/**
 * Telegram dispatch helpers — capability/status reports + LLM dispatch
 * utilities + casual chat / action-item / JSON parsing helpers.
 *
 * Extracted from src/extension.ts. These functions sit between Telegram
 * polling (which already lives in src/telegram/{polling,commands}.ts) and
 * the multi-agent dispatch pipeline. They were left in extension.ts because
 * they cross-cut multiple subsystems — now collected here so extension.ts
 * can shrink further.
 *
 * Cross-module dependencies pulled from '../extension':
 *   - `readTelegramConfig`, `isCalendarWriteConnected` (calendar OAuth status)
 *   - `isYoutubeOAuthConnected` (re-exported via '../youtube')
 *   - `_safeReadText`, `getCompanyDir` (re-exported via '../paths' for the
 *     latter; the former is still inside extension.ts)
 *   - `listOpenTrackerTasks` (currently inside extension.ts as a helper)
 *   - `_activeChatProvider` (sidebar provider, set during activate)
 *   - `_personalizePrompt` (company-name swap-in)
 *   - `AGENTS` (re-exported via '../agents')
 *   - `ask` (LLM call, from '../llm')
 *
 * Prompt constants now live in '../prompts'.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { ask, type Tier } from '../llm';
import { AGENTS } from '../agents';
import { getCompanyDir } from '../paths';
import { isYoutubeOAuthConnected } from '../youtube';
import { CEO_CLASSIFIER_PROMPT } from '../prompts';
import {
  readTelegramConfig,
  isCalendarWriteConnected,
  _safeReadText,
  _activeChatProvider,
  _personalizePrompt,
} from '../extension';

/* listOpenTrackerTasks is `function listOpenTrackerTasks()` — module-internal
   but `_buildDispatchStatusReport` needs it. Imported via the tracker module
   directly (companyDir-aware variant) to avoid re-exporting extension internals. */
import * as trk from '../tracker';

export const TELEGRAM_HELP = `🤖 *Agent OS 봇* — 비서가 24시간 대기 중

*그냥 자연어로 말해주세요. 비서가 알아서 처리합니다.*

📅 *일정*
"오늘 일정 뭐야" / "내일 3시 광고주 미팅 잡아줘" / "내일 미팅 취소"

📋 *할일·상태*
"할일 뭐 있어?" / "에이전트 뭐 하고 있어?" / "어제 뭐 했어?"

💼 *작업 분배*
"썸네일 만들어줘" / "유튜브 트렌드 분석해줘"
→ CEO가 적합한 에이전트에게 분배 → 결과 보고

🤖 *에이전트 직접 지시*
"디자이너한테 로고 시안 부탁해" / "유튜브에게 컨셉 3개 뽑으라고 해"

🔧 *도구·승인 상태*
"도구 자율도 어때?" / "승인 대기 뭐 있어?"

━━━━━━━━━━━━━
*명령어 (옵션, 없어도 됨)*
\`/done <id>\` — 작업 완료 (id로 확실하게)
\`/cancel <id>\` — 작업 취소
\`/skill\` — 직전 산출물을 패턴(스킬)으로 저장 (다음 호출부터 자동 참조)
\`/skills [에이전트id]\` — 저장된 스킬 목록 보기
\`/help\` — 이 도움말`;

export function _modelToTier(modelName: string): Tier {
    const m = (modelName || '').toLowerCase();
    if (m.includes('opus')) return 'heavy';
    if (m.includes('haiku')) return 'light';
    return 'standard';
}

export function _serializeMessages(messages: { role: string; content: any }[]): string {
    const parts: string[] = [];
    for (const msg of messages) {
        const role = msg.role === 'assistant' ? 'ASSISTANT' : msg.role === 'system' ? 'SYSTEM' : 'USER';
        const content = typeof msg.content === 'string'
            ? msg.content
            : Array.isArray(msg.content)
                ? msg.content.map((c: any) => c?.text || '').join('')
                : String(msg.content ?? '');
        parts.push(`<${role}>\n${content}\n</${role}>`);
    }
    parts.push('Respond as the assistant to the latest USER message above. Do not echo the conversation back.');
    return parts.join('\n\n');
}

