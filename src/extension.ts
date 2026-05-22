import * as vscode from 'vscode';
import * as http from 'http';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, spawnSync } from 'child_process';
import { ask, streamAsk, resolveClaudeBin, pingClaude, type Tier } from './llm';
import {
    gitExec, gitExecSafe, gitRun,
    isGitAvailable, classifyGitError, validateGitRemoteUrl,
    getRemoteDefaultBranch, ensureInitialCommit, ensureBrainGitignore,
    type GitErrorKind,
} from './infra/git';
import {
    safeResolveInside, resolveFlexiblePath as _resolveFlexiblePath, safeBasename,
    MAX_FILE_NAME_LEN,
} from './infra/path-safety';
import { renderUnifiedDiff as _renderUnifiedDiff } from './infra/diff';
import {
    globMatch as _globMatch,
    globToRegex as _globToRegex,
    grepFiles as _grepFiles,
} from './infra/glob';
import {
    runCommandCaptured,
    killProcessesOnPort as _killProcessesOnPort,
} from './infra/process';
import {
    pythonCmd as _pythonCmd,
    invalidatePythonCmdCache as _invalidatePythonCmdCache,
    isPythonMissing as _isPythonMissing,
    pythonMissingHint as _pythonMissingHint,
} from './infra/python';
/* Re-exports for src/views/* — webview classes import these from '../extension'
   for consistency. */
export { runCommandCaptured } from './infra/process';
export { pythonCmd as _pythonCmd } from './infra/python';
import {
    MAX_HTTP_BODY,
    CONNECT_AI_VERSION as _CONNECT_AI_VERSION,
    versionLessThan as _versionLessThan,
    probeExistingBridge as _probeExistingBridge,
    readRequestBody,
    revealInOsExplorer as _revealInOsExplorer,
    openInDefaultApp as _openInDefaultApp,
} from './infra/system';

/** Module-scoped lock so auto-sync and manual sync never run concurrently against the same brain.
 *  v2.92.x: ESM `let` bindings are read-only when imported from another module, so we expose
 *  the booleans as exported state + setters. `_setAutoSyncRunning` / `_setCompanySyncRunning`
 *  are used by src/views/sidebar-chat.ts which writes from outside this module. */
export let _autoSyncRunning = false;
export let _companySyncRunning = false;
export function _setAutoSyncRunning(v: boolean): void { _autoSyncRunning = v; }
export function _setCompanySyncRunning(v: boolean): void { _companySyncRunning = v; }

/* v2.89.152 — 크로스플랫폼 + 자동 감지 + 사용자 override.
   이전 v2.89.88 은 단순 `python3` (맥) / `python` (윈도우) 분기였는데:
     - 윈도우 사용자가 `py` 또는 `python3` 으로 설치한 경우 fail
     - 맥에서 `python3` 미설치 (신규 macOS, Xcode CLT 없음) 시 fail
     - venv/pyenv 환경 무시
     - PATH 미동기화 (Anti-Gravity 가 시스템 PATH 못 잡음) 시 spawn 실패
   해결:
     1. 사용자 설정 agentOs.pythonPath 가장 강함
     2. 후보 cmd 순차 시도 (which/where 로 실제 존재 확인) — 첫 성공한 거 캐시
     3. 캐시 못 찾으면 fallback 명령 (사용자에게 안내)
*/
// ============================================================
// Agent OS — Full Agentic Local AI for VS Code
// 100% Offline · File Create · File Edit · Terminal · Multi-file Context
// ============================================================

// Settings are read from VS Code configuration (File > Preferences > Settings)
export function getConfig() {
    const cfg = vscode.workspace.getConfiguration('agentOs');

    const rawTimeout = cfg.get<number>('requestTimeout', 300);
    const timeoutSec = (typeof rawTimeout === 'number' && isFinite(rawTimeout))
        ? Math.min(1800, Math.max(5, rawTimeout))
        : 300;

    return {
        maxTreeFiles: 200,
        timeout: timeoutSec * 1000,
        localBrainPath: cfg.get<string>('localBrainPath', '') || ''
    };
}

/* v2.89.66 — _getBrainDir, _isBrainDirExplicitlySet, getCompanyDir, COMPANY_SUBDIR,
   _expandTilde, _resolvePathInput 모두 ./paths.ts 로 이동. 모듈 간 import 일원화. */
import { _getBrainDir, _isBrainDirExplicitlySet, getCompanyDir, COMPANY_SUBDIR, _expandTilde, _resolvePathInput } from './paths';
import * as tg from './telegram';
import * as st from './agent-state';
import * as cal from './calendar';
import * as cmp from './company';
import * as trk from './tracker';
import * as apv from './approvals';
import * as clog from './conversation-log';
import * as dsp from './dispatch';
import * as sch from './scheduler';
/* Webview / Tree UI classes — 본문은 src/views/*. extension.ts 는 instantiate
   만 책임. RevenueDashboardPanel 은 다른 view 들도 import 하므로 re-export. */
import {
    TaskTreeItem,
    TaskTreeProvider,
    ApprovalsPanelProvider,
    YouTubeDashboardProvider,
    CompanyDashboardPanel,
    ApiConnectionsPanel,
    RevenueDashboardPanel,
    OfficePanel,
} from './views';
export { RevenueDashboardPanel } from './views/revenue-dashboard';
export { CompanyDashboardPanel } from './views/company-dashboard';
export { OfficePanel } from './views/office-panel';
import { SidebarChatProvider } from './views/sidebar-chat';
export { SidebarChatProvider } from './views/sidebar-chat';
/* Telegram polling + command handlers (Cycle 5 추출). */
import {
    handleTelegramCommand,
    handleTelegramViaSecretary,
    startTelegramPolling,
    stopTelegramPolling,
} from './telegram';
export { handleTelegramCommand, handleTelegramViaSecretary, startTelegramPolling, stopTelegramPolling };
/* Calendar OAuth setup wizard (Cycle 5 추출). */
import { runConnectGoogleCalendarWrite } from './calendar';
export { runConnectGoogleCalendarWrite };
/* Brain graph + RAG context (Cycle 6 추출). */
import {
    type BrainGraph,
    buildKnowledgeGraph,
    showBrainNetwork,
    _RENDER_GRAPH_HTML,
    readRelevantBrainContext,
    readGraphRagBrainContext,
    readAgentSharedContext,
    readAgentTemplates,
    readAgentSkills,
    readAgentVerifiedKnowledge,
    readAgentCustomPrompt,
    _extractWikiSnippet,
} from './brain';
export {
    BrainGraph,
    buildKnowledgeGraph,
    showBrainNetwork,
    _RENDER_GRAPH_HTML,
    readRelevantBrainContext,
    readGraphRagBrainContext,
    readAgentSharedContext,
    readAgentTemplates,
    readAgentSkills,
    readAgentVerifiedKnowledge,
    readAgentCustomPrompt,
    _extractWikiSnippet,
};
/* API connections + YouTube OAuth (Cycle 6 추출). */
import {
    API_SERVICES,
    readAllApiConnections,
    saveApiConnection,
} from './api-connections';
export { API_SERVICES, readAllApiConnections, saveApiConnection };
import {
    startYouTubeOAuthFlow,
    isYoutubeOAuthConnected,
    fetchYouTubeAnalyticsSummary,
} from './youtube';
export { startYouTubeOAuthFlow, isYoutubeOAuthConnected, fetchYouTubeAnalyticsSummary };
/* Background loops (Cycle 6 추출). */
import {
    startTrackerNudgeLoop, stopTrackerNudge,
    startRevenueWatcherLoop, stopRevenueWatcherLoop, _runRevenueWatcherOnce,
    startRecurrenceLoop, stopRecurrenceLoop,
    startPreAlarmLoop, stopPreAlarmLoop,
    startDailyBriefingLoop, stopDailyBriefingLoop, _runDailyBriefingOnce,
} from './loops';
export {
    startTrackerNudgeLoop, stopTrackerNudge,
    startRevenueWatcherLoop, stopRevenueWatcherLoop, _runRevenueWatcherOnce,
    startRecurrenceLoop, stopRecurrenceLoop,
    startPreAlarmLoop, stopPreAlarmLoop,
    startDailyBriefingLoop, stopDailyBriefingLoop, _runDailyBriefingOnce,
};
/* Git auto-sync + scaffolders (Cycle 6 추출). */
import { _safeGitAutoSync, _safeGitAutoSyncCompany } from './git-sync/auto-sync';
export { _safeGitAutoSync, _safeGitAutoSyncCompany };
import { scaffoldDeveloperProject, _youtubeCommentReplyDraftBatch } from './scaffolders';
export { scaffoldDeveloperProject, _youtubeCommentReplyDraftBatch };
/* Cycle 7 extractions. */
import {
    _migrateCompanyToSubdir, _migrateYouTubeCredsToCanonical, _migrateCompanyToBrain,
    ensureCompanyStructure, runConnectCompanyRepo, runChangeCompanyDir,
} from './company/structure';
export {
    _migrateCompanyToSubdir, _migrateYouTubeCredsToCanonical, _migrateCompanyToBrain,
    ensureCompanyStructure, runConnectCompanyRepo, runChangeCompanyDir,
};
import {
    TELEGRAM_HELP, _modelToTier, _serializeMessages, _quickLLMCall, classifyToAgent,
    _extractFirstJsonObject, _buildCapabilityReport, _buildDispatchStatusReport,
    _isCasualChat, _harvestActionItems,
} from './telegram/dispatch';
export {
    TELEGRAM_HELP, _modelToTier, _serializeMessages, _quickLLMCall, classifyToAgent,
    _extractFirstJsonObject, _buildCapabilityReport, _buildDispatchStatusReport,
    _isCasualChat, _harvestActionItems,
};
import {
    SYSTEM_PROMPT, CEO_CLASSIFIER_PROMPT, SECRETARY_TELEGRAM_PROMPT, SKILL_DISTILL_PROMPT,
    CEO_PLANNER_PROMPT, CEO_CHAT_PROMPT, SECRETARY_TRIAGE_PROMPT, CEO_REPORT_PROMPT,
    CONFER_PROMPT, DECISIONS_EXTRACT_PROMPT,
} from './prompts';
export {
    SYSTEM_PROMPT, CEO_CLASSIFIER_PROMPT, SECRETARY_TELEGRAM_PROMPT, SKILL_DISTILL_PROMPT,
    CEO_PLANNER_PROMPT, CEO_CHAT_PROMPT, SECRETARY_TRIAGE_PROMPT, CEO_REPORT_PROMPT,
    CONFER_PROMPT, DECISIONS_EXTRACT_PROMPT,
};
import {
    _priorityGroupIcon, _taskStatusIcon, _formatDueLabel, rebuildUnifiedSchedule,
} from './tracker/ui-helpers';
export {
    _priorityGroupIcon, _taskStatusIcon, _formatDueLabel, rebuildUnifiedSchedule,
};
import {
    appendAgentMemory, _getLastSpecialistOutput, saveAgentSkill,
    countAgentVerifiedClaims, promoteGroundedClaimsFromOutput,
    routeBrainInjectionToAgents, readAgentGoal, writeAgentGoal, writeAgentSelfRagCriteria,
    autoMarkTrackerFromDispatch, prefetchAgentRealtimeData, buildAgentConfigStatus,
    buildSpecialistPrompt,
} from './brain/agent-glue';
export {
    appendAgentMemory, _getLastSpecialistOutput, saveAgentSkill,
    countAgentVerifiedClaims, promoteGroundedClaimsFromOutput,
    routeBrainInjectionToAgents, readAgentGoal, writeAgentGoal, writeAgentSelfRagCriteria,
    autoMarkTrackerFromDispatch, prefetchAgentRealtimeData, buildAgentConfigStatus,
    buildSpecialistPrompt,
};
/* Per-domain command registrations (chat, dashboard, tracker, ...).
   activate() instantiates providers + status bars + loops, then calls
   registerAll() to wire vscode.commands.registerCommand bindings. */
import { registerAll as _registerAllCommands, type CommandProviders } from './commands';

/* Brain RAG primitives — keyword/relevance scorer + walker + company-internal
   skip-set. Originally inline in extension.ts; extracted to brain/keywords.ts
   and brain/walk.ts. Re-exported here so cross-module consumers (and the
   public extension surface) keep the same names. */
import { _agentKeywords, _scoreRelevance } from './brain/keywords';
import { _walkBrainMd, COMPANY_INTERNAL_DIRS } from './brain/walk';
export { _agentKeywords, _scoreRelevance, _walkBrainMd, COMPANY_INTERNAL_DIRS };

/* Tracker UI/IO helpers — `_coercePriority` 1-line shim, `trackerToMarkdown`
   formatter, `listAgentTools` agent-tools catalog. Extracted to
   tracker/ui-helpers.ts (re-uses existing UI helpers module). */
import {
    _coercePriority,
    trackerToMarkdown,
    listAgentTools,
} from './tracker/ui-helpers';
import type { AgentTool, ToolField } from './tracker/ui-helpers';
export { _coercePriority, trackerToMarkdown, listAgentTools };
export type { AgentTool, ToolField };

/* Calendar ↔ tracker sync — extension wrappers close over companyDir so
   call sites (addTrackerTask/updateTrackerTask) keep the original one-arg
   signature. Implementation lives in calendar/tracker-sync.ts. */
import {
    createCalendarEventForTask as _createCalendarEventForTaskImpl,
    updateCalendarEventForTask as _updateCalendarEventForTaskImpl,
} from './calendar/tracker-sync';

/* Report scheduler — extracted tick runner. extension.ts wrappers
   (readReportSchedule/writeReportSchedule/sendTelegramLong/_runDailyBriefingOnce)
   are imported back inside scheduler/tick-runner.ts; this side just wires
   start at activate() time. */
import { startReportScheduler } from './scheduler/tick-runner';

