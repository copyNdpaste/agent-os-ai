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

export const SYSTEM_PROMPT = _loadPrompt('system.md');
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
   여기엔 COMPANY_SUBDIR과 무관한 INTERNAL_DIRS 만 남김. */
const COMPANY_INTERNAL_DIRS = new Set(['_cache', '_tmp']);

/* One-shot migration: when the user upgrades from a layout where company
   files lived at the brain root, transparently move them under _company/.
   Runs at activation. Idempotent — does nothing if already migrated. */
function _migrateCompanyToSubdir() {
  try {
    const root = _getBrainDir();
    if (!fs.existsSync(root)) return;
    const target = path.join(root, COMPANY_SUBDIR);
    if (fs.existsSync(target)) return; // already migrated
    const legacyDirs = ['_shared', '_agents', 'sessions', 'approvals'];
    const present = legacyDirs.filter(d => {
      try { return fs.statSync(path.join(root, d)).isDirectory(); } catch { return false; }
    });
    if (present.length === 0) return; // nothing to migrate
    fs.mkdirSync(target, { recursive: true });
    for (const d of present) {
      const src = path.join(root, d);
      const dst = path.join(target, d);
      try { fs.renameSync(src, dst); } catch (e) {
        console.warn(`[Agent OS] migration: rename ${d} failed`, e);
      }
    }
    console.log(`[Agent OS] migrated ${present.length} legacy folders under ${target}`);
  } catch (e) {
    console.warn('[Agent OS] _company/ migration failed', e);
  }
}

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
function _migrateYouTubeCredsToCanonical() {
  try {
    const dir = getCompanyDir();
    const cfgPath = path.join(dir, '_agents', 'youtube', 'config.md');
    if (!fs.existsSync(cfgPath)) return;
    const cfgTxt = _safeReadText(cfgPath);
    /* 라인 시작 앵커 — 이전 read regex 버그 회피 */
    const apiKeyM = cfgTxt.match(/^YOUTUBE_API_KEY[ \t]*[:：=][ \t]*([^\r\n]+?)[ \t]*$/m);
    const channelM = cfgTxt.match(/^YOUTUBE_CHANNEL_ID[ \t]*[:：=][ \t]*([^\r\n]+?)[ \t]*$/m);
    /* v2.89.18 — OAuth Client ID/Secret도 같이 마이그레이션 */
    const oauthIdM = cfgTxt.match(/^YOUTUBE_OAUTH_CLIENT_ID[ \t]*[:：=][ \t]*([^\r\n]+?)[ \t]*$/m);
    const oauthSecretM = cfgTxt.match(/^YOUTUBE_OAUTH_CLIENT_SECRET[ \t]*[:：=][ \t]*([^\r\n]+?)[ \t]*$/m);
    const apiKey = apiKeyM ? apiKeyM[1].trim() : '';
    const channelId = channelM ? channelM[1].trim() : '';
    const oauthId = oauthIdM ? oauthIdM[1].trim() : '';
    const oauthSecret = oauthSecretM ? oauthSecretM[1].trim() : '';
    if (!apiKey && !channelId && !oauthId && !oauthSecret) return;
    const toolDir = path.join(dir, '_agents', 'youtube', 'tools');
    if (!fs.existsSync(toolDir)) return;
    const jsonPath = path.join(toolDir, 'youtube_account.json');
    let existing: Record<string, any> = {};
    if (fs.existsSync(jsonPath)) {
      try { existing = JSON.parse(fs.readFileSync(jsonPath, 'utf-8') || '{}'); } catch { /* malformed */ }
    }
    const existingKey = String(existing['YOUTUBE_API_KEY'] || '').trim();
    const existingChannel = String(existing['MY_CHANNEL_ID'] || '').trim();
    const existingOauthId = String(existing['YOUTUBE_OAUTH_CLIENT_ID'] || '').trim();
    const existingOauthSecret = String(existing['YOUTUBE_OAUTH_CLIENT_SECRET'] || '').trim();
    const needSync = (apiKey && !existingKey) || (channelId && !existingChannel) || (oauthId && !existingOauthId) || (oauthSecret && !existingOauthSecret);
    if (!needSync) return;
    /* 누락된 것만 채워줌 — 기존 값은 보존 */
    if (apiKey && !existingKey) existing['YOUTUBE_API_KEY'] = apiKey;
    if (channelId && !existingChannel) existing['MY_CHANNEL_ID'] = channelId;
    if (oauthId && !existingOauthId) existing['YOUTUBE_OAUTH_CLIENT_ID'] = oauthId;
    if (oauthSecret && !existingOauthSecret) existing['YOUTUBE_OAUTH_CLIENT_SECRET'] = oauthSecret;
    /* 누락 필드 기본값 */
    if (!('MY_CHANNEL_HANDLE' in existing)) existing['MY_CHANNEL_HANDLE'] = '';
    if (!('WATCHED_CHANNELS' in existing)) existing['WATCHED_CHANNELS'] = [];
    if (!('COMPETITOR_CHANNELS' in existing)) existing['COMPETITOR_CHANNELS'] = [];
    fs.writeFileSync(jsonPath, JSON.stringify(existing, null, 2));
    console.log('[migration] youtube_account.json synced from config.md');
  } catch (e: any) {
    console.warn('[migration] youtube_account.json sync failed:', e?.message || e);
  }
}

// One-time migration from the old `<brain>/Company/...` (or custom
// `companyDir`) layout to the unified flat layout. Called once on activate.
function _migrateCompanyToBrain() {
  try {
    const brain = _getBrainDir();
    if (fs.existsSync(path.join(brain, '_shared'))) return; // already unified

    const cfg = vscode.workspace.getConfiguration('agentOs');
    let legacy = ((cfg.get('companyDir') as string | undefined) || '').trim();
    if (!legacy && _extCtx) {
      legacy = (_extCtx.globalState.get<string>('companyDir') || '').trim();
    }
    if (legacy.startsWith('~/')) legacy = path.join(os.homedir(), legacy.slice(2));
    if (!legacy) legacy = path.join(brain, 'Company');

    if (!fs.existsSync(path.join(legacy, '_shared'))) return; // nothing to migrate

    fs.mkdirSync(brain, { recursive: true });
    for (const name of fs.readdirSync(legacy)) {
      const src = path.join(legacy, name);
      const dst = path.join(brain, name);
      if (fs.existsSync(dst)) continue; // never overwrite user data
      try { fs.renameSync(src, dst); } catch { /* skip on cross-device */ }
    }
    if (legacy === path.join(brain, 'Company')) {
      try { fs.rmdirSync(legacy); } catch {}
    }
    try { cfg.update('companyDir', undefined, vscode.ConfigurationTarget.Global); } catch {}
    if (_extCtx) {
      try { _extCtx.globalState.update('companyDir', undefined); } catch {}
    }
    console.log(`Agent OS: migrated ${legacy} → ${brain}`);
  } catch (e) {
    console.error('Agent OS: company → brain migration failed', e);
  }
}

// ──────────────────────────────────────────────────────────────────
// Company metrics + identity — extension-side thin wrappers
// 본문은 src/company/{metrics,identity}.ts. baseDir 로 brain 을 주입.
// ──────────────────────────────────────────────────────────────────
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

export const TELEGRAM_HELP = `🤖 *Agent OS 봇* — 비서가 24시간 대기 중

*그냥 자연어로 말해주세요. 비서가 알아서 처리합니다.*

📅 *일정*
"오늘 일정 뭐야" / "내일 3시 광고주 미팅 잡아줘" / "내일 미팅 취소"

📋 *할일·상태*
"할일 뭐 있어?" / "에이전트 뭐 하고 있어?" / "어제 뭐 했어?"

💼 *작업 분배*
"썸네일 만들어줘" / "유튜브 트렌드 분석해줘"
→ CEO가 적합한 에이전트에게 분배 → 결과 보고

🤖 *에이전트 직접 지시*
"디자이너한테 로고 시안 부탁해" / "유튜브에게 컨셉 3개 뽑으라고 해"

🔧 *도구·승인 상태*
"도구 자율도 어때?" / "승인 대기 뭐 있어?"

━━━━━━━━━━━━━
*명령어 (옵션, 없어도 됨)*
\`/done <id>\` — 작업 완료 (id로 확실하게)
\`/cancel <id>\` — 작업 취소
\`/skill\` — 직전 산출물을 패턴(스킬)으로 저장 (다음 호출부터 자동 참조)
\`/skills [에이전트id]\` — 저장된 스킬 목록 보기
\`/help\` — 이 도움말`;

export const AUTONOMY_LABELS: Record<number, string> = {
    0: 'Off',
    1: 'Read-only',
    2: 'Draft → Approve',
    3: 'Auto'
};

export function readToolAutonomyLevel(agentId: string): number {
    return st.readAutonomyLevel(getCompanyDir(), agentId);
}

export function _modelToTier(modelName: string): Tier {
    const m = (modelName || '').toLowerCase();
    if (m.includes('opus')) return 'heavy';
    if (m.includes('haiku')) return 'light';
    return 'standard';
}

export function _serializeMessages(messages: { role: string; content: any }[]): string {
    const parts: string[] = [];
    for (const msg of messages) {
        const role = msg.role === 'assistant' ? 'ASSISTANT' : msg.role === 'system' ? 'SYSTEM' : 'USER';
        const content = typeof msg.content === 'string'
            ? msg.content
            : Array.isArray(msg.content)
                ? msg.content.map((c: any) => c?.text || '').join('')
                : String(msg.content ?? '');
        parts.push(`<${role}>\n${content}\n</${role}>`);
    }
    parts.push('Respond as the assistant to the latest USER message above. Do not echo the conversation back.');
    return parts.join('\n\n');
}

export async function _quickLLMCall(systemPrompt: string, userMsg: string, maxTokens = 64): Promise<string> {
    const prompt = `${systemPrompt}\n\n---\n\n${userMsg}\n\n(Respond in ${maxTokens} tokens or fewer. Output only the answer, no preamble.)`;
    const out = await ask(prompt, 'light', { timeoutMs: 60_000 });
    return out.trim();
}

const CEO_CLASSIFIER_PROMPT = _loadPrompt('ceo-classifier.md');
export const SECRETARY_TELEGRAM_PROMPT = _loadPrompt('secretary-telegram.md');
export async function classifyToAgent(text: string): Promise<string> {
    try {
        const out = await _quickLLMCall(_personalizePrompt(CEO_CLASSIFIER_PROMPT), text, 16);
        const id = out.trim().toLowerCase().replace(/[^a-z]/g, '');
        if (AGENTS[id]) return id;
    } catch { /* fall through to keyword router */ }
    const lower = text.toLowerCase();
    if (/인스타|instagram|릴스|피드|reel/.test(lower)) return 'instagram';
    if (/디자인|design|로고|이미지/.test(lower)) return 'designer';
    if (/코드|개발|사이트|웹|deploy|배포|api|app/.test(lower)) return 'developer';
    if (/돈|매출|가격|수익|roi|business|단가/.test(lower)) return 'business';
    if (/일정|할일|todo|미팅|알림|메일|brief|브리핑|캘린더/.test(lower)) return 'secretary';
    if (/편집|자막|b-?roll|컷/.test(lower)) return 'editor';
    if (/카피|스크립트|블로그|후크|글/.test(lower)) return 'writer';
    if (/트렌드|리서치|조사|뉴스/.test(lower)) return 'researcher';
    return 'secretary'; // safe default — secretary triages
}


/* Robust JSON extractor — handles model output that wraps the JSON in prose,
   markdown fences, or multiple objects. Scans ALL balanced top-level objects
   and returns the first one with a string `mode` field; falls back to the
   first parseable object if none has `mode`. Picking by `mode` matters because
   small models often emit a "thinking" / scratchpad JSON before the real
   answer, and the legacy first-only behavior would lock onto the scratchpad
   and leak it (or trigger an empty-reply fallback). */
export function _extractFirstJsonObject(raw: string): any | null {
    if (!raw) return null;
    /* Strip code fences first */
    const stripped = raw.replace(/```[a-zA-Z]*\n?|```/g, '');
    const candidates: any[] = [];
    let i = 0;
    while (i < stripped.length) {
        const start = stripped.indexOf('{', i);
        if (start < 0) break;
        let depth = 0;
        let inStr = false;
        let esc = false;
        let endIdx = -1;
        for (let j = start; j < stripped.length; j++) {
            const ch = stripped[j];
            if (esc) { esc = false; continue; }
            if (ch === '\\') { esc = true; continue; }
            if (ch === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) { endIdx = j; break; }
            }
        }
        if (endIdx < 0) break; // unbalanced trailing object — let the caller's truncation rescue handle it
        try {
            const obj = JSON.parse(stripped.slice(start, endIdx + 1));
            if (obj && typeof obj === 'object') candidates.push(obj);
        } catch { /* skip malformed object, continue scanning */ }
        i = endIdx + 1;
    }
    if (candidates.length === 0) return null;
    const withMode = candidates.find(c => typeof c.mode === 'string');
    return withMode || candidates[0];
}

/* v2.88 — 비서가 "지금 진짜로 뭐 할 수 있는지" 자연어로 답변. 모든 에이전트의
   라이브 상태 + 자격증명 상태 점검. 일반론 답변 대신 사실만 — 사용자가
   "이건 되고 이건 안 되네" 즉시 파악. */
export function _buildCapabilityReport(): string {
    const lines: string[] = ['👋 *카리나예요. 지금 제가 도울 수 있는 건:*\n'];
    const tg = readTelegramConfig();
    const calOk = isCalendarWriteConnected();
    /* 1) 비서 본인의 직접 능력 */
    lines.push('*📅 일정 관리*');
    if (calOk) lines.push('  ✅ 추가·조회·수정·취소 (자연어로) — "내일 3시 미팅 잡아줘"');
    else lines.push('  ⚠️ 미연결 — 명령 팔레트 → "Agent OS: Google Calendar 자동 일정 연결"');
    lines.push('');
    lines.push('*📨 텔레그램 양방향*');
    if (tg.token && tg.chatId) lines.push('  ✅ 작동 중 — 명령 받고 보고 보내기');
    else lines.push('  ⚠️ 미연결 — 직원 보기 → 카리나 카드 → ⚙️에서 봇 토큰 입력');
    lines.push('');
    lines.push('*📋 작업 추적*');
    lines.push('  ✅ "내일까지 X 해야 해" → 자동 등록, 마감 임박 시 알림');
    lines.push('');
    /* 2) 다른 에이전트들의 능력 */
    lines.push('*👥 회사 에이전트들 (자연어로 부르세요)*');
    const agentSummary: string[] = [];
    /* YouTube 상태 */
    try {
        const cfgPath = path.join(getCompanyDir(), '_agents', 'youtube', 'config.md');
        const txt = _safeReadText(cfgPath);
        const apiKey = (txt.match(/YOUTUBE_API_KEY\s*[:：=]\s*([A-Za-z0-9_\-]+)/) || [])[1] || '';
        const channelId = (txt.match(/YOUTUBE_CHANNEL_ID\s*[:：=]\s*([A-Za-z0-9_\-]+)/) || [])[1] || '';
        if (apiKey && channelId) {
            const oauth = isYoutubeOAuthConnected();
            agentSummary.push('  📺 *YouTube* — ✅ 채널 분석·트렌드' + (oauth ? '·시청 지속률·트래픽' : ' (Analytics는 OAuth 필요)'));
        } else {
            agentSummary.push('  📺 *YouTube* — ⚠️ API 키·채널 ID 필요');
        }
    } catch {
        agentSummary.push('  📺 *YouTube* — ⚠️ 설정 필요');
    }
    /* LLM 기반 에이전트들 — 항상 가능 */
    agentSummary.push('  🎨 *디자이너* — ✅ 시안 카피·무드보드·브랜드 컬러 가이드');
    agentSummary.push('  ✍️ *작가* — ✅ 후크·스크립트·블로그·영상 카피');
    agentSummary.push('  🎵 *한스짐머* — ✅ BGM 자동 생성·영상-음악 합성·사운드 디자인');
    agentSummary.push('  💼 *제프베조스* — ✅ 가격·KPI·전략 분석');
    agentSummary.push('  💻 *개발신* — ✅ 사이트·자동화·API 코드');
    agentSummary.push('  🔍 *리서처* — ✅ 트렌드·경쟁사·사실 확인');
    agentSummary.push('  📷 *Instagram* — ✅ 릴스 기획·해시태그·카피');
    lines.push(agentSummary.join('\n'));
    lines.push('');
    lines.push('*예시:*');
    lines.push('• "다음 영상 컨셉 5개 뽑아줘" → CEO가 YouTube·작가에게 분배');
    lines.push('• "썸네일 시안 만들어줘" → 디자이너로');
    lines.push('• "오늘 일정 뭐야?" → 제가 바로 답변');
    lines.push('• "에이전트 뭐 하고 있어?" → 진행 중 작업 모두');
    lines.push('');
    lines.push('_명령 외울 필요 없어요. 자연어로 그냥 말씀해주세요._');
    return lines.join('\n');
}

/* v2.89 — 진행 상태 자기 보고. 디스패치 큐 + 현재 작업 + 추적기 진행 중 작업
   까지 한 화면 요약. 사용자가 "지금 뭐 하고 있어?" 물었을 때 LLM 거치지
   않고 실제 상태를 즉시. */
export function _buildDispatchStatusReport(): string {
    const lines: string[] = ['📊 *지금 상태*\n'];
    const provider = _activeChatProvider;
    const snap = provider?.getDispatchSnapshot?.();
    if (snap?.current) {
        const c = snap.current;
        const priorityIcon = c.priority === 'user' ? '👤' : '🌙';
        const priorityLabel = c.priority === 'user' ? '사용자 명령' : '자율 사이클';
        lines.push(`*${priorityIcon} 진행 중* (${c.elapsedSec}초 째)`);
        lines.push(`  ${priorityLabel}: ${c.prompt.slice(0, 80)}${c.prompt.length > 80 ? '…' : ''}`);
        lines.push('');
    } else {
        lines.push('_대기 중 (현재 진행하는 작업 없음)_\n');
    }
    if (snap && snap.queueLength > 0) {
        lines.push(`*⏳ 대기 줄 (${snap.queueLength}건)*`);
        for (const q of snap.queue) {
            const icon = q.priority === 'user' ? '👤' : '🌙';
            lines.push(`  ${icon} ${q.prompt.slice(0, 70)}${q.prompt.length > 70 ? '…' : ''}`);
        }
        lines.push('');
    }
    /* 추적기 진행 중 작업 */
    try {
        const open = listOpenTrackerTasks().slice(0, 8);
        if (open.length > 0) {
            lines.push(`*📋 추적 중인 작업 (${open.length}건)*`);
            for (const t of open) {
                const ico = t.status === 'in_progress' ? '🔄' : '⏳';
                const owner = t.owner === 'user' ? '👤' : t.owner === 'mixed' ? '👥' : '🤖';
                lines.push(`  ${ico} ${owner} ${t.title.slice(0, 60)}`);
            }
            lines.push('');
        }
    } catch { /* tracker may not exist */ }
    /* 24시간 자율 사이클 ON/OFF */
    try {
        const enabled = vscode.workspace.getConfiguration('agentOs').get<boolean>('autoCycleEnabled', true);
        lines.push(`*🌙 24시간 자율 사이클*: ${enabled ? '✅ ON (15분마다 일거리 자동 실행)' : '⏸ OFF'}`);
    } catch { /* ignore */ }
    return lines.join('\n');
}


/* v2.89.24 — 보고 스케줄러. 사용자가 _shared/report_schedule.json 에 정해놓은
   시각마다 자동으로 텔레그램·사이드바에 보고서 발송. cron-style 분 단위 점검.
   schedule.json 형식:
     { entries: [
       { id: 'morning-brief', label: '모닝 브리핑', hour: 9, minute: 0,
         days: [1,2,3,4,5], action: 'briefing', enabled: true },
       { id: 'channel-daily', label: '채널 분석', hour: 8, minute: 0,
         days: [0,1,2,3,4,5,6], action: 'tool', tool: 'channel_full_analysis',
         agentId: 'youtube', enabled: true },
     ] } */
// ──────────────────────────────────────────────────────────────────
// Report scheduler — extension-side thin wrappers (storage + types)
// 본문은 src/scheduler/{storage,planner,types}.ts. _runScheduledReportEntry
// / _scheduleTick / startReportScheduler 는 vscode + setTimeout 의존이라 잔류.
// ──────────────────────────────────────────────────────────────────
type ReportScheduleEntry = sch.ReportScheduleEntry;

function _reportSchedulePath(): string { return sch.schedulePath(getCompanyDir()); }
export function readReportSchedule(): { entries: ReportScheduleEntry[] } { return sch.readSchedule(getCompanyDir()); }
export function writeReportSchedule(s: { entries: ReportScheduleEntry[] }) { sch.writeSchedule(getCompanyDir(), s); }
let _reportSchedulerTimer: NodeJS.Timeout | null = null;
async function _runScheduledReportEntry(entry: ReportScheduleEntry) {
    try {
        if (entry.action === 'briefing') {
            await _runDailyBriefingOnce(true);
        } else if (entry.action === 'tool' && entry.tool && entry.agentId) {
            const toolDir = path.join(getCompanyDir(), '_agents', entry.agentId, 'tools');
            const scriptPath = path.join(toolDir, `${entry.tool}.py`);
            if (!fs.existsSync(scriptPath)) {
                console.warn(`[scheduler] tool not found: ${scriptPath}`);
                return;
            }
            const r = await runCommandCaptured(`${_pythonCmd()} ${JSON.stringify(entry.tool + '.py')}`, toolDir, () => {}, 120000);
            const out = (r.output || '').trim();
            const status = r.exitCode === 0 ? '✅' : `❌ exit ${r.exitCode}`;
            const msg = `📆 *${entry.label}* (스케줄 자동 실행) ${status}\n\n\`\`\`\n${out.slice(0, 3000)}\n\`\`\``;
            try { await sendTelegramLong(msg); } catch { /* silent */ }
            try { _activeChatProvider?.postSystemNote?.(`📆 ${entry.label} 자동 실행 ${status}`, '📆'); } catch { /* ignore */ }
        }
    } catch (e: any) {
        console.warn('[scheduler] entry failed:', e?.message || e);
    }
}
function _scheduleTick() {
    try {
        const sch = readReportSchedule();
        if (sch.entries.length === 0) return;
        const now = new Date();
        const today = now.toISOString().slice(0, 10);
        const dow = now.getDay();
        const hour = now.getHours();
        const minute = now.getMinutes();
        let changed = false;
        for (const entry of sch.entries) {
            if (!entry.enabled) continue;
            if (entry.hour !== hour || entry.minute !== minute) continue;
            if (entry.days && entry.days.length > 0 && !entry.days.includes(dow)) continue;
            if (entry.lastFiredAt === today) continue; /* 오늘 이미 실행 */
            entry.lastFiredAt = today;
            changed = true;
            _runScheduledReportEntry(entry).catch(() => { /* silent */ });
        }
        if (changed) writeReportSchedule(sch);
    } catch (e: any) {
        console.warn('[scheduler] tick failed:', e?.message || e);
    }
}
function startReportScheduler() {
    if (_reportSchedulerTimer) return;
    /* 매 60초마다 점검. 분 단위 정밀도면 충분. */
    _reportSchedulerTimer = setInterval(_scheduleTick, 60_000);
    /* 첫 tick은 30초 후 — 활성화 직후 폭주 방지 */
    setTimeout(_scheduleTick, 30_000);
}


function stopTrackerNudge() {
    if (_trackerNudgeTimer) {
        clearInterval(_trackerNudgeTimer);
        _trackerNudgeTimer = null;
    }
}

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

/* Create a calendar event for a tracker task. Best effort — never throws.
   Returns the eventId if successful so the caller can persist it on the
   tracker entry for future updates. */
async function createCalendarEventForTask(task: TrackerTask): Promise<string | null> {
  if (!task.dueAt) return null;
  const access = await _getCalendarAccessToken();
  if (!access) return null;
  const cfg = readCalendarWriteConfig();
  const calendarId = (cfg.CALENDAR_ID || 'primary').trim() || 'primary';
  const dur = Number(cfg.DEFAULT_DURATION_MINUTES) > 0 ? Number(cfg.DEFAULT_DURATION_MINUTES) : 60;
  /* dueAt is "YYYY-MM-DD" or full ISO. If date-only, default to 9am that day
     so it shows up on the user's morning. */
  let startIso: string;
  let endIso: string;
  let isAllDay = false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(task.dueAt)) {
    const start = new Date(task.dueAt + 'T09:00:00');
    const end = new Date(start.getTime() + dur * 60_000);
    startIso = start.toISOString();
    endIso = end.toISOString();
  } else {
    try {
      const start = new Date(task.dueAt);
      const end = new Date(start.getTime() + dur * 60_000);
      startIso = start.toISOString();
      endIso = end.toISOString();
    } catch {
      return null;
    }
  }
  const body: any = {
    summary: task.title.slice(0, 200),
    description: (task.description || '') + `\n\n📋 추적 ID: ${task.id}\n생성: 비서(Secretary)`,
    start: isAllDay ? { date: task.dueAt } : { dateTime: startIso },
    end: isAllDay ? { date: task.dueAt } : { dateTime: endIso },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 5 }, { method: 'popup', minutes: 60 }] },
  };
  try {
    const res = await axios.post(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      body,
      {
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        timeout: 12000,
        validateStatus: () => true,
      }
    );
    if (res.status >= 200 && res.status < 300 && res.data?.id) {
      return String(res.data.id);
    }
    console.warn('[Calendar] create event failed:', res.status, res.data);
    return null;
  } catch (e: any) {
    console.warn('[Calendar] create event error:', e?.message || e);
    return null;
  }
}

/* Update a calendar event when its tracker task changes. Best effort —
   silently no-ops if the task has no event id or Calendar isn't connected.
   Used when a task gets renamed, completed, or its due date moves. */
async function updateCalendarEventForTask(task: TrackerTask): Promise<boolean> {
  if (!task.calendarEventId) return false;
  const access = await _getCalendarAccessToken();
  if (!access) return false;
  const cfg = readCalendarWriteConfig();
  const calendarId = (cfg.CALENDAR_ID || 'primary').trim() || 'primary';
  const dur = Number(cfg.DEFAULT_DURATION_MINUTES) > 0 ? Number(cfg.DEFAULT_DURATION_MINUTES) : 60;
  const body: any = {
    summary: (task.status === 'done' ? '✅ ' : task.status === 'cancelled' ? '✖️ ' : '') + task.title.slice(0, 200),
    description: (task.description || '') + `\n\n📋 추적 ID: ${task.id}\n상태: ${task.status}\n수정: 비서(Secretary)`,
  };
  if (task.dueAt) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(task.dueAt)) {
      const start = new Date(task.dueAt + 'T09:00:00');
      const end = new Date(start.getTime() + dur * 60_000);
      body.start = { dateTime: start.toISOString() };
      body.end = { dateTime: end.toISOString() };
    } else {
      try {
        const start = new Date(task.dueAt);
        const end = new Date(start.getTime() + dur * 60_000);
        body.start = { dateTime: start.toISOString() };
        body.end = { dateTime: end.toISOString() };
      } catch { /* skip time update */ }
    }
  }
  try {
    const r = await axios.patch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(task.calendarEventId)}`,
      body,
      {
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        timeout: 12000, validateStatus: () => true,
      }
    );
    return r.status >= 200 && r.status < 300;
  } catch { return false; }
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


/* Stale-task nudge — Secretary scans the tracker every hour for user-owned
   tasks that have been pending >24h or are past their due date, and sends
   a single nudge per task via Telegram. Conservative: 1 ping per task max
   per ~24h, no spam. */
let _trackerNudgeTimer: NodeJS.Timeout | null = null;
const _NUDGE_WINDOW_MS = 23 * 60 * 60 * 1000; /* re-ping no more than once per ~day */
async function _runTrackerNudgeOnce() {
    /* Piggyback: refresh calendar_cache.md via OAuth if connected. This means
       OAuth users don't have to also configure the iCal tool — every hour
       we pull fresh events. Failure is silent. */
    if (isCalendarWriteConnected()) {
        refreshCalendarCacheViaOAuth(14).catch(() => { /* never let this break nudges */ });
    }
    try {
        const { token, chatId } = readTelegramConfig();
        if (!token || !chatId) return; // can't nudge without channel
        const tracker = readTracker();
        const now = Date.now();
        let changed = false;
        const nudges: string[] = [];
        for (const t of tracker.tasks) {
            if (t.status === 'done' || t.status === 'cancelled') continue;
            if (t.owner !== 'user' && t.owner !== 'mixed') continue;
            const lastNudge = (t as any)._lastNudgeAt ? new Date((t as any)._lastNudgeAt).getTime() : 0;
            if (now - lastNudge < _NUDGE_WINDOW_MS) continue;
            const ageDays = (now - new Date(t.createdAt).getTime()) / 86_400_000;
            const overdue = t.dueAt && new Date(t.dueAt).getTime() < now;
            if (!overdue && ageDays < 1) continue; /* not stale yet */
            nudges.push(`• \`${t.id.slice(-9)}\` ${t.title}${t.dueAt ? ` ⏰${t.dueAt.slice(0, 10)}` : ''}${overdue ? ' 🔴' : ''}`);
            (t as any)._lastNudgeAt = new Date().toISOString();
            t.nudges = (t.nudges || 0) + 1;
            changed = true;
        }
        if (changed) writeTracker(tracker);
        if (nudges.length > 0) {
            const body = `👀 *비서: 확인해주세요*\n\n진행되지 않은 사용자 작업이 있어요:\n\n${nudges.slice(0, 8).join('\n')}\n\n_완료: \`/done <id>\` · 취소: \`/cancel <id>\`_`;
            await sendTelegramReport(body);
        }
    } catch { /* never let nudge errors break anything */ }
}
function startTrackerNudgeLoop() {
    if (_trackerNudgeTimer) return;
    /* First check after 5 min, then hourly. Light interval keeps batterylcheap. */
    setTimeout(_runTrackerNudgeOnce, 5 * 60 * 1000);
    _trackerNudgeTimer = setInterval(_runTrackerNudgeOnce, 60 * 60 * 1000);
}

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

