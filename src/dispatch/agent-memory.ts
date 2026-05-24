/**
 * Agent memory gate — extract + validate 🧠 학습 markers from agent output.
 *
 * 이전엔 specialist-loop 에서 매 task 끝날 때마다 `${task} → 산출물 sessions/...`
 * 한 줄을 무조건 memory.md 에 append 했음. 정보 없는 메타 로그가 무한 누적 →
 * agent 다음 dispatch 때 system prompt 가 옛 노이즈로 가득 차고 추론 환각 증가.
 *
 * 새 정책 (system.md 의 🧠 학습 마커 기준 결정론화):
 *   1) Agent 가 답변에 `🧠 학습: <한 문장>` 을 명시한 경우에만 저장
 *   2) 4가지 기준 (새 패턴 / 실패→교훈 / 사장님 선호 / peer 활용) 중 하나 해당
 *   3) 시스템이 형식·길이·노이즈 패턴 검증 (게이트)
 *   4) memory.md 가 100줄 OR 30KB 초과 시 오래된 50% 자동 정리
 *
 * 효과: noise-free, 작은 LLM 의 마커 남발 차단, 의미있는 학습만 누적.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getCompanyDir } from '../paths';

/** Hard caps for memory.md — when EITHER exceeds, oldest 50% lines dropped. */
export const MEMORY_MAX_LINES = 100;
export const MEMORY_MAX_BYTES = 30 * 1024;

/** Min/max char counts for a learning line content (after stripping prefix). */
export const LEARNING_MIN_CHARS = 20;
export const LEARNING_MAX_CHARS = 300;

/** Match a `🧠 학습:` prefix with optional `[scope]` selector.
 *    Group 1 = optional explicit scope ("global" | "critical"), undefined for default
 *    Group 2 = content after the prefix
 *  Examples it accepts:
 *    🧠 학습: 사장님은 즉시 액션 1개 선호
 *    🧠 학습 [global]: 사장님 톤은 데이터 기반
 *    🧠 학습 [critical]: PayPal live 키 sandbox 와 별도 발급
 *  Strict on the emoji + label so accidental "🧠 노트:" variants don't leak. */
const LEARNING_PREFIX_RE = /^\s*🧠\s*학습(?:\s*\[(global|critical)\])?\s*:\s*(.+?)\s*$/;

/** Memory entry scope:
 *    'critical' — security/system risks; always shown first regardless of project
 *    'global'   — cross-project applicable (user style, decision patterns)
 *    'project'  — bound to one project; only shown when current project matches
 *  Storage line shape: `YYYY-MM-DD 🧠 [scope[:project]] content`
 *  Reading time, `buildScopedMemoryBlock` filters by current project. */
export type LearningScope = 'critical' | 'global' | 'project';

export interface ParsedLearning {
    /** The substantive content after prefix/scope, trimmed. */
    content: string;
    /** Bucket — defaults to 'project' when agent didn't specify [global]/[critical]. */
    scope: LearningScope;
}

/** Match a stored memory line: `YYYY-MM-DD 🧠 [scope[:project]] content`.
 *  Used by buildScopedMemoryBlock to filter by current project at read time.
 *  Captures: 1=date, 2=scope (critical|global|project), 3=optional project name, 4=content */
const MEMORY_LINE_RE = /^\s*(\d{4}-\d{2}-\d{2})\s+🧠\s+\[(critical|global|project)(?::([^\]]+))?\]\s+(.+?)\s*$/;

export interface MemoryEntry {
    date: string;
    scope: LearningScope;
    project?: string;  /* present when scope='project' */
    content: string;
    /** Raw line as stored — used to reconstruct trimmed memory. */
    raw: string;
}

/** Parse a fully-stored memory line. Returns null for malformed/legacy lines
 *  (the old `- [date] task → sessions/x.md` format from before the scope
 *  refactor) so callers can skip them gracefully. */
export function parseMemoryLine(line: string): MemoryEntry | null {
    const m = MEMORY_LINE_RE.exec(line);
    if (!m) return null;
    return {
        date: m[1],
        scope: m[2] as LearningScope,
        project: m[3] || undefined,
        content: m[4].trim(),
        raw: line,
    };
}

/** Patterns the agent must NOT use as learnings — meta/status noise that has
 *  no future-prompt value. Matched against the content (after prefix strip). */
