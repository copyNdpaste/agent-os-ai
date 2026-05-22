/**
 * Chat session archive storage. Originally inline on `SidebarChatProvider`;
 * extracted here as stateless helpers that take the VS Code `ExtensionContext`
 * (where the sessions live in `globalState`) as their first argument.
 *
 * Behaviour is byte-for-byte the same as the previous in-class methods —
 * only the location changed.
 */
import * as vscode from 'vscode';
import * as path from 'path';

const SESSIONS_KEY = 'chatSessionsV1';

export interface DisplayMessage { text: string; role: string }
export interface ChatMessage { role: string; content: string }

export interface ChatSession {
    id: string;
    title: string;
    preview: string;
    workspace: string;
    workspaceName: string;
    createdAt: string;
    updatedAt: string;
    messageCount: number;
    chat: ChatMessage[];
    display: DisplayMessage[];
}

/** Read the archived sessions list from globalState (defensive against
 *  legacy non-array values — returns []). */
export function readSessions(ctx: vscode.ExtensionContext): any[] {
    /* v2.89.108 — 타입 any[]로 완화. v2.89.106에선 좁은 타입이었지만, preview·workspace·
       workspaceName 메타가 추가되면서 너무 좁아짐. 내부 storage라 any로 충분. */
    try {
        const arr = ctx.globalState.get<any[]>(SESSIONS_KEY, []);
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}

/** Persist the sessions list, capped at the most recent 50. */
export function writeSessions(ctx: vscode.ExtensionContext, sessions: any[]): void {
    try {
        const trimmed = sessions.slice(0, 50);
        ctx.globalState.update(SESSIONS_KEY, trimmed);
    } catch { /* ignore */ }
}

/* v2.89.108 — 세션을 프로젝트(워크스페이스)별로 그룹화하기 위한 메타 추가 */
export function currentWorkspaceMeta(): { workspace: string; workspaceName: string } {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    let name = '';
    if (root) {
        try { name = path.basename(root); } catch { name = root; }
    } else {
        name = '워크스페이스 없음';
    }
    return { workspace: root, workspaceName: name };
}

/** Snapshot the live chat into a brand-new session entry at the head of the
 *  archive. Returns false (no-op) when the display log is empty. */
export function archiveCurrentChat(
    ctx: vscode.ExtensionContext,
    chatHistory: ChatMessage[],
    displayMessages: DisplayMessage[],
): boolean {
    if (displayMessages.length === 0) return false;
    const sessions = readSessions(ctx);
    const firstUser = displayMessages.find(m => m.role === 'user');
    const titleSrc = firstUser?.text || displayMessages[0]?.text || '대화';
    const title = titleSrc.replace(/\s+/g, ' ').trim().slice(0, 80) || '대화';
    const lastMsg = displayMessages[displayMessages.length - 1];
    const preview = (lastMsg?.text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const now = new Date().toISOString();
    const ws = currentWorkspaceMeta();
    const session: any = {
        id: 'sess-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        title,
        preview,
        workspace: ws.workspace,
        workspaceName: ws.workspaceName,
        createdAt: now,
        updatedAt: now,
        messageCount: displayMessages.length,
        chat: chatHistory,
        display: displayMessages,
    };
    sessions.unshift(session);  /* 최신이 위 */
    writeSessions(ctx, sessions);
    return true;
}

/** Delete a single archived session by id. Returns false if the id is unknown. */
export function deleteSession(ctx: vscode.ExtensionContext, id: string): boolean {
    const sessions = readSessions(ctx);
    const idx = sessions.findIndex(s => s.id === id);
    if (idx < 0) return false;
    sessions.splice(idx, 1);
    writeSessions(ctx, sessions);
    return true;
}

/** v2.89.107 — archive 또는 update. activeId 가 주어졌고 그 세션이 archive에
 *  이미 있으면 그 entry 를 in-place 업데이트(+ 맨 위로 끌어올림). 아니면 새
 *  archiveCurrentChat 으로 fallback. */
export function archiveOrUpdateCurrentChat(
    ctx: vscode.ExtensionContext,
    activeId: string | null,
    chatHistory: ChatMessage[],
    displayMessages: DisplayMessage[],
): boolean {
    if (displayMessages.length === 0) return false;
    const sessions = readSessions(ctx);
    const now = new Date().toISOString();
    if (activeId) {
        const idx = sessions.findIndex(s => s.id === activeId);
        if (idx >= 0) {
            const lastMsg = displayMessages[displayMessages.length - 1];
            const preview = (lastMsg?.text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
            sessions[idx] = {
                ...sessions[idx],
                updatedAt: now,
                messageCount: displayMessages.length,
                preview,
                chat: chatHistory,
                display: displayMessages,
            };
            /* 최신 위로 끌어올림 */
            const updated = sessions.splice(idx, 1)[0];
            sessions.unshift(updated);
            writeSessions(ctx, sessions);
            return true;
        }
    }
    return archiveCurrentChat(ctx, chatHistory, displayMessages);
}
