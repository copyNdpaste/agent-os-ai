/* Codex MCP wrapper — `codex mcp` 서브명령을 spawn 해서 ~/.codex/config.toml
   안 mcp_servers 섹션을 관리. 직접 TOML 파싱 안 하고 codex 가 알아서
   읽고 쓰게 위임 (스키마 변경 호환).

   ⚠️ 정책 (memory feedback-image-gen-via-codex-mcp):
   이미지/콘텐츠 생성은 OpenAI API 직접 호출 금지 — codex CLI 의 빌트인/MCP
   도구만 사용. starter pack 에 API 키 청구 방식 MCP (image-gen 등) 추가 금지.
   filesystem 처럼 호출당 청구 없는 도구만 포함. */
import { spawn } from 'child_process';
import { resolveCodexBin, buildSpawnEnv } from '../llm';

export interface CodexMcpEntry {
    name: string;
    command: string;
    args: string;     /* 공백으로 join 된 표시용 */
    env: string;      /* `KEY=*****, ...` 형태로 마스킹된 표시용 */
    status: string;   /* enabled / disabled */
    auth: string;     /* Unsupported / Supported / authed */
}

interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
}

function runCodex(args: string[], timeoutMs = 15_000): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        const bin = resolveCodexBin();
        if (!bin) return reject(new Error('Codex CLI 경로를 찾지 못했어요. agentOs.codexBinPath 설정 또는 `npm install -g @openai/codex`.'));
        let stdout = '';
        let stderr = '';
        let settled = false;
        const child = spawn(bin, args, { env: buildSpawnEnv(bin) });
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { child.kill('SIGTERM'); } catch { /* already dead */ }
            reject(new Error(`codex ${args.join(' ')} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
        child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
        child.on('error', (e: NodeJS.ErrnoException) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (e.code === 'ENOENT') {
                reject(new Error(`Codex CLI not found at '${bin}'. 설치: \`npm install -g @openai/codex\``));
            } else {
                reject(e);
            }
        });
        child.on('close', (code: number | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ code: code ?? -1, stdout, stderr });
        });
    });
}

/** `codex mcp list` 결과를 파싱. 헤더 라인 + 각 server 1줄.
 *  컬럼은 가변 공백으로 구분 — 2-space 이상을 separator 로 split. */
export async function listCodexMcpServers(): Promise<CodexMcpEntry[]> {
    const r = await runCodex(['mcp', 'list']);
    if (r.code !== 0) {
        throw new Error(`codex mcp list 실패: ${(r.stderr || r.stdout || '').trim() || `exit ${r.code}`}`);
    }
    const lines = r.stdout.split('\n').map(l => l.trimEnd()).filter(Boolean);
    if (lines.length < 2) return [];
    const out: CodexMcpEntry[] = [];
    /* 헤더 행 skip. 본문: Name Command Args Env Cwd Status Auth */
    for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(/\s{2,}/).map(p => p.trim());
        if (parts.length < 2) continue;
        out.push({
            name: parts[0] || '',
            command: parts[1] || '',
            args: parts[2] === '-' ? '' : (parts[2] || ''),
            env: parts[3] === '-' ? '' : (parts[3] || ''),
            status: parts[5] || '',
            auth: parts[6] || '',
        });
    }
    return out;
}

export interface AddOptions {
    /** MCP 서버 이름 (config.toml 의 [mcp_servers.<name>] 키) */
    name: string;
    /** stdio 서버: 실행 명령 + 인자. 예: ['npx', '-y', '@modelcontextprotocol/server-filesystem', '/workspace'] */
    command: string[];
    /** 환경변수 (선택) */
    env?: Record<string, string>;
}

/** 단일 MCP 서버 추가. 이미 있으면 codex 가 conflict 에러 — 호출 측에서 처리. */
export async function addCodexMcpServer(opts: AddOptions): Promise<void> {
    if (!opts.name || !opts.name.trim()) throw new Error('MCP 서버 이름이 비어있어요');
    if (!Array.isArray(opts.command) || opts.command.length === 0) throw new Error('command 가 비어있어요');
    const args = ['mcp', 'add', opts.name];
    if (opts.env) {
        for (const [k, v] of Object.entries(opts.env)) {
            args.push('--env', `${k}=${v}`);
        }
    }
    args.push('--', ...opts.command);
    const r = await runCodex(args);
    if (r.code !== 0) {
        const msg = (r.stderr || r.stdout || '').trim() || `exit ${r.code}`;
        throw new Error(`codex mcp add 실패: ${msg}`);
    }
}

export async function removeCodexMcpServer(name: string): Promise<void> {
    if (!name || !name.trim()) throw new Error('이름이 비어있어요');
    const r = await runCodex(['mcp', 'remove', name]);
    if (r.code !== 0) {
        const msg = (r.stderr || r.stdout || '').trim() || `exit ${r.code}`;
        throw new Error(`codex mcp remove 실패: ${msg}`);
    }
}

/** Filesystem MCP placeholder 등록 — path 박지 않음 (의도된 동작).
 *
 *  ⚠️ 핵심 디자인: 글로벌 ~/.codex/config.toml 에 filesystem MCP 의 *형태* 만
 *  등록해두고 (npx + 패키지명까지만), 실제 허용 경로 (`args` 의 마지막 요소) 는
 *  **codex-cli.ts 가 매 호출마다 현재 워크스페이스로 -c override**.
 *
 *  이게 필요한 이유:
 *  - alpha-agent-ai 에서 설정 → 글로벌 path 에 alpha-agent-ai 박힘
 *  - content-bot-ai 워크스페이스 열고 codex 호출 → filesystem MCP 는 여전히
 *    alpha-agent-ai 가리킴 → 워크스페이스간 누수 발생
 *  - 그래서 글로벌엔 placeholder, 호출 시점에 동적 path 주입.
 *
 *  사용자 시각: 한 번만 "설정" 클릭하면 모든 워크스페이스에서 자동으로 자기
 *  폴더만 접근. content-bot-ai 가서도 다시 설정 안 해도 됨. */
export const FILESYSTEM_PLACEHOLDER_PATH = '/__agent_os_ai_dynamic__';

export async function setupStarterPack(_allowedPath?: string): Promise<{
    added: string[];
    skipped: Array<{ name: string; reason: string }>;
}> {
    /* allowedPath 인자는 backwards-compat 으로 받지만 더 이상 사용 안 함.
       실제 path 는 호출 시점에 codex-cli.ts 에서 동적 override. */
    const added: string[] = [];
    const skipped: Array<{ name: string; reason: string }> = [];

    let existing: CodexMcpEntry[] = [];
    try {
        existing = await listCodexMcpServers();
    } catch { /* list 실패해도 add 시도 */ }
    const existingNames = new Set(existing.map(e => e.name));

    if (existingNames.has('filesystem')) {
        skipped.push({ name: 'filesystem', reason: '이미 등록됨 (path 는 호출 시 현재 워크스페이스로 자동 override)' });
    } else {
        try {
            /* placeholder path — codex-cli.ts 가 -c 로 매번 override 함.
               이 path 가 실제로 쓰이는 일은 없음 (override 못 받으면 codex 가
               존재 안 하는 dir 에러로 빨리 실패 → 디버깅 용이) */
            await addCodexMcpServer({
                name: 'filesystem',
                command: ['npx', '-y', '@modelcontextprotocol/server-filesystem', FILESYSTEM_PLACEHOLDER_PATH],
            });
            added.push('filesystem');
        } catch (e: any) {
            skipped.push({ name: 'filesystem', reason: e?.message || String(e) });
        }
    }
    return { added, skipped };
}
