/**
 * readTelegramConfig — companyDir 인자 받아 token/chatId 읽는 pure-ish 함수.
 * tmp dir 만들어 실제 파일 시스템과 상호작용을 검증한다.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readTelegramConfig } from '../../src/telegram/config';

function mkCompanyTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-tg-config-'));
}

function writeSecretaryFile(companyDir: string, rel: string, content: string) {
    const full = path.join(companyDir, '_agents', 'secretary', ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
}

describe('readTelegramConfig', () => {
    let dir: string;
    beforeEach(() => { dir = mkCompanyTmp(); });
    afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('telegram_setup.json 에 토큰·chatId 있으면 그대로 읽는다', () => {
        // Given: canonical JSON 설정 파일
        writeSecretaryFile(dir, 'tools/telegram_setup.json', JSON.stringify({
            TELEGRAM_BOT_TOKEN: '123:ABC-DEF',
            TELEGRAM_CHAT_ID: '987654321',
        }));
        // When
        const cfg = readTelegramConfig(dir);
        // Then
        expect(cfg.token).toBe('123:ABC-DEF');
        expect(cfg.chatId).toBe('987654321');
    });

    it('json 이 없으면 config.md 의 regex 패턴으로 fallback', () => {
        // Given: legacy markdown 설정
        writeSecretaryFile(dir, 'config.md', [
            '# Secretary config',
            'TELEGRAM_BOT_TOKEN: 555:legacy-token',
            'TELEGRAM_CHAT_ID: -100123',
        ].join('\n'));
        // When
        const cfg = readTelegramConfig(dir);
        // Then
        expect(cfg.token).toBe('555:legacy-token');
        expect(cfg.chatId).toBe('-100123');
    });

    it('json/md 둘 다 없으면 빈 문자열을 반환한다', () => {
        // Given: 아무 설정도 없음
        // When
        const cfg = readTelegramConfig(dir);
        // Then
        expect(cfg.token).toBe('');
        expect(cfg.chatId).toBe('');
    });

    it('json 이 망가져 있으면 md fallback 으로 넘어간다', () => {
        // Given: 깨진 JSON + 정상 md
        writeSecretaryFile(dir, 'tools/telegram_setup.json', '{ this is not json');
        writeSecretaryFile(dir, 'config.md', [
            'TELEGRAM_BOT_TOKEN: rescue-token-1',
            'TELEGRAM_CHAT_ID: 42',
        ].join('\n'));
        // When
        const cfg = readTelegramConfig(dir);
        // Then: try/catch 가 JSON 에러를 삼키고 md 로 fallback
        expect(cfg.token).toBe('rescue-token-1');
        expect(cfg.chatId).toBe('42');
    });

    it('json 에 토큰만 있고 chatId 비어있으면 md 에서 chatId 만 채운다', () => {
        // Given: 부분 설정 (token in json, chatId only in md)
        writeSecretaryFile(dir, 'tools/telegram_setup.json', JSON.stringify({
            TELEGRAM_BOT_TOKEN: 'json-token',
        }));
        writeSecretaryFile(dir, 'config.md', 'TELEGRAM_CHAT_ID: 777');
        // When
        const cfg = readTelegramConfig(dir);
        // Then
        expect(cfg.token).toBe('json-token');
        expect(cfg.chatId).toBe('777');
    });
});
