/**
 * Brain ↔ tooling glue — adapters between the agent disk layout
 * (`_agents/<id>/...`) and the broader system (LLM, tracker, conversation
 * log, brain RAG, prompt assembly).
 *
 * These functions all touch agent-specific state on disk:
 *   - per-agent memory.md / goal.md / skills/ / verified.md / self_rag_criteria.md
 *   - the specialist system prompt assembly
 *   - runtime credential probing + Python prefetch
 *   - cross-cuts into tracker (autoMarkTrackerFromDispatch),
 *     conversation log (_getLastSpecialistOutput),
 *     and brain knowledge routing (routeBrainInjectionToAgents).
 *
 * Extracted from src/extension.ts. The functions assume the wrappers
 * (`readCompanyName`, `getConversationsDir`, `readTelegramConfig`, …)
 * still live in extension.ts — they were already exported there in
 * prior cycles.
 *
 * Cross-module dependencies pulled from '../extension':
 *   - `_quickLLMCall` (already wrapped — could pull from '../telegram' too)
 *   - `readTracker`, `updateTrackerTask` (tracker wrappers)
 *   - `getConversationsDir` (conversation-log wrapper)
 *   - `readTelegramConfig`, `isCalendarWriteConnected` (creds probes)
 *   - `readCompanyName`, `isCompanyConfigured` (company identity)
 *   - `_agentKeywords`, `_scoreRelevance` (RAG scorers; still in extension.ts)
 *   - `runCommandCaptured`, `_pythonCmd` (re-exported via '../infra/*')
 *
 * Other deps already barrelled in their own modules:
 *   - `AGENTS`, `AGENT_ORDER`, `SPECIALIST_IDS` from '../agents'
 *   - `getCompanyDir`, `_getBrainDir` from '../paths'
 *   - `isYoutubeOAuthConnected` from '../youtube'
 *   - `readAgentVerifiedKnowledge` from './agent-context' (sibling — local relative)
 *   - `SKILL_DISTILL_PROMPT` from '../prompts'
 */

import * as fs from 'fs';
import * as path from 'path';

import { AGENTS, AGENT_ORDER, SPECIALIST_IDS } from '../agents';
import { getCompanyDir, _getBrainDir } from '../paths';
import { isYoutubeOAuthConnected } from '../youtube';
import { readAgentVerifiedKnowledge } from './agent-context';
import { SKILL_DISTILL_PROMPT } from '../prompts';
import { runCommandCaptured } from '../infra/process';
import { pythonCmd as _pythonCmd } from '../infra/python';
import {
  _quickLLMCall,
  readTracker,
  updateTrackerTask,
  getConversationsDir,
  readTelegramConfig,
  isCalendarWriteConnected,
  readCompanyName,
  isCompanyConfigured,
} from '../extension';
import { _agentKeywords, _scoreRelevance } from './keywords';

export function appendAgentMemory(agentId: string, line: string) {
  try {
    const p = path.join(getCompanyDir(), '_agents', agentId, 'memory.md');
    const stamp = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(p, `\n- [${stamp}] ${line.replace(/\n/g, ' ').slice(0, 300)}`);
    /* memory.md 가 100줄·30KB 초과 시 오래된 50% 자동 정리 — 무한 누적 차단.
       OAuth/credentials-blocked 등 시스템 이벤트 경로도 동일하게 trim 적용. */
    try {
      const mem = require('../dispatch/agent-memory');
      mem.trimMemoryFile(p);
    } catch { /* trim 실패해도 append 자체 깨뜨리지 않음 */ }
  } catch { /* ignore */ }
}

/** Find the most recent specialist output in today's conversation log.
 *  Returns the agent id + body so the user can say `/skill` and we know
 *  whose skills/ to save into. Falls back to yesterday if today has none. */
