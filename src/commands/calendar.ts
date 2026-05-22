/* Calendar commands — Google Calendar OAuth setup wizard. */

import * as vscode from 'vscode';
import { runConnectGoogleCalendarWrite } from '../calendar';
import type { CommandProviders } from './index';

export function registerCalendarCommands(
    context: vscode.ExtensionContext,
    _providers: CommandProviders
): void {
    context.subscriptions.push(
        /* Google Calendar 자동 일정 등록 (OAuth) */
        vscode.commands.registerCommand('agent-os.connectGoogleCalendarWrite', async () => {
            await runConnectGoogleCalendarWrite();
        })
    );
}
