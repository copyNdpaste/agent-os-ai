import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createApproval } from '../../src/approvals/create';
import { approvePendingBulk, isApprovalExcluded } from '../../src/approvals/bulk';
import { listPending } from '../../src/approvals/list';
import { historyDir } from '../../src/approvals/paths';
import type { PendingApproval } from '../../src/approvals/types';

function mkCompanyTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-approvals-bulk-'));
}

describe('approvePendingBulk', () => {
    let dir: string;
    beforeEach(() => { dir = mkCompanyTmp(); });
    afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('pending 전체를 승인하되 excluded payload 는 건너뛴다', async () => {
        const a = createApproval(dir, {
            agentId: 'writer', title: 'send a', summary: 's', payload: { text: 'a' }, kind: 'post',
        });
        const b = createApproval(dir, {
            agentId: 'writer', title: 'send b', summary: 's', payload: { status: 'excluded' }, kind: 'post',
        });
        const calls: string[] = [];
        const r = await approvePendingBulk(dir, 'test bulk', async (ap: PendingApproval) => {
            calls.push(ap.id);
            return { ok: true, output: 'sent' };
        });

        expect(r.ok).toBe(true);
        expect(r.total).toBe(2);
        expect(r.approved).toBe(1);
        expect(r.skipped).toBe(1);
        expect(r.failed).toBe(0);
        expect(calls).toEqual([a.id]);
        expect(listPending(dir).map(x => x.id)).toEqual([b.id]);
        expect(fs.readdirSync(historyDir(dir)).some(f => f.includes(a.id) && f.includes('_OK_'))).toBe(true);
    });

    it('excluded marker 변형을 인식한다', () => {
        const base = {
            id: 'apr-x',
            agentId: 'a',
            title: 't',
            summary: 's',
            kind: 'k',
            createdAt: new Date().toISOString(),
        };
        expect(isApprovalExcluded({ ...base, payload: { excluded: true } })).toBe(true);
        expect(isApprovalExcluded({ ...base, payload: { queueStatus: 'skip' } })).toBe(true);
        expect(isApprovalExcluded({ ...base, payload: { status: 'pending' } })).toBe(false);
    });
});
