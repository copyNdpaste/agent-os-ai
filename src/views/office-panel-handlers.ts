/**
 * OfficePanel message handlers — extracted from office-panel.ts to keep the
 * panel class focused on lifecycle/asset-resolution. Each handler is a plain
 * async function that receives the same context bag so it can postMessage,
 * read disk, and dispatch to the chat provider.
 *
 * Behavior preserved byte-for-byte. The switch dispatch lives in
 * `handleOfficeMessage()`; cases delegate to dedicated helpers when their
 * body is non-trivial.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getCompanyDir } from '../paths';
import { pythonCmd as _pythonCmd } from '../infra/python';
import { AGENTS } from '../agents';
import {
    type SidebarChatProvider,
    ensureCompanyStructure,
    setCompanyDir,
    getConversationsDir,
    _safeReadText,
    _activeChatProvider,
    RevenueDashboardPanel,
} from '../extension';

export interface OfficeHandlerCtx {
    panel: vscode.WebviewPanel;
    ctx: vscode.ExtensionContext;
    provider: SidebarChatProvider;
    sendInit: () => void;
}

export async function handleOfficeMessage(hctx: OfficeHandlerCtx, msg: any): Promise<void> {
    const { panel, provider } = hctx;
    switch (msg.type) {
        case 'officeReady':
            hctx.sendInit();
            break;
        case 'openRevenueDashboard':
            /* v2.89.143 — 가상 사무실 HUD 클릭 → 풀스크린 매출 대시보드 */
            RevenueDashboardPanel.createOrShow();
            break;
        case 'askHyunbinRevenue': {
            /* v2.89.146 — 매출 shortcut 발동 위해 corporate dispatch 직접 호출
               (injectPrompt 는 bypassCorporate=true 라 명시적 호출 라우팅·shortcut
               건너뛰는 버그). runCorporatePromptExternal 로 specialist dispatch
               진입 → "현빈아" explicit detection → _tryRevenueShortcut 발동. */
            try {
                const model = provider.getDefaultModel();
                provider.runCorporatePromptExternal(
                    '제프베조스아, 이번 달 PayPal 매출 실데이터 가져와서 분석하고 다음 액션 1개 추천해줘.',
                    model
                ).catch((e) => {
                    try { panel.webview.postMessage({ type: 'error', value: `⚠️ ${e?.message || e}` }); } catch { /* ignore */ }
                });
            } catch { /* ignore */ }
            break;
        }
        case 'requestRevenueMini':
            await handleRequestRevenueMini(hctx);
            break;
        case 'officePrompt': {
            const prompt = String(msg.value || '').trim();
            if (!prompt) return;
            const model = provider.getDefaultModel();
            provider.runCorporatePromptExternal(prompt, model).catch((e) => {
                try { panel.webview.postMessage({ type: 'error', value: `⚠️ ${e?.message || e}` }); } catch { /* ignore */ }
            });
            break;
        }
        case 'runChatter': {
            const model = provider.getDefaultModel();
            provider.runAutonomousChatter(model).catch(() => { /* silent */ });
            break;
        }
        case 'loadConversations':
            handleLoadConversations(hctx);
            break;
        case 'openCompanyFolder':
            try {
                const dir = ensureCompanyStructure();
                const sub = msg.sub || '';
                const target = sub ? path.join(dir, sub) : dir;
                vscode.env.openExternal(vscode.Uri.file(target));
            } catch { /* ignore */ }
            break;
        case 'openDashboard':
            try { vscode.commands.executeCommand('agentOs.dashboard.open'); } catch { /* ignore */ }
            break;
        case 'openApiConnections':
            try { vscode.commands.executeCommand('agentOs.apiConnections.open'); } catch { /* ignore */ }
            break;
        case 'toggleAutoCycle':
            try {
                await vscode.workspace.getConfiguration('agentOs').update('autoCycleEnabled', !!msg.on, vscode.ConfigurationTarget.Global);
                if (msg.on) _activeChatProvider?.startAutoCycle?.(15, 0);
                else _activeChatProvider?.stopAutoCycle?.();
            } catch { /* ignore */ }
            break;
        case 'pickCompanyFolder':
            await handlePickCompanyFolder(hctx);
            break;
        case 'agentProfileRequest':
            handleAgentProfileRequest(hctx, msg);
            break;
        case 'agentConfigRequest':
            handleAgentConfigRequest(hctx, msg);
            break;
        case 'saveAgentConfig':
            handleSaveAgentConfig(hctx, msg);
            break;
    }
}

