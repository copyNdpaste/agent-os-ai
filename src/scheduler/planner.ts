/**
 * Schedule planner — pure functions deciding which entry should fire next.
 *
 * extension.ts 에서 분리됨 (god-file 모듈화). 실제 setTimeout / 발송 wrapper 는
 * extension.ts 에 남고, 여기엔 "지금 발사해야 할 entry 가 무엇인가" 의 결정
 * 로직만 둔다 — vscode-runtime concern 과 데이터 결정 로직을 분리.
 *
 * 원본 `_scheduleTick` 규칙:
 *   - entry.enabled 가 true 여야 함
 *   - now 의 hour/minute 와 정확히 일치해야 함
 *   - entry.days 가 비어있지 않으면 now.getDay() 가 포함되어야 함
 *   - entry.lastFiredAt (YYYY-MM-DD) 가 오늘과 같으면 스킵 (오늘 이미 발사)
 */
import type { ReportScheduleEntry } from './types';

/** Pick the next entry from `entries` that is due at `now`. Returns the first
 *  match in iteration order, or `null` if none. Caller decides what to do
 *  with it (fire + stamp lastFiredAt + persist). Pure — no IO, no mutation. */
export function pickNextDue(
    entries: ReportScheduleEntry[],
    now: Date,
): ReportScheduleEntry | null {
    const today = now.toISOString().slice(0, 10);
    const dow = now.getDay();
    const hour = now.getHours();
    const minute = now.getMinutes();
    for (const entry of entries) {
        if (!entry.enabled) continue;
        if (entry.hour !== hour || entry.minute !== minute) continue;
        if (entry.days && entry.days.length > 0 && !entry.days.includes(dow)) continue;
        if (entry.lastFiredAt === today) continue; /* 오늘 이미 실행 */
        return entry;
    }
    return null;
}
