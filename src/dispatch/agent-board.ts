/**
 * Agent board aggregator — feeds the "📋 업무 보드" tab in the dashboard.
 *
 * Pulls two data sources into one unified BoardEntry shape:
 *  - tracker.json (long-lived TODO list, owner/agent/user/mixed)
 *  - sessions/*\/state.json (per-dispatch checkpoint with per-agent outputs)
 *
 * Status maps to 3 kanban columns:
 *  - 예정 (pending)      → tracker pending / session task not started or blocked
 *  - 진행 (in_progress)  → tracker in_progress / session output streaming
 *  - 완료 (done)         → tracker done / session output done|failed|aborted
 *
 * Period filter is computed against the entry's most-recent timestamp (updatedAt).
 * Agent filter narrows to a single agent id or 'all'.
 *
 * Used by company-dashboard's 업무 탭. Pure logic; no vscode imports so
 * the aggregator is unit-testable without the extension host.
 */
import * as fs from 'fs';
import * as path from 'path';
import { readTracker } from '../tracker/io';
import type { TrackerTask } from '../tracker/types';
import { readSessionState, type SessionState } from './session-state';

export type BoardStatus = 'pending' | 'in_progress' | 'done';
export type BoardPeriod = 'today' | 'week' | 'month' | 'all';
export type BoardSource = 'tracker' | 'session';

export interface BoardEntry {
    /** Stable id — `tracker:{taskId}` or `session:{sessionId}:{agentId}`. */
    id: string;
    agentId: string;
    title: string;
    status: BoardStatus;
    source: BoardSource;
    /** Original status string from source — preserves nuance like 'failed'/'blocked'/
     *  'cancelled' that gets collapsed into the 3-column board status. */
    sourceStatus: string;
    createdAt: number;
    updatedAt: number;
    completedAt?: number;
    /** Absolute path to session folder (for session entries) so UI can open. */
    sessionDir?: string;
    /** Short blurb shown on the kanban card. */
    summary?: string;
    /** Untruncated title for the detail modal. Kanban cards still use `title`
     *  (clipped). Falls back to `title` if absent. */
    titleFull?: string;
    /** Untruncated body for the detail modal — full agent output / task
     *  description, line breaks preserved. Capped to keep payloads sane. */
    summaryFull?: string;
    description?: string;
    priority?: string;
    /** Failed/blocked badge for session entries even when sorted under 완료. */
    badge?: 'failed' | 'blocked' | 'aborted';
}

export interface BoardFilters {
    period?: BoardPeriod;
    /** Specific agent id, or 'all' / undefined for everyone. */
    agentId?: string;
}

export interface BoardSnapshot {
    entries: BoardEntry[];
    /** Counts per column — UI uses these to render the column header pills. */
    counts: Record<BoardStatus, number>;
    /** Distinct agent ids that appear in the filtered set (for the agent filter
     *  dropdown to know which options to show). */
    agentsInScope: string[];
    /** Total before period/agent filter — UI shows "보이는 N / 전체 M". */
    totalBeforeFilter: number;
    /** Snapshot time so UI can display "방금 갱신됨". */
    builtAt: number;
}

interface BoardHiddenState {
    ids: string[];
    sessionDirs: string[];
}

function boardHiddenPath(companyDir: string): string {
    return path.join(companyDir, 'board_hidden.json');
}

function readBoardHidden(companyDir: string): BoardHiddenState {
    try {
        const raw = fs.readFileSync(boardHiddenPath(companyDir), 'utf-8');
        const parsed = JSON.parse(raw);
        return {
            ids: Array.isArray(parsed?.ids) ? parsed.ids.filter((x: any) => typeof x === 'string') : [],
            sessionDirs: Array.isArray(parsed?.sessionDirs) ? parsed.sessionDirs.filter((x: any) => typeof x === 'string') : [],
        };
    } catch {
        return { ids: [], sessionDirs: [] };
    }
}

export function hideBoardEntry(companyDir: string, entry: { id?: string; sessionDir?: string }): void {
    const cur = readBoardHidden(companyDir);
    const ids = new Set(cur.ids);
    const sessionDirs = new Set(cur.sessionDirs);
    if (entry.id) ids.add(entry.id);
    if (entry.sessionDir) sessionDirs.add(path.resolve(entry.sessionDir));
    const next: BoardHiddenState = {
        ids: Array.from(ids).sort(),
        sessionDirs: Array.from(sessionDirs).sort(),
    };
    fs.writeFileSync(boardHiddenPath(companyDir), JSON.stringify(next, null, 2));
}

