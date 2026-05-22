/**
 * Instagram 에이전트 도구 시드 — Threads / IG / X / Slack workflow.
 *   - token_manager        : 멀티 계정 토큰 자동 갱신
 *   - threads_uploader     : Threads 게시 (text/image/video)
 *   - instagram_uploader   : IG 피드 (IMAGE / REELS / CAROUSEL)
 *   - x_uploader           : X (Twitter) OAuth 2.0 PKCE
 *   - slack_notifier       : draft → Slack 카드 + ✅/❌/📝
 *   - slack_approval_worker: Socket Mode 데몬 (launchd 상주)
 * v2.90.x → v2.92.x.
 */

import * as path from 'path';
import {
  _loadToolSeed,
  _seedFileForceUpgrade,
  _mergeSchemaIntoJson,
} from './common';

/* v2.91.x — Instagram 에이전트 시드: 토큰 자동 관리자 (Threads + IG 멀티 계정).
   .env 와 tokens.json 으로 토큰을 분리 관리. 도구 카드엔 cron 옵션만. */
export function _seedInstagramTokenManager(toolsDir: string) {
  const py = _loadToolSeed('instagram/token_manager.py');
  const md = _loadToolSeed('instagram/token_manager.md');
  const json = JSON.stringify({
    AUTO_REFRESH_HOURS: 24,
    _schema: {
      AUTO_REFRESH_HOURS: {
        type: 'select',
        label: '🔁 자동 갱신 주기 (스케줄러용)',
        hint: '만료 7일 이내 토큰만 자동 갱신. .env / tokens.json 은 별도 관리 (token_manager.md 참조).',
        options: [
          { value: 6,   label: '6시간마다' },
          { value: 24,  label: '⭐ 매일 (권장)' },
          { value: 168, label: '매주' },
        ],
      },
    },
  }, null, 2);
  _seedFileForceUpgrade(path.join(toolsDir, 'token_manager.py'), py, 'token_manager_v2_x_integrated');
  _mergeSchemaIntoJson(path.join(toolsDir, 'token_manager.json'), json);
  _seedFileForceUpgrade(path.join(toolsDir, 'token_manager.md'), md, 'token_manager');
}

/* v2.90.x → v2.92.x — Threads 자동 업로더. 멀티 계정 + tokens.json 우선 + 이미지/영상.
   토큰 칸은 제거하고 DEFAULT_ACCOUNT 만 남김. 환경변수 폴백은 .py 가 자동 처리.
   v2.92: MEDIA_TYPE (text/image/video) 추가, video 는 status polling 자동. */
export function _seedInstagramThreadsUploader(toolsDir: string) {
  const py = _loadToolSeed('instagram/threads_uploader.py');
  const md = _loadToolSeed('instagram/threads_uploader.md');
  const json = JSON.stringify({
    DEFAULT_ACCOUNT: 'default',
    DRAFT_MODE: true,
    REPLY_CONTROL: 'everyone',
    MEDIA_TYPE: 'text',
    _schema: {
      DEFAULT_ACCOUNT: {
        type: 'text',
        label: '🌐 기본 계정',
        hint: '.env 의 META_THREADS_SHORT_TOKEN_<계정> 키 (예: jp, kr). 토큰은 token_manager.py 가 관리.',
      },
      DRAFT_MODE: {
        type: 'select',
        label: '✏️ 모드',
        hint: '처음엔 draft 로 확인 후 자동 게시로 전환 권장.',
        options: [
          { value: true,  label: '📝 Draft — drafts/ 폴더에 저장만' },
          { value: false, label: '🚀 자동 게시 (tokens.json 또는 환경변수 필요)' },
        ],
      },
      MEDIA_TYPE: {
        type: 'select',
        label: '🎬 미디어 타입',
        hint: '게시할 콘텐츠 종류. image/video 면 호출 시 --image-url / --video-url 인자 필요.',
        options: [
          { value: 'text',  label: '📝 텍스트 — 본문만' },
          { value: 'image', label: '🖼️ 이미지 — --image-url 추가' },
          { value: 'video', label: '🎥 영상 — --video-url (mp4, status polling 자동)' },
        ],
      },
      REPLY_CONTROL: {
        type: 'select',
        label: '💬 댓글 권한',
        hint: '게시 시 누가 답글 달 수 있는지.',
        options: [
          { value: 'everyone',  label: '🌐 모두' },
          { value: 'mentioned', label: '@ 언급한 사람만' },
          { value: 'followers', label: '👥 팔로워만' },
        ],
      },
    },
  }, null, 2);
  _seedFileForceUpgrade(path.join(toolsDir, 'threads_uploader.py'), py, 'threads_uploader_v3_video');
  _mergeSchemaIntoJson(path.join(toolsDir, 'threads_uploader.json'), json);
  _seedFileForceUpgrade(path.join(toolsDir, 'threads_uploader.md'), md, '권장 워크플로우 — token_manager');
}

