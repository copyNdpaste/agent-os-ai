/* api-connections/storage.ts 의 cascade resolver 와 project override 동작 검증.
   tmp 디렉토리에 가짜 company + workspace 를 만들고 resolveAllApiConnections /
   clearProjectOverride 가 정확히 동작하는지 확인. 핵심은: project override 가
   있으면 그 값이 효과, 없으면 company default 값이 효과, 둘 다 없으면 빈 값 +
   scope='none' 으로 표시. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/* getCompanyDir 는 settings.json 의 companyDir 또는 ~/.agent-os-ai-brain/_company
   를 본다. 테스트는 임시 디렉토리를 주입하기 위해 vscode + paths + extension
   세 모듈을 mock 한다. */
let tmpRoot: string;
let companyDir: string;
let workspaceDir: string;

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-os-cascade-'));
    companyDir = path.join(tmpRoot, 'company');
    workspaceDir = path.join(tmpRoot, 'workspace');
    fs.mkdirSync(companyDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    vi.resetModules();
    /* Mock vscode minimal stub so the storage module's `require('vscode')` in
       paths.ts gives sane defaults. */
    vi.doMock('vscode', () => ({
        workspace: {
            getConfiguration: () => ({ get: (_k: string, def: any) => def }),
        },
    }));
    /* Force getCompanyDir to point at our tmp folder. */
    vi.doMock('../../src/paths', () => ({
        getCompanyDir: () => companyDir,
        _getBrainDir: () => companyDir,
        _isBrainDirExplicitlySet: () => true,
    }));
    /* The extension module pulls in a lot — stub only what storage.ts imports
       (_safeReadText, ensureCompanyStructure). */
    vi.doMock('../../src/extension', () => ({
        _safeReadText: (p: string) => {
            try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; }
        },
        ensureCompanyStructure: () => companyDir,
    }));
    /* Agents lookup is only used to seed config.md headers — provide minimal map. */
    vi.doMock('../../src/agents', () => ({
        AGENTS: {
            business: { name: 'Bezos', emoji: '💼' },
            secretary: { name: 'Karina', emoji: '🤖' },
            instagram: { name: 'Beast', emoji: '🎬' },
            youtube: { name: 'Beast', emoji: '🎬' },
            developer: { name: 'Dev', emoji: '💻' },
        },
    }));
});

afterEach(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Seed a config.md for a given agent with KEY: VALUE lines so the cascade
 *  resolver can pick them up as company defaults. */
function seedCompanyConfig(agentId: string, kv: Record<string, string>) {
    const dir = path.join(companyDir, '_agents', agentId);
    fs.mkdirSync(dir, { recursive: true });
    const lines = Object.entries(kv).map(([k, v]) => `${k}: ${v}`).join('\n');
    fs.writeFileSync(path.join(dir, 'config.md'), `# header\n\n${lines}\n`, 'utf-8');
}

describe('api-connections/storage cascade', () => {
    it('회사 기본값만 있으면 effective scope=company, 값 그대로', async () => {
        seedCompanyConfig('business', { OPENAI_API_KEY: 'sk-company-key' });
        const { resolveAllApiConnections } = await import('../../src/api-connections/storage');

        const r = resolveAllApiConnections({ workspaceFolder: workspaceDir });

        expect(r.openai.effective.OPENAI_API_KEY.value).toBe('sk-company-key');
        expect(r.openai.effective.OPENAI_API_KEY.scope).toBe('company');
        expect(r.openai.hasProjectOverride).toBe(false);
    });

    it('회사·프로젝트 둘 다 없으면 빈 값 + scope=none', async () => {
        const { resolveAllApiConnections } = await import('../../src/api-connections/storage');

        const r = resolveAllApiConnections({ workspaceFolder: workspaceDir });

        expect(r.openai.effective.OPENAI_API_KEY.value).toBe('');
        expect(r.openai.effective.OPENAI_API_KEY.scope).toBe('none');
    });

    it('프로젝트 override 가 있으면 회사값 무시하고 그 값이 effective', async () => {
        seedCompanyConfig('business', { OPENAI_API_KEY: 'sk-company' });
        const { saveApiConnection, resolveAllApiConnections } = await import('../../src/api-connections/storage');

        const res = await saveApiConnection(
            'openai',
            { OPENAI_API_KEY: 'sk-project-only' },
            { scope: 'project', workspaceFolder: workspaceDir },
        );

        expect(res.ok).toBe(true);
        expect(res.scope).toBe('project');

        const r = resolveAllApiConnections({ workspaceFolder: workspaceDir });
        expect(r.openai.effective.OPENAI_API_KEY.value).toBe('sk-project-only');
        expect(r.openai.effective.OPENAI_API_KEY.scope).toBe('project');
        expect(r.openai.hasProjectOverride).toBe(true);
        expect(r.openai.companyValues.OPENAI_API_KEY).toBe('sk-company');
    });

    it('clearProjectOverride 후엔 회사 기본값으로 복원', async () => {
        seedCompanyConfig('business', { OPENAI_API_KEY: 'sk-company' });
        const {
            saveApiConnection,
            clearProjectOverride,
            resolveAllApiConnections,
        } = await import('../../src/api-connections/storage');

        await saveApiConnection(
            'openai',
            { OPENAI_API_KEY: 'sk-override' },
            { scope: 'project', workspaceFolder: workspaceDir },
        );
        const cleared = clearProjectOverride(workspaceDir, 'openai');
        expect(cleared).toBe(true);

        const r = resolveAllApiConnections({ workspaceFolder: workspaceDir });
        expect(r.openai.effective.OPENAI_API_KEY.value).toBe('sk-company');
        expect(r.openai.effective.OPENAI_API_KEY.scope).toBe('company');
        expect(r.openai.hasProjectOverride).toBe(false);
    });

    it('company-only 서비스는 project scope 저장 거부', async () => {
        const { saveApiConnection } = await import('../../src/api-connections/storage');

        const res = await saveApiConnection(
            'slack',
            { SLACK_BOT_TOKEN: 'xoxb-...' },
            { scope: 'project', workspaceFolder: workspaceDir },
        );

        expect(res.ok).toBe(false);
        expect(res.error || '').toMatch(/회사 전체 단일 계정/);
    });

    it('project scope 저장은 .agent-os-ai/credentials/{id}.json 에 들어가고 gitignore 도 생성', async () => {
        const { saveApiConnection } = await import('../../src/api-connections/storage');

        await saveApiConnection(
            'openai',
            { OPENAI_API_KEY: 'sk-proj' },
            { scope: 'project', workspaceFolder: workspaceDir },
        );

        const credFile = path.join(workspaceDir, '.agent-os-ai', 'credentials', 'openai.json');
        expect(fs.existsSync(credFile)).toBe(true);
        const parsed = JSON.parse(fs.readFileSync(credFile, 'utf-8'));
        expect(parsed.OPENAI_API_KEY).toBe('sk-proj');

        const gi = path.join(workspaceDir, '.agent-os-ai', '.gitignore');
        expect(fs.existsSync(gi)).toBe(true);
        expect(fs.readFileSync(gi, 'utf-8')).toContain('credentials/');
    });
});
