/* Agent context assembly — shared prompt, templates, skills, verified, custom.
 *
 * Extracted from extension.ts byte-for-byte. These functions compose the
 * "shared context" block appended to every agent's prompt — identity,
 * decisions, memory, schedules, templates, skills, Graph-RAG brain
 * retrieval, Self-RAG protocol, tool catalog, custom persona prompt.
 *
 * Deps imported from `../extension` (need `export` added there if missing):
 *   - _safeReadText                  (already exported)
 *   - readAgentGoal                  (already exported)
 *   - readAgentRagMode               (already exported)
 *   - readAgentSelfRagCriteria       (already exported)
 *   - trackerToMarkdown              (already exported)
 *   - listAgentTools                 (already exported)
 *   - isCalendarWriteConnected       (already exported)
 *   - _pythonCmd                     (already exported — re-export of infra/python)
 *
 * Deps from extracted modules / siblings:
 *   - getCompanyDir                  ← '../paths'
 *   - _getBrainDir                   ← '../paths'
 *   - AGENTS                         ← '../agents'
 *   - _seedBundledTemplates          ← '../seeds'
 *   - readGraphRagBrainContext       ← './rag-context'
 *
 * NOTE: readAgentSharedContext also calls `readAgentVerifiedKnowledge`,
 * `readAgentSkills`, `readAgentTemplates`, `readAgentCustomPrompt` —
 * which all live in THIS file, so no cross-import needed for those.
 */

import * as fs from 'fs';
import * as path from 'path';

import { getCompanyDir, _getBrainDir } from '../paths';
import { AGENTS } from '../agents';
import { _seedBundledTemplates } from '../seeds';
import {
    _safeReadText,
    readAgentGoal,
    readAgentRagMode,
    readAgentSelfRagCriteria,
    trackerToMarkdown,
    listAgentTools,
    isCalendarWriteConnected,
    _pythonCmd,
} from '../extension';

import { readGraphRagBrainContext } from './rag-context';

