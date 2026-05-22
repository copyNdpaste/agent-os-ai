/**
 * Report schedule persistence — JSON file under `<companyDir>/_shared/`.
 *
 * extension.ts 에서 분리됨 (god-file 모듈화). companyDir 외부 주입.
 *
 * Pure data IO 만 다룬다. 실제 setTimeout / 발송 같은 런타임 사이드이펙트는
 * 호출자 (extension.ts) 가 wrapper 로 유지한다.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ReportSchedule, ReportScheduleEntry } from './types';

export function schedulePath(companyDir: string): string {
    return path.join(companyDir, '_shared', 'report_schedule.json');
}

/** Read the schedule file. Returns `{ entries: [] }` on missing file or any
 *  parse / IO error — fail-open so a corrupted disk never blocks startup. */
export function readSchedule(companyDir: string): ReportSchedule {
    try {
        const p = schedulePath(companyDir);
        if (!fs.existsSync(p)) return { entries: [] };
        const data = JSON.parse(fs.readFileSync(p, 'utf-8') || '{}');
        return { entries: Array.isArray(data.entries) ? (data.entries as ReportScheduleEntry[]) : [] };
    } catch {
        return { entries: [] };
    }
}

/** Persist the schedule, pretty-printed with 2-space indent for hand editing.
 *  Errors are logged via console.warn — caller does not need to handle them. */
export function writeSchedule(companyDir: string, s: ReportSchedule): void {
    try {
        const p = schedulePath(companyDir);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(s, null, 2));
    } catch (e: any) {
        console.warn('[reportSchedule] write failed:', e?.message || e);
    }
}
