/**
 * refreshCache — OAuth 로 다가오는 일정 50건을 받아 `_shared/calendar_cache.md`
 * 에 마크다운으로 기록한다. iCal tool 이 쓰던 파일과 동일 포맷이라 OAuth
 * 사용자는 iCal 을 켜지 않아도 회사 전체 (다른 에이전트들) 가 일정을 본다.
 *
 * extension.ts 의 refreshCalendarCacheViaOAuth 에서 추출. 변경점:
 *  - companyDir 를 인자로 받음 (getCompanyDir 글로벌 제거).
 *  - axios → 주입된 HttpClient.
 *  - console.warn 제거 — caller 가 result.error 로 분기.
 *
 * 반환:
 *  - token 못 받음                 → { ok:false, count:0, error:'no token' }
 *  - HTTP non-2xx                  → { ok:false, count:0, error:'HTTP <status>' }
 *  - HTTP 예외                     → { ok:false, count:0, error:<message> }
 *  - 성공                          → { ok:true, count:<events.length> }
 */
import * as fs from 'fs';
import * as path from 'path';
import { readConfig } from './config';
import { getAccessToken } from './token';
import { defaultHttpClient, type HttpClient } from './http';
import type { RefreshCacheResult } from './types';

const CAL_BASE = 'https://www.googleapis.com/calendar/v3/calendars';

export async function refreshCache(
    companyDir: string,
    daysAhead: number = 14,
    http: HttpClient = defaultHttpClient
): Promise<RefreshCacheResult> {
    const access = await getAccessToken(companyDir, http);
    if (!access) return { ok: false, count: 0, error: 'no token' };

    const cfg = readConfig(companyDir);
    const calendarId = (cfg.CALENDAR_ID || 'primary').trim() || 'primary';
    const now = new Date();
    const future = new Date(now.getTime() + daysAhead * 86_400_000);
    const params = new URLSearchParams({
        timeMin: now.toISOString(),
        timeMax: future.toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '50',
    });

    let events: any[] = [];
    try {
        const r = await http.get(
            `${CAL_BASE}/${encodeURIComponent(calendarId)}/events?${params}`,
            {
                headers: { Authorization: `Bearer ${access}` },
                timeout: 12_000,
                validateStatus: () => true,
            }
        );
        if (r.status < 200 || r.status >= 300) {
            return { ok: false, count: 0, error: `HTTP ${r.status}` };
        }
        events = Array.isArray(r.data?.items) ? r.data.items : [];
    } catch (e: any) {
        return { ok: false, count: 0, error: e?.message || String(e) };
    }

    /* Write the same calendar_cache.md format the iCal tool produces. */
    fs.mkdirSync(path.join(companyDir, '_shared'), { recursive: true });
    const lines: string[] = [];
    lines.push('# 📅 다가오는 일정 (Google Calendar)');
    lines.push(`_업데이트: ${now.toLocaleString('ko-KR')} · 향후 ${daysAhead}일 · OAuth 동기화_`);
    lines.push('');
    if (events.length === 0) {
        lines.push('_없음_');
    } else {
        for (const ev of events) {
            const start = ev.start?.dateTime || ev.start?.date;
            if (!start) continue;
            const allDay = !!ev.start?.date;
            let stamp = '';
            try {
                const d = new Date(start);
                stamp = allDay
                    ? d.toISOString().slice(0, 10)
                    : d.toISOString().slice(0, 16).replace('T', ' ');
            } catch {
                stamp = String(start);
            }
            const summary = (ev.summary || '(제목 없음)').replace(/\n/g, ' ');
            const loc = ev.location
                ? ` — 📍 ${String(ev.location).replace(/\n/g, ' ').slice(0, 80)}`
                : '';
            lines.push(`- **${stamp}** · ${summary}${loc}`);
        }
    }
    fs.writeFileSync(
        path.join(companyDir, '_shared', 'calendar_cache.md'),
        lines.join('\n') + '\n'
    );
    return { ok: true, count: events.length };
}
