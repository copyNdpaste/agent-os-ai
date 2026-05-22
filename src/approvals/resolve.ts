/**
 * resolveApproval — 승인 또는 거부 결정을 디스크에 기록하고 파일을 history/ 로
 * 이동.
 *
 * extension.ts 원본에서 분리됨. 원본은 'approved' 시 `approvals/executors/{kind}.js`
 * 를 spawnSync 로 실행했지만, 이 모듈은 executor 를 callback 으로 추상화한다
 * (테스트 가능 + node:child_process 의존 제거).
 *
 * 동작:
 *   1. id 로 pending 찾기 — 없으면 { ok: false } 즉시 반환
 *   2. 'approved' 면 executor callback 호출 (있을 때만)
 *      - throw 또는 ok=false 둘 다 best-effort 로 삼킴 — 결과는 audit 에 기록
 *      - 호출되지 않으면 "(no executor — manual follow-up)" 마커
 *   3. {id}.md 에 결정 블록 append (시각/사유/실행 결과)
 *   4. {id}.{md,json} 을 history/{stamp}_{tag}_{id}.{ext} 로 rename
 *   5. { ok: true, ap, message } 반환
 *
 * 'rejected' 일 때 executor 는 호출되지 않는다 (원본 동작).
 */
import * as path from 'path';
import * as fs from 'fs';
import type {
    PendingApproval,
    ResolveResult,
    ApprovalExecutor,
    ExecutorResult,
} from './types';
import { pendingDir, historyDir } from './paths';
import { findByShortId } from './list';

export async function resolveApproval(
    companyDir: string,
    id: string,
    decision: 'approved' | 'rejected',
    reason: string = '',
    executor?: ApprovalExecutor
): Promise<ResolveResult> {
    const ap = findByShortId(companyDir, id);
    if (!ap) return { ok: false, message: '해당 id 승인 요청을 찾지 못했어요.' };
    const pDir = pendingDir(companyDir);
    const hDir = historyDir(companyDir);
    fs.mkdirSync(hDir, { recursive: true });
    /* Move both files (md + json) to history with decision suffix. */
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const tag = decision === 'approved' ? 'OK' : 'NO';
    const baseSrc = path.join(pDir, ap.id);
    const baseDst = path.join(hDir, `${stamp}_${tag}_${ap.id}`);
    let executorOutput = '';
    let executorOk = true;
    if (decision === 'approved') {
        if (executor) {
            try {
                const r = (await executor(ap)) as ExecutorResult | void;
                if (r && typeof r === 'object') {
                    executorOk = r.ok !== false;
                    executorOutput = r.output || '';
                } else {
                    executorOk = true;
                    executorOutput = '';
                }
            } catch (e: any) {
                executorOk = false;
                executorOutput = `executor error: ${e?.message || e}`;
            }
        } else {
            executorOutput = `(no executor for ${ap.kind} — approval recorded, manual follow-up)`;
        }
    }
    /* Append decision to the markdown for audit. */
    try {
        const mdPath = `${baseSrc}.md`;
        if (fs.existsSync(mdPath)) {
            const append = `\n---\n\n## 결정: **${decision === 'approved' ? '✅ 승인' : '✖️ 거부'}**\n- 시각: ${new Date().toISOString()}\n- 사유: ${reason || '_(없음)_'}\n${decision === 'approved' ? `- 실행 결과: ${executorOk ? 'OK' : 'FAIL'}\n\n\`\`\`\n${executorOutput.slice(0, 1500)}\n\`\`\`\n` : ''}`;
            fs.appendFileSync(mdPath, append);
        }
    } catch { /* ignore */ }
    /* Move pending → history. */
    try {
        for (const ext of ['.md', '.json']) {
            const src = `${baseSrc}${ext}`;
            const dst = `${baseDst}${ext}`;
            if (fs.existsSync(src)) fs.renameSync(src, dst);
        }
    } catch { /* ignore */ }
    return {
        ok: true,
        ap,
        message: decision === 'approved'
            ? `✅ 승인됨 — ${ap.title}${executorOutput ? `\n\n${executorOutput.slice(0, 600)}` : ''}`
            : `✖️ 거부됨 — ${ap.title}`,
    };
}
