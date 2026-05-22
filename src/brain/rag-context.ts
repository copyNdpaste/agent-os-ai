/* RAG (Retrieval-Augmented Generation) brain context.
 *
 * Extracted from extension.ts byte-for-byte. Two retrievers:
 *   - readRelevantBrainContext: pure keyword-scored top-K snippets
 *   - readGraphRagBrainContext:  keyword seeds + 1-hop graph expansion
 *                                via wikilinks and anchor-term co-occurrence
 *
 * Both walk the BRAIN root (not _company/) so agent self-output never gets
 * re-fed as "knowledge". Snippets are scored, sorted, and clipped to a char
 * budget before being concatenated into a context block.
 *
 * Deps imported from `../extension` (need `export` added there if missing):
 *   - _agentKeywords          (NOT currently exported -- must be exported)
 *   - _walkBrainMd            (NOT currently exported -- must be exported)
 *
 * Deps from extracted modules / siblings:
 *   - _getBrainDir            ← '../paths'
 *   - _extractWikiSnippet     ← './graph-builder'
 *   - type BrainSnippet       ← './types'
 */

import * as fs from 'fs';
import * as path from 'path';

import { _getBrainDir } from '../paths';
import { _agentKeywords } from './keywords';
import { _walkBrainMd } from './walk';

import { _extractWikiSnippet } from './graph-builder';
import type { BrainSnippet } from './types';

/* Returns a context block to append to the agent's prompt, or '' if no
   relevant brain content. Budget caps total chars so we don't blow up the
   context window. */
export function readRelevantBrainContext(agentId: string, budgetChars: number = 2400): string {
  /* Walk the BRAIN root (where 00_Raw/, 10_Wiki/, user notes live) — NOT
     the company subdir. Skip _company/ entirely so agent self-output never
     gets re-fed as "knowledge". */
  const brain = _getBrainDir();
  const keywords = _agentKeywords(agentId);
  if (keywords.length === 0) return '';

  const skipDirs = new Set([
    '_company', '_shared', '_agents', 'sessions', 'approvals',
    'node_modules', '.git', '.cache', '_cache', 'out', 'dist', '__pycache__',
  ]);

  /* 10_Wiki and other top-level knowledge folders — main scan target. */
  const wikiFiles = _walkBrainMd(brain, { maxDepth: 4, maxFiles: 200, skipDirs });

  /* Recent 00_Raw within last 14 days — these are freshly injected and
     might not be wiki-organized yet. Score on filename + first chunk. */
  const rawDir = path.join(brain, '00_Raw');
  let rawFiles: string[] = [];
  if (fs.existsSync(rawDir)) {
    rawFiles = _walkBrainMd(rawDir, { maxDepth: 2, maxFiles: 50, skipDirs: new Set() });
    /* keep only ≤14 days old */
    const cutoff = Date.now() - 14 * 86_400_000;
    rawFiles = rawFiles.filter(f => {
      try { return fs.statSync(f).mtimeMs >= cutoff; } catch { return false; }
    });
  }

  const all = [...wikiFiles, ...rawFiles];
  if (all.length === 0) return '';

  const snippets: BrainSnippet[] = [];
  for (const f of all) {
    const s = _extractWikiSnippet(f, brain, keywords);
    if (s && s.score > 0) snippets.push(s);
  }
  if (snippets.length === 0) return '';

  snippets.sort((a, b) => b.score - a.score || b.mtime - a.mtime);

  let block = '\n\n[관련 두뇌 지식 — 최근 또는 당신 분야 관련 자료. 필요하면 인용/활용]\n';
  let used = 0;
  for (const s of snippets) {
    const line = `- 🧠 **${s.title}** (${s.rel})\n  > ${s.insight}\n`;
    if (used + line.length > budgetChars) break;
    block += line;
    used += line.length;
  }
  return used > 0 ? block : '';
}

/* Graph RAG retrieval — minimal but meaningful implementation.
   Builds a lightweight knowledge graph from the brain folder where:
     - nodes  = wiki/raw markdown files
     - edges  = explicit `[[wikilinks]]` (directional, treated as undirected
                here for traversal) + co-occurrence on shared "anchor terms"
                (H1 titles + quoted phrases) above a small frequency threshold
   Then keyword-scores nodes against the agent's specialty (same as standard
   retrieval) to pick top-K SEEDS, BFS 1-hop from each seed to bring in
   connected notes that wouldn't match keywords directly, and emits a
   context block with both the seed and the connected neighbors annotated.
   This is intentionally educational: the user can compare against
   `readRelevantBrainContext` and see how Graph RAG surfaces 1-hop links
   that pure keyword search misses. */
