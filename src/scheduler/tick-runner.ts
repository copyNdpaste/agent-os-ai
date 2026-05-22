/**
 * Report scheduler tick runner.
 *
 * extension.ts 에서 byte-for-byte 추출. 1분마다 _shared/schedule.json (sch.*
 * storage) 을 점검해 사용자 정의 스케줄 entry 를 발동한다. entry 종류:
 *   - 'briefing'  → _runDailyBriefingOnce(true)
 *   - 'tool'      → _agents/<agentId>/tools/<tool>.py 실행
 *
 * extension.ts 의 activate() 가 startReportScheduler() 를 호출한다. 추출 후에도
 * 호출 시그니처는 그대로 (vsCode/Telegram/Chat 사이드 이펙트는 extension.ts 의
 * 공개 wrapper 를 import 해서 그대로 호출).
 *
 * Deps imported from `../extension`:
 *   - readReportSchedule, writeReportSchedule
 *   - sendTelegramLong
 *   - _activeChatProvider  (낙관적 chained ?. 호출)
 *   - _runDailyBriefingOnce
 *
 * Deps from sibling modules:
 *   - getCompanyDir         ← '../paths'
 *   - runCommandCaptured    ← '../infra/process'
 *   - _pythonCmd            ← '../infra/python'
 *   - ReportScheduleEntry   ← './types'
 */
import * as fs from 'fs';
import * as path from 'path';

import { getCompanyDir } from '../paths';
import { runCommandCaptured } from '../infra/process';
import { pythonCmd as _pythonCmd } from '../infra/python';
import type { ReportScheduleEntry } from './types';
import {
    readReportSchedule,
    writeReportSchedule,
    sendTelegramLong,
    _activeChatProvider,
    _runDailyBriefingOnce,
} from '../extension';

let _reportSchedulerTimer: NodeJS.Timeout | null = null;

async function _runScheduledReportEntry(entry: ReportScheduleEntry) {
    try {
        if (entry.action === 'briefing') {
            await _runDailyBriefingOnce(true);
        } else if (entry.action === 'tool' && entry.tool && entry.agentId) {
            const toolDir = path.join(getCompanyDir(), '_agents', entry.agentId, 'tools');
            const scriptPath = path.join(toolDir, `${entry.tool}.py`);
            if (!fs.existsSync(scriptPath)) {
                console.warn(`[scheduler] tool not found: ${scriptPath}`);
                return;
            }
            const r = await runCommandCaptured(`${_pythonCmd()} ${JSON.stringify(entry.tool + '.py')}`, toolDir, () => {}, 120000);
            const out = (r.output || '').trim();
            const status = r.exitCode === 0 ? '✅' : `❌ exit ${r.exitCode}`;
            const msg = `📆 *${entry.label}* (스케줄 자동 실행) ${status}\n\n\`\`\`\n${out.slice(0, 3000)}\n\`\`\``;
            try { await sendTelegramLong(msg); } catch { /* silent */ }
            try { _activeChatProvider?.postSystemNote?.(`📆 ${entry.label} 자동 실행 ${status}`, '📆'); } catch { /* ignore */ }
        }
    } catch (e: any) {
        console.warn('[scheduler] entry failed:', e?.message || e);
    }
}

function _scheduleTick() {
    try {
        const sch = readReportSchedule();
        if (sch.entries.length === 0) return;
        const now = new Date();
        const today = now.toISOString().slice(0, 10);
        const dow = now.getDay();
        const hour = now.getHours();
        const minute = now.getMinutes();
        let changed = false;
        for (const entry of sch.entries) {
            if (!entry.enabled) continue;
            if (entry.hour !== hour || entry.minute !== minute) continue;
            if (entry.days && entry.days.length > 0 && !entry.days.includes(dow)) continue;
            if (entry.lastFiredAt === today) continue; /* 오늘 이미 실행 */
            entry.lastFiredAt = today;
            changed = true;
            _runScheduledReportEntry(entry).catch(() => { /* silent */ });
        }
        if (changed) writeReportSchedule(sch);
    } catch (e: any) {
        console.warn('[scheduler] tick failed:', e?.message || e);
    }
}

export function startReportScheduler() {
    if (_reportSchedulerTimer) return;
    /* 매 60초마다 점검. 분 단위 정밀도면 충분. */
    _reportSchedulerTimer = setInterval(_scheduleTick, 60_000);
    /* 첫 tick은 30초 후 — 활성화 직후 폭주 방지 */
    setTimeout(_scheduleTick, 30_000);
}

export function stopReportScheduler() {
    if (_reportSchedulerTimer) {
        clearInterval(_reportSchedulerTimer);
        _reportSchedulerTimer = null;
    }
}
