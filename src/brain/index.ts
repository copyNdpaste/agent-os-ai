/* Brain module barrel — knowledge graph rendering + RAG context system.
 *
 * Re-exports the public surface of src/brain/ so the wiring step in
 * extension.ts can replace the original `function` defs with one-line
 * imports: `import { showBrainNetwork, readAgentSharedContext, ... } from './brain';`.
 *
 * Sub-modules:
 *   - types.ts          → BrainNode / BrainLink / BrainGraph / BrainSnippet
 *   - graph-builder.ts  → buildKnowledgeGraph + _extractWikiSnippet
 *   - graph-html.ts     → _RENDER_GRAPH_HTML (the 880-line webview template)
 *   - network-view.ts   → showBrainNetwork (webview launcher)
 *   - rag-context.ts    → readRelevantBrainContext + readGraphRagBrainContext
 *   - agent-context.ts  → readAgentSharedContext + readAgentTemplates
 *                         + readAgentSkills + readAgentVerifiedKnowledge
 *                         + readAgentCustomPrompt
 */

export type {
    BrainNode,
    BrainLink,
    BrainGraph,
    BrainSnippet,
} from './types';

export {
    buildKnowledgeGraph,
    _extractWikiSnippet,
} from './graph-builder';

export { _RENDER_GRAPH_HTML } from './graph-html';

export { showBrainNetwork } from './network-view';

export {
    readRelevantBrainContext,
    readGraphRagBrainContext,
} from './rag-context';

export {
    readAgentSharedContext,
    readAgentTemplates,
    readAgentSkills,
    readAgentVerifiedKnowledge,
    readAgentCustomPrompt,
} from './agent-context';