async function handleRequestRevenueMini(hctx: OfficeHandlerCtx): Promise<void> {
    const { panel } = hctx;
    /* v2.89.143 — 사무실 우상단 HUD 데이터 요청. paypal_revenue.py OUTPUT=json. */
    try {
        const ppToolDir = path.join(getCompanyDir(), '_agents', 'business', 'tools');
        const ppScript = path.join(ppToolDir, 'paypal_revenue.py');
        const ppJson = path.join(ppToolDir, 'paypal_revenue.json');
        if (!fs.existsSync(ppScript) || !fs.existsSync(ppJson)) {
            panel.webview.postMessage({ type: 'revenueMini', data: { error: 'PayPal 미설정' } });
            return;
        }
        const cfg = JSON.parse(_safeReadText(ppJson) || '{}');
        if (!cfg.CLIENT_ID || !cfg.CLIENT_SECRET) {
            panel.webview.postMessage({ type: 'revenueMini', data: null });
            return;
        }
        const env = { ...process.env, OUTPUT: 'json', LOOKBACK_DAYS: '30' };
        const r = await new Promise<{ exitCode: number; output: string }>((resolve) => {
            const cp = require('child_process');
            const p = cp.spawn(_pythonCmd(), [ppScript], { cwd: ppToolDir, env });
            let out = '';
            p.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
            p.on('close', (code: number) => resolve({ exitCode: code, output: out }));
            setTimeout(() => { try { p.kill(); } catch {} resolve({ exitCode: -1, output: out }); }, 18000);
        });
        if (r.exitCode !== 0 || !r.output) {
            panel.webview.postMessage({ type: 'revenueMini', data: { error: 'PayPal 호출 실패' } });
            return;
        }
        try {
            const data = JSON.parse(r.output);
            panel.webview.postMessage({ type: 'revenueMini', data });
        } catch {
            panel.webview.postMessage({ type: 'revenueMini', data: { error: '응답 파싱 실패' } });
        }
    } catch (e: any) {
        panel.webview.postMessage({ type: 'revenueMini', data: { error: e?.message || String(e) } });
    }
}

function handleLoadConversations(hctx: OfficeHandlerCtx): void {
    const { panel } = hctx;
    try {
        const convDir = getConversationsDir();
        const today = new Date().toISOString().slice(0, 10);
        const f = path.join(convDir, `${today}.md`);
        const content = fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : `_아직 오늘 대화가 없습니다._\n\n경로: ${convDir.replace(os.homedir(), '~')}/${today}.md`;
        panel.webview.postMessage({ type: 'conversationsLoaded', date: today, content });
    } catch (e: any) {
        panel.webview.postMessage({ type: 'conversationsLoaded', date: '', content: `_읽기 실패: ${e?.message || e}_` });
    }
}

async function handlePickCompanyFolder(hctx: OfficeHandlerCtx): Promise<void> {
    const { panel } = hctx;
    try {
        const picked = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: '회사 폴더로 선택',
            title: '회사 폴더 선택 — 에이전트들의 작업/메모리/세션이 여기에 저장됩니다'
        });
        if (!picked || picked.length === 0) return;
        const newDir = picked[0].fsPath;
        await setCompanyDir(newDir);
        ensureCompanyStructure();
        hctx.sendInit();
        panel.webview.postMessage({ type: 'companyFolderChanged', dir: newDir.replace(os.homedir(), '~') });
        vscode.window.showInformationMessage(`🏢 회사 폴더 변경됨: ${newDir}`);
    } catch (e: any) {
        vscode.window.showErrorMessage(`폴더 변경 실패: ${e?.message || e}`);
    }
}

