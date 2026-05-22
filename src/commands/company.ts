/* Company-scope commands — virtual office panel, settings menu
   passthrough, company directory location change, and the
   company-specific GitHub repo connection wizard. */

import * as vscode from 'vscode';
import { OfficePanel } from '../views';
import { runChangeCompanyDir, runConnectCompanyRepo } from '../company/structure';
import type { CommandProviders } from './index';

export function registerCompanyCommands(
    context: vscode.ExtensionContext,
    providers: CommandProviders
): void {
    const provider = providers.chatProvider;

    // 🏢 Open virtual office (스몰빌식 가상 사무실)
    context.subscriptions.push(
        vscode.commands.registerCommand('agent-os.openOffice', () => {
            OfficePanel.createOrShow(context, provider);
        }),
        /* v2.89.96 — 사이드바 ⋯ 메뉴가 어떤 이유로 클릭 안 받을 때를 대비한
           명령 팔레트 fallback. Cmd/Ctrl+Shift+P → "Agent OS: 설정 열기" */
        vscode.commands.registerCommand('agent-os.openSettings', async () => {
            try { await (provider as any)._handleSettingsMenu?.(); }
            catch (e: any) {
                vscode.window.showErrorMessage(`설정 메뉴 열기 실패: ${e?.message || e}`);
            }
        }),
        /* 회사 폴더 위치 변경 — 두뇌 안 nested vs 완전 분리 선택 */
        vscode.commands.registerCommand('agent-os.changeCompanyDir', async () => {
            await runChangeCompanyDir();
        }),
        /* 회사 GitHub 별도 연결 — 두뇌와 분리된 repo로 백업 */
        vscode.commands.registerCommand('agent-os.connectCompanyRepo', async () => {
            await runConnectCompanyRepo();
        })
    );
}