export async function _quickLLMCall(systemPrompt: string, userMsg: string, maxTokens = 64): Promise<string> {
    const prompt = `${systemPrompt}\n\n---\n\n${userMsg}\n\n(Respond in ${maxTokens} tokens or fewer. Output only the answer, no preamble.)`;
    const out = await ask(prompt, 'light', { timeoutMs: 60_000 });
    return out.trim();
}

export async function classifyToAgent(text: string): Promise<string> {
    try {
        const out = await _quickLLMCall(_personalizePrompt(CEO_CLASSIFIER_PROMPT), text, 16);
        const id = out.trim().toLowerCase().replace(/[^a-z]/g, '');
        if (AGENTS[id]) return id;
    } catch { /* fall through to keyword router */ }
    const lower = text.toLowerCase();
    if (/인스타|instagram|릴스|피드|reel/.test(lower)) return 'instagram';
    if (/디자인|design|로고|이미지/.test(lower)) return 'designer';
    if (/코드|개발|사이트|웹|deploy|배포|api|app/.test(lower)) return 'developer';
    if (/돈|매출|가격|수익|roi|business|단가/.test(lower)) return 'business';
    if (/일정|할일|todo|미팅|알림|메일|brief|브리핑|캘린더/.test(lower)) return 'secretary';
    if (/편집|자막|b-?roll|컷/.test(lower)) return 'editor';
    if (/카피|스크립트|블로그|후크|글/.test(lower)) return 'writer';
    if (/트렌드|리서치|조사|뉴스/.test(lower)) return 'researcher';
    return 'secretary'; // safe default — secretary triages
}


/* Robust JSON extractor — handles model output that wraps the JSON in prose,
   markdown fences, or multiple objects. Scans ALL balanced top-level objects
   and returns the first one with a string `mode` field; falls back to the
   first parseable object if none has `mode`. Picking by `mode` matters because
   small models often emit a "thinking" / scratchpad JSON before the real
   answer, and the legacy first-only behavior would lock onto the scratchpad
   and leak it (or trigger an empty-reply fallback). */
export function _extractFirstJsonObject(raw: string): any | null {
    if (!raw) return null;
    /* Strip code fences first */
    const stripped = raw.replace(/```[a-zA-Z]*\n?|```/g, '');
    const candidates: any[] = [];
    let i = 0;
    while (i < stripped.length) {
        const start = stripped.indexOf('{', i);
        if (start < 0) break;
        let depth = 0;
        let inStr = false;
        let esc = false;
        let endIdx = -1;
        for (let j = start; j < stripped.length; j++) {
            const ch = stripped[j];
            if (esc) { esc = false; continue; }
            if (ch === '\\') { esc = true; continue; }
            if (ch === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) { endIdx = j; break; }
            }
        }
        if (endIdx < 0) break; // unbalanced trailing object — let the caller's truncation rescue handle it
        try {
            const obj = JSON.parse(stripped.slice(start, endIdx + 1));
            if (obj && typeof obj === 'object') candidates.push(obj);
        } catch { /* skip malformed object, continue scanning */ }
        i = endIdx + 1;
    }
    if (candidates.length === 0) return null;
    const withMode = candidates.find(c => typeof c.mode === 'string');
    return withMode || candidates[0];
}

/* v2.88 — 비서가 "지금 진짜로 뭐 할 수 있는지" 자연어로 답변. 모든 에이전트의
   라이브 상태 + 자격증명 상태 점검. 일반론 답변 대신 사실만 — 사용자가
   "이건 되고 이건 안 되네" 즉시 파악. */
