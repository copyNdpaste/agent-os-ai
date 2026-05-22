import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { appendLog, readRecent, conversationsDir, dayFilePath } from '../../src/conversation-log';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'conv-log-'));
}

function today(): string {
    return new Date().toISOString().slice(0, 10);
}

function yesterday(): string {
    return new Date(Date.now() - 86400000).toISOString().slice(0, 10);
}

describe('conversation-log/log', () => {
    let companyDir: string;

    beforeEach(() => {
        companyDir = mkTmp();
    });

    it('appendLog 는 디렉토리 + day file 을 자동 생성한다', () => {
        // Given: 깨끗한 companyDir — conversations 디렉토리 자체가 없음
        expect(fs.existsSync(conversationsDir(companyDir))).toBe(false);

        // When: 첫 entry 를 append
        appendLog(companyDir, { speaker: '사장', body: '오늘 채널 분석 부탁' });

        // Then: 디렉토리 + 오늘 날짜 파일이 만들어졌어야 한다
        expect(fs.existsSync(conversationsDir(companyDir))).toBe(true);
        const f = dayFilePath(companyDir, today());
        expect(fs.existsSync(f)).toBe(true);
        const txt = fs.readFileSync(f, 'utf-8');
        // header + entry 블록이 둘 다 포함
        expect(txt).toContain(`# 📜 ${today()} 회사 대화록`);
        expect(txt).toContain('**사장**');
        expect(txt).toContain('오늘 채널 분석 부탁');
    });

    it('같은 날 두 번 append 는 동일 파일에 누적된다', () => {
        // Given: 첫 append 로 파일 생성
        appendLog(companyDir, { speaker: '사장', body: '첫 명령' });
        const f = dayFilePath(companyDir, today());
        const firstSize = fs.statSync(f).size;

        // When: 두 번째 append
        appendLog(companyDir, { speaker: 'CEO', body: '두 번째 응답' });

        // Then: 같은 파일이 더 커지고, 두 본문이 모두 들어있다
        const secondSize = fs.statSync(f).size;
        expect(secondSize).toBeGreaterThan(firstSize);
        const txt = fs.readFileSync(f, 'utf-8');
        expect(txt).toContain('첫 명령');
        expect(txt).toContain('두 번째 응답');
        // header 는 한 번만 — 정확히 1회 나타나야 함
        const headerMatches = txt.match(/# 📜/g) || [];
        expect(headerMatches.length).toBe(1);
    });

    it('새로운 날 첫 append 는 header 가 포함된 새 파일을 생성한다', () => {
        // Given: 어제 날짜 파일이 미리 있음 (수동으로 작성)
        const convDir = conversationsDir(companyDir);
        fs.mkdirSync(convDir, { recursive: true });
        const yPath = dayFilePath(companyDir, yesterday());
        fs.writeFileSync(yPath, `# 📜 ${yesterday()} 회사 대화록\n\n_옛날 헤더_\n\n## [09:00:00] 🗨️ **사장**\n\n어제 메시지\n`);

        // When: 오늘 첫 append (today file 은 아직 없음)
        const tPath = dayFilePath(companyDir, today());
        expect(fs.existsSync(tPath)).toBe(false);
        appendLog(companyDir, { speaker: 'CEO', body: '오늘 첫 메시지' });

        // Then: 오늘 파일이 새로 생기고 header 가 포함됨
        expect(fs.existsSync(tPath)).toBe(true);
        const txt = fs.readFileSync(tPath, 'utf-8');
        expect(txt.startsWith(`# 📜 ${today()} 회사 대화록`)).toBe(true);
        expect(txt).toContain('오늘 첫 메시지');
        // 어제 파일은 그대로 남아있음
        expect(fs.existsSync(yPath)).toBe(true);
    });

    it('readRecent 는 today + yesterday 파일을 결합해서 반환한다', () => {
        // Given: 어제·오늘 파일에 각각 표식 entry 가 들어가 있음
        const convDir = conversationsDir(companyDir);
        fs.mkdirSync(convDir, { recursive: true });
        fs.writeFileSync(
            dayFilePath(companyDir, yesterday()),
            `# 📜 ${yesterday()} 회사 대화록\n\n어제표식ABC\n`,
        );
        fs.writeFileSync(
            dayFilePath(companyDir, today()),
            `# 📜 ${today()} 회사 대화록\n\n오늘표식XYZ\n`,
        );

        // When
        const out = readRecent(companyDir, 100_000);

        // Then: 둘 다 포함되어야 한다 (어제 → 오늘 순)
        expect(out).toContain('어제표식ABC');
        expect(out).toContain('오늘표식XYZ');
        expect(out.indexOf('어제표식ABC')).toBeLessThan(out.indexOf('오늘표식XYZ'));
        // 컨텍스트 헤더가 prefix 로 붙는다
        expect(out).toContain('[최근 회사 대화 요약 (참고용)]');
    });

    it('readRecent maxChars 는 정확한 tail length 로 잘린다', () => {
        // Given: 큰 분량의 오늘 파일 (5000 chars 정도 채움)
        const convDir = conversationsDir(companyDir);
        fs.mkdirSync(convDir, { recursive: true });
        const big = 'A'.repeat(2000) + 'B'.repeat(2000) + 'TAIL_MARKER_C';
        fs.writeFileSync(dayFilePath(companyDir, today()), big);

        // When: maxChars=100 으로 읽기
        const out = readRecent(companyDir, 100);

        // Then: 정확히 마지막 100자만 (+ context wrapper) 가 포함되어야 함.
        // wrapper 가 앞뒤에 붙는 구조이므로 tail 부분이 정확히 100자임을 확인.
        const wrapperPrefix = '\n\n[최근 회사 대화 요약 (참고용)]\n';
        const wrapperSuffix = '\n';
        expect(out.startsWith(wrapperPrefix)).toBe(true);
        const tail = out.slice(wrapperPrefix.length, out.length - wrapperSuffix.length);
        expect(tail.length).toBe(100);
        // tail 끝의 marker 가 살아있어야 함 (가장 마지막 100자 안에 들어감)
        expect(tail).toContain('TAIL_MARKER_C');
        // 맨 앞 'A' 들은 잘려나가서 안 들어옴
        expect(tail.startsWith('A')).toBe(false);
    });
});
