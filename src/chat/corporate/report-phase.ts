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
    const nonEmptyOutputs = plan.tasks
        .map(t => ({ agent: t.agent, out: (outputs[t.agent] || '').trim() }))
        .filter(o => o.out.length > 30 && !/^⚠️.*호출 실패/.test(o.out));
    if (nonEmptyOutputs.length === 0) {
        /* 모든 에이전트가 빈 답 — CEO LLM 호출 무의미. 즉시 실패 보고로 종료. */
        finalReport = `⚠️ **모든 에이전트의 LLM 호출이 실패했습니다.**\n\n` +
            `시도된 에이전트: ${plan.tasks.map(t => `${AGENTS[t.agent]?.emoji} ${AGENTS[t.agent]?.name}`).join(' · ')}\n\n` +
            `**가장 흔한 원인**:\n` +
            `- Claude CLI 미설치 또는 PATH에 없음 → \`claude --version\` 으로 확인\n` +
            `- Claude Max 5시간 사용량 한도 초과 → 잠시 뒤 재시도\n` +
            `- \`claude login\` 인증 만료 → 재로그인 필요\n\n` +
            `_각 에이전트의 정확한 에러는 위 카드들 참고._`;
    } else if (plan.tasks.length <= 1) {
        const onlyAgent = plan.tasks[0]?.agent;
        const onlyOutput = onlyAgent ? (outputs[onlyAgent] || '') : '';
        finalReport = onlyOutput.trim() || '_(에이전트 산출물 없음)_';
    } else {
        post({ type: 'agentStart', agent: 'ceo', task: '종합 보고서 작성' });
        _updateActiveDispatchStep(prompt, 'CEO 종합 보고서 작성 중');
        /* v2.89.46 — 산출물 없는 에이전트는 reportInput에서 제외 (CEO가 placeholder
           출력 위험 제거). 명시적으로 "X명 중 Y명만 답변 도착" 메타 정보 포함. */
        const validTasks = plan.tasks.filter(t => nonEmptyOutputs.some(o => o.agent === t.agent));
        const reportInput = `[원 명령]\n${prompt}\n\n[브리프]\n${plan.brief}\n\n` +
            `[응답 도착: ${validTasks.length}/${plan.tasks.length}명]\n\n` +
            `[유효한 에이전트 산출물]\n${validTasks.map(t => `\n## ${AGENTS[t.agent]?.emoji} ${AGENTS[t.agent]?.name}\n${(outputs[t.agent] || '').slice(0, 2000)}`).join('\n')}\n\n` +
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
                const out = outputs[t.agent] || '';
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

    return finalReport;
}
