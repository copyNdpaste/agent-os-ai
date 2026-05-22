/**
 * <reveal_in_explorer> / <open_file> action handlers (OS-level reveal + launch).
 * Extracted verbatim from `_executeActions`.
 */
import * as os from 'os';
import { resolveFlexiblePath as _resolveFlexiblePath } from '../../infra/path-safety';
import {
    revealInOsExplorer as _revealInOsExplorer,
    openInDefaultApp as _openInDefaultApp,
} from '../../infra/system';
import type { ActionContext } from './types';

const revealRegex = /<(?:reveal_in_explorer|reveal|finder|explorer)\s+(?:path|file|name|경로|파일)=['"]?([^'">]+?)['"]?\s*\/?>(?:<\/(?:reveal_in_explorer|reveal|finder|explorer)>)?/gi;
const openAppRegex = /<(?:open_file|open_in_app|launch)\s+(?:path|file|name|경로|파일)=['"]?([^'">]+?)['"]?\s*\/?>(?:<\/(?:open_file|open_in_app|launch)>)?/gi;

export async function executeRevealInExplorer(ctx: ActionContext): Promise<void> {
    const { aiMessage, rootPath, report } = ctx;
    const re = new RegExp(revealRegex.source, revealRegex.flags);
    let match: RegExpExecArray | null;

    while ((match = re.exec(aiMessage)) !== null) {
        const relPath = match[1].trim();
        const resolved = _resolveFlexiblePath(relPath, rootPath);
        if (!resolved) { report.push(`❌ 익스플로러 열기 실패: ${relPath} — 경로 해석 불가.`); continue; }
        const r = _revealInOsExplorer(resolved.abs);
        report.push((r.ok ? '🗂 ' : '❌ ') + r.message.replace(os.homedir(), '~'));
    }
}

export async function executeOpenFile(ctx: ActionContext): Promise<void> {
    const { aiMessage, rootPath, report } = ctx;
    const re = new RegExp(openAppRegex.source, openAppRegex.flags);
    let match: RegExpExecArray | null;

    while ((match = re.exec(aiMessage)) !== null) {
        const relPath = match[1].trim();
        const resolved = _resolveFlexiblePath(relPath, rootPath);
        if (!resolved) { report.push(`❌ 파일 열기 실패: ${relPath} — 경로 해석 불가.`); continue; }
        const r = _openInDefaultApp(resolved.abs);
        report.push((r.ok ? '🚀 ' : '❌ ') + r.message.replace(os.homedir(), '~'));
    }
}
