/**
 * YouTube OAuth — Google OAuth2 클라이언트 + 토큰 디스크 캐시 + loopback 콜백.
 *
 * extension.ts 에서 byte-for-byte 복사. 단 한 곳만 변경: `_ensureYtAccessToken`
 * 에 `export` 키워드 추가 — analytics.ts 가 동일 모듈 안에서 호출하려면 필요.
 * 다른 함수 본문은 모두 byte-for-byte 보존.
 *
 * Deps from '../extension':
 *   - _safeReadText                  (exported)
 * Deps from extracted modules:
 *   - getCompanyDir                  ← '../paths'
 *
 * Public (per spec):
 *   - startYouTubeOAuthFlow
 *   - _readYtOAuthClient
 *   - isYoutubeOAuthConnected
 * Internal (consumed by analytics.ts):
 *   - _ensureYtAccessToken
 */
import * as vscode from 'vscode';
import * as http from 'http';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { getCompanyDir } from '../paths';
import { _safeReadText } from '../extension';

/* ── YouTube OAuth + Analytics API ────────────────────────────────────────
   Implements the Google OAuth2 device-style flow that fits a VS Code
   extension: extension opens the consent URL in the browser, runs a
   tiny http server on localhost:5814 to receive the auth code, exchanges
   for tokens, stores them in `_agents/youtube/oauth.local.json` (gitignored).
   Refresh tokens get reused; access tokens get re-fetched when expired. */

const YT_OAUTH_CLIENT_ID_KEY = 'YOUTUBE_OAUTH_CLIENT_ID';
const YT_OAUTH_CLIENT_SECRET_KEY = 'YOUTUBE_OAUTH_CLIENT_SECRET';
const YT_OAUTH_REDIRECT = 'http://127.0.0.1:5814/yt-oauth-callback';
const YT_OAUTH_SCOPES = [
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/yt-analytics.readonly',
    'https://www.googleapis.com/auth/youtube.force-ssl', /* needed for posting comment replies */
].join(' ');

function _ytOAuthTokenPath(): string {
    return path.join(getCompanyDir(), '_agents', 'youtube', 'oauth.local.json');
}

export function _readYtOAuthClient(): { id: string; secret: string } {
    /* v2.89.18 — 캐노니컬 youtube_account.json 우선. 외부 연결 패널이 거기에
       저장하니까 source of truth 일관성 유지. config.md는 legacy fallback만. */
    const jsonPath = path.join(getCompanyDir(), '_agents', 'youtube', 'tools', 'youtube_account.json');
    try {
        if (fs.existsSync(jsonPath)) {
            const cfg = JSON.parse(fs.readFileSync(jsonPath, 'utf-8') || '{}');
            const id = String(cfg[YT_OAUTH_CLIENT_ID_KEY] || '').trim();
            const secret = String(cfg[YT_OAUTH_CLIENT_SECRET_KEY] || '').trim();
            if (id && secret) return { id, secret };
        }
    } catch { /* malformed — fall through */ }
    /* Fallback: legacy config.md */
    const txt = _safeReadText(path.join(getCompanyDir(), '_agents', 'youtube', 'config.md'));
    const idM = txt.match(new RegExp(YT_OAUTH_CLIENT_ID_KEY + '\\s*[:：=]\\s*([^\\s]+)'));
    const sM  = txt.match(new RegExp(YT_OAUTH_CLIENT_SECRET_KEY + '\\s*[:：=]\\s*([^\\s]+)'));
    return { id: idM ? idM[1] : '', secret: sM ? sM[1] : '' };
}

function _readYtOAuthTokens(): { access_token?: string; refresh_token?: string; expires_at?: number } | null {
    try {
        const txt = _safeReadText(_ytOAuthTokenPath());
        if (!txt.trim()) return null;
        return JSON.parse(txt);
    } catch { return null; }
}

function _writeYtOAuthTokens(t: { access_token?: string; refresh_token?: string; expires_at?: number }) {
    try {
        fs.mkdirSync(path.dirname(_ytOAuthTokenPath()), { recursive: true });
        fs.writeFileSync(_ytOAuthTokenPath(), JSON.stringify(t, null, 2));
    } catch { /* ignore */ }
}

export function isYoutubeOAuthConnected(): boolean {
    const t = _readYtOAuthTokens();
    return !!(t && (t.refresh_token || (t.access_token && t.expires_at && t.expires_at > Date.now())));
}

