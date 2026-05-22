import { describe, it, expect } from 'vitest';
import { parseLooseDate, computeNextRunAt } from '../../src/tracker/recurrence';

describe('tracker/recurrence', () => {
    it("computeNextRunAt(date, 'daily') 는 +1일", () => {
        // Given
        const prev = new Date('2026-05-22T09:00:00.000Z');

        // When
        const next = computeNextRunAt(prev, 'daily');

        // Then: +24h (Date.setDate 는 로컬 기준이지만 일 단위라 결과 동일)
        const diff = next.getTime() - prev.getTime();
        expect(diff).toBe(24 * 60 * 60 * 1000);
    });

    it("computeNextRunAt(date, 'weekly') 는 +7일", () => {
        // Given
        const prev = new Date('2026-05-22T09:00:00.000Z');

        // When
        const next = computeNextRunAt(prev, 'weekly');

        // Then
        const diff = next.getTime() - prev.getTime();
        expect(diff).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it("computeNextRunAt(date, 'monthly') 는 +1달", () => {
        // Given
        const prev = new Date('2026-05-22T09:00:00.000Z');

        // When
        const next = computeNextRunAt(prev, 'monthly');

        // Then: 달이 한 단계 진행
        expect(next.getMonth()).toBe((prev.getMonth() + 1) % 12);
        // Year 가 넘어가는 케이스는 12월 → 1월
        const dec = new Date('2026-12-15T09:00:00.000Z');
        const jan = computeNextRunAt(dec, 'monthly');
        expect(jan.getFullYear()).toBe(dec.getFullYear() + 1);
        expect(jan.getMonth()).toBe(0);
    });

    it('parseLooseDate 는 "내일", "+2h", ISO 등 다양한 형태를 처리', () => {
        // ISO
        const iso = parseLooseDate('2026-05-22T15:00:00');
        expect(iso).not.toBeNull();
        expect(iso!.getFullYear()).toBe(2026);

        // 공백 분리된 ISO
        const isoSpace = parseLooseDate('2026-05-22 15:00');
        expect(isoSpace).not.toBeNull();

        // +2h
        const before = Date.now();
        const off = parseLooseDate('+2h');
        const after = Date.now();
        expect(off).not.toBeNull();
        const expectedMin = before + 2 * 3600_000;
        const expectedMax = after + 2 * 3600_000;
        expect(off!.getTime()).toBeGreaterThanOrEqual(expectedMin);
        expect(off!.getTime()).toBeLessThanOrEqual(expectedMax);

        // +30분 (한국어 단위)
        const minKo = parseLooseDate('+30분');
        expect(minKo).not.toBeNull();

        // "내일" → 다음 날 09:00 (로컬)
        const tomorrow = parseLooseDate('내일');
        expect(tomorrow).not.toBeNull();
        expect(tomorrow!.getHours()).toBe(9);
        expect(tomorrow!.getMinutes()).toBe(0);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const expected = new Date(today);
        expected.setDate(today.getDate() + 1);
        expected.setHours(9, 0, 0, 0);
        expect(tomorrow!.toDateString()).toBe(expected.toDateString());

        // "내일 15:30" — HH:MM 분 포함
        const tomAt = parseLooseDate('내일 15:30');
        expect(tomAt).not.toBeNull();
        expect(tomAt!.getHours()).toBe(15);
        expect(tomAt!.getMinutes()).toBe(30);

        // "모레" → +2일 09:00
        const overmorrow = parseLooseDate('모레');
        expect(overmorrow).not.toBeNull();
        expect(overmorrow!.getHours()).toBe(9);
    });

    it('parseLooseDate 는 손상된 입력 시 null', () => {
        expect(parseLooseDate('')).toBeNull();
        expect(parseLooseDate('   ')).toBeNull();
        expect(parseLooseDate('garbage')).toBeNull();
        expect(parseLooseDate('not-a-date-at-all')).toBeNull();
    });
});
