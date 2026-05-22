import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    activeJsonPath,
    readActive,
    isActive,
    setActive,
    isTogglable,
} from '../../src/agent-state/active';
import { hiredJsonPath, markHired } from '../../src/agent-state/hired';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'agentstate-active-'));
}

/* extension.ts 의 LOCKED_AGENTS_DEFAULT 상수와 동일한 의미 — caller 가 주입한다.
   원본은 editor 만 LOCKED. */
const LOCKED_FIXTURE: Record<string, boolean> = { editor: true };

const DEFAULT_ON_FIXTURE = ['secretary', 'writer', 'designer', 'instagram', 'business', 'developer', 'researcher'];

describe('agent-state/active', () => {
    let companyDir: string;

    beforeEach(() => {
        companyDir = mkTmp();
    });

    afterEach(() => {
        try { fs.rmSync(companyDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('readActive 는 파일 없으면 신규 사용자 시드(_migrated_v2 + DEFAULT_ON 7명)로 초기화한다', () => {
        // Given: 깨끗한 디렉터리, hired.json 도 없음 → 신규 사용자
        expect(fs.existsSync(activeJsonPath(companyDir))).toBe(false);

        // When
        const map = readActive(companyDir);

        // Then: _migrated + _migrated_v2 + DEFAULT_ON 전체가 시드됨
        expect(map._migrated).toBe(true);
        expect((map as any)._migrated_v2).toBe(true);
        for (const id of DEFAULT_ON_FIXTURE) {
            expect(map[id]).toBeDefined();
            expect((map[id] as any).seeded).toBe(true);
        }
        // 디스크에 실제로 기록됨
        expect(fs.existsSync(activeJsonPath(companyDir))).toBe(true);
    });

    it('readActive 는 기존 사용자(hired entry 있음) 면 OPTIONAL 전체 자동 활성화', () => {
        // Given: hired.json 에 editor entry → 기존 사용자로 간주
        const hiredDir = path.dirname(hiredJsonPath(companyDir));
        fs.mkdirSync(hiredDir, { recursive: true });
        fs.writeFileSync(hiredJsonPath(companyDir), JSON.stringify({
            editor: { hiredAt: new Date().toISOString() }
        }));

        // When
        const map = readActive(companyDir);

        // Then: OPTIONAL 7명 모두 활성화 (seeded 플래그 없음 — _migrated 만 true)
        expect(map._migrated).toBe(true);
        for (const id of DEFAULT_ON_FIXTURE) {
            expect(map[id]).toBeDefined();
            expect(map[id].activatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        }
    });

    it('readActive 는 손상된 JSON 일 때 안전하게 빈 객체로 fallback', () => {
        // Given: active.json 이 깨진 JSON
        const p = activeJsonPath(companyDir);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, '{not valid json}}}');

        // When
        const map = readActive(companyDir);

        // Then: 빈 객체 (throw 안 함)
        expect(map).toEqual({});
    });

    it('setActive(false) 는 항목을 삭제한다 (원본 동작 그대로)', () => {
        // Given: secretary 가 시드로 활성화돼있음
        readActive(companyDir);
        expect(readActive(companyDir).secretary).toBeDefined();

        // When: 비활성화
        const ok = setActive(companyDir, 'secretary', false);

        // Then: secretary entry 가 삭제되어 있다 (false 마킹이 아니라 delete)
        expect(ok).toBe(true);
        const map = readActive(companyDir);
        expect(map.secretary).toBeUndefined();
        // _migrated 플래그는 유지
        expect(map._migrated).toBe(true);
    });

    it('isActive 는 lockedDefaults[id]=true 면 hired.json 기준으로만 판단', () => {
        // Given: editor 는 LOCKED. hired.json 에 entry 없음 → false
        expect(isActive(companyDir, 'editor', LOCKED_FIXTURE)).toBe(false);

        // When: editor 채용
        markHired(companyDir, 'editor');

        // Then: 이제 isActive 가 true
        expect(isActive(companyDir, 'editor', LOCKED_FIXTURE)).toBe(true);
    });

    it('isActive 는 LOCKED 가 아닌 id 는 active.json entry 기준', () => {
        // Given: 신규 사용자 시드 (DEFAULT_ON 활성화)
        readActive(companyDir);

        // Then: secretary 는 active 상태
        expect(isActive(companyDir, 'secretary', LOCKED_FIXTURE)).toBe(true);

        // When: 비활성화
        setActive(companyDir, 'secretary', false);

        // Then: 이제 false
        expect(isActive(companyDir, 'secretary', LOCKED_FIXTURE)).toBe(false);
    });

    it('isTogglable: OPTIONAL 또는 LOCKED 인 id 만 true', () => {
        // Given: 기본 OPTIONAL 집합 사용 (active 모듈 내부 default)
        // LOCKED id 는 togglable=true (UI 에서 PIN 입력 받기 위해 토글 가능해야 함)
        expect(isTogglable(companyDir, 'editor', LOCKED_FIXTURE)).toBe(true);
        // OPTIONAL id 는 togglable=true
        expect(isTogglable(companyDir, 'secretary', LOCKED_FIXTURE)).toBe(true);
        // ALWAYS_ON (ceo) — LOCKED 도 아니고 OPTIONAL 도 아니라면 togglable=false
        expect(isTogglable(companyDir, 'ceo', LOCKED_FIXTURE)).toBe(false);
    });
});
