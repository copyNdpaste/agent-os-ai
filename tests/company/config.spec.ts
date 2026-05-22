/**
 * company/config — extractField / extractGoalLine / readConfig / writeConfig BDD.
 *
 * 원본 extension.ts 의 regex / 파일 구조 (identity.md + goals.md) 를 그대로
 * 유지하는지 검증.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    extractField,
    extractGoalLine,
    readConfig,
    writeConfig,
} from '../../src/company/config';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'company-config-'));
}

function writeShared(companyDir: string, file: 'identity.md' | 'goals.md', content: string): void {
    const dir = path.join(companyDir, '_shared');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), content, 'utf8');
}

describe('company/config', () => {
    let tmp: string;
    beforeEach(() => { tmp = mkTmp(); });
    afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('extractField 는 "- **라벨:** 값" 형식에서 값을 추출한다 (원본 regex 그대로)', () => {
        // Given: bullet + 강조표시된 라벨
        const md = '- **한 줄 소개:** AI 가 굴리는 회사';
        // When
        const v = extractField(md, '한 줄 소개');
        // Then: 별표 제거된 값
        expect(v).toBe('AI 가 굴리는 회사');
    });

    it('extractField 는 "라벨: 값" plain 형식과 전각 콜론도 처리한다', () => {
        // Given: 강조 없이 plain, 전각 콜론
        const md = '브랜드 톤： 단단하고 친근함';
        // When
        const v = extractField(md, '브랜드 톤');
        // Then
        expect(v).toBe('단단하고 친근함');
    });

    it('extractField 는 placeholder/미설정 문구를 빈 문자열로 정규화한다', () => {
        // Given: 원본 regex 가 걸러내야 할 패턴들
        const md = [
            '- **타깃 청중:** (아직 미설정)',
            '- **금기:** _자가학습이 채울 예정_',
        ].join('\n');
        // When
        // Then
        expect(extractField(md, '타깃 청중')).toBe('');
        expect(extractField(md, '금기')).toBe('');
    });

    it('extractGoalLine 은 헤더 다음 줄의 첫 비어있지 않은 bullet 을 추출한다', () => {
        // Given: 표준 goals.md 포맷 (체크박스 포함)
        const goals = [
            '# 🎯 공동 목표',
            '',
            '## 올해 핵심 목표',
            '- [ ] 유튜브 구독자 1만',
            '',
            '## 1개월 내 단기 목표',
            '- 영상 4편 업로드',
        ].join('\n');
        // When
        const yearly = extractGoalLine(goals, '올해 핵심 목표');
        const monthly = extractGoalLine(goals, '1개월 내 단기 목표');
        // Then
        expect(yearly).toBe('유튜브 구독자 1만');
        expect(monthly).toBe('영상 4편 업로드');
    });

    it('readConfig 는 파일이 없으면 모든 필드가 빈 문자열인 default 를 돌려준다', () => {
        // Given: 빈 디렉터리
        // When
        const cfg = readConfig(tmp);
        // Then: 원본 default 와 동일 — 모든 필드 빈 문자열
        expect(cfg).toEqual({
            name: '',
            oneLiner: '',
            audience: '',
            tone: '',
            taboos: '',
            goalYear: '',
            goalMonth: '',
            needs: '',
        });
    });

    it('readConfig 는 identity.md + goals.md 를 합쳐서 한 객체로 돌려준다', () => {
        // Given: 양쪽 파일에 값이 흩어져 있음
        writeShared(tmp, 'identity.md', [
            '# 🏢 회사 정체성',
            '- **회사 이름:** 헐크네 가게',
            '- **한 줄 소개:** 가게 운영을 AI 가 돕는다',
            '- **타깃 청중:** 동네 단골',
            '- **브랜드 톤:** 따뜻함',
            '- **금기:** 정치 얘기 금지',
        ].join('\n'));
        writeShared(tmp, 'goals.md', [
            '# 🎯 공동 목표',
            '',
            '## 올해 핵심 목표',
            '- [ ] 월매출 500만원',
            '',
            '## 1개월 내 단기 목표',
            '- 메뉴판 리뉴얼',
            '',
            '## 지금 가장 필요한 것',
            '- SNS 운영 자동화',
        ].join('\n'));

        // When
        const cfg = readConfig(tmp);

        // Then: 8개 필드가 전부 채워진다
        expect(cfg.name).toBe('헐크네 가게');
        expect(cfg.oneLiner).toBe('가게 운영을 AI 가 돕는다');
        expect(cfg.audience).toBe('동네 단골');
        expect(cfg.tone).toBe('따뜻함');
        expect(cfg.taboos).toBe('정치 얘기 금지');
        expect(cfg.goalYear).toBe('월매출 500만원');
        expect(cfg.goalMonth).toBe('메뉴판 리뉴얼');
        expect(cfg.needs).toBe('SNS 운영 자동화');
    });

    it('writeConfig 는 부분 업데이트 시 기존 필드를 보존한다', () => {
        // Given: 한 번 전체 설정을 쓴 상태
        writeConfig(tmp, {
            name: '초안컴퍼니',
            oneLiner: '첫 한 줄',
            audience: '얼리어답터',
            tone: '쿨함',
            taboos: '욕설',
            goalYear: '연 매출 1억',
            goalMonth: '런칭',
            needs: '디자이너',
        });

        // When: tone 만 살짝 갱신
        writeConfig(tmp, { tone: '캐주얼 + 위트' });

        // Then: tone 만 바뀌고 나머지는 그대로
        const cfg = readConfig(tmp);
        expect(cfg.tone).toBe('캐주얼 + 위트');
        expect(cfg.name).toBe('초안컴퍼니');
        expect(cfg.oneLiner).toBe('첫 한 줄');
        expect(cfg.audience).toBe('얼리어답터');
        expect(cfg.taboos).toBe('욕설');
        expect(cfg.goalYear).toBe('연 매출 1억');
        expect(cfg.goalMonth).toBe('런칭');
        expect(cfg.needs).toBe('디자이너');
    });

    it('readConfig 는 손상된 / 비어있는 파일에도 안전하게 fallback (빈 문자열)', () => {
        // Given: identity.md 가 쓰레기 / goals.md 가 비어있음
        writeShared(tmp, 'identity.md', '###### 부서진 헤더 만 있고 라벨 없음');
        writeShared(tmp, 'goals.md', '');

        // When
        const cfg = readConfig(tmp);

        // Then: 모든 필드가 빈 문자열 — throw 하지 않아야 한다
        expect(cfg.name).toBe('');
        expect(cfg.oneLiner).toBe('');
        expect(cfg.audience).toBe('');
        expect(cfg.tone).toBe('');
        expect(cfg.taboos).toBe('');
        expect(cfg.goalYear).toBe('');
        expect(cfg.goalMonth).toBe('');
        expect(cfg.needs).toBe('');
    });
});
