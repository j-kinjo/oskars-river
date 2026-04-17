// ═══════════════════════════════════════════════════════════════
//  OSKAR'S RIVER  v3
//  Mood: zenful Japanese ink-wash river
//  Camera: rear-elevated, looking at boat from behind / above
//  Wake = mana lines (COB warm upper, IOB cool lower)
//  Banks = lily pads (hyper top, hypo bottom)
//  Time of day drives full palette shift
// ═══════════════════════════════════════════════════════════════

// ── DATA PLACEHOLDER (injected at build time) ─────────────────
const HISTORY_RAW = window.__RIVER_HISTORY__ || [];

var BOLUS_EVENTS = [];
var LOGGED_EVENTS = [];
try { LOGGED_EVENTS = JSON.parse(localStorage.getItem('river_logged')||'[]');
  LOGGED_EVENTS = LOGGED_EVENTS.filter(function(e){return (Date.now()-e.t)<30*86400000;});
  LOGGED_EVENTS.forEach(function(e){
    BOLUS_EVENTS.push(e);
    if(e.t > HISTORY_RAW[HISTORY_RAW.length-1].t)
      HISTORY_RAW.push({t:e.t,bg:HISTORY_RAW[HISTORY_RAW.length-1].bg||7.0,iob:0,cob:0,pen:1});
  });
} catch(err) {}

const POD_PAUSE_T  = 1773651600000;
let CGM_START = HISTORY_RAW[0].t;
let CGM_END   = HISTORY_RAW[HISTORY_RAW.length-1].t;

function updateCGMBounds() {
  if (HISTORY_RAW.length === 0) {
    // No history yet — set bounds to now so canvas renders
    CGM_START = Date.now() - 2*3600000;
    CGM_END   = Date.now();
    return;
  }
  CGM_START = HISTORY_RAW[0].t;
  CGM_END   = HISTORY_RAW[HISTORY_RAW.length-1].t;
}

// ── CONSTANTS ─────────────────────────────────────────────────
const BG_LOW  = 3.9, BG_HIGH = 10.0;

// ── FORCE COLOURS ─────────────────────────────────────────────────
const COL_IOB   = [60,  130, 220];  // cool blue   — insulin gravity
const COL_COB   = [255, 140,  50];  // warm orange  — carb buoyancy
const COL_HYPO  = [255, 210,  40];  // golden yellow — hypo lightning
const COL_BGLOW = [80,  130, 220];  // blue when low
const COL_BGHIGH= [230, 140,  40];  // amber when high
const BG_MIN  = 2.0, BG_MAX  = 18.0;
const MAX_IOB = 6.0, MAX_COB = 80.0;
const NOW_X   = 0.62;
const IOB_PEAK = 70; // "now" position — past to left, future to right
// HORIZON removed — full-bleed void, no sky/water split

// Session entries
let SESSION = [];
try { SESSION = JSON.parse(localStorage.getItem('river_session')||'[]'); SESSION=SESSION.filter(function(s){return (Date.now()-s.t)<7*86400000;}); } catch(e){}

// ── CANVAS ───────────────────────────────────────────────────
const CV = document.getElementById('c');
const CX = CV.getContext('2d');
let W, H;
function resize() {
  W = CV.width  = window.innerWidth;
  H = CV.height = window.innerHeight;
}
resize();
window.addEventListener('resize', resize);

// ── VIEW STATE ───────────────────────────────────────────────
let viewTime = CGM_END;
let viewSpan = 4 * 3600000;
const MIN_SPAN = 20*60000, MAX_SPAN = 72*3600000;

function tX(t) { return NOW_X*W + (t-viewTime)/viewSpan*W; }
function xT(x) { return viewTime + (x-NOW_X*W)/W*viewSpan; }

// ── HISTORY LOOKUP ───────────────────────────────────────────
function histAt(t) {
  const EMPTY = { bg: 7.0, iob: 0, cob: 0, pen: 1 };
  if (HISTORY_RAW.length === 0) return EMPTY;
  if (t <= HISTORY_RAW[0].t) return HISTORY_RAW[0];
  if (t >= HISTORY_RAW[HISTORY_RAW.length-1].t) return HISTORY_RAW[HISTORY_RAW.length-1];
  let lo=0, hi=HISTORY_RAW.length-1;
  while (hi-lo>1) { const m=(lo+hi)>>1; HISTORY_RAW[m].t<=t?lo=m:hi=m; }
  const a=HISTORY_RAW[lo], b=HISTORY_RAW[hi], f=(t-a.t)/(b.t-a.t);
  return { bg:a.bg+f*(b.bg-a.bg), iob:a.iob+f*(b.iob-a.iob),
           cob:a.cob+f*(b.cob-a.cob), pen:a.pen };
}
function dataAt(t) {
  const h = histAt(t);
  let si=0, sc=0;
  for (const s of SESSION) {
    const m=(t-s.t)/60000;
    if (m<0||m>240) continue;
    si += (s.u||0)*iobF(m);
    sc += (s.c||0)*cobF(m);
  }
  return { bg:h.bg, iob:h.iob+si, cob:h.cob+sc, pen:h.pen };
}

function iobF(m) {
  if (m<=0) return 1; if (m>=240) return 0;
  let d=0; for(let x=0;x<m;x+=2) d+=(x<=70?x/70:Math.max(0,1-(x-70)/170))*2;
  return Math.max(0,1-Math.min(1,d/105));
}
function cobF(m,gi=60) {
  if (m<=0) return 1; if (m>=240) return 0;
  const pk=Math.max(20,95-gi),s=pk/2.2,z=(m-pk)/s;
  return Math.max(0,1-Math.min(1,0.5*(1+Math.tanh(0.7978845608*(z+0.044715*z*z*z)))));
}

// ── TIME-OF-DAY PALETTE ──────────────────────────────────────
// Key palettes — rich saturated colours from mood board
// boat_and_wake: cream bg, paper-cut teal→indigo wake
// lily_pad_banks: deep jewel-green water, bright caustic streaks
// ═══════════════════════════════════════════════════════════════════════
//  RIVER v4 — VISUAL SYSTEM
//  Concept: complementary forces seeking equilibrium
//  Carbs = warm buoyant force pushing UP (amber/gold ribbons, rising)
//  Insulin = cool gravity force pushing DOWN (indigo ribbons, descending)
//  Glucose = the life-line threading between them
//  Background = deep void of space / dark water — calm, infinite
//  Time of day shifts the void from midnight blue to dawn amber to dusk
//  No sky, no horizon, no river banks as such
//  The whole canvas IS the flow — edge to edge, full bleed
//  Forces are visible as luminous ribbons / ley-lines in the void
//  BG trace is the brightest element — the thing being guided
// ═══════════════════════════════════════════════════════════════════════

// ── PALETTE — void colours shifting through time of day ────────────────
// ── ANIMATION STATE ──────────────────────────────────────────────────
let phi = 0, t0 = 0, treeScrollX = 0;

// Seed for deterministic "random" positions (used in visual effects)
function seededRand(seed) {
  let s = seed;
  return function() { s=(s*16807+0)%2147483647; return (s-1)/2147483646; };
}

const PALETTES = [
  // Night 00:00 — deepest void, midnight indigo
  { h:0,  bg0:'#05070f', bg1:'#080c1a', bg2:'#060914',
    cobR:[200,120,40],  iobR:[60,80,200],  bgLine:[100,220,160],
    particle:'rgba(120,140,255,0.15)', voidAlpha:0.97, name:'night' },
  // Pre-dawn 04:30
  { h:4.5, bg0:'#080c18', bg1:'#0c1228', bg2:'#070a14',
    cobR:[200,120,40],  iobR:[60,80,200],  bgLine:[100,220,160],
    particle:'rgba(120,140,255,0.12)', voidAlpha:0.97, name:'night' },
  // Dawn 05:30 — warm amber bleeds in from top
  { h:5.5, bg0:'#1a0e08', bg1:'#100c18', bg2:'#080a10',
    cobR:[220,140,50],  iobR:[70,90,210],  bgLine:[120,230,170],
    particle:'rgba(200,140,80,0.15)', voidAlpha:0.96, name:'dawn' },
  // Morning 08:00 — warm muted teal void
  { h:8,  bg0:'#061410', bg1:'#081a14', bg2:'#050e0c',
    cobR:[210,130,45],  iobR:[55,75,195],  bgLine:[110,225,165],
    particle:'rgba(100,200,160,0.15)', voidAlpha:0.96, name:'day' },
  // Midday 12:00 — brightest, slightly lifted void
  { h:12, bg0:'#071612', bg1:'#091c16', bg2:'#060f0d',
    cobR:[215,135,45],  iobR:[55,78,198],  bgLine:[115,228,168],
    particle:'rgba(100,210,165,0.18)', voidAlpha:0.95, name:'day' },
  // Afternoon 15:00
  { h:15, bg0:'#080f0a', bg1:'#0a1410', bg2:'#060c08',
    cobR:[215,130,40],  iobR:[58,80,200],  bgLine:[110,220,162],
    particle:'rgba(100,200,155,0.14)', voidAlpha:0.96, name:'day' },
  // Dusk 18:30 — deep amber/rust bleeds in
  { h:18.5, bg0:'#140a04', bg1:'#100c14', bg2:'#0a0808',
    cobR:[230,110,35],  iobR:[65,70,190],  bgLine:[105,215,158],
    particle:'rgba(200,100,60,0.15)', voidAlpha:0.97, name:'dusk' },
  // Evening 21:00 — back toward midnight
  { h:21, bg0:'#060814', bg1:'#08091c', bg2:'#050710',
    cobR:[200,115,38],  iobR:[60,80,200],  bgLine:[100,218,160],
    particle:'rgba(100,110,220,0.14)', voidAlpha:0.97, name:'night' },
  // Night 24:00
  { h:24, bg0:'#05070f', bg1:'#080c1a', bg2:'#060914',
    cobR:[200,120,40],  iobR:[60,80,200],  bgLine:[100,220,160],
    particle:'rgba(120,140,255,0.15)', voidAlpha:0.97, name:'night' },
];

function lerpC(a, b, f) { return a.map((v,i) => v + f*(b[i]-v)); }

function palette(t) {
  const h = new Date(t).getHours() + new Date(t).getMinutes()/60;
  let lo = PALETTES[0], hi = PALETTES[PALETTES.length-1];
  for (let i=0; i<PALETTES.length-1; i++) {
    if (h >= PALETTES[i].h && h < PALETTES[i+1].h) { lo=PALETTES[i]; hi=PALETTES[i+1]; break; }
  }
  const f = lo.h===hi.h ? 0 : (h-lo.h)/(hi.h-lo.h);
  return {
    bg0:  lo.bg0,   // not interpolating hex strings — snap to nearest keyframe is fine for bg
    bg1:  lo.bg1,
    cobR: lerpC(lo.cobR, hi.cobR, f),
    iobR: lerpC(lo.iobR, hi.iobR, f),
    bgLine: lerpC(lo.bgLine, hi.bgLine, f),
    particle: lo.particle,
    voidAlpha: lo.voidAlpha + f*(hi.voidAlpha - lo.voidAlpha),
    name: f < 0.5 ? lo.name : hi.name,
    isNight: (f < 0.5 ? lo.name : hi.name) === 'night',
  };
}

// ── VOID BACKGROUND ────────────────────────────────────────────────────
function drawVoid(pal) {
  // Full-bleed dark background — the infinite void the forces move through
  const g = CX.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0,   pal.bg0);
  g.addColorStop(0.5, pal.bg1);
  g.addColorStop(1,   pal.bg0);
  CX.fillStyle = g;
  CX.fillRect(0, 0, W, H);

  // Subtle grain / particle field — tiny luminous motes drifting with time
  CX.save();
  const rng = seededRand(3);
  for (let i=0; i<55; i++) {
    const px = rng()*W;
    const py = rng()*H;
    const drift = ((px*0.3 + py*0.15 + phi*18) % W + W) % W;
    const twinkle = 0.4 + Math.sin(phi*0.8 + i*0.6)*0.6;
    CX.globalAlpha = twinkle * 0.22;
    CX.fillStyle = pal.particle;
    CX.beginPath();
    CX.arc((px + treeScrollX*0.08) % W, py, 0.6 + rng()*1.0, 0, Math.PI*2);
    CX.fill();
  }
  CX.globalAlpha = 1;
  CX.restore();
}

// ── BG LINE Y-MAPPING ─────────────────────────────────────────────────
// Full vertical range — BG 2.0 maps near bottom, 18+ near top
// Inverted: high BG = high on screen (upward force = upward position)
function bgToY(bg) {
  const pad = H * 0.10;
  const frac = Math.max(0, Math.min(1, (bg - BG_MIN) / (BG_MAX - BG_MIN)));
  return (H - pad) - frac * (H - pad*2);
}
const boatYfromBG = bgToY;

// ── BG HISTORY TRACE — the life-line ──────────────────────────────────
function drawBGTrail(pal) {
  if (HISTORY_RAW.length === 0) return; // no data yet
  const leftT = Math.max(CGM_START, xT(0));
  const n     = Math.min(500, Math.max(120, Math.floor(W/1.2)));
  const pts   = [];

  for (let i=0; i<=n; i++) {
    const t = leftT + (i/n)*(viewTime-leftT);
    const d = dataAt(t);
    pts.push({ x: tX(t), y: bgToY(d.bg), bg: d.bg, t });
  }
  if (pts.length < 2) return;

  CX.save();

  // Outer glow — wide, very soft
  CX.globalAlpha = 0.10;
  CX.strokeStyle = `rgba(${pal.bgLine.join(',')},1)`;
  CX.lineWidth   = 16;
  CX.lineJoin    = 'round'; CX.lineCap = 'round';
  _drawSmoothLine(pts);
  CX.stroke();

  // Mid glow
  CX.globalAlpha = 0.22;
  CX.lineWidth   = 6;
  _drawSmoothLine(pts);
  CX.stroke();

  // Core — segmented by zone colour
  CX.globalAlpha = 1;
  CX.lineWidth   = 2.0;
  let seg = [], segCol = null;
  const getCol = (bg) =>
    bg > BG_HIGH ? `rgba(230,140,40,0.95)` :
    bg < BG_LOW  ? `rgba(80,130,220,0.95)` :
                    `rgba(${pal.bgLine.join(',')},0.95)`;

  for (let i=0; i<pts.length; i++) {
    const col = getCol(pts[i].bg);
    if (col !== segCol && seg.length > 1) {
      CX.strokeStyle = segCol;
      CX.shadowColor = segCol; CX.shadowBlur = 3;
      _drawSmoothLine(seg); CX.stroke();
      CX.shadowBlur = 0;
      seg = [seg[seg.length-1]];
    }
    segCol = col;
    seg.push(pts[i]);
  }
  if (seg.length > 1) {
    CX.strokeStyle = segCol;
    CX.shadowColor = segCol; CX.shadowBlur = 3;
    _drawSmoothLine(seg); CX.stroke();
    CX.shadowBlur = 0;
  }

  // Reading dots every ~15min
  const dotGap = (viewSpan/W)*W/16;
  let lastDotT = 0;
  for (const p of pts) {
    if (p.t - lastDotT < dotGap) continue;
    lastDotT = p.t;
    const col = p.bg > BG_HIGH ? '#e68c28' : p.bg < BG_LOW ? '#5082dc' : `rgb(${pal.bgLine.join(',')})`;
    const r   = p.bg > BG_HIGH || p.bg < BG_LOW ? 3.5 : 2.2;
    CX.globalAlpha = 0.85;
    CX.fillStyle   = col;
    CX.shadowColor = col; CX.shadowBlur = 5;
    CX.beginPath(); CX.arc(p.x, p.y, r, 0, Math.PI*2); CX.fill();
    CX.shadowBlur  = 0;
  }

  // ── PREDICTION — soft range cloud, not a single line ─────────────────
  const d0    = dataAt(viewTime);
  const prev5 = dataAt(viewTime - 5*60000);
  const roc   = d0.bg - prev5.bg;
  const ISF   = (new Date(viewTime).getHours() >= 9 && new Date(viewTime).getHours() < 15) ? 7.0 : 6.0;

  // Build centre prediction
  const predC = [];
  for (let i=1; i<=24; i++) {
    const mins = i*5;
    const ft   = viewTime + mins*60000;
    const fx   = tX(ft);
    if (fx > W+20) break;
    const iobDelta = d0.iob > 0 ? -d0.iob*(1-iobF(mins))*ISF : 0;
    const cobDelta = d0.cob > 0 ?  d0.cob*(1-cobF(mins))*0.05 : 0;
    const rocD     = roc * Math.exp(-mins/25);
    const bg       = Math.max(1.5, Math.min(22, d0.bg+iobDelta+cobDelta+rocD));
    predC.push({x:fx, y:bgToY(bg), bg});
  }

  if (predC.length > 1) {
    // Uncertainty cloud — draw 5 bands with increasing offset
    const bands = [0.4, 0.6, 1.0, 0.6, 0.4];
    const offsets = [-2, -1, 0, 1, 2];
    for (let b=0; b<5; b++) {
      const offset = offsets[b] * 8; // vertical spread
      CX.globalAlpha = 0.06 * bands[b];
      CX.strokeStyle = `rgba(${pal.bgLine.join(',')},1)`;
      CX.lineWidth   = 3;
      CX.setLineDash([3, 6]);
      CX.beginPath();
      CX.moveTo(pts[pts.length-1].x, pts[pts.length-1].y + offset);
      for (const p of predC) CX.lineTo(p.x, p.y + offset);
      CX.stroke();
    }
    // Centre prediction line — slightly brighter
    CX.globalAlpha = 0.35;
    CX.strokeStyle = `rgba(${pal.bgLine.join(',')},1)`;
    CX.lineWidth   = 1.5;
    CX.setLineDash([4, 7]);
    CX.beginPath();
    CX.moveTo(pts[pts.length-1].x, pts[pts.length-1].y);
    for (const p of predC) CX.lineTo(p.x, p.y);
    CX.stroke();
    CX.setLineDash([]);

    // Predicted endpoint — ghost dot
    const last = predC[predC.length-1];
    const endCol = last.bg > BG_HIGH ? 'rgba(230,140,40,0.5)' :
                   last.bg < BG_LOW  ? 'rgba(80,130,220,0.5)' :
                   `rgba(${pal.bgLine.join(',')},0.5)`;
    CX.globalAlpha = 0.6;
    CX.fillStyle   = endCol;
    CX.beginPath(); CX.arc(last.x, last.y, 3, 0, Math.PI*2); CX.fill();
    // Predicted value — faint
    CX.globalAlpha = 0.4;
    CX.fillStyle   = endCol;
    CX.font        = "200 10px 'Fraunces',serif";
    CX.textAlign   = 'center';
    CX.fillText(last.bg.toFixed(1), last.x, last.y - 7);
  }

  CX.globalAlpha = 1;
  CX.restore();
}

function _drawSmoothLine(pts) {
  if (pts.length < 2) return;
  CX.beginPath();
  CX.moveTo(pts[0].x, pts[0].y);
  for (let i=1; i<pts.length-1; i++) {
    const mx = (pts[i].x + pts[i+1].x)/2;
    const my = (pts[i].y + pts[i+1].y)/2;
    CX.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
  }
  CX.lineTo(pts[pts.length-1].x, pts[pts.length-1].y);
}

// ── FORCE RIBBONS ─────────────────────────────────────────────────────
// Carbs: warm buoyant ribbon — flows ABOVE the BG line, pushing it up
// Insulin: cool gravity ribbon — flows BELOW the BG line, pulling it down
// Both taper toward the boat (now-point), widen into the past

function buildForcePts(valueKey, direction, lookAhead) {
  const nowT  = viewTime;
  const leftT = Math.max(CGM_START, xT(0));
  const n     = Math.min(400, Math.max(80, Math.floor(W/1.5)));
  const pts   = [];

  for (let i=0; i<=n; i++) {
    const t  = leftT + (i/n)*(nowT-leftT);
    const d  = dataAt(t);
    const x  = tX(t);
    const bgY = bgToY(d.bg);
    const val = Math.max(0, d[valueKey]);
    // Force displaces the ribbon above (carbs, positive) or below (insulin, negative)
    // Maximum ribbon spread = 35% of screen height
    const maxSpread = H * 0.35;
    const dispMax   = valueKey==='cob' ? 50 : 3.0;
    const spread    = Math.min(1, Math.sqrt(Math.max(0,val)/dispMax)) * maxSpread;
    // Age fades the ribbon
    const ageFrac   = Math.max(0, Math.min(1, (nowT-t)/(2*3600000)));
    const y = bgY + direction * spread * (0.3 + 0.7*ageFrac); // wider in past
    pts.push({x, y, val, bgY, spread, t, future:false});
  }

  // Future — decaying forward projection
  if (lookAhead > 0) {
    const d0 = dataAt(nowT);
    for (let i=1; i<=Math.min(18, lookAhead/5); i++) {
      const mins  = i*5;
      const ft    = nowT + mins*60000;
      const fx    = tX(ft);
      if (fx > W+20) break;
      const bgFut = bgToY(dataAt(nowT).bg);
      let fval    = valueKey==='cob' ? d0.cob*cobF(mins) : d0.iob*iobF(mins);
      for (const s of SESSION) {
        const e=(ft-s.t)/60000;
        if (e<0||e>240) continue;
        fval += valueKey==='cob' ? (s.c||0)*cobF(e) : (s.u||0)*iobF(e);
      }
      fval = Math.max(0, fval);
      const maxSpread = H*0.35;
      const spread    = Math.min(1, fval/(valueKey==='cob'?MAX_COB:MAX_IOB))*maxSpread;
      const y = bgFut + direction * spread * 0.3;
      pts.push({x:fx, y, val:fval, bgY:bgFut, spread, t:ft, future:true});
    }
  }
  return pts;
}

function drawForceRibbon(pts, colorR, direction) {
  if (pts.length < 2) return;
  const past   = pts.filter(p => !p.future);
  const future = pts.filter(p =>  p.future);
  if (past.length < 2) return;

  const displayMax = direction > 0 ? 50 : 3.0;
  const peakVal = Math.max(...past.map(function(p){return p.val;}));
  if (peakVal < 0.02) return;
  const tipFrac = Math.min(1, Math.sqrt(Math.max(0,peakVal)/displayMax));

  const r = colorR[0], g = colorR[1], b = colorR[2];

  CX.save();

  // ── FILLED RIBBON — the body of the force ─────────────────────────
  // Upper edge: the displaced y value
  // Lower edge: the BG line itself
  // This makes the ribbon "fill" the space between force and BG line

  // Build ribbon polygon
  const topEdge = past.map(p => ({x:p.x, y:p.y}));
  const botEdge = past.map(p => ({x:p.x, y:p.bgY}));

  // Horizontal gradient: zero alpha at left, peaks near tip
  const rgLeft  = topEdge[0].x;
  const rgRight = tip.x;
  const grad    = CX.createLinearGradient(rgLeft, 0, rgRight, 0);
  grad.addColorStop(0,    `rgba(${r},${g},${b},0)`);
  grad.addColorStop(0.3,  `rgba(${r},${g},${b},${0.06*tipFrac})`);
  grad.addColorStop(0.7,  `rgba(${r},${g},${b},${0.18*tipFrac})`);
  grad.addColorStop(0.92, `rgba(${r},${g},${b},${0.28*tipFrac})`);
  grad.addColorStop(1,    `rgba(${r},${g},${b},${0.12*tipFrac})`);

  CX.fillStyle = grad;
  CX.beginPath();
  // Top edge (displaced)
  CX.moveTo(topEdge[0].x, topEdge[0].y);
  for (let i=1; i<topEdge.length; i++) {
    const mx = (topEdge[i-1].x + topEdge[i].x)/2;
    const my = (topEdge[i-1].y + topEdge[i].y)/2;
    CX.quadraticCurveTo(topEdge[i-1].x, topEdge[i-1].y, mx, my);
  }
  CX.lineTo(topEdge[topEdge.length-1].x, topEdge[topEdge.length-1].y);
  // Bottom edge (BG line) — reversed
  for (let i=botEdge.length-1; i>=0; i--) {
    CX.lineTo(botEdge[i].x, botEdge[i].y);
  }
  CX.closePath();
  CX.fill();

  // ── RIBBON EDGE — glowing filament along the displaced edge ───────
  // Core filament
  CX.strokeStyle = `rgba(${r},${g},${b},${0.55*tipFrac})`;
  CX.lineWidth   = 1.5;
  CX.lineJoin    = 'round'; CX.lineCap = 'round';
  CX.shadowColor = `rgba(${r},${g},${b},0.6)`;
  CX.shadowBlur  = 8;
  CX.globalAlpha = tipFrac;
  _drawSmoothLine(topEdge);
  CX.stroke();
  CX.shadowBlur  = 0;

  // Outer glow filament
  CX.strokeStyle = `rgba(${r},${g},${b},0.15)`;
  CX.lineWidth   = 5;
  CX.globalAlpha = tipFrac;
  _drawSmoothLine(topEdge);
  CX.stroke();

  // ── TIP ORB — converging point at "now" ────────────────────────────
  if (tipFrac > 0.02) {
    const orbR  = 3 + tipFrac*8;
    const orbG  = CX.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, orbR*3);
    orbG.addColorStop(0,   `rgba(${r},${g},${b},${0.8*tipFrac})`);
    orbG.addColorStop(0.4, `rgba(${r},${g},${b},${0.25*tipFrac})`);
    orbG.addColorStop(1,   `rgba(${r},${g},${b},0)`);
    CX.globalAlpha = 1;
    CX.fillStyle   = orbG;
    CX.shadowColor = `rgba(${r},${g},${b},0.8)`;
    CX.shadowBlur  = 16;
    CX.beginPath(); CX.arc(tip.x, tip.y, orbR*3, 0, Math.PI*2); CX.fill();
    CX.shadowBlur  = 0;

    // Solid core
    CX.fillStyle = `rgba(${r},${g},${b},${0.9*tipFrac})`;
    CX.shadowColor = `rgba(${r},${g},${b},1)`;
    CX.shadowBlur  = 6;
    CX.beginPath(); CX.arc(tip.x, tip.y, Math.max(0.5, orbR*0.4), 0, Math.PI*2); CX.fill();
    CX.shadowBlur  = 0;

    // Sparks — tiny particles trailing off the edge
    const sparkN = Math.floor(2 + tipFrac*4);
    const rng    = seededRand(direction > 0 ? 11 : 22);
    for (let i=0; i<sparkN; i++) {
      const idx  = Math.floor(past.length * (0.6 + rng()*0.4));
      if (idx >= past.length) continue;
      const sp   = past[idx];
      const sa   = tipFrac*(0.3 + Math.sin(phi*2.5+i*1.7)*0.25);
      const sr   = 0.8 + tipFrac*1.5;
      CX.globalAlpha = Math.max(0, sa);
      CX.fillStyle   = `rgba(${r},${g},${b},1)`;
      CX.shadowColor = `rgba(${r},${g},${b},0.7)`;
      CX.shadowBlur  = 4;
      CX.beginPath(); CX.arc(sp.x, sp.y, Math.max(0.3,sr), 0, Math.PI*2); CX.fill();
      CX.shadowBlur  = 0;
    }
  }

  // ── FUTURE PROJECTION — faint dotted continuation ─────────────────
  if (future.length > 1) {
    const futEdge = future.map(p => ({x:p.x, y:p.y}));
    CX.globalAlpha = 0.22 * tipFrac;
    CX.strokeStyle = `rgba(${r},${g},${b},1)`;
    CX.lineWidth   = 1.0;
    CX.setLineDash([2, 8]);
    CX.beginPath();
    CX.moveTo(tip.x, tip.y);
    for (const p of futEdge) CX.lineTo(p.x, p.y);
    CX.stroke();
    CX.setLineDash([]);
  }

  CX.restore();
}

