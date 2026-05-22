/**
 * <grep> action handler (Claude-extension-compatible content search).
 * Extracted verbatim from `_executeActions` ("ACTION NEW v2.89.104: Grep").
 */
import * as os from 'os';
import { resolveFlexiblePath as _resolveFlexiblePath } from '../../infra/path-safety';
import { grepFiles as _grepFiles } from '../../infra/glob';
import type { ActionContext } from './types';

const grepRegex = /<grep\s+(?:[^>]*?\b)?pattern=['"]([^'"]+)['"](?:[^>]*?\bpath=['"]?([^'">]+)['"]?)?(?:[^>]*?\bfiles=['"]?([^'">]+)['"]?)?[^>]*\/?>(?:<\/grep>)?/gi;

export async function executeGrep(ctx: ActionContext): Promise<void> {
    const { aiMessage, rootPath, report, opts } = ctx;
    const re = new RegExp(grepRegex.source, grepRegex.flags);
    let match: RegExpExecArray | null;

    while ((match = re.exec(aiMessage)) !== null) {
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
            else ctx.pushChatHistory({ role: 'user', content: injection });
        } catch (err: any) {
            report.push(`❌ grep 실패: ${pattern} — ${err.message}`);
        }
    }
}
