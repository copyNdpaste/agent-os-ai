/**
 * Developer (코다리) 에이전트 도구 시드.
 *   - web_init     : 5종 템플릿 자동 셋업 (vite·next·astro·expo·vanilla)
 *   - web_preview  : dev server 백그라운드 + URL 자동 오픈
 *   - pwa_setup    : manifest·sw·아이콘 자동 생성
 *   - pack_apply   : 두뇌의 키트 적용 + npm install
 *   - lint_test    : 자가 검증 (tsc·py_compile·npm scripts)
 * v2.89.112 ~ v2.89.122.
 */

import * as path from 'path';
import {
  _loadToolSeed,
  _seedFileForceUpgrade,
  _mergeSchemaIntoJson,
} from './common';

export function _seedDeveloperWebInit(toolsDir: string) {
  const py = _loadToolSeed('developer/web_init.py');
  const md = _loadToolSeed('developer/web_init.md');
  const json = JSON.stringify({
    TEMPLATE: 'vite-react',
    PROJECT_NAME: 'my-app',
    OUTPUT_DIR: '',
    _schema: {
      TEMPLATE: {
        type: 'select',
        label: '🎨 템플릿',
        hint: '프로젝트 종류. vite-react는 SPA, nextjs는 풀스택, astro는 콘텐츠, expo는 모바일 앱, vanilla는 단순 HTML.',
        options: [
          { value: 'vite-react', label: '⚡ Vite + React + TS + Tailwind (SPA · 추천)' },
          { value: 'nextjs',     label: '▲ Next.js 14 + TS + Tailwind (풀스택)' },
          { value: 'astro',      label: '🚀 Astro + Tailwind (블로그 · 콘텐츠)' },
          { value: 'expo',       label: '📱 Expo (iOS/Android 모바일 앱)' },
          { value: 'vanilla',    label: '📄 Vanilla HTML+CSS+JS (단순)' },
        ],
      },
      PROJECT_NAME: {
        type: 'text',
        label: '📁 프로젝트 이름',
        hint: '소문자·숫자·하이픈만. 공백·한글 X. 예: my-blog, dashboard, portfolio',
      },
      OUTPUT_DIR: {
        type: 'text',
        label: '🗂️ 부모 폴더',
        hint: '비우면 ~/agent-os-ai-projects/. 다른 위치 원하면 절대경로.',
      },
    },
  }, null, 2);
  _seedFileForceUpgrade(path.join(toolsDir, 'web_init.py'), py, 'web_init_v3');
  _mergeSchemaIntoJson(path.join(toolsDir, 'web_init.json'), json);
  _seedFileForceUpgrade(path.join(toolsDir, 'web_init.md'), md, 'web_init_v1');
}

export function _seedDeveloperWebPreview(toolsDir: string) {
  const py = _loadToolSeed('developer/web_preview.py');
  const md = _loadToolSeed('developer/web_preview.md');
  const json = JSON.stringify({
    PROJECT_PATH: '',
    DEV_CMD: '',
    AUTO_OPEN: 'true',
    _schema: {
      PROJECT_PATH: { type: 'text', label: '📁 프로젝트 경로', hint: '비우면 web_init이 마지막에 만든 프로젝트 자동 사용' },
      DEV_CMD: { type: 'text', label: '▶️ dev 명령', hint: '비우면 package.json scripts.dev 자동 감지 (npm run dev)' },
      AUTO_OPEN: {
        type: 'select', label: '🌐 브라우저 자동 열기',
        options: [
          { value: 'true', label: 'O — URL 감지하면 브라우저 자동 오픈' },
          { value: 'false', label: 'X — 출력만, 브라우저 수동' },
        ],
      },
    },
  }, null, 2);
  _seedFileForceUpgrade(path.join(toolsDir, 'web_preview.py'), py, 'web_preview_v1');
  _mergeSchemaIntoJson(path.join(toolsDir, 'web_preview.json'), json);
  _seedFileForceUpgrade(path.join(toolsDir, 'web_preview.md'), md, 'web_preview_v1');
}

