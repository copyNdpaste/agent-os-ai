/**
 * Extracted from `SidebarChatProvider._handleBrainMenu` in
 * `src/views/sidebar-chat.ts` (~line 2329).
 *
 * Second Brain menu (QuickPick): manages local brain folder, online (GitHub)
 * repo, manual sync, network graph view, and cleanup of either connection.
 *
 * Behavior is preserved byte-for-byte from the original in-class method.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { _getBrainDir, _isBrainDirExplicitlySet } from '../../paths';
import {
    gitExec,
    gitExecSafe,
    validateGitRemoteUrl,
} from '../../infra/git';

/**
 * Surface area the brain menu helper needs from `SidebarChatProvider`.
 * Mirrors the bound methods/state the original method body referenced via
 * `this`.
 */
export interface BrainMenuHost {
    /** SidebarChatProvider's `_view` field. */
    view: vscode.WebviewView | undefined;
    /** SidebarChatProvider's `_ctx` field. */
    ctx: vscode.ExtensionContext;
    /** Mirror of `_brainEnabled` — read AND written by this menu. */
    setBrainEnabled(value: boolean): void;
    /** Walks the brain dir and returns all .md file paths. */
    findBrainFiles(dir: string): string[];
    /** Triggers a full GitHub sync (delegates to `_syncSecondBrain`). */
    syncSecondBrain(): Promise<void>;
    /** Sends a status update message to the webview. */
    sendStatusUpdate(): void;
}

