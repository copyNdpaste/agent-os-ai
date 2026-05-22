/**
 * <run_command> / <command> / <bash> / <terminal> action handler.
 * Extracted verbatim from `_executeActions` ("ACTION 6: Run commands").
 *
 * Behavior: streams output to the webview as the command produces it,
 * captures full result, injects back into chat history so the AI can see it.
 */
import { runCommandCaptured } from '../../infra/process';
import type { ActionContext } from './types';

const cmdRegex = /<(?:run_command|command|bash|terminal)>([\s\S]*?)<\/(?:run_command|command|bash|terminal)>/gi;

export async function executeRunCommand(ctx: ActionContext): Promise<void> {
    const { aiMessage, rootPath, report, opts } = ctx;
    if (opts?.skipRunCommand) return;

    const re = new RegExp(cmdRegex.source, cmdRegex.flags);
    let match: RegExpExecArray | null;

    while ((match = re.exec(aiMessage)) !== null) {
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
            ctx.postWebview({ type: 'streamChunk', value: headerMsg });
        }

        try {
            /* v2.89.77 — 60초 → 25분. 음악 생성·모델 설치·영상 합치기처럼 시간이
               오래 걸리는 도구가 chat 경로로도 실행됨. dispatch 경로(line 16386)와
               맞추는 게 자연스러움. 짧은 명령은 어차피 빨리 끝나니까 손해 없음. */
            const result = await runCommandCaptured(cmd, rootPath, (chunk) => {
                if (!opts?.appendToOutput) {
                    ctx.postWebview({ type: 'streamChunk', value: chunk });
                }
            }, 25 * 60 * 1000);
            if (!opts?.appendToOutput) {
                ctx.postWebview({ type: 'streamChunk', value: '\n```\n' });
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
            else ctx.pushChatHistory({ role: 'user', content: injection });
        } catch (err: any) {
            report.push(`❌ 명령 실패: \`${cmd}\` — ${err.message}`);
            if (!opts?.appendToOutput) {
                ctx.postWebview({ type: 'streamChunk', value: `\n[실행 오류] ${err.message}\n\`\`\`\n` });
            }
        }
    }
}
