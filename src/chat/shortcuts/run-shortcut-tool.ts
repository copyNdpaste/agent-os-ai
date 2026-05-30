/**
 * Extracted from `SidebarChatProvider._runShortcutTool` in
 * `src/views/sidebar-chat.ts` (~line 3226).
 *
 * Runs a single specialist tool (Python script) directly — bypassing the
 * full multi-agent dispatch / CEO planner — then optionally chains a
 * specialist-self-analysis + CEO-summary LLM pass when the user prompt
 * contains analysis intent.
 *
 * Behavior is preserved byte-for-byte from the original in-class method.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
    CEO_REPORT_PROMPT,
    _personalizePrompt,
    appendConversationLog,
    buildSpecialistPrompt,
    getAgentModel,
    readAgentSharedContext,
} from '../../extension';
import { AGENTS } from '../../agents';
import { runCommandCaptured } from '../../infra/process';
import {
    pythonCmd as _pythonCmd,
    isPythonMissing as _isPythonMissing,
    pythonMissingHint as _pythonMissingHint,
} from '../../infra/python';

/**
 * Shape of a single tool catalog entry passed into `runShortcutTool`.
 * Matches the inner type used in the original method.
 */
export interface ShortcutCatalogEntry {
    agentId: string;
    tool: string;
    scriptPath: string;
}

/**
 * Surface area the run-shortcut-tool helper needs from
 * `SidebarChatProvider`. Mirrors the bound methods/state the original method
 * body referenced via `this`.
 */
export interface RunShortcutToolHost {
    /** SidebarChatProvider's `_displayMessages` field — pushed-into by this helper. */
    displayMessages: { text: string; role: string }[];
    /** Broadcasts a corporate message (agentStart/agentEnd/response/error/...). */
    broadcastCorporate(msg: any): void;
    /** Calls a Claude/LLM agent (mirrors `_callAgentLLM` signature). */
    callAgentLLM(
        systemPrompt: string,
        userMsg: string,
        modelName: string,
        agentId: string,
        broadcast: boolean,
        opts?: { jsonMode?: boolean; onFirstToken?: () => void }
    ): Promise<string>;
}

/* 도구 1개를 직접 실행하고 결과를 채팅창에 출력. multi-agent 분배·CEO 보고서 다 스킵.
   source 인자는 어떤 단계에서 매칭됐는지 사용자에게 보여주기 위함 ('패턴' or '분류기'). */
