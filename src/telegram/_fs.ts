/**
 * Tiny internal fs helper for telegram modules.
 *
 * extension.ts 에서 분리됨. _safeReadText 의 module-local 버전 —
 * fs.readFileSync 가 실패하면 빈 문자열을 반환해 caller 가 분기 안 해도 되도록.
 */
import * as fs from 'fs';

export function safeReadText(p: string): string {
    try {
        return fs.readFileSync(p, 'utf8');
    } catch {
        return '';
    }
}
