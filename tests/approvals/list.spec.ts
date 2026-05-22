/**
 * listPending / findByShortId BDD.
 * tmp dir 에 가짜 .json/.md 파일을 만들어 검증.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listPending, findByShortId } from '../../src/approvals/list';
import { createApproval } from '../../src/approvals/create';
import { pendingDir } from '../../src/approvals/paths';
import type { PendingApproval } from '../../src/approvals/types';

function mkCompanyTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-approvals-list-'));
}

function writeRaw(dir: string, ap: PendingApproval): void {
    const d = pendingDir(dir);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `${ap.id}.json`), JSON.stringify(ap, null, 2));
    fs.writeFileSync(path.join(d, `${ap.id}.md`), `# ${ap.title}\n`);
}

describe('listPending', () => {
    let dir: string;
    beforeEach(() => { dir = mkCompanyTmp(); });
    afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('pending/ 디렉토리가 없으면 빈 배열을 반환한다', () => {
        // Given: 아무것도 없음
        // When
        const out = listPending(dir);
        // Then
        expect(out).toEqual([]);
    });

    it('.json 파일들만 PendingApproval 로 파싱해 반환한다', () => {
        // Given
        writeRaw(dir, { id: 'apr-1', agentId: 'a', title: 't1', summary: 's', payload: {}, kind: 'k', createdAt: '2025-01-01T00:00:00Z' });
        writeRaw(dir, { id: 'apr-2', agentId: 'a', title: 't2', summary: 's', payload: {}, kind: 'k', createdAt: '2025-01-02T00:00:00Z' });
        /* extraneous file should be ignored */
        fs.writeFileSync(path.join(pendingDir(dir), 'note.txt'), 'noise');
        // When
        const out = listPending(dir);
        // Then
        expect(out).toHaveLength(2);
        expect(out.map(a => a.id).sort()).toEqual(['apr-1', 'apr-2']);
    });

    it('createdAt 오름차순 (오래된 것 먼저) 으로 정렬된다', () => {
        // Given: 일부러 역순으로 작성
        writeRaw(dir, { id: 'apr-late', agentId: 'a', title: 't', summary: 's', payload: {}, kind: 'k', createdAt: '2025-03-01T00:00:00Z' });
        writeRaw(dir, { id: 'apr-mid',  agentId: 'a', title: 't', summary: 's', payload: {}, kind: 'k', createdAt: '2025-02-01T00:00:00Z' });
        writeRaw(dir, { id: 'apr-early', agentId: 'a', title: 't', summary: 's', payload: {}, kind: 'k', createdAt: '2025-01-01T00:00:00Z' });
        // When
        const out = listPending(dir);
        // Then
        expect(out.map(a => a.id)).toEqual(['apr-early', 'apr-mid', 'apr-late']);
    });

    it('깨진 JSON 파일은 조용히 skip 한다 (throw 없음)', () => {
        // Given: 정상 1개 + 깨진 1개
        writeRaw(dir, { id: 'apr-ok', agentId: 'a', title: 't', summary: 's', payload: {}, kind: 'k', createdAt: '2025-01-01T00:00:00Z' });
        fs.writeFileSync(path.join(pendingDir(dir), 'apr-broken.json'), '{ not json');
        // When
        const out = listPending(dir);
        // Then
        expect(out.map(a => a.id)).toEqual(['apr-ok']);
    });
});

describe('findByShortId', () => {
    let dir: string;
    beforeEach(() => { dir = mkCompanyTmp(); });
    afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('매칭되는 게 없으면 null 을 반환한다', () => {
        // Given: 빈 디렉토리
        // When
        const got = findByShortId(dir, 'nope');
        // Then
        expect(got).toBeNull();
    });

    it('id 의 끝 부분으로 매칭한다 (텔레그램 short id 케이스)', () => {
        // Given
        const ap = createApproval(dir, {
            agentId: 'a', title: 't', summary: 's', payload: {}, kind: 'k',
        });
        // When: 끝 9자리만 사용
        const got = findByShortId(dir, ap.id.slice(-9));
        // Then
        expect(got).not.toBeNull();
        expect(got!.id).toBe(ap.id);
    });

    it('전체 id 가 정확히 일치하면 endsWith fallback 보다 우선 매칭된다', () => {
        // Given
        const a1 = createApproval(dir, { agentId: 'a', title: 't', summary: 's', payload: {}, kind: 'k' });
        // When
        const got = findByShortId(dir, a1.id);
        // Then
        expect(got).not.toBeNull();
        expect(got!.id).toBe(a1.id);
    });
});
