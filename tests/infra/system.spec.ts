import { describe, it, expect } from 'vitest';
import { versionLessThan } from '../../src/infra/system';

describe('versionLessThan', () => {
    it('major 가 작으면 true', () => {
        // Given: 1.0.0 < 2.0.0
        expect(versionLessThan('1.0.0', '2.0.0')).toBe(true);
    });

    it('동일 major 에서 minor 비교', () => {
        expect(versionLessThan('1.2.0', '1.3.0')).toBe(true);
        expect(versionLessThan('1.3.0', '1.2.0')).toBe(false);
    });

    it('동일 minor 에서 patch 비교', () => {
        expect(versionLessThan('1.2.3', '1.2.4')).toBe(true);
        expect(versionLessThan('1.2.4', '1.2.3')).toBe(false);
    });

    it('완전 동일 버전은 false', () => {
        expect(versionLessThan('2.89.156', '2.89.156')).toBe(false);
    });

    it('길이가 다른 버전 비교 (1.2 < 1.2.0 은 false)', () => {
        // Given: 짧은 버전과 긴 버전 — 누락된 자리는 0 으로 간주
        expect(versionLessThan('1.2', '1.2.0')).toBe(false);
        expect(versionLessThan('1.2.0', '1.2')).toBe(false);
    });

    it('비숫자 토큰은 0 으로 간주', () => {
        // Given: "1.x.0" 같은 잘못된 입력
        expect(versionLessThan('1.x.0', '2.0.0')).toBe(true);
    });
});
