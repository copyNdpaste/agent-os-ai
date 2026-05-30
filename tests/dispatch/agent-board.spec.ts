/* dispatch/agent-board.ts — tracker + sessions 합산 + 필터 검증.
   파일 IO 가 있어 tmp dir 셋업. SessionStateWriter 로 진짜 state.json 만든
   뒤 buildBoard 가 정확히 분류·정렬·필터하는지 확인. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeTracker } from '../../src/tracker/io';
import type { TrackerTask } from '../../src/tracker/types';
import { SessionStateWriter } from '../../src/dispatch/session-state';
import { buildBoard, hideBoardEntry } from '../../src/dispatch/agent-board';

let companyDir: string;

beforeEach(() => {
    companyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-'));
    fs.mkdirSync(path.join(companyDir, '_shared'), { recursive: true });
    fs.mkdirSync(path.join(companyDir, 'sessions'), { recursive: true });
});
afterEach(() => {
    try { fs.rmSync(companyDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function seedTracker(tasks: TrackerTask[]) {
    writeTracker(companyDir, { tasks });
}

function seedSession(id: string, prompt: string, init: (w: SessionStateWriter) => void, finalStatus?: 'completed' | 'failed' | 'aborted'): string {
    const dir = path.join(companyDir, 'sessions', id);
    fs.mkdirSync(dir, { recursive: true });
    const w = new SessionStateWriter({ sessionDir: dir, prompt, modelName: 'claude-sonnet-4-6', fromTelegram: false, throttleMs: 0 });
    init(w);
    /* Force-flush throttled writes so streaming-status entries land on disk
       before the assertion reads them back. finish() also flushes, so callers
       who pass finalStatus get correct behavior either way. */
    if (finalStatus) w.finish(finalStatus);
    else w.flush();
    return dir;
}