function isHiddenEntry(e: BoardEntry, hidden: BoardHiddenState): boolean {
    if (hidden.ids.includes(e.id)) return true;
    if (!e.sessionDir) return false;
    const resolved = path.resolve(e.sessionDir);
    return hidden.sessionDirs.includes(resolved);
}

/** Convert a tracker task into a board entry. Generic cancelled tasks are
 *  hidden, but dashboard board-aborts stay visible as done+aborted so the
 *  Kanban card does not look like it was deleted. */
function trackerToEntry(task: TrackerTask): BoardEntry | null {
    if (task.status === 'cancelled') {
        if (!String(task.evidence || '').includes('대시보드 보드에서 중단')) return null;
        const created = parseIsoOr(task.createdAt, 0);
        const completed = task.completedAt ? parseIsoOr(task.completedAt, 0) : Date.now();
        return {
            id: `tracker:${task.id}`,
            agentId: (task.agentIds && task.agentIds[0]) || (task.owner === 'user' ? 'user' : 'ceo'),
            title: task.title,
            titleFull: task.title,
            status: 'done',
            source: 'tracker',
            sourceStatus: task.status,
            createdAt: created,
            updatedAt: completed || created,
            completedAt: completed,
            description: task.description,
            summaryFull: task.description,
            priority: task.priority,
            badge: 'aborted',
        };
    }
    const status: BoardStatus = task.status === 'done' ? 'done'
        : task.status === 'in_progress' ? 'in_progress'
        : 'pending';
    const created = parseIsoOr(task.createdAt, 0);
    const completed = task.completedAt ? parseIsoOr(task.completedAt, 0) : undefined;
    return {
        id: `tracker:${task.id}`,
        agentId: (task.agentIds && task.agentIds[0]) || (task.owner === 'user' ? 'user' : 'ceo'),
        title: task.title,
        titleFull: task.title,
        status,
        source: 'tracker',
        sourceStatus: task.status,
        createdAt: created,
        updatedAt: completed || created,
        completedAt: completed,
        description: task.description,
        summaryFull: task.description,
        priority: task.priority,
    };
}

/** Convert a session state into one BoardEntry per planned agent task. Sessions
 *  without a plan (e.g. crashed before planner finished) contribute one entry
 *  under the session's prompt with agentId='ceo' so the user still sees it.
 *  Aborted/failed sessions surface with a badge so they don't silently rot. */
function sessionToEntries(state: SessionState): BoardEntry[] {
    const out: BoardEntry[] = [];
    const sessionEndedAt = state.status === 'completed' || state.status === 'failed' || state.status === 'aborted'
        ? state.lastUpdatedAt : undefined;
    if (!state.plan || !Array.isArray(state.plan.tasks) || state.plan.tasks.length === 0) {
        /* No plan → represent the whole session as one CEO-owned entry. */
        const status: BoardStatus = state.status === 'running' ? 'in_progress'
            : 'done';
        const badge = state.status === 'failed' ? 'failed'
            : state.status === 'aborted' ? 'aborted' : undefined;
        out.push({
            id: `session:${state.id}:ceo`,
            agentId: 'ceo',
            title: shortTitle(state.prompt),
            titleFull: state.prompt,
            status,
            source: 'session',
            sourceStatus: state.status,
            createdAt: state.startedAt,
            updatedAt: state.lastUpdatedAt,
            completedAt: sessionEndedAt,
            sessionDir: state.sessionDir,
            summary: state.currentStep,
            summaryFull: state.currentStep,
            badge,
        });
        return out;
    }
    for (const t of state.plan.tasks) {
        const agentOut = state.outputs[t.agent];
        let status: BoardStatus;
        let badge: BoardEntry['badge'] | undefined;
        const sourceStatus = agentOut?.status || 'queued';
        if (state.status === 'aborted') {
            status = 'done';
            badge = 'aborted';
        } else if (!agentOut) {
            /* Plan listed this agent but they never started — session crashed
               before their turn. Show in pending so user can resume mentally. */
            status = state.status === 'running' ? 'pending' : 'pending';
            if (state.status === 'failed') badge = 'failed';
        } else if (agentOut.status === 'streaming') {
            status = 'in_progress';
        } else if (agentOut.status === 'done') {
            status = 'done';
        } else if (agentOut.status === 'failed') {
            status = 'done';
            badge = 'failed';
        } else if (agentOut.status === 'blocked') {
            status = 'pending';
            badge = 'blocked';
        } else {
            status = 'pending';
        }
        const summary = agentOut?.text ? firstNonHeaderLine(agentOut.text, 100) : t.task;
        const summaryFull = agentOut?.text ? capLength(agentOut.text, 8000) : t.task;
        out.push({
            id: `session:${state.id}:${t.agent}`,
            agentId: t.agent,
            title: shortTitle(t.task),
            titleFull: t.task,
            status,
            source: 'session',
            sourceStatus,
            createdAt: state.startedAt,
            updatedAt: state.lastUpdatedAt,
            completedAt: status === 'done' ? sessionEndedAt : undefined,
            sessionDir: state.sessionDir,
            summary,
            summaryFull,
            badge,
        });
    }
    return out;
}

