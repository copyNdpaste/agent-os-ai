import { describe, it, expect } from 'vitest';

describe('vitest 인프라 sanity check', () => {
    it('테스트 러너가 동작한다', () => {
        // Given: 단순 산술식
        const a = 2;
        const b = 3;

        // When: 두 수를 더함
        const sum = a + b;

        // Then: 결과는 5
        expect(sum).toBe(5);
    });
});
