/**
 * Approvals 목록 / lookup.
 *
 * extension.ts 의 listPendingApprovals / findApprovalByShortId 에서 분리됨.
 *
 * - listPending: pending/ 의 .json 파일을 모두 파싱. 깨진 파일은 조용히 skip.
 *   createdAt 오름차순 정렬 (가장 오래된 요청이 먼저).
 * - findByShortId: 전체 id 매칭 → 그래도 없으면 끝 9자리 매칭. 텔레그램에서
 *   사용자가 `/approve abc12def3` 처럼 짧은 id 만 쳐도 동작하게 한다.
 */
import * as path from 'path';
import * as fs from 'fs';
import type { PendingApproval } from './types';
import { pendingDir } from './paths';

export function listPending(companyDir: string): PendingApproval[] {
    const dir = pendingDir(companyDir);
    if (!fs.existsSync(dir)) return [];
    const out: PendingApproval[] = [];
    for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        try {
            const txt = fs.readFileSync(path.join(dir, f), 'utf-8');
            const ap = JSON.parse(txt);
            if (ap && ap.id) out.push(ap);
        } catch { /* skip malformed */ }
    }
    out.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return out;
}

export function findByShortId(companyDir: string, short: string): PendingApproval | null {
    const all = listPending(companyDir);
    return all.find(a => a.id === short) || all.find(a => a.id.endsWith(short)) || null;
}