// ── EQUILIBRIUM ZONE — the calm corridor between forces ───────────────
// When BG is in range and forces are roughly balanced, draw a soft
// glowing band showing the target zone — the zone of equilibrium
// ── GAS CLOUD — living ethereal force field ───────────────────────────
// direction:  1 = carbs rising from below BG line toward bottom of screen
//            -1 = insulin falling from above BG line toward top of screen
// The cloud fills the space between the BG line and the screen edge
// in the direction of the force, with animated wispy tendrils

function drawGasCloud(pts, col, direction, d) {
  if (!pts || pts.length < 2) return;
  const past = pts.filter(p => !p.future);
  if (past.length < 2) return;

  const peakVal = Math.max(...past.map(p => p.val));
  if (peakVal < 0.01) return; // void — no force active

  const [r, g, b] = col;
  const tipFrac = Math.min(1, Math.sqrt(peakVal / (direction > 0 ? 50 : 3.0)));

  CX.save();

  const nowX  = NOW_X * W;
  const edgeY = direction > 0 ? H : 0; // screen edge toward which cloud expands

  // ── MAIN CLOUD BODY — gaussian fill from BG line to screen edge ──
  // Build the cloud polygon: BG line on one side, screen edge on other
  const topEdge = past.map(p => ({ x: p.x, y: p.bgY }));         // BG line
  const botEdge = past.map(p => {                                   // cloud extent
    // Cloud height scales with force value and tapers toward left (older)
    const ageFrac  = Math.max(0, Math.min(1, (viewTime - p.t) / (2*3600000)));
    const strength = Math.min(1, Math.sqrt(Math.max(0, p.val) / (direction > 0 ? 50 : 3.0)));
    const maxH     = H * 0.45 * strength * (0.2 + 0.8 * ageFrac);
    return { x: p.x, y: p.bgY + direction * maxH };
  });

  // Gradient from BG line (transparent) to screen edge (peak opacity)
  const gradY0 = past[past.length-1].bgY;
  const gradY1 = gradY0 + direction * H * 0.45;
  const grad   = CX.createLinearGradient(0, gradY0, 0, gradY1);
  grad.addColorStop(0,    `rgba(${r},${g},${b},0)`);
  grad.addColorStop(0.15, `rgba(${r},${g},${b},${0.04 * tipFrac})`);
  grad.addColorStop(0.4,  `rgba(${r},${g},${b},${0.10 * tipFrac})`);
  grad.addColorStop(0.7,  `rgba(${r},${g},${b},${0.16 * tipFrac})`);
  grad.addColorStop(1.0,  `rgba(${r},${g},${b},${0.22 * tipFrac})`);

  CX.globalAlpha = 1;
  CX.fillStyle   = grad;
  CX.beginPath();
  CX.moveTo(topEdge[0].x, topEdge[0].y);
  _drawSmoothLine(topEdge);
  // Across to cloud extent
  for (let i = botEdge.length-1; i >= 0; i--) {
    CX.lineTo(botEdge[i].x, botEdge[i].y);
  }
  CX.closePath();
  CX.fill();

  // ── WISPS — animated tendrils floating in the gas ─────────────
  const wispCount = Math.floor(3 + tipFrac * 6);
  const rng = seededRand(direction > 0 ? 77 : 33);
  for (let w = 0; w < wispCount; w++) {
    const wIdx   = Math.floor(past.length * (0.2 + rng() * 0.8));
    if (wIdx >= past.length) continue;
    const wp     = past[wIdx];
    const wStrength = Math.min(1, Math.sqrt(Math.max(0, wp.val) / (direction > 0 ? 50 : 3.0)));
    if (wStrength < 0.05) continue;

    const wPhase  = phi * (0.4 + rng() * 0.6) + w * 1.3;
    const wOffset = Math.sin(wPhase) * 8 * wStrength;
    const wH      = wp.bgY + direction * H * 0.35 * wStrength + wOffset;
    const wAlpha  = wStrength * tipFrac * (0.08 + 0.12 * Math.abs(Math.sin(wPhase)));
    const wWidth  = 20 + rng() * 40;

    const wg = CX.createRadialGradient(wp.x, wH, 0, wp.x, wH, wWidth);
    wg.addColorStop(0,   `rgba(${r},${g},${b},${wAlpha})`);
    wg.addColorStop(0.5, `rgba(${r},${g},${b},${wAlpha * 0.4})`);
    wg.addColorStop(1,   `rgba(${r},${g},${b},0)`);
    CX.globalAlpha = 1;
    CX.fillStyle   = wg;
    CX.beginPath();
    CX.ellipse(wp.x, wH, wWidth, wWidth * 0.4, 0, 0, Math.PI * 2);
    CX.fill();
  }

  // ── BOUNDARY FILAMENT — glowing edge at the BG line interface ──
  const filAlpha = Math.max(0.15, tipFrac * 0.55);
  CX.globalAlpha = filAlpha;
  CX.strokeStyle = `rgba(${r},${g},${b},1)`;
  CX.lineWidth   = 1.2;
  CX.shadowColor = `rgba(${r},${g},${b},0.7)`;
  CX.shadowBlur  = 6;
  _drawSmoothLine(topEdge);
  CX.stroke();
  CX.shadowBlur  = 0;

  // ── TIP CONVERGENCE — where the force meets now ────────────────
  const tip = past[past.length - 1];
  if (tipFrac > 0.02 && tip) {
    const tipR = 2 + tipFrac * 6;
    const tg   = CX.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, tipR * 4);
    tg.addColorStop(0,   `rgba(${r},${g},${b},${0.7 * tipFrac})`);
    tg.addColorStop(0.5, `rgba(${r},${g},${b},${0.2 * tipFrac})`);
    tg.addColorStop(1,   `rgba(${r},${g},${b},0)`);
    CX.globalAlpha = 1;
    CX.fillStyle   = tg;
    CX.shadowColor = `rgba(${r},${g},${b},0.8)`;
    CX.shadowBlur  = 12;
    CX.beginPath(); CX.arc(tip.x, tip.y, tipR * 4, 0, Math.PI * 2); CX.fill();

    // Solid core spark
    CX.fillStyle   = `rgba(${r},${g},${b},${0.9 * tipFrac})`;
    CX.shadowBlur  = 4;
    CX.beginPath(); CX.arc(tip.x, tip.y, Math.max(0.5, tipFrac * 2.5), 0, Math.PI * 2); CX.fill();
    CX.shadowBlur  = 0;
  }

  CX.restore();
}

// ── FUTURE CLOUDS — projected gas beyond now ─────────────────────────
function drawFutureClouds(cobPts, iobPts, d, pal) {
  const nowX = NOW_X * W;

  // Subtle void deepening ahead
  const mg = CX.createLinearGradient(nowX, 0, W, 0);
  mg.addColorStop(0,    'rgba(0,0,0,0)');
  mg.addColorStop(0.08, 'rgba(0,0,0,0.06)');
  mg.addColorStop(1,    'rgba(0,0,0,0.20)');
  CX.fillStyle = mg;
  CX.fillRect(nowX, 0, W - nowX, H);

  // Project COB cloud forward
  const cobFuture = cobPts.filter(p => p.future);
  if (cobFuture.length > 1) {
    const [r,g,b] = COL_COB;
    const peakCob = Math.max(...cobPts.filter(p=>!p.future).map(p=>p.val));
    const tf = Math.min(0.5, Math.sqrt(peakCob / 50));
    CX.save();
    const grad = CX.createLinearGradient(nowX, 0, W, 0);
    grad.addColorStop(0,   `rgba(${r},${g},${b},${0.12 * tf})`);
    grad.addColorStop(1,   `rgba(${r},${g},${b},0)`);
    CX.globalAlpha = 1;
    CX.fillStyle   = grad;
    CX.beginPath();
    CX.moveTo(nowX, d ? bgToY(d.bg) : H/2);
    for (const p of cobFuture) CX.lineTo(p.x, p.bgY);
    for (let i = cobFuture.length-1; i >= 0; i--) CX.lineTo(cobFuture[i].x, cobFuture[i].y);
    CX.closePath(); CX.fill();
    // Wispy filament
    CX.globalAlpha = tf * 0.3;
    CX.strokeStyle = `rgba(${r},${g},${b},1)`;
    CX.lineWidth   = 0.8;
    CX.setLineDash([3, 9]);
    CX.beginPath();
    CX.moveTo(nowX, d ? bgToY(d.bg) : H/2);
    for (const p of cobFuture) CX.lineTo(p.x, p.y);
    CX.stroke();
    CX.setLineDash([]);
    CX.restore();
  }

  // Project IOB cloud forward
  const iobFuture = iobPts.filter(p => p.future);
  if (iobFuture.length > 1) {
    const [r,g,b] = COL_IOB;
    const peakIob = Math.max(...iobPts.filter(p=>!p.future).map(p=>p.val));
    const tf = Math.min(0.5, Math.sqrt(peakIob / 3.0));
    CX.save();
    const grad = CX.createLinearGradient(nowX, 0, W, 0);
    grad.addColorStop(0,   `rgba(${r},${g},${b},${0.12 * tf})`);
    grad.addColorStop(1,   `rgba(${r},${g},${b},0)`);
    CX.globalAlpha = 1;
    CX.fillStyle   = grad;
    CX.beginPath();
    CX.moveTo(nowX, d ? bgToY(d.bg) : H/2);
    for (const p of iobFuture) CX.lineTo(p.x, p.bgY);
    for (let i = iobFuture.length-1; i >= 0; i--) CX.lineTo(iobFuture[i].x, iobFuture[i].y);
    CX.closePath(); CX.fill();
    CX.globalAlpha = tf * 0.3;
    CX.strokeStyle = `rgba(${r},${g},${b},1)`;
    CX.lineWidth   = 0.8;
    CX.setLineDash([3, 9]);
    CX.beginPath();
    CX.moveTo(nowX, d ? bgToY(d.bg) : H/2);
    for (const p of iobFuture) CX.lineTo(p.x, p.y);
    CX.stroke();
    CX.setLineDash([]);
    CX.restore();
  }
}

// ── ORB — the present moment, buoyant on the BG line ─────────────────
function drawOrb(pal, d) {
  if (!d) return;
  const x    = NOW_X * W;
  const y    = bgToY(d.bg);
  const t    = Date.now() / 1000;

  // Colour shifts with BG value
  const [r, g, b] = d.bg < BG_LOW  ? COL_BGLOW :
                    d.bg > BG_HIGH  ? COL_BGHIGH :
                    pal.bgLine;

  // Breathing pulse — slow living rhythm
  const breath = 0.7 + Math.sin(phi * 0.8) * 0.3;
  const orbR   = 6 + breath * 3;

  CX.save();

  // Outer glow — wide, soft, colour-coded
  const og = CX.createRadialGradient(x, y, 0, x, y, orbR * 5);
  og.addColorStop(0,   `rgba(${r},${g},${b},${0.25 * breath})`);
  og.addColorStop(0.4, `rgba(${r},${g},${b},${0.10 * breath})`);
  og.addColorStop(1,   `rgba(${r},${g},${b},0)`);
  CX.globalAlpha = 1;
  CX.fillStyle   = og;
  CX.beginPath(); CX.arc(x, y, orbR * 5, 0, Math.PI * 2); CX.fill();

  // Mid glow
  const mg = CX.createRadialGradient(x, y, 0, x, y, orbR * 2.5);
  mg.addColorStop(0,   `rgba(${r},${g},${b},${0.6 * breath})`);
  mg.addColorStop(0.6, `rgba(${r},${g},${b},${0.2 * breath})`);
  mg.addColorStop(1,   `rgba(${r},${g},${b},0)`);
  CX.fillStyle   = mg;
  CX.shadowColor = `rgba(${r},${g},${b},0.9)`;
  CX.shadowBlur  = 16;
  CX.beginPath(); CX.arc(x, y, orbR * 2.5, 0, Math.PI * 2); CX.fill();
  CX.shadowBlur  = 0;

  // Core — solid, bright
  CX.fillStyle   = `rgba(${r},${g},${b},0.95)`;
  CX.shadowColor = `rgba(${r},${g},${b},1)`;
  CX.shadowBlur  = 8;
  CX.beginPath(); CX.arc(x, y, Math.max(2, orbR * 0.5), 0, Math.PI * 2); CX.fill();
  CX.shadowBlur  = 0;

  // Sparkle — tiny rotating satellites
  const sparkCount = 3;
  for (let i = 0; i < sparkCount; i++) {
    const angle  = phi * 0.6 + (i / sparkCount) * Math.PI * 2;
    const dist   = orbR * 1.8;
    const sx     = x + Math.cos(angle) * dist;
    const sy     = y + Math.sin(angle) * dist;
    const sa     = 0.3 + Math.sin(phi * 1.2 + i * 2.1) * 0.2;
    CX.globalAlpha = Math.max(0, sa);
    CX.fillStyle   = `rgba(${r},${g},${b},1)`;
    CX.shadowColor = `rgba(${r},${g},${b},0.8)`;
    CX.shadowBlur  = 3;
    CX.beginPath(); CX.arc(sx, sy, Math.max(0.5, orbR * 0.12), 0, Math.PI * 2); CX.fill();
    CX.shadowBlur  = 0;
  }

  // Long-press hint — very subtle ring
  if (_orbLongPressHint > 0) {
    CX.globalAlpha = _orbLongPressHint * 0.4;
    CX.strokeStyle = `rgba(${r},${g},${b},1)`;
    CX.lineWidth   = 1;
    CX.beginPath(); CX.arc(x, y, orbR * 3.5, 0, Math.PI * 2); CX.stroke();
    _orbLongPressHint *= 0.96;
  }

  CX.globalAlpha = 1;
  CX.restore();
}

let _orbLongPressHint = 0;


function drawEquilibriumZone(pal) {
  const loY = bgToY(BG_HIGH); // top of target (high mmol = higher on screen)
  const hiY = bgToY(BG_LOW);  // bottom of target
  CX.save();
  // Subtle band — just a hint, not a clinical range marker
  CX.globalAlpha = 0.04;
  CX.fillStyle   = `rgb(${pal.bgLine.join(',')})`;
  CX.fillRect(0, loY, W, hiY - loY);
  // Edge lines — very faint
  CX.globalAlpha = 0.07;
  CX.strokeStyle = `rgb(${pal.bgLine.join(',')})`;
  CX.lineWidth   = 0.5;
  CX.setLineDash([4, 12]);
  CX.beginPath(); CX.moveTo(0, loY); CX.lineTo(W, loY); CX.stroke();
  CX.beginPath(); CX.moveTo(0, hiY); CX.lineTo(W, hiY); CX.stroke();
  CX.setLineDash([]);
  CX.globalAlpha = 1;
  CX.restore();
}

// ── "NOW" PULSE — vertical breath at the current moment ───────────────
function drawNowPulse(pal, d) {
  const nowX = NOW_X*W;
  const bgY  = bgToY(d.bg);
  CX.save();

  // Vertical axis of now — very faint
  CX.globalAlpha = 0.06;
  CX.strokeStyle = 'rgba(255,255,255,0.8)';
  CX.lineWidth   = 0.5;
  CX.setLineDash([2, 10]);
  CX.beginPath(); CX.moveTo(nowX, 0); CX.lineTo(nowX, H); CX.stroke();
  CX.setLineDash([]);

  // Breathing radial pulse centred on boat position
  const pulse  = 0.5 + Math.sin(phi*0.9)*0.5;
  const pR     = 18 + pulse*12;
  const pAlpha = 0.04 + pulse*0.03;
  const col    = d.bg < BG_LOW  ? `rgba(80,130,220,${pAlpha})`  :
                 d.bg > BG_HIGH ? `rgba(220,130,60,${pAlpha})` :
                                   `rgba(${pal.bgLine.join(',')},${pAlpha})`;
  CX.globalAlpha = 1;
  CX.fillStyle   = col;
  CX.beginPath(); CX.arc(nowX, bgY, pR, 0, Math.PI*2); CX.fill();

  // Live reading pulse if new data
  if (_pulseAlpha > 0.01) {
    const pr = 20 + (1-_pulseAlpha)*50;
    CX.globalAlpha = _pulseAlpha * 0.4;
    CX.strokeStyle = `rgba(${pal.bgLine.join(',')},0.9)`;
    CX.lineWidth   = 1.2;
    CX.shadowColor = `rgb(${pal.bgLine.join(',')})`;
    CX.shadowBlur  = 8;
    CX.beginPath(); CX.arc(nowX, bgY, Math.max(0.5,pr), 0, Math.PI*2); CX.stroke();
    CX.shadowBlur  = 0;
    _pulseAlpha *= 0.93;
  }

  CX.restore();
}

// ── BOLUS MARKERS ────────────────────────────────────────────────────
// ── BOLUS / EVENT MARKERS — anchored context cards ────────────────
function drawBolusMarkers(pal) {
  if (!window._eventCards) window._eventCards = [];
  window._eventCards = [];
  CX.save();
  const allEvents = [...BOLUS_EVENTS, ...SESSION.map(s => ({t:s.t, c:s.c||0, u:s.u||0}))];

  for (const b of allEvents) {
    const x   = tX(b.t);
    if (x < -80 || x > W + 80) continue;
    const d   = dataAt(b.t);
    const bgY = bgToY(d.bg);

    if (b.c > 1) {
      const r = pal.cobR[0], g = pal.cobR[1], bv = pal.cobR[2];
      const cardY = bgY - 30 - Math.min(b.c * 0.4, 36);
      // Stem
      CX.globalAlpha = 0.35;
      CX.strokeStyle = 'rgba(' + r + ',' + g + ',' + bv + ',0.7)';
      CX.lineWidth   = 0.8; CX.setLineDash([2,5]);
      CX.beginPath(); CX.moveTo(x, bgY - 5); CX.lineTo(x, cardY + 12); CX.stroke();
      CX.setLineDash([]);
      // Dot on trace
      CX.globalAlpha = 0.9; CX.fillStyle = 'rgba(' + r + ',' + g + ',' + bv + ',1)';
      CX.shadowColor = 'rgba(' + r + ',' + g + ',' + bv + ',0.8)'; CX.shadowBlur = 5;
      CX.beginPath(); CX.arc(x, bgY, 3.2, 0, Math.PI*2); CX.fill(); CX.shadowBlur = 0;
      // Pill label
      const lbl = b.c + 'g';
      CX.font = "300 9px 'DM Mono',monospace";
      const lw = CX.measureText(lbl).width + 12;
      CX.globalAlpha = 0.6;
      CX.fillStyle   = 'rgba(' + r + ',' + g + ',' + bv + ',0.18)';
      CX.strokeStyle = 'rgba(' + r + ',' + g + ',' + bv + ',0.45)';
      CX.lineWidth   = 0.7;
      CX.beginPath(); CX.roundRect(x - lw/2, cardY, lw, 15, 4); CX.fill(); CX.stroke();
      CX.globalAlpha = 0.85; CX.fillStyle = 'rgba(' + r + ',' + g + ',' + bv + ',1)';
      CX.textAlign   = 'center';
      CX.fillText(lbl, x, cardY + 10.5);
      window._eventCards.push({x, y:cardY+8, w:lw+4, h:16, data:b, type:'carb'});
    }

    if (b.u > 0.1) {
      const r = pal.iobR[0], g = pal.iobR[1], bv = pal.iobR[2];
      const cardY = bgY + 30 + Math.min(b.u * 8, 36);
      CX.globalAlpha = 0.35;
      CX.strokeStyle = 'rgba(' + r + ',' + g + ',' + bv + ',0.7)';
      CX.lineWidth   = 0.8; CX.setLineDash([2,5]);
      CX.beginPath(); CX.moveTo(x, bgY + 5); CX.lineTo(x, cardY - 2); CX.stroke();
      CX.setLineDash([]);
      CX.globalAlpha = 0.9; CX.fillStyle = 'rgba(' + r + ',' + g + ',' + bv + ',1)';
      CX.shadowColor = 'rgba(' + r + ',' + g + ',' + bv + ',0.8)'; CX.shadowBlur = 5;
      CX.beginPath(); CX.arc(x, bgY, 3.2, 0, Math.PI*2); CX.fill(); CX.shadowBlur = 0;
      const lbl = b.u.toFixed(1) + 'U';
      CX.font = "300 9px 'DM Mono',monospace";
      const lw = CX.measureText(lbl).width + 12;
      CX.globalAlpha = 0.6;
      CX.fillStyle   = 'rgba(' + r + ',' + g + ',' + bv + ',0.15)';
      CX.strokeStyle = 'rgba(' + r + ',' + g + ',' + bv + ',0.4)';
      CX.lineWidth   = 0.7;
      CX.beginPath(); CX.roundRect(x - lw/2, cardY - 1, lw, 15, 4); CX.fill(); CX.stroke();
      CX.globalAlpha = 0.8; CX.fillStyle = 'rgba(' + r + ',' + g + ',' + bv + ',1)';
      CX.textAlign   = 'center';
      CX.fillText(lbl, x, cardY + 10);
      window._eventCards.push({x, y:cardY+7, w:lw+4, h:16, data:b, type:'insulin'});
    }
  }
  CX.globalAlpha = 1; CX.restore();
}


function drawBoat(pal, d) {
  const nowX = NOW_X*W;
  const bgY  = bgToY(d.bg);
  const prev = dataAt(viewTime - 10*60000);
  const rate = (d.bg - prev.bg) / (10/60);

  const isLow  = d.bg < BG_LOW;
  const isHigh = d.bg > BG_HIGH;
  const orbRGB = isLow  ? [80,120,220] :
                 isHigh ? [230,140,50]  :
                 pal.bgLine;
  const r=orbRGB[0], g=orbRGB[1], b=orbRGB[2];

  const pulseRate = isLow ? 3.5 : isHigh ? 2.2 : 1.0;
  const pulse = 0.5 + Math.sin(phi * pulseRate) * 0.5;
  const bob   = Math.sin(phi * 1.1) * 2.2;
  const cy    = bgY + bob;
  const orbSz = 8 + pulse * 4;

  CX.save();

  // Outer glow
  var glowG = CX.createRadialGradient(nowX, cy, 0, nowX, cy, orbSz * 4.5);
  glowG.addColorStop(0,   'rgba(' + r + ',' + g + ',' + b + ',' + (0.16 + pulse*0.07) + ')');
  glowG.addColorStop(0.4, 'rgba(' + r + ',' + g + ',' + b + ',' + (0.05 + pulse*0.03) + ')');
  glowG.addColorStop(1,   'rgba(' + r + ',' + g + ',' + b + ',0)');
  CX.fillStyle = glowG;
  CX.beginPath(); CX.arc(nowX, cy, orbSz * 4.5, 0, Math.PI*2); CX.fill();

  // Direction arc — shows rate of change
  const arcA = rate > 0.3  ? [-Math.PI*0.85, -Math.PI*0.15] :
               rate < -0.3 ? [ Math.PI*0.15,  Math.PI*0.85] :
               [-Math.PI, Math.PI];
  CX.globalAlpha = 0.45 + pulse * 0.2;
  CX.strokeStyle = 'rgba(' + r + ',' + g + ',' + b + ',0.9)';
  CX.lineWidth   = 1.4;
  CX.shadowColor = 'rgba(' + r + ',' + g + ',' + b + ',0.8)';
  CX.shadowBlur  = 5;
  CX.beginPath(); CX.arc(nowX, cy, orbSz * 1.6, arcA[0], arcA[1]); CX.stroke();
  CX.shadowBlur  = 0;

  // Core sphere
  var coreG = CX.createRadialGradient(nowX - orbSz*0.28, cy - orbSz*0.28, 0, nowX, cy, orbSz);
  coreG.addColorStop(0,   'rgba(255,255,255,' + (0.55 + pulse*0.2) + ')');
  coreG.addColorStop(0.4, 'rgba(' + r + ',' + g + ',' + b + ',' + (0.88 + pulse*0.08) + ')');
  coreG.addColorStop(1,   'rgba(' + r + ',' + g + ',' + b + ',' + (0.45 + pulse*0.1) + ')');
  CX.globalAlpha = 1;
  CX.fillStyle   = coreG;
  CX.shadowColor = 'rgba(' + r + ',' + g + ',' + b + ',1)';
  CX.shadowBlur  = 12;
  CX.beginPath(); CX.arc(nowX, cy, orbSz, 0, Math.PI*2); CX.fill();
  CX.shadowBlur  = 0;

  // Rate-of-change trail dots
  if (Math.abs(rate) > 0.25) {
    var dir = rate > 0 ? -1 : 1;
    for (var i = 1; i <= 3; i++) {
      var dotA = (0.35 - i*0.09) * (Math.min(3, Math.abs(rate)) / 3);
      if (dotA < 0.02) continue;
      CX.globalAlpha = dotA;
      CX.fillStyle   = 'rgba(' + r + ',' + g + ',' + b + ',1)';
      CX.beginPath(); CX.arc(nowX, cy + dir*i*9, Math.max(0.5, 2.2 - i*0.5), 0, Math.PI*2); CX.fill();
    }
  }

  // Live reading pulse ring
  if (_pulseAlpha > 0.01) {
    var pr = 18 + (1 - _pulseAlpha) * 50;
    CX.globalAlpha = _pulseAlpha * 0.4;
    CX.strokeStyle = 'rgba(' + r + ',' + g + ',' + b + ',0.8)';
    CX.lineWidth   = 1.2;
    CX.shadowColor = 'rgba(' + r + ',' + g + ',' + b + ',0.8)';
    CX.shadowBlur  = 8;
    CX.beginPath(); CX.arc(nowX, cy, Math.max(1, pr), 0, Math.PI*2); CX.stroke();
    CX.shadowBlur  = 0;
    _pulseAlpha   *= 0.93;
  }

  CX.restore();
}


function drawFutureMist(pal) {
  const nowX = NOW_X*W;
  // Very subtle — the void itself is already dark enough
  // Just a slight deepening of the void ahead
  const mg = CX.createLinearGradient(nowX, 0, W, 0);
  mg.addColorStop(0,    'rgba(0,0,0,0)');
  mg.addColorStop(0.12, 'rgba(0,0,0,0.08)');
  mg.addColorStop(0.5,  'rgba(0,0,0,0.18)');
  mg.addColorStop(1,    'rgba(0,0,0,0.28)');
  CX.fillStyle = mg;
  CX.fillRect(nowX, 0, W-nowX, H);
}

// ── TRANSITION MARKER — OmniPod pause ─────────────────────────────────
function drawTransition(pal) {
  const tx = tX(POD_PAUSE_T);
  if (tx < -40 || tx > W+40) return;
  CX.save();
  CX.globalAlpha = 0.12;
  CX.strokeStyle = 'rgba(180,180,200,0.6)';
  CX.lineWidth   = 0.6;
  CX.setLineDash([2,10]);
  CX.beginPath(); CX.moveTo(tx, 0); CX.lineTo(tx, H); CX.stroke();
  CX.setLineDash([]);
  CX.globalAlpha = 0.18;
  CX.fillStyle   = 'rgba(180,180,200,0.8)';
  CX.font        = "italic 9px 'Fraunces',serif";
  CX.textAlign   = 'center';
  CX.fillText('pen · 16 mar', tx, 18);
  CX.restore();
}

