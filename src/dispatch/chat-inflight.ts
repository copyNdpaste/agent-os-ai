/**
 * Single-turn chat inflight checkpoint.
 *
 * `_handleCorporatePrompt` 는 dispatch 단위로 sessions/{ts}/state.json 을 쓰지만
 * `_handlePrompt` (사이드바 단일 LLM 호출) 는 그동안 disk 흔적이 없었다 — 응답
 * 도중 VS Code 가 죽으면 사용자는 자기가 뭘 물었는지·어디까지 답이 왔었는지
 * 알 수 없었음. 이 모듈이 채워준다.
 *
 * 정책:
 *  - 한 번에 하나만 추적 (사용자가 동시에 사이드바 두 프롬프트 보내지 않음).
 *  - `_chat/inflight.json` 단일 파일에 prompt + 누적 응답 + status 저장.
 *  - 스트리밍 중 1초 throttle, finish() 는 즉시 flush.
 *  - 정상 완료 시 파일 삭제 (다음 ready 에서 복구 카드 안 뜨게).
 *  - 미완료 (status='running' && 30초 이상 정지) 면 ready 에서 복구 카드.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface ChatInflightState {
    schema: 1;
    prompt: string;
    modelName: string;
    startedAt: number;
    lastUpdatedAt: number;
    status: 'running' | 'completed' | 'aborted' | 'failed';
    /** Streamed AI response so far (truncated to MAX_CAPTURE bytes to keep
     *  the file size bounded — 1MB cap is plenty for any chat turn). */
    partialResponse: string;
    errorMessage?: string;
}

const MAX_CAPTURE = 1_000_000; /* 1MB cap on captured response */

function inflightDir(companyDir: string): string {
    return path.join(companyDir, '_chat');
}
function inflightPath(companyDir: string): string {
    return path.join(inflightDir(companyDir), 'inflight.json');
}

export class ChatInflightWriter {
    private state: ChatInflightState;
    private filePath: string;
    private throttleMs: number;
    private throttleTimer: NodeJS.Timeout | null = null;

    constructor(args: {
        companyDir: string;
        prompt: string;
        modelName: string;
        throttleMs?: number;
    }) {
        this.filePath = inflightPath(args.companyDir);
        this.throttleMs = args.throttleMs ?? 1000;
        const now = Date.now();
        this.state = {
            schema: 1,
            prompt: args.prompt,
            modelName: args.modelName,
            startedAt: now,
            lastUpdatedAt: now,
            status: 'running',
            partialResponse: '',
        };
        this.flushNow();
    }

    appendChunk(chunk: string): void {
        if (this.state.partialResponse.length >= MAX_CAPTURE) return;
        this.state.partialResponse = (this.state.partialResponse + chunk).slice(0, MAX_CAPTURE);
        this.markDirty();
    }

    finish(status: 'completed' | 'aborted' | 'failed', error?: string): void {
        if (this.throttleTimer) {
            clearTimeout(this.throttleTimer);
            this.throttleTimer = null;
        }
        if (status === 'completed') {
            /* 정상 종료 — 파일 자체를 지움. 다음 ready 에서 복구 카드 안 뜸. */
            try {
                if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
            } catch { /* ignore */ }
            return;
        }
        this.state.status = status;
        if (error) this.state.errorMessage = error;
        this.state.lastUpdatedAt = Date.now();
        this.flushNow();
    }

    /** Force flush — useful before risky operations / in tests. */
    flush(): void {
        if (this.throttleTimer) {
            clearTimeout(this.throttleTimer);
            this.throttleTimer = null;
        }
        this.flushNow();
    }

    private markDirty(): void {
        if (this.throttleTimer) return;
        this.throttleTimer = setTimeout(() => {
            this.throttleTimer = null;
            this.flushNow();
        }, this.throttleMs);
    }

    private flushNow(): void {
        this.state.lastUpdatedAt = Date.now();
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const tmp = this.filePath + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf-8');
            fs.renameSync(tmp, this.filePath);
        } catch (e) {
            console.error('[chat-inflight] flush failed:', e);
        }
    }
}

export function readChatInflight(companyDir: string): ChatInflightState | null {
    try {
        const f = inflightPath(companyDir);
        if (!fs.existsSync(f)) return null;
        const parsed = JSON.parse(fs.readFileSync(f, 'utf-8') || '{}') as ChatInflightState;
        if (!parsed || parsed.schema !== 1) return null;
        return parsed;
    } catch { return null; }
}

/** Returns the inflight state only if it represents a real interruption
 *  (status='running' and not just-now started). `cooldownMs` defaults to 30s
 *  so the in-flight dispatch of this very moment doesn't surface to itself. */
export function findInterruptedChat(companyDir: string, opts: { cooldownMs?: number; maxAgeMs?: number } = {}): ChatInflightState | null {
    const cooldownMs = opts.cooldownMs ?? 30_000;
    const maxAgeMs = opts.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
    const state = readChatInflight(companyDir);
    if (!state) return null;
    if (state.status !== 'running') return null;
    const age = Date.now() - state.lastUpdatedAt;
    if (age < cooldownMs) return null;
    if (age > maxAgeMs) return null;
    return state;
}

/** Discard the inflight file unconditionally — used by the recovery card's
 *  "폐기" button. No-op if file already gone. */
export function discardChatInflight(companyDir: string): void {
    try {
        const f = inflightPath(companyDir);
        if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch { /* ignore */ }
}