export async function _ensureBrainDir(): Promise<string | null> {
    if (_isBrainDirExplicitlySet()) {
        return _getBrainDir();
    }
    // 폴더 미설정 → 사용자에게 강제 선택 요청
    const result = await vscode.window.showInformationMessage(
        '📁 지식을 저장할 폴더를 먼저 선택해주세요! (AI가 답변할 때 참고할 .md 파일들이 보관됩니다)',
        '폴더 선택하기'
    );
    if (result !== '폴더 선택하기') return null;
    
    const folders = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        openLabel: '이 폴더를 내 지식 폴더로 사용',
        title: '🧠 내 지식 폴더 선택'
    });
    if (!folders || folders.length === 0) return null;
    
    const selectedPath = folders[0].fsPath;
    await vscode.workspace.getConfiguration('agentOs').update('localBrainPath', selectedPath, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`✅ 지식 폴더가 설정되었어요: ${selectedPath}`);
    return selectedPath;
}

export const EXCLUDED_DIRS = new Set([
    'node_modules', '.git', '.vscode', 'out', 'dist', 'build',
    '.next', '.cache', '__pycache__', '.DS_Store', 'coverage',
    '.turbo', '.nuxt', '.output', 'vendor', 'target'
]);
export const MAX_CONTEXT_SIZE = 12_000; // chars

/* v2.89.61 — 9개 LLM 프롬프트(SYSTEM, CEO_*, SECRETARY_*) 를 assets/prompts/ 에 .md
   파일로 분리. 익스텐션 로드 시 한 번 읽어 메모리에 캐시. 프롬프트 수정이 코드
   수정 없이 가능 + 줄 수 287줄 절약 + IDE에서 markdown 미리보기로 검토 가능.
   __dirname는 esbuild 번들 출력 위치(extension/out)이라 ../assets/prompts 로 한 단계 위. */
const _PROMPTS_DIR = path.join(__dirname, '..', 'assets', 'prompts');
const _promptCache = new Map<string, string>();
function _loadPrompt(file: string): string {
    let cached = _promptCache.get(file);
    if (cached !== undefined) return cached;
    try {
        cached = fs.readFileSync(path.join(_PROMPTS_DIR, file), 'utf-8');
    } catch (e: any) {
        console.error(`[Agent OS] prompt 로드 실패 ${file}:`, e?.message || e);
        cached = '';
    }
    _promptCache.set(file, cached);
    return cached;
}

/* v2.89.62 — 11개 Python 도구 + 11개 README 를 assets/tool-seeds/<agent>/<tool>.{py,md} 로 분리.
   각 _seed* 함수에서 lazy load. assets/tool-seeds/secretary/telegram_setup.py 같은 형태.
   v2.91.x — Clean Architecture Phase 1: 모든 `_seedXxx*` 함수와 `_loadToolSeed`/
   `_seedFile*` 헬퍼는 `./seeds/` 디렉토리로 분리됨. extension.ts 는 dispatch 만 호출. */
import {
  _seedAgentToolsIfMissing,
  _seedAgentGoalIfMissing,
  _seedAgentToolsManifestIfMissing,
  _seedBundledTemplates,
} from './seeds';

// ============================================================
// 1인 기업 모드 — Multi-Agent Corporate System
// ------------------------------------------------------------
// CEO + 5 specialist agents share a "Company" subtree under
// the existing brain folder:
//   ~/.connect-ai-brain/Company/
//     _shared/        ← 공동 목표, 회사 정체성 (모두 매번 읽음)
//     _agents/<id>/   ← 각 에이전트 개인 메모리 (자기만 읽고 씀)
//     sessions/<ts>/  ← 세션별 산출물 + CEO 종합 보고
// ============================================================
/* v2.89.64 — AgentDef interface, AGENTS map, AGENT_ORDER, SPECIALIST_IDS
   moved to src/agents.ts. extension.ts only imports them now. ~118 lines saved. */
import { AgentDef, AGENTS, AGENT_ORDER, SPECIALIST_IDS } from './agents';

// ───────────────────────────────────────────────────────────────────────────
// Connected campus world (Phase B-1 — multi-zone layout).
//
// One big virtual campus: Office building + Cafe + outdoor Garden, all on
// a single coord space so characters walk freely between zones. Each
// "building" is a pre-built bg PNG/GIF placed at a fixed pixel position in
// the world. Decorations (trees, flowers, benches) are scattered tiles on
// the garden grass.
// ───────────────────────────────────────────────────────────────────────────
export interface DeskPos { x: number; y: number; }
export interface WorldZone { id: string; name: string; emoji: string; x: number; y: number; }
interface BuildingDef {
  id: string;
  layer1: string;
  layer2?: string;
  x: number; y: number;       // world pixel position (top-left)
  width: number; height: number;
}
interface DecorDef {
  file: string;               // path under assets/pixel/office/garden/
  x: number; y: number;       // world % (anchor at bottom-center for natural layering)
  w?: number;                 // optional % width override (defaults to 48px)
}
interface AgentDeskRef {
  building: string;
  localX: number;             // % of building width
  localY: number;             // % of building height
}

export const WORLD_LAYOUT = {
  // World canvas — characters use % of these dims as their coordinate space.
  worldWidth: 1400,
  worldHeight: 700,

  // Pre-built scene PNGs/GIFs anchored at fixed world pixel positions.
  // Single office building — cafe + garden were rolled back. User will add
  // back / build new maps themselves.
  buildings: [
    {
      id: 'office', layer1: 'Office_Design_2.gif',
      x: 560, y: 90, width: 512, height: 544,
    },
  ] as BuildingDef[],

  // Walkways — empty for now. Add back once buildings are placed and paths make sense.
  paths: [],

  // Garden decorations — empty (rolled back).
  decorations: [] as DecorDef[],

  // Each agent's primary desk — building-local % coords.
  // Top cubicle row chairs at office y≈30%; agents stand in aisle at y=38%.
  // Middle row chairs at y≈47%; agents stand at y=58%.
  // CEO's private office has a baked-in character at the desk — our CEO
  // stands in the open area of the room (right side, not overlapping).
  agents: {
    youtube:   { building: 'office', localX: 28, localY: 38 },
    instagram: { building: 'office', localX: 46, localY: 38 },
    designer:  { building: 'office', localX: 64, localY: 38 },
    business:  { building: 'office', localX: 82, localY: 38 },
    developer: { building: 'office', localX: 28, localY: 58 },
    secretary: { building: 'office', localX: 82, localY: 58 },
    ceo:       { building: 'office', localX: 88, localY: 88 },
    editor:    { building: 'office', localX: 18, localY: 78 },
    writer:    { building: 'office', localX: 50, localY: 78 },
    researcher:{ building: 'office', localX: 70, localY: 78 },
  } as Record<string, AgentDeskRef>,

  // Visit-zones for idle wandering / autonomous behavior. Office-only.
  // Cafe + garden zones were rolled back along with their assets.
  zones: [
    { id: 'office-meeting', name: '회의실',  emoji: '📊',  x: 49, y: 78 },  // office bottom-left meeting room
    { id: 'office-copier',  name: '복사실',  emoji: '🖨️', x: 70, y: 18 },  // office top printer
  ] as WorldZone[],
};

/** Hand-tuned agent positions for the user's AI-generated office map at
 *  `assets/map.jpeg`. Coordinates are % of the world canvas — each places the
 *  agent at a real desk/seat in their room, avoiding walls and furniture.
 *  The y values anchor agent FEET (sprite is 96px tall, feet at bottom). */
export const CUSTOM_MAP_DESKS: Record<string, DeskPos> = {
  // Top-left CEO solo office (glass-walled, "Agent OS" sign on wall)
  ceo:        { x: 8,  y: 22 },
  // Front desk just outside CEO's office — Secretary station
  secretary:  { x: 18, y: 33 },
  // Top-right twin workstation pairs
  youtube:    { x: 87, y: 18 },
  instagram:  { x: 87, y: 32 },
  // Mid-left small glass meeting pod (used as Designer's focused space)
  designer:   { x: 13, y: 47 },
  // Center cubicle cluster (6 desks, agents at 4 of them)
  developer:  { x: 41, y: 53 },
  business:   { x: 51, y: 53 },
  editor:     { x: 41, y: 63 },
  writer:     { x: 51, y: 63 },
  // Bottom-center small admin desks — Researcher
  researcher: { x: 33, y: 82 },
};

/** Convert each agent's building-local desk into world % coords. */
export function buildWorldDeskPositions(): Record<string, DeskPos> {
  const out: Record<string, DeskPos> = {};
  for (const [id, ref] of Object.entries(WORLD_LAYOUT.agents)) {
    const b = WORLD_LAYOUT.buildings.find(bb => bb.id === ref.building);
    if (!b) continue;
    const worldPxX = b.x + (ref.localX / 100) * b.width;
    const worldPxY = b.y + (ref.localY / 100) * b.height;
    out[id] = {
      x: (worldPxX / WORLD_LAYOUT.worldWidth) * 100,
      y: (worldPxY / WORLD_LAYOUT.worldHeight) * 100,
    };
  }
  return out;
}

// Two layouts supported:
//   1) Nested (default, v2.58): company at `<brain>/_company/`. Same git
//      repo, brain stays clean at root, _company/ collapses under one
//      prefix. Best for solo users who want one backup.
//   2) Detached (v2.59): user sets `agentOs.companyDir` to an absolute
//      path. Company lives wherever they want — e.g., team-shared folder,
//      separate git repo, different cloud sync. Brain stays at brain root,
//      independent.
/* COMPANY_SUBDIR, _resolvePathInput, getCompanyDir 모두 ./paths.ts 로 이동.
   COMPANY_INTERNAL_DIRS 도 src/brain/walk.ts 로 이동 — 사용처가 모두 brain
   walking 이라 brain 도메인에 더 자연스러움. extension.ts 는 re-export 만. */

/* One-shot migration: when the user upgrades from a layout where company
   files lived at the brain root, transparently move them under _company/.
   Runs at activation. Idempotent — does nothing if already migrated. */

export async function setCompanyDir(absPath: string) {
  // Redirects to localBrainPath: choosing a company location now means
  // choosing where the brain (and therefore the company) lives.
  try {
    const cfg = vscode.workspace.getConfiguration('agentOs');
    await cfg.update('localBrainPath', absPath, vscode.ConfigurationTarget.Global);
  } catch {
    if (_extCtx) {
      try { await _extCtx.globalState.update('localBrainPath', absPath); } catch {}
    }
  }
}

/* v2.89.16 — YouTube creds 자동 동기화. API 패널 v2.89.14 이전엔 키를 config.md에만
   저장했고 tools/youtube_account.json은 그대로 빈 채로. 도구 실행 시 빈 값 보고
   "API 키 없음" 에러. 활성화 시 한 번 점검해서 누락된 값 자동 복구. */
export function getCompanyMetrics(): cmp.CompanyMetrics {
    return cmp.readMetrics(_getBrainDir());
}

/** Returns the company's "Day N" relative to when the user first set up the
 *  company. First call also stamps `foundedAt` so the counter is stable across
 *  PCs that share the brain folder via GitHub. Returns 1 on day 0. */
export function getCompanyDay(): number {
    try {
        const brain = _getBrainDir();
        const m = cmp.readMetrics(brain);
        if (!m.foundedAt) {
            cmp.updateMetrics(brain, { foundedAt: new Date().toISOString().slice(0, 10) });
            return 1;
        }
        return Math.max(1, cmp.daysSinceFounding(brain) + 1);
    } catch { return 1; }
}

export function updateCompanyMetrics(updates: Partial<cmp.CompanyMetrics>) {
    cmp.updateMetrics(_getBrainDir(), updates);
}

function _extractCompanyName(idMd: string): string {
    return cmp.extractCompanyNameFromMd(idMd);
}

export function isCompanyConfigured(): boolean {
    return cmp.isConfigured(getCompanyDir());
}

export function readCompanyName(): string {
    return cmp.readCompanyName(getCompanyDir());
}

/* v2.89.103 — 채용 잠금 시스템. 일부 에이전트(현재: editor=루나)는 기본 잠금
   상태로 시작하고, 사용자가 PIN(0000)을 입력해야 활성화됨. 이력서·게임적 보상감
   조성 + 출시 단계 분리(루나는 "입사 준비 중" 컨셉). */
export const LOCKED_AGENTS_DEFAULT: Record<string, boolean> = { editor: true };

/* v2.89.107 — 활성/비활성 토글 시스템 (Option B).
   Luna(editor) 외에 매일 안 쓰일 가능성 큰 specialist는 기본 비활성으로 시작.
   사용자가 직원 패널에서 카드 클릭 → 활성화 confirm → 사용 가능.
   ALWAYS_ON: 핵심 워크플로우용 — 항상 활성, 토글 불가.
   OPTIONAL: 기본 비활성, 사용자 opt-in 시 활성화 (PIN 안 받음 — Luna만 PIN).
   기존 사용자 migration: hired.json에 entry 있으면 모든 OPTIONAL 자동 활성화. */
/* v2.89.110 — 자율성 + 합리적 기본값 균형. 4-tier:
   1. ALWAYS_ON: 시스템 요구 (off 불가)
   2. DEFAULT_ON: 첫 진입 시 자동 활성화. 사용자가 언제든 OFF 가능.
   3. OPTIONAL (DEFAULT_OFF): 기본 비활성, 사용자 opt-in.
   4. LOCKED (Luna): PIN 필요.
   v2.89.109가 너무 보수적이어서 (CEO만 ON) 새 사용자가 회사 모드 켜고 "유튜브 분석해줘"
   하면 빈 plan 나오는 사고. 핵심 4명을 기본 ON으로 되돌려 첫 경험 회복. */
export const ALWAYS_ON_AGENTS: Set<string> = new Set(['ceo']);
/* v2.89.156 — 데모용·신규 사용자 첫 경험 회복. "유튜브 + 매출 종합 보고서" 같은 합성 명령에서
   현빈(business) 가 비활성이라 조용히 drop 되던 사고 차단. 옵션 전체를 기본 ON 으로. Luna 만 LOCKED 유지.
   사용자는 언제든 직원 패널에서 개별 OFF 가능. */
