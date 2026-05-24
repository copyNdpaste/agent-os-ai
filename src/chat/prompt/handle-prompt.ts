/**
 * `handlePrompt` — extracted body of `SidebarChatProvider._handlePrompt`
 * (originally at src/views/sidebar-chat.ts:~2884). The class method is
 * now a thin wrapper that builds a `PromptContext` and forwards here.
 *
 * Behavior is preserved byte-for-byte from the original. All `this.*`
 * references are routed through `ctx` so this function stays class-free.
 */
import axios from 'axios';
import { streamAsk, type Tier } from '../../llm';
import {
    buildActiveEditorContext as _hBuildActiveEditorContext,
} from '../pure-helpers';
import {
    MAX_CONTEXT_SIZE,
    _serializeMessages,
    _modelToTier,
    sendTelegramReport,
} from '../../extension';
import type { PromptContext } from './types';

export async function handlePrompt(
    ctx: PromptContext,
    prompt: string,
    modelName: string,
    internetEnabled?: boolean,
): Promise<void> {
    if (!ctx.view) { return; }

    try {
        // 1. Context: active editor content
        const contextBlock = _hBuildActiveEditorContext(MAX_CONTEXT_SIZE);

        // 2. Context: workspace file tree + key file contents
        const workspaceCtx = ctx.getWorkspaceContext();

        // 2.5 Inject Second Brain Knowledge (ON/OFF 토글 반영)
        const brainCtx = ctx.brainEnabled ? ctx.getSecondBrainContext() : '';

        // 3. Push user message
        ctx.chatHistory.push({
            role: 'user',
            content: prompt
        });

        // 저장용: 유저 메시지 기록 (프롬프트만)
        ctx.displayMessages.push({ text: prompt, role: 'user' });

        const reqMessages = [...ctx.chatHistory];
        if (reqMessages.length > 0 && reqMessages[0].role === 'system') {
            const internetCtx = internetEnabled
                ? `\n\n[CRITICAL DIRECTIVE: INTERNET ACCESS IS ENABLED]\nCurrent Time: ${new Date().toLocaleString('ko-KR')}\nYou have FULL internet access via the <read_url> tool. You MUST NEVER say you cannot search, or that your capabilities are limited. To search, ALWAYS output:\n<read_url>https://html.duckduckgo.com/html/?q=YOUR+SEARCH+TERM</read_url>\nIf the user asks to search, or asks for recent info, DO NOT apologize. Just use the tag.`
                : '';
            reqMessages[0] = {
                role: 'system',
                content: `${ctx.systemPrompt}${ctx.getProjectMemory()}\n\n[BACKGROUND CONTEXT - DO NOT EXPLAIN THIS TO THE USER UNLESS ASKED]\n${contextBlock}\n${workspaceCtx}\n${brainCtx}${internetCtx}`
            };
        }

        let aiMessage = '';

        ctx.view.webview.postMessage({ type: 'streamStart' });
        ctx.setLastPrompt(prompt);
        ctx.setLastModel(modelName);
        const abortController = ctx.createAbortController();

        if (ctx.shouldEmitThinking()) {
            ctx.postThinking({ type: 'thinking_start', prompt });
            ctx.postThinking({
                type: 'context_done',
                workspace: !!workspaceCtx,
                brainCount: ctx.brainEnabled ? (brainCtx ? brainCtx.split('📄').length - 1 : 0) : 0,
                web: !!internetEnabled
            });
        }

        const seenBrainReads = new Set<string>();
        const detectBrainReadsLive = () => {
            if (!ctx.shouldEmitThinking()) return;
            const matches = [...aiMessage.matchAll(/<read_brain>([\s\S]*?)<\/read_brain>/g)];
            for (const m of matches) {
                const note = m[1].trim();
                if (note && !seenBrainReads.has(note)) {
                    seenBrainReads.add(note);
                    ctx.postThinking({ type: 'brain_read', note });
                }
            }
            const fileMatches = [...aiMessage.matchAll(/<(?:read_file|create_file|edit_file)\s+path="([^"]+)"/g)];
            for (const m of fileMatches) {
                let note = m[1].trim();
                if (note.includes('Company/')) {
                    note = note.split('Company/').pop() || note;
                }
                if (note && !seenBrainReads.has(note)) {
                    seenBrainReads.add(note);
                    ctx.postThinking({ type: 'brain_read', note });
                }
            }
        };
        let answerStartFired = false;
        const fireAnswerStart = () => {
            if (ctx.shouldEmitThinking() && !answerStartFired) {
                answerStartFired = true;
                ctx.postThinking({ type: 'answer_start' });
            }
        };

        const tier: Tier = _modelToTier(modelName);
        const claudePrompt = _serializeMessages(reqMessages);
        await streamAsk(claudePrompt, tier, (token) => {
            if (abortController.signal.aborted) return;
            aiMessage += token;
            ctx.view!.webview.postMessage({ type: 'streamChunk', value: token });
            /* Inflight checkpoint — 1초 throttle disk write 로 crash 시 복구 가능. */
            try { ctx.inflightAppendChunk?.(token); } catch { /* never break stream */ }
            detectBrainReadsLive();
            if (ctx.shouldEmitThinking()) {
                fireAnswerStart();
                ctx.postThinking({ type: 'answer_chunk', text: token });
            }
        });

        // 스트리밍 완료 알림 잠시 보류 (연속된 답변을 같은 상자에 이어서 출력하기 위함)

        // 4.5 자율 열람 (Second Brain 및 웹 검색): AI가 <read_brain> 또는 <read_url>을 사용했는지 확인
        const brainReads = [...aiMessage.matchAll(/<read_brain>([\s\S]*?)<\/read_brain>/g)];
        const urlReads = [...aiMessage.matchAll(/<read_url>([\s\S]*?)<\/read_url>/gi)];

        if (brainReads.length > 0 || urlReads.length > 0) {
            let fetchedContent = '';
            let uiFeedbackStr = '';

            // Brain 읽기 처리
            for (const match of brainReads) {
                const requestedFile = match[1].trim();
                const fileContent = ctx.readBrainFile(requestedFile);
                fetchedContent += `\n\n[BRAIN DOCUMENT: ${requestedFile}]\n${fileContent}\n`;
            }

            // URL 읽기 처리
            for (const match of urlReads) {
                const url = match[1].trim();
                try {
                    const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 });
                    let cleaned = data.toString()
                        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
                        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                    fetchedContent += `\n\n[WEB CONTENT: ${url}]\n${cleaned.slice(0, 15000)}\n`;
                    const msg = `\n\n> 🌐 **[웹 검색 완료]** ${url} (${cleaned.length}자)\n\n`;
                    uiFeedbackStr += msg;
                    ctx.view.webview.postMessage({ type: 'streamChunk', value: msg });
                } catch (err: any) {
                    fetchedContent += `\n\n[WEB CONTENT: ${url}] (FAILED: ${err.message})\n`;
                    const msg = `\n\n> 🌐 **[웹 검색 실패]** ${url} - ${err.message}\n\n`;
                    uiFeedbackStr += msg;
                    ctx.view.webview.postMessage({ type: 'streamChunk', value: msg });
                }
            }

            const cleanedResponse = aiMessage.replace(/<read_brain>[\s\S]*?<\/read_brain>/g, '')
                                             .replace(/<read_url>[\s\S]*?<\/read_url>/gi, '').trim();

            if (brainReads.length > 0) {
                const msg = `\n\n> 🧠 **[Second Brain 열람 완료]** 스캔한 핵심 지식을 바탕으로 답변을 구성합니다...\n\n`;
                uiFeedbackStr += msg;
                ctx.view.webview.postMessage({ type: 'streamChunk', value: msg });
            }

            reqMessages.push({ role: 'assistant', content: cleanedResponse || '탐색을 진행 중입니다...' });
            reqMessages.push({ role: 'user', content: `[SYSTEM: The following documents and web contents were retrieved based on your actions. Use this information to provide a complete and accurate answer to the user's original question.]\n${fetchedContent}\n\nNow answer the user's question using the above knowledge. Do NOT output <read_brain> or <read_url> again. Answer directly and comprehensively.` });

            aiMessage = cleanedResponse + uiFeedbackStr;

            if (ctx.shouldEmitThinking()) {
                ctx.postThinking({ type: 'answer_start' });
            }

            const followUpPrompt = _serializeMessages(reqMessages);
            const followUpTier: Tier = _modelToTier(modelName);
            await streamAsk(followUpPrompt, followUpTier, (token) => {
                if (abortController.signal.aborted) return;
                aiMessage += token;
                ctx.view!.webview.postMessage({ type: 'streamChunk', value: token });
                try { ctx.inflightAppendChunk?.(token); } catch { /* never break stream */ }
                if (ctx.shouldEmitThinking()) {
                    ctx.postThinking({ type: 'answer_chunk', text: token });
                }
            });
        }

        // 모든 스트리밍(1차 및 2차)이 끝난 후, 박스 포장 완료
        ctx.view.webview.postMessage({ type: 'streamEnd' });

        ctx.chatHistory.push({ role: 'assistant', content: aiMessage });

        // 5. Execute agent actions
        const report = await ctx.executeActions(aiMessage);

        // 6. Agent report 추가 (있을 때만)
        if (report.length > 0) {
            const reportMsg = `\n\n---\n**에이전트 작업 결과**\n${report.join('\n')}`;
            ctx.view.webview.postMessage({ type: 'streamChunk', value: reportMsg });
            ctx.view.webview.postMessage({ type: 'streamEnd' });
            aiMessage += reportMsg;
        }

        // 저장용: AI 응답 기록
        /* raw aiMessage 그대로 저장 — 이전엔 stripActionTags 로 <create_file>·
           <edit_file>·<run_command>·<read_brain> 같은 태그 안 내용을 통째로 지웠는데
           addMsg→fmt() 가 이미 그 태그들을 file-badge/edit-badge/code-wrap/cmd-badge
           로 렌더하므로 strip 은 reload 시 콘텐츠 손실만 유발 (사용자 보고: 표·
           코드블록이 reload 후 사라짐). raw 저장하면 reload 후 동일 화면. */
        ctx.displayMessages.push({ text: aiMessage, role: 'ai' });

        // 📚 Citation badges + 🎬 final source highlight
        const allBrainReads = [...aiMessage.matchAll(/<read_brain>([\s\S]*?)<\/read_brain>/g)]
            .map(m => m[1].trim()).filter(s => s.length > 0);
        const uniqueSources = [...new Set(allBrainReads)];
        if (uniqueSources.length > 0) {
            ctx.view.webview.postMessage({ type: 'attachCitations', sources: uniqueSources });
        }
        if (ctx.shouldEmitThinking()) {
            ctx.postThinking({ type: 'answer_complete', sources: uniqueSources });
        }

        ctx.pruneHistory();
        ctx.saveHistory();

    } catch (error: any) {
        const msg = error?.message || String(error);
        let errMsg: string;
        if (/ENOENT|not found/i.test(msg)) {
            errMsg = `⚠️ Claude CLI 를 찾지 못했어요.\n\`claude --version\` 으로 설치를 확인하거나 settings.json 의 \`agentOs.claudeBinPath\` 를 설정해주세요.`;
        } else if (/timed out|timeout/i.test(msg)) {
            errMsg = `⚠️ Claude 응답이 너무 오래 걸려요. 질문을 짧게 줄이거나 Claude Max 사용량 한도를 확인해주세요.`;
        } else if (/aborted/i.test(msg)) {
            errMsg = `⚠️ 응답이 중간에 취소됐어요.`;
        } else {
            errMsg = `⚠️ 오류: ${msg}`;
        }

        ctx.view.webview.postMessage({ type: 'error', value: errMsg });

        if (ctx.getTelegramMirrorPending()) {
            sendTelegramReport(`⚠️ *AI 응답 실패*\n\n${errMsg.slice(0, 800)}`).catch(() => { /* silent */ });
            ctx.setTelegramMirrorPending(false);
        }
    } finally {
        /* If this prompt came from Telegram, mirror the AI response back. */
        ctx.maybeMirrorToTelegram().catch(() => { /* silent */ });
    }
}
