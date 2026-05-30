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
        /* modelName (예: 'gpt-5.5') 을 opts.model 로 명시 전달.
           streamAsk → resolveModel 이 opts.model 우선 → providerFor 가 gpt-* → codex 라우팅.
           이전엔 tier 만 넘겨서 항상 TIER_TO_MODEL[claude-sonnet-4-6] 로 덮였음 (gpt 선택 무시 버그). */
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
        }, { model: modelName, codexReasoningEffort: ctx.getCodexReasoningEffort() });

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
            }, { model: modelName, codexReasoningEffort: ctx.getCodexReasoningEffort() });
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

        /* v2.92.x — Multi-turn continuation loop (simple chat 모드).
           사장님 사례: "src/llm/index.ts 읽고 timeoutMs 60000으로 바꿔" 명령에 agent 가
           <read_file> 만 출력하고 멈춤. 이유: 단발 LLM 호출 → executeActions 가 파일 읽어서
           chatHistory 에 결과 push → 그러나 다음 LLM 호출 없음 → agent 가 결과 보고 edit 못 함.
           이 loop 는 agent 가 <done/> 출력하거나 새 액션 발행 멈출 때까지 자동 추가 턴.
           각 턴: executeActions 가 이미 chatHistory 에 tool 결과 push 했으니 그냥 streamAsk 재호출. */
        const MAX_CONTINUATION_TURNS = 5;
        const DONE_RE = /<done\s*\/?>/i;
        const ACTION_RE = /<(?:read_file|read|list_files|glob|grep|run_command|command|bash|terminal|create_file|write_file|edit_file|delete_file|file|read_brain|read_url)\b/i;
        const READ_ACTION_RE = /<(?:read_file|read|list_files|glob|grep|read_brain|read_url|run_command|command|bash|terminal)\b/i;
        const WRITE_ACTION_RE = /<(?:create_file|write_file|edit_file|delete_file|file)\b/i;
        for (let ct = 0; ct < MAX_CONTINUATION_TURNS; ct++) {
            if (abortController.signal.aborted) break;
            /* 직전 응답에 <done/> 있으면 종료 */
            if (DONE_RE.test(aiMessage)) break;
            /* 직전 응답에 액션이 전혀 없으면 agent 가 자발적 종료한 것 → 종료 */
            if (!ACTION_RE.test(aiMessage)) break;
            /* 직전 응답이 순수 write 액션만이고 report 에 성공 표시 있으면, 보통 작업 끝.
               하지만 사장님 명령이 read → write 흐름이면 read 만 했을 때 강제로 continuation. */
            const hadReadOnly = READ_ACTION_RE.test(aiMessage) && !WRITE_ACTION_RE.test(aiMessage);
            const hadWrite = WRITE_ACTION_RE.test(aiMessage);
            /* write 만 있고 read 없으면 (단순 create_file), 다음 턴은 굳이 안 돌려도 됨 — 사용자가
               명시적으로 "검증해" 같은 multi-step 안 시켰을 가능성. read 가 섞여 있으면 (편집 흐름)
               무조건 continuation 진입. */
            if (!hadReadOnly && hadWrite && report.some(r => r.startsWith('✏️') || r.startsWith('✅'))) {
                /* write 만 한 단순 케이스 — 추가 턴 의미 적음. 사장님이 명시적 multi-step 명령했으면
                   agent 가 자기 응답에 다음 액션 박았을 것 (그러면 위 ACTION_RE 통과 못 했을 것). */
                break;
            }

            /* write 결과 (chatHistory 에 안 들어감) 를 user msg 로 보충 주입.
               LLM 이 "edit 됐다" 인지하고 다음 단계 (보통 검증 또는 done) 진행 가능. */
            const writeReports = report.filter(r =>
                r.startsWith('✅') || r.startsWith('✏️') || r.startsWith('🗑️') || r.startsWith('🖥️') || r.startsWith('🚀')
            );
            if (writeReports.length > 0) {
                ctx.chatHistory.push({
                    role: 'user',
                    content: `[시스템: 너의 직전 write/exec 액션 결과]\n${writeReports.join('\n')}\n\n작업이 완전히 끝났으면 <done/> 한 줄. 아니면 다음 액션 (예: 검증 run_command) 또는 추가 edit_file.`,
                });
            } else if (!hadReadOnly) {
                /* 액션 있었는데 report 에 성공 표시 0 = 실패만 있음. 그래도 LLM 에게 다음 결정권. */
                ctx.chatHistory.push({
                    role: 'user',
                    content: `[시스템: 직전 액션이 모두 실패하거나 결과를 못 만듦. 경로/이름 확인 후 다시 시도하거나 <done/> 출력.]`,
                });
            }
            /* read-only 였다면 read 결과는 이미 chatHistory 에 push 됨 — 그대로 진행. */

            /* UI 표시: multi-turn 시작 */
            const turnHeaderMsg = `\n\n---\n🔄 **multi-turn ${ct + 2}** — 결과 보고 다음 단계 결정 중…\n\n`;
            ctx.view.webview.postMessage({ type: 'streamStart' });
            ctx.view.webview.postMessage({ type: 'streamChunk', value: turnHeaderMsg });

            /* 다음 턴 LLM 호출 — chatHistory 그대로 직렬화. */
            let turnAiMessage = '';
            try {
                const turnReqMessages = [...ctx.chatHistory];
                /* system msg 는 reqMessages 첫 번째 그대로 유지. ctx.chatHistory[0] 이 이미 system 임. */
                const turnPrompt = _serializeMessages(turnReqMessages);
                await streamAsk(turnPrompt, _modelToTier(modelName), (token) => {
                    if (abortController.signal.aborted) return;
                    turnAiMessage += token;
                    ctx.view!.webview.postMessage({ type: 'streamChunk', value: token });
                    try { ctx.inflightAppendChunk?.(token); } catch { /* never break stream */ }
                    if (ctx.shouldEmitThinking()) {
                        ctx.postThinking({ type: 'answer_chunk', text: token });
                    }
                }, { model: modelName, codexReasoningEffort: ctx.getCodexReasoningEffort() });
            } catch (e: any) {
                ctx.view.webview.postMessage({ type: 'streamChunk', value: `\n⚠️ multi-turn ${ct + 2} 실패: ${e?.message || e}` });
                ctx.view.webview.postMessage({ type: 'streamEnd' });
                break;
            }
            ctx.view.webview.postMessage({ type: 'streamEnd' });
            if (!turnAiMessage.trim()) break;
            ctx.chatHistory.push({ role: 'assistant', content: turnAiMessage });

            /* 새 액션 실행 */
            const turnReport = await ctx.executeActions(turnAiMessage);
            if (turnReport.length > 0) {
                const turnReportMsg = `\n\n---\n**에이전트 작업 결과 (turn ${ct + 2})**\n${turnReport.join('\n')}`;
                ctx.view.webview.postMessage({ type: 'streamChunk', value: turnReportMsg });
                ctx.view.webview.postMessage({ type: 'streamEnd' });
            }
            /* 다음 iteration 의 조건 체크용으로 aiMessage / report 갱신 */
            aiMessage = turnAiMessage;
            (report as string[]).length = 0;
            (report as string[]).push(...turnReport);
        }
        if (DONE_RE.test(aiMessage)) {
            ctx.view.webview.postMessage({ type: 'streamChunk', value: `\n✅ **<done/>** 작업 완료\n` });
            ctx.view.webview.postMessage({ type: 'streamEnd' });
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
        /* provider 판정 — gpt-5.5 사용 중인데 "Claude 한도 확인" 같은 오답 나오면 사장님 혼란. */
        const _m = (modelName || '').toLowerCase();
        const _isCodex = _m.startsWith('gpt-') || _m.startsWith('gpt5') || _m.startsWith('o1') || _m.startsWith('o3');
        const _cliName = _isCodex ? 'Codex (GPT-5.5)' : 'Claude';
        const _cliBin = _isCodex ? 'codex' : 'claude';
        const _binSetting = _isCodex ? 'agentOs.codexBinPath' : 'agentOs.claudeBinPath';
        let errMsg: string;
        if (/ENOENT|not found/i.test(msg)) {
            errMsg = `⚠️ ${_cliName} CLI 를 찾지 못했어요.\n\`${_cliBin} --version\` 으로 설치를 확인하거나 settings.json 의 \`${_binSetting}\` 를 설정해주세요.`;
        } else if (/timed out|timeout/i.test(msg)) {
            const usageHint = _isCodex ? 'Codex CLI 응답성 (`codex --version`) 또는 질문 길이를 확인' : 'Claude Max 사용량 한도를 확인';
            errMsg = `⚠️ ${_cliName} 응답이 너무 오래 걸려요. 질문을 짧게 줄이거나 ${usageHint}해주세요.`;
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
