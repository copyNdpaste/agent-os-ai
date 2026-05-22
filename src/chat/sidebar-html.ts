/**
 * Sidebar webview HTML loader. The actual HTML/CSS/JS lives at
 * `assets/webview/sidebar.html` (see v2.89.59 — the markup was extracted out
 * of the TypeScript file so `node --check` can syntax-verify the webview
 * script before publishing). This module is the thin loader that the class
 * delegates to.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Read the prebuilt sidebar HTML from disk. Returns a tiny error page on
 * read failure so the webview still renders something useful.
 */
export function getSidebarHtml(extensionUri: vscode.Uri): string {
    // v2.89.59 — sidebar webview HTML/CSS/JS extracted to assets/webview/sidebar.html
    // for safer editing and pre-build syntax verification (node --check). Single-file
    // extension.ts had multiple webview-script syntax errors that killed all UI;
    // separate file lets us run node --check before publishing.
    const htmlPath = path.join(extensionUri.fsPath, 'assets', 'webview', 'sidebar.html');
    try {
        return fs.readFileSync(htmlPath, 'utf-8');
    } catch (e: any) {
        return `<!DOCTYPE html><html><body style="background:#111;color:#fff;padding:24px;font-family:-apple-system"><h2>⚠️ Webview HTML 로드 실패</h2><pre>${(e?.message || e).toString()}</pre><p>경로: ${htmlPath}</p></body></html>`;
    }
}
