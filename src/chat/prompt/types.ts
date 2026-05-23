/**
 * Shared types for the prompt-handling helpers extracted out of
 * `SidebarChatProvider._handlePrompt` / `_handlePromptWithFile` in
 * `src/views/sidebar-chat.ts`.
 *
 * The provider methods become thin wrappers that build a `PromptContext`
 * and forward to the helpers below. Behavior must remain byte-for-byte
 * identical to the in-class implementations.
 */
import type * as vscode from 'vscode';

export type ChatMessage = { role: string; content: string };
export type DisplayMessage = { text: string; role: string };

/**
 * The narrow surface the prompt helpers need from `SidebarChatProvider`.
 * Bound at the call site so the extracted functions stay class-free.
 */
export interface PromptContext {
    /* --- webview --- */
    view: vscode.WebviewView;

    /* --- mutable conversation state (read + push through references) --- */
    chatHistory: ChatMessage[];
    displayMessages: DisplayMessage[];

    /* --- runtime state getters/setters --- */
    brainEnabled: boolean;
    systemPrompt: string;

    /** persists `prompt` as the user's most recent input for retry/regen. */
    setLastPrompt: (prompt: string) => void;
    /** persists `modelName` as the most recently used model. */
    setLastModel: (modelName: string) => void;

    /** create + store a fresh AbortController for the active stream. */
    createAbortController: () => AbortController;
    /** read the current abort controller (may be undefined). */
    getAbortController: () => AbortController | undefined;

    /** writes `_telegramMirrorPending` on the host instance. */
    setTelegramMirrorPending: (v: boolean) => void;
    /** reads `_telegramMirrorPending` on the host instance. */
    getTelegramMirrorPending: () => boolean;

    /* --- bound provider methods --- */
    getWorkspaceContext: () => string;
    getSecondBrainContext: () => string;
    getProjectMemory: () => string;
    readBrainFile: (filename: string) => string;
    executeActions: (
        aiMessage: string,
        opts?: {
            rootOverride?: string;
            appendToOutput?: (s: string) => void;
            silent?: boolean;
            skipRunCommand?: boolean;
            agentId?: string;
        },
    ) => Promise<string[]>;
    stripActionTags: (text: string) => string;
    pruneHistory: () => void;
    saveHistory: () => void;
    maybeMirrorToTelegram: () => Promise<void>;
    postThinking: (message: any) => void;
    shouldEmitThinking: () => boolean;

    /* --- optional inflight checkpoint hooks ---
     *  When attached, the prompt helper streams each token to the writer so a
     *  mid-stream crash leaves a recoverable file at `_chat/inflight.json`.
     *  Wrapper owns lifecycle (create/finish); helpers just call appendChunk. */
    inflightAppendChunk?: (chunk: string) => void;
}
