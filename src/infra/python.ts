/**
 * Python 3 명령 자동 감지 + missing 안내.
 *
 * extension.ts 에서 분리됨. VS Code config 의존 (사용자 override).
 */
import * as vscode from 'vscode';
import { spawnSync } from 'child_process';

let _pythonCmdCache: string | null = null;

/**
 * Python 3 명령 감지:
 *   1) agentOs.pythonPath override
 *   2) 플랫폼별 후보 순차 시도 (which/where 확인)
 *   3) fallback (`python3` / `python`)
 */
export function detectPythonCmd(): string {
    try {
        const cfg = vscode.workspace.getConfiguration('agentOs');
        const override = (cfg.get<string>('pythonPath') || '').trim();
        if (override) {
            try {
                const r = spawnSync(override, ['--version'], { encoding: 'utf-8', timeout: 4000 });
                if (r.status === 0 || /python\s/i.test((r.stdout || '') + (r.stderr || ''))) {
                    return override;
                }
            } catch { /* fall through */ }
        }
    } catch { /* config 못 읽어도 진행 */ }

    const candidates = process.platform === 'win32'
        ? ['py -3', 'python3', 'python', 'py']
        : ['python3', 'python', '/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3'];
    for (const cand of candidates) {
        try {
            const parts = cand.split(' ');
            const r = spawnSync(parts[0], parts.slice(1).concat(['--version']), {
                encoding: 'utf-8', timeout: 4000
            });
            const out = (r.stdout || '') + (r.stderr || '');
            if (r.status === 0 && /python\s+3/i.test(out)) return cand;
            if (/python\s+3\.\d/i.test(out)) return cand;
        } catch { /* 다음 후보 */ }
    }
    return process.platform === 'win32' ? 'python' : 'python3';
}

export function pythonCmd(): string {
    if (_pythonCmdCache) return _pythonCmdCache;
    _pythonCmdCache = detectPythonCmd();
    return _pythonCmdCache;
}

/** 사용자가 설정 변경하면 다음 호출 시 재감지. */
export function invalidatePythonCmdCache(): void {
    _pythonCmdCache = null;
}

/** 9009 / "Python was not found" / ENOENT 류를 감지. */
export function isPythonMissing(exitCode: number, output: string): boolean {
    if (exitCode === 9009) return true;
    if (/Python was not found/i.test(output)) return true;
    if (/command not found.*python/i.test(output)) return true;
    if (/No such file or directory.*python/i.test(output)) return true;
    if (/ENOENT/i.test(output) && /python/i.test(output)) return true;
    return false;
}

export function pythonMissingHint(): string {
    const detected = pythonCmd();
    const platformHint = process.platform === 'win32'
        ? 'https://www.python.org/downloads/ 에서 Python 3 설치 (Add Python to PATH 체크박스 필수!)'
        : (process.platform === 'darwin' ? '`brew install python3`' : '`sudo apt install python3`');
    return `⚠️ Python 3 명령 실행 실패 (시도한 명령: \`${detected}\`).\n` +
           `🔧 해결:\n` +
           `  1. ${platformHint}\n` +
           `  2. 설치 후 안티그래비티/VS Code 완전 종료 → 재실행 (PATH 새로고침 필요)\n` +
           `  3. 또는 명령 팔레트 → "⚙️ 설정 열기" → \`agentOs.pythonPath\` 에 절대 경로 입력 (예: \`/usr/local/bin/python3\` 또는 \`C:\\\\Python311\\\\python.exe\`)\n` +
           `🔍 본인 PC 의 Python 경로 확인:\n` +
           (process.platform === 'win32' ? '  - PowerShell: \`Get-Command python, python3, py\`' : '  - 터미널: \`which python3 python py\`');
}
