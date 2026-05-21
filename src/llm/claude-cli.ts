import { spawn } from 'child_process';

interface RunOptions {
  binPath: string;
  timeoutMs?: number;
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

const DEFAULT_TIMEOUT_MS = 300_000;

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
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
      child = spawn(opts.binPath, args);
    } catch (e) {
      reject(e);
      return;
    }

    let stdoutBuf = '';
    let stderrBuf = '';
    let accumulated = '';
    let finalResult: string | null = null;
    let errorFromStream: string | null = null;

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
      settle(() => reject(new Error(`Claude CLI timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    child.stdout.on('data', (buf: Buffer) => {
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
      stderrBuf += buf.toString('utf8');
    });

    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
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
      clearTimeout(timer);
      if (errorFromStream) {
        settle(() => reject(new Error(errorFromStream as string)));
        return;
      }
      if (code !== 0) {
        const detail = stderrBuf.trim() || stdoutBuf.trim() || `exit code ${code}`;
        settle(() => reject(new Error(`Claude CLI exited ${code}: ${detail}`)));
        return;
      }
      settle(() => resolve(finalResult ?? accumulated));
    });
  });
}
