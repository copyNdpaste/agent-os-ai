/**
 * Telegram single-instance leader lock (TTL + heartbeat).
 *
 * extension.ts 에서 분리됨 (god-file Telegram 모듈화). userBrain (e.g.
 * ~/.connect-ai-brain) 은 외부에서 주입한다.
 *
 * Multi-window guard — when the user has VS Code / Cursor open in several
 * windows simultaneously, each extension instance independently polls the
 * same bot, so the user's "안녕" gets answered N times. We elect a single
 * "leader" via a TTL lockfile in the user-level brain dir. The leader refreshes
 * its heartbeat on every successful poll; followers see the fresh heartbeat
 * and skip polling entirely. If the leader dies, its lock goes stale (>15s)
 * and any other window can take over on its next tick.
 */
import * as fs from 'fs';
import * as path from 'path';

export const LOCK_TTL_MS = 15000;

export function lockPath(userBrain: string): string {
    /* v2.89.24 — 유저 레벨로 이동. 이전엔 `_company/_shared/`(워크스페이스 단위)에
       있어서 안티그래비티 창마다 다른 워크스페이스면 락도 따로따로 → 두 창이
       독립적으로 폴링. ~/.connect-ai-brain/ 는 모든 창이 공유하는 단일 위치. */
    try { fs.mkdirSync(userBrain, { recursive: true }); } catch { /* ignore */ }
    return path.join(userBrain, '.telegram_poll.lock');
}

export function tryAcquireLock(userBrain: string): boolean {
    const p = lockPath(userBrain);
    const now = Date.now();
    /* v2.89.4 — 원자적(atomic) 잠금. fs.openSync(path, 'wx')는 파일이 이미 있으면
       실패하므로 두 프로세스가 동시에 호출해도 한 명만 락 잡음. 이전 구현은
       exists() → write() 사이 race window에서 둘 다 락 잡을 수 있었음. */
    try {
        try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch { /* ignore */ }
        /* 1) 락 파일이 이미 있으면 — ours? stale? */
        if (fs.existsSync(p)) {
            try {
                const data = JSON.parse(fs.readFileSync(p, 'utf-8') || '{}');
                if (data.pid === process.pid) {
                    /* 우리가 가진 락 — heartbeat 갱신 */
                    fs.writeFileSync(p, JSON.stringify({ pid: process.pid, heartbeat: now }));
                    return true;
                }
                if (typeof data.heartbeat === 'number' && now - data.heartbeat < LOCK_TTL_MS) {
                    return false; /* 다른 창이 살아있음 */
                }
            } catch { /* 손상된 파일 — 강제 인계 */ }
            /* stale 또는 손상 — 삭제 후 atomic 생성 시도 */
            try { fs.unlinkSync(p); } catch { /* race — already gone */ }
        }
        /* 2) atomic create-exclusive — 둘 이상 동시 시도해도 한 명만 성공 */
        try {
            const fd = fs.openSync(p, 'wx');
            fs.writeSync(fd, JSON.stringify({ pid: process.pid, heartbeat: now }));
            fs.closeSync(fd);
            return true;
        } catch (e: any) {
            if (e?.code === 'EEXIST') {
                /* 같은 순간에 다른 창이 잡았음 — 양보 */
                return false;
            }
            throw e;
        }
    } catch {
        return true; /* fail-open — 락 메커니즘 자체 깨졌으면 차라리 중복 한 번 */
    }
}

export function releaseLockIfOwned(userBrain: string): void {
    const p = lockPath(userBrain);
    try {
        if (!fs.existsSync(p)) return;
        const data = JSON.parse(fs.readFileSync(p, 'utf-8') || '{}');
        if (data.pid === process.pid) fs.unlinkSync(p);
    } catch { /* ignore */ }
}
