import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { newTaskId, addTask, updateTask, listOpen } from '../../src/tracker/mutations';
import { readTracker } from '../../src/tracker/io';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-mut-'));
}

describe('tracker/mutations', () => {
    let companyDir: string;

    beforeEach(() => {
        companyDir = mkTmp();
    });

    afterEach(() => {
        try { fs.rmSync(companyDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('addTask 는 id + createdAt 을 자동 채운다', () => {
        // Given: 아무것도 없는 상태
        // When: title/owner 만 주고 추가
        const task = addTask(companyDir, { title: '메모 작성', owner: 'user' });

        // Then: id 와 createdAt 이 자동으로 채워짐
        expect(task.id).toBeTruthy();
        expect(task.id.length).toBeGreaterThan(0);
        expect(task.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        // 디스크에도 저장됨
        const back = readTracker(companyDir);
        expect(back.tasks).toHaveLength(1);
        expect(back.tasks[0].id).toBe(task.id);
    });

    it("addTask 는 priority 기본값 'normal'", () => {
        // When: priority 없이 추가
        const task = addTask(companyDir, { title: 'X', owner: 'user' });

        // Then: 'normal' 로 채워짐
        expect(task.priority).toBe('normal');

        // 그리고 잘못된 값을 넣어도 'normal' 로 coerce
        const task2 = addTask(companyDir, { title: 'Y', owner: 'user', priority: 'bogus' as any });
        expect(task2.priority).toBe('normal');
    });

    it('updateTask 는 patch 필드만 머지', () => {
        // Given: pending task 하나
        const t = addTask(companyDir, { title: '원본 제목', owner: 'user', description: '설명' });

        // When: title 만 patch
        const updated = updateTask(companyDir, t.id, { title: '수정된 제목' });

        // Then: title 만 바뀌고 description 은 보존
        expect(updated).not.toBeNull();
        expect(updated!.title).toBe('수정된 제목');
        expect(updated!.description).toBe('설명');
        expect(updated!.id).toBe(t.id);
        expect(updated!.status).toBe('pending');

        // status → done 으로 바꾸면 completedAt 자동 채움
        const done = updateTask(companyDir, t.id, { status: 'done' });
        expect(done!.status).toBe('done');
        expect(done!.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('updateTask 는 존재하지 않는 id 면 null 반환', () => {
        // Given: 빈 tracker
        // When
        const r = updateTask(companyDir, 'no-such-id', { title: 'x' });

        // Then
        expect(r).toBeNull();
    });

    it("listOpen 은 status='done' 또는 'cancelled' 제외", () => {
        // Given: pending / in_progress / done / cancelled 각각 하나
        const a = addTask(companyDir, { title: 'A', owner: 'user' });                                          // pending
        const b = addTask(companyDir, { title: 'B', owner: 'agent' });                                         // in_progress
        const c = addTask(companyDir, { title: 'C', owner: 'user' });
        updateTask(companyDir, c.id, { status: 'done' });
        const d = addTask(companyDir, { title: 'D', owner: 'user' });
        updateTask(companyDir, d.id, { status: 'cancelled' });

        // When
        const open = listOpen(companyDir);

        // Then: A, B 만 남음
        const ids = open.map(t => t.id).sort();
        expect(ids).toEqual([a.id, b.id].sort());
    });

    it('newTaskId 는 매번 다른 값', () => {
        // When: 여러 번 호출
        const ids = new Set<string>();
        for (let i = 0; i < 50; i++) ids.add(newTaskId());

        // Then: 모두 unique
        expect(ids.size).toBe(50);
    });
});
