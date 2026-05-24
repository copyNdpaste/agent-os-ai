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
    parseMemoryLine,
    buildScopedMemoryBlock,
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
    it('답변 본문에서 학습 라인만 추출 + 기본 scope=project', () => {
        const output = `## 분석 결과

매출 데이터를 보면 주말 집중도가 높습니다.

🧠 학습: 주말 매출 비중 65% — 토요일 광고 우선순위 높이기.

추가 권장: ...`;
        const r = extractLearnings(output);
        expect(r.length).toBe(1);
        expect(r[0].content).toContain('주말 매출 비중 65%');
        expect(r[0].scope).toBe('project'); /* 기본값 */
    });

    it('[global] / [critical] 명시 scope 파싱', () => {
        const output = [
            '🧠 학습 [global]: 사장님은 즉시 액션 1개를 선호. 보고서 구조 단순화.',
            '🧠 학습 [critical]: PayPal live 자격증명 sandbox 와 별도 발급 필요. 모드 토글 후 재발급.',
            '🧠 학습: 인스타 댓글에서 "쇼츠" 키워드 23회 등장 — 콘텐츠 우선순위.',
        ].join('\n');
        const r = extractLearnings(output);
        expect(r.length).toBe(3);
        expect(r.find(l => l.content.includes('사장님'))?.scope).toBe('global');
        expect(r.find(l => l.content.includes('PayPal'))?.scope).toBe('critical');
        expect(r.find(l => l.content.includes('쇼츠'))?.scope).toBe('project');
    });

    it('중복 content 는 한 번만', () => {
        const output = [
            '🧠 학습: 사장님은 즉시 액션 1개를 선호. 보고서 구조 단순화.',
            '🧠 학습: 사장님은 즉시 액션 1개를 선호. 보고서 구조 단순화.',
        ].join('\n');
        expect(extractLearnings(output).length).toBe(1);
    });

    it('통과한 학습과 거부된 학습 섞여있어도 통과한 것만 반환', () => {
        const output = [
            '',
            '🧠 학습: 짧음.',
            '🧠 학습: 분석 진행 완료, 결과는 sessions/x.md 에 저장',
            '🧠 학습: 인스타 댓글에 "쇼츠" 키워드 23회 등장 — 미스터비스트 콘텐츠 우선순위에 활용.',
            '',
        ].join('\n');
        const r = extractLearnings(output);
        expect(r.length).toBe(1);
        expect(r[0].content).toContain('쇼츠');
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

describe('dispatch/agent-memory — parseMemoryLine', () => {
    it('critical scope 라인 파싱', () => {
        const e = parseMemoryLine('2026-05-24 🧠 [critical] PayPal live 키 sandbox 와 별도 발급');
        expect(e?.scope).toBe('critical');
        expect(e?.date).toBe('2026-05-24');
        expect(e?.content).toContain('PayPal');
    });

    it('global scope 라인 파싱', () => {
        const e = parseMemoryLine('2026-05-24 🧠 [global] 사장님은 즉시 액션 1개 선호');
        expect(e?.scope).toBe('global');
        expect(e?.project).toBeUndefined();
    });

    it('project scope 라인 — project name 캡쳐', () => {
        const e = parseMemoryLine('2026-05-24 🧠 [project:alpha-agent-ai] 인스타 댓글 쇼츠 23회');
        expect(e?.scope).toBe('project');
        expect(e?.project).toBe('alpha-agent-ai');
        expect(e?.content).toContain('쇼츠');
    });

    it('legacy/malformed 라인은 null', () => {
        expect(parseMemoryLine('- [2026-01-15] 옛 메타 한 줄')).toBeNull();
        expect(parseMemoryLine('일반 텍스트')).toBeNull();
        expect(parseMemoryLine('')).toBeNull();
    });
});

describe('dispatch/agent-memory — buildScopedMemoryBlock', () => {
    const memory = [
        '2026-05-20 🧠 [critical] PayPal live 키 sandbox 와 별도 발급',
        '2026-05-21 🧠 [global] 사장님은 즉시 액션 1개 선호',
        '2026-05-22 🧠 [project:alpha-agent-ai] 인스타 댓글 쇼츠 23회',
        '2026-05-23 🧠 [project:content-bot] 한국어 캡션이 일본어보다 engagement 1.5x',
        '2026-05-24 🧠 [project:alpha-agent-ai] 사전예약 페이지 CTR 8%',
        '- [2026-01-01] legacy 메타 한 줄 (parser 가 무시)',
    ].join('\n');

    it('현재 프로젝트 = alpha-agent-ai → 다른 프로젝트 항목 제외', () => {
        const block = buildScopedMemoryBlock(memory, 'alpha-agent-ai');
        expect(block).toContain('PayPal');                              /* critical 포함 */
        expect(block).toContain('사장님은 즉시 액션');                  /* global 포함 */
        expect(block).toContain('인스타 댓글 쇼츠');                    /* 현재 project 포함 */
        expect(block).toContain('사전예약 페이지 CTR');                 /* 현재 project 포함 */
        expect(block).not.toContain('한국어 캡션');                     /* 다른 project 제외 */
        expect(block).not.toContain('legacy 메타');                     /* malformed 무시 */
    });

    it('섹션 헤더로 scope 구분', () => {
        const block = buildScopedMemoryBlock(memory, 'alpha-agent-ai');
        expect(block).toContain('🔴 [critical');
        expect(block).toContain('📌 [project — 이 프로젝트 (alpha-agent-ai)');
        expect(block).toContain('🌍 [global');
    });

    it('현재 프로젝트 없으면 critical + global 만', () => {
        const block = buildScopedMemoryBlock(memory, undefined);
        expect(block).toContain('PayPal');
        expect(block).toContain('사장님은 즉시 액션');
        expect(block).not.toContain('인스타 댓글 쇼츠');
        expect(block).not.toContain('한국어 캡션');
    });

    it('빈 memory 면 빈 문자열', () => {
        expect(buildScopedMemoryBlock('', 'x')).toBe('');
        expect(buildScopedMemoryBlock('   ', 'x')).toBe('');
    });

    it('각 scope 최신 우선 (append-only 파일이라 끝 라인이 최신)', () => {
        const m = [
            '2026-05-20 🧠 [project:alpha-agent-ai] 첫 학습',
            '2026-05-24 🧠 [project:alpha-agent-ai] 최신 학습',
        ].join('\n');
        const block = buildScopedMemoryBlock(m, 'alpha-agent-ai');
        const firstPos = block.indexOf('첫 학습');
        const newestPos = block.indexOf('최신 학습');
        expect(newestPos).toBeLessThan(firstPos); /* 최신이 위에 */
    });
});
