/* Command registrations split out of activate() by domain. Each
   register* function pushes vscode.commands.registerCommand handles
   onto context.subscriptions so disposal stays automatic. activate()
   instantiates providers + status bars + starts loops, then calls
   registerAll() to wire commands. Behaviour is preserved byte-for-byte
   from the original monolithic activate(). */

import * as vscode from 'vscode';
import { TaskTreeProvider, YouTubeDashboardProvider } from '../views';
import { SidebarChatProvider } from '../views/sidebar-chat';

export interface CommandProviders {
    chatProvider: SidebarChatProvider;
    taskTreeProvider: TaskTreeProvider;
    ytDashboardProvider: YouTubeDashboardProvider;
    extensionUri: vscode.Uri;
    /* Allows dashboard.open to refresh the module-level
       _dashboardExtensionUri (assigned in activate() too, but the
       original command re-set it on every invocation). */
    setDashboardExtensionUri: (uri: vscode.Uri) => void;
}

import { registerChatCommands } from './chat';
import { registerBrainCommands } from './brain';
import { registerTrackerCommands } from './tracker';
import { registerCalendarCommands } from './calendar';
import { registerCompanyCommands } from './company';
import { registerDevCommands } from './dev';
import { registerDashboardCommands } from './dashboard';
import { registerYoutubeCommands } from './youtube';

export {
    registerChatCommands,
    registerBrainCommands,
    registerTrackerCommands,
    registerCalendarCommands,
    registerCompanyCommands,
    registerDevCommands,
    registerDashboardCommands,
    registerYoutubeCommands,
};

export function registerAll(
    context: vscode.ExtensionContext,
    providers: CommandProviders
): void {
    registerDashboardCommands(context, providers);
    registerTrackerCommands(context, providers);
    registerDevCommands(context, providers);
    registerYoutubeCommands(context, providers);
    registerChatCommands(context, providers);
    registerBrainCommands(context, providers);
    registerCompanyCommands(context, providers);
    registerCalendarCommands(context, providers);
}