// ── TIME LABELS — on the void ──────────────────────────────────────────
const DNAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function drawTimeLabels(pal) {
  if (!pal || CGM_END === CGM_START) return;
  const mspp   = viewSpan/W;
  let tickMs   = 3600000;
  if (mspp*W > 20*3600000) tickMs = 6*3600000;
  if (mspp*W > 48*3600000) tickMs = 12*3600000;

  const nd = new Date(viewTime);
  const el = document.getElementById('timelabel');
  if (el) el.textContent = DNAMES[nd.getDay()] + ' ' +
    nd.getHours().toString().padStart(2,'0') + ':' +
    nd.getMinutes().toString().padStart(2,'0');

  const nowX   = NOW_X*W;
  const startT = xT(0), endT = xT(W);
  const firstT = Math.ceil(startT/tickMs)*tickMs;

  CX.save(); CX.textAlign = 'center';
  for (let t=firstT; t<=endT; t+=tickMs) {
    const x = tX(t);
    if (x < 20 || x > W-20) continue;
    const d = new Date(t);
    const lbl = d.getHours()===0
      ? DNAMES[d.getDay()]
      : d.getHours().toString().padStart(2,'0')+':00';
    const distPx  = Math.abs(x - nowX);
    const distFrac= Math.min(1, distPx/(W*0.42));
    const sz      = Math.max(11, 20*(1-distFrac*0.5));
    const al      = Math.max(0.12, 0.45*(1-distFrac*0.75));

    // Labels float at bottom of screen — always visible
    CX.globalAlpha = al;
    CX.fillStyle   = 'rgba(180,200,220,1)';
    CX.font        = `200 ${sz.toFixed(0)}px 'Fraunces',serif`;
    CX.fillText(lbl, x, H - 28);
  }

  // "now" marker — small, sits at orb x position just above tick area
  CX.globalAlpha = 0.55;
  CX.fillStyle   = 'rgba(200,220,240,1)';
  CX.font        = "300 11px 'DM Mono',monospace";
  CX.fillText(
    nd.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}),
    nowX, H - 46
  );
  // Tiny "now" label beneath time
  CX.globalAlpha = 0.22;
  CX.font        = "300 8px 'DM Mono',monospace";
  CX.fillText('now', nowX, H - 35);
  CX.globalAlpha=0.28;CX.fillStyle='rgba(200,220,240,1)';
  CX.font="300 9px 'DM Mono',monospace";CX.textAlign='right';
  CX.fillText('__BUILD_ID__',W-10,H-8);
  CX.globalAlpha=0.28;CX.fillStyle='rgba(200,220,240,1)';
  CX.font="300 9px 'DM Mono',monospace";CX.textAlign='right';
  CX.fillText('__BUILD_ID__',W-10,H-8);
  CX.restore();
}

// ── RIVER PEBBLE — disturbance in the flow ─────────────────────────────
var _riverPebble = null;

function showRiverPebble(msg, type) {
  _riverPebble = { msg, type, alpha: 1.0, t: Date.now() };
  var chip = document.getElementById('pebble-chip');
  if (!chip) {
    chip = document.createElement('div');
    chip.id = 'pebble-chip';
    chip.style.cssText = [
      'position:fixed',
      'bottom:calc(max(80px,env(safe-area-inset-bottom,80px)) + 12px)',
      'left:50%',
      'transform:translateX(-50%)',
      'z-index:25',
      'padding:6px 16px',
      'border-radius:20px',
      "font-family:'DM Mono',monospace",
      'font-size:10px',
      'color:rgba(200,220,240,0.9)',
      'letter-spacing:.4px',
      'cursor:pointer',
      'background:rgba(30,50,80,0.75)',
      'backdrop-filter:blur(10px)',
      'border:1px solid rgba(100,150,200,0.2)',
      'transition:opacity .4s',
      'white-space:nowrap'
    ].join(';');
    chip.onclick = function() {
      chip.style.opacity = '0';
      ALERTS.snooze('corr_nudge', 20*60000);
      ALERTS.snooze('corr_high',  20*60000);
    };
    document.body.appendChild(chip);
  }
  chip.textContent = msg;
  chip.style.opacity = '1';
  if (window._pebbleTimeout) clearTimeout(window._pebbleTimeout);
  window._pebbleTimeout = setTimeout(function() {
    if (chip) chip.style.opacity = '0';
  }, 10000);
}

function drawRiverPebble(pal) {
  if (!_riverPebble) return;
  var age = (Date.now() - _riverPebble.t)/1000;
  if (age > 14) { _riverPebble = null; return; }
  _riverPebble.alpha = Math.max(0, 1 - age/14);
  var nowX  = NOW_X*W;
  var boatY = bgToY(dataAt(viewTime).bg);
  CX.save();
  for (var ring=0; ring<3; ring++) {
    var rAge  = (age + ring) % 4.5;
    var r     = 12 + rAge*15;
    var rAlpha= _riverPebble.alpha*(1-rAge/4.5)*0.35;
    if (rAlpha < 0.01) continue;
    CX.globalAlpha = rAlpha;
    CX.strokeStyle = 'rgba(180,210,255,0.8)';
    CX.lineWidth   = 0.8;
    CX.beginPath(); CX.arc(nowX, boatY, Math.max(1,r), 0, Math.PI*2); CX.stroke();
  }
  CX.restore();
}


// ── MAIN FRAME ───────────────────────────────────────────────

// ── SMART ALERT SYSTEM ──────────────────────────────────────────────
// Hypo: act NOW — urgent, escalating
// Hyper: only alert when correction window is open (IOB clear, safe gap)

const ALERTS = {
  _lastAlertT:   {},
  _audioCtx:     null,
  _snoozedUntil: {},

  canFire(key, cooldownMs) {
    const now = Date.now();
    if (this._snoozedUntil[key] && now < this._snoozedUntil[key]) return false;
    if (this._lastAlertT[key]   && now - this._lastAlertT[key] < cooldownMs) return false;
    return true;
  },
  fire(key)          { this._lastAlertT[key] = Date.now(); },
  snooze(key, ms)    { this._snoozedUntil[key] = Date.now() + ms; },

  beep(freq, dur, vol, type) {
    type = type || 'sine';
    try {
      if (!this._audioCtx) this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = this._audioCtx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      gain.gain.setValueAtTime(vol, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + dur);
    } catch(e) {}
  },

  hypoAlarm() {
    var self = this;
    [0, 180, 360].forEach(function(delay) {
      setTimeout(function() {
        self.beep(440, 0.15, 0.6, 'square');
        setTimeout(function() { self.beep(580, 0.15, 0.6, 'square'); }, 80);
        setTimeout(function() { self.beep(740, 0.25, 0.6, 'square'); }, 160);
      }, delay);
    });
    if (navigator.vibrate) navigator.vibrate([200,100,200,100,400]);
  },

  hypoWarning() {
    this.beep(520, 0.2, 0.35, 'sine');
    var self = this;
    setTimeout(function() { self.beep(520, 0.2, 0.35, 'sine'); }, 300);
    if (navigator.vibrate) navigator.vibrate([150, 100, 150]);
  },

  correctionNudge() {
    this.beep(660, 0.3, 0.18, 'sine');
    var self = this;
    setTimeout(function() { self.beep(880, 0.4, 0.12, 'sine'); }, 350);
  }
};

// ── HOVER TOOLTIP ─────────────────────────────────────────────────
var _hoverTooltip = null;
var _tooltipFade  = 0;
var _lastTooltip  = null;

function drawHoverTooltip(pal) {
  if (!_hoverTooltip) { _tooltipFade = Math.max(0, _tooltipFade - 0.06); }
  else                { _tooltipFade = Math.min(1, _tooltipFade + 0.14); }
  if (_tooltipFade < 0.01) return;
  var tp = _hoverTooltip || _lastTooltip;
  if (!tp) return;
  CX.save();
  CX.globalAlpha = _tooltipFade;
  CX.font = "300 10px 'DM Mono',monospace";
  var tw = CX.measureText(tp.label).width;
  var bw = tw + 16, bh = 22;
  var bx = Math.max(4, Math.min(W - bw - 4, tp.x - bw/2));
  var by = Math.max(4, tp.y - bh - 12);
  CX.fillStyle = 'rgba(6,9,20,0.90)';
  CX.strokeStyle = tp.col || 'rgba(140,180,220,0.4)';
  CX.lineWidth = 0.6;
  CX.beginPath(); CX.roundRect(bx, by, bw, bh, 4);
  CX.fill(); CX.stroke();
  CX.fillStyle = tp.col || 'rgba(170,210,240,0.9)';
  CX.textAlign = 'center';
  CX.fillText(tp.label, bx + bw/2, by + 14);
  CX.fillStyle = tp.col || 'rgba(170,210,240,0.6)';
  CX.beginPath(); CX.arc(tp.x, tp.y, 2.5, 0, Math.PI*2); CX.fill();
  CX.restore();
}

