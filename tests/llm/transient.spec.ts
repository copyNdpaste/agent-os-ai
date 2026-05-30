import { describe, it, expect } from 'vitest';
import { isTransientLLMError } from '../../src/llm/index';

/* v2.92.x — 에이전트 "자꾸 실패" 진짜 원인은 일시적 API 오류였다. streamAsk 가 이걸
   감지해 자동 재시도한다. 분류기가 진짜 일시 오류만 잡고 영구 오류(설치/인증/취소)는
   재시도하지 않도록 고정한다. */
describe('isTransientLLMError', () => {
    it('Claude CLI agentic 루프의 thinking 블록 400 → 재시도 대상', () => {
        const msg = 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.45: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response."}}';
        expect(isTransientLLMError(msg)).toBe(true);
    });

    it('overloaded(529) → 재시도 대상', () => {
        expect(isTransientLLMError('API Error: 529 {"type":"overloaded_error"}')).toBe(true);
    });

    it('rate limit(429) → 재시도 대상', () => {
        expect(isTransientLLMError('Error: 429 rate_limit_error: too many requests')).toBe(true);
    });

    it('5xx 서버 오류 → 재시도 대상', () => {
        expect(isTransientLLMError('Claude CLI exited 1: API Error: 500 Internal server error')).toBe(true);
        expect(isTransientLLMError('upstream connect error 503 service unavailable')).toBe(true);
    });

    it('네트워크 끊김 → 재시도 대상', () => {
        expect(isTransientLLMError('fetch failed: ECONNRESET')).toBe(true);
        expect(isTransientLLMError('socket hang up')).toBe(true);
    });

    it('CLI 미설치(ENOENT) → 재시도 안 함 (영구 오류)', () => {
        expect(isTransientLLMError("Claude CLI not found at 'claude'. spawn ENOENT")).toBe(false);
    });

    it('타임아웃 → 재시도 안 함 (다시 띄워도 또 멈춤)', () => {
        expect(isTransientLLMError('Claude CLI timed out: idle 900s — 응답 멈춤')).toBe(false);
    });

    it('사용자 중단(aborted) → 재시도 안 함', () => {
        expect(isTransientLLMError('request aborted by user')).toBe(false);
    });

    it('일반 인증 만료 같은 비일시 오류 → 재시도 안 함', () => {
        expect(isTransientLLMError('Invalid API key / authentication_error')).toBe(false);
    });
});
