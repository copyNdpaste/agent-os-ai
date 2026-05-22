/**
 * Telegram HTTP client.
 *
 * extension.ts 에서 분리됨. axios 는 defaultHttpClient 안에서만 사용 — 외부에는
 * HttpClient 인터페이스만 노출해서 테스트에서 fake 주입 가능.
 *
 * - sendReport: 단일 메시지 (4000자 cap, Markdown).
 * - sendLong: 긴 텍스트를 자연 경계로 청크 분할 후 순차 전송. Markdown 실패 시 plain text 재시도.
 * - sendTyping: sendChatAction(action='typing') 호출.
 *
 * 모든 함수는 network 예외를 삼키고 boolean / void 반환 — 원본 동작 유지.
 */
import axios from 'axios';
import { markdownToTelegram } from './markdown';
import type { TelegramConfig } from './config';

export interface HttpClient {
    post(
        url: string,
        data: any,
        opts?: { timeout?: number; validateStatus?: (s: number) => boolean }
    ): Promise<{ status: number; data: any }>;
}

export const defaultHttpClient: HttpClient = {
    async post(url, data, opts) {
        const r = await axios.post(url, data, opts);
        return { status: r.status, data: r.data };
    },
};

const MAX_CHUNK = 3800; // safety margin under Telegram's 4096 cap
const SINGLE_CAP = 4000;

export async function sendReport(
    text: string,
    cfg: TelegramConfig,
    http: HttpClient = defaultHttpClient
): Promise<boolean> {
    if (!cfg.token || !cfg.chatId) return false;
    try {
        const url = `https://api.telegram.org/bot${cfg.token}/sendMessage`;
        await http.post(
            url,
            {
                chat_id: cfg.chatId,
                text: markdownToTelegram(text).slice(0, SINGLE_CAP),
                parse_mode: 'Markdown',
                disable_web_page_preview: true,
            },
            { timeout: 8000 }
        );
        return true;
    } catch {
        return false;
    }
}

export async function sendLong(
    text: string,
    cfg: TelegramConfig,
    http: HttpClient = defaultHttpClient
): Promise<boolean> {
    if (!cfg.token || !cfg.chatId) return false;
    const clean = markdownToTelegram((text || '').trim());
    if (!clean) return false;
    const chunks: string[] = [];
    let remaining = clean;
    while (remaining.length > MAX_CHUNK) {
        /* Prefer to split at a double-newline boundary, then a single newline,
           then a sentence end. Falls back to a hard cut when nothing else fits. */
        let splitAt = remaining.lastIndexOf('\n\n', MAX_CHUNK);
        if (splitAt < MAX_CHUNK * 0.6) splitAt = remaining.lastIndexOf('\n', MAX_CHUNK);
        if (splitAt < MAX_CHUNK * 0.6) splitAt = remaining.lastIndexOf('. ', MAX_CHUNK);
        if (splitAt < MAX_CHUNK * 0.4) splitAt = MAX_CHUNK;
        chunks.push(remaining.slice(0, splitAt).trimEnd());
        remaining = remaining.slice(splitAt).trimStart();
    }
    if (remaining) chunks.push(remaining);
    const url = `https://api.telegram.org/bot${cfg.token}/sendMessage`;
    let allOk = true;
    for (let i = 0; i < chunks.length; i++) {
        const part = chunks.length > 1 ? `${chunks[i]}\n\n_(${i + 1}/${chunks.length})_` : chunks[i];
        let ok = false;
        try {
            const r = await http.post(
                url,
                {
                    chat_id: cfg.chatId,
                    text: part,
                    parse_mode: 'Markdown',
                    disable_web_page_preview: true,
                },
                { timeout: 10000, validateStatus: () => true }
            );
            ok = r.status >= 200 && r.status < 300;
            if (!ok) {
                // Markdown parse error → retry as plain text so the user still gets something
                const r2 = await http.post(
                    url,
                    {
                        chat_id: cfg.chatId,
                        text: part.replace(/[*_`\[\]]/g, ''),
                        disable_web_page_preview: true,
                    },
                    { timeout: 10000, validateStatus: () => true }
                );
                ok = r2.status >= 200 && r2.status < 300;
            }
        } catch {
            ok = false;
        }
        if (!ok) allOk = false;
        /* Throttle ~25/s globally; we send a few in a row, sleep just enough */
        if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 350));
    }
    return allOk;
}

export async function sendTyping(
    cfg: TelegramConfig,
    http: HttpClient = defaultHttpClient
): Promise<void> {
    if (!cfg.token || !cfg.chatId) return;
    try {
        await http.post(
            `https://api.telegram.org/bot${cfg.token}/sendChatAction`,
            { chat_id: cfg.chatId, action: 'typing' },
            { timeout: 4000, validateStatus: () => true }
        );
    } catch {
        /* ignore */
    }
}
