import { spawn } from 'child_process';
import { buildSpawnEnv } from './index';

function getCurrentWorkspaceFolder(): string | undefined {
  try {
    const vscode = require('vscode');
    const wf = vscode?.workspace?.workspaceFolders;
    if (wf && wf.length > 0) return wf[0].uri.fsPath;
  } catch { /* vscode unavailable */ }
  return undefined;
}

interface RunOptions {
  binPath: string;
  /** Wall-clock max — 이 시간 넘으면 무조건 SIGTERM. default 25분. */
  timeoutMs?: number;
  /** Idle timeout — 마지막 chunk 후 이 시간 안에 다음 chunk 없으면 SIGTERM. default 5분. */
  idleTimeoutMs?: number;
}

interface AssistantContentBlock {
  type: string;
  text?: string;
}

interface StreamMessage {
  type: string;
  subtype?: string;
  message?: {
    content?: AssistantContentBlock[];
  };
  result?: string;
  is_error?: boolean;
  error?: string;
}

/* v2.92.x — wall-clock 단일 5분 → (idle + wall) 두 단계 + 0=무제한.
   사장님 사용 패턴:
   - 일반 작업: 한 specialist 의 LLM 호출이 1~5분
   - 큰 작업: claude-opus-4-7 + 큰 컨텍스트 → 10~30분도 가능
   - 24시간 자율: dispatch 전체가 N번 호출 — 각 호출은 여전히 5~30분 안에 끝남
   기본값을 보수적으로 키우고, 사장님이 settings 에서 조절 가능 (0 = 무제한).
   사장님 24시간 자율 시는 wall=0 으로 설정해 한 호출 무제한 ⇒ stuck 안 됨. */
const DEFAULT_IDLE_TIMEOUT_MS = 900_000;     // 15분 chunk 없으면 죽음 판정
const DEFAULT_WALL_TIMEOUT_MS = 0;           // 0 = wall 무제한 (idle 만으로 stuck 잡음). 큰 작업·자율 모드 안전

function tryParse(line: string): StreamMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as StreamMessage;
  } catch {
    return null;
  }
}

export function runClaudeCli(
  prompt: string,
  model: string,
  onDelta: (chunk: string) => void,
  opts: RunOptions
): Promise<string> {
  const wallTimeoutMs = opts.timeoutMs ?? DEFAULT_WALL_TIMEOUT_MS;
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const args = [
    '-p', prompt,
    '--model', model,
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'bypassPermissions'
  ];

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    let child;
    try {
      /* PATH-augmented env so the `#!/usr/bin/env node` shebang inside
         the Claude CLI binary can actually find node. Without this VS
         Code's Dock-launched extension host gets exit 127 on macOS
         because nvm/Volta/asdf paths aren't inherited. */
      const env = buildSpawnEnv(opts.binPath);
      const wsFolder = getCurrentWorkspaceFolder();
      const spawnOpts: any = { env };
      if (wsFolder) spawnOpts.cwd = wsFolder;
      child = spawn(opts.binPath, args, spawnOpts);
    } catch (e) {
      reject(e);
      return;
    }

    let stdoutBuf = '';
    let stderrBuf = '';
    let accumulated = '';
    let finalResult: string | null = null;
    let errorFromStream: string | null = null;

    /* v2.92.x — idle/wall watchdog. 둘 다 0 이면 watchdog 자체 안 만듦 (무제한).
       사장님 24시간 자율 모드는 settings 에서 둘 다 0 으로 — stuck 안 됨. */
    const startTs = Date.now();
    let lastActivity = startTs;
    const idleEnabled = idleTimeoutMs > 0;
    const wallEnabled = wallTimeoutMs > 0;
    const watchdog = (idleEnabled || wallEnabled) ? setInterval(() => {
      const now = Date.now();
      const idle = now - lastActivity;
      const wall = now - startTs;
      const idleViolated = idleEnabled && idle > idleTimeoutMs;
      const wallViolated = wallEnabled && wall > wallTimeoutMs;
      if (idleViolated || wallViolated) {
        if (watchdog) clearInterval(watchdog);
        try { child.kill('SIGTERM'); } catch { /* already dead */ }
        const reason = wallViolated
          ? `wall ${Math.round(wall / 1000)}s > ${Math.round(wallTimeoutMs / 1000)}s 한도 (settings agentOs.llmTimeoutWallMin 으로 조절. 0 = 무제한)`
          : `idle ${Math.round(idle / 1000)}s — 응답 멈춤 (settings agentOs.llmTimeoutIdleMin 으로 조절. 0 = 무제한)`;
        settle(() => reject(new Error(`Claude CLI timed out: ${reason}`)));
      }
    }, 15_000) : null;

    child.stdout.on('data', (buf: Buffer) => {
      lastActivity = Date.now();
      stdoutBuf += buf.toString('utf8');
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        const msg = tryParse(line);
        if (!msg) {
          if (line.trim()) console.warn('[claude-cli] skip non-JSON line:', line.slice(0, 200));
          continue;
        }
        if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
          for (const block of msg.message!.content!) {
            if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
              accumulated += block.text;
              try { onDelta(block.text); } catch { /* consumer errors don't crash us */ }
            }
          }
        } else if (msg.type === 'result') {
          if (msg.is_error) {
            errorFromStream = msg.error || msg.result || 'Claude CLI returned an error';
          } else if (typeof msg.result === 'string') {
            finalResult = msg.result;
          }
        }
      }
    });

    child.stderr.on('data', (buf: Buffer) => {
      lastActivity = Date.now();
      stderrBuf += buf.toString('utf8');
    });

    child.on('error', (e: NodeJS.ErrnoException) => {
      if (watchdog) clearInterval(watchdog);
      if (e.code === 'ENOENT') {
        settle(() => reject(new Error(
          `Claude CLI not found at '${opts.binPath}'. ` +
          `Install from https://docs.claude.com/en/docs/claude-code/setup ` +
          `or set agentOs.claudeBinPath.`
        )));
      } else {
        settle(() => reject(e));
      }
    });

    child.on('close', (code: number | null) => {
      if (watchdog) clearInterval(watchdog);
      if (errorFromStream) {
        settle(() => reject(new Error(errorFromStream as string)));
        return;
      }
      if (code !== 0) {
        const detail = stderrBuf.trim() || stdoutBuf.trim() || `exit code ${code}`;
        /* 흔한 환경 문제 진단 친화적으로 — node 가 PATH 에 없으면
           shebang 실패라 exit 127 + 'env: node: No such file or directory' */
        if (code === 127 && /env: node|node: No such file/.test(detail)) {
          settle(() => reject(new Error(
            `Claude CLI 가 node 를 못 찾았어요 (exit 127). ` +
            `Node.js 가 설치돼 있는지 \`which node\` 로 확인하고, ` +
            `없으면 \`brew install node\` 또는 nvm 으로 설치해주세요. ` +
            `이미 설치돼 있는데도 이 에러가 나면 VS Code 를 터미널에서 \`code .\` 로 다시 켜보세요.`
          )));
          return;
        }
        settle(() => reject(new Error(`Claude CLI exited ${code}: ${detail}`)));
        return;
      }
      settle(() => resolve(finalResult ?? accumulated));
    });
  });
}
