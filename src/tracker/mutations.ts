/**
 * Tracker mutations (add / update / list / id-gen).
 *
 * extension.ts 에서 분리됨. companyDir 주입. 캘린더 자동 동기화 사이드 이펙트
 * (createCalendarEventForTask / updateCalendarEventForTask / deleteCalendarEvent)
 * 는 vscode·다른 도메인 의존이라 이 모듈에서 제외 — wrapper (extension.ts) 가
 * addTask/updateTask 의 반환값을 보고 호출한다.
 *
 * 30일 이전 done/cancelled 항목 자동 폐기 정책은 그대로 유지한다 (파일 무한
 * 증가 방지).
 */
import { coercePriority, type TrackerTask } from './types';
import { readTracker, writeTracker } from './io';

/**
 * 새 task id 생성 — UTC timestamp(14자리) + base36 랜덤(4자리). 충돌 가능성은
 * 사실상 0 이지만, 단일 프로세스 내 보장이 필요한 곳에서는 caller 가 추가
 * 체크 하는 것을 권장.
 */
export function newTaskId(): string {
    const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    const rand = Math.random().toString(36).slice(2, 6);
    return `${stamp}-${rand}`;
}

/**
 * 새 task 추가. id/createdAt/status/nudges/priority/preAlarmsSent 기본값 채움.
 * - title 200자, description 1000자 제한 (원본 동작 그대로 — tracker 파일이
 *   너무 커지는 것 방지)
 * - status 미지정 시 owner='agent' → 'in_progress', 그 외 → 'pending'
 * - 30일 이전 done/cancelled 자동 제거
 *
 * 캘린더 자동 생성은 wrapper 측에서 처리한다 (반환된 task 의 dueAt 확인 후).
 */
export function addTask(
    companyDir: string,
    partial: Partial<TrackerTask> & { title: string; owner: TrackerTask['owner'] }
): TrackerTask {
    const t = readTracker(companyDir);
    const task: TrackerTask = {
        id: partial.id || newTaskId(),
        title: partial.title.slice(0, 200),
        description: partial.description?.slice(0, 1000),
        owner: partial.owner,
        agentIds: partial.agentIds,
        createdAt: partial.createdAt || new Date().toISOString(),
        dueAt: partial.dueAt,
        status: partial.status || (partial.owner === 'agent' ? 'in_progress' : 'pending'),
        sessionDir: partial.sessionDir,
        nudges: 0,
        priority: coercePriority(partial.priority),
        recurrence: partial.recurrence,
        nextRunAt: partial.nextRunAt,
        preAlarmsSent: partial.preAlarmsSent || [],
    };
    t.tasks.push(task);
    /* Keep file from growing unbounded — drop very old completed/cancelled. */
    const cutoff = Date.now() - 30 * 86_400_000;
    t.tasks = t.tasks.filter(x => {
        if (x.status === 'done' || x.status === 'cancelled') {
            const at = new Date(x.completedAt || x.createdAt).getTime();
            return at >= cutoff;
        }
        return true;
    });
    writeTracker(companyDir, t);
    return task;
}

/**
 * patch 필드만 머지해 task 를 업데이트. status 가 done/cancelled 로 바뀌고
 * completedAt 이 비어있으면 now 로 채운다 — 원본 동작 보존.
 *
 * 존재하지 않는 id → null 반환 (no-op).
 *
 * 캘린더 mirror (cancelled→delete, done/title/due 변화 → patch) 는 wrapper 측
 * 에서 prev/cur diff 를 보고 직접 호출한다.
 */
export function updateTask(
    companyDir: string,
    id: string,
    patch: Partial<TrackerTask>
): TrackerTask | null {
    const t = readTracker(companyDir);
    const idx = t.tasks.findIndex(x => x.id === id);
    if (idx < 0) return null;
    const prev = t.tasks[idx];
    t.tasks[idx] = { ...prev, ...patch };
    const cur = t.tasks[idx];
    if ((patch.status === 'done' || patch.status === 'cancelled') && !cur.completedAt) {
        cur.completedAt = new Date().toISOString();
    }
    writeTracker(companyDir, t);
    return t.tasks[idx];
}

/** done/cancelled 가 아닌 모든 task. */
export function listOpen(companyDir: string): TrackerTask[] {
    return readTracker(companyDir).tasks.filter(
        t => t.status !== 'done' && t.status !== 'cancelled'
    );
}
