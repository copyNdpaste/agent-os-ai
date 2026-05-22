import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { safeBasename, safeResolveInside, resolveFlexiblePath } from '../../src/infra/path-safety';

describe('safeBasename', () => {
    it('경로 구분자를 _ 로 치환한다', () => {
        // Given: 슬래시 포함 이름
        const dirty = '../../etc/passwd';
        // When
        const out = safeBasename(dirty);
        // Then: 마지막 segment 만 + 위험 문자 제거
        expect(out).not.toBeNull();
        expect(out).not.toContain('/');
        expect(out).not.toContain('..');
    });

    it('"." 또는 ".." 단독이면 null 을 반환한다', () => {
        expect(safeBasename('.')).toBeNull();
        expect(safeBasename('..')).toBeNull();
    });

    it('정상 파일명은 그대로 통과시킨다', () => {
        expect(safeBasename('hello.md')).toBe('hello.md');
    });

    it('200자 제한을 적용한다', () => {
        const long = 'a'.repeat(300) + '.md';
        const out = safeBasename(long);
        expect(out).not.toBeNull();
        expect(out!.length).toBeLessThanOrEqual(200);
    });
});

describe('safeResolveInside', () => {
    it('root 안 상대경로는 절대경로로 반환한다', () => {
        // Given: 임시 root + 안전 상대경로
        const root = os.tmpdir();
        // When
        const out = safeResolveInside(root, 'sub/file.md');
        // Then: root 시작
        expect(out).not.toBeNull();
        expect(out!.startsWith(path.resolve(root))).toBe(true);
    });

    it('root 밖으로 나가는 traversal 은 null', () => {
        const root = os.tmpdir();
        expect(safeResolveInside(root, '../../etc/passwd')).toBeNull();
    });

    it('절대경로 입력은 null (root 밖 가능성)', () => {
        const root = os.tmpdir();
        expect(safeResolveInside(root, '/etc/passwd')).toBeNull();
    });
});

describe('resolveFlexiblePath', () => {
    it('"~/" 는 홈 디렉터리로 확장된다', () => {
        // Given: tilde 경로
        const out = resolveFlexiblePath('~/Documents/foo.md', '/tmp');
        // Then: 홈으로 시작
        expect(out).not.toBeNull();
        expect(out!.abs.startsWith(os.homedir())).toBe(true);
        expect(out!.reason).toBeUndefined();
    });

    it('시스템 보호 경로(/etc)는 reason 과 함께 차단된다', () => {
        // Given: /etc 경로
        const out = resolveFlexiblePath('/etc/hosts', '/tmp');
        // Then: abs 는 채워지지만 reason 으로 차단 표시
        expect(out).not.toBeNull();
        expect(out!.reason).toBeTruthy();
        expect(out!.reason).toMatch(/시스템 보호 경로/);
    });

    it('빈 문자열은 null', () => {
        expect(resolveFlexiblePath('', '/tmp')).toBeNull();
        expect(resolveFlexiblePath('   ', '/tmp')).toBeNull();
    });

    it('상대경로는 root 기준으로 resolve 된다', () => {
        // Given: 상대경로 + root
        const out = resolveFlexiblePath('foo/bar.md', '/tmp');
        // Then
        expect(out).not.toBeNull();
        expect(out!.abs).toBe(path.normalize('/tmp/foo/bar.md'));
    });
});