export function readAgentSharedContext(agentId: string, opts?: { lean?: boolean }): string {
  /* v2.89.42 — lean 모드 = 두뇌 "삭제"가 아니라 "축소". 실데이터 prefetch가 성공해서
     큰 컨텍스트가 들어왔을 때 두뇌 콘텐츠 자르기보다 줄이는 쪽으로 결정.
     사용자가 쌓아둔 결정·메모리·brain 노트는 분석에 쓸 수 있어야 함 (제2의 두뇌 컨셉의
     핵심). 단 너무 길면 추론 느려지고 환각 위험 — 그래서 적정 크기로 축소.
       normal: decisions 3000자 / memory 4000자 / brain RAG 2400자 (총 ~9400자)
       lean:   decisions 1200자 / memory 1500자 / brain RAG  900자 (총 ~3600자)
     → 약 60% 감소. 두뇌는 살아있되 부담 줄임. */
  const lean = opts?.lean === true;
  const dir = getCompanyDir();
  const identity = _safeReadText(path.join(dir, '_shared', 'identity.md'));
  const companyGoals = _safeReadText(path.join(dir, '_shared', 'goals.md'));
  const decisions = _safeReadText(path.join(dir, '_shared', 'decisions.md'));
  const memory = _safeReadText(path.join(dir, '_agents', agentId, 'memory.md'));
  const personalGoal = readAgentGoal(agentId);
  const ragMode = readAgentRagMode(agentId);
  let ctx = '';
  // Priority order (most-trusted first):
  //   agent goal > 현재 프로젝트 > company goals > company identity > decisions > memory > brain knowledge > tools
  //   회사 = 글로벌 정체성·창업자 비전 (고정). 프로젝트 = 워크스페이스별 현재 작업
  //   (목표·기한·상태 자주 바뀜). 둘 다 보여서 specialist 가 "회사 정체성 안에서 이번
  //   프로젝트 목표 달성" 으로 맥락 잡음.
  if (personalGoal.trim()) ctx += `\n\n[당신의 개인 목표 (최우선 — 매 사이클 이 방향으로 한 스텝 진행)]\n${personalGoal.slice(0, 4000)}`;
  /* 현재 프로젝트 컨텍스트 — workspace 의 .agent-os-ai/project.json 에서 로드.
     워크스페이스 없거나 파일 없으면 block 생략 (회사 컨텍스트만으로 동작). */
  try {
    const vscode = require('vscode');
    const wf = vscode?.workspace?.workspaceFolders;
    const workspaceFolder = wf && wf.length > 0 ? wf[0].uri.fsPath : undefined;
    if (workspaceFolder) {
      const { readProjectMeta, buildProjectContextBlock } = require('../company/project-meta');
      const projectMeta = readProjectMeta(workspaceFolder);
      const block = buildProjectContextBlock(projectMeta);
      if (block) ctx += block;
    }
  } catch { /* vscode unavailable (tests) or project read failed — skip */ }
  if (companyGoals.trim()) ctx += `\n\n[회사 공동 목표]\n${companyGoals.slice(0, 4000)}`;
  if (identity.trim()) ctx += `\n\n[회사 정체성]\n${identity.slice(0, 2000)}`;
  if (decisions.trim()) ctx += `\n\n[지난 의사결정 로그]\n${decisions.slice(lean ? -1200 : -3000)}`;
  /* Calendar — secretary's google_calendar tool writes upcoming events here.
     Surfaced to every agent so scheduling and time-aware planning work without
     each agent having to call the tool itself. */
  try {
    const cal = _safeReadText(path.join(dir, '_shared', 'calendar_cache.md'));
    if (cal.trim()) ctx += `\n\n[다가오는 일정 (Google Calendar)]\n${cal.slice(0, 2000)}`;
  } catch { /* ignore */ }
  /* Unified schedule — Secretary maintains this combining calendar + each
     agent's recent activity + user TODOs. Lets every agent plan around the
     user's life and their teammates' workload. */
  try {
    const sch = _safeReadText(path.join(dir, '_shared', 'schedule.md'));
    if (sch.trim()) ctx += `\n\n[통합 스케줄 (비서 관리)]\n${sch.slice(0, 2200)}`;
  } catch { /* ignore */ }
  /* Open tracker tasks — agents see what's still pending so they don't
     duplicate work and can pick up overlapping items. Also lets them know
     what user is on the hook for, so they avoid blocking on the user. */
  try {
    const trackerMd = trackerToMarkdown({ onlyOpen: true, max: 12 });
    if (trackerMd) ctx += `\n\n[추적 중인 작업 (열린 것만)]\n${trackerMd}`;
  } catch { /* ignore */ }
  /* Self-RAG mode: surface verified.md FIRST as primary memory so previously
     self-grounded claims dominate the context. memory.md still gets included
     below as the firehose, but the agent has already been told to trust
     verified entries above [추측] entries. */
  if (ragMode === 'self-rag') {
    const verified = readAgentVerifiedKnowledge(agentId);
    if (verified.trim()) {
      ctx += `\n\n[${AGENTS[agentId]?.name} 검증된 지식 (Self-RAG가 자가검증한 항목들 — 최우선 신뢰)]\n${verified.slice(0, 4000)}`;
    }
  }
  /* v2.89.115 — Curated skills (검증된 재사용 패턴). memory.md는 firehose,
     skills/는 사용자가 명시적으로 승격한 것만. 신뢰도가 더 높으므로 memory
     위에 배치하고 별도 라벨로 표시. */
  try {
    const skillsBlock = readAgentSkills(agentId, lean ? 1500 : 4000);
    if (skillsBlock) ctx += skillsBlock;
  } catch { /* never break the prompt */ }
  /* v2.89.115 — 템플릿 (재사용 빌딩블록). 두뇌의 40_템플릿/<id>/ 폴더.
     스킬보다 더 무거운 자료(코드·파일·문서) — 매니페스트만 inject, 실제 파일은
     LLM이 필요시 read_file 로 읽기. */
  try {
    const templatesBlock = readAgentTemplates(agentId, lean ? 1000 : 2000);
    if (templatesBlock) ctx += templatesBlock;
  } catch { /* never break the prompt */ }
  /* Scope-aware memory injection. 이전엔 단순 slice(-N) 으로 최근 N자만
     주입했으나 여러 프로젝트 학습이 섞여 들어와 노이즈 + 추론 환각 위험.
     이제 critical / 현재 project / global 3 섹션으로 예산 분배 (다른 project
     학습은 dropped). 워크스페이스 없으면 critical + global 만. */
  if (memory.trim()) {
    try {
      const { buildScopedMemoryBlock, MEMORY_BUDGET_NORMAL, MEMORY_BUDGET_LEAN } = require('../dispatch/agent-memory');
      let currentProjectName: string | undefined;
      try {
        const vscode = require('vscode');
        const wf = vscode?.workspace?.workspaceFolders;
        const workspaceFolder = wf && wf.length > 0 ? wf[0].uri.fsPath : undefined;
        if (workspaceFolder) {
          const { readProjectMeta } = require('../company/project-meta');
          const pm = readProjectMeta(workspaceFolder);
          currentProjectName = pm?.name;
        }
      } catch { /* vscode unavailable — fall through with undefined */ }
      const scoped = buildScopedMemoryBlock(memory, currentProjectName, lean ? MEMORY_BUDGET_LEAN : MEMORY_BUDGET_NORMAL);
      if (scoped) {
        const ragNote = ragMode === 'self-rag' ? ' — 미검증 포함, 신중히 사용' : '';
        ctx += `\n\n[${AGENTS[agentId]?.name} 개인 메모리${ragNote}]\n${scoped}`;
      }
    } catch {
      /* Fallback to legacy slice if scoped block fails (defensive). */
      ctx += `\n\n[${AGENTS[agentId]?.name} 개인 메모리]\n${memory.slice(lean ? -1500 : -4000)}`;
    }
  }
  /* Bridge to broader brain folder — Graph RAG retrieval is always on
     (the brain network IS the graph; not using it would be wasteful).
     Normal: 2400 chars cap. Lean: 900 chars cap — 두뇌가 살아있되 짐 가벼움. */
  try {
    ctx += readGraphRagBrainContext(agentId, lean ? 900 : 2400);
  } catch { /* never let brain scan break the prompt */ }
  /* Self-RAG instruction block — appended late so it overrides earlier
     conventions. Tells the agent to ground every claim in the context above
     and tag ungrounded claims as [추측]. This is the "self-critique" step
     of Self-RAG, expressed as a strict output protocol. */
  if (ragMode === 'self-rag') {
    ctx += `\n\n[Self-RAG 자가검증 프로토콜 — 반드시 따를 것]\n`
      + `1. 답변 생성 전 위 컨텍스트(개인 목표·회사 목표·메모리·두뇌 지식)에서 근거가 되는 항목을 머릿속으로 골라내세요.\n`
      + `2. 각 사실 주장 옆에 \`[근거: <출처 한 마디>]\` 또는 \`[추측]\` 중 하나를 반드시 표기하세요. 출처가 위 컨텍스트에 없으면 \`[추측]\` 입니다.\n`
      + `3. 답변 마지막 줄에 \`자가검증: 사실 N개 / 추측 M개\` 한 줄을 추가하세요.\n`
      + `4. \`[추측]\`이 \`[근거:]\`보다 많으면 답변하지 말고 \`정보 부족 — 두뇌 폴더에 X 자료 필요\` 라고만 말하세요. 근거 없는 자신감은 회사 의사결정 로그를 오염시킵니다.`;
    /* User-defined extra criteria — appended only if non-empty. Tagged as
       "추가 기준" so the model treats them as authoritative checks on top
       of the standard protocol. */
    const userCriteria = readAgentSelfRagCriteria(agentId).trim();
    if (userCriteria) {
      ctx += `\n\n[Self-RAG 추가 기준 — 사용자 정의 (위 프로토콜 위에 강제 적용)]\n${userCriteria.slice(0, 3500)}\n\n위 사용자 정의 기준 중 하나라도 만족하지 못하면 답변을 보내기 전 수정하세요. 기준 위반은 \`자가검증\` 라인에서 \`기준 위반: …\` 형태로 명시.`;
    }
  }
  // Tool catalog — agent can invoke these via <run_command>. Only ENABLED
  // tools surface here; disabled ones are hidden so the agent never picks
  // them up autonomously. Absolute paths resolve correctly regardless of
  // where the user put their brain folder.
  /* google_calendar_write is a diagnostic-only Python script — the real
     calendar read/write is handled by built-in TypeScript functions
     (refreshCalendarCacheViaOAuth, createCalendarEventForTask). Exclude it
     from the tool catalog so the agent doesn't generate 'cd && python'
     commands for calendar operations. Same for google_calendar (iCal read). */
  const _BUILTIN_TOOLS = new Set(['google_calendar_write', 'google_calendar']);
  const tools = listAgentTools(agentId).filter(t => t.enabled && !_BUILTIN_TOOLS.has(t.name));
  if (tools.length > 0) {
    ctx += `\n\n[사용 가능한 도구 — <run_command>로 직접 실행 가능]\n` + tools.map(t => {
      const cd = `cd "${path.dirname(t.scriptPath)}"`;
      return `- 🛠️ \`${t.name}\` — ${t.description.replace(/\n/g, ' ').slice(0, 140)}\n  실행: <run_command>${cd} && ${_pythonCmd()} ${path.basename(t.scriptPath)}</run_command>\n  설정 파일(API 키 등): ${t.configPath}`;
    }).join('\n');
    /* v2.89.31 — 도구 사용 의무화. 작은 LLM은 도구 카탈로그를 무시하고
       LLM 지식만으로 답변하는 경향이 있어서, 실데이터가 필요한 task일 때
       반드시 도구를 명시적으로 실행 요청하라고 강제. 단 한 응답 안에서
       LLM은 도구 stdout을 못 봄 — system이 LLM 응답 종료 후 실행하고
       결과는 출력 끝에 append되어 다음 에이전트(peerCtx)와 final report에 흘러감. */
    ctx += `\n\n[🛠️ 도구 사용 규칙 — 반드시 따를 것]\n`
      + `- 위 도구 중 task에 필요한 게 있고 [실시간 데이터] 섹션에 해당 데이터가 아직 없으면, **답변 어디든** \`<run_command>\` 블록을 출력하세요. 시스템이 LLM 응답 종료 후 실행하고 결과를 출력 끝에 append합니다 (당신은 이 응답에서 stdout 못 봄 — 다음 에이전트와 final report가 활용).\n`
      + `- 이미 [실시간 데이터] 섹션에 데이터가 자동 주입돼 있으면 그걸 분석에 활용 — 도구 중복 실행 X.\n`
      + `- 데이터 없이 추측·일반론으로 답하는 건 금지. 데이터가 없고 도구도 없으면 솔직히 "데이터 부족으로 분석 보류" + 평가 \`대기\`로.\n`
      + `- 같은 task에 여러 도구가 도움 되면 \`<run_command>\` 블록을 여러 개 출력해도 됩니다 (시스템이 순차 실행).`;
  }
  /* Calendar context — if OAuth is connected, tell the agent it can access
     calendar data through the built-in system (no Python script needed).
     The actual data is already in _shared/calendar_cache.md (injected via
     readAgentSharedContext). */
  if (agentId === 'secretary' && isCalendarWriteConnected()) {
    ctx += `\n\n[📅 Google Calendar — 내장 연결됨]\n캘린더 데이터는 위 [다가오는 일정] 섹션에 자동 로드됩니다. Python 스크립트 실행 불필요 — 일정 조회는 이미 로드된 컨텍스트를 참고하세요. 일정 생성은 추적기에 due를 넣으면 자동으로 생성됩니다.`;
  }
  ctx += readAgentCustomPrompt(agentId);
  return ctx;
}

