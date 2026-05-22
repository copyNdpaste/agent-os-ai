/**
 * Unified diff renderer (단순 chunk 비교).
 *
 * extension.ts 에서 분리됨 — pure 함수. edit_file 후 변경 hunk 표시용.
 */

/**
 * Claude 익스텐션 호환 unified diff. 변경 hunk 를 ±ctx 컨텍스트로 표시.
 * 변경 없으면 빈 문자열. 50줄 cap.
 */
export function renderUnifiedDiff(before: string, after: string, ctx: number = 3): string {
    if (before === after) return '';
    const a = before.split('\n');
    const b = after.split('\n');
    let prefixLen = 0;
    while (prefixLen < a.length && prefixLen < b.length && a[prefixLen] === b[prefixLen]) prefixLen++;
    let suffixLen = 0;
    while (
        suffixLen < a.length - prefixLen &&
        suffixLen < b.length - prefixLen &&
        a[a.length - 1 - suffixLen] === b[b.length - 1 - suffixLen]
    ) suffixLen++;
    const aChanged = a.slice(prefixLen, a.length - suffixLen);
    const bChanged = b.slice(prefixLen, b.length - suffixLen);
    const ctxStart = Math.max(0, prefixLen - ctx);
    const ctxEndA = Math.min(a.length, a.length - suffixLen + ctx);
    const ctxEndB = Math.min(b.length, b.length - suffixLen + ctx);
    const out: string[] = [];
    out.push(`@@ -${ctxStart + 1},${ctxEndA - ctxStart} +${ctxStart + 1},${ctxEndB - ctxStart} @@`);
    for (let i = ctxStart; i < prefixLen; i++) out.push(' ' + a[i]);
    for (const line of aChanged) out.push('-' + line);
    for (const line of bChanged) out.push('+' + line);
    for (let i = a.length - suffixLen; i < ctxEndA; i++) out.push(' ' + a[i]);
    if (out.length > 52) {
        return out.slice(0, 52).join('\n') + '\n... (' + (out.length - 52) + '줄 더 있음)';
    }
    return out.join('\n');
}
