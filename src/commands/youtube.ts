/* YouTube commands — OAuth connect flow + comment-queue refresh. */

import * as vscode from 'vscode';
import { startYouTubeOAuthFlow } from '../youtube';
import { _youtubeCommentReplyDraftBatch } from '../scaffolders';
import { CompanyDashboardPanel } from '../views';
import type { CommandProviders } from './index';

export function registerYoutubeCommands(
    context: vscode.ExtensionContext,
    providers: CommandProviders
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('agentOs.youtube.connectOAuth', async () => {
            const r = await startYouTubeOAuthFlow();
            if (r.ok) {
                vscode.window.showInformationMessage(r.message);
                providers.ytDashboardProvider?.refresh();
                if (CompanyDashboardPanel.current) CompanyDashboardPanel.current.refresh();
            } else {
                vscode.window.showWarningMessage(r.message);
            }
        }),
        vscode.commands.registerCommand('agentOs.youtube.refreshCommentQueue', async () => {
            try {
                vscode.window.showInformationMessage('📺 YouTube 댓글 가져오는 중...');
                const r = await _youtubeCommentReplyDraftBatch({});
                if (r.reason) {
                    vscode.window.showWarningMessage(`⚠️ ${r.reason}`);
                    return;
                }
                vscode.window.showInformationMessage(
                    `📺 답장 초안 ${r.drafted}건 생성, ${r.skipped}건 스킵 (이미 큐에 있거나 사용자가 답한 댓글). \`approvals/pending/\`에서 확인하거나 텔레그램 \`/approve <id>\`로 게시.`
                );
            } catch (e: any) {
                vscode.window.showErrorMessage(`YouTube 큐 갱신 실패: ${e?.message || e}`);
            }
        })
    );
}
