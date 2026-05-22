import { describe, it, expect } from 'vitest';
import { globToRegex } from '../../src/infra/glob';

describe('globToRegex', () => {
    it('"*" 는 슬래시를 제외한 모든 문자에 매치한다', () => {
        // Given: 단순 별표 패턴
        const re = globToRegex('*.md');
        // When/Then
        expect(re.test('foo.md')).toBe(true);
        expect(re.test('a/b.md')).toBe(false);
    });

    it('"**" 는 디렉터리를 가로지른다', () => {
        // Given: 글로벌스타
        const re = globToRegex('**/*.ts');
        // When/Then
        expect(re.test('a.ts')).toBe(true);
        expect(re.test('a/b/c.ts')).toBe(true);
        expect(re.test('a/b/c.txt')).toBe(false);
    });

    it('"?" 는 단일 문자에만 매치한다', () => {
        const re = globToRegex('?.md');
        expect(re.test('a.md')).toBe(true);
        expect(re.test('ab.md')).toBe(false);
    });

    it('대소문자 무관 (i flag)', () => {
        const re = globToRegex('*.MD');
        expect(re.test('readme.md')).toBe(true);
        expect(re.test('README.MD')).toBe(true);
    });

    it('정규식 특수문자가 패턴에 들어가도 안전하게 escape 된다', () => {
        // Given: '.', '+', '(' 같은 정규식 메타문자
        const re = globToRegex('a.b+c');
        // Then: 그대로 매치 (a.b+c) — 메타로 해석 안 됨
        expect(re.test('a.b+c')).toBe(true);
        expect(re.test('axbxc')).toBe(false);
    });
});
