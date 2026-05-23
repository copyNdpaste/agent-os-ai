/* dispatch/chat-inflight.ts — 단일 채팅 중단 시 disk checkpoint.
   ChatInflightWriter 가 chunk 저장 / finish 처리 / 정상 완료 시 파일 삭제 /
   미완료 감지 (findInterruptedChat) 동작 검증. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    ChatInflightWriter,
    readChatInflight,
    findInterruptedChat,
    discardChatInflight,
} from '../../src/dispatch/chat-inflight';

let companyDir: string;
const inflightFile = () => path.join(companyDir, '_chat', 'inflight.json');

beforeEach(() => {
    companyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-inflight-'));
});
afterEach(() => {
    try { fs.rmSync(companyDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('dispatch/chat-inflight', () => {
    it('생성 시 즉시 _chat/inflight.json 생성 + status=running', () => {
        const w = new ChatInflightWriter({ companyDir, prompt: '안녕', modelName: 'claude-sonnet-4-6', throttleMs: 0 });

        const state = readChatInflight(companyDir);

        expect(state?.prompt).toBe('안녕');
        expect(state?.modelName).toBe('claude-sonnet-4-6');
        expect(state?.status).toBe('running');
        expect(state?.partialResponse).toBe('');
    });

    it('appendChunk 후 flush 하면 디스크 반영', () => {
        const w = new ChatInflightWriter({ companyDir, prompt: 'p', modelName: 'm', throttleMs: 0 });

        w.appendChunk('Hello ');
        w.appendChunk('World');
        w.flush();

        const state = readChatInflight(companyDir);
        expect(state?.partialResponse).toBe('Hello World');
    });

    it("finish('completed') 는 파일 통째 삭제 (다음 ready 에서 복구 카드 안 뜸)", () => {
        const w = new ChatInflightWriter({ companyDir, prompt: 'p', modelName: 'm', throttleMs: 0 });
        w.appendChunk('done');
        w.flush();
        expect(fs.existsSync(inflightFile())).toBe(true);

        w.finish('completed');

        expect(fs.existsSync(inflightFile())).toBe(false);
        expect(readChatInflight(companyDir)).toBeNull();
    });

    it("finish('aborted'|'failed') 는 status 갱신 + 파일 유지", () => {
        const w = new ChatInflightWriter({ companyDir, prompt: 'p', modelName: 'm', throttleMs: 0 });
        w.appendChunk('partial');
        w.finish('aborted', 'user pressed stop');

        const state = readChatInflight(companyDir);
        expect(state?.status).toBe('aborted');
        expect(state?.errorMessage).toBe('user pressed stop');
        expect(state?.partialResponse).toBe('partial');
    });

    it('findInterruptedChat 는 cooldown 안 지나면 null 반환', () => {
        const w = new ChatInflightWriter({ companyDir, prompt: 'p', modelName: 'm', throttleMs: 0 });
        w.flush();

        /* cooldown 기본 30초 → 방금 만든 건 안 잡힘 */
        const found = findInterruptedChat(companyDir);
        expect(found).toBeNull();
    });

    it('findInterruptedChat — lastUpdatedAt 가 cooldown 보다 오래된 running 파일 잡음', () => {
        const w = new ChatInflightWriter({ companyDir, prompt: '리서치 좀', modelName: 'm', throttleMs: 0 });
        w.appendChunk('답변 일부 …');
        w.flush();

        /* lastUpdatedAt 을 손으로 1시간 전으로 밀어버림 */
        const f = inflightFile();
        const raw = JSON.parse(fs.readFileSync(f, 'utf-8'));
        raw.lastUpdatedAt = Date.now() - 60 * 60 * 1000;
        fs.writeFileSync(f, JSON.stringify(raw));

        const found = findInterruptedChat(companyDir);
        expect(found?.prompt).toBe('리서치 좀');
        expect(found?.partialResponse).toBe('답변 일부 …');
    });

    it('discardChatInflight 파일 제거', () => {
        const w = new ChatInflightWriter({ companyDir, prompt: 'p', modelName: 'm', throttleMs: 0 });
        w.finish('aborted');
        expect(fs.existsSync(inflightFile())).toBe(true);

        discardChatInflight(companyDir);

        expect(fs.existsSync(inflightFile())).toBe(false);
    });

    it('1MB cap — partialResponse 절대 1MB 초과 안 함', () => {
        const w = new ChatInflightWriter({ companyDir, prompt: 'p', modelName: 'm', throttleMs: 0 });
        const huge = 'a'.repeat(2_000_000); /* 2MB chunk */
        w.appendChunk(huge);
        w.flush();

        const state = readChatInflight(companyDir);
        expect(state?.partialResponse.length).toBe(1_000_000);
    });
});
