/**
 * python.ts 의 pure 부분만 테스트. detectPythonCmd / pythonCmd 는 VS Code 의존이라
 * 통합 테스트에서 다룸.
 *
 * NOTE: vitest 에서 vscode 모듈을 import 할 수 없어서 isPythonMissing 만 따로 검증한다.
 * 함수는 pure 라서 import 만 통하면 충분.
 */
import { describe, it, expect, vi } from 'vitest';

// vscode 모듈 mock — pure 함수만 쓰지만 python.ts 가 import 하므로 필요
vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({ get: () => '' }),
    },
}));

const { isPythonMissing } = await import('../../src/infra/python');

describe('isPythonMissing', () => {
    it('exitCode 9009 (Windows command-not-found) → true', () => {
        expect(isPythonMissing(9009, '')).toBe(true);
    });

    it('"Python was not found" 스텁 메시지 → true', () => {
        expect(isPythonMissing(1, 'Python was not found; run without arguments')).toBe(true);
    });

    it('"command not found: python3" → true', () => {
        expect(isPythonMissing(127, 'zsh: command not found: python3')).toBe(true);
    });

    it('"No such file or directory" + python 언급 → true', () => {
        expect(isPythonMissing(127, '/bin/sh: No such file or directory: python3')).toBe(true);
    });

    it('ENOENT + python 언급 → true', () => {
        expect(isPythonMissing(-1, 'spawn python3 ENOENT')).toBe(true);
    });

    it('일반 실패 (exit 1 + python 미언급) → false', () => {
        expect(isPythonMissing(1, 'SyntaxError: invalid syntax')).toBe(false);
    });

    it('exit 0 + 정상 출력 → false', () => {
        expect(isPythonMissing(0, 'Python 3.14.4')).toBe(false);
    });
});
