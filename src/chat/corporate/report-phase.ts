/**
 * Phase: CEO synthesis report — given the plan + specialist outputs +
 * confer turns, ask the CEO model to produce a single owner-facing
 * report. Falls back to a meta-only "작업 라운드" breakdown when the
 * CEO call fails or every specialist returned empty.
 *
 * Extracted out of `_handleCorporatePrompt` byte-for-byte.
 */
import { AGENTS } from '../../agents';
import {
    _personalizePrompt,
    _updateActiveDispatchStep,
    CEO_REPORT_PROMPT,
    getAgentModel,
    readAgentSharedContext,
} from '../../extension';
import type { AgentMetaEntry, CorporateContext, Plan } from './types';

export interface RunReportPhaseArgs {
    ctx: CorporateContext;
    plan: Plan;
    prompt: string;
    modelName: string;
    outputs: Record<string, string>;
    agentMeta: Record<string, AgentMetaEntry>;
}

export async function runReportPhase(args: RunReportPhaseArgs): Promise<string> {
    const { ctx, plan, prompt, modelName, outputs, agentMeta } = args;
    const { post } = ctx;

    // 5) CEO 종합 보고서 (UI에는 chunk 안 흘리고 카드로만 표시)
    // v2.89.41 — 단일 에이전트 dispatch면 CEO 보고서 스킵.
    // v2.89.46 — 빈 산출물 감지: 모든 에이전트가 LLM 실패로 빈 답 반환했으면
    //   CEO가 "기다리고 있습니다" 같은 placeholder 출력하지 않게 명시적 실패 보고.
    let finalReport = '';
    /* v2.92.x — outputs[agent] 가 어디선가 객체 형태 ({text:..., toolsUsed:...}) 로 저장되는
       회귀가 발견됨 (사장님 사례: sessions/2026-05-26T06-42 — developer outputs 가 dict 인데
       report-phase 가 string 으로 .trim() 호출 → 빈 답 판정 → "모든 LLM 호출 실패" 가짜
       빨간 보고서). 여기서 dict/object 인 경우 .text 또는 .out 키에서 실제 텍스트 펴줌. */
    const _normalizeOut = (raw: unknown): string => {
        if (raw == null) return '';
        if (typeof raw === 'string') return raw;
        if (typeof raw === 'object') {
            const r = raw as Record<string, unknown>;
            if (typeof r.text === 'string') return r.text;
            if (typeof r.out === 'string') return r.out;
            if (typeof r.content === 'string') return r.content;
        }
        return String(raw);
    };
    /* v2.91.x — '빈 답' 판정 보정. 도구 실행이나 파일 액션을 한 라운드는
       LLM 텍스트가 짧아도 valid 산출물. 이전엔 collector.py 백그라운드 실행 +
       파일 덮어쓰기 다 했어도 마지막 LLM 답 30자 미만이면 "모든 LLM 호출 실패"
       잘못된 빨간 보고가 떴음. 사장님 dispatch 사고 케이스 (2026-05-25). */
    const nonEmptyOutputs = plan.tasks
        .map(t => ({ agent: t.agent, out: _normalizeOut(outputs[t.agent]).trim(), meta: agentMeta[t.agent] }))
        .filter(o => {
            if (/^⚠️.*호출 실패/.test(o.out)) return false;
            if (o.out.length > 30) return true;
            /* 도구 1개라도 실행했으면 valid (메타가 토구 추적) */
            if (o.meta?.toolsUsed && o.meta.toolsUsed.length > 0) return true;
            /* 출력 본문에 파일 액션 / 셸 실행 흔적이 있으면 valid */
            if (/✅ 생성:|✏️ 덮어씀:|📁 파일 액션|🖥️ 실행:|🚀 백그라운드 시작/.test(o.out)) return true;
            return false;
        });
    if (nonEmptyOutputs.length === 0) {
        /* 모든 에이전트가 빈 답 — CEO LLM 호출 무의미. 즉시 실패 보고로 종료. */
        const attemptedModels = Array.from(new Set(plan.tasks
            .map(t => getAgentModel(t.agent, modelName))
            .filter(Boolean)));
        const usesCodex = attemptedModels.some(m => /^(gpt-|gpt5|o1|o3)/i.test(m));
        const usesClaude = attemptedModels.length === 0 || attemptedModels.some(m => !/^(gpt-|gpt5|o1|o3)/i.test(m));
        const modelLines = attemptedModels.length > 0
            ? `\n시도된 모델: ${attemptedModels.map(m => `\`${m}\``).join(' · ')}\n`
            : '';
        /* v2.92.x — 추측 대신 진실. 각 에이전트가 실제로 받은 에러를 카드에서 직접 보여준다.
           specialist catch 가 out 에 `⚠️ ... LLM 호출 실패: {msg}\n원인: {detail}` 형태로 남김.
           이게 없을 땐 기존 일반 추측으로 fallback. */
        const realErrors = plan.tasks
            .map(t => {
                const o = _normalizeOut(outputs[t.agent]);
                const mm = o.match(/원인:\s*([^\n]+)/) || o.match(/LLM 호출 실패:\s*([^\n]+)/);
                return { agent: t.agent, detail: (mm?.[1] || '').trim() };
            })
            .filter(e => e.detail);
        const joinedErr = realErrors.map(e => e.detail).join(' ⏐ ');
        const looksApiError = /(thinking|redacted_thinking)[\s\S]{0,120}(cannot be modified|must remain)|invalid_request_error|overloaded|rate[_\s-]?limit|\b429\b|\b5\d\d\b|API Error|status \d{3}/i.test(joinedErr);

        const causeLines: string[] = [];
        if (looksApiError) {
            /* 진짜 원인이 일시적 API 오류면 그걸 헤드라인으로. "사용량 초과·미설치" 오답 차단. */
            causeLines.push(
                `- **LLM API 일시 오류** (사용량·설치 문제 아님). 자동 재시도 후에도 실패 → 잠시(1~2분) 뒤 같은 명령을 다시 내려보세요. 대개 정상 작동합니다.`,
                `- 계속 반복되면 위 에이전트 카드의 \`원인:\` 줄을 확인하세요.`,
            );
        } else {
            if (usesCodex) {
                causeLines.push(
                    `- Codex CLI 미설치 또는 PATH에 없음 → \`codex --version\` 으로 확인`,
                    `- Codex 로그인/세션 만료 → \`codex login\` 재인증`,
                    `- GPT/Codex 사용량 한도 또는 모델명 거부 → 위 에이전트 카드의 정확한 stderr 확인`,
                );
            }
            if (usesClaude) {
                causeLines.push(
                    `- Claude CLI 미설치 또는 PATH에 없음 → \`claude --version\` 으로 확인`,
                    `- Claude Max 5시간 사용량 한도 초과 → 잠시 뒤 재시도`,
                    `- \`claude login\` 인증 만료 → 재로그인 필요`,
                );
            }
        }
        const realErrLines = realErrors.length > 0
            ? `\n**실제 받은 에러**:\n${realErrors.map(e => `- ${AGENTS[e.agent]?.emoji || ''} ${AGENTS[e.agent]?.name || e.agent}: ${e.detail.slice(0, 200)}`).join('\n')}\n`
            : '';
        finalReport = `⚠️ **모든 에이전트의 LLM 호출이 실패했습니다.**\n\n` +
            `시도된 에이전트: ${plan.tasks.map(t => `${AGENTS[t.agent]?.emoji} ${AGENTS[t.agent]?.name}`).join(' · ')}\n\n` +
            modelLines +
            realErrLines +
            `\n**가장 흔한 원인**:\n` +
            `${causeLines.join('\n')}\n\n` +
            `_각 에이전트의 정확한 에러는 위 카드들 참고._`;
    } else if (plan.tasks.length <= 1) {
        const onlyAgent = plan.tasks[0]?.agent;
        const onlyOutput = onlyAgent ? _normalizeOut(outputs[onlyAgent]) : '';
        finalReport = onlyOutput.trim() || '_(에이전트 산출물 없음)_';
    } else {
        post({ type: 'agentStart', agent: 'ceo', task: '종합 보고서 작성' });
        _updateActiveDispatchStep(prompt, 'CEO 종합 보고서 작성 중');
        /* v2.89.46 — 산출물 없는 에이전트는 reportInput에서 제외 (CEO가 placeholder
           출력 위험 제거). 명시적으로 "X명 중 Y명만 답변 도착" 메타 정보 포함. */
        const validTasks = plan.tasks.filter(t => nonEmptyOutputs.some(o => o.agent === t.agent));
        const reportInput = `[원 명령]\n${prompt}\n\n[브리프]\n${plan.brief}\n\n` +
            `[응답 도착: ${validTasks.length}/${plan.tasks.length}명]\n\n` +
            /* v2.92.x — 이전 2000자 truncate 는 multi-turn 산출물(파일 diff·도구 결과)이
               out 끝에 append 돼서 사장님이 받는 최종 보고에서 가장 중요한 부분이
               잘림. head 1500 + tail 6500 로 양쪽 보존 (총 ~8KB/에이전트). 5명이면
               CEO context 40KB — claude-opus-4-7 200K 한도에 여유. */
            `[유효한 에이전트 산출물]\n${validTasks.map(t => {
                const full = _normalizeOut(outputs[t.agent]);
                if (full.length <= 8000) return `\n## ${AGENTS[t.agent]?.emoji} ${AGENTS[t.agent]?.name}\n${full}`;
                return `\n## ${AGENTS[t.agent]?.emoji} ${AGENTS[t.agent]?.name}\n${full.slice(0, 1500)}\n\n…(중략 ${full.length - 8000}자)…\n\n${full.slice(-6500)}`;
            }).join('\n')}\n\n` +
            `규칙: 위 산출물 안의 실제 내용·숫자만 인용해 보고서 작성. "산출물을 기다리고 있습니다", "데이터가 제공되면" 같은 placeholder 표현 절대 금지 — 산출물은 이미 위에 있음.`;
        let ceoNarrative = '';
        try {
            ceoNarrative = await ctx.callAgentLLM(
                `${_personalizePrompt(CEO_REPORT_PROMPT)}\n${readAgentSharedContext('ceo', { lean: true })}`,
                reportInput,
                modelName,
                'ceo',
                false
            );
            /* CEO가 그래도 placeholder 뱉으면 무시 */
            if (/산출물을\s*기다|데이터가\s*제공|once\s+the\s+output|when\s+the\s+output/i.test(ceoNarrative)) {
                ceoNarrative = '';
            }
        } catch { ceoNarrative = ''; }
        post({ type: 'agentEnd', agent: 'ceo' });
        /* v2.89.51 — 메타데이터 기반 작업 라운드 보고. CEO LLM 답이 짧거나 빈 답이어도
           사용자가 "어떤 도구·어떤 데이터·각 에이전트 무엇을 했나" 한눈에 파악. */
        const breakdownLines: string[] = [];
        breakdownLines.push(`## 🗂 작업 라운드 — 누가 뭐 했나`);
        breakdownLines.push('');
        for (const t of plan.tasks) {
            const a = AGENTS[t.agent];
            const meta = agentMeta[t.agent];
            if (!a) continue;
            breakdownLines.push(`### ${a.emoji} ${a.name} _(${a.role})_`);
            breakdownLines.push(`> 📋 **지시**: ${t.task}`);
            if (meta?.toolsUsed && meta.toolsUsed.length > 0) {
                breakdownLines.push(`> 🔧 **도구 실행**: ${meta.toolsUsed.map(x => '`'+x+'`').join(', ')}`);
            } else {
                breakdownLines.push(`> 🔧 **도구 실행**: _(없음 — LLM 추론만)_`);
            }
            if (meta?.prefetchSummary) {
                breakdownLines.push(`> 📊 **수집 데이터**: ${meta.prefetchSummary}`);
            }
            if (meta?.outputSummary) {
                breakdownLines.push(`> 💡 **핵심 산출**: ${meta.outputSummary}`);
            } else {
                const out = _normalizeOut(outputs[t.agent]);
                if (!out.trim() || /^⚠️/.test(out)) {
                    breakdownLines.push(`> ⚠️ **상태**: 빈 답변 또는 LLM 실패`);
                }
            }
            breakdownLines.push(`> 📝 산출물 길이: ${meta?.outputLength || 0}자`);
            breakdownLines.push('');
        }
        if (ceoNarrative && ceoNarrative.trim()) {
            finalReport = `${breakdownLines.join('\n')}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n## 👔 CEO 종합\n\n${ceoNarrative.trim()}`;
        } else {
            /* CEO LLM 실패해도 메타 보고서는 항상 보임 */
            finalReport = `${breakdownLines.join('\n')}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n_(CEO 종합 단계 스킵 — 위 작업 라운드 메타가 답입니다)_`;
        }
    }

    /* Checkpoint: report finalized. Writer flushes immediately on phase boundary
       so a crash after this point still has the report on disk for the recovery
       card to surface. */
    ctx.sessionWriter?.setReport(finalReport);
    return finalReport;
}