const NOISE_PATTERNS: RegExp[] = [
    /^(분석|작업|보고서|데이터|결과)(을|를)?\s*(진행|확인|작성|완료|저장)/,
    /sessions\//,
    /^[\u{1F300}-\u{1FAFF}\s.,;:!?\-—·]+$/u, /* 이모지·공백·구두점만 */
    /^(중요|핵심|필요)(하다|함|해)\b/,        /* "중요하다" 같은 빈말 */
    /(같습니다|일\s*것\s*같)/,              /* 추측성 어미 */
];

/** Verify a single line passes the learning gate. Used both at extract time
 *  and as a public utility (e.g., tests / future UI to preview). */
export function isValidLearning(rawLine: string): boolean {
    const m = LEARNING_PREFIX_RE.exec(rawLine);
    if (!m) return false;
    const content = m[2].trim();
    if (content.length < LEARNING_MIN_CHARS) return false;
    if (content.length > LEARNING_MAX_CHARS) return false;
    for (const p of NOISE_PATTERNS) {
        if (p.test(content)) return false;
    }
    return true;
}

/** Scan an agent's full output text for `🧠 학습:` lines that pass the gate.
 *  Returns ParsedLearning { content, scope } — caller decides project tagging
 *  and persistence. Default scope is 'project' when agent didn't specify
 *  [global] or [critical]. */
export function extractLearnings(output: string): ParsedLearning[] {
    if (!output) return [];
    const lines = output.split(/\r?\n/);
    const out: ParsedLearning[] = [];
    const seen = new Set<string>();
    for (const ln of lines) {
        if (!isValidLearning(ln)) continue;
        const m = LEARNING_PREFIX_RE.exec(ln);
        if (!m) continue;
        const explicitScope = m[1] as 'global' | 'critical' | undefined;
        const content = m[2].trim();
        /* 같은 학습 중복 방지 (한 답변에 같은 줄 두 번 출력하는 작은 LLM 케이스) */
        if (seen.has(content)) continue;
        seen.add(content);
        out.push({
            content,
            scope: explicitScope || 'project',
        });
    }
    return out;
}

/** Atomically trim memory.md so its line count + byte size stay under caps.
 *  Strategy: when exceeded, drop oldest 50% of lines. Preserves the most
 *  recent half — which is what `agent-context.readAgentSharedContext` reads
 *  via .slice(-N) (after the slice bug fix). */
export function trimMemoryFile(filePath: string): void {
    let raw = '';
    try {
        if (!fs.existsSync(filePath)) return;
        raw = fs.readFileSync(filePath, 'utf-8');
    } catch { return; }
    const lines = raw.split(/\r?\n/);
    /* 마지막 빈 줄은 보존 (trailing newline) */
    const trailing = lines.length > 0 && lines[lines.length - 1] === '' ? '\n' : '';
    const nonEmpty = trailing ? lines.slice(0, -1) : lines;
    const lineCount = nonEmpty.length;
    const byteSize = Buffer.byteLength(raw, 'utf-8');
    if (lineCount <= MEMORY_MAX_LINES && byteSize <= MEMORY_MAX_BYTES) return;
    /* 오래된 50% 제거 — 최신 절반만 남김 */
    const keepFrom = Math.floor(nonEmpty.length / 2);
    const kept = nonEmpty.slice(keepFrom);
    const header = `<!-- ⚠️ 자동 정리됨: ${new Date().toISOString().slice(0, 10)} — 오래된 ${keepFrom} 줄 제거 (cap: ${MEMORY_MAX_LINES} lines / ${MEMORY_MAX_BYTES} bytes) -->\n`;
    const next = header + kept.join('\n') + trailing;
    try {
        const tmp = filePath + '.tmp';
        fs.writeFileSync(tmp, next, 'utf-8');
        fs.renameSync(tmp, filePath);
    } catch (e) {
        console.error('[agent-memory] trim failed:', e);
    }
}

/** Append the validated learnings of one agent's output to its memory.md
 *  with scope + project stamping, then trim if caps exceeded.
 *
 *  Storage format per line: `YYYY-MM-DD 🧠 [scope[:project]] content`
 *
 *  `currentProject` (optional, from workspace project.json `name`):
 *   - Stamped onto entries with scope='project' as `[project:NAME]`
 *   - Ignored for scope='critical' or 'global'
 *   - When undefined (no workspace), scope='project' entries fall back to
 *     `[project:_orphan]` so they don't conflict with any real project's
 *     reads — reader filters them out unless current project is also undefined.
 *
 *  Returns count of lines actually appended. */
