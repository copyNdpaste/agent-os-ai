/* v2.91.x — seeds 모듈 entrypoint.
 *
 * extension.ts 에서 import 하는 4가지 함수만 외부 노출:
 *   _seedAgentToolsIfMissing(agentId)  — 에이전트별 도구 시드 dispatch
 *   _seedAgentGoalIfMissing(agentId)
 *   _seedAgentToolsManifestIfMissing(agentId)
 *   _seedBundledTemplates(agentId, targetDir)
 *
 * v2.92 (agent-os-ai 분리): instagram 분기 제거.
 *   - 한일 SNS 자동 컨텐츠 봇 (Threads/IG/X 업로더 + workflow) 은 별도 repo
 *     `content-bot-ai` 로 이동: https://github.com/copyNdpaste/content-bot-ai
 *   - agent-os-ai 는 운영 본부 (확장 + 9 에이전트) 역할만.
 *   - instagram 에이전트 자체는 AGENTS 에 남아있어서 채팅·기획 가능, 자동 게시 X.
 */
import * as path from 'path';
import * as fs from 'fs';
import { getCompanyDir } from '../paths';

import { _seedBusinessPaypalRevenue } from './business';
import {
  _seedDeveloperWebInit,
  _seedDeveloperWebPreview,
  _seedDeveloperLintTest,
  _seedDeveloperPackApply,
  _seedDeveloperPwaSetup,
} from './developer';
import {
  _seedEditorMusicStudioSetup,
  _seedEditorMusicGenerate,
  _seedEditorMusicToVideo,
} from './editor';
import {
  _seedSecretaryTelegram,
  _seedSecretaryGoogleCalendar,
  _seedSecretaryGoogleCalendarWrite,
} from './secretary';
import {
  _seedYouTubeTrendSniper,
  _seedYouTubeAutoPlanner,
  _seedYouTubeAccount,
  _seedYouTubeMyVideosCheck,
  _seedYouTubeChannelFullAnalysis,
} from './youtube';

export { _loadToolSeed, _seedFile, _seedFileForceUpgrade } from './common';
export { _seedAgentGoalIfMissing, _seedAgentToolsManifestIfMissing } from './manifest-and-goal';
export { _seedBundledTemplates } from './manifest-and-goal';

/** 에이전트 id 별로 도구 시드 함수들을 일괄 호출.
 *  ensureCompanyStructure() 가 모든 에이전트에 대해 호출. */
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
    } else if (agentId === 'secretary') {
      const toolsDir = path.join(getCompanyDir(), '_agents', agentId, 'tools');
      fs.mkdirSync(toolsDir, { recursive: true });
      _seedSecretaryTelegram(toolsDir);
      _seedSecretaryGoogleCalendarWrite(toolsDir);
    } else if (agentId === 'editor') {
      const toolsDir = path.join(getCompanyDir(), '_agents', agentId, 'tools');
      fs.mkdirSync(toolsDir, { recursive: true });
      _seedEditorMusicStudioSetup(toolsDir);
      _seedEditorMusicGenerate(toolsDir);
      _seedEditorMusicToVideo(toolsDir);
    } else if (agentId === 'developer') {
      const toolsDir = path.join(getCompanyDir(), '_agents', agentId, 'tools');
      fs.mkdirSync(toolsDir, { recursive: true });
      _seedDeveloperWebInit(toolsDir);
      _seedDeveloperWebPreview(toolsDir);
      _seedDeveloperPwaSetup(toolsDir);
      _seedDeveloperPackApply(toolsDir);
      _seedDeveloperLintTest(toolsDir);
    } else if (agentId === 'business') {
      const toolsDir = path.join(getCompanyDir(), '_agents', agentId, 'tools');
      fs.mkdirSync(toolsDir, { recursive: true });
      _seedBusinessPaypalRevenue(toolsDir);
    }
    /* instagram 에이전트는 content-bot-ai 별도 repo 에서 처리.
       https://github.com/copyNdpaste/content-bot-ai
       사장님이 content-bot-ai 셋업 후 launchd 로 자동 동작. */
  } catch { /* ignore */ }
}
