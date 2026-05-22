/**
 * Google OAuth2 access_token 발급.
 *
 * extension.ts 의 _getCalendarAccessToken 에서 분리. refresh_token 으로
 * 매번 새 access_token 을 받음 — 원본은 캐시를 안 했으므로 우리도 안 함
 * (lifetime ~1h 짜리라 어차피 곧 만료; 비용보다 단순함을 택함).
 *
 * 반환값:
 *  - 자격 부족 (CLIENT_ID / CLIENT_SECRET / REFRESH_TOKEN 중 하나라도 없음) → null
 *  - HTTP non-2xx 또는 access_token 누락 → null
 *  - HTTP 예외 → null (throw 안 함, 원본 try/catch 보존)
 *  - 성공 → access_token (string)
 */
import { readConfig } from './config';
import { defaultHttpClient, type HttpClient } from './http';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export async function getAccessToken(
    companyDir: string,
    http: HttpClient = defaultHttpClient
): Promise<string | null> {
    const c = readConfig(companyDir);
    if (!c.CLIENT_ID || !c.CLIENT_SECRET || !c.REFRESH_TOKEN) return null;
    try {
        const body = new URLSearchParams({
            client_id: c.CLIENT_ID,
            client_secret: c.CLIENT_SECRET,
            refresh_token: c.REFRESH_TOKEN,
            grant_type: 'refresh_token',
        }).toString();
        const res = await http.post(TOKEN_ENDPOINT, body, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 12_000,
            validateStatus: () => true,
        });
        if (res.status >= 200 && res.status < 300 && res.data?.access_token) {
            return String(res.data.access_token);
        }
        return null;
    } catch {
        return null;
    }
}
