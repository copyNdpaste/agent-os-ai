/**
 * Calendar CRUD BDD — createEvent / findEvents / patchEvent / deleteEvent.
 * 모든 호출에 fake HttpClient 주입. config 파일은 tmp dir 에 실제 작성.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    createEvent,
    findEvents,
    deleteEvent,
    patchEvent,
} from '../../src/calendar/crud';
import { writeConfig } from '../../src/calendar/config';
import type { HttpClient } from '../../src/calendar/http';

function mkCompanyTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-cal-crud-'));
}

/** 모든 메서드에 대해 200/OK 를 반환하는 fake. impl 로 분기 가능. */
function makeHttp(
    impl?: Partial<{
        get: (url: string) => { status: number; data?: any };
        post: (url: string, data: any) => { status: number; data?: any };
        patch: (url: string, data: any) => { status: number; data?: any };
        delete: (url: string) => { status: number; data?: any };
    }>
): HttpClient {
    return {
        get: vi.fn(async (url: string) => {
            const r = impl?.get?.(url) ?? { status: 200, data: { items: [] } };
            return { status: r.status, data: r.data ?? {} };
        }) as any,
        post: vi.fn(async (url: string, data: any) => {
            // token endpoint 는 access_token 발급, 그 외 calendar endpoint 는 event id 발급
            if (url.includes('oauth2.googleapis.com/token')) {
                return { status: 200, data: { access_token: 'access-OK' } };
            }
            const r = impl?.post?.(url, data) ?? { status: 200, data: { id: 'evt-1', htmlLink: 'http://x' } };
            return { status: r.status, data: r.data ?? {} };
        }) as any,
        patch: vi.fn(async (url: string, data: any) => {
            const r = impl?.patch?.(url, data) ?? { status: 200, data: { id: 'evt-1' } };
            return { status: r.status, data: r.data ?? {} };
        }) as any,
        delete: vi.fn(async (url: string) => {
            const r = impl?.delete?.(url) ?? { status: 204, data: {} };
            return { status: r.status, data: r.data ?? {} };
        }) as any,
    };
}

function setupConnected(dir: string) {
    writeConfig(dir, { CLIENT_ID: 'cid', CLIENT_SECRET: 'csec', REFRESH_TOKEN: 'rt' });
}

describe('createEvent', () => {
    let dir: string;
    beforeEach(() => { dir = mkCompanyTmp(); });
    afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('Google Calendar v3 events URL 로 POST 한다 (chat_id 따위 없음)', async () => {
        // Given
        setupConnected(dir);
        const http = makeHttp();
        // When
        const out = await createEvent(dir, {
            title: '내일 회의',
            startIso: '2030-01-15T10:00:00Z',
            endIso: '2030-01-15T11:00:00Z',
        }, http);
        // Then
        expect(out?.eventId).toBe('evt-1');
        // post 호출 중 calendar endpoint 호출을 찾음 (첫 호출은 token endpoint)
        const calls = (http.post as any).mock.calls as any[];
        const calCall = calls.find(c => String(c[0]).includes('/calendar/v3/calendars/'));
        expect(calCall).toBeTruthy();
        expect(String(calCall[0])).toMatch(/https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/primary\/events$/);
        expect(calCall[1].summary).toBe('내일 회의');
        expect(calCall[1].start.dateTime).toBeTruthy();
        expect(calCall[1].end.dateTime).toBeTruthy();
        expect(calCall[2].headers.Authorization).toBe('Bearer access-OK');
    });

    it('access_token 발급 실패하면 즉시 null (calendar endpoint 호출 0회)', async () => {
        // Given: 자격 없음 → token endpoint 도 안 가고 null
        const http = makeHttp();
        // When
        const out = await createEvent(dir, {
            title: 't', startIso: '2030-01-15T10:00:00Z',
        }, http);
        // Then
        expect(out).toBeNull();
        const calendarCalls = (http.post as any).mock.calls.filter(
            (c: any) => String(c[0]).includes('/calendar/v3/calendars/')
        );
        expect(calendarCalls.length).toBe(0);
    });

    it('CALENDAR_ID 설정 시 URL 에 반영된다', async () => {
        // Given
        writeConfig(dir, {
            CLIENT_ID: 'cid', CLIENT_SECRET: 'csec', REFRESH_TOKEN: 'rt',
            CALENDAR_ID: 'work@group.calendar.google.com',
        });
        const http = makeHttp();
        // When
        await createEvent(dir, { title: 't', startIso: '2030-01-15T10:00:00Z' }, http);
        // Then
        const calls = (http.post as any).mock.calls as any[];
        const calCall = calls.find(c => String(c[0]).includes('/calendar/v3/calendars/'));
        expect(String(calCall[0])).toContain(encodeURIComponent('work@group.calendar.google.com'));
    });

    it('startIso 가 invalid 면 null', async () => {
        // Given
        setupConnected(dir);
        const http = makeHttp();
        // When
        const out = await createEvent(dir, { title: 't', startIso: 'not-a-date' }, http);
        // Then
        expect(out).toBeNull();
    });
});

