/**
 * Google Calendar CRUD — create / find / patch / delete.
 *
 * extension.ts 의 createCalendarEventDirect / findCalendarEvents /
 * patchCalendarEvent / deleteCalendarEvent 를 추출. 모든 함수는 access_token
 * 을 token.getAccessToken 으로 받아오고, axios 대신 주입된 HttpClient 를 사용.
 *
 * 동작 보존:
 *  - access_token 못 받으면 즉시 null / false / [] 반환 (네트워크 호출 0회).
 *  - HTTP non-2xx 도 throw 안 함 (validateStatus = () => true). caller 는
 *    null/false 로 분기.
 *  - HTTP 예외도 삼킴 — try/catch 가 모든 axios 호출을 감쌈.
 *
 * 원본의 `updateCalendarEventForTask(task: TrackerTask)` 는 TrackerTask
 * 타입에 강하게 결합돼 있어 (status/title/description/dueAt/calendarEventId)
 * 여기서는 extract 하지 않는다 — wrapper 가 patchEvent 를 호출하면 됨.
 */
import { readConfig } from './config';
import { getAccessToken } from './token';
import { defaultHttpClient, type HttpClient } from './http';
import type {
    CalendarEvent,
    CalendarEventResult,
    CreateEventOpts,
    FindEventsOpts,
    PatchEventOpts,
} from './types';

const CAL_BASE = 'https://www.googleapis.com/calendar/v3/calendars';

