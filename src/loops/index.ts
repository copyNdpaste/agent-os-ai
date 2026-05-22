/**
 * Background loops barrel.
 *
 * 각 loop 은 setInterval + setTimeout 기반 주기 실행기. extension.ts wrapper 의
 * activate() 에서 start*Loop() 호출, deactivate() 에서 stop*Loop() 호출.
 * `_runDailyBriefingOnce` 는 `/today` 등 외부에서 force-fire 용도로 export.
 */

export { startTrackerNudgeLoop, stopTrackerNudge } from './tracker-nudge';
export { startRevenueWatcherLoop, stopRevenueWatcherLoop, _runRevenueWatcherOnce } from './revenue-watcher';
export { startRecurrenceLoop, stopRecurrenceLoop } from './recurrence';
export { startPreAlarmLoop, stopPreAlarmLoop } from './pre-alarm';
export {
    startDailyBriefingLoop,
    stopDailyBriefingLoop,
    _runDailyBriefingOnce,
} from './daily-briefing';
