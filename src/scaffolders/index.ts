/**
 * Scaffolders barrel.
 *
 * Project / draft batch builders that run on demand (button press, slash
 * command, scheduled tool). Distinguished from loops/ because they're NOT
 * setInterval-driven — they fire once per invocation.
 */

export { scaffoldDeveloperProject } from './developer-project';
export { _youtubeCommentReplyDraftBatch } from './youtube-reply-drafter';
