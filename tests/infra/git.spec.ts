import { describe, it, expect } from 'vitest';
import { classifyGitError, validateGitRemoteUrl } from '../../src/infra/git';

describe('classifyGitError', () => {
    it('"authentication failed" → kind=auth', () => {
        // Given: 인증 실패 stderr
        const stderr = 'remote: Authentication failed for https://github.com/foo/bar';
        // When
        const out = classifyGitError(stderr);
        // Then
        expect(out.kind).toBe('auth');
        expect(out.message).toMatch(/인증/);
    });

    it('"repository not found" → kind=not_found', () => {
        const out = classifyGitError('ERROR: Repository not found.');
        expect(out.kind).toBe('not_found');
    });

    it('"rejected non-fast-forward" → kind=rejected', () => {
        const out = classifyGitError('! [rejected] main -> main (non-fast-forward)');
        expect(out.kind).toBe('rejected');
    });

    it('"merge conflict" → kind=merge_conflict', () => {
        const out = classifyGitError('CONFLICT (content): Merge conflict in foo.md');
        expect(out.kind).toBe('merge_conflict');
    });

    it('"could not resolve host" → kind=network', () => {
        const out = classifyGitError('fatal: unable to access: Could not resolve host: github.com');
        expect(out.kind).toBe('network');
    });

    it('알 수 없는 메시지 → kind=unknown 그리고 원문 240자 cap', () => {
        const long = 'x'.repeat(500);
        const out = classifyGitError(long);
        expect(out.kind).toBe('unknown');
        expect(out.message.length).toBeLessThanOrEqual(240);
    });
});

describe('validateGitRemoteUrl', () => {
    it('https:// URL 통과', () => {
        // Given: 정상 https
        const url = 'https://github.com/foo/bar';
        // When
        const out = validateGitRemoteUrl(url);
        // Then: 그대로
        expect(out).toBe(url);
    });

    it('SSH git@host:owner/repo 통과', () => {
        expect(validateGitRemoteUrl('git@github.com:foo/bar.git')).toBe('git@github.com:foo/bar.git');
    });

    it('끝 슬래시와 쿼리스트링은 제거된다', () => {
        // Given: 잡음 붙은 URL
        const out = validateGitRemoteUrl('https://github.com/foo/bar/?utm=x');
        // Then: 정리됨
        expect(out).toBe('https://github.com/foo/bar');
    });

    it('수상한 프로토콜은 null', () => {
        expect(validateGitRemoteUrl('javascript:alert(1)')).toBeNull();
        expect(validateGitRemoteUrl('file:///etc/passwd')).toBeNull();
    });

    it('500자 초과는 null', () => {
        const huge = 'https://github.com/' + 'a'.repeat(600);
        expect(validateGitRemoteUrl(huge)).toBeNull();
    });

    it('빈 문자열은 null', () => {
        expect(validateGitRemoteUrl('')).toBeNull();
        expect(validateGitRemoteUrl('   ')).toBeNull();
    });
});
