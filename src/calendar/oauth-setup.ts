/**
 * Calendar OAuth setup wizard — 사용자를 Google Cloud Console 셋업으로
 * 가이드하고 loopback 서버로 refresh_token 을 받아 디스크에 저장.
 *
 * extension.ts 에서 분리. UI flow 라 vscode 의존이 강하지만 sibling
 * config / cache 모듈을 직접 import 해 extension.ts 결합을 최소화.
 *
 * Public:
 *   - runConnectGoogleCalendarWrite() — VS Code 명령 entry point
 *
 * Deps:
 *   - import * as vscode from 'vscode'
 *   - import axios from 'axios'
 *   - import * as http from 'http' (현재 함수 본문은 require('http') 사용 — byte-for-byte 보존)
 *   - import { readConfig, writeConfig, isConnected } from './config'
 *   - import { refreshCache } from './cache'
 *   - import { getCompanyDir } from '../paths'
 *
 * extension.ts 의 wrapper (readCalendarWriteConfig / writeCalendarWriteConfig /
 * isCalendarWriteConnected / refreshCalendarCacheViaOAuth) 는 이 파일 안에서
 * 로컬로 재정의 — 호출부를 byte-for-byte 그대로 유지하기 위함.
 */
import * as vscode from 'vscode';
import axios from 'axios';
import { readConfig, writeConfig, isConnected } from './config';
import { refreshCache } from './cache';
import type { CalendarWriteConfig, RefreshCacheResult } from './types';
import { getCompanyDir } from '../paths';

/* Local wrappers — extension.ts 의 동명 헬퍼와 동일 시그니처. 본문 byte-for-byte
   복사를 가능하게 한다. */
function readCalendarWriteConfig(): CalendarWriteConfig { return readConfig(getCompanyDir()) || {}; }
function writeCalendarWriteConfig(cfg: CalendarWriteConfig) { writeConfig(getCompanyDir(), cfg); }
function isCalendarWriteConnected(): boolean { return isConnected(getCompanyDir()); }
async function refreshCalendarCacheViaOAuth(daysAhead: number = 14): Promise<RefreshCacheResult> {
  return refreshCache(getCompanyDir(), daysAhead);
}

