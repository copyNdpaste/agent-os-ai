/**
 * company/identity — extractCompanyNameFromMd / readCompanyName / isConfigured BDD.
 *
 * 원본 extension.ts 의 _extractCompanyName regex 를 그대로 옮겨왔는지 검증.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    extractCompanyNameFromMd,
    readCompanyName,
    isConfigured,
    identityPath,
} from '../../src/company/identity';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'company-identity-'));
}

function writeIdentity(companyDir: string, content: string): void {
    const p = identityPath(companyDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
}

describe('company/identity', () => {
    let tmp: string;
    beforeEach(() => { tmp = mkTmp(); });
    afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('extractCompanyNameFromMd 는 "회사 이름: ..." 형식에서 값을 추출한다', () => {
        // Given: 원본 markdown 헤더 + 회사 이름 줄
        const md = [
            '# 🏢 회사 정체성',
            '',
            '- **회사 이름:** 아인슈타인랩',
            '- **한 줄 소개:** AI 1인 기업 운영체제',
        ].join('\n');
        // When
        const name = extractCompanyNameFromMd(md);
        // Then: 별표/공백 제거된 회사명
        expect(name).toBe('아인슈타인랩');
    });

    it('extractCompanyNameFromMd 는 형식이 안 맞으면 빈 문자열을 돌려준다', () => {
        // Given: 회사 이름 줄이 없는 텍스트
        const md = '아무 markdown 도 회사 이름 라벨이 없으면\n그냥 빈 결과';
        // When
        const name = extractCompanyNameFromMd(md);
        // Then
        expect(name).toBe('');
    });

    it('extractCompanyNameFromMd 는 placeholder "(아직 미설정)" 같은 값을 빈 문자열로 정규화한다', () => {
        // Given: 사용자가 아직 안 채운 상태
        const md = '- **회사 이름:** (아직 미설정)';
        // When
        const name = extractCompanyNameFromMd(md);
        // Then: 원본 regex 가 placeholder 를 걸러야 한다
        expect(name).toBe('');
    });

    it('readCompanyName 는 identity.md 가 없으면 빈 문자열을 돌려준다', () => {
        // Given: 빈 디렉터리
        // When
        const name = readCompanyName(tmp);
        // Then
        expect(name).toBe('');
    });

    it('isConfigured 는 identity.md 가 있고 회사명이 추출되면 true 를 돌려준다', () => {
        // Given: 회사명이 들어간 identity.md
        writeIdentity(tmp, '- **회사 이름:** 헐크네 가게');
        // When
        // Then
        expect(isConfigured(tmp)).toBe(true);
        expect(readCompanyName(tmp)).toBe('헐크네 가게');
    });

    it('isConfigured 는 placeholder 만 있는 경우 false 를 돌려준다', () => {
        // Given: 파일은 있는데 회사명이 placeholder
        writeIdentity(tmp, '- **회사 이름:** (아직 미설정)');
        // When
        // Then: regex 가 placeholder 를 걸러야 함 → false
        expect(isConfigured(tmp)).toBe(false);
    });
});
