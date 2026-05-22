/**
 * <glob> action handler (Claude-extension-compatible glob search).
 * Extracted verbatim from `_executeActions` ("ACTION NEW v2.89.104: Glob").
 */
import * as os from 'os';
import { resolveFlexiblePath as _resolveFlexiblePath } from '../../infra/path-safety';
import { globMatch as _globMatch } from '../../infra/glob';
import type { ActionContext } from './types';

const globRegex = /<glob\s+(?:[^>]*?\b)?pattern=['"]([^'"]+)['"](?:\s+(?:path|dir|root)=['"]?([^'">]+)['"]?)?[^>]*\/?>(?:<\/glob>)?/gi;

export async function executeGlob(ctx: ActionContext): Promise<void> {
    const { aiMessage, rootPath, report, opts } = ctx;
    const re = new RegExp(globRegex.source, globRegex.flags);
    let match: RegExpExecArray | null;

    while ((match = re.exec(aiMessage)) !== null) {
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
            else ctx.pushChatHistory({ role: 'user', content: injection });
        } catch (err: any) {
            report.push(`❌ glob 실패: ${pattern} — ${err.message}`);
        }
    }
}
