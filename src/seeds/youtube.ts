/**
 * YouTube 에이전트 도구 시드 (8종).
 *   - youtube_account         : API 키 + 채널 + Telegram 통합 설정
 *   - trend_sniper            : 키워드 기반 떡상 영상 패턴
 *   - auto_planner            : 트렌드 스나이퍼 무인 반복 (24h 자율)
 *   - my_videos_check         : 내 채널 성과 종합 분석
 *   - channel_full_analysis   : 채널 전체 그림 (메타·업로드·참여율)
 *   - comment_harvester       : 감시 채널 댓글 → memory.md
 *   - competitor_brief        : 경쟁 채널 → 다음 액션 지시문
 *   - telegram_notify         : 다른 도구 보고를 메신저로 푸시
 * v2.89.20 ~ v2.89.81.
 */

import * as path from 'path';
import {
  _loadToolSeed,
  _seedFile,
  _seedFileForceUpgrade,
  _mergeSchemaIntoJson,
} from './common';

export function _seedYouTubeTrendSniper(toolsDir: string) {
  const py = _loadToolSeed('youtube/trend_sniper.py');
  const json = JSON.stringify({
    TARGET_KEYWORDS: ['유튜브 자동화', 'AI 비즈니스', '마케팅 트렌드', '생산성 툴'],
  }, null, 2);
  const md = _loadToolSeed('youtube/trend_sniper.md');
  /* v2.89.70 sentinel — LM Studio + Ollama 자동 감지 추가됨. 이전 사용자는 자동 업그레이드. */
  _seedFileForceUpgrade(path.join(toolsDir, 'trend_sniper.py'), py, 'is_lm_studio');
  _seedFile(path.join(toolsDir, 'trend_sniper.json'), json);
  _seedFile(path.join(toolsDir, 'trend_sniper.md'), md);
}

/* v2.89.70 sentinel — Auto Planner에 첫 실행 검증 + blocking 명확 안내 추가. 자동 업그레이드. */
export function _seedYouTubeAutoPlanner(toolsDir: string) {
  const py = _loadToolSeed('youtube/auto_planner.py');
  /* v2.89.72 — 사용자가 드롭다운으로 모드 선택. INTERVAL과 TOTAL 둘 다 select. */
  const json = JSON.stringify({
    INTERVAL_HOURS: 6,
    TOTAL_RUN_HOURS: 0,
    _schema: {
      INTERVAL_HOURS: {
        type: 'select',
        label: '⏰ 실행 간격',
        hint: 'YouTube API 일일 quota 한도(10,000 unit) 고려. 6시간이 안전권.',
        options: [
          { value: 1,  label: '1시간 — 너무 빠름, quota 초과 위험' },
          { value: 2,  label: '2시간 — 빠른 모니터링 (12회/일)' },
          { value: 3,  label: '3시간 — 활발 (8회/일)' },
          { value: 6,  label: '⭐ 6시간 — 권장 (4회/일, 안전)' },
          { value: 12, label: '12시간 — 보수적 (2회/일)' },
          { value: 24, label: '24시간 — 일일 1회' },
        ],
      },
      TOTAL_RUN_HOURS: {
        type: 'select',
        label: '🌙 가동 모드',
        hint: '0(무한) = 24시간 자율 모드. 양수 = 그 시간만 돌고 종료 (테스트용).',
        options: [
          { value: 0,  label: '⭐ 0 (무한) — 24시간 자율, 사용자가 멈출 때까지' },
          { value: 8,  label: '8시간 — 하룻밤 동안 (테스트용)' },
          { value: 24, label: '24시간 — 하루 동안' },
          { value: 72, label: '72시간 — 3일 동안' },
          { value: 168, label: '168시간 — 1주일 동안' },
        ],
      },
    },
  }, null, 2);
  const md = _loadToolSeed('youtube/auto_planner.md');
  /* v2.89.71 sentinel — 24시간 자율 모드 (TOTAL_RUN_HOURS=0 무한). 자동 업그레이드. */
  _seedFileForceUpgrade(path.join(toolsDir, 'auto_planner.py'), py, '24시간 자율 모드');
  _seedFile(path.join(toolsDir, 'auto_planner.json'), json);
  _seedFileForceUpgrade(path.join(toolsDir, 'auto_planner.md'), md, '24시간 자율 모드');
}

/* ─── Shared YouTube account/channel config ────────────────────────────────
   The other tools (trend_sniper, my_videos_check, comment_harvester,
   competitor_brief, telegram_notify) all read this single file so the user
   only enters their API key / channels / Telegram once. */
