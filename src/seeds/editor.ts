/**
 * Editor (사운드) 에이전트 도구 시드 — MusicGen / ACE-Step 로컬 음악 생성.
 *   - music_studio_setup : 모델 다운로드 + venv 셋업
 *   - music_generate     : 프롬프트 → BGM
 *   - music_to_video     : 영상에 BGM 합성 (loop / fade)
 * v2.89.68 ~ v2.89.85.
 */

import * as path from 'path';
import {
  _loadToolSeed,
  _seedFile,
  _seedFileForceUpgrade,
  _mergeSchemaIntoJson,
} from './common';

export function _seedEditorMusicStudioSetup(toolsDir: string) {
  const py = _loadToolSeed('editor/music_studio_setup.py');
  const md = _loadToolSeed('editor/music_studio_setup.md');
  /* v2.89.72 — _schema 메타로 MODEL을 드롭다운으로 노출. 사용자가 텍스트 입력 안 하고 클릭으로 선택. */
  const json = JSON.stringify({
    MODEL: '',
    INSTALL_DIR: '',
    _schema: {
      MODEL: {
        type: 'select',
        label: '🎵 음악 모델',
        hint: '비워두면 small 자동 선택 (모든 기기 안전). 큰 모델은 명시 RAM의 1.5~2배 실제 압박',
        options: [
          { value: '', label: '(자동 — 항상 small, 가장 안전)' },
          { value: 'musicgen-small',  label: '⚡ MusicGen Small  (300MB · 4GB+ RAM · 빠름)' },
          { value: 'musicgen-medium', label: '⚖️ MusicGen Medium (1.5GB · 8GB+ RAM · 균형)' },
          { value: 'musicgen-large',  label: '🎼 MusicGen Large  (3.3GB · 16GB+ RAM · 좋음)' },
          { value: 'acestep-base',    label: '🎹 ACE-Step Base   (10GB · 16GB+ Mac · 우수)' },
          { value: 'acestep-xl',      label: '🎻 ACE-Step XL     (15GB · 32GB+ 머신 · 최고)' },
        ],
      },
      INSTALL_DIR: {
        type: 'text',
        label: '📁 설치 위치',
        hint: '비워두면 ~/connect-ai-music/. 외장 디스크 등 변경 가능',
      },
    },
  }, null, 2);
  _seedFileForceUpgrade(path.join(toolsDir, 'music_studio_setup.py'), py, 'music_v5');
  // v2.89.85 — _seedFile → _mergeSchemaIntoJson. 기존 설치자의 json 에는
  // _schema 가 없어서 폼에 드롭다운이 안 떴음. 머지 헬퍼가 사용자 입력값
  // (MODEL/INSTALL_DIR) 과 도구가 자동 채워넣은 메타 (INSTALLED_·VENV_·
  // HF_ID·INSTALLED_AT) 는 그대로 보존하면서 _schema 만 최신화.
  _mergeSchemaIntoJson(path.join(toolsDir, 'music_studio_setup.json'), json);
  _seedFileForceUpgrade(path.join(toolsDir, 'music_studio_setup.md'), md, 'music_v5');
}

export function _seedEditorMusicGenerate(toolsDir: string) {
  const py = _loadToolSeed('editor/music_generate.py');
  const md = _loadToolSeed('editor/music_generate.md');
  const json = JSON.stringify({
    PROMPT: 'calm korean YouTube intro music, gentle piano, hopeful',
    DURATION_SEC: 30,
    GENRE: '',
    OUTPUT_DIR: '',
  }, null, 2);
  _seedFileForceUpgrade(path.join(toolsDir, 'music_generate.py'), py, 'music_v4');
  _seedFile(path.join(toolsDir, 'music_generate.json'), json);
  _seedFileForceUpgrade(path.join(toolsDir, 'music_generate.md'), md, 'music_v4');
}

export function _seedEditorMusicToVideo(toolsDir: string) {
  const py = _loadToolSeed('editor/music_to_video.py');
  const md = _loadToolSeed('editor/music_to_video.md');
  const json = JSON.stringify({
    VIDEO_PATH: '',
    MUSIC_PATH: '',
    BGM_VOLUME: 0.3,
    OUTPUT_PATH: '',
  }, null, 2);
  _seedFileForceUpgrade(path.join(toolsDir, 'music_to_video.py'), py, 'music_v3');
  _seedFile(path.join(toolsDir, 'music_to_video.json'), json);
  _seedFileForceUpgrade(path.join(toolsDir, 'music_to_video.md'), md, 'music_v3');
}