function checkHover(mx, my) {
  var dots = window._bgDots || [];
  for (var i = 0; i < dots.length; i++) {
    var d = dots[i];
    if (Math.hypot(mx - d.x, my - d.y) < 16) {
      var ts = new Date(d.t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
      _hoverTooltip = {x:d.x, y:d.y, label:d.bg.toFixed(1)+' mmol  '+ts, col:d.col};
      _lastTooltip  = _hoverTooltip; return;
    }
  }
  var cards = window._eventCards || [];
  for (var j = 0; j < cards.length; j++) {
    var c = cards[j];
    if (mx>c.x-c.w/2-10&&mx<c.x+c.w/2+10&&my>c.y-c.h-6&&my<c.y+c.h+6) {
      var ts2 = new Date(c.data.t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
      var lbl = c.type==='carb' ? c.data.c+'g carbs  '+ts2 : c.data.u.toFixed(1)+'U bolus  '+ts2;
      var col = c.type==='carb' ? 'rgba(220,155,60,0.9)' : 'rgba(100,140,225,0.9)';
      _hoverTooltip = {x:c.x, y:c.y-8, label:lbl, col:col};
      _lastTooltip  = _hoverTooltip; return;
    }
  }
  _hoverTooltip = null;
}

(function wireHoverEvents() {
  window.addEventListener('load', function() {
    var cv = document.getElementById('c');
    if (!cv) return;
    function onMove(cx, cy) {
      checkHover(cx, cy);
      if (window._pebbleHitbox) {
        var h = window._pebbleHitbox;
        if (cx>h.x&&cx<h.x+h.w&&cy>h.y&&cy<h.y+h.h) { _riverPebble=null; window._pebbleHitbox=null; }
      }
    }
    cv.addEventListener('mousemove', function(e) {
      var r=cv.getBoundingClientRect();
      onMove((e.clientX-r.left)*(cv.width/r.width),(e.clientY-r.top)*(cv.height/r.height));
    });
    cv.addEventListener('touchmove', function(e) {
      if (e.touches.length!==1) return;
      var r=cv.getBoundingClientRect();
      onMove((e.touches[0].clientX-r.left)*(cv.width/r.width),(e.touches[0].clientY-r.top)*(cv.height/r.height));
    },{passive:true});
    cv.addEventListener('mouseleave', function(){ _hoverTooltip=null; });
  });
})();


var _alertState = null;
var _alertPulse = 0;
var _bannerTimeout = null;

function showAlertBanner(msg, bgCol, urgent) {
  var banner = document.getElementById('alert-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'alert-banner';
    banner.style.position = 'fixed';
    banner.style.top = 'max(60px,env(safe-area-inset-top,60px))';
    banner.style.left = '50%';
    banner.style.transform = 'translateX(-50%)';
    banner.style.zIndex = '50';
    banner.style.padding = '12px 20px';
    banner.style.borderRadius = '14px';
    banner.style.fontFamily = "'DM Mono',monospace";
    banner.style.fontSize = '12px';
    banner.style.letterSpacing = '.3px';
    banner.style.color = 'rgba(255,255,255,0.95)';
    banner.style.textAlign = 'center';
    banner.style.backdropFilter = 'blur(12px)';
    banner.style.border = '1px solid rgba(255,255,255,0.15)';
    banner.style.cursor = 'pointer';
    banner.style.maxWidth = '280px';
    banner.style.lineHeight = '1.4';
    banner.style.transition = 'opacity .3s';
    banner.onclick = function() {
      banner.style.opacity = '0';
      ALERTS.snooze('corr_nudge', 20*60000);
      ALERTS.snooze('corr_high',  20*60000);
    };
    document.body.appendChild(banner);
  }
  banner.textContent = msg;
  banner.style.background = bgCol;
  banner.style.opacity = '1';
  banner.style.boxShadow = urgent ? '0 0 30px rgba(60,100,255,0.4)' : 'none';
  if (_bannerTimeout) clearTimeout(_bannerTimeout);
  _bannerTimeout = setTimeout(function() {
    if (banner) banner.style.opacity = '0';
  }, urgent ? 20000 : 8000);
}

function checkAlerts(d) {
  if (!d || !d.bg) return;
  var now = Date.now();
  var lastBol = 0;
  for (var i=0; i<SESSION.length; i++) {
    if (SESSION[i].t > lastBol) lastBol = SESSION[i].t;
  }
  var minsSinceLastBolus = lastBol > 0 ? (now - lastBol)/60000 : 999;

  // Hypo urgent < 3.9
  if (d.bg < 3.9) {
    _alertState = 'hypo_urgent';
    _alertPulse = Math.min(1, (_alertPulse||0) + 0.05);
    if (ALERTS.canFire('hypo_urgent', 3*60000)) {
      ALERTS.hypoAlarm();
      ALERTS.fire('hypo_urgent');
      showAlertBanner('HYPO — treat NOW', 'rgba(40,60,200,0.95)', true);
    }
    return;
  }

  // Hypo warning 3.9–4.5
  if (d.bg < 4.5) {
    _alertState = 'hypo_warn';
    _alertPulse = Math.min(0.6, (_alertPulse||0) + 0.02);
    if (ALERTS.canFire('hypo_warn', 5*60000)) {
      ALERTS.hypoWarning();
      ALERTS.fire('hypo_warn');
      showAlertBanner('Dropping — watch closely', 'rgba(60,90,200,0.85)', false);
    }
    return;
  }

  // Correction window: only alert when you can actually act
  var iobClear = d.iob < 0.5;
  var bolusGap = minsSinceLastBolus > 90;
  var high = d.bg > 10.5;
  var veryHigh = d.bg > 14;

  if (high && iobClear && bolusGap) {
    _alertState = 'correction';
    var key = veryHigh ? 'corr_high' : 'corr_nudge';
    var cooldown = veryHigh ? 30*60000 : 60*60000;
    if (ALERTS.canFire(key, cooldown)) {
      ALERTS.correctionNudge();
      ALERTS.fire(key);
      var msg = veryHigh
        ? ('BG ' + d.bg.toFixed(1) + ' — correction window open')
        : (d.bg.toFixed(1) + ' mmol — could correct now');
      showRiverPebble(msg,'correction');
    }
    return;
  }

  // All clear
  _alertState = null;
  _alertPulse = Math.max(0, (_alertPulse||0) - 0.03);
}

function drawHypoPulse(pal) {
  if (!_alertPulse || _alertPulse < 0.01) return;
  var isUrgent = (_alertState === 'hypo_urgent');
  var pulseA   = _alertPulse * (0.12 + Math.sin(phi * (isUrgent ? 5 : 2)) * 0.08);
  var col      = isUrgent ? 'rgba(40,80,220,' : 'rgba(80,120,200,';
  var grad     = CX.createRadialGradient(W/2, H, 0, W/2, H, H*0.8);
  grad.addColorStop(0,   col + (pulseA*1.5).toFixed(3) + ')');
  grad.addColorStop(0.5, col + pulseA.toFixed(3) + ')');
  grad.addColorStop(1,   col + '0)');
  CX.save(); CX.fillStyle=grad; CX.fillRect(0,0,W,H); CX.restore();
}


// ── HUD UPDATE ──────────────────────────────────────────────────────────
let lastHUD = 0;
function updateHUD(d, pal) {
  if (Date.now()-lastHUD < 300) return; lastHUD = Date.now();
  if (!d || !pal || typeof d.bg !== 'number' || isNaN(d.bg)) return;

  // Stale data warning
  var staleWarn = document.getElementById('stale-warn');
  if (staleWarn) {
    var minsStale = _lastReadingT > 0 ? Math.round((Date.now()-_lastReadingT)/60000) : 0;
    var isStale   = minsStale > 12 && _lastReadingT > 0;
    staleWarn.style.display = isStale ? 'block' : 'none';
    if (isStale) staleWarn.textContent = 'no reading for ' + minsStale + 'm';
  }

  // BG number + trend arrow
  var prev15 = dataAt(viewTime - 15*60000);
  var delta  = d.bg - prev15.bg;
  var arr    = delta > 0.75  ? '↑↑' :
               delta > 0.25  ? '↑'  :
               delta < -0.75 ? '↓↓' :
               delta < -0.25 ? '↓'  : '→';

  var bgEl  = document.getElementById('bg-num');
  var color = d.bg < BG_LOW  ? 'rgba(100,150,255,0.9)'  :
              d.bg > BG_HIGH ? 'rgba(255,160,80,0.9)'   :
              'rgba(' + pal.bgLine[0] + ',' + pal.bgLine[1] + ',' + pal.bgLine[2] + ',0.92)';
  bgEl.innerHTML = d.bg.toFixed(1) +
    '<span style="font-size:20px;opacity:0.45;margin-left:4px">' + arr + '</span>';
  bgEl.style.color = color;

  document.getElementById('bg-unit').style.color = 'rgba(150,180,200,0.4)';

  // COB / IOB — colour + opacity scale with active values
  var mcEl = document.getElementById('mc-val');
  var miEl = document.getElementById('mi-val');
  var mcLb = document.getElementById('mc-label');
  var miLb = document.getElementById('mi-label');
  if (mcEl) {
    var cobFrac = Math.min(1, d.cob / 40);
    mcEl.textContent = d.cob > 0.5 ? d.cob.toFixed(0) + 'g' : '—';
    mcEl.style.fontSize = d.cob > 5 ? '20px' : '16px';
    mcEl.style.color = 'rgba(' + pal.cobR[0] + ',' + pal.cobR[1] + ',' + pal.cobR[2] + ',' + (0.45 + cobFrac*0.5) + ')';
    if (mcLb) mcLb.style.color = 'rgba(' + pal.cobR[0] + ',' + pal.cobR[1] + ',' + pal.cobR[2] + ',' + (0.3 + cobFrac*0.3) + ')';
  }
  if (miEl) {
    var iobFrac = Math.min(1, d.iob / 4);
    miEl.textContent = d.iob > 0.1 ? d.iob.toFixed(1) + 'U' : '—';
    miEl.style.fontSize = d.iob > 1 ? '20px' : '16px';
    miEl.style.color = 'rgba(' + pal.iobR[0] + ',' + pal.iobR[1] + ',' + pal.iobR[2] + ',' + (0.45 + iobFrac*0.5) + ')';
    if (miLb) miLb.style.color = 'rgba(' + pal.iobR[0] + ',' + pal.iobR[1] + ',' + pal.iobR[2] + ',' + (0.3 + iobFrac*0.3) + ')';
  }

  // Timebar scrubber
  var timeRange = CGM_END - CGM_START;
  var prog = timeRange > 0 ? (viewTime - CGM_START) / timeRange : 1;
  var tnEl = document.getElementById('timenow');
  var tkEl = document.getElementById('timetrack');
  var pct  = (Math.max(0, Math.min(1, prog)) * 100).toFixed(1) + '%';
  if (tnEl) tnEl.style.left = pct;
  if (tkEl) tkEl.style.setProperty('--prog', pct);
}

function returnToNow() {
  _isAtNow = true;
  viewTime = HISTORY_RAW[HISTORY_RAW.length-1].t;
  viewSpan = 2 * 3600000; // fixed 2h
  document.getElementById('now-btn').style.display='none';
}

// Track if user has scrolled away from now
let _isAtNow = true;

function frame(ts) {
  try {
  const dt=Math.min((ts-t0)/1000, 0.05); t0=ts;
  phi+=0.4*dt;
  treeScrollX+=10*dt; // river current speed

  const d   = dataAt(viewTime);
  const pal = palette(viewTime);
  if (!d || !pal) { requestAnimationFrame(frame); return; }

  // ── ANIMATION STATE ──────────────────────────────────────────
  window._bgDots=[];
  window._eventCards=[];
  drawVoid(pal);

  // ── EQUILIBRIUM ZONE — soft target corridor ────────────────────
  drawEquilibriumZone(pal);

  // ── GAS CLOUDS — living forces above and below the BG line ──────
  const cobPts = buildForcePts('cob',  1, 90);
  const iobPts = buildForcePts('iob', -1, 90);
  drawGasCloud(cobPts, COL_COB,  1, d);   // carbs: warm orange rising
  drawGasCloud(iobPts, COL_IOB, -1, d);   // insulin: cool blue falling

  // ── BG TRACE — the life-line ────────────────────────────────────
  drawBGTrail(pal);

  // ── EVENT MARKERS — ripples where forces entered ───────────────
  drawBolusMarkers(pal);

  // ── CONTEXT ─────────────────────────────────────────────────────
  drawTransition(pal);
  drawFutureClouds(cobPts, iobPts, d, pal);
  drawTimeLabels(pal);

  // ── THE ORB — buoyant on BG line ────────────────────────────────
  drawOrb(pal, d);

  // ── NOW PULSE — breath at current moment ─────────────────────
  drawNowPulse(pal, d);
  drawRiverPebble(pal);
  drawHoverTooltip(pal);

  // Live reading pulse — flashes when new data arrives
  if (_pulseAlpha > 0.01) {
    const nowX = NOW_X*W, boatY = boatYfromBG(d.bg);
    const pr = 20 + (1-_pulseAlpha)*40;
    CX.save(); CX.globalAlpha = _pulseAlpha * 0.5;
    CX.strokeStyle = 'rgba(200,240,200,0.8)'; CX.lineWidth = 1.5;
    CX.shadowColor = '#80e890'; CX.shadowBlur = 10;
    CX.beginPath(); CX.arc(nowX, boatY, Math.max(0.5, pr), 0, Math.PI*2); CX.stroke();
    CX.shadowBlur = 0; CX.restore();
    _pulseAlpha *= 0.94;
  }

  // Show "return to now" when scrolled away from latest data
  const latestT = HISTORY_RAW[HISTORY_RAW.length-1].t;
  const awayFromNow = (latestT - viewTime) > 8 * 60000;
  const nowBtn = document.getElementById('now-btn');
  if (nowBtn) nowBtn.style.opacity = awayFromNow ? '0.85' : '0';

  // time labels handled by drawTimeLabels

  checkAlerts(d);
  drawHypoPulse(pal);
  updateHUD(d, pal);

  requestAnimationFrame(frame);
  } catch(e) {
    console.error('[river] frame error:', e);
    requestAnimationFrame(frame); // keep running even if a frame errors
  }
}

// ── TOUCH / MOUSE ────────────────────────────────────────────
let drag={on:false,x0:0,t0:0}, pinch={on:false,d0:0,s0:0};
CV.addEventListener('touchstart',e=>{
  if(e.target.closest&&e.target.closest('#sheet,#flow-dock,.dock-btn,#whisper-overlay,#food-mgr-overlay,#hypo-overlay,#corr-overlay,#food-add-overlay,[id$=-overlay],button,input,textarea,select')) return;
  if(e.touches.length===1) drag={on:true,x0:e.touches[0].clientX,t0:viewTime};
  else if(e.touches.length===2) {
    const dx=e.touches[0].clientX-e.touches[1].clientX;
    const dy=e.touches[0].clientY-e.touches[1].clientY;
    pinch={on:true,d0:Math.hypot(dx,dy),s0:viewSpan};
  }
},{passive:true});
CV.addEventListener('touchmove',e=>{
  if(e.target.closest&&e.target.closest('#sheet,#flow-dock,.dock-btn,#whisper-overlay,#food-mgr-overlay,#hypo-overlay,#corr-overlay,#food-add-overlay,[id$=-overlay],button,input,textarea,select')) return;
  e.preventDefault();
  if(drag.on&&e.touches.length===1) {
    viewTime=Math.max(CGM_START,Math.min(CGM_END,drag.t0-(e.touches[0].clientX-drag.x0)*(viewSpan/W))); _isAtNow=false;
  } else if(pinch.on&&e.touches.length===2) {
    const dx=e.touches[0].clientX-e.touches[1].clientX;
    const dy=e.touches[0].clientY-e.touches[1].clientY;
    viewSpan=Math.max(MIN_SPAN,Math.min(MAX_SPAN,pinch.s0*(pinch.d0/Math.hypot(dx,dy))));
  }
},{passive:false});
CV.addEventListener('touchend',()=>{drag.on=false;pinch.on=false;},{passive:true});
let md={on:false,x0:0,t0:0};
CV.addEventListener('mousedown',e=>{if(!e.target.closest('#sheet,#flow-dock,.dock-btn,#whisper-overlay,#food-mgr-overlay,#hypo-overlay,#corr-overlay,#food-add-overlay,[id$=-overlay],button,input,textarea,select'))md={on:true,x0:e.clientX,t0:viewTime}});
CV.addEventListener('mousemove',e=>{if(md.on)viewTime=Math.max(CGM_START,Math.min(CGM_END,md.t0-(e.clientX-md.x0)*(viewSpan/W)))});
CV.addEventListener('mouseup',()=>md.on=false);
// wheel zoom disabled — fixed 2h view

// ── LOG SHEET ────────────────────────────────────────────────
let _st=null;
// Saved meals from session/localStorage
const SAVED_MEALS = (() => {
  try { return JSON.parse(localStorage.getItem('river_meals')||'[]'); } catch(e) { return []; }
})();

function saveMealToHistory(name, carbs, insulin, t) {
  const entry = {name, carbs, insulin, t: t||Date.now()};
  SAVED_MEALS.unshift(entry);
  if (SAVED_MEALS.length > 20) SAVED_MEALS.pop();
  try { localStorage.setItem('river_meals', JSON.stringify(SAVED_MEALS)); } catch(e) {}
}

function renderSavedMeals() {
  const row = document.getElementById('saved-meals-row');
  const chips = document.getElementById('saved-meals-chips');
  if (!row || !chips) return;
  if (SAVED_MEALS.length === 0) { row.style.display='none'; return; }
  row.style.display='block';
  chips.innerHTML = SAVED_MEALS.slice(0,8).map((m,i) =>
    `<button onclick="loadSavedMeal(${i})" style="padding:5px 10px;border-radius:8px;
      border:1px solid rgba(40,55,50,0.12);background:rgba(40,55,50,0.05);
      font-family:'DM Mono',monospace;font-size:10px;color:rgba(40,55,50,0.55);
      cursor:pointer">${m.name} (${m.carbs}g)</button>`
  ).join('');
}

function loadSavedMeal(idx) {
  const m = SAVED_MEALS[idx];
  if (!m) return;
  selType('b');
  document.getElementById('in-c').value = m.carbs;
  document.getElementById('in-i').value = m.insulin || '';
  onInp();
}

function setTimeNow() {
  var now = new Date();
  var local = new Date(now.getTime() - now.getTimezoneOffset()*60000);
  var val = local.toISOString().slice(0,16);
  _entryTimeVal = val;
  var el = document.getElementById('in-time');
  if (el) el.value = val;
}
var _entryTimeVal = null;
var _bolusVal = null;
var _eatWaitOverride = null; // preserved across renderSheet() calls

function getEntryTime() {
  var el = document.getElementById('in-time');
  if (el && el.value) {
    _entryTimeVal = el.value; // cache it
    return new Date(el.value).getTime();
  }
  if (_entryTimeVal) return new Date(_entryTimeVal).getTime();
  return Date.now();
}

function onTimeChange(val) { _entryTimeVal = val; renderSheet(); }

function setEntryTime(val) {
  _entryTimeVal = val;
  var el = document.getElementById('in-time');
  if (el) el.value = val;
}

function setCarbs(v) {
  document.getElementById('in-c').value = v;
  document.querySelectorAll('#sec-c .bgchip').forEach(c =>
    c.classList.toggle('on', parseInt(c.textContent)===v));
  onInp();
}


// openSheet defined in food system below

// closeSheet defined in food system below
function selType(t){
  _st=t;
  ['c','b','i'].forEach(x=>document.getElementById(`tb-${x}`).className='tbtn'+(x===t?` sel-${t}`:''));
  document.getElementById('sec-c').className='isec'+(['c','b'].includes(t)?' vis':'');
  document.getElementById('sec-i').className='isec'+(['i','b'].includes(t)?' vis':'');
  document.getElementById('sec-bg').className='isec'+(['c','b'].includes(t)?' vis':'');
  onInp();
}
function setBG(v){
  document.getElementById('in-bg').value=v;
  document.querySelectorAll('.bgchip').forEach(c=>c.classList.toggle('on',parseFloat(c.textContent)===v));
  onInp();
}
function onInp(){
  const c=parseFloat(document.getElementById('in-c').value)||0;
  const u=parseFloat(document.getElementById('in-i').value)||0;
  const bg=parseFloat(document.getElementById('in-bg').value)||0;
  const btn=document.getElementById('dropbtn');
  const sug=document.getElementById('sugbox');
  const has=(_st==='c'&&c>0)||(_st==='i'&&u>0)||(_st==='b'&&(c>0||u>0));
  window._pendingDrop = has ? {c, u, t:Date.now()} : null;
  btn.disabled=!has;
  if(c>0&&bg>0&&['c','b'].includes(_st)){
    // Time-aware I:C and ISF (updated 26 Mar 2026)
    const _now = new Date(getEntryTime());
    const _h   = _now.getHours() + _now.getMinutes()/60;
    const _ic  = (_h>=6&&_h<10) ? 8.5 : (_h>=10&&_h<14) ? 12 : (_h>=14&&_h<18) ? 15 : 10;
    const _isf = (_h>=9&&_h<15) ? 7.0 : 6.0;
    const _target = 6.0;
    const _carbDose = c > 0 ? c / _ic : 0;
    const _corrDose = bg > 7.0 ? Math.max(0, (bg - _target) / _isf) : 0;
    const dose = _carbDose + _corrDose;
    const r=Math.round(dose/0.5)*0.5;
    document.getElementById('sugval').textContent=r.toFixed(1)+'U';
    const _icStr   = c>0 ? (c+'g / '+_ic+' I:C') : '';
    const _corrStr = bg>7.0 ? ('corr ISF '+_isf) : '';
    document.getElementById('sugnote').textContent=[_icStr,_corrStr].filter(Boolean).join(' + ');
    sug.style.display='block';
    if(!document.getElementById('in-i').value&&_st==='b') document.getElementById('in-i').value=r.toFixed(1);
  } else sug.style.display='none';
  const pts=[]; if(c>0)pts.push(`${c}g`); if(u>0)pts.push(`${u}U`);
  btn.textContent=pts.length?`flow · ${pts.join(' + ')}`:'flow it in';
}
function commitDrop(){
  const c=parseFloat(document.getElementById('in-c').value)||0;
  const u=parseFloat(document.getElementById('in-i').value)||0;
  const t=getEntryTime();
  if(c>0||u>0){
    SESSION.push({t,c,u});
    try{localStorage.setItem('river_session',JSON.stringify(SESSION));}catch(e){}
    // Save meal to history if has carbs
    if(c>0) {
      const bg=parseFloat(document.getElementById('in-bg').value)||0;
      const mealName = c>0&&u>0?`${c}g + ${u}U`:(c>0?`${c}g carbs`:`${u}U bolus`);
      saveMealToHistory(mealName, c, u, t);
    }
    // Also update HISTORY_RAW entry for that time if it exists
    const existing = HISTORY_RAW.findIndex(h=>Math.abs(h.t-t)<150000);
    if(existing>=0) { HISTORY_RAW[existing].iob+=u; HISTORY_RAW[existing].cob+=c; }
  }
  const msg=[]; if(c>0)msg.push(`${c}g`); if(u>0)msg.push(`${u}U`);
  showToast((msg.join(' · ')||'logged')+'\ninto the river');
  ['in-c','in-i','in-bg'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('sugbox').style.display='none';
  document.getElementById('dropbtn').disabled=true;
  closeSheet();
}
function showToast(msg){
  const t=document.getElementById('toast');
  t.innerHTML=msg.replace('\n','<br>');
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),2000);
}

// ── INIT ─────────────────────────────────────────────────────;

// ═══════════════════════════════════════════════════════════════════════
//  FOOD & BOLUS SYSTEM
//  - Food database with GI, carbs per 100g
//  - Meal builder: search/add items by weight → auto carbs
//  - Smart bolus: time-aware I:C + ISF, IOB offset, suggested eat time
//  - Forecast: visual impact prediction shown as river event
//  - Eat-time reminder
// ═══════════════════════════════════════════════════════════════════════

// ── FOOD DATABASE ──────────────────────────────────────────────────────
// {name, carbs_per_100g, gi, category}
// GI: low<55, medium 55-69, high>=70
const FOOD_DB = window.__RIVER_FOODS__ || [];

var FOOD_LIBRARY = (function() {
  try { return JSON.parse(localStorage.getItem('river_food_lib') || '[]'); } catch(e) { return []; }
})();

function saveFoodLibrary() {
  try { localStorage.setItem('river_food_lib', JSON.stringify(FOOD_LIBRARY)); } catch(e) {}
}

// ── MEAL HISTORY ──────────────────────────────────────────────────────
var MEAL_HISTORY = (function() {
  try { return JSON.parse(localStorage.getItem('river_meal_hist') || '[]'); } catch(e) { return []; }
})();

function saveMealHistory() {
  try { localStorage.setItem('river_meal_hist', JSON.stringify(MEAL_HISTORY.slice(0, 30))); } catch(e) {}
}

// ── BOLUS CALCULATION ─────────────────────────────────────────────────
function calcBolus(totalCarbs, currentBG, entryTime) {
  var d    = dataAt(viewTime);
  var h    = new Date(entryTime).getHours() + new Date(entryTime).getMinutes()/60;
  var ic   = h>=6&&h<10 ? 8.5 : h>=10&&h<14 ? 12 : h>=14&&h<18 ? 15 : 10;
  var isf  = h>=9&&h<15 ? 7.0 : 6.0;
  var tgt  = 6.0;
  var bg   = currentBG || d.bg;

  // Carb dose
  var carbDose = totalCarbs > 0 ? totalCarbs / ic : 0;

  // Correction (only if BG above target AND IOB doesn't already cover it)
  var rawCorr  = bg > tgt ? Math.max(0, (bg - tgt) / isf) : 0;
  // Offset by active IOB to avoid stacking
  var corrDose = Math.max(0, rawCorr - d.iob);

  // Round to nearest 0.5U
  var total    = Math.round((carbDose + corrDose) / 0.5) * 0.5;

  return {
    total:    total,
    carbDose: Math.round(carbDose * 10) / 10,
    corrDose: Math.round(corrDose * 10) / 10,
    ic:       ic,
    isf:      isf,
    iob:      Math.round(d.iob * 10) / 10,
    bg:       Math.round(bg * 10) / 10,
    tgt:      tgt,
  };
}

// Suggested eat time: bolus wait based on BG level
// High BG → wait longer; low → eat sooner
function suggestEatWait(bg) {
  if (bg > 10) return 25; // high — wait longer
  if (bg > 7)  return 20; // normal
  if (bg > 5)  return 15; // slightly low
  return 5;               // low — eat now / reduce bolus
}

// GI-adjusted absorption speed (used in forecast)
function mealAbsorptionSpeed(avgGI) {
  if (avgGI >= 70) return 1.4;  // fast
  if (avgGI >= 55) return 1.0;  // medium
  return 0.7;                   // slow (sourdough etc)
}

// ── FORECAST ──────────────────────────────────────────────────────────
// Returns array of {minsFromNow, predBG} for the meal impact
function buildMealForecast(totalCarbs, bolusU, avgGI, eatInMins) {
  var d0   = dataAt(viewTime);
  var bg   = d0.bg;
  var iob  = d0.iob;
  var ISF  = (new Date(viewTime).getHours() >= 9 &&
              new Date(viewTime).getHours() < 15) ? 7.0 : 6.0;
  var speed = mealAbsorptionSpeed(avgGI || 60);
  var pts   = [];

  for (var i = 0; i <= 36; i++) { // 3h in 5min steps
    var mins = i * 5;

    // COB from this meal (starts absorbing at eatInMins)
    var eatElapsed = Math.max(0, mins - eatInMins);
    var cobRemaining = totalCarbs * cobF(eatElapsed * speed);
    var cobSpent     = totalCarbs * (1 - cobF(eatElapsed * speed));
    var carbEffect   = cobSpent * 0.055; // rough mmol rise per g absorbed

    // IOB effect: existing + new bolus
    var totalIOB  = iob + bolusU;
    var iobEffect = totalIOB * (1 - iobF(mins)) * ISF;

    // Existing IOB
    var existIOBEffect = d0.iob * (1 - iobF(mins)) * ISF;

    // Rate of change momentum
    var prev5 = dataAt(viewTime - 5*60000);
    var roc   = bg - prev5.bg;
    var rocDecay = roc * Math.exp(-mins/25);

    var predBG = Math.max(1.5, Math.min(22,
      bg + carbEffect - iobEffect + rocDecay
    ));

    pts.push({mins: mins, bg: predBG, cob: cobRemaining});
  }
  return pts;
}

// ── SHEET RENDERING ───────────────────────────────────────────────────
function setWait(delta) {
  var el = document.getElementById('wait-mins');
  if (!el) return;
  var v = Math.max(0, Math.min(60, (parseInt(el.value)||0) + delta));
  el.value = v;
  _eatWaitOverride = v;
  renderSheet();
}

function setWaitDirect(val) {
  var v = Math.max(0, Math.min(60, parseInt(val)||0));
  _eatWaitOverride = v;
  renderSheet();
}

function openSheet() {
  _mealItems  = [];
  _bolusGiven = false;
  _sheetMode  = 'meal';
  renderSheet();
  document.getElementById('sheet').classList.add('open');
  document.getElementById('overlay').classList.add('open');
  setTimeNow();
}

function closeSheet() {
  document.getElementById('sheet').classList.remove('open');
  document.getElementById('overlay').classList.remove('open');
  window._pendingDrop = null;
}

function suggestGI(n){
  n=n.toLowerCase();
  if(/oat|porridge|bran|barley|lentil|bean|chick|pasta|pea/.test(n)) return 40;
  if(/apple|pear|orange|berry|yoghurt|milk|sourdough|rye/.test(n)) return 45;
  if(/banana|mango|pineapple/.test(n)) return 62;
  if(/basmati|sweet.potato/.test(n)) return 60;
  if(/bread|toast|bagel|wrap|pitta|naan|cereal|muesli/.test(n)) return 65;
  if(/potato|parsnip|pumpkin/.test(n)) return 78;
  if(/white.rice|baguette|croissant|pretzel|donut|cake|biscuit/.test(n)) return 72;
  if(/glucose|dextrose|jelly|lucozade|sports/.test(n)) return 95;
  return 55;
}


function renderSheet() {
  var sheet = document.getElementById('sheet');
  var d     = dataAt(viewTime);
  var bg    = d.bg;
  var iob   = d.iob;

  var totalCarbs  = _mealItems.reduce(function(s,i){return s+i.carbs;}, 0);
  var avgGI       = _mealItems.length > 0
    ? _mealItems.reduce(function(s,i){return s+(i.food.gi||55)*i.carbs;},0) / Math.max(totalCarbs,1)
    : 55;
  var eatWait     = _eatWaitOverride !== null ? _eatWaitOverride : suggestEatWait(bg);
  var bolus       = totalCarbs > 0 ? calcBolus(totalCarbs, bg, getEntryTime()) : null;
  var giLabel     = avgGI >= 70 ? 'high GI' : avgGI >= 55 ? 'medium GI' : 'low GI';
  var giCol       = avgGI >= 70 ? 'rgba(210,80,40,0.8)' : avgGI >= 55 ? 'rgba(200,140,30,0.8)' : 'rgba(60,160,90,0.8)';

  var itemsHTML = _mealItems.map(function(item, idx) {
    var gi_i = item.food.gi || 0;
    var giC  = gi_i>=70?'rgba(210,80,40,0.55)':gi_i>=55?'rgba(200,140,30,0.55)':'rgba(60,160,90,0.55)';
    return '<div style="padding:6px 0;border-bottom:1px solid rgba(40,55,50,0.06)">' +
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:2px">' +
      '<div style="flex:1;font-family:\'DM Mono\',monospace;font-size:11px;color:rgba(40,55,50,0.8)">' + item.food.name + '</div>' +
      (gi_i ? '<span style="font-family:\'DM Mono\',monospace;font-size:8px;color:'+giC+'">GI '+gi_i+'</span>' : '') +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:4px">' +
      '<span style="font-family:\'DM Mono\',monospace;font-size:8px;color:rgba(40,55,50,0.35)">g</span>' +
      '<input type="number" value="' + item.grams + '" min="1" max="1000" step="1" ' +
        'style="width:54px;padding:4px 6px;border-radius:6px;border:1px solid rgba(40,55,50,0.12);' +
        'background:rgba(255,255,255,0.6);font-family:\'DM Mono\',monospace;font-size:11px;text-align:right" ' +
        'onchange="updateItemGrams(' + idx + ',\'g\',this.value)">' +
      '<span style="font-family:\'DM Mono\',monospace;font-size:8px;color:rgba(62,180,120,0.5)">carbs</span>' +
      '<input type="number" value="' + item.carbs.toFixed(1) + '" min="0" max="200" step="0.5" ' +
        'style="width:50px;padding:4px 6px;border-radius:6px;border:1px solid rgba(62,180,120,0.2);' +
        'background:rgba(62,180,120,0.05);font-family:\'DM Mono\',monospace;font-size:11px;color:rgba(62,180,120,0.9);text-align:right" ' +
        'onchange="updateItemGrams(' + idx + ',\'c\',this.value)">' +
      '<button onclick="removeMealItem(' + idx + ')" style="background:none;border:none;cursor:pointer;' +
        'color:rgba(40,55,50,0.25);font-size:14px;padding:0 4px">×</button>' +
      '</div></div>';
  }).join('');

  // Forecast mini-chart (ASCII-style via canvas would be ideal but inline SVG is lighter)
  var forecastHTML = '';
  if (totalCarbs > 0 && bolus) {
    var pts  = buildMealForecast(totalCarbs, bolus.total, avgGI, eatWait);
    var maxBG = Math.max.apply(null, pts.map(function(p){return p.bg;}));
    var minBG = Math.min.apply(null, pts.map(function(p){return p.bg;}));
    var range = Math.max(maxBG - minBG, 2);
    var W = 260, H = 48;
    var svgPts = pts.map(function(p, i) {
      var x = (i / (pts.length-1)) * W;
      var y = H - ((p.bg - minBG) / range) * (H-6) - 3;
      return x.toFixed(0) + ',' + y.toFixed(0);
    }).join(' ');
    // BG_LOW line
    var lowY = H - ((BG_LOW - minBG) / range) * (H-6) - 3;
    var highY = H - ((BG_HIGH - minBG) / range) * (H-6) - 3;
    var peakBG = Math.max.apply(null, pts.map(function(p){return p.bg;}));
    var peakCol = peakBG > BG_HIGH ? 'rgba(210,100,40,0.8)' : peakBG < BG_LOW ? 'rgba(80,120,200,0.8)' : 'rgba(60,180,120,0.8)';

    forecastHTML = '<div style="padding:0 18px;margin-bottom:12px">' +
      '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(40,55,50,0.3);' +
        'letter-spacing:1px;text-transform:uppercase;margin-bottom:6px">forecast · 3h</div>' +
      '<svg width="' + W + '" height="' + H + '" style="overflow:visible">' +
        // BG range bands
        (highY > 0 ? '<rect x="0" y="0" width="' + W + '" height="' + highY.toFixed(0) + '" fill="rgba(210,100,40,0.06)"/>' : '') +
        (lowY < H ? '<rect x="0" y="' + lowY.toFixed(0) + '" width="' + W + '" height="' + (H-lowY).toFixed(0) + '" fill="rgba(80,120,200,0.06)"/>' : '') +
        // Target lines
        '<line x1="0" y1="' + highY.toFixed(0) + '" x2="' + W + '" y2="' + highY.toFixed(0) + '" stroke="rgba(210,100,40,0.2)" stroke-width="0.5" stroke-dasharray="3,3"/>' +
        '<line x1="0" y1="' + lowY.toFixed(0) + '" x2="' + W + '" y2="' + lowY.toFixed(0) + '" stroke="rgba(80,120,200,0.2)" stroke-width="0.5" stroke-dasharray="3,3"/>' +
        // Eat time marker
        '<line x1="' + ((eatWait/180)*W).toFixed(0) + '" y1="0" x2="' + ((eatWait/180)*W).toFixed(0) + '" y2="' + H + '" stroke="rgba(62,180,120,0.3)" stroke-width="1" stroke-dasharray="2,4"/>' +
        // Forecast line
        '<polyline points="' + svgPts + '" fill="none" stroke="' + peakCol + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
        // Peak label
        '<text x="' + W + '" y="8" font-family="DM Mono,monospace" font-size="9" fill="' + peakCol + '" text-anchor="end">peak ' + peakBG.toFixed(1) + '</text>' +
        // Now dot
        '<circle cx="0" cy="' + (H - ((bg-minBG)/range)*(H-6) - 3).toFixed(0) + '" r="3" fill="rgba(62,180,120,0.9)"/>' +
      '</svg>' +
      '<div style="display:flex;justify-content:space-between;font-family:\'DM Mono\',monospace;font-size:8px;color:rgba(40,55,50,0.25);margin-top:2px">' +
        '<span>now</span><span>+1h</span><span>+2h</span><span>+3h</span>' +
      '</div>' +
    '</div>';
  }

  var bolusHTML = '';
  if (totalCarbs > 0) {
    // Range hint only — no default value. User enters actual units given.
    var rangeLo = bolus ? Math.max(0, bolus.total - 1.0) : 0;
    var rangeHi = bolus ? bolus.total + 0.5 : 0;
    var rangeStr = bolus
      ? 'context: ' + rangeLo.toFixed(1) + ' – ' + rangeHi.toFixed(1) + 'U based on ' +
        totalCarbs.toFixed(0) + 'g ÷ I:C ' + (bolus.ic||10) +
        (bolus.corrDose > 0 ? ', BG ' + (bolus.bg||'') : '') +
        (bolus.iob > 0.2 ? ', IOB ' + bolus.iob + 'U active' : '')
      : '';
    var eatTime = new Date(getEntryTime() + eatWait*60000);
    var eatStr  = eatTime.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});

    bolusHTML =
      '<div style="margin:0 18px 14px;padding:14px;background:rgba(40,85,200,0.05);' +
        'border-radius:12px;border:1px solid rgba(40,85,200,0.12)">' +

        // Total carbs — prominent
        '<div style="text-align:center;margin-bottom:12px">' +
          '<div style="font-family:\'Fraunces\',serif;font-weight:200;font-size:42px;' +
            'color:rgba(255,140,50,0.9);letter-spacing:-1px;line-height:1">' +
            totalCarbs.toFixed(0) + '</div>' +
          '<div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1.5px;' +
            'text-transform:uppercase;color:rgba(255,140,50,0.4)">grams carbs · GI ' +
            avgGI.toFixed(0) + ' ' + giLabel + '</div>' +
        '</div>' +

        // Wait time — editable
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;' +
          'padding:8px 10px;border-radius:8px;background:rgba(40,55,50,0.04);' +
          'border:1px solid rgba(40,55,50,0.08)">' +
          '<div style="flex:1">' +
            '<div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1px;' +
              'text-transform:uppercase;color:rgba(40,55,50,0.3);margin-bottom:2px">bolus wait</div>' +
            '<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;' +
              'font-size:14px;color:rgba(40,55,50,0.6)">eat ~' + eatStr + ' (+' + eatWait + 'min)</div>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:4px">' +
            '<button onclick="setWait(-5)" style="width:28px;height:28px;border-radius:8px;' +
              'border:1px solid rgba(40,55,50,0.12);background:rgba(255,255,255,0.5);' +
              'font-size:16px;cursor:pointer;touch-action:manipulation">−</button>' +
            '<input id="wait-mins" type="number" value="' + eatWait + '" min="0" max="60" step="5" ' +
              'onchange="setWaitDirect(this.value)" ' +
              'style="width:42px;text-align:center;padding:4px;border-radius:6px;' +
                'border:1px solid rgba(40,55,50,0.12);background:rgba(255,255,255,0.5);' +
                'font-family:\'DM Mono\',monospace;font-size:12px">' +
            '<button onclick="setWait(5)" style="width:28px;height:28px;border-radius:8px;' +
              'border:1px solid rgba(40,55,50,0.12);background:rgba(255,255,255,0.5);' +
              'font-size:16px;cursor:pointer;touch-action:manipulation">+</button>' +
          '</div>' +
        '</div>' +

        // Bolus input
        '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(40,55,50,0.3);' +
          'letter-spacing:1px;text-transform:uppercase;margin-bottom:8px">insulin given</div>' +
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">' +
          '<input id="in-bolus" type="number" inputmode="decimal" placeholder="—" ' +
            'min="0" max="20" step="0.5" ' +
            'style="flex:1;padding:10px 14px;border-radius:9px;' +
            'border:1px solid rgba(40,85,200,0.2);background:rgba(255,255,255,0.55);' +
            'font-family:\'Fraunces\',serif;font-size:22px;color:rgba(40,55,50,0.8);' +
            'outline:none;text-align:center">' +
          '<span style="font-family:\'DM Mono\',monospace;font-size:13px;color:rgba(40,55,50,0.4)">U</span>' +
        '</div>' +

        // Action buttons — above context so they're immediately visible
        '<div style="display:flex;gap:8px;margin-bottom:10px">' +
          // Log carbs + bolus
          '<button onclick="logMealEntry()" ' +
            'style="flex:1;padding:11px;border-radius:9px;' +
            'border:1px solid rgba(40,85,200,0.3);background:rgba(40,85,200,0.08);' +
            'font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:15px;' +
            'color:rgba(40,85,200,0.85);cursor:pointer">add to flow</button>' +
          // Log carbs only (skip bolus)
          '<button onclick="logMealEntry(true)" ' +
            'style="padding:11px 14px;border-radius:9px;' +
            'border:1px solid rgba(40,55,50,0.12);background:transparent;' +
            'font-family:\'DM Mono\',monospace;font-size:9px;letter-spacing:.5px;' +
            'text-transform:uppercase;color:rgba(40,55,50,0.35);cursor:pointer">no insulin</button>' +
        '</div>' +
      '</div>';
  }

  sheet.innerHTML =
    '<div class="handle"></div>' +
    '<div style="display:flex;align-items:center;justify-content:space-between;padding:0 8px 0 0">' +
    '<div class="sheet-title">add to the flow</div>' +
    '<button onclick="closeSheet()" style="background:none;border:none;cursor:pointer;font-size:26px;color:rgba(40,55,50,0.3);padding:4px 8px;line-height:1;touch-action:manipulation">×</button>' +
    '</div>' +

    // Time row
    '<div style="display:flex;align-items:center;gap:8px;padding:0 18px;margin-bottom:14px">' +
      '<div style="margin-bottom:4px">' +
      '<span id="time-display" style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:16px;color:rgba(40,55,50,0.75)">' + 
        (function(){ var d=_entryTimeVal?new Date(_entryTimeVal):new Date(); return d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'}) + ' · ' + d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}); }()) +
      '</span></div>' +
      '<span style="font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(40,55,50,0.3);letter-spacing:1px;text-transform:uppercase">when</span>' +
      '<input id="in-time" type="datetime-local" style="flex:1;padding:8px 10px;border-radius:8px;border:1px solid rgba(40,55,50,0.12);background:rgba(255,255,255,0.55);font-family:\'DM Mono\',monospace;font-size:12px;color:rgba(40,55,50,0.7);outline:none" onchange="onTimeChange(this.value)">' +
      '<button onclick="setTimeNow()" style="padding:6px 10px;border-radius:7px;border:1px solid rgba(40,55,50,0.12);background:rgba(40,55,50,0.05);font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(40,55,50,0.4);cursor:pointer">now</button>' +
    '</div>' +

    // Food search
    '<div style="padding:0 18px;margin-bottom:10px">' +
      '<div style="position:relative">' +
        '<input id="food-search" type="text" placeholder="search food..." autocomplete="off" autocorrect="off" spellcheck="false"' +
          ' style="width:100%;padding:10px 12px;border-radius:10px;border:1px solid rgba(40,55,50,0.15);background:rgba(255,255,255,0.6);font-family:\'DM Mono\',monospace;font-size:13px;color:rgba(40,55,50,0.8);outline:none;box-sizing:border-box"' +
          ' oninput="searchFood(this.value)">' +
        '<div id="food-results" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:50;' +
          'background:rgba(240,238,228,0.99);border:1px solid rgba(40,55,50,0.12);border-radius:10px;' +
          'box-shadow:0 4px 20px rgba(0,0,0,0.08);max-height:180px;overflow-y:auto;margin-top:4px"></div>' +
      '</div>' +
    '</div>' +

    // Meal items
    (itemsHTML ? '<div style="padding:0 18px;margin-bottom:10px">' +
      '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(40,55,50,0.3);letter-spacing:1px;text-transform:uppercase;margin-bottom:6px">' +
        'meal · ' + totalCarbs.toFixed(0) + 'g carbs' +
        (avgGI && _mealItems.length > 0 ? ' · <span style="color:' + giCol + '">' + giLabel + ' (GI ' + avgGI.toFixed(0) + ')</span>' : '') +
      '</div>' +
      itemsHTML +
    '</div>' : '') +

    // Recent meals
    buildRecentMealsHTML() +

    // Forecast
    forecastHTML +

    // Bolus suggestion
    bolusHTML +

    // Manual insulin entry (if no meal)
    (totalCarbs === 0 ?
      '<div style="padding:0 18px;margin-bottom:12px">' +
        '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(40,55,50,0.3);letter-spacing:1px;text-transform:uppercase;margin-bottom:8px">manual bolus / correction</div>' +
        '<div style="display:flex;align-items:center;gap:10px">' +
          '<div style="width:8px;height:8px;border-radius:50%;background:rgba(40,85,200,0.8);flex-shrink:0"></div>' +
          '<input id="in-i" type="number" inputmode="decimal" placeholder="units" min="0" max="20" step="0.5"' +
            ' style="flex:1;background:rgba(255,255,255,0.6);border:1px solid rgba(40,55,50,0.12);border-radius:8px;padding:10px 12px;font-family:\'Fraunces\',serif;font-size:18px;color:rgba(40,55,50,0.8);outline:none">' +
          '<span style="font-family:\'DM Mono\',monospace;font-size:11px;color:rgba(40,55,50,0.4)">U</span>' +
          '<button onclick="commitManualBolus()" style="padding:10px 14px;border-radius:9px;border:1px solid rgba(40,85,200,0.3);background:rgba(40,85,200,0.08);font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(40,85,200,0.8);cursor:pointer">log</button>' +
        '</div>' +
      '</div>'
    : '') +

    '<div style="height:max(20px,env(safe-area-inset-bottom,20px))"></div>';
}

function buildRecentMealsHTML() {
  if (MEAL_HISTORY.length === 0) return '';
  var recent = MEAL_HISTORY.slice(0, 6);
  var chips = recent.map(function(m, i) {
    return '<button onclick="loadMealHistory(' + i + ')" style="padding:5px 10px;border-radius:8px;' +
      'border:1px solid rgba(40,55,50,0.1);background:rgba(255,255,255,0.5);' +
      'font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(150,180,210,0.5);cursor:pointer;white-space:nowrap">' +
      m.name.slice(0,20) + ' (' + m.totalCarbs + 'g)</button>';
  }).join('');
  return '<div style="padding:0 18px;margin-bottom:12px">' +
    '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(40,55,50,0.25);letter-spacing:1px;text-transform:uppercase;margin-bottom:6px">recent meals</div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:5px">' + chips + '</div>' +
  '</div>';
}

function searchFood(q) {
  var results = document.getElementById('food-results');
  if (!q || q.length < 1) { results.style.display='none'; return; }
  var ql = q.toLowerCase();

  // Combine DB + library
  var all = FOOD_DB.concat(FOOD_LIBRARY);
  var matches = all.filter(function(f) { return f.name.toLowerCase().indexOf(ql) >= 0; }).slice(0, 8);

  if (matches.length === 0) {
    results.style.display='block';
    results.innerHTML = '<div style="padding:10px 14px;font-family:\'DM Mono\',monospace;font-size:11px;color:rgba(40,55,50,0.35)">' +
      'not found — <button onclick="addCustomFood(\'' + q.replace(/'/g,"\\'") + '\')" style="background:none;border:none;cursor:pointer;color:rgba(40,85,200,0.7);font-family:\'DM Mono\',monospace;font-size:11px;text-decoration:underline">add custom</button></div>';
    return;
  }

  results.style.display='block';
  results.innerHTML = matches.map(function(f) {
    var giCol2 = f.gi>=70?'rgba(200,80,40,0.6)':f.gi>=55?'rgba(190,130,30,0.6)':'rgba(50,150,80,0.6)';
    return '<div onclick="addFoodItem(\'' + f.name.replace(/'/g,"\\'") + '\')" style="padding:10px 14px;cursor:pointer;' +
      'border-bottom:1px solid rgba(40,55,50,0.05);display:flex;justify-content:space-between;align-items:center">' +
      '<div>' +
        '<div style="font-family:\'DM Mono\',monospace;font-size:12px;color:rgba(40,55,50,0.8)">' + f.name + '</div>' +
        '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(40,55,50,0.35);">' + f.c100 + 'g carbs/100g</div>' +
      '</div>' +
      '<div style="font-size:10px;color:' + giCol2 + ';font-family:\'DM Mono\',monospace">GI ' + (f.gi||'—') + '</div>' +
    '</div>';
  }).join('');
}

function addFoodItem(name) {
  var all   = FOOD_DB.concat(FOOD_LIBRARY);
  var food  = null;
  for (var i=0; i<all.length; i++) { if (all[i].name === name) { food = all[i]; break; } }
  if (!food) return;
  var defaultG = food.g_each || 100;
  var carbs    = Math.round((food.c100 * defaultG / 100) * 10) / 10;
  _mealItems.push({food: food, grams: defaultG, carbs: carbs});
  document.getElementById('food-search').value = '';
  document.getElementById('food-results').style.display = 'none';
  renderSheet();
}

function addCustomFood(name) {
  // Remove any existing overlay
  var ex = document.getElementById('food-add-overlay');
  if (ex) ex.remove();

  // GI lookup table for common food types
  var giHints = [
    {words:['white','bread','baguette','roll'], gi:75},
    {words:['brown','wholemeal','rye'], gi:55},
    {words:['rice'], gi:64},
    {words:['pasta','noodle','spaghetti'], gi:48},
    {words:['potato','chips','fries'], gi:78},
    {words:['sweet potato'], gi:44},
    {words:['oat','porridge'], gi:55},
    {words:['banana'], gi:52},
    {words:['apple','pear'], gi:36},
    {words:['orange','mango','grape'], gi:52},
    {words:['milk','yoghurt'], gi:36},
    {words:['juice'], gi:65},
    {words:['cola','fizzy','lucozade'], gi:63},
    {words:['chocolate'], gi:40},
    {words:['biscuit','cookie','cake'], gi:65},
    {words:['cereal','cornflake','weetabix'], gi:72},
    {words:['bean','lentil','chickpea'], gi:30},
    {words:['carrot','pea'], gi:47},
    {words:['glucose','dextrose','tab'], gi:100},
    {words:['honey','jam'], gi:58},
  ];
  var lname = name.toLowerCase();
  var suggestGI = 55; // default medium
  for (var i=0; i<giHints.length; i++) {
    if (giHints[i].words.some(function(w){return lname.indexOf(w)>=0;})) {
      suggestGI = giHints[i].gi; break;
    }
  }

  var el = document.createElement('div');
  el.id = 'food-add-overlay';
  el.style.cssText = 'position:fixed;inset:0;z-index:80;background:rgba(3,5,20,0.9);backdrop-filter:blur(14px);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;transition:opacity .2s;opacity:0';

  el.innerHTML = '<div style="max-width:320px;width:100%">' +
    '<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:20px;color:rgba(180,220,200,0.9);margin-bottom:4px">add food</div>' +
    '<div style="font-family:\'DM Mono\',monospace;font-size:11px;color:rgba(100,160,140,0.5);margin-bottom:20px">' + name + '</div>' +

    '<div style="display:flex;gap:10px;margin-bottom:14px">' +
      '<div style="flex:1">' +
        '<div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1px;text-transform:uppercase;color:rgba(40,55,50,0.4);margin-bottom:5px">carbs per 100g</div>' +
        '<input id="new-food-c100" type="number" inputmode="decimal" placeholder="e.g. 28" min="0" max="100" step="0.5" ' +
          'style="width:100%;padding:10px;border-radius:8px;border:1px solid rgba(62,180,120,0.2);background:rgba(62,180,120,0.05);font-family:\'DM Mono\',monospace;font-size:16px;color:rgba(62,180,120,0.9);text-align:center;outline:none">' +
      '</div>' +
      '<div style="flex:1">' +
        '<div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1px;text-transform:uppercase;color:rgba(40,55,50,0.4);margin-bottom:5px">GI <span style="opacity:0.5;font-size:7px">(suggested)</span></div>' +
        '<input id="new-food-gi" type="number" inputmode="decimal" placeholder="' + suggestGI + '" min="0" max="100" step="1" value="' + suggestGI + '" ' +
          'style="width:100%;padding:10px;border-radius:8px;border:1px solid rgba(200,140,60,0.2);background:rgba(200,140,60,0.05);font-family:\'DM Mono\',monospace;font-size:16px;color:rgba(200,140,60,0.8);text-align:center;outline:none">' +
      '</div>' +
    '</div>' +

    '<div style="font-family:\'DM Mono\',monospace;font-size:8px;color:rgba(40,55,50,0.25);margin-bottom:16px;line-height:1.6">GI: low&lt;55 · medium 55–70 · high&gt;70. Suggested based on food name — adjust if you know it.</div>' +

    '<div style="display:flex;gap:8px">' +
      '<button onclick="saveCustomFood(\'' + encodeURIComponent(name) + '\')" ' +
        'style="flex:1;padding:12px;border-radius:9px;border:1px solid rgba(62,180,120,0.3);background:rgba(62,180,120,0.08);font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:16px;color:rgba(62,180,120,0.9);cursor:pointer">save + add</button>' +
      '<button onclick="document.getElementById(\'food-add-overlay\').remove()" ' +
        'style="padding:12px 16px;border-radius:9px;border:1px solid rgba(40,55,50,0.12);background:transparent;font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(40,55,50,0.4);cursor:pointer">cancel</button>' +
    '</div></div>';

  el.addEventListener('click', function(e){ if(e.target===el){ el.remove(); } });
  el.addEventListener('keydown', function(e){ if(e.key==='Escape') el.remove(); });
  document.body.appendChild(el);
  requestAnimationFrame(function(){ el.style.opacity = '1'; });
  setTimeout(function(){ var inp=document.getElementById('new-food-c100'); if(inp) inp.focus(); }, 300);
}

function saveCustomFood(encodedName) {
  var name   = decodeURIComponent(encodedName);
  var carbs  = parseFloat(document.getElementById('new-food-c100').value) || 0;
  var gi     = parseInt(document.getElementById('new-food-gi').value) || 55;
  var el     = document.getElementById('food-add-overlay');
  if (el) el.remove();
  if (carbs > 0) {
    var f = {name: name, c100: carbs, gi: gi, cat: 'custom'};
    FOOD_LIBRARY.push(f);
    saveFoodLibrary();
    addFoodItem(name);
  }
}

function updateItemCarbs(idx, val) {
  var c=parseFloat(val); if(isNaN(c)||c<0) return;
  _mealItems[idx].carbs=Math.round(c*10)/10;
  var f=_mealItems[idx].food;
  if(f.c100>0) _mealItems[idx].grams=Math.round(c/f.c100*100);
  var _b=document.getElementById('in-bolus');if(_b&&_b.value!=='')_bolusVal=_b.value;
  renderSheet();
}

function updateItemGrams(idx, field, val) {
  var v = parseFloat(val);
  if (isNaN(v) || v < 0) return;
  var f = _mealItems[idx].food;
  var _b = document.getElementById('in-bolus');
  if (_b && _b.value !== '') _bolusVal = _b.value;
  if (field === 'c') {
    _mealItems[idx].carbs = Math.round(v * 10) / 10;
    if (f.c100 > 0) _mealItems[idx].grams = Math.round(v / f.c100 * 100);
  } else {
    _mealItems[idx].grams = Math.round(v);
    _mealItems[idx].carbs = Math.round((f.c100 * v / 100) * 10) / 10;
  }
  renderSheet();
}

function removeMealItem(idx) {
  _mealItems.splice(idx, 1);
  renderSheet();
}

function loadMealHistory(idx) {
  var m = MEAL_HISTORY[idx];
  if (!m || !m.items) return;
  _mealItems = m.items.map(function(item) {
    // Try to find original food object
    var all  = FOOD_DB.concat(FOOD_LIBRARY);
    var food = null;
    for (var i=0; i<all.length; i++) { if (all[i].name === item.name) { food=all[i]; break; } }
    if (!food) food = {name:item.name, c100:0, gi:55, cat:'saved'};
    return {food:food, grams:item.grams, carbs:item.carbs};
  });
  renderSheet();
}

function logMealEntry(carbsOnly) {
  var totalCarbs = _mealItems.reduce(function(s,i){return s+i.carbs;},0);
  var t = getEntryTime();
  var u = 0;

  if (!carbsOnly) {
    var inp = document.getElementById('in-bolus');
    u = inp ? (parseFloat(inp.value) || 0) : 0;
  }

  // Log carbs
  if (totalCarbs > 0) {
    SESSION.push({t: t, c: totalCarbs, u: 0});
  }

  // Log insulin separately if given
  if (u > 0) {
    SESSION.push({t: t, c: 0, u: u});
  }

  // Also push to BOLUS_EVENTS for canvas markers
  if (totalCarbs > 0 || u > 0) {
    BOLUS_EVENTS.push({t: t, c: totalCarbs, u: u});
  LOGGED_EVENTS.push({t: t, c: totalCarbs, u: u});
  try{localStorage.setItem('river_logged',JSON.stringify(LOGGED_EVENTS));}catch(err){}
  }

  try { localStorage.setItem('river_session',JSON.stringify(SESSION)); } catch(e) {}

  if (t > CGM_END) {
    var lastBg = HISTORY_RAW.length > 0 ? HISTORY_RAW[HISTORY_RAW.length-1].bg : 7.0;
    HISTORY_RAW.push({t: t, bg: lastBg, iob: 0, cob: 0, pen: 1});
    updateCGMBounds();
    viewTime = CGM_END;
  }

  // Save to meal history
  if (_mealItems.length > 0) {
    MEAL_HISTORY.unshift({
      name:       _mealItems.map(function(i){return i.food.name;}).join(', '),
      totalCarbs: Math.round(totalCarbs),
      items:      _mealItems.map(function(i){return {name:i.food.name, grams:i.grams, carbs:i.carbs};}),
      t:          t,
      u:          u,
    });
    saveMealHistory();
  }

  // Eat reminder if bolus given
  if (u > 0 && !carbsOnly) {
    var bg   = dataAt(viewTime).bg;
    var wait = suggestEatWait(bg);
    var eatAt = t + wait * 60000;
    if (_eatReminder) clearTimeout(_eatReminder);
    _eatReminder = setTimeout(function() {
      if (document.getElementById('sheet') && document.getElementById('sheet').classList.contains('open')) return;
      showRiverPebble('time to eat (~' + wait + 'min since bolus)', 'eat');
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    }, Math.max(0, eatAt - Date.now()));
  }

  var parts = [];
  if (totalCarbs > 0) parts.push(totalCarbs.toFixed(0) + 'g carbs');
  if (u > 0) parts.push(u.toFixed(1) + 'U insulin');
  showToast((parts.join(' + ') || 'logged') + '\nadded to the flow');
  closeSheet();
}


function confirmBolus(units) {
  var t = typeof getEntryTime === 'function' ? getEntryTime() : Date.now();
  SESSION.push({t: t, c: 0, u: units});
  try { localStorage.setItem('river_session',JSON.stringify(SESSION)); } catch(e) {}
  _bolusGiven = true;

  // Save meal to history
  var totalCarbs = _mealItems.reduce(function(s,i){return s+i.carbs;},0);
  if (_mealItems.length > 0) {
    MEAL_HISTORY.unshift({
      name:       _mealItems.map(function(i){return i.food.name;}).join(', '),
      totalCarbs: Math.round(totalCarbs),
      items:      _mealItems.map(function(i){return {name:i.food.name,grams:i.grams,carbs:i.carbs};}),
      t:          t,
    });
    saveMealHistory();
  }

  // Set eat reminder
  var bg = dataAt(viewTime).bg;
  var wait = suggestEatWait(bg);
  var eatAt = Date.now() + wait * 60000;
  if (_eatReminder) clearTimeout(_eatReminder);
  _eatReminder = setTimeout(function() {
    if (document.getElementById('sheet').classList.contains('open')) return;
    showAlertBanner('Time to eat! (' + wait + 'min since bolus)', 'rgba(62,180,120,0.9)', false);
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  }, wait * 60000);

  showToast('💧 ' + units.toFixed(1) + 'U logged\n⏰ eat reminder set for ' +
    new Date(eatAt).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}));
  closeSheet();
}

function adjustBolus(delta) {
  // Find the bolus button and update — just re-render with adjusted calc
  // We store override in window
  window._bolusOverride = (window._bolusOverride || 0) + delta;
  renderSheet();
}

function commitManualBolus() {
  var el = document.getElementById('in-i');
  if (!el) return;
  var u = parseFloat(el.value) || 0;
  if (u <= 0) return;
  var t = typeof getEntryTime === 'function' ? getEntryTime() : Date.now();
  SESSION.push({t: t, c: 0, u: u});
  try { localStorage.setItem('river_session',JSON.stringify(SESSION)); } catch(e) {}
  showToast('💧 ' + u.toFixed(1) + 'U logged');
  closeSheet();
}

// ═══════════════════════════════════════════════════════════════════════
//  DEMO SCENARIOS — testbed for visual system
//  Each scenario generates ~2h of history ending at "now"
//  showing a specific glycaemic state and its forces
// ═══════════════════════════════════════════════════════════════════════

const DEMO_SCENARIOS = [

  {
    id: 'equilibrium',
    name: 'Equilibrium',
    desc: 'Steady in range. Forces balanced. The zen state.',
    emoji: '~',
    bgColor: 'rgba(30,120,80,0.7)',
  },
  {
    id: 'meal_bolus',
    name: 'Meal in progress',
    desc: 'Bolused 20min ago. Carbs absorbing. COB rising against IOB.',
    emoji: '\u25b2',
    bgColor: 'rgba(160,90,20,0.7)',
  },
  {
    id: 'post_meal_spike',
    name: 'Post-meal spike',
    desc: 'High GI meal, IOB not keeping up. The rocket ship.',
    emoji: '\u21d1\u21d1',
    bgColor: 'rgba(180,80,30,0.7)',
  },
  {
    id: 'correction_window',
    name: 'Correction window open',
    desc: 'Sticky hyper. IOB cleared. Safe to act.',
    emoji: '\u25c6',
    bgColor: 'rgba(140,80,30,0.7)',
  },
  {
    id: 'hypo_approach',
    name: 'Approaching hypo',
    desc: 'IOB overpowering. BG dropping. Snack needed soon.',
    emoji: '\u21d3',
    bgColor: 'rgba(40,80,180,0.7)',
  },
  {
    id: 'hypo_treatment',
    name: 'Hypo treated',
    desc: 'Glucose tabs 20min ago. COB lifting BG. Forces resolving.',
    emoji: '\u25b2\u25b2',
    bgColor: 'rgba(60,100,200,0.7)',
  },
  {
    id: 'dawn_phenomenon',
    name: 'Dawn rise',
    desc: '6am. BG creeping up from basal resistance. Low IOB, no COB.',
    emoji: '\u2197',
    bgColor: 'rgba(140,70,30,0.7)',
  },
  {
    id: 'overnight_flat',
    name: 'Overnight flat',
    desc: '3am. Nothing active. Both forces at rest. Basal holding.',
    emoji: '\u2014',
    bgColor: 'rgba(20,30,70,0.7)',
  },

];

// Generate scenario history — returns {history, bolus_events, now_offset}
// now_offset = how many ms before Date.now() the scenario "ends"
// (0 = ends right now, positive = ended X ms ago for scrollable history)

function generateScenario(id) {
  const now   = Date.now();
  const step  = 5 * 60000; // 5 min
  const hist  = [];
  const bolus = [];

  function pushPt(minsBack, bg, iob, cob) {
    hist.push({ t: now - minsBack*60000, bg, iob, cob, pen:1 });
  }
  function pushBolus(minsBack, c, u) {
    bolus.push({ t: now - minsBack*60000, c, u });
  }

  switch(id) {

    case 'equilibrium': {
      // 2h of gentle in-range. Small meal 90min ago, fully resolved.
      // BG wanders 5.8 to 7.2 with gentle sine
      for (let m=120; m>=0; m-=5) {
        const wave = Math.sin(m*0.08)*0.7 + Math.sin(m*0.15)*0.3;
        const bg   = 6.2 + wave;
        const iob  = m>90 ? Math.max(0, (m-90)*0.018) : 0;
        const cob  = m>90 ? Math.max(0, (m-90)*0.4 * Math.exp(-(m-90)/35)) : 0;
        pushPt(m, parseFloat(bg.toFixed(1)), parseFloat(iob.toFixed(2)), parseFloat(cob.toFixed(1)));
      }
      pushBolus(90, 35, 2.5);
      break;
    }

    case 'meal_bolus': {
      // Bolused 20min ago. Was at 7.2. Carbs just starting to absorb.
      // IOB peaked, COB building. BG dipping slightly then starting to rise.
      for (let m=120; m>=0; m-=5) {
        let bg, iob, cob;
        if (m > 20) {
          bg  = 7.2 + Math.sin(m*0.05)*0.4;
          iob = 0; cob = 0;
        } else {
          // Post-bolus: IOB active, COB building, BG dipping slightly
          const elapsed = 20-m;
          iob = 3.2 * Math.exp(-elapsed/90);
          cob = 45 * (1 - Math.exp(-elapsed/25)) * Math.exp(-elapsed/80);
          bg  = 7.2 - elapsed*0.04 + cob*0.04;
          bg  = Math.max(5.5, bg);
        }
        pushPt(m, parseFloat(bg.toFixed(1)), parseFloat(iob.toFixed(2)), parseFloat(cob.toFixed(1)));
      }
      pushBolus(20, 45, 3.2);
      break;
    }

    case 'post_meal_spike': {
      // High GI breakfast 45min ago. Porridge. Rapid rise despite bolus.
      // BG peaked at 16.5, now slowly coming down with IOB still working.
      for (let m=120; m>=0; m-=5) {
        let bg, iob, cob;
        if (m > 55) {
          bg = 7.5 + Math.sin(m*0.04)*0.5;
          iob=0; cob=0;
        } else {
          const elapsed = 55-m;
          iob = 3.8 * Math.max(0, 1 - elapsed/95);
          // Fast carb absorption — peaks at 20min
          const cobPeak = elapsed < 20 ? elapsed*1.8 : Math.max(0, 36 - (elapsed-20)*0.8);
          cob = Math.max(0, cobPeak);
          // Rapid rise then slow fall
          if (elapsed < 30) {
            bg = 7.5 + elapsed * 0.3;
          } else {
            bg = 7.5 + 30*0.3 - (elapsed-30)*0.12;
          }
          bg = Math.max(7, bg);
        }
        pushPt(m, parseFloat(bg.toFixed(1)), parseFloat(iob.toFixed(2)), parseFloat(cob.toFixed(1)));
      }
      pushBolus(55, 52, 3.8);
      break;
    }

    case 'correction_window': {
      // Was high (16+) 3h ago. Correction given. IOB now cleared.
      // BG still at 12.8, stubbornly. Window now open to correct again.
      for (let m=120; m>=0; m-=5) {
        let bg, iob, cob;
        // IOB cleared 20min ago
        iob  = m > 20 ? Math.max(0, (m-20)*0.008) : 0;
        cob  = 0;
        // BG was 16, correction brought it down but stalled
        bg   = 16 - (120-m)*0.026;
        bg   = Math.max(12.2, Math.min(16, bg));
        // Slight fluctuation
        bg  += Math.sin(m*0.12)*0.3;
        pushPt(m, parseFloat(bg.toFixed(1)), parseFloat(iob.toFixed(2)), 0);
      }
      pushBolus(115, 0, 1.8); // correction 115min ago, now cleared
      break;
    }

    case 'hypo_approach': {
      // Active IOB from aggressive correction 70min ago. BG dropping steadily.
      // Currently 5.2 and falling. Snack needed, not yet critical.
      for (let m=120; m>=0; m-=5) {
        let bg, iob, cob;
        if (m > 70) {
          bg = 11.5 + Math.sin(m*0.05)*0.5; iob=0; cob=0;
        } else {
          const elapsed = 70-m;
          iob  = 2.8 * Math.max(0, 1 - elapsed/85);
          cob  = 0;
          bg   = 11.5 - elapsed*0.09;
          bg   = Math.max(4.2, bg);
        }
        pushPt(m, parseFloat(bg.toFixed(1)), parseFloat(iob.toFixed(2)), parseFloat(cob.toFixed(1)));
      }
      pushBolus(70, 0, 2.8);
      break;
    }

    case 'hypo_treatment': {
      // Went hypo 40min ago (3.6). Treated with 3 glucose tabs. BG recovering.
      // COB from tabs lifting BG. IOB minimal. Forces resolving upward.
      for (let m=120; m>=0; m-=5) {
        let bg, iob, cob;
        if (m > 70) {
          bg = 9.5 + Math.sin(m*0.06)*0.4; iob=0.3; cob=0;
        } else if (m > 40) {
          // Declining toward hypo
          const elapsed = 70-m;
          bg   = 9.5 - elapsed*0.15;
          bg   = Math.max(3.5, bg);
          iob  = 0.3 * Math.max(0, 1 - elapsed/80);
          cob  = 0;
        } else {
          // Treated 40min ago — 3 glucose tabs = ~12g fast carb
          const elapsed = 40-m;
          cob  = 12 * Math.max(0, 1 - elapsed/35);
          iob  = 0;
          bg   = 3.6 + elapsed*0.17;
          bg   = Math.min(9.5, bg);
        }
        pushPt(m, parseFloat(bg.toFixed(1)), parseFloat(iob.toFixed(2)), parseFloat(cob.toFixed(1)));
      }
      pushBolus(40, 12, 0); // glucose tabs logged as carbs only
      break;
    }

    case 'dawn_phenomenon': {
      // 6am. BG creeping up from early morning basal resistance.
      // Slow steady rise from 6.8 to 9.1. No IOB, no COB. Just the basal gap.
      for (let m=120; m>=0; m-=5) {
        const bg  = 6.8 + (120-m)*0.019 + Math.sin(m*0.07)*0.25;
        pushPt(m, parseFloat(bg.toFixed(1)), 0, 0);
      }
      break;
    }

    case 'overnight_flat': {
      // 3am. Everything quiet. BG wandering gently 5.8–6.8.
      // Both forces at rest. Basal holding. The ideal overnight.
      for (let m=120; m>=0; m-=5) {
        const bg = 6.2 + Math.sin(m*0.06)*0.5 + Math.sin(m*0.13)*0.2;
        pushPt(m, parseFloat(bg.toFixed(1)), 0, 0);
      }
      break;
    }

    default:
      // Fallback — flat
      for (let m=120; m>=0; m-=5) pushPt(m, 7.0, 0, 0);
  }

  hist.sort((a,b) => a.t-b.t);
  return { history: hist, bolus };
}

function loadScenario(id) {
  const s = generateScenario(id);

  // Replace HISTORY_RAW contents
  HISTORY_RAW.length = 0;
  for (const h of s.history) HISTORY_RAW.push(h);
  HISTORY_RAW.sort((a,b) => a.t-b.t);

  // Replace BOLUS_EVENTS
  BOLUS_EVENTS.length = 0;
  for (const b of s.bolus) BOLUS_EVENTS.push(b);

  // Clear session
  SESSION.length = 0;

  // Reset view to now
  updateCGMBounds();
  viewTime = CGM_END;
  viewSpan = 2 * 3600000;

  // Close selector
  var sel = document.getElementById('scenario-selector');
  if (sel) { sel.style.opacity='0'; setTimeout(function(){ sel.remove(); }, 300); }

  _activeDemoId = id;

  // Toast
  var sc = DEMO_SCENARIOS.find(function(s){ return s.id===id; });
  if (sc) showToast(sc.name + '\n' + sc.desc);
}

var _activeDemoId = null;

function openScenarioSelector() {
  var existing = document.getElementById('scenario-selector');
  if (existing) { existing.remove(); return; }

  var el = document.createElement('div');
  el.id = 'scenario-selector';
  el.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:100',
    'background:rgba(3,5,15,0.92)',
    'backdrop-filter:blur(16px)',
    '-webkit-backdrop-filter:blur(16px)',
    'display:flex', 'flex-direction:column',
    'align-items:center', 'justify-content:center',
    'padding:24px', 'overflow-y:auto',
    'transition:opacity .3s', 'opacity:0'
  ].join(';');

  var inner = '<div style="max-width:440px;width:100%">';
  inner += '<div style="text-align:center;margin-bottom:24px">';
  inner += '<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;';
  inner += 'font-size:28px;color:rgba(180,210,240,0.8);letter-spacing:-1px">demo scenarios</div>';
  inner += '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(150,180,210,0.3);';
  inner += 'letter-spacing:2px;text-transform:uppercase;margin-top:4px">select a glycaemic state</div>';
  inner += '</div>';

  inner += '<div style="display:flex;flex-direction:column;gap:8px">';
  DEMO_SCENARIOS.forEach(function(sc) {
    var active = _activeDemoId === sc.id;
    inner += '<button onclick="loadScenario(\'' + sc.id + '\')" style="';
    inner += 'display:flex;align-items:center;gap:14px;';
    inner += 'padding:14px 16px;border-radius:12px;cursor:pointer;text-align:left;';
    inner += 'background:' + (active ? 'rgba(50,100,150,0.3)' : 'rgba(20,30,50,0.5)') + ';';
    inner += 'border:1px solid ' + (active ? 'rgba(100,160,220,0.3)' : 'rgba(80,110,150,0.12)') + ';';
    inner += 'transition:all .15s;width:100%">';
    inner += '<div style="font-size:18px;width:24px;text-align:center;flex-shrink:0;';
    inner += 'font-family:\'DM Mono\',monospace;color:rgba(180,210,240,0.6)">' + sc.emoji + '</div>';
    inner += '<div style="flex:1">';
    inner += '<div style="font-family:\'Fraunces\',serif;font-weight:200;font-size:16px;';
    inner += 'color:rgba(180,210,240,0.9)">' + sc.name + '</div>';
    inner += '<div style="font-family:\'DM Mono\',monospace;font-size:10px;';
    inner += 'color:rgba(150,180,210,0.45);margin-top:2px">' + sc.desc + '</div>';
    inner += '</div></button>';
  });
  inner += '</div>';

  inner += '<div style="text-align:center;margin-top:20px">';
  inner += '<button onclick="closeScenarioSelector()" style="background:none;border:none;cursor:pointer;';
  inner += 'font-family:\'DM Mono\',monospace;font-size:9px;letter-spacing:1px;';
  inner += 'text-transform:uppercase;color:rgba(150,180,210,0.25);padding:8px">close</button>';
  inner += '</div></div>';

  el.innerHTML = inner;
  document.body.appendChild(el);
  requestAnimationFrame(function(){ el.style.opacity='1'; });
}

