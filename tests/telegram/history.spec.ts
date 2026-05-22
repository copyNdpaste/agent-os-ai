import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/* history.ts 는 module-private 링 버퍼를 갖는다. 매 테스트마다 vi.resetModules()
   + dynamic import 로 깨끗한 모듈 인스턴스를 받아 사용한다. 프로덕션 API 에
   __reset 같은 노이즈를 두지 않기 위함. */
type HistoryModule = typeof import('../../src/telegram/history');

async function freshModule(): Promise<HistoryModule> {
    vi.resetModules();
    return await import('../../src/telegram/history');
}

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-history-'));
}

describe('telegram/history', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = mkTmp();
    });

    it('첫 push 이후 hydrate 가 다시 디스크를 읽지 않는다 (idempotent)', async () => {
        // Given: 디스크에 미리 1줄 적혀있음
        const mod = await freshModule();
        const p = mod.historyPath(tmpDir);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify({ role: 'user', text: '예전 메시지', ts: Date.now() }) + '\n');

        // When: hydrate 호출 후, 디스크에 새 줄을 직접 추가하고 다시 hydrate
        mod.hydrateFromDisk(tmpDir);
        fs.appendFileSync(p, JSON.stringify({ role: 'user', text: '뒤늦은 줄', ts: Date.now() }) + '\n');
        mod.hydrateFromDisk(tmpDir); // 두 번째 호출

        // Then: 두 번째 hydrate 가 무시되어야 한다 — render 에 '뒤늦은 줄' 이 안 나옴
        const rendered = mod.renderHistory(tmpDir);
        expect(rendered).toContain('예전 메시지');
        expect(rendered).not.toContain('뒤늦은 줄');
    });

    it('HISTORY_MAX(12) 를 넘으면 오래된 항목을 잘라낸다', async () => {
        // Given: 깨끗한 모듈
        const mod = await freshModule();
        expect(mod.HISTORY_MAX).toBe(12);

        // When: 15 개 push
        for (let i = 0; i < 15; i++) {
            mod.pushHistory('user', `메시지-${i}`, tmpDir);
        }

        // Then: render 에는 마지막 8개 (renderHistory 기본 maxTurns=8) 만 나오고
        //       내부 버퍼는 최대 12개로 잘려있음 — render(maxTurns=20) 으로 확인
        const all = mod.renderHistory(tmpDir, 20);
        // 가장 오래된 0,1,2 는 잘려나가야 함 — 정확히 매칭하기 위해 줄 끝 기준
        const lines = all.split('\n');
        const tails = lines.map(l => l.replace(/^.*?: /, ''));
        expect(tails).not.toContain('메시지-0');
        expect(tails).not.toContain('메시지-1');
        expect(tails).not.toContain('메시지-2');
        // 마지막 메시지는 살아있어야 함
        expect(tails).toContain('메시지-14');
        // 라인 수 ≤ 12
        expect(lines.length).toBeLessThanOrEqual(12);
    });

    it('디스크 jsonl 의 마지막 N 줄만 메모리에 hydrate 한다', async () => {
        // Given: 디스크에 20줄, 그 중 마지막 12줄만 메모리로 와야 함
        const mod = await freshModule();
        const p = mod.historyPath(tmpDir);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const now = Date.now();
        const lines: string[] = [];
        for (let i = 0; i < 20; i++) {
            lines.push(JSON.stringify({ role: 'user', text: `디스크-${i}`, ts: now - (20 - i) * 1000 }));
        }
        fs.writeFileSync(p, lines.join('\n') + '\n');

        // When: hydrate 후 전체 렌더
        const rendered = mod.renderHistory(tmpDir, 50);
        const tails = rendered.split('\n').map(l => l.replace(/^.*?: /, ''));

        // Then: 0..7 은 없고 8..19 는 있어야 한다 (마지막 12개)
        for (let i = 0; i < 8; i++) {
            expect(tails).not.toContain(`디스크-${i}`);
        }
        for (let i = 8; i < 20; i++) {
            expect(tails).toContain(`디스크-${i}`);
        }
    });

    it('renderHistory 는 4시간 이전 항목을 cutoff 로 제외한다', async () => {
        // Given: 옛 항목 + 최근 항목을 디스크에 직접 기록 (push 는 ts=now 라 cutoff 통제 불가)
        const mod = await freshModule();
        const p = mod.historyPath(tmpDir);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const now = Date.now();
        const fiveHoursAgo = now - 5 * 60 * 60_000;
        const oneHourAgo = now - 60 * 60_000;
        fs.writeFileSync(p,
            JSON.stringify({ role: 'user', text: '아주오래된', ts: fiveHoursAgo }) + '\n' +
            JSON.stringify({ role: 'assistant', text: '최근응답', ts: oneHourAgo }) + '\n'
        );

        // When
        const rendered = mod.renderHistory(tmpDir);

        // Then: cutoff(4h) 보다 오래된 항목은 제외, 최근 항목만 포함
        expect(rendered).not.toContain('아주오래된');
        expect(rendered).toContain('최근응답');
    });

    it('push 가 jsonl 에 append 형식으로 기록한다', async () => {
        // Given: 빈 디렉터리
        const mod = await freshModule();

        // When: 두 번 push
        mod.pushHistory('user', '첫번째', tmpDir);
        mod.pushHistory('assistant', '두번째', tmpDir);

        // Then: 파일이 두 줄짜리 jsonl 이어야 한다
        const p = mod.historyPath(tmpDir);
        expect(fs.existsSync(p)).toBe(true);
        const lines = fs.readFileSync(p, 'utf8').split('\n').filter(l => l.trim());
        expect(lines.length).toBe(2);
        const e1 = JSON.parse(lines[0]);
        const e2 = JSON.parse(lines[1]);
        expect(e1.role).toBe('user');
        expect(e1.text).toBe('첫번째');
        expect(typeof e1.ts).toBe('number');
        expect(e2.role).toBe('assistant');
        expect(e2.text).toBe('두번째');
    });
});
