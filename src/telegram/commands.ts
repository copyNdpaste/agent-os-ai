/**
 * Telegram command handlers — /done, /reschedule, /priority, free-text routing
 * through Secretary (자연어 분류 후 분배).
 *
 * extension.ts 에서 분리. byte-for-byte copy — 리팩토링 X. 외부 헬퍼는 모두
 * import 로 끌어온다. polling.ts 가 handleTelegramCommand 를 진입점으로 호출.
 *
 * Deps imported from `../extension` (★ = need `export` added in extension.ts):
 *   - sendTelegramReport, sendTelegramLong, sendTelegramTyping  ★ (wrappers)
 *   - _pushTelegramHistory, _renderTelegramHistory              ★
 *   - _quickLLMCall                                             ★
 *   - _extractFirstJsonObject                                   ★
 *   - _buildCapabilityReport                                    ★
 *   - _buildDispatchStatusReport                                ★
 *   - classifyToAgent                                           ★
 *   - _parseLooseDate                                           ★
 *   - _getLastSpecialistOutput                                  ★
 *   - saveAgentSkill                                            ★
 *   - appendConversationLog                                     ★
 *   - appendAgentMemory                                         ★
 *   - addTrackerTask                                            ★
 *   - trackerToMarkdown                                         ★
 *   - listOpenTrackerTasks                                      ★ (currently
 *     not used directly here but declared in module surface)
 *   - isCalendarWriteConnected                                  ★
 *   - createCalendarEventDirect                                 ★
 *   - findCalendarEvents                                        ★
 *   - deleteCalendarEvent                                       ★
 *   - patchCalendarEvent                                        ★
 *   - refreshCalendarCacheViaOAuth                              ★
 *   - readRecentConversations                                   (already exported)
 *   - readTracker, updateTrackerTask, _safeReadText             (already exported)
 *   - resolveApproval, listPendingApprovals                     (already exported)
 *   - TASK_PRIORITY_LABEL, type TaskPriority                    (already exported)
 *   - SECRETARY_TELEGRAM_PROMPT, TELEGRAM_HELP                  ★ (constants)
 *   - _activeChatProvider                                       (already exported)
 *
 * Deps from extracted modules:
 *   - AGENTS, SPECIALIST_IDS    ← '../agents'
 *   - getCompanyDir             ← '../paths'
 */
import * as fs from 'fs';
import * as path from 'path';
import { AGENTS, SPECIALIST_IDS } from '../agents';
import { getCompanyDir } from '../paths';
import {
    sendTelegramReport,
    sendTelegramLong,
    sendTelegramTyping,
    _pushTelegramHistory,
    _renderTelegramHistory,
    _quickLLMCall,
    _extractFirstJsonObject,
    _buildCapabilityReport,
    _buildDispatchStatusReport,
    classifyToAgent,
    _parseLooseDate,
    _getLastSpecialistOutput,
    saveAgentSkill,
    appendConversationLog,
    appendAgentMemory,
    addTrackerTask,
    trackerToMarkdown,
    isCalendarWriteConnected,
    createCalendarEventDirect,
    findCalendarEvents,
    deleteCalendarEvent,
    patchCalendarEvent,
    refreshCalendarCacheViaOAuth,
    readRecentConversations,
    readTracker,
    updateTrackerTask,
    _safeReadText,
    resolveApproval,
    listPendingApprovals,
    TASK_PRIORITY_LABEL,
    type TaskPriority,
    SECRETARY_TELEGRAM_PROMPT,
    TELEGRAM_HELP,
    _activeChatProvider,
} from '../extension';