export function _seedYouTubeAccount(toolsDir: string) {
  const py = _loadToolSeed('youtube/youtube_account.py');
  /* v2.89.81 — _schema 추가. 폼 렌더가 hint를 자동으로 표시. */
  const json = JSON.stringify({
    YOUTUBE_API_KEY: '',
    MY_CHANNEL_HANDLE: '',
    MY_CHANNEL_ID: '',
    WATCHED_CHANNELS: [],
    COMPETITOR_CHANNELS: [],
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_CHAT_ID: '',
    OLLAMA_URL: 'http://127.0.0.1:11434',
    MODEL: '',
    _schema: {
      YOUTUBE_API_KEY: { label: '🔑 YouTube Data API 키', hint: 'Google Cloud Console → API & Services → 사용자 인증 정보에서 발급. 트렌드/통계 조회용 (일일 quota 10,000).' },
      MY_CHANNEL_HANDLE: { label: '📺 내 채널 핸들', hint: '@로 시작하는 채널 핸들 (예: @leoyt). 안 적어도 ID만 있으면 동작.' },
      MY_CHANNEL_ID: { label: '🆔 내 채널 ID', hint: 'UC로 시작하는 24자 ID. studio.youtube.com → 설정 → 채널 → 고급 설정에서 확인.' },
      WATCHED_CHANNELS: { label: '👀 모니터링 채널들', hint: '내가 정기적으로 추적하고 싶은 채널 핸들. 트렌드 스나이퍼가 새 영상을 잡아옴.' },
      COMPETITOR_CHANNELS: { label: '🎯 경쟁 채널들', hint: '벤치마킹할 채널 핸들. 비교 분석에 사용.' },
      TELEGRAM_BOT_TOKEN: { label: '🤖 Telegram Bot 토큰', hint: '@BotFather에서 /newbot으로 발급. 형식: 123456789:AAH...' },
      TELEGRAM_CHAT_ID: { label: '💬 Telegram Chat ID', hint: '봇과 첫 대화 시작 후 자동 채워짐. 직접 입력하지 않아도 됨.' },
      OLLAMA_URL: { label: '🧠 LLM 서버 주소', hint: '로컬 Ollama/LM Studio 엔드포인트. 보통 그대로 두면 됨.' },
      MODEL: { label: '🎚 사용할 모델', hint: '비워두면 설치된 모델 중 가장 작은 것 자동. 직접 지정하려면 모델명 (예: gemma2:2b).' },
      YOUTUBE_OAUTH_CLIENT_ID: { label: '🔓 OAuth Client ID', hint: 'Google Cloud → OAuth 2.0 클라이언트 ID. 댓글 답글·통계 등 인증 필요한 기능에 사용.' },
      YOUTUBE_OAUTH_CLIENT_SECRET: { label: '🔐 OAuth Client Secret', hint: 'OAuth 클라이언트 ID와 같이 발급되는 비밀 키. Authorized redirect URI: http://127.0.0.1:5814/yt-oauth-callback' },
    },
  }, null, 2);
  const md = _loadToolSeed('youtube/youtube_account.md');
  _seedFile(path.join(toolsDir, 'youtube_account.py'), py);
  /* Force-upgrade JSON so existing users get the new _schema. 사용자가 이미 입력한
     값은 보존하고 _schema만 머지하는 게 이상적이지만, _schema는 사용자가 편집하지
     않는 메타라 통째 덮어써도 안전. 단, 사용자 값이 있으면 보존해야 함 — 여기서
     _seedFileForceUpgrade는 sentinel 없으면 통째 덮어쓰니까 사용자 값이 날아감.
     그래서 별도 머지 함수 호출. */
  _mergeSchemaIntoJson(path.join(toolsDir, 'youtube_account.json'), json);
  /* Force-upgrade to surface the new Secretary-canonical guidance to users
     on older versions. Sentinel = the new section header. */
  _seedFileForceUpgrade(path.join(toolsDir, 'youtube_account.md'), md, '비서(Secretary)에 입력');
}

/* ─── My Videos Check — own channel performance (pro_v1) ────────────────────
   v2.89.43 — 전문 유튜브 분석가 수준의 종합 보고서. 이전엔 중간값 1줄 + 영상 목록만
   출력해서 "전문 에이전트답지 못함"이라는 사용자 피드백. 이제 채널 메타·요일별 성과·
   참여율·제목 키워드·인기 댓글·구체 액션 추천까지 포함. */
