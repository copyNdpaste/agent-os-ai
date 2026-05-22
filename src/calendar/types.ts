/**
 * Calendar 도메인 타입.
 *
 * extension.ts 에서 분리됨. CalendarWriteConfig 는 Google OAuth 자격정보
 * (Client ID/Secret + refresh_token + 기본 calendarId + 메타데이터) 를 담는
 * `_agents/secretary/tools/google_calendar_write.json` 파일의 shape.
 *
 * 필드명은 대문자 — 원본 디스크 포맷과의 호환을 위해 유지. (사용자가 직접
 * 편집한 기존 파일을 깨뜨리지 않기 위함)
 */

export interface CalendarWriteConfig {
    CLIENT_ID?: string;
    CLIENT_SECRET?: string;
    REFRESH_TOKEN?: string;
    CALENDAR_ID?: string;
    DEFAULT_DURATION_MINUTES?: number;
    _CONNECTED_AS?: string;
    _CONNECTED_AT?: string;
}

/** Google Calendar event — extension.ts 에서 사용하던 reduced shape. */
export interface CalendarEvent {
    eventId: string;
    title: string;
    startIso: string;
    endIso: string;
    htmlLink?: string;
}

/** createEvent / patchEvent 의 결과 (eventId + 시간 + 링크). */
export interface CalendarEventResult {
    eventId: string;
    htmlLink?: string;
    startIso: string;
    endIso: string;
}

/** createEvent 입력 (free-form, tracker task 와 무관). */
export interface CreateEventOpts {
    title: string;
    /** RFC3339 (with TZ offset) 또는 'YYYY-MM-DDTHH:mm:ss'. */
    startIso: string;
    /** 생략 시 start + DEFAULT_DURATION_MINUTES. */
    endIso?: string;
    description?: string;
    location?: string;
}

/** patchEvent 입력 — 모든 필드 optional (부분 업데이트). */
export interface PatchEventOpts {
    title?: string;
    startIso?: string;
    endIso?: string;
    description?: string;
    location?: string;
}

/** findEvents 입력. */
export interface FindEventsOpts {
    /** 부분 일치 검색어 (Google 의 q 파라미터). */
    query?: string;
    /** now 부터 며칠 후까지 볼지. 기본 14일. */
    daysAhead?: number;
}

/** refreshCache 결과. */
export interface RefreshCacheResult {
    ok: boolean;
    count: number;
    error?: string;
}
