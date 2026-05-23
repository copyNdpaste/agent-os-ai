/**
 * Pure / mostly-pure helper functions extracted from `SidebarChatProvider`
 * (src/views/sidebar-chat.ts). Each function below either takes all its inputs
 * as arguments (no implicit `this` state) or reads from the file system /
 * workspace only — never from instance fields.
 *
 * The originating class methods now delegate to these so the class body shrinks
 * dramatically. Behaviour is byte-for-byte identical to the previous inline
 * implementation; only the location has moved.
 *
 * Caller convention — when a helper needs ephemeral state that used to live on
 * the class (e.g. `_recentFileActions`), the caller passes that state in
 * explicitly. This keeps these functions trivially unit-testable.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { safeResolveInside } from '../infra/path-safety';
import { pythonCmd as _pythonCmd } from '../infra/python';
import { _getBrainDir, getCompanyDir } from '../paths';
import { AGENTS } from '../agents';
import {
    getConfig,
    EXCLUDED_DIRS,
    _RENDER_GRAPH_HTML,
    type BrainGraph,
    isAgentActive,
    _safeReadText,
} from '../extension';

// ---------------------------------------------------------------------------
// Recent file action — shape originally declared inline on the class. Hoisted
// so helpers that consume it (fuzzyPathHint / buildRecentFilesContext) have a
// shared type.
// ---------------------------------------------------------------------------
export interface RecentFileAction {
    agentId: string;
    absPath: string;
    action: 'create' | 'edit' | 'delete';
    ts: number;
}

// ---------------------------------------------------------------------------
// Action-tag stripping — used before piping AI output to the chat renderer so
// the user doesn't see raw <create_file>, <run_command> etc. tags.
// ---------------------------------------------------------------------------
export function stripActionTags(text: string): string {
    return text
        .replace(/<(?:create_file|write_file|file)\s+[^>]*>[\s\S]*?<\/(?:create_file|write_file|file)>/gi, '')
        .replace(/<(?:edit_file|edit)\s+[^>]*>[\s\S]*?<\/(?:edit_file|edit)>/gi, '')
        .replace(/<(?:delete_file|delete)\s+[^>]*\s*\/?>(?:<\/(?:delete_file|delete)>)?/gi, '')
        .replace(/<(?:read_file|read)\s+[^>]*\s*\/?>(?:<\/(?:read_file|read)>)?/gi, '')
        .replace(/<(?:list_files|list_dir|ls)\s+[^>]*\s*\/?>(?:<\/(?:list_files|list_dir|ls)>)?/gi, '')
        .replace(/<(?:reveal_in_explorer|reveal|finder|explorer)\s+[^>]*\s*\/?>(?:<\/(?:reveal_in_explorer|reveal|finder|explorer)>)?/gi, '')
        .replace(/<(?:open_file|open_in_app|launch)\s+[^>]*\s*\/?>(?:<\/(?:open_file|open_in_app|launch)>)?/gi, '')
        .replace(/<glob\s+[^>]*\s*\/?>(?:<\/glob>)?/gi, '')
        .replace(/<grep\s+[^>]*\s*\/?>(?:<\/grep>)?/gi, '')
        .replace(/<(?:run_command|command|bash|terminal)>[\s\S]*?<\/(?:run_command|command|bash|terminal)>/gi, '')
        .replace(/<(?:read_brain)>[\s\S]*?<\/(?:read_brain)>/gi, '')
        .replace(/<(?:read_url|url|fetch_url)>[\s\S]*?<\/(?:read_url|url|fetch_url)>/gi, '')
        .trim();
}

// ---------------------------------------------------------------------------
// Build the cinematic thinking-mode HTML. Pure formatting — graph in,
// HTML string out.
// ---------------------------------------------------------------------------
export function buildThinkingHtml(graph: BrainGraph, forceGraphSrc: string, cspSource: string): string {
    const graphJson = JSON.stringify({
        nodes: graph.nodes.map(n => ({
            id: n.id, name: n.name, folder: n.folder, tags: n.tags,
            connections: n.incoming + n.outgoing,
        })),
        links: graph.links,
    });
    const isEmpty = graph.nodes.length === 0;
    return _RENDER_GRAPH_HTML(graphJson, isEmpty, forceGraphSrc, cspSource);
}

// ---------------------------------------------------------------------------
// Recursive .md/.txt scanner for the local Second Brain folder. Skips noisy
// folders (.git / node_modules / .obsidian) and absorbs unreadable directories.
// ---------------------------------------------------------------------------
export function findBrainFiles(dir: string): string[] {
    let results: string[] = [];
    try {
        const list = fs.readdirSync(dir);
        for (const file of list) {
            const filePath = path.join(dir, file);
            const stat = fs.statSync(filePath);
            if (stat && stat.isDirectory()) {
                if (file !== '.git' && file !== 'node_modules' && file !== '.obsidian') {
                    results = results.concat(findBrainFiles(filePath));
                }
            } else {
                if (file.endsWith('.md') || file.endsWith('.txt')) {
                    results.push(filePath);
                }
            }
        }
    } catch (e) { /* skip unreadable dirs */ }
    return results;
}

