/**
 * <read_brain> action handler — surfaces files in the Second-Brain index.
 * Extracted verbatim from `_executeActions` ("ACTION 7: Read Second Brain documents").
 */
import type { ActionContext } from './types';

const brainReadRegex = /<read_brain>([\s\S]*?)<\/read_brain>/gi;

export async function executeReadBrain(ctx: ActionContext): Promise<void> {
    const { aiMessage, report } = ctx;
    const re = new RegExp(brainReadRegex.source, brainReadRegex.flags);
    let match: RegExpExecArray | null;

    while ((match = re.exec(aiMessage)) !== null) {
        const filename = match[1].trim();
        if (!filename) continue;
        const content = ctx.readBrainFile(filename);
        report.push(`🧠 두뇌 파일 읽기: ${filename}`);
        ctx.pushChatHistory({ role: 'user', content: `[시스템: read_brain 결과]\n파일: ${filename}\n\`\`\`\n${content.slice(0, 15000)}\n\`\`\`` });
    }
}
