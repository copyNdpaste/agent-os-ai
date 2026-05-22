/**
 * Company directory structure: creation, migration, and folder picker flows.
 *
 * Extracted from src/extension.ts. These are the functions that wire up the
 * `_company/` subtree on disk:
 *   - `ensureCompanyStructure` — idempotent skeleton creator (`_shared/`,
 *     `_agents/<id>/`, sessions/, approvals/, .gitignore, _system.md, …).
 *   - `_migrateCompanyToSubdir` — one-shot mover for the pre-_company/ layout.
 *   - `_migrateCompanyToBrain` — one-shot unifier for old <brain>/Company/.
 *   - `_migrateYouTubeCredsToCanonical` — config.md → youtube_account.json.
 *   - `runConnectCompanyRepo` — palette command to set companyRepo.
 *   - `runChangeCompanyDir` — palette command to relocate the company folder.
 *
 * Cross-module dependencies pulled from '../extension' (already exported from
 * prior extraction cycles):
 *   - `_extCtx`, `_safeReadText`, `_activeChatProvider`
 *   - `AGENTS`, `AGENT_ORDER` (re-exported via '../agents')
 *   - `_safeGitAutoSyncCompany` (from '../git-sync/auto-sync')
 *   - `validateGitRemoteUrl` (from '../infra/git')
 *   - `_seedAgentGoalIfMissing`, `_seedAgentToolsIfMissing`,
 *     `_seedAgentToolsManifestIfMissing` (from '../seeds')
 *   - `_getBrainDir`, `getCompanyDir`, `COMPANY_SUBDIR`, `_resolvePathInput`
 *     (from '../paths')
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { _getBrainDir, getCompanyDir, COMPANY_SUBDIR, _resolvePathInput } from '../paths';
import { AGENTS, AGENT_ORDER } from '../agents';
import {
  _seedAgentGoalIfMissing,
  _seedAgentToolsIfMissing,
  _seedAgentToolsManifestIfMissing,
} from '../seeds';
import { validateGitRemoteUrl } from '../infra/git';
import { _safeGitAutoSyncCompany } from '../git-sync/auto-sync';
import {
  _extCtx,
  _safeReadText,
  _activeChatProvider,
} from '../extension';

/* One-shot migration: when the user upgrades from a layout where company
   files lived at the brain root, transparently move them under _company/.
   Runs at activation. Idempotent — does nothing if already migrated. */
export function _migrateCompanyToSubdir() {
  try {
    const root = _getBrainDir();
    if (!fs.existsSync(root)) return;
    const target = path.join(root, COMPANY_SUBDIR);
    if (fs.existsSync(target)) return; // already migrated
    const legacyDirs = ['_shared', '_agents', 'sessions', 'approvals'];
    const present = legacyDirs.filter(d => {
      try { return fs.statSync(path.join(root, d)).isDirectory(); } catch { return false; }
    });
    if (present.length === 0) return; // nothing to migrate
    fs.mkdirSync(target, { recursive: true });
    for (const d of present) {
      const src = path.join(root, d);
      const dst = path.join(target, d);
      try { fs.renameSync(src, dst); } catch (e) {
        console.warn(`[Agent OS] migration: rename ${d} failed`, e);
      }
    }
    console.log(`[Agent OS] migrated ${present.length} legacy folders under ${target}`);
  } catch (e) {
    console.warn('[Agent OS] _company/ migration failed', e);
  }
}

/* v2.89.16 — YouTube creds 자동 동기화. API 패널 v2.89.14 이전엔 키를 config.md에만
   저장했고 tools/youtube_account.json은 그대로 빈 채로. 도구 실행 시 빈 값 보고
   "API 키 없음" 에러. 활성화 시 한 번 점검해서 누락된 값 자동 복구. */
