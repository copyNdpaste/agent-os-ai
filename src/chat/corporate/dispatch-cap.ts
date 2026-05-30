/**
 * Phase: Dispatch hard-cap.
 *
 * 사장님 좌절 사례 — 단순 명령 (".sh 안 됨", "GUI 켜줘", "/디버깅", "왜 안 돼?")
 * 에도 CEO LLM 이 ceo-planner.md 의 "최소 동원 원칙" 을 무시하고 5~9명 specialist
 * 를 다 호출 → 9건 LLM round → 각자 read·grep 만 잔뜩 하고 timeout. 사장님 결과 = 0.
 *
 * 시스템 측 hard cap 으로 LLM 의지박약 보강:
 *  - 단순 조회/디버깅/실행 명령 → specialist 1명 cap (CEO 가 5명 분배해도 1명만 남김).
 *  - 일반 명령 → 최대 3명 cap.
 *  - 사장님이 명시적으로 "전 직원", "9명 다", "모두" 같은 광범위 동원을 요청한
 *    경우만 cap 풀기.
 *
 * Trim 시 채팅에 한 줄 알림. 기존 fallback 로직 (sidebar-chat.ts:3189 근처)
 * 다음 단계에서 호출되도록 plan.tasks 만 in-place 수정한다.
 */
import type { Plan } from './types';

/** 단순 조회/디버깅/실행 — specialist 1명이면 충분.
 *  사장님 사례: ".sh 안 돼", "GUI 켜줘", "/디버깅", "에러 떴어", "왜 안 돼".
 *  CEO 가 5명 분배해도 시스템이 1명만 남김. */
const SIMPLE_COMMAND_RE = /(?:켜줘|켜봐|실행(?:해|하고|시켜)?|돌려(?:봐|줘)?|돌아가|안\s*(?:돼|됨|되|켜져|열려|작동|실행|동작)|에러|exception|stack ?trace|디버깅|디버그|debug|확인(?:해|만|해줘)?|상태|status|뭐야|뭐예요|왜\s*안\s*(?:돼|됨|되)|스크립트(?:가)?|이게\s*맞|맞는\s*거|맞나요|꺼져|꺼봐|로그|log|보여줘|찍어줘|체크(?:해)?|test|테스트(?:해|만)?|works?|동작.*안|작동.*안|\.sh\b|\.py\b|\.ts\b|\.js\b|F5|단축키)/i;

/** 사장님이 명시적으로 전 직원 동원 요청 — cap 풀기. */
const BROAD_REQUEST_RE = /전\s*직원|모든\s*(?:직원|에이전트|specialist)|9\s*명\s*(?:다|모두|전부)|specialist\s*(?:다|모두|전부)|총동원|올스타|all\s*hands|everyone|모두\s*소집|다\s*모여|다\s*같이/i;

const COLLABORATION_LANES: RegExp[] = [
    /리서치|research|조사|경쟁사|competitor|벤치마크|benchmark|트렌드|trend|시장|market/i,
    /디자인|design|색|컬러|color|레이아웃|layout|버튼|button|ui|ux|컴포넌트|component|타이포|폰트|font|랜딩|landing|페이지|page|css|tailwind/i,
    /코드|코딩|개발|구현|api|배포|deploy|리팩|refactor|타입|typescript|tsx|빌드|build|컴파일|compile|e2e|테스트|검증/i,
    /카피|copy|글|문구|텍스트|응답|답변|콘텐츠|보고서|문서|스레드|threads|트윗|tweet|블로그|blog/i,
    /매출|수익|결제|paypal|revenue|매상|월 매출|페이팔|비즈니스|사업|모델|가격|pricing|수익화|수요검증|mvp/i,
];

function collaborationLaneCount(prompt: string): number {
    return COLLABORATION_LANES.reduce((count, re) => count + (re.test(prompt) ? 1 : 0), 0);
}

/** 우선순위 점수 — 명령에 가장 잘 맞는 specialist 부터 남김.
 *  점수 높은 1~3명만 살리고 나머지 trim. */