// ---------------------------------------------------------------------------
// Build the "second brain" table-of-contents block injected into the system
// prompt. Only an index (first heading line per file) — the AI calls
// <read_brain> to fetch the actual contents.
// ---------------------------------------------------------------------------
export function getSecondBrainContext(): string {
    const brainDir = _getBrainDir();
    if (!fs.existsSync(brainDir)) return '';

    const files = findBrainFiles(brainDir);
    if (files.length === 0) return '';

    // 컨텍스트 폭발 크래시(OOM)를 방지하기 위해 최대 인덱스 개수 제한
    const MAX_INDEX = 200;
    const index: string[] = [];
    let truncated = false;

    for (let i = 0; i < files.length; i++) {
        if (i >= MAX_INDEX) {
            truncated = true;
            break;
        }
        const file = files[i];
        const relativePath = path.relative(brainDir, file);
        try {
            const firstLine = fs.readFileSync(file, 'utf-8').split('\n').find(l => l.trim().length > 0) || '';
            // 제목 부분만 추출 (# 헤더 또는 첫 줄)
            const title = firstLine.replace(/^#+\s*/, '').slice(0, 80);
            index.push(`  📄 ${relativePath}  →  "${title}"`);
        } catch {
            index.push(`  📄 ${relativePath}`);
        }
    }

    const msgLimit = truncated ? `\n(⚠️ 메모리 폭발 방지를 위해 상위 ${MAX_INDEX}개 파일의 목차만 표시됩니다.)` : '';

    return `\n\n[CRITICAL: SECOND BRAIN INDEX — User's Personal Knowledge Base (${files.length} documents)]\nThe user has synced a personal knowledge repository. Below is the TABLE OF CONTENTS.${msgLimit}\nIf the user's query is even slightly related to any topics in this index, YOU MUST FIRST READ the relevant document BEFORE answering.\nTo read the actual content of any document, use EXACTLY this syntax: <read_brain>filename_or_path</read_brain>\nYou can call <read_brain> multiple times. ALWAYS READ THE FULL DOCUMENT BEFORE ANSWERING.\n\n**IMPORTANT: When your answer uses knowledge from the Second Brain, you MUST end your response with a "📚 출처" section listing the file(s) you referenced. Example:\n📚 출처: MrBeast_분석.md, 마케팅_전략.md**\n\n${index.join('\n')}\n\n`;
}

// ---------------------------------------------------------------------------
// Resolve a brain filename to its content. Honours path-traversal safety —
// any resolution outside `_getBrainDir()` is rejected.
// ---------------------------------------------------------------------------
export function readBrainFile(filename: string): string {
    const brainDir = _getBrainDir();
    if (!fs.existsSync(brainDir)) return '[ERROR] Second Brain이 동기화되지 않았습니다. 🧠 버튼을 먼저 눌러주세요.';

    // Path traversal 방어: brainDir 밖으로 나가는 경로는 차단
    const exactPath = safeResolveInside(brainDir, filename);
    if (exactPath && fs.existsSync(exactPath) && fs.statSync(exactPath).isFile()) {
        const content = fs.readFileSync(exactPath, 'utf-8');
        return content.slice(0, 8000); // 파일당 최대 8000자
    }

    // 파일명만으로 퍼지 검색 (하위 폴더에 있을 수 있으므로)
    const baseOnly = path.basename(filename);
    const allFiles = findBrainFiles(brainDir);
    const match = allFiles.find(f =>
        path.basename(f) === baseOnly ||
        path.basename(f) === baseOnly + '.md' ||
        (baseOnly.length > 2 && f.includes(baseOnly))
    );

    if (match) {
        // 결과 파일이 brainDir 안인지 한 번 더 확인
        const resolved = path.resolve(match);
        if (resolved.startsWith(path.resolve(brainDir) + path.sep)) {
            const content = fs.readFileSync(resolved, 'utf-8');
            return content.slice(0, 8000);
        }
    }

    return `[NOT FOUND] "${filename}" 파일을 Second Brain에서 찾을 수 없습니다. 목차(INDEX)를 다시 확인해주세요.`;
}

// ---------------------------------------------------------------------------
// CLAUDE.md-compatible project memory loader. Scans workspace + parents +
// global ~/.agent-os-ai/global.md for project-scoped rules / preferences.
// ---------------------------------------------------------------------------
export function getProjectMemory(): string {
    const candidatePaths: string[] = [];
    const tried = new Set<string>();
    const filenames = ['AGENT.md', 'AGENT-OS-AI.md', 'AGENTOSAI.md', 'CLAUDE.md', '.agent-os-ai/instructions.md'];
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const editor = vscode.window.activeTextEditor;
    const roots: string[] = [];
    if (root) roots.push(root);
    if (editor && editor.document.uri.scheme === 'file') {
        const dir = path.dirname(editor.document.uri.fsPath);
        if (!roots.includes(dir)) roots.push(dir);
    }
    /* 워크스페이스 root + 부모 root */
    for (const r of roots) {
        for (const fn of filenames) {
            candidatePaths.push(path.join(r, fn));
        }
        const parent = path.dirname(r);
        if (parent !== r) {
            for (const fn of filenames) candidatePaths.push(path.join(parent, fn));
        }
    }
    /* 홈 디렉토리 글로벌 메모리 */
    try {
        candidatePaths.push(path.join(os.homedir(), '.agent-os-ai', 'global.md'));
    } catch { /* ignore */ }
    const blocks: string[] = [];
    let totalChars = 0;
    const FILE_CAP = 8 * 1024;
    const TOTAL_CAP = 24 * 1024;
    for (const p of candidatePaths) {
        if (tried.has(p)) continue;
        tried.add(p);
        try {
            if (!fs.existsSync(p)) continue;
            const stat = fs.statSync(p);
            if (!stat.isFile() || stat.size === 0) continue;
            const raw = fs.readFileSync(p, 'utf-8');
            const truncated = raw.length > FILE_CAP;
            const body = truncated ? raw.slice(0, FILE_CAP) + '\n[…잘림…]' : raw;
            const display = p.replace(os.homedir(), '~');
            blocks.push(`### 📌 ${display}\n${body.trim()}`);
            totalChars += body.length;
            if (totalChars >= TOTAL_CAP) break;
        } catch { /* skip unreadable */ }
    }
    if (blocks.length === 0) return '';
    return `\n\n[PROJECT MEMORY — 사용자가 명시적으로 정한 프로젝트 규칙·금지사항·우선순위. 절대 무시하지 말 것.]\n${blocks.join('\n\n')}`;
}

// ---------------------------------------------------------------------------
// Build a workspace context block: file tree + auto-read of common config /
// entry-point files. Pure read of the active workspace folder.
// ---------------------------------------------------------------------------
export function getWorkspaceContext(): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) { return ''; }

    // --- 1. File tree ---
    const lines: string[] = [];
    let count = 0;

    const walk = (dir: string, prefix: string) => {
        if (count >= getConfig().maxTreeFiles) { return; }
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch { return; }

        entries.sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) { return -1; }
            if (!a.isDirectory() && b.isDirectory()) { return 1; }
            return a.name.localeCompare(b.name);
        });

        for (const entry of entries) {
            if (count >= getConfig().maxTreeFiles) { break; }
            if (EXCLUDED_DIRS.has(entry.name)) { continue; }
            if (entry.name.startsWith('.') && entry.isDirectory()) { continue; }

            if (entry.isDirectory()) {
                lines.push(`${prefix}📁 ${entry.name}/`);
                count++;
                walk(path.join(dir, entry.name), prefix + '  ');
            } else {
                lines.push(`${prefix}📄 ${entry.name}`);
                count++;
            }
        }
    };
    walk(root, '');

    let result = '';
    if (lines.length > 0) {
        result += `\n\n[WORKSPACE INFO]\n📂 경로: ${root}\n\n[프로젝트 파일 구조]\n${lines.join('\n')}`;
    }

    // --- 2. Auto-read key project files ---
    const keyFiles = [
        'package.json', 'tsconfig.json', 'vite.config.ts', 'vite.config.js',
        'next.config.js', 'next.config.ts', 'README.md',
        'index.html', 'app.js', 'app.ts', 'main.ts', 'main.js',
        'src/index.ts', 'src/index.js', 'src/App.tsx', 'src/App.jsx',
        'src/main.ts', 'src/main.js',
    ];
    let totalRead = 0;
    const MAX_AUTO_READ = 6_000; // chars total

    for (const kf of keyFiles) {
        if (totalRead >= MAX_AUTO_READ) { break; }
        const abs = path.join(root, kf);
        if (fs.existsSync(abs)) {
            try {
                const content = fs.readFileSync(abs, 'utf-8');
                if (content.length < 5000) {
                    result += `\n\n[파일 내용: ${kf}]\n\`\`\`\n${content}\n\`\`\``;
                    totalRead += content.length;
                }
            } catch { /* skip */ }
        }
    }

    return result;
}