export async function runConnectGoogleCalendarWrite() {
  const cfg = readCalendarWriteConfig();
  const already = isCalendarWriteConnected();
  if (already) {
    const choice = await vscode.window.showInformationMessage(
      `✅ 이미 연결됨: ${cfg._CONNECTED_AS || 'Google 계정'}`,
      { modal: false },
      '연결 해제',
      '재연결',
      '취소'
    );
    if (choice === '연결 해제') {
      writeCalendarWriteConfig({ REFRESH_TOKEN: '', _CONNECTED_AS: '', _CONNECTED_AT: '' });
      await vscode.window.showInformationMessage('Google Calendar 쓰기 연결 해제됨.');
      return;
    }
    if (choice !== '재연결') return;
  }

  const intro = await vscode.window.showInformationMessage(
    `📅 Google Calendar 자동 일정 등록 — 셋업 (약 5~10분)\n\n1단계: Google Cloud Console에서 OAuth 클라이언트 만들기 (수동)\n2단계: Client ID + Secret 붙여넣기\n3단계: 브라우저로 로그인 → 끝\n\n시작할까요?`,
    { modal: true },
    '시작',
    'Google Cloud Console 먼저 열기',
    '취소'
  );
  if (intro === '취소' || !intro) return;
  if (intro === 'Google Cloud Console 먼저 열기') {
    await vscode.env.openExternal(vscode.Uri.parse('https://console.cloud.google.com/apis/credentials'));
    const back = await vscode.window.showInformationMessage(
      `Google Cloud에서 다음 단계를 마쳤으면 계속 →\n\n1. 새 프로젝트 만들기\n2. APIs & Services → Library → "Google Calendar API" 활성화\n3. OAuth 동의 화면 설정 (External, Test users에 본인 이메일)\n4. Credentials → Create OAuth 2.0 Client ID → 'Desktop app'\n5. Client ID + Client Secret 복사`,
      { modal: true },
      '다 됐음 →',
      '취소'
    );
    if (back !== '다 됐음 →') return;
  }

  const clientId = await vscode.window.showInputBox({
    title: 'Google OAuth Client ID',
    prompt: 'Google Cloud Credentials 페이지에서 복사한 Client ID',
    placeHolder: 'xxxxxxxx.apps.googleusercontent.com',
    ignoreFocusOut: true,
    validateInput: v => (v || '').trim() ? null : '비어있어요',
  });
  if (!clientId) return;
  const clientSecret = await vscode.window.showInputBox({
    title: 'Google OAuth Client Secret',
    prompt: '같은 화면의 Client Secret',
    placeHolder: 'GOCSPX-...',
    password: true,
    ignoreFocusOut: true,
    validateInput: v => (v || '').trim() ? null : '비어있어요',
  });
  if (!clientSecret) return;

  /* OAuth dance — spin up a one-shot local HTTP server, open browser,
     wait for ?code=... callback, exchange. */
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: '🔐 Google 로그인 대기 중…',
    cancellable: true,
  }, async (progress, cancelToken) => {
    progress.report({ message: '브라우저에서 Google 로그인 진행하세요' });
    const result = await _runCalendarOAuthLoopback(clientId.trim(), clientSecret.trim(), cancelToken);
    if (!result.ok) {
      await vscode.window.showErrorMessage(`OAuth 실패: ${result.error || '알 수 없는 오류'}`);
      return;
    }
    /* Verify token works by hitting userinfo */
    let connectedAs = '';
    try {
      const r = await axios.get('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${result.accessToken}` },
        timeout: 8000, validateStatus: () => true,
      });
      if (r.status >= 200 && r.status < 300) {
        connectedAs = r.data?.email || r.data?.name || '';
      }
    } catch { /* non-fatal */ }
    writeCalendarWriteConfig({
      CLIENT_ID: clientId.trim(),
      CLIENT_SECRET: clientSecret.trim(),
      REFRESH_TOKEN: result.refreshToken,
      CALENDAR_ID: 'primary',
      DEFAULT_DURATION_MINUTES: 60,
      _CONNECTED_AS: connectedAs,
      _CONNECTED_AT: new Date().toISOString(),
    });
    /* Immediately pull upcoming events too so calendar_cache.md is fresh —
       this means OAuth users don't need to also configure the iCal tool. */
    const refresh = await refreshCalendarCacheViaOAuth(14).catch(e => ({ ok: false, count: 0, error: String(e?.message || e) }));
    const refreshNote = refresh.ok
      ? `\n\n📥 다가오는 일정 ${refresh.count}개도 회사 컨텍스트에 동기화됨 (iCal 도구 별도 셋업 불필요)`
      : '';
    await vscode.window.showInformationMessage(
      `✅ Google Calendar 연결 완료!${connectedAs ? ' (' + connectedAs + ')' : ''}\n\n이제 due 있는 작업이 추적기에 등록되면 자동으로 캘린더에 일정이 만들어집니다.${refreshNote}`
    );
  });
}

