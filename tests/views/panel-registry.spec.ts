/* views/panel-registry — markOpen/markClosed/getOpenPanels 가 globalState
   에 정확히 영속하고 read back 도 동일한지 검증. ExtensionContext 는 메모리
   Map 기반 stub 으로 대체. */
import { describe, it, expect, beforeEach } from 'vitest';
import { markOpen, markClosed, getOpenPanels, setRegistryContext } from '../../src/views/panel-registry';

interface MemoryState {
    [k: string]: unknown;
}

function makeStubContext() {
    const store: MemoryState = {};
    return {
        globalState: {
            get<T>(key: string, def?: T): T {
                return (key in store ? store[key] : def) as T;
            },
            update(key: string, value: unknown): Thenable<void> {
                store[key] = value;
                return Promise.resolve();
            },
            keys(): readonly string[] { return Object.keys(store); },
            setKeysForSync(_keys: readonly string[]): void { /* no-op */ },
        },
        /* Rest of ExtensionContext is irrelevant to the registry. Cast loosely
           via `as any` in the test instead of stubbing 30 fields. */
    } as any;
}

beforeEach(() => {
    /* New context each test → fresh storage. */
    setRegistryContext(makeStubContext());
});

describe('views/panel-registry', () => {
    it('빈 상태에서 getOpenPanels 는 빈 배열', () => {
        expect(getOpenPanels()).toEqual([]);
    });

    it('markOpen 누적, getOpenPanels 정렬된 array', () => {
        markOpen('office');
        markOpen('company-dashboard');

        expect(getOpenPanels().sort()).toEqual(['company-dashboard', 'office']);
    });

    it('같은 panel markOpen 두 번 = 중복 없음', () => {
        markOpen('office');
        markOpen('office');

        expect(getOpenPanels()).toEqual(['office']);
    });

    it('markClosed 는 해당 panel 만 제거', () => {
        markOpen('office');
        markOpen('api-connections');
        markOpen('revenue-dashboard');

        markClosed('api-connections');

        expect(getOpenPanels().sort()).toEqual(['office', 'revenue-dashboard']);
    });

    it('없는 panel markClosed = no-op', () => {
        markOpen('office');

        markClosed('revenue-dashboard');

        expect(getOpenPanels()).toEqual(['office']);
    });

    it('이전 세션 stub state → setRegistryContext 후 그대로 복원됨', () => {
        const ctx = makeStubContext();
        ctx.globalState.update('agentOs.openPanels.v1', ['office', 'company-dashboard']);
        setRegistryContext(ctx);

        expect(getOpenPanels().sort()).toEqual(['company-dashboard', 'office']);
    });

    it('알 수 없는 키는 필터링 (이전 버전 마이그레이션 안전)', () => {
        const ctx = makeStubContext();
        ctx.globalState.update('agentOs.openPanels.v1', ['office', 'legacy-panel', 'something-removed']);
        setRegistryContext(ctx);

        expect(getOpenPanels()).toEqual(['office']);
    });
});
