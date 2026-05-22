/**
 * OfficePanel — 가상 사무실 시뮬레이션 webview. 에이전트들의 책상 위치,
 * 활성 상태 펄스, 대화 버블, 매출 HUD 등을 표시.
 *
 * extension.ts 에서 분리. wrapper 측에서 `OfficePanel.createOrShow()` 로
 * instantiate. 클래스 본체는 byte-for-byte 그대로 옮겼고, 외부 헬퍼는 모두
 * import 로 끌어온다.
 *
 * Deps imported from `../extension` (need `export` added there):
 *   - type DeskPos
 *   - type WorldZone
 *   - WORLD_LAYOUT
 *   - CUSTOM_MAP_DESKS
 *   - buildWorldDeskPositions
 *   - readCompanyName
 *   - ensureCompanyStructure
 *   - setCompanyDir
 *   - getConversationsDir
 *   - _safeReadText
 *   - _activeChatProvider
 *   - _extCtx
 *   - RevenueDashboardPanel
 *   - type SidebarChatProvider
 *
 * Deps from extracted modules / siblings:
 *   - getCompanyDir          ← '../paths'
 *   - pythonCmd (as _pythonCmd) ← '../infra/python'
 *   - AGENTS, AGENT_ORDER    ← '../agents'
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getCompanyDir } from '../paths';
import { pythonCmd as _pythonCmd } from '../infra/python';
import { AGENTS, AGENT_ORDER } from '../agents';
import {
    type DeskPos,
    type WorldZone,
    type SidebarChatProvider,
    WORLD_LAYOUT,
    CUSTOM_MAP_DESKS,
    buildWorldDeskPositions,
    readCompanyName,
    ensureCompanyStructure,
    setCompanyDir,
    getConversationsDir,
    _safeReadText,
    _activeChatProvider,
    _extCtx,
    RevenueDashboardPanel,
} from '../extension';
import { renderOfficePanelHtml } from './office-panel-html';

export class OfficePanel {
    public static current?: OfficePanel;
    private static readonly viewType = 'connectAiOffice';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _ctx: vscode.ExtensionContext;
    private readonly _provider: SidebarChatProvider;
    private _disposables: vscode.Disposable[] = [];

    static createOrShow(ctx: vscode.ExtensionContext, provider: SidebarChatProvider) {
        if (OfficePanel.current) {
            OfficePanel.current._panel.reveal(vscode.ViewColumn.Active);
            return;
        }
        try { provider.broadcastOfficeState(true); } catch { /* ignore */ }
        const userAssets = OfficePanel._resolveUserAssetsPath();
        const localResourceRoots: vscode.Uri[] = [ctx.extensionUri];
        if (userAssets) {
            localResourceRoots.push(vscode.Uri.file(userAssets));
        }
        // Allow loading user's custom map PNG from the brain folder
        try {
            const brain = getCompanyDir();
            if (brain && fs.existsSync(brain)) {
                localResourceRoots.push(vscode.Uri.file(brain));
            }
        } catch { /* ignore */ }
        const panel = vscode.window.createWebviewPanel(
            OfficePanel.viewType,
            '🏢 가상 사무실',
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots
            }
        );
        OfficePanel.current = new OfficePanel(panel, ctx, provider);
    }

    private constructor(panel: vscode.WebviewPanel, ctx: vscode.ExtensionContext, provider: SidebarChatProvider) {
        this._panel = panel;
        this._ctx = ctx;
        this._provider = provider;

        provider.registerCorporateBroadcastTarget(panel.webview);

        panel.onDidDispose(() => this.dispose(), null, this._disposables);
        panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'officeReady':
                    this._sendInit();
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
                case 'requestRevenueMini': {
                    /* v2.89.143 — 사무실 우상단 HUD 데이터 요청. paypal_revenue.py OUTPUT=json. */
                    try {
                        const ppToolDir = path.join(getCompanyDir(), '_agents', 'business', 'tools');
                        const ppScript = path.join(ppToolDir, 'paypal_revenue.py');
                        const ppJson = path.join(ppToolDir, 'paypal_revenue.json');
                        if (!fs.existsSync(ppScript) || !fs.existsSync(ppJson)) {
                            panel.webview.postMessage({ type: 'revenueMini', data: { error: 'PayPal 미설정' } });
                            break;
                        }
                        const cfg = JSON.parse(_safeReadText(ppJson) || '{}');
                        if (!cfg.CLIENT_ID || !cfg.CLIENT_SECRET) {
                            panel.webview.postMessage({ type: 'revenueMini', data: null });
                            break;
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
                            break;
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
                    break;
                }
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
                case 'loadConversations': {
                    try {
                        const convDir = getConversationsDir();
                        const today = new Date().toISOString().slice(0, 10);
                        const f = path.join(convDir, `${today}.md`);
                        const content = fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : `_아직 오늘 대화가 없습니다._\n\n경로: ${convDir.replace(os.homedir(), '~')}/${today}.md`;
                        panel.webview.postMessage({ type: 'conversationsLoaded', date: today, content });
                    } catch (e: any) {
                        panel.webview.postMessage({ type: 'conversationsLoaded', date: '', content: `_읽기 실패: ${e?.message || e}_` });
                    }
                    break;
                }
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
                case 'pickCompanyFolder': {
                    try {
                        const picked = await vscode.window.showOpenDialog({
                            canSelectFolders: true,
                            canSelectFiles: false,
                            canSelectMany: false,
                            openLabel: '회사 폴더로 선택',
                            title: '회사 폴더 선택 — 에이전트들의 작업/메모리/세션이 여기에 저장됩니다'
                        });
                        if (!picked || picked.length === 0) break;
                        const newDir = picked[0].fsPath;
                        await setCompanyDir(newDir);
                        ensureCompanyStructure();
                        this._sendInit();
                        this._panel.webview.postMessage({ type: 'companyFolderChanged', dir: newDir.replace(os.homedir(), '~') });
                        vscode.window.showInformationMessage(`🏢 회사 폴더 변경됨: ${newDir}`);
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`폴더 변경 실패: ${e?.message || e}`);
                    }
                    break;
                }
                case 'agentProfileRequest': {
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
                                const p = vscode.Uri.joinPath(this._ctx.extensionUri, 'assets', 'agents', pi);
                                if (fs.existsSync(p.fsPath)) {
                                    profileImageUri = this._panel.webview.asWebviewUri(p).toString();
                                }
                            }
                        } catch { /* ignore */ }
                        this._panel.webview.postMessage({
                            type: 'agentProfile',
                            agent: id,
                            memory, decisions,
                            sessionCount,
                            recentSessions,
                            profileImageUri,
                            agentDir: agentDir.replace(os.homedir(), '~')
                        });
                    } catch (e: any) {
                        this._panel.webview.postMessage({ type: 'agentProfile', agent: msg.agent, error: e?.message || String(e) });
                    }
                    break;
                }
                case 'agentConfigRequest': {
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
                        this._panel.webview.postMessage({ type: 'agentConfig', agent: id, values });
                    } catch (e: any) {
                        this._panel.webview.postMessage({ type: 'agentConfig', agent: msg.agent, values: {}, error: e?.message || String(e) });
                    }
                    break;
                }
                case 'saveAgentConfig': {
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
                        this._panel.webview.postMessage({ type: 'agentConfigSaved', agent: id });
                    } catch (e: any) {
                        this._panel.webview.postMessage({ type: 'agentConfigSaved', agent: msg.agent, error: e?.message || String(e) });
                    }
                    break;
                }
            }
        }, null, this._disposables);

        panel.webview.html = this._renderHtml();
    }

    /** 사용자가 설정에 명시적으로 추가 자산 경로를 지정한 경우만 사용. 그 외엔 vsix 번들 자산 사용. */
    private static _resolveUserAssetsPath(): string {
        const cfg = vscode.workspace.getConfiguration('agentOs');
        const explicit = (cfg.get<string>('assetsPath') || '').trim();
        if (explicit && fs.existsSync(explicit)) return explicit;
        // Dev mode: extension repo includes the LimeZu pack at
        // `assets/pixel/moderninteriors-win` (excluded from vsix via .vscodeignore).
        if (_extCtx) {
            const dev = path.join(_extCtx.extensionPath, 'assets', 'pixel', 'moderninteriors-win');
            if (fs.existsSync(dev)) return dev;
        }
        return '';
    }

    /** 캐릭터 sprite를 결정. 우선순위: 사용자 LimeZu 폴더 > 번들 자산 > 빈 문자열(이모지 폴백) */
    private _resolveCharacterSprite(agentId: string): { uri: string; source: 'user' | 'bundled' | 'none' } {
        const userPath = OfficePanel._resolveUserAssetsPath();
        if (userPath) {
            const idx: Record<string, number> = {
                ceo: 1, youtube: 2, instagram: 3, designer: 4,
                developer: 5, business: 6, secretary: 7
            };
            const num = idx[agentId];
            if (num) {
                const padded = String(num).padStart(2, '0');
                const candidates = [
                    // Real LimeZu folder structure
                    path.join(userPath, '2_Characters', 'Character_Generator', '0_Premade_Characters', '48x48', `Premade_Character_48x48_${padded}.png`),
                    // Legacy/flattened layout
                    path.join(userPath, 'modern-interiors', 'characters', `Premade_Character_48x48_${padded}.png`),
                ];
                for (const file of candidates) {
                    if (fs.existsSync(file)) {
                        return { uri: this._panel.webview.asWebviewUri(vscode.Uri.file(file)).toString(), source: 'user' };
                    }
                }
            }
        }
        // 번들 자산 (vsix에 포함, 모든 사용자에게 동작)
        const bundled = vscode.Uri.joinPath(this._ctx.extensionUri, 'assets', 'pixel', 'characters', `${agentId}.png`);
        if (fs.existsSync(bundled.fsPath)) {
            return { uri: this._panel.webview.asWebviewUri(bundled).toString(), source: 'bundled' };
        }
        return { uri: '', source: 'none' };
    }

    /** Resolve all WORLD_LAYOUT scene + decoration assets to webview URIs.
     *  Returns the data shape the webview officeInit handler expects. */
    private _resolveWorld(): {
        worldWidth: number;
        worldHeight: number;
        grassUri: string;
        pathUri: string;
        paths: Array<{ x: number; y: number; w: number; h: number; }>;
        buildings: Array<{ id: string; layer1Uri: string; layer2Uri: string; x: number; y: number; width: number; height: number; }>;
        decorations: Array<{ uri: string; x: number; y: number; w?: number; }>;
        desks: Record<string, DeskPos>;
        zones: WorldZone[];
    } {
        const officeDir = vscode.Uri.joinPath(this._ctx.extensionUri, 'assets', 'pixel', 'office');
        const gardenDir = vscode.Uri.joinPath(officeDir, 'garden');
        const toUri = (root: vscode.Uri, file: string) => {
            if (!file) return '';
            const fp = vscode.Uri.joinPath(root, file);
            if (!fs.existsSync(fp.fsPath)) return '';
            return this._panel.webview.asWebviewUri(fp).toString();
        };
        const buildings = WORLD_LAYOUT.buildings.map(b => ({
            id: b.id,
            layer1Uri: toUri(officeDir, b.layer1),
            layer2Uri: toUri(officeDir, b.layer2 || ''),
            x: b.x, y: b.y, width: b.width, height: b.height,
        }));
        const decorations = WORLD_LAYOUT.decorations
            .map(d => ({ uri: toUri(gardenDir, d.file), x: d.x, y: d.y, w: d.w }))
            .filter(d => !!d.uri);
        return {
            worldWidth: WORLD_LAYOUT.worldWidth,
            worldHeight: WORLD_LAYOUT.worldHeight,
            grassUri: toUri(gardenDir, 'grass_base.png'),
            pathUri: toUri(gardenDir, 'path_stone.png'),
            paths: WORLD_LAYOUT.paths,
            buildings,
            decorations,
            desks: buildWorldDeskPositions(),
            zones: WORLD_LAYOUT.zones,
        };
    }

    /** Detect a user-supplied office map (PNG/JPG/JPEG). If present, the webview
     *  replaces the procedural WORLD_LAYOUT (grass + buildings + decor) with this
     *  single full-stage image. Useful for AI-generated or hand-drawn full-floor maps.
     *  Search order: brain dir _world/, brain dir root, then extension assets/. */
    private _resolveCustomOfficeMap(): string {
        try {
            const brain = getCompanyDir();
            const extAssets = vscode.Uri.joinPath(this._ctx.extensionUri, 'assets').fsPath;
            const candidates = [
                path.join(brain, '_world', 'office-map.png'),
                path.join(brain, '_world', 'office-map.jpg'),
                path.join(brain, '_world', 'office-map.jpeg'),
                path.join(brain, 'office-map.png'),
                path.join(brain, 'office-map.jpg'),
                path.join(brain, 'office-map.jpeg'),
                path.join(extAssets, 'office-map.png'),
                path.join(extAssets, 'office-map.jpg'),
                path.join(extAssets, 'office-map.jpeg'),
                path.join(extAssets, 'map.png'),
                path.join(extAssets, 'map.jpg'),
                path.join(extAssets, 'map.jpeg'),
            ];
            for (const file of candidates) {
                if (fs.existsSync(file)) {
                    return this._panel.webview.asWebviewUri(vscode.Uri.file(file)).toString();
                }
            }
        } catch { /* ignore */ }
        return '';
    }

    private _sendInit() {
        const characterUris: Record<string, string> = {};
        const sources: Record<string, string> = {};
        let firstUri = '';
        const missing: string[] = [];
        for (const id of AGENT_ORDER) {
            const r = this._resolveCharacterSprite(id);
            if (r.uri) {
                characterUris[id] = r.uri;
                sources[id] = r.source;
                if (!firstUri) firstUri = r.uri;
            } else {
                missing.push(id);
            }
        }
        const agents = AGENT_ORDER.map(id => ({
            id,
            name: AGENTS[id].name,
            role: AGENTS[id].role,
            emoji: AGENTS[id].emoji,
            color: AGENTS[id].color,
            specialty: AGENTS[id].specialty,
            sprite: characterUris[id] || ''
        }));
        const dir = getCompanyDir();
        const userPath = OfficePanel._resolveUserAssetsPath();
        const bundledCount = Object.values(sources).filter(s => s === 'bundled').length;
        const userCount = Object.values(sources).filter(s => s === 'user').length;
        // Phase-B-1 connected campus: Office + Cafe + Garden in one world.
        // If user dropped a custom full-stage map (e.g. assets/map.jpeg),
        // that single PNG replaces the procedural world (grass + buildings + decor)
        // AND we override desk positions with hand-tuned CUSTOM_MAP_DESKS so each
        // agent sits in the right room on the AI-generated map.
        const world = this._resolveWorld();
        const customMapUri = this._resolveCustomOfficeMap();
        if (customMapUri) {
            world.desks = { ...world.desks, ...CUSTOM_MAP_DESKS };
        }
        const workdayOn = vscode.workspace.getConfiguration('agentOs').get<boolean>('autoCycleEnabled', true);
        this._panel.webview.postMessage({
            type: 'officeInit',
            agents,
            companyName: readCompanyName() || '1인 기업',
            companyDir: dir.replace(os.homedir(), '~'),
            assetsAvailable: Object.keys(characterUris).length > 0,
            world,
            customMapUri,
            workdayOn,
            debug: {
                userPath,
                bundledCount,
                userCount,
                missing,
                firstSpriteUri: firstUri,
                buildingsLoaded: world.buildings.filter(b => b.layer1Uri).length,
                decorationsLoaded: world.decorations.length,
                customMap: customMapUri ? 'OK' : 'none',
            }
        });
    }

    public dispose() {
        try { this._provider.unregisterCorporateBroadcastTarget(this._panel.webview); } catch { /* ignore */ }
        OfficePanel.current = undefined;
        try { this._provider.broadcastOfficeState(false); } catch { /* ignore */ }
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            try { d?.dispose(); } catch { /* ignore */ }
        }
    }

    private _renderHtml(): string {
        const csp = this._panel.webview.cspSource;
        return renderOfficePanelHtml({ csp });
    }
}