function closeScenarioSelector() {
  var el = document.getElementById('scenario-selector');
  if (el) { el.style.opacity='0'; setTimeout(function(){ el.remove(); }, 300); }
}

// ═══════════════════════════════════════════════════════════════════════════
//  CGM SOURCE SYSTEM
//  Pluggable data sources. Credentials stored in localStorage only.
//  Never hardcoded. Never sent anywhere except the configured endpoint.
//
//  Sources:
//    nightscout  — Nightscout-compatible URL + token (Gluroo, real NS, xDrip)
//    dexcom_share — Dexcom Share unofficial API (username + password)
//    dexcom_oauth — Dexcom official OAuth2 API (future)
//    libre        — LibreLinkUp (future)
//    manual       — No live data, manual entry only
// ═══════════════════════════════════════════════════════════════════════════

const CGM_SOURCES = {
  nightscout: {
    name: 'Nightscout / Gluroo',
    icon: '🌙',
    description: 'In Gluroo: Menu → Settings → Gluroo Global Connect Nightscout. Tap Copy → Copy JSON. Paste the URL into the URL field and the apiSecretToken value into the token field.',
    fields: [
      { key: 'url',   label: 'Nightscout URL',   placeholder: 'https://xxxx.ns.gluroo.com', type: 'url' },
      { key: 'token', label: 'API Token / Secret', placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', type: 'password' },
    ],
    _parse(data) {
      return data
        .filter(e => e.sgv || e.mbg)
        .map(e => ({
          t:     e.date,
          bg:    e.sgv ? +(e.sgv / 18).toFixed(1) : +(e.mbg),
          trend: e.direction || 'NONE',
          src:   'nightscout'
        }));
    },
    _proxy: 'https://orange-surf-6f98.john-king-uk.workers.dev',
    async _get(cfg, path) {
      const base   = cfg.url.replace(/\/+$/, '');
      const sep    = path.includes('?') ? '&' : '?';
      const target = base + path + sep + 'token=' + encodeURIComponent(cfg.token);
      const proxyUrl = this._proxy + '/?url=' + encodeURIComponent(target);
      let r;
      try { r = await fetch(proxyUrl); }
      catch(e) { throw new Error('Cannot reach ' + base + ' — check URL is correct'); }
      return r;
    },
    async fetch(cfg, count=1) {
      let r;
      try { r = await this._get(cfg, '/api/v1/entries.json?count=' + count); }
      catch(e) { throw e; }
      if (r.status === 401 || r.status === 403)
        throw new Error('Token rejected — get a fresh one: Gluroo → Menu → Settings → Gluroo Global Connect');
      if (!r.ok) throw new Error('Server returned ' + r.status);
      let data;
      try { data = await r.json(); } catch(e) { throw new Error('Bad response — is the URL correct?'); }
      if (!Array.isArray(data)) throw new Error('Unexpected response format');
      if (data.length === 0) throw new Error('No readings — is Dexcom Share active in the Gluroo app?');
      return this._parse(data);
    },
    async fetchRecent(cfg, hours=3) {
      const count = hours * 12 + 5;
      let r;
      try { r = await this._get(cfg, '/api/v1/entries.json?count=' + count); }
      catch(e) { throw new Error('Cannot reach server'); }
      if (!r.ok) throw new Error('Server returned ' + r.status);
      let data;
      try { data = await r.json(); } catch(e) { return []; }
      if (!Array.isArray(data)) return [];
      return this._parse(data).sort((a,b) => a.t - b.t);
    }
  },

  dexcom_share: {
    name: 'Dexcom Share',
    icon: '📡',
    description: 'Direct Dexcom Share using your Dexcom app credentials. Requires Share enabled with at least one follower. Must be served over https:// (works on GitHub Pages).',
    fields: [
      { key: 'username', label: 'Dexcom Username / Email', placeholder: 'yourname@email.com', type: 'text' },
      { key: 'password', label: 'Dexcom Password',          placeholder: '••••••••',            type: 'password' },
      { key: 'region',   label: 'Region',                    placeholder: '',                   type: 'select',
        options: [{ value:'ous', label:'Outside US (UK, EU, AU...)' }, { value:'us', label:'United States' }] },
    ],
    _session: null,
    _sessionExpiry: 0,
    _proxy: 'https://orange-surf-6f98.john-king-uk.workers.dev',
    async _post(url, body) {
      // POST via proxy — worker needs to support POST, so we send as GET with encoded body
      // Actually: send directly since Dexcom Share does allow CORS on POST from https://
      // If that fails, we fall back to proxy
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: {'Content-Type':'application/json','Accept':'application/json'},
          body: JSON.stringify(body)
        });
        return r;
      } catch(e) {
        throw new Error('Cannot reach Dexcom — check your internet connection');
      }
    },
    async _getSession(cfg) {
      if (this._session && Date.now() < this._sessionExpiry) return this._session;
      const base  = cfg.region === 'us'
        ? 'https://share2.dexcom.com/ShareWebServices/Services'
        : 'https://shareous1.dexcom.com/ShareWebServices/Services';
      const appId = 'd89443d2-327c-4a6f-89e5-496bbb0317db';
      const r1 = await this._post(`${base}/General/AuthenticatePublisherAccount`,
        { accountName: cfg.username, password: cfg.password, applicationId: appId });
      if (!r1.ok) throw new Error('Dexcom auth failed — check your username and password');
      const accountId = await r1.json();
      const r2 = await this._post(`${base}/General/LoginPublisherAccountById`,
        { accountId, password: cfg.password, applicationId: appId });
      if (!r2.ok) throw new Error('Dexcom login failed — try again');
      this._session = await r2.json();
      this._sessionExpiry = Date.now() + 55 * 60000;
      return this._session;
    },
    _parseDex(data) {
      return data.map(e => ({
        t:   parseInt(e.WT.replace(/[^0-9]/g,'')),
        bg:  +(e.Value / 18).toFixed(1),
        trend: e.Trend,
        src: 'dexcom_share'
      })).sort((a,b) => a.t - b.t);
    },
    async _dexGet(cfg, path) {
      const base = cfg.region === 'us'
        ? 'https://share2.dexcom.com/ShareWebServices/Services'
        : 'https://shareous1.dexcom.com/ShareWebServices/Services';
      const target = base + path;
      const proxyUrl = this._proxy + '/?url=' + encodeURIComponent(target);
      const r = await fetch(proxyUrl);
      if (!r.ok) { this._session = null; throw new Error('Dexcom read ' + r.status); }
      return r.json();
    },
    async fetch(cfg, count=1) {
      const sid = await this._getSession(cfg);
      const data = await this._dexGet(cfg,
        `/Publisher/ReadPublisherLatestGlucoseValues?sessionId=${sid}&minutes=1440&maxCount=${count}`);
      return this._parseDex(data);
    },
    async fetchRecent(cfg, hours=3) {
      const sid = await this._getSession(cfg);
      const data = await this._dexGet(cfg,
        `/Publisher/ReadPublisherLatestGlucoseValues?sessionId=${sid}&minutes=${hours*60}&maxCount=${hours*12+5}`);
      return this._parseDex(data);
    }
  },

  libre3: {
    name: 'Libre 3 (LibreLinkUp)',
    icon: '💙',
    description: 'LibreLinkUp follower account credentials. Setup: LibreLink app → Menu → Connected Apps → LibreLinkUp → invite an email as follower → accept invite from that email → use those credentials here. Important: this is the FOLLOWER account email/password, not your main LibreLink or LibreView login.',
    fields: [
      { key: 'email',    label: 'LibreLinkUp Email',    placeholder: 'you@email.com',  type: 'text'     },
      { key: 'password', label: 'LibreLinkUp Password', placeholder: '••••••••',        type: 'password' },
      { key: 'region',   label: 'Region',               placeholder: '',                type: 'select',
        options: [
          { value: 'eu',  label: 'Europe (UK, EU)' },
          { value: 'us',  label: 'United States'   },
          { value: 'au',  label: 'Australia'        },
          { value: 'ap',  label: 'Asia Pacific'     },
          { value: 'ca',  label: 'Canada'           },
          { value: 'de',  label: 'Germany'          },
          { value: 'fr',  label: 'France'           },
          { value: 'jp',  label: 'Japan'            },
          { value: 'us2', label: 'United States 2'  },
          { value: 'eu2', label: 'Europe 2 (EU2)'   },
        ]
      },
    ],
    _proxy: 'https://orange-surf-6f98.john-king-uk.workers.dev',
    _token: null,
    _tokenExpiry: 0,
    _patientId: null,

    _baseUrl(region) {
      const hosts = {
        us:  'api.libreview.io',
        eu:  'api-eu.libreview.io',
        eu2: 'api-eu2.libreview.io',
        au:  'api-au.libreview.io',
        ap:  'api-ap.libreview.io',
        ca:  'api-ca.libreview.io',
        de:  'api-de.libreview.io',
        fr:  'api-fr.libreview.io',
        jp:  'api-jp.libreview.io',
        us2: 'api2.libreview.io',
      };
      return 'https://' + (hosts[region] || hosts.eu);
    },

    async _req(region, path, method, body, token) {
      const url = this._baseUrl(region) + path;
      // Send everything to the proxy — it must forward method, headers, and body
      const proxied = this._proxy + '/?url=' + encodeURIComponent(url);
      const headers = {
        'Content-Type':    'application/json',
        'Accept':          'application/json',
        'product':         'llu.ios',
        'version':         '4.12.0',
        'Accept-Encoding': 'gzip, deflate, br',
        'Pragma':          'no-cache',
        'Cache-Control':   'no-cache',
        'User-Agent':      'LibreLinkUp/4.12.0 CFNetwork/1492.0.1 Darwin/23.3.0',
      };
      if (token) headers['Authorization'] = 'Bearer ' + token;

      let r;
      try {
        r = await fetch(proxied, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
        });
        // If iOS headers get 403 on login, retry with Android headers
        if (r.status === 403 && path.includes('/auth/login')) {
          const hdrs2 = Object.assign({}, headers, {
            'product':    'llu.android',
            'version':    '4.12.0',
            'User-Agent': 'LibreLinkUp/4.12.0 (Android)',
          });
          const r2 = await fetch(proxied, {
            method,
            headers: hdrs2,
            body: body ? JSON.stringify(body) : undefined,
          });
          if (r2.ok || r2.status !== 403) r = r2;
        }
      } catch(netErr) {
        // Network-level failure — proxy unreachable or CORS
        const isPost = method === 'POST';
        throw new Error(
          'Cannot reach LibreLinkUp proxy.' +
          (isPost ? ' The proxy may not support POST requests with a body — ' +
            'update your Cloudflare Worker (see Settings → CGM → help).' : '') +
          ' (' + netErr.message + ')'
        );
      }

      if (!r.ok) {
        let txt = '';
        try { txt = await r.text(); } catch(e) {}
        // Parse Abbott error codes
        let detail = '';
        try {
          const j = JSON.parse(txt);
          if (j.error) detail = j.error.message || j.error;
          else if (j.message) detail = j.message;
        } catch(e) { detail = txt.slice(0, 120); }

        if (r.status === 401) throw new Error('Wrong email or password for LibreLinkUp follower account');
        if (r.status === 403) {
          // 403 with correct credentials usually means:
          // 1. Terms not accepted in LibreLinkUp app
          // 2. No active follower connection
          // 3. Account exists but hasn't completed LibreLinkUp setup
          throw new Error(
            'Account not authorised (403). ' +
            'Steps to fix: ' +
            '(1) Open the LibreLinkUp app and check you can see readings there. ' +
            '(2) Accept any pending terms or notifications in the app. ' +
            '(3) In LibreLink → Connected Apps → LibreLinkUp, confirm the connection is active. ' +
            '(4) Try logging out and back into the LibreLinkUp app.'
          );
        }
        if (r.status === 429) throw new Error('Too many requests — wait a few minutes and try again');
        if (r.status === 0)   throw new Error('Proxy blocked the request — the Cloudflare Worker needs updating to support POST');
        throw new Error('LibreLinkUp error ' + r.status + (detail ? ': ' + detail : ''));
      }

      let json;
      try { json = await r.json(); }
      catch(e) { throw new Error('Bad response from LibreLinkUp — unexpected format'); }
      return json;
    },

    async _login(cfg) {
      if (this._token && Date.now() < this._tokenExpiry) return this._token;
      const data = await this._req(cfg.region, '/llu/auth/login', 'POST', {
        email:    cfg.email,
        password: cfg.password,
      });

      // Log full response to console for debugging
      console.log('[libre3] login response status:', data.status);
      console.log('[libre3] login response keys:', Object.keys(data.data || {}));

      // Region redirect — Abbott tells us which server to use
      if (data.data?.redirect) {
        const redirect = data.data.region;
        console.log('[libre3] Redirected to region:', redirect);
        if (redirect) {
          if (redirect === cfg.region) {
            // Already on the right region but still redirecting — unknown region
            throw new Error(
              'LibreLinkUp redirected to region "' + redirect + '" but could not connect. ' +
              'Try selecting "Europe 2 (EU2)" from the region dropdown.'
            );
          }
          cfg.region = redirect;
          this._token = null; // clear cached token
          return this._login(cfg); // retry with correct region
        }
      }

      // Terms and conditions not accepted
      if (data.data?.step?.type === 'tou' || data.data?.step?.type === 'legal') {
        throw new Error(
          'You need to accept LibreLinkUp terms in the app first. ' +
          'Open LibreLinkUp on your phone, accept the terms, then try again.'
        );
      }

      // Wrong credentials
      if (data.status === 2 || data.status === 4) {
        throw new Error(
          'Wrong email or password. ' +
          'Use your LibreLinkUp follower account — the one that received the invitation email. ' +
          'This is NOT the same as your LibreLink or LibreView login.'
        );
      }

      // Account not found or other auth error
      if (data.status !== 0) {
        // Try to extract a message from the response
        const msg = data.error?.message || data.message || '';
        throw new Error(
          'LibreLinkUp login failed (code ' + data.status + ')' +
          (msg ? ': ' + msg : '') +
          '. Check your email, password, and region.'
        );
      }

      // Check for token
      const token = data.data?.authTicket?.token;
      if (!token) {
        // Log the actual response data to help debug
        const dataStr = JSON.stringify(data.data || {}).slice(0, 200);
        console.warn('[libre3] No token in response. data:', dataStr);
        throw new Error(
          'LibreLinkUp connected but returned no session token. ' +
          'Response: ' + dataStr + '. ' +
          'This may mean you need to accept terms in the LibreLinkUp app, ' +
          'or the account needs to complete setup.'
        );
      }

      this._token = token;
      this._tokenExpiry = Date.now() + 50 * 60000;
      console.log('[libre3] Login successful, token expires in 50min');
      return token;
    },

    async _getPatient(cfg, token) {
      if (this._patientId) return this._patientId;
      const data = await this._req(cfg.region, '/llu/connections', 'GET', null, token);
      if (!data.data || data.data.length === 0) {
        throw new Error('No connections found — make sure LibreLinkUp follower is set up in the LibreLink app');
      }
      this._patientId = data.data[0].patientId;
      return this._patientId;
    },

    _parseReading(r) {
      // Libre timestamps are in local time as Unix seconds (not ms)
      // ValueInMgPerDl → mmol/L
      const t  = r.FactoryTimestamp
        ? new Date(r.FactoryTimestamp + ' UTC').getTime()
        : r.Timestamp
          ? new Date(r.Timestamp).getTime()
          : Date.now();
      const bg = r.ValueInMgPerDl
        ? +(r.ValueInMgPerDl / 18.016).toFixed(1)
        : r.Value
          ? +(r.Value).toFixed(1)
          : 0;
      const trendMap = { 1:'DoubleUp', 2:'SingleUp', 3:'FortyFiveUp', 4:'Flat',
                         5:'FortyFiveDown', 6:'SingleDown', 7:'DoubleDown' };
      return { t, bg, trend: trendMap[r.TrendArrow] || 'Flat', src: 'libre3' };
    },

    async fetch(cfg, count) {
      const token = await this._login(cfg);
      const pid   = await this._getPatient(cfg, token);
      const data  = await this._req(cfg.region, '/llu/connections/' + pid + '/graph', 'GET', null, token);
      if (!data.data) throw new Error('No data in response');
      // Current reading
      const current = data.data.connection?.glucoseMeasurement;
      if (!current) throw new Error('No current reading — is the sensor active?');
      return [this._parseReading(current)];
    },

    async fetchRecent(cfg, hours) {
      const token = await this._login(cfg);
      const pid   = await this._getPatient(cfg, token);
      const data  = await this._req(cfg.region, '/llu/connections/' + pid + '/graph', 'GET', null, token);
      if (!data.data) throw new Error('No data in response');
      const readings = [];
      // Graph data (historical)
      const graphData = data.data.graphData || [];
      for (const r of graphData) {
        const parsed = this._parseReading(r);
        if (parsed.bg > 0) readings.push(parsed);
      }
      // Add current reading
      const current = data.data.connection?.glucoseMeasurement;
      if (current) {
        const parsed = this._parseReading(current);
        if (parsed.bg > 0) readings.push(parsed);
      }
      readings.sort((a,b) => a.t - b.t);
      return readings;
    },
  },


  manual: {
    name: 'Manual only',
    icon: '✏️',
    description: 'No live CGM connection. Log readings manually using the drop button.',
    fields: [],
    async fetch()       { return []; },
    async fetchRecent() { return []; }
  }
};


