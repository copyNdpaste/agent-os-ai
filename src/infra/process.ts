/**
 * 서브프로세스 실행 + 포트 점유 정리.
 *
 * extension.ts 에서 분리됨.
 */
import { spawn, spawnSync } from 'child_process';

/**
 * Run a shell command and capture stdout+stderr live so the AI can act on the result.
 * - Streams output to onChunk for live display in the chat
 * - Returns combined output (capped to 15KB) + exit code
 * - Hard timeout to prevent hung processes
 * - Uses default shell ($SHELL or sh) for natural command parsing
 */
export function runCommandCaptured(
    cmd: string,
    cwd: string,
    onChunk: (text: string) => void,
    timeoutMs = 60000,
    captureStream: 'both' | 'stdout' = 'both'
): Promise<{ exitCode: number; output: string; timedOut: boolean }> {
    return new Promise((resolve) => {
        const child = spawn(cmd, {
            cwd,
            shell: true,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let buf = '';
        let timedOut = false;
        const append = (s: string) => {
            buf += s;
            if (buf.length > 30000) buf = buf.slice(-30000);
            onChunk(s);
        };
        child.stdout?.on('data', (d: Buffer) => append(d.toString()));
        if (captureStream === 'both') {
            child.stderr?.on('data', (d: Buffer) => append(d.toString()));
        }
        const killTimer = setTimeout(() => {
            timedOut = true;
            if (process.platform === 'win32' && child.pid) {
                try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).unref(); }
                catch { try { child.kill(); } catch { /* gone */ } }
            } else {
                try { child.kill('SIGTERM'); } catch { /* already dead */ }
                setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 2000);
            }
        }, timeoutMs);
        child.on('close', (code) => {
            clearTimeout(killTimer);
            resolve({ exitCode: code ?? -1, output: buf.slice(-15000), timedOut });
        });
        child.on('error', (e) => {
            clearTimeout(killTimer);
            resolve({ exitCode: -1, output: `[실행 오류] ${e.message}`, timedOut: false });
        });
    });
}

/**
 * 특정 TCP 포트 점유 프로세스 강제 종료 (cross-platform).
 * 본인 PID 는 안 죽임. 종료된 PID 배열 반환.
 */
export function killProcessesOnPort(port: number): number[] {
    const ourPid = process.pid;
    const killed: number[] = [];
    try {
        if (process.platform === 'win32') {
            const r = spawnSync('netstat', ['-ano'], { encoding: 'utf-8', timeout: 5000 });
            const lines = (r.stdout || '').split(/\r?\n/);
            const pidSet = new Set<number>();
            for (const line of lines) {
                if (!/LISTENING/i.test(line)) continue;
                if (!new RegExp(`[:.]${port}\\b`).test(line)) continue;
                const m = line.trim().split(/\s+/);
                const pid = parseInt(m[m.length - 1], 10);
                if (!isNaN(pid) && pid > 0 && pid !== ourPid) pidSet.add(pid);
            }
            for (const pid of pidSet) {
                const k = spawnSync('taskkill', ['/F', '/PID', String(pid)], { encoding: 'utf-8', timeout: 3000 });
                if (k.status === 0) killed.push(pid);
            }
        } else {
            const r = spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf-8', timeout: 5000 });
            const pids = (r.stdout || '')
                .split(/\r?\n/)
                .map(s => parseInt(s.trim(), 10))
                .filter(p => !isNaN(p) && p > 0 && p !== ourPid);
            for (const pid of pids) {
                const k = spawnSync('kill', ['-9', String(pid)], { encoding: 'utf-8', timeout: 3000 });
                if (k.status === 0) killed.push(pid);
            }
        }
    } catch (e) {
        console.error('[Agent OS] killProcessesOnPort 실패:', e);
    }
    return killed;
}
