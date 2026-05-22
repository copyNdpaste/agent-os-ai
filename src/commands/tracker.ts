/* Task tracker sidebar commands — refresh, mark-done, cancel,
   set-priority, and open-tracker-json. All driven by the
   TaskTreeProvider sidebar items. */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TaskTreeItem } from '../views';
import { getCompanyDir } from '../paths';
import { updateTrackerTask, type TaskPriority } from '../extension';
import type { CommandProviders } from './index';

export function registerTrackerCommands(
    context: vscode.ExtensionContext,
    providers: CommandProviders
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('agentOs.tasks.refresh', () => {
            providers.taskTreeProvider?.refresh();
        }),
        vscode.commands.registerCommand('agentOs.tasks.markDone', (item: TaskTreeItem) => {
            if (item?.task) {
                updateTrackerTask(item.task.id, { status: 'done', evidence: '사이드바에서 완료 처리' });
            }
        }),
        vscode.commands.registerCommand('agentOs.tasks.cancel', async (item: TaskTreeItem) => {
            if (!item?.task) return;
            const ok = await vscode.window.showWarningMessage(
                `"${item.task.title}" 취소할까요?`,
                { modal: false },
                '취소', '뒤로'
            );
            if (ok === '취소') {
                updateTrackerTask(item.task.id, { status: 'cancelled', evidence: '사이드바에서 취소' });
            }
        }),
        vscode.commands.registerCommand('agentOs.tasks.setPriority', async (item: TaskTreeItem) => {
            if (!item?.task) return;
            const pick = await vscode.window.showQuickPick(
                [
                    { label: '🔴 긴급 (urgent)', value: 'urgent' as TaskPriority },
                    { label: '🟠 높음 (high)',   value: 'high'   as TaskPriority },
                    { label: '⚪ 보통 (normal)', value: 'normal' as TaskPriority },
                    { label: '🔵 낮음 (low)',    value: 'low'    as TaskPriority },
                ],
                { placeHolder: '우선순위 선택' }
            );
            if (pick) {
                updateTrackerTask(item.task.id, { priority: pick.value });
            }
        }),
        vscode.commands.registerCommand('agentOs.tasks.openTrackerJson', async () => {
            try {
                const p = path.join(getCompanyDir(), '_shared', 'tracker.json');
                if (!fs.existsSync(p)) {
                    vscode.window.showInformationMessage('아직 tracker.json 이 없어요. 작업이 등록되면 생성됩니다.');
                    return;
                }
                const doc = await vscode.workspace.openTextDocument(p);
                await vscode.window.showTextDocument(doc);
            } catch (e: any) {
                vscode.window.showErrorMessage(`tracker.json 열기 실패: ${e?.message || e}`);
            }
        })
    );
}
