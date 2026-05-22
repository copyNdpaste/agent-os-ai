/**
 * YouTube comment reply drafter — fetches recent uploads → recent comments →
 * drafts AI replies → creates pending approvals (idempotent on commentId).
 * Triggered from sidebar button or scheduled tool runs.
 *
 * extension.ts 의 `_youtubeCommentReplyDraftBatch` 본문을 byte-for-byte 복사.
 *
 * Deps imported from `../extension`:
 *   - _activeChatProvider    (pulseAgent for office animation)
 *   - _safeReadText
 *   - listPendingApprovals
 *   - _quickLLMCall
 *   - sendTelegramReport     (side-effect replication of extension.ts wrapper)
 *   - appendConversationLog  (side-effect replication of extension.ts wrapper)
 *
 * Deps from sibling modules:
 *   - apv.createApproval     ← '../approvals' (pure file IO)
 *   - AGENTS                 ← '../agents'    (agentLabel resolver)
 *   - getCompanyDir          ← '../paths'
 *   - axios                  ← 'axios'
 *
 * Local `createApproval(req)` helper replicates the extension.ts wrapper at
 * line ~1553 (apv.createApproval + telegram card + conversation log +
 * secretary pulse + agent pulse). The only behavioural deviation: the wrapper
 * also called `_approvalsPanelProvider?.refresh()` — that provider is private
 * to extension.ts so we can't trigger the same refresh from here. Panel will
 * pick up the new approval on its next scheduled refresh / file watch tick.
 * Documented because byte-for-byte across the module boundary required this
 * replication.
 */
import * as path from 'path';
import axios from 'axios';
import {
    _activeChatProvider,
    _safeReadText,
    listPendingApprovals,
    _quickLLMCall,
    sendTelegramReport,
    appendConversationLog,
} from '../extension';
import * as apv from '../approvals';
import { AGENTS } from '../agents';
import { getCompanyDir } from '../paths';

type PendingApproval = apv.PendingApproval;

/* Local createApproval — replicates extension.ts:1553 wrapper minus the
   `_approvalsPanelProvider?.refresh()` call (private to extension.ts). */
function createApproval(req: Omit<PendingApproval, 'id' | 'createdAt'>): PendingApproval {
    const ap = apv.createApproval(getCompanyDir(), req, {
        agentLabel: (id: string) => AGENTS[id]?.name ? `${AGENTS[id].emoji} ${AGENTS[id].name}` : undefined,
    });
    const a = AGENTS[ap.agentId];
    const ownerLine = a ? `${a.emoji} ${a.name}` : ap.agentId;
    /* Telegram card + conversation log + pulse — 모두 vscode/통합
       사이드 이펙트라 wrapper 측에서 처리. */
    sendTelegramReport(`⏳ *승인 대기 (${ownerLine})*\n\n${ap.title}\n\n${ap.summary.slice(0, 300)}\n\n_승인: \`/approve ${ap.id.slice(-9)}\` · 거부: \`/reject ${ap.id.slice(-9)}\`_`).catch(() => { /* silent */ });
    try { appendConversationLog({ speaker: ownerLine, emoji: '⏳', section: '승인 요청', body: `${ap.title} (${ap.kind})\n${ap.summary.slice(0, 300)}` }); } catch { /* ignore */ }
    try {
        _activeChatProvider?.pulseAgent?.(ap.agentId, '⏳', 3500, `${ap.title} 승인 요청`);
        _activeChatProvider?.pulseAgent?.('secretary', '🔔', 3500);
    } catch { /* ignore */ }
    return ap;
}