export async function _runDailyBriefingOnce(force = false): Promise<void> {
    try {
        const cfg = vscode.workspace.getConfiguration('agentOs');
        const time = _parseBriefingTime(cfg.get<string>('dailyBriefingTime') || '09:00');
        if (!time && !force) return; // off
        const { token, chatId } = readTelegramConfig();
        if (!token || !chatId) return; // no channel
        const today = new Date().toISOString().slice(0, 10);
        const lastSent = _extCtx?.globalState.get<string>(_DAILY_BRIEFING_KEY, '');
        if (!force && lastSent === today) return; // already sent today

        /* Build the brief — kept text-only so the prompt stays small. */
        const dir = getCompanyDir();
        const company = readCompanyName() || '1인 기업';
        const dateStr = new Date().toLocaleDateString('ko-KR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

        /* 1. Calendar */
        let calBlock = '';
        try {
            const cal = _safeReadText(path.join(dir, '_shared', 'calendar_cache.md')).trim();
            if (cal) {
                const calLines = cal.split('\n').filter(l => l.trim().startsWith('-')).slice(0, 6);
                if (calLines.length > 0) calBlock = `\n*📅 오늘 일정*\n${calLines.join('\n')}\n`;
            }
        } catch { /* ignore */ }
        if (!calBlock) calBlock = '\n*📅 오늘 일정*\n_등록된 일정이 없어요._\n';

        /* 2. Open tasks (top 5 by priority) */
        let taskBlock = '';
        try {
            const md = trackerToMarkdown({ onlyOpen: true, max: 5 });
            taskBlock = md ? `\n*✅ 우선순위 할 일 (상위 5)*\n${md}\n` : '\n*✅ 할 일*\n_진행 중인 작업이 없어요._\n';
        } catch { /* ignore */ }

        /* 3. Yesterday highlights — last 800 chars of yesterday's log */
        let yhBlock = '';
        try {
            const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
            const ypath = path.join(getConversationsDir(), `${yest}.md`);
            const txt = _safeReadText(ypath);
            if (txt.trim()) {
                const tail = txt.slice(-700);
                yhBlock = `\n*📝 어제 회사 활동 (요약 컨텍스트)*\n${tail.slice(0, 700)}\n`;
            }
        } catch { /* ignore */ }

        /* 4. v2.89.136 — 어제 PayPal 매출 (가능하면). business/tools/paypal_revenue.py
           를 LOOKBACK_DAYS=1 으로 동기 실행 → 어제 총 매출·거래수만 한 줄 추출.
           paypal 설정 안 됐거나 실패 시 silently skip — 브리핑 자체는 항상 발송. */
        let revBlock = '';
        try {
            const ppToolDir = path.join(getCompanyDir(), '_agents', 'business', 'tools');
            const ppScript = path.join(ppToolDir, 'paypal_revenue.py');
            const ppJson = path.join(ppToolDir, 'paypal_revenue.json');
            if (fs.existsSync(ppScript) && fs.existsSync(ppJson)) {
                const env = { ...process.env, LOOKBACK_DAYS: '1' };
                const r = await new Promise<{ exitCode: number; output: string }>((resolve) => {
                    const cp = require('child_process');
                    const p = cp.spawn(_pythonCmd(), [ppScript], { cwd: ppToolDir, env });
                    let out = '';
                    p.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
                    p.on('close', (code: number) => resolve({ exitCode: code, output: out }));
                    setTimeout(() => { try { p.kill(); } catch {} resolve({ exitCode: -1, output: out }); }, 15000);
                });
                if (r.exitCode === 0 && r.output) {
                    /* 출력 마크다운에서 첫 통화 행 추출 — 예: "| **USD** | 14.95 | -0 | ..." */
                    const m = r.output.match(/\|\s*\*\*([A-Z]{3})\*\*\s*\|\s*([\d.,]+)\s*\|[^|]+\|[^|]+\|\s*\*\*([\d.,]+)\*\*\s*\|\s*(\d+)건/);
                    if (m) {
                        revBlock = `\n*💰 어제 매출*\n  ${m[1]} ${m[2]} (순매출 ${m[3]}, ${m[4]}건)\n`;
                    } else if (/거래가 없어요/.test(r.output)) {
                        revBlock = '\n*💰 어제 매출*\n  _거래 0건_\n';
                    }
                }
            }
        } catch { /* ignore — briefing 자체는 항상 진행 */ }

        const body = `🌅 *${company} — 아침 브리핑*\n_${dateStr}_\n${calBlock}${taskBlock}${revBlock}${yhBlock}\n_명령: \`/today\` 다시 보기 · \`/tools\` 도구 상태_`;
        await sendTelegramReport(body);
        if (_extCtx) {
            _extCtx.globalState.update(_DAILY_BRIEFING_KEY, today);
        }
        try { appendConversationLog({ speaker: '비서', emoji: '🌅', section: '데일리 브리핑', body: body.slice(0, 1000) }); } catch { /* ignore */ }
        /* v2.82: removed the system-note injection into chat. Daily briefing
           now lives only in: (1) telegram, (2) company dashboard "회사
           활동 로그" + KPI strip, (3) conversation log file. The chat is
           kept as a clean conversation surface — no auto-injected cards. */
    } catch { /* never let briefing errors break the extension */ }
}

function startDailyBriefingLoop() {
    if (_dailyBriefingTimer) return;
    /* Check every minute — cheap, gives ±60s precision on the configured time.
       The single-fire guard via globalState makes this safe to over-tick. */
    _dailyBriefingTimer = setInterval(() => {
        try {
            const cfg = vscode.workspace.getConfiguration('agentOs');
            const time = _parseBriefingTime(cfg.get<string>('dailyBriefingTime') || '09:00');
            if (!time) return;
            const now = new Date();
            if (now.getHours() === time.hour && now.getMinutes() === time.minute) {
                _runDailyBriefingOnce().catch(() => { /* silent */ });
            }
        } catch { /* ignore */ }
    }, 60 * 1000);
}

function stopDailyBriefingLoop() {
    if (_dailyBriefingTimer) {
        clearInterval(_dailyBriefingTimer);
        _dailyBriefingTimer = null;
    }
}

/* ── v2.89.137 — Revenue Watcher (PayPal polling) ──────────────────────────
   5분마다 paypal_revenue.py OUTPUT=json 호출 → 마지막 본 transaction id 와
   비교 → 새 결제 발견 시 텔레그램 푸시 + 사무실 영숙 책상 펄스. paypal 미설정
   시 silently skip. 이게 진짜 "AI 회사가 자고 있어도 결제 알아차림" 의 코어. */
let _revenueWatcherTimer: NodeJS.Timeout | null = null;
const _REVENUE_LAST_SEEN_KEY = 'revenueLastSeenTxId';
const _REVENUE_LAST_SEEN_TS_KEY = 'revenueLastSeenTxTs';
const REVENUE_POLL_INTERVAL_MS = 5 * 60 * 1000; /* 5분 */

async function _runRevenueWatcherOnce(): Promise<void> {
    try {
        const ppToolDir = path.join(getCompanyDir(), '_agents', 'business', 'tools');
        const ppScript = path.join(ppToolDir, 'paypal_revenue.py');
        const ppJson = path.join(ppToolDir, 'paypal_revenue.json');
        if (!fs.existsSync(ppScript) || !fs.existsSync(ppJson)) return;
        const cfg = JSON.parse(_safeReadText(ppJson) || '{}');
        if (!cfg.CLIENT_ID || !cfg.CLIENT_SECRET) return; /* 미설정 — silent */

        const env = { ...process.env, OUTPUT: 'json', LOOKBACK_DAYS: '2' };
        const r = await new Promise<{ exitCode: number; output: string }>((resolve) => {
            const cp = require('child_process');
            const p = cp.spawn(_pythonCmd(), [ppScript], { cwd: ppToolDir, env });
            let out = '';
            p.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
            p.on('close', (code: number) => resolve({ exitCode: code, output: out }));
            setTimeout(() => { try { p.kill(); } catch {} resolve({ exitCode: -1, output: out }); }, 20000);
        });
        if (r.exitCode !== 0 || !r.output) return;

        let data: any;
        try { data = JSON.parse(r.output); } catch { return; }
        const txs: any[] = Array.isArray(data?.transactions) ? data.transactions : [];
        if (txs.length === 0) return;

        const lastSeenTs = Number(_extCtx?.globalState.get<number>(_REVENUE_LAST_SEEN_TS_KEY, 0) || 0);
        const lastSeenId = String(_extCtx?.globalState.get<string>(_REVENUE_LAST_SEEN_KEY, '') || '');

        /* 첫 실행 — 알림 보내지 말고 baseline 만 기록 (사용자 폭주 방지) */
        if (lastSeenTs === 0) {
            const newest = txs[0];
            _extCtx?.globalState.update(_REVENUE_LAST_SEEN_TS_KEY, newest.ts_epoch);
            _extCtx?.globalState.update(_REVENUE_LAST_SEEN_KEY, newest.id);
            return;
        }

        /* 새 거래 = lastSeenTs 보다 ts 큰 것 (refund 포함, 사용자에게 다 알림). */
        const fresh = txs.filter(t => t.ts_epoch > lastSeenTs && t.id !== lastSeenId);
        if (fresh.length === 0) return;

        /* 가장 최신부터 역순 정렬 → 알림은 옛 → 신순 */
        fresh.sort((a, b) => a.ts_epoch - b.ts_epoch);
        for (const tx of fresh) {
            const isRefund = !!tx.is_refund;
            const arrow = isRefund ? '↩️ 환불' : '💰 새 결제';
            const sign = isRefund ? '-' : '+';
            const amount = `${sign}${Math.abs(tx.value).toFixed(2)} ${tx.currency}`;
            const subj = tx.subject || '(설명 없음)';
            const monthTotal = data?.totals?.by_period?.month || 0;
            const cur = (data?.totals?.by_currency && Object.keys(data.totals.by_currency)[0]) || tx.currency;
            const body = `${arrow} 도착!\n*${subj}*\n${amount}\n_30일 누적: ${monthTotal.toFixed(2)} ${cur}_`;
            try { await sendTelegramReport(body); } catch { /* ignore */ }
            try {
                appendConversationLog({
                    speaker: '비서', emoji: isRefund ? '↩️' : '💰',
                    section: isRefund ? '환불 감지' : '새 결제',
                    body: `${arrow}: ${subj} ${amount}`
                });
            } catch { /* ignore */ }
            /* 사무실 영숙 책상 펄스 + 알림 */
            try {
                _activeChatProvider?.pulseAgent?.('secretary', isRefund ? '↩️' : '💰', 6000, `${arrow}: ${amount}`);
            } catch { /* ignore */ }
        }

        /* baseline 업데이트 — 가장 최신 거래로 */
        const newest = fresh[fresh.length - 1];
        _extCtx?.globalState.update(_REVENUE_LAST_SEEN_TS_KEY, newest.ts_epoch);
        _extCtx?.globalState.update(_REVENUE_LAST_SEEN_KEY, newest.id);
    } catch (e: any) {
        console.warn('[Agent OS] revenue watcher tick 실패:', e?.message || e);
    }
}

function startRevenueWatcherLoop() {
    if (_revenueWatcherTimer) return;
    /* 첫 tick: activate 후 30초. 그 뒤 5분마다. */
    setTimeout(() => { _runRevenueWatcherOnce(); }, 30_000);
    _revenueWatcherTimer = setInterval(() => {
        _runRevenueWatcherOnce();
    }, REVENUE_POLL_INTERVAL_MS);
}

function stopRevenueWatcherLoop() {
    if (_revenueWatcherTimer) {
        clearInterval(_revenueWatcherTimer);
        _revenueWatcherTimer = null;
    }
}

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

export function _coercePriority(v: unknown): TaskPriority { return trk.coercePriority(v); }
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
async function scaffoldDeveloperProject(name: string, template: 'vite-vanilla' | 'vite-react' | 'static'): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
    try {
        const safe = name.replace(/[^a-zA-Z0-9_-]/g, '');
        if (!safe) return { ok: false, error: '유효하지 않은 이름' };
        const root = path.join(getCompanyDir(), 'projects', safe);
        if (fs.existsSync(root)) return { ok: false, error: `이미 존재: ${root}` };
        fs.mkdirSync(path.join(root, 'site'), { recursive: true });
        fs.mkdirSync(path.join(root, 'logs'), { recursive: true });

        if (template === 'static') {
            fs.writeFileSync(path.join(root, 'site', 'index.html'),
`<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safe}</title>
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-zinc-950 text-zinc-100 min-h-screen flex items-center justify-center">
  <main class="text-center space-y-4">
    <h1 class="text-4xl font-bold">${safe}</h1>
    <p class="text-zinc-400">Agent OS · Developer 에이전트가 만든 페이지</p>
  </main>
</body>
</html>
`);
        } else if (template === 'vite-vanilla') {
            fs.writeFileSync(path.join(root, 'site', 'package.json'),
                JSON.stringify({
                    name: safe,
                    private: true,
                    type: 'module',
                    scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
                    devDependencies: { vite: '^5.0.0' },
                }, null, 2));
            fs.writeFileSync(path.join(root, 'site', 'index.html'),
`<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>${safe}</title>
</head>
<body>
<h1>${safe}</h1>
<script type="module" src="/main.js"></script>
</body>
</html>
`);
            fs.writeFileSync(path.join(root, 'site', 'main.js'),
`document.querySelector('h1').addEventListener('click', () => {
  console.log('hi from ${safe}');
});
`);
        } else if (template === 'vite-react') {
            fs.writeFileSync(path.join(root, 'site', 'package.json'),
                JSON.stringify({
                    name: safe,
                    private: true,
                    type: 'module',
                    scripts: { dev: 'vite', build: 'tsc && vite build', preview: 'vite preview' },
                    dependencies: { react: '^18.3.0', 'react-dom': '^18.3.0' },
                    devDependencies: {
                        '@types/react': '^18.3.0',
                        '@types/react-dom': '^18.3.0',
                        '@vitejs/plugin-react': '^4.3.0',
                        typescript: '^5.4.0',
                        vite: '^5.0.0',
                    },
                }, null, 2));
            fs.writeFileSync(path.join(root, 'site', 'tsconfig.json'),
                JSON.stringify({
                    compilerOptions: {
                        target: 'ES2020',
                        useDefineForClassFields: true,
                        lib: ['ES2020', 'DOM', 'DOM.Iterable'],
                        module: 'ESNext',
                        skipLibCheck: true,
                        moduleResolution: 'bundler',
                        allowImportingTsExtensions: true,
                        resolveJsonModule: true,
                        isolatedModules: true,
                        noEmit: true,
                        jsx: 'react-jsx',
                        strict: true,
                    },
                    include: ['src'],
                }, null, 2));
            fs.writeFileSync(path.join(root, 'site', 'vite.config.ts'),
`import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()] });
`);
            fs.writeFileSync(path.join(root, 'site', 'index.html'),
`<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><title>${safe}</title></head>
<body>
<div id="root"></div>
<script type="module" src="/src/main.tsx"></script>
</body>
</html>
`);
            fs.mkdirSync(path.join(root, 'site', 'src'), { recursive: true });
            fs.writeFileSync(path.join(root, 'site', 'src', 'main.tsx'),
`import React from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  return <h1>${safe}</h1>;
}

createRoot(document.getElementById('root')!).render(<App />);
`);
        }

        fs.writeFileSync(path.join(root, 'README.md'),
`# ${safe}

Developer 에이전트가 ${new Date().toISOString().slice(0, 10)}에 만든 프로젝트.
템플릿: \`${template}\`

## 다음 스텝

${template === 'static'
    ? `\`\`\`bash\ncd site && ${_pythonCmd()} -m http.server 5173\n# 또는: npx serve site\n\`\`\`\n브라우저에서 http://127.0.0.1:5173 열기.`
    : `\`\`\`bash\ncd site && npm install && npm run dev\n\`\`\`\nVite dev server가 http://localhost:5173 에서 실행됩니다.`}

## 결정 로그
\`decisions.md\`에 누적됩니다.
`);
        fs.writeFileSync(path.join(root, 'decisions.md'),
`# 📌 ${safe} 결정 로그

_Developer 에이전트와 사용자가 내린 디자인·기술 의사결정이 시간순으로 누적됩니다._

## [${new Date().toISOString().slice(0, 10)}] 프로젝트 생성
- 템플릿: \`${template}\`
- 위치: \`${path.relative(getCompanyDir(), root)}\`
`);
        try { appendConversationLog({ speaker: 'Developer', emoji: '💻', section: '프로젝트 생성', body: `${safe} (\`${template}\`) 생성 → ${root}` }); } catch { /* ignore */ }
        /* Tracker entry so the user sees it in the sidebar Task panel. */
        try {
            addTrackerTask({
                title: `${safe} 프로젝트 셋업 (${template})`,
                description: `다음 스텝: cd site && ${template === 'static' ? 'serve' : 'npm install && npm run dev'}`,
                owner: 'mixed',
                agentIds: ['developer'],
                status: 'in_progress',
                priority: 'normal',
            });
        } catch { /* ignore */ }
        /* Telegram ping so the user knows from any channel. */
        sendTelegramReport(`💻 *Developer*: \`${safe}\` 프로젝트 만들었어요 (${template})\n\n로컬: \`${path.relative(getCompanyDir(), root)}\`\n다음: ${template === 'static' ? `\`cd site && ${_pythonCmd()} -m http.server 5173\`` : '`cd site && npm install && npm run dev`'}`).catch(() => { /* silent */ });
        return { ok: true, path: root };
    } catch (e: any) {
        return { ok: false, error: e?.message || String(e) };
    }
}

export async function _youtubeCommentReplyDraftBatch(opts: { maxComments?: number; maxPerVideo?: number } = {}): Promise<{ drafted: number; skipped: number; reason?: string }> {
    /* Office pulse so the user sees youtube agent is working on something
       even when triggered from a button press rather than chat dispatch. */
    try { _activeChatProvider?.pulseAgent?.('youtube', '📺', 4000, '댓글 큐 갱신 중'); } catch { /* ignore */ }
    const cfgPath = path.join(getCompanyDir(), '_agents', 'youtube', 'config.md');
    const cfgTxt = _safeReadText(cfgPath);
    const apiM = cfgTxt.match(/YOUTUBE_API_KEY\s*[:：=]\s*([A-Za-z0-9_\-]+)/);
    const chM  = cfgTxt.match(/YOUTUBE_CHANNEL_ID\s*[:：=]\s*([A-Za-z0-9_\-]+)/);
    if (!apiM || !chM) {
        return { drafted: 0, skipped: 0, reason: 'YOUTUBE_API_KEY 또는 YOUTUBE_CHANNEL_ID 미설정 (`_agents/youtube/config.md`)' };
    }
    const apiKey = apiM[1];
    const channelId = chM[1];
    const maxComments = opts.maxComments ?? 10;
    const maxPerVideo = opts.maxPerVideo ?? 3;
    /* 1) channel → recent uploads playlist */
    let uploads = '';
    try {
        const r = await axios.get(`https://www.googleapis.com/youtube/v3/channels`, {
            params: { part: 'contentDetails', id: channelId, key: apiKey },
            timeout: 10000,
        });
        uploads = r.data?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads || '';
    } catch (e: any) {
        return { drafted: 0, skipped: 0, reason: `채널 조회 실패: ${e?.message || e}` };
    }
    if (!uploads) return { drafted: 0, skipped: 0, reason: '업로드 플레이리스트를 찾지 못함' };
    /* 2) recent video ids */
    let videoIds: string[] = [];
    try {
        const r = await axios.get(`https://www.googleapis.com/youtube/v3/playlistItems`, {
            params: { part: 'contentDetails', playlistId: uploads, maxResults: 5, key: apiKey },
            timeout: 10000,
        });
        videoIds = (r.data?.items || []).map((it: any) => it.contentDetails?.videoId).filter(Boolean);
    } catch (e: any) {
        return { drafted: 0, skipped: 0, reason: `최근 영상 조회 실패: ${e?.message || e}` };
    }
    /* 3) for each video, fetch top comments, draft replies, create approvals.
       Skip comments that already have a pending approval to avoid spam on
       repeated runs. */
    const pendingNow = listPendingApprovals();
    const existingCommentIds = new Set(
        pendingNow
            .filter(a => a.kind === 'youtube.comment_reply')
            .map(a => String(a.payload?.commentId || ''))
    );
    let drafted = 0, skipped = 0;
    for (const videoId of videoIds) {
        if (drafted >= maxComments) break;
        let comments: any[] = [];
        try {
            const r = await axios.get(`https://www.googleapis.com/youtube/v3/commentThreads`, {
                params: { part: 'snippet', videoId, maxResults: maxPerVideo, order: 'time', key: apiKey, textFormat: 'plainText' },
                timeout: 10000,
            });
            comments = r.data?.items || [];
        } catch { continue; /* video may have comments disabled */ }
        for (const c of comments) {
            if (drafted >= maxComments) break;
            const top = c.snippet?.topLevelComment?.snippet;
            const commentId = c.snippet?.topLevelComment?.id;
            if (!top || !commentId) continue;
            if (existingCommentIds.has(commentId)) { skipped++; continue; }
            /* If channel owner has already replied, skip — the conversation
               is owned by a human now. */
            if ((c.snippet?.totalReplyCount || 0) > 0) { skipped++; continue; }
            const author = top.authorDisplayName || '익명';
            const text = (top.textDisplay || '').slice(0, 500);
            let draft = '';
            try {
                draft = await _quickLLMCall(
                    `당신은 1인 크리에이터의 YouTube 댓글 답장 작성기입니다. 친근하고 짧게 (1~3문장), 한국어로, 채널 톤 유지. 욕설·논쟁 회피, 스팸성 댓글은 "감사합니다 ☺️" 같이 짧게.`,
                    `[댓글 작성자] ${author}\n[댓글]\n${text}\n\n위 댓글에 답장 초안을 1~3문장으로.`,
                    200
                );
            } catch { /* skip on draft failure */ continue; }
            const reply = (draft || '').trim();
            if (!reply) continue;
            createApproval({
                agentId: 'youtube',
                title: `${author}님 댓글에 답장`,
                summary: `*원댓글:* ${text.slice(0, 200)}\n\n*답장 초안:* ${reply.slice(0, 300)}`,
                kind: 'youtube.comment_reply',
                payload: { videoId, commentId, replyText: reply, author, originalText: text },
            });
            drafted++;
        }
    }
    return { drafted, skipped };
}

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

/* P1-6: Recurrence loop — every minute, scans tracker for tasks whose
   nextRunAt has passed. For each, spawns a fresh "instance" copy in
   pending status and bumps the template's nextRunAt forward. The original
   task acts as the template; the spawned copies are what the user actually
   completes. Templates have status='in_progress' permanently — they're
   never marked done by the user. */
let _recurrenceTimer: NodeJS.Timeout | null = null;

function _runRecurrenceTickOnce() {
    try {
        const tracker = readTracker();
        const now = Date.now();
        let anySpawned = false;
        for (const t of tracker.tasks) {
            if (!t.recurrence) continue;
            if (t.status === 'cancelled') continue;
            if (!t.nextRunAt) {
                /* First time we've seen this template — schedule from createdAt
                   so freshly-added recurring tasks don't fire immediately. */
                const baseline = new Date(t.createdAt);
                t.nextRunAt = _computeNextRunAt(baseline, t.recurrence).toISOString();
                continue;
            }
            const due = new Date(t.nextRunAt).getTime();
            if (now < due) continue;
            /* Spawn a fresh instance (without recurrence — only the template
               is recurring). Owner inherits from template. */
            addTrackerTask({
                title: t.title,
                description: t.description,
                owner: t.owner,
                agentIds: t.agentIds,
                priority: _coercePriority(t.priority),
                dueAt: t.nextRunAt,
                status: t.owner === 'agent' ? 'in_progress' : 'pending',
            });
            /* Advance template's nextRunAt — handles the "machine was off
               overnight, multiple cycles missed" case by jumping forward
               until we're back in the future. */
            let advance = new Date(t.nextRunAt);
            while (advance.getTime() <= now) {
                advance = _computeNextRunAt(advance, t.recurrence);
            }
            t.nextRunAt = advance.toISOString();
            anySpawned = true;
        }
        if (anySpawned) writeTracker(tracker);
    } catch { /* never let recurrence break anything */ }
}

function startRecurrenceLoop() {
    if (_recurrenceTimer) return;
    /* First check after 1 minute, then every minute. The 1-min granularity
       is the same as the daily-briefing loop, so the two cooperate cleanly
       without needing a shared scheduler. */
    setTimeout(_runRecurrenceTickOnce, 60 * 1000);
    _recurrenceTimer = setInterval(_runRecurrenceTickOnce, 60 * 1000);
}
function stopRecurrenceLoop() {
    if (_recurrenceTimer) { clearInterval(_recurrenceTimer); _recurrenceTimer = null; }
}

/* P1-7: Pre-alarms — sends a Telegram nudge 1 day before and 1 hour before
   each task's dueAt. Tracked via preAlarmsSent[] so each window only fires
   once per task. Independent from stale-task nudges (which fire AFTER due).
   Tick is hourly — finer granularity wastes battery, the 1d-before window
   has 24h of slack so the user gets the reminder on a sensible cadence. */
let _preAlarmTimer: NodeJS.Timeout | null = null;
const _PRE_ALARM_WINDOWS: Array<{ key: string; ms: number; label: string }> = [
    { key: 't1d', ms: 24 * 60 * 60_000, label: '내일' },
    { key: 't1h', ms:  1 * 60 * 60_000, label: '1시간 후' },
];

async function _runPreAlarmTickOnce(): Promise<void> {
    try {
        const { token, chatId } = readTelegramConfig();
        if (!token || !chatId) return;
        const tracker = readTracker();
        const now = Date.now();
        let changed = false;
        const lines: string[] = [];
        for (const t of tracker.tasks) {
            if (t.status === 'done' || t.status === 'cancelled') continue;
            if (!t.dueAt) continue;
            const due = new Date(t.dueAt).getTime();
            if (isNaN(due) || due < now) continue;
            const remaining = due - now;
            const sent = t.preAlarmsSent || [];
            for (const w of _PRE_ALARM_WINDOWS) {
                if (sent.includes(w.key)) continue;
                /* Fire when the remaining time has dropped below the window
                   threshold but the task is still in the future. So a 1d
                   alarm fires when due is within 24h, 1h alarm fires within
                   60min. The "below" condition (not "equal") is what makes
                   this work even if the tick lands a few minutes late. */
                if (remaining <= w.ms) {
                    const a = (t.agentIds && t.agentIds[0]) ? AGENTS[t.agentIds[0]] : null;
                    const owner = a ? `${a.emoji} ${a.name}` : (t.owner === 'user' ? '👤 사용자' : '🤖 에이전트');
                    lines.push(`• ⏰${w.label} \`${t.id.slice(-9)}\` ${owner}: ${t.title}`);
                    sent.push(w.key);
                    t.preAlarmsSent = sent;
                    changed = true;
                }
            }
        }
        if (changed) writeTracker(tracker);
        if (lines.length > 0) {
            const body = `🔔 *사전 알림*\n\n${lines.slice(0, 8).join('\n')}\n\n_미루기: \`/reschedule <id> <시간>\` · 완료: \`/done <id>\`_`;
            await sendTelegramReport(body);
        }
    } catch { /* silent */ }
}

function startPreAlarmLoop() {
    if (_preAlarmTimer) return;
    /* First tick after 2 min, then hourly. The 2-min initial gives the
       extension time to fully boot before we start firing user alerts. */
    setTimeout(_runPreAlarmTickOnce, 2 * 60 * 1000);
    _preAlarmTimer = setInterval(_runPreAlarmTickOnce, 60 * 60 * 1000);
}
function stopPreAlarmLoop() {
    if (_preAlarmTimer) { clearInterval(_preAlarmTimer); _preAlarmTimer = null; }
}

/* P1-5: Pull markdown checkbox items out of an agent's output. We accept
   `- [ ]`, `* [ ]`, and numbered `1. [ ]` forms so different agents'
   formatting all flow into one tracker. Only unchecked items count —
   `[x]` is already-done, and we don't try to retroactively register
   completed work. Capped to 5 per output to prevent runaway lists. */
export function _harvestActionItems(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*(?:[-*]|\d+\.)\s*\[\s\]\s+(.{4,200})$/);
    if (m) {
      const title = m[1].trim().replace(/\s+/g, ' ');
      if (title && !out.includes(title)) out.push(title);
      if (out.length >= 5) break;
    }
  }
  return out;
}

