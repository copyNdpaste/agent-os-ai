/* Codex CLI runner — OpenAI 의 `codex` 바이너리를 spawn 해서 GPT 호출.
   Claude CLI 와 다른 점:
   - `codex exec` 가 비대화형 실행 모드 (one-shot, stdout 으로 답 출력)
   - stream-json 같은 구조화 출력 대신 그냥 stdout 텍스트 → 받은 chunk 그대로
     onDelta 로 흘리고, close 시 누적 텍스트 반환
   - 모델 지정: `-m <model>` (예: gpt-5.5)
   - PATH 보정은 claude-cli 와 동일하게 buildSpawnEnv 재사용 (codex 도
     `#!/usr/bin/env node` shebang 패턴) */
import { spawn } from 'child_process';
import { buildSpawnEnv } from './index';

export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

interface RunOptions {
  binPath: string;
  /** Wall-clock max. default 25분. */
  timeoutMs?: number;
  /** Idle timeout — 마지막 chunk 후 N분 idle 이면 SIGTERM. default 5분. */
  idleTimeoutMs?: number;
  /** v2.92.x — filesystem MCP 비활성. CEO planner 같은 단순 JSON 분류기는 파일 접근 필요 X.
   *  큰 워크스페이스 (.venv / node_modules / .pytest_cache) 에서 MCP init 으로 5분 timeout 사고 차단. */
  skipFilesystemMcp?: boolean;
  /** Codex/GPT reasoning effort. Passed as model_reasoning_effort config override. */
  reasoningEffort?: CodexReasoningEffort;
}

/* v2.92.x — claude-cli 와 동일 (idle + wall, 0=무제한). */
const DEFAULT_IDLE_TIMEOUT_MS = 900_000;     // 15분 idle 면 죽음
const DEFAULT_WALL_TIMEOUT_MS = 0;           // 0 = wall 무제한

/** 현재 VS Code 워크스페이스 폴더들. 첫 번째는 cwd/--cd, 나머지는 --add-dir 로 넘긴다. */
function getCurrentWorkspaceFolders(): string[] {
  try {
    const vscode = require('vscode');
    const wf = vscode?.workspace?.workspaceFolders;
    if (wf && wf.length > 0) {
      return wf.map((f: any) => f?.uri?.fsPath).filter((p: any) => typeof p === 'string' && p.length > 0);
    }
  } catch { /* vscode unavailable */ }
  return [];
}

