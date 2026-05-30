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
    getAgentModel,
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
import {
    detectDangerousCommand,
    formatBlockedCommandInjection,
    formatBlockedCommandNotice,
} from './safety-filter';

export interface SpecialistLoopArgs {
    ctx: CorporateContext;
    plan: Plan;
    prompt: string;
    modelName: string;
    sessionDir: string;
    explicit: { agentId: string; agentName: string } | null;
    /** v2.92.x — applyDispatchCap 가 'simple' 판정한 단순 명령. specialist 가 환각
     *  retry 후 적용 재시도 + multi-turn 까지 다 도는 게 과잉 (README 1줄 추가에
     *  LLM 4회 호출 → 사장님 좌절 사례). simple 이면 환각 retry 1회 후 종료. */
    simpleCommand?: boolean;
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

/* v2.92.x — Read-only 의도 명령 감지. 사장님이 "분석만/보고서만/수정 금지/건드리지 마"
   같은 키워드 명시한 명령은 write 액션 0 이 정상. 환각 가드가 false-positive 로
   재시도 메시지 띄우는 사고 차단. 사장님 사례: Level 4 "코드 수정은 절대 하지 말고
   분석 보고서만" 명령에 환각 retry 발동 → 사장님이 "왜 자꾸 환각 떠?" 의문. */
const READ_ONLY_INTENT_RE = /수정\s*(?:은\s*)?(?:절대\s*)?(?:하지\s*마|금지|말|마)|건드리지\s*(?:마|말)|보고서(?:만| only)|분석(?:만| only)|read[-_\s]?only|읽기\s*전용|코드\s*수정\s*(?:없|금지|X|x)|변경\s*(?:없|금지)|만들지\s*(?:마|말)|쓰지\s*(?:마|말)/i;

/* v2.92.x — 환각 탐지 v2. 이전 ACTION_TAG_RE 에는 읽기 액션(read_file·glob·grep·
   list_files)이 포함되어 있어서, developer 가 그것만 호출하고 정작 수정(<edit_file>)
   은 안 한 채 "Before/After 표 + ✅ 완료" 가짜 보고서를 써도 통과됨 (사장님 실제 사례:
   sessions/2026-05-26T06-15 — 4개 읽기 액션 + 0개 쓰기 액션 + 풍성한 diff 표). 이제
   읽기/쓰기 분리해서 "쓰기 0 + 가짜 완료 보고" 패턴을 환각으로 명확히 판정. */
const READ_ACTION_RE = /<(?:read_file|read|list_files|list_dir|ls|glob|grep)\b/i;
/* v2.92.x — write 는 "파일 시스템 영구 변경" 만. run_command/bash 는 grep·ls·cat
   같은 read-only 도 흔하므로 별도 카테고리 (EXEC) 로 분리. 이전엔 run_command
   가 write 로 카운트돼서 "grep 1번 + ls 1번 = write 2회" → 환각 가드 무력화. */
const WRITE_ACTION_RE = /<(?:create_file|write_file|file|edit_file|edit|delete_file)\b/i;
const EXEC_ACTION_RE = /<(?:run_command|command|bash|terminal)\b/i;
const READ_ONLY_CLAIM_RE = /read-only|읽기\s*전용|권한.*(?:없|차단|막힘)|실제\s*(?:반영|수정|적용).*(?:불가|차단|못|안\s*됨)|도구\s*실행:\s*\(?없음|LLM\s*추론만/i;
/* 가짜 완료 보고 패턴 — 실제로 수정 안 했는데 "다 했어요" 작성. */
const HALLUCINATED_COMPLETION_RE = /Before\s*\/\s*After|before\s*\/\s*after|변경\s*(?:사항|파일|요약|결과)\s*(?:요약|보고)?|##\s*📦|✅\s*(?:완료|검증|확인|적용|반영|교체)|diff\s*요약|적용\s*완료|반영\s*완료|교체\s*완료|수정\s*완료|##\s*🔄/i;
/* v2.92.x — 확장. 사장님 명령은 동사 form 이 다양 ("완성하고", "확장", "짜기",
   "채우", "구축", "모듈/스크립트/엔드포인트" 같은 명사 단독). 이전 정규식은
   "고쳐/만들어/구현해" 만 잡아서 단순 명사 명령 ("채널 수집 모듈 구현") 도 미스.
   여기에 산출물 명사 + 한국어 동사 종결 form 확대. */
const IMPLEMENTATION_REQUEST_RE = /(?:고쳐|만들어|구현해(?:\s*줘)?|바꿔(?:\s*줘)?|추가해(?:\s*줘)?|작성해(?:\s*줘)?|리팩(?:토링)?\s*해|적용해\s*줘|반영해\s*줘|수정해\s*줘|개선해\s*줘|완성(?:해|시켜|하고|시켜줘)?|확장(?:해|시켜|하고)?|채우(?:고|기|어|어줘)?|구축(?:해|하고)?|구성(?:해|하고)?|짜(?:줘|봐|기|는|서)|세팅(?:해|하고)?|셋업|setup|배포(?:해|하고)?|deploy|랜딩(?:\s*페이지)?|landing\s*page|css|tailwind|tsx|\.html\b|모듈\s*(?:구현|만|작성|구축|확장)?|스크립트\s*(?:구현|만|작성|짜)?|스키마\s*(?:추가|확장|마이그)?|엔드포인트|마이그레이션|템플릿\s*확장|발송\s*(?:모듈|로직)?|수집\s*(?:모듈|스크립트)?|warm[-_\s]?up|버그(?:\s*잡|\s*고)|에러(?:\s*잡|\s*고))/i;
const WRITE_SUCCESS_RE = /^(?:✅|✏️|🗑️|🖥️|🚀)/m;
/* v2.92.x — read 만 호출하고 끝낸 specialist 자동 재호출 대상.
   secretary/editor 는 단순 보고형이 많아 제외. 작업형(코드·디자인·카피·리서치·
   비즈니스·콘텐츠) 은 read 후 반드시 write 까지 가야 함. */
const WORK_AGENTS = new Set(['developer', 'designer', 'writer', 'researcher', 'business', 'instagram']);

/* v2.92.x — 사장님 원 명령에서 보존 키워드를 자동 추출. CEO LLM 이 ceo-planner.md
   의 "보존 인용" 룰을 빼먹어도 시스템이 직접 specialist userMsg 에 박아 넣음.
   추출 규칙: '기존/유지/그대로/건드리지/살려/보존/남겨/놔둬' 키워드를 포함한 절
   (최대 3개) 을 그대로 인용. 광범위 변경 키워드('전체 갈아엎/처음부터 다시/재구축')
   가 있으면 보존 규칙은 풀고 빈 문자열. */
function extractPreservationClauses(prompt: string): string[] {
    if (/전체\s*갈아엎|처음부터\s*다시|재구축|싹\s*다\s*바꿔/i.test(prompt)) return [];
    const PRESERVE_RE = /(기존|유지|그대로|건드리지|살려|보존|남겨|놔둬)/;
    const sentences = prompt.split(/(?<=[.!?。\n])\s+|,\s*/g);
    const hits: string[] = [];
    for (const s of sentences) {
        const trimmed = s.trim();
        if (trimmed.length < 4 || trimmed.length > 140) continue;
        if (PRESERVE_RE.test(trimmed)) hits.push(trimmed);
        if (hits.length >= 3) break;
    }
    return hits;
}

/** v2.92.x — Claude CLI bypassPermissions 모드는 LLM 이 ProoAI custom 태그
 *  (<edit_file>/<run_command>) 없이 Claude 내장 Edit/Write 도구로 직접 파일을
 *  변경함. 환각 가드는 텍스트 안 태그만 카운트해서 "0회" 로 false-positive 판정 →
 *  사장님이 "변경 안 됐다" 오해 + 재시도 메시지로 신뢰 깨짐.
 *  해결: 환각 판정 전·후 wsRoot 의 git status 를 비교. 다르면 실제 변경 발생 →
 *  환각 retry skip. ProoAI 액션 0개여도 Claude 내장 도구로 변경한 것이라 OK. */
function getWsRoot(): string | undefined {
    try {
        const vscode = require('vscode');
        const wf = vscode?.workspace?.workspaceFolders;
        if (wf && wf.length > 0) return wf[0].uri.fsPath;
    } catch { /* vscode unavailable */ }
    return undefined;
}

function captureGitState(wsRoot: string | undefined): string {
    if (!wsRoot) return '';
    try {
        const { execSync } = require('child_process');
        return execSync('git status --porcelain', {
            cwd: wsRoot, encoding: 'utf8', timeout: 3000,
        });
    } catch { return ''; }
}

function needsConcreteDeveloperAction(agentId: string, task: string, prompt: string): boolean {
    /* v2.92.x — 이전엔 developer 만 강제 retry 대상이었음 → designer/writer/researcher
       가 "tailwind 적용해줘", "copy 다시 써줘", "경쟁사 분석해줘" 같은 implementation
       명령에 환각 완료 보고만 작성해도 시스템이 못 잡음. 모든 WORK_AGENTS 로 확장
       해서 implementation 키워드면 강제 retry 발동. */
    if (!WORK_AGENTS.has(agentId)) return false;
    return IMPLEMENTATION_REQUEST_RE.test(`${task}\n${prompt}`);
}

/** 환각 판정 — 쓰기 액션 0개 + (가짜 완료 보고 OR read-only 변명).
 *  읽기 액션만 부르고 결과는 보지 않은 채 "완료" 작성하는 케이스를 잡음.
 *  v2.92.x — execCount 분리: run_command/bash 는 grep·ls 같은 read-only 도 흔하므로
 *  writeCount 에서 빼고 별도 카운트. write = 파일 시스템 영구 변경만. */
function isHallucinatingCompletion(out: string): { hallucinating: boolean; readCount: number; writeCount: number; execCount: number; reason: string } {
    const readCount = (out.match(/<(?:read_file|read|list_files|list_dir|ls|glob|grep)\b/gi) || []).length;
    const writeCount = (out.match(/<(?:create_file|write_file|file|edit_file|edit|delete_file)\b/gi) || []).length;
    const execCount = (out.match(/<(?:run_command|command|bash|terminal)\b/gi) || []).length;
    if (writeCount > 0) return { hallucinating: false, readCount, writeCount, execCount, reason: 'has-write' };
    if (HALLUCINATED_COMPLETION_RE.test(out)) {
        return { hallucinating: true, readCount, writeCount, execCount, reason: 'fake-completion-report' };
    }
    if (READ_ONLY_CLAIM_RE.test(out)) {
        return { hallucinating: true, readCount, writeCount, execCount, reason: 'read-only-excuse' };
    }
    return { hallucinating: false, readCount, writeCount, execCount, reason: 'plain-text-no-claim' };
}

/** v2.92.x — read·exec 만 호출하고 write 액션 0 인 채 응답 종료한 작업형 specialist
 *  를 잡음. 사장님 원 명령에 명시적 implementation 키워드가 없어도 (예: "다음 작업
 *  진행해", "outreach 완성하고 ...") 작업형 agent 가 read·grep·ls 만 부르고 끝나면
 *  시스템이 1회 재호출해 실제 write 까지 가게 강제. */
function needsContinuationAfterRead(
    agentId: string,
    readCount: number,
    writeCount: number,
    execCount: number,
): boolean {
    if (!WORK_AGENTS.has(agentId)) return false;
    if (writeCount > 0) return false;
    return (readCount + execCount) > 0;
}

export async function runSpecialistLoop(args: SpecialistLoopArgs): Promise<SpecialistLoopResult> {
    const { ctx, plan, prompt, modelName, sessionDir, explicit, simpleCommand } = args;
    const { post, isAborted } = ctx;

    const outputs: Record<string, string> = {};
    /* v2.89.51 — 작업 라운드 메타데이터 추적. 어떤 도구를 썼고, 어떤 데이터를
       받았고, 핵심 산출이 뭔지를 CEO 보고에 포함시켜 사용자가 한눈에 파악. */
    const agentMeta: Record<string, AgentMetaEntry> = {};

    const _wsRoot = getWsRoot();
    for (const t of plan.tasks) {
        if (isAborted()) {
            /* User pressed stop. Mark this agent as failed so resume can know
               where we left off. */
            ctx.sessionWriter?.endAgent(t.agent, 'failed', undefined, 'user aborted');
            post({ type: 'agentEnd', agent: t.agent });
            break;
        }
        const a = AGENTS[t.agent];
        if (!a) continue;
        /* v2.92.x — Claude 내장 도구 변경 감지용 baseline. specialist 시작 직전 git
           status 캡처. 환각 판정 시점에 다시 캡처해서 비교 → 다르면 실제 변경 발생. */
        const _gitBefore = captureGitState(_wsRoot);
        const stripTask = String(t.task || '').replace(/\s+/g, ' ').trim().slice(0, 220);
        post({ type: 'agentStart', agent: t.agent, task: t.task, detail: stripTask });
        _updateActiveDispatchStep(prompt, `${a.emoji} ${a.name} 작업 중 — ${t.task.slice(0, 40)}`);

        // 이전 에이전트들의 산출물을 동료의 작업으로 함께 제공
        /* v2.92.x — peerCtx 1500 → 4000자. 사장님 협업 깊이 ↑. designer 가 4000자
           디자인 토큰 표를 만들었을 때 다음 specialist (developer) 가 그 중 1500자만
           봐서 tail 의 Tailwind diff 짤려 추측으로 채우던 사고 차단. 4명 X 4000 = 16K
           추가 token 이지만 claude-opus-4-7 200K 한도에 여유. */
        const peerCtx = Object.keys(outputs).length > 0
            ? `\n\n[같은 세션의 동료 에이전트 산출물 — 비판·개선·인용 가능]\n${Object.entries(outputs).map(([k, v]) => `\n### ${AGENTS[k]?.emoji} ${AGENTS[k]?.name}\n${v.slice(0, 4000)}`).join('\n')}`
            : '';

        /* v2.89.10 — Prefetch 진짜 데이터: LLM 호출 직전에 시스템이
           에이전트의 데이터 도구를 실행해서 stdout을 컨텍스트로 주입.
           에이전트가 "데이터 로드 완료했다" 거짓말 못하게 됨 (거짓이면
           주입된 실제 데이터와 충돌이 보임). */
        let realtimeData = '';
        try {
            post({ type: 'progressTick', agent: t.agent, emoji: a.emoji, name: a.name, phase: '데이터 가져오는 중', icon: '🔍', elapsedSec: 0 });
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
        /* v2.92.x — 사장님 원 명령을 최상단·강조 형태로. 이전엔 "[CEO 지시] → [원 명령 참고]"
           순서라 specialist 가 "CEO 지시를 좀 더 잘 해석한 결과" 같은 광범위 변형을 만듦.
           이제 사장님 원 명령이 1순위, CEO 지시는 그걸 구체화한 step 으로 명시. recency
           bias 활용 — instruction-following 모델은 prompt 끝 쪽 명령을 더 강하게 따름. */
        /* v2.92.x — 보존 키워드 자동 추출 → CEO LLM 이 빼먹어도 시스템이 박음. */
        const preserveClauses = extractPreservationClauses(prompt);
        const preserveBlock = preserveClauses.length > 0
            ? `\n\n🔒 **[보존 제약 — 사장님 원 명령에서 자동 추출, 절대 위반 금지]**\n` +
              preserveClauses.map(c => `  · "${c}"`).join('\n') +
              `\n→ 위 영역은 read-only. 절대 삭제·수정·재작성 금지. 변경 충동 들어도 무시.`
            : '';
        const userMsg = `🎯 **사장님이 직접 내린 원 명령 (1순위 — 그대로 따름)**
${prompt}${preserveBlock}

────────────────────────────────────────
📋 [CEO 가 위 명령을 specialist 용 step 으로 변환한 지시]
${t.task}
────────────────────────────────────────

규칙:
- 위 사장님 원 명령과 CEO step 이 충돌하면 **사장님 원 명령**이 우선.
- 사장님 원 명령에 명시 안 된 변경은 만들지 마세요 (페르소나 충동 무시).
- 페르소나는 톤·말투에만 쓰고, instruction-following 이 최우선.${preserveClauses.length > 0 ? '\n- 위 🔒 보존 제약은 CEO task 보다도 우선. 충돌하면 보존이 이긴다.' : ''}`;

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
        /* v2.92.x — 진행 strip 에 실제 호출되는 모델 표시. 사장님이 "정말 gpt-5.5 로 가는지" 눈으로 확인. */
        const agentModelForStrip = getAgentModel(t.agent, modelName);
        const progressDetails = [
            '작업 지시를 읽고 필요한 컨텍스트를 고르는 중입니다.',
            '요청과 기존 자료를 대조하며 핵심 조건을 확인하는 중입니다.',
            '필요한 데이터와 실행 단계를 정리하는 중입니다.',
            '결론과 적용할 변경 내용을 좁히는 중입니다.',
            '보고서에 넣을 핵심 결과를 압축하는 중입니다.',
            '응답을 마무리하고 검토하는 중입니다.',
            '모델 응답을 기다리며 진행 상태를 유지하는 중입니다.',
        ];
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
            /* v2.92.x — progressTick (in-place strip 갱신). 매 2.5초마다 elapsed 갱신 →
               웹뷰의 thinking strip 이 progress bar + 텍스트 부드럽게 흐름. phase 는 10초마다 변경 (시각 다양성). */
            const phaseIdx = Math.max(0, Math.floor(elapsedSec / 10));
            const phaseDefs: { icon: string; phase: string }[] = [
                { icon: '⏳', phase: '시작 중' },
                { icon: '🔄', phase: '분석 중' },
                { icon: '🧠', phase: '데이터 처리 중' },
                { icon: '⚙️', phase: '추론 중' },
                { icon: '💭', phase: '결과 정리 중' },
                { icon: '✨', phase: '거의 다 됐어요' },
                { icon: '⏳', phase: '무거운 모델 처리 중' },
            ];
            const cur = phaseDefs[Math.min(phaseIdx, phaseDefs.length - 1)];
            const detail = `${progressDetails[Math.min(phaseIdx, progressDetails.length - 1)]} · ${stripTask}`;
            post({
                type: 'progressTick',
                agent: t.agent,
                emoji: a.emoji,
                name: a.name,
                phase: cur.phase,
                task: stripTask,
                detail,
                icon: cur.icon,
                elapsedSec,
                timeStr,
                model: agentModelForStrip,
            });
            heartbeatChatTick = phaseIdx; /* 호환 — 더는 사용 안 함 */
        }, 2500); /* v2.89.157 — 2.5초로 단축. 사무실 시각 효과 (sparkle·thought·status) 더 자주 갱신 → 정지처럼 안 보임. */
        /* Session-state checkpoint: start agent slot so partial output
           is persisted even if the LLM call dies mid-stream. */
        ctx.sessionWriter?.startAgent(t.agent, t.task);
        try {
            /* v2.92.x — specialist 모델 매핑 적용. corp 모드는 modelSel.value 가 CSS hidden 으로
               stale (사장님이 직접 만질 수 없음). 사장님이 ad-chip 에서 본 매핑 (예: gpt-5.5 일괄) 이
               실제 라우팅까지 가야 함. getAgentModel(t.agent, modelName) — agent 매핑 있으면 그걸,
               없으면 modelName (corp 진입 시 fallback) 사용. */
            const agentModel = agentModelForStrip;
            out = await ctx.callAgentLLM(sysPrompt, userMsg, agentModel, t.agent, true, {
                onFirstToken: () => {
                    clearInterval(heartbeatInterval);
                    const waitSec = Math.round((Date.now() - llmStartTs) / 1000);
                    const mm = Math.floor(waitSec / 60);
                    const ss = waitSec % 60;
                    const timeStr = mm > 0 ? `${mm}분 ${ss}초` : `${ss}초`;
                    try {
                        post({
                            type: 'progressTick',
                            agent: t.agent, emoji: a.emoji, name: a.name,
                            phase: `응답 시작 — 첫 토큰까지 ${timeStr} 대기`,
                            icon: '📝',
                            elapsedSec: waitSec, timeStr,
                            model: agentModelForStrip,
                            firstToken: true,
                        });
                    } catch { /* ignore */ }
                    try { vscode.window.setStatusBarMessage(`✍️ ${a.emoji} ${a.name} 응답 생성 중`, 8000); } catch { /* ignore */ }
                },
                onChunk: (chunk) => {
                    /* Throttled to ~1s inside the writer. Streams agent text
                       to sessionDir/state.json so crash mid-LLM keeps everything
                       already received. */
                    ctx.sessionWriter?.appendAgentChunk(t.agent, chunk);
                },
            });
        } catch (e: any) {
            clearInterval(heartbeatInterval);
            if (isAborted()) {
                post({ type: 'agentEnd', agent: t.agent });
                post({ type: 'error', value: '🛑 사용자가 중단했어요.' });
                return { outputs, agentMeta, earlyReturn: true, blocked: false };
            }
            const detail = String(e?.message || e || '').slice(0, 300);
            /* provider 판정 — 매 specialist 의 실제 매핑 모델 (agentModelForStrip) 기준.
               try 안 const agentModel 은 catch scope 에 안 보임 → ReferenceError 차단. */
            const _m = (agentModelForStrip || modelName || '').toLowerCase();
            const _isCodex = _m.startsWith('gpt-') || _m.startsWith('gpt5') || _m.startsWith('o1') || _m.startsWith('o3');
            const _cliName = _isCodex ? 'Codex (GPT-5.5)' : 'Claude';
            const _cliBin = _isCodex ? 'codex' : 'claude';
            const _binSetting = _isCodex ? 'agentOs.codexBinPath' : 'agentOs.claudeBinPath';
            let hint = '';
            if (/ENOENT|not found/i.test(detail)) {
                hint = `\n💡 ${_cliName} CLI 미설치. \`${_cliBin} --version\` 확인 또는 settings.json 의 \`${_binSetting}\` 설정.`;
            } else if (/timed out|timeout/i.test(detail)) {
                hint = _isCodex
                    ? '\n💡 Codex (GPT-5.5) 응답이 시간 초과. 질문 길이 줄이거나 잠시 뒤 재시도.'
                    : '\n💡 Claude 응답이 시간 초과. Claude Max 5시간 한도 확인 또는 잠시 뒤 재시도.';
            } else if (/aborted/i.test(detail)) {
                hint = '\n💡 응답이 중간에 취소됐어요.';
            } else if (/(thinking|redacted_thinking)[\s\S]{0,120}(cannot be modified|must remain)|invalid_request_error|overloaded|rate[_\s-]?limit|\b429\b|\b5\d\d\b|API Error/i.test(detail)) {
                /* v2.92.x — 사용량/설치 문제 아님. CLI agentic 루프의 일시적 API 오류
                   (thinking 블록 재전송 400 등). streamAsk 가 이미 3회 자동 재시도했는데도
                   실패한 것 → 잠깐 뒤 다시 명령하면 대개 정상. 오답("사용량 초과") 차단. */
                hint = `\n💡 ${_cliName} API 일시 오류 (사용량·설치 문제 아님). 자동 재시도 후에도 실패 — 잠시 뒤 같은 명령 다시 내리면 대개 정상 작동해요.`;
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

        /* v2.92.x — Developer execution guard (환각 탐지 v2).
           읽기 액션(read/grep/glob)만 부르고 쓰기 액션(edit_file/create_file)은 안 한 채
           "Before/After 표 + ✅ 완료" 가짜 보고서 작성하는 패턴을 잡음. 사장님 사례:
           sessions/2026-05-26T06-15 — 4 read + 0 write + 풍성한 diff 표 + 실제 파일 변경 0건. */
        /* v2.92.x — Read-only 의도 명령은 환각 가드 자체 skip. 사장님이 "분석만/
           보고서만/수정 금지" 명시하면 write 0 이 정상이라 환각 retry 발동 X. */
        const _isReadOnlyIntent = READ_ONLY_INTENT_RE.test(prompt) || READ_ONLY_INTENT_RE.test(t.task);
        const shouldForceDevActions = !_isReadOnlyIntent && needsConcreteDeveloperAction(t.agent, t.task, prompt);
        const diag = isHallucinatingCompletion(out);
        /* read-only 명령이면 가드 자체 무효화 — git check 도 불필요. */
        if (_isReadOnlyIntent) {
            diag.hallucinating = false;
            diag.reason = 'read-only-intent-detected';
        }
        /* v2.92.x — Claude 내장 도구 변경 검증. ProoAI 액션 0개여도 git status 가
           specialist 시작 시점 대비 변했으면 실제 파일 변경 발생 → 환각 retry skip.
           이 fix 없이는 Claude Opus 가 Edit/Write 내장 도구로 정확히 수정해도 시스템이
           "환각" 판정하고 false-positive 재시도 메시지 표시 → 사장님 신뢰 깨짐. */
        let _claudeBuiltInChanged = false;
        if (diag.hallucinating) {
            const _gitAfter = captureGitState(_wsRoot);
            if (_gitAfter && _gitAfter !== _gitBefore) {
                _claudeBuiltInChanged = true;
                diag.hallucinating = false;
                diag.reason = 'claude-builtin-tool-changes-detected';
                const _diffSummary = (() => {
                    try {
                        const beforeLines = new Set(_gitBefore.split('\n').filter(Boolean));
                        const afterLines = _gitAfter.split('\n').filter(Boolean);
                        const newOrChanged = afterLines.filter(l => !beforeLines.has(l));
                        return newOrChanged.slice(0, 5).join(', ') || `${afterLines.length}개 파일`;
                    } catch { return '변경 발생'; }
                })();
                post({
                    type: 'response',
                    value: `✅ ${a.emoji} ${a.name}: ProoAI 액션 태그 0개이지만 Claude 내장 도구로 실제 파일 변경 감지 — 환각 X. 변경: ${_diffSummary}`,
                });
            }
        }
        if (shouldForceDevActions && diag.hallucinating && !_claudeBuiltInChanged) {
            try {
                post({ type: 'response',
                       value: `🚨 ${a.emoji} ${a.name}: 환각 탐지 — 읽기 ${diag.readCount}회 / 쓰기 **0회** 인데 "${diag.reason === 'fake-completion-report' ? '완료 보고서' : 'read-only 변명'}" 작성. 강제 재시도.` });
                const retryUserMsg = `[시스템 — 환각 탐지됨]

이전 응답 분석:
- 읽기 액션 (read_file/glob/grep/list_files): ${diag.readCount}회 호출
- 쓰기 액션 (edit_file/create_file/write_file/run_command): **0회 호출**
- 그런데 "Before/After 표 / ✅ 완료 / 변경 사항 요약" 같은 가짜 완료 보고를 작성함

이건 환각입니다. 실제 파일은 안 바뀌었습니다.

이번 응답에서 반드시 지킬 규칙:
1. **금지** — Before/After 표 작성 금지. "변경 사항 요약" 금지. "✅ 완료/적용/반영/교체" 결론 금지. diff 요약 금지. "다음 단계" 제안 금지. (시스템이 실제 실행 결과로 보여줌)
2. **필수** — 다음 형식으로만 출력:

\`\`\`
<grep pattern="실제_타깃_텍스트" files="**/*.tsx"/>
\`\`\`
→ 결과에서 진짜 파일 경로 확인. (이전 grep 0매치였으면, 키워드를 더 넓게 또는 부분 문자열로 다시 시도)

\`\`\`
<edit_file path="찾은_파일_절대경로">
find: <정확히 그 파일 안에 존재하는 원문 일부>
replace: <새 카피>
</edit_file>
\`\`\`
→ find 의 문자열이 grep 결과로 확인된 실재 텍스트여야 함. 추측 금지.

3. **출력 끝맺음** — 마지막 한 줄로만 "수정 완료: {파일경로}" (시스템이 진짜 결과를 그 뒤에 붙임).

[CEO 원 지시]
${t.task}

[원 사용자 명령]
${prompt}

[이전 응답에서 네가 호출한 액션]
${(out.match(/<[a-z_]+[^>]*>/gi) || []).slice(0, 20).join('\n')}`;
                const retryOut = await ctx.callAgentLLM(sysPrompt, retryUserMsg, getAgentModel(t.agent, modelName), t.agent, true, {
                    onChunk: (chunk) => ctx.sessionWriter?.appendAgentChunk(t.agent, chunk),
                });
                if ((retryOut || '').trim()) out = `${out}\n\n---\n## 🔁 환각 재시도 (읽기 ${diag.readCount} / 쓰기 0)\n\n${retryOut}`;
                /* 재시도 후에도 여전히 쓰기 액션 0이면 사장님에게 명시 알림 — 조용히 통과 X. */
                const postRetryWrites = (retryOut || '').match(/<(?:create_file|write_file|file|edit_file|edit|delete_file|run_command|command|bash|terminal)\b/gi) || [];
                if (postRetryWrites.length === 0) {
                    post({ type: 'response',
                           value: `⚠️ ${a.emoji} ${a.name}: 재시도 후에도 쓰기 액션 **0회** — 모델 한계 또는 타깃 텍스트가 코드에 없음. 사장님이 직접 grep 으로 진짜 위치 확인 필요.` });
                    out = `${out}\n\n⚠️ 환각 재시도 실패 — 쓰기 액션 0회 유지. 사장님 수동 확인 필요.`;
                }
            } catch (e: any) {
                out = `${out}\n\n⚠️ 환각 재시도 실패: ${e?.message || e}`;
            }
        }

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
            /* v2.92.x — 위험 명령 0순위 차단. sudo, rm -rf /, mkfs, dd of=/dev/,
               --no-verify, curl | sh 등은 specialist 가 출력해도 실행하지 않음.
               시스템 파괴 사고 0건 보장 + 채팅창에 사장님 알림 + specialist out
               에 차단 사실 append (다음 라운드에서 LLM 도 인지하고 회피). */
            const safeCmds: string[] = [];
            const blockedHits: { cmd: string; reason: string }[] = [];
            for (const c of cmds) {
                const hit = detectDangerousCommand(c);
                if (hit) {
                    blockedHits.push(hit);
                    try { post({ type: 'response', value: formatBlockedCommandNotice(hit) }); } catch { /* ignore */ }
                    out = `${out}${formatBlockedCommandInjection(hit)}`;
                } else {
                    safeCmds.push(c);
                }
            }
            if (blockedHits.length > 0 && safeCmds.length === 0) {
                /* 전부 차단됨 — 실행할 게 없음. 다음 단계로 그대로 진행. */
            }
            cmds.length = 0;
            cmds.push(...safeCmds);
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
            /* v2.92.x — 게이트 확장. 사장님이 명시적 implementation 키워드 안 써도
               (예: "다음 작업 진행해", "outreach 완성하고 ...") 작업형 agent 가 read·
               exec 만 호출하고 write 없이 종료하면 자동 재호출. fileInjections 가 비
               어 있어도 (run_command 만 출력했을 때) fileReport 가 있으면 재호출. */
            const postExecDiag = isHallucinatingCompletion(out);
            const needsContinue = needsContinuationAfterRead(
                t.agent, postExecDiag.readCount, postExecDiag.writeCount, postExecDiag.execCount,
            );
            const haveSomethingToInject = fileReport.length > 0 || fileInjections.length > 0;
            /* v2.92.x — simple command 일 땐 적용 재시도 skip. 단순 명령은 환각 retry
               1회로 충분. 추가 LLM 호출 = round trip 증가 = 사장님 대기.
               read-only 의도 명령도 skip — 분석/보고서만 명령에 적용 재시도 = false-positive. */
            if (!simpleCommand && !_isReadOnlyIntent && (shouldForceDevActions || needsContinue) && haveSomethingToInject && !WRITE_SUCCESS_RE.test(fileReport.join('\n'))) {
                try {
                    const reason = shouldForceDevActions
                        ? '명시적 implementation 요청인데 write 0회'
                        : `${a.name} 가 read·exec 만 ${postExecDiag.readCount + postExecDiag.execCount}회 호출하고 write 0회로 응답 종료`;
                    post({ type: 'response', value: `🔁 ${a.emoji} ${a.name}: ${reason} → 적용 단계 자동 재호출.` });
                    const applyUserMsg = `[시스템 재지시 — 적용 단계 자동 재호출]
직전 응답에서 read·grep·list·run_command 만 출력하고 write 액션 (create_file/edit_file/delete_file) 0회로 응답이 종료됐습니다. 사장님 명령은 "실제 산출물 만들기" 가 핵심입니다. 이제 진짜 작업하세요.

규칙:
- 추가 read·grep·list 호출 **금지**. 이미 충분히 봤습니다.
- 같은 응답에서 <create_file> 또는 <edit_file> 또는 (변경 후) <run_command>를 **최소 1개** 출력하세요.
- 무엇을 만들지 모르겠으면 사장님 명령을 작은 단위로 쪼개서 첫 번째 산출물부터 만드세요.
- 절대 "다음 단계에서 ~ 하겠습니다", "준비됐습니다" 같은 약속 종료 금지. 같은 응답 내 write 액션으로 끝맺기.

[사장님 원 명령]
${prompt}

[CEO 가 변환한 step]
${t.task}

[직전 응답에서 네가 부른 액션 카운트]
- read·glob·grep·list: ${postExecDiag.readCount}회
- run_command/bash: ${postExecDiag.execCount}회
- create_file/edit_file: ${postExecDiag.writeCount}회 ← 이게 0이라 재호출

[직전 응답에서 시스템이 실행한 파일 액션 결과]
${fileReport.join('\n')}
${fileInjections.join('\n').slice(0, 20000)}`;
                    const applyOut = await ctx.callAgentLLM(sysPrompt, applyUserMsg, getAgentModel(t.agent, modelName), t.agent, true, {
                        onChunk: (chunk) => ctx.sessionWriter?.appendAgentChunk(t.agent, chunk),
                    });
                    if ((applyOut || '').trim()) {
                        const applyReports: string[] = [];
                        const applyInjections: string[] = [];
                        const ar = await ctx.executeActions(applyOut, {
                            rootOverride: fileActionRoot,
                            appendToOutput: (s) => applyInjections.push(s),
                            silent: true,
                            skipRunCommand: false,
                            agentId: t.agent,
                        });
                        applyReports.push(...ar);
                        out = `${out}\n\n---\n## 🔁 적용 액션 재시도\n\n${applyOut}`;
                        if (applyReports.length > 0) {
                            post({ type: 'response', value: `📁 ${a.emoji} ${a.name} 적용 재시도 결과:\n${applyReports.slice(0, 5).join('\n')}` });
                            out += `\n\n### 적용 재시도 결과\n${applyReports.join('\n')}${applyInjections.join('')}`;
                        }
                    }
                } catch (e: any) {
                    out = `${out}\n\n⚠️ 적용 액션 재시도 실패: ${e?.message || e}`;
                }
            }
        } catch (e: any) {
            /* 파일 액션 실패해도 dispatch 진행. 로그만 남김. */
            try { post({ type: 'response', value: `⚠️ ${a.emoji} ${a.name} 파일 액션 처리 중 오류: ${e?.message || e}` }); } catch { /* ignore */ }
        }

        /* v2.92.x — Multi-turn continuation loop. 사장님 요구: "claude code 보다 나은 agent".
           단발 LLM 호출은 1턴 안에서 read → write 반복이 안 됨 → specialist가 read만 하고 끝나는
           "환각" 사고. 위에서 한 번 retry 했어도 복잡한 작업은 3~5턴 필요.
           이 loop는 agent가 <done/> 출력하거나 액션 발행을 멈출 때까지 자동 다음 턴 진입.
           각 턴마다 tool 결과를 user msg 로 feedback → Claude Code의 multi-turn 도구 호출과 동일 패턴.
           shortcut path 는 1회성이므로 continuation skip. */
        /* v2.92.x — simple command 일 땐 multi-turn 자체 skip. README 1줄 추가에
           multi-turn 까지 도는 건 사장님 대기 시간만 증가. 복잡 명령일 때만 5턴까지. */
        const MAX_CONTINUATION_TURNS = simpleCommand ? 0 : 5;
        const DONE_RE = /<done\s*\/?>|✅\s*done|작업\s*완료\s*<\/?\s*done\s*\/?>/i;
        const ACTION_RE = /<(?:run_command|command|bash|terminal|create_file|write_file|edit_file|delete_file|file)\b/i;
        for (let ct = 0; ct < MAX_CONTINUATION_TURNS && !shortcut; ct++) {
            if (isAborted()) break;
            if (DONE_RE.test(out)) break;
            /* 직전 턴 (out 의 마지막 8000자) 에서 새 액션이 있었는지 확인.
               없으면 agent 가 알아서 끝낸 것 → continuation 의미 없음. */
            const tail = out.slice(-8000);
            if (!ACTION_RE.test(tail)) break;
            /* 이미 마지막 턴이 "도구 실행 결과" / "파일 액션 결과" / "적용 재시도" 등 시스템
               inject 만 있고 새 LLM 발화 부분에 action 이 없으면 break. 위 ACTION_RE 가 tail
               에서 매치되더라도, 그게 시스템 inject 안의 명령 echo 일 수 있어서 한 번 더 체크. */
            const lastLlmSection = out.split(/##\s+🛠️\s+도구\s+실행\s+결과|##\s+📁\s+파일\s+액션\s+결과|##\s+🔁\s+적용\s+액션\s+재시도|##\s+🔁\s+환각\s+재시도/i).slice(-1)[0] || '';
            if (!ACTION_RE.test(lastLlmSection)) break;

            try {
                post({ type: 'response', value: `🔄 ${a.emoji} ${a.name}: turn ${ct + 2} 계속 (multi-turn) …` });
                const continueUserMsg = `[시스템 — 다음 턴 자동 진입 (multi-turn ${ct + 2}/${MAX_CONTINUATION_TURNS + 1})]
직전 턴에서 너가 발행한 액션과 그 실행 결과는 아래에 첨부됨. 사장님 원 명령이 완전히 끝났으면 \`<done/>\` 한 줄만 출력. 아니면 다음 액션 (반드시 실제 작업) 발행.

규칙:
- 이미 시스템이 read/grep/list/run_command/edit_file 모두 실행해 결과를 보여줬으니, 같은 호출 반복 금지.
- "다음 단계에서 ~ 하겠다", "준비됐다" 같은 약속 종료 금지 — 같은 응답 안에 진짜 액션 또는 \`<done/>\`.
- 추가 발행 액션 없이 그냥 분석/요약만 쓰면 그게 곧 작업 종료 신호.

[직전 턴 누적 (LLM 발화 + tool 결과)]
${out.slice(-15000)}

[사장님 원 명령 다시 확인]
${prompt}`;
                const turnOut = await ctx.callAgentLLM(sysPrompt, continueUserMsg, getAgentModel(t.agent, modelName), t.agent, true, {
                    onChunk: (chunk) => ctx.sessionWriter?.appendAgentChunk(t.agent, chunk),
                });
                if (!turnOut || !turnOut.trim()) break;
                /* turn 출력을 누적 */
                out = `${out}\n\n---\n## 🔄 multi-turn ${ct + 2}\n\n${turnOut}`;
                /* turn 의 액션 실행. run_command + 파일 액션 모두 ctx.executeActions 가 처리 (skipRunCommand=false 기본).
                   streaming 출력은 lost (continuation 은 빠른 처리가 우선) — 사장님 사례 1턴짜리 작업 아닌 multi-step 보장이 더 중요. */
                const turnInjections: string[] = [];
                const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                const fileActionRoot = wsRoot || getCompanyDir();
                const turnReports = await ctx.executeActions(turnOut, {
                    rootOverride: fileActionRoot,
                    appendToOutput: (s) => turnInjections.push(s),
                    silent: true,
                    skipRunCommand: false,
                    agentId: t.agent,
                });
                if (turnReports.length > 0 || turnInjections.length > 0) {
                    out += `\n\n### multi-turn ${ct + 2} 결과\n${turnReports.join('\n')}${turnInjections.join('')}`;
                    post({ type: 'response', value: `📁 ${a.emoji} ${a.name} multi-turn ${ct + 2} 액션 ${turnReports.length}건 실행` });
                }
                /* checkpoint */
                ctx.sessionWriter?.setAgentText(t.agent, out);
            } catch (e: any) {
                out = `${out}\n\n⚠️ multi-turn ${ct + 2} 실패: ${e?.message || e}`;
                break;
            }
        }
        /* multi-turn 종료 사유 로그 */
        if (DONE_RE.test(out)) {
            post({ type: 'response', value: `✅ ${a.emoji} ${a.name}: <done/> 신호로 종료` });
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
            /* Checkpoint: agent slot now reflects the final post-processed text
               (includes tool exec results / file action results). Writer flushes
               immediately on phase boundary. */
            ctx.sessionWriter?.setAgentText(t.agent, out);
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
            ctx.sessionWriter?.setAgentText(t.agent, out);
            ctx.sessionWriter?.endAgent(t.agent, 'blocked', undefined, 'OAuth trigger');
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
            /* 명시적 신호. bare `키` 음절은 한국어 dev 용어 (패키지·아키텍처·도키 등)
               에 흔해서 false-positive 다발 — 항상 (API|access|secret|발급|발행) 같은
               자격증명 컨텍스트와 묶어서만 매칭. 2026-05-28 사례: 개발신이 sharp 미설치
               안내하다가 "패키지의 peer" / "아키텍처·권한" 두 줄에 키 음절이 잡혀
               전체 dispatch 가 중단된 사고. */
            const credKey = /(API|access|secret|토큰|token|발급|발행)\s*키/i;
            if (/API\s*키.*(필요|입력|미설정)/i.test(o)) return true;
            if (/OAuth\s*(연결|미연결).*(필요|해주세요)/i.test(o)) return true;
            if (/(자격증명|credentials).*(필요|미설정|missing)/i.test(o)) return true;
            /* ⚠️ + 미설정 도 그 라인에 키워드 (API·OAuth·credentials·자격증명·환경변수) 동반 시만 */
            if (/⚠️[^\n]*(API|OAuth|credentials|자격증명|환경\s*변수|env|키)[^\n]*미설정/i.test(o)) return true;
            /* 자가평가가 '대기' + 본문에 명확한 자격증명 신호.
               Bare "API" 는 너무 넓다. 개발 작업 보고서의 "API 인증은
               middleware가 보호" 같은 정상 문장까지 자격증명 부족으로 오판했다. */
            if (/📊\s*평가:\s*대기/i.test(o)
                && (
                    credKey.test(o)
                    || /OAuth\s*(연결|미연결|인증).*(필요|해주세요|미설정)/i.test(o)
                    || /(credentials|자격증명).*(필요|미설정|missing)/i.test(o)
                    || /(환경\s*변수|env).*(미설정|누락|missing)/i.test(o)
                )) return true;
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
            ctx.sessionWriter?.setAgentText(t.agent, out);
            ctx.sessionWriter?.endAgent(t.agent, 'blocked', undefined, 'credentials missing');
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
        /* 개인 메모리 누적 — 이전엔 매 task 마다 "task → sessions/x.md" 메타
           한 줄 무조건 append (noise). 이제는 agent 가 답변에 명시한
           `🧠 학습: ...` 마커만 검증 게이트 통과 후 저장 (system.md 기준).
           산출물 위치는 sessions/ 폴더 자체로 추적되므로 메모리 중복 불필요. */
        try {
            const { persistLearnings } = await import('../../dispatch/agent-memory');
            /* 현재 워크스페이스의 프로젝트 이름을 stamp 로 사용. 없으면 _orphan
               으로 분류 (cross-project 노이즈 방지 — buildScopedMemoryBlock 이
               다른 프로젝트 학습은 drop 함). */
            let currentProjectName: string | undefined;
            try {
                const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (wsRoot) {
                    const { readProjectMeta } = await import('../../company/project-meta');
                    currentProjectName = readProjectMeta(wsRoot)?.name;
                }
            } catch { /* fall through with undefined */ }
            const n = persistLearnings(t.agent, out, currentProjectName);
            if (n > 0) post({ type: 'response', value: `🧠 ${a.emoji} ${a.name} 학습 ${n}개 memory.md 누적` });
        } catch (e: any) {
            console.warn('[specialist-loop] persistLearnings failed:', e?.message || e);
        }
        /* Self-RAG promotion: if this agent is in self-rag mode, scan
           its output for [근거: ...] tagged claims and append them to
           verified.md. memory.md still gets the learning gate above
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
        /* Checkpoint: agent finished cleanly — mark phase complete in state.json
           so on resume we'd skip re-running it. */
        ctx.sessionWriter?.endAgent(t.agent, 'done', agentMeta[t.agent]);
        post({ type: 'agentEnd', agent: t.agent });

        const metrics = getCompanyMetrics();
        updateCompanyMetrics({ tasksCompleted: (metrics.tasksCompleted || 0) + 1 });
    }

    return { outputs, agentMeta, earlyReturn: false, blocked: false };
}