function eventsUrl(calendarId: string): string {
    return `${CAL_BASE}/${encodeURIComponent(calendarId)}/events`;
}
function eventUrl(calendarId: string, eventId: string): string {
    return `${CAL_BASE}/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
}

function pickCalendarId(cfg: { CALENDAR_ID?: string }): string {
    return (cfg.CALENDAR_ID || 'primary').trim() || 'primary';
}
function pickDuration(cfg: { DEFAULT_DURATION_MINUTES?: number }): number {
    const n = Number(cfg.DEFAULT_DURATION_MINUTES);
    return n > 0 ? n : 60;
}

/* Create a free-form calendar event (not tied to a tracker task). Returns
   the event metadata or null on failure. Never throws — original behavior. */
export async function createEvent(
    companyDir: string,
    opts: CreateEventOpts,
    http: HttpClient = defaultHttpClient
): Promise<CalendarEventResult | null> {
    const access = await getAccessToken(companyDir, http);
    if (!access) return null;
    const cfg = readConfig(companyDir);
    const calendarId = pickCalendarId(cfg);
    const dur = pickDuration(cfg);

    let startIso = '';
    let endIso = '';
    try {
        const start = new Date(opts.startIso);
        if (isNaN(start.getTime())) return null;
        const end = opts.endIso ? new Date(opts.endIso) : new Date(start.getTime() + dur * 60_000);
        if (isNaN(end.getTime())) return null;
        startIso = start.toISOString();
        endIso = end.toISOString();
    } catch {
        return null;
    }

    const body: any = {
        summary: opts.title.slice(0, 200),
        description: (opts.description || '') + '\n\n생성: 비서(Secretary)',
        start: { dateTime: startIso },
        end: { dateTime: endIso },
        reminders: {
            useDefault: false,
            overrides: [
                { method: 'popup', minutes: 10 },
                { method: 'popup', minutes: 60 },
            ],
        },
    };
    if (opts.location) body.location = opts.location.slice(0, 200);

    try {
        const r = await http.post(eventsUrl(calendarId), body, {
            headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
            timeout: 12_000,
            validateStatus: () => true,
        });
        if (r.status >= 200 && r.status < 300 && r.data?.id) {
            return { eventId: String(r.data.id), htmlLink: r.data.htmlLink, startIso, endIso };
        }
        return null;
    } catch {
        return null;
    }
}

/* List up to 5 events matching the query, sorted by startTime, within
   [now, now + daysAhead] (default 14d). q parameter passes through to
   Google's fuzzy match. */
export async function findEvents(
    companyDir: string,
    opts: FindEventsOpts,
    http: HttpClient = defaultHttpClient
): Promise<CalendarEvent[]> {
    const access = await getAccessToken(companyDir, http);
    if (!access) return [];
    const cfg = readConfig(companyDir);
    const calendarId = pickCalendarId(cfg);
    const days = opts.daysAhead && opts.daysAhead > 0 ? opts.daysAhead : 14;
    const now = new Date();
    const future = new Date(now.getTime() + days * 86_400_000);
    const params = new URLSearchParams({
        timeMin: now.toISOString(),
        timeMax: future.toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '20',
    });
    if (opts.query) params.set('q', opts.query.slice(0, 80));
    try {
        const r = await http.get(`${eventsUrl(calendarId)}?${params}`, {
            headers: { Authorization: `Bearer ${access}` },
            timeout: 12_000,
            validateStatus: () => true,
        });
        if (r.status < 200 || r.status >= 300) return [];
        const items = Array.isArray(r.data?.items) ? r.data.items : [];
        return items.slice(0, 5).map((ev: any) => ({
            eventId: String(ev.id),
            title: String(ev.summary || '(제목 없음)'),
            startIso: String(ev.start?.dateTime || ev.start?.date || ''),
            endIso: String(ev.end?.dateTime || ev.end?.date || ''),
            htmlLink: ev.htmlLink,
        }));
    } catch {
        return [];
    }
}

/* Delete a calendar event by id. Returns false on any failure (no access,
   non-2xx, exception). */
export async function deleteEvent(
    companyDir: string,
    eventId: string,
    http: HttpClient = defaultHttpClient
): Promise<boolean> {
    if (!eventId) return false;
    const access = await getAccessToken(companyDir, http);
    if (!access) return false;
    const cfg = readConfig(companyDir);
    const calendarId = pickCalendarId(cfg);
    try {
        const r = await http.delete(eventUrl(calendarId, eventId), {
            headers: { Authorization: `Bearer ${access}` },
            timeout: 12_000,
            validateStatus: () => true,
        });
        return r.status >= 200 && r.status < 300;
    } catch {
        return false;
    }
}

/* PATCH an existing event — partial update (only the fields we send change).
   Used when Secretary handles "그 일정 4시로 바꿔줘" without losing the
   eventId (which delete+create would). */
export async function patchEvent(
    companyDir: string,
    eventId: string,
    opts: PatchEventOpts,
    http: HttpClient = defaultHttpClient
): Promise<CalendarEventResult | null> {
    if (!eventId) return null;
    const access = await getAccessToken(companyDir, http);
    if (!access) return null;
    const cfg = readConfig(companyDir);
    const calendarId = pickCalendarId(cfg);

    const body: any = {};
    if (opts.title) body.summary = opts.title.slice(0, 200);
    if (opts.location) body.location = opts.location.slice(0, 200);
    if (opts.description) body.description = `${opts.description}\n\n수정: 비서(Secretary)`;
    if (opts.startIso) {
        const s = new Date(opts.startIso);
        if (!isNaN(s.getTime())) body.start = { dateTime: s.toISOString() };
    }
    if (opts.endIso) {
        const e = new Date(opts.endIso);
        if (!isNaN(e.getTime())) body.end = { dateTime: e.toISOString() };
    }

    try {
        const r = await http.patch(eventUrl(calendarId, eventId), body, {
            headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
            timeout: 12_000,
            validateStatus: () => true,
        });
        if (r.status >= 200 && r.status < 300 && r.data?.id) {
            return {
                eventId: String(r.data.id),
                htmlLink: r.data.htmlLink,
                startIso: r.data.start?.dateTime || r.data.start?.date || '',
                endIso: r.data.end?.dateTime || r.data.end?.date || '',
            };
        }
        return null;
    } catch {
        return null;
    }
}