function handleAgentProfileRequest(hctx: OfficeHandlerCtx, msg: any): void {
    const { panel, ctx } = hctx;
    try {
        const id = String(msg.agent || '');
        const dir = ensureCompanyStructure();
        const agentDir = path.join(dir, '_agents', id);
        const memoryPath = path.join(agentDir, 'memory.md');
        const decisionsPath = path.join(agentDir, 'decisions.md');
        const memory = fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, 'utf-8').slice(0, 4000) : '_메모리 없음_';
        const decisions = fs.existsSync(decisionsPath) ? fs.readFileSync(decisionsPath, 'utf-8').slice(-3000) : '_의사결정 기록 없음_';
        /* count session files mentioning this agent */
        const sessionsRoot = path.join(dir, 'sessions');
        let sessionCount = 0;
        let recentSessions: string[] = [];
        if (fs.existsSync(sessionsRoot)) {
            const entries = fs.readdirSync(sessionsRoot).filter(n => fs.statSync(path.join(sessionsRoot, n)).isDirectory());
            recentSessions = entries.sort().slice(-5).reverse();
            sessionCount = entries.length;
        }
        /* Profile photo (영숙/레오 등) — convert to a webview URI so
           the modal can render the real face instead of just the
           sprite. Empty string when no custom photo is declared. */
        let profileImageUri = '';
        try {
            const pi = AGENTS[id]?.profileImage;
            if (pi) {
                const p = vscode.Uri.joinPath(ctx.extensionUri, 'assets', 'agents', pi);
                if (fs.existsSync(p.fsPath)) {
                    profileImageUri = panel.webview.asWebviewUri(p).toString();
                }
            }
        } catch { /* ignore */ }
        panel.webview.postMessage({
            type: 'agentProfile',
            agent: id,
            memory, decisions,
            sessionCount,
            recentSessions,
            profileImageUri,
            agentDir: agentDir.replace(os.homedir(), '~')
        });
    } catch (e: any) {
        panel.webview.postMessage({ type: 'agentProfile', agent: msg.agent, error: e?.message || String(e) });
    }
}

function handleAgentConfigRequest(hctx: OfficeHandlerCtx, msg: any): void {
    const { panel } = hctx;
    try {
        const id = String(msg.agent || '');
        const dir = ensureCompanyStructure();
        const connPath = path.join(dir, '_agents', id, 'connections.md');
        const values: Record<string, string> = {};
        if (fs.existsSync(connPath)) {
            const text = fs.readFileSync(connPath, 'utf-8');
            /* Parse simple "- key: value" lines (also tolerates "key: value") */
            text.split('\n').forEach(line => {
                const m2 = line.match(/^[\s-]*([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.+?)\s*$/);
                if (m2) values[m2[1]] = m2[2];
            });
        }
        panel.webview.postMessage({ type: 'agentConfig', agent: id, values });
    } catch (e: any) {
        panel.webview.postMessage({ type: 'agentConfig', agent: msg.agent, values: {}, error: e?.message || String(e) });
    }
}

function handleSaveAgentConfig(hctx: OfficeHandlerCtx, msg: any): void {
    const { panel } = hctx;
    try {
        const id = String(msg.agent || '');
        const dir = ensureCompanyStructure();
        const agentDir = path.join(dir, '_agents', id);
        if (!fs.existsSync(agentDir)) fs.mkdirSync(agentDir, { recursive: true });
        const connPath = path.join(agentDir, 'connections.md');
        const values = (msg.values || {}) as Record<string, string>;
        const ts = new Date().toISOString().replace('T', ' ').slice(0, 16);
        const lines = [
            `# ${id} — 외부 연결 / API 설정`,
            ``,
            `> 마지막 수정: ${ts}`,
            `> 이 파일은 ${id} 에이전트가 작업할 때 자동으로 읽힙니다. 민감한 토큰은 git에서 제외(.gitignore)되도록 주의하세요.`,
            ``,
            `## 연결 정보`,
            ``
        ];
        Object.keys(values).forEach(k => {
            const v = (values[k] || '').trim();
            if (v) lines.push(`- ${k}: ${v}`);
        });
        fs.writeFileSync(connPath, lines.join('\n') + '\n', 'utf-8');
        panel.webview.postMessage({ type: 'agentConfigSaved', agent: id });
    } catch (e: any) {
        panel.webview.postMessage({ type: 'agentConfigSaved', agent: msg.agent, error: e?.message || String(e) });
    }
}
