/**
 * Company metrics — tasksCompleted / knowledgeInjected / Day N 카운터.
 *
 * extension.ts 의 getCompanyMetrics / updateCompanyMetrics / getCompanyDay 에서
 * 분리됨. 원본은 _getBrainDir() + 'company_state.json' 글로벌에 의존했지만,
 * 여기서는 baseDir 를 외부 주입받아 테스트 가능하게 만든다.
 *
 * 파일 경로: `<baseDir>/company_state.json` — 원본 위치 그대로 (brain dir).
 * baseDir 인자명은 의도적으로 generic — wrapper 에서 brain 을 주입.
 */
import * as fs from 'fs';
import * as path from 'path';

export type CompanyMetrics = {
    tasksCompleted: number;
    knowledgeInjected: number;
    lastSessionDate: string;
    foundedAt?: string;
};

/** Disk path for the metrics blob. baseDir 아래에 단일 JSON 으로 보관해
 *  git-sync 가 자연스럽게 따라오게 한다. */
export function metricsPath(baseDir: string): string {
    return path.join(baseDir, 'company_state.json');
}

/** 파일이 없거나 깨졌으면 원본과 동일한 default 를 돌려준다.
 *  (tasksCompleted=0, knowledgeInjected=0, lastSessionDate='') */
export function readMetrics(baseDir: string): CompanyMetrics {
    try {
        const file = metricsPath(baseDir);
        if (fs.existsSync(file)) {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        }
    } catch { /* fall through to default */ }
    return { tasksCompleted: 0, knowledgeInjected: 0, lastSessionDate: '' };
}

/** Partial merge 후 동기 쓰기. 디렉터리는 필요시 생성한다.
 *  원본 v2.89.25 주석: baseDir 가 첫 활성화 시점에 없을 수 있어 mkdirSync
 *  recursive 가 필수 — 그렇지 않으면 foundedAt 영원히 영속화 안 되고 Day 매번 1. */
export function updateMetrics(baseDir: string, updates: Partial<CompanyMetrics>): void {
    try {
        try { fs.mkdirSync(baseDir, { recursive: true }); } catch { /* ignore */ }
        const file = metricsPath(baseDir);
        const s = readMetrics(baseDir);
        Object.assign(s, updates);
        fs.writeFileSync(file, JSON.stringify(s, null, 2));
    } catch (e: any) {
        // eslint-disable-next-line no-console
        console.warn('[updateMetrics] write failed:', e?.message || e);
    }
}

/** foundedAt(YYYY-MM-DD) 부터 오늘까지의 정수 일수.
 *  - foundedAt 없으면 0 (원본은 1 부터 카운트했지만, 여기서는 spec 에 맞게
 *    "없을 때 0" 으로 명시. caller 가 +1 해서 표시하든 자유). */
export function daysSinceFounding(baseDir: string): number {
    try {
        const m = readMetrics(baseDir);
        if (!m.foundedAt) return 0;
        const start = Date.parse(m.foundedAt + 'T00:00:00');
        const now = Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00');
        if (!isFinite(start) || !isFinite(now)) return 0;
        return Math.max(0, Math.floor((now - start) / 86400000));
    } catch {
        return 0;
    }
}
