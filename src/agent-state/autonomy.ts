/**
 * Per-agent tool autonomy level read.
 *
 * extension.ts 에서 분리됨 (god-file Agent-state 모듈화). companyDir 는 외부에서
 * 주입한다.
 *
 * 자율성은 0~3 의 4 단계 — 0=Off, 1=Read-only, 2=Draft→Approve(기본), 3=Auto.
 * 디스크 표현은 에이전트별 `tools.md` 안의 `AUTONOMY_LEVEL: <digit>` 라인.
 * 파일이 없거나 파싱 실패하면 안전한 기본값 2(Draft) 로 fallback.
 */
import * as fs from 'fs';
import * as path from 'path';

export const AUTONOMY_DEFAULT = 2;
export const AUTONOMY_MIN = 0;
export const AUTONOMY_MAX = 3;

/** 에이전트별 tools.md 의 AUTONOMY_LEVEL 라인을 읽어 0~3 의 정수로 반환.
 *
 *  파싱 실패 / 파일 없음 → AUTONOMY_DEFAULT(2). 범위 밖 값은 clamp.
 *  비숫자는 정규식 매칭 자체가 안 되어 default fallback. */
export function readAutonomyLevel(companyDir: string, agentId: string): number {
    try {
        const p = path.join(companyDir, '_agents', agentId, 'tools.md');
        const txt = safeReadText(p);
        const m = txt.match(/AUTONOMY_LEVEL\s*[:：=]\s*(\d)/);
        if (m) {
            const n = parseInt(m[1], 10);
            if (Number.isFinite(n)) {
                return Math.max(AUTONOMY_MIN, Math.min(AUTONOMY_MAX, n));
            }
        }
    } catch { /* ignore */ }
    return AUTONOMY_DEFAULT;
}

function safeReadText(p: string): string {
    try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}
