import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { runClaudeCli } from './claude-cli';
import { runCodexCli } from './codex-cli';

export type Tier = 'heavy' | 'standard' | 'light';
export type Provider = 'claude' | 'codex';

export interface AskOptions {
  model?: string;
  binPath?: string;
  timeoutMs?: number;
}

const TIER_TO_MODEL: Record<Tier, string> = {
  heavy: 'claude-opus-4-7',
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

export async function streamAsk(
  prompt: string,
  tier: Tier | undefined,
  onDelta: (chunk: string) => void,
  opts?: AskOptions
): Promise<string> {
  const model = resolveModel(tier, opts);
  const provider = providerFor(model);
  if (provider === 'codex') {
    const bin = opts?.binPath ?? resolveCodexBin();
    if (!bin) throw new Error('Codex CLI binary path not resolved.');
    return runCodexCli(prompt, model, onDelta, {
      binPath: bin,
      timeoutMs: opts?.timeoutMs
    });
  }
  const bin = opts?.binPath ?? resolveClaudeBin();
  if (!bin) throw new Error('Claude CLI binary path not resolved.');
  return runClaudeCli(prompt, model, onDelta, {
    binPath: bin,
    timeoutMs: opts?.timeoutMs
  });
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
