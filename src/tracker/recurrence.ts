/**
 * Tracker date helpers — loose-date parsing + recurrence cadence math.
 *
 * extension.ts 에서 분리됨. 순수 함수 (디스크 IO·vscode 의존성 없음).
 *
 * parseLooseDate 는 사용자가 /reschedule 등에서 채팅으로 실제 입력하는
 * 네 가지 형태를 커버한다:
 *   - ISO ("2026-05-10 14:00")
 *   - 한국어 상대 표현 ("내일", "내일 15:00", "오늘 18:00", "모레")
 *   - 양수 오프셋 ("+2h", "+90m", "+1d", "+2시간", "+30분", "+1일")
 *   - 위 모두 실패 시 null (caller 가 재질문)
 */

/**
 * 채팅에서 실제 들어오는 4가지 형태의 날짜를 관대하게 해석한다.
 * 매칭 실패 시 null.
 */
export function parseLooseDate(input: string): Date | null {
    const s = input.trim();
    if (!s) return null;
    /* +Nh / +Nm / +Nd offset */
    const off = s.match(/^\+(\d+)\s*(h|m|d|시간|분|일)$/i);
    if (off) {
        const n = parseInt(off[1], 10);
        const u = off[2].toLowerCase();
        const ms = (u === 'h' || u === '시간') ? n * 3600_000
                 : (u === 'm' || u === '분')   ? n * 60_000
                 : (u === 'd' || u === '일')   ? n * 86_400_000
                 : 0;
        if (ms > 0) return new Date(Date.now() + ms);
    }
    /* "내일 [HH:MM]" / "오늘 [HH:MM]" / "모레 [HH:MM]" */
    const rel = s.match(/^(내일|오늘|모레)\s*(\d{1,2}):(\d{2})?$/);
    if (rel) {
        const offsetDays = rel[1] === '내일' ? 1 : rel[1] === '모레' ? 2 : 0;
        const d = new Date();
        d.setDate(d.getDate() + offsetDays);
        const hh = parseInt(rel[2], 10);
        const mm = rel[3] ? parseInt(rel[3], 10) : 0;
        d.setHours(hh, mm, 0, 0);
        return d;
    }
    /* Bare "내일" / "오늘" / "모레" → 09:00 default */
    if (/^(내일|오늘|모레)$/.test(s)) {
        const offsetDays = s === '내일' ? 1 : s === '모레' ? 2 : 0;
        const d = new Date();
        d.setDate(d.getDate() + offsetDays);
        d.setHours(9, 0, 0, 0);
        return d;
    }
    /* ISO-ish — let Date constructor try. Reject NaN. */
    const iso = new Date(s.replace(/[ T]/, 'T'));
    if (!isNaN(iso.getTime())) return iso;
    return null;
}

/**
 * 다음 실행 시각을 cadence 에 따라 계산한다. 로컬 타임을 쓰므로 "매일 09:00"
 * 같은 사용자 직관에 맞는 시간으로 떨어진다 ("매일 아침" 의 의미 보존).
 */
export function computeNextRunAt(
    prev: Date,
    cadence: 'daily' | 'weekly' | 'monthly'
): Date {
    const next = new Date(prev);
    if (cadence === 'daily')   next.setDate(next.getDate() + 1);
    if (cadence === 'weekly')  next.setDate(next.getDate() + 7);
    if (cadence === 'monthly') next.setMonth(next.getMonth() + 1);
    return next;
}
