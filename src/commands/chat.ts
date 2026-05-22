/* Sidebar chat commands — new chat, export, focus input, explain
   selection. All routed through SidebarChatProvider. */

import * as vscode from 'vscode';
import type { CommandProviders } from './index';

export function registerChatCommands(
    context: vscode.ExtensionContext,
    providers: CommandProviders
): void {
    const provider = providers.chatProvider;

    // New Chat
    context.subscriptions.push(
        vscode.commands.registerCommand('agent-os.newChat', () => {
            provider.resetChat();
        })
    );

    // Export Chat as Markdown
    context.subscriptions.push(
        vscode.commands.registerCommand('agent-os.exportChat', async () => {
            await provider.exportChat();
        })
    );

    // Focus Chat Input (Cmd+L)
    context.subscriptions.push(
        vscode.commands.registerCommand('agent-os.focusChat', () => {
            provider.focusInput();
        })
    );

    // Explain Selected Code (right-click menu)
    context.subscriptions.push(
        vscode.commands.registerCommand('agent-os.explainSelection', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { return; }
            const selection = editor.document.getText(editor.selection);
            if (selection.trim()) {
                provider.sendPromptFromExtension(`이 코드를 분석하고 설명해줘:\n\`\`\`\n${selection}\n\`\`\``);
            }
        })
    );
}
