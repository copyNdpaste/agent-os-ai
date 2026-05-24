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

interface RunOptions {
  binPath: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;

/** 현재 VS Code 워크스페이스 폴더. 없으면 undefined.
 *  codex spawn 의 cwd + filesystem MCP path 양쪽에 쓰여서 워크스페이스간 격리 보장. */
function getCurrentWorkspaceFolder(): string | undefined {
  try {
    const vscode = require('vscode');
    const wf = vscode?.workspace?.workspaceFolders;
    if (wf && wf.length > 0) return wf[0].uri.fsPath;
  } catch { /* vscode unavailable */ }
  return undefined;
}

export function runCodexCli(
  prompt: string,
  model: string,
  onDelta: (chunk: string) => void,
  opts: RunOptions
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const wsFolder = getCurrentWorkspaceFolder();

  /* `codex exec` — 비대화형 one-shot. -m 으로 모델 지정. 마지막 인자가
     prompt. --skip-git-repo-check 는 워크스페이스 검사 우회 (확장에서
     호출할 땐 cwd 가 임의일 수 있음).

     워크스페이스 격리 (사장님 요구): 매 호출마다 cwd + filesystem MCP path 를
     현재 워크스페이스로 동적 주입. 글로벌 ~/.codex/config.toml 에 박힌
     filesystem path 가 있어도 -c 가 override 함. alpha-agent-ai 에서 호출
     → alpha-agent-ai 만 접근. 다른 ws 열면 그 ws 만. */
  const args = [
    'exec',
    '-m', model,
    '--skip-git-repo-check',
  ];
  if (wsFolder) {
    /* TOML array literal 로 path 주입. JSON.stringify 가 큰따옴표·escape 다 처리.
       codex 의 -c <key=value> 는 value 를 TOML 로 parse 시도 → JSON-style array 도 호환. */
    const argsToml = `["-y","@modelcontextprotocol/server-filesystem",${JSON.stringify(wsFolder)}]`;
    args.push('-c', `mcp_servers.filesystem.command="npx"`);
    args.push('-c', `mcp_servers.filesystem.args=${argsToml}`);
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
      /* cwd=워크스페이스 → codex 빌트인 image gen / file write 도구가
         사장님 프로젝트 폴더에 산출물을 떨굼. 워크스페이스 없으면 process cwd
         (extension host) 그대로 — 이 경우는 사이드바만 띄운 채로 명령 친 케이스 */
      child = spawn(opts.binPath, args, wsFolder ? { env, cwd: wsFolder } : { env });
    } catch (e) {
      reject(e);
      return;
    }

    let accumulated = '';
    let stderrBuf = '';

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
      settle(() => reject(new Error(`Codex CLI timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    child.stdout.on('data', (buf: Buffer) => {
      const chunk = buf.toString('utf8');
      accumulated += chunk;
      try { onDelta(chunk); } catch { /* consumer errors don't crash us */ }
    });

    child.stderr.on('data', (buf: Buffer) => {
      stderrBuf += buf.toString('utf8');
    });

    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
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
      clearTimeout(timer);
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
