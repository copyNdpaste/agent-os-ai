/**
 * Agent configuration message handlers — load/save goal, RAG mode, self-RAG
 * criteria, active status, hiring, manual one-step run, skills library.
 *
 * Extracted byte-for-byte from `SidebarChatProvider.resolveWebviewView`
 * switch arms in `src/views/sidebar-chat.ts`.
 */
import * as vscode from 'vscode';
import { AGENTS, AGENT_ORDER } from '../../agents';
import {
    ensureCompanyStructure,
    readAgentGoal,
    writeAgentGoal,
    readAgentRagMode,
    writeAgentRagMode,
    readAgentSelfRagCriteria,
    writeAgentSelfRagCriteria,
    countAgentVerifiedClaims,
    readTelegramConfig,
    listAgentTools,
    readActiveAgents,
    readHiredAgents,
    setAgentActive,
    markAgentHired,
    _maybeRecommendCoderModel,
    ALWAYS_ON_AGENTS,
    LOCKED_AGENTS_DEFAULT,
    CompanyDashboardPanel,
} from '../../extension';
import type { MessageContext } from './types';

export async function handleAgentConfigMessage(ctx: MessageContext, msg: any): Promise<boolean> {
    const webviewView = ctx.webviewView;
    switch (msg.type) {
        case 'loadAgentConfig': {
            try {
                ensureCompanyStructure();
                const goal = readAgentGoal(msg.agent);
                const ragMode = readAgentRagMode(msg.agent);
                const selfRagCriteria = readAgentSelfRagCriteria(msg.agent);
                const verifiedCount = countAgentVerifiedClaims(msg.agent);
                const tg = readTelegramConfig();
                const telegramConnected = !!(tg.token && tg.chatId);
                const autoOn = vscode.workspace.getConfiguration('agentOs').get<boolean>('autoCycleEnabled', true);
                const tools = listAgentTools(msg.agent).map(t => ({
                    name: t.name,
                    displayName: t.displayName,
                    description: t.description,
                    configSchema: t.configSchema,
                    injectedAt: t.injectedAt || null,
                    injectedFrom: t.injectedFrom || null,
                    enabled: t.enabled,
                }));
                webviewView.webview.postMessage({ type: 'agentConfigLoaded', agent: msg.agent, goal, ragMode, selfRagCriteria, verifiedCount, telegramConnected, autoOn, tools });
            } catch (e: any) {
                webviewView.webview.postMessage({ type: 'agentConfigLoaded', agent: msg.agent, goal: '', ragMode: 'standard', selfRagCriteria: '', verifiedCount: 0, telegramConnected: false, autoOn: false, tools: [], error: String(e?.message || e) });
            }
            return true;
        }
        case 'loadAllSkills': {
            /* 글로벌 "내 스킬 라이브러리" 데이터 — 모든 에이전트의 tools를
               한 번에 묶어서 webview로 전달. 에이전트별로 그룹핑 + Mine 표시. */
            try {
                const groups = AGENT_ORDER.map(id => ({
                    agentId: id,
                    agentName: AGENTS[id]?.name || id,
                    agentEmoji: AGENTS[id]?.emoji || '🛠',
                    agentColor: AGENTS[id]?.color || '#5DE0E6',
                    agentRole: AGENTS[id]?.role || '',
                    tools: listAgentTools(id).map(t => ({
                        name: t.name,
                        displayName: t.displayName,
                        description: t.description,
                        injectedAt: t.injectedAt || null,
                        injectedFrom: t.injectedFrom || null,
                    })),
                }));
                webviewView.webview.postMessage({ type: 'allSkillsLoaded', groups });
            } catch (e: any) {
                webviewView.webview.postMessage({ type: 'allSkillsLoaded', groups: [], error: String(e?.message || e) });
            }
            return true;
        }
        case 'saveAgentGoal': {
            try {
                ensureCompanyStructure();
                writeAgentGoal(msg.agent, msg.goal || '');
            } catch (e: any) {
                vscode.window.showWarningMessage(`목표 저장 실패: ${e?.message || e}`);
            }
            return true;
        }
        case 'saveAgentRagMode': {
            try {
                ensureCompanyStructure();
                writeAgentRagMode(msg.agent, msg.mode || 'standard');
            } catch (e: any) {
                vscode.window.showWarningMessage(`RAG 모드 저장 실패: ${e?.message || e}`);
            }
            return true;
        }
        case 'saveAgentSelfRagCriteria': {
            try {
                ensureCompanyStructure();
                writeAgentSelfRagCriteria(msg.agent, msg.criteria || '');
            } catch (e: any) {
                vscode.window.showWarningMessage(`자가검증 기준 저장 실패: ${e?.message || e}`);
            }
            return true;
        }
        case 'runAgentStep': {
            // Manual single-step kick from the agent panel. Goes through
            // the existing CEO dispatch path so artifacts land in the
            // same sessions/ folder and the cinematic UI fires.
            // We TEMPORARILY enable sidebar broadcast for this run so
            // the user sees their explicit action play out, then
            // restore the previous state so autonomous activity stays
            // gated by the user's actual corp toggle.
            const a = AGENTS[msg.agent];
            const name = a?.name || msg.agent;
            const model = ctx.getDefaultModel();
            if (!model) {
                webviewView.webview.postMessage({ type: 'error', value: '⚠️ 기본 모델이 설정되지 않았어요.' });
                return true;
            }
            const prevSidebarBroadcast = ctx.sidebarCorpModeRef.value;
            ctx.sidebarCorpModeRef.value = true;
            ctx.handleCorporatePrompt(
                `[수동 한 스텝 — ${name}] ${name} 에이전트의 개인 목표(_agents/${msg.agent}/goal.md)를 향해 다음 한 스텝을 실행하세요. 반드시 ${msg.agent} 에이전트에게 작업을 분배하세요.`,
                model,
            )
                .catch(() => { /* error already broadcast */ })
                .finally(() => { ctx.sidebarCorpModeRef.value = prevSidebarBroadcast; });
            return true;
        }
        /* v2.89.107 — 활성/비활성 토글 (사이드바). PIN 안 받음. */
        case 'setAgentActive': {
            const aid = String((msg as any).agent || '').trim();
            const want = !!(msg as any).active;
            if (!aid) return true;
            if (ALWAYS_ON_AGENTS.has(aid)) {
                try { ctx.view?.webview.postMessage({ type: 'systemNote', value: `⚠️ ${AGENTS[aid]?.name || aid}는 핵심 에이전트라 비활성화할 수 없어요.` }); } catch { /* ignore */ }
                return true;
            }
            if (LOCKED_AGENTS_DEFAULT[aid] && want) {
                try { ctx.view?.webview.postMessage({ type: 'systemNote', value: `🔒 ${AGENTS[aid]?.name || aid}는 PIN 인증이 필요해요. 카드를 클릭해 PIN을 입력하세요.` }); } catch { /* ignore */ }
                return true;
            }
            const ok = setAgentActive(aid, want);
            if (ok) {
                const verb = want ? '활성화됨 ✅' : '비활성화됨 ⏸';
                try { ctx.view?.webview.postMessage({ type: 'systemNote', value: `${AGENTS[aid]?.emoji || ''} ${AGENTS[aid]?.name || aid} ${verb}` }); } catch { /* ignore */ }
                try { ctx.view?.webview.postMessage({ type: 'activeAgents', value: readActiveAgents() }); } catch { /* ignore */ }
                /* v2.89.112 — 개발신 첫 활성화 시 시니어 코더 모델 추천 카드 */
                if (want && aid === 'developer') {
                    try { if (ctx.view) _maybeRecommendCoderModel(ctx.view.webview); } catch { /* ignore */ }
                }
                try {
                    if (CompanyDashboardPanel.current) CompanyDashboardPanel.current.refresh();
                } catch { /* ignore */ }
            } else {
                try { ctx.view?.webview.postMessage({ type: 'systemNote', value: `⚠️ 변경 실패: 회사 폴더 쓰기 권한 확인.` }); } catch { /* ignore */ }
            }
            return true;
        }
        /* v2.89.95 — 채용 PIN 통과 후 webview가 알림. 회사 폴더에 영구 저장.
           v2.89.106 — PIN backend 재검증 + 두 화면 동기화. 사이드바·대쉬보드
           어디서 채용해도 backend가 단일 진실 소스. */
        case 'agentHired':
            try {
                const aid = String((msg as any).agent || '').trim();
                const pin = String((msg as any).pin || '');
                if (!aid || !LOCKED_AGENTS_DEFAULT[aid]) return true;
                /* 잠긴 에이전트만 PIN 게이트 통과 가능. PIN 없거나 다르면 거부. */
                if (pin !== '0000') {
                    try { ctx.view?.webview.postMessage({ type: 'systemNote', value: '❌ 인증 실패: 잘못된 코드입니다.' }); } catch { /* ignore */ }
                    return true;
                }
                const ok = markAgentHired(aid);
                if (!ok) {
                    try { ctx.view?.webview.postMessage({ type: 'systemNote', value: '⚠️ 채용 실패: 회사 폴더에 쓰기 권한이 없습니다.' }); } catch { /* ignore */ }
                    return true;
                }
                try { vscode.window.showInformationMessage(`🎉 ${aid} 에이전트 채용 완료! 이제 활용 가능합니다.`); } catch { /* ignore */ }
                /* 사이드바에 즉시 동기화 + 대쉬보드 패널 열려있으면 거기도 refresh */
                try {
                    ctx.view?.webview.postMessage({ type: 'hiredAgents', value: readHiredAgents() });
                } catch { /* ignore */ }
                try {
                    if (CompanyDashboardPanel.current) CompanyDashboardPanel.current.refresh();
                } catch { /* ignore */ }
            } catch { /* ignore — UI 이미 잠금 해제됨 */ }
            return true;
    }
    return false;
}
