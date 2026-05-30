/**
 * `handlePromptWithFile` — extracted body of
 * `SidebarChatProvider._handlePromptWithFile` (originally at
 * src/views/sidebar-chat.ts:~2764). The class method is now a thin
 * wrapper that builds a `PromptContext` and forwards here.
 *
 * Behavior is preserved byte-for-byte from the original.
 *
 * v2.90.1 note (from original) — text attachments are inlined, binary /
 * image attachments are persisted to OS tempdir and only their paths are
 * embedded in the prompt so the Claude CLI Read tool can open them safely.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { streamAsk, type Tier } from '../../llm';
import { MAX_FILE_NAME_LEN } from '../../infra/path-safety';
import {
    buildActiveEditorContext as _hBuildActiveEditorContext,
    classifyChatError as _hClassifyChatError,
} from '../pure-helpers';
import {
    MAX_CONTEXT_SIZE,
    _serializeMessages,
    _modelToTier,
} from '../../extension';
import type { PromptContext } from './types';

export async function handlePromptWithFile(
    ctx: PromptContext,
    prompt: string,
    modelName: string,
    files: { name: string; type: string; data: string }[],
    internetEnabled?: boolean,
): Promise<void> {
    if (!ctx.view) { return; }

    /* v2.90.1 — 이전 코드는 PDF·DOCX 같은 바이너리도 base64→utf-8 디코딩해서
       프롬프트 -p 인자에 박았음. PDF 깨진 문자열이 Claude CLI 입력을 망가뜨려
       "Failed to execute 'json' on 'Response'" 류 에러 발생 + ARG_MAX 초과 위험.
       이제 텍스트는 그대로 인라인, 바이너리/이미지는 OS 임시 디렉토리에 저장하고
       경로만 프롬프트에 노출 → Claude CLI 의 Read 도구가 직접 처리. */
    const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-yaml|x-sh|x-shellscript))/i;
    const TEXT_EXT = /\.(txt|md|markdown|json|xml|ya?ml|js|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|sh|bash|zsh|sql|html?|css|scss|less|env|toml|ini|conf|cfg|csv|tsv|log)$/i;
    const isTextFile = (f: { name: string; type: string }) =>
        TEXT_MIME.test(f.type || '') || TEXT_EXT.test(f.name || '');
    const isImage = (f: { name: string; type: string }) => (f.type || '').startsWith('image/');

    const tmpDir = path.join(os.tmpdir(), `agent-os-ai-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const savedPaths: string[] = [];

    try {
        let fileContext = '';
        const inlineTextBlocks: string[] = [];
        const fileRefs: string[] = [];

        for (const f of files) {
            if (isTextFile(f) && !isImage(f)) {
                const decoded = Buffer.from(f.data, 'base64').toString('utf-8');
                inlineTextBlocks.push(`\n\n[첨부 파일: ${f.name}]\n\`\`\`\n${decoded.slice(0, 20000)}\n\`\`\``);
            } else {
                if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
                const safeName = (f.name || 'file').replace(/[^\w.\-]+/g, '_').slice(0, MAX_FILE_NAME_LEN);
                const p = path.join(tmpDir, safeName);
                fs.writeFileSync(p, Buffer.from(f.data, 'base64'));
                savedPaths.push(p);
                const kind = isImage(f) ? '이미지' : (f.type || '바이너리');
                fileRefs.push(`- ${f.name} (${kind}) → \`${p}\``);
            }
        }

        if (inlineTextBlocks.length) fileContext += inlineTextBlocks.join('');
        if (fileRefs.length) {
            fileContext += `\n\n[첨부된 파일이 디스크에 저장되었습니다. \`Read\` 도구로 아래 경로를 직접 읽어 분석하세요 (PDF·이미지·DOCX 지원):]\n${fileRefs.join('\n')}`;
        }

        const userContent = prompt + fileContext;
        ctx.chatHistory.push({ role: 'user', content: userContent });
        ctx.displayMessages.push({ text: prompt + (files.length > 0 ? `\n📎 ${files.map(f => f.name).join(', ')}` : ''), role: 'user' });
        /* v2.90.1 — 전송 전에 히스토리 정리 (이전 PDF 깨진 잔재가 있으면 자름) */
        ctx.pruneHistory();

        const reqMessages = [...ctx.chatHistory];
        if (reqMessages.length > 0 && reqMessages[0].role === 'system') {
            const contextBlock = _hBuildActiveEditorContext(MAX_CONTEXT_SIZE);
            const workspaceCtx = ctx.getWorkspaceContext();
            const brainCtx = ctx.brainEnabled ? ctx.getSecondBrainContext() : '';
            const projectMemory = ctx.getProjectMemory();
            const internetCtx = internetEnabled
                ? `\n\n[CRITICAL DIRECTIVE: INTERNET ACCESS IS ENABLED]\nCurrent Time: ${new Date().toLocaleString('ko-KR')}\nYou have FULL internet access via the <read_url> tool. You MUST NEVER say you cannot search, or that your capabilities are limited. To search, ALWAYS output:\n<read_url>https://html.duckduckgo.com/html/?q=YOUR+SEARCH+TERM</read_url>\nIf the user asks to search, or asks for recent info, DO NOT apologize. Just use the tag.`
                : '';
            reqMessages[0] = {
                role: 'system',
                content: `${ctx.systemPrompt}${projectMemory}\n\n[BACKGROUND CONTEXT]\n${contextBlock}\n${workspaceCtx}\n${brainCtx}${internetCtx}`
            };
        }

        let aiMessage = '';
        ctx.view.webview.postMessage({ type: 'streamStart' });
        const abortController = ctx.createAbortController();

        const tier: Tier = _modelToTier(modelName);
        const claudePrompt = _serializeMessages(reqMessages);
        /* opts.model 명시 — gpt-5.5 선택이 tier 변환 단계에서 claude 로 덮이는 버그 차단. */
        await streamAsk(claudePrompt, tier, (token) => {
            if (abortController.signal.aborted) return;
            aiMessage += token;
            ctx.view!.webview.postMessage({ type: 'streamChunk', value: token });
        }, { model: modelName, codexReasoningEffort: ctx.getCodexReasoningEffort() });

        ctx.view.webview.postMessage({ type: 'streamEnd' });
        ctx.chatHistory.push({ role: 'assistant', content: aiMessage });

        const report = await ctx.executeActions(aiMessage);
        if (report.length > 0) {
            const reportMsg = `\n\n---\n**에이전트 작업 결과**\n${report.join('\n')}`;
            ctx.view.webview.postMessage({ type: 'streamChunk', value: reportMsg });
            ctx.view.webview.postMessage({ type: 'streamEnd' });
            aiMessage += reportMsg;
        }
        /* raw aiMessage 저장 — fmt() 가 action 태그를 badge 로 렌더하므로
           strip 불필요. strip 하면 reload 시 표·코드·badge 내용 사라짐. */
        ctx.displayMessages.push({ text: aiMessage, role: 'ai' });
        ctx.pruneHistory();
        ctx.saveHistory();

    } catch (error: any) {
        const msg = error?.message || String(error);
        const errMsg = _hClassifyChatError(msg, modelName);

        ctx.view.webview.postMessage({ type: 'error', value: errMsg });

        // Axios의 타입이 stream일 때 에러 본문을 파싱해서 원인을 명확히 로그에 남김
        if (error.response?.data?.on) {
            let buf = '';
            error.response.data.on('data', (c: any) => buf += c.toString());
            error.response.data.on('end', () => {
                try {
                    const parsed = JSON.parse(buf);
                    if (parsed.error?.message) {
                        ctx.view!.webview.postMessage({ type: 'error', value: `⚠️ API 자세한 오류: ${parsed.error.message}` });
                    }
                } catch { /* ignore parsing err */ }
            });
        }
    } finally {
        /* Claude CLI 가 -p 모드라 await 끝나면 자식 프로세스 종료된 상태 → 안전하게 정리. */
        for (const p of savedPaths) {
            try { fs.unlinkSync(p); } catch { /* gone is fine */ }
        }
        try { fs.rmdirSync(tmpDir); } catch { /* may not exist or non-empty */ }
    }
}