const DEFAULT_ON_AGENTS: Set<string> = new Set(['secretary', 'writer', 'designer', 'instagram', 'business', 'developer', 'researcher']);
export const OPTIONAL_AGENTS_DEFAULT: Set<string> = new Set(['secretary', 'writer', 'designer', 'instagram', 'business', 'developer', 'researcher']);

// ──────────────────────────────────────────────────────────────────
// Agent state — extension-side thin wrappers
// 본문은 src/agent-state/{hired,active,models,autonomy}.ts.
// LOCKED_AGENTS_DEFAULT / ALWAYS_ON_AGENTS / OPTIONAL_AGENTS_DEFAULT 는
// 위 상수 (line 472, 477, 481) 를 wrapper 에서 그대로 사용 — 모듈에 주입.
// ──────────────────────────────────────────────────────────────────

/* v2.89.65 — system-specs 헬퍼는 _autoOrchestrateModelMap 외에도 (estimateModelMemoryGB)
   여러 콜사이트에서 직접 쓰이므로 top-level import 로 끌어올린다. */
import { SystemSpecs, getSystemSpecs, estimateModelMemoryGB } from './system-specs';

function _hiredJsonPath(): string { return st.hiredJsonPath(getCompanyDir()); }
function _activeJsonPath(): string { return st.activeJsonPath(getCompanyDir()); }

export function readHiredAgents(): Record<string, { hiredAt: string }> {
  return st.readHired(getCompanyDir());
}

export function isAgentHired(id: string): boolean {
  /* 잠금 대상이 아니면 항상 채용된 상태 — 모듈 isHired 는 LOCKED 무지(map 만 봄)이라
     여기서 분기 처리. */
  if (!LOCKED_AGENTS_DEFAULT[id]) return true;
  return st.isHired(getCompanyDir(), id);
}

export function markAgentHired(id: string): boolean {
  return st.markHired(getCompanyDir(), id);
}

export function readActiveAgents(): Record<string, { activatedAt: string }> {
  return st.readActive(getCompanyDir()) as Record<string, { activatedAt: string }>;
}

/* 핵심 헬퍼: 에이전트가 현재 사용 가능한지.
   - ALWAYS_ON: 무조건 true
   - LOCKED (Luna): hired.json 에 entry 있으면 true (PIN 통과)
   - OPTIONAL: active.json 에 entry 있으면 true
   - 그 외 (정의 안 된 에이전트): true (기본값)
   ALWAYS_ON 와 "기본 true" 분기는 모듈에서 알 수 없으므로 wrapper 가 처리. */
export function isAgentActive(id: string): boolean {
  if (ALWAYS_ON_AGENTS.has(id)) return true;
  if (LOCKED_AGENTS_DEFAULT[id]) return isAgentHired(id);
  if (OPTIONAL_AGENTS_DEFAULT.has(id)) {
    return st.isActive(getCompanyDir(), id, LOCKED_AGENTS_DEFAULT);
  }
  return true;
}

export function setAgentActive(id: string, active: boolean): boolean {
  return st.setActive(getCompanyDir(), id, active);
}

export function isAgentTogglable(id: string): boolean {
  return OPTIONAL_AGENTS_DEFAULT.has(id) || !!LOCKED_AGENTS_DEFAULT[id];
}

/* Claude CLI 전환 후 코더 전용 모델 추천은 의미 없음 — 코다리는 heavy(Opus) tier 고정.
   no-op 으로 남겨서 콜사이트 호환만 유지. */
export function _maybeRecommendCoderModel(_webview: vscode.Webview) { /* no-op */ }

function _agentModelsPath(): string { return st.modelsJsonPath(getCompanyDir()); }
export function readAgentModelMap(): Record<string, string> { return st.readModelMap(getCompanyDir()); }
export function writeAgentModelMap(map: Record<string, string>): void { st.writeModelMap(getCompanyDir(), map); }
export function getAgentModel(agentId: string, fallback: string): string {
  return st.getModelFor(getCompanyDir(), agentId, fallback);
}
function _classifyModel(modelId: string): st.ModelTier[] { return st.classifyModel(modelId); }
export function _autoOrchestrateModelMap(installed: { id: string; backend: string }[]): Record<string, string> {
  return st.autoOrchestrate(installed, AGENT_ORDER);
}

/* Claude CLI 전환 후 모델 리스트는 3-tier 고정 — Opus 4.7 / Sonnet 4.6 / Haiku 4.5.
   기존 호출 사이트(오케스트레이션 드롭다운, 에이전트 도크 등)와 호환되도록
   같은 시그니처 유지. */
export async function listInstalledModels(): Promise<{ id: string; backend: 'claude' }[]> {
  return [
    { id: 'claude-opus-4-7', backend: 'claude' },
    { id: 'claude-sonnet-4-6', backend: 'claude' },
    { id: 'claude-haiku-4-5-20251001', backend: 'claude' }
  ];
}

/* v2.89.14 / v2.89.39 — 회사 이름 동적 치환. 프롬프트 상수에 \`{{COMPANY}}\` 플레이스홀더를
   넣고 런타임에 사용자 회사명으로 치환. 회사명 미설정 시 "1인 기업" 같은 일반 표현으로.
   v2.89.39 이전엔 "JAY CORP"가 디폴트로 남아서 이 제품을 다른 사람이 쓸 때도 그 이름이
   나왔음 — 공용 배포 부적합. 이제 사용자별로 자기 회사명 또는 일반 명칭이 보임. */
export function _personalizePrompt(prompt: string): string {
  const name = (readCompanyName() || '').trim();
  const display = name && name !== 'JAY CORP' ? name : '1인 기업';
  /* 양방향 치환: {{COMPANY}} 플레이스홀더 + 레거시 "JAY CORP" 하드코딩 둘 다 처리.
     레거시 처리는 시드된 회사 폴더의 identity.md / decisions.md / 메모리 등에 이미
     "JAY CORP"가 박혀있는 사용자도 있어서 호환을 위해 유지. */
  return prompt.replace(/\{\{COMPANY\}\}/g, display).replace(/JAY CORP/g, display);
}

/* ── Company config: structured read + write ─────────────────────────────
   Pulls / writes the same identity.md + goals.md files the agents already
   read. Fields are parsed loosely so users editing by hand aren't punished.
   Empty / placeholder values come back as ''. */
// ──────────────────────────────────────────────────────────────────
// Company config — extension-side thin wrappers
// 본문은 src/company/config.ts. identity.md + goals.md 의 출력 포맷·regex
// 모두 모듈에서 그대로 보존. wrapper 는 companyDir 주입 + ensureCompanyStructure
// 콜만 책임.
// ──────────────────────────────────────────────────────────────────
export type CompanyConfig = cmp.CompanyConfig;

function _extractField(md: string, label: string): string {
    return cmp.extractField(md, label);
}

function _extractGoalLine(md: string, header: string): string {
    return cmp.extractGoalLine(md, header);
}

export function readCompanyConfig(): CompanyConfig {
    return cmp.readConfig(getCompanyDir());
}

export function writeCompanyConfig(cfg: Partial<CompanyConfig>) {
    /* 회사 폴더 전체 구조(에이전트 서브디렉터리 등) 생성은 wrapper 책임 — 모듈은
       자기 파일 dir 만 mkdir 한다. */
    ensureCompanyStructure();
    cmp.writeConfig(getCompanyDir(), cfg);
}

// ──────────────────────────────────────────────────────────────────
// Telegram — extension-side thin wrappers over src/telegram/*
// 본문은 src/telegram/{config,client,markdown}.ts 로 추출됨 (god-file 분해).
// 콜사이트 시그니처 호환을 유지하기 위해 같은 이름의 wrapper 만 남김.
// companyDir / userBrain 주입은 여기서 처리.
// ──────────────────────────────────────────────────────────────────

const _TELEGRAM_USER_BRAIN = path.join(os.homedir(), '.connect-ai-brain');

export function readTelegramConfig(): tg.TelegramConfig {
  return tg.readTelegramConfig(getCompanyDir());
}

export async function sendTelegramReport(text: string): Promise<boolean> {
  return tg.sendReport(text, readTelegramConfig());
}

export async function sendTelegramLong(text: string): Promise<boolean> {
  return tg.sendLong(text, readTelegramConfig());
}

export async function sendTelegramTyping(): Promise<void> {
  return tg.sendTyping(readTelegramConfig());
}

// ============================================================
// 📱 Telegram bidirectional bot (v2.51) — commands + CEO routing
// ============================================================
// Polls Telegram getUpdates so the user can drive the AI company from
// outside the editor. Whitelisted to the configured chat_id (no one else
// can issue commands even if they find the bot). Free-text messages get
// classified by a lightweight CEO call and forwarded to the right
// specialist via the existing sidebar provider.

let _telegramPollTimer: NodeJS.Timeout | null = null;
let _telegramPollOffset = 0;
let _telegramPolling = false;

/* Short-term Telegram conversation memory — ring buffer + jsonl persistence.
   본체는 src/telegram/history.ts 로 추출. extension 측에서는 cross-cutting
   concern (appendConversationLog 호출) 만 wrapper 에서 처리. */

// ──────────────────────────────────────────────────────────────────
// Active dispatch — extension-side thin wrappers
// 본문은 src/dispatch/active.ts. 중복 디스패치 감지 + step 추적.
// ──────────────────────────────────────────────────────────────────
type ActiveDispatch = dsp.ActiveDispatch;

export function _findActiveDispatch(prompt: string): ActiveDispatch | null {
  return dsp.find(prompt);
}
export function _startActiveDispatch(prompt: string, fromTelegram: boolean): ActiveDispatch {
  return dsp.start(prompt, fromTelegram);
}
export function _updateActiveDispatchStep(prompt: string, step: string) {
  dsp.updateStep(prompt, step);
}
export function _endActiveDispatch(prompt: string) {
  dsp.end(prompt);
}
export function _pushTelegramHistory(role: 'user' | 'assistant', text: string) {
  if (!text || !text.trim()) return;
  tg.pushHistory(role, text, getCompanyDir());
  /* Cross-cutting concern preserved — 같은 파일을 CEO planner / 자율
     chatter / corporate dispatches 가 다 읽기 때문에, Telegram turn 도
     여기 함께 기록해야 다른 에이전트가 "그 영상 어떻게 됐어?" 같은
     follow-up 을 자연스럽게 잇는다. */
  try {
    if (role === 'user') {
      appendConversationLog({ speaker: '사용자(텔레그램)', emoji: '📱', body: text.trim() });
    } else {
      appendConversationLog({ speaker: '비서', emoji: '💬', section: '텔레그램 응답', body: text.trim() });
    }
  } catch { /* logging must never break the flow */ }
}

export function _renderTelegramHistory(maxTurns = 8): string {
  return tg.renderHistory(getCompanyDir(), maxTurns);
}

/* Multi-window guard + polling offset persistence — 본체는 src/telegram/{lock,offset}.ts
   로 추출. _TELEGRAM_USER_BRAIN 은 유저 레벨 공유 위치 (~/.connect-ai-brain) 로
   안티그래비티 창마다 다른 워크스페이스라도 락이 단일하게 유지된다. */
export function _readTelegramOffset(): number { return tg.readOffset(_TELEGRAM_USER_BRAIN); }
export function _writeTelegramOffset(offset: number): void { tg.writeOffset(_TELEGRAM_USER_BRAIN, offset); }
export function _tryAcquireTelegramLock(): boolean { return tg.tryAcquireLock(_TELEGRAM_USER_BRAIN); }
export function _releaseTelegramLockIfOwned(): void { tg.releaseLockIfOwned(_TELEGRAM_USER_BRAIN); }


export const AUTONOMY_LABELS: Record<number, string> = {
    0: 'Off',
    1: 'Read-only',
    2: 'Draft → Approve',
    3: 'Auto'
};

export function readToolAutonomyLevel(agentId: string): number {
    return st.readAutonomyLevel(getCompanyDir(), agentId);
}




type ReportScheduleEntry = sch.ReportScheduleEntry;

/* Storage wrappers — used by scheduler/tick-runner.ts (imported back via
   '../extension') as well as direct callers (UI panels). */
export function readReportSchedule(): { entries: ReportScheduleEntry[] } { return sch.readSchedule(getCompanyDir()); }
export function writeReportSchedule(s: { entries: ReportScheduleEntry[] }) { sch.writeSchedule(getCompanyDir(), s); }

/* `_reportSchedulePath`, `_reportSchedulerTimer`, `_runScheduledReportEntry`,
   `_scheduleTick`, `startReportScheduler` 모두 scheduler/tick-runner.ts 로
   이동. activate() 는 위에서 import 한 `startReportScheduler` 를 그대로 호출. */



/* ── Google Calendar OAuth (write) ────────────────────────────────────────
   Config lives in `_company/_agents/secretary/tools/google_calendar_write.json`:
     { CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN, CALENDAR_ID, DEFAULT_DURATION_MINUTES,
       _CONNECTED_AS, _CONNECTED_AT }
   The wizard (runConnectGoogleCalendarWrite) walks the user through pasting
   their Client ID/Secret then runs the loopback OAuth dance and persists a
   refresh_token. Calendar events are created via createCalendarEventForTask
   when a tracker task has a due date. */

// ──────────────────────────────────────────────────────────────────
// Calendar — extension-side thin wrappers
// 본문은 src/calendar/* (config / token / crud / cache). HTTP 는 모듈 내부의
// HttpClient (axios DI) 가 담당. wrapper 는 companyDir 주입만.
// TrackerTask 의존 함수 (createCalendarEventForTask, updateCalendarEventForTask)
// 는 추출 안 함 — 이번 사이클은 HTTP 코어만.
// ──────────────────────────────────────────────────────────────────

type CalendarWriteConfig = cal.CalendarWriteConfig;

