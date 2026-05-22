/**
 * Telegram conversation history (short-term ring buffer + jsonl persistence).
 *
 * extension.ts 에서 분리됨 (god-file Telegram 모듈화). companyDir 는 외부에서 주입.
 *
 * Short-term Telegram conversation memory — small ring buffer that gives
 * Secretary just enough context to handle follow-ups like "그 일정 4시로",
 * "방금 그거 취소", "그래 진행해줘". Without this, every Telegram message is
 * processed in isolation and the user has to re-state what they meant.
 * Cap intentionally small (last 12 turns) so we don't bloat the prompt or
 * leak old conversations into unrelated requests.
 */
import * as fs from 'fs';
import * as path from 'path';
import { safeReadText } from './_fs';

export const HISTORY_MAX = 12;

interface HistoryEntry {
    role: 'user' | 'assistant';
    text: string;
    ts: number;
}

/* Module-private state — kept hidden so callers can't accidentally mutate
   the ring buffer directly. Tests reset by re-importing via vi.resetModules(). */
const _history: HistoryEntry[] = [];
let _hydrated = false;

/** Disk path for Telegram conversation log. Persists short-term context so
 *  the bot survives an extension restart without losing the thread. Lives
 *  alongside Secretary's other files so it git-syncs naturally. */
export function historyPath(companyDir: string): string {
    return path.join(companyDir, '_agents', 'secretary', 'telegram_history.jsonl');
}

/** Lazy-load history on first access. Called from both push and render so
 *  whichever happens first hydrates the in-memory ring buffer. Idempotent. */
export function hydrateFromDisk(companyDir: string): void {
    if (_hydrated) return;
    _hydrated = true;
    try {
        const txt = safeReadText(historyPath(companyDir));
        if (!txt.trim()) return;
        const lines = txt.split('\n').filter(l => l.trim());
        /* Only restore the tail — the file may have grown across many sessions
           but we still cap working memory at HISTORY_MAX. */
        for (const line of lines.slice(-HISTORY_MAX)) {
            try {
                const e = JSON.parse(line);
                if ((e.role === 'user' || e.role === 'assistant') && typeof e.text === 'string' && typeof e.ts === 'number') {
                    _history.push({ role: e.role, text: e.text, ts: e.ts });
                }
            } catch { /* skip malformed line */ }
        }
    } catch { /* ignore — first run, no file yet */ }
}

export function pushHistory(role: 'user' | 'assistant', text: string, companyDir: string): void {
    if (!text || !text.trim()) return;
    hydrateFromDisk(companyDir);
    const entry: HistoryEntry = { role, text: text.trim().slice(0, 500), ts: Date.now() };
    _history.push(entry);
    if (_history.length > HISTORY_MAX) {
        _history.splice(0, _history.length - HISTORY_MAX);
    }
    /* JSONL ring buffer — fast restart-recovery, structured. */
    try {
        const p = historyPath(companyDir);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.appendFileSync(p, JSON.stringify(entry) + '\n');
    } catch { /* never let disk write block the bot */ }
}

export function renderHistory(companyDir: string, maxTurns: number = 8): string {
    hydrateFromDisk(companyDir);
    if (_history.length === 0) return '';
    /* Widened from 30m → 4h so multi-hour follow-ups ("아까 그 일정 4시로")
       still resolve. After 4h the user is plausibly starting a new thread.
       Persisted history means a VS Code restart no longer empties this. */
    const cutoff = Date.now() - 4 * 60 * 60_000;
    const recent = _history.filter(e => e.ts >= cutoff).slice(-maxTurns);
    if (recent.length === 0) return '';
    return recent.map(e => `${e.role === 'user' ? '👤 사용자' : '💬 비서'}: ${e.text}`).join('\n');
}