export async function runShortcutTool(
    host: RunShortcutToolHost,
    entry: ShortcutCatalogEntry,
    prompt: string,
    sessionDir: string,
    source: string,
): Promise<boolean> {
    const post = (m: any) => host.broadcastCorporate(m);
    const a = AGENTS[entry.agentId];
    const toolsDir = path.dirname(entry.scriptPath);

    /* === 1단계: 도구 실행 (데이터 수집) === */
    post({ type: 'agentStart', agent: entry.agentId, task: `${entry.tool} 데이터 수집` });
    post({ type: 'response', value: `🔧 ${a.emoji} ${a.name}: \`${entry.tool}\` 실행 중...` });
    let r: { exitCode: number; output: string; timedOut: boolean };
    try {
        /* stderr 도 캡쳐한다. 실패 시 Python ImportError / env 누락 메시지가
           stderr 로만 나오면 사용자에게 "(출력 없음)" 으로 보여 원인 파악이 안 된다. */
        r = await runCommandCaptured(`${_pythonCmd()} ${JSON.stringify(entry.tool)}`, toolsDir, () => {}, 90000, 'both');
    } catch (e: any) {
        post({ type: 'agentEnd', agent: entry.agentId });
        post({ type: 'error', value: `⚠️ 도구 실행 에러: ${e?.message || e}` });
        return true;
    }
    post({ type: 'agentEnd', agent: entry.agentId });

    const toolOut = (r.output || '').trim();
    const toolOk = r.exitCode === 0 && toolOut.length > 0;
    const toolStatus = r.timedOut ? '⏱️ 90초 초과' : (toolOk ? '✅' : `❌ exit ${r.exitCode}`);

    if (!toolOk) {
        const pyMissing = _isPythonMissing(r.exitCode, toolOut);
        const hint = pyMissing
            ? _pythonMissingHint()
            : '💡 흔한 원인: API 키 미설정, Python·필수 패키지 미설치';
        /* tool 출력은 이미 의도된 markdown (헤딩·blockquote·list 포함). 코드블록
           으로 감싸면 raw syntax 가 그대로 보이고 가독성 깨짐. 그대로 렌더링되게
           둠. 출력이 진짜 plain text/log 면 스크립트 측에서 fenced block 으로
           감싸 출력하면 됨. */
        const body = `${a.emoji} **${a.name}** — \`${entry.tool}\` 실행 실패\n\n${toolOut || '_(출력 없음)_'}\n\n_${toolStatus}_\n\n${hint}`;
        host.displayMessages.push({ text: body, role: 'ai' });
        post({ type: 'response', value: body });
        appendConversationLog({ speaker: a.name, emoji: a.emoji, section: `도구 실행 (${source})`, body: `${entry.tool} 실패: ${toolOut.slice(0, 500)}` });
        return true;
    }

    /* "분석" 의도가 명시적이지 않으면 (예: "내 채널 데이터 보여줘") LLM 분석 스킵하고
       원본 데이터만. 의도 단어 있으면 (분석/어때/평가/검토 등) 2단계 LLM chain 발동. */
    const wantsAnalysis = /(분석|어때|어떻게|평가|검토|좋|안\s*좋|개선|문제|왜|뭐\s*해야|추천|제안|전략|review|analyze|assess|evaluate)/i.test(prompt);
    if (!wantsAnalysis) {
        /* 도구 출력은 이미 markdown 형식 — ``` wrap 없이 그대로 렌더링. */
        const body = `${a.emoji} **${a.name}** — \`${entry.tool}\` 결과\n\n${toolOut.slice(0, 6000)}\n\n_${toolStatus} · 데이터만 출력했습니다. 분석이 필요하면 "분석해줘"·"어때"·"평가해줘" 같이 분석 동사를 붙여주세요._`;
        host.displayMessages.push({ text: body, role: 'ai' });
        post({ type: 'response', value: body });
        appendConversationLog({ speaker: a.name, emoji: a.emoji, section: `도구 실행 (${source}, 데이터만)`, body: `${entry.tool} 완료\n\n${toolOut.slice(0, 2000)}` });
        try { fs.writeFileSync(path.join(sessionDir, '_shortcut.md'), `# ${entry.tool} (${source})\n\n명령: ${prompt}\n\n${body}\n`); } catch { /* ignore */ }
        return true;
    }

    /* === 2단계: Specialist 에이전트가 전문가로서 자가 분석 ===
       이 에이전트가 그 도메인 전문가 (YouTube agent = 채널 분석가). 도구가 가져온 raw
       데이터를 받아서 전문가 시각으로 깊이 해석. 청중·트렌드·콘텐츠 전략 관점에서 평가. */
    const agentModel = getAgentModel(entry.agentId, '');
    const specialistSysPrompt = `${buildSpecialistPrompt(entry.agentId)}` +
        `\n\n[방금 시스템이 가져온 실제 데이터 — 이게 분석 근거]\n${toolOut.slice(0, 8000)}` +
        `\n\n${readAgentSharedContext(entry.agentId, { lean: true })}` +
        `\n\n[전문가 자가 분석 지침 — 반드시 따를 것]\n` +
        `당신은 ${a.name} (${a.role}) 입니다. 위 [실제 데이터]를 보고 **그 분야 전문가로서** 깊이 있게 분석하세요.\n` +
        `1. **현재 상태 진단** — 데이터의 숫자·패턴이 의미하는 바 (단순 나열 X, 해석)\n` +
        `2. **잘 된 것** — 무엇이·왜 잘 됐나 (구체적 영상·숫자 인용)\n` +
        `3. **문제점** — 무엇이·왜 부진한가 (추측이 아니라 데이터 근거)\n` +
        `4. **청중 인사이트** — 인기 댓글에서 보이는 시청자 관심사·니즈\n` +
        `5. **30일 액션 플랜** — 우선순위 순 3~5개, 각각 "왜 이걸 해야 하는지" 데이터 근거 명시\n` +
        `\n⚠️ 데이터에 없는 숫자·사실 절대 만들어내지 마세요. "Deep Blue/Neon Cyan" 같은 과거 컨셉을 끌어와 끼워넣지 마세요. 오직 위 [실제 데이터]만 근거.`;
    post({ type: 'agentStart', agent: entry.agentId, task: '전문가 자가 분석' });
    post({ type: 'response', value: `🧠 ${a.emoji} ${a.name}: 데이터 보고 전문가 분석 중...` });
    let specialistAnalysis = '';
    let specialistError = '';
    try {
        specialistAnalysis = await host.callAgentLLM(
            specialistSysPrompt,
            `[사용자 명령]\n${prompt}\n\n위 데이터에 대한 ${a.name} (${a.role}) 시각의 전문가 분석을 작성하세요.`,
            agentModel,
            entry.agentId,
            true,
        );
    } catch (e: any) {
        specialistError = e?.message || String(e);
        specialistAnalysis = '';
    }
    post({ type: 'agentEnd', agent: entry.agentId });

    /* v2.89.47 — 빈 답 감지. 작은 모델·메모리 부족 시 LLM이 빈 string 반환하는데
       이전엔 그대로 CEO한테 넘겨서 "분석 결과를 제공해주시면..." 헛소리 출력. */
    const specialistContent = (specialistAnalysis || '').trim();
    const specialistOk = specialistContent.length > 50 && !/^⚠️/.test(specialistContent);

    /* === 3단계: CEO 종합 요약 ===
       Specialist 분석이 의미 있을 때만 CEO 호출. 빈 답이면 CEO 스킵 → 명시적 실패 보고. */
    let ceoSummary = '';
    if (specialistOk) {
        post({ type: 'agentStart', agent: 'ceo', task: '종합 요약' });
        post({ type: 'response', value: `👔 CEO: 사장님께 올릴 종합 정리 중...` });
        const ceoModel = getAgentModel('ceo', '');
        const ceoSysPrompt = `${_personalizePrompt(CEO_REPORT_PROMPT)}\n${readAgentSharedContext('ceo', { lean: true })}`;
        const ceoUserMsg = `[사장님 명령]\n${prompt}\n\n[${a.emoji} ${a.name} 전문가 분석]\n${specialistContent.slice(0, 6000)}\n\n위 ${a.name}의 분석을 사장님이 30초에 파악할 수 있게 종합 요약하세요. ${a.name}의 결론과 액션을 충실히 반영하되, 너무 길지 않게.\n\n⚠️ "분석 결과를 제공해주시면", "데이터가 들어오면" 같은 placeholder 절대 금지 — 위 분석은 이미 제공됐음.`;
        try {
            ceoSummary = await host.callAgentLLM(ceoSysPrompt, ceoUserMsg, ceoModel, 'ceo', false);
            /* CEO도 placeholder 뱉으면 무시 → specialist 분석만 보임 */
            if (/분석\s*결과를\s*제공|데이터가\s*제공|데이터가\s*들어오면|once\s+the\s+output|when\s+the\s+output/i.test(ceoSummary)) {
                ceoSummary = '';
            }
        } catch { ceoSummary = ''; }
        post({ type: 'agentEnd', agent: 'ceo' });
    }

    /* === 출력 조합 (v2.89.48 — 스크립트 분석을 항상 주답으로) ===
       이전엔 LLM 실패 시 "분석 실패"라고만 표시 + 데이터를 collapsible로 숨김. 그런데
       pro_v1 스크립트는 이미 (1) 채널 메타 (2) 영상별 표 (3) 상위 영상 + 인기 댓글
       (4) 패턴 분석 (5) 우선순위 액션 추천 까지 다 출력하는 진짜 분석. 즉 LLM이 죽어도
       쓸만한 분석은 이미 손에 있음. 이걸 항상 펼쳐서 주답으로, LLM 분석은 "추가 인사이트"로. */
    /* v2.89.49 — 출력 정리. 이전엔 ![alt](url) 마크다운 이미지가 채팅 sidebar의
       markdown renderer에서 안 렌더되고 "!alt"로 깨져 보였음. 아바타 이미지 markdown
       제거하고 이모지·이름만으로 헤더. 데이터 분석은 stdout 그대로 (이미 markdown 정렬). */
    const sections: string[] = [];
    if (ceoSummary && ceoSummary.trim()) {
        sections.push(`## 👔 CEO 종합\n\n${ceoSummary.trim()}`);
    }
    /* 스크립트 분석은 자체적으로 # 🎬 헤딩으로 시작하므로 추가 헤딩 없이 그대로 삽입 */
    sections.push(toolOut.slice(0, 12000).trim());
    /* LLM 자가 분석은 추가 레이어 — 성공 시 더 깊은 인사이트, 실패 시 짧게 안내만 */
    if (specialistOk) {
        sections.push(`---\n\n## 🧠 ${a.emoji} ${a.name} 추가 인사이트\n\n${specialistContent}`);
    } else if (specialistError) {
        sections.push(`---\n\n> ⚠️ LLM 추가 인사이트 단계 스킵: \`${specialistError.slice(0, 200)}\`\n> 💡 모델 오케스트레이션 모달 → ${a.name} 모델을 더 작은 것으로 변경하면 다음번엔 인사이트도 같이 옵니다. 위 데이터 분석은 LLM 없이 정상 집계된 결과예요.`);
    }
    const body = sections.join('\n\n');

    host.displayMessages.push({ text: body, role: 'ai' });
    post({ type: 'response', value: body });
    appendConversationLog({
        speaker: a.name, emoji: a.emoji,
        section: `전문가 분석 chain (${source})`,
        body: `Tool: ${entry.tool}\n\n${a.name} 분석:\n${specialistAnalysis.slice(0, 1500)}\n\nCEO 요약:\n${ceoSummary.slice(0, 800)}`,
    });
    try {
        fs.writeFileSync(path.join(sessionDir, '_shortcut.md'), `# ${entry.tool} (${source}, 전문가 분석 chain)\n\n명령: ${prompt}\n\n${body}\n`);
    } catch { /* ignore */ }
    return true;
}