export function _getLastSpecialistOutput(): { agentId: string; agentName: string; body: string } | null {
  try {
    const convDir = getConversationsDir();
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    /* Index agent name → id for reverse lookup. Skip CEO (planner role,
       not a specialist whose patterns we'd reuse). */
    const nameToId = new Map<string, string>();
    for (const id of SPECIALIST_IDS) {
      const a = AGENTS[id];
      if (!a) continue;
      nameToId.set(a.name, id);
    }
    for (const day of [today, yesterday]) {
      const f = path.join(convDir, `${day}.md`);
      if (!fs.existsSync(f)) continue;
      let txt = '';
      try { txt = fs.readFileSync(f, 'utf-8'); } catch { continue; }
      /* Conversation entries are blocks like:
           ## [HH:MM:SS] {emoji} **{speaker}** · _{section}_

           {body}
         Walk from the end backward and grab the most recent one whose
         speaker matches a specialist name. */
      const headerRe = /\n##\s+\[\d{2}:\d{2}:\d{2}\][^\n]*\*\*([^*]+)\*\*[^\n]*\n([\s\S]*?)(?=\n##\s+\[|$)/g;
      const matches: Array<{ name: string; body: string }> = [];
      let m: RegExpExecArray | null;
      while ((m = headerRe.exec(txt)) !== null) {
        matches.push({ name: m[1].trim(), body: m[2].trim() });
      }
      for (let i = matches.length - 1; i >= 0; i--) {
        const id = nameToId.get(matches[i].name);
        if (id && matches[i].body.length >= 80) {
          return { agentId: id, agentName: matches[i].name, body: matches[i].body };
        }
      }
    }
  } catch { /* fall through */ }
  return null;
}

