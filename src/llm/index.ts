import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { runClaudeCli } from './claude-cli';

export type Tier = 'heavy' | 'standard' | 'light';

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
    const cfg = vscode.workspace.getConfiguration('connectAiLab');
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

export async function ask(
  prompt: string,
  tier?: Tier,
  opts?: AskOptions
): Promise<string> {
  const model = resolveModel(tier, opts);
  const bin = opts?.binPath ?? resolveClaudeBin();
  if (!bin) {
    throw new Error('Claude CLI binary path not resolved.');
  }
  return runClaudeCli(prompt, model, () => { /* no streaming */ }, {
    binPath: bin,
    timeoutMs: opts?.timeoutMs
  });
}

export async function streamAsk(
  prompt: string,
  tier: Tier | undefined,
  onDelta: (chunk: string) => void,
  opts?: AskOptions
): Promise<string> {
  const model = resolveModel(tier, opts);
  const bin = opts?.binPath ?? resolveClaudeBin();
  if (!bin) {
    throw new Error('Claude CLI binary path not resolved.');
  }
  return runClaudeCli(prompt, model, onDelta, {
    binPath: bin,
    timeoutMs: opts?.timeoutMs
  });
}

export async function pingClaude(): Promise<string> {
  const bin = resolveClaudeBin();
  if (!bin) {
    throw new Error('Claude CLI binary path not resolved.');
  }
  const { spawn } = await import('child_process');
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['--version']);
    let out = '';
    let err = '';
    child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    child.stderr.on('data', (b: Buffer) => { err += b.toString(); });
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') {
        reject(new Error(
          `Claude CLI not found at '${bin}'. Install: 'npm install -g @anthropic-ai/claude-code' ` +
          `or set connectAiLab.claudeBinPath.`
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
