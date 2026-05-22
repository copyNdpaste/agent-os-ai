/**
 * <edit_file> / <edit> action handler with find/replace + fuzzy fallback.
 * Extracted verbatim from `_executeActions` in `src/views/sidebar-chat.ts`
 * (action block "ACTION 2: Edit files"). Behavior preserved byte-for-byte.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { resolveFlexiblePath as _resolveFlexiblePath } from '../../infra/path-safety';
import { renderUnifiedDiff as _renderUnifiedDiff } from '../../infra/diff';
import { _getBrainDir } from '../../paths';
import type { ActionContext } from './types';

const editRegex = /<(?:edit_file|edit)\s+(?:path|file|name|경로|파일)=['"]?([^'">]+)['"]?[^>]*>([\s\S]*?)<\/(?:edit_file|edit)>/gi;

export async function executeEditFile(ctx: ActionContext): Promise<void> {
    const { aiMessage, rootPath, report, opts } = ctx;
    const re = new RegExp(editRegex.source, editRegex.flags);
    let match: RegExpExecArray | null;

    while ((match = re.exec(aiMessage)) !== null) {
        const relPath = match[1].trim();
        const body = match[2];
        const resolved = _resolveFlexiblePath(relPath, rootPath);
        if (!resolved) {
            report.push(`❌ 편집 차단: ${relPath} — 경로를 해석할 수 없습니다.`);
            continue;
        }
        if (resolved.reason) {
            report.push(`❌ 편집 차단: ${relPath} — ${resolved.reason}`);
            continue;
        }
        const absPath = resolved.abs;

        try {
            let fileContent = fs.readFileSync(absPath, 'utf-8');
            /* v2.89.104 — 편집 전 원본 보관 → diff 표시용 */
            const originalContent = fileContent;
            const findReplaceRegex = /<find>([\s\S]*?)<\/find>\s*<replace>([\s\S]*?)<\/replace>/g;
            let frMatch: RegExpExecArray | null;
            let editCount = 0;
            const fuzzyMisses: string[] = [];

            while ((frMatch = findReplaceRegex.exec(body)) !== null) {
                const findText = frMatch[1];
                const replaceText = frMatch[2];
                if (fileContent.includes(findText)) {
                    fileContent = fileContent.split(findText).join(replaceText);
                    editCount++;
                    continue;
                }
                /* fuzzy 1: 연속 공백·탭을 단일 공백으로 정규화 후 매칭 */
                const norm = (s: string) => s.replace(/[ \t]+/g, ' ').replace(/\r\n/g, '\n');
                const normFile = norm(fileContent);
                const normFind = norm(findText);
                const normIdx = normFile.indexOf(normFind);
                if (normIdx >= 0) {
                    /* 원본 file에서 같은 위치 부분을 찾아 교체 — 인덱스 매핑은
                       근사치라서 normalized 길이로 슬라이스 후 복원. */
                    const before = normFile.slice(0, normIdx);
                    const beforeOrig = fileContent.slice(0, before.length + (fileContent.slice(0, before.length + 50).match(/[ \t]/g)?.length || 0) * 0);
                    /* 안전장치: 단순 split 으로 normalize 매칭 — 정확하지 않을 수 있어
                       confirmation 메시지에 fuzzy 표기 */
                    const lines = fileContent.split('\n');
                    const findLines = findText.split('\n').map(l => l.trim());
                    let foundAt = -1;
                    for (let i = 0; i <= lines.length - findLines.length; i++) {
                        let ok = true;
                        for (let j = 0; j < findLines.length; j++) {
                            if (lines[i + j].trim() !== findLines[j]) { ok = false; break; }
                        }
                        if (ok) { foundAt = i; break; }
                    }
                    if (foundAt >= 0) {
                        const replaceLines = replaceText.split('\n');
                        lines.splice(foundAt, findLines.length, ...replaceLines);
                        fileContent = lines.join('\n');
                        editCount++;
                        report.push(`🔍 fuzzy 매칭으로 교체됨 (공백 차이 무시): ${relPath}`);
                        continue;
                    }
                }
                fuzzyMisses.push(findText.slice(0, 80).replace(/\n/g, ' ⏎ '));
            }
            for (const miss of fuzzyMisses) {
                report.push(`⚠️ ${relPath}: 매칭 실패 — \`${miss}…\` (정확/fuzzy 둘 다 실패)`);
            }

            if (editCount > 0) {
                fs.writeFileSync(absPath, fileContent, 'utf-8');
                if (absPath.startsWith(_getBrainDir())) ctx.brainModifiedRef.value = true;
                /* v2.89.104 — Claude 익스텐션 호환 unified diff 표시. 변경된 hunk만,
                   3줄 컨텍스트. AI도 사람도 무엇이 어떻게 바뀌었는지 한눈에 파악. */
                const diffBlock = _renderUnifiedDiff(originalContent, fileContent, 3);
                const sizeBefore = (Buffer.byteLength(originalContent, 'utf-8') / 1024).toFixed(1);
                const sizeAfter = (Buffer.byteLength(fileContent, 'utf-8') / 1024).toFixed(1);
                const linesBefore = originalContent.split('\n').length;
                const linesAfter = fileContent.split('\n').length;
                const linesDelta = linesAfter - linesBefore;
                const deltaStr = linesDelta === 0 ? '' : (linesDelta > 0 ? ` +${linesDelta}줄` : ` ${linesDelta}줄`);
                if (diffBlock) {
                    report.push(`✏️ 편집 완료: ${absPath.replace(os.homedir(), '~')} (${editCount}건 수정${deltaStr}, ${sizeBefore}KB → ${sizeAfter}KB)\n\`\`\`diff\n${diffBlock}\n\`\`\``);
                } else {
                    report.push(`✏️ 편집 완료: ${absPath.replace(os.homedir(), '~')} (${editCount}건${deltaStr})`);
                }
                ctx.trackFileAction(opts?.agentId, absPath, 'edit');
                // Open edited file
                if (!opts?.silent) {
                    await ctx.showTextDocument(vscode.Uri.file(absPath));
                }
            }
        } catch (err: any) {
            if (err.code === 'ENOENT') {
                report.push(`❌ 편집 실패: ${relPath} — 파일이 존재하지 않습니다.`);
            } else {
                report.push(`❌ 편집 실패: ${relPath} — ${err.message}`);
            }
        }
    }
}
