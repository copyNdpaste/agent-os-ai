/**
 * Shared types for per-action handlers extracted from
 * `SidebarChatProvider._executeActions` in `src/views/sidebar-chat.ts`.
 *
 * Each handler is a pure-ish async function: it receives the AI text and a
 * context bag of bound methods/state. It mutates `report` (and, via callbacks
 * on the context, the host's chat history / webview), and returns nothing of
 * note. Behavior must remain byte-for-byte identical to the in-class version.
 */
import type * as vscode from 'vscode';
import type { RecentFileAction } from '../pure-helpers';

export interface ExecuteActionsOpts {
    rootOverride?: string;
    appendToOutput?: (s: string) => void;
    silent?: boolean;
    skipRunCommand?: boolean;
    agentId?: string;
}

/**
 * Surface area the per-action handlers need from `SidebarChatProvider`.
 * Passed in by the coordinator so handlers stay class-free.
 */
export interface ActionContext {
    /** absolute root used to resolve relative paths */
    rootPath: string;
    /** the AI message text we're scanning for action tags */
    aiMessage: string;
    /** mutated by handlers; collected into the method's return value */
    report: string[];
    /** set true if any action touched files inside the brain dir */
    brainModifiedRef: { value: boolean };
    /** mirror of the original opts param from `_executeActions` */
    opts?: ExecuteActionsOpts;

    /* --- bound provider methods / state --- */
    trackFileAction: (agentId: string | undefined, absPath: string, action: 'create' | 'edit' | 'delete') => void;
    fuzzyPathHint: (missingPath: string) => string;
    readBrainFile: (filename: string) => string;
    pushChatHistory: (msg: { role: string; content: string }) => void;
    postWebview: (msg: unknown) => void;
    showTextDocument: (uri: vscode.Uri) => Promise<void>;

    /** read-only snapshot for handlers that need it */
    recentFileActions: ReadonlyArray<RecentFileAction>;
}
