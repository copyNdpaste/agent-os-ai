/**
 * <create_file> / <write_file> / <file> action handler.
 * Extracted verbatim from `_executeActions` in `src/views/sidebar-chat.ts`
 * (action block "ACTION 1: Create files"). Behavior preserved byte-for-byte.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { resolveFlexiblePath as _resolveFlexiblePath } from '../../infra/path-safety';
import { _getBrainDir } from '../../paths';
import type { ActionContext } from './types';

const createRegex = /<(?:create_file|write_file|file)\s+(?:path|file|name|경로|파일)=['"]?([^'">]+)['"]?[^>]*>([\s\S]*?)<\/(?:create_file|write_file|file)>/gi;

export async function executeWriteFile(ctx: ActionContext): Promise<void> {
    const { aiMessage, rootPath, report, opts } = ctx;
    const re = new RegExp(createRegex.source, createRegex.flags);
    let match: RegExpExecArray | null;
    let firstCreatedFile = '';

    while ((match = re.exec(aiMessage)) !== null) {
        const relPath = match[1].trim();
        let content = match[2].trim();

        // Strip markdown code fences if AI accidentally wrapped the content inside the xml
        if (content.startsWith('```')) {
            const lines = content.split('\n');
            if (lines[0].startsWith('```')) lines.shift();
            if (lines.length > 0 && lines[lines.length - 1].startsWith('```')) lines.pop();
            content = lines.join('\n').trim();
        }

        const resolved = _resolveFlexiblePath(relPath, rootPath);
        if (!resolved) {
            report.push(`❌ 생성 차단: ${relPath} — 경로를 해석할 수 없습니다.`);
            continue;
        }
        if (resolved.reason) {
            report.push(`❌ 생성 차단: ${relPath} — ${resolved.reason}`);
            continue;
        }
        const absPath = resolved.abs;
        try {
            const dir = path.dirname(absPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const existed = fs.existsSync(absPath);
            fs.writeFileSync(absPath, content, 'utf-8');
            if (absPath.startsWith(_getBrainDir())) ctx.brainModifiedRef.value = true;
            report.push(`${existed ? '✏️ 덮어씀' : '✅ 생성'}: ${absPath.replace(os.homedir(), '~')}`);
            ctx.trackFileAction(opts?.agentId, absPath, existed ? 'edit' : 'create');
            if (!firstCreatedFile) { firstCreatedFile = absPath; }
        } catch (err: any) {
            report.push(`❌ 생성 실패: ${relPath} — ${err.message}`);
        }
    }

    // Open first created file
    if (firstCreatedFile) {
        await ctx.showTextDocument(vscode.Uri.file(firstCreatedFile));
    }
}
