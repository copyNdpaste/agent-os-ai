/**
 * company/metrics — readMetrics / updateMetrics / daysSinceFounding BDD.
 *
 * 각 테스트는 tmp dir 을 따로 만들어 격리한다. metrics 는 단일 JSON 파일이라
 * vi.resetModules 없이도 안전 — 모듈 로컬 state 가 없다.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    readMetrics,
    updateMetrics,
    metricsPath,
    daysSinceFounding,
} from '../../src/company/metrics';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'company-metrics-'));
}

describe('company/metrics', () => {
    let tmp: string;
    beforeEach(() => { tmp = mkTmp(); });
    afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('readMetrics 는 파일 없으면 원본 default (0/0/"" + foundedAt 없음) 을 반환한다', () => {
        // Given: 빈 디렉터리 (metrics 파일 없음)
        // When
        const m = readMetrics(tmp);
        // Then: 원본 코드의 default 와 동일해야 한다
        expect(m).toEqual({ tasksCompleted: 0, knowledgeInjected: 0, lastSessionDate: '' });
        expect(m.foundedAt).toBeUndefined();
    });

    it('updateMetrics 는 일부 필드만 머지하고 나머지는 보존한다', () => {
        // Given: 초기 상태로 한 번 기록
        updateMetrics(tmp, { tasksCompleted: 5, knowledgeInjected: 3, lastSessionDate: '2026-05-01' });
        // When: tasksCompleted 만 갱신
        updateMetrics(tmp, { tasksCompleted: 7 });
        // Then: 다른 두 필드는 그대로
        const m = readMetrics(tmp);
        expect(m.tasksCompleted).toBe(7);
        expect(m.knowledgeInjected).toBe(3);
        expect(m.lastSessionDate).toBe('2026-05-01');
    });

    it('updateMetrics 는 새 키 (foundedAt) 를 추가할 수 있다', () => {
        // Given: foundedAt 없는 초기 상태
        updateMetrics(tmp, { tasksCompleted: 1 });
        expect(readMetrics(tmp).foundedAt).toBeUndefined();
        // When: foundedAt 추가
        updateMetrics(tmp, { foundedAt: '2026-01-15' });
        // Then: 새 키가 영속화되고 기존 필드도 살아있다
        const m = readMetrics(tmp);
        expect(m.foundedAt).toBe('2026-01-15');
        expect(m.tasksCompleted).toBe(1);
    });

    it('daysSinceFounding 은 foundedAt 이 없으면 0 을 반환한다', () => {
        // Given: foundedAt 없는 metrics
        // When
        const days = daysSinceFounding(tmp);
        // Then
        expect(days).toBe(0);
    });

    it('daysSinceFounding 은 ISO 날짜로부터 정수 일수를 계산한다', () => {
        // Given: 10일 전 founded — 함수 내부와 동일한 방식 (Date.parse + 'T00:00:00')
        //        으로 오늘 자정 timestamp 를 잡고, 거기서 정확히 10일을 뺀 날짜의
        //        YYYY-MM-DD 를 foundedAt 으로 박는다. 시간대/DST 영향 안 받게.
        const todayIso = new Date().toISOString().slice(0, 10);
        const todayLocalMid = Date.parse(todayIso + 'T00:00:00');
        const tenDaysAgoIso = new Date(todayLocalMid - 10 * 86400000)
            .toISOString().slice(0, 10);
        updateMetrics(tmp, { foundedAt: tenDaysAgoIso });

        // When
        const days = daysSinceFounding(tmp);

        // Then: 정확히 10일 (±1 허용 — 자정 직전 실행 시 DST/시간대 경계)
        expect(days).toBeGreaterThanOrEqual(9);
        expect(days).toBeLessThanOrEqual(11);
    });

    it('metricsPath 는 baseDir 아래 company_state.json (원본 파일명) 을 가리키고 updateMetrics 가 그 경로에 쓴다', () => {
        // Given: update 한 번
        updateMetrics(tmp, { tasksCompleted: 42 });
        // When
        const p = metricsPath(tmp);
        // Then: 파일이 정확히 거기에 존재 — 디스크 호환성 위해 원본 파일명 유지
        expect(p).toBe(path.join(tmp, 'company_state.json'));
        expect(fs.existsSync(p)).toBe(true);
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        expect(raw.tasksCompleted).toBe(42);
    });
});