export function _seedDeveloperLintTest(toolsDir: string) {
  const py = _loadToolSeed('developer/lint_test.py');
  const md = _loadToolSeed('developer/lint_test.md');
  const json = JSON.stringify({
    PROJECT_PATH: '',
    STRICT: 'false',
    _schema: {
      PROJECT_PATH: { type: 'text', label: '📁 프로젝트 경로', hint: '비우면 web_init 마지막 결과 사용' },
      STRICT: {
        type: 'select', label: '⚙️ 엄격 모드',
        options: [
          { value: 'false', label: '느슨 — 모든 검증 시도 (기본)' },
          { value: 'true',  label: '엄격 — 첫 실패 시 중단' },
        ],
      },
    },
  }, null, 2);
  _seedFileForceUpgrade(path.join(toolsDir, 'lint_test.py'), py, 'lint_test_v1');
  _mergeSchemaIntoJson(path.join(toolsDir, 'lint_test.json'), json);
  _seedFileForceUpgrade(path.join(toolsDir, 'lint_test.md'), md, 'lint_test_v1');
}

export function _seedDeveloperPackApply(toolsDir: string) {
  const py = _loadToolSeed('developer/pack_apply.py');
  const md = _loadToolSeed('developer/pack_apply.md');
  const json = JSON.stringify({
    KIT_NAME: '',
    USER_INTENT: '',
    PROJECT_PATH: '',
    _schema: {
      KIT_NAME: {
        type: 'select',
        label: '🧩 키트 (명시 선택, 선택 사항)',
        hint: '비우면 USER_INTENT 로 자동 추론. 명시하면 무조건 그 키트 사용.',
        options: [
          { value: '',              label: '(자동 추론 — USER_INTENT 사용)' },
          { value: 'landing-kit',   label: '🏠 Landing Kit — SaaS 랜딩 (6 섹션)' },
          { value: 'portfolio-kit', label: '👤 Portfolio Kit — 1인 크리에이터 (5 섹션)' },
          { value: 'dashboard-kit', label: '📊 Dashboard Kit — SaaS 관리자' },
          { value: 'mobile-kit',    label: '📱 Mobile Kit — Expo 모바일 앱 (3 화면)' },
        ],
      },
      USER_INTENT: {
        type: 'text',
        label: '🎯 사용자 의도 (자연어, 자동 매칭용)',
        hint: '예: "다이어트 SaaS 랜딩" → 자동으로 landing-kit. "내 작품 모음" → portfolio-kit.',
      },
      PROJECT_PATH: {
        type: 'text',
        label: '📁 적용할 프로젝트 경로',
        hint: '비우면 web_init 이 마지막에 만든 프로젝트 자동 사용',
      },
    },
  }, null, 2);
  _seedFileForceUpgrade(path.join(toolsDir, 'pack_apply.py'), py, 'pack_apply_v7_1');
  _mergeSchemaIntoJson(path.join(toolsDir, 'pack_apply.json'), json);
  _seedFileForceUpgrade(path.join(toolsDir, 'pack_apply.md'), md, 'pack_apply_v1');
}

export function _seedDeveloperPwaSetup(toolsDir: string) {
  const py = _loadToolSeed('developer/pwa_setup.py');
  const md = _loadToolSeed('developer/pwa_setup.md');
  const json = JSON.stringify({
    PROJECT_PATH: '',
    APP_NAME: '',
    APP_SHORT_NAME: '',
    THEME_COLOR: '#667eea',
    BACKGROUND_COLOR: '#ffffff',
    ICON_EMOJI: '✦',
    _schema: {
      PROJECT_PATH: { type: 'text', label: '📁 프로젝트 경로', hint: '비우면 web_init 결과 자동 사용' },
      APP_NAME: { type: 'text', label: '📱 앱 이름', hint: '홈 화면에 표시될 풀 이름. 비우면 폴더명.' },
      APP_SHORT_NAME: { type: 'text', label: '🏷️ 짧은 이름', hint: '12자 이하. 비우면 앱 이름 잘라서.' },
      THEME_COLOR: { type: 'text', label: '🎨 테마 색', hint: '상단 바 색. #RRGGBB' },
      BACKGROUND_COLOR: { type: 'text', label: '🖼️ 스플래시 배경', hint: '앱 시작 화면 배경. #RRGGBB' },
      ICON_EMOJI: { type: 'text', label: '✨ 아이콘 이모지', hint: '아이콘에 쓸 이모지 (예: 📚 ✦ 🎯)' },
    },
  }, null, 2);
  _seedFileForceUpgrade(path.join(toolsDir, 'pwa_setup.py'), py, 'pwa_setup_v1');
  _mergeSchemaIntoJson(path.join(toolsDir, 'pwa_setup.json'), json);
  _seedFileForceUpgrade(path.join(toolsDir, 'pwa_setup.md'), md, 'pwa_setup_v1');
}
