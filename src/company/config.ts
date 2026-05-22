/**
 * Company config — identity.md + goals.md 를 한 번에 읽고 쓰는 구조화 reader.
 *
 * extension.ts 의 CompanyConfig / _extractField / _extractGoalLine /
 * readCompanyConfig / writeCompanyConfig 에서 분리됨. companyDir 외부 주입.
 *
 * 원본 regex 와 출력 마크다운 포맷을 그대로 유지한다 — 사용자가 직접 편집해
 * 둔 파일을 깨뜨리지 않기 위해서.
 */
import * as path from 'path';
import * as fs from 'fs';
import { safeReadText } from './_fs';
import { extractCompanyNameFromMd } from './identity';

export interface CompanyConfig {
    name: string;
    oneLiner: string;
    audience: string;       // 누구를 위해 만드나
    tone: string;           // 브랜드 톤
    taboos: string;         // 금기
    goalYear: string;       // 올해 핵심 목표
    goalMonth: string;      // 1개월 단기 목표
    needs: string;          // 지금 가장 필요한 것
}

/** config.md 경로 — 단, 실제로는 identity.md + goals.md 를 분리해 쓰므로
 *  이 함수는 "config 모듈이 다루는 메인 파일" 이라는 의미의 대표 경로. */
export function configPath(companyDir: string): string {
    return path.join(companyDir, '_shared', 'config.md');
}

function _identityMdPath(companyDir: string): string {
    return path.join(companyDir, '_shared', 'identity.md');
}

function _goalsMdPath(companyDir: string): string {
    return path.join(companyDir, '_shared', 'goals.md');
}

/** "- **라벨:** 값" / "라벨: 값" 형식에서 값을 뽑는다. placeholder/미설정 문구는
 *  빈 문자열로 정규화. 원본 regex 그대로. */
export function extractField(md: string, label: string): string {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|\\n)\\s*-?\\s*\\*{0,2}${escaped}\\*{0,2}\\s*[:：]\\s*([^\\n]+)`, 'i');
    const m = md.match(re);
    if (!m || !m[1]) return '';
    let v = m[1].trim().replace(/\*+/g, '').replace(/^_+|_+$/g, '').trim();
    if (!v) return '';
    if (/^\(여기에|^\(아직 미설정|^\(미설정|미설정$|^_자가학습|^아직 미설정|^_/.test(v)) return '';
    return v;
}

/** 주어진 H2 헤더 블록 안의 첫 비어있지 않은 bullet 값을 반환. 원본 regex 그대로. */
export function extractGoalLine(md: string, header: string): string {
    const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`##\\s*${escaped}([\\s\\S]*?)(?:\\n##|$)`);
    const m = md.match(re);
    if (!m) return '';
    const block = m[1];
    const lineRe = /\n\s*-\s*(?:\[\s*[xX ]?\s*\]\s*)?([^\n]+)/g;
    let lm;
    while ((lm = lineRe.exec(block))) {
        let v = (lm[1] || '').trim().replace(/\*+/g, '').replace(/^_+|_+$/g, '').trim();
        if (!v) continue;
        if (/^\(아직 미설정|^_자가학습|미설정$|^_/.test(v)) continue;
        return v;
    }
    return '';
}

/** identity.md + goals.md 를 합쳐 CompanyConfig 형태로 돌려준다.
 *  파일이 없으면 모든 필드 빈 문자열 default. */
export function readConfig(companyDir: string): CompanyConfig {
    const idMd = safeReadText(_identityMdPath(companyDir));
    const goalsMd = safeReadText(_goalsMdPath(companyDir));
    return {
        name: extractCompanyNameFromMd(idMd),
        oneLiner: extractField(idMd, '한 줄 소개'),
        audience: extractField(idMd, '타깃 청중'),
        tone:     extractField(idMd, '브랜드 톤'),
        taboos:   extractField(idMd, '금기'),
        goalYear:  extractGoalLine(goalsMd, '올해 핵심 목표'),
        goalMonth: extractGoalLine(goalsMd, '1개월 내 단기 목표'),
        needs:     extractGoalLine(goalsMd, '지금 가장 필요한 것'),
    };
}

/** partial 업데이트 — 빠진 필드는 현재 값으로 보존한 뒤 identity.md + goals.md
 *  를 다시 쓴다. 원본 텍스트 포맷을 그대로 보존. */
export function writeConfig(companyDir: string, cfg: Partial<CompanyConfig>): void {
    const dir = companyDir;
    const sharedDir = path.join(dir, '_shared');
    try { fs.mkdirSync(sharedDir, { recursive: true }); } catch { /* ignore */ }

    const cur = readConfig(dir);
    const m: CompanyConfig = {
        name:     (cfg.name     ?? cur.name).trim(),
        oneLiner: (cfg.oneLiner ?? cur.oneLiner).trim(),
        audience: (cfg.audience ?? cur.audience).trim(),
        tone:     (cfg.tone     ?? cur.tone).trim(),
        taboos:   (cfg.taboos   ?? cur.taboos).trim(),
        goalYear:  (cfg.goalYear  ?? cur.goalYear).trim(),
        goalMonth: (cfg.goalMonth ?? cur.goalMonth).trim(),
        needs:     (cfg.needs     ?? cur.needs).trim(),
    };
    const fmt = (v: string) => v || '_자가학습이 채울 예정_';
    const idPath = _identityMdPath(dir);
    fs.writeFileSync(idPath,
`# 🏢 회사 정체성

- **회사 이름:** ${m.name || '(아직 미설정)'}
- **한 줄 소개:** ${m.oneLiner || '(아직 미설정)'}
- **타깃 청중:** ${fmt(m.audience)}
- **브랜드 톤:** ${fmt(m.tone)}
- **금기:** ${fmt(m.taboos)}

> 이 파일은 사용자가 직접 편집하거나, 작업하면서 자가학습으로 채워집니다.
> 채팅 사이드바의 "👔 회사명" 뱃지를 누르면 폼으로 수정할 수도 있어요.
`);
    const goalsPath = _goalsMdPath(dir);
    fs.writeFileSync(goalsPath,
`# 🎯 공동 목표

## 올해 핵심 목표
- [ ] ${m.goalYear || '(아직 미설정 — 작업하면서 추가)'}

## 1개월 내 단기 목표
- ${fmt(m.goalMonth)}

## 지금 가장 필요한 것
- ${fmt(m.needs)}

> 모든 에이전트가 매번 이 파일을 읽고 일합니다. 회사 설정 모달에서 폼으로도 수정 가능.
`);
}
