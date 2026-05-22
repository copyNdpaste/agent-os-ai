/**
 * Approvals 디렉토리 경로.
 *
 * extension.ts 의 _approvalsPendingDir / _approvalsHistoryDir /
 * _approvalsExecutorsDir 에서 분리됨. getCompanyDir 글로벌 호출을 인자로 치환.
 *
 * 레이아웃:
 *   <companyDir>/approvals/
 *     pending/        ⏳ 승인 대기 (id.md + id.json)
 *     history/        ✅/✖️ 결정된 것 (timestamp_OK_id.{md,json})
 *     executors/      {kind}.js — node 로 실행되는 후크 스크립트
 */
import * as path from 'path';

export function pendingDir(companyDir: string): string {
    return path.join(companyDir, 'approvals', 'pending');
}

export function historyDir(companyDir: string): string {
    return path.join(companyDir, 'approvals', 'history');
}

export function executorsDir(companyDir: string): string {
    return path.join(companyDir, 'approvals', 'executors');
}
