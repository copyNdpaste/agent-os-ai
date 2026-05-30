import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { runClaudeCli } from './claude-cli';
import { runCodexCli, type CodexReasoningEffort } from './codex-cli';

export type Tier = 'heavy' | 'standard' | 'light';
export type Provider = 'claude' | 'codex';

export interface AskOptions {
  model?: string;
  binPath?: string;
  /** Wall-clock max (ms). 0 = 무제한. opts 에 없으면 settings 또는 default. */
  timeoutMs?: number;
  /** Idle max (ms) — 마지막 chunk 후 N ms idle 이면 SIGTERM. 0 = 무제한. */
  idleTimeoutMs?: number;
  /** Codex CLI 전용 — filesystem MCP init 우회. 큰 워크스페이스에서 분류기·CEO planner 호출 시 hang 방지. */
  skipFilesystemMcp?: boolean;
  /** Codex/GPT 추론 강도. low / medium / high / xhigh. */
  codexReasoningEffort?: CodexReasoningEffort;
}

/** v2.92.x — VS Code settings 에서 timeout 값 읽음.
 *  `agentOs.llmTimeoutWallMin` (분 단위, 0=무제한) / `agentOs.llmTimeoutIdleMin` (분 단위, 0=무제한).
 *  vscode 모듈은 옵셔널 (테스트 환경에서 없을 수 있음). 없으면 undefined 반환 → CLI runner 의 default 적용. */
function readTimeoutSettings(): { wallMs?: number; idleMs?: number } {
  try {
    const vscode = require('vscode');
    const cfg = vscode?.workspace?.getConfiguration?.('agentOs');
    if (!cfg) return {};
    const wallMin = cfg.get('llmTimeoutWallMin');
    const idleMin = cfg.get('llmTimeoutIdleMin');
    return {
      wallMs: typeof wallMin === 'number' ? wallMin * 60_000 : undefined,
      idleMs: typeof idleMin === 'number' ? idleMin * 60_000 : undefined,
    };
  } catch { return {}; }
}

function readCodexReasoningEffortSetting(): CodexReasoningEffort {
  try {
    const vscode = require('vscode');
    const cfg = vscode?.workspace?.getConfiguration?.('agentOs');
    const raw = String(cfg?.get?.('codexReasoningEffort', 'medium') || 'medium').toLowerCase();
    return raw === 'low' || raw === 'high' || raw === 'xhigh' ? raw : 'medium';
  } catch { return 'medium'; }
}

const TIER_TO_MODEL: Record<Tier, string> = {
  heavy: 'claude-opus-4-8',
  standard: 'claude-sonnet-4-6',
  light: 'claude-sonnet-4-6'
};

const DEFAULT_TIER: Tier = 'standard';

function resolveModel(tier: Tier | undefined, opts?: AskOptions): string {
  if (opts?.model) return opts.model;
  return TIER_TO_MODEL[tier ?? DEFAULT_TIER];
}

/** 모델 ID 로 provider 판정. gpt-* → codex, 나머지 → claude.
 *  새 provider 추가 시 여기 한 곳만 수정. */
export function providerFor(model: string): Provider {
  const m = (model || '').toLowerCase();
  if (m.startsWith('gpt-') || m.startsWith('gpt5') || m.startsWith('o1') || m.startsWith('o3')) {
    return 'codex';
  }
  return 'claude';
}

function expandTilde(p: string): string {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/* v2.90.1 — VS Code/Antigravity 확장 호스트의 PATH 는 보통 nvm/asdf/홈 .local/bin
   같은 사용자 셸 경로가 빠진 상태. spawn('claude') 가 ENOENT 로 실패하면 사용자는
   "Claude CLI 를 찾지 못했어요" 만 보고 직접 절대경로 박아야 함. 흔한 위치들을
   자동 탐색해서 발견되면 그 경로를 쓰고, 그래도 없으면 마지막에 'claude' 반환
   (PATH 에 있으면 살아남고, 진짜 없으면 호출부에서 ENOENT 처리). */
const CANDIDATE_CLAUDE_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '~/.local/bin',
  '~/.claude/local',
  '~/bin'
];

function findClaudeFallback(): string | null {
  const candidates: string[] = [];
  for (const d of CANDIDATE_CLAUDE_DIRS) {
    candidates.push(path.join(expandTilde(d), 'claude'));
  }
  /* nvm: try every installed node version's bin dir */
  const nvmRoot = expandTilde('~/.nvm/versions/node');
  try {
    if (fs.existsSync(nvmRoot)) {
      for (const v of fs.readdirSync(nvmRoot)) {
        candidates.push(path.join(nvmRoot, v, 'bin', 'claude'));
      }
    }
  } catch { /* ignore */ }
  /* volta */
  candidates.push(expandTilde('~/.volta/bin/claude'));
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch { /* ignore */ }
  }
  return null;
}

let _cachedFallback: string | null | undefined;

