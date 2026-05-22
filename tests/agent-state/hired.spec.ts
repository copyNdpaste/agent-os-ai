import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    hiredJsonPath,
    readHired,
    isHired,
    markHired,
} from '../../src/agent-state/hired';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'agentstate-hired-'));
}

describe('agent-state/hired', () => {
    let companyDir: string;

    beforeEach(() => {
        companyDir = mkTmp();
    });

    afterEach(() => {
        try { fs.rmSync(companyDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('readHired 는 파일 없으면 빈 객체 반환', () => {
        // Given: 깨끗한 디렉터리 (hired.json 없음)
        // When
        const map = readHired(companyDir);
        // Then
        expect(map).toEqual({});
    });

    it('markHired 는 hiredAt 을 ISO timestamp 로 기록한다', () => {
        // Given: 깨끗한 상태
        const before = Date.now();

        // When
        const ok = markHired(companyDir, 'editor');

        // Then: 파일이 생기고 hiredAt 이 유효한 ISO 문자열
        expect(ok).toBe(true);
        const p = hiredJsonPath(companyDir);
        expect(fs.existsSync(p)).toBe(true);
        const map = readHired(companyDir);
        expect(map.editor).toBeDefined();
        const ts = Date.parse(map.editor.hiredAt);
        expect(Number.isFinite(ts)).toBe(true);
        expect(ts).toBeGreaterThanOrEqual(before);
        /* ISO 8601 형식 검증 — Z 또는 시간대 포함 */
        expect(map.editor.hiredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('markHired 는 같은 id 를 두 번 호출해도 idempotent', () => {
        // Given: 한 번 채용 후
        markHired(companyDir, 'editor');
        const first = readHired(companyDir).editor.hiredAt;

        // When: 같은 id 다시 호출 (1ms 이상 간격을 보장하기 위해 잠시 대기)
        // 동일 ms 에 호출되면 timestamp 가 같을 수 있지만, 호출 자체는 성공해야 함
        const ok = markHired(companyDir, 'editor');

        // Then: 에러 없음, entry 가 정확히 1개로 유지, hiredAt 은 갱신됨(또는 동일)
        expect(ok).toBe(true);
        const map = readHired(companyDir);
        const keys = Object.keys(map);
        expect(keys.length).toBe(1);
        expect(keys[0]).toBe('editor');
        /* hiredAt 은 유효 ISO 이며 첫 호출 이상의 시각 */
        expect(Date.parse(map.editor.hiredAt)).toBeGreaterThanOrEqual(Date.parse(first));
    });

    it('isHired 는 파일에 있으면 true, 없으면 false', () => {
        // Given: 빈 상태에서 editor 는 아직 hired 아님
        expect(isHired(companyDir, 'editor')).toBe(false);

        // When: editor 채용
        markHired(companyDir, 'editor');

        // Then: editor 는 true, 다른 id 는 여전히 false
        expect(isHired(companyDir, 'editor')).toBe(true);
        expect(isHired(companyDir, 'designer')).toBe(false);
    });

    it('markHired 는 사이드 이펙트로 active.json 에 setActive(true) 를 호출한다', () => {
        // Given: 깨끗한 상태
        const activePath = path.join(companyDir, '_shared', 'active.json');
        expect(fs.existsSync(activePath)).toBe(false);

        // When: PIN 통과 → 채용
        const ok = markHired(companyDir, 'editor');

        // Then: active.json 도 함께 만들어지고 editor entry 가 있다
        expect(ok).toBe(true);
        expect(fs.existsSync(activePath)).toBe(true);
        const active = JSON.parse(fs.readFileSync(activePath, 'utf8'));
        expect(active.editor).toBeDefined();
        expect(active.editor.activatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
});