export function _migrateYouTubeCredsToCanonical() {
  try {
    const dir = getCompanyDir();
    const cfgPath = path.join(dir, '_agents', 'youtube', 'config.md');
    if (!fs.existsSync(cfgPath)) return;
    const cfgTxt = _safeReadText(cfgPath);
    /* 라인 시작 앵커 — 이전 read regex 버그 회피 */
    const apiKeyM = cfgTxt.match(/^YOUTUBE_API_KEY[ \t]*[:：=][ \t]*([^\r\n]+?)[ \t]*$/m);
    const channelM = cfgTxt.match(/^YOUTUBE_CHANNEL_ID[ \t]*[:：=][ \t]*([^\r\n]+?)[ \t]*$/m);
    /* v2.89.18 — OAuth Client ID/Secret도 같이 마이그레이션 */
    const oauthIdM = cfgTxt.match(/^YOUTUBE_OAUTH_CLIENT_ID[ \t]*[:：=][ \t]*([^\r\n]+?)[ \t]*$/m);
    const oauthSecretM = cfgTxt.match(/^YOUTUBE_OAUTH_CLIENT_SECRET[ \t]*[:：=][ \t]*([^\r\n]+?)[ \t]*$/m);
    const apiKey = apiKeyM ? apiKeyM[1].trim() : '';
    const channelId = channelM ? channelM[1].trim() : '';
    const oauthId = oauthIdM ? oauthIdM[1].trim() : '';
    const oauthSecret = oauthSecretM ? oauthSecretM[1].trim() : '';
    if (!apiKey && !channelId && !oauthId && !oauthSecret) return;
    const toolDir = path.join(dir, '_agents', 'youtube', 'tools');
    if (!fs.existsSync(toolDir)) return;
    const jsonPath = path.join(toolDir, 'youtube_account.json');
    let existing: Record<string, any> = {};
    if (fs.existsSync(jsonPath)) {
      try { existing = JSON.parse(fs.readFileSync(jsonPath, 'utf-8') || '{}'); } catch { /* malformed */ }
    }
    const existingKey = String(existing['YOUTUBE_API_KEY'] || '').trim();
    const existingChannel = String(existing['MY_CHANNEL_ID'] || '').trim();
    const existingOauthId = String(existing['YOUTUBE_OAUTH_CLIENT_ID'] || '').trim();
    const existingOauthSecret = String(existing['YOUTUBE_OAUTH_CLIENT_SECRET'] || '').trim();
    const needSync = (apiKey && !existingKey) || (channelId && !existingChannel) || (oauthId && !existingOauthId) || (oauthSecret && !existingOauthSecret);
    if (!needSync) return;
    /* 누락된 것만 채워줌 — 기존 값은 보존 */
    if (apiKey && !existingKey) existing['YOUTUBE_API_KEY'] = apiKey;
    if (channelId && !existingChannel) existing['MY_CHANNEL_ID'] = channelId;
    if (oauthId && !existingOauthId) existing['YOUTUBE_OAUTH_CLIENT_ID'] = oauthId;
    if (oauthSecret && !existingOauthSecret) existing['YOUTUBE_OAUTH_CLIENT_SECRET'] = oauthSecret;
    /* 누락 필드 기본값 */
    if (!('MY_CHANNEL_HANDLE' in existing)) existing['MY_CHANNEL_HANDLE'] = '';
    if (!('WATCHED_CHANNELS' in existing)) existing['WATCHED_CHANNELS'] = [];
    if (!('COMPETITOR_CHANNELS' in existing)) existing['COMPETITOR_CHANNELS'] = [];
    fs.writeFileSync(jsonPath, JSON.stringify(existing, null, 2));
    console.log('[migration] youtube_account.json synced from config.md');
  } catch (e: any) {
    console.warn('[migration] youtube_account.json sync failed:', e?.message || e);
  }
}

// One-time migration from the old `<brain>/Company/...` (or custom
// `companyDir`) layout to the unified flat layout. Called once on activate.
export function _migrateCompanyToBrain() {
  try {
    const brain = _getBrainDir();
    if (fs.existsSync(path.join(brain, '_shared'))) return; // already unified

    const cfg = vscode.workspace.getConfiguration('agentOs');
    let legacy = ((cfg.get('companyDir') as string | undefined) || '').trim();
    if (!legacy && _extCtx) {
      legacy = (_extCtx.globalState.get<string>('companyDir') || '').trim();
    }
    if (legacy.startsWith('~/')) legacy = path.join(os.homedir(), legacy.slice(2));
    if (!legacy) legacy = path.join(brain, 'Company');

    if (!fs.existsSync(path.join(legacy, '_shared'))) return; // nothing to migrate

    fs.mkdirSync(brain, { recursive: true });
    for (const name of fs.readdirSync(legacy)) {
      const src = path.join(legacy, name);
      const dst = path.join(brain, name);
      if (fs.existsSync(dst)) continue; // never overwrite user data
      try { fs.renameSync(src, dst); } catch { /* skip on cross-device */ }
    }
    if (legacy === path.join(brain, 'Company')) {
      try { fs.rmdirSync(legacy); } catch {}
    }
    try { cfg.update('companyDir', undefined, vscode.ConfigurationTarget.Global); } catch {}
    if (_extCtx) {
      try { _extCtx.globalState.update('companyDir', undefined); } catch {}
    }
    console.log(`Agent OS: migrated ${legacy} → ${brain}`);
  } catch (e) {
    console.error('Agent OS: company → brain migration failed', e);
  }
}

