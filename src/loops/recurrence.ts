/**
 * Recurrence loop — every minute scans the tracker for templates whose
 * nextRunAt has passed, spawns a fresh non-recurring instance, and advances
 * the template forward (handling missed cycles when the machine was off).
 *
 * extension.ts 에서 byte-for-byte 추출. wrapper 측에서 startRecurrenceLoop()
 * 호출.
 *
 * Deps imported from `../extension`:
 *   - readTracker
 *   - addTrackerTask
 *   - _coercePriority
 *
 * Deps from sibling modules:
 *   - trk.writeTracker       ← '../tracker' (used directly — extension.ts
 *     wrapper not exported)
 *   - trk.computeNextRunAt   ← '../tracker'
 *   - getCompanyDir          ← '../paths'
 */
import {
    readTracker,
    addTrackerTask,
    _coercePriority,
} from '../extension';
import * as trk from '../tracker';
import { getCompanyDir } from '../paths';

/** Bridge to the un-exported `writeTracker` wrapper in extension.ts. The
 *  recurrence loop only mutates `nextRunAt` on templates — UI refresh via
 *  `_trackerChangeEmitter` is lost but acceptable (TreeView refresh happens
 *  on the spawned instance via addTrackerTask). */
function writeTracker(t: { tasks: trk.TrackerTask[] }) {
    trk.writeTracker(getCompanyDir(), t);
}

/** Bridge to the un-exported `_computeNextRunAt` wrapper in extension.ts. */
function _computeNextRunAt(prev: Date, cadence: 'daily' | 'weekly' | 'monthly'): Date {
    return trk.computeNextRunAt(prev, cadence);
}


/* P1-6: Recurrence loop — every minute, scans tracker for tasks whose
   nextRunAt has passed. For each, spawns a fresh "instance" copy in
   pending status and bumps the template's nextRunAt forward. The original
   task acts as the template; the spawned copies are what the user actually
   completes. Templates have status='in_progress' permanently — they're
   never marked done by the user. */
let _recurrenceTimer: NodeJS.Timeout | null = null;

function _runRecurrenceTickOnce() {
    try {
        const tracker = readTracker();
        const now = Date.now();
        let anySpawned = false;
        for (const t of tracker.tasks) {
            if (!t.recurrence) continue;
            if (t.status === 'cancelled') continue;
            if (!t.nextRunAt) {
                /* First time we've seen this template — schedule from createdAt
                   so freshly-added recurring tasks don't fire immediately. */
                const baseline = new Date(t.createdAt);
                t.nextRunAt = _computeNextRunAt(baseline, t.recurrence).toISOString();
                continue;
            }
            const due = new Date(t.nextRunAt).getTime();
            if (now < due) continue;
            /* Spawn a fresh instance (without recurrence — only the template
               is recurring). Owner inherits from template. */
            addTrackerTask({
                title: t.title,
                description: t.description,
                owner: t.owner,
                agentIds: t.agentIds,
                priority: _coercePriority(t.priority),
                dueAt: t.nextRunAt,
                status: t.owner === 'agent' ? 'in_progress' : 'pending',
            });
            /* Advance template's nextRunAt — handles the "machine was off
               overnight, multiple cycles missed" case by jumping forward
               until we're back in the future. */
            let advance = new Date(t.nextRunAt);
            while (advance.getTime() <= now) {
                advance = _computeNextRunAt(advance, t.recurrence);
            }
            t.nextRunAt = advance.toISOString();
            anySpawned = true;
        }
        if (anySpawned) writeTracker(tracker);
    } catch { /* never let recurrence break anything */ }
}

export function startRecurrenceLoop() {
    if (_recurrenceTimer) return;
    /* First check after 1 minute, then every minute. The 1-min granularity
       is the same as the daily-briefing loop, so the two cooperate cleanly
       without needing a shared scheduler. */
    setTimeout(_runRecurrenceTickOnce, 60 * 1000);
    _recurrenceTimer = setInterval(_runRecurrenceTickOnce, 60 * 1000);
}
export function stopRecurrenceLoop() {
    if (_recurrenceTimer) { clearInterval(_recurrenceTimer); _recurrenceTimer = null; }
}
