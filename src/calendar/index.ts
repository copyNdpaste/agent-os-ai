/**
 * Calendar 도메인 barrel.
 *
 * extension.ts 의 OAuth-backed Google Calendar 헬퍼들을 한 묶음으로 추출.
 * Telegram 모듈과 동일 패턴 — companyDir 인자, HttpClient DI, network 예외
 * 삼킴.
 */

export type {
    CalendarWriteConfig,
    CalendarEvent,
    CalendarEventResult,
    CreateEventOpts,
    PatchEventOpts,
    FindEventsOpts,
    RefreshCacheResult,
} from './types';

export type { HttpClient, HttpRequestOpts } from './http';
export { defaultHttpClient } from './http';

export { configPath, readConfig, writeConfig, isConnected } from './config';

export { getAccessToken } from './token';

export { createEvent, findEvents, deleteEvent, patchEvent } from './crud';

export { refreshCache } from './cache';

export { runConnectGoogleCalendarWrite } from './oauth-setup';

export {
    createCalendarEventForTask,
    updateCalendarEventForTask,
} from './tracker-sync';
