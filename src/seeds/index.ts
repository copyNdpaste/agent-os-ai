/**
 * Seeds barrel — extension.ts 가 가져가야 할 모든 시드 API를 한 곳에서 re-export.
 *
 * Clean Architecture Phase 1 — 원래 extension.ts (1.4MB monolith) 안에 있던
 * ~3000줄의 `_seedXxx*` 함수들을 도메인별 7개 모듈로 분리:
 *   - common.ts            (헬퍼·번들 템플릿)
 *   - business.ts          (PayPal 매출)
 *   - youtube.ts           (8종 YouTube 도구)
 *   - instagram.ts         (Threads · IG · X · Slack)
 *   - secretary.ts         (Telegram · Calendar)
 *   - developer.ts         (web_init · pack_apply · pwa · lint_test · preview)
 *   - editor.ts            (음악 모델 셋업·생성·합성)
 *   - manifest-and-goal.ts (goal.md · tools.md 시드 + AGENT_TOOLS_CATALOG 상수)
 *
 * 비즈니스 로직 변경 0. 위치 이동만.
 */

import * as path from 'path';
import * as fs from 'fs';
import { getCompanyDir } from '../paths';

import {
  _seedYouTubeAccount,
  _seedYouTubeTrendSniper,
  _seedYouTubeAutoPlanner,
  _seedYouTubeMyVideosCheck,
  _seedYouTubeChannelFullAnalysis,
  _seedYouTubeCommentHarvester,
  _seedYouTubeCompetitorBrief,
  _seedYouTubeTelegramNotify,
} from './youtube';
import {
  _seedSecretaryTelegram,
  _seedSecretaryGoogleCalendarWrite,
} from './secretary';
import {
  _seedEditorMusicStudioSetup,
  _seedEditorMusicGenerate,
  _seedEditorMusicToVideo,
} from './editor';
import {
  _seedDeveloperWebInit,
  _seedDeveloperWebPreview,
  _seedDeveloperPwaSetup,
  _seedDeveloperPackApply,
  _seedDeveloperLintTest,
} from './developer';
import { _seedBusinessPaypalRevenue } from './business';
import {
  _seedInstagramTokenManager,
  _seedInstagramThreadsUploader,
  _seedInstagramPhotoUploader,
  _seedInstagramXUploader,
  _seedInstagramSlackNotifier,
  _seedInstagramSlackWorker,
} from './instagram';

/** Seed each agent's starter tools. Idempotent — only writes files that
 *  don't already exist, so users can edit/delete freely without us clobbering.
 *  YouTube has the deepest tool catalog. Secretary owns telegram credentials
 *  (architecturally the messenger) so non-developers can input via the UI. */
export function _seedAgentToolsIfMissing(agentId: string) {
  try {
    if (agentId === 'youtube') {
      const toolsDir = path.join(getCompanyDir(), '_agents', agentId, 'tools');
      fs.mkdirSync(toolsDir, { recursive: true });
      _seedYouTubeAccount(toolsDir);
      _seedYouTubeTrendSniper(toolsDir);
      _seedYouTubeAutoPlanner(toolsDir);
      _seedYouTubeMyVideosCheck(toolsDir);
      _seedYouTubeChannelFullAnalysis(toolsDir);
      _seedYouTubeCommentHarvester(toolsDir);
      _seedYouTubeCompetitorBrief(toolsDir);
      _seedYouTubeTelegramNotify(toolsDir);
    } else if (agentId === 'secretary') {
      const toolsDir = path.join(getCompanyDir(), '_agents', agentId, 'tools');
      fs.mkdirSync(toolsDir, { recursive: true });
      _seedSecretaryTelegram(toolsDir);
      /* v2.67: drop iCal-only tool from new installs — OAuth covers reading
         too, and having two "Google Calendar" entries was confusing. The
         iCal helper still exists for users on older installs (their files
         remain), but listAgentTools hides it whenever the OAuth tool is
         present so they only see ONE calendar entry. */
      _seedSecretaryGoogleCalendarWrite(toolsDir);
    } else if (agentId === 'editor') {
      /* v2.89.68 — 사운드/음악 에이전트 도구. ACE-Step 1.5 로컬 음악 생성 모델 사용. */
      const toolsDir = path.join(getCompanyDir(), '_agents', agentId, 'tools');
      fs.mkdirSync(toolsDir, { recursive: true });
      _seedEditorMusicStudioSetup(toolsDir);
      _seedEditorMusicGenerate(toolsDir);
      _seedEditorMusicToVideo(toolsDir);
    } else if (agentId === 'developer') {
      /* v2.89.112+122 — 개발신 도구. 웹·모바일 셋업 + PWA + dev server + 키트 적용. */
      const toolsDir = path.join(getCompanyDir(), '_agents', agentId, 'tools');
      fs.mkdirSync(toolsDir, { recursive: true });
      _seedDeveloperWebInit(toolsDir);
      _seedDeveloperWebPreview(toolsDir);
      _seedDeveloperPwaSetup(toolsDir);
      _seedDeveloperPackApply(toolsDir);
      _seedDeveloperLintTest(toolsDir);
    } else if (agentId === 'business') {
      /* v2.89.121 — 비즈니스 에이전트 도구. PayPal 매출 자동 분석. */
      const toolsDir = path.join(getCompanyDir(), '_agents', agentId, 'tools');
      fs.mkdirSync(toolsDir, { recursive: true });
      _seedBusinessPaypalRevenue(toolsDir);
    } else if (agentId === 'instagram') {
      /* v2.90.x — 쓰레드·인스타 자동 업로더. draft mode 기본, 메타 토큰 채우면 real-post.
         v2.91.x — 멀티 계정 + token_manager 자동 토큰 갱신 도입.
         v2.92.x — X (Twitter) 업로더 + Threads/IG 영상·캐러셀 지원. */
      const toolsDir = path.join(getCompanyDir(), '_agents', agentId, 'tools');
      fs.mkdirSync(toolsDir, { recursive: true });
      _seedInstagramTokenManager(toolsDir);
      _seedInstagramThreadsUploader(toolsDir);
      _seedInstagramPhotoUploader(toolsDir);
      _seedInstagramXUploader(toolsDir);
      _seedInstagramSlackNotifier(toolsDir);
      _seedInstagramSlackWorker(toolsDir);
    }
  } catch { /* ignore */ }
}

// Re-exports that extension.ts and helpers need
export {
  _loadToolSeed,
  _seedFile,
  _seedFileForceUpgrade,
  _seedBundledTemplates,
} from './common';
export {
  _seedAgentGoalIfMissing,
  _seedAgentToolsManifestIfMissing,
} from './manifest-and-goal';
