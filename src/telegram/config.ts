/**
 * Telegram bot config reader.
 *
 * extension.ts 에서 분리됨. companyDir 를 인자로 받아 테스트 가능하게 만듦
 * (원본은 getCompanyDir() 글로벌을 호출했음).
 *
 * New canonical: `_agents/secretary/tools/telegram_setup.json` (set via the
 * UI's ⚙️ tool config modal). Falls back to legacy `_agents/secretary/config.md`
 * (markdown edit) for users on pre-v2.52 setups.
 */
import * as path from 'path';
import * as fs from 'fs';
import { safeReadText } from './_fs';

export type TelegramConfig = { token: string; chatId: string };

export function readTelegramConfig(companyDir: string): TelegramConfig {
    let token = '';
    let chatId = '';
    try {
        const jsonPath = path.join(companyDir, '_agents', 'secretary', 'tools', 'telegram_setup.json');
        if (fs.existsSync(jsonPath)) {
            const cfg = JSON.parse(fs.readFileSync(jsonPath, 'utf-8') || '{}');
            token = String(cfg.TELEGRAM_BOT_TOKEN || '').trim();
            chatId = String(cfg.TELEGRAM_CHAT_ID || '').trim();
        }
    } catch { /* ignore malformed JSON, fall through */ }
    if (!token || !chatId) {
        const cfgPath = path.join(companyDir, '_agents', 'secretary', 'config.md');
        const txt = safeReadText(cfgPath);
        if (!token) {
            const tokenM = txt.match(/TELEGRAM_BOT_TOKEN\s*[:：=]\s*([A-Za-z0-9:_\-]+)/);
            if (tokenM) token = tokenM[1].trim();
        }
        if (!chatId) {
            const chatM = txt.match(/TELEGRAM_CHAT_ID\s*[:：=]\s*(-?\d+)/);
            if (chatM) chatId = chatM[1].trim();
        }
    }
    return { token, chatId };
}
