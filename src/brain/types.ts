/* Brain graph data types.
 *
 * Extracted from extension.ts byte-for-byte. The graph is a lightweight
 * representation of the user's markdown brain:
 *   - BrainNode  = one .md file
 *   - BrainLink  = wikilink, markdown link, tag co-occurrence, or
 *                  semantic (basename mention)
 *   - BrainGraph = nodes + links + all unique tags
 *
 * Used by:
 *   - buildKnowledgeGraph (graph-builder.ts) — produces the graph
 *   - showBrainNetwork (network-view.ts)    — renders it as a webview
 *   - ThinkingPanel in extension.ts          — re-uses _RENDER_GRAPH_HTML
 */

export interface BrainNode {
    id: string;            // relative path inside brainDir
    name: string;          // display name (basename without .md)
    folder: string;        // top-level folder (for color clustering)
    group?: string;        // inferred validation group (idea/customer/problem/experiment/etc.)
    stage?: string;        // inferred experiment stage (idea/hypothesis/posted/signal/mvp)
    keywords?: string[];   // high-signal keywords extracted from title/content
    tags: string[];
    incoming: number;      // backlink count (for size)
    outgoing: number;
    mtime: number;         // last modified time (for memory decay/hotness)
}

export interface BrainLink {
    source: string;
    target: string;
    type: 'wikilink' | 'mdlink' | 'tag' | 'semantic' | 'related';
}

export interface BrainGraph {
    nodes: BrainNode[];
    links: BrainLink[];
    tags: string[];        // all unique tags found
}

/* Used by RAG retrieval helpers (rag-context.ts, agent-context.ts).
 * Not part of the visualization graph — it's a transient retrieval record. */
export interface BrainSnippet {
    path: string;
    rel: string;
    title: string;
    insight: string;
    score: number;
    mtime: number;
}
