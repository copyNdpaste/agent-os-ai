/**
 * Daily briefing loop — once per day at the user's configured time (default
 * 09:00 KST), Secretary builds and sends a "good morning" brief covering
 * today's calendar, top 5 open tracker tasks, yesterday's PayPal revenue
 * snapshot, and yesterday's conversation log tail.
 *
 * extension.ts 에서 byte-for-byte 추출. wrapper 측에서 startDailyBriefingLoop()
 * 호출. `_runDailyBriefingOnce` 는 export 유지 — Telegram `/today` 핸들러가
 * 강제 fire 용으로 호출함.
 *
 * Deps imported from `../extension`:
 *   - readTelegramConfig
 *   - sendTelegramReport
 *   - _safeReadText
 *   - _pythonCmd
 *   - _extCtx                (globalState — single-fire-per-day guard)
 *   - readCompanyName
 *   - trackerToMarkdown
 *   - getConversationsDir
 *   - appendConversationLog
 *
 * Deps from sibling modules:
 *   - getCompanyDir          ← '../paths'
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    readTelegramConfig,
    sendTelegramReport,
    _safeReadText,
    _pythonCmd,
    _extCtx,
    readCompanyName,
    trackerToMarkdown,
    getConversationsDir,
    appendConversationLog,
} from '../extension';
import { getCompanyDir } from '../paths';


/* ── P0-3: Daily briefing auto-fire ─────────────────────────────────────
   Once per day at the user's configured time (default 09:00), Secretary
   builds and sends a "good morning" brief to Telegram covering:
     - Today's calendar (from calendar_cache.md)
     - Open tracker tasks (priority-sorted, top 5)
     - Yesterday's company highlights (last conversation log entries)
   Single-fire: tracks last-fired date in extension globalState so a VS Code
   restart at 09:30 doesn't double-send. */
let _dailyBriefingTimer: NodeJS.Timeout | null = null;
const _DAILY_BRIEFING_KEY = 'dailyBriefingLastSentDate';

function _parseBriefingTime(raw: string): { hour: number; minute: number } | null {
    if (!raw || raw.trim() === '' || raw.trim().toLowerCase() === 'off') return null;
    const m = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const hour = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return { hour, minute };
}

