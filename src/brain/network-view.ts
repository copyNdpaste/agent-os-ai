/* Neural Construct (Brain) webview launcher.
 *
 * Extracted from extension.ts byte-for-byte. `showBrainNetwork` opens a
 * VS Code webview panel that renders the user's knowledge graph using
 * force-graph.min.js bundled in assets/. It wires AI search "thinking"
 * pulses from the chat provider into the same graph so the user sees the
 * agents searching their brain live.
 *
 * Deps imported from `../extension`:
 *   - _activeChatProvider     (already exported)
 *
 * Deps from extracted modules / siblings:
 *   - _getBrainDir              ← '../paths'
 *   - safeResolveInside         ← '../infra/path-safety'
 *   - buildKnowledgeGraph       ← './graph-builder'
 *   - _RENDER_GRAPH_HTML        ← './graph-html'
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { _getBrainDir } from '../paths';
import { safeResolveInside } from '../infra/path-safety';
import { _activeChatProvider } from '../extension';

import { buildKnowledgeGraph } from './graph-builder';
import { _RENDER_GRAPH_HTML } from './graph-html';

export async function showBrainNetwork(_context: vscode.ExtensionContext) {
    let panel: vscode.WebviewPanel | undefined;
    try {
        const assetsRoot = vscode.Uri.file(path.join(_context.extensionPath, 'assets'));
        panel = vscode.window.createWebviewPanel(
            'brainTopology',
            'Neural Construct (Brain)',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [assetsRoot] }
        );

        // Hook this panel into the chat provider's thinking-event broadcast,
        // so AI search activity pulses on this graph too — not just on the
        // separate Thinking Mode panel.
        _activeChatProvider?.registerExternalGraphPanel(panel);

        const brainDir = _getBrainDir();
        const graph = buildKnowledgeGraph(brainDir);
        const isEmpty = graph.nodes.length === 0;

        // Handle messages from webview (e.g., open file requests)
        panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'openFile' && typeof msg.id === 'string') {
                const safe = safeResolveInside(brainDir, msg.id);
                if (safe && fs.existsSync(safe)) {
                    const doc = await vscode.workspace.openTextDocument(safe);
                    vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
                }
            }
        });

        const graphJson = JSON.stringify({
            nodes: graph.nodes.map(n => ({
                id: n.id, name: n.name, folder: n.folder, tags: n.tags,
                connections: n.incoming + n.outgoing
            })),
            links: graph.links
        });

        const forceGraphSrc = panel.webview.asWebviewUri(
            vscode.Uri.file(path.join(_context.extensionPath, 'assets', 'force-graph.min.js'))
        ).toString();
        const html = _RENDER_GRAPH_HTML(graphJson, isEmpty, forceGraphSrc, panel.webview.cspSource);
        // Defensive: if HTML somehow comes back falsy, surface that explicitly
        // instead of letting the webview coerce it into the literal string "null".
        if (typeof html !== 'string' || !html) {
            throw new Error('_RENDER_GRAPH_HTML returned non-string: ' + typeof html);
        }
        panel.webview.html = html;
    } catch (err: any) {
        const detail = err?.stack || err?.message || String(err);
        console.error('showBrainNetwork failed:', detail);
        vscode.window.showErrorMessage('지식 네트워크 열기 실패: ' + (err?.message || String(err)));
        if (panel) {
            const safe = String(detail).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'} as any)[c]);
            panel.webview.html = '<!DOCTYPE html><html><body style="background:#000;color:#B8B8C2;font-family:-apple-system,SF Pro Display,sans-serif;padding:40px;line-height:1.55"><div style="font-family:SF Mono,monospace;font-size:10px;letter-spacing:3px;color:rgba(0,255,65,.55);text-transform:uppercase;margin-bottom:18px">CONNECT · AI</div><h2 style="color:#00FF41;margin-top:0;text-shadow:0 0 14px rgba(0,255,65,.3)">⚠️ 지식 네트워크 로드 실패</h2><div style="color:#9090A0;font-size:13px;margin-bottom:14px">아래 에러 메시지를 그대로 알려주세요.</div><pre style="color:#B8B8C2;background:#0a0d0a;border:1px solid rgba(0,255,65,.15);padding:14px;border-radius:10px;overflow:auto;font-size:12px;font-family:SF Mono,JetBrains Mono,monospace">' + safe + '</pre></body></html>';
        }
    }
}