/** Walk sessions/*\/state.json and return parsed states (skips missing/corrupt). */
function readAllSessionStates(companyDir: string): SessionState[] {
    const root = path.join(companyDir, 'sessions');
    if (!fs.existsSync(root)) return [];
    const out: SessionState[] = [];
    let entries: string[] = [];
    try { entries = fs.readdirSync(root); } catch { return []; }
    for (const name of entries) {
        const stateFile = path.join(root, name, 'state.json');
        const state = readSessionState(stateFile);
        if (state) out.push(state);
    }
    return out;
}

/** Build a board snapshot from disk. Pure aggregator — no UI. */
export function buildBoard(companyDir: string, filters: BoardFilters = {}): BoardSnapshot {
    const period = filters.period || 'all';
    const agentFilter = filters.agentId && filters.agentId !== 'all' ? filters.agentId : undefined;
    const periodStart = periodStartMs(period);

    /* Collect tracker entries. */
    const tracker = readTracker(companyDir);
    const trackerEntries: BoardEntry[] = [];
    for (const t of tracker.tasks || []) {
        const e = trackerToEntry(t);
        if (e) trackerEntries.push(e);
    }

    /* Collect session entries. */
    const sessions = readAllSessionStates(companyDir);
    const sessionEntries: BoardEntry[] = [];
    for (const s of sessions) sessionEntries.push(...sessionToEntries(s));

    const hidden = readBoardHidden(companyDir);
    const all = [...trackerEntries, ...sessionEntries].filter(e => !isHiddenEntry(e, hidden));
    const totalBeforeFilter = all.length;

    /* Apply filters. */
    const filtered = all.filter(e => {
        if (agentFilter && e.agentId !== agentFilter) return false;
        if (periodStart > 0 && e.updatedAt < periodStart) return false;
        return true;
    });

    /* Sort: in_progress first (active work front), then pending (next up),
       then done (most recent first). Within each, newest updatedAt first. */
    const statusOrder: Record<BoardStatus, number> = { in_progress: 0, pending: 1, done: 2 };
    filtered.sort((a, b) => {
        const so = statusOrder[a.status] - statusOrder[b.status];
        if (so !== 0) return so;
        return b.updatedAt - a.updatedAt;
    });

    const counts: Record<BoardStatus, number> = { pending: 0, in_progress: 0, done: 0 };
    const agentsSet = new Set<string>();
    for (const e of filtered) {
        counts[e.status]++;
        agentsSet.add(e.agentId);
    }

    return {
        entries: filtered,
        counts,
        agentsInScope: Array.from(agentsSet).sort(),
        totalBeforeFilter,
        builtAt: Date.now(),
    };
}

/* === Helpers === */

function parseIsoOr(iso: string | undefined, fallback: number): number {
    if (!iso) return fallback;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : fallback;
}

function periodStartMs(period: BoardPeriod): number {
    const now = new Date();
    if (period === 'today') {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        return d.getTime();
    }
    if (period === 'week') return now.getTime() - 7 * 24 * 60 * 60 * 1000;
    if (period === 'month') return now.getTime() - 30 * 24 * 60 * 60 * 1000;
    return 0;
}

function shortTitle(s: string): string {
    const cleaned = String(s || '').trim().replace(/\s+/g, ' ');
    return cleaned.length > 140 ? cleaned.slice(0, 137) + '…' : cleaned;
}

function capLength(s: string, max: number): string {
    const str = String(s || '');
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

function firstNonHeaderLine(text: string, max: number): string {
    const lines = String(text || '').split(/\r?\n/);
    for (const l of lines) {
        const t = l.trim();
        if (!t) continue;
        if (t.startsWith('#') || t.startsWith('---') || t.startsWith('━')) continue;
        return t.length > max ? t.slice(0, max - 1) + '…' : t;
    }
    return '';
}
