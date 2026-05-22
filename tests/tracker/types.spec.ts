import { describe, it, expect } from 'vitest';
import {
    coercePriority,
    TASK_PRIORITY_ORDER,
    TASK_PRIORITY_LABEL,
} from '../../src/tracker/types';

describe('tracker/types', () => {
    it('coercePriority 는 유효 값 그대로', () => {
        // Given/When/Then
        expect(coercePriority('urgent')).toBe('urgent');
        expect(coercePriority('high')).toBe('high');
        expect(coercePriority('low')).toBe('low');
        // 'normal' 도 그대로 유지되어야 한다 (단, 코드 경로는 fallback 분기)
        expect(coercePriority('normal')).toBe('normal');
    });

    it("coercePriority 는 무효 값 → 'normal'", () => {
        // Given/When/Then
        expect(coercePriority(undefined)).toBe('normal');
        expect(coercePriority(null)).toBe('normal');
        expect(coercePriority('')).toBe('normal');
        expect(coercePriority('bogus')).toBe('normal');
        expect(coercePriority(42)).toBe('normal');
        expect(coercePriority({})).toBe('normal');

        // 그리고 정렬 순서/라벨 상수도 모든 priority 를 다룬다 (sanity)
        expect(TASK_PRIORITY_ORDER.urgent).toBe(0);
        expect(TASK_PRIORITY_ORDER.low).toBe(3);
        expect(TASK_PRIORITY_LABEL.urgent).toContain('긴급');
        expect(TASK_PRIORITY_LABEL.normal).toContain('보통');
    });
});