/* v2.90.x → v2.91.x — 인스타 사진/릴스 업로더. 멀티 계정 + tokens.json 우선.
   토큰 칸 제거, DEFAULT_ACCOUNT 추가. */
export function _seedInstagramPhotoUploader(toolsDir: string) {
  const py = _loadToolSeed('instagram/instagram_uploader.py');
  const md = _loadToolSeed('instagram/instagram_uploader.md');
  const json = JSON.stringify({
    DEFAULT_ACCOUNT: 'default',
    DRAFT_MODE: true,
    MEDIA_TYPE: 'IMAGE',
    _schema: {
      DEFAULT_ACCOUNT: {
        type: 'text',
        label: '🌐 기본 계정',
        hint: '.env 의 META_IG_SHORT_TOKEN_<계정> 키 (예: jp, kr). 토큰은 token_manager.py 가 관리.',
      },
      DRAFT_MODE: {
        type: 'select',
        label: '✏️ 모드',
        hint: '처음엔 draft 로 확인 후 자동 게시로 전환 권장.',
        options: [
          { value: true,  label: '📝 Draft — drafts/ 폴더에 저장만' },
          { value: false, label: '🚀 자동 게시 (tokens.json 또는 환경변수 필요)' },
        ],
      },
      MEDIA_TYPE: {
        type: 'select',
        label: '🖼️ 미디어 타입',
        options: [
          { value: 'IMAGE',    label: '📷 IMAGE — 일반 사진 1장' },
          { value: 'REELS',    label: '🎬 REELS — 짧은 영상 (≤ 90초)' },
          { value: 'CAROUSEL', label: '🎠 CAROUSEL — 2~10장 묶음 (image/video 혼합 가능)' },
        ],
      },
    },
  }, null, 2);
  _seedFileForceUpgrade(path.join(toolsDir, 'instagram_uploader.py'), py, 'instagram_uploader_v3_reels_carousel');
  _mergeSchemaIntoJson(path.join(toolsDir, 'instagram_uploader.json'), json);
  _seedFileForceUpgrade(path.join(toolsDir, 'instagram_uploader.md'), md, '권장 워크플로우 — token_manager');
}

/* v2.92.x — X (Twitter) 자동 업로더 시드. OAuth 2.0 PKCE + tokens.json 우선.
   토큰 칸 없음 (.env 의 X_OAUTH_TOKEN_<계정> + token_manager.py 가 관리). */
export function _seedInstagramXUploader(toolsDir: string) {
  const py = _loadToolSeed('instagram/x_uploader.py');
  const md = _loadToolSeed('instagram/x_uploader.md');
  const json = JSON.stringify({
    DEFAULT_ACCOUNT: 'default',
    DRAFT_MODE: true,
    _schema: {
      DEFAULT_ACCOUNT: {
        type: 'text',
        label: '🌐 기본 계정',
        hint: '.env 의 X_OAUTH_TOKEN_<계정> 키 (예: jp, kr). 토큰은 token_manager.py 가 관리.',
      },
      DRAFT_MODE: {
        type: 'select',
        label: '✏️ 모드',
        hint: '처음엔 draft 로 확인 후 자동 게시로 전환 권장. (DRAFT_MODE=true env 와 동등)',
        options: [
          { value: true,  label: '📝 Draft — drafts/ 폴더에 저장만' },
          { value: false, label: '🚀 자동 게시 (tokens.json 또는 환경변수 필요)' },
        ],
      },
    },
  }, null, 2);
  _seedFileForceUpgrade(path.join(toolsDir, 'x_uploader.py'), py, 'x_uploader_v1');
  _mergeSchemaIntoJson(path.join(toolsDir, 'x_uploader.json'), json);
  _seedFileForceUpgrade(path.join(toolsDir, 'x_uploader.md'), md, 'X Developer Portal');
}

