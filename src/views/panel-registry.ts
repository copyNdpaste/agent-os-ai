/**
 * Panel registry — tracks which webview panels are currently open so we can
 * restore them on the next extension activation (VS Code reload, window
 * restart, etc).
 *
 * Why this lives here (not in each panel): the panels are independent classes
 * with their own `static createOrShow`. We don't want to litter persistence
 * logic across all of them — one tiny module owns the snapshot.
 *
 * Storage: vscode.ExtensionContext.globalState (single key).
 * Snapshot is a string[] of panel keys (see PANEL_KEYS) — small, safe to
 * persist across machines.
 *
 * Each panel calls `panelRegistry.markOpen(key)` after createOrShow succeeds
 * and `panelRegistry.markClosed(key)` from its onDidDispose. activate() at
 * the end of bootstrap calls `restoreOpenPanels(ctx, providers)` which
 * iterates the snapshot and calls the right createOrShow.
 */
import * as vscode from 'vscode';

/** Stable string identifiers — DO NOT rename casually, they live on disk
 *  inside globalState across upgrades. */
export type PanelKey =
    | 'office'
    | 'company-dashboard'
    | 'api-connections'
    | 'revenue-dashboard';

const STATE_KEY = 'agentOs.openPanels.v1';

/* The context is captured at activate() time. All read/write goes through
   this single reference; tests inject a stub via setContext. */
let _ctx: vscode.ExtensionContext | null = null;

export function setRegistryContext(ctx: vscode.ExtensionContext): void {
    _ctx = ctx;
}

function readSnapshot(): PanelKey[] {
    if (!_ctx) return [];
    try {
        const raw = _ctx.globalState.get<unknown>(STATE_KEY, []);
        if (!Array.isArray(raw)) return [];
        const valid: PanelKey[] = [];
        for (const v of raw) {
            if (v === 'office' || v === 'company-dashboard' || v === 'api-connections' || v === 'revenue-dashboard') {
                valid.push(v);
            }
        }
        return valid;
    } catch { return []; }
}

function writeSnapshot(keys: PanelKey[]): void {
    if (!_ctx) return;
    try {
        /* Dedupe + stable order for diffability. */
        const unique = Array.from(new Set(keys)).sort();
        _ctx.globalState.update(STATE_KEY, unique);
    } catch { /* never break panel lifecycle on persistence failure */ }
}

export function markOpen(key: PanelKey): void {
    const cur = readSnapshot();
    if (cur.includes(key)) return;
    cur.push(key);
    writeSnapshot(cur);
}

export function markClosed(key: PanelKey): void {
    const cur = readSnapshot();
    const next = cur.filter(k => k !== key);
    if (next.length === cur.length) return;
    writeSnapshot(next);
}

export function getOpenPanels(): PanelKey[] {
    return readSnapshot();
}

/** Restore previously-open panels. Call once at end of activate() after all
 *  providers are constructed. Uses lazy require to avoid module-load loops
 *  (the panel modules themselves import this registry). Each panel is opened
 *  in sequence with a tiny delay so they don't all race for ViewColumn.Active.
 *  If a panel's createOrShow throws (e.g. missing deps), the others still try. */
export function restoreOpenPanels(args: {
    chatProvider: import('./sidebar-chat').SidebarChatProvider;
    extensionContext: vscode.ExtensionContext;
}): void {
    const open = readSnapshot();
    if (open.length === 0) return;
    let delay = 50;
    for (const key of open) {
        setTimeout(() => {
            try { _openPanel(key, args); }
            catch (e) { console.warn('[panel-registry] restore failed for', key, e); }
        }, delay);
        delay += 80; /* stagger so columns don't fight */
    }
}

function _openPanel(key: PanelKey, args: {
    chatProvider: import('./sidebar-chat').SidebarChatProvider;
    extensionContext: vscode.ExtensionContext;
}): void {
    switch (key) {
        case 'office': {
            const { OfficePanel } = require('./office-panel');
            OfficePanel.createOrShow(args.extensionContext, args.chatProvider);
            return;
        }
        case 'company-dashboard': {
            const { CompanyDashboardPanel } = require('./company-dashboard');
            CompanyDashboardPanel.createOrShow(args.extensionContext.extensionUri);
            return;
        }
        case 'api-connections': {
            const { ApiConnectionsPanel } = require('./api-connections-panel');
            ApiConnectionsPanel.createOrShow();
            return;
        }
        case 'revenue-dashboard': {
            const { RevenueDashboardPanel } = require('./revenue-dashboard');
            RevenueDashboardPanel.createOrShow();
            return;
        }
    }
}
