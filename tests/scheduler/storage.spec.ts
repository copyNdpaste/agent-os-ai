import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readSchedule, writeSchedule, schedulePath } from '../../src/scheduler';
import type { ReportScheduleEntry } from '../../src/scheduler';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sched-store-'));
}

describe('scheduler/storage', () => {
    let companyDir: string;

    beforeEach(() => {
        companyDir = mkTmp();
    });

    it('readSchedule 은 파일이 없으면 { entries: [] } 를 반환한다', () => {
        // Given: 파일이 아직 만들어지지 않은 깨끗한 companyDir
        const p = schedulePath(companyDir);
        expect(fs.existsSync(p)).toBe(false);

        // When
        const s = readSchedule(companyDir);

        // Then
        expect(s).toEqual({ entries: [] });
    });

    it('write → read 라운드트립이 entry 형식을 보존한다', () => {
        // Given: 실사용 형태의 entry 두 개
        const entries: ReportScheduleEntry[] = [
            {
                id: 'morning-brief', label: '모닝 브리핑', hour: 9, minute: 0,
                days: [1, 2, 3, 4, 5], action: 'briefing', enabled: true,
            },
            {
                id: 'channel-daily', label: '채널 분석', hour: 8, minute: 0,
                days: [0, 1, 2, 3, 4, 5, 6], action: 'tool',
                tool: 'channel_full_analysis', agentId: 'youtube', enabled: true,
                lastFiredAt: '2026-05-21',
            },
        ];

        // When
        writeSchedule(companyDir, { entries });
        const read = readSchedule(companyDir);

        // Then
        expect(read.entries).toEqual(entries);
        // 그리고 디스크 경로도 우리가 광고한 위치여야 한다
        const p = schedulePath(companyDir);
        expect(fs.existsSync(p)).toBe(true);
        expect(p).toContain(path.join('_shared', 'report_schedule.json'));
    });

    it('손상된 JSON 시 fallback 으로 빈 entries 를 반환한다 (throw 안 함)', () => {
        // Given: 깨진 JSON 본문
        const p = schedulePath(companyDir);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, '{this is not valid json::::::');

        // When / Then
        expect(() => readSchedule(companyDir)).not.toThrow();
        expect(readSchedule(companyDir)).toEqual({ entries: [] });
    });
});
