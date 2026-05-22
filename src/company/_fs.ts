/**
 * Tiny internal fs helper for company modules.
 *
 * extension.ts 의 _safeReadText 와 동일한 동작 — fs.readFileSync 실패 시
 * 빈 문자열을 반환해 caller 가 분기 안 해도 되도록.
 */
import * as fs from 'fs';

export function safeReadText(p: string): string {
    try {
        return fs.readFileSync(p, 'utf8');
    } catch {
        return '';
    }
}
