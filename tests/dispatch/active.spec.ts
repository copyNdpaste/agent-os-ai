import { describe, it, expect, vi } from 'vitest';

/* dispatch/active.ts 는 module-private Map state 를 갖는다. 매 테스트마다
   vi.resetModules() + dynamic import 로 깨끗한 모듈 인스턴스를 받는다.
   프로덕션 API 에 __reset 같은 노이즈를 두지 않기 위함. */
type DispatchModule = typeof import('../../src/dispatch/active');

async function freshModule(): Promise<DispatchModule> {
    vi.resetModules();
    return await import('../../src/dispatch/active');
}

describe('dispatch/active', () => {
    it('start 는 새 entry 를 추가하고 동일 키로 재사용할 수 있다', async () => {
        // Given: 깨끗한 모듈
        const mod = await freshModule();

        // When: 첫 start
        const a = mod.start('유튜브 분석', false);

        // Then: 반환된 entry 의 모양이 맞고, find 로 같은 prompt 매칭됨
        expect(a.step).toBe('준비 중');
        expect(a.fromTelegram).toBe(false);
        expect(typeof a.startedAt).toBe('number');
        expect(mod.find('유튜브 분석')).not.toBeNull();

        // And: 같은 키로 다시 start 호출 시 새 entry 로 덮어쓰는데, 키 매칭은 유지
        const b = mod.start('유튜브 분석', true);
        expect(b.fromTelegram).toBe(true);
        // 한 키당 entry 한 개 — 두 번째 start 가 첫 entry 를 덮어씀
        const found = mod.find('유튜브 분석');
        expect(found?.fromTelegram).toBe(true);
    });

    it('find 는 같은 prompt 의 normalized key 로 매칭된다', async () => {
        // Given: "유튜브 분석" 으로 start 된 entry
        const mod = await freshModule();
        mod.start('유튜브 분석', false);

        // When/Then: 공백·구두점이 달라도 같은 entry 가 잡혀야 한다
        expect(mod.find('유튜브 분석')).not.toBeNull();
        expect(mod.find('유튜브  분석!')).not.toBeNull();
        expect(mod.find('유튜브분석')).not.toBeNull();
        expect(mod.find('  유튜브   분석   ')).not.toBeNull();

        // 완전히 다른 prompt 는 잡히면 안 됨
        expect(mod.find('인스타 분석')).toBeNull();
    });

    it('find 는 TTL(5분) 지난 항목을 제외한다', async () => {
        // Given: start 한 직후, startedAt 을 6분 전으로 강제 노화
        const mod = await freshModule();
        const entry = mod.start('오래된 요청', false);
        entry.startedAt = Date.now() - (mod.ACTIVE_DISPATCH_TTL_MS + 1000);

        // When
        const found = mod.find('오래된 요청');

        // Then: TTL 청소가 일어나서 null
        expect(found).toBeNull();
        // 그리고 같은 prompt 로 다시 찾아도 여전히 null (실제로 map 에서 제거됨)
        expect(mod.find('오래된 요청')).toBeNull();
    });

    it('updateStep 은 entry 의 step 필드를 갱신한다', async () => {
        // Given: 진행중 dispatch
        const mod = await freshModule();
        mod.start('영상 분석', false);
        expect(mod.find('영상 분석')?.step).toBe('준비 중');

        // When
        mod.updateStep('영상 분석', '에이전트 분배 중');

        // Then
        expect(mod.find('영상 분석')?.step).toBe('에이전트 분배 중');

        // 존재하지 않는 prompt 의 updateStep 은 조용히 무시 (throw 안 함)
        expect(() => mod.updateStep('없는요청', '아무거나')).not.toThrow();
    });

    it('end 는 entry 를 map 에서 제거한다', async () => {
        // Given: 진행중 dispatch
        const mod = await freshModule();
        mod.start('마감 처리', false);
        expect(mod.find('마감 처리')).not.toBeNull();

        // When
        mod.end('마감 처리');

        // Then: 사라짐 + idempotent (다시 end 호출해도 throw 안 함)
        expect(mod.find('마감 처리')).toBeNull();
        expect(() => mod.end('마감 처리')).not.toThrow();
    });
});
