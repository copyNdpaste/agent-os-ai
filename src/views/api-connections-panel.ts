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
import * as path from 'path';
import {
    saveApiConnection,
    API_SERVICES,
    _loadWebviewAsset,
} from '../extension';
import { resolveAllApiConnections, clearProjectOverride } from '../api-connections/storage';

/** Return the absolute path of the first workspace folder, or undefined if
 *  the user has no folder open. Project-scope credentials require this — the
 *  override file lives at `<workspaceFolder>/.agent-os-ai/credentials/`. */
function activeWorkspaceFolder(): string | undefined {
    const wf = vscode.workspace.workspaceFolders;
    if (!wf || wf.length === 0) return undefined;
    return wf[0].uri.fsPath;
}

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
        try { require('./panel-registry').markOpen('api-connections'); } catch { /* ignore */ }
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
                    /* msg.scope: 'company' (default) | 'project'.
                       project scope writes to <workspace>/.agent-os-ai/credentials/{id}.json
                       and skips company-side side-effects (Telegram token verify,
                       OAuth, canonical JSON sync). UI ensures scope='project' only
                       fires when a workspace folder is open. */
                    const scope: 'company' | 'project' = msg.scope === 'project' ? 'project' : 'company';
                    const workspaceFolder = activeWorkspaceFolder();
                    const r = await saveApiConnection(msg.serviceId, msg.values, { scope, workspaceFolder });
                    this._panel.webview.postMessage({
                        type: 'saved',
                        serviceId: msg.serviceId,
                        ok: r.ok,
                        error: r.error,
                        note: r.note,
                        scope: r.scope || scope,
                    });
                    this._post();
                } else if (msg?.type === 'clearProjectOverride' && msg.serviceId) {
                    const workspaceFolder = activeWorkspaceFolder();
                    const cleared = clearProjectOverride(workspaceFolder, msg.serviceId);
                    this._panel.webview.postMessage({
                        type: 'saved',
                        serviceId: msg.serviceId,
                        ok: true,
                        note: cleared ? '🔄 프로젝트 override 제거 — 회사 기본값 복원' : '이미 회사 기본값을 사용 중이에요',
                        scope: 'company',
                    });
                    this._post();
                } else if (msg?.type === 'wizard' && msg.command) {
                    vscode.commands.executeCommand(msg.command);
                } else if (msg?.type === 'openHelp' && msg.url) {
                    vscode.env.openExternal(vscode.Uri.parse(msg.url));
                } else if (msg?.type === 'setupCodexMcp') {
                    /* Codex MCP starter pack 한 번 클릭 추가 — filesystem 만.
                       이미지/콘텐츠는 codex 빌트인 도구 (ChatGPT 구독) 가 처리,
                       API 키 청구 방식 MCP 는 일부러 제외 (사장님 비용 정책). */
                    vscode.commands.executeCommand('agentOs.codex.setupMcp');
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
            const workspaceFolder = activeWorkspaceFolder();
            const resolved = resolveAllApiConnections({ workspaceFolder });
            const workspaceName = workspaceFolder ? path.basename(workspaceFolder) : '';
            this._panel.webview.postMessage({
                type: 'state',
                hasWorkspace: !!workspaceFolder,
                workspaceName,
                services: API_SERVICES.map(s => {
                    const r = resolved[s.id];
                    return {
                        id: s.id, name: s.name, icon: s.icon, summary: s.summary,
                        helpUrl: s.helpUrl || '',
                        wizardCommand: s.wizardCommand || '',
                        comingSoon: !!s.comingSoon,
                        scopeHint: s.scopeHint || 'project-allowed',
                        fields: s.fields,
                        /* Backwards compat: existing UI reads `values[fieldKey]` as
                           a plain string. We pass the EFFECTIVE values (project
                           override wins) so legacy code paths still render correctly. */
                        values: Object.fromEntries(
                            Object.entries(r?.effective || {}).map(([k, v]) => [k, v.value])
                        ),
                        /* New: per-field provenance so UI can badge "company" vs
                           "project" without re-querying. */
                        fieldScopes: Object.fromEntries(
                            Object.entries(r?.effective || {}).map(([k, v]) => [k, v.scope])
                        ),
                        companyValues: r?.companyValues || {},
                        projectValues: r?.projectValues || {},
                        hasProjectOverride: !!r?.hasProjectOverride,
                    };
                }),
            });
        } catch { /* panel disposed */ }
    }

    private _dispose() {
        ApiConnectionsPanel.current = null;
        try { require('./panel-registry').markClosed('api-connections'); } catch { /* ignore */ }
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
      <div class="eyebrow">AGENT OS AI · 외부 연결</div>
      <h1>API 키 한 곳에서 관리</h1>
      <div class="hero-sub">텔레그램 · YouTube · Calendar · OpenAI · Slack · X · Threads · Instagram — 모든 자격증명을 한 패널에서 관리. 회사 기본값은 모든 프로젝트가 공유, 필요 시 프로젝트별 override 가능. 저장 위치: <code>_company/_agents/&lt;id&gt;/config.md</code> + <code>.agent-os-ai/credentials/</code> (둘 다 git 자동 제외).</div>
      <div style="margin-top: 12px; padding: 10px 14px; background: rgba(0,200,150,0.08); border: 1px solid rgba(0,200,150,0.25); border-radius: 8px; font-size: 13px;">
        🟢 <strong>Codex MCP</strong> — 이미지/콘텐츠 생성은 codex 의 ChatGPT 구독 도구로 (API 청구 X).
        <button onclick="vscode.postMessage({type:'setupCodexMcp'})"
                style="margin-left: 8px; padding: 4px 12px; background: #00c896; color: #001; border: none; border-radius: 4px; cursor: pointer; font-weight: 600;">
          filesystem MCP 한 번만 등록
        </button>
        <span style="opacity:0.7">— 등록 후엔 모든 워크스페이스에서 자동으로 <strong>현재 폴더만</strong> 접근 (다른 프로젝트 누수 X). 호출 시점에 path 동적 override.</span>
      </div>
    </div>
  </div>
</header>
<main id="grid" class="grid"></main>
<div class="toast" id="toast"></div>
<script>${_loadWebviewAsset('api-panel.js')}</script>
</body></html>`;
    }
}
