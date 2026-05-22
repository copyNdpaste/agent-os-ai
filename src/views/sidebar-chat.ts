/**
 * SidebarChatProvider — VS Code 사이드바 메인 챗 webview. 사용자 ↔ CEO ↔
 * 에이전트들 사이의 모든 대화·디스패치·상태 동기화의 본진. 5,564 줄.
 *
 * extension.ts 에서 분리. wrapper 측에서 instantiate (`new SidebarChatProvider(context)`).
 *
 * 이번 사이클은 byte-for-byte 복사만. 다음 사이클에서 메서드별 잘게 분해 예정.
 *
 * Deps imported from `../extension` (이미 export 추가됐거나 wiring 단계에서 추가될 것들):
 *   상수 / 프롬프트:
 *     - SYSTEM_PROMPT, CEO_CHAT_PROMPT, CEO_PLANNER_PROMPT, CEO_REPORT_PROMPT
 *     - CONFER_PROMPT, DECISIONS_EXTRACT_PROMPT, SECRETARY_TRIAGE_PROMPT
 *     - EXCLUDED_DIRS, MAX_CONTEXT_SIZE
 *   상태:
 *     - _autoSyncRunning            (mutable — 같은 모듈에서 읽기·쓰기)
 *   helpers (module-level functions):
 *     - getConfig, _personalizePrompt, _harvestActionItems, _isCasualChat
 *     - _safeGitAutoSync, _safeGitAutoSyncCompany
 *     - _ensureBrainDir
 *     - _findActiveDispatch, _startActiveDispatch, _endActiveDispatch
 *     - _updateActiveDispatchStep, _pushTelegramHistory
 *     - _serializeMessages, _extractFirstJsonObject, _modelToTier
 *     - _RENDER_GRAPH_HTML, BrainGraph (type), buildKnowledgeGraph
 *     - _readYtOAuthClient, startYouTubeOAuthFlow
 *     - sendTelegramReport, sendTelegramLong, readTelegramConfig
 *     - readSecretaryBridgeMode
 *     - readAgentSharedContext, readAgentGoal, writeAgentGoal
 *     - writeAgentSelfRagCriteria, writeToolConfig, setToolEnabled
 *     - appendAgentMemory, appendConversationLog
 *     - getCompanyDay, getCompanyMetrics, updateCompanyMetrics
 *     - readCompanyConfig, writeCompanyConfig, CompanyConfig (type)
 *     - isCompanyConfigured
 *     - getAgentModel
 *     - makeSessionDir
 *     - prefetchAgentRealtimeData, promoteGroundedClaimsFromOutput
 *     - routeBrainInjectionToAgents
 *     - addTrackerTask, autoMarkTrackerFromDispatch, rebuildUnifiedSchedule
 *     - buildAgentConfigStatus, buildSpecialistPrompt
 *   기존 export (Cycle 1~4 에서 이미 노출):
 *     - getConversationsDir, readRecentConversations
 *     - readCompanyName
 *     - ensureCompanyStructure, _safeReadText
 *     - readAgentModelMap, writeAgentModelMap, _autoOrchestrateModelMap
 *     - listInstalledModels, _maybeRecommendCoderModel
 *     - readActiveAgents, readHiredAgents, isAgentActive, markAgentHired, setAgentActive
 *     - listAgentTools, readAgentRagMode, writeAgentRagMode, readAgentSelfRagCriteria
 *     - countAgentVerifiedClaims
 *   webview wrapper classes:
 *     - CompanyDashboardPanel, OfficePanel
 *
 * Deps from extracted modules:
 *   - import * as dsp from '../dispatch'
 *
 * Infra modules (이미 분리됨):
 *   - safeResolveInside, safeBasename, MAX_FILE_NAME_LEN ← '../infra/path-safety'
 *   - _renderUnifiedDiff ← '../infra/diff'
 *   - _globMatch, _grepFiles ← '../infra/glob'
 *   - runCommandCaptured ← '../infra/process'
 *   - _pythonCmd, _isPythonMissing, _pythonMissingHint ← '../infra/python'
 *   - _revealInOsExplorer, _openInDefaultApp ← '../infra/system'
 *
 * Git infra:
 *   - gitExec, gitExecSafe, gitRun, isGitAvailable, classifyGitError,
 *     validateGitRemoteUrl, getRemoteDefaultBranch, ensureInitialCommit,
 *     ensureBrainGitignore ← '../infra/git'
 *
 * Paths:
 *   - _getBrainDir, _isBrainDirExplicitlySet, getCompanyDir ← '../paths'
 *
 * Agents / system specs:
 *   - AGENTS, AGENT_ORDER, SPECIALIST_IDS ← '../agents'
 *   - getSystemSpecs, estimateModelMemoryGB ← '../system-specs'
 *
 * LLM:
 *   - ask, streamAsk, pingClaude, type Tier ← '../llm'
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import axios from 'axios';
import { ask, streamAsk, pingClaude, type Tier } from '../llm';
import {
    gitExec, gitExecSafe, gitRun,
    isGitAvailable, classifyGitError, validateGitRemoteUrl,
    getRemoteDefaultBranch, ensureInitialCommit, ensureBrainGitignore,
} from '../infra/git';
import {
    safeResolveInside, resolveFlexiblePath as _resolveFlexiblePath, safeBasename,
    MAX_FILE_NAME_LEN,
} from '../infra/path-safety';
import { renderUnifiedDiff as _renderUnifiedDiff } from '../infra/diff';
import {
    globMatch as _globMatch,
    grepFiles as _grepFiles,
} from '../infra/glob';
import { runCommandCaptured } from '../infra/process';
import {
    pythonCmd as _pythonCmd,
    isPythonMissing as _isPythonMissing,
    pythonMissingHint as _pythonMissingHint,
} from '../infra/python';
import {
    revealInOsExplorer as _revealInOsExplorer,
    openInDefaultApp as _openInDefaultApp,
} from '../infra/system';
import { _getBrainDir, _isBrainDirExplicitlySet, getCompanyDir } from '../paths';
import { AGENTS, AGENT_ORDER, SPECIALIST_IDS } from '../agents';
import { getSystemSpecs, estimateModelMemoryGB } from '../system-specs';
import * as dsp from '../dispatch';
import {
    stripActionTags as _hStripActionTags,
    buildThinkingHtml as _hBuildThinkingHtml,
    findBrainFiles as _hFindBrainFiles,
    getSecondBrainContext as _hGetSecondBrainContext,
    readBrainFile as _hReadBrainFile,
    getProjectMemory as _hGetProjectMemory,
    getWorkspaceContext as _hGetWorkspaceContext,
    detectExplicitMention as _hDetectExplicitMention,
    tryRevenueShortcut as _hTryRevenueShortcut,
    tryKitShortcut as _hTryKitShortcut,
    fuzzyPathHint as _hFuzzyPathHint,
    buildRecentFilesContext as _hBuildRecentFilesContext,
    getSidebarHtml as _hGetSidebarHtml,
    classifyChatError as _hClassifyChatError,
    buildActiveEditorContext as _hBuildActiveEditorContext,
    trackFileAction as _hTrackFileAction,
    pruneHistory as _hPruneHistory,
    parseChatterTurns as _hParseChatterTurns,
    readSessions as _hReadSessions,
    writeSessions as _hWriteSessions,
    archiveCurrentChat as _hArchiveCurrentChat,
    archiveOrUpdateCurrentChat as _hArchiveOrUpdateCurrentChat,
    deleteSession as _hDeleteSession,
    currentWorkspaceMeta as _hCurrentWorkspaceMeta,
} from '../chat';
import { runActionCoordinator } from '../chat/actions/coordinator';
import {
    runSpecialistLoop,
    runConferPhase,
    runReportPhase,
    runDecisionsPhase,
    type CorporateContext,
    type Plan as CorporatePlan,
} from '../chat/corporate';
import { _readYtOAuthClient } from '../youtube/oauth';
import {
    /* 상수 / 프롬프트 */
    SYSTEM_PROMPT,
    CEO_CHAT_PROMPT,
    CEO_PLANNER_PROMPT,
    CEO_REPORT_PROMPT,
    CONFER_PROMPT,
    DECISIONS_EXTRACT_PROMPT,
    SECRETARY_TRIAGE_PROMPT,
    EXCLUDED_DIRS,
    MAX_CONTEXT_SIZE,
    /* 가변 상태 (모듈 단위 mutable) — write 는 setter 통해서. ESM let binding 은
       import 측에서 read-only 라 _setAutoSyncRunning 으로 갱신. */
    _autoSyncRunning,
    _setAutoSyncRunning,
    /* 모듈-수준 helper */
    getConfig,
    _personalizePrompt,
    _harvestActionItems,
    _isCasualChat,
    _safeGitAutoSync,
    _safeGitAutoSyncCompany,
    _ensureBrainDir,
    _findActiveDispatch,
    _startActiveDispatch,
    _endActiveDispatch,
    _updateActiveDispatchStep,
    _pushTelegramHistory,
    _serializeMessages,
    _extractFirstJsonObject,
    _modelToTier,
    _RENDER_GRAPH_HTML,
    type BrainGraph,
    buildKnowledgeGraph,
    /* _readYtOAuthClient: Cycle 6 에서 src/youtube/oauth.ts 로 이동. 직접 import. */
    startYouTubeOAuthFlow,
    sendTelegramReport,
    sendTelegramLong,
    readTelegramConfig,
    readSecretaryBridgeMode,
    readAgentSharedContext,
    readAgentGoal,
    writeAgentGoal,
    writeAgentSelfRagCriteria,
    writeToolConfig,
    setToolEnabled,
    appendAgentMemory,
    appendConversationLog,
    getCompanyDay,
    getCompanyMetrics,
    updateCompanyMetrics,
    readCompanyConfig,
    writeCompanyConfig,
    type CompanyConfig,
    isCompanyConfigured,
    getAgentModel,
    makeSessionDir,
    prefetchAgentRealtimeData,
    promoteGroundedClaimsFromOutput,
    routeBrainInjectionToAgents,
    addTrackerTask,
    autoMarkTrackerFromDispatch,
    rebuildUnifiedSchedule,
    buildAgentConfigStatus,
    buildSpecialistPrompt,
    /* 이미 export 되어있는 것들 */
    getConversationsDir,
    readRecentConversations,
    readCompanyName,
    ensureCompanyStructure,
    _safeReadText,
    readAgentModelMap,
    writeAgentModelMap,
    _autoOrchestrateModelMap,
    listInstalledModels,
    _maybeRecommendCoderModel,
    readActiveAgents,
    readHiredAgents,
    isAgentActive,
    markAgentHired,
    setAgentActive,
    listAgentTools,
    readAgentRagMode,
    writeAgentRagMode,
    readAgentSelfRagCriteria,
    countAgentVerifiedClaims,
    /* 누락된 deps — wire 단계에서 발견 */
    _extCtx,
    setCompanyDir,
    ALWAYS_ON_AGENTS,
    LOCKED_AGENTS_DEFAULT,
    _activeChatProvider,
    CompanyDashboardPanel,
    OfficePanel,
} from '../extension';