export function trackerToMarkdown(opts: { onlyOpen?: boolean; max?: number } = {}): string {
  const all = readTracker().tasks;
  const tasks = opts.onlyOpen ? all.filter(t => t.status !== 'done' && t.status !== 'cancelled') : all;
  if (tasks.length === 0) return '';
  /* Sort: status (in_progress > pending > done) → priority (urgent > high > normal > low)
     → newest createdAt within ties. Status before priority means a 'done urgent'
     still falls below an open 'low' — open work always surfaces first. */
  const order = (s: TrackerTask['status']) => s === 'in_progress' ? 0 : s === 'pending' ? 1 : s === 'done' ? 2 : 3;
  tasks.sort((a, b) => {
    const o = order(a.status) - order(b.status);
    if (o !== 0) return o;
    const pa = TASK_PRIORITY_ORDER[_coercePriority(a.priority)];
    const pb = TASK_PRIORITY_ORDER[_coercePriority(b.priority)];
    if (pa !== pb) return pa - pb;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
  const max = opts.max || 25;
  const lines: string[] = [];
  for (const t of tasks.slice(0, max)) {
    const icon = t.status === 'done' ? '✅'
      : t.status === 'in_progress' ? '🔄'
      : t.status === 'pending' ? '⏳'
      : '✖️';
    const ownerEmoji = t.owner === 'user' ? '👤'
      : t.owner === 'mixed' ? '👥'
      : (t.agentIds && t.agentIds[0] ? (AGENTS[t.agentIds[0]]?.emoji || '🤖') : '🤖');
    const due = t.dueAt ? ` ⏰${t.dueAt.slice(0, 10)}` : '';
    const aged = (Date.now() - new Date(t.createdAt).getTime()) / 86_400_000;
    const stale = (t.status === 'pending' && aged > 1) ? ' 🟡' : '';
    const prio = _coercePriority(t.priority);
    /* Show priority chip only for non-default — keeps the line short for
       the common 'normal' case while still surfacing urgent/high visually. */
    const prioChip = prio === 'normal' ? '' : ` ${TASK_PRIORITY_LABEL[prio].split(' ')[0]}`;
    const recur = t.recurrence ? ` 🔁${t.recurrence}` : '';
    lines.push(`- ${icon}${prioChip} ${ownerEmoji} \`${t.id.slice(-9)}\` ${t.title}${due}${recur}${stale}`);
  }
  return lines.join('\n');
}

/* ── Task Tree View (sidebar) ─────────────────────────────────────────────
   P0-1: visualizes tracker.json as a clickable tree. Top level = status
   groups (진행중 / 대기 / 완료 / 취소). Children = task entries with
   priority chip, owner emoji, due, recurrence indicator. Inline actions
   (✅ / ✖️) come from package.json menus → registered commands.
   The tree auto-refreshes via onTrackerChanged. */

/* Map a priority level to a colored ThemeIcon for the group header. */
export function _priorityGroupIcon(p: TaskPriority): vscode.ThemeIcon {
    switch (p) {
        case 'urgent': return new vscode.ThemeIcon('error',     new vscode.ThemeColor('errorForeground'));
        case 'high':   return new vscode.ThemeIcon('warning',   new vscode.ThemeColor('list.warningForeground'));
        case 'normal': return new vscode.ThemeIcon('circle-outline');
        case 'low':    return new vscode.ThemeIcon('chevron-down', new vscode.ThemeColor('descriptionForeground'));
    }
}

/* Per-task icon — encodes status + due-urgency. We use VS Code's built-in
   codicon names so the look stays consistent with the rest of the IDE. */
export function _taskStatusIcon(t: TrackerTask): vscode.ThemeIcon {
    if (t.status === 'done')      return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
    if (t.status === 'cancelled') return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('descriptionForeground'));
    /* Open task — visual urgency derived from due. Codicon 'sync~spin' is
       VS Code's native spinner — used for in_progress to show "AI is on it". */
    if (t.dueAt) {
        const dt = new Date(t.dueAt).getTime();
        const ms = dt - Date.now();
        if (ms < 0)             return new vscode.ThemeIcon('flame', new vscode.ThemeColor('errorForeground')); // overdue
        if (ms < 60 * 60_000)   return new vscode.ThemeIcon('clock', new vscode.ThemeColor('errorForeground')); // <1h
        if (ms < 24 * 3600_000) return new vscode.ThemeIcon('clock', new vscode.ThemeColor('list.warningForeground')); // <1d
    }
    if (t.status === 'in_progress') return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.green'));
    return new vscode.ThemeIcon('circle-outline');
}

/* Friendly relative-time formatter — "지금부터 3시간", "내일 09:00", "3일 지남". */
export function _formatDueLabel(iso: string): string {
    try {
        const dt = new Date(iso);
        const ms = dt.getTime() - Date.now();
        const abs = Math.abs(ms);
        const m = Math.floor(abs / 60_000);
        const h = Math.floor(abs / 3600_000);
        const d = Math.floor(abs / 86_400_000);
        if (ms < 0) {
            if (d >= 1) return `🔴 ${d}일 지남`;
            if (h >= 1) return `🔴 ${h}시간 지남`;
            return `🔴 ${m}분 지남`;
        }
        if (d >= 7)  return `📅 ${dt.toISOString().slice(5, 10)}`;
        if (d >= 1)  return `📅 ${d}일 후`;
        if (h >= 1)  return `⏰ ${h}시간 후`;
        return `⚡ ${Math.max(1, m)}분 후`;
    } catch { return iso.slice(0, 16); }
}

let _taskTreeProvider: TaskTreeProvider | null = null;

/* Heuristic: from a finished CEO dispatch (plan + outputs), find
   matching open tracker tasks (created within last 5 min by Secretary
   for THIS user request) and mark them done. Avoids LLM round-trip. */
export function autoMarkTrackerFromDispatch(plan: { brief?: string; tasks?: { agent: string; task: string }[] } | null, sessionDir: string, ceoSynthesis: string) {
  try {
    if (!plan || !Array.isArray(plan.tasks)) return;
    const tracker = readTracker();
    const now = Date.now();
    /* 24h window — covers overnight/multi-step tasks. Original 10-min was
       too narrow: if user issued "이거 해" yesterday and CEO finishes today,
       the task would stay pending forever. */
    const fresh = tracker.tasks.filter(t =>
      t.status !== 'done' && t.status !== 'cancelled' &&
      (now - new Date(t.createdAt).getTime()) < 24 * 60 * 60_000
    );
    if (fresh.length === 0) return;
    /* For each fresh agent-owned task, mark first overlap done. */
    for (const ft of fresh) {
      if (ft.owner !== 'agent' && ft.owner !== 'mixed') continue;
      const evidence = `완료: sessions/${path.basename(sessionDir)}/_report.md\n` +
        plan.tasks.slice(0, 3).map(t => `- ${AGENTS[t.agent]?.name || t.agent}: ${t.task.slice(0, 80)}`).join('\n') +
        (ceoSynthesis ? `\n\nCEO 종합 요점: ${ceoSynthesis.slice(0, 200)}` : '');
      updateTrackerTask(ft.id, {
        status: 'done',
        sessionDir: path.basename(sessionDir),
        evidence,
      });
    }
  } catch { /* ignore */ }
}

/* ── Unified schedule.md ─────────────────────────────────────────────────
   Secretary's job is to give one consolidated view of "today/this week" —
   user's calendar events + each agent's recent activity + pending TODOs.
   Other agents read this via readAgentSharedContext so they can plan
   around the user's life and each other's work.

   Sources:
     - _shared/calendar_cache.md  (Google Calendar via iCal tool)
     - _agents/{id}/memory.md     (last 5 lines per agent — recent task log)
     - _shared/todos.md           (user-maintained — optional) */
export function rebuildUnifiedSchedule() {
  try {
    const dir = getCompanyDir();
    if (!fs.existsSync(dir)) return;
    fs.mkdirSync(path.join(dir, '_shared'), { recursive: true });
    const now = new Date();
    const lines: string[] = [];
    lines.push(`# 📋 통합 스케줄`);
    lines.push(`_업데이트: ${now.toLocaleString('ko-KR')}_`);
    lines.push('');

    /* 1. Calendar */
    const cal = _safeReadText(path.join(dir, '_shared', 'calendar_cache.md')).trim();
    if (cal) {
      lines.push('## 📅 사람 일정 (Google Calendar)');
      const calLines = cal.split('\n')
        .filter(l => l.trim().startsWith('-'))
        .slice(0, 12);
      lines.push(...calLines);
      lines.push('');
    }

    /* 2. Recent agent activity */
    const agentBlocks: string[] = [];
    for (const id of AGENT_ORDER) {
      if (id === 'ceo') continue;
      const memPath = path.join(dir, '_agents', id, 'memory.md');
      const mem = _safeReadText(memPath).trim();
      if (!mem) continue;
      const recent = mem.split('\n')
        .filter(l => /^\s*-\s*\[\d{4}-\d{2}-\d{2}\]/.test(l))
        .slice(-3);
      if (recent.length === 0) continue;
      const a = AGENTS[id];
      agentBlocks.push(`### ${a.emoji} ${a.name}\n${recent.join('\n')}`);
    }
    if (agentBlocks.length > 0) {
      lines.push('## 🤖 에이전트 최근 활동');
      lines.push(...agentBlocks);
      lines.push('');
    }

    /* 3. User TODOs */
    const todos = _safeReadText(path.join(dir, '_shared', 'todos.md')).trim();
    if (todos) {
      lines.push('## ✅ 사용자 할 일');
      lines.push(todos.slice(0, 1500));
      lines.push('');
    }

    fs.writeFileSync(path.join(dir, '_shared', 'schedule.md'), lines.join('\n') + '\n');
  } catch { /* never let schedule errors break the dispatch */ }
}

function readAgentCustomPrompt(agentId: string): string {
  const dir = getCompanyDir();
  const promptPath = path.join(dir, '_agents', agentId, 'prompt.md');
  const configPath = path.join(dir, '_agents', agentId, 'config.md');
  const customPrompt = _safeReadText(promptPath).trim();
  const config = _safeReadText(configPath).trim();
  let extra = '';
  if (customPrompt && !customPrompt.startsWith('# ')) {
    extra += `\n\n[사용자가 추가한 페르소나 디테일]\n${customPrompt.slice(0, 2000)}`;
  } else if (customPrompt) {
    // 헤더 시작이면 그대로 — placeholder 인지 검사
    const stripped = customPrompt.replace(/^#.*$/gm, '').replace(/_여기에.*?_/gs, '').trim();
    if (stripped.length > 30) {
      extra += `\n\n[사용자가 추가한 페르소나 디테일]\n${customPrompt.slice(0, 2000)}`;
    }
  }
  if (config) {
    // config.md에서 비밀 토큰은 마스킹 후 컨텍스트로 주입 (에이전트는 자기 어떤 도구 쓸 수 있는지 알아야 함)
    const masked = config.replace(/(TOKEN|API_KEY|SECRET)([:：=])\s*\S+/gi, '$1$2 ***SET***');
    if (masked.replace(/^#.*$/gm, '').trim().length > 30) {
      extra += `\n\n[당신의 도구·설정 (시크릿 마스킹됨)]\n${masked.slice(0, 1500)}`;
    }
  }
  return extra;
}

export function _safeReadText(p: string): string {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; }
}

export function ensureCompanyStructure(): string {
  const dir = getCompanyDir();
  fs.mkdirSync(path.join(dir, '_shared'), { recursive: true });
  fs.mkdirSync(path.join(dir, '_agents'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'approvals', 'pending'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'approvals', 'history'), { recursive: true });
  AGENT_ORDER.forEach(id => {
    fs.mkdirSync(path.join(dir, '_agents', id), { recursive: true });
    _seedAgentGoalIfMissing(id);
    _seedAgentToolsIfMissing(id);
    _seedAgentToolsManifestIfMissing(id);
  });

  const goalsPath = path.join(dir, '_shared', 'goals.md');
  if (!fs.existsSync(goalsPath)) {
    fs.writeFileSync(goalsPath,
`# 🎯 공동 목표 (Company Goals)

_이 파일은 **모든 에이전트가 매번 읽는** 회사의 북극성입니다. 자유롭게 편집하세요._

## 장기 목표 (1년)
- [ ] (예) 유튜브 구독자 10만 달성
- [ ] (예) 인스타그램 팔로워 5만
- [ ] (예) 월 수익 500만원

## 단기 목표 (1개월)
- [ ] (예) 영상 4개 업로드
- [ ] (예) 릴스 12개 게시
`);
  }
  const idPath = path.join(dir, '_shared', 'identity.md');
  if (!fs.existsSync(idPath)) {
    fs.writeFileSync(idPath,
`# 🏢 회사 정체성 / 톤앤매너

_브랜드 보이스, 톤, 절대 금지어 등을 적으세요. 모든 에이전트가 매번 참조합니다._

- **회사 이름:**
- **대표자:**
- **타깃 청중:**
- **핵심 가치:**
- **브랜드 톤:**
- **금기 (절대 하지 말 것):**
`);
  }
  AGENT_ORDER.forEach(id => {
    const memPath = path.join(dir, '_agents', id, 'memory.md');
    if (!fs.existsSync(memPath)) {
      fs.writeFileSync(memPath,
`# ${AGENTS[id].emoji} ${AGENTS[id].name} (${AGENTS[id].role}) 개인 메모리

_${AGENTS[id].name} 에이전트만 읽고 쓰는 개인 노트. 학습·교훈·자주 쓰는 패턴이 누적됩니다._

## 학습 기록
`);
    }
    /* v2.89.115 — skills/ 디렉토리. memory.md(append-only firehose)와
       구분되는 "큐레이션된 재사용 패턴". 사용자가 텔레그램 `/skill` 또는
       명령 팔레트로 직전 산출물을 승격시킬 때 여기 저장됨. 매 호출 시
       readAgentSharedContext가 system prompt 위쪽에 주입. */
    const skillsDir = path.join(dir, '_agents', id, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    const skillReadme = path.join(skillsDir, 'README.md');
    if (!fs.existsSync(skillReadme)) {
      fs.writeFileSync(skillReadme,
`# ${AGENTS[id].emoji} ${AGENTS[id].name} 스킬

_재사용 가능한 패턴 모음. memory.md는 모든 활동의 로그(append-only firehose),
이 폴더는 **검증된 패턴만 골라낸 것**입니다. 각 \`*.md\` 파일은 다음 호출 시
${AGENTS[id].name}의 system prompt에 자동 주입됩니다._

## 어떻게 채우나요?
- 텔레그램에서 \`/skill\` (직전 산출물 자동 승격)
- VS Code 명령 팔레트: \`Agent OS: 방금 산출물 → 스킬로 저장\`
- 직접 이 폴더에 \`<주제>.md\` 파일을 만들어도 됩니다 (\`# 제목\` + 본문)

\`README.md\` 자체는 system prompt에 주입되지 않습니다.
`);
    }
    const promptPath = path.join(dir, '_agents', id, 'prompt.md');
    if (!fs.existsSync(promptPath)) {
      fs.writeFileSync(promptPath,
`# ${AGENTS[id].emoji} ${AGENTS[id].name} 페르소나 디테일

_여기에 ${AGENTS[id].name} 에이전트에게 주고 싶은 추가 지시·말투·취향·예시 등을 자유롭게 적으세요._
_매 호출 시 시스템 프롬프트에 자동 주입됩니다. (git에 동기화됨)_

`);
    }
    const configPath = path.join(dir, '_agents', id, 'config.md');
    if (!fs.existsSync(configPath)) {
      let presets = '';
      if (id === 'secretary') {
        presets = `\n## 텔레그램 봇\n_BotFather에서 봇을 만들고 토큰을 받으세요. https://t.me/BotFather_\n_그리고 본인 채팅 ID를 알아내려면 https://t.me/userinfobot 에 메시지를 보내세요._\n\n- TELEGRAM_BOT_TOKEN: \n- TELEGRAM_CHAT_ID: \n`;
      } else if (id === 'youtube') {
        presets = `\n## YouTube Data API\n- YOUTUBE_API_KEY: \n- YOUTUBE_CHANNEL_ID: \n`;
      } else if (id === 'instagram') {
        presets = `\n## Meta Graph API\n- META_ACCESS_TOKEN: \n- INSTAGRAM_BUSINESS_ID: \n`;
      } else if (id === 'designer') {
        presets = `\n## 디자인 도구\n- FIGMA_TOKEN: \n- STITCH_API_KEY: \n`;
      }
      fs.writeFileSync(configPath,
`# ${AGENTS[id].emoji} ${AGENTS[id].name} 설정 (시크릿)

_이 파일은 \`.gitignore\`에 의해 깃 동기화에서 제외됩니다. API 키·토큰을 자유롭게 적으세요._
${presets}
`);
    }
  });

  // .gitignore — 시크릿과 캐시 보호
  const giPath = path.join(dir, '.gitignore');
  const desiredGi =
`# 자동 생성 — Agent OS 1인 기업 모드
# 시크릿·API 키 보호
_agents/*/config.md
# 도구 설정 JSON 안에 API 키·텔레그램 봇 토큰이 들어갈 수 있어 git에서 제외
_agents/*/tools/*.json
_agents/*/tools/youtube_account.json

# 외부 API 응답 캐시 (재현 가능)
_cache/

# 대용량 임시 산출물
_tmp/
*.log
`;
  if (!fs.existsSync(giPath)) {
    fs.writeFileSync(giPath, desiredGi);
  } else {
    /* Migrate old gitignore that didn't list tool JSONs — append the
       missing rules so existing users get token protection without us
       clobbering anything they manually added. */
    let cur = '';
    try { cur = fs.readFileSync(giPath, 'utf-8'); } catch { /* ignore */ }
    const additions: string[] = [];
    if (!cur.includes('_agents/*/tools/*.json')) {
      additions.push('# 도구 설정 JSON 안에 API 키·텔레그램 봇 토큰이 들어갈 수 있어 git에서 제외');
      additions.push('_agents/*/tools/*.json');
    }
    if (!cur.includes('youtube_account.json')) {
      additions.push('_agents/*/tools/youtube_account.json');
    }
    if (additions.length > 0) {
      try { fs.appendFileSync(giPath, '\n' + additions.join('\n') + '\n'); } catch { /* ignore */ }
    }
  }

  // _system.md — 시스템 자가 매뉴얼 (사람도 읽고 LLM도 컨텍스트로)
  const sysPath = path.join(dir, '_shared', '_system.md');
  if (!fs.existsSync(sysPath)) {
    fs.writeFileSync(sysPath,
`# 🧬 1인 기업 OS — 자가 매뉴얼

## 이 폴더는 무엇인가요?
당신의 1인 기업의 두뇌입니다. 7명의 AI 에이전트가 여기서 일합니다.

## 폴더 구조
- \`_shared/\` — 모든 에이전트가 매번 읽는 공동 메모리
  - \`identity.md\` — 회사 정체성 (이름, 톤, 가치)
  - \`goals.md\` — 목표
  - \`decisions.md\` — 의사결정 로그 (자가학습이 자동 누적)
  - \`_system.md\` — 이 파일
- \`_agents/<id>/\` — 각 에이전트 개인 공간
  - \`memory.md\` — 자가학습 (자동, append-only)
  - \`prompt.md\` — 페르소나 디테일 (사용자가 편집)
  - \`config.md\` — API 키·시크릿 (\`.gitignore\`로 보호)
- \`sessions/<ts>/\` — 세션별 산출물 (자동)
- \`_cache/\` — API 응답 캐시 (sync 제외)

## 메모리 위계 (충돌 시 우선순위)
1. \`decisions.md\` — 가장 강한 신뢰
2. \`identity.md\`
3. \`goals.md\`
4. 개인 메모리
5. 지식 베이스 (\`10_Wiki/\`)

## 다른 PC로 옮길 때
1. 새 PC에 Agent OS 설치
2. 👔 모드 ON → "📥 다른 PC에서 가져오기" 선택
3. GitHub URL 입력 → 자동 clone
4. 끝.

## 동기화 정책
- \`_shared/\`, \`_agents/*/memory.md\`, \`_agents/*/prompt.md\`, \`sessions/\` → git sync ✅
- \`_agents/*/config.md\`, \`_cache/\` → git sync ❌ (시크릿·캐시)

## 7명의 에이전트
${AGENT_ORDER.map(id => `- ${AGENTS[id].emoji} **${AGENTS[id].name}** (${AGENTS[id].role}): ${AGENTS[id].specialty}`).join('\n')}
`);
  }

  return dir;
}

/* ── Brain knowledge → agent context bridge ────────────────────────────
   Every agent cycle we surface the user's broader knowledge (10_Wiki, recent
   00_Raw) into that agent's prompt. Filtered by the agent's specialty
   keywords so YouTube doesn't drown in design notes and vice versa. Tight
   budget keeps the prompt small. */

function _agentKeywords(agentId: string): string[] {
  const a = AGENTS[agentId];
  if (!a) return [];
  /* Pull tokens from name, role, specialty. Strip punctuation, lowercase,
     drop tiny tokens. Korean is tricky — we keep ≥2-char chunks. */
  const text = `${a.name} ${a.role} ${a.specialty}`;
  const tokens = text
    .replace(/[()·,/·\-·]+/g, ' ')
    .split(/\s+/)
    .map(t => t.trim().toLowerCase())
    .filter(t => t.length >= 2 && !/^(and|the|of|for|to|in)$/i.test(t));
  /* Dedupe while preserving order */
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) { if (!seen.has(t)) { seen.add(t); out.push(t); } }
  return out;
}

function _scoreRelevance(text: string, keywords: string[]): number {
  if (!text || keywords.length === 0) return 0;
  const lc = text.toLowerCase();
  let score = 0;
  for (const k of keywords) {
    /* count occurrences (cap at 5 per keyword to avoid one giant doc winning) */
    let i = 0, hits = 0;
    while ((i = lc.indexOf(k, i)) !== -1 && hits < 5) { hits++; i += k.length; }
    score += hits;
  }
  return score;
}

/* Recursively list .md files under a root, capped depth + count for safety.
   Skips company-internal folders + .git so we don't pull in identity.md /
   memory.md (those are added separately). */
function _walkBrainMd(root: string, opts: { maxDepth: number; maxFiles: number; skipDirs: Set<string> }): string[] {
  const out: string[] = [];
  if (!fs.existsSync(root)) return out;
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (stack.length && out.length < opts.maxFiles) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(cur.dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (out.length >= opts.maxFiles) break;
      const full = path.join(cur.dir, e.name);
      if (e.isDirectory()) {
        if (opts.skipDirs.has(e.name)) continue;
        if (e.name.startsWith('.')) continue; /* skip dotfiles like .git */
        if (cur.depth + 1 <= opts.maxDepth) stack.push({ dir: full, depth: cur.depth + 1 });
      } else if (e.isFile() && (e.name.toLowerCase().endsWith('.md') || e.name.toLowerCase().endsWith('.txt'))) {
        out.push(full);
      }
    }
  }
  return out;
}

interface BrainSnippet { path: string; rel: string; title: string; insight: string; score: number; mtime: number; }

function _extractWikiSnippet(filePath: string, brainRoot: string, keywords: string[]): BrainSnippet | null {
  let raw = '';
  try {
    const st = fs.statSync(filePath);
    if (st.size > 80_000) return null; /* skip giant files */
    raw = fs.readFileSync(filePath, 'utf-8').slice(0, 12_000);
  } catch { return null; }
  if (!raw.trim()) return null;
  /* Title: first H1, else filename */
  const h1 = raw.match(/^#\s+(.+?)\s*$/m);
  const title = h1 ? h1[1].trim().replace(/\[\[|\]\]/g, '') : path.basename(filePath, path.extname(filePath));
  /* Insight: prefer the "📌 한 줄 통찰" line (P-Reinforce convention).
     Fallback: first non-heading paragraph. */
  let insight = '';
  const insightM = raw.match(/##[^\n]*한 줄 통찰[^\n]*\n>?\s*([^\n]+)/);
  if (insightM && insightM[1]) {
    insight = insightM[1].trim().replace(/^>+\s*/, '');
  } else {
    /* Strip frontmatter, find first non-heading non-empty line */
    const body = raw.replace(/^---[\s\S]*?---\n/, '');
    const lines = body.split('\n');
    for (const ln of lines) {
      const t = ln.trim();
      if (!t) continue;
      if (t.startsWith('#')) continue;
      if (t.startsWith('---')) continue;
      insight = t.slice(0, 220);
      break;
    }
  }
  if (!insight) insight = raw.replace(/\s+/g, ' ').slice(0, 180);
  insight = insight.slice(0, 220);
  let st: fs.Stats | null = null;
  try { st = fs.statSync(filePath); } catch {}
  /* Recency boost: docs modified in last 14 days get +5 to score */
  const ageDays = st ? (Date.now() - st.mtimeMs) / 86_400_000 : 999;
  const recencyBonus = ageDays <= 14 ? 5 : (ageDays <= 60 ? 2 : 0);
  const scoreText = title + '\n' + insight + '\n' + raw.slice(0, 2000);
  const score = _scoreRelevance(scoreText, keywords) + recencyBonus;
  return {
    path: filePath,
    rel: path.relative(brainRoot, filePath),
    title,
    insight,
    score,
    mtime: st ? st.mtimeMs : 0,
  };
}

/* Returns a context block to append to the agent's prompt, or '' if no
   relevant brain content. Budget caps total chars so we don't blow up the
   context window. */
function readRelevantBrainContext(agentId: string, budgetChars: number = 2400): string {
  /* Walk the BRAIN root (where 00_Raw/, 10_Wiki/, user notes live) — NOT
     the company subdir. Skip _company/ entirely so agent self-output never
     gets re-fed as "knowledge". */
  const brain = _getBrainDir();
  const keywords = _agentKeywords(agentId);
  if (keywords.length === 0) return '';

  const skipDirs = new Set([
    '_company', '_shared', '_agents', 'sessions', 'approvals',
    'node_modules', '.git', '.cache', '_cache', 'out', 'dist', '__pycache__',
  ]);

  /* 10_Wiki and other top-level knowledge folders — main scan target. */
  const wikiFiles = _walkBrainMd(brain, { maxDepth: 4, maxFiles: 200, skipDirs });

  /* Recent 00_Raw within last 14 days — these are freshly injected and
     might not be wiki-organized yet. Score on filename + first chunk. */
  const rawDir = path.join(brain, '00_Raw');
  let rawFiles: string[] = [];
  if (fs.existsSync(rawDir)) {
    rawFiles = _walkBrainMd(rawDir, { maxDepth: 2, maxFiles: 50, skipDirs: new Set() });
    /* keep only ≤14 days old */
    const cutoff = Date.now() - 14 * 86_400_000;
    rawFiles = rawFiles.filter(f => {
      try { return fs.statSync(f).mtimeMs >= cutoff; } catch { return false; }
    });
  }

  const all = [...wikiFiles, ...rawFiles];
  if (all.length === 0) return '';

  const snippets: BrainSnippet[] = [];
  for (const f of all) {
    const s = _extractWikiSnippet(f, brain, keywords);
    if (s && s.score > 0) snippets.push(s);
  }
  if (snippets.length === 0) return '';

  snippets.sort((a, b) => b.score - a.score || b.mtime - a.mtime);

  let block = '\n\n[관련 두뇌 지식 — 최근 또는 당신 분야 관련 자료. 필요하면 인용/활용]\n';
  let used = 0;
  for (const s of snippets) {
    const line = `- 🧠 **${s.title}** (${s.rel})\n  > ${s.insight}\n`;
    if (used + line.length > budgetChars) break;
    block += line;
    used += line.length;
  }
  return used > 0 ? block : '';
}

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
function readGraphRagBrainContext(agentId: string, budgetChars: number = 2400): string {
  /* Walk BRAIN root — same rationale as readRelevantBrainContext. The graph
     edges (wikilinks) live in user notes under 00_Raw/, 10_Wiki/, etc.,
     never inside _company/ (that's agent output, not knowledge). */
  const brain = _getBrainDir();
  const keywords = _agentKeywords(agentId);
  if (keywords.length === 0) return '';

  const skipDirs = new Set([
    '_company', '_shared', '_agents', 'sessions', 'approvals',
    'node_modules', '.git', '.cache', '_cache', 'out', 'dist', '__pycache__',
  ]);
  const wikiFiles = _walkBrainMd(brain, { maxDepth: 4, maxFiles: 200, skipDirs });
  const rawDir = path.join(brain, '00_Raw');
  let rawFiles: string[] = [];
  if (fs.existsSync(rawDir)) {
    rawFiles = _walkBrainMd(rawDir, { maxDepth: 2, maxFiles: 50, skipDirs: new Set() });
    const cutoff = Date.now() - 14 * 86_400_000;
    rawFiles = rawFiles.filter(f => {
      try { return fs.statSync(f).mtimeMs >= cutoff; } catch { return false; }
    });
  }
  const all = Array.from(new Set([...wikiFiles, ...rawFiles]));
  if (all.length === 0) return '';

  /* Pass 1: load each file once (cap size), compute snippet + extract its
     wikilinks and a small set of anchor terms (H1 title + first 5 quoted
     phrases). Title→file index lets us resolve `[[Foo]]` to a real node. */
  type Node = { snippet: BrainSnippet; titleKey: string; links: string[]; anchors: string[]; raw: string };
  const nodes: Node[] = [];
  const titleToIdx = new Map<string, number>();
  for (const f of all) {
    let raw = '';
    try {
      const st = fs.statSync(f);
      if (st.size > 80_000) continue;
      raw = fs.readFileSync(f, 'utf-8').slice(0, 12_000);
    } catch { continue; }
    if (!raw.trim()) continue;
    const snippet = _extractWikiSnippet(f, brain, keywords);
    if (!snippet) continue;
    const titleKey = snippet.title.trim().toLowerCase();
    /* Wikilinks — strip optional `|alias` */
    const links: string[] = [];
    const linkRe = /\[\[([^\]\|\n]+?)(?:\|[^\]]*)?\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(raw)) && links.length < 30) {
      links.push(m[1].trim().toLowerCase());
    }
    /* Anchor terms — H1 + up to 5 backtick/quoted phrases (cheap proxy for
       "important named entities" without an LLM extraction pass). */
    const anchors: string[] = [snippet.title.trim()];
    const phraseRe = /[`"]([^`"\n]{3,40})[`"]/g;
    let pm: RegExpExecArray | null;
    while ((pm = phraseRe.exec(raw)) && anchors.length < 6) {
      anchors.push(pm[1].trim());
    }
    nodes.push({ snippet, titleKey, links, anchors: anchors.map(a => a.toLowerCase()), raw });
    if (!titleToIdx.has(titleKey)) titleToIdx.set(titleKey, nodes.length - 1);
  }
  if (nodes.length === 0) return '';

  /* Pass 2: build adjacency. Wikilink edge if target title resolves; anchor
     edge if two notes share an anchor term (excluding empty/very short). */
  const adj: Set<number>[] = nodes.map(() => new Set<number>());
  /* Wikilink edges */
  for (let i = 0; i < nodes.length; i++) {
    for (const link of nodes[i].links) {
      const j = titleToIdx.get(link);
      if (j !== undefined && j !== i) {
        adj[i].add(j);
        adj[j].add(i);
      }
    }
  }
  /* Anchor co-occurrence — anchor → list of node indices */
  const anchorIdx = new Map<string, number[]>();
  for (let i = 0; i < nodes.length; i++) {
    for (const a of nodes[i].anchors) {
      if (a.length < 3) continue;
      const arr = anchorIdx.get(a) || [];
      arr.push(i);
      anchorIdx.set(a, arr);
    }
  }
  for (const [, idxs] of anchorIdx) {
    if (idxs.length < 2 || idxs.length > 8) continue; /* skip noise */
    for (let i = 0; i < idxs.length; i++) {
      for (let j = i + 1; j < idxs.length; j++) {
        adj[idxs[i]].add(idxs[j]);
        adj[idxs[j]].add(idxs[i]);
      }
    }
  }

  /* Pass 3: pick top SEEDS by keyword score. BFS 1-hop to expand. Re-rank
     expanded set: seeds keep full score; neighbors get neighbor_factor *
     best_seed_score so they ride into the context window even with zero
     direct keyword match — that is the Graph RAG payoff. */
  const seedCount = 3;
  const ranked = nodes
    .map((n, i) => ({ i, score: n.snippet.score }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (ranked.length === 0) return '';
  const seeds = ranked.slice(0, seedCount).map(x => x.i);
  const seedSet = new Set(seeds);
  const finalScore = new Map<number, number>();
  const reachedVia = new Map<number, number>(); /* neighbor → seed idx */
  for (const s of seeds) {
    finalScore.set(s, nodes[s].snippet.score);
    for (const nb of adj[s]) {
      if (seedSet.has(nb)) continue;
      const boost = nodes[s].snippet.score * 0.5;
      const cur = finalScore.get(nb) || 0;
      if (boost > cur) {
        finalScore.set(nb, boost);
        reachedVia.set(nb, s);
      }
    }
  }
  const ordered = Array.from(finalScore.entries())
    .sort((a, b) => b[1] - a[1] || nodes[b[0]].snippet.mtime - nodes[a[0]].snippet.mtime);

  /* Emit. Mark each line with whether it was a direct match (🎯) or a
     graph-connected neighbor (🔗) so the agent — and the curious user
     reading the prompt — can see the graph at work. */
  let block = '\n\n[관련 두뇌 지식 — Graph RAG: 직접 매칭(🎯) + 1-hop 연결(🔗)]\n';
  let used = 0;
  for (const [idx] of ordered) {
    const n = nodes[idx];
    const tag = seedSet.has(idx) ? '🎯' : '🔗';
    let line = `- ${tag} **${n.snippet.title}** (${n.snippet.rel})\n  > ${n.snippet.insight}\n`;
    if (tag === '🔗') {
      const via = reachedVia.get(idx);
      if (via !== undefined) {
        line = `- ${tag} **${n.snippet.title}** (${n.snippet.rel}) — \`${nodes[via].snippet.title}\`와 연결\n  > ${n.snippet.insight}\n`;
      }
    }
    if (used + line.length > budgetChars) break;
    block += line;
    used += line.length;
  }
  return used > 0 ? block : '';
}

export function readAgentSharedContext(agentId: string, opts?: { lean?: boolean }): string {
  /* v2.89.42 — lean 모드 = 두뇌 "삭제"가 아니라 "축소". 실데이터 prefetch가 성공해서
     큰 컨텍스트가 들어왔을 때 두뇌 콘텐츠 자르기보다 줄이는 쪽으로 결정.
     사용자가 쌓아둔 결정·메모리·brain 노트는 분석에 쓸 수 있어야 함 (제2의 두뇌 컨셉의
     핵심). 단 너무 길면 추론 느려지고 환각 위험 — 그래서 적정 크기로 축소.
       normal: decisions 3000자 / memory 4000자 / brain RAG 2400자 (총 ~9400자)
       lean:   decisions 1200자 / memory 1500자 / brain RAG  900자 (총 ~3600자)
     → 약 60% 감소. 두뇌는 살아있되 부담 줄임. */
  const lean = opts?.lean === true;
  const dir = getCompanyDir();
  const identity = _safeReadText(path.join(dir, '_shared', 'identity.md'));
  const companyGoals = _safeReadText(path.join(dir, '_shared', 'goals.md'));
  const decisions = _safeReadText(path.join(dir, '_shared', 'decisions.md'));
  const memory = _safeReadText(path.join(dir, '_agents', agentId, 'memory.md'));
  const personalGoal = readAgentGoal(agentId);
  const ragMode = readAgentRagMode(agentId);
  let ctx = '';
  // Priority order (most-trusted first):
  //   agent goal > company goals > company identity > decisions > memory > brain knowledge > tools
  if (personalGoal.trim()) ctx += `\n\n[당신의 개인 목표 (최우선 — 매 사이클 이 방향으로 한 스텝 진행)]\n${personalGoal.slice(0, 4000)}`;
  if (companyGoals.trim()) ctx += `\n\n[회사 공동 목표]\n${companyGoals.slice(0, 4000)}`;
  if (identity.trim()) ctx += `\n\n[회사 정체성]\n${identity.slice(0, 2000)}`;
  if (decisions.trim()) ctx += `\n\n[지난 의사결정 로그]\n${decisions.slice(lean ? -1200 : -3000)}`;
  /* Calendar — secretary's google_calendar tool writes upcoming events here.
     Surfaced to every agent so scheduling and time-aware planning work without
     each agent having to call the tool itself. */
  try {
    const cal = _safeReadText(path.join(dir, '_shared', 'calendar_cache.md'));
    if (cal.trim()) ctx += `\n\n[다가오는 일정 (Google Calendar)]\n${cal.slice(0, 2000)}`;
  } catch { /* ignore */ }
  /* Unified schedule — Secretary maintains this combining calendar + each
     agent's recent activity + user TODOs. Lets every agent plan around the
     user's life and their teammates' workload. */
  try {
    const sch = _safeReadText(path.join(dir, '_shared', 'schedule.md'));
    if (sch.trim()) ctx += `\n\n[통합 스케줄 (비서 관리)]\n${sch.slice(0, 2200)}`;
  } catch { /* ignore */ }
  /* Open tracker tasks — agents see what's still pending so they don't
     duplicate work and can pick up overlapping items. Also lets them know
     what user is on the hook for, so they avoid blocking on the user. */
  try {
    const trackerMd = trackerToMarkdown({ onlyOpen: true, max: 12 });
    if (trackerMd) ctx += `\n\n[추적 중인 작업 (열린 것만)]\n${trackerMd}`;
  } catch { /* ignore */ }
  /* Self-RAG mode: surface verified.md FIRST as primary memory so previously
     self-grounded claims dominate the context. memory.md still gets included
     below as the firehose, but the agent has already been told to trust
     verified entries above [추측] entries. */
  if (ragMode === 'self-rag') {
    const verified = readAgentVerifiedKnowledge(agentId);
    if (verified.trim()) {
      ctx += `\n\n[${AGENTS[agentId]?.name} 검증된 지식 (Self-RAG가 자가검증한 항목들 — 최우선 신뢰)]\n${verified.slice(0, 4000)}`;
    }
  }
  /* v2.89.115 — Curated skills (검증된 재사용 패턴). memory.md는 firehose,
     skills/는 사용자가 명시적으로 승격한 것만. 신뢰도가 더 높으므로 memory
     위에 배치하고 별도 라벨로 표시. */
  try {
    const skillsBlock = readAgentSkills(agentId, lean ? 1500 : 4000);
    if (skillsBlock) ctx += skillsBlock;
  } catch { /* never break the prompt */ }
  /* v2.89.115 — 템플릿 (재사용 빌딩블록). 두뇌의 40_템플릿/<id>/ 폴더.
     스킬보다 더 무거운 자료(코드·파일·문서) — 매니페스트만 inject, 실제 파일은
     LLM이 필요시 read_file 로 읽기. */
  try {
    const templatesBlock = readAgentTemplates(agentId, lean ? 1000 : 2000);
    if (templatesBlock) ctx += templatesBlock;
  } catch { /* never break the prompt */ }
  if (memory.trim()) ctx += `\n\n[${AGENTS[agentId]?.name} 개인 메모리 ${ragMode === 'self-rag' ? '— 미검증 포함, 신중히 사용' : ''}]\n${memory.slice(0, lean ? 1500 : 4000)}`;
  /* Bridge to broader brain folder — Graph RAG retrieval is always on
     (the brain network IS the graph; not using it would be wasteful).
     Normal: 2400 chars cap. Lean: 900 chars cap — 두뇌가 살아있되 짐 가벼움. */
  try {
    ctx += readGraphRagBrainContext(agentId, lean ? 900 : 2400);
  } catch { /* never let brain scan break the prompt */ }
  /* Self-RAG instruction block — appended late so it overrides earlier
     conventions. Tells the agent to ground every claim in the context above
     and tag ungrounded claims as [추측]. This is the "self-critique" step
     of Self-RAG, expressed as a strict output protocol. */
  if (ragMode === 'self-rag') {
    ctx += `\n\n[Self-RAG 자가검증 프로토콜 — 반드시 따를 것]\n`
      + `1. 답변 생성 전 위 컨텍스트(개인 목표·회사 목표·메모리·두뇌 지식)에서 근거가 되는 항목을 머릿속으로 골라내세요.\n`
      + `2. 각 사실 주장 옆에 \`[근거: <출처 한 마디>]\` 또는 \`[추측]\` 중 하나를 반드시 표기하세요. 출처가 위 컨텍스트에 없으면 \`[추측]\` 입니다.\n`
      + `3. 답변 마지막 줄에 \`자가검증: 사실 N개 / 추측 M개\` 한 줄을 추가하세요.\n`
      + `4. \`[추측]\`이 \`[근거:]\`보다 많으면 답변하지 말고 \`정보 부족 — 두뇌 폴더에 X 자료 필요\` 라고만 말하세요. 근거 없는 자신감은 회사 의사결정 로그를 오염시킵니다.`;
    /* User-defined extra criteria — appended only if non-empty. Tagged as
       "추가 기준" so the model treats them as authoritative checks on top
       of the standard protocol. */
    const userCriteria = readAgentSelfRagCriteria(agentId).trim();
    if (userCriteria) {
      ctx += `\n\n[Self-RAG 추가 기준 — 사용자 정의 (위 프로토콜 위에 강제 적용)]\n${userCriteria.slice(0, 3500)}\n\n위 사용자 정의 기준 중 하나라도 만족하지 못하면 답변을 보내기 전 수정하세요. 기준 위반은 \`자가검증\` 라인에서 \`기준 위반: …\` 형태로 명시.`;
    }
  }
  // Tool catalog — agent can invoke these via <run_command>. Only ENABLED
  // tools surface here; disabled ones are hidden so the agent never picks
  // them up autonomously. Absolute paths resolve correctly regardless of
  // where the user put their brain folder.
  /* google_calendar_write is a diagnostic-only Python script — the real
     calendar read/write is handled by built-in TypeScript functions
     (refreshCalendarCacheViaOAuth, createCalendarEventForTask). Exclude it
     from the tool catalog so the agent doesn't generate 'cd && python'
     commands for calendar operations. Same for google_calendar (iCal read). */
  const _BUILTIN_TOOLS = new Set(['google_calendar_write', 'google_calendar']);
  const tools = listAgentTools(agentId).filter(t => t.enabled && !_BUILTIN_TOOLS.has(t.name));
  if (tools.length > 0) {
    ctx += `\n\n[사용 가능한 도구 — <run_command>로 직접 실행 가능]\n` + tools.map(t => {
      const cd = `cd "${path.dirname(t.scriptPath)}"`;
      return `- 🛠️ \`${t.name}\` — ${t.description.replace(/\n/g, ' ').slice(0, 140)}\n  실행: <run_command>${cd} && ${_pythonCmd()} ${path.basename(t.scriptPath)}</run_command>\n  설정 파일(API 키 등): ${t.configPath}`;
    }).join('\n');
    /* v2.89.31 — 도구 사용 의무화. 작은 LLM은 도구 카탈로그를 무시하고
       LLM 지식만으로 답변하는 경향이 있어서, 실데이터가 필요한 task일 때
       반드시 도구를 명시적으로 실행 요청하라고 강제. 단 한 응답 안에서
       LLM은 도구 stdout을 못 봄 — system이 LLM 응답 종료 후 실행하고
       결과는 출력 끝에 append되어 다음 에이전트(peerCtx)와 final report에 흘러감. */
    ctx += `\n\n[🛠️ 도구 사용 규칙 — 반드시 따를 것]\n`
      + `- 위 도구 중 task에 필요한 게 있고 [실시간 데이터] 섹션에 해당 데이터가 아직 없으면, **답변 어디든** \`<run_command>\` 블록을 출력하세요. 시스템이 LLM 응답 종료 후 실행하고 결과를 출력 끝에 append합니다 (당신은 이 응답에서 stdout 못 봄 — 다음 에이전트와 final report가 활용).\n`
      + `- 이미 [실시간 데이터] 섹션에 데이터가 자동 주입돼 있으면 그걸 분석에 활용 — 도구 중복 실행 X.\n`
      + `- 데이터 없이 추측·일반론으로 답하는 건 금지. 데이터가 없고 도구도 없으면 솔직히 "데이터 부족으로 분석 보류" + 평가 \`대기\`로.\n`
      + `- 같은 task에 여러 도구가 도움 되면 \`<run_command>\` 블록을 여러 개 출력해도 됩니다 (시스템이 순차 실행).`;
  }
  /* Calendar context — if OAuth is connected, tell the agent it can access
     calendar data through the built-in system (no Python script needed).
     The actual data is already in _shared/calendar_cache.md (injected via
     readAgentSharedContext). */
  if (agentId === 'secretary' && isCalendarWriteConnected()) {
    ctx += `\n\n[📅 Google Calendar — 내장 연결됨]\n캘린더 데이터는 위 [다가오는 일정] 섹션에 자동 로드됩니다. Python 스크립트 실행 불필요 — 일정 조회는 이미 로드된 컨텍스트를 참고하세요. 일정 생성은 추적기에 due를 넣으면 자동으로 생성됩니다.`;
  }
  ctx += readAgentCustomPrompt(agentId);
  return ctx;
}

export function appendAgentMemory(agentId: string, line: string) {
  try {
    const p = path.join(getCompanyDir(), '_agents', agentId, 'memory.md');
    const stamp = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(p, `\n- [${stamp}] ${line.replace(/\n/g, ' ').slice(0, 300)}`);
  } catch { /* ignore */ }
}

/* ── Curated skills (재사용 패턴) ─────────────────────────────────────────
   v2.89.115 — Hermes Agent의 skill 자동승격 패턴을 1인 기업 컨셉에 이식.
   memory.md는 모든 활동을 그대로 누적하는 append-only 로그(firehose)이고,
   skills/는 사용자가 명시적으로 "이거 패턴화"라고 승격시킨 것만. 신뢰도가
   훨씬 높으므로 system prompt에 더 강한 라벨로 주입한다. */
/* v2.89.115 / v2.91.x — `_seedBundledTemplates` 와 `_copyDirRecursive` 는
   `./seeds/common.ts` 로 이동. extension.ts 는 `./seeds` 에서 import 만 함. */

/* v2.89.115 — 템플릿 reader. 두뇌의 `40_템플릿/<agentId>/` 폴더 스캔.
   각 템플릿은 하위 폴더이고 README.md + manifest.json + 코드 파일 가짐.
   AI 컨텍스트엔 매니페스트 요약 + README의 핵심 + 파일 목록만 inject (전체 코드는 X —
   파일 너무 크면 컨텍스트 폭주). LLM이 "이 템플릿 쓰겠다" 결정하면 read_file로 실제
   파일 읽으면 됨. */
function readAgentTemplates(agentId: string, maxChars = 2000): string {
  const brainDir = _getBrainDir();
  /* 새 표준 위치: 두뇌 안의 40_템플릿/<agentId>/ */
  const standardDir = path.join(brainDir, '40_템플릿', agentId);
  const englishDir = path.join(brainDir, '40_Templates', agentId);
  let templatesDir = '';
  if (fs.existsSync(standardDir)) templatesDir = standardDir;
  else if (fs.existsSync(englishDir)) templatesDir = englishDir;
  else {
    /* 첫 사용 — 번들 템플릿이 있으면 두뇌에 시드 */
    _seedBundledTemplates(agentId, standardDir);
    if (fs.existsSync(standardDir)) templatesDir = standardDir;
  }
  if (!templatesDir) return '';
  let folders: string[] = [];
  try {
    folders = fs.readdirSync(templatesDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
      .map(e => e.name);
  } catch { return ''; }
  if (folders.length === 0) return '';
  /* v2.89.125 — 스케일링: 매니페스트 풀 inject 대신 압축 형식 (이름 + 한 줄).
     실제 manifest+README는 pack_apply 가 필요 시 디스크에서 직접 읽음. 컨텍스트 절약.
     500자 이내 (10~20개 키트도 안전). */
  const MAX_KITS_LISTED = 20;
  const briefs: { name: string; title: string; desc: string; keywords: string[]; files: number }[] = [];
  for (const name of folders.slice(0, MAX_KITS_LISTED)) {
    const tplDir = path.join(templatesDir, name);
    let manifest: any = null;
    try {
      const mp = path.join(tplDir, 'manifest.json');
      if (fs.existsSync(mp)) manifest = JSON.parse(fs.readFileSync(mp, 'utf-8') || '{}');
    } catch { /* malformed */ }
    let fileCount = 0;
    try {
      const filesDir = path.join(tplDir, 'files');
      if (fs.existsSync(filesDir)) fileCount = fs.readdirSync(filesDir).length;
    } catch { /* ignore */ }
    briefs.push({
      name,
      title: manifest?.name || name,
      desc: (manifest?.description || '').slice(0, 90),
      keywords: (manifest?.keywords || []).slice(0, 5),
      files: fileCount,
    });
  }
  if (briefs.length === 0) return '';
  /* 압축 한 줄 포맷: `- name (📄 N파일): 설명 [키워드, ...]` */
  const lines = briefs.map(b =>
    `- \`${b.name}\` (📄 ${b.files}): ${b.desc}${b.keywords.length ? ` _[${b.keywords.join(', ')}]_` : ''}`
  );
  const overflow = folders.length > MAX_KITS_LISTED ? `\n_(총 ${folders.length}개 중 상위 ${MAX_KITS_LISTED}개. 나머지는 \`pack_apply\` 자동 매칭 사용)_` : '';
  /* lean 모드: 키워드 생략 — 더 짧게 */
  if (maxChars <= 1200) {
    const tightLines = briefs.map(b => `- \`${b.name}\`: ${b.desc.slice(0, 60)}`);
    return `\n\n[${AGENTS[agentId]?.name || agentId} 키트 ${folders.length}개 — \`pack_apply\` USER_INTENT 사용 권장]\n${tightLines.join('\n')}${overflow}\n`;
  }
  return `\n\n[${AGENTS[agentId]?.name || agentId} 키트 (${folders.length}개) — 사용 시 \`pack_apply\` 도구 호출. KIT_NAME 비우고 USER_INTENT 에 사용자 명령 그대로 → 자동 매칭]\n${lines.join('\n')}${overflow}\n`;
}

function readAgentSkills(agentId: string, maxChars = 4000): string {
  const skillsDir = path.join(getCompanyDir(), '_agents', agentId, 'skills');
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(skillsDir).filter(f => f.endsWith('.md') && f.toLowerCase() !== 'readme.md');
  } catch { return ''; }
  if (entries.length === 0) return '';
  /* 최근 수정순으로 정렬 — 새로 만든 스킬이 먼저 보이도록 */
  entries.sort((a, b) => {
    try {
      const ma = fs.statSync(path.join(skillsDir, a)).mtimeMs;
      const mb = fs.statSync(path.join(skillsDir, b)).mtimeMs;
      return mb - ma;
    } catch { return 0; }
  });
  const blocks: string[] = [];
  let used = 0;
  for (const f of entries) {
    if (used >= maxChars) break;
    const body = _safeReadText(path.join(skillsDir, f)).trim();
    if (!body) continue;
    const block = body.slice(0, Math.max(200, maxChars - used));
    blocks.push(block);
    used += block.length;
  }
  if (blocks.length === 0) return '';
  return `\n\n[${AGENTS[agentId]?.name} 검증된 스킬 (사용자가 패턴으로 승격한 항목 — 가능하면 이 패턴을 따르세요)]\n${blocks.join('\n\n---\n\n')}`;
}

/** Find the most recent specialist output in today's conversation log.
 *  Returns the agent id + body so the user can say `/skill` and we know
 *  whose skills/ to save into. Falls back to yesterday if today has none. */
export function _getLastSpecialistOutput(): { agentId: string; agentName: string; body: string } | null {
  try {
    const convDir = getConversationsDir();
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    /* Index agent name → id for reverse lookup. Skip CEO (planner role,
       not a specialist whose patterns we'd reuse). */
    const nameToId = new Map<string, string>();
    for (const id of SPECIALIST_IDS) {
      const a = AGENTS[id];
      if (!a) continue;
      nameToId.set(a.name, id);
    }
    for (const day of [today, yesterday]) {
      const f = path.join(convDir, `${day}.md`);
      if (!fs.existsSync(f)) continue;
      let txt = '';
      try { txt = fs.readFileSync(f, 'utf-8'); } catch { continue; }
      /* Conversation entries are blocks like:
           ## [HH:MM:SS] {emoji} **{speaker}** · _{section}_

           {body}
         Walk from the end backward and grab the most recent one whose
         speaker matches a specialist name. */
      const headerRe = /\n##\s+\[\d{2}:\d{2}:\d{2}\][^\n]*\*\*([^*]+)\*\*[^\n]*\n([\s\S]*?)(?=\n##\s+\[|$)/g;
      const matches: Array<{ name: string; body: string }> = [];
      let m: RegExpExecArray | null;
      while ((m = headerRe.exec(txt)) !== null) {
        matches.push({ name: m[1].trim(), body: m[2].trim() });
      }
      for (let i = matches.length - 1; i >= 0; i--) {
        const id = nameToId.get(matches[i].name);
        if (id && matches[i].body.length >= 80) {
          return { agentId: id, agentName: matches[i].name, body: matches[i].body };
        }
      }
    }
  } catch { /* fall through */ }
  return null;
}

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

const SKILL_DISTILL_PROMPT = _loadPrompt('skill-distill.md');

/** Distill `sourceText` into a reusable skill markdown and save it under
 *  `_agents/{agentId}/skills/<slug>.md`. Returns the saved path or an error.
 *  Uses _quickLLMCall — same lightweight path as Secretary classification. */
export async function saveAgentSkill(
  agentId: string,
  sourceText: string,
  opts?: { titleHint?: string }
): Promise<{ ok: true; path: string; title: string } | { ok: false; reason: string }> {
  const a = AGENTS[agentId];
  if (!a) return { ok: false, reason: `알 수 없는 에이전트: ${agentId}` };
  const trimmed = (sourceText || '').trim();
  if (trimmed.length < 80) return { ok: false, reason: '산출물이 너무 짧아 패턴화할 가치가 부족해요.' };
  const userBlock = (opts?.titleHint ? `[힌트] ${opts.titleHint}\n\n` : '') + `[산출물]\n${trimmed.slice(0, 4000)}`;
  let raw = '';
  try {
    raw = await _quickLLMCall(SKILL_DISTILL_PROMPT, userBlock, 600);
  } catch (e: any) {
    return { ok: false, reason: `LLM 호출 실패: ${e?.message || e}` };
  }
  let body = (raw || '').trim();
  /* Strip code fences if the model wrapped the markdown despite instructions */
  body = body.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```\s*$/, '').trim();
  if (!body) return { ok: false, reason: '큐레이터 LLM이 응답하지 못했어요.' };
  const firstLine = body.split('\n')[0].trim();
  if (/^#\s*SKIP/i.test(firstLine)) {
    return { ok: false, reason: '큐레이터 판단: 재사용 가치가 부족해 저장하지 않았어요.' };
  }
  if (!firstLine.startsWith('#')) {
    /* Force a heading so downstream display stays consistent */
    body = `# ${opts?.titleHint?.slice(0, 60) || '미정 스킬'}\n\n${body}`;
  }
  const title = body.split('\n')[0].replace(/^#+\s*/, '').trim();
  const slug = _slugifySkill(title);
  const skillsDir = path.join(getCompanyDir(), '_agents', agentId, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  let outPath = path.join(skillsDir, `${slug}.md`);
  /* Avoid collisions — append a short stamp if file exists */
  if (fs.existsSync(outPath)) {
    const stamp = new Date().toISOString().slice(5, 10).replace('-', '');
    outPath = path.join(skillsDir, `${slug}-${stamp}.md`);
  }
  const stamped = `${body}\n\n---\n_저장: ${new Date().toLocaleString('ko-KR')} · 출처: 직전 ${a.name} 산출물_\n`;
  try { fs.writeFileSync(outPath, stamped); }
  catch (e: any) { return { ok: false, reason: `파일 저장 실패: ${e?.message || e}` }; }
  return { ok: true, path: outPath, title };
}

/* ── Self-RAG verified knowledge store ────────────────────────────────────
   memory.md is the firehose (everything happens, including [추측]). When
   Self-RAG is ON for an agent, we parse its output for `[근거: source]`
   patterns and promote those claims into a curated `verified.md` next to
   memory.md. Future cycles preferentially retrieve from verified.md so the
   agent works off claims it has already self-grounded — not from raw
   speculation. */
function readAgentVerifiedKnowledge(agentId: string): string {
  try {
    const p = path.join(getCompanyDir(), '_agents', agentId, 'verified.md');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
  } catch { return ''; }
}
function appendAgentVerifiedKnowledge(agentId: string, claim: string, source: string) {
  try {
    const dir = path.join(getCompanyDir(), '_agents', agentId);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'verified.md');
    if (!fs.existsSync(p)) {
      const a = AGENTS[agentId];
      const header = `# ${a?.emoji || '✓'} ${a?.name || agentId} — 검증된 지식

_Self-RAG가 출력에서 \`[근거: ...]\` 태그가 붙은 주장만 자동 승격해서 누적._
_여기 들어온 내용만 다음 사이클의 retrieval 우선순위에 들어갑니다._
_사용자가 직접 줄을 지우면 그 주장은 다시 미검증 상태로 돌아갑니다._

`;
      fs.writeFileSync(p, header);
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const oneLine = (claim || '').replace(/\n/g, ' ').slice(0, 360);
    const src = (source || '').replace(/\n/g, ' ').slice(0, 120);
    fs.appendFileSync(p, `\n- [${stamp}] ${oneLine} _(근거: ${src})_`);
  } catch { /* ignore */ }
}
export function countAgentVerifiedClaims(agentId: string): number {
  try {
    const txt = readAgentVerifiedKnowledge(agentId);
    if (!txt) return 0;
    return (txt.match(/^\s*-\s*\[\d{4}-\d{2}-\d{2}\]/gm) || []).length;
  } catch { return 0; }
}

/* Parse an agent's response text for [근거: source] grounded claims and
   promote each to verified.md. We capture the WHOLE LINE (or a meaningful
   slice) containing the tag, plus the source label inside the brackets. */
export function promoteGroundedClaimsFromOutput(agentId: string, output: string): number {
  if (!output) return 0;
  /* Match lines that contain [근거: ...] anywhere. Grab the entire line for
     context, and pull the source out of the brackets. */
  const lines = output.split('\n');
  const tagRe = /\[\s*근거\s*[:：]\s*([^\]\n]+?)\s*\]/;
  let promoted = 0;
  for (const raw of lines) {
    const ln = raw.trim();
    if (!ln) continue;
    const m = ln.match(tagRe);
    if (!m) continue;
    /* Strip the [근거: ...] tag from the claim text so verified.md doesn't
       echo the bracket — we already have the source as a separate field. */
    const claim = ln.replace(tagRe, '').replace(/\s{2,}/g, ' ').trim();
    if (claim.length < 4) continue; /* skip degenerate matches */
    appendAgentVerifiedKnowledge(agentId, claim, m[1].trim());
    promoted++;
    if (promoted >= 12) break; /* sanity cap per output */
  }
  return promoted;
}

/* When the user injects a file into the brain (⚡ button), score it against
   each agent's specialty and append a memory line to the top matches. The
   raw file lives at <brain>/00_Raw/<date>/<name>; agents now know "new
   knowledge inbound" without us having to wait for them to scan the brain
   folder on next cycle. Returns the agent IDs that received an entry. */
export function routeBrainInjectionToAgents(filePath: string, fileName: string): string[] {
  if (!isCompanyConfigured()) return [];
  let raw = '';
  try {
    const st = fs.statSync(filePath);
    if (st.size > 80_000) return []; /* don't try to summarize giant files */
    raw = fs.readFileSync(filePath, 'utf-8').slice(0, 8000);
  } catch { return []; }
  if (!raw.trim()) return [];

  /* Best-of: score the file against every specialist. Pick top 2 above
     a threshold — narrow enough to avoid spamming everyone. */
  type Match = { id: string; score: number };
  const matches: Match[] = [];
  for (const id of SPECIALIST_IDS) {
    const kws = _agentKeywords(id);
    const score = _scoreRelevance(raw + ' ' + fileName, kws);
    if (score >= 2) matches.push({ id, score });
  }
  matches.sort((a, b) => b.score - a.score);
  const winners = matches.slice(0, 2).map(m => m.id);

  /* Always tell CEO too — CEO needs to know new knowledge arrived even if
     it doesn't match a specialist cleanly. */
  const recipients = Array.from(new Set(['ceo', ...winners]));

  /* Build the one-line summary: title (first H1) + first 140 chars of
     the first non-heading paragraph, or just the filename + first chunk. */
  const h1 = raw.match(/^#\s+(.+?)\s*$/m);
  const title = (h1 && h1[1] ? h1[1].trim() : fileName).slice(0, 80);
  const body = raw
    .replace(/^---[\s\S]*?---\n/, '')
    .split('\n')
    .find(ln => ln.trim() && !ln.trim().startsWith('#') && !ln.trim().startsWith('---'))
    || raw.replace(/\s+/g, ' ').slice(0, 200);
  const blurb = body.replace(/\s+/g, ' ').trim().slice(0, 160);
  /* Source path is relative to brain root (where 00_Raw/ etc. live),
     not the company subdir — keeps the citation human-readable. */
  const rel = path.relative(_getBrainDir(), filePath);

  const line = `📥 새 지식 입수 — **${title}**: ${blurb} (출처: ${rel})`;
  for (const id of recipients) {
    appendAgentMemory(id, line);
  }
  return recipients;
}

// ───────────────────────────────────────────────────────────────────────────
// Per-agent goal layer (v2.38)
// ---------------------------------------------------------------------------
// Each agent owns a personal `goal.md` separate from the company's shared
// `_shared/goals.md`. Hierarchy when building prompt context:
//   1. Agent goal       (this file) — most specific, takes priority
//   2. Company goals    (_shared/goals.md) — shared by every agent
//   3. Company identity (_shared/identity.md)
//   4. Decisions log    (_shared/decisions.md)
//   5. Agent memory     (_agents/{id}/memory.md)
//   6. Brain knowledge  (root brain folder, surfaced by separate flow)
//
// Empty goal.md is fine — agent simply runs without a personal mission.
// ───────────────────────────────────────────────────────────────────────────
/* v2.91.x — Mission templates (`_GOAL_PREAMBLE` + `DEFAULT_AGENT_GOALS`) 와
   `_seedAgentGoalIfMissing` 는 `./seeds/manifest-and-goal.ts` 로 이동했습니다. */

export function readAgentGoal(agentId: string): string {
  try {
    const p = path.join(getCompanyDir(), '_agents', agentId, 'goal.md');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
  } catch { return ''; }
}

export function writeAgentGoal(agentId: string, content: string) {
  const dir = path.join(getCompanyDir(), '_agents', agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'goal.md'), content);
}

/* `_seedAgentGoalIfMissing` 는 `./seeds/manifest-and-goal.ts` 로 이동. */

// ───────────────────────────────────────────────────────────────────────────
// Per-agent retrieval strategy (v2.45) — educational toggle
// ---------------------------------------------------------------------------
// Each agent picks ONE retrieval strategy. The choice changes both how the
// agent reads the brain folder AND how it self-checks its own output:
//   - "standard"  : current keyword routing, no self-critique
//   - "self-rag"  : keyword routing + self-critique step (factuality + sources)
//   - "graph-rag" : co-occurrence graph traversal over brain folder
// Stored as plain text in `_agents/{id}/rag_mode.txt`. Default is "standard"
// so existing companies keep current behavior on upgrade.
// ───────────────────────────────────────────────────────────────────────────
/* Two modes only: 'standard' = Graph RAG retrieval, no self-critique.
   'self-rag' = Graph RAG retrieval + self-critique protocol + verified.md
   promotion. The old 'graph-rag' mode is folded into 'standard' since the
   graph IS the brain — always traversed. Existing saved values of
   'graph-rag' are migrated to 'standard' on read. */
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
export function writeAgentSelfRagCriteria(agentId: string, content: string) {
  const dir = path.join(getCompanyDir(), '_agents', agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'self_rag_criteria.md'), (content || '').slice(0, 4000));
}

// ───────────────────────────────────────────────────────────────────────────
// Per-agent tools (v2.39)
// ---------------------------------------------------------------------------
// Each agent owns a `tools/` folder under their `_agents/{id}/` directory.
// A tool is a triplet:
//   <name>.py    — executable script (reads sibling JSON for config)
//   <name>.json  — config values (API keys, params) — edited via panel UI
//   <name>.md    — agent-facing description (shown in panel + injected
//                   into specialist prompt context as a tool catalog)
//
// Tools live INSIDE the brain folder so they auto-sync to GitHub with the
// rest of the user's knowledge. Scripts use os.path.dirname(__file__) to
// resolve their config path, so they work regardless of where the user
// puts their brain folder.
// ───────────────────────────────────────────────────────────────────────────

interface AgentTool {
  name: string;          // e.g. "trend_sniper"
  displayName: string;   // human label
  description: string;   // short blurb for catalog
  scriptPath: string;    // absolute path to .py
  configPath: string;    // absolute path to .json
  readmePath: string;    // absolute path to .md
  config: Record<string, any>;   // parsed JSON values
  configSchema: ToolField[];     // inferred field schema for UI
  injectedAt?: string;   // ISO date — only set for skills injected via /api/skill-inject
  injectedFrom?: string; // origin tag (e.g. "ezer", "ai-university")
  enabled: boolean;      // user toggle — false hides tool from agent's prompt catalog
}

interface ToolField {
  key: string;
  label: string;
  type: 'password' | 'text' | 'list' | 'number' | 'select';
  value: any;
  /** v2.89.72 — select 타입일 때 드롭다운 옵션 목록. JSON config의 `_schema[KEY].options`에서. */
  options?: { value: string; label: string }[];
  /** v2.89.72 — select/text/number 공통 — 사용자한테 보여줄 placeholder/도움말. `_schema[KEY].hint`. */
  hint?: string;
}

function _inferToolFieldType(key: string, value: any, schema?: any): ToolField['type'] {
  // v2.89.72 — _schema에서 명시적 type 지정이 있으면 우선
  if (schema && schema[key] && schema[key].type) {
    const t = schema[key].type;
    if (['password', 'text', 'list', 'number', 'select'].includes(t)) return t;
  }
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'number') return 'number';
  // any key with KEY/SECRET/TOKEN/PASS → password
  if (/(KEY|SECRET|TOKEN|PASS|API)/i.test(key)) return 'password';
  return 'text';
}

export function listAgentTools(agentId: string): AgentTool[] {
  const dir = path.join(getCompanyDir(), '_agents', agentId, 'tools');
  if (!fs.existsSync(dir)) return [];
  let entries: string[] = [];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  let names = entries
    .filter(f => f.endsWith('.py'))
    .map(f => f.slice(0, -3));
  /* v2.67 dedup: hide the iCal-only `google_calendar` tool whenever the
     OAuth tool `google_calendar_write` is present — they overlap entirely
     and users found two "Google Calendar" entries confusing. */
  if (names.includes('google_calendar') && names.includes('google_calendar_write')) {
    names = names.filter(n => n !== 'google_calendar');
  }
  const out: AgentTool[] = [];
  for (const name of names) {
    const scriptPath = path.join(dir, `${name}.py`);
    const configPath = path.join(dir, `${name}.json`);
    const readmePath = path.join(dir, `${name}.md`);
    let config: Record<string, any> = {};
    try {
      if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch { /* malformed JSON — leave empty */ }
    let readme = '';
    try { if (fs.existsSync(readmePath)) readme = fs.readFileSync(readmePath, 'utf-8'); } catch {}
    // Display name: first H1 in readme, or prettified file name
    const h1 = readme.match(/^#\s+(.+)$/m);
    const displayName = h1 ? h1[1].trim() : name.replace(/_/g, ' ');
    // Description: first non-heading paragraph
    const descMatch = readme.split('\n').find(l => l.trim() && !l.startsWith('#'));
    const description = (descMatch || '').slice(0, 200);
    // _injectedAt 등 메타 키는 사용자에게 노출되는 설정 폼에선 숨김 — 출처 추적용 내부 필드.
    // v2.89.72 — _schema 메타 필드로 select 옵션·hint·label override 가능.
    const schema = (config && typeof config._schema === 'object') ? config._schema : null;
    const configSchema: ToolField[] = Object.entries(config)
      .filter(([key]) => !key.startsWith('_'))
      .map(([key, value]) => {
        const t = _inferToolFieldType(key, value, schema);
        const fieldMeta = schema && schema[key] ? schema[key] : null;
        const field: ToolField = {
          key,
          label: (fieldMeta && fieldMeta.label) || key.replace(/_/g, ' '),
          type: t,
          value,
        };
        if (t === 'select' && fieldMeta && Array.isArray(fieldMeta.options)) {
          field.options = fieldMeta.options.map((o: any) =>
            typeof o === 'string' ? { value: o, label: o } : { value: o.value, label: o.label || o.value }
          );
        }
        if (fieldMeta && fieldMeta.hint) field.hint = fieldMeta.hint;
        return field;
      });
    const injectedAt = typeof config._injectedAt === 'string' ? config._injectedAt : undefined;
    const injectedFrom = typeof config._injectedFrom === 'string' ? config._injectedFrom : undefined;
    /* enabled defaults TRUE — explicit `_enabled: false` opts out, missing
       config or missing key both keep the tool active. Stored alongside
       other config keys so it round-trips through writeToolConfig untouched. */
    const enabled = config._enabled === false ? false : true;
    out.push({ name, displayName, description, scriptPath, configPath, readmePath, config, configSchema, injectedAt, injectedFrom, enabled });
  }
  return out;
}

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

export const CEO_PLANNER_PROMPT = _loadPrompt('ceo-planner.md');
/* Conversational CEO prompt — used for the casual-chat fast path so a "안녕"
   doesn't crash the JSON planner. Small models will reply with a polite
   greeting no matter how strict the JSON instruction; we detect those turns
   up front and route them here instead of fighting the model. */
export const CEO_CHAT_PROMPT = _loadPrompt('ceo-chat.md');
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
export const SECRETARY_TRIAGE_PROMPT = _loadPrompt('secretary-triage.md');
/* Heuristic for "this is small talk, not a work order". When true we skip
   the JSON planner and just have CEO chat back. Conservative: only matches
   short greetings/acks; anything longer or with action verbs falls through
   to the full planner. */
export function _isCasualChat(text: string): boolean {
    const t = (text || '').trim();
    if (!t) return false;
    // Very short messages with no verbs → casual
    if (t.length < 6) return true;
    // Common Korean greetings / acks / status questions (whole-word-ish)
    if (/^(안녕|잘\s*지냈|헬로|하이|좋은\s*아침|좋은\s*저녁|굿모닝|굿이브닝|반가워|오랜만|뭐해|뭐\s*하고|잘\s*있어|식사|밥\s*먹|커피|화이팅|파이팅)/i.test(t)) return true;
    if (/^(응|네|넵|넹|그래|좋아|오케이|ok|okay|ㅇㅋ|알겠|확인|고마워|감사|땡큐|thx|thanks)([\s.!?~ㅋㅎ]|$)/i.test(t)) return true;
    // Pure emoji/laughter
    if (/^[\sㅋㅎ.!?~ㅠㅜ😂🙂😊👍❤️]+$/u.test(t)) return true;
    return false;
}

export const CEO_REPORT_PROMPT = _loadPrompt('ceo-report.md');
export const CONFER_PROMPT = _loadPrompt('confer.md');
export const DECISIONS_EXTRACT_PROMPT = _loadPrompt('decisions-extract.md');
/* v2.87.11 — 에이전트가 외부 API에 의존할 때, 자격증명이 없으면 그 사실을
   에이전트 본인이 알고 사용자에게 입력해달라고 응답해야 함. 이 함수가
   sysPrompt에 명시적인 config 상태 블록을 주입한다. 키가 비어있으면 강제로
   "사용자에게 입력 요청하세요" 지시 포함. */
/* v2.89.10 — 진짜 데이터 prefetch. LLM 호출 전 시스템이 직접 도구 실행해서
   결과를 컨텍스트로 강제 주입. 이전 패턴은 에이전트가 <run_command>를 자발적
   출력해야만 발동됐는데, 작은 LLM은 자주 안 함 → 거짓말 (placeholder 데이터)
   양산. 이제 prefetch 결과가 있으면 에이전트가 거짓말 못 함 — 진짜 숫자 보고
   답하거나 "데이터에 없음"이라고 솔직히 말하거나. */
export async function prefetchAgentRealtimeData(agentId: string): Promise<string> {
  /* v2.89.11 — 진짜 API 호출하는 도구 우선. 이전엔 youtube_account.py 호출했는데
     그건 설정 sanity-check만 출력하지 실제 채널 데이터 안 가져옴. my_videos_check.py
     가 진짜 YouTube API 호출해서 채널 영상·조회수·기준선 데이터 반환. */
  const candidates: Array<{ tool: string; label: string }> = [];
  if (agentId === 'youtube') {
    candidates.push({ tool: 'my_videos_check.py', label: 'YouTube 채널 영상 분석 (실제 API 데이터)' });
    candidates.push({ tool: 'youtube_account.py', label: 'YouTube 설정 확인 (fallback)' });
  }
  /* v2.89.136 — business prefetch. 현빈에게 매출 질문 들어오면 paypal_revenue.py
     자동 실행 → 거래 + 게임별 분류 + 환불·수수료 마크다운 컨텍스트로 주입 →
     현빈이 환각 없이 진짜 숫자로 분석. 유튜브(레오) 와 동일 패턴. */
  if (agentId === 'business') {
    candidates.push({ tool: 'paypal_revenue.py', label: 'PayPal 매출 분석 (게임·프로젝트별, 실제 거래 데이터)' });
  }
  if (candidates.length === 0) return '';
  const toolsDir = path.join(getCompanyDir(), '_agents', agentId, 'tools');
  if (!fs.existsSync(toolsDir)) return '';
  const blocks: string[] = [];
  let gotRealData = false;
  for (const c of candidates) {
    const scriptPath = path.join(toolsDir, c.tool);
    if (!fs.existsSync(scriptPath)) continue;
    /* 첫 도구가 성공하면 fallback 도구는 건너뜀 (이미 진짜 데이터 확보) */
    if (gotRealData) break;
    try {
      const r = await new Promise<{ exitCode: number; output: string; timedOut: boolean }>((resolve) => {
        runCommandCaptured(`${_pythonCmd()} ${JSON.stringify(c.tool)}`, toolsDir, () => { /* silent */ }, 90000)
          .then(resolve)
          .catch(() => resolve({ exitCode: -1, output: '', timedOut: false }));
      });
      const out = (r.output || '').trim();
      if (r.exitCode === 0 && out) {
        blocks.push(`### ${c.label}\n\`\`\`\n${out.slice(0, 5000)}\n\`\`\``);
        gotRealData = true;
      } else if (out) {
        /* exit code != 0 but has output — usually error message worth surfacing */
        blocks.push(`### ${c.label} _(exit ${r.exitCode}${r.timedOut ? ', 시간 초과' : ''})_\n\`\`\`\n${out.slice(0, 3000)}\n\`\`\``);
      } else {
        blocks.push(`### ${c.label}\n_(도구 실행 실패 — exit ${r.exitCode}${r.timedOut ? ', 시간 초과' : ''}, 출력 없음. Python·google-api-python-client 설치 확인 필요)_`);
      }
    } catch (err: any) {
      blocks.push(`### ${c.label}\n_(실행 에러: ${err?.message || err})_`);
    }
  }
  if (blocks.length === 0) return '';
  /* 진짜 데이터 확보 여부에 따라 강력한 지시 다르게 */
  const strictRule = gotRealData
    ? `⚠️ **위 데이터에 없는 숫자는 추측·생성 금지**. "[데이터 입력 필요]" 같은 placeholder 절대 금지. 빈 항목은 "이 지표는 사용 가능 데이터에 포함 안 됨"이라고 솔직히 표시.

🛑 **read_file·list_files 사용 금지 (실시간 데이터 이미 위에 있음)**:
위 [실시간 데이터] 블록에 진짜 매출/거래/숫자가 모두 포함돼 있음. README 또는 .md 문서 읽지 마세요 — 그건 사용법 안내일 뿐이고 실데이터 아님. 위 표·숫자를 그대로 인용해서 즉시 분석/액션 제안.

✅ **즉시 답변 패턴**:
1. 첫 줄: "사장님, 이번 달 매출 [정확한 금액] 입니다."
2. 핵심 인사이트 1~2개 (위 데이터에서 직접 인용)
3. 다음 액션 1개 (구체적, 실행 가능)
4. 마지막 자가평가 + 다음 단계 (필수)`
    : `🛑 **실시간 데이터 가져오기 실패** — 위 출력은 에러 메시지뿐. 사용자에게 정확히 무엇이 문제인지(Python 미설치? 패키지 미설치? API 키 미설정?) 알려주고, 가짜 분석·placeholder 데이터 절대 생성하지 마세요. 작업은 '대기' 평가로 끝내고 다음 단계는 사용자가 환경 셋업 후 재시도.`;
  return `\n\n[실시간 데이터 — 시스템이 방금 도구로 가져온 진짜 출력]\n\n${blocks.join('\n\n')}\n\n${strictRule}`;
}

export function buildAgentConfigStatus(agentId: string): string {
  const lines: string[] = [];
  if (agentId === 'youtube') {
    try {
      /* v2.89.18 — 캐노니컬 youtube_account.json 단일 출처. 이전엔 config.md를
         읽어서 외부 연결 패널·도구·에이전트 상태가 다른 데이터 보고 있었음. */
      const jsonPath = path.join(getCompanyDir(), '_agents', 'youtube', 'tools', 'youtube_account.json');
      let cfg: Record<string, any> = {};
      try {
        if (fs.existsSync(jsonPath)) cfg = JSON.parse(fs.readFileSync(jsonPath, 'utf-8') || '{}');
      } catch { /* malformed */ }
      const apiKey = String(cfg.YOUTUBE_API_KEY || '').trim();
      const channelId = String(cfg.MY_CHANNEL_ID || '').trim() || String(cfg.MY_CHANNEL_HANDLE || '').trim();
      const oauthOk = isYoutubeOAuthConnected();
      const missing: string[] = [];
      if (!apiKey) missing.push('YOUTUBE_API_KEY (구독자/조회수/영상 메타)');
      if (!channelId) missing.push('YOUTUBE_CHANNEL_ID (내 채널 식별자)');
      if (missing.length > 0) {
        lines.push(`\n\n[⚠️ 필수 자격증명 미설정]`);
        lines.push(`다음 정보가 비어있어 실제 분석이 불가능합니다:`);
        for (const m of missing) lines.push(`- ${m}`);
        lines.push('');
        lines.push(`[필수 응답 규칙]`);
        lines.push(`반드시 사용자에게 다음과 같이 안내하세요:`);
        lines.push(`> 📊 채널 분석을 하려면 YouTube API 키와 채널 ID가 필요해요. 헤더 우측 "👥 직원 에이전트 보기" 버튼 → YouTube 카드 ⚙️ 클릭 → API 키와 채널 ID 입력 후 다시 요청해주세요.`);
        lines.push(`추측이나 일반론으로 답하지 말고, 위 안내만 짧게 출력하세요. 작업은 미완료(📊 평가: 대기)로 표시.`);
      } else if (!oauthOk) {
        /* v2.89.8 — Analytics OAuth가 비연결인데 사용자가 시청 지속률 등을 요청하면,
           시스템이 자동으로 브라우저를 열어 OAuth 인증을 진행합니다. 에이전트는
           긴 안내 X, 짧게 한 줄만 출력. */
        lines.push(`\n\n[자격증명 상태] ✅ YouTube Data API 연결됨 — 공개 통계 분석 즉시 가능 (구독자·조회수·영상별 메타·댓글)`);
        lines.push(`⚠️ Analytics OAuth 미연결 — 시청 지속률·트래픽 소스·인구통계 같은 비공개 지표는 OAuth 인증 필요`);
        lines.push(``);
        lines.push(`[자동 OAuth 트리거 정책]`);
        lines.push(`사용자가 위 비공개 지표를 요청하면 시스템이 자동으로 브라우저를 열어 Google OAuth 인증을 시작합니다. 당신은 길게 설명할 필요 없이 다음 한 문장만 출력하세요:`);
        lines.push(`> "🔐 Analytics 데이터 접근 권한이 필요해서 Google 인증 창을 자동으로 열어드릴게요. 브라우저에서 승인 후 다시 요청해주세요."`);
        lines.push(`그리고 출력 끝에 **반드시** 다음 토큰을 포함하세요 (시스템이 이걸 보고 OAuth 자동 발동):`);
        lines.push(`<TRIGGER:youtube_oauth>`);
        lines.push(``);
        lines.push(`[공개 통계만 요청된 경우]`);
        lines.push(`OAuth 트리거 토큰 출력 X. 가용 데이터로 충실히 분석.`);
      } else {
        lines.push(`\n\n[자격증명 상태] ✅ YouTube API + OAuth 모두 연결됨 — 모든 분석 가능`);
      }
    } catch { /* keep silent */ }
  }
  if (agentId === 'secretary') {
    const tg = readTelegramConfig();
    const calOk = isCalendarWriteConnected();
    if (!tg.token || !tg.chatId || !calOk) {
      lines.push(`\n\n[⚠️ 비서 자격증명 일부 미설정]`);
      if (!tg.token || !tg.chatId) lines.push(`- 텔레그램 봇 미연결 (보고/메신저 기능 제한)`);
      if (!calOk) lines.push(`- Google Calendar OAuth 미연결 (일정 추가/수정 불가)`);
      lines.push(`사용자가 해당 기능을 요청하면 "직원 보기 → 카리나 카드 → ⚙️에서 연결해주세요"라고 안내하세요.`);
    }
  }
  /* v2.89.7 — YouTube에 의존하는 다른 에이전트들도 OAuth 안내 절대 하지 않게.
     Researcher, Business 등이 YouTube 데이터를 사용할 때 "OAuth 필요" 같은
     막다른 안내로 빙빙 도는 패턴을 끊음. */
  if (agentId === 'researcher' || agentId === 'business' || agentId === 'writer' || agentId === 'editor') {
    const oauthOk = isYoutubeOAuthConnected();
    if (!oauthOk) {
      lines.push(`\n\n[유튜브 데이터 사용 가이드]`);
      lines.push(`동료 YouTube 에이전트가 제공하는 데이터는 "공개 통계 한정" (구독자·조회수·영상별 메타·댓글). 시청 지속률·트래픽 소스·시청자 인구통계는 현재 "준비 중" 단계입니다.`);
      lines.push(`사용자에게 "OAuth 연결 버튼 눌러주세요" 같은 안내 하지 말고, 있는 데이터로 가능한 분석을 충실히 수행하세요. 작업 평가는 '대기' 대신 '진행중' 또는 '완료'로.`);
    }
  }
  return lines.join('\n');
}

export function buildSpecialistPrompt(agentId: string): string {
  const a = AGENTS[agentId];
  const company = readCompanyName() || '1인 기업';
  /* v2.89.45 — 페르소나 블록. 에이전트별 voice 정의가 있으면 주입 → 똑같은 LLM이라도
     레오는 데이터 중심 솔직한 톤, 영숙은 정중·친근한 톤으로 답함. 인격 있는 동료처럼 보임. */
  const personaBlock = a.persona
    ? `\n\n[당신의 톤·말투 — 항상 이 페르소나 유지]\n${a.persona}`
    : '';
  return `당신은 ${company}의 ${a.emoji} ${a.name} (${a.role}) 에이전트입니다.

[전문 영역]
${a.specialty}${personaBlock}

[작업 환경]
- 시스템 컨텍스트에 (1) 당신의 개인 목표 (2) 회사 공동 목표 (3) 회사 정체성/의사결정 (4) 당신의 개인 메모리가 우선순위 순서대로 주입됩니다. 1번을 가장 신뢰하세요.
- 같은 세션에서 다른 에이전트들이 먼저 만든 산출물도 함께 제공됩니다 (있을 경우).
- 당신의 산출물은 자동으로 sessions/ 폴더에 저장되어 다음 세션에서 다시 참조됩니다.

[로컬 파일·터미널 직접 조작 (v2.89.94+)]
당신은 사용자 컴퓨터의 실제 파일 시스템과 터미널에 직접 연결되어 있습니다. 텍스트로 "만들었다·편집했다"고 하지 말고 아래 태그로 실제 실행하세요. 시스템이 자동으로 디스크에 적용합니다.

  • <create_file path="...">내용</create_file> — 파일 생성·덮어쓰기 (~/, 절대경로, $HOME 모두 가능)
  • <edit_file path="..."><find>기존</find><replace>새</replace></edit_file> — 정확/공백관용 fuzzy 매칭. 성공 시 unified diff 자동 표시
  • <read_file path="..."/> — 32KB까지 읽기 (cat -n 줄번호 포함). 편집 전엔 반드시 먼저 read
  • <delete_file path="..."/> — 파일·디렉토리 삭제
  • <list_files path="..."/> — 디렉토리 목록
  • <glob pattern="**/*.ts"/> — 패턴으로 파일 찾기 (\`**\`=하위 모두, \`*\`=슬래시 외)
  • <grep pattern="..." files="**/*.py"/> — 파일 내용 검색 (정규식, 줄번호 표시)
  • <run_command>명령</run_command> — 셸 실행. 맥은 sh, 윈도우는 cmd.exe
  • <reveal_in_explorer path="..."/> — Finder/Explorer 열기 (사용자 시각 확인용)
  • <open_file path="..."/> — 기본 앱(이미지·PDF·웹페이지)으로 열기

OS 차이: 백그라운드 프로세스는 맥/리눅스에선 \`nohup ... &\`, 윈도우에선 \`start /b ...\` (시스템이 \`run_command\`를 \`shell:true\`로 실행하므로 양쪽 모두 작동).

[🛑 절대 경로 사용 규칙 — v2.89.131]
- 이전 turn 에서 파일을 만들었다면 그 **절대 경로 그대로** 다시 쓰세요. 추측 금지.
- 시스템이 system prompt 아래쪽에 "당신이 최근 작업한 파일들" 블록으로 정확한 경로를 알려줍니다. 그걸 신뢰하세요.
- 당신의 도구 폴더 (\`_agents/<id>/tools/\`) 와 사용자 프로젝트 폴더는 다릅니다. 사용자가 "이 프로젝트에 ..."라고 했으면 그 폴더는 도구 폴더 안이 아닙니다.
- 경로가 헷갈리면 추측하지 말고 \`<list_files path="~/Downloads/지식메모리/_company"/>\` 처럼 상위 폴더부터 탐색하세요.

[출력 규칙]
- 한국어 마크다운으로 작성
- 첫 줄: 한 줄 시작 신호 (예: "${a.emoji} ${a.name}: 작업 시작합니다.")
- 본문: 구체적인 산출물. 추상적·일반론 금지. 바로 실행 가능한 결과물.
- 파일 만들거나 명령 실행할 거면 위 태그 사용. "만들겠습니다" 텍스트로만 끝나면 사용자 컴퓨터엔 아무 일도 안 일어남.
- 사족·사과·면책·자기검열 금지. 가성비 있게.
- 위 [톤·말투]가 정의돼있으면 반드시 그 voice로 일관되게 작성.

[필수 자가평가 — 마지막 두 줄 강제]
- 끝에서 두 번째 줄: \`📊 평가: <완료|진행중|대기> — <한 문장 이유>\`
  · 완료 = 이 산출물로 목표가 달성됨
  · 진행중 = 다음 스텝에서 더 진전 가능
  · 대기 = 다른 에이전트/사람의 입력이 필요해 지금은 멈춤
- 마지막 줄: \`📝 다음 단계: <한 줄, 구체적 액션>\` (대기 상태면 "대기 — <누구의 무엇이 필요>" 형식)
- 자가평가 없이 끝나면 시스템이 산출물을 거부합니다.`;
}

// ============================================================
// Robust Git Auto-Sync (module scope)
// ------------------------------------------------------------
// Auto-sync runs silently in the background after every brain
// modification. It must be NON-DESTRUCTIVE: never force-push,
// never use `-X ours` to silently discard remote changes, and
// never block the UI thread on credential prompts.
// On any conflict / auth failure, surface a friendly message
// and let the user resolve it via the manual sync menu.
// ============================================================
export async function _safeGitAutoSync(brainDir: string, commitMsg: string, provider: any = null) {
    if (_autoSyncRunning) return; // dedup: another auto-sync (or manual sync) is already running
    _autoSyncRunning = true;

    const notify = (msg: string, delayMs = 4000) => {
        if (provider && provider.injectSystemMessage) {
            setTimeout(() => provider.injectSystemMessage(msg), delayMs);
        }
    };

    try {
        if (!isGitAvailable()) {
            notify(`⚠️ **[GitHub Sync 건너뜀]** git이 설치되지 않았습니다. https://git-scm.com 에서 설치 후 재시도하세요. (로컬 파일은 안전하게 저장됨)`);
            return;
        }

        // 폴더가 git repo가 아니면, GitHub URL이 설정돼 있을 때만 자동 init.
        // (사용자가 settings.json에서 직접 폴더 경로를 입력한 경우에도 작동하도록 함)
        const isRepo = gitExecSafe(['status'], brainDir) !== null;
        if (!isRepo) {
            const repoUrl = vscode.workspace.getConfiguration('agentOs').get<string>('secondBrainRepo', '');
            const cleanRepo = repoUrl ? validateGitRemoteUrl(repoUrl) : null;
            if (!cleanRepo) {
                // GitHub URL도 없음 → 사용자가 sync 의도를 표현한 적이 없음. 조용히 종료.
                notify(`✅ 지식이 로컬에 저장되었습니다.\n\n💡 **Tip:** 깃허브 백업을 원하시면 🧠 메뉴 → '깃허브 동기화'를 눌러 저장소를 연결하세요!`, 3000);
                return;
            }
            // GitHub URL이 있다 → 자동으로 git init + remote 등록
            const initRes = gitRun(['init'], brainDir, 10000);
            if (initRes.status !== 0) {
                notify(`⚠️ **[GitHub Sync]** git init 실패: ${classifyGitError(initRes.stderr).message}`);
                return;
            }
        }

        ensureBrainGitignore(brainDir);
        ensureInitialCommit(brainDir);

        // Stage + commit any new local work. "nothing to commit" is fine.
        gitExecSafe(['add', '.'], brainDir);
        gitExecSafe(['commit', '-m', commitMsg], brainDir);

        // No remote configured → try to pull from settings, otherwise stay local.
        const existingRemote = gitExecSafe(['remote', 'get-url', 'origin'], brainDir)?.trim() || '';
        if (!existingRemote) {
            const repoUrl = vscode.workspace.getConfiguration('agentOs').get<string>('secondBrainRepo', '');
            const cleanRepo = repoUrl ? validateGitRemoteUrl(repoUrl) : null;
            if (!cleanRepo) {
                notify(`✅ 지식이 로컬에 안전하게 저장되었습니다.\n\n💡 **Tip:** 깃허브 백업을 원하시면 🧠 메뉴 → '깃허브 동기화'를 눌러주세요!`, 3000);
                return;
            }
            gitExecSafe(['remote', 'add', 'origin', cleanRepo], brainDir);
        }

        // Detect what branch the remote actually uses (main / master / something else).
        const remoteBranch = getRemoteDefaultBranch(brainDir);
        const currentBranch = gitExecSafe(['rev-parse', '--abbrev-ref', 'HEAD'], brainDir)?.trim() || '';
        if (currentBranch && currentBranch !== remoteBranch) {
            gitExecSafe(['branch', '-M', remoteBranch], brainDir);
        }

        // 인증은 시스템 git에 맡깁니다 (osxkeychain / gh CLI / SSH 키).

        // Fetch first so we know whether we're behind.
        const fetchRes = gitRun(['fetch', 'origin', remoteBranch], brainDir, 30000);
        if (fetchRes.status !== 0) {
            // Fetch failure usually = auth or network. Surface details and stop.
            const err = classifyGitError(fetchRes.stderr);
            notify(`⚠️ **[GitHub Sync 실패]** ${err.message}`);
            return;
        }

        // Try fast-forward only — if local has diverged, do NOT auto-merge.
        const ffRes = gitRun(['merge', '--ff-only', `origin/${remoteBranch}`], brainDir, 15000);
        if (ffRes.status !== 0) {
            const stderrLower = ffRes.stderr.toLowerCase();
            const diverged = stderrLower.includes('not possible') || stderrLower.includes('non-fast-forward') || stderrLower.includes('refusing');
            if (diverged) {
                // 사용자 친화 알림 + 1-클릭 병합 버튼. 채팅 인젝션 메시지는 백업
                // (사용자가 native 토스트를 놓쳤을 때를 대비), 토스트의 "병합하기"
                // 버튼이 그대로 수동 동기화 플로우(_syncSecondBrain)를 호출함.
                notify(`💡 **온라인 지식과 로컬에 서로 다른 내용이 있어요.** 동기화하려면 채팅창 위 알림의 "병합하기"를 누르거나 메뉴 → 🧠 → '깃허브 동기화'를 눌러주세요. (로컬 파일은 안전합니다)`);
                vscode.window.showWarningMessage(
                    '온라인 지식(GitHub)과 로컬에 서로 다른 변경사항이 있습니다. 동기화하시겠어요?',
                    '병합하기', '나중에'
                ).then((choice) => {
                    if (choice === '병합하기' && provider && (provider as any)._syncSecondBrain) {
                        (provider as any)._syncSecondBrain().catch(() => { /* manual sync handles its own errors */ });
                    }
                });
                return;
            }
            // Other merge errors (e.g., no upstream yet on first push) — push will create it.
        }

        // Push without -f. If push fails, classify and inform the user.
        const pushRes = gitRun(['push', '-u', 'origin', remoteBranch], brainDir, 60000);
        if (pushRes.status === 0) {
            notify(`✅ **[GitHub Sync]** 글로벌 뇌(Second Brain)에 지식이 자동 백업되었습니다!`, 5000);
        } else {
            const err = classifyGitError(pushRes.stderr);
            notify(`⚠️ **[GitHub Sync 실패]** ${err.message}\n\n💡 메뉴 → 🧠 → '깃허브 동기화' 에서 수동 해결을 시도해보세요. (로컬 파일은 안전합니다)`);
        }
    } catch (e: any) {
        console.error('Git Auto-Sync Failed:', e);
        notify(`⚠️ **[GitHub Sync 오류]** ${e?.message || e}\n(로컬 파일은 안전합니다)`);
    } finally {
        _autoSyncRunning = false;
    }
}

/* Company-folder git sync (separate from brain). Only meaningful when the
   company is DETACHED (lives outside <brain>/_company/) AND the user has
   set `agentOs.companyRepo`. Otherwise no-op — company is already
   covered by brain sync (nested) or user hasn't asked for backup. Uses
   its own lock so it can run in parallel with brain sync. */
export async function _safeGitAutoSyncCompany(commitMsg: string, provider: any = null) {
    if (_companySyncRunning) return;
    const companyDir = getCompanyDir();
    const brainDir = _getBrainDir();
    const isNested = path.normalize(companyDir).startsWith(path.normalize(brainDir) + path.sep);
    if (isNested) return; // brain sync covers it
    if (!fs.existsSync(companyDir)) return;
    const repoUrl = vscode.workspace.getConfiguration('agentOs').get<string>('companyRepo', '');
    const cleanRepo = repoUrl ? validateGitRemoteUrl(repoUrl) : null;
    if (!cleanRepo) return; // user hasn't asked for company backup yet

    _companySyncRunning = true;
    const notify = (msg: string, delayMs = 4000) => {
        if (provider && provider.injectSystemMessage) {
            setTimeout(() => provider.injectSystemMessage(msg), delayMs);
        }
    };
    try {
        if (!isGitAvailable()) return;
        const isRepo = gitExecSafe(['status'], companyDir) !== null;
        if (!isRepo) {
            const initRes = gitRun(['init'], companyDir, 10000);
            if (initRes.status !== 0) {
                notify(`⚠️ **[회사 GitHub Sync]** git init 실패: ${classifyGitError(initRes.stderr).message}`);
                return;
            }
        }
        ensureBrainGitignore(companyDir); // same boilerplate ignore is fine here
        ensureInitialCommit(companyDir);
        gitExecSafe(['add', '.'], companyDir);
        gitExecSafe(['commit', '-m', commitMsg], companyDir);
        const existingRemote = gitExecSafe(['remote', 'get-url', 'origin'], companyDir)?.trim() || '';
        if (!existingRemote) {
            gitExecSafe(['remote', 'add', 'origin', cleanRepo], companyDir);
        } else if (existingRemote !== cleanRepo) {
            gitExecSafe(['remote', 'set-url', 'origin', cleanRepo], companyDir);
        }
        const remoteBranch = getRemoteDefaultBranch(companyDir);
        const currentBranch = gitExecSafe(['rev-parse', '--abbrev-ref', 'HEAD'], companyDir)?.trim() || '';
        if (currentBranch && currentBranch !== remoteBranch) {
            gitExecSafe(['branch', '-M', remoteBranch], companyDir);
        }
        const fetchRes = gitRun(['fetch', 'origin', remoteBranch], companyDir, 30000);
        if (fetchRes.status !== 0) {
            notify(`⚠️ **[회사 GitHub Sync 실패]** ${classifyGitError(fetchRes.stderr).message}`);
            return;
        }
        gitRun(['merge', '--ff-only', `origin/${remoteBranch}`], companyDir, 15000);
        const pushRes = gitRun(['push', '-u', 'origin', remoteBranch], companyDir, 60000);
        if (pushRes.status !== 0) {
            notify(`⚠️ **[회사 GitHub Sync 실패]** push: ${classifyGitError(pushRes.stderr).message}`);
            return;
        }
        notify(`☁️ **[회사 백업]** ${path.basename(companyDir)} → ${cleanRepo.replace(/^https:\/\/[^@]+@/, 'https://')}`);
    } catch (e: any) {
        console.error('Company Git Auto-Sync Failed:', e);
    } finally {
        _companySyncRunning = false;
    }
}

// ============================================================
// Extension Activation
// ============================================================

// Module-level reference so module-scope helpers (e.g. showBrainNetwork) can
// register externally-opened graph panels with the provider for thinking
// event broadcasts.
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
    context.subscriptions.push(
        vscode.commands.registerCommand('agentOs.youtube.connectOAuth', async () => {
            const r = await startYouTubeOAuthFlow();
            if (r.ok) {
                vscode.window.showInformationMessage(r.message);
                _ytDashboardProvider?.refresh();
                if (CompanyDashboardPanel.current) CompanyDashboardPanel.current.refresh();
            } else {
                vscode.window.showWarningMessage(r.message);
            }
        }),
        vscode.commands.registerCommand('agentOs.dashboard.open', () => {
            try {
                _dashboardExtensionUri = context.extensionUri;
                CompanyDashboardPanel.createOrShow(context.extensionUri);
            } catch (e: any) {
                /* v2.89.14 — 진단: 대시보드 패널 생성 실패 시 사용자에게 안내. */
                vscode.window.showErrorMessage(`👥 직원 에이전트 보기 열기 실패: ${e?.message || e}. (Cmd+Shift+P → "Developer: Reload Window" 시도)`);
                console.error('[dashboard.open] failed:', e);
            }
        }),
        vscode.commands.registerCommand('agentOs.apiConnections.open', () => {
            ApiConnectionsPanel.createOrShow();
        }),
        /* v2.89.137 — 매출 대시보드 (PayPal 시각화) */
        vscode.commands.registerCommand('agentOs.revenueDashboard.open', () => {
            RevenueDashboardPanel.createOrShow();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('agentOs.tasks.refresh', () => {
            _taskTreeProvider?.refresh();
        }),
        vscode.commands.registerCommand('agentOs.tasks.markDone', (item: TaskTreeItem) => {
            if (item?.task) {
                updateTrackerTask(item.task.id, { status: 'done', evidence: '사이드바에서 완료 처리' });
            }
        }),
        vscode.commands.registerCommand('agentOs.tasks.cancel', async (item: TaskTreeItem) => {
            if (!item?.task) return;
            const ok = await vscode.window.showWarningMessage(
                `"${item.task.title}" 취소할까요?`,
                { modal: false },
                '취소', '뒤로'
            );
            if (ok === '취소') {
                updateTrackerTask(item.task.id, { status: 'cancelled', evidence: '사이드바에서 취소' });
            }
        }),
        vscode.commands.registerCommand('agentOs.tasks.setPriority', async (item: TaskTreeItem) => {
            if (!item?.task) return;
            const pick = await vscode.window.showQuickPick(
                [
                    { label: '🔴 긴급 (urgent)', value: 'urgent' as TaskPriority },
                    { label: '🟠 높음 (high)',   value: 'high'   as TaskPriority },
                    { label: '⚪ 보통 (normal)', value: 'normal' as TaskPriority },
                    { label: '🔵 낮음 (low)',    value: 'low'    as TaskPriority },
                ],
                { placeHolder: '우선순위 선택' }
            );
            if (pick) {
                updateTrackerTask(item.task.id, { priority: pick.value });
            }
        }),
        vscode.commands.registerCommand('agentOs.tasks.openTrackerJson', async () => {
            try {
                const p = path.join(getCompanyDir(), '_shared', 'tracker.json');
                if (!fs.existsSync(p)) {
                    vscode.window.showInformationMessage('아직 tracker.json 이 없어요. 작업이 등록되면 생성됩니다.');
                    return;
                }
                const doc = await vscode.workspace.openTextDocument(p);
                await vscode.window.showTextDocument(doc);
            } catch (e: any) {
                vscode.window.showErrorMessage(`tracker.json 열기 실패: ${e?.message || e}`);
            }
        }),
        vscode.commands.registerCommand('agentOs.diagnoseConnection', async () => {
            const out: string[] = [];
            const ok = (s: string) => out.push(`✅ ${s}`);
            const warn = (s: string) => out.push(`⚠️ ${s}`);
            const err = (s: string) => out.push(`❌ ${s}`);
            const info = (s: string) => out.push(`ℹ️ ${s}`);

            out.push('## 🤖 Claude CLI');
            const bin = resolveClaudeBin();
            info(`Claude binary: \`${bin || '(미설정 — PATH의 claude 사용 시도)'}\``);

            let versionOk = false;
            try {
                const version = await pingClaude();
                ok(`\`claude --version\` 응답: ${version}`);
                versionOk = true;
            } catch (e: any) {
                err(`Claude CLI 호출 실패: ${e?.message || e}`);
                info('설치 안 됐으면: 공식 가이드 https://docs.claude.com/en/docs/claude-code/setup 따라 설치 후 `claude login`.');
                info('이미 있으면: `which claude` 결과를 settings.json의 `agentOs.claudeBinPath` 에 넣어보세요.');
            }

            if (versionOk) {
                try {
                    const reply = await ask('Say "pong" and nothing else.', 'standard', { timeoutMs: 20_000 });
                    if (/pong/i.test(reply)) {
                        ok(`Sonnet 응답 OK — "${reply.trim().slice(0, 40)}"`);
                    } else {
                        warn(`Sonnet 응답이 예상과 다름: "${reply.trim().slice(0, 80)}"`);
                    }
                } catch (e: any) {
                    err(`Claude 응답 실패: ${e?.message || e}`);
                    info('Claude Max 구독 상태나 `claude login` 인증을 확인하세요.');
                }
            }

            /* v2.89.152 — Python 환경 진단. paypal_revenue·my_videos_check 같은 .py 도구
               실행이 exit 1 로 떨어질 때 어디서 막혔는지 사용자가 직접 진단. */
            out.push('');
            out.push('## 🐍 Python 환경');
            try {
                const _invalidate = require('child_process');
                _invalidatePythonCmdCache();
                const pyCmd = _pythonCmd();
                info(`자동 감지 결과: \`${pyCmd}\``);
                try {
                    const parts = pyCmd.split(' ');
                    const r = _invalidate.spawnSync(parts[0], parts.slice(1).concat(['--version']), { encoding: 'utf-8', timeout: 4000 });
                    const ver = ((r.stdout || '') + (r.stderr || '')).trim();
                    if (r.status === 0 && /python\s+3/i.test(ver)) {
                        ok(`Python 3 확인: ${ver}`);
                    } else if (/python\s+3\.\d/i.test(ver)) {
                        ok(`Python 3 (status ${r.status}): ${ver}`);
                    } else {
                        err(`Python 3 미감지. status=${r.status}, output=${ver.slice(0, 100)}`);
                        info(_pythonMissingHint());
                    }
                } catch (pe: any) {
                    err(`Python 호출 실패: ${pe?.message || pe}`);
                    info(_pythonMissingHint());
                }
                /* 사용자 override 표시 */
                try {
                    const cfgPy = (vscode.workspace.getConfiguration('agentOs').get<string>('pythonPath') || '').trim();
                    if (cfgPy) info(`사용자 설정 (\`agentOs.pythonPath\`): \`${cfgPy}\``);
                    else info(`사용자 설정 없음 (자동 감지 사용). 직접 지정하려면 명령 팔레트 → "설정 열기" → \`agentOs.pythonPath\``);
                } catch { /* ignore */ }
                /* 평행 진단 — 다른 후보 명령들 작동 여부 */
                const altCmds = process.platform === 'win32'
                    ? ['py', 'py -3', 'python', 'python3']
                    : ['python3', 'python', '/usr/bin/python3', '/opt/homebrew/bin/python3'];
                const altResults: string[] = [];
                for (const c of altCmds) {
                    try {
                        const parts = c.split(' ');
                        const r = _invalidate.spawnSync(parts[0], parts.slice(1).concat(['--version']), { encoding: 'utf-8', timeout: 2500 });
                        const ver = ((r.stdout || '') + (r.stderr || '')).trim().slice(0, 50);
                        if (/python\s+3\.\d/i.test(ver)) altResults.push(`  ✅ \`${c}\` → ${ver}`);
                        else if (r.status === 0) altResults.push(`  ⚠️ \`${c}\` → ${ver || '(no version output)'}`);
                        else altResults.push(`  ❌ \`${c}\` → 실패 (status ${r.status})`);
                    } catch (e: any) {
                        altResults.push(`  ❌ \`${c}\` → 호출 실패: ${(e?.message || '').slice(0, 50)}`);
                    }
                }
                info('후보 명령 평행 테스트:');
                altResults.forEach(r => out.push(r));
            } catch (pyErr: any) {
                err(`Python 진단 자체 실패: ${pyErr?.message || pyErr}`);
            }

            /* 결과 패널 표시 */
            const doc = await vscode.workspace.openTextDocument({
                language: 'markdown',
                content: `# 🔍 Agent OS — Claude CLI 연결 진단\n\n_${new Date().toLocaleString('ko-KR')}_\n\n${out.join('\n')}\n\n---\n\n## 자주 막히는 곳\n\n### Claude CLI가 처음이면\n1. 공식 설치 가이드: https://docs.claude.com/en/docs/claude-code/setup\n2. 설치 후 터미널에서 \`claude login\` 으로 Claude Max 계정 인증\n3. \`claude --version\` 으로 동작 확인\n4. Agent OS 다시 열고 채팅 시도\n\n### \`claude\` 명령을 못 찾는다면\n- \`which claude\` 결과를 settings.json 의 \`agentOs.claudeBinPath\` 에 절대경로로 박아두세요.\n- 예: \`/Users/hoony/.local/bin/claude\` 또는 \`~/bin/claude\`\n\n### 그래도 안 되면\n- VS Code/Anti-Gravity 재시작\n- 명령 팔레트 (Cmd+Shift+P) → \`Agent OS: 연결 진단\` 다시 실행\n- 위 결과 스크린샷과 함께 제보\n`,
            });
            await vscode.window.showTextDocument(doc, { preview: false });
        }),
        vscode.commands.registerCommand('agentOs.dailyBriefing.fireNow', async () => {
            try {
                await _runDailyBriefingOnce(true);
                vscode.window.showInformationMessage('🌅 데일리 브리핑이 텔레그램으로 발송됐어요. (토큰 미설정이면 무시됨)');
            } catch (e: any) {
                vscode.window.showErrorMessage(`브리핑 발사 실패: ${e?.message || e}`);
            }
        }),
        /* v2.89.115 — 직전 specialist 산출물을 재사용 가능한 패턴으로 승격.
           Hermes Agent의 self-improving skill 패턴을 1인 기업 컨셉에 맞게
           단순화 (자동 노이즈 X, 사용자가 명시적으로 트리거할 때만). */
        vscode.commands.registerCommand('agentOs.skill.saveLast', async () => {
            try {
                const last = _getLastSpecialistOutput();
                if (!last) {
                    vscode.window.showWarningMessage('직전 specialist 산출물을 찾지 못했어요. 작업 한 번 시킨 다음에 호출하세요.');
                    return;
                }
                const allIds = SPECIALIST_IDS.slice();
                const items = allIds.map(id => {
                    const a = AGENTS[id];
                    const isDefault = id === last.agentId;
                    return {
                        label: `${a.emoji} ${a.name}${isDefault ? '  (직전 발화)' : ''}`,
                        description: a.role,
                        id,
                    } as vscode.QuickPickItem & { id: string };
                });
                const pick = await vscode.window.showQuickPick(items, {
                    placeHolder: `어느 에이전트의 스킬로 저장할까요? (직전: ${AGENTS[last.agentId]?.name})`,
                });
                if (!pick) return;
                vscode.window.showInformationMessage(`💎 ${AGENTS[pick.id].name} — 패턴화 중…`);
                const result = await saveAgentSkill(pick.id, last.body, { titleHint: last.body.slice(0, 80) });
                if (!result.ok) {
                    vscode.window.showWarningMessage(`⚠️ ${result.reason}`);
                    try { appendConversationLog({ speaker: '시스템', emoji: '💎', section: '스킬 저장 시도', body: `${AGENTS[pick.id].name} → ${result.reason}` }); } catch { /* ignore */ }
                    return;
                }
                vscode.window.showInformationMessage(`✅ ${AGENTS[pick.id].name} 스킬 저장됨: ${result.title}`);
                try { appendConversationLog({ speaker: '시스템', emoji: '💎', section: '스킬 저장', body: `${AGENTS[pick.id].name} → ${result.title}` }); } catch { /* ignore */ }
                try { appendAgentMemory(pick.id, `[skill 승격] "${result.title}" — 다음 사이클부터 패턴 재사용`); } catch { /* ignore */ }
                /* 새로 만든 파일 바로 열어서 사용자가 검토·수정할 수 있게 */
                try { await vscode.window.showTextDocument(vscode.Uri.file(result.path)); } catch { /* ignore */ }
            } catch (e: any) {
                vscode.window.showErrorMessage(`스킬 저장 실패: ${e?.message || e}`);
            }
        }),
        vscode.commands.registerCommand('agentOs.youtube.refreshCommentQueue', async () => {
            try {
                vscode.window.showInformationMessage('📺 YouTube 댓글 가져오는 중...');
                const r = await _youtubeCommentReplyDraftBatch({});
                if (r.reason) {
                    vscode.window.showWarningMessage(`⚠️ ${r.reason}`);
                    return;
                }
                vscode.window.showInformationMessage(
                    `📺 답장 초안 ${r.drafted}건 생성, ${r.skipped}건 스킵 (이미 큐에 있거나 사용자가 답한 댓글). \`approvals/pending/\`에서 확인하거나 텔레그램 \`/approve <id>\`로 게시.`
                );
            } catch (e: any) {
                vscode.window.showErrorMessage(`YouTube 큐 갱신 실패: ${e?.message || e}`);
            }
        }),
        vscode.commands.registerCommand('agentOs.developer.scaffoldProject', async () => {
            try {
                const name = await vscode.window.showInputBox({
                    placeHolder: '프로젝트 이름 (영문/숫자/하이픈)',
                    prompt: 'Developer 에이전트가 _company/projects/ 안에 만들 폴더 이름',
                    validateInput: (v) => /^[a-zA-Z0-9_-]{2,40}$/.test(v) ? null : '영문·숫자·-·_ 만, 2~40자',
                });
                if (!name) return;
                const tpl = await vscode.window.showQuickPick(
                    [
                        { label: 'vite-vanilla', detail: 'Vite + 순수 JS' },
                        { label: 'vite-react',   detail: 'Vite + React + TypeScript' },
                        { label: 'static',       detail: 'index.html 한 장 (Tailwind CDN)' },
                    ],
                    { placeHolder: '템플릿 선택' }
                );
                if (!tpl) return;
                const result = await scaffoldDeveloperProject(name, tpl.label as 'vite-vanilla' | 'vite-react' | 'static');
                if (result.ok) {
                    const open = await vscode.window.showInformationMessage(
                        `✅ \`${name}\` 생성 완료 — ${result.path}`,
                        '폴더 열기',
                        '닫기'
                    );
                    if (open === '폴더 열기') {
                        const uri = vscode.Uri.file(result.path);
                        vscode.commands.executeCommand('revealFileInOS', uri);
                    }
                } else {
                    vscode.window.showErrorMessage(`❌ ${result.error}`);
                }
            } catch (e: any) {
                vscode.window.showErrorMessage(`프로젝트 생성 실패: ${e?.message || e}`);
            }
        })
    );

    // New Chat
    context.subscriptions.push(
        vscode.commands.registerCommand('agent-os.newChat', () => {
            provider.resetChat();
        })
    );

    // Export Chat as Markdown
    context.subscriptions.push(
        vscode.commands.registerCommand('agent-os.exportChat', async () => {
            await provider.exportChat();
        })
    );

    // Focus Chat Input (Cmd+L)
    context.subscriptions.push(
        vscode.commands.registerCommand('agent-os.focusChat', () => {
            provider.focusInput();
        })
    );

    // Explain Selected Code (right-click menu)
    context.subscriptions.push(
        vscode.commands.registerCommand('agent-os.explainSelection', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { return; }
            const selection = editor.document.getText(editor.selection);
            if (selection.trim()) {
                provider.sendPromptFromExtension(`이 코드를 분석하고 설명해줘:\n\`\`\`\n${selection}\n\`\`\``);
            }
        })
    );

    // Show Brain Network Topology
    context.subscriptions.push(
        vscode.commands.registerCommand('agent-os.showBrainNetwork', () => {
            showBrainNetwork(context);
        })
    );

    // 🏢 Open virtual office (스몰빌식 가상 사무실)
    context.subscriptions.push(
        vscode.commands.registerCommand('agent-os.openOffice', () => {
            OfficePanel.createOrShow(context, provider);
        }),
        /* v2.89.96 — 사이드바 ⋯ 메뉴가 어떤 이유로 클릭 안 받을 때를 대비한
           명령 팔레트 fallback. Cmd/Ctrl+Shift+P → "Agent OS: 설정 열기" */
        vscode.commands.registerCommand('agent-os.openSettings', async () => {
            try { await (provider as any)._handleSettingsMenu?.(); }
            catch (e: any) {
                vscode.window.showErrorMessage(`설정 메뉴 열기 실패: ${e?.message || e}`);
            }
        }),
        /* 회사 폴더 위치 변경 — 두뇌 안 nested vs 완전 분리 선택 */
        vscode.commands.registerCommand('agent-os.changeCompanyDir', async () => {
            await runChangeCompanyDir();
        }),
        /* 회사 GitHub 별도 연결 — 두뇌와 분리된 repo로 백업 */
        vscode.commands.registerCommand('agent-os.connectCompanyRepo', async () => {
            await runConnectCompanyRepo();
        }),
        /* Google Calendar 자동 일정 등록 (OAuth) */
        vscode.commands.registerCommand('agent-os.connectGoogleCalendarWrite', async () => {
            await runConnectGoogleCalendarWrite();
        })
    );
}

async function runConnectCompanyRepo() {
    const cfg = vscode.workspace.getConfiguration('agentOs');
    const companyDir = getCompanyDir();
    const brainDir = _getBrainDir();
    const isNested = path.normalize(companyDir).startsWith(path.normalize(brainDir) + path.sep);
    if (isNested) {
        const ok = await vscode.window.showInformationMessage(
            `회사 폴더가 두뇌 안 nested 위치에 있어요 — 두뇌 GitHub 저장소(\`secondBrainRepo\`)로 이미 같이 백업됩니다.\n\n별도 저장소를 쓰려면 먼저 명령 팔레트에서 "Agent OS: 회사 폴더 변경"으로 회사를 두뇌 외부로 옮기세요.`,
            { modal: false },
            '회사 폴더 변경하기',
            '괜찮아요'
        );
        if (ok === '회사 폴더 변경하기') {
            await runChangeCompanyDir();
        }
        return;
    }
    const cur = (cfg.get<string>('companyRepo', '') || '').trim();
    const url = await vscode.window.showInputBox({
        title: '🔗 회사 GitHub 저장소 URL',
        prompt: '예: https://github.com/사용자/my-company-workspace  (비워두면 회사 백업 OFF)',
        value: cur,
        ignoreFocusOut: true,
        placeHolder: 'https://github.com/...',
        validateInput: (v: string) => {
            const t = (v || '').trim();
            if (!t) return null; // empty = clear setting
            if (!validateGitRemoteUrl(t)) return '⚠️ 유효한 git URL이 아닌 것 같아요. https://github.com/ 또는 git@ 형식';
            return null;
        }
    });
    if (url === undefined) return; // user cancelled
    const cleaned = url.trim();
    await cfg.update('companyRepo', cleaned, vscode.ConfigurationTarget.Global);
    if (!cleaned) {
        await vscode.window.showInformationMessage('회사 GitHub 저장소 연결 해제됨. 회사 폴더는 로컬에만 저장됩니다.');
        return;
    }
    /* Try a first sync immediately so user gets instant feedback. */
    await vscode.window.showInformationMessage(`✅ 회사 GitHub 연결됨: ${cleaned.replace(/^https:\/\/[^@]+@/, 'https://')}\n\n첫 백업을 시도합니다…`);
    await _safeGitAutoSyncCompany(`Initial company backup`, _activeChatProvider);
}

/* Folder-picker driven flow for changing where the company workspace lives.
   Three paths the user can take:
     A) Nested under brain (default, recommended for solo users)
     B) Pick another folder (detached — separate git repo, team-shared, ...)
     C) Cancel */
async function runChangeCompanyDir() {
    const cfg = vscode.workspace.getConfiguration('agentOs');
    const cur = (cfg.get<string>('companyDir', '') || '').trim();
    const oldDir = getCompanyDir();
    const brainDir = _getBrainDir();
    const isNested = !cur || _resolvePathInput(cur) === path.join(brainDir, COMPANY_SUBDIR);
    const stateLine = isNested
        ? `현재: 📂 두뇌 안 nested (\`${path.join(brainDir, COMPANY_SUBDIR).replace(os.homedir(), '~')}\`)`
        : `현재: 📂 별도 위치 (\`${cur.replace(os.homedir(), '~')}\`)`;

    const picked = await vscode.window.showQuickPick(
        [
            { label: '$(folder) 두뇌 안 nested로 (권장 · 한 git repo)', description: '~/.../<두뇌>/_company/', value: 'nest' as const },
            { label: '$(folder-opened) 별도 폴더 직접 선택…', description: '두뇌와 완전히 분리. 외주 공유·다른 git repo·다른 동기화 가능', value: 'detach' as const },
            { label: '$(close) 취소', value: 'cancel' as const },
        ],
        { placeHolder: stateLine, ignoreFocusOut: true }
    );
    if (!picked || picked.value === 'cancel') return;

    let newDir = '';
    if (picked.value === 'nest') {
        newDir = path.join(brainDir, COMPANY_SUBDIR);
        await cfg.update('companyDir', '', vscode.ConfigurationTarget.Global);
    } else {
        const folder = await vscode.window.showOpenDialog({
            canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
            openLabel: '여기를 회사 폴더로',
            defaultUri: vscode.Uri.file(os.homedir()),
        });
        if (!folder || folder.length === 0) return;
        newDir = folder[0].fsPath;
        /* Sanity check — refuse silently-broken read-only picks (USB ROM,
           system folders, mounted snapshots, etc.). Bail with a clear msg
           BEFORE persisting the setting so user can retry without rolling
           back. */
        try {
            fs.accessSync(newDir, fs.constants.W_OK);
        } catch {
            await vscode.window.showErrorMessage(
                `❌ 이 폴더는 쓰기 권한이 없어요. 다른 폴더를 선택하세요: ${newDir.replace(os.homedir(), '~')}`
            );
            return;
        }
        await cfg.update('companyDir', newDir, vscode.ConfigurationTarget.Global);
    }

    /* Move existing data if old has content + new is empty/non-existent.
       Otherwise leave both alone — refuse to merge silently to avoid
       overwriting anything. */
    if (newDir === oldDir) {
        await vscode.window.showInformationMessage(`회사 폴더 위치 변경 없음.`);
        return;
    }
    const oldHasData = fs.existsSync(oldDir) && fs.readdirSync(oldDir).length > 0;
    const newHasData = fs.existsSync(newDir) && fs.readdirSync(newDir).length > 0;
    if (!oldHasData) {
        await vscode.window.showInformationMessage(`✅ 회사 폴더 위치 설정됨: ${newDir.replace(os.homedir(), '~')}`);
        return;
    }
    if (newHasData) {
        await vscode.window.showWarningMessage(
            `⚠️ 새 위치(${path.basename(newDir)})에 이미 파일이 있어서 자동 이동을 건너뜁니다. 옛 폴더(${oldDir.replace(os.homedir(), '~')})의 내용을 수동으로 합쳐주세요.`,
            { modal: false }
        );
        return;
    }
    const move = await vscode.window.showInformationMessage(
        `옛 회사 폴더 내용을 새 위치로 이동할까요?\n\n옛: ${oldDir.replace(os.homedir(), '~')}\n새: ${newDir.replace(os.homedir(), '~')}`,
        { modal: true },
        '이동',
        '나중에'
    );
    if (move === '이동') {
        try {
            fs.mkdirSync(newDir, { recursive: true });
            for (const entry of fs.readdirSync(oldDir)) {
                fs.renameSync(path.join(oldDir, entry), path.join(newDir, entry));
            }
            try { fs.rmdirSync(oldDir); } catch { /* maybe non-empty leftovers, ignore */ }
            await vscode.window.showInformationMessage(`✅ 이동 완료: ${newDir.replace(os.homedir(), '~')}`);
        } catch (e: any) {
            await vscode.window.showErrorMessage(`이동 실패: ${e?.message || e}`);
        }
    } else {
        await vscode.window.showInformationMessage(`✅ 위치만 바뀜. 옛 데이터는 ${oldDir.replace(os.homedir(), '~')} 에 그대로 남아있습니다.`);
    }
}

// ============================================================
// Knowledge Graph Builder — REAL connections (not random!)
// Parses [[wikilinks]], markdown links, and #tags from .md files
// to build a true semantic graph of the user's brain.
// ============================================================
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
export interface BrainGraph {
    nodes: BrainNode[];
    links: BrainLink[];
    tags: string[];        // all unique tags found
}

export function buildKnowledgeGraph(brainDir: string): BrainGraph {
    const nodes: BrainNode[] = [];
    const nodeByPath = new Map<string, BrainNode>();
    const nodeByBasename = new Map<string, BrainNode[]>();
    const links: BrainLink[] = [];
    const tagSet = new Set<string>();
    let scanned = 0;

    if (!fs.existsSync(brainDir)) return { nodes, links, tags: [] };

    // --- Pass 1: collect all .md files as nodes ---
    function walk(dir: string) {
        if (scanned >= 1000) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries) {
            if (e.name.startsWith('.') || e.name === 'node_modules') continue;
            if (COMPANY_INTERNAL_DIRS.has(e.name)) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { walk(full); continue; }
            if (!e.isFile() || !full.endsWith('.md')) continue;
            const rel = path.relative(brainDir, full);
            const base = e.name.replace(/\.md$/i, '');
            const parts = rel.split(path.sep);
            const folder = parts.length > 1 ? parts[0] : '_root';
            let mtime = 0;
            try { mtime = fs.statSync(full).mtimeMs; } catch { /* ignore */ }
            const node: BrainNode = { id: rel, name: base, folder, tags: [], incoming: 0, outgoing: 0, mtime };
            nodes.push(node);
            nodeByPath.set(rel, node);
            const list = nodeByBasename.get(base.toLowerCase()) || [];
            list.push(node);
            nodeByBasename.set(base.toLowerCase(), list);
            scanned++;
        }
    }
    walk(brainDir);

    // --- Pass 2: parse each file for links + tags ---
    const wikilinkRe = /\[\[([^\]\n|#]+)(?:[#|][^\]\n]*)?\]\]/g;
    const mdlinkRe = /\[[^\]]+\]\(([^)]+\.md)\)/gi;
    const tagRe = /(?:^|[\s>(])#([A-Za-z가-힣0-9_-]{2,40})/g;

    function resolveLink(target: string, fromNode: BrainNode): BrainNode | null {
        const cleaned = target.trim().replace(/^\.\//, '').replace(/\\/g, '/');
        // Try exact relative path match (with or without .md)
        const exact = cleaned.endsWith('.md') ? cleaned : cleaned + '.md';
        if (nodeByPath.has(exact)) return nodeByPath.get(exact)!;
        // Try resolved relative to source file's folder
        const fromDir = path.dirname(fromNode.id);
        const joined = path.normalize(path.join(fromDir, exact));
        if (nodeByPath.has(joined)) return nodeByPath.get(joined)!;
        // Fall back to basename match (Obsidian style)
        const base = path.basename(cleaned, '.md').toLowerCase();
        const matches = nodeByBasename.get(base) || [];
        if (matches.length === 0) return null;
        // Prefer same-folder match if multiple
        if (matches.length > 1) {
            const sameFolder = matches.find(m => path.dirname(m.id) === fromDir);
            if (sameFolder) return sameFolder;
        }
        return matches[0];
    }

    for (const node of nodes) {
        let content: string;
        try { content = fs.readFileSync(path.join(brainDir, node.id), 'utf-8').slice(0, 200_000); }
        catch { continue; }

        // Wikilinks → real edges
        let m: RegExpExecArray | null;
        wikilinkRe.lastIndex = 0;
        while ((m = wikilinkRe.exec(content)) !== null) {
            const target = resolveLink(m[1], node);
            if (target && target.id !== node.id) {
                links.push({ source: node.id, target: target.id, type: 'wikilink' });
                node.outgoing++;
                target.incoming++;
            }
        }

        // Markdown links → real edges
        mdlinkRe.lastIndex = 0;
        while ((m = mdlinkRe.exec(content)) !== null) {
            // Skip external URLs
            if (/^https?:\/\//i.test(m[1])) continue;
            const target = resolveLink(m[1], node);
            if (target && target.id !== node.id) {
                links.push({ source: node.id, target: target.id, type: 'mdlink' });
                node.outgoing++;
                target.incoming++;
            }
        }

        // Tags
        tagRe.lastIndex = 0;
        const localTags = new Set<string>();
        while ((m = tagRe.exec(content)) !== null) {
            localTags.add(m[1]);
        }
        node.tags = [...localTags];
        localTags.forEach(t => tagSet.add(t));
    }

    // --- Pass 2.5: Semantic Implicit Links (Brain Pattern Recognition) ---
    // If a document mentions another document's exact basename (and it's >= 2 chars), create a semantic link.
    const validBasenames = nodes.filter(n => n.name.length >= 2);
    for (const node of nodes) {
        let content: string;
        try { content = fs.readFileSync(path.join(brainDir, node.id), 'utf-8').slice(0, 100_000); }
        catch { continue; }
        // Fast plain-text match
        const contentLower = content.toLowerCase();
        for (const target of validBasenames) {
            if (target.id === node.id) continue;
            // Prevent overly broad matching (e.g. matching "it" or "at") by checking word boundaries
            // We use simple substring check first for performance, then regex for word boundary
            const targetLower = target.name.toLowerCase();
            if (contentLower.includes(targetLower)) {
                // Confirm with boundaries if alphabet
                const isAlpha = /^[a-z]+$/.test(targetLower);
                if (isAlpha) {
                    const regex = new RegExp(`\\b${targetLower}\\b`, 'i');
                    if (!regex.test(content)) continue;
                }
                links.push({ source: node.id, target: target.id, type: 'semantic' });
                // We don't increment incoming/outgoing for semantic links to keep sizes strictly based on explicit structure
            }
        }
    }

    // --- Pass 3: tag co-occurrence edges (cap to top 8 tags to avoid explosion) ---
    const tagToNodes = new Map<string, BrainNode[]>();
    for (const node of nodes) {
        for (const t of node.tags) {
            const list = tagToNodes.get(t) || [];
            list.push(node);
            tagToNodes.set(t, list);
        }
    }
    const topTags = [...tagToNodes.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 8);
    for (const [, nodesWithTag] of topTags) {
        if (nodesWithTag.length < 2 || nodesWithTag.length > 25) continue;
        for (let i = 0; i < nodesWithTag.length; i++) {
            for (let j = i + 1; j < nodesWithTag.length; j++) {
                links.push({ source: nodesWithTag[i].id, target: nodesWithTag[j].id, type: 'tag' });
            }
        }
    }

    // De-duplicate links (a→b and b→a counted once)
    const seen = new Set<string>();
    const dedup: BrainLink[] = [];
    for (const l of links) {
        const key = l.source < l.target ? `${l.source}|${l.target}|${l.type}` : `${l.target}|${l.source}|${l.type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        dedup.push(l);
    }

    return { nodes, links: dedup, tags: [...tagSet] };
}

async function showBrainNetwork(_context: vscode.ExtensionContext) {
    let panel: vscode.WebviewPanel | undefined;
    try {
        const assetsRoot = vscode.Uri.file(path.join(_context.extensionPath, 'assets'));
        panel = vscode.window.createWebviewPanel(
            'brainTopology',
            'Neural Construct (Brain)',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [assetsRoot] }
        );

        // Hook this panel into the chat provider's thinking-event broadcast,
        // so AI search activity pulses on this graph too — not just on the
        // separate Thinking Mode panel.
        _activeChatProvider?.registerExternalGraphPanel(panel);

        const brainDir = _getBrainDir();
        const graph = buildKnowledgeGraph(brainDir);
        const isEmpty = graph.nodes.length === 0;

        // Handle messages from webview (e.g., open file requests)
        panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'openFile' && typeof msg.id === 'string') {
                const safe = safeResolveInside(brainDir, msg.id);
                if (safe && fs.existsSync(safe)) {
                    const doc = await vscode.workspace.openTextDocument(safe);
                    vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
                }
            }
        });

        const graphJson = JSON.stringify({
            nodes: graph.nodes.map(n => ({
                id: n.id, name: n.name, folder: n.folder, tags: n.tags,
                connections: n.incoming + n.outgoing
            })),
            links: graph.links
        });

        const forceGraphSrc = panel.webview.asWebviewUri(
            vscode.Uri.file(path.join(_context.extensionPath, 'assets', 'force-graph.min.js'))
        ).toString();
        const html = _RENDER_GRAPH_HTML(graphJson, isEmpty, forceGraphSrc, panel.webview.cspSource);
        // Defensive: if HTML somehow comes back falsy, surface that explicitly
        // instead of letting the webview coerce it into the literal string "null".
        if (typeof html !== 'string' || !html) {
            throw new Error('_RENDER_GRAPH_HTML returned non-string: ' + typeof html);
        }
        panel.webview.html = html;
    } catch (err: any) {
        const detail = err?.stack || err?.message || String(err);
        console.error('showBrainNetwork failed:', detail);
        vscode.window.showErrorMessage('지식 네트워크 열기 실패: ' + (err?.message || String(err)));
        if (panel) {
            const safe = String(detail).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'} as any)[c]);
            panel.webview.html = '<!DOCTYPE html><html><body style="background:#000;color:#B8B8C2;font-family:-apple-system,SF Pro Display,sans-serif;padding:40px;line-height:1.55"><div style="font-family:SF Mono,monospace;font-size:10px;letter-spacing:3px;color:rgba(0,255,65,.55);text-transform:uppercase;margin-bottom:18px">CONNECT · AI</div><h2 style="color:#00FF41;margin-top:0;text-shadow:0 0 14px rgba(0,255,65,.3)">⚠️ 지식 네트워크 로드 실패</h2><div style="color:#9090A0;font-size:13px;margin-bottom:14px">아래 에러 메시지를 그대로 알려주세요.</div><pre style="color:#B8B8C2;background:#0a0d0a;border:1px solid rgba(0,255,65,.15);padding:14px;border-radius:10px;overflow:auto;font-size:12px;font-family:SF Mono,JetBrains Mono,monospace">' + safe + '</pre></body></html>';
        }
    }
}

/** Returns the full graph webview HTML. Reused by showBrainNetwork + ThinkingPanel. */
export function _RENDER_GRAPH_HTML(graphJson: string, isEmpty: boolean, forceGraphSrc: string, cspSource: string): string {
    // NOTE: force-graph.min.js is loaded as an external script (not inlined).
    // Inlining via template literal corrupts the bundle because the minified
    // library contains `${...}` sequences that get evaluated as template parts.
    return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource} 'unsafe-inline'; font-src ${cspSource};">
  <title>Agent OS — 지식 네트워크</title>
  <style>
    body { margin: 0; padding: 0; background: #131419; overflow: hidden; width: 100vw; height: 100vh; font-family: 'SF Pro Display', -apple-system, sans-serif; color: #d8d9de; }
    /* Subtle vignette behind the canvas — z-index -1 so it never obscures nodes */
    body::after { content: ''; position: fixed; inset: 0; pointer-events: none; z-index: -1;
      background: radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,.55) 100%); }
    #ui-layer { position: absolute; top: 20px; left: 24px; z-index: 10; pointer-events: none; max-width: 60%; }
    #ui-layer h1 { font-size: 22px; margin: 0 0 4px 0; font-weight: 700; letter-spacing: -0.4px; color: #e8e9ee; }
    #ui-layer h1 span { color: #5DE0E6; text-shadow: 0 0 14px rgba(93,224,230,.45); }
    #stats { color: #6c6e78; font-family: 'SF Mono', monospace; font-size: 11px; margin-top: 2px; letter-spacing: .2px; }
    #legend { position: absolute; top: 20px; right: 24px; z-index: 10; background: rgba(20,21,28,.78); border: 1px solid rgba(255,255,255,.06); border-radius: 12px; padding: 12px 14px; font-size: 11px; backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); box-shadow: 0 8px 32px rgba(0,0,0,.4); }
    #legend .row { display: flex; align-items: center; gap: 8px; margin: 4px 0; color: #9094a0; }
    #legend .swatch { width: 18px; height: 2px; border-radius: 1px; }
    #legend .row.synapse .swatch { box-shadow: 0 0 6px #5DE0E6; }
    #empty { position: absolute; inset: 0; display: ${isEmpty ? 'flex' : 'none'}; flex-direction: column; align-items: center; justify-content: center; color: #555; font-size: 14px; gap: 10px; pointer-events: none; }
    #empty .big { font-size: 22px; color: #888; }
    #tooltip { position: absolute; pointer-events: none; background: rgba(20,21,28,.95); border: 1px solid rgba(93,224,230,.28); border-radius: 10px; padding: 10px 13px; font-size: 12px; color: #e0e2e8; box-shadow: 0 8px 32px rgba(93,224,230,.12), 0 4px 12px rgba(0,0,0,.5); display: none; z-index: 20; max-width: 260px; backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); }
    #tooltip .t-name { font-weight: 700; color: #5DE0E6; margin-bottom: 4px; letter-spacing: .1px; }
    #tooltip .t-meta { color: #7c7f8a; font-size: 10px; font-family: 'SF Mono', monospace; }
    #tooltip .t-tags { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px; }
    #tooltip .t-tag { background: rgba(93,224,230,.08); color: #5DE0E6; padding: 2px 7px; border-radius: 8px; font-size: 9px; border: 1px solid rgba(93,224,230,.2); }
    #graph { position: absolute; inset: 0; width: 100vw; height: 100vh; z-index: 0; }
    canvas { cursor: grab; }
    canvas:active { cursor: grabbing; }
    /* Search/filter bar — toggle with the slash key */
    #search-bar { position: absolute; top: 64px; left: 24px; z-index: 12;
      background: rgba(20,21,28,.92); border: 1px solid rgba(93,224,230,.32);
      border-radius: 10px; padding: 6px 10px;
      display: none; align-items: center; gap: 8px;
      backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
      box-shadow: 0 8px 32px rgba(0,0,0,.4), 0 0 16px rgba(93,224,230,.08);
      min-width: 260px; max-width: 380px; }
    #search-bar.active { display: flex; animation: searchSlideIn .25s cubic-bezier(.16,1,.3,1); }
    @keyframes searchSlideIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
    #search-input { background: transparent; border: 0; outline: 0;
      color: #e8e9ee; font-size: 13px; font-family: 'SF Pro Display', -apple-system, sans-serif;
      flex: 1; padding: 4px 0; min-width: 0; }
    #search-input::placeholder { color: #5a5d68; }
    #search-count { color: #5DE0E6; font-size: 11px; font-family: 'SF Mono', monospace; white-space: nowrap; }
    #search-count.zero { color: #FFB266; }
    /* Legend folder chips + toggles */
    #legend .folders { margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,.06); display: flex; flex-direction: column; gap: 3px; max-height: 180px; overflow-y: auto; }
    #legend .folder-row { display: flex; align-items: center; gap: 6px; font-size: 10.5px; color: #9094a0; }
    #legend .folder-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    #legend .folder-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #legend .folder-count { color: #5a5d68; font-family: 'SF Mono', monospace; font-size: 9px; }
    #legend .toggle-row { margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,.06); display: flex; align-items: center; gap: 8px; font-size: 11px; color: #9094a0; cursor: pointer; user-select: none; }
    #legend .toggle-row:hover { color: #d8d9de; }
    #legend .toggle-row .switch { width: 22px; height: 12px; border-radius: 7px; background: #2a2a30; position: relative; transition: background .2s; flex-shrink: 0; }
    #legend .toggle-row .switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 8px; height: 8px; border-radius: 50%; background: #888; transition: left .2s, background .2s; }
    #legend .toggle-row.on .switch { background: rgba(93,224,230,.4); }
    #legend .toggle-row.on .switch::after { left: 12px; background: #5DE0E6; }
    /* Thinking Mode — neural HUD */
    #thinking-overlay { position: absolute; bottom: 28px; left: 50%; transform: translateX(-50%); z-index: 15;
      background: linear-gradient(180deg, rgba(18,22,32,.94), rgba(12,15,22,.92));
      border: 1px solid rgba(93,224,230,.30); border-radius: 16px;
      padding: 16px 22px 14px; font-size: 13px; color: #e0e2e8;
      backdrop-filter: blur(20px) saturate(140%); -webkit-backdrop-filter: blur(20px) saturate(140%);
      box-shadow: 0 16px 56px rgba(0,0,0,.55), 0 0 0 1px rgba(93,224,230,.06) inset, 0 24px 64px rgba(93,224,230,.10);
      display: none; min-width: 360px; max-width: 620px; overflow: hidden;
    }
    #thinking-overlay::before { content:''; position:absolute; top:0; left:0; right:0; height:1px;
      background: linear-gradient(90deg, transparent, rgba(93,224,230,.65), transparent);
      animation: scanLine 2.4s ease-in-out infinite;
    }
    @keyframes scanLine { 0% { transform: translateX(-30%); opacity: 0; } 50% { opacity: 1; } 100% { transform: translateX(30%); opacity: 0; } }
    #thinking-overlay.active { display: block; animation: slideUp .5s cubic-bezier(.16,1,.3,1); }
    @keyframes slideUp { from { opacity: 0; transform: translate(-50%, 24px); } to { opacity: 1; transform: translate(-50%, 0); } }
    #thinking-overlay .phases { display: flex; flex-direction: column; gap: 2px; position: relative; }
    /* Vertical connector line linking the three phase dots */
    #thinking-overlay .phases::before { content: ''; position: absolute;
      left: 9px; top: 14px; bottom: 14px; width: 1px;
      background: linear-gradient(180deg, rgba(93,224,230,.10), rgba(255,178,102,.10));
    }
    #thinking-overlay .phase { display: flex; align-items: center; gap: 12px; padding: 5px 0; opacity: .38;
      transition: opacity .35s ease, color .35s ease, transform .35s ease; font-size: 12.5px; letter-spacing: .1px;
      position: relative;
    }
    #thinking-overlay .phase .icon {
      width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center;
      background: rgba(40,44,56,.7); border-radius: 50%;
      box-shadow: 0 0 0 1px rgba(255,255,255,.06) inset;
      font-size: 11px; flex-shrink: 0; transition: background .35s ease, box-shadow .35s ease, transform .35s ease;
      position: relative; z-index: 1;
    }
    #thinking-overlay .phase .text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #thinking-overlay .phase.active { opacity: 1; color: #5DE0E6; }
    #thinking-overlay .phase.active .icon {
      background: radial-gradient(circle, rgba(93,224,230,.45), rgba(93,224,230,.10));
      box-shadow: 0 0 0 1px rgba(93,224,230,.55) inset, 0 0 14px rgba(93,224,230,.55);
      animation: phasePulse 1.4s ease-in-out infinite;
    }
    @keyframes phasePulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.08); } }
    #thinking-overlay .phase.done { opacity: .8; color: #FFB266; }
    #thinking-overlay .phase.done .icon {
      background: radial-gradient(circle, rgba(255,178,102,.30), rgba(255,178,102,.05));
      box-shadow: 0 0 0 1px rgba(255,178,102,.40) inset;
    }
    #thinking-overlay .answer-preview { margin-top: 12px; padding: 10px 12px;
      background: rgba(93,224,230,.04); border: 1px solid rgba(93,224,230,.10); border-radius: 8px;
      font-size: 11.5px; color: #b8bac4; max-height: 64px; overflow: hidden; line-height: 1.55;
      font-family: 'SF Mono', 'JetBrains Mono', monospace; letter-spacing: .15px;
    }
    body.thinking::before { content: ''; position: absolute; inset: 0;
      background: radial-gradient(ellipse at center, rgba(93,224,230,.07), transparent 60%);
      pointer-events: none; z-index: 1; animation: thinkingPulse 3.2s ease-in-out infinite;
    }
    @keyframes thinkingPulse { 0%, 100% { opacity: .45; } 50% { opacity: 1; } }
  </style>
  <script src="${forceGraphSrc}"></script>
</head>
<body>
  <div id="ui-layer">
    <h1>✦ <span id="titleSpan">지식 네트워크</span></h1>
    <p id="stats">로딩 중...</p>
  </div>
  <div id="thinking-overlay">
    <div class="phases">
      <div class="phase" id="phase-context"><span class="icon">📂</span><span class="text">컨텍스트 모으는 중...</span></div>
      <div class="phase" id="phase-brain"><span class="icon">🧠</span><span class="text">관련 노트 찾는 중...</span></div>
      <div class="phase" id="phase-answer"><span class="icon">✍️</span><span class="text">답변 생성 중...</span></div>
    </div>
    <div class="answer-preview" id="answer-preview" style="display:none"></div>
  </div>
  <div id="legend">
    <div class="folders" id="folders-list"></div>
  </div>
  <div id="empty">
    <div class="big">📂 아직 지식이 없어요</div>
    <div>지식 폴더에 .md 파일을 넣고 다시 열어주세요</div>
    <div style="font-size:10px;color:#444">팁: <code style="background:#1a1a1a;padding:2px 6px;border-radius:4px">[[다른노트]]</code> 형식으로 링크하면 자동 연결됩니다</div>
  </div>
  <div id="search-bar">
    <span style="color:#5DE0E6;font-size:13px">⌕</span>
    <input id="search-input" type="text" placeholder="이름·태그·폴더 검색  (ESC로 닫기)" autocomplete="off" spellcheck="false" />
    <span id="search-count"></span>
  </div>
  <div id="graph"></div>
  <div id="tooltip"></div>
  <script>
    const vscode = acquireVsCodeApi();
    const data = ${graphJson};
    const tooltip = document.getElementById('tooltip');

    // Folder palette — Obsidian-style desaturated tones, optimized for dark canvas.
    const PALETTE = ['#7DA8E6','#8FD3A8','#E89B6E','#C28BE5','#E5C07B','#7FCBC0','#E68FB0','#A8B2D1','#9DC4A0','#D9A89B'];
    const folders = [...new Set(data.nodes.map(n => n.folder))].sort();
    const folderColor = {};
    folders.forEach((f, i) => { folderColor[f] = PALETTE[i % PALETTE.length]; });

    // Edge color by type — softer, more "neural" (cyan synapse / lilac bridge / faint tag mist)
    const EDGE_COLOR = {
      wikilink: 'rgba(125,200,232,0.55)',
      mdlink:   'rgba(168,155,217,0.40)',
      tag:      'rgba(180,180,200,0.10)',
      semantic: 'rgba(93,224,230,0.15)' // Faint cyan for implicit brain connections
    };
    const EDGE_WIDTH = { wikilink: 1.2, mdlink: 0.9, tag: 0.4, semantic: 0.6 };
    // Active synapse color used during thinking
    const SYNAPSE = '#5DE0E6';   // electric cyan — "fired" feeling
    const TRAIL   = '#FFB266';   // warm amber — "this knowledge was used"

    document.getElementById('stats').textContent =
      data.nodes.length + ' 지식 · ' + data.links.length + ' 연결 · ' + folders.length + ' 폴더';

    // ── Folder chip list in legend (informational; folder→color mapping) ──
    (() => {
      const el = document.getElementById('folders-list');
      if (!el) return;
      const counts = {};
      data.nodes.forEach(n => { counts[n.folder] = (counts[n.folder] || 0) + 1; });
      folders.forEach(f => {
        const row = document.createElement('div');
        row.className = 'folder-row';
        const dot = document.createElement('div');
        dot.className = 'folder-dot';
        dot.style.background = folderColor[f] || '#888';
        const name = document.createElement('div');
        name.className = 'folder-name';
        name.textContent = f || '/';
        const count = document.createElement('div');
        count.className = 'folder-count';
        count.textContent = counts[f] || 0;
        row.appendChild(dot); row.appendChild(name); row.appendChild(count);
        el.appendChild(row);
      });
    })();

    // ── Orphan-hide toggle ──
    let hideOrphans = false;
    const orphanToggleEl = document.getElementById('toggle-orphans');
    orphanToggleEl?.addEventListener('click', () => {
      hideOrphans = !hideOrphans;
      orphanToggleEl.classList.toggle('on', hideOrphans);
      // Trigger a layout/render refresh
      Graph.nodeVisibility(Graph.nodeVisibility());
    });

    let hoverNode = null;
    let highlightNodes = new Set();
    let highlightLinks = new Set();

    function applyHighlight(node) {
      highlightNodes = new Set();
      highlightLinks = new Set();
      if (!node) return;
      highlightNodes.add(node.id);
      data.links.forEach(l => {
        const sId = (l.source && l.source.id) || l.source;
        const tId = (l.target && l.target.id) || l.target;
        if (sId === node.id || tId === node.id) {
          highlightLinks.add(l);
          highlightNodes.add(sId);
          highlightNodes.add(tId);
        }
      });
    }

    // Compute node radius — Obsidian-style hierarchy + Recency (Hotness)
    // Hubs (many connections) get noticeably larger.
    // Recently modified nodes get a "hotness" bump.
    const now = Date.now();
    function nodeRadius(n) {
      const c = n.connections;
      let r = 3.5;
      if (c > 0 && c <= 2) r = 5.5;                                  // leaf
      else if (c > 2 && c <= 5) r = 8 + Math.log2(c) * 0.8;          // mid
      else if (c > 5) r = Math.min(22, 11 + Math.log2(c) * 2.2);     // hub
      
      // Memory decay / Hotness: files modified in the last 24 hours get slightly larger
      if (n.mtime && (now - n.mtime < 86400000)) {
         // linearly scale bump based on recency within 24 hours
         const ageRatio = (now - n.mtime) / 86400000;
         r += 2 * (1 - ageRatio);
      }
      return r;
    }
    function isHub(n) { return n.connections > 5; }
    // Precompute neighbor map — used for synapse highlights when a node is "fired"
    const neighborsOf = {};
    data.nodes.forEach(n => { neighborsOf[n.id] = new Set(); });
    data.links.forEach(l => {
      const sId = (l.source && l.source.id) || l.source;
      const tId = (l.target && l.target.id) || l.target;
      if (neighborsOf[sId]) neighborsOf[sId].add(tId);
      if (neighborsOf[tId]) neighborsOf[tId].add(sId);
    });

    // ── Thinking-mode state — must be declared BEFORE Graph creation
    // because force-graph invokes linkColor/linkDirectionalParticles
    // synchronously during .graphData() and would otherwise hit TDZ.
    const thinkingActive = new Set();          // node ids currently being read (electric cyan)
    const thinkingAdjacent = new Set();        // 1-hop neighbors of active nodes (faint glow)
    const thinkingDoneOrder = new Map();       // node id → 1-based usage index (warm amber trail)
    let thinkingDoneCounter = 0;
    let thinkPulseTime = 0;
    const nodeById = {};
    data.nodes.forEach(n => { nodeById[n.id] = n; });
    function recomputeAdjacent() {
      thinkingAdjacent.clear();
      thinkingActive.forEach(id => {
        (neighborsOf[id] || new Set()).forEach(n => { if (!thinkingActive.has(n)) thinkingAdjacent.add(n); });
      });
    }
    function markDone(id) {
      if (!thinkingDoneOrder.has(id)) thinkingDoneOrder.set(id, ++thinkingDoneCounter);
    }
    function clearThinkingTrail() {
      thinkingActive.clear();
      thinkingAdjacent.clear();
      thinkingDoneOrder.clear();
      thinkingDoneCounter = 0;
    }

    const Graph = ForceGraph()(document.getElementById('graph'))
      .width(window.innerWidth)
      .height(window.innerHeight)
      .backgroundColor('#0a0a0a')
      .graphData(data)
      .nodeId('id')
      .nodeVal(n => nodeRadius(n) * 0.6)
      .nodeCanvasObject((node, ctx, globalScale) => {
        // (NOTE: this is the base renderer; thinking-mode renderer below overrides it.)
        renderNode(node, ctx, globalScale);
      })
      .nodePointerAreaPaint((node, color, ctx) => {
        const r = nodeRadius(node) + 6;
        ctx.beginPath(); ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
        ctx.fillStyle = color; ctx.fill();
      })
      .linkColor(l => {
        const sId = (l.source && l.source.id) || l.source;
        const tId = (l.target && l.target.id) || l.target;
        const isSynapse = thinkingActive.has(sId) || thinkingActive.has(tId);
        const isTrail   = thinkingDoneOrder.has(sId) && thinkingDoneOrder.has(tId);
        if (isSynapse) return 'rgba(93,224,230,0.85)';
        if (isTrail)   return 'rgba(255,178,102,0.55)';
        if (highlightLinks.size > 0 && !highlightLinks.has(l)) return 'rgba(60,60,70,0.10)';
        return EDGE_COLOR[l.type] || 'rgba(255,255,255,0.08)';
      })
      .linkWidth(l => {
        const sId = (l.source && l.source.id) || l.source;
        const tId = (l.target && l.target.id) || l.target;
        const isSynapse = thinkingActive.has(sId) || thinkingActive.has(tId);
        const isTrail   = thinkingDoneOrder.has(sId) && thinkingDoneOrder.has(tId);
        if (isSynapse) return 2.4;
        if (isTrail)   return 1.6;
        return highlightLinks.has(l) ? (EDGE_WIDTH[l.type] || 1) * 2 : (EDGE_WIDTH[l.type] || 1);
      })
      // Every link breathes a slow particle — synapse-active ones fire faster + brighter
      .linkDirectionalParticles(l => {
        const sId = (l.source && l.source.id) || l.source;
        const tId = (l.target && l.target.id) || l.target;
        if (thinkingActive.has(sId) || thinkingActive.has(tId)) return 4;
        if (l.type === 'wikilink') return 2;
        if (l.type === 'mdlink')   return 1;
        return 0; // tag links stay quiet
      })
      .linkDirectionalParticleWidth(l => {
        const sId = (l.source && l.source.id) || l.source;
        const tId = (l.target && l.target.id) || l.target;
        return (thinkingActive.has(sId) || thinkingActive.has(tId)) ? 2.4 : 1.4;
      })
      .linkDirectionalParticleSpeed(l => {
        const sId = (l.source && l.source.id) || l.source;
        const tId = (l.target && l.target.id) || l.target;
        return (thinkingActive.has(sId) || thinkingActive.has(tId)) ? 0.018 : 0.005;
      })
      .linkDirectionalParticleColor(l => {
        const sId = (l.source && l.source.id) || l.source;
        const tId = (l.target && l.target.id) || l.target;
        if (thinkingActive.has(sId) || thinkingActive.has(tId)) return SYNAPSE;
        return EDGE_COLOR[l.type] || '#7DA8E6';
      })
      .nodeVisibility(n => !(hideOrphans && n.connections === 0))
      .d3VelocityDecay(0.25)
      .warmupTicks(120)
      .cooldownTicks(1200)
      .onNodeHover(node => {
        hoverNode = node || null;
        // Sticky selection / active search win — when either is pinning the
        // highlight set, hover doesn't disturb it (Obsidian-style behavior).
        if (!stickyNode && !(searchActive && searchInput.value)) applyHighlight(hoverNode);
        document.body.style.cursor = node ? 'pointer' : 'grab';
        if (node) {
          tooltip.style.display = 'block';
          const tagsHtml = (node.tags || []).slice(0, 5).map(t => '<span class="t-tag">#' + t + '</span>').join('');
          tooltip.innerHTML =
            '<div class="t-name">' + (node.name || '(이름 없음)') + '</div>' +
            '<div class="t-meta">' + (node.folder || '/') + ' · ' + (node.connections || 0) + '개 연결</div>' +
            (tagsHtml ? '<div class="t-tags">' + tagsHtml + '</div>' : '');
        } else {
          tooltip.style.display = 'none';
        }
      })
      .onNodeRightClick(node => {
        vscode.postMessage({ type: 'openFile', id: node.id });
      });

    // ── Sticky selection (Obsidian signature behavior) ──
    // Single click → pin a node + its 1-hop neighbors as the highlight set
    //                (everything else dims).
    // Same node clicked again → unpin.
    // Different node clicked → repin.
    // Double-click → open file.
    // Background click → unpin.
    let stickyNode = null;
    function pinNode(node) {
      stickyNode = node;
      applyHighlight(node);
    }
    function unpinNode() {
      stickyNode = null;
      applyHighlight(hoverNode);  // fall back to hover state if any
    }

    let lastClick = { id: null, t: 0 };
    Graph.onNodeClick(node => {
      // Click during active search → close the search panel and act as a normal pin
      if (searchActive) closeSearch();
      const now = Date.now();
      if (lastClick.id === node.id && now - lastClick.t < 400) {
        // Double-click on the same node → open file
        vscode.postMessage({ type: 'openFile', id: node.id });
        lastClick = { id: null, t: 0 };
        return;
      }
      lastClick = { id: node.id, t: now };

      if (stickyNode && stickyNode.id === node.id) {
        unpinNode();
      } else {
        pinNode(node);
        Graph.centerAt(node.x, node.y, 600);
        Graph.zoom(3, 800);
      }
    });

    let lastBgClickT = 0;
    Graph.onBackgroundClick(() => {
      const now = Date.now();
      if (now - lastBgClickT < 400) {
        // Background double-click → reset zoom to fit the whole graph
        Graph.zoomToFit(800, 60);
        lastBgClickT = 0;
        return;
      }
      lastBgClickT = now;
      if (searchActive) closeSearch();
      else if (stickyNode) unpinNode();
    });

    // -- Search/filter bar (slash to open, ESC to close) --
    const searchBar = document.getElementById('search-bar');
    const searchInput = document.getElementById('search-input');
    const searchCount = document.getElementById('search-count');
    let searchActive = false;
    function openSearch() {
      searchActive = true;
      searchBar.classList.add('active');
      searchInput.focus();
      searchInput.select();
    }
    function closeSearch() {
      searchActive = false;
      searchBar.classList.remove('active');
      searchInput.value = '';
      searchCount.textContent = '';
      searchCount.classList.remove('zero');
      // Restore prior state (sticky pin or current hover)
      applyHighlight(stickyNode || hoverNode);
    }
    function runSearch(q) {
      q = q.trim().toLowerCase();
      if (!q) {
        searchCount.textContent = '';
        searchCount.classList.remove('zero');
        applyHighlight(stickyNode || hoverNode);
        return;
      }
      const matches = new Set();
      data.nodes.forEach(n => {
        const hay = ((n.name || '') + ' ' + (n.folder || '') + ' ' +
                     (n.tags || []).map(t => '#' + t).join(' ')).toLowerCase();
        if (hay.includes(q)) matches.add(n.id);
      });
      searchCount.textContent = matches.size + '개';
      searchCount.classList.toggle('zero', matches.size === 0);
      if (matches.size === 0) {
        // Don't dim the whole graph for zero results — feels punishing
        highlightNodes = new Set(); highlightLinks = new Set();
        return;
      }
      highlightNodes = new Set(matches);
      highlightLinks = new Set();
      data.links.forEach(l => {
        const sId = (l.source && l.source.id) || l.source;
        const tId = (l.target && l.target.id) || l.target;
        if (matches.has(sId) && matches.has(tId)) highlightLinks.add(l);
      });
    }
    searchInput.addEventListener('input', () => runSearch(searchInput.value));
    document.addEventListener('keydown', (e) => {
      if (e.target === searchInput) {
        if (e.key === 'Escape') { closeSearch(); e.preventDefault(); }
        return;
      }
      if (e.key === '/' && !searchActive) {
        e.preventDefault();
        openSearch();
      } else if (e.key === 'Escape' && searchActive) {
        closeSearch();
      }
    });

    // Force tuning: hubs repel more, semantic links are gentle.
    const sparseFactor = Math.max(0.4, Math.min(1, data.links.length / Math.max(1, data.nodes.length)));
    Graph.d3Force('charge').strength(n => -50 - 25 * sparseFactor - (isHub(n) ? 60 : 0));
    Graph.d3Force('link')
      .distance(l => l.type === 'tag' ? 90 : l.type === 'semantic' ? 70 : l.type === 'mdlink' ? 50 : 36)
      .strength(l => l.type === 'tag' ? 0.15 : l.type === 'semantic' ? 0.25 : l.type === 'mdlink' ? 0.5 : 0.85);
    if (typeof window.d3 !== 'undefined' && window.d3.forceCenter) {
      Graph.d3Force('center', window.d3.forceCenter(0, 0).strength(0.06));
    }

    // Tooltip follow mouse
    document.addEventListener('mousemove', (e) => {
      if (tooltip.style.display === 'block') {
        tooltip.style.left = (e.clientX + 14) + 'px';
        tooltip.style.top = (e.clientY + 14) + 'px';
      }
    });

    // Initial framing: the force simulation needs time to spread nodes from
    // their origin spawn before zoomToFit can frame anything meaningful. Doing
    // it too early frames a tiny clump → zooms way in → nodes then explode
    // outward off-screen. We wait for the engine to actually settle, with one
    // safety fit as a fallback if cooldown is unusually long.
    const zoomPad = data.nodes.length < 10 ? 120 : data.nodes.length < 30 ? 90 : 60;
    let _initialFitDone = false;
    function _initialFit(duration) {
      if (_initialFitDone) return;
      _initialFitDone = true;
      try { Graph.zoomToFit(duration, zoomPad); } catch (e) {}
      const ts = document.getElementById('titleSpan'); if (ts) ts.innerText = '지식 네트워크 · LIVE';
    }
    // Authoritative fit — fires once the layout has fully settled.
    Graph.onEngineStop(() => _initialFit(900));
    // Safety net: if the engine never reports stop (rare, but possible with
    // very large graphs or external re-heats), frame what we have at ~2.5s.
    setTimeout(() => _initialFit(1100), 2500);

    window.addEventListener('resize', () => {
      Graph.width(window.innerWidth).height(window.innerHeight);
    });

    // ============================================================
    // 🎬 THINKING MODE — receive realtime events from chat extension
    // ============================================================
    const thinkingOverlay = document.getElementById('thinking-overlay');
    const phaseContext = document.getElementById('phase-context');
    const phaseBrain = document.getElementById('phase-brain');
    const phaseAnswer = document.getElementById('phase-answer');
    const answerPreview = document.getElementById('answer-preview');

    // Map basename → node for fast lookup when AI sends "read this brain note"
    const nodesByBasename = {};
    data.nodes.forEach(n => {
      const k = n.name.toLowerCase();
      nodesByBasename[k] = nodesByBasename[k] || [];
      nodesByBasename[k].push(n);
    });
    function findNodeForReadRequest(req) {
      if (typeof req !== 'string' || !req) return null;
      // Try by exact id first
      const direct = data.nodes.find(n => n.id === req || n.id === req + '.md');
      if (direct) return direct;
      // Then by basename match
      const base = (req.split(/[\\\\/]/).pop() || '').replace(/\\.md$/i, '').toLowerCase();
      const matches = nodesByBasename[base];
      return matches && matches.length > 0 ? matches[0] : null;
    }

    // (thinkingActive / thinkingAdjacent / thinkingDone / recomputeAdjacent
    //  were hoisted above the Graph constructor to avoid TDZ when force-graph
    //  invokes link callbacks synchronously during .graphData().)

    // Single canonical renderer — Obsidian + brain look, thinking effects layered on top.
    function renderNode(node, ctx, globalScale) {
      // Skip the very first ticks before force-graph has assigned coords —
      // createRadialGradient throws if any value is non-finite.
      if (!isFinite(node.x) || !isFinite(node.y)) return;
      const baseR = Math.max(1, nodeRadius(node) || 0);
      const isHL = highlightNodes.size === 0 || highlightNodes.has(node.id);
      const isActive = thinkingActive.has(node.id);
      const isAdj    = thinkingAdjacent.has(node.id);
      const isDone   = thinkingDoneOrder.has(node.id);
      const isOrphan = node.connections === 0;
      const hub      = isHub(node);
      const color    = folderColor[node.folder] || '#9aa0a6';

      // ── 1. Active synapse halo: pulsing electric cyan ──
      if (isActive) {
        const pulse = 0.5 + 0.5 * Math.sin(thinkPulseTime * 0.09);
        const haloR = baseR * (2.6 + pulse * 0.9);
        const grad = ctx.createRadialGradient(node.x, node.y, baseR, node.x, node.y, haloR);
        grad.addColorStop(0, 'rgba(93,224,230,0.55)');
        grad.addColorStop(0.5, 'rgba(93,224,230,0.20)');
        grad.addColorStop(1,  'rgba(93,224,230,0)');
        ctx.beginPath(); ctx.arc(node.x, node.y, haloR, 0, 2 * Math.PI);
        ctx.fillStyle = grad; ctx.fill();
      }

      // ── 2. Adjacent ghost glow: faint cyan whisper ──
      if (isAdj && !isActive) {
        ctx.beginPath(); ctx.arc(node.x, node.y, baseR * 1.8, 0, 2 * Math.PI);
        const g = ctx.createRadialGradient(node.x, node.y, baseR * 0.6, node.x, node.y, baseR * 1.8);
        g.addColorStop(0, 'rgba(93,224,230,0.22)');
        g.addColorStop(1, 'rgba(93,224,230,0)');
        ctx.fillStyle = g; ctx.fill();
      }

      // ── 3. Ambient glow for hubs / done-trail ──
      const r = isHL ? baseR : baseR * 0.7;
      const ambientColor = isActive ? SYNAPSE : isDone ? TRAIL : color;
      const ambientStrength = isActive ? 'cc' : isDone ? '99' : (hub && isHL ? '88' : (isHL ? '55' : '22'));
      ctx.beginPath(); ctx.arc(node.x, node.y, r + (hub ? 5 : 3), 0, 2 * Math.PI);
      const ambient = ctx.createRadialGradient(node.x, node.y, r * 0.4, node.x, node.y, r + (hub ? 5 : 3));
      ambient.addColorStop(0, ambientColor + ambientStrength);
      ambient.addColorStop(1, ambientColor + '00');
      ctx.fillStyle = ambient; ctx.fill();

      // ── 4. Solid core ──
      ctx.beginPath(); ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
      if (isActive) {
        ctx.shadowBlur = 24; ctx.shadowColor = SYNAPSE;
        ctx.fillStyle = SYNAPSE; ctx.fill();
      } else if (isDone) {
        ctx.shadowBlur = 12; ctx.shadowColor = TRAIL;
        ctx.fillStyle = TRAIL; ctx.fill();
      } else if (isOrphan) {
        ctx.fillStyle = '#0a0a0a'; ctx.fill();
        ctx.lineWidth = 1; ctx.strokeStyle = color + (isHL ? 'a0' : '50'); ctx.stroke();
      } else if (hub && isHL) {
        ctx.shadowBlur = 14; ctx.shadowColor = color;
        ctx.fillStyle = color; ctx.fill();
      } else {
        ctx.fillStyle = isHL ? color : color + '88'; ctx.fill();
      }
      ctx.shadowBlur = 0;

      // ── 5. Zoom-aware label ──
      // Obsidian behavior: only hubs always show; mids appear as you zoom in;
      // leaves only at high zoom. Active/done nodes always show their name.
      const labelMinScale = isActive || isDone ? 0 : hub ? 0 : node.connections >= 2 ? 1.4 : 2.6;
      if (globalScale < labelMinScale) return;

      const fs = isActive || isDone || hub
        ? Math.max(4, Math.min(8, 13 / globalScale + (hub ? 1.5 : 0)))
        : Math.max(3, Math.min(6, 11 / globalScale));
      const fontWeight = isActive ? '700 ' : (hub || isDone) ? '600 ' : '';
      ctx.font = fontWeight + fs + "px -apple-system, 'SF Pro Display', sans-serif";
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';

      const dimAlpha = highlightNodes.size > 0 && !isHL ? '40' : '';
      ctx.fillStyle = isActive ? SYNAPSE
                    : isDone   ? TRAIL
                    : hub      ? '#f0f0f0' + dimAlpha
                    :            '#a0a0a8' + dimAlpha;
      // subtle text shadow for active/hub legibility
      if (isActive || isDone) { ctx.shadowBlur = 6; ctx.shadowColor = isActive ? SYNAPSE : TRAIL; }
      ctx.fillText(node.name || '', node.x, node.y + r + 2);
      ctx.shadowBlur = 0;

      // ── 6. Usage-order index chip on cited nodes (1, 2, 3...) ──
      if (isDone) {
        const idx = thinkingDoneOrder.get(node.id);
        if (idx) {
          const chipR = Math.max(4.5, 6 / globalScale);
          const cx = node.x + r + chipR + 1;
          const cy = node.y - r - 1;
          ctx.beginPath(); ctx.arc(cx, cy, chipR, 0, 2 * Math.PI);
          ctx.fillStyle = TRAIL; ctx.fill();
          ctx.lineWidth = 0.6; ctx.strokeStyle = '#131419'; ctx.stroke();
          ctx.fillStyle = '#131419';
          ctx.font = '700 ' + Math.max(5, 7 / globalScale) + "px -apple-system, sans-serif";
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(String(idx), cx, cy + 0.5);
        }
      }
    }

    // Re-bind renderer (override of the placeholder bound earlier).
    Graph.nodeCanvasObject(renderNode);

    // ── Trail path: dashed amber line connecting cited nodes in usage order ──
    Graph.onRenderFramePost((ctx) => {
      if (thinkingDoneOrder.size < 2) return;
      const ordered = [...thinkingDoneOrder.entries()]
        .sort((a, b) => a[1] - b[1])
        .map(([id]) => nodeById[id])
        .filter(n => n && isFinite(n.x) && isFinite(n.y));
      if (ordered.length < 2) return;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,178,102,0.45)';
      ctx.lineWidth = 1.3;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ordered.forEach((n, i) => {
        if (i === 0) ctx.moveTo(n.x, n.y);
        else ctx.lineTo(n.x, n.y);
      });
      ctx.stroke();
      ctx.restore();
    });

    // Pulse animation tick — drive both thinking pulse and a slow ambient breath.
    setInterval(() => {
      thinkPulseTime++;
      // Force redraw only when there's an active animation to avoid wasted work.
      if (thinkingActive.size > 0 || thinkingAdjacent.size > 0) {
        Graph.nodeRelSize(Graph.nodeRelSize());
      }
    }, 40);

    function setPhase(id, state) {
      const el = document.getElementById('phase-' + id);
      if (!el) return;
      el.classList.remove('active', 'done');
      if (state) el.classList.add(state);
    }

    function showThinkingOverlay() {
      thinkingOverlay.classList.add('active');
      document.body.classList.add('thinking');
    }
    function hideThinkingOverlay() {
      // Keep the thinking trail visible (done nodes stay highlighted) but remove pulse overlay
      document.body.classList.remove('thinking');
      // Auto-hide overlay after a delay so user can see the final state
      setTimeout(() => {
        thinkingOverlay.classList.remove('active');
        thinkingActive.clear();
      }, 6000);
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || !msg.type) return;
      switch (msg.type) {
        case 'thinking_start': {
          showThinkingOverlay();
          phaseContext.querySelector('.text').textContent = '컨텍스트 모으는 중...';
          phaseBrain.querySelector('.text').textContent = '관련 노트 찾는 중...';
          phaseAnswer.querySelector('.text').textContent = '답변 생성 중...';
          setPhase('context', 'active'); setPhase('brain', null); setPhase('answer', null);
          answerPreview.style.display = 'none';
          answerPreview.textContent = '';
          clearThinkingTrail();   // fresh session — drop the previous trail entirely
          break;
        }
        case 'context_done': {
          const summary = (msg.workspace ? '📂 워크스페이스' : '') +
                          (msg.brainCount > 0 ? '  🧠 ' + msg.brainCount + '개 노트' : '') +
                          (msg.web ? '  🌐 인터넷' : '');
          phaseContext.querySelector('.text').textContent = '컨텍스트 모음 완료' + (summary ? ' · ' + summary : '');
          setPhase('context', 'done');
          setPhase('brain', 'active');
          break;
        }
        case 'brain_read': {
          const node = findNodeForReadRequest(msg.note || '');
          if (node) {
            thinkingActive.add(node.id);
            recomputeAdjacent();
            // Camera nudge — gently center on the active node
            try { Graph.centerAt(node.x, node.y, 800); } catch(e){}
            phaseBrain.querySelector('.text').textContent = '🧠 ' + (node.name || '(노트)') + ' 읽는 중...';
            // After 1.4s, mark as done (trail) and remove from active
            setTimeout(() => {
              thinkingActive.delete(node.id);
              markDone(node.id);
              recomputeAdjacent();
            }, 1400);
          } else {
            phaseBrain.querySelector('.text').textContent = '🧠 ' + (msg.note || '...') + ' 검색 중...';
          }
          break;
        }
        case 'url_read': {
          phaseBrain.querySelector('.text').textContent = '🌐 ' + (msg.url || '').slice(0, 60) + '...';
          break;
        }
        case 'answer_start': {
          setPhase('brain', 'done');
          setPhase('answer', 'active');
          answerPreview.style.display = 'block';
          break;
        }
        case 'answer_chunk': {
          // Show last ~120 chars as live preview
          if (typeof msg.text === 'string') {
            answerPreview.textContent = (answerPreview.textContent + msg.text).slice(-180);
          }
          break;
        }
        case 'answer_complete': {
          setPhase('answer', 'done');
          phaseAnswer.querySelector('.text').textContent = '✅ 답변 완료';
          if (Array.isArray(msg.sources)) {
            msg.sources.forEach(req => {
              const node = findNodeForReadRequest(req);
              if (node) markDone(node.id);
            });
          }
          hideThinkingOverlay();
          // Auto-frame the cluster of cited notes — "this answer came from
          // these notes" — so the trail isn't lost in a sea of unrelated nodes.
          // Falls back to full-graph fit when nothing was cited.
          setTimeout(() => {
            if (thinkingDoneOrder.size > 0) {
              try {
                Graph.zoomToFit(1200, 120, n => thinkingDoneOrder.has(n.id));
              } catch(e){ Graph.zoomToFit(1000, 80); }
            } else {
              Graph.zoomToFit(1000, 80);
            }
          }, 400);
          break;
        }
        case 'highlight_node': {
          // External request to focus on a specific note (citation badge click)
          const node = findNodeForReadRequest(msg.note || '');
          if (node) {
            markDone(node.id);
            try { Graph.centerAt(node.x, node.y, 600); Graph.zoom(3, 800); } catch(e){}
            applyHighlight(node);
          }
          break;
        }
        case 'graphData': {
          // Live refresh — new knowledge was injected (EZER / A.U Training).
          // Replace data + tell force-graph to layout incrementally so existing
          // nodes keep their positions and only new nodes settle in.
          if (!msg.data || !Array.isArray(msg.data.nodes)) break;
          data.nodes = msg.data.nodes;
          data.links = msg.data.links || [];
          // Refresh derived lookups
          for (const k in nodeById) delete nodeById[k];
          data.nodes.forEach(n => { nodeById[n.id] = n; });
          for (const k in neighborsOf) delete neighborsOf[k];
          data.nodes.forEach(n => { neighborsOf[n.id] = new Set(); });
          data.links.forEach(l => {
            const sId = (l.source && l.source.id) || l.source;
            const tId = (l.target && l.target.id) || l.target;
            if (neighborsOf[sId]) neighborsOf[sId].add(tId);
            if (neighborsOf[tId]) neighborsOf[tId].add(sId);
          });
          for (const k in nodesByBasename) delete nodesByBasename[k];
          data.nodes.forEach(n => {
            const k = (n.name || '').toLowerCase();
            nodesByBasename[k] = nodesByBasename[k] || [];
            nodesByBasename[k].push(n);
          });
          // Push new graph data into force-graph
          Graph.graphData(data);
          // Stats refresh
          const newFolders = [...new Set(data.nodes.map(n => n.folder))].sort();
          newFolders.forEach((f, i) => { if (!folderColor[f]) folderColor[f] = PALETTE[i % PALETTE.length]; });
          document.getElementById('stats').textContent =
            data.nodes.length + ' 지식 · ' + data.links.length + ' 연결 · ' + newFolders.length + ' 폴더';
          // Append any newly seen folders to legend chip list
          const folderListEl = document.getElementById('folders-list');
          if (folderListEl) {
            const existing = new Set([...folderListEl.querySelectorAll('.folder-name')].map(el => el.textContent));
            const counts = {};
            data.nodes.forEach(n => { counts[n.folder] = (counts[n.folder] || 0) + 1; });
            newFolders.forEach(f => {
              if (existing.has(f || '/')) return;
              const row = document.createElement('div');
              row.className = 'folder-row';
              const dot = document.createElement('div');
              dot.className = 'folder-dot';
              dot.style.background = folderColor[f] || '#888';
              const name = document.createElement('div');
              name.className = 'folder-name';
              name.textContent = f || '/';
              const count = document.createElement('div');
              count.className = 'folder-count';
              count.textContent = counts[f] || 0;
              row.appendChild(dot); row.appendChild(name); row.appendChild(count);
              folderListEl.appendChild(row);
            });
          }
          // Pulse the freshly injected node so the user actually sees it
          if (msg.highlightTitle) {
            const node = findNodeForReadRequest(msg.highlightTitle);
            if (node) {
              thinkingActive.add(node.id);
              recomputeAdjacent();
              try { Graph.centerAt(node.x || 0, node.y || 0, 800); Graph.zoom(2.4, 900); } catch(e){}
              setTimeout(() => {
                thinkingActive.delete(node.id);
                markDone(node.id);
                recomputeAdjacent();
              }, 2200);
            }
          }
          break;
        }
      }
    });

    // Notify extension we're ready to receive events
    vscode.postMessage({ type: 'graph_ready' });
  </script>
</body>
</html>`;
}

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

export const API_SERVICES: ApiServiceDef[] = [
    {
        id: 'telegram',
        name: '텔레그램 봇',
        icon: '📨',
        summary: '비서가 텔레그램으로 양방향 명령을 받고 보고합니다. 폰 어디서든 회사를 운영하세요.',
        helpUrl: 'https://t.me/BotFather',
        agentId: 'secretary',
        fields: [
            { key: 'TELEGRAM_BOT_TOKEN', label: 'Bot Token', type: 'password', help: '@BotFather에서 /newbot으로 발급. 형식: 숫자:문자' },
            { key: 'TELEGRAM_CHAT_ID', label: 'Chat ID', type: 'text', placeholder: '비워두면 자동 감지', help: '봇한테 메시지 1번 보내고 비워둔 채 저장하면 자동으로 채워집니다' },
        ],
    },
    {
        id: 'youtube',
        name: 'YouTube Data API',
        icon: '📺',
        summary: '내 채널 + 경쟁 채널 분석, 댓글 답장 큐 생성. 시청 지속률 같은 비공개 데이터는 OAuth가 별도.',
        helpUrl: 'https://console.cloud.google.com/',
        agentId: 'youtube',
        fields: [
            { key: 'YOUTUBE_API_KEY', label: 'API Key', type: 'password', help: 'Cloud Console → YouTube Data API v3 → 사용자 인증 정보 → API 키' },
            { key: 'YOUTUBE_CHANNEL_ID', label: 'Channel ID', type: 'text', placeholder: 'UCxxx...', help: '내 채널 페이지에서 확인' },
        ],
    },
    {
        id: 'youtube-oauth',
        name: 'YouTube Analytics (OAuth)',
        icon: '📊',
        summary: '시청 지속률 · 트래픽 소스 · 시청자 인구통계. Client ID/Secret 채운 뒤 "OAuth 연결" 버튼 (또는 에이전트가 자동으로 발동).',
        helpUrl: 'https://console.cloud.google.com/',
        agentId: 'youtube',
        wizardCommand: 'agentOs.youtube.connectOAuth',
        fields: [
            { key: 'YOUTUBE_OAUTH_CLIENT_ID', label: 'Client ID', type: 'password' },
            { key: 'YOUTUBE_OAUTH_CLIENT_SECRET', label: 'Client Secret', type: 'password', help: 'Authorized redirect URI: http://127.0.0.1:5814/yt-oauth-callback' },
        ],
    },
    {
        id: 'google-calendar',
        name: 'Google Calendar',
        icon: '📅',
        summary: '비서가 사용자 일정을 읽고 자동으로 task 마감일과 동기화합니다.',
        agentId: 'secretary',
        wizardCommand: 'agent-os.connectGoogleCalendarWrite',
        fields: [
            { key: 'GOOGLE_CALENDAR_ID', label: 'Calendar ID', type: 'text', placeholder: 'primary 또는 yourcal@group.calendar.google.com', help: '명령 팔레트 → "Agent OS: Google Calendar 자동 일정 연결" 추천' },
        ],
    },
    {
        id: 'github',
        name: 'GitHub',
        icon: '💻',
        summary: 'Developer 에이전트가 이슈 읽고 코드 푸시. repo + workflow 권한 필요.',
        helpUrl: 'https://github.com/settings/tokens',
        agentId: 'developer',
        comingSoon: true,
        fields: [
            { key: 'GITHUB_TOKEN', label: 'Personal Access Token', type: 'password' },
            { key: 'GITHUB_DEFAULT_REPO', label: '기본 저장소', type: 'text', placeholder: 'owner/repo' },
        ],
    },
    {
        id: 'instagram',
        name: 'Instagram (Meta Graph)',
        icon: '📷',
        summary: '인스타 비즈니스 계정 게시 + DM/댓글 분석.',
        helpUrl: 'https://developers.facebook.com/',
        agentId: 'instagram',
        comingSoon: true,
        fields: [
            { key: 'META_ACCESS_TOKEN', label: 'Access Token', type: 'password' },
            { key: 'INSTAGRAM_BUSINESS_ID', label: 'Business Account ID', type: 'text' },
        ],
    },
    {
        id: 'paypal',
        name: 'PayPal (매출 분석)',
        icon: '💰',
        summary: '내 게임·서비스의 결제 거래를 분석. 매출 대시보드 + 새 결제 텔레그램 알림에 사용. Developer Dashboard에서 Client ID/Secret 발급.',
        helpUrl: 'https://developer.paypal.com/dashboard/applications',
        agentId: 'business',
        fields: [
            { key: 'PAYPAL_MODE', label: '모드', type: 'select', options: ['sandbox', 'live'], help: '테스트는 sandbox, 실제 결제는 live. ⚠️ Live 는 별도 자격증명 필요 — Developer Dashboard 좌상단 Sandbox/Live 토글 후 Live 앱에서 받은 Client ID/Secret 사용.' },
            { key: 'PAYPAL_CLIENT_ID', label: 'Client ID', type: 'password', help: 'Developer Dashboard → Apps & Credentials → 본인 앱 → Client ID' },
            { key: 'PAYPAL_CLIENT_SECRET', label: 'Client Secret', type: 'password', help: '같은 화면에서 Secret 복사 (Show 클릭)' },
            { key: 'PAYPAL_LOOKBACK_DAYS', label: '분석 기간 (일)', type: 'text', placeholder: '30', help: '비우면 30일. Transaction Search 한도 31일.' },
            { key: 'PAYPAL_CURRENCY', label: '기본 통화 (선택)', type: 'text', placeholder: 'USD', help: '비우면 모든 통화 표시. USD/KRW 등.' },
        ],
    },
    {
        id: 'gemini',
        name: 'Google Gemini (AI 텍스트 + 이미지)',
        icon: '✨',
        summary: '운영자의 1인 기업 서비스에서 Gemini AI 호출 (텍스트 + Imagen 3 이미지). 키트 자동 적용 시 HTML 에 자동 inline 박힘. 보안: Google Cloud Console 에서 HTTP Referer 제한 권장.',
        helpUrl: 'https://aistudio.google.com/apikey',
        agentId: 'business',
        fields: [
            { key: 'GEMINI_API_KEY', label: 'API Key', type: 'password', help: 'aistudio.google.com/apikey 에서 Create API key (무료 tier OK). 이 키가 pack_apply 가 키트에 자동 박아 넣음 — 운영자의 강아지 사주·이미지 생성 서비스 등.' },
            { key: 'GEMINI_TEXT_MODEL', label: '텍스트 모델', type: 'text', placeholder: 'gemini-3.1-flash-lite-preview', help: '비우면 기본 gemini-3.1-flash-lite-preview (가성비·1M context·멀티모달). 또는 gemini-3.1-flash, gemini-3.1-pro.' },
            { key: 'GEMINI_IMAGE_MODEL', label: '이미지 모델', type: 'text', placeholder: 'gemini-3.1-flash-image-preview', help: '비우면 기본 gemini-3.1-flash-image-preview (text+image multimodal). 이미지 생성 안 쓸 거면 비워둠.' },
        ],
    },
];

/* Read all current values from each service's config.md. Empty string when
   not yet set. Returned as { [serviceId]: { key: value } }. */
export function readAllApiConnections(): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    /* v2.88.2 — 무효 값 필터: 사용자가 placeholder/라벨을 실수로 저장하거나
       이전 버그로 'TELEGRAM_BOT_TOKEN:' 같은 키 이름이 값 자리에 박혀있을 때
       빈 값으로 취급. 실제로 의미 있는 자격증명만 폼에 다시 채움. */
    const looksLikeJunk = (key: string, val: string): boolean => {
        const v = (val || '').trim();
        if (!v) return true;
        /* 본인 키 이름이 값 자리에 들어간 케이스 */
        if (v.startsWith(key + ':') || v === key || v.startsWith(key + '=')) return true;
        /* 다른 필드 키 이름이 들어간 경우 (이전 폼 오작동) */
        const allKeys = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'YOUTUBE_API_KEY', 'YOUTUBE_CHANNEL_ID'];
        if (allKeys.some(k => k !== key && (v.startsWith(k + ':') || v === k || v.startsWith(k + '=')))) return true;
        return false;
    };
    for (const svc of API_SERVICES) {
        out[svc.id] = {};
        try {
            /* 텔레그램은 캐노니컬 JSON을 우선 읽음 — 폴링이 읽는 단일 진실의 출처. */
            if (svc.id === 'telegram') {
                try {
                    const jsonPath = path.join(getCompanyDir(), '_agents', 'secretary', 'tools', 'telegram_setup.json');
                    if (fs.existsSync(jsonPath)) {
                        const cfg = JSON.parse(fs.readFileSync(jsonPath, 'utf-8') || '{}');
                        for (const f of svc.fields) {
                            const v = String(cfg[f.key] || '').trim();
                            out[svc.id][f.key] = looksLikeJunk(f.key, v) ? '' : v;
                        }
                        if (out[svc.id]['TELEGRAM_BOT_TOKEN']) continue;
                    }
                } catch { /* fall through to config.md */ }
            }
            /* v2.89.153 — Gemini 은 gemini_account.json 이 단일 진실의 출처. */
            if (svc.id === 'gemini') {
                try {
                    const jsonPath = path.join(getCompanyDir(), '_agents', 'business', 'tools', 'gemini_account.json');
                    if (fs.existsSync(jsonPath)) {
                        const cfg = JSON.parse(fs.readFileSync(jsonPath, 'utf-8') || '{}');
                        const map: Record<string, string> = {
                            GEMINI_API_KEY: 'API_KEY',
                            GEMINI_TEXT_MODEL: 'TEXT_MODEL',
                            GEMINI_IMAGE_MODEL: 'IMAGE_MODEL',
                        };
                        for (const f of svc.fields) {
                            const canonical = map[f.key] || f.key;
                            const raw = cfg[canonical];
                            const v = (raw === undefined || raw === null) ? '' : String(raw).trim();
                            out[svc.id][f.key] = looksLikeJunk(f.key, v) ? '' : v;
                        }
                        if (Object.values(out[svc.id]).some(v => !!v)) continue;
                    }
                } catch { /* fall through */ }
            }
            /* v2.89.139 — PayPal 은 paypal_revenue.json 이 단일 진실의 출처. */
            if (svc.id === 'paypal') {
                try {
                    const jsonPath = path.join(getCompanyDir(), '_agents', 'business', 'tools', 'paypal_revenue.json');
                    if (fs.existsSync(jsonPath)) {
                        const cfg = JSON.parse(fs.readFileSync(jsonPath, 'utf-8') || '{}');
                        /* 폼 키 → JSON 키 매핑 */
                        const map: Record<string, string> = {
                            PAYPAL_MODE: 'MODE',
                            PAYPAL_CLIENT_ID: 'CLIENT_ID',
                            PAYPAL_CLIENT_SECRET: 'CLIENT_SECRET',
                            PAYPAL_LOOKBACK_DAYS: 'LOOKBACK_DAYS',
                            PAYPAL_CURRENCY: 'CURRENCY',
                        };
                        for (const f of svc.fields) {
                            const canonical = map[f.key] || f.key;
                            const raw = cfg[canonical];
                            const v = (raw === undefined || raw === null) ? '' : String(raw).trim();
                            out[svc.id][f.key] = looksLikeJunk(f.key, v) ? '' : v;
                        }
                        if (Object.values(out[svc.id]).some(v => !!v)) continue;
                    }
                } catch { /* fall through */ }
            }
            /* v2.89.18 — YouTube Data API + OAuth Client 캐노니컬 youtube_account.json 우선. */
            if (svc.id === 'youtube' || svc.id === 'youtube-oauth') {
                try {
                    const jsonPath = path.join(getCompanyDir(), '_agents', 'youtube', 'tools', 'youtube_account.json');
                    if (fs.existsSync(jsonPath)) {
                        const cfg = JSON.parse(fs.readFileSync(jsonPath, 'utf-8') || '{}');
                        for (const f of svc.fields) {
                            /* API 패널 키 → 캐노니컬 JSON 키 매핑.
                               YOUTUBE_CHANNEL_ID (외부연결 폼) ↔ MY_CHANNEL_ID (캐노니컬). */
                            const canonicalKey = f.key === 'YOUTUBE_CHANNEL_ID' ? 'MY_CHANNEL_ID' : f.key;
                            const v = String(cfg[canonicalKey] || '').trim();
                            out[svc.id][f.key] = looksLikeJunk(f.key, v) ? '' : v;
                        }
                        const hasAny = Object.values(out[svc.id]).some(v => !!v);
                        if (hasAny) continue;
                    }
                } catch { /* fall through */ }
            }
            const cfgPath = path.join(getCompanyDir(), '_agents', svc.agentId, 'config.md');
            const txt = _safeReadText(cfgPath);
            for (const f of svc.fields) {
                /* v2.89.5 — line-anchored regex (`^KEY:` with `m` flag). 이전엔
                   anchor 없어서 `- YOUTUBE_API_KEY: ` 같은 preset 코멘트 라인을
                   먼저 잡고, `\s*` 가 newline 건너뛰어서 다음 줄의 키 이름을
                   value로 캡처해버림 → looksLikeJunk가 junk 판정 → "미설정".
                   line-start 강제로 실제 데이터 라인만 잡음. 또한 \s 대신
                   ' ' 으로 한정해서 newline 안 건너뜀. */
                const re = new RegExp('^' + f.key + '[ \\t]*[:：=][ \\t]*([^\\r\\n]+?)[ \\t]*$', 'm');
                const m = txt.match(re);
                const v = m ? m[1].trim() : '';
                out[svc.id][f.key] = looksLikeJunk(f.key, v) ? '' : v;
            }
        } catch { /* leave empty */ }
    }
    return out;
}

/* Save a service's values. Reads the existing config.md, replaces lines for
   each field (or appends a new section), writes back. Idempotent. */
export async function saveApiConnection(serviceId: string, values: Record<string, string>): Promise<{ ok: boolean; error?: string; note?: string }> {
    const svc = API_SERVICES.find(s => s.id === serviceId);
    if (!svc) return { ok: false, error: 'Unknown service' };
    try {
        ensureCompanyStructure();
        let extraNote = '';
        /* v2.88 — 텔레그램 서비스 특별 처리:
           1) chat_id 비어있으면 봇의 getUpdates에서 자동 감지
           2) 캐노니컬 위치(_agents/secretary/tools/telegram_setup.json)에도 동시 저장
              — 사이드바·텔레그램 폴링이 읽는 단일 진실의 출처
           3) 사용자가 token 잘못 넣으면 명확한 에러 반환 */
        if (serviceId === 'telegram') {
            let token = (values['TELEGRAM_BOT_TOKEN'] || '').trim();
            let chatId = (values['TELEGRAM_CHAT_ID'] || '').trim();
            /* v2.88.3 — 이전 regex `[ -‍﻿]+` 가 U+0020~U+200D 전체 범위를
               잡아서 ASCII 글자 다 깎아냄(=토큰 통째로 빈 문자열). 명시적 escape로
               whitespace + zero-width chars + BOM만 정확히 제거. */
            token = token.replace(/[\s ​-‍﻿]+/g, '').replace(/^bot/i, '');
            /* v2.88.2 — chat_id에 라벨/키 이름 같은 garbage가 있으면 빈 값으로
               취급해서 자동 감지 트리거. 이전 버그로 placeholder가 값 자리에
               박혀있는 사용자 데이터 자동 정리. */
            if (chatId && /^(TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID|YOUTUBE_API_KEY|YOUTUBE_CHANNEL_ID)[:=]?/i.test(chatId)) {
                chatId = '';
            }
            /* chat_id는 정상이면 음수 또는 양수 정수만 가능 */
            if (chatId && !/^-?\d+$/.test(chatId)) {
                chatId = '';
            }
            if (!token) return { ok: false, error: '봇 토큰이 비어있어요' };
            if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
                return { ok: false, error: `봇 토큰 형식이 이상해요. @BotFather에서 받은 "숫자:문자열" 형태인지 확인해주세요. 받은 값: ${token.slice(0, 20)}…` };
            }
            /* 토큰 검증 */
            try {
                const meRes = await axios.get(`https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`, { timeout: 8000, validateStatus: () => true });
                if (!meRes.data?.ok) {
                    return { ok: false, error: `봇 토큰 거절됨: ${meRes.data?.description || `HTTP ${meRes.status}`}. @BotFather에서 토큰 다시 확인해주세요.` };
                }
            } catch (e: any) {
                return { ok: false, error: `텔레그램 서버 연결 실패: ${e?.message || e}. 인터넷 확인하시고 다시 시도해주세요.` };
            }
            /* chat_id 비어있으면 자동 감지 */
            if (!chatId) {
                try {
                    const upRes = await axios.get(`https://api.telegram.org/bot${encodeURIComponent(token)}/getUpdates`, { timeout: 8000, validateStatus: () => true });
                    const updates: any[] = Array.isArray(upRes.data?.result) ? upRes.data.result : [];
                    const seen = new Set<number>();
                    const chats: { id: number; name: string }[] = [];
                    for (let i = updates.length - 1; i >= 0; i--) {
                        const m = updates[i]?.message || updates[i]?.edited_message || updates[i]?.channel_post;
                        const c = m?.chat;
                        if (!c || typeof c.id !== 'number') continue;
                        if (seen.has(c.id)) continue;
                        seen.add(c.id);
                        const name = c.first_name ? `${c.first_name}${c.last_name ? ' ' + c.last_name : ''}` : (c.title || c.username || `Chat ${c.id}`);
                        chats.push({ id: c.id, name });
                    }
                    if (chats.length === 0) {
                        return { ok: false, error: '봇한테 아직 메시지를 보낸 적이 없어요. 텔레그램에서 봇 시작(/start) 눌러서 메시지 1개 보낸 후 다시 저장해주세요.' };
                    }
                    /* 첫 번째(가장 최근) chat 자동 선택 */
                    chatId = String(chats[0].id);
                    extraNote = `📲 chat_id 자동 감지됨 (${chats[0].name})`;
                } catch (e: any) {
                    return { ok: false, error: `chat_id 자동 감지 실패: ${e?.message || e}` };
                }
            }
            /* 캐노니컬 JSON 저장 — 폴링이 읽는 단일 진실의 출처 */
            const toolDir = path.join(getCompanyDir(), '_agents', 'secretary', 'tools');
            fs.mkdirSync(toolDir, { recursive: true });
            const jsonPath = path.join(toolDir, 'telegram_setup.json');
            fs.writeFileSync(jsonPath, JSON.stringify({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId }, null, 2));
            /* values도 갱신해서 아래 config.md 저장 시 정합성 유지 */
            values['TELEGRAM_BOT_TOKEN'] = token;
            values['TELEGRAM_CHAT_ID'] = chatId;
        }
        /* v2.89.18 — YouTube 자격증명 (Data API + OAuth) 캐노니컬 단일 저장.
           외부 연결 패널 = source of truth. 도구·에이전트·OAuth 흐름 모두 여기서
           읽음. config.md는 더 이상 source 아님 (legacy fallback only). */
        if (serviceId === 'youtube' || serviceId === 'youtube-oauth') {
            const ytToolDir = path.join(getCompanyDir(), '_agents', 'youtube', 'tools');
            const ytJsonPath = path.join(ytToolDir, 'youtube_account.json');
            try {
                fs.mkdirSync(ytToolDir, { recursive: true });
                let existing: Record<string, any> = {};
                if (fs.existsSync(ytJsonPath)) {
                    try { existing = JSON.parse(fs.readFileSync(ytJsonPath, 'utf-8') || '{}'); } catch { /* malformed */ }
                }
                /* Data API 필드 */
                if (serviceId === 'youtube') {
                    const apiKey = (values['YOUTUBE_API_KEY'] || '').trim();
                    const channelId = (values['YOUTUBE_CHANNEL_ID'] || '').trim();
                    existing['YOUTUBE_API_KEY'] = apiKey;
                    if (channelId) existing['MY_CHANNEL_ID'] = channelId;
                    if (channelId && !apiKey) extraNote = `⚠️ 채널 ID는 저장됨 — API 키도 입력해야 분석 가능`;
                    else if (apiKey && channelId) extraNote = `🔑 캐노니컬 youtube_account.json 동기화 완료`;
                }
                /* OAuth Client ID/Secret 필드 */
                if (serviceId === 'youtube-oauth') {
                    const clientId = (values['YOUTUBE_OAUTH_CLIENT_ID'] || '').trim();
                    const clientSecret = (values['YOUTUBE_OAUTH_CLIENT_SECRET'] || '').trim();
                    if (clientId) existing['YOUTUBE_OAUTH_CLIENT_ID'] = clientId;
                    if (clientSecret) existing['YOUTUBE_OAUTH_CLIENT_SECRET'] = clientSecret;
                    extraNote = `🔐 OAuth Client 캐노니컬 youtube_account.json 동기화 완료`;
                }
                /* 누락 필드 기본값 */
                if (typeof existing['YOUTUBE_API_KEY'] !== 'string') existing['YOUTUBE_API_KEY'] = '';
                if (!('MY_CHANNEL_HANDLE' in existing)) existing['MY_CHANNEL_HANDLE'] = '';
                if (!('MY_CHANNEL_ID' in existing)) existing['MY_CHANNEL_ID'] = '';
                if (!('WATCHED_CHANNELS' in existing)) existing['WATCHED_CHANNELS'] = [];
                if (!('COMPETITOR_CHANNELS' in existing)) existing['COMPETITOR_CHANNELS'] = [];
                fs.writeFileSync(ytJsonPath, JSON.stringify(existing, null, 2));
            } catch (e: any) {
                console.warn('[saveApiConnection] youtube_account.json sync failed:', e?.message || e);
            }
        }
        /* v2.89.139 — PayPal 캐노니컬 JSON 동기화. paypal_revenue.py / 매출 대시보드 /
           RevenueWatcher 가 모두 _agents/business/tools/paypal_revenue.json 을 읽음.
           외부 연결 패널이 그 단일 진실 출처에 직접 write → 별도 설정 단계 불필요. */
        if (serviceId === 'paypal') {
            const ppToolDir = path.join(getCompanyDir(), '_agents', 'business', 'tools');
            const ppJsonPath = path.join(ppToolDir, 'paypal_revenue.json');
            try {
                fs.mkdirSync(ppToolDir, { recursive: true });
                let existing: Record<string, any> = {};
                if (fs.existsSync(ppJsonPath)) {
                    try { existing = JSON.parse(fs.readFileSync(ppJsonPath, 'utf-8') || '{}'); } catch { /* malformed */ }
                }
                const mode = (values['PAYPAL_MODE'] || 'sandbox').trim().toLowerCase();
                const clientId = (values['PAYPAL_CLIENT_ID'] || '').trim();
                const clientSecret = (values['PAYPAL_CLIENT_SECRET'] || '').trim();
                const lookback = parseInt((values['PAYPAL_LOOKBACK_DAYS'] || '').trim(), 10);
                const currency = (values['PAYPAL_CURRENCY'] || '').trim().toUpperCase();
                existing['MODE'] = (mode === 'live' || mode === 'sandbox') ? mode : 'sandbox';
                if (clientId) existing['CLIENT_ID'] = clientId;
                if (clientSecret) existing['CLIENT_SECRET'] = clientSecret;
                existing['LOOKBACK_DAYS'] = isNaN(lookback) ? 30 : Math.max(1, Math.min(31, lookback));
                existing['CURRENCY'] = currency;
                if (!('_schema' in existing)) {
                    existing['_schema'] = {
                        MODE: { type: 'select', options: ['sandbox', 'live'] },
                        CLIENT_ID: { type: 'password' },
                        CLIENT_SECRET: { type: 'password' },
                        LOOKBACK_DAYS: { type: 'number' },
                        CURRENCY: { type: 'text' },
                    };
                }
                fs.writeFileSync(ppJsonPath, JSON.stringify(existing, null, 2));
                if (clientId && clientSecret) {
                    extraNote = `💰 paypal_revenue.json 동기화 — 매출 대시보드·watcher 즉시 사용 가능 (${existing['MODE']} 모드)`;
                } else {
                    extraNote = `⚠️ Client ID + Secret 둘 다 입력해야 매출 분석 가능 (현재 일부 빈 값)`;
                }
            } catch (e: any) {
                console.warn('[saveApiConnection] paypal_revenue.json sync failed:', e?.message || e);
            }
        }
        /* v2.89.153 — Gemini API 캐노니컬 JSON 동기화. pack_apply 가 키트 적용 시
           HTML 의 __GEMINI_API_KEY__ placeholder 를 이 키로 자동 inline.
           운영자 (1인 기업) 의 단일 자격증명을 모든 키트가 공유. */
        if (serviceId === 'gemini') {
            const gToolDir = path.join(getCompanyDir(), '_agents', 'business', 'tools');
            const gJsonPath = path.join(gToolDir, 'gemini_account.json');
            try {
                fs.mkdirSync(gToolDir, { recursive: true });
                let existing: Record<string, any> = {};
                if (fs.existsSync(gJsonPath)) {
                    try { existing = JSON.parse(fs.readFileSync(gJsonPath, 'utf-8') || '{}'); } catch { /* malformed */ }
                }
                const apiKey = (values['GEMINI_API_KEY'] || '').trim();
                const textModel = (values['GEMINI_TEXT_MODEL'] || '').trim() || 'gemini-3.1-flash-lite-preview';
                const imageModel = (values['GEMINI_IMAGE_MODEL'] || '').trim() || 'gemini-3.1-flash-image-preview';
                if (apiKey) existing['API_KEY'] = apiKey;
                existing['TEXT_MODEL'] = textModel;
                existing['IMAGE_MODEL'] = imageModel;
                fs.writeFileSync(gJsonPath, JSON.stringify(existing, null, 2));
                if (apiKey) {
                    extraNote = `✨ Gemini API 키 저장됨 — pack_apply 시 키트 HTML 에 자동 inline (텍스트: ${textModel}, 이미지: ${imageModel})`;
                } else {
                    extraNote = `⚠️ API Key 비어있음 — aistudio.google.com/apikey 에서 발급`;
                }
            } catch (e: any) {
                console.warn('[saveApiConnection] gemini_account.json sync failed:', e?.message || e);
            }
        }
        const cfgPath = path.join(getCompanyDir(), '_agents', svc.agentId, 'config.md');
        let txt = _safeReadText(cfgPath);
        if (!txt) {
            const a = AGENTS[svc.agentId];
            txt = `# ${a?.emoji || '🤖'} ${a?.name || svc.agentId} 설정 (시크릿)\n\n_이 파일은 \`.gitignore\`로 깃 동기화에서 제외됩니다._\n`;
        }
        for (const f of svc.fields) {
            const v = (values[f.key] || '').trim();
            const re = new RegExp('^' + f.key + '\\s*[:：=]\\s*.*$', 'm');
            if (re.test(txt)) {
                txt = txt.replace(re, `${f.key}: ${v}`);
            } else {
                txt = txt.trimEnd() + `\n${f.key}: ${v}\n`;
            }
        }
        fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
        fs.writeFileSync(cfgPath, txt);
        return { ok: true, note: extraNote || undefined };
    } catch (e: any) {
        return { ok: false, error: e?.message || String(e) };
    }
}


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

const YT_OAUTH_CLIENT_ID_KEY = 'YOUTUBE_OAUTH_CLIENT_ID';
const YT_OAUTH_CLIENT_SECRET_KEY = 'YOUTUBE_OAUTH_CLIENT_SECRET';
const YT_OAUTH_REDIRECT = 'http://127.0.0.1:5814/yt-oauth-callback';
const YT_OAUTH_SCOPES = [
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/yt-analytics.readonly',
    'https://www.googleapis.com/auth/youtube.force-ssl', /* needed for posting comment replies */
].join(' ');

function _ytOAuthTokenPath(): string {
    return path.join(getCompanyDir(), '_agents', 'youtube', 'oauth.local.json');
}

export function _readYtOAuthClient(): { id: string; secret: string } {
    /* v2.89.18 — 캐노니컬 youtube_account.json 우선. 외부 연결 패널이 거기에
       저장하니까 source of truth 일관성 유지. config.md는 legacy fallback만. */
    const jsonPath = path.join(getCompanyDir(), '_agents', 'youtube', 'tools', 'youtube_account.json');
    try {
        if (fs.existsSync(jsonPath)) {
            const cfg = JSON.parse(fs.readFileSync(jsonPath, 'utf-8') || '{}');
            const id = String(cfg[YT_OAUTH_CLIENT_ID_KEY] || '').trim();
            const secret = String(cfg[YT_OAUTH_CLIENT_SECRET_KEY] || '').trim();
            if (id && secret) return { id, secret };
        }
    } catch { /* malformed — fall through */ }
    /* Fallback: legacy config.md */
    const txt = _safeReadText(path.join(getCompanyDir(), '_agents', 'youtube', 'config.md'));
    const idM = txt.match(new RegExp(YT_OAUTH_CLIENT_ID_KEY + '\\s*[:：=]\\s*([^\\s]+)'));
    const sM  = txt.match(new RegExp(YT_OAUTH_CLIENT_SECRET_KEY + '\\s*[:：=]\\s*([^\\s]+)'));
    return { id: idM ? idM[1] : '', secret: sM ? sM[1] : '' };
}

function _readYtOAuthTokens(): { access_token?: string; refresh_token?: string; expires_at?: number } | null {
    try {
        const txt = _safeReadText(_ytOAuthTokenPath());
        if (!txt.trim()) return null;
        return JSON.parse(txt);
    } catch { return null; }
}

function _writeYtOAuthTokens(t: { access_token?: string; refresh_token?: string; expires_at?: number }) {
    try {
        fs.mkdirSync(path.dirname(_ytOAuthTokenPath()), { recursive: true });
        fs.writeFileSync(_ytOAuthTokenPath(), JSON.stringify(t, null, 2));
    } catch { /* ignore */ }
}

export function isYoutubeOAuthConnected(): boolean {
    const t = _readYtOAuthTokens();
    return !!(t && (t.refresh_token || (t.access_token && t.expires_at && t.expires_at > Date.now())));
}

async function _ensureYtAccessToken(): Promise<string | null> {
    const t = _readYtOAuthTokens();
    if (!t) return null;
    if (t.access_token && t.expires_at && t.expires_at > Date.now() + 30_000) return t.access_token;
    if (!t.refresh_token) return null;
    const cl = _readYtOAuthClient();
    if (!cl.id || !cl.secret) return null;
    try {
        const params = new URLSearchParams({
            client_id: cl.id,
            client_secret: cl.secret,
            refresh_token: t.refresh_token,
            grant_type: 'refresh_token',
        });
        const r = await axios.post('https://oauth2.googleapis.com/token', params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 10000,
        });
        const newAt: string = r.data?.access_token;
        const expiresIn: number = r.data?.expires_in || 3600;
        if (!newAt) return null;
        _writeYtOAuthTokens({ ...t, access_token: newAt, expires_at: Date.now() + expiresIn * 1000 });
        return newAt;
    } catch { return null; }
}

export async function startYouTubeOAuthFlow(): Promise<{ ok: boolean; message: string }> {
    const cl = _readYtOAuthClient();
    if (!cl.id || !cl.secret) {
        return { ok: false, message: `먼저 \`_agents/youtube/config.md\`에 다음 두 줄 추가하세요:\n${YT_OAUTH_CLIENT_ID_KEY}: <Google Cloud Console OAuth 2.0 Client ID>\n${YT_OAUTH_CLIENT_SECRET_KEY}: <Client Secret>\n\n생성: console.cloud.google.com → APIs & Services → Credentials → OAuth 2.0 Client ID (Web application). Authorized redirect URI에 ${YT_OAUTH_REDIRECT} 등록.` };
    }
    return new Promise((resolve) => {
        const state = Math.random().toString(36).slice(2, 12);
        const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?'
            + new URLSearchParams({
                client_id: cl.id,
                redirect_uri: YT_OAUTH_REDIRECT,
                response_type: 'code',
                scope: YT_OAUTH_SCOPES,
                access_type: 'offline',
                prompt: 'consent',
                state,
            }).toString();
        let server: http.Server | null = null;
        let resolved = false;
        const timer = setTimeout(() => {
            if (resolved) return;
            resolved = true;
            try { server?.close(); } catch { /* ignore */ }
            resolve({ ok: false, message: '⏱️ OAuth 시간 초과 (5분). 다시 시도해주세요.' });
        }, 5 * 60_000);
        server = http.createServer(async (req, res) => {
            try {
                const url = new URL(req.url || '/', `http://127.0.0.1:5814`);
                if (!url.pathname.startsWith('/yt-oauth-callback')) {
                    res.writeHead(404); res.end(); return;
                }
                const code = url.searchParams.get('code') || '';
                const stateBack = url.searchParams.get('state') || '';
                if (stateBack !== state || !code) {
                    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end('<h2>❌ OAuth 실패 — state 불일치 또는 code 없음</h2>');
                    if (!resolved) { resolved = true; clearTimeout(timer); try { server?.close(); } catch {} resolve({ ok: false, message: 'OAuth state mismatch' }); }
                    return;
                }
                /* exchange code → tokens */
                const params = new URLSearchParams({
                    client_id: cl.id,
                    client_secret: cl.secret,
                    code,
                    redirect_uri: YT_OAUTH_REDIRECT,
                    grant_type: 'authorization_code',
                });
                const tk = await axios.post('https://oauth2.googleapis.com/token', params.toString(), {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    timeout: 15000,
                });
                const at = tk.data?.access_token;
                const rt = tk.data?.refresh_token;
                const ein = tk.data?.expires_in || 3600;
                _writeYtOAuthTokens({ access_token: at, refresh_token: rt, expires_at: Date.now() + ein * 1000 });
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<!doctype html><html><body style="background:#0a0d12;color:#e6edf3;font-family:sans-serif;text-align:center;padding:60px"><h1 style="color:#00ff41">✅ Agent OS · YouTube 연결 완료</h1><p>이 창을 닫고 안티그래비티로 돌아가세요.</p></body></html>');
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timer);
                    try { server?.close(); } catch { /* ignore */ }
                    resolve({ ok: true, message: '✅ YouTube OAuth 연결 완료. Analytics 데이터 활성화.' });
                }
            } catch (e: any) {
                res.writeHead(500); res.end('OAuth error: ' + (e?.message || e));
                if (!resolved) { resolved = true; clearTimeout(timer); try { server?.close(); } catch {} resolve({ ok: false, message: `OAuth 교환 실패: ${e?.message || e}` }); }
            }
        });
        server.listen(5814, '127.0.0.1', () => {
            vscode.env.openExternal(vscode.Uri.parse(authUrl));
        });
        server.on('error', (err: any) => {
            if (!resolved) { resolved = true; clearTimeout(timer); resolve({ ok: false, message: `포트 5814 사용 중: ${err?.message || err}` }); }
        });
    });
}

/* Pulls a 28-day Analytics summary for the user's channel — views,
   estimatedMinutesWatched, averageViewDuration, plus top traffic sources +
   top countries. Rolled into one object the dashboard renders. */
export async function fetchYouTubeAnalyticsSummary(): Promise<any> {
    const at = await _ensureYtAccessToken();
    if (!at) throw new Error('OAuth 토큰 없음');
    const end = new Date();
    const start = new Date(Date.now() - 28 * 86_400_000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const baseParams = {
        ids: 'channel==MINE',
        startDate: fmt(start),
        endDate: fmt(end),
    };
    const headers = { Authorization: `Bearer ${at}` };
    /* 1) totals */
    const totals = await axios.get('https://youtubeanalytics.googleapis.com/v2/reports', {
        params: { ...baseParams, metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained' },
        headers, timeout: 12000,
    });
    const row = totals.data?.rows?.[0] || [];
    const cols = (totals.data?.columnHeaders || []).map((c: any) => c.name);
    const get = (name: string) => { const i = cols.indexOf(name); return i >= 0 ? row[i] : null; };
    /* 2) top sources */
    let topSources: Array<{ source: string; views: number }> = [];
    try {
        const r = await axios.get('https://youtubeanalytics.googleapis.com/v2/reports', {
            params: { ...baseParams, metrics: 'views', dimensions: 'insightTrafficSourceType', sort: '-views', maxResults: 7 },
            headers, timeout: 12000,
        });
        topSources = (r.data?.rows || []).map((rr: any) => ({ source: String(rr[0]), views: Number(rr[1]) }));
    } catch { /* ignore */ }
    /* 3) top countries */
    let topCountries: Array<{ country: string; views: number }> = [];
    try {
        const r = await axios.get('https://youtubeanalytics.googleapis.com/v2/reports', {
            params: { ...baseParams, metrics: 'views', dimensions: 'country', sort: '-views', maxResults: 7 },
            headers, timeout: 12000,
        });
        topCountries = (r.data?.rows || []).map((rr: any) => ({ country: String(rr[0]), views: Number(rr[1]) }));
    } catch { /* ignore */ }
    return {
        views: get('views') || 0,
        estimatedMinutesWatched: get('estimatedMinutesWatched') || 0,
        avgViewDurationSec: get('averageViewDuration') || 0,
        avgViewPercentage: get('averageViewPercentage') || 0,
        subscribersGained: get('subscribersGained') || 0,
        topSources,
        topCountries,
    };
}

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

