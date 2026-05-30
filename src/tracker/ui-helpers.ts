/**
 * Tracker UI helpers — VS Code-flavored icons and a label formatter for the
 * Task TreeView, plus `rebuildUnifiedSchedule` which collates calendar +
 * agent memory + user TODOs into `_shared/schedule.md`.
 *
 * Extracted from src/extension.ts. These functions are split out from the
 * pure tracker domain (src/tracker/{io,mutations,recurrence}) because they
 * either depend on the `vscode` namespace (ThemeIcon / ThemeColor) or on
 * cross-cutting state (company dir, agent map) — i.e. they're "adapter"
 * code, not pure domain.
 *
 * Cross-module dependencies pulled from '../extension':
 *   - `_safeReadText` (read-safe wrapper, still resident in extension.ts)
 *
 * Other deps (already barrelled in their own modules):
 *   - `TaskPriority`, `TrackerTask` from './types'
 *   - `getCompanyDir` from '../paths'
 *   - `AGENTS`, `AGENT_ORDER` from '../agents'
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import type { TaskPriority, TrackerTask } from './types';
import { TASK_PRIORITY_ORDER, TASK_PRIORITY_LABEL, coercePriority } from './types';
import { readTracker as readTrackerStorage } from './io';
import { getCompanyDir } from '../paths';
import { AGENTS, AGENT_ORDER } from '../agents';
import { _safeReadText } from '../extension';

/* Map a priority level to a colored ThemeIcon for the group header. */
export function _priorityGroupIcon(p: TaskPriority): vscode.ThemeIcon {
    switch (p) {
        case 'urgent': return new vscode.ThemeIcon('error',     new vscode.ThemeColor('errorForeground'));
        case 'high':   return new vscode.ThemeIcon('warning',   new vscode.ThemeColor('list.warningForeground'));
        case 'normal': return new vscode.ThemeIcon('circle-outline');
        case 'low':    return new vscode.ThemeIcon('chevron-down', new vscode.ThemeColor('descriptionForeground'));
    }
}

/* Per-task icon — encodes status + due-urgency. We use VS Code's built-in
   codicon names so the look stays consistent with the rest of the IDE. */
export function _taskStatusIcon(t: TrackerTask): vscode.ThemeIcon {
    if (t.status === 'done')      return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
    if (t.status === 'cancelled') return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('descriptionForeground'));
    /* Open task — visual urgency derived from due. Codicon 'sync~spin' is
       VS Code's native spinner — used for in_progress to show "AI is on it". */
    if (t.dueAt) {
        const dt = new Date(t.dueAt).getTime();
        const ms = dt - Date.now();
        if (ms < 0)             return new vscode.ThemeIcon('flame', new vscode.ThemeColor('errorForeground')); // overdue
        if (ms < 60 * 60_000)   return new vscode.ThemeIcon('clock', new vscode.ThemeColor('errorForeground')); // <1h
        if (ms < 24 * 3600_000) return new vscode.ThemeIcon('clock', new vscode.ThemeColor('list.warningForeground')); // <1d
    }
    if (t.status === 'in_progress') return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.green'));
    return new vscode.ThemeIcon('circle-outline');
}

/* Friendly relative-time formatter — "지금부터 3시간", "내일 09:00", "3일 지남". */
export function _formatDueLabel(iso: string): string {
    try {
        const dt = new Date(iso);
        const ms = dt.getTime() - Date.now();
        const abs = Math.abs(ms);
        const m = Math.floor(abs / 60_000);
        const h = Math.floor(abs / 3600_000);
        const d = Math.floor(abs / 86_400_000);
        if (ms < 0) {
            if (d >= 1) return `🔴 ${d}일 지남`;
            if (h >= 1) return `🔴 ${h}시간 지남`;
            return `🔴 ${m}분 지남`;
        }
        if (d >= 7)  return `📅 ${dt.toISOString().slice(5, 10)}`;
        if (d >= 1)  return `📅 ${d}일 후`;
        if (h >= 1)  return `⏰ ${h}시간 후`;
        return `⚡ ${Math.max(1, m)}분 후`;
    } catch { return iso.slice(0, 16); }
}