/* v2.89.115 — 템플릿 reader. 두뇌의 `40_템플릿/<agentId>/` 폴더 스캔.
   각 템플릿은 하위 폴더이고 README.md + manifest.json + 코드 파일 가짐.
   AI 컨텍스트엔 매니페스트 요약 + README의 핵심 + 파일 목록만 inject (전체 코드는 X —
   파일 너무 크면 컨텍스트 폭주). LLM이 "이 템플릿 쓰겠다" 결정하면 read_file로 실제
   파일 읽으면 됨. */
export function readAgentTemplates(agentId: string, maxChars = 2000): string {
  const brainDir = _getBrainDir();
  /* 새 표준 위치: 두뇌 안의 40_템플릿/<agentId>/ */
  const standardDir = path.join(brainDir, '40_템플릿', agentId);
  const englishDir = path.join(brainDir, '40_Templates', agentId);
  let templatesDir = '';
  if (fs.existsSync(standardDir)) templatesDir = standardDir;
  else if (fs.existsSync(englishDir)) templatesDir = englishDir;
  else {
    /* 첫 사용 — 번들 템플릿이 있으면 두뇌에 시드 */
    _seedBundledTemplates(agentId, standardDir);
    if (fs.existsSync(standardDir)) templatesDir = standardDir;
  }
  if (!templatesDir) return '';
  let folders: string[] = [];
  try {
    folders = fs.readdirSync(templatesDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
      .map(e => e.name);
  } catch { return ''; }
  if (folders.length === 0) return '';
  /* v2.89.125 — 스케일링: 매니페스트 풀 inject 대신 압축 형식 (이름 + 한 줄).
     실제 manifest+README는 pack_apply 가 필요 시 디스크에서 직접 읽음. 컨텍스트 절약.
     500자 이내 (10~20개 키트도 안전). */
  const MAX_KITS_LISTED = 20;
  const briefs: { name: string; title: string; desc: string; keywords: string[]; files: number }[] = [];
  for (const name of folders.slice(0, MAX_KITS_LISTED)) {
    const tplDir = path.join(templatesDir, name);
    let manifest: any = null;
    try {
      const mp = path.join(tplDir, 'manifest.json');
      if (fs.existsSync(mp)) manifest = JSON.parse(fs.readFileSync(mp, 'utf-8') || '{}');
    } catch { /* malformed */ }
    let fileCount = 0;
    try {
      const filesDir = path.join(tplDir, 'files');
      if (fs.existsSync(filesDir)) fileCount = fs.readdirSync(filesDir).length;
    } catch { /* ignore */ }
    briefs.push({
      name,
      title: manifest?.name || name,
      desc: (manifest?.description || '').slice(0, 90),
      keywords: (manifest?.keywords || []).slice(0, 5),
      files: fileCount,
    });
  }
  if (briefs.length === 0) return '';
  /* 압축 한 줄 포맷: `- name (📄 N파일): 설명 [키워드, ...]` */
  const lines = briefs.map(b =>
    `- \`${b.name}\` (📄 ${b.files}): ${b.desc}${b.keywords.length ? ` _[${b.keywords.join(', ')}]_` : ''}`
  );
  const overflow = folders.length > MAX_KITS_LISTED ? `\n_(총 ${folders.length}개 중 상위 ${MAX_KITS_LISTED}개. 나머지는 \`pack_apply\` 자동 매칭 사용)_` : '';
  /* lean 모드: 키워드 생략 — 더 짧게 */
  if (maxChars <= 1200) {
    const tightLines = briefs.map(b => `- \`${b.name}\`: ${b.desc.slice(0, 60)}`);
    return `\n\n[${AGENTS[agentId]?.name || agentId} 키트 ${folders.length}개 — \`pack_apply\` USER_INTENT 사용 권장]\n${tightLines.join('\n')}${overflow}\n`;
  }
  return `\n\n[${AGENTS[agentId]?.name || agentId} 키트 (${folders.length}개) — 사용 시 \`pack_apply\` 도구 호출. KIT_NAME 비우고 USER_INTENT 에 사용자 명령 그대로 → 자동 매칭]\n${lines.join('\n')}${overflow}\n`;
}

export function readAgentSkills(agentId: string, maxChars = 4000): string {
  const skillsDir = path.join(getCompanyDir(), '_agents', agentId, 'skills');
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(skillsDir).filter(f => f.endsWith('.md') && f.toLowerCase() !== 'readme.md');
  } catch { return ''; }
  if (entries.length === 0) return '';
  /* 최근 수정순으로 정렬 — 새로 만든 스킬이 먼저 보이도록 */
  entries.sort((a, b) => {
    try {
      const ma = fs.statSync(path.join(skillsDir, a)).mtimeMs;
      const mb = fs.statSync(path.join(skillsDir, b)).mtimeMs;
      return mb - ma;
    } catch { return 0; }
  });
  const blocks: string[] = [];
  let used = 0;
  for (const f of entries) {
    if (used >= maxChars) break;
    const body = _safeReadText(path.join(skillsDir, f)).trim();
    if (!body) continue;
    const block = body.slice(0, Math.max(200, maxChars - used));
    blocks.push(block);
    used += block.length;
  }
  if (blocks.length === 0) return '';
  return `\n\n[${AGENTS[agentId]?.name} 검증된 스킬 (사용자가 패턴으로 승격한 항목 — 가능하면 이 패턴을 따르세요)]\n${blocks.join('\n\n---\n\n')}`;
}

