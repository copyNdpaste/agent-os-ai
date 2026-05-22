/**
 * Telegram HTTP client BDD — fake HttpClient 를 주입해서 네트워크 없이 검증.
 * 원본 sendTelegramReport/Long/Typing 동작과 1:1 매칭.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    sendReport,
    sendLong,
    sendTyping,
    type HttpClient,
} from '../../src/telegram/client';
import type { TelegramConfig } from '../../src/telegram/config';

function makeHttp(impl?: (url: string, data: any) => { status: number; data?: any }): HttpClient {
    const fn = vi.fn(async (url: string, data: any) => {
        const r = impl ? impl(url, data) : { status: 200, data: { ok: true } };
        return { status: r.status, data: r.data ?? { ok: true } };
    });
    return { post: fn as any };
}

const fullCfg: TelegramConfig = { token: 'T:abc', chatId: '123' };
const emptyCfg: TelegramConfig = { token: '', chatId: '' };

describe('sendReport', () => {
    it('토큰 없으면 즉시 false 반환 (네트워크 호출 0회)', async () => {
        // Given: 빈 cfg
        const http = makeHttp();
        // When
        const ok = await sendReport('hi', emptyCfg, http);
        // Then
        expect(ok).toBe(false);
        expect((http.post as any).mock.calls.length).toBe(0);
    });

    it('text 를 4000자로 잘라 전송한다', async () => {
        // Given: 5000자 입력
        const http = makeHttp();
        const long = 'a'.repeat(5000);
        // When
        const ok = await sendReport(long, fullCfg, http);
        // Then
        expect(ok).toBe(true);
        const call = (http.post as any).mock.calls[0];
        expect(call[1].text.length).toBeLessThanOrEqual(4000);
    });

    it('parse_mode=Markdown 으로 보낸다', async () => {
        // Given
        const http = makeHttp();
        // When
        await sendReport('hello', fullCfg, http);
        // Then
        const call = (http.post as any).mock.calls[0];
        expect(call[0]).toBe('https://api.telegram.org/botT:abc/sendMessage');
        expect(call[1].parse_mode).toBe('Markdown');
        expect(call[1].chat_id).toBe('123');
        expect(call[1].disable_web_page_preview).toBe(true);
    });

    it('HTTP 예외가 나도 boolean 반환 (throw 안 됨) → false', async () => {
        // Given: 항상 throw 하는 http
        const http: HttpClient = { post: vi.fn(async () => { throw new Error('boom'); }) as any };
        // When
        const ok = await sendReport('x', fullCfg, http);
        // Then
        expect(ok).toBe(false);
    });
});

describe('sendLong', () => {
    beforeEach(() => { vi.useFakeTimers(); });

    async function runWithTimers<T>(p: Promise<T>): Promise<T> {
        // setTimeout(350) chunk throttle 을 fake-timer 로 지나가게 함
        const flush = async () => {
            for (let i = 0; i < 20; i++) {
                await vi.advanceTimersByTimeAsync(500);
            }
        };
        const f = flush();
        const r = await p;
        await f;
        vi.useRealTimers();
        return r;
    }

    it('토큰 없으면 즉시 false 반환', async () => {
        const http = makeHttp();
        const ok = await sendLong('hi', emptyCfg, http);
        expect(ok).toBe(false);
        expect((http.post as any).mock.calls.length).toBe(0);
        vi.useRealTimers();
    });

    it('텍스트가 MAX(3800) 이하면 1회만 전송', async () => {
        // Given: 짧은 텍스트
        const http = makeHttp();
        // When
        const ok = await runWithTimers(sendLong('짧은 메시지', fullCfg, http));
        // Then
        expect(ok).toBe(true);
        expect((http.post as any).mock.calls.length).toBe(1);
        const body = (http.post as any).mock.calls[0][1];
        // 단일 청크일 때 "(1/N)" suffix 가 붙지 않음
        expect(body.text).not.toMatch(/\(1\/\d+\)/);
        expect(body.parse_mode).toBe('Markdown');
    });

    it('MAX 초과 시 여러 청크로 나눠 순차 전송', async () => {
        // Given: 자연 경계가 있는 9000자 텍스트
        const para = 'A'.repeat(3000);
        const text = [para, para, para].join('\n\n');
        const http = makeHttp();
        // When
        const ok = await runWithTimers(sendLong(text, fullCfg, http));
        // Then
        expect(ok).toBe(true);
        const calls = (http.post as any).mock.calls;
        expect(calls.length).toBeGreaterThanOrEqual(2);
        // chunk suffix 가 붙어야 함
        for (const c of calls) {
            expect(c[1].text).toMatch(/_\(\d+\/\d+\)_$/);
        }
    });

    it('첫 청크 실패(400) 시 plain text 로 재시도 (Markdown 거부 fallback)', async () => {
        // Given: Markdown 호출은 400, plain text 호출은 200
        let n = 0;
        const http = makeHttp((_url, data) => {
            n++;
            // 첫 호출(Markdown) 실패, 두 번째(no parse_mode) 성공
            if (data.parse_mode === 'Markdown') return { status: 400, data: { ok: false } };
            return { status: 200, data: { ok: true } };
        });
        // When
        const ok = await runWithTimers(sendLong('hello world', fullCfg, http));
        // Then
        expect(ok).toBe(true);
        expect(n).toBe(2);
        const second = (http.post as any).mock.calls[1][1];
        expect(second.parse_mode).toBeUndefined();
        // plain text 변환 시 *_`[] 제거됨 — 우리 input엔 마크다운 없으니 그대로
        expect(second.text).toContain('hello world');
    });

    it('HTTP 예외 발생해도 boolean 반환 (throw 안 됨)', async () => {
        // Given: 항상 throw
        const http: HttpClient = { post: vi.fn(async () => { throw new Error('net down'); }) as any };
        // When
        const ok = await runWithTimers(sendLong('hi', fullCfg, http));
        // Then
        expect(typeof ok).toBe('boolean');
        expect(ok).toBe(false);
    });
});

describe('sendTyping', () => {
    it('action=typing 으로 sendChatAction 호출', async () => {
        // Given
        const http = makeHttp();
        // When
        await sendTyping(fullCfg, http);
        // Then
        const call = (http.post as any).mock.calls[0];
        expect(call[0]).toBe('https://api.telegram.org/botT:abc/sendChatAction');
        expect(call[1].action).toBe('typing');
        expect(call[1].chat_id).toBe('123');
    });

    it('토큰 없으면 no-op (네트워크 호출 0회, throw 안 됨)', async () => {
        const http = makeHttp();
        await expect(sendTyping(emptyCfg, http)).resolves.toBeUndefined();
        expect((http.post as any).mock.calls.length).toBe(0);
    });

    it('HTTP 예외 발생해도 throw 하지 않음', async () => {
        const http: HttpClient = { post: vi.fn(async () => { throw new Error('x'); }) as any };
        await expect(sendTyping(fullCfg, http)).resolves.toBeUndefined();
    });
});
