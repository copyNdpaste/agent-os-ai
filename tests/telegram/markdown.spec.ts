import { describe, it, expect } from 'vitest';
import { markdownToTelegram } from '../../src/telegram/markdown';

describe('markdownToTelegram', () => {
    it('코드블록(```)을 보존한다', () => {
        // Given: fenced code block — Telegram 도 ``` 을 그대로 받아들임
        const src = '```\nconst x = 1;\n```';
        // When
        const out = markdownToTelegram(src);
        // Then: fence 가 그대로 살아있어야 한다
        expect(out).toContain('```');
        expect(out).toContain('const x = 1;');
    });

    it('## / ### 헤더를 *bold* 로 변환한다', () => {
        // Given: 표준 마크다운 헤더
        const src = '## 큰 제목\n### 중간 제목';
        // When
        const out = markdownToTelegram(src);
        // Then: ## 은 ━━ 장식과 함께, ### 은 *bold* 로
        expect(out).toMatch(/\*━━ 큰 제목 ━━\*/);
        expect(out).toMatch(/\*중간 제목\*/);
        // 원본 # 기호는 사라져야 한다
        expect(out).not.toMatch(/^##\s/m);
        expect(out).not.toMatch(/^###\s/m);
    });

    it('`-` 리스트는 통과시킨다 (Telegram 이 그대로 렌더)', () => {
        // Given: dash 리스트 — 원본 구현은 dash 를 별도 변환하지 않고 통과
        const src = '- apple\n- banana';
        // When
        const out = markdownToTelegram(src);
        // Then: 줄이 그대로 살아있고 내용 보존
        expect(out).toContain('- apple');
        expect(out).toContain('- banana');
    });

    it('**bold** 이중 별표는 그대로 유지된다 (Telegram 이 *bold* 로 인식)', () => {
        // Given: GFM 스타일 ** **
        const src = '**강조**';
        // When
        const out = markdownToTelegram(src);
        // Then: 함수는 **를 변환하지 않음 — Telegram 클라이언트가 직접 처리
        expect(out).toBe('**강조**');
    });

    it('빈 입력이면 빈 문자열을 반환한다', () => {
        // Given: 다양한 빈 케이스
        // When/Then
        expect(markdownToTelegram('')).toBe('');
        expect(markdownToTelegram('   \n\n  ')).toBe('');
        expect(markdownToTelegram(undefined as unknown as string)).toBe('');
    });

    it('표(table)의 separator 행은 제거하고 데이터 행은 • · 로 변환한다', () => {
        // Given: GFM 표
        const src = '| 이름 | 값 |\n|---|---|\n| a | 1 |\n| b | 2 |';
        // When
        const out = markdownToTelegram(src);
        // Then: 헤더·데이터 행은 • a · 1 같은 단일 라인으로
        expect(out).toMatch(/• 이름 · 값/);
        expect(out).toMatch(/• a · 1/);
        expect(out).toMatch(/• b · 2/);
        // separator 행은 사라졌어야 함
        expect(out).not.toMatch(/---/);
    });

    it('연속된 빈 줄(3개+)은 2개로 압축된다', () => {
        // Given: 줄바꿈이 과도하게 많은 입력
        const src = 'a\n\n\n\n\nb';
        // When
        const out = markdownToTelegram(src);
        // Then: \n\n 으로 압축
        expect(out).toBe('a\n\nb');
    });
});
