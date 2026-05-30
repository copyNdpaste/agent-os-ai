import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let companyDir = '';

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({
            get: (key: string) => key === 'companyDir' ? companyDir : '',
        }),
    },
    ThemeIcon: class ThemeIcon {
        constructor(public id: string, public color?: unknown) {}
    },
    ThemeColor: class ThemeColor {
        constructor(public id: string) {}
    },
}));

vi.mock('../../src/extension', () => ({
    _safeReadText: (p: string) => {
        try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
    },
}));

import { listAgentTools } from '../../src/tracker/ui-helpers';

function writeTool(agentId: string, name: string, config: Record<string, any>) {
    const dir = path.join(companyDir, '_agents', agentId, 'tools');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.py`), 'print("ok")\n');
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(config, null, 2));
    fs.writeFileSync(path.join(dir, `${name}.md`), `# ${name}\n\nTest tool.`);
}

describe('listAgentTools', () => {
    beforeEach(() => {
        companyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-tools-'));
    });

    afterEach(() => {
        try { fs.rmSync(companyDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('Slack tools are hidden unless explicitly enabled', () => {
        writeTool('instagram', 'threads_uploader', {});
        writeTool('instagram', 'slack_approval_worker', {});
        writeTool('instagram', 'slack_notifier', { _enabled: false });

        expect(listAgentTools('instagram').map(t => t.name)).toEqual(['threads_uploader']);
    });

    it('Slack tools can still be exposed by explicit _enabled true', () => {
        writeTool('instagram', 'slack_approval_worker', { _enabled: true });

        expect(listAgentTools('instagram').map(t => t.name)).toContain('slack_approval_worker');
    });
});
