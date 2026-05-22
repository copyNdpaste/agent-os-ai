/**
 * <delete_file> / <delete> action handler.
 * Extracted verbatim from `_executeActions` ("ACTION 3: Delete files").
 */
import * as fs from 'fs';
import * as os from 'os';
import { resolveFlexiblePath as _resolveFlexiblePath } from '../../infra/path-safety';
import { _getBrainDir } from '../../paths';
import type { ActionContext } from './types';

const deleteRegex = /<(?:delete_file|delete)\s+(?:path|file|name|경로|파일)=['"]?([^'">]+?)['"]?\s*\/?>(?:<\/(?:delete_file|delete)>)?/gi;

export async function executeDeleteFile(ctx: ActionContext): Promise<void> {
    const { aiMessage, rootPath, report, opts } = ctx;
    const re = new RegExp(deleteRegex.source, deleteRegex.flags);
    let match: RegExpExecArray | null;

    while ((match = re.exec(aiMessage)) !== null) {
        const relPath = match[1].trim();
        const resolved = _resolveFlexiblePath(relPath, rootPath);
        if (!resolved) {
            report.push(`❌ 삭제 차단: ${relPath} — 경로를 해석할 수 없습니다.`);
            continue;
        }
        if (resolved.reason) {
            report.push(`❌ 삭제 차단: ${relPath} — ${resolved.reason}`);
            continue;
        }
        const absPath = resolved.abs;
        /* 안전장치: 사용자 홈 자체나 루트 직접 삭제 차단 */
        if (absPath === os.homedir() || absPath === '/' || /^[A-Z]:\\?$/i.test(absPath)) {
            report.push(`❌ 삭제 차단: ${absPath} — 홈/루트 디렉토리 직접 삭제 금지.`);
            continue;
        }
        try {
            if (fs.existsSync(absPath)) {
                const stat = fs.statSync(absPath);
                if (stat.isDirectory()) {
                    fs.rmSync(absPath, { recursive: true, force: true });
                } else {
                    fs.unlinkSync(absPath);
                }
                if (absPath.startsWith(_getBrainDir())) ctx.brainModifiedRef.value = true;
                report.push(`🗑️ 삭제: ${absPath.replace(os.homedir(), '~')}`);
                ctx.trackFileAction(opts?.agentId, absPath, 'delete');
            } else {
                report.push(`⚠️ 삭제 스킵: ${relPath} — 파일이 존재하지 않습니다.`);
            }
        } catch (err: any) {
            report.push(`❌ 삭제 실패: ${relPath} — ${err.message}`);
        }
    }
}