export function ensureCompanyStructure(): string {
  const dir = getCompanyDir();
  fs.mkdirSync(path.join(dir, '_shared'), { recursive: true });
  fs.mkdirSync(path.join(dir, '_agents'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'approvals', 'pending'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'approvals', 'history'), { recursive: true });
  AGENT_ORDER.forEach(id => {
    fs.mkdirSync(path.join(dir, '_agents', id), { recursive: true });
    _seedAgentGoalIfMissing(id);
    _seedAgentToolsIfMissing(id);
    _seedAgentToolsManifestIfMissing(id);
  });

  const goalsPath = path.join(dir, '_shared', 'goals.md');
  if (!fs.existsSync(goalsPath)) {
    fs.writeFileSync(goalsPath,
`# 🎯 공동 목표 (Company Goals)

_이 파일은 **모든 에이전트가 매번 읽는** 회사의 북극성입니다. 자유롭게 편집하세요._

## 장기 목표 (1년)
- [ ] (예) 유튜브 구독자 10만 달성
- [ ] (예) 인스타그램 팔로워 5만
- [ ] (예) 월 수익 500만원

## 단기 목표 (1개월)
- [ ] (예) 영상 4개 업로드
- [ ] (예) 릴스 12개 게시
`);
  }
  const idPath = path.join(dir, '_shared', 'identity.md');
  if (!fs.existsSync(idPath)) {
    fs.writeFileSync(idPath,
`# 🏢 회사 정체성 / 톤앤매너

_브랜드 보이스, 톤, 절대 금지어 등을 적으세요. 모든 에이전트가 매번 참조합니다._

- **회사 이름:**
- **대표자:**
- **타깃 청중:**
- **핵심 가치:**
- **브랜드 톤:**
- **금기 (절대 하지 말 것):**
`);
  }
  AGENT_ORDER.forEach(id => {
    const memPath = path.join(dir, '_agents', id, 'memory.md');
    if (!fs.existsSync(memPath)) {
      fs.writeFileSync(memPath,
`# ${AGENTS[id].emoji} ${AGENTS[id].name} (${AGENTS[id].role}) 개인 메모리

_${AGENTS[id].name} 에이전트만 읽고 쓰는 개인 노트. 학습·교훈·자주 쓰는 패턴이 누적됩니다._

## 학습 기록
`);
    }
    /* v2.89.115 — skills/ 디렉토리. memory.md(append-only firehose)와
       구분되는 "큐레이션된 재사용 패턴". 사용자가 텔레그램 `/skill` 또는
       명령 팔레트로 직전 산출물을 승격시킬 때 여기 저장됨. 매 호출 시
       readAgentSharedContext가 system prompt 위쪽에 주입. */
    const skillsDir = path.join(dir, '_agents', id, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    const skillReadme = path.join(skillsDir, 'README.md');
    if (!fs.existsSync(skillReadme)) {
      fs.writeFileSync(skillReadme,
`# ${AGENTS[id].emoji} ${AGENTS[id].name} 스킬

_재사용 가능한 패턴 모음. memory.md는 모든 활동의 로그(append-only firehose),
이 폴더는 **검증된 패턴만 골라낸 것**입니다. 각 \`*.md\` 파일은 다음 호출 시
${AGENTS[id].name}의 system prompt에 자동 주입됩니다._

## 어떻게 채우나요?
- 텔레그램에서 \`/skill\` (직전 산출물 자동 승격)
- VS Code 명령 팔레트: \`Agent OS: 방금 산출물 → 스킬로 저장\`
- 직접 이 폴더에 \`<주제>.md\` 파일을 만들어도 됩니다 (\`# 제목\` + 본문)

\`README.md\` 자체는 system prompt에 주입되지 않습니다.
`);
    }
    const promptPath = path.join(dir, '_agents', id, 'prompt.md');
    if (!fs.existsSync(promptPath)) {
      fs.writeFileSync(promptPath,
`# ${AGENTS[id].emoji} ${AGENTS[id].name} 페르소나 디테일

_여기에 ${AGENTS[id].name} 에이전트에게 주고 싶은 추가 지시·말투·취향·예시 등을 자유롭게 적으세요._
_매 호출 시 시스템 프롬프트에 자동 주입됩니다. (git에 동기화됨)_

`);
    }
    const configPath = path.join(dir, '_agents', id, 'config.md');
    if (!fs.existsSync(configPath)) {
      let presets = '';
      if (id === 'secretary') {
        presets = `\n## 텔레그램 봇\n_BotFather에서 봇을 만들고 토큰을 받으세요. https://t.me/BotFather_\n_그리고 본인 채팅 ID를 알아내려면 https://t.me/userinfobot 에 메시지를 보내세요._\n\n- TELEGRAM_BOT_TOKEN: \n- TELEGRAM_CHAT_ID: \n`;
      } else if (id === 'youtube') {
        presets = `\n## YouTube Data API\n- YOUTUBE_API_KEY: \n- YOUTUBE_CHANNEL_ID: \n`;
      } else if (id === 'instagram') {
        presets = `\n## Meta Graph API\n- META_ACCESS_TOKEN: \n- INSTAGRAM_BUSINESS_ID: \n`;
      } else if (id === 'designer') {
        presets = `\n## 디자인 도구\n- FIGMA_TOKEN: \n- STITCH_API_KEY: \n`;
      }
      fs.writeFileSync(configPath,
`# ${AGENTS[id].emoji} ${AGENTS[id].name} 설정 (시크릿)

_이 파일은 \`.gitignore\`에 의해 깃 동기화에서 제외됩니다. API 키·토큰을 자유롭게 적으세요._
${presets}
`);
    }
  });

  // .gitignore — 시크릿과 캐시 보호
  const giPath = path.join(dir, '.gitignore');
  const desiredGi =
`# 자동 생성 — Agent OS 1인 기업 모드
# 시크릿·API 키 보호
_agents/*/config.md
# 도구 설정 JSON 안에 API 키·텔레그램 봇 토큰이 들어갈 수 있어 git에서 제외
_agents/*/tools/*.json
_agents/*/tools/youtube_account.json

# 외부 API 응답 캐시 (재현 가능)
_cache/

# 대용량 임시 산출물
_tmp/
*.log
`;
  if (!fs.existsSync(giPath)) {
    fs.writeFileSync(giPath, desiredGi);
  } else {
    /* Migrate old gitignore that didn't list tool JSONs — append the
       missing rules so existing users get token protection without us
       clobbering anything they manually added. */
    let cur = '';
    try { cur = fs.readFileSync(giPath, 'utf-8'); } catch { /* ignore */ }
    const additions: string[] = [];
    if (!cur.includes('_agents/*/tools/*.json')) {
      additions.push('# 도구 설정 JSON 안에 API 키·텔레그램 봇 토큰이 들어갈 수 있어 git에서 제외');
      additions.push('_agents/*/tools/*.json');
    }
    if (!cur.includes('youtube_account.json')) {
      additions.push('_agents/*/tools/youtube_account.json');
    }
    if (additions.length > 0) {
      try { fs.appendFileSync(giPath, '\n' + additions.join('\n') + '\n'); } catch { /* ignore */ }
    }
  }

  // _system.md — 시스템 자가 매뉴얼 (사람도 읽고 LLM도 컨텍스트로)
  const sysPath = path.join(dir, '_shared', '_system.md');
  if (!fs.existsSync(sysPath)) {
    fs.writeFileSync(sysPath,
`# 🧬 1인 기업 OS — 자가 매뉴얼

## 이 폴더는 무엇인가요?
당신의 1인 기업의 두뇌입니다. 7명의 AI 에이전트가 여기서 일합니다.

## 폴더 구조
- \`_shared/\` — 모든 에이전트가 매번 읽는 공동 메모리
  - \`identity.md\` — 회사 정체성 (이름, 톤, 가치)
  - \`goals.md\` — 목표
  - \`decisions.md\` — 의사결정 로그 (자가학습이 자동 누적)
  - \`_system.md\` — 이 파일
- \`_agents/<id>/\` — 각 에이전트 개인 공간
  - \`memory.md\` — 자가학습 (자동, append-only)
  - \`prompt.md\` — 페르소나 디테일 (사용자가 편집)
  - \`config.md\` — API 키·시크릿 (\`.gitignore\`로 보호)
- \`sessions/<ts>/\` — 세션별 산출물 (자동)
- \`_cache/\` — API 응답 캐시 (sync 제외)

## 메모리 위계 (충돌 시 우선순위)
1. \`decisions.md\` — 가장 강한 신뢰
2. \`identity.md\`
3. \`goals.md\`
4. 개인 메모리
5. 지식 베이스 (\`10_Wiki/\`)

## 다른 PC로 옮길 때
1. 새 PC에 Agent OS 설치
2. 👔 모드 ON → "📥 다른 PC에서 가져오기" 선택
3. GitHub URL 입력 → 자동 clone
4. 끝.

## 동기화 정책
- \`_shared/\`, \`_agents/*/memory.md\`, \`_agents/*/prompt.md\`, \`sessions/\` → git sync ✅
- \`_agents/*/config.md\`, \`_cache/\` → git sync ❌ (시크릿·캐시)

## 7명의 에이전트
${AGENT_ORDER.map(id => `- ${AGENTS[id].emoji} **${AGENTS[id].name}** (${AGENTS[id].role}): ${AGENTS[id].specialty}`).join('\n')}
`);
  }

  return dir;
}

export async function runConnectCompanyRepo() {
    const cfg = vscode.workspace.getConfiguration('agentOs');
    const companyDir = getCompanyDir();
    const brainDir = _getBrainDir();
    const isNested = path.normalize(companyDir).startsWith(path.normalize(brainDir) + path.sep);
    if (isNested) {
        const ok = await vscode.window.showInformationMessage(
            `회사 폴더가 두뇌 안 nested 위치에 있어요 — 두뇌 GitHub 저장소(\`secondBrainRepo\`)로 이미 같이 백업됩니다.\n\n별도 저장소를 쓰려면 먼저 명령 팔레트에서 "Agent OS: 회사 폴더 변경"으로 회사를 두뇌 외부로 옮기세요.`,
            { modal: false },
            '회사 폴더 변경하기',
            '괜찮아요'
        );
        if (ok === '회사 폴더 변경하기') {
            await runChangeCompanyDir();
        }
        return;
    }
    const cur = (cfg.get<string>('companyRepo', '') || '').trim();
    const url = await vscode.window.showInputBox({
        title: '🔗 회사 GitHub 저장소 URL',
        prompt: '예: https://github.com/사용자/my-company-workspace  (비워두면 회사 백업 OFF)',
        value: cur,
        ignoreFocusOut: true,
        placeHolder: 'https://github.com/...',
        validateInput: (v: string) => {
            const t = (v || '').trim();
            if (!t) return null; // empty = clear setting
            if (!validateGitRemoteUrl(t)) return '⚠️ 유효한 git URL이 아닌 것 같아요. https://github.com/ 또는 git@ 형식';
            return null;
        }
    });
    if (url === undefined) return; // user cancelled
    const cleaned = url.trim();
    await cfg.update('companyRepo', cleaned, vscode.ConfigurationTarget.Global);
    if (!cleaned) {
        await vscode.window.showInformationMessage('회사 GitHub 저장소 연결 해제됨. 회사 폴더는 로컬에만 저장됩니다.');
        return;
    }
    /* Try a first sync immediately so user gets instant feedback. */
    await vscode.window.showInformationMessage(`✅ 회사 GitHub 연결됨: ${cleaned.replace(/^https:\/\/[^@]+@/, 'https://')}\n\n첫 백업을 시도합니다…`);
    await _safeGitAutoSyncCompany(`Initial company backup`, _activeChatProvider);
}

/* Folder-picker driven flow for changing where the company workspace lives.
   Three paths the user can take:
     A) Nested under brain (default, recommended for solo users)
     B) Pick another folder (detached — separate git repo, team-shared, ...)
     C) Cancel */
export async function runChangeCompanyDir() {
    const cfg = vscode.workspace.getConfiguration('agentOs');
    const cur = (cfg.get<string>('companyDir', '') || '').trim();
    const oldDir = getCompanyDir();
    const brainDir = _getBrainDir();
    const isNested = !cur || _resolvePathInput(cur) === path.join(brainDir, COMPANY_SUBDIR);
    const stateLine = isNested
        ? `현재: 📂 두뇌 안 nested (\`${path.join(brainDir, COMPANY_SUBDIR).replace(os.homedir(), '~')}\`)`
        : `현재: 📂 별도 위치 (\`${cur.replace(os.homedir(), '~')}\`)`;

    const picked = await vscode.window.showQuickPick(
        [
            { label: '$(folder) 두뇌 안 nested로 (권장 · 한 git repo)', description: '~/.../<두뇌>/_company/', value: 'nest' as const },
            { label: '$(folder-opened) 별도 폴더 직접 선택…', description: '두뇌와 완전히 분리. 외주 공유·다른 git repo·다른 동기화 가능', value: 'detach' as const },
            { label: '$(close) 취소', value: 'cancel' as const },
        ],
        { placeHolder: stateLine, ignoreFocusOut: true }
    );
    if (!picked || picked.value === 'cancel') return;

    let newDir = '';
    if (picked.value === 'nest') {
        newDir = path.join(brainDir, COMPANY_SUBDIR);
        await cfg.update('companyDir', '', vscode.ConfigurationTarget.Global);
    } else {
        const folder = await vscode.window.showOpenDialog({
            canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
            openLabel: '여기를 회사 폴더로',
            defaultUri: vscode.Uri.file(os.homedir()),
        });
        if (!folder || folder.length === 0) return;
        newDir = folder[0].fsPath;
        /* Sanity check — refuse silently-broken read-only picks (USB ROM,
           system folders, mounted snapshots, etc.). Bail with a clear msg
           BEFORE persisting the setting so user can retry without rolling
           back. */
        try {
            fs.accessSync(newDir, fs.constants.W_OK);
        } catch {
            await vscode.window.showErrorMessage(
                `❌ 이 폴더는 쓰기 권한이 없어요. 다른 폴더를 선택하세요: ${newDir.replace(os.homedir(), '~')}`
            );
            return;
        }
        await cfg.update('companyDir', newDir, vscode.ConfigurationTarget.Global);
    }

    /* Move existing data if old has content + new is empty/non-existent.
       Otherwise leave both alone — refuse to merge silently to avoid
       overwriting anything. */
    if (newDir === oldDir) {
        await vscode.window.showInformationMessage(`회사 폴더 위치 변경 없음.`);
        return;
    }
    const oldHasData = fs.existsSync(oldDir) && fs.readdirSync(oldDir).length > 0;
    const newHasData = fs.existsSync(newDir) && fs.readdirSync(newDir).length > 0;
    if (!oldHasData) {
        await vscode.window.showInformationMessage(`✅ 회사 폴더 위치 설정됨: ${newDir.replace(os.homedir(), '~')}`);
        return;
    }
    if (newHasData) {
        await vscode.window.showWarningMessage(
            `⚠️ 새 위치(${path.basename(newDir)})에 이미 파일이 있어서 자동 이동을 건너뜁니다. 옛 폴더(${oldDir.replace(os.homedir(), '~')})의 내용을 수동으로 합쳐주세요.`,
            { modal: false }
        );
        return;
    }
    const move = await vscode.window.showInformationMessage(
        `옛 회사 폴더 내용을 새 위치로 이동할까요?\n\n옛: ${oldDir.replace(os.homedir(), '~')}\n새: ${newDir.replace(os.homedir(), '~')}`,
        { modal: true },
        '이동',
        '나중에'
    );
    if (move === '이동') {
        try {
            fs.mkdirSync(newDir, { recursive: true });
            for (const entry of fs.readdirSync(oldDir)) {
                fs.renameSync(path.join(oldDir, entry), path.join(newDir, entry));
            }
            try { fs.rmdirSync(oldDir); } catch { /* maybe non-empty leftovers, ignore */ }
            await vscode.window.showInformationMessage(`✅ 이동 완료: ${newDir.replace(os.homedir(), '~')}`);
        } catch (e: any) {
            await vscode.window.showErrorMessage(`이동 실패: ${e?.message || e}`);
        }
    } else {
        await vscode.window.showInformationMessage(`✅ 위치만 바뀜. 옛 데이터는 ${oldDir.replace(os.homedir(), '~')} 에 그대로 남아있습니다.`);
    }
}