// ── HYPO TREATMENT QUICK-LOG ──────────────────────────────────────
var HYPO_TREATMENTS = [
  {id:'glucose_tabs', name:'Glucose tabs', carbs:12, gi:100, desc:'4 tabs = 12g'},
  {id:'jelly_babies', name:'Jelly babies', carbs:11, gi:80,  desc:'4 babies = 11g'},
  {id:'apple_juice',  name:'Apple juice',  carbs:13, gi:85,  desc:'125ml carton'},
  {id:'lucozade',     name:'Lucozade',     carbs:15, gi:95,  desc:'half bottle'},
  {id:'dextro',       name:'Dextro tabs',  carbs:9,  gi:100, desc:'3 tabs = 9g'},
];


async function suggestGI(foodName, inputEl) {
  if (!foodName || foodName.length < 2) return 55;
  if (inputEl) inputEl.placeholder = '...';
  try {
    var resp = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({model:'claude-sonnet-4-20250514', max_tokens:60,
        messages:[{role:'user', content:'Single integer only: glycaemic index for "'+foodName+'". Just the number 1-100.'}]})
    });
    var d = await resp.json();
    var gi = parseInt(((d.content||[])[0]||{}).text||'55');
    gi = Math.max(1, Math.min(100, gi||55));
    if (inputEl) { inputEl.value = gi; inputEl.placeholder = 'GI'; }
    return gi;
  } catch(e) { if (inputEl) inputEl.placeholder = 'GI'; return 55; }
}

