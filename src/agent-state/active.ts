/**
 * Agent active-state persistence (`_shared/active.json`).
 *
 * extension.ts 에서 분리됨 (god-file Agent-state 모듈화). companyDir 와
 * lockedDefaults 는 외부에서 주입한다 — 모듈은 vscode·전역 설정에 의존하지 않음.
 *
 * 활성/비활성 토글 시스템(v2.89.107~v2.89.156) 의 디스크 저장 로직. 신규 사용자
 * 시드(_migrated_v2)와 OPTIONAL 자동 활성화(_migrated_v3) 마이그레이션 분기를
 * 그대로 보존한다 — 기존 사용자 active.json 호환을 위해 절대 단순화 금지.
 */
import * as fs from 'fs';
import * as path from 'path';
import { readHired } from './hired';

export interface ActiveEntry {
    activatedAt: string;
    seeded?: boolean;
    seeded_v3?: boolean;
}

/** Disk location for the per-company active-agents map. */
export function activeJsonPath(companyDir: string): string {
    return path.join(companyDir, '_shared', 'active.json');
}

/** Seed lists carried over from extension.ts. Kept as module constants because
 *  they describe extension.ts migration semantics — moving them would silently
 *  change behaviour for existing users on first read after upgrade. */
const DEFAULT_ON_AGENTS: readonly string[] = [
    'secretary', 'writer', 'designer', 'instagram', 'business', 'developer', 'researcher'
];
const OPTIONAL_AGENTS_DEFAULT: readonly string[] = [
    'secretary', 'writer', 'designer', 'instagram', 'business', 'developer', 'researcher'
];

/**
 * 활성 에이전트 맵을 읽는다. 파일이 없으면 마이그레이션 단계별로 시드를 만들어
 * 디스크에 적고 반환한다.
 *
 * - 기존 사용자(hired.json 에 entry 있음) → _migrated:true + OPTIONAL 전체 활성화
 * - 신규 사용자 → _migrated_v2:true + DEFAULT_ON 4명 활성화 (seeded:true)
 * - 기존 _migrated:true 만 있는 사용자 → secretary/writer/designer carry-over
 * - _migrated_v3 미설치 → OPTIONAL 전체 활성화 (seeded_v3:true)
 */
export function readActive(companyDir: string): Record<string, ActiveEntry> {
    try {
        const p = activeJsonPath(companyDir);
        if (!fs.existsSync(p)) {
            /* 첫 실행 + hired.json 에 entry 있으면 기존 사용자로 간주 */
            const hired = readHired(companyDir);
            const isExistingUser = Object.keys(hired).filter(k => !k.startsWith('_')).length > 0;
            if (isExistingUser) {
                const seed: Record<string, any> = { _migrated: true };
                for (const id of OPTIONAL_AGENTS_DEFAULT) {
                    seed[id] = { activatedAt: new Date().toISOString() };
                }
                try {
                    const dir = path.join(companyDir, '_shared');
                    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
                    fs.writeFileSync(p, JSON.stringify(seed, null, 2));
                } catch { /* readonly fs */ }
                return seed;
            }
            /* 신규 사용자: DEFAULT_ON 4명을 시드로 활성화 */
            const seed: Record<string, any> = { _migrated: true, _migrated_v2: true };
            for (const id of DEFAULT_ON_AGENTS) {
                seed[id] = { activatedAt: new Date().toISOString(), seeded: true };
            }
            try {
                const dir = path.join(companyDir, '_shared');
                try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
                fs.writeFileSync(p, JSON.stringify(seed, null, 2));
            } catch { /* readonly fs */ }
            return seed;
        }
        const data = JSON.parse(fs.readFileSync(p, 'utf-8') || '{}');
        if (!data || typeof data !== 'object') return {};
        /* v2.89.109 carry-over: secretary/writer/designer 자동 활성화 */
        if (data._migrated && !data._migrated_v2) {
            const carryOver = ['secretary', 'writer', 'designer'];
            let touched = false;
            for (const id of carryOver) {
                if (!data[id]) {
                    data[id] = { activatedAt: new Date().toISOString() };
                    touched = true;
                }
            }
            data._migrated_v2 = true;
            if (touched) {
                try { fs.writeFileSync(p, JSON.stringify(data, null, 2)); } catch { /* ignore */ }
            }
        }
        /* v2.89.156: OPTIONAL 전체 자동 활성화 (seeded_v3 표시) */
        if (data._migrated && !data._migrated_v3) {
            let touched = false;
            for (const id of OPTIONAL_AGENTS_DEFAULT) {
                if (!data[id]) {
                    data[id] = { activatedAt: new Date().toISOString(), seeded_v3: true };
                    touched = true;
                }
            }
            data._migrated_v3 = true;
            if (touched) {
                try { fs.writeFileSync(p, JSON.stringify(data, null, 2)); } catch { /* ignore */ }
            } else {
                try { fs.writeFileSync(p, JSON.stringify(data, null, 2)); } catch { /* ignore */ }
            }
        }
        return data;
    } catch { return {}; }
}

/**
 * 에이전트가 현재 사용 가능한지.
 * - lockedDefaults[id] === true 인 id 는 hired.json 기준 (PIN 통과 여부)
 * - 그 외 (OPTIONAL/DEFAULT) 는 active.json 에 entry 있으면 true
 *
 * lockedDefaults 는 caller 가 주입한다 — 모듈은 LOCKED_AGENTS_DEFAULT 같은
 * 글로벌 상수에 직접 의존하지 않는다.
 */
export function isActive(
    companyDir: string,
    id: string,
    lockedDefaults: Record<string, boolean>
): boolean {
    if (lockedDefaults[id]) {
        /* LOCKED: hired.json 에 entry 있으면 true */
        const hired = readHired(companyDir);
        return !!hired[id];
    }
    const map = readActive(companyDir);
    return !!map[id];
}

/** active=true → 엔트리 작성, false → 삭제. _migrated 플래그는 보존. */
export function setActive(companyDir: string, id: string, active: boolean): boolean {
    try {
        const dir = path.join(companyDir, '_shared');
        try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
        const f = activeJsonPath(companyDir);
        let cur: Record<string, any> = {};
        try { cur = JSON.parse(fs.readFileSync(f, 'utf-8') || '{}'); } catch { /* malformed */ }
        if (active) {
            cur[id] = { activatedAt: new Date().toISOString() };
        } else {
            delete cur[id];
        }
        cur._migrated = true;
        fs.writeFileSync(f, JSON.stringify(cur, null, 2));
        return true;
    } catch { return false; }
}

/** UI 에서 토글 가능한지 여부. LOCKED 는 토글 가능(PIN 입력해서 해제), ALWAYS_ON
 *  도메인 에이전트는 caller 측에서 별도 처리. 여기서는 lockedDefaults 와 동일한
 *  의미를 따른다 — 단순히 OPTIONAL/LOCKED 인지만 본다. */
export function isTogglable(
    companyDir: string,
    id: string,
    lockedDefaults: Record<string, boolean>,
    optionalAgents: ReadonlySet<string> = new Set(OPTIONAL_AGENTS_DEFAULT)
): boolean {
    return optionalAgents.has(id) || !!lockedDefaults[id];
}
