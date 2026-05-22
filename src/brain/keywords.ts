/**
 * Brain keyword extraction + relevance scoring.
 *
 * extension.ts 에서 byte-for-byte 추출. RAG (retrieval-augmented generation)
 * 의 score 함수. 에이전트 정의에서 name/role/specialty 토큰을 뽑아 corpus 의
 * 각 문서에 대해 빈도 기반 score 를 매긴다.
 *
 * 동작 보존:
 *   - 한국어 ≥2자 토큰 유지
 *   - 영어 stop-words (and/the/of/for/to/in) drop
 *   - 한 키워드 당 최대 5 hit 까지 카운트 (한 거대 문서가 다 먹는 거 방지)
 *
 * extension.ts 에서 re-export 되어 다른 모듈 (brain/agent-glue, brain/rag-context,
 * brain/graph-builder) 이 import 한다.
 */
import { AGENTS } from '../agents';

export function _agentKeywords(agentId: string): string[] {
  const a = AGENTS[agentId];
  if (!a) return [];
  /* Pull tokens from name, role, specialty. Strip punctuation, lowercase,
     drop tiny tokens. Korean is tricky — we keep ≥2-char chunks. */
  const text = `${a.name} ${a.role} ${a.specialty}`;
  const tokens = text
    .replace(/[()·,/·\-·]+/g, ' ')
    .split(/\s+/)
    .map(t => t.trim().toLowerCase())
    .filter(t => t.length >= 2 && !/^(and|the|of|for|to|in)$/i.test(t));
  /* Dedupe while preserving order */
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) { if (!seen.has(t)) { seen.add(t); out.push(t); } }
  return out;
}

export function _scoreRelevance(text: string, keywords: string[]): number {
  if (!text || keywords.length === 0) return 0;
  const lc = text.toLowerCase();
  let score = 0;
  for (const k of keywords) {
    /* count occurrences (cap at 5 per keyword to avoid one giant doc winning) */
    let i = 0, hits = 0;
    while ((i = lc.indexOf(k, i)) !== -1 && hits < 5) { hits++; i += k.length; }
    score += hits;
  }
  return score;
}
