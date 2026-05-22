/**
 * createApproval BDD — pending/{id}.md + {id}.json 작성.
 * tmp dir 라운드트립으로 검증.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createApproval, newApprovalId } from '../../src/approvals/create';
import { pendingDir } from '../../src/approvals/paths';

function mkCompanyTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-approvals-create-'));
}

describe('createApproval', () => {
    let dir: string;
    beforeEach(() => { dir = mkCompanyTmp(); });
    afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('id 와 createdAt 을 자동으로 채워서 반환한다', () => {
        // Given/When
        const ap = createApproval(dir, {
            agentId: 'ceo',
            title: 'deploy prod',
            summary: 'ship v1',
            payload: { foo: 1 },
            kind: 'deploy.prod',
        });
        // Then
        expect(ap.id).toMatch(/^apr-\d{14}-[a-z0-9]{1,4}$/);
        expect(ap.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(ap.title).toBe('deploy prod');
    });

    it('pending/{id}.md 와 {id}.json 두 파일을 모두 작성한다', () => {
        // Given/When
        const ap = createApproval(dir, {
            agentId: 'developer',
            title: 'commit changes',
            summary: 'fix bug',
            payload: { sha: 'abc' },
            kind: 'git.commit',
        });
        // Then: 파일명은 {id}.md / {id}.json
        const mdPath = path.join(pendingDir(dir), `${ap.id}.md`);
        const jsonPath = path.join(pendingDir(dir), `${ap.id}.json`);
        expect(fs.existsSync(mdPath)).toBe(true);
        expect(fs.existsSync(jsonPath)).toBe(true);
    });

    it('마크다운에 title / summary / kind / payload 가 모두 포함된다', () => {
        // Given/When
        const ap = createApproval(dir, {
            agentId: 'secretary',
            title: 'send weekly mail',
            summary: '주간 리포트 발송',
            payload: { to: 'team@x.com', subject: 'weekly' },
            kind: 'email.send',
        });
        const md = fs.readFileSync(path.join(pendingDir(dir), `${ap.id}.md`), 'utf-8');
        // Then
        expect(md).toContain('send weekly mail');
        expect(md).toContain('주간 리포트 발송');
        expect(md).toContain('`email.send`');
        expect(md).toContain('"to": "team@x.com"');
        expect(md).toContain(ap.id.slice(-9));
    });

    it('summary 가 빈 문자열이면 마크다운에 "_(없음)_" 으로 표기된다', () => {
        // Given/When
        const ap = createApproval(dir, {
            agentId: 'x',
            title: 't',
            summary: '',
            payload: {},
            kind: 'k',
        });
        const md = fs.readFileSync(path.join(pendingDir(dir), `${ap.id}.md`), 'utf-8');
        // Then
        expect(md).toContain('_(없음)_');
    });

    it('agentLabel resolver 가 주어지면 "에이전트:" 라인에 라벨이 들어간다', () => {
        // Given/When
        const ap = createApproval(
            dir,
            { agentId: 'ceo', title: 't', summary: 's', payload: {}, kind: 'k' },
            { agentLabel: (id) => id === 'ceo' ? '👑 CEO' : undefined }
        );
        const md = fs.readFileSync(path.join(pendingDir(dir), `${ap.id}.md`), 'utf-8');
        // Then
        expect(md).toContain('**에이전트:** 👑 CEO');
    });

    it('agentLabel 가 빈 문자열을 반환하면 raw agentId 로 폴백한다', () => {
        // Given/When
        const ap = createApproval(
            dir,
            { agentId: 'mystery', title: 't', summary: 's', payload: {}, kind: 'k' },
            { agentLabel: () => '' }
        );
        const md = fs.readFileSync(path.join(pendingDir(dir), `${ap.id}.md`), 'utf-8');
        // Then
        expect(md).toContain('**에이전트:** mystery');
    });

    it('JSON 파일은 PendingApproval 의 정규 직렬화이다', () => {
        // Given/When
        const ap = createApproval(dir, {
            agentId: 'a',
            title: 't',
            summary: 's',
            payload: { n: 7 },
            kind: 'k',
        });
        const parsed = JSON.parse(
            fs.readFileSync(path.join(pendingDir(dir), `${ap.id}.json`), 'utf-8')
        );
        // Then
        expect(parsed).toEqual(ap);
    });
});

describe('newApprovalId', () => {
    it('호출할 때마다 다른 값을 만든다', () => {
        // Given/When
        const a = newApprovalId();
        const b = newApprovalId();
        const c = newApprovalId();
        // Then: 최소 두 개는 달라야 한다 (timestamp 가 같아도 rand 가 다름)
        const ids = new Set([a, b, c]);
        expect(ids.size).toBeGreaterThan(1);
    });

    it('형식은 apr-<timestamp14>-<rand> 이다', () => {
        // Given/When
        const id = newApprovalId();
        // Then
        expect(id).toMatch(/^apr-\d{14}-[a-z0-9]+$/);
    });
});
