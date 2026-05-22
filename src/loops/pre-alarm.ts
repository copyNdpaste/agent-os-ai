/**
 * Pre-alarm loop — hourly tick that fires Telegram nudges 1 day and 1 hour
 * before each tracker task's dueAt. Tracks fired windows in preAlarmsSent[]
 * so each window only fires once per task.
 *
 * extension.ts 에서 byte-for-byte 추출. wrapper 측에서 startPreAlarmLoop()
 * 호출.
 *
 * Deps imported from `../extension`:
 *   - readTelegramConfig
 *   - sendTelegramReport
 *   - readTracker
 *
 * Deps from sibling modules:
 *   - AGENTS                 ← '../agents'
 *   - trk.writeTracker       ← '../tracker' (used directly — extension.ts
 *     wrapper not exported)
 *   - getCompanyDir          ← '../paths'
 */
import {
    readTelegramConfig,
    sendTelegramReport,
    readTracker,
} from '../extension';
import { AGENTS } from '../agents';
import * as trk from '../tracker';
import { getCompanyDir } from '../paths';

/** Bridge to the un-exported `writeTracker` wrapper in extension.ts.
 *  preAlarm mutations are stored in `preAlarmsSent[]` — TreeView doesn't
 *  display this so the lost `_trackerChangeEmitter.fire()` is harmless. */
function writeTracker(t: { tasks: trk.TrackerTask[] }) {
    trk.writeTracker(getCompanyDir(), t);
}


/* P1-7: Pre-alarms — sends a Telegram nudge 1 day before and 1 hour before
   each task's dueAt. Tracked via preAlarmsSent[] so each window only fires
   once per task. Independent from stale-task nudges (which fire AFTER due).
   Tick is hourly — finer granularity wastes battery, the 1d-before window
   has 24h of slack so the user gets the reminder on a sensible cadence. */
let _preAlarmTimer: NodeJS.Timeout | null = null;
const _PRE_ALARM_WINDOWS: Array<{ key: string; ms: number; label: string }> = [
    { key: 't1d', ms: 24 * 60 * 60_000, label: '내일' },
    { key: 't1h', ms:  1 * 60 * 60_000, label: '1시간 후' },
];

async function _runPreAlarmTickOnce(): Promise<void> {
    try {
        const { token, chatId } = readTelegramConfig();
        if (!token || !chatId) return;
        const tracker = readTracker();
        const now = Date.now();
        let changed = false;
        const lines: string[] = [];
        for (const t of tracker.tasks) {
            if (t.status === 'done' || t.status === 'cancelled') continue;
            if (!t.dueAt) continue;
            const due = new Date(t.dueAt).getTime();
            if (isNaN(due) || due < now) continue;
            const remaining = due - now;
            const sent = t.preAlarmsSent || [];
            for (const w of _PRE_ALARM_WINDOWS) {
                if (sent.includes(w.key)) continue;
                /* Fire when the remaining time has dropped below the window
                   threshold but the task is still in the future. So a 1d
                   alarm fires when due is within 24h, 1h alarm fires within
                   60min. The "below" condition (not "equal") is what makes
                   this work even if the tick lands a few minutes late. */
                if (remaining <= w.ms) {
                    const a = (t.agentIds && t.agentIds[0]) ? AGENTS[t.agentIds[0]] : null;
                    const owner = a ? `${a.emoji} ${a.name}` : (t.owner === 'user' ? '👤 사용자' : '🤖 에이전트');
                    lines.push(`• ⏰${w.label} \`${t.id.slice(-9)}\` ${owner}: ${t.title}`);
                    sent.push(w.key);
                    t.preAlarmsSent = sent;
                    changed = true;
                }
            }
        }
        if (changed) writeTracker(tracker);
        if (lines.length > 0) {
            const body = `🔔 *사전 알림*\n\n${lines.slice(0, 8).join('\n')}\n\n_미루기: \`/reschedule <id> <시간>\` · 완료: \`/done <id>\`_`;
            await sendTelegramReport(body);
        }
    } catch { /* silent */ }
}

export function startPreAlarmLoop() {
    if (_preAlarmTimer) return;
    /* First tick after 2 min, then hourly. The 2-min initial gives the
       extension time to fully boot before we start firing user alerts. */
    setTimeout(_runPreAlarmTickOnce, 2 * 60 * 1000);
    _preAlarmTimer = setInterval(_runPreAlarmTickOnce, 60 * 60 * 1000);
}
export function stopPreAlarmLoop() {
    if (_preAlarmTimer) { clearInterval(_preAlarmTimer); _preAlarmTimer = null; }
}