export function persistLearnings(agentId: string, output: string, currentProject?: string): number {
    const learnings = extractLearnings(output);
    if (learnings.length === 0) return 0;
    const dir = path.join(getCompanyDir(), '_agents', agentId);
    const file = path.join(dir, 'memory.md');
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const date = new Date().toISOString().slice(0, 10);
        const projectTag = currentProject?.trim() || '_orphan';
        const block = learnings.map(l => {
            const scopeTag = l.scope === 'project'
                ? `[project:${projectTag}]`
                : `[${l.scope}]`;
            return `${date} 🧠 ${scopeTag} ${l.content}`;
        }).join('\n') + '\n';
        fs.appendFileSync(file, block, 'utf-8');
        trimMemoryFile(file);
        return learnings.length;
    } catch (e) {
        console.error('[agent-memory] persist failed for', agentId, e);
        return 0;
    }
}

/** Allocation budget for the scoped memory block. Numbers chosen so the
 *  total roughly matches the old single-block budget (~4000 normal, ~1500
 *  lean) but distributed across scopes. */
export interface MemoryBudget {
    critical: number;
    project: number;
    global: number;
}
export const MEMORY_BUDGET_NORMAL: MemoryBudget = { critical: 1200, project: 2000, global: 800 };
export const MEMORY_BUDGET_LEAN: MemoryBudget = { critical: 500, project: 700, global: 300 };

/** Build the memory prompt block for one agent, filtered by scope + current
 *  project. Allocation per scope is bounded — critical always included
 *  (security/safety can't be skipped), current project gets the largest share,
 *  global gets a small slot. Other projects' entries are dropped (would be
 *  cross-context noise).
 *
 *  Returns the assembled block string (already wrapped with section headers),
 *  or empty string if no entries match. */
export function buildScopedMemoryBlock(
    rawMemory: string,
    currentProject: string | undefined,
    budget: MemoryBudget = MEMORY_BUDGET_NORMAL,
): string {
    if (!rawMemory || !rawMemory.trim()) return '';
    const lines = rawMemory.split(/\r?\n/);
    const critical: MemoryEntry[] = [];
    const projectEntries: MemoryEntry[] = [];
    const global: MemoryEntry[] = [];
    for (const ln of lines) {
        const e = parseMemoryLine(ln);
        if (!e) continue; /* legacy/malformed — skip */
        if (e.scope === 'critical') critical.push(e);
        else if (e.scope === 'global') global.push(e);
        else if (e.scope === 'project') {
            /* Match: same project (including both undefined). Drop cross-project. */
            const proj = e.project || '_orphan';
            const want = currentProject?.trim() || '_orphan';
            if (proj === want) projectEntries.push(e);
        }
    }
    /* Newest first within each bucket. Memory file is append-only, so latest
       entries are at the END of the lines array → reverse to put recent first. */
    critical.reverse();
    projectEntries.reverse();
    global.reverse();
    function fitWithin(entries: MemoryEntry[], cap: number): string[] {
        const out: string[] = [];
        let used = 0;
        for (const e of entries) {
            const line = e.raw.trim();
            if (used + line.length + 1 > cap) break;
            out.push(line);
            used += line.length + 1;
        }
        return out;
    }
    const cBlock = fitWithin(critical, budget.critical);
    const pBlock = fitWithin(projectEntries, budget.project);
    const gBlock = fitWithin(global, budget.global);
    if (cBlock.length === 0 && pBlock.length === 0 && gBlock.length === 0) return '';
    const sections: string[] = [];
    if (cBlock.length > 0) sections.push(`🔴 [critical — 항상 우선]\n${cBlock.join('\n')}`);
    if (pBlock.length > 0) {
        const label = currentProject ? `이 프로젝트 (${currentProject})` : '현재';
        sections.push(`📌 [project — ${label}]\n${pBlock.join('\n')}`);
    }
    if (gBlock.length > 0) sections.push(`🌍 [global — 모든 프로젝트 공통]\n${gBlock.join('\n')}`);
    return sections.join('\n\n');
}
