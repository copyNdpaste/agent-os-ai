/**
 * Approvals path BDD — pendingDir / historyDir / executorsDir.
 * 경로 형식 검증 (디스크 액세스 없음).
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { pendingDir, historyDir, executorsDir } from '../../src/approvals/paths';

describe('approvals paths', () => {
    const COMPANY = '/tmp/some-company';

    it('pendingDir 는 <companyDir>/approvals/pending 이다', () => {
        // Given/When
        const p = pendingDir(COMPANY);
        // Then
        expect(p).toBe(path.join(COMPANY, 'approvals', 'pending'));
    });

    it('historyDir 는 <companyDir>/approvals/history 이다', () => {
        // Given/When
        const p = historyDir(COMPANY);
        // Then
        expect(p).toBe(path.join(COMPANY, 'approvals', 'history'));
    });

    it('executorsDir 는 <companyDir>/approvals/executors 이다', () => {
        // Given/When
        const p = executorsDir(COMPANY);
        // Then
        expect(p).toBe(path.join(COMPANY, 'approvals', 'executors'));
    });

    it('companyDir 가 바뀌면 경로도 그대로 따라간다 (글로벌 상태 없음)', () => {
        // Given
        const a = '/x/a';
        const b = '/y/b';
        // When/Then
        expect(pendingDir(a)).toBe(path.join('/x/a', 'approvals', 'pending'));
        expect(pendingDir(b)).toBe(path.join('/y/b', 'approvals', 'pending'));
    });
});
