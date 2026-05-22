/**
 * resolveApproval BDD — 'approved' / 'rejected' 양쪽 경로 + executor callback.
 * tmp dir 라운드트립으로 검증.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveApproval } from '../../src/approvals/resolve';
import { createApproval } from '../../src/approvals/create';
import { listPending } from '../../src/approvals/list';
import { pendingDir, historyDir } from '../../src/approvals/paths';
import type { PendingApproval } from '../../src/approvals/types';

function mkCompanyTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-approvals-resolve-'));
}

describe('resolveApproval', () => {
    let dir: string;
    beforeEach(() => { dir = mkCompanyTmp(); });
    afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('approved 결정 시 pending 파일이 history 로 이동된다', async () => {
        // Given
        const ap = createApproval(dir, {
            agentId: 'a', title: 'deploy', summary: 's', payload: {}, kind: 'deploy.prod',
        });
        const mdSrc = path.join(pendingDir(dir), `${ap.id}.md`);
        const jsonSrc = path.join(pendingDir(dir), `${ap.id}.json`);
        expect(fs.existsSync(mdSrc)).toBe(true);
        expect(fs.existsSync(jsonSrc)).toBe(true);
        // When
        const res = await resolveApproval(dir, ap.id, 'approved', '확인 완료');
        // Then
        expect(res.ok).toBe(true);
        expect(res.ap?.id).toBe(ap.id);
        // pending 에는 더 이상 없어야
        expect(fs.existsSync(mdSrc)).toBe(false);
        expect(fs.existsSync(jsonSrc)).toBe(false);
        // history 디렉토리에 OK 태그 파일이 생겨야
        const histFiles = fs.readdirSync(historyDir(dir));
        const okMd = histFiles.find(f => f.includes('_OK_') && f.endsWith('.md'));
        const okJson = histFiles.find(f => f.includes('_OK_') && f.endsWith('.json'));
        expect(okMd).toBeTruthy();
        expect(okJson).toBeTruthy();
    });

    it('rejected 결정 시에도 pending → history 로 이동된다 (NO 태그)', async () => {
        // Given
        const ap = createApproval(dir, {
            agentId: 'a', title: 'spam reply', summary: 's', payload: {}, kind: 'youtube.comment_reply',
        });
        // When
        const res = await resolveApproval(dir, ap.id, 'rejected', '품질 미달');
        // Then
        expect(res.ok).toBe(true);
        expect(res.message).toContain('거부');
        const histFiles = fs.readdirSync(historyDir(dir));
        expect(histFiles.some(f => f.includes('_NO_'))).toBe(true);
        // pending 은 비었어야
        expect(listPending(dir)).toEqual([]);
    });

    it('존재하지 않는 id 는 { ok: false } + 메시지를 반환한다', async () => {
        // Given: 아무 승인도 없음
        // When
        const res = await resolveApproval(dir, 'no-such-id', 'approved');
        // Then
        expect(res.ok).toBe(false);
        expect(res.message).toContain('id');
        expect(res.ap).toBeUndefined();
    });

    it('executor callback 은 approved 일 때만 호출된다', async () => {
        // Given
        const ap = createApproval(dir, {
            agentId: 'a', title: 't', summary: 's', payload: { x: 1 }, kind: 'k',
        });
        const calls: PendingApproval[] = [];
        const exec = async (p: PendingApproval) => { calls.push(p); };
        // When
        const res = await resolveApproval(dir, ap.id, 'approved', '', exec);
        // Then
        expect(res.ok).toBe(true);
        expect(calls).toHaveLength(1);
        expect(calls[0].id).toBe(ap.id);
        expect(calls[0].payload).toEqual({ x: 1 });
    });

    it('rejected 결정에서는 executor callback 이 호출되지 않는다', async () => {
        // Given
        const ap = createApproval(dir, {
            agentId: 'a', title: 't', summary: 's', payload: {}, kind: 'k',
        });
        let called = false;
        const exec = async () => { called = true; };
        // When
        const res = await resolveApproval(dir, ap.id, 'rejected', '거절', exec);
        // Then
        expect(res.ok).toBe(true);
        expect(called).toBe(false);
    });

    it('executor 가 throw 해도 함수는 ok:true 로 끝난다 (best-effort)', async () => {
        // Given
        const ap = createApproval(dir, {
            agentId: 'a', title: 't', summary: 's', payload: {}, kind: 'k',
        });
        const exec = async () => { throw new Error('boom'); };
        // When
        const res = await resolveApproval(dir, ap.id, 'approved', '', exec);
        // Then: executor 가 실패해도 승인은 기록된다
        expect(res.ok).toBe(true);
        // 그리고 history 의 md 에는 FAIL 마커가 들어가야
        const histFiles = fs.readdirSync(historyDir(dir));
        const okMd = histFiles.find(f => f.includes('_OK_') && f.endsWith('.md'));
        expect(okMd).toBeTruthy();
        const histMd = fs.readFileSync(path.join(historyDir(dir), okMd!), 'utf-8');
        expect(histMd).toContain('실행 결과: FAIL');
        expect(histMd).toContain('executor error');
    });

    it('executor 가 없으면 audit 마크다운에 "no executor" 마커가 기록된다', async () => {
        // Given
        const ap = createApproval(dir, {
            agentId: 'a', title: 't', summary: 's', payload: {}, kind: 'youtube.comment_reply',
        });
        // When: executor 미지정
        const res = await resolveApproval(dir, ap.id, 'approved');
        // Then
        expect(res.ok).toBe(true);
        const histFiles = fs.readdirSync(historyDir(dir));
        const okMd = histFiles.find(f => f.includes('_OK_') && f.endsWith('.md'));
        const md = fs.readFileSync(path.join(historyDir(dir), okMd!), 'utf-8');
        expect(md).toContain('no executor');
        expect(md).toContain('youtube.comment_reply');
    });

    it('short id (끝 9자리) 로도 해소할 수 있다', async () => {
        // Given
        const ap = createApproval(dir, {
            agentId: 'a', title: 't', summary: 's', payload: {}, kind: 'k',
        });
        // When
        const res = await resolveApproval(dir, ap.id.slice(-9), 'approved');
        // Then
        expect(res.ok).toBe(true);
        expect(res.ap?.id).toBe(ap.id);
    });

    it('audit 마크다운에 결정/시각/사유가 append 된다', async () => {
        // Given
        const ap = createApproval(dir, {
            agentId: 'a', title: 'do thing', summary: 's', payload: {}, kind: 'k',
        });
        // When
        await resolveApproval(dir, ap.id, 'rejected', '사유 텍스트');
        // Then
        const histFiles = fs.readdirSync(historyDir(dir));
        const noMd = histFiles.find(f => f.includes('_NO_') && f.endsWith('.md'));
        const md = fs.readFileSync(path.join(historyDir(dir), noMd!), 'utf-8');
        expect(md).toContain('## 결정: **✖️ 거부**');
        expect(md).toContain('사유: 사유 텍스트');
    });
});