// ---------------------------------------------------------------------------
// Detect an explicit "@agent" / "<nickname>야" mention so we can dispatch
// directly to that specialist and skip the CEO planner step. Returns null
// when no clear mention is found OR when the mentioned agent is inactive.
// ---------------------------------------------------------------------------
export function detectExplicitMention(prompt: string): { agentId: string; agentName: string } | null {
    const lower = prompt.toLowerCase();
    /* 호출 후보: 한글 닉네임·영문 id·역할 키워드 → agentId 매핑.
       우선순위 높은 것부터 (일론머스크·제프베조스 같은 고유 페르소나명이 일반 역할어보다 강함). */
    const candidates: Array<{ patterns: RegExp[]; agentId: string; agentName: string }> = [
        { patterns: [/개발신[야아!,~ ]/, /개발신아/, /@developer\b/, /@개발신\b/], agentId: 'developer', agentName: '개발신' },
        { patterns: [/제프베조스[야아!,~ ]/, /베조스[야아!,~ ]/, /제프[야아!,~ ]/, /@business\b/, /@제프베조스\b/, /@베조스\b/], agentId: 'business', agentName: '제프베조스' },
        { patterns: [/한스짐머[야아!,~ ]/, /짐머[야아!,~ ]/, /@editor\b/, /@한스짐머\b/, /@짐머\b/], agentId: 'editor', agentName: '한스짐머' },
        { patterns: [/카리나[야아!,~ ]/, /카리나야/, /@secretary\b/, /@카리나\b/], agentId: 'secretary', agentName: '카리나' },
        { patterns: [/일론머스크[야아!,~ ]/, /일론[야아!,~ ]/, /머스크[야아!,~ ]/, /@ceo\b/, /@일론머스크\b/, /@일론\b/], agentId: 'ceo', agentName: '일론머스크' },
        { patterns: [/미스터비스트[야아!,~ ]/, /미스터 비스트[야아!,~ ]/, /비스트[야아!,~ ]/, /@instagram\b/, /@youtube\b/, /@미스터비스트\b/, /@비스트\b/, /@beast\b/i, /@MrBeast\b/i], agentId: 'instagram', agentName: '미스터비스트' },
        { patterns: [/조나단아이브[야아!,~ ]/, /조나단[야아!,~ ]/, /아이브[야아!,~ ]/, /@designer\b/, /@조나단아이브\b/, /@조나단\b/], agentId: 'designer', agentName: '조나단아이브' },
        { patterns: [/셰익스피어[야아!,~ ]/, /셰익[야아!,~ ]/, /@writer\b/, /@셰익스피어\b/], agentId: 'writer', agentName: '셰익스피어' },
        { patterns: [/아인슈타인[야아!,~ ]/, /아인슈[야아!,~ ]/, /@researcher\b/, /@아인슈타인\b/], agentId: 'researcher', agentName: '아인슈타인' },
        /* 역할 호칭 — 단, 자연스러운 명령에서 잘못 매칭 안 되게 "야"·"!"·"," 같은 호격 표지 필요 */
        { patterns: [/개발자[야아!,]/, /@developer\b/], agentId: 'developer', agentName: '개발자' },
        { patterns: [/디자이너[야아!,]/, /@designer\b/], agentId: 'designer', agentName: '디자이너' },
        { patterns: [/작가[야아!,]/, /@writer\b/], agentId: 'writer', agentName: '작가' },
        { patterns: [/리서처[야아!,]/, /@researcher\b/], agentId: 'researcher', agentName: '리서처' },
        { patterns: [/인스타[야아!,]/, /@instagram\b/], agentId: 'instagram', agentName: '인스타' },
    ];
    for (const c of candidates) {
        for (const p of c.patterns) {
            if (p.test(prompt) || p.test(lower)) {
                /* 활성 상태인지 확인 — 비활성 에이전트면 CEO 분배로 fallback */
                if (isAgentActive(c.agentId)) {
                    return { agentId: c.agentId, agentName: c.agentName };
                }
            }
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// PayPal "revenue" shortcut — bypasses the LLM when the user explicitly asks
// 제프베조스 for revenue figures and credentials are configured. Returns the
// pre-baked report on success, a configuration prompt on missing creds, or
// null when the tool isn't installed (falls back to normal LLM flow).
// ---------------------------------------------------------------------------
export async function tryRevenueShortcut(_userPrompt: string): Promise<string | null> {
    const ppToolDir = path.join(getCompanyDir(), '_agents', 'business', 'tools');
    const ppScript = path.join(ppToolDir, 'paypal_revenue.py');
    const ppJson = path.join(ppToolDir, 'paypal_revenue.json');
    if (!fs.existsSync(ppScript) || !fs.existsSync(ppJson)) return null;
    let cfg: any = {};
    try { cfg = JSON.parse(_safeReadText(ppJson) || '{}'); } catch { return null; }
    if (!cfg.CLIENT_ID || !cfg.CLIENT_SECRET) {
        return `💼 제프베조스: 사장님, PayPal Client ID 또는 Secret 이 비어있어 매출을 가져올 수 없어요.

📋 **해결 단계**:
1. \`Cmd+Shift+P\` → \`Agent OS: 외부 연결\`
2. 💰 PayPal 카드 → Client ID + Secret 입력
3. 저장 → 즉시 매출 분석 가능

📊 평가: 대기 — PayPal 자격증명 입력 후 재시도.
📝 다음 단계: 사장님이 PayPal Developer Dashboard 에서 Client ID/Secret 복사 → 외부 연결 패널 입력.
`;
    }
    try {
        const env = { ...process.env, LOOKBACK_DAYS: String(cfg.LOOKBACK_DAYS || 30) };
        const r = await new Promise<{ exitCode: number; output: string; stderr: string }>((resolve) => {
            const cp = require('child_process');
            const p = cp.spawn(_pythonCmd(), [ppScript], { cwd: ppToolDir, env });
            let out = '', err = '';
            p.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
            p.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
            p.on('close', (code: number) => resolve({ exitCode: code, output: out, stderr: err }));
            setTimeout(() => { try { p.kill(); } catch {} resolve({ exitCode: -1, output: out, stderr: err }); }, 25000);
        });
        if (r.exitCode !== 0 || !r.output) {
            return `💼 제프베조스: PayPal 데이터 가져오기 실패. ${r.stderr.slice(-150) || ''}

📋 외부 연결 패널에서 Client ID/Secret 다시 확인 후 재시도.
📊 평가: 대기 — 자격증명 확인 필요.
📝 다음 단계: \`Cmd+Shift+P\` → \`Agent OS: 외부 연결\` 에서 PayPal 카드 점검.
`;
        }
        const insight = `💼 제프베조스: 사장님, 실시간 PayPal 데이터 가져왔습니다. 즉시 분석 결과 보여드려요.\n\n`;
        const footer = `\n\n📊 평가: 완료 — 실데이터 기반 분석 (LLM 우회, 환각 없음).\n📝 다음 단계: 위 "💡 다음 액션" 섹션 참고하시고, 더 깊이 분석 필요하면 매출 대시보드 (\`Cmd+Shift+P → 매출 대시보드\`) 에서 시각화 확인.\n`;
        return insight + r.output + footer;
    } catch (e: any) {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Developer "kit" shortcut — when the user explicitly calls 개발신 with a
// prompt strongly matching a brain-folder kit manifest, bypass the LLM and
// produce a pre-baked `<run_command>` response that drives `pack_apply.py`.
// Scoring: keyword=10 / name=5 / category=3, threshold 10.
// ---------------------------------------------------------------------------
export function tryKitShortcut(agentId: string, userPrompt: string): string | null {
    if (agentId !== 'developer') return null;
    const a = AGENTS[agentId];
    if (!a) return null;

    const lowerPrompt = userPrompt.toLowerCase();
    const brainDir = _getBrainDir();
    const kitsRoot = path.join(brainDir, '40_템플릿', 'developer');
    if (!fs.existsSync(kitsRoot)) return null;

    let best: { kit: string; score: number; manifest: any } | null = null;
    try {
        for (const dirent of fs.readdirSync(kitsRoot, { withFileTypes: true })) {
            if (!dirent.isDirectory()) continue;
            const kitName = dirent.name;
            const manifestPath = path.join(kitsRoot, kitName, 'manifest.json');
            if (!fs.existsSync(manifestPath)) continue;
            let manifest: any;
            try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')); }
            catch { continue; }

            let score = 0;
            const kws: string[] = Array.isArray(manifest.keywords) ? manifest.keywords : [];
            for (const k of kws) {
                const kl = String(k).toLowerCase();
                if (kl && lowerPrompt.includes(kl)) score += 10;
            }
            const nameStr = String(manifest.name || '').toLowerCase();
            if (nameStr && lowerPrompt.includes(nameStr)) score += 5;
            const cat = String(manifest.category || '').toLowerCase();
            if (cat && lowerPrompt.includes(cat)) score += 3;

            if (score > 0 && (!best || score > best.score)) {
                best = { kit: kitName, score, manifest };
            }
        }
    } catch { return null; }

    if (!best || best.score < 10) return null;

    /* v2.89.134 — PROJECT_PATH 자동 생성. pack_apply 가 빈 경로 거부 안 하게.
       폴더명: 키트 이름에서 '-kit' suffix 제거 + timestamp 안 붙여서 매번 같은
       폴더 (기존 파일 덮어쓰지만 .backup 자동 보존). */
    const escapedIntent = userPrompt.replace(/"/g, '\\"');
    const projectName = best.kit.replace(/-kit$/, '');
    const projectDir = path.join(os.homedir(), 'agent-os-ai-projects', projectName);
    const toolsDir = path.join(getCompanyDir(), '_agents', 'developer', 'tools').replace(/\\/g, '/');
    const projectDirShell = projectDir.replace(/\\/g, '/');
    const brainRootShell = brainDir.replace(/\\/g, '/');

    /* 매니페스트의 apply.open_in_browser 가 있으면 그 파일을 open. 없으면 index.html
       이 있을 가능성에 베팅 (대부분의 vanilla 키트). */
    const openTarget = best.manifest?.apply?.open_in_browser || 'index.html';

    /* v2.89.152 — 크로스플랫폼. 윈도우 cmd 는 `mkdir -p`·inline env vars 미지원.
       Python 자체로 mkdir + CLI 인자로 모든 값 전달 → 모든 OS 동일 동작.
       pack_apply 는 v4 부터 CLI 인자 지원 (`--kit X --user-intent Y --project Z`). */
    const isWin = process.platform === 'win32';
    const pyCmd = _pythonCmd();
    const openCmd = isWin ? `start "" "${projectDirShell}\\${openTarget}"`.replace(/\//g, '\\')
        : (process.platform === 'darwin' ? `open "${projectDirShell}/${openTarget}"` : `xdg-open "${projectDirShell}/${openTarget}"`);

    const fakeOutput = `${a.emoji} ${a.name}: 명시적 호출 + 매칭 키트 발견. LLM 우회 — 시스템이 직접 \`${best.kit}\` 적용합니다.

> 📋 매칭 점수: **${best.score}점** (\`${best.manifest.name || best.kit}\`)
> 📁 대상 프로젝트: \`${projectDir.replace(os.homedir(), '~')}\`
> 💡 \`pack_apply.py\` 즉시 실행 → 키트 파일 복사·설정 자동화.

<run_command>${pyCmd} -c "import os; os.makedirs(r'${projectDirShell}', exist_ok=True)" && cd "${toolsDir}" && ${pyCmd} pack_apply.py --kit "${best.kit}" --user-intent "${escapedIntent}" --project "${projectDirShell}" --brain-root "${brainRootShell}"</run_command>

<run_command>${openCmd}</run_command>

📊 평가: 완료 — 키트 적용 + 결과 파일 자동 오픈까지 시스템이 처리.
📝 다음 단계: 브라우저에 결과 보임. 코드 커스터마이즈는 \`${projectDir.replace(os.homedir(), '~')}/\` 폴더에서.
`;
    return fakeOutput;
}

// ---------------------------------------------------------------------------
// Classify a thrown error from `streamAsk` / `ask` (Claude CLI surface) into
// a user-friendly Korean error message. Pure — message in, message out.
// ---------------------------------------------------------------------------
export function classifyChatError(msg: string): string {
    if (/ENOENT|not found/i.test(msg)) {
        return `⚠️ Claude CLI 를 찾지 못했어요.\n\n**해결 방법:**\n• 터미널에서 \`which claude\` 로 경로 확인\n• 없으면 https://docs.claude.com/en/docs/claude-code/setup 따라 설치 후 \`claude login\`\n• 설치 경로가 PATH 에 없으면 settings.json 의 \`agentOs.claudeBinPath\` 에 절대경로 입력\n\n💡 **명령 팔레트 (Cmd+Shift+P) → "Agent OS: 연결 진단"** 실행하면 자동 체크해드려요.`;
    }
    if (/timed out|timeout/i.test(msg)) {
        return `⚠️ Claude 응답이 너무 오래 걸려요.\n\n**해결 방법:**\n• 질문을 짧게 줄여보기\n• 사용량 한도 (Claude Max 5시간 윈도우) 가 거의 다 찼는지 확인`;
    }
    if (/aborted/i.test(msg)) {
        return `⚠️ 응답이 중간에 취소됐어요.`;
    }
    if (/Unexpected end of JSON input|Unexpected token|prompt is too long|maximum context length/i.test(msg)) {
        /* v2.90.1 — 이전 PDF 첨부가 chatHistory 에 깨진 base64 로 박혀 있을 때 자주 발생.
           사용자에게 새 대화 시작을 권장. */
        return `⚠️ 프롬프트가 너무 크거나 망가졌어요. (${msg})\n\n**해결 방법:**\n• 좌측 상단 **+ 새 대화** 버튼으로 대화 초기화\n• PDF 다시 첨부해서 시도\n\n_이전에 깨진 PDF 첨부 잔재가 히스토리에 쌓여 있을 가능성이 큽니다._`;
    }
    return `⚠️ 오류: ${msg}`;
}

// ---------------------------------------------------------------------------
// Build an "active editor" context block (file path + contents) capped at
// MAX_CONTEXT_SIZE. Empty string when no eligible file is open.
// ---------------------------------------------------------------------------
export function buildActiveEditorContext(maxContextSize: number): string {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') return '';
    const text = editor.document.getText();
    const name = path.basename(editor.document.fileName);
    if (text.trim().length === 0 || text.length >= maxContextSize) return '';
    return `\n\n[Currently open file: ${name}]\n\`\`\`\n${text}\n\`\`\``;
}

// ---------------------------------------------------------------------------
// Parse the autonomous chatter LLM response into a validated list of turns.
// Drops malformed entries, agents that don't exist in `validIds`, and
// self-talk (from === to). Caps each text at 80 chars. Returns [] on any
// parsing failure (caller can treat as "skip this round").
// ---------------------------------------------------------------------------
export function parseChatterTurns(
    raw: string,
    validIds: readonly string[],
): Array<{ from: string; to: string; text: string }> {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return [];
    let parsed: any;
    try { parsed = JSON.parse(m[0]); } catch { return []; }
    if (!parsed || !Array.isArray(parsed.turns)) return [];
    const turns: { from: string; to: string; text: string }[] = [];
    for (const t of parsed.turns) {
        if (typeof t.from === 'string' && typeof t.to === 'string' && typeof t.text === 'string'
            && validIds.includes(t.from) && validIds.includes(t.to)
            && t.from !== t.to && t.text.trim().length > 0) {
            turns.push({ from: t.from, to: t.to, text: t.text.trim().slice(0, 80) });
        }
    }
    return turns;
}

// ---------------------------------------------------------------------------
// Cap chat history + display messages so a runaway session can't OOM the
// extension host. Returns the pruned arrays — caller reassigns.
//   - keeps the system prompt (if present) at the head
//   - keeps the most recent MAX_HISTORY (50) entries
//   - caps any single message body at MAX_PER_MSG (50 KB)
// ---------------------------------------------------------------------------
export function pruneHistory(
    chatHistory: Array<{ role: string; content: string }>,
    displayMessages: Array<{ text: string; role: string }>,
): {
    chatHistory: Array<{ role: string; content: string }>;
    displayMessages: Array<{ text: string; role: string }>;
} {
    const MAX_HISTORY = 50;
    const MAX_PER_MSG = 50_000; /* v2.90.1 — 옛 PDF 깨진 base64 가 메시지에 박혀 매 요청마다
                                   프롬프트 폭증 → Claude API 가 "Unexpected end of JSON input"
                                   반환. 메시지 1건당 50KB 로 잘라 누적 폭주 방지. */
    let nextChat = chatHistory;
    if (chatHistory.length > MAX_HISTORY + 1) {
        const sysIdx = chatHistory.findIndex(m => m.role === 'system');
        const sys = sysIdx >= 0 ? chatHistory[sysIdx] : null;
        const tail = chatHistory.slice(-MAX_HISTORY);
        nextChat = sys ? [sys, ...tail] : tail;
    }
    for (const m of nextChat) {
        if (typeof m.content === 'string' && m.content.length > MAX_PER_MSG) {
            m.content = m.content.slice(0, MAX_PER_MSG) + `\n\n[…메시지가 ${m.content.length} 자로 너무 커서 잘림]`;
        }
    }
    let nextDisplay = displayMessages;
    if (displayMessages.length > MAX_HISTORY) {
        nextDisplay = displayMessages.slice(-MAX_HISTORY);
    }
    return { chatHistory: nextChat, displayMessages: nextDisplay };
}

// ---------------------------------------------------------------------------
// Mutate-in-place tracker for recent file actions. Dedupes same agent + path
// (touch instead of duplicate), expires entries older than 30 minutes, caps
// at 20. Returns the (possibly replaced) array — caller must reassign.
// ---------------------------------------------------------------------------
export function trackFileAction(
    actions: RecentFileAction[],
    agentId: string | undefined,
    absPath: string,
    action: 'create' | 'edit' | 'delete',
): RecentFileAction[] {
    if (!agentId) return actions;
    const now = Date.now();
    /* 같은 파일·같은 액션 직전 기록 있으면 시간만 갱신 (중복 방지) */
    const dup = actions.find(r => r.absPath === absPath && r.agentId === agentId);
    if (dup) {
        dup.action = action;
        dup.ts = now;
    } else {
        actions.push({ agentId, absPath, action, ts: now });
    }
    /* 30분 묵은 건 제거 + 최대 20개 cap (오래된 것부터 잘림) */
    const cutoff = now - 30 * 60 * 1000;
    let next = actions.filter(r => r.ts > cutoff);
    if (next.length > 20) {
        next = next.slice(-20);
    }
    return next;
}

// ---------------------------------------------------------------------------
// "Did you mean this path?" hint shown when the AI references a folder the
// runtime can't find. Searches recent file actions + 1-2-level scan of the
// company folder for a directory whose basename matches.
// ---------------------------------------------------------------------------
export function fuzzyPathHint(missingPath: string, recentFileActions: ReadonlyArray<RecentFileAction>): string {
    const baseName = path.basename(missingPath);
    if (!baseName || baseName === '.' || baseName === '/') return '';
    const seen = new Set<string>();
    const hits: string[] = [];
    /* 1) 최근 액션 안에 같은 basename 가진 파일 있으면 1순위 */
    for (const r of recentFileActions) {
        if (path.basename(r.absPath) === baseName || r.absPath.includes(`/${baseName}/`) || r.absPath.endsWith(`/${baseName}`)) {
            const parent = path.dirname(r.absPath);
            if (!seen.has(parent)) {
                seen.add(parent);
                hits.push(parent);
            }
        }
    }
    /* 2) 회사 폴더 1~2단계 깊이만 빠르게 스캔 */
    try {
        const companyDir = getCompanyDir();
        if (companyDir && fs.existsSync(companyDir)) {
            const queue: Array<{ dir: string; depth: number }> = [{ dir: companyDir, depth: 0 }];
            while (queue.length > 0 && hits.length < 5) {
                const { dir, depth } = queue.shift()!;
                if (depth > 2) continue;
                let entries: fs.Dirent[];
                try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
                for (const e of entries) {
                    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '_agents') continue;
                    if (e.isDirectory()) {
                        const full = path.join(dir, e.name);
                        if (e.name === baseName && !seen.has(full)) {
                            seen.add(full);
                            hits.push(full);
                        }
                        if (depth < 2) queue.push({ dir: full, depth: depth + 1 });
                    }
                }
            }
        }
    } catch { /* ignore */ }
    if (hits.length === 0) return '';
    const lines = hits.slice(0, 3).map(p => `  • ${p}`).join('\n');
    return `\n💡 비슷한 경로 발견 — 다음 중 하나 의도였나요?\n${lines}\n   → 정확한 절대 경로로 다시 시도하세요.`;
}

// ---------------------------------------------------------------------------
// System-prompt block listing the absolute paths the agent recently touched.
// Kills the "where did I put that file?" failure mode in small models.
// ---------------------------------------------------------------------------
export function buildRecentFilesContext(agentId: string, recentFileActions: ReadonlyArray<RecentFileAction>): string {
    const mine = recentFileActions
        .filter(r => r.agentId === agentId)
        .slice(-10);
    if (mine.length === 0) return '';
    const lines = mine.map(r => {
        const label = r.action === 'create' ? '✅ 생성' : r.action === 'edit' ? '✏️ 편집' : '🗑️ 삭제';
        const mins = Math.max(1, Math.round((Date.now() - r.ts) / 60000));
        return `  - ${label}: ${r.absPath}  (${mins}분 전)`;
    }).join('\n');
    return `\n\n[🗂️ 당신이 최근 작업한 파일들 — 절대 경로 정확]\n${lines}\n\n` +
           `⚠️ 이전에 만든 파일을 다시 참조할 때 이 절대 경로를 그대로 사용하세요. 추측 금지. "내 도구 폴더 기준 상대 경로"로 변환하지 마세요.\n`;
}