/* ── Unified schedule.md ─────────────────────────────────────────────────
   Secretary's job is to give one consolidated view of "today/this week" —
   user's calendar events + each agent's recent activity + pending TODOs.
   Other agents read this via readAgentSharedContext so they can plan
   around the user's life and each other's work.

   Sources:
     - _shared/calendar_cache.md  (Google Calendar via iCal tool)
     - _agents/{id}/memory.md     (last 5 lines per agent — recent task log)
     - _shared/todos.md           (user-maintained — optional) */
export function rebuildUnifiedSchedule() {
  try {
    const dir = getCompanyDir();
    if (!fs.existsSync(dir)) return;
    fs.mkdirSync(path.join(dir, '_shared'), { recursive: true });
    const now = new Date();
    const lines: string[] = [];
    lines.push(`# 📋 통합 스케줄`);
    lines.push(`_업데이트: ${now.toLocaleString('ko-KR')}_`);
    lines.push('');

    /* 1. Calendar */
    const cal = _safeReadText(path.join(dir, '_shared', 'calendar_cache.md')).trim();
    if (cal) {
      lines.push('## 📅 사람 일정 (Google Calendar)');
      const calLines = cal.split('\n')
        .filter(l => l.trim().startsWith('-'))
        .slice(0, 12);
      lines.push(...calLines);
      lines.push('');
    }

    /* 2. Recent agent activity */
    const agentBlocks: string[] = [];
    for (const id of AGENT_ORDER) {
      if (id === 'ceo') continue;
      const memPath = path.join(dir, '_agents', id, 'memory.md');
      const mem = _safeReadText(memPath).trim();
      if (!mem) continue;
      const recent = mem.split('\n')
        .filter(l => /^\s*-\s*\[\d{4}-\d{2}-\d{2}\]/.test(l))
        .slice(-3);
      if (recent.length === 0) continue;
      const a = AGENTS[id];
      agentBlocks.push(`### ${a.emoji} ${a.name}\n${recent.join('\n')}`);
    }
    if (agentBlocks.length > 0) {
      lines.push('## 🤖 에이전트 최근 활동');
      lines.push(...agentBlocks);
      lines.push('');
    }

    /* 3. User TODOs */
    const todos = _safeReadText(path.join(dir, '_shared', 'todos.md')).trim();
    if (todos) {
      lines.push('## ✅ 사용자 할 일');
      lines.push(todos.slice(0, 1500));
      lines.push('');
    }

    fs.writeFileSync(path.join(dir, '_shared', 'schedule.md'), lines.join('\n') + '\n');
  } catch { /* never let schedule errors break the dispatch */ }
}

/* ── _coercePriority — thin re-export of `coercePriority` ─────────────────
   extension.ts 의 1-line wrapper 를 그대로 옮긴 것. consumer 들은 익숙한
   `_coercePriority` 이름을 계속 사용 가능. */
export function _coercePriority(v: unknown): TaskPriority {
  return coercePriority(v);
}

/* ── trackerToMarkdown ─────────────────────────────────────────────────────
   tracker.json → 사람이 읽을 수 있는 markdown 체크리스트 변환. 텔레그램
   카드 / daily-briefing / agent context 컨텍스트 블록에 모두 동일한 포맷이
   주입되도록 단일 출처 유지. */
