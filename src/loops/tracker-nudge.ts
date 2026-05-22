/**
 * Tracker nudge loop — hourly scan of user-owned tracker tasks; sends a single
 * Telegram ping per stale task (pending >24h or past due). Bundled with the
 * calendar_cache.md refresh so OAuth-only users get fresh events too.
 *
 * extension.ts 에서 byte-for-byte 추출. wrapper 측에서 startTrackerNudgeLoop()
 * 를 호출한다.
 *
 * Deps imported from `../extension`:
 *   - isCalendarWriteConnected
 *   - refreshCalendarCacheViaOAuth
 *   - readTelegramConfig
 *   - sendTelegramReport
 *   - readTracker
 *
 * Deps from sibling modules:
 *   - trk.writeTracker  ← '../tracker' (used directly — extension.ts wrapper
 *     not exported)
 *   - getCompanyDir     ← '../paths'  (needed for trk.writeTracker)
 *
 * Type deps: TrackerTask (used implicitly via readTracker return).
 */
import {
    isCalendarWriteConnected,
    refreshCalendarCacheViaOAuth,
    readTelegramConfig,
    sendTelegramReport,
    readTracker,
} from '../extension';
import * as trk from '../tracker';
import { getCompanyDir } from '../paths';

/** Bridge to the extension.ts private `writeTracker` wrapper. The wrapper
 *  also fires `_trackerChangeEmitter` for UI refresh, but we lose that here —
 *  acceptable for the nudge path since the only mutation is `_lastNudgeAt`
 *  / `nudges` counters which don't drive any visible TreeView column. */
function writeTracker(t: { tasks: trk.TrackerTask[] }) {
    trk.writeTracker(getCompanyDir(), t);
}


/* Stale-task nudge — Secretary scans the tracker every hour for user-owned
   tasks that have been pending >24h or are past their due date, and sends
   a single nudge per task via Telegram. Conservative: 1 ping per task max
   per ~24h, no spam. */
let _trackerNudgeTimer: NodeJS.Timeout | null = null;
const _NUDGE_WINDOW_MS = 23 * 60 * 60 * 1000; /* re-ping no more than once per ~day */
async function _runTrackerNudgeOnce() {
    /* Piggyback: refresh calendar_cache.md via OAuth if connected. This means
       OAuth users don't have to also configure the iCal tool — every hour
       we pull fresh events. Failure is silent. */
    if (isCalendarWriteConnected()) {
        refreshCalendarCacheViaOAuth(14).catch(() => { /* never let this break nudges */ });
    }
    try {
        const { token, chatId } = readTelegramConfig();
        if (!token || !chatId) return; // can't nudge without channel
        const tracker = readTracker();
        const now = Date.now();
        let changed = false;
        const nudges: string[] = [];
        for (const t of tracker.tasks) {
            if (t.status === 'done' || t.status === 'cancelled') continue;
            if (t.owner !== 'user' && t.owner !== 'mixed') continue;
            const lastNudge = (t as any)._lastNudgeAt ? new Date((t as any)._lastNudgeAt).getTime() : 0;
            if (now - lastNudge < _NUDGE_WINDOW_MS) continue;
            const ageDays = (now - new Date(t.createdAt).getTime()) / 86_400_000;
            const overdue = t.dueAt && new Date(t.dueAt).getTime() < now;
            if (!overdue && ageDays < 1) continue; /* not stale yet */
            nudges.push(`• \`${t.id.slice(-9)}\` ${t.title}${t.dueAt ? ` ⏰${t.dueAt.slice(0, 10)}` : ''}${overdue ? ' 🔴' : ''}`);
            (t as any)._lastNudgeAt = new Date().toISOString();
            t.nudges = (t.nudges || 0) + 1;
            changed = true;
        }
        if (changed) writeTracker(tracker);
        if (nudges.length > 0) {
            const body = `👀 *비서: 확인해주세요*\n\n진행되지 않은 사용자 작업이 있어요:\n\n${nudges.slice(0, 8).join('\n')}\n\n_완료: \`/done <id>\` · 취소: \`/cancel <id>\`_`;
            await sendTelegramReport(body);
        }
    } catch { /* never let nudge errors break anything */ }
}
export function startTrackerNudgeLoop() {
    if (_trackerNudgeTimer) return;
    /* First check after 5 min, then hourly. Light interval keeps batterylcheap. */
    setTimeout(_runTrackerNudgeOnce, 5 * 60 * 1000);
    _trackerNudgeTimer = setInterval(_runTrackerNudgeOnce, 60 * 60 * 1000);
}

export function stopTrackerNudge() {
    if (_trackerNudgeTimer) {
        clearInterval(_trackerNudgeTimer);
        _trackerNudgeTimer = null;
    }
}
