/**
 * OfficePanel — 가상 사무실 시뮬레이션 webview. 에이전트들의 책상 위치,
 * 활성 상태 펄스, 대화 버블, 매출 HUD 등을 표시.
 *
 * extension.ts 에서 분리. wrapper 측에서 `OfficePanel.createOrShow()` 로
 * instantiate. 클래스 본체는 lifecycle/asset-resolution 만 담당하고
 * webview message dispatch 는 `office-panel-handlers.ts` 로 위임.
 *
 * Deps imported from `../extension`:
 *   - type DeskPos / type WorldZone / type SidebarChatProvider
 *   - WORLD_LAYOUT, CUSTOM_MAP_DESKS, buildWorldDeskPositions
 *   - readCompanyName, _extCtx
 *
 * Deps from extracted modules / siblings:
 *   - getCompanyDir          ← '../paths'
 *   - AGENTS, AGENT_ORDER    ← '../agents'
 *   - renderOfficePanelHtml  ← './office-panel-html'
 *   - handleOfficeMessage    ← './office-panel-handlers'
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getCompanyDir } from '../paths';
import { AGENTS, AGENT_ORDER } from '../agents';
import {
    type DeskPos,
    type WorldZone,
    type SidebarChatProvider,
    WORLD_LAYOUT,
    CUSTOM_MAP_DESKS,
    buildWorldDeskPositions,
    readCompanyName,
    _extCtx,
} from '../extension';
import { renderOfficePanelHtml } from './office-panel-html';
import { handleOfficeMessage } from './office-panel-handlers';

export class OfficePanel {
    public static current?: OfficePanel;
    private static readonly viewType = 'agentOsAiOffice';

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
        const hctx = {
            panel,
            ctx,
            provider,
            sendInit: () => this._sendInit(),
        };
        panel.webview.onDidReceiveMessage((msg) => {
            handleOfficeMessage(hctx, msg);
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

    /** 캐릭터 sprite를 결정.
     *  우선순위: photo/ 단일 sprite (사진 기반 픽셀) > 사용자 LimeZu atlas > 번들 atlas > 없음.
     *  'photo' source 는 atlas 가 아니므로 webview 에서 frame animation 을 끄고 정적으로 표시. */
    private _resolveCharacterSprite(agentId: string): { uri: string; source: 'photo' | 'user' | 'bundled' | 'none' } {
        // 사진 기반 단일 sprite (assets/pixel/characters/photo/{id}.png)
        const photo = vscode.Uri.joinPath(this._ctx.extensionUri, 'assets', 'pixel', 'characters', 'photo', `${agentId}.png`);
        if (fs.existsSync(photo.fsPath)) {
            return { uri: this._panel.webview.asWebviewUri(photo).toString(), source: 'photo' };
        }
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
            sprite: characterUris[id] || '',
            /* 'photo' = 단일 사진-기반 픽셀 sprite (atlas 아님 → walking frame animation 비활성).
               'user'/'bundled' = LimeZu atlas (48×96 cells × 24 frames). */
            spriteSource: sources[id] || 'none'
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