export function trackerToMarkdown(opts: { onlyOpen?: boolean; max?: number } = {}): string {
  const all = readTrackerStorage(getCompanyDir()).tasks;
  const tasks = opts.onlyOpen ? all.filter(t => t.status !== 'done' && t.status !== 'cancelled') : all;
  if (tasks.length === 0) return '';
  /* Sort: status (in_progress > pending > done) → priority (urgent > high > normal > low)
     → newest createdAt within ties. Status before priority means a 'done urgent'
     still falls below an open 'low' — open work always surfaces first. */
  const order = (s: TrackerTask['status']) => s === 'in_progress' ? 0 : s === 'pending' ? 1 : s === 'done' ? 2 : 3;
  tasks.sort((a, b) => {
    const o = order(a.status) - order(b.status);
    if (o !== 0) return o;
    const pa = TASK_PRIORITY_ORDER[_coercePriority(a.priority)];
    const pb = TASK_PRIORITY_ORDER[_coercePriority(b.priority)];
    if (pa !== pb) return pa - pb;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
  const max = opts.max || 25;
  const lines: string[] = [];
  for (const t of tasks.slice(0, max)) {
    const icon = t.status === 'done' ? '✅'
      : t.status === 'in_progress' ? '🔄'
      : t.status === 'pending' ? '⏳'
      : '✖️';
    const ownerEmoji = t.owner === 'user' ? '👤'
      : t.owner === 'mixed' ? '👥'
      : (t.agentIds && t.agentIds[0] ? (AGENTS[t.agentIds[0]]?.emoji || '🤖') : '🤖');
    const due = t.dueAt ? ` ⏰${t.dueAt.slice(0, 10)}` : '';
    const aged = (Date.now() - new Date(t.createdAt).getTime()) / 86_400_000;
    const stale = (t.status === 'pending' && aged > 1) ? ' 🟡' : '';
    const prio = _coercePriority(t.priority);
    /* Show priority chip only for non-default — keeps the line short for
       the common 'normal' case while still surfacing urgent/high visually. */
    const prioChip = prio === 'normal' ? '' : ` ${TASK_PRIORITY_LABEL[prio].split(' ')[0]}`;
    const recur = t.recurrence ? ` 🔁${t.recurrence}` : '';
    lines.push(`- ${icon}${prioChip} ${ownerEmoji} \`${t.id.slice(-9)}\` ${t.title}${due}${recur}${stale}`);
  }
  return lines.join('\n');
}

/* ── AgentTool catalog ────────────────────────────────────────────────────
   _agents/<agentId>/tools/ 디렉토리를 스캔해 (script.py, config.json, README.md)
   triple 을 합쳐 webview 패널 / LLM prompt 에서 쓰는 catalog row 로 변환.
   Group 1 추출이지만 의미상 "agent 도구 catalog" 라서 tracker 와는 무관 —
   현재 위치는 단일 ui-helpers 파일 통합을 위한 임시 거주지. */
export interface AgentTool {
  name: string;          // e.g. "trend_sniper"
  displayName: string;   // human label
  description: string;   // short blurb for catalog
  scriptPath: string;    // absolute path to .py
  configPath: string;    // absolute path to .json
  readmePath: string;    // absolute path to .md
  config: Record<string, any>;   // parsed JSON values
  configSchema: ToolField[];     // inferred field schema for UI
  injectedAt?: string;   // ISO date — only set for skills injected via /api/skill-inject
  injectedFrom?: string; // origin tag (e.g. "ezer", "ai-university")
  enabled: boolean;      // user toggle — false hides tool from agent's prompt catalog
}

export interface ToolField {
  key: string;
  label: string;
  type: 'password' | 'text' | 'list' | 'number' | 'select';
  value: any;
  /** v2.89.72 — select 타입일 때 드롭다운 옵션 목록. JSON config의 `_schema[KEY].options`에서. */
  options?: { value: string; label: string }[];
  /** v2.89.72 — select/text/number 공통 — 사용자한테 보여줄 placeholder/도움말. `_schema[KEY].hint`. */
  hint?: string;
}

function _inferToolFieldType(key: string, value: any, schema?: any): ToolField['type'] {
  // v2.89.72 — _schema에서 명시적 type 지정이 있으면 우선
  if (schema && schema[key] && schema[key].type) {
    const t = schema[key].type;
    if (['password', 'text', 'list', 'number', 'select'].includes(t)) return t;
  }
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'number') return 'number';
  // any key with KEY/SECRET/TOKEN/PASS → password
  if (/(KEY|SECRET|TOKEN|PASS|API)/i.test(key)) return 'password';
  return 'text';
}

export function listAgentTools(agentId: string): AgentTool[] {
  const dir = path.join(getCompanyDir(), '_agents', agentId, 'tools');
  if (!fs.existsSync(dir)) return [];
  let entries: string[] = [];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  let names = entries
    .filter(f => f.endsWith('.py'))
    .map(f => f.slice(0, -3));
  /* v2.67 dedup: hide the iCal-only `google_calendar` tool whenever the
     OAuth tool `google_calendar_write` is present — they overlap entirely
     and users found two "Google Calendar" entries confusing. */
  if (names.includes('google_calendar') && names.includes('google_calendar_write')) {
    names = names.filter(n => n !== 'google_calendar');
  }
  /* Slack approval is optional legacy transport. Current approval/release
     flow uses Agent OS dashboard, approvals panel, and Telegram. Hide Slack
     tools unless explicitly re-enabled by editing their tool JSON. */
  const slackTools = new Set(['slack_notifier', 'slack_approval_worker']);
  const out: AgentTool[] = [];
  for (const name of names) {
    const scriptPath = path.join(dir, `${name}.py`);
    const configPath = path.join(dir, `${name}.json`);
    const readmePath = path.join(dir, `${name}.md`);
    let config: Record<string, any> = {};
    try {
      if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch { /* malformed JSON — leave empty */ }
    if (slackTools.has(name) && config._enabled !== true) continue;
    let readme = '';
    try { if (fs.existsSync(readmePath)) readme = fs.readFileSync(readmePath, 'utf-8'); } catch {}
    // Display name: first H1 in readme, or prettified file name
    const h1 = readme.match(/^#\s+(.+)$/m);
    const displayName = h1 ? h1[1].trim() : name.replace(/_/g, ' ');
    // Description: first non-heading paragraph
    const descMatch = readme.split('\n').find(l => l.trim() && !l.startsWith('#'));
    const description = (descMatch || '').slice(0, 200);
    // _injectedAt 등 메타 키는 사용자에게 노출되는 설정 폼에선 숨김 — 출처 추적용 내부 필드.
    // v2.89.72 — _schema 메타 필드로 select 옵션·hint·label override 가능.
    const schema = (config && typeof config._schema === 'object') ? config._schema : null;
    const configSchema: ToolField[] = Object.entries(config)
      .filter(([key]) => !key.startsWith('_'))
      .map(([key, value]) => {
        const t = _inferToolFieldType(key, value, schema);
        const fieldMeta = schema && schema[key] ? schema[key] : null;
        const field: ToolField = {
          key,
          label: (fieldMeta && fieldMeta.label) || key.replace(/_/g, ' '),
          type: t,
          value,
        };
        if (t === 'select' && fieldMeta && Array.isArray(fieldMeta.options)) {
          field.options = fieldMeta.options.map((o: any) =>
            typeof o === 'string' ? { value: o, label: o } : { value: o.value, label: o.label || o.value }
          );
        }
        if (fieldMeta && fieldMeta.hint) field.hint = fieldMeta.hint;
        return field;
      });
    const injectedAt = typeof config._injectedAt === 'string' ? config._injectedAt : undefined;
    const injectedFrom = typeof config._injectedFrom === 'string' ? config._injectedFrom : undefined;
    /* enabled defaults TRUE — explicit `_enabled: false` opts out, missing
       config or missing key both keep the tool active. Stored alongside
       other config keys so it round-trips through writeToolConfig untouched. */
    const enabled = config._enabled === false ? false : true;
    out.push({ name, displayName, description, scriptPath, configPath, readmePath, config, configSchema, injectedAt, injectedFrom, enabled });
  }
  return out;
}
