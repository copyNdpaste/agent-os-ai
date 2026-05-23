/**
 * API connections storage — per-companyDir 파일 IO.
 *
 * extension.ts 에서 byte-for-byte 복사 — readAllApiConnections /
 * saveApiConnection. 리팩토링 없음. 외부 통합 자격증명 폼이 호출하는 단일
 * 진실의 출처:
 *   - 캐노니컬 JSON 우선 (telegram_setup.json / youtube_account.json /
 *     paypal_revenue.json / gemini_account.json)
 *   - legacy fallback 으로 _agents/<agentId>/config.md
 *
 * Deps from '../extension':
 *   - _safeReadText            (exported)
 *   - ensureCompanyStructure   (exported)
 * Deps from extracted modules:
 *   - API_SERVICES             ← './services'
 *   - getCompanyDir            ← '../paths'
 *   - AGENTS                   ← '../agents'
 *
 * ⚠ line 6615 (원본) 는 token 정규화 regex 에 zero-width 문자 (U+00A0,
 * U+200B, U+200C, U+200D, U+FEFF) 가 포함됨 — byte-for-byte 보존.
 * Cycle 5 토큰 cleansing 버그 방지용.
 */
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { API_SERVICES } from './services';
import { getCompanyDir } from '../paths';
import { AGENTS } from '../agents';
import { _safeReadText, ensureCompanyStructure } from '../extension';
import type { ResolvedServiceValues, CredentialScope } from './types';

/* === Project override files ===
   When a user opts into a per-project credential set for a service, we write
   one JSON file per service into `<workspace>/.agent-os-ai/credentials/`.
   - Single source of truth at runtime: project override > company default.
   - The folder is auto-gitignored on first write so secrets never reach git.
   - File name = `${serviceId}.json` (matches service id from API_SERVICES). */
const PROJECT_CREDENTIALS_REL = path.join('.agent-os-ai', 'credentials');

function projectCredentialsDir(workspaceFolder: string): string {
    return path.join(workspaceFolder, PROJECT_CREDENTIALS_REL);
}

function projectCredentialsFile(workspaceFolder: string, serviceId: string): string {
    return path.join(projectCredentialsDir(workspaceFolder), `${serviceId}.json`);
}

/** Reads a project-override JSON if present. Returns empty object when the
 *  file is missing or unparseable so callers can treat "no override" uniformly. */
function readProjectOverride(workspaceFolder: string | undefined, serviceId: string): Record<string, string> {
    if (!workspaceFolder) return {};
    try {
        const f = projectCredentialsFile(workspaceFolder, serviceId);
        if (!fs.existsSync(f)) return {};
        const parsed = JSON.parse(fs.readFileSync(f, 'utf-8') || '{}');
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed || {})) {
            if (typeof v === 'string') out[k] = v;
        }
        return out;
    } catch { return {}; }
}

/** Ensures `<workspace>/.agent-os-ai/.gitignore` exists and excludes credentials.
 *  Idempotent — appends only when the rules are missing. */
function ensureProjectGitignore(workspaceFolder: string): void {
    try {
        const dir = path.join(workspaceFolder, '.agent-os-ai');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const gi = path.join(dir, '.gitignore');
        const want = `# Agent OS AI — project-scoped API credentials. NEVER commit.\ncredentials/\n`;
        if (!fs.existsSync(gi)) {
            fs.writeFileSync(gi, want);
            return;
        }
        const cur = fs.readFileSync(gi, 'utf-8');
        if (!cur.includes('credentials/')) {
            fs.writeFileSync(gi, cur.trimEnd() + '\n' + want);
        }
    } catch { /* never block save on gitignore failure */ }
}

/** Atomic write of the project override file for one service. Empty values
 *  are still written so the UI shows "set to empty (override active)" vs
 *  "no override". Use `clearProjectOverride` to remove the file entirely. */