/* v2.91.x — Slack 인터랙티브 노티파이어 (draft → Slack 카드 + ✅/❌/📝 버튼).
   환경변수 (.env 의 SLACK_*) 는 token_manager.md 와 slack_setup.md 에서 관리. */
export function _seedInstagramSlackNotifier(toolsDir: string) {
  const py = _loadToolSeed('instagram/slack_notifier.py');
  const md = _loadToolSeed('instagram/slack_notifier.md');
  const json = JSON.stringify({
    POST_DELAY_SECONDS: 2,
    DEFAULT_PLATFORM: 'threads',
    _schema: {
      POST_DELAY_SECONDS: {
        type: 'select',
        label: '⏱️ Slack 게시 간 딜레이',
        hint: '여러 카드 연속 발송 시 레이트리밋 방지용 sleep. 보통 2초면 충분.',
        options: [
          { value: 0,  label: '0초 — 딜레이 없음' },
          { value: 2,  label: '⭐ 2초 (권장)' },
          { value: 5,  label: '5초' },
          { value: 10, label: '10초' },
        ],
      },
      DEFAULT_PLATFORM: {
        type: 'select',
        label: '🎯 기본 플랫폼',
        hint: '--platform 인자 생략 시 사용 (CLI 인자가 항상 우선).',
        options: [
          { value: 'threads',   label: '🧵 Threads' },
          { value: 'instagram', label: '📷 Instagram' },
          { value: 'x',         label: '𝕏 X (Twitter)' },
        ],
      },
    },
  }, null, 2);
  _seedFileForceUpgrade(path.join(toolsDir, 'slack_notifier.py'), py, 'slack_notifier_v1');
  _mergeSchemaIntoJson(path.join(toolsDir, 'slack_notifier.json'), json);
  _seedFileForceUpgrade(path.join(toolsDir, 'slack_notifier.md'), md, 'Slack 콘텐츠 승인 노티파이어');
}

/* v2.91.x — Slack 승인 워커 (Socket Mode 데몬). launchd 로 백그라운드 상주.
   plist: ~/Library/LaunchAgents/com.agentosai.slack-worker.plist */
export function _seedInstagramSlackWorker(toolsDir: string) {
  const py = _loadToolSeed('instagram/slack_approval_worker.py');
  const md = _loadToolSeed('instagram/slack_approval_worker.md');
  const json = JSON.stringify({
    AUTO_START_DAEMON: true,
    _schema: {
      AUTO_START_DAEMON: {
        type: 'select',
        label: '🤖 자동 데몬',
        hint: 'launchctl 로 워커를 백그라운드 상주. SLACK_BOT_TOKEN/SLACK_APP_TOKEN 필요 (slack_setup.md 참조).',
        options: [
          { value: true,  label: '⭐ 자동 — launchd 가 항상 실행' },
          { value: false, label: '⏸️ 수동 — 직접 `python3 slack_approval_worker.py` 실행' },
        ],
      },
    },
  }, null, 2);
  _seedFileForceUpgrade(path.join(toolsDir, 'slack_approval_worker.py'), py, 'slack_approval_worker_v1');
  _mergeSchemaIntoJson(path.join(toolsDir, 'slack_approval_worker.json'), json);
  _seedFileForceUpgrade(path.join(toolsDir, 'slack_approval_worker.md'), md, 'Slack 승인 워커 (Socket Mode)');
}
