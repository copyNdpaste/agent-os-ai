/**
 * Tracker ↔ Google Calendar synchronization.
 *
 * extension.ts 에서 byte-for-byte 추출. addTrackerTask / updateTrackerTask
 * 의 side-effect 로 호출되어 tracker 의 dueAt / status / title / dueAt 변경을
 * Google Calendar 이벤트에 반영한다.
 *
 * 동작 보존:
 *  - dueAt 없으면 즉시 null/false 반환 (네트워크 호출 0회)
 *  - access_token 미설정 → 즉시 null/false (조용히 종료)
 *  - HTTP 예외 모두 삼킴 — 절대 throw 안 함 (caller 가 .catch 안 걸어도 안전)
 *
 * 원본은 axios 를 직접 호출했고 wrapper 에서 readCalendarWriteConfig /
 * _getCalendarAccessToken 을 닫아서 썼다. 이주 시에도 같은 의존성 (axios,
 * cal.readConfig, cal.getAccessToken) 을 명시적으로 import 한다.
 */
import axios from 'axios';
import { readConfig } from './config';
import { getAccessToken } from './token';
import type { TrackerTask } from '../tracker';

/* Create a calendar event for a tracker task. Best effort — never throws.
   Returns the eventId if successful so the caller can persist it on the
   tracker entry for future updates. */
export async function createCalendarEventForTask(
  companyDir: string,
  task: TrackerTask
): Promise<string | null> {
  if (!task.dueAt) return null;
  const access = await getAccessToken(companyDir);
  if (!access) return null;
  const cfg = readConfig(companyDir) || {};
  const calendarId = (cfg.CALENDAR_ID || 'primary').trim() || 'primary';
  const dur = Number(cfg.DEFAULT_DURATION_MINUTES) > 0 ? Number(cfg.DEFAULT_DURATION_MINUTES) : 60;
  /* dueAt is "YYYY-MM-DD" or full ISO. If date-only, default to 9am that day
     so it shows up on the user's morning. */
  let startIso: string;
  let endIso: string;
  let isAllDay = false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(task.dueAt)) {
    const start = new Date(task.dueAt + 'T09:00:00');
    const end = new Date(start.getTime() + dur * 60_000);
    startIso = start.toISOString();
    endIso = end.toISOString();
  } else {
    try {
      const start = new Date(task.dueAt);
      const end = new Date(start.getTime() + dur * 60_000);
      startIso = start.toISOString();
      endIso = end.toISOString();
    } catch {
      return null;
    }
  }
  const body: any = {
    summary: task.title.slice(0, 200),
    description: (task.description || '') + `\n\n📋 추적 ID: ${task.id}\n생성: 비서(Secretary)`,
    start: isAllDay ? { date: task.dueAt } : { dateTime: startIso },
    end: isAllDay ? { date: task.dueAt } : { dateTime: endIso },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 5 }, { method: 'popup', minutes: 60 }] },
  };
  try {
    const res = await axios.post(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      body,
      {
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        timeout: 12000,
        validateStatus: () => true,
      }
    );
    if (res.status >= 200 && res.status < 300 && res.data?.id) {
      return String(res.data.id);
    }
    console.warn('[Calendar] create event failed:', res.status, res.data);
    return null;
  } catch (e: any) {
    console.warn('[Calendar] create event error:', e?.message || e);
    return null;
  }
}

/* Update a calendar event when its tracker task changes. Best effort —
   silently no-ops if the task has no event id or Calendar isn't connected.
   Used when a task gets renamed, completed, or its due date moves. */
export async function updateCalendarEventForTask(
  companyDir: string,
  task: TrackerTask
): Promise<boolean> {
  if (!task.calendarEventId) return false;
  const access = await getAccessToken(companyDir);
  if (!access) return false;
  const cfg = readConfig(companyDir) || {};
  const calendarId = (cfg.CALENDAR_ID || 'primary').trim() || 'primary';
  const dur = Number(cfg.DEFAULT_DURATION_MINUTES) > 0 ? Number(cfg.DEFAULT_DURATION_MINUTES) : 60;
  const body: any = {
    summary: (task.status === 'done' ? '✅ ' : task.status === 'cancelled' ? '✖️ ' : '') + task.title.slice(0, 200),
    description: (task.description || '') + `\n\n📋 추적 ID: ${task.id}\n상태: ${task.status}\n수정: 비서(Secretary)`,
  };
  if (task.dueAt) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(task.dueAt)) {
      const start = new Date(task.dueAt + 'T09:00:00');
      const end = new Date(start.getTime() + dur * 60_000);
      body.start = { dateTime: start.toISOString() };
      body.end = { dateTime: end.toISOString() };
    } else {
      try {
        const start = new Date(task.dueAt);
        const end = new Date(start.getTime() + dur * 60_000);
        body.start = { dateTime: start.toISOString() };
        body.end = { dateTime: end.toISOString() };
      } catch { /* skip time update */ }
    }
  }
  try {
    const r = await axios.patch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(task.calendarEventId)}`,
      body,
      {
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        timeout: 12000, validateStatus: () => true,
      }
    );
    return r.status >= 200 && r.status < 300;
  } catch { return false; }
}
