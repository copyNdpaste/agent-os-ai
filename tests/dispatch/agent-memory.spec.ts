/* dispatch/agent-memory — 🧠 학습 마커 추출 / 검증 게이트 / trim.
   src/paths.ts 가 vscode 를 import 하기 때문에 module load 단계에서 vite 가
   resolve 시도. 테스트는 pure 로직만 검증하므로 vscode 를 빈 stub 으로 mock. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({ get: (_k: string, def: any) => def }),
        workspaceFolders: [],
    },
}));

import {
    extractLearnings,
    isValidLearning,
    trimMemoryFile,
    MEMORY_MAX_LINES,
} from '../../src/dispatch/agent-memory';

describe('dispatch/agent-memory — isValidLearning', () => {
    it('정확한 prefix + 의미있는 내용은 통과', () => {
        expect(isValidLearning('🧠 학습: 주말 매출이 평일의 1.8배. 토요일 캠페인 집중 권장.'))
            .toBe(true);
    });

    it('prefix 없으면 거부', () => {
        expect(isValidLearning('학습: 좋은 발견이 있었습니다')).toBe(false);
        expect(isValidLearning('🧠 노트: 다른 마커')).toBe(false);
    });

    it('20자 미만 거부 (너무 짧음)', () => {
        expect(isValidLearning('🧠 학습: 좋음.')).toBe(false);
    });

    it('300자 초과 거부 (요약 실패)', () => {
        const long = '🧠 학습: ' + 'a'.repeat(400);
        expect(isValidLearning(long)).toBe(false);
    });

    it('메타 보고 패턴 거부', () => {
        expect(isValidLearning('🧠 학습: 분석을 진행했습니다. 데이터 확인 완료되었습니다 sessions/x'))
            .toBe(false);
        expect(isValidLearning('🧠 학습: 매출 분석 결과를 sessions/2026-05.md 에 저장 완료'))
            .toBe(false);
    });

    it('이모지·구두점만으로 된 줄 거부', () => {
        expect(isValidLearning('🧠 학습: ✅ ✨ 🎉 . . . — — —')).toBe(false);
    });

    it('추측성 어미 거부', () => {
        expect(isValidLearning('🧠 학습: 브랜딩이 매우 중요할 것 같습니다 — 향후 전략 고려'))
            .toBe(false);
    });
});

describe('dispatch/agent-memory — extractLearnings', () => {
    it('답변 본문에서 학습 라인만 추출', () => {
        const output = `## 분석 결과

매출 데이터를 보면 주말 집중도가 높습니다.

🧠 학습: 주말 매출 비중 65% — 토요일 광고 우선순위 높이기.

추가 권장: ...`;
        expect(extractLearnings(output)).toEqual([
            '주말 매출 비중 65% — 토요일 광고 우선순위 높이기.',
        ]);
    });

    it('여러 학습 줄 모두 추출 + 중복 제거', () => {
        const output = `
🧠 학습: 사장님은 즉시 액션 1개를 선호. 보고서 구조 단순화.
중간 텍스트
🧠 학습: PayPal live 자격증명 별도 발급 필요. sandbox 와 분리.
🧠 학습: 사장님은 즉시 액션 1개를 선호. 보고서 구조 단순화.
`;
        const result = extractLearnings(output);
        expect(result.length).toBe(2); /* 중복 한 줄 제거됨 */
        expect(result).toContain('사장님은 즉시 액션 1개를 선호. 보고서 구조 단순화.');
        expect(result).toContain('PayPal live 자격증명 별도 발급 필요. sandbox 와 분리.');
    });

    it('통과한 학습과 거부된 학습 섞여있어도 통과한 것만 반환', () => {
        /* 라인 안 inline 주석을 넣으면 길이 게이트를 통과해버리므로 실제 거부될
           라인은 클린하게. 의도:
             첫 줄  — 길이 20자 미만 (거부)
             둘째   — 메타 보고 + sessions/ 경로 (거부)
             셋째   — 통과해야 함 */
        const output = [
            '',
            '🧠 학습: 짧음.',
            '🧠 학습: 분석 진행 완료, 결과는 sessions/x.md 에 저장',
            '🧠 학습: 인스타 댓글에 "쇼츠" 키워드 23회 등장 — 미스터비스트 콘텐츠 우선순위에 활용.',
            '',
        ].join('\n');
        const result = extractLearnings(output);
        expect(result.length).toBe(1);
        expect(result[0]).toContain('쇼츠');
    });

    it('학습 라인 없으면 빈 배열', () => {
        expect(extractLearnings('일반 답변에 학습 마커 없음')).toEqual([]);
        expect(extractLearnings('')).toEqual([]);
    });
});

describe('dispatch/agent-memory — trimMemoryFile', () => {
    let tmpDir: string;
    let file: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-'));
        file = path.join(tmpDir, 'memory.md');
    });
    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('파일 없으면 no-op', () => {
        trimMemoryFile(file); /* throw 하지 않아야 함 */
        expect(fs.existsSync(file)).toBe(false);
    });

    it('cap 이내면 변경 없음', () => {
        const content = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n') + '\n';
        fs.writeFileSync(file, content);

        trimMemoryFile(file);

        expect(fs.readFileSync(file, 'utf-8')).toBe(content);
    });

    it('라인 수 cap 초과 시 오래된 50% 제거', () => {
        const lines = Array.from({ length: MEMORY_MAX_LINES + 20 }, (_, i) => `entry ${i}`);
        fs.writeFileSync(file, lines.join('\n') + '\n');

        trimMemoryFile(file);

        const kept = fs.readFileSync(file, 'utf-8');
        /* 헤더 + 최신 절반 유지 — 가장 마지막 entry 포함 */
        expect(kept).toContain(`entry ${MEMORY_MAX_LINES + 19}`);
        /* 첫 entry 는 잘려나감 */
        expect(kept).not.toContain('entry 0\n');
        expect(kept).toContain('<!-- ⚠️ 자동 정리됨');
    });
});
