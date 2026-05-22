import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { offsetPath, readOffset, writeOffset } from '../../src/telegram/offset';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-offset-'));
}

describe('telegram/offset', () => {
    let userBrain: string;

    beforeEach(() => {
        userBrain = mkTmp();
    });

    it('파일이 없으면 0 을 반환한다', () => {
        // Given: 빈 디렉터리
        // When
        const out = readOffset(userBrain);
        // Then
        expect(out).toBe(0);
    });

    it('write → read 라운드트립이 성립한다', () => {
        // Given: write 로 12345 저장
        writeOffset(userBrain, 12345);
        // When
        const out = readOffset(userBrain);
        // Then
        expect(out).toBe(12345);
        // 파일은 jsonl 이 아니라 단일 JSON
        const raw = fs.readFileSync(offsetPath(userBrain), 'utf8');
        const parsed = JSON.parse(raw);
        expect(parsed.offset).toBe(12345);
        expect(typeof parsed.ts).toBe('number');
    });

    it('망가진 JSON 은 0 으로 fallback 한다', () => {
        // Given: 손상된 파일 내용
        const p = offsetPath(userBrain);
        fs.writeFileSync(p, '{not valid json');
        // When
        const out = readOffset(userBrain);
        // Then: parse 실패 → 0
        expect(out).toBe(0);
    });
});
