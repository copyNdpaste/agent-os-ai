/**
 * Chat-domain message handlers — user prompts, new chat, ready, regenerate,
 * stop generation, knowledge injection, corp-mode toggle, brain network
 * highlight, etc.
 *
 * Extracted byte-for-byte from `SidebarChatProvider.resolveWebviewView`
 * switch arms in `src/views/sidebar-chat.ts`.
 */
import { AGENT_ORDER } from '../../agents';
import type { MessageContext } from './types';

export async function handleChatMessage(ctx: MessageContext, msg: any): Promise<boolean> {
    switch (msg.type) {
        case 'prompt': {
            /* v2.89.146 — 명시적 호출 감지("베조스야", "개발신아" 등) 시 corporate
               모드 force. 사용자가 사이드바 toggle 안 해도 명시적 호출은 항상
               specialist dispatch 흐름으로 → 매출/키트 shortcut 발동. */
            const txt = String(msg.value || '');
            const hasExplicit = !!ctx.detectExplicitMention(txt);
            if (msg.corporate || hasExplicit) {
                ctx.sidebarCorpModeRef.value = true;
                await ctx.handleCorporatePrompt(txt, msg.model);
            } else {
                await ctx.handlePrompt(txt, msg.model, msg.internet);
            }
            return true;
        }
        case 'corpModeToggle':
            ctx.sidebarCorpModeRef.value = !!msg.on;
            return true;
        case 'promptWithFile':
            await ctx.handlePromptWithFile(msg.value, msg.model, msg.files, msg.internet);
            return true;
        case 'newChat':
            ctx.resetChat();
            return true;
        case 'ready':
            // 웹뷰가 준비되면 저장된 대화 기록 복원 + 회사 상태 동기화.
            // v2.89.86 — 이전엔 _sendCompanyState() 가 사용자 셋업 액션 후에만
            // 호출돼서, 사이드바 재로드 시 companyState.configured 가 false로
            // 시작했음. 그 결과 셋업 완료된 사용자가 👔 모드에서 메시지 보내도
            // send() 의 가드 (`corp && !companyState.configured`) 에 막혀서
            // 응답 없이 차단됐음. ready 시점에 한 번 더 동기화.
            ctx.restoreDisplayMessages();
            ctx.sendCompanyState();
            /* Scan for incomplete sessions (last run crashed or was interrupted).
               Sidebar shows a recovery card if any found. */
            try { ctx.postIncompleteSessions(); } catch { /* never block ready */ }
            return true;
        case 'discardSession':
            if (typeof msg.sessionDir === 'string') ctx.discardSession(msg.sessionDir);
            return true;
        case 'openSessionFolder':
            if (typeof msg.sessionDir === 'string') ctx.openSessionFolder(msg.sessionDir);
            return true;
        case 'discardChatInflight':
            ctx.discardChatInflight();
            return true;
        case 'retryChatInflight':
            ctx.retryChatInflight();
            return true;
        case 'toggleThinking':
            await ctx.toggleThinkingMode();
            return true;
        case 'requestStatus':
            ctx.sendStatusUpdate();
            return true;
        case 'highlightBrainNote':
            if (typeof msg.note === 'string') {
                if (!ctx.thinkingPanelRef.value) ctx.openThinkingPanel();
                // Allow the panel a moment to load before sending the highlight
                setTimeout(() => ctx.postThinking({ type: 'highlight_node', note: msg.note }), 350);
            }
            return true;
        case 'injectLocalBrain':
            await ctx.handleInjectLocalBrain(msg.files);
            return true;
        case 'stopGeneration':
            if (ctx.abortControllerRef.value) {
                ctx.abortControllerRef.value.abort();
                ctx.abortControllerRef.value = undefined;
            }
            /* Force-clear any agent cards stuck in 'thinking' state — abort
               can race past the corporate flow's per-stage agentEnd posts. */
            try {
                for (const id of AGENT_ORDER) {
                    ctx.broadcastCorporate({ type: 'agentEnd', agent: id });
                }
            } catch { /* ignore */ }
            return true;
        case 'regenerate':
            if (ctx.lastPromptRef.value) {
                // Remove last AI response from history
                if (ctx.chatHistory.length > 0 && ctx.chatHistory[ctx.chatHistory.length - 1].role === 'assistant') {
                    ctx.chatHistory.pop();
                }
                if (ctx.displayMessages.length > 0 && ctx.displayMessages[ctx.displayMessages.length - 1].role === 'ai') {
                    ctx.displayMessages.pop();
                }
                await ctx.handlePrompt(ctx.lastPromptRef.value, ctx.lastModelRef.value || '');
            }
            return true;
    }
    return false;
}
