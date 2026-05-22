/**
 * Tracker disk IO (`_shared/tracker.json`).
 *
 * extension.ts 에서 분리됨. companyDir 는 외부에서 주입; vscode 의존성 없음.
 * EventEmitter (UI refresh) 는 모듈에 포함하지 않는다 — 호출자(extension.ts
 * wrapper) 가 writeTracker 성공 후 직접 fire 한다.
 *
 * 손상된 JSON 은 빈 tasks 배열로 안전 fallback — tracker 에러가 절대 다른
 * 흐름을 깨트리지 않게 한다 (원본 정책 그대로).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { TrackerTask } from './types';

/** Disk path for the per-company tracker file. */
export function trackerPath(companyDir: string): string {
    return path.join(companyDir, '_shared', 'tracker.json');
}

/**
 * Read tracker.json from disk. Always returns `{ tasks: TrackerTask[] }` —
 * missing file or malformed JSON yields an empty array.
 */
export function readTracker(companyDir: string): { tasks: TrackerTask[] } {
    try {
        const p = trackerPath(companyDir);
        if (!fs.existsSync(p)) return { tasks: [] };
        const raw = fs.readFileSync(p, 'utf-8');
        const parsed = JSON.parse(raw || '{}');
        return { tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [] };
    } catch { return { tasks: [] }; }
}

/**
 * Atomically (write-then-rename is overkill here — single fs.writeFileSync
 * is what the original used) persist the tracker. Creates `_shared/` if
 * missing. Swallows errors — tracker IO never breaks the calling flow.
 *
 * NOTE: This module does NOT fire any UI-refresh event. Callers that want
 * to notify a TreeView should wrap this and emit their own event after.
 */
export function writeTracker(companyDir: string, t: { tasks: TrackerTask[] }): void {
    try {
        const dir = path.join(companyDir, '_shared');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(trackerPath(companyDir), JSON.stringify(t, null, 2));
    } catch { /* never let tracker errors break flow */ }
}
