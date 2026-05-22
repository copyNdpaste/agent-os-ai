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

/** Module-scoped lock so auto-sync and manual sync never run concurrently against the same brain. */
let _autoSyncRunning = false;
let _companySyncRunning = false; /* separate lock — brain & company can sync in parallel */

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
function getConfig() {
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

async function _ensureBrainDir(): Promise<string | null> {
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

const EXCLUDED_DIRS = new Set([
    'node_modules', '.git', '.vscode', 'out', 'dist', 'build',
    '.next', '.cache', '__pycache__', '.DS_Store', 'coverage',
    '.turbo', '.nuxt', '.output', 'vendor', 'target'
]);
const MAX_CONTEXT_SIZE = 12_000; // chars

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

const SYSTEM_PROMPT = _loadPrompt('system.md');
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
function getCompanyMetrics(): cmp.CompanyMetrics {
    return cmp.readMetrics(_getBrainDir());
}

/** Returns the company's "Day N" relative to when the user first set up the
 *  company. First call also stamps `foundedAt` so the counter is stable across
 *  PCs that share the brain folder via GitHub. Returns 1 on day 0. */
function getCompanyDay(): number {
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

function updateCompanyMetrics(updates: Partial<cmp.CompanyMetrics>) {
    cmp.updateMetrics(_getBrainDir(), updates);
}

function _extractCompanyName(idMd: string): string {
    return cmp.extractCompanyNameFromMd(idMd);
}

function isCompanyConfigured(): boolean {
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
function getAgentModel(agentId: string, fallback: string): string {
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
function _personalizePrompt(prompt: string): string {
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
type CompanyConfig = cmp.CompanyConfig;

function _extractField(md: string, label: string): string {
    return cmp.extractField(md, label);
}

function _extractGoalLine(md: string, header: string): string {
    return cmp.extractGoalLine(md, header);
}

function readCompanyConfig(): CompanyConfig {
    return cmp.readConfig(getCompanyDir());
}

function writeCompanyConfig(cfg: Partial<CompanyConfig>) {
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

function readTelegramConfig(): tg.TelegramConfig {
  return tg.readTelegramConfig(getCompanyDir());
}

async function sendTelegramReport(text: string): Promise<boolean> {
  return tg.sendReport(text, readTelegramConfig());
}

async function sendTelegramLong(text: string): Promise<boolean> {
  return tg.sendLong(text, readTelegramConfig());
}

async function sendTelegramTyping(): Promise<void> {
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

function _findActiveDispatch(prompt: string): ActiveDispatch | null {
  return dsp.find(prompt);
}
function _startActiveDispatch(prompt: string, fromTelegram: boolean): ActiveDispatch {
  return dsp.start(prompt, fromTelegram);
}
function _updateActiveDispatchStep(prompt: string, step: string) {
  dsp.updateStep(prompt, step);
}
function _endActiveDispatch(prompt: string) {
  dsp.end(prompt);
}
function _pushTelegramHistory(role: 'user' | 'assistant', text: string) {
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

function _renderTelegramHistory(maxTurns = 8): string {
  return tg.renderHistory(getCompanyDir(), maxTurns);
}

/* Multi-window guard + polling offset persistence — 본체는 src/telegram/{lock,offset}.ts
   로 추출. _TELEGRAM_USER_BRAIN 은 유저 레벨 공유 위치 (~/.connect-ai-brain) 로
   안티그래비티 창마다 다른 워크스페이스라도 락이 단일하게 유지된다. */
function _readTelegramOffset(): number { return tg.readOffset(_TELEGRAM_USER_BRAIN); }
function _writeTelegramOffset(offset: number): void { tg.writeOffset(_TELEGRAM_USER_BRAIN, offset); }
function _tryAcquireTelegramLock(): boolean { return tg.tryAcquireLock(_TELEGRAM_USER_BRAIN); }
function _releaseTelegramLockIfOwned(): void { tg.releaseLockIfOwned(_TELEGRAM_USER_BRAIN); }

const TELEGRAM_HELP = `🤖 *Agent OS 봇* — 비서가 24시간 대기 중

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

function _modelToTier(modelName: string): Tier {
    const m = (modelName || '').toLowerCase();
    if (m.includes('opus')) return 'heavy';
    if (m.includes('haiku')) return 'light';
    return 'standard';
}

function _serializeMessages(messages: { role: string; content: any }[]): string {
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

async function _quickLLMCall(systemPrompt: string, userMsg: string, maxTokens = 64): Promise<string> {
    const prompt = `${systemPrompt}\n\n---\n\n${userMsg}\n\n(Respond in ${maxTokens} tokens or fewer. Output only the answer, no preamble.)`;
    const out = await ask(prompt, 'light', { timeoutMs: 60_000 });
    return out.trim();
}

const CEO_CLASSIFIER_PROMPT = _loadPrompt('ceo-classifier.md');
const SECRETARY_TELEGRAM_PROMPT = _loadPrompt('secretary-telegram.md');
async function classifyToAgent(text: string): Promise<string> {
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

async function handleTelegramCommand(text: string): Promise<void> {
    const trimmed = text.trim();
    const cmd = trimmed.split(/\s+/)[0].toLowerCase();
    const rest = trimmed.slice(cmd.length).trim();

    if (cmd === '/help' || cmd === '/start') {
        await sendTelegramReport(TELEGRAM_HELP);
        return;
    }
    /* Plan B (2026-05-03 단순화) — 슬래시 명령은 4개만 유지:
         /help · /start  → Telegram 봇 관습 (첫 추가 시 자동 발동)
         /done <id>      → 작업 완료 (id로 확실하게 — 자연어 모호성 회피)
         /cancel <id>    → 작업 취소 (동일 이유)
       나머지(/agents, /tools, /approvals, /calendar, /today, /brief, /tasks,
       /ask)는 모두 비서가 자연어로 답하는 게 더 자연스러워서 제거. 알 수
       없는 슬래시도 거부하지 않고 비서한테 그대로 흘림 — 사용자가 외울
       명령은 사실상 0개. */
    if (cmd === '/done' || cmd === '/cancel') {
        const idArg = rest.trim();
        if (!idArg) {
            await sendTelegramReport(`사용법: \`${cmd} <id>\` — 작업 id는 "할일 뭐 있어?"라고 물어보면 비서가 알려줘요. 마지막 9자리만 입력해도 OK.`);
            return;
        }
        /* Allow short suffix match */
        const all = readTracker().tasks;
        const match = all.find(t => t.id === idArg) || all.find(t => t.id.endsWith(idArg));
        if (!match) {
            await sendTelegramReport(`❌ id \`${idArg}\` 못 찾았어요. "할일 뭐 있어?"로 목록 확인해주세요.`);
            return;
        }
        if (match.status === 'done' || match.status === 'cancelled') {
            await sendTelegramReport(`이미 ${match.status === 'done' ? '완료' : '취소'} 상태입니다.`);
            return;
        }
        const newStatus = cmd === '/done' ? 'done' : 'cancelled';
        updateTrackerTask(match.id, { status: newStatus, evidence: cmd === '/done' ? '사용자 텔레그램 확인' : '사용자 취소' });
        await sendTelegramReport(`${cmd === '/done' ? '✅' : '✖️'} \`${match.id.slice(-9)}\` ${match.title}\n→ ${newStatus === 'done' ? '완료' : '취소'} 처리됨.`);
        return;
    }
    /* P1-8: edit commands — let the user retarget tasks without re-creating.
       Loose date parser (ISO, "내일", "오늘 15:00", "+2h") covers the
       common cases without dragging in a date library. */
    if (cmd === '/reschedule' || cmd === '/priority' || cmd === '/move-to') {
        const parts = rest.split(/\s+/).filter(Boolean);
        const idArg = parts.shift() || '';
        const argRest = parts.join(' ').trim();
        if (!idArg || !argRest) {
            await sendTelegramReport(`사용법:\n\`/reschedule <id> <시간>\` (예: \`내일 15:00\`, \`+2h\`, \`2026-05-10\`)\n\`/priority <id> <urgent|high|normal|low>\`\n\`/move-to <id> <에이전트id>\``);
            return;
        }
        const all = readTracker().tasks;
        const match = all.find(t => t.id === idArg) || all.find(t => t.id.endsWith(idArg));
        if (!match) {
            await sendTelegramReport(`❌ id \`${idArg}\` 못 찾았어요.`);
            return;
        }
        if (cmd === '/reschedule') {
            const dt = _parseLooseDate(argRest);
            if (!dt) {
                await sendTelegramReport(`⚠️ 시간을 못 알아들었어요: \`${argRest}\`\n예: \`내일 15:00\`, \`+2h\`, \`2026-05-10 09:00\``);
                return;
            }
            updateTrackerTask(match.id, { dueAt: dt.toISOString(), preAlarmsSent: [] });
            await sendTelegramReport(`📅 \`${match.id.slice(-9)}\` ${match.title}\n→ ${dt.toLocaleString('ko-KR')} 으로 변경`);
            return;
        }
        if (cmd === '/priority') {
            const p = argRest.toLowerCase();
            if (p !== 'urgent' && p !== 'high' && p !== 'normal' && p !== 'low') {
                await sendTelegramReport(`⚠️ 우선순위는 \`urgent / high / normal / low\` 중 하나여야 해요.`);
                return;
            }
            updateTrackerTask(match.id, { priority: p as TaskPriority });
            await sendTelegramReport(`${TASK_PRIORITY_LABEL[p as TaskPriority]} \`${match.id.slice(-9)}\` ${match.title}\n→ 우선순위 ${p}`);
            return;
        }
        if (cmd === '/move-to') {
            const newAgent = argRest.toLowerCase().trim();
            if (!AGENTS[newAgent]) {
                await sendTelegramReport(`⚠️ 에이전트 id를 모르겠어요: \`${newAgent}\`. \`/agents\`로 목록 확인.`);
                return;
            }
            const a = AGENTS[newAgent];
            updateTrackerTask(match.id, { agentIds: [newAgent], owner: 'agent' });
            await sendTelegramReport(`${a.emoji} \`${match.id.slice(-9)}\` ${match.title}\n→ ${a.name}에게 이관`);
            return;
        }
    }
    /* v2.89.115 — /skill: 직전 specialist 산출물을 재사용 가능한 패턴으로
       승격해서 _agents/{id}/skills/<slug>.md 에 저장. Hermes Agent의 skill
       자동승격을 1인 기업 컨셉으로 단순화한 것 — 자동 노이즈 X, 사용자가
       명시적으로 트리거할 때만. 다음 호출부터 해당 specialist의 system prompt
       에 자동 주입됨.
         /skill            → 대화 로그에서 직전 specialist 자동 감지
         /skill <agent_id> → 명시적으로 어느 에이전트에 저장할지 지정 */
    if (cmd === '/skill') {
        const argId = rest.toLowerCase().trim();
        const last = _getLastSpecialistOutput();
        if (!last) {
            await sendTelegramReport(`⚠️ 직전 specialist 산출물을 찾지 못했어요. 작업 한 번 시킨 다음에 \`/skill\`을 호출해주세요.`);
            return;
        }
        const targetId = argId && AGENTS[argId] ? argId : last.agentId;
        const target = AGENTS[targetId];
        await sendTelegramReport(`💎 ${target.emoji} *${target.name}* — 직전 산출물을 패턴화하는 중…`);
        const result = await saveAgentSkill(targetId, last.body, { titleHint: last.body.slice(0, 80) });
        if (!result.ok) {
            await sendTelegramReport(`⚠️ ${result.reason}`);
            try { appendConversationLog({ speaker: '시스템', emoji: '💎', section: '스킬 저장 시도', body: `${target.name} → ${result.reason}` }); } catch { /* ignore */ }
            return;
        }
        await sendTelegramReport(`✅ ${target.emoji} *${target.name}* 스킬 저장됨\n\n*${result.title}*\n\n다음 호출부터 ${target.name}의 시스템 컨텍스트에 자동 주입돼요.`);
        try { appendConversationLog({ speaker: '시스템', emoji: '💎', section: '스킬 저장', body: `${target.name} → ${result.title}` }); } catch { /* ignore */ }
        try { appendAgentMemory(targetId, `[skill 승격] "${result.title}" — 다음 사이클부터 패턴 재사용`); } catch { /* ignore */ }
        return;
    }
    if (cmd === '/skills') {
        const argId = rest.toLowerCase().trim();
        const ids = argId && AGENTS[argId] ? [argId] : SPECIALIST_IDS;
        const lines: string[] = [];
        for (const id of ids) {
            const a = AGENTS[id];
            const skillsDir = path.join(getCompanyDir(), '_agents', id, 'skills');
            let files: string[] = [];
            try { files = fs.readdirSync(skillsDir).filter(f => f.endsWith('.md') && f.toLowerCase() !== 'readme.md'); } catch { /* ignore */ }
            if (files.length === 0) continue;
            lines.push(`${a.emoji} *${a.name}* (${files.length})`);
            for (const f of files.slice(0, 5)) {
                const txt = _safeReadText(path.join(skillsDir, f));
                const title = (txt.split('\n')[0] || f).replace(/^#+\s*/, '').trim().slice(0, 60);
                lines.push(`  • ${title}`);
            }
            if (files.length > 5) lines.push(`  _… +${files.length - 5}개_`);
        }
        if (lines.length === 0) {
            await sendTelegramReport(`💎 저장된 스킬이 아직 없어요. 작업 후 \`/skill\`로 패턴화해보세요.`);
        } else {
            await sendTelegramReport(`💎 *저장된 스킬*\n\n${lines.join('\n')}`);
        }
        return;
    }
    /* P0-4: /approve /reject — release or kill an agent's pending action.
       Same shape as /done /cancel, separate id-space (`apr-…`). */
    if (cmd === '/approve' || cmd === '/reject') {
        const idArg = rest.trim();
        if (!idArg) {
            const pending = listPendingApprovals();
            if (pending.length === 0) {
                await sendTelegramReport(`✅ 승인 대기 액션이 없어요.`);
                return;
            }
            const list = pending.slice(0, 5).map(a => {
                const ag = AGENTS[a.agentId];
                return `• \`${a.id.slice(-9)}\` ${ag?.emoji || '🤖'} ${a.title}`;
            }).join('\n');
            await sendTelegramReport(`사용법: \`${cmd} <id>\`\n\n*대기 중 (${pending.length}건)*\n${list}`);
            return;
        }
        const decision = cmd === '/approve' ? 'approved' : 'rejected';
        const result = await resolveApproval(idArg, decision);
        await sendTelegramReport(result.message);
        return;
    }
    /* Unknown slash — fall through to natural-language handling. Don't reject.
       Users who type "/뭐하고있어" should get an answer, not a rejection. */

    /* Free text → Secretary mediates. Secretary decides whether to answer
       directly (schedule/status questions), forward to CEO (work that needs
       dispatch), or ask for more info. This is the "Secretary as gateway"
       behavior — every Telegram interaction goes through the agent who's
       supposed to be the messenger. */
    try {
        await handleTelegramViaSecretary(trimmed);
    } catch (e: any) {
        /* Fallback to old classifier behavior if Secretary call fails — keeps
           the bot responsive even when the local LLM is down. */
        try {
            const targetAgent = await classifyToAgent(trimmed);
            const a = AGENTS[targetAgent];
            await sendTelegramReport(`🧭 (비서 응답 실패 → CEO 라우팅) ${a.emoji} *${a.name}*\n\n_"${trimmed.slice(0, 120)}"_\n\n_답변 준비되는 대로 보내드릴게요._`);
            _activeChatProvider?.sendPromptFromExtension?.(trimmed, { fromTelegram: true, corporate: true });
        } catch { /* truly silent fail */ }
    }
}

/* Robust JSON extractor — handles model output that wraps the JSON in prose,
   markdown fences, or multiple objects. Scans ALL balanced top-level objects
   and returns the first one with a string `mode` field; falls back to the
   first parseable object if none has `mode`. Picking by `mode` matters because
   small models often emit a "thinking" / scratchpad JSON before the real
   answer, and the legacy first-only behavior would lock onto the scratchpad
   and leak it (or trigger an empty-reply fallback). */
function _extractFirstJsonObject(raw: string): any | null {
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
function _buildCapabilityReport(): string {
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
function _buildDispatchStatusReport(): string {
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

async function handleTelegramViaSecretary(userText: string): Promise<void> {
    /* Mirror user's Telegram message into the sidebar chat */
    try { _activeChatProvider?.postSystemNote?.(`텔레그램: "${userText.slice(0, 200)}"`, '📱'); } catch { /* ignore */ }
    /* Show the bot is working — Telegram typing indicator */
    sendTelegramTyping().catch(() => { /* ignore */ });
    /* Push the user's message into short-term memory BEFORE we build the
       prompt — Secretary needs to see "그 일정", "방금 그거" type follow-ups
       in context. Reply gets pushed at each branch below so the next turn's
       history reflects what we actually said. */
    _pushTelegramHistory('user', userText);
    /* v2.89.3 — Cancel intent. 진행 중 작업이 있으면 즉시 abort. LLM 안 거침
       — 사용자가 멈추라고 했는데 또 LLM 한 사이클 돌리면 답답함 가중. */
    const cancelQ = /^\s*(취소|중단|중지|그만|멈춰|멈춰줘|stop|cancel|abort|nevermind|never\s*mind)\s*[\.!\?]*\s*$/i;
    if (cancelQ.test(userText)) {
        const result = _activeChatProvider?.abortActiveDispatch?.() || { cancelled: false };
        if (result.cancelled) {
            const what = result.what ? ` (${result.what} 단계에서)` : '';
            const msg = `🛑 *비서*: 작업 중단했어요${what}. 다음 명령 기다릴게요.`;
            await sendTelegramReport(msg);
            _pushTelegramHistory('assistant', `작업 중단됨${what}`);
            try { _activeChatProvider?.postSystemNote?.(`비서 → 텔레그램 (작업 중단)`, '🛑'); } catch { /* ignore */ }
        } else {
            const msg = `💬 *비서*: 지금 진행 중인 작업이 없어요. 자유롭게 새 명령 주세요.`;
            await sendTelegramReport(msg);
            _pushTelegramHistory('assistant', `진행 중 작업 없음 — 취소할 거 없음`);
        }
        return;
    }
    /* v2.88 — Capability introspection. "뭐 할 수 있어?" / "도움" / "/start"
       류 메시지면 LLM 거치지 않고 실제 연결된 능력만 자연어로 답변. 일반론
       대신 정확히 지금 가능한 것만 알려줘서 "AI가 멍청하다" 인상 줄임. */
    const introQ = /^\s*(\/start|\/help|뭐\s*할\s*수\s*있|도움|help|what.*can.*you.*do|할\s*수\s*있는\s*거|기능\s*뭐|능력\s*뭐)/i;
    if (introQ.test(userText)) {
        const cap = _buildCapabilityReport();
        await sendTelegramLong(cap);
        _pushTelegramHistory('assistant', cap.slice(0, 400));
        try { _activeChatProvider?.postSystemNote?.(`비서 → 텔레그램 (능력 요약)`, '💬'); } catch { /* ignore */ }
        return;
    }
    /* v2.89 — 진행 상태 introspection. "지금 뭐 해?" / "/status" / "큐" 류
       질문이면 디스패치 큐 + 현재 작업 즉시 답변. */
    const statusQ = /^\s*(\/status|지금\s*뭐\s*해|뭐\s*하고\s*있|작업\s*상태|큐\s*상태|현재\s*상태)/i;
    if (statusQ.test(userText)) {
        const status = _buildDispatchStatusReport();
        await sendTelegramLong(status);
        _pushTelegramHistory('assistant', status.slice(0, 400));
        try { _activeChatProvider?.postSystemNote?.(`비서 → 텔레그램 (진행 상태)`, '💬'); } catch { /* ignore */ }
        return;
    }

    /* Build Secretary's context: identity + calendar + schedule + recent
       agent activity. Keeps the call cheap (small model, low temp). */
    const today = new Date();
    const todayStr = today.toLocaleDateString('ko-KR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    let ctxBlock = `\n\n[현재 시각]\n${today.toLocaleString('ko-KR')} (${todayStr})`;
    try {
        const dir = getCompanyDir();
        const cal = _safeReadText(path.join(dir, '_shared', 'calendar_cache.md'));
        const sch = _safeReadText(path.join(dir, '_shared', 'schedule.md'));
        const id  = _safeReadText(path.join(dir, '_shared', 'identity.md'));
        const dec = _safeReadText(path.join(dir, '_shared', 'decisions.md'));
        if (id.trim())  ctxBlock += `\n\n[회사 정체성]\n${id.slice(0, 800)}`;
        if (cal.trim()) ctxBlock += `\n\n[다가오는 일정 (Google Calendar)]\n${cal.slice(0, 1200)}`;
        if (sch.trim()) ctxBlock += `\n\n[통합 스케줄]\n${sch.slice(0, 1200)}`;
        /* Tracker — lets Secretary answer "에이전트 뭐하고있어?" / "지금 뭐 하고
           있어?" without dispatching. The list is the canonical "what is the
           company doing right now" view. */
        try {
            const trackerMd = trackerToMarkdown({ onlyOpen: true, max: 12 });
            if (trackerMd) ctxBlock += `\n\n[지금 진행 중인 작업 (추적기)]\n${trackerMd.slice(0, 1500)}`;
        } catch { /* ignore */ }
        /* Recent CEO decisions — last 1500 chars of the decisions log gives
           Secretary enough to answer "최근에 뭐 결정했어?" / "어제 뭐 했어?". */
        if (dec.trim()) ctxBlock += `\n\n[최근 의사결정 로그]\n${dec.slice(-1500)}`;
        /* Recent session reports — give Secretary a quick view of the last
           few completed dispatches so it can summarize "에이전트 최근 결과물" without
           re-dispatching. Cheap: just read filenames + first 200 chars. */
        try {
            const sessDir = path.join(dir, 'sessions');
            const sessions = fs.readdirSync(sessDir)
                .filter(n => !n.startsWith('.'))
                .sort()
                .slice(-3);
            if (sessions.length > 0) {
                const lines: string[] = [];
                for (const s of sessions) {
                    const reportPath = path.join(sessDir, s, '_report.md');
                    const txt = _safeReadText(reportPath);
                    if (txt.trim()) lines.push(`• ${s}: ${txt.slice(0, 160).replace(/\s+/g, ' ').trim()}…`);
                }
                if (lines.length > 0) ctxBlock += `\n\n[최근 완료된 세션 보고서]\n${lines.join('\n')}`;
            }
        } catch { /* ignore — no sessions yet */ }
    } catch { /* ignore */ }
    if (isCalendarWriteConnected()) {
        ctxBlock += `\n\n[캘린더 연결 상태] ✅ Google Calendar 쓰기 연결됨 — calendar_create/list/delete/update 모드 사용 가능`;
    } else {
        ctxBlock += `\n\n[캘린더 연결 상태] ❌ 미연결 — calendar_* 모드 사용 시 mode='reply'로 "Google Calendar 연결이 필요해요(명령 팔레트 → '회사 GitHub 연결' 옆 'Google Calendar 자동 일정 연결')"라고 알려주세요`;
    }
    /* Short-term Telegram history — gives Secretary context for follow-ups
       like "그거 4시로 바꿔줘". Capped to last 8 turns within the past 4
       hours (helper enforces both). */
    const historyBlock = _renderTelegramHistory(8);
    if (historyBlock) {
        ctxBlock += `\n\n[최근 텔레그램 대화 (참조용)]\n${historyBlock}\n\n_사용자가 "그거"·"방금 그 일정"·"그 회의" 라고 하면 위 대화에서 어떤 일정/주제인지 찾아서 처리하세요._`;
    }
    /* Company-wide conversation log — same source CEO planner reads. Captures
       sidebar dialogues, autonomous agent chatter, dispatch results. Lets
       Secretary answer cross-channel follow-ups like "developer가 사이트 어떻게
       하고 있어?" without re-dispatching. Conservative size (1500 chars) to
       avoid blowing past LM Studio's default context window. */
    const companyLog = readRecentConversations(1500);
    if (companyLog && companyLog.trim()) {
        ctxBlock += companyLog;
    }

    let raw = '';
    try {
        /* 800 (was 500) — calendar_create with description + location can blow
           past 500 and arrive truncated. Truncated JSON has no balanced close
           brace, defeats the parser, and leaks raw `{"mode":...` to the user. */
        raw = await _quickLLMCall(SECRETARY_TELEGRAM_PROMPT + ctxBlock, userText, 800);
    } catch (e: any) {
        await sendTelegramReport(`⚠️ 비서가 응답하지 못했어요: ${e?.message || e}`);
        return;
    }
    const parsed = _extractFirstJsonObject(raw);
    if (!parsed || typeof parsed.mode !== 'string') {
        /* Try one rescue pass — small models often emit a truncated JSON whose
           `text` field is recoverable even without a closing brace. */
        const textM = raw.match(/"text"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
        const rescuedText = textM ? textM[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').trim() : '';
        if (rescuedText) {
            await sendTelegramLong(`💬 *비서*: ${rescuedText.slice(0, 1500)}`);
            try { _activeChatProvider?.postSystemNote?.(`비서 → 텔레그램 (JSON 복구): ${rescuedText.slice(0, 300)}`, '💬'); } catch { /* ignore */ }
            return;
        }
        /* Fallback — aggressively strip from the first { onward (handles both
           balanced and unclosed JSON) so the user never sees raw mode/text
           markup. If nothing remains, ask the user to retry. */
        const clean = raw
            .replace(/```[\s\S]*?```/g, '')   // code fences first
            .replace(/\{[\s\S]*$/, '')         // open brace → EOF (catches truncation)
            .trim();
        if (!clean) {
            await sendTelegramReport(`💬 비서: 잠깐, 모델이 답변을 끝내지 못했어요. 다시 한 번 말씀해주실 수 있나요?`);
            return;
        }
        const fallbackMsg = clean.slice(0, 600);
        await sendTelegramReport(`💬 비서: ${fallbackMsg}`);
        try { _activeChatProvider?.postSystemNote?.(`비서 → 텔레그램: ${fallbackMsg.slice(0, 300)}`, '💬'); } catch { /* ignore */ }
        return;
    }

    const replyText = (typeof parsed.text === 'string' ? parsed.text : '').trim().slice(0, 3500);
    const mode = parsed.mode;

    /* Tracker — Secretary may flag this message as a trackable commitment. */
    let trackedId = '';
    try {
        const tt = parsed.track_task;
        if (tt && typeof tt === 'object' && typeof tt.title === 'string' && tt.title.trim()) {
            const owner = (tt.owner === 'user' || tt.owner === 'mixed') ? tt.owner : 'agent';
            const due = (typeof tt.due === 'string' && /^\d{4}-\d{2}-\d{2}/.test(tt.due)) ? tt.due : undefined;
            const task = addTrackerTask({
                title: tt.title.trim(),
                owner,
                dueAt: due,
                description: userText.slice(0, 400),
                status: owner === 'agent' ? 'in_progress' : 'pending',
            });
            trackedId = task.id;
        }
    } catch { /* ignore */ }
    const trailer = trackedId ? `\n\n_📋 추적: \`${trackedId.slice(-9)}\`_` : '';

    /* ── Calendar actions: Secretary acts directly ─────────────────── */
    if (mode === 'calendar_create') {
        const ev = parsed.event;
        if (!isCalendarWriteConnected()) {
            await sendTelegramReport(`⚠️ Google Calendar가 연결되지 않았어요.\n\n*명령 팔레트* → "Agent OS: Google Calendar 자동 일정 연결" 로 먼저 셋업해주세요.`);
            return;
        }
        if (!ev || typeof ev.title !== 'string' || typeof ev.start !== 'string') {
            await sendTelegramReport(`💬 *비서*: ${replyText || '일정 정보가 부족해요. 시작 시각과 제목을 다시 알려주세요.'}`);
            return;
        }
        const dur = (typeof ev.duration_minutes === 'number' && ev.duration_minutes > 0) ? ev.duration_minutes : 60;
        const startDate = new Date(ev.start);
        if (isNaN(startDate.getTime())) {
            await sendTelegramReport(`⚠️ 시작 시각 해석 실패: \`${ev.start}\`. 다시 알려주세요.`);
            return;
        }
        const endDate = new Date(startDate.getTime() + dur * 60_000);
        const created = await createCalendarEventDirect({
            title: ev.title.trim(),
            startIso: startDate.toISOString(),
            endIso: endDate.toISOString(),
            description: typeof ev.description === 'string' ? ev.description : undefined,
            location: typeof ev.location === 'string' ? ev.location : undefined,
        });
        if (!created) {
            await sendTelegramReport(`❌ 캘린더 일정 생성 실패. 토큰이 만료됐을 수 있어요. 명령 팔레트 → "Google Calendar 자동 일정 연결" 재실행해주세요.`);
            return;
        }
        const fmt = (d: Date) => d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit' });
        const link = created.htmlLink ? `\n\n[🔗 캘린더에서 보기](${created.htmlLink})` : '';
        const confirmMsg = replyText || `📅 일정 추가됨\n*${ev.title}*\n${fmt(startDate)} – ${fmt(endDate)}`;
        await sendTelegramLong(`💬 *비서*: ${confirmMsg}${link}${trailer}`);
        _pushTelegramHistory('assistant', `일정 추가됨: ${ev.title} (${fmt(startDate)} – ${fmt(endDate)})`);
        try { _activeChatProvider?.postSystemNote?.(`비서 → 캘린더: "${ev.title}" ${fmt(startDate)}`, '📅'); } catch { /* ignore */ }
        /* Refresh local cache so other agents see the new event */
        refreshCalendarCacheViaOAuth(14).catch(() => { /* silent */ });
        return;
    }
    if (mode === 'calendar_list') {
        if (!isCalendarWriteConnected()) {
            /* Fall back to cached calendar if OAuth not connected */
            const cal = _safeReadText(path.join(getCompanyDir(), '_shared', 'calendar_cache.md')).trim();
            const body = cal ? cal.split('\n').slice(0, 30).join('\n') : '_캘린더 정보가 없어요. Google Calendar 연결 또는 iCal 도구 셋업이 필요해요._';
            await sendTelegramLong(`💬 *비서 — 일정*\n\n${body}`);
            return;
        }
        const days = (typeof parsed.days_ahead === 'number' && parsed.days_ahead > 0) ? Math.min(60, parsed.days_ahead) : 7;
        const events = await findCalendarEvents({ daysAhead: days });
        if (events.length === 0) {
            await sendTelegramReport(`💬 *비서*: 향후 ${days}일 안에 잡힌 일정이 없어요. ${replyText}`);
            return;
        }
        const fmt = (s: string) => {
            try {
                const d = new Date(s);
                return d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit' });
            } catch { return s; }
        };
        const list = events.map(e => `• *${fmt(e.startIso)}* — ${e.title}`).join('\n');
        await sendTelegramLong(`💬 *비서 — 향후 ${days}일 일정*\n\n${list}${replyText ? `\n\n${replyText}` : ''}`);
        /* Compact summary for history — keeps "그 일정" references resolvable
           without dumping the full list into every subsequent prompt. */
        const histSummary = events.slice(0, 5).map(e => `${e.title} (${fmt(e.startIso)})`).join(', ');
        _pushTelegramHistory('assistant', `향후 ${days}일 일정: ${histSummary}${events.length > 5 ? ' 외 ' + (events.length - 5) + '건' : ''}`);
        try { _activeChatProvider?.postSystemNote?.(`비서 → 캘린더 조회 (${events.length}건)`, '📅'); } catch { /* ignore */ }
        return;
    }
    if (mode === 'calendar_delete') {
        if (!isCalendarWriteConnected()) {
            await sendTelegramReport(`⚠️ Google Calendar가 연결되지 않았어요.`);
            return;
        }
        const query = typeof parsed.query === 'string' ? parsed.query.trim() : '';
        /* 30일 기본값으로 확장 — "여자 들어간 일정 다 취소" 같은 벌크 명령은
           오늘만이 아니라 향후 1달치를 다 잡아야 자연스러움. 단일 매칭 케이스는
           원래도 days_ahead를 LLM이 작게 보냈으니 영향 없음. */
        const days = (typeof parsed.days_ahead === 'number' && parsed.days_ahead > 0) ? Math.min(60, parsed.days_ahead) : 30;
        const deleteAll = parsed.delete_all === true;
        const matches = await findCalendarEvents({ query, daysAhead: days });
        if (matches.length === 0) {
            await sendTelegramReport(`💬 *비서*: \`${query || '(검색어 없음)'}\` 일치하는 일정을 못 찾았어요.`);
            return;
        }
        const fmt = (s: string) => { try { return new Date(s).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return s; } };
        /* 벌크 삭제 — 사용자가 "모두/전부/다" 명시한 경우. LLM이 delete_all=true로
           세팅. 매칭된 일정 전부 순차 삭제 후 결과 요약. */
        if (deleteAll) {
            let ok = 0, fail = 0;
            const okTitles: string[] = [];
            const failTitles: string[] = [];
            for (const ev of matches) {
                const r = await deleteCalendarEvent(ev.eventId);
                if (r) { ok++; okTitles.push(`✖️ ${ev.title} (${fmt(ev.startIso)})`); }
                else   { fail++; failTitles.push(`⚠️ ${ev.title} (${fmt(ev.startIso)})`); }
            }
            const okBlock = okTitles.length ? okTitles.join('\n') : '_없음_';
            const failBlock = failTitles.length ? `\n\n*실패 ${fail}건*\n${failTitles.join('\n')}` : '';
            const headline = fail === 0
                ? `💬 *비서*: ✖️ \`${query}\` 일치 ${ok}건 모두 취소됨`
                : `💬 *비서*: \`${query}\` 일치 ${matches.length}건 중 ${ok}건 취소`;
            await sendTelegramLong(`${headline}\n\n${okBlock}${failBlock}`);
            _pushTelegramHistory('assistant', `${ok}건 취소됨 (${query}). ${fail > 0 ? fail + '건 실패.' : ''}`);
            try { _activeChatProvider?.postSystemNote?.(`비서 → 캘린더 벌크 취소: "${query}" ${ok}/${matches.length}건`, '🗑️'); } catch { /* ignore */ }
            refreshCalendarCacheViaOAuth(30).catch(() => { /* silent */ });
            return;
        }
        if (matches.length > 1) {
            const list = matches.map((e, i) => `${i + 1}. *${fmt(e.startIso)}* — ${e.title}`).join('\n');
            await sendTelegramLong(`💬 *비서*: ${matches.length}개가 일치해요. 어떻게 할까요?\n\n${list}\n\n_• 모두 취소하려면: "모두 삭제" 또는 "다 취소"_\n_• 하나만 취소하려면: 더 구체적인 제목으로 알려주세요_`);
            _pushTelegramHistory('assistant', `${matches.length}건 매칭. 모두 삭제 또는 더 구체적 지시 대기.`);
            return;
        }
        const ev = matches[0];
        const ok = await deleteCalendarEvent(ev.eventId);
        if (!ok) {
            await sendTelegramReport(`❌ 일정 취소 실패. 권한이 없거나 이미 삭제됐을 수 있어요.`);
            return;
        }
        const cancelMsg = `💬 *비서*: ✖️ 취소됨 — *${ev.title}* (${fmt(ev.startIso)})${replyText ? `\n\n${replyText}` : ''}`;
        await sendTelegramLong(cancelMsg);
        _pushTelegramHistory('assistant', `취소됨 — ${ev.title} (${fmt(ev.startIso)}). ${replyText}`);
        try { _activeChatProvider?.postSystemNote?.(`비서 → 캘린더 취소: "${ev.title}"`, '🗑️'); } catch { /* ignore */ }
        refreshCalendarCacheViaOAuth(14).catch(() => { /* silent */ });
        return;
    }
    if (mode === 'calendar_update') {
        if (!isCalendarWriteConnected()) {
            await sendTelegramReport(`⚠️ Google Calendar가 연결되지 않았어요.`);
            return;
        }
        const query = typeof parsed.query === 'string' ? parsed.query.trim() : '';
        const days = (typeof parsed.days_ahead === 'number' && parsed.days_ahead > 0) ? Math.min(60, parsed.days_ahead) : 7;
        const patch = (parsed.patch && typeof parsed.patch === 'object') ? parsed.patch : {};
        if (!patch.start && !patch.duration_minutes && !patch.title) {
            await sendTelegramReport(`💬 *비서*: 뭘 바꿀지 알려주세요 (시간/길이/제목 중 하나 이상).`);
            return;
        }
        const matches = await findCalendarEvents({ query, daysAhead: days });
        if (matches.length === 0) {
            await sendTelegramReport(`💬 *비서*: \`${query || '(검색어 없음)'}\` 일치하는 일정을 못 찾았어요.`);
            return;
        }
        if (matches.length > 1) {
            const fmt = (s: string) => { try { return new Date(s).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return s; } };
            const list = matches.map((e, i) => `${i + 1}. *${fmt(e.startIso)}* — ${e.title}`).join('\n');
            await sendTelegramLong(`💬 *비서*: 여러 개가 일치해요. 어느 걸 바꿀까요?\n\n${list}\n\n_제목을 더 구체적으로 알려주세요._`);
            return;
        }
        const ev = matches[0];
        /* Compute new start/end from patch fields, falling back to current. */
        let newStartIso: string | undefined;
        let newEndIso: string | undefined;
        const currentStart = new Date(ev.startIso);
        const currentEnd = ev.endIso ? new Date(ev.endIso) : new Date(currentStart.getTime() + 60 * 60_000);
        const currentDurMin = Math.max(15, Math.round((currentEnd.getTime() - currentStart.getTime()) / 60_000));
        if (typeof patch.start === 'string') {
            const s = new Date(patch.start);
            if (isNaN(s.getTime())) {
                await sendTelegramReport(`⚠️ 새 시작 시각 해석 실패: \`${patch.start}\`. 다시 알려주세요.`);
                return;
            }
            newStartIso = s.toISOString();
            const dur = (typeof patch.duration_minutes === 'number' && patch.duration_minutes > 0) ? patch.duration_minutes : currentDurMin;
            newEndIso = new Date(s.getTime() + dur * 60_000).toISOString();
        } else if (typeof patch.duration_minutes === 'number' && patch.duration_minutes > 0) {
            /* Only duration changed — keep start, recompute end */
            newEndIso = new Date(currentStart.getTime() + patch.duration_minutes * 60_000).toISOString();
        }
        const newTitle = (typeof patch.title === 'string' && patch.title.trim()) ? patch.title.trim() : undefined;
        const updated = await patchCalendarEvent(ev.eventId, {
            title: newTitle,
            startIso: newStartIso,
            endIso: newEndIso,
        });
        if (!updated) {
            await sendTelegramReport(`❌ 일정 수정 실패. 권한이 없거나 이미 삭제됐을 수 있어요.`);
            return;
        }
        const fmt = (s: string) => { try { return new Date(s).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return s; } };
        const finalTitle = newTitle || ev.title;
        const link = updated.htmlLink ? `\n\n[🔗 캘린더에서 보기](${updated.htmlLink})` : '';
        const confirmMsg = replyText || `📅 *${finalTitle}* 수정됨 — ${fmt(updated.startIso || newStartIso || ev.startIso)}${updated.endIso ? ` ~ ${fmt(updated.endIso)}` : ''}`;
        await sendTelegramLong(`💬 *비서*: ${confirmMsg}${link}${trailer}`);
        _pushTelegramHistory('assistant', `${finalTitle} 수정됨 (${fmt(updated.startIso || ev.startIso)})`);
        try { _activeChatProvider?.postSystemNote?.(`비서 → 캘린더 수정: "${finalTitle}" ${fmt(updated.startIso || ev.startIso)}`, '✏️'); } catch { /* ignore */ }
        refreshCalendarCacheViaOAuth(14).catch(() => { /* silent */ });
        return;
    }

    /* ── Existing reply / dispatch / ask paths ─────────────────────── */
    if (mode === 'dispatch') {
        await sendTelegramReport(`📨 *비서 → CEO*\n\n${replyText || '작업을 분배할게요'}${trailer}`);
        _pushTelegramHistory('assistant', `(CEO에게 전달) ${replyText || '작업을 분배할게요'}`);
        try { _activeChatProvider?.postSystemNote?.(`비서 → CEO 전달: ${replyText.slice(0, 300)}`, '📨'); } catch { /* ignore */ }
        const dispatchInstr = String(parsed.dispatch_to_ceo || userText).slice(0, 1500);
        /* corporate:true 추가 — _handleCorporatePrompt를 직접 호출해서 진짜
           멀티 에이전트 디스패치 발동. 이전엔 webview를 거쳐서 단일 LLM
           응답으로만 흘러서 "전달 완료"만 답하고 실제 작업 안 함. */
        try { _activeChatProvider?.sendPromptFromExtension?.(dispatchInstr, { fromTelegram: true, corporate: true }); } catch { /* ignore */ }
    } else if (mode === 'ask') {
        await sendTelegramLong(`💬 *비서*: ${replyText}`);
        _pushTelegramHistory('assistant', replyText);
        try { _activeChatProvider?.postSystemNote?.(`비서 → 텔레그램: ${replyText.slice(0, 300)}`, '💬'); } catch { /* ignore */ }
    } else {
        if (!replyText) {
            await sendTelegramReport(`💬 비서: 한 번 더 말씀해주실 수 있나요? 답변을 만들지 못했어요.`);
            return;
        }
        await sendTelegramLong(`💬 *비서*: ${replyText}${trailer}`);
        _pushTelegramHistory('assistant', replyText);
        try { _activeChatProvider?.postSystemNote?.(`비서 → 텔레그램: ${replyText.slice(0, 300)}`, '💬'); } catch { /* ignore */ }
    }
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
function startTelegramPolling() {
    if (_telegramPollTimer) return;
    // Restore last known offset so we never replay messages after a restart
    if (_extCtx) {
        _telegramPollOffset = _extCtx.globalState.get<number>('telegramPollOffset', 0);
    }
    const tick = async () => {
        if (_telegramPolling) return;
        const { token, chatId } = readTelegramConfig();
        if (!token || !chatId) return; // not configured — quietly idle
        if (!_tryAcquireTelegramLock()) return; // another window is already the leader
        _telegramPolling = true;
        /* v2.89.24 — 유저 레벨 파일 offset 사용. globalState는 같은 머신·같은 확장이지만
           Antigravity 같은 fork에서 namespace가 다를 수 있어서, 진짜 공유는 파일 한 군데. */
        const fileOffset = _readTelegramOffset();
        if (fileOffset > _telegramPollOffset) _telegramPollOffset = fileOffset;
        if (_extCtx) {
            const stored = _extCtx.globalState.get<number>('telegramPollOffset', 0);
            if (stored > _telegramPollOffset) _telegramPollOffset = stored;
        }
        try {
            /* v2.89.41 — Long polling. timeout=25는 Telegram 서버에 "메시지 올 때까지 25초간
               열어둬"라고 요청. 메시지 오면 즉시 반환, 없으면 25초 후 빈 배열. 결과:
               - 텔레그램 응답성: 5초 폴링 사이클 → 거의 실시간 (메시지 도착하자마자 반환)
               - API 호출 ~12배 감소 (5초마다 → 25~30초마다)
               - 트래픽·배터리 절약 */
            const url = `https://api.telegram.org/bot${token}/getUpdates`;
            const res = await axios.get(url, {
                params: { offset: _telegramPollOffset, timeout: 25, allowed_updates: JSON.stringify(['message']) },
                timeout: 30_000 /* 서버 timeout(25s) + 네트워크 여유 5s */
            });
            const updates = res.data?.result || [];
            for (const u of updates) {
                _telegramPollOffset = (u.update_id || 0) + 1;
                try { _extCtx?.globalState.update('telegramPollOffset', _telegramPollOffset); } catch {}
                /* v2.89.24 — 유저 레벨 파일에도 즉시 commit. 다른 창이 다음 tick에 이걸 읽어서
                   같은 update 두 번 처리하지 않게. */
                _writeTelegramOffset(_telegramPollOffset);
                const m = u.message;
                if (!m) continue;
                const fromChat = String(m.chat?.id ?? '');
                if (fromChat !== String(chatId)) continue; // whitelist guard
                const text = (m.text || '').trim();
                if (!text) continue;
                try { await handleTelegramCommand(text); }
                catch (e: any) {
                    try { await sendTelegramReport(`⚠️ 명령 처리 중 오류: ${e?.message || e}`); } catch {}
                }
            }
        } catch (e: any) {
            if (e?.response?.status === 401) {
                console.warn('[Telegram] 401 — bot token rejected. Stopping polling until config changes.');
                stopTelegramPolling();
            }
            // Other errors (network, 5xx) silently retry next tick.
        } finally {
            _telegramPolling = false;
        }
    };
    /* v2.89.41 — long-poll이 25초 블록되니 setInterval은 long poll 끝난 직후 다음 tick
       발동시키는 안전망 역할. 1초 간격으로 체크하지만 _telegramPolling 가드 때문에
       동시 실행 안 됨 (이전 tick이 long poll 중이면 즉시 return). */
    _telegramPollTimer = setInterval(tick, 1000);
    setTimeout(tick, 500);
}

function stopTelegramPolling() {
    if (_telegramPollTimer) {
        clearInterval(_telegramPollTimer);
        _telegramPollTimer = null;
    }
    _releaseTelegramLockIfOwned();
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
function isCalendarWriteConnected(): boolean { return cal.isConnected(getCompanyDir()); }
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

async function deleteCalendarEvent(eventId: string): Promise<boolean> {
  return cal.deleteEvent(getCompanyDir(), eventId);
}

async function patchCalendarEvent(
  eventId: string,
  opts: cal.PatchEventOpts
): Promise<cal.CalendarEventResult | null> {
  return cal.patchEvent(getCompanyDir(), eventId, opts);
}

async function createCalendarEventDirect(
  opts: cal.CreateEventOpts
): Promise<cal.CalendarEventResult | null> {
  return cal.createEvent(getCompanyDir(), opts);
}

async function findCalendarEvents(opts: cal.FindEventsOpts): Promise<cal.CalendarEvent[]> {
  return cal.findEvents(getCompanyDir(), opts);
}

async function refreshCalendarCacheViaOAuth(daysAhead: number = 14): Promise<cal.RefreshCacheResult> {
  return cal.refreshCache(getCompanyDir(), daysAhead);
}

/* OAuth setup wizard — guides the user through Google Cloud setup, captures
   their Client ID/Secret, runs a loopback auth flow, and persists the
   refresh_token. Only Secretary owns this — keys live in Secretary's tool
   config so the rest of the system can find them via one stable path. */
async function runConnectGoogleCalendarWrite() {
  const cfg = readCalendarWriteConfig();
  const already = isCalendarWriteConnected();
  if (already) {
    const choice = await vscode.window.showInformationMessage(
      `✅ 이미 연결됨: ${cfg._CONNECTED_AS || 'Google 계정'}`,
      { modal: false },
      '연결 해제',
      '재연결',
      '취소'
    );
    if (choice === '연결 해제') {
      writeCalendarWriteConfig({ REFRESH_TOKEN: '', _CONNECTED_AS: '', _CONNECTED_AT: '' });
      await vscode.window.showInformationMessage('Google Calendar 쓰기 연결 해제됨.');
      return;
    }
    if (choice !== '재연결') return;
  }

  const intro = await vscode.window.showInformationMessage(
    `📅 Google Calendar 자동 일정 등록 — 셋업 (약 5~10분)\n\n1단계: Google Cloud Console에서 OAuth 클라이언트 만들기 (수동)\n2단계: Client ID + Secret 붙여넣기\n3단계: 브라우저로 로그인 → 끝\n\n시작할까요?`,
    { modal: true },
    '시작',
    'Google Cloud Console 먼저 열기',
    '취소'
  );
  if (intro === '취소' || !intro) return;
  if (intro === 'Google Cloud Console 먼저 열기') {
    await vscode.env.openExternal(vscode.Uri.parse('https://console.cloud.google.com/apis/credentials'));
    const back = await vscode.window.showInformationMessage(
      `Google Cloud에서 다음 단계를 마쳤으면 계속 →\n\n1. 새 프로젝트 만들기\n2. APIs & Services → Library → "Google Calendar API" 활성화\n3. OAuth 동의 화면 설정 (External, Test users에 본인 이메일)\n4. Credentials → Create OAuth 2.0 Client ID → 'Desktop app'\n5. Client ID + Client Secret 복사`,
      { modal: true },
      '다 됐음 →',
      '취소'
    );
    if (back !== '다 됐음 →') return;
  }

  const clientId = await vscode.window.showInputBox({
    title: 'Google OAuth Client ID',
    prompt: 'Google Cloud Credentials 페이지에서 복사한 Client ID',
    placeHolder: 'xxxxxxxx.apps.googleusercontent.com',
    ignoreFocusOut: true,
    validateInput: v => (v || '').trim() ? null : '비어있어요',
  });
  if (!clientId) return;
  const clientSecret = await vscode.window.showInputBox({
    title: 'Google OAuth Client Secret',
    prompt: '같은 화면의 Client Secret',
    placeHolder: 'GOCSPX-...',
    password: true,
    ignoreFocusOut: true,
    validateInput: v => (v || '').trim() ? null : '비어있어요',
  });
  if (!clientSecret) return;

  /* OAuth dance — spin up a one-shot local HTTP server, open browser,
     wait for ?code=... callback, exchange. */
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: '🔐 Google 로그인 대기 중…',
    cancellable: true,
  }, async (progress, cancelToken) => {
    progress.report({ message: '브라우저에서 Google 로그인 진행하세요' });
    const result = await _runCalendarOAuthLoopback(clientId.trim(), clientSecret.trim(), cancelToken);
    if (!result.ok) {
      await vscode.window.showErrorMessage(`OAuth 실패: ${result.error || '알 수 없는 오류'}`);
      return;
    }
    /* Verify token works by hitting userinfo */
    let connectedAs = '';
    try {
      const r = await axios.get('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${result.accessToken}` },
        timeout: 8000, validateStatus: () => true,
      });
      if (r.status >= 200 && r.status < 300) {
        connectedAs = r.data?.email || r.data?.name || '';
      }
    } catch { /* non-fatal */ }
    writeCalendarWriteConfig({
      CLIENT_ID: clientId.trim(),
      CLIENT_SECRET: clientSecret.trim(),
      REFRESH_TOKEN: result.refreshToken,
      CALENDAR_ID: 'primary',
      DEFAULT_DURATION_MINUTES: 60,
      _CONNECTED_AS: connectedAs,
      _CONNECTED_AT: new Date().toISOString(),
    });
    /* Immediately pull upcoming events too so calendar_cache.md is fresh —
       this means OAuth users don't need to also configure the iCal tool. */
    const refresh = await refreshCalendarCacheViaOAuth(14).catch(e => ({ ok: false, count: 0, error: String(e?.message || e) }));
    const refreshNote = refresh.ok
      ? `\n\n📥 다가오는 일정 ${refresh.count}개도 회사 컨텍스트에 동기화됨 (iCal 도구 별도 셋업 불필요)`
      : '';
    await vscode.window.showInformationMessage(
      `✅ Google Calendar 연결 완료!${connectedAs ? ' (' + connectedAs + ')' : ''}\n\n이제 due 있는 작업이 추적기에 등록되면 자동으로 캘린더에 일정이 만들어집니다.${refreshNote}`
    );
  });
}

async function _runCalendarOAuthLoopback(
  clientId: string,
  clientSecret: string,
  cancelToken: vscode.CancellationToken
): Promise<{ ok: true; accessToken: string; refreshToken: string } | { ok: false; error: string }> {
  return new Promise(resolve => {
    const http = require('http');
    let _resolved = false;
    function _resolve(v: any) { if (_resolved) return; _resolved = true; resolve(v); }
    /* Bind to ephemeral port (0) — Google accepts any localhost port for
       Desktop-app OAuth clients. */
    const server = http.createServer((req: any, res: any) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const code = url.searchParams.get('code');
        const err = url.searchParams.get('error');
        /* Ignore non-callback requests (favicon.ico, etc.) — browsers send
           these automatically and they don't carry code/error params. Without
           this guard the second request races with the token exchange and
           resolves with 'no code'. */
        if (!code && !err) {
          res.writeHead(204);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (err) {
          res.end(`<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent OS — 인증 실패</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#080a0f;color:#e2e8f0;font-family:'SF Pro Display','Pretendard',-apple-system,system-ui,sans-serif;overflow:hidden}
body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(239,68,68,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(239,68,68,.03) 1px,transparent 1px);background-size:40px 40px;animation:gridDrift 20s linear infinite}
@keyframes gridDrift{from{transform:translateY(0)}to{transform:translateY(40px)}}
.card{position:relative;text-align:center;padding:48px 40px;max-width:440px;width:90vw;background:linear-gradient(180deg,rgba(15,8,8,.96),rgba(8,6,6,.99));border:1px solid rgba(239,68,68,.35);border-radius:20px;box-shadow:0 0 80px rgba(239,68,68,.12),0 30px 80px rgba(0,0,0,.7)}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,#ef4444,transparent);border-radius:20px 20px 0 0}
.brand{font-family:'SF Mono','JetBrains Mono',monospace;font-size:10px;letter-spacing:3.5px;color:rgba(239,68,68,.6);text-transform:uppercase;margin-bottom:28px}
.icon{font-size:56px;margin-bottom:16px;filter:drop-shadow(0 0 20px rgba(239,68,68,.4))}
h1{font-size:22px;font-weight:700;color:#ef4444;margin-bottom:10px;text-shadow:0 0 14px rgba(239,68,68,.3)}
.msg{font-size:13px;color:#94a3b8;line-height:1.6;margin-bottom:8px}
.err{font-family:'SF Mono',monospace;font-size:11px;color:rgba(239,68,68,.7);background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.15);border-radius:8px;padding:8px 14px;margin:16px 0}
.hint{font-size:12px;color:#64748b;margin-top:20px}
</style></head><body>
<div class="card">
<div class="brand">Connect · AI Solopreneur OS</div>
<div class="icon">🔴</div>
<h1>인증 실패</h1>
<div class="err">${err}</div>
<p class="msg">Agent OS로 돌아가서 다시 시도해주세요.</p>
<p class="hint">이 탭은 닫아도 됩니다.</p>
</div>
</body></html>`);
          server.close();
          _resolve({ ok: false, error: err });
          return;
        }
        res.end(`<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent OS — 인증 완료</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#080a0f;color:#e2e8f0;font-family:'SF Pro Display','Pretendard',-apple-system,system-ui,sans-serif;overflow:hidden}
body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(0,255,65,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(0,255,65,.03) 1px,transparent 1px);background-size:40px 40px;animation:gridDrift 20s linear infinite}
@keyframes gridDrift{from{transform:translateY(0)}to{transform:translateY(40px)}}
body::after{content:'';position:fixed;inset:0;background:linear-gradient(180deg,transparent 0,transparent 50%,rgba(0,255,65,.04) 50.2%,transparent 51%);background-size:100% 220px;animation:scan 5s linear infinite;pointer-events:none}
@keyframes scan{from{background-position:0 -220px}to{background-position:0 100vh}}
.card{position:relative;text-align:center;padding:48px 40px;max-width:440px;width:90vw;background:linear-gradient(180deg,rgba(8,14,10,.96),rgba(4,8,5,.99));border:1px solid rgba(0,255,65,.35);border-radius:20px;box-shadow:0 0 80px rgba(0,255,65,.12),0 30px 80px rgba(0,0,0,.7);animation:cardIn .7s cubic-bezier(.16,1,.3,1)}
@keyframes cardIn{from{opacity:0;transform:translateY(20px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,#00ff41,transparent);border-radius:20px 20px 0 0;animation:linePulse 2s ease-in-out infinite}
@keyframes linePulse{0%,100%{opacity:.6}50%{opacity:1}}
.brand{font-family:'SF Mono','JetBrains Mono',monospace;font-size:10px;letter-spacing:3.5px;color:rgba(0,255,65,.5);text-transform:uppercase;margin-bottom:28px}
.ring{position:relative;width:100px;height:100px;margin:0 auto 24px;display:flex;align-items:center;justify-content:center}
.ring::before,.ring::after{content:'';position:absolute;inset:0;border-radius:50%;border:1.5px solid rgba(0,255,65,.4);border-top-color:transparent;border-right-color:transparent}
.ring::before{animation:spin 2s linear infinite}
.ring::after{inset:10px;border-color:rgba(0,255,65,.25);border-bottom-color:transparent;animation:spin 3s linear infinite reverse}
@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
.icon{font-size:44px;position:relative;z-index:2;filter:drop-shadow(0 0 20px rgba(0,255,65,.5));animation:iconPop .5s .3s cubic-bezier(.16,1,.3,1) both}
@keyframes iconPop{from{transform:scale(0);opacity:0}to{transform:scale(1);opacity:1}}
h1{font-size:22px;font-weight:700;color:#00ff41;margin-bottom:10px;text-shadow:0 0 14px rgba(0,255,65,.3);animation:fadeUp .5s .5s ease both}
.msg{font-size:13px;color:#94a3b8;line-height:1.6;animation:fadeUp .5s .6s ease both}
.msg strong{color:#22c55e}
@keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.countdown{font-family:'SF Mono',monospace;font-size:11px;color:rgba(0,255,65,.4);letter-spacing:2px;margin-top:24px;animation:fadeUp .5s .8s ease both}
.particles{position:fixed;inset:0;pointer-events:none;overflow:hidden}
.p{position:absolute;width:3px;height:3px;background:#00ff41;border-radius:50%;box-shadow:0 0 6px #00ff41;opacity:0;animation:fly 2s ease-out forwards}
@keyframes fly{0%{opacity:1;transform:translate(0,0) scale(1)}100%{opacity:0;transform:translate(var(--dx),var(--dy)) scale(0)}}
</style></head><body>
<div class="particles" id="pts"></div>
<div class="card">
<div class="brand">Connect · AI Solopreneur OS</div>
<div class="ring"><span class="icon">✅</span></div>
<h1>인증 완료!</h1>
<p class="msg">Google Calendar가 <strong>Agent OS</strong>에 연결됐어요.<br>이 탭은 자동으로 닫힙니다.</p>
<p class="countdown" id="cd">3초 후 닫힘</p>
</div>
<script>
(function(){
var pts=document.getElementById('pts');
for(var i=0;i<24;i++){
var p=document.createElement('span');p.className='p';
var a=(i/24)*Math.PI*2,d=80+Math.random()*160;
p.style.left='50%';p.style.top='50%';
p.style.setProperty('--dx',Math.cos(a)*d+'px');
p.style.setProperty('--dy',Math.sin(a)*d+'px');
p.style.animationDelay=(Math.random()*.4)+'s';
if(i%3===0){p.style.background='#22d3ee';p.style.boxShadow='0 0 6px #22d3ee'}
if(i%5===0){p.style.background='#a78bfa';p.style.boxShadow='0 0 6px #a78bfa'}
pts.appendChild(p);
}
var s=3;var cd=document.getElementById('cd');
var t=setInterval(function(){s--;if(s<=0){clearInterval(t);cd.textContent='닫는 중…';window.close();}else{cd.textContent=s+'초 후 닫힘';}},1000);
})();
</script>
</body></html>`);
        const port = (server.address() && server.address().port) || 0;
        const redirectUri = `http://localhost:${port}`;
        /* Exchange code for tokens */
        axios.post(
          'https://oauth2.googleapis.com/token',
          new URLSearchParams({
            code: code!,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
          }).toString(),
          {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 12000,
            validateStatus: () => true,
          }
        ).then((r: any) => {
          server.close();
          if (r.status >= 200 && r.status < 300 && r.data?.refresh_token) {
            _resolve({ ok: true, accessToken: r.data.access_token || '', refreshToken: r.data.refresh_token });
          } else {
            _resolve({ ok: false, error: r.data?.error_description || r.data?.error || `HTTP ${r.status}` });
          }
        }).catch((e: any) => {
          server.close();
          _resolve({ ok: false, error: e?.message || String(e) });
        });
      } catch (e: any) {
        try { server.close(); } catch { /* ignore */ }
        _resolve({ ok: false, error: e?.message || String(e) });
      }
    });
    server.listen(0, '127.0.0.1', async () => {
      const port = (server.address() && server.address().port) || 0;
      if (!port) {
        resolve({ ok: false, error: 'failed to bind localhost port' });
        return;
      }
      const redirectUri = `http://localhost:${port}`;
      const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'https://www.googleapis.com/auth/calendar.events openid email',
        access_type: 'offline',
        prompt: 'consent',
      }).toString();
      try { await vscode.env.openExternal(vscode.Uri.parse(authUrl)); } catch { /* user can copy from log */ }
      console.log('[Agent OS] Calendar OAuth URL:', authUrl);
    });
    /* Cancel after 3 minutes max */
    const timer = setTimeout(() => {
      try { server.close(); } catch { /* ignore */ }
      _resolve({ ok: false, error: '시간 초과 (3분). 다시 시도해주세요.' });
    }, 180_000);
    cancelToken.onCancellationRequested(() => {
      clearTimeout(timer);
      try { server.close(); } catch { /* ignore */ }
      _resolve({ ok: false, error: '사용자가 취소함' });
    });
  });
}

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

function addTrackerTask(partial: Partial<TrackerTask> & { title: string; owner: TrackerTask['owner'] }): TrackerTask {
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
function _parseLooseDate(input: string): Date | null { return trk.parseLooseDate(input); }
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
function _harvestActionItems(text: string): string[] {
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

function trackerToMarkdown(opts: { onlyOpen?: boolean; max?: number } = {}): string {
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
function autoMarkTrackerFromDispatch(plan: { brief?: string; tasks?: { agent: string; task: string }[] } | null, sessionDir: string, ceoSynthesis: string) {
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
function rebuildUnifiedSchedule() {
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

function readAgentSharedContext(agentId: string, opts?: { lean?: boolean }): string {
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

function appendAgentMemory(agentId: string, line: string) {
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
function _getLastSpecialistOutput(): { agentId: string; agentName: string; body: string } | null {
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
async function saveAgentSkill(
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
function promoteGroundedClaimsFromOutput(agentId: string, output: string): number {
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
function routeBrainInjectionToAgents(filePath: string, fileName: string): string[] {
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

function readAgentGoal(agentId: string): string {
  try {
    const p = path.join(getCompanyDir(), '_agents', agentId, 'goal.md');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
  } catch { return ''; }
}

function writeAgentGoal(agentId: string, content: string) {
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
function writeAgentSelfRagCriteria(agentId: string, content: string) {
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

function writeToolConfig(agentId: string, toolName: string, config: Record<string, any>) {
  const p = path.join(getCompanyDir(), '_agents', agentId, 'tools', `${toolName}.json`);
  let existing: Record<string, any> = {};
  try {
    if (fs.existsSync(p)) existing = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch { /* malformed — overwrite cleanly */ }
  fs.writeFileSync(p, JSON.stringify({ ...existing, ...config }, null, 2));
}

/** Toggle a single tool's enabled flag without disturbing other config values. */
function setToolEnabled(agentId: string, toolName: string, enabled: boolean) {
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

function appendConversationLog(entry: { speaker: string; emoji?: string; section?: string; body: string }) {
  clog.appendLog(getCompanyDir(), entry);
}

export function readRecentConversations(maxChars = 2500): string {
  return clog.readRecent(getCompanyDir(), maxChars);
}

function makeSessionDir(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const dir = path.join(getCompanyDir(), 'sessions', ts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const CEO_PLANNER_PROMPT = _loadPrompt('ceo-planner.md');
/* Conversational CEO prompt — used for the casual-chat fast path so a "안녕"
   doesn't crash the JSON planner. Small models will reply with a polite
   greeting no matter how strict the JSON instruction; we detect those turns
   up front and route them here instead of fighting the model. */
const CEO_CHAT_PROMPT = _loadPrompt('ceo-chat.md');
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
function readSecretaryBridgeMode(): SecretaryBridgeMode {
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
const SECRETARY_TRIAGE_PROMPT = _loadPrompt('secretary-triage.md');
/* Heuristic for "this is small talk, not a work order". When true we skip
   the JSON planner and just have CEO chat back. Conservative: only matches
   short greetings/acks; anything longer or with action verbs falls through
   to the full planner. */
function _isCasualChat(text: string): boolean {
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

const CEO_REPORT_PROMPT = _loadPrompt('ceo-report.md');
const CONFER_PROMPT = _loadPrompt('confer.md');
const DECISIONS_EXTRACT_PROMPT = _loadPrompt('decisions-extract.md');
/* v2.87.11 — 에이전트가 외부 API에 의존할 때, 자격증명이 없으면 그 사실을
   에이전트 본인이 알고 사용자에게 입력해달라고 응답해야 함. 이 함수가
   sysPrompt에 명시적인 config 상태 블록을 주입한다. 키가 비어있으면 강제로
   "사용자에게 입력 요청하세요" 지시 포함. */
/* v2.89.10 — 진짜 데이터 prefetch. LLM 호출 전 시스템이 직접 도구 실행해서
   결과를 컨텍스트로 강제 주입. 이전 패턴은 에이전트가 <run_command>를 자발적
   출력해야만 발동됐는데, 작은 LLM은 자주 안 함 → 거짓말 (placeholder 데이터)
   양산. 이제 prefetch 결과가 있으면 에이전트가 거짓말 못 함 — 진짜 숫자 보고
   답하거나 "데이터에 없음"이라고 솔직히 말하거나. */
async function prefetchAgentRealtimeData(agentId: string): Promise<string> {
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

function buildAgentConfigStatus(agentId: string): string {
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

function buildSpecialistPrompt(agentId: string): string {
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
async function _safeGitAutoSync(brainDir: string, commitMsg: string, provider: any = null) {
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
async function _safeGitAutoSyncCompany(commitMsg: string, provider: any = null) {
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
interface BrainGraph {
    nodes: BrainNode[];
    links: BrainLink[];
    tags: string[];        // all unique tags found
}

function buildKnowledgeGraph(brainDir: string): BrainGraph {
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
function _RENDER_GRAPH_HTML(graphJson: string, isEmpty: boolean, forceGraphSrc: string, cspSource: string): string {
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

function _readYtOAuthClient(): { id: string; secret: string } {
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

async function startYouTubeOAuthFlow(): Promise<{ ok: boolean; message: string }> {
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
            const m = raw.match(/\{[\s\S]*\}/);
            if (!m) return;
            const parsed = JSON.parse(m[0]);
            if (!parsed || !Array.isArray(parsed.turns)) return;
            const validIds = SPECIALIST_IDS;
            const turns: { from: string; to: string; text: string }[] = [];
            for (const t of parsed.turns) {
                if (typeof t.from === 'string' && typeof t.to === 'string' && typeof t.text === 'string'
                    && validIds.includes(t.from) && validIds.includes(t.to)
                    && t.from !== t.to && t.text.trim().length > 0) {
                    turns.push({ from: t.from, to: t.to, text: t.text.trim().slice(0, 80) });
                }
            }
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
     *  graph panel. Called after brain-inject (EZER, A.U Training, etc.) so
     *  the user sees new knowledge appear immediately, plus a brief pulse
     *  on the freshly-added node. */
    public broadcastGraphRefresh(highlightTitle?: string) {
        try {
            const brainDir = _getBrainDir();
            if (!fs.existsSync(brainDir)) return;
            const graph = buildKnowledgeGraph(brainDir);
            const data = {
                nodes: graph.nodes.map(n => ({
                    id: n.id, name: n.name, folder: n.folder, tags: n.tags,
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
    private _sessionsKey(): string {
        return 'chatSessionsV1';
    }
    private _readSessions(): any[] {
        /* v2.89.108 — 타입 any[]로 완화. v2.89.106에선 좁은 타입이었지만, preview·workspace·
           workspaceName 메타가 추가되면서 너무 좁아짐. 내부 storage라 any로 충분. */
        try {
            const arr = this._ctx.globalState.get<any[]>(this._sessionsKey(), []);
            return Array.isArray(arr) ? arr : [];
        } catch { return []; }
    }
    private _writeSessions(sessions: any[]) {
        try {
            const trimmed = sessions.slice(0, 50);
            this._ctx.globalState.update(this._sessionsKey(), trimmed);
        } catch { /* ignore */ }
    }
    /* v2.89.108 — 세션을 프로젝트(워크스페이스)별로 그룹화하기 위한 메타 추가 */
    private _currentWorkspaceMeta(): { workspace: string; workspaceName: string } {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        let name = '';
        if (root) {
            try { name = path.basename(root); } catch { name = root; }
        } else {
            name = '워크스페이스 없음';
        }
        return { workspace: root, workspaceName: name };
    }
    private _archiveCurrentChat(): boolean {
        if (this._displayMessages.length === 0) return false;
        const sessions = this._readSessions();
        const firstUser = this._displayMessages.find(m => m.role === 'user');
        const titleSrc = firstUser?.text || this._displayMessages[0]?.text || '대화';
        const title = titleSrc.replace(/\s+/g, ' ').trim().slice(0, 80) || '대화';
        const lastMsg = this._displayMessages[this._displayMessages.length - 1];
        const preview = (lastMsg?.text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        const now = new Date().toISOString();
        const ws = this._currentWorkspaceMeta();
        const session: any = {
            id: 'sess-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
            title,
            preview,
            workspace: ws.workspace,
            workspaceName: ws.workspaceName,
            createdAt: now,
            updatedAt: now,
            messageCount: this._displayMessages.length,
            chat: this._chatHistory,
            display: this._displayMessages
        };
        sessions.unshift(session);  /* 최신이 위 */
        this._writeSessions(sessions);
        return true;
    }
    /* v2.89.107 — 현재 활성 세션의 ID. 복원 시 이 ID를 기억해두고 다음 archive
       때 "이미 archive에 있는 같은 세션" 이면 update만 (중복 방지). */
    private _activeSessionId: string | null = null;
    private _restoreSession(id: string): boolean {
        const sessions = this._readSessions();
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
        const sessions = this._readSessions();
        const idx = sessions.findIndex(s => s.id === id);
        if (idx < 0) return false;
        sessions.splice(idx, 1);
        this._writeSessions(sessions);
        return true;
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
            'connectAiThinking',
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
        const graphJson = JSON.stringify({
            nodes: graph.nodes.map(n => ({
                id: n.id, name: n.name, folder: n.folder, tags: n.tags,
                connections: n.incoming + n.outgoing
            })),
            links: graph.links
        });
        const isEmpty = graph.nodes.length === 0;
        return _RENDER_GRAPH_HTML(graphJson, isEmpty, forceGraphSrc, cspSource);
    }

    /** 메모리 누수 방지: 대화 이력 길이 제한 (최근 50건만 유지, 시스템 프롬프트는 보존) */
    private _pruneHistory() {
        const MAX_HISTORY = 50;
        const MAX_PER_MSG = 50_000; /* v2.90.1 — 옛 PDF 깨진 base64 가 메시지에 박혀 매 요청마다
                                       프롬프트 폭증 → Claude API 가 "Unexpected end of JSON input"
                                       반환. 메시지 1건당 50KB 로 잘라 누적 폭주 방지. */
        if (this._chatHistory.length > MAX_HISTORY + 1) {
            const sysIdx = this._chatHistory.findIndex(m => m.role === 'system');
            const sys = sysIdx >= 0 ? this._chatHistory[sysIdx] : null;
            const tail = this._chatHistory.slice(-MAX_HISTORY);
            this._chatHistory = sys ? [sys, ...tail] : tail;
        }
        for (const m of this._chatHistory) {
            if (typeof m.content === 'string' && m.content.length > MAX_PER_MSG) {
                m.content = m.content.slice(0, MAX_PER_MSG) + `\n\n[…메시지가 ${m.content.length} 자로 너무 커서 잘림]`;
            }
        }
        if (this._displayMessages.length > MAX_HISTORY) {
            this._displayMessages = this._displayMessages.slice(-MAX_HISTORY);
        }
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
        if (this._displayMessages.length === 0) return false;
        const sessions = this._readSessions();
        const now = new Date().toISOString();
        if (this._activeSessionId) {
            const idx = sessions.findIndex(s => s.id === this._activeSessionId);
            if (idx >= 0) {
                const lastMsg = this._displayMessages[this._displayMessages.length - 1];
                const preview = (lastMsg?.text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
                sessions[idx] = {
                    ...sessions[idx],
                    updatedAt: now,
                    messageCount: this._displayMessages.length,
                    preview,
                    chat: this._chatHistory,
                    display: this._displayMessages
                };
                /* 최신 위로 끌어올림 */
                const updated = sessions.splice(idx, 1)[0];
                sessions.unshift(updated);
                this._writeSessions(sessions);
                return true;
            }
        }
        return this._archiveCurrentChat();
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

    /** 외부에서 프롬프트 전송 (예: 코드 선택 → 설명, EZER 주입 등).
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
                            // ~/.connect-ai-brain (brain dir == company dir)
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
                                const targetParent = path.join(os.homedir(), '.connect-ai-brain-imported');
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
        // was closed (e.g. EZER injected knowledge before the user opened it).
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
        _autoSyncRunning = true;
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
            _autoSyncRunning = false;
        }
    }

    // 재귀 탐색 유틸리티 (하위 폴더까지 .md/.txt 파일 긁어옴)
    public _findBrainFiles(dir: string): string[] {
        let results: string[] = [];
        try {
            const list = fs.readdirSync(dir);
            for (const file of list) {
                const filePath = path.join(dir, file);
                const stat = fs.statSync(filePath);
                if (stat && stat.isDirectory()) {
                    if (file !== '.git' && file !== 'node_modules' && file !== '.obsidian') {
                        results = results.concat(this._findBrainFiles(filePath));
                    }
                } else {
                    if (file.endsWith('.md') || file.endsWith('.txt')) {
                        results.push(filePath);
                    }
                }
            }
        } catch (e) { /* skip unreadable dirs */ }
        return results;
    }

    // 목차(인덱스)만 생성 — 내용은 AI가 <read_brain>으로 직접 열람
    private _getSecondBrainContext(): string {
        const brainDir = _getBrainDir();
        if (!fs.existsSync(brainDir)) return '';

        const files = this._findBrainFiles(brainDir);
        if (files.length === 0) return '';

        // 컨텍스트 폭발 크래시(OOM)를 방지하기 위해 최대 인덱스 개수 제한
        const MAX_INDEX = 200;
        const index: string[] = [];
        let truncated = false;

        for (let i = 0; i < files.length; i++) {
            if (i >= MAX_INDEX) {
                truncated = true;
                break;
            }
            const file = files[i];
            const relativePath = path.relative(brainDir, file);
            try {
                const firstLine = fs.readFileSync(file, 'utf-8').split('\n').find(l => l.trim().length > 0) || '';
                // 제목 부분만 추출 (# 헤더 또는 첫 줄)
                const title = firstLine.replace(/^#+\s*/, '').slice(0, 80);
                index.push(`  📄 ${relativePath}  →  "${title}"`);
            } catch {
                index.push(`  📄 ${relativePath}`);
            }
        }

        const msgLimit = truncated ? `\n(⚠️ 메모리 폭발 방지를 위해 상위 ${MAX_INDEX}개 파일의 목차만 표시됩니다.)` : '';

        return `\n\n[CRITICAL: SECOND BRAIN INDEX — User's Personal Knowledge Base (${files.length} documents)]\nThe user has synced a personal knowledge repository. Below is the TABLE OF CONTENTS.${msgLimit}\nIf the user's query is even slightly related to any topics in this index, YOU MUST FIRST READ the relevant document BEFORE answering.\nTo read the actual content of any document, use EXACTLY this syntax: <read_brain>filename_or_path</read_brain>\nYou can call <read_brain> multiple times. ALWAYS READ THE FULL DOCUMENT BEFORE ANSWERING.\n\n**IMPORTANT: When your answer uses knowledge from the Second Brain, you MUST end your response with a "📚 출처" section listing the file(s) you referenced. Example:\n📚 출처: MrBeast_분석.md, 마케팅_전략.md**\n\n${index.join('\n')}\n\n`;
    }

    // AI가 <read_brain>태그로 요청한 파일의 실제 내용을 읽어서 반환
    private _readBrainFile(filename: string): string {
        const brainDir = _getBrainDir();
        if (!fs.existsSync(brainDir)) return '[ERROR] Second Brain이 동기화되지 않았습니다. 🧠 버튼을 먼저 눌러주세요.';

        // Path traversal 방어: brainDir 밖으로 나가는 경로는 차단
        const exactPath = safeResolveInside(brainDir, filename);
        if (exactPath && fs.existsSync(exactPath) && fs.statSync(exactPath).isFile()) {
            const content = fs.readFileSync(exactPath, 'utf-8');
            return content.slice(0, 8000); // 파일당 최대 8000자
        }

        // 파일명만으로 퍼지 검색 (하위 폴더에 있을 수 있으므로)
        const baseOnly = path.basename(filename);
        const allFiles = this._findBrainFiles(brainDir);
        const match = allFiles.find(f =>
            path.basename(f) === baseOnly ||
            path.basename(f) === baseOnly + '.md' ||
            (baseOnly.length > 2 && f.includes(baseOnly))
        );

        if (match) {
            // 결과 파일이 brainDir 안인지 한 번 더 확인
            const resolved = path.resolve(match);
            if (resolved.startsWith(path.resolve(brainDir) + path.sep)) {
                const content = fs.readFileSync(resolved, 'utf-8');
                return content.slice(0, 8000);
            }
        }

        return `[NOT FOUND] "${filename}" 파일을 Second Brain에서 찾을 수 없습니다. 목차(INDEX)를 다시 확인해주세요.`;
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
    // 워크스페이스 루트에 AGENT.md / CONNECT-AI.md / .connect-ai/instructions.md 가
    // 있으면 자동으로 시스템 프롬프트에 주입. 부모 디렉토리도 한 단계 거슬러
    // 올라가서 모노레포 root 메모리도 캡처. 없으면 빈 문자열.
    // 우선순위: 워크스페이스 root → 부모 → 홈(~/.connect-ai/global.md).
    // 한 파일당 8KB cap, 총 24KB cap. 같은 파일 중복 주입 방지.
    private _getProjectMemory(): string {
        const candidatePaths: string[] = [];
        const tried = new Set<string>();
        const filenames = ['AGENT.md', 'CONNECT-AI.md', 'CONNECTAI.md', 'CLAUDE.md', '.connect-ai/instructions.md'];
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const editor = vscode.window.activeTextEditor;
        const roots: string[] = [];
        if (root) roots.push(root);
        if (editor && editor.document.uri.scheme === 'file') {
            const dir = path.dirname(editor.document.uri.fsPath);
            if (!roots.includes(dir)) roots.push(dir);
        }
        /* 워크스페이스 root + 부모 root */
        for (const r of roots) {
            for (const fn of filenames) {
                candidatePaths.push(path.join(r, fn));
            }
            const parent = path.dirname(r);
            if (parent !== r) {
                for (const fn of filenames) candidatePaths.push(path.join(parent, fn));
            }
        }
        /* 홈 디렉토리 글로벌 메모리 */
        try {
            candidatePaths.push(path.join(os.homedir(), '.connect-ai', 'global.md'));
        } catch { /* ignore */ }
        const blocks: string[] = [];
        let totalChars = 0;
        const FILE_CAP = 8 * 1024;
        const TOTAL_CAP = 24 * 1024;
        for (const p of candidatePaths) {
            if (tried.has(p)) continue;
            tried.add(p);
            try {
                if (!fs.existsSync(p)) continue;
                const stat = fs.statSync(p);
                if (!stat.isFile() || stat.size === 0) continue;
                const raw = fs.readFileSync(p, 'utf-8');
                const truncated = raw.length > FILE_CAP;
                const body = truncated ? raw.slice(0, FILE_CAP) + '\n[…잘림…]' : raw;
                const display = p.replace(os.homedir(), '~');
                blocks.push(`### 📌 ${display}\n${body.trim()}`);
                totalChars += body.length;
                if (totalChars >= TOTAL_CAP) break;
            } catch { /* skip unreadable */ }
        }
        if (blocks.length === 0) return '';
        return `\n\n[PROJECT MEMORY — 사용자가 명시적으로 정한 프로젝트 규칙·금지사항·우선순위. 절대 무시하지 말 것.]\n${blocks.join('\n\n')}`;
    }

    // Build workspace file tree + read key files
    // --------------------------------------------------------
    private _getWorkspaceContext(): string {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) { return ''; }

        // --- 1. File tree ---
        const lines: string[] = [];
        let count = 0;

        const walk = (dir: string, prefix: string) => {
            if (count >= getConfig().maxTreeFiles) { return; }
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch { return; }

            entries.sort((a, b) => {
                if (a.isDirectory() && !b.isDirectory()) { return -1; }
                if (!a.isDirectory() && b.isDirectory()) { return 1; }
                return a.name.localeCompare(b.name);
            });

            for (const entry of entries) {
                if (count >= getConfig().maxTreeFiles) { break; }
                if (EXCLUDED_DIRS.has(entry.name)) { continue; }
                if (entry.name.startsWith('.') && entry.isDirectory()) { continue; }

                if (entry.isDirectory()) {
                    lines.push(`${prefix}📁 ${entry.name}/`);
                    count++;
                    walk(path.join(dir, entry.name), prefix + '  ');
                } else {
                    lines.push(`${prefix}📄 ${entry.name}`);
                    count++;
                }
            }
        };
        walk(root, '');

        let result = '';
        if (lines.length > 0) {
            result += `\n\n[WORKSPACE INFO]\n📂 경로: ${root}\n\n[프로젝트 파일 구조]\n${lines.join('\n')}`;
        }

        // --- 2. Auto-read key project files ---
        const keyFiles = [
            'package.json', 'tsconfig.json', 'vite.config.ts', 'vite.config.js',
            'next.config.js', 'next.config.ts', 'README.md',
            'index.html', 'app.js', 'app.ts', 'main.ts', 'main.js',
            'src/index.ts', 'src/index.js', 'src/App.tsx', 'src/App.jsx',
            'src/main.ts', 'src/main.js'
        ];
        let totalRead = 0;
        const MAX_AUTO_READ = 6_000; // chars total

        for (const kf of keyFiles) {
            if (totalRead >= MAX_AUTO_READ) { break; }
            const abs = path.join(root, kf);
            if (fs.existsSync(abs)) {
                try {
                    const content = fs.readFileSync(abs, 'utf-8');
                    if (content.length < 5000) {
                        result += `\n\n[파일 내용: ${kf}]\n\`\`\`\n${content}\n\`\`\``;
                        totalRead += content.length;
                    }
                } catch { /* skip */ }
            }
        }

        return result;
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

        const tmpDir = path.join(os.tmpdir(), `connect-ai-upload-${Date.now()}-${Math.random().toString(36).slice(2,8)}`);
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
                const editor = vscode.window.activeTextEditor;
                let contextBlock = '';
                if (editor && editor.document.uri.scheme === 'file') {
                    const text = editor.document.getText();
                    const name = path.basename(editor.document.fileName);
                    if (text.trim().length > 0 && text.length < MAX_CONTEXT_SIZE) {
                        contextBlock = `\n\n[Currently open file: ${name}]\n\`\`\`\n${text}\n\`\`\``;
                    }
                }
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
            let errMsg = '';
            if (/ENOENT|not found/i.test(msg)) {
                errMsg = `⚠️ Claude CLI 를 찾지 못했어요.\n\n**해결 방법:**\n• 터미널에서 \`which claude\` 로 경로 확인\n• 없으면 https://docs.claude.com/en/docs/claude-code/setup 따라 설치 후 \`claude login\`\n• 설치 경로가 PATH 에 없으면 settings.json 의 \`agentOs.claudeBinPath\` 에 절대경로 입력\n\n💡 **명령 팔레트 (Cmd+Shift+P) → "Agent OS: 연결 진단"** 실행하면 자동 체크해드려요.`;
            } else if (/timed out|timeout/i.test(msg)) {
                errMsg = `⚠️ Claude 응답이 너무 오래 걸려요.\n\n**해결 방법:**\n• 질문을 짧게 줄여보기\n• 사용량 한도 (Claude Max 5시간 윈도우) 가 거의 다 찼는지 확인`;
            } else if (/aborted/i.test(msg)) {
                errMsg = `⚠️ 응답이 중간에 취소됐어요.`;
            } else if (/Unexpected end of JSON input|Unexpected token|prompt is too long|maximum context length/i.test(msg)) {
                /* v2.90.1 — 이전 PDF 첨부가 chatHistory 에 깨진 base64 로 박혀 있을 때 자주 발생.
                   사용자에게 새 대화 시작을 권장. */
                errMsg = `⚠️ 프롬프트가 너무 크거나 망가졌어요. (${msg})\n\n**해결 방법:**\n• 좌측 상단 **+ 새 대화** 버튼으로 대화 초기화\n• PDF 다시 첨부해서 시도\n\n_이전에 깨진 PDF 첨부 잔재가 히스토리에 쌓여 있을 가능성이 큽니다._`;
            } else {
                errMsg = `⚠️ 오류: ${msg}`;
            }

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
            const editor = vscode.window.activeTextEditor;
            let contextBlock = '';
            if (editor && editor.document.uri.scheme === 'file') {
                const text = editor.document.getText();
                const name = path.basename(editor.document.fileName);
                if (text.trim().length > 0 && text.length < MAX_CONTEXT_SIZE) {
                    contextBlock = `\n\n[Currently open file: ${name}]\n\`\`\`\n${text}\n\`\`\``;
                }
            }

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

            // 4) 각 specialist 순차 호출
            const outputs: Record<string, string> = {};
            /* v2.89.51 — 작업 라운드 메타데이터 추적. 어떤 도구를 썼고, 어떤 데이터를
               받았고, 핵심 산출이 뭔지를 CEO 보고에 포함시켜 사용자가 한눈에 파악. */
            const agentMeta: Record<string, {
                task: string;
                toolsUsed: string[];           // 실행한 Python 도구 목록
                prefetchSummary: string;       // prefetch가 가져온 데이터 요약 (1줄)
                outputSummary: string;          // 산출물 첫 줄·평가
                outputLength: number;
            }> = {};
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
                /* v2.89.131 — 최근 파일 액션 컨텍스트. 코다리가 직전에 만든 파일의 절대
                   경로를 잊고 "_agents/developer/test/" 같은 추측 경로로 list_files
                   호출해 실패하던 사고 차단. */
                const recentFilesCtx = this._buildRecentFilesContext(t.agent);
                const sysPrompt = `${buildSpecialistPrompt(t.agent)}${this._getProjectMemory()}${buildAgentConfigStatus(t.agent)}${realtimeData}${readAgentSharedContext(t.agent, { lean: useLeanContext })}${peerCtx}${hallucinationGuard}${recentFilesCtx}`;
                const userMsg = `[CEO의 지시]\n${t.task}\n\n[원 사용자 명령 참고]\n${prompt}`;

                let out = '';
                /* v2.89.133 — 키트 shortcut. 명시적 호출(`코다리야 ...`) + 두뇌 키트
                   강하게 매칭되는 명령이면 LLM 호출 자체 건너뛰고 pack_apply 직접 실행.
                   LM Studio 죽어있거나 context 모자라도 시연 깨지지 않음.
                   조건: explicit 호출 + t.agent === developer + 매칭 점수 ≥ 10. */
                let shortcut: string | null = null;
                if (explicit && t.agent === 'developer') {
                    shortcut = this._tryKitShortcut(t.agent, prompt);
                }
                /* v2.89.147 — business 매출 shortcut. business 에이전트 + 매출/PayPal
                   키워드면 explicit 여부 무관 LLM 우회. 종합 보고서에서 CEO 가 business 에
                   분배한 경우도 동일하게 paypal_revenue.py 실데이터 직접 표시. 작은
                   LLM(gemma-2B) 이 system prompt 무시하고 README 읽으려는 버릇 차단. */
                if (!shortcut && t.agent === 'business') {
                    const lower = prompt.toLowerCase();
                    if (/매출|수익|결제|paypal|revenue|매상|매월|이번 달|이번달|월 매출|페이팔|돈|얼마 벌/.test(lower)) {
                        shortcut = await this._tryRevenueShortcut(prompt);
                    }
                }
                if (shortcut) {
                    out = shortcut;
                    /* 사무실에 작업 시작 신호 한 번 → 사용자가 코다리 카드 펄스 봄 */
                    try {
                        this._broadcastCorporate({ type: 'agentBusy', agent: t.agent, elapsedSec: 0 });
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
                        this._broadcastCorporate({
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
                    out = await this._callAgentLLM(sysPrompt, userMsg, modelName, t.agent, true, {
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
                        return;
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
                                if (this._telegramMirrorPending) {
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
                    const fr = await this._executeActions(out, {
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
                            if (this._telegramMirrorPending) {
                                await sendTelegramLong(setupMsg);
                                _pushTelegramHistory('assistant', 'OAuth 셋업 필요 — Client ID/Secret 입력 안내');
                            }
                        } else {
                            /* Client 있음 — 자동으로 브라우저 열기. fire-and-forget으로 dispatch 진행 안 막음. */
                            post({ type: 'response', value: '🔐 YouTube OAuth 인증 창을 자동으로 띄울게요...' });
                            if (this._telegramMirrorPending) {
                                await sendTelegramReport(`🔐 *Analytics OAuth 인증 시작* — 브라우저가 자동으로 열려요. Google 계정 승인 후 분석 다시 요청해주세요.`);
                            }
                            startYouTubeOAuthFlow().then(r => {
                                try {
                                    if (r.ok) {
                                        _activeChatProvider?.postSystemNote?.('✅ YouTube OAuth 연결 완료 — 다시 분석 요청해주세요.', '🔐');
                                        if (this._telegramMirrorPending !== undefined) {
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
                    this._telegramMirrorPending = false;
                    break;
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
                        if (this._telegramMirrorPending) {
                            await sendTelegramLong(`${headline}\n\n${cleaned.slice(0, 1500)}`);
                            _pushTelegramHistory('assistant', `${a.name}: ${cleaned.slice(0, 200)}`);
                        }
                        post({ type: 'response', value: `⛔ ${a.emoji} ${a.name}가 자격증명 부족으로 멈췄어요${this._telegramMirrorPending ? ' (텔레그램 알림 발송)' : ''}.` });
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
                    this._telegramMirrorPending = false;
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

            if (isAborted()) {
                post({ type: 'error', value: '🛑 사용자가 중단했어요.' });
                return;
            }
            // 4.5) 에이전트 간 자율 대화 (Confer) — 2명 이상일 때만
            const conferTurns: { from: string; to: string; text: string }[] = [];
            if (plan.tasks.length >= 2) {
                try {
                    const conferInput = `[원 명령]\n${prompt}\n\n[산출물 요약]\n${plan.tasks.map(t => `\n## ${AGENTS[t.agent]?.name}\n${(outputs[t.agent] || '').slice(0, 800)}`).join('\n')}`;
                    const conferRaw = await this._callAgentLLM(_personalizePrompt(CONFER_PROMPT), conferInput, modelName, 'ceo', false);
                    const m = conferRaw.match(/\{[\s\S]*\}/);
                    const parsed = JSON.parse(m ? m[0] : conferRaw);
                    if (parsed && Array.isArray(parsed.turns)) {
                        const validIds = SPECIALIST_IDS;
                        for (const t of parsed.turns) {
                            if (typeof t.from === 'string' && typeof t.to === 'string' && typeof t.text === 'string'
                                && validIds.includes(t.from) && validIds.includes(t.to)
                                && t.from !== t.to && t.text.trim().length > 0) {
                                conferTurns.push({ from: t.from, to: t.to, text: t.text.trim().slice(0, 80) });
                            }
                        }
                    }
                } catch { /* confer 실패는 silent */ }

                if (conferTurns.length > 0) {
                    post({ type: 'agentConfer', turns: conferTurns });
                    // Phase 1: log all confer turns into the running transcript
                    const conferBody = conferTurns
                        .map(t => `- ${AGENTS[t.from]?.emoji || ''} **${AGENTS[t.from]?.name || t.from}** → ${AGENTS[t.to]?.emoji || ''} ${AGENTS[t.to]?.name || t.to}: ${t.text}`)
                        .join('\n');
                    appendConversationLog({ speaker: '팀 회의', emoji: '💬', section: '에이전트 간 대화', body: conferBody });
                    // 사무실 시각화가 자연스럽게 흐르도록 대기 (캐릭터 walk + bubble + return)
                    await new Promise(r => setTimeout(r, Math.min(conferTurns.length * 4500, 22000)));
                }
            }

            if (isAborted()) {
                post({ type: 'error', value: '🛑 사용자가 중단했어요.' });
                return;
            }
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
                    ceoNarrative = await this._callAgentLLM(
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

            // 5.5) 자가학습 — 결정 추출 → decisions.md에 자동 append
            const learnedDecisions: string[] = [];
            try {
                const learnInput = `[원 명령]\n${prompt}\n\n[보고서]\n${finalReport.slice(0, 2500)}\n\n[대화]\n${conferTurns.map(t => `${AGENTS[t.from]?.name} → ${AGENTS[t.to]?.name}: ${t.text}`).join('\n')}`;
                const learnRaw = await this._callAgentLLM(DECISIONS_EXTRACT_PROMPT, learnInput, modelName, 'ceo', false);
                const m = learnRaw.match(/\{[\s\S]*\}/);
                const parsed = JSON.parse(m ? m[0] : learnRaw);
                if (parsed && Array.isArray(parsed.decisions)) {
                    for (const d of parsed.decisions) {
                        if (typeof d === 'string' && d.trim().length > 0 && d.trim().length <= 80) {
                            learnedDecisions.push(d.trim());
                        }
                    }
                }
            } catch { /* silent */ }

            if (learnedDecisions.length > 0) {
                try {
                    const dir = getCompanyDir();
                    const decPath = path.join(dir, '_shared', 'decisions.md');
                    if (!fs.existsSync(decPath)) {
                        fs.writeFileSync(decPath, `# 📌 회사 의사결정 로그\n\n_자가학습이 자동 누적합니다. 잘못된 항목은 직접 삭제하세요._\n`);
                    }
                    const ts = new Date().toISOString().slice(0, 10);
                    const block = `\n## [${ts}] ${prompt.slice(0, 60)}\n${learnedDecisions.map(d => `- ${d}`).join('\n')}\n_세션: ${path.basename(sessionDir)}_\n`;
                    fs.appendFileSync(decPath, block);
                } catch { /* ignore */ }
                post({ type: 'decisionsLearned', decisions: learnedDecisions });
            }

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
            const brainDir = path.join(os.homedir(), '.connect-ai-brain');
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
        if (!agentId) return;
        const now = Date.now();
        /* 같은 파일·같은 액션 직전 기록 있으면 시간만 갱신 (중복 방지) */
        const dup = this._recentFileActions.find(r => r.absPath === absPath && r.agentId === agentId);
        if (dup) {
            dup.action = action;
            dup.ts = now;
        } else {
            this._recentFileActions.push({ agentId, absPath, action, ts: now });
        }
        /* 30분 묵은 건 제거 + 최대 20개 cap (오래된 것부터 잘림) */
        const cutoff = now - 30 * 60 * 1000;
        this._recentFileActions = this._recentFileActions.filter(r => r.ts > cutoff);
        if (this._recentFileActions.length > 20) {
            this._recentFileActions = this._recentFileActions.slice(-20);
        }
    }

    /** v2.89.132 — 명시적 에이전트 호출 감지. "코다리야 …"·"@developer …"·"개발자야 …"
     *  처럼 사용자가 직접 이름 부른 경우 CEO 단계를 건너뛰고 그 에이전트에게만 dispatch.
     *  사용자 의도 존중 + 단순 작업의 처리 시간 5배 단축 (CEO LLM 호출 1회 + 다른
     *  specialist 4명 호출 제거). 자연어로만 명령한 경우는 None 반환 → 기존 CEO 분배. */
    private _detectExplicitMention(prompt: string): { agentId: string; agentName: string } | null {
        const lower = prompt.toLowerCase();
        /* 호출 후보: 한글 닉네임·영문 id·역할 키워드 → agentId 매핑.
           우선순위 높은 것부터 (코다리 같은 고유 닉네임이 일반어 "개발자"보다 강함). */
        const candidates: Array<{ patterns: RegExp[]; agentId: string; agentName: string }> = [
            { patterns: [/개발신[야아!,~ ]/, /개발신아/, /@developer\b/, /@개발신\b/], agentId: 'developer', agentName: '개발신' },
            { patterns: [/제프베조스[야아!,~ ]/, /베조스[야아!,~ ]/, /제프[야아!,~ ]/, /@business\b/, /@제프베조스\b/, /@베조스\b/], agentId: 'business', agentName: '제프베조스' },
            { patterns: [/한스짐머[야아!,~ ]/, /짐머[야아!,~ ]/, /@editor\b/, /@한스짐머\b/, /@짐머\b/], agentId: 'editor', agentName: '한스짐머' },
            { patterns: [/레오[야아!,~ ]/, /레오야/, /@youtube\b/, /@레오\b/], agentId: 'youtube', agentName: '레오' },
            { patterns: [/카리나[야아!,~ ]/, /카리나야/, /@secretary\b/, /@카리나\b/], agentId: 'secretary', agentName: '카리나' },
            { patterns: [/일론머스크[야아!,~ ]/, /일론[야아!,~ ]/, /머스크[야아!,~ ]/, /@ceo\b/, /@일론머스크\b/, /@일론\b/], agentId: 'ceo', agentName: '일론머스크' },
            { patterns: [/박재범[야아!,~ ]/, /재범[야아!,~ ]/, /@instagram\b/, /@박재범\b/, /@재범\b/], agentId: 'instagram', agentName: '박재범' },
            { patterns: [/조나단아이브[야아!,~ ]/, /조나단[야아!,~ ]/, /아이브[야아!,~ ]/, /@designer\b/, /@조나단아이브\b/, /@조나단\b/], agentId: 'designer', agentName: '조나단아이브' },
            { patterns: [/셰익스피어[야아!,~ ]/, /셰익[야아!,~ ]/, /@writer\b/, /@셰익스피어\b/], agentId: 'writer', agentName: '셰익스피어' },
            { patterns: [/아인슈타인[야아!,~ ]/, /아인슈[야아!,~ ]/, /@researcher\b/, /@아인슈타인\b/], agentId: 'researcher', agentName: '아인슈타인' },
            /* 역할 호칭 — 단, 자연스러운 명령에서 잘못 매칭 안 되게 "야"·"!"·"," 같은 호격 표지 필요 */
            { patterns: [/개발자[야아!,]/, /@developer\b/], agentId: 'developer', agentName: '개발자' },
            { patterns: [/디자이너[야아!,]/, /@designer\b/], agentId: 'designer', agentName: '디자이너' },
            { patterns: [/작가[야아!,]/, /@writer\b/], agentId: 'writer', agentName: '작가' },
            { patterns: [/리서처[야아!,]/, /@researcher\b/], agentId: 'researcher', agentName: '리서처' },
            { patterns: [/인스타[야아!,]/, /@instagram\b/], agentId: 'instagram', agentName: '인스타' },
        ];
        for (const c of candidates) {
            for (const p of c.patterns) {
                if (p.test(prompt) || p.test(lower)) {
                    /* 활성 상태인지 확인 — 비활성 에이전트면 CEO 분배로 fallback */
                    if (isAgentActive(c.agentId)) {
                        return { agentId: c.agentId, agentName: c.agentName };
                    }
                }
            }
        }
        return null;
    }

    /** v2.89.145 — 매출 shortcut. 명시적 현빈 호출 + 매출 키워드면 LLM 우회하고
     *  paypal_revenue.py 의 마크다운 리포트 + 한 줄 코멘트 직접 표시. 작은 LLM이
     *  prefetch 무시하고 README 읽으려 하는 버릇 차단.
     *
     *  paypal_revenue.json 자격증명 없으면 친절 안내. 호출 실패하면 null →
     *  기존 LLM 흐름으로 fallback.
     */
    private async _tryRevenueShortcut(userPrompt: string): Promise<string | null> {
        const ppToolDir = path.join(getCompanyDir(), '_agents', 'business', 'tools');
        const ppScript = path.join(ppToolDir, 'paypal_revenue.py');
        const ppJson = path.join(ppToolDir, 'paypal_revenue.json');
        if (!fs.existsSync(ppScript) || !fs.existsSync(ppJson)) return null;
        let cfg: any = {};
        try { cfg = JSON.parse(_safeReadText(ppJson) || '{}'); } catch { return null; }
        if (!cfg.CLIENT_ID || !cfg.CLIENT_SECRET) {
            return `💼 제프베조스: 사장님, PayPal Client ID 또는 Secret 이 비어있어 매출을 가져올 수 없어요.

📋 **해결 단계**:
1. \`Cmd+Shift+P\` → \`Agent OS: 외부 연결\`
2. 💰 PayPal 카드 → Client ID + Secret 입력
3. 저장 → 즉시 매출 분석 가능

📊 평가: 대기 — PayPal 자격증명 입력 후 재시도.
📝 다음 단계: 사장님이 PayPal Developer Dashboard 에서 Client ID/Secret 복사 → 외부 연결 패널 입력.
`;
        }
        try {
            const env = { ...process.env, LOOKBACK_DAYS: String(cfg.LOOKBACK_DAYS || 30) };
            const r = await new Promise<{ exitCode: number; output: string; stderr: string }>((resolve) => {
                const cp = require('child_process');
                const p = cp.spawn(_pythonCmd(), [ppScript], { cwd: ppToolDir, env });
                let out = '', err = '';
                p.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
                p.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
                p.on('close', (code: number) => resolve({ exitCode: code, output: out, stderr: err }));
                setTimeout(() => { try { p.kill(); } catch {} resolve({ exitCode: -1, output: out, stderr: err }); }, 25000);
            });
            if (r.exitCode !== 0 || !r.output) {
                return `💼 제프베조스: PayPal 데이터 가져오기 실패. ${r.stderr.slice(-150) || ''}

📋 외부 연결 패널에서 Client ID/Secret 다시 확인 후 재시도.
📊 평가: 대기 — 자격증명 확인 필요.
📝 다음 단계: \`Cmd+Shift+P\` → \`Agent OS: 외부 연결\` 에서 PayPal 카드 점검.
`;
            }
            const insight = `💼 제프베조스: 사장님, 실시간 PayPal 데이터 가져왔습니다. 즉시 분석 결과 보여드려요.\n\n`;
            const footer = `\n\n📊 평가: 완료 — 실데이터 기반 분석 (LLM 우회, 환각 없음).\n📝 다음 단계: 위 "💡 다음 액션" 섹션 참고하시고, 더 깊이 분석 필요하면 매출 대시보드 (\`Cmd+Shift+P → 매출 대시보드\`) 에서 시각화 확인.\n`;
            return insight + r.output + footer;
        } catch (e: any) {
            return null;
        }
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
        if (agentId !== 'developer') return null;
        const a = AGENTS[agentId];
        if (!a) return null;

        const lowerPrompt = userPrompt.toLowerCase();
        const brainDir = _getBrainDir();
        const kitsRoot = path.join(brainDir, '40_템플릿', 'developer');
        if (!fs.existsSync(kitsRoot)) return null;

        let best: { kit: string; score: number; manifest: any } | null = null;
        try {
            for (const dirent of fs.readdirSync(kitsRoot, { withFileTypes: true })) {
                if (!dirent.isDirectory()) continue;
                const kitName = dirent.name;
                const manifestPath = path.join(kitsRoot, kitName, 'manifest.json');
                if (!fs.existsSync(manifestPath)) continue;
                let manifest: any;
                try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')); }
                catch { continue; }

                let score = 0;
                const kws: string[] = Array.isArray(manifest.keywords) ? manifest.keywords : [];
                for (const k of kws) {
                    const kl = String(k).toLowerCase();
                    if (kl && lowerPrompt.includes(kl)) score += 10;
                }
                const nameStr = String(manifest.name || '').toLowerCase();
                if (nameStr && lowerPrompt.includes(nameStr)) score += 5;
                const cat = String(manifest.category || '').toLowerCase();
                if (cat && lowerPrompt.includes(cat)) score += 3;

                if (score > 0 && (!best || score > best.score)) {
                    best = { kit: kitName, score, manifest };
                }
            }
        } catch { return null; }

        if (!best || best.score < 10) return null;

        /* v2.89.134 — PROJECT_PATH 자동 생성. pack_apply 가 빈 경로 거부 안 하게.
           폴더명: 키트 이름에서 '-kit' suffix 제거 + timestamp 안 붙여서 매번 같은
           폴더 (기존 파일 덮어쓰지만 .backup 자동 보존). */
        const escapedIntent = userPrompt.replace(/"/g, '\\"');
        const projectName = best.kit.replace(/-kit$/, '');
        const projectDir = path.join(os.homedir(), 'connect-ai-projects', projectName);
        const toolsDir = path.join(getCompanyDir(), '_agents', 'developer', 'tools').replace(/\\/g, '/');
        const projectDirShell = projectDir.replace(/\\/g, '/');
        const brainRootShell = brainDir.replace(/\\/g, '/');

        /* 매니페스트의 apply.open_in_browser 가 있으면 그 파일을 open. 없으면 index.html
           이 있을 가능성에 베팅 (대부분의 vanilla 키트). */
        const openTarget = best.manifest?.apply?.open_in_browser || 'index.html';

        /* v2.89.152 — 크로스플랫폼. 윈도우 cmd 는 `mkdir -p`·inline env vars 미지원.
           Python 자체로 mkdir + CLI 인자로 모든 값 전달 → 모든 OS 동일 동작.
           pack_apply 는 v4 부터 CLI 인자 지원 (`--kit X --user-intent Y --project Z`). */
        const isWin = process.platform === 'win32';
        const pyCmd = _pythonCmd();
        const openCmd = isWin ? `start "" "${projectDirShell}\\${openTarget}"`.replace(/\//g, '\\')
            : (process.platform === 'darwin' ? `open "${projectDirShell}/${openTarget}"` : `xdg-open "${projectDirShell}/${openTarget}"`);

        const fakeOutput = `${a.emoji} ${a.name}: 명시적 호출 + 매칭 키트 발견. LLM 우회 — 시스템이 직접 \`${best.kit}\` 적용합니다.

> 📋 매칭 점수: **${best.score}점** (\`${best.manifest.name || best.kit}\`)
> 📁 대상 프로젝트: \`${projectDir.replace(os.homedir(), '~')}\`
> 💡 \`pack_apply.py\` 즉시 실행 → 키트 파일 복사·설정 자동화.

<run_command>${pyCmd} -c "import os; os.makedirs(r'${projectDirShell}', exist_ok=True)" && cd "${toolsDir}" && ${pyCmd} pack_apply.py --kit "${best.kit}" --user-intent "${escapedIntent}" --project "${projectDirShell}" --brain-root "${brainRootShell}"</run_command>

<run_command>${openCmd}</run_command>

📊 평가: 완료 — 키트 적용 + 결과 파일 자동 오픈까지 시스템이 처리.
📝 다음 단계: 브라우저에 결과 보임. 코드 커스터마이즈는 \`${projectDir.replace(os.homedir(), '~')}/\` 폴더에서.
`;
        return fakeOutput;
    }

    /** v2.89.131 — fuzzy path hint. list_files/read_file 이 디렉토리 못 찾을 때
     *  비슷한 이름의 디렉토리를 _recentFileActions + 회사 폴더 하위에서 탐색해 제안.
     *  코다리가 "_agents/developer/test/" 추측 → 실제 "_company/test/" 매핑 자동 회복. */
    private _fuzzyPathHint(missingPath: string): string {
        const baseName = path.basename(missingPath);
        if (!baseName || baseName === '.' || baseName === '/') return '';
        const seen = new Set<string>();
        const hits: string[] = [];
        /* 1) 최근 액션 안에 같은 basename 가진 파일 있으면 1순위 */
        for (const r of this._recentFileActions) {
            if (path.basename(r.absPath) === baseName || r.absPath.includes(`/${baseName}/`) || r.absPath.endsWith(`/${baseName}`)) {
                const parent = path.dirname(r.absPath);
                if (!seen.has(parent)) {
                    seen.add(parent);
                    hits.push(parent);
                }
            }
        }
        /* 2) 회사 폴더 1~2단계 깊이만 빠르게 스캔 */
        try {
            const companyDir = getCompanyDir();
            if (companyDir && fs.existsSync(companyDir)) {
                const queue: Array<{ dir: string; depth: number }> = [{ dir: companyDir, depth: 0 }];
                while (queue.length > 0 && hits.length < 5) {
                    const { dir, depth } = queue.shift()!;
                    if (depth > 2) continue;
                    let entries: fs.Dirent[];
                    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
                    for (const e of entries) {
                        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '_agents') continue;
                        if (e.isDirectory()) {
                            const full = path.join(dir, e.name);
                            if (e.name === baseName && !seen.has(full)) {
                                seen.add(full);
                                hits.push(full);
                            }
                            if (depth < 2) queue.push({ dir: full, depth: depth + 1 });
                        }
                    }
                }
            }
        } catch { /* ignore */ }
        if (hits.length === 0) return '';
        const lines = hits.slice(0, 3).map(p => `  • ${p}`).join('\n');
        return `\n💡 비슷한 경로 발견 — 다음 중 하나 의도였나요?\n${lines}\n   → 정확한 절대 경로로 다시 시도하세요.`;
    }

    /** v2.89.131 — system prompt 주입용 블록. 해당 에이전트가 최근 만진 파일들의
     *  절대 경로 리스트. 코다리가 "방금 만든 파일 어디?"라고 물을 일 자체 차단. */
    private _buildRecentFilesContext(agentId: string): string {
        const mine = this._recentFileActions
            .filter(r => r.agentId === agentId)
            .slice(-10);
        if (mine.length === 0) return '';
        const lines = mine.map(r => {
            const label = r.action === 'create' ? '✅ 생성' : r.action === 'edit' ? '✏️ 편집' : '🗑️ 삭제';
            const mins = Math.max(1, Math.round((Date.now() - r.ts) / 60000));
            return `  - ${label}: ${r.absPath}  (${mins}분 전)`;
        }).join('\n');
        return `\n\n[🗂️ 당신이 최근 작업한 파일들 — 절대 경로 정확]\n${lines}\n\n` +
               `⚠️ 이전에 만든 파일을 다시 참조할 때 이 절대 경로를 그대로 사용하세요. 추측 금지. "내 도구 폴더 기준 상대 경로"로 변환하지 마세요.\n`;
    }

    private async _executeActions(
        aiMessage: string,
        opts?: { rootOverride?: string; appendToOutput?: (s: string) => void; silent?: boolean; skipRunCommand?: boolean; agentId?: string }
    ): Promise<string[]> {
        const report: string[] = [];
        let brainModified = false;
        /* v2.89.93 — root 결정 우선순위:
             1. 호출자가 명시한 rootOverride (회사 모드)
             2. 워크스페이스 폴더
             3. 활성 에디터 디렉토리
             4. 회사 폴더 (회사 모드 활성 시)
             5. 두뇌 폴더 (마지막 fallback)
           이전엔 1·2만 있어서 워크스페이스 미오픈 사용자가 영영 차단됐음. */
        let rootPath = opts?.rootOverride
            || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
            || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.scheme === 'file'
                ? path.dirname(vscode.window.activeTextEditor.document.uri.fsPath)
                : undefined);
        let usedFallbackRoot = false;
        if (!rootPath) {
            try {
                const compDir = getCompanyDir();
                if (compDir && fs.existsSync(compDir)) { rootPath = compDir; usedFallbackRoot = true; }
            } catch { /* ignore */ }
        }
        if (!rootPath) {
            try {
                const brainDir = _getBrainDir();
                if (brainDir && fs.existsSync(brainDir)) { rootPath = brainDir; usedFallbackRoot = true; }
            } catch { /* ignore */ }
        }
        if (!rootPath) {
            const hasActions = /<(?:create_file|edit_file|run_command|delete_file|read_file|list_files|file|reveal_in_explorer|open_file|glob|grep)/i.test(aiMessage);
            if (hasActions) {
                report.push('❌ 작업할 폴더를 찾을 수 없습니다. File → Open Folder 로 폴더를 열거나 회사·두뇌 폴더를 먼저 설정해주세요.');
            }
            return report;
        }
        if (usedFallbackRoot) {
            report.push(`📁 워크스페이스 미오픈 — \`${rootPath.replace(os.homedir(), '~')}\` 를 root로 사용합니다.`);
        }
        /* v2.89.95 — fence-unwrap 단순화. 이전 v2.89.93 regex(중첩 lazy + 긴 alternation)는
           특정 입력에서 V8 정규식 엔진의 백트래킹 한계에 부딪힐 가능성이 있어 안전한 라인
           단위 처리로 교체. 액션 태그를 감싸는 ```xml ... ``` 블록만 정확히 unwrap. */
        try {
            aiMessage = aiMessage.replace(/```(?:xml|html|action|tool|tools)\s*\n/gi, '').replace(/(<\/(?:create_file|edit_file|delete_file|read_file|list_files|run_command|reveal_in_explorer|open_file|read_url|read_brain|file)>)\s*\n```/gi, '$1');
        } catch { /* defensive — never let unwrap break the path */ }

        // ACTION 1: Create files — v2.89.93 자유경로(~, $HOME, 절대경로) 허용,
        //           attr 한국어 alias(경로=) 인식.
        const createRegex = /<(?:create_file|write_file|file)\s+(?:path|file|name|경로|파일)=['"]?([^'">]+)['"]?[^>]*>([\s\S]*?)<\/(?:create_file|write_file|file)>/gi;
        let match: RegExpExecArray | null;
        let firstCreatedFile = '';

        while ((match = createRegex.exec(aiMessage)) !== null) {
            const relPath = match[1].trim();
            let content = match[2].trim();

            // Strip markdown code fences if AI accidentally wrapped the content inside the xml
            if (content.startsWith('```')) {
                const lines = content.split('\n');
                if (lines[0].startsWith('```')) lines.shift();
                if (lines.length > 0 && lines[lines.length - 1].startsWith('```')) lines.pop();
                content = lines.join('\n').trim();
            }

            const resolved = _resolveFlexiblePath(relPath, rootPath);
            if (!resolved) {
                report.push(`❌ 생성 차단: ${relPath} — 경로를 해석할 수 없습니다.`);
                continue;
            }
            if (resolved.reason) {
                report.push(`❌ 생성 차단: ${relPath} — ${resolved.reason}`);
                continue;
            }
            const absPath = resolved.abs;
            try {
                const dir = path.dirname(absPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                const existed = fs.existsSync(absPath);
                fs.writeFileSync(absPath, content, 'utf-8');
                if (absPath.startsWith(_getBrainDir())) brainModified = true;
                report.push(`${existed ? '✏️ 덮어씀' : '✅ 생성'}: ${absPath.replace(os.homedir(), '~')}`);
                this._trackFileAction(opts?.agentId, absPath, existed ? 'edit' : 'create');
                if (!firstCreatedFile) { firstCreatedFile = absPath; }
            } catch (err: any) {
                report.push(`❌ 생성 실패: ${relPath} — ${err.message}`);
            }
        }

        // Open first created file
        if (firstCreatedFile) {
            await vscode.window.showTextDocument(vscode.Uri.file(firstCreatedFile), { preview: false });
        }

        // ACTION 2: Edit files — v2.89.93 fuzzy fallback. 정확 매칭 실패 시
        //           (a) trim된 줄별 비교 (b) 다중 공백 정규화 매칭 시도.
        const editRegex = /<(?:edit_file|edit)\s+(?:path|file|name|경로|파일)=['"]?([^'">]+)['"]?[^>]*>([\s\S]*?)<\/(?:edit_file|edit)>/gi;
        while ((match = editRegex.exec(aiMessage)) !== null) {
            const relPath = match[1].trim();
            const body = match[2];
            const resolved = _resolveFlexiblePath(relPath, rootPath);
            if (!resolved) {
                report.push(`❌ 편집 차단: ${relPath} — 경로를 해석할 수 없습니다.`);
                continue;
            }
            if (resolved.reason) {
                report.push(`❌ 편집 차단: ${relPath} — ${resolved.reason}`);
                continue;
            }
            const absPath = resolved.abs;

            try {
                let fileContent = fs.readFileSync(absPath, 'utf-8');
                /* v2.89.104 — 편집 전 원본 보관 → diff 표시용 */
                const originalContent = fileContent;
                const findReplaceRegex = /<find>([\s\S]*?)<\/find>\s*<replace>([\s\S]*?)<\/replace>/g;
                let frMatch: RegExpExecArray | null;
                let editCount = 0;
                const fuzzyMisses: string[] = [];

                while ((frMatch = findReplaceRegex.exec(body)) !== null) {
                    const findText = frMatch[1];
                    const replaceText = frMatch[2];
                    if (fileContent.includes(findText)) {
                        fileContent = fileContent.split(findText).join(replaceText);
                        editCount++;
                        continue;
                    }
                    /* fuzzy 1: 연속 공백·탭을 단일 공백으로 정규화 후 매칭 */
                    const norm = (s: string) => s.replace(/[ \t]+/g, ' ').replace(/\r\n/g, '\n');
                    const normFile = norm(fileContent);
                    const normFind = norm(findText);
                    const normIdx = normFile.indexOf(normFind);
                    if (normIdx >= 0) {
                        /* 원본 file에서 같은 위치 부분을 찾아 교체 — 인덱스 매핑은
                           근사치라서 normalized 길이로 슬라이스 후 복원. */
                        const before = normFile.slice(0, normIdx);
                        const beforeOrig = fileContent.slice(0, before.length + (fileContent.slice(0, before.length + 50).match(/[ \t]/g)?.length || 0) * 0);
                        /* 안전장치: 단순 split 으로 normalize 매칭 — 정확하지 않을 수 있어
                           confirmation 메시지에 fuzzy 표기 */
                        const lines = fileContent.split('\n');
                        const findLines = findText.split('\n').map(l => l.trim());
                        let foundAt = -1;
                        for (let i = 0; i <= lines.length - findLines.length; i++) {
                            let ok = true;
                            for (let j = 0; j < findLines.length; j++) {
                                if (lines[i + j].trim() !== findLines[j]) { ok = false; break; }
                            }
                            if (ok) { foundAt = i; break; }
                        }
                        if (foundAt >= 0) {
                            const replaceLines = replaceText.split('\n');
                            lines.splice(foundAt, findLines.length, ...replaceLines);
                            fileContent = lines.join('\n');
                            editCount++;
                            report.push(`🔍 fuzzy 매칭으로 교체됨 (공백 차이 무시): ${relPath}`);
                            continue;
                        }
                    }
                    fuzzyMisses.push(findText.slice(0, 80).replace(/\n/g, ' ⏎ '));
                }
                for (const miss of fuzzyMisses) {
                    report.push(`⚠️ ${relPath}: 매칭 실패 — \`${miss}…\` (정확/fuzzy 둘 다 실패)`);
                }

                if (editCount > 0) {
                    fs.writeFileSync(absPath, fileContent, 'utf-8');
                    if (absPath.startsWith(_getBrainDir())) brainModified = true;
                    /* v2.89.104 — Claude 익스텐션 호환 unified diff 표시. 변경된 hunk만,
                       3줄 컨텍스트. AI도 사람도 무엇이 어떻게 바뀌었는지 한눈에 파악. */
                    const diffBlock = _renderUnifiedDiff(originalContent, fileContent, 3);
                    const sizeBefore = (Buffer.byteLength(originalContent, 'utf-8') / 1024).toFixed(1);
                    const sizeAfter = (Buffer.byteLength(fileContent, 'utf-8') / 1024).toFixed(1);
                    const linesBefore = originalContent.split('\n').length;
                    const linesAfter = fileContent.split('\n').length;
                    const linesDelta = linesAfter - linesBefore;
                    const deltaStr = linesDelta === 0 ? '' : (linesDelta > 0 ? ` +${linesDelta}줄` : ` ${linesDelta}줄`);
                    if (diffBlock) {
                        report.push(`✏️ 편집 완료: ${absPath.replace(os.homedir(), '~')} (${editCount}건 수정${deltaStr}, ${sizeBefore}KB → ${sizeAfter}KB)\n\`\`\`diff\n${diffBlock}\n\`\`\``);
                    } else {
                        report.push(`✏️ 편집 완료: ${absPath.replace(os.homedir(), '~')} (${editCount}건${deltaStr})`);
                    }
                    this._trackFileAction(opts?.agentId, absPath, 'edit');
                    // Open edited file
                    if (!opts?.silent) {
                        await vscode.window.showTextDocument(vscode.Uri.file(absPath), { preview: false });
                    }
                }
            } catch (err: any) {
                if (err.code === 'ENOENT') {
                    report.push(`❌ 편집 실패: ${relPath} — 파일이 존재하지 않습니다.`);
                } else {
                    report.push(`❌ 편집 실패: ${relPath} — ${err.message}`);
                }
            }
        }

        // ACTION 3: Delete files — v2.89.93 자유경로 + 디렉토리 안전 가드 강화
        const deleteRegex = /<(?:delete_file|delete)\s+(?:path|file|name|경로|파일)=['"]?([^'">]+?)['"]?\s*\/?>(?:<\/(?:delete_file|delete)>)?/gi;
        while ((match = deleteRegex.exec(aiMessage)) !== null) {
            const relPath = match[1].trim();
            const resolved = _resolveFlexiblePath(relPath, rootPath);
            if (!resolved) {
                report.push(`❌ 삭제 차단: ${relPath} — 경로를 해석할 수 없습니다.`);
                continue;
            }
            if (resolved.reason) {
                report.push(`❌ 삭제 차단: ${relPath} — ${resolved.reason}`);
                continue;
            }
            const absPath = resolved.abs;
            /* 안전장치: 사용자 홈 자체나 루트 직접 삭제 차단 */
            if (absPath === os.homedir() || absPath === '/' || /^[A-Z]:\\?$/i.test(absPath)) {
                report.push(`❌ 삭제 차단: ${absPath} — 홈/루트 디렉토리 직접 삭제 금지.`);
                continue;
            }
            try {
                if (fs.existsSync(absPath)) {
                    const stat = fs.statSync(absPath);
                    if (stat.isDirectory()) {
                        fs.rmSync(absPath, { recursive: true, force: true });
                    } else {
                        fs.unlinkSync(absPath);
                    }
                    if (absPath.startsWith(_getBrainDir())) brainModified = true;
                    report.push(`🗑️ 삭제: ${absPath.replace(os.homedir(), '~')}`);
                    this._trackFileAction(opts?.agentId, absPath, 'delete');
                } else {
                    report.push(`⚠️ 삭제 스킵: ${relPath} — 파일이 존재하지 않습니다.`);
                }
            } catch (err: any) {
                report.push(`❌ 삭제 실패: ${relPath} — ${err.message}`);
            }
        }

        // ACTION 4: Read files — v2.89.93 자유경로, 32KB cap (was 10KB), truncation 명시,
        //           회사 모드는 inline append (chat history 대신).
        const readRegex = /<(?:read_file|read)\s+(?:path|file|name|경로|파일)=['"]?([^'">]+?)['"]?\s*\/?>(?:<\/(?:read_file|read)>)?/gi;
        const READ_CAP = 32000;
        while ((match = readRegex.exec(aiMessage)) !== null) {
            const relPath = match[1].trim();
            const resolved = _resolveFlexiblePath(relPath, rootPath);
            if (!resolved) {
                report.push(`❌ 읽기 차단: ${relPath} — 경로를 해석할 수 없습니다.`);
                continue;
            }
            if (resolved.reason) {
                report.push(`❌ 읽기 차단: ${relPath} — ${resolved.reason}`);
                continue;
            }
            const absPath = resolved.abs;
            try {
                if (fs.existsSync(absPath)) {
                    const stat = fs.statSync(absPath);
                    if (stat.isDirectory()) {
                        report.push(`⚠️ 읽기 실패: ${relPath} — 디렉토리입니다. <list_files>를 쓰세요.`);
                        continue;
                    }
                    /* 바이너리 파일 보호 — 처음 512바이트에 NUL 있으면 binary로 취급 */
                    const headBuf = Buffer.alloc(512);
                    const fd = fs.openSync(absPath, 'r');
                    const headLen = fs.readSync(fd, headBuf, 0, 512, 0);
                    fs.closeSync(fd);
                    const isBinary = headBuf.slice(0, headLen).includes(0);
                    if (isBinary) {
                        const sizeKb = (stat.size / 1024).toFixed(1);
                        report.push(`⚠️ 읽기 스킵: ${relPath} — 바이너리 파일(${sizeKb}KB). 텍스트 파일만 read_file 가능.`);
                        continue;
                    }
                    const content = fs.readFileSync(absPath, 'utf-8');
                    const truncated = content.length > READ_CAP;
                    const shown = truncated ? content.slice(0, READ_CAP) : content;
                    /* v2.89.104 — Claude 익스텐션 호환 cat -n 스타일 줄번호. AI가 특정 줄을
                       지정해서 edit_file 하기 쉬워짐. 줄번호 너비는 자동 (3~5자리). */
                    const lines = shown.split('\n');
                    const totalLines = content.split('\n').length;
                    const padWidth = String(lines.length).length;
                    const numbered = lines.map((line, i) => `${String(i + 1).padStart(padWidth, ' ')}\t${line}`).join('\n');
                    const previewLines = lines.slice(0, 10);
                    const previewPadWidth = String(Math.min(10, lines.length)).length;
                    const preview = previewLines.map((line, i) => `${String(i + 1).padStart(previewPadWidth, ' ')}\t${line}`).join('\n');
                    const sizeKb = (stat.size / 1024).toFixed(1);
                    const truncNote = truncated ? `\n_⚠️ ${content.length}자 중 처음 ${READ_CAP}자만 표시 (${totalLines}줄 중 ${lines.length}줄) — 전체가 필요하면 더 작은 단위로 분할 읽기._` : '';
                    report.push(`📖 읽기: ${absPath.replace(os.homedir(), '~')} (${totalLines}줄, ${sizeKb}KB${truncated ? ', 잘림' : ''})\n\`\`\`\n${preview}${lines.length > 10 ? '\n...' : ''}\n\`\`\``);
                    const injection = `[시스템: read_file 결과]\n파일: ${absPath.replace(os.homedir(), '~')} (${totalLines}줄)\n\`\`\`\n${numbered}\n\`\`\`${truncNote}`;
                    if (opts?.appendToOutput) {
                        opts.appendToOutput('\n\n' + injection);
                    } else {
                        this._chatHistory.push({ role: 'user', content: injection });
                    }
                } else {
                    const hint = this._fuzzyPathHint(absPath);
                    report.push(`⚠️ 읽기 실패: ${relPath} — 파일이 존재하지 않습니다.${hint}`);
                    if (hint) {
                        const injection = `[시스템: read_file 실패]\n경로: ${absPath}\n${hint}`;
                        if (opts?.appendToOutput) opts.appendToOutput('\n\n' + injection);
                        else this._chatHistory.push({ role: 'user', content: injection });
                    }
                }
            } catch (err: any) {
                report.push(`❌ 읽기 실패: ${relPath} — ${err.message}`);
            }
        }

        // ACTION 5: List directory — v2.89.93 자유경로 + 회사 모드 inline append
        const listRegex = /<(?:list_files|list_dir|ls)\s+(?:path|dir|name|경로|파일)=['"]?([^'">]*?)['"]?\s*\/?>(?:<\/(?:list_files|list_dir|ls)>)?/gi;
        while ((match = listRegex.exec(aiMessage)) !== null) {
            const relDir = match[1].trim() || '.';
            const resolved = _resolveFlexiblePath(relDir, rootPath);
            if (!resolved) {
                report.push(`❌ 목록 차단: ${relDir} — 경로를 해석할 수 없습니다.`);
                continue;
            }
            if (resolved.reason) {
                report.push(`❌ 목록 차단: ${relDir} — ${resolved.reason}`);
                continue;
            }
            const absDir = resolved.abs;
            try {
                if (fs.existsSync(absDir) && fs.statSync(absDir).isDirectory()) {
                    const entries = fs.readdirSync(absDir, { withFileTypes: true });
                    const listing = entries
                        .filter(e => !e.name.startsWith('.') && !EXCLUDED_DIRS.has(e.name))
                        .map(e => e.isDirectory() ? `📁 ${e.name}/` : `📄 ${e.name}`)
                        .join('\n') || '_(빈 디렉토리)_';
                    report.push(`📂 목록: ${absDir.replace(os.homedir(), '~')}/\n\`\`\`\n${listing}\n\`\`\``);
                    const injection = `[시스템: list_files 결과]\n디렉토리: ${absDir.replace(os.homedir(), '~')}/\n${listing}`;
                    if (opts?.appendToOutput) opts.appendToOutput('\n\n' + injection);
                    else this._chatHistory.push({ role: 'user', content: injection });
                } else {
                    const hint = this._fuzzyPathHint(absDir);
                    report.push(`⚠️ 목록 실패: ${relDir} — 디렉토리가 존재하지 않습니다.${hint}`);
                    /* hint 를 다음 LLM turn 도 보게 chat history (또는 inline) 에 주입 */
                    if (hint) {
                        const injection = `[시스템: list_files 실패]\n경로: ${absDir}\n${hint}`;
                        if (opts?.appendToOutput) opts.appendToOutput('\n\n' + injection);
                        else this._chatHistory.push({ role: 'user', content: injection });
                    }
                }
            } catch (err: any) {
                report.push(`❌ 목록 실패: ${relDir} — ${err.message}`);
            }
        }

        // ACTION NEW v2.89.104: Glob — 패턴으로 파일 찾기 (Claude 익스텐션 호환)
        // <glob pattern="**/*.ts"/> 또는 <glob pattern="src/**/*.tsx" path="."/>
        const globRegex = /<glob\s+(?:[^>]*?\b)?pattern=['"]([^'"]+)['"](?:\s+(?:path|dir|root)=['"]?([^'">]+)['"]?)?[^>]*\/?>(?:<\/glob>)?/gi;
        while ((match = globRegex.exec(aiMessage)) !== null) {
            const pattern = match[1].trim();
            const relRoot = (match[2] || '.').trim();
            const resolved = _resolveFlexiblePath(relRoot, rootPath);
            if (!resolved || resolved.reason) {
                report.push(`❌ glob 차단: ${pattern} — ${resolved?.reason || '경로 해석 불가'}`);
                continue;
            }
            try {
                const hits = _globMatch(pattern, resolved.abs, 200);
                const summary = hits.length === 0 ? '_(매칭 없음)_'
                    : (hits.length >= 200 ? hits.slice(0, 200).join('\n') + '\n_(200개 cap 도달)_' : hits.join('\n'));
                report.push(`🔎 glob \`${pattern}\` (${resolved.abs.replace(os.homedir(), '~')}): ${hits.length}개\n\`\`\`\n${summary.slice(0, 4000)}\n\`\`\``);
                const injection = `[시스템: glob 결과]\n패턴: ${pattern}\n루트: ${resolved.abs.replace(os.homedir(), '~')}\n매치 ${hits.length}개:\n${summary}`;
                if (opts?.appendToOutput) opts.appendToOutput('\n\n' + injection);
                else this._chatHistory.push({ role: 'user', content: injection });
            } catch (err: any) {
                report.push(`❌ glob 실패: ${pattern} — ${err.message}`);
            }
        }

        // ACTION NEW v2.89.104: Grep — 파일 내용 검색 (Claude 익스텐션 호환)
        // <grep pattern="TODO" path="src" files="**/*.ts"/>
        const grepRegex = /<grep\s+(?:[^>]*?\b)?pattern=['"]([^'"]+)['"](?:[^>]*?\bpath=['"]?([^'">]+)['"]?)?(?:[^>]*?\bfiles=['"]?([^'">]+)['"]?)?[^>]*\/?>(?:<\/grep>)?/gi;
        while ((match = grepRegex.exec(aiMessage)) !== null) {
            const pattern = match[1].trim();
            const relRoot = (match[2] || '.').trim();
            const fileGlob = match[3] ? match[3].trim() : undefined;
            const resolved = _resolveFlexiblePath(relRoot, rootPath);
            if (!resolved || resolved.reason) {
                report.push(`❌ grep 차단: ${pattern} — ${resolved?.reason || '경로 해석 불가'}`);
                continue;
            }
            try {
                const hits = _grepFiles(pattern, resolved.abs, fileGlob);
                let total = 0;
                for (const h of hits) total += h.matches.length;
                let body = '';
                if (hits.length === 0) {
                    body = '_(매칭 없음)_';
                } else {
                    for (const h of hits) {
                        body += `\n📄 ${h.file}\n` + h.matches.map(m => `  ${String(m.line).padStart(4, ' ')}: ${m.text}`).join('\n');
                    }
                }
                report.push(`🔍 grep \`${pattern}\`${fileGlob ? ` (${fileGlob})` : ''}: ${hits.length}파일 / ${total}매치\n\`\`\`\n${body.slice(0, 4000)}\n\`\`\``);
                const injection = `[시스템: grep 결과]\n패턴: ${pattern}\n루트: ${resolved.abs.replace(os.homedir(), '~')}\n${fileGlob ? `파일 필터: ${fileGlob}\n` : ''}${hits.length}파일 ${total}매치:${body}`;
                if (opts?.appendToOutput) opts.appendToOutput('\n\n' + injection);
                else this._chatHistory.push({ role: 'user', content: injection });
            } catch (err: any) {
                report.push(`❌ grep 실패: ${pattern} — ${err.message}`);
            }
        }

        // ACTION NEW: Reveal in OS file explorer (Finder · Windows Explorer · GNOME Files)
        // v2.89.93 — 사용자가 "Finder에서 열어줘" 같은 자연스러운 요청 가능.
        const revealRegex = /<(?:reveal_in_explorer|reveal|finder|explorer)\s+(?:path|file|name|경로|파일)=['"]?([^'">]+?)['"]?\s*\/?>(?:<\/(?:reveal_in_explorer|reveal|finder|explorer)>)?/gi;
        while ((match = revealRegex.exec(aiMessage)) !== null) {
            const relPath = match[1].trim();
            const resolved = _resolveFlexiblePath(relPath, rootPath);
            if (!resolved) { report.push(`❌ 익스플로러 열기 실패: ${relPath} — 경로 해석 불가.`); continue; }
            const r = _revealInOsExplorer(resolved.abs);
            report.push((r.ok ? '🗂 ' : '❌ ') + r.message.replace(os.homedir(), '~'));
        }

        // ACTION NEW: Open in default OS app (이미지·PDF·웹페이지·.docx 등)
        const openAppRegex = /<(?:open_file|open_in_app|launch)\s+(?:path|file|name|경로|파일)=['"]?([^'">]+?)['"]?\s*\/?>(?:<\/(?:open_file|open_in_app|launch)>)?/gi;
        while ((match = openAppRegex.exec(aiMessage)) !== null) {
            const relPath = match[1].trim();
            const resolved = _resolveFlexiblePath(relPath, rootPath);
            if (!resolved) { report.push(`❌ 파일 열기 실패: ${relPath} — 경로 해석 불가.`); continue; }
            const r = _openInDefaultApp(resolved.abs);
            report.push((r.ok ? '🚀 ' : '❌ ') + r.message.replace(os.homedir(), '~'));
        }

        // ACTION 6: Run commands — capture output so AI can see results.
        // v2.89.93 — skipRunCommand: 회사 모드 dispatch는 tools dir cwd·telegram mirror·noise
        //   필터까지 specialized 처리(line 16476)가 이미 있어서 여기선 스킵.
        const cmdRegex = /<(?:run_command|command|bash|terminal)>([\s\S]*?)<\/(?:run_command|command|bash|terminal)>/gi;
        if (opts?.skipRunCommand) {
            cmdRegex.lastIndex = aiMessage.length;
        }
        while (!opts?.skipRunCommand && (match = cmdRegex.exec(aiMessage)) !== null) {
            let cmd = match[1].trim();
            // Clean up if AI outputs markdown inside
            if (cmd.startsWith('```')) {
                const lines = cmd.split('\n');
                if (lines[0].startsWith('```')) lines.shift();
                if (lines.length > 0 && lines[lines.length - 1].startsWith('```')) lines.pop();
                cmd = lines.join('\n').trim();
            }
            if (!cmd) continue;

            // Live-stream the output to the chat so the user sees progress in real time
            // (corporate 모드는 카드 뷰에서 별도 처리 — opts.appendToOutput 만 채움)
            const headerMsg = `\n\n\`\`\`bash\n$ ${cmd}\n`;
            if (!opts?.appendToOutput) {
                this._view?.webview.postMessage({ type: 'streamChunk', value: headerMsg });
            }

            try {
                /* v2.89.77 — 60초 → 25분. 음악 생성·모델 설치·영상 합치기처럼 시간이
                   오래 걸리는 도구가 chat 경로로도 실행됨. dispatch 경로(line 16386)와
                   맞추는 게 자연스러움. 짧은 명령은 어차피 빨리 끝나니까 손해 없음. */
                const result = await runCommandCaptured(cmd, rootPath, (chunk) => {
                    if (!opts?.appendToOutput) {
                        this._view?.webview.postMessage({ type: 'streamChunk', value: chunk });
                    }
                }, 25 * 60 * 1000);
                if (!opts?.appendToOutput) {
                    this._view?.webview.postMessage({ type: 'streamChunk', value: '\n```\n' });
                }

                const status = result.timedOut
                    ? '⏱️ 25분 시간 초과로 중단됨'
                    : result.exitCode === 0
                        ? '✅ 종료 코드 0'
                        : `❌ 종료 코드 ${result.exitCode}`;
                report.push(`🖥️ 실행: \`${cmd}\` — ${status}`);

                // Inject the output back so the AI can continue with context
                const injection = `[시스템: run_command 결과]\n명령: ${cmd}\n종료 코드: ${result.exitCode}${result.timedOut ? ' (시간 초과)' : ''}\n출력:\n\`\`\`\n${result.output}\n\`\`\``;
                if (opts?.appendToOutput) opts.appendToOutput('\n\n' + injection);
                else this._chatHistory.push({ role: 'user', content: injection });
            } catch (err: any) {
                report.push(`❌ 명령 실패: \`${cmd}\` — ${err.message}`);
                if (!opts?.appendToOutput) {
                    this._view?.webview.postMessage({ type: 'streamChunk', value: `\n[실행 오류] ${err.message}\n\`\`\`\n` });
                }
            }
        }

        // ACTION 8: Read Urls (Web Scraping)
        const urlRegex = /<(?:read_url|url|fetch_url)>([\s\S]*?)<\/(?:read_url|url|fetch_url)>/gi;
        while ((match = urlRegex.exec(aiMessage)) !== null) {
            const url = match[1].trim();
            try {
                // Fetch the HTML content
                const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, timeout: 10000 });
                // Strip scripts and styles first
                let cleaned = data.toString()
                    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
                    // Strip remaining HTML tags
                    .replace(/<[^>]+>/g, ' ')
                    // Consolidate whitespaces
                    .replace(/\s+/g, ' ')
                    .trim();
                
                const preview = cleaned.slice(0, 500);
                report.push(`🌐 웹사이트 읽기: ${url} (${cleaned.length}자)\n\`\`\`\n${preview}...\n\`\`\``);
                this._chatHistory.push({ role: 'user', content: `[시스템: read_url 결과]\nURL: ${url}\n\`\`\`\n${cleaned.slice(0, 15000)}\n\`\`\`` });
            } catch (err: any) {
                report.push(`❌ 웹사이트 접속 실패: ${url} — ${err.message}`);
                this._chatHistory.push({ role: 'user', content: `[시스템: read_url 실패]\n${err.message}` });
            }
        }

        // ACTION 7: Read Second Brain documents
        const brainReadRegex = /<read_brain>([\s\S]*?)<\/read_brain>/gi;
        while ((match = brainReadRegex.exec(aiMessage)) !== null) {
            const filename = match[1].trim();
            if (!filename) continue;
            const content = this._readBrainFile(filename);
            report.push(`🧠 두뇌 파일 읽기: ${filename}`);
            this._chatHistory.push({ role: 'user', content: `[시스템: read_brain 결과]\n파일: ${filename}\n\`\`\`\n${content.slice(0, 15000)}\n\`\`\`` });
        }

        // FALLBACK: If AI used markdown code blocks with filenames instead of XML tags
        if (report.length === 0) {
            const fallbackRegex = /```(?:[a-zA-Z]*)?\s*\n\/\/\s*(?:file|파일):\s*([^\n]+)\n([\s\S]*?)```/gi;
            while ((match = fallbackRegex.exec(aiMessage)) !== null) {
                const relPath = match[1].trim();
                const content = match[2].trim();
                if (relPath && content && relPath.includes('.')) {
                    const absPath = safeResolveInside(rootPath, relPath);
                    if (!absPath) {
                        report.push(`❌ 생성 차단: ${relPath} — 워크스페이스 밖으로 나가는 경로입니다.`);
                        continue;
                    }
                    try {
                        const dir = path.dirname(absPath);
                        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                        fs.writeFileSync(absPath, content, 'utf-8');
                        report.push(`✅ 생성(자동감지): ${relPath}`);
                        if (!firstCreatedFile) firstCreatedFile = absPath;
                    } catch (err: any) {
                        report.push(`❌ 생성 실패: ${relPath} — ${err.message}`);
                    }
                }
            }
            if (firstCreatedFile) {
                await vscode.window.showTextDocument(vscode.Uri.file(firstCreatedFile), { preview: false });
            }
        }

        // Show notification — silent suppresses for corporate dispatch (카드 뷰에서 별도 보고됨)
        const successCount = report.filter(r => r.startsWith('✅') || r.startsWith('✏️') || r.startsWith('🖥️') || r.startsWith('🗑️') || r.startsWith('📖') || r.startsWith('📂') || r.startsWith('🗂') || r.startsWith('🚀')).length;
        if (successCount > 0 && !opts?.silent) {
            vscode.window.showInformationMessage(`Agent OS: ${successCount}개 에이전트 작업 완료!`);
        }

        // Auto-Push Second Brain changes to Cloud
        if (brainModified) {
            _safeGitAutoSync(_getBrainDir(), `[P-Reinforce] Auto-synced structured knowledge`, this);
        }

        return report;
    }

    // Strip raw XML action tags from display message
    private _stripActionTags(text: string): string {
        return text
            .replace(/<(?:create_file|write_file|file)\s+[^>]*>[\s\S]*?<\/(?:create_file|write_file|file)>/gi, '')
            .replace(/<(?:edit_file|edit)\s+[^>]*>[\s\S]*?<\/(?:edit_file|edit)>/gi, '')
            .replace(/<(?:delete_file|delete)\s+[^>]*\s*\/?>(?:<\/(?:delete_file|delete)>)?/gi, '')
            .replace(/<(?:read_file|read)\s+[^>]*\s*\/?>(?:<\/(?:read_file|read)>)?/gi, '')
            .replace(/<(?:list_files|list_dir|ls)\s+[^>]*\s*\/?>(?:<\/(?:list_files|list_dir|ls)>)?/gi, '')
            .replace(/<(?:reveal_in_explorer|reveal|finder|explorer)\s+[^>]*\s*\/?>(?:<\/(?:reveal_in_explorer|reveal|finder|explorer)>)?/gi, '')
            .replace(/<(?:open_file|open_in_app|launch)\s+[^>]*\s*\/?>(?:<\/(?:open_file|open_in_app|launch)>)?/gi, '')
            .replace(/<glob\s+[^>]*\s*\/?>(?:<\/glob>)?/gi, '')
            .replace(/<grep\s+[^>]*\s*\/?>(?:<\/grep>)?/gi, '')
            .replace(/<(?:run_command|command|bash|terminal)>[\s\S]*?<\/(?:run_command|command|bash|terminal)>/gi, '')
            .replace(/<(?:read_brain)>[\s\S]*?<\/(?:read_brain)>/gi, '')
            .replace(/<(?:read_url|url|fetch_url)>[\s\S]*?<\/(?:read_url|url|fetch_url)>/gi, '')
            .trim();
    }


    // ============================================================
    // Webview HTML — CINEMATIC UI v3 (Content-Grade Visuals)
    // ============================================================

    private _getHtml(): string {
        // v2.89.59 — sidebar webview HTML/CSS/JS extracted to assets/webview/sidebar.html
        // for safer editing and pre-build syntax verification (node --check). Single-file
        // extension.ts had multiple webview-script syntax errors that killed all UI;
        // separate file lets us run node --check before publishing.
        const htmlPath = path.join(this._extensionUri.fsPath, 'assets', 'webview', 'sidebar.html');
        try {
            return fs.readFileSync(htmlPath, 'utf-8');
        } catch (e: any) {
            return `<!DOCTYPE html><html><body style="background:#111;color:#fff;padding:24px;font-family:-apple-system"><h2>⚠️ Webview HTML 로드 실패</h2><pre>${(e?.message || e).toString()}</pre><p>경로: ${htmlPath}</p></body></html>`;
        }
    }
}