function writeProjectOverride(workspaceFolder: string, serviceId: string, values: Record<string, string>): void {
    const dir = projectCredentialsDir(workspaceFolder);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    ensureProjectGitignore(workspaceFolder);
    const file = projectCredentialsFile(workspaceFolder, serviceId);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(values, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
}

/** Delete the project override file for a service so the company default
 *  takes over. No-op if no override exists. */
export function clearProjectOverride(workspaceFolder: string | undefined, serviceId: string): boolean {
    if (!workspaceFolder) return false;
    try {
        const f = projectCredentialsFile(workspaceFolder, serviceId);
        if (fs.existsSync(f)) {
            fs.unlinkSync(f);
            return true;
        }
    } catch { /* ignore */ }
    return false;
}

/** Cascade resolver — returns effective values per service with provenance.
 *  Reading order: project override (if workspaceFolder provided & override
 *  file exists for that service) > company default > none.
 *  Use this in UI to badge each field with its source. */
export function resolveAllApiConnections(opts: { workspaceFolder?: string } = {}): Record<string, ResolvedServiceValues> {
    const companyAll = readAllApiConnections();
    const out: Record<string, ResolvedServiceValues> = {};
    for (const svc of API_SERVICES) {
        const companyValues = companyAll[svc.id] || {};
        const projectValues = readProjectOverride(opts.workspaceFolder, svc.id);
        const hasProjectOverride = Object.keys(projectValues).length > 0;
        const effective: Record<string, { value: string; scope: CredentialScope }> = {};
        for (const f of svc.fields) {
            if (hasProjectOverride && f.key in projectValues) {
                effective[f.key] = { value: projectValues[f.key] || '', scope: 'project' };
            } else {
                const v = companyValues[f.key] || '';
                effective[f.key] = { value: v, scope: v ? 'company' : 'none' };
            }
        }
        out[svc.id] = { effective, companyValues, projectValues, hasProjectOverride };
    }
    return out;
}

/* Read all current values from each service's config.md. Empty string when
   not yet set. Returned as { [serviceId]: { key: value } }. */
export function readAllApiConnections(): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    /* v2.88.2 — 무효 값 필터: 사용자가 placeholder/라벨을 실수로 저장하거나
       이전 버그로 'TELEGRAM_BOT_TOKEN:' 같은 키 이름이 값 자리에 박혀있을 때
       빈 값으로 취급. 실제로 의미 있는 자격증명만 폼에 다시 채움. */
    const looksLikeJunk = (key: string, val: string): boolean => {
        const v = (val || '').trim();
        if (!v) return true;
        /* 본인 키 이름이 값 자리에 들어간 케이스 */
        if (v.startsWith(key + ':') || v === key || v.startsWith(key + '=')) return true;
        /* 다른 필드 키 이름이 들어간 경우 (이전 폼 오작동) */
        const allKeys = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'YOUTUBE_API_KEY', 'YOUTUBE_CHANNEL_ID'];
        if (allKeys.some(k => k !== key && (v.startsWith(k + ':') || v === k || v.startsWith(k + '=')))) return true;
        return false;
    };
    for (const svc of API_SERVICES) {
        out[svc.id] = {};
        try {
            /* 텔레그램은 캐노니컬 JSON을 우선 읽음 — 폴링이 읽는 단일 진실의 출처. */
            if (svc.id === 'telegram') {
                try {
                    const jsonPath = path.join(getCompanyDir(), '_agents', 'secretary', 'tools', 'telegram_setup.json');
                    if (fs.existsSync(jsonPath)) {
                        const cfg = JSON.parse(fs.readFileSync(jsonPath, 'utf-8') || '{}');
                        for (const f of svc.fields) {
                            const v = String(cfg[f.key] || '').trim();
                            out[svc.id][f.key] = looksLikeJunk(f.key, v) ? '' : v;
                        }
                        if (out[svc.id]['TELEGRAM_BOT_TOKEN']) continue;
                    }
                } catch { /* fall through to config.md */ }
            }
            /* v2.89.153 — Gemini 은 gemini_account.json 이 단일 진실의 출처. */
            if (svc.id === 'gemini') {
                try {
                    const jsonPath = path.join(getCompanyDir(), '_agents', 'business', 'tools', 'gemini_account.json');
                    if (fs.existsSync(jsonPath)) {
                        const cfg = JSON.parse(fs.readFileSync(jsonPath, 'utf-8') || '{}');
                        const map: Record<string, string> = {
                            GEMINI_API_KEY: 'API_KEY',
                            GEMINI_TEXT_MODEL: 'TEXT_MODEL',
                            GEMINI_IMAGE_MODEL: 'IMAGE_MODEL',
                        };
                        for (const f of svc.fields) {
                            const canonical = map[f.key] || f.key;
                            const raw = cfg[canonical];
                            const v = (raw === undefined || raw === null) ? '' : String(raw).trim();
                            out[svc.id][f.key] = looksLikeJunk(f.key, v) ? '' : v;
                        }
                        if (Object.values(out[svc.id]).some(v => !!v)) continue;
                    }
                } catch { /* fall through */ }
            }
            /* v2.89.139 — PayPal 은 paypal_revenue.json 이 단일 진실의 출처. */
            if (svc.id === 'paypal') {
                try {
                    const jsonPath = path.join(getCompanyDir(), '_agents', 'business', 'tools', 'paypal_revenue.json');
                    if (fs.existsSync(jsonPath)) {
                        const cfg = JSON.parse(fs.readFileSync(jsonPath, 'utf-8') || '{}');
                        /* 폼 키 → JSON 키 매핑 */
                        const map: Record<string, string> = {
                            PAYPAL_MODE: 'MODE',
                            PAYPAL_CLIENT_ID: 'CLIENT_ID',
                            PAYPAL_CLIENT_SECRET: 'CLIENT_SECRET',
                            PAYPAL_LOOKBACK_DAYS: 'LOOKBACK_DAYS',
                            PAYPAL_CURRENCY: 'CURRENCY',
                        };
                        for (const f of svc.fields) {
                            const canonical = map[f.key] || f.key;
                            const raw = cfg[canonical];
                            const v = (raw === undefined || raw === null) ? '' : String(raw).trim();
                            out[svc.id][f.key] = looksLikeJunk(f.key, v) ? '' : v;
                        }
                        if (Object.values(out[svc.id]).some(v => !!v)) continue;
                    }
                } catch { /* fall through */ }
            }
            /* v2.89.18 — YouTube Data API + OAuth Client 캐노니컬 youtube_account.json 우선. */
            if (svc.id === 'youtube' || svc.id === 'youtube-oauth') {
                try {
                    const jsonPath = path.join(getCompanyDir(), '_agents', 'youtube', 'tools', 'youtube_account.json');
                    if (fs.existsSync(jsonPath)) {
                        const cfg = JSON.parse(fs.readFileSync(jsonPath, 'utf-8') || '{}');
                        for (const f of svc.fields) {
                            /* API 패널 키 → 캐노니컬 JSON 키 매핑.
                               YOUTUBE_CHANNEL_ID (외부연결 폼) ↔ MY_CHANNEL_ID (캐노니컬). */
                            const canonicalKey = f.key === 'YOUTUBE_CHANNEL_ID' ? 'MY_CHANNEL_ID' : f.key;
                            const v = String(cfg[canonicalKey] || '').trim();
                            out[svc.id][f.key] = looksLikeJunk(f.key, v) ? '' : v;
                        }
                        const hasAny = Object.values(out[svc.id]).some(v => !!v);
                        if (hasAny) continue;
                    }
                } catch { /* fall through */ }
            }
            const cfgPath = path.join(getCompanyDir(), '_agents', svc.agentId, 'config.md');
            const txt = _safeReadText(cfgPath);
            for (const f of svc.fields) {
                /* v2.89.5 — line-anchored regex (`^KEY:` with `m` flag). 이전엔
                   anchor 없어서 `- YOUTUBE_API_KEY: ` 같은 preset 코멘트 라인을
                   먼저 잡고, `\s*` 가 newline 건너뛰어서 다음 줄의 키 이름을
                   value로 캡처해버림 → looksLikeJunk가 junk 판정 → "미설정".
                   line-start 강제로 실제 데이터 라인만 잡음. 또한 \s 대신
                   ' ' 으로 한정해서 newline 안 건너뜀. */
                const re = new RegExp('^' + f.key + '[ \\t]*[:：=][ \\t]*([^\\r\\n]+?)[ \\t]*$', 'm');
                const m = txt.match(re);
                const v = m ? m[1].trim() : '';
                out[svc.id][f.key] = looksLikeJunk(f.key, v) ? '' : v;
            }
        } catch { /* leave empty */ }
    }
    return out;
}

