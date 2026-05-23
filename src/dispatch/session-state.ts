/**
 * Session state writer + scanner — incremental checkpoint persistence for
 * corporate dispatch.
 *
 * 모든 명령 1건마다 `sessionDir/state.json` 을 만든다. 각 phase 가 진행되는
 * 동안 throttled (1초) 로 disk 에 동기화. VS Code 가 중간에 꺼지거나 인터넷이
 * 끊기거나 LLM 호출이 실패해도 그 시점까지의 진행 상태가 보존된다.
 *
 * 시작 시 `scanIncompleteSessions` 가 status='running' 인 state.json 들을 모아
 * 사용자에게 "이전 작업 미완료" 카드를 띄울 수 있게 한다 (실제 재개 실행은
 * Phase 3 — 다음 사이클에 합의 후).
 *
 * 파일 포맷은 의도적으로 단순한 JSON 한 덩어리. atomic write (tmp + rename)
 * 으로 crash 중에도 partial 파일이 남지 않는다.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface SessionAgentOutput {
    text: string;
    status: 'streaming' | 'done' | 'failed' | 'blocked';
    task?: string;
    error?: string;
}

export interface SessionAgentMeta {
    task: string;
    toolsUsed: string[];
    prefetchSummary: string;
    outputSummary: string;
    outputLength: number;
}

export interface SessionPlan {
    brief: string;
    tasks: Array<{ agent: string; task: string }>;
}

export interface SessionState {
    /** Schema version — bump when shape changes incompatibly. */
    schema: 1;
    /** Stable id derived from session folder timestamp. */
    id: string;
    /** Absolute path to the session folder owning this state. */
    sessionDir: string;
    prompt: string;
    modelName: string;
    fromTelegram: boolean;
    startedAt: number;
    lastUpdatedAt: number;
    /** Lifecycle. `running` is the in-flight state; everything else is terminal. */
    status: 'running' | 'completed' | 'failed' | 'aborted';
    /** Human-readable label, e.g. "🎬 미스터비스트 작업 중". */
    currentStep: string;
    /** Ordered list of phases that finished. Used by future resume to skip. */
    completedPhases: string[];
    plan?: SessionPlan;
    /** Per-agent streamed output. status='streaming' means tokens still coming. */
    outputs: Record<string, SessionAgentOutput>;
    agentMeta: Record<string, SessionAgentMeta>;
    /** CEO synthesis report. */
    report?: string;
    /** Decisions distilled at end of session. */
    decisions?: string[];
    /** Set when status transitions to failed/aborted. */
    errorMessage?: string;
}

/** Writer wraps a state.json file. Mutation methods are cheap; disk writes
 *  throttle to once per second so streaming-heavy agents don't thrash. Phase
 *  boundaries (`setPlan`, `endAgent`, `setReport`, `finish`) bypass throttle
 *  and flush immediately so crash recovery never misses a completed step. */
export class SessionStateWriter {
    private state: SessionState;
    private filePath: string;
    private throttleTimer: NodeJS.Timeout | null = null;
    private throttleMs: number;

    constructor(args: {
        sessionDir: string;
        prompt: string;
        modelName: string;
        fromTelegram: boolean;
        throttleMs?: number;
    }) {
        this.filePath = path.join(args.sessionDir, 'state.json');
        this.throttleMs = args.throttleMs ?? 1000;
        const now = Date.now();
        this.state = {
            schema: 1,
            id: path.basename(args.sessionDir),
            sessionDir: args.sessionDir,
            prompt: args.prompt,
            modelName: args.modelName,
            fromTelegram: args.fromTelegram,
            startedAt: now,
            lastUpdatedAt: now,
            status: 'running',
            currentStep: '준비 중',
            completedPhases: [],
            outputs: {},
            agentMeta: {},
        };
        this.flushNow();
    }

    /** Snapshot of the current in-memory state. Useful for tests/diagnostics. */
    snapshot(): SessionState {
        return JSON.parse(JSON.stringify(this.state));
    }

    setStep(step: string): void {
        this.state.currentStep = step;
        this.markDirty();
    }

    setPlan(plan: SessionPlan): void {
        this.state.plan = plan;
        if (!this.state.completedPhases.includes('plan')) {
            this.state.completedPhases.push('plan');
        }
        this.flushNow();
    }

    startAgent(agentId: string, task: string): void {
        this.state.outputs[agentId] = { text: '', status: 'streaming', task };
        this.state.currentStep = `${agentId} 작업 중`;
        this.markDirty();
    }

    /** Called per streamed chunk during specialist LLM run. Throttled. */
    appendAgentChunk(agentId: string, chunk: string): void {
        const cur = this.state.outputs[agentId] || { text: '', status: 'streaming' as const };
        cur.text = (cur.text || '') + chunk;
        cur.status = 'streaming';
        this.state.outputs[agentId] = cur;
        this.markDirty();
    }

