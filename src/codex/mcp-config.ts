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

/** Starter pack — filesystem MCP 만 (사장님 정책: API 키 청구 방식 금지).
 *  이미지/콘텐츠 생성은 codex 빌트인 도구 (ChatGPT 구독 인증) 가 알아서 처리하므로
 *  starter pack 에 image-gen 같은 API 키 기반 MCP 는 일부러 포함하지 않음.
 *
 *  filesystem MCP 는 호출당 청구 0, 로컬 디스크만 접근 — 안전.
 *  허용 경로는 호출자가 지정 (보통 현재 워크스페이스 폴더). */
export async function setupStarterPack(allowedPath: string): Promise<{
    added: string[];
    skipped: Array<{ name: string; reason: string }>;
}> {
    if (!allowedPath || !allowedPath.trim()) {
        throw new Error('허용 경로가 비어있어요 — 워크스페이스 폴더를 열고 다시 시도해주세요');
    }
    const added: string[] = [];
    const skipped: Array<{ name: string; reason: string }> = [];

    /* 이미 등록된 서버는 skip — codex mcp add 가 conflict 에러 던지기 전에 미리 거름 */
    let existing: CodexMcpEntry[] = [];
    try {
        existing = await listCodexMcpServers();
    } catch { /* list 실패해도 일단 add 시도 — codex 가 다시 에러줄 거임 */ }
    const existingNames = new Set(existing.map(e => e.name));

    if (existingNames.has('filesystem')) {
        skipped.push({ name: 'filesystem', reason: '이미 등록됨' });
    } else {
        try {
            await addCodexMcpServer({
                name: 'filesystem',
                command: ['npx', '-y', '@modelcontextprotocol/server-filesystem', allowedPath],
            });
            added.push('filesystem');
        } catch (e: any) {
            skipped.push({ name: 'filesystem', reason: e?.message || String(e) });
        }
    }
    return { added, skipped };
}