/* Self-RAG verified knowledge reader. When Self-RAG is ON for an agent,
   we parse its output for `[근거: source]` patterns and promote those
   claims into a curated `verified.md` next to memory.md. Future cycles
   preferentially retrieve from verified.md so the agent works off claims
   it has already self-grounded — not from raw speculation. */
export function readAgentVerifiedKnowledge(agentId: string): string {
  try {
    const p = path.join(getCompanyDir(), '_agents', agentId, 'verified.md');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
  } catch { return ''; }
}

export function readAgentCustomPrompt(agentId: string): string {
  const dir = getCompanyDir();
  const promptPath = path.join(dir, '_agents', agentId, 'prompt.md');
  const configPath = path.join(dir, '_agents', agentId, 'config.md');
  const customPrompt = _safeReadText(promptPath).trim();
  const config = _safeReadText(configPath).trim();
  let extra = '';
  if (customPrompt && !customPrompt.startsWith('# ')) {
    extra += `\n\n[사용자가 추가한 페르소나 디테일]\n${customPrompt.slice(0, 2000)}`;
  } else if (customPrompt) {
    // 헤더 시작이면 그대로 — placeholder 인지 검사
    const stripped = customPrompt.replace(/^#.*$/gm, '').replace(/_여기에.*?_/gs, '').trim();
    if (stripped.length > 30) {
      extra += `\n\n[사용자가 추가한 페르소나 디테일]\n${customPrompt.slice(0, 2000)}`;
    }
  }
  if (config) {
    // config.md에서 비밀 토큰은 마스킹 후 컨텍스트로 주입 (에이전트는 자기 어떤 도구 쓸 수 있는지 알아야 함)
    const masked = config.replace(/(TOKEN|API_KEY|SECRET)([:：=])\s*\S+/gi, '$1$2 ***SET***');
    if (masked.replace(/^#.*$/gm, '').trim().length > 30) {
      extra += `\n\n[당신의 도구·설정 (시크릿 마스킹됨)]\n${masked.slice(0, 1500)}`;
    }
  }
  return extra;
}