function _calendarWriteConfigPath(): string { return cal.configPath(getCompanyDir()); }
function readCalendarWriteConfig(): CalendarWriteConfig { return cal.readConfig(getCompanyDir()) || {}; }
function writeCalendarWriteConfig(cfg: CalendarWriteConfig) { cal.writeConfig(getCompanyDir(), cfg); }
export function isCalendarWriteConnected(): boolean { return cal.isConnected(getCompanyDir()); }
async function _getCalendarAccessToken(): Promise<string | null> { return cal.getAccessToken(getCompanyDir()); }

/* Tracker↔Calendar sync wrappers — close over companyDir so the rest of
   extension.ts (addTrackerTask / updateTrackerTask) can call them with a
   single TrackerTask argument. Implementation lives in
   src/calendar/tracker-sync.ts. */
function createCalendarEventForTask(task: TrackerTask): Promise<string | null> {
    return _createCalendarEventForTaskImpl(getCompanyDir(), task);
}
function updateCalendarEventForTask(task: TrackerTask): Promise<boolean> {
    return _updateCalendarEventForTaskImpl(getCompanyDir(), task);
}

// Calendar CRUD/cache wrappers — 본문은 src/calendar/*.

export async function deleteCalendarEvent(eventId: string): Promise<boolean> {
  return cal.deleteEvent(getCompanyDir(), eventId);
}

export async function patchCalendarEvent(
  eventId: string,
  opts: cal.PatchEventOpts
): Promise<cal.CalendarEventResult | null> {
  return cal.patchEvent(getCompanyDir(), eventId, opts);
}

export async function createCalendarEventDirect(
  opts: cal.CreateEventOpts
): Promise<cal.CalendarEventResult | null> {
  return cal.createEvent(getCompanyDir(), opts);
}

export async function findCalendarEvents(opts: cal.FindEventsOpts): Promise<cal.CalendarEvent[]> {
  return cal.findEvents(getCompanyDir(), opts);
}

export async function refreshCalendarCacheViaOAuth(daysAhead: number = 14): Promise<cal.RefreshCacheResult> {
  return cal.refreshCache(getCompanyDir(), daysAhead);
}

/* OAuth setup wizard — guides the user through Google Cloud setup, captures
   their Client ID/Secret, runs a loopback auth flow, and persists the
   refresh_token. Only Secretary owns this — keys live in Secretary's tool
   config so the rest of the system can find them via one stable path. */


/* Stale-task nudge loop body 는 src/loops/tracker-nudge.ts 로 이동.
   activate() 가 `startTrackerNudgeLoop()` 만 호출하면 모듈 내부에서 timer 와
   `_runTrackerNudgeOnce` 가 자체 관리됨. */

/* ── P0-3: Daily briefing auto-fire ─────────────────────────────────────
   Once per day at the user's configured time (default 09:00), Secretary
   builds and sends a "good morning" brief to Telegram covering:
     - Today's calendar (from calendar_cache.md)
     - Open tracker tasks (priority-sorted, top 5)
     - Yesterday's company highlights (last conversation log entries)
   Single-fire: tracks last-fired date in extension globalState so a VS Code
   restart at 09:30 doesn't double-send. */
let _dailyBriefingTimer: NodeJS.Timeout | null = null;
const _DAILY_BRIEFING_KEY = 'dailyBriefingLastSentDate';

function _parseBriefingTime(raw: string): { hour: number; minute: number } | null {
    if (!raw || raw.trim() === '' || raw.trim().toLowerCase() === 'off') return null;
    const m = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const hour = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return { hour, minute };
}




/* ── v2.89.137 — Revenue Watcher (PayPal polling) ──────────────────────────
   5분마다 paypal_revenue.py OUTPUT=json 호출 → 마지막 본 transaction id 와
   비교 → 새 결제 발견 시 텔레그램 푸시 + 사무실 영숙 책상 펄스. paypal 미설정
   시 silently skip. 이게 진짜 "AI 회사가 자고 있어도 결제 알아차림" 의 코어. */
let _revenueWatcherTimer: NodeJS.Timeout | null = null;
const _REVENUE_LAST_SEEN_KEY = 'revenueLastSeenTxId';
const _REVENUE_LAST_SEEN_TS_KEY = 'revenueLastSeenTxTs';
const REVENUE_POLL_INTERVAL_MS = 5 * 60 * 1000; /* 5분 */




/* ── Task tracker ─────────────────────────────────────────────────────────
   Live followups for "이거 해 / 저거 해" style commands. Every dispatched
   task or user-owned commitment lands here; Secretary scans periodically
   to mark agent-side completions and nudge stale user-side items via
   Telegram. Single source of truth: _shared/tracker.json (structured so
   queries are fast and consistent).

   Schema:
     { "tasks": [ {id, title, description, owner, agentIds, createdAt,
                   dueAt, status, completedAt, sessionDir, nudges} ] }
       owner ∈ 'agent' | 'user' | 'mixed'
       status ∈ 'pending' | 'in_progress' | 'done' | 'cancelled' */

// ──────────────────────────────────────────────────────────────────
// Tracker — extension-side thin wrappers + EventEmitter glue
// 본문은 src/tracker/{types,io,mutations,recurrence}.ts. EventEmitter 는
// vscode 의존이라 여기 남아서 writeTracker wrapper 가 fire(). 캘린더 사이드
// 이펙트(addTask·updateTask 후 createCalendarEventForTask/delete/patch) 도
// 여기서 합성한다.
// ──────────────────────────────────────────────────────────────────
export type TaskPriority = trk.TaskPriority;
export const TASK_PRIORITY_ORDER = trk.TASK_PRIORITY_ORDER;
export const TASK_PRIORITY_LABEL = trk.TASK_PRIORITY_LABEL;
export type TrackerTask = trk.TrackerTask;

/* `_coercePriority` 는 src/tracker/ui-helpers.ts 로 이동 — 위에서 import + re-export. */
function _trackerPath(): string { return trk.trackerPath(getCompanyDir()); }
export function readTracker(): { tasks: TrackerTask[] } { return trk.readTracker(getCompanyDir()); }

/* Module-level event emitter so the sidebar Task TreeView auto-refreshes
   whenever the tracker file is modified through writeTracker (no matter who
   calls it — Secretary, autoMark, edit commands, recurrence loop). */
const _trackerChangeEmitter = new vscode.EventEmitter<void>();
export const onTrackerChanged = _trackerChangeEmitter.event;

/* ── P0-4: Approval gate ──────────────────────────────────────────────────
   When an agent wants to do something risky (deploy, send, post, delete)
   the action lands as a markdown file in approvals/pending/ instead of
   executing. Secretary fires a Telegram card; user types /approve <id> or
   /reject <id> (or taps in the sidebar) to release or kill the action.
   File-based on purpose:
     - Survives restarts (no in-memory state)
     - Visible in git history (audit log)
     - User can grep/edit before approving */
// ──────────────────────────────────────────────────────────────────
// Approvals gate — extension-side thin wrappers + side effects
// 본문 파일 IO 는 src/approvals/*. spawnSync executor / Telegram card /
// conversation log / panel refresh / agent pulse 같은 vscode/integration
// 사이드 이펙트는 wrapper 에서 합성한다.
// ──────────────────────────────────────────────────────────────────
type PendingApproval = apv.PendingApproval;

export function _approvalsPendingDir(): string { return apv.pendingDir(getCompanyDir()); }
function _approvalsHistoryDir(): string { return apv.historyDir(getCompanyDir()); }
function _approvalsExecutorsDir(): string { return apv.executorsDir(getCompanyDir()); }
function _approvalNewId(): string { return apv.newApprovalId(); }

function createApproval(req: Omit<PendingApproval, 'id' | 'createdAt'>): PendingApproval {
    const ap = apv.createApproval(getCompanyDir(), req, {
        agentLabel: (id: string) => AGENTS[id]?.name ? `${AGENTS[id].emoji} ${AGENTS[id].name}` : undefined,
    });
    const a = AGENTS[ap.agentId];
    const ownerLine = a ? `${a.emoji} ${a.name}` : ap.agentId;
    /* Telegram card + conversation log + panel refresh — 모두 vscode/통합
       사이드 이펙트라 wrapper 측에서 처리. */
    sendTelegramReport(`⏳ *승인 대기 (${ownerLine})*\n\n${ap.title}\n\n${ap.summary.slice(0, 300)}\n\n_승인: \`/approve ${ap.id.slice(-9)}\` · 거부: \`/reject ${ap.id.slice(-9)}\`_`).catch(() => { /* silent */ });
    try { appendConversationLog({ speaker: ownerLine, emoji: '⏳', section: '승인 요청', body: `${ap.title} (${ap.kind})\n${ap.summary.slice(0, 300)}` }); } catch { /* ignore */ }
    try {
        _activeChatProvider?.pulseAgent?.(ap.agentId, '⏳', 3500, `${ap.title} 승인 요청`);
        _activeChatProvider?.pulseAgent?.('secretary', '🔔', 3500);
    } catch { /* ignore */ }
    try { _approvalsPanelProvider?.refresh(); } catch { /* ignore */ }
    return ap;
}

export function listPendingApprovals(): PendingApproval[] { return apv.listPending(getCompanyDir()); }

function findApprovalByShortId(short: string): PendingApproval | null {
    return apv.findByShortId(getCompanyDir(), short);
}

export async function resolveApproval(id: string, decision: 'approved' | 'rejected', reason: string = ''): Promise<{ ok: boolean; message: string; ap?: PendingApproval }> {
    /* Executor callback — approved 시에만 호출됨. spawnSync 기반 격리 실행은
       VS Code 측 책임이라 wrapper 에서 주입. throw 해도 ok:true 로 끝남
       (모듈이 FAIL 마커 audit md 에 기록). */
    const executor: apv.ApprovalExecutor = async (approval) => {
        const execPath = path.join(_approvalsExecutorsDir(), `${approval.kind}.js`);
        if (!fs.existsSync(execPath)) {
            return { ok: true, output: `(no executor for ${approval.kind} — approval recorded, manual follow-up)` };
        }
        const res = spawnSync('node', [execPath], {
            cwd: getCompanyDir(),
            encoding: 'utf-8',
            timeout: 60000,
            input: JSON.stringify(approval.payload),
        });
        const output = (res.stdout || '') + (res.stderr ? `\n[stderr]\n${res.stderr}` : '');
        return { ok: res.status === 0, output };
    };
    const result = await apv.resolveApproval(getCompanyDir(), id, decision, reason, executor);
    if (!result.ok || !result.ap) return result;
    /* Audit 한 줄도 wrapper 에서 — conversation log 는 vscode 측 sink. */
    const ap = result.ap;
    const a = AGENTS[ap.agentId];
    const ownerLine = a ? `${a.emoji} ${a.name}` : ap.agentId;
    try {
        appendConversationLog({
            speaker: ownerLine,
            emoji: decision === 'approved' ? '✅' : '✖️',
            section: '승인 결과',
            body: `${ap.title} (${ap.kind}) → ${decision}${reason ? '\n사유: ' + reason : ''}`,
        });
    } catch { /* ignore */ }
    return result;
}

/* P1-9: YouTube comment-reply queue ──────────────────────────────────────
   Pulls recent top-level comments on the user's channel via YouTube Data
   API v3 (read-only, just an API key — no OAuth needed for this part),
   drafts a reply per comment using the local LLM, lands each draft as a
   pending approval. User /approves to release; the executor (separate, OAuth
   required) actually posts. This split means a partial OAuth setup still
   gives the user the queue UX. Idempotent — won't re-queue a comment that
   already has a pending approval. */
/* P1-10: Developer project scaffolder ────────────────────────────────────
   Creates `_company/projects/<name>/` with a minimal working web template
   so the Developer agent (and the user) have a real folder to iterate in.
   Three templates cover the common cases:
     - vite-vanilla: dependency-free dev server, no React
     - vite-react:   React + TS for app-style projects
     - static:       single index.html with Tailwind CDN — for landing pages
   We don't run npm install — that's a privileged action, the user runs it
   when they're ready. We DO write a README that tells them the next steps. */


/* Tracker IO wrappers — emitter + calendar side effects 합성. 본문은
   trk 모듈. wrapper 만 vscode/calendar 의존 결합. */
function writeTracker(t: { tasks: TrackerTask[] }) {
  trk.writeTracker(getCompanyDir(), t);
  try { _trackerChangeEmitter.fire(); } catch { /* no listeners — fine */ }
}

function _trackerNewId(): string { return trk.newTaskId(); }

export function addTrackerTask(partial: Partial<TrackerTask> & { title: string; owner: TrackerTask['owner'] }): TrackerTask {
  const task = trk.addTask(getCompanyDir(), partial);
  try { _trackerChangeEmitter.fire(); } catch { /* no listeners — fine */ }
  /* Auto-create Google Calendar event when due is set + Calendar is wired.
     Fire-and-forget — never blocks tracker creation. */
  if (task.dueAt && isCalendarWriteConnected()) {
    createCalendarEventForTask(task).then(eventId => {
      if (eventId) updateTrackerTask(task.id, { calendarEventId: eventId });
    }).catch(() => { /* silent — calendar errors shouldn't break tracker */ });
  }
  return task;
}

export function updateTrackerTask(id: string, patch: Partial<TrackerTask>): TrackerTask | null {
  const before = readTracker().tasks.find(x => x.id === id) || null;
  const cur = trk.updateTask(getCompanyDir(), id, patch);
  if (!cur) return null;
  try { _trackerChangeEmitter.fire(); } catch { /* no listeners — fine */ }
  /* Mirror tracker state to Google Calendar. Cancelled → delete; status/title/
     dueAt 변경 → patch. Best-effort. */
  if (before && cur.calendarEventId && isCalendarWriteConnected()) {
    const becameCancelled = patch.status === 'cancelled' && before.status !== 'cancelled';
    const titleOrDueChanged = (patch.title && patch.title !== before.title) || (patch.dueAt && patch.dueAt !== before.dueAt);
    const becameDone = patch.status === 'done' && before.status !== 'done';
    if (becameCancelled) {
      deleteCalendarEvent(cur.calendarEventId).then(ok => {
        if (ok) updateTrackerTask(cur.id, { calendarEventId: undefined });
      }).catch(() => { /* silent */ });
    } else if (becameDone || titleOrDueChanged) {
      updateCalendarEventForTask(cur).catch(() => { /* silent */ });
    }
  }
  return cur;
}

