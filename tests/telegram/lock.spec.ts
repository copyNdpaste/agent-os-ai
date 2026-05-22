import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LOCK_TTL_MS, lockPath, tryAcquireLock, releaseLockIfOwned } from '../../src/telegram/lock';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-lock-'));
}

describe('telegram/lock', () => {
    let userBrain: string;

    beforeEach(() => {
        userBrain = mkTmp();
    });

    it('첫 호출은 lock 을 획득한다', () => {
        // Given: 깨끗한 디렉터리
        // When
        const ok = tryAcquireLock(userBrain);
        // Then: true + 락 파일 존재 + pid 우리것
        expect(ok).toBe(true);
        const p = lockPath(userBrain);
        expect(fs.existsSync(p)).toBe(true);
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        expect(data.pid).toBe(process.pid);
        expect(typeof data.heartbeat).toBe('number');
    });

    it('다른 PID 의 fresh heartbeat 이 있으면 false 를 반환한다', () => {
        // Given: 다른 PID 로 방금 막 찍은 lock
        const p = lockPath(userBrain);
        fs.writeFileSync(p, JSON.stringify({ pid: process.pid + 99999, heartbeat: Date.now() }));

        // When
        const ok = tryAcquireLock(userBrain);

        // Then: 양보
        expect(ok).toBe(false);
        // 락 파일은 그대로 남아있어야 한다
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        expect(data.pid).toBe(process.pid + 99999);
    });

    it('다른 PID 라도 heartbeat 가 TTL 초과면 lock 을 탈취할 수 있다', () => {
        // Given: 다른 PID, heartbeat 가 TTL 보다 오래된 경우 (stale)
        const p = lockPath(userBrain);
        const stale = Date.now() - LOCK_TTL_MS - 5000;
        fs.writeFileSync(p, JSON.stringify({ pid: process.pid + 99999, heartbeat: stale }));

        // When
        const ok = tryAcquireLock(userBrain);

        // Then: 탈취 성공 + 락 파일 pid 가 우리것으로 갱신
        expect(ok).toBe(true);
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        expect(data.pid).toBe(process.pid);
    });

    it('releaseLockIfOwned 는 자기 소유 lock 만 삭제한다 (다른 PID lock 은 유지)', () => {
        // Given: 다른 PID 가 잡은 락
        const p = lockPath(userBrain);
        fs.writeFileSync(p, JSON.stringify({ pid: process.pid + 99999, heartbeat: Date.now() }));

        // When: release 시도
        releaseLockIfOwned(userBrain);

        // Then: 락 파일이 그대로 살아있어야 함
        expect(fs.existsSync(p)).toBe(true);
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        expect(data.pid).toBe(process.pid + 99999);

        // And: 우리가 잡은 락은 release 가 지운다
        fs.writeFileSync(p, JSON.stringify({ pid: process.pid, heartbeat: Date.now() }));
        releaseLockIfOwned(userBrain);
        expect(fs.existsSync(p)).toBe(false);
    });
});