export function _seedYouTubeMyVideosCheck(toolsDir: string) {
  const py = _loadToolSeed('youtube/my_videos_check.py');
  const json = JSON.stringify({ LOOKBACK_DAYS: 30, TOP_N: 15, COMMENT_SAMPLES: 5 }, null, 2);
  const md = _loadToolSeed('youtube/my_videos_check.md');
  /* Force-upgrade the .py — older users on pre-telegram_v2 versions need
     the Secretary fallback so token doesn't have to be duplicated. */
  /* v2.89.43 — sentinel 'pro_v1' = 종합 분석 버전. 기존 사용자도 자동 업그레이드. */
  /* sentinel pro_v4 — HTML entity 디코드 + 빈 영상 시 stderr로. 기존 설치자 자동 업그레이드. */
  _seedFileForceUpgrade(path.join(toolsDir, 'my_videos_check.py'), py, 'pro_v4');
  _seedFile(path.join(toolsDir, 'my_videos_check.json'), json);
  /* v2.89.20 — Force upgrade .md heading from old "내 영상 체크" to "내 유튜브 채널 분석"
     for existing users. Sentinel = the new heading text. */
  _seedFileForceUpgrade(path.join(toolsDir, 'my_videos_check.md'), md, '내 유튜브 채널 분석');
}

/* ─── 📈 채널 완전 분석 — v2.89.21 ──────────────────────────────────────────
   API 키 + 채널 ID 만 있으면 돌아가는 통합 분석 도구. my_videos_check 는
   "이번 달 영상 떡상/부진 보기" 같은 단순 비교라면, 이건 채널 전체 그림:
   - 채널 메타 (구독자·총조회·영상수·가입일·평균 조회)
   - 최근 30일 업로드 패턴 (요일·시간대·길이)
   - 영상별 참여율 (좋아요/조회, 댓글/조회)
   - 인기 영상 vs 부진 영상의 제목·길이 패턴 비교
   - 다음 액션 자동 추천 (LLM 호출 없이 통계만으로)
   추가 입력 필요 없음. */
export function _seedYouTubeChannelFullAnalysis(toolsDir: string) {
  const py = _loadToolSeed('youtube/channel_full_analysis.py');
  const json = JSON.stringify({}, null, 2); /* 추가 입력 없음 */
  const md = _loadToolSeed('youtube/channel_full_analysis.md');
  _seedFile(path.join(toolsDir, 'channel_full_analysis.py'), py);
  _seedFile(path.join(toolsDir, 'channel_full_analysis.json'), json);
  _seedFile(path.join(toolsDir, 'channel_full_analysis.md'), md);
}

/* ─── Comment Harvester — pulls comments from watched channels ───────────── */
export function _seedYouTubeCommentHarvester(toolsDir: string) {
  const py = _loadToolSeed('youtube/comment_harvester.py');
  const json = JSON.stringify({
    VIDEOS_PER_CHANNEL: 5,
    COMMENTS_PER_VIDEO: 20,
    LOOKBACK_DAYS: 14,
  }, null, 2);
  const md = _loadToolSeed('youtube/comment_harvester.md');
  _seedFile(path.join(toolsDir, 'comment_harvester.py'), py);
  _seedFile(path.join(toolsDir, 'comment_harvester.json'), json);
  _seedFile(path.join(toolsDir, 'comment_harvester.md'), md);
}

/* ─── Competitor Brief — prescriptive next-actions from rivals ───────────── */
export function _seedYouTubeCompetitorBrief(toolsDir: string) {
  const py = _loadToolSeed('youtube/competitor_brief.py');
  const json = JSON.stringify({ TOP_N_PER_CHANNEL: 5, LOOKBACK_DAYS: 30 }, null, 2);
  const md = _loadToolSeed('youtube/competitor_brief.md');
  _seedFileForceUpgrade(path.join(toolsDir, 'competitor_brief.py'), py, 'telegram_v3');
  _seedFile(path.join(toolsDir, 'competitor_brief.json'), json);
  _seedFile(path.join(toolsDir, 'competitor_brief.md'), md);
}

/* ─── Telegram Notify — sender + connectivity check ─────────────────────── */
export function _seedYouTubeTelegramNotify(toolsDir: string) {
  /* telegram_v3 — Secretary's tools/telegram_setup.json is canonical for
     telegram credentials (UI-managed). config.md and youtube_account.json
     remain as back-compat fallbacks. */
  const py = _loadToolSeed('youtube/telegram_notify.py');
  const json = JSON.stringify({}, null, 2);
  const md = _loadToolSeed('youtube/telegram_notify.md');
  _seedFileForceUpgrade(path.join(toolsDir, 'telegram_notify.py'), py, 'telegram_v3');
  _seedFile(path.join(toolsDir, 'telegram_notify.json'), json);
  _seedFileForceUpgrade(path.join(toolsDir, 'telegram_notify.md'), md, 'Secretary 비서가 정답');
}