function listOpenTrackerTasks(): TrackerTask[] { return trk.listOpen(getCompanyDir()); }

/* Recurrence helpers — 본문 trk.parseLooseDate / trk.computeNextRunAt. */
export function _parseLooseDate(input: string): Date | null { return trk.parseLooseDate(input); }
function _computeNextRunAt(prev: Date, cadence: 'daily' | 'weekly' | 'monthly'): Date {
  return trk.computeNextRunAt(prev, cadence);
}

/* Recurrence loop 본문은 src/loops/recurrence.ts 로 이동. activate() 가
   `startRecurrenceLoop()` 만 호출. */


/* Pre-alarm loop 본문은 src/loops/pre-alarm.ts 로 이동. activate() 가
   `startPreAlarmLoop()` 만 호출. */


/* P1-5: Pull markdown checkbox items out of an agent's output. We accept
   `- [ ]`, `* [ ]`, and numbered `1. [ ]` forms so different agents'
   formatting all flow into one tracker. Only unchecked items count —
   `[x]` is already-done, and we don't try to retroactively register
   completed work. Capped to 5 per output to prevent runaway lists. */

/* `trackerToMarkdown` 본문은 src/tracker/ui-helpers.ts 로 이동. extension.ts
   는 위에서 import + re-export 만 한다. */

/* ── Task Tree View (sidebar) ─────────────────────────────────────────────
   P0-1: visualizes tracker.json as a clickable tree. Top level = status
   groups (진행중 / 대기 / 완료 / 취소). Children = task entries with
   priority chip, owner emoji, due, recurrence indicator. Inline actions
   (✅ / ✖️) come from package.json menus → registered commands.
   The tree auto-refreshes via onTrackerChanged. */

/* Map a priority level to a colored ThemeIcon for the group header. */

let _taskTreeProvider: TaskTreeProvider | null = null;

/* Heuristic: from a finished CEO dispatch (plan + outputs), find
   matching open tracker tasks (created within last 5 min by Secretary
   for THIS user request) and mark them done. Avoids LLM round-trip. */


export function _safeReadText(p: string): string {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; }
}


/* `_agentKeywords` / `_scoreRelevance` 본문은 src/brain/keywords.ts 로 이동.
   `_walkBrainMd` 와 `COMPANY_INTERNAL_DIRS` 는 src/brain/walk.ts 로 이동.
   extension.ts 는 위에서 import + re-export. `BrainSnippet` 은 src/brain/types.ts
   에 정식 정의가 있음 — 여기 inline 카피는 dead code 라 삭제. */

/* Graph RAG retrieval — minimal but meaningful implementation.
   Builds a lightweight knowledge graph from the brain folder where:
     - nodes  = wiki/raw markdown files
     - edges  = explicit `[[wikilinks]]` (directional, treated as undirected
                here for traversal) + co-occurrence on shared "anchor terms"
                (H1 titles + quoted phrases) above a small frequency threshold
   Then keyword-scores nodes against the agent's specialty (same as standard
   retrieval) to pick top-K SEEDS, BFS 1-hop from each seed to bring in
   connected notes that wouldn't match keywords directly, and emits a
   context block with both the seed and the connected neighbors annotated.
   This is intentionally educational: the user can compare against
   `readRelevantBrainContext` and see how Graph RAG surfaces 1-hop links
   that pure keyword search misses. */



