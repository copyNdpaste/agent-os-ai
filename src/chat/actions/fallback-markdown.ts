/**
 * Fallback handler — runs only when no other action produced output.
 * Detects ```lang\n// file: path/to/file.ts\n...``` style code fences and
 * creates the file. Extracted verbatim from `_executeActions` ("FALLBACK").
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { safeResolveInside } from '../../infra/path-safety';
import type { ActionContext } from './types';

const fallbackRegex = /```(?:[a-zA-Z]*)?\s*\n\/\/\s*(?:file|파일):\s*([^\n]+)\n([\s\S]*?)```/gi;

/**
 * Returns true if it ran (i.e. when `report` was empty on entry). The
 * coordinator decides whether to invoke based on the same condition the
 * original method used.
 */
export async function executeFallbackMarkdown(ctx: ActionContext): Promise<void> {
    const { aiMessage, rootPath, report } = ctx;
    const re = new RegExp(fallbackRegex.source, fallbackRegex.flags);
    let match: RegExpExecArray | null;
    let firstCreatedFile = '';

    while ((match = re.exec(aiMessage)) !== null) {
        const relPath = match[1].trim();
        const content = match[2].trim();
        if (relPath && content && relPath.includes('.')) {
            const absPath = safeResolveInside(rootPath, relPath);
            if (!absPath) {
                report.push(`❌ 생성 차단: ${relPath} — 워크스페이스 밖으로 나가는 경로입니다.`);
                continue;
            }
            try {
                const dir = path.dirname(absPath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(absPath, content, 'utf-8');
                report.push(`✅ 생성(자동감지): ${relPath}`);
                if (!firstCreatedFile) firstCreatedFile = absPath;
            } catch (err: any) {
                report.push(`❌ 생성 실패: ${relPath} — ${err.message}`);
            }
        }
    }
    if (firstCreatedFile) {
        await ctx.showTextDocument(vscode.Uri.file(firstCreatedFile));
    }
}
