/* Brain / knowledge graph commands — currently just the brain-network
   topology viewer. */

import * as vscode from 'vscode';
import { showBrainNetwork } from '../brain';
import type { CommandProviders } from './index';

export function registerBrainCommands(
    context: vscode.ExtensionContext,
    _providers: CommandProviders
): void {
    // Show Brain Network Topology
    context.subscriptions.push(
        vscode.commands.registerCommand('agent-os.showBrainNetwork', () => {
            showBrainNetwork(context);
        })
    );
}
