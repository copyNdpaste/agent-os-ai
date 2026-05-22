/**
 * Agent-state modules barrel.
 *
 * extension.ts 에서 분리된 Agent 상태(채용/활성/모델 라우팅/자율성) 도우미들을
 * 한 곳으로 묶음. 모든 함수는 companyDir 를 명시적으로 받아 vscode 의존성 없음.
 */

export type { HiredEntry } from './hired';
export {
    hiredJsonPath,
    readHired,
    isHired,
    markHired,
} from './hired';

export type { ActiveEntry } from './active';
export {
    activeJsonPath,
    readActive,
    isActive,
    setActive,
    isTogglable,
} from './active';

export type { ModelTier } from './models';
export {
    modelsJsonPath,
    readModelMap,
    writeModelMap,
    getModelFor,
    classifyModel,
    autoOrchestrate,
} from './models';

export {
    AUTONOMY_DEFAULT,
    AUTONOMY_MIN,
    AUTONOMY_MAX,
    readAutonomyLevel,
} from './autonomy';
