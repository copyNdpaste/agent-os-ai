/*
 * Per-agent RAG mode + Self-RAG verification criteria.
 *
 * Originally inline in extension.ts. Both are tiny file-IO helpers tied to
 * an agent's _agents/<id>/ directory. Kept in agent-state because they sit
 * next to autonomy + active state files.
 */

import * as fs from 'fs';
import * as path from 'path';

export type RagMode = 'standard' | 'self-rag';
const RAG_MODES: RagMode[] = ['standard', 'self-rag'];

export function readAgentRagMode(companyDir: string, agentId: string): RagMode {
  try {
    const p = path.join(companyDir, '_agents', agentId, 'rag_mode.txt');
    if (!fs.existsSync(p)) return 'standard';
    const v = fs.readFileSync(p, 'utf-8').trim().toLowerCase();
    return (RAG_MODES as string[]).includes(v) ? v as RagMode : 'standard';
  } catch { return 'standard'; }
}

export function writeAgentRagMode(companyDir: string, agentId: string, mode: string): void {
  const safe = (RAG_MODES as string[]).includes(mode) ? mode : 'standard';
  const dir = path.join(companyDir, '_agents', agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rag_mode.txt'), safe);
}

/* User-defined Self-RAG verification criteria. Plain markdown — agent reads
   it and appends to the standard self-critique protocol. Lets users tailor
   "what counts as grounded" to their domain (e.g. "any number must cite an
   actual data file", "thumbnail copy must be ≤5 words"). */
export function readAgentSelfRagCriteria(companyDir: string, agentId: string): string {
  try {
    const p = path.join(companyDir, '_agents', agentId, 'self_rag_criteria.md');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
  } catch { return ''; }
}
