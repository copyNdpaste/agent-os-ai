/**
 * TaskTreeItem + TaskTreeProvider — VS Code 사이드바 트리 뷰.
 *
 * extension.ts 에서 분리. tracker.json 을 시각화 — 우선순위 그룹 (긴급/높음/보통/낮음)
 * 으로 묶고, 닫힌 항목은 "이력" 그룹에 30개까지. 5분마다 due-임박 큐 갱신.
 *
 * 두 클래스는 강하게 결합돼 있어 (provider 가 item 을 생성) 한 파일로 묶음.
 * 클래스 본문은 byte-for-byte 복사 — 이번 사이클에는 리팩터링 없음.
 *
 * Deps imported from `../extension` (need `export` 추가됨):
 *   - type TrackerTask
 *   - type TaskPriority
 *   - TASK_PRIORITY_LABEL
 *   - readTracker
 *   - onTrackerChanged
 *   - _coercePriority
 *   - _formatDueLabel
 *   - _priorityGroupIcon
 *   - _taskStatusIcon
 *
 * Deps from extracted modules / siblings:
 *   - AGENTS ← '../agents'
 */
import * as vscode from 'vscode';
import { AGENTS } from '../agents';
import {
    type TrackerTask,
    type TaskPriority,
    TASK_PRIORITY_LABEL,
    readTracker,
    onTrackerChanged,
    _coercePriority,
    _formatDueLabel,
    _priorityGroupIcon,
    _taskStatusIcon,
} from '../extension';

/* TaskGroup key now expanded to support priority-grouping mode. The tree
   groups by PRIORITY (urgent/high/normal/low) for open tasks since that's
   what the user actually scans for. Closed tasks (done/cancelled) collapse
   into a single "이력" group so they don't dominate the view. */
type TaskGroupKey = TaskPriority | 'closed';

export class TaskTreeItem extends vscode.TreeItem {
    constructor(
        public readonly task: TrackerTask | null,
        public readonly groupKey: TaskGroupKey | null,
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState);
    }
}

