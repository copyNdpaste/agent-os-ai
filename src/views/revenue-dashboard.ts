/**
 * RevenueDashboardPanel — 풀-스크린 webview ("💰 매출 대시보드").
 *
 * extension.ts 에서 분리. paypal_revenue.py OUTPUT=json 실행 결과를
 * KPI 카운터 + 도넛 + 30일 스파크라인 + 거래 피드 로 시각화.
 * 매트릭스 네온 테마. 글리프 비 배경, count-up 애니메이션, 새 결제 시
 * 화면 가운데 burst alert. 5분마다 auto-refresh.
 *
 * 클래스 본문은 byte-for-byte 복사 — 이번 사이클에는 리팩터링 없음.
 *
 * Deps imported from `../extension` (need `export` 추가됨):
 *   - _safeReadText
 *   - _loadWebviewAsset
 *
 * Deps from extracted modules / siblings:
 *   - getCompanyDir ← '../paths'
 *   - pythonCmd (as _pythonCmd) ← '../infra/python'
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getCompanyDir } from '../paths';
import { pythonCmd as _pythonCmd } from '../infra/python';
import {
    _safeReadText,
    _loadWebviewAsset,
} from '../extension';

export class RevenueDashboardPanel {
    public static current: RevenueDashboardPanel | null = null;
    public static readonly viewType = 'agentOs.revenueDashboard';
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _autoRefreshTimer: NodeJS.Timeout | null = null;

    public static createOrShow() {
        const column = vscode.ViewColumn.Active;
        if (RevenueDashboardPanel.current) {
            RevenueDashboardPanel.current._panel.reveal(column);
            RevenueDashboardPanel.current._fetchAndPost();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            RevenueDashboardPanel.viewType,
            '💰 매출 대시보드',
            column,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        RevenueDashboardPanel.current = new RevenueDashboardPanel(panel);
    }

    private constructor(panel: vscode.WebviewPanel) {
        this._panel = panel;
        this._panel.webview.html = this._html();
        this._panel.onDidDispose(() => this._dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(async (msg) => {
            try {
                if (msg?.type === 'ready' || msg?.type === 'refresh') {
                    await this._fetchAndPost();
                } else if (msg?.type === 'openSettings') {
                    vscode.commands.executeCommand('agentOs.apiConnections.open');
                }
            } catch (e: any) {
                this._postError(e?.message || String(e));
            }
        }, null, this._disposables);
        /* 자동 새로고침 — 5분마다. 패널 닫히면 dispose 에서 클리어. */
        this._autoRefreshTimer = setInterval(() => { this._fetchAndPost(); }, 5 * 60 * 1000);
    }

    private async _fetchAndPost() {
        this._post({ type: 'state', loading: true, error: null, data: null });
        try {
            const ppToolDir = path.join(getCompanyDir(), '_agents', 'business', 'tools');
            const ppScript = path.join(ppToolDir, 'paypal_revenue.py');
            const ppJson = path.join(ppToolDir, 'paypal_revenue.json');
            if (!fs.existsSync(ppScript) || !fs.existsSync(ppJson)) {
                this._postError('PayPal 도구가 두뇌에 없어요. business 에이전트 활성화 후 다시 시도.');
                return;
            }
            const cfg = JSON.parse(_safeReadText(ppJson) || '{}');
            if (!cfg.CLIENT_ID || !cfg.CLIENT_SECRET) {
                this._postError('PayPal Client ID 또는 Secret 미설정. 외부 연결 패널에서 입력 필요.');
                return;
            }
            const env = { ...process.env, OUTPUT: 'json', LOOKBACK_DAYS: String(cfg.LOOKBACK_DAYS || 30) };
            const r = await new Promise<{ exitCode: number; output: string; stderr: string }>((resolve) => {
                const cp = require('child_process');
                const p = cp.spawn(_pythonCmd(), [ppScript], { cwd: ppToolDir, env });
                let out = '', err = '';
                p.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
                p.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
                p.on('close', (code: number) => resolve({ exitCode: code, output: out, stderr: err }));
                setTimeout(() => { try { p.kill(); } catch {} resolve({ exitCode: -1, output: out, stderr: err }); }, 25000);
            });
            if (r.exitCode !== 0 || !r.output) {
                this._postError(`paypal_revenue.py 실패 (exit ${r.exitCode}). ${r.stderr.slice(-200) || ''}`);
                return;
            }
            let data: any;
            try { data = JSON.parse(r.output); } catch (pe: any) {
                this._postError(`JSON 파싱 실패: ${pe?.message || pe}`);
                return;
            }
            this._post({ type: 'state', loading: false, error: null, data });
        } catch (e: any) {
            this._postError(e?.message || String(e));
        }
    }

    private _post(msg: any) {
        try { this._panel.webview.postMessage(msg); } catch { /* ignore */ }
    }

    private _postError(err: string) {
        this._post({ type: 'state', loading: false, error: err, data: null });
    }

    private _dispose() {
        RevenueDashboardPanel.current = null;
        if (this._autoRefreshTimer) clearInterval(this._autoRefreshTimer);
        this._disposables.forEach(d => { try { d.dispose(); } catch {} });
    }

    private _html(): string {
        return `<!doctype html><html><head><meta charset="utf-8">
<style>${_loadWebviewAsset('revenue-dashboard.css')}</style>
</head><body>
<div class="glyph-rain" id="glyphRain"></div>

<div class="wrap">
  <header class="hero">
    <div class="hero-mark">💰</div>
    <div class="hero-info">
      <div class="eyebrow">CONNECT AI · REVENUE COMMAND CENTER</div>
      <h1>매출 대시보드</h1>
      <div class="hero-sub">
        PayPal 거래 실시간 분석 · 게임별 매출 분해 · <span class="live">LIVE</span>
        <span style="margin-left: 8px; color: var(--text-3); font-size: 0.8rem;" id="generated"></span>
      </div>
    </div>
    <div class="hero-actions">
      <button class="btn" id="refreshBtn">🔄 새로고침</button>
      <button class="btn" id="settingsBtn">⚙️ 설정</button>
    </div>
  </header>

  <div id="emptyArea" class="hidden"></div>

  <!-- KPI strip -->
  <div class="kpi-strip">
    <div class="kpi today">
      <div class="kpi-label">오늘 매출</div>
      <div class="kpi-value" id="kpiToday" data-last="0">0.00</div>
      <div class="kpi-unit"><span id="curLabel">USD</span></div>
    </div>
    <div class="kpi">
      <div class="kpi-label">지난 7일</div>
      <div class="kpi-value" id="kpiWeek" data-last="0">0.00</div>
      <div class="kpi-unit">7-day rolling</div>
    </div>
    <div class="kpi month">
      <div class="kpi-label">이번 달 (30일)</div>
      <div class="kpi-value" id="kpiMonth" data-last="0">0.00</div>
      <div class="kpi-sub" id="kpiMonthSub">—</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">순매출 / 거래수</div>
      <div class="kpi-value" id="kpiNet" data-last="0">0.00</div>
      <div class="kpi-unit"><span id="kpiCount" data-last="0">0</span>건</div>
    </div>
  </div>

  <!-- Sparkline + Donut row -->
  <div class="row">
    <div class="card">
      <div class="section">
        <h2>30일 일별 매출 추이</h2>
        <div class="spark-wrap">
          <svg class="spark-svg" id="sparkSvg" viewBox="0 0 800 160" preserveAspectRatio="none"></svg>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="section">
        <h2>프로젝트 구성</h2>
        <div class="donut-wrap">
          <div class="donut-rel">
            <svg class="donut-svg" id="donutSvg" viewBox="0 0 200 200"></svg>
            <div class="donut-center">
              <div class="label">Total</div>
              <div class="val" id="donutCenterVal" data-last="0">0</div>
            </div>
          </div>
          <div class="donut-legend" id="donutLegend"></div>
        </div>
      </div>
    </div>
  </div>

  <!-- Project bars + Transaction feed -->
  <div class="row" style="margin-top: 20px;">
    <div class="card">
      <div class="section">
        <h2>프로젝트별 상세</h2>
        <div id="projBars"></div>
      </div>
    </div>
    <div class="card">
      <div class="section">
        <h2>최근 거래</h2>
        <div class="feed" id="feed">
          <div class="skeleton" style="height: 60px; margin-bottom: 10px;"></div>
          <div class="skeleton" style="height: 60px; margin-bottom: 10px;"></div>
          <div class="skeleton" style="height: 60px;"></div>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="burst" id="burst"></div>
<script>${_loadWebviewAsset('revenue-dashboard.js')}</script>
</body></html>`;
    }
}
