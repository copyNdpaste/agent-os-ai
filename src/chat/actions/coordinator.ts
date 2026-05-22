/**
 * Coordinator for per-action handlers. Replaces the body of the original
 * monolithic `_executeActions` method in `src/views/sidebar-chat.ts`. Each
 * handler is invoked in the **same order** as the original method to preserve
 * semantics (some handlers inject into chat history, which subsequent
 * handlers may rely on indirectly via the AI's next turn — order matters).
 *
 * The coordinator takes care of:
 *   1. root-path resolution (workspace → active editor → company → brain)
 *   2. fence-unwrap of ```xml…``` wrappers around action tags
 *   3. dispatching to handlers and aggregating the `report` array
 *   4. post-run side-effects (success toast, brain git auto-sync)
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { _getBrainDir, getCompanyDir } from '../../paths';
import { _safeGitAutoSync } from '../../extension';
import type { ActionContext, ExecuteActionsOpts } from './types';
import type { RecentFileAction } from '../pure-helpers';
import { executeWriteFile } from './write-file';
import { executeEditFile } from './edit-file';
import { executeDeleteFile } from './delete-file';
import { executeReadFile } from './read-file';
import { executeListFiles } from './list-files';
import { executeGlob } from './glob';
import { executeGrep } from './grep';
import { executeRevealInExplorer, executeOpenFile } from './reveal-open';
import { executeRunCommand } from './run-command';
import { executeReadUrl } from './read-url';
import { executeReadBrain } from './read-brain';
import { executeFallbackMarkdown } from './fallback-markdown';

/**
 * Surface the coordinator needs from the host class. Mirrors the bound
 * methods/state the original `_executeActions` body referenced via `this`.
 */
export interface CoordinatorHost {
    trackFileAction(agentId: string | undefined, absPath: string, action: 'create' | 'edit' | 'delete'): void;
    fuzzyPathHint(missingPath: string): string;
    readBrainFile(filename: string): string;
    pushChatHistory(msg: { role: string; content: string }): void;
    postWebview(msg: unknown): void;
    showTextDocument(uri: vscode.Uri, silent?: boolean): Promise<void>;
    recentFileActions: ReadonlyArray<RecentFileAction>;
    /** Passed straight through to `_safeGitAutoSync` (matches original signature). */
    selfForGitSync: unknown;
}

export async function runActionCoordinator(
    aiMessage: string,
    host: CoordinatorHost,
    opts?: ExecuteActionsOpts,
): Promise<string[]> {
    const report: string[] = [];
    const brainModifiedRef = { value: false };

    /* v2.89.93 — root 결정 우선순위:
         1. 호출자가 명시한 rootOverride (회사 모드)
         2. 워크스페이스 폴더
         3. 활성 에디터 디렉토리
         4. 회사 폴더 (회사 모드 활성 시)
         5. 두뇌 폴더 (마지막 fallback)
       이전엔 1·2만 있어서 워크스페이스 미오픈 사용자가 영영 차단됐음. */
    let rootPath = opts?.rootOverride
        || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.scheme === 'file'
            ? path.dirname(vscode.window.activeTextEditor.document.uri.fsPath)
            : undefined);
    let usedFallbackRoot = false;
    if (!rootPath) {
        try {
            const compDir = getCompanyDir();
            if (compDir && fs.existsSync(compDir)) { rootPath = compDir; usedFallbackRoot = true; }
        } catch { /* ignore */ }
    }
    if (!rootPath) {
        try {
            const brainDir = _getBrainDir();
            if (brainDir && fs.existsSync(brainDir)) { rootPath = brainDir; usedFallbackRoot = true; }
        } catch { /* ignore */ }
    }
    if (!rootPath) {
        const hasActions = /<(?:create_file|edit_file|run_command|delete_file|read_file|list_files|file|reveal_in_explorer|open_file|glob|grep)/i.test(aiMessage);
        if (hasActions) {
            report.push('❌ 작업할 폴더를 찾을 수 없습니다. File → Open Folder 로 폴더를 열거나 회사·두뇌 폴더를 먼저 설정해주세요.');
        }
        return report;
    }
    if (usedFallbackRoot) {
        report.push(`📁 워크스페이스 미오픈 — \`${rootPath.replace(os.homedir(), '~')}\` 를 root로 사용합니다.`);
    }

    /* v2.89.95 — fence-unwrap 단순화. 이전 v2.89.93 regex(중첩 lazy + 긴 alternation)는
       특정 입력에서 V8 정규식 엔진의 백트래킹 한계에 부딪힐 가능성이 있어 안전한 라인
       단위 처리로 교체. 액션 태그를 감싸는 ```xml ... ``` 블록만 정확히 unwrap. */
    let processedMessage = aiMessage;
    try {
        processedMessage = processedMessage
            .replace(/```(?:xml|html|action|tool|tools)\s*\n/gi, '')
            .replace(/(<\/(?:create_file|edit_file|delete_file|read_file|list_files|run_command|reveal_in_explorer|open_file|read_url|read_brain|file)>)\s*\n```/gi, '$1');
    } catch { /* defensive — never let unwrap break the path */ }

    const ctx: ActionContext = {
        rootPath,
        aiMessage: processedMessage,
        report,
        brainModifiedRef,
        opts,
        trackFileAction: host.trackFileAction.bind(host),
        fuzzyPathHint: host.fuzzyPathHint.bind(host),
        readBrainFile: host.readBrainFile.bind(host),
        pushChatHistory: host.pushChatHistory.bind(host),
        postWebview: host.postWebview.bind(host),
        showTextDocument: (uri) => host.showTextDocument(uri, opts?.silent),
        recentFileActions: host.recentFileActions,
    };

    // Order mirrors the original method exactly. See sidebar-chat.ts ~line 4674.
    await executeWriteFile(ctx);
    await executeEditFile(ctx);
    await executeDeleteFile(ctx);
    await executeReadFile(ctx);
    await executeListFiles(ctx);
    await executeGlob(ctx);
    await executeGrep(ctx);
    await executeRevealInExplorer(ctx);
    await executeOpenFile(ctx);
    await executeRunCommand(ctx);
    await executeReadUrl(ctx);
    await executeReadBrain(ctx);

    // FALLBACK: If AI used markdown code blocks with filenames instead of XML tags
    if (report.length === 0) {
        await executeFallbackMarkdown(ctx);
    }

    // Show notification — silent suppresses for corporate dispatch (카드 뷰에서 별도 보고됨)
    const successCount = report.filter(r =>
        r.startsWith('✅') || r.startsWith('✏️') || r.startsWith('🖥️') ||
        r.startsWith('🗑️') || r.startsWith('📖') || r.startsWith('📂') ||
        r.startsWith('🗂') || r.startsWith('🚀')
    ).length;
    if (successCount > 0 && !opts?.silent) {
        vscode.window.showInformationMessage(`Agent OS: ${successCount}개 에이전트 작업 완료!`);
    }

    // Auto-Push Second Brain changes to Cloud
    if (brainModifiedRef.value) {
        _safeGitAutoSync(_getBrainDir(), `[P-Reinforce] Auto-synced structured knowledge`, host.selfForGitSync);
    }

    return report;
}
