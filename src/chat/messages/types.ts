/**
 * Shared types for per-message-type handlers extracted from
 * `SidebarChatProvider.resolveWebviewView` in `src/views/sidebar-chat.ts`.
 *
 * Each handler is an async function that receives a `MessageContext` (a bag
 * of bound provider methods/state) and the original `msg` from the webview.
 * Behavior must remain byte-for-byte identical to the in-class switch arm.
 *
 * The coordinator (`coordinator.ts`) builds one `MessageContext` per
 * `onDidReceiveMessage` call and dispatches by `msg.type`.
 */
import type * as vscode from 'vscode';

/**
 * Subset of `SidebarChatProvider` that the message handlers need access to.
 * Methods are bound by the orchestrator before being placed on the context.
 *
 * NOTE: This intentionally mirrors `this.X` references inside the original
 * switch body. If any field name diverges from the source, the orchestrator
 * must adapt — handlers themselves stay strictly typed against this shape.
 */
export interface MessageContext {
    /** The webview view passed into resolveWebviewView. */
    webviewView: vscode.WebviewView;

    /** Extension context — used for globalState reads/writes. */
    ctx: vscode.ExtensionContext;

    /** Optional reference to `_view` (may be undefined for completeness). */
    view: vscode.WebviewView | undefined;

    /* --- mutable state --- */
    chatHistory: { role: string; content: string }[];
    displayMessages: { text: string; role: string }[];
    abortControllerRef: { value: AbortController | undefined };
    lastPromptRef: { value: string | undefined };
    lastModelRef: { value: string | undefined };
    sidebarCorpModeRef: { value: boolean };
    activeSessionIdRef: { value: string | undefined };
    thinkingPanelRef: { value: vscode.WebviewPanel | undefined };

    /* --- bound provider methods --- */
    handlePrompt(prompt: string, modelName: string, internetEnabled?: boolean): Promise<void>;
    handleCorporatePrompt(prompt: string, modelName: string): Promise<void>;
    handlePromptWithFile(
        prompt: string,
        modelName: string,
        files: { name: string; type: string; data: string }[],
        internetEnabled?: boolean,
    ): Promise<void>;
    handleInjectLocalBrain(files: any[]): Promise<void>;
    handleSettingsMenu(): Promise<void>;
    handleBrainMenu(): Promise<void>;
    handleStatusFolderClick(): Promise<void>;
    handleStatusGitClick(): Promise<void>;
    /** Scan sessions/* for state.json files with status='running' and post
     *  a recovery card to the webview (incompleteSessions message). */
    postIncompleteSessions(): void;
    /** Mark a session as aborted on disk (used by recovery card 폐기 button). */
    discardSession(sessionDir: string): void;
    /** Open a session folder in OS file manager. */
    openSessionFolder(sessionDir: string): void;
    sendModels(): Promise<void>;
    sendCompanyState(noteToUser?: string): void;
    sendStatusUpdate(): void;
    toggleThinkingMode(): Promise<void>;
    openThinkingPanel(): void;
    postThinking(message: any): void;
    restoreSession(id: string): boolean;
    readSessions(): any[];
    writeSessions(sessions: any[]): void;
    deleteSession(id: string): boolean;
    currentWorkspaceMeta(): { workspace: string; workspaceName: string };
    detectExplicitMention(prompt: string): { agentId: string; agentName: string } | null;
    restoreDisplayMessages(): void;
    resetChat(): void;
    injectSystemMessage(message: string): void;
    getDefaultModel(): string;
    startAutoCycle(intervalMin?: number, idleMin?: number): void;
    stopAutoCycle(): void;
    maybeMorningBriefing(ctx: vscode.ExtensionContext): Promise<void>;
    broadcastCorporate(msg: any): void;

    /** Extension URI — needed for resolving asset paths in `corporateInit`. */
    extensionUri: vscode.Uri;
}
