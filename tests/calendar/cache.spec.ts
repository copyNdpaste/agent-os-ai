/**
 * refreshCache BDD — Google Calendar 에서 다가오는 일정을 받아
 * `_shared/calendar_cache.md` 에 마크다운으로 기록하는 동작 검증.
 *
 * 원본 refreshCalendarCacheViaOAuth 는 axios.get 으로 events 를 받아
 * 파일을 쓰는 inlined flow — 우리도 동일하게 http.get 호출을 그대로 검증.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { refreshCache } from '../../src/calendar/cache';
import { writeConfig } from '../../src/calendar/config';
import type { HttpClient } from '../../src/calendar/http';

function mkCompanyTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-cal-cache-'));
}

/** post: token endpoint → access_token 발급. get: getter 가 정의한 응답. */
function makeHttp(getImpl?: (url: string) => { status: number; data?: any }): HttpClient {
    return {
        get: vi.fn(async (url: string) => {
            const r = getImpl ? getImpl(url) : { status: 200, data: { items: [] } };
            return { status: r.status, data: r.data ?? {} };
        }) as any,
        post: vi.fn(async (url: string) => {
            if (url.includes('oauth2.googleapis.com/token')) {
                return { status: 200, data: { access_token: 'access-OK' } };
            }
            return { status: 200, data: {} };
        }) as any,
        patch: vi.fn(async () => ({ status: 200, data: {} })) as any,
        delete: vi.fn(async () => ({ status: 200, data: {} })) as any,
    };
}

function setupConnected(dir: string) {
    writeConfig(dir, { CLIENT_ID: 'cid', CLIENT_SECRET: 'csec', REFRESH_TOKEN: 'rt' });
}

describe('refreshCache', () => {
    let dir: string;
    beforeEach(() => { dir = mkCompanyTmp(); });
    afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('Google Calendar 호출 후 _shared/calendar_cache.md 를 작성한다', async () => {
        // Given: 자격 + 가짜 일정 2개
        setupConnected(dir);
        const http = makeHttp(() => ({
            status: 200,
            data: {
                items: [
                    {
                        id: 'e1',
                        summary: '주간 회의',
                        start: { dateTime: '2030-01-01T10:00:00Z' },
                        end: { dateTime: '2030-01-01T11:00:00Z' },
                    },
                    {
                        id: 'e2',
                        summary: '점심 약속',
                        location: '강남역',
                        start: { dateTime: '2030-01-02T12:00:00Z' },
                        end: { dateTime: '2030-01-02T13:00:00Z' },
                    },
                ],
            },
        }));
        // When
        const out = await refreshCache(dir, 7, http);
        // Then
        expect(out.ok).toBe(true);
        expect(out.count).toBe(2);
        // 파일 확인
        const md = fs.readFileSync(path.join(dir, '_shared', 'calendar_cache.md'), 'utf8');
        expect(md).toContain('# 📅 다가오는 일정 (Google Calendar)');
        expect(md).toContain('주간 회의');
        expect(md).toContain('점심 약속');
        expect(md).toContain('강남역');
        // get 이 events endpoint 로 호출됐는지
        const getCall = (http.get as any).mock.calls[0];
        expect(String(getCall[0])).toContain('/calendar/v3/calendars/primary/events?');
    });

    it('일정이 없으면 _없음_ 메시지를 적는다', async () => {
        // Given: 자격 OK, 일정 0개
        setupConnected(dir);
        const http = makeHttp(() => ({ status: 200, data: { items: [] } }));
        // When
        const out = await refreshCache(dir, 14, http);
        // Then
        expect(out.ok).toBe(true);
        expect(out.count).toBe(0);
        const md = fs.readFileSync(path.join(dir, '_shared', 'calendar_cache.md'), 'utf8');
        expect(md).toContain('_없음_');
    });

    it('access_token 없으면 { ok:false, error:"no token" } (파일 작성 안 함)', async () => {
        // Given: 자격 없음
        const http = makeHttp();
        // When
        const out = await refreshCache(dir, 14, http);
        // Then
        expect(out.ok).toBe(false);
        expect(out.count).toBe(0);
        expect(out.error).toBe('no token');
        expect(fs.existsSync(path.join(dir, '_shared', 'calendar_cache.md'))).toBe(false);
    });

    it('HTTP non-2xx 면 { ok:false, error:"HTTP <status>" }', async () => {
        // Given
        setupConnected(dir);
        const http = makeHttp(() => ({ status: 500, data: { error: 'internal' } }));
        // When
        const out = await refreshCache(dir, 14, http);
        // Then
        expect(out.ok).toBe(false);
        expect(out.count).toBe(0);
        expect(out.error).toBe('HTTP 500');
    });

    it('HTTP 예외 발생해도 throw 안 함 → { ok:false, error:<msg> }', async () => {
        // Given
        setupConnected(dir);
        const http = makeHttp();
        (http.get as any) = vi.fn(async () => { throw new Error('ENETUNREACH'); });
        // When
        const out = await refreshCache(dir, 14, http);
        // Then
        expect(out.ok).toBe(false);
        expect(out.count).toBe(0);
        expect(out.error).toBe('ENETUNREACH');
    });
});