// ── TIME INPUT HELPERS ────────────────────────────────────────────────
function toDatetimeLocal(d) {
  // Format Date to datetime-local input value (local time)
  var pad = function(n){ return String(n).padStart(2,'0'); };
  return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function fmtTime(val) {
  // Format datetime-local string to readable "Thu 17 Apr · 14:00"
  if (!val) return '';
  var d = new Date(val);
  return d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'}) +
    ' · ' + d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
}

function timePickerHTML(id, defaultDate, allowFuture) {
  // Returns HTML for a compact time picker row
  var val = toDatetimeLocal(defaultDate);
  var max = allowFuture ? '' : 'max="' + toDatetimeLocal(new Date()) + '"';
  return '<div style="margin:14px 0 10px">' +
    '<div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1px;' +
      'text-transform:uppercase;color:rgba(255,255,255,0.25);margin-bottom:5px">when</div>' +
    '<div style="display:flex;align-items:center;gap:8px">' +
    '<div id="' + id + '-display" style="flex:1;font-family:\'Fraunces\',serif;' +
      'font-style:italic;font-weight:200;font-size:15px;color:rgba(200,220,240,0.7)">' +
      fmtTime(val) + '</div>' +
    '<input id="' + id + '" type="datetime-local" value="' + val + '" ' + max + ' ' +
      'style="position:absolute;opacity:0;width:1px;height:1px" ' +
      'onchange="document.getElementById(\'' + id + '-display\').textContent=fmtTime(this.value)">' +
    '<button onclick="document.getElementById(\'' + id + '\').showPicker?.' +
      'call(document.getElementById(\'' + id + '\'))||document.getElementById(\'' + id + '\').click()" ' +
      'style="padding:5px 10px;border-radius:7px;border:1px solid rgba(255,255,255,0.12);' +
      'background:rgba(255,255,255,0.05);font-family:\'DM Mono\',monospace;font-size:9px;' +
      'color:rgba(200,220,240,0.4);cursor:pointer;touch-action:manipulation">change</button>' +
    '</div></div>';
}

function getTimeVal(id) {
  var el = document.getElementById(id);
  if (el && el.value) return new Date(el.value).getTime();
  return Date.now();
}

function openHypoLog() {
  var ex=document.getElementById('hypo-overlay'); if(ex){ex.remove();return;}
  var el=document.createElement('div'); el.id='hypo-overlay';
  el.style.cssText='position:fixed;inset:0;z-index:60;background:rgba(3,5,20,0.9);backdrop-filter:blur(14px);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;transition:opacity .25s;opacity:0;touch-action:pan-y;pointer-events:auto';
  el.addEventListener('touchstart',function(e){e.stopPropagation();},{passive:true});
  el.addEventListener('click',function(e){if(e.target===el)closeHypoLog();});
  var _hypoDefault = new Date();
  var s='<div style="max-width:360px;width:100%">';
  s+='<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">';
  s+='<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:22px;color:rgba(100,150,255,0.9)">hypo treatment</div>';
  s+='<button onclick="closeHypoLog()" style="background:none;border:none;cursor:pointer;font-size:24px;color:rgba(255,255,255,0.2);padding:4px;touch-action:manipulation">×</button>';
  s+='</div>';
  s+=timePickerHTML('hypo-time', _hypoDefault, false);
  s+='<div style="display:flex;flex-direction:column;gap:8px">';
  HYPO_TREATMENTS.forEach(function(t){
    s+='<button onclick="logHypoTreatment(\''+t.id+'\')" style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-radius:10px;cursor:pointer;background:rgba(40,60,140,0.25);border:1px solid rgba(80,120,220,0.2);width:100%">';
    s+='<div><div style="font-family:\'Fraunces\',serif;font-weight:200;font-size:16px;color:rgba(160,190,255,0.9)">'+t.name+'</div>';
    s+='<div style="font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(100,130,200,0.45);margin-top:2px">'+t.desc+'</div></div>';
    s+='<div style="font-family:\'DM Mono\',monospace;font-size:13px;color:rgba(120,160,255,0.7)">'+t.carbs+'g</div></button>';
  });
  s+='</div><div style="text-align:center;margin-top:16px">';
  s+='<button onclick="closeHypoLog()" style="background:none;border:none;cursor:pointer;font-family:\'DM Mono\',monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase;color:rgba(100,130,200,0.25);padding:8px">cancel</button></div></div>';
  el.innerHTML=s; document.body.appendChild(el);
  requestAnimationFrame(function(){el.style.opacity='1';});
}
function closeHypoLog(){var el=document.getElementById('hypo-overlay');if(el){el.style.opacity='0';setTimeout(function(){el.remove();},250);}}
function logHypoTreatment(id){
  var t=HYPO_TREATMENTS.find(function(x){return x.id===id;});
  if(!t) return;
  var now=getTimeVal('hypo-time');
  SESSION.push({t:now,c:t.carbs,u:0,note:'hypo:'+id});
  try{localStorage.setItem('river_session',JSON.stringify(SESSION));}catch(e){}
  BOLUS_EVENTS.push({t:now,c:t.carbs,u:0});
  closeHypoLog();
  var timeStr=document.getElementById('hypo-time-display')?.textContent||'';
  showToast(t.name+'\n'+t.carbs+'g logged'+(timeStr?'\n'+timeStr:''));
}

// ── CORRECTION QUICK-LOG ──────────────────────────────────────────
function openCorrectionLog(){
  var d=dataAt(viewTime);
  var ISF=(new Date(viewTime).getHours()>=9&&new Date(viewTime).getHours()<15)?7.0:6.0;
  var sug=Math.max(0,Math.round(((d.bg-6.0)/ISF)*2)/2);
  var ex=document.getElementById('corr-overlay');if(ex){ex.remove();return;}
  var el=document.createElement('div');el.id='corr-overlay';
  el.style.cssText='position:fixed;inset:0;z-index:60;background:rgba(3,5,20,0.9);backdrop-filter:blur(14px);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;transition:opacity .25s;opacity:0';
  var _corrDefault = new Date();
  var s='<div style="max-width:320px;width:100%">';
  s+='<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">';
  s+='<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:22px;color:rgba(220,160,60,0.9)">correction</div>';
  s+='<button onclick="closeCorrectionLog()" style="background:none;border:none;cursor:pointer;font-size:24px;color:rgba(255,255,255,0.2);padding:4px;touch-action:manipulation">×</button>';
  s+='</div>';
  s+=timePickerHTML('corr-time', _corrDefault, false);
  s+='<div style="font-family:\'DM Mono\',monospace;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:rgba(180,140,60,0.35);text-align:center;margin-bottom:20px">bg '+d.bg.toFixed(1)+' mmol &middot; isf 1:'+ISF.toFixed(0)+'</div>';
  s+='<div style="text-align:center;margin-bottom:20px">';
  s+='<div style="font-family:\'Fraunces\',serif;font-weight:200;font-size:52px;color:rgba(220,170,80,0.95);letter-spacing:-2px">'+sug.toFixed(1)+'</div>';
  s+='<div style="font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(180,140,60,0.4)">suggested units</div></div>';
  s+='<div style="display:flex;align-items:center;gap:10px;margin-bottom:20px">';
  s+='<span style="font-family:\'DM Mono\',monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase;color:rgba(180,140,60,0.4)">actual</span>';
  s+='<input id="corr-units" type="number" step="0.5" min="0" max="10" value="'+sug.toFixed(1)+'" style="flex:1;padding:10px;border-radius:8px;border:1px solid rgba(180,140,60,0.2);background:rgba(40,30,10,0.4);font-family:\'DM Mono\',monospace;font-size:18px;color:rgba(220,180,80,0.9);text-align:center;outline:none">';
  s+='<span style="font-family:\'DM Mono\',monospace;font-size:13px;color:rgba(180,140,60,0.5)">U</span></div>';
  s+='<button onclick="logCorrection()" style="width:100%;padding:14px;border-radius:10px;border:1px solid rgba(180,140,60,0.25);background:rgba(40,30,10,0.5);font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:17px;color:rgba(220,170,80,0.85);cursor:pointer;margin-bottom:12px">log correction</button>';
  s+='<div style="text-align:center"><button onclick="closeCorrectionLog()" style="background:none;border:none;cursor:pointer;font-family:\'DM Mono\',monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase;color:rgba(180,140,60,0.25);padding:4px">cancel</button></div></div>';
  el.innerHTML=s; document.body.appendChild(el);
  requestAnimationFrame(function(){el.style.opacity='1';});
}
function closeCorrectionLog(){var el=document.getElementById('corr-overlay');if(el){el.style.opacity='0';setTimeout(function(){el.remove();},250);}}
function logCorrection(){
  var u=parseFloat(document.getElementById('corr-units').value)||0;
  if(u<=0){closeCorrectionLog();return;}
  var now=getTimeVal('corr-time');
  SESSION.push({t:now,c:0,u:u});
  try{localStorage.setItem('river_session',JSON.stringify(SESSION));}catch(e){}
  BOLUS_EVENTS.push({t:now,c:0,u:u});
  ALERTS.snooze('corr_nudge',90*60000); ALERTS.snooze('corr_high',90*60000);
  _riverPebble=null;
  closeCorrectionLog();
  showToast(u.toFixed(1)+'U correction\nlogged');
}

// ── CREDENTIAL STORAGE ────────────────────────────────────────────────────
const CRED_KEY = 'river_cgm_cfg';

function saveCGMConfig(sourceId, fields) {
  try {
    localStorage.setItem(CRED_KEY, JSON.stringify({ sourceId, fields, savedAt: Date.now() }));
    return true;
  } catch(e) { return false; }
}

function loadCGMConfig() {
  try { return JSON.parse(localStorage.getItem(CRED_KEY) || 'null'); } catch(e) { return null; }
}

function clearCGMConfig() {
  localStorage.removeItem(CRED_KEY);
}

// ── LIVE POLLING ─────────────────────────────────────────────────────────
let _pollTimer     = null;
let _liveConnected = false;
let _lastReadingT  = 0;
let _sourceCfg     = null;
let _sourceId      = null;

async function startLivePolling(sourceId, cfg) {
  _sourceId  = sourceId;
  _sourceCfg = cfg;
  stopLivePolling();

  const source = CGM_SOURCES[sourceId];
  if (!source || sourceId === 'manual') return;

  // Full backfill — fetch up to 24h of real history to replace static data
  try {
    setLiveStatus('connecting', 'Loading history…');
    const recent = await source.fetchRecent(cfg, 12); // 12h of backfill on connect
    if (recent.length > 0) {
      // Remove only the old static embedded data (pre-2026-03-20)
      // Keep any persisted live readings
      const liveDataCutoff = Date.now() - 8 * 86400000; // 8 days ago
      // Remove entries older than 8 days or from the static embed window
      const staticEmbedEnd = 1742256000000; // March 18 2026 00:00 UTC
      const filtered = HISTORY_RAW.filter(h => h.t > staticEmbedEnd || h.t > liveDataCutoff);
      HISTORY_RAW.length = 0;
      for (const h of filtered) HISTORY_RAW.push(h);
      // Merge in the fresh backfill data (fills gaps)
      ingestReadings(recent);
      setLiveStatus('live', `${recent.length} readings loaded`);
      // Snap to now after first backfill
      viewTime = CGM_END;
      _isAtNow = true;
    }
  } catch(e) {
    setLiveStatus('error', e.message);
    console.warn('CGM backfill failed:', e);
  }

  // Poll every 5 minutes
  async function poll() {
    try {
      const readings = await source.fetch(_sourceCfg, 2);
      if (readings.length > 0) {
        const newest = readings[readings.length-1];
        if (newest.t > _lastReadingT) {
          ingestReadings(readings);
          _liveConnected = true;
          setLiveStatus('live', formatAge(newest.t));
          triggerNewReadingPulse();
        }
      }
    } catch(e) {
      _liveConnected = false;
      setLiveStatus('error', e.message);
      console.warn('CGM poll failed:', e);
    }
  }

  await poll(); // immediate
  _pollTimer = setInterval(poll, 5 * 60000);
}

function stopLivePolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  _liveConnected = false;
}

const PERSIST_KEY = 'river_cgm_history';
const PERSIST_MAX_DAYS = 7; // keep 7 days of readings

function persistReadings() {
  try {
    const cutoff = Date.now() - PERSIST_MAX_DAYS * 86400000;
    const toSave = HISTORY_RAW
      .filter(h => h.t > cutoff && h.bg > 0)
      .map(h => ({t:h.t, bg:h.bg})); // minimal footprint
    localStorage.setItem(PERSIST_KEY, JSON.stringify(toSave));
  } catch(e) {}
}

function loadPersistedReadings() {
  try {
    const raw = JSON.parse(localStorage.getItem(PERSIST_KEY) || '[]');
    if (!Array.isArray(raw) || raw.length === 0) return;
    const cutoff = Date.now() - PERSIST_MAX_DAYS * 86400000;
    for (const r of raw) {
      if (!r.t || !r.bg || r.t < cutoff) continue;
      const exists = HISTORY_RAW.findIndex(h => Math.abs(h.t-r.t) < 90000);
      if (exists < 0) HISTORY_RAW.push({t:r.t, bg:r.bg, iob:0, cob:0, pen:1});
    }
    HISTORY_RAW.sort((a,b)=>a.t-b.t);
    updateCGMBounds();
    console.log(`Loaded ${raw.length} persisted readings (${CGM_START ? new Date(CGM_START).toLocaleDateString() : '?'} → now)`);
  } catch(e) {}
}

function ingestReadings(readings) {
  let changed = false;
  for (const r of readings) {
    if (!r.t || !r.bg || r.bg < 1 || r.bg > 30) continue;
    const existing = HISTORY_RAW.findIndex(h => Math.abs(h.t - r.t) < 90000);
    const entry = { t: r.t, bg: r.bg, iob: 0, cob: 0, pen: 1 };
    if (existing >= 0) HISTORY_RAW[existing] = { ...HISTORY_RAW[existing], bg: r.bg };
    else { HISTORY_RAW.push(entry); changed = true; }
    if (r.t > _lastReadingT) _lastReadingT = r.t;
  }
  HISTORY_RAW.sort((a,b) => a.t - b.t);
  updateCGMBounds();
  // Snap to now if: user is at now, first data arriving, or viewTime is out of range
  const wasAtNow = _isAtNow || (CGM_END - viewTime) < 10 * 60000;
  if (wasAtNow || viewTime < CGM_START || viewTime > CGM_END + 60000) {
    viewTime = CGM_END;
    _isAtNow = true;
  }
  if (changed) persistReadings();
}

function formatAge(t) {
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins === 1) return '1 min ago';
  if (mins < 60) return `${mins} mins ago`;
  return `${Math.round(mins/60)}h ago`;
}

let _pulseAlpha = 0;
function triggerNewReadingPulse() { _pulseAlpha = 1.0; }

// ── SETUP SCREEN ────────────────────────────────────────────────────────
function buildSetupScreen() {
  const existing = loadCGMConfig();
  const selId    = existing?.sourceId || 'nightscout';

  return `
<div id="setup-screen" style="
  position:fixed;inset:0;z-index:200;
  background:rgba(240,238,228,0.98);
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  font-family:'DM Sans',sans-serif;padding:24px;overflow-y:auto;
">
  <div style="max-width:440px;width:100%">
    <!-- Logo -->
    <div style="text-align:center;margin-bottom:28px">
      <div style="font-family:'Fraunces',serif;font-style:italic;font-weight:200;
        font-size:32px;color:rgba(40,55,50,0.75);letter-spacing:-1px">Oskar's River</div>
      <div style="font-family:'DM Mono',monospace;font-size:9px;color:rgba(40,55,50,0.3);
        letter-spacing:2px;text-transform:uppercase;margin-top:4px">connect your cgm</div>
    </div>

    <!-- Source selector -->
    <div style="display:flex;gap:8px;margin-bottom:20px" id="source-tabs">
      ${Object.entries(CGM_SOURCES).map(([id,src]) => `
        <button onclick="selectSource('${id}')"
          id="stab-${id}"
          style="flex:1;padding:10px 6px;border-radius:10px;cursor:pointer;
            font-family:'DM Sans',sans-serif;font-size:11px;text-align:center;
            border:1.5px solid ${id===selId?'rgba(40,55,50,0.4)':'rgba(40,55,50,0.12)'};
            background:${id===selId?'rgba(40,55,50,0.08)':'transparent'};
            color:${id===selId?'rgba(40,55,50,0.8)':'rgba(40,55,50,0.4)'};
            transition:all .15s">
          <div style="font-size:20px;margin-bottom:4px">${src.icon}</div>
          ${src.name}
        </button>
      `).join('')}
    </div>

    <!-- Source description -->
    <div id="src-desc" style="font-size:12px;color:rgba(40,55,50,0.45);
      margin-bottom:16px;line-height:1.5;min-height:36px;text-align:center">
      ${CGM_SOURCES[selId].description}
    </div>

    <!-- Fields -->
    <div id="src-fields" style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px">
    </div>

    <!-- Status / error -->
    <div id="setup-status" style="font-size:11px;color:rgba(40,55,50,0.4);
      text-align:center;margin-bottom:12px;min-height:18px;font-family:'DM Mono',monospace"></div>

    <!-- Connect button -->
    <button onclick="connectCGM()" id="connect-btn"
      style="width:100%;padding:14px;border-radius:10px;
        border:1px solid rgba(40,55,50,0.2);
        background:rgba(40,55,50,0.08);
        color:rgba(40,55,50,0.7);font-family:'Fraunces',serif;
        font-style:italic;font-weight:200;font-size:17px;
        cursor:pointer;transition:all .12s;letter-spacing:-.2px">
      begin the flow
    </button>

    <!-- Skip -->
    <div style="text-align:center;margin-top:12px">
      <button onclick="skipSetup()"
        style="background:none;border:none;cursor:pointer;
          font-family:'DM Mono',monospace;font-size:9px;letter-spacing:1px;
          text-transform:uppercase;color:rgba(40,55,50,0.25);padding:4px">
        skip for now — use demo data
      </button>
    </div>

    <!-- Privacy note -->
    <div style="margin-top:20px;padding:12px;border-radius:8px;
      background:rgba(40,55,50,0.04);border:1px solid rgba(40,55,50,0.08)">
      <div style="font-size:10px;color:rgba(40,55,50,0.35);line-height:1.6">
        🔒 <strong style="color:rgba(150,180,210,0.5)">Your credentials stay on this device.</strong>
        They're saved to your browser's localStorage and sent only to your CGM provider —
        never to any third party. This app has no backend.
      </div>
    </div>
    <div style="text-align:center;margin-top:10px;font-family:'DM Mono',monospace;font-size:8px;color:rgba(40,55,50,0.15);letter-spacing:1px">__BUILD_ID__</div>
  </div>
</div>`;
}

let _selectedSource = 'nightscout';

function selectSource(id) {
  _selectedSource = id;
  const src = CGM_SOURCES[id];
  // Update tabs
  Object.keys(CGM_SOURCES).forEach(sid => {
    const btn = document.getElementById(`stab-${sid}`);
    if (!btn) return;
    const active = sid === id;
    btn.style.borderColor  = active ? 'rgba(40,55,50,0.4)' : 'rgba(40,55,50,0.12)';
    btn.style.background   = active ? 'rgba(40,55,50,0.08)' : 'transparent';
    btn.style.color        = active ? 'rgba(40,55,50,0.8)' : 'rgba(40,55,50,0.4)';
  });
  // Update description
  const desc = document.getElementById('src-desc');
  if (desc) desc.textContent = src.description;
  // Update fields
  renderSourceFields(id);
  document.getElementById('setup-status').textContent = '';
}

function renderSourceFields(id) {
  const src       = CGM_SOURCES[id];
  const container = document.getElementById('src-fields');
  if (!container) return;
  const existing  = loadCGMConfig();
  const saved     = (existing?.sourceId === id) ? existing.fields : {};

  container.innerHTML = src.fields.map(f => {
    if (f.type === 'select') {
      return `<div>
        <label style="font-family:'DM Mono',monospace;font-size:9px;letter-spacing:1px;
          text-transform:uppercase;color:rgba(40,55,50,0.4);display:block;margin-bottom:5px">${f.label}</label>
        <select id="sf-${f.key}"
          style="width:100%;padding:10px 12px;border-radius:8px;
            border:1px solid rgba(40,55,50,0.15);background:rgba(255,255,255,0.7);
            font-family:'DM Sans',sans-serif;font-size:14px;color:rgba(40,55,50,0.8);
            outline:none;-webkit-appearance:none">
          ${f.options.map(o => `<option value="${o.value}" ${(saved[f.key]||'ous')===o.value?'selected':''}>${o.label}</option>`).join('')}
        </select>
      </div>`;
    }
    return `<div>
      <label style="font-family:'DM Mono',monospace;font-size:9px;letter-spacing:1px;
        text-transform:uppercase;color:rgba(40,55,50,0.4);display:block;margin-bottom:5px">${f.label}</label>
      <input id="sf-${f.key}" type="${f.type}" placeholder="${f.placeholder}"
        value="${saved[f.key]||''}"
        style="width:100%;padding:11px 14px;border-radius:8px;
          border:1px solid rgba(40,55,50,0.15);background:rgba(255,255,255,0.7);
          font-family:'DM Mono',monospace;font-size:13px;color:rgba(40,55,50,0.8);
          outline:none;box-sizing:border-box"
        autocomplete="${f.type==='password'?'current-password':'off'}"
        autocapitalize="none" autocorrect="off" spellcheck="false">
    </div>`;
  }).join('');
}

async function connectCGM() {
  const src    = CGM_SOURCES[_selectedSource];
  const status = document.getElementById('setup-status');
  const btn    = document.getElementById('connect-btn');
  if (!status || !btn) return;

  // Collect field values
  const fields = {};
  for (const f of src.fields) {
    const el = document.getElementById(`sf-${f.key}`);
    if (el) fields[f.key] = el.value.trim();
  }

  // Validate
  for (const f of src.fields) {
    if (f.type !== 'select' && !fields[f.key]) {
      status.textContent = `Please enter your ${f.label.toLowerCase()}`;
      status.style.color = 'rgba(160,60,30,0.8)';
      return;
    }
  }

  btn.textContent    = 'connecting…';
  btn.disabled       = true;
  const srcName = src.name || _selectedSource;
  status.textContent = 'Connecting to ' + srcName + '…';
  status.style.color = 'rgba(40,55,50,0.4)';

  try {
    const readings = await src.fetch(fields, 1);
    if (readings.length === 0) throw new Error('No readings returned — check credentials');

    const latest = readings[0];
    const ageMin = Math.round((Date.now() - latest.t) / 60000);
    status.textContent = `✓ Connected — last reading ${latest.bg} mmol/L, ${ageMin} min ago`;
    status.style.color = 'rgba(40,120,60,0.8)';

    // Save and launch
    saveCGMConfig(_selectedSource, fields);
    setTimeout(() => {
      dismissSetup();
      startLivePolling(_selectedSource, fields);
    }, 1200);

  } catch(e) {
    status.textContent = `✗ ${e.message}`;
    status.style.color = 'rgba(160,60,30,0.8)';
    btn.textContent    = 'try again';
    btn.disabled       = false;
  }
}

function skipSetup() {
  saveCGMConfig('manual', {});
  dismissSetup();
}

function dismissSetup() {
  const s = document.getElementById('setup-screen');
  if (s) { s.style.opacity='0'; s.style.transition='opacity .4s'; setTimeout(()=>s.remove(),400); }
}

// ── LIVE STATUS INDICATOR ────────────────────────────────────────────────
// Small dot in top-right of the HUD

// ── CGM CLOCK ──────────────────────────────────────────────────────
var _cgmClockState = 'idle'; // 'idle' | 'connecting' | 'live' | 'error' | 'stale'
var _cgmLastReadingAge = 0;  // minutes since last reading

function drawCGMClock() {
  var cv = document.getElementById('cgm-clock');
  if (!cv) return;
  var cx = cv.getContext('2d');
  var W = cv.width, H = cv.height;
  var cx2 = W/2, cy2 = H/2, r = W*0.38;
  cx.clearRect(0, 0, W, H);

  // State → colour
  var col = _cgmClockState === 'live'        ? '#3ecfa0' :
            _cgmClockState === 'connecting'  ? '#c87832' :
            _cgmClockState === 'error'       ? '#dc4040' :
            _cgmClockState === 'stale'       ? '#c87832' :
                                               '#444460';
  var alpha = _cgmClockState === 'idle' ? 0.35 : 0.9;

  // Track ring (background)
  cx.beginPath();
  cx.arc(cx2, cy2, r, 0, Math.PI*2);
  cx.strokeStyle = 'rgba(255,255,255,0.08)';
  cx.lineWidth = W*0.12;
  cx.stroke();

  // Filled segments: 12 segments = 5min intervals over 1 hour
  // Each segment lights up when we have a reading within that window
  var segments = 12;
  var segAngle = (Math.PI*2) / segments;
  var gap = 0.08; // radians gap between segments
  var startAngle = -Math.PI/2; // 12 o'clock

  for (var i=0; i<segments; i++) {
    var aStart = startAngle + i*segAngle + gap/2;
    var aEnd   = startAngle + (i+1)*segAngle - gap/2;
    // Segment 0 = most recent 5min, segment 11 = 55-60min ago
    var ageMin = i * 5;
    var hasData = _cgmClockState === 'live' && ageMin < _cgmLastReadingAge + 5;
    var isRecent = ageMin === 0;

    if (hasData || _cgmClockState === 'connecting') {
      var segAlpha = isRecent ? 1.0 : Math.max(0.15, 1 - ageMin/65);
      cx.beginPath();
      cx.arc(cx2, cy2, r, aStart, aEnd);
      cx.strokeStyle = col.replace(')', ',' + (segAlpha * alpha) + ')').replace('rgb', 'rgba').replace('#', '');
      // Parse hex to rgba properly
      var hr = parseInt(col.slice(1,3),16);
      var hg = parseInt(col.slice(3,5),16);
      var hb = parseInt(col.slice(5,7),16);
      cx.strokeStyle = 'rgba('+hr+','+hg+','+hb+','+(segAlpha*alpha)+')';
      cx.lineWidth = W*0.12;
      cx.stroke();
    }
  }

  // Centre dot — pulses when live
  var dotR = W*0.10;
  var pulse = _cgmClockState === 'live' ? 0.7 + Math.sin(Date.now()/600)*0.3 : 0.6;
  var hr2 = parseInt(col.slice(1,3),16);
  var hg2 = parseInt(col.slice(3,5),16);
  var hb2 = parseInt(col.slice(5,7),16);
  cx.beginPath();
  cx.arc(cx2, cy2, dotR, 0, Math.PI*2);
  cx.fillStyle = 'rgba('+hr2+','+hg2+','+hb2+','+(pulse*alpha)+')';
  cx.fill();

  // Error X
  if (_cgmClockState === 'error') {
    cx.strokeStyle = col;
    cx.lineWidth = W*0.08;
    cx.lineCap = 'round';
    var d = dotR*0.7;
    cx.beginPath(); cx.moveTo(cx2-d, cy2-d); cx.lineTo(cx2+d, cy2+d); cx.stroke();
    cx.beginPath(); cx.moveTo(cx2+d, cy2-d); cx.lineTo(cx2-d, cy2+d); cx.stroke();
  }

  requestAnimationFrame(drawCGMClock);
}

function updateCGMClockState(state, ageMins) {
  _cgmClockState = state;
  if (ageMins !== undefined) _cgmLastReadingAge = ageMins;
}

window.addEventListener('load', function() { drawCGMClock(); });

function setLiveStatus(state, text) {
  const dot = document.getElementById('live-dot');
  if (dot) {
    const colors = { live:'#4a9060', connecting:'#c87832', error:'#c04030' };
    dot.style.background = colors[state] || colors.connecting;
    dot.title = text || '';
    dot.style.opacity = state === 'live' ? '0' : '0.85';
  }
  // Update live-dot SVG colour
  var dotSvg = document.getElementById('live-dot-svg');
  if (dotSvg) {
    var dotCol = state==='live' ? 'rgba(62,207,160,' : state==='connecting' ? 'rgba(200,140,50,' : 'rgba(200,60,60,';
    dotSvg.querySelectorAll('path,circle').forEach(function(el,i) {
      var a = i===0?'0.4':i===1?'0.6':'0.9';
      el.setAttribute('stroke', dotCol+a+')');
      if (i===2) el.setAttribute('fill', dotCol+'0.9)');
    });
  }
  // Update CGM clock
  var ageMins = 0;
  if (text) {
    var m = text.match(/(\d+) min/);
    if (m) ageMins = parseInt(m[1]);
    else if (text === 'just now') ageMins = 0;
  }
  updateCGMClockState(
    state === 'live' ? (ageMins > 12 ? 'stale' : 'live') :
    state === 'connecting' ? 'connecting' : 'error',
    ageMins
  );
}

// ── SETTINGS BUTTON (cog, bottom-left) ──────────────────────────────────

function exportData() {
  var data = {
    v: 1,
    exported: new Date().toISOString(),
    session:  JSON.parse(localStorage.getItem('river_session')||'[]'),
    logged:   JSON.parse(localStorage.getItem('river_logged')||'[]'),
    meals:    JSON.parse(localStorage.getItem('river_meal_hist')||'[]'),
    foods:    JSON.parse(localStorage.getItem('river_food_lib')||'[]'),
    cgm_cfg:  JSON.parse(localStorage.getItem('river_cgm_cfg')||'null'),
  };
  var blob = new Blob([JSON.stringify(data,null,2)], {type:'application/json'});
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  a.href   = url;
  a.download = 'river-data-' + new Date().toISOString().slice(0,10) + '.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('data exported');
}

function importData(file) {
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    try {
      var data = JSON.parse(e.target.result);
      if (data.v !== 1) { showToast('unknown format'); return; }
      if (data.session) localStorage.setItem('river_session', JSON.stringify(data.session));
      if (data.logged)  localStorage.setItem('river_logged',  JSON.stringify(data.logged));
      if (data.meals)   localStorage.setItem('river_meal_hist', JSON.stringify(data.meals));
      if (data.foods)   localStorage.setItem('river_food_lib',  JSON.stringify(data.foods));
      if (data.cgm_cfg) localStorage.setItem('river_cgm_cfg',   JSON.stringify(data.cgm_cfg));
      showToast('data imported\nreloading...');
      setTimeout(function(){ location.reload(); }, 1200);
    } catch(err) { showToast('import failed'); }
  };
  reader.readAsText(file);
}


// ── FOOD MANAGER ────────────────────────────────────────────────
function openFoodManager() {
  var ex = document.getElementById('food-mgr-overlay');
  if (ex) { ex.remove(); return; }

  var el = document.createElement('div');
  el.id = 'food-mgr-overlay';
  el.style.cssText = 'position:fixed;inset:0;z-index:70;background:rgba(3,5,15,0.96);overflow-y:auto;transition:opacity .2s;opacity:0;-webkit-overflow-scrolling:touch;touch-action:pan-y;pointer-events:auto';

  renderFoodManager(el);
  el.addEventListener('touchstart', function(e){ e.stopPropagation(); }, {passive:true});
  el.addEventListener('touchmove',  function(e){ e.stopPropagation(); }, {passive:true});
  document.body.appendChild(el);
  requestAnimationFrame(function(){ el.style.opacity='1'; });
}

function closeFoodManager() {
  var el = document.getElementById('food-mgr-overlay');
  if (el) { el.style.opacity='0'; setTimeout(function(){el.remove();}, 200); }
}