export function _buildCapabilityReport(): string {
    const lines: string[] = ['👋 *카리나예요. 지금 제가 도울 수 있는 건:*\n'];
    const tg = readTelegramConfig();
    const calOk = isCalendarWriteConnected();
    /* 1) 비서 본인의 직접 능력 */
    lines.push('*📅 일정 관리*');
    if (calOk) lines.push('  ✅ 추가·조회·수정·취소 (자연어로) — "내일 3시 미팅 잡아줘"');
    else lines.push('  ⚠️ 미연결 — 명령 팔레트 → "Agent OS: Google Calendar 자동 일정 연결"');
    lines.push('');
    lines.push('*📨 텔레그램 양방향*');
    if (tg.token && tg.chatId) lines.push('  ✅ 작동 중 — 명령 받고 보고 보내기');
    else lines.push('  ⚠️ 미연결 — 직원 보기 → 카리나 카드 → ⚙️에서 봇 토큰 입력');
    lines.push('');
    lines.push('*📋 작업 추적*');
    lines.push('  ✅ "내일까지 X 해야 해" → 자동 등록, 마감 임박 시 알림');
    lines.push('');
    /* 2) 다른 에이전트들의 능력 */
    lines.push('*👥 회사 에이전트들 (자연어로 부르세요)*');
    const agentSummary: string[] = [];
    /* YouTube 상태 */
    try {
        const cfgPath = path.join(getCompanyDir(), '_agents', 'youtube', 'config.md');
        const txt = _safeReadText(cfgPath);
        const apiKey = (txt.match(/YOUTUBE_API_KEY\s*[:：=]\s*([A-Za-z0-9_\-]+)/) || [])[1] || '';
        const channelId = (txt.match(/YOUTUBE_CHANNEL_ID\s*[:：=]\s*([A-Za-z0-9_\-]+)/) || [])[1] || '';
        if (apiKey && channelId) {
            const oauth = isYoutubeOAuthConnected();
            agentSummary.push('  📺 *YouTube* — ✅ 채널 분석·트렌드' + (oauth ? '·시청 지속률·트래픽' : ' (Analytics는 OAuth 필요)'));
        } else {
            agentSummary.push('  📺 *YouTube* — ⚠️ API 키·채널 ID 필요');
        }
    } catch {
        agentSummary.push('  📺 *YouTube* — ⚠️ 설정 필요');
    }
    /* LLM 기반 에이전트들 — 항상 가능 */
    agentSummary.push('  🎨 *디자이너* — ✅ 시안 카피·무드보드·브랜드 컬러 가이드');
    agentSummary.push('  ✍️ *작가* — ✅ 후크·스크립트·블로그·영상 카피');
    agentSummary.push('  🎵 *한스짐머* — ✅ BGM 자동 생성·영상-음악 합성·사운드 디자인');
    agentSummary.push('  💼 *제프베조스* — ✅ 가격·KPI·전략 분석');
    agentSummary.push('  💻 *개발신* — ✅ 사이트·자동화·API 코드');
    agentSummary.push('  🔍 *리서처* — ✅ 트렌드·경쟁사·사실 확인');
    agentSummary.push('  📷 *Instagram* — ✅ 릴스 기획·해시태그·카피');
    lines.push(agentSummary.join('\n'));
    lines.push('');
    lines.push('*예시:*');
    lines.push('• "다음 영상 컨셉 5개 뽑아줘" → CEO가 YouTube·작가에게 분배');
    lines.push('• "썸네일 시안 만들어줘" → 디자이너로');
    lines.push('• "오늘 일정 뭐야?" → 제가 바로 답변');
    lines.push('• "에이전트 뭐 하고 있어?" → 진행 중 작업 모두');
    lines.push('');
    lines.push('_명령 외울 필요 없어요. 자연어로 그냥 말씀해주세요._');
    return lines.join('\n');
}

/* v2.89 — 진행 상태 자기 보고. 디스패치 큐 + 현재 작업 + 추적기 진행 중 작업
   까지 한 화면 요약. 사용자가 "지금 뭐 하고 있어?" 물었을 때 LLM 거치지
   않고 실제 상태를 즉시. */
