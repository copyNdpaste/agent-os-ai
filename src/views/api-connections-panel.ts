/**
 * ApiConnectionsPanel — 풀-스크린 webview ("🔌 외부 연결").
 *
 * extension.ts 에서 분리. 텔레그램/YouTube/Google Calendar/GitHub/Instagram 등
 * 외부 API 자격증명을 한 패널에서 입력·저장 — 같은 값이
 * `_agents/<id>/config.md` 로 디스크에 떨어진다.
 *
 * 클래스 본문은 byte-for-byte 복사 — 이번 사이클에는 리팩터링 없음.
 *
 * Deps imported from `../extension` (need `export` 추가됨):
 *   - saveApiConnection
 *   - readAllApiConnections
 *   - API_SERVICES
 *   - _loadWebviewAsset
 */
import * as vscode from 'vscode';
import {
    saveApiConnection,
    readAllApiConnections,
    API_SERVICES,
    _loadWebviewAsset,
} from '../extension';

export class ApiConnectionsPanel {
    public static current: ApiConnectionsPanel | null = null;
    public static readonly viewType = 'agentOs.apiConnections';
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow() {
        const column = vscode.ViewColumn.Active;
        if (ApiConnectionsPanel.current) {
            ApiConnectionsPanel.current._panel.reveal(column);
            ApiConnectionsPanel.current.refresh();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            ApiConnectionsPanel.viewType,
            '🔌 외부 연결 (API 키)',
            column,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        ApiConnectionsPanel.current = new ApiConnectionsPanel(panel);
    }

    private constructor(panel: vscode.WebviewPanel) {
        this._panel = panel;
        this._panel.webview.html = this._html();
        this._panel.onDidDispose(() => this._dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(async (msg) => {
            try {
                if (msg?.type === 'load') {
                    this._post();
                } else if (msg?.type === 'save' && msg.serviceId && msg.values) {
                    const r = await saveApiConnection(msg.serviceId, msg.values);
                    this._panel.webview.postMessage({ type: 'saved', serviceId: msg.serviceId, ok: r.ok, error: r.error, note: r.note });
                    this._post();
                } else if (msg?.type === 'wizard' && msg.command) {
                    vscode.commands.executeCommand(msg.command);
                } else if (msg?.type === 'openHelp' && msg.url) {
                    vscode.env.openExternal(vscode.Uri.parse(msg.url));
                }
            } catch (e: any) {
                this._panel.webview.postMessage({ type: 'saved', serviceId: msg?.serviceId, ok: false, error: e?.message || String(e) });
            }
        }, null, this._disposables);
        this._post();
    }

    public refresh() { this._post(); }

    private _post() {
        try {
            const values = readAllApiConnections();
            this._panel.webview.postMessage({
                type: 'state',
                services: API_SERVICES.map(s => ({
                    id: s.id, name: s.name, icon: s.icon, summary: s.summary,
                    helpUrl: s.helpUrl || '',
                    wizardCommand: s.wizardCommand || '',
                    comingSoon: !!s.comingSoon,
                    fields: s.fields,
                    values: values[s.id] || {},
                })),
            });
        } catch { /* panel disposed */ }
    }

    private _dispose() {
        ApiConnectionsPanel.current = null;
        while (this._disposables.length) {
            const d = this._disposables.pop();
            try { d?.dispose(); } catch {}
        }
        try { this._panel.dispose(); } catch {}
    }

    private _html(): string {
        return `<!doctype html><html><head><meta charset="utf-8"><style>${_loadWebviewAsset('api-panel.css')}</style></head><body>
<header class="hero">
  <div class="hero-inner">
    <div class="hero-mark">🔌</div>
    <div>
      <div class="eyebrow">CONNECT AI · 외부 연결</div>
      <h1>API 키 한 곳에서 관리</h1>
      <div class="hero-sub">텔레그램 · YouTube · Google Calendar · GitHub · Instagram — 모든 자격증명을 한 패널에서 입력하고 저장합니다. 같은 값이 <code>_agents/&lt;id&gt;/config.md</code>로 저장돼요.</div>
    </div>
  </div>
</header>
<main id="grid" class="grid"></main>
<div class="toast" id="toast"></div>
<script>${_loadWebviewAsset('api-panel.js')}</script>
</body></html>`;
    }
}
