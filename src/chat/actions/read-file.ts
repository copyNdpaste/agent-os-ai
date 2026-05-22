/**
 * <read_file> / <read> action handler.
 * Extracted verbatim from `_executeActions` ("ACTION 4: Read files").
 */
import * as fs from 'fs';
import * as os from 'os';
import { resolveFlexiblePath as _resolveFlexiblePath } from '../../infra/path-safety';
import type { ActionContext } from './types';

const readRegex = /<(?:read_file|read)\s+(?:path|file|name|경로|파일)=['"]?([^'">]+?)['"]?\s*\/?>(?:<\/(?:read_file|read)>)?/gi;
const READ_CAP = 32000;

export async function executeReadFile(ctx: ActionContext): Promise<void> {
    const { aiMessage, rootPath, report, opts } = ctx;
    const re = new RegExp(readRegex.source, readRegex.flags);
    let match: RegExpExecArray | null;

    while ((match = re.exec(aiMessage)) !== null) {
        const relPath = match[1].trim();
        const resolved = _resolveFlexiblePath(relPath, rootPath);
        if (!resolved) {
            report.push(`❌ 읽기 차단: ${relPath} — 경로를 해석할 수 없습니다.`);
            continue;
        }
        if (resolved.reason) {
            report.push(`❌ 읽기 차단: ${relPath} — ${resolved.reason}`);
            continue;
        }
        const absPath = resolved.abs;
        try {
            if (fs.existsSync(absPath)) {
                const stat = fs.statSync(absPath);
                if (stat.isDirectory()) {
                    report.push(`⚠️ 읽기 실패: ${relPath} — 디렉토리입니다. <list_files>를 쓰세요.`);
                    continue;
                }
                /* 바이너리 파일 보호 — 처음 512바이트에 NUL 있으면 binary로 취급 */
                const headBuf = Buffer.alloc(512);
                const fd = fs.openSync(absPath, 'r');
                const headLen = fs.readSync(fd, headBuf, 0, 512, 0);
                fs.closeSync(fd);
                const isBinary = headBuf.slice(0, headLen).includes(0);
                if (isBinary) {
                    const sizeKb = (stat.size / 1024).toFixed(1);
                    report.push(`⚠️ 읽기 스킵: ${relPath} — 바이너리 파일(${sizeKb}KB). 텍스트 파일만 read_file 가능.`);
                    continue;
                }
                const content = fs.readFileSync(absPath, 'utf-8');
                const truncated = content.length > READ_CAP;
                const shown = truncated ? content.slice(0, READ_CAP) : content;
                /* v2.89.104 — Claude 익스텐션 호환 cat -n 스타일 줄번호. AI가 특정 줄을
                   지정해서 edit_file 하기 쉬워짐. 줄번호 너비는 자동 (3~5자리). */
                const lines = shown.split('\n');
                const totalLines = content.split('\n').length;
                const padWidth = String(lines.length).length;
                const numbered = lines.map((line, i) => `${String(i + 1).padStart(padWidth, ' ')}\t${line}`).join('\n');
                const previewLines = lines.slice(0, 10);
                const previewPadWidth = String(Math.min(10, lines.length)).length;
                const preview = previewLines.map((line, i) => `${String(i + 1).padStart(previewPadWidth, ' ')}\t${line}`).join('\n');
                const sizeKb = (stat.size / 1024).toFixed(1);
                const truncNote = truncated ? `\n_⚠️ ${content.length}자 중 처음 ${READ_CAP}자만 표시 (${totalLines}줄 중 ${lines.length}줄) — 전체가 필요하면 더 작은 단위로 분할 읽기._` : '';
                report.push(`📖 읽기: ${absPath.replace(os.homedir(), '~')} (${totalLines}줄, ${sizeKb}KB${truncated ? ', 잘림' : ''})\n\`\`\`\n${preview}${lines.length > 10 ? '\n...' : ''}\n\`\`\``);
                const injection = `[시스템: read_file 결과]\n파일: ${absPath.replace(os.homedir(), '~')} (${totalLines}줄)\n\`\`\`\n${numbered}\n\`\`\`${truncNote}`;
                if (opts?.appendToOutput) {
                    opts.appendToOutput('\n\n' + injection);
                } else {
                    ctx.pushChatHistory({ role: 'user', content: injection });
                }
            } else {
                const hint = ctx.fuzzyPathHint(absPath);
                report.push(`⚠️ 읽기 실패: ${relPath} — 파일이 존재하지 않습니다.${hint}`);
                if (hint) {
                    const injection = `[시스템: read_file 실패]\n경로: ${absPath}\n${hint}`;
                    if (opts?.appendToOutput) opts.appendToOutput('\n\n' + injection);
                    else ctx.pushChatHistory({ role: 'user', content: injection });
                }
            }
        } catch (err: any) {
            report.push(`❌ 읽기 실패: ${relPath} — ${err.message}`);
        }
    }
}