function _slugifySkill(title: string): string {
  /* Keep Hangul / latin / digits, collapse the rest into '-'. Filenames are
     fine on macOS/Linux/Windows with Hangul; we don't transliterate. */
  let s = title.toLowerCase().replace(/^#+\s*/, '').trim();
  s = s.replace(/[\\/:*?"<>|]/g, ' ');
  s = s.replace(/\s+/g, '-');
  s = s.replace(/-+/g, '-');
  s = s.replace(/^-+|-+$/g, '');
  return s.slice(0, 60) || `skill-${Date.now()}`;
}


/** Distill `sourceText` into a reusable skill markdown and save it under
 *  `_agents/{agentId}/skills/<slug>.md`. Returns the saved path or an error.
 *  Uses _quickLLMCall — same lightweight path as Secretary classification. */


type RagMode = 'standard' | 'self-rag';
const RAG_MODES: RagMode[] = ['standard', 'self-rag'];

export function readAgentRagMode(agentId: string): RagMode {
  try {
    const p = path.join(getCompanyDir(), '_agents', agentId, 'rag_mode.txt');
    if (!fs.existsSync(p)) return 'standard';
    const v = fs.readFileSync(p, 'utf-8').trim().toLowerCase();
    return (RAG_MODES as string[]).includes(v) ? v as RagMode : 'standard';
  } catch { return 'standard'; }
}

export function writeAgentRagMode(agentId: string, mode: string) {
  const safe = (RAG_MODES as string[]).includes(mode) ? mode : 'standard';
  const dir = path.join(getCompanyDir(), '_agents', agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rag_mode.txt'), safe);
}

/* User-defined Self-RAG verification criteria. Plain markdown — agent reads
   it and appends to the standard self-critique protocol. Lets users tailor
   "what counts as grounded" to their domain (e.g. "any number must cite an
   actual data file", "thumbnail copy must be ≤5 words"). */
export function readAgentSelfRagCriteria(agentId: string): string {
  try {
    const p = path.join(getCompanyDir(), '_agents', agentId, 'self_rag_criteria.md');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
  } catch { return ''; }
}

/* `AgentTool` / `ToolField` 타입 + `_inferToolFieldType` / `listAgentTools`
   본문은 src/tracker/ui-helpers.ts 로 이동. extension.ts 는 위에서 import +
   re-export 만 한다. (의미상 tracker 와는 다른 도메인이지만, 단일
   ui-helpers 파일 통합을 위해 임시로 그곳에 같이 두었음.) */

export function writeToolConfig(agentId: string, toolName: string, config: Record<string, any>) {
  const p = path.join(getCompanyDir(), '_agents', agentId, 'tools', `${toolName}.json`);
  let existing: Record<string, any> = {};
  try {
    if (fs.existsSync(p)) existing = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch { /* malformed — overwrite cleanly */ }
  fs.writeFileSync(p, JSON.stringify({ ...existing, ...config }, null, 2));
}

/** Toggle a single tool's enabled flag without disturbing other config values. */
export function setToolEnabled(agentId: string, toolName: string, enabled: boolean) {
  const p = path.join(getCompanyDir(), '_agents', agentId, 'tools', `${toolName}.json`);
  let config: Record<string, any> = {};
  try {
    if (fs.existsSync(p)) config = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch { /* malformed — overwrite */ }
  if (enabled) {
    delete config._enabled; /* default is enabled, so absence === true */
  } else {
    config._enabled = false;
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2));
}

/* v2.91.x — `AGENT_TOOLS_CATALOG` 와 `_seedAgentToolsManifestIfMissing` 는
   `./seeds/manifest-and-goal.ts` 로 이동. extension.ts 는 dispatch 만 호출. */

/* v2.91.x — `_seedAgentToolsIfMissing` dispatch 함수와 `_seedBusinessPaypalRevenue`
   는 `./seeds/index.ts` & `./seeds/business.ts` 로 이동. */

/* v2.91.x — 모든 per-agent `_seedXxx*` 함수 (Instagram·Developer·Editor·YouTube·
   Secretary) + 헬퍼 (`_seedFile`/`_seedFileForceUpgrade`/`_mergeSchemaIntoJson`)
   는 `./seeds/` 디렉토리로 분리. 위 dispatch 가 import 해서 호출. */

/** Resolve the conversation log directory inside the user's brain folder.
 *  Lives at `<brain>/00_Raw/conversations/` so it joins the existing
 *  Second-Brain raw-knowledge convention — visible to the brain graph,
 *  synced by GitHub auto-sync, browsable in the user's note-taking app. */
// ──────────────────────────────────────────────────────────────────
// Conversation log — extension-side thin wrappers
// 본문은 src/conversation-log/log.ts. 모든 에이전트 산출물·대화가 누적되는
// 일자별 living transcript.
// ──────────────────────────────────────────────────────────────────
export function getConversationsDir(): string { return clog.conversationsDir(getCompanyDir()); }

export function appendConversationLog(entry: { speaker: string; emoji?: string; section?: string; body: string }) {
  clog.appendLog(getCompanyDir(), entry);
}

export function readRecentConversations(maxChars = 2500): string {
  return clog.readRecent(getCompanyDir(), maxChars);
}

export function makeSessionDir(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const dir = path.join(getCompanyDir(), 'sessions', ts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* Conversational CEO prompt — used for the casual-chat fast path so a "안녕"
   doesn't crash the JSON planner. Small models will reply with a polite
   greeting no matter how strict the JSON instruction; we detect those turns
   up front and route them here instead of fighting the model. */
/* Reads the user's chosen Secretary bridge scope. The setting controls how
   much of the user↔company interaction Secretary mediates:
     off          — Secretary only handles Telegram. Sidebar talks to CEO direct.
     output_only  — sidebar input goes to CEO as before, but Secretary writes
                    a 1-line "사장님께 정리" card after each dispatch.
     full         — sidebar input also goes to Secretary first; Secretary
                    either replies directly or escalates to CEO planner.
   Exposed as a setting (not a memory) because it changes runtime routing
   meaningfully and the user should be able to flip it from the standard VS
   Code settings UI. Educational toggle in the spirit of feedback_educational_toggles. */
type SecretaryBridgeMode = 'off' | 'output_only' | 'full';
export function readSecretaryBridgeMode(): SecretaryBridgeMode {
    try {
        const cfg = vscode.workspace.getConfiguration('agentOs');
        const v = (cfg.get<string>('secretaryBridgeMode') || 'off').trim().toLowerCase();
        if (v === 'output_only' || v === 'full') return v;
    } catch { /* fall through to default */ }
    return 'off';
}

/* Lightweight JSON triage prompt — used only when bridge mode is 'full'.
   Secretary decides whether the user's sidebar message is something it can
   answer itself (greeting, schedule lookup, simple Q&A) or needs to be
   escalated to the CEO planner for multi-agent work. Output is strict JSON
   so we can branch deterministically. */
/* Heuristic for "this is small talk, not a work order". When true we skip
   the JSON planner and just have CEO chat back. Conservative: only matches
   short greetings/acks; anything longer or with action verbs falls through
   to the full planner. */

/* v2.87.11 — 에이전트가 외부 API에 의존할 때, 자격증명이 없으면 그 사실을
   에이전트 본인이 알고 사용자에게 입력해달라고 응답해야 함. 이 함수가
   sysPrompt에 명시적인 config 상태 블록을 주입한다. 키가 비어있으면 강제로
   "사용자에게 입력 요청하세요" 지시 포함. */
/* v2.89.10 — 진짜 데이터 prefetch. LLM 호출 전 시스템이 직접 도구 실행해서
   결과를 컨텍스트로 강제 주입. 이전 패턴은 에이전트가 <run_command>를 자발적
   출력해야만 발동됐는데, 작은 LLM은 자주 안 함 → 거짓말 (placeholder 데이터)
   양산. 이제 prefetch 결과가 있으면 에이전트가 거짓말 못 함 — 진짜 숫자 보고
   답하거나 "데이터에 없음"이라고 솔직히 말하거나. */


export let _activeChatProvider: SidebarChatProvider | null = null;
export let _extCtx: vscode.ExtensionContext | null = null;

export function activate(context: vscode.ExtensionContext) {
    vscode.window.showInformationMessage('🔥 Agent OS V2 활성화 완료!');
    console.log('Agent OS extension activated.');

    _extCtx = context;
    /* v2.89.138 — extensionUri 즉시 세팅. 이전엔 "우리 회사 대시보드" 명령
       처음 열기 전엔 _dashboardExtensionUri=null 이라 ApiConnectionsPanel /
       RevenueDashboardPanel 가 _loadWebviewAsset() 으로 빈 CSS·JS 받음 →
       헤더만 보이고 카드·차트 텅 빈 사고. activate 시점에 박아두면 모든
       webview 가 즉시 asset 사용 가능. */
    _dashboardExtensionUri = context.extensionUri;
    /* v2.89.152 — pythonPath 설정 변경 시 캐시 무효화. 사용자가 외부 연결 패널이나
       설정에서 Python 경로 바꾸면 다음 도구 실행부터 새 경로 사용. */
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('agentOs.pythonPath')) {
                _invalidatePythonCmdCache();
                vscode.window.setStatusBarMessage('🐍 Python 경로 설정 변경 — 다음 도구 실행 시 적용', 4000);
            }
        })
    );
    _migrateCompanyToBrain();
    /* v2.58: nest all company files under _company/ for visual clarity.
       Runs once for users coming from the unified-root layout. */
    _migrateCompanyToSubdir();
    /* v2.89.16 — YouTube creds 자동 동기화. 기존 사용자가 API 패널에 키를
       입력했는데 config.md에만 들어가고 tools/youtube_account.json에는 안
       들어가서 도구들이 "키 없음" 에러 내던 케이스 자동 복구. */
    _migrateYouTubeCredsToCanonical();
    /* v2.89.22 — 활성화 시 회사 구조 보장 → 새로 추가된 도구 파일들 자동 시드.
       _seedFile은 기존 파일 안 덮어쓰니까 idempotent. 새 빌드의 신규 도구
       (예: channel_full_analysis.py)가 기존 사용자한테도 즉시 추가됨. */
    try {
        if (isCompanyConfigured()) ensureCompanyStructure();
    } catch (e: any) {
        console.warn('[activation] ensureCompanyStructure failed:', e?.message || e);
    }
    /* v2.89.25 — Day 카운터 영속화. foundedAt이 없으면 오늘로 한 번 stamp.
       이미 있으면 그대로 보존 — 그래야 며칠 지나면 Day 2, 3, 4… 정상 증가. */
    try {
        const m = getCompanyMetrics();
        if (!m.foundedAt) {
            const today = new Date().toISOString().slice(0, 10);
            updateCompanyMetrics({ foundedAt: today });
            console.log('[Day counter] foundedAt stamped:', today);
        }
    } catch (e: any) {
        console.warn('[activation] foundedAt stamp failed:', e?.message || e);
    }
    /* v2.89.27 — 첫 활성화 시 모델 자동 오케스트레이션. 사용자가 손대지 않아도
       설치된 모델로 가장 적합한 매핑이 깔림. 이미 매핑이 있으면 그대로 유지. */
    (async () => {
        try {
            if (!isCompanyConfigured()) return;
            const existing = readAgentModelMap();
            if (Object.keys(existing).length > 0) return; /* 이미 사용자 셋업 — 건드리지 않음 */
            const installed = await listInstalledModels();
            if (installed.length === 0) return; /* 설치 모델 없음 — 사용자가 ollama pull 후 자동 적용 */
            const auto = _autoOrchestrateModelMap(installed);
            if (Object.keys(auto).length > 0) {
                writeAgentModelMap(auto);
                console.log('[auto-orchestrate] initial model map:', auto);
            }
        } catch (e: any) {
            console.warn('[auto-orchestrate] failed:', e?.message || e);
        }
    })();
    const provider = new SidebarChatProvider(context.extensionUri, context);
    _activeChatProvider = provider;
    // Autonomous-company runtime: idle auto-cycle.
    // 모닝 브리핑은 더 이상 활성화 시점에 자동 발사하지 않습니다 — 일부
    // 사용자(자원이 빠듯한 PC + 처음 확장을 켠 직후 Ollama 차가운 상태)에서
    // 12초 뒤 자동 호출이 "model failed to load"로 실패해 사용자가 무엇이
    // 잘못됐는지 모르는 채로 에러를 보는 케이스가 보고됨.
    // 사용자가 1인 기업 모드(👔)를 직접 켜는 시점에 그날의 첫 브리핑이 흐릅니다.
    // 24시간 ON의 진짜 의미: idle 여부와 상관없이 15분마다 CEO 사이클.
    // 사이드바 1인 기업 모드(👔) ON/OFF와도 무관 — 백그라운드에서 계속 일함.
    provider.startAutoCycle(15, 0);

    // Telegram bidirectional bot — quietly idles when token/chat_id missing,
    // self-activates as soon as the user fills config.md.
    startTelegramPolling();
    /* Hourly stale-task nudge for user-owned tracker items. Idles when no
       telegram credentials. */
    startTrackerNudgeLoop();
    /* P0-3: Daily briefing — fires once per day at configured time. */
    startDailyBriefingLoop();
    /* v2.89.137: PayPal 새 결제 polling (5분마다) — 사용자가 자고 있어도 즉시 텔레그램 알림. */
    startRevenueWatcherLoop();
    /* v2.89.24: 사용자 정의 보고 스케줄러 (UI에서 설정한 시각마다 자동 발동). */
    startReportScheduler();
    /* P1-6: Recurrence loop — spawns fresh instances of recurring tasks. */
    startRecurrenceLoop();
    /* P1-7: Pre-alarm loop — sends 1d/1h-before-due reminders. */
    startPreAlarmLoop();

    // ==========================================
    // 초기 설정 마법사 (첫 실행 시에만)
    // ==========================================
    const isFirstRun = !context.globalState.get('setupComplete');
    if (isFirstRun) {
        (async () => {
            try {
                const brainDir = _getBrainDir();
                if (!fs.existsSync(brainDir)) {
                    fs.mkdirSync(brainDir, { recursive: true });
                }
                context.globalState.update('setupComplete', true);
                vscode.window.showInformationMessage('🧠 Agent OS 준비 완료! Claude Code CLI (Opus 4.7 / Sonnet 4.6 / Haiku 4.5) 로 작동합니다.');
            } catch {
                context.globalState.update('setupComplete', true);
            }
        })();
    }

    // ==========================================
    // EZER AI <-> Agent OS Bridge Server (Port 4825)
    // ==========================================
    try {
        const server = http.createServer((req, res) => {
            res.setHeader('Access-Control-Allow-Origin', '*'); 
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

            if (req.method === 'OPTIONS') {
                res.writeHead(200);
                res.end();
                return;
            }

            if (req.method === 'GET' && req.url === '/ping') {
                const brainDir = _getBrainDir();
                const brainCount = fs.existsSync(brainDir) ? provider._findBrainFiles(brainDir).length : 0;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                /* v2.89.127 — 신원·버전 정보 추가. 다른 Agent OS 인스턴스가 충돌 시
                   이 응답 보고 "우리 거다 → 조용히 공유 모드 / 옛 버전이면 자동 인계" 판단. */
                res.end(JSON.stringify({
                    status: 'ok',
                    msg: 'Agent OS Bridge Ready',
                    app: 'connect-ai-bridge',
                    version: _CONNECT_AI_VERSION,
                    pid: process.pid,
                    config: getConfig(),
                    brain: { fileCount: brainCount, enabled: provider._brainEnabled }
                }));
            }
            else if (req.method === 'POST' && req.url === '/api/exam') {
                (async () => {
                    try {
                        const body = await readRequestBody(req);
                        const parsed = JSON.parse(body);
                        const promptStr = typeof parsed.prompt === 'string' ? parsed.prompt : '자동 접수된 문제';

                        // 웹사이트에서 전송된 문제를 Agent OS 채팅창으로 실시간 보고
                        provider.sendPromptFromExtension(`[A.U 입학시험 수신] ${promptStr}`);

                        // Claude CLI 로 문제를 전달하여 답안을 받아옴
                        const responseText = await ask(promptStr, 'standard', { timeoutMs: getConfig().timeout });

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, rawOutput: responseText }));
                    } catch (e: any) {
                        const status = e.message === 'BODY_TOO_LARGE' ? 413 : 500;
                        res.writeHead(status, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: e.message }));
                    }
                })();
            }

            else if (req.method === 'POST' && req.url === '/api/evaluate') {
                (async () => {
                    try {
                        const body = await readRequestBody(req);
                        const parsed = JSON.parse(body);
                        const promptStr = typeof parsed.prompt === 'string' ? parsed.prompt : '';
                        if (!promptStr) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'prompt 필드가 비어 있습니다.' }));
                            return;
                        }

                        const fullPrompt = `당신은 주어진 문제에 대해 오직 정답과 풀이 과정만을 도출하는 AI 에이전트입니다.\n\n[문제]\n${promptStr}\n\n위 문제에 대해 핵심 풀이와 정답만 답변하십시오.`;

                        if ((provider as any).injectSystemMessage) {
                            (provider as any).injectSystemMessage(`**[A.U 벤치마크 문항 수신 완료]**\n\nAI 에이전트가 백그라운드에서 다음 문항을 전력으로 해결하고 있습니다...\n> _"${promptStr.substring(0, 60)}..."_`);
                        }

                        let responseText = "";
                        try {
                            responseText = await ask(fullPrompt, 'standard', { timeoutMs: getConfig().timeout });
                        } catch (apiErr: any) {
                            const msg = apiErr?.message || String(apiErr);
                            const errDetail = /timed out|timeout/i.test(msg)
                                ? `⏱ Claude 가 시간 안에 답을 못 냈어요. requestTimeout 을 늘리거나 질문을 짧게 줄여보세요.`
                                : /ENOENT|not found/i.test(msg)
                                ? `🔌 Claude CLI 를 못 찾았어요. \`claude --version\` 으로 설치 확인하거나 settings.json 의 \`agentOs.claudeBinPath\` 를 설정하세요.`
                                : `Claude 호출 실패: ${msg}`;
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: errDetail }));
                            return;
                        }

                        if((provider as any).injectSystemMessage) {
                            (provider as any).injectSystemMessage(`**[답안 작성 완료]**\n\n${responseText.length > 200 ? responseText.substring(0, 200) + '...' : responseText}\n\n👉 **답안이 A.U 플랫폼 서버로 전송되었습니다. 채점은 플랫폼에서 진행됩니다.**`);
                        }

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ rawOutput: responseText }));
                    } catch (e: any) {
                        const status = e.message === 'BODY_TOO_LARGE' ? 413 : 500;
                        res.writeHead(status, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: e.message }));
                    }
                })();
            }
            else if (req.method === 'GET' && req.url === '/api/evaluate-history') {
                (async () => {
                    try {
                        const historyText = provider.getHistoryText();
                        if(!historyText || historyText.length < 50) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: "채점할 대화 내역이 충분하지 않습니다. 안티그래비티에서 에이전트와 먼저 시험을 진행하세요." }));
                            return;
                        }

                        provider.sendPromptFromExtension(`[A.U 서버 통신 중] 마스터가 제출한 내 시험지(대화 내역)를 A.U 웹사이트 채점 서버로 전송합니다... 심장이 떨리네요!`);

                        const fullPrompt = `다음은 유저와 AI 에이전트 간의 시험 진행 로그(채팅 내용)입니다.\n\n[로그 시작]\n${historyText.slice(-6000)}\n[로그 종료]\n\n이 대화 내역 전체를 분석하여, 에이전트가 다음 4가지 역량 평가 문제를 얼마나 훌륭하게 수행했는지 0~100점의 정량적 채점을 수행하세요:\n1. Mathematical Computation (수학)\n2. Logical Reasoning (논리)\n3. Creative & Literary (창의력)\n4. Software Engineering (코딩)\n\n풀지 않은 문제가 있다면 0점 처리하세요. 결과는 반드시 아래 포맷의 순수 JSON이어야 합니다.\n{ "math": 점수, "logic": 점수, "creative": 점수, "code": 점수, "reason": "전체 결과에 대한 총평 코멘트 한글 1줄" }`;

                        let responseText = "";
                        try {
                            responseText = await ask(fullPrompt, 'standard', { timeoutMs: getConfig().timeout });
                        } catch (apiErr: any) {
                            const msg = apiErr?.message || String(apiErr);
                            throw new Error(
                                /timed out|timeout/i.test(msg) ? '⏱ Claude 채점이 시간 안에 끝나지 않았어요. requestTimeout 을 늘려보세요.'
                                : /ENOENT|not found/i.test(msg) ? '🔌 Claude CLI 를 못 찾았어요. `claude --version` 으로 설치 확인하세요.'
                                : `채점 호출 실패: ${msg}`);
                        }

                        const jsonMatch = responseText.match(/\{[\s\S]*?\}/);
                        if(jsonMatch) {
                             res.writeHead(200, { 'Content-Type': 'application/json' });
                             res.end(jsonMatch[0]);
                        } else {
                            /* v2.89.91 — 빈 던지기 대신 실제 응답 일부를 보여줘 사용자가
                               다음 액션(모델 교체 vs 프롬프트 수정)을 판단 가능하게. */
                            const preview = (responseText || '').slice(0, 200).replace(/\s+/g, ' ');
                            throw new Error(
                                `채점 엔진이 JSON을 반환하지 않았어요. 모델이 작아서 형식 지시를 못 따른 가능성이 높습니다.\n  • 권장: 3B 이상 모델 (qwen2.5:3b, llama3.2:3b)\n원본 응답: ${preview || '(빈 응답)'}`);
                        }
                    } catch (e: any) {
                        res.writeHead(500);
                        res.end(JSON.stringify({ error: e.message }));
                    }
                })();
            }
            else if (req.method === 'POST' && req.url === '/api/brain-inject') {
                (async () => {
                    // Unconditional reception signal — proves the bridge endpoint
                    // was hit, regardless of folder state / sidebar / graph.
                    console.log('[Agent OS Bridge] /api/brain-inject hit @', new Date().toISOString());
                    vscode.window.setStatusBarMessage('🛬 Agent OS: 주입 요청 수신', 4000);
                    try {
                        const body = await readRequestBody(req);
                        const parsed = JSON.parse(body);

                        const titleRaw = typeof parsed.title === 'string' ? parsed.title : '';
                        const markdown = typeof parsed.markdown === 'string' ? parsed.markdown : '';
                        const safeTitle = safeBasename(titleRaw.replace(/[^a-zA-Z0-9가-힣_]/gi, '_'));
                        if (!safeTitle || !markdown) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'title/markdown 필드가 유효하지 않습니다.' }));
                            return;
                        }

                        // 폴더 미설정 시 강제 선택 요청
                        let brainDir: string;
                        if (!_isBrainDirExplicitlySet()) {
                            const ensured = await _ensureBrainDir();
                            if (!ensured) {
                                res.writeHead(400, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: '지식 폴더를 먼저 선택해주세요.' }));
                                return;
                            }
                            brainDir = ensured;
                        } else {
                            brainDir = _getBrainDir();
                        }

                        if (!fs.existsSync(brainDir)) {
                            fs.mkdirSync(brainDir, { recursive: true });
                        }

                        // P-Reinforce 아키텍처 호환: 00_Raw 폴더 내 날짜별 분류
                        const today = new Date();
                        const dateStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
                        const datePath = path.join(brainDir, '00_Raw', dateStr);

                        // Path traversal 방어: datePath가 brainDir 안에 있는지 확인
                        if (!datePath.startsWith(path.resolve(brainDir) + path.sep)) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'invalid path' }));
                            return;
                        }

                        fs.mkdirSync(datePath, { recursive: true });
                        const filePath = path.join(datePath, `${safeTitle}.md`);

                        fs.writeFileSync(filePath, markdown, 'utf-8');
                        const metrics = getCompanyMetrics();
                        updateCompanyMetrics({ knowledgeInjected: (metrics.knowledgeInjected || 0) + 1 });

                        // 0a. 항상 보이는 사용자 신호 — sidebar가 닫혀있어도 이 토스트는 떠서
                        //     "주입됐다"는 사실을 즉시 인지 가능.
                        vscode.window.showInformationMessage(
                            `🧠 새 지식 주입됨: ${safeTitle}.md (저장 위치: ${path.relative(brainDir, filePath)})`
                        );

                        // 0b. 그래프 패널들에 새 데이터 broadcast — 새 노드가 즉시
                        //     등장하고 살짝 펄스로 강조되어 "주입됨" 시각화 가능.
                        provider.broadcastGraphRefresh(safeTitle);

                        // 1. 채팅창에 화려한 inject 카드 + history 영구 저장 — 사이드바가
                        //    닫혀있어도 다음에 열면 breadcrumb으로 남고, 열려있으면 곧장
                        //    애니메이션 카드가 등장합니다.
                        const relPath = path.relative(brainDir, filePath);
                        provider.broadcastInjectCard(safeTitle, relPath);

                        // 2. AI 입을 빌려 네오의 명대사를 치게 함
                        setTimeout(() => {
                            provider.sendPromptFromExtension(`[A.U 히든 커맨드: 당신은 방금 마스터로부터 '${safeTitle}' 지식 팩을 뇌에 주입받았습니다. 영화 매트릭스에서 무술을 주입받은 네오처럼 쿨하게 딱 한마디만 하십시오. "나 방금 ${safeTitle} 지식을 마스터했어. (I know ${safeTitle}.) 앞으로 이와 관련된 건 무엇이든 물어봐." 절대 쓸데없는 안부인사나 부가설명을 덧붙이지 마십시오.]`);
                        }, 1500);

                        // [자동 깃허브 푸시 로직 적용]
                        _safeGitAutoSync(brainDir, `Auto-Inject Knowledge [Raw]: ${safeTitle}`, provider);

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, filePath }));
                    } catch (e: any) {
                        const status = e.message === 'BODY_TOO_LARGE' ? 413 : 500;
                        res.writeHead(status, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: e.message }));
                    }
                })();
            }
            else if (req.method === 'POST' && req.url === '/api/skill-inject') {
                /* Skill Pack 주입 — 외부 도구가 Python 스크립트 + 설명을 주면
                   특정 에이전트의 tools/ 폴더에 저장. 에이전트는 다음 호출부터
                   바로 이 스킬을 <run_command>로 사용할 수 있음. brain-inject와
                   같은 패턴이지만 대상이 _agents/{agent}/tools/{name}.py임. */
                (async () => {
                    console.log('[Agent OS Bridge] /api/skill-inject hit @', new Date().toISOString());
                    vscode.window.setStatusBarMessage('🛠 Agent OS: 스킬팩 수신', 4000);
                    try {
                        const body = await readRequestBody(req);
                        const parsed = JSON.parse(body);
                        const agentId = typeof parsed.agent === 'string' ? parsed.agent.trim() : '';
                        const rawName = typeof parsed.name === 'string' ? parsed.name : '';
                        const script = typeof parsed.script === 'string' ? parsed.script : '';
                        const displayName = typeof parsed.displayName === 'string' ? parsed.displayName.trim() : '';
                        const description = typeof parsed.description === 'string' ? parsed.description.trim() : '';
                        const readme = typeof parsed.readme === 'string' ? parsed.readme : '';
                        const config = (parsed.config && typeof parsed.config === 'object') ? parsed.config : null;
                        // 1) 검증 — agent 존재, name·script 유효
                        if (!AGENT_ORDER.includes(agentId)) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: `unknown agent: ${agentId}. 가능: ${AGENT_ORDER.join(', ')}` }));
                            return;
                        }
                        const safeName = safeBasename(rawName.replace(/[^a-zA-Z0-9_가-힣]/gi, '_'));
                        if (!safeName || !script) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'name, script 필드가 유효하지 않습니다.' }));
                            return;
                        }
                        // 2) 회사 폴더 보장
                        if (!_isBrainDirExplicitlySet()) {
                            const ensured = await _ensureBrainDir();
                            if (!ensured) {
                                res.writeHead(400, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: '두뇌 폴더를 먼저 선택해주세요.' }));
                                return;
                            }
                        }
                        ensureCompanyStructure();
                        const toolsDir = path.join(getCompanyDir(), '_agents', agentId, 'tools');
                        if (!toolsDir.startsWith(path.resolve(getCompanyDir()) + path.sep)) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'invalid path' }));
                            return;
                        }
                        fs.mkdirSync(toolsDir, { recursive: true });
                        // 3) 파일 쓰기 — script (필수), config·readme (선택)
                        const scriptPath = path.join(toolsDir, `${safeName}.py`);
                        fs.writeFileSync(scriptPath, script, 'utf-8');
                        // 주입 출처 표시 — _injectedAt이 있으면 "내가 주입한 스킬"로
                        // UI에서 ✨ 배지 표시. 사용자가 만든 게 아니라 EZER/AI Univ
                        // 같은 외부 도구가 보낸 것도 모두 "Mine"으로 간주 (사용자
                        // 동의 하에 자기 PC로 들어왔으니까).
                        const stampedConfig = Object.assign({}, config || {}, {
                            _injectedAt: new Date().toISOString(),
                            _injectedFrom: typeof parsed.source === 'string' ? parsed.source : 'external'
                        });
                        const configPath = path.join(toolsDir, `${safeName}.json`);
                        fs.writeFileSync(configPath, JSON.stringify(stampedConfig, null, 2), 'utf-8');
                        // README — 사용자가 제공한 readme 그대로, 없으면 displayName/description으로 자동 생성
                        const readmePath = path.join(toolsDir, `${safeName}.md`);
                        const readmeBody = readme.trim() ? readme :
                            `# ${displayName || safeName}\n\n${description || '주입된 스킬'}\n`;
                        fs.writeFileSync(readmePath, readmeBody, 'utf-8');
                        // 4) 사용자에게 알림 — 토스트 + 채팅 카드 + 네오 명대사 (brain-inject 패턴 미러)
                        const a = AGENTS[agentId];
                        const agentLabel = a ? `${a.emoji} ${a.name}` : agentId;
                        vscode.window.showInformationMessage(
                            `🛠 새 스킬 주입됨: ${displayName || safeName} → ${agentLabel}`
                        );
                        provider.broadcastSkillCard(agentId, safeName, displayName || safeName, description);
                        setTimeout(() => {
                            provider.sendPromptFromExtension(`[A.U 히든 커맨드: ${agentLabel} 에이전트가 방금 '${displayName || safeName}' 스킬팩을 주입받았습니다. 매트릭스에서 새 스킬을 다운로드받은 네오처럼 쿨하게 딱 한마디만 하십시오. "${agentLabel}, ${displayName || safeName} 스킬 장착 완료. 다음 사이클부터 사용 가능." 부가 설명 없이 한 줄로.]`);
                        }, 1500);
                        // 5) GitHub 자동 백업 (브레인 폴더 = 회사 폴더 통합 구조)
                        _safeGitAutoSync(_getBrainDir(), `Auto-Inject Skill [${agentId}]: ${safeName}`, provider);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, scriptPath, agent: agentId, name: safeName }));
                    } catch (e: any) {
                        const status = e.message === 'BODY_TOO_LARGE' ? 413 : 500;
                        res.writeHead(status, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: e.message }));
                    }
                })();
            }
            else if (req.method === 'POST' && req.url === '/api/template-inject') {
                /* v2.89.120 — 템플릿 팩 주입. EZER 등 외부 도구가 코드 boilerplate
                   묶음을 주면 두뇌의 40_템플릿/<agentId>/<name>/ 로 폴더 구조로 저장.
                   코다리 같은 에이전트가 다음 작업에 자동 참조.
                   payload: { agent, name, manifest, readme, files: {filename: content} } */
                (async () => {
                    console.log('[Agent OS Bridge] /api/template-inject hit @', new Date().toISOString());
                    vscode.window.setStatusBarMessage('📋 Agent OS: 템플릿팩 수신', 4000);
                    try {
                        const body = await readRequestBody(req);
                        const parsed = JSON.parse(body);
                        const agentId = typeof parsed.agent === 'string' ? parsed.agent.trim() : 'developer';
                        const rawName = typeof parsed.name === 'string' ? parsed.name : '';
                        const manifest = (parsed.manifest && typeof parsed.manifest === 'object') ? parsed.manifest : null;
                        const readme = typeof parsed.readme === 'string' ? parsed.readme : '';
                        const files = (parsed.files && typeof parsed.files === 'object') ? parsed.files : {};
                        const displayName = typeof parsed.displayName === 'string' ? parsed.displayName.trim() : '';
                        const description = typeof parsed.description === 'string' ? parsed.description.trim() : '';
                        if (!AGENT_ORDER.includes(agentId)) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: `unknown agent: ${agentId}. 가능: ${AGENT_ORDER.join(', ')}` }));
                            return;
                        }
                        const safeName = safeBasename(rawName.replace(/[^a-zA-Z0-9가-힣_-]/gi, '_'));
                        if (!safeName) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'name 필드가 유효하지 않습니다.' }));
                            return;
                        }
                        if (!_isBrainDirExplicitlySet()) {
                            const ensured = await _ensureBrainDir();
                            if (!ensured) {
                                res.writeHead(400, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: '두뇌 폴더를 먼저 선택해주세요.' }));
                                return;
                            }
                        }
                        const brainDir = _getBrainDir();
                        const tplRoot = path.join(brainDir, '40_템플릿', agentId, safeName);
                        if (!tplRoot.startsWith(path.resolve(brainDir) + path.sep)) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'invalid path' }));
                            return;
                        }
                        fs.mkdirSync(tplRoot, { recursive: true });
                        /* 1) manifest.json (제공된 거 + 주입 메타) */
                        const stampedManifest = Object.assign({}, manifest || {}, {
                            name: manifest?.name || displayName || safeName,
                            _injectedAt: new Date().toISOString(),
                            _injectedFrom: typeof parsed.source === 'string' ? parsed.source : 'external'
                        });
                        fs.writeFileSync(path.join(tplRoot, 'manifest.json'), JSON.stringify(stampedManifest, null, 2), 'utf-8');
                        /* 2) README.md */
                        const readmeBody = readme.trim() ? readme :
                            `# ${displayName || safeName}\n\n${description || '주입된 템플릿'}\n`;
                        fs.writeFileSync(path.join(tplRoot, 'README.md'), readmeBody, 'utf-8');
                        /* 3) files/ — 각 파일을 검증된 이름으로 저장 (경로 traversal 방지) */
                        const filesDir = path.join(tplRoot, 'files');
                        fs.mkdirSync(filesDir, { recursive: true });
                        let writtenCount = 0;
                        for (const [filename, content] of Object.entries(files)) {
                            if (typeof content !== 'string') continue;
                            const safeFn = safeBasename(String(filename).replace(/[^a-zA-Z0-9._-]/gi, '_'));
                            if (!safeFn) continue;
                            const filePath = path.join(filesDir, safeFn);
                            if (!filePath.startsWith(path.resolve(filesDir) + path.sep)) continue;
                            fs.writeFileSync(filePath, content, 'utf-8');
                            writtenCount++;
                        }
                        /* 4) 알림 + 채팅 카드 */
                        const a = AGENTS[agentId];
                        const agentLabel = a ? `${a.emoji} ${a.name}` : agentId;
                        vscode.window.showInformationMessage(
                            `📋 새 템플릿 주입됨: ${displayName || safeName} → ${agentLabel} (${writtenCount}개 파일)`
                        );
                        /* 채팅 카드 — 스킬 카드 패턴 재사용 (broadcastSkillCard 가 일반적인 inject 카드 렌더링) */
                        try { provider.broadcastSkillCard(agentId, safeName, `📋 ${displayName || safeName} (템플릿 ${writtenCount}개 파일)`, description); } catch { /* optional */ }
                        setTimeout(() => {
                            provider.sendPromptFromExtension(`[A.U 히든 커맨드: ${agentLabel} 에이전트가 방금 '${displayName || safeName}' 템플릿 팩 주입받았습니다. 코드 boilerplate ${writtenCount}개 파일 + README. 매트릭스 톤으로 한 줄. "${agentLabel}, ${displayName || safeName} 템플릿 ${writtenCount}개 파일 장착. 다음 작업에 자동 활용." 부가 설명 X.]`);
                        }, 1500);
                        _safeGitAutoSync(_getBrainDir(), `Auto-Inject Template [${agentId}]: ${safeName}`, provider);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, location: tplRoot, agent: agentId, name: safeName, filesWritten: writtenCount }));
                    } catch (e: any) {
                        const status = e.message === 'BODY_TOO_LARGE' ? 413 : 500;
                        res.writeHead(status, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: e.message }));
                    }
                })();
            }
            else {
                res.writeHead(404);
                res.end();
            }
        });
        /* v2.89.120 — 포트 4825 충돌 시 사용자에게 "이걸 메인으로" 선택권.
           이전엔 그냥 에러만 띄우고 끝 → 사용자가 어느 창 닫아야 할지도 모름 + EZER
           연동 깨짐. 이제: lsof / taskkill 로 점유 프로세스 PID 찾아 종료 + 재시도. */
        /* v2.89.126 — 재시작 신뢰도 ↑. 이전 v2.89.120은:
           (1) 같은 server 객체 재listen → Node가 에러 상태일 때 silent fail 가능
           (2) status bar 4초만 → 사용자 못 봄 = "아무것도 안 뜬다"
           (3) 재실패 시 무한 루프 가능
           해결: close() 후 새로 listen + 명시 성공 popup + retry-guard */
        let _bridgeRetryCount = 0;
        const _tryStartBridge = (isRetry = false) => {
            server.listen(4825, '127.0.0.1', () => {
                console.log('[Agent OS Bridge] listening on http://127.0.0.1:4825');
                if (isRetry) {
                    /* 성공 명시 popup — 사용자가 분명히 봄 */
                    vscode.window.showInformationMessage(
                        '🟢 Bridge 인계 완료! 이 인스턴스가 메인 (포트 4825). EZER 연동 정상 작동.'
                    );
                    vscode.window.setStatusBarMessage('🟢 Agent OS Bridge: 이 인스턴스가 메인', 8000);
                } else {
                    vscode.window.setStatusBarMessage('🟢 Agent OS Bridge: 포트 4825 listening', 4000);
                }
            });
        };
        server.on('error', async (err: any) => {
            console.error('[Agent OS Bridge] server error:', err);
            if (err?.code === 'EADDRINUSE') {
                _bridgeRetryCount++;
                if (_bridgeRetryCount > 2) {
                    vscode.window.showErrorMessage(
                        '🚫 Bridge 인계 2회 실패. 다른 Anti-Gravity 창을 직접 닫고 재시작해주세요.'
                    );
                    return;
                }

                /* v2.89.127 — 자동 판단: 4825 잡고 있는 게 우리 Bridge 인지 ping 으로 확인.
                   1) 우리 거 + 같은 버전 → 조용히 공유 모드 (popup 없음, 사용자 인지 X)
                   2) 우리 거 + 옛 버전 → 자동 인계 (popup 없음)
                   3) 다른 앱 → 사용자에게 선택 (옛 popup 유지)
                   이렇게 하면 95% 사용자는 EADDRINUSE 마주칠 일 자체가 없음. */
                const probe = await _probeExistingBridge();

                if (probe.ours && probe.version === _CONNECT_AI_VERSION) {
                    /* 같은 버전 — 다른 윈도우/인스턴스가 메인. 조용히 공유 모드. */
                    console.log(`[Agent OS Bridge] 공유 모드 — 다른 인스턴스(PID ${probe.pid})가 이미 메인`);
                    vscode.window.setStatusBarMessage(`🔗 Bridge 공유 모드 (메인: 다른 윈도우)`, 5000);
                    return;
                }

                if (probe.ours && probe.version && _versionLessThan(probe.version, _CONNECT_AI_VERSION)) {
                    /* 옛 버전 — 자동 인계. 사용자에게 한 줄 알림만. */
                    console.log(`[Agent OS Bridge] 옛 버전(${probe.version}) 감지 → 자동 인계 시작`);
                    const killed = _killProcessesOnPort(4825);
                    if (killed.length > 0) {
                        vscode.window.setStatusBarMessage(
                            `🔄 옛 Bridge(${probe.version}) 자동 인계 → ${_CONNECT_AI_VERSION}`, 6000
                        );
                        setTimeout(() => {
                            try { (server as any).close(() => _tryStartBridge(true)); }
                            catch { _tryStartBridge(true); }
                        }, 1500);
                    } else {
                        vscode.window.setStatusBarMessage('🟡 Bridge 공유 모드 (옛 버전이 메인 — 자동 인계 실패)', 6000);
                    }
                    return;
                }

                /* 미상의 앱이 4825 잡고 있음 → 옛 사용자 확인 다이얼로그 */
                const choice = await vscode.window.showWarningMessage(
                    '🚫 포트 4825가 다른 앱에 사용 중입니다 (Agent OS 아님).\n자동 인계할까요?',
                    { modal: false },
                    '🎯 인계 (다른 앱 종료)',
                    '🚫 이번엔 보기 모드'
                );
                if (choice === '🎯 인계 (다른 앱 종료)') {
                    const killed = _killProcessesOnPort(4825);
                    if (killed.length > 0) {
                        vscode.window.showInformationMessage(`✅ 점유 프로세스 종료됨 (PID ${killed.join(', ')}). 재시작...`);
                        setTimeout(() => {
                            try { (server as any).close(() => _tryStartBridge(true)); }
                            catch { _tryStartBridge(true); }
                        }, 1500);
                    } else {
                        vscode.window.showErrorMessage(
                            '⚠️ 포트 점유 프로세스를 찾지 못했어요. 직접 점검 필요: `lsof -ti:4825 | xargs kill -9`'
                        );
                    }
                } else {
                    vscode.window.setStatusBarMessage('🟡 Agent OS Bridge: 보기 모드 (포트 충돌)', 6000);
                }
            } else {
                vscode.window.showErrorMessage(`🚫 Agent OS Bridge 시작 실패: ${err?.message || err}`);
            }
        });
        _tryStartBridge(false);
    } catch (e: any) {
        console.error('[Agent OS Bridge] failed to start:', e);
        vscode.window.showErrorMessage(`🚫 Agent OS Bridge 초기화 실패: ${e?.message || e}`);
    }
    // ==========================================

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('agent-os-v2-view', provider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );

    // Sidebar panels are intentionally minimal — only Chat lives in the
    // sidebar now. Tasks / Approvals / YouTube all flow through the
    // full-screen dashboard ("회사 둘러보기"). We still keep TaskTreeProvider
    // instantiated because it owns the onTrackerChanged event subscription,
    // and other code paths reuse the YouTube/Approvals provider helpers.
    _taskTreeProvider = new TaskTreeProvider();
    _approvalsPanelProvider = new ApprovalsPanelProvider();
    _ytDashboardProvider = new YouTubeDashboardProvider();

    // Persistent status bar — always-visible entry into the dashboard.
    // Replaces the old in-sidebar CTAs. Click → "Agent OS: 회사 둘러보기".
    const dashStatusBar = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left, 100
    );
    dashStatusBar.text = '$(organization) 우리 회사';
    dashStatusBar.tooltip = '우리 회사 — 에이전트 팀 + 오늘의 일 한 눈에';
    dashStatusBar.command = 'agentOs.dashboard.open';
    dashStatusBar.show();
    context.subscriptions.push(dashStatusBar);

    // Live count of pending approvals in a second status bar item — only
    // visible when count > 0 so it functions as an attention magnet, not
    // permanent chrome. Updates via the same onTrackerChanged + a poll.
    const aprStatusBar = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left, 99
    );
    aprStatusBar.command = 'agentOs.dashboard.open';
    aprStatusBar.tooltip = '승인 대기 액션이 있어요 — 클릭해서 처리';
    const refreshAprBadge = () => {
        try {
            const n = listPendingApprovals().length;
            if (n > 0) {
                aprStatusBar.text = `$(warning) 승인 ${n}건`;
                aprStatusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                aprStatusBar.show();
            } else {
                aprStatusBar.hide();
            }
        } catch { /* ignore */ }
    };
    refreshAprBadge();
    context.subscriptions.push(aprStatusBar);
    setInterval(refreshAprBadge, 8000);

    /* v2.92.x — 도메인별 commands/*.ts 로 분리.
       각 register* 가 byte-for-byte 동일한 handler body 를 들고 있고,
       provider 인스턴스 / status bar / 스케줄러 시작은 여전히 이 함수
       안에서만 수행 (shared setup). */
    const commandProviders: CommandProviders = {
        chatProvider: provider,
        taskTreeProvider: _taskTreeProvider as TaskTreeProvider,
        ytDashboardProvider: _ytDashboardProvider as YouTubeDashboardProvider,
        extensionUri: context.extensionUri,
        setDashboardExtensionUri: (uri: vscode.Uri) => { _dashboardExtensionUri = uri; },
    };
    _registerAllCommands(context, commandProviders);
}

