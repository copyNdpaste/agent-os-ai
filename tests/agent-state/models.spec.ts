import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    modelsJsonPath,
    readModelMap,
    writeModelMap,
    getModelFor,
    classifyModel,
    autoOrchestrate,
} from '../../src/agent-state/models';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'agentstate-models-'));
}

describe('agent-state/models', () => {
    let companyDir: string;

    beforeEach(() => {
        companyDir = mkTmp();
    });

    afterEach(() => {
        try { fs.rmSync(companyDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('getModelFor 는 매핑 없으면 fallback 반환', () => {
        // Given: 깨끗한 디렉터리 (agent_models.json 없음)
        // When
        const got = getModelFor(companyDir, 'ceo', 'claude-sonnet-4-6');
        // Then: fallback 그대로
        expect(got).toBe('claude-sonnet-4-6');
    });

    it('classifyModel 은 사이즈와 능력 tier 를 모두 반환한다', () => {
        // 8B 미만 small + coder 키워드
        const a = classifyModel('qwen2.5-coder:7b');
        expect(a).toContain('coder');
        expect(a).toContain('small');

        // 14B 이하 medium
        const b = classifyModel('llama3.1:13b');
        expect(b).toContain('medium');

        // 14B 초과 large
        const c = classifyModel('llama3.1:70b');
        expect(c).toContain('large');

        // 3B 이하 tiny
        const d = classifyModel('llama3.2:3b');
        expect(d).toContain('tiny');

        // vision 키워드 + 사이즈
        const e = classifyModel('llava:13b');
        expect(e).toContain('vision');

        // 사이즈 정보 전혀 없음 → small 폴백
        const f = classifyModel('unknown-model');
        expect(f).toEqual(['small']);
    });

    it('autoOrchestrate 는 installed 가 비어있으면 빈 매핑', () => {
        const map = autoOrchestrate([], ['ceo', 'secretary']);
        expect(map).toEqual({});
    });

    it('autoOrchestrate 는 각 에이전트 역할에 맞춰 최적 tier 모델을 매칭한다', () => {
        // Given: 다양한 사이즈의 모델 (메모리 제한에 안 걸리도록 작은 것 위주)
        const installed = [
            { id: 'llama3.2:1b', backend: 'ollama' },       // tiny
            { id: 'qwen2.5-coder:7b', backend: 'ollama' },  // small + coder
            { id: 'llama3.1:8b', backend: 'ollama' },       // small
        ];

        // When
        const map = autoOrchestrate(installed);

        // Then: 적어도 일부 에이전트는 배정됨 (시스템 specs 따라 다를 수 있으나
        // safe filter 가 전부 잘라도 최소 1개는 살리는 폴백이 있어 결과 비지 않음)
        expect(Object.keys(map).length).toBeGreaterThan(0);
        /* CEO 는 tiny/small/medium 선호 — 어떤 작은 모델이라도 배정돼야 함 */
        expect(map.ceo).toBeDefined();
        /* developer 는 coder 선호 — qwen2.5-coder:7b 가 후보로 살아있다면 우선 매칭 */
        if (map.developer) {
            expect([
                'qwen2.5-coder:7b',
                'llama3.1:8b',
                'llama3.2:1b',
            ]).toContain(map.developer);
        }
    });

    it('write→read 라운드트립이 동일한 매핑을 반환한다', () => {
        // Given: 임의 매핑
        const input = {
            ceo: 'claude-haiku-4-5-20251001',
            secretary: 'claude-sonnet-4-6',
            developer: 'claude-opus-4-7',
        };

        // When: 디스크에 쓰고 다시 읽기
        writeModelMap(companyDir, input);
        const out = readModelMap(companyDir);

        // Then: 동일 객체
        expect(out).toEqual(input);
        // And: 디스크에 파일 존재
        expect(fs.existsSync(modelsJsonPath(companyDir))).toBe(true);
    });

    it('getModelFor 는 매핑에 빈 문자열이 있으면 fallback', () => {
        // Given: 매핑이 있지만 값이 비어있음 (원본 (map[id] || '').trim() || fallback 로직)
        writeModelMap(companyDir, { ceo: '   ' });

        // When
        const got = getModelFor(companyDir, 'ceo', 'claude-sonnet-4-6');

        // Then: 빈 값은 무시되고 fallback
        expect(got).toBe('claude-sonnet-4-6');
    });
});
