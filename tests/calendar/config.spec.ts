/**
 * Calendar config BDD — readConfig / writeConfig / isConnected.
 * tmp dir 만들어 실제 디스크 라운드트립 검증.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    configPath,
    readConfig,
    writeConfig,
    isConnected,
} from '../../src/calendar/config';
import type { CalendarWriteConfig } from '../../src/calendar/types';

function mkCompanyTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-cal-config-'));
}

describe('readConfig', () => {
    let dir: string;
    beforeEach(() => { dir = mkCompanyTmp(); });
    afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('파일이 없으면 빈 객체를 반환한다', () => {
        // Given: 아무 설정도 없음
        // When
        const cfg = readConfig(dir);
        // Then
        expect(cfg).toEqual({});
    });

    it('canonical path 가 google_calendar_write.json 이다', () => {
        // Given/When
        const p = configPath(dir);
        // Then
        expect(p.endsWith(
            path.join('_agents', 'secretary', 'tools', 'google_calendar_write.json')
        )).toBe(true);
    });

    it('write→read 라운드트립으로 동일한 값을 돌려준다', () => {
        // Given
        const want: CalendarWriteConfig = {
            CLIENT_ID: 'cid-1',
            CLIENT_SECRET: 'csec',
            REFRESH_TOKEN: 'rt-xyz',
            CALENDAR_ID: 'primary',
            DEFAULT_DURATION_MINUTES: 30,
            _CONNECTED_AS: 'me@example.com',
        };
        // When
        writeConfig(dir, want);
        const got = readConfig(dir);
        // Then
        expect(got).toEqual(want);
    });

    it('writeConfig 는 merge — 기존 필드를 보존한다', () => {
        // Given: 초기 설정
        writeConfig(dir, { CLIENT_ID: 'cid', CLIENT_SECRET: 'csec', REFRESH_TOKEN: 'rt' });
        // When: REFRESH_TOKEN 만 비우는 partial write (연결 해제 케이스)
        writeConfig(dir, { REFRESH_TOKEN: '' });
        const got = readConfig(dir);
        // Then: CLIENT_ID/SECRET 는 그대로
        expect(got.CLIENT_ID).toBe('cid');
        expect(got.CLIENT_SECRET).toBe('csec');
        expect(got.REFRESH_TOKEN).toBe('');
    });

    it('깨진 JSON 파일은 빈 객체로 fallback (throw 안 함)', () => {
        // Given
        const p = configPath(dir);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, '{ this is not json');
        // When
        const cfg = readConfig(dir);
        // Then
        expect(cfg).toEqual({});
    });
});

describe('isConnected', () => {
    let dir: string;
    beforeEach(() => { dir = mkCompanyTmp(); });
    afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('CLIENT_ID + CLIENT_SECRET + REFRESH_TOKEN 셋 다 있어야 true', () => {
        // Given
        writeConfig(dir, { CLIENT_ID: 'a', CLIENT_SECRET: 'b', REFRESH_TOKEN: 'c' });
        // When/Then
        expect(isConnected(dir)).toBe(true);
    });

    it('REFRESH_TOKEN 이 비어있으면 false (연결 해제 상태)', () => {
        // Given: REFRESH_TOKEN 만 비움
        writeConfig(dir, { CLIENT_ID: 'a', CLIENT_SECRET: 'b', REFRESH_TOKEN: '' });
        // When/Then
        expect(isConnected(dir)).toBe(false);
    });

    it('파일이 아예 없으면 false', () => {
        // Given: 빈 dir
        // When/Then
        expect(isConnected(dir)).toBe(false);
    });

    it('CLIENT_SECRET 만 빠져도 false', () => {
        // Given
        writeConfig(dir, { CLIENT_ID: 'a', REFRESH_TOKEN: 'c' });
        // When/Then
        expect(isConnected(dir)).toBe(false);
    });
});
