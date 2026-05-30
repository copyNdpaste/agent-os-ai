/**
 * CompanyDashboardPanel — VS Code 풀-스크린 웹뷰. "👥 에이전트 업무 대시보드".
 *
 * extension.ts 에서 분리. wrapper 측에서 createOrShow() 호출.
 * 사이드바 위젯 (좁아서 KPI 풀 렌더 불가) 의 폴리쉬 본진 — 에이전트 매트릭스,
 * 액티브 워크로드, 승인 큐, YouTube 통합, 매출 카드 모두 여기서 산다.
 *
 * 클래스 본문은 byte-for-byte 복사 — 이번 사이클에는 리팩터링 없음.
 *
 * Deps imported from `../extension` (need `export` 추가됨):
 *   - RevenueDashboardPanel
 *   - _activeChatProvider, _ytDashboardProvider
 *   - _safeReadText, _pythonCmd
 *   - _coercePriority, _formatDueLabel
 *   - _approvalsPendingDir
 *   - _runDailyBriefingOnce
 *   - _youtubeCommentReplyDraftBatch
 *   - _maybeRecommendCoderModel
 *   - _autoOrchestrateModelMap
 *   - _dashboardExtensionUri
 *   - ALWAYS_ON_AGENTS, LOCKED_AGENTS_DEFAULT, OPTIONAL_AGENTS_DEFAULT
 *   - AUTONOMY_LABELS
 *   - TASK_PRIORITY_ORDER
 *   - setAgentActive
 *   - readActiveAgents, readHiredAgents, markAgentHired
 *   - isAgentActive, isAgentHired, isAgentTogglable
 *   - readCompanyName
 *   - readTracker, updateTrackerTask
 *   - resolveApproval, listPendingApprovals
 *   - approveAllPendingApprovals
 *   - listInstalledModels
 *   - readAgentModelMap, writeAgentModelMap
 *   - readReportSchedule, writeReportSchedule
 *   - listAgentTools
 *   - runCommandCaptured
 *   - readToolAutonomyLevel
 *   - countAgentVerifiedClaims
 *   - readAgentRagMode, writeAgentRagMode, readAgentSelfRagCriteria
 *   - onTrackerChanged
 *   - isYoutubeOAuthConnected, fetchYouTubeAnalyticsSummary
 *   - getConversationsDir, readRecentConversations
 *   - _loadWebviewAsset
 *
 * Deps from extracted modules / 별도 파일:
 *   - import { AGENTS, AGENT_ORDER } from '../agents'
 *   - import { getCompanyDir } from '../paths'
 *   - import { getSystemSpecs, estimateModelMemoryGB } from '../system-specs'
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { AGENTS, AGENT_ORDER } from '../agents';
import { getCompanyDir } from '../paths';
import { getSystemSpecs, estimateModelMemoryGB } from '../system-specs';
import {
    RevenueDashboardPanel,
    _activeChatProvider,
    _ytDashboardProvider,
    _safeReadText,
    _pythonCmd,
    _coercePriority,
    _formatDueLabel,
    _approvalsPendingDir,
    _runDailyBriefingOnce,
    _youtubeCommentReplyDraftBatch,
    _maybeRecommendCoderModel,
    _autoOrchestrateModelMap,
    _dashboardExtensionUri,
    _loadWebviewAsset,
    ALWAYS_ON_AGENTS,
    LOCKED_AGENTS_DEFAULT,
    OPTIONAL_AGENTS_DEFAULT,
    AUTONOMY_LABELS,
    TASK_PRIORITY_ORDER,
    setAgentActive,
    readActiveAgents,
    readHiredAgents,
    markAgentHired,
    isAgentActive,
    isAgentHired,
    isAgentTogglable,
    readCompanyName,
    readTracker,
    updateTrackerTask,
    resolveApproval,
    approveAllPendingApprovals,
    listPendingApprovals,
    listInstalledModels,
    readAgentModelMap,
    writeAgentModelMap,
    readReportSchedule,
    writeReportSchedule,
    listAgentTools,
    runCommandCaptured,
    readToolAutonomyLevel,
    countAgentVerifiedClaims,
    readAgentRagMode,
    writeAgentRagMode,
    readAgentSelfRagCriteria,
    onTrackerChanged,
    isYoutubeOAuthConnected,
    fetchYouTubeAnalyticsSummary,
    getConversationsDir,
    readRecentConversations,
} from '../extension';

/* ── Full-screen Company Dashboard ────────────────────────────────────────
   The sidebar webviews are inherently constrained to ~220px wide; analytics
   dashboards need real width. This class opens a full editor-pane webview
   ("회사 둘러보기") that is the proper home for the polished design — the
   sidebar versions become quick-glance status cards that link here.
   Singleton: re-opening the command brings the existing panel forward
   instead of stacking. */
export class CompanyDashboardPanel {
    public static current: CompanyDashboardPanel | null = null;
    public static readonly viewType = 'agentOs.dashboard';
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _refreshTimer: NodeJS.Timeout | null = null;

