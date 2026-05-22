/**
 * Barrel for the corporate-dispatch phase helpers extracted out of
 * `SidebarChatProvider._handleCorporatePrompt`. The orchestrator there
 * imports these and pipes them through a `CorporateContext` instead of
 * relying on `this`-capture.
 */
export type {
    Plan,
    ConferTurn,
    AgentMetaEntry,
    CorporateContext,
} from './types';
export { runSpecialistLoop } from './specialist-loop';
export { runConferPhase } from './confer-phase';
export { runReportPhase } from './report-phase';
export { runDecisionsPhase } from './decisions-phase';