export function resolveClaudeBin(): string | null {
  let configured = '';
  try {
    const vscode = require('vscode');
    const cfg = vscode.workspace.getConfiguration('agentOs');
    configured = (cfg.get('claudeBinPath', '') || '').trim();
  } catch {
    /* vscode not available — running outside extension host */
  }
  if (configured) {
    const expanded = expandTilde(configured);
    return expanded || null;
  }
  if (_cachedFallback === undefined) _cachedFallback = findClaudeFallback();
  return _cachedFallback || 'claude';
}

/* Codex CLI 위치 탐색 — claude 와 같은 후보 디렉터리 (npm global, brew,
   nvm bin 들). settings.json `agentOs.codexBinPath` 가 있으면 우선. */
function findCodexFallback(): string | null {
  const candidates: string[] = [];
  for (const d of CANDIDATE_CLAUDE_DIRS) {
    candidates.push(path.join(expandTilde(d), 'codex'));
  }
  const nvmRoot = expandTilde('~/.nvm/versions/node');
  try {
    if (fs.existsSync(nvmRoot)) {
      for (const v of fs.readdirSync(nvmRoot)) {
        candidates.push(path.join(nvmRoot, v, 'bin', 'codex'));
      }
    }
  } catch { /* ignore */ }
  candidates.push(expandTilde('~/.volta/bin/codex'));
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch { /* ignore */ }
  }
  return null;
}

let _cachedCodexFallback: string | null | undefined;

export function resolveCodexBin(): string | null {
  let configured = '';
  try {
    const vscode = require('vscode');
    const cfg = vscode.workspace.getConfiguration('agentOs');
    configured = (cfg.get('codexBinPath', '') || '').trim();
  } catch { /* vscode not available */ }
  if (configured) {
    const expanded = expandTilde(configured);
    return expanded || null;
  }
  if (_cachedCodexFallback === undefined) _cachedCodexFallback = findCodexFallback();
  return _cachedCodexFallback || 'codex';
}

/* Node binary lookup — Claude CLI uses `#!/usr/bin/env node` shebang. VS Code
   extension host PATH on macOS (when launched from Dock) doesn't include
   user shell PATH (nvm / Volta / asdf paths missing). spawn('claude') 가 살아도
   그 안의 `env node` 가 'No such file or directory' 로 죽는다 (exit 127).
   해결: node 도 찾아서 PATH 에 prepend 한 env 를 spawn 에 넘김. */
const CANDIDATE_NODE_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '~/.local/bin',
  '~/.volta/bin',
  '~/bin',
];
let _cachedNodeBin: string | null | undefined;
function findNodeFallback(): string | null {
  const candidates: string[] = [];
  for (const d of CANDIDATE_NODE_DIRS) candidates.push(path.join(expandTilde(d), 'node'));
  /* nvm — pick the highest version available (heuristic: lexicographic) */
  const nvmRoot = expandTilde('~/.nvm/versions/node');
  try {
    if (fs.existsSync(nvmRoot)) {
      const versions = fs.readdirSync(nvmRoot).sort().reverse(); /* newest first */
      for (const v of versions) candidates.push(path.join(nvmRoot, v, 'bin', 'node'));
    }
  } catch { /* ignore */ }
  /* asdf */
  const asdfRoot = expandTilde('~/.asdf/installs/nodejs');
  try {
    if (fs.existsSync(asdfRoot)) {
      const versions = fs.readdirSync(asdfRoot).sort().reverse();
      for (const v of versions) candidates.push(path.join(asdfRoot, v, 'bin', 'node'));
    }
  } catch { /* ignore */ }
  for (const c of candidates) {
    try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch { /* ignore */ }
  }
  return null;
}
export function resolveNodeBin(): string | null {
  if (_cachedNodeBin === undefined) _cachedNodeBin = findNodeFallback();
  return _cachedNodeBin || null;
}

/** Build a child-process env with node + claude bin dirs prepended to PATH.
 *  Caller passes the resolved claude bin so we can include its parent dir
 *  too (claude often depends on co-located helper binaries). */
export function buildSpawnEnv(claudeBin: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const extra: string[] = [];
  const nodeBin = resolveNodeBin();
  if (nodeBin) extra.push(path.dirname(nodeBin));
  if (claudeBin) {
    const claudeDir = path.dirname(claudeBin);
    if (!extra.includes(claudeDir)) extra.push(claudeDir);
  }
  if (extra.length > 0) {
    env.PATH = [...extra, env.PATH || ''].filter(Boolean).join(path.delimiter);
  }
  return env;
}

export async function ask(
  prompt: string,
  tier?: Tier,
  opts?: AskOptions
): Promise<string> {
  return streamAsk(prompt, tier, () => { /* no streaming */ }, opts);
}

