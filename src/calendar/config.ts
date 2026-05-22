/**
 * Calendar config reader / writer.
 *
 * extension.ts 에서 분리됨. companyDir 를 인자로 받아 테스트 가능하게 만듦
 * (원본은 getCompanyDir() 글로벌 호출).
 *
 * Canonical 파일: `<companyDir>/_agents/secretary/tools/google_calendar_write.json`
 * — UI 의 ⚙️ tool config 모달에서 생성/편집. Secretary 가 OAuth 자격을 소유.
 *
 * writeConfig 는 merge — 기존 필드 (e.g. _CONNECTED_AS, CALENDAR_ID) 를 보존.
 * 모든 함수는 디스크 에러를 삼키고 안전 기본값 ({}, false) 을 반환 — 원본 동작.
 */
import * as path from 'path';
import * as fs from 'fs';
import type { CalendarWriteConfig } from './types';

export function configPath(companyDir: string): string {
    return path.join(companyDir, '_agents', 'secretary', 'tools', 'google_calendar_write.json');
}

/** 파일 없으면 빈 객체 ({}) 반환. 깨진 JSON 도 {} 로 fallback. */
export function readConfig(companyDir: string): CalendarWriteConfig {
    try {
        const p = configPath(companyDir);
        if (!fs.existsSync(p)) return {};
        return JSON.parse(fs.readFileSync(p, 'utf-8') || '{}');
    } catch {
        return {};
    }
}

/** Merge write — 기존 필드 위에 cfg 의 필드만 덮어쓴다. */
export function writeConfig(companyDir: string, cfg: CalendarWriteConfig): void {
    const p = configPath(companyDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const cur = readConfig(companyDir);
    fs.writeFileSync(p, JSON.stringify({ ...cur, ...cfg }, null, 2));
}

/** CLIENT_ID + CLIENT_SECRET + REFRESH_TOKEN 셋 다 있어야 "연결됨". */
export function isConnected(companyDir: string): boolean {
    const c = readConfig(companyDir);
    return !!(c.CLIENT_ID && c.CLIENT_SECRET && c.REFRESH_TOKEN);
}
