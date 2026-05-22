/**
 * Active dispatch tracker — in-memory state machine that de-duplicates fast
 * re-submissions of the same prompt.
 *
 * extension.ts 에서 분리됨 (god-file 모듈화). 모든 상태는 모듈-private.
 *
 * v2.88 — 디스패치 중복 감지 + 진행 상태 추적. 사용자가 "유튜브 분석" 을 30초
 * 안에 두 번 보내면 두 번 다 디스패치되어 둘 다 "처리 중" 답을 보내서 AI 가
 * 멍청해 보임. 활성 디스패치를 키(normalized prompt + 5분 TTL)로 추적하고,
 * 같은 요청이 들어오면 새로 시작 안 하고 진행 상황만 알린다.
 *
 * Tests reset module state via `vi.resetModules()` + dynamic import — 프로덕션
 * API 에 `__reset` 같은 노이즈를 두지 않기 위함.
 */

export interface ActiveDispatch {
    promptKey: string;
    startedAt: number;
    step: string;                          /* 현재 단계 — "계획 중", "에이전트 분배 중", etc */
    heartbeatTimer: NodeJS.Timeout | null;
    heartbeatCount: number;
    fromTelegram: boolean;
}

export const ACTIVE_DISPATCH_TTL_MS = 5 * 60 * 1000; /* 5분 */

/* Module-private state — kept hidden so callers can't accidentally mutate the
   map directly. Tests reset by re-importing via vi.resetModules(). */
const _activeDispatches: Map<string, ActiveDispatch> = new Map();

/** Normalize a free-form prompt into a stable key. extension.ts 측 dispatcher
 *  queue 도 같은 normalization 을 써야 중복 제거가 일관되므로 export. */
export function normalizeKey(s: string): string {
    /* 공백·구두점 제거하고 첫 80자만 — 사용자가 "유튜브 분석" / "유튜브  분석!"
       을 같은 의도로 묶기 위해. 너무 짧으면 다른 요청도 충돌해서 80자. */
    return (s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '').slice(0, 80);
}

/** Look up a still-live dispatch matching `prompt`. Sweeps TTL-expired entries
 *  on every call so the map self-cleans without a background timer. */
export function find(prompt: string): ActiveDispatch | null {
    const now = Date.now();
    const key = normalizeKey(prompt);
    /* TTL 청소 */
    for (const [k, v] of _activeDispatches.entries()) {
        if (now - v.startedAt > ACTIVE_DISPATCH_TTL_MS) {
            if (v.heartbeatTimer) clearInterval(v.heartbeatTimer);
            _activeDispatches.delete(k);
        }
    }
    return _activeDispatches.get(key) || null;
}

/** Register a new dispatch under the prompt's normalized key. If one already
 *  exists (defensive — caller should have checked via `find`), its heartbeat
 *  timer is cleared before replacement. */
export function start(prompt: string, fromTelegram: boolean): ActiveDispatch {
    const key = normalizeKey(prompt);
    /* 같은 키가 이미 있으면 우선 정리 (방어) */
    const old = _activeDispatches.get(key);
    if (old?.heartbeatTimer) clearInterval(old.heartbeatTimer);
    const entry: ActiveDispatch = {
        promptKey: key,
        startedAt: Date.now(),
        step: '준비 중',
        heartbeatTimer: null,
        heartbeatCount: 0,
        fromTelegram,
    };
    _activeDispatches.set(key, entry);
    return entry;
}

/** Update the current step label on the dispatch keyed by `prompt`. No-op if
 *  the entry has expired or never existed. */
export function updateStep(prompt: string, step: string): void {
    const key = normalizeKey(prompt);
    const entry = _activeDispatches.get(key);
    if (entry) entry.step = step;
}

/** Remove the dispatch keyed by `prompt`, clearing any heartbeat timer. */
export function end(prompt: string): void {
    const key = normalizeKey(prompt);
    const entry = _activeDispatches.get(key);
    if (entry?.heartbeatTimer) clearInterval(entry.heartbeatTimer);
    _activeDispatches.delete(key);
}

/** Clear ALL active dispatches (e.g. user pressed cancel). Returns the step
 *  labels of the cleared entries in iteration order so the caller can show
 *  e.g. "🛑 중단됨 — 마지막 단계: 계획 중". Heartbeat timers are cleared. */
export function cancelAll(): string[] {
    const steps: string[] = [];
    for (const [key, entry] of _activeDispatches.entries()) {
        if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer);
        steps.push(entry.step);
        _activeDispatches.delete(key);
    }
    return steps;
}
