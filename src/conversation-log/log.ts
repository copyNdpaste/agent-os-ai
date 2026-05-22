/**
 * Conversation log — per-day Markdown transcripts of every company interaction.
 *
 * extension.ts 에서 분리됨 (god-file 모듈화). companyDir 는 외부에서 주입한다.
 *
 * Lives at `<companyDir>/00_Raw/conversations/<YYYY-MM-DD>.md` so it joins the
 * existing Second-Brain raw-knowledge convention — visible to the brain graph,
 * synced by GitHub auto-sync, browsable in the user's note-taking app.
 *
 * 각 일자 파일은 다음 형식:
 *   header: `# 📜 {date} 회사 대화록\n\n_...설명_\n`
 *   entry blocks: `\n## [{ts}] {emoji} **{speaker}**{section}\n\n{body}\n`
 *
 * 바이트 단위로 기존 형식 보존 — 두뇌 인덱서가 이미 학습한 포맷이라 깨면 안 됨.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface ConversationLogEntry {
    speaker: string;
    emoji?: string;
    section?: string;
    body: string;
}

/** Resolve the conversation log directory inside the user's brain/company folder.
 *  Lives at `<companyDir>/00_Raw/conversations/` so it joins the existing
 *  Second-Brain raw-knowledge convention. */
export function conversationsDir(companyDir: string): string {
    return path.join(companyDir, '00_Raw', 'conversations');
}

/** Path of the day's running conversation Markdown file. `date` is YYYY-MM-DD. */
export function dayFilePath(companyDir: string, date: string): string {
    return path.join(conversationsDir(companyDir), `${date}.md`);
}

/** Append one entry to the day's running conversation log. Living transcript
 *  of every interaction in the company — user commands, CEO briefs, each
 *  agent's output, confer turns, final reports. Stored in 00_Raw alongside
 *  other raw knowledge so it participates in brain queries.
 *
 *  Best-effort — swallows IO errors so a disk hiccup never breaks the flow. */
export function appendLog(companyDir: string, entry: ConversationLogEntry): void {
    try {
        const convDir = conversationsDir(companyDir);
        fs.mkdirSync(convDir, { recursive: true });
        const today = new Date().toISOString().slice(0, 10);
        const dayFile = path.join(convDir, `${today}.md`);
        if (!fs.existsSync(dayFile)) {
            fs.writeFileSync(dayFile, `# 📜 ${today} 회사 대화록\n\n_모든 명령·분배·산출물·대화가 시간순으로 누적됩니다. 두뇌가 자동 인덱싱·동기화합니다._\n`);
        }
        const ts = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        const emoji = entry.emoji || '🗨️';
        const sectionLine = entry.section ? ` · _${entry.section}_` : '';
        const block = `\n## [${ts}] ${emoji} **${entry.speaker}**${sectionLine}\n\n${entry.body}\n`;
        fs.appendFileSync(dayFile, block);
    } catch { /* logging must never break the flow */ }
}

/** Read the last N chars (across today + yesterday) of the conversation log
 *  for use as system-prompt context. Lets CEO recall what the company has
 *  recently been working on without needing the full file. */
export function readRecent(companyDir: string, maxChars: number = 2500): string {
    try {
        const convDir = conversationsDir(companyDir);
        if (!fs.existsSync(convDir)) return '';
        const today = new Date().toISOString().slice(0, 10);
        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        let combined = '';
        for (const day of [yesterday, today]) {
            const f = path.join(convDir, `${day}.md`);
            if (fs.existsSync(f)) {
                try { combined += fs.readFileSync(f, 'utf-8'); } catch { /* ignore */ }
            }
        }
        if (!combined) return '';
        const tail = combined.slice(-maxChars);
        return `\n\n[최근 회사 대화 요약 (참고용)]\n${tail}\n`;
    } catch {
        return '';
    }
}
