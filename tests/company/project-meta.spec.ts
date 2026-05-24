/* company/project-meta — workspace-scoped 프로젝트 메타 read/write + 헬퍼. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    readProjectMeta,
    writeProjectMeta,
    statusLabel,
    projectSummaryLine,
    buildProjectContextBlock,
    type ProjectMeta,
} from '../../src/company/project-meta';

let ws: string;
const metaFile = () => path.join(ws, '.agent-os-ai', 'project.json');

beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'project-meta-'));
});
afterEach(() => {
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('project-meta — read/write', () => {
    it('workspace 없으면 null', () => {
        expect(readProjectMeta(undefined)).toBeNull();
    });

    it('파일 없으면 null', () => {
        expect(readProjectMeta(ws)).toBeNull();
    });

    it('writeProjectMeta → readProjectMeta round-trip', () => {
        const meta: ProjectMeta = {
            name: 'alpha-agent-ai',
            tagline: '수요 신호로 아이디어 검증',
            goal: '30일 안에 첫 사전예약 1개',
            deadline: '2026-07-01',
            status: 'validating',
            audience: '1인 개발자',
            kpis: ['사전예약 ≥ 10', '고객 인터뷰 ≥ 5'],
        };

        const r = writeProjectMeta(ws, meta);

        expect(r.ok).toBe(true);
        const back = readProjectMeta(ws);
        expect(back?.name).toBe('alpha-agent-ai');
        expect(back?.goal).toBe('30일 안에 첫 사전예약 1개');
        expect(back?.status).toBe('validating');
        expect(back?.kpis).toEqual(['사전예약 ≥ 10', '고객 인터뷰 ≥ 5']);
        expect(back?.createdAt).toBeDefined();
        expect(back?.updatedAt).toBeDefined();
    });

    it('name 없으면 거부', () => {
        const r = writeProjectMeta(ws, { name: '' });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/이름/);
    });

    it('잘못된 status 는 read 시 drop', () => {
        const dir = path.join(ws, '.agent-os-ai');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(metaFile(), JSON.stringify({
            name: 'x', status: 'totally-invalid',
        }));

        const back = readProjectMeta(ws);

        expect(back?.name).toBe('x');
        expect(back?.status).toBeUndefined();
    });

    it('createdAt 두 번째 저장에서 보존, updatedAt 만 갱신', async () => {
        writeProjectMeta(ws, { name: 'p1', goal: 'a' });
        const first = readProjectMeta(ws);
        await new Promise(r => setTimeout(r, 5));

        writeProjectMeta(ws, { name: 'p1', goal: 'b' });
        const second = readProjectMeta(ws);

        expect(second?.createdAt).toBe(first?.createdAt);
        expect(second?.updatedAt).not.toBe(first?.updatedAt);
    });

    it('.agent-os-ai/.gitignore 자동 생성 + credentials 차단', () => {
        writeProjectMeta(ws, { name: 'p' });

        const gi = path.join(ws, '.agent-os-ai', '.gitignore');
        expect(fs.existsSync(gi)).toBe(true);
        expect(fs.readFileSync(gi, 'utf-8')).toContain('credentials/');
    });

    it('알 수 없는 필드는 read 시 stripped (forward-compat)', () => {
        const dir = path.join(ws, '.agent-os-ai');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(metaFile(), JSON.stringify({
            name: 'p', futureField: 'should-be-dropped',
        }));

        const back = readProjectMeta(ws);

        expect(back?.name).toBe('p');
        expect((back as any).futureField).toBeUndefined();
    });
});

describe('project-meta — helpers', () => {
    it('statusLabel 매핑', () => {
        expect(statusLabel('ideating')).toContain('💡');
        expect(statusLabel('validating')).toContain('🔬');
        expect(statusLabel('building')).toContain('🛠');
        expect(statusLabel('launched')).toContain('🚀');
        expect(statusLabel(undefined)).toBe('');
    });

    it('projectSummaryLine — null 안전, 컴팩트 한 줄', () => {
        expect(projectSummaryLine(null)).toBe('');
        const line = projectSummaryLine({
            name: 'alpha-agent-ai',
            goal: '30일 안에 첫 사전예약 1개',
            status: 'validating',
        });
        expect(line).toContain('alpha-agent-ai');
        expect(line).toContain('사전예약');
        expect(line).toContain('🔬');
    });

    it('projectSummaryLine 의 goal 너무 길면 잘림', () => {
        const longGoal = '아주 긴 목표가 있고 이건 정말로 매우 매우 길어서 한 줄에 다 안 들어가는 길이';
        const line = projectSummaryLine({ name: 'x', goal: longGoal });
        expect(line).toContain('…');
    });

    it('buildProjectContextBlock — null 이면 빈 문자열', () => {
        expect(buildProjectContextBlock(null)).toBe('');
    });

    it('buildProjectContextBlock — 모든 필드 라벨링 포함', () => {
        const block = buildProjectContextBlock({
            name: 'alpha-agent-ai',
            tagline: '수요 검증 SaaS',
            goal: '사전예약 10명',
            deadline: '2026-07-01',
            status: 'validating',
            audience: '1인 개발자',
            kpis: ['예약 10', '인터뷰 5'],
        });
        expect(block).toContain('[현재 프로젝트');
        expect(block).toContain('이름: alpha-agent-ai');
        expect(block).toContain('🎯 목표: 사전예약 10명');
        expect(block).toContain('📅 기한: 2026-07-01');
        expect(block).toContain('🔬 수요 검증 중');
        expect(block).toContain('👥 타깃: 1인 개발자');
        expect(block).toContain('📈 KPI: 예약 10 / 인터뷰 5');
    });
});
