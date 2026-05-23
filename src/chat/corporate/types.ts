/**
 * Shared types for the corporate dispatch phases extracted out of
 * SidebarChatProvider._handleCorporatePrompt.
 *
 * The orchestrator (`_handleCorporatePrompt` in src/views/sidebar-chat.ts)
 * stays a thin sequencer; each phase below receives an explicit
 * `CorporateContext` so we avoid implicit `this` coupling.
 */

export type Plan = {
    brief: string;
    tasks: { agent: string; task: string }[];
};

export type AgentMetaEntry = {
    task: string;
    toolsUsed: string[];
    prefetchSummary: string;
    outputSummary: string;
    outputLength: number;
};

export type ConferTurn = { from: string; to: string; text: string };

/**
 * The narrow surface area the extracted phase helpers need from the
 * SidebarChatProvider instance. We pass these via an explicit context object
 * rather than a `this` bind so the phases stay testable and the data flow
 * is obvious at the call site.
 */
export interface CorporateContext {
    /** Forwards a webview message to sidebar + office panel. */
    post: (m: any) => void;
    /** Same channel as `post`, but uses the raw broadcast helper for events
     *  (e.g. `multiDispatch`) that historically went through it directly. */
    broadcastCorporate: (m: any) => void;
    /** True when the user clicked stop. */
    isAborted: () => boolean;
    /** Backing field — phases need to mutate the pending mirror flag. */
    setTelegramMirrorPending: (v: boolean) => void;
    getTelegramMirrorPending: () => boolean;
    /** LLM call (already bound to the active AbortController).
     *  `onChunk` fires for every streamed token — used by SessionStateWriter
     *  to persist agent output incrementally so a crash mid-stream still
     *  keeps everything written so far. */
    callAgentLLM: (
        systemPrompt: string,
        userMsg: string,
        modelName: string,
        agentId: string,
        broadcast: boolean,
        opts?: { jsonMode?: boolean; onFirstToken?: () => void; onChunk?: (chunk: string) => void }
    ) => Promise<string>;
    /** Optional checkpoint writer. When present, each phase pushes progress
     *  to disk so an interrupted session can be detected (and eventually
     *  resumed) on next launch. Undefined when called from contexts that
     *  don't need persistence (tests, secondary internal calls). */
    sessionWriter?: import('../../dispatch/session-state').SessionStateWriter;
    /** Execute embedded XML action tags inside an agent output. */
    executeActions: (
        aiMessage: string,
        opts?: {
            rootOverride?: string;
            appendToOutput?: (s: string) => void;
            silent?: boolean;
            skipRunCommand?: boolean;
            agentId?: string;
        }
    ) => Promise<string[]>;
    /** Recent files context block injected into specialist system prompts. */
    buildRecentFilesContext: (agentId: string) => string;
    /** Project memory section injected into CEO chat prompts. */
    getProjectMemory: () => string;
    /** Kit shortcut for explicit `개발신아 …` developer call. */
    tryKitShortcut: (agentId: string, prompt: string) => string | null;
    /** Revenue shortcut for business agent. */
    tryRevenueShortcut: (prompt: string) => Promise<string | null>;
}
