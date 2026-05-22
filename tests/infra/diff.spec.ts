import { describe, it, expect } from 'vitest';
import { renderUnifiedDiff } from '../../src/infra/diff';

describe('renderUnifiedDiff', () => {
    it('동일한 입력이면 빈 문자열을 반환한다', () => {
        // Given: before === after
        const text = 'line A\nline B\nline C';
        // When: render
        const out = renderUnifiedDiff(text, text);
        // Then: 빈 문자열
        expect(out).toBe('');
    });

    it('한 줄 변경 시 - 와 + 라인을 모두 포함한다', () => {
        // Given: 한 줄만 다른 두 버전
        const before = 'a\nb\nc';
        const after = 'a\nB\nc';
        // When: render
        const out = renderUnifiedDiff(before, after);
        // Then: hunk 헤더 + 변경 줄
        expect(out).toContain('@@');
        expect(out).toContain('-b');
        expect(out).toContain('+B');
    });

    it('변경 부분 앞뒤로 컨텍스트 줄을 포함한다', () => {
        // Given: ctx=2
        const before = 'a\nb\nc\nd\ne';
        const after = 'a\nb\nX\nd\ne';
        // When
        const out = renderUnifiedDiff(before, after, 2);
        // Then: 앞/뒤 컨텍스트 모두 들어감
        expect(out).toContain(' a');
        expect(out).toContain(' b');
        expect(out).toContain(' d');
        expect(out).toContain(' e');
    });

    it('변경이 52줄을 넘으면 잘라내고 마커를 추가한다', () => {
        // Given: 60줄 차이
        const before = Array.from({ length: 60 }, (_, i) => `before-${i}`).join('\n');
        const after = Array.from({ length: 60 }, (_, i) => `after-${i}`).join('\n');
        // When
        const out = renderUnifiedDiff(before, after);
        // Then: 잘림 마커
        expect(out).toMatch(/줄 더 있음/);
    });
});