export async function handleBrainMenu(host: BrainMenuHost): Promise<void> {
    if (!host.view) { return; }

    const brainDir = _getBrainDir();
    const brainFiles = fs.existsSync(brainDir) ? host.findBrainFiles(brainDir) : [];
    const fileCount = brainFiles.length;

    const currentRepo = vscode.workspace.getConfiguration('agentOs').get<string>('secondBrainRepo', '');
    const repoLabel = currentRepo ? currentRepo.split('/').pop() : '없음';

    const items: any[] = [
        { label: '☁️ 온라인 지식 공간', description: currentRepo ? `GitHub: ${repoLabel}` : 'GitHub 주소 설정', action: 'changeGithub' },
        { label: '📁 로컬 지식 공간', description: brainDir ? `폴더: ${path.basename(brainDir)} (${fileCount}개 파일)` : '폴더 위치 설정', action: 'changeFolder' },
        { label: '🔄 지금 백업', description: '온라인과 로컬 동기화', action: 'githubSync' },
        { label: '🌐 네트워크 보기', description: '지식 연결 그래프', action: 'viewGraph' },
        { label: '🗑️ 삭제', description: 'GitHub 연결 또는 로컬 폴더 분리', action: 'cleanup' },
    ];

    const pick = await vscode.window.showQuickPick(items, { placeHolder: '🧠 지식 공간 관리' });
    if (!pick) return;

    switch (pick.action) {
        case 'listFiles': {
            if (fileCount === 0) {
                const action = await vscode.window.showInformationMessage(
                    '📂 아직 저장된 지식이 없어요. 지식 폴더에 .md 파일을 넣어주세요!',
                    '📁 지식 폴더 열기'
                );
                if (action === '📁 지식 폴더 열기') {
                    if (!fs.existsSync(brainDir)) fs.mkdirSync(brainDir, { recursive: true });
                    vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(brainDir));
                }
            } else {
                const fileItems = brainFiles.slice(0, 50).map(f => {
                    const rel = path.relative(brainDir, f);
                    let title = '';
                    try { title = fs.readFileSync(f, 'utf-8').split('\n').find(l => l.trim().length > 0)?.replace(/^#+\s*/, '').slice(0, 60) || ''; } catch {}
                    return { label: `📄 ${rel}`, description: title, filePath: f };
                });
                const selected = await vscode.window.showQuickPick(fileItems, {
                    placeHolder: `📂 내 지식 파일 (총 ${fileCount}개) — 클릭하면 내용을 볼 수 있어요`
                });
                if (selected) {
                    const doc = await vscode.workspace.openTextDocument(selected.filePath);
                    vscode.window.showTextDocument(doc);
                }
            }
            break;
        }
        case 'changeFolder': {
            const folders = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: '이 폴더를 내 지식 폴더로 사용',
                title: '📁 AI에게 읽혀줄 지식(.md 파일)이 들어있는 폴더를 선택하세요'
            });
            if (folders && folders.length > 0) {
                const selectedPath = folders[0].fsPath;
                await vscode.workspace.getConfiguration('agentOs').update('localBrainPath', selectedPath, vscode.ConfigurationTarget.Global);
                host.setBrainEnabled(true);
                host.ctx.globalState.update('brainEnabled', true);

                // 새 폴더에 git이 없으면 자동 초기화 + 기존 깃허브 URL로 remote 재연결
                const newGitDir = path.join(selectedPath, '.git');
                if (!fs.existsSync(newGitDir)) {
                    try {
                        gitExec(['init'], selectedPath);
                        gitExecSafe(['branch', '-M', 'main'], selectedPath);

                        const existingRepo = vscode.workspace.getConfiguration('agentOs').get<string>('secondBrainRepo', '');
                        const cleanRepo = existingRepo ? validateGitRemoteUrl(existingRepo) : null;
                        if (cleanRepo) {
                            gitExecSafe(['remote', 'add', 'origin', cleanRepo], selectedPath);
                        }
                    } catch (e) {
                        console.warn('Git init on new brain folder failed:', e);
                    }
                }

                const newFiles = host.findBrainFiles(selectedPath);
                vscode.window.showInformationMessage(`✅ 지식 폴더가 변경되었어요! (${newFiles.length}개 지식 파일 발견)`);
                host.view.webview.postMessage({ type: 'response', value: `🧠 **지식 폴더 연결 완료!**\n📁 ${selectedPath}\n📄 ${newFiles.length}개의 지식 파일을 읽고 있어요.` });
            }
            break;
        }
        case 'resync': {
            host.setBrainEnabled(true);
            host.ctx.globalState.update('brainEnabled', true);
            const refreshedFiles = host.findBrainFiles(brainDir);
            vscode.window.showInformationMessage(`🔄 지식 새로고침 완료! (${refreshedFiles.length}개)`);
            host.view.webview.postMessage({ type: 'response', value: `🔄 **지식 새로고침 완료!** ${refreshedFiles.length}개 지식이 연결되어 있어요.\n\n지식 모드가 ON 되었습니다.` });
            break;
        }
        case 'viewGraph': {
            vscode.commands.executeCommand('agent-os.showBrainNetwork');
            break;
        }
        case 'githubSync': {
            await host.syncSecondBrain();
            break;
        }
        case 'changeGithub': {
            const existing = vscode.workspace.getConfiguration('agentOs').get<string>('secondBrainRepo', '');
            const inputUrl = await vscode.window.showInputBox({
                prompt: '☁️ 온라인 지식 공간 — GitHub 주소 (Enter로 저장)',
                placeHolder: '예: https://github.com/사용자명/저장소이름',
                value: existing,
                ignoreFocusOut: true,
                validateInput: (val) => {
                    const v = (val || '').trim();
                    if (!v) return null;
                    if (validateGitRemoteUrl(v)) return null;
                    return '⚠️ 형식: https://github.com/사용자/저장소  또는  git@github.com:사용자/저장소.git';
                }
            });
            if (inputUrl !== undefined && inputUrl.trim()) {
                const cleaned = validateGitRemoteUrl(inputUrl) || inputUrl.trim();
                await vscode.workspace.getConfiguration('agentOs').update('secondBrainRepo', cleaned, vscode.ConfigurationTarget.Global);
                const saved = vscode.workspace.getConfiguration('agentOs').get<string>('secondBrainRepo', '');
                vscode.window.showInformationMessage(`✅ 온라인 지식 공간 저장됨: ${saved}`);
                host.sendStatusUpdate();
            }
            break;
        }
        case 'cleanup': {
            const cfg = vscode.workspace.getConfiguration('agentOs');
            const hasGit = !!(cfg.get<string>('secondBrainRepo', '') || '');
            const hasFolder = _isBrainDirExplicitlySet();

            const items: any[] = [];
            if (hasGit) items.push({ label: '☁️ 온라인 지식 공간 연결만 끊기', description: '파일은 그대로, GitHub 주소만 제거', kind: 'github' });
            if (hasFolder) items.push({ label: '📁 로컬 지식 공간 연결만 분리', description: '파일은 디스크에 그대로, 익스텐션에서만 분리', kind: 'folder' });
            if (items.length === 0) {
                vscode.window.showInformationMessage('지울 연결이 없어요. 이미 깨끗합니다 ✨');
                break;
            }
            items.push({ label: '⛔ 취소', kind: 'cancel' });

            const pick2 = await vscode.window.showQuickPick(items, { placeHolder: '🗑️ 무엇을 끊을까요?' });
            if (!pick2 || pick2.kind === 'cancel') break;

            if (pick2.kind === 'github') {
                const confirm = await vscode.window.showWarningMessage(
                    '☁️ 온라인 지식 공간 연결을 끊을까요?\n\n• GitHub 저장소 주소만 제거됩니다\n• 로컬 파일과 GitHub 저장소 자체는 그대로 남아요',
                    { modal: true },
                    '☁️ 끊기',
                    '⛔ 취소'
                );
                if (confirm === '☁️ 끊기') {
                    await cfg.update('secondBrainRepo', '', vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage('☁️ 온라인 지식 공간 연결 해제됨.');
                    host.sendStatusUpdate();
                }
            } else if (pick2.kind === 'folder') {
                const confirm = await vscode.window.showWarningMessage(
                    '📁 로컬 지식 공간 연결을 분리할까요?\n\n• 익스텐션이 더 이상 이 폴더를 참조하지 않습니다\n• 디스크의 파일은 그대로 남아요 (수동 삭제 안 함)',
                    { modal: true },
                    '📁 분리',
                    '⛔ 취소'
                );
                if (confirm === '📁 분리') {
                    await cfg.update('localBrainPath', '', vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage('📁 로컬 지식 공간 연결 분리됨.');
                    host.sendStatusUpdate();
                }
            }
            break;
        }
    }
}
