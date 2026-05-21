/**
 * Secretary 에이전트 도구 시드.
 *   - telegram_setup           : 양방향 봇 (Bot Token + Chat ID)
 *   - google_calendar          : iCal Secret URL 읽기 전용 (legacy)
 *   - google_calendar_write    : OAuth 양방향 (현재 표준)
 * v2.67+ 신규 설치는 google_calendar_write 만, google_calendar 는 구설치 호환 용.
 */

import * as path from 'path';
import {
  _loadToolSeed,
  _seedFile,
  _seedFileForceUpgrade,
} from './common';

/* ─── Secretary · Telegram 연결 도구 ────────────────────────────────────────
   Secretary is the canonical home for Telegram credentials. This seeds a
   telegram_setup tool so non-developer users can input bot token + chat_id
   via the Skills section's standard ⚙️ tool config modal — no markdown
   editing required. The .json field names match what _resolve_telegram
   looks for, and the .py runs a connectivity test on ▶ click. */
export function _seedSecretaryTelegram(toolsDir: string) {
  const py = _loadToolSeed('secretary/telegram_setup.py');
  /* JSON keys are inferred as password by _inferToolFieldType because they
     match KEY|SECRET|TOKEN|API regex. CHAT_ID falls into 'text' because no
     match — exactly what we want. */
  const jsonStr = JSON.stringify({
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_CHAT_ID: '',
  }, null, 2);
  const md = _loadToolSeed('secretary/telegram_setup.md');
  _seedFileForceUpgrade(path.join(toolsDir, 'telegram_setup.py'), py, 'secretary_telegram_v2');
  _seedFile(path.join(toolsDir, 'telegram_setup.json'), jsonStr);
  _seedFileForceUpgrade(path.join(toolsDir, 'telegram_setup.md'), md, '⚙️ 버튼을 누르고 폼에 입력');
}

/* ─── Secretary · Google Calendar (iCal 읽기 전용) ──────────────────────────
   비서가 사용자의 Google Calendar 일정을 읽어서 데일리 브리핑/시간 비교에
   활용. v1은 OAuth 없이 iCal Secret URL 한 줄로 끝나는 read-only 모델.
   ▶ 실행하면 다가오는 N일치 일정을 _shared/calendar_cache.md 에 저장하고
   다른 에이전트가 readAgentSharedContext에서 자동 참조하게 됩니다. */
export function _seedSecretaryGoogleCalendar(toolsDir: string) {
  const py = _loadToolSeed('secretary/google_calendar.py');
  const jsonStr = JSON.stringify({
    ICAL_URL: '',
    DAYS_AHEAD: 14,
  }, null, 2);
  const md = _loadToolSeed('secretary/google_calendar.md');
  _seedFileForceUpgrade(path.join(toolsDir, 'google_calendar.py'), py, 'secretary_calendar_v1');
  _seedFile(path.join(toolsDir, 'google_calendar.json'), jsonStr);
  _seedFileForceUpgrade(path.join(toolsDir, 'google_calendar.md'), md, '가벼운 읽기, iCal');
}

/* ─── Secretary · Google Calendar Write (OAuth 자동 일정 등록) ────────────
   The actual OAuth dance + event creation is driven from TypeScript (host
   has axios + can spin up a loopback HTTP server). This Python is purely a
   status/diagnostic tool: ▶ shows whether the connection is alive. */
export function _seedSecretaryGoogleCalendarWrite(toolsDir: string) {
  const py = _loadToolSeed('secretary/google_calendar_write.py');
  /* Empty-ish JSON — actual values come from the wizard. CALENDAR_ID and
     DEFAULT_DURATION_MINUTES are user-tunable via the standard ⚙️ form. */
  const jsonStr = JSON.stringify({
    CLIENT_ID: '',
    CLIENT_SECRET: '',
    REFRESH_TOKEN: '',
    CALENDAR_ID: 'primary',
    DEFAULT_DURATION_MINUTES: 60,
  }, null, 2);
  const md = _loadToolSeed('secretary/google_calendar_write.md');
  _seedFileForceUpgrade(path.join(toolsDir, 'google_calendar_write.py'), py, 'secretary_calendar_write_v1');
  _seedFile(path.join(toolsDir, 'google_calendar_write.json'), jsonStr);
  _seedFileForceUpgrade(path.join(toolsDir, 'google_calendar_write.md'), md, '비서가 본인의 Google Calendar와 양방향 연결');
}
