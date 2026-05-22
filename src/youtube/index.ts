/**
 * YouTube 도메인 barrel.
 *
 * extension.ts 의 YouTube OAuth + Analytics 헬퍼들을 한 묶음으로 추출.
 * Loopback OAuth (127.0.0.1:5814) → refresh_token 디스크 캐시 → 28일
 * Analytics 요약. extension.ts wrapper 는 동일 시그니처로 호출만.
 */

export {
    startYouTubeOAuthFlow,
    _readYtOAuthClient,
    isYoutubeOAuthConnected,
    _ensureYtAccessToken,
} from './oauth';

export { fetchYouTubeAnalyticsSummary } from './analytics';