    /** Replace the accumulated agent text wholesale (used when specialist-loop
     *  post-processes output, e.g. adds tool execution results). */
    setAgentText(agentId: string, fullText: string): void {
        const cur = this.state.outputs[agentId] || { text: '', status: 'streaming' as const };
        cur.text = fullText;
        this.state.outputs[agentId] = cur;
        this.markDirty();
    }

    endAgent(
        agentId: string,
        status: 'done' | 'failed' | 'blocked',
        meta?: SessionAgentMeta,
        error?: string,
    ): void {
        const cur = this.state.outputs[agentId] || { text: '', status: 'done' as const };
        cur.status = status;
        if (error) cur.error = error;
        this.state.outputs[agentId] = cur;
        if (meta) this.state.agentMeta[agentId] = meta;
        const phase = `agent:${agentId}`;
        if (!this.state.completedPhases.includes(phase)) {
            this.state.completedPhases.push(phase);
        }
        this.flushNow();
    }

    setReport(report: string): void {
        this.state.report = report;
        if (!this.state.completedPhases.includes('report')) {
            this.state.completedPhases.push('report');
        }
        this.flushNow();
    }

    setDecisions(decisions: string[]): void {
        this.state.decisions = decisions;
        if (!this.state.completedPhases.includes('decisions')) {
            this.state.completedPhases.push('decisions');
        }
        this.flushNow();
    }

    finish(status: 'completed' | 'failed' | 'aborted', error?: string): void {
        this.state.status = status;
        if (error) this.state.errorMessage = error;
        this.state.currentStep = status === 'completed' ? '완료' : status === 'aborted' ? '중단됨' : '실패';
        if (this.throttleTimer) {
            clearTimeout(this.throttleTimer);
            this.throttleTimer = null;
        }
        this.flushNow();
    }

    private markDirty(): void {
        if (this.throttleTimer) return;
        this.throttleTimer = setTimeout(() => {
            this.throttleTimer = null;
            this.flushNow();
        }, this.throttleMs);
    }

    private flushNow(): void {
        this.state.lastUpdatedAt = Date.now();
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const tmp = this.filePath + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf-8');
            fs.renameSync(tmp, this.filePath);
        } catch (e) {
            /* Don't crash dispatch over a write failure — log and move on. */
            console.error('[session-state] flush failed:', e);
        }
    }
}

/** Read a state.json file, returning null if missing or unparseable. */
export function readSessionState(stateFilePath: string): SessionState | null {
    try {
        if (!fs.existsSync(stateFilePath)) return null;
        const raw = fs.readFileSync(stateFilePath, 'utf-8');
        const parsed = JSON.parse(raw) as SessionState;
        if (!parsed || typeof parsed !== 'object' || parsed.schema !== 1) return null;
        return parsed;
    } catch {
        return null;
    }
}

export interface IncompleteSession {
    state: SessionState;
    stateFilePath: string;
    /** Minutes since lastUpdatedAt. Helps UI label freshness. */
    staleMinutes: number;
}

/** Walk `${companyDir}/sessions/*\/state.json` and return ones still marked
 *  running. A `recentSkipMs` window filters out sessions touched in the very
 *  recent past — those are likely the active in-flight dispatch on this very
 *  run, not a leftover. `maxAgeMs` discards ancient stuck files entirely. */
export function scanIncompleteSessions(
    companyDir: string,
    opts: { recentSkipMs?: number; maxAgeMs?: number } = {},
): IncompleteSession[] {
    const recentSkipMs = opts.recentSkipMs ?? 30 * 1000;
    const maxAgeMs = opts.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000; /* 7 days */
    const sessionsRoot = path.join(companyDir, 'sessions');
    if (!fs.existsSync(sessionsRoot)) return [];
    const out: IncompleteSession[] = [];
    const now = Date.now();
    let entries: string[] = [];
    try { entries = fs.readdirSync(sessionsRoot); } catch { return []; }
    for (const name of entries) {
        const dir = path.join(sessionsRoot, name);
        try {
            if (!fs.statSync(dir).isDirectory()) continue;
        } catch { continue; }
        const stateFile = path.join(dir, 'state.json');
        const state = readSessionState(stateFile);
        if (!state) continue;
        if (state.status !== 'running') continue;
        const age = now - state.lastUpdatedAt;
        if (age < recentSkipMs) continue;
        if (age > maxAgeMs) continue;
        out.push({
            state,
            stateFilePath: stateFile,
            staleMinutes: Math.round(age / 60000),
        });
    }
    out.sort((a, b) => b.state.lastUpdatedAt - a.state.lastUpdatedAt);
    return out;
}

/** Mark an incomplete session as aborted on disk. Used when the user picks
 *  "폐기" on the recovery card. No-op if the file vanished in the meantime. */
export function markSessionAborted(stateFilePath: string, reason = 'user discarded'): void {
    const state = readSessionState(stateFilePath);
    if (!state) return;
    state.status = 'aborted';
    state.errorMessage = reason;
    state.lastUpdatedAt = Date.now();
    state.currentStep = '중단됨';
    try {
        const tmp = stateFilePath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
        fs.renameSync(tmp, stateFilePath);
    } catch (e) {
        console.error('[session-state] markAborted failed:', e);
    }
}
