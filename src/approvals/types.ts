/**
 * Approvals 도메인 타입.
 *
 * extension.ts 의 PendingApproval 인터페이스에서 분리됨. 파일 기반 승인 게이트
 * (`<companyDir>/approvals/{pending,history,executors}/`) 의 공통 shape.
 *
 * - id: `apr-<timestamp14>-<rand4>` (createApproval 이 자동 부여)
 * - createdAt: ISO 8601 (createApproval 이 자동 부여)
 * - kind: 실행기 디스패치 키 (e.g. 'youtube.comment_reply', 'deploy.prod')
 * - payload: 실행기에 전달되는 opaque 데이터 (JSON 직렬화 가능해야 함)
 */
export interface PendingApproval {
    id: string;
    agentId: string;
    /** one-line description — 마크다운 H1 에 들어감 */
    title: string;
    /** short rationale — 마크다운 "요약" 섹션에 들어감 */
    summary: string;
    /** executor 에 전달되는 opaque blob */
    payload: any;
    /** dispatch key e.g. 'youtube.comment_reply', 'deploy.prod', 'instagram.post' */
    kind: string;
    /** ISO 8601 */
    createdAt: string;
}

/**
 * resolveApproval 반환 타입.
 *
 * ok=false 는 id 매칭 실패. ok=true 는 디스크 이동이 성공한 경우.
 * executor 실패는 ok 에 영향을 주지 않는다 (best-effort) — message 에 결과 포함.
 */
export interface ResolveResult {
    ok: boolean;
    message: string;
    ap?: PendingApproval;
}

/**
 * Optional agent label resolver — extension.ts 의 AGENTS map 을 외부에서 주입.
 *
 * 없으면 (또는 빈 문자열 반환 시) raw agentId 를 사용한다. 원본 동작:
 *   `${a.emoji} ${a.name}` || ap.agentId
 */
export type AgentLabelResolver = (agentId: string) => string | undefined;

/**
 * Approval executor callback — 'approved' 결정 시 호출된다.
 *
 * extension.ts 원본에서는 `approvals/executors/{kind}.js` 를 spawnSync 로 실행.
 * 모듈에서는 callback 으로 추상화해 테스트 가능하게 만든다.
 * - return value 의 ok=false 또는 throw 는 둘 다 best-effort 로 삼킨다.
 * - output 은 audit 마크다운에 1500 자까지 첨부된다.
 */
export type ApprovalExecutor = (approval: PendingApproval) => Promise<ExecutorResult | void>;

export interface ExecutorResult {
    ok: boolean;
    output?: string;
}