export class TaskTreeProvider implements vscode.TreeDataProvider<TaskTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TaskTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    /* Periodic light refresh so due-imminent visual cues update without
       waiting for a tracker write — tasks transition into "임박" zone purely
       by clock advancing. 5min cadence is plenty (window resolution is hour). */
    private _ticker: NodeJS.Timeout | null = null;

    constructor() {
        onTrackerChanged(() => this.refresh());
        this._ticker = setInterval(() => this.refresh(), 5 * 60_000);
    }
    dispose() { if (this._ticker) { clearInterval(this._ticker); this._ticker = null; } }

    refresh() { this._onDidChangeTreeData.fire(); }

    getTreeItem(el: TaskTreeItem): vscode.TreeItem { return el; }

    getChildren(parent?: TaskTreeItem): TaskTreeItem[] {
        const all = readTracker().tasks;
        if (!parent) {
            /* Top level — priority groups for open tasks + a single "이력"
               group for closed. Hide empty groups so we don't show
               "🔴 긴급 (0)" noise on a fresh install. Counts include the
               #stale flag (overdue user tasks) as a small adornment. */
            const open = all.filter(t => t.status !== 'done' && t.status !== 'cancelled');
            const closed = all.filter(t => t.status === 'done' || t.status === 'cancelled');
            const prioOrder: TaskPriority[] = ['urgent', 'high', 'normal', 'low'];
            const items: TaskTreeItem[] = [];
            for (const p of prioOrder) {
                const inGroup = open.filter(t => _coercePriority(t.priority) === p);
                if (inGroup.length === 0) continue;
                const overdue = inGroup.filter(t => t.dueAt && new Date(t.dueAt).getTime() < Date.now()).length;
                const overdueChip = overdue > 0 ? ` 🔴${overdue}` : '';
                const it = new TaskTreeItem(
                    null, p,
                    `${TASK_PRIORITY_LABEL[p]}  (${inGroup.length})${overdueChip}`,
                    /* Expand urgent + high by default — those are the ones the user
                       must act on. Normal + low collapsed unless they're the only
                       group present (handled below). */
                    (p === 'urgent' || p === 'high')
                        ? vscode.TreeItemCollapsibleState.Expanded
                        : vscode.TreeItemCollapsibleState.Collapsed
                );
                it.contextValue = 'taskGroup';
                /* Group icon + theme color — visual hierarchy at a glance. */
                it.iconPath = _priorityGroupIcon(p);
                items.push(it);
            }
            /* If only normal/low have tasks, expand them so the view isn't empty-feeling. */
            if (items.length > 0 && items.every(it => it.collapsibleState === vscode.TreeItemCollapsibleState.Collapsed)) {
                items[0].collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
            }
            if (closed.length > 0) {
                const histIt = new TaskTreeItem(
                    null, 'closed',
                    `📁 이력  (${closed.length})`,
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                histIt.contextValue = 'taskGroup';
                histIt.iconPath = new vscode.ThemeIcon('archive');
                items.push(histIt);
            }
            if (items.length === 0) {
                const empty = new TaskTreeItem(null, null, '아직 등록된 할 일이 없어요. 텔레그램에 자연어로 말하거나 사이드바에 명령하면 비서가 만들어요.', vscode.TreeItemCollapsibleState.None);
                empty.contextValue = 'emptyHint';
                empty.iconPath = new vscode.ThemeIcon('lightbulb');
                return [empty];
            }
            return items;
        }
        if (!parent.groupKey) return [];
        let tasks: TrackerTask[];
        if (parent.groupKey === 'closed') {
            tasks = all.filter(t => t.status === 'done' || t.status === 'cancelled');
            tasks.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
            tasks = tasks.slice(0, 30); /* don't load infinite history */
        } else {
            tasks = all.filter(t => t.status !== 'done' && t.status !== 'cancelled' && _coercePriority(t.priority) === parent.groupKey);
            /* Within group: due-imminent first, then stale, then newest. */
            const now = Date.now();
            const score = (t: TrackerTask) => {
                if (t.dueAt) {
                    const dt = new Date(t.dueAt).getTime();
                    if (dt < now) return -1e12 + dt; /* overdue: most negative first */
                    return dt;                       /* upcoming: nearest first */
                }
                return 1e15 - new Date(t.createdAt).getTime();
            };
            tasks.sort((a, b) => score(a) - score(b));
        }
        return tasks.map(t => {
            const prio = _coercePriority(t.priority);
            const ownerEmoji = t.owner === 'user' ? '👤'
                : t.owner === 'mixed' ? '👥'
                : (t.agentIds && t.agentIds[0] ? (AGENTS[t.agentIds[0]]?.emoji || '🤖') : '🤖');
            const recur = t.recurrence ? ` 🔁` : '';
            const item = new TaskTreeItem(t, null, `${ownerEmoji} ${t.title}${recur}`, vscode.TreeItemCollapsibleState.None);
            /* Status / urgency icon — mapped through ThemeIcon so it adapts to
               the user's color theme (light/dark/high-contrast). The colored
               'urgent' / 'overdue' variants use the same red the editor uses
               for errors, so the visual hierarchy matches what users already
               read as "needs attention". */
            item.iconPath = _taskStatusIcon(t);
            const desc: string[] = [];
            if (t.dueAt) {
                const due = _formatDueLabel(t.dueAt);
                desc.push(due);
            }
            desc.push(`id ${t.id.slice(-9)}`);
            const aged = (Date.now() - new Date(t.createdAt).getTime()) / 86_400_000;
            if (t.status === 'pending' && aged > 1) desc.push('🟡 오래됨');
            item.description = desc.join(' · ');
            const tip = new vscode.MarkdownString();
            tip.appendMarkdown(`**${t.title}**\n\n`);
            tip.appendMarkdown(`- 우선순위: ${TASK_PRIORITY_LABEL[prio]}\n`);
            tip.appendMarkdown(`- 상태: ${t.status}\n`);
            tip.appendMarkdown(`- 소유: ${t.owner}${t.agentIds?.length ? ' (' + t.agentIds.join(', ') + ')' : ''}\n`);
            if (t.dueAt) tip.appendMarkdown(`- 기한: ${t.dueAt}\n`);
            if (t.recurrence) tip.appendMarkdown(`- 반복: ${t.recurrence}\n`);
            tip.appendMarkdown(`- 생성: ${t.createdAt}\n`);
            if (t.description) tip.appendMarkdown(`\n_${t.description.slice(0, 200)}_\n`);
            item.tooltip = tip;
            item.contextValue = (t.status === 'done' || t.status === 'cancelled') ? 'closedTask' : 'openTask';
            item.id = t.id;
            return item;
        });
    }
}
