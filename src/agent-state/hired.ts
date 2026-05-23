/**
 * Agent hire-state persistence (`_shared/hired.json`).
 *
 * extension.ts 에서 분리됨 (god-file Agent-state 모듈화). 채용 잠금
 * 시스템(v2.89.103) — 일부 에이전트(현재: editor=한스짐머)는 PIN 입력으로 채용해야
 * 활성화된다. 채용 통과한 에이전트는 active.json 에도 자동 등록되어 즉시 사용 가능.
 *
 * companyDir 는 외부에서 주입한다. setActive 는 ./active 에서 import 하여 모듈
 * 내부에서 직접 호출 (이전 extension.ts 의 markAgentHired → setAgentActive 호출
 * 사이드 이펙트를 그대로 보존).
 */
import * as fs from 'fs';
import * as path from 'path';
import { setActive } from './active';

export interface HiredEntry {
    hiredAt: string;
}

/** Disk location for the per-company hired-agents map. */
export function hiredJsonPath(companyDir: string): string {
    return path.join(companyDir, '_shared', 'hired.json');
}

/** 채용된 에이전트 맵. 파일이 없거나 손상되면 빈 객체로 안전 fallback. */
export function readHired(companyDir: string): Record<string, HiredEntry> {
    try {
        const p = hiredJsonPath(companyDir);
        if (!fs.existsSync(p)) return {};
        const data = JSON.parse(fs.readFileSync(p, 'utf-8') || '{}');
        return (data && typeof data === 'object') ? data : {};
    } catch { return {}; }
}

/**
 * 특정 id 가 채용 상태인지.
 *
 * 주의: 이 함수는 lockedDefaults 를 알지 못한다 — caller (e.g. active.isActive)
 * 가 lockedDefaults[id] 가 true 인 경우에만 이 함수를 호출해야 한다. 원본
 * `isAgentHired` 의 "잠금 대상이 아니면 항상 채용" 분기는 active.ts 측에서 처리.
 */
export function isHired(companyDir: string, id: string): boolean {
    const map = readHired(companyDir);
    return !!map[id];
}

/**
 * 에이전트를 채용 상태로 마킹. hiredAt 은 ISO timestamp. 사이드 이펙트로
 * setActive(id, true) 를 호출하여 즉시 활성화 — 원본 markAgentHired 동작 그대로.
 *
 * idempotent: 같은 id 를 두 번 호출하면 hiredAt 이 갱신될 뿐 에러 없음.
 */
export function markHired(companyDir: string, id: string): boolean {
    try {
        const dir = path.join(companyDir, '_shared');
        try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
        const f = hiredJsonPath(companyDir);
        let cur: Record<string, any> = {};
        try { cur = JSON.parse(fs.readFileSync(f, 'utf-8') || '{}'); } catch { /* malformed */ }
        cur[id] = { hiredAt: new Date().toISOString() };
        fs.writeFileSync(f, JSON.stringify(cur, null, 2));
        /* PIN 통과한 에이전트는 자동으로 active 등록 */
        setActive(companyDir, id, true);
        return true;
    } catch { return false; }
}
