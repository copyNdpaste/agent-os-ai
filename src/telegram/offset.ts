/**
 * Telegram getUpdates polling offset persistence.
 *
 * extension.ts 에서 분리됨 (god-file Telegram 모듈화). userBrain (e.g.
 * ~/.agent-os-ai-brain) 은 외부에서 주입한다. 같은 이유로 offset도 유저 레벨
 * 파일에 저장 — globalState 의존 X, 워크스페이스 단위로 갈리지 않음.
 */
import * as fs from 'fs';
import * as path from 'path';

export function offsetPath(userBrain: string): string {
    try { fs.mkdirSync(userBrain, { recursive: true }); } catch { /* ignore */ }
    return path.join(userBrain, '.telegram_offset.json');
}

export function readOffset(userBrain: string): number {
    try {
        const p = offsetPath(userBrain);
        if (!fs.existsSync(p)) return 0;
        const data = JSON.parse(fs.readFileSync(p, 'utf-8') || '{}');
        return Number(data.offset) || 0;
    } catch { return 0; }
}

export function writeOffset(userBrain: string, offset: number): void {
    try {
        fs.writeFileSync(offsetPath(userBrain), JSON.stringify({ offset, ts: Date.now() }));
    } catch { /* ignore */ }
}