/* Save a service's values. Reads the existing config.md, replaces lines for
   each field (or appends a new section), writes back. Idempotent.
   `opts.scope`:
     - 'company' (default) — writes to company folder (shared across all projects)
     - 'project' — writes ONLY to `<workspace>/.agent-os-ai/credentials/{id}.json`
       (overrides company default for this workspace; company file untouched).
   When scope='project' you must also pass `opts.workspaceFolder`. The project
   override skips Telegram chat-id detection / OAuth handshake / canonical
   JSON sync because those side-effects already happened against the company
   default — project override is purely a credential substitution layer. */
export async function saveApiConnection(
    serviceId: string,
    values: Record<string, string>,
    opts: { scope?: 'company' | 'project'; workspaceFolder?: string } = {},
): Promise<{ ok: boolean; error?: string; note?: string; scope?: 'company' | 'project' }> {
    const svc = API_SERVICES.find(s => s.id === serviceId);
    if (!svc) return { ok: false, error: 'Unknown service' };
    const scope = opts.scope || 'company';
    /* Project override path — pure JSON write, skip all the company-side
       side-effects. The runtime resolver will pick this file first. */
    if (scope === 'project') {
        if (!opts.workspaceFolder) {
            return { ok: false, error: '프로젝트 폴더가 열려 있어야 프로젝트 전용 저장이 가능합니다.' };
        }
        if (svc.scopeHint === 'company-only') {
            return { ok: false, error: `${svc.name} 은(는) 회사 전체 단일 계정 전용이라 프로젝트 override 가 지원되지 않습니다.` };
        }
        try {
            /* Sanitize values — only known fields, trim whitespace. */
            const sanitized: Record<string, string> = {};
            for (const f of svc.fields) {
                const v = (values[f.key] || '').trim();
                sanitized[f.key] = v;
            }
            writeProjectOverride(opts.workspaceFolder, serviceId, sanitized);
            return {
                ok: true,
                scope: 'project',
                note: `🔒 이 프로젝트(workspace)에만 저장됨 — 회사 기본값은 그대로. .agent-os-ai/credentials/${serviceId}.json (git 자동 제외)`,
            };
        } catch (e: any) {
            return { ok: false, error: `프로젝트 override 저장 실패: ${e?.message || e}` };
        }
    }
    try {
        ensureCompanyStructure();
        let extraNote = '';
        /* v2.88 — 텔레그램 서비스 특별 처리:
           1) chat_id 비어있으면 봇의 getUpdates에서 자동 감지
           2) 캐노니컬 위치(_agents/secretary/tools/telegram_setup.json)에도 동시 저장
              — 사이드바·텔레그램 폴링이 읽는 단일 진실의 출처
           3) 사용자가 token 잘못 넣으면 명확한 에러 반환 */
        if (serviceId === 'telegram') {
            let token = (values['TELEGRAM_BOT_TOKEN'] || '').trim();
            let chatId = (values['TELEGRAM_CHAT_ID'] || '').trim();
            /* v2.88.3 — 이전 regex `[ -‍﻿]+` 가 U+0020~U+200D 전체 범위를
               잡아서 ASCII 글자 다 깎아냄(=토큰 통째로 빈 문자열). 명시적 escape로
               whitespace + zero-width chars + BOM만 정확히 제거. */
            token = token.replace(/[\s ​-‍﻿]+/g, '').replace(/^bot/i, '');
            /* v2.88.2 — chat_id에 라벨/키 이름 같은 garbage가 있으면 빈 값으로
               취급해서 자동 감지 트리거. 이전 버그로 placeholder가 값 자리에
               박혀있는 사용자 데이터 자동 정리. */
            if (chatId && /^(TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID|YOUTUBE_API_KEY|YOUTUBE_CHANNEL_ID)[:=]?/i.test(chatId)) {
                chatId = '';
            }
            /* chat_id는 정상이면 음수 또는 양수 정수만 가능 */
            if (chatId && !/^-?\d+$/.test(chatId)) {
                chatId = '';
            }
            if (!token) return { ok: false, error: '봇 토큰이 비어있어요' };
            if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
                return { ok: false, error: `봇 토큰 형식이 이상해요. @BotFather에서 받은 "숫자:문자열" 형태인지 확인해주세요. 받은 값: ${token.slice(0, 20)}…` };
            }
            /* 토큰 검증 */
            try {
                const meRes = await axios.get(`https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`, { timeout: 8000, validateStatus: () => true });
                if (!meRes.data?.ok) {
                    return { ok: false, error: `봇 토큰 거절됨: ${meRes.data?.description || `HTTP ${meRes.status}`}. @BotFather에서 토큰 다시 확인해주세요.` };
                }
            } catch (e: any) {
                return { ok: false, error: `텔레그램 서버 연결 실패: ${e?.message || e}. 인터넷 확인하시고 다시 시도해주세요.` };
            }
            /* chat_id 비어있으면 자동 감지 */
            if (!chatId) {
                try {
                    const upRes = await axios.get(`https://api.telegram.org/bot${encodeURIComponent(token)}/getUpdates`, { timeout: 8000, validateStatus: () => true });
                    const updates: any[] = Array.isArray(upRes.data?.result) ? upRes.data.result : [];
                    const seen = new Set<number>();
                    const chats: { id: number; name: string }[] = [];
                    for (let i = updates.length - 1; i >= 0; i--) {
                        const m = updates[i]?.message || updates[i]?.edited_message || updates[i]?.channel_post;
                        const c = m?.chat;
                        if (!c || typeof c.id !== 'number') continue;
                        if (seen.has(c.id)) continue;
                        seen.add(c.id);
                        const name = c.first_name ? `${c.first_name}${c.last_name ? ' ' + c.last_name : ''}` : (c.title || c.username || `Chat ${c.id}`);
                        chats.push({ id: c.id, name });
                    }
                    if (chats.length === 0) {
                        return { ok: false, error: '봇한테 아직 메시지를 보낸 적이 없어요. 텔레그램에서 봇 시작(/start) 눌러서 메시지 1개 보낸 후 다시 저장해주세요.' };
                    }
                    /* 첫 번째(가장 최근) chat 자동 선택 */
                    chatId = String(chats[0].id);
                    extraNote = `📲 chat_id 자동 감지됨 (${chats[0].name})`;
                } catch (e: any) {
                    return { ok: false, error: `chat_id 자동 감지 실패: ${e?.message || e}` };
                }
            }
            /* 캐노니컬 JSON 저장 — 폴링이 읽는 단일 진실의 출처 */
            const toolDir = path.join(getCompanyDir(), '_agents', 'secretary', 'tools');
            fs.mkdirSync(toolDir, { recursive: true });
            const jsonPath = path.join(toolDir, 'telegram_setup.json');
            fs.writeFileSync(jsonPath, JSON.stringify({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId }, null, 2));
            /* values도 갱신해서 아래 config.md 저장 시 정합성 유지 */
            values['TELEGRAM_BOT_TOKEN'] = token;
            values['TELEGRAM_CHAT_ID'] = chatId;
        }
        /* v2.89.18 — YouTube 자격증명 (Data API + OAuth) 캐노니컬 단일 저장.
           외부 연결 패널 = source of truth. 도구·에이전트·OAuth 흐름 모두 여기서
           읽음. config.md는 더 이상 source 아님 (legacy fallback only). */
        if (serviceId === 'youtube' || serviceId === 'youtube-oauth') {
            const ytToolDir = path.join(getCompanyDir(), '_agents', 'youtube', 'tools');
            const ytJsonPath = path.join(ytToolDir, 'youtube_account.json');
            try {
                fs.mkdirSync(ytToolDir, { recursive: true });
                let existing: Record<string, any> = {};
                if (fs.existsSync(ytJsonPath)) {
                    try { existing = JSON.parse(fs.readFileSync(ytJsonPath, 'utf-8') || '{}'); } catch { /* malformed */ }
                }
                /* Data API 필드 */
                if (serviceId === 'youtube') {
                    const apiKey = (values['YOUTUBE_API_KEY'] || '').trim();
                    const channelId = (values['YOUTUBE_CHANNEL_ID'] || '').trim();
                    existing['YOUTUBE_API_KEY'] = apiKey;
                    if (channelId) existing['MY_CHANNEL_ID'] = channelId;
                    if (channelId && !apiKey) extraNote = `⚠️ 채널 ID는 저장됨 — API 키도 입력해야 분석 가능`;
                    else if (apiKey && channelId) extraNote = `🔑 캐노니컬 youtube_account.json 동기화 완료`;
                }
                /* OAuth Client ID/Secret 필드 */
                if (serviceId === 'youtube-oauth') {
                    const clientId = (values['YOUTUBE_OAUTH_CLIENT_ID'] || '').trim();
                    const clientSecret = (values['YOUTUBE_OAUTH_CLIENT_SECRET'] || '').trim();
                    if (clientId) existing['YOUTUBE_OAUTH_CLIENT_ID'] = clientId;
                    if (clientSecret) existing['YOUTUBE_OAUTH_CLIENT_SECRET'] = clientSecret;
                    extraNote = `🔐 OAuth Client 캐노니컬 youtube_account.json 동기화 완료`;
                }
                /* 누락 필드 기본값 */
                if (typeof existing['YOUTUBE_API_KEY'] !== 'string') existing['YOUTUBE_API_KEY'] = '';
                if (!('MY_CHANNEL_HANDLE' in existing)) existing['MY_CHANNEL_HANDLE'] = '';
                if (!('MY_CHANNEL_ID' in existing)) existing['MY_CHANNEL_ID'] = '';
                if (!('WATCHED_CHANNELS' in existing)) existing['WATCHED_CHANNELS'] = [];
                if (!('COMPETITOR_CHANNELS' in existing)) existing['COMPETITOR_CHANNELS'] = [];
                fs.writeFileSync(ytJsonPath, JSON.stringify(existing, null, 2));
            } catch (e: any) {
                console.warn('[saveApiConnection] youtube_account.json sync failed:', e?.message || e);
            }
        }
        /* v2.89.139 — PayPal 캐노니컬 JSON 동기화. paypal_revenue.py / 매출 대시보드 /
           RevenueWatcher 가 모두 _agents/business/tools/paypal_revenue.json 을 읽음.
           외부 연결 패널이 그 단일 진실 출처에 직접 write → 별도 설정 단계 불필요. */
        if (serviceId === 'paypal') {
            const ppToolDir = path.join(getCompanyDir(), '_agents', 'business', 'tools');
            const ppJsonPath = path.join(ppToolDir, 'paypal_revenue.json');
            try {
                fs.mkdirSync(ppToolDir, { recursive: true });
                let existing: Record<string, any> = {};
                if (fs.existsSync(ppJsonPath)) {
                    try { existing = JSON.parse(fs.readFileSync(ppJsonPath, 'utf-8') || '{}'); } catch { /* malformed */ }
                }
                const mode = (values['PAYPAL_MODE'] || 'sandbox').trim().toLowerCase();
                const clientId = (values['PAYPAL_CLIENT_ID'] || '').trim();
                const clientSecret = (values['PAYPAL_CLIENT_SECRET'] || '').trim();
                const lookback = parseInt((values['PAYPAL_LOOKBACK_DAYS'] || '').trim(), 10);
                const currency = (values['PAYPAL_CURRENCY'] || '').trim().toUpperCase();
                existing['MODE'] = (mode === 'live' || mode === 'sandbox') ? mode : 'sandbox';
                if (clientId) existing['CLIENT_ID'] = clientId;
                if (clientSecret) existing['CLIENT_SECRET'] = clientSecret;
                existing['LOOKBACK_DAYS'] = isNaN(lookback) ? 30 : Math.max(1, Math.min(31, lookback));
                existing['CURRENCY'] = currency;
                if (!('_schema' in existing)) {
                    existing['_schema'] = {
                        MODE: { type: 'select', options: ['sandbox', 'live'] },
                        CLIENT_ID: { type: 'password' },
                        CLIENT_SECRET: { type: 'password' },
                        LOOKBACK_DAYS: { type: 'number' },
                        CURRENCY: { type: 'text' },
                    };
                }
                fs.writeFileSync(ppJsonPath, JSON.stringify(existing, null, 2));
                if (clientId && clientSecret) {
                    extraNote = `💰 paypal_revenue.json 동기화 — 매출 대시보드·watcher 즉시 사용 가능 (${existing['MODE']} 모드)`;
                } else {
                    extraNote = `⚠️ Client ID + Secret 둘 다 입력해야 매출 분석 가능 (현재 일부 빈 값)`;
                }
            } catch (e: any) {
                console.warn('[saveApiConnection] paypal_revenue.json sync failed:', e?.message || e);
            }
        }
        /* v2.89.153 — Gemini API 캐노니컬 JSON 동기화. pack_apply 가 키트 적용 시
           HTML 의 __GEMINI_API_KEY__ placeholder 를 이 키로 자동 inline.
           운영자 (1인 기업) 의 단일 자격증명을 모든 키트가 공유. */
        if (serviceId === 'gemini') {
            const gToolDir = path.join(getCompanyDir(), '_agents', 'business', 'tools');
            const gJsonPath = path.join(gToolDir, 'gemini_account.json');
            try {
                fs.mkdirSync(gToolDir, { recursive: true });
                let existing: Record<string, any> = {};
                if (fs.existsSync(gJsonPath)) {
                    try { existing = JSON.parse(fs.readFileSync(gJsonPath, 'utf-8') || '{}'); } catch { /* malformed */ }
                }
                const apiKey = (values['GEMINI_API_KEY'] || '').trim();
                const textModel = (values['GEMINI_TEXT_MODEL'] || '').trim() || 'gemini-3.1-flash-lite-preview';
                const imageModel = (values['GEMINI_IMAGE_MODEL'] || '').trim() || 'gemini-3.1-flash-image-preview';
                if (apiKey) existing['API_KEY'] = apiKey;
                existing['TEXT_MODEL'] = textModel;
                existing['IMAGE_MODEL'] = imageModel;
                fs.writeFileSync(gJsonPath, JSON.stringify(existing, null, 2));
                if (apiKey) {
                    extraNote = `✨ Gemini API 키 저장됨 — pack_apply 시 키트 HTML 에 자동 inline (텍스트: ${textModel}, 이미지: ${imageModel})`;
                } else {
                    extraNote = `⚠️ API Key 비어있음 — aistudio.google.com/apikey 에서 발급`;
                }
            } catch (e: any) {
                console.warn('[saveApiConnection] gemini_account.json sync failed:', e?.message || e);
            }
        }
        const cfgPath = path.join(getCompanyDir(), '_agents', svc.agentId, 'config.md');
        let txt = _safeReadText(cfgPath);
        if (!txt) {
            const a = AGENTS[svc.agentId];
            txt = `# ${a?.emoji || '🤖'} ${a?.name || svc.agentId} 설정 (시크릿)\n\n_이 파일은 \`.gitignore\`로 깃 동기화에서 제외됩니다._\n`;
        }
        for (const f of svc.fields) {
            const v = (values[f.key] || '').trim();
            const re = new RegExp('^' + f.key + '\\s*[:：=]\\s*.*$', 'm');
            if (re.test(txt)) {
                txt = txt.replace(re, `${f.key}: ${v}`);
            } else {
                txt = txt.trimEnd() + `\n${f.key}: ${v}\n`;
            }
        }
        fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
        fs.writeFileSync(cfgPath, txt);
        return { ok: true, note: extraNote || undefined };
    } catch (e: any) {
        return { ok: false, error: e?.message || String(e) };
    }
}