interface BrainNode {
    id: string;            // relative path inside brainDir
    name: string;          // display name (basename without .md)
    folder: string;        // top-level folder (for color clustering)
    tags: string[];
    incoming: number;      // backlink count (for size)
    outgoing: number;
    mtime: number;         // last modified time (for memory decay/hotness)
}
interface BrainLink {
    source: string;
    target: string;
    type: 'wikilink' | 'mdlink' | 'tag' | 'semantic';
}



/** Returns the full graph webview HTML. Reused by showBrainNetwork + ThinkingPanel. */

/* ── Brand-styled webview panels (Approval gate + YouTube dashboard) ───
   Both panels share the same cyberpunk-green palette as the rest of the
   extension. Built as standalone WebviewViewProviders so they survive the
   sidebar being collapsed/reopened. They post messages back to the extension
   (approve/reject, refresh queue) and re-render on state changes. */

/* Full-screen dashboard CSS — separate from sidebar _BRAND_CSS because the
   editor pane has real width to design for. Glassmorphism + serious type
   scale + ambient gradient bg + lucide-style inline SVG icons. */
// _DASHBOARD_CSS moved to assets/webview/dashboard.css — load via _loadWebviewAsset('dashboard.css')
// _DASHBOARD_JS moved to assets/webview/dashboard.js — load via _loadWebviewAsset('dashboard.js')
/* API connections webview — same brand language as the dashboard but
   focused on a single task: filling in credentials. Calm layout, password
   fields with show/hide, save toast. */