export async function handleTelegramCommand(text: string): Promise<void> {
    const trimmed = text.trim();
    const cmd = trimmed.split(/\s+/)[0].toLowerCase();
    const rest = trimmed.slice(cmd.length).trim();

    if (cmd === '/help' || cmd === '/start') {
        await sendTelegramReport(TELEGRAM_HELP);
        return;
    }
    /* Plan B (2026-05-03 단순화) — 슬래시 명령은 4개만 유지:
         /help · /start  → Telegram 봇 관습 (첫 추가 시 자동 발동)
         /done <id>      → 작업 완료 (id로 확실하게 — 자연어 모호성 회피)
         /cancel <id>    → 작업 취소 (동일 이유)
       나머지(/agents, /tools, /approvals, /calendar, /today, /brief, /tasks,
       /ask)는 모두 비서가 자연어로 답하는 게 더 자연스러워서 제거. 알 수
       없는 슬래시도 거부하지 않고 비서한테 그대로 흘림 — 사용자가 외울
       명령은 사실상 0개. */
    if (cmd === '/done' || cmd === '/cancel') {
        const idArg = rest.trim();
        if (!idArg) {
            await sendTelegramReport(`사용법: \`${cmd} <id>\` — 작업 id는 "할일 뭐 있어?"라고 물어보면 비서가 알려줘요. 마지막 9자리만 입력해도 OK.`);
            return;
        }
        /* Allow short suffix match */
        const all = readTracker().tasks;
        const match = all.find(t => t.id === idArg) || all.find(t => t.id.endsWith(idArg));
        if (!match) {
            await sendTelegramReport(`❌ id \`${idArg}\` 못 찾았어요. "할일 뭐 있어?"로 목록 확인해주세요.`);
            return;
        }
        if (match.status === 'done' || match.status === 'cancelled') {
            await sendTelegramReport(`이미 ${match.status === 'done' ? '완료' : '취소'} 상태입니다.`);
            return;
        }
        const newStatus = cmd === '/done' ? 'done' : 'cancelled';
        updateTrackerTask(match.id, { status: newStatus, evidence: cmd === '/done' ? '사용자 텔레그램 확인' : '사용자 취소' });
        await sendTelegramReport(`${cmd === '/done' ? '✅' : '✖️'} \`${match.id.slice(-9)}\` ${match.title}\n→ ${newStatus === 'done' ? '완료' : '취소'} 처리됨.`);
        return;
    }
    /* P1-8: edit commands — let the user retarget tasks without re-creating.
       Loose date parser (ISO, "내일", "오늘 15:00", "+2h") covers the
       common cases without dragging in a date library. */
    if (cmd === '/reschedule' || cmd === '/priority' || cmd === '/move-to') {
        const parts = rest.split(/\s+/).filter(Boolean);
        const idArg = parts.shift() || '';
        const argRest = parts.join(' ').trim();
        if (!idArg || !argRest) {
            await sendTelegramReport(`사용법:\n\`/reschedule <id> <시간>\` (예: \`내일 15:00\`, \`+2h\`, \`2026-05-10\`)\n\`/priority <id> <urgent|high|normal|low>\`\n\`/move-to <id> <에이전트id>\``);
            return;
        }
        const all = readTracker().tasks;
        const match = all.find(t => t.id === idArg) || all.find(t => t.id.endsWith(idArg));
        if (!match) {
            await sendTelegramReport(`❌ id \`${idArg}\` 못 찾았어요.`);
            return;
        }
        if (cmd === '/reschedule') {
            const dt = _parseLooseDate(argRest);
            if (!dt) {
                await sendTelegramReport(`⚠️ 시간을 못 알아들었어요: \`${argRest}\`\n예: \`내일 15:00\`, \`+2h\`, \`2026-05-10 09:00\``);
                return;
            }
            updateTrackerTask(match.id, { dueAt: dt.toISOString(), preAlarmsSent: [] });
            await sendTelegramReport(`📅 \`${match.id.slice(-9)}\` ${match.title}\n→ ${dt.toLocaleString('ko-KR')} 으로 변경`);
            return;
        }
        if (cmd === '/priority') {
            const p = argRest.toLowerCase();
            if (p !== 'urgent' && p !== 'high' && p !== 'normal' && p !== 'low') {
                await sendTelegramReport(`⚠️ 우선순위는 \`urgent / high / normal / low\` 중 하나여야 해요.`);
                return;
            }
            updateTrackerTask(match.id, { priority: p as TaskPriority });
            await sendTelegramReport(`${TASK_PRIORITY_LABEL[p as TaskPriority]} \`${match.id.slice(-9)}\` ${match.title}\n→ 우선순위 ${p}`);
            return;
        }
        if (cmd === '/move-to') {
            const newAgent = argRest.toLowerCase().trim();
            if (!AGENTS[newAgent]) {
                await sendTelegramReport(`⚠️ 에이전트 id를 모르겠어요: \`${newAgent}\`. \`/agents\`로 목록 확인.`);
                return;
            }
            const a = AGENTS[newAgent];
            updateTrackerTask(match.id, { agentIds: [newAgent], owner: 'agent' });
            await sendTelegramReport(`${a.emoji} \`${match.id.slice(-9)}\` ${match.title}\n→ ${a.name}에게 이관`);
            return;
        }
    }
    /* v2.89.115 — /skill: 직전 specialist 산출물을 재사용 가능한 패턴으로
       승격해서 _agents/{id}/skills/<slug>.md 에 저장. Hermes Agent의 skill
       자동승격을 1인 기업 컨셉으로 단순화한 것 — 자동 노이즈 X, 사용자가
       명시적으로 트리거할 때만. 다음 호출부터 해당 specialist의 system prompt
       에 자동 주입됨.
         /skill            → 대화 로그에서 직전 specialist 자동 감지
         /skill <agent_id> → 명시적으로 어느 에이전트에 저장할지 지정 */
    if (cmd === '/skill') {
        const argId = rest.toLowerCase().trim();
        const last = _getLastSpecialistOutput();
        if (!last) {
            await sendTelegramReport(`⚠️ 직전 specialist 산출물을 찾지 못했어요. 작업 한 번 시킨 다음에 \`/skill\`을 호출해주세요.`);
            return;
        }
        const targetId = argId && AGENTS[argId] ? argId : last.agentId;
        const target = AGENTS[targetId];
        await sendTelegramReport(`💎 ${target.emoji} *${target.name}* — 직전 산출물을 패턴화하는 중…`);
        const result = await saveAgentSkill(targetId, last.body, { titleHint: last.body.slice(0, 80) });
        if (!result.ok) {
            await sendTelegramReport(`⚠️ ${result.reason}`);
            try { appendConversationLog({ speaker: '시스템', emoji: '💎', section: '스킬 저장 시도', body: `${target.name} → ${result.reason}` }); } catch { /* ignore */ }
            return;
        }
        await sendTelegramReport(`✅ ${target.emoji} *${target.name}* 스킬 저장됨\n\n*${result.title}*\n\n다음 호출부터 ${target.name}의 시스템 컨텍스트에 자동 주입돼요.`);
        try { appendConversationLog({ speaker: '시스템', emoji: '💎', section: '스킬 저장', body: `${target.name} → ${result.title}` }); } catch { /* ignore */ }
        try { appendAgentMemory(targetId, `[skill 승격] "${result.title}" — 다음 사이클부터 패턴 재사용`); } catch { /* ignore */ }
        return;
    }
    if (cmd === '/skills') {
        const argId = rest.toLowerCase().trim();
        const ids = argId && AGENTS[argId] ? [argId] : SPECIALIST_IDS;
        const lines: string[] = [];
        for (const id of ids) {
            const a = AGENTS[id];
            const skillsDir = path.join(getCompanyDir(), '_agents', id, 'skills');
            let files: string[] = [];
            try { files = fs.readdirSync(skillsDir).filter(f => f.endsWith('.md') && f.toLowerCase() !== 'readme.md'); } catch { /* ignore */ }
            if (files.length === 0) continue;
            lines.push(`${a.emoji} *${a.name}* (${files.length})`);
            for (const f of files.slice(0, 5)) {
                const txt = _safeReadText(path.join(skillsDir, f));
                const title = (txt.split('\n')[0] || f).replace(/^#+\s*/, '').trim().slice(0, 60);
                lines.push(`  • ${title}`);
            }
            if (files.length > 5) lines.push(`  _… +${files.length - 5}개_`);
        }
        if (lines.length === 0) {
            await sendTelegramReport(`💎 저장된 스킬이 아직 없어요. 작업 후 \`/skill\`로 패턴화해보세요.`);
        } else {
            await sendTelegramReport(`💎 *저장된 스킬*\n\n${lines.join('\n')}`);
        }
        return;
    }
    /* P0-4: /approve /reject — release or kill an agent's pending action.
       Same shape as /done /cancel, separate id-space (`apr-…`). */
    if (cmd === '/approve' || cmd === '/reject') {
        const idArg = rest.trim();
        if (!idArg) {
            const pending = listPendingApprovals();
            if (pending.length === 0) {
                await sendTelegramReport(`✅ 승인 대기 액션이 없어요.`);
                return;
            }
            const list = pending.slice(0, 5).map(a => {
                const ag = AGENTS[a.agentId];
                return `• \`${a.id.slice(-9)}\` ${ag?.emoji || '🤖'} ${a.title}`;
            }).join('\n');
            await sendTelegramReport(`사용법: \`${cmd} <id>\`\n\n*대기 중 (${pending.length}건)*\n${list}`);
            return;
        }
        const decision = cmd === '/approve' ? 'approved' : 'rejected';
        const result = await resolveApproval(idArg, decision);
        await sendTelegramReport(result.message);
        return;
    }
    /* Unknown slash — fall through to natural-language handling. Don't reject.
       Users who type "/뭐하고있어" should get an answer, not a rejection. */

    /* Free text → Secretary mediates. Secretary decides whether to answer
       directly (schedule/status questions), forward to CEO (work that needs
       dispatch), or ask for more info. This is the "Secretary as gateway"
       behavior — every Telegram interaction goes through the agent who's
       supposed to be the messenger. */
    try {
        await handleTelegramViaSecretary(trimmed);
    } catch (e: any) {
        /* Fallback to old classifier behavior if Secretary call fails — keeps
           the bot responsive even when the local LLM is down. */
        try {
            const targetAgent = await classifyToAgent(trimmed);
            const a = AGENTS[targetAgent];
            await sendTelegramReport(`🧭 (비서 응답 실패 → CEO 라우팅) ${a.emoji} *${a.name}*\n\n_"${trimmed.slice(0, 120)}"_\n\n_답변 준비되는 대로 보내드릴게요._`);
            _activeChatProvider?.sendPromptFromExtension?.(trimmed, { fromTelegram: true, corporate: true });
        } catch { /* truly silent fail */ }
    }
}

export async function handleTelegramViaSecretary(userText: string): Promise<void> {
    /* Mirror user's Telegram message into the sidebar chat */
    try { _activeChatProvider?.postSystemNote?.(`텔레그램: "${userText.slice(0, 200)}"`, '📱'); } catch { /* ignore */ }
    /* Show the bot is working — Telegram typing indicator */
    sendTelegramTyping().catch(() => { /* ignore */ });
    /* Push the user's message into short-term memory BEFORE we build the
       prompt — Secretary needs to see "그 일정", "방금 그거" type follow-ups
       in context. Reply gets pushed at each branch below so the next turn's
       history reflects what we actually said. */
    _pushTelegramHistory('user', userText);
    /* v2.89.3 — Cancel intent. 진행 중 작업이 있으면 즉시 abort. LLM 안 거침
       — 사용자가 멈추라고 했는데 또 LLM 한 사이클 돌리면 답답함 가중. */
    const cancelQ = /^\s*(취소|중단|중지|그만|멈춰|멈춰줘|stop|cancel|abort|nevermind|never\s*mind)\s*[\.!\?]*\s*$/i;
    if (cancelQ.test(userText)) {
        const result = _activeChatProvider?.abortActiveDispatch?.() || { cancelled: false };
        if (result.cancelled) {
            const what = result.what ? ` (${result.what} 단계에서)` : '';
            const msg = `🛑 *비서*: 작업 중단했어요${what}. 다음 명령 기다릴게요.`;
            await sendTelegramReport(msg);
            _pushTelegramHistory('assistant', `작업 중단됨${what}`);
            try { _activeChatProvider?.postSystemNote?.(`비서 → 텔레그램 (작업 중단)`, '🛑'); } catch { /* ignore */ }
        } else {
            const msg = `💬 *비서*: 지금 진행 중인 작업이 없어요. 자유롭게 새 명령 주세요.`;
            await sendTelegramReport(msg);
            _pushTelegramHistory('assistant', `진행 중 작업 없음 — 취소할 거 없음`);
        }
        return;
    }
    /* v2.88 — Capability introspection. "뭐 할 수 있어?" / "도움" / "/start"
       류 메시지면 LLM 거치지 않고 실제 연결된 능력만 자연어로 답변. 일반론
       대신 정확히 지금 가능한 것만 알려줘서 "AI가 멍청하다" 인상 줄임. */
    const introQ = /^\s*(\/start|\/help|뭐\s*할\s*수\s*있|도움|help|what.*can.*you.*do|할\s*수\s*있는\s*거|기능\s*뭐|능력\s*뭐)/i;
    if (introQ.test(userText)) {
        const cap = _buildCapabilityReport();
        await sendTelegramLong(cap);
        _pushTelegramHistory('assistant', cap.slice(0, 400));
        try { _activeChatProvider?.postSystemNote?.(`비서 → 텔레그램 (능력 요약)`, '💬'); } catch { /* ignore */ }
        return;
    }
    /* v2.89 — 진행 상태 introspection. "지금 뭐 해?" / "/status" / "큐" 류
       질문이면 디스패치 큐 + 현재 작업 즉시 답변. */
    const statusQ = /^\s*(\/status|지금\s*뭐\s*해|뭐\s*하고\s*있|작업\s*상태|큐\s*상태|현재\s*상태)/i;
    if (statusQ.test(userText)) {
        const status = _buildDispatchStatusReport();
        await sendTelegramLong(status);
        _pushTelegramHistory('assistant', status.slice(0, 400));
        try { _activeChatProvider?.postSystemNote?.(`비서 → 텔레그램 (진행 상태)`, '💬'); } catch { /* ignore */ }
        return;
    }

    /* Build Secretary's context: identity + calendar + schedule + recent
       agent activity. Keeps the call cheap (small model, low temp). */
    const today = new Date();
    const todayStr = today.toLocaleDateString('ko-KR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    let ctxBlock = `\n\n[현재 시각]\n${today.toLocaleString('ko-KR')} (${todayStr})`;
    try {
        const dir = getCompanyDir();
        const cal = _safeReadText(path.join(dir, '_shared', 'calendar_cache.md'));
        const sch = _safeReadText(path.join(dir, '_shared', 'schedule.md'));
        const id  = _safeReadText(path.join(dir, '_shared', 'identity.md'));
        const dec = _safeReadText(path.join(dir, '_shared', 'decisions.md'));
        if (id.trim())  ctxBlock += `\n\n[회사 정체성]\n${id.slice(0, 800)}`;
        if (cal.trim()) ctxBlock += `\n\n[다가오는 일정 (Google Calendar)]\n${cal.slice(0, 1200)}`;
        if (sch.trim()) ctxBlock += `\n\n[통합 스케줄]\n${sch.slice(0, 1200)}`;
        /* Tracker — lets Secretary answer "에이전트 뭐하고있어?" / "지금 뭐 하고
           있어?" without dispatching. The list is the canonical "what is the
           company doing right now" view. */
        try {
            const trackerMd = trackerToMarkdown({ onlyOpen: true, max: 12 });
            if (trackerMd) ctxBlock += `\n\n[지금 진행 중인 작업 (추적기)]\n${trackerMd.slice(0, 1500)}`;
        } catch { /* ignore */ }
        /* Recent CEO decisions — last 1500 chars of the decisions log gives
           Secretary enough to answer "최근에 뭐 결정했어?" / "어제 뭐 했어?". */
        if (dec.trim()) ctxBlock += `\n\n[최근 의사결정 로그]\n${dec.slice(-1500)}`;
        /* Recent session reports — give Secretary a quick view of the last
           few completed dispatches so it can summarize "에이전트 최근 결과물" without
           re-dispatching. Cheap: just read filenames + first 200 chars. */
        try {
            const sessDir = path.join(dir, 'sessions');
            const sessions = fs.readdirSync(sessDir)
                .filter(n => !n.startsWith('.'))
                .sort()
                .slice(-3);
            if (sessions.length > 0) {
                const lines: string[] = [];
                for (const s of sessions) {
                    const reportPath = path.join(sessDir, s, '_report.md');
                    const txt = _safeReadText(reportPath);
                    if (txt.trim()) lines.push(`• ${s}: ${txt.slice(0, 160).replace(/\s+/g, ' ').trim()}…`);
                }
                if (lines.length > 0) ctxBlock += `\n\n[최근 완료된 세션 보고서]\n${lines.join('\n')}`;
            }
        } catch { /* ignore — no sessions yet */ }
    } catch { /* ignore */ }
    if (isCalendarWriteConnected()) {
        ctxBlock += `\n\n[캘린더 연결 상태] ✅ Google Calendar 쓰기 연결됨 — calendar_create/list/delete/update 모드 사용 가능`;
    } else {
        ctxBlock += `\n\n[캘린더 연결 상태] ❌ 미연결 — calendar_* 모드 사용 시 mode='reply'로 "Google Calendar 연결이 필요해요(명령 팔레트 → '회사 GitHub 연결' 옆 'Google Calendar 자동 일정 연결')"라고 알려주세요`;
    }
    /* Short-term Telegram history — gives Secretary context for follow-ups
       like "그거 4시로 바꿔줘". Capped to last 8 turns within the past 4
       hours (helper enforces both). */
    const historyBlock = _renderTelegramHistory(8);
    if (historyBlock) {
        ctxBlock += `\n\n[최근 텔레그램 대화 (참조용)]\n${historyBlock}\n\n_사용자가 "그거"·"방금 그 일정"·"그 회의" 라고 하면 위 대화에서 어떤 일정/주제인지 찾아서 처리하세요._`;
    }
    /* Company-wide conversation log — same source CEO planner reads. Captures
       sidebar dialogues, autonomous agent chatter, dispatch results. Lets
       Secretary answer cross-channel follow-ups like "developer가 사이트 어떻게
       하고 있어?" without re-dispatching. Conservative size (1500 chars) to
       avoid blowing past LM Studio's default context window. */
    const companyLog = readRecentConversations(1500);
    if (companyLog && companyLog.trim()) {
        ctxBlock += companyLog;
    }

    let raw = '';
    try {
        /* 800 (was 500) — calendar_create with description + location can blow
           past 500 and arrive truncated. Truncated JSON has no balanced close
           brace, defeats the parser, and leaks raw `{"mode":...` to the user. */
        raw = await _quickLLMCall(SECRETARY_TELEGRAM_PROMPT + ctxBlock, userText, 800);
    } catch (e: any) {
        await sendTelegramReport(`⚠️ 비서가 응답하지 못했어요: ${e?.message || e}`);
        return;
    }
    const parsed = _extractFirstJsonObject(raw);
    if (!parsed || typeof parsed.mode !== 'string') {
        /* Try one rescue pass — small models often emit a truncated JSON whose
           `text` field is recoverable even without a closing brace. */
        const textM = raw.match(/"text"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
        const rescuedText = textM ? textM[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').trim() : '';
        if (rescuedText) {
            await sendTelegramLong(`💬 *비서*: ${rescuedText.slice(0, 1500)}`);
            try { _activeChatProvider?.postSystemNote?.(`비서 → 텔레그램 (JSON 복구): ${rescuedText.slice(0, 300)}`, '💬'); } catch { /* ignore */ }
            return;
        }
        /* Fallback — aggressively strip from the first { onward (handles both
           balanced and unclosed JSON) so the user never sees raw mode/text
           markup. If nothing remains, ask the user to retry. */
        const clean = raw
            .replace(/```[\s\S]*?```/g, '')   // code fences first
            .replace(/\{[\s\S]*$/, '')         // open brace → EOF (catches truncation)
            .trim();
        if (!clean) {
            await sendTelegramReport(`💬 비서: 잠깐, 모델이 답변을 끝내지 못했어요. 다시 한 번 말씀해주실 수 있나요?`);
            return;
        }
        const fallbackMsg = clean.slice(0, 600);
        await sendTelegramReport(`💬 비서: ${fallbackMsg}`);
        try { _activeChatProvider?.postSystemNote?.(`비서 → 텔레그램: ${fallbackMsg.slice(0, 300)}`, '💬'); } catch { /* ignore */ }
        return;
    }

    const replyText = (typeof parsed.text === 'string' ? parsed.text : '').trim().slice(0, 3500);
    const mode = parsed.mode;

    /* Tracker — Secretary may flag this message as a trackable commitment. */
    let trackedId = '';
    try {
        const tt = parsed.track_task;
        if (tt && typeof tt === 'object' && typeof tt.title === 'string' && tt.title.trim()) {
            const owner = (tt.owner === 'user' || tt.owner === 'mixed') ? tt.owner : 'agent';
            const due = (typeof tt.due === 'string' && /^\d{4}-\d{2}-\d{2}/.test(tt.due)) ? tt.due : undefined;
            const task = addTrackerTask({
                title: tt.title.trim(),
                owner,
                dueAt: due,
                description: userText.slice(0, 400),
                status: owner === 'agent' ? 'in_progress' : 'pending',
            });
            trackedId = task.id;
        }
    } catch { /* ignore */ }
    const trailer = trackedId ? `\n\n_📋 추적: \`${trackedId.slice(-9)}\`_` : '';

    /* ── Calendar actions: Secretary acts directly ─────────────────── */
    if (mode === 'calendar_create') {
        const ev = parsed.event;
        if (!isCalendarWriteConnected()) {
            await sendTelegramReport(`⚠️ Google Calendar가 연결되지 않았어요.\n\n*명령 팔레트* → "Agent OS: Google Calendar 자동 일정 연결" 로 먼저 셋업해주세요.`);
            return;
        }
        if (!ev || typeof ev.title !== 'string' || typeof ev.start !== 'string') {
            await sendTelegramReport(`💬 *비서*: ${replyText || '일정 정보가 부족해요. 시작 시각과 제목을 다시 알려주세요.'}`);
            return;
        }
        const dur = (typeof ev.duration_minutes === 'number' && ev.duration_minutes > 0) ? ev.duration_minutes : 60;
        const startDate = new Date(ev.start);
        if (isNaN(startDate.getTime())) {
            await sendTelegramReport(`⚠️ 시작 시각 해석 실패: \`${ev.start}\`. 다시 알려주세요.`);
            return;
        }
        const endDate = new Date(startDate.getTime() + dur * 60_000);
        const created = await createCalendarEventDirect({
            title: ev.title.trim(),
            startIso: startDate.toISOString(),
            endIso: endDate.toISOString(),
            description: typeof ev.description === 'string' ? ev.description : undefined,
            location: typeof ev.location === 'string' ? ev.location : undefined,
        });
        if (!created) {
            await sendTelegramReport(`❌ 캘린더 일정 생성 실패. 토큰이 만료됐을 수 있어요. 명령 팔레트 → "Google Calendar 자동 일정 연결" 재실행해주세요.`);
            return;
        }
        const fmt = (d: Date) => d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit' });
        const link = created.htmlLink ? `\n\n[🔗 캘린더에서 보기](${created.htmlLink})` : '';
        const confirmMsg = replyText || `📅 일정 추가됨\n*${ev.title}*\n${fmt(startDate)} – ${fmt(endDate)}`;
        await sendTelegramLong(`💬 *비서*: ${confirmMsg}${link}${trailer}`);
        _pushTelegramHistory('assistant', `일정 추가됨: ${ev.title} (${fmt(startDate)} – ${fmt(endDate)})`);
        try { _activeChatProvider?.postSystemNote?.(`비서 → 캘린더: "${ev.title}" ${fmt(startDate)}`, '📅'); } catch { /* ignore */ }
        /* Refresh local cache so other agents see the new event */
        refreshCalendarCacheViaOAuth(14).catch(() => { /* silent */ });
        return;
    }
    if (mode === 'calendar_list') {
        if (!isCalendarWriteConnected()) {
            /* Fall back to cached calendar if OAuth not connected */
            const cal = _safeReadText(path.join(getCompanyDir(), '_shared', 'calendar_cache.md')).trim();
            const body = cal ? cal.split('\n').slice(0, 30).join('\n') : '_캘린더 정보가 없어요. Google Calendar 연결 또는 iCal 도구 셋업이 필요해요._';
            await sendTelegramLong(`💬 *비서 — 일정*\n\n${body}`);
            return;
        }
        const days = (typeof parsed.days_ahead === 'number' && parsed.days_ahead > 0) ? Math.min(60, parsed.days_ahead) : 7;
        const events = await findCalendarEvents({ daysAhead: days });
        if (events.length === 0) {
            await sendTelegramReport(`💬 *비서*: 향후 ${days}일 안에 잡힌 일정이 없어요. ${replyText}`);
            return;
        }
        const fmt = (s: string) => {
            try {
                const d = new Date(s);
                return d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit' });
            } catch { return s; }
        };
        const list = events.map(e => `• *${fmt(e.startIso)}* — ${e.title}`).join('\n');
        await sendTelegramLong(`💬 *비서 — 향후 ${days}일 일정*\n\n${list}${replyText ? `\n\n${replyText}` : ''}`);
        /* Compact summary for history — keeps "그 일정" references resolvable
           without dumping the full list into every subsequent prompt. */
        const histSummary = events.slice(0, 5).map(e => `${e.title} (${fmt(e.startIso)})`).join(', ');
        _pushTelegramHistory('assistant', `향후 ${days}일 일정: ${histSummary}${events.length > 5 ? ' 외 ' + (events.length - 5) + '건' : ''}`);
        try { _activeChatProvider?.postSystemNote?.(`비서 → 캘린더 조회 (${events.length}건)`, '📅'); } catch { /* ignore */ }
        return;
    }
    if (mode === 'calendar_delete') {
        if (!isCalendarWriteConnected()) {
            await sendTelegramReport(`⚠️ Google Calendar가 연결되지 않았어요.`);
            return;
        }
        const query = typeof parsed.query === 'string' ? parsed.query.trim() : '';
        /* 30일 기본값으로 확장 — "여자 들어간 일정 다 취소" 같은 벌크 명령은
           오늘만이 아니라 향후 1달치를 다 잡아야 자연스러움. 단일 매칭 케이스는
           원래도 days_ahead를 LLM이 작게 보냈으니 영향 없음. */
        const days = (typeof parsed.days_ahead === 'number' && parsed.days_ahead > 0) ? Math.min(60, parsed.days_ahead) : 30;
        const deleteAll = parsed.delete_all === true;
        const matches = await findCalendarEvents({ query, daysAhead: days });
        if (matches.length === 0) {
            await sendTelegramReport(`💬 *비서*: \`${query || '(검색어 없음)'}\` 일치하는 일정을 못 찾았어요.`);
            return;
        }
        const fmt = (s: string) => { try { return new Date(s).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return s; } };
        /* 벌크 삭제 — 사용자가 "모두/전부/다" 명시한 경우. LLM이 delete_all=true로
           세팅. 매칭된 일정 전부 순차 삭제 후 결과 요약. */
        if (deleteAll) {
            let ok = 0, fail = 0;
            const okTitles: string[] = [];
            const failTitles: string[] = [];
            for (const ev of matches) {
                const r = await deleteCalendarEvent(ev.eventId);
                if (r) { ok++; okTitles.push(`✖️ ${ev.title} (${fmt(ev.startIso)})`); }
                else   { fail++; failTitles.push(`⚠️ ${ev.title} (${fmt(ev.startIso)})`); }
            }
            const okBlock = okTitles.length ? okTitles.join('\n') : '_없음_';
            const failBlock = failTitles.length ? `\n\n*실패 ${fail}건*\n${failTitles.join('\n')}` : '';
            const headline = fail === 0
                ? `💬 *비서*: ✖️ \`${query}\` 일치 ${ok}건 모두 취소됨`
                : `💬 *비서*: \`${query}\` 일치 ${matches.length}건 중 ${ok}건 취소`;
            await sendTelegramLong(`${headline}\n\n${okBlock}${failBlock}`);
            _pushTelegramHistory('assistant', `${ok}건 취소됨 (${query}). ${fail > 0 ? fail + '건 실패.' : ''}`);
            try { _activeChatProvider?.postSystemNote?.(`비서 → 캘린더 벌크 취소: "${query}" ${ok}/${matches.length}건`, '🗑️'); } catch { /* ignore */ }
            refreshCalendarCacheViaOAuth(30).catch(() => { /* silent */ });
            return;
        }
        if (matches.length > 1) {
            const list = matches.map((e, i) => `${i + 1}. *${fmt(e.startIso)}* — ${e.title}`).join('\n');
            await sendTelegramLong(`💬 *비서*: ${matches.length}개가 일치해요. 어떻게 할까요?\n\n${list}\n\n_• 모두 취소하려면: "모두 삭제" 또는 "다 취소"_\n_• 하나만 취소하려면: 더 구체적인 제목으로 알려주세요_`);
            _pushTelegramHistory('assistant', `${matches.length}건 매칭. 모두 삭제 또는 더 구체적 지시 대기.`);
            return;
        }
        const ev = matches[0];
        const ok = await deleteCalendarEvent(ev.eventId);
        if (!ok) {
            await sendTelegramReport(`❌ 일정 취소 실패. 권한이 없거나 이미 삭제됐을 수 있어요.`);
            return;
        }
        const cancelMsg = `💬 *비서*: ✖️ 취소됨 — *${ev.title}* (${fmt(ev.startIso)})${replyText ? `\n\n${replyText}` : ''}`;
        await sendTelegramLong(cancelMsg);
        _pushTelegramHistory('assistant', `취소됨 — ${ev.title} (${fmt(ev.startIso)}). ${replyText}`);
        try { _activeChatProvider?.postSystemNote?.(`비서 → 캘린더 취소: "${ev.title}"`, '🗑️'); } catch { /* ignore */ }
        refreshCalendarCacheViaOAuth(14).catch(() => { /* silent */ });
        return;
    }
    if (mode === 'calendar_update') {
        if (!isCalendarWriteConnected()) {
            await sendTelegramReport(`⚠️ Google Calendar가 연결되지 않았어요.`);
            return;
        }
        const query = typeof parsed.query === 'string' ? parsed.query.trim() : '';
        const days = (typeof parsed.days_ahead === 'number' && parsed.days_ahead > 0) ? Math.min(60, parsed.days_ahead) : 7;
        const patch = (parsed.patch && typeof parsed.patch === 'object') ? parsed.patch : {};
        if (!patch.start && !patch.duration_minutes && !patch.title) {
            await sendTelegramReport(`💬 *비서*: 뭘 바꿀지 알려주세요 (시간/길이/제목 중 하나 이상).`);
            return;
        }
        const matches = await findCalendarEvents({ query, daysAhead: days });
        if (matches.length === 0) {
            await sendTelegramReport(`💬 *비서*: \`${query || '(검색어 없음)'}\` 일치하는 일정을 못 찾았어요.`);
            return;
        }
        if (matches.length > 1) {
            const fmt = (s: string) => { try { return new Date(s).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return s; } };
            const list = matches.map((e, i) => `${i + 1}. *${fmt(e.startIso)}* — ${e.title}`).join('\n');
            await sendTelegramLong(`💬 *비서*: 여러 개가 일치해요. 어느 걸 바꿀까요?\n\n${list}\n\n_제목을 더 구체적으로 알려주세요._`);
            return;
        }
        const ev = matches[0];
        /* Compute new start/end from patch fields, falling back to current. */
        let newStartIso: string | undefined;
        let newEndIso: string | undefined;
        const currentStart = new Date(ev.startIso);
        const currentEnd = ev.endIso ? new Date(ev.endIso) : new Date(currentStart.getTime() + 60 * 60_000);
        const currentDurMin = Math.max(15, Math.round((currentEnd.getTime() - currentStart.getTime()) / 60_000));
        if (typeof patch.start === 'string') {
            const s = new Date(patch.start);
            if (isNaN(s.getTime())) {
                await sendTelegramReport(`⚠️ 새 시작 시각 해석 실패: \`${patch.start}\`. 다시 알려주세요.`);
                return;
            }
            newStartIso = s.toISOString();
            const dur = (typeof patch.duration_minutes === 'number' && patch.duration_minutes > 0) ? patch.duration_minutes : currentDurMin;
            newEndIso = new Date(s.getTime() + dur * 60_000).toISOString();
        } else if (typeof patch.duration_minutes === 'number' && patch.duration_minutes > 0) {
            /* Only duration changed — keep start, recompute end */
            newEndIso = new Date(currentStart.getTime() + patch.duration_minutes * 60_000).toISOString();
        }
        const newTitle = (typeof patch.title === 'string' && patch.title.trim()) ? patch.title.trim() : undefined;
        const updated = await patchCalendarEvent(ev.eventId, {
            title: newTitle,
            startIso: newStartIso,
            endIso: newEndIso,
        });
        if (!updated) {
            await sendTelegramReport(`❌ 일정 수정 실패. 권한이 없거나 이미 삭제됐을 수 있어요.`);
            return;
        }
        const fmt = (s: string) => { try { return new Date(s).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return s; } };
        const finalTitle = newTitle || ev.title;
        const link = updated.htmlLink ? `\n\n[🔗 캘린더에서 보기](${updated.htmlLink})` : '';
        const confirmMsg = replyText || `📅 *${finalTitle}* 수정됨 — ${fmt(updated.startIso || newStartIso || ev.startIso)}${updated.endIso ? ` ~ ${fmt(updated.endIso)}` : ''}`;
        await sendTelegramLong(`💬 *비서*: ${confirmMsg}${link}${trailer}`);
        _pushTelegramHistory('assistant', `${finalTitle} 수정됨 (${fmt(updated.startIso || ev.startIso)})`);
        try { _activeChatProvider?.postSystemNote?.(`비서 → 캘린더 수정: "${finalTitle}" ${fmt(updated.startIso || ev.startIso)}`, '✏️'); } catch { /* ignore */ }
        refreshCalendarCacheViaOAuth(14).catch(() => { /* silent */ });
        return;
    }

    /* ── Existing reply / dispatch / ask paths ─────────────────────── */
    if (mode === 'dispatch') {
        await sendTelegramReport(`📨 *비서 → CEO*\n\n${replyText || '작업을 분배할게요'}${trailer}`);
        _pushTelegramHistory('assistant', `(CEO에게 전달) ${replyText || '작업을 분배할게요'}`);
        try { _activeChatProvider?.postSystemNote?.(`비서 → CEO 전달: ${replyText.slice(0, 300)}`, '📨'); } catch { /* ignore */ }
        const dispatchInstr = String(parsed.dispatch_to_ceo || userText).slice(0, 1500);
        /* corporate:true 추가 — _handleCorporatePrompt를 직접 호출해서 진짜
           멀티 에이전트 디스패치 발동. 이전엔 webview를 거쳐서 단일 LLM
           응답으로만 흘러서 "전달 완료"만 답하고 실제 작업 안 함. */
        try { _activeChatProvider?.sendPromptFromExtension?.(dispatchInstr, { fromTelegram: true, corporate: true }); } catch { /* ignore */ }
    } else if (mode === 'ask') {
        await sendTelegramLong(`💬 *비서*: ${replyText}`);
        _pushTelegramHistory('assistant', replyText);
        try { _activeChatProvider?.postSystemNote?.(`비서 → 텔레그램: ${replyText.slice(0, 300)}`, '💬'); } catch { /* ignore */ }
    } else {
        if (!replyText) {
            await sendTelegramReport(`💬 비서: 한 번 더 말씀해주실 수 있나요? 답변을 만들지 못했어요.`);
            return;
        }
        await sendTelegramLong(`💬 *비서*: ${replyText}${trailer}`);
        _pushTelegramHistory('assistant', replyText);
        try { _activeChatProvider?.postSystemNote?.(`비서 → 텔레그램: ${replyText.slice(0, 300)}`, '💬'); } catch { /* ignore */ }
    }
}
