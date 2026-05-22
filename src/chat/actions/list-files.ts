/**
 * <list_files> / <list_dir> / <ls> action handler.
 * Extracted verbatim from `_executeActions` ("ACTION 5: List directory").
 */
import * as fs from 'fs';
import * as os from 'os';
import { resolveFlexiblePath as _resolveFlexiblePath } from '../../infra/path-safety';
import { EXCLUDED_DIRS } from '../../extension';
import type { ActionContext } from './types';

const listRegex = /<(?:list_files|list_dir|ls)\s+(?:path|dir|name|경로|파일)=['"]?([^'">]*?)['"]?\s*\/?>(?:<\/(?:list_files|list_dir|ls)>)?/gi;

export async function executeListFiles(ctx: ActionContext): Promise<void> {
    const { aiMessage, rootPath, report, opts } = ctx;
    const re = new RegExp(listRegex.source, listRegex.flags);
    let match: RegExpExecArray | null;

    while ((match = re.exec(aiMessage)) !== null) {
        const relDir = match[1].trim() || '.';
        const resolved = _resolveFlexiblePath(relDir, rootPath);
        if (!resolved) {
            report.push(`❌ 목록 차단: ${relDir} — 경로를 해석할 수 없습니다.`);
            continue;
        }
        if (resolved.reason) {
            report.push(`❌ 목록 차단: ${relDir} — ${resolved.reason}`);
            continue;
        }
        const absDir = resolved.abs;
        try {
            if (fs.existsSync(absDir) && fs.statSync(absDir).isDirectory()) {
                const entries = fs.readdirSync(absDir, { withFileTypes: true });
                const listing = entries
                    .filter(e => !e.name.startsWith('.') && !EXCLUDED_DIRS.has(e.name))
                    .map(e => e.isDirectory() ? `📁 ${e.name}/` : `📄 ${e.name}`)
                    .join('\n') || '_(빈 디렉토리)_';
                report.push(`📂 목록: ${absDir.replace(os.homedir(), '~')}/\n\`\`\`\n${listing}\n\`\`\``);
                const injection = `[시스템: list_files 결과]\n디렉토리: ${absDir.replace(os.homedir(), '~')}/\n${listing}`;
                if (opts?.appendToOutput) opts.appendToOutput('\n\n' + injection);
                else ctx.pushChatHistory({ role: 'user', content: injection });
            } else {
                const hint = ctx.fuzzyPathHint(absDir);
                report.push(`⚠️ 목록 실패: ${relDir} — 디렉토리가 존재하지 않습니다.${hint}`);
                /* hint 를 다음 LLM turn 도 보게 chat history (또는 inline) 에 주입 */
                if (hint) {
                    const injection = `[시스템: list_files 실패]\n경로: ${absDir}\n${hint}`;
                    if (opts?.appendToOutput) opts.appendToOutput('\n\n' + injection);
                    else ctx.pushChatHistory({ role: 'user', content: injection });
                }
            }
        } catch (err: any) {
            report.push(`❌ 목록 실패: ${relDir} — ${err.message}`);
        }
    }
}
