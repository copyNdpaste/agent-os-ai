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

/** Match a `🧠 학습:` prefix tolerant of leading/trailing whitespace.
 *  Strict on the emoji + label so accidental "🧠 노트:" type variants don't
 *  leak through. Capture group = the content after the prefix. */
const LEARNING_PREFIX_RE = /^\s*🧠\s*학습\s*:\s*(.+?)\s*$/;

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
    const content = m[1].trim();
    if (content.length < LEARNING_MIN_CHARS) return false;
    if (content.length > LEARNING_MAX_CHARS) return false;
    for (const p of NOISE_PATTERNS) {
        if (p.test(content)) return false;
    }
    return true;
}

/** Scan an agent's full output text for `🧠 학습:` lines that pass the gate.
 *  Returns the cleaned content (prefix stripped, trimmed) — caller decides
 *  whether to add a date prefix etc. before persisting. */
export function extractLearnings(output: string): string[] {
    if (!output) return [];
    const lines = output.split(/\r?\n/);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const ln of lines) {
        if (!isValidLearning(ln)) continue;
        const m = LEARNING_PREFIX_RE.exec(ln);
        if (!m) continue;
        const content = m[1].trim();
        /* 같은 학습 중복 방지 (한 답변에 같은 줄 두 번 출력하는 작은 LLM 케이스) */
        if (seen.has(content)) continue;
        seen.add(content);
        out.push(content);
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

/** Append the validated learnings of one agent's output to its memory.md,
 *  then trim if caps exceeded. Date prefix added so future readers (and the
 *  trim logic) can chronologically scan. No-op when no learnings pass gate. */
export function persistLearnings(agentId: string, output: string): number {
    const learnings = extractLearnings(output);
    if (learnings.length === 0) return 0;
    const dir = path.join(getCompanyDir(), '_agents', agentId);
    const file = path.join(dir, 'memory.md');
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const date = new Date().toISOString().slice(0, 10);
        const block = learnings.map(l => `${date} 🧠 ${l}`).join('\n') + '\n';
        fs.appendFileSync(file, block, 'utf-8');
        trimMemoryFile(file);
        return learnings.length;
    } catch (e) {
        console.error('[agent-memory] persist failed for', agentId, e);
        return 0;
    }
}
