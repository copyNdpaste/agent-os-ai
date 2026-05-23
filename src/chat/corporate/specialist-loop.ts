/**
 * Phase: Specialist agent loop — the per-agent dispatch body extracted
 * out of `_handleCorporatePrompt`. Behavior is preserved byte-for-byte;
 * the original blob just lives here now and runs against an explicit
 * `CorporateContext` instead of capturing `this`.
 *
 * The loop yields a `SpecialistLoopResult` so the caller can decide
 * whether to skip the confer/report stages (e.g. OAuth trigger, blocked
 * credentials, abort, fatal error).
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AGENTS } from '../../agents';
import {
    _activeChatProvider,
    appendAgentMemory,
    appendConversationLog,
    addTrackerTask,
    getCompanyDir,
    getCompanyMetrics,
    updateCompanyMetrics,
    _harvestActionItems,
    _pushTelegramHistory,
    _updateActiveDispatchStep,
    prefetchAgentRealtimeData,
    promoteGroundedClaimsFromOutput,
    readAgentSharedContext,
    readAgentRagMode,
    buildAgentConfigStatus,
    buildSpecialistPrompt,
    sendTelegramLong,
    sendTelegramReport,
    startYouTubeOAuthFlow,
} from '../../extension';
import { _readYtOAuthClient } from '../../youtube/oauth';
import { runCommandCaptured } from '../../infra/process';
import type { AgentMetaEntry, CorporateContext, Plan } from './types';

export interface SpecialistLoopArgs {
    ctx: CorporateContext;
    plan: Plan;
    prompt: string;
    modelName: string;
    sessionDir: string;
    explicit: { agentId: string; agentName: string } | null;
}

export interface SpecialistLoopResult {
    outputs: Record<string, string>;
    agentMeta: Record<string, AgentMetaEntry>;
    /** True when the loop aborted early and the orchestrator should
     *  return immediately (e.g. user pressed stop mid-call). */
    earlyReturn: boolean;
    /** True when a specialist hit an OAuth trigger or credentials block.
     *  The orchestrator must skip confer/report/learn phases entirely. */
    blocked: boolean;
}

