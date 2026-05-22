/**
 * Phase: Confer — after each specialist has produced output, ask the CEO
 * model to script a short on-camera exchange between the agents. Output
 * is `ConferTurn[]` which the office view animates as floating bubbles.
 *
 * Extracted out of `_handleCorporatePrompt` byte-for-byte.
 */
import { AGENTS, SPECIALIST_IDS } from '../../agents';
import {
    _personalizePrompt,
    CONFER_PROMPT,
    appendConversationLog,
} from '../../extension';
import type { ConferTurn, CorporateContext, Plan } from './types';

export interface RunConferPhaseArgs {
    ctx: CorporateContext;
    plan: Plan;
    prompt: string;
    modelName: string;
    outputs: Record<string, string>;
}

export async function runConferPhase(args: RunConferPhaseArgs): Promise<ConferTurn[]> {
    const { ctx, plan, prompt, modelName, outputs } = args;
    const conferTurns: ConferTurn[] = [];
    if (plan.tasks.length < 2) {
        return conferTurns;
    }
    try {
        const conferInput = `[원 명령]\n${prompt}\n\n[산출물 요약]\n${plan.tasks.map(t => `\n## ${AGENTS[t.agent]?.name}\n${(outputs[t.agent] || '').slice(0, 800)}`).join('\n')}`;
        const conferRaw = await ctx.callAgentLLM(_personalizePrompt(CONFER_PROMPT), conferInput, modelName, 'ceo', false);
        const m = conferRaw.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(m ? m[0] : conferRaw);
        if (parsed && Array.isArray(parsed.turns)) {
            const validIds = SPECIALIST_IDS;
            for (const t of parsed.turns) {
                if (typeof t.from === 'string' && typeof t.to === 'string' && typeof t.text === 'string'
                    && validIds.includes(t.from) && validIds.includes(t.to)
                    && t.from !== t.to && t.text.trim().length > 0) {
                    conferTurns.push({ from: t.from, to: t.to, text: t.text.trim().slice(0, 80) });
                }
            }
        }
    } catch { /* confer 실패는 silent */ }

    if (conferTurns.length > 0) {
        ctx.post({ type: 'agentConfer', turns: conferTurns });
        // Phase 1: log all confer turns into the running transcript
        const conferBody = conferTurns
            .map(t => `- ${AGENTS[t.from]?.emoji || ''} **${AGENTS[t.from]?.name || t.from}** → ${AGENTS[t.to]?.emoji || ''} ${AGENTS[t.to]?.name || t.to}: ${t.text}`)
            .join('\n');
        appendConversationLog({ speaker: '팀 회의', emoji: '💬', section: '에이전트 간 대화', body: conferBody });
        // 사무실 시각화가 자연스럽게 흐르도록 대기 (캐릭터 walk + bubble + return)
        await new Promise(r => setTimeout(r, Math.min(conferTurns.length * 4500, 22000)));
    }

    return conferTurns;
}
