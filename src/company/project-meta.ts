/**
 * Project metadata — per-workspace project info.
 *
 * 회사 (Agent OS AI) 는 글로벌 정체성 — 한 번 셋업하면 안 바뀜. 사용자가
 * 어떤 프로젝트를 시작하든 사장님 정체성·회사 비전은 동일.
 *
 * 프로젝트는 워크스페이스 단위 — VS Code 가 열린 폴더 하나가 곧 프로젝트.
 * 매 프로젝트마다 별도 목표·기한·청중·상태. 사용자가 동시에 idea-radar +
 * content-bot 두 프로젝트 돌리면 각 워크스페이스가 자기 project.json 가짐.
 *
 * 저장 위치: `<workspaceFolder>/.agent-os-ai/project.json`
 *   - cascade credentials 와 같은 폴더 — `.gitignore` 자동 생성 (한 곳)
 *   - 워크스페이스 안 열려있으면 null (회사 컨텍스트만으로 동작)
 *
 * 스키마는 의도적으로 작음 — 6개 필드 + 메타데이터. 더 추가하면 UI 가
 * 무거워지고 사용자가 셋업 단계에서 막힘. 필요하면 free-form `notes` 에.
 */
import * as fs from 'fs';
import * as path from 'path';

export type ProjectStatus = 'ideating' | 'validating' | 'building' | 'launched' | 'paused' | 'archived';

export interface ProjectMeta {
    /** Stable identifier — 보통 폴더 이름. 사용자가 바꿀 수 있음. */
    name: string;
    /** 한 줄 설명 — 무엇을 만들고 있는지. */
    tagline?: string;
    /** 이 프로젝트의 1차 목표. 매 dispatch 마다 에이전트들이 봄. */
    goal?: string;
    /** 목표 기한 — ISO date (YYYY-MM-DD) 또는 자유 텍스트 ("2 주 내"). */
    deadline?: string;
    /** 현재 단계 — ideating(아이디어) / validating(검증) / building(빌드)
     *  / launched(런칭) / paused(보류) / archived(종료). */
    status?: ProjectStatus;
    /** 타깃 청중 한 줄. 회사 정체성의 audience 와 별도 — 프로젝트별로 다를 수 있음. */
    audience?: string;
    /** 측정 지표 (KPI) — 최대 5개 권장. 예: ["사전예약 ≥ 10", "고객 인터뷰 ≥ 5"]. */
    kpis?: string[];
    /** 자유 노트 — 위 6 필드로 안 잡히는 컨텍스트. */
    notes?: string;
    /** 시스템 자동 관리. */
    createdAt?: string;
    updatedAt?: string;
}

const PROJECT_META_REL = path.join('.agent-os-ai', 'project.json');

function projectMetaPath(workspaceFolder: string): string {
    return path.join(workspaceFolder, PROJECT_META_REL);
}

/** Make sure `<workspace>/.agent-os-ai/.gitignore` exists and excludes
 *  credentials + project.json. project.json itself is fine to commit
 *  (no secrets) but the credentials/ subdir must stay private. */
function ensureProjectGitignore(workspaceFolder: string): void {
    try {
        const dir = path.join(workspaceFolder, '.agent-os-ai');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const gi = path.join(dir, '.gitignore');
        const want = `# Agent OS AI — local credentials only. project.json 은 commit OK.\ncredentials/\n`;
        if (!fs.existsSync(gi)) {
            fs.writeFileSync(gi, want);
            return;
        }
        const cur = fs.readFileSync(gi, 'utf-8');
        if (!cur.includes('credentials/')) {
            fs.writeFileSync(gi, cur.trimEnd() + '\n' + want);
        }
    } catch { /* never break write on gitignore failure */ }
}

/** Read the project metadata for the given workspace.
 *  Returns null when no workspace provided, file missing, or unparseable. */
