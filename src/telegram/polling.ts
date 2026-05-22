/**
 * Telegram getUpdates long-polling loop.
 *
 * extension.ts 에서 분리. 단일 인스턴스만 폴링하도록 cross-window file lock
 * 으로 보호되며 (lock.ts), offset 은 globalState + userBrain 파일 양쪽에
 * 기록해서 다른 워크스페이스/포크 (Antigravity 등) 와도 안전하게 공유된다.
 *
 * - startTelegramPolling: timer 등록 + 즉시 한 번 tick. token/chatId 미설정
 *   상태에서도 조용히 대기 (configured 되는 순간부터 정상 동작).
 * - stopTelegramPolling: timer 정리 + lock 해제. 401(token reject) 시
 *   자체적으로 호출됨.
 *
 * Deps imported from `../extension` (★ = need `export` added in extension.ts):
 *   - readTelegramConfig                                        ★
 *   - sendTelegramReport                                        ★
 *   - _readTelegramOffset, _writeTelegramOffset                 ★
 *   - _tryAcquireTelegramLock, _releaseTelegramLockIfOwned      ★
 *   - _extCtx                                                   (already exported)
 *
 * Deps from extracted modules:
 *   - handleTelegramCommand     ← './commands'
 */
import axios from 'axios';
import {
    readTelegramConfig,
    sendTelegramReport,
    _readTelegramOffset,
    _writeTelegramOffset,
    _tryAcquireTelegramLock,
    _releaseTelegramLockIfOwned,
    _extCtx,
} from '../extension';
import { handleTelegramCommand } from './commands';

let _telegramPollTimer: NodeJS.Timeout | null = null;
let _telegramPollOffset = 0;
let _telegramPolling = false;

export function startTelegramPolling() {
    if (_telegramPollTimer) return;
    // Restore last known offset so we never replay messages after a restart
    if (_extCtx) {
        _telegramPollOffset = _extCtx.globalState.get<number>('telegramPollOffset', 0);
    }
    const tick = async () => {
        if (_telegramPolling) return;
        const { token, chatId } = readTelegramConfig();
        if (!token || !chatId) return; // not configured — quietly idle
        if (!_tryAcquireTelegramLock()) return; // another window is already the leader
        _telegramPolling = true;
        /* v2.89.24 — 유저 레벨 파일 offset 사용. globalState는 같은 머신·같은 확장이지만
           Antigravity 같은 fork에서 namespace가 다를 수 있어서, 진짜 공유는 파일 한 군데. */
        const fileOffset = _readTelegramOffset();
        if (fileOffset > _telegramPollOffset) _telegramPollOffset = fileOffset;
        if (_extCtx) {
            const stored = _extCtx.globalState.get<number>('telegramPollOffset', 0);
            if (stored > _telegramPollOffset) _telegramPollOffset = stored;
        }
        try {
            /* v2.89.41 — Long polling. timeout=25는 Telegram 서버에 "메시지 올 때까지 25초간
               열어둬"라고 요청. 메시지 오면 즉시 반환, 없으면 25초 후 빈 배열. 결과:
               - 텔레그램 응답성: 5초 폴링 사이클 → 거의 실시간 (메시지 도착하자마자 반환)
               - API 호출 ~12배 감소 (5초마다 → 25~30초마다)
               - 트래픽·배터리 절약 */
            const url = `https://api.telegram.org/bot${token}/getUpdates`;
            const res = await axios.get(url, {
                params: { offset: _telegramPollOffset, timeout: 25, allowed_updates: JSON.stringify(['message']) },
                timeout: 30_000 /* 서버 timeout(25s) + 네트워크 여유 5s */
            });
            const updates = res.data?.result || [];
            for (const u of updates) {
                _telegramPollOffset = (u.update_id || 0) + 1;
                try { _extCtx?.globalState.update('telegramPollOffset', _telegramPollOffset); } catch {}
                /* v2.89.24 — 유저 레벨 파일에도 즉시 commit. 다른 창이 다음 tick에 이걸 읽어서
                   같은 update 두 번 처리하지 않게. */
                _writeTelegramOffset(_telegramPollOffset);
                const m = u.message;
                if (!m) continue;
                const fromChat = String(m.chat?.id ?? '');
                if (fromChat !== String(chatId)) continue; // whitelist guard
                const text = (m.text || '').trim();
                if (!text) continue;
                try { await handleTelegramCommand(text); }
                catch (e: any) {
                    try { await sendTelegramReport(`⚠️ 명령 처리 중 오류: ${e?.message || e}`); } catch {}
                }
            }
        } catch (e: any) {
            if (e?.response?.status === 401) {
                console.warn('[Telegram] 401 — bot token rejected. Stopping polling until config changes.');
                stopTelegramPolling();
            }
            // Other errors (network, 5xx) silently retry next tick.
        } finally {
            _telegramPolling = false;
        }
    };
    /* v2.89.41 — long-poll이 25초 블록되니 setInterval은 long poll 끝난 직후 다음 tick
       발동시키는 안전망 역할. 1초 간격으로 체크하지만 _telegramPolling 가드 때문에
       동시 실행 안 됨 (이전 tick이 long poll 중이면 즉시 return). */
    _telegramPollTimer = setInterval(tick, 1000);
    setTimeout(tick, 500);
}

export function stopTelegramPolling() {
    if (_telegramPollTimer) {
        clearInterval(_telegramPollTimer);
        _telegramPollTimer = null;
    }
    _releaseTelegramLockIfOwned();
}