export async function _runDailyBriefingOnce(force = false): Promise<void> {
    try {
        const cfg = vscode.workspace.getConfiguration('agentOs');
        const time = _parseBriefingTime(cfg.get<string>('dailyBriefingTime') || '09:00');
        if (!time && !force) return; // off
        const { token, chatId } = readTelegramConfig();
        if (!token || !chatId) return; // no channel
        const today = new Date().toISOString().slice(0, 10);
        const lastSent = _extCtx?.globalState.get<string>(_DAILY_BRIEFING_KEY, '');
        if (!force && lastSent === today) return; // already sent today

        /* Build the brief — kept text-only so the prompt stays small. */
        const dir = getCompanyDir();
        const company = readCompanyName() || '1인 기업';
        const dateStr = new Date().toLocaleDateString('ko-KR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

        /* 1. Calendar */
        let calBlock = '';
        try {
            const cal = _safeReadText(path.join(dir, '_shared', 'calendar_cache.md')).trim();
            if (cal) {
                const calLines = cal.split('\n').filter(l => l.trim().startsWith('-')).slice(0, 6);
                if (calLines.length > 0) calBlock = `\n*📅 오늘 일정*\n${calLines.join('\n')}\n`;
            }
        } catch { /* ignore */ }
        if (!calBlock) calBlock = '\n*📅 오늘 일정*\n_등록된 일정이 없어요._\n';

        /* 2. Open tasks (top 5 by priority) */
        let taskBlock = '';
        try {
            const md = trackerToMarkdown({ onlyOpen: true, max: 5 });
            taskBlock = md ? `\n*✅ 우선순위 할 일 (상위 5)*\n${md}\n` : '\n*✅ 할 일*\n_진행 중인 작업이 없어요._\n';
        } catch { /* ignore */ }

        /* 3. Yesterday highlights — last 800 chars of yesterday's log */
        let yhBlock = '';
        try {
            const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
            const ypath = path.join(getConversationsDir(), `${yest}.md`);
            const txt = _safeReadText(ypath);
            if (txt.trim()) {
                const tail = txt.slice(-700);
                yhBlock = `\n*📝 어제 회사 활동 (요약 컨텍스트)*\n${tail.slice(0, 700)}\n`;
            }
        } catch { /* ignore */ }

        /* 4. v2.89.136 — 어제 PayPal 매출 (가능하면). business/tools/paypal_revenue.py
           를 LOOKBACK_DAYS=1 으로 동기 실행 → 어제 총 매출·거래수만 한 줄 추출.
           paypal 설정 안 됐거나 실패 시 silently skip — 브리핑 자체는 항상 발송. */
        let revBlock = '';
        try {
            const ppToolDir = path.join(getCompanyDir(), '_agents', 'business', 'tools');
            const ppScript = path.join(ppToolDir, 'paypal_revenue.py');
            const ppJson = path.join(ppToolDir, 'paypal_revenue.json');
            if (fs.existsSync(ppScript) && fs.existsSync(ppJson)) {
                const env = { ...process.env, LOOKBACK_DAYS: '1' };
                const r = await new Promise<{ exitCode: number; output: string }>((resolve) => {
                    const cp = require('child_process');
                    const p = cp.spawn(_pythonCmd(), [ppScript], { cwd: ppToolDir, env });
                    let out = '';
                    p.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
                    p.on('close', (code: number) => resolve({ exitCode: code, output: out }));
                    setTimeout(() => { try { p.kill(); } catch {} resolve({ exitCode: -1, output: out }); }, 15000);
                });
                if (r.exitCode === 0 && r.output) {
                    /* 출력 마크다운에서 첫 통화 행 추출 — 예: "| **USD** | 14.95 | -0 | ..." */
                    const m = r.output.match(/\|\s*\*\*([A-Z]{3})\*\*\s*\|\s*([\d.,]+)\s*\|[^|]+\|[^|]+\|\s*\*\*([\d.,]+)\*\*\s*\|\s*(\d+)건/);
                    if (m) {
                        revBlock = `\n*💰 어제 매출*\n  ${m[1]} ${m[2]} (순매출 ${m[3]}, ${m[4]}건)\n`;
                    } else if (/거래가 없어요/.test(r.output)) {
                        revBlock = '\n*💰 어제 매출*\n  _거래 0건_\n';
                    }
                }
            }
        } catch { /* ignore — briefing 자체는 항상 진행 */ }

        const body = `🌅 *${company} — 아침 브리핑*\n_${dateStr}_\n${calBlock}${taskBlock}${revBlock}${yhBlock}\n_명령: \`/today\` 다시 보기 · \`/tools\` 도구 상태_`;
        await sendTelegramReport(body);
        if (_extCtx) {
            _extCtx.globalState.update(_DAILY_BRIEFING_KEY, today);
        }
        try { appendConversationLog({ speaker: '비서', emoji: '🌅', section: '데일리 브리핑', body: body.slice(0, 1000) }); } catch { /* ignore */ }
        /* v2.82: removed the system-note injection into chat. Daily briefing
           now lives only in: (1) telegram, (2) company dashboard "회사
           활동 로그" + KPI strip, (3) conversation log file. The chat is
           kept as a clean conversation surface — no auto-injected cards. */
    } catch { /* never let briefing errors break the extension */ }
}

export function startDailyBriefingLoop() {
    if (_dailyBriefingTimer) return;
    /* Check every minute — cheap, gives ±60s precision on the configured time.
       The single-fire guard via globalState makes this safe to over-tick. */
    _dailyBriefingTimer = setInterval(() => {
        try {
            const cfg = vscode.workspace.getConfiguration('agentOs');
            const time = _parseBriefingTime(cfg.get<string>('dailyBriefingTime') || '09:00');
            if (!time) return;
            const now = new Date();
            if (now.getHours() === time.hour && now.getMinutes() === time.minute) {
                _runDailyBriefingOnce().catch(() => { /* silent */ });
            }
        } catch { /* ignore */ }
    }, 60 * 1000);
}

export function stopDailyBriefingLoop() {
    if (_dailyBriefingTimer) {
        clearInterval(_dailyBriefingTimer);
        _dailyBriefingTimer = null;
    }
}
