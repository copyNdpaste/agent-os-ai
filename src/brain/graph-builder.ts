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

import {
    COMPANY_INTERNAL_DIRS,
    _scoreRelevance,
} from '../extension';

import type {
    BrainGraph,
    BrainNode,
    BrainLink,
    BrainSnippet,
} from './types';

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