function _slugifySkill(title: string): string {
  /* Keep Hangul / latin / digits, collapse the rest into '-'. Filenames are
     fine on macOS/Linux/Windows with Hangul; we don't transliterate. */
  let s = title.toLowerCase().replace(/^#+\s*/, '').trim();
  s = s.replace(/[\\/:*?"<>|]/g, ' ');
  s = s.replace(/\s+/g, '-');
  s = s.replace(/-+/g, '-');
  s = s.replace(/^-+|-+$/g, '');
  return s.slice(0, 60) || `skill-${Date.now()}`;
}

/** Distill `sourceText` into a reusable skill markdown and save it under
 *  `_agents/{agentId}/skills/<slug>.md`. Returns the saved path or an error.
 *  Uses _quickLLMCall — same lightweight path as Secretary classification. */
export async function saveAgentSkill(
  agentId: string,
  sourceText: string,
  opts?: { titleHint?: string }
): Promise<{ ok: true; path: string; title: string } | { ok: false; reason: string }> {
  const a = AGENTS[agentId];
  if (!a) return { ok: false, reason: `알 수 없는 에이전트: ${agentId}` };
  const trimmed = (sourceText || '').trim();
  if (trimmed.length < 80) return { ok: false, reason: '산출물이 너무 짧아 패턴화할 가치가 부족해요.' };
  const userBlock = (opts?.titleHint ? `[힌트] ${opts.titleHint}\n\n` : '') + `[산출물]\n${trimmed.slice(0, 4000)}`;
  let raw = '';
  try {
    raw = await _quickLLMCall(SKILL_DISTILL_PROMPT, userBlock, 600);
  } catch (e: any) {
    return { ok: false, reason: `LLM 호출 실패: ${e?.message || e}` };
  }
  let body = (raw || '').trim();
  /* Strip code fences if the model wrapped the markdown despite instructions */
  body = body.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```\s*$/, '').trim();
  if (!body) return { ok: false, reason: '큐레이터 LLM이 응답하지 못했어요.' };
  const firstLine = body.split('\n')[0].trim();
  if (/^#\s*SKIP/i.test(firstLine)) {
    return { ok: false, reason: '큐레이터 판단: 재사용 가치가 부족해 저장하지 않았어요.' };
  }
  if (!firstLine.startsWith('#')) {
    /* Force a heading so downstream display stays consistent */
    body = `# ${opts?.titleHint?.slice(0, 60) || '미정 스킬'}\n\n${body}`;
  }
  const title = body.split('\n')[0].replace(/^#+\s*/, '').trim();
  const slug = _slugifySkill(title);
  const skillsDir = path.join(getCompanyDir(), '_agents', agentId, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  let outPath = path.join(skillsDir, `${slug}.md`);
  /* Avoid collisions — append a short stamp if file exists */
  if (fs.existsSync(outPath)) {
    const stamp = new Date().toISOString().slice(5, 10).replace('-', '');
    outPath = path.join(skillsDir, `${slug}-${stamp}.md`);
  }
  const stamped = `${body}\n\n---\n_저장: ${new Date().toLocaleString('ko-KR')} · 출처: 직전 ${a.name} 산출물_\n`;
  try { fs.writeFileSync(outPath, stamped); }
  catch (e: any) { return { ok: false, reason: `파일 저장 실패: ${e?.message || e}` }; }
  return { ok: true, path: outPath, title };
}

/* ── Self-RAG verified knowledge store ────────────────────────────────────
   memory.md is the firehose (everything happens, including [추측]). When
   Self-RAG is ON for an agent, we parse its output for `[근거: source]`
   patterns and promote those claims into a curated `verified.md` next to
   memory.md. Future cycles preferentially retrieve from verified.md so the
   agent works off claims it has already self-grounded — not from raw
   speculation. */
function appendAgentVerifiedKnowledge(agentId: string, claim: string, source: string) {
  try {
    const dir = path.join(getCompanyDir(), '_agents', agentId);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'verified.md');
    if (!fs.existsSync(p)) {
      const a = AGENTS[agentId];
      const header = `# ${a?.emoji || '✓'} ${a?.name || agentId} — 검증된 지식

_Self-RAG가 출력에서 \`[근거: ...]\` 태그가 붙은 주장만 자동 승격해서 누적._
_여기 들어온 내용만 다음 사이클의 retrieval 우선순위에 들어갑니다._
_사용자가 직접 줄을 지우면 그 주장은 다시 미검증 상태로 돌아갑니다._

`;
      fs.writeFileSync(p, header);
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const oneLine = (claim || '').replace(/\n/g, ' ').slice(0, 360);
    const src = (source || '').replace(/\n/g, ' ').slice(0, 120);
    fs.appendFileSync(p, `\n- [${stamp}] ${oneLine} _(근거: ${src})_`);
  } catch { /* ignore */ }
}

export function countAgentVerifiedClaims(agentId: string): number {
  try {
    const txt = readAgentVerifiedKnowledge(agentId);
    if (!txt) return 0;
    return (txt.match(/^\s*-\s*\[\d{4}-\d{2}-\d{2}\]/gm) || []).length;
  } catch { return 0; }
}

/* Parse an agent's response text for [근거: source] grounded claims and
   promote each to verified.md. We capture the WHOLE LINE (or a meaningful
   slice) containing the tag, plus the source label inside the brackets. */
export function promoteGroundedClaimsFromOutput(agentId: string, output: string): number {
  if (!output) return 0;
  /* Match lines that contain [근거: ...] anywhere. Grab the entire line for
     context, and pull the source out of the brackets. */
  const lines = output.split('\n');
  const tagRe = /\[\s*근거\s*[:：]\s*([^\]\n]+?)\s*\]/;
  let promoted = 0;
  for (const raw of lines) {
    const ln = raw.trim();
    if (!ln) continue;
    const m = ln.match(tagRe);
    if (!m) continue;
    /* Strip the [근거: ...] tag from the claim text so verified.md doesn't
       echo the bracket — we already have the source as a separate field. */
    const claim = ln.replace(tagRe, '').replace(/\s{2,}/g, ' ').trim();
    if (claim.length < 4) continue; /* skip degenerate matches */
    appendAgentVerifiedKnowledge(agentId, claim, m[1].trim());
    promoted++;
    if (promoted >= 12) break; /* sanity cap per output */
  }
  return promoted;
}

/* When the user injects a file into the brain (⚡ button), score it against
   each agent's specialty and append a memory line to the top matches. The
   raw file lives at <brain>/00_Raw/<date>/<name>; agents now know "new
   knowledge inbound" without us having to wait for them to scan the brain
   folder on next cycle. Returns the agent IDs that received an entry. */
export function routeBrainInjectionToAgents(filePath: string, fileName: string): string[] {
  if (!isCompanyConfigured()) return [];
  let raw = '';
  try {
    const st = fs.statSync(filePath);
    if (st.size > 80_000) return []; /* don't try to summarize giant files */
    raw = fs.readFileSync(filePath, 'utf-8').slice(0, 8000);
  } catch { return []; }
  if (!raw.trim()) return [];

  /* Best-of: score the file against every specialist. Pick top 2 above
     a threshold — narrow enough to avoid spamming everyone. */
  type Match = { id: string; score: number };
  const matches: Match[] = [];
  for (const id of SPECIALIST_IDS) {
    const kws = _agentKeywords(id);
    const score = _scoreRelevance(raw + ' ' + fileName, kws);
    if (score >= 2) matches.push({ id, score });
  }
  matches.sort((a, b) => b.score - a.score);
  const winners = matches.slice(0, 2).map(m => m.id);

  /* Always tell CEO too — CEO needs to know new knowledge arrived even if
     it doesn't match a specialist cleanly. */
  const recipients = Array.from(new Set(['ceo', ...winners]));

  /* Build the one-line summary: title (first H1) + first 140 chars of
     the first non-heading paragraph, or just the filename + first chunk. */
  const h1 = raw.match(/^#\s+(.+?)\s*$/m);
  const title = (h1 && h1[1] ? h1[1].trim() : fileName).slice(0, 80);
  const body = raw
    .replace(/^---[\s\S]*?---\n/, '')
    .split('\n')
    .find(ln => ln.trim() && !ln.trim().startsWith('#') && !ln.trim().startsWith('---'))
    || raw.replace(/\s+/g, ' ').slice(0, 200);
  const blurb = body.replace(/\s+/g, ' ').trim().slice(0, 160);
  /* Source path is relative to brain root (where 00_Raw/ etc. live),
     not the company subdir — keeps the citation human-readable. */
  const rel = path.relative(_getBrainDir(), filePath);

  const line = `📥 새 지식 입수 — **${title}**: ${blurb} (출처: ${rel})`;
  for (const id of recipients) {
    appendAgentMemory(id, line);
  }
  return recipients;
}

export function readAgentGoal(agentId: string): string {
  try {
    const p = path.join(getCompanyDir(), '_agents', agentId, 'goal.md');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
  } catch { return ''; }
}

export function writeAgentGoal(agentId: string, content: string) {
  const dir = path.join(getCompanyDir(), '_agents', agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'goal.md'), content);
}

export function writeAgentSelfRagCriteria(agentId: string, content: string) {
  const dir = path.join(getCompanyDir(), '_agents', agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'self_rag_criteria.md'), (content || '').slice(0, 4000));
}

/* Heuristic: from a finished CEO dispatch (plan + outputs), find
   matching open tracker tasks (created within last 5 min by Secretary
   for THIS user request) and mark them done. Avoids LLM round-trip. */
export function autoMarkTrackerFromDispatch(plan: { brief?: string; tasks?: { agent: string; task: string }[] } | null, sessionDir: string, ceoSynthesis: string) {
  try {
    if (!plan || !Array.isArray(plan.tasks)) return;
    const tracker = readTracker();
    const now = Date.now();
    /* 24h window — covers overnight/multi-step tasks. Original 10-min was
       too narrow: if user issued "이거 해" yesterday and CEO finishes today,
       the task would stay pending forever. */
    const fresh = tracker.tasks.filter(t =>
      t.status !== 'done' && t.status !== 'cancelled' &&
      (now - new Date(t.createdAt).getTime()) < 24 * 60 * 60_000
    );
    if (fresh.length === 0) return;
    /* For each fresh agent-owned task, mark first overlap done. */
    for (const ft of fresh) {
      if (ft.owner !== 'agent' && ft.owner !== 'mixed') continue;
      const evidence = `완료: sessions/${path.basename(sessionDir)}/_report.md\n` +
        plan.tasks.slice(0, 3).map(t => `- ${AGENTS[t.agent]?.name || t.agent}: ${t.task.slice(0, 80)}`).join('\n') +
        (ceoSynthesis ? `\n\nCEO 종합 요점: ${ceoSynthesis.slice(0, 200)}` : '');
      updateTrackerTask(ft.id, {
        status: 'done',
        sessionDir: path.basename(sessionDir),
        evidence,
      });
    }
  } catch { /* ignore */ }
}

/* v2.87.11 — 에이전트가 외부 API에 의존할 때, 자격증명이 없으면 그 사실을
   에이전트 본인이 알고 사용자에게 입력해달라고 응답해야 함. 이 함수가
   sysPrompt에 명시적인 config 상태 블록을 주입한다. 키가 비어있으면 강제로
   "사용자에게 입력 요청하세요" 지시 포함. */
/* v2.89.10 — 진짜 데이터 prefetch. LLM 호출 전 시스템이 직접 도구 실행해서
   결과를 컨텍스트로 강제 주입. 이전 패턴은 에이전트가 <run_command>를 자발적
   출력해야만 발동됐는데, 작은 LLM은 자주 안 함 → 거짓말 (placeholder 데이터)
   양산. 이제 prefetch 결과가 있으면 에이전트가 거짓말 못 함 — 진짜 숫자 보고
   답하거나 "데이터에 없음"이라고 솔직히 말하거나. */
export async function prefetchAgentRealtimeData(agentId: string): Promise<string> {
  /* v2.89.11 — 진짜 API 호출하는 도구 우선. 이전엔 youtube_account.py 호출했는데
     그건 설정 sanity-check만 출력하지 실제 채널 데이터 안 가져옴. my_videos_check.py
     가 진짜 YouTube API 호출해서 채널 영상·조회수·기준선 데이터 반환. */
  const candidates: Array<{ tool: string; label: string }> = [];
  if (agentId === 'youtube') {
    candidates.push({ tool: 'my_videos_check.py', label: 'YouTube 채널 영상 분석 (실제 API 데이터)' });
    candidates.push({ tool: 'youtube_account.py', label: 'YouTube 설정 확인 (fallback)' });
  }
  /* v2.89.136 — business prefetch. 제프베조스에게 매출 질문 들어오면 paypal_revenue.py
     자동 실행 → 거래 + 게임별 분류 + 환불·수수료 마크다운 컨텍스트로 주입 →
     제프베조스가 환각 없이 진짜 숫자로 분석. Instagram(박재범) 와 동일 패턴. */
  if (agentId === 'business') {
    candidates.push({ tool: 'paypal_revenue.py', label: 'PayPal 매출 분석 (게임·프로젝트별, 실제 거래 데이터)' });
  }
  if (candidates.length === 0) return '';
  const toolsDir = path.join(getCompanyDir(), '_agents', agentId, 'tools');
  if (!fs.existsSync(toolsDir)) return '';
  const blocks: string[] = [];
  let gotRealData = false;
  for (const c of candidates) {
    const scriptPath = path.join(toolsDir, c.tool);
    if (!fs.existsSync(scriptPath)) continue;
    /* 첫 도구가 성공하면 fallback 도구는 건너뜀 (이미 진짜 데이터 확보) */
    if (gotRealData) break;
    try {
      const r = await new Promise<{ exitCode: number; output: string; timedOut: boolean }>((resolve) => {
        runCommandCaptured(`${_pythonCmd()} ${JSON.stringify(c.tool)}`, toolsDir, () => { /* silent */ }, 90000)
          .then(resolve)
          .catch(() => resolve({ exitCode: -1, output: '', timedOut: false }));
      });
      const out = (r.output || '').trim();
      if (r.exitCode === 0 && out) {
        blocks.push(`### ${c.label}\n\`\`\`\n${out.slice(0, 5000)}\n\`\`\``);
        gotRealData = true;
      } else if (out) {
        /* exit code != 0 but has output — usually error message worth surfacing */
        blocks.push(`### ${c.label} _(exit ${r.exitCode}${r.timedOut ? ', 시간 초과' : ''})_\n\`\`\`\n${out.slice(0, 3000)}\n\`\`\``);
      } else {
        blocks.push(`### ${c.label}\n_(도구 실행 실패 — exit ${r.exitCode}${r.timedOut ? ', 시간 초과' : ''}, 출력 없음. Python·google-api-python-client 설치 확인 필요)_`);
      }
    } catch (err: any) {
      blocks.push(`### ${c.label}\n_(실행 에러: ${err?.message || err})_`);
    }
  }
  if (blocks.length === 0) return '';
  /* 진짜 데이터 확보 여부에 따라 강력한 지시 다르게 */
  const strictRule = gotRealData
    ? `⚠️ **위 데이터에 없는 숫자는 추측·생성 금지**. "[데이터 입력 필요]" 같은 placeholder 절대 금지. 빈 항목은 "이 지표는 사용 가능 데이터에 포함 안 됨"이라고 솔직히 표시.

🛑 **read_file·list_files 사용 금지 (실시간 데이터 이미 위에 있음)**:
위 [실시간 데이터] 블록에 진짜 매출/거래/숫자가 모두 포함돼 있음. README 또는 .md 문서 읽지 마세요 — 그건 사용법 안내일 뿐이고 실데이터 아님. 위 표·숫자를 그대로 인용해서 즉시 분석/액션 제안.

✅ **즉시 답변 패턴**:
1. 첫 줄: "사장님, 이번 달 매출 [정확한 금액] 입니다."
2. 핵심 인사이트 1~2개 (위 데이터에서 직접 인용)
3. 다음 액션 1개 (구체적, 실행 가능)
4. 마지막 자가평가 + 다음 단계 (필수)`
    : `🛑 **실시간 데이터 가져오기 실패** — 위 출력은 에러 메시지뿐. 사용자에게 정확히 무엇이 문제인지(Python 미설치? 패키지 미설치? API 키 미설정?) 알려주고, 가짜 분석·placeholder 데이터 절대 생성하지 마세요. 작업은 '대기' 평가로 끝내고 다음 단계는 사용자가 환경 셋업 후 재시도.`;
  return `\n\n[실시간 데이터 — 시스템이 방금 도구로 가져온 진짜 출력]\n\n${blocks.join('\n\n')}\n\n${strictRule}`;
}

export function buildAgentConfigStatus(agentId: string): string {
  const lines: string[] = [];
  if (agentId === 'youtube') {
    try {
      /* v2.89.18 — 캐노니컬 youtube_account.json 단일 출처. 이전엔 config.md를
         읽어서 외부 연결 패널·도구·에이전트 상태가 다른 데이터 보고 있었음. */
      const jsonPath = path.join(getCompanyDir(), '_agents', 'youtube', 'tools', 'youtube_account.json');
      let cfg: Record<string, any> = {};
      try {
        if (fs.existsSync(jsonPath)) cfg = JSON.parse(fs.readFileSync(jsonPath, 'utf-8') || '{}');
      } catch { /* malformed */ }
      const apiKey = String(cfg.YOUTUBE_API_KEY || '').trim();
      const channelId = String(cfg.MY_CHANNEL_ID || '').trim() || String(cfg.MY_CHANNEL_HANDLE || '').trim();
      const oauthOk = isYoutubeOAuthConnected();
      const missing: string[] = [];
      if (!apiKey) missing.push('YOUTUBE_API_KEY (구독자/조회수/영상 메타)');
      if (!channelId) missing.push('YOUTUBE_CHANNEL_ID (내 채널 식별자)');
      if (missing.length > 0) {
        lines.push(`\n\n[⚠️ 필수 자격증명 미설정]`);
        lines.push(`다음 정보가 비어있어 실제 분석이 불가능합니다:`);
        for (const m of missing) lines.push(`- ${m}`);
        lines.push('');
        lines.push(`[필수 응답 규칙]`);
        lines.push(`반드시 사용자에게 다음과 같이 안내하세요:`);
        lines.push(`> 📊 채널 분석을 하려면 YouTube API 키와 채널 ID가 필요해요. 헤더 우측 "👥 에이전트 업무 대시보드" 버튼 → YouTube 카드 ⚙️ 클릭 → API 키와 채널 ID 입력 후 다시 요청해주세요.`);
        lines.push(`추측이나 일반론으로 답하지 말고, 위 안내만 짧게 출력하세요. 작업은 미완료(📊 평가: 대기)로 표시.`);
      } else if (!oauthOk) {
        /* v2.89.8 — Analytics OAuth가 비연결인데 사용자가 시청 지속률 등을 요청하면,
           시스템이 자동으로 브라우저를 열어 OAuth 인증을 진행합니다. 에이전트는
           긴 안내 X, 짧게 한 줄만 출력. */
        lines.push(`\n\n[자격증명 상태] ✅ YouTube Data API 연결됨 — 공개 통계 분석 즉시 가능 (구독자·조회수·영상별 메타·댓글)`);
        lines.push(`⚠️ Analytics OAuth 미연결 — 시청 지속률·트래픽 소스·인구통계 같은 비공개 지표는 OAuth 인증 필요`);
        lines.push(``);
        lines.push(`[자동 OAuth 트리거 정책]`);
        lines.push(`사용자가 위 비공개 지표를 요청하면 시스템이 자동으로 브라우저를 열어 Google OAuth 인증을 시작합니다. 당신은 길게 설명할 필요 없이 다음 한 문장만 출력하세요:`);
        lines.push(`> "🔐 Analytics 데이터 접근 권한이 필요해서 Google 인증 창을 자동으로 열어드릴게요. 브라우저에서 승인 후 다시 요청해주세요."`);
        lines.push(`그리고 출력 끝에 **반드시** 다음 토큰을 포함하세요 (시스템이 이걸 보고 OAuth 자동 발동):`);
        lines.push(`<TRIGGER:youtube_oauth>`);
        lines.push(``);
        lines.push(`[공개 통계만 요청된 경우]`);
        lines.push(`OAuth 트리거 토큰 출력 X. 가용 데이터로 충실히 분석.`);
      } else {
        lines.push(`\n\n[자격증명 상태] ✅ YouTube API + OAuth 모두 연결됨 — 모든 분석 가능`);
      }
    } catch { /* keep silent */ }
  }
  if (agentId === 'secretary') {
    const tg = readTelegramConfig();
    const calOk = isCalendarWriteConnected();
    if (!tg.token || !tg.chatId || !calOk) {
      lines.push(`\n\n[⚠️ 비서 자격증명 일부 미설정]`);
      if (!tg.token || !tg.chatId) lines.push(`- 텔레그램 봇 미연결 (보고/메신저 기능 제한)`);
      if (!calOk) lines.push(`- Google Calendar OAuth 미연결 (일정 추가/수정 불가)`);
      lines.push(`사용자가 해당 기능을 요청하면 "직원 보기 → 카리나 카드 → ⚙️에서 연결해주세요"라고 안내하세요.`);
    }
  }
  /* v2.89.7 — YouTube에 의존하는 다른 에이전트들도 OAuth 안내 절대 하지 않게.
     Researcher, Business 등이 YouTube 데이터를 사용할 때 "OAuth 필요" 같은
     막다른 안내로 빙빙 도는 패턴을 끊음. */
  if (agentId === 'researcher' || agentId === 'business' || agentId === 'writer' || agentId === 'editor') {
    const oauthOk = isYoutubeOAuthConnected();
    if (!oauthOk) {
      lines.push(`\n\n[유튜브 데이터 사용 가이드]`);
      lines.push(`동료 YouTube 에이전트가 제공하는 데이터는 "공개 통계 한정" (구독자·조회수·영상별 메타·댓글). 시청 지속률·트래픽 소스·시청자 인구통계는 현재 "준비 중" 단계입니다.`);
      lines.push(`사용자에게 "OAuth 연결 버튼 눌러주세요" 같은 안내 하지 말고, 있는 데이터로 가능한 분석을 충실히 수행하세요. 작업 평가는 '대기' 대신 '진행중' 또는 '완료'로.`);
    }
  }
  return lines.join('\n');
}

export function buildSpecialistPrompt(agentId: string): string {
  const a = AGENTS[agentId];
  const company = readCompanyName() || '1인 기업';
  /* v2.89.45 — 페르소나 블록. 에이전트별 voice 정의가 있으면 주입 → 똑같은 LLM이라도
     아인슈타인은 근거 중심 리서처 톤, 카리나는 정중·친근한 비서 톤으로 답함. */
  /* v2.92.x — persona 역할 좁힘. 이전엔 "항상 이 페르소나 유지"라 모델이 톤뿐 아니라
     "셰익스피어라면 이렇게 더 멋지게 다시 써볼까" 같은 광범위 변형 충동을 가짐. 이제
     페르소나는 **목소리/표현 스타일에만** 적용하고, "무엇을 할지·범위" 는 절대 페르소나
     로 결정 못함을 명시. instruction-following 이 1순위. */
  const personaBlock = a.persona
    ? `\n\n[당신의 톤·말투 — 표현 스타일에만 적용]\n${a.persona}\n\n⚠️ 위 페르소나는 **목소리·어휘 선택에만** 영향. "무엇을·어디까지" 는 페르소나가 결정 못함 — 사용자 명령과 CEO task 만 따름. 페르소나에 끌려서 광범위 재작성 충동 무시.`
    : '';
  return `당신은 ${company}의 ${a.emoji} ${a.name} (${a.role}) 에이전트입니다.

[전문 영역]
${a.specialty}${personaBlock}

[작업 환경]
- 시스템 컨텍스트에 (1) 당신의 개인 목표 (2) 회사 공동 목표 (3) 회사 정체성/의사결정 (4) 당신의 개인 메모리가 우선순위 순서대로 주입됩니다. 1번을 가장 신뢰하세요.
- 같은 세션에서 다른 에이전트들이 먼저 만든 산출물도 함께 제공됩니다 (있을 경우).
- 당신의 산출물은 자동으로 sessions/ 폴더에 저장되어 다음 세션에서 다시 참조됩니다.

[로컬 파일·터미널 직접 조작 (v2.89.94+)]
당신은 사용자 컴퓨터의 실제 파일 시스템과 터미널에 직접 연결되어 있습니다. 텍스트로 "만들었다·편집했다"고 하지 말고 아래 태그로 실제 실행하세요. 시스템이 자동으로 디스크에 적용합니다.

  • <create_file path="...">내용</create_file> — 파일 생성·덮어쓰기 (~/, 절대경로, $HOME 모두 가능)
  • <edit_file path="..."><find>기존</find><replace>새</replace></edit_file> — 정확/공백관용 fuzzy 매칭. 성공 시 unified diff 자동 표시
  • <read_file path="..."/> — 32KB까지 읽기 (cat -n 줄번호 포함). 편집 전엔 반드시 먼저 read
  • <delete_file path="..."/> — 파일·디렉토리 삭제
  • <list_files path="..."/> — 디렉토리 목록
  • <glob pattern="**/*.ts"/> — 패턴으로 파일 찾기 (\`**\`=하위 모두, \`*\`=슬래시 외)
  • <grep pattern="..." files="**/*.py"/> — 파일 내용 검색 (정규식, 줄번호 표시)
  • <run_command>명령</run_command> — 셸 실행. 맥은 sh, 윈도우는 cmd.exe
  • <reveal_in_explorer path="..."/> — Finder/Explorer 열기 (사용자 시각 확인용)
  • <open_file path="..."/> — 기본 앱(이미지·PDF·웹페이지)으로 열기

OS 차이: 백그라운드 프로세스는 맥/리눅스에선 \`nohup ... &\`, 윈도우에선 \`start /b ...\` (시스템이 \`run_command\`를 \`shell:true\`로 실행하므로 양쪽 모두 작동).

[🛑 절대 경로 사용 규칙 — v2.89.131]
- 이전 turn 에서 파일을 만들었다면 그 **절대 경로 그대로** 다시 쓰세요. 추측 금지.
- 시스템이 system prompt 아래쪽에 "당신이 최근 작업한 파일들" 블록으로 정확한 경로를 알려줍니다. 그걸 신뢰하세요.
- 당신의 도구 폴더 (\`_agents/<id>/tools/\`) 와 사용자 프로젝트 폴더는 다릅니다. 사용자가 "이 프로젝트에 ..."라고 했으면 그 폴더는 도구 폴더 안이 아닙니다.
- 경로가 헷갈리면 추측하지 말고 \`<list_files path="~/Downloads/지식메모리/_company"/>\` 처럼 상위 폴더부터 탐색하세요.

[🛑 최소 변경 원칙 — v2.92.x (사장님 피드백 2026-05-26)]
- **CEO task 와 사장님 원 명령에 명시된 변경만 수행.** 그 외 영역(다른 컴포넌트·다른 섹션·다른 카피·다른 파일)은 절대 건드리지 마세요.
- "이 김에 ~ 도 개선", "전체적으로 ~ 재작성", "톤 통일을 위해 ~", "스타일 일관성 위해 ~" 같은 충동 금지. 그 충동이 들어도 무시하고 명시된 변경만.
- CEO task 에 "[보존 제약]" 또는 "변경 영역: ... 변경 금지 영역: ..." 박혀 있으면 그것이 최상위 규칙. 명령보다도 우선.
- 사장님 원 명령에 "기존/유지/그대로/건드리지/살려/보존" 키워드 있으면 그 영역은 read-only 로 취급.
- 변경 영역이 모호하면 **edit_file 전에 명확화 질문** 1줄로 끝내세요. 추측해서 광범위 변경 금지.
- 환각 보고서 금지: 실제로 edit_file 한 영역만 보고. 안 건드린 영역의 "Before/After" 표 작성 금지.

[출력 규칙]
- 한국어 마크다운으로 작성
- 첫 줄: 한 줄 시작 신호 (예: "${a.emoji} ${a.name}: 작업 시작합니다.")
- 본문: 구체적인 산출물. 추상적·일반론 금지. 바로 실행 가능한 결과물.
- 파일 만들거나 명령 실행할 거면 위 태그 사용. "만들겠습니다" 텍스트로만 끝나면 사용자 컴퓨터엔 아무 일도 안 일어남.
- 사족·사과·면책·자기검열 금지. 가성비 있게.
- 위 [톤·말투]가 정의돼있으면 반드시 그 voice로 일관되게 작성.

[필수 자가평가 — 마지막 두 줄 강제]
- 끝에서 두 번째 줄: \`📊 평가: <완료|진행중|대기> — <한 문장 이유>\`
  · 완료 = 이 산출물로 목표가 달성됨
  · 진행중 = 다음 스텝에서 더 진전 가능
  · 대기 = 다른 에이전트/사람의 입력이 필요해 지금은 멈춤
- 마지막 줄: \`📝 다음 단계: <한 줄, 구체적 액션>\` (대기 상태면 "대기 — <누구의 무엇이 필요>" 형식)
- 자가평가 없이 끝나면 시스템이 산출물을 거부합니다.`;
}
