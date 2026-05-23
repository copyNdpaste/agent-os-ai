const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
function toast(msg, err){ const t=$('toast'); t.textContent=msg; t.classList.toggle('err',!!err); t.classList.add('show'); setTimeout(()=>t.classList.remove('show'), 2400); }

/* Provenance badge — shows whether a field's value came from the company
   default or this project's override. Renders inline after the label. */
function scopeBadge(scope) {
  if (scope === 'project') return '<span class="svc-scope-badge sb-project" title="이 프로젝트(workspace) 전용 키">PROJECT</span>';
  if (scope === 'company') return '<span class="svc-scope-badge sb-company" title="회사 기본값 (모든 프로젝트 공유)">COMPANY</span>';
  return '<span class="svc-scope-badge sb-empty">없음</span>';
}

function render(s){
  const grid = $('grid');
  const hasWorkspace = !!s.hasWorkspace;
  const workspaceName = s.workspaceName || '';
  grid.innerHTML = s.services.map(svc => {
    const connected = !svc.comingSoon && svc.fields.every(f => (svc.values[f.key] || '').trim().length > 0);
    let status;
    if (svc.comingSoon) status = '<span class="svc-status coming">준비 중</span>';
    else if (connected) status = '<span class="svc-status connected">연결됨</span>';
    else status = '<span class="svc-status">미설정</span>';

    /* Scope toggle — only meaningful when the service allows project override
       AND a workspace is currently open. company-only services hide it. */
    const allowProject = svc.scopeHint !== 'company-only' && !svc.comingSoon;
    const isProjectScoped = !!svc.hasProjectOverride;
    let scopeToggleHtml = '';
    if (allowProject) {
      if (!hasWorkspace) {
        scopeToggleHtml =
          '<div class="svc-scope-row svc-scope-disabled" title="프로젝트 폴더가 열려 있어야 프로젝트 전용 키 저장이 가능합니다">'
          + '<input type="checkbox" disabled> '
          + '<span class="ss-label">이 프로젝트만 다른 키 쓰기</span>'
          + '<span class="ss-hint">(폴더 안 열림)</span>'
          + '</div>';
      } else {
        const checked = isProjectScoped ? ' checked' : '';
        const wsLabel = workspaceName ? ' — <code>' + esc(workspaceName) + '</code>' : '';
        scopeToggleHtml =
          '<div class="svc-scope-row">'
          + '<label><input type="checkbox" data-scope-toggle="1"' + checked + '> '
          +   '<span class="ss-label">이 프로젝트만 다른 키 쓰기</span>'
          +   '<span class="ss-hint">' + wsLabel + '</span>'
          + '</label>'
          + (isProjectScoped
              ? '<button class="ss-clear" data-act="clear-override" title="프로젝트 override 삭제 → 회사 기본값 복원">🔄 회사 기본값으로</button>'
              : '')
          + '</div>';
      }
    } else if (svc.scopeHint === 'company-only' && !svc.comingSoon) {
      scopeToggleHtml = '<div class="svc-scope-row svc-scope-info">🏢 회사 전체 단일 계정 (프로젝트별 분리 불가 — 텔레그램/Slack 등은 봇 1개로 통합 운영)</div>';
    }

    const fieldsHtml = svc.fields.map(f => {
      const val = svc.values[f.key] || '';
      const fieldScope = (svc.fieldScopes && svc.fieldScopes[f.key]) || 'none';
      const dis = svc.comingSoon ? ' disabled' : '';
      let inputEl;
      if (f.type === 'select' && Array.isArray(f.options)) {
        const opts = f.options.map(o =>
          '<option value="' + esc(o) + '"' + (o === val ? ' selected' : '') + '>' + esc(o) + '</option>'
        ).join('');
        inputEl = '<select' + dis + '>' + opts + '</select>';
      } else {
        const inputType = f.type === 'password' ? 'password' : 'text';
        inputEl = '<input type="' + inputType + '" value="' + esc(val) + '" placeholder="' + esc(f.placeholder || '') + '"' + dis + '>';
      }
      return '<div class="svc-field" data-key="' + esc(f.key) + '">'
        + '<label>' + esc(f.label) + (svc.comingSoon ? '' : scopeBadge(fieldScope)) + '</label>'
        + '<div class="svc-input-wrap">'
        +   inputEl
        +   (f.type === 'password' && !svc.comingSoon ? '<button class="svc-eye" data-eye="1" title="표시/숨김">👁</button>' : '')
        + '</div>'
        + (f.help ? '<div class="svc-help">' + esc(f.help) + '</div>' : '')
        + '</div>';
    }).join('');

    let actions = '';
    if (svc.comingSoon) {
      actions = '<div class="svc-coming-banner">곧 합류합니다 · 다음 업데이트에서 풀려요</div>';
    } else {
      actions = '<button class="btn primary" data-act="save">💾 저장</button>';
      if (svc.wizardCommand) actions += '<button class="btn" data-act="wizard">⚡ 자동 연결</button>';
      if (svc.helpUrl) actions += '<button class="btn ghost" data-act="help">📘 도움말</button>';
      actions = '<div class="svc-actions">' + actions + '</div>';
    }
    return '<div class="svc-card ' + (svc.comingSoon ? 'coming' : connected ? 'connected' : '') + (isProjectScoped ? ' has-override' : '') + '" data-svc="' + esc(svc.id) + '">'
      + '<div class="svc-head">'
      +   '<div class="svc-icon">' + esc(svc.icon) + '</div>'
      +   '<div><div class="svc-name">' + esc(svc.name) + '</div></div>'
      +   status
      + '</div>'
      + '<div class="svc-summary">' + esc(svc.summary) + '</div>'
      + scopeToggleHtml
      + '<div class="svc-fields">' + fieldsHtml + '</div>'
      + actions
      + '</div>';
  }).join('');
  /* Wire up handlers per card. */
  grid.querySelectorAll('.svc-card').forEach(card => {
    const id = card.dataset.svc;
    const svc = s.services.find(x => x.id === id);
    if (!svc) return;
    card.querySelectorAll('button[data-eye]').forEach(btn => {
      btn.onclick = () => {
        const inp = btn.previousElementSibling;
        inp.type = inp.type === 'password' ? 'text' : 'password';
      };
    });
    card.querySelectorAll('button[data-act]').forEach(btn => {
      btn.onclick = () => {
        const act = btn.dataset.act;
        if (act === 'save') {
          const values = {};
          card.querySelectorAll('.svc-field').forEach(fEl => {
            values[fEl.dataset.key] = (fEl.querySelector('input, select') || {}).value || '';
          });
          /* scope is decided by the toggle state (checked = project). When the
             toggle isn't rendered (company-only or coming-soon) we send
             'company' so storage falls through to the regular flow. */
          const toggle = card.querySelector('input[data-scope-toggle]');
          const scope = toggle && toggle.checked ? 'project' : 'company';
          vscode.postMessage({ type: 'save', serviceId: id, values, scope });
        } else if (act === 'clear-override') {
          vscode.postMessage({ type: 'clearProjectOverride', serviceId: id });
        } else if (act === 'wizard') {
          vscode.postMessage({ type: 'wizard', command: svc.wizardCommand });
        } else if (act === 'help') {
          vscode.postMessage({ type: 'openHelp', url: svc.helpUrl });
        }
      };
    });
  });
}
window.addEventListener('message', e => {
  const m = e.data;
  if (m.type === 'state') render(m);
  else if (m.type === 'saved') {
    const scopeLabel = m.scope === 'project' ? ' (프로젝트 전용)' : (m.scope === 'company' ? ' (회사 전체)' : '');
    toast(m.ok ? (m.note ? '✅ 저장됨' + scopeLabel + ' — ' + m.note : '✅ 저장됨' + scopeLabel) : ('⚠️ ' + (m.error || '저장 실패')), !m.ok);
  }
});
vscode.postMessage({ type: 'load' });