/* v2.92.x — 에이전트가 "자꾸 실패" 하던 진짜 원인은 사용량/설치 문제가 아니라
   CLI 호출 중 일시적 API 오류였다. 특히 Claude CLI 가 agentic 루프 안에서 도구를 쓰다
   `thinking`/`redacted_thinking` 블록을 다음 턴에 그대로 못 돌려보내면 Anthropic 이
   400 (`...blocks ... cannot be modified...`) 을 던진다. 이건 간헐적이라 -p 단발 호출을
   새로 띄우면(상태 없음) 대개 깨끗한 턴이 다시 생성돼 성공한다. overloaded(529)·rate
   limit(429)·5xx·네트워크 끊김도 같은 부류. 이런 일시 오류는 자동 재시도로 흡수한다.
   사용자 중단(aborted)·타임아웃·이미 토큰을 흘린 경우는 재시도하지 않는다. */
export function isTransientLLMError(msg: string): boolean {
  const m = msg || '';
  if (/overloaded|rate[_\s-]?limit|too many requests|\b429\b|\b500\b|\b502\b|\b503\b|\b529\b|internal server error|service unavailable|bad gateway|gateway time-?out/i.test(m)) return true;
  if (/ECONNRESET|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang ?up|fetch failed|network (error|timeout)|connection (error|reset|closed|refused)/i.test(m)) return true;
  if (/(thinking|redacted_thinking)[\s\S]{0,120}(cannot be modified|must remain)/i.test(m)) return true;
  return false;
}

const MAX_LLM_ATTEMPTS = 3;

export async function streamAsk(
  prompt: string,
  tier: Tier | undefined,
  onDelta: (chunk: string) => void,
  opts?: AskOptions
): Promise<string> {
  const model = resolveModel(tier, opts);
  const provider = providerFor(model);
  const settings = readTimeoutSettings();
  /* 우선순위: opts (호출자가 명시) > settings (사장님 설정) > CLI runner default. */
  const timeoutMs = opts?.timeoutMs ?? settings.wallMs;
  const idleTimeoutMs = opts?.idleTimeoutMs ?? settings.idleMs;

  const runOnce = (deltaSink: (chunk: string) => void): Promise<string> => {
    if (provider === 'codex') {
      const bin = opts?.binPath ?? resolveCodexBin();
      if (!bin) throw new Error('Codex CLI binary path not resolved.');
      return runCodexCli(prompt, model, deltaSink, {
        binPath: bin,
        timeoutMs,
        idleTimeoutMs,
        skipFilesystemMcp: opts?.skipFilesystemMcp,
        reasoningEffort: opts?.codexReasoningEffort ?? readCodexReasoningEffortSetting(),
      });
    }
    const bin = opts?.binPath ?? resolveClaudeBin();
    if (!bin) throw new Error('Claude CLI binary path not resolved.');
    return runClaudeCli(prompt, model, deltaSink, {
      binPath: bin,
      timeoutMs,
      idleTimeoutMs,
    });
  };

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_LLM_ATTEMPTS; attempt++) {
    /* 이번 시도에서 실제 텍스트가 한 토큰이라도 흘렀으면, 재시도 시 같은 답이 두 번
       보이게 된다 → 그땐 재시도 금지하고 그대로 실패 전파. 일시 API 오류는 보통 최종
       텍스트가 나오기 전(도구·thinking 단계)에 터져서 emittedText=false 라 깨끗하게 재시도됨. */
    let emittedText = false;
    const sink = (chunk: string) => { if (chunk) emittedText = true; onDelta(chunk); };
    try {
      return await runOnce(sink);
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message || e || '');
      const canRetry = attempt < MAX_LLM_ATTEMPTS && !emittedText
        && !/aborted/i.test(msg) && isTransientLLMError(msg);
      if (!canRetry) throw e;
      /* 지수 백오프(1.5s, 3s) — overloaded 윈도우 짧게 비켜가기. */
      await new Promise(r => setTimeout(r, attempt * 1500));
    }
  }
  throw lastErr;
}

export async function pingCodex(): Promise<string> {
  const bin = resolveCodexBin();
  if (!bin) throw new Error('Codex CLI binary path not resolved.');
  const { spawn } = await import('child_process');
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['--version'], { env: buildSpawnEnv(bin) });
    let out = '';
    let err = '';
    child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    child.stderr.on('data', (b: Buffer) => { err += b.toString(); });
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') {
        reject(new Error(
          `Codex CLI not found at '${bin}'. Install: 'npm install -g @openai/codex' ` +
          `또는 agentOs.codexBinPath 설정.`
        ));
      } else {
        reject(e);
      }
    });
    child.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`codex --version exited ${code}: ${err.trim() || out.trim()}`));
    });
  });
}

export async function pingClaude(): Promise<string> {
  const bin = resolveClaudeBin();
  if (!bin) {
    throw new Error('Claude CLI binary path not resolved.');
  }
  const { spawn } = await import('child_process');
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['--version'], { env: buildSpawnEnv(bin) });
    let out = '';
    let err = '';
    child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    child.stderr.on('data', (b: Buffer) => { err += b.toString(); });
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') {
        reject(new Error(
          `Claude CLI not found at '${bin}'. Install: 'npm install -g @anthropic-ai/claude-code' ` +
          `or set agentOs.claudeBinPath.`
        ));
      } else {
        reject(e);
      }
    });
    child.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`claude --version exited ${code}: ${err.trim() || out.trim()}`));
    });
  });
}
