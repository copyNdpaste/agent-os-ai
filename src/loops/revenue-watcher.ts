/**
 * Revenue watcher — every 5 minutes runs business/tools/paypal_revenue.py with
 * OUTPUT=json, diffs against the last seen transaction id stamped in
 * globalState, and pushes Telegram alerts for new payments / refunds plus a
 * Secretary desk pulse.
 *
 * extension.ts 에서 byte-for-byte 추출. wrapper 측에서 startRevenueWatcherLoop()
 * 호출.
 *
 * Deps imported from `../extension`:
 *   - _safeReadText
 *   - _pythonCmd
 *   - _extCtx                (globalState read/update for baseline tracking)
 *   - sendTelegramReport
 *   - appendConversationLog
 *   - _activeChatProvider    (pulseAgent for desk animation)
 *
 * Deps from sibling modules:
 *   - getCompanyDir          ← '../paths'
 */
import * as fs from 'fs';
import * as path from 'path';
import {
    _safeReadText,
    _pythonCmd,
    _extCtx,
    sendTelegramReport,
    appendConversationLog,
    _activeChatProvider,
} from '../extension';
import { getCompanyDir } from '../paths';


/* ── v2.89.137 — Revenue Watcher (PayPal polling) ──────────────────────────
   5분마다 paypal_revenue.py OUTPUT=json 호출 → 마지막 본 transaction id 와
   비교 → 새 결제 발견 시 텔레그램 푸시 + 사무실 영숙 책상 펄스. paypal 미설정
   시 silently skip. 이게 진짜 "AI 회사가 자고 있어도 결제 알아차림" 의 코어. */
let _revenueWatcherTimer: NodeJS.Timeout | null = null;
const _REVENUE_LAST_SEEN_KEY = 'revenueLastSeenTxId';
const _REVENUE_LAST_SEEN_TS_KEY = 'revenueLastSeenTxTs';
const REVENUE_POLL_INTERVAL_MS = 5 * 60 * 1000; /* 5분 */

export async function _runRevenueWatcherOnce(): Promise<void> {
    try {
        const ppToolDir = path.join(getCompanyDir(), '_agents', 'business', 'tools');
        const ppScript = path.join(ppToolDir, 'paypal_revenue.py');
        const ppJson = path.join(ppToolDir, 'paypal_revenue.json');
        if (!fs.existsSync(ppScript) || !fs.existsSync(ppJson)) return;
        const cfg = JSON.parse(_safeReadText(ppJson) || '{}');
        if (!cfg.CLIENT_ID || !cfg.CLIENT_SECRET) return; /* 미설정 — silent */

        const env = { ...process.env, OUTPUT: 'json', LOOKBACK_DAYS: '2' };
        const r = await new Promise<{ exitCode: number; output: string }>((resolve) => {
            const cp = require('child_process');
            const p = cp.spawn(_pythonCmd(), [ppScript], { cwd: ppToolDir, env });
            let out = '';
            p.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
            p.on('close', (code: number) => resolve({ exitCode: code, output: out }));
            setTimeout(() => { try { p.kill(); } catch {} resolve({ exitCode: -1, output: out }); }, 20000);
        });
        if (r.exitCode !== 0 || !r.output) return;

        let data: any;
        try { data = JSON.parse(r.output); } catch { return; }
        const txs: any[] = Array.isArray(data?.transactions) ? data.transactions : [];
        if (txs.length === 0) return;

        const lastSeenTs = Number(_extCtx?.globalState.get<number>(_REVENUE_LAST_SEEN_TS_KEY, 0) || 0);
        const lastSeenId = String(_extCtx?.globalState.get<string>(_REVENUE_LAST_SEEN_KEY, '') || '');

        /* 첫 실행 — 알림 보내지 말고 baseline 만 기록 (사용자 폭주 방지) */
        if (lastSeenTs === 0) {
            const newest = txs[0];
            _extCtx?.globalState.update(_REVENUE_LAST_SEEN_TS_KEY, newest.ts_epoch);
            _extCtx?.globalState.update(_REVENUE_LAST_SEEN_KEY, newest.id);
            return;
        }

        /* 새 거래 = lastSeenTs 보다 ts 큰 것 (refund 포함, 사용자에게 다 알림). */
        const fresh = txs.filter(t => t.ts_epoch > lastSeenTs && t.id !== lastSeenId);
        if (fresh.length === 0) return;

        /* 가장 최신부터 역순 정렬 → 알림은 옛 → 신순 */
        fresh.sort((a, b) => a.ts_epoch - b.ts_epoch);
        for (const tx of fresh) {
            const isRefund = !!tx.is_refund;
            const arrow = isRefund ? '↩️ 환불' : '💰 새 결제';
            const sign = isRefund ? '-' : '+';
            const amount = `${sign}${Math.abs(tx.value).toFixed(2)} ${tx.currency}`;
            const subj = tx.subject || '(설명 없음)';
            const monthTotal = data?.totals?.by_period?.month || 0;
            const cur = (data?.totals?.by_currency && Object.keys(data.totals.by_currency)[0]) || tx.currency;
            const body = `${arrow} 도착!\n*${subj}*\n${amount}\n_30일 누적: ${monthTotal.toFixed(2)} ${cur}_`;
            try { await sendTelegramReport(body); } catch { /* ignore */ }
            try {
                appendConversationLog({
                    speaker: '비서', emoji: isRefund ? '↩️' : '💰',
                    section: isRefund ? '환불 감지' : '새 결제',
                    body: `${arrow}: ${subj} ${amount}`
                });
            } catch { /* ignore */ }
            /* 사무실 영숙 책상 펄스 + 알림 */
            try {
                _activeChatProvider?.pulseAgent?.('secretary', isRefund ? '↩️' : '💰', 6000, `${arrow}: ${amount}`);
            } catch { /* ignore */ }
        }

        /* baseline 업데이트 — 가장 최신 거래로 */
        const newest = fresh[fresh.length - 1];
        _extCtx?.globalState.update(_REVENUE_LAST_SEEN_TS_KEY, newest.ts_epoch);
        _extCtx?.globalState.update(_REVENUE_LAST_SEEN_KEY, newest.id);
    } catch (e: any) {
        console.warn('[Agent OS] revenue watcher tick 실패:', e?.message || e);
    }
}

export function startRevenueWatcherLoop() {
    if (_revenueWatcherTimer) return;
    /* 첫 tick: activate 후 30초. 그 뒤 5분마다. */
    setTimeout(() => { _runRevenueWatcherOnce(); }, 30_000);
    _revenueWatcherTimer = setInterval(() => {
        _runRevenueWatcherOnce();
    }, REVENUE_POLL_INTERVAL_MS);
}

export function stopRevenueWatcherLoop() {
    if (_revenueWatcherTimer) {
        clearInterval(_revenueWatcherTimer);
        _revenueWatcherTimer = null;
    }
}