describe('deleteEvent', () => {
    let dir: string;
    beforeEach(() => { dir = mkCompanyTmp(); });
    afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('DELETE /events/{id} 로 호출 → 2xx 면 true', async () => {
        // Given
        setupConnected(dir);
        const http = makeHttp();
        // When
        const ok = await deleteEvent(dir, 'evt-abc', http);
        // Then
        expect(ok).toBe(true);
        const call = (http.delete as any).mock.calls[0];
        expect(String(call[0])).toMatch(/\/calendar\/v3\/calendars\/primary\/events\/evt-abc$/);
        expect(call[1].headers.Authorization).toBe('Bearer access-OK');
    });

    it('빈 eventId 면 즉시 false (네트워크 호출 0회)', async () => {
        // Given
        setupConnected(dir);
        const http = makeHttp();
        // When
        const ok = await deleteEvent(dir, '', http);
        // Then
        expect(ok).toBe(false);
        expect((http.delete as any).mock.calls.length).toBe(0);
    });

    it('HTTP 예외 발생해도 throw 안 함 → false', async () => {
        // Given
        setupConnected(dir);
        const http = makeHttp();
        (http.delete as any) = vi.fn(async () => { throw new Error('boom'); });
        // When
        const ok = await deleteEvent(dir, 'x', http);
        // Then
        expect(ok).toBe(false);
    });
});

describe('patchEvent', () => {
    let dir: string;
    beforeEach(() => { dir = mkCompanyTmp(); });
    afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('PATCH /events/{id} 로 부분 업데이트', async () => {
        // Given
        setupConnected(dir);
        const http = makeHttp({
            patch: () => ({
                status: 200,
                data: {
                    id: 'evt-zz',
                    htmlLink: 'http://h',
                    start: { dateTime: '2030-02-01T10:00:00Z' },
                    end: { dateTime: '2030-02-01T11:00:00Z' },
                },
            }),
        });
        // When
        const out = await patchEvent(dir, 'evt-zz', {
            title: 'updated',
            startIso: '2030-02-01T10:00:00Z',
        }, http);
        // Then
        expect(out?.eventId).toBe('evt-zz');
        const call = (http.patch as any).mock.calls[0];
        expect(String(call[0])).toMatch(/\/calendar\/v3\/calendars\/primary\/events\/evt-zz$/);
        expect(call[1].summary).toBe('updated');
        expect(call[1].start.dateTime).toBeTruthy();
    });

    it('빈 eventId 면 null (네트워크 호출 0회)', async () => {
        // Given
        setupConnected(dir);
        const http = makeHttp();
        // When
        const out = await patchEvent(dir, '', { title: 'x' }, http);
        // Then
        expect(out).toBeNull();
        expect((http.patch as any).mock.calls.length).toBe(0);
    });

    it('HTTP 예외 발생해도 throw 안 함 → null', async () => {
        // Given
        setupConnected(dir);
        const http = makeHttp();
        (http.patch as any) = vi.fn(async () => { throw new Error('net'); });
        // When
        const out = await patchEvent(dir, 'evt-1', { title: 't' }, http);
        // Then
        expect(out).toBeNull();
    });
});

describe('findEvents', () => {
    let dir: string;
    beforeEach(() => { dir = mkCompanyTmp(); });
    afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('GET /events?timeMin=&timeMax=&q= 쿼리 파라미터 포함', async () => {
        // Given
        setupConnected(dir);
        const http = makeHttp({
            get: () => ({
                status: 200,
                data: {
                    items: [
                        {
                            id: 'a',
                            summary: '회의',
                            start: { dateTime: '2030-01-01T10:00:00Z' },
                            end: { dateTime: '2030-01-01T11:00:00Z' },
                            htmlLink: 'http://x',
                        },
                    ],
                },
            }),
        });
        // When
        const out = await findEvents(dir, { query: '회의', daysAhead: 7 }, http);
        // Then
        expect(out.length).toBe(1);
        expect(out[0].eventId).toBe('a');
        expect(out[0].title).toBe('회의');
        const call = (http.get as any).mock.calls[0];
        const url = String(call[0]);
        expect(url).toContain('timeMin=');
        expect(url).toContain('timeMax=');
        expect(url).toContain('singleEvents=true');
        expect(url).toContain('orderBy=startTime');
        // q 는 encodeURIComponent 처리됨
        expect(url).toMatch(/[?&]q=/);
    });

    it('access_token 없으면 즉시 빈 배열 (네트워크 호출 0회)', async () => {
        // Given: 자격 없음
        const http = makeHttp();
        // When
        const out = await findEvents(dir, {}, http);
        // Then
        expect(out).toEqual([]);
        expect((http.get as any).mock.calls.length).toBe(0);
    });

    it('HTTP 예외 발생해도 throw 안 함 → []', async () => {
        // Given
        setupConnected(dir);
        const http = makeHttp();
        (http.get as any) = vi.fn(async () => { throw new Error('net'); });
        // When
        const out = await findEvents(dir, { query: 'x' }, http);
        // Then
        expect(out).toEqual([]);
    });

    it('non-2xx 응답이면 []', async () => {
        // Given
        setupConnected(dir);
        const http = makeHttp({ get: () => ({ status: 500, data: {} }) });
        // When
        const out = await findEvents(dir, {}, http);
        // Then
        expect(out).toEqual([]);
    });
});
