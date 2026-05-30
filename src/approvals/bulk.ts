/**
 * Bulk approval helpers.
 *
 * Approves every pending item except approvals explicitly marked as excluded
 * in payload/top-level metadata. Sequential on purpose: executors may touch
 * rate-limited APIs, so parallel release would be risky.
 */
import type { ApprovalExecutor, PendingApproval } from './types';
import { listPending } from './list';
import { resolveApproval } from './resolve';

export interface BulkResolveResult {
    ok: boolean;
    total: number;
    approved: number;
    skipped: number;
    failed: number;
    messages: string[];
}

function _lower(v: unknown): string {
    return String(v ?? '').trim().toLowerCase();
}

export function isApprovalExcluded(ap: PendingApproval): boolean {
    const anyAp = ap as any;
    const payload = (ap.payload && typeof ap.payload === 'object') ? ap.payload : {};
    if (anyAp.excluded === true || payload.excluded === true) return true;
    if (anyAp.exclude === true || payload.exclude === true) return true;
    const markers = [
        anyAp.status, anyAp.state, anyAp.decision,
        payload.status, payload.state, payload.decision,
        payload.approvalStatus, payload.queueStatus,
    ].map(_lower);
    return markers.some(v => v === 'excluded' || v === 'exclude' || v === 'skipped' || v === 'skip');
}

export async function approvePendingBulk(
    companyDir: string,
    reason = '일괄 승인',
    executor?: ApprovalExecutor
): Promise<BulkResolveResult> {
    const pending = listPending(companyDir);
    const result: BulkResolveResult = {
        ok: true,
        total: pending.length,
        approved: 0,
        skipped: 0,
        failed: 0,
        messages: [],
    };
    for (const ap of pending) {
        if (isApprovalExcluded(ap)) {
            result.skipped += 1;
            result.messages.push(`⏭️ 제외됨 — ${ap.title}`);
            continue;
        }
        const r = await resolveApproval(companyDir, ap.id, 'approved', reason, executor);
        if (r.ok) {
            result.approved += 1;
        } else {
            result.failed += 1;
            result.ok = false;
        }
        result.messages.push(r.message);
    }
    return result;
}
