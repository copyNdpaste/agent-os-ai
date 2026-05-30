/**
 * Approvals 도메인 barrel.
 *
 * extension.ts 의 PendingApproval 게이트 시스템을 추출 — 파일 기반 승인 워크플로
 * (pending → history) 를 순수 IO + executor callback 으로 모듈화.
 * Telegram/conversation-log/sidebar pulse 같은 통합 사이드 이펙트는 호출자에 남아
 * 있다 — 이 도메인은 디스크 라운드트립만 책임진다.
 */

export type {
    PendingApproval,
    ResolveResult,
    AgentLabelResolver,
    ApprovalExecutor,
    ExecutorResult,
} from './types';

export { pendingDir, historyDir, executorsDir } from './paths';

export { newApprovalId, createApproval } from './create';
export type { CreateApprovalOptions } from './create';

export { listPending, findByShortId } from './list';

export { resolveApproval } from './resolve';
export { approvePendingBulk, isApprovalExcluded } from './bulk';
export type { BulkResolveResult } from './bulk';
