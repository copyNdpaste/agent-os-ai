/**
 * OfficePanel HTML template — extracted from office-panel.ts to keep the
 * class file readable. Pure render function: takes the dynamic
 * interpolation values (currently just the CSP source) and returns the
 * webview HTML byte-for-byte identical to the previous inline template.
 */

export interface OfficePanelHtmlArgs {
    /** webview.cspSource for the Content-Security-Policy meta tag. */
    csp: string;
}

export function renderOfficePanelHtml(args: OfficePanelHtmlArgs): string {
    const { csp } = args;
    return `<!DOCTYPE html><html lang="ko"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp} data: blob: https: vscode-resource: vscode-webview-resource:; style-src ${csp} 'unsafe-inline'; script-src 'unsafe-inline'; font-src ${csp} data:;">
<title>🏢 가상 사무실</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:'SF Pro Display',-apple-system,'Segoe UI',sans-serif}
/* v2.86: unified to the matrix black + green palette across the whole app
   so the office, dashboard, and chat all share one identity. The amber
   override that used to flip on for "1인 기업 모드" is removed — having
   two parallel colors made the product feel like two different apps. */
:root{--accent:#38BDF8;--accent2:#1E40AF;--accent-glow:rgba(56,189,248,.22);--bg:#040608;--bg2:#080B10;--surface:rgba(15,22,30,.78);--border:rgba(255,255,255,.06);--text:#E5E7EB;--text-dim:#8A95A3;--text-bright:#fff}
html,body{width:100%;height:100%;background:var(--bg);color:var(--text);overflow:hidden}
body{display:flex;flex-direction:column}

/* ===== Top bar (v2.83 redesign) =====
   Three-zone layout — brand on the left, HUD stat strip in the middle,
   action buttons on the right. Replaces the old cramped single-row stack. */
.topbar{
  position:relative;display:grid;grid-template-columns:auto 1fr auto;
  align-items:center;gap:20px;padding:14px 22px;
  background:linear-gradient(180deg,rgba(10,8,5,.96),rgba(8,7,4,.78));
  border-bottom:1px solid var(--border);flex-shrink:0;
  backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);z-index:10;
  font-family:'Inter','SF Pro Display',-apple-system,system-ui,sans-serif;
}
.topbar::after{
  content:'';position:absolute;left:0;right:0;bottom:-1px;height:1px;
  background:linear-gradient(90deg,transparent 5%,var(--accent) 50%,transparent 95%);
  opacity:.35;animation:lineGlow 4s infinite alternate;
}
@keyframes lineGlow{0%{opacity:.18}100%{opacity:.55}}

/* --- Brand zone --- */
.brand-block{display:flex;align-items:center;gap:14px;min-width:0}
.brand-mark{
  width:38px;height:38px;border-radius:12px;flex-shrink:0;
  background:linear-gradient(135deg,rgba(56,189,248,.18),rgba(30,64,175,.04));
  border:1px solid var(--accent-glow);
  display:flex;align-items:center;justify-content:center;font-size:20px;
  box-shadow:0 0 16px rgba(56,189,248,.18),inset 0 0 0 1px rgba(255,255,255,.04);
}
.brand-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.brand-row{display:flex;align-items:center;gap:6px;min-width:0}
.brand-name{
  font-size:16px;font-weight:800;color:var(--text);letter-spacing:-.2px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px;
}
.brand-name.loading{color:var(--text-dim);font-weight:500;font-style:italic}
.brand-sub{
  font-size:10.5px;color:var(--text-dim);font-weight:500;
  text-transform:uppercase;letter-spacing:1.4px;
}
.brand-edit{
  background:transparent;border:1px solid var(--border);color:var(--text-dim);
  width:24px;height:24px;border-radius:7px;cursor:pointer;font-size:11px;
  display:inline-flex;align-items:center;justify-content:center;
  transition:all .2s;padding:0;flex-shrink:0;
}
.brand-edit:hover{color:var(--accent);border-color:var(--accent);box-shadow:0 0 10px var(--accent-glow)}

/* --- HUD strip --- */
.hud{
  display:flex;align-items:center;justify-content:center;gap:8px;
  font-family:'Inter','SF Pro Display',sans-serif;
}
.hud .stat{
  display:flex;align-items:center;gap:8px;
  padding:7px 13px;border-radius:10px;
  background:rgba(56,189,248,.04);
  border:1px solid rgba(56,189,248,.16);
  transition:border-color .2s,background .2s;
}
.hud .stat:hover{border-color:rgba(56,189,248,.32);background:rgba(56,189,248,.06)}
.hud .stat .icon{font-size:14px;opacity:.85;line-height:1}
.hud .stat .text{display:flex;flex-direction:column;line-height:1.1}
.hud .stat .lbl{
  color:var(--text-dim);font-size:8.5px;letter-spacing:1.4px;
  text-transform:uppercase;opacity:.7;font-weight:600;
}
.hud .stat .val{
  color:var(--accent);font-weight:800;font-size:14px;
  font-variant-numeric:tabular-nums;
  text-shadow:0 0 10px var(--accent-glow);letter-spacing:-.3px;
}
.hud .stat.live{position:relative}
.hud .stat.live::before{
  content:'';position:absolute;top:6px;right:6px;
  width:6px;height:6px;border-radius:50%;background:#ef4444;
  box-shadow:0 0 6px #ef4444,0 0 12px rgba(239,68,68,.5);
  animation:liveBlink 1.4s infinite;
}
@keyframes liveBlink{0%,49%{opacity:1}50%,100%{opacity:.3}}
.hud .stat.warn{border-color:rgba(255,171,64,.3)}
.hud .stat.warn .val{color:#ffab40;text-shadow:0 0 6px rgba(255,171,64,.4)}
@media (max-width:900px){
  .hud .stat:nth-child(n+3){display:none}
}

/* --- Action buttons --- */
.actions{display:flex;align-items:center;gap:8px}
.topbtn{
  font-family:inherit;font-size:12px;font-weight:600;
  padding:9px 14px;border-radius:10px;cursor:pointer;
  background:rgba(255,255,255,.03);
  border:1px solid var(--border);color:var(--text);
  transition:all .2s cubic-bezier(.16,1,.3,1);
  display:inline-flex;align-items:center;gap:6px;
  letter-spacing:-.1px;
}
.topbtn:hover{
  background:rgba(255,255,255,.06);border-color:rgba(56,189,248,.3);
  color:var(--accent);transform:translateY(-1px);
  box-shadow:0 4px 14px rgba(0,0,0,.4);
}
.topbtn.primary{
  background:linear-gradient(135deg,#7dd3fc 0%,#38BDF8 50%,#1E40AF 100%);
  color:#001a0d;border-color:transparent;font-weight:700;
  box-shadow:0 4px 16px rgba(56,189,248,.3),inset 0 1px 0 rgba(255,255,255,.3);
}
.topbtn.primary:hover{
  filter:brightness(1.08);transform:translateY(-2px);
  box-shadow:0 8px 28px rgba(56,189,248,.45),inset 0 1px 0 rgba(255,255,255,.3);
}
.topbtn.ghost{background:transparent;color:var(--text-dim)}
.topbtn.ghost:hover{background:rgba(255,255,255,.04);color:var(--text)}

/* 24h workday toggle — distinct on/off pill with live dot. */
#workdayBtn{display:inline-flex;align-items:center;gap:8px;font-weight:700;font-size:11.5px}
#workdayBtn::before{
  content:'';width:7px;height:7px;border-radius:50%;
  background:var(--text-dim);transition:all .3s;flex-shrink:0;
}
#workdayBtn.on{
  background:linear-gradient(135deg,rgba(56,189,248,.20),rgba(56,189,248,.06));
  border-color:var(--accent);color:var(--accent);
  text-shadow:0 0 8px var(--accent-glow);
  box-shadow:0 0 16px rgba(56,189,248,.20),inset 0 0 0 1px rgba(56,189,248,.20);
}
#workdayBtn.on::before{
  background:var(--accent);
  box-shadow:0 0 8px var(--accent),0 0 14px var(--accent-glow);
  animation:workdayLiveDot 1.4s ease-in-out infinite;
}
#workdayBtn.off{
  background:rgba(0,0,0,.3);border-color:var(--border);
  color:var(--text-dim);opacity:.65;
}
@keyframes workdayLiveDot{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.5);opacity:.5}}

/* Legacy mini button — kept for backward compat but no longer used in topbar. */
.topbtn-mini{background:transparent;border:1px solid var(--border);color:var(--text-dim);width:22px;height:22px;border-radius:6px;cursor:pointer;font-size:11px;display:inline-flex;align-items:center;justify-content:center;margin-left:4px;transition:all .25s;padding:0}
.topbtn-mini:hover{color:var(--accent);border-color:var(--accent);box-shadow:0 0 8px var(--accent-glow)}

/* Subtle status row beneath topbar — shows live agent activity summary. */
.status-row{
  display:flex;align-items:center;gap:14px;
  padding:6px 22px;font-size:10.5px;color:var(--text-dim);
  background:rgba(0,0,0,.2);border-bottom:1px solid var(--border);
  font-family:'Inter',sans-serif;letter-spacing:.2px;
}
.status-row .pulse-dot{
  width:6px;height:6px;border-radius:50%;background:var(--accent);
  box-shadow:0 0 6px var(--accent);
  animation:liveBlink 1.6s ease-in-out infinite;
}
.status-row .sep{opacity:.3}
.status-row .text{color:var(--text)}

/* ===== Office Floor — unified office (single Office_Design_2.gif bg) =====
   Legacy TV-studio dual-layer rules (bg-stack, office-fg, office-anims) and
   the conflicting office-bg transform translate(-50%, -50%) shorthand have
   been removed — they were pulling the bg image off-screen by half its own
   size. */
.office-wrap{flex:1;display:flex;min-height:0}
.office-floor{flex:1;position:relative;overflow:hidden;border-right:1px solid var(--border);background:#070A0F}

/* === Unified office stage — ONE pre-built office bg fills the floor area ===
   stageInner has a fixed aspect-ratio matching the bg image (512×544).
   Agents are children of stageInner and use % coords that map directly to
   the bg image, so a character at (78,80)% lands inside the CEO office
   regardless of panel size. */
.office-stage{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;z-index:0;background:#070A0F}
/* stageInner sized inline by fitStage() to maintain world aspect ratio (1400/700). */
.office-stage-inner{position:relative;--char-scale:1.5;overflow:hidden;border-radius:6px;box-shadow:0 0 0 1px rgba(56,189,248,.18),0 8px 32px rgba(0,0,0,.6)}

/* Garden grass — tiled LimeZu grass texture (base layer of world canvas).
   Tile size set inline by JS based on world scale so pixels stay crisp. */
.world-grass{position:absolute;inset:0;background-repeat:repeat;image-rendering:pixelated;image-rendering:crisp-edges;pointer-events:none;z-index:0}
/* Stone walkway paths between buildings — same tiled texture pattern */
.world-paths{position:absolute;inset:0;pointer-events:none;z-index:1}
.world-paths .path-strip{position:absolute;background-repeat:repeat;image-rendering:pixelated;image-rendering:crisp-edges;box-shadow:inset 0 0 0 1px rgba(0,0,0,.15)}
/* Buildings layer — pre-built scene PNGs/GIFs at fixed world pixel positions */
.world-buildings{position:absolute;inset:0;pointer-events:none;z-index:2}
.world-buildings img{position:absolute;image-rendering:pixelated;image-rendering:crisp-edges;display:block}
/* Decorations layer — single garden tiles (trees, benches, flowers) */
.world-decorations{position:absolute;inset:0;pointer-events:none;z-index:3}
.world-decorations img{position:absolute;image-rendering:pixelated;image-rendering:crisp-edges;filter:drop-shadow(0 2px 3px rgba(0,0,0,.5));display:block;transform:translate(-50%,-100%)}
.office-bg{position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated;image-rendering:crisp-edges;pointer-events:none;display:block}
.office-zones{position:absolute;inset:0;pointer-events:none;z-index:2}
.office-zones .zone-label{position:absolute;font-family:'SF Mono',monospace;font-size:9px;letter-spacing:1px;color:var(--accent);text-transform:uppercase;text-shadow:0 0 8px rgba(56,189,248,.85),0 1px 2px rgba(0,0,0,.95);opacity:.8;transform:translate(-50%,-100%);white-space:nowrap;padding:2px 6px;border-radius:3px;background:rgba(0,8,4,.55);border:1px solid rgba(56,189,248,.25)}

/* Ambient decor — 빈 영역에 떠다니는 작은 이모지. opacity 살짝, 천천히 위아래 */
.ambient-decor{position:absolute;inset:0;pointer-events:none;z-index:3}
.adeco{position:absolute;font-size:14px;opacity:.55;filter:drop-shadow(0 2px 4px rgba(0,0,0,.4));animation:adecoFloat 6s ease-in-out infinite;transform:translate(-50%,-50%)}
@keyframes adecoFloat{0%,100%{transform:translate(-50%,-50%) translateY(0)}50%{transform:translate(-50%,-50%) translateY(-4px)}}
/* Hide legacy single-room overlay UI in unified-office mode. */
body.floorplan .conf-room,body.floorplan .location{display:none!important}
.office-vignette{position:absolute;inset:0;background:radial-gradient(ellipse at center,transparent 55%,rgba(0,0,0,.45) 100%);pointer-events:none;z-index:3}

/* Floating particles drifting up — feels alive */
.particles{position:absolute;inset:0;pointer-events:none;z-index:4;overflow:hidden}
.particles span{position:absolute;width:2px;height:2px;border-radius:50%;background:rgba(56,189,248,.45);box-shadow:0 0 4px rgba(56,189,248,.7);animation:floatUp 14s linear infinite;opacity:0}
@keyframes floatUp{0%{transform:translateY(0);opacity:0}10%{opacity:.8}90%{opacity:.6}100%{transform:translateY(-100vh);opacity:0}}

/* Conference room — glass-walled boardroom with holographic projection */
.conf-room{position:absolute;left:50%;top:3%;transform:translateX(-50%);width:42%;min-width:340px;max-width:560px;height:20%;min-height:130px;
  background:
    linear-gradient(180deg,rgba(56,189,248,.07),rgba(30,64,175,.02)),
    radial-gradient(ellipse at 50% 100%,rgba(56,189,248,.12),transparent 60%);
  border:1px solid rgba(56,189,248,.5);border-radius:14px;
  box-shadow:
    inset 0 0 40px rgba(56,189,248,.1),
    inset 0 0 0 1px rgba(0,0,0,.5),
    0 8px 28px rgba(56,189,248,.18),
    0 0 60px rgba(56,189,248,.08);
  z-index:4;
  backdrop-filter:blur(2px)}
/* corner brackets — futuristic frame */
.conf-room::before{content:'';position:absolute;top:0;left:0;width:18px;height:18px;border-top:2px solid var(--accent);border-left:2px solid var(--accent);border-radius:14px 0 0 0;opacity:.7}
.conf-room::after{content:'';position:absolute;top:0;right:0;width:18px;height:18px;border-top:2px solid var(--accent);border-right:2px solid var(--accent);border-radius:0 14px 0 0;opacity:.7}
.conf-label{position:absolute;top:6px;left:50%;transform:translateX(-50%);font-family:'SF Mono',monospace;font-size:8px;letter-spacing:4px;color:var(--accent);opacity:.85;text-shadow:0 0 8px var(--accent-glow);z-index:5}
.conf-label::before{content:'◆ ';opacity:.6}
.conf-label::after{content:' ◆';opacity:.6}

/* glass holographic projection — shows brief during commands */
.whiteboard{position:absolute;top:20px;left:50%;transform:translateX(-50%);width:82%;max-width:420px;height:54px;
  background:linear-gradient(180deg,rgba(0,30,15,.92),rgba(0,15,8,.95));
  border:1px solid rgba(56,189,248,.3);border-radius:6px;
  display:flex;align-items:center;justify-content:center;
  font-family:'SF Mono',monospace;font-size:10.5px;color:var(--text-dim);text-align:center;padding:8px;line-height:1.4;overflow:hidden;
  box-shadow:inset 0 0 14px rgba(56,189,248,.06),0 0 0 1px rgba(0,0,0,.5)}
.whiteboard::before{content:'';position:absolute;inset:0;background:repeating-linear-gradient(0deg,transparent 0 2px,rgba(56,189,248,.05) 2px 3px);pointer-events:none}
.whiteboard.active{border-color:var(--accent);background:linear-gradient(180deg,rgba(0,40,20,.95),rgba(0,20,10,.98));color:var(--text);box-shadow:inset 0 0 22px rgba(56,189,248,.18),0 0 24px var(--accent-glow);animation:wbPulse 2.4s ease-in-out infinite}
@keyframes wbPulse{0%,100%{box-shadow:inset 0 0 22px rgba(56,189,248,.18),0 0 24px var(--accent-glow)}50%{box-shadow:inset 0 0 28px rgba(56,189,248,.28),0 0 38px var(--accent-glow)}}
.whiteboard .wb-line{display:block;animation:wbType .4s ease-out backwards;position:relative;z-index:1}
@keyframes wbType{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:translateY(0)}}

/* conference table with holographic glow on top */
.conf-table{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);width:78%;height:26%;
  background:linear-gradient(180deg,#1a2028 0%,#0c1218 100%);
  border:1px solid rgba(56,189,248,.25);border-radius:50px;
  box-shadow:
    0 6px 14px rgba(0,0,0,.6),
    inset 0 1px 0 rgba(56,189,248,.15),
    inset 0 0 20px rgba(56,189,248,.06)}
.conf-table::before{content:'';position:absolute;left:8%;right:8%;top:30%;bottom:30%;background:radial-gradient(ellipse,rgba(56,189,248,.15),transparent 70%);border-radius:50%;animation:tablePulse 3s ease-in-out infinite}
@keyframes tablePulse{0%,100%{opacity:.5}50%{opacity:1}}

/* Workstations — proper desk with dual monitors, LED strip, PC tower */
.desk{position:absolute;width:108px;height:78px;transform:translate(-50%,-50%);z-index:3;pointer-events:none}
.desk .ds-top{position:absolute;left:0;right:0;top:24px;height:32px;
  background:linear-gradient(180deg,#1a2028 0%,#0c1218 100%);
  border:1px solid rgba(56,189,248,.2);border-radius:4px;
  box-shadow:0 4px 8px rgba(0,0,0,.65),inset 0 1px 0 rgba(255,255,255,.04)}
/* desk LED strip — glows in agent color */
.desk .ds-top::before{content:'';position:absolute;left:6px;right:6px;bottom:1px;height:1.5px;background:var(--ag-color,var(--accent));box-shadow:0 0 6px var(--ag-color,var(--accent));opacity:.8;border-radius:1px;animation:ledStripPulse 3s ease-in-out infinite}
@keyframes ledStripPulse{0%,100%{opacity:.5}50%{opacity:1}}
/* PC tower under desk */
.desk .ds-top::after{content:'';position:absolute;right:4px;bottom:-12px;width:9px;height:14px;background:linear-gradient(135deg,#1c2228,#0a0e14);border:1px solid rgba(255,255,255,.06);border-radius:1.5px;box-shadow:0 0 4px rgba(56,189,248,.2)}

/* Dual monitor frame */
.desk .ds-monitor{position:absolute;left:50%;top:0;transform:translateX(-50%);width:80px;height:30px;display:flex;gap:2px;justify-content:center}
.desk .ds-screen{flex:0 0 38px;height:26px;background:#000;border:1.2px solid #2a3038;border-radius:2px;
  box-shadow:0 0 10px rgba(56,189,248,.18),inset 0 0 0 1px rgba(0,0,0,.5);
  overflow:hidden;position:relative}
/* monitor stand */
.desk .ds-monitor::after{content:'';position:absolute;left:50%;bottom:-4px;transform:translateX(-50%);width:14px;height:4px;background:#1a1f26;border-radius:0 0 4px 4px;box-shadow:0 1px 2px rgba(0,0,0,.6)}
/* scanline overlay on each screen */
.desk .ds-screen::after{content:'';position:absolute;inset:0;background:repeating-linear-gradient(0deg,transparent 0 1px,rgba(0,0,0,.25) 1px 2px);pointer-events:none;z-index:3}
.desk .ds-screen::before{content:'';position:absolute;inset:0;z-index:1}

/* Per-agent screen content */
/* CEO: command graph with sweeping radar arm */
.desk[data-agent="ceo"] .ds-screen::before{background:radial-gradient(circle at 50% 50%,rgba(56,189,248,.4) 0%,rgba(56,189,248,0) 1px,rgba(56,189,248,.1) 2px,rgba(56,189,248,0) 3px,rgba(56,189,248,.1) 6px,rgba(56,189,248,0) 7px,rgba(56,189,248,.08) 12px,rgba(56,189,248,0) 13px),conic-gradient(from 0deg,rgba(56,189,248,.5),transparent 70%);animation:radarSweep 4s linear infinite}
@keyframes radarSweep{from{transform:rotate(0)}to{transform:rotate(360deg)}}

/* Developer: scrolling code lines */
.desk[data-agent="developer"] .ds-screen::before{background:repeating-linear-gradient(0deg,transparent 0 3px,rgba(34,211,238,.7) 3px 4px,transparent 4px 7px,rgba(34,211,238,.4) 7px 8px,transparent 8px 12px,rgba(34,211,238,.55) 12px 13px,transparent 13px 16px,rgba(34,211,238,.3) 16px 17px,transparent 17px 22px);background-size:100% 22px;animation:codeScroll 3s linear infinite}
@keyframes codeScroll{from{background-position:0 0}to{background-position:0 22px}}

/* Designer: rotating color swatches */
.desk[data-agent="designer"] .ds-screen::before{background:conic-gradient(from 0deg,#FF0033 0deg 60deg,#FBBF24 60deg 120deg,#22D3EE 120deg 180deg,#A78BFA 180deg 240deg,#22D3EE 240deg 300deg,#E1306C 300deg 360deg);filter:saturate(.85) brightness(.7);animation:colorSpin 8s linear infinite;border-radius:50%;margin:6px}
@keyframes colorSpin{from{transform:rotate(0)}to{transform:rotate(360deg)}}

/* YouTube: red bars rising/falling like audio meter */
.desk[data-agent="youtube"] .ds-screen::before{background:linear-gradient(90deg,
  rgba(255,0,51,.7) 0%,rgba(255,0,51,.7) 8%,transparent 8% 12%,
  rgba(255,0,51,.5) 12% 20%,transparent 20% 24%,
  rgba(255,0,51,.8) 24% 32%,transparent 32% 36%,
  rgba(255,0,51,.4) 36% 44%,transparent 44% 48%,
  rgba(255,0,51,.6) 48% 56%,transparent 56% 60%,
  rgba(255,0,51,.7) 60% 68%,transparent 68% 72%,
  rgba(255,0,51,.5) 72% 80%,transparent 80% 84%,
  rgba(255,0,51,.6) 84% 92%,transparent 92% 100%);background-size:100% 100%;animation:audioBars .6s ease-in-out infinite alternate;mask-image:linear-gradient(0deg,#000 0%,#000 100%)}
@keyframes audioBars{from{filter:hue-rotate(0deg)}to{filter:hue-rotate(20deg) brightness(1.2)}}

/* Instagram: pink heart pulse + grid */
.desk[data-agent="instagram"] .ds-screen::before{background:radial-gradient(circle at 50% 55%,rgba(225,48,108,.85) 0%,rgba(225,48,108,.5) 20%,transparent 35%),repeating-linear-gradient(0deg,rgba(247,119,55,.15) 0 4px,transparent 4px 8px),repeating-linear-gradient(90deg,rgba(247,119,55,.15) 0 4px,transparent 4px 8px);animation:igPulse 1.6s ease-in-out infinite}
@keyframes igPulse{0%,100%{transform:scale(.95);opacity:.7}50%{transform:scale(1.05);opacity:1}}

/* Business: bar chart growing */
.desk[data-agent="business"] .ds-screen::before{background:linear-gradient(0deg,rgba(251,191,36,.7) 0%,rgba(251,191,36,.7) 30%,transparent 30%) 0 100%/12% 100% no-repeat,linear-gradient(0deg,rgba(251,191,36,.7) 0%,rgba(251,191,36,.7) 50%,transparent 50%) 16% 100%/12% 100% no-repeat,linear-gradient(0deg,rgba(251,191,36,.7) 0%,rgba(251,191,36,.7) 70%,transparent 70%) 32% 100%/12% 100% no-repeat,linear-gradient(0deg,rgba(251,191,36,.7) 0%,rgba(251,191,36,.7) 45%,transparent 45%) 48% 100%/12% 100% no-repeat,linear-gradient(0deg,rgba(251,191,36,.7) 0%,rgba(251,191,36,.7) 85%,transparent 85%) 64% 100%/12% 100% no-repeat,linear-gradient(0deg,rgba(251,191,36,.7) 0%,rgba(251,191,36,.7) 60%,transparent 60%) 80% 100%/12% 100% no-repeat;animation:barsRise 2.4s ease-in-out infinite alternate}
@keyframes barsRise{from{filter:brightness(.7)}to{filter:brightness(1.2)}}

/* Secretary: scrolling event list */
.desk[data-agent="secretary"] .ds-screen::before{background:repeating-linear-gradient(0deg,rgba(34,211,238,.55) 0 2px,transparent 2px 4px,rgba(34,211,238,.3) 4px 5px,transparent 5px 8px);background-size:100% 16px;animation:listScroll 4s linear infinite}
@keyframes listScroll{from{background-position:0 0}to{background-position:0 16px}}

/* second screen — slightly dimmer secondary feed */
.desk .ds-screen.s2{opacity:.65}

.desk .ds-chair{position:absolute;left:50%;bottom:0;transform:translateX(-50%);width:30px;height:18px;
  background:linear-gradient(180deg,#1a2030,#0c1220);
  border:1px solid rgba(56,189,248,.18);border-radius:5px 5px 9px 9px;
  box-shadow:0 2px 4px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.04)}
.desk[data-side="bottom"] .ds-chair{top:0;bottom:auto;border-radius:9px 9px 5px 5px}
.desk[data-side="bottom"] .ds-monitor{top:auto;bottom:0}
.desk[data-side="bottom"] .ds-top{top:auto;bottom:24px}

.desk-label{position:absolute;left:50%;bottom:-12px;transform:translateX(-50%);font-family:'SF Mono',monospace;font-size:7px;letter-spacing:1.5px;color:var(--ag-color,var(--text-dim));opacity:.6;white-space:nowrap;text-transform:uppercase;text-shadow:0 0 4px var(--ag-color-glow,transparent)}
.desk[data-side="bottom"] .desk-label{bottom:auto;top:-12px}

/* Decor — emoji icons with subtle float */
.decor{position:absolute;pointer-events:none;z-index:3;font-size:24px;filter:drop-shadow(0 3px 5px rgba(0,0,0,.7));animation:decorFloat 5s ease-in-out infinite}
.decor:nth-of-type(odd){animation-delay:-2s}
@keyframes decorFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}

/* ===== Locations — Smallville routine destinations (JS positions to bg-image %) ===== */
.location{position:absolute;transform:translate(-50%,-50%);z-index:5;pointer-events:none;display:flex;flex-direction:column;align-items:center;gap:2px;background:rgba(0,0,0,.65);border:1px solid rgba(56,189,248,.4);border-radius:8px;padding:4px 8px;backdrop-filter:blur(2px)}
.location .loc-icon{font-size:18px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.8))}
.location .loc-label{font-family:'SF Mono',monospace;font-size:7px;letter-spacing:1.5px;color:var(--accent);opacity:.85;white-space:nowrap;text-transform:uppercase;text-shadow:0 0 4px var(--accent-glow)}
.location.active{animation:locPulse 1.5s ease-in-out infinite;border-color:var(--accent);box-shadow:0 0 14px var(--accent-glow)}
@keyframes locPulse{0%,100%{box-shadow:0 0 14px var(--accent-glow)}50%{box-shadow:0 0 22px var(--accent-glow)}}
.loc-brain{border-color:rgba(167,139,250,.6)}
.loc-brain .loc-label{color:#A78BFA;text-shadow:0 0 4px rgba(167,139,250,.5)}
.loc-brain.active{border-color:#A78BFA;box-shadow:0 0 16px rgba(167,139,250,.6)}

/* ===== Status icon above each agent (mood/state) ===== */
.ag-status{position:absolute;top:-22px;left:50%;transform:translateX(-50%);font-size:11px;background:rgba(8,10,15,.92);border:1px solid var(--ag-color,var(--accent));border-radius:50%;width:18px;height:18px;display:flex;align-items:center;justify-content:center;line-height:1;z-index:8;box-shadow:0 0 6px var(--ag-color-glow,var(--accent-glow));transition:all .3s;animation:statusPop .35s cubic-bezier(.16,1,.3,1)}
@keyframes statusPop{from{transform:translateX(-50%) scale(0)}to{transform:translateX(-50%) scale(1)}}
.ag-status.fade{opacity:0;transform:translateX(-50%) scale(.8)}

/* Thought bubble (small dotted bubble for inner monologue) */
.thought{position:absolute;left:50%;bottom:calc(100% + 22px);transform:translateX(-50%);background:rgba(8,10,15,.94);border:1px dashed var(--ag-color,var(--accent));border-radius:14px;padding:5px 11px;font-size:9.5px;font-style:italic;color:var(--text-dim);white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis;font-family:'SF Mono',monospace;z-index:19;box-shadow:0 4px 12px rgba(0,0,0,.6);animation:thoughtIn .4s cubic-bezier(.16,1,.3,1)}
.thought::after{content:'';position:absolute;left:50%;top:100%;transform:translateX(-50%);width:5px;height:5px;border-radius:50%;background:rgba(8,10,15,.94);border:1px dashed var(--ag-color,var(--accent));margin-top:2px}
.thought::before{content:'';position:absolute;left:calc(50% - 9px);top:calc(100% + 7px);width:3px;height:3px;border-radius:50%;background:rgba(8,10,15,.94);border:1px dashed var(--ag-color,var(--accent))}
@keyframes thoughtIn{from{opacity:0;transform:translateX(-50%) translateY(4px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}

/* ===== Agent profile modal — centered overlay with backdrop, on top of everything ===== */
/* ===== Agent profile modal (v2.84 polish) =====
   Reframed as an "employee card" — bigger avatar, clear identity strip,
   gentler stats grid, breathing room. Inter font matches topbar/dashboard. */
.agent-modal-backdrop{
  position:fixed;inset:0;
  background:rgba(0,5,10,.72);
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  z-index:200;display:flex;align-items:center;justify-content:center;
  animation:amdBdIn .25s cubic-bezier(.16,1,.3,1);
  padding:24px;
}
.agent-modal-backdrop[hidden]{display:none}
@keyframes amdBdIn{from{opacity:0}to{opacity:1}}
.agent-modal{
  position:relative;width:min(480px,94vw);max-height:88vh;
  background:linear-gradient(180deg,rgba(20,16,10,.97),rgba(12,9,5,.98));
  border:1px solid var(--border);border-radius:18px;padding:24px;
  display:flex;flex-direction:column;gap:18px;
  box-shadow:0 24px 72px rgba(0,0,0,.85),0 0 60px rgba(56,189,248,.18),inset 0 1px 0 rgba(255,255,255,.04);
  overflow-y:auto;
  animation:amdIn .4s cubic-bezier(.16,1,.3,1);
  font-family:'Inter','SF Pro Display',sans-serif;
}
/* Subtle accent line on top — same brand cue as dashboard cards. */
.agent-modal::before{
  content:'';position:absolute;left:24px;right:24px;top:0;height:1px;
  background:linear-gradient(90deg,transparent,var(--accent) 50%,transparent);
  opacity:.55;
}
@keyframes amdIn{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}
.agent-modal::-webkit-scrollbar{width:5px}
.agent-modal::-webkit-scrollbar-thumb{background:var(--accent);opacity:.4;border-radius:2px}
.amd-head{
  display:flex;align-items:center;gap:14px;
  padding-bottom:18px;border-bottom:1px solid var(--border);
}
.amd-emoji{
  font-size:30px;width:54px;height:54px;flex-shrink:0;
  display:flex;align-items:center;justify-content:center;
  background:linear-gradient(135deg,rgba(255,182,39,.14),rgba(255,182,39,.03));
  border:1px solid var(--accent-glow);border-radius:14px;
  box-shadow:0 0 18px rgba(56,189,248,.18),inset 0 0 0 1px rgba(255,255,255,.04);
  overflow:hidden;
}
/* When a custom portrait is loaded (프로필 이미지 제공 에이전트), drop the gradient and let
   the image cover the avatar tile completely. Adds a subtle inner ring so
   the photo blends with the brand's amber border. */
.amd-emoji.has-photo{background:transparent;padding:0}
.amd-photo{width:100%;height:100%;object-fit:cover;display:block;border-radius:13px}
.amd-title{flex:1;min-width:0}
.amd-name{
  font-size:18px;font-weight:800;color:var(--text);
  letter-spacing:-.3px;line-height:1.2;
}
.amd-role{
  font-size:10.5px;color:var(--text-dim);
  letter-spacing:1.4px;text-transform:uppercase;margin-top:4px;
  font-weight:600;
}
.amd-close{
  background:transparent;border:1px solid var(--border);
  color:var(--text-dim);width:32px;height:32px;border-radius:9px;
  cursor:pointer;font-size:13px;line-height:1;transition:all .2s;
  display:inline-flex;align-items:center;justify-content:center;
}
.amd-close:hover{color:#ef4444;border-color:#ef4444;background:rgba(239,68,68,.08)}
.amd-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.amd-stat{
  background:rgba(255,255,255,.03);
  border:1px solid var(--border);border-radius:10px;padding:10px 8px;
  text-align:center;transition:border-color .15s;
}
.amd-stat:hover{border-color:var(--accent-glow)}
.amd-stat-lbl{
  font-size:9px;color:var(--text-dim);
  letter-spacing:1.4px;text-transform:uppercase;margin-bottom:4px;
  font-weight:600;
}
.amd-stat-val{
  font-size:15px;font-weight:800;color:var(--accent);
  text-shadow:0 0 8px var(--accent-glow);
  font-variant-numeric:tabular-nums;letter-spacing:-.2px;
}
.amd-section{display:flex;flex-direction:column;gap:7px;flex:1;min-height:80px}
.amd-section-head{
  font-size:10px;letter-spacing:1.5px;color:var(--text-dim);
  text-transform:uppercase;opacity:.85;font-weight:700;
  display:flex;align-items:center;gap:6px;
}
.amd-content{
  background:rgba(0,0,0,.22);
  border:1px solid var(--border);
  border-radius:10px;padding:12px 14px;
  font-size:12px;color:var(--text);
  font-family:'Inter',sans-serif;line-height:1.6;
  max-height:200px;overflow-y:auto;
  white-space:pre-wrap;word-break:break-word;margin:0;
}
.amd-content::-webkit-scrollbar{width:4px}
.amd-content::-webkit-scrollbar-thumb{background:var(--accent);opacity:.4;border-radius:2px}
.amd-sessions{display:flex;flex-direction:column;gap:3px;font-size:10px;font-family:'SF Mono',monospace;color:var(--text-dim)}
.amd-sessions .amd-sess{padding:3px 8px;background:rgba(56,189,248,.03);border:1px solid rgba(56,189,248,.1);border-radius:4px}
.amd-foot{padding-top:8px;border-top:1px solid rgba(56,189,248,.18);display:flex;gap:6px}
.amd-btn{flex:1;background:rgba(56,189,248,.06);border:1px solid rgba(56,189,248,.3);color:var(--accent);padding:7px 10px;border-radius:6px;cursor:pointer;font-size:10px;font-family:'SF Mono',monospace;letter-spacing:.5px;transition:all .2s}
.amd-btn:hover{background:rgba(56,189,248,.12);box-shadow:0 0 10px var(--accent-glow)}
.amd-btn.primary{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#000;border-color:transparent;font-weight:700}
.amd-btn.primary:hover{filter:brightness(1.15);box-shadow:0 4px 14px var(--accent-glow)}

/* Per-agent settings form fields */
.amd-form{display:flex;flex-direction:column;gap:8px}
.amd-field{display:flex;flex-direction:column;gap:3px}
.amd-field-lbl{font-family:'SF Mono',monospace;font-size:8.5px;letter-spacing:1.2px;color:var(--text-dim);text-transform:uppercase;opacity:.85}
.amd-field-help{font-size:9px;color:var(--text-dim);opacity:.6;margin-top:1px;font-style:italic}
.amd-input{background:rgba(56,189,248,.04);border:1px solid rgba(56,189,248,.18);border-radius:5px;padding:7px 9px;font-size:11px;color:var(--text);font-family:'SF Mono',monospace;outline:none;transition:all .2s}
.amd-input:focus{border-color:var(--accent);box-shadow:0 0 8px var(--accent-glow);background:rgba(56,189,248,.08)}
textarea.amd-input{resize:vertical;min-height:50px;line-height:1.45}
.amd-save-status{font-size:9.5px;font-family:'SF Mono',monospace;letter-spacing:.5px;text-align:center;padding:4px;border-radius:4px;opacity:0;transition:opacity .3s}
.amd-save-status.show{opacity:1}
.amd-save-status.success{color:var(--accent);background:rgba(56,189,248,.08)}
.amd-save-status.error{color:#ef4444;background:rgba(239,68,68,.08)}


/* Agent piece — inline-SVG character + nameplate. Furniture is CSS-drawn behind. */
.agent{position:absolute;width:60px;display:flex;flex-direction:column;align-items:center;gap:3px;transition:left .9s cubic-bezier(.16,1,.3,1),top .9s cubic-bezier(.16,1,.3,1);z-index:6;filter:drop-shadow(0 4px 6px rgba(0,0,0,.65));transform:scale(var(--char-scale,1));transform-origin:50% 96px}
.agent .ag-led{position:absolute;top:-4px;right:6px;width:5px;height:5px;border-radius:50%;background:var(--text-dim);opacity:.4;transition:all .3s;z-index:7}
.agent.thinking .ag-led{background:#ffab40;animation:ledBlink 1s infinite;box-shadow:0 0 6px #ffab40;opacity:1}
.agent.working .ag-led{background:var(--ag-color,var(--accent));animation:ledBlink .7s infinite;box-shadow:0 0 8px var(--ag-color,var(--accent));opacity:1}
.agent.done .ag-led{background:#00cc77;box-shadow:0 0 6px #00cc77;opacity:1}
@keyframes ledBlink{0%,100%{opacity:1}50%{opacity:.4}}

/* Sprite character — LimeZu Premade_Character_48x48 atlas (2688×1968).
   CRITICAL: each character cell is 48 wide × 96 tall (TILE × CHAR_HEIGHT, where CHAR_HEIGHT = TILE*2).
   Rendering this as 48×48 (the bug we hit before) shows only the head/hair.
   Idle frame: row 1, col 0 → background-position: 0 -96px
   Walking row: row 2 (y=-192), 6 frames per direction (down 0–5, left 6–11, right 12–17, up 18–23) */
.character{width:48px;height:96px;position:relative;overflow:hidden;image-rendering:pixelated;cursor:default;background-repeat:no-repeat;background-position:0 -96px;background-size:auto;filter:drop-shadow(0 6px 8px rgba(0,0,0,.65));animation:charBob 2.4s ease-in-out infinite;transform:scale(0.8);transform-origin:center bottom}
/* photo-sprite: 사진 기반 단일 픽셀 sprite. atlas 가 아니므로 background-position 시프트
   금지하고 한 장 그대로 contain 으로 보여줌. 비율 살리려면 width 도 자연히 채워야 함. */
.character.photo-sprite{width:64px;height:96px;background-position:center center !important;background-size:contain !important;overflow:visible}
@keyframes charBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-1px)}}

/* State glow under character */
.character::before{content:'';position:absolute;left:50%;bottom:-4px;transform:translateX(-50%);width:36px;height:6px;border-radius:50%;background:radial-gradient(ellipse,var(--ag-color-glow,rgba(0,0,0,.4)) 0%,transparent 70%);opacity:0;transition:opacity .3s;pointer-events:none;z-index:-1}
.agent.working .character::before,.agent.thinking .character::before{opacity:1}

/* v2.89.157 — 게임처럼 살아있는 "작업 중" 시각화. 작업 시 캐릭터 주변 펄싱 링·강한 바운스·바닥 그림자 확장. */
.agent.working .character,.agent.thinking .character{animation:charBob 0.9s ease-in-out infinite,charBuzz 3.2s ease-in-out infinite}
@keyframes charBuzz{0%,90%,100%{filter:drop-shadow(0 6px 8px rgba(0,0,0,.65)) drop-shadow(0 0 0 transparent)}45%{filter:drop-shadow(0 6px 8px rgba(0,0,0,.65)) drop-shadow(0 0 6px var(--ag-color-glow,rgba(255,255,255,.6)))}}
/* 펄싱 후광 링 — 작업 중인 에이전트 주변 컬러 링이 부풀었다 줄어듦 */
.agent.working::after,.agent.thinking::after{content:'';position:absolute;left:50%;top:62px;transform:translate(-50%,-50%);width:62px;height:62px;border-radius:50%;border:2px solid var(--ag-color,var(--accent));opacity:0;animation:agentRing 1.6s ease-out infinite;pointer-events:none;z-index:-1}
@keyframes agentRing{0%{transform:translate(-50%,-50%) scale(.6);opacity:.7;border-width:2px}100%{transform:translate(-50%,-50%) scale(1.5);opacity:0;border-width:0.5px}}
.agent.thinking::after{animation-duration:2.2s;border-color:#ffab40}
/* 작업 중 LED 양옆에 깜빡이는 두 번째 LED — "신호 보내는 중" 느낌 */
.agent.working .ag-led::after,.agent.thinking .ag-led::after{content:'';position:absolute;top:-2px;right:-9px;width:3px;height:3px;border-radius:50%;background:var(--ag-color,var(--accent));animation:ledBlink .55s infinite reverse;box-shadow:0 0 5px var(--ag-color-glow,var(--accent-glow))}

/* 게임식 sparkle 입자 — JS 가 agentBusy 마다 .spark 노드 spawn */
.spark{position:absolute;width:6px;height:6px;border-radius:50%;background:var(--spark-c,var(--accent));box-shadow:0 0 8px var(--spark-c,var(--accent-glow)),0 0 14px var(--spark-c,var(--accent-glow));pointer-events:none;z-index:10;animation:sparkFly 1.4s ease-out forwards}
@keyframes sparkFly{0%{opacity:1;transform:translate(0,0) scale(1)}80%{opacity:.8}100%{opacity:0;transform:translate(var(--sx,0),var(--sy,-46px)) scale(.2)}}

/* 작업 진행 막대 — 캐릭터 머리 위 작은 progress bar. 길이가 점점 차오름 (CSS 만으로) */
.work-bar{position:absolute;left:50%;top:-12px;transform:translateX(-50%);width:48px;height:4px;background:rgba(0,0,0,.6);border:1px solid var(--ag-color,var(--accent));border-radius:3px;overflow:hidden;opacity:0;transition:opacity .25s;z-index:9}
.agent.working .work-bar,.agent.thinking .work-bar{opacity:1}
.work-bar-fill{height:100%;width:0;background:linear-gradient(90deg,var(--ag-color,var(--accent)),var(--ag-color-glow,#fff));box-shadow:0 0 8px var(--ag-color-glow,var(--accent-glow));animation:workBarFill 18s linear infinite}
@keyframes workBarFill{0%{width:0}90%{width:96%}100%{width:100%}}

.ag-plate{font-family:'SF Mono','JetBrains Mono',monospace;font-size:8.5px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--text-bright);padding:2px 7px;background:rgba(0,0,0,.85);border:1px solid var(--ag-color,var(--border));border-radius:5px;text-shadow:0 0 4px var(--ag-color-glow,transparent);white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.5)}
.agent.idle .ag-plate{opacity:.7}
.agent.working .ag-plate{color:var(--ag-color,var(--accent));box-shadow:0 0 10px var(--ag-color-glow,var(--accent-glow)),0 2px 6px rgba(0,0,0,.5)}

/* Speech bubble above character (task toast / chat) */
.bubble{position:absolute;left:50%;bottom:calc(100% + 8px);transform:translateX(-50%);background:rgba(8,10,15,.96);border:1px solid var(--ag-color,var(--accent));border-radius:8px;padding:5px 10px;font-size:10px;color:var(--text-bright);white-space:nowrap;max-width:200px;overflow:hidden;text-overflow:ellipsis;font-family:'SF Mono',monospace;z-index:20;box-shadow:0 4px 14px rgba(0,0,0,.7),0 0 14px var(--ag-color-glow,var(--accent-glow));animation:bubbleIn .35s cubic-bezier(.16,1,.3,1)}
.bubble::after{content:'';position:absolute;left:50%;top:100%;transform:translateX(-50%);border:5px solid transparent;border-top-color:var(--ag-color,var(--accent))}
@keyframes bubbleIn{from{opacity:0;transform:translateX(-50%) translateY(4px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}

/* SVG dispatch beams */
.beams{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5;opacity:0;transition:opacity .3s}
body.dispatching .beams{opacity:1}
.beams .beam{stroke-dasharray:6 8;fill:none;animation:beamFlow 1.4s linear}
@keyframes beamFlow{0%{stroke-dashoffset:80;opacity:0}20%{opacity:1}100%{stroke-dashoffset:0;opacity:.7}}

/* ===== Side panel (activity log + report) — collapsed by default to maximize map ===== */
/* ===== Side panel (v2.84 polish) =====
   Activity / Outputs / Transcript — modernized to match the topbar's
   Inter-based language. Tabs are larger and clearer; panes have proper
   padding + cleaner empty states. */
.side{
  width:300px;flex-shrink:0;
  background:linear-gradient(180deg,rgba(14,11,7,.92),rgba(8,7,4,.85));
  border-left:1px solid var(--border);
  display:flex;flex-direction:column;min-height:0;
  font-family:'Inter','SF Pro Display',sans-serif;
  backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
}
/* width transition 은 collapse 토글 때만 켠다. drag 중엔 따라가지 못해서 끊긴다. */
.side.animated{transition:width .3s cubic-bezier(.16,1,.3,1),border-left-width .3s ease}
.side.collapsed{width:0;border-left-width:0;overflow:hidden}
/* Drag-resize handle — office floor 와 side 패널 사이 세로 막대.
   collapse 시 side 와 같이 사라진다. */
.side-resizer{
  width:6px;flex-shrink:0;cursor:col-resize;
  background:rgba(255,255,255,.02);
  border-left:1px solid var(--border);border-right:1px solid var(--border);
  position:relative;z-index:5;user-select:none;
  transition:background .15s,box-shadow .15s;
}
.side-resizer:hover,.side-resizer.dragging{
  background:var(--accent-glow);
  box-shadow:0 0 12px var(--accent-glow),inset 0 0 4px var(--accent-glow);
}
.side-resizer::before{
  content:'⋮';position:absolute;left:50%;top:50%;
  transform:translate(-50%,-50%);color:var(--text-dim);
  font-size:14px;font-weight:900;pointer-events:none;
  text-shadow:0 0 6px rgba(0,0,0,.6);line-height:1;
}
.side-resizer:hover::before,.side-resizer.dragging::before{color:var(--accent)}
.side-resizer.hidden{display:none}

/* === Custom tooltip (1s delay) ===
   브라우저 기본 title tooltip 은 2-3초 후에 떠서 발견이 늦다. 1초 후
   네온 톤으로 띄우고, 줄바꿈도 지원. data-tip 속성을 읽는다. */
.custom-tooltip{
  position:fixed;z-index:9999;pointer-events:none;
  background:linear-gradient(180deg,rgba(8,12,20,.98),rgba(4,8,14,.98));
  color:var(--text-bright,#fff);font-size:11.5px;line-height:1.5;
  font-family:'Inter','SF Pro Display',-apple-system,system-ui,sans-serif;
  padding:8px 12px;border-radius:8px;max-width:320px;
  border:1px solid var(--accent-glow);
  box-shadow:0 8px 28px rgba(0,0,0,.55),0 0 16px var(--accent-glow),inset 0 1px 0 rgba(255,255,255,.04);
  white-space:pre-wrap;word-break:keep-all;
  opacity:0;transform:translateY(-4px);
  transition:opacity .15s ease,transform .15s ease;
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
}
.custom-tooltip.show{opacity:1;transform:translateY(0)}
.custom-tooltip::before{
  content:'';position:absolute;width:8px;height:8px;
  background:inherit;border-left:1px solid var(--accent-glow);
  border-top:1px solid var(--accent-glow);
  transform:rotate(45deg);
}
.custom-tooltip.below::before{top:-5px;left:14px}
.custom-tooltip.above::before{bottom:-5px;left:14px;border-left:none;border-top:none;
  border-right:1px solid var(--accent-glow);border-bottom:1px solid var(--accent-glow)}
.side-tabs{
  display:flex;border-bottom:1px solid var(--border);flex-shrink:0;
  background:rgba(0,0,0,.25);
}
.side-tab{
  flex:1;padding:11px 10px;background:transparent;border:none;
  color:var(--text-dim);cursor:pointer;
  font-family:inherit;font-size:11px;font-weight:600;letter-spacing:.3px;
  border-bottom:2px solid transparent;transition:all .2s;
  display:inline-flex;align-items:center;justify-content:center;gap:6px;
}
.side-tab:hover{color:var(--text);background:rgba(255,255,255,.02)}
.side-tab.active{
  color:var(--accent);border-bottom-color:var(--accent);
  background:linear-gradient(180deg,rgba(56,189,248,.06),transparent);
  text-shadow:0 0 8px var(--accent-glow);
}
.side-tab .tab-count{
  font-size:9.5px;font-weight:700;padding:1px 7px;border-radius:999px;
  background:rgba(255,182,39,.12);color:var(--accent);
  border:1px solid var(--accent-glow);min-width:18px;line-height:1.4;
}
.side-tab.active .tab-count{background:var(--accent);color:#1a0f00}
.side-pane{flex:1;overflow-y:auto;padding:14px 12px;display:none}
/* Markdown 요소 — 대화록·산출물 탭 안에서 읽기 좋게. side-pane 다크 톤에 맞춤. */
.md-h1{font-size:14px;font-weight:700;color:var(--accent);margin:14px 0 6px;letter-spacing:-.2px}
.md-h2{font-size:13px;font-weight:700;color:var(--text-bright,#f1f5f9);margin:12px 0 5px;padding-bottom:3px;border-bottom:1px solid rgba(56,189,248,.2)}
.md-h3{font-size:12px;font-weight:700;color:var(--accent);margin:10px 0 4px;display:inline-block}
.md-quote{border-left:2px solid var(--accent);padding:3px 10px;margin:3px 0 3px 8px;color:var(--text,#cbd5e1);background:rgba(56,189,248,.04);border-radius:0 4px 4px 0;font-size:11.5px;line-height:1.55}
.md-quote strong{color:var(--text-bright,#f1f5f9)}
.md-pre{background:rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.08);border-radius:6px;padding:8px 10px;overflow-x:auto;margin:6px 0;font-family:'SF Mono','JetBrains Mono',monospace;font-size:11px;line-height:1.5}
.md-pre code{color:#a5f3fc}
.md-code{background:rgba(0,0,0,.45);color:#a5f3fc;padding:1px 5px;border-radius:3px;font-family:'SF Mono','JetBrains Mono',monospace;font-size:11px;border:1px solid rgba(255,255,255,.08)}
.md-hr{border:none;height:1px;background:linear-gradient(90deg,transparent,rgba(56,189,248,.4),transparent);margin:10px 0}
.md-ul,.md-ol{padding-left:18px;margin:4px 0}
.md-ul li,.md-ol li{margin:2px 0;font-size:11.5px;line-height:1.6}
.md-gap{height:6px}
#convBody strong{color:var(--text-bright,#f1f5f9);font-weight:700}
#convBody em{color:var(--text,#cbd5e1);font-style:italic}
.side-pane.active{display:block}
.side-pane::-webkit-scrollbar{width:5px}
.side-pane::-webkit-scrollbar-thumb{background:rgba(56,189,248,.35);border-radius:3px}
.side-pane::-webkit-scrollbar-track{background:transparent}
.side-empty{
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  padding:48px 20px;text-align:center;color:var(--text-dim);
  border:1px dashed rgba(255,255,255,.06);border-radius:12px;
  font-size:12px;line-height:1.55;
  background:rgba(255,255,255,.015);
}
.side-empty .ic{font-size:32px;margin-bottom:10px;opacity:.55}
.side-empty .hint{font-size:10.5px;opacity:.7;margin-top:4px}

/* Activity log entries — clean rows with timestamp + agent dot + text */
.log-entry{
  display:grid;grid-template-columns:auto auto 1fr;gap:8px;align-items:flex-start;
  padding:8px 10px;margin-bottom:6px;
  background:rgba(255,255,255,.025);
  border:1px solid rgba(255,255,255,.04);
  border-left:2px solid var(--ag-color,var(--accent));
  border-radius:8px;
  animation:logIn .3s cubic-bezier(.16,1,.3,1);
  transition:border-color .15s,background .15s;
}
.log-entry:hover{background:rgba(255,255,255,.04);border-left-color:var(--ag-color,var(--accent))}
@keyframes logIn{from{opacity:0;transform:translateX(-6px)}to{opacity:1;transform:translateX(0)}}
.log-time{
  font-family:'SF Mono','JetBrains Mono',monospace;
  font-size:9.5px;color:var(--text-dim);flex-shrink:0;line-height:1.5;
  font-variant-numeric:tabular-nums;letter-spacing:.4px;
}
.log-emoji{flex-shrink:0;font-size:13px;line-height:1.3}
.log-text{
  color:var(--text);font-size:11px;line-height:1.5;
  word-break:break-word;
}
.log-text strong{color:var(--ag-color,var(--accent));font-weight:700}

/* Output stream cards (per agent) — feels like an employee handing in work */
.out-card{
  background:linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.015));
  border:1px solid rgba(255,255,255,.07);
  border-left:3px solid var(--ag-color,var(--accent));
  border-radius:10px;padding:12px 14px;margin-bottom:12px;
  animation:logIn .35s cubic-bezier(.16,1,.3,1);
  position:relative;overflow:hidden;
}
.out-card::before{
  content:'';position:absolute;left:0;right:0;top:0;height:1px;
  background:linear-gradient(90deg,transparent,var(--ag-color,var(--accent)),transparent);
  opacity:.35;
}
.out-head{
  font-size:11.5px;font-weight:700;
  color:var(--ag-color,var(--accent));margin-bottom:8px;
  display:flex;align-items:center;gap:8px;
  text-shadow:0 0 6px var(--ag-color-glow,var(--accent-glow));
}
.out-head .oh-task{color:var(--text-dim);font-weight:500;font-size:10px;letter-spacing:.2px}
.out-body{
  font-size:11.5px;color:var(--text);line-height:1.6;
  white-space:pre-wrap;word-break:break-word;
  max-height:220px;overflow-y:auto;
  font-family:'Inter',sans-serif;
}
.out-body::-webkit-scrollbar{width:4px}
.out-body::-webkit-scrollbar-thumb{background:var(--ag-color,var(--accent));opacity:.4;border-radius:2px}
.report-block{background:linear-gradient(135deg,rgba(56,189,248,.05),rgba(30,64,175,.02));border:1px solid rgba(56,189,248,.3);border-radius:8px;padding:14px;margin-top:10px;color:var(--text);font-size:11.5px;line-height:1.65;white-space:pre-wrap;animation:logIn .4s ease-out;box-shadow:0 0 14px rgba(56,189,248,.08)}
.report-block .rb-head{font-family:'SF Mono',monospace;font-size:10px;letter-spacing:1.5px;color:var(--accent);margin-bottom:8px;text-transform:uppercase}

/* ===== Bottom command bar ===== */
.cmdbar{display:flex;align-items:center;gap:8px;padding:10px 14px;background:rgba(8,10,15,.96);border-top:1px solid var(--border);flex-shrink:0;z-index:10}
.cmdbar input{flex:1;background:rgba(0,10,2,.7);border:1px solid var(--border);border-radius:8px;padding:10px 14px;color:var(--text);font-family:inherit;font-size:13px;outline:none;transition:all .2s}
.cmdbar input:focus{border-color:var(--accent);box-shadow:0 0 14px var(--accent-glow)}
.cmdbar button{background:linear-gradient(135deg,var(--accent),var(--accent2));border:none;color:#fff;padding:10px 18px;border-radius:8px;cursor:pointer;font-weight:600;font-size:12px;transition:all .2s}
.cmdbar button:hover{transform:translateY(-1px);box-shadow:0 4px 14px var(--accent-glow)}
.cmdbar button:disabled{opacity:.4;cursor:not-allowed;transform:none;box-shadow:none}

/* ===== Empty state ===== */
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-dim);font-size:12px;text-align:center;padding:40px 20px;line-height:1.7}
.empty .empty-icon{font-size:48px;margin-bottom:12px;opacity:.6}
.empty code{background:var(--surface);border:1px solid var(--border);padding:2px 6px;border-radius:4px;color:var(--accent);font-family:'SF Mono',monospace}

/* ============================================================
   v2.89.143 — Floating Revenue Command Center
   사무실 우상단 떠 있는 매트릭스 풍 HUD. 사무실 분위기 안 깨고 별도 레이어.
============================================================ */
.hud-revenue.clickable{cursor:pointer;transition:all .2s;position:relative}
.hud-revenue.clickable:hover{background:rgba(34,211,238,.08);transform:translateY(-1px)}
.hud-revenue .icon{color:#22d3ee;text-shadow:0 0 8px #22d3ee}
.hud-rev-pulse{position:absolute;top:6px;right:6px;width:5px;height:5px;border-radius:50%;background:#22d3ee;box-shadow:0 0 6px #22d3ee;animation:hudRevPulse 1.4s ease-in-out infinite}
@keyframes hudRevPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.3;transform:scale(.6)}}

.floating-revenue{
  position:fixed;top:88px;right:22px;width:300px;z-index:50;
  background:linear-gradient(160deg,rgba(11,17,48,.94),rgba(8,12,32,.86));
  border:1px solid rgba(103,232,249,.3);
  border-radius:16px;
  padding:14px 16px;
  box-shadow:0 16px 48px rgba(34,211,238,.18),0 4px 16px rgba(0,0,0,.6);
  backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  overflow:hidden;
  font-family:'SF Pro Display',-apple-system,sans-serif;
  transition:transform .3s cubic-bezier(.2,.8,.2,1),opacity .3s;
  animation:frSlideIn .5s cubic-bezier(.2,.8,.2,1);
}
@keyframes frSlideIn{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}
.floating-revenue.hidden{transform:translateX(360px);opacity:0;pointer-events:none}

.fr-glow{
  position:absolute;inset:-30px;
  background:radial-gradient(circle at 20% 0%,rgba(34,211,238,.25),transparent 60%),
             radial-gradient(circle at 100% 100%,rgba(167,139,250,.2),transparent 60%);
  pointer-events:none;
}
.floating-revenue::before{
  content:'';position:absolute;top:0;left:0;right:0;height:1px;
  background:linear-gradient(90deg,transparent,#22d3ee 30%,#a78bfa 70%,transparent);
  opacity:.8;
}

.fr-head{display:flex;align-items:center;gap:10px;margin-bottom:10px;position:relative;z-index:2}
.fr-icon{font-size:1.6rem;filter:drop-shadow(0 0 10px #22d3ee)}
.fr-title{flex:1;min-width:0}
.fr-eyebrow{
  font-size:.6rem;letter-spacing:.22em;text-transform:uppercase;
  color:#67e8f9;font-weight:800;
  text-shadow:0 0 8px rgba(34,211,238,.5);
  display:flex;align-items:center;gap:6px;
}
.fr-live{
  display:inline-flex;align-items:center;gap:4px;
  padding:1px 6px;background:rgba(34,211,238,.15);
  border:1px solid rgba(34,211,238,.35);border-radius:999px;
  color:#22d3ee;font-size:.55rem;letter-spacing:.1em;
}
.fr-pulse{
  width:5px;height:5px;border-radius:50%;background:#22d3ee;
  box-shadow:0 0 6px #22d3ee;animation:hudRevPulse 1.4s ease-in-out infinite;
}
.fr-name{
  font-size:1.05rem;font-weight:900;
  background:linear-gradient(135deg,#fff,#67e8f9);
  -webkit-background-clip:text;background-clip:text;color:transparent;
  letter-spacing:-.01em;line-height:1.2;margin-top:2px;
}
.fr-close{
  background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);
  color:#94a3b8;width:22px;height:22px;border-radius:50%;
  cursor:pointer;font-size:.7rem;display:flex;align-items:center;justify-content:center;
  flex-shrink:0;transition:all .15s;
}
.fr-close:hover{background:rgba(244,63,94,.2);border-color:rgba(244,63,94,.5);color:#fff}

.fr-body{position:relative;z-index:2;margin-bottom:10px}
.fr-kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:8px}
.fr-kpi{
  padding:8px 6px;background:rgba(255,255,255,.025);
  border:1px solid rgba(103,232,249,.1);border-radius:8px;text-align:center;
}
.fr-kpi-l{
  font-size:.58rem;letter-spacing:.12em;text-transform:uppercase;
  color:#64748b;font-weight:700;margin-bottom:2px;
}
.fr-kpi-v{
  font-size:1.05rem;font-weight:900;font-variant-numeric:tabular-nums;
  background:linear-gradient(135deg,#fff,#67e8f9);
  -webkit-background-clip:text;background-clip:text;color:transparent;
  line-height:1.1;letter-spacing:-.02em;
}
.fr-spark{width:100%;height:36px;margin:4px 0 6px}
.fr-spark .area{fill:url(#frSparkGrad)}
.fr-spark .line{stroke:#67e8f9;stroke-width:1.8;fill:none;filter:drop-shadow(0 0 4px #22d3ee)}
.fr-spark .peak{fill:#fbbf24;filter:drop-shadow(0 0 5px #fbbf24)}
.fr-sub{
  font-size:.68rem;color:#64748b;
  text-align:center;letter-spacing:.05em;
}

.fr-actions{display:flex;flex-direction:column;gap:6px;position:relative;z-index:2}
.fr-btn{
  position:relative;padding:8px 12px;border:none;border-radius:9px;
  font-size:.78rem;font-weight:800;cursor:pointer;
  display:flex;align-items:center;justify-content:center;gap:6px;
  transition:all .2s;font-family:inherit;
}
.fr-btn.primary{
  background:linear-gradient(135deg,#0891b2,#22d3ee);color:#fff;
  box-shadow:0 4px 14px rgba(34,211,238,.4),inset 0 1px 0 rgba(255,255,255,.2);
}
.fr-btn.primary:hover{transform:translateY(-1px);box-shadow:0 6px 22px rgba(34,211,238,.6)}
.fr-btn.primary:active{transform:translateY(0)}
.fr-btn-arrow{transition:transform .2s}
.fr-btn.primary:hover .fr-btn-arrow{transform:translateX(3px)}
.fr-btn.ghost{
  background:rgba(255,255,255,.04);border:1px solid rgba(167,139,250,.25);
  color:#c4b5fd;font-size:.72rem;padding:6px 10px;
}
.fr-btn.ghost:hover{background:rgba(167,139,250,.1);border-color:rgba(167,139,250,.5)}

/* Reopen pip — floating 닫혔을 때만 보임 */
.fr-reopen{
  position:fixed;top:88px;right:22px;width:44px;height:44px;
  border-radius:50%;border:1px solid rgba(103,232,249,.4);
  background:linear-gradient(135deg,rgba(8,145,178,.9),rgba(34,211,238,.9));
  color:#fff;font-size:1.2rem;cursor:pointer;z-index:50;
  display:none;align-items:center;justify-content:center;
  box-shadow:0 8px 24px rgba(34,211,238,.4);
  transition:all .2s;animation:frReopenPulse 2.5s ease-in-out infinite;
}
.fr-reopen.show{display:flex}
.fr-reopen:hover{transform:scale(1.1);box-shadow:0 10px 32px rgba(34,211,238,.6)}
@keyframes frReopenPulse{0%,100%{box-shadow:0 8px 24px rgba(34,211,238,.4)}50%{box-shadow:0 8px 36px rgba(34,211,238,.7)}}

@media (max-width:900px){
  .floating-revenue{width:260px;top:78px;right:12px}
  .fr-reopen{top:78px;right:12px}
}
</style>
</head>
<body>

<div class="topbar">
  <!-- Brand zone — logo + company name + tagline + folder edit -->
  <div class="brand-block">
    <div class="brand-mark">🏢</div>
    <div class="brand-text">
      <div class="brand-row">
        <div class="brand-name loading" id="topCompany">불러오는 중…</div>
        <button class="brand-edit" id="pickFolderBtn" title="회사 폴더 변경">⚙</button>
      </div>
      <div class="brand-sub">나만의 에이전트 팀</div>
    </div>
  </div>

  <!-- HUD — live company stats. Bigger than before, icon + text columns. -->
  <div class="hud">
    <div class="stat live">
      <div class="icon">📅</div>
      <div class="text"><div class="lbl">Day</div><div class="val" id="hudDay">1</div></div>
    </div>
    <div class="stat">
      <div class="icon">⏰</div>
      <div class="text"><div class="lbl">Time</div><div class="val" id="hudTime">09:00</div></div>
    </div>
    <div class="stat">
      <div class="icon">⚡</div>
      <div class="text"><div class="lbl">Output</div><div class="val" id="hudOutput">0</div></div>
    </div>
    <div class="stat" id="hudWorkingStat">
      <div class="icon">👥</div>
      <div class="text"><div class="lbl">Working</div><div class="val" id="hudWorking">0/7</div></div>
    </div>
  </div>

  <!-- Action zone — primary CTA prominent, secondary toggles ghost. -->
  <div class="actions">
    <button class="topbtn" id="workdayBtn" title="24시간 자동 운영 토글
ON 이면 에이전트들이 15분마다 미션을 향해 자동으로 한 스텝씩 실행합니다.
OFF 면 사용자가 명령할 때만 동작.">24h ⋯</button>
    <button class="topbtn primary" id="dashboardBtn" title="👥 에이전트 업무 대시보드
업무 보드(칸반)·각 에이전트 목표/메모리/도구/자가검증 기준·모델 매핑·매출 등 한 화면에서 관리.">👥 에이전트 업무 대시보드</button>
    <button class="topbtn ghost" id="revenueBtn" title="💰 매출 컨트롤 센터
이번 달 PayPal 매출, 14일 차트, 베조스 분석을 미니 카드로 우상단에 띄움.">💰</button>
    <button class="topbtn ghost" id="apiBtn" title="🔌 외부 연결 (API 키 관리)
Telegram, YouTube, Google Calendar, PayPal 등 외부 서비스 자격증명을 한 곳에서 등록·테스트.">🔌</button>
    <button class="topbtn ghost" id="toggleSideBtn" title="📋 오른쪽 사이드 패널 열기/닫기
활동 로그·산출물·오늘 대화록 3개 탭. 드래그로 너비 조절 가능.">📋</button>
    <button class="topbtn ghost" id="folderBtn" title="📁 회사 데이터 폴더를 Finder/탐색기에서 열기
에이전트 메모리(_agents/*/memory.md), 세션 산출물(sessions/*), 대화록(conversations/*) 등 원본 파일을 직접 확인·수정.">📁</button>
  </div>
</div>

<!-- Live status row — one-line summary of who's doing what right now. -->
<div class="status-row">
  <span class="pulse-dot"></span>
  <span class="text" id="statusText">사무실 가동 중</span>
  <span class="sep">·</span>
  <span id="statusActivity">에이전트 자리 잡는 중...</span>
</div>

<!-- v2.89.143 — Floating Revenue Command Center overlay. 사무실 화면 우상단
     에 떠 있는 매트릭스 풍 HUD. 미니 KPI + 14일 sparkline + 풀스크린 진입 버튼.
     사무실 분위기 안 깨고 별도 레이어로 매출 한눈에 확인. -->
<div class="floating-revenue hidden" id="floatingRevenue">
  <div class="fr-glow"></div>
  <div class="fr-head">
    <div class="fr-icon">💰</div>
    <div class="fr-title">
      <div class="fr-eyebrow">REVENUE · <span class="fr-live"><span class="fr-pulse"></span>LIVE</span></div>
      <div class="fr-name">매출 컨트롤 센터</div>
    </div>
    <button class="fr-close" id="frClose" title="숨기기">✕</button>
  </div>
  <div class="fr-body">
    <div class="fr-kpis">
      <div class="fr-kpi">
        <div class="fr-kpi-l">30일</div>
        <div class="fr-kpi-v" id="frMonth" data-last="0">—</div>
      </div>
      <div class="fr-kpi">
        <div class="fr-kpi-l">7일</div>
        <div class="fr-kpi-v" id="frWeek" data-last="0">—</div>
      </div>
      <div class="fr-kpi">
        <div class="fr-kpi-l">건수</div>
        <div class="fr-kpi-v" id="frCount" data-last="0">—</div>
      </div>
    </div>
    <svg class="fr-spark" id="frSparkSvg" viewBox="0 0 240 36" preserveAspectRatio="none"></svg>
    <div class="fr-sub" id="frSub">로딩 중…</div>
  </div>
  <div class="fr-actions">
    <button class="fr-btn primary" id="frOpenDashboard">
      📊 풀스크린 대시보드
      <span class="fr-btn-arrow">→</span>
    </button>
    <button class="fr-btn ghost" id="frAskBezos" title="제프베조스 에이전트 매출 분석">🧠 제프베조스 분석</button>
  </div>
</div>

<!-- 숨김 상태에서 다시 열 수 있는 작은 핍 (floating 닫혔을 때만 보임) -->
<!-- 플로팅 reopen 핍은 헤더 #revenueBtn 으로 대체됨. 호환을 위해 hidden 상태로 유지. -->
<button class="fr-reopen" id="frReopen" title="매출 컨트롤 센터 열기" style="display:none">💰</button>

<div class="office-wrap">
  <div class="office-floor" id="floor">

    <!-- Connected campus world (Phase B-1) — Office + Cafe buildings on a
         garden grass canvas. Single coord space (% of stageInner) so agents
         walk freely between zones. -->
    <div class="office-stage" id="officeStage">
      <div class="office-stage-inner" id="stageInner">
        <div class="world-grass" id="worldGrass"></div>
        <div class="world-paths" id="worldPaths"></div>
        <div class="world-buildings" id="worldBuildings"></div>
        <div class="world-decorations" id="worldDecor"></div>
        <div class="office-zones" id="officeZones"></div>
        <!-- Ambient decor — 빈 영역에 작은 floating emoji 5개. 디테일만 살짝. -->
        <div class="ambient-decor" aria-hidden="true">
          <span class="adeco" style="left:5%;top:10%;animation-delay:0s">🌿</span>
          <span class="adeco" style="left:97%;top:14%;animation-delay:1.2s">☕</span>
          <span class="adeco" style="left:48%;top:6%;animation-delay:2.4s">✨</span>
          <span class="adeco" style="left:8%;top:88%;animation-delay:3.1s">📚</span>
          <span class="adeco" style="left:92%;top:90%;animation-delay:4.5s">🕐</span>
        </div>
        <!-- agents inserted here by JS — coords resolve % of stageInner -->
      </div>
    </div>

    <!-- Floating particles for ambient feel -->
    <div class="particles" id="particles"></div>

    <!-- Conference area (CEO + whiteboard at top of studio, where wall monitors are) -->
    <div class="conf-room">
      <div class="conf-label">CONFERENCE</div>
      <div class="whiteboard" id="whiteboard">대기 중 — 명령을 내리면 팀이 움직입니다</div>
    </div>

    <!-- Smallville locations — emoji markers (no heavy CSS furniture, image bg provides studio look) -->
    <div class="location loc-coffee"     data-loc="coffee"><div class="loc-icon">☕</div><div class="loc-label">COFFEE</div></div>
    <div class="location loc-whiteboard" data-loc="whiteboard"><div class="loc-icon">📊</div><div class="loc-label">BOARD</div></div>
    <div class="location loc-lounge"     data-loc="lounge"><div class="loc-icon">🛋️</div><div class="loc-label">LOUNGE</div></div>
    <div class="location loc-server"     data-loc="server"><div class="loc-icon">🖥️</div><div class="loc-label">SERVERS</div></div>
    <div class="location loc-brain"      data-loc="brain"><div class="loc-icon">🧠</div><div class="loc-label">SECOND BRAIN</div></div>

    <div class="office-vignette"></div>
    <svg class="beams" id="beams" preserveAspectRatio="none"></svg>
    <!-- agents injected by JS -->

  </div>

  <!-- Agent profile modal — centered overlay above everything -->
  <div class="agent-modal-backdrop" id="agentModalBackdrop" hidden>
    <div class="agent-modal" id="agentModal" role="dialog" aria-modal="true">
      <div class="amd-head">
        <span class="amd-emoji" id="amdEmoji"></span>
        <div class="amd-title"><div class="amd-name" id="amdName">—</div><div class="amd-role" id="amdRole">—</div></div>
        <button class="amd-close" id="amdClose">✕</button>
      </div>
      <div class="amd-stats">
        <div class="amd-stat"><div class="amd-stat-lbl">SESSIONS</div><div class="amd-stat-val" id="amdSessions">0</div></div>
        <div class="amd-stat"><div class="amd-stat-lbl">STATE</div><div class="amd-stat-val" id="amdState">IDLE</div></div>
        <div class="amd-stat"><div class="amd-stat-lbl">SPECIALTY</div><div class="amd-stat-val" id="amdSpecialty" style="font-size:9px">—</div></div>
      </div>
      <div class="amd-section">
        <div class="amd-section-head">⚙️ 외부 연결 / API</div>
        <div class="amd-form" id="amdConfigForm"><span style="font-size:10px;color:var(--text-dim)">이 에이전트는 별도 설정이 없습니다.</span></div>
        <div class="amd-save-status" id="amdSaveStatus"></div>
      </div>
      <div class="amd-section">
        <div class="amd-section-head">🧠 메모리 (memory.md)</div>
        <pre class="amd-content" id="amdMemory">불러오는 중…</pre>
      </div>
      <div class="amd-section">
        <div class="amd-section-head">📜 의사결정 로그 (decisions.md)</div>
        <pre class="amd-content" id="amdDecisions">불러오는 중…</pre>
      </div>
      <div class="amd-section">
        <div class="amd-section-head">📁 최근 세션</div>
        <div id="amdSessionList" class="amd-sessions">—</div>
      </div>
      <div class="amd-foot">
        <button class="amd-btn primary" id="amdSaveConfig">💾 저장</button>
        <button class="amd-btn" id="amdOpenFolder">📁 폴더</button>
      </div>
    </div>
  </div>
  <div class="side-resizer hidden" id="sideResizer" title="드래그해서 사이드 패널 너비 조절"></div>
  <div class="side">
    <div class="side-tabs">
      <button class="side-tab active" data-pane="logPane" title="📡 활동 로그
지금 어떤 에이전트가 무엇을 하고 있는지 실시간 흐름. 디스패치·도구 실행·완료가 시간순으로 쌓입니다.">📡 활동</button>
      <button class="side-tab" data-pane="outPane" title="📦 산출물
에이전트가 만들어낸 파일·보고서·코드 등 결과물 목록.">📦 산출물</button>
      <button class="side-tab" data-pane="convPane" title="📜 오늘 대화록
오늘 날짜로 저장된 대화 기록 (conversations/YYYY-MM-DD.md). 새로고침으로 다시 읽음.">📜 대화록</button>
    </div>
    <div class="side-pane active" id="logPane">
      <div class="side-empty" id="logEmpty">
        <div class="ic">📡</div>
        <div>활동이 없어요</div>
        <div class="hint">에이전트가 일을 시작하면 여기에 실시간으로 흐릅니다.</div>
      </div>
    </div>
    <div class="side-pane" id="outPane">
      <div class="side-empty">
        <div class="ic">📦</div>
        <div>아직 산출물이 없어요</div>
        <div class="hint">사이드바 채팅이나 텔레그램에 일을 던져주세요.</div>
      </div>
    </div>
    <div class="side-pane" id="convPane">
      <div style="font-size:11px;color:var(--text);line-height:1.6;font-family:inherit">
        <div id="convDate" style="font-size:9.5px;color:var(--text-dim);margin-bottom:10px;letter-spacing:.6px;font-weight:600;text-transform:uppercase">오늘 대화록 로딩 중…</div>
        <div id="convBody" style="white-space:pre-wrap;word-break:break-word"></div>
        <div style="margin-top:16px;text-align:center">
          <button class="topbtn ghost" id="reloadConvBtn" style="font-size:11px">🔄 새로고침</button>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- 명령창은 사이드바에 통합됨. 사무실 패널은 시각화 전용. -->
<div class="cmdbar" style="display:none">
  <input id="cmdInput" type="hidden" />
  <button id="cmdSend" style="display:none">전송 ↑</button>
</div>

<script>
const vscode = acquireVsCodeApi();

/* === Custom tooltip system (1s delay, neon style) ===
   브라우저 기본 title 은 너무 느리고(2-3초) hover 위치도 마우스 따라 깜빡임.
   대신 모든 [title] 을 data-tip 으로 옮겨서 native tooltip 끄고, 우리가
   1초 후에 정확히 element 아래에 띄운다. dynamic 으로 추가되는 element 도
   event delegation 으로 자동 캐치. */
(function setupTooltips(){
  const tipEl = document.createElement('div');
  tipEl.className = 'custom-tooltip';
  document.body.appendChild(tipEl);
  let showTimer = null;
  let activeEl = null;

  function migrateTitle(el){
    if (!el || !el.getAttribute) return;
    const t = el.getAttribute('title');
    if (t && !el.hasAttribute('data-tip')) {
      el.setAttribute('data-tip', t);
      el.removeAttribute('title');
    }
  }
  /* 초기 sweep — 페이지의 모든 [title] 을 data-tip 으로 변환. */
  document.querySelectorAll('[title]').forEach(migrateTitle);
  /* MutationObserver — 동적으로 추가되는 [title] 도 잡아냄. */
  const mo = new MutationObserver((records) => {
    for (const r of records) {
      r.addedNodes.forEach((n) => {
        if (n.nodeType !== 1) return;
        migrateTitle(n);
        n.querySelectorAll && n.querySelectorAll('[title]').forEach(migrateTitle);
      });
      if (r.type === 'attributes' && r.attributeName === 'title') {
        migrateTitle(r.target);
      }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['title'] });

  function hideTip(){
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    tipEl.classList.remove('show');
    activeEl = null;
  }
  function showTipFor(el){
    const text = el.getAttribute('data-tip');
    if (!text) return;
    tipEl.textContent = text;
    /* 위치: element 아래쪽 기본, 화면 하단 가까우면 위쪽으로 flip */
    const r = el.getBoundingClientRect();
    const margin = 8;
    /* 임시로 표시해서 실제 크기 측정 */
    tipEl.style.left = '-9999px';
    tipEl.style.top = '0';
    tipEl.classList.add('show');
    const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
    const winW = window.innerWidth, winH = window.innerHeight;
    let left = r.left;
    let top = r.bottom + margin;
    let placement = 'below';
    if (top + th > winH - 8) { top = r.top - th - margin; placement = 'above'; }
    if (left + tw > winW - 8) left = winW - tw - 8;
    if (left < 8) left = 8;
    tipEl.classList.toggle('below', placement === 'below');
    tipEl.classList.toggle('above', placement === 'above');
    tipEl.style.left = left + 'px';
    tipEl.style.top = top + 'px';
  }
  document.addEventListener('mouseover', (e) => {
    const el = e.target && e.target.closest && e.target.closest('[data-tip]');
    if (!el || el === activeEl) return;
    if (showTimer) clearTimeout(showTimer);
    activeEl = el;
    tipEl.classList.remove('show');
    showTimer = setTimeout(() => showTipFor(el), 1000);
  });
  document.addEventListener('mouseout', (e) => {
    const leaving = e.target && e.target.closest && e.target.closest('[data-tip]');
    if (!leaving) return;
    /* mouseout 은 자식으로 옮겨갈 때도 발사되므로 relatedTarget 확인 */
    const to = e.relatedTarget;
    if (to && leaving.contains(to)) return;
    hideTip();
  });
  document.addEventListener('mousedown', hideTip, true);
  window.addEventListener('blur', hideTip);
  window.addEventListener('scroll', hideTip, true);
})();

const floor = document.getElementById('floor');
const beams = document.getElementById('beams');
const whiteboard = document.getElementById('whiteboard');
const cmdInput = document.getElementById('cmdInput');
const cmdSend = document.getElementById('cmdSend');
const logPane = document.getElementById('logPane');
const outPane = document.getElementById('outPane');
const topCompany = document.getElementById('topCompany');
const topMeta = document.getElementById('topMeta');
const folderBtn = document.getElementById('folderBtn');

let agents = [];
let agentMap = {};
let deskEls = {};   /* alias: agent elements */
let outCardEls = {};
let currentTasks = [];
/* Home desk positions are % of the WORLD canvas (1400×700 campus).
   Replaced by world.desks at officeInit time; placeholder below covers
   the brief moment before the message arrives. Office is at world
   x=540..1052, y=90..634, so each agent's office-local % maps to world. */
let HOME_POS = {
  youtube:   { x: 49, y: 41 },
  instagram: { x: 56, y: 41 },
  designer:  { x: 63, y: 41 },
  business:  { x: 69, y: 41 },
  developer: { x: 49, y: 57 },
  secretary: { x: 69, y: 57 },
  ceo:       { x: 64, y: 77 }
};

function getHomeXY(agentId){
  const p = HOME_POS[agentId] || { x: 50, y: 50 };
  return { x: p.x, y: p.y };
}




function makeAgent(a){
  const home = getHomeXY(a.id);
  const d = document.createElement('div');
  d.className = 'agent idle';
  d.dataset.agent = a.id;
  d.dataset.homeX = home.x;
  d.dataset.homeY = home.y;
  d.dataset.dir = 'down';
  d.style.setProperty('--ag-color', a.color);
  d.style.setProperty('--ag-color-glow', a.color + '55');
  positionAgentToImageCoord(d, home.x, home.y);
  
  /* Sprite character — atlas (LimeZu 48×96 × 24 frames) OR single photo-sprite.
     photo-sprite 모드는 background 한 장을 contain 으로 채우고 frame animation 끔. */
  const character = document.createElement('div');
  character.className = 'character';
  if (a.spriteSource === 'photo') character.classList.add('photo-sprite');
  if (a.sprite) {
    character.style.backgroundImage = 'url(' + a.sprite + ')';
  } else {
    /* Fallback to CEO sprite if missing */
    character.style.background = 'rgba(255,255,255,0.1)';
  }
  
  const led = document.createElement('span'); led.className = 'ag-led'; d.appendChild(led);
  d.appendChild(character);
  /* v2.89.157 — 머리 위 작업 진행 바 + sparkle 컨테이너 */
  const wbar = document.createElement('div'); wbar.className = 'work-bar';
  const wfill = document.createElement('div'); wfill.className = 'work-bar-fill';
  wbar.appendChild(wfill); d.appendChild(wbar);
  const nm = document.createElement('div'); nm.className = 'ag-plate'; nm.textContent = a.emoji + ' ' + a.name; d.appendChild(nm);
  d.title = a.role + ' — ' + a.specialty;
  d.addEventListener('click', () => {
    /* CEO opens its folder; everyone else opens the unified agent card —
       same modal the agent board uses, so floor plan + board stay in sync. */
    if (a.id === 'ceo') {
      vscode.postMessage({type:'openCompanyFolder',sub:'_agents/ceo'});
      return;
    }
    showAgentPanel(a);
  });
  return d;
}

/** Position agent at (xPct, yPct) as % of stageInner — which has the same
    bounds as the office bg image (CSS aspect-ratio), so coords map 1:1.
    Higher y = renders in front (depth-sort), so agents farther down the
    office naturally occlude ones above them. */
function positionAgentToImageCoord(el, xPct, yPct){
  el.style.left = 'calc(' + xPct + '% - 24px)';
  el.style.top  = 'calc(' + yPct + '% - 96px)';
  el.style.zIndex = String(10 + Math.floor(yPct * 10));
}

function repositionAllAgents(){
  agents.forEach(a => {
    const el = deskEls[a.id]; if (!el) return;
    const x = parseFloat(el.dataset.homeX), y = parseFloat(el.dataset.homeY);
    positionAgentToImageCoord(el, x, y);
  });
  /* Re-anchor location markers to image coords too */
  positionLocations();
}

function positionLocations(){
  const bgEl = document.getElementById('officeBg');
  const fr = floor.getBoundingClientRect();
  if (!bgEl || !bgEl.complete || !bgEl.naturalWidth) return;
  const iw = bgEl.clientWidth, ih = bgEl.clientHeight;
  const ix = (fr.width - iw) / 2;
  const iy = (fr.height - ih) / 2;
  Object.keys(LOCATIONS).forEach(id => {
    const def = LOCATIONS[id];
    const el = document.querySelector('[data-loc="'+id+'"]');
    if (!el) return;
    const px = ix + (def.x / 100) * iw;
    const py = iy + (def.y / 100) * ih;
    el.style.left = px + 'px';
    el.style.top  = py + 'px';
  });
}

function setDeskState(agentId, state, task){
  const d = deskEls[agentId]; if (!d) return;
  d.classList.remove('idle','thinking','working','done');
  d.classList.add(state);
  const old = d.querySelector('.bubble'); if (old) old.remove();
  if (task && (state === 'working' || state === 'thinking')) {
    const b = document.createElement('div'); b.className = 'bubble'; b.textContent = task;
    d.appendChild(b);
    setTimeout(() => { try { b.style.opacity = '0'; setTimeout(() => b.remove(), 350); } catch{} }, 3500);
  }
  /* Recompute the topbar HUD "Working" count + status-row activity text
     whenever any desk state changes. Makes the office feel genuinely live —
     the user sees the count rise the moment an agent starts a task. */
  try { updateLiveStatus(); } catch {}
}

/* Counts how many agents are currently in working/thinking state and
   refreshes the topbar HUD pill + status-row text. Cheap (DOM scan). */
function updateLiveStatus(){
  try {
    let working = 0, thinking = 0;
    const workingNames = [];
    Object.keys(deskEls).forEach(id => {
      const d = deskEls[id];
      if (!d) return;
      if (d.classList.contains('working')) { working++; workingNames.push(agentMap[id]?.name || id); }
      else if (d.classList.contains('thinking')) { thinking++; }
    });
    const total = Object.keys(deskEls).length || agents.length;
    const wrkEl = document.getElementById('hudWorking');
    const wrkStatEl = document.getElementById('hudWorkingStat');
    if (wrkEl) wrkEl.textContent = working + '/' + total;
    if (wrkStatEl) wrkStatEl.classList.toggle('warn', working === 0 && thinking === 0);
    /* Status row: short, optimistic phrasing about who's doing what. */
    const sa = document.getElementById('statusActivity');
    if (sa) {
      if (working > 0) {
        const head = workingNames.slice(0, 2).join(', ');
        const more = workingNames.length > 2 ? (' 외 ' + (workingNames.length - 2) + '명') : '';
        sa.textContent = head + more + ' 작업 중';
      } else if (thinking > 0) {
        sa.textContent = thinking + '명 생각 중';
      }
      /* Don't overwrite the last logActivity message when fully idle —
         that lets the most recent meaningful event linger in the status row. */
    }
  } catch {}
}

function showBubbleOn(agentId, text, ms){
  const d = deskEls[agentId]; if (!d) return;
  const old = d.querySelector('.bubble'); if (old) old.remove();
  const b = document.createElement('div'); b.className = 'bubble'; b.textContent = text;
  d.appendChild(b);
  const dur = ms || 2500;
  setTimeout(() => { try { b.style.opacity = '0'; setTimeout(() => b.remove(), 350); } catch{} }, dur);
}

/* ==== Auto-walking + idle chat ==== */
let autoWalkActive = false;
const IDLE_CHATS = [
  '커피 한잔?', '오늘 진도 어때?', '아 그거 봤어?', '점심 뭐 먹지', '와 대박',
  '확인해볼게', '체크', '오케이', '굿', '음...', '잠깐만', '나중에 얘기하자'
];
function pickRandom(arr){ return arr[Math.floor(Math.random() * arr.length)]; }

function walkToward(agentId, targetXPct, targetYPct, durationMs){
  const el = deskEls[agentId]; if (!el) return Promise.resolve();
  const currentX = parseFloat(el.style.left.replace(/[^-0-9.]/g, '')) || 0; // Simplified check
  const currentY = parseFloat(el.style.top.replace(/[^-0-9.]/g, '')) || 0;
  
  /* Determine direction */
  const dx = targetXPct - parseFloat(el.dataset.currX || el.dataset.homeX);
  const dy = targetYPct - parseFloat(el.dataset.currY || el.dataset.homeY);
  if (Math.abs(dx) > Math.abs(dy)) {
    el.dataset.dir = dx > 0 ? 'right' : 'left';
  } else {
    el.dataset.dir = dy > 0 ? 'down' : 'up';
  }
  el.dataset.currX = targetXPct;
  el.dataset.currY = targetYPct;

  el.classList.add('walking');
  positionAgentToImageCoord(el, targetXPct, targetYPct);
  return new Promise(resolve => {
    setTimeout(() => { el.classList.remove('walking'); resolve(); }, durationMs || 1000);
  });
}

/* ===== Visit locations — WORLD %-coords (1400×700 campus canvas) =====
   Campus: Office (center-right), Cafe (left), Garden (right + outside).
   These ids are referenced by PERSONALITY.likedLocs and visitLocationStep. */
const LOCATIONS = {
  cafeCounter: { x: 21, y: 39, label:'☕ 카페 카운터',     emoji:'☕', stay: 4000 },
  cafeTable:   { x: 22, y: 75, label:'🪑 카페 테이블',     emoji:'🪑', stay: 5000 },
  meeting:     { x: 49, y: 78, label:'📊 회의실',          emoji:'📊', stay: 4500 },
  copier:      { x: 70, y: 18, label:'🖨️ 복사실',          emoji:'🖨️', stay: 3500 },
  gardenBench: { x: 85, y: 32, label:'🌳 정원 벤치',       emoji:'🌳', stay: 5500 },
  gardenTree:  { x: 92, y: 86, label:'🌲 큰 나무 아래',    emoji:'🌲', stay: 6000 },
  gardenWalk:  { x: 78, y: 60, label:'🚶 잔디 산책',       emoji:'🚶', stay: 4500 }
};

/* Per-agent personality — drives thoughts, status preferences, location bias.
   likedLocs reference LOCATIONS keys (conference/copier/water/plants/ceoDoor). */
const PERSONALITY = {
  ceo: {
    thoughts: ['이번 분기 목표가...', '회사 비전 정리해야', '다음 큰 그림은?', '팀 잘 굴러가나', 'KPI 다시 봐야겠다'],
    status: ['🧠','💼','📋','🎯'],
    likedLocs: ['meeting','gardenBench','cafeCounter']
  },
  youtube: {
    thoughts: ['다음 썸네일 뭐로?', '오프닝 5초가 핵심', '트렌드 봐야지', '편집 컷 좀 줄이자', '구독자 반응 어떨까'],
    status: ['🎥','📹','💡','🔥','▶️'],
    likedLocs: ['cafeCounter','meeting','gardenWalk']
  },
  designer: {
    thoughts: ['색감이 뭔가 부족한데', '여백을 더...', '폰트 다시 골라야', '레퍼런스 찾자', '톤앤매너가 안 맞아'],
    status: ['🎨','💜','✏️','💡','✨'],
    likedLocs: ['gardenBench','copier','cafeTable']
  },
  instagram: {
    thoughts: ['릴스 트렌드 체크', '해시태그 뭘로?', '커버 이미지가 약해', '댓글 톤이 좋네', '피드 구성 다시'],
    status: ['📸','💖','🌸','✨','📱'],
    likedLocs: ['gardenBench','cafeTable','gardenWalk']
  },
  developer: {
    thoughts: ['이거 캐시해야', '버그 어디서 났지', '리팩터 해야 하는데', '...아 그게 그구나', '커피 한 잔 더'],
    status: ['💻','⌨️','🐛','💡','☕'],
    likedLocs: ['cafeCounter','copier','gardenTree']
  },
  business: {
    thoughts: ['ROI 계산 다시', '단가 협상해야', '월 마감 보자', '현금흐름은 OK', '채널별 수익 분리'],
    status: ['💰','📈','💼','📊','💹'],
    likedLocs: ['meeting','copier','cafeCounter']
  },
  secretary: {
    thoughts: ['일정 정리하자', '메일 답장 보내야', 'CEO 미팅 30분 후', '다들 할 일 알지?', '회의록 다시 보자'],
    status: ['📋','📞','📅','📝','✉️'],
    likedLocs: ['copier','meeting','cafeTable']
  }
};

/* Show small status icon above an agent's head (auto-fades) */
function showStatusIcon(agentId, icon, ms){
  const d = deskEls[agentId]; if (!d) return;
  const old = d.querySelector('.ag-status'); if (old) old.remove();
  const s = document.createElement('div'); s.className='ag-status'; s.textContent = icon;
  d.appendChild(s);
  const dur = ms || 3500;
  setTimeout(() => { try { s.classList.add('fade'); setTimeout(()=>s.remove(),350); } catch{} }, dur);
}

/* Show dotted thought bubble (.oO style — inner monologue) */
function showThought(agentId, text, ms){
  const d = deskEls[agentId]; if (!d) return;
  const old = d.querySelector('.thought'); if (old) old.remove();
  const t = document.createElement('div'); t.className='thought'; t.textContent = '· '+text;
  d.appendChild(t);
  const dur = ms || 3500;
  setTimeout(() => { try { t.style.opacity='0'; setTimeout(()=>t.remove(),350); } catch{} }, dur);
}

/* v2.89.150 — 화면 중앙 거대 글리치 배너. dispatch 시 시청자가 바로 알게.
   3초 후 fade. 매트릭스 풍 cyan + violet 그라데이션. */
function spawnDispatchBanner(briefText) {
  const stage = document.getElementById('stageInner') || document.getElementById('officeStage');
  if (!stage) return;
  const old = document.getElementById('dispatchBanner');
  if (old) try { old.remove(); } catch {}
  const banner = document.createElement('div');
  banner.id = 'dispatchBanner';
  banner.style.cssText = [
    'position:absolute', 'top:38%', 'left:50%', 'transform:translate(-50%,-50%) scale(0.6)',
    'z-index:30', 'pointer-events:none', 'text-align:center',
    'font-family:"SF Pro Display",-apple-system,sans-serif',
    'opacity:0', 'transition:opacity .4s, transform .5s cubic-bezier(.2,.8,.2,1)'
  ].join(';');
  banner.innerHTML =
    '<div style="font-size:clamp(28px,5vw,52px); font-weight:900; letter-spacing:.08em;' +
    'background:linear-gradient(135deg,#67e8f9,#a78bfa,#fbbf24);' +
    '-webkit-background-clip:text;background-clip:text;color:transparent;' +
    'text-shadow:0 0 60px rgba(34,211,238,.7);' +
    'animation:bannerGlitch .35s steps(2) 2;">' +
    '📋 DISPATCH PROTOCOL' +
    '</div>' +
    '<div style="font-size:clamp(13px,1.6vw,18px); color:#67e8f9; margin-top:6px;' +
    'letter-spacing:.18em; font-weight:700; text-shadow:0 0 12px #22d3ee; ' +
    'text-transform:uppercase;">' +
    escapeHtml((briefText || '').slice(0, 80)) +
    '</div>';
  /* 글리치 keyframe inject (한 번만) */
  if (!document.getElementById('bannerGlitchKf')) {
    const style = document.createElement('style');
    style.id = 'bannerGlitchKf';
    style.textContent = '@keyframes bannerGlitch{0%,100%{transform:translate(0,0)}25%{transform:translate(-2px,1px)}50%{transform:translate(2px,-1px)}75%{transform:translate(-1px,-2px)}}';
    document.head.appendChild(style);
  }
  stage.appendChild(banner);
  requestAnimationFrame(() => {
    banner.style.opacity = '1';
    banner.style.transform = 'translate(-50%,-50%) scale(1)';
  });
  setTimeout(() => {
    try {
      banner.style.opacity = '0';
      banner.style.transform = 'translate(-50%,-80%) scale(1.05)';
      setTimeout(() => { try { banner.remove(); } catch {} }, 500);
    } catch {}
  }, 2400);
}

/* v2.89.150 — 회의 종료 배너. specialist 가 자기 자리로 복귀하는 순간. */
function spawnMeetingEndBanner() {
  const stage = document.getElementById('stageInner') || document.getElementById('officeStage');
  if (!stage) return;
  const old = document.getElementById('meetingEndBanner');
  if (old) try { old.remove(); } catch {}
  const banner = document.createElement('div');
  banner.id = 'meetingEndBanner';
  banner.style.cssText = [
    'position:absolute', 'top:38%', 'left:50%', 'transform:translate(-50%,-50%) scale(0.8)',
    'z-index:30', 'pointer-events:none', 'text-align:center',
    'font-family:"SF Pro Display",-apple-system,sans-serif',
    'opacity:0', 'transition:opacity .35s, transform .4s cubic-bezier(.2,.8,.2,1)'
  ].join(';');
  banner.innerHTML =
    '<div style="font-size:clamp(22px,3.2vw,32px); font-weight:900; letter-spacing:.1em;' +
    'background:linear-gradient(135deg,#22d3ee,#67e8f9);' +
    '-webkit-background-clip:text;background-clip:text;color:transparent;' +
    'text-shadow:0 0 40px rgba(34,211,238,.5);">' +
    '✨ MEETING COMPLETE' +
    '</div>' +
    '<div style="font-size:clamp(11px,1.2vw,14px); color:#22d3ee; margin-top:4px;' +
    'letter-spacing:.18em; font-weight:700; text-transform:uppercase;">' +
    'AGENTS DISPATCHED TO WORKSTATIONS' +
    '</div>';
  stage.appendChild(banner);
  requestAnimationFrame(() => {
    banner.style.opacity = '1';
    banner.style.transform = 'translate(-50%,-50%) scale(1)';
  });
  setTimeout(() => {
    try {
      banner.style.opacity = '0';
      banner.style.transform = 'translate(-50%,-70%) scale(1.02)';
      setTimeout(() => { try { banner.remove(); } catch {} }, 400);
    } catch {}
  }, 1500);
}

/* v2.89.150 — 도착 파티클 폭발. specialist 책상에 task 도착 순간. */
function spawnArrivalBurst(agentId) {
  const el = deskEls[agentId]; if (!el) return;
  const stage = document.getElementById('stageInner') || document.getElementById('officeStage');
  if (!stage) return;
  const stageRect = stage.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  const cx = er.left + er.width / 2 - stageRect.left;
  const cy = er.top + er.height / 2 - stageRect.top;
  const colors = ['#67e8f9', '#fbbf24', '#a78bfa', '#22d3ee', '#fef08a'];
  for (let i = 0; i < 12; i++) {
    const p = document.createElement('div');
    const ang = (i / 12) * Math.PI * 2;
    const dist = 30 + Math.random() * 20;
    const color = colors[i % colors.length];
    p.style.cssText = [
      'position:absolute',
      'left:' + cx + 'px', 'top:' + cy + 'px',
      'width:6px', 'height:6px', 'border-radius:50%',
      'background:' + color,
      'box-shadow:0 0 12px ' + color,
      'pointer-events:none', 'z-index:25',
      'transform:translate(-50%,-50%)',
      'transition:transform .7s cubic-bezier(.2,.8,.2,1),opacity .7s'
    ].join(';');
    stage.appendChild(p);
    requestAnimationFrame(() => {
      const tx = Math.cos(ang) * dist;
      const ty = Math.sin(ang) * dist;
      p.style.transform = 'translate(calc(-50% + ' + tx + 'px),calc(-50% + ' + ty + 'px)) scale(0.4)';
      p.style.opacity = '0';
    });
    setTimeout(() => { try { p.remove(); } catch {} }, 750);
  }
}

/* v2.89.148 — CEO ↔ specialist dispatch 광선 효과. 책상 두 개 사이 SVG line +
   따라 흐르는 점. 시각적으로 "CEO가 task 보냈다 → specialist 받음" 표현.
   v2.89.150: 광선 색 cyan→violet 그라데이션 + 황금 점 꼬리 추가 + 도착 파티클. */
function spawnDispatchBeam(fromId, toId) {
  const fromEl = deskEls[fromId], toEl = deskEls[toId];
  if (!fromEl || !toEl) return;
  const stage = document.getElementById('stageInner') || document.getElementById('officeStage');
  if (!stage) return;
  const stageRect = stage.getBoundingClientRect();
  const fr = fromEl.getBoundingClientRect();
  const tr = toEl.getBoundingClientRect();
  const x1 = fr.left + fr.width / 2 - stageRect.left;
  const y1 = fr.top + fr.height / 2 - stageRect.top;
  const x2 = tr.left + tr.width / 2 - stageRect.left;
  const y2 = tr.top + tr.height / 2 - stageRect.top;
  let svg = document.getElementById('dispatchBeamLayer');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'dispatchBeamLayer';
    svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:20;overflow:visible;';
    /* gradient defs */
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML =
      '<linearGradient id="beamGrad" x1="0%" y1="0%" x2="100%" y2="0%">' +
      '<stop offset="0%" stop-color="#67e8f9"/>' +
      '<stop offset="50%" stop-color="#a78bfa"/>' +
      '<stop offset="100%" stop-color="#22d3ee"/></linearGradient>';
    svg.appendChild(defs);
    stage.appendChild(svg);
  }
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('x1', x1); line.setAttribute('y1', y1);
  line.setAttribute('x2', x2); line.setAttribute('y2', y2);
  line.setAttribute('stroke', 'url(#beamGrad)');
  line.setAttribute('stroke-width', '3');
  line.setAttribute('stroke-dasharray', '8 5');
  line.setAttribute('stroke-linecap', 'round');
  line.style.filter = 'drop-shadow(0 0 8px #22d3ee) drop-shadow(0 0 14px rgba(167,139,250,.5))';
  line.style.opacity = '0';
  requestAnimationFrame(() => { line.style.transition = 'opacity .3s'; line.style.opacity = '0.9'; });
  /* 점선 따라 흐르는 애니메이션 */
  const anim = document.createElementNS('http://www.w3.org/2000/svg', 'animate');
  anim.setAttribute('attributeName', 'stroke-dashoffset');
  anim.setAttribute('from', '0'); anim.setAttribute('to', '-40');
  anim.setAttribute('dur', '0.7s'); anim.setAttribute('repeatCount', 'indefinite');
  line.appendChild(anim);
  svg.appendChild(line);
  /* 메인 황금 점 + 꼬리 (3개 trailing dots) */
  const dots = [];
  for (let i = 0; i < 3; i++) {
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    const r = 6 - i * 1.5;
    dot.setAttribute('r', String(Math.max(2, r)));
    dot.setAttribute('fill', i === 0 ? '#fef08a' : (i === 1 ? '#fbbf24' : '#f59e0b'));
    dot.style.filter = 'drop-shadow(0 0 ' + (12 - i * 3) + 'px #fbbf24)';
    dot.style.opacity = String(1 - i * 0.25);
    const animX = document.createElementNS('http://www.w3.org/2000/svg', 'animate');
    animX.setAttribute('attributeName', 'cx'); animX.setAttribute('from', x1); animX.setAttribute('to', x2);
    animX.setAttribute('dur', '1.0s'); animX.setAttribute('begin', (i * 0.08) + 's');
    animX.setAttribute('fill', 'freeze');
    const animY = document.createElementNS('http://www.w3.org/2000/svg', 'animate');
    animY.setAttribute('attributeName', 'cy'); animY.setAttribute('from', y1); animY.setAttribute('to', y2);
    animY.setAttribute('dur', '1.0s'); animY.setAttribute('begin', (i * 0.08) + 's');
    animY.setAttribute('fill', 'freeze');
    dot.appendChild(animX); dot.appendChild(animY);
    svg.appendChild(dot);
    dots.push(dot);
  }
  /* 도착 시 파티클 폭발 */
  setTimeout(() => { try { spawnArrivalBurst(toId); } catch {} }, 1050);
  /* 광선 페이드아웃 */
  setTimeout(() => {
    try {
      line.style.transition = 'opacity 0.6s'; line.style.opacity = '0';
      dots.forEach(d => { d.style.transition = 'opacity .4s'; d.style.opacity = '0'; });
      setTimeout(() => { try { line.remove(); dots.forEach(d => d.remove()); } catch {} }, 700);
    } catch {}
  }, 3200);
}

async function idleChatStep(){
  if (!autoWalkActive) return;
  const idleAgents = agents.filter(a => {
    const el = deskEls[a.id];
    return el && (el.classList.contains('idle') || el.classList.contains('done'));
  });
  if (idleAgents.length < 2) return;
  const A = pickRandom(idleAgents);
  let B = pickRandom(idleAgents);
  let tries = 0;
  while (B.id === A.id && tries < 5) { B = pickRandom(idleAgents); tries++; }
  if (B.id === A.id) return;
  const bEl = deskEls[B.id]; if (!bEl) return;
  const bx = parseFloat(bEl.dataset.homeX), by = parseFloat(bEl.dataset.homeY);
  const aHomeX = parseFloat(deskEls[A.id].dataset.homeX);
  const aHomeY = parseFloat(deskEls[A.id].dataset.homeY);
  const ax = bx + (aHomeX > bx ? 7 : -7);
  const ay = by + (aHomeY > by ? 5 : -5);
  showStatusIcon(A.id, '💬', 4500);
  await walkToward(A.id, ax, ay, 1100);
  showBubbleOn(A.id, pickRandom(IDLE_CHATS), 1800);
  logActivity(A.emoji, A.id, '<strong>'+A.name+'</strong> → '+B.emoji+' '+B.name+' (잡담)');
  await new Promise(r => setTimeout(r, 1400));
  if (Math.random() < 0.7) {
    showStatusIcon(B.id, '💬', 2500);
    showBubbleOn(B.id, pickRandom(IDLE_CHATS), 1800);
    await new Promise(r => setTimeout(r, 1400));
  }
  await walkToward(A.id, aHomeX, aHomeY, 1100);
}

/* Visit a location, idle there, return — Smallville routine */
async function visitLocationStep(){
  if (!autoWalkActive) return;
  const idleAgents = agents.filter(a => {
    const el = deskEls[a.id];
    return el && (el.classList.contains('idle') || el.classList.contains('done'));
  });
  if (idleAgents.length === 0) return;
  const A = pickRandom(idleAgents);
  const persona = PERSONALITY[A.id] || { likedLocs:['coffee'], status:['💭'] };
  const locId = pickRandom(persona.likedLocs);
  const loc = LOCATIONS[locId]; if (!loc) return;
  const aHomeX = parseFloat(deskEls[A.id].dataset.homeX);
  const aHomeY = parseFloat(deskEls[A.id].dataset.homeY);
  /* offset so multiple agents at same location don't perfectly overlap */
  const offX = (Math.random() - 0.5) * 5;
  showStatusIcon(A.id, loc.emoji, loc.stay + 2400);
  logActivity(loc.emoji, A.id, '<strong>'+A.name+'</strong> → '+loc.label);
  /* mark location active */
  const locEl = document.querySelector('[data-loc="'+locId+'"]');
  if (locEl) locEl.classList.add('active');
  await walkToward(A.id, loc.x + offX, loc.y, 1300);
  await new Promise(r => setTimeout(r, loc.stay));
  if (locEl) locEl.classList.remove('active');
  await walkToward(A.id, aHomeX, aHomeY, 1300);
}

/* Think alone at desk — generate a personality thought */
async function thinkStep(){
  if (!autoWalkActive) return;
  const idleAgents = agents.filter(a => {
    const el = deskEls[a.id];
    return el && (el.classList.contains('idle') || el.classList.contains('done'));
  });
  if (idleAgents.length === 0) return;
  const A = pickRandom(idleAgents);
  const persona = PERSONALITY[A.id] || { thoughts:['...'], status:['💭'] };
  showStatusIcon(A.id, pickRandom(persona.status), 3500);
  showThought(A.id, pickRandom(persona.thoughts), 3500);
}

/* Weighted random action — Smallville-style autonomous behavior */
async function autonomousAct(){
  if (!autoWalkActive) return;
  const r = Math.random();
  if (r < 0.40) await idleChatStep();        /* 40% chitchat */
  else if (r < 0.75) await visitLocationStep(); /* 35% visit a place */
  else await thinkStep();                       /* 25% inner thought */
}

function startAutoWalk(){
  if (autoWalkActive) return;
  autoWalkActive = true;
  logActivity('🚶','ceo','자율 모드 ON — 에이전트들이 일과를 시작합니다.');
  const tick = async () => {
    if (!autoWalkActive) return;
    try { await autonomousAct(); } catch {}
    /* 14~32초 사이 랜덤 간격 — 더 활발하게 */
    const next = 14000 + Math.floor(Math.random() * 18000);
    setTimeout(tick, next);
  };
  setTimeout(tick, 6000);
}
function stopAutoWalk(){
  autoWalkActive = false;
  logActivity('🛑','ceo','자율 모드 OFF');
}

/* ===== Ambient particles — drifting glow dots ===== */
function spawnParticles(){
  const container = document.getElementById('particles'); if (!container) return;
  container.innerHTML = '';
  const count = 14;
  for (let i = 0; i < count; i++) {
    const p = document.createElement('span');
    p.style.left = (Math.random() * 100) + '%';
    p.style.bottom = '0';
    p.style.animationDuration = (10 + Math.random() * 8) + 's';
    p.style.animationDelay = (-Math.random() * 14) + 's';
    /* color variety: green/cyan/violet */
    const c = Math.random();
    if (c < 0.5) { /* green default */ }
    else if (c < 0.8) { p.style.background='rgba(34,211,238,.45)'; p.style.boxShadow='0 0 4px rgba(34,211,238,.7)'; }
    else { p.style.background='rgba(167,139,250,.45)'; p.style.boxShadow='0 0 4px rgba(167,139,250,.7)'; }
    container.appendChild(p);
  }
}

/* ===== HUD ticker — DAY / TIME / OUTPUT / WORKING =====
   DAY/TIME는 실제 달력·시계와 동기화. companyDay는 host로부터
   corporateState 메시지로 받음 (회사 출범일 기준 경과 일수). */
let hudOutputCount = 0;
let hudDayNum = 1;
let hudInterval = null;
function startHud(){
  if (hudInterval) clearInterval(hudInterval);
  const dayEl = document.getElementById('hudDay');
  const timeEl = document.getElementById('hudTime');
  const outEl = document.getElementById('hudOutput');
  const wrkEl = document.getElementById('hudWorking');
  const wrkStatEl = document.getElementById('hudWorkingStat');
  const meta = document.getElementById('topMeta');
  if (dayEl) dayEl.textContent = hudDayNum;
  const update = () => {
    if (dayEl && hudDayNum) dayEl.textContent = hudDayNum;
    /* Wall-clock time — 24h HH:MM, refreshed every tick */
    const now = new Date();
    if (timeEl) timeEl.textContent = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
    if (outEl) outEl.textContent = hudOutputCount;
    /* count agents currently working/thinking */
    let working = 0;
    agents.forEach(a => {
      const el = deskEls[a.id];
      if (el && (el.classList.contains('working') || el.classList.contains('thinking'))) working++;
    });
    if (wrkEl) wrkEl.textContent = working + '/' + agents.length;
    if (wrkStatEl) wrkStatEl.classList.toggle('warn', working > 0);
    if (meta) meta.textContent = '에이전트 '+agents.length+'명 · '+(working > 0 ? working+'명 작업 중' : '대기 중');
  };
  hudInterval = setInterval(update, 1000);
  update();
}
function bumpOutput(){ hudOutputCount++; const el = document.getElementById('hudOutput'); if (el) el.textContent = hudOutputCount; }

/* ===== Per-agent connection / API config field schema ===== */
const AGENT_CONFIG_FIELDS = {
  ceo: [
    { key:'company_vision', label:'회사 비전', type:'textarea', help:'한 문장으로 요약. 모든 에이전트가 의사결정 시 참고합니다.' },
    { key:'company_values', label:'핵심 가치', type:'textarea', help:'쉼표로 구분된 키워드. 예: 빠른 실행, 사용자 중심' },
    { key:'monthly_target', label:'월 목표', type:'text', help:'예: 매출 ₩1,000만 / 영상 8개 / 팔로워 +5,000' }
  ],
  youtube: [
    { key:'channel_id', label:'YouTube 채널 ID', type:'text', placeholder:'UCxxx...' },
    { key:'channel_handle', label:'채널 핸들', type:'text', placeholder:'@mychannel' },
    { key:'api_key', label:'YouTube Data API 키', type:'password', help:'console.cloud.google.com에서 발급. 트렌드 조회/통계용.' },
    { key:'content_focus', label:'주력 콘텐츠 주제', type:'textarea', help:'예: AI 도구 리뷰, 자동화 워크플로우' }
  ],
  instagram: [
    { key:'username', label:'인스타그램 핸들', type:'text', placeholder:'@yourhandle' },
    { key:'access_token', label:'Graph API Access Token', type:'password', help:'Meta for Developers에서 발급. 게시/통계용.' },
    { key:'business_account_id', label:'비즈니스 계정 ID', type:'text' },
    { key:'aesthetic', label:'피드 톤앤매너', type:'textarea', help:'예: 미니멀 / 비비드 / 다크모노' }
  ],
  designer: [
    { key:'figma_token', label:'Figma Personal Access Token', type:'password', help:'figma.com/settings → Personal access tokens' },
    { key:'brand_colors', label:'브랜드 컬러 (HEX, 쉼표)', type:'text', placeholder:'#FF0033, #FFD700' },
    { key:'preferred_fonts', label:'선호 폰트', type:'text', placeholder:'Pretendard, Inter' },
    { key:'design_system', label:'디자인 시스템 메모', type:'textarea' }
  ],
  developer: [
    { key:'github_token', label:'GitHub Personal Access Token', type:'password', help:'github.com/settings/tokens — repo + workflow 권한 필요' },
    { key:'default_repo', label:'기본 저장소 (owner/repo)', type:'text', placeholder:'yourname/agent-os-ai' },
    { key:'preferred_stack', label:'선호 기술 스택', type:'text', placeholder:'TypeScript, Next.js, PostgreSQL' },
    { key:'deploy_target', label:'배포 환경', type:'text', placeholder:'Vercel / 자체 서버' }
  ],
  business: [
    { key:'currency', label:'기본 통화', type:'text', placeholder:'KRW' },
    { key:'monthly_target_revenue', label:'월 목표 매출', type:'text', placeholder:'₩1,000만' },
    { key:'payment_provider', label:'결제 서비스', type:'text', placeholder:'Toss / Stripe / PayPal' },
    { key:'tax_rate', label:'세율 / 부가세 정책', type:'text', placeholder:'간이과세 / 일반과세' },
    { key:'revenue_streams', label:'수익 채널', type:'textarea', help:'예: 광고 / 멤버십 / 상품 판매' }
  ],
  secretary: [
    { key:'google_calendar_id', label:'Google Calendar ID', type:'text', placeholder:'primary 또는 yourcal@group.calendar.google.com' },
    { key:'google_oauth_token', label:'Google OAuth Token', type:'password', help:'OAuth 2.0 Playground 또는 자체 발급' },
    { key:'telegram_bot_token', label:'Telegram Bot Token', type:'password', help:'@BotFather에서 봇 만들고 토큰 받기' },
    { key:'telegram_chat_id', label:'Telegram Chat ID', type:'text', placeholder:'본인 chat_id (숫자)', help:'@userinfobot으로 확인' },
    { key:'work_hours', label:'근무 시간', type:'text', placeholder:'09:00–18:00' }
  ]
};

/* ===== Agent profile modal (in-UI panel) ===== */
let _profileAgentId = null;
function openAgentProfile(agentId){
  const a = agentMap[agentId]; if (!a) return;
  _profileAgentId = agentId;
  const backdrop = document.getElementById('agentModalBackdrop');
  const modal = document.getElementById('agentModal');
  const emoji = document.getElementById('amdEmoji');
  const name = document.getElementById('amdName');
  const role = document.getElementById('amdRole');
  const state = document.getElementById('amdState');
  const specialty = document.getElementById('amdSpecialty');
  const memory = document.getElementById('amdMemory');
  const decisions = document.getElementById('amdDecisions');
  const sessions = document.getElementById('amdSessions');
  const sessionList = document.getElementById('amdSessionList');
  if (emoji) emoji.textContent = a.emoji;
  if (name) name.textContent = a.name;
  if (role) role.textContent = a.role;
  if (specialty) specialty.textContent = a.specialty || '—';
  const el = deskEls[agentId];
  let cur = 'IDLE';
  if (el) {
    if (el.classList.contains('working')) cur = 'WORKING';
    else if (el.classList.contains('thinking')) cur = 'THINKING';
    else if (el.classList.contains('done')) cur = 'DONE';
  }
  if (state) state.textContent = cur;
  if (memory) memory.textContent = '불러오는 중…';
  if (decisions) decisions.textContent = '불러오는 중…';
  if (sessions) sessions.textContent = '…';
  if (sessionList) sessionList.innerHTML = '';
  /* render config form */
  renderConfigForm(agentId, {});
  modal.style.setProperty('--ag-color', a.color);
  modal.style.setProperty('--ag-color-glow', a.color + '55');
  if (backdrop) backdrop.removeAttribute('hidden');
  vscode.postMessage({ type: 'agentProfileRequest', agent: agentId });
  vscode.postMessage({ type: 'agentConfigRequest', agent: agentId });
}
function closeAgentProfile(){
  _profileAgentId = null;
  const backdrop = document.getElementById('agentModalBackdrop');
  if (backdrop) backdrop.setAttribute('hidden','');
}

function renderConfigForm(agentId, values){
  const form = document.getElementById('amdConfigForm');
  if (!form) return;
  const fields = AGENT_CONFIG_FIELDS[agentId] || [];
  if (fields.length === 0) {
    form.innerHTML = '<span style="font-size:10px;color:var(--text-dim)">이 에이전트는 별도 외부 연결 설정이 없습니다.</span>';
    return;
  }
  form.innerHTML = '';
  fields.forEach(f => {
    const wrap = document.createElement('div');
    wrap.className = 'amd-field';
    const lbl = document.createElement('label');
    lbl.className = 'amd-field-lbl';
    lbl.textContent = f.label;
    wrap.appendChild(lbl);
    let input;
    if (f.type === 'textarea') {
      input = document.createElement('textarea');
    } else {
      input = document.createElement('input');
      input.type = (f.type === 'password') ? 'password' : 'text';
    }
    input.className = 'amd-input';
    input.dataset.key = f.key;
    if (f.placeholder) input.placeholder = f.placeholder;
    if (values && values[f.key] !== undefined) input.value = values[f.key];
    wrap.appendChild(input);
    if (f.help) {
      const help = document.createElement('div');
      help.className = 'amd-field-help';
      help.textContent = f.help;
      wrap.appendChild(help);
    }
    form.appendChild(wrap);
  });
}

function collectConfigValues(){
  const form = document.getElementById('amdConfigForm');
  if (!form) return {};
  const out = {};
  form.querySelectorAll('[data-key]').forEach(el => {
    out[el.dataset.key] = el.value || '';
  });
  return out;
}

function saveAgentConfig(){
  if (!_profileAgentId) return;
  const values = collectConfigValues();
  const status = document.getElementById('amdSaveStatus');
  if (status) { status.className = 'amd-save-status show'; status.textContent = '저장 중…'; }
  vscode.postMessage({ type:'saveAgentConfig', agent: _profileAgentId, values });
}

(function(){
  const closeBtn = document.getElementById('amdClose');
  if (closeBtn) closeBtn.addEventListener('click', closeAgentProfile);
  /* Click on backdrop (outside modal box) closes too */
  const backdrop = document.getElementById('agentModalBackdrop');
  if (backdrop) backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeAgentProfile(); });
  /* Esc closes */
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && _profileAgentId) closeAgentProfile(); });
  const ofb = document.getElementById('amdOpenFolder');
  if (ofb) ofb.addEventListener('click', () => { if (_profileAgentId) vscode.postMessage({ type:'openCompanyFolder', sub:'_agents/'+_profileAgentId }); });
  const sfb = document.getElementById('amdSaveConfig');
  if (sfb) sfb.addEventListener('click', saveAgentConfig);
  const pfb = document.getElementById('pickFolderBtn');
  if (pfb) pfb.addEventListener('click', () => vscode.postMessage({ type:'pickCompanyFolder' }));
})();

/* ===== Brain integration visual ===== */
function pulseBrain(agentId, reason){
  const locEl = document.querySelector('[data-loc="brain"]');
  if (locEl) {
    locEl.classList.add('active');
    setTimeout(()=>locEl.classList.remove('active'), 2200);
  }
  if (agentId) showStatusIcon(agentId, '🧠', 2400);
  if (reason) {
    const a = agentMap[agentId];
    logActivity('🧠', agentId || 'ceo', '<strong>'+(a?a.name:'에이전트')+'</strong> 두뇌 열람: '+reason);
  }
}

function logActivity(emoji, agentId, text){
  const a = agentMap[agentId];
  /* Remove the empty placeholder once anything actually happens. */
  const empty = document.getElementById('logEmpty'); if (empty) empty.remove();
  const e = document.createElement('div'); e.className = 'log-entry';
  if (a) e.style.setProperty('--ag-color', a.color);
  const t = new Date(); const hh = String(t.getHours()).padStart(2,'0'), mm = String(t.getMinutes()).padStart(2,'0'), ss = String(t.getSeconds()).padStart(2,'0');
  e.innerHTML = '<span class="log-time">'+hh+':'+mm+':'+ss+'</span><span class="log-emoji">'+emoji+'</span><span class="log-text">'+text+'</span>';
  logPane.appendChild(e);
  logPane.scrollTop = logPane.scrollHeight;
  /* Mirror latest activity into the topbar status row so the user always
     has a one-line summary of what's happening — even with the log panel
     collapsed. Strip out HTML tags so the row stays clean. */
  try {
    const sa = document.getElementById('statusActivity');
    if (sa) {
      const stripped = String(text || '').replace(/<[^>]+>/g, '').slice(0, 120);
      const who = a ? a.name + ' — ' : '';
      sa.textContent = emoji + ' ' + who + stripped;
    }
  } catch {}
}

function startOutCard(agentId, task){
  const a = agentMap[agentId]; if (!a) return;
  /* Clear empty state once */
  const empty = outPane.querySelector('.empty'); if (empty) empty.remove();
  const card = document.createElement('div');
  card.className = 'out-card';
  card.style.setProperty('--ag-color', a.color);
  card.innerHTML = '<div class="out-head">'+a.emoji+' '+a.name+' <span class="oh-task">— '+escapeHtml(task||'')+'</span></div><div class="out-body"></div>';
  outPane.appendChild(card);
  outPane.scrollTop = outPane.scrollHeight;
  outCardEls[agentId] = { card: card, body: card.querySelector('.out-body'), raw: '' };
}
function appendOutChunk(agentId, value){
  let c = outCardEls[agentId];
  if (!c) { startOutCard(agentId, ''); c = outCardEls[agentId]; }
  if (!c) return;
  c.raw = (c.raw||'') + value;
  c.body.textContent = c.raw;
  outPane.scrollTop = outPane.scrollHeight;
}
function endOutCard(agentId){ delete outCardEls[agentId]; }

function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
/* 대화록·산출물용 미니 markdown 렌더러. heading(#·##·###), bold(**), italic(_·*),
   inline code(\`\`), blockquote(>), hr(---), list (-·*·1.), 줄바꿈 처리.
   외부 라이브러리 없이 webview 안에서 동작. XSS 방어 위해 escape 먼저.
   ⚠️ 이 함수는 office-panel-html.ts 의 template literal 안에 들어가므로,
   regex/string 안의 backslash escape (\\n, \\s, \\*, \\d, \\.) 는 반드시 이중
   backslash 로 써야 한다. TS 가 template literal 을 처리할 때 단일 \\ 가
   사라져서 regex literal 이 두 줄로 깨지거나 \\s 가 그냥 s 로 바뀌어 정규식
   자체가 잘못된다 (Uncaught SyntaxError: missing /). */
function renderMarkdown(text){
  if (!text) return '';
  let html = escapeHtml(text);
  // code fences (triple backtick blocks) — backtick via \\x60 to avoid template-string clash
  html = html.replace(new RegExp('\\x60\\x60\\x60([\\s\\S]*?)\\x60\\x60\\x60', 'g'), function(_, code){ return '<pre class="md-pre"><code>'+code.replace(/^\\n/,'')+'</code></pre>'; });
  // inline code (single backtick spans)
  html = html.replace(new RegExp('\\x60([^\\x60\\n]+)\\x60', 'g'), '<code class="md-code">$1</code>');
  // headings
  html = html.replace(/^### (.+)$/gm, '<h3 class="md-h3">$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2 class="md-h2">$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1 class="md-h1">$1</h1>');
  // hr
  html = html.replace(/^[-_*]{3,}\\s*$/gm, '<hr class="md-hr">');
  // blockquote — 연속 > 라인을 하나로 묶지 않고 한 줄씩 (간단하게)
  html = html.replace(/^&gt; (.+)$/gm, '<div class="md-quote">$1</div>');
  // bold + italic
  html = html.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[\\s(])_([^_\\n]+)_(?=[\\s).,!?:;]|$)/g, '$1<em>$2</em>');
  // unordered list — - or * 시작 줄들을 <li> 로
  html = html.replace(/(?:^|\\n)([-*] .+(?:\\n[-*] .+)*)/g, (m, block) => {
    const items = block.split(/\\n/).map(l => l.replace(/^[-*] /, '').trim()).filter(Boolean);
    return '\\n<ul class="md-ul">'+items.map(i => '<li>'+i+'</li>').join('')+'</ul>';
  });
  // ordered list
  html = html.replace(/(?:^|\\n)(\\d+\\. .+(?:\\n\\d+\\. .+)*)/g, (m, block) => {
    const items = block.split(/\\n/).map(l => l.replace(/^\\d+\\. /, '').trim()).filter(Boolean);
    return '\\n<ol class="md-ol">'+items.map(i => '<li>'+i+'</li>').join('')+'</ol>';
  });
  // line breaks (남은 일반 줄은 <br>)
  html = html.replace(/\\n{2,}/g, '<div class="md-gap"></div>');
  html = html.replace(/\\n/g, '<br>');
  return html;
}

function drawBeams(taskAgentIds){
  if (!beams || !deskEls.ceo) return;
  beams.innerHTML = '';
  const fr = floor.getBoundingClientRect();
  const ceoR = deskEls.ceo.getBoundingClientRect();
  const cx = ceoR.left + ceoR.width/2 - fr.left;
  const cy = ceoR.top + ceoR.height/2 - fr.top;
  const w = fr.width, h = fr.height;
  beams.setAttribute('viewBox','0 0 '+w+' '+h);
  beams.setAttribute('width', w); beams.setAttribute('height', h);
  taskAgentIds.forEach((id, i) => {
    const desk = deskEls[id]; if (!desk || id==='ceo') return;
    const r = desk.getBoundingClientRect();
    const tx = r.left + r.width/2 - fr.left;
    const ty = r.top + r.height/2 - fr.top;
    const mx = (cx+tx)/2, my = (cy+ty)/2 - 30;
    const path = document.createElementNS('http://www.w3.org/2000/svg','path');
    path.setAttribute('d','M '+cx+' '+cy+' Q '+mx+' '+my+' '+tx+' '+ty);
    path.setAttribute('class','beam');
    const a = agentMap[id];
    if (a) { path.style.stroke = a.color; path.style.filter = 'drop-shadow(0 0 6px '+a.color+')'; }
    path.style.animationDelay = (i*0.08)+'s';
    beams.appendChild(path);
  });
}

function setSending(v){ cmdSend.disabled = v; cmdInput.disabled = v; }
function send(){
  const text = (cmdInput.value || '').trim();
  if (!text) return;
  setSending(true);
  logActivity('👤','ceo','명령: <strong>'+escapeHtml(text)+'</strong>');
  vscode.postMessage({ type: 'officePrompt', value: text });
  cmdInput.value = '';
}
cmdSend.addEventListener('click', send);
cmdInput.addEventListener('keydown', e => { if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); send(); }});
folderBtn.addEventListener('click', () => vscode.postMessage({ type: 'openCompanyFolder' }));
/* Single master switch: walking + chatter + 24h work cycle move together.
   Initial state mirrors the workspace setting agentOs.autoCycleEnabled,
   pushed by the host on officeInit. */
const workdayBtn = document.getElementById('workdayBtn');
let _chatterTimer = null;
/* Initial state UNKNOWN — start neutral, let officeInit's m.workdayOn drive
   the first paint. Initializing to true here was the source of the "OFF
   reverts to ON" bug — the button briefly rendered ON before the saved
   setting arrived from the host. */
let _workdayOn = false;
function startChatterAutofire(){
  if (_chatterTimer) return;
  _chatterTimer = setInterval(() => {
    try { vscode.postMessage({ type: 'runChatter' }); } catch {}
  }, 300000);
}
function stopChatterAutofire(){
  if (_chatterTimer) { clearInterval(_chatterTimer); _chatterTimer = null; }
}
function applyWorkdayState(on, opts){
  _workdayOn = !!on;
  if (workdayBtn) {
    /* 라벨에 더 명확한 행동 결과 텍스트 + on/off 클래스로 시각 구분 강화 */
    workdayBtn.textContent = _workdayOn ? '24시간 자동 운영 ON' : '24시간 자동 운영 OFF';
    workdayBtn.classList.toggle('on', _workdayOn);
    workdayBtn.classList.toggle('off', !_workdayOn);
    workdayBtn.style.color = '';
    workdayBtn.title = _workdayOn
      ? '🟢 ON — 1인 기업 에이전트들이 15분마다 미션을 향해 자동으로 한 스텝씩 일합니다. 자리 비워도, 일반 채팅 모드여도 계속 일해요. 클릭하면 끔.'
      : '⚫ OFF — 자동 사이클 중단. 사용자가 직접 명령할 때만 동작. 클릭하면 다시 켬.';
  }
  if (_workdayOn) {
    try { startAutoWalk(); } catch {}
    startChatterAutofire();
    /* Click-to-enable should give instant feedback; first-time init shouldn't. */
    if (opts && opts.fireImmediate) {
      try { vscode.postMessage({ type: 'runChatter' }); } catch {}
    }
  } else {
    try { stopAutoWalk(); } catch {}
    stopChatterAutofire();
  }
}
workdayBtn && workdayBtn.addEventListener('click', () => {
  const next = !_workdayOn;
  applyWorkdayState(next, { fireImmediate: next });
  vscode.postMessage({ type: 'toggleAutoCycle', on: next });
});
/* New in v2.81 — dashboard launcher inside the office. Replaces the
   sidebar "회사 둘러보기" button that used to live in the now-removed
   approvals/youtube panels. The office is the natural home for it: you
   step out of the floor plan and into the analytics view. */
const dashboardBtn = document.getElementById('dashboardBtn');
if (dashboardBtn) dashboardBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'openDashboard' });
});
const apiBtn = document.getElementById('apiBtn');
if (apiBtn) apiBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'openApiConnections' });
});
/* Side panel toggle + drag-resize.
   - 시작은 collapsed (지도가 화면을 다 차지하도록).
   - 📋 클릭 → collapse 토글 (열 때는 저장된 너비 복원).
   - .side-resizer 드래그 → 너비 실시간 변경 + vscode.setState 로 영구 저장.
   - 너비 범위: 220px ~ 윈도우 너비의 80%. */
const sideEl = document.querySelector('.side');
const toggleSideBtn = document.getElementById('toggleSideBtn');
const sideResizer = document.getElementById('sideResizer');
const SIDE_MIN_W = 220;
const sideMaxW = () => Math.max(SIDE_MIN_W, Math.floor(window.innerWidth * 0.8));
function getSavedSideWidth(){
  try { const s = vscode.getState() || {}; return Number(s.sideWidth) || 0; } catch { return 0; }
}
function saveSideWidth(w){
  try { const s = vscode.getState() || {}; vscode.setState({ ...s, sideWidth: w }); } catch {}
}
function applySideWidth(w){
  if (!sideEl) return;
  const clamped = Math.max(SIDE_MIN_W, Math.min(sideMaxW(), w));
  sideEl.style.width = clamped + 'px';
  return clamped;
}
function showResizer(show){
  if (sideResizer) sideResizer.classList.toggle('hidden', !show);
}
if (sideEl) {
  sideEl.classList.add('collapsed');
  const saved = getSavedSideWidth();
  if (saved >= SIDE_MIN_W) sideEl.style.width = saved + 'px';
}
if (toggleSideBtn && sideEl) {
  toggleSideBtn.addEventListener('click', () => {
    sideEl.classList.add('animated');
    const collapsing = !sideEl.classList.contains('collapsed');
    sideEl.classList.toggle('collapsed', collapsing);
    toggleSideBtn.style.color = collapsing ? '' : 'var(--accent)';
    showResizer(!collapsing);
    setTimeout(() => {
      sideEl.classList.remove('animated');
      try { fitAndScale(); } catch {}
      window.dispatchEvent(new Event('resize'));
    }, 320);
  });
}
if (sideResizer && sideEl) {
  let dragging = false, startX = 0, startW = 0;
  sideResizer.addEventListener('mousedown', (e) => {
    if (sideEl.classList.contains('collapsed')) return;
    dragging = true;
    startX = e.clientX;
    startW = sideEl.offsetWidth;
    sideResizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    /* resizer 가 side 의 LEFT 에 붙어있으니, 왼쪽으로 끌면 side 가 커지고
       오른쪽으로 끌면 작아진다. */
    const delta = startX - e.clientX;
    const newW = applySideWidth(startW + delta);
    if (newW) saveSideWidth(newW);
    try { fitAndScale(); } catch {}
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    sideResizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.dispatchEvent(new Event('resize'));
  });
  /* Double-click resizer to reset to default 300px */
  sideResizer.addEventListener('dblclick', () => {
    if (sideEl.classList.contains('collapsed')) return;
    const w = applySideWidth(300);
    if (w) saveSideWidth(w);
    try { fitAndScale(); } catch {}
  });
}
/* === Connected campus world — Office + Cafe + Garden in one coord space === */
let officeZones = [];           /* [{id,name,emoji,x,y}] world % */
let worldData = null;           /* { worldWidth, worldHeight, buildings, decorations, ... } */
const stageInner = document.getElementById('stageInner');

function renderWorldGrass(){
  const grass = document.getElementById('worldGrass');
  if (!grass || !worldData || !worldData.grassUri) return;
  /* Tile size = (48 / worldWidth) * 100% so each tile maps to one 48-px
     LimeZu tile in world coordinates. With % units, the grass scales with
     stageInner without becoming pixelated mush. */
  const tilePctW = (48 / worldData.worldWidth) * 100;
  const tilePctH = (48 / worldData.worldHeight) * 100;
  grass.style.backgroundImage = 'url(' + worldData.grassUri + ')';
  grass.style.backgroundSize = tilePctW + '% ' + tilePctH + '%';
}

function renderWorldPaths(){
  const wrap = document.getElementById('worldPaths');
  if (!wrap || !worldData) return;
  wrap.innerHTML = '';
  if (!worldData.pathUri || !Array.isArray(worldData.paths)) return;
  const W = worldData.worldWidth, H = worldData.worldHeight;
  /* Path tile is 48px native; render at one tile per 48 world-px. */
  const tilePctW = (48 / W) * 100;
  const tilePctH = (48 / H) * 100;
  worldData.paths.forEach(p => {
    const strip = document.createElement('div');
    strip.className = 'path-strip';
    strip.style.left   = (p.x / W) * 100 + '%';
    strip.style.top    = (p.y / H) * 100 + '%';
    strip.style.width  = (p.w / W) * 100 + '%';
    strip.style.height = (p.h / H) * 100 + '%';
    strip.style.backgroundImage = 'url(' + worldData.pathUri + ')';
    /* Sub-strip background-size needs to express tile size as % of THIS
       strip, not the world. Convert: tile_strip% = world_tilePct / strip_pct. */
    strip.style.backgroundSize =
      (48 / p.w * 100) + '% ' + (48 / p.h * 100) + '%';
    wrap.appendChild(strip);
  });
}

function renderWorldBuildings(){
  const wrap = document.getElementById('worldBuildings');
  if (!wrap || !worldData) return;
  wrap.innerHTML = '';
  const W = worldData.worldWidth, H = worldData.worldHeight;
  worldData.buildings.forEach(b => {
    const leftPct  = (b.x / W) * 100;
    const topPct   = (b.y / H) * 100;
    const widthPct = (b.width / W) * 100;
    const heightPct= (b.height / H) * 100;
    if (b.layer1Uri) {
      const im = document.createElement('img');
      im.src = b.layer1Uri; im.alt = '';
      im.style.left = leftPct + '%';
      im.style.top  = topPct + '%';
      im.style.width = widthPct + '%';
      im.style.height = heightPct + '%';
      im.style.zIndex = '1';
      wrap.appendChild(im);
    }
    if (b.layer2Uri) {
      const im2 = document.createElement('img');
      im2.src = b.layer2Uri; im2.alt = '';
      im2.style.left = leftPct + '%';
      im2.style.top  = topPct + '%';
      im2.style.width = widthPct + '%';
      im2.style.height = heightPct + '%';
      im2.style.zIndex = '2';
      wrap.appendChild(im2);
    }
  });
}

function renderWorldDecorations(){
  const wrap = document.getElementById('worldDecor');
  if (!wrap || !worldData) return;
  wrap.innerHTML = '';
  const W = worldData.worldWidth;
  // Each decoration is 48px native — render at (48/W)*100 % wide so the
  // pixel-art stays consistent regardless of stage size.
  const decorWPct = (48 / W) * 100;
  worldData.decorations.forEach(d => {
    const img = document.createElement('img');
    img.src = d.uri; img.alt = '';
    img.style.left = d.x + '%';
    img.style.top  = d.y + '%';
    img.style.width = (d.w || decorWPct) + '%';
    /* depth-sort: decorations farther down render in front of higher ones */
    img.style.zIndex = String(Math.floor(d.y * 10));
    wrap.appendChild(img);
  });
}

function renderOfficeZones(zones){
  const wrap = document.getElementById('officeZones');
  if (!wrap) return;
  wrap.innerHTML = '';
  (zones || []).forEach(z => {
    const lbl = document.createElement('div');
    lbl.className = 'zone-label';
    lbl.textContent = (z.emoji || '') + ' ' + z.name;
    lbl.style.left = z.x + '%';
    lbl.style.top  = z.y + '%';
    wrap.appendChild(lbl);
  });
}

/* Resize stageInner to the largest world-aspect rect that fits in the
   office-stage container. World aspect comes from worldData (1400/700 = 2.0). */
function fitStage(){
  const stage = document.getElementById('officeStage');
  const inner = document.getElementById('stageInner');
  if (!stage || !inner) return;
  const w = stage.clientWidth, h = stage.clientHeight;
  if (w <= 0 || h <= 0) return;
  const W = (worldData && worldData.worldWidth) || 1400;
  const H = (worldData && worldData.worldHeight) || 700;
  const targetAR = W / H;
  const containerAR = w / h;
  let iw, ih;
  if (containerAR > targetAR) { ih = h; iw = Math.round(h * targetAR); }
  else                         { iw = w; ih = Math.round(w / targetAR); }
  inner.style.width  = iw + 'px';
  inner.style.height = ih + 'px';
}

/* Scale character sprites to MATCH the world's display scale.
   World is rendered at world-px → stage-px ratio. Characters should scale
   the same so they look proportional to the cubicles/furniture baked into
   the bg images. A small bump (×1.05) so name plates stay readable. */
function updateCharScale(){
  const inner = document.getElementById('stageInner');
  if (!inner) return;
  const worldW = (worldData && worldData.worldWidth) || 1400;
  const worldScale = inner.clientWidth / worldW;
  const scale = Math.max(0.35, Math.min(1.6, worldScale * 1.05));
  inner.style.setProperty('--char-scale', scale.toFixed(2));
}

function fitAndScale(){ fitStage(); updateCharScale(); repositionAllAgents(); }

/* The old 자율(walking) and 자율 대화(chatter) buttons are unified into the
   single 🌞 24시간 업무 toggle above. The startAutoWalk()/stopAutoWalk() and
   chatter-autofire functions are still called from there. */
/* Re-fit stage + rescale characters + reposition agents on panel resize */
window.addEventListener('resize', fitAndScale);
document.querySelectorAll('.side-tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.side-tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.side-pane').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById(t.dataset.pane).classList.add('active');
    if (t.dataset.pane === 'convPane') {
      vscode.postMessage({ type: 'loadConversations' });
    }
  });
});
document.getElementById('reloadConvBtn')?.addEventListener('click', () => {
  vscode.postMessage({ type: 'loadConversations' });
});

window.addEventListener('message', e => {
  const m = e.data;
  switch (m.type) {
    case 'officeInit': {
      agents = m.agents || [];
      agentMap = {}; deskEls = {};
      agents.forEach(a => { agentMap[a.id] = a; });
      topCompany.textContent = m.companyName || '1인 기업';
      /* Drop the 'loading' style class once the real name arrives so the
         brand text picks up the bold heading style. */
      topCompany.classList.remove('loading');
      /* Working count in the HUD reflects the actual roster size. */
      const wEl = document.getElementById('hudWorking');
      if (wEl) wEl.textContent = '0/' + (agents.length || 0);
      /* Status row initial text. */
      const sa = document.getElementById('statusActivity');
      if (sa) sa.textContent = agents.length + '명 자리 잡음 · 명령 대기 중';
      /* Connected campus: world canvas with multiple buildings + decorations.
         Agents share the world coord space (% of stageInner = % of world). */
      worldData = m.world || null;
      if (worldData && worldData.desks) {
        HOME_POS = Object.assign({}, HOME_POS, worldData.desks);
      }
      officeZones = (worldData && Array.isArray(worldData.zones)) ? worldData.zones : [];
      document.body.classList.add('floorplan');
      try {
        const dbg = (m.debug || {});
        console.log('[Agent OS] world init — buildings:', dbg.buildingsLoaded, '/ decor:', dbg.decorationsLoaded, '/ custom map:', dbg.customMap||'none');
        const customNote = (dbg.customMap === 'OK') ? ' · 🎨 커스텀 맵 사용' : '';
        logActivity('🛠','ceo','캠퍼스 v2.28: '+(dbg.buildingsLoaded||0)+'동 + '+(dbg.decorationsLoaded||0)+' 장식'+customNote);
      } catch {}
      /* Custom map: a user-supplied full-stage PNG overrides procedural world */
      const customMapUri = m.customMapUri || '';
      const stageEl = document.getElementById('stageInner');
      if (customMapUri) {
        if (stageEl) {
          stageEl.style.backgroundImage = 'url(' + customMapUri + ')';
          stageEl.style.backgroundSize = '100% 100%';
          stageEl.style.backgroundPosition = 'center center';
          stageEl.style.backgroundRepeat = 'no-repeat';
        }
        /* Suppress procedural world layers when custom map is used */
        ['worldGrass','worldPaths','worldBuildings','worldDecorations'].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.innerHTML = '';
        });
      } else {
        if (stageEl) stageEl.style.backgroundImage = '';
        renderWorldGrass();
        renderWorldPaths();
        renderWorldBuildings();
        renderWorldDecorations();
      }
      renderOfficeZones(officeZones);
      /* Render agents inside stageInner — % coords map onto the world canvas */
      const stage = document.getElementById('stageInner');
      if (stage) stage.querySelectorAll('.agent').forEach(d => d.remove());
      agents.forEach(a => {
        const d = makeAgent(a);
        if (stage) stage.appendChild(d);
        deskEls[a.id] = d;
      });
      fitAndScale();
      /* Re-fit once any building image has loaded so layout settles */
      const firstBld = stage && stage.querySelector('.world-buildings img');
      if (firstBld) { firstBld.addEventListener('load', fitAndScale, { once: true }); }
      setTimeout(fitAndScale, 60);
      setTimeout(fitAndScale, 350);
      
      /* Sprite animation loop — LimeZu Premade_Character_48x48 (cell = 48×96).
         Row 1 (y=96)  = idle / standing.  Cycles 6 frames per direction even when idle (subtle breathing).
         Row 2 (y=192) = walking / typing motion.  6 frames per direction.
         Direction columns: down=0, left=6, right=12, up=18 (each 6 frames). */
      let frameCount = 0;
      const TILE = 48;
      const CHAR_HEIGHT = TILE * 2;  /* = 96 — correct cell height */
      const animateSprites = () => {
        frameCount++;
        agents.forEach(a => {
          const el = deskEls[a.id]; if (!el) return;
          const characterEl = el.querySelector('.character'); if (!characterEl) return;
          /* photo-sprite 는 atlas 가 아니라 단일 이미지 — frame shift skip. CSS bob 만 적용됨. */
          if (characterEl.classList.contains('photo-sprite')) return;

          let colOffset = 0;
          switch (el.dataset.dir) {
            case 'down':  colOffset = 0;  break;
            case 'left':  colOffset = 6;  break;
            case 'right': colOffset = 12; break;
            case 'up':    colOffset = 18; break;
          }

          let row = 1;  /* idle */
          if (el.classList.contains('walking')) row = 2;
          else if (el.classList.contains('working') || el.classList.contains('thinking')) row = 2;

          /* Animate slower when idle, faster when walking/working */
          const speed = (row === 2) ? 8 : 14;
          const frameIndex = Math.floor(frameCount / speed) % 6;
          const col = colOffset + frameIndex;

          characterEl.style.backgroundPosition = '-' + (col * TILE) + 'px -' + (row * CHAR_HEIGHT) + 'px';
        });
        requestAnimationFrame(animateSprites);
      };
      animateSprites();

      /* reposition once layout settles */
      setTimeout(repositionAllAgents, 100);
      setTimeout(repositionAllAgents, 600);
      /* spawn ambient particles */
      spawnParticles();
      /* start HUD ticker (DAY / TIME / WORKING) */
      startHud();
      /* Apply the workday master state IMMEDIATELY so the button reflects the
         saved setting on first paint. The 6s delay used to be here so the
         office could "settle" before chatter/walking, but it caused a real
         UX bug: the button would render "ON" for 6 seconds even when the user
         had it OFF (because _workdayOn defaults to true at module init).
         Users read that flash as "it turned back on by itself".
         The walking + chatter auto-fire is internally throttled, so applying
         the state immediately is safe.
         Fallback to 'true' only when the host genuinely didn't send a value. */
      const initialWorkdayOn = (typeof m.workdayOn === 'boolean') ? m.workdayOn : true;
      applyWorkdayState(initialWorkdayOn, { fireImmediate: false });
      setTimeout(() => { agents.forEach(a => { showStatusIcon(a.id, '☕', 2500); }); }, 1200);
      logActivity('🏢','ceo','사무실 가동. 에이전트 '+agents.length+'명 자리 잡음.');
      logActivity('🌅','ceo','오늘 하루 시작.');
      break;
    }
    case 'agentDispatch': {
      currentTasks = m.tasks || [];
      const ids = ['ceo'].concat(currentTasks.map(t => t.agent));
      whiteboard.classList.add('active');
      whiteboard.innerHTML = '<span class="wb-line">📋 '+escapeHtml(m.brief||'')+'</span>';
      currentTasks.forEach(t => setDeskState(t.agent, 'thinking', t.task));
      document.body.classList.add('dispatching');
      setTimeout(() => drawBeams(ids), 50);
      setTimeout(() => { document.body.classList.remove('dispatching'); beams.innerHTML=''; }, 1700);
      logActivity('🧭','ceo','<strong>분배:</strong> '+escapeHtml(m.brief||''));
      currentTasks.forEach(t => {
        const a = agentMap[t.agent];
        if (a) logActivity(a.emoji, t.agent, '<strong>'+a.name+'</strong> ← '+escapeHtml(t.task));
      });
      /* 캐릭터들이 회의실로 모이는 시네마틱 */
      const taskIdsOnly = currentTasks.map(t => t.agent);
      const ceoP = HOME_POS.ceo;
      taskIdsOnly.forEach((id, i) => {
        setTimeout(() => {
          const offX = ((i % 4) - 1.5) * 7;
          const offY = (Math.floor(i / 4)) * 6 + 8;
          walkToward(id, ceoP.x + offX, ceoP.y + offY, 1100);
        }, i * 90);
      });
      setTimeout(() => {
        taskIdsOnly.forEach(id => {
          const el = deskEls[id]; if (!el) return;
          const hx = parseFloat(el.dataset.homeX), hy = parseFloat(el.dataset.homeY);
          walkToward(id, hx, hy, 1100);
        });
      }, 2200);
      break;
    }
    case 'agentStart': {
      setDeskState(m.agent, 'working', m.task);
      const persona = PERSONALITY[m.agent] || { status:['⚡'] };
      showStatusIcon(m.agent, pickRandom(persona.status), 4500);
      if (m.agent !== 'ceo') {
        startOutCard(m.agent, m.task||'');
        const a = agentMap[m.agent];
        if (a) logActivity(a.emoji, m.agent, a.name+' 작업 시작');
      } else {
        const txt = m.task || 'CEO 작업';
        logActivity('🧭','ceo','<strong>CEO</strong> '+escapeHtml(txt));
      }
      break;
    }
    case 'agentChunk': {
      appendOutChunk(m.agent, m.value || '');
      break;
    }
    case 'multiDispatch': {
      /* v2.89.150 — 디자인 폭발 시네마틱:
         (0) 화면 가운데 "📋 DISPATCH" 거대 배너 (글리치)
         (1) CEO 책상 폭발적 펄스 + 화이트보드 활성화
         (2) specialist walk → CEO 회의실
         (3) cyan + violet 광선 + 꼬리 황금 점
         (4) 도착 파티클 폭발
         (5) chatter
         (6) 복귀 walk + working */
      try {
        const tasks = Array.isArray(m.tasks) ? m.tasks : [];
        if (tasks.length === 0) break;
        const ids = tasks.map(t => t.agent);
        /* 0. 화면 중앙 글리치 배너 */
        try { spawnDispatchBanner(String(m.brief || '작업 분배')); } catch {}
        /* 1. CEO 펄스 + 화이트보드 */
        try { setDeskState('ceo', 'thinking'); } catch {}
        try { showStatusIcon('ceo', '📋', 4500); } catch {}
        try { showThought('ceo', String(m.brief || '작업 분배 중...').slice(0, 50), 6000); } catch {}
        try {
          if (typeof whiteboard !== 'undefined' && whiteboard) {
            whiteboard.classList.add('active');
            whiteboard.innerHTML = '<span class="wb-line">📋 ' + escapeHtml(m.brief || '종합 분석') + '</span>';
            setTimeout(() => { try { whiteboard.classList.remove('active'); } catch {} }, 9000);
          }
        } catch {}
        try { document.body.classList.add('dispatching'); } catch {}
        /* 2. 캐릭터들이 CEO 책상 주변으로 walk */
        const ceoP = (typeof HOME_POS !== 'undefined' && HOME_POS.ceo) ? HOME_POS.ceo : { x: 50, y: 50 };
        ids.forEach((id, i) => {
          setTimeout(() => {
            try { setDeskState(id, 'thinking'); } catch {}
            const offX = ((i % 4) - 1.5) * 8;
            const offY = (Math.floor(i / 4)) * 7 + 10;
            try { walkToward(id, ceoP.x + offX, ceoP.y + offY, 1300); } catch {}
          }, 100 + i * 180);
        });
        /* 3. cyan 광선 + 황금 점 (walk 시작 후 약간 늦게) */
        tasks.forEach((t, i) => {
          setTimeout(() => {
            try { spawnDispatchBeam('ceo', t.agent); } catch {}
            try { showStatusIcon(t.agent, t.emoji || '🎯', 5000); } catch {}
            try {
              const short = (t.task || '').replace(/^\[지시\][\s\S]*/, '').trim().slice(0, 35);
              showThought(t.agent, short || (t.name + ' 받음!'), 6000);
            } catch {}
            try {
              if (typeof logActivity === 'function') {
                logActivity('🎯', t.agent, (t.emoji || '🤖') + ' ' + t.name + ' ← CEO task: ' + (t.task || '').slice(0, 60));
              }
            } catch {}
          }, 1400 + i * 350);
        });
        /* 4. 회의 중 chatter — 회의실에 모인 동안 한 마디씩 */
        setTimeout(() => {
          ids.forEach((id, i) => {
            setTimeout(() => {
              const chat = ['알겠습니다!', '바로 시작', '데이터 확인', '잠시만요...', '🚀 ON IT'];
              try { showThought(id, chat[i % chat.length], 2500); } catch {}
            }, i * 400);
          });
        }, 2200);
        /* 5. 3.2초 후 자기 자리로 복귀 + working 시작 */
        setTimeout(() => {
          try { document.body.classList.remove('dispatching'); } catch {}
          /* 회의 종료 배너 — 모든 specialist 가 자기 자리로 복귀하는 순간 */
          try { spawnMeetingEndBanner(); } catch {}
          ids.forEach((id, i) => {
            setTimeout(() => {
              try {
                const el = deskEls[id];
                if (el) {
                  const hx = parseFloat(el.dataset.homeX);
                  const hy = parseFloat(el.dataset.homeY);
                  walkToward(id, hx, hy, 1100);
                  setTimeout(() => {
                    try { setDeskState(id, 'working'); } catch {}
                    /* 책상 도착 시 작은 펄스 */
                    try { showStatusIcon(id, '⚡', 2500); } catch {}
                  }, 1150);
                }
              } catch {}
            }, i * 150);
          });
          /* CEO 도 'working' 으로 (종합 보고서 작성 중) */
          setTimeout(() => {
            try { setDeskState('ceo', 'working'); } catch {}
            try { showThought('ceo', '📝 종합 보고서 작성', 6000); } catch {}
            try { showStatusIcon('ceo', '✍️', 4000); } catch {}
          }, 800);
        }, 3200);
      } catch { /* office view 미연결 — silent */ }
      break;
    }
    case 'agentBusy': {
      /* v2.89.131 — LLM 호출 대기 중 5초마다 들어오는 신호. 작업 중인 에이전트의
         책상을 'working' 상태로 유지 + 페르소나 thought·status 반복 노출.
         v2.89.157 — 게임식 효과: 매 tick 마다 sparkle 입자 5개 spawn + 작업 막대 진행 + 풍부한 thought. */
      try {
        const a = agentMap[m.agent];
        if (!a) break;
        setDeskState(m.agent, 'working');
        const p = (typeof PERSONALITY !== 'undefined') ? PERSONALITY[m.agent] : null;
        const elapsed = Number(m.elapsedSec || 0);
        if (p) {
          /* thought 노출 빈도 ↑ — 매 tick 마다 (5초마다) 새로운 페르소나 멘트 */
          if (Array.isArray(p.thoughts) && p.thoughts.length > 0) {
            const t = p.thoughts[Math.floor(Math.random() * p.thoughts.length)];
            try { showThought(m.agent, t, 5500); } catch {}
          }
          if (Array.isArray(p.status) && p.status.length > 0) {
            const s = p.status[Math.floor(Math.random() * p.status.length)];
            try { showStatusIcon(m.agent, s, 4500); } catch {}
          }
        }
        /* v2.89.157 — sparkle 입자 5개 spawn. 머리 위에서 무작위 방향으로 흩날림.
           "백엔드에서 일하고 있다"는 visual heartbeat — 정지처럼 보이지 않게. */
        try {
          const desk = deskEls[m.agent];
          if (desk) {
            const color = a.color || '#38BDF8';
            for (let k = 0; k < 5; k++) {
              const sp = document.createElement('div');
              sp.className = 'spark';
              sp.style.setProperty('--spark-c', color);
              /* 머리 위 ~(top:5px) 부근에서 발생, 위로 ±18px 좌우, 위로 -42 ~ -64px */
              sp.style.left = (24 + (Math.random() - 0.5) * 8) + 'px';
              sp.style.top = (4 + Math.random() * 6) + 'px';
              sp.style.setProperty('--sx', ((Math.random() - 0.5) * 36).toFixed(0) + 'px');
              sp.style.setProperty('--sy', (-42 - Math.random() * 22).toFixed(0) + 'px');
              sp.style.animationDelay = (k * 60) + 'ms';
              desk.appendChild(sp);
              setTimeout(() => { try { sp.remove(); } catch {} }, 1500 + k * 60);
            }
          }
        } catch {}
        /* 5초마다 elapsed 이모지 status — 사용자가 "지금 N초째 작업 중" 한눈에 인식 */
        try {
          if (elapsed > 0 && elapsed % 5 === 0) {
            const icon = elapsed >= 60 ? '⏰' : (elapsed >= 30 ? '⏳' : '🔄');
            showStatusIcon(m.agent, icon, 2500);
          }
        } catch {}
      } catch { /* office view 안 떠있어도 ignore */ }
      break;
    }
    case 'agentEnd': {
      setDeskState(m.agent, 'done');
      endOutCard(m.agent);
      const a = agentMap[m.agent];
      if (a) logActivity('✅', m.agent, a.name+' 완료');
      showStatusIcon(m.agent, '✨', 2000);
      bumpOutput();
      break;
    }
    case 'agentPulse': {
      /* External pulse trigger — used by YouTube tool runs / approval gate
         drops. Lights up the named agent's desk briefly so the office shows
         the AI company is alive even when no chat dispatch is happening. */
      try {
        if (m.agent) {
          showStatusIcon(m.agent, m.icon || '✨', m.ms || 3000);
          if (m.deskState) setDeskState(m.agent, m.deskState);
          if (m.log) logActivity(m.icon || '🔔', m.agent, m.log);
        }
      } catch {}
      break;
    }
    case 'corporateReport': {
      whiteboard.classList.add('active');
      whiteboard.innerHTML = '<span class="wb-line">📝 '+escapeHtml((m.brief||'').slice(0,80))+'</span>';
      const block = document.createElement('div'); block.className = 'report-block';
      block.innerHTML = '<div class="rb-head">📝 CEO 종합 보고서</div>'+escapeHtml(m.report||'');
      outPane.appendChild(block);
      outPane.scrollTop = outPane.scrollHeight;
      logActivity('📝','ceo','<strong>종합 보고서 발표</strong> · '+escapeHtml(m.sessionPath||''));
      /* switch to outputs tab */
      document.querySelectorAll('.side-tab').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.side-pane').forEach(x => x.classList.remove('active'));
      document.querySelector('.side-tab[data-pane="outPane"]').classList.add('active');
      outPane.classList.add('active');
      setSending(false);
      setTimeout(() => Object.keys(deskEls).forEach(id => setDeskState(id, 'idle')), 2500);
      break;
    }
    case 'telegramSent': {
      logActivity('📱','secretary','<strong>Secretary</strong> 텔레그램으로 보고 전송');
      break;
    }
    case 'agentConfig': {
      if (m.agent !== _profileAgentId) break;
      renderConfigForm(m.agent, m.values || {});
      break;
    }
    case 'agentConfigSaved': {
      const status = document.getElementById('amdSaveStatus');
      if (!status) break;
      status.className = 'amd-save-status show ' + (m.error ? 'error' : 'success');
      status.textContent = m.error ? ('⚠️ ' + m.error) : '✅ 저장됨 · _agents/' + m.agent + '/connections.md';
      setTimeout(() => { status.classList.remove('show'); }, 2800);
      break;
    }
    case 'agentProfile': {
      if (m.agent !== _profileAgentId) break;  /* user closed or switched */
      const memEl = document.getElementById('amdMemory');
      const decEl = document.getElementById('amdDecisions');
      const sessEl = document.getElementById('amdSessions');
      const listEl = document.getElementById('amdSessionList');
      if (m.error) {
        if (memEl) memEl.textContent = '⚠️ ' + m.error;
        break;
      }
      /* Swap the avatar emoji square for a real photo when one is provided
         (프로필 이미지 제공 에이전트). The .has-photo class kills the gradient background and
         lets the image cover the avatar tile fully. */
      try {
        const emo = document.getElementById('amdEmoji');
        if (emo) {
          if (m.profileImageUri) {
            emo.classList.add('has-photo');
            emo.innerHTML = '<img class="amd-photo" src="'+m.profileImageUri+'" alt="">';
          } else {
            emo.classList.remove('has-photo');
            const a = agentMap[m.agent];
            emo.textContent = a ? a.emoji : '';
          }
        }
      } catch {}
      if (memEl) memEl.textContent = m.memory || '_없음_';
      if (decEl) decEl.textContent = m.decisions || '_없음_';
      if (sessEl) sessEl.textContent = m.sessionCount || 0;
      if (listEl) {
        listEl.innerHTML = '';
        (m.recentSessions || []).forEach(s => {
          const d = document.createElement('div'); d.className='amd-sess'; d.textContent = '· '+s;
          listEl.appendChild(d);
        });
        if ((m.recentSessions || []).length === 0) listEl.textContent = '_세션 기록 없음_';
      }
      break;
    }
    case 'companyFolderChanged': {
      logActivity('📁','ceo','회사 폴더 변경됨 → '+escapeHtml(m.dir||''));
      break;
    }
    case 'conversationsLoaded': {
      const dateEl = document.getElementById('convDate');
      const bodyEl = document.getElementById('convBody');
      if (dateEl) dateEl.textContent = m.date ? '📅 ' + m.date : '';
      if (bodyEl) bodyEl.innerHTML = renderMarkdown(m.content || '');
      /* Auto-scroll to latest entry at the bottom */
      const pane = document.getElementById('convPane');
      if (pane) pane.scrollTop = pane.scrollHeight;
      break;
    }
    case 'brainRead': {
      pulseBrain(m.agent, m.reason || '');
      break;
    }
    case 'agentConfer': {
      const turns = m.turns || [];
      logActivity('💬','ceo','<strong>자율 회의</strong> ('+turns.length+'턴)');
      /* 자동 walk: 화자가 청자 옆으로 걸어가서 말 → 다시 자기 자리로 */
      let chain = Promise.resolve();
      turns.forEach((t) => {
        chain = chain.then(async () => {
          const fa = agentMap[t.from], ta = agentMap[t.to];
          const fEl = deskEls[t.from], tEl = deskEls[t.to];
          if (!fa || !ta || !fEl || !tEl) return;
          const bx = parseFloat(tEl.dataset.homeX), by = parseFloat(tEl.dataset.homeY);
          const ax = parseFloat(fEl.dataset.homeX);
          const offX = (ax > bx ? 7 : -7);
          await walkToward(t.from, bx + offX, by, 950);
          showBubbleOn(t.from, t.text, 1700);
          logActivity(fa.emoji, t.from, '<strong>'+fa.name+'</strong> → '+ta.emoji+' '+ta.name+': '+escapeHtml(t.text));
          await new Promise(r => setTimeout(r, 1500));
          const hx = parseFloat(fEl.dataset.homeX), hy = parseFloat(fEl.dataset.homeY);
          await walkToward(t.from, hx, hy, 950);
        });
      });
      break;
    }
    case 'decisionsLearned': {
      const decs = m.decisions || [];
      if (decs.length === 0) break;
      logActivity('🧠','ceo','<strong>자가학습</strong> '+decs.length+'개 결정 누적 (decisions.md)');
      const empty = outPane.querySelector('.empty'); if (empty) empty.remove();
      const block = document.createElement('div'); block.className = 'report-block';
      block.style.borderColor = 'rgba(167,139,250,.4)';
      block.style.boxShadow = '0 0 14px rgba(167,139,250,.15)';
      block.innerHTML = '<div class="rb-head" style="color:#A78BFA">🧠 자가학습 · decisions.md</div>'+decs.map(d => '• '+escapeHtml(d)).join('<br>');
      outPane.appendChild(block);
      outPane.scrollTop = outPane.scrollHeight;
      break;
    }
    case 'error': {
      logActivity('⚠️','ceo','<strong>오류:</strong> '+escapeHtml(m.value||''));
      setSending(false);
      break;
    }
  }
});

/* ============================================================
   v2.89.143 — Floating Revenue Command Center (사무실 우상단 HUD)
============================================================ */
(function setupFloatingRevenue() {
  const FR = document.getElementById('floatingRevenue');
  const REOPEN = document.getElementById('frReopen');
  const HUD_STAT = document.getElementById('hudRevenueStat');
  const $$ = (id) => document.getElementById(id);

  function frClose() {
    if (!FR) return;
    FR.classList.add('hidden');
    if (REOPEN) REOPEN.classList.add('show');
  }
  function frOpen() {
    if (!FR) return;
    FR.classList.remove('hidden');
    if (REOPEN) REOPEN.classList.remove('show');
    requestRevenueMini();
  }
  function requestRevenueMini() {
    vscode.postMessage({ type: 'requestRevenueMini' });
  }
  $$('frClose')?.addEventListener('click', frClose);
  REOPEN?.addEventListener('click', frOpen);
  HUD_STAT?.addEventListener('click', frOpen);
  /* v2.92 — 헤더 매출 버튼. 클릭하면 카드 토글. */
  $$('revenueBtn')?.addEventListener('click', () => {
    if (!FR) return;
    if (FR.classList.contains('hidden')) frOpen();
    else frClose();
  });
  $$('frOpenDashboard')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'openRevenueDashboard' });
  });
  $$('frAskBezos')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'askBezosRevenue' });
  });

  function _fmt(v) {
    if (v == null) return '—';
    const n = Number(v);
    if (n === 0) return '0';
    const abs = Math.abs(n);
    if (abs >= 1000) return (n/1000).toFixed(1) + 'K';
    return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }
  function _animate(el, target, formatter) {
    if (!el) return;
    const t0 = performance.now(), dur = 900;
    const startVal = parseFloat(el.dataset.last || '0') || 0;
    function tick(now) {
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      const v = startVal + (target - startVal) * eased;
      el.textContent = formatter ? formatter(v) : Math.round(v).toLocaleString();
      if (p < 1) requestAnimationFrame(tick);
      else el.dataset.last = String(target);
    }
    requestAnimationFrame(tick);
  }
  function _renderSpark(byDay, cur) {
    const svg = $$('frSparkSvg');
    if (!svg) return;
    const days = [];
    const today = new Date();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const day = byDay[key];
      days.push(day && day[cur] ? day[cur].gross : 0);
    }
    const maxV = Math.max(...days, 1);
    const W = 240, H = 36;
    const xOf = (i) => (i / (days.length - 1)) * W;
    const yOf = (v) => 4 + (28) - (v / maxV) * 28;
    const pts = days.map((v, i) => xOf(i).toFixed(1) + ',' + yOf(v).toFixed(1)).join(' ');
    const areaPts = '0,' + (4 + 28) + ' ' + pts + ' ' + W + ',' + (4 + 28);
    const peakIdx = days.reduce((acc, v, i) => v > days[acc] ? i : acc, 0);
    const peakDot = days[peakIdx] > 0
      ? '<circle class="peak" cx="' + xOf(peakIdx).toFixed(1) + '" cy="' + yOf(days[peakIdx]).toFixed(1) + '" r="2.5"></circle>'
      : '';
    svg.innerHTML =
      '<defs><linearGradient id="frSparkGrad" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#22d3ee" stop-opacity="0.4"/>' +
      '<stop offset="100%" stop-color="#22d3ee" stop-opacity="0"/></linearGradient></defs>' +
      '<polygon class="area" points="' + areaPts + '"></polygon>' +
      '<polyline class="line" points="' + pts + '"></polyline>' + peakDot;
  }
  function renderRev(data) {
    if (data?.error) {
      $$('frSub').textContent = '⚠️ ' + (data.error || '연결 확인 필요');
      return;
    }
    if (!data || !data.totals) {
      $$('frSub').textContent = '💡 외부 연결 패널 → PayPal 입력';
      return;
    }
    const totals = data.totals;
    const period = totals.by_period || {};
    const byCur = totals.by_currency || {};
    const primaryCur = Object.entries(byCur).sort((a,b) => (b[1].gross||0)-(a[1].gross||0))[0]?.[0] || 'USD';
    const cur = byCur[primaryCur] || { gross: 0, count: 0 };
    const fmt = (v) => primaryCur === 'USD' ? '$' + _fmt(v) : _fmt(v) + ' ' + primaryCur;
    _animate($$('frMonth'), period.month || 0, fmt);
    _animate($$('frWeek'), period.week || 0, fmt);
    _animate($$('frCount'), cur.count || 0);
    // HUD stat
    const hudEl = $$('hudRevenue');
    if (hudEl) hudEl.textContent = fmt(period.month || 0);
    _renderSpark(data.by_day || {}, primaryCur);
    $$('frSub').textContent = cur.count + '건 · 실시간 분석';
  }
  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'revenueMini') renderRev(m.data);
  });
  // 초기 + 60초마다 새로고침
  requestRevenueMini();
  setInterval(requestRevenueMini, 60000);
})();

vscode.postMessage({ type: 'officeReady' });
</script>
</body>
</html>`;
}
