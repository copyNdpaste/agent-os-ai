import { describe, it, expect } from 'vitest';
import { pickNextDue } from '../../src/scheduler/planner';
import type { ReportScheduleEntry } from '../../src/scheduler/types';

/** Construct a Date with hour/minute/dow controlled, today's date string is
 *  derived from the Date itself so the planner's lastFiredAt check is exercised
 *  consistently. We use a fixed Wednesday for determinism. */
function makeDate(h: number, m: number, dayOffsetFromBaseWed = 0): Date {
    // 2026-05-20 is a Wednesday (dow=3). Adjust by dayOffsetFromBaseWed.
    const base = new Date(Date.UTC(2026, 4, 20, h, m, 0));
    base.setUTCDate(base.getUTCDate() + dayOffsetFromBaseWed);
    // Use a local Date that mirrors hour/minute/day-of-week the planner reads
    // via getHours/getMinutes/getDay — but Date.UTC depends on TZ. To keep the
    // test TZ-stable we construct via local components instead.
    return new Date(2026, 4, 20 + dayOffsetFromBaseWed, h, m, 0);
}

describe('scheduler/planner', () => {
    it('pickNextDue 빈 배열이면 null 을 반환한다', () => {
        expect(pickNextDue([], new Date())).toBeNull();
    });

    it('pickNextDue 모든 entry 가 미래 시각이면 null 을 반환한다', () => {
        // Given: 지금이 09:30 인데 모든 entry 는 10:00 / 11:00
        const now = makeDate(9, 30);
        const entries: ReportScheduleEntry[] = [
            { id: 'a', label: 'A', hour: 10, minute: 0, days: [], action: 'briefing', enabled: true },
            { id: 'b', label: 'B', hour: 11, minute: 0, days: [], action: 'briefing', enabled: true },
        ];

        // When / Then
        expect(pickNextDue(entries, now)).toBeNull();
    });

    it('pickNextDue 는 지금 시각·요일·미발사 조건을 만족하는 첫 entry 를 반환한다', () => {
        // Given: 지금이 수요일 09:00. entries 에 09:00 수요일 entry 1개 + 다른 시각 1개.
        const now = makeDate(9, 0); // dow=3 (Wed in local TZ from 2026-05-20)
        const today = now.toISOString().slice(0, 10);
        const dow = now.getDay();

        const entries: ReportScheduleEntry[] = [
            // 다른 시각 (10:00) — pass over
            { id: 'later', label: 'later', hour: 10, minute: 0, days: [], action: 'briefing', enabled: true },
            // 오늘 이미 fired
            { id: 'already', label: 'already', hour: 9, minute: 0, days: [dow], action: 'briefing', enabled: true, lastFiredAt: today },
            // 비활성
            { id: 'off', label: 'off', hour: 9, minute: 0, days: [dow], action: 'briefing', enabled: false },
            // 다른 요일만
            { id: 'wrongdow', label: 'wrongdow', hour: 9, minute: 0, days: [(dow + 1) % 7], action: 'briefing', enabled: true },
            // 정답
            { id: 'match', label: 'match', hour: 9, minute: 0, days: [dow], action: 'briefing', enabled: true },
            // 더 뒤에 또 매치되는 entry — 첫 매치를 반환해야 하므로 이건 안 잡혀야 함
            { id: 'match2', label: 'match2', hour: 9, minute: 0, days: [dow], action: 'briefing', enabled: true },
        ];

        // When
        const picked = pickNextDue(entries, now);

        // Then: 'match' 가 정확히 첫 매치
        expect(picked).not.toBeNull();
        expect(picked?.id).toBe('match');
    });
});
