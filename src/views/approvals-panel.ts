/**
 * ApprovalsPanelProvider — VS Code 사이드바 webview ("⏳ 승인 대기").
 *
 * extension.ts 에서 분리. 컴팩트한 상위 3건만 보여주고 풀 UX 는
 * CompanyDashboardPanel 로 위임. 8초마다 폴링 refresh — 다른 에이전트가
 * 패널 밖에서 승인을 만들어도 라이브로 반영.
 *
 * 클래스 본문은 byte-for-byte 복사 — 이번 사이클에는 리팩터링 없음.
 *
 * Deps imported from `../extension` (need `export` 추가됨):
 *   - resolveApproval
 *   - listPendingApprovals
 *   - _approvalsPendingDir
 *   - _loadWebviewAsset
 *
 * Deps from extracted modules / siblings:
 *   - AGENTS ← '../agents'
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { AGENTS } from '../agents';
import {
    resolveApproval,
    listPendingApprovals,
    _approvalsPendingDir,
    _loadWebviewAsset,
} from '../extension';

export class ApprovalsPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewId = 'agentOs.approvals';
    private _view?: vscode.WebviewView;
    private _refreshTicker: NodeJS.Timeout | null = null;

    resolveWebviewView(view: vscode.WebviewView): void {
        this._view = view;
        view.webview.options = { enableScripts: true };
        view.webview.html = this._html();
        view.webview.onDidReceiveMessage(async (msg) => {
            if (msg?.type === 'refresh') this._post();
            else if (msg?.type === 'openDash') {
                vscode.commands.executeCommand('agentOs.dashboard.open');
            } else if (msg?.type === 'approve' && msg.id) {
                const r = await resolveApproval(msg.id, 'approved');
                this._post(r.message);
            } else if (msg?.type === 'reject' && msg.id) {
                const r = await resolveApproval(msg.id, 'rejected');
                this._post(r.message);
            } else if (msg?.type === 'open' && msg.id) {
                try {
                    const ap = listPendingApprovals().find(a => a.id.endsWith(msg.id));
                    if (ap) {
                        const p = path.join(_approvalsPendingDir(), `${ap.id}.md`);
                        const doc = await vscode.workspace.openTextDocument(p);
                        vscode.window.showTextDocument(doc);
                    }
                } catch { /* ignore */ }
            }
        });
        /* Poll-refresh — pending approvals can be created from any agent any
           time, so the panel needs to re-render even when the user isn't
           interacting with it. 8s is a sweet spot — fast enough to feel
           live, slow enough to not drain battery. */
        this._refreshTicker = setInterval(() => this._post(), 8000);
        view.onDidDispose(() => {
            if (this._refreshTicker) clearInterval(this._refreshTicker);
            this._refreshTicker = null;
            this._view = undefined;
        });
        this._post();
    }

    public refresh() { this._post(); }

    private _post(toast?: string) {
        if (!this._view) return;
        const items = listPendingApprovals().map(a => {
            const ag = AGENTS[a.agentId];
            return {
                id: a.id, shortId: a.id.slice(-9),
                agent: a.agentId,
                emoji: ag?.emoji || '🤖',
                name: ag?.name || a.agentId,
                kind: a.kind,
                title: a.title,
                summary: a.summary,
                createdAt: a.createdAt,
            };
        });
        this._view.webview.postMessage({ type: 'state', items, toast });
    }

    private _html(): string {
        /* Slim sidebar version — full UX lives in the editor-pane dashboard.
           Here we show: top 3 pending approvals (compact), big "둘러보기"
           CTA. Quick approval actions still inline so the user can decide
           without context-switching. */
        return `<!doctype html><html><head><meta charset="utf-8"><style>${_loadWebviewAsset('sidebar-brand.css')}</style></head><body>
<div class="sb-head">
  <span class="sb-title">⏳ 승인 대기</span>
  <span class="sb-badge" id="cnt">0</span>
</div>
<div class="sb-cta">
  <button class="sb-btn primary" id="openDash">🏢 우리 회사 →</button>
</div>
<div id="list" class="sb-body"></div>
<div class="sb-toast" id="toast"></div>
<script>
const vscode = acquireVsCodeApi();
const list = document.getElementById('list');
const cnt  = document.getElementById('cnt');
const toast = document.getElementById('toast');
document.getElementById('openDash').onclick = () => vscode.postMessage({ type: 'openDash' });
function showToast(msg, isErr) { toast.textContent = msg; toast.classList.toggle('err', !!isErr); toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2400); }
function esc(s){ return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]); }
window.addEventListener('message', e => {
  const m = e.data;
  if (m.type !== 'state') return;
  cnt.textContent = m.items.length;
  if (m.toast) showToast(m.toast, /실패|찾지 못|FAIL/.test(m.toast));
  if (m.items.length === 0) {
    list.innerHTML = '<div class="sb-empty">✅ 대기 액션 없음</div>';
    return;
  }
  /* Show top 3 only — rest in the dashboard. */
  list.innerHTML = m.items.slice(0, 3).map(it =>
    '<div class="sb-card"><div class="sb-card-head"><span>' + it.emoji + '</span>'
    + '<span class="sb-card-title">' + esc(it.title) + '</span></div>'
    + '<div class="sb-card-meta">' + esc(it.name) + ' · ' + esc(it.shortId) + '</div>'
    + '<div class="sb-card-actions">'
    +   '<button class="sb-btn primary" data-act="approve" data-id="' + esc(it.shortId) + '">✅</button>'
    +   '<button class="sb-btn danger"  data-act="reject"  data-id="' + esc(it.shortId) + '">✖️</button>'
    +   '<button class="sb-btn"          data-act="open"    data-id="' + esc(it.shortId) + '">📄</button>'
    + '</div></div>'
  ).join('');
  if (m.items.length > 3) {
    list.innerHTML += '<div class="sb-more">+' + (m.items.length - 3) + '건 더 — 둘러보기에서 확인</div>';
  }
  list.querySelectorAll('button[data-act]').forEach(btn => {
    btn.onclick = () => vscode.postMessage({ type: btn.dataset.act, id: btn.dataset.id });
  });
});
vscode.postMessage({ type: 'refresh' });
</script>
</body></html>`;
    }
}
