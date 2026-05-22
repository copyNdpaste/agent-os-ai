/**
 * Barrel for `src/chat/*` — helpers extracted out of `SidebarChatProvider`
 * (src/views/sidebar-chat.ts). The class itself stays in views/; this folder
 * collects the pure / mostly-pure logic that used to bloat it.
 */
export * from './pure-helpers';
export { getSidebarHtml } from './sidebar-html';
export {
    readSessions,
    writeSessions,
    archiveCurrentChat,
    archiveOrUpdateCurrentChat,
    deleteSession,
    currentWorkspaceMeta,
} from './sessions';
