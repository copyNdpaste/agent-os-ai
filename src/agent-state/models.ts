/**
 * Agent ↔ Claude model routing (`_shared/agent_models.json`).
 *
 * extension.ts 에서 분리됨 (god-file Agent-state 모듈화). 각 에이전트가 어떤
 * Claude 모델(Opus/Sonnet/Haiku 등) 을 쓸지 매핑 + 자동 오케스트레이션 로직.
 *
 * companyDir 와 agentOrder 는 외부에서 주입한다. 모델 분류는 순수 함수
 * (classifyModel) — 외부 의존성 없음. 시스템 메모리 추정/필터링이 필요한
 * autoOrchestrate 만은 `../system-specs` 의 헬퍼를 사용한다.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getSystemSpecs, estimateModelMemoryGB } from '../system-specs';

/** 모델 능력 분류. 한 모델이 여러 tier 에 동시 속할 수 있다 (예: vision + medium). */
export type ModelTier = 'tiny' | 'small' | 'medium' | 'large' | 'vision' | 'coder';

/** Disk location for the per-company agent→model map. */
export function modelsJsonPath(companyDir: string): string {
    return path.join(companyDir, '_shared', 'agent_models.json');
}

export function readModelMap(companyDir: string): Record<string, string> {
    try {
        const p = modelsJsonPath(companyDir);
        if (!fs.existsSync(p)) return {};
        const data = JSON.parse(fs.readFileSync(p, 'utf-8') || '{}');
        return (data && typeof data === 'object') ? data : {};
    } catch { return {}; }
}

export function writeModelMap(companyDir: string, map: Record<string, string>): void {
    try {
        const p = modelsJsonPath(companyDir);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(map, null, 2));
    } catch (e: any) {
        console.warn('[agentModels] write failed:', e?.message || e);
    }
}

/** 특정 에이전트에 매핑된 모델 id. 매핑이 없으면 fallback. 빈 문자열도 fallback 처리. */
export function getModelFor(companyDir: string, agentId: string, fallback: string): string {
    const map = readModelMap(companyDir);
    return (map[agentId] || '').trim() || fallback;
}

/**
 * 모델 id 문자열을 보고 어떤 tier 에 속하는지 분류. 순수 함수 — 외부 호출 없음.
 *
 * - vision: 이미지 입력 가능 (llava, vl, vision 키워드)
 * - coder: 코드 특화 (coder, code-llama, code-qwen)
 * - tiny/small/medium/large: 파라미터 수(B 단위) 기반. MoE 는 활성 파라미터 기준.
 */
export function classifyModel(modelId: string): ModelTier[] {
    const id = modelId.toLowerCase();
    const tiers: ModelTier[] = [];
    /* 비전 모델 — 이미지 입력 가능 */
    if (/vision|llava|vl\b|glm.*v|gemma.?4.*e|qwen.?2.?vl|moondream/i.test(id)) tiers.push('vision');
    /* 코드 특화 */
    if (/coder|code-?(?:llama|qwen)/i.test(id)) tiers.push('coder');
    /* 사이즈 — 우선순위: 명시된 파라미터 → 모델 이름 패턴 */
    const paramM = id.match(/(\d+(?:\.\d+)?)\s*b\b/);
    let paramB = paramM ? parseFloat(paramM[1]) : 0;
    /* MoE 모델은 활성 파라미터 기준으로 분류 (예: "24b a2b" = 활성 2B) */
    const moeM = id.match(/a(\d+(?:\.\d+)?)b/);
    if (moeM) paramB = parseFloat(moeM[1]);
    /* LFM 패밀리 + Phi + Gemma E2B 같이 작은 모델 패턴 */
    const isExplicitlyTiny = /lfm2\.?5|gemma.?4.?e2b|phi-?3|llama.?3\.?2.?(?:1b|3b)|qwen.?2\.?5.?(?:0\.5b|1\.5b|3b)/i.test(id);
    if (isExplicitlyTiny || (paramB > 0 && paramB <= 3)) tiers.push('tiny');
    else if (paramB <= 8) tiers.push('small');
    else if (paramB <= 14) tiers.push('medium');
    else if (paramB > 14) tiers.push('large');
    else tiers.push('small'); /* 사이즈 알 수 없으면 small 로 안전 폴백 */
    return tiers;
}

/** 에이전트 역할별 선호 tier 순서. 첫번째가 best, 못 찾으면 다음으로 폴백. */
const ROLE_PREFERENCES: Record<string, ModelTier[]> = {
    ceo: ['tiny', 'small', 'medium'],         /* 라우팅 결정 — 빠른 게 최우선 */
    secretary: ['small', 'tiny', 'medium'],   /* 일정·대화 — 균형 */
    youtube: ['large', 'medium', 'small'],    /* 데이터 분석 — 큰 모델 */
    researcher: ['large', 'medium', 'small'], /* 리서치 — 큰 모델 */
    business: ['medium', 'large', 'small'],   /* KPI·전략 — 추론 */
    writer: ['medium', 'small', 'large'],     /* 창작 — 중간 */
    editor: ['medium', 'small'],              /* 영상 디렉션 */
    designer: ['vision', 'medium', 'small'],  /* 비전 우선 */
    developer: ['coder', 'large', 'medium'],  /* 코드 우선 */
    instagram: ['medium', 'small'],
};

/**
 * 설치된 모델 목록을 받아 에이전트별 최적 모델 매핑을 자동 생성.
 *
 * - 시스템 메모리 한계로 못 돌리는 큰 모델은 사전 필터링(getSystemSpecs).
 * - 안전 필터로 전부 잘려나가면 제일 작은 모델 1개라도 후보로 남김.
 * - 각 에이전트의 ROLE_PREFERENCES 순서대로 첫번째로 매칭되는 모델을 배정.
 *
 * agentOrder 는 caller (extension.ts) 가 주입하지만, ROLE_PREFERENCES 의 키 집합과
 * 다른 경우 ROLE_PREFERENCES 키 우선 — agentOrder 는 향후 확장용 파라미터.
 */
export function autoOrchestrate(
    installed: { id: string; backend: string }[],
    _agentOrder: readonly string[] = []
): Record<string, string> {
    if (installed.length === 0) return {};
    const specs = getSystemSpecs();
    const safeInstalled = installed.filter(m => {
        const need = estimateModelMemoryGB(m.id);
        return need <= specs.safeModelBudgetGB;
    });
    /* 안전 필터로 다 잘려나가면 제일 작은 1개라도 남기기 */
    const candidates = safeInstalled.length > 0 ? safeInstalled : (
        installed.length > 0
            ? [installed.slice().sort((a, b) => estimateModelMemoryGB(a.id) - estimateModelMemoryGB(b.id))[0]]
            : []
    );
    /* 모델별 tier 분류 + 우선순위 정렬 */
    const byTier: Record<ModelTier, string[]> = { tiny: [], small: [], medium: [], large: [], vision: [], coder: [] };
    for (const m of candidates) {
        const tiers = classifyModel(m.id);
        for (const t of tiers) byTier[t].push(m.id);
    }
    const map: Record<string, string> = {};
    for (const agentId of Object.keys(ROLE_PREFERENCES)) {
        const prefs = ROLE_PREFERENCES[agentId];
        for (const tier of prefs) {
            const ms = byTier[tier];
            if (ms && ms.length > 0) {
                map[agentId] = ms[0];
                break;
            }
        }
    }
    return map;
}
