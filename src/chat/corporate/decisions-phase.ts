/**
 * Phase: Self-learning decision extraction — given the final report +
 * confer turns, ask the model to distill a small set of short decision
 * bullets and persist them to `_shared/decisions.md` so future rounds
 * pick them up via `readAgentSharedContext`.
 *
 * Extracted out of `_handleCorporatePrompt` byte-for-byte.
 */
import * as fs from 'fs';
import * as path from 'path';
import { AGENTS } from '../../agents';
import {
    DECISIONS_EXTRACT_PROMPT,
    getCompanyDir,
} from '../../extension';
import type { ConferTurn, CorporateContext } from './types';

export interface RunDecisionsPhaseArgs {
    ctx: CorporateContext;
    prompt: string;
    modelName: string;
    finalReport: string;
    conferTurns: ConferTurn[];
    sessionDir: string;
}

export async function runDecisionsPhase(args: RunDecisionsPhaseArgs): Promise<string[]> {
    const { ctx, prompt, modelName, finalReport, conferTurns, sessionDir } = args;
    const { post } = ctx;

    // 5.5) 자가학습 — 결정 추출 → decisions.md에 자동 append
    const learnedDecisions: string[] = [];
    try {
        const learnInput = `[원 명령]\n${prompt}\n\n[보고서]\n${finalReport.slice(0, 2500)}\n\n[대화]\n${conferTurns.map(t => `${AGENTS[t.from]?.name} → ${AGENTS[t.to]?.name}: ${t.text}`).join('\n')}`;
        const learnRaw = await ctx.callAgentLLM(DECISIONS_EXTRACT_PROMPT, learnInput, modelName, 'ceo', false);
        const m = learnRaw.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(m ? m[0] : learnRaw);
        if (parsed && Array.isArray(parsed.decisions)) {
            /* v2.92.x — specialist 환각 차단 2차 가드. LLM 이 prompt 룰 어기고
               specialist 의 가상 후보·KPI·우선순위를 결정으로 추출해도, 사장님 명령
               원문에 핵심 명사가 없으면 환각 판정. 사장님 영구 메모리 오염 방지. */
            const promptLower = (prompt || '').toLowerCase();
            const PHANTOM_NOUN_RE = /(악플방패|댓글거울|부동산사기|wedge|우선\s*추진|1순위|0→1|1→n|monopoly|독점\s*가능|단일\s*wedge|좁히고|hybrid\s*제품|행동\s*처방|launch는|채택만|폐기|6각형\s*폐기|콜드\s*hybrid)/i;
            for (const d of parsed.decisions) {
                if (typeof d === 'string' && d.trim().length > 0 && d.trim().length <= 80) {
                    const trimmed = d.trim();
                    /* 의심 키워드가 결정에 있으면 사장님 prompt 에서 같은 단어 확인. 없으면 drop. */
                    if (PHANTOM_NOUN_RE.test(trimmed)) {
                        const m = trimmed.match(PHANTOM_NOUN_RE);
                        if (m && !promptLower.includes(m[0].toLowerCase())) {
                            /* 환각 결정 — drop + log. 사장님 메모리 안 오염. */
                            continue;
                        }
                    }
                    learnedDecisions.push(trimmed);
                }
            }
        }
    } catch { /* silent */ }

    if (learnedDecisions.length > 0) {
        try {
            const dir = getCompanyDir();
            const decPath = path.join(dir, '_shared', 'decisions.md');
            if (!fs.existsSync(decPath)) {
                fs.writeFileSync(decPath, `# 📌 회사 의사결정 로그\n\n_자가학습이 자동 누적합니다. 잘못된 항목은 직접 삭제하세요._\n`);
            }
            const ts = new Date().toISOString().slice(0, 10);
            const block = `\n## [${ts}] ${prompt.slice(0, 60)}\n${learnedDecisions.map(d => `- ${d}`).join('\n')}\n_세션: ${path.basename(sessionDir)}_\n`;
            fs.appendFileSync(decPath, block);
        } catch { /* ignore */ }
        post({ type: 'decisionsLearned', decisions: learnedDecisions });
    }

    return learnedDecisions;
}