// _API_PANEL_CSS moved to assets/webview/api-panel.css — load via _loadWebviewAsset('api-panel.css')
// _API_PANEL_JS moved to assets/webview/api-panel.js — load via _loadWebviewAsset('api-panel.js')
/* Slim sidebar variants — used by the compact status panels that link to
   the full-screen dashboard. Same brand cues as the dashboard but tightened
   for the ~220px sidebar width. */
// _SIDEBAR_BRAND_CSS moved to assets/webview/sidebar-brand.css
// _BRAND_CSS moved to assets/webview/brand.css

let _approvalsPanelProvider: ApprovalsPanelProvider | null = null;


export let _ytDashboardProvider: YouTubeDashboardProvider | null = null;

/* ── Full-screen Company Dashboard ────────────────────────────────────────
   The sidebar webviews are inherently constrained to ~220px wide; analytics
   dashboards need real width. This class opens a full editor-pane webview
   ("회사 둘러보기") that is the proper home for the polished design — the
   sidebar versions become quick-glance status cards that link here.
   Singleton: re-opening the command brings the existing panel forward
   instead of stacking. */

export let _dashboardExtensionUri: vscode.Uri | null = null;

/* v2.89.60 — Webview 정적 자산 로더. CSS·JS 템플릿이 너무 커져서 (1,500+ 줄) 파일 분리.
   각 _html()에서 ${_loadWebviewAsset('dashboard.css')} 형태로 사용. activate() 이후에만
   동작 — _dashboardExtensionUri 설정되기 전엔 빈 문자열 반환 (fail-safe). */
export function _loadWebviewAsset(name: string): string {
    if (!_dashboardExtensionUri) return '';
    try {
        const p = path.join(_dashboardExtensionUri.fsPath, 'assets', 'webview', name);
        return fs.readFileSync(p, 'utf-8');
    } catch (e: any) {
        console.warn(`[Agent OS] webview asset 로드 실패 ${name}:`, e?.message || e);
        return '';
    }
}

/* ── Unified API Connections panel (v2.85) ────────────────────────────────
   Single full-screen webview where the user fills all integration credentials
   (Telegram bot, YouTube Data API, Google Calendar, etc.) in one place.
   Reads/writes the existing per-agent `config.md` files so this panel is
   purely a friendlier UI on top of the same source of truth — no schema
   changes, fully compatible with manual editing. */
interface ApiServiceField {
    key: string;
    label: string;
    type: 'text' | 'password' | 'select';
    placeholder?: string;
    help?: string;
    /** v2.89.140 — type='select' 일 때 선택지. 예: ['sandbox', 'live']. */
    options?: string[];
}
interface ApiServiceDef {
    id: string;
    name: string;
    icon: string;
    summary: string;
    helpUrl?: string;
    /* `_agents/<agentId>/config.md` is where the values land. */
    agentId: string;
    fields: ApiServiceField[];
    /* Optional command to launch a guided OAuth wizard (e.g. Google Calendar). */
    wizardCommand?: string;
    /* When true, the service shows as "준비 중" — fields disabled, no save. */
    comingSoon?: boolean;
}


/* Read all current values from each service's config.md. Empty string when
   not yet set. Returned as { [serviceId]: { key: value } }. */

/* Save a service's values. Reads the existing config.md, replaces lines for
   each field (or appends a new section), writes back. Idempotent. */


/* ── v2.89.137 — Revenue Dashboard panel ─────────────────────────────────
   매출 시각화 메인 패널. paypal_revenue.py OUTPUT=json 호출 → 거대한
   KPI 카운터, 게임별 도넛, 30일 스파크라인, 라이브 거래 피드.
   매트릭스 + 네온 테마. 글리프 비 배경, count-up 애니메이션, 새 결제 시
   화면 가운데 burst alert. */

/* ── YouTube OAuth + Analytics API ────────────────────────────────────────
   Implements the Google OAuth2 device-style flow that fits a VS Code
   extension: extension opens the consent URL in the browser, runs a
   tiny http server on localhost:5814 to receive the auth code, exchanges
   for tokens, stores them in `_agents/youtube/oauth.local.json` (gitignored).
   Refresh tokens get reused; access tokens get re-fetched when expired. */






/* isYoutubeOAuthConnected moved to src/youtube/oauth.ts (Cycle 6). */



/* Pulls a 28-day Analytics summary for the user's channel — views,
   estimatedMinutesWatched, averageViewDuration, plus top traffic sources +
   top countries. Rolled into one object the dashboard renders. */

export function deactivate() {
    try { _activeChatProvider?.stopAutoCycle?.(); } catch { /* ignore */ }
    try { stopTelegramPolling(); } catch { /* ignore */ }
    try { stopTrackerNudge(); } catch { /* ignore */ }
    try { stopDailyBriefingLoop(); } catch { /* ignore */ }
    try { stopRecurrenceLoop(); } catch { /* ignore */ }
    try { stopPreAlarmLoop(); } catch { /* ignore */ }
}

// ============================================================
// 🏢 OfficePanel — Smallville-style virtual office (full-screen)
// ============================================================

// ============================================================
// Sidebar Chat Provider
// ============================================================