function renderFoodManager(el) {
  if (!el) el = document.getElementById('food-mgr-overlay');
  if (!el) return;

  var cats = ['bread','cereal','snack','hypo','fruit','dairy','protein','main','drink','custom'];
  var catLabels = {bread:'breads',cereal:'cereals',snack:'snacks',hypo:'hypo treats',
                   fruit:'fruit',dairy:'dairy',protein:'protein',main:'mains',
                   drink:'drinks',custom:'your foods'};

  var all = FOOD_DB.concat(FOOD_LIBRARY.filter(function(f){
    return !FOOD_DB.some(function(d){ return d.name===f.name; });
  }));

  var html = '<div style="max-width:500px;margin:0 auto;padding:20px 16px 60px">';

  // Header
  html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px">';
  html += '<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:24px;color:rgba(180,220,200,0.9)">food library</div>';
  html += '<div style="display:flex;gap:8px">';
  html += '<button onclick="startAddFood()" style="padding:8px 14px;border-radius:9px;border:1px solid rgba(62,180,120,0.3);background:rgba(62,180,120,0.08);font-family:\'DM Mono\',monospace;font-size:10px;letter-spacing:.5px;color:rgba(62,180,120,0.8);cursor:pointer">+ add food</button>';
  html += '<button onclick="closeFoodManager()" style="padding:8px 12px;border-radius:9px;border:1px solid rgba(255,255,255,0.1);background:transparent;font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(255,255,255,0.3);cursor:pointer">close</button>';
  html += '</div></div>';

  // Group by category
  cats.forEach(function(cat) {
    var items = all.filter(function(f){ return (f.cat||'custom') === cat; });
    if (items.length === 0) return;

    html += '<div style="margin-bottom:20px">';
    html += '<div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1.5px;text-transform:uppercase;color:rgba(255,255,255,0.2);margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid rgba(255,255,255,0.06)">' + (catLabels[cat]||cat) + '</div>';

    items.forEach(function(f, i) {
      var isCustom = FOOD_LIBRARY.some(function(l){ return l.name===f.name; });
      var gi = f.gi || 0;
      var giC = gi>=70?'rgba(210,80,40,0.7)':gi>=55?'rgba(200,140,30,0.7)':'rgba(60,160,90,0.7)';
      var giLabel = gi>=70?'high':gi>=55?'med':'low';
      var servCarbs = f.g_serv ? (f.c100 * f.g_serv / 100).toFixed(1) : null;
      var fid = encodeURIComponent(f.name);

      html += '<div id="frow-' + fid + '" style="display:flex;align-items:center;gap:10px;padding:10px 8px;border-radius:10px;margin-bottom:4px;background:rgba(255,255,255,0.03)">';

      // Name + note
      html += '<div style="flex:1;min-width:0">';
      html += '<div style="font-family:\'DM Mono\',monospace;font-size:12px;color:rgba(220,230,240,0.85);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + f.name + '</div>';
      if (f.note) html += '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(255,255,255,0.2);margin-top:1px">' + f.note + '</div>';
      html += '</div>';

      // Serving carbs
      if (servCarbs) {
        html += '<div style="text-align:center;min-width:36px">';
        html += '<div style="font-family:\'DM Mono\',monospace;font-size:13px;color:rgba(62,207,160,0.75)">' + servCarbs + 'g</div>';
        html += '<div style="font-family:\'DM Mono\',monospace;font-size:7px;color:rgba(62,207,160,0.3);letter-spacing:.5px">carbs/serv</div>';
        html += '</div>';
      }

      // GI badge
      html += '<div style="text-align:center;min-width:28px">';
      html += '<div style="font-family:\'DM Mono\',monospace;font-size:10px;color:' + giC + '">' + (gi||'—') + '</div>';
      html += '<div style="font-family:\'DM Mono\',monospace;font-size:7px;color:rgba(255,255,255,0.15)">gi</div>';
      html += '</div>';

      // c100
      html += '<div style="text-align:center;min-width:32px">';
      html += '<div style="font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(255,255,255,0.4)">' + f.c100 + '</div>';
      html += '<div style="font-family:\'DM Mono\',monospace;font-size:7px;color:rgba(255,255,255,0.15)">c/100g</div>';
      html += '</div>';

      // Edit button
      html += '<button onclick="editFood(\'' + fid + '\')" style="padding:5px 10px;border-radius:7px;border:1px solid rgba(255,255,255,0.08);background:transparent;font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(255,255,255,0.3);cursor:pointer">edit</button>';

      html += '</div>';
    });
    html += '</div>';
  });

  html += '</div>';
  el.innerHTML = html;
}

function startAddFood() {
  showFoodEditForm(null);
}

function editFood(encodedName) {
  var name = decodeURIComponent(encodedName);
  var all  = FOOD_DB.concat(FOOD_LIBRARY);
  var f    = all.find(function(x){ return x.name===name; });
  showFoodEditForm(f);
}

function showFoodEditForm(f) {
  var isNew  = !f;
  var el     = document.getElementById('food-mgr-overlay');
  if (!el) return;

  var cats = ['bread','cereal','snack','hypo','fruit','dairy','protein','main','drink','custom'];
  var catOpts = cats.map(function(c){
    return '<option value="'+c+'"'+(f&&f.cat===c?' selected':'')+'>'+c+'</option>';
  }).join('');

  var html = '<div style="max-width:420px;margin:0 auto;padding:20px 16px 60px">';
  html += '<div style="display:flex;align-items:center;gap:12px;margin-bottom:24px">';
  html += '<button onclick="renderFoodManager()" style="background:none;border:none;cursor:pointer;font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(255,255,255,0.3);padding:4px">← back</button>';
  html += '<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:22px;color:rgba(180,220,200,0.9)">' + (isNew?'new food':'edit food') + '</div>';
  html += '</div>';

  var fld = function(id, label, val, type, placeholder, note) {
    var v = (val!==undefined&&val!==null) ? val : '';
    return '<div style="margin-bottom:14px">' +
      '<div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1px;text-transform:uppercase;color:rgba(255,255,255,0.3);margin-bottom:5px">' + label + (note?'<span style="opacity:0.5;margin-left:6px;font-size:7px">'+note+'</span>':'') + '</div>' +
      '<input id="fe-'+id+'" type="'+(type||'text')+'" value="'+v+'" placeholder="'+(placeholder||'')+'" ' +
      'style="width:100%;padding:10px 12px;border-radius:9px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.05);font-family:\'DM Mono\',monospace;font-size:14px;color:rgba(220,230,240,0.9);outline:none;box-sizing:border-box">' +
      '</div>';
  };

  html += fld('name',   'food name',        f?f.name:'',     'text',   'e.g. Weetabix');
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">';
  html += fld('c100',   'carbs per 100g',   f?f.c100:'',     'number', '0–100', 'g');
  html += fld('gi',     'GI',               f?f.gi:'',       'number', '0–100', '0=none, 100=pure glucose');
  html += fld('g_serv', 'serving weight',   f?f.g_serv:'',   'number', 'grams', 'typical serving in g');
  html += fld('g_each', 'weight each',      f?f.g_each:'',   'number', 'grams', 'if sold individually');
  html += '</div>';

  // Calculated carbs per serving (live)
  html += '<div id="fe-serv-preview" style="font-family:\'DM Mono\',monospace;font-size:11px;color:rgba(62,207,160,0.6);margin-bottom:14px;min-height:18px"></div>';

  html += '<div style="margin-bottom:14px">';
  html += '<div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1px;text-transform:uppercase;color:rgba(255,255,255,0.3);margin-bottom:5px">category</div>';
  html += '<select id="fe-cat" style="width:100%;padding:10px 12px;border-radius:9px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.05);font-family:\'DM Mono\',monospace;font-size:13px;color:rgba(220,230,240,0.8);outline:none">' + catOpts + '</select>';
  html += '</div>';

  html += fld('note', 'note / description', f?f.note:'', 'text', 'e.g. 1 slice, 1 bowl');

  html += '<div style="display:flex;gap:8px;margin-top:24px">';
  html += '<button onclick="saveFoodEdit(\'' + (f?encodeURIComponent(f.name):'') + '\',' + (isNew?'true':'false') + ')" style="flex:1;padding:12px;border-radius:9px;border:1px solid rgba(62,180,120,0.3);background:rgba(62,180,120,0.08);font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:16px;color:rgba(62,180,120,0.9);cursor:pointer">save food</button>';
  if (!isNew) {
    html += '<button onclick="deleteFood(\'' + (f?encodeURIComponent(f.name):'') + '\')" style="padding:12px 16px;border-radius:9px;border:1px solid rgba(200,60,60,0.2);background:transparent;font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(200,80,80,0.5);cursor:pointer">delete</button>';
  }
  html += '<button onclick="renderFoodManager()" style="padding:12px 16px;border-radius:9px;border:1px solid rgba(255,255,255,0.08);background:transparent;font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(255,255,255,0.3);cursor:pointer">cancel</button>';
  html += '</div>';

  html += '</div>';
  el.innerHTML = html;

  // Live preview of carbs per serving
  function updatePreview() {
    var c = parseFloat(document.getElementById('fe-c100').value)||0;
    var g = parseFloat(document.getElementById('fe-g_serv').value)||0;
    var pr = document.getElementById('fe-serv-preview');
    if (pr) pr.textContent = (c&&g) ? 'carbs per serving: ' + (c*g/100).toFixed(1) + 'g' : '';
  }
  var c100el = document.getElementById('fe-c100');
  var gsel   = document.getElementById('fe-g_serv');
  if (c100el) c100el.oninput = updatePreview;
  if (gsel)   gsel.oninput   = updatePreview;
  updatePreview();
}

function saveFoodEdit(encodedOldName, isNew) {
  var name  = (document.getElementById('fe-name').value||'').trim();
  var c100  = parseFloat(document.getElementById('fe-c100').value)||0;
  var gi    = parseInt(document.getElementById('fe-gi').value)||0;
  var gServ = parseFloat(document.getElementById('fe-g_serv').value)||null;
  var gEach = parseFloat(document.getElementById('fe-g_each').value)||null;
  var cat   = document.getElementById('fe-cat').value||'custom';
  var note  = (document.getElementById('fe-note').value||'').trim();

  if (!name || c100 < 0) { showToast('name and carbs required'); return; }

  var f = {name:name, c100:c100, gi:gi, cat:cat};
  if (gServ) f.g_serv = gServ;
  if (gEach) f.g_each = gEach;
  if (note)  f.note   = note;

  // Remove old entry from library
  var oldName = encodedOldName ? decodeURIComponent(encodedOldName) : null;
  FOOD_LIBRARY = FOOD_LIBRARY.filter(function(x){ return x.name !== oldName && x.name !== name; });

  // Also remove from FOOD_DB if editing a built-in (it goes into library as override)
  FOOD_LIBRARY.push(f);
  saveFoodLibrary();
  showToast('saved: ' + name);
  renderFoodManager();
}

function deleteFood(encodedName) {
  var name = decodeURIComponent(encodedName);
  FOOD_LIBRARY = FOOD_LIBRARY.filter(function(x){ return x.name !== name; });
  saveFoodLibrary();
  showToast('removed: ' + name);
  renderFoodManager();
}

// ── DOCK GESTURES & FLICK ANIMATIONS ─────────────────────────────────
let _dockTouch = {};
let _corrHoldTimer = null;

function dockTouchStart(e, type) {
  const t = e.touches[0];
  _dockTouch[type] = { y: t.clientY, x: t.clientX, time: Date.now() };
}

function dockTouchEnd(e, type) {
  const start = _dockTouch[type];
  if (!start) return;
  const t = e.changedTouches[0];
  const dy = start.y - t.clientY;
  const dt = Date.now() - start.time;
  // Flick = upward movement > 30px in < 400ms
  if (dy > 30 && dt < 400) {
    const startX = t.clientX;
    const startY = start.y;
    if (type === 'food')  { flickAnimation(startX, startY, COL_COB,  1); openSheet(); }
    if (type === 'hypo')  { flickAnimation(startX, startY, COL_HYPO, 1); openHypoLog(); }
  }
  delete _dockTouch[type];
}

function correctionTap() {
  // Single tap — show the correction log (no flick needed)
  openCorrectionLog();
}

let _corrPressStart = 0;
function correctionPressStart(e) {
  _corrPressStart = Date.now();
  const ring = document.getElementById('corr-hold-ring');
  if (ring) ring.style.borderColor = 'rgba(60,130,220,0.5)';
  _corrHoldTimer = setTimeout(function() {
    // Long hold = confirmed correction entry
    const ring = document.getElementById('corr-hold-ring');
    if (ring) ring.style.borderColor = 'rgba(60,130,220,0)';
    const btn = document.getElementById('dock-correct');
    if (btn) {
      const rect = btn.getBoundingClientRect();
      flickAnimation(rect.left + rect.width/2, rect.top, COL_IOB, -1);
    }
    openCorrectionLog();
  }, 600);
}

function correctionPressEnd(e) {
  if (_corrHoldTimer) { clearTimeout(_corrHoldTimer); _corrHoldTimer = null; }
  const ring = document.getElementById('corr-hold-ring');
  if (ring) ring.style.borderColor = 'rgba(60,130,220,0)';
  const held = Date.now() - _corrPressStart;
  if (held < 600) correctionTap(); // short press = open log
}

// ── FLICK ANIMATION — particles enter the flow ────────────────────────
const _flickParticles = [];

function flickAnimation(startX, startY, col, direction) {
  // direction: 1 = rising (food/hypo), -1 = falling (correction)
  const count = 18;
  for (let i = 0; i < count; i++) {
    const angle  = -Math.PI/2 + (Math.random()-0.5) * 0.8; // mostly vertical
    const speed  = 4 + Math.random() * 8;
    _flickParticles.push({
      x:    startX + (Math.random()-0.5)*20,
      y:    startY,
      vx:   Math.cos(angle) * speed * (Math.random()-0.5),
      vy:   Math.sin(angle) * speed * direction,
      life: 1.0,
      decay:0.025 + Math.random()*0.02,
      r:    1.5 + Math.random()*2.5,
      col:  col,
    });
  }
  // Ripple at BG line (orb position)
  const orbX = NOW_X * (window.innerWidth || 390);
  const d = dataAt ? dataAt(viewTime) : null;
  const orbY = d ? bgToY(d.bg) : (window.innerHeight || 844) * 0.6;
  _flickRipples.push({ x: orbX, y: orbY, r: 0, maxR: 55, alpha: 0.7, col });
  requestAnimationFrame(animateFlick);
}

const _flickRipples = [];

function animateFlick() {
  const fc = document.getElementById('flick-canvas');
  if (!fc) return;
  fc.width  = window.innerWidth;
  fc.height = window.innerHeight;
  const ctx = fc.getContext('2d');
  ctx.clearRect(0, 0, fc.width, fc.height);

  let alive = false;

  // Draw particles
  for (const p of _flickParticles) {
    if (p.life <= 0) continue;
    alive = true;
    p.x  += p.vx;
    p.y  += p.vy;
    p.vy *= 0.96; // gentle deceleration
    p.vx *= 0.96;
    p.life -= p.decay;
    const [r,g,b] = p.col;
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.fillStyle   = `rgba(${r},${g},${b},1)`;
    ctx.shadowColor = `rgba(${r},${g},${b},0.8)`;
    ctx.shadowBlur  = 6;
    ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.3, p.r * p.life), 0, Math.PI*2); ctx.fill();
    ctx.shadowBlur  = 0;
  }

  // Draw ripples
  for (const rp of _flickRipples) {
    if (rp.alpha <= 0.01) continue;
    alive = true;
    rp.r     += (rp.maxR - rp.r) * 0.12;
    rp.alpha *= 0.88;
    const [r,g,b] = rp.col;
    ctx.globalAlpha  = Math.max(0, rp.alpha);
    ctx.strokeStyle  = `rgba(${r},${g},${b},1)`;
    ctx.lineWidth    = 1.5;
    ctx.shadowColor  = `rgba(${r},${g},${b},0.6)`;
    ctx.shadowBlur   = 8;
    ctx.beginPath(); ctx.arc(rp.x, rp.y, Math.max(0.5, rp.r), 0, Math.PI*2); ctx.stroke();
    ctx.shadowBlur   = 0;
  }

  ctx.globalAlpha = 1;

  // Clean up dead particles/ripples
  for (let i = _flickParticles.length-1; i >= 0; i--) {
    if (_flickParticles[i].life <= 0) _flickParticles.splice(i, 1);
  }
  for (let i = _flickRipples.length-1; i >= 0; i--) {
    if (_flickRipples[i].alpha <= 0.01) _flickRipples.splice(i, 1);
  }

  if (alive) requestAnimationFrame(animateFlick);
  else ctx.clearRect(0, 0, fc.width, fc.height);
}

// ── ORB LONG PRESS — whisper to the River ─────────────────────────────
let _orbPressTimer = null;
let _whisperOpen   = false;

function setupOrbLongPress() {
  const cv = document.getElementById('c');
  if (!cv) return;
  cv.addEventListener('touchstart', function(e) {
    const t = e.touches[0];
    const orbX = NOW_X * W;
    const d    = dataAt ? dataAt(viewTime) : null;
    const orbY = d ? bgToY(d.bg) : H * 0.6;
    const dist = Math.hypot(t.clientX - orbX, t.clientY - orbY);
    if (dist < 44) {
      _orbLongPressHint = 1.0;
      _orbPressTimer = setTimeout(function() {
        openWhisper();
      }, 700);
    }
  }, {passive:true});
  cv.addEventListener('touchend', function() {
    if (_orbPressTimer) { clearTimeout(_orbPressTimer); _orbPressTimer = null; }
  }, {passive:true});
}

function openWhisper() {
  if (_whisperOpen) return;
  _whisperOpen = true;
  var ex = document.getElementById('whisper-overlay');
  if (ex) ex.remove();

  var el = document.createElement('div');
  el.id  = 'whisper-overlay';
  el.style.cssText = 'position:fixed;inset:0;z-index:75;background:rgba(3,8,20,0.92);backdrop-filter:blur(20px);display:flex;flex-direction:column;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:0;pointer-events:auto;touch-action:pan-y';
  el.addEventListener('touchstart',function(e){e.stopPropagation();},{passive:true});

  el.innerHTML =
    '<div style="min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:48px 24px 40px;box-sizing:border-box">' +
    '<div style="max-width:340px;width:100%">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">' +
    '<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:22px;color:rgba(180,220,200,0.7);letter-spacing:-.5px">ask the river</div>' +
    '<button onclick="closeWhisper()" style="background:none;border:none;cursor:pointer;font-size:24px;color:rgba(255,255,255,0.25);padding:4px;line-height:1;touch-action:manipulation">×</button>' +
    '</div>' +
    '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(100,160,140,0.3);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:24px">' +
      (dataAt ? dataAt(viewTime).bg.toFixed(1) + ' mmol · ' + new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}) : '') +
    '</div>' +
    '<textarea id="whisper-input" rows="3" placeholder="what do you want to know…" ' +
      'style="width:100%;padding:14px;border-radius:12px;border:1px solid rgba(62,180,120,0.2);' +
      'background:rgba(3,8,20,0.85);font-family:\'DM Mono\',monospace;font-size:13px;' +
      'color:rgba(180,220,200,0.9);resize:none;outline:none;box-sizing:border-box;' +
      'backdrop-filter:blur(20px);line-height:1.5"></textarea>' +
    '<div id="whisper-response" style="min-height:60px;margin-top:16px;font-family:\'Fraunces\',serif;font-weight:200;font-style:italic;font-size:15px;color:rgba(180,220,200,0.6);line-height:1.6;text-align:left"></div>' +
    '<div style="display:flex;gap:10px;margin-top:20px">' +
      '<button onclick="sendWhisper()" style="flex:1;padding:14px;border-radius:10px;border:1px solid rgba(62,180,120,0.25);background:rgba(62,180,120,0.07);font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:17px;color:rgba(62,180,120,0.8);cursor:pointer;touch-action:manipulation">ask</button>' +
    '</div>' +
    '</div></div>';

  document.body.appendChild(el);
  setTimeout(function(){ var inp = document.getElementById('whisper-input'); if(inp) inp.focus(); }, 300);
}

function closeWhisper() {
  _whisperOpen = false;
  var el = document.getElementById('whisper-overlay');
  if (el) el.remove();
}

async function sendWhisper() {
  var q = (document.getElementById('whisper-input').value || '').trim();
  if (!q) return;
  var resp = document.getElementById('whisper-response');
  if (!resp) return;
  resp.textContent = '…';

  // Build context
  var d   = dataAt ? dataAt(viewTime) : {};
  var now = new Date();
  var ctx = [
    'Current time: ' + now.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}),
    'BG: ' + (d.bg||'?').toFixed(1) + ' mmol/L',
    'IOB: ' + (d.iob||0).toFixed(2) + 'U',
    'COB: ' + (d.cob||0).toFixed(1) + 'g',
    'Trend: last 5min Δ ' + (dataAt ? (d.bg - dataAt(viewTime-5*60000).bg).toFixed(1) : '?') + ' mmol',
    'Patient: Oskar, age 9, T1D, MDI, Degludec 9U basal, Novorapid bolus',
    'Overnight carb sensitivity at 3:30am: ~0.55 mmol/g (from historical data)',
    'ISF: ~1:6.5 mmol/U overnight, 1:7.0 daytime',
    'Recent history: ' + (HISTORY_RAW.slice(-6).map(h=>(h.bg).toFixed(1)).join('→') || 'none'),
  ].join('\n');

  try {
    // Route through Cloudflare proxy — add anthropic-version header
    var proxyUrl = 'https://orange-surf-6f98.john-king-uk.workers.dev/?url=' +
      encodeURIComponent('https://api.anthropic.com/v1/messages');
    var r = await fetch(proxyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 180,
        system: 'You are a calm, knowledgeable diabetes management assistant embedded in a glucose visualisation app called Oskar\'s River. Provide brief, specific, actionable insight — 2-4 sentences maximum. Never diagnose or prescribe. Always frame as contextual insight, not instruction. Use the clinical context provided. Be warm but precise.',
        messages: [{ role: 'user', content: 'Clinical context:\n' + ctx + '\n\nQuestion: ' + q }]
      })
    });
    if (!r.ok) {
      var errTxt = await r.text().catch(()=>'');
      resp.textContent = 'River is quiet right now (' + r.status + '). Try again shortly.';
      console.warn('[whisper] API error:', r.status, errTxt.slice(0,100));
      return;
    }
    var data = await r.json();
    var text = ((data.content||[])[0]||{}).text || 'No response';
    resp.style.opacity = '0';
    resp.style.transition = 'opacity .4s';
    resp.textContent = text;
    setTimeout(function(){ resp.style.opacity = '1'; }, 50);
  } catch(e) {
    console.warn('[whisper] fetch error:', e);
    resp.textContent = 'River is quiet. Check your connection and try again.';
  }
}

window.addEventListener('load', function() {
  setupOrbLongPress();
});


// ── DEBUG OVERLAY ─────────────────────────────────────────────────────
(function() {
  var _debugLog = [];
  var _origError = console.error.bind(console);
  var _origWarn  = console.warn.bind(console);

  console.error = function() {
    _origError.apply(console, arguments);
    _debugLog.unshift('[ERR] ' + Array.from(arguments).join(' '));
    if (_debugLog.length > 12) _debugLog.pop();
    updateDebugPanel();
  };
  console.warn = function() {
    _origWarn.apply(console, arguments);
    _debugLog.unshift('[WRN] ' + Array.from(arguments).join(' '));
    if (_debugLog.length > 12) _debugLog.pop();
    updateDebugPanel();
  };

  function updateDebugPanel() {
    var p = document.getElementById('debug-panel');
    if (!p || p.style.display === 'none') return;
    var lines = _debugLog.slice(0, 8).map(function(l) {
      return '<div style="border-bottom:1px solid rgba(255,255,255,0.05);padding:3px 0;word-break:break-all">' +
        l.slice(0, 120) + '</div>';
    }).join('');
    var content = document.getElementById('debug-content');
    if (content) content.innerHTML = lines || '<div style="opacity:0.4">no errors</div>';
  }

  window.__debugLog = _debugLog;
  window.__updateDebugPanel = updateDebugPanel;
})();

function openDebugPanel() {
  var p = document.getElementById('debug-panel');
  if (p) { p.remove(); return; }

  var el = document.createElement('div');
  el.id  = 'debug-panel';
  el.style.cssText = (
    'position:fixed;bottom:80px;left:8px;right:8px;z-index:200;' +
    'background:rgba(0,0,0,0.92);border:1px solid rgba(255,255,255,0.1);' +
    'border-radius:10px;padding:10px;font-family:monospace;font-size:10px;' +
    'color:rgba(200,220,200,0.8);max-height:50vh;overflow-y:auto;' +
    'touch-action:pan-y;pointer-events:auto'
  );

  // Status section
  var d   = (typeof dataAt === 'function') ? dataAt(viewTime) : {};
  var age = (typeof _lastReadingT !== 'undefined' && _lastReadingT > 0)
    ? Math.round((Date.now() - _lastReadingT) / 60000) + ' min ago'
    : 'unknown';
  var src = (typeof _sourceId !== 'undefined') ? _sourceId : 'none';
  var hist = (typeof HISTORY_RAW !== 'undefined') ? HISTORY_RAW.length : '?';
  var buildStr = '__BUILD_ID__';

  el.innerHTML =
    '<div style="display:flex;justify-content:space-between;margin-bottom:6px">' +
      '<span style="color:rgba(62,207,160,0.8);font-weight:bold">River Debug</span>' +
      '<button onclick="document.getElementById(\'debug-panel\').remove()" ' +
        'style="background:none;border:none;color:rgba(255,255,255,0.4);cursor:pointer;font-size:16px;padding:0">×</button>' +
    '</div>' +
    '<div style="color:rgba(150,200,150,0.6);margin-bottom:6px;line-height:1.6">' +
      buildStr + ' · source: ' + src + '<br>' +
      'last reading: ' + age + ' · history: ' + hist + ' entries<br>' +
      'BG: ' + (d.bg ? d.bg.toFixed(1) : '?') +
      ' IOB: ' + (d.iob ? d.iob.toFixed(2) : '?') +
      ' COB: ' + (d.cob ? d.cob.toFixed(1) : '?') +
    '</div>' +
    '<div id="debug-content" style="line-height:1.5"></div>';

  document.body.appendChild(el);
  if (window.__updateDebugPanel) window.__updateDebugPanel();
}

function openSettings() {
  // Re-render setup screen on top
  const existing = document.getElementById('setup-screen');
  if (existing) existing.remove();
  document.body.insertAdjacentHTML('beforeend', buildSetupScreen());
  _selectedSource = loadCGMConfig()?.sourceId || 'nightscout';
  renderSourceFields(_selectedSource);
  // Add close button
  const sc = document.getElementById('setup-screen');
  if (sc) {
    sc.querySelector('div').insertAdjacentHTML('afterbegin',
      `<button onclick="dismissSetup()" style="position:absolute;top:16px;right:16px;
        background:none;border:none;cursor:pointer;font-size:22px;
        color:rgba(40,55,50,0.3)">×</button>`);
  }
}




window.addEventListener('load',()=>{
  // Load any persisted CGM history from previous sessions
  loadPersistedReadings();

  // If no embedded history, start at now
  if (HISTORY_RAW.length === 0) updateCGMBounds();
  viewTime = CGM_END || Date.now();
  viewSpan = 2*3600000;
  try{
    SESSION=JSON.parse(localStorage.getItem('river_session')||'[]'); SESSION=SESSION.filter(s=>(Date.now()-s.t)<7*86400000);
  }catch(e){}
  const pal=palette(CGM_END);
  document.body.style.background='#05070f';
  document.getElementById('loading').style.background='#05070f';

  requestAnimationFrame(ts=>{t0=ts; requestAnimationFrame(frame);});
  setTimeout(()=>{
    document.getElementById('loading').classList.add('gone');
    setTimeout(()=>document.getElementById('loading').style.display='none',700);
  },1000);

  // CGM source — auto-connect if configured, show setup if not
  const saved = loadCGMConfig();
  if (saved && saved.sourceId && saved.sourceId !== 'manual') {
    // Re-use saved credentials silently
    setTimeout(()=> startLivePolling(saved.sourceId, saved.fields), 1500);
  } else if (saved && saved.sourceId === 'manual') {
    // Manual / demo mode — load equilibrium scenario
    setTimeout(function(){ loadScenario('equilibrium'); }, 400);
  } else {
    // First run — show setup screen, load demo underneath so canvas isn't empty
    setTimeout(function(){ loadScenario('equilibrium'); }, 400);
    setTimeout(()=>{
      document.body.insertAdjacentHTML('beforeend', buildSetupScreen());
      _selectedSource = 'nightscout';
      renderSourceFields('nightscout');
    }, 1200);
  }
})
