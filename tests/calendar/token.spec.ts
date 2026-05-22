/**
 * getAccessToken BDD — fake HttpClient 주입으로 Google OAuth2 token endpoint
 * 호출을 검증. 원본 _getCalendarAccessToken 은 access_token 을 캐시하지 않고
 * refresh_token 으로 매번 새로 받는다 (lifetime ~1h, 비용보다 단순함 우선) —
 * 이 동작을 그대로 보존.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getAccessToken } from '../../src/calendar/token';
import { writeConfig } from '../../src/calendar/config';
import type { HttpClient } from '../../src/calendar/http';

function mkCompanyTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-cal-token-'));
}

function makeHttp(
    impl?: (url: string, data: any) => { status: number; data?: any }
): HttpClient {
    return {
        get: vi.fn(async () => ({ status: 200, data: {} })) as any,
        post: vi.fn(async (url: string, data: any) => {
            const r = impl ? impl(url, data) : { status: 200, data: { access_token: 'tk' } };
            return { status: r.status, data: r.data ?? {} };
        }) as any,
        patch: vi.fn(async () => ({ status: 200, data: {} })) as any,
        delete: vi.fn(async () => ({ status: 200, data: {} })) as any,
    };
}

describe('getAccessToken', () => {
    let dir: string;
    beforeEach(() => { dir = mkCompanyTmp(); });
    afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('자격(CLIENT_ID/SECRET/REFRESH_TOKEN) 다 있으면 새 access_token 발급', async () => {
        // Given
        writeConfig(dir, { CLIENT_ID: 'cid', CLIENT_SECRET: 'csec', REFRESH_TOKEN: 'rt' });
        const http = makeHttp(() => ({ status: 200, data: { access_token: 'access-XYZ' } }));
        // When
        const tok = await getAccessToken(dir, http);
        // Then
        expect(tok).toBe('access-XYZ');
        // Google OAuth2 endpoint 으로 POST 호출됐는지
        const call = (http.post as any).mock.calls[0];
        expect(call[0]).toBe('https://oauth2.googleapis.com/token');
        // body 는 x-www-form-urlencoded 문자열
        expect(typeof call[1]).toBe('string');
        expect(call[1]).toContain('grant_type=refresh_token');
        expect(call[1]).toContain('refresh_token=rt');
        expect(call[1]).toContain('client_id=cid');
        expect(call[2].headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    });

    it('refresh_token 없으면 즉시 null 반환 (네트워크 호출 0회)', async () => {
        // Given: REFRESH_TOKEN 누락
        writeConfig(dir, { CLIENT_ID: 'cid', CLIENT_SECRET: 'csec' });
        const http = makeHttp();
        // When
        const tok = await getAccessToken(dir, http);
        // Then
        expect(tok).toBeNull();
        expect((http.post as any).mock.calls.length).toBe(0);
    });

    it('CLIENT_ID/SECRET 누락도 즉시 null (자격 자체가 없음)', async () => {
        // Given: 빈 config
        const http = makeHttp();
        // When
        const tok = await getAccessToken(dir, http);
        // Then
        expect(tok).toBeNull();
        expect((http.post as any).mock.calls.length).toBe(0);
    });

    it('HTTP non-2xx 면 null 반환 (예외 안 던짐)', async () => {
        // Given: Google 이 400 응답
        writeConfig(dir, { CLIENT_ID: 'cid', CLIENT_SECRET: 'csec', REFRESH_TOKEN: 'bad-rt' });
        const http = makeHttp(() => ({ status: 400, data: { error: 'invalid_grant' } }));
        // When
        const tok = await getAccessToken(dir, http);
        // Then
        expect(tok).toBeNull();
    });

    it('HTTP 예외 발생 시 null 반환 (throw 안 됨)', async () => {
        // Given: 네트워크 down
        writeConfig(dir, { CLIENT_ID: 'cid', CLIENT_SECRET: 'csec', REFRESH_TOKEN: 'rt' });
        const http: HttpClient = {
            get: vi.fn() as any,
            post: vi.fn(async () => { throw new Error('ENETUNREACH'); }) as any,
            patch: vi.fn() as any,
            delete: vi.fn() as any,
        };
        // When
        const tok = await getAccessToken(dir, http);
        // Then
        expect(tok).toBeNull();
    });

    it('2xx 인데 access_token 필드가 없는 응답이면 null', async () => {
        // Given: 응답에 access_token 누락 (예: 권한 잘못된 scope)
        writeConfig(dir, { CLIENT_ID: 'cid', CLIENT_SECRET: 'csec', REFRESH_TOKEN: 'rt' });
        const http = makeHttp(() => ({ status: 200, data: { token_type: 'Bearer' } }));
        // When
        const tok = await getAccessToken(dir, http);
        // Then
        expect(tok).toBeNull();
    });
});
