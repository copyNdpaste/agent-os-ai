/* Knowledge graph builder + wiki snippet extractor.
 *
 * Extracted from extension.ts byte-for-byte. `buildKnowledgeGraph` walks the
 * brain markdown corpus, parses wikilinks / md links / tags / semantic
 * basename mentions, and emits the lightweight BrainGraph used by the
 * Neural Construct webview. `_extractWikiSnippet` is a helper used by the
 * RAG retrieval functions in ./rag-context.ts and ./agent-context.ts.
 *
 * Deps imported from `../extension` (need `export` added there if missing):
 *   - COMPANY_INTERNAL_DIRS   (NOT currently exported — must be exported)
 *   - _scoreRelevance         (NOT currently exported — must be exported)
 *
 * Deps from extracted modules / siblings:
 *   - (none beyond fs/path)
 *
 * Pure functions — no vscode dependency.
 */

import * as fs from 'fs';
import * as path from 'path';

import { COMPANY_INTERNAL_DIRS } from './walk';
import { _scoreRelevance } from './keywords';

import type {
    BrainGraph,
    BrainNode,
    BrainLink,
    BrainSnippet,
} from './types';

const VALIDATION_GROUPS: Array<{ group: string; tags: string[]; patterns: RegExp[] }> = [
    { group: '아이디어', tags: ['idea', '아이디어'], patterns: [/아이디어|idea|컨셉|서비스|앱|제품|MVP/i] },
    { group: '고객', tags: ['customer', 'target', '고객'], patterns: [/타깃|고객|사용자|유저|페르소나|audience|customer|target/i] },
    { group: '문제', tags: ['problem', 'pain', '문제'], patterns: [/문제|불편|pain|고통|니즈|숨겨진 정보|정보 비대칭/i] },
    { group: '가설', tags: ['hypothesis', '가설'], patterns: [/가설|검증|assumption|hypothesis|검증할/i] },
    { group: '실험', tags: ['experiment', 'sns', '실험'], patterns: [/실험|게시|SNS|Threads|Instagram|인스타|릴스|X\(|트위터|숏츠|CTA|랜딩/i] },
    { group: '반응', tags: ['signal', 'reaction', '반응'], patterns: [/반응|댓글|DM|클릭|저장|공유|대기자|가입|신청|전환|signal|score/i] },
    { group: '수익화', tags: ['bm', 'revenue', '수익화'], patterns: [/BM|가격|매출|수익|결제|구독|유료|가격|revenue|pricing/i] },
    { group: '리스크', tags: ['risk', '리스크'], patterns: [/리스크|법률|약관|정책|위험|금지|주의|개인정보|저작권|규제/i] },
    { group: 'MVP', tags: ['mvp', 'build'], patterns: [/MVP|프로토타입|구현|개발|빌드|launch|출시/i] },
];

const STAGE_PATTERNS: Array<{ stage: string; patterns: RegExp[] }> = [
    { stage: 'idea', patterns: [/아이디어|원문 아이디어|컨셉/i] },
    { stage: 'hypothesis', patterns: [/가설|타깃|문제 정의|검증/i] },
    { stage: 'experiment', patterns: [/SNS 실험|게시|실험 문구|CTA|랜딩/i] },
    { stage: 'signal', patterns: [/반응|댓글|DM|클릭|대기자|신청|Idea Score|signal/i] },
    { stage: 'mvp', patterns: [/MVP|구현|프로토타입|출시/i] },
];

const KEYWORD_STOP = new Set([
    '그리고', '하지만', '해서', '있는', '없는', '하기', '하면', '으로', '에서', '에게',
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'you', 'your'
]);

function inferValidationMeta(content: string, rel: string, base: string): { group: string; stage: string; tags: string[]; keywords: string[] } {
    const hay = `${rel}\n${base}\n${content.slice(0, 20_000)}`;
    let best = { group: '지식', tags: [] as string[], score: 0 };
    for (const g of VALIDATION_GROUPS) {
        const score = g.patterns.reduce((sum, re) => sum + ((hay.match(re) || []).length || (re.test(hay) ? 1 : 0)), 0);
        if (score > best.score) best = { group: g.group, tags: g.tags, score };
    }
    let stage = '';
    for (const s of STAGE_PATTERNS) {
        if (s.patterns.some(re => re.test(hay))) { stage = s.stage; break; }
    }
    const words = hay
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
        .split(/\s+/)
        .map(w => w.trim().toLowerCase())
        .filter(w => w.length >= 2 && w.length <= 24 && !KEYWORD_STOP.has(w));
    const freq = new Map<string, number>();
    for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
    const keywords = [...freq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([w]) => w);
    return { group: best.group, stage, tags: best.tags, keywords };
}

export function buildKnowledgeGraph(brainDir: string): BrainGraph {
    const nodes: BrainNode[] = [];
    const nodeByPath = new Map<string, BrainNode>();
    const nodeByBasename = new Map<string, BrainNode[]>();
    const links: BrainLink[] = [];
    const tagSet = new Set<string>();
    let scanned = 0;

    if (!fs.existsSync(brainDir)) return { nodes, links, tags: [] };

    // --- Pass 1: collect all .md files as nodes ---
    function walk(dir: string) {
        if (scanned >= 1000) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries) {
            if (e.name.startsWith('.') || e.name === 'node_modules') continue;
            if (COMPANY_INTERNAL_DIRS.has(e.name)) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { walk(full); continue; }
            if (!e.isFile() || !full.endsWith('.md')) continue;
            const rel = path.relative(brainDir, full);
            const base = e.name.replace(/\.md$/i, '');
            const parts = rel.split(path.sep);
            const folder = parts.length > 1 ? parts[0] : '_root';
            let mtime = 0;
            try { mtime = fs.statSync(full).mtimeMs; } catch { /* ignore */ }
            const node: BrainNode = { id: rel, name: base, folder, tags: [], incoming: 0, outgoing: 0, mtime };
            nodes.push(node);
            nodeByPath.set(rel, node);
            const list = nodeByBasename.get(base.toLowerCase()) || [];
            list.push(node);
            nodeByBasename.set(base.toLowerCase(), list);
            scanned++;
        }
    }
    walk(brainDir);

    // --- Pass 2: parse each file for links + tags ---
    const wikilinkRe = /\[\[([^\]\n|#]+)(?:[#|][^\]\n]*)?\]\]/g;
    const mdlinkRe = /\[[^\]]+\]\(([^)]+\.md)\)/gi;
    const tagRe = /(?:^|[\s>(])#([A-Za-z가-힣0-9_-]{2,40})/g;

    function resolveLink(target: string, fromNode: BrainNode): BrainNode | null {
        const cleaned = target.trim().replace(/^\.\//, '').replace(/\\/g, '/');
        // Try exact relative path match (with or without .md)
        const exact = cleaned.endsWith('.md') ? cleaned : cleaned + '.md';
        if (nodeByPath.has(exact)) return nodeByPath.get(exact)!;
        // Try resolved relative to source file's folder
        const fromDir = path.dirname(fromNode.id);
        const joined = path.normalize(path.join(fromDir, exact));
        if (nodeByPath.has(joined)) return nodeByPath.get(joined)!;
        // Fall back to basename match (Obsidian style)
        const base = path.basename(cleaned, '.md').toLowerCase();
        const matches = nodeByBasename.get(base) || [];
        if (matches.length === 0) return null;
        // Prefer same-folder match if multiple
        if (matches.length > 1) {
            const sameFolder = matches.find(m => path.dirname(m.id) === fromDir);
            if (sameFolder) return sameFolder;
        }
        return matches[0];
    }

    for (const node of nodes) {
        let content: string;
        try { content = fs.readFileSync(path.join(brainDir, node.id), 'utf-8').slice(0, 200_000); }
        catch { continue; }

        // Wikilinks → real edges
        let m: RegExpExecArray | null;
        wikilinkRe.lastIndex = 0;
        while ((m = wikilinkRe.exec(content)) !== null) {
            const target = resolveLink(m[1], node);
            if (target && target.id !== node.id) {
                links.push({ source: node.id, target: target.id, type: 'wikilink' });
                node.outgoing++;
                target.incoming++;
            }
        }

        // Markdown links → real edges
        mdlinkRe.lastIndex = 0;
        while ((m = mdlinkRe.exec(content)) !== null) {
            // Skip external URLs
            if (/^https?:\/\//i.test(m[1])) continue;
            const target = resolveLink(m[1], node);
            if (target && target.id !== node.id) {
                links.push({ source: node.id, target: target.id, type: 'mdlink' });
                node.outgoing++;
                target.incoming++;
            }
        }

        // Tags
        tagRe.lastIndex = 0;
        const localTags = new Set<string>();
        while ((m = tagRe.exec(content)) !== null) {
            localTags.add(m[1]);
        }
        const inferred = inferValidationMeta(content, node.id, node.name);
        node.group = inferred.group;
        node.stage = inferred.stage;
        node.keywords = inferred.keywords;
        inferred.tags.forEach(t => localTags.add(t));
        if (inferred.stage) localTags.add(`stage-${inferred.stage}`);
        node.tags = [...localTags];
        localTags.forEach(t => tagSet.add(t));
    }

    // --- Pass 2.5: Semantic Implicit Links (Brain Pattern Recognition) ---
    // If a document mentions another document's exact basename (and it's >= 2 chars), create a semantic link.
    const validBasenames = nodes.filter(n => n.name.length >= 2);
    for (const node of nodes) {
        let content: string;
        try { content = fs.readFileSync(path.join(brainDir, node.id), 'utf-8').slice(0, 100_000); }
        catch { continue; }
        // Fast plain-text match
        const contentLower = content.toLowerCase();
        for (const target of validBasenames) {
            if (target.id === node.id) continue;
            // Prevent overly broad matching (e.g. matching "it" or "at") by checking word boundaries
            // We use simple substring check first for performance, then regex for word boundary
            const targetLower = target.name.toLowerCase();
            if (contentLower.includes(targetLower)) {
                // Confirm with boundaries if alphabet
                const isAlpha = /^[a-z]+$/.test(targetLower);
                if (isAlpha) {
                    const regex = new RegExp(`\\b${targetLower}\\b`, 'i');
                    if (!regex.test(content)) continue;
                }
                links.push({ source: node.id, target: target.id, type: 'semantic' });
                // We don't increment incoming/outgoing for semantic links to keep sizes strictly based on explicit structure
            }
        }
    }

    // --- Pass 3: tag co-occurrence edges (cap to top 8 tags to avoid explosion) ---
    const tagToNodes = new Map<string, BrainNode[]>();
    for (const node of nodes) {
        for (const t of node.tags) {
            const list = tagToNodes.get(t) || [];
            list.push(node);
            tagToNodes.set(t, list);
        }
    }
    const topTags = [...tagToNodes.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 8);
    for (const [, nodesWithTag] of topTags) {
        if (nodesWithTag.length < 2 || nodesWithTag.length > 25) continue;
        for (let i = 0; i < nodesWithTag.length; i++) {
            for (let j = i + 1; j < nodesWithTag.length; j++) {
                links.push({ source: nodesWithTag[i].id, target: nodesWithTag[j].id, type: 'tag' });
            }
        }
    }

    // --- Pass 3.5: validation-similarity edges ---
    // Idea validation docs often don't have explicit wikilinks yet. Connect
    // nodes in the same inferred group when they share high-signal keywords,
    // so the graph shows real clusters before the user manually curates links.
    const groupToNodes = new Map<string, BrainNode[]>();
    for (const node of nodes) {
        const group = node.group || node.folder || '지식';
        const list = groupToNodes.get(group) || [];
        list.push(node);
        groupToNodes.set(group, list);
    }
    for (const [, groupNodes] of groupToNodes) {
        if (groupNodes.length < 2 || groupNodes.length > 60) continue;
        let added = 0;
        for (let i = 0; i < groupNodes.length && added < 120; i++) {
            const a = groupNodes[i];
            const aKw = new Set(a.keywords || []);
            for (let j = i + 1; j < groupNodes.length && added < 120; j++) {
                const b = groupNodes[j];
                const bKw = b.keywords || [];
                const shared = bKw.filter(k => aKw.has(k));
                if (shared.length >= 2 || (a.stage && a.stage === b.stage && shared.length >= 1)) {
                    links.push({ source: a.id, target: b.id, type: 'related' });
                    added++;
                }
            }
        }
    }

    // De-duplicate links (a→b and b→a counted once)
    const seen = new Set<string>();
    const dedup: BrainLink[] = [];
    for (const l of links) {
        const key = l.source < l.target ? `${l.source}|${l.target}|${l.type}` : `${l.target}|${l.source}|${l.type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        dedup.push(l);
    }

    return { nodes, links: dedup, tags: [...tagSet] };
}

export function _extractWikiSnippet(filePath: string, brainRoot: string, keywords: string[]): BrainSnippet | null {
  let raw = '';
  try {
    const st = fs.statSync(filePath);
    if (st.size > 80_000) return null; /* skip giant files */
    raw = fs.readFileSync(filePath, 'utf-8').slice(0, 12_000);
  } catch { return null; }
  if (!raw.trim()) return null;
  /* Title: first H1, else filename */
  const h1 = raw.match(/^#\s+(.+?)\s*$/m);
  const title = h1 ? h1[1].trim().replace(/\[\[|\]\]/g, '') : path.basename(filePath, path.extname(filePath));
  /* Insight: prefer the "📌 한 줄 통찰" line (P-Reinforce convention).
     Fallback: first non-heading paragraph. */
  let insight = '';
  const insightM = raw.match(/##[^\n]*한 줄 통찰[^\n]*\n>?\s*([^\n]+)/);
  if (insightM && insightM[1]) {
    insight = insightM[1].trim().replace(/^>+\s*/, '');
  } else {
    /* Strip frontmatter, find first non-heading non-empty line */
    const body = raw.replace(/^---[\s\S]*?---\n/, '');
    const lines = body.split('\n');
    for (const ln of lines) {
      const t = ln.trim();
      if (!t) continue;
      if (t.startsWith('#')) continue;
      if (t.startsWith('---')) continue;
      insight = t.slice(0, 220);
      break;
    }
  }
  if (!insight) insight = raw.replace(/\s+/g, ' ').slice(0, 180);
  insight = insight.slice(0, 220);
  let st: fs.Stats | null = null;
  try { st = fs.statSync(filePath); } catch {}
  /* Recency boost: docs modified in last 14 days get +5 to score */
  const ageDays = st ? (Date.now() - st.mtimeMs) / 86_400_000 : 999;
  const recencyBonus = ageDays <= 14 ? 5 : (ageDays <= 60 ? 2 : 0);
  const scoreText = title + '\n' + insight + '\n' + raw.slice(0, 2000);
  const score = _scoreRelevance(scoreText, keywords) + recencyBonus;
  return {
    path: filePath,
    rel: path.relative(brainRoot, filePath),
    title,
    insight,
    score,
    mtime: st ? st.mtimeMs : 0,
  };
}
