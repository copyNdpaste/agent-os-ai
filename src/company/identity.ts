/**
 * Company identity — `_shared/identity.md` 의 회사명 파싱.
 *
 * extension.ts 의 _extractCompanyName / isCompanyConfigured / readCompanyName
 * 에서 분리됨. companyDir 를 외부 주입받음.
 *
 * 원본 regex 는 그대로 유지한다 — placeholder/미설정 문구 필터 포함.
 */
import * as path from 'path';
import * as fs from 'fs';
import { safeReadText } from './_fs';

/** identity.md 경로. */
export function identityPath(companyDir: string): string {
    return path.join(companyDir, '_shared', 'identity.md');
}

/** identity.md 본문에서 "회사 이름: ..." 줄을 추출. placeholder/미설정 문구는
 *  빈 문자열로 정규화. 원본 regex 그대로. */
export function extractCompanyNameFromMd(idMd: string): string {
    const m = idMd.match(/회사\s*이름\s*[:：]\s*(.+)/);
    if (!m || !m[1]) return '';
    let v = m[1].trim().replace(/\*+/g, '').replace(/^_+|_+$/g, '').trim();
    if (!v) return '';
    if (/\(여기에|\(아직 미설정|\(미설정|미설정$|^_자가학습/.test(v)) return '';
    return v;
}

/** identity.md 가 존재하고 회사명이 추출되면 true. */
export function isConfigured(companyDir: string): boolean {
    const idPath = identityPath(companyDir);
    if (!fs.existsSync(idPath)) return false;
    return extractCompanyNameFromMd(safeReadText(idPath)).length > 0;
}

/** 회사명을 읽어 반환. 없으면 빈 문자열. */
export function readCompanyName(companyDir: string): string {
    return extractCompanyNameFromMd(safeReadText(identityPath(companyDir)));
}