async function _runCalendarOAuthLoopback(
  clientId: string,
  clientSecret: string,
  cancelToken: vscode.CancellationToken
): Promise<{ ok: true; accessToken: string; refreshToken: string } | { ok: false; error: string }> {
  return new Promise(resolve => {
    const http = require('http');
    let _resolved = false;
    function _resolve(v: any) { if (_resolved) return; _resolved = true; resolve(v); }
    /* Bind to ephemeral port (0) — Google accepts any localhost port for
       Desktop-app OAuth clients. */
    const server = http.createServer((req: any, res: any) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const code = url.searchParams.get('code');
        const err = url.searchParams.get('error');
        /* Ignore non-callback requests (favicon.ico, etc.) — browsers send
           these automatically and they don't carry code/error params. Without
           this guard the second request races with the token exchange and
           resolves with 'no code'. */
        if (!code && !err) {
          res.writeHead(204);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (err) {
          res.end(`<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent OS — 인증 실패</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#080a0f;color:#e2e8f0;font-family:'SF Pro Display','Pretendard',-apple-system,system-ui,sans-serif;overflow:hidden}
body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(239,68,68,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(239,68,68,.03) 1px,transparent 1px);background-size:40px 40px;animation:gridDrift 20s linear infinite}
@keyframes gridDrift{from{transform:translateY(0)}to{transform:translateY(40px)}}
.card{position:relative;text-align:center;padding:48px 40px;max-width:440px;width:90vw;background:linear-gradient(180deg,rgba(15,8,8,.96),rgba(8,6,6,.99));border:1px solid rgba(239,68,68,.35);border-radius:20px;box-shadow:0 0 80px rgba(239,68,68,.12),0 30px 80px rgba(0,0,0,.7)}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,#ef4444,transparent);border-radius:20px 20px 0 0}
.brand{font-family:'SF Mono','JetBrains Mono',monospace;font-size:10px;letter-spacing:3.5px;color:rgba(239,68,68,.6);text-transform:uppercase;margin-bottom:28px}
.icon{font-size:56px;margin-bottom:16px;filter:drop-shadow(0 0 20px rgba(239,68,68,.4))}
h1{font-size:22px;font-weight:700;color:#ef4444;margin-bottom:10px;text-shadow:0 0 14px rgba(239,68,68,.3)}
.msg{font-size:13px;color:#94a3b8;line-height:1.6;margin-bottom:8px}
.err{font-family:'SF Mono',monospace;font-size:11px;color:rgba(239,68,68,.7);background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.15);border-radius:8px;padding:8px 14px;margin:16px 0}
.hint{font-size:12px;color:#64748b;margin-top:20px}
</style></head><body>
<div class="card">
<div class="brand">Connect · AI Solopreneur OS</div>
<div class="icon">🔴</div>
<h1>인증 실패</h1>
<div class="err">${err}</div>
<p class="msg">Agent OS로 돌아가서 다시 시도해주세요.</p>
<p class="hint">이 탭은 닫아도 됩니다.</p>
</div>
</body></html>`);
          server.close();
          _resolve({ ok: false, error: err });
          return;
        }
        res.end(`<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent OS — 인증 완료</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#080a0f;color:#e2e8f0;font-family:'SF Pro Display','Pretendard',-apple-system,system-ui,sans-serif;overflow:hidden}
body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(0,255,65,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(0,255,65,.03) 1px,transparent 1px);background-size:40px 40px;animation:gridDrift 20s linear infinite}
@keyframes gridDrift{from{transform:translateY(0)}to{transform:translateY(40px)}}
body::after{content:'';position:fixed;inset:0;background:linear-gradient(180deg,transparent 0,transparent 50%,rgba(0,255,65,.04) 50.2%,transparent 51%);background-size:100% 220px;animation:scan 5s linear infinite;pointer-events:none}
@keyframes scan{from{background-position:0 -220px}to{background-position:0 100vh}}
.card{position:relative;text-align:center;padding:48px 40px;max-width:440px;width:90vw;background:linear-gradient(180deg,rgba(8,14,10,.96),rgba(4,8,5,.99));border:1px solid rgba(0,255,65,.35);border-radius:20px;box-shadow:0 0 80px rgba(0,255,65,.12),0 30px 80px rgba(0,0,0,.7);animation:cardIn .7s cubic-bezier(.16,1,.3,1)}
@keyframes cardIn{from{opacity:0;transform:translateY(20px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,#00ff41,transparent);border-radius:20px 20px 0 0;animation:linePulse 2s ease-in-out infinite}
@keyframes linePulse{0%,100%{opacity:.6}50%{opacity:1}}
.brand{font-family:'SF Mono','JetBrains Mono',monospace;font-size:10px;letter-spacing:3.5px;color:rgba(0,255,65,.5);text-transform:uppercase;margin-bottom:28px}
.ring{position:relative;width:100px;height:100px;margin:0 auto 24px;display:flex;align-items:center;justify-content:center}
.ring::before,.ring::after{content:'';position:absolute;inset:0;border-radius:50%;border:1.5px solid rgba(0,255,65,.4);border-top-color:transparent;border-right-color:transparent}
.ring::before{animation:spin 2s linear infinite}
.ring::after{inset:10px;border-color:rgba(0,255,65,.25);border-bottom-color:transparent;animation:spin 3s linear infinite reverse}
@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
.icon{font-size:44px;position:relative;z-index:2;filter:drop-shadow(0 0 20px rgba(0,255,65,.5));animation:iconPop .5s .3s cubic-bezier(.16,1,.3,1) both}
@keyframes iconPop{from{transform:scale(0);opacity:0}to{transform:scale(1);opacity:1}}
h1{font-size:22px;font-weight:700;color:#00ff41;margin-bottom:10px;text-shadow:0 0 14px rgba(0,255,65,.3);animation:fadeUp .5s .5s ease both}
.msg{font-size:13px;color:#94a3b8;line-height:1.6;animation:fadeUp .5s .6s ease both}
.msg strong{color:#22c55e}
@keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.countdown{font-family:'SF Mono',monospace;font-size:11px;color:rgba(0,255,65,.4);letter-spacing:2px;margin-top:24px;animation:fadeUp .5s .8s ease both}
.particles{position:fixed;inset:0;pointer-events:none;overflow:hidden}
.p{position:absolute;width:3px;height:3px;background:#00ff41;border-radius:50%;box-shadow:0 0 6px #00ff41;opacity:0;animation:fly 2s ease-out forwards}
@keyframes fly{0%{opacity:1;transform:translate(0,0) scale(1)}100%{opacity:0;transform:translate(var(--dx),var(--dy)) scale(0)}}
</style></head><body>
<div class="particles" id="pts"></div>
<div class="card">
<div class="brand">Connect · AI Solopreneur OS</div>
<div class="ring"><span class="icon">✅</span></div>
<h1>인증 완료!</h1>
<p class="msg">Google Calendar가 <strong>Agent OS</strong>에 연결됐어요.<br>이 탭은 자동으로 닫힙니다.</p>
<p class="countdown" id="cd">3초 후 닫힘</p>
</div>
<script>
(function(){
var pts=document.getElementById('pts');
for(var i=0;i<24;i++){
var p=document.createElement('span');p.className='p';
var a=(i/24)*Math.PI*2,d=80+Math.random()*160;
p.style.left='50%';p.style.top='50%';
p.style.setProperty('--dx',Math.cos(a)*d+'px');
p.style.setProperty('--dy',Math.sin(a)*d+'px');
p.style.animationDelay=(Math.random()*.4)+'s';
if(i%3===0){p.style.background='#22d3ee';p.style.boxShadow='0 0 6px #22d3ee'}
if(i%5===0){p.style.background='#a78bfa';p.style.boxShadow='0 0 6px #a78bfa'}
pts.appendChild(p);
}
var s=3;var cd=document.getElementById('cd');
var t=setInterval(function(){s--;if(s<=0){clearInterval(t);cd.textContent='닫는 중…';window.close();}else{cd.textContent=s+'초 후 닫힘';}},1000);
})();
</script>
</body></html>`);
        const port = (server.address() && server.address().port) || 0;
        const redirectUri = `http://localhost:${port}`;
        /* Exchange code for tokens */
        axios.post(
          'https://oauth2.googleapis.com/token',
          new URLSearchParams({
            code: code!,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
          }).toString(),
          {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 12000,
            validateStatus: () => true,
          }
        ).then((r: any) => {
          server.close();
          if (r.status >= 200 && r.status < 300 && r.data?.refresh_token) {
            _resolve({ ok: true, accessToken: r.data.access_token || '', refreshToken: r.data.refresh_token });
          } else {
            _resolve({ ok: false, error: r.data?.error_description || r.data?.error || `HTTP ${r.status}` });
          }
        }).catch((e: any) => {
          server.close();
          _resolve({ ok: false, error: e?.message || String(e) });
        });
      } catch (e: any) {
        try { server.close(); } catch { /* ignore */ }
        _resolve({ ok: false, error: e?.message || String(e) });
      }
    });
    server.listen(0, '127.0.0.1', async () => {
      const port = (server.address() && server.address().port) || 0;
      if (!port) {
        resolve({ ok: false, error: 'failed to bind localhost port' });
        return;
      }
      const redirectUri = `http://localhost:${port}`;
      const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'https://www.googleapis.com/auth/calendar.events openid email',
        access_type: 'offline',
        prompt: 'consent',
      }).toString();
      try { await vscode.env.openExternal(vscode.Uri.parse(authUrl)); } catch { /* user can copy from log */ }
      console.log('[Agent OS] Calendar OAuth URL:', authUrl);
    });
    /* Cancel after 3 minutes max */
    const timer = setTimeout(() => {
      try { server.close(); } catch { /* ignore */ }
      _resolve({ ok: false, error: '시간 초과 (3분). 다시 시도해주세요.' });
    }, 180_000);
    cancelToken.onCancellationRequested(() => {
      clearTimeout(timer);
      try { server.close(); } catch { /* ignore */ }
      _resolve({ ok: false, error: '사용자가 취소함' });
    });
  });
}
