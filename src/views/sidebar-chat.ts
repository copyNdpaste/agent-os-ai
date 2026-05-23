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
import { runShortcutTool } from '../chat/shortcuts/run-shortcut-tool';
import { handleInjectLocalBrain } from '../chat/menu/inject-local-brain';
import { handleBrainMenu } from '../chat/menu/brain-menu';
import { handlePrompt } from '../chat/prompt/handle-prompt';
import { handlePromptWithFile } from '../chat/prompt/handle-prompt-with-file';
import type { PromptContext } from '../chat/prompt/types';
import { handleChatMessage } from '../chat/messages/chat';
import { handleAgentConfigMessage } from '../chat/messages/agent-config';
import { handleModelsMessage } from '../chat/messages/models';
import type { MessageContext } from '../chat/messages/types';
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
    /** v2.89.131 — 최근 파일 액션 추적. 개발신(또는 다른 specialist) 가 직전 turn 에
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
       해서 "진짜 사람이 말하는 느낌" 연출. profileImage가 정의된 에이전트(아인슈타인/카리나)만
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
       헤딩 라인 뒤에 같이 붙여서 ## ![](url) 📺 아인슈타인 형태로 한 줄 헤더 만듦. */
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

    /** Scan sessions/* for state.json files left in 'running' status (extension
     *  crashed mid-dispatch, network died, user closed VS Code, etc) and post
     *  a recovery card to the sidebar webview. No-op when none found. */
    private async _postIncompleteSessions(): Promise<void> {
        if (!this._view) return;
        try {
            const { scanIncompleteSessions } = await import('../dispatch/session-state');
            const incomplete = scanIncompleteSessions(getCompanyDir());
            if (incomplete.length === 0) return;
            const summary = incomplete.map(s => ({
                sessionDir: s.state.sessionDir,
                id: s.state.id,
                prompt: s.state.prompt,
                currentStep: s.state.currentStep,
                staleMinutes: s.staleMinutes,
                completedPhases: s.state.completedPhases,
                hasReport: !!s.state.report,
                agentCount: Object.keys(s.state.outputs).length,
            }));
            this._view.webview.postMessage({ type: 'incompleteSessions', sessions: summary });
        } catch (e) {
            console.error('[sidebar-chat] postIncompleteSessions failed:', e);
        }
    }

    /** Mark a session as aborted on disk. Called from recovery card "폐기". */
    private async _discardSession(sessionDir: string): Promise<void> {
        try {
            const { markSessionAborted } = await import('../dispatch/session-state');
            const stateFile = path.join(sessionDir, 'state.json');
            markSessionAborted(stateFile, 'user discarded from recovery card');
            /* Re-scan so card refreshes (if other incomplete sessions remain). */
            this._postIncompleteSessions();
        } catch (e) {
            console.error('[sidebar-chat] discardSession failed:', e);
        }
    }

    /** Reveal a session folder in OS file manager. */
    private _openSessionFolder(sessionDir: string): void {
        try {
            vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(sessionDir));
        } catch (e) {
            console.error('[sidebar-chat] openSessionFolder failed:', e);
        }
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
            /* Extracted handler dispatch chain — handlers return true if they
               consume the message. Inline cases below are kept for non-extracted
               message types; the extracted cases are dead code until cleanup. */
            const mctx = this._buildMessageContext(webviewView);
            if (await handleChatMessage(mctx, msg)) return;
            if (await handleAgentConfigMessage(mctx, msg)) return;
            if (await handleModelsMessage(mctx, msg)) return;
            switch (msg.type) {
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
                case 'statusFolderClick':
                    await this._handleStatusFolderClick();
                    break;
                case 'statusGitClick':
                    await this._handleStatusGitClick();
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

    /* Body lives in `chat/menu/inject-local-brain.ts`; this is a thin host wrapper. */
    private async _handleInjectLocalBrain(files: any[]) {
        return handleInjectLocalBrain(
            {
                view: this._view,
                chatHistory: this._chatHistory,
                selfForGitSync: this,
                sendStatusUpdate: () => this._sendStatusUpdate(),
                injectSystemMessage: (msg) => this.injectSystemMessage(msg),
            },
            files,
        );
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
    // Body lives in `chat/menu/brain-menu.ts`; this is a thin host wrapper.
    // --------------------------------------------------------
    private async _handleBrainMenu() {
        return handleBrainMenu({
            view: this._view,
            ctx: this._ctx,
            setBrainEnabled: (v) => { this._brainEnabled = v; },
            findBrainFiles: (dir) => this._findBrainFiles(dir),
            syncSecondBrain: () => this._syncSecondBrain(),
            sendStatusUpdate: () => this._sendStatusUpdate(),
        });
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

    /** Builds a MessageContext bag for the extracted webview message handlers.
        Refs are tiny accessor objects so writes inside handlers propagate back
        to the underlying class field. */
    private _buildMessageContext(webviewView: vscode.WebviewView): MessageContext {
        const self = this;
        return {
            webviewView,
            ctx: this._ctx,
            view: this._view,
            extensionUri: this._extensionUri,
            chatHistory: this._chatHistory,
            displayMessages: this._displayMessages,
            abortControllerRef: {
                get value() { return self._abortController; },
                set value(v) { self._abortController = v; },
            },
            lastPromptRef: {
                get value() { return self._lastPrompt; },
                set value(v) { self._lastPrompt = v; },
            },
            lastModelRef: {
                get value() { return self._lastModel; },
                set value(v) { self._lastModel = v; },
            },
            sidebarCorpModeRef: {
                get value() { return self._sidebarCorpModeOn; },
                set value(v) { self._sidebarCorpModeOn = v; },
            },
            activeSessionIdRef: {
                get value() { return self._activeSessionId ?? undefined; },
                set value(v) { self._activeSessionId = v ?? null; },
            },
            thinkingPanelRef: {
                get value() { return self._thinkingPanel; },
                set value(v) { self._thinkingPanel = v; },
            },
            handlePrompt: (p, m, i) => this._handlePrompt(p, m, i),
            handleCorporatePrompt: (p, m) => this._handleCorporatePrompt(p, m),
            handlePromptWithFile: (p, m, f, i) => this._handlePromptWithFile(p, m, f, i),
            handleInjectLocalBrain: (f) => this._handleInjectLocalBrain(f),
            handleSettingsMenu: () => this._handleSettingsMenu(),
            handleBrainMenu: () => this._handleBrainMenu(),
            handleStatusFolderClick: () => this._handleStatusFolderClick(),
            handleStatusGitClick: () => this._handleStatusGitClick(),
            postIncompleteSessions: () => this._postIncompleteSessions(),
            discardSession: (dir) => this._discardSession(dir),
            openSessionFolder: (dir) => this._openSessionFolder(dir),
            sendModels: () => this._sendModels(),
            sendCompanyState: (note) => this._sendCompanyState(note),
            sendStatusUpdate: () => this._sendStatusUpdate(),
            toggleThinkingMode: () => this._toggleThinkingMode(),
            openThinkingPanel: () => this._openThinkingPanel(),
            postThinking: (m) => this._postThinking(m),
            restoreSession: (id) => this._restoreSession(id),
            readSessions: () => _hReadSessions(this._ctx),
            writeSessions: (sessions) => _hWriteSessions(this._ctx, sessions),
            deleteSession: (id) => _hDeleteSession(this._ctx, id),
            currentWorkspaceMeta: () => _hCurrentWorkspaceMeta(),
            detectExplicitMention: (p) => this._detectExplicitMention(p),
            restoreDisplayMessages: () => this._restoreDisplayMessages(),
            resetChat: () => this.resetChat(),
            injectSystemMessage: (m) => this.injectSystemMessage(m),
            getDefaultModel: () => this.getDefaultModel(),
            startAutoCycle: (i, idle) => this.startAutoCycle(i, idle),
            stopAutoCycle: () => this.stopAutoCycle(),
            maybeMorningBriefing: (c) => this.maybeMorningBriefing(c),
            broadcastCorporate: (m) => this._broadcastCorporate(m),
        };
    }

    /** Builds a PromptContext bag for the extracted prompt handlers.
        Caller must guard `!this._view` first since PromptContext.view is non-optional. */
    private _buildPromptContext(view: vscode.WebviewView): PromptContext {
        return {
            view,
            chatHistory: this._chatHistory,
            displayMessages: this._displayMessages,
            brainEnabled: this._brainEnabled,
            systemPrompt: this._systemPrompt,
            setLastPrompt: (p) => { this._lastPrompt = p; },
            setLastModel: (m) => { this._lastModel = m; },
            createAbortController: () => {
                this._abortController = new AbortController();
                return this._abortController;
            },
            getAbortController: () => this._abortController,
            setTelegramMirrorPending: (v) => { this._telegramMirrorPending = v; },
            getTelegramMirrorPending: () => this._telegramMirrorPending,
            getWorkspaceContext: () => this._getWorkspaceContext(),
            getSecondBrainContext: () => this._getSecondBrainContext(),
            getProjectMemory: () => this._getProjectMemory(),
            readBrainFile: (f) => this._readBrainFile(f),
            executeActions: (msg, opts) => this._executeActions(msg, opts),
            stripActionTags: (t) => this._stripActionTags(t),
            pruneHistory: () => this._pruneHistory(),
            saveHistory: () => this._saveHistory(),
            maybeMirrorToTelegram: () => this._maybeMirrorToTelegram(),
            postThinking: (m) => this._postThinking(m),
            shouldEmitThinking: () => this._shouldEmitThinking(),
        };
    }

    // --------------------------------------------------------
    // Handle prompt with file attachments (multimodal)
    // Body lives in `chat/prompt/handle-prompt-with-file.ts`.
    // --------------------------------------------------------
    private async _handlePromptWithFile(prompt: string, modelName: string, files: {name: string, type: string, data: string}[], internetEnabled?: boolean) {
        if (!this._view) { return; }
        return handlePromptWithFile(this._buildPromptContext(this._view), prompt, modelName, files, internetEnabled);
    }

    // --------------------------------------------------------
    // Handle user prompt → Claude → agent actions → response
    // Body lives in `chat/prompt/handle-prompt.ts`.
    // --------------------------------------------------------
    private async _handlePrompt(prompt: string, modelName: string, internetEnabled?: boolean) {
        if (!this._view) { return; }
        return handlePrompt(this._buildPromptContext(this._view), prompt, modelName, internetEnabled);
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
           무시하고 multi-agent dispatch (제프베조스 + 아인슈타인 둘 다) 가 잡도록 여기서 바로 false. */
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
       source 인자는 어떤 단계에서 매칭됐는지 사용자에게 보여주기 위함 ('패턴' or '분류기').
       Body lives in `chat/shortcuts/run-shortcut-tool.ts`; this is a thin host wrapper. */
    private async _runShortcutTool(
        entry: { agentId: string; tool: string; scriptPath: string },
        prompt: string,
        sessionDir: string,
        source: string,
    ): Promise<boolean> {
        return runShortcutTool(
            {
                displayMessages: this._displayMessages,
                broadcastCorporate: (m) => this._broadcastCorporate(m),
                callAgentLLM: (sys, usr, model, agentId, broadcast, opts) =>
                    this._callAgentLLM(sys, usr, model, agentId, broadcast, opts),
            },
            entry,
            prompt,
            sessionDir,
            source,
        );
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
        /* Session-state writer is created right after sessionDir so every
           phase that follows can checkpoint progress to disk. Declared out
           here so the outer try/finally can call finish() exactly once. */
        let sessionWriter: import('../dispatch/session-state').SessionStateWriter | undefined;
        try {
            ensureCompanyStructure();
            const sessionDir = makeSessionDir();
            const sessionDisplay = sessionDir.replace(os.homedir(), '~');
            /* Lazy import keeps the dispatch entry hot path slim and lets the
               session-state module stay tree-shakable. */
            const { SessionStateWriter } = await import('../dispatch/session-state');
            sessionWriter = new SessionStateWriter({
                sessionDir,
                prompt,
                modelName,
                fromTelegram: false,
            });
            sessionWriter.setStep('CEO 계획 중');

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
            /* v2.89.132 — 명시적 호출 감지. "개발신아 …" 처럼 사용자가 직접 이름 부르면
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
                   - LOCKED 미채용 (한스짐머 PIN 안 풀림)
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
               비활성 에이전트(한스짐머 미채용 또는 OPTIONAL 비활성)에 task 배정해도 여기서 제거. */
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
                const wantedIds = originalTasks.map(t => String(t.agent || '').trim().toLowerCase());
                /* v2.92 — CEO 가 자기 자신만 task 로 넣은 케이스 (또는 unknown id 만)
                   를 silent fallback. 사용자 명령에 브레인스토밍 키워드가 있으면
                   기본 3인방 (researcher · business · designer) 로 자동 라우팅.
                   에러로 끊는 대신 사용자 의도에 맞게 진행 → 훨씬 부드러운 UX. */
                const ceoSelfOnly = wantedIds.length > 0 && wantedIds.every(id => id === 'ceo' || !SPECIALIST_IDS.includes(id));
                const looksBrainstorm = /아이디어|브레인스토밍|프로젝트.*뭐|어떤.*비즈니스|어떤.*프로젝트|뭐 ?하면 ?좋|뭘 ?만들|돈.*벌|시장|해결.*문제|너희들끼리|상의|고민/i.test(prompt);
                if (droppedTasks.length > 0) {
                    post({ type: 'error', value: `⚠️ CEO가 비활성 에이전트만 호출했어요. 직원 패널에서 활성화 후 다시 시도해주세요.` });
                    return;
                }
                if (ceoSelfOnly && looksBrainstorm) {
                    const fallbackBase: { agent: string; task: string }[] = [
                        { agent: 'researcher', task: `시장·트렌드 리서치: "${prompt.slice(0, 120)}" 관점에서 해결되지 않은 문제·기회를 데이터·출처와 함께 3~5개 정리.` },
                        { agent: 'business', task: `위 리서치 토대로 수익화 가능한 비즈니스 모델 후보 2~3개 — 고객 관점(Working Backwards), TAM·1년 매출 추정, 진입 장벽 평가.` },
                        { agent: 'designer', task: `각 후보의 제품 차별화 각도(less but better)와 첫 MVP 범위 — 1주일에 만들 수 있는 단순한 형태로 압축.` },
                    ];
                    plan.tasks = fallbackBase.filter(t => isAgentActive(t.agent));
                    if (plan.tasks.length > 0) {
                        const fbNames = plan.tasks.map(t => `${AGENTS[t.agent]?.emoji || ''} ${AGENTS[t.agent]?.name || t.agent}`).join(' · ');
                        post({ type: 'systemNote', value: `🧭 CEO 가 자기 자신만 호출해서 자동 fallback 으로 ${fbNames} 에게 브레인스토밍 분배했습니다.` });
                        plan.brief = plan.brief || `브레인스토밍: "${prompt.slice(0, 100)}"`;
                    } else {
                        post({ type: 'error', value: `⚠️ Fallback 시도했지만 researcher/business/designer 모두 비활성. 직원 패널에서 활성화 후 다시 시도해주세요.` });
                        return;
                    }
                } else {
                    const wantedStr = originalTasks.map(t => `"${t.agent}"`).join(', ');
                    post({
                        type: 'error',
                        value: `⚠️ CEO가 호출한 에이전트(${wantedStr || '없음'})가 우리 팀에 없어요.\n사용 가능한 id: ${SPECIALIST_IDS.join(', ')}\n\nCEO 원본 응답 일부:\n${(planRaw || '').slice(0, 300)}`
                    });
                    return;
                }
            }
            /* v2.92 — plan.tasks 안에 'ceo' 가 섞여있는 partial 케이스도 silent drop.
               (이미 SPECIALIST_IDS find 로 dropped 됐지만, 명시 가드로 한 번 더.) */
            plan.tasks = plan.tasks.filter(t => SPECIALIST_IDS.includes(t.agent));

            /* Checkpoint: planner finished, persist plan to state.json. */
            sessionWriter?.setPlan({ brief: plan.brief, tasks: plan.tasks });

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
                sessionWriter,
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
            /* Checkpoint: full dispatch finished cleanly. */
            sessionWriter?.finish('completed');
        } catch (error: any) {
            if (isAborted()) {
                this._broadcastCorporate({ type: 'error', value: '🛑 사용자가 중단했어요.' });
                sessionWriter?.finish('aborted', 'user aborted');
            } else {
                this._broadcastCorporate({ type: 'error', value: `⚠️ 1인 기업 모드 오류: ${error.message}` });
                sessionWriter?.finish('failed', String(error?.message || error).slice(0, 500));
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
            /* Defensive: if try-block returned early before finish() ran (e.g.
               earlyReturn from specialist-loop after abort), make sure status
               isn't left as 'running' forever. Status is idempotent — second
               finish() on a terminal writer is a no-op. */
            if (sessionWriter) {
                const snap = sessionWriter.snapshot();
                if (snap.status === 'running') sessionWriter.finish('aborted', 'early return');
            }
        }
    }

    // 단일 에이전트 LLM 호출. broadcast=true이면 토큰을 webview로 스트리밍.
    private async _callAgentLLM(
        systemPrompt: string,
        userMsg: string,
        modelName: string,
        agentId: string,
        broadcast: boolean,
        opts?: { jsonMode?: boolean; onFirstToken?: () => void; onChunk?: (chunk: string) => void }
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
            /* Session checkpoint: stream chunk straight to disk-writer if attached.
               Writer throttles to ~1s so this is cheap. */
            if (opts?.onChunk) {
                try { opts.onChunk(token); } catch { /* never break LLM stream */ }
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
     *  개발신가 파일 위치 잊고 추측 경로 만드는 사고 차단. */
    private _trackFileAction(agentId: string | undefined, absPath: string, action: 'create' | 'edit' | 'delete') {
        this._recentFileActions = _hTrackFileAction(this._recentFileActions, agentId, absPath, action);
    }

    /** v2.89.132 — 명시적 에이전트 호출 감지. "개발신아 …"·"@developer …"·"개발자야 …"
     *  처럼 사용자가 직접 이름 부른 경우 CEO 단계를 건너뛰고 그 에이전트에게만 dispatch.
     *  사용자 의도 존중 + 단순 작업의 처리 시간 5배 단축 (CEO LLM 호출 1회 + 다른
     *  specialist 4명 호출 제거). 자연어로만 명령한 경우는 None 반환 → 기존 CEO 분배. */
    private _detectExplicitMention(prompt: string): { agentId: string; agentName: string } | null {
        return _hDetectExplicitMention(prompt);
    }

    /** v2.89.145 — 매출 shortcut. 명시적 제프베조스 호출 + 매출 키워드면 LLM 우회하고
     *  paypal_revenue.py 의 마크다운 리포트 + 한 줄 코멘트 직접 표시. 작은 LLM이
     *  prefetch 무시하고 README 읽으려 하는 버릇 차단.
     *
     *  paypal_revenue.json 자격증명 없으면 친절 안내. 호출 실패하면 null →
     *  기존 LLM 흐름으로 fallback.
     */
    private async _tryRevenueShortcut(userPrompt: string): Promise<string | null> {
        return _hTryRevenueShortcut(userPrompt);
    }

    /** v2.89.133 — 키트 shortcut. 명시적 개발신 호출 + 두뇌 키트와 강하게 매칭되는
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
     *  개발신가 "_agents/developer/test/" 추측 → 실제 "_company/test/" 매핑 자동 회복. */
    private _fuzzyPathHint(missingPath: string): string {
        return _hFuzzyPathHint(missingPath, this._recentFileActions);
    }

    /** v2.89.131 — system prompt 주입용 블록. 해당 에이전트가 최근 만진 파일들의
     *  절대 경로 리스트. 개발신가 "방금 만든 파일 어디?"라고 물을 일 자체 차단. */
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