export async function _youtubeCommentReplyDraftBatch(opts: { maxComments?: number; maxPerVideo?: number } = {}): Promise<{ drafted: number; skipped: number; reason?: string }> {
    /* Office pulse so the user sees youtube agent is working on something
       even when triggered from a button press rather than chat dispatch. */
    try { _activeChatProvider?.pulseAgent?.('youtube', '📺', 4000, '댓글 큐 갱신 중'); } catch { /* ignore */ }
    const cfgPath = path.join(getCompanyDir(), '_agents', 'youtube', 'config.md');
    const cfgTxt = _safeReadText(cfgPath);
    const apiM = cfgTxt.match(/YOUTUBE_API_KEY\s*[:：=]\s*([A-Za-z0-9_\-]+)/);
    const chM  = cfgTxt.match(/YOUTUBE_CHANNEL_ID\s*[:：=]\s*([A-Za-z0-9_\-]+)/);
    if (!apiM || !chM) {
        return { drafted: 0, skipped: 0, reason: 'YOUTUBE_API_KEY 또는 YOUTUBE_CHANNEL_ID 미설정 (`_agents/youtube/config.md`)' };
    }
    const apiKey = apiM[1];
    const channelId = chM[1];
    const maxComments = opts.maxComments ?? 10;
    const maxPerVideo = opts.maxPerVideo ?? 3;
    /* 1) channel → recent uploads playlist */
    let uploads = '';
    try {
        const r = await axios.get(`https://www.googleapis.com/youtube/v3/channels`, {
            params: { part: 'contentDetails', id: channelId, key: apiKey },
            timeout: 10000,
        });
        uploads = r.data?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads || '';
    } catch (e: any) {
        return { drafted: 0, skipped: 0, reason: `채널 조회 실패: ${e?.message || e}` };
    }
    if (!uploads) return { drafted: 0, skipped: 0, reason: '업로드 플레이리스트를 찾지 못함' };
    /* 2) recent video ids */
    let videoIds: string[] = [];
    try {
        const r = await axios.get(`https://www.googleapis.com/youtube/v3/playlistItems`, {
            params: { part: 'contentDetails', playlistId: uploads, maxResults: 5, key: apiKey },
            timeout: 10000,
        });
        videoIds = (r.data?.items || []).map((it: any) => it.contentDetails?.videoId).filter(Boolean);
    } catch (e: any) {
        return { drafted: 0, skipped: 0, reason: `최근 영상 조회 실패: ${e?.message || e}` };
    }
    /* 3) for each video, fetch top comments, draft replies, create approvals.
       Skip comments that already have a pending approval to avoid spam on
       repeated runs. */
    const pendingNow = listPendingApprovals();
    const existingCommentIds = new Set(
        pendingNow
            .filter(a => a.kind === 'youtube.comment_reply')
            .map(a => String(a.payload?.commentId || ''))
    );
    let drafted = 0, skipped = 0;
    for (const videoId of videoIds) {
        if (drafted >= maxComments) break;
        let comments: any[] = [];
        try {
            const r = await axios.get(`https://www.googleapis.com/youtube/v3/commentThreads`, {
                params: { part: 'snippet', videoId, maxResults: maxPerVideo, order: 'time', key: apiKey, textFormat: 'plainText' },
                timeout: 10000,
            });
            comments = r.data?.items || [];
        } catch { continue; /* video may have comments disabled */ }
        for (const c of comments) {
            if (drafted >= maxComments) break;
            const top = c.snippet?.topLevelComment?.snippet;
            const commentId = c.snippet?.topLevelComment?.id;
            if (!top || !commentId) continue;
            if (existingCommentIds.has(commentId)) { skipped++; continue; }
            /* If channel owner has already replied, skip — the conversation
               is owned by a human now. */
            if ((c.snippet?.totalReplyCount || 0) > 0) { skipped++; continue; }
            const author = top.authorDisplayName || '익명';
            const text = (top.textDisplay || '').slice(0, 500);
            let draft = '';
            try {
                draft = await _quickLLMCall(
                    `당신은 1인 크리에이터의 YouTube 댓글 답장 작성기입니다. 친근하고 짧게 (1~3문장), 한국어로, 채널 톤 유지. 욕설·논쟁 회피, 스팸성 댓글은 "감사합니다 ☺️" 같이 짧게.`,
                    `[댓글 작성자] ${author}\n[댓글]\n${text}\n\n위 댓글에 답장 초안을 1~3문장으로.`,
                    200
                );
            } catch { /* skip on draft failure */ continue; }
            const reply = (draft || '').trim();
            if (!reply) continue;
            createApproval({
                agentId: 'youtube',
                title: `${author}님 댓글에 답장`,
                summary: `*원댓글:* ${text.slice(0, 200)}\n\n*답장 초안:* ${reply.slice(0, 300)}`,
                kind: 'youtube.comment_reply',
                payload: { videoId, commentId, replyText: reply, author, originalText: text },
            });
            drafted++;
        }
    }
    return { drafted, skipped };
}
