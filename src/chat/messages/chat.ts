/**
 * Chat-domain message handlers — user prompts, new chat, ready, regenerate,
 * stop generation, knowledge injection, corp-mode toggle, brain network
 * highlight, etc.
 *
 * Extracted byte-for-byte from `SidebarChatProvider.resolveWebviewView`
 * switch arms in `src/views/sidebar-chat.ts`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AGENT_ORDER } from '../../agents';
import { MAX_FILE_NAME_LEN } from '../../infra/path-safety';
import type { MessageContext } from './types';

function isTextAttachment(f: { name: string; type: string }): boolean {
    const textMime = /^(text\/|application\/(json|xml|javascript|x-yaml|x-sh|x-shellscript))/i;
    const textExt = /\.(txt|md|markdown|json|xml|ya?ml|js|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|sh|bash|zsh|sql|html?|css|scss|less|env|toml|ini|conf|cfg|csv|tsv|log)$/i;
    return textMime.test(f.type || '') || textExt.test(f.name || '');
}

function buildCorporateAttachmentPrompt(
    prompt: string,
    files: { name: string; type: string; data: string }[],
): { prompt: string; cleanup: () => void } {
    const tmpDir = path.join(os.tmpdir(), `agent-os-ai-corp-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const savedPaths: string[] = [];
    const inlineBlocks: string[] = [];
    const fileRefs: string[] = [];

    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const displayName = (f.name || '').trim() || `Image #${i + 1}`;
        const isImage = (f.type || '').startsWith('image/');
        if (isTextAttachment(f) && !isImage) {
            const decoded = Buffer.from(f.data, 'base64').toString('utf-8');
            inlineBlocks.push(`\n\n[첨부 파일: ${displayName}]\n\`\`\`\n${decoded.slice(0, 20000)}\n\`\`\``);
        } else {
            if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
            const fallbackName = isImage ? `Image_${i + 1}.png` : `attachment_${i + 1}`;
            const safeName = (displayName || fallbackName).replace(/[^\w.\- #()[\]]+/g, '_').slice(0, MAX_FILE_NAME_LEN) || fallbackName;
            const p = path.join(tmpDir, safeName);
            fs.writeFileSync(p, Buffer.from(f.data, 'base64'));
            savedPaths.push(p);
            const label = isImage ? `이미지 [Image #${i + 1}]` : (f.type || '바이너리');
            fileRefs.push(`- [Image #${i + 1}] ${displayName} (${label}) → \`${p}\``);
        }
    }

    const attachmentContext = [
        inlineBlocks.join(''),
        fileRefs.length
            ? `\n\n[첨부 파일]\n아래 파일은 이번 회사 작업 라운드 동안 임시 경로에 저장되어 있습니다. 보고서에서 \`[Image #1]\` 같은 첨부 표기는 절대 생략하거나 말줄임표로 줄이지 말고 그대로 표시하세요.\n${fileRefs.join('\n')}`
            : ''
    ].join('');

    return {
        prompt: `${prompt}${attachmentContext}`,
        cleanup: () => {
            for (const p of savedPaths) {
                try { fs.unlinkSync(p); } catch { /* ignore */ }
            }
            try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
        }
    };
}

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
                /* v2.92.x — corp dispatch 큐 라우팅. 진행 중이면 큐에 추가, 끝나면
                   worker 가 자동으로 다음 잡 처리. 사장님이 연속 명령 던지고 자리
                   비울 수 있게. enqueueCorporatePrompt 미바인딩 환경(legacy)은 fallback. */
                if (ctx.enqueueCorporatePrompt) {
                    const r = ctx.enqueueCorporatePrompt(txt, msg.model);
                    if (r.queued) {
                        const preview = txt.length > 60 ? txt.slice(0, 60) + '…' : txt;
                        try {
                            ctx.webviewView?.webview.postMessage({
                                type: 'systemNote',
                                value: `🕐 대기열 추가 (#${r.position + 1}) — 현재 작업 끝나면 자동 시작: "${preview}"`,
                            });
                        } catch { /* ignore */ }
                    }
                } else {
                    await ctx.handleCorporatePrompt(txt, msg.model);
                }
            } else {
                await ctx.handlePrompt(txt, msg.model, msg.internet);
            }
            return true;
        }
        case 'corpModeToggle':
            ctx.sidebarCorpModeRef.value = !!msg.on;
            return true;
        case 'promptWithFile': {
            const txt = String(msg.value || '');
            const hasExplicit = !!ctx.detectExplicitMention(txt);
            if (msg.corporate || hasExplicit) {
                ctx.sidebarCorpModeRef.value = true;
                const built = buildCorporateAttachmentPrompt(txt, msg.files || []);
                try {
                    await ctx.handleCorporatePrompt(built.prompt, msg.model);
                } finally {
                    built.cleanup();
                }
            } else {
                await ctx.handlePromptWithFile(msg.value, msg.model, msg.files, msg.internet);
            }
            return true;
        }
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
