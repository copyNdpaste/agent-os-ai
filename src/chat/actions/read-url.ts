/**
 * <read_url> / <url> / <fetch_url> action handler.
 * Extracted verbatim from `_executeActions` ("ACTION 8: Read Urls").
 */
import axios from 'axios';
import type { ActionContext } from './types';

const urlRegex = /<(?:read_url|url|fetch_url)>([\s\S]*?)<\/(?:read_url|url|fetch_url)>/gi;

export async function executeReadUrl(ctx: ActionContext): Promise<void> {
    const { aiMessage, report } = ctx;
    const re = new RegExp(urlRegex.source, urlRegex.flags);
    let match: RegExpExecArray | null;

    while ((match = re.exec(aiMessage)) !== null) {
        const url = match[1].trim();
        try {
            // Fetch the HTML content
            const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, timeout: 10000 });
            // Strip scripts and styles first
            let cleaned = data.toString()
                .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
                // Strip remaining HTML tags
                .replace(/<[^>]+>/g, ' ')
                // Consolidate whitespaces
                .replace(/\s+/g, ' ')
                .trim();

            const preview = cleaned.slice(0, 500);
            report.push(`🌐 웹사이트 읽기: ${url} (${cleaned.length}자)\n\`\`\`\n${preview}...\n\`\`\``);
            ctx.pushChatHistory({ role: 'user', content: `[시스템: read_url 결과]\nURL: ${url}\n\`\`\`\n${cleaned.slice(0, 15000)}\n\`\`\`` });
        } catch (err: any) {
            report.push(`❌ 웹사이트 접속 실패: ${url} — ${err.message}`);
            ctx.pushChatHistory({ role: 'user', content: `[시스템: read_url 실패]\n${err.message}` });
        }
    }
}