export async function _ensureYtAccessToken(): Promise<string | null> {
    const t = _readYtOAuthTokens();
    if (!t) return null;
    if (t.access_token && t.expires_at && t.expires_at > Date.now() + 30_000) return t.access_token;
    if (!t.refresh_token) return null;
    const cl = _readYtOAuthClient();
    if (!cl.id || !cl.secret) return null;
    try {
        const params = new URLSearchParams({
            client_id: cl.id,
            client_secret: cl.secret,
            refresh_token: t.refresh_token,
            grant_type: 'refresh_token',
        });
        const r = await axios.post('https://oauth2.googleapis.com/token', params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 10000,
        });
        const newAt: string = r.data?.access_token;
        const expiresIn: number = r.data?.expires_in || 3600;
        if (!newAt) return null;
        _writeYtOAuthTokens({ ...t, access_token: newAt, expires_at: Date.now() + expiresIn * 1000 });
        return newAt;
    } catch { return null; }
}

export async function startYouTubeOAuthFlow(): Promise<{ ok: boolean; message: string }> {
    const cl = _readYtOAuthClient();
    if (!cl.id || !cl.secret) {
        return { ok: false, message: `먼저 \`_agents/youtube/config.md\`에 다음 두 줄 추가하세요:\n${YT_OAUTH_CLIENT_ID_KEY}: <Google Cloud Console OAuth 2.0 Client ID>\n${YT_OAUTH_CLIENT_SECRET_KEY}: <Client Secret>\n\n생성: console.cloud.google.com → APIs & Services → Credentials → OAuth 2.0 Client ID (Web application). Authorized redirect URI에 ${YT_OAUTH_REDIRECT} 등록.` };
    }
    return new Promise((resolve) => {
        const state = Math.random().toString(36).slice(2, 12);
        const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?'
            + new URLSearchParams({
                client_id: cl.id,
                redirect_uri: YT_OAUTH_REDIRECT,
                response_type: 'code',
                scope: YT_OAUTH_SCOPES,
                access_type: 'offline',
                prompt: 'consent',
                state,
            }).toString();
        let server: http.Server | null = null;
        let resolved = false;
        const timer = setTimeout(() => {
            if (resolved) return;
            resolved = true;
            try { server?.close(); } catch { /* ignore */ }
            resolve({ ok: false, message: '⏱️ OAuth 시간 초과 (5분). 다시 시도해주세요.' });
        }, 5 * 60_000);
        server = http.createServer(async (req, res) => {
            try {
                const url = new URL(req.url || '/', `http://127.0.0.1:5814`);
                if (!url.pathname.startsWith('/yt-oauth-callback')) {
                    res.writeHead(404); res.end(); return;
                }
                const code = url.searchParams.get('code') || '';
                const stateBack = url.searchParams.get('state') || '';
                if (stateBack !== state || !code) {
                    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end('<h2>❌ OAuth 실패 — state 불일치 또는 code 없음</h2>');
                    if (!resolved) { resolved = true; clearTimeout(timer); try { server?.close(); } catch {} resolve({ ok: false, message: 'OAuth state mismatch' }); }
                    return;
                }
                /* exchange code → tokens */
                const params = new URLSearchParams({
                    client_id: cl.id,
                    client_secret: cl.secret,
                    code,
                    redirect_uri: YT_OAUTH_REDIRECT,
                    grant_type: 'authorization_code',
                });
                const tk = await axios.post('https://oauth2.googleapis.com/token', params.toString(), {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    timeout: 15000,
                });
                const at = tk.data?.access_token;
                const rt = tk.data?.refresh_token;
                const ein = tk.data?.expires_in || 3600;
                _writeYtOAuthTokens({ access_token: at, refresh_token: rt, expires_at: Date.now() + ein * 1000 });
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<!doctype html><html><body style="background:#0a0d12;color:#e6edf3;font-family:sans-serif;text-align:center;padding:60px"><h1 style="color:#00ff41">✅ Agent OS · YouTube 연결 완료</h1><p>이 창을 닫고 안티그래비티로 돌아가세요.</p></body></html>');
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timer);
                    try { server?.close(); } catch { /* ignore */ }
                    resolve({ ok: true, message: '✅ YouTube OAuth 연결 완료. Analytics 데이터 활성화.' });
                }
            } catch (e: any) {
                res.writeHead(500); res.end('OAuth error: ' + (e?.message || e));
                if (!resolved) { resolved = true; clearTimeout(timer); try { server?.close(); } catch {} resolve({ ok: false, message: `OAuth 교환 실패: ${e?.message || e}` }); }
            }
        });
        server.listen(5814, '127.0.0.1', () => {
            vscode.env.openExternal(vscode.Uri.parse(authUrl));
        });
        server.on('error', (err: any) => {
            if (!resolved) { resolved = true; clearTimeout(timer); resolve({ ok: false, message: `포트 5814 사용 중: ${err?.message || err}` }); }
        });
    });
}