export function _buildDispatchStatusReport(): string {
    const lines: string[] = ['📊 *지금 상태*\n'];
    const provider = _activeChatProvider;
    const snap = provider?.getDispatchSnapshot?.();
    if (snap?.current) {
        const c = snap.current;
        const priorityIcon = c.priority === 'user' ? '👤' : '🌙';
        const priorityLabel = c.priority === 'user' ? '사용자 명령' : '자율 사이클';
        lines.push(`*${priorityIcon} 진행 중* (${c.elapsedSec}초 째)`);
        lines.push(`  ${priorityLabel}: ${c.prompt.slice(0, 80)}${c.prompt.length > 80 ? '…' : ''}`);
        lines.push('');
    } else {
        lines.push('_대기 중 (현재 진행하는 작업 없음)_\n');
    }
    if (snap && snap.queueLength > 0) {
        lines.push(`*⏳ 대기 줄 (${snap.queueLength}건)*`);
        for (const q of snap.queue) {
            const icon = q.priority === 'user' ? '👤' : '🌙';
            lines.push(`  ${icon} ${q.prompt.slice(0, 70)}${q.prompt.length > 70 ? '…' : ''}`);
        }
        lines.push('');
    }
    /* 추적기 진행 중 작업 */
    try {
        const open = trk.listOpen(getCompanyDir()).slice(0, 8);
        if (open.length > 0) {
            lines.push(`*📋 추적 중인 작업 (${open.length}건)*`);
            for (const t of open) {
                const ico = t.status === 'in_progress' ? '🔄' : '⏳';
                const owner = t.owner === 'user' ? '👤' : t.owner === 'mixed' ? '👥' : '🤖';
                lines.push(`  ${ico} ${owner} ${t.title.slice(0, 60)}`);
            }
            lines.push('');
        }
    } catch { /* tracker may not exist */ }
    /* 24시간 자율 사이클 ON/OFF */
    try {
        const enabled = vscode.workspace.getConfiguration('agentOs').get<boolean>('autoCycleEnabled', true);
        lines.push(`*🌙 24시간 자율 사이클*: ${enabled ? '✅ ON (15분마다 일거리 자동 실행)' : '⏸ OFF'}`);
    } catch { /* ignore */ }
    return lines.join('\n');
}

/* Heuristic for "this is small talk, not a work order". When true we skip
   the JSON planner and just have CEO chat back. Conservative: only matches
   short greetings/acks; anything longer or with action verbs falls through
   to the full planner. */
export function _isCasualChat(text: string): boolean {
    const t = (text || '').trim();
    if (!t) return false;
    // Very short messages with no verbs → casual
    if (t.length < 6) return true;
    // Common Korean greetings / acks / status questions (whole-word-ish)
    if (/^(안녕|잘\s*지냈|헬로|하이|좋은\s*아침|좋은\s*저녁|굿모닝|굿이브닝|반가워|오랜만|뭐해|뭐\s*하고|잘\s*있어|식사|밥\s*먹|커피|화이팅|파이팅)/i.test(t)) return true;
    if (/^(응|네|넵|넹|그래|좋아|오케이|ok|okay|ㅇㅋ|알겠|확인|고마워|감사|땡큐|thx|thanks)([\s.!?~ㅋㅎ]|$)/i.test(t)) return true;
    // Pure emoji/laughter
    if (/^[\sㅋㅎ.!?~ㅠㅜ😂🙂😊👍❤️]+$/u.test(t)) return true;
    return false;
}

/* Action-item harvester — scrape unchecked `- [ ]` style checklist items
   from an agent's output and return them as a deduplicated array. Supports
   `- [ ]`, `* [ ]`, and numbered `1. [ ]` forms so different agents'
   formatting all flow into one tracker. Only unchecked items count —
   `[x]` is already-done, and we don't try to retroactively register
   completed work. Capped to 5 per output to prevent runaway lists. */
export function _harvestActionItems(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*(?:[-*]|\d+\.)\s*\[\s\]\s+(.{4,200})$/);
    if (m) {
      const title = m[1].trim().replace(/\s+/g, ' ');
      if (title && !out.includes(title)) out.push(title);
      if (out.length >= 5) break;
    }
  }
  return out;
}