    public static createOrShow(extensionUri: vscode.Uri) {
        const column = vscode.ViewColumn.Active;
        if (CompanyDashboardPanel.current) {
            CompanyDashboardPanel.current._panel.reveal(column);
            CompanyDashboardPanel.current.refresh();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            CompanyDashboardPanel.viewType,
            '👥 에이전트 업무 대시보드',
            column,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        CompanyDashboardPanel.current = new CompanyDashboardPanel(panel, extensionUri);
        try { require('./panel-registry').markOpen('company-dashboard'); } catch { /* ignore */ }
    }

    private constructor(panel: vscode.WebviewPanel, _extUri: vscode.Uri) {
        this._panel = panel;
        this._panel.webview.html = this._html();
        this._panel.onDidDispose(() => this._dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(async (msg) => {
            try {
                if (msg?.type === 'refresh') {
                    await this._sendState();
                } else if (msg?.type === 'loadBoard') {
                    /* 📋 업무 보드 데이터 요청. period + agent 필터를 받아 tracker +
                       sessions 합산해서 board snapshot 반환. */
                    try {
                        const { buildBoard } = await import('../dispatch/agent-board');
                        const period = (msg.period === 'today' || msg.period === 'week' || msg.period === 'month' || msg.period === 'all') ? msg.period : 'today';
                        const agentId = typeof msg.agentId === 'string' ? msg.agentId : undefined;
                        const snap = buildBoard(getCompanyDir(), { period, agentId });
                        this._panel.webview.postMessage({ type: 'boardData', snapshot: snap, period, agentId: agentId || 'all' });
                    } catch (e: any) {
                        this._panel.webview.postMessage({ type: 'boardData', error: e?.message || String(e) });
                    }
                } else if (msg?.type === 'loadYouTubeLeads') {
                    /* 📺 YouTube 콜드 리드 패널 — alpha-agent-ai 의 youtubers.db 읽음.
                       sqlite3 CLI 로 호출 (추가 npm dep 없음). 발송 X — 표시만. */
                    try {
                        const home = require('os').homedir();
                        const dbPath = path.join(home, 'alpha-agent-ai', 'scripts', 'youtube-collector', 'youtubers.db');
                        if (!fs.existsSync(dbPath)) {
                            this._panel.webview.postMessage({ type: 'youtubeLeadsData', error: `DB 없음: ${dbPath} — collector.py 한 번도 실행 안 했거나 다른 경로 사용 중` });
                            return;
                        }
                        const filterCategory = typeof msg.category === 'string' && msg.category !== 'all' ? msg.category : null;
                        const onlyWithEmail = msg.onlyWithEmail === true;
                        const where: string[] = [];
                        if (filterCategory) where.push(`category = '${filterCategory.replace(/'/g, "''")}'`);
                        if (onlyWithEmail) where.push(`email IS NOT NULL AND email != ''`);
                        const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
                        const sql = `SELECT json_group_array(json_object('channel_id', channel_id, 'name', name, 'subscribers', subscribers, 'email', email, 'channel_url', channel_url, 'video_count', video_count, 'last_upload_date', last_upload_date, 'uploads_per_week', uploads_per_week, 'category', category, 'email_status', email_status, 'has_contact_hint', has_contact_hint, 'instagram_handle', instagram_handle, 'twitter_handle', twitter_handle, 'threads_handle', threads_handle, 'other_url', other_url, 'email_source', email_source, 'collected_at', collected_at)) FROM (SELECT * FROM youtubers ${whereClause} ORDER BY (CASE WHEN email IS NOT NULL AND email != '' THEN 0 WHEN instagram_handle IS NOT NULL OR twitter_handle IS NOT NULL OR threads_handle IS NOT NULL THEN 1 ELSE 2 END), (CASE WHEN has_contact_hint = 1 THEN 0 ELSE 1 END), subscribers DESC LIMIT 500)`;
                        /* 카테고리별 + 이메일 상태별 분포 카운트. 사장님이 "왜 이메일 없냐"
                           눈으로 보고: description 자체 없음 / 있는데 매칭 실패 / about reCAPTCHA 등 사유 구분. */
                        const sqlCounts = `SELECT json_group_array(json_object('category', COALESCE(category, '미분류'), 'total', total, 'with_email', with_email, 'with_hint_no_email', with_hint_no_email)) FROM (SELECT category, COUNT(*) as total, SUM(CASE WHEN email IS NOT NULL AND email != '' THEN 1 ELSE 0 END) as with_email, SUM(CASE WHEN has_contact_hint = 1 AND (email IS NULL OR email = '') THEN 1 ELSE 0 END) as with_hint_no_email FROM youtubers GROUP BY category ORDER BY total DESC)`;
                        const sqlStatus = `SELECT json_group_array(json_object('email_status', COALESCE(email_status, 'unknown'), 'count', count)) FROM (SELECT email_status, COUNT(*) as count FROM youtubers GROUP BY email_status ORDER BY count DESC)`;
                        const r = await new Promise<{ exitCode: number; rows: string; counts: string; status: string }>((resolve) => {
                            const cp = require('child_process');
                            const p = cp.spawn('sqlite3', ['-readonly', dbPath, sql, sqlCounts, sqlStatus]);
                            let buf = '';
                            p.stdout?.on('data', (d: Buffer) => { buf += d.toString(); });
                            p.on('close', (code: number) => {
                                const lines = buf.split('\n').filter(Boolean);
                                resolve({ exitCode: code ?? -1, rows: lines[0] || '[]', counts: lines[1] || '[]', status: lines[2] || '[]' });
                            });
                            setTimeout(() => { try { p.kill(); } catch {} resolve({ exitCode: -1, rows: '[]', counts: '[]', status: '[]' }); }, 8000);
                        });
                        if (r.exitCode !== 0) {
                            this._panel.webview.postMessage({ type: 'youtubeLeadsData', error: `sqlite3 호출 실패 (exit ${r.exitCode}) — sqlite3 CLI 설치 확인` });
                            return;
                        }
                        let rows: any[] = []; let counts: any[] = []; let statusDist: any[] = [];
                        try { rows = JSON.parse(r.rows); } catch { /* keep [] */ }
                        try { counts = JSON.parse(r.counts); } catch { /* keep [] */ }
                        try { statusDist = JSON.parse(r.status); } catch { /* keep [] */ }
                        this._panel.webview.postMessage({ type: 'youtubeLeadsData', rows, counts, statusDist, filters: { category: filterCategory || 'all', onlyWithEmail } });
                    } catch (e: any) {
                        this._panel.webview.postMessage({ type: 'youtubeLeadsData', error: e?.message || String(e) });
                    }
                } else if (msg?.type === 'openExternalUrl' && typeof msg.url === 'string') {
                    /* YouTube 채널 등 외부 URL — 기본 브라우저로 열기. webview 안의
                       a target=_blank 는 VS Code 정책상 안 열리는 케이스 많아서
                       명시적으로 openExternal 호출. */
                    try {
                        const u = String(msg.url).trim();
                        if (/^https?:\/\//i.test(u)) {
                            vscode.env.openExternal(vscode.Uri.parse(u));
                        }
                    } catch { /* ignore */ }
                } else if (msg?.type === 'openSessionFolder' && typeof msg.sessionDir === 'string') {
                    try { vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(msg.sessionDir)); } catch { /* ignore */ }
                } else if (msg?.type === 'openRevenueDashboard') {
                    /* v2.89.142 — 매출 카드 버튼 → 풀 대시보드 패널 띄움 */
                    RevenueDashboardPanel.createOrShow();
                } else if (msg?.type === 'askBezosRevenue') {
                    /* v2.89.146 — corporate dispatch 직접 호출. injectPrompt 는
                       bypassCorporate=true 라 shortcut 건너뛰는 버그 회피. */
                    try {
                        if (_activeChatProvider) {
                            const model = _activeChatProvider.getDefaultModel();
                            _activeChatProvider.runCorporatePromptExternal(
                                '베조스야, 이번 달 PayPal 매출 실데이터 가져와서 분석하고 다음 액션 1개 추천해줘.',
                                model
                            ).catch(() => { /* ignore */ });
                        }
                    } catch { /* ignore */ }
                } else if (msg?.type === 'requestRevenueMini') {
                    /* v2.89.142 — 회사 대시보드의 미니 매출 위젯 데이터 요청.
                       paypal_revenue.py OUTPUT=json 로 실행 → 응답을 webview 에 회신. */
                    try {
                        const ppToolDir = path.join(getCompanyDir(), '_agents', 'business', 'tools');
                        const ppScript = path.join(ppToolDir, 'paypal_revenue.py');
                        const ppJson = path.join(ppToolDir, 'paypal_revenue.json');
                        if (!fs.existsSync(ppScript) || !fs.existsSync(ppJson)) {
                            this._panel.webview.postMessage({ type: 'revenueMini', data: { error: 'PayPal 미설정 — 외부 연결 패널에서 입력하세요' } });
                            return;
                        }
                        const cfg = JSON.parse(_safeReadText(ppJson) || '{}');
                        if (!cfg.CLIENT_ID || !cfg.CLIENT_SECRET) {
                            this._panel.webview.postMessage({ type: 'revenueMini', data: null });
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
                            this._panel.webview.postMessage({ type: 'revenueMini', data: { error: 'PayPal 호출 실패 — 권한·자격증명 확인' } });
                            return;
                        }
                        let data: any;
                        try { data = JSON.parse(r.output); } catch {
                            this._panel.webview.postMessage({ type: 'revenueMini', data: { error: '응답 파싱 실패' } });
                            return;
                        }
                        this._panel.webview.postMessage({ type: 'revenueMini', data });
                    } catch (e: any) {
                        this._panel.webview.postMessage({ type: 'revenueMini', data: { error: e?.message || String(e) } });
                    }
                } else if (msg?.type === 'setAgentActive' && msg.agent) {
                    /* v2.89.107 — 활성/비활성 토글. PIN 안 받음 (한스짐머는 별도 hireAgent). */
                    const aid = String(msg.agent || '').trim();
                    const want = !!msg.active;
                    if (ALWAYS_ON_AGENTS.has(aid)) {
                        this._postToast(`⚠️ ${aid}는 핵심 에이전트라 비활성화할 수 없어요.`, true);
                    } else if (LOCKED_AGENTS_DEFAULT[aid] && want) {
                        /* 한스짐머 활성화는 PIN 통해서만 — 별도 핸들러 */
                        this._postToast(`🔒 ${aid}는 PIN 인증이 필요해요. 카드를 클릭하세요.`, true);
                    } else {
                        const ok = setAgentActive(aid, want);
                        if (ok) {
                            const verb = want ? '활성화됨' : '비활성화됨';
                            this._postToast(`✅ ${AGENTS[aid]?.emoji || ''} ${AGENTS[aid]?.name || aid} ${verb}`, false);
                            /* v2.89.112 — 개발신(developer) 첫 활성화 시 시니어 코더 모델 추천. */
                            if (want && aid === 'developer') {
                                _maybeRecommendCoderModel(this._panel.webview);
                            }
                            await this._sendState();
                            /* 사이드바도 동기화 */
                            try {
                                const sb = _activeChatProvider as any;
                                if (sb && sb._view) {
                                    sb._view.webview.postMessage({ type: 'activeAgents', value: readActiveAgents() });
                                    sb._view.webview.postMessage({ type: 'hiredAgents', value: readHiredAgents() });
                                }
                            } catch { /* ignore */ }
                        } else {
                            this._postToast(`⚠️ 변경 실패: 회사 폴더 쓰기 권한 확인.`, true);
                        }
                    }
                } else if (msg?.type === 'hireAgent' && msg.agent) {
                    /* v2.89.103 — PIN 통과 후 webview가 알림. PIN 자체는 sidebar와
                       동일하게 webview에서 검증(0000) — 백엔드는 영구 저장만 담당.
                       서버에서도 PIN 재검증해서 위변조 방지. */
                    const pin = String(msg.pin || '');
                    const aid = String(msg.agent || '').trim();
                    if (pin === '0000' && LOCKED_AGENTS_DEFAULT[aid]) {
                        const ok = markAgentHired(aid);
                        if (ok) {
                            this._postToast(`🎉 ${aid} 에이전트 채용 완료. 이제 활용 가능합니다.`, false);
                            try { vscode.window.showInformationMessage(`🎉 ${aid} 에이전트가 합류했어요!`); } catch { /* ignore */ }
                        } else {
                            this._postToast(`⚠️ 채용 실패: 회사 폴더에 쓰기 권한이 없습니다.`, true);
                        }
                        await this._sendState();
                    } else {
                        this._postToast(`❌ 인증 실패. 잘못된 코드입니다.`, true);
                    }
                } else if (msg?.type === 'queueComments') {
                    const r = await _youtubeCommentReplyDraftBatch({});
                    this._postToast(r.reason ? `⚠️ ${r.reason}` : `📺 ${r.drafted}건 큐 생성, ${r.skipped}건 스킵`, !!r.reason);
                    await this._sendState();
                } else if (msg?.type === 'connectOAuth') {
                    vscode.commands.executeCommand('agentOs.youtube.connectOAuth');
                } else if (msg?.type === 'addCompetitor' && msg.handleOrId) {
                    if (_ytDashboardProvider) {
                        /* Reuse the storage helpers on the sidebar provider — same source of truth. */
                        await (_ytDashboardProvider as any)._addCompetitor?.(msg.handleOrId);
                    }
                    await this._sendState();
                } else if (msg?.type === 'removeCompetitor' && msg.id) {
                    if (_ytDashboardProvider) {
                        await (_ytDashboardProvider as any)._removeCompetitor?.(msg.id);
                    }
                    await this._sendState();
                } else if (msg?.type === 'approve' && msg.id) {
                    const r = await resolveApproval(msg.id, 'approved');
                    this._postToast(r.message, !r.ok);
                    await this._sendState();
                } else if (msg?.type === 'approveAllPending') {
                    const r = await approveAllPendingApprovals('대시보드 일괄 승인');
                    this._postToast(`✅ 일괄 처리: 승인 ${r.approved}건 · 제외 ${r.skipped}건 · 실패 ${r.failed}건`, !r.ok);
                    await this._sendState();
                } else if (msg?.type === 'reject' && msg.id) {
                    const r = await resolveApproval(msg.id, 'rejected');
                    this._postToast(r.message, !r.ok);
                    await this._sendState();
                } else if (msg?.type === 'openApproval' && msg.id) {
                    try {
                        const ap = listPendingApprovals().find(a => a.id.endsWith(msg.id));
                        if (ap) {
                            const p = path.join(_approvalsPendingDir(), `${ap.id}.md`);
                            const doc = await vscode.workspace.openTextDocument(p);
                            vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
                        }
                    } catch { /* ignore */ }
                } else if (msg?.type === 'fireBriefing') {
                    await _runDailyBriefingOnce(true);
                    this._postToast('🌅 데일리 브리핑 발사 완료');
                } else if (msg?.type === 'getAgentModelRouting') {
                    /* v2.89.26 — 모델 라우팅 모달 데이터 송출. 설치된 모델 + 현재 매핑 */
                    try {
                        const installed = await listInstalledModels();
                        const map = readAgentModelMap();
                        const defaultModel = 'claude-sonnet-4-6';
                        const specs = getSystemSpecs();
                        const installedWithMem = installed.map(m => ({
                            ...m,
                            estMemGB: estimateModelMemoryGB(m.id),
                            safe: estimateModelMemoryGB(m.id) <= specs.safeModelBudgetGB,
                        }));
                        this._panel.webview.postMessage({
                            type: 'agentModelRoutingData',
                            installed: installedWithMem,
                            map,
                            defaultModel,
                            agents: AGENT_ORDER.map(id => ({ id, name: AGENTS[id]?.name || id, emoji: AGENTS[id]?.emoji || '🤖', role: AGENTS[id]?.role || '' })),
                            specs,
                        });
                    } catch (e: any) {
                        this._panel.webview.postMessage({ type: 'agentModelRoutingData', installed: [], map: {}, defaultModel: '', agents: [], error: e?.message || String(e) });
                    }
                } else if (msg?.type === 'getSystemSpecs') {
                    /* v2.89.36 — 트렌딩 모달이 사용자 머신 사양 받아서 모델 추천에 활용 */
                    try {
                        this._panel.webview.postMessage({ type: 'systemSpecsData', specs: getSystemSpecs() });
                    } catch (e: any) {
                        this._panel.webview.postMessage({ type: 'systemSpecsData', specs: null, error: e?.message || String(e) });
                    }
                } else if (msg?.type === 'fetchTrendingModels') {
                    /* v2.89.30 — HuggingFace API에서 인기 텍스트 LLM 조회.
                       객관적 데이터 (다운로드 수, 좋아요, 최신성) 기반 추천.
                       사용자가 어떤 모델이 진짜 인기 있는지 한눈에 파악. */
                    try {
                        const limit = Math.min(30, Math.max(5, Number(msg.limit) || 20));
                        const r = await axios.get('https://huggingface.co/api/models', {
                            params: {
                                pipeline_tag: 'text-generation',
                                sort: 'downloads',
                                direction: -1,
                                limit,
                                full: false,
                            },
                            timeout: 10000,
                            validateStatus: () => true,
                        });
                        if (r.status >= 200 && r.status < 300 && Array.isArray(r.data)) {
                            const models = r.data.map((m: any) => ({
                                id: m.id || m.modelId || '',
                                downloads: m.downloads || 0,
                                likes: m.likes || 0,
                                lastModified: m.lastModified || '',
                                tags: Array.isArray(m.tags) ? m.tags.slice(0, 8) : [],
                            })).filter((m: any) => m.id);
                            this._panel.webview.postMessage({ type: 'trendingModelsData', models });
                        } else {
                            this._panel.webview.postMessage({ type: 'trendingModelsData', models: [], error: `HF API ${r.status}` });
                        }
                    } catch (e: any) {
                        this._panel.webview.postMessage({ type: 'trendingModelsData', models: [], error: e?.message || String(e) });
                    }
                } else if (msg?.type === 'autoOrchestrateModels') {
                    /* v2.89.27 — "✨ 자동 추천" 버튼: 시스템이 알아서 매핑 계산 */
                    try {
                        const installed = await listInstalledModels();
                        const auto = _autoOrchestrateModelMap(installed);
                        this._panel.webview.postMessage({ type: 'agentModelRoutingAuto', map: auto });
                    } catch (e: any) {
                        this._panel.webview.postMessage({ type: 'agentModelRoutingAuto', map: {}, error: e?.message || String(e) });
                    }
                } else if (msg?.type === 'saveAgentModelRouting' && msg.map && typeof msg.map === 'object') {
                    /* 매핑 저장. 빈 문자열 키는 default 사용 의미 → 매핑에서 제거 */
                    try {
                        const cleaned: Record<string, string> = {};
                        for (const [k, v] of Object.entries(msg.map)) {
                            const sv = String(v || '').trim();
                            if (sv) cleaned[k] = sv;
                        }
                        writeAgentModelMap(cleaned);
                        this._postToast(`🧠 에이전트별 모델 라우팅 저장됨 (${Object.keys(cleaned).length}건)`);
                        this._panel.webview.postMessage({ type: 'agentModelRoutingSaved', ok: true });
                        /* v2.89.116 — 사이드바 dock도 같이 갱신 (양쪽이 항상 같은 진실) */
                        try { _activeChatProvider?.triggerAgentDockReload?.(); } catch { /* ignore */ }
                    } catch (e: any) {
                        this._panel.webview.postMessage({ type: 'agentModelRoutingSaved', ok: false, error: e?.message || String(e) });
                    }
                } else if (msg?.type === 'getReportSchedule') {
                    /* v2.89.24 — 보고 스케줄 UI 데이터 송출 */
                    try {
                        const sch = readReportSchedule();
                        this._panel.webview.postMessage({ type: 'reportScheduleData', entries: sch.entries });
                    } catch (e: any) {
                        this._panel.webview.postMessage({ type: 'reportScheduleData', entries: [], error: e?.message || String(e) });
                    }
                } else if (msg?.type === 'saveReportSchedule' && Array.isArray(msg.entries)) {
                    /* 사용자가 모달에서 저장 → 디스크 + 토스트 */
                    try {
                        writeReportSchedule({ entries: msg.entries });
                        this._postToast(`📆 보고 스케줄 ${msg.entries.length}건 저장됨`);
                        this._panel.webview.postMessage({ type: 'reportScheduleData', entries: msg.entries });
                    } catch (e: any) {
                        this._postToast(`⚠️ 스케줄 저장 실패: ${e?.message || e}`, true);
                    }
                } else if (msg?.type === 'saveSkillConfig' && typeof msg.agentId === 'string' && typeof msg.skillName === 'string') {
                    /* v2.89.17 — 인앱 도구 설정 저장. tool config는 도구 자체 .json,
                       shared는 youtube_account.json 같은 공유 파일에 저장. */
                    try {
                        const updates = msg.updates || {};
                        const toolDir = path.join(getCompanyDir(), '_agents', msg.agentId, 'tools');
                        /* 도구 자체 config */
                        if (updates.tool && Object.keys(updates.tool).length > 0) {
                            const toolJsonPath = path.join(toolDir, `${msg.skillName}.json`);
                            let cur: Record<string, any> = {};
                            try {
                                if (fs.existsSync(toolJsonPath)) cur = JSON.parse(fs.readFileSync(toolJsonPath, 'utf-8') || '{}');
                            } catch { /* malformed */ }
                            for (const [k, v] of Object.entries(updates.tool)) {
                                cur[k] = v;
                            }
                            fs.writeFileSync(toolJsonPath, JSON.stringify(cur, null, 2));
                        }
                        /* 공유 config (현재는 youtube 한정) */
                        if (updates.shared && Object.keys(updates.shared).length > 0 && msg.agentId === 'youtube') {
                            const sharedPath = path.join(toolDir, 'youtube_account.json');
                            let cur: Record<string, any> = {};
                            try {
                                if (fs.existsSync(sharedPath)) cur = JSON.parse(fs.readFileSync(sharedPath, 'utf-8') || '{}');
                            } catch { /* malformed */ }
                            for (const [k, v] of Object.entries(updates.shared)) {
                                cur[k] = v;
                            }
                            fs.writeFileSync(sharedPath, JSON.stringify(cur, null, 2));
                        }
                        this._postToast(`💾 ${msg.skillName} 설정 저장됨`);
                        await this._sendState();
                        /* 모달에 "저장 완료" 알림 */
                        this._panel.webview.postMessage({ type: 'skillConfigSaved', skillName: msg.skillName, ok: true });
                    } catch (e: any) {
                        this._panel.webview.postMessage({ type: 'skillConfigSaved', skillName: msg.skillName, ok: false, error: e?.message || String(e) });
                    }
                } else if (msg?.type === 'runSingleSkill' && typeof msg.agentId === 'string' && typeof msg.skillName === 'string') {
                    /* v2.89.12 — 단독 스킬 실행. 사용자가 에이전트 모달에서 스킬
                       타일 클릭 → ▶ 실행 누르면 그 도구만 spawn해서 stdout 캡처
                       후 모달에 라이브 표시. */
                    try {
                        const tools = listAgentTools(msg.agentId);
                        const tool = tools.find(t => t.name === msg.skillName);
                        if (!tool) {
                            this._panel.webview.postMessage({ type: 'skillRunOutput', ok: false, output: `⚠️ 스킬 못 찾음: ${msg.skillName}` });
                        } else {
                            const scriptPath = tool.scriptPath;
                            const cwd = path.dirname(scriptPath);
                            const cmd = `${_pythonCmd()} ${JSON.stringify(path.basename(scriptPath))}`;
                            const r = await runCommandCaptured(cmd, cwd, () => { /* silent */ }, 90000);
                            this._panel.webview.postMessage({
                                type: 'skillRunOutput',
                                ok: r.exitCode === 0,
                                output: (r.output || '').slice(-8000),
                                exitCode: r.exitCode,
                                timedOut: r.timedOut,
                            });
                        }
                    } catch (e: any) {
                        this._panel.webview.postMessage({ type: 'skillRunOutput', ok: false, output: `⚠️ 실행 에러: ${e?.message || e}` });
                    }
                } else if (msg?.type === 'cancelTask' && typeof msg.id === 'string') {
                    /* v2.88.4 — 멈춘 작업 정리. shortId(마지막 9자리)로 매칭 후
                       status='cancelled' + evidence 기록. */
                    try {
                        const all = readTracker().tasks;
                        const target = all.find(t => t.id.endsWith(msg.id)) || all.find(t => t.id === msg.id);
                        if (!target) {
                            this._postToast(`⚠️ 작업을 못 찾았어요 (id: ${msg.id})`, true);
                        } else {
                            updateTrackerTask(target.id, { status: 'cancelled', evidence: '대시보드에서 사용자 취소' });
                            this._postToast(`✖️ 취소됨: ${target.title.slice(0, 40)}`);
                            await this._sendState();
                        }
                    } catch (e: any) {
                        this._postToast(`⚠️ 취소 실패: ${e?.message || e}`, true);
                    }
                } else if (msg?.type === 'boardAbortEntry' && typeof msg.id === 'string') {
                    /* 업무 보드 카드 중단 — id 가 `tracker:...` 면 cancelled, `session:...`
                       이면 state.json 의 status=aborted 로 마킹. aborted 카드는 ✅완료
                       열에 grey badge 로 남음 (기록 보존). 영구 제거는 🗑 삭제 액션. */
                    let ok = false;
                    try {
                        const id = String(msg.id);
                        if (id.startsWith('tracker:')) {
                            const taskId = id.slice('tracker:'.length);
                            const target = readTracker().tasks.find(t => t.id === taskId);
                            if (!target) {
                                this._postToast(`⚠️ 작업을 못 찾았어요 (tracker)`, true);
                            } else {
                                updateTrackerTask(target.id, { status: 'cancelled', evidence: '대시보드 보드에서 중단' });
                                this._postToast(`⏹ 중단됨: ${target.title.slice(0, 40)}`);
                                ok = true;
                            }
                        } else if (id.startsWith('session:')) {
                            const sessionDir = typeof msg.sessionDir === 'string' ? msg.sessionDir : '';
                            if (!sessionDir) {
                                this._postToast(`⚠️ session 경로 누락 — 카드 데이터 새로고침 후 다시 시도`, true);
                            } else {
                                const { markSessionAborted } = await import('../dispatch/session-state');
                                const stateFile = path.join(sessionDir, 'state.json');
                                if (!fs.existsSync(stateFile)) {
                                    this._postToast(`⚠️ 세션 state.json 이 없어요: ${sessionDir}`, true);
                                } else {
                                    markSessionAborted(stateFile, '대시보드 보드에서 사용자 중단');
                                    this._postToast(`⏹ 세션 중단됨`);
                                    ok = true;
                                }
                            }
                        } else {
                            this._postToast(`⚠️ 잘못된 보드 항목 id: ${id}`, true);
                        }
                    } catch (e: any) {
                        this._postToast(`⚠️ 중단 실패: ${e?.message || e}`, true);
                    }
                    if (ok) {
                        try { this._panel.webview.postMessage({ type: 'boardReloadHint' }); } catch { /* ignore */ }
                    }
                } else if (msg?.type === 'boardDeleteEntry' && typeof msg.id === 'string') {
                    /* 업무 보드 카드 삭제 — tracker 는 tracker.json 에서 entry 제거,
                       session 은 sessions/{id} 폴더 통째 삭제 (state.json + 출력 로그
                       전부). 카드 1장이 sessionId 1개에 매칭 — 같은 session 의 다른
                       agent 카드도 함께 사라짐 (1세션 = 1폴더). */
                    let ok = false;
                    try {
                        const id = String(msg.id);
                        const sessionDirFromMsg = typeof msg.sessionDir === 'string' ? msg.sessionDir : '';
                        try {
                            const { hideBoardEntry } = await import('../dispatch/agent-board');
                            hideBoardEntry(getCompanyDir(), { id, sessionDir: sessionDirFromMsg || undefined });
                        } catch { /* tombstone best-effort — physical delete still attempted */ }
                        if (id.startsWith('tracker:')) {
                            const taskId = id.slice('tracker:'.length);
                            const { writeTracker } = await import('../tracker/io');
                            const trk = readTracker();
                            const before = trk.tasks.length;
                            const nextTasks = trk.tasks.filter(t => t.id !== taskId);
                            if (nextTasks.length === before) {
                                this._postToast(`⚠️ 작업을 못 찾았어요 (tracker)`, true);
                            } else {
                                writeTracker(getCompanyDir(), { tasks: nextTasks });
                                this._postToast(`🗑 삭제됨`);
                                ok = true;
                            }
                        } else if (id.startsWith('session:')) {
                            const sessionDir = sessionDirFromMsg;
                            if (!sessionDir) {
                                this._postToast(`🗑 보드에서 숨김 처리됨`);
                                ok = true;
                            } else {
                                const sessionsRoot = path.join(getCompanyDir(), 'sessions');
                                /* 안전장치: sessionDir 가 정확히 sessions/ 아래여야 삭제. */
                                const resolved = path.resolve(sessionDir);
                                const resolvedRoot = path.resolve(sessionsRoot);
                                if (!resolved.startsWith(resolvedRoot + path.sep)) {
                                    this._postToast(`🗑 보드에서 숨김 처리됨 (세션 폴더는 안전상 보존)`);
                                    ok = true;
                                } else if (!fs.existsSync(resolved)) {
                                    this._postToast(`⚠️ 세션 폴더가 이미 없어요: ${path.basename(resolved)}`, true);
                                    /* 이미 없으면 board 에서도 없어야 하니까 refresh 트리거 */
                                    ok = true;
                                } else {
                                    fs.rmSync(resolved, { recursive: true, force: true });
                                    this._postToast(`🗑 세션 삭제됨: ${path.basename(resolved)}`);
                                    ok = true;
                                }
                            }
                        } else {
                            this._postToast(`⚠️ 잘못된 보드 항목 id: ${id}`, true);
                        }
                    } catch (e: any) {
                        this._postToast(`⚠️ 삭제 실패: ${e?.message || e}`, true);
                    }
                    if (ok) {
                        try { this._panel.webview.postMessage({ type: 'boardReloadHint' }); } catch { /* ignore */ }
                    }
                } else if (msg?.type === 'setAgentRagMode' && typeof msg.agentId === 'string') {
                    /* v2.87.9 — 대시보드 모달의 자가검증 토글에서 호출. mode는
                       'self-rag' 또는 'standard'. 디스크 갱신 후 state 새로고침 →
                       모달 칩이 자동 동기화됨. */
                    try {
                        const mode = msg.mode === 'self-rag' ? 'self-rag' : 'standard';
                        writeAgentRagMode(msg.agentId, mode);
                        const a = AGENTS[msg.agentId];
                        const label = mode === 'self-rag' ? '🧠 자가검증 ON' : '🧠 자가검증 OFF';
                        this._postToast(`${a?.name || msg.agentId}: ${label}`);
                        await this._sendState();
                    } catch (e: any) {
                        this._postToast(`⚠️ 자가검증 모드 변경 실패: ${e?.message || e}`, true);
                    }
                } else if (msg?.type === 'openAgentFolder' && typeof msg.agentId === 'string') {
                    /* v2.87.6 — 대시보드 팀 카드 클릭 → 에이전트 폴더 OS 탐색기에서
                       열기. _agents/<id>/ 안에 지식·스킬·메모리·세션 다 있어서
                       그게 "에이전트 들여다보기"의 정직한 출구. VS Code 사이드바
                       에서도 같은 폴더가 열림. */
                    try {
                        const folderPath = path.join(getCompanyDir(), '_agents', msg.agentId);
                        if (!fs.existsSync(folderPath)) {
                            this._postToast(`⚠️ ${msg.agentId} 폴더를 찾을 수 없어요`, true);
                        } else {
                            const uri = vscode.Uri.file(folderPath);
                            vscode.commands.executeCommand('revealFileInOS', uri);
                            this._postToast(`📁 ${msg.agentId} 폴더 열기`);
                        }
                    } catch (e: any) {
                        this._postToast(`⚠️ 폴더 열기 실패: ${e?.message || e}`, true);
                    }
                }
            } catch (e: any) {
                this._postToast(`⚠️ ${e?.message || e}`, true);
            }
        }, null, this._disposables);
        /* Reactive refresh — when tracker writes happen we want to update KPIs. */
        this._disposables.push(onTrackerChanged(() => this._sendState().catch(() => {})));
        /* Periodic light refresh for time-based UI (countdowns) and remote state. */
        this._refreshTimer = setInterval(() => this._sendState().catch(() => {}), 30 * 1000);
        this._sendState().catch(() => { /* ignore boot */ });
    }

    public refresh() { this._sendState().catch(() => {}); }

    private _postToast(text: string, err = false) {
        try { this._panel.webview.postMessage({ type: 'toast', text, err }); } catch { /* ignore */ }
    }

    private _loadCfg(): { apiKey: string; channelId: string } {
        const cfgPath = path.join(getCompanyDir(), '_agents', 'youtube', 'config.md');
        const txt = _safeReadText(cfgPath);
        const apiM = txt.match(/YOUTUBE_API_KEY\s*[:：=]\s*([A-Za-z0-9_\-]+)/);
        const chM  = txt.match(/YOUTUBE_CHANNEL_ID\s*[:：=]\s*([A-Za-z0-9_\-]+)/);
        return { apiKey: apiM ? apiM[1] : '', channelId: chM ? chM[1] : '' };
    }

    private async _sendState() {
        const cfg = this._loadCfg();
        const oauthConnected = isYoutubeOAuthConnected();
        const company = readCompanyName() || '1인 기업';
        const tracker = readTracker().tasks;
        const openTasks = tracker.filter(t => t.status !== 'done' && t.status !== 'cancelled');
        const overdueTasks = openTasks.filter(t => t.dueAt && new Date(t.dueAt).getTime() < Date.now()).length;
        const urgentTasks = openTasks.filter(t => _coercePriority(t.priority) === 'urgent').length;
        const pendingApprovals = listPendingApprovals();

        let yt: any = { configured: false };
        if (cfg.apiKey && cfg.channelId) {
            try {
                const my = await this._fetchChannelSummary(cfg.channelId, cfg.apiKey);
                if (my) {
                    const myVideos = await this._fetchRecentVideos(my.uploadsPlaylist, cfg.apiKey, 6);
                    const totalViews = myVideos.reduce((s: number, v: any) => s + v.views, 0);
                    const totalEng   = myVideos.reduce((s: number, v: any) => s + v.likes + v.comments, 0);
                    const engagementPct = totalViews > 0 ? ((totalEng / totalViews) * 100).toFixed(2) : '0.00';
                    let competitors: any[] = [];
                    const compIds = this._readCompetitors().slice(0, 6);
                    for (const cid of compIds) {
                        const c = await this._fetchChannelSummary(cid, cfg.apiKey);
                        if (c) competitors.push(c);
                    }
                    let analytics: any = null;
                    if (oauthConnected) {
                        try { analytics = await fetchYouTubeAnalyticsSummary(); } catch {}
                    }
                    yt = { configured: true, my, myVideos, engagementPct, competitors, analytics };
                }
            } catch { /* keep yt.configured=false */ }
        }

        const conversationsToday = (() => {
            try {
                const today = new Date().toISOString().slice(0, 10);
                const txt = _safeReadText(path.join(getConversationsDir(), `${today}.md`));
                return txt.split('\n').filter(l => l.startsWith('## [')).length;
            } catch { return 0; }
        })();

        const recentLog = readRecentConversations(2400)
            .replace(/^\[최근 회사 대화 요약 \(참고용\)\]\n/, '')
            .trim();

        /* Build agent team section — one card per agent with persona + open
           task count + autonomy level + most recent memory line + custom
           profile photo when available (프로필 이미지 제공 에이전트). The photo URI is resolved
           through the panel's webview so the asset is reachable from the
           sandboxed iframe. */
        const agentTeam = AGENT_ORDER.map(id => {
            const a = AGENTS[id];
            if (!a) return null;
            const myTasks = openTasks.filter(t => Array.isArray(t.agentIds) && t.agentIds.includes(id));
            let lastActivity = '';
            try {
                const memTxt = _safeReadText(path.join(getCompanyDir(), '_agents', id, 'memory.md'));
                const lines = memTxt.split('\n').map(l => l.trim()).filter(l => /^\s*-\s*\[/.test(l) || (l.length > 4 && !l.startsWith('#') && !l.startsWith('_')));
                lastActivity = lines.length > 0 ? lines[lines.length - 1].slice(0, 120) : '';
            } catch { /* ignore */ }
            let profileImageUri = '';
            try {
                if (a.profileImage && _dashboardExtensionUri) {
                    const p = vscode.Uri.joinPath(_dashboardExtensionUri, 'assets', 'agents', a.profileImage);
                    if (fs.existsSync(p.fsPath)) {
                        profileImageUri = this._panel.webview.asWebviewUri(p).toString();
                    }
                }
            } catch { /* ignore */ }
            const lvl = readToolAutonomyLevel(id);
            /* v2.87.7 — Pre-load lightweight skill list + verified count so the
               in-dashboard agent detail modal can render instantly without a
               second round-trip. Each skill = emoji + name (truncated). */
            /* v2.89.12 — `name` 은 백엔드에서 listAgentTools 매칭에 쓰이는 진짜
               tool name (예: "my_videos_check"), `label` 은 사용자한테 보일 짧은
               이름. description은 모달 상세에서 보여줌. */
            let skills: Array<{ name: string; label: string; emoji: string; enabled: boolean; locked: boolean; description: string; config?: any; sharedConfigName?: string; sharedConfig?: any }> = [];
            try {
                /* v2.89.20 — 비기술자 사용자한테 너무 복잡한 도구들 숨김. 기본
                   화면엔 "한 번 클릭으로 끝나는" 도구만 노출. 고급 분석(경쟁
                   채널 비교, 트렌드 스나이퍼 등)은 별도 섹션 또는 미래 빌드에서.
                   숨겨진 도구도 폴더엔 그대로 있어서 직접 실행은 가능함. */
                const HIDDEN_TOOLS_BY_AGENT: Record<string, string[]> = {
                    youtube: [
                        'youtube_account',     /* 설정 허브 — 외부 연결 패널과 중복 */
                        'competitor_brief',    /* COMPETITOR_CHANNELS 추가 입력 필요 — 고급 */
                        'trend_sniper',        /* WATCHED_CHANNELS 추가 입력 필요 — 고급 */
                        'comment_harvester',   /* WATCHED_CHANNELS 추가 입력 필요 — 고급 */
                        'telegram_notify',     /* 인프라 — 다른 도구가 자동 사용 */
                    ],
                    secretary: [
                        'telegram_setup',      /* 외부 연결 패널과 중복 */
                        'google_calendar',     /* iCal 읽기 전용 — google_calendar_write 가 풀 기능 */
                    ],
                };
                const hidden = HIDDEN_TOOLS_BY_AGENT[id] || [];
                const tools = listAgentTools(id).filter(t => !hidden.includes(t.name));
                /* v2.89.17 — 도구의 자체 config (예: COMPETITOR_CHANNELS) + 공유 설정
                   (youtube_account.json 같은 다른 도구들이 같이 쓰는 파일)을 모두
                   webview로 보내서 인앱 폼으로 편집 가능하게. */
                let sharedYouTube: any = null;
                if (id === 'youtube') {
                    try {
                        const sharedPath = path.join(getCompanyDir(), '_agents', 'youtube', 'tools', 'youtube_account.json');
                        if (fs.existsSync(sharedPath)) {
                            sharedYouTube = JSON.parse(fs.readFileSync(sharedPath, 'utf-8') || '{}');
                        }
                    } catch { /* malformed — ignore */ }
                }
                skills = tools.map(t => {
                    const dn = t.displayName || t.name;
                    const m = dn.match(/^([\p{Extended_Pictographic}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}])/u);
                    const emoji = m ? m[1] : '🛠️';
                    const cleanName = dn.replace(/^[\p{Extended_Pictographic}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\s*/u, '').slice(0, 18);
                    const schema = (t as any).configSchema || [];
                    const locked = schema.some((f: any) => f.type === 'password' && (!f.value || String(f.value).trim() === ''));
                    /* 도구 자체 config — 메타 키(_) 제외, 사용자가 편집할 수 있는 키만.
                       v2.89.81 — _schema는 통과시켜서 폼이 hint·label 렌더에 사용. */
                    const cleanConfig: Record<string, any> = {};
                    for (const [k, v] of Object.entries(t.config || {})) {
                        if (k.startsWith('_') && k !== '_schema') continue;
                        cleanConfig[k] = v;
                    }
                    /* YouTube 도구들은 youtube_account.json도 같이 쓰니까 일부 키가 거기서
                       오는지 표시. 사용자가 그 키를 편집하면 자동으로 그 파일에 저장. */
                    let sharedConfigName: string | undefined;
                    let sharedConfig: any;
                    if (id === 'youtube' && t.name !== 'youtube_account' && sharedYouTube) {
                        sharedConfigName = 'youtube_account.json';
                        sharedConfig = sharedYouTube;
                    }
                    return {
                        name: t.name,
                        label: cleanName,
                        emoji,
                        enabled: t.enabled !== false,
                        locked,
                        description: (t.description || '').slice(0, 280),
                        config: cleanConfig,
                        sharedConfigName,
                        sharedConfig,
                    };
                });
            } catch { /* tools may not be seeded yet */ }
            const verifiedCount = countAgentVerifiedClaims(id);
            const ragMode = readAgentRagMode(id);
            const selfRagCriteria = readAgentSelfRagCriteria(id);
            return {
                id,
                name: a.name,
                role: a.role,
                emoji: a.emoji,
                color: a.color,
                specialty: a.specialty,
                tagline: a.tagline || '',
                openTasks: myTasks.length,
                autonomy: lvl,
                autonomyLabel: AUTONOMY_LABELS[lvl] || 'Off',
                lastActivity,
                profileImageUri,
                skills,
                verifiedCount,
                ragMode,
                selfRagCriteria,
                /* v2.89.103 — 채용 락 시스템. hired=false 면 잠금 카드로 렌더,
                   클릭 시 PIN 모달 → 0000 통과해야 활성화. 잠금 대상 아닌 에이전트는
                   항상 hired=true. */
                hired: isAgentHired(id),
                lockable: !!LOCKED_AGENTS_DEFAULT[id],
                /* v2.89.107 — 활성/비활성 토글 시스템. active=false 면 비활성 카드 (페이드).
                   클릭 시 간단 confirm → active=true. CEO는 항상 활성. */
                active: isAgentActive(id),
                togglable: isAgentTogglable(id),
                alwaysOn: ALWAYS_ON_AGENTS.has(id),
                optional: OPTIONAL_AGENTS_DEFAULT.has(id),
            };
        }).filter(Boolean);
        const totalAgents = agentTeam.length;
        const hiredCount = (agentTeam as any[]).filter(a => a && a.hired).length;
        const activeCount = (agentTeam as any[]).filter(a => a && a.active).length;

        try {
            this._panel.webview.postMessage({
                type: 'state',
                company,
                oauthConnected,
                yt,
                agentTeam,
                hiredCount,
                totalAgents,
                activeCount,
                tasks: {
                    open: openTasks.length,
                    overdue: overdueTasks,
                    urgent: urgentTasks,
                    top: openTasks
                        .sort((a, b) => TASK_PRIORITY_ORDER[_coercePriority(a.priority)] - TASK_PRIORITY_ORDER[_coercePriority(b.priority)])
                        .slice(0, 6)
                        .map(t => ({
                            id: t.id, shortId: t.id.slice(-9),
                            title: t.title,
                            priority: _coercePriority(t.priority),
                            owner: t.owner,
                            agentEmoji: t.agentIds && t.agentIds[0] ? (AGENTS[t.agentIds[0]]?.emoji || '🤖') : (t.owner === 'user' ? '👤' : '🤖'),
                            dueAt: t.dueAt || '',
                            dueLabel: t.dueAt ? _formatDueLabel(t.dueAt) : '',
                            recurrence: t.recurrence || '',
                            status: t.status,
                        })),
                },
                approvals: pendingApprovals.map(a => {
                    const ag = AGENTS[a.agentId];
                    return {
                        id: a.id, shortId: a.id.slice(-9),
                        emoji: ag?.emoji || '🤖',
                        agent: ag?.name || a.agentId,
                        kind: a.kind,
                        title: a.title,
                        summary: a.summary,
                        createdAt: a.createdAt,
                    };
                }),
                conversationsToday,
                recentLog: recentLog.slice(-1500),
                briefingTime: vscode.workspace.getConfiguration('agentOs').get<string>('dailyBriefingTime') || '09:00',
            });
        } catch { /* panel disposed */ }
    }

    private async _fetchChannelSummary(channelId: string, apiKey: string): Promise<any | null> {
        try {
            const r = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
                params: { part: 'snippet,statistics,contentDetails', id: channelId, key: apiKey },
                timeout: 10000,
            });
            const it = r.data?.items?.[0];
            if (!it) return null;
            return {
                id: channelId,
                title: it.snippet?.title || '',
                desc: (it.snippet?.description || '').slice(0, 240),
                thumb: it.snippet?.thumbnails?.high?.url || it.snippet?.thumbnails?.default?.url || '',
                subs: parseInt(it.statistics?.subscriberCount || '0', 10),
                views: parseInt(it.statistics?.viewCount || '0', 10),
                videos: parseInt(it.statistics?.videoCount || '0', 10),
                uploadsPlaylist: it.contentDetails?.relatedPlaylists?.uploads || '',
            };
        } catch { return null; }
    }

