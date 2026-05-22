/**
 * Tracker domain barrel.
 *
 * extension.ts 에서 분리된 Tracker(할 일/recurrence) 도우미들을 한 곳으로 묶음.
 * 모든 함수는 companyDir 를 명시적으로 받아 vscode 의존성 없음. UI refresh
 * 이벤트(`_trackerChangeEmitter.fire()`) 는 wrapper 가 처리한다.
 */

export type { TaskPriority, TrackerTask } from './types';
export {
    TASK_PRIORITY_ORDER,
    TASK_PRIORITY_LABEL,
    coercePriority,
} from './types';

export {
    trackerPath,
    readTracker,
    writeTracker,
} from './io';

export {
    newTaskId,
    addTask,
    updateTask,
    listOpen,
} from './mutations';

export {
    parseLooseDate,
    computeNextRunAt,
} from './recurrence';
