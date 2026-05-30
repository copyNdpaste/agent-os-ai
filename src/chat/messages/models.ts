/**
 * Model / agent-dock domain message handlers.
 *
 * Extracted byte-for-byte from `SidebarChatProvider.resolveWebviewView`
 * switch arms in `src/views/sidebar-chat.ts`.
 */
import * as vscode from 'vscode';
import { AGENTS, AGENT_ORDER, SPECIALIST_IDS } from '../../agents';
import { getSystemSpecs, estimateModelMemoryGB } from '../../system-specs';
import {
    listInstalledModels,
    readAgentModelMap,
    writeAgentModelMap,
    _autoOrchestrateModelMap,
} from '../../extension';
import type { MessageContext } from './types';

const GPT_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);

function normalizeGptEffort(raw: unknown): 'low' | 'medium' | 'high' | 'xhigh' {
    const v = String(raw || '').trim().toLowerCase();
    return GPT_EFFORTS.has(v) ? v as any : 'medium';
}

export async function handleModelsMessage(ctx: MessageContext, msg: any): Promise<boolean> {
    const webviewView = ctx.webviewView;
    switch (msg.type) {
        case 'getModels':
            await ctx.sendModels();
            return true;
        case 'setDefaultModel': {
            const model = String(msg.model || '').trim();
            if (model) {
                await ctx.ctx.globalState.update('selectedModel', model);
                webviewView.webview.postMessage({ type: 'defaultModelSaved', ok: true, model });
            }
            return true;
        }
        case 'setCodexReasoningEffort': {
            const effort = normalizeGptEffort(msg.effort);
            await ctx.ctx.globalState.update('codexReasoningEffort', effort);
            await vscode.workspace.getConfiguration('agentOs').update('codexReasoningEffort', effort, vscode.ConfigurationTarget.Global);
            webviewView.webview.postMessage({ type: 'codexReasoningEffortSaved', ok: true, effort });
            return true;
        }
        /* v2.89.116 — 1인 기업 모드 specialist dock. 사이드바 헤더의 단일
           모델 셀렉터 자리에서 9명 specialist의 모델 매핑을 한눈에 보고
           인라인 변경. dashboard의 "모델 오케스트레이션" 모달과 동일
           백엔드 함수(_autoOrchestrateModelMap, writeAgentModelMap)를
           재사용해서 양쪽이 항상 같은 진실을 본다. */
        case 'loadAgentDock': {
            try {
                const installed = await listInstalledModels();
                const specs = getSystemSpecs();
                const installedWithMem = installed.map(m => ({
                    id: m.id,
                    tier: (m as any).tier || '',
                    estMemGB: estimateModelMemoryGB(m.id),
                    safe: estimateModelMemoryGB(m.id) <= specs.safeModelBudgetGB,
                }));
                const map = readAgentModelMap();
                const defaultModel = ctx.ctx.globalState.get<string>('selectedModel', 'claude-sonnet-4-6');
                const agents = SPECIALIST_IDS.map(id => ({
                    id,
                    name: AGENTS[id]?.name || id,
                    emoji: AGENTS[id]?.emoji || '🤖',
                    role: AGENTS[id]?.role || '',
                    color: AGENTS[id]?.color || '#c9a961',
                    currentModel: map[id] || defaultModel,
                    usingDefault: !map[id],
                }));
                webviewView.webview.postMessage({
                    type: 'agentDockData',
                    installed: installedWithMem,
                    defaultModel,
                    agents,
                    specs,
                });
            } catch (e: any) {
                webviewView.webview.postMessage({ type: 'agentDockData', installed: [], defaultModel: '', agents: [], specs: null, error: String(e?.message || e) });
            }
            return true;
        }
        case 'setAgentModel': {
            try {
                const agentId = String(msg.agent || '').trim();
                const model = String(msg.model || '').trim();
                if (!agentId || !AGENTS[agentId]) {
                    webviewView.webview.postMessage({ type: 'agentDockSaved', ok: false, error: `알 수 없는 에이전트: ${agentId}` });
                    return true;
                }
                const map = readAgentModelMap();
                if (model && model !== 'claude-sonnet-4-6') {
                    map[agentId] = model;
                } else {
                    delete map[agentId];
                }
                writeAgentModelMap(map);
                webviewView.webview.postMessage({ type: 'agentDockSaved', ok: true, agent: agentId, model });
            } catch (e: any) {
                webviewView.webview.postMessage({ type: 'agentDockSaved', ok: false, error: String(e?.message || e) });
            }
            return true;
        }
        case 'autoMapAgents': {
            try {
                const installed = await listInstalledModels();
                const auto = _autoOrchestrateModelMap(installed);
                writeAgentModelMap(auto);
                webviewView.webview.postMessage({ type: 'agentDockAutoMapped', ok: true, map: auto });
            } catch (e: any) {
                webviewView.webview.postMessage({ type: 'agentDockAutoMapped', ok: false, error: String(e?.message || e) });
            }
            return true;
        }
        case 'setAllAgents': {
            try {
                const model = String(msg.model || '').trim();
                if (!model) {
                    webviewView.webview.postMessage({ type: 'agentDockSaved', ok: false, error: '모델이 비어있습니다.' });
                    return true;
                }
                await ctx.ctx.globalState.update('selectedModel', model);
                const map: Record<string, string> = {};
                for (const id of AGENT_ORDER) {
                    if (AGENTS[id]) map[id] = model;
                }
                writeAgentModelMap(map);
                webviewView.webview.postMessage({ type: 'agentDockSaved', ok: true, agent: '*', model });
            } catch (e: any) {
                webviewView.webview.postMessage({ type: 'agentDockSaved', ok: false, error: String(e?.message || e) });
            }
            return true;
        }
        case 'probeIDEModels': {
            /* Try to discover models the host IDE (Antigravity, Cursor,
             * VS Code w/ Copilot, etc.) exposes via the vscode.lm API.
             * Returns list to webview so user can see what's available
             * without committing to integration yet. */
            let models: Array<{ id: string; vendor: string; family: string; name: string }> = [];
            let error = '';
            try {
                const lm: any = (vscode as any).lm;
                if (lm && typeof lm.selectChatModels === 'function') {
                    const result = await lm.selectChatModels({});
                    if (Array.isArray(result)) {
                        models = result.map((m: any) => ({
                            id: m.id || '',
                            vendor: m.vendor || '',
                            family: m.family || '',
                            name: m.name || m.id || '',
                        }));
                    }
                } else {
                    error = 'vscode.lm API 미지원 — 이 호스트(Antigravity?)는 익스텐션에 모델을 노출하지 않음';
                }
            } catch (e: any) {
                error = e?.message || String(e);
            }
            if (ctx.view) {
                ctx.view.webview.postMessage({ type: 'ideModelsProbed', models, error });
            }
            return true;
        }
    }
    return false;
}
