import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    AUTONOMY_DEFAULT,
    AUTONOMY_MIN,
    AUTONOMY_MAX,
    readAutonomyLevel,
} from '../../src/agent-state/autonomy';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'agentstate-autonomy-'));
}

function writeTools(companyDir: string, agentId: string, body: string): void {
    const p = path.join(companyDir, '_agents', agentId, 'tools.md');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
}

describe('agent-state/autonomy', () => {
    let companyDir: string;

    beforeEach(() => {
        companyDir = mkTmp();
    });

    afterEach(() => {
        try { fs.rmSync(companyDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('파일 없으면 기본값(AUTONOMY_DEFAULT=2) 반환', () => {
        // Given: tools.md 가 존재하지 않는 신규 에이전트
        // When
        const lvl = readAutonomyLevel(companyDir, 'ceo');
        // Then: 기본값 2 (Draft → Approve)
        expect(lvl).toBe(AUTONOMY_DEFAULT);
        expect(lvl).toBe(2);
    });

    it('AUTONOMY_LEVEL 라인이 있으면 그 값을 반환 (0~3 범위)', () => {
        writeTools(companyDir, 'secretary', '# Tools\n\nAUTONOMY_LEVEL: 3\n');
        expect(readAutonomyLevel(companyDir, 'secretary')).toBe(3);

        writeTools(companyDir, 'secretary', 'AUTONOMY_LEVEL: 0\n');
        expect(readAutonomyLevel(companyDir, 'secretary')).toBe(0);

        writeTools(companyDir, 'secretary', 'AUTONOMY_LEVEL = 1\n');
        expect(readAutonomyLevel(companyDir, 'secretary')).toBe(1);
    });

    it('AUTONOMY_LEVEL 값이 범위 밖이어도 clamp 된다', () => {
        // Note: 정규식이 \d 단일 자리만 매칭하므로 9 같은 한 자리 큰 값을 사용.
        // 정규식은 한 자리만 잡지만 클램프 로직은 0~3 으로 제한해야 함.
        writeTools(companyDir, 'designer', 'AUTONOMY_LEVEL: 9');
        const high = readAutonomyLevel(companyDir, 'designer');
        expect(high).toBeLessThanOrEqual(AUTONOMY_MAX);
        expect(high).toBeGreaterThanOrEqual(AUTONOMY_MIN);
        expect(high).toBe(AUTONOMY_MAX); // 9 → 3

        // 음수는 정규식이 `[:=]\s*(\d)` 라 `-` 가 \d 매칭에 실패 → 매칭 자체가 안 됨 → default fallback.
        // (원본 정규식 동작 그대로 보존)
        writeTools(companyDir, 'designer', 'AUTONOMY_LEVEL: -1');
        expect(readAutonomyLevel(companyDir, 'designer')).toBe(AUTONOMY_DEFAULT);
    });

    it('비숫자/포맷 깨진 파일은 default fallback', () => {
        // AUTONOMY_LEVEL 라인이 없으면 default
        writeTools(companyDir, 'writer', '# tools.md\n\n자유 텍스트, 키워드 없음.');
        expect(readAutonomyLevel(companyDir, 'writer')).toBe(AUTONOMY_DEFAULT);

        // AUTONOMY_LEVEL 키워드는 있지만 값이 비숫자
        writeTools(companyDir, 'writer', 'AUTONOMY_LEVEL: abc');
        expect(readAutonomyLevel(companyDir, 'writer')).toBe(AUTONOMY_DEFAULT);

        // 빈 파일
        writeTools(companyDir, 'writer', '');
        expect(readAutonomyLevel(companyDir, 'writer')).toBe(AUTONOMY_DEFAULT);
    });
});
