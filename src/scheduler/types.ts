/**
 * Report scheduler types.
 *
 * extension.ts 에서 분리됨 (god-file 모듈화). 스케줄 entry 구조 + action 종류.
 *
 * 사용자 예시:
 *   { entries: [
 *     { id: 'morning-brief', label: '모닝 브리핑', hour: 9, minute: 0,
 *       days: [1,2,3,4,5], action: 'briefing', enabled: true },
 *     { id: 'channel-daily', label: '채널 분석', hour: 8, minute: 0,
 *       days: [0,1,2,3,4,5,6], action: 'tool', tool: 'channel_full_analysis',
 *       agentId: 'youtube', enabled: true },
 *   ] }
 */
export interface ReportScheduleEntry {
    id: string;
    label: string;
    hour: number;           /* 0-23 */
    minute: number;         /* 0-59 */
    days: number[];         /* 0=일 ~ 6=토 */
    action: 'briefing' | 'tool';
    tool?: string;
    agentId?: string;
    enabled: boolean;
    lastFiredAt?: string;   /* ISO 날짜 — 같은 날 두 번 실행 방지 */
}

export interface ReportSchedule {
    entries: ReportScheduleEntry[];
}
