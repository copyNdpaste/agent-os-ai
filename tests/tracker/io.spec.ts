import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { trackerPath, readTracker, writeTracker } from '../../src/tracker/io';
import type { TrackerTask } from '../../src/tracker/types';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-io-'));
}

function sampleTask(over: Partial<TrackerTask> = {}): TrackerTask {
    return {
        id: 'fixture-1',
        title: '문서 정리',
        owner: 'user',
        createdAt: '2026-05-01T00:00:00.000Z',
        status: 'pending',
        ...over,
    };
}

describe('tracker/io', () => {
    let companyDir: string;

    beforeEach(() => {
        companyDir = mkTmp();
    });

    afterEach(() => {
        try { fs.rmSync(companyDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('readTracker 는 파일 없으면 빈 tasks 배열', () => {
        // Given: 깨끗한 디렉터리 — tracker.json 없음
        expect(fs.existsSync(trackerPath(companyDir))).toBe(false);

        // When
        const t = readTracker(companyDir);

        // Then: throw 없이 빈 배열
        expect(t).toEqual({ tasks: [] });
    });

    it('readTracker 는 손상된 JSON 시 빈 배열 fallback', () => {
        // Given: 손상된 JSON
        const p = trackerPath(companyDir);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, '{ this is not json ]');

        // When
        const t = readTracker(companyDir);

        // Then: 안전하게 빈 배열
        expect(t).toEqual({ tasks: [] });
    });

    it('writeTracker 는 tasks 배열을 JSON 으로 저장', () => {
        // Given: 샘플 task 한 개
        const task = sampleTask();

        // When: 디스크에 기록
        writeTracker(companyDir, { tasks: [task] });

        // Then: 파일이 존재하고 파싱하면 task 가 있다
        const p = trackerPath(companyDir);
        expect(fs.existsSync(p)).toBe(true);
        const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
        expect(parsed.tasks).toHaveLength(1);
        expect(parsed.tasks[0].id).toBe('fixture-1');
        expect(parsed.tasks[0].title).toBe('문서 정리');
    });

    it('write→read 라운드트립 으로 동일한 데이터 보존', () => {
        // Given: 두 개 task
        const tasks: TrackerTask[] = [
            sampleTask({ id: 'a', title: '첫 번째' }),
            sampleTask({ id: 'b', title: '두 번째', owner: 'agent', status: 'in_progress' }),
        ];

        // When: write 후 다시 read
        writeTracker(companyDir, { tasks });
        const back = readTracker(companyDir);

        // Then: 동일
        expect(back.tasks).toHaveLength(2);
        expect(back.tasks[0].id).toBe('a');
        expect(back.tasks[1].id).toBe('b');
        expect(back.tasks[1].owner).toBe('agent');
        expect(back.tasks[1].status).toBe('in_progress');
    });

    it("trackerPath 는 `<companyDir>/_shared/tracker.json` 가리킴", () => {
        // When
        const p = trackerPath(companyDir);

        // Then: 정확한 절대 경로
        expect(p).toBe(path.join(companyDir, '_shared', 'tracker.json'));
    });
});