export class SidebarChatProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    // Sidebar's 1인 기업 모드 toggle. When false, autonomous corp activity
    // (morning briefing, auto cycle, ambient chatter) still runs in the
    // background and writes to the conversation log + office panel, but is
    // suppressed in the chat sidebar so regular chats stay clean.
    private _sidebarCorpModeOn: boolean = false;
    private _chatHistory: { role: string; content: string }[] = [];
    private _ctx: vscode.ExtensionContext;

    // 대화 표시용 (system prompt 제외, 유저에게 보여줄 것만 저장)
    private _displayMessages: { text: string; role: string }[] = [];
    private _isSyncingBrain: boolean = false;
    public _brainEnabled: boolean = true; // 🧠 ON/OFF 토글 상태
    private _abortController?: AbortController;
    private _lastPrompt?: string;
    private _lastModel?: string;
    /** v2.89.131 — 최근 파일 액션 추적. 코다리(또는 다른 specialist) 가 직전 turn 에
     *  만든·편집한 파일의 절대 경로를 기억해서, 다음 turn 의 system prompt 에 명시
     *  주입한다. 이전엔 chat history 안 깊은 곳에 묻혀서 LLM 이 잊고 경로 추측 → 못
     *  찾는 사고 자주 났음. 가장 최근 10개만 보관, 30분 묵은 건 자동 폐기. */
    private _recentFileActions: Array<{
        agentId: string;
        absPath: string;
        action: 'create' | 'edit' | 'delete';
        ts: number;
    }> = [];
    /** Tracks user activity for autonomous cycle gating — only fires auto-work
     *  when user has been idle for the configured threshold. */
    private _lastUserActivityTs: number = Date.now();
    private _autoCycleTimer?: NodeJS.Timeout;
    private _autoCycleRunning: boolean = false;

    // 🎬 Thinking Mode — live cinematic graph that visualises AI reasoning
    private _thinkingMode: boolean = false;
    private _thinkingPanel?: vscode.WebviewPanel;
    private _thinkingReady: boolean = false;
    // Externally-opened brain network panels (메뉴 → 🌐 네트워크 보기) that should
    // also receive thinking events so the user sees the same node pulse / trail.
    private _externalGraphPanels: Set<vscode.WebviewPanel> = new Set();
    public registerExternalGraphPanel(panel: vscode.WebviewPanel) {
        this._externalGraphPanels.add(panel);
        panel.onDidDispose(() => this._externalGraphPanels.delete(panel));
    }

    // 🏢 Office panel broadcast — corporate-mode 메시지를 사이드바와 풀스크린
    // 사무실 패널 양쪽에 동시에 보내기 위한 list. OfficePanel이 자기 webview를 등록.
    private _corporateBroadcastTargets: Set<vscode.Webview> = new Set();
    public registerCorporateBroadcastTarget(webview: vscode.Webview) {
        this._corporateBroadcastTargets.add(webview);
    }
    public unregisterCorporateBroadcastTarget(webview: vscode.Webview) {
        this._corporateBroadcastTargets.delete(webview);
    }
    /* Public pulse — module-level helpers (createApproval, YouTube tool
       runs) call this to light up an agent's desk in the office view.
       Routed through the same broadcast pipeline as agentEnd so the
       Office panel + sidebar (when corp-mode on) both receive it. */
    public pulseAgent(agent: string, icon: string = '✨', ms: number = 3000, log?: string) {
        this._broadcastCorporate({ type: 'agentPulse', agent, icon, ms, log });
        try { this._view?.webview.postMessage({ type: 'agentPulse', agent, icon, ms, log }); } catch { /* ignore */ }
    }
    private _broadcastCorporate(msg: any) {
        // Sidebar receives corp messages ONLY when its 1인 기업 모드 toggle is ON.
        // The office panel always receives them; the daily conversation log file
        // is written separately by appendConversationLog() upstream.
        if (this._sidebarCorpModeOn) {
            try { this._view?.webview.postMessage(msg); } catch { /* ignore */ }
        }
        this._corporateBroadcastTargets.forEach(w => {
            try { w.postMessage(msg); } catch { /* disposed */ }
        });
    }

    /* v2.89.45 — 에이전트 프로필 사진을 markdown으로 반환. 채팅창에 메시지 위에 prepend
       해서 "진짜 사람이 말하는 느낌" 연출. profileImage가 정의된 에이전트(레오/영숙)만
       사진 나오고, 나머지는 빈 문자열 → 그냥 emoji + 이름. */
    private _agentAvatarMd(agentId: string): string {
        const a = AGENTS[agentId];
        if (!a?.profileImage || !this._view) return '';
        try {
            const uri = this._view.webview.asWebviewUri(
                vscode.Uri.joinPath(this._extensionUri, 'assets', 'agents', a.profileImage)
            );
            return `<img src="${uri.toString()}" alt="${a.name}" width="56" height="56" style="border-radius:50%;vertical-align:middle;margin-right:12px;border:2px solid ${a.color}"/>`;
        } catch { return ''; }
    }

    /* v2.89.47 — 마크다운 이미지 버전. webview markdown sanitizer가 inline <img> HTML
       문자 그대로 표시하던 문제 해결. ![alt](url) 형식은 표준 마크다운이라 항상 렌더됨.
       헤딩 라인 뒤에 같이 붙여서 ## ![](url) 📺 레오 형태로 한 줄 헤더 만듦. */
    private _agentAvatarUriMd(agentId: string): string {
        const a = AGENTS[agentId];
        if (!a?.profileImage || !this._view) return '';
        try {
            const uri = this._view.webview.asWebviewUri(
                vscode.Uri.joinPath(this._extensionUri, 'assets', 'agents', a.profileImage)
            );
            /* 마크다운 이미지 + alt text. 가까이 붙어 있는 텍스트와 함께 헤딩에 들어가게 */
            return `![${a.name}](${uri.toString()}) `;
        } catch { return ''; }
    }
    /** Notify the sidebar webview that the office panel opened/closed so it can update its UI. */
    public broadcastOfficeState(open: boolean) {
        try { this._view?.webview.postMessage({ type: 'officeStateChanged', open }); } catch { /* ignore */ }
    }

    // 외부 (OfficePanel)에서 명령을 받아 corporate 작업 시작
    public async runCorporatePromptExternal(prompt: string, modelName: string) {
        this._markActivity();
        await this._handleCorporatePrompt(prompt, modelName);
    }
    public async runAutonomousChatter(modelName: string): Promise<void> {
        await this._runAutonomousChatter(modelName);
    }
    public _markActivity() { this._lastUserActivityTs = Date.now(); }

    /** Fire a "morning briefing" the first time the IDE is opened on a new day,
     *  IF the company is configured. CEO reads goals + recent progress and
     *  proposes the day's top 3 priorities — sets the tone of an autonomous co. */
    public async maybeMorningBriefing(ctx: vscode.ExtensionContext) {
        try {
            if (!isCompanyConfigured()) return;
            // 사용자가 24시간 업무를 OFF 했으면 자동 브리핑도 같이 OFF.
            const enabled = vscode.workspace.getConfiguration('agentOs').get<boolean>('autoCycleEnabled', true);
            if (!enabled) return;
            const today = new Date().toISOString().slice(0, 10);
            const last = ctx.globalState.get<string>('lastMorningBriefDate', '');
            if (last === today) return;
            await ctx.globalState.update('lastMorningBriefDate', today);
            // Wait a bit for the IDE / sidebar to settle so the user sees the
            // brief unfold instead of getting hit instantly.
            setTimeout(() => {
                const model = this.getDefaultModel();
                if (!model) return;
                this._handleCorporatePrompt(
                    `[모닝 브리핑] 오늘 날짜는 ${today}입니다. 회사 목표(goals.md)와 지금까지의 의사결정 로그를 바탕으로 오늘 우리 회사가 우선순위로 처리해야 할 작업 3가지를 결정하고, 각 작업을 적절한 에이전트에게 분배하세요.`,
                    model,
                ).catch(() => { /* silent */ });
            }, 12000);
        } catch { /* never break activation on briefing failure */ }
    }

    /** Start the auto-cycle scheduler. Every interval, if idle > threshold and
     *  the company is configured, CEO autonomously dispatches one priority task. */
    /** 24시간 자율 업무 — 사용자가 자리에 있든 없든, 1인 기업 모드(👔)가
     *  사이드바에 켜져 있든 꺼져 있든, autoCycleEnabled가 true면 정해진
     *  간격마다 CEO가 알아서 일을 분배합니다. 이게 "24시간 ON"의 진짜 의미.
     *  안전장치는 두 가지: (1) 동일 사이클 중복 실행 방지, (2) 사용자가 직접
     *  대화 중일 때(_abortController 활성)는 그 호출이 끝날 때까지 대기. */
    /* v2.89 — Dispatch queue. 자율 사이클과 사용자 명령이 동시에 들어와서
       _handleCorporatePrompt를 동시 호출 → 같은 _abortController·_displayMessages
       공유로 상태가 꼬이던 버그 해결.

       원칙:
       - 한 번에 한 개만 실행 (LLM 자원 보호)
       - 사용자 명령 = 큐 앞 (priority='user') — 진행 중 자율 사이클이
         있으면 그게 끝나기 기다림 (soft yield, 보통 30초~3분)
       - 자율 사이클 = 큐 뒤 (priority='auto')
       - 같은 promptKey가 큐에 이미 있으면 중복 추가 안 함
    */
    private _dispatchQueue: Array<{
        promptKey: string;
        prompt: string;
        modelName: string;
        priority: 'user' | 'auto';
        fromTelegram: boolean;
        enqueuedAt: number;
    }> = [];
    private _dispatchWorkerRunning: boolean = false;
    private _currentDispatch: { prompt: string; priority: 'user' | 'auto'; startedAt: number } | null = null;
    public enqueueDispatch(prompt: string, modelName: string, priority: 'user' | 'auto', fromTelegram: boolean): boolean {
        const key = dsp.normalizeKey(prompt);
        /* 같은 키가 이미 큐에 있거나 진행 중이면 추가 안 함 (자율 사이클 중복 방지) */
        if (this._currentDispatch && dsp.normalizeKey(this._currentDispatch.prompt) === key) return false;
        if (this._dispatchQueue.some(j => j.promptKey === key)) return false;
        const job = { promptKey: key, prompt, modelName, priority, fromTelegram, enqueuedAt: Date.now() };
        if (priority === 'user') {
            /* 큐 앞으로 — 자율 사이클들 모두 양보 */
            this._dispatchQueue.unshift(job);
        } else {
            this._dispatchQueue.push(job);
        }
        if (!this._dispatchWorkerRunning) this._runDispatchWorker();
        return true;
    }
    private async _runDispatchWorker(): Promise<void> {
        if (this._dispatchWorkerRunning) return;
        this._dispatchWorkerRunning = true;
        try {
            while (this._dispatchQueue.length > 0) {
                const job = this._dispatchQueue.shift()!;
                this._currentDispatch = { prompt: job.prompt, priority: job.priority, startedAt: Date.now() };
                /* 자율 사이클 활동 시그널 */
                if (job.priority === 'auto') {
                    try { this._view?.webview.postMessage({ type: 'autoCycleActivity', active: true }); } catch {}
                }
                try {
                    await this._handleCorporatePrompt(job.prompt, job.modelName);
                } catch (err: any) {
                    console.error('[dispatch worker] job failed:', err);
                    if (job.fromTelegram) {
                        sendTelegramReport(`⚠️ 작업 실행 중 오류: ${err?.message || err}`).catch(() => {});
                    }
                } finally {
                    if (job.priority === 'auto') {
                        try { this._view?.webview.postMessage({ type: 'autoCycleActivity', active: false }); } catch {}
                    }
                    _endActiveDispatch(job.prompt);
                }
                this._currentDispatch = null;
            }
        } finally {
            this._dispatchWorkerRunning = false;
        }
    }
    public getDispatchSnapshot(): { current: { prompt: string; priority: string; elapsedSec: number } | null; queueLength: number; queue: Array<{ priority: string; prompt: string }> } {
        const now = Date.now();
        return {
            current: this._currentDispatch
                ? { prompt: this._currentDispatch.prompt.slice(0, 80), priority: this._currentDispatch.priority, elapsedSec: Math.floor((now - this._currentDispatch.startedAt) / 1000) }
                : null,
            queueLength: this._dispatchQueue.length,
            queue: this._dispatchQueue.slice(0, 5).map(j => ({ priority: j.priority, prompt: j.prompt.slice(0, 80) })),
        };
    }

    public startAutoCycle(intervalMin: number = 15, idleMin: number = 0) {
        this.stopAutoCycle();
        const intervalMs = intervalMin * 60 * 1000;
        const idleMs = idleMin * 60 * 1000;
        this._autoCycleTimer = setInterval(() => {
            this._tryAutoCycle(idleMs).catch(() => { /* silent */ });
        }, intervalMs);
    }
    public stopAutoCycle() {
        if (this._autoCycleTimer) { clearInterval(this._autoCycleTimer); this._autoCycleTimer = undefined; }
    }
    private async _tryAutoCycle(idleMs: number) {
        // 24h ON은 idle 게이트 없이 돌아가는 게 정상 — idleMs가 0이면 이 검사 skip.
        if (idleMs > 0 && Date.now() - this._lastUserActivityTs < idleMs) return;
        if (!isCompanyConfigured()) return;
        // Manual kill switch from agent panel — settings key, default ON.
        const enabled = vscode.workspace.getConfiguration('agentOs').get<boolean>('autoCycleEnabled', true);
        if (!enabled) return;
        const model = this.getDefaultModel();
        if (!model) return;
        const today = new Date().toISOString().slice(0, 10);
        /* v2.89 — 큐에 자율 사이클 작업 추가. 워커가 알아서 처리하고, 사용자
           명령이 들어오면 그게 우선. 자율 사이클이 진행 중일 때 다음 사이클
           들어오면 큐에 같은 키로 이미 있어서 중복 추가 안 됨(=정상). */
        this.enqueueDispatch(
            `[자율 사이클 — ${today}] 1인 기업 24시간 운영 중. 회사 목표·각 에이전트의 개인 목표(_agents/{id}/goal.md)·최근 의사결정·메모리를 검토해서 지금 가장 가치 있는 단일 작업 1개를 결정하고, 적절한 1~2명 에이전트에게 분배해서 실행하세요. 같은 산출물을 반복하지 마세요 — 메모리에 비슷한 항목이 24시간 내에 있으면 다른 각도로 진전시키세요.`,
            model,
            'auto',
            false,
        );
    }
    public getDefaultModel(): string {
        return 'claude-sonnet-4-6';
    }

    /** One round of agent-to-agent ambient chatter. Picks two random specialists,
     *  asks the model for 2-3 short turns of natural workplace dialogue (in
     *  context of recent conversations + company goals), animates the confer in
     *  the office panel, and appends to the daily conversation log. */
    private async _runAutonomousChatter(modelName: string): Promise<void> {
        try {
            ensureCompanyStructure();
            const post = (m: any) => this._broadcastCorporate(m);
            // Pick two distinct specialists at random
            const pool = SPECIALIST_IDS.slice();
            if (pool.length < 2) return;
            const i = Math.floor(Math.random() * pool.length);
            let j = Math.floor(Math.random() * pool.length);
            while (j === i) j = Math.floor(Math.random() * pool.length);
            const aFrom = AGENTS[pool[i]];
            const aTo = AGENTS[pool[j]];
            if (!aFrom || !aTo) return;
            const recent = readRecentConversations(1500);
            const goalsPath = path.join(getCompanyDir(), '_shared', 'goals.md');
            const goals = fs.existsSync(goalsPath) ? fs.readFileSync(goalsPath, 'utf-8').slice(0, 1000) : '';
            const sys = `당신은 1인 AI 기업 사무실의 분위기 시뮬레이터입니다. 두 동료가 자연스럽게 짧게 잡담하거나 작업 얘기를 합니다.

⚠️ 반드시 아래 JSON 형식으로만 출력. 마크다운 펜스·머리말·꼬리말 절대 금지.

{
  "turns": [
    {"from": "${aFrom.id}", "to": "${aTo.id}", "text": "30자 이내 한국어"},
    {"from": "${aTo.id}", "to": "${aFrom.id}", "text": "30자 이내 한국어"}
  ]
}

규칙: 2~3턴, 각 30자 이내, 자연스러움. from/to는 정확히 "${aFrom.id}"와 "${aTo.id}"만.`;
            const usr = `[참여자]\n${aFrom.emoji} ${aFrom.name} (${aFrom.role})\n${aTo.emoji} ${aTo.name} (${aTo.role})\n\n[회사 목표]\n${goals}${recent}`;
            const raw = await this._callAgentLLM(sys, usr, modelName, aFrom.id, false);
            const turns = _hParseChatterTurns(raw, SPECIALIST_IDS);
            if (turns.length === 0) return;
            post({ type: 'agentConfer', turns });
            const body = turns
                .map(t => `- ${AGENTS[t.from]?.emoji || ''} **${AGENTS[t.from]?.name || t.from}** → ${AGENTS[t.to]?.emoji || ''} ${AGENTS[t.to]?.name || t.to}: ${t.text}`)
                .join('\n');
            appendConversationLog({ speaker: '자율 잡담', emoji: '💬', section: `${aFrom.name} ↔ ${aTo.name}`, body });
        } catch { /* never let chatter break the panel */ }
    }

    /** Push a flashy "knowledge injected" card into the chat sidebar and
     *  persist a tiny markdown breadcrumb to history so it survives reloads
     *  even if the sidebar wasn't open at injection time. */
    public broadcastInjectCard(title: string, relPath: string) {
        // Persistent breadcrumb in chat history (compact markdown)
        const breadcrumb = '> 🧠 **새 지식 주입됨** · `' + title + '.md`\n> 📁 `' + relPath + '`\n> ✦ I know ' + title + '.';
        this._chatHistory.push({ role: 'assistant', content: breadcrumb });
        this._displayMessages.push({ role: 'ai', text: breadcrumb });
        this._saveHistory();
        // Live, animated card if the sidebar is mounted right now
        if (this._view) {
            this._view.webview.postMessage({ type: 'brainInject', title, relPath });
        }
    }

    /** v2.89.116 — agent_models.json이 어디서든(이 사이드바 dock·dashboard 모달·
     *  외부 편집) 바뀌면 호출. 사이드바가 기업 모드로 열려있으면 dock을 즉시
     *  새로고침해서 양쪽이 항상 같은 진실을 본다. */
    public triggerAgentDockReload() {
        if (this._view) {
            this._view.webview.postMessage({ type: 'agentMapExternallyChanged' });
        }
    }

    /** 스킬팩 주입 — broadcastInjectCard의 스킬 버전.
     *  채팅창에 영구 breadcrumb + 사이드바가 열려있으면 시네마틱 카드 애니메이션. */
    public broadcastSkillCard(agentId: string, name: string, displayName: string, description: string) {
        const a = AGENTS[agentId];
        const agentLabel = a ? `${a.emoji} ${a.name}` : agentId;
        const breadcrumb = '> 🛠 **새 스킬 주입됨** · `' + name + '` → ' + agentLabel
            + (description ? '\n> ' + description.replace(/\n/g, ' ').slice(0, 140) : '')
            + '\n> ⚡ 다음 사이클부터 ' + agentLabel + ' 가 <run_command>로 사용 가능';
        this._chatHistory.push({ role: 'assistant', content: breadcrumb });
        this._displayMessages.push({ role: 'ai', text: breadcrumb });
        this._saveHistory();
        if (this._view) {
            this._view.webview.postMessage({
                type: 'skillInject',
                agentId, agentName: a?.name || agentId, agentEmoji: a?.emoji || '🛠',
                agentColor: a?.color || '#5DE0E6',
                name, displayName, description
            });
        }
    }

    /** Re-scan the brain folder and push fresh node/link data to every open
     *  graph panel. Called after brain-inject (Idea Lab, A.U Training, etc.) so
     *  the user sees new knowledge appear immediately, plus a brief pulse
     *  on the freshly-added node. */
    public broadcastGraphRefresh(highlightTitle?: string) {
        try {
            const brainDir = _getBrainDir();
            if (!fs.existsSync(brainDir)) return;
            const graph = buildKnowledgeGraph(brainDir);
            const data = {
                nodes: graph.nodes.map(n => ({
                    id: n.id, name: n.name, folder: n.folder, group: n.group, stage: n.stage, keywords: n.keywords, tags: n.tags,
                    connections: n.incoming + n.outgoing
                })),
                links: graph.links
            };
            const msg = { type: 'graphData', data, highlightTitle: highlightTitle || null };
            if (this._thinkingPanel && this._thinkingReady) {
                this._thinkingPanel.webview.postMessage(msg);
            }
            this._externalGraphPanels.forEach(panel => {
                try { panel.webview.postMessage(msg); } catch { /* disposed */ }
            });
        } catch (e) {
            console.error('broadcastGraphRefresh failed:', e);
        }
    }

    // 🏛️ AI 파라미터 튜닝
    private _temperature: number;
    private _topP: number;
    private _topK: number;
    private _systemPrompt: string;

    constructor(private readonly _extensionUri: vscode.Uri, ctx: vscode.ExtensionContext) {
        this._ctx = ctx;
        this._temperature = ctx.globalState.get<number>('aiTemperature', 0.8);
        this._topP = ctx.globalState.get<number>('aiTopP', 0.9);
        this._topK = ctx.globalState.get<number>('aiTopK', 40);
        this._systemPrompt = ctx.globalState.get<string>('aiSystemPrompt', SYSTEM_PROMPT);
        this._restoreHistory();
        // 두뇌 토글 상태 복원 (세션 뒤에도 유지)
        this._brainEnabled = this._ctx.globalState.get<boolean>('brainEnabled', true);
    }

    /** 저장된 대화 기록 복원 */
    private _restoreHistory() {
        const saved = this._ctx.workspaceState.get<{ chat: any[]; display: any[] }>('chatState');
        if (saved && saved.chat && saved.chat.length > 1) {
            this._chatHistory = saved.chat;
            this._displayMessages = saved.display || [];
        } else {
            this._initHistory();
        }
    }

    /** 대화 기록 영구 저장 (워크스페이스 단위) */
    private _saveHistory() {
        this._ctx.workspaceState.update('chatState', {
            chat: this._chatHistory,
            display: this._displayMessages
        });
    }

    /* v2.89.106 — 대화 세션 아카이브.
       기존엔 `+` (newChat) 누르면 _initHistory()가 즉시 메시지 다 날려버려서
       사용자가 "어제 뭐 물어봤더라" 다시 못 봄. 이제는:
       1. resetChat 직전에 현재 대화를 sessions 배열에 push (메시지 ≥ 1 일 때만)
       2. 사용자가 "이전 대화" 메뉴 열면 리스트 → 클릭으로 복원
       세션은 워크스페이스 globalState에 저장 (모든 워크스페이스 공유 — 사용자가
       프로젝트 옮겨도 대화 보존).
       세션당 시작 첫 user 메시지 80자를 title로 사용. 최근 50개만 유지. */
    private _readSessions(): any[] {
        return _hReadSessions(this._ctx);
    }
    private _writeSessions(sessions: any[]) {
        _hWriteSessions(this._ctx, sessions);
    }
    private _currentWorkspaceMeta(): { workspace: string; workspaceName: string } {
        return _hCurrentWorkspaceMeta();
    }
    private _archiveCurrentChat(): boolean {
        return _hArchiveCurrentChat(this._ctx, this._chatHistory, this._displayMessages);
    }
    /* v2.89.107 — 현재 활성 세션의 ID. 복원 시 이 ID를 기억해두고 다음 archive
       때 "이미 archive에 있는 같은 세션" 이면 update만 (중복 방지). */
    private _activeSessionId: string | null = null;
    private _restoreSession(id: string): boolean {
        const sessions = _hReadSessions(this._ctx);
        const sess = sessions.find(s => s.id === id);
        if (!sess) return false;
        /* 현재 대화도 안 잃게 — 비어있지 않으면 archive (단, 같은 세션 이어가는 거면 skip) */
        if (this._activeSessionId !== id) {
            try { this._archiveCurrentChat(); } catch { /* ignore */ }
        }
        this._chatHistory = Array.isArray(sess.chat) ? sess.chat : [];
        this._displayMessages = Array.isArray(sess.display) ? sess.display : [];
        this._activeSessionId = id;
        this._saveHistory();
        if (this._view) {
            this._view.webview.postMessage({ type: 'clearChat' });
            for (const m of this._displayMessages) {
                this._view.webview.postMessage({
                    type: m.role === 'user' ? 'userEcho' : 'response',
                    value: m.text
                });
            }
            this._view.webview.postMessage({ type: 'systemNote', value: `📂 "${sess.title}" 이어서 대화하기 (이전 ${sess.messageCount}개 메시지 복원)` });
            this._view.webview.postMessage({ type: 'activeSession', id, title: sess.title });
        }
        return true;
    }
    private _deleteSession(id: string): boolean {
        return _hDeleteSession(this._ctx, id);
    }

    // ============================================================
    // 🎬 Thinking Mode helpers
    // ============================================================
    private async _toggleThinkingMode() {
        this._thinkingMode = !this._thinkingMode;
        if (this._thinkingMode) {
            this._openThinkingPanel();
        } else {
            this._closeThinkingPanel();
        }
        if (this._view) {
            this._view.webview.postMessage({ type: 'thinkingModeState', value: this._thinkingMode });
        }
    }

    private _openThinkingPanel() {
        if (this._thinkingPanel) {
            this._thinkingPanel.reveal(vscode.ViewColumn.Beside, true);
            return;
        }
        const brainDir = _getBrainDir();
        const graph = buildKnowledgeGraph(brainDir);

        const assetsRoot = vscode.Uri.file(path.join(this._ctx.extensionPath, 'assets'));
        const panel = vscode.window.createWebviewPanel(
            'agentOsAiThinking',
            '🎬 Thinking Mode — AI 사고 시각화',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [assetsRoot] }
        );

        // Inject the same graph HTML used by showBrainNetwork — it already listens
        // for thinking events via window.message and is fully reusable.
        const forceGraphSrc = panel.webview.asWebviewUri(
            vscode.Uri.file(path.join(this._ctx.extensionPath, 'assets', 'force-graph.min.js'))
        ).toString();
        panel.webview.html = this._buildThinkingHtml(graph, forceGraphSrc, panel.webview.cspSource);

        panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'graph_ready') {
                this._thinkingReady = true;
                return;
            }
            if (msg.type === 'openFile' && typeof msg.id === 'string') {
                const safe = safeResolveInside(brainDir, msg.id);
                if (safe && fs.existsSync(safe)) {
                    const doc = await vscode.workspace.openTextDocument(safe);
                    vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);
                }
            }
        });
        panel.onDidDispose(() => {
            this._thinkingPanel = undefined;
            this._thinkingReady = false;
            this._thinkingMode = false;
            if (this._view) this._view.webview.postMessage({ type: 'thinkingModeState', value: false });
        });
        this._thinkingPanel = panel;
    }

    private _closeThinkingPanel() {
        if (this._thinkingPanel) {
            this._thinkingPanel.dispose();
            this._thinkingPanel = undefined;
            this._thinkingReady = false;
        }
    }

    /** Should we emit thinking events at all? True if either:
     *  - the dedicated Thinking Mode panel is on, or
     *  - the user has a normal brain-network graph panel open and would
     *    benefit from seeing the AI's live activity on it. */
    private _shouldEmitThinking(): boolean {
        return this._thinkingMode || this._externalGraphPanels.size > 0;
    }

    private _postThinking(message: any) {
        if (this._thinkingPanel && this._thinkingReady) {
            this._thinkingPanel.webview.postMessage(message);
        }
        // Also broadcast to any externally-opened brain network panels.
        // Their webview always has the message listener attached, so we don't
        // need a per-panel "ready" handshake — best-effort send is fine.
        this._externalGraphPanels.forEach(panel => {
            try { panel.webview.postMessage(message); } catch { /* disposed */ }
        });
    }

    // ============================================================
    // 📊 Header status bar — folder + GitHub status, always visible
    // ============================================================
    private _sendCompanyState(noteToUser?: string) {
        if (!this._view) return;
        const dir = getCompanyDir();
        const exists = fs.existsSync(path.join(dir, '_shared'));
        const configured = isCompanyConfigured();
        this._view.webview.postMessage({
            type: 'corporateState',
            companyDir: dir.replace(os.homedir(), '~'),
            companyName: readCompanyName(),
            folderExists: exists,
            configured,
            // True when the user already picked a brain folder (e.g. via the
            // welcome 4-step onboarding). Webview uses this to skip the boot
            // Stage 1 folder-choice card — that question was already answered.
            brainExplicitlySet: _isBrainDirExplicitlySet(),
            // 회사가 출범한 이후 실제 경과일 (1일차 = 첫날).
            // HUD의 DAY 카운터가 가상 시간이 아니라 실제 달력에 동기화됨.
            companyDay: configured ? getCompanyDay() : 1,
            note: noteToUser || '',
            /* v2.89.106 — 채용 상태 single source of truth. 사이드바가 자체 localStorage
               대신 이 값을 우선 사용해서 대쉬보드와 즉시 일관.
               v2.89.107 — 활성/비활성 상태도 함께. */
            hiredAgents: readHiredAgents(),
            activeAgents: readActiveAgents()
        });
    }

    private _sendStatusUpdate() {
        if (!this._view) return;
        const cfg = vscode.workspace.getConfiguration('agentOs');
        const folderPath = _isBrainDirExplicitlySet() ? _getBrainDir() : '';
        let fileCount = 0;
        if (folderPath && fs.existsSync(folderPath)) {
            try { fileCount = this._findBrainFiles(folderPath).length; } catch { /* ignore */ }
        }
        const githubUrl = cfg.get<string>('secondBrainRepo', '') || '';
        // Last-sync time computed from latest commit on the brain repo, if any
        let lastSync = '';
        if (folderPath && fs.existsSync(path.join(folderPath, '.git'))) {
            const out = gitExecSafe(['log', '-1', '--format=%cr'], folderPath);
            if (out) lastSync = out.trim();
        }
        this._view.webview.postMessage({
            type: 'statusUpdate',
            value: {
                folderPath,
                fileCount,
                githubUrl,
                lastSync,
                syncing: this._isSyncingBrain || _autoSyncRunning
            }
        });
    }

    private async _handleStatusFolderClick() {
        const isSet = _isBrainDirExplicitlySet();
        if (!isSet) {
            // Not configured yet → kick off folder selection
            await _ensureBrainDir();
            this._sendStatusUpdate();
            return;
        }
        // Configured → reveal folder in OS file explorer
        const dir = _getBrainDir();
        if (fs.existsSync(dir)) {
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
        }
    }

    private async _handleStatusGitClick() {
        // Beginner-friendly: clicking ☁️ ALWAYS opens the URL input box, with the
        // current URL pre-filled. After save, sync runs automatically.
        // No nested menu — direct typing is the most intuitive flow.
        const cfg = vscode.workspace.getConfiguration('agentOs');
        const existing = cfg.get<string>('secondBrainRepo', '') || '';

        const inputUrl = await vscode.window.showInputBox({
            prompt: existing
                ? '🔗 GitHub 저장소 주소를 확인하거나 변경하세요 (Enter로 저장 + 동기화)'
                : '🔗 백업할 GitHub 저장소 주소를 붙여넣고 Enter (예: https://github.com/내이름/저장소)',
            placeHolder: 'https://github.com/사용자명/저장소이름',
            value: existing,
            ignoreFocusOut: true,
            validateInput: (val) => {
                const v = (val || '').trim();
                if (!v) return null;
                if (validateGitRemoteUrl(v)) return null;
                return '⚠️ 형식이 맞지 않아요. 예: https://github.com/내이름/저장소  또는  git@github.com:내이름/저장소.git';
            }
        });

        if (inputUrl === undefined) {
            // User pressed ESC — do nothing
            return;
        }

        const trimmed = inputUrl.trim();
        if (!trimmed) {
            // User cleared the input → ask if they want to disconnect
            const disconnect = await vscode.window.showWarningMessage(
                'GitHub 백업을 끊을까요?',
                { modal: true },
                '☁️ 끊기',
                '⛔ 취소'
            );
            if (disconnect === '☁️ 끊기') {
                await cfg.update('secondBrainRepo', '', vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage('☁️ GitHub 백업 연결을 해제했어요.');
                this._sendStatusUpdate();
            }
            return;
        }

        const cleaned = validateGitRemoteUrl(trimmed) || trimmed;
        const isNew = cleaned !== existing;
        if (isNew) {
            await cfg.update('secondBrainRepo', cleaned, vscode.ConfigurationTarget.Global);
        }

        // Always sync after — fresh URL or just confirming
        await this._syncSecondBrain();
        this._sendStatusUpdate();
    }

    /** Build the same HTML that showBrainNetwork uses — kept inline for reuse. */
    private _buildThinkingHtml(graph: BrainGraph, forceGraphSrc: string, cspSource: string): string {
        return _hBuildThinkingHtml(graph, forceGraphSrc, cspSource);
    }

    /** 메모리 누수 방지: 대화 이력 길이 제한 (최근 50건만 유지, 시스템 프롬프트는 보존) */
    private _pruneHistory() {
        const pruned = _hPruneHistory(this._chatHistory, this._displayMessages);
        this._chatHistory = pruned.chatHistory;
        this._displayMessages = pruned.displayMessages;
    }

    private _initHistory() {
        this._chatHistory = [{ role: 'system', content: this._systemPrompt }];
        this._displayMessages = [];
    }

    public resetChat() {
        /* v2.89.106 — 새 대화 시작 전 현재 대화를 아카이브에 보관. 빈 대화면 skip.
           v2.89.107 — 같은 세션을 이어가다가 + 누르면 archive에 update만 (중복 방지). */
        const archived = this._archiveOrUpdateCurrentChat();
        this._activeSessionId = null;
        this._initHistory();
        this._saveHistory();
        if (this._view) {
            this._view.webview.postMessage({ type: 'clearChat' });
            this._view.webview.postMessage({ type: 'activeSession', id: null, title: null });
            if (archived) {
                this._view.webview.postMessage({
                    type: 'systemNote',
                    value: '✅ 이전 대화는 자동 보관됨 (📂 클릭해서 이어서 가능).'
                });
            }
        }
    }

    /* v2.89.107 — archive 또는 update. 활성 세션 ID가 있으면 그 entry를 업데이트
       (중복 방지). 없으면 새 entry 생성. */
    private _archiveOrUpdateCurrentChat(): boolean {
        return _hArchiveOrUpdateCurrentChat(
            this._ctx,
            this._activeSessionId,
            this._chatHistory,
            this._displayMessages,
        );
    }

    /** 대화를 Markdown 파일로 내보내기 */
    public async exportChat() {
        if (this._displayMessages.length === 0) {
            vscode.window.showWarningMessage('내보낼 대화가 없습니다.');
            return;
        }
        let md = `# Agent OS — 대화 기록\n\n_${new Date().toLocaleString('ko-KR')}_\n\n---\n\n`;
        for (const m of this._displayMessages) {
            const label = m.role === 'user' ? '**👤 You**' : '**✦ Agent OS**';
            md += `### ${label}\n\n${m.text}\n\n---\n\n`;
        }
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (root) {
            const filePath = path.join(root, `chat-export-${Date.now()}.md`);
            fs.writeFileSync(filePath, md, 'utf-8');
            const doc = await vscode.workspace.openTextDocument(filePath);
            await vscode.window.showTextDocument(doc);
            vscode.window.showInformationMessage(`대화가 ${path.basename(filePath)}로 저장되었습니다.`);
        }
    }

    /** 채팅 입력창에 포커스 (Cmd+L) */
    public focusInput() {
        if (this._view) {
            this._view.show?.(true);
            this._view.webview.postMessage({ type: 'focusInput' });
        }
    }

    public getHistoryText(): string {
        return this._displayMessages.map(m => `[${m.role.toUpperCase()}]\n${m.text}`).join('\n\n');
    }

    /** 외부에서 프롬프트 전송 (예: 코드 선택 → 설명, Idea Lab 주입 등).
     *  sidebar가 아직 mount 안 됐어도 history에는 항상 저장 — 다음에 사이드바를
     *  열면 자동 복원되어 보임. mount되어 있으면 즉시 webview에도 전달. */
    public injectSystemMessage(message: string) {
        this._chatHistory.push({ role: 'assistant', content: message });
        this._displayMessages.push({ role: 'ai', text: message });
        this._saveHistory();
        if (this._view) {
            this._view.webview.postMessage({ type: 'response', value: message });
        }
    }

    // Pending prompts buffered while the sidebar webview is unmounted —
    // flushed when resolveWebviewView wires up the new _view.
    private _pendingPrompts: Array<{ prompt: string; fromTelegram: boolean }> = [];
    /* When true, the next AI response should also be sent to Telegram so the
       user sees the same answer in their chat app. Reset after one mirror so
       a sidebar-typed message right after a Telegram dispatch doesn't leak. */
    private _telegramMirrorPending: boolean = false;
    /* Marker we look for to detect when the sidebar's response is actually
       complete (set in _displayMessages). Prevents premature mirrors. */
    private _telegramMirrorSeenAiCount: number = 0;

    /* v2.89.3 — 외부에서(텔레그램 폴링 등) 진행 중 작업 취소.
       sidebar의 stop button과 같은 abort signal 트리거. 활성 디스패치 추적도
       정리. 작업이 없으면 false 반환 — 호출자가 "취소할 게 없어요" 안내 가능. */
    public abortActiveDispatch(): { cancelled: boolean; what?: string } {
        let cancelled = false;
        let what = '';
        if (this._abortController && !this._abortController.signal.aborted) {
            try {
                this._abortController.abort();
                this._abortController = undefined;
                cancelled = true;
            } catch { /* ignore */ }
        }
        /* 활성 디스패치 추적도 정리 — 하트비트 timer 끄고 제거 */
        const cancelledSteps = dsp.cancelAll();
        if (cancelledSteps.length > 0) {
            what = cancelledSteps[cancelledSteps.length - 1];
            cancelled = true;
        }
        if (cancelled) {
            try {
                this._broadcastCorporate({ type: 'error', value: '🛑 사용자가 텔레그램으로 중단했어요.' });
            } catch { /* ignore */ }
        }
        return { cancelled, what };
    }

    public sendPromptFromExtension(prompt: string, opts?: { fromTelegram?: boolean; corporate?: boolean }) {
        const fromTelegram = !!opts?.fromTelegram;
        const corporate = !!opts?.corporate;
        if (fromTelegram) {
            this._telegramMirrorPending = true;
            // Snapshot AI message count so the mirror watcher can detect the
            // *next* AI message (the response to this prompt).
            this._telegramMirrorSeenAiCount = this._displayMessages.filter(m => m.role === 'ai').length;
        }
        /* v2.87.10 — Corporate dispatch direct path. 이전엔 모든 sendPromptFromExtension
           이 webview의 injectPrompt → send({bypassCorporate:true}) 흐름을 탔는데,
           그게 단일 LLM 호출(_handlePrompt)로만 가서 멀티 에이전트 디스패치
           (_handleCorporatePrompt)가 안 일어남. 텔레그램에서 "유튜브 분석해줘"
           처럼 진짜 에이전트 작업이 필요한 명령은 webview를 우회해서 corporate
           핸들러를 직접 호출해야 함. */
        if (corporate) {
            const model = this.getDefaultModel();
            if (!model) {
                /* v2.88.4 — 이전엔 모델 없으면 silent fall-through으로 webview에
                   inject되었는데, 사이드바 닫혀있는 상태(텔레그램 트리거)면
                   아무것도 안 일어남. 에러를 명확히 알리고 끝. */
                if (fromTelegram) {
                    sendTelegramReport(`⚠️ AI 모델이 선택되지 않았어요. 사이드바를 열어 모델 드롭다운에서 모델을 선택한 후 다시 시도해주세요.`).catch(() => {});
                }
                return;
            }
            this._markActivity();
            /* v2.88 — 중복 감지: 5분 안에 같은 요청이 또 오면 새로 시작 안
               하고 진행 상황만 알림. */
            const existing = _findActiveDispatch(prompt);
            if (existing) {
                const elapsedSec = Math.floor((Date.now() - existing.startedAt) / 1000);
                const msg = `🔄 *비서*: 같은 요청을 이미 처리하고 있어요 (${elapsedSec}초 진행 중 — 현재: ${existing.step}). 결과 곧 알려드릴게요.`;
                if (fromTelegram) sendTelegramReport(msg).catch(() => {});
                try { this.postSystemNote?.(`(중복 무시) 이미 처리 중: ${prompt.slice(0, 60)}…`, '🔄'); } catch {}
                return;
            }
            const entry = _startActiveDispatch(prompt, fromTelegram);
            /* 하트비트 — 12초마다 텔레그램에 진행 상황 알림 */
            if (fromTelegram) {
                entry.heartbeatTimer = setInterval(() => {
                    entry.heartbeatCount++;
                    const elapsed = Math.floor((Date.now() - entry.startedAt) / 1000);
                    sendTelegramReport(`📊 *진행 중* (${elapsed}초) — ${entry.step}`).catch(() => {});
                }, 12_000);
            }
            /* v2.89 — 큐에 사용자 명령 추가 (앞으로). 자율 사이클 진행 중이면
               그게 끝나길 기다린 후 즉시 실행. 자율 사이클이 평균 30초~3분이라
               대기 시간 합리적. 큐 위치 알림. */
            const snap = this.getDispatchSnapshot();
            const wasQueued = snap.current !== null && snap.current.priority === 'auto';
            if (wasQueued && fromTelegram) {
                sendTelegramReport(`📥 *비서*: 자율 사이클이 진행 중이라 곧 처리할게요 (${snap.current!.elapsedSec}초째 진행 중 — 끝나는 대로 즉시 시작).`).catch(() => {});
            }
            this.enqueueDispatch(prompt, model, 'user', fromTelegram);
            return;
        }
        if (this._view) {
            this._view.show?.(true);
            // 약간의 딜레이 후 전송 (뷰가 보이기를 기다림)
            setTimeout(() => {
                this._view?.webview.postMessage({ type: 'injectPrompt', value: prompt });
            }, 300);
        } else {
            // Buffer until the sidebar opens; cap to avoid unbounded growth.
            this._pendingPrompts.push({ prompt, fromTelegram });
            if (this._pendingPrompts.length > 20) this._pendingPrompts.shift();
        }
    }

    /** After a sidebar AI response completes, mirror it back to Telegram if
     *  the original request came from Telegram. Idempotent — only fires once
     *  per mirror cycle and clears the pending flag. Called from the tail of
     *  _handlePrompt and _handleCorporatePrompt. */
    private async _maybeMirrorToTelegram(): Promise<void> {
        if (!this._telegramMirrorPending) return;
        this._telegramMirrorPending = false;
        const tg = readTelegramConfig();
        if (!tg.token || !tg.chatId) return;
        const aiMessages = this._displayMessages.filter(m => m.role === 'ai');
        if (aiMessages.length <= this._telegramMirrorSeenAiCount) {
            /* No new AI message — silently skip. We used to send a "(빈
               응답)" notice, but that fired every time the corporate flow
               handled the dispatch (corporate has its own Telegram report at
               the end and clears mirror flag), creating noise. Better silent
               than spammy. */
            return;
        }
        const newest = aiMessages[aiMessages.length - 1];
        const text = (newest?.text || '').trim();
        if (!text) return;
        try { await sendTelegramLong(text); } catch { /* silent */ }
    }

    /** Display a system note in the chat (no LLM call). Used for Telegram
     *  message mirroring, calendar events, agent status updates, etc. */
    public postSystemNote(text: string, icon: string = '📱') {
        /* Persist the note in the running chat so the user can see Telegram /
           calendar activity even if the sidebar was closed when it happened.
           The note rides the same _displayMessages pipeline as regular chat
           — restoreMessages will replay it via addMsg('note', ...). Without
           this, agents could carry on a whole Telegram conversation while the
           user was away from the desk and they'd come back to a blank chat. */
        const composed = `${icon} ${text}`;
        this._displayMessages.push({ role: 'note', text: composed });
        if (this._displayMessages.length > 100) {
            this._displayMessages = this._displayMessages.slice(-100);
        }
        try { this._saveHistory(); } catch { /* never let a UI mirror break the polling tick */ }
        /* Live broadcast if the sidebar is currently open — the systemNote
           handler renders the same look. Closed-sidebar case relies on the
           restore-from-history path above. */
        if (this._view) {
            this._view.webview.postMessage({ type: 'systemNote', text, icon });
        }
    }
    /** Called from resolveWebviewView once _view is ready. */
    private _flushPendingPrompts() {
        if (!this._view || this._pendingPrompts.length === 0) return;
        const queue = this._pendingPrompts.slice();
        this._pendingPrompts.length = 0;
        queue.forEach((entry, i) => {
            if (entry.fromTelegram) {
                this._telegramMirrorPending = true;
                this._telegramMirrorSeenAiCount = this._displayMessages.filter(m => m.role === 'ai').length;
            }
            setTimeout(() => this._view?.webview.postMessage({ type: 'injectPrompt', value: entry.prompt }), 400 + i * 200);
        });
    }

    // --------------------------------------------------------
    // Webview Lifecycle
    // --------------------------------------------------------
    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        // 중요: HTML을 그리기 전에 메시지 리스너를 먼저 붙여야 Race Condition이 발생하지 않습니다!
        webviewView.webview.onDidReceiveMessage(async (msg) => {
            /* v2.89.97 — 전체 메시지 핸들러를 try/catch로 감싸 어떤 단일 핸들러
               예외도 후속 메시지 처리를 죽이지 않게. 이전엔 unhandled async
               rejection이 화살표 함수 밖으로 빠져나가 extension host가 사실상
               비활성 상태가 되는 사고. 'Maximum call stack' 같은 RangeError도
               여기서 잡혀서 사용자에게 재시작 안내까지 보냄. */
            try {
            switch (msg.type) {
                case 'getModels':
                    await this._sendModels();
                    break;
                /* v2.89.116 — 1인 기업 모드 specialist dock. 사이드바 헤더의 단일
                   모델 셀렉터 자리에서 9명 specialist의 모델 매핑을 한눈에 보고
                   인라인 변경. dashboard의 "모델 오케스트레이션" 모달과 동일
                   백엔드 함수(_autoOrchestrateModelMap, writeAgentModelMap)를
                   재사용해서 양쪽이 항상 같은 진실을 본다. */
                case 'loadAgentDock': {
                    try {
                        const installed = await listInstalledModels();
                        const specs = getSystemSpecs();
                        const installedWithMem = installed.map(m => ({
                            id: m.id,
                            tier: (m as any).tier || '',
                            estMemGB: estimateModelMemoryGB(m.id),
                            safe: estimateModelMemoryGB(m.id) <= specs.safeModelBudgetGB,
                        }));
                        const map = readAgentModelMap();
                        const defaultModel = 'claude-sonnet-4-6';
                        const agents = SPECIALIST_IDS.map(id => ({
                            id,
                            name: AGENTS[id]?.name || id,
                            emoji: AGENTS[id]?.emoji || '🤖',
                            role: AGENTS[id]?.role || '',
                            color: AGENTS[id]?.color || '#c9a961',
                            currentModel: map[id] || defaultModel,
                            usingDefault: !map[id],
                        }));
                        webviewView.webview.postMessage({
                            type: 'agentDockData',
                            installed: installedWithMem,
                            defaultModel,
                            agents,
                            specs,
                        });
                    } catch (e: any) {
                        webviewView.webview.postMessage({ type: 'agentDockData', installed: [], defaultModel: '', agents: [], specs: null, error: String(e?.message || e) });
                    }
                    break;
                }
                case 'setAgentModel': {
                    try {
                        const agentId = String(msg.agent || '').trim();
                        const model = String(msg.model || '').trim();
                        if (!agentId || !AGENTS[agentId]) {
                            webviewView.webview.postMessage({ type: 'agentDockSaved', ok: false, error: `알 수 없는 에이전트: ${agentId}` });
                            break;
                        }
                        const map = readAgentModelMap();
                        if (model && model !== 'claude-sonnet-4-6') {
                            map[agentId] = model;
                        } else {
                            delete map[agentId];
                        }
                        writeAgentModelMap(map);
                        webviewView.webview.postMessage({ type: 'agentDockSaved', ok: true, agent: agentId, model });
                    } catch (e: any) {
                        webviewView.webview.postMessage({ type: 'agentDockSaved', ok: false, error: String(e?.message || e) });
                    }
                    break;
                }
                case 'autoMapAgents': {
                    try {
                        const installed = await listInstalledModels();
                        const auto = _autoOrchestrateModelMap(installed);
                        writeAgentModelMap(auto);
                        webviewView.webview.postMessage({ type: 'agentDockAutoMapped', ok: true, map: auto });
                    } catch (e: any) {
                        webviewView.webview.postMessage({ type: 'agentDockAutoMapped', ok: false, error: String(e?.message || e) });
                    }
                    break;
                }
                case 'setAllAgents': {
                    try {
                        const model = String(msg.model || '').trim();
                        if (!model) {
                            webviewView.webview.postMessage({ type: 'agentDockSaved', ok: false, error: '모델이 비어있어요' });
                            break;
                        }
                        const isDefault = model === 'claude-sonnet-4-6';
                        const map: Record<string, string> = {};
                        if (!isDefault) {
                            for (const id of SPECIALIST_IDS) map[id] = model;
                        }
                        writeAgentModelMap(map);
                        webviewView.webview.postMessage({ type: 'agentDockSaved', ok: true, all: true, model });
                    } catch (e: any) {
                        webviewView.webview.postMessage({ type: 'agentDockSaved', ok: false, error: String(e?.message || e) });
                    }
                    break;
                }
                case 'prompt': {
                    /* v2.89.146 — 명시적 호출 감지("현빈아", "코다리야" 등) 시 corporate
                       모드 force. 사용자가 사이드바 toggle 안 해도 명시적 호출은 항상
                       specialist dispatch 흐름으로 → 매출/키트 shortcut 발동. */
                    const txt = String(msg.value || '');
                    const hasExplicit = !!this._detectExplicitMention(txt);
                    if (msg.corporate || hasExplicit) {
                        this._sidebarCorpModeOn = true;
                        await this._handleCorporatePrompt(txt, msg.model);
                    } else {
                        await this._handlePrompt(txt, msg.model, msg.internet);
                    }
                    break;
                }
                case 'corpModeToggle':
                    this._sidebarCorpModeOn = !!msg.on;
                    break;
                case 'loadAgentConfig': {
                    try {
                        ensureCompanyStructure();
                        const goal = readAgentGoal(msg.agent);
                        const ragMode = readAgentRagMode(msg.agent);
                        const selfRagCriteria = readAgentSelfRagCriteria(msg.agent);
                        const verifiedCount = countAgentVerifiedClaims(msg.agent);
                        const tg = readTelegramConfig();
                        const telegramConnected = !!(tg.token && tg.chatId);
                        const autoOn = vscode.workspace.getConfiguration('agentOs').get<boolean>('autoCycleEnabled', true);
                        const tools = listAgentTools(msg.agent).map(t => ({
                            name: t.name,
                            displayName: t.displayName,
                            description: t.description,
                            configSchema: t.configSchema,
                            injectedAt: t.injectedAt || null,
                            injectedFrom: t.injectedFrom || null,
                            enabled: t.enabled,
                        }));
                        webviewView.webview.postMessage({ type: 'agentConfigLoaded', agent: msg.agent, goal, ragMode, selfRagCriteria, verifiedCount, telegramConnected, autoOn, tools });
                    } catch (e: any) {
                        webviewView.webview.postMessage({ type: 'agentConfigLoaded', agent: msg.agent, goal: '', ragMode: 'standard', selfRagCriteria: '', verifiedCount: 0, telegramConnected: false, autoOn: false, tools: [], error: String(e?.message || e) });
                    }
                    break;
                }
                case 'loadAllSkills': {
                    /* 글로벌 "내 스킬 라이브러리" 데이터 — 모든 에이전트의 tools를
                       한 번에 묶어서 webview로 전달. 에이전트별로 그룹핑 + Mine 표시. */
                    try {
                        const groups = AGENT_ORDER.map(id => ({
                            agentId: id,
                            agentName: AGENTS[id]?.name || id,
                            agentEmoji: AGENTS[id]?.emoji || '🛠',
                            agentColor: AGENTS[id]?.color || '#5DE0E6',
                            agentRole: AGENTS[id]?.role || '',
                            tools: listAgentTools(id).map(t => ({
                                name: t.name,
                                displayName: t.displayName,
                                description: t.description,
                                injectedAt: t.injectedAt || null,
                                injectedFrom: t.injectedFrom || null,
                            })),
                        }));
                        webviewView.webview.postMessage({ type: 'allSkillsLoaded', groups });
                    } catch (e: any) {
                        webviewView.webview.postMessage({ type: 'allSkillsLoaded', groups: [], error: String(e?.message || e) });
                    }
                    break;
                }
                case 'loadToolConfig': {
                    try {
                        const tools = listAgentTools(msg.agent);
                        const tool = tools.find(t => t.name === msg.tool);
                        if (!tool) {
                            webviewView.webview.postMessage({ type: 'toolConfigLoaded', agent: msg.agent, tool: msg.tool, schema: [], error: '도구를 찾을 수 없어요' });
                            break;
                        }
                        webviewView.webview.postMessage({ type: 'toolConfigLoaded', agent: msg.agent, tool: msg.tool, schema: tool.configSchema });
                    } catch (e: any) {
                        webviewView.webview.postMessage({ type: 'toolConfigLoaded', agent: msg.agent, tool: msg.tool, schema: [], error: String(e?.message || e) });
                    }
                    break;
                }
                case 'saveToolConfig': {
                    try {
                        writeToolConfig(msg.agent, msg.tool, msg.config || {});
                        vscode.window.setStatusBarMessage(`✓ ${msg.tool} 설정 저장됨`, 2000);
                    } catch (e: any) {
                        vscode.window.showWarningMessage(`도구 설정 저장 실패: ${e?.message || e}`);
                    }
                    break;
                }
                case 'setToolEnabled': {
                    try {
                        setToolEnabled(msg.agent, msg.tool, !!msg.enabled);
                    } catch (e: any) {
                        vscode.window.showWarningMessage(`도구 활성화 토글 실패: ${e?.message || e}`);
                    }
                    break;
                }
                case 'openToolFile': {
                    try {
                        const tools = listAgentTools(msg.agent);
                        const tool = tools.find(t => t.name === msg.tool);
                        if (!tool) break;
                        const target = msg.kind === 'script' ? tool.scriptPath
                            : msg.kind === 'readme' ? tool.readmePath
                            : tool.configPath;
                        const doc = await vscode.workspace.openTextDocument(target);
                        await vscode.window.showTextDocument(doc);
                    } catch (e: any) {
                        vscode.window.showWarningMessage(`도구 파일 열기 실패: ${e?.message || e}`);
                    }
                    break;
                }
                case 'runTool': {
                    // Ask the YouTube agent to run this specific tool now via the
                    // CEO dispatch path. The agent has the tool catalog in its
                    // context and can output <run_command> to execute it.
                    // Lifecycle messages (toolRunCompleted) let the panel show
                    // a per-tool game-like state machine: pending → running → done/error.
                    const tools = listAgentTools(msg.agent);
                    const tool = tools.find(t => t.name === msg.tool);
                    if (!tool) {
                        webviewView.webview.postMessage({ type: 'toolRunCompleted', agent: msg.agent, tool: msg.tool, ok: false, reason: 'not_found', message: `도구를 찾을 수 없어요: ${msg.tool}` });
                        break;
                    }
                    // Pre-flight: warn if any password field is empty. Frontend
                    // already paints these as 🔒 locked, but defense-in-depth.
                    const missing = tool.configSchema.filter(f => f.type === 'password' && (!f.value || String(f.value).trim() === ''));
                    if (missing.length > 0) {
                        webviewView.webview.postMessage({ type: 'toolRunCompleted', agent: msg.agent, tool: msg.tool, ok: false, reason: 'missing_config', message: `실행 전에 ${missing.map(f => f.label).join(', ')} 값을 입력해주세요.` });
                        break;
                    }
                    const a = AGENTS[msg.agent];
                    const name = a?.name || msg.agent;
                    const model = this.getDefaultModel();
                    if (!model) {
                        webviewView.webview.postMessage({ type: 'toolRunCompleted', agent: msg.agent, tool: msg.tool, ok: false, reason: 'no_model', message: '기본 모델이 설정되지 않았어요.' });
                        break;
                    }
                    /* Tell frontend the request was accepted — flip card to running */
                    webviewView.webview.postMessage({ type: 'toolRunDispatched', agent: msg.agent, tool: msg.tool });
                    const prevSidebarBroadcast = this._sidebarCorpModeOn;
                    this._sidebarCorpModeOn = true;
                    this._handleCorporatePrompt(
                        `[도구 실행 — ${name} → ${tool.displayName}] ${name} 에이전트에게 다음 도구를 즉시 실행하라고 지시하세요. 반드시 ${msg.agent} 에이전트에게 분배. 도구: ${tool.name}. 실행 명령 (정확히 이 형식): <run_command>cd "${path.dirname(tool.scriptPath)}" && ${_pythonCmd()} ${path.basename(tool.scriptPath)}</run_command>. 실행 후 출력을 분석해 다음 액션을 한 줄로 제안하세요.`,
                        model,
                    )
                        .then(() => {
                            webviewView.webview.postMessage({ type: 'toolRunCompleted', agent: msg.agent, tool: msg.tool, ok: true });
                        })
                        .catch((err: any) => {
                            webviewView.webview.postMessage({ type: 'toolRunCompleted', agent: msg.agent, tool: msg.tool, ok: false, reason: 'exec_error', message: String(err?.message || err) });
                        })
                        .finally(() => { this._sidebarCorpModeOn = prevSidebarBroadcast; });
                    break;
                }
                case 'saveAgentGoal': {
                    try {
                        ensureCompanyStructure();
                        writeAgentGoal(msg.agent, msg.goal || '');
                    } catch (e: any) {
                        vscode.window.showWarningMessage(`목표 저장 실패: ${e?.message || e}`);
                    }
                    break;
                }
                case 'saveAgentRagMode': {
                    try {
                        ensureCompanyStructure();
                        writeAgentRagMode(msg.agent, msg.mode || 'standard');
                    } catch (e: any) {
                        vscode.window.showWarningMessage(`RAG 모드 저장 실패: ${e?.message || e}`);
                    }
                    break;
                }
                case 'saveAgentSelfRagCriteria': {
                    try {
                        ensureCompanyStructure();
                        writeAgentSelfRagCriteria(msg.agent, msg.criteria || '');
                    } catch (e: any) {
                        vscode.window.showWarningMessage(`자가검증 기준 저장 실패: ${e?.message || e}`);
                    }
                    break;
                }
                /* ── Telegram setup wizard handlers ──────────────────────────
                   Validate token / auto-detect chat_id / send a test message.
                   The wizard in the webview drives all three so users don't
                   have to touch URLs or JSON. */
                case 'telegramValidateToken': {
                    /* Defense in depth — strip whitespace + invisible unicode +
                       leading "bot" prefix before hitting Telegram. Webview
                       already does this, but if a different caller sends raw
                       paste, we still survive. */
                    let token = String(msg.token || '').trim();
                    token = token.replace(/[ -  ​-‍﻿]+/g, '');
                    if (/^bot/i.test(token)) token = token.replace(/^bot/i, '');
                    try {
                        const r = await axios.get(`https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`, { timeout: 8000, validateStatus: () => true });
                        const data = r.data || {};
                        if (data.ok) {
                            webviewView.webview.postMessage({
                                type: 'telegramValidateTokenResult', ok: true,
                                username: data.result?.username || '',
                                botName: data.result?.first_name || '',
                                botId: data.result?.id || 0,
                            });
                        } else {
                            webviewView.webview.postMessage({
                                type: 'telegramValidateTokenResult', ok: false,
                                error: data.description || `HTTP ${r.status}`,
                            });
                        }
                    } catch (e: any) {
                        webviewView.webview.postMessage({ type: 'telegramValidateTokenResult', ok: false, error: String(e?.message || e) });
                    }
                    break;
                }
                case 'telegramDetectChatId': {
                    const token = String(msg.token || '').trim();
                    try {
                        const r = await axios.get(`https://api.telegram.org/bot${encodeURIComponent(token)}/getUpdates`, { timeout: 8000, validateStatus: () => true });
                        const data = r.data || {};
                        if (!data.ok) {
                            webviewView.webview.postMessage({ type: 'telegramDetectChatIdResult', ok: false, error: data.description || `HTTP ${r.status}` });
                            break;
                        }
                        // Pull unique chats (private only, prefer most recent)
                        const updates: any[] = Array.isArray(data.result) ? data.result : [];
                        const chats: { id: number; name: string }[] = [];
                        const seen = new Set<number>();
                        for (let i = updates.length - 1; i >= 0; i--) {
                            const m = updates[i]?.message || updates[i]?.edited_message || updates[i]?.channel_post;
                            const c = m?.chat;
                            if (!c || typeof c.id !== 'number') continue;
                            if (seen.has(c.id)) continue;
                            seen.add(c.id);
                            const name = c.first_name ? `${c.first_name}${c.last_name ? ' ' + c.last_name : ''}` : (c.title || c.username || `Chat ${c.id}`);
                            chats.push({ id: c.id, name });
                        }
                        webviewView.webview.postMessage({ type: 'telegramDetectChatIdResult', ok: true, chats });
                    } catch (e: any) {
                        webviewView.webview.postMessage({ type: 'telegramDetectChatIdResult', ok: false, error: String(e?.message || e) });
                    }
                    break;
                }
                case 'telegramSendTest': {
                    const token = String(msg.token || '').trim();
                    const chatId = String(msg.chatId || '').trim();
                    const text = String(msg.text || `✅ 비서(Secretary) 텔레그램 연결 정상 — ${new Date().toLocaleString('ko-KR')}\n\n이 메시지가 보이면 모든 에이전트가 이 채널로 보고를 보낼 수 있습니다.`);
                    try {
                        const r = await axios.post(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
                            chat_id: chatId,
                            text,
                            parse_mode: 'Markdown',
                        }, { timeout: 8000, validateStatus: () => true });
                        const data = r.data || {};
                        if (data.ok) {
                            webviewView.webview.postMessage({ type: 'telegramSendTestResult', ok: true });
                        } else {
                            webviewView.webview.postMessage({ type: 'telegramSendTestResult', ok: false, error: data.description || `HTTP ${r.status}` });
                        }
                    } catch (e: any) {
                        webviewView.webview.postMessage({ type: 'telegramSendTestResult', ok: false, error: String(e?.message || e) });
                    }
                    break;
                }
                case 'telegramSaveSetup': {
                    /* Persist token + chat_id into Secretary's telegram_setup.json
                       — same path that readTelegramConfig + Python _resolve_telegram
                       look at first. Safer than asking user to navigate to ⚙️ form
                       after the wizard. */
                    try {
                        ensureCompanyStructure();
                        const dir = path.join(getCompanyDir(), '_agents', 'secretary', 'tools');
                        fs.mkdirSync(dir, { recursive: true });
                        const p = path.join(dir, 'telegram_setup.json');
                        const cur = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8') || '{}') : {};
                        cur.TELEGRAM_BOT_TOKEN = String(msg.token || '').trim();
                        cur.TELEGRAM_CHAT_ID   = String(msg.chatId || '').trim();
                        fs.writeFileSync(p, JSON.stringify(cur, null, 2));
                        webviewView.webview.postMessage({ type: 'telegramSaveSetupResult', ok: true });
                    } catch (e: any) {
                        webviewView.webview.postMessage({ type: 'telegramSaveSetupResult', ok: false, error: String(e?.message || e) });
                    }
                    break;
                }
                case 'runCalendarWriteWizard': {
                    /* Triggered from agent panel ⚙️ on google_calendar_write —
                       runs the host-side OAuth wizard. */
                    vscode.commands.executeCommand('agent-os.connectGoogleCalendarWrite').then(undefined, () => { /* user cancel */ });
                    break;
                }
                case 'toggleAutoCycle': {
                    try {
                        await vscode.workspace.getConfiguration('agentOs').update('autoCycleEnabled', !!msg.on, vscode.ConfigurationTarget.Global);
                        if (msg.on) {
                            this.startAutoCycle(15, 0);
                        } else {
                            this.stopAutoCycle();
                        }
                    } catch { /* ignore */ }
                    break;
                }
                case 'runAgentStep': {
                    // Manual single-step kick from the agent panel. Goes through
                    // the existing CEO dispatch path so artifacts land in the
                    // same sessions/ folder and the cinematic UI fires.
                    // We TEMPORARILY enable sidebar broadcast for this run so
                    // the user sees their explicit action play out, then
                    // restore the previous state so autonomous activity stays
                    // gated by the user's actual corp toggle.
                    const a = AGENTS[msg.agent];
                    const name = a?.name || msg.agent;
                    const model = this.getDefaultModel();
                    if (!model) {
                        webviewView.webview.postMessage({ type: 'error', value: '⚠️ 기본 모델이 설정되지 않았어요.' });
                        break;
                    }
                    const prevSidebarBroadcast = this._sidebarCorpModeOn;
                    this._sidebarCorpModeOn = true;
                    this._handleCorporatePrompt(
                        `[수동 한 스텝 — ${name}] ${name} 에이전트의 개인 목표(_agents/${msg.agent}/goal.md)를 향해 다음 한 스텝을 실행하세요. 반드시 ${msg.agent} 에이전트에게 작업을 분배하세요.`,
                        model,
                    )
                        .catch(() => { /* error already broadcast */ })
                        .finally(() => { this._sidebarCorpModeOn = prevSidebarBroadcast; });
                    break;
                }
                case 'promptWithFile':
                    await this._handlePromptWithFile(msg.value, msg.model, msg.files, msg.internet);
                    break;
                case 'probeIDEModels': {
                    /* Try to discover models the host IDE (Antigravity, Cursor,
                     * VS Code w/ Copilot, etc.) exposes via the vscode.lm API.
                     * Returns list to webview so user can see what's available
                     * without committing to integration yet. */
                    let models: Array<{ id: string; vendor: string; family: string; name: string }> = [];
                    let error = '';
                    try {
                        const lm: any = (vscode as any).lm;
                        if (lm && typeof lm.selectChatModels === 'function') {
                            const result = await lm.selectChatModels({});
                            if (Array.isArray(result)) {
                                models = result.map((m: any) => ({
                                    id: m.id || '',
                                    vendor: m.vendor || '',
                                    family: m.family || '',
                                    name: m.name || m.id || '',
                                }));
                            }
                        } else {
                            error = 'vscode.lm API 미지원 — 이 호스트(Antigravity?)는 익스텐션에 모델을 노출하지 않음';
                        }
                    } catch (e: any) {
                        error = e?.message || String(e);
                    }
                    if (this._view) {
                        this._view.webview.postMessage({ type: 'ideModelsProbed', models, error });
                    }
                    break;
                }
                case 'onboardingState': {
                    const cfg = vscode.workspace.getConfiguration('agentOs');
                    const brain = (cfg.get<string>('localBrainPath') || '').trim();
                    const repo = (cfg.get<string>('secondBrainRepo') || '').trim();
                    const dismissed = !!_extCtx?.globalState.get('onboardingDismissed');
                    let engineDetected = '';
                    let engineDetail = '';
                    try {
                        const version = await pingClaude();
                        engineDetected = 'Claude CLI';
                        engineDetail = version;
                    } catch {}
                    if (this._view) {
                        this._view.webview.postMessage({
                            type: 'onboardingState',
                            dismissed,
                            steps: {
                                engine: { done: !!engineDetected, detected: engineDetected, url: '', model: engineDetail },
                                brain: { done: !!brain, path: brain },
                                github: { done: !!repo, url: repo },
                            },
                        });
                    }
                    break;
                }
                case 'detectEngine': {
                    let detected = '', detail = '';
                    try {
                        const version = await pingClaude();
                        detected = `Claude CLI ${version}`;
                        try {
                            const reply = await ask('Reply with exactly: ok', 'standard', { timeoutMs: 20_000 });
                            if (/ok/i.test(reply)) {
                                detail = 'Sonnet 응답 OK';
                            } else {
                                detail = `Sonnet 응답: "${reply.trim().slice(0, 40)}"`;
                            }
                        } catch (askErr: any) {
                            detail = `인증 필요: ${(askErr?.message || askErr).toString().slice(0, 80)}`;
                        }
                    } catch (e: any) {
                        detected = '';
                        detail = e?.message || String(e);
                    }
                    if (this._view) {
                        const label = detected
                            ? `${detected}${detail ? ' · ' + detail : ''}`
                            : `Claude CLI 미설치 — ${detail}`;
                        this._view.webview.postMessage({ type: 'engineDetected', engine: detected || 'none', model: label });
                    }
                    break;
                }
                case 'pickBrainFolder': {
                    const picked = await vscode.window.showOpenDialog({
                        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
                        openLabel: '내 두뇌 폴더로 사용', title: '🧠 두뇌 폴더 선택 (지식·대화·회사 모두 여기에 저장됨)'
                    });
                    if (picked && picked[0]) {
                        const cfg = vscode.workspace.getConfiguration('agentOs');
                        try { await cfg.update('localBrainPath', picked[0].fsPath, vscode.ConfigurationTarget.Global); } catch {}
                        if (this._view) this._view.webview.postMessage({ type: 'brainFolderPicked', path: picked[0].fsPath });
                    }
                    break;
                }
                case 'setSecondBrainRepo': {
                    const url = String(msg.value || '').trim();
                    if (url && !validateGitRemoteUrl(url)) {
                        if (this._view) this._view.webview.postMessage({ type: 'githubRepoResult', ok: false, error: '유효한 GitHub URL이 아닙니다' });
                        break;
                    }
                    try {
                        const cfg = vscode.workspace.getConfiguration('agentOs');
                        await cfg.update('secondBrainRepo', url, vscode.ConfigurationTarget.Global);
                    } catch {}
                    if (this._view) this._view.webview.postMessage({ type: 'githubRepoResult', ok: true, url });
                    break;
                }
                case 'dismissOnboarding': {
                    try { await _extCtx?.globalState.update('onboardingDismissed', true); } catch {}
                    break;
                }
                case 'corporateInit':
                    try {
                        const dir = getCompanyDir();
                        const exists = fs.existsSync(path.join(dir, '_shared'));
                        const configured = isCompanyConfigured();
                        // 사용자가 1인 기업 모드를 직접 켤 때 그날의 첫 모닝
                        // 브리핑을 흐립니다. 이전 버전에선 활성화 직후 자동
                        // 발사돼서 Ollama 차가운 상태로 "model failed to load"
                        // 에러가 사용자 액션 없이 떴음. 이제 명시적 트리거 시점에만.
                        if (configured) this.maybeMorningBriefing(this._ctx);
                        if (this._view) {
                            const view = this._view;
                            this._view.webview.postMessage({
                                type: 'corporateReady',
                                agents: AGENT_ORDER.map(id => {
                                    // Prefer high-res custom portrait if declared and the file exists,
                                    // else fall back to the bundled pixel sprite.
                                    const customName = AGENTS[id].profileImage;
                                    let portraitUri: vscode.Uri;
                                    if (customName) {
                                        const customPath = vscode.Uri.joinPath(this._ctx.extensionUri, 'assets', 'agents', customName);
                                        try {
                                            if (fs.existsSync(customPath.fsPath)) {
                                                portraitUri = customPath;
                                            } else {
                                                portraitUri = vscode.Uri.joinPath(this._ctx.extensionUri, 'assets', 'pixel', 'characters', `${id}.png`);
                                            }
                                        } catch {
                                            portraitUri = vscode.Uri.joinPath(this._ctx.extensionUri, 'assets', 'pixel', 'characters', `${id}.png`);
                                        }
                                    } else {
                                        portraitUri = vscode.Uri.joinPath(this._ctx.extensionUri, 'assets', 'pixel', 'characters', `${id}.png`);
                                    }
                                    return {
                                        id,
                                        name: AGENTS[id].name,
                                        role: AGENTS[id].role,
                                        emoji: AGENTS[id].emoji,
                                        color: AGENTS[id].color,
                                        tagline: AGENTS[id].tagline,
                                        specialty: AGENTS[id].specialty,
                                        portrait: view.webview.asWebviewUri(portraitUri).toString(),
                                        portraitIsCustom: !!customName && fs.existsSync(vscode.Uri.joinPath(this._ctx.extensionUri, 'assets', 'agents', customName).fsPath),
                                    };
                                }),
                                companyDir: dir.replace(os.homedir(), '~'),
                                companyName: readCompanyName(),
                                folderExists: exists,
                                configured,
                                brainExplicitlySet: _isBrainDirExplicitlySet(),
                                companyDay: configured ? getCompanyDay() : 1
                            });
                        }
                    } catch (e: any) {
                        if (this._view) this._view.webview.postMessage({ type: 'error', value: `⚠️ 회사 폴더 초기화 실패: ${e.message}` });
                    }
                    break;
                case 'openCompanyFolder':
                    try {
                        const dir = ensureCompanyStructure();
                        const sub = msg.sub || '';
                        const target = sub ? path.join(dir, sub) : dir;
                        vscode.env.openExternal(vscode.Uri.file(target));
                    } catch { /* ignore */ }
                    break;
                case 'companySetup': {
                    // msg.choice: 'default' | 'pick' | 'import'
                    const choice = msg.choice as string;
                    try {
                        if (choice === 'default') {
                            // ~/.agent-os-ai-brain (brain dir == company dir)
                            await setCompanyDir('');
                            ensureCompanyStructure();
                            this._sendCompanyState('두뇌 폴더에 회사 구조가 만들어졌어요.');
                        } else if (choice === 'pick') {
                            const picked = await vscode.window.showOpenDialog({
                                canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
                                openLabel: '두뇌 폴더로 사용',
                                title: '두뇌 폴더 위치 선택 (지식·회사 구조가 모두 이 폴더 안에 저장됩니다)'
                            });
                            if (picked && picked[0]) {
                                const target = picked[0].fsPath;
                                fs.mkdirSync(target, { recursive: true });
                                await setCompanyDir(target);
                                ensureCompanyStructure();
                                this._sendCompanyState(`두뇌 폴더가 ${target} 에 설정되었어요.`);
                            } else {
                                this._sendCompanyState('취소했어요.');
                            }
                        } else if (choice === 'import') {
                            const url = await vscode.window.showInputBox({
                                prompt: '기존 두뇌의 GitHub URL (예: https://github.com/me/my-brain.git)',
                                placeHolder: 'https://github.com/...',
                                validateInput: (v) => {
                                    if (!v || !v.trim()) return undefined;
                                    return validateGitRemoteUrl(v) ? undefined : '⚠️ 유효한 GitHub URL이 아닙니다';
                                }
                            });
                            if (url) {
                                const targetParent = path.join(os.homedir(), '.agent-os-ai-brain-imported');
                                fs.mkdirSync(targetParent, { recursive: true });
                                const targetName = path.basename(url, '.git');
                                const target = path.join(targetParent, targetName);
                                if (fs.existsSync(target)) {
                                    this._view?.webview.postMessage({ type: 'error', value: `⚠️ 이미 존재하는 폴더: ${target}\n다른 이름으로 다시 시도하거나 폴더를 먼저 정리해주세요.` });
                                } else {
                                    const r = gitRun(['clone', url, target], targetParent, 60000);
                                    if (r.status === 0) {
                                        // import한 위치가 Company 자체이거나 상위인지 확인
                                        const candidate = fs.existsSync(path.join(target, '_shared')) ? target : path.join(target, 'Company');
                                        await setCompanyDir(candidate);
                                        ensureCompanyStructure();
                                        this._sendCompanyState(`✅ 가져오기 완료: ${candidate}`);
                                    } else {
                                        this._view?.webview.postMessage({ type: 'error', value: `⚠️ git clone 실패: ${r.stderr || r.error?.message || 'unknown'}` });
                                    }
                                }
                            } else {
                                this._sendCompanyState('취소했어요.');
                            }
                        }
                    } catch (e: any) {
                        this._view?.webview.postMessage({ type: 'error', value: `⚠️ 회사 설정 실패: ${e.message}` });
                    }
                    break;
                }
                case 'companyInterview': {
                    // msg.answers: { name, oneLiner, audience, goalYear, goalMonth, needs }
                    // (Legacy callers may send `goal` — map it to goalYear for back-compat.)
                    try {
                        const a = msg.answers || {};
                        const goalYear = (a.goalYear || a.goal || '').trim();
                        writeCompanyConfig({
                            name: (a.name || '').trim(),
                            oneLiner: (a.oneLiner || '').trim(),
                            audience: (a.audience || '').trim(),
                            goalYear,
                            goalMonth: (a.goalMonth || '').trim(),
                            needs: (a.needs || '').trim(),
                        });
                        const namedTxt = (a.name || '').trim();
                        this._sendCompanyState(namedTxt ? `✅ "${namedTxt}" 설정 완료. 명령을 내려보세요.` : `✅ 회사 설정 저장 완료.`);
                    } catch (e: any) {
                        this._view?.webview.postMessage({ type: 'error', value: `⚠️ 인터뷰 저장 실패: ${e.message}` });
                    }
                    break;
                }
                case 'loadCompanyConfig': {
                    try {
                        ensureCompanyStructure();
                        const cfg = readCompanyConfig();
                        webviewView.webview.postMessage({ type: 'companyConfigLoaded', config: cfg });
                    } catch (e: any) {
                        webviewView.webview.postMessage({ type: 'companyConfigLoaded', config: null, error: String(e?.message || e) });
                    }
                    break;
                }
                case 'saveCompanyConfig': {
                    try {
                        writeCompanyConfig(msg.config || {});
                        const named = ((msg.config && msg.config.name) || '').trim();
                        this._sendCompanyState(named ? `✅ "${named}" 설정 저장됨.` : `✅ 회사 설정 저장됨.`);
                        webviewView.webview.postMessage({ type: 'companyConfigSaved', ok: true });
                    } catch (e: any) {
                        webviewView.webview.postMessage({ type: 'companyConfigSaved', ok: false, error: String(e?.message || e) });
                    }
                    break;
                }
                case 'newChat':
                    this.resetChat();
                    break;
                /* v2.89.106 — 대화 세션 아카이브 명령 */
                case 'listSessions': {
                    const cur = this._currentWorkspaceMeta();
                    const sessions = this._readSessions().map(s => {
                        const ss: any = s;
                        return {
                            id: ss.id, title: ss.title, preview: ss.preview || '',
                            workspace: ss.workspace || '', workspaceName: ss.workspaceName || '워크스페이스 없음',
                            createdAt: ss.createdAt, updatedAt: ss.updatedAt,
                            messageCount: ss.messageCount,
                        };
                    });
                    try {
                        this._view?.webview.postMessage({
                            type: 'sessionsList',
                            value: sessions,
                            currentWorkspace: cur.workspace,
                            currentWorkspaceName: cur.workspaceName,
                            activeSessionId: this._activeSessionId
                        });
                    } catch { /* ignore */ }
                    break;
                }
                case 'restoreSession': {
                    const id = String((msg as any).id || '').trim();
                    if (!id) break;
                    const ok = this._restoreSession(id);
                    if (!ok) {
                        try { this._view?.webview.postMessage({ type: 'systemNote', value: '⚠️ 세션을 찾을 수 없어요.' }); } catch { /* ignore */ }
                    }
                    break;
                }
                case 'renameSession': {
                    /* v2.89.108 — 세션 제목 수동 변경 */
                    const id = String((msg as any).id || '').trim();
                    const newTitle = String((msg as any).title || '').trim().slice(0, 80);
                    if (!id || !newTitle) break;
                    const sessions = this._readSessions();
                    const idx = sessions.findIndex(s => s.id === id);
                    if (idx >= 0) {
                        sessions[idx].title = newTitle;
                        sessions[idx].updatedAt = new Date().toISOString();
                        this._writeSessions(sessions);
                    }
                    /* refresh list */
                    const cur = this._currentWorkspaceMeta();
                    const out = this._readSessions().map(s => {
                        const ss: any = s;
                        return {
                            id: ss.id, title: ss.title, preview: ss.preview || '',
                            workspace: ss.workspace || '', workspaceName: ss.workspaceName || '워크스페이스 없음',
                            createdAt: ss.createdAt, updatedAt: ss.updatedAt,
                            messageCount: ss.messageCount,
                        };
                    });
                    try { this._view?.webview.postMessage({ type: 'sessionsList', value: out, currentWorkspace: cur.workspace, currentWorkspaceName: cur.workspaceName, activeSessionId: this._activeSessionId }); } catch { /* ignore */ }
                    break;
                }
                case 'deleteSession': {
                    const id = String((msg as any).id || '').trim();
                    if (!id) break;
                    this._deleteSession(id);
                    /* refresh list */
                    const cur = this._currentWorkspaceMeta();
                    const sessions = this._readSessions().map(s => {
                        const ss: any = s;
                        return {
                            id: ss.id, title: ss.title, preview: ss.preview || '',
                            workspace: ss.workspace || '', workspaceName: ss.workspaceName || '워크스페이스 없음',
                            createdAt: ss.createdAt, updatedAt: ss.updatedAt,
                            messageCount: ss.messageCount,
                        };
                    });
                    try { this._view?.webview.postMessage({ type: 'sessionsList', value: sessions, currentWorkspace: cur.workspace, currentWorkspaceName: cur.workspaceName, activeSessionId: this._activeSessionId }); } catch { /* ignore */ }
                    break;
                }
                /* v2.89.107 — 활성/비활성 토글 (사이드바). PIN 안 받음. */
                case 'setAgentActive': {
                    const aid = String((msg as any).agent || '').trim();
                    const want = !!(msg as any).active;
                    if (!aid) break;
                    if (ALWAYS_ON_AGENTS.has(aid)) {
                        try { this._view?.webview.postMessage({ type: 'systemNote', value: `⚠️ ${AGENTS[aid]?.name || aid}는 핵심 에이전트라 비활성화할 수 없어요.` }); } catch { /* ignore */ }
                        break;
                    }
                    if (LOCKED_AGENTS_DEFAULT[aid] && want) {
                        try { this._view?.webview.postMessage({ type: 'systemNote', value: `🔒 ${AGENTS[aid]?.name || aid}는 PIN 인증이 필요해요. 카드를 클릭해 PIN을 입력하세요.` }); } catch { /* ignore */ }
                        break;
                    }
                    const ok = setAgentActive(aid, want);
                    if (ok) {
                        const verb = want ? '활성화됨 ✅' : '비활성화됨 ⏸';
                        try { this._view?.webview.postMessage({ type: 'systemNote', value: `${AGENTS[aid]?.emoji || ''} ${AGENTS[aid]?.name || aid} ${verb}` }); } catch { /* ignore */ }
                        try { this._view?.webview.postMessage({ type: 'activeAgents', value: readActiveAgents() }); } catch { /* ignore */ }
                        /* v2.89.112 — 코다리 첫 활성화 시 시니어 코더 모델 추천 카드 */
                        if (want && aid === 'developer') {
                            try { if (this._view) _maybeRecommendCoderModel(this._view.webview); } catch { /* ignore */ }
                        }
                        try {
                            if (CompanyDashboardPanel.current) CompanyDashboardPanel.current.refresh();
                        } catch { /* ignore */ }
                    } else {
                        try { this._view?.webview.postMessage({ type: 'systemNote', value: `⚠️ 변경 실패: 회사 폴더 쓰기 권한 확인.` }); } catch { /* ignore */ }
                    }
                    break;
                }
                /* v2.89.95 — 채용 PIN 통과 후 webview가 알림. 회사 폴더에 영구 저장.
                   v2.89.106 — PIN backend 재검증 + 두 화면 동기화. 사이드바·대쉬보드
                   어디서 채용해도 backend가 단일 진실 소스. */
                case 'agentHired':
                    try {
                        const aid = String((msg as any).agent || '').trim();
                        const pin = String((msg as any).pin || '');
                        if (!aid || !LOCKED_AGENTS_DEFAULT[aid]) break;
                        /* 잠긴 에이전트만 PIN 게이트 통과 가능. PIN 없거나 다르면 거부. */
                        if (pin !== '0000') {
                            try { this._view?.webview.postMessage({ type: 'systemNote', value: '❌ 인증 실패: 잘못된 코드입니다.' }); } catch { /* ignore */ }
                            break;
                        }
                        const ok = markAgentHired(aid);
                        if (!ok) {
                            try { this._view?.webview.postMessage({ type: 'systemNote', value: '⚠️ 채용 실패: 회사 폴더에 쓰기 권한이 없습니다.' }); } catch { /* ignore */ }
                            break;
                        }
                        try { vscode.window.showInformationMessage(`🎉 ${aid} 에이전트 채용 완료! 이제 활용 가능합니다.`); } catch { /* ignore */ }
                        /* 사이드바에 즉시 동기화 + 대쉬보드 패널 열려있으면 거기도 refresh */
                        try {
                            this._view?.webview.postMessage({ type: 'hiredAgents', value: readHiredAgents() });
                        } catch { /* ignore */ }
                        try {
                            if (CompanyDashboardPanel.current) CompanyDashboardPanel.current.refresh();
                        } catch { /* ignore */ }
                    } catch { /* ignore — UI 이미 잠금 해제됨 */ }
                    break;
                case 'ready':
                    // 웹뷰가 준비되면 저장된 대화 기록 복원 + 회사 상태 동기화.
                    // v2.89.86 — 이전엔 _sendCompanyState() 가 사용자 셋업 액션 후에만
                    // 호출돼서, 사이드바 재로드 시 companyState.configured 가 false로
                    // 시작했음. 그 결과 셋업 완료된 사용자가 👔 모드에서 메시지 보내도
                    // send() 의 가드 (`corp && !companyState.configured`) 에 막혀서
                    // 응답 없이 차단됐음. ready 시점에 한 번 더 동기화.
                    this._restoreDisplayMessages();
                    this._sendCompanyState();
                    break;
                case 'openSettings':
                    await this._handleSettingsMenu();
                    break;
                case 'syncBrain':
                    await this._handleBrainMenu();
                    break;
                case 'showBrainNetwork':
                    vscode.commands.executeCommand('agent-os.showBrainNetwork');
                    break;
                case 'openOffice':
                    vscode.commands.executeCommand('agent-os.openOffice');
                    break;
                case 'toggleOffice':
                    if (OfficePanel.current) {
                        OfficePanel.current.dispose();
                    } else {
                        vscode.commands.executeCommand('agent-os.openOffice');
                    }
                    break;
                case 'closeOffice':
                    if (OfficePanel.current) OfficePanel.current.dispose();
                    break;
                case 'toggleThinking':
                    await this._toggleThinkingMode();
                    break;
                case 'requestStatus':
                    this._sendStatusUpdate();
                    break;
                case 'statusFolderClick':
                    await this._handleStatusFolderClick();
                    break;
                case 'statusGitClick':
                    await this._handleStatusGitClick();
                    break;
                case 'highlightBrainNote':
                    if (typeof msg.note === 'string') {
                        if (!this._thinkingPanel) this._openThinkingPanel();
                        // Allow the panel a moment to load before sending the highlight
                        setTimeout(() => this._postThinking({ type: 'highlight_node', note: msg.note }), 350);
                    }
                    break;
                case 'injectLocalBrain':
                    await this._handleInjectLocalBrain(msg.files);
                    break;
                case 'stopGeneration':
                    if (this._abortController) {
                        this._abortController.abort();
                        this._abortController = undefined;
                    }
                    /* Force-clear any agent cards stuck in 'thinking' state — abort
                       can race past the corporate flow's per-stage agentEnd posts. */
                    try {
                        for (const id of AGENT_ORDER) {
                            this._broadcastCorporate({ type: 'agentEnd', agent: id });
                        }
                    } catch { /* ignore */ }
                    break;
                case 'regenerate':
                    if (this._lastPrompt) {
                        // Remove last AI response from history
                        if (this._chatHistory.length > 0 && this._chatHistory[this._chatHistory.length - 1].role === 'assistant') {
                            this._chatHistory.pop();
                        }
                        if (this._displayMessages.length > 0 && this._displayMessages[this._displayMessages.length - 1].role === 'ai') {
                            this._displayMessages.pop();
                        }
                        await this._handlePrompt(this._lastPrompt, this._lastModel || '');
                    }
                    break;
            }
            } catch (msgErr: any) {
                /* v2.89.97 — 메시지 처리 중 어떤 예외든 잡힘. 사용자에게 정확한
                   복구 절차 안내. 가장 흔한 원인: Ollama/LM Studio 미실행, 모델 미로드,
                   메모리 부족, 또는 prior request의 stream pipe가 꼬여 axios 내부에서
                   RangeError. */
                const stack = msgErr?.stack ? String(msgErr.stack).split('\n').slice(0, 4).join('\n') : '';
                console.error('[Agent OS] message handler 예외:', stack || msgErr);
                try {
                    webviewView.webview.postMessage({
                        type: 'error',
                        value: `⚠️ 메시지 처리 중 오류 (type=${(msg as any)?.type || '?'}): ${msgErr?.message || msgErr}\n\n복구 방법:\n  1) 안티그래비티 재시작\n  2) 그래도 안 되면 Cmd/Ctrl+Shift+P → "Developer: Reload Window"\n\n[stack]\n${stack}`
                    });
                } catch { /* webview gone */ }
            }
        });

        // 리스너를 붙인 후 HTML을 렌더링합니다.
        webviewView.webview.html = this._getHtml();
        webviewView.webview.postMessage({ type: 'companyMetrics', metrics: getCompanyMetrics() });
        /* v2.89.91 — 회사 상태 두-단계 동기화. v2.89.86은 'ready' 이벤트에만 의존했는데,
           webview 재로드·iframe dispose/recreate 같은 경로에서 ready가 누락되면
           companyState.configured=false 로 굳어 사용자 메시지가 가드에 막혔음.
           이제 mount 직후 push + ready 시 push 둘 다 → 메시지 큐가 둘 중 하나만
           살아도 정상 동기화됨. */
        try { this._sendCompanyState(); } catch { /* ignore — _sendCompanyState 내부 가드 있음 */ }

        // Sidebar just mounted — drain any prompts that were buffered while it
        // was closed (e.g. Idea Lab injected knowledge before the user opened it).
        this._flushPendingPrompts();

        /* v2.89.91 — webview 가시성 변경(panel 다시 열림 등) 시 재동기화. 사용자가
           사이드바를 닫았다 다시 열면 _view 가 살아 있어도 상태 표시가 stale 가능. */
        try {
            webviewView.onDidChangeVisibility(() => {
                if (webviewView.visible) {
                    try { this._sendCompanyState(); } catch { /* ignore */ }
                }
            });
        } catch { /* ignore — onDidChangeVisibility 부재 시 무시 */ }
    }

    // --------------------------------------------------------
    // Settings Menu (Engine + AI Tuning)
    // --------------------------------------------------------
    private async _handleSettingsMenu() {
        const mainPick = await vscode.window.showQuickPick([
            { label: '🤖 Claude CLI 진단', description: '`claude --version` + Sonnet 응답 테스트', action: 'diagnose' },
            { label: '🎛️ AI 파라미터 튜닝', description: `Temp: ${this._temperature}, Top-P: ${this._topP}, Top-K: ${this._topK}`, action: 'params' },
            { label: '📝 시스템 프롬프트 설정', description: '에이전트의 기본 역할을 커스텀합니다.', action: 'prompt' }
        ], { placeHolder: '설정 메뉴' });

        if (!mainPick) return;

        if (mainPick.action === 'diagnose') {
            await vscode.commands.executeCommand('agentOs.diagnoseConnection');
        }
        else if (mainPick.action === 'params') {
            const paramPick = await vscode.window.showQuickPick([
                { label: `Temperature (${this._temperature})`, description: '답변의 창의성 (0.0 ~ 2.0)', action: 'temp' },
                { label: `Top P (${this._topP})`, description: '단어 선택 확률 (0.0 ~ 1.0)', action: 'topp' },
                { label: `Top K (${this._topK})`, description: '단어 선택 범위 (1 ~ 100)', action: 'topk' },
            ], { placeHolder: '파라미터를 선택하세요' });

            if (!paramPick) return;

            if (paramPick.action === 'temp') {
                const val = await vscode.window.showInputBox({ prompt: 'Temperature 값 (0.0~2.0)', value: this._temperature.toString() });
                if (val && !isNaN(Number(val))) {
                    this._temperature = Number(val);
                    this._ctx.globalState.update('aiTemperature', this._temperature);
                    vscode.window.showInformationMessage(`Temperature가 ${this._temperature}로 변경되었습니다.`);
                }
            } else if (paramPick.action === 'topp') {
                const val = await vscode.window.showInputBox({ prompt: 'Top P 값 (0.0~1.0)', value: this._topP.toString() });
                if (val && !isNaN(Number(val))) {
                    this._topP = Number(val);
                    this._ctx.globalState.update('aiTopP', this._topP);
                    vscode.window.showInformationMessage(`Top P가 ${this._topP}로 변경되었습니다.`);
                }
            } else if (paramPick.action === 'topk') {
                const val = await vscode.window.showInputBox({ prompt: 'Top K 값 (1~100)', value: this._topK.toString() });
                if (val && !isNaN(Number(val))) {
                    this._topK = Number(val);
                    this._ctx.globalState.update('aiTopK', this._topK);
                    vscode.window.showInformationMessage(`Top K가 ${this._topK}로 변경되었습니다.`);
                }
            }
        }
        else if (mainPick.action === 'prompt') {
            const val = await vscode.window.showInputBox({ 
                prompt: '시스템 프롬프트 (비워두면 기본값으로 초기화됩니다)', 
                value: this._systemPrompt === SYSTEM_PROMPT ? '' : this._systemPrompt,
                ignoreFocusOut: true
            });
            if (val !== undefined) {
                this._systemPrompt = val.trim() || SYSTEM_PROMPT;
                this._ctx.globalState.update('aiSystemPrompt', this._systemPrompt);
                this._initHistory();
                this._saveHistory();
                vscode.window.showInformationMessage('시스템 프롬프트가 변경되어 새 대화가 시작되었습니다.');
                if (this._view) this._view.webview.postMessage({ type: 'clearChat' });
            }
        }
    }

    private async _handleInjectLocalBrain(files: any[]) {
        if (!this._view) return;
        
        // 폴더 미설정 시 먼저 폴더 선택 강제
        let brainDir: string;
        if (!_isBrainDirExplicitlySet()) {
            const ensured = await _ensureBrainDir();
            if (!ensured) {
                vscode.window.showWarningMessage("📁 지식을 저장할 폴더를 먼저 선택해주세요!");
                return;
            }
            brainDir = ensured;
        } else {
            brainDir = _getBrainDir();
        }
        
        if (!fs.existsSync(brainDir)) {
            fs.mkdirSync(brainDir, { recursive: true });
        }
        const today = new Date();
        const dateStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
        const datePath = path.join(brainDir, '00_Raw', dateStr);
        
        if (!fs.existsSync(datePath)) {
            fs.mkdirSync(datePath, { recursive: true });
        }

        let injectedTitles: string[] = [];
        const routedAgents = new Set<string>();

        this._view.webview.postMessage({ type: 'response', value: `🧠 **[P-Reinforce 연동 준비]**\n첨부하신 ${files.length}개의 파일을 로컬 두뇌(\`00_Raw/${dateStr}\`)에 입수하고 자동 푸시를 진행합니다.` });

        for (const file of files) {
            try {
                if (typeof file?.name !== 'string' || typeof file?.data !== 'string') continue;
                const fileContent = Buffer.from(file.data, 'base64').toString('utf-8');
                const sanitized = file.name.replace(/[^a-zA-Z0-9가-힣_.-]/gi, '_');
                const safeTitle = safeBasename(sanitized);
                if (!safeTitle) continue;
                const filePath = safeResolveInside(datePath, safeTitle);
                if (!filePath) continue; // path traversal blocked
                fs.writeFileSync(filePath, fileContent, 'utf-8');
                injectedTitles.push(safeTitle);
                /* Route a one-line summary into matching agents' memory.md
                   so on next cycle they already see "new knowledge inbound"
                   even before scanning the brain folder themselves. Best-effort. */
                try {
                    const recipients = routeBrainInjectionToAgents(filePath, safeTitle);
                    for (const id of recipients) routedAgents.add(id);
                } catch (e) {
                    console.error('Failed to route inject to agent memory:', e);
                }
            } catch (err) {
                console.error('Failed to write brain file:', err);
            }
        }
        /* Surface routing to the user so they know which agents got updated. */
        if (routedAgents.size > 0) {
            const labels = Array.from(routedAgents).map(id => {
                const a = (AGENTS as any)[id];
                return a ? `${a.emoji} ${a.name}` : id;
            }).join(', ');
            this._view.webview.postMessage({ type: 'response', value: `🧠 ${labels} 의 메모리에 새 지식이 자동 연결되었습니다. 다음 사이클부터 활용합니다.` });
        }
        
        const safeTitles = injectedTitles.join(', ');

        _safeGitAutoSync(brainDir, `Auto-Inject Knowledge [Raw]: ${safeTitles}`, this);
        this._sendStatusUpdate();
            
        setTimeout(() => {
            let combinedContent = '';
            for (const title of injectedTitles) {
                try {
                    const content = fs.readFileSync(path.join(datePath, title), 'utf-8');
                    combinedContent += `\n\n[원본 데이터: ${title}]\n\`\`\`\n${content.slice(0, 10000)}\n\`\`\``;
                } catch(e) {}
            }

            const hiddenPrompt = `[A.U 시스템 지시: P-Reinforce Architect 모드 활성화]\n새로운 비정형 데이터('${safeTitles}')가 글로벌 두뇌(Second Brain)에 입수 및 클라우드 백업 처리 완료되었습니다.\n\n방금 입수된 데이터의 원본 내용은 아래와 같습니다:${combinedContent}\n\n여기서부터 중요합니다! 마스터가 '응'이나 '진행해' 등으로 동의할 경우, 당신은 절대 대화만으로 대답하지 말고 아래의 [P-Reinforce 구조화 규격]에 따라 곧바로 <create_file> Tool들을 사용하십시오.\n\n[P-Reinforce 구조화 규격]\n1. 폴더 생성: 원본 데이터를 주제별로 쪼개어 절대 경로인 \`${brainDir}/10_Wiki/\` 하위의 적절한 폴더(예: 🛠️ Projects, 💡 Topics, ⚖️ Decisions, 🚀 Skills)에 저장하십시오.\n2. 마크다운 양식 준수: 생성되는 각 문서 파일은 반드시 아래 포맷을 따라야 합니다.\n---\nid: {{UUID}}\ncategory: "[[10_Wiki/설정한_폴더]]"\nconfidence_score: 0.9\ntags: [관련태그]\nlast_reinforced: ${dateStr}\n---\n# [[문서 제목]]\n## 📌 한 줄 통찰\n> (핵심 요약)\n## 📖 구조화된 지식\n- (세부 내용 불렛 포인트)\n## 🔗 지식 연결\n- Parent: [[상위_카테고리]]\n- Related: [[연관_개념]]\n- Raw Source: [[00_Raw/${dateStr}/${safeTitles}]]\n\n지시를 숙지했다면 묻지 말고 즉각 \`<create_file path="${brainDir}/10_Wiki/새폴더/새문서.md">\`를 사용하여 지식을 분해 후 생성하십시오. 완료 후 잘라낸 결과를 보고하십시오.`;
            this._chatHistory.push({ role: 'system', content: hiddenPrompt });
            
            const uiMsg = "🧠 데이터가 완벽하게 입수되었습니다! 즉시 P-Reinforce 구조화를 시작할까요?";
            this.injectSystemMessage(uiMsg);
        }, 3000);
    }

    // --------------------------------------------------------
    // Fetch available Claude models (fixed 3-tier list)
    // --------------------------------------------------------
    private async _sendModels() {
        if (!this._view) { return; }
        const models = ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];
        this._view.webview.postMessage({ type: 'modelsList', value: models });
    }

    // --------------------------------------------------------
    // Second Brain Menu (QuickPick)
    // --------------------------------------------------------
    private async _handleBrainMenu() {
        if (!this._view) { return; }
        
        const brainDir = _getBrainDir();
        const brainFiles = fs.existsSync(brainDir) ? this._findBrainFiles(brainDir) : [];
        const fileCount = brainFiles.length;
        
        const currentRepo = vscode.workspace.getConfiguration('agentOs').get<string>('secondBrainRepo', '');
        const repoLabel = currentRepo ? currentRepo.split('/').pop() : '없음';
        
        const items: any[] = [
            { label: '☁️ 온라인 지식 공간', description: currentRepo ? `GitHub: ${repoLabel}` : 'GitHub 주소 설정', action: 'changeGithub' },
            { label: '📁 로컬 지식 공간', description: brainDir ? `폴더: ${path.basename(brainDir)} (${fileCount}개 파일)` : '폴더 위치 설정', action: 'changeFolder' },
            { label: '🔄 지금 백업', description: '온라인과 로컬 동기화', action: 'githubSync' },
            { label: '🌐 네트워크 보기', description: '지식 연결 그래프', action: 'viewGraph' },
            { label: '🗑️ 삭제', description: 'GitHub 연결 또는 로컬 폴더 분리', action: 'cleanup' },
        ];

        const pick = await vscode.window.showQuickPick(items, { placeHolder: '🧠 지식 공간 관리' });
        if (!pick) return;

        switch (pick.action) {
            case 'listFiles': {
                if (fileCount === 0) {
                    const action = await vscode.window.showInformationMessage(
                        '📂 아직 저장된 지식이 없어요. 지식 폴더에 .md 파일을 넣어주세요!',
                        '📁 지식 폴더 열기'
                    );
                    if (action === '📁 지식 폴더 열기') {
                        if (!fs.existsSync(brainDir)) fs.mkdirSync(brainDir, { recursive: true });
                        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(brainDir));
                    }
                } else {
                    const fileItems = brainFiles.slice(0, 50).map(f => {
                        const rel = path.relative(brainDir, f);
                        let title = '';
                        try { title = fs.readFileSync(f, 'utf-8').split('\n').find(l => l.trim().length > 0)?.replace(/^#+\s*/, '').slice(0, 60) || ''; } catch {}
                        return { label: `📄 ${rel}`, description: title, filePath: f };
                    });
                    const selected = await vscode.window.showQuickPick(fileItems, { 
                        placeHolder: `📂 내 지식 파일 (총 ${fileCount}개) — 클릭하면 내용을 볼 수 있어요` 
                    });
                    if (selected) {
                        const doc = await vscode.workspace.openTextDocument(selected.filePath);
                        vscode.window.showTextDocument(doc);
                    }
                }
                break;
            }
            case 'changeFolder': {
                const folders = await vscode.window.showOpenDialog({
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false,
                    openLabel: '이 폴더를 내 지식 폴더로 사용',
                    title: '📁 AI에게 읽혀줄 지식(.md 파일)이 들어있는 폴더를 선택하세요'
                });
                if (folders && folders.length > 0) {
                    const selectedPath = folders[0].fsPath;
                    await vscode.workspace.getConfiguration('agentOs').update('localBrainPath', selectedPath, vscode.ConfigurationTarget.Global);
                    this._brainEnabled = true;
                    this._ctx.globalState.update('brainEnabled', true);
                    
                    // 새 폴더에 git이 없으면 자동 초기화 + 기존 깃허브 URL로 remote 재연결
                    const newGitDir = path.join(selectedPath, '.git');
                    if (!fs.existsSync(newGitDir)) {
                        try {
                            gitExec(['init'], selectedPath);
                            gitExecSafe(['branch', '-M', 'main'], selectedPath);

                            const existingRepo = vscode.workspace.getConfiguration('agentOs').get<string>('secondBrainRepo', '');
                            const cleanRepo = existingRepo ? validateGitRemoteUrl(existingRepo) : null;
                            if (cleanRepo) {
                                gitExecSafe(['remote', 'add', 'origin', cleanRepo], selectedPath);
                            }
                        } catch (e) {
                            console.warn('Git init on new brain folder failed:', e);
                        }
                    }
                    
                    const newFiles = this._findBrainFiles(selectedPath);
                    vscode.window.showInformationMessage(`✅ 지식 폴더가 변경되었어요! (${newFiles.length}개 지식 파일 발견)`);
                    this._view.webview.postMessage({ type: 'response', value: `🧠 **지식 폴더 연결 완료!**\n📁 ${selectedPath}\n📄 ${newFiles.length}개의 지식 파일을 읽고 있어요.` });
                }
                break;
            }
            case 'resync': {
                this._brainEnabled = true;
                this._ctx.globalState.update('brainEnabled', true);
                const refreshedFiles = this._findBrainFiles(brainDir);
                vscode.window.showInformationMessage(`🔄 지식 새로고침 완료! (${refreshedFiles.length}개)`);
                this._view.webview.postMessage({ type: 'response', value: `🔄 **지식 새로고침 완료!** ${refreshedFiles.length}개 지식이 연결되어 있어요.\n\n지식 모드가 ON 되었습니다.` });
                break;
            }
            case 'viewGraph': {
                vscode.commands.executeCommand('agent-os.showBrainNetwork');
                break;
            }
            case 'githubSync': {
                await this._syncSecondBrain();
                break;
            }
            case 'changeGithub': {
                const existing = vscode.workspace.getConfiguration('agentOs').get<string>('secondBrainRepo', '');
                const inputUrl = await vscode.window.showInputBox({
                    prompt: '☁️ 온라인 지식 공간 — GitHub 주소 (Enter로 저장)',
                    placeHolder: '예: https://github.com/사용자명/저장소이름',
                    value: existing,
                    ignoreFocusOut: true,
                    validateInput: (val) => {
                        const v = (val || '').trim();
                        if (!v) return null;
                        if (validateGitRemoteUrl(v)) return null;
                        return '⚠️ 형식: https://github.com/사용자/저장소  또는  git@github.com:사용자/저장소.git';
                    }
                });
                if (inputUrl !== undefined && inputUrl.trim()) {
                    const cleaned = validateGitRemoteUrl(inputUrl) || inputUrl.trim();
                    await vscode.workspace.getConfiguration('agentOs').update('secondBrainRepo', cleaned, vscode.ConfigurationTarget.Global);
                    const saved = vscode.workspace.getConfiguration('agentOs').get<string>('secondBrainRepo', '');
                    vscode.window.showInformationMessage(`✅ 온라인 지식 공간 저장됨: ${saved}`);
                    this._sendStatusUpdate();
                }
                break;
            }
            case 'cleanup': {
                const cfg = vscode.workspace.getConfiguration('agentOs');
                const hasGit = !!(cfg.get<string>('secondBrainRepo', '') || '');
                const hasFolder = _isBrainDirExplicitlySet();

                const items: any[] = [];
                if (hasGit) items.push({ label: '☁️ 온라인 지식 공간 연결만 끊기', description: '파일은 그대로, GitHub 주소만 제거', kind: 'github' });
                if (hasFolder) items.push({ label: '📁 로컬 지식 공간 연결만 분리', description: '파일은 디스크에 그대로, 익스텐션에서만 분리', kind: 'folder' });
                if (items.length === 0) {
                    vscode.window.showInformationMessage('지울 연결이 없어요. 이미 깨끗합니다 ✨');
                    break;
                }
                items.push({ label: '⛔ 취소', kind: 'cancel' });

                const pick2 = await vscode.window.showQuickPick(items, { placeHolder: '🗑️ 무엇을 끊을까요?' });
                if (!pick2 || pick2.kind === 'cancel') break;

                if (pick2.kind === 'github') {
                    const confirm = await vscode.window.showWarningMessage(
                        '☁️ 온라인 지식 공간 연결을 끊을까요?\n\n• GitHub 저장소 주소만 제거됩니다\n• 로컬 파일과 GitHub 저장소 자체는 그대로 남아요',
                        { modal: true },
                        '☁️ 끊기',
                        '⛔ 취소'
                    );
                    if (confirm === '☁️ 끊기') {
                        await cfg.update('secondBrainRepo', '', vscode.ConfigurationTarget.Global);
                        vscode.window.showInformationMessage('☁️ 온라인 지식 공간 연결 해제됨.');
                        this._sendStatusUpdate();
                    }
                } else if (pick2.kind === 'folder') {
                    const confirm = await vscode.window.showWarningMessage(
                        '📁 로컬 지식 공간 연결을 분리할까요?\n\n• 익스텐션이 더 이상 이 폴더를 참조하지 않습니다\n• 디스크의 파일은 그대로 남아요 (수동 삭제 안 함)',
                        { modal: true },
                        '📁 분리',
                        '⛔ 취소'
                    );
                    if (confirm === '📁 분리') {
                        await cfg.update('localBrainPath', '', vscode.ConfigurationTarget.Global);
                        vscode.window.showInformationMessage('📁 로컬 지식 공간 연결 분리됨.');
                        this._sendStatusUpdate();
                    }
                }
                break;
            }
        }
    }

    // --------------------------------------------------------
    // Second Brain (Github Repo Knowledge Sync)
    // --------------------------------------------------------
    private async _syncSecondBrain() {
        if (!this._view) { return; }
        if (this._isSyncingBrain) {
            vscode.window.showWarningMessage('동기화가 이미 진행 중입니다. 잠시만 기다려주세요!');
            return;
        }

        // 폴더 미설정 시 먼저 폴더 선택 강제
        if (!_isBrainDirExplicitlySet()) {
            const ensured = await _ensureBrainDir();
            if (!ensured) { return; }
        }

        let secondBrainRepo = vscode.workspace.getConfiguration('agentOs').get<string>('secondBrainRepo', '');
        
        // UX 극대화: 안 채워져 있으면 에러 내뱉지 말고 입력창 띄우기!
        if (!secondBrainRepo) {
            const inputUrl = await vscode.window.showInputBox({
                prompt: '🧠 GitHub 저장소 주소를 입력하세요 (Enter로 저장)',
                placeHolder: '예: https://github.com/사용자명/저장소이름',
                ignoreFocusOut: true,
                validateInput: (val) => {
                    const v = (val || '').trim();
                    if (!v) return null;
                    if (validateGitRemoteUrl(v)) return null;
                    return '⚠️ 형식: https://github.com/사용자/저장소  또는  git@github.com:사용자/저장소.git';
                }
            });
            if (!inputUrl || !inputUrl.trim()) { return; }

            const cleaned = validateGitRemoteUrl(inputUrl) || inputUrl.trim();
            await vscode.workspace.getConfiguration('agentOs').update('secondBrainRepo', cleaned, vscode.ConfigurationTarget.Global);
            secondBrainRepo = cleaned;
        }

        // git이 시스템에 없으면 의미 있는 에러로 즉시 종료
        if (!isGitAvailable()) {
            this._view.webview.postMessage({ type: 'error', value: '⚠️ git이 설치되지 않았습니다.\n\n👉 https://git-scm.com/downloads 에서 설치 후 VS Code를 다시 실행해주세요.' });
            return;
        }

        // 자동 sync와 동시 실행 방지 (data race로 인한 손상 방지)
        if (_autoSyncRunning) {
            this._view.webview.postMessage({ type: 'response', value: '⏳ 백그라운드에서 자동 동기화가 진행 중입니다. 잠시 후 다시 시도해주세요.' });
            return;
        }
        _setAutoSyncRunning(true);
        this._isSyncingBrain = true;
        const brainDir = _getBrainDir();
        try {
            this._view.webview.postMessage({ type: 'response', value: '🔄 **지식 동기화 진행 중...** 내 지식 폴더와 GitHub을 최신 상태로 맞추고 있어요.' });

            if (!fs.existsSync(brainDir)) {
                fs.mkdirSync(brainDir, { recursive: true });
            }

            const gitDir = path.join(brainDir, '.git');
            const cleanRepo = validateGitRemoteUrl(secondBrainRepo);
            if (!cleanRepo) {
                throw new Error('지원되지 않는 저장소 URL 형식입니다. 예: https://github.com/사용자/레포지토리');
            }

            // git이 없으면 init
            if (!fs.existsSync(gitDir)) {
                gitExec(['init'], brainDir);
            }

            ensureBrainGitignore(brainDir);
            ensureInitialCommit(brainDir);

            // remote 재연결
            gitExecSafe(['remote', 'remove', 'origin'], brainDir);
            gitExec(['remote', 'add', 'origin', cleanRepo], brainDir);

            // 인증은 시스템 git에 맡깁니다 (osxkeychain / gh CLI / SSH 키 등).
            // VS Code OAuth 강제 호출은 더 헷갈리게 만들었기 때문에 제거.

            // 1. 로컬 변경사항 커밋
            gitExecSafe(['add', '.'], brainDir);
            gitExecSafe(['commit', '-m', 'Auto-sync local brain'], brainDir);

            // 2. 원격 기본 브랜치 감지 + 로컬 브랜치 정렬
            const remoteBranch = getRemoteDefaultBranch(brainDir);
            const currentBranch = gitExecSafe(['rev-parse', '--abbrev-ref', 'HEAD'], brainDir)?.trim() || '';
            if (currentBranch && currentBranch !== remoteBranch) {
                gitExecSafe(['branch', '-M', remoteBranch], brainDir);
            }

            // 3. fetch (원격 상태 파악)
            const fetchRes = gitRun(['fetch', 'origin'], brainDir, 30000);
            const remoteHasBranch = gitExecSafe(['rev-parse', '--verify', `origin/${remoteBranch}`], brainDir) !== null;

            if (fetchRes.status !== 0 && !(fetchRes.stderr || '').toLowerCase().includes("couldn't find remote ref")) {
                const err = classifyGitError(fetchRes.stderr);
                throw new Error(err.message);
            }

            // 4. 원격에 브랜치가 있으면 fast-forward 시도
            if (remoteHasBranch) {
                const ffRes = gitRun(['merge', '--ff-only', `origin/${remoteBranch}`], brainDir, 15000);
                if (ffRes.status !== 0) {
                    const stderrLower = ffRes.stderr.toLowerCase();
                    const diverged = stderrLower.includes('not possible') || stderrLower.includes('non-fast-forward') || stderrLower.includes('refusing');
                    if (diverged) {
                        // 사용자에게 충돌 해결 방법 선택권 제공 (silently 덮어쓰지 않음!)
                        const choice = await vscode.window.showWarningMessage(
                            '🤔 내 PC와 GitHub이 서로 다르게 수정됐어요.\n어떤 걸 살릴까요?',
                            { modal: true },
                            '🤝 둘 다 합치기 (추천)',
                            '💻 내 PC 내용으로 덮어쓰기',
                            '☁️ GitHub 내용으로 덮어쓰기'
                        );
                        if (!choice) {
                            this._view.webview.postMessage({ type: 'response', value: '⏸️ 동기화 취소했어요. 내 PC 파일은 그대로 안전합니다.' });
                            return;
                        }
                        // 선택 적용 — 자동 병합 실패 시 즉시 재선택 다이얼로그를 띄워 사용자를 메뉴로 돌려보내지 않음
                        let resolved = false;
                        let activeChoice: string = choice;
                        for (let attempt = 0; attempt < 3 && !resolved; attempt++) {
                            if (activeChoice.startsWith('🤝')) {
                                // We already fetched at step 3 above — use git merge directly to avoid the
                                // git 2.27+ "divergent branches" hint that `git pull` (without --rebase / --ff-only) emits.
                                const mergeRes = gitRun(['merge', '--no-edit', '--allow-unrelated-histories', `origin/${remoteBranch}`], brainDir, 30000);
                                if (mergeRes.status === 0) {
                                    resolved = true;
                                    break;
                                }
                                // 실패 → 머지 상태 정리 후 사용자에게 다른 방법을 즉시 제안
                                gitExecSafe(['merge', '--abort'], brainDir);
                                const conflicted = gitExecSafe(['diff', '--name-only', '--diff-filter=U'], brainDir)?.trim();
                                const detailMsg = conflicted
                                    ? `🤝 자동으로 못 합쳤어요. 같은 줄이 양쪽에서 다르게 수정됐거든요.\n\n충돌 파일:\n${conflicted}\n\n어떻게 할까요?`
                                    : '🤝 자동으로 못 합쳤어요. 어떻게 할까요?';
                                const next = await vscode.window.showWarningMessage(
                                    detailMsg,
                                    { modal: true },
                                    '💻 내 PC 내용으로 덮어쓰기',
                                    '☁️ GitHub 내용으로 덮어쓰기',
                                    '🛠️ 폴더 열어서 직접 고치기'
                                );
                                if (!next) {
                                    this._view.webview.postMessage({ type: 'response', value: '⏸️ 동기화 취소했어요. 내 PC 파일은 그대로 안전합니다.' });
                                    return;
                                }
                                if (next.startsWith('🛠️')) {
                                    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(brainDir));
                                    this._view.webview.postMessage({ type: 'response', value: '🛠️ 폴더를 열었어요. 파일을 직접 수정한 뒤, 메뉴에서 다시 동기화를 눌러주세요.' });
                                    return;
                                }
                                activeChoice = next;
                                continue;
                            }
                            if (activeChoice.startsWith('💻') || activeChoice.startsWith('💪')) {
                                // git merge with -s recursive -X ours = "merge, but on conflicts prefer my (local) side"
                                const mres = gitRun(['merge', '--no-edit', '--allow-unrelated-histories', '-s', 'recursive', '-X', 'ours', `origin/${remoteBranch}`], brainDir, 30000);
                                if (mres.status !== 0) throw new Error(classifyGitError(mres.stderr).message);
                                resolved = true;
                                break;
                            }
                            // ☁️ GitHub 내용으로 덮어쓰기
                            const fres = gitRun(['fetch', 'origin', remoteBranch], brainDir, 30000);
                            if (fres.status !== 0) throw new Error(classifyGitError(fres.stderr).message);
                            gitExec(['reset', '--hard', `origin/${remoteBranch}`], brainDir, 15000);
                            resolved = true;
                            break;
                        }
                        if (!resolved) {
                            throw new Error('합치기를 끝내지 못했어요. 폴더를 직접 열어서 수정해주세요.');
                        }
                    }
                }
            }

            // 5. push — 시스템 git 자격증명 그대로 사용 (osxkeychain / gh CLI / SSH 키)
            const pushRes = gitRun(['push', '-u', 'origin', remoteBranch], brainDir, 60000);
            if (pushRes.status !== 0) {
                const err = classifyGitError(pushRes.stderr);
                if (err.kind === 'rejected') {
                    // 충돌이 다시 발생한 경우 — force-push는 사용자 명시적 동의 후에만
                    const force = await vscode.window.showWarningMessage(
                        '☁️ GitHub에 더 새로운 내용이 있어요.\n\n그래도 내 PC 내용으로 덮어쓸까요?\n(주의: GitHub의 새 내용은 영구 삭제됩니다)',
                        { modal: true },
                        '⛔ 그만두기 (안전)',
                        '⚠️ 그래도 덮어쓰기'
                    );
                    if (force === '⚠️ 그래도 덮어쓰기') {
                        const forceRes = gitRun(['push', '-u', 'origin', remoteBranch, '--force-with-lease'], brainDir, 60000);
                        if (forceRes.status !== 0) {
                            throw new Error(classifyGitError(forceRes.stderr).message);
                        }
                    } else {
                        throw new Error('덮어쓰기를 그만두었어요. 내 PC 파일은 그대로 안전합니다.');
                    }
                } else {
                    throw new Error(err.message);
                }
            }

            // 연동 완료 후 자동으로 지식 모드 ON
            this._brainEnabled = true;
            this._ctx.globalState.update('brainEnabled', true);

            vscode.window.showInformationMessage('✅ GitHub 동기화 완료!');
            this._view.webview.postMessage({ type: 'response', value: `✅ **동기화가 끝났어요!** (브랜치: \`${remoteBranch}\`)\n\n내 PC와 GitHub이 이제 완전히 똑같은 상태예요.\n\n앞으로 AI가 답변할 때 이 지식들을 참고합니다. (지식 모드: 🟢 ON)` });
            this._sendStatusUpdate();
        } catch (error: any) {
            const userMsg = error?.message || '알 수 없는 문제가 생겼어요';
            vscode.window.showErrorMessage(`동기화 실패: ${userMsg}`);
            this._view.webview.postMessage({ type: 'error', value: `⚠️ ${userMsg}` });
        } finally {
            this._isSyncingBrain = false;
            _setAutoSyncRunning(false);
        }
    }

    // 재귀 탐색 유틸리티 (하위 폴더까지 .md/.txt 파일 긁어옴)
    public _findBrainFiles(dir: string): string[] {
        return _hFindBrainFiles(dir);
    }

    // 목차(인덱스)만 생성 — 내용은 AI가 <read_brain>으로 직접 열람
    private _getSecondBrainContext(): string {
        return _hGetSecondBrainContext();
    }

    // AI가 <read_brain>태그로 요청한 파일의 실제 내용을 읽어서 반환
    private _readBrainFile(filename: string): string {
        return _hReadBrainFile(filename);
    }

    /** 저장된 대화 메시지를 웹뷰에 다시 전송 (복원) */
    private _restoreDisplayMessages() {
        if (!this._view || this._displayMessages.length === 0) { return; }
        this._view.webview.postMessage({
            type: 'restoreMessages',
            value: this._displayMessages
        });
    }

    // --------------------------------------------------------
    // v2.89.105 — Claude Code의 CLAUDE.md 호환 프로젝트 메모리 로더.
    // 워크스페이스 루트에 AGENT.md / AGENT-OS-AI.md / .agent-os-ai/instructions.md 가
    // 있으면 자동으로 시스템 프롬프트에 주입. 부모 디렉토리도 한 단계 거슬러
    // 올라가서 모노레포 root 메모리도 캡처. 없으면 빈 문자열.
    // 우선순위: 워크스페이스 root → 부모 → 홈(~/.agent-os-ai/global.md).
    // 한 파일당 8KB cap, 총 24KB cap. 같은 파일 중복 주입 방지.
    private _getProjectMemory(): string {
        return _hGetProjectMemory();
    }

    // Build workspace file tree + read key files
    // --------------------------------------------------------
    private _getWorkspaceContext(): string {
        return _hGetWorkspaceContext();
    }

    // --------------------------------------------------------
    // Handle prompt with file attachments (multimodal)
    // --------------------------------------------------------
    private async _handlePromptWithFile(prompt: string, modelName: string, files: {name: string, type: string, data: string}[], internetEnabled?: boolean) {
        if (!this._view) { return; }

        /* v2.90.1 — 이전 코드는 PDF·DOCX 같은 바이너리도 base64→utf-8 디코딩해서
           프롬프트 -p 인자에 박았음. PDF 깨진 문자열이 Claude CLI 입력을 망가뜨려
           "Failed to execute 'json' on 'Response'" 류 에러 발생 + ARG_MAX 초과 위험.
           이제 텍스트는 그대로 인라인, 바이너리/이미지는 OS 임시 디렉토리에 저장하고
           경로만 프롬프트에 노출 → Claude CLI 의 Read 도구가 직접 처리. */
        const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-yaml|x-sh|x-shellscript))/i;
        const TEXT_EXT = /\.(txt|md|markdown|json|xml|ya?ml|js|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|sh|bash|zsh|sql|html?|css|scss|less|env|toml|ini|conf|cfg|csv|tsv|log)$/i;
        const isTextFile = (f: {name:string,type:string}) =>
            TEXT_MIME.test(f.type || '') || TEXT_EXT.test(f.name || '');
        const isImage = (f: {name:string,type:string}) => (f.type || '').startsWith('image/');

        const tmpDir = path.join(os.tmpdir(), `agent-os-ai-upload-${Date.now()}-${Math.random().toString(36).slice(2,8)}`);
        const savedPaths: string[] = [];

        try {
            let fileContext = '';
            const inlineTextBlocks: string[] = [];
            const fileRefs: string[] = [];

            for (const f of files) {
                if (isTextFile(f) && !isImage(f)) {
                    const decoded = Buffer.from(f.data, 'base64').toString('utf-8');
                    inlineTextBlocks.push(`\n\n[첨부 파일: ${f.name}]\n\`\`\`\n${decoded.slice(0, 20000)}\n\`\`\``);
                } else {
                    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
                    const safeName = (f.name || 'file').replace(/[^\w.\-]+/g, '_').slice(0, MAX_FILE_NAME_LEN);
                    const p = path.join(tmpDir, safeName);
                    fs.writeFileSync(p, Buffer.from(f.data, 'base64'));
                    savedPaths.push(p);
                    const kind = isImage(f) ? '이미지' : (f.type || '바이너리');
                    fileRefs.push(`- ${f.name} (${kind}) → \`${p}\``);
                }
            }

            if (inlineTextBlocks.length) fileContext += inlineTextBlocks.join('');
            if (fileRefs.length) {
                fileContext += `\n\n[첨부된 파일이 디스크에 저장되었습니다. \`Read\` 도구로 아래 경로를 직접 읽어 분석하세요 (PDF·이미지·DOCX 지원):]\n${fileRefs.join('\n')}`;
            }

            const userContent = prompt + fileContext;
            this._chatHistory.push({ role: 'user', content: userContent });
            this._displayMessages.push({ text: prompt + (files.length > 0 ? `\n📎 ${files.map(f=>f.name).join(', ')}` : ''), role: 'user' });
            /* v2.90.1 — 전송 전에 히스토리 정리 (이전 PDF 깨진 잔재가 있으면 자름) */
            this._pruneHistory();

            const reqMessages = [...this._chatHistory];
            if (reqMessages.length > 0 && reqMessages[0].role === 'system') {
                const contextBlock = _hBuildActiveEditorContext(MAX_CONTEXT_SIZE);
                const workspaceCtx = this._getWorkspaceContext();
                const brainCtx = this._brainEnabled ? this._getSecondBrainContext() : '';
                const projectMemory = this._getProjectMemory();
                const internetCtx = internetEnabled
                    ? `\n\n[CRITICAL DIRECTIVE: INTERNET ACCESS IS ENABLED]\nCurrent Time: ${new Date().toLocaleString('ko-KR')}\nYou have FULL internet access via the <read_url> tool. You MUST NEVER say you cannot search, or that your capabilities are limited. To search, ALWAYS output:\n<read_url>https://html.duckduckgo.com/html/?q=YOUR+SEARCH+TERM</read_url>\nIf the user asks to search, or asks for recent info, DO NOT apologize. Just use the tag.`
                    : '';
                reqMessages[0] = {
                    role: 'system',
                    content: `${this._systemPrompt}${projectMemory}\n\n[BACKGROUND CONTEXT]\n${contextBlock}\n${workspaceCtx}\n${brainCtx}${internetCtx}`
                };
            }

            let aiMessage = '';
            this._view.webview.postMessage({ type: 'streamStart' });
            this._abortController = new AbortController();

            const tier: Tier = _modelToTier(modelName);
            const claudePrompt = _serializeMessages(reqMessages);
            await streamAsk(claudePrompt, tier, (token) => {
                if (this._abortController?.signal.aborted) return;
                aiMessage += token;
                this._view!.webview.postMessage({ type: 'streamChunk', value: token });
            });

            this._view.webview.postMessage({ type: 'streamEnd' });
            this._chatHistory.push({ role: 'assistant', content: aiMessage });

            const report = await this._executeActions(aiMessage);
            if (report.length > 0) {
                const reportMsg = `\n\n---\n**에이전트 작업 결과**\n${report.join('\n')}`;
                this._view.webview.postMessage({ type: 'streamChunk', value: reportMsg });
                this._view.webview.postMessage({ type: 'streamEnd' });
                aiMessage += reportMsg;
            }
            this._displayMessages.push({ text: this._stripActionTags(aiMessage), role: 'ai' });
            this._pruneHistory();
            this._saveHistory();

        } catch (error: any) {
            const msg = error?.message || String(error);
            const errMsg = _hClassifyChatError(msg);

            this._view.webview.postMessage({ type: 'error', value: errMsg });

            // Axios의 타입이 stream일 때 에러 본문을 파싱해서 원인을 명확히 로그에 남김
            if (error.response?.data?.on) {
                let buf = '';
                error.response.data.on('data', (c: any) => buf += c.toString());
                error.response.data.on('end', () => {
                    try {
                        const parsed = JSON.parse(buf);
                        if (parsed.error?.message) {
                            this._view!.webview.postMessage({ type: 'error', value: `⚠️ API 자세한 오류: ${parsed.error.message}` });
                        }
                    } catch { /* ignore parsing err */ }
                });
            }
        } finally {
            /* Claude CLI 가 -p 모드라 await 끝나면 자식 프로세스 종료된 상태 → 안전하게 정리. */
            for (const p of savedPaths) {
                try { fs.unlinkSync(p); } catch { /* gone is fine */ }
            }
            try { fs.rmdirSync(tmpDir); } catch { /* may not exist or non-empty */ }
        }
    }

    // --------------------------------------------------------
    // Handle user prompt → Ollama → agent actions → response
    // --------------------------------------------------------
    private async _handlePrompt(prompt: string, modelName: string, internetEnabled?: boolean) {
        if (!this._view) { return; }

        try {
            // 1. Context: active editor content
            const contextBlock = _hBuildActiveEditorContext(MAX_CONTEXT_SIZE);

            // 2. Context: workspace file tree + key file contents
            const workspaceCtx = this._getWorkspaceContext();
            
            // 2.5 Inject Second Brain Knowledge (ON/OFF 토글 반영)
            const brainCtx = this._brainEnabled ? this._getSecondBrainContext() : '';

            // 3. Push user message
            this._chatHistory.push({
                role: 'user',
                content: prompt
            });

            // 저장용: 유저 메시지 기록 (프롬프트만)
            this._displayMessages.push({ text: prompt, role: 'user' });

            const reqMessages = [...this._chatHistory];
            if (reqMessages.length > 0 && reqMessages[0].role === 'system') {
                const internetCtx = internetEnabled
                    ? `\n\n[CRITICAL DIRECTIVE: INTERNET ACCESS IS ENABLED]\nCurrent Time: ${new Date().toLocaleString('ko-KR')}\nYou have FULL internet access via the <read_url> tool. You MUST NEVER say you cannot search, or that your capabilities are limited. To search, ALWAYS output:\n<read_url>https://html.duckduckgo.com/html/?q=YOUR+SEARCH+TERM</read_url>\nIf the user asks to search, or asks for recent info, DO NOT apologize. Just use the tag.`
                    : '';
                reqMessages[0] = {
                    role: 'system',
                    content: `${this._systemPrompt}${this._getProjectMemory()}\n\n[BACKGROUND CONTEXT - DO NOT EXPLAIN THIS TO THE USER UNLESS ASKED]\n${contextBlock}\n${workspaceCtx}\n${brainCtx}${internetCtx}`
                };
            }

            let aiMessage = '';

            this._view.webview.postMessage({ type: 'streamStart' });
            this._lastPrompt = prompt;
            this._lastModel = modelName;
            this._abortController = new AbortController();

            if (this._shouldEmitThinking()) {
                this._postThinking({ type: 'thinking_start', prompt });
                this._postThinking({
                    type: 'context_done',
                    workspace: !!workspaceCtx,
                    brainCount: this._brainEnabled ? (brainCtx ? brainCtx.split('📄').length - 1 : 0) : 0,
                    web: !!internetEnabled
                });
            }

            const seenBrainReads = new Set<string>();
            const detectBrainReadsLive = () => {
                if (!this._shouldEmitThinking()) return;
                const matches = [...aiMessage.matchAll(/<read_brain>([\s\S]*?)<\/read_brain>/g)];
                for (const m of matches) {
                    const note = m[1].trim();
                    if (note && !seenBrainReads.has(note)) {
                        seenBrainReads.add(note);
                        this._postThinking({ type: 'brain_read', note });
                    }
                }
                const fileMatches = [...aiMessage.matchAll(/<(?:read_file|create_file|edit_file)\s+path="([^"]+)"/g)];
                for (const m of fileMatches) {
                    let note = m[1].trim();
                    if (note.includes('Company/')) {
                        note = note.split('Company/').pop() || note;
                    }
                    if (note && !seenBrainReads.has(note)) {
                        seenBrainReads.add(note);
                        this._postThinking({ type: 'brain_read', note });
                    }
                }
            };
            let answerStartFired = false;
            const fireAnswerStart = () => {
                if (this._shouldEmitThinking() && !answerStartFired) {
                    answerStartFired = true;
                    this._postThinking({ type: 'answer_start' });
                }
            };

            const tier: Tier = _modelToTier(modelName);
            const claudePrompt = _serializeMessages(reqMessages);
            await streamAsk(claudePrompt, tier, (token) => {
                if (this._abortController?.signal.aborted) return;
                aiMessage += token;
                this._view!.webview.postMessage({ type: 'streamChunk', value: token });
                detectBrainReadsLive();
                if (this._shouldEmitThinking()) {
                    fireAnswerStart();
                    this._postThinking({ type: 'answer_chunk', text: token });
                }
            });

            // 스트리밍 완료 알림 잠시 보류 (연속된 답변을 같은 상자에 이어서 출력하기 위함)
            
            // 4.5 자율 열람 (Second Brain 및 웹 검색): AI가 <read_brain> 또는 <read_url>을 사용했는지 확인
            const brainReads = [...aiMessage.matchAll(/<read_brain>([\s\S]*?)<\/read_brain>/g)];
            const urlReads = [...aiMessage.matchAll(/<read_url>([\s\S]*?)<\/read_url>/gi)];

            if (brainReads.length > 0 || urlReads.length > 0) {
                let fetchedContent = '';
                let uiFeedbackStr = '';
                
                // Brain 읽기 처리
                for (const match of brainReads) {
                    const requestedFile = match[1].trim();
                    const fileContent = this._readBrainFile(requestedFile);
                    fetchedContent += `\n\n[BRAIN DOCUMENT: ${requestedFile}]\n${fileContent}\n`;
                }

                // URL 읽기 처리
                for (const match of urlReads) {
                    const url = match[1].trim();
                    try {
                        const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 });
                        let cleaned = data.toString()
                            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                            .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
                            .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                        fetchedContent += `\n\n[WEB CONTENT: ${url}]\n${cleaned.slice(0, 15000)}\n`;
                        const msg = `\n\n> 🌐 **[웹 검색 완료]** ${url} (${cleaned.length}자)\n\n`;
                        uiFeedbackStr += msg;
                        this._view.webview.postMessage({ type: 'streamChunk', value: msg });
                    } catch (err: any) {
                        fetchedContent += `\n\n[WEB CONTENT: ${url}] (FAILED: ${err.message})\n`;
                        const msg = `\n\n> 🌐 **[웹 검색 실패]** ${url} - ${err.message}\n\n`;
                        uiFeedbackStr += msg;
                        this._view.webview.postMessage({ type: 'streamChunk', value: msg });
                    }
                }

                const cleanedResponse = aiMessage.replace(/<read_brain>[\s\S]*?<\/read_brain>/g, '')
                                                 .replace(/<read_url>[\s\S]*?<\/read_url>/gi, '').trim();
                
                if (brainReads.length > 0) {
                    const msg = `\n\n> 🧠 **[Second Brain 열람 완료]** 스캔한 핵심 지식을 바탕으로 답변을 구성합니다...\n\n`;
                    uiFeedbackStr += msg;
                    this._view.webview.postMessage({ type: 'streamChunk', value: msg });
                }
                
                reqMessages.push({ role: 'assistant', content: cleanedResponse || '탐색을 진행 중입니다...' });
                reqMessages.push({ role: 'user', content: `[SYSTEM: The following documents and web contents were retrieved based on your actions. Use this information to provide a complete and accurate answer to the user's original question.]\n${fetchedContent}\n\nNow answer the user's question using the above knowledge. Do NOT output <read_brain> or <read_url> again. Answer directly and comprehensively.` });

                aiMessage = cleanedResponse + uiFeedbackStr;

                if (this._shouldEmitThinking()) {
                    this._postThinking({ type: 'answer_start' });
                }

                const followUpPrompt = _serializeMessages(reqMessages);
                const followUpTier: Tier = _modelToTier(modelName);
                await streamAsk(followUpPrompt, followUpTier, (token) => {
                    if (this._abortController?.signal.aborted) return;
                    aiMessage += token;
                    this._view!.webview.postMessage({ type: 'streamChunk', value: token });
                    if (this._shouldEmitThinking()) {
                        this._postThinking({ type: 'answer_chunk', text: token });
                    }
                });
            }

            // 모든 스트리밍(1차 및 2차)이 끝난 후, 박스 포장 완료
            this._view.webview.postMessage({ type: 'streamEnd' });

            this._chatHistory.push({ role: 'assistant', content: aiMessage });

            // 5. Execute agent actions
            const report = await this._executeActions(aiMessage);

            // 6. Agent report 추가 (있을 때만)
            if (report.length > 0) {
                const reportMsg = `\n\n---\n**에이전트 작업 결과**\n${report.join('\n')}`;
                this._view.webview.postMessage({ type: 'streamChunk', value: reportMsg });
                this._view.webview.postMessage({ type: 'streamEnd' });
                aiMessage += reportMsg;
            }

            // 저장용: AI 응답 기록
            this._displayMessages.push({ text: this._stripActionTags(aiMessage), role: 'ai' });

            // 📚 Citation badges + 🎬 final source highlight
            const allBrainReads = [...aiMessage.matchAll(/<read_brain>([\s\S]*?)<\/read_brain>/g)]
                .map(m => m[1].trim()).filter(s => s.length > 0);
            const uniqueSources = [...new Set(allBrainReads)];
            if (uniqueSources.length > 0) {
                this._view.webview.postMessage({ type: 'attachCitations', sources: uniqueSources });
            }
            if (this._shouldEmitThinking()) {
                this._postThinking({ type: 'answer_complete', sources: uniqueSources });
            }

            this._pruneHistory();
            this._saveHistory();

        } catch (error: any) {
            const msg = error?.message || String(error);
            let errMsg: string;
            if (/ENOENT|not found/i.test(msg)) {
                errMsg = `⚠️ Claude CLI 를 찾지 못했어요.\n\`claude --version\` 으로 설치를 확인하거나 settings.json 의 \`agentOs.claudeBinPath\` 를 설정해주세요.`;
            } else if (/timed out|timeout/i.test(msg)) {
                errMsg = `⚠️ Claude 응답이 너무 오래 걸려요. 질문을 짧게 줄이거나 Claude Max 사용량 한도를 확인해주세요.`;
            } else if (/aborted/i.test(msg)) {
                errMsg = `⚠️ 응답이 중간에 취소됐어요.`;
            } else {
                errMsg = `⚠️ 오류: ${msg}`;
            }

            this._view.webview.postMessage({ type: 'error', value: errMsg });

            if (this._telegramMirrorPending) {
                sendTelegramReport(`⚠️ *AI 응답 실패*\n\n${errMsg.slice(0, 800)}`).catch(() => { /* silent */ });
                this._telegramMirrorPending = false;
            }
        } finally {
            /* If this prompt came from Telegram, mirror the AI response back. */
            this._maybeMirrorToTelegram().catch(() => { /* silent */ });
        }
    }

    /* v2.89.37 — 3단계 fallback. 사용자가 "내 유튜브 채널 분석" 같은 명백한 단일 도구
       요청을 했을 때, LLM 분류기만 의존하면 작은 모델이 `{}` 뱉어서 CEO 플래너로 폴백
       → CEO가 4명 동원해서 Designer가 무관한 시각 시스템 보고서 출력. 사용자 박살.

       이제 흐름:
         1) 패턴 매칭 (deterministic, 절대 실패 X) — 명백한 키워드면 즉시 도구 실행
         2) LLM 분류기 — 변형된 표현 ("subscriber 어때?", "내 유튜브 어떻게 됐냐") 캐치
         3) CEO 플래너 — 진짜 다중 에이전트 작업 ("영상 기획해줘", "썸네일 만들어")

       1·2 단계가 도구를 찾으면 그 도구만 실행하고 multi-agent 분배 전부 스킵. */
    private async _tryDataShortcut(prompt: string, sessionDir: string): Promise<boolean> {
        const p = (prompt || '').trim();
        if (!p) return false;

        /* v2.89.156 — 다중 도메인 종합 명령은 multi-agent 로 보냄.
           "유튜브 + 매출 + 종합 보고서" 같이 두 영역 동시 요청이면 단일 도구 shortcut 이
           무시하고 multi-agent dispatch (현빈 + 레오 둘 다) 가 잡도록 여기서 바로 false. */
        const lpEarly = p.toLowerCase();
        const hasYoutube = /유튜브|youtube|채널|구독|조회/.test(lpEarly);
        const hasRevenue = /매출|페이팔|paypal|수익|결제|매상/.test(lpEarly);
        const hasSummary = /종합|전체|현황|보고서|통합|요약/.test(lpEarly);
        if ((hasYoutube && hasRevenue) || (hasSummary && (hasYoutube || hasRevenue))) {
            return false;
        }

        /* 도구 카탈로그 (활성화된 것만, 두 단계가 공유) */
        const _BUILTIN_TOOLS = new Set(['google_calendar_write', 'google_calendar']);
        type CatalogEntry = { agentId: string; tool: string; description: string; scriptPath: string };
        const catalog: CatalogEntry[] = [];
        for (const aid of SPECIALIST_IDS) {
            try {
                const tools = listAgentTools(aid).filter(t => t.enabled && !_BUILTIN_TOOLS.has(t.name));
                for (const t of tools) {
                    /* v2.89.46 — listAgentTools가 t.name에서 .py 빼고 반환 ('my_videos_check').
                       카탈로그에는 실행 가능한 파일명 형태로 저장 ('my_videos_check.py') —
                       패턴의 tool 필드와 매칭 일관성 + python3 실행 시 그대로 인자 사용 가능. */
                    catalog.push({
                        agentId: aid,
                        tool: t.name + '.py',
                        description: (t.description || '').replace(/\n/g, ' ').slice(0, 120),
                        scriptPath: t.scriptPath,
                    });
                }
            } catch { /* skip agent on error */ }
        }
        if (catalog.length === 0) return false;

        /* === 1단계: 도메인 키워드 + 비창작 의도 매칭 (v2.89.48) ===
           이전엔 빡빡한 정규식이라 "유튜브붆석해" 같은 오타나 "유튜브 어때" 같은 변형을
           못 잡고 CEO 플래너로 떨어뜨림. 새 접근:
           - 도메인 키워드 (유튜브/채널/구독자/조회수 등) 등장 = YouTube 도구 후보
           - 사용자가 명백한 창작 동사 (만들/기획/디자인/스크립트 써)를 안 쓰면 = 분석 의도
           - 즉, 키워드 + 비창작 → my_videos_check.py 즉시 실행
           오타·변형·축약 다 흡수. 창작 명령은 CEO 플래너로 정상 라우팅. */
        type DomainShortcut = {
            agentId: string;
            tool: string;
            domainPattern: RegExp;
        };
        const domainShortcuts: DomainShortcut[] = [
            {
                agentId: 'youtube',
                tool: 'my_videos_check.py',
                domainPattern: /(?:유튜브|youtube|채널|구독자|조회수|시청자|시청\s*시간|내\s*영상|내\s*비디오|video\s*count|subscriber)/i,
            },
        ];
        /* 창작·기획 동사 — 이게 있으면 분석이 아니라 multi-agent 작업 (CEO 플래너로) */
        const creativePattern = /(?:만들|기획|디자인|썸네일\s*제작|썸네일\s*만들|스크립트\s*써|글\s*써|작성해|코딩|개발|제작|design|create|build|make|write|generate|plan)/i;
        const isCreative = creativePattern.test(p);
        const lower = p.toLowerCase();
        const domainMatch = !isCreative && domainShortcuts.find(d =>
            d.domainPattern.test(lower) &&
            catalog.some(c => c.agentId === d.agentId && c.tool === d.tool)
        );
        if (domainMatch) {
            const entry = catalog.find(c => c.agentId === domainMatch.agentId && c.tool === domainMatch.tool)!;
            return await this._runShortcutTool(entry, prompt, sessionDir, '키워드');
        }

        /* === 2단계: LLM 분류기 ===
           패턴이 못 잡은 변형 표현을 LLM이 의미로 해석. 짧은 프롬프트라 작은 모델도
           대체로 잘 따름. 실패 시 그냥 false → CEO 플래너로. */
        const classifierPrompt = `당신은 사용자 명령에 가장 잘 맞는 도구를 1개 고르는 분류기입니다.

[사용 가능한 도구]
${catalog.map((c, i) => `${i + 1}. agent=${c.agentId} tool=${c.tool} — ${c.description}`).join('\n')}

[규칙]
- 사용자 명령이 위 도구 중 1개와 명확히 매칭되면 \`{"agent": "...", "tool": "..."}\` 출력
- 매칭 안 되거나 애매·일반 작업(콘텐츠 제작·디자인·코딩 등)이면 \`{}\` 출력
- agent/tool 이름은 위 목록에서 정확히 복사 (스펠링 변형 금지)
- ⚠️ JSON 외 텍스트(설명·펜스·머리말) 절대 금지`;

        const classifierModel = getAgentModel('ceo', '');
        let classifyRaw = '';
        try {
            classifyRaw = await this._callAgentLLM(
                classifierPrompt,
                `[사용자 명령]\n${p}`,
                classifierModel,
                'ceo',
                false,
            );
        } catch {
            return false; /* LLM 실패 → CEO 플래너 */
        }

        let parsed: { agent?: string; tool?: string } | null = null;
        try {
            const m = classifyRaw.match(/\{[\s\S]*?\}/);
            parsed = m ? JSON.parse(m[0]) : null;
        } catch { parsed = null; }
        if (!parsed || !parsed.agent || !parsed.tool) return false;

        const llmEntry = catalog.find(c => c.agentId === parsed!.agent && c.tool === parsed!.tool);
        if (!llmEntry) return false;

        return await this._runShortcutTool(llmEntry, prompt, sessionDir, '분류기');
    }

    /* 도구 1개를 직접 실행하고 결과를 채팅창에 출력. multi-agent 분배·CEO 보고서 다 스킵.
       source 인자는 어떤 단계에서 매칭됐는지 사용자에게 보여주기 위함 ('패턴' or '분류기'). */
    private async _runShortcutTool(
        entry: { agentId: string; tool: string; scriptPath: string },
        prompt: string,
        sessionDir: string,
        source: string,
    ): Promise<boolean> {
        const post = (m: any) => this._broadcastCorporate(m);
        const a = AGENTS[entry.agentId];
        const toolsDir = path.dirname(entry.scriptPath);

        /* === 1단계: 도구 실행 (데이터 수집) === */
        post({ type: 'agentStart', agent: entry.agentId, task: `${entry.tool} 데이터 수집` });
        post({ type: 'response', value: `🔧 ${a.emoji} ${a.name}: \`${entry.tool}\` 실행 중...` });
        let r: { exitCode: number; output: string; timedOut: boolean };
        try {
            /* v2.89.50 — stdout만 캡쳐. stderr (진행 메시지·DeprecationWarning) 채팅에 안 끼게. */
            r = await runCommandCaptured(`${_pythonCmd()} ${JSON.stringify(entry.tool)}`, toolsDir, () => {}, 90000, 'stdout');
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
            const body = `${a.emoji} **${a.name}** — \`${entry.tool}\` 실행 실패\n\n\`\`\`\n${toolOut || '(출력 없음)'}\n\`\`\`\n\n_${toolStatus}_\n\n${hint}`;
            this._displayMessages.push({ text: body, role: 'ai' });
            post({ type: 'response', value: body });
            appendConversationLog({ speaker: a.name, emoji: a.emoji, section: `도구 실행 (${source})`, body: `${entry.tool} 실패: ${toolOut.slice(0, 500)}` });
            return true;
        }

        /* "분석" 의도가 명시적이지 않으면 (예: "내 채널 데이터 보여줘") LLM 분석 스킵하고
           원본 데이터만. 의도 단어 있으면 (분석/어때/평가/검토 등) 2단계 LLM chain 발동. */
        const wantsAnalysis = /(분석|어때|어떻게|평가|검토|좋|안\s*좋|개선|문제|왜|뭐\s*해야|추천|제안|전략|review|analyze|assess|evaluate)/i.test(prompt);
        if (!wantsAnalysis) {
            const body = `${a.emoji} **${a.name}** — \`${entry.tool}\` 결과\n\n\`\`\`\n${toolOut.slice(0, 6000)}\n\`\`\`\n\n_${toolStatus} · 데이터만 출력했습니다. 분석이 필요하면 "분석해줘"·"어때"·"평가해줘" 같이 분석 동사를 붙여주세요._`;
            this._displayMessages.push({ text: body, role: 'ai' });
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
            specialistAnalysis = await this._callAgentLLM(
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
                ceoSummary = await this._callAgentLLM(ceoSysPrompt, ceoUserMsg, ceoModel, 'ceo', false);
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

        this._displayMessages.push({ text: body, role: 'ai' });
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

    // --------------------------------------------------------
    // 1인 기업 모드 — Multi-Agent Orchestration
    // --------------------------------------------------------
    // CEO 에이전트가 사용자 한 줄 명령을 받아 작업을 분해하고,
    // 전문 에이전트들에게 순차로 일을 분배합니다. 각 에이전트는
    // 공동 목표·정체성·자기 메모리를 매번 읽고 작업합니다.
    // --------------------------------------------------------
    private async _handleCorporatePrompt(prompt: string, modelName: string) {
        /* v2.88.4 — 이전 가드 `if (!this._view && this._corporateBroadcastTargets.size === 0) return;`
           는 사이드바도 안 열려있고 사무실 패널도 없으면 즉시 return해서, 텔레그램에서
           디스패치 명령이 와도 아무것도 실행 안 했음. UI 업데이트는 실패해도 OK
           (텔레그램이 출구) — 디스패치 자체는 무조건 실행되어야 함. */
        const post = (m: any) => this._broadcastCorporate(m);
        // Single abort controller drives every LLM call in this session — sidebar
        // stop button calls _abortController.abort() which propagates through.
        this._abortController = new AbortController();
        const isAborted = () => !!this._abortController?.signal.aborted;
        try {
            ensureCompanyStructure();
            const sessionDir = makeSessionDir();
            const sessionDisplay = sessionDir.replace(os.homedir(), '~');

            this._displayMessages.push({ text: prompt, role: 'user' });

            // Phase 1: log the user command at the top of every session
            appendConversationLog({ speaker: '사용자', emoji: '👤', body: prompt });

            // Bridge mode 'full' — Secretary is the single front door. Triage
            // the message: either Secretary handles it directly (greeting,
            // schedule lookup) or escalates to CEO. This puts sidebar in the
            // same shape as Telegram so all user input flows through one
            // consistent entry. Educational toggle — see readSecretaryBridgeMode.
            const bridgeMode = readSecretaryBridgeMode();
            if (bridgeMode === 'full') {
                post({ type: 'agentStart', agent: 'secretary', task: '브릿지 분류' });
                let triageRaw = '';
                try {
                    triageRaw = await this._callAgentLLM(
                        `${SECRETARY_TRIAGE_PROMPT}\n${readAgentSharedContext('secretary')}${readRecentConversations(800)}`,
                        prompt,
                        modelName,
                        'secretary',
                        false
                    );
                } catch (e: any) {
                    /* Bridge fail-open — if Secretary triage errors we fall
                       through to the normal CEO planner so the user isn't
                       blocked. Log the error in conversation log for visibility. */
                    appendConversationLog({ speaker: '비서', emoji: '⚠️', body: `브릿지 분류 실패 → CEO로 직행: ${e?.message || e}` });
                }
                post({ type: 'agentEnd', agent: 'secretary' });
                let triage: { mode?: string; text?: string } | null = null;
                try {
                    const m = triageRaw.match(/\{[\s\S]*\}/);
                    triage = m ? JSON.parse(m[0]) : null;
                } catch { triage = null; }
                if (triage && triage.mode === 'reply') {
                    const text = (triage.text || '').trim() || '네, 사장님. 더 자세히 말씀해 주세요.';
                    const wrapped = `📱 비서: ${text}`;
                    this._displayMessages.push({ text: wrapped, role: 'ai' });
                    post({ type: 'response', value: wrapped });
                    appendConversationLog({ speaker: '비서', emoji: '📱', section: '브릿지(직접 응답)', body: text });
                    try { await this._maybeMirrorToTelegram(); } catch { /* ignore */ }
                    return;
                }
                /* triage.mode === 'dispatch' or parse failure → continue to
                   CEO planner. Optional ack so user knows Secretary saw it. */
                appendConversationLog({ speaker: '비서', emoji: '📱', section: '브릿지(CEO에게 위임)', body: '작업이라 CEO에게 분배 요청' });
            }

            // Casual-chat fast path — short greetings like "안녕" must NOT enter
            // the JSON planner. Small models reply with a friendly greeting
            // (no JSON), parsing fails, user sees a confusing context-length
            // error even after they've already widened the context. Detect
            // and route casual turns to a plain conversational CEO reply.
            // Skipped in bridge='full' since Secretary already triaged above.
            if (bridgeMode !== 'full' && _isCasualChat(prompt)) {
                post({ type: 'agentStart', agent: 'ceo', task: '인사' });
                let chatReply = '';
                try {
                    chatReply = await this._callAgentLLM(
                        `${_personalizePrompt(CEO_CHAT_PROMPT)}\n${readAgentSharedContext('ceo')}${readRecentConversations(800)}`,
                        prompt,
                        modelName,
                        'ceo',
                        true
                    );
                } catch (e: any) {
                    post({ type: 'agentEnd', agent: 'ceo' });
                    post({ type: 'error', value: `⚠️ CEO 응답 실패: ${e?.message || e}` });
                    return;
                }
                post({ type: 'agentEnd', agent: 'ceo' });
                const streamed = (chatReply || '').trim();
                const text = streamed || '안녕하세요, 사장님. 무엇을 도와드릴까요?';
                /* 스트리밍이 토큰을 한 글자도 못 받았으면 (LM Studio reasoning-only 모델이
                   delta.reasoning_content만 내보내고 delta.content는 빈 채로 끝나는 케이스 등)
                   webview에 아무것도 안 그려진 상태라 사용자는 "무응답"으로 봄. fallback 텍스트
                   를 명시적으로 보내서 빈 응답일 때 화면이 비지 않게 함. */
                if (!streamed) {
                    post({ type: 'response', value: text });
                }
                /* v2.89.100 — 캐주얼 챗 응답에 파일 액션 태그가 들어있으면 실행. 이전엔
                   text에 <list_files .../> 같은 태그가 raw로 출력만 되고 실제 동작 0이라
                   사용자가 "왜 안 돼?" → 정답은 "여기서 안 부르고 있었음". */
                try {
                    const fileReport = await this._executeActions(text, { silent: true });
                    if (fileReport.length > 0) {
                        const reportMsg = `\n\n---\n**작업 결과**\n${fileReport.join('\n')}`;
                        post({ type: 'response', value: reportMsg });
                        appendConversationLog({ speaker: '시스템', emoji: '📁', body: fileReport.join('\n') });
                    }
                } catch (actErr: any) {
                    console.error('[Agent OS] casual-chat 파일 액션 실패:', actErr?.message || actErr);
                }
                this._displayMessages.push({ text: this._stripActionTags(text), role: 'ai' });
                appendConversationLog({ speaker: 'CEO', emoji: '👔', body: text });
                try { await this._maybeMirrorToTelegram(); } catch { /* ignore */ }
                return;
            }

            /* v2.89.40 — 단축회로. 도구 1개로 답이 나오는 명령(예: "내 유튜브 채널 분석")은
               여기서 도구 직접 실행하고 종료. 매칭 실패 시 일반 multi-agent 흐름으로 떨어짐 —
               CEO 플래너 프롬프트의 "단일 에이전트 우선" 규칙 + 환각 가드 + 스트림 타임아웃이
               헛소리·hang을 막음. v2.89.38의 "info면 무조건 차단" 로직은 너무 과했어서 제거. */
            const shortcut = await this._tryDataShortcut(prompt, sessionDir);
            if (shortcut) {
                try { await this._maybeMirrorToTelegram(); } catch { /* ignore */ }
                return;
            }

            // 1) CEO에게 작업 분해 요청 (silent — UI에는 카드 펄스만)
            // Phase 2: inject recent conversation history into CEO context so
            // planning is aware of what the company has been doing.
            /* v2.89.132 — 명시적 호출 감지. "코다리야 …" 처럼 사용자가 직접 이름 부르면
               CEO LLM 호출 건너뛰고 그 에이전트만 단독 dispatch. 30초 vs 11분 차이. */
            const explicit = this._detectExplicitMention(prompt);
            if (explicit) {
                post({ type: 'agentStart', agent: 'ceo', task: `${explicit.agentName} 직접 호출 — CEO 우회` });
                _updateActiveDispatchStep(prompt, `${explicit.agentName} 직접 호출`);
            } else {
                post({ type: 'agentStart', agent: 'ceo', task: '작업 분해' });
                _updateActiveDispatchStep(prompt, 'CEO 계획 수립 중');
            }
            let planRaw = '';
            /* v2.89.96 — 단계별 system prompt 빌드 + 각 단계 가드. 어느 단계가
               'Maximum call stack' 던지는지 정확히 표시 → 사용자/우리가 즉시 진단. */
            let ceoSystemPrompt = '';
            let ceoStage = 'init';
            try {
                ceoStage = '_personalizePrompt';
                let base = _personalizePrompt(CEO_PLANNER_PROMPT);
                /* v2.89.103+107 — 채용·활성 게이트. 다음 에이전트는 CEO 팀 명단에서 제외:
                   - LOCKED 미채용 (Luna PIN 안 풀림)
                   - OPTIONAL 비활성 (사용자가 토글 OFF)
                   각각 다른 안내 문구로 CEO에게 알림. */
                try {
                    const unavailableIds: string[] = [];
                    const reasons: Record<string, string> = {};
                    for (const id of AGENT_ORDER) {
                        if (id === 'ceo') continue;
                        if (!isAgentActive(id)) {
                            unavailableIds.push(id);
                            reasons[id] = LOCKED_AGENTS_DEFAULT[id] ? '아직 채용 전 (PIN 미입력)' : '사용자가 비활성화함';
                        }
                    }
                    if (unavailableIds.length > 0) {
                        const labels = unavailableIds.map(id => `${AGENTS[id]?.emoji || ''} ${AGENTS[id]?.name || id} (${id}: ${reasons[id]})`).join(', ');
                        for (const uid of unavailableIds) {
                            const re = new RegExp(`^- ${uid}\\b.*$`, 'gm');
                            base = base.replace(re, '');
                        }
                        base += `\n\n[활성 게이트] 다음 에이전트는 현재 사용 불가 — 절대 tasks 배열에 넣지 마세요: ${labels}\n`;
                    }
                } catch (gateErr: any) {
                    console.error('[Agent OS] 활성 게이트 적용 실패:', gateErr?.message || gateErr);
                }
                ceoStage = 'readAgentSharedContext';
                let shared = '';
                try { shared = readAgentSharedContext('ceo'); }
                catch (sc: any) {
                    /* 두뇌 RAG 등이 폭주해도 CEO 호출은 계속 — 컨텍스트 일부 누락한 채 진행. */
                    console.error('[Agent OS] readAgentSharedContext 실패, 빈 컨텍스트로 계속:', sc?.message || sc);
                    shared = '';
                }
                ceoStage = 'readRecentConversations';
                let recent = '';
                try { recent = readRecentConversations(2000); }
                catch (rc: any) {
                    console.error('[Agent OS] readRecentConversations 실패:', rc?.message || rc);
                    recent = '';
                }
                ceoSystemPrompt = `${base}\n${shared}${recent}`;
                /* 시스템 프롬프트가 너무 크면 컨텍스트 폭주 위험 — 50KB 초과 시 잘라냄. */
                if (ceoSystemPrompt.length > 50_000) {
                    ceoSystemPrompt = ceoSystemPrompt.slice(0, 50_000) + '\n[…컨텍스트 50KB 캡 도달, 일부 절단됨…]';
                }
                ceoStage = '_callAgentLLM';
            } catch (buildErr: any) {
                post({ type: 'agentEnd', agent: 'ceo' });
                const stk = buildErr?.stack ? String(buildErr.stack).split('\n').slice(0, 3).join(' | ').slice(0, 300) : '';
                post({ type: 'error', value: `⚠️ CEO 시스템 프롬프트 빌드 실패 (${ceoStage}): ${buildErr?.message || buildErr}\n[stack] ${stk}` });
                return;
            }
            try {
                /* v2.89.132 — 명시적 호출이면 LLM 안 거치고 직접 plan JSON 생성. */
                if (explicit) {
                    planRaw = JSON.stringify({
                        brief: `사용자가 ${explicit.agentName}를 직접 호출 — 단독 작업`,
                        tasks: [{ agent: explicit.agentId, task: prompt }]
                    });
                } else {
                    /* v2.89.147 — 종합 보고서 패턴 감지 시 CEO LLM 우회.
                       "유튜브 + 매출" 같이 여러 데이터 영역 동시 요청 시 작은 LLM 이
                       "유튜브 1명만" 규칙에 빠져 한쪽 무시하던 버그 차단. */
                    const lp = prompt.toLowerCase();
                    const wantsYoutube = /유튜브|youtube|채널|영상|구독|조회/.test(lp);
                    const wantsRevenue = /매출|페이팔|paypal|수익|결제|매상|돈|이번 ?달/.test(lp);
                    const isSummary = /종합|전체|현황|보고서|통합|요약|회사 ?(상황|현황)/.test(lp);
                    if (isSummary && wantsYoutube && wantsRevenue) {
                        planRaw = JSON.stringify({
                            brief: '유튜브 채널 + PayPal 매출 종합 분석',
                            tasks: [
                                { agent: 'youtube', task: `${prompt}\n\n[지시] 채널 데이터를 분석하고 다음 영상 전략 1개 제안.` },
                                { agent: 'business', task: `${prompt}\n\n[지시] PayPal 매출을 분석하고 다음 액션 1개 제안.` }
                            ]
                        });
                    } else if (wantsYoutube && wantsRevenue) {
                        /* 종합 키워드 없이도 두 영역 같이 요청하면 multi-agent. */
                        planRaw = JSON.stringify({
                            brief: '유튜브 + 매출 데이터 같이 분석',
                            tasks: [
                                { agent: 'youtube', task: prompt },
                                { agent: 'business', task: prompt }
                            ]
                        });
                    } else {
                        planRaw = await this._callAgentLLM(
                            ceoSystemPrompt,
                            `[사용자 명령]\n${prompt}`,
                            modelName,
                            'ceo',
                            false,
                            { jsonMode: true }
                        );
                    }
                }
            } catch (e: any) {
                post({ type: 'agentEnd', agent: 'ceo' });
                // Pull server-side error detail out of the axios stream response so
                // 500s don't surface as the bare "Request failed with status code 500".
                let detail = '';
                try {
                    if (e?.response?.data?.on) {
                        const buf = await new Promise<string>((resolve) => {
                            let acc = '';
                            e.response.data.on('data', (c: Buffer) => { acc += c.toString(); });
                            e.response.data.on('end', () => resolve(acc));
                            e.response.data.on('error', () => resolve(acc));
                        });
                        try { detail = JSON.parse(buf).error?.message || JSON.parse(buf).error || buf.slice(0, 300); }
                        catch { detail = buf.slice(0, 300); }
                    } else if (e?.response?.data) {
                        detail = typeof e.response.data === 'string' ? e.response.data.slice(0, 300) : JSON.stringify(e.response.data).slice(0, 300);
                    }
                } catch { /* ignore */ }
                let hint = '';
                if (/context length|context_length|num_ctx|maximum context/i.test(detail)) {
                    hint = '\n💡 컨텍스트 초과 — 더 큰 모델로 바꾸거나 회사 폴더의 _shared/decisions.md / _agents/ceo/memory.md를 줄여주세요.';
                } else if (/out of memory|cuda|allocation|vram/i.test(detail)) {
                    hint = '\n💡 메모리 부족 — 작은 모델 사용 또는 다른 무거운 앱 종료 후 재시도.';
                } else if (/ENOENT|not found/i.test(detail) || /ENOENT|not found/i.test(String(e?.message || ''))) {
                    hint = '\n💡 Claude CLI 를 찾지 못했어요. `claude --version` 으로 설치 확인 또는 settings.json 의 `agentOs.claudeBinPath` 설정.';
                } else if (/timed out|timeout/i.test(detail)) {
                    hint = '\n💡 Claude 응답이 시간 초과. Claude Max 5시간 윈도우 사용량이 거의 다 찼는지 확인하거나 잠시 뒤 재시도.';
                }
                /* v2.89.95 — 디버그 보강. 'Maximum call stack' 같은 런타임 에러는
                   원인 추적을 위해 스택 첫 줄도 함께 노출 (사용자 신고 시 정확한 위치 확인). */
                const stackTop = e?.stack ? String(e.stack).split('\n').slice(0, 3).join(' | ').slice(0, 300) : '';
                post({ type: 'error', value: `⚠️ CEO 호출 실패: ${e.message}${detail ? '\n원인: ' + detail : ''}${stackTop ? '\n[stack] ' + stackTop : ''}${hint}` });
                return;
            }
            post({ type: 'agentEnd', agent: 'ceo' });

            // 2) JSON 파싱 — 4단계 관대한 파이프라인.
            // (a) 노이즈 제거(소형 양자화 모델이 토하는 <span> 류 HTML 잡음)
            // (b) 견고한 balanced extractor (_extractFirstJsonObject)
            // (c) 잘린 JSON → 정규식으로 task 항목만이라도 회수
            // (d) 그래도 비면 jsonMode + 슬림 컨텍스트로 1회 자동 재시도
            type Plan = { brief: string; tasks: { agent: string; task: string }[] };
            const _parsePlan = (raw: string): Plan | null => {
                if (!raw) return null;
                /* (a) HTML/XML 잡음 제거 — `="num">2026</span>` 같은 토크나이저 사고. */
                const cleaned = raw.replace(/<\/?[a-zA-Z][^>]*>/g, '').replace(/="[a-zA-Z0-9_-]+">/g, '');
                /* (b) balanced extractor */
                const obj = _extractFirstJsonObject(cleaned);
                if (obj && Array.isArray(obj.tasks) && obj.tasks.length > 0) {
                    return { brief: String(obj.brief || ''), tasks: obj.tasks };
                }
                /* (c) 잘린 JSON 복구 — agent/task 쌍을 직접 추출 */
                const tasks: { agent: string; task: string }[] = [];
                const re = /"agent"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*,\s*"task"\s*:\s*"((?:[^"\\]|\\.)*?)(?:"|$)/g;
                let mm: RegExpExecArray | null;
                while ((mm = re.exec(cleaned))) {
                    const agent = mm[1].trim();
                    const task = mm[2].replace(/\\n/g, '\n').replace(/\\"/g, '"').trim();
                    if (agent && task) tasks.push({ agent, task });
                }
                if (tasks.length > 0) {
                    const briefM = cleaned.match(/"brief"\s*:\s*"((?:[^"\\]|\\.)*?)(?:"|$)/);
                    const brief = briefM ? briefM[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').trim() : '';
                    return { brief, tasks };
                }
                return null;
            };
            let plan: Plan | null = _parsePlan(planRaw);

            /* (d) 1회 자동 재시도 — 회사 컨텍스트 빼고 더 강한 JSON 지시로. */
            if (!plan) {
                try { _activeChatProvider?.postSystemNote?.('CEO 첫 응답 파싱 실패 — JSON 모드로 1회 재시도', '🔄'); } catch { /* ignore */ }
                try {
                    const retryRaw = await this._callAgentLLM(
                        `${_personalizePrompt(CEO_PLANNER_PROMPT)}\n\n[중요] 오직 JSON 한 객체만 출력. 설명/주석/마크다운 금지. 형식: {"brief":"…","tasks":[{"agent":"<id>","task":"…"}]}`,
                        `[사용자 명령]\n${prompt}`,
                        modelName,
                        'ceo',
                        false,
                        { jsonMode: true }
                    );
                    plan = _parsePlan(retryRaw);
                    if (plan) planRaw = retryRaw;
                } catch { /* fall through to error */ }
            }

            if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
                const openBraces = (planRaw.match(/\{/g) || []).length;
                const closeBraces = (planRaw.match(/\}/g) || []).length;
                const looksTruncated = openBraces > closeBraces || planRaw.length < 50 || !/\{/.test(planRaw);
                const hint = looksTruncated
                    ? '\n\n💡 Claude 응답이 중간에 잘린 듯해요:'
                    + '\n  1) 회사 폴더 `_shared/decisions.md` / `_agents/ceo/memory.md` 길이를 줄여서 프롬프트 크기 축소'
                    + '\n  2) Claude Max 사용량 한도(5시간 윈도우) 확인'
                    + '\n  3) `claude --version` 으로 CLI 정상 작동 확인'
                    : '\n\n💡 Claude 가 JSON 형식 지시를 못 따랐어요:'
                    + '\n  1) 잠시 뒤 재시도 (간헐적 모델 흔들림)'
                    + '\n  2) CEO 에이전트를 Opus tier 로 올려보기 (에이전트 도크)';
                post({
                    type: 'error',
                    value: `⚠️ CEO가 작업 분배 계획(JSON)을 생성하지 못했어요.${hint}\n\n원본 응답:\n${planRaw.slice(0, 400)}`
                });
                return;
            }
            // 유효한 에이전트만 필터 — 모델이 케이스/공백/한글명을 섞어 보낼 수 있으니
            // 관대하게 매칭. 영문 id 정확매칭 → 소문자/trim → 한글이름·영문이름 부분일치 순.
            const idLookup = new Map<string, string>();
            for (const id of SPECIALIST_IDS) {
                idLookup.set(id, id);
                idLookup.set(id.toLowerCase(), id);
                const a = AGENTS[id];
                if (a) {
                    idLookup.set(a.name.toLowerCase(), id);
                    idLookup.set(a.name, id);
                }
            }
            const koreanAlias: Record<string, string> = {
                '유튜브': 'youtube', '인스타': 'instagram', '인스타그램': 'instagram',
                '디자이너': 'designer', '디자인': 'designer',
                '개발자': 'developer', '개발': 'developer',
                '비즈니스': 'business', '경영': 'business',
                '비서': 'secretary', '비서관': 'secretary',
                '편집자': 'editor', '편집': 'editor',
                '작가': 'writer', '카피라이터': 'writer',
                '리서처': 'researcher', '연구원': 'researcher', '리서치': 'researcher',
            };
            const originalTasks = [...plan.tasks];
            plan.tasks = plan.tasks
                .map(t => {
                    const raw = String(t.agent || '').trim();
                    const direct = idLookup.get(raw) || idLookup.get(raw.toLowerCase());
                    if (direct) return { ...t, agent: direct };
                    if (koreanAlias[raw]) return { ...t, agent: koreanAlias[raw] };
                    // partial: any specialist id that appears as substring
                    const lower = raw.toLowerCase();
                    const hit = SPECIALIST_IDS.find(id => lower.includes(id));
                    if (hit) return { ...t, agent: hit };
                    return null;
                })
                .filter((t): t is { agent: string; task: string } => !!t);
            /* v2.89.103+107 — 채용·활성 게이트 backend 보호. CEO가 프롬프트 무시하고
               비활성 에이전트(Luna 미채용 또는 OPTIONAL 비활성)에 task 배정해도 여기서 제거. */
            const droppedTasks: { agent: string; task: string; reason: string }[] = [];
            plan.tasks = plan.tasks.filter(t => {
                if (!isAgentActive(t.agent)) {
                    const reason = LOCKED_AGENTS_DEFAULT[t.agent]
                        ? '채용 전 (PIN 필요)'
                        : '비활성 상태 (사용자가 OFF로 둠)';
                    droppedTasks.push({ ...t, reason });
                    return false;
                }
                return true;
            });
            if (droppedTasks.length > 0) {
                const droppedSummary = droppedTasks.map(t => `${AGENTS[t.agent]?.emoji || ''} ${AGENTS[t.agent]?.name || t.agent} (${t.reason})`).join(', ');
                post({ type: 'systemNote', value: `🔒 다음 에이전트는 사용 불가라 제외됐어요: ${droppedSummary}\n👥 직원 패널에서 활성화 후 다시 시도하세요.` });
            }
            if (plan.tasks.length === 0) {
                const wantedIds = originalTasks.map(t => `"${t.agent}"`).join(', ');
                if (droppedTasks.length > 0) {
                    post({ type: 'error', value: `⚠️ CEO가 비활성 에이전트만 호출했어요. 직원 패널에서 활성화 후 다시 시도해주세요.` });
                } else {
                    post({
                        type: 'error',
                        value: `⚠️ CEO가 호출한 에이전트(${wantedIds || '없음'})가 우리 팀에 없어요.\n사용 가능한 id: ${SPECIALIST_IDS.join(', ')}\n\nCEO 원본 응답 일부:\n${(planRaw || '').slice(0, 300)}`
                    });
                }
                return;
            }

            // brief 저장
            try {
                fs.writeFileSync(
                    path.join(sessionDir, '_brief.md'),
                    `# 📋 작업 브리프\n\n**원 명령:** ${prompt}\n\n## 요약\n${plan.brief}\n\n## 분배\n${plan.tasks.map(t => `- **${AGENTS[t.agent]?.emoji} ${AGENTS[t.agent]?.name}**: ${t.task}`).join('\n')}\n`
                );
            } catch { /* ignore */ }

            /* v2.89.148 — 가상 사무실 시각적 협업 동기화.
               dispatch 시점에 멀티 에이전트 dispatch 이벤트 broadcast →
               office view 가 CEO → specialist 화살표 + 각 책상 task 말풍선 + 펄스. */
            try {
                this._broadcastCorporate({
                    type: 'multiDispatch',
                    brief: plan.brief,
                    tasks: plan.tasks.map(t => ({
                        agent: t.agent,
                        emoji: AGENTS[t.agent]?.emoji || '🤖',
                        name: AGENTS[t.agent]?.name || t.agent,
                        task: (t.task || '').slice(0, 80),
                    }))
                });
            } catch { /* ignore */ }

            // 3) 시네마틱 분배 알림
            post({
                type: 'agentDispatch',
                brief: plan.brief,
                tasks: plan.tasks.map(t => ({ agent: t.agent, task: t.task })),
                userPrompt: prompt
            });

            // Phase 1: log CEO's brief + assignment
            appendConversationLog({
                speaker: 'CEO', emoji: '🧭', section: '작업 분배',
                body: `${plan.brief}\n\n**할당:**\n${plan.tasks.map(t => `- ${AGENTS[t.agent]?.emoji || '🤖'} **${AGENTS[t.agent]?.name || t.agent}**: ${t.task}`).join('\n')}`,
            });

            // 4) 각 specialist 순차 호출 — extracted to src/chat/corporate/specialist-loop.ts.
            //    Behavior preserved byte-for-byte; the loop body lives there now and runs
            //    against an explicit CorporateContext so we don't drag the entire
            //    SidebarChatProvider `this` into the helper.
            const corpCtx: CorporateContext = {
                post,
                broadcastCorporate: (m) => this._broadcastCorporate(m),
                isAborted,
                setTelegramMirrorPending: (v) => { this._telegramMirrorPending = v; },
                getTelegramMirrorPending: () => this._telegramMirrorPending,
                callAgentLLM: (sp, um, mn, ag, br, opts) => this._callAgentLLM(sp, um, mn, ag, br, opts),
                executeActions: (msg, opts) => this._executeActions(msg, opts),
                buildRecentFilesContext: (id) => this._buildRecentFilesContext(id),
                getProjectMemory: () => this._getProjectMemory(),
                tryKitShortcut: (id, p) => this._tryKitShortcut(id, p),
                tryRevenueShortcut: (p) => this._tryRevenueShortcut(p),
            };
            const __loopResult = await runSpecialistLoop({
                ctx: corpCtx,
                plan: plan as CorporatePlan,
                prompt,
                modelName,
                sessionDir,
                explicit,
            });
            const outputs = __loopResult.outputs;
            const agentMeta = __loopResult.agentMeta;
            if (__loopResult.earlyReturn) {
                /* LLM 호출 도중 사용자가 abort 했거나 fatal 한 케이스 — 후속 phase
                   skip 하고 사이드바를 streamEnd 로 풀어주는 finally 로 직행. */
                return;
            }
            /* __loopResult.blocked (OAuth trigger / credentials block) 케이스도
               원본 코드와 동일하게 confer/report/decisions phase 까지 그대로 진행.
               specialist-loop 안에서 이미 plan.tasks 잘라뒀고 텔레그램 통보 끝났음. */

            if (isAborted()) {
                post({ type: 'error', value: '🛑 사용자가 중단했어요.' });
                return;
            }
            // 4.5) 에이전트 간 자율 대화 (Confer) — extracted to src/chat/corporate/confer-phase.ts.
            const conferTurns = await runConferPhase({
                ctx: corpCtx,
                plan: plan as CorporatePlan,
                prompt,
                modelName,
                outputs,
            });

            if (isAborted()) {
                post({ type: 'error', value: '🛑 사용자가 중단했어요.' });
                return;
            }
            // 5) CEO 종합 보고서 — extracted to src/chat/corporate/report-phase.ts.
            const finalReport = await runReportPhase({
                ctx: corpCtx,
                plan: plan as CorporatePlan,
                prompt,
                modelName,
                outputs,
                agentMeta,
            });

            try {
                fs.writeFileSync(path.join(sessionDir, '_report.md'), `# 📝 CEO 종합 보고서\n\n${finalReport}\n`);
            } catch { /* ignore */ }
            appendAgentMemory('ceo', `${prompt} → 보고서 sessions/${path.basename(sessionDir)}/_report.md`);
            // Phase 1: log CEO's final synthesis into the running transcript
            appendConversationLog({ speaker: 'CEO', emoji: '🧭', section: '종합 보고서', body: finalReport });
            /* Auto-mark any open tracker task that was created in the last
               few minutes (= the user's most recent dispatch) as done now
               that the CEO has wrapped up. Lets the user see "✅ 다음 영상
               컨셉 뽑기" without manual /done. */
            try { autoMarkTrackerFromDispatch(plan, sessionDir, finalReport); } catch { /* ignore */ }
            /* Refresh unified schedule so the next cycle's agents see the
               freshly-completed work in their context. */
            try { rebuildUnifiedSchedule(); } catch { /* ignore */ }

            // 5.5) 자가학습 — 결정 추출 → decisions.md 자동 append.
            //      Extracted to src/chat/corporate/decisions-phase.ts.
            await runDecisionsPhase({
                ctx: corpCtx,
                prompt,
                modelName,
                finalReport,
                conferTurns,
                sessionDir,
            });

            // 6) 종합 카드
            post({
                type: 'corporateReport',
                brief: plan.brief,
                report: finalReport,
                sessionPath: sessionDisplay,
                sessionRel: `Company/sessions/${path.basename(sessionDir)}`
            });

            // 6.4) Bridge mode 'output_only' or 'full' — Secretary writes a
            // 1-2 line wrap-up addressed to the user. Replaces the raw CEO
            // tone with a friendly, owner-facing summary so the bridge model
            // is felt at the end of every dispatch (not just at the start).
            // Reuses the same Telegram mirror flag so this card flows out
            // through the same channels as Secretary's other replies.
            if (bridgeMode !== 'off') {
                try {
                    const wrapSys = `당신은 1인 기업의 비서입니다. 방금 회사가 사장님 명령을 처리해서 종합 보고서가 나왔습니다.\n사장님(사용자)께 1~2 문장으로 친근하게 정리해서 전달하세요.\n- "사장님, ~"으로 시작\n- 핵심 결과 1개 + 필요하면 다음 액션 한 줄\n- JSON·머리말·꼬리말 금지. 평문만.`;
                    const wrapUsr = `[사장님 명령]\n${prompt.slice(0, 400)}\n\n[CEO 종합 보고]\n${finalReport.slice(0, 1500)}`;
                    const wrap = await this._callAgentLLM(wrapSys, wrapUsr, modelName, 'secretary', false);
                    const wrapText = (wrap || '').trim().slice(0, 500);
                    if (wrapText) {
                        this._displayMessages.push({ text: `📱 비서: ${wrapText}`, role: 'ai' });
                        appendConversationLog({ speaker: '비서', emoji: '📱', section: '브릿지(사장님 정리)', body: wrapText });
                        post({ type: 'agentChunk', agent: 'secretary', value: wrapText });
                    }
                } catch { /* never let the wrap-up break the dispatch flow */ }
            }

            // 6.5) Secretary 자동 텔레그램 보고 (토큰 있을 때만)
            const tg = readTelegramConfig();
            if (tg.token && tg.chatId) {
                const company = readCompanyName() || '1인 기업';
                /* v2.89 — 자율 사이클 vs 사용자 명령 헤더 구분. 자리 비웠을 때
                   회사가 알아서 한 일도 한 눈에 알 수 있게. */
                const isAuto = /^\[자율 사이클/.test(prompt);
                const header = isAuto
                    ? `*🌙 ${company} — 자율 사이클 보고*`
                    : `*📱 ${company} — 작업 라운드 보고*`;
                const cmdLine = isAuto
                    ? `*컨텍스트:* 회사 목표·메모리 검토 후 자율적으로 일거리 결정`
                    : `*명령:* ${prompt.slice(0, 200)}`;
                const tgText = `${header}\n\n${cmdLine}\n\n*브리프:* ${plan.brief}\n\n*완료한 에이전트:*\n${plan.tasks.map(t => `• ${AGENTS[t.agent]?.emoji} ${AGENTS[t.agent]?.name}`).join('\n')}\n\n${finalReport.slice(0, 1500)}\n\n_세션: ${path.basename(sessionDir)}_`;
                sendTelegramReport(tgText).then(ok => {
                    if (ok) {
                        post({ type: 'telegramSent', agent: 'secretary' });
                    }
                }).catch(() => { /* silent */ });
            }

            // 7) 디스플레이 히스토리 (간략)
            this._displayMessages.push({
                text: `**[1인 기업 모드]** ${plan.brief}\n\n${finalReport}\n\n_📁 저장: ${sessionDisplay}_`,
                role: 'ai'
            });
            this._saveHistory();

            // 8) 자율 git 백업 — 두뇌 + (옵션)회사 별도 백업 둘 다 시도.
            //    회사가 두뇌 안 nested면 두뇌 sync 한 번으로 끝, detached면
            //    별도 push가 같이 돌아감. 락이 분리돼있어 병렬로 실행 가능.
            const brainDir = path.join(os.homedir(), '.agent-os-ai-brain');
            const sessionMsg = `chore(corporate): session ${path.basename(sessionDir)}`;
            _safeGitAutoSync(brainDir, sessionMsg, this).catch(() => { /* silent */ });
            _safeGitAutoSyncCompany(sessionMsg, this).catch(() => { /* silent */ });
        } catch (error: any) {
            if (isAborted()) {
                this._broadcastCorporate({ type: 'error', value: '🛑 사용자가 중단했어요.' });
            } else {
                this._broadcastCorporate({ type: 'error', value: `⚠️ 1인 기업 모드 오류: ${error.message}` });
            }
        } finally {
            this._abortController = undefined;
            /* The corp dispatch already sends a Telegram daily-report when
               configured, but we still clear the mirror flag so a follow-up
               sidebar prompt doesn't accidentally inherit it. */
            this._telegramMirrorPending = false;
            /* v2.89.52 — 입력 잠금 해제. _handlePrompt만 streamEnd 보내고 있어서
               _handleCorporatePrompt(casual chat·shortcut·multi-agent 다 포함) 끝나면
               webview는 여전히 "응답 중" 상태로 입력 막혀있었음. 사용자가 정지 버튼을
               눌러야 풀리는 사고. 어떤 경로로 끝나든 finally에서 streamEnd 보장. */
            try { this._view?.webview.postMessage({ type: 'streamEnd' }); } catch { /* ignore */ }
        }
    }

    // 단일 에이전트 LLM 호출. broadcast=true이면 토큰을 webview로 스트리밍.
    private async _callAgentLLM(
        systemPrompt: string,
        userMsg: string,
        modelName: string,
        agentId: string,
        broadcast: boolean,
        opts?: { jsonMode?: boolean; onFirstToken?: () => void }
    ): Promise<string> {
        const agentDef = AGENTS[agentId];
        const tier: Tier = agentDef?.tier ?? _modelToTier(modelName);
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMsg }
        ];
        const jsonHint = opts?.jsonMode
            ? '\n\nIMPORTANT: Respond with valid JSON only. No code fences, no preamble, no trailing prose.'
            : '';
        const claudePrompt = _serializeMessages(messages) + jsonHint;

        let result = '';
        let firstTokenFired = false;
        const signal = this._abortController?.signal;
        await streamAsk(claudePrompt, tier, (token) => {
            if (signal?.aborted) return;
            if (!firstTokenFired && token) {
                firstTokenFired = true;
                try { opts?.onFirstToken?.(); } catch { /* ignore */ }
            }
            result += token;
            if (broadcast) {
                this._broadcastCorporate({ type: 'agentChunk', agent: agentId, value: token });
            }
        });
        return result;
    }

    // --------------------------------------------------------
    // Execute ALL agent actions from AI response
    // v2.89.93 — opts.rootOverride: 회사 모드에서 회사 폴더를 root로 사용.
    //            opts.appendToOutput: 회사 모드 inline injection 콜백 (read_file/list_files 결과를
    //              specialist 응답 끝에 append → 다음 에이전트와 final report에 컨텍스트 전달).
    //            opts.silent: vscode.window 알림 억제 (회사 모드는 카드 뷰에서 보고됨).
    // --------------------------------------------------------
    /** v2.89.131 — 직전 파일 액션 추적. agentId 가 주어졌을 때만 _recentFileActions
     *  에 기록. 다음 turn 의 system prompt 에 "최근 작업한 파일" 블록으로 주입돼서
     *  코다리가 파일 위치 잊고 추측 경로 만드는 사고 차단. */
    private _trackFileAction(agentId: string | undefined, absPath: string, action: 'create' | 'edit' | 'delete') {
        this._recentFileActions = _hTrackFileAction(this._recentFileActions, agentId, absPath, action);
    }

    /** v2.89.132 — 명시적 에이전트 호출 감지. "코다리야 …"·"@developer …"·"개발자야 …"
     *  처럼 사용자가 직접 이름 부른 경우 CEO 단계를 건너뛰고 그 에이전트에게만 dispatch.
     *  사용자 의도 존중 + 단순 작업의 처리 시간 5배 단축 (CEO LLM 호출 1회 + 다른
     *  specialist 4명 호출 제거). 자연어로만 명령한 경우는 None 반환 → 기존 CEO 분배. */
    private _detectExplicitMention(prompt: string): { agentId: string; agentName: string } | null {
        return _hDetectExplicitMention(prompt);
    }

    /** v2.89.145 — 매출 shortcut. 명시적 현빈 호출 + 매출 키워드면 LLM 우회하고
     *  paypal_revenue.py 의 마크다운 리포트 + 한 줄 코멘트 직접 표시. 작은 LLM이
     *  prefetch 무시하고 README 읽으려 하는 버릇 차단.
     *
     *  paypal_revenue.json 자격증명 없으면 친절 안내. 호출 실패하면 null →
     *  기존 LLM 흐름으로 fallback.
     */
    private async _tryRevenueShortcut(userPrompt: string): Promise<string | null> {
        return _hTryRevenueShortcut(userPrompt);
    }

    /** v2.89.133 — 키트 shortcut. 명시적 코다리 호출 + 두뇌 키트와 강하게 매칭되는
     *  명령이면 LLM 호출 자체를 건너뛰고 pack_apply 직접 실행하는 가짜 LLM 응답을
     *  생성한다. LM Studio 가 죽어있거나 context 모자라도 시연이 깨지지 않음.
     *
     *  매칭 점수 (pack_apply 와 동일 규칙):
     *    - manifest.keywords 1개 매칭 = 10점
     *    - manifest.name 부분 일치 = 5점
     *    - manifest.category = 3점
     *  점수 ≥ 10 이면 shortcut 발동. 아니면 null 반환 → 기존 LLM 흐름.
     *
     *  반환: out 문자열 (이미 <run_command> 태그 포함 → _executeActions 가 자동 실행).
     */
    private _tryKitShortcut(agentId: string, userPrompt: string): string | null {
        return _hTryKitShortcut(agentId, userPrompt);
    }

    /** v2.89.131 — fuzzy path hint. list_files/read_file 이 디렉토리 못 찾을 때
     *  비슷한 이름의 디렉토리를 _recentFileActions + 회사 폴더 하위에서 탐색해 제안.
     *  코다리가 "_agents/developer/test/" 추측 → 실제 "_company/test/" 매핑 자동 회복. */
    private _fuzzyPathHint(missingPath: string): string {
        return _hFuzzyPathHint(missingPath, this._recentFileActions);
    }

    /** v2.89.131 — system prompt 주입용 블록. 해당 에이전트가 최근 만진 파일들의
     *  절대 경로 리스트. 코다리가 "방금 만든 파일 어디?"라고 물을 일 자체 차단. */
    private _buildRecentFilesContext(agentId: string): string {
        return _hBuildRecentFilesContext(agentId, this._recentFileActions);
    }

    /**
     * v2.90 — Thin wrapper around the per-action coordinator in
     * `src/chat/actions/`. The original ~559-line regex pipeline lives there
     * now, one file per action type. Behavior is preserved byte-for-byte;
     * this method only binds class methods/state into a `CoordinatorHost`.
     */
    private async _executeActions(
        aiMessage: string,
        opts?: { rootOverride?: string; appendToOutput?: (s: string) => void; silent?: boolean; skipRunCommand?: boolean; agentId?: string }
    ): Promise<string[]> {
        return runActionCoordinator(aiMessage, {
            trackFileAction: (agentId, absPath, action) => this._trackFileAction(agentId, absPath, action),
            fuzzyPathHint: (missingPath) => this._fuzzyPathHint(missingPath),
            readBrainFile: (filename) => this._readBrainFile(filename),
            pushChatHistory: (msg) => { this._chatHistory.push(msg); },
            postWebview: (msg) => { try { this._view?.webview.postMessage(msg as any); } catch { /* ignore */ } },
            showTextDocument: async (uri, silent) => {
                /* edit/create handlers honor opts.silent — coordinator forwards
                   it via the `silent` argument so the wrapper here is a no-op
                   when the caller asked for silent dispatch. */
                if (silent) return;
                await vscode.window.showTextDocument(uri, { preview: false });
            },
            recentFileActions: this._recentFileActions,
            selfForGitSync: this,
        }, opts);
    }


    // Strip raw XML action tags from display message
    private _stripActionTags(text: string): string {
        return _hStripActionTags(text);
    }


    // ============================================================
    // Webview HTML — CINEMATIC UI v3 (Content-Grade Visuals)
    // ============================================================

    private _getHtml(): string {
        return _hGetSidebarHtml(this._extensionUri);
    }
}
