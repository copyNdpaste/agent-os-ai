/*
 * Per-agent tool configuration writers.
 *
 * Originally inline in extension.ts. Each tool lives at
 * `_agents/<agentId>/tools/<toolName>.json`. writeToolConfig merges patches
 * onto existing config; setToolEnabled flips just the `_enabled` flag while
 * preserving everything else.
 */

import * as fs from 'fs';
import * as path from 'path';

export function writeToolConfig(
    companyDir: string,
    agentId: string,
    toolName: string,
    config: Record<string, any>,
): void {
    const p = path.join(companyDir, '_agents', agentId, 'tools', `${toolName}.json`);
    let existing: Record<string, any> = {};
    try {
        if (fs.existsSync(p)) existing = JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch { /* malformed — overwrite cleanly */ }
    fs.writeFileSync(p, JSON.stringify({ ...existing, ...config }, null, 2));
}

/** Toggle a single tool's enabled flag without disturbing other config values. */
export function setToolEnabled(
    companyDir: string,
    agentId: string,
    toolName: string,
    enabled: boolean,
): void {
    const p = path.join(companyDir, '_agents', agentId, 'tools', `${toolName}.json`);
    let config: Record<string, any> = {};
    try {
        if (fs.existsSync(p)) config = JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch { /* malformed — overwrite */ }
    if (enabled) {
        delete config._enabled; /* default is enabled, so absence === true */
    } else {
        config._enabled = false;
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(config, null, 2));
}