export function readProjectMeta(workspaceFolder: string | undefined): ProjectMeta | null {
    if (!workspaceFolder) return null;
    try {
        const f = projectMetaPath(workspaceFolder);
        if (!fs.existsSync(f)) return null;
        const parsed = JSON.parse(fs.readFileSync(f, 'utf-8') || '{}') as ProjectMeta;
        if (!parsed || typeof parsed !== 'object') return null;
        /* Light sanitization — strip fields we don't recognize. */
        const out: ProjectMeta = {
            name: typeof parsed.name === 'string' ? parsed.name : path.basename(workspaceFolder),
        };
        if (typeof parsed.tagline === 'string') out.tagline = parsed.tagline;
        if (typeof parsed.goal === 'string') out.goal = parsed.goal;
        if (typeof parsed.deadline === 'string') out.deadline = parsed.deadline;
        if (typeof parsed.status === 'string' && isValidStatus(parsed.status)) out.status = parsed.status;
        if (typeof parsed.audience === 'string') out.audience = parsed.audience;
        if (Array.isArray(parsed.kpis)) out.kpis = parsed.kpis.filter(k => typeof k === 'string').slice(0, 10);
        if (typeof parsed.notes === 'string') out.notes = parsed.notes;
        if (typeof parsed.createdAt === 'string') out.createdAt = parsed.createdAt;
        if (typeof parsed.updatedAt === 'string') out.updatedAt = parsed.updatedAt;
        return out;
    } catch { return null; }
}

function isValidStatus(s: string): s is ProjectStatus {
    return s === 'ideating' || s === 'validating' || s === 'building'
        || s === 'launched' || s === 'paused' || s === 'archived';
}

/** Atomically write project metadata. Preserves createdAt on update,
 *  bumps updatedAt to now. Creates `.agent-os-ai/` + `.gitignore` if missing. */
export function writeProjectMeta(workspaceFolder: string, meta: ProjectMeta): { ok: boolean; error?: string } {
    if (!workspaceFolder) return { ok: false, error: '워크스페이스 폴더가 열려있어야 합니다' };
    if (!meta || typeof meta.name !== 'string' || !meta.name.trim()) {
        return { ok: false, error: '프로젝트 이름은 필수입니다' };
    }
    try {
        const dir = path.join(workspaceFolder, '.agent-os-ai');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        ensureProjectGitignore(workspaceFolder);
        const file = projectMetaPath(workspaceFolder);
        /* createdAt 보존 — 이미 있으면 그대로, 없으면 새로 */
        let createdAt = meta.createdAt;
        if (!createdAt) {
            const existing = readProjectMeta(workspaceFolder);
            createdAt = existing?.createdAt || new Date().toISOString();
        }
        const next: ProjectMeta = {
            ...meta,
            createdAt,
            updatedAt: new Date().toISOString(),
        };
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
        fs.renameSync(tmp, file);
        return { ok: true };
    } catch (e: any) {
        return { ok: false, error: e?.message || String(e) };
    }
}

/** Human-readable status label — used in UI badges + agent prompt context. */
export function statusLabel(status: ProjectStatus | undefined): string {
    switch (status) {
        case 'ideating':   return '💡 아이디어 단계';
        case 'validating': return '🔬 수요 검증 중';
        case 'building':   return '🛠 빌드 중';
        case 'launched':   return '🚀 런칭 완료';
        case 'paused':     return '⏸ 보류';
        case 'archived':   return '📦 종료';
        default:           return '';
    }
}

/** Build a short single-line summary for sidebar badges / status bars.
 *  Empty string when project not configured — UI can fall through to
 *  "프로젝트 미설정" placeholder. */
export function projectSummaryLine(meta: ProjectMeta | null): string {
    if (!meta) return '';
    const parts: string[] = [];
    parts.push(`🎯 ${meta.name}`);
    if (meta.goal) parts.push(meta.goal.length > 40 ? meta.goal.slice(0, 37) + '…' : meta.goal);
    const status = statusLabel(meta.status);
    if (status) parts.push(status);
    return parts.join(' · ');
}

/** Build the agent prompt context block for the current project. Empty
 *  string when no project metadata. Caller (agent-context.ts) inserts this
 *  between company identity and decisions log so agents see "이번 프로젝트
 *  목표·기한·상태" without overriding the broader company identity. */
export function buildProjectContextBlock(meta: ProjectMeta | null): string {
    if (!meta) return '';
    const lines: string[] = [];
    lines.push(`이름: ${meta.name}`);
    if (meta.tagline) lines.push(`설명: ${meta.tagline}`);
    if (meta.goal) lines.push(`🎯 목표: ${meta.goal}`);
    if (meta.deadline) lines.push(`📅 기한: ${meta.deadline}`);
    if (meta.status) lines.push(`📊 단계: ${statusLabel(meta.status)}`);
    if (meta.audience) lines.push(`👥 청중: ${meta.audience}`);
    if (meta.kpis && meta.kpis.length > 0) lines.push(`📈 KPI: ${meta.kpis.slice(0, 5).join(' / ')}`);
    if (meta.notes) lines.push(`📝 노트: ${meta.notes.slice(0, 400)}`);
    return `\n\n[현재 프로젝트 — 이번 워크스페이스]\n${lines.join('\n')}`;
}