describe('dispatch/agent-board', () => {
    it('tracker 의 pending/in_progress/done 을 3개 컬럼으로 분류', () => {
        const now = new Date().toISOString();
        seedTracker([
            { id: 't1', title: '리서치 마치기', owner: 'agent', agentIds: ['researcher'], createdAt: now, status: 'pending' },
            { id: 't2', title: '디자인 진행', owner: 'agent', agentIds: ['designer'], createdAt: now, status: 'in_progress' },
            { id: 't3', title: '코드 완료', owner: 'agent', agentIds: ['developer'], createdAt: now, status: 'done', completedAt: now },
            { id: 't4', title: '취소된 작업', owner: 'agent', agentIds: ['ceo'], createdAt: now, status: 'cancelled' },
        ]);

        const snap = buildBoard(companyDir, { period: 'all' });

        expect(snap.counts.pending).toBe(1);
        expect(snap.counts.in_progress).toBe(1);
        expect(snap.counts.done).toBe(1);
        expect(snap.entries.find(e => e.id === 'tracker:t4')).toBeUndefined(); /* cancelled 는 제외 */
        expect(snap.totalBeforeFilter).toBe(3); /* cancelled 1개 제외 → 3 */
    });

    it('session 의 plan.tasks 가 agentOutput 상태별로 매핑', () => {
        seedSession('s1', '리서치+디자인+개발', w => {
            w.setPlan({ brief: 'multi', tasks: [
                { agent: 'researcher', task: '시장 리서치' },
                { agent: 'designer', task: 'UI 시안' },
                { agent: 'developer', task: '구현' },
            ]});
            /* researcher 완료, designer 진행 중, developer 미시작 */
            w.startAgent('researcher', '시장 리서치');
            w.appendAgentChunk('researcher', '리서치 결과 …');
            w.endAgent('researcher', 'done', { task: '시장 리서치', toolsUsed: [], prefetchSummary: '', outputSummary: '결과', outputLength: 100 });
            w.startAgent('designer', 'UI 시안');
            w.appendAgentChunk('designer', '진행 중 …');
        });

        const snap = buildBoard(companyDir, { period: 'all' });
        const byAgent = Object.fromEntries(snap.entries.map(e => [e.agentId, e]));

        expect(byAgent.researcher?.status).toBe('done');
        expect(byAgent.designer?.status).toBe('in_progress');
        expect(byAgent.developer?.status).toBe('pending');
    });

    it('agent 필터가 특정 한 명만 남김', () => {
        const now = new Date().toISOString();
        seedTracker([
            { id: 't1', title: 'A', owner: 'agent', agentIds: ['business'], createdAt: now, status: 'pending' },
            { id: 't2', title: 'B', owner: 'agent', agentIds: ['developer'], createdAt: now, status: 'pending' },
        ]);

        const snap = buildBoard(companyDir, { period: 'all', agentId: 'developer' });

        expect(snap.entries.length).toBe(1);
        expect(snap.entries[0].agentId).toBe('developer');
        expect(snap.totalBeforeFilter).toBe(2); /* 필터 전엔 2개였음 */
    });

    it("period='today' 는 어제 이전 entry 제외", () => {
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        const yesterday = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000).toISOString();
        const noonToday = new Date(todayStart.getTime() + 12 * 60 * 60 * 1000).toISOString();
        seedTracker([
            { id: 'old', title: '어제 일', owner: 'agent', agentIds: ['business'], createdAt: yesterday, status: 'done', completedAt: yesterday },
            { id: 'new', title: '오늘 일', owner: 'agent', agentIds: ['business'], createdAt: noonToday, status: 'pending' },
        ]);

        const snap = buildBoard(companyDir, { period: 'today' });

        expect(snap.entries.length).toBe(1);
        expect(snap.entries[0].id).toBe('tracker:new');
    });

    it('aborted session 은 완료 컬럼에 badge=aborted 로 표시', () => {
        seedSession('s2', '중단된 작업', w => {
            w.setPlan({ brief: 'x', tasks: [
                { agent: 'business', task: '매출 분석' },
                { agent: 'researcher', task: '추가 리서치' },
            ]});
            w.startAgent('business', '매출 분석');
            w.appendAgentChunk('business', '시작…');
            /* developer 시작 안 함 — session 이 abort 됨 */
        }, 'aborted');

        const snap = buildBoard(companyDir, { period: 'all' });
        const business = snap.entries.find(e => e.agentId === 'business');
        const researcher = snap.entries.find(e => e.agentId === 'researcher');

        expect(business?.status).toBe('done');
        expect(business?.badge).toBe('aborted');
        expect(researcher?.status).toBe('done');
        expect(researcher?.badge).toBe('aborted');
    });

    it("정렬: in_progress → pending → done, 같은 컬럼 안에서는 updatedAt 최신 우선", () => {
        const baseTime = Date.now();
        seedTracker([
            { id: 'd1', title: 'done old', owner: 'agent', agentIds: ['ceo'], createdAt: new Date(baseTime - 10000).toISOString(), status: 'done', completedAt: new Date(baseTime - 10000).toISOString() },
            { id: 'd2', title: 'done new', owner: 'agent', agentIds: ['ceo'], createdAt: new Date(baseTime - 1000).toISOString(), status: 'done', completedAt: new Date(baseTime - 1000).toISOString() },
            { id: 'p1', title: 'pending', owner: 'agent', agentIds: ['ceo'], createdAt: new Date(baseTime).toISOString(), status: 'pending' },
            { id: 'ip1', title: 'in_prog', owner: 'agent', agentIds: ['ceo'], createdAt: new Date(baseTime).toISOString(), status: 'in_progress' },
        ]);

        const snap = buildBoard(companyDir, { period: 'all' });
        const order = snap.entries.map(e => e.id);

        expect(order[0]).toBe('tracker:ip1');   /* in_progress 1순위 */
        expect(order[1]).toBe('tracker:p1');    /* pending 2순위 */
        expect(order[2]).toBe('tracker:d2');    /* done — 최신 먼저 */
        expect(order[3]).toBe('tracker:d1');    /* done — 오래된 */
    });

    it('hideBoardEntry 는 tracker 카드를 칸반 집계에서 제외한다', () => {
        const now = new Date().toISOString();
        seedTracker([
            { id: 't1', title: '삭제할 카드', owner: 'agent', agentIds: ['developer'], createdAt: now, status: 'pending' },
            { id: 't2', title: '남길 카드', owner: 'agent', agentIds: ['developer'], createdAt: now, status: 'pending' },
        ]);

        hideBoardEntry(companyDir, { id: 'tracker:t1' });
        const snap = buildBoard(companyDir, { period: 'all' });

        expect(snap.entries.map(e => e.id)).toEqual(['tracker:t2']);
        expect(snap.counts.pending).toBe(1);
        expect(snap.totalBeforeFilter).toBe(1);
    });

    it('hideBoardEntry 는 같은 sessionDir 의 모든 에이전트 카드를 제외한다', () => {
        const sessionDir = seedSession('s-hide', '여러 에이전트 작업', w => {
            w.setPlan({ brief: 'multi', tasks: [
                { agent: 'researcher', task: '조사' },
                { agent: 'developer', task: '구현' },
            ]});
        });

        hideBoardEntry(companyDir, { id: 'session:s-hide:researcher', sessionDir });
        const snap = buildBoard(companyDir, { period: 'all' });

        expect(snap.entries).toHaveLength(0);
        expect(snap.counts.pending).toBe(0);
    });
});
