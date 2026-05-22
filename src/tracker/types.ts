/**
 * Tracker domain — types and pure helpers.
 *
 * extension.ts 에서 분리됨 (god-file Tracker 도메인 모듈화). 디스크 IO·vscode
 * 의존성 없음; 순수 타입 + priority 정규화 헬퍼.
 *
 * Schema (preserved from extension.ts):
 *   {
 *     "tasks": [
 *       { id, title, description, owner, agentIds, createdAt,
 *         dueAt, status, completedAt, sessionDir, nudges, evidence,
 *         calendarEventId, priority, recurrence, nextRunAt, preAlarmsSent }
 *     ]
 *   }
 *     owner   ∈ 'agent' | 'user' | 'mixed'
 *     status  ∈ 'pending' | 'in_progress' | 'done' | 'cancelled'
 *     priority∈ 'urgent' | 'high' | 'normal' | 'low'
 */

export type TaskPriority = 'urgent' | 'high' | 'normal' | 'low';

/** Sort order for priority — lower number = higher priority (urgent first). */
export const TASK_PRIORITY_ORDER: Record<TaskPriority, number> = {
    urgent: 0,
    high: 1,
    normal: 2,
    low: 3,
};

/** UI label per priority, including the visual marker. Kept in this module
 *  so future label tweaks (i18n etc.) live next to the canonical type. */
export const TASK_PRIORITY_LABEL: Record<TaskPriority, string> = {
    urgent: '🔴 긴급',
    high: '🟠 높음',
    normal: '⚪ 보통',
    low: '🔵 낮음',
};

export interface TrackerTask {
    id: string;
    title: string;
    description?: string;
    owner: 'agent' | 'user' | 'mixed';
    agentIds?: string[];
    createdAt: string;
    dueAt?: string;
    status: 'pending' | 'in_progress' | 'done' | 'cancelled';
    completedAt?: string;
    sessionDir?: string;
    /** how many telegram nudges sent for stale user tasks */
    nudges?: number;
    evidence?: string;
    /** Google Calendar event id (when auto-created) */
    calendarEventId?: string;
    /** added v2.78 — defaults to 'normal' on read */
    priority?: TaskPriority;
    /* P1-6: recurrence — when set, the task is a template that auto-spawns
       fresh copies after each completion. cadence is a simple semantic key,
       nextRunAt is computed by the recurrence loop. */
    recurrence?: 'daily' | 'weekly' | 'monthly';
    nextRunAt?: string;
    /* P1-7: pre-alarms — track which "due-N" reminders we've already sent
       so the alarm loop doesn't re-fire every cycle. 't1d' = "1 day before",
       't1h' = "1 hour before". */
    preAlarmsSent?: string[];
}

/**
 * Normalize an unknown value to a valid TaskPriority. Anything other than
 * 'urgent' | 'high' | 'low' collapses to 'normal' — preserves extension.ts
 * `_coercePriority` behaviour exactly so existing tracker.json files don't
 * silently change priority after upgrade.
 */
export function coercePriority(v: unknown): TaskPriority {
    return v === 'urgent' || v === 'high' || v === 'low' ? v : 'normal';
}