function scoreAgentForPrompt(agentId: string, prompt: string): number {
    const p = prompt.toLowerCase();
    let s = 0;
    switch (agentId) {
        case 'developer':
            if (/코드|코딩|개발|구현|버그|함수|api|배포|deploy|리팩|refactor|타입|typescript|tsx|에러|exception|stack ?trace|\.sh\b|\.py\b|\.ts\b|\.js\b|스크립트|디버깅|debug|컴파일|compile|build|빌드|테스트|검증|e2e|f5|익스텐션|extension|vscode/i.test(p)) s += 10;
            break;
        case 'designer':
            if (/디자인|design|색|컬러|color|레이아웃|layout|버튼|button|ui|ux|컴포넌트|component|타이포|폰트|font|랜딩|landing|페이지|page|css|tailwind|tsx/i.test(p)) s += 10;
            break;
        case 'writer':
            if (/카피|copy|글|문구|텍스트|응답|답변|콘텐츠 ?문|보고서|문서|광고\s*카피|랜딩\s*카피|스레드|threads|트윗|tweet|블로그|blog/i.test(p)) s += 10;
            break;
        case 'researcher':
            if (/리서치|research|조사|경쟁사|competitor|벤치마크|benchmark|트렌드|trend|시장|market/i.test(p)) s += 10;
            break;
        case 'business':
            if (/매출|수익|결제|paypal|revenue|매상|월 매출|페이팔|돈|얼마 벌|비즈니스|사업|모델|가격|pricing|수익화/i.test(p)) s += 10;
            break;
        case 'editor':
            if (/영상|video|편집|edit|썸네일|thumbnail|쇼츠|shorts|훅|hook/i.test(p)) s += 10;
            break;
        case 'instagram':
            if (/인스타|instagram|릴스|reels|스토리|story/i.test(p)) s += 10;
            break;
        case 'youtube':
            if (/유튜브|youtube|채널|구독자|조회수|영상\s*\d+/i.test(p)) s += 10;
            break;
        case 'secretary':
            if (/일정|미팅|메일|이메일|email|메모|memo|정리해|요약해|summary/i.test(p)) s += 10;
            break;
    }
    return s;
}

export type DispatchCapResult =
    | { kind: 'simple'; originalCount: number; trimmedCount: number; message: string }
    | { kind: 'cap'; originalCount: number; trimmedCount: number; message: string }
    | { kind: 'broad'; originalCount: number; message: string }
    | { kind: 'noop'; originalCount: number };

/**
 * Apply hard cap to plan.tasks. Mutates `plan.tasks` in place and returns
 * a result describing the action taken (so the caller can post a one-line
 * notice to chat / sessionWriter).
 *
 * Rules:
 *  1. Broad request keyword present → no trim, return 'broad'.
 *  2. Simple command (debug/status/exec keyword) → keep only the highest
 *     scoring 1 specialist.
 *  3. Otherwise → cap at 3 by score order.
 */
export function applyDispatchCap(plan: Plan, prompt: string): DispatchCapResult {
    const originalCount = plan.tasks.length;
    if (originalCount <= 1) return { kind: 'noop', originalCount };

    if (BROAD_REQUEST_RE.test(prompt)) {
        return {
            kind: 'broad',
            originalCount,
            message: `🛡️ 광범위 동원 요청 감지 — specialist ${originalCount}명 cap 해제 (사장님 명시 지시).`,
        };
    }

    const isCollaborative = collaborationLaneCount(prompt) >= 2;
    const isSimple = SIMPLE_COMMAND_RE.test(prompt) && !isCollaborative;
    const targetCap = isSimple ? 1 : 3;
    if (originalCount <= targetCap) return { kind: 'noop', originalCount };

    /* 점수 기준 정렬 — 점수 동률이면 원래 CEO 순서 유지 (stable sort). */
    const indexed = plan.tasks.map((t, i) => ({ t, i, score: scoreAgentForPrompt(t.agent, prompt) }));
    indexed.sort((a, b) => (b.score - a.score) || (a.i - b.i));
    const kept = indexed.slice(0, targetCap).sort((a, b) => a.i - b.i).map(x => x.t);
    plan.tasks = kept;

    if (isSimple) {
        return {
            kind: 'simple',
            originalCount,
            trimmedCount: kept.length,
            message: `⚠️ 단순 명령으로 판단 → specialist 1명만 동원 (CEO 분배 ${originalCount}명 → ${kept.length}명 trim). 광범위 동원 원하면 "전 직원" 등 명시.`,
        };
    }
    return {
        kind: 'cap',
        originalCount,
        trimmedCount: kept.length,
        message: `⚠️ specialist ${targetCap}명 cap 적용 (CEO 분배 ${originalCount}명 → ${kept.length}명 trim). 광범위 동원 원하면 "전 직원" 등 명시.`,
    };
}