export function readGraphRagBrainContext(agentId: string, budgetChars: number = 2400): string {
  /* Walk BRAIN root — same rationale as readRelevantBrainContext. The graph
     edges (wikilinks) live in user notes under 00_Raw/, 10_Wiki/, etc.,
     never inside _company/ (that's agent output, not knowledge). */
  const brain = _getBrainDir();
  const keywords = _agentKeywords(agentId);
  if (keywords.length === 0) return '';

  const skipDirs = new Set([
    '_company', '_shared', '_agents', 'sessions', 'approvals',
    'node_modules', '.git', '.cache', '_cache', 'out', 'dist', '__pycache__',
  ]);
  const wikiFiles = _walkBrainMd(brain, { maxDepth: 4, maxFiles: 200, skipDirs });
  const rawDir = path.join(brain, '00_Raw');
  let rawFiles: string[] = [];
  if (fs.existsSync(rawDir)) {
    rawFiles = _walkBrainMd(rawDir, { maxDepth: 2, maxFiles: 50, skipDirs: new Set() });
    const cutoff = Date.now() - 14 * 86_400_000;
    rawFiles = rawFiles.filter(f => {
      try { return fs.statSync(f).mtimeMs >= cutoff; } catch { return false; }
    });
  }
  const all = Array.from(new Set([...wikiFiles, ...rawFiles]));
  if (all.length === 0) return '';

  /* Pass 1: load each file once (cap size), compute snippet + extract its
     wikilinks and a small set of anchor terms (H1 title + first 5 quoted
     phrases). Title→file index lets us resolve `[[Foo]]` to a real node. */
  type Node = { snippet: BrainSnippet; titleKey: string; links: string[]; anchors: string[]; raw: string };
  const nodes: Node[] = [];
  const titleToIdx = new Map<string, number>();
  for (const f of all) {
    let raw = '';
    try {
      const st = fs.statSync(f);
      if (st.size > 80_000) continue;
      raw = fs.readFileSync(f, 'utf-8').slice(0, 12_000);
    } catch { continue; }
    if (!raw.trim()) continue;
    const snippet = _extractWikiSnippet(f, brain, keywords);
    if (!snippet) continue;
    const titleKey = snippet.title.trim().toLowerCase();
    /* Wikilinks — strip optional `|alias` */
    const links: string[] = [];
    const linkRe = /\[\[([^\]\|\n]+?)(?:\|[^\]]*)?\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(raw)) && links.length < 30) {
      links.push(m[1].trim().toLowerCase());
    }
    /* Anchor terms — H1 + up to 5 backtick/quoted phrases (cheap proxy for
       "important named entities" without an LLM extraction pass). */
    const anchors: string[] = [snippet.title.trim()];
    const phraseRe = /[`"]([^`"\n]{3,40})[`"]/g;
    let pm: RegExpExecArray | null;
    while ((pm = phraseRe.exec(raw)) && anchors.length < 6) {
      anchors.push(pm[1].trim());
    }
    nodes.push({ snippet, titleKey, links, anchors: anchors.map(a => a.toLowerCase()), raw });
    if (!titleToIdx.has(titleKey)) titleToIdx.set(titleKey, nodes.length - 1);
  }
  if (nodes.length === 0) return '';

  /* Pass 2: build adjacency. Wikilink edge if target title resolves; anchor
     edge if two notes share an anchor term (excluding empty/very short). */
  const adj: Set<number>[] = nodes.map(() => new Set<number>());
  /* Wikilink edges */
  for (let i = 0; i < nodes.length; i++) {
    for (const link of nodes[i].links) {
      const j = titleToIdx.get(link);
      if (j !== undefined && j !== i) {
        adj[i].add(j);
        adj[j].add(i);
      }
    }
  }
  /* Anchor co-occurrence — anchor → list of node indices */
  const anchorIdx = new Map<string, number[]>();
  for (let i = 0; i < nodes.length; i++) {
    for (const a of nodes[i].anchors) {
      if (a.length < 3) continue;
      const arr = anchorIdx.get(a) || [];
      arr.push(i);
      anchorIdx.set(a, arr);
    }
  }
  for (const [, idxs] of anchorIdx) {
    if (idxs.length < 2 || idxs.length > 8) continue; /* skip noise */
    for (let i = 0; i < idxs.length; i++) {
      for (let j = i + 1; j < idxs.length; j++) {
        adj[idxs[i]].add(idxs[j]);
        adj[idxs[j]].add(idxs[i]);
      }
    }
  }

  /* Pass 3: pick top SEEDS by keyword score. BFS 1-hop to expand. Re-rank
     expanded set: seeds keep full score; neighbors get neighbor_factor *
     best_seed_score so they ride into the context window even with zero
     direct keyword match — that is the Graph RAG payoff. */
  const seedCount = 3;
  const ranked = nodes
    .map((n, i) => ({ i, score: n.snippet.score }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (ranked.length === 0) return '';
  const seeds = ranked.slice(0, seedCount).map(x => x.i);
  const seedSet = new Set(seeds);
  const finalScore = new Map<number, number>();
  const reachedVia = new Map<number, number>(); /* neighbor → seed idx */
  for (const s of seeds) {
    finalScore.set(s, nodes[s].snippet.score);
    for (const nb of adj[s]) {
      if (seedSet.has(nb)) continue;
      const boost = nodes[s].snippet.score * 0.5;
      const cur = finalScore.get(nb) || 0;
      if (boost > cur) {
        finalScore.set(nb, boost);
        reachedVia.set(nb, s);
      }
    }
  }
  const ordered = Array.from(finalScore.entries())
    .sort((a, b) => b[1] - a[1] || nodes[b[0]].snippet.mtime - nodes[a[0]].snippet.mtime);

  /* Emit. Mark each line with whether it was a direct match (🎯) or a
     graph-connected neighbor (🔗) so the agent — and the curious user
     reading the prompt — can see the graph at work. */
  let block = '\n\n[관련 두뇌 지식 — Graph RAG: 직접 매칭(🎯) + 1-hop 연결(🔗)]\n';
  let used = 0;
  for (const [idx] of ordered) {
    const n = nodes[idx];
    const tag = seedSet.has(idx) ? '🎯' : '🔗';
    let line = `- ${tag} **${n.snippet.title}** (${n.snippet.rel})\n  > ${n.snippet.insight}\n`;
    if (tag === '🔗') {
      const via = reachedVia.get(idx);
      if (via !== undefined) {
        line = `- ${tag} **${n.snippet.title}** (${n.snippet.rel}) — \`${nodes[via].snippet.title}\`와 연결\n  > ${n.snippet.insight}\n`;
      }
    }
    if (used + line.length > budgetChars) break;
    block += line;
    used += line.length;
  }
  return used > 0 ? block : '';
}
