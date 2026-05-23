/**
 * Extracted from `SidebarChatProvider._handleInjectLocalBrain` in
 * `src/views/sidebar-chat.ts` (~line 2230).
 *
 * Handles drag-and-drop / attachment of local files into the user's Second
 * Brain (`00_Raw/{date}`), routing summaries into matching agents' memory.md,
 * triggering git auto-sync, and finally injecting a hidden system prompt that
 * primes the AI for P-Reinforce structured-knowledge generation on the user's
 * next acknowledgement.
 *
 * Behavior is preserved byte-for-byte from the original in-class method.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { _getBrainDir, _isBrainDirExplicitlySet } from '../../paths';
import { safeResolveInside, safeBasename } from '../../infra/path-safety';
import {
    _ensureBrainDir,
    _safeGitAutoSync,
    routeBrainInjectionToAgents,
} from '../../extension';
import { AGENTS } from '../../agents';

/**
 * Surface area the inject-local-brain helper needs from
 * `SidebarChatProvider`. Mirrors the bound methods/state the original method
 * body referenced via `this`.
 */
export interface InjectLocalBrainHost {
    /** SidebarChatProvider's `_view` field. */
    view: vscode.WebviewView | undefined;
    /** SidebarChatProvider's `_chatHistory` field — pushed-into by this helper. */
    chatHistory: { role: string; content: string }[];
    /** Passed straight through to `_safeGitAutoSync` (matches original signature). */
    selfForGitSync: unknown;
    /** Sends a status update message to the webview. */
    sendStatusUpdate(): void;
    /** Injects a hidden system message into the chat (after a 3s delay). */
    injectSystemMessage(message: string): void;
}

export async function handleInjectLocalBrain(
    host: InjectLocalBrainHost,
    files: any[],
): Promise<void> {
    if (!host.view) return;

    // 폴더 미설정 시 먼저 폴더 선택 강제
    let brainDir: string;
    if (!_isBrainDirExplicitlySet()) {
        const ensured = await _ensureBrainDir();
        if (!ensured) {
            vscode.window.showWarningMessage("📁 지식을 저장할 폴더를 먼저 선택해주세요!");
            return;
        }
        brainDir = ensured;
    } else {
        brainDir = _getBrainDir();
    }

    if (!fs.existsSync(brainDir)) {
        fs.mkdirSync(brainDir, { recursive: true });
    }
    const today = new Date();
    const dateStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    const datePath = path.join(brainDir, '00_Raw', dateStr);

    if (!fs.existsSync(datePath)) {
        fs.mkdirSync(datePath, { recursive: true });
    }

    let injectedTitles: string[] = [];
    const routedAgents = new Set<string>();

    host.view.webview.postMessage({ type: 'response', value: `🧠 **[P-Reinforce 연동 준비]**\n첨부하신 ${files.length}개의 파일을 로컬 두뇌(\`00_Raw/${dateStr}\`)에 입수하고 자동 푸시를 진행합니다.` });

    for (const file of files) {
        try {
            if (typeof file?.name !== 'string' || typeof file?.data !== 'string') continue;
            const fileContent = Buffer.from(file.data, 'base64').toString('utf-8');
            const sanitized = file.name.replace(/[^a-zA-Z0-9가-힣_.-]/gi, '_');
            const safeTitle = safeBasename(sanitized);
            if (!safeTitle) continue;
            const filePath = safeResolveInside(datePath, safeTitle);
            if (!filePath) continue; // path traversal blocked
            fs.writeFileSync(filePath, fileContent, 'utf-8');
            injectedTitles.push(safeTitle);
            /* Route a one-line summary into matching agents' memory.md
               so on next cycle they already see "new knowledge inbound"
               even before scanning the brain folder themselves. Best-effort. */
            try {
                const recipients = routeBrainInjectionToAgents(filePath, safeTitle);
                for (const id of recipients) routedAgents.add(id);
            } catch (e) {
                console.error('Failed to route inject to agent memory:', e);
            }
        } catch (err) {
            console.error('Failed to write brain file:', err);
        }
    }
    /* Surface routing to the user so they know which agents got updated. */
    if (routedAgents.size > 0) {
        const labels = Array.from(routedAgents).map(id => {
            const a = (AGENTS as any)[id];
            return a ? `${a.emoji} ${a.name}` : id;
        }).join(', ');
        host.view.webview.postMessage({ type: 'response', value: `🧠 ${labels} 의 메모리에 새 지식이 자동 연결되었습니다. 다음 사이클부터 활용합니다.` });
    }

    const safeTitles = injectedTitles.join(', ');

    _safeGitAutoSync(brainDir, `Auto-Inject Knowledge [Raw]: ${safeTitles}`, host.selfForGitSync);
    host.sendStatusUpdate();

    setTimeout(() => {
        let combinedContent = '';
        for (const title of injectedTitles) {
            try {
                const content = fs.readFileSync(path.join(datePath, title), 'utf-8');
                combinedContent += `\n\n[원본 데이터: ${title}]\n\`\`\`\n${content.slice(0, 10000)}\n\`\`\``;
            } catch(e) {}
        }

        const hiddenPrompt = `[A.U 시스템 지시: P-Reinforce Architect 모드 활성화]\n새로운 비정형 데이터('${safeTitles}')가 글로벌 두뇌(Second Brain)에 입수 및 클라우드 백업 처리 완료되었습니다.\n\n방금 입수된 데이터의 원본 내용은 아래와 같습니다:${combinedContent}\n\n여기서부터 중요합니다! 마스터가 '응'이나 '진행해' 등으로 동의할 경우, 당신은 절대 대화만으로 대답하지 말고 아래의 [P-Reinforce 구조화 규격]에 따라 곧바로 <create_file> Tool들을 사용하십시오.\n\n[P-Reinforce 구조화 규격]\n1. 폴더 생성: 원본 데이터를 주제별로 쪼개어 절대 경로인 \`${brainDir}/10_Wiki/\` 하위의 적절한 폴더(예: 🛠️ Projects, 💡 Topics, ⚖️ Decisions, 🚀 Skills)에 저장하십시오.\n2. 마크다운 양식 준수: 생성되는 각 문서 파일은 반드시 아래 포맷을 따라야 합니다.\n---\nid: {{UUID}}\ncategory: "[[10_Wiki/설정한_폴더]]"\nconfidence_score: 0.9\ntags: [관련태그]\nlast_reinforced: ${dateStr}\n---\n# [[문서 제목]]\n## 📌 한 줄 통찰\n> (핵심 요약)\n## 📖 구조화된 지식\n- (세부 내용 불렛 포인트)\n## 🔗 지식 연결\n- Parent: [[상위_카테고리]]\n- Related: [[연관_개념]]\n- Raw Source: [[00_Raw/${dateStr}/${safeTitles}]]\n\n지시를 숙지했다면 묻지 말고 즉각 \`<create_file path="${brainDir}/10_Wiki/새폴더/새문서.md">\`를 사용하여 지식을 분해 후 생성하십시오. 완료 후 잘라낸 결과를 보고하십시오.`;
        host.chatHistory.push({ role: 'system', content: hiddenPrompt });

        const uiMsg = "🧠 데이터가 완벽하게 입수되었습니다! 즉시 P-Reinforce 구조화를 시작할까요?";
        host.injectSystemMessage(uiMsg);
    }, 3000);
}
