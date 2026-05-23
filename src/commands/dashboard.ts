/* Dashboard panel commands — full-screen webview entries for the
   "회사 둘러보기" (CompanyDashboardPanel), API Connections, and the
   Revenue dashboard. The dashboard.open handler also refreshes the
   module-level _dashboardExtensionUri (mirrors the original behaviour
   from extension.ts where the URI was rebound on every invocation). */

import * as vscode from 'vscode';
import { CompanyDashboardPanel, ApiConnectionsPanel, RevenueDashboardPanel } from '../views';
import type { CommandProviders } from './index';

export function registerDashboardCommands(
    context: vscode.ExtensionContext,
    providers: CommandProviders
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('agentOs.dashboard.open', () => {
            try {
                providers.setDashboardExtensionUri(context.extensionUri);
                CompanyDashboardPanel.createOrShow(context.extensionUri);
            } catch (e: any) {
                /* v2.89.14 — 진단: 대시보드 패널 생성 실패 시 사용자에게 안내. */
                vscode.window.showErrorMessage(`👥 에이전트 업무 대시보드 열기 실패: ${e?.message || e}. (Cmd+Shift+P → "Developer: Reload Window" 시도)`);
                console.error('[dashboard.open] failed:', e);
            }
        }),
        vscode.commands.registerCommand('agentOs.apiConnections.open', () => {
            ApiConnectionsPanel.createOrShow();
        }),
        /* v2.89.137 — 매출 대시보드 (PayPal 시각화) */
        vscode.commands.registerCommand('agentOs.revenueDashboard.open', () => {
            RevenueDashboardPanel.createOrShow();
        })
    );
}