export async function runSpecialistLoop(args: SpecialistLoopArgs): Promise<SpecialistLoopResult> {
    const { ctx, plan, prompt, modelName, sessionDir, explicit } = args;
    const { post, isAborted } = ctx;

    const outputs: Record<string, string> = {};
    /* v2.89.51 — 작업 라운드 메타데이터 추적. 어떤 도구를 썼고, 어떤 데이터를
       받았고, 핵심 산출이 뭔지를 CEO 보고에 포함시켜 사용자가 한눈에 파악. */
    const agentMeta: Record<string, AgentMetaEntry> = {};

    for (const t of plan.tasks) {
        if (isAborted()) {
            post({ type: 'agentEnd', agent: t.agent });
            break;
        }
        const a = AGENTS[t.agent];
        if (!a) continue;
        post({ type: 'agentStart', agent: t.agent, task: t.task });
        _updateActiveDispatchStep(prompt, `${a.emoji} ${a.name} 작업 중 — ${t.task.slice(0, 40)}`);

        // 이전 에이전트들의 산출물을 동료의 작업으로 함께 제공
        const peerCtx = Object.keys(outputs).length > 0
            ? `\n\n[같은 세션의 동료 에이전트 산출물]\n${Object.entries(outputs).map(([k, v]) => `\n### ${AGENTS[k]?.emoji} ${AGENTS[k]?.name}\n${v.slice(0, 1500)}`).join('\n')}`
            : '';

        /* v2.89.10 — Prefetch 진짜 데이터: LLM 호출 직전에 시스템이
           에이전트의 데이터 도구를 실행해서 stdout을 컨텍스트로 주입.
           에이전트가 "데이터 로드 완료했다" 거짓말 못하게 됨 (거짓이면
           주입된 실제 데이터와 충돌이 보임). */
        let realtimeData = '';
        try {
            post({ type: 'response', value: `🔍 ${a.emoji} ${a.name} 데이터 가져오는 중...` });
            realtimeData = await prefetchAgentRealtimeData(t.agent);
        } catch { /* prefetch 실패해도 dispatch 안 막음 */ }
        /* v2.89.38 — 환각 방지 가드. 사용자 원 명령에 키워드가 등장하는데
           그 데이터를 가진 에이전트(youtube/instagram/secretary)가 1차로 실행돼서
           실데이터가 peerCtx 또는 realtimeData에 있는데도 specialist가 무시하고
           memory.md/decisions.md/brain RAG에서 끌어와 헛소리하던 패턴 차단. */
        const userMentionsChannelData = /(유튜브|youtube|채널|구독자|조회수|영상)/i.test(prompt);
        const hasRealChannelData = userMentionsChannelData && (
            /채널.*조회수|조회수\s*중간값|구독자|영상\s*\d+개/i.test(realtimeData + peerCtx)
        );
        const hallucinationGuard = hasRealChannelData
            ? `\n\n[🛑 환각 금지 규칙 — 절대 위반 금지]\n` +
              `위 [실시간 데이터] 또는 [동료 산출물]에 사용자 채널의 진짜 데이터(조회수·영상 수·구독자 등)가 들어있습니다.\n` +
              `- 분석은 **오직 그 데이터만** 근거로 하세요\n` +
              `- 당신의 memory.md / 회사 decisions / 브레인 노트에 들어있는 과거 디자인·전략·시각 시스템 내용을 **소환하지 마세요** (사용자가 *이번에 그걸 명시적으로 요청*하지 않은 한)\n` +
              `- "Deep Blue/Neon Cyan", "지배 구조", "심리적 통제권" 같은 과거 컨셉을 자동으로 끌어와 보고서에 끼워 넣는 행위 금지\n` +
              `- 본인 task가 위 데이터와 무관하면 \`📊 평가: 대기 — 이번 명령에 적합한 데이터·지시 부족\` 으로 정직하게 종료`
            : '';
        /* v2.89.41 — 컨텍스트 다이어트. 실데이터(prefetch 또는 peerCtx) 있을 때
           lean 모드 = decisions·memory·brain RAG 생략 → 토큰 ~9000자 감소 →
           추론 30~50% 빨라짐 + 환각 더 줄어듦 (메모리에서 끌어올 거리 없음). */
        const useLeanContext = (realtimeData.length > 200) || (peerCtx.length > 500);
        /* v2.89.131 — 최근 파일 액션 컨텍스트. 개발신가 직전에 만든 파일의 절대
           경로를 잊고 "_agents/developer/test/" 같은 추측 경로로 list_files
           호출해 실패하던 사고 차단. */
        const recentFilesCtx = ctx.buildRecentFilesContext(t.agent);
        const sysPrompt = `${buildSpecialistPrompt(t.agent)}${ctx.getProjectMemory()}${buildAgentConfigStatus(t.agent)}${realtimeData}${readAgentSharedContext(t.agent, { lean: useLeanContext })}${peerCtx}${hallucinationGuard}${recentFilesCtx}`;
        const userMsg = `[CEO의 지시]\n${t.task}\n\n[원 사용자 명령 참고]\n${prompt}`;

        let out = '';
        /* v2.89.133 — 키트 shortcut. 명시적 호출(`개발신아 ...`) + 두뇌 키트
           강하게 매칭되는 명령이면 LLM 호출 자체 건너뛰고 pack_apply 직접 실행.
           LM Studio 죽어있거나 context 모자라도 시연 깨지지 않음.
           조건: explicit 호출 + t.agent === developer + 매칭 점수 ≥ 10. */
        let shortcut: string | null = null;
        if (explicit && t.agent === 'developer') {
            shortcut = ctx.tryKitShortcut(t.agent, prompt);
        }
        /* v2.89.147 — business 매출 shortcut. business 에이전트 + 매출/PayPal
           키워드면 explicit 여부 무관 LLM 우회. 종합 보고서에서 CEO 가 business 에
           분배한 경우도 동일하게 paypal_revenue.py 실데이터 직접 표시. 작은
           LLM(gemma-2B) 이 system prompt 무시하고 README 읽으려는 버릇 차단. */
        if (!shortcut && t.agent === 'business') {
            const lower = prompt.toLowerCase();
            if (/매출|수익|결제|paypal|revenue|매상|매월|이번 달|이번달|월 매출|페이팔|돈|얼마 벌/.test(lower)) {
                shortcut = await ctx.tryRevenueShortcut(prompt);
            }
        }
        if (shortcut) {
            out = shortcut;
            /* 사무실에 작업 시작 신호 한 번 → 사용자가 개발신 카드 펄스 봄 */
            try {
                ctx.broadcastCorporate({ type: 'agentBusy', agent: t.agent, elapsedSec: 0 });
            } catch { /* ignore */ }
            /* statusBar 알림 */
            try {
                vscode.window.setStatusBarMessage(
                    `⚡ ${a.emoji} ${a.name} 키트 자동 적용 — LLM 우회`, 5000
                );
            } catch { /* ignore */ }
            /* shortcut 경로 — 아래 heartbeat / LLM 호출 블록 통째로 스킵 */
        }

        /* v2.89.133 — shortcut 경로는 heartbeat / LLM 호출 자체를 스킵.
           pack_apply 결과는 dispatch 의 _executeActions / cmdRegex 가 곧바로 잡음. */
        if (!shortcut) {
        /* v2.89.131 — 진행 표시 + 사무실 동기화 + 첫 토큰 마커.
           사용자가 "11분간 멈춘 것 같다"고 한 사고 해결. 5초마다 statusBar +
           30초마다 채팅창 한 줄 + 가상 사무실 캐릭터 상태 갱신. 첫 토큰 도착
           시 모두 클리어 + "응답 시작 (XX초 소요)" 채팅 메시지. */
        const llmStartTs = Date.now();
        let heartbeatChatTick = 0; /* 채팅창에 push 한 횟수 (30초 단위) */
        const heartbeatInterval = setInterval(() => {
            const elapsedSec = Math.round((Date.now() - llmStartTs) / 1000);
            const mm = Math.floor(elapsedSec / 60);
            const ss = elapsedSec % 60;
            const timeStr = mm > 0 ? `${mm}분 ${ss}초` : `${ss}초`;
            /* statusBar — 항상 갱신 (5초마다) */
            try {
                vscode.window.setStatusBarMessage(
                    `⏳ ${a.emoji} ${a.name} 작업 중 — ${timeStr} 경과`, 6500
                );
            } catch { /* ignore */ }
            /* 가상 사무실 broadcast — 작업 중 thought/status 표시 */
            try {
                ctx.broadcastCorporate({
                    type: 'agentBusy',
                    agent: t.agent,
                    elapsedSec
                });
            } catch { /* ignore */ }
            /* v2.89.157 — 채팅창 진행 표시 10초마다. "정지처럼 보인다" 사용자 피드백 반영.
               매 10초 이모지·문구가 바뀌어 backend 가 살아있다는 signal 강화. */
            const tick = Math.floor(elapsedSec / 10);
            if (tick > heartbeatChatTick && elapsedSec >= 10) {
                heartbeatChatTick = tick;
                const phases = [
                    `🔄 ${a.emoji} ${a.name} 분석 중 — ${timeStr} 경과`,
                    `🧠 ${a.emoji} ${a.name} 데이터 처리 중 — ${timeStr} 경과`,
                    `⚙️ ${a.emoji} ${a.name} 추론 중 — ${timeStr} 경과`,
                    `💭 ${a.emoji} ${a.name} 결과 정리 중 — ${timeStr} 경과`,
                    `✨ ${a.emoji} ${a.name} 거의 다 됐어요 — ${timeStr} 경과`,
                    `⏳ ${a.emoji} ${a.name} 무거운 모델 처리 중 — ${timeStr} 경과 _(정상)_`,
                ];
                post({
                    type: 'response',
                    value: phases[(tick - 1) % phases.length]
                });
            }
        }, 2500); /* v2.89.157 — 2.5초로 단축. 사무실 시각 효과 (sparkle·thought·status) 더 자주 갱신 → 정지처럼 안 보임. */
        try {
            out = await ctx.callAgentLLM(sysPrompt, userMsg, modelName, t.agent, true, {
                onFirstToken: () => {
                    clearInterval(heartbeatInterval);
                    const waitSec = Math.round((Date.now() - llmStartTs) / 1000);
                    const mm = Math.floor(waitSec / 60);
                    const ss = waitSec % 60;
                    const timeStr = mm > 0 ? `${mm}분 ${ss}초` : `${ss}초`;
                    try {
                        post({
                            type: 'response',
                            value: `📝 ${a.emoji} ${a.name} 응답 시작 — 첫 토큰까지 ${timeStr} 대기`
                        });
                    } catch { /* ignore */ }
                    try { vscode.window.setStatusBarMessage(`✍️ ${a.emoji} ${a.name} 응답 생성 중`, 8000); } catch { /* ignore */ }
                }
            });
        } catch (e: any) {
            clearInterval(heartbeatInterval);
            if (isAborted()) {
                post({ type: 'agentEnd', agent: t.agent });
                post({ type: 'error', value: '🛑 사용자가 중단했어요.' });
                return { outputs, agentMeta, earlyReturn: true, blocked: false };
            }
            const detail = String(e?.message || e || '').slice(0, 300);
            let hint = '';
            if (/ENOENT|not found/i.test(detail)) {
                hint = '\n💡 Claude CLI 미설치. `claude --version` 확인 또는 settings.json 의 `agentOs.claudeBinPath` 설정.';
            } else if (/timed out|timeout/i.test(detail)) {
                hint = '\n💡 Claude 응답이 시간 초과. Claude Max 5시간 한도 확인 또는 잠시 뒤 재시도.';
            } else if (/aborted/i.test(detail)) {
                hint = '\n💡 응답이 중간에 취소됐어요.';
            }
            /* v2.89.32 — LLM 호출은 실패해도 prefetch가 가져온 실데이터는
               살아있으니 그대로 보존해서 다음 에이전트(peerCtx)와 최종 보고서가
               볼 수 있게 함. 이전엔 LLM 실패 = 에러 메시지만 out에 들어가서
               "데이터 로드 실패"로 잘못 보고됨 (실제로는 데이터가 있는데도). */
            const errBlock = `⚠️ ${a.name} LLM 호출 실패: ${e.message}${detail ? '\n원인: ' + detail : ''}${hint}`;
            if (realtimeData && realtimeData.trim()) {
                out = `${errBlock}\n\n---\n\n## 📊 LLM 실패에도 시스템이 가져온 실데이터는 보존됨\n\n${realtimeData}\n\n_위 데이터를 기반으로 다음 에이전트가 분석을 이어가야 합니다. "데이터 로드 실패"로 잘못 보고하지 마세요._`;
            } else {
                out = errBlock;
            }
        } finally {
            /* v2.89.131 — 정상 종료·예외 모두 interval 클리어 보장. onFirstToken 이
               호출됐어도 idempotent 하니까 두 번 클리어해도 안전. */
            clearInterval(heartbeatInterval);
        }
        } /* end if (!shortcut) — v2.89.133 LLM 우회 분기 닫음 */
        /* v2.89.9 — 진짜 도구 실행. corporate dispatch에서도 에이전트가
           <run_command>...</run_command> 출력하면 시스템이 실제로 실행하고
           stdout/stderr를 다시 출력에 주입. 이게 LLM hallucination을
           진짜 데이터 기반 답변으로 바꿈. 이전엔 _handlePrompt 흐름에서만
           실행됐고 corporate에선 텍스트만 흘러서 "데이터 로드함"이라고
           거짓 보고만 났음. */
        try {
            const cmdRegex = /<(?:run_command|command|bash|terminal)>([\s\S]*?)<\/(?:run_command|command|bash|terminal)>/gi;
            const cmds: string[] = [];
            let cmdMatch: RegExpExecArray | null;
            while ((cmdMatch = cmdRegex.exec(out)) !== null) {
                let c = cmdMatch[1].trim();
                if (c.startsWith('```')) {
                    const lines = c.split('\n');
                    if (lines[0].startsWith('```')) lines.shift();
                    if (lines.length > 0 && lines[lines.length - 1].startsWith('```')) lines.pop();
                    c = lines.join('\n').trim();
                }
                if (c) cmds.push(c);
            }
            if (cmds.length > 0) {
                post({ type: 'response', value: `🔧 ${a.emoji} ${a.name}: ${cmds.length}개 명령 실행 중...` });
                const cwd = path.join(getCompanyDir(), '_agents', t.agent, 'tools');
                const execLogs: string[] = [];
                for (const cmd of cmds) {
                    try {
                        /* v2.89.73 — 실시간 진행상황 streaming. 이전엔 명령 끝난 후에야 출력 보였음
                           (5~15분 음악 모델 설치 시 사용자가 "뭐가 되고 있나?" 답답). 이제 stdout/
                           stderr 라인 단위로 채팅창에 흘림. 라인이 너무 빠르면 100ms throttle. */
                        let lineBuf = '';
                        let lastFlush = 0;
                        const FLUSH_MS = 100;
                        /* v2.89.74 — 라이브러리 내부 noise 필터. 사용자한테 의미 없는 줄은
                           채팅창에 안 보이게 (transformers LOAD REPORT, ANSI escape, HF auth
                           warning 등). 진짜 진행상황은 통과. */
                        const noisePatterns = [
                            /\[transformers\]/,
                            /MusicgenForConditionalGeneration LOAD REPORT/,
                            /^\s*Key\s+\|\s+Status/,
                            /^\s*-+\+-+\+-+\+/,
                            /\bUNEXPECTED\b.*\|/,
                            /^\s*Notes:\s*$/,
                            /^\s*-\s*UNEXPECTED:/,
                            /You are sending unauthenticated requests to the HF Hub/,
                            /Please set a HF_TOKEN/,
                            /\x1b\[\d+m/,  /* ANSI color codes */
                        ];
                        const isNoise = (line: string) => noisePatterns.some(re => re.test(line));
                        const flushChunk = (text: string, force = false) => {
                            lineBuf += text;
                            const lines = lineBuf.split('\n');
                            if (!force) lineBuf = lines.pop() || '';
                            else lineBuf = '';
                            /* ANSI escape 제거 + noise 필터 + 빈 줄 제거 */
                            const clean = lines
                                .map(l => l.replace(/\x1b\[[0-9;]*m/g, ''))
                                .filter(l => l.trim() && !isNoise(l));
                            const out = clean.join('\n');
                            if (!out) return;
                            const now = Date.now();
                            if (force || now - lastFlush > FLUSH_MS) {
                                post({ type: 'response', value: `\`\`\`\n${out.slice(-2000)}\n\`\`\`` });
                                lastFlush = now;
                            }
                        };
                        /* 90초 → 25분(설치류 대비). music_studio_setup, project_scaffold 같은 게
                           시간 오래 걸려도 끊기지 않게. */
                        const r = await runCommandCaptured(cmd, cwd, (chunk) => flushChunk(chunk), 25 * 60 * 1000);
                        if (lineBuf.trim()) flushChunk('', true);
                        const status = r.timedOut ? '⏱️ 25분 초과' : (r.exitCode === 0 ? '✅' : `❌ exit ${r.exitCode}`);
                        const trimmedOut = (r.output || '').trim().slice(0, 4000);
                        execLogs.push(`### 🔧 실행: \`${cmd.slice(0, 100)}\`\n\`\`\`\n${trimmedOut}\n\`\`\`\n_${status}_`);
                        post({ type: 'response', value: `${status} 명령 완료: \`${cmd.slice(0, 80)}\`` });
                        if (ctx.getTelegramMirrorPending()) {
                            sendTelegramReport(`🔧 *${a.emoji} ${a.name}* 도구 실행 ${status}\n\n\`\`\`\n${trimmedOut.slice(0, 1500)}\n\`\`\``).catch(() => {});
                        }
                    } catch (err: any) {
                        execLogs.push(`### 🔧 실행 실패: \`${cmd.slice(0, 100)}\`\n${err?.message || err}`);
                    }
                }
                /* 출력에 실제 실행 결과 append — LLM이 다음에 보거나 final report에 들어감 */
                out = `${out}\n\n---\n## 🛠️ 도구 실행 결과 (시스템 자동 실행)\n\n${execLogs.join('\n\n')}`;
                post({ type: 'response', value: `✅ ${a.emoji} ${a.name}: 도구 실행 완료, 결과 컨텍스트 주입` });
                /* 도구 결과로 에이전트가 다시 분석하도록 2차 호출 (선택) — 시간/토큰 비용 있어서
                   일단은 결과만 append, 다음 에이전트(peerCtx)와 final report에서 활용. */
            }
        } catch { /* never let tool exec break the dispatch */ }

        /* v2.89.93 — 파일 액션 처리. specialist도 <create_file>·<edit_file>·
           <delete_file>·<read_file>·<list_files>·<reveal_in_explorer>·<open_file>
           다 쓸 수 있게. 이전엔 run_command만 실행돼서 디자이너·작가·개발자가
           "파일 만들었다" 텍스트만 출력하고 디스크엔 아무것도 안 남던 사고.
           skipRunCommand=true — 위 dispatch run_command가 이미 처리. */
        try {
            const fileReport: string[] = [];
            const fileInjections: string[] = [];
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const fileActionRoot = wsRoot || getCompanyDir();
            const fr = await ctx.executeActions(out, {
                rootOverride: fileActionRoot,
                appendToOutput: (s) => fileInjections.push(s),
                silent: true,
                skipRunCommand: true,
                agentId: t.agent, /* v2.89.131 — 최근 파일 액션 트래킹 */
            });
            fileReport.push(...fr);
            if (fileReport.length > 0) {
                const summary = fileReport.slice(0, 5).join('\n');
                post({ type: 'response', value: `📁 ${a.emoji} ${a.name} 파일 액션:\n${summary}` });
                out = `${out}\n\n---\n## 📁 파일 액션 결과\n\n${fileReport.join('\n')}${fileInjections.join('')}`;
            }
        } catch (e: any) {
            /* 파일 액션 실패해도 dispatch 진행. 로그만 남김. */
            try { post({ type: 'response', value: `⚠️ ${a.emoji} ${a.name} 파일 액션 처리 중 오류: ${e?.message || e}` }); } catch { /* ignore */ }
        }

        outputs[t.agent] = out;
        /* v2.89.51 — 작업 라운드 메타데이터 수집. CEO 보고에 도구·데이터·핵심 인용. */
        {
            /* prefetch summary: realtimeData 첫 의미있는 줄 (### 헤딩 다음) */
            let prefetchSummary = '';
            if (realtimeData) {
                const m = realtimeData.match(/###\s*([^\n]+)/);
                prefetchSummary = m ? m[1].trim() : '';
                /* 진짜 데이터의 핵심 숫자 한두개 뽑아내기 */
                const stats: string[] = [];
                const subM = realtimeData.match(/구독자[\s:]*([0-9.]+[KkMm]?[명]?)/);
                const viewsM = realtimeData.match(/조회수\s*중간값[:\s]*\*?\*?([0-9.]+[KkMm]?)/);
                const videoM = realtimeData.match(/영상\s*(\d+)\s*개/);
                if (subM) stats.push(`구독자 ${subM[1]}`);
                if (viewsM) stats.push(`중간값 ${viewsM[1]}`);
                if (videoM) stats.push(`영상 ${videoM[1]}개`);
                if (stats.length > 0) prefetchSummary = stats.join(' · ');
            }
            /* output summary: 첫 의미있는 줄 + 평가 라인 */
            const outLines = (out || '').split('\n').map(l => l.trim()).filter(Boolean);
            const firstReal = outLines.find(l => !l.startsWith('#') && !l.startsWith('---') && !/^[📺📊🔥💰🎨🔧🛠️]/.test(l) && l.length > 10) || (outLines[0] || '');
            const evalLine = outLines.find(l => l.startsWith('📊 평가:')) || '';
            const outputSummary = [firstReal.slice(0, 200), evalLine].filter(Boolean).join(' / ');
            /* 실행한 도구 이름 추출 — '🛠️ 도구 실행 결과' 섹션 또는 prefetch */
            const toolsUsed: string[] = [];
            const toolMatches = (out || '').matchAll(/실행:\s*`(?:cd[^&`]*&&\s*)?(?:python\d?\s+)?([\w_-]+\.py)/g);
            for (const m of toolMatches) toolsUsed.push(m[1]);
            /* youtube의 경우 prefetch가 my_videos_check.py 자동 실행하니 추가 */
            if (t.agent === 'youtube' && realtimeData.length > 100 && !toolsUsed.includes('my_videos_check.py')) {
                toolsUsed.push('my_videos_check.py (prefetch)');
            }
            agentMeta[t.agent] = {
                task: t.task,
                toolsUsed,
                prefetchSummary,
                outputSummary,
                outputLength: (out || '').length,
            };
        }
        /* v2.89.8 — 자동 트리거 토큰. 에이전트가 `<TRIGGER:youtube_oauth>`
           를 출력하면 시스템이 OAuth 명령을 직접 실행해서 브라우저를 띄움.
           사용자가 "버튼 어디 있냐" 헤매지 않고 진짜 비서처럼 자동으로
           인증 창이 뜸. */
        if (out && /<TRIGGER:youtube_oauth>/i.test(out)) {
            try {
                /* 먼저 Client ID/Secret 확인 — 없으면 OAuth 시작 못함.
                   사용자에게 그 사실을 텔레그램·사이드바 둘 다에 명확히 안내. */
                const cl = _readYtOAuthClient();
                const hasClient = !!(cl.id && cl.secret);
                if (!hasClient) {
                    const setupMsg = `🔐 *YouTube Analytics 인증 셋업 필요*\n\nClient ID와 Secret이 비어있어 자동 인증을 시작할 수 없어요. 1회만 셋업하면 다음부터 자동:\n\n1. 헤더 우측 *🔌 외부 연결* 버튼 클릭\n2. *📊 YouTube Analytics (OAuth)* 카드에서 Client ID·Secret 입력\n3. ⚡ *자동 연결* 버튼 → 브라우저 자동 열림\n\n_생성: console.cloud.google.com → APIs & Services → Credentials → OAuth 2.0 Client ID (Desktop)_`;
                    post({ type: 'response', value: '🔐 OAuth 셋업이 필요해요 — Client ID/Secret을 먼저 입력해주세요. (텔레그램으로 안내 발송)' });
                    if (ctx.getTelegramMirrorPending()) {
                        await sendTelegramLong(setupMsg);
                        _pushTelegramHistory('assistant', 'OAuth 셋업 필요 — Client ID/Secret 입력 안내');
                    }
                } else {
                    /* Client 있음 — 자동으로 브라우저 열기. fire-and-forget으로 dispatch 진행 안 막음. */
                    post({ type: 'response', value: '🔐 YouTube OAuth 인증 창을 자동으로 띄울게요...' });
                    if (ctx.getTelegramMirrorPending()) {
                        await sendTelegramReport(`🔐 *Analytics OAuth 인증 시작* — 브라우저가 자동으로 열려요. Google 계정 승인 후 분석 다시 요청해주세요.`);
                    }
                    startYouTubeOAuthFlow().then(r => {
                        try {
                            if (r.ok) {
                                _activeChatProvider?.postSystemNote?.('✅ YouTube OAuth 연결 완료 — 다시 분석 요청해주세요.', '🔐');
                                if (ctx.getTelegramMirrorPending() !== undefined) {
                                    sendTelegramReport(`✅ *OAuth 연결 완료* — 이제 시청 지속률·트래픽 소스 같은 Analytics 데이터 분석 가능. 같은 명령 다시 보내주세요.`).catch(() => {});
                                }
                            } else {
                                _activeChatProvider?.postSystemNote?.(`⚠️ OAuth 실패: ${r.message}`, '🔐');
                            }
                        } catch { /* ignore */ }
                    });
                }
            } catch (e: any) {
                post({ type: 'error', value: `⚠️ OAuth 자동 트리거 실패: ${e?.message || e}` });
            }
            /* 출력에서 TRIGGER 토큰 제거 (사용자한텐 보이면 안 됨) */
            out = out.replace(/<TRIGGER:youtube_oauth>/gi, '').trim();
            outputs[t.agent] = out;
            /* 후속 에이전트 분배 의미 없음 — 사용자 OAuth 승인 후 재요청 흐름 */
            plan.tasks = plan.tasks.slice(0, plan.tasks.findIndex(x => x.agent === t.agent) + 1);
            /* 산출물 저장은 그대로 (기록 가치) */
            try {
                fs.writeFileSync(
                    path.join(sessionDir, `${t.agent}.md`),
                    `# ${a.emoji} ${a.name} — ${t.task}\n\n${out}\n`
                );
            } catch { /* ignore */ }
            appendAgentMemory(t.agent, `${t.task} → OAuth 자동 트리거 발동`);
            post({ type: 'agentEnd', agent: t.agent, blocked: true });
            ctx.setTelegramMirrorPending(false);
            return { outputs, agentMeta, earlyReturn: false, blocked: true };
        }
        /* v2.89.2 — 차단 감지 + 즉시 텔레그램 통보. 에이전트 응답이
           "API 키 필요"·"OAuth 미연결" 같은 자격증명 차단 신호면:
           1) 사용자한테 즉시 텔레그램으로 그 메시지 송출 (기다리지 말고)
           2) 후속 에이전트 분배는 의미 없으니 break
           3) 나중에 final report에 묻히지 않음 */
        const isBlocked = (() => {
            const o = out || '';
            /* 명시적 신호 */
            if (/API\s*키.*(필요|입력|미설정)/i.test(o)) return true;
            if (/OAuth\s*(연결|미연결).*(필요|해주세요)/i.test(o)) return true;
            if (/(자격증명|credentials).*(필요|미설정|missing)/i.test(o)) return true;
            if (/⚠️.*미설정/i.test(o)) return true;
            /* 자가평가가 '대기' + 이유에 키 언급 */
            if (/📊\s*평가:\s*대기/i.test(o) && /키|API|OAuth|credentials/i.test(o)) return true;
            return false;
        })();
        if (isBlocked) {
            /* v2.89.7 — 사이드바 디스패치도 블록 인지하게. 이전엔 텔레그램에서
               시작한 디스패치만 즉시 알림 보내고, 사이드바 디스패치는 그냥
               통과시켜서 후속 에이전트들이 빈 데이터로 빙빙 돌았음. 이제 둘 다
               차단. */
            try {
                /* "📊 평가: 대기" 같은 메타 라인 제거하고 본문만 추출 */
                const cleaned = out
                    .replace(/^📊\s*평가:.*$/gim, '')
                    .replace(/^📝\s*다음 단계:.*$/gim, '')
                    .replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}].*?\s*(시작|작업)\s*합니다.*$/gimu, '')
                    .trim();
                const headline = `⛔ *${a.emoji} ${a.name} 작업 멈춤* — 자격증명 필요`;
                if (ctx.getTelegramMirrorPending()) {
                    await sendTelegramLong(`${headline}\n\n${cleaned.slice(0, 1500)}`);
                    _pushTelegramHistory('assistant', `${a.name}: ${cleaned.slice(0, 200)}`);
                }
                post({ type: 'response', value: `⛔ ${a.emoji} ${a.name}가 자격증명 부족으로 멈췄어요${ctx.getTelegramMirrorPending() ? ' (텔레그램 알림 발송)' : ''}.` });
            } catch { /* silent */ }
            /* 이 에이전트의 산출물 저장 + memory 누적은 그대로 진행 (기록 가치) */
            try {
                fs.writeFileSync(
                    path.join(sessionDir, `${t.agent}.md`),
                    `# ${a.emoji} ${a.name} — ${t.task}\n\n${out}\n`
                );
            } catch { /* ignore */ }
            appendAgentMemory(t.agent, `${t.task} → 자격증명 부족으로 차단됨`);
            post({ type: 'agentEnd', agent: t.agent, blocked: true });
            /* 이 에이전트가 다른 에이전트의 입력 데이터 공급원이면 후속 작업도
               의미 없음. 전체 dispatch 중단. */
            post({ type: 'response', value: `🛑 후속 에이전트 분배 중단 — 먼저 ${a.name} 자격증명 입력 후 재요청해주세요.` });
            /* mirror 처리는 final report가 발사되기 전이지만 이미 위에서
               텔레그램에 핵심 메시지 보냈으니 mirror flag만 끄고 final
               report 단계로 진입하지 않게 throw. */
            ctx.setTelegramMirrorPending(false);
            /* finalReport는 차단 메시지로 대체 — sessionDir 정리만 하고
               break out of the agent loop. */
            plan.tasks = plan.tasks.slice(0, plan.tasks.findIndex(x => x.agent === t.agent) + 1);
            break;
        }
        try {
            fs.writeFileSync(
                path.join(sessionDir, `${t.agent}.md`),
                `# ${a.emoji} ${a.name} — ${t.task}\n\n${out}\n`
            );
        } catch { /* ignore */ }
        // 개인 메모리에 한 줄 누적
        appendAgentMemory(t.agent, `${t.task} → 산출물 sessions/${path.basename(sessionDir)}/${t.agent}.md`);
        /* Self-RAG promotion: if this agent is in self-rag mode, scan
           its output for [근거: ...] tagged claims and append them to
           verified.md. memory.md still gets the firehose entry above
           for traceability. */
        try {
            if (readAgentRagMode(t.agent) === 'self-rag') {
                const n = promoteGroundedClaimsFromOutput(t.agent, out);
                if (n > 0) {
                    post({ type: 'response', value: `✅ ${a.emoji} ${a.name}의 검증된 주장 ${n}개를 \`verified.md\`로 승격했습니다.` });
                }
            }
        } catch { /* ignore */ }
        // Phase 1: log this agent's full output to the running transcript
        appendConversationLog({ speaker: a.name, emoji: a.emoji, section: t.task.slice(0, 60), body: out });
        /* P1-5: harvest action items from this agent's output and register them
           into tracker so the user sees them in the sidebar Task panel. We use
           a conservative regex (`- [ ] ...` markdown checkbox) so agents
           opt-in by formatting their output that way; their prompt seeds
           already encourage action-oriented endings. */
        try {
            const harvested = _harvestActionItems(out);
            for (const title of harvested) {
                addTrackerTask({
                    title,
                    owner: 'agent',
                    agentIds: [t.agent],
                    status: 'pending',
                    description: `자동 등록 (${a.name} 산출물에서 추출)`,
                    sessionDir: path.basename(sessionDir),
                });
            }
        } catch { /* never let harvesting break the dispatch */ }
        post({ type: 'agentEnd', agent: t.agent });

        const metrics = getCompanyMetrics();
        updateCompanyMetrics({ tasksCompleted: (metrics.tasksCompleted || 0) + 1 });
    }

    return { outputs, agentMeta, earlyReturn: false, blocked: false };
}
