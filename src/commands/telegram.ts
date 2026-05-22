/* Telegram commands — placeholder. Currently the Telegram lifecycle
   (startTelegramPolling / stopTelegramPolling) is driven from activate()
   directly and from sidebar interactions; there are no
   vscode.commands.registerCommand bindings yet. The file exists so the
   barrel + future telegram-specific commands can land here without
   touching the dispatcher in index.ts. */

import * as vscode from 'vscode';
import type { CommandProviders } from './index';

export function registerTelegramCommands(
    _context: vscode.ExtensionContext,
    _providers: CommandProviders
): void {
    /* no-op for now */
}