    private async _fetchRecentVideos(playlistId: string, apiKey: string, max = 6): Promise<any[]> {
        if (!playlistId) return [];
        try {
            const r = await axios.get('https://www.googleapis.com/youtube/v3/playlistItems', {
                params: { part: 'contentDetails', playlistId, maxResults: max, key: apiKey },
                timeout: 10000,
            });
            const ids = (r.data?.items || []).map((x: any) => x.contentDetails?.videoId).filter(Boolean);
            if (ids.length === 0) return [];
            const stats = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
                params: { part: 'snippet,statistics,contentDetails', id: ids.join(','), key: apiKey },
                timeout: 10000,
            });
            return (stats.data?.items || []).map((it: any) => ({
                id: it.id,
                title: it.snippet?.title || '',
                thumb: it.snippet?.thumbnails?.high?.url || it.snippet?.thumbnails?.medium?.url || it.snippet?.thumbnails?.default?.url || '',
                views: parseInt(it.statistics?.viewCount || '0', 10),
                likes: parseInt(it.statistics?.likeCount || '0', 10),
                comments: parseInt(it.statistics?.commentCount || '0', 10),
                publishedAt: it.snippet?.publishedAt || '',
            }));
        } catch { return []; }
    }

    private _readCompetitors(): string[] {
        try {
            const p = path.join(getCompanyDir(), '_agents', 'youtube', 'competitors.json');
            const txt = _safeReadText(p);
            const arr = JSON.parse(txt || '[]');
            return Array.isArray(arr) ? arr.filter(x => typeof x === 'string') : [];
        } catch { return []; }
    }

    private _dispose() {
        CompanyDashboardPanel.current = null;
        try { require('./panel-registry').markClosed('company-dashboard'); } catch { /* ignore */ }
        if (this._refreshTimer) { clearInterval(this._refreshTimer); this._refreshTimer = null; }
        while (this._disposables.length) {
            const d = this._disposables.pop();
            try { d?.dispose(); } catch {}
        }
        try { this._panel.dispose(); } catch {}
    }

    private _html(): string {
        return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${_loadWebviewAsset('dashboard.css')}</style>
</head><body>
<canvas id="bgCanvas"></canvas>
<header class="hero">
  <div class="hero-inner">
    <div class="hero-brand">
      <div class="logo-mark">
        <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="16" cy="16" r="14" stroke="currentColor" stroke-width="1.5"/>
          <circle cx="16" cy="16" r="8"  stroke="currentColor" stroke-width="1.5"/>
          <circle cx="16" cy="16" r="2.5" fill="currentColor"/>
          <path d="M16 2 L16 30 M2 16 L30 16" stroke="currentColor" stroke-width="0.7" stroke-dasharray="2 3"/>
        </svg>
      </div>
      <div>
        <div class="hero-eyebrow">AGENT OS AI · 에이전트 업무 대시보드</div>
        <div class="hero-title" id="companyName">불러오는 중…</div>
        <div class="hero-meta">
          <span class="meta-pill" id="todayLabel"></span>
          <span class="meta-pill"><span class="dot live"></span> <span id="convCount">0</span>건 대화</span>
          <span class="meta-pill" id="briefPill">🌅 매일 09:00</span>
        </div>
      </div>
    </div>
    <div class="hero-actions">
      <button class="btn ghost" id="briefBtn" title="회사 전체 상태·진행 작업·이슈 즉시 점검">시스템 진단</button>
      <button class="btn ghost" id="scheduleBtn" title="정해진 시각·요일에 시스템이 자동 보고">리포트 자동화</button>
      <button class="btn ghost" id="modelsBtn" title="각 에이전트마다 최적 LLM 자동 분배·실행">모델 오케스트레이션</button>
      <button class="btn ghost" id="refreshBtn" title="동기화">↻</button>
    </div>
  </div>
</header>

<main class="grid">
  <!-- v2.86 layout — agent team is the hero (사용자가 가장 보고 싶어하는 것).
       Below that: today (tasks + approvals merged), then YouTube + Analytics
       only when the channel is connected. Card count: 9 → 4 (or 6 with YT). -->

  <!-- 📋 업무 보드 — 에이전트별·기간별 칸반/테이블. tracker + sessions 자동 집계. -->
  <section class="card span-12 board-card" id="boardCard">
    <div class="card-head">
      <div class="card-title"><span class="title-icon">📋</span> 업무 보드</div>
      <div class="board-toolbar">
        <span class="board-counts" id="boardCounts"></span>
        <select id="boardAgent" class="board-select" title="에이전트 필터">
          <option value="all">전체 에이전트</option>
        </select>
        <div class="board-period seg-group" role="tablist">
          <button class="seg active" data-period="today">오늘</button>
          <button class="seg" data-period="week">7일</button>
          <button class="seg" data-period="month">30일</button>
          <button class="seg" data-period="all">전체</button>
        </div>
        <div class="board-view seg-group" role="tablist">
          <button class="seg active" data-view="kanban" title="3 column 칸반">▦ 칸반</button>
          <button class="seg" data-view="table" title="표 형태">≣ 표</button>
        </div>
        <button class="btn ghost" id="boardRefresh" title="다시 집계">↻</button>
      </div>
    </div>
    <div class="board-body" id="boardBody">
      <div class="board-loading">불러오는 중…</div>
    </div>
  </section>

  <!-- 📺 YouTube 콜드 리드 — alpha-agent-ai/youtubers.db. 발송 X, 표시·복사만.
       사장님 정책: 콜드메일 자동 발송 금지. 사이트 배포 전 테스트 단계라 발송 사고 절대 X. -->
  <section class="card span-12" id="ytLeadsCard">
    <div class="card-head">
      <div class="card-title"><span class="title-icon">📺</span> YouTube 콜드 리드 <span class="badge" id="ytLeadsBadge">—</span></div>
      <div class="board-toolbar">
        <span class="board-counts" id="ytLeadsCounts" style="font-size:11px;color:rgba(255,255,255,.6)"></span>
        <select id="ytLeadsCategory" class="board-select" title="카테고리 필터">
          <option value="all">전체 카테고리</option>
        </select>
        <div class="board-view seg-group" role="tablist">
          <button class="seg active" data-yt-email="all" title="모든 채널">전체</button>
          <button class="seg" data-yt-email="only" title="이메일 확보 채널만">📧 이메일</button>
        </div>
        <button class="btn ghost" id="ytLeadsRefresh" title="다시 집계">↻</button>
      </div>
    </div>
    <div class="board-body" id="ytLeadsBody">
      <div class="board-loading">DB 읽는 중…</div>
    </div>
    <div style="padding:8px 16px 14px;font-size:11px;color:rgba(255,255,255,.5);border-top:1px solid rgba(255,255,255,.06)">
      ⚠️ 발송 금지 모드 — 이메일은 <b>📋 복사</b> 만 가능. 콜드메일은 사장님 검토 후 수동 발송.
    </div>
  </section>

  <!-- 1) 우리 팀 — hero. v2.89.108: 상태 필터 + 범례 추가. -->
  <section class="card span-12 hero-team" id="teamCard">
    <div class="card-head">
      <div class="card-title"><span class="title-icon">👥</span> 에이전트 매트릭스</div>
      <span class="badge" id="teamBadge">10명</span>
    </div>
    <div class="team-legend">
      <span class="tl-chip tl-active" data-filter="all">전체 <span class="tl-count" id="tlAll">0</span></span>
      <span class="tl-chip" data-filter="online" title="활성 — CEO가 호출 가능"><span class="tl-dot tl-dot-on"></span>활성 <span class="tl-count" id="tlOn">0</span></span>
      <span class="tl-chip" data-filter="optional" title="OPT-IN 비활성 — 카드 클릭해서 활성화"><span class="tl-dot tl-dot-opt"></span>옵션 <span class="tl-count" id="tlOpt">0</span></span>
      <span class="tl-chip" data-filter="locked" title="채용 PIN 필요"><span class="tl-dot tl-dot-lock"></span>채용 대기 <span class="tl-count" id="tlLock">0</span></span>
    </div>
    <div class="team-grid" id="teamBody"></div>
  </section>

  <!-- v2.89.142 — 매출 카드. 회사 대시보드 메인 진입점.
       클릭하면 풀 매출 대시보드 패널 (매트릭스 풍) 열림. -->
  <section class="card span-12 revenue-card" id="revenueCard">
    <div class="rev-glyph-rain" aria-hidden="true"></div>
    <div class="rev-inner">
      <div class="rev-left">
        <div class="rev-eyebrow">REVENUE COMMAND CENTER · <span class="rev-live"><span class="rev-pulse"></span> LIVE</span></div>
        <div class="rev-title">💰 매출 컨트롤 센터</div>
        <div class="rev-sub" id="revSubtitle">PayPal 연결을 확인하는 중…</div>
      </div>
      <div class="rev-kpis" id="revKpis">
        <div class="rev-kpi rev-skeleton"><div class="rev-kpi-l">이번 달</div><div class="rev-kpi-v" id="revMonth">—</div></div>
        <div class="rev-kpi rev-skeleton"><div class="rev-kpi-l">7일</div><div class="rev-kpi-v" id="revWeek">—</div></div>
        <div class="rev-kpi rev-skeleton"><div class="rev-kpi-l">거래</div><div class="rev-kpi-v" id="revCount">—</div></div>
      </div>
      <div class="rev-spark">
        <svg id="revSparkSvg" viewBox="0 0 280 60" preserveAspectRatio="none"></svg>
      </div>
      <div class="rev-actions">
        <button class="rev-btn primary" id="openRevDashBtn">
          <span class="rev-btn-glow"></span>
          <span>풀스크린 매출 대시보드</span>
          <span class="rev-btn-arrow">→</span>
        </button>
        <button class="rev-btn ghost" id="askBezosBtn" title="제프베조스 에이전트에게 매출 분석 요청">🧠 제프베조스에게 분석 의뢰</button>
      </div>
    </div>
  </section>

  <!-- 2) 오늘의 일 — open tasks (left) + approvals (right). Compact. -->
  <section class="card span-7" id="tasksCard">
    <div class="card-head">
      <div class="card-title"><span class="title-icon">⚡</span> 액티브 워크로드</div>
      <span class="badge" id="taskBadge">0</span>
    </div>
    <div id="tasksBody"><div class="skeleton skel-md"></div></div>
  </section>

  <section class="card span-5" id="aprCard">
    <div class="card-head">
      <div class="card-title"><span class="title-icon">⏳</span> 승인 큐 (Pending)</div>
      <div class="apr-head-actions">
        <button class="btn small" id="approveAllBtn" title="Excluded 로 표시된 항목은 제외하고 pending 승인 전체 실행">✓ 전체 발송</button>
        <span class="badge warn" id="aprBadge">0</span>
      </div>
    </div>
    <div id="aprBody"><div class="empty subtle">대기 중인 승인이 없어요.</div></div>
  </section>

  <!-- 3) YouTube + Analytics — only when API key configured. -->
  <section class="card span-7 yt-cond" id="ytCard" style="display:none">
    <div class="card-head">
      <div class="card-title"><span class="title-icon">📺</span> YouTube — 내 채널</div>
      <button class="btn small" id="queueBtn" title="유튜브 최근 영상의 미답 댓글을 가져와 응답 큐에 추가">📥 댓글 큐 갱신</button>
    </div>
    <div id="ytBody"></div>
  </section>

  <section class="card span-5 yt-cond" id="anaCard" style="display:none">
    <div class="card-head">
      <div class="card-title"><span class="title-icon">📊</span> Analytics · 28일</div>
      <span class="badge" id="anaBadge">API key</span>
    </div>
    <div id="anaBody"></div>
  </section>

  <section class="card span-12 yt-cond" id="vidCard" style="display:none">
    <div class="card-head">
      <div class="card-title"><span class="title-icon">🎬</span> 최근 영상</div>
    </div>
    <div class="video-grid" id="vidBody"></div>
  </section>

  <!-- 4) Mini KPI strip — moved to bottom; less prominent. Hidden when no YT. -->
  <section class="card span-12 kpi-strip yt-cond" id="kpiStrip" style="display:none">
    <div class="kpi-cell">
      <div class="kpi-icon">📺</div>
      <div class="kpi-num" data-target="0" id="kSubs">0</div>
      <div class="kpi-label">구독자</div>
    </div>
    <div class="kpi-cell">
      <div class="kpi-icon">👁</div>
      <div class="kpi-num" data-target="0" id="kViews">0</div>
      <div class="kpi-label">총 조회</div>
    </div>
    <div class="kpi-cell">
      <div class="kpi-icon">💗</div>
      <div class="kpi-num" id="kEng">–</div>
      <div class="kpi-label">참여율</div>
    </div>
    <div class="kpi-cell">
      <div class="kpi-icon">⚡</div>
      <div class="kpi-num" data-target="0" id="kOpen">0</div>
      <div class="kpi-label">열린 작업</div>
      <div class="kpi-delta urgent" id="kUrgent"></div>
    </div>
    <div class="kpi-cell">
      <div class="kpi-icon">⏳</div>
      <div class="kpi-num" data-target="0" id="kApr">0</div>
      <div class="kpi-label">승인 대기</div>
    </div>
  </section>
</main>

<div class="toast" id="toast"></div>

<script>${_loadWebviewAsset('dashboard.js')}</script>
</body></html>`;
    }
}