export function runCodexCli(
  prompt: string,
  model: string,
  onDelta: (chunk: string) => void,
  opts: RunOptions
): Promise<string> {
  const wallTimeoutMs = opts.timeoutMs ?? DEFAULT_WALL_TIMEOUT_MS;
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const wsFolders = getCurrentWorkspaceFolders();
  const wsFolder = wsFolders[0];

  /* `codex exec` — 비대화형 one-shot. -m 으로 모델 지정. 마지막 인자가
     prompt. --skip-git-repo-check 는 워크스페이스 검사 우회 (확장에서
     호출할 땐 cwd 가 임의일 수 있음).

     워크스페이스 격리 (사장님 요구): 매 호출마다 cwd + filesystem MCP path 를
     현재 워크스페이스로 동적 주입. 글로벌 ~/.codex/config.toml 에 박힌
     filesystem path 가 있어도 -c 가 override 함. alpha-agent-ai 에서 호출
     → alpha-agent-ai 만 접근. 다른 ws 열면 그 ws 만. */
  /* v2.92.x — --ignore-user-config 로 사장님 ~/.codex/config.toml 의 무거운 MCP 들 (node_repl
     startup_timeout 120s, browser/computer-use plugins 등) 자체를 우회. 사장님 dispatch 는
     backend 의 inline action tag (<read_file>/<edit_file>/<run_command>) 로 파일 작업 처리
     하므로 codex 의 빌트인 MCP / plugin 필요 X. 깔끔한 spawn → 빠른 응답. auth 는 --ignore-user-config
     기조 하에서도 CODEX_HOME 로 정상 사용. */
  const args = [
    'exec',
    '--ignore-user-config',
    '--skip-git-repo-check',
    /* `--ignore-user-config` also drops the user's sandbox profile. Without an
       explicit sandbox Codex exec can fall back to read-only, so developer
       agents report "apply_patch blocked by read-only sandbox" even when the
       VS Code workspace itself is writable. */
    '--sandbox', 'workspace-write',
    '-c', 'approval_policy="never"',
    '-m', model,
  ];
  if (wsFolder) {
    args.push('--cd', wsFolder);
    for (const extra of wsFolders.slice(1)) {
      args.push('--add-dir', extra);
    }
  }
  if (opts.reasoningEffort) {
    args.push('-c', `model_reasoning_effort="${opts.reasoningEffort}"`);
  }
  args.push(prompt);

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    let child;
    try {
      const env = buildSpawnEnv(opts.binPath);
      /* v2.92.x — stdin 'ignore' 로 spawn. codex exec 는 prompt 를 arg 로 받아도 stdin 이 pipe 면
         "Reading additional input from stdin..." 으로 stdin EOF 무한정 기다림 → spawn 한 child 는
         stdin pipe 가 열린 채라 EOF 안 옴 → CEO planner 60초/300초 timeout 사고의 진짜 원인.
         stdin: 'ignore' 로 codex 가 stdin 없다 인식 → arg prompt 만으로 즉시 처리.
         cwd=워크스페이스 → codex 빌트인 도구가 사장님 폴더에 산출물 떨굼 (필요 시). */
      const baseOpts: any = { env, stdio: ['ignore', 'pipe', 'pipe'] };
      if (wsFolder) baseOpts.cwd = wsFolder;
      child = spawn(opts.binPath, args, baseOpts);
    } catch (e) {
      reject(e);
      return;
    }

    let accumulated = '';
    let stderrBuf = '';

    /* v2.92.x — claude-cli 동일 패턴 (idle + wall, 0=무제한). */
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
          ? `wall ${Math.round(wall / 1000)}s > ${Math.round(wallTimeoutMs / 1000)}s (settings agentOs.llmTimeoutWallMin 으로 조절. 0 = 무제한)`
          : `idle ${Math.round(idle / 1000)}s — 응답 멈춤 (settings agentOs.llmTimeoutIdleMin 으로 조절. 0 = 무제한)`;
        settle(() => reject(new Error(`Codex CLI timed out: ${reason}`)));
      }
    }, 15_000) : null;

    child.stdout.on('data', (buf: Buffer) => {
      lastActivity = Date.now();
      const chunk = buf.toString('utf8');
      accumulated += chunk;
      try { onDelta(chunk); } catch { /* consumer errors don't crash us */ }
    });

    child.stderr.on('data', (buf: Buffer) => {
      lastActivity = Date.now();
      stderrBuf += buf.toString('utf8');
    });

    child.on('error', (e: NodeJS.ErrnoException) => {
      if (watchdog) clearInterval(watchdog);
      if (e.code === 'ENOENT') {
        settle(() => reject(new Error(
          `Codex CLI not found at '${opts.binPath}'. ` +
          `Install: 'npm install -g @openai/codex' (또는 brew install codex), ` +
          `또는 settings.json 에서 agentOs.codexBinPath 를 설정해주세요.`
        )));
      } else {
        settle(() => reject(e));
      }
    });

    child.on('close', (code: number | null) => {
      if (watchdog) clearInterval(watchdog);
      if (code !== 0) {
        const detail = stderrBuf.trim() || accumulated.trim() || `exit code ${code}`;
        /* node shebang 못 찾으면 exit 127 + env: node 메시지 — claude-cli 와 동일 진단 */
        if (code === 127 && /env: node|node: No such file/.test(detail)) {
          settle(() => reject(new Error(
            `Codex CLI 가 node 를 못 찾았어요 (exit 127). ` +
            `\`which node\` 로 확인하고, 없으면 \`brew install node\` 또는 nvm 으로 설치. ` +
            `이미 설치돼 있는데도 에러면 VS Code 를 터미널에서 \`code .\` 로 다시 켜보세요.`
          )));
          return;
        }
        /* 인증 안 됨 — codex login 안내 */
        if (/not\s*logged\s*in|unauthorized|api[\s-]?key/i.test(detail)) {
          settle(() => reject(new Error(
            `Codex CLI 인증 안 됨. 터미널에서 \`codex login\` 한 번 실행해주세요. ` +
            `(원본 에러: ${detail.slice(0, 200)})`
          )));
          return;
        }
        settle(() => reject(new Error(`Codex CLI exited ${code}: ${detail}`)));
        return;
      }
      settle(() => resolve(accumulated.trim()));
    });
  });
}
