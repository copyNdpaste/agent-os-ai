/**
 * Tiny internal fs helper for approvals modules.
 *
 * company/_fs.ts 와 동일한 동작 — fs.readFileSync 실패 시 빈 문자열 반환.
 */
import * as fs from 'fs';

export function safeReadText(p: string): string {
    try {
        return fs.readFileSync(p, 'utf8');
    } catch {
        return '';
    }
}
