// ═══════════════════════════════════════════════════════════════
//  OSKAR'S RIVER  v4
//  Mood: zen void river — balance, breath, flow
//  Forces: COB (warm orange) rises from below — carbs absorbing
//          IOB (cool blue) falls from above — insulin working
//  Reservoirs anchor to event time, peak at per-GI absorption peak
//  Individual food GI curves visible in reservoir bell stack
//  Particles pair and annihilate when forces balance
//  Unaccounted forces (exercise, cold, stress) shift the line too
//  Target corridor glows — the zen tunnel, aim for stillness
//  Multi-device sync via Supabase
// ═══════════════════════════════════════════════════════════════

// ── DATA PLACEHOLDER (injected at build time) ─────────────────
const HISTORY_RAW = window.__RIVER_HISTORY__ || [];

// ═══════════════════════════════════════════════════════════════════════
//  OSKAR'S RIVER — SUPABASE SYNC MODULE
//  Multi-device sync: John (read/write) + Elisa (read)
//  Offline-first: app works fully without connection
//  Sync on: startup, after logging, every 5 minutes
//  Conflict resolution: last-write-wins on events, merge on readings
// ═══════════════════════════════════════════════════════════════════════

// ── CONFIG — paste your values here ───────────────────────────────────
const SUPABASE_URL     = 'https://oafnrfxypmllyvdewztm.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_MFxi8_3Nsj4O-8_oSG8a7Q_OwpnjKWy';
const SUPABASE_READY   = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

// ── SCHEMA (run this SQL in Supabase → SQL Editor) ─────────────────────
// Paste and run once to create tables + policies:
//
// -- CGM readings (from Nightscout/Libre)
// create table if not exists readings (
//   id          bigserial primary key,
//   t           bigint not null unique,   -- unix ms timestamp
//   bg          float  not null,          -- mmol/L
//   trend       text,
//   src         text,
//   created_at  timestamptz default now()
// );
//
// -- Logged events (meals, boluses, corrections, hypo treatments)
// create table if not exists events (
//   id          bigserial primary key,
//   t           bigint not null,          -- event time unix ms
//   c           float  default 0,         -- carbs g
//   u           float  default 0,         -- insulin units
//   gi          float,                    -- avg GI of meal
//   note        text,                     -- 'carbs'|'bolus'|'hypo:glucose_tabs' etc
//   items       jsonb,                    -- per-food breakdown [{name,carbs,gi,g}]
//   device_id   text,                     -- which device logged it
//   created_at  timestamptz default now(),
//   updated_at  timestamptz default now()
// );
//
// -- RLS policies (allow anon read, write with device token)
// alter table readings enable row level security;
// alter table events   enable row level security;
//
// create policy "anyone can read readings" on readings for select using (true);
// create policy "anyone can insert readings" on readings for insert with check (true);
//
// create policy "anyone can read events" on events for select using (true);
// create policy "anyone can insert events" on events for insert with check (true);
// create policy "anyone can update events" on events for update using (true);
//
// -- Index for time-range queries
// create index if not exists readings_t_idx on readings (t desc);
// create index if not exists events_t_idx   on events   (t desc);

// ── DEVICE ID — identifies this install ───────────────────────────────
const _deviceId = (function() {
  var id = localStorage.getItem('river_device_id');
  if (!id) {
    id = 'dev_' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem('river_device_id', id);
  }
  return id;
})();

// ── SYNC STATE ─────────────────────────────────────────────────────────
var _syncState    = 'idle';  // idle | syncing | error | ok
var _lastSyncT    = 0;
var _syncError    = null;
var _pendingPush  = [];      // events queued while offline

// ── HTTP HELPER ────────────────────────────────────────────────────────
async function _sbFetch(path, opts) {
  if (!SUPABASE_READY) throw new Error('Supabase not configured');
  var url = SUPABASE_URL + '/rest/v1/' + path;
  var headers = {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
    'Prefer':        opts.prefer || 'return=minimal',
  };
  var r = await fetch(url, {
    method:  opts.method || 'GET',
    headers: Object.assign(headers, opts.headers || {}),
    body:    opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!r.ok) {
    var txt = await r.text().catch(function(){ return ''; });
    throw new Error('Supabase ' + r.status + ': ' + txt.slice(0, 120));
  }
  if (r.status === 204) return null;
  const txt2 = await r.text();
  if (!txt2 || txt2.trim() === '') return null;
  try { return JSON.parse(txt2); } catch(e) { return null; }
}

// ── PUSH: local events → Supabase ─────────────────────────────────────
async function syncPushEvents(events) {
  if (!SUPABASE_READY || !events || events.length === 0) return;
  // Upsert — safe to call multiple times
  var rows = events.map(function(ev) {
    return {
      t:         ev.t,
      c:         ev.c   || 0,
      u:         ev.u   || 0,
      gi:        ev.gi  || null,
      note:      ev.note || null,
      items:     ev.items ? ev.items : null,
      device_id: _deviceId,
      updated_at: new Date().toISOString(),
    };
  });
  try {
    // Try upsert first (requires unique constraint on t in Supabase)
    await _sbFetch('events?on_conflict=t', {
      method:  'POST',
      prefer:  'resolution=merge-duplicates,return=minimal',
      body:    rows,
    });
  } catch(e) {
    if (e.message.includes('42P10') || e.message.includes('no unique')) {
      // No unique constraint — fall back to plain INSERT, swallow dupes
      try {
        await _sbFetch('events', { method: 'POST', prefer: 'return=minimal', body: rows });
      } catch(e2) {
        if (!e2.message.includes('409') && !e2.message.includes('23505')) throw e2;
      }
    } else if (!e.message.includes('409') && !e.message.includes('23505')) {
      throw e;
    }
  }
}

// ── PUSH: CGM readings → Supabase ────────────────────────────────────
async function syncPushReadings(readings) {
  if (!SUPABASE_READY || !readings || readings.length === 0) return;
  var rows = readings.map(function(r) {
    return { t: r.t, bg: r.bg, trend: r.trend || null, src: r.src || null };
  });
  // Upsert on t (unique) — ignore conflicts
  await _sbFetch('readings?on_conflict=t', {
    method: 'POST',
    prefer: 'resolution=ignore-duplicates,return=minimal',
    body:   rows,
  });
}

// ── PULL: Supabase readings → local ───────────────────────────────────
async function syncPullReadings(sinceT) {
  var since = sinceT || (Date.now() - 7 * 86400000);
  var rows  = await _sbFetch(
    'readings?t=gte.' + since + '&order=t.asc&limit=2000',
    { method: 'GET' }
  );
  if (!rows || rows.length === 0) return 0;
  var added = 0;
  rows.forEach(function(row) {
    var exists = HISTORY_RAW.findIndex(function(h){ return Math.abs(h.t - row.t) < 90000; });
    if (exists < 0) {
      HISTORY_RAW.push({ t: row.t, bg: row.bg, iob: 0, cob: 0, pen: 1 });
      added++;
    }
  });
  if (added > 0) {
    HISTORY_RAW.sort(function(a,b){ return a.t - b.t; });
    updateCGMBounds();
  }
  return added;
}

// ── PULL: Supabase events → local ─────────────────────────────────────
async function syncPullEvents(sinceT) {
  // Only pull events from the last 6h — older events are irrelevant to the visual window.
  var _pullCutoff = Date.now() - 6 * 3600000;
  var since = Math.max(sinceT || 0, _pullCutoff);
  var rows  = await _sbFetch(
    'events?t=gte.' + since + '&order=t.asc&limit=500',
    { method: 'GET' }
  );
  if (!rows || rows.length === 0) return 0;
  var added = 0;
  rows.forEach(function(row) {
    // Skip events the user has explicitly deleted on this device
    if (typeof _deletedEventTs !== 'undefined' && _deletedEventTs.has(row.t)) return;
    // Merge into LOGGED_EVENTS
    var existsL = LOGGED_EVENTS.findIndex(function(e){ return e.t === row.t && Math.abs((e.c||0) - (row.c||0)) < 0.5; });
    if (existsL < 0) {
      var rowItems = row.items;
      if (typeof rowItems === 'string') { try { rowItems = JSON.parse(rowItems); } catch(_e) { rowItems = null; } }
      var ev = { t: row.t, c: row.c||0, u: row.u||0, gi: row.gi, note: row.note, items: rowItems, local: false };
      LOGGED_EVENTS.push(ev);
      BOLUS_EVENTS.push(ev);
      // Do NOT push into SESSION — historical Supabase events must not drive dataAt().
      added++;
    }
  });
  if (added > 0) {
    try { localStorage.setItem('river_logged', JSON.stringify(LOGGED_EVENTS)); } catch(e){}
    try { localStorage.setItem('river_session', JSON.stringify(SESSION)); } catch(e){}
  }
  return added;
}

// ── FULL SYNC ─────────────────────────────────────────────────────────
var _syncTimer = null;

async function syncNow(silent) {
  if (!SUPABASE_READY) return;
  if (_syncState === 'syncing') return;
  _syncState = 'syncing';
  _updateSyncIndicator();

  try {
    // Push all locally-logged events — local:true means logged on this device.
    // Upsert on Supabase handles duplicates. Always push regardless of _lastSyncT.
    var localEvents = LOGGED_EVENTS.filter(function(e){ return e.local === true; });
    if (localEvents.length > 0) await syncPushEvents(localEvents);

    // Push recent CGM readings — skip on very first startup sync (no real data yet)
    if (_lastSyncT > 0) {
      var recentReadings = HISTORY_RAW.filter(function(h){
        return h.t > Date.now() - 3600000 && h.bg > 0;
      });
      if (recentReadings.length > 0) await syncPushReadings(recentReadings);
    }

    // Pull everything from other devices
    var sinceT    = _lastSyncT || Date.now() - 7 * 86400000;
    var newRead   = await syncPullReadings(sinceT);
    var newEvents = await syncPullEvents(sinceT);
    await syncPullPricks();

    _lastSyncT  = Date.now();
    _syncState  = 'ok';
    _syncError  = null;

    if (!silent && (newRead > 0 || newEvents > 0)) {
      console.log('[sync] pulled ' + newRead + ' readings, ' + newEvents + ' events');
    }
  } catch(err) {
    _syncState = 'error';
    _syncError = err.message;
    console.warn('[sync] failed:', err.message);
  }

  _updateSyncIndicator();
}

function startSyncPolling() {
  if (!SUPABASE_READY) return;
  syncNow(true); // immediate on startup
  _syncTimer = setInterval(function(){ syncNow(true); }, 5 * 60000);
}

function stopSyncPolling() {
  if (_syncTimer) { clearInterval(_syncTimer); _syncTimer = null; }
}

// ── RESUME / FOCUS HANDLERS — repoll immediately on return to app ─────
// Covers: tab switch, phone unlock, Safari background/foreground.
// Without this, there's a gap until the next 5-min interval fires.
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState !== 'visible') return;
  var stale = Date.now() - _lastReadingT > 60000;
  // Re-poll CGM if we haven't had a reading in the last minute
  if (stale && _sourceId && _sourceCfg && CGM_SOURCES[_sourceId]) {
    CGM_SOURCES[_sourceId].fetch(_sourceCfg, 2).then(function(readings) {
      if (readings.length > 0) {
        ingestReadings(readings);
        setLiveStatus('live', formatAge(readings[readings.length-1].t));
        triggerNewReadingPulse();
      }
    }).catch(function(){});
  }
  // Also re-sync events/pricks from Supabase
  if (stale && SUPABASE_READY) syncNow(true);
});
window.addEventListener('pageshow', function(e) {
  // bfcache restore — browser replays the page from cache without firing load
  if (e.persisted) {
    if (_sourceId && _sourceCfg && CGM_SOURCES[_sourceId]) {
      CGM_SOURCES[_sourceId].fetch(_sourceCfg, 2).then(function(readings) {
        if (readings.length > 0) ingestReadings(readings);
      }).catch(function(){});
    }
    if (SUPABASE_READY) syncNow(true);
  }
});

// ── SYNC AFTER LOGGING — call after any event is saved ────────────────
function syncAfterLog() {
  if (!SUPABASE_READY) return;
  syncNow(true); // immediate — no delay
}

// ── SYNC STATUS INDICATOR ─────────────────────────────────────────────
function _updateSyncIndicator() {
  var el = document.getElementById('sync-indicator');
  if (!el) return;
  var labels = { syncing:'↻', ok:'✓', error:'!', idle:'' };
  var colors = {
    syncing: 'rgba(200,200,200,0.5)',
    ok:      'rgba(62,180,120,0.6)',
    error:   'rgba(220,80,60,0.7)',
    idle:    'rgba(100,100,100,0.3)',
  };
  el.textContent = labels[_syncState] || '';
  el.style.color = colors[_syncState] || colors.idle;
  el.title = _syncError || (_syncState === 'ok' ? 'synced ' + new Date(_lastSyncT).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}) : _syncState);
}

// ── SETTINGS UI — Supabase config in the settings screen ──────────────
function buildSupabaseSettingsHTML() {
  var configured = SUPABASE_READY;
  var lastSync   = _lastSyncT > 0
    ? 'last sync ' + new Date(_lastSyncT).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})
    : 'not yet synced';

  return '<div style="margin-top:24px;padding-top:20px;border-top:1px solid rgba(40,55,50,0.08)">' +
    '<div style="font-family:\'DM Mono\',monospace;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:rgba(40,55,50,0.6);margin-bottom:12px">multi-device sync</div>' +
    (configured
      ? '<div style="font-family:\'DM Mono\',monospace;font-size:11px;color:rgba(62,180,120,0.8);margin-bottom:8px">✓ connected · ' + lastSync + '</div>'
      : '<div style="font-family:\'DM Mono\',monospace;font-size:11px;color:rgba(200,140,60,0.7);margin-bottom:8px">not configured — add URL + key to app.js</div>'
    ) +
    '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(40,55,50,0.35);line-height:1.7">' +
      'Syncs readings and logged events across John\'s phone and Elisa\'s device.<br>' +
      'Data stored in Supabase (your account, your data).' +
    '</div>' +
    (configured ? '<button onclick="syncNow(false)" style="margin-top:10px;padding:7px 14px;border-radius:8px;border:1px solid rgba(62,180,120,0.25);background:rgba(62,180,120,0.06);font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(62,180,120,0.7);cursor:pointer">sync now</button>' : '') +
  '</div>';
}


var BOLUS_EVENTS = [];
var LOGGED_EVENTS = [];
try { LOGGED_EVENTS = JSON.parse(localStorage.getItem('river_logged')||'[]');
  // Keep only last 6h — older events are not displayed and cause ghost bells on reload.
  var _sixHoursAgo = Date.now() - 6 * 3600000;
  LOGGED_EVENTS = LOGGED_EVENTS.filter(function(e){ return e.t >= _sixHoursAgo; });
  LOGGED_EVENTS.forEach(function(e){ BOLUS_EVENTS.push(e); });
  // Write trimmed list back so it doesn't grow indefinitely
  try { localStorage.setItem('river_logged', JSON.stringify(LOGGED_EVENTS)); } catch(_le){}
} catch(err) {}

const POD_PAUSE_T  = 1773651600000;
let CGM_START = HISTORY_RAW.length > 0 ? HISTORY_RAW[0].t : Date.now() - 2*3600000;
let CGM_END   = HISTORY_RAW.length > 0 ? HISTORY_RAW[HISTORY_RAW.length-1].t : Date.now();

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

// ── VISUAL PREFERENCES — user-configurable overrides ─────────────────
// Stored in localStorage. Merged on top of the time-of-day palette.
// null = use palette default. Set via openVisualSettings().
var RIVER_VISUAL_PREFS = (function() {
  try { return JSON.parse(localStorage.getItem('river_visual_prefs') || 'null') || {}; }
  catch(e) { return {}; }
})();
// Apply contrast tokens immediately on load
(function(){ if(typeof applyUITokens==='function') applyUITokens(RIVER_VISUAL_PREFS.bgTint||'#060914'); })();


// ── UI CONTRAST TOKENS — derived from background luminance ───────────
// Called on startup and whenever visual prefs change.
// Sets CSS custom properties on :root so all overlays inherit automatically.

function _hexLuminance(hex) {
  hex = (hex || '#060914').replace('#','');
  if (hex.length === 3) hex = hex.split('').map(function(c){return c+c;}).join('');
  var r = parseInt(hex.slice(0,2),16)/255;
  var g = parseInt(hex.slice(2,4),16)/255;
  var b = parseInt(hex.slice(4,6),16)/255;
  // sRGB linearise
  var lin = function(c){ return c<=0.04045 ? c/12.92 : Math.pow((c+0.055)/1.055,2.4); };
  return 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b);
}

function deriveUITokens(bgHex) {
  var lum = _hexLuminance(bgHex || '#060914');
  var dark = lum < 0.18;   // true for most night/dark themes
  var mid  = lum >= 0.18 && lum < 0.5; // mid-tone — needs care

  // Panel background — slightly lighter/darker than canvas bg
  var panelBg, panelBorder, inputBg, inputBorder;
  var textPrimary, textSecondary, textMuted, textDim;
  var swatchBorder, divider, closeBtnCol;

  if (dark) {
    panelBg      = 'rgba(4,6,22,0.97)';
    panelBorder  = 'rgba(255,255,255,0.07)';
    inputBg      = 'rgba(255,255,255,0.05)';
    inputBorder  = 'rgba(255,255,255,0.10)';
    textPrimary  = 'rgba(200,220,240,0.88)';
    textSecondary= 'rgba(180,200,220,0.78)';
    textMuted    = 'rgba(160,180,200,0.62)';
    textDim      = 'rgba(140,160,180,0.22)';
    swatchBorder = 'rgba(255,255,255,0.14)';
    divider      = 'rgba(255,255,255,0.06)';
    closeBtnCol  = 'rgba(255,255,255,0.35)';
  } else if (mid) {
    // Mid-tone: use dark-on-light for text, slightly opaque panel
    panelBg      = 'rgba(240,238,232,0.96)';
    panelBorder  = 'rgba(0,0,0,0.10)';
    inputBg      = 'rgba(0,0,0,0.06)';
    inputBorder  = 'rgba(0,0,0,0.14)';
    textPrimary  = 'rgba(20,24,32,0.90)';
    textSecondary= 'rgba(30,34,44,0.65)';
    textMuted    = 'rgba(40,44,54,0.65)';
    textDim      = 'rgba(40,44,54,0.25)';
    swatchBorder = 'rgba(0,0,0,0.18)';
    divider      = 'rgba(0,0,0,0.08)';
    closeBtnCol  = 'rgba(0,0,0,0.30)';
  } else {
    // Light bg: full dark-on-light
    panelBg      = 'rgba(248,246,240,0.98)';
    panelBorder  = 'rgba(0,0,0,0.08)';
    inputBg      = 'rgba(0,0,0,0.05)';
    inputBorder  = 'rgba(0,0,0,0.12)';
    textPrimary  = 'rgba(16,20,30,0.92)';
    textSecondary= 'rgba(24,28,40,0.68)';
    textMuted    = 'rgba(32,36,50,0.66)';
    textDim      = 'rgba(32,36,50,0.26)';
    swatchBorder = 'rgba(0,0,0,0.16)';
    divider      = 'rgba(0,0,0,0.07)';
    closeBtnCol  = 'rgba(0,0,0,0.28)';
  }

  return {
    lum, dark, mid,
    panelBg, panelBorder, inputBg, inputBorder,
    textPrimary, textSecondary, textMuted, textDim,
    swatchBorder, divider, closeBtnCol,
  };
}

// Returns the user's preferred label opacity (safety-floored at 0.15)
function getLabelOpacity() {
  var v = RIVER_VISUAL_PREFS.labelOpacity;
  return (v !== undefined && v !== null) ? Math.max(0.15, v) : 0.7;
}

function applyUITokens(bgHex) {
  var tk = deriveUITokens(bgHex);
  var root = document.documentElement;
  root.style.setProperty('--rv-panel-bg',       tk.panelBg);
  root.style.setProperty('--rv-panel-border',    tk.panelBorder);
  root.style.setProperty('--rv-input-bg',        tk.inputBg);
  root.style.setProperty('--rv-input-border',    tk.inputBorder);
  root.style.setProperty('--rv-text-primary',    tk.textPrimary);
  root.style.setProperty('--rv-text-secondary',  tk.textSecondary);
  root.style.setProperty('--rv-text-muted',      tk.textMuted);
  root.style.setProperty('--rv-text-dim',        tk.textDim);
  root.style.setProperty('--rv-swatch-border',   tk.swatchBorder);
  root.style.setProperty('--rv-divider',         tk.divider);
  root.style.setProperty('--rv-close-btn',       tk.closeBtnCol);
}

function saveVisualPrefs() {
  try { localStorage.setItem('river_visual_prefs', JSON.stringify(RIVER_VISUAL_PREFS)); }
  catch(e) {}
}

// GI colour ramp — continuous interpolation from hot (fast carbs) to cool (slow carbs)
// Each stop: [gi_threshold, r, g, b]
// The hot and cool ends are configurable via visual settings.
const GI_COLOUR_RAMP_DEFAULT = [
  [100, 255, 210,  40],
  [ 75, 255, 140,  50],
  [ 55, 230, 100,  80],
  [ 35, 160, 180,  90],
  [ 20, 110, 160, 190],
  [  0,  90, 100, 200],
];

function _buildGIRamp() {
  var ramp = GI_COLOUR_RAMP_DEFAULT.map(function(s){ return s.slice(); });
  if (RIVER_VISUAL_PREFS.carbHot)  { var h=RIVER_VISUAL_PREFS.carbHot;  ramp[0][1]=h[0];ramp[0][2]=h[1];ramp[0][3]=h[2]; }
  if (RIVER_VISUAL_PREFS.carbCool) { var c=RIVER_VISUAL_PREFS.carbCool; ramp[ramp.length-1][1]=c[0];ramp[ramp.length-1][2]=c[1];ramp[ramp.length-1][3]=c[2]; }
  return ramp;
}

function giToColour(gi) {
  gi = Math.max(0, Math.min(100, gi || 55));
  var ramp = _buildGIRamp();
  for (var i = 0; i < ramp.length - 1; i++) {
    var hi = ramp[i], lo = ramp[i + 1];
    if (gi >= lo[0]) {
      var f = (gi - lo[0]) / (hi[0] - lo[0]);
      return [
        Math.round(lo[1] + f * (hi[1] - lo[1])),
        Math.round(lo[2] + f * (hi[2] - lo[2])),
        Math.round(lo[3] + f * (hi[3] - lo[3])),
      ];
    }
  }
  return ramp[ramp.length - 1].slice(1);
}
const BG_MIN  = 2.0, BG_MAX  = 18.0;
const MAX_IOB = 6.0, MAX_COB = 80.0;
const NOW_X   = 0.62;
const IOB_PEAK = 70; // "now" position — past to left, future to right
// HORIZON removed — full-bleed void, no sky/water split

// Session entries
let SESSION = [];
var _eatReminder = null; // timeout handle for eat-now reminder after bolus
try { SESSION = JSON.parse(localStorage.getItem('river_session')||'[]'); SESSION=SESSION.filter(function(s){return (Date.now()-s.t)<6*3600000;}); } catch(e){}

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
  const a=HISTORY_RAW[lo], b=HISTORY_RAW[hi];
  // Don't interpolate across CGM gaps > 12 min (2+ missed readings) — return gap sentinel
  if (b.t - a.t > 12 * 60000) return { bg: null, iob: 0, cob: 0, pen: 1, gap: true };
  const f=(t-a.t)/(b.t-a.t);
  return { bg:a.bg+f*(b.bg-a.bg), iob:a.iob+f*(b.iob-a.iob),
           cob:a.cob+f*(b.cob-a.cob), pen:a.pen };
}
function dataAt(t) {
  const h = histAt(t);
  let si=0, sc=0;
  // Count SESSION entries and BOLUS_EVENTS after last CGM reading.
  // SESSION alone is lost on reload; BOLUS_EVENTS persists via Supabase sync.
  // Merge both (dedup by timestamp) so reservoirs survive hard reloads.
  // Use 6h floor so pad-imported events with past timestamps are still shown.
  // CGM_END - 5min was too aggressive — it excluded anything logged before the last reading.
  const _cgmFloor = Date.now() - 6 * 3600000;
  var _seen = {};
  var _sources = SESSION.concat(BOLUS_EVENTS);
  for (var _si = 0; _si < _sources.length; _si++) {
    var s = _sources[_si];
    if (s.t < _cgmFloor) continue;
    var _key = Math.round(s.t / 15000) + '_' + (s.u||0).toFixed(1) + '_' + (s.c||0).toFixed(0);
    if (_seen[_key]) continue;
    _seen[_key] = true;
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
  var p = {
    bg0:  lo.bg0,
    bg1:  lo.bg1,
    cobR: lerpC(lo.cobR, hi.cobR, f),
    iobR: lerpC(lo.iobR, hi.iobR, f),
    bgLine: lerpC(lo.bgLine, hi.bgLine, f),
    particle: lo.particle,
    voidAlpha: lo.voidAlpha + f*(hi.voidAlpha - lo.voidAlpha),
    name: f < 0.5 ? lo.name : hi.name,
    isNight: (f < 0.5 ? lo.name : hi.name) === 'night',
  };
  // Merge user visual preferences on top of the time-of-day palette
  var vp = RIVER_VISUAL_PREFS;
  if (vp.bgTint)  { p.bg0 = vp.bgTint; p.bg1 = vp.bgTint; }
  if (vp.cobR)    { p.cobR = vp.cobR; }
  if (vp.iobR)    { p.iobR = vp.iobR; }
  if (vp.bgLine)  { p.bgLine = vp.bgLine; }
  return p;
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
  if (bg === null || bg === undefined || isNaN(bg)) return H * 0.5;
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

  // Build a set of gap intervals from HISTORY_RAW (gaps > 12 min)
  const gapIntervals = [];
  for (let gi = 1; gi < HISTORY_RAW.length; gi++) {
    const gapMs = HISTORY_RAW[gi].t - HISTORY_RAW[gi-1].t;
    if (gapMs > 12 * 60000) {
      gapIntervals.push([HISTORY_RAW[gi-1].t, HISTORY_RAW[gi].t]);
    }
  }
  function inGap(t) {
    return gapIntervals.some(function(g){ return t > g[0] && t < g[1]; });
  }

  for (let i=0; i<=n; i++) {
    const t = leftT + (i/n)*(viewTime-leftT);
    const d = dataAt(t);
    const gap = inGap(t) || d.gap || d.bg === null;
    const bg = (d.bg !== null && d.bg !== undefined) ? d.bg : 0;
    pts.push({ x: tX(t), y: bgToY(bg), bg, t, gap });
  }
  if (pts.length < 2) return;

  CX.save();

  const ptsNoGap = pts.filter(function(p){ return !p.gap; });
  // Outer glow — wide, very soft
  CX.globalAlpha = 0.10;
  CX.strokeStyle = `rgba(${pal.bgLine.join(',')},1)`;
  CX.lineWidth   = 16;
  CX.lineJoin    = 'round'; CX.lineCap = 'round';
  _drawSmoothLine(ptsNoGap);
  CX.stroke();

  // Mid glow
  CX.globalAlpha = 0.22;
  CX.lineWidth   = 6;
  _drawSmoothLine(ptsNoGap);
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
    // Break line at sensor gaps
    if (pts[i].gap) {
      if (seg.length > 1) {
        CX.strokeStyle = segCol; CX.shadowColor = segCol; CX.shadowBlur = 3;
        _drawSmoothLine(seg); CX.stroke(); CX.shadowBlur = 0;
      }
      // Only draw dotted gap bridge for historical gaps (not active/current gap)
      if (i > 0 && !pts[i-1].gap) {
        // Check if this gap extends to the present (active gap)
        var gapIsActive = pts[i].t >= (HISTORY_RAW.length > 0 ? HISTORY_RAW[HISTORY_RAW.length-1].t : 0) - 30000;
        if (!gapIsActive) {
          CX.save();
          CX.globalAlpha = 0.15;
          CX.strokeStyle = 'rgba(180,200,220,1)';
          CX.lineWidth = 1;
          CX.setLineDash([3, 8]);
          CX.beginPath();
          CX.moveTo(pts[i-1].x, pts[i-1].y);
          CX.lineTo(pts[i].x, pts[i].y);
          CX.stroke();
          CX.setLineDash([]);
          CX.restore();
        }
      }
      seg = []; segCol = null;
      continue;
    }
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

  // ── SMART FORECAST — per-food GI + IOB decay ─────────────────────────
  const predC = buildSmartForecast();
  if (predC.length > 1) {
    const startPt = pts[pts.length-1] || predC[0];
    const last    = predC[predC.length-1];
    const endCol  = last.bg > BG_HIGH ? `rgba(230,140,40,` :
                    last.bg < BG_LOW  ? `rgba(80,130,220,` :
                    `rgba(${pal.bgLine.join(',')},`;

    // Uncertainty bands
    [[-2,0.04],[-1,0.06],[0,0.11],[1,0.06],[2,0.04]].forEach(function(band) {
      const spread = band[0]*7, alpha = band[1];
      CX.globalAlpha = alpha;
      CX.strokeStyle = `rgba(${pal.bgLine.join(',')},1)`;
      CX.lineWidth = 3; CX.setLineDash([3,6]);
      CX.beginPath(); CX.moveTo(startPt.x, startPt.y+spread);
      predC.forEach(function(p){ CX.lineTo(p.x, p.y+spread); });
      CX.stroke();
    });

    // Centre line — colour by predicted landing
    CX.globalAlpha = 0.5;
    CX.strokeStyle = endCol + '1)';
    CX.lineWidth = 1.8; CX.setLineDash([4,7]);
    CX.beginPath(); CX.moveTo(startPt.x, startPt.y);
    predC.forEach(function(p){ CX.lineTo(p.x, p.y); });
    CX.stroke(); CX.setLineDash([]);

    // Landing dot
    CX.globalAlpha = 0.8;
    CX.fillStyle   = endCol + '0.9)';
    CX.shadowColor = endCol + '0.5)'; CX.shadowBlur = 6;
    CX.beginPath(); CX.arc(last.x, last.y, 3.5, 0, Math.PI*2); CX.fill();
    CX.shadowBlur = 0;

    // Landing value + time label
    CX.globalAlpha = 0.6;
    CX.fillStyle   = endCol + '1)';
    CX.font        = "300 10px 'Fraunces',serif"; CX.textAlign = 'center';
    CX.fillText(last.bg.toFixed(1), last.x, last.y - 9);
    CX.globalAlpha = 0.3;
    CX.font        = "300 8px 'DM Mono',monospace";
    CX.fillText('+' + last.mins + 'min', last.x, last.y + 13);
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
// ── PARTICLE FORCE SYSTEM v2 — per-food GI curves ────────────────────
// Each logged food contributes its own absorption bell to the COB reservoir.
// Bell width and peak time driven by individual food GI.
// Reservoir bell scales with viewSpan (zoom-aware).
// IOB anchors to bolus time + Novorapid 75min peak.
// Smart forecast factors per-food curves + IOB decay.

var _cobReservoir   = 0;
var _lastCOBPeakY   = -1;   // canvas Y of tallest active COB bell peak (for pill tracking)
var _lastIOBPeakY   = -1;   // canvas Y of tallest active IOB bell peak
var _iobReservoir   = 0;
var _forceParticles = [];
var _forceMists     = [];
var _forceSparks    = [];
var _forceFrame     = 0;

function topUpCOB(grams)  { _cobReservoir = Math.min(1, _cobReservoir + grams / 80); }
function topUpIOB(units)  { _iobReservoir = Math.min(1, _iobReservoir + units / 6);  }

function _getActiveMealEvents() {
  // Always use real clock for cutoff — not viewTime which can be scrubbed back.
  // This prevents old events from appearing when user scrolls left.
  var cutoff = Date.now() - 6 * 3600000;
  var events = [], seen = {};
  BOLUS_EVENTS.concat(SESSION).forEach(function(ev) {
    if (!ev.c || ev.c <= 0 || ev.t < cutoff) return;
    var key = Math.round(ev.t / 30000);
    if (seen[key]) return;
    seen[key] = true;
    events.push({ t: ev.t, c: ev.c, gi: ev.gi||55,
      items: ev.items || [{name:'meal', carbs:ev.c, gi:ev.gi||55}] });
  });
  return events.sort(function(a,b){ return a.t-b.t; });
}

function _getActiveBolusEvents() {
  var cutoff = Date.now() - 6 * 3600000;
  var events = [], seen = {};
  BOLUS_EVENTS.concat(SESSION).forEach(function(ev) {
    if (!ev.u || ev.u <= 0 || ev.t < cutoff) return;
    var key = Math.round(ev.t / 30000);
    if (seen[key]) return;
    seen[key] = true;
    events.push({ t: ev.t, u: ev.u });
  });
  return events.sort(function(a,b){ return a.t-b.t; });
}

function _cobFgi(mins, gi) {
  gi = gi || 55;
  if (mins <= 0) return 1; if (mins >= 240) return 0;
  var pk = Math.max(15, 95 - gi), s = pk / 2.2, z = (mins - pk) / s;
  return Math.max(0, 1 - Math.min(1, 0.5*(1+Math.tanh(0.7978845608*(z+0.044715*z*z*z)))));
}

function _iobFn(mins) {
  if (mins <= 0) return 1; if (mins >= 240) return 0;
  var d = 0;
  for (var x = 0; x < mins; x += 2) d += (x<=70 ? x/70 : Math.max(0,1-(x-70)/170))*2;
  return Math.max(0, 1 - Math.min(1, d/105));
}

// Zoom-aware sigma: bell width scales with viewSpan so it looks right at any zoom
function _bellSigma(giModifier) {
  // At default 2h view (7200000ms), W pixels covers viewSpan
  // We want bell to represent ~45min of absorption time at medium GI
  var msPerPx = viewSpan / W;
  var widthMs = (giModifier || 1) * 45 * 60000; // 45min in ms, scaled by GI
  return (widthMs / msPerPx) / 2.5; // convert to pixels
}

function _drawCOBReservoir() {
  var mealEvents = _getActiveMealEvents();
  if (mealEvents.length === 0) return;

  mealEvents.forEach(function(meal) {
    if (!meal.items) return;
    meal.items.forEach(function(food) {
      if (!food.carbs || food.carbs <= 0) return;
      var gi         = food.gi || 55;
      var peakMin    = Math.max(15, 95 - gi);
      var peakT      = meal.t + peakMin * 60000;
      var peakX      = tX(peakT);  // scroll-aware
      var elapsedMin = (viewTime - meal.t) / 60000;
      var remaining  = _cobFgi(elapsedMin, gi);
      if (remaining < 0.02) return;

      // GI \u2192 colour via continuous ramp (user-configurable)
      var giCol=giToColour(gi), rv=giCol[0], gv=giCol[1], bv=giCol[2];

      // Zoom-aware bell width — faster GI = narrower bell
      var sigmaFactor = gi >= 70 ? 0.6 : gi >= 55 ? 1.0 : 1.5;
      var sigma = _bellSigma(sigmaFactor);
      // Deeper into the flow — reservoir peaks closer to BG line
      var lineY      = dataAt ? bgToY(dataAt(viewTime).bg) : H * 0.5;
      var availableH = H - lineY - 8;  // space from bottom to just below BG line
      var maxD  = Math.min(availableH * 0.92, 90 * (food.carbs / 20) * remaining);
      // Minimum visible height — even 1g carb should be perceptible on the canvas
      var minD  = Math.min(availableH * 0.12, 18);
      maxD = Math.max(minD * remaining, maxD);

      // Draw bell in TIME-SPACE, not pixel-space.
      // This correctly handles peakT off-screen left or right.
      // For each pixel, compute its canvas time and evaluate distance to peakT.
      var sigmaMins = peakMin / 2.2; // absorption width in minutes (mirrors _cobFgi sigma)
      var mealT_local = meal.t; // capture for closure — carbs cannot arrive before eat time
      function bellH(px) {
        var t_px = viewTime + (px - NOW_X*W) / W * viewSpan;
        if (t_px < mealT_local) return 0; // zero before food is eaten
        // Smooth ramp-up from eat time: rises from 0 over the first ~8 minutes
        // so the curve starts gradually at the chip rather than as a vertical cliff
        var rampMins = Math.min(1.0, (t_px - mealT_local) / (8 * 60000));
        var ramp = rampMins * rampMins * (3 - 2 * rampMins); // smoothstep
        var minsDist = (t_px - peakT) / 60000;
        return Math.exp(-0.5 * Math.pow(minsDist / sigmaMins, 2)) * maxD * ramp;
      }
      CX.beginPath();
      CX.moveTo(0, H);
      for (var i = 0; i <= 280; i++) {
        var px = (i/280)*W;
        CX.lineTo(px, H - bellH(px));
      }
      CX.lineTo(W, H); CX.closePath();

      var gr = CX.createLinearGradient(0, H, 0, H-maxD);
      gr.addColorStop(0,   'rgba('+rv+','+gv+','+bv+','+(0.22+remaining*0.28)+')');
      gr.addColorStop(0.5, 'rgba('+rv+','+gv+','+bv+','+(remaining*0.12)+')');
      gr.addColorStop(1,   'rgba('+rv+','+gv+','+bv+',0)');
      CX.fillStyle = gr; CX.fill();

      // Rim
      CX.beginPath();
      for (var i = 0; i <= 280; i++) {
        var px = (i/280)*W;
        var py = H - bellH(px);
        i===0 ? CX.moveTo(px,py) : CX.lineTo(px,py);
      }
      CX.strokeStyle='rgba('+rv+','+gv+','+bv+','+(0.35+remaining*0.45)+')';
      CX.lineWidth=1.2; CX.stroke();

      // Food label — at peak if on screen, else at visible maximum
      if (food.carbs >= 2 && maxD > 14) {
        // Find the pixel with highest bell value within screen bounds
        var labelX = Math.max(30, Math.min(W-30, peakX));
        var labelH = bellH(labelX);
        if (labelH > maxD * 0.15) { // only label if bell is meaningfully tall here
          CX.globalAlpha = remaining * 0.65;
          CX.fillStyle   = 'rgba('+rv+','+gv+','+bv+',1)';
          CX.font        = "300 8px 'DM Mono',monospace";
          CX.textAlign   = 'center';
          CX.fillText(food.name.slice(0,14)+' '+food.carbs.toFixed(0)+'g', labelX, H-labelH-6);
          CX.globalAlpha = 1;
        }
      }
      // Track peak Y for pill positioning (highest bell = closest to BG line)
      var thisPeakY = H - maxD;
      if (_lastCOBPeakY < 0 || thisPeakY < _lastCOBPeakY) _lastCOBPeakY = thisPeakY;
    });
  });
}

function _drawIOBReservoir() {
  var bolusEvents = _getActiveBolusEvents();
  if (bolusEvents.length === 0) return;

  bolusEvents.forEach(function(bolus) {
    var elapsedMin = (viewTime - bolus.t) / 60000;
    var remaining  = _iobFn(elapsedMin);
    if (remaining < 0.02) return;

    var peakT  = bolus.t + 75 * 60000;
    var peakX  = tX(peakT);
    var sigma  = _bellSigma(1.1);  // slightly wider than medium GI
    var lineY      = dataAt ? bgToY(dataAt(viewTime).bg) : H * 0.5;
    var availableH = lineY - 8;    // space from top to just above BG line
    var maxD   = Math.min(availableH * 0.90, 110 * (bolus.u/3) * remaining);
    var minD   = Math.min(availableH * 0.12, 18);
    maxD = Math.max(minD * remaining, maxD);

    var rv=COL_IOB[0], gv=COL_IOB[1], bv=COL_IOB[2];

    CX.beginPath();
    CX.moveTo(0, 0);
    for (var i = 0; i <= 280; i++) {
      var px = (i/280)*W;
      CX.lineTo(px, Math.exp(-0.5*Math.pow((px-peakX)/sigma,2))*maxD);
    }
    CX.lineTo(W, 0); CX.closePath();

    var gr = CX.createLinearGradient(0, 0, 0, maxD);
    gr.addColorStop(0,   'rgba('+rv+','+gv+','+bv+','+(0.22+remaining*0.28)+')');
    gr.addColorStop(0.5, 'rgba('+rv+','+gv+','+bv+','+(remaining*0.12)+')');
    gr.addColorStop(1,   'rgba('+rv+','+gv+','+bv+',0)');
    CX.fillStyle = gr; CX.fill();

    CX.beginPath();
    for (var i = 0; i <= 280; i++) {
      var px = (i/280)*W;
      var py = Math.exp(-0.5*Math.pow((px-peakX)/sigma,2))*maxD;
      i===0 ? CX.moveTo(px,py) : CX.lineTo(px,py);
    }
    CX.strokeStyle='rgba('+rv+','+gv+','+bv+','+(0.35+remaining*0.45)+')';
    CX.lineWidth=1.2; CX.stroke();

    if (peakX > 30 && peakX < W-30 && maxD > 10) {
      CX.globalAlpha = remaining * 0.6;
      CX.fillStyle   = 'rgba('+rv+','+gv+','+bv+',1)';
      CX.font        = "300 8px 'DM Mono',monospace";
      CX.textAlign   = 'center';
      CX.fillText(bolus.u.toFixed(1)+'U', peakX, maxD+10);
      CX.globalAlpha = 1;
    }
    // Track peak Y for pill positioning (deepest bell = closest to BG line)
    if (_lastIOBPeakY < 0 || maxD > _lastIOBPeakY) _lastIOBPeakY = maxD;
  });
}

// Smart forecast — per-food GI curves + IOB decay
function buildSmartForecast() {
  var d0    = dataAt(viewTime);
  var bg    = d0.bg;
  var ISF   = (new Date(viewTime).getHours()>=9 && new Date(viewTime).getHours()<15) ? 7.0 : 6.5;
  var prev5 = dataAt(viewTime - 5*60000);
  var roc   = d0.bg - prev5.bg;
  var meals  = _getActiveMealEvents();
  var boluses= _getActiveBolusEvents();
  var pts    = [];

  for (var i = 1; i <= 36; i++) {
    var mins = i * 5;
    var ft   = viewTime + mins*60000;
    var fx   = tX(ft);
    if (fx > W+40) break;

    var cobEffect = 0;
    meals.forEach(function(meal) {
      // mealMins: minutes since the eat-time (meal.t).
      // Positive = already eating/absorbed; negative = haven't eaten yet.
      var mealMinsNow    = (viewTime - meal.t) / 60000;
      var mealMinsFuture = mealMinsNow + mins;
      meal.items.forEach(function(food) {
        var gi = food.gi || 55;
        // Absorbed carbs up to now and up to forecast point, relative to eat time.
        // _cobFgi returns 1 when mins<=0 (no absorption yet), 0 when fully absorbed.
        var absNow    = food.carbs * Math.max(0, 1 - _cobFgi(mealMinsNow, gi));
        var absFuture = food.carbs * Math.max(0, 1 - _cobFgi(mealMinsFuture, gi));
        cobEffect += Math.max(0, absFuture - absNow) * 0.055;
      });
    });

    var iobEffect = 0;
    boluses.forEach(function(bolus) {
      var bMins = (viewTime - bolus.t) / 60000;
      iobEffect += bolus.u * (_iobFn(bMins) - _iobFn(bMins+mins)) * ISF;
    });

    var predBG = Math.max(1.8, Math.min(22, bg + cobEffect - iobEffect + roc*Math.exp(-mins/20)));
    pts.push({mins:mins, bg:predBG, x:fx, y:bgToY(predBG)});
  }
  return pts;
}

// ── PARTICLES ────────────────────────────────────────────────────────

function _spawnForceParticle(type, gi) {
  var isCob = type==='cob';
  var level = isCob ? _cobReservoir : _iobReservoir;
  if (level < 0.02) return;
  var r = 2.8 + Math.random()*2.5;
  var col = isCob ? giToColour(gi || 55) : (RIVER_VISUAL_PREFS.iobR || COL_IOB);
  _forceParticles.push({
    type:type, r:r, baseR:r, col:col,
    x: NOW_X*W + (Math.random()-0.5)*28,
    y: isCob ? H+4 : -4,
    vy: isCob ? -(1.6+Math.random()*0.7) : (1.6+Math.random()*0.7),
    phase: Math.random()*Math.PI*2,
    alpha:0, state:'traveling',
    sitTimer:0, sitDur:550+Math.random()*450,
    stackSlot:0, fadeAlpha:1, age:0, paired:false,
  });
}

function _spawnMist(type, x, y, col) {
  _forceMists.push({
    type:type, x:x, y:y,
    col: col || (type==='cob' ? COL_COB : COL_IOB),
    r:7+Math.random()*14, life:0, maxLife:180+Math.random()*200,
    vx:(Math.random()-0.5)*0.2,
    vy:type==='cob' ? -(0.06+Math.random()*0.1) : (0.06+Math.random()*0.1),
    phase:Math.random()*Math.PI*2, maxAlpha:0.06+Math.random()*0.08,
  });
}

function _spawnSparks(x, y) {
  for (var i=0;i<8;i++) {
    var ang=Math.random()*Math.PI*2, spd=1.2+Math.random()*2.2;
    _forceSparks.push({x:x,y:y, vx:Math.cos(ang)*spd, vy:Math.sin(ang)*spd,
      r:1.2+Math.random()*1.6, alpha:1, maxLife:22+Math.random()*14, life:0});
  }
}

function _reassignSlots() {
  var ci=0,ii=0;
  _forceParticles.forEach(function(p){
    if(p.state!=='sitting'||p.paired) return;
    p.stackSlot = p.type==='cob' ? ci++ : ii++;
  });
}

function _tryPair() {
  var sitting=_forceParticles.filter(function(p){return p.state==='sitting'&&!p.paired;});
  var cobs=sitting.filter(function(p){return p.type==='cob';});
  var iobs=sitting.filter(function(p){return p.type==='iob';});
  cobs.forEach(function(c){
    if(c.paired) return;
    var best=null,bestD=999;
    iobs.forEach(function(io){
      if(io.paired) return;
      var d=Math.abs(c.x-io.x);
      if(d<bestD){bestD=d;best=io;}
    });
    if(best&&bestD<80){
      _spawnSparks((c.x+best.x)/2, bgToY(dataAt(viewTime).bg));
      c.paired=best.paired=true;
      c.state=best.state='fading';
    }
  });
}

function _drawMists() {
  _forceMists.forEach(function(m){
    var t=m.life/m.maxLife;
    var a=t<0.2?m.maxAlpha*(t/0.2):m.maxAlpha*(1-(t-0.2)/0.8);
    var col=m.col||(m.type==='cob'?COL_COB:COL_IOB);
    CX.beginPath();
    CX.arc(m.x+Math.sin(_forceFrame*0.025+m.phase)*5, m.y, m.r*(0.7+t*0.5), 0, Math.PI*2);
    CX.fillStyle='rgba('+col[0]+','+col[1]+','+col[2]+','+Math.max(0,a)+')';
    CX.fill();
  });
}

function _drawForceParticles(lineY) {
  var nx=NOW_X*W;
  _forceParticles.forEach(function(p){
    var isCob=p.type==='cob';
    var col=p.col||(isCob?COL_COB:COL_IOB);
    var rv=col[0],gv=col[1],bv=col[2];
    var wobX=Math.sin(_forceFrame*0.045+p.phase)*1.8;
    var wobY=p.state==='sitting'?Math.sin(_forceFrame*0.07+p.phase*1.2)*1.0:0;
    var pulse=p.state==='sitting'?1+Math.sin(_forceFrame*0.11+p.phase)*0.13:1;
    var rad=p.baseR*pulse;
    var a=p.state==='fading'?p.fadeAlpha:p.alpha;
    if(a<0.02) return;

    var px,py;
    if(p.state==='traveling'){
      px=p.x+wobX*0.3; py=p.y;
    } else {
      var gap=rad*2.1+1.5;
      var offset=p.stackSlot*gap+rad+3;
      px=nx+(p.stackSlot%2===0?1:-1)*p.baseR*0.5+wobX;
      py=isCob?lineY+offset+wobY:lineY-offset+wobY;
    }

    if(isCob){
      // Bubble
      CX.beginPath(); CX.arc(px,py,rad,0,Math.PI*2);
      CX.fillStyle='rgba('+rv+','+gv+','+bv+','+(a*0.15)+')'; CX.fill();
      CX.strokeStyle='rgba('+rv+','+gv+','+bv+','+(a*0.88)+')';
      CX.lineWidth=1.3; CX.stroke();
      var hlR=rv>200?255:200, hlG=gv>150?228:210, hlB=bv<100?175:220;
      CX.beginPath(); CX.arc(px-rad*0.28,py-rad*0.32,rad*0.25,0,Math.PI*2);
      CX.fillStyle='rgba('+hlR+','+hlG+','+hlB+','+(a*0.48)+')'; CX.fill();
      if(p.age>120){
        var haze=Math.min((p.age-120)/150,0.6);
        CX.beginPath(); CX.arc(px,py,rad*1.6,0,Math.PI*2);
        CX.fillStyle='rgba('+rv+','+gv+','+bv+','+(haze*0.09)+')'; CX.fill();
      }
      if(p.state==='sitting'){
        var aw=rad*0.5,ay=py+rad+2;
        CX.beginPath(); CX.moveTo(px,ay-aw*1.1);
        CX.lineTo(px-aw,ay+aw*0.5); CX.lineTo(px+aw,ay+aw*0.5); CX.closePath();
        CX.fillStyle='rgba('+rv+','+gv+','+bv+','+(a*0.35)+')'; CX.fill();
      }
    } else {
      // Teardrop
      var s=rad;
      CX.beginPath();
      CX.moveTo(px,py-s*1.4);
      CX.bezierCurveTo(px+s*0.95,py-s*0.25,px+s*0.95,py+s*0.65,px,py+s*0.75);
      CX.bezierCurveTo(px-s*0.95,py+s*0.65,px-s*0.95,py-s*0.25,px,py-s*1.4);
      CX.fillStyle='rgba('+rv+','+gv+','+bv+','+(a*0.72)+')'; CX.fill();
      CX.strokeStyle='rgba('+rv+','+gv+','+bv+','+(a*0.28)+')';
      CX.lineWidth=0.7; CX.stroke();
      CX.beginPath(); CX.arc(px+s*0.2,py-s*0.42,s*0.2,0,Math.PI*2);
      CX.fillStyle='rgba(195,228,255,'+(a*0.52)+')'; CX.fill();
      if(p.age>120){
        var haze=Math.min((p.age-120)/150,0.6);
        CX.beginPath(); CX.arc(px,py,rad*1.6,0,Math.PI*2);
        CX.fillStyle='rgba('+rv+','+gv+','+bv+','+(haze*0.09)+')'; CX.fill();
      }
      if(p.state==='sitting'){
        CX.beginPath(); CX.moveTo(px,py-s*1.5); CX.lineTo(px,py-s*1.5-s*1.2);
        CX.strokeStyle='rgba('+rv+','+gv+','+bv+','+(a*0.38)+')';
        CX.lineWidth=1.1; CX.stroke();
        CX.beginPath(); CX.arc(px,py-s*1.5-s*1.2,1.5,0,Math.PI*2);
        CX.fillStyle='rgba('+rv+','+gv+','+bv+','+(a*0.38)+')'; CX.fill();
      }
    }
  });
}

function _drawSparks() {
  _forceSparks.forEach(function(s){
    var a=s.alpha*(1-s.life/s.maxLife);
    if(a<0.02) return;
    CX.beginPath(); CX.arc(s.x,s.y,s.r,0,Math.PI*2);
    CX.fillStyle='rgba(255,242,210,'+Math.max(0,a)+')'; CX.fill();
  });
}

function _drawPressureGlow(lineY) {
  var nx=NOW_X*W, cobC=0, iobC=0;
  var cobR=COL_COB[0],cobG=COL_COB[1],cobB=COL_COB[2],cobW=0;
  var iobCol=RIVER_VISUAL_PREFS.iobR||COL_IOB;
  _forceParticles.forEach(function(p){
    if(p.state==='traveling') return;
    var a=p.state==='fading'?p.fadeAlpha:1;
    if(p.type==='cob'){
      cobC+=a*p.baseR;
      if(p.col&&a>0.1){var w=a*p.baseR;cobR=(cobR*cobW+p.col[0]*w)/(cobW+w);cobG=(cobG*cobW+p.col[1]*w)/(cobW+w);cobB=(cobB*cobW+p.col[2]*w)/(cobW+w);cobW+=w;}
    } else iobC+=a*p.baseR;
  });
  if(cobC>0.5){
    var h=Math.min(cobC*2.4,52);
    var cr=Math.round(cobR),cg=Math.round(cobG),cb=Math.round(cobB);
    var gr=CX.createLinearGradient(0,lineY,0,lineY+h);
    gr.addColorStop(0,'rgba('+cr+','+cg+','+cb+',0.3)');
    gr.addColorStop(1,'rgba('+cr+','+cg+','+cb+',0)');
    CX.beginPath(); CX.ellipse(nx,lineY+h/2,44,h/2,0,0,Math.PI*2);
    CX.fillStyle=gr; CX.fill();
  }
  if(iobC>0.5){
    var h=Math.min(iobC*2.4,52);
    var gr=CX.createLinearGradient(0,lineY,0,lineY-h);
    gr.addColorStop(0,'rgba('+iobCol[0]+','+iobCol[1]+','+iobCol[2]+',0.3)');
    gr.addColorStop(1,'rgba('+iobCol[0]+','+iobCol[1]+','+iobCol[2]+',0)');
    CX.beginPath(); CX.ellipse(nx,lineY-h/2,44,h/2,0,0,Math.PI*2);
    CX.fillStyle=gr; CX.fill();
  }
}

function drawGasCloud(cobPts, col, direction, d) {
  var isCob = direction > 0;

  if(isCob) {
    _forceFrame++;
    _lastCOBPeakY = -1;  // reset each frame so we pick fresh peak
    _lastIOBPeakY = -1;
    if(d) {
      _cobReservoir += (Math.min(1,(d.cob||0)/80) - _cobReservoir)*0.005;
      _iobReservoir += (Math.min(1,(d.iob||0)/6)  - _iobReservoir)*0.005;
      _cobReservoir  = Math.max(0,Math.min(1,_cobReservoir));
      _iobReservoir  = Math.max(0,Math.min(1,_iobReservoir));
    }
    if(_forceFrame%20===0){
      // Pick dominant active food GI for particle colour
      var _am=_getActiveMealEvents(), _domGI=55;
      if(_am.length>0){
        var _bf=null,_bc=0;
        _am.forEach(function(meal){
          if(!meal.items) return;
          meal.items.forEach(function(food){
            var e=(viewTime-meal.t)/60000;
            var rem=_cobFgi(e,food.gi||55)*(food.carbs||0);
            if(rem>_bc){_bc=rem;_bf=food;}
          });
        });
        if(_bf) _domGI=_bf.gi||55;
      }
      if(Math.random()<_cobReservoir*0.88) _spawnForceParticle('cob',_domGI);
      if(Math.random()<_iobReservoir*0.82) _spawnForceParticle('iob');
    }
    if(_forceFrame%15===0){
      var lineY=d?bgToY(d.bg):H/2;
      _forceParticles.forEach(function(p){
        if(p.state==='sitting'&&p.age>70&&Math.random()<0.065)
          _spawnMist(p.type, p.x+(Math.random()-0.5)*24,
            lineY+(p.type==='cob'?1:-1)*(10+Math.random()*20), p.col);
      });
    }
    var lineY=d?bgToY(d.bg):H/2;
    _forceParticles.forEach(function(p){
      p.age++;
      var isCobP=p.type==='cob';
      if(p.state==='traveling'){
        // Scrub-aware: scale alpha by reservoir so particles materialise/dissolve with scrub direction
        var _pres=isCobP?Math.max(0.15,_cobReservoir):Math.max(0.15,_iobReservoir);
        p.alpha=Math.min(_pres,p.alpha+0.065*_pres);
        p.y+=p.vy;
        p.x+=(NOW_X*W-p.x)*0.015;
        if(isCobP?p.y<=lineY:p.y>=lineY){p.state='sitting';p.y=lineY;}
      } else if(p.state==='sitting'&&!p.paired){
        p.alpha=Math.min(1,p.alpha+0.04);
        p.y=lineY; p.sitTimer++;
        if(p.sitTimer>p.sitDur){p.paired=true;p.state='fading';}
      } else {
        p.fadeAlpha=Math.max(0,p.fadeAlpha-0.022);
        p.alpha=Math.max(0,p.alpha-0.022);
      }
    });
    _forceParticles=_forceParticles.filter(function(p){return p.alpha>0.01;});
    if(_forceParticles.length>200) _forceParticles.splice(0,_forceParticles.length-200);
    if(_forceFrame%28===0) _tryPair();
    _reassignSlots();
    _forceMists.forEach(function(m){m.life++;m.x+=m.vx;m.y+=m.vy;});
    _forceMists=_forceMists.filter(function(m){return m.life<m.maxLife;});
    if(_forceMists.length>130) _forceMists.splice(0,_forceMists.length-130);
    _forceSparks.forEach(function(s){s.life++;s.x+=s.vx;s.y+=s.vy;s.vy+=0.04;s.alpha*=0.92;});
    _forceSparks=_forceSparks.filter(function(s){return s.alpha>0.04;});
  }

  if(isCob) _drawCOBReservoir();
  else       _drawIOBReservoir();

  if(isCob){
    var lineY=d?bgToY(d.bg):H/2;
    _drawMists();
    _drawPressureGlow(lineY);
    _drawForceParticles(lineY);
    _drawSparks();
  }
}




// ── UNKNOWN FORCE — silver mist where reality diverges from forecast ──
// When BG moves in ways COB+IOB don't explain, a mysterious residual appears.
// Not labelled. Not categorised. Just present — waiting to be named.
// Cold pool? Stress? Growth hormone? The mist knows something we don't yet.

var _mistParticles = [];
var _mistFrame = 0;

function drawUnknownForce(pal) {
  _mistFrame++;

  // Build forecast from 2h ago to now in 5min steps
  var steps = 24; // 2h
  var residuals = [];

  for (var i = 0; i <= steps; i++) {
    var t       = viewTime - (steps - i) * 5 * 60000;
    var actual  = dataAt(t).bg;
    if (!actual || actual <= 0) continue;

    // Simple forward forecast from 5min prior
    var tPrev   = t - 5 * 60000;
    var dPrev   = dataAt(tPrev);
    var ISF     = (new Date(t).getHours() >= 9 && new Date(t).getHours() < 15) ? 7.0 : 6.5;

    // What IOB+COB alone would predict over 5 mins
    var cobDelta = dPrev.cob > 0 ? dPrev.cob * (1 - cobF(5)) * 0.055 : 0;
    var iobDelta = dPrev.iob > 0 ? -dPrev.iob * (1 - iobF(5)) * ISF  : 0;
    var predicted = dPrev.bg + cobDelta + iobDelta;

    var residual = actual - predicted; // + means went higher than expected, - means lower
    var x = tX(t);

    // Only show residuals beyond noise threshold (±0.3 mmol)
    if (Math.abs(residual) > 0.3 && x > 0 && x < W) {
      residuals.push({ t, x, actual, predicted, residual });
    }
  }

  if (residuals.length === 0) return;

  // ── RIBBON LAYER — stacked grey ribbons from edge toward BG line ──
  // Positive residual (BG higher than expected) → ribbons from above (like phantom IOB failing)
  // Negative residual (BG lower than expected)  → ribbons from below (like phantom COB absorbed)
  var totalResidue = 0;
  var recentResiduals = residuals.slice(-8); // last 40 min
  recentResiduals.forEach(function(r){ totalResidue += r.residual; });
  var avgResidue = recentResiduals.length > 0 ? totalResidue / recentResiduals.length : 0;
  var ribbonStrength = Math.min(1, Math.abs(avgResidue) / 2.5);

  if (ribbonStrength > 0.08) {
    CX.save();
    var isDown   = avgResidue < 0; // unknown force pulling BG down
    var nowX2    = NOW_X * W;
    var lineY2   = dataAt ? bgToY(dataAt(viewTime).bg) : H * 0.5;
    var numRibs  = 3 + Math.floor(ribbonStrength * 4);
    var edgeY    = isDown ? H : 0;  // ribbons from bottom (down) or top (up)

    for (var ri = 0; ri < numRibs; ri++) {
      var rFrac    = (ri + 1) / (numRibs + 1);
      // Each ribbon anchored at a different x spanning past 40min to now
      var rx       = nowX2 * (0.3 + rFrac * 0.6);
      var ribLen   = 40 + rFrac * 60;  // width in px
      var ribAlpha = ribbonStrength * (0.06 + rFrac * 0.08) * (0.5 + 0.5 * Math.sin(phi * 0.4 + ri));
      var midY     = edgeY + (lineY2 - edgeY) * (0.3 + rFrac * 0.55);

      var gr2 = CX.createLinearGradient(rx - ribLen/2, 0, rx + ribLen/2, 0);
      gr2.addColorStop(0,   'rgba(180,195,220,0)');
      gr2.addColorStop(0.2, 'rgba(180,195,220,' + ribAlpha + ')');
      gr2.addColorStop(0.8, 'rgba(180,195,220,' + ribAlpha + ')');
      gr2.addColorStop(1,   'rgba(180,195,220,0)');

      // Thin horizontal ribbon
      CX.globalAlpha = 1;
      CX.fillStyle   = gr2;
      CX.beginPath();
      CX.roundRect(rx - ribLen/2, midY - 1.5, ribLen, 3, 1.5);
      CX.fill();

      // Vertical tendril from edge to ribbon
      var tGr = CX.createLinearGradient(0, edgeY, 0, midY);
      tGr.addColorStop(0,   'rgba(160,180,210,0)');
      tGr.addColorStop(0.6, 'rgba(160,180,210,' + (ribAlpha * 0.5) + ')');
      tGr.addColorStop(1,   'rgba(160,180,210,' + (ribAlpha * 0.9) + ')');
      CX.fillStyle = tGr;
      CX.fillRect(rx - 1, Math.min(edgeY, midY), 2, Math.abs(midY - edgeY));
    }
    CX.restore();
  }

  CX.save();

  // Draw the residual gap as a shaded region between actual and predicted
  residuals.forEach(function(pt) {
    var actualY    = bgToY(pt.actual);
    var predictedY = bgToY(pt.predicted);
    var gapPx      = Math.abs(actualY - predictedY);
    if (gapPx < 2) return;

    var topY = Math.min(actualY, predictedY);
    var botY = Math.max(actualY, predictedY);
    var intensity = Math.min(1, Math.abs(pt.residual) / 3); // max at 3 mmol divergence

    // Silver-white fill — ethereal, not force-coloured
    var gr = CX.createLinearGradient(0, topY, 0, botY);
    gr.addColorStop(0,   'rgba(200,210,230,' + (intensity * 0.18) + ')');
    gr.addColorStop(0.5, 'rgba(180,195,220,' + (intensity * 0.10) + ')');
    gr.addColorStop(1,   'rgba(200,210,230,' + (intensity * 0.18) + ')');
    CX.fillStyle = gr;
    CX.fillRect(pt.x - 2, topY, 5, gapPx);
  });

  // Spawn swirling mist particles at points of high divergence
  if (_mistFrame % 12 === 0) {
    residuals.forEach(function(pt) {
      if (Math.abs(pt.residual) < 0.8) return;
      if (Math.random() > 0.35) return;
      var intensity = Math.min(1, Math.abs(pt.residual) / 3);
      var goingUp   = pt.residual < 0; // actual lower than predicted = unknown pulling down
      _mistParticles.push({
        x:        pt.x + (Math.random() - 0.5) * 20,
        y:        bgToY(pt.actual) + (Math.random() - 0.5) * 12,
        vx:       (Math.random() - 0.5) * 0.4,
        vy:       (goingUp ? -0.3 : 0.3) * (0.5 + Math.random() * 0.5),
        r:        4 + Math.random() * 10,
        alpha:    0,
        maxAlpha: 0.12 + intensity * 0.14,
        life:     0,
        maxLife:  80 + Math.random() * 120,
        phase:    Math.random() * Math.PI * 2,
        intensity: intensity,
      });
    });
    if (_mistParticles.length > 200) _mistParticles.splice(0, _mistParticles.length - 200);
  }

  // Update and draw mist particles
  for (var i = _mistParticles.length - 1; i >= 0; i--) {
    var m = _mistParticles[i];
    m.life++;
    m.x  += m.vx + Math.sin(m.life * 0.04 + m.phase) * 0.3;
    m.y  += m.vy + Math.sin(m.life * 0.06 + m.phase * 1.3) * 0.2;

    var t = m.life / m.maxLife;
    if (t < 0.2)      m.alpha = m.maxAlpha * (t / 0.2);
    else if (t < 0.7) m.alpha = m.maxAlpha;
    else              m.alpha = m.maxAlpha * (1 - (t - 0.7) / 0.3);

    if (m.life >= m.maxLife) { _mistParticles.splice(i, 1); continue; }

    CX.beginPath();
    CX.arc(m.x, m.y, m.r * (0.6 + t * 0.6), 0, Math.PI * 2);
    // Silver-white — cooler than IOB blue, warmer than pure white
    CX.fillStyle = 'rgba(210,220,235,' + Math.max(0, m.alpha) + ')';
    CX.fill();
  }

  // Subtle edge line tracing the predicted path
  // Shows what "should have happened" as a ghost beneath reality
  if (residuals.length > 2) {
    CX.globalAlpha = 0.15;
    CX.strokeStyle = 'rgba(200,215,235,1)';
    CX.lineWidth   = 1;
    CX.setLineDash([2, 8]);
    CX.beginPath();
    residuals.forEach(function(pt, i) {
      var py = bgToY(pt.predicted);
      i === 0 ? CX.moveTo(pt.x, py) : CX.lineTo(pt.x, py);
    });
    CX.stroke();
    CX.setLineDash([]);
  }

  CX.globalAlpha = 1;
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
  window._orbScreenX = x;
  window._orbScreenY = y;
  // Export orb screen position so the DOM long-press button can track it
  window._orbScreenX = x;
  window._orbScreenY = y;
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

  // Tap hint — "Hold to see actions" text above orb, fades in/out
  if (_orbTapHint > 0.01) {
    var hintAlpha = _orbTapHint;
    var hintY = y - orbR * 5 - 8;
    // Keep hint on screen
    if (hintY < 32) hintY = y + orbR * 5 + 20;
    CX.globalAlpha = hintAlpha * 0.75;
    CX.font = "300 10px 'DM Mono',monospace";
    CX.textAlign = 'center';
    CX.letterSpacing = '1px';
    CX.fillStyle = `rgba(${r},${g},${b},1)`;
    CX.fillText('hold to see actions', x, hintY);
    CX.letterSpacing = '0px';
    _orbTapHint *= 0.975; // slow fade
  }

  CX.globalAlpha = 1;
  CX.restore();
}

let _orbLongPressHint = 0;
let _orbTapHint = 0;       // fades in on single tap, prompts hold
let _orbTapHintT = 0;      // timestamp of last tap hint trigger


// Shimmer particles drifting along equilibrium tunnel edges
var _eqShimmers = [];
var _eqShimmerFrame = 0;

function drawEquilibriumZone(pal) {
  const loY = bgToY(BG_HIGH);
  const hiY = bgToY(BG_LOW);
  const zH  = hiY - loY;
  const [r, g, b] = pal.bgLine;
  CX.save();

  // Iridescent inner fill — shifts hue with time
  const hueShift = Math.sin(phi * 0.15) * 0.5 + 0.5; // 0-1 slow oscillation
  const r2 = Math.round(r * 0.7 + 80 * hueShift);
  const g2 = Math.round(g * 0.8 + 60 * (1 - hueShift));
  const b2 = Math.round(b * 0.9 + 40 * hueShift);

  const grad = CX.createLinearGradient(0, loY, 0, hiY);
  grad.addColorStop(0,    `rgba(${r2},${g2},${b2},0.13)`);
  grad.addColorStop(0.12, `rgba(${r},${g},${b},0.04)`);
  grad.addColorStop(0.5,  `rgba(${r2},${g2},${b2},0.015)`);
  grad.addColorStop(0.88, `rgba(${r},${g},${b},0.04)`);
  grad.addColorStop(1,    `rgba(${r2},${g2},${b2},0.13)`);
  CX.globalAlpha = 1;
  CX.fillStyle   = grad;
  CX.fillRect(0, loY, W, zH);

  // Flowing edge lines — gentle sine-wave wobble, no dashes, ethereal
  // Three overlapping layers per edge, different frequencies and phases
  var flowLayers = [
    { alpha: 0.22, width: 0.9, freq: 0.008, amp: 3.2, speed: 0.012, phase: 0     },
    { alpha: 0.10, width: 0.5, freq: 0.013, amp: 2.0, speed: 0.019, phase: 2.1   },
    { alpha: 0.06, width: 0.3, freq: 0.005, amp: 4.2, speed: 0.007, phase: 4.7   },
  ];
  CX.setLineDash([]);
  flowLayers.forEach(function(fl, li) {
    var col = li === 1 ? `rgba(${r2},${g2},${b2},1)` : `rgba(${r},${g},${b},1)`;
    CX.globalAlpha = fl.alpha;
    CX.strokeStyle = col;
    CX.lineWidth   = fl.width;
    // Top edge (loY = high BG line)
    CX.beginPath();
    for (var xi = 0; xi <= W; xi += 2) {
      var wy = loY + Math.sin(xi * fl.freq + phi * fl.speed + fl.phase) * fl.amp
                   + Math.sin(xi * fl.freq * 0.47 + phi * fl.speed * 1.3) * fl.amp * 0.4;
      xi === 0 ? CX.moveTo(xi, wy) : CX.lineTo(xi, wy);
    }
    CX.stroke();
    // Bottom edge (hiY = low BG / hypo line)
    CX.beginPath();
    for (var xi = 0; xi <= W; xi += 2) {
      var wy = hiY + Math.sin(xi * fl.freq + phi * fl.speed + fl.phase + 1.3) * fl.amp
                   + Math.sin(xi * fl.freq * 0.53 + phi * fl.speed * 0.9 + 0.8) * fl.amp * 0.4;
      xi === 0 ? CX.moveTo(xi, wy) : CX.lineTo(xi, wy);
    }
    CX.stroke();
  });

  // Shimmer particles — spawn along edges, drift across tunnel
  _eqShimmerFrame++;
  if (_eqShimmerFrame % 8 === 0 && _eqShimmers.length < 40) {
    var onTop = Math.random() < 0.5;
    _eqShimmers.push({
      x: Math.random() * W,
      y: onTop ? loY + Math.random() * 4 : hiY - Math.random() * 4,
      vy: onTop ? (0.3 + Math.random() * 0.5) : -(0.3 + Math.random() * 0.5),
      vx: (Math.random() - 0.5) * 0.4,
      life: 0,
      maxLife: 60 + Math.floor(Math.random() * 80),
      r: Math.random() < 0.4 ? r2 : r,
      g: Math.random() < 0.4 ? g2 : g,
      b: Math.random() < 0.4 ? b2 : b,
      size: 0.6 + Math.random() * 1.2,
    });
  }
  _eqShimmers.forEach(function(s) {
    s.life++;
    s.x += s.vx;
    s.y += s.vy;
    var frac = s.life / s.maxLife;
    var a = frac < 0.2 ? frac / 0.2 : frac > 0.8 ? (1 - frac) / 0.2 : 1;
    CX.globalAlpha = a * 0.55;
    CX.fillStyle = `rgba(${s.r},${s.g},${s.b},1)`;
    CX.shadowColor = `rgba(${s.r},${s.g},${s.b},0.8)`;
    CX.shadowBlur  = 3;
    CX.beginPath();
    CX.arc(s.x, s.y, Math.max(0.3, s.size), 0, Math.PI * 2);
    CX.fill();
    CX.shadowBlur = 0;
  });
  _eqShimmers = _eqShimmers.filter(function(s) { return s.life < s.maxLife; });

  CX.globalAlpha = 1;

  // Danger glow above (high) and below (hypo)
  const dangerTop = CX.createLinearGradient(0, loY - zH*0.4, 0, loY);
  dangerTop.addColorStop(0, 'rgba(230,140,40,0)');
  dangerTop.addColorStop(1, 'rgba(230,140,40,0.07)');
  CX.globalAlpha = 1; CX.fillStyle = dangerTop;
  CX.fillRect(0, loY - zH*0.4, W, zH*0.4);

  const dangerBot = CX.createLinearGradient(0, hiY, 0, hiY + zH*0.4);
  dangerBot.addColorStop(0, 'rgba(80,130,220,0.07)');
  dangerBot.addColorStop(1, 'rgba(80,130,220,0)');
  CX.fillStyle = dangerBot;
  CX.fillRect(0, hiY, W, zH*0.4);

  // Edge mmol labels — softly glowing
  CX.globalAlpha = 0.28;
  CX.fillStyle   = `rgba(${r},${g},${b},1)`;
  CX.shadowColor = `rgba(${r},${g},${b},0.6)`;
  CX.shadowBlur  = 4;
  CX.font        = "200 9px 'DM Mono',monospace";
  CX.textAlign   = 'right';
  CX.fillText('10.0', NOW_X * W - 12, loY - 4);
  CX.fillText('3.9',  NOW_X * W - 12, hiY + 11);
  CX.shadowBlur = 0;

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
// ── BASAL RESERVOIR — Degludec: flat peakless, always dripping ──────────
// Shown as a slim static bar along the top edge with a continuous gentle drip
// Unlike bolus (which spikes and fades), basal is the constant background hum.
var _basalDrops = [];
var _basalFrame = 0;

function drawBasalReservoir(pal) {
  _basalFrame++;
  var lineY = dataAt ? bgToY(dataAt(viewTime).bg) : H * 0.5;
  // Bar height scales with dose: 3px per unit, clamped 4–14px
  var dose   = (_TREATMENT || _TREATMENT_DEFAULTS).basalDose || 6;
  var barH   = Math.max(4, Math.min(14, Math.round(dose * 0.55)));
  var barY   = 0;       // anchored to very top edge
  var alpha  = 0.45;    // more prominent — basal is always-on, not subtle
  var [r,g,b]= [40, 200, 160]; // teal — distinct from bolus blue and carb orange

  CX.save();

  // Static bar — full width, very slim, anchored top
  var barGr = CX.createLinearGradient(0, barY, W, barY);
  barGr.addColorStop(0,   'rgba('+r+','+g+','+b+',0)');
  barGr.addColorStop(0.1, 'rgba('+r+','+g+','+b+','+(alpha*0.9)+')');
  barGr.addColorStop(0.5, 'rgba('+r+','+g+','+b+','+alpha+')');
  barGr.addColorStop(0.9, 'rgba('+r+','+g+','+b+','+(alpha*0.9)+')');
  barGr.addColorStop(1,   'rgba('+r+','+g+','+b+',0)');
  CX.fillStyle = barGr;
  CX.fillRect(0, barY, W, barH);

  // Label on left — show live dose from settings
  CX.globalAlpha = 0.55;
  CX.fillStyle   = 'rgba('+r+','+g+','+b+',1)';
  CX.font        = "400 9px 'DM Mono',monospace";
  CX.textAlign   = 'left';
  CX.fillText('basal  ' + dose + 'U', 10, barY + 14);
  CX.globalAlpha = 1;

  // Spawn drops periodically — slow drip from bar down toward BG line
  if (_basalFrame % 18 === 0 && Math.random() < 0.65) {
    var dx = 60 + Math.random() * (W - 120);
    _basalDrops.push({
      x:      dx,
      y:      barH + 2,
      targetY: lineY - 8,
      alpha:  0,
      size:   1.2 + Math.random() * 1.0,
      speed:  0.28 + Math.random() * 0.18,
      life:   0,
      maxLife: 160 + Math.random() * 80,
    });
  }
  if (_basalDrops.length > 60) _basalDrops.splice(0, _basalDrops.length - 60);

  // Update + draw drops
  for (var di = _basalDrops.length - 1; di >= 0; di--) {
    var drop = _basalDrops[di];
    drop.life++;
    drop.y  += drop.speed;
    var t    = drop.life / drop.maxLife;
    drop.alpha = t < 0.15 ? (t/0.15) * 0.35 : t < 0.7 ? 0.35 : 0.35 * (1 - (t-0.7)/0.3);
    if (drop.life >= drop.maxLife || drop.y > drop.targetY) {
      _basalDrops.splice(di, 1); continue;
    }
    CX.globalAlpha = drop.alpha;
    CX.fillStyle   = 'rgba('+r+','+g+','+b+',1)';
    CX.beginPath();
    CX.arc(drop.x, drop.y, drop.size, 0, Math.PI*2);
    CX.fill();
  }

  CX.globalAlpha = 1;
  CX.restore();
}

function drawBolusMarkers(pal) {
  if (!window._eventCards) window._eventCards = [];
  window._eventCards = [];
  CX.save();
  // Use BOLUS_EVENTS only — all logged events are already pushed there at log time.
  // Concatenating SESSION caused duplicates (and surfaced stale previous-day chips).
  const allEvents = [...BOLUS_EVENTS];

  for (var _bIdx = 0; _bIdx < allEvents.length; _bIdx++) {
    const b = allEvents[_bIdx];
    const x   = tX(b.t);
    if (x < -80 || x > W + 80) continue;
    const d   = dataAt(b.t);
    const bgY = bgToY(d.bg);

    if (b.c > 1) {
      // Hypo treatment events get the blue hypo colour, not the carb orange
      var _isHypo = b.note && typeof b.note === 'string' && b.note.indexOf('hypo') === 0;
      // Hypo chips use the same golden yellow as the dock button (COL_HYPO)
      const r = _isHypo ? 255 : pal.cobR[0],
            g = _isHypo ? 210 : pal.cobR[1],
            bv= _isHypo ?  40 : pal.cobR[2];
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
      const who = b.logged_by ? getPersonInitial(b.logged_by) : '';
      CX.font = "500 11px 'DM Mono',monospace";
      const lw = CX.measureText(lbl).width + 16;
      CX.globalAlpha = 1.0;
      CX.fillStyle   = 'rgba(' + r + ',' + g + ',' + bv + ',0.55)';
      CX.strokeStyle = 'rgba(' + r + ',' + g + ',' + bv + ',1.0)';
      CX.lineWidth   = 1.2;
      CX.shadowColor = 'rgba(' + r + ',' + g + ',' + bv + ',0.5)'; CX.shadowBlur = 6;
      CX.beginPath(); CX.roundRect(x - lw/2, cardY, lw, 17, 5); CX.fill(); CX.stroke();
      CX.shadowBlur = 0;
      CX.fillStyle = 'rgba(255,255,255,1.0)';
      CX.textAlign   = 'center';
      CX.fillText(lbl, x, cardY + 12);
      if (who) {
        CX.globalAlpha = 0.7; CX.font = "400 8px 'DM Mono',monospace";
        CX.fillText(who, x + lw/2 - 5, cardY + 1);
        CX.globalAlpha = 1;
      }
      window._eventCards.push({x:x, y:cardY+8, w:lw+4, h:17, data:b, idx:_bIdx, type:'carb'});
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
      CX.font = "500 11px 'DM Mono',monospace";
      const lw = CX.measureText(lbl).width + 16;
      CX.globalAlpha = 1.0;
      CX.fillStyle   = 'rgba(' + r + ',' + g + ',' + bv + ',0.50)';
      CX.strokeStyle = 'rgba(' + r + ',' + g + ',' + bv + ',1.0)';
      CX.lineWidth   = 1.2;
      CX.shadowColor = 'rgba(' + r + ',' + g + ',' + bv + ',0.5)'; CX.shadowBlur = 6;
      CX.beginPath(); CX.roundRect(x - lw/2, cardY - 1, lw, 17, 5); CX.fill(); CX.stroke();
      CX.shadowBlur = 0;
      CX.fillStyle = 'rgba(255,255,255,1.0)';
      CX.textAlign   = 'center';
      CX.fillText(lbl, x, cardY + 11);
      window._eventCards.push({x:x, y:cardY+7, w:lw+4, h:17, data:b, idx:_bIdx, type:'insulin'});
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
  if (el) {
    // When scrolled away from now, show the view time with day context
    var awayMs = HISTORY_RAW.length > 0 ? (HISTORY_RAW[HISTORY_RAW.length-1].t - viewTime) : 0;
    var _lo = getLabelOpacity();
    if (awayMs > 5 * 60000) {
      // Scrolled: show day + time of the view position
      el.textContent = DNAMES[nd.getDay()] + ' ' +
        nd.getHours().toString().padStart(2,'0') + ':' +
        nd.getMinutes().toString().padStart(2,'0');
      el.style.opacity = String(Math.min(0.92, _lo));
      el.style.color   = 'rgba(180,210,240,' + _lo + ')';
    } else {
      // At now: subtle, just show time
      var nowD = new Date();
      el.textContent = nowD.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
      el.style.opacity = '0.45';
      el.style.color   = 'rgba(180,210,240,0.45)';
    }
  }

  const nowX   = NOW_X*W;
  const startT = xT(0), endT = xT(W);
  const firstT = Math.ceil(startT/tickMs)*tickMs;

  CX.save(); CX.globalAlpha = getLabelOpacity(); CX.textAlign = 'center';
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
  if(typeof _syncState!=='undefined'&&_syncState!=='idle'){
    var _sc=_syncState==='ok'?'rgba(62,180,120,0.55)':_syncState==='error'?'rgba(220,80,60,0.7)':'rgba(200,200,200,0.4)';
    CX.globalAlpha=1;CX.fillStyle=_sc;
    CX.font="300 9px 'DM Mono',monospace";CX.textAlign='right';
    CX.fillText(_syncState==='ok'?'✓ synced':_syncState==='error'?'! sync err':'↻',W-10,H-20);
  }
  CX.restore();
}

// ── RIVER PEBBLE — disturbance in the flow ─────────────────────────────
var _riverPebble    = null;
var _lastPebbleMsg  = null;  // remember last nudge for ghost display

function showRiverPebble(msg, type) {
  _riverPebble   = { msg, type, alpha: 1.0, t: Date.now() };
  _lastPebbleMsg = { msg, type, t: Date.now() };  // store for ghost
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
      'white-space:nowrap',
      'pointer-events:auto',
    ].join(';');
    chip.onclick = function() {
      chip.style.opacity = '0';
      ALERTS.snooze('corr_nudge', 20*60000);
      ALERTS.snooze('corr_high',  20*60000);
    };
    document.body.appendChild(chip);
  }
  chip.textContent = msg;

  // Only show chip when viewing "now" — hide when scrolled
  var atNow = _isAtNow || (HISTORY_RAW.length > 0 &&
    Math.abs(viewTime - HISTORY_RAW[HISTORY_RAW.length-1].t) < 8 * 60000);
  chip.style.opacity = atNow ? '1' : '0';
  chip.style.pointerEvents = atNow ? 'auto' : 'none';

  if (window._pebbleTimeout) clearTimeout(window._pebbleTimeout);
  window._pebbleTimeout = setTimeout(function() {
    if (chip) chip.style.opacity = '0';
  }, 10000);
}

// Called from frame to keep nudge chip visibility in sync with scroll state
function updateNudgeChipVisibility() {
  var chip = document.getElementById('pebble-chip');
  if (!chip || chip.style.opacity === '0') return;
  var atNow = _isAtNow || (HISTORY_RAW.length > 0 &&
    Math.abs(viewTime - HISTORY_RAW[HISTORY_RAW.length-1].t) < 8 * 60000);
  chip.style.opacity      = atNow ? '1' : '0';
  chip.style.pointerEvents = atNow ? 'auto' : 'none';

  // Ghost chip: when scrolled away from now and a recent nudge exists
  var ghost = document.getElementById('pebble-ghost');
  if (!atNow && _lastPebbleMsg && (Date.now() - _lastPebbleMsg.t) < 20 * 60000) {
    if (!ghost) {
      ghost = document.createElement('div');
      ghost.id = 'pebble-ghost';
      ghost.style.cssText = [
        'position:fixed',
        'bottom:calc(max(80px,env(safe-area-inset-bottom,80px)) + 12px)',
        'left:50%',
        'transform:translateX(-50%)',
        'z-index:24',
        'padding:5px 14px',
        'border-radius:20px',
        "font-family:'DM Mono',monospace",
        'font-size:9px',
        'letter-spacing:.4px',
        'color:rgba(140,170,200,0.4)',
        'background:rgba(20,30,55,0.4)',
        'border:1px solid rgba(80,110,160,0.15)',
        'white-space:nowrap',
        'pointer-events:none',
      ].join(';');
      document.body.appendChild(ghost);
    }
    ghost.textContent = '⟳ ' + _lastPebbleMsg.msg;
    ghost.style.display = 'block';
  } else if (ghost) {
    ghost.style.display = 'none';
  }
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

// ── NO-DATA ORB — pulsing grey when sensor gap is active ──────────────
function drawNoDataOrb(pal) {
  if (HISTORY_RAW.length === 0) return;
  var lastT  = HISTORY_RAW[HISTORY_RAW.length-1].t;
  var gapMs  = Date.now() - lastT;
  var isLive = _isAtNow || Math.abs(viewTime - lastT) < 5*60000;
  if (!isLive) return;                        // only show when viewing 'now'
  if (gapMs < 10 * 60000) return;            // only trigger after 10 min gap
  var gapMins = Math.floor(gapMs / 60000);

  // Position orb at the last known reading's x position, at its y
  var lastReading = HISTORY_RAW[HISTORY_RAW.length-1];
  var ox = tX(lastReading.t);
  var oy = bgToY(lastReading.bg);

  // Constrain to canvas — if scrolled, use NOW_X
  if (ox < 20 || ox > W - 20) ox = NOW_X * W;

  var pulse = 0.5 + 0.5 * Math.sin(phi * 2.5);

  CX.save();

  // Outer pulsing rings — muted grey-blue
  for (var ring = 0; ring < 3; ring++) {
    var rAge    = (phi * 0.8 + ring * 1.1) % 3;
    var rRadius = 10 + rAge * 22;
    var rAlpha  = (1 - rAge / 3) * 0.3;
    CX.globalAlpha = rAlpha;
    CX.strokeStyle = 'rgba(160,180,200,1)';
    CX.lineWidth   = 0.8;
    CX.beginPath(); CX.arc(ox, oy, Math.max(1, rRadius), 0, Math.PI*2); CX.stroke();
  }

  // Core grey orb
  var orbR = 7 + pulse * 3;
  var grad = CX.createRadialGradient(ox, oy, 0, ox, oy, orbR * 2);
  grad.addColorStop(0,   'rgba(180,200,220,' + (0.6 + pulse * 0.2) + ')');
  grad.addColorStop(0.5, 'rgba(120,140,170,' + (0.3 + pulse * 0.1) + ')');
  grad.addColorStop(1,   'rgba(80,100,140,0)');
  CX.globalAlpha = 0.85;
  CX.fillStyle   = grad;
  CX.beginPath(); CX.arc(ox, oy, orbR * 2, 0, Math.PI*2); CX.fill();

  // Inner dot
  CX.globalAlpha = 0.7 + pulse * 0.3;
  CX.fillStyle   = 'rgba(180,200,230,1)';
  CX.shadowColor = 'rgba(150,180,220,0.8)'; CX.shadowBlur = 8;
  CX.beginPath(); CX.arc(ox, oy, orbR * 0.5, 0, Math.PI*2); CX.fill();
  CX.shadowBlur  = 0;

  // Label: "no data Xm" just above the orb
  CX.globalAlpha = 0.65 + pulse * 0.2;
  CX.font        = "400 9px 'DM Mono',monospace";
  CX.fillStyle   = 'rgba(160,185,210,1)';
  CX.textAlign   = 'center';
  CX.fillText('no data ' + gapMins + 'm', ox, oy - orbR * 2 - 6);

  CX.globalAlpha = 1; CX.restore();

  // Also drive the stale-warn HTML element
  var sw = document.getElementById('stale-warn');
  if (sw) {
    sw.style.display = 'block';
    sw.textContent   = 'no reading for ' + gapMins + 'm';
  }
}

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
      if (!window._riverHasUserGesture) return; // don't create AudioContext before first gesture
      if (!this._audioCtx) this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = this._audioCtx;
      // Resume context if suspended (Chrome autoplay policy)
      if (ctx.state === 'suspended') ctx.resume();
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
    banner.style.position   = 'fixed';
    // Position in the flow — below the HUD readout, in the canvas area
    banner.style.top        = 'max(90px, calc(env(safe-area-inset-top, 0px) + 90px))';
    banner.style.left       = '50%';
    banner.style.transform  = 'translateX(-50%)';
    banner.style.zIndex     = '30';  // below HUD (z:40+) but visible on canvas
    banner.style.padding    = '8px 18px';
    banner.style.borderRadius = '20px';
    banner.style.fontFamily = "'DM Mono',monospace";
    banner.style.fontSize   = '11px';
    banner.style.letterSpacing = '.5px';
    banner.style.textTransform = 'uppercase';
    banner.style.color      = 'rgba(255,255,255,0.92)';
    banner.style.textAlign  = 'center';
    banner.style.backdropFilter = 'blur(8px)';
    banner.style.border     = '1px solid rgba(255,255,255,0.12)';
    banner.style.cursor     = 'pointer';
    banner.style.maxWidth   = '240px';
    banner.style.lineHeight = '1.4';
    banner.style.transition = 'opacity .3s, transform .3s';
    banner.style.pointerEvents = 'auto';
    banner.onclick = function() {
      banner.style.opacity   = '0';
      banner.style.transform = 'translateX(-50%) translateY(-6px)';
      ALERTS.snooze('corr_nudge', 20*60000);
      ALERTS.snooze('corr_high',  20*60000);
    };
    document.body.appendChild(banner);
  }
  banner.textContent = msg;
  banner.style.background  = bgCol;
  banner.style.opacity     = '1';
  banner.style.transform   = 'translateX(-50%) translateY(0)';
  banner.style.boxShadow   = urgent ? '0 4px 24px rgba(60,100,255,0.35)' : '0 2px 12px rgba(0,0,0,0.3)';
  if (_bannerTimeout) clearTimeout(_bannerTimeout);
  _bannerTimeout = setTimeout(function() {
    if (banner) {
      banner.style.opacity   = '0';
      banner.style.transform = 'translateX(-50%) translateY(-6px)';
    }
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
  // Persisted history loaded but live CGM not yet connected — hide BG entirely
  if (_historyIsStale) {
    var bgWrap = document.getElementById('bg-wrap');
    if (bgWrap) bgWrap.style.opacity = '0';
    return;
  } else {
    var bgWrap = document.getElementById('bg-wrap');
    if (bgWrap) bgWrap.style.opacity = '';
  }
  if (!d || !pal || typeof d.bg !== 'number' || isNaN(d.bg)) return;

  // Stale data warning
  var staleWarn = document.getElementById('stale-warn');
  if (staleWarn) {
    var minsStale = _lastReadingT > 0 ? Math.round((Date.now()-_lastReadingT)/60000) : 0;
    var isStale   = minsStale > 12 && _lastReadingT > 0;
    staleWarn.style.display = isStale ? 'block' : 'none';
    if (isStale) staleWarn.textContent = 'no reading for ' + minsStale + 'm';
  }

  // BG number + trend arrow — prefer CGM trend field from latest reading
  var latestRaw = HISTORY_RAW.length > 0 ? HISTORY_RAW[HISTORY_RAW.length-1] : null;
  var cgmTrend  = latestRaw && latestRaw.trend ? latestRaw.trend : null;
  var cgmStale  = latestRaw ? (Date.now() - latestRaw.t) > 8 * 60000 : true;
  var prev15 = dataAt(viewTime - 15*60000);
  var delta  = d.bg - prev15.bg;
  // Only use computed delta if we have ≥12 min of real span and we're near "now"
  var haveSpan = latestRaw && HISTORY_RAW.length > 1 && (latestRaw.t - HISTORY_RAW[0].t) > 12*60000;
  var nearNow  = Math.abs(viewTime - (latestRaw ? latestRaw.t : 0)) < 10*60000;
  var arr;
  if (cgmTrend && !cgmStale && nearNow) {
    arr = cgmTrend === 'DoubleUp'       ? '↑↑' :
          cgmTrend === 'SingleUp'       ? '↑'  :
          cgmTrend === 'FortyFiveUp'    ? '↗'  :
          cgmTrend === 'Flat'           ? '→'  :
          cgmTrend === 'FortyFiveDown'  ? '↘'  :
          cgmTrend === 'SingleDown'     ? '↓'  :
          cgmTrend === 'DoubleDown'     ? '↓↓' : '→';
  } else if (haveSpan) {
    arr = delta > 0.75  ? '↑↑' :
          delta > 0.25  ? '↑'  :
          delta < -0.75 ? '↓↓' :
          delta < -0.25 ? '↓'  : '→';
  } else {
    arr = '·';
  }

  var bgEl  = document.getElementById('bg-num');
  var color = d.bg < BG_LOW  ? 'rgba(100,150,255,0.9)'  :
              d.bg > BG_HIGH ? 'rgba(255,160,80,0.9)'   :
              'rgba(' + pal.bgLine[0] + ',' + pal.bgLine[1] + ',' + pal.bgLine[2] + ',0.92)';
  var _lo = getLabelOpacity();
  bgEl.innerHTML = d.bg.toFixed(1) +
    '<span style="font-size:20px;opacity:' + (0.45 * _lo) + ';margin-left:4px">' + arr + '</span>';
  bgEl.style.color = color;
  bgEl.style.opacity = String(Math.min(1, _lo * 1.15));

  document.getElementById('bg-unit').style.color = 'rgba(150,180,200,' + (_lo * 0.45) + ')';

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

  // Mana pill — position between COB and IOB reservoir peaks, living in the flow
  var pill = document.getElementById('mana-pill');
  if (pill) {
    var H_px = window.innerHeight;
    var hasCOB = d.cob > 0.5 && _lastCOBPeakY > 0;
    var hasIOB = d.iob > 0.1 && _lastIOBPeakY > 0;
    if (hasCOB && hasIOB) {
      // Float midway between the two reservoir peaks
      var cobY = _lastCOBPeakY;         // px from top, COB peak (near BG line from below)
      var iobY = _lastIOBPeakY;         // px from top, IOB peak (near BG line from above)
      var midY = (cobY + iobY) / 2;
      // Convert to bottom offset (for CSS bottom property)
      var bottomPx = Math.max(60, H_px - midY - 20);
      pill.style.bottom = bottomPx + 'px';
      pill.style.opacity = '1';
    } else if (hasCOB) {
      var bottomPx = Math.max(60, H_px - _lastCOBPeakY + 16);
      pill.style.bottom = bottomPx + 'px';
      pill.style.opacity = '1';
    } else if (hasIOB) {
      var bottomPx = Math.max(60, H_px - _lastIOBPeakY - 36);
      pill.style.bottom = bottomPx + 'px';
      pill.style.opacity = '1';
    } else {
      // Nothing active — hide gently
      pill.style.opacity = '0';
    }
  }
}

function returnToNow() {
  _isAtNow = true;
  viewTime = HISTORY_RAW.length > 0 ? HISTORY_RAW[HISTORY_RAW.length-1].t : Date.now();
  viewSpan = 2 * 3600000; // fixed 2h
  var nb = document.getElementById('now-btn');
  if (nb) nb.style.opacity = '0';
}

// Track if user has scrolled away from now
let _isAtNow = true;


// ── CURVE BUBBLE SYSTEM — physics-aware accumulation at peaks and troughs ──
// Separate from the NOW_X forceParticles system.
// Bubbles accumulate at local BG peaks (carbs dominating) and troughs (insulin dominating).
// Lava-lamp motion, per-food GI colour, dark unknown blobs mixed in.

var _curveBubbles    = [];   // active curve bubbles
var _curveGhosts     = [];   // ribbon ghost trails
var _ptCache         = null; // cached peaks/troughs
var _ptCacheTime     = 0;    // when cache was built
var _ptCacheView     = 0;    // viewTime when cache was built
var _cbFrame         = 0;    // animation frame counter

// Find up to 3 local peaks and troughs in the visible BG curve
function _findPeaksTroughs() {
  var now = Date.now();
  if (_ptCache && (now - _ptCacheTime) < 2000 &&
      Math.abs(_ptCacheView - viewTime) < 2 * 60000) {
    return _ptCache;
  }

  var pts = [];
  var steps = 40;
  var leftT  = viewTime - viewSpan * NOW_X;
  var rightT = viewTime + viewSpan * (1 - NOW_X);
  // Only look at history, not forecast
  rightT = Math.min(rightT, viewTime + 60000);

  for (var i = 0; i <= steps; i++) {
    var t = leftT + (i / steps) * (rightT - leftT);
    var d = dataAt(t);
    pts.push({ t: t, bg: d.bg, cob: d.cob || 0, iob: d.iob || 0 });
  }

  var results = [];
  for (var i = 2; i < pts.length - 2; i++) {
    var prev2 = pts[i-2].bg, prev1 = pts[i-1].bg;
    var cur   = pts[i].bg;
    var next1 = pts[i+1].bg, next2 = pts[i+2].bg;

    var isPeak  = cur > prev1 && cur > prev2 && cur > next1 && cur > next2;
    var isTrough= cur < prev1 && cur < prev2 && cur < next1 && cur < next2;

    if (isPeak || isTrough) {
      var p = pts[i];
      var netForce = p.cob - p.iob * 1.8; // carbs vs insulin-weighted
      results.push({
        t: p.t,
        x: tX(p.t),
        y: bgToY(p.bg),
        bg: p.bg,
        type: isPeak ? 'peak' : 'trough',
        cob: p.cob,
        iob: p.iob,
        netForce: netForce,
        magnitude: isPeak ? (p.bg - BG_LOW) / (BG_HIGH - BG_LOW)
                           : (BG_HIGH - p.bg) / (BG_HIGH - BG_LOW),
      });
    }
  }

  // Keep strongest 3
  results.sort(function(a, b) { return Math.abs(b.netForce) - Math.abs(a.netForce); });
  results = results.slice(0, 3);

  _ptCache    = results;
  _ptCacheTime = now;
  _ptCacheView = viewTime;
  return results;
}

// Spawn curve bubbles at a peak or trough
function _spawnCurveBubbles(pt) {
  var isPeak = pt.type === 'peak';
  var count  = Math.max(3, Math.round(pt.magnitude * 14));

  // ── Divergence model ───────────────────────────────────────────────
  // How much of the BG at this pt is unexplained by COB+IOB forces?
  // Estimate predicted BG: neutral baseline + COB lift - IOB pull
  // COB contribution: each gram lifts ~0.05 mmol; IOB: each unit pulls ~1.5 mmol
  var activeCOB = pt.cob || 0;
  var activeIOB = pt.iob || 0;
  var neutralBG   = 6.0; // mmol baseline for model
  var predictedBG = neutralBG + activeCOB * 0.05 - activeIOB * 1.5;
  predictedBG     = Math.max(2.5, Math.min(18, predictedBG));
  var divergence  = Math.abs(pt.bg - predictedBG);
  // Dark (unknown force) blobs only spawn when reality significantly diverges from model
  var darkCount = 0;
  if (divergence > 1.2) {
    darkCount = Math.min(4, Math.floor((divergence - 1.2) * 2));
  }

  // ── Explanation model ─────────────────────────────────────────────────
  // How much of this peak/trough is explained by active COB or IOB?
  // cobExplained: 0–1 fraction of the move accounted for by active carbs
  // iobExplained: 0–1 fraction accounted for by active insulin
  // unexplained:  remainder → silver/grey bubbles
  // When a meal is later logged, COB rises, cobExplained rises, grey→warm.

  var d = dataAt(pt.t);
  var activeCOB = d.cob || 0;
  var activeIOB = d.iob || 0;

  // Total "force" budget — rough normalisation
  var totalForce = Math.max(0.1, activeCOB * 0.8 + activeIOB * 1.8);
  var cobExplained = Math.min(1, (activeCOB * 0.8) / totalForce);
  var iobExplained = Math.min(1, (activeIOB * 1.8) / totalForce);

  // At a peak: carbs are the explaining force (buoyancy)
  // At a trough: insulin is the explaining force (gravity)
  var explainedFraction = isPeak ? cobExplained : iobExplained;
  // If neither COB nor IOB is meaningful, everything is unknown
  if (activeCOB < 0.5 && activeIOB < 0.1) explainedFraction = 0;

  // Dominant GI for colour
  var domGI = 55;
  var meals = _getActiveMealEvents();
  if (meals.length > 0) {
    var bestCarbs = 0, bestFood = null;
    meals.forEach(function(meal) {
      var elapsedMin = (pt.t - meal.t) / 60000;
      if (meal.items) meal.items.forEach(function(food) {
        var rem = _cobFgi(elapsedMin, food.gi || 55) * (food.carbs || 0);
        if (rem > bestCarbs) { bestCarbs = rem; bestFood = food; }
      });
    });
    if (bestFood) domGI = bestFood.gi || 55;
  }

  // Silver/grey colour for unknown force
  var COL_UNKNOWN = [160, 168, 185]; // cool silver — the unnamed thing

  // Colour for the explained force
  var COL_EXPLAINED = isPeak
    ? giToColour(domGI + (Math.random() - 0.5) * 20)  // carb: GI-warm
    : (RIVER_VISUAL_PREFS && RIVER_VISUAL_PREFS.iobR ? RIVER_VISUAL_PREFS.iobR : COL_IOB); // IOB: blue

  // Split count: explained vs unknown
  var explainedCount = Math.round(count * explainedFraction);
  var unknownCount   = count - explainedCount;

  // ── Spawn explained bubbles (coloured) ─────────────────────────────────
  for (var i = 0; i < explainedCount; i++) {
    var isIOB  = !isPeak; // peak → carb below, trough → IOB above
    var oyBase = isIOB ? -(3 + Math.random() * 18) : (3 + Math.random() * 22);
    _curveBubbles.push({
      ptType: pt.type, ptX: pt.x, ptY: pt.y,
      ox: (Math.random() - 0.5) * 38, oy: oyBase,
      x: pt.x + (Math.random() - 0.5) * 38, y: pt.y + oyBase,
      vx: (Math.random() - 0.5) * 0.12,
      vy: isIOB ? -(0.04 + Math.random() * 0.08) : (0.04 + Math.random() * 0.08),
      r: 2.5 + Math.random() * 3.5, col: COL_EXPLAINED,
      isIOB: isIOB, isDark: false, alpha: 0,
      phase: Math.random() * Math.PI * 2,
      lavaPhase: Math.random() * Math.PI * 2, lavaSpeed: 0.008 + Math.random() * 0.012,
      ghosts: [], age: 0,
    });
  }

  // ── Spawn silver unknown bubbles (unexplained fraction of explained pool) ──
  for (var j = 0; j < unknownCount; j++) {
    var oyUnk = (Math.random() - 0.5) * 28;
    _curveBubbles.push({
      ptType: pt.type, ptX: pt.x, ptY: pt.y,
      ox: (Math.random() - 0.5) * 32, oy: oyUnk,
      x: pt.x + (Math.random() - 0.5) * 32, y: pt.y + oyUnk,
      vx: (Math.random() - 0.5) * 0.07, vy: (Math.random() - 0.5) * 0.06,
      r: 2.0 + Math.random() * 2.8, col: COL_UNKNOWN,
      isIOB: false, isDark: false, isUnknown: true, alpha: 0,
      phase: Math.random() * Math.PI * 2,
      lavaPhase: Math.random() * Math.PI * 2, lavaSpeed: 0.005 + Math.random() * 0.008,
      ghosts: [], age: 0,
    });
  }

  // ── Dark blobs — divergence-gated unnamed force ────────────────────────
  // Only spawn when actual BG significantly diverges from COB+IOB model (>1.2 mmol).
  // These are the swim, the stress, the growth hormone — the things with no name yet.
  var COL_DARK = [55, 48, 65];
  for (var k = 0; k < darkCount; k++) {
    var oyDk = (Math.random() - 0.5) * 40;
    _curveBubbles.push({
      ptType: pt.type, ptX: pt.x, ptY: pt.y,
      ox: (Math.random() - 0.5) * 44, oy: oyDk,
      x: pt.x + (Math.random() - 0.5) * 44, y: pt.y + oyDk,
      vx: (Math.random() - 0.5) * 0.05, vy: (Math.random() - 0.5) * 0.05,
      r: 3.0 + Math.random() * 3.5, col: COL_DARK,
      isIOB: false, isDark: true, isUnknown: false, alpha: 0,
      phase: Math.random() * Math.PI * 2,
      lavaPhase: Math.random() * Math.PI * 2, lavaSpeed: 0.003 + Math.random() * 0.005,
      ghosts: [], age: 0,
    });
  }
}

// Rebuild curve bubbles when peaks/troughs change significantly
var _lastPTSet = '';
function _updateCurveBubbles() {
  var pts = _findPeaksTroughs();

  // Build a signature to detect changes
  var sig = pts.map(function(p) {
    return p.type + Math.round(p.x) + Math.round(p.y);
  }).join('|');

  // Use sentinel for empty state so it doesn't match a populated state
  if (pts.length === 0) sig = '__empty__';
  // If nothing changed and bubbles already cleared, skip
  if (sig === _lastPTSet && (pts.length > 0 || _curveBubbles.length === 0)) return;
  _lastPTSet = sig;

  // Mark all existing bubbles dying
  _curveBubbles.forEach(function(b) { b._dying = true; });

  // Only spawn for peaks/troughs with meaningful force or magnitude
  // Prevents flat CGM-only wiggles from generating persistent bubbles
  if (pts.length > 0) {
    pts.forEach(function(pt) {
      if (Math.abs(pt.netForce) > 0.8 || pt.magnitude > 0.4) {
        _spawnCurveBubbles(pt);
      }
    });
  }
}

function _tickCurveBubbles() {
  _cbFrame++;
  var pts = _findPeaksTroughs();

  // Build lookup: ptX → pt (for anchoring)
  var ptMap = {};
  pts.forEach(function(pt) { ptMap[Math.round(pt.x)] = pt; });

  _curveBubbles = _curveBubbles.filter(function(b) {
    b.age++;

    // Fade in
    if (!b._dying) b.alpha = Math.min(0.82, b.alpha + 0.025);

    // Max lifetime — bubbles older than 220 frames (~3.6s) start dying naturally
    if (!b._dying && b.age > 220) b._dying = true;

    // Dying bubbles fade out and are removed
    if (b._dying) {
      b.alpha -= 0.022;
      return b.alpha > 0.01;
    }

    // Lava-lamp motion — slow sinusoidal buoyancy
    b.lavaPhase += b.lavaSpeed;
    var lavaLift = Math.sin(b.lavaPhase) * 8;
    var lavaWob  = Math.cos(b.lavaPhase * 0.7 + b.phase) * 5;

    // Find current peak position (peaks move as BG changes)
    var anchorX = b.ptX;
    var anchorY = b.ptY;
    // Re-anchor to nearest pt — orphaned bubbles (no anchor) die
    var reanchored = pts.length === 0 ? false : false;
    pts.forEach(function(pt) {
      if (Math.abs(pt.x - b.ptX) < 60) {
        b.ptX = pt.x; b.ptY = pt.y;
        anchorX = pt.x; anchorY = pt.y;
        reanchored = true;
      }
    });
    if (!reanchored && pts.length === 0) { b._dying = true; }

    // Target: orbital offset + lava motion around anchor
    var targetX = anchorX + b.ox + lavaWob;
    var rawTargetY = anchorY + b.oy + lavaLift * (b.ptType === 'peak' ? -1 : 1);
    // IOB stays above line — hard max 12px above anchor (gravity drops hug the line)
    // Carbs stay below line (positive offset = lower on canvas = buoyancy up visually)
    var targetY = b.isIOB
      ? Math.max(anchorY - 12, Math.min(anchorY - 2 - lavaLift * 0.3, rawTargetY))
      : (b.isDark ? rawTargetY : Math.max(anchorY + 1, rawTargetY));

    // Spring toward target
    b.vx += (targetX - b.x) * 0.04;
    b.vy += (targetY - b.y) * 0.04;
    b.vx *= 0.82;
    b.vy *= 0.82;
    b.x += b.vx;
    b.y += b.vy;

    // Ghost ribbon — every 6 frames if moving fast enough
    if (_cbFrame % 6 === 0 && (Math.abs(b.vx) + Math.abs(b.vy)) > 0.3) {
      b.ghosts.push({ x: b.x, y: b.y, alpha: b.alpha * 0.35, r: b.r * 0.7, col: b.col });
      if (b.ghosts.length > 6) b.ghosts.shift();
    }

    // Decay ghosts
    b.ghosts.forEach(function(g) { g.alpha *= 0.84; });
    b.ghosts = b.ghosts.filter(function(g) { return g.alpha > 0.01; });

    return true;
  });
}

function _drawCurveBubbles() {
  // Draw ghosts first (ribbon trails)
  _curveBubbles.forEach(function(b) {
    b.ghosts.forEach(function(g) {
      CX.beginPath();
      CX.arc(g.x, g.y, g.r, 0, Math.PI * 2);
      CX.fillStyle = 'rgba(' + g.col[0] + ',' + g.col[1] + ',' + g.col[2] + ',' + g.alpha + ')';
      CX.fill();
    });
  });

  // Draw bubbles
  _curveBubbles.forEach(function(b) {
    if (b.alpha < 0.01) return;
    var rv = b.col[0], gv = b.col[1], bv = b.col[2];
    var a  = b.alpha;

    if (b.isUnknown) {
      // Unknown force — silver mist droplet. Soft, no hard edge. The unnamed thing.
      CX.beginPath();
      CX.arc(b.x, b.y, b.r * 1.1, 0, Math.PI * 2);
      CX.fillStyle = 'rgba(' + rv + ',' + gv + ',' + bv + ',' + (a * 0.22) + ')';
      CX.fill();
      CX.strokeStyle = 'rgba(' + rv + ',' + gv + ',' + bv + ',' + (a * 0.55) + ')';
      CX.lineWidth = 0.7;
      CX.stroke();
      // Faint inner glow
      CX.beginPath();
      CX.arc(b.x - b.r * 0.2, b.y - b.r * 0.2, b.r * 0.3, 0, Math.PI * 2);
      CX.fillStyle = 'rgba(220,228,240,' + (a * 0.28) + ')';
      CX.fill();
    } else if (b.isDark) {
      // Dark blob (legacy) — solid charcoal
      CX.beginPath();
      CX.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      CX.fillStyle   = 'rgba(' + rv + ',' + gv + ',' + bv + ',' + (a * 0.72) + ')';
      CX.fill();
      CX.strokeStyle = 'rgba(20,18,22,' + (a * 0.45) + ')';
      CX.lineWidth   = 0.8;
      CX.stroke();
    } else if (b.isIOB) {
      // IOB teardrop — smaller, falling feel
      var s = b.r;
      CX.beginPath();
      CX.arc(b.x, b.y, s, 0, Math.PI * 2);
      CX.fillStyle   = 'rgba(' + rv + ',' + gv + ',' + bv + ',' + (a * 0.55) + ')';
      CX.fill();
      CX.strokeStyle = 'rgba(' + rv + ',' + gv + ',' + bv + ',' + (a * 0.80) + ')';
      CX.lineWidth   = 1.1;
      CX.stroke();
      // Small inner highlight
      CX.beginPath();
      CX.arc(b.x - s * 0.25, b.y - s * 0.3, s * 0.22, 0, Math.PI * 2);
      CX.fillStyle = 'rgba(195,228,255,' + (a * 0.42) + ')';
      CX.fill();
    } else {
      // Carb bubble — GI-coloured, open circle with fill
      CX.beginPath();
      CX.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      CX.fillStyle   = 'rgba(' + rv + ',' + gv + ',' + bv + ',' + (a * 0.18) + ')';
      CX.fill();
      CX.strokeStyle = 'rgba(' + rv + ',' + gv + ',' + bv + ',' + (a * 0.85) + ')';
      CX.lineWidth   = 1.4;
      CX.stroke();
      // Warm highlight
      var hlR = rv > 200 ? 255 : 200, hlG = gv > 150 ? 230 : 210, hlB = bv < 100 ? 170 : 220;
      CX.beginPath();
      CX.arc(b.x - b.r * 0.28, b.y - b.r * 0.3, b.r * 0.24, 0, Math.PI * 2);
      CX.fillStyle = 'rgba(' + hlR + ',' + hlG + ',' + hlB + ',' + (a * 0.44) + ')';
      CX.fill();
    }
  });
}

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
  const cobPts = buildForcePts('cob',  1, 180);
  const iobPts = buildForcePts('iob', -1, 180);
  drawGasCloud(cobPts, COL_COB,  1, d);   // carbs: warm orange rising
  drawGasCloud(iobPts, COL_IOB, -1, d);   // insulin: cool blue falling

  // ── BG TRACE — the life-line ────────────────────────────────────
  drawBGTrail(pal);
  drawUnknownForce(pal);  // silver mist where forces are unexplained (layer 1)

  // ── CURVE BUBBLES — lava-lamp accumulation at peaks and troughs ──
  _updateCurveBubbles();  // rebuild if peaks/troughs changed
  _tickCurveBubbles();    // physics tick every frame
  _drawCurveBubbles();    // render after mist, before orb

  // ── EVENT MARKERS — ripples where forces entered ───────────────
  drawBolusMarkers(pal);
  drawBasalReservoir(pal);  // subtle always-present basal drip
  drawBloodPricks();         // red diamond prick markers

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
  drawNoDataOrb(pal);  // pulsing grey orb during active sensor gap

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
  const latestT = HISTORY_RAW.length > 0 ? HISTORY_RAW[HISTORY_RAW.length-1].t : Date.now();
  const awayFromNow = (latestT - viewTime) > 8 * 60000;
  var nowBtn = document.getElementById('now-btn');
  if (!nowBtn) {
    // Create it if missing — position on right so it never gets lost during zoom/scroll
    nowBtn = document.createElement('button');
    nowBtn.id = 'now-btn';
    nowBtn.textContent = 'now ›';
    nowBtn.onclick = returnToNow;
    nowBtn.style.cssText = [
      'position:fixed',
      'right:14px',
      'bottom:80px',
      'z-index:50',
      'padding:8px 14px',
      'border-radius:20px',
      'border:1px solid rgba(62,180,120,0.35)',
      'background:rgba(3,8,22,0.82)',
      'backdrop-filter:blur(8px)',
      "font-family:'DM Mono',monospace",
      'font-size:10px',
      'letter-spacing:0.5px',
      'color:rgba(62,200,140,0.85)',
      'cursor:pointer',
      'transition:opacity .25s',
      'opacity:0',
      'pointer-events:none',
      'touch-action:manipulation',
    ].join(';');
    document.body.appendChild(nowBtn);
  }
  nowBtn.style.opacity        = awayFromNow ? '0.9' : '0';
  nowBtn.style.pointerEvents  = awayFromNow ? 'auto' : 'none';

  // time labels handled by drawTimeLabels

  checkAlerts(_isAtNow ? d : null);
  drawHypoPulse(pal);
  updateHUD(d, pal);
  updateNudgeChipVisibility();

  requestAnimationFrame(frame);
  } catch(e) {
    console.error('[river] frame error:', e);
    requestAnimationFrame(frame); // keep running even if a frame errors
    // Auto-capture to debug log for easy reporting
    if (window.__debugLog) {
      window.__debugLog.unshift('[FRAME ERR] ' + e.message + ' (line ~' + (e.stack||'').split('\n')[1] + ')');
    }
  }
}

// ── TOUCH / MOUSE ────────────────────────────────────────────
// drag.pending = touch is down but hasn't moved 10px yet (long-press window)
// drag.on      = confirmed drag in progress
// KEY: iOS Safari suppresses long-press when passive:false touchmove is registered upfront on the element.
// Fix: start with passive:true touchmove only. Attach non-passive handler dynamically only once drag confirmed.
let drag={on:false,pending:false,x0:0,y0:0,t0:0}, pinch={on:false,d0:0,s0:0};
var _dragActiveListenerAttached = false;

function _onDragMoveActive(e) {
  if(e.target.closest&&e.target.closest('#sheet,#flow-dock,.dock-btn,#whisper-overlay,#food-mgr-overlay,#hypo-overlay,#corr-overlay,#food-add-overlay,[id$=-overlay],button,input,textarea,select')) return;
  if(e.touches.length===1 && drag.on) {
    e.preventDefault();
    viewTime=Math.max(CGM_START,Math.min(CGM_END,drag.t0-(e.touches[0].clientX-drag.x0)*(viewSpan/W))); _isAtNow=false;
  } else if(pinch.on&&e.touches.length===2) {
    e.preventDefault();
    const dx=e.touches[0].clientX-e.touches[1].clientX;
    const dy=e.touches[0].clientY-e.touches[1].clientY;
    viewSpan=Math.max(MIN_SPAN,Math.min(MAX_SPAN,pinch.s0*(pinch.d0/Math.hypot(dx,dy))));
  }
}

CV.addEventListener('touchstart',e=>{
  if(e.target.closest&&e.target.closest('#sheet,#flow-dock,.dock-btn,#whisper-overlay,#food-mgr-overlay,#hypo-overlay,#corr-overlay,#food-add-overlay,[id$=-overlay],button,input,textarea,select')) return;
  if(e.touches.length===1) drag={on:false,pending:true,x0:e.touches[0].clientX,y0:e.touches[0].clientY,t0:viewTime};
  else if(e.touches.length===2) {
    drag={on:false,pending:false,x0:0,y0:0,t0:0};
    const dx=e.touches[0].clientX-e.touches[1].clientX;
    const dy=e.touches[0].clientY-e.touches[1].clientY;
    pinch={on:true,d0:Math.hypot(dx,dy),s0:viewSpan};
  }
},{passive:true});
CV.addEventListener('touchmove',e=>{
  if(e.target.closest&&e.target.closest('#sheet,#flow-dock,.dock-btn,#whisper-overlay,#food-mgr-overlay,#hypo-overlay,#corr-overlay,#food-add-overlay,[id$=-overlay],button,input,textarea,select')) return;
  if(e.touches.length===1 && drag.pending && !drag.on) {
    const dx=e.touches[0].clientX-drag.x0, dy=e.touches[0].clientY-drag.y0;
    if(Math.sqrt(dx*dx+dy*dy) > 10) {
      drag.on=true; drag.pending=false;
      if(!_dragActiveListenerAttached) {
        _dragActiveListenerAttached=true;
        CV.addEventListener('touchmove', _onDragMoveActive, {passive:false});
      }
    }
  } else if(e.touches.length===2 && pinch.on && !_dragActiveListenerAttached) {
    _dragActiveListenerAttached=true;
    CV.addEventListener('touchmove', _onDragMoveActive, {passive:false});
  }
},{passive:true});
CV.addEventListener('touchend',()=>{
  drag.on=false; drag.pending=false; pinch.on=false;
  if(_dragActiveListenerAttached) {
    CV.removeEventListener('touchmove', _onDragMoveActive);
    _dragActiveListenerAttached=false;
  }
},{passive:true});
let md={on:false,x0:0,t0:0};
CV.addEventListener('mousedown',e=>{if(!e.target.closest('#sheet,#flow-dock,.dock-btn,#whisper-overlay,#food-mgr-overlay,#hypo-overlay,#corr-overlay,#food-add-overlay,[id$=-overlay],button,input,textarea,select'))md={on:true,x0:e.clientX,t0:viewTime}});
CV.addEventListener('mousemove',e=>{if(md.on)viewTime=Math.max(CGM_START,Math.min(CGM_END,md.t0-(e.clientX-md.x0)*(viewSpan/W)))});
CV.addEventListener('mouseup',()=>md.on=false);
CV.addEventListener('click', function(e) {
  var rect = CV.getBoundingClientRect();
  var mx = e.clientX - rect.left;
  var my = e.clientY - rect.top;

  // Check prick diamonds first
  if (window._prickCards && _prickCards.length > 0) {
    for (var pi = 0; pi < _prickCards.length; pi++) {
      var pc = _prickCards[pi];
      if (Math.abs(mx - pc.x) < 14 && Math.abs(my - pc.y) < 14) {
        openPrickEditor(pc.prick);
        return;
      }
    }
  }

  // Then event chips
  if (!window._eventCards || _eventCards.length === 0) return;
  for (var ci = 0; ci < _eventCards.length; ci++) {
    var c = _eventCards[ci];
    if (mx >= c.x - c.w/2 && mx <= c.x + c.w/2 && my >= c.y - 12 && my <= c.y + 12) {
      openEventEditor(c.idx);
      return;
    }
  }
});
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

// Set sheet time from an explicit timestamp — used when back-logging at a historical position
function setSheetTime(t) {
  var d = new Date(t);
  var local = new Date(d.getTime() - d.getTimezoneOffset()*60000);
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

function onTimeChange(val) {
  _entryTimeVal = val;
  // Update display without full re-render (which wipes input values)
  var disp = document.getElementById('time-display');
  if (disp) {
    var d = new Date(val);
    disp.textContent = d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'}) +
      ' · ' + d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
  }
  // Update bolus suggestion only
  var c = parseFloat((document.getElementById('in-c')||{}).value)||0;
  var u = parseFloat((document.getElementById('in-i')||{}).value)||0;
  var bg= parseFloat((document.getElementById('in-bg')||{}).value)||0;
  if (c > 0 && bg > 0) onInp();
}

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

// ═══════════════════════════════════════════════════════════════════════
//  PEOPLE IN THE FLOW
//  Device identity — who's using this device right now
//  Profiles stored in localStorage, device_id links to a person
// ═══════════════════════════════════════════════════════════════════════

var FLOW_PEOPLE = (function() {
  try { return JSON.parse(localStorage.getItem('river_people') || '[]'); } catch(e) { return []; }
})();

var _thisPersonId = localStorage.getItem('river_person_id') || null;

function savePeople() {
  try { localStorage.setItem('river_people', JSON.stringify(FLOW_PEOPLE)); } catch(e) {}
}

function getThisPerson() {
  if (!_thisPersonId) return null;
  return FLOW_PEOPLE.find(function(p){ return p.id === _thisPersonId; }) || null;
}

function setThisPerson(id) {
  _thisPersonId = id;
  localStorage.setItem('river_person_id', id);
}

function getPersonInitial(id) {
  var p = FLOW_PEOPLE.find(function(p){ return p.id === id; });
  return p ? p.name.slice(0,1).toUpperCase() : '?';
}

function getPersonColour(id) {
  var p = FLOW_PEOPLE.find(function(p){ return p.id === id; });
  return p ? p.colour : 'rgba(150,150,150,0.7)';
}

// Open "people in the flow" management screen
function openPeopleInFlow() {
  var ex = document.getElementById('people-overlay');
  if (ex) { ex.remove(); return; }
  var el = document.createElement('div');
  el.id = 'people-overlay';
  el.style.cssText = 'position:fixed;inset:0;z-index:85;background:var(--rv-panel-bg);backdrop-filter:blur(16px);display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:48px 24px 40px;overflow-y:auto;transition:opacity .2s;opacity:0;touch-action:pan-y';
  el.addEventListener('touchstart',function(e){e.stopPropagation();},{passive:true});
  renderPeopleScreen(el);
  document.body.appendChild(el);
  requestAnimationFrame(function(){ el.style.opacity='1'; });
}

function closePeopleInFlow() {
  var el = document.getElementById('people-overlay');
  if (el) { el.style.opacity='0'; setTimeout(function(){ el.remove(); }, 200); }
}

function renderPeopleScreen(el) {
  if (!el) el = document.getElementById('people-overlay');
  if (!el) return;

  var colours = ['rgba(62,180,120,0.9)','rgba(60,130,220,0.9)','rgba(255,140,50,0.9)',
                 'rgba(200,80,160,0.9)','rgba(180,160,60,0.9)','rgba(120,160,220,0.9)'];

  var html = '<div style="max-width:380px;width:100%">';
  html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">';
  html += '<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:26px;color:rgba(180,220,200,0.9)">people in the flow</div>';
  html += '<button onclick="closePeopleInFlow()" style="background:none;border:none;cursor:pointer;font-size:24px;color:var(--rv-close-btn);padding:4px">×</button>';
  html += '</div>';
  html += '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(100,160,140,0.35);letter-spacing:1px;text-transform:uppercase;margin-bottom:28px">who\'s watching the river</div>';

  // This device
  var me = getThisPerson();
  html += '<div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1px;text-transform:uppercase;color:var(--rv-text-dim);margin-bottom:10px">this device</div>';
  if (me) {
    html += '<div style="display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:12px;background:var(--rv-input-bg);border:1px solid var(--rv-panel-border);margin-bottom:20px">';
    html += '<div style="width:40px;height:40px;border-radius:50%;background:'+me.colour+';display:flex;align-items:center;justify-content:center;font-family:\'Fraunces\',serif;font-size:18px;color:#fff;font-weight:200">'+me.name.slice(0,1).toUpperCase()+'</div>';
    html += '<div style="flex:1"><div style="font-family:\'Fraunces\',serif;font-weight:200;font-size:18px;color:var(--rv-text-primary)">'+me.name+'</div>';
    html += '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:var(--rv-text-muted)">'+me.role+'</div></div>';
    html += '<button onclick="clearThisDevice()" style="padding:6px 12px;border-radius:8px;border:1px solid var(--rv-panel-border);background:transparent;font-family:\'DM Mono\',monospace;font-size:9px;color:var(--rv-close-btn);cursor:pointer">change</button>';
    html += '</div>';
  } else {
    html += '<div style="padding:14px 16px;border-radius:12px;background:var(--rv-input-bg);border:1px dashed rgba(255,255,255,0.1);margin-bottom:20px;font-family:\'DM Mono\',monospace;font-size:11px;color:var(--rv-text-muted)">not set — pick below</div>';
  }

  // All people
  html += '<div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1px;text-transform:uppercase;color:var(--rv-text-dim);margin-bottom:10px">the team</div>';
  html += '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:20px">';

  FLOW_PEOPLE.forEach(function(person) {
    var isMe = person.id === _thisPersonId;
    html += '<div style="display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:10px;background:'+(isMe?'rgba(62,180,120,0.1)':'rgba(255,255,255,0.03)')+';border:1px solid '+(isMe?'rgba(62,180,120,0.3)':'rgba(255,255,255,0.07)')+';">';
    html += '<div style="width:34px;height:34px;border-radius:50%;background:'+person.colour+';display:flex;align-items:center;justify-content:center;font-family:\'Fraunces\',serif;font-size:16px;color:#fff;font-weight:200;flex-shrink:0">'+person.name.slice(0,1).toUpperCase()+'</div>';
    html += '<div style="flex:1"><div style="font-family:\'Fraunces\',serif;font-weight:200;font-size:16px;color:var(--rv-text-primary)">'+person.name+'</div>';
    html += '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:var(--rv-text-muted)">'+person.role+'</div></div>';
    if (!isMe) {
      html += '<button onclick="setThisDeviceTo(\''+person.id+'\')" style="padding:6px 12px;border-radius:8px;border:1px solid var(--rv-panel-border);background:transparent;font-family:\'DM Mono\',monospace;font-size:9px;color:var(--rv-text-muted);cursor:pointer">this is me</button>';
    } else {
      html += '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(62,180,120,0.7)">← you</div>';
    }
    html += '<button onclick="removePerson(\''+person.id+'\')" style="padding:4px 8px;border-radius:6px;border:none;background:transparent;font-family:\'DM Mono\',monospace;font-size:11px;color:var(--rv-text-dim);cursor:pointer">×</button>';
    html += '</div>';
  });
  html += '</div>';

  // Add person form
  html += '<div style="padding:16px;border-radius:12px;background:var(--rv-input-bg);border:1px solid var(--rv-panel-border)">';
  html += '<div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1px;text-transform:uppercase;color:var(--rv-text-dim);margin-bottom:12px">add someone</div>';
  html += '<div style="display:flex;gap:8px;margin-bottom:10px">';
  html += '<input id="new-person-name" type="text" placeholder="name" autocorrect="off" style="flex:1;padding:10px 12px;border-radius:8px;border:1px solid var(--rv-panel-border);background:var(--rv-input-bg);font-family:\'DM Mono\',monospace;font-size:13px;color:var(--rv-text-secondary);outline:none">';
  html += '<select id="new-person-role" style="padding:10px;border-radius:8px;border:1px solid var(--rv-panel-border);background:var(--rv-input-bg);font-family:\'DM Mono\',monospace;font-size:11px;color:var(--rv-text-secondary);outline:none">';
  ['parent','carer','school TA','family','other'].forEach(function(r){
    html += '<option value="'+r+'">'+r+'</option>';
  });
  html += '</select></div>';
  // Colour picker
  html += '<div style="display:flex;gap:8px;margin-bottom:12px">';
  colours.forEach(function(c,i){
    html += '<button onclick="selectNewPersonColour(\''+c+'\')" id="colour-btn-'+i+'" style="width:28px;height:28px;border-radius:50%;background:'+c+';border:2px solid transparent;cursor:pointer;transition:border .1s" data-colour="'+c+'"></button>';
  });
  html += '</div>';
  html += '<button onclick="addPerson()" style="width:100%;padding:11px;border-radius:9px;border:1px solid rgba(62,180,120,0.3);background:rgba(62,180,120,0.08);font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:16px;color:rgba(62,180,120,0.9);cursor:pointer">add to the flow</button>';
  html += '</div></div>';

  el.innerHTML = html;
  // Default colour selection
  window._newPersonColour = colours[0];
  var btn = el.querySelector('[data-colour="'+colours[0]+'"]');
  if (btn) btn.style.border = '2px solid rgba(255,255,255,0.7)';
}

function selectNewPersonColour(col) {
  window._newPersonColour = col;
  document.querySelectorAll('[data-colour]').forEach(function(b){
    b.style.border = b.getAttribute('data-colour')===col ? '2px solid rgba(255,255,255,0.7)' : '2px solid transparent';
  });
}

function addPerson() {
  var name = (document.getElementById('new-person-name').value||'').trim();
  var role = document.getElementById('new-person-role').value;
  if (!name) return;
  var id = 'person_' + Date.now().toString(36);
  var colour = window._newPersonColour || 'rgba(62,180,120,0.9)';
  FLOW_PEOPLE.push({id:id, name:name, role:role, colour:colour});
  savePeople();
  // Auto-set as this device if no one set yet
  if (!_thisPersonId) setThisDevice(id);
  renderPeopleScreen();
}

function removePerson(id) {
  var idx = FLOW_PEOPLE.findIndex(function(p){ return p.id===id; });
  if (idx>=0) FLOW_PEOPLE.splice(idx,1);
  savePeople();
  if (_thisPersonId===id) { _thisPersonId=null; localStorage.removeItem('river_person_id'); }
  renderPeopleScreen();
}

function setThisDeviceTo(id) {
  setThisPerson(id);
  renderPeopleScreen();
}

function clearThisDevice() {
  _thisPersonId = null;
  localStorage.removeItem('river_person_id');
  renderPeopleScreen();
}

// First-run prompt if no person set and no people defined
function promptPersonIfNeeded() {
  if (_thisPersonId || FLOW_PEOPLE.length === 0) return;
  // Silently skip — they'll set it via settings
}

// ═══════════════════════════════════════════════════════════════════════
//  RECIPE SYSTEM
//  Templates with carb-relevant ingredients
//  Each cook creates an instance with actual weights → ratio
//  Portion logging uses ratio × weight
// ═══════════════════════════════════════════════════════════════════════

var RECIPES = (function() {
  try { return JSON.parse(localStorage.getItem('river_recipes') || '[]'); } catch(e) { return []; }
})();

function saveRecipes() {
  try { localStorage.setItem('river_recipes', JSON.stringify(RECIPES)); } catch(e) {}
}

// A recipe instance = one cook of a template with actual weights recorded
// recipe.instances = [{date, weights:{ingredientName: grams}, batchWeight, ratio, notes}]

function calcRecipeRatio(recipe, weights, batchWeight) {
  // Total carbs from weighed ingredients
  var totalCarbs = 0;
  recipe.ingredients.forEach(function(ing) {
    var g = parseFloat(weights[ing.name]) || 0;
    totalCarbs += (ing.c100 * g / 100);
  });
  var ratio = batchWeight > 0 ? totalCarbs / batchWeight : 0;
  return { totalCarbs: totalCarbs, ratio: ratio };
}

// Get most recent ratio for a recipe
function getLatestRatio(recipe) {
  if (!recipe.instances || recipe.instances.length === 0) return null;
  return recipe.instances[recipe.instances.length - 1].ratio;
}

// ═══════════════════════════════════════════════════════════════════════
//  PLATE BUILDER — KITCHEN MODE
//  Running tally of Oskar's plate while cooking
//  Supports: regular foods, recipe portions, manual entries
//  Persists across sheet open/close during a cooking session
// ═══════════════════════════════════════════════════════════════════════

var _plateItems   = [];   // [{type:'food'|'recipe'|'manual', name, carbs, grams, note}]
var _plateActive  = false;
var _plateBolused = false;
var _plateBolusU  = 0;
var _plateBolusTm = 0;
var _cookingTimer = null;
var _servingMins  = null; // estimated mins until ready

function startPlateBuilder() {
  _plateActive  = true;
  _plateBolused = false;
  _plateBolusU  = 0;
  _plateBolusTm = 0;
  _servingMins  = null;
  renderKitchen();
  document.getElementById('sheet').classList.add('open');
  document.getElementById('overlay').classList.add('open');
}

function openKitchen() {
  // Kitchen mode = enhanced food sheet
  // Merges into openSheet with kitchen context
  _mealItems  = [];
  _bolusGiven = false;
  _sheetMode  = 'kitchen';
  _plateItems = [];
  _plateBolused = false;
  renderSheet();
  document.getElementById('sheet').classList.add('open');
  document.getElementById('overlay').classList.add('open');
  var liveRef = HISTORY_RAW.length > 0 ? HISTORY_RAW[HISTORY_RAW.length-1].t : Date.now();
  if (liveRef - viewTime > 2 * 60000) {
    setSheetTime(viewTime);
  } else {
    setTimeNow();
  }
}

function totalPlateCarbs() {
  return _plateItems.reduce(function(s,i){ return s + (i.carbs||0); }, 0);
}

function addPlateFood(name) {
  var all  = FOOD_DB.concat(FOOD_LIBRARY);
  var food = all.find(function(f){ return f.name===name; });
  if (!food) return;
  var defaultG = food.g_each || food.g_serv || 100;
  var carbs    = Math.round((food.c100 * defaultG / 100) * 10) / 10;
  _plateItems.push({
    type:'food', name:food.name, grams:defaultG, carbs:carbs,
    gi:food.gi||55, c100:food.c100, food:food,
  });
  renderKitchen();
}

function addPlateRecipe(recipeId) {
  var recipe = RECIPES.find(function(r){ return r.id===recipeId; });
  if (!recipe) return;
  var ratio = getLatestRatio(recipe);
  _plateItems.push({
    type:'recipe', name:recipe.name, grams:100,
    ratio:ratio, carbs:ratio ? Math.round(ratio*100*10)/10 : 0,
    recipeId:recipeId, needsWeighing:true,
  });
  renderKitchen();
}

function updatePlateItemGrams(idx, grams) {
  var p = _plateItems[idx];
  if (!p) return;
  p.grams = parseFloat(grams) || 0;
  if (p.type==='food' || p.type==='manual') {
    p.carbs = p.c100 ? Math.round((p.c100*p.grams/100)*10)/10 : p.carbs;
  } else if (p.type==='recipe' && p.ratio) {
    p.carbs = Math.round(p.ratio * p.grams * 10) / 10;
  }
  renderKitchen();
}

function removePlateItem(idx) {
  _plateItems.splice(idx, 1);
  renderKitchen();
}

function renderKitchen() {
  var sheet = document.getElementById('sheet');
  if (!sheet) return;
  var d      = dataAt(viewTime);
  var bg     = d.bg;
  var total  = totalPlateCarbs();
  var avgGI  = _plateItems.length>0
    ? _plateItems.reduce(function(s,i){return s+(i.gi||55)*(i.carbs||0);},0)/Math.max(total,1)
    : 55;
  var eatWait = _eatWaitOverride!==null?_eatWaitOverride:suggestEatWait(bg,avgGI);
  var bolus   = total>0 ? calcBolus(total,bg,getEntryTime()) : null;

  // Whisper — pattern memory for this meal context
  var whisperHTML = buildKitchenWhisper(avgGI, total);

  // Items HTML
  var itemsHTML = _plateItems.map(function(item,idx){
    var isCook = item.type==='recipe';
    var col    = isCook?'rgba(180,160,60,0.8)':'rgba(62,180,120,0.8)';
    return '<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.05)">' +
      '<div style="flex:1">' +
        '<div style="font-family:\'DM Mono\',monospace;font-size:11px;color:var(--rv-text-secondary)">'+item.name+'</div>' +
        (isCook&&item.needsWeighing?'<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(200,160,60,0.6)">⚖ weigh the portion</div>':'') +
      '</div>' +
      '<input type="number" value="'+item.grams+'" min="0" max="2000" step="1" ' +
        'onchange="updatePlateItemGrams('+idx+',this.value)" ' +
        'style="width:58px;padding:6px;border-radius:7px;border:1px solid var(--rv-panel-border);background:var(--rv-input-bg);font-family:\'DM Mono\',monospace;font-size:12px;color:var(--rv-text-secondary);text-align:right;outline:none">'+
      '<span style="font-family:\'DM Mono\',monospace;font-size:9px;color:var(--rv-text-muted);width:12px">g</span>' +
      '<div style="min-width:36px;text-align:right;font-family:\'DM Mono\',monospace;font-size:12px;color:'+col+'">'+item.carbs.toFixed(1)+'g</div>' +
      '<button onclick="removePlateItem('+idx+')" style="background:none;border:none;cursor:pointer;color:var(--rv-text-dim);font-size:16px;padding:0 4px">×</button>' +
    '</div>';
  }).join('');

  // Food search for plate
  var searchHTML =
    '<div style="position:relative;margin-bottom:10px">' +
      '<input id="plate-search" type="text" placeholder="add food to plate..." autocomplete="off" autocorrect="off" ' +
        'oninput="searchPlateFood(this.value)" ' +
        'style="width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--rv-panel-border);background:var(--rv-input-bg);font-family:\'DM Mono\',monospace;font-size:13px;color:var(--rv-text-secondary);outline:none;box-sizing:border-box">' +
      '<div id="plate-results" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:50;background:rgba(15,20,35,0.99);border:1px solid var(--rv-panel-border);border-radius:10px;max-height:180px;overflow-y:auto;margin-top:4px"></div>' +
    '</div>';

  // Recipe chips
  var recipeChips = '';
  if (RECIPES.length > 0) {
    recipeChips = '<div style="margin-bottom:12px"><div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1px;text-transform:uppercase;color:var(--rv-text-dim);margin-bottom:6px">saved recipes</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:6px">' +
      RECIPES.map(function(r){
        var ratio = getLatestRatio(r);
        return '<button onclick="addPlateRecipe(\''+r.id+'\')" style="padding:6px 12px;border-radius:10px;border:1px solid rgba(180,160,60,0.3);background:rgba(180,160,60,0.08);font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(200,180,80,0.8);cursor:pointer">' +
          r.name + (ratio?' · '+ratio.toFixed(2)+'g/g':'') + '</button>';
      }).join('') +
      '</div></div>';
  }

  // Bolus section
  var bolusHTML = '';
  if (total > 0 && bolus) {
    var eatTime = new Date(getEntryTime() + eatWait*60000);
    var eatStr  = eatTime.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
    if (_plateBolused) {
      bolusHTML =
        '<div style="padding:14px;border-radius:12px;background:rgba(60,130,220,0.1);border:1px solid rgba(60,130,220,0.25);margin-bottom:12px">' +
          '<div style="font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(60,130,220,0.7);margin-bottom:4px">✓ bolus given</div>' +
          '<div style="font-family:\'Fraunces\',serif;font-weight:200;font-size:28px;color:rgba(100,160,255,0.9)">' + _plateBolusU.toFixed(1) + 'U</div>' +
          '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(100,140,200,0.5);margin-top:4px">eat by ' + eatStr + ' · timer running</div>' +
          '<button onclick="logPlate()" style="margin-top:10px;width:100%;padding:11px;border-radius:9px;border:1px solid rgba(62,180,120,0.3);background:rgba(62,180,120,0.08);font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:15px;color:rgba(62,180,120,0.9);cursor:pointer">✓ confirm plate + log</button>' +
        '</div>';
    } else {
      bolusHTML =
        '<div style="padding:14px;border-radius:12px;background:rgba(40,50,80,0.4);border:1px solid var(--rv-panel-border);margin-bottom:12px">' +
          // Carb total prominent
          '<div style="text-align:center;margin-bottom:12px">' +
            '<div style="font-family:\'Fraunces\',serif;font-weight:200;font-size:48px;color:rgba(255,160,60,0.95);letter-spacing:-2px;line-height:1">' + total.toFixed(0) + '</div>' +
            '<div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1.5px;text-transform:uppercase;color:rgba(255,160,70,0.7)">grams carbs · GI ' + avgGI.toFixed(0) + '</div>' +
          '</div>' +
          // Wait time
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;padding:8px 10px;border-radius:8px;background:var(--rv-input-bg)">' +
            '<div style="flex:1;font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:13px;color:rgba(255,255,255,0.5)">bolus now → eat ~' + eatStr + ' (+' + eatWait + 'min)</div>' +
            '<button onclick="setWait(-5)" style="width:28px;height:28px;border-radius:7px;border:1px solid var(--rv-panel-border);background:var(--rv-input-bg);color:var(--rv-text-secondary);font-size:16px;cursor:pointer">−</button>' +
            '<input id="wait-mins" type="number" value="'+eatWait+'" min="0" max="60" step="5" onchange="setWaitDirect(this.value)" style="width:40px;text-align:center;padding:4px;border-radius:6px;border:1px solid var(--rv-panel-border);background:var(--rv-input-bg);font-family:\'DM Mono\',monospace;font-size:12px;color:var(--rv-text-secondary);outline:none">' +
            '<button onclick="setWait(5)" style="width:28px;height:28px;border-radius:7px;border:1px solid var(--rv-panel-border);background:var(--rv-input-bg);color:var(--rv-text-secondary);font-size:16px;cursor:pointer">+</button>' +
          '</div>' +
          // Bolus input
          '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">' +
            '<input id="plate-bolus" type="number" inputmode="decimal" placeholder="'+bolus.total.toFixed(1)+'" step="0.5" min="0" max="20" ' +
              'style="flex:1;padding:12px;border-radius:9px;border:1px solid rgba(60,130,220,0.25);background:rgba(60,130,220,0.07);font-family:\'Fraunces\',serif;font-size:24px;color:rgba(100,160,255,0.9);text-align:center;outline:none">' +
            '<span style="font-family:\'DM Mono\',monospace;font-size:13px;color:var(--rv-text-muted)">U</span>' +
          '</div>' +
          '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:var(--rv-text-dim);text-align:center;margin-bottom:10px">' +
            'context: '+bolus.carbDose.toFixed(1)+'U carbs + '+bolus.corrDose.toFixed(1)+'U corr · ISF 1:'+bolus.isf+'</div>' +
          '<button onclick="bolusNow()" style="width:100%;padding:13px;border-radius:10px;border:1px solid rgba(60,130,220,0.3);background:rgba(60,130,220,0.1);font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:17px;color:rgba(100,160,255,0.9);cursor:pointer">bolus now · keep cooking</button>' +
        '</div>';
    }
  }

  // Kitchen mode — dark bg so text is readable
  if (_sheetMode === 'kitchen') {
    sheet.style.background = 'rgba(8,12,28,0.98)';
    sheet.style.color = 'rgba(255,255,255,0.85)';
  } else {
    sheet.style.background = '';
    sheet.style.color = '';
  }

  var kitchenTopHTML = '';
  if (_sheetMode === 'kitchen') {
    var whisper = buildKitchenWhisper(avgGI, totalCarbs);
    var _kDiv = document.createElement('div');
    _kDiv.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 14px;border-radius:10px;background:var(--rv-input-bg);border:1px solid var(--rv-panel-border);margin-bottom:14px';
    var _kBG = document.createElement('div');
    _kBG.style.fontSize = '24px';
    _kBG.style.color = bg<3.9 ? 'rgba(100,140,255,0.95)' : bg>10 ? 'rgba(255,120,40,0.95)' : 'rgba(62,200,140,0.95)';
    _kBG.textContent = bg.toFixed(1);
    var _kLbl = document.createElement('div');
    _kLbl.style.fontFamily = 'monospace';
    _kLbl.style.fontSize = '9px';
    _kLbl.style.color = 'rgba(255,255,255,0.3)';
    _kLbl.textContent = 'mmol · live';
    var _kSp = document.createElement('div'); _kSp.style.flex = '1';
    var _kBtn = document.createElement('button');
    _kBtn.style.cssText = 'padding:5px 10px;border-radius:7px;border:1px solid rgba(200,180,60,0.3);background:rgba(200,180,60,0.07);font-family:monospace;font-size:9px;color:rgba(200,180,70,0.8);cursor:pointer';
    _kBtn.textContent = '🍳 recipes';
    _kBtn.onclick = function(){ openRecipeManager(); };
    _kDiv.appendChild(_kBG); _kDiv.appendChild(_kLbl); _kDiv.appendChild(_kSp); _kDiv.appendChild(_kBtn);
    kitchenTopHTML = _kDiv.outerHTML + whisper;
  }

  // Assemble close button
  var closeBtn = '<button onclick="closeSheet()" style="position:absolute;top:14px;right:16px;' +
    'background:none;border:none;cursor:pointer;font-size:20px;' +
    'color:var(--rv-text-muted);padding:4px 8px;line-height:1;touch-action:manipulation">×</button>';

  sheet.innerHTML =
    '<div style="position:relative;padding:20px 18px 24px;">' +
      closeBtn +
      kitchenTopHTML +
      itemsHTML +
      '<div style="margin-top:10px">' + searchHTML + recipeChips + '</div>' +
      bolusHTML +
    '</div>';
}

function searchPlateFood(q) {
  var results = document.getElementById('plate-results');
  if (!q||q.length<1){ results.style.display='none'; return; }
  var all = FOOD_DB.concat(FOOD_LIBRARY);
  var matches = all.filter(function(f){ return f.name.toLowerCase().indexOf(q.toLowerCase())>=0; }).slice(0,8);
  if (matches.length===0){ results.style.display='none'; return; }
  results.style.display='block';
  results.innerHTML = matches.map(function(f){
    return '<div onclick="addPlateFood(\''+f.name.replace(/'/g,"\\'")+'\')" style="padding:10px 14px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.05);display:flex;justify-content:space-between;align-items:center">' +
      '<div style="font-family:\'DM Mono\',monospace;font-size:12px;color:var(--rv-text-secondary)">'+f.name+'</div>' +
      '<div style="font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(62,180,120,0.6)">'+f.c100+'g/100g</div>' +
    '</div>';
  }).join('');
}

function bolusNow() {
  var inp = document.getElementById('plate-bolus');
  var u   = parseFloat(inp&&inp.value) || 0;
  if (u<=0) return;
  if (u > 20) { showToast('⚠️ ' + u.toFixed(1) + 'U is very high — max 20U per entry'); return; }
  if (u > 15) { showToast('⚠️ ' + u.toFixed(1) + 'U logged — double-check this dose'); }
  var t = getEntryTime() || Date.now();
  SESSION.push({t:t, c:0, u:u});
  BOLUS_EVENTS.push({t:t, c:0, u:u});
  LOGGED_EVENTS.push({t:t, c:0, u:u, note:'bolus', logged_by:_thisPersonId||'unknown', local:true});
  try{localStorage.setItem('river_session',JSON.stringify(SESSION));}catch(e){}
  try{localStorage.setItem('river_logged',JSON.stringify(LOGGED_EVENTS));}catch(e){}
  topUpIOB(u);
  syncAfterLog();
  _ptCache = null;
  _plateBolused = true;
  _plateBolusU  = u;
  _plateBolusTm = t;
  // Eat reminder
  var eatWait = _eatWaitOverride!==null?_eatWaitOverride:suggestEatWait(dataAt(viewTime).bg);
  if (_cookingTimer) clearTimeout(_cookingTimer);
  _cookingTimer = setTimeout(function(){
    showRiverPebble('time to plate up — bolus was '+eatWait+'min ago','eat');
    if(navigator.vibrate) navigator.vibrate([200,100,200]);
  }, Math.max(0, eatWait*60000));
  renderKitchen();
  showToast(u.toFixed(1)+'U bolused\nkeep cooking ↻');
}

function logPlate() {
  var total    = totalPlateCarbs();
  var avgGI    = _plateItems.length>0
    ? _plateItems.reduce(function(s,i){return s+(i.gi||55)*(i.carbs||0);},0)/Math.max(total,1) : 55;
  var t = _plateBolusTm || Date.now();
  var eatWait  = _eatWaitOverride!==null?_eatWaitOverride:suggestEatWait(dataAt(viewTime).bg,avgGI);
  var carbT    = t + eatWait*60000;
  var foodItems= _plateItems.map(function(i){return {name:i.name,carbs:i.carbs,gi:i.gi||55,g:i.grams};});

  if (total>0) {
    SESSION.push({t:carbT, c:total, u:0, gi:avgGI, items:foodItems});
    BOLUS_EVENTS.push({t:carbT, c:total, u:0, gi:avgGI, items:foodItems});
    LOGGED_EVENTS.push({t:carbT, c:total, u:0, gi:avgGI, items:foodItems, note:'plate',
      logged_by:_thisPersonId||'unknown', local:true});
    topUpCOB(total);
  }

  // Save to meal history
  MEAL_HISTORY.unshift({
    name: (function(){
      var hr=new Date().getHours();
      var meal=hr<10?'Breakfast':hr<14?'Lunch':hr<17?'Snack':'Dinner';
      return meal+' · '+new Date().toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'});
    })(),
    totalCarbs: Math.round(total), items:foodItems, t:carbT, u:_plateBolusU,
    logged_by:_thisPersonId||'unknown',
  });
  saveMealHistory();

  try{localStorage.setItem('river_session',JSON.stringify(SESSION));}catch(e){}
  try{localStorage.setItem('river_logged',JSON.stringify(LOGGED_EVENTS));}catch(e){}
  syncAfterLog();
  _ptCache = null;
  showToast(total.toFixed(0)+'g carbs\nplate logged ✓');
  closeKitchen();
}

function closeKitchen() {
  _plateActive     = false;
  _eatWaitOverride = null;
  _bolusVal        = null;
  if (_cookingTimer) { clearTimeout(_cookingTimer); _cookingTimer=null; }
  var s=document.getElementById('sheet');
  var o=document.getElementById('overlay');
  if(s) s.classList.remove('open');
  if(o) o.classList.remove('open');
}

// ═══════════════════════════════════════════════════════════════════════
//  RECIPE MANAGER
//  Create/edit recipe templates, log cook instances, calculate ratios
// ═══════════════════════════════════════════════════════════════════════

function openRecipeManager() {
  var ex=document.getElementById('recipe-overlay');
  if(ex){ex.remove();return;}
  var el=document.createElement('div');
  el.id='recipe-overlay';
  el.style.cssText='position:fixed;inset:0;z-index:90;background:var(--rv-panel-bg);overflow-y:auto;transition:opacity .2s;opacity:0;touch-action:pan-y;-webkit-overflow-scrolling:touch';
  el.addEventListener('touchstart',function(e){e.stopPropagation();},{passive:true});
  renderRecipeManager(el);
  document.body.appendChild(el);
  requestAnimationFrame(function(){el.style.opacity='1';});
}

function closeRecipeManager() {
  var el=document.getElementById('recipe-overlay');
  if(el){el.style.opacity='0';setTimeout(function(){el.remove();},200);}
}

function renderRecipeManager(el) {
  if(!el) el=document.getElementById('recipe-overlay');
  if(!el) return;
  var html='<div style="max-width:480px;margin:0 auto;padding:48px 20px 60px">';
  html+='<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px">';
  html+='<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:24px;color:rgba(200,180,80,0.9)">recipes</div>';
  html+='<div style="display:flex;gap:8px">';
  html+='<button onclick="startNewRecipe()" style="padding:8px 14px;border-radius:9px;border:1px solid rgba(200,180,60,0.3);background:rgba(200,180,60,0.07);font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(200,180,70,0.8);cursor:pointer">+ new recipe</button>';
  html+='<button onclick="closeRecipeManager()" style="padding:8px 12px;border-radius:9px;border:1px solid var(--rv-panel-border);background:transparent;font-family:\'DM Mono\',monospace;font-size:10px;color:var(--rv-text-muted);cursor:pointer">close</button>';
  html+='</div></div>';

  if(RECIPES.length===0){
    html+='<div style="font-family:\'DM Mono\',monospace;font-size:11px;color:var(--rv-close-btn);text-align:center;padding:40px 0">no recipes yet<br><span style="opacity:0.5">add Kaarina\'s specials here</span></div>';
  } else {
    RECIPES.forEach(function(r){
      var ratio=getLatestRatio(r);
      var instances=r.instances||[];
      html+='<div style="padding:16px;border-radius:12px;background:var(--rv-input-bg);border:1px solid rgba(200,180,60,0.15);margin-bottom:12px">';
      html+='<div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:8px">';
      html+='<div><div style="font-family:\'Fraunces\',serif;font-weight:200;font-size:18px;color:rgba(220,200,80,0.9)">'+r.name+'</div>';
      html+='<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:var(--rv-close-btn)">'+r.ingredients.length+' ingredients · '+instances.length+' cook'+(instances.length!==1?'s':'')+'</div></div>';
      html+='<div style="display:flex;gap:6px">';
      html+='<button onclick="cookRecipe(\''+r.id+'\')" style="padding:6px 12px;border-radius:8px;border:1px solid rgba(200,180,60,0.3);background:rgba(200,180,60,0.08);font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(200,180,70,0.8);cursor:pointer">cook now</button>';
      html+='<button onclick="editRecipe(\''+r.id+'\')" style="padding:6px 10px;border-radius:8px;border:1px solid var(--rv-panel-border);background:transparent;font-family:\'DM Mono\',monospace;font-size:9px;color:var(--rv-text-muted);cursor:pointer">edit</button>';
      html+='</div></div>';
      if(ratio){
        html+='<div style="font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(200,180,70,0.6)">'+ratio.toFixed(3)+'g carbs/g · last cook '+(instances.length>0?new Date(instances[instances.length-1].date).toLocaleDateString('en-GB',{day:'numeric',month:'short'}):'')+'</div>';
      }
      // Show last 3 instances
      if(instances.length>0){
        html+='<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px">';
        instances.slice(-3).reverse().forEach(function(inst){
          html+='<div style="font-family:\'DM Mono\',monospace;font-size:8px;color:var(--rv-text-dim);padding:3px 7px;border-radius:5px;background:var(--rv-input-bg)">'+
            new Date(inst.date).toLocaleDateString('en-GB',{day:'numeric',month:'short'})+' · '+inst.ratio.toFixed(3)+'g/g</div>';
        });
        html+='</div>';
      }
      html+='</div>';
    });
  }
  html+='</div>';
  el.innerHTML=html;
}

function startNewRecipe() {
  showRecipeForm(null);
}

function editRecipe(id) {
  var r=RECIPES.find(function(r){return r.id===id;});
  showRecipeForm(r);
}

function showRecipeForm(recipe) {
  var el=document.getElementById('recipe-overlay');
  if(!el) return;
  var isNew=!recipe;
  var ings=recipe?recipe.ingredients:[];

  var html='<div style="max-width:480px;margin:0 auto;padding:48px 20px 60px">';
  html+='<div style="display:flex;align-items:center;gap:12px;margin-bottom:24px">';
  html+='<button onclick="renderRecipeManager()" style="background:none;border:none;cursor:pointer;font-family:\'DM Mono\',monospace;font-size:10px;color:var(--rv-text-muted);padding:4px">← back</button>';
  html+='<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:22px;color:rgba(200,180,80,0.9)">'+(isNew?'new recipe':'edit recipe')+'</div>';
  html+='</div>';

  html+='<div style="margin-bottom:14px"><div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1px;text-transform:uppercase;color:var(--rv-text-muted);margin-bottom:5px">recipe name</div>';
  html+='<input id="recipe-name" type="text" value="'+(recipe?recipe.name:'')+'" placeholder="e.g. Kaarina\'s Macaroni Laatikko" autocorrect="off" style="width:100%;padding:11px 14px;border-radius:9px;border:1px solid rgba(200,180,60,0.2);background:rgba(200,180,60,0.05);font-family:\'DM Mono\',monospace;font-size:13px;color:var(--rv-text-secondary);outline:none;box-sizing:border-box"></div>';

  html+='<div style="margin-bottom:14px"><div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1px;text-transform:uppercase;color:var(--rv-text-muted);margin-bottom:6px">carb ingredients <span style="opacity:0.5">(skip zero-carb items like meat, eggs)</span></div>';
  html+='<div id="recipe-ings">';
  ings.forEach(function(ing,i){
    html+=recipeIngRow(i,ing.name,ing.c100,ing.gi);
  });
  html+='</div>';
  html+='<div style="position:relative;margin-top:8px">';
  html+='<input id="recipe-ing-search" type="text" placeholder="search to add ingredient..." autocomplete="off" autocorrect="off" oninput="searchRecipeIng(this.value)" style="width:100%;padding:9px 12px;border-radius:9px;border:1px solid var(--rv-panel-border);background:var(--rv-input-bg);font-family:\'DM Mono\',monospace;font-size:12px;color:var(--rv-text-secondary);outline:none;box-sizing:border-box">';
  html+='<div id="recipe-ing-results" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:50;background:rgba(15,20,35,0.99);border:1px solid var(--rv-panel-border);border-radius:9px;max-height:160px;overflow-y:auto;margin-top:4px"></div>';
  html+='</div></div>';

  html+='<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:var(--rv-close-btn);margin-bottom:16px;line-height:1.7">';
  html+='When you cook, you\'ll enter the actual weight of each ingredient. The app calculates total carbs, you weigh the finished dish, and it works out the ratio (g carbs per g of dish).</div>';

  html+='<div style="display:flex;gap:8px">';
  html+='<button onclick="saveRecipeForm(\''+encodeURIComponent(recipe?recipe.id:'')+'\','+isNew+')" style="flex:1;padding:12px;border-radius:10px;border:1px solid rgba(200,180,60,0.3);background:rgba(200,180,60,0.08);font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:16px;color:rgba(220,200,80,0.9);cursor:pointer">save recipe</button>';
  if(!isNew) html+='<button onclick="deleteRecipe(\''+recipe.id+'\')" style="padding:12px 16px;border-radius:10px;border:1px solid rgba(200,60,60,0.2);background:transparent;font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(200,80,80,0.5);cursor:pointer">delete</button>';
  html+='<button onclick="renderRecipeManager()" style="padding:12px 14px;border-radius:10px;border:1px solid var(--rv-panel-border);background:transparent;font-family:\'DM Mono\',monospace;font-size:10px;color:var(--rv-close-btn);cursor:pointer">cancel</button>';
  html+='</div></div>';

  el.innerHTML=html;
  window._recipeIngredients = ings.slice(); // working copy
}

function recipeIngRow(i, name, c100, gi) {
  return '<div id="ring-'+i+'" style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.05)">' +
    '<div style="flex:1;font-family:\'DM Mono\',monospace;font-size:11px;color:var(--rv-text-secondary)">'+name+'</div>' +
    '<div style="font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(62,180,120,0.6)">'+c100+'g/100g</div>' +
    '<button onclick="removeRecipeIng('+i+')" style="background:none;border:none;cursor:pointer;color:var(--rv-text-dim);font-size:15px;padding:0 4px">×</button>' +
  '</div>';
}

function searchRecipeIng(q) {
  var res=document.getElementById('recipe-ing-results');
  if(!q||q.length<1){res.style.display='none';return;}
  var all=FOOD_DB.concat(FOOD_LIBRARY);
  var matches=all.filter(function(f){return f.name.toLowerCase().indexOf(q.toLowerCase())>=0&&f.c100>0;}).slice(0,8);
  if(matches.length===0){res.style.display='none';return;}
  res.style.display='block';
  res.innerHTML=matches.map(function(f){
    return '<div onclick="addRecipeIng(\''+f.name.replace(/'/g,"\\'")+'\','+f.c100+','+(f.gi||55)+')" style="padding:9px 12px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.05);display:flex;justify-content:space-between">' +
      '<div style="font-family:\'DM Mono\',monospace;font-size:11px;color:var(--rv-text-secondary)">'+f.name+'</div>' +
      '<div style="font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(62,180,120,0.5)">'+f.c100+'g/100g</div>' +
    '</div>';
  }).join('');
}

function addRecipeIng(name, c100, gi) {
  if (!window._recipeIngredients) window._recipeIngredients=[];
  window._recipeIngredients.push({name:name, c100:c100, gi:gi||55});
  var container=document.getElementById('recipe-ings');
  if(container){
    var i=window._recipeIngredients.length-1;
    container.insertAdjacentHTML('beforeend', recipeIngRow(i,name,c100,gi||55));
  }
  var inp=document.getElementById('recipe-ing-search');
  if(inp) inp.value='';
  document.getElementById('recipe-ing-results').style.display='none';
}

function removeRecipeIng(i) {
  if(window._recipeIngredients) window._recipeIngredients.splice(i,1);
  var el=document.getElementById('ring-'+i);
  if(el) el.remove();
}

function saveRecipeForm(encodedId, isNew) {
  var name=(document.getElementById('recipe-name').value||'').trim();
  if(!name){showToast('recipe needs a name');return;}
  var ings=window._recipeIngredients||[];
  if(ings.length===0){showToast('add at least one ingredient');return;}

  if(isNew) {
    var r={id:'recipe_'+Date.now().toString(36), name:name, ingredients:ings, instances:[]};
    RECIPES.push(r);
  } else {
    var id=decodeURIComponent(encodedId);
    var idx=RECIPES.findIndex(function(r){return r.id===id;});
    if(idx>=0){RECIPES[idx].name=name;RECIPES[idx].ingredients=ings;}
  }
  saveRecipes();
  showToast(name+'\nsaved');
  renderRecipeManager();
}

function deleteRecipe(id) {
  var idx=RECIPES.findIndex(function(r){return r.id===id;});
  if(idx>=0) RECIPES.splice(idx,1);
  saveRecipes();
  renderRecipeManager();
}

// Cook a recipe — open the cook session to enter actual weights
function cookRecipe(id) {
  var recipe=RECIPES.find(function(r){return r.id===id;});
  if(!recipe) return;
  var el=document.getElementById('recipe-overlay');
  if(!el) return;

  var html='<div style="max-width:480px;margin:0 auto;padding:48px 20px 60px">';
  html+='<div style="display:flex;align-items:center;gap:12px;margin-bottom:6px">';
  html+='<button onclick="renderRecipeManager()" style="background:none;border:none;cursor:pointer;font-family:\'DM Mono\',monospace;font-size:10px;color:var(--rv-text-muted);padding:4px">← back</button>';
  html+='<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:22px;color:rgba(200,180,80,0.9)">'+recipe.name+'</div>';
  html+='</div>';
  html+='<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:var(--rv-close-btn);margin-bottom:24px">weigh each ingredient as you add it</div>';

  // Ingredient weight inputs
  html+='<div style="margin-bottom:16px">';
  recipe.ingredients.forEach(function(ing,i){
    html+='<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.05)">';
    html+='<div style="flex:1;font-family:\'DM Mono\',monospace;font-size:12px;color:var(--rv-text-secondary)">'+ing.name+'<span style="opacity:0.4;margin-left:6px;font-size:9px">'+ing.c100+'g/100g</span></div>';
    html+='<input id="cook-ing-'+i+'" type="number" inputmode="decimal" placeholder="grams" min="0" max="2000" step="1" oninput="updateCookPreview(\''+recipe.id+'\')" style="width:70px;padding:8px;border-radius:8px;border:1px solid rgba(200,180,60,0.2);background:rgba(200,180,60,0.05);font-family:\'DM Mono\',monospace;font-size:13px;color:rgba(220,200,80,0.9);text-align:right;outline:none">';
    html+='<span style="font-family:\'DM Mono\',monospace;font-size:9px;color:var(--rv-close-btn)">g</span>';
    html+='</div>';
  });
  html+='</div>';

  // Totals preview
  html+='<div id="cook-preview" style="padding:12px;border-radius:10px;background:var(--rv-input-bg);border:1px solid var(--rv-panel-border);margin-bottom:14px;font-family:\'DM Mono\',monospace;font-size:10px;color:var(--rv-text-muted)">enter weights above to see carb total</div>';

  // Batch weight
  html+='<div style="margin-bottom:16px"><div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1px;text-transform:uppercase;color:var(--rv-text-muted);margin-bottom:6px">finished dish weight (g)</div>';
  html+='<input id="cook-batch-weight" type="number" inputmode="decimal" placeholder="weigh the whole dish" min="0" max="10000" step="1" oninput="updateCookPreview(\''+recipe.id+'\')" style="width:100%;padding:11px 14px;border-radius:9px;border:1px solid var(--rv-panel-border);background:var(--rv-input-bg);font-family:\'DM Mono\',monospace;font-size:16px;color:var(--rv-text-secondary);outline:none;box-sizing:border-box">';
  html+='</div>';

  html+='<div id="cook-ratio-preview" style="font-family:\'DM Mono\',monospace;font-size:11px;color:rgba(200,180,70,0.7);margin-bottom:16px;min-height:16px"></div>';

  html+='<div style="display:flex;gap:8px">';
  html+='<button onclick="saveCookInstance(\''+recipe.id+'\')" style="flex:1;padding:12px;border-radius:10px;border:1px solid rgba(200,180,60,0.3);background:rgba(200,180,60,0.08);font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:16px;color:rgba(220,200,80,0.9);cursor:pointer">save this cook</button>';
  html+='<button onclick="renderRecipeManager()" style="padding:12px 14px;border-radius:10px;border:1px solid var(--rv-panel-border);background:transparent;font-family:\'DM Mono\',monospace;font-size:10px;color:var(--rv-close-btn);cursor:pointer">cancel</button>';
  html+='</div></div>';

  el.innerHTML=html;
  window._cookingRecipeId=id;
}

function updateCookPreview(recipeId) {
  var recipe=RECIPES.find(function(r){return r.id===recipeId;});
  if(!recipe) return;
  var weights={};
  recipe.ingredients.forEach(function(ing,i){
    var el=document.getElementById('cook-ing-'+i);
    weights[ing.name]=parseFloat(el&&el.value)||0;
  });
  var batchEl=document.getElementById('cook-batch-weight');
  var batchW=parseFloat(batchEl&&batchEl.value)||0;
  var calc=calcRecipeRatio(recipe,weights,batchW);

  var prev=document.getElementById('cook-preview');
  if(prev){
    var lines=recipe.ingredients.map(function(ing,i){
      var g=weights[ing.name]||0;
      var c=g?Math.round(ing.c100*g/100*10)/10:0;
      return ing.name+(g?' '+g+'g → '+c+'g carbs':'');
    }).filter(function(l){return l.indexOf('→')>-1;});
    prev.innerHTML=lines.length?
      lines.join('<br>')+'<br><strong style="color:rgba(255,200,60,0.8)">total: '+calc.totalCarbs.toFixed(1)+'g carbs</strong>':
      'enter weights above to see carb total';
  }
  var rp=document.getElementById('cook-ratio-preview');
  if(rp && batchW>0 && calc.totalCarbs>0){
    rp.textContent='ratio: '+calc.ratio.toFixed(3)+'g carbs per gram · 100g portion = '+Math.round(calc.ratio*100)+'g carbs';
  } else if(rp) {
    rp.textContent='';
  }
}

function saveCookInstance(recipeId) {
  var recipe=RECIPES.find(function(r){return r.id===recipeId;});
  if(!recipe) return;
  var weights={};
  recipe.ingredients.forEach(function(ing,i){
    var el=document.getElementById('cook-ing-'+i);
    weights[ing.name]=parseFloat(el&&el.value)||0;
  });
  var batchEl=document.getElementById('cook-batch-weight');
  var batchW=parseFloat(batchEl&&batchEl.value)||0;
  if(batchW<=0){showToast('enter the finished dish weight');return;}
  var calc=calcRecipeRatio(recipe,weights,batchW);
  if(calc.totalCarbs<=0){showToast('enter at least one ingredient weight');return;}

  if(!recipe.instances) recipe.instances=[];
  recipe.instances.push({
    date:Date.now(), weights:weights, batchWeight:batchW,
    totalCarbs:calc.totalCarbs, ratio:calc.ratio,
    cooked_by:_thisPersonId||'unknown',
  });
  saveRecipes();
  showToast(recipe.name+'\nratio: '+calc.ratio.toFixed(3)+'g/g saved');
  renderRecipeManager();
}

// ═══════════════════════════════════════════════════════════════════════
//  KITCHEN WHISPER — pattern memory surfaced while cooking
//  One line. Quiet. What the river remembers about meals like this one.
// ═══════════════════════════════════════════════════════════════════════

function buildKitchenWhisper(avgGI, totalCarbs) {
  // Find similar past meals from MEAL_HISTORY
  // Similar = same time of day (±2h) and similar carb range (±30%)
  if (!MEAL_HISTORY || MEAL_HISTORY.length < 3) return '';

  var nowHour = new Date().getHours() + new Date().getMinutes()/60;
  var similar = MEAL_HISTORY.filter(function(m) {
    if (!m.t || !m.totalCarbs) return false;
    var mHour = new Date(m.t).getHours() + new Date(m.t).getMinutes()/60;
    var hourDiff = Math.min(Math.abs(mHour-nowHour), 24-Math.abs(mHour-nowHour));
    var carbDiff = totalCarbs > 0 ? Math.abs(m.totalCarbs - totalCarbs) / totalCarbs : 1;
    return hourDiff < 2.5 && carbDiff < 0.4;
  });

  if (similar.length < 2) return '';

  // What happened to BG in the 2h after these meals?
  var peaks = [], lows = [], times = [];
  similar.forEach(function(m) {
    var mealT = m.t;
    var bgAtMeal = histAt(mealT).bg;
    if (!bgAtMeal || bgAtMeal <= 0) return;
    var peakBG = bgAtMeal, peakT = 0, minBG = bgAtMeal;
    for (var mins = 10; mins <= 120; mins += 5) {
      var bg = histAt(mealT + mins*60000).bg;
      if (!bg||bg<=0) continue;
      if (bg > peakBG) { peakBG=bg; peakT=mins; }
      if (bg < minBG)  minBG=bg;
    }
    if (peakT>0) {
      peaks.push(peakBG - bgAtMeal);
      times.push(peakT);
    }
  });

  if (peaks.length < 2) return '';

  var avgRise = peaks.reduce(function(s,v){return s+v;},0)/peaks.length;
  var avgPeakT = times.reduce(function(s,v){return s+v;},0)/times.length;
  var wentHigh = peaks.filter(function(p){return p>3;}).length;

  var msg = '';
  var col = 'rgba(200,200,220,0.55)';

  if (wentHigh >= Math.ceil(peaks.length * 0.6)) {
    msg = similar.length+' similar meals · peaked +'+avgRise.toFixed(1)+' mmol ~'+Math.round(avgPeakT)+'min · went high '+wentHigh+'/'+peaks.length+' times';
    col = 'rgba(255,140,50,0.55)';
  } else if (avgRise > 1.5) {
    msg = similar.length+' similar meals · usually +'+avgRise.toFixed(1)+' mmol around '+Math.round(avgPeakT)+'min';
    col = 'rgba(200,200,100,0.5)';
  } else {
    msg = similar.length+' similar meals · usually settled well · avg rise +'+avgRise.toFixed(1)+' mmol';
    col = 'rgba(62,180,120,0.5)';
  }

  return '<div style="padding:8px 12px;border-radius:8px;background:var(--rv-input-bg);border-left:2px solid '+col+';margin-bottom:12px">' +
    '<div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1px;text-transform:uppercase;color:var(--rv-text-dim);margin-bottom:3px">the river remembers</div>' +
    '<div style="font-family:\'DM Mono\',monospace;font-size:10px;color:'+col+'">'+msg+'</div>' +
  '</div>';
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
function suggestEatWait(bg, avgGI) {
  // Nudge not preach — soft suggestions, team max is 20min
  // GI-adjusted: high GI foods absorb fast so less wait needed
  var gi = avgGI || 60;
  var giAdj = gi >= 70 ? -5 : gi <= 40 ? 5 : 0; // fast food = less wait
  var base;
  if (bg > 10)     base = 20; // high — suggest waiting (capped at team max)
  else if (bg > 7) base = 15; // normal range
  else if (bg > 5) base = 10; // slightly lower — shorter wait
  else             base = 0;  // low — eat now
  return Math.max(0, Math.min(20, base + giAdj));
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
  // Cache bolus value before re-render wipes the input
  var bi = document.getElementById('in-bolus');
  if (bi && bi.value !== '') _bolusVal = bi.value;
  renderSheet();
}

function setWaitDirect(val) {
  var v = Math.max(0, Math.min(60, parseInt(val)||0));
  _eatWaitOverride = v;
  var bi = document.getElementById('in-bolus');
  if (bi && bi.value !== '') _bolusVal = bi.value;
  renderSheet();
}

function openSheet() {
  _mealItems  = [];
  _bolusGiven = false;
  _sheetMode  = 'meal';
  // Meal mode: full-screen dark overlay, consistent with correction/hypo screens
  var s = document.getElementById('sheet');
  if (s) {
    s.style.display = 'flex'; // clear display:none explicitly
    s.style.position = 'fixed';
    s.style.inset = '0';
    s.style.zIndex = '60';
    s.style.background = 'rgba(3,5,20,0.96)';
    s.style.backdropFilter = 'blur(16px)';
    s.style.overflowY = 'auto';
    s.style.WebkitOverflowScrolling = 'touch';
    s.style.transition = 'opacity .25s';
    s.style.opacity = '0';
    s.style.pointerEvents = 'auto';
    s.style.touchAction = 'pan-y';
    s.style.display = 'flex';
    s.style.flexDirection = 'column';
    s.style.borderRadius = '0';
    s.style.transform = 'none';
    s.style.maxHeight = 'none';
  }
  renderSheet();
  if (s) {
    s.classList.add('open');
    requestAnimationFrame(function(){ s.style.opacity = '1'; });
  }
  // If _radialDefaultT set (long press at river position), use that; else use scrub position
  var liveRef = HISTORY_RAW.length > 0 ? HISTORY_RAW[HISTORY_RAW.length-1].t : Date.now();
  if (_radialDefaultT) {
    setSheetTime(_radialDefaultT);
    _radialDefaultT = null;
  } else if (liveRef - viewTime > 2 * 60000) {
    setSheetTime(viewTime);
  } else {
    setTimeNow();
  }
}

// Long-press food button → kitchen mode; tap → quick log
// kitchen mode opened via dock button

function closeSheet() {
  window._logMealLock = false;
  var s = document.getElementById('sheet');
  var o = document.getElementById('overlay');
  if (s) {
    if (_sheetMode === 'meal') {
      // Fade out, then hard-hide. Don't use cssText='' — it races with display:none.
      s.style.opacity = '0';
      s.style.pointerEvents = 'none';
      s.style.touchAction = 'none';
      setTimeout(function() {
        s.classList.remove('open');
        // Reset meal-mode styles individually — don't use cssText='' which clears everything
        s.style.position = '';
        s.style.inset = '';
        s.style.zIndex = '';
        s.style.background = '';
        s.style.backdropFilter = '';
        s.style.overflowY = '';
        s.style.WebkitOverflowScrolling = '';
        s.style.transition = '';
        s.style.opacity = '';
        s.style.pointerEvents = '';
        s.style.touchAction = '';
        s.style.display = 'none';
        s.style.flexDirection = '';
        s.style.borderRadius = '';
        s.style.transform = '';
        s.style.maxHeight = '';
      }, 320);
    } else {
      s.classList.remove('open');
    }
  }
  if (o) o.classList.remove('open');
  _mealItems = [];
  _bolusVal  = null;
  _eatWaitOverride = null;
  _entryTimeVal = null;
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
  var eatWait     = _eatWaitOverride !== null ? _eatWaitOverride : suggestEatWait(bg, avgGI);
  var bolus       = totalCarbs > 0 ? calcBolus(totalCarbs, bg, getEntryTime()) : null;
  var giLabel     = avgGI >= 70 ? 'high GI' : avgGI >= 55 ? 'medium GI' : 'low GI';
  var giCol       = avgGI >= 70 ? 'rgba(210,80,40,0.8)' : avgGI >= 55 ? 'rgba(200,140,30,0.8)' : 'rgba(60,160,90,0.8)';

  var itemsHTML = _mealItems.map(function(item, idx) {
    var gi_i = item.food.gi || 0;
    var giC  = gi_i>=70?'rgba(210,80,40,0.55)':gi_i>=55?'rgba(200,140,30,0.55)':'rgba(60,160,90,0.55)';
    return '<div style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.06)">' +
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:2px">' +
      '<div style="flex:1;font-family:\'DM Mono\',monospace;font-size:11px;color:rgba(220,235,250,0.9)">' + item.food.name + '</div>' +
      (gi_i ? '<span style="font-family:\'DM Mono\',monospace;font-size:8px;color:'+giC+'">GI '+gi_i+'</span>' : '') +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:4px">' +
      '<span style="font-family:\'DM Mono\',monospace;font-size:8px;color:rgba(180,200,220,0.5)">g</span>' +
      '<input type="number" value="' + item.grams + '" min="1" max="1000" step="1" ' +
        'style="width:54px;padding:4px 6px;border-radius:6px;border:1px solid rgba(255,255,255,0.14);' +
        'background:var(--rv-input-bg);font-family:\'DM Mono\',monospace;font-size:11px;color:rgba(220,235,250,0.9);text-align:right" ' +
        'onchange="updateItemGrams(' + idx + ',\'g\',this.value)">' +
      '<span style="font-family:\'DM Mono\',monospace;font-size:8px;color:rgba(62,200,140,0.7)">carbs</span>' +
      '<input type="number" value="' + item.carbs.toFixed(1) + '" min="0" max="200" step="0.5" ' +
        'style="width:50px;padding:4px 6px;border-radius:6px;border:1px solid rgba(62,180,120,0.2);' +
        'background:rgba(62,180,120,0.05);font-family:\'DM Mono\',monospace;font-size:11px;color:rgba(62,180,120,0.9);text-align:right" ' +
        'onchange="updateItemGrams(' + idx + ',\'c\',this.value)">' +
      '<button onclick="removeMealItem(' + idx + ')" style="background:none;border:none;cursor:pointer;' +
        'color:var(--rv-text-muted);font-size:14px;padding:0 4px">×</button>' +
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
      '<div style="background:var(--rv-input-bg);border-radius:10px;padding:10px 12px;border:1px solid var(--rv-panel-border)">' +
      '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(180,200,220,0.55);' +
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
      '<div style="display:flex;justify-content:space-between;font-family:\'DM Mono\',monospace;font-size:8px;color:rgba(180,200,220,0.35);margin-top:2px">' +
        '<span>now</span><span>+1h</span><span>+2h</span><span>+3h</span>' +
      '</div>' +
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
      '<div style="margin:0 18px 14px;padding:14px;background:rgba(30,50,120,0.25);' +
        'border-radius:12px;border:1px solid rgba(80,120,255,0.2)">' +

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
          'padding:8px 10px;border-radius:8px;background:var(--rv-input-bg);' +
          'border:1px solid var(--rv-panel-border)">' +
          '<div style="flex:1">' +
            '<div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1px;' +
              'text-transform:uppercase;color:rgba(180,200,220,0.6);margin-bottom:2px">bolus wait</div>' +
            '<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;' +
              'font-size:14px;color:rgba(200,220,240,0.8)">eat ~' + eatStr + ' (+' + eatWait + 'min)</div>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:4px">' +
            '<button onclick="setWait(-5)" style="width:28px;height:28px;border-radius:8px;' +
              'border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.08);' +
              'font-size:16px;color:rgba(220,235,250,0.8);cursor:pointer;touch-action:manipulation">−</button>' +
            '<input id="wait-mins" type="number" value="' + eatWait + '" min="0" max="60" step="5" ' +
              'onchange="setWaitDirect(this.value)" ' +
              'style="width:42px;text-align:center;padding:4px;border-radius:6px;' +
                'border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.08);' +
                'font-family:\'DM Mono\',monospace;font-size:12px;color:rgba(220,235,250,0.9)">' +
            '<button onclick="setWait(5)" style="width:28px;height:28px;border-radius:8px;' +
              'border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.08);' +
              'font-size:16px;color:rgba(220,235,250,0.8);cursor:pointer;touch-action:manipulation">+</button>' +
          '</div>' +
        '</div>' +

        // Bolus input
        '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(180,200,220,0.6);' +
          'letter-spacing:1px;text-transform:uppercase;margin-bottom:8px">insulin given</div>' +
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">' +
          '<input id="in-bolus" type="number" inputmode="decimal" placeholder="—" value="' + (_bolusVal||'') + '" ' +
            'min="0" max="20" step="0.5" ' +
            'style="flex:1;padding:10px 14px;border-radius:9px;' +
            'border:1px solid rgba(80,140,255,0.3);background:var(--rv-input-bg);' +
            'font-family:\'Fraunces\',serif;font-size:22px;color:rgba(220,235,255,0.9);' +
            'outline:none;text-align:center">' +
          '<span style="font-family:\'DM Mono\',monospace;font-size:13px;color:rgba(180,200,220,0.5)">U</span>' +
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
            'border:1px solid var(--rv-panel-border);background:transparent;' +
            'font-family:\'DM Mono\',monospace;font-size:9px;letter-spacing:.5px;' +
            'text-transform:uppercase;color:rgba(180,200,220,0.45);cursor:pointer">no insulin</button>' +
        '</div>' +
      '</div>';
  }

  sheet.innerHTML =
    '<div style="position:relative;padding:28px 18px 0">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;padding:0 8px 0 0">' +
    '<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:22px;color:rgba(255,140,50,0.9);padding:18px 18px 0">add to the flow</div>' +
    '<button onclick="closeSheet()" style="background:none;border:none;cursor:pointer;font-size:26px;' +
      'color:var(--rv-text-muted);padding:4px 8px;line-height:1;touch-action:manipulation">×</button>' +
    '</div>' +

    // Time row
    '<div style="display:flex;align-items:center;gap:8px;padding:0 18px;margin-bottom:14px">' +
      '<div style="margin-bottom:4px">' +
      '<span id="time-display" style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:16px;color:var(--rv-text-primary)">' + 
        (function(){ var d=_entryTimeVal?new Date(_entryTimeVal):new Date(); return d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'}) + ' · ' + d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}); }()) +
      '</span></div>' +
      '<span style="font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(180,200,220,0.5);letter-spacing:1px;text-transform:uppercase">when</span>' +
      '<input id="in-time" type="datetime-local" style="flex:1;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:var(--rv-input-bg);font-family:\'DM Mono\',monospace;font-size:12px;color:rgba(200,220,240,0.8);outline:none" onchange="onTimeChange(this.value)">' +
      '<button onclick="setTimeNow()" style="padding:6px 10px;border-radius:7px;border:1px solid var(--rv-panel-border);background:var(--rv-input-bg);font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(180,200,220,0.6);cursor:pointer">now</button>' +
    '</div>' +

    // Food search
    '<div style="padding:0 18px;margin-bottom:10px">' +
      '<div style="position:relative">' +
        '<input id="food-search" type="text" placeholder="search food or paste URL..." autocomplete="off" autocorrect="off" spellcheck="false"' +
          ' style="width:100%;padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.08);font-family:\'DM Mono\',monospace;font-size:13px;color:rgba(220,235,250,0.9);outline:none;box-sizing:border-box"' +
          ' oninput="searchFood(this.value)" onpaste="setTimeout(function(){checkFoodPaste(document.getElementById(\'food-search\').value)},50)">' +
        '<div id="food-results" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:50;' +
          'background:rgba(18,24,42,0.99);border:1px solid var(--rv-panel-border);border-radius:10px;' +
          'box-shadow:0 4px 20px rgba(0,0,0,0.08);max-height:180px;overflow-y:auto;margin-top:4px"></div>' +
      '</div>' +
      // Voice / Photo / Pad / URL input buttons
      '<div style="display:flex;gap:8px;margin-top:8px">' +
        '<button id="voice-food-btn" onpointerdown="startVoiceFood(event)" onpointerup="stopVoiceFood(event)" onpointerleave="stopVoiceFood(event)" style="flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:9px 10px;border-radius:9px;border:1px solid var(--rv-panel-border);background:var(--rv-input-bg);font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(180,200,220,0.6);cursor:pointer;touch-action:manipulation;transition:all .2s" title="hold to speak meal">' +
          '<svg viewBox="0 0 16 16" width="13" height="13" fill="none"><rect x="5" y="1" width="6" height="9" rx="3" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 8.5a5.5 5.5 0 0010 0" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="8" y1="14" x2="8" y2="15.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>' +
          'hold to speak' +
        '</button>' +
        '<button onclick="openPhotoFood()" style="flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:9px 10px;border-radius:9px;border:1px solid var(--rv-panel-border);background:var(--rv-input-bg);font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(180,200,220,0.6);cursor:pointer;touch-action:manipulation;transition:all .2s" title="photo of food label">' +
          '<svg viewBox="0 0 16 16" width="13" height="13" fill="none"><rect x="1" y="3.5" width="14" height="10" rx="2" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8.5" r="2.5" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 3.5L6.5 1.5h3l1 2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          'photo / label' +
        '</button>' +
        '<button onclick="openPadScanInput()" style="flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:9px 10px;border-radius:9px;border:1px solid rgba(255,180,80,0.25);background:rgba(255,180,80,0.06);font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(255,180,80,0.7);cursor:pointer;touch-action:manipulation;transition:all .2s" title="scan handwritten meal notes">' +
          '<svg viewBox="0 0 16 16" width="13" height="13" fill="none"><rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.3"/><line x1="5" y1="6" x2="11" y2="6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="5" y1="9" x2="9" y2="9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>' +
          'pad scan' +
        '</button>' +
      '</div>' +
      '<input type="file" id="food-photo-input" accept="image/*" capture="environment" style="display:none" onchange="handleFoodPhoto(this)">' +
    '</div>' +

    // Meal items
    (itemsHTML ? '<div style="padding:0 18px;margin-bottom:10px">' +
      '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(180,200,220,0.6);letter-spacing:1px;text-transform:uppercase;margin-bottom:6px">' +
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
        '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(180,200,220,0.6);letter-spacing:1px;text-transform:uppercase;margin-bottom:8px">manual bolus / correction</div>' +
        '<div style="display:flex;align-items:center;gap:10px">' +
          '<div style="width:8px;height:8px;border-radius:50%;background:rgba(40,85,200,0.8);flex-shrink:0"></div>' +
          '<input id="in-i" type="number" inputmode="decimal" placeholder="units" min="0" max="20" step="0.5"' +
            ' style="flex:1;background:var(--rv-input-bg);border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:10px 12px;font-family:\'Fraunces\',serif;font-size:18px;color:rgba(220,235,250,0.9);outline:none">' +
          '<span style="font-family:\'DM Mono\',monospace;font-size:11px;color:rgba(180,200,220,0.5)">U</span>' +
          '<button onclick="commitManualBolus()" style="padding:10px 14px;border-radius:9px;border:1px solid rgba(40,85,200,0.3);background:rgba(40,85,200,0.08);font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(40,85,200,0.8);cursor:pointer">log</button>' +
        '</div>' +
      '</div>'
    : '') +

    '<div style="height:max(20px,env(safe-area-inset-bottom,20px))"></div>';
}

function buildRecentMealsHTML() {
  if (MEAL_HISTORY.length === 0) return '';
  var recent = MEAL_HISTORY.slice(0, 6);
  // Deduplicate by name — show most recent of each unique meal
  var seen = {};
  var unique = [];
  for (var j = 0; j < MEAL_HISTORY.length && unique.length < 6; j++) {
    var key = MEAL_HISTORY[j].name;
    if (!seen[key]) { seen[key] = true; unique.push({m: MEAL_HISTORY[j], i: j}); }
  }
  // Sort by time-of-day relevance — closest hour to now first
  var nowHour = new Date().getHours() + new Date().getMinutes()/60;
  unique.sort(function(a, b) {
    var aHour = a.m.t ? (new Date(a.m.t).getHours() + new Date(a.m.t).getMinutes()/60) : 12;
    var bHour = b.m.t ? (new Date(b.m.t).getHours() + new Date(b.m.t).getMinutes()/60) : 12;
    var aDiff = Math.min(Math.abs(aHour - nowHour), 24 - Math.abs(aHour - nowHour));
    var bDiff = Math.min(Math.abs(bHour - nowHour), 24 - Math.abs(bHour - nowHour));
    return aDiff - bDiff;
  });
  var chips = unique.map(function(entry) {
    var m = entry.m; var i = entry.i;
    return '<button onclick="loadMealHistory(' + i + ')" style="padding:6px 12px;border-radius:10px;' +
      'border:1px solid rgba(255,255,255,0.11);background:var(--rv-input-bg);' +
      'font-family:\'DM Mono\',monospace;font-size:10px;color:var(--rv-text-secondary);' +
      'cursor:pointer;white-space:nowrap;touch-action:manipulation">' +
      m.name.slice(0,32) + ' · ' + m.totalCarbs + 'g</button>';
  }).join('');
  return '<div style="padding:0 18px;margin-bottom:12px">' +
    '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(180,200,220,0.55);letter-spacing:1px;text-transform:uppercase;margin-bottom:6px">recent meals</div>' +
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
    results.innerHTML = '<div style="padding:10px 14px;font-family:\'DM Mono\',monospace;font-size:11px;color:rgba(180,200,220,0.5)">' +
      'not found — <button onclick="addCustomFood(\'' + q.replace(/'/g,"\\'") + '\')" style="background:none;border:none;cursor:pointer;color:rgba(40,85,200,0.7);font-family:\'DM Mono\',monospace;font-size:11px;text-decoration:underline">add custom</button></div>';
    return;
  }

  results.style.display='block';
  results.innerHTML = matches.map(function(f) {
    var giCol2 = f.gi>=70?'rgba(200,80,40,0.6)':f.gi>=55?'rgba(190,130,30,0.6)':'rgba(50,150,80,0.6)';
    return '<div onclick="addFoodItem(\'' + f.name.replace(/'/g,"\\'") + '\')" style="padding:10px 14px;cursor:pointer;' +
      'border-bottom:1px solid rgba(255,255,255,0.07);display:flex;justify-content:space-between;align-items:center">' +
      '<div>' +
        '<div style="font-family:\'DM Mono\',monospace;font-size:12px;color:rgba(220,235,250,0.9)">' + f.name + '</div>' +
        '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(62,200,140,0.65);">' + f.c100 + 'g carbs/100g</div>' +
      '</div>' +
      '<div style="font-size:10px;color:' + giCol2 + ';font-family:\'DM Mono\',monospace">GI ' + (f.gi||'—') + '</div>' +
    '</div>';
  }).join('');
}

// ── VOICE / PHOTO / URL FOOD INPUT ────────────────────────────────────────────

// ── Voice input (Web Speech API, hold-to-speak) ──
var _voiceRecog = null;
var _voiceActive = false;

function startVoiceFood(e) {
  if (e && e.preventDefault) e.preventDefault();
  var btn = document.getElementById('voice-food-btn');
  var SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    showToast('Voice input not supported on this browser');
    return;
  }
  if (_voiceActive) return;
  _voiceActive = true;
  if (btn) {
    btn.style.background = 'rgba(62,180,120,0.18)';
    btn.style.borderColor = 'rgba(62,180,120,0.5)';
    btn.style.color = 'rgba(62,200,140,0.95)';
    btn.textContent = '🎤 listening…';
  }

  var recog = new SpeechRec();
  _voiceRecog = recog;
  recog.lang = 'en-GB';
  recog.interimResults = false;
  recog.maxAlternatives = 1;
  recog.continuous = false;

  recog.onresult = function(ev) {
    var transcript = ev.results[0][0].transcript;
    _resetVoiceBtn();
    _parseSpeechToFood(transcript);
  };
  recog.onerror = function(ev) {
    _resetVoiceBtn();
    if (ev.error !== 'aborted') showToast('Could not hear that — try again');
  };
  recog.onend = function() { _resetVoiceBtn(); };
  try { recog.start(); } catch(err) { _resetVoiceBtn(); }
}

function stopVoiceFood(e) {
  if (!_voiceActive) return;
  if (_voiceRecog) { try { _voiceRecog.stop(); } catch(err) {} }
}

function _resetVoiceBtn() {
  _voiceActive = false;
  _voiceRecog = null;
  var btn = document.getElementById('voice-food-btn');
  if (!btn) return;
  btn.style.background = 'rgba(255,255,255,0.05)';
  btn.style.borderColor = 'rgba(255,255,255,0.12)';
  btn.style.color = 'rgba(180,200,220,0.6)';
  btn.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none"><rect x="5" y="1" width="6" height="9" rx="3" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 8.5a5.5 5.5 0 0010 0" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="8" y1="14" x2="8" y2="15.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg> hold to speak';
}

async function _parseSpeechToFood(transcript) {
  var searchEl = document.getElementById('food-search');
  if (searchEl) searchEl.value = '';
  showToast('Heard: "' + transcript.slice(0,60) + '"');

  // Build known recipe/dish names for context
  var knownDishes = RECIPES.map(function(r){ return r.name; }).join(', ') || 'none';
  // Build a short food library hint (first 30 items)
  var libraryHint = FOOD_DB.concat(FOOD_LIBRARY).slice(0,30).map(function(f){ return f.name; }).join(', ');

  _showFoodAIStatus('parsing meal\u2026');
  try {
    var r = await fetch('https://orange-surf-6f98.john-king-uk.workers.dev/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 700,
        system: 'You parse garbled speech-to-text meal descriptions for a UK child\'s diabetes app. Speech recognition often mangles brand names and food words — correct them phonetically (e.g. "Lindell chocolate ball" = "Lindor chocolate ball", "benecault" = "Benecol", "wild from" = "wild farm"). RULES: (1) Each food/ingredient is a SEPARATE object — never combine. A sandwich = bread + filling items as separate objects. (2) Every object needs: "name" (clean UK food name, never empty), "grams" (typical child portion estimate), and optionally "dish" (if it\'s part of a dish/sandwich, set dish:"sandwich" or dish:"recipe name"). (3) If something sounds like a known dish [' + knownDishes + '] set type:"dish" and include its likely ingredients as separate objects with dish set to the recipe name. (4) Known foods for reference: ' + libraryHint + '. (5) Return ONLY a valid JSON array. Example for "cheese sandwich and a plum": [{"name":"bread","grams":60,"dish":"sandwich"},{"name":"cheddar cheese","grams":30,"dish":"sandwich"},{"name":"plum","grams":80}]',
        messages: [{ role: 'user', content: 'Parse into individual food items, correcting any speech recognition errors: "' + transcript + '"' }]
      })
    });
    if (!r.ok) {
      var errBody = await r.text().catch(function(){ return ''; });
      throw new Error('API ' + r.status + ': ' + errBody.slice(0,120));
    }
    var data = await r.json();
    var text = ((data.content||[])[0]||{}).text || '[]';
    var clean = text.replace(/```json|```/g,'').trim();
    var fb = clean.indexOf('['), lb = clean.lastIndexOf(']');
    if (fb < 0 || lb < 0) throw new Error('No JSON array');
    var items = JSON.parse(clean.slice(fb, lb+1));
    // Sanitise
    items = items.filter(function(it){ return it && it.name && String(it.name).trim().length > 0; });
    items = items.map(function(it){
      var n = String(it.name).trim().replace(/^(a |an |some )\s*/i, '');
      n = n.charAt(0).toUpperCase() + n.slice(1);
      return { name: n, grams: Math.max(1, Math.round(Number(it.grams)||100)), dish: it.dish||null };
    });
    _hideFoodAIStatus();
    console.log('[voice] raw response text:', text.slice(0,300));
    console.log('[voice] parsed items:', JSON.stringify(items));
    if (!items.length) {
      _showVoicePanel(
        '<div onclick="_closeVoicePanel()" style="padding:18px;font-family:\'DM Mono\',monospace;font-size:11px;color:rgba(220,200,160,0.8)">' +
        '<div style="font-size:9px;color:rgba(62,200,140,0.7);margin-bottom:8px">heard · nothing matched</div>' +
        '&ldquo;' + transcript.slice(0,120) + '&rdquo;' +
        '<div style="font-size:9px;color:rgba(130,160,220,0.55);margin-top:8px">tap to dismiss</div>' +
        '</div>'
      );
      return;
    }
    _showVoiceResults(items, transcript);
  } catch(err) {
    console.warn('[voice food] parse error:', err);
    var errMsg = err && err.message ? err.message : String(err);
    _showVoicePanel(
      '<div onclick="_closeVoicePanel()" style="padding:18px 18px 24px;font-family:\'DM Mono\',monospace">' +
        '<div style="font-size:10px;color:rgba(62,200,140,0.7);letter-spacing:.8px;text-transform:uppercase;margin-bottom:10px">heard · could not parse</div>' +
        '<div style="font-size:11px;color:rgba(220,200,160,0.8);margin-bottom:10px;word-break:break-all">"' + transcript.slice(0,120) + '"</div>' +
        '<div style="font-size:9px;color:rgba(200,80,60,0.7);margin-bottom:14px">error: ' + errMsg + '</div>' +
        '<div style="font-size:9px;color:rgba(130,160,220,0.55)">tap to dismiss · search manually</div>' +
      '</div>'
    );
    if (searchEl) searchEl.value = transcript;
  }
}

// ── Fixed voice results panel (position:fixed, not clipped by sheet overflow) ──

function _showVoicePanel(html) {
  // Inject spin animation if needed
  if (!document.getElementById('spin-style')) {
    var s = document.createElement('style');
    s.id = 'spin-style';
    s.textContent = '@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}';
    document.head.appendChild(s);
  }
  // Always destroy and recreate — avoids transition state issues on reuse
  var old = document.getElementById('voice-results-panel');
  if (old) old.parentNode.removeChild(old);
  var panel = document.createElement('div');
  panel.id = 'voice-results-panel';
  panel.style.cssText = [
    'position:fixed',
    'left:0','right:0','bottom:0',
    'z-index:9999',
    'background:rgba(14,20,38,0.98)',
    'border-top:1px solid rgba(255,255,255,0.10)',
    'border-radius:18px 18px 0 0',
    'max-height:62vh',
    'overflow-y:auto',
    'box-shadow:0 -8px 40px rgba(0,0,0,0.5)',
    'transform:translateY(100%)',
    '-webkit-overflow-scrolling:touch'
  ].join(';');
  panel.innerHTML = html;
  document.body.appendChild(panel);
  // Frame delay ensures element is painted before transition starts
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      panel.style.transition = 'transform .25s cubic-bezier(.4,0,.2,1)';
      panel.style.transform = 'translateY(0)';
    });
  });
}

function _closeVoicePanel() {
  var panel = document.getElementById('voice-results-panel');
  if (!panel) return;
  panel.style.transform = 'translateY(100%)';
  setTimeout(function() { if (panel) panel.style.display = 'none'; }, 280);
}

function _showVoiceResults(items, transcript) {
  var all2 = FOOD_DB.concat(FOOD_LIBRARY);

  // Group items by dish
  var dishes = {};   // dishName -> [items]
  var standalone = [];
  items.forEach(function(item) {
    if (item.dish) {
      if (!dishes[item.dish]) dishes[item.dish] = [];
      dishes[item.dish].push(item);
    } else {
      standalone.push(item);
    }
  });

  function matchFood(name) {
    var ql = name.toLowerCase();
    for (var i = 0; i < all2.length; i++) {
      var fn = all2[i].name.toLowerCase();
      if (fn.indexOf(ql) >= 0 || ql.indexOf(fn) >= 0) return all2[i];
    }
    return null;
  }

  function itemRow(item, indent) {
    if (!item || !item.name) return '';
    var matched = matchFood(item.name);
    var carbs   = matched ? Math.round(matched.c100 * item.grams / 100 * 10) / 10 : null;
    var giCol   = matched ? (matched.gi >= 70 ? 'rgba(200,80,40,0.7)' : matched.gi >= 55 ? 'rgba(190,130,30,0.7)' : 'rgba(50,150,80,0.7)') : 'rgba(130,150,180,0.5)';
    var safeName = matched ? matched.name : item.name;
    var encName  = encodeURIComponent(safeName);
    var pad      = indent ? 'padding:8px 14px 8px 28px' : 'padding:10px 16px';

    if (matched) {
      return '<div onclick="_closeVoicePanel();addFoodItemGrams(decodeURIComponent(\'' + encName + '\'),' + item.grams + ')" style="' + pad + ';cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;justify-content:space-between;align-items:center;touch-action:manipulation">' +
        '<div>' +
          '<div style="font-family:\'DM Mono\',monospace;font-size:12px;color:rgba(220,235,250,0.9)">' + item.name + '</div>' +
          '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(62,200,140,0.65)">' + item.grams + 'g · ' + carbs + 'g carbs</div>' +
        '</div>' +
        '<div style="font-size:10px;color:' + giCol + ';font-family:\'DM Mono\',monospace">GI ' + (matched.gi || '—') + '</div>' +
      '</div>';
    } else {
      // Unmatched: add to sheet with 0 carbs flagged — user edits inline
      var encRaw = encodeURIComponent(item.name);
      return '<div onclick="_closeVoicePanel();_addUnknownFoodToSheet(decodeURIComponent(\'' + encRaw + '\'),' + item.grams + ')" style="' + pad + ';cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;justify-content:space-between;align-items:center;touch-action:manipulation">' +
        '<div>' +
          '<div style="font-family:\'DM Mono\',monospace;font-size:12px;color:rgba(200,210,240,0.8)">' + item.name + '</div>' +
          '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(220,160,60,0.7)">' + item.grams + 'g · carbs unknown — tap then edit</div>' +
        '</div>' +
        '<div style="font-size:9px;color:rgba(220,160,60,0.6);font-family:\'DM Mono\',monospace;border:1px solid rgba(220,160,60,0.25);border-radius:5px;padding:2px 6px">? carbs</div>' +
      '</div>';
    }
  }

  var shortTranscript = transcript.length > 55 ? transcript.slice(0,52) + '…' : transcript;

  var html = '' +
    // Drag handle / close
    '<div onclick="_closeVoicePanel()" style="padding:10px 16px 6px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.07);cursor:pointer">' +
      '<div style="width:36px;height:4px;border-radius:2px;background:rgba(255,255,255,0.18);margin:0 auto 0 0"></div>' +
      '<div style="font-family:\'DM Mono\',monospace;font-size:8px;color:rgba(120,140,180,0.55);letter-spacing:.5px;text-align:right;max-width:75%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + shortTranscript + '</div>' +
    '</div>' +
    '<div style="padding:7px 16px 5px;font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(62,200,140,0.7);letter-spacing:.8px;text-transform:uppercase;border-bottom:1px solid rgba(255,255,255,0.06)">heard · tap item to add</div>';

  // Dish groups — collapsible header + indented items
  Object.keys(dishes).forEach(function(dishName) {
    var dishItems = dishes[dishName];
    var dishId    = 'vd-' + dishName.replace(/\s+/g,'-').toLowerCase();
    var dishCarbs = dishItems.reduce(function(s, it) {
      var m = matchFood(it.name);
      return s + (m ? Math.round(m.c100 * it.grams / 100 * 10) / 10 : 0);
    }, 0);
    var encDishItems = encodeURIComponent(JSON.stringify(dishItems));
    // Dish header
    html += '<div style="padding:9px 16px;background:var(--rv-input-bg);border-bottom:1px solid rgba(255,255,255,0.07);display:flex;justify-content:space-between;align-items:center;cursor:pointer;touch-action:manipulation" onclick="var s=document.getElementById(\'' + dishId + '\');s.style.display=s.style.display===\'none\'?\'block\':\'none\'">' +
      '<div>' +
        '<div style="font-family:\'DM Mono\',monospace;font-size:11px;color:rgba(220,235,250,0.8)">◈ ' + dishName + '</div>' +
        '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(180,200,220,0.5)">' + dishItems.length + ' ingredients · ~' + dishCarbs.toFixed(0) + 'g carbs</div>' +
      '</div>' +
      '<button onclick="event.stopPropagation();_addAllVoiceItems(JSON.parse(decodeURIComponent(\'' + encDishItems + '\')))" style="font-family:\'DM Mono\',monospace;font-size:9px;padding:5px 10px;border-radius:6px;border:1px solid rgba(62,180,120,0.3);background:rgba(62,180,120,0.1);color:rgba(62,200,140,0.85);cursor:pointer;touch-action:manipulation">add all</button>' +
    '</div>';
    // Dish ingredients (expanded by default)
    html += '<div id="' + dishId + '" style="display:block">';
    dishItems.forEach(function(item) { html += itemRow(item, true); });
    html += '</div>';
  });

  // Standalone items
  standalone.forEach(function(item) { html += itemRow(item, false); });

  // "Add all matched" footer if 2+ matched standalone items
  var matchedStandalone = standalone.filter(function(it) { return it && it.name && matchFood(it.name); });
  if (matchedStandalone.length > 1) {
    var encAll = encodeURIComponent(JSON.stringify(matchedStandalone));
    html += '<div onclick="_addAllVoiceItems(JSON.parse(decodeURIComponent(\'' + encAll + '\')))" style="padding:12px 16px;cursor:pointer;background:rgba(62,180,120,0.07);border-top:1px solid rgba(62,180,120,0.15);display:flex;justify-content:space-between;align-items:center;touch-action:manipulation">' +
      '<div style="font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(62,200,140,0.85)">add all ' + matchedStandalone.length + ' matched items</div>' +
      '<div style="font-size:18px;color:rgba(62,180,120,0.7)">＋</div>' +
    '</div>';
  }

  // Bottom safe-area padding
  html += '<div style="height:env(safe-area-inset-bottom,16px)"></div>';

  _showVoicePanel(html);
}

function _addAllVoiceItems(items) {
  var all2 = FOOD_DB.concat(FOOD_LIBRARY);
  items.forEach(function(item) {
    if (!item || !item.name) return;
    var ql3 = item.name.toLowerCase();
    var matched = null;
    for (var i = 0; i < all2.length; i++) {
      var fn = all2[i].name.toLowerCase();
      if (fn.indexOf(ql3) >= 0 || ql3.indexOf(fn) >= 0) { matched = all2[i]; break; }
    }
    if (matched) {
      var carbs3 = Math.round(matched.c100 * item.grams / 100 * 10) / 10;
      _mealItems.push({food: matched, grams: item.grams, carbs: carbs3});
    }
  });
  _closeVoicePanel();
  var _b = document.getElementById('in-bolus'); if (_b && _b.value !== '') _bolusVal = _b.value;
  var fs = document.getElementById('food-search'); if (fs) fs.value = '';
  var fr = document.getElementById('food-results'); if (fr) fr.style.display = 'none';
  renderSheet();
}

// Add food item with a specific gram weight (used by voice results)
// Add an unrecognised voice item directly to the sheet with 0 carbs so user can edit inline
function _addUnknownFoodToSheet(name, grams) {
  var phantom = { name: name, c100: 0, gi: 55, g_serv: grams, g_each: grams, kcal: 0, prot: 0, fat: 0, fibre: 0 };
  _mealItems.push({ food: phantom, grams: grams, carbs: 0 });
  var _b = document.getElementById('in-bolus'); if (_b && _b.value !== '') _bolusVal = _b.value;
  var fs = document.getElementById('food-search'); if (fs) fs.value = '';
  var fr = document.getElementById('food-results'); if (fr) fr.style.display = 'none';
  renderSheet();
  // Brief toast nudging user to edit the carb value
  showToast(name + ' added — edit carbs');
}

function addFoodItemGrams(name, grams) {
  var all   = FOOD_DB.concat(FOOD_LIBRARY);
  var food  = null;
  for (var i=0; i<all.length; i++) { if (all[i].name === name) { food = all[i]; break; } }
  if (!food) return;
  var carbs = Math.round((food.c100 * grams / 100) * 10) / 10;
  _mealItems.push({food: food, grams: grams, carbs: carbs});
  var _b = document.getElementById('in-bolus'); if (_b && _b.value !== '') _bolusVal = _b.value;
  document.getElementById('food-search').value = '';
  document.getElementById('food-results').style.display = 'none';
  renderSheet();
}

// ── Status indicator for AI food operations ──
function _showFoodAIStatus(msg) {
  // Use the fixed voice panel so it's never clipped by sheet overflow
  _showVoicePanel(
    '<div style="padding:20px 18px;font-family:\'DM Mono\',monospace;font-size:11px;color:rgba(62,200,140,0.7);letter-spacing:.5px;display:flex;align-items:center;gap:10px">' +
    '<span style="display:inline-block;animation:spin 1s linear infinite;font-size:16px">◌</span>' +
    '<span>' + msg + '</span></div>'
  );
}

function _hideFoodAIStatus() {
  _closeVoicePanel();
}

// ── Photo / nutrition label input ──
function openPhotoFood() {
  var input = document.getElementById('food-photo-input');
  if (input) input.click();
}

async function handleFoodPhoto(inputEl) {
  var file = inputEl.files && inputEl.files[0];
  if (!file) return;
  inputEl.value = ''; // reset so same file can be picked again

  _showFoodAIStatus('reading label…');

  try {
    var base64 = await new Promise(function(res, rej) {
      var r = new FileReader();
      r.onload = function() { res(r.result.split(',')[1]); };
      r.onerror = function() { rej(new Error('Read failed')); };
      r.readAsDataURL(file);
    });

    var mediaType = file.type || 'image/jpeg';
    var r = await fetch('https://orange-surf-6f98.john-king-uk.workers.dev/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 400,
        system: 'You extract nutritional information from food packaging photos and nutrition labels. Return ONLY a JSON object, no markdown, no explanation. Fields: {"name": "product name", "c100": carbs_per_100g_as_number, "gi": estimated_gi_as_number_or_null, "g_serv": serving_size_grams_as_number_or_null, "sugar": sugars_per_100g_as_number_or_null}. Use the "Carbohydrate" or "Total Carbohydrate" row (not "of which sugars" for c100). Estimate GI from the food type if not shown: white bread ~75, wholemeal ~55, pasta ~48, biscuits ~70, oats ~55, fruit ~45. If image is not a food label, return {"error": "not a label"}.',
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: 'Extract nutritional info from this food label.' }
          ]
        }]
      })
    });
    if (!r.ok) throw new Error('API ' + r.status);
    var data = await r.json();
    var text = ((data.content||[])[0]||{}).text || '{}';
    var clean = text.replace(/```json|```/g,'').trim();
    var firstBrace = clean.indexOf('{');
    var lastBrace = clean.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace < 0) throw new Error('No JSON');
    var info = JSON.parse(clean.slice(firstBrace, lastBrace+1));
    _hideFoodAIStatus();

    if (info.error) { showToast('No label found — try a clearer photo'); return; }
    if (!info.name || !info.c100) { showToast('Could not read label — try again'); return; }

    // Pre-populate add food modal with extracted values
    _photoFoodData = info;
    addCustomFood(info.name);
  } catch(err) {
    _hideFoodAIStatus();
    console.warn('[photo food] error:', err);
    showToast('Could not read label — try again');
  }
}

var _photoFoodData = null; // set by handleFoodPhoto, consumed by addCustomFood

// ── URL paste detection ──
async function checkFoodPaste(val) {
  if (!val) return;
  val = val.trim();
  // Check if it looks like a URL
  if (!/^https?:\/\//i.test(val) && !/^www\./i.test(val)) return;

  var url = val.startsWith('www.') ? 'https://' + val : val;
  var searchEl = document.getElementById('food-search');
  if (searchEl) searchEl.value = '';
  _showFoodAIStatus('fetching recipe / nutrition…');

  try {
    // Fetch via Worker to avoid CORS
    var workerUrl = 'https://orange-surf-6f98.john-king-uk.workers.dev/claude';

    // First fetch the page text via a simple proxy approach —
    // We ask Claude to use its knowledge about the URL domain to estimate,
    // but actually fetch the page via the worker's URL proxy endpoint
    var pageResp = await fetch('https://orange-surf-6f98.john-king-uk.workers.dev/?url=' + encodeURIComponent(url), {
      method: 'GET',
      headers: { 'Accept': 'text/html,text/plain' }
    });
    var pageText = '';
    if (pageResp.ok) {
      pageText = (await pageResp.text()).slice(0, 8000); // cap to avoid token explosion
    }

    // Now ask Claude to extract ingredients
    var r = await fetch(workerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 600,
        system: 'You extract recipe ingredients or nutritional info from webpage text. Return ONLY a JSON array, no markdown. Each item: {"name": "food name", "c100": carbs_per_100g_as_number, "gi": estimated_gi_or_null, "g_serv": typical_serving_grams_or_null}. If the page contains a recipe, extract the main ingredients with estimated carb content per 100g. If it contains a single product with nutrition info, return a single-item array. If you cannot extract any food data, return []. Use common UK food names.',
        messages: [{ role: 'user', content: 'URL: ' + url + '\n\nPage content:\n' + (pageText || '(could not fetch page)') + '\n\nExtract food/nutrition data.' }]
      })
    });
    if (!r.ok) throw new Error('API ' + r.status);
    var data = await r.json();
    var text = ((data.content||[])[0]||{}).text || '[]';
    var clean2 = text.replace(/```json|```/g,'').trim();
    var fb = clean2.indexOf('['); var lb = clean2.lastIndexOf(']');
    if (fb < 0 || lb < 0) throw new Error('No array');
    var items = JSON.parse(clean2.slice(fb, lb+1));
    _hideFoodAIStatus();

    if (!items.length) { showToast('No food data found at that URL'); return; }

    // Add each new food to library and show tappable results
    var results = document.getElementById('food-results');
    if (!results) return;
    var html = '<div style="padding:8px 12px 4px;font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(130,160,220,0.7);letter-spacing:.8px;text-transform:uppercase">from url · tap to add</div>';
    items.forEach(function(item) {
      if (!item.name || !item.c100) return;
      var giEst = item.gi || 55;
      var gServ = item.g_serv || 100;
      var carbsServ = Math.round(item.c100 * gServ / 100 * 10) / 10;
      html += '<div onclick="addUrlFoodItem(' + JSON.stringify(item).replace(/'/g,"\\'") + ')" style="padding:10px 14px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.07);display:flex;justify-content:space-between;align-items:center">' +
        '<div>' +
          '<div style="font-family:\'DM Mono\',monospace;font-size:12px;color:rgba(220,235,250,0.9)">' + item.name + '</div>' +
          '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(62,200,140,0.65)">' + item.c100 + 'g carbs/100g · serv ' + gServ + 'g</div>' +
        '</div>' +
        '<div style="font-size:10px;color:rgba(130,160,220,0.6);font-family:\'DM Mono\',monospace">GI ' + giEst + '</div>' +
      '</div>';
    });
    results.innerHTML = html;
    results.style.display = 'block';
  } catch(err) {
    _hideFoodAIStatus();
    console.warn('[url food] error:', err);
    showToast('Could not read that URL');
  }
}

function addUrlFoodItem(item) {
  // Save to library if not already present
  var all = FOOD_DB.concat(FOOD_LIBRARY);
  var existing = all.filter(function(f){ return f.name === item.name; })[0];
  if (!existing) {
    var newFood = { name: item.name, c100: item.c100, gi: item.gi || 55, g_serv: item.g_serv || 100 };
    FOOD_LIBRARY.push(newFood);
    try { localStorage.setItem('river_food_lib', JSON.stringify(FOOD_LIBRARY)); } catch(e) {}
  }
  // Add to meal
  addFoodItemGrams(item.name, item.g_serv || 100);
}

function addFoodItem(name) {
  var all   = FOOD_DB.concat(FOOD_LIBRARY);
  var food  = null;
  for (var i=0; i<all.length; i++) { if (all[i].name === name) { food = all[i]; break; } }
  if (!food) return;
  var defaultG = food.g_each || food.g_serv || 100;
  var carbs    = Math.round((food.c100 * defaultG / 100) * 10) / 10;
  _mealItems.push({food: food, grams: defaultG, carbs: carbs});
  var _b = document.getElementById('in-bolus'); if (_b && _b.value !== '') _bolusVal = _b.value;
  document.getElementById('food-search').value = '';
  document.getElementById('food-results').style.display = 'none';
  renderSheet();
}

// ── ADD FOOD MODAL ────────────────────────────────────────────────────────────
// GI hints keyed on food name (shared between addCustomFood and calcGIFromCarbs)
var _giHints = [
  {words:['white','bread','baguette','roll','naan','pitta','wrap','toast'], gi:75},
  {words:['brown','wholemeal','rye','sourdough'], gi:55},
  {words:['rice'], gi:64},
  {words:['pasta','noodle','spaghetti','macaroni'], gi:48},
  {words:['potato','chips','fries','parsnip'], gi:78},
  {words:['sweet potato'], gi:44},
  {words:['oat','porridge'], gi:55},
  {words:['banana'], gi:52},
  {words:['apple','pear','berry'], gi:36},
  {words:['orange','mango','grape'], gi:52},
  {words:['milk','yoghurt','yogurt'], gi:36},
  {words:['juice'], gi:65},
  {words:['cola','fizzy','lucozade','sports'], gi:65},
  {words:['chocolate'], gi:40},
  {words:['biscuit','cookie','cake','donut'], gi:65},
  {words:['cereal','cornflake','weetabix'], gi:72},
  {words:['bean','lentil','chickpea'], gi:30},
  {words:['glucose','dextrose','jelly','gummy','gummie','vitamin','supplement'], gi:95},
  {words:['honey','jam','syrup'], gi:65},
  {words:['meat','chicken','beef','fish','egg','cheese','butter','oil','cream','bacon'], gi:0},
];

// Auto-estimate GI from carb density + serving size ratio.
// Rationale: pure sugar = 100g carbs per 100g = GI ~95. Starchy carbs = 60-80g/100g = GI ~55-75.
// Low density (20-40g/100g) with fibre-rich foods = GI ~30-50.
// Serving size helps refine: very small servings of dense carbs (jelly babies) = fast.
function calcGIFromCarbs(c100, gServ, nameLower) {
  // 1. Name-based hint (most reliable if matched)
  for (var i = 0; i < _giHints.length; i++) {
    if (_giHints[i].words.some(function(w){ return nameLower.indexOf(w) >= 0; })) {
      return _giHints[i].gi;
    }
  }
  // 2. Density-based estimate
  if (c100 <= 0) return 0;
  if (c100 >= 90) return 95;    // almost pure sugar / glucose
  if (c100 >= 70) return 78;    // very high density — refined starches, sweets
  if (c100 >= 50) return 65;    // moderate-high — white bread territory
  if (c100 >= 30) return 52;    // moderate — mixed carbs
  if (c100 >= 15) return 40;    // lower density — legumes, dairy, chocolate territory
  return 30;                    // low density — mostly protein/fat with some carbs
}

// Narrative descriptions for GI — explains the curve shape in plain language
function giNarrative(gi, c100) {
  if (c100 <= 0) return { text: 'no carbs — will not affect the flow', col: 'rgba(120,140,160,0.5)', peak: null };
  if (gi >= 90) return {
    text: '⚡ almost pure sugar — peak in ~15 min, sharp spike then rapid fall. Ideal for hypo treatment.',
    col: 'rgba(255,80,40,0.85)',
    peak: 15
  };
  if (gi >= 70) return {
    text: '↑ fast carbs — peak around 20–30 min. Bolus at the same time or slightly after eating.',
    col: 'rgba(220,120,40,0.85)',
    peak: 25
  };
  if (gi >= 55) return {
    text: '→ medium speed — peak around 35–50 min. Bolus 10–15 min before eating.',
    col: 'rgba(200,160,40,0.8)',
    peak: 45
  };
  if (gi >= 30) return {
    text: '↓ slow release — peak around 50–70 min. Bolus 20–30 min before, watch for late rise.',
    col: 'rgba(80,180,120,0.8)',
    peak: 60
  };
  return {
    text: '↓↓ very slow — minimal glucose impact. May need less insulin than carb count suggests.',
    col: 'rgba(60,160,100,0.7)',
    peak: 75
  };
}

// Track which input mode is active: 'per100' or 'perServing'
var _addFoodMode = 'per100';

function addCustomFood(name) {
  var ex = document.getElementById('food-add-overlay');
  if (ex) ex.remove();
  _addFoodMode = 'per100';

  var lname = name.toLowerCase();
  var suggestGI = calcGIFromCarbs(0, 0, lname); // name-based hint first

  var el = document.createElement('div');
  el.id = 'food-add-overlay';
  el.style.cssText = 'position:fixed;inset:0;z-index:80;background:var(--rv-panel-bg);backdrop-filter:blur(14px);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;transition:opacity .2s;opacity:0;overflow-y:auto;-webkit-overflow-scrolling:touch';

  function inp(id, type, placeholder, min, max, step, val, extraStyle) {
    var i = document.createElement('input');
    i.id = id; i.type = type; i.placeholder = placeholder;
    if (min !== null) i.min = min;
    if (max !== null) i.max = max;
    if (step) i.step = step;
    if (val !== undefined && val !== null) i.value = val;
    i.setAttribute('inputmode', 'decimal');
    i.setAttribute('oninput', 'updateAddFoodPreview()');
    i.style.cssText = 'width:100%;padding:11px 14px;border-radius:9px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.08);font-family:monospace;font-size:15px;color:var(--rv-text-primary);text-align:center;outline:none;box-sizing:border-box;' + (extraStyle||'');
    return i;
  }

  function lbl(text, sub) {
    var d = document.createElement('div');
    d.style.cssText = 'font-family:monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase;color:var(--rv-text-secondary);margin-bottom:6px';
    d.textContent = text;
    if (sub) {
      var s = document.createElement('span');
      s.style.cssText = 'opacity:0.55;font-size:8px;margin-left:6px;text-transform:none;letter-spacing:0';
      s.textContent = sub;
      d.appendChild(s);
    }
    return d;
  }

  var wrap = document.createElement('div');
  wrap.style.cssText = 'max-width:320px;width:100%';

  // Title
  var title = document.createElement('div');
  title.style.cssText = "font-family:'Fraunces',serif;font-style:italic;font-weight:200;font-size:22px;color:rgba(180,220,200,0.95);margin-bottom:3px";
  title.textContent = 'add food';
  wrap.appendChild(title);

  var sub = document.createElement('div');
  sub.style.cssText = 'font-family:monospace;font-size:12px;color:rgba(100,200,160,0.6);margin-bottom:20px';
  sub.textContent = name;
  wrap.appendChild(sub);

  // ── Toggle: carbs per 100g / carbs per serving ──────────────────
  var toggleWrap = document.createElement('div');
  toggleWrap.style.cssText = 'display:flex;gap:0;margin-bottom:16px;border-radius:10px;overflow:hidden;border:1px solid rgba(62,180,120,0.25)';

  function makeToggleBtn(label, mode) {
    var b = document.createElement('button');
    b.id = 'toggle-' + mode;
    b.textContent = label;
    b.style.cssText = 'flex:1;padding:9px 0;border:none;cursor:pointer;font-family:monospace;font-size:10px;letter-spacing:0.5px;text-transform:uppercase;transition:background .15s, color .15s;touch-action:manipulation';
    b.onclick = function() {
      _addFoodMode = mode;
      updateToggleState();
      updateAddFoodPreview();
    };
    return b;
  }
  var btn100  = makeToggleBtn('per 100g', 'per100');
  var btnServ = makeToggleBtn('per serving', 'perServing');
  toggleWrap.appendChild(btn100);
  toggleWrap.appendChild(btnServ);
  wrap.appendChild(toggleWrap);

  function updateToggleState() {
    var is100 = _addFoodMode === 'per100';
    btn100.style.background  = is100  ? 'rgba(62,180,120,0.18)' : 'transparent';
    btn100.style.color       = is100  ? 'rgba(100,220,160,0.95)' : 'rgba(180,200,220,0.45)';
    btnServ.style.background = !is100 ? 'rgba(62,180,120,0.18)' : 'transparent';
    btnServ.style.color      = !is100 ? 'rgba(100,220,160,0.95)' : 'rgba(180,200,220,0.45)';
    // Show/hide relevant inputs
    var c100Row = document.getElementById('new-food-c100-row');
    var cServRow = document.getElementById('new-food-cserv-row');
    if (c100Row) c100Row.style.display = is100 ? '' : 'none';
    if (cServRow) cServRow.style.display = !is100 ? '' : 'none';
  }

  // Carbs per 100g input
  var c100Row = document.createElement('div');
  c100Row.id = 'new-food-c100-row';
  c100Row.style.marginBottom = '14px';
  c100Row.appendChild(lbl('carbs per 100g', '· 0 for meat, eggs, cheese'));
  var carbInp = inp('new-food-c100', 'number', 'e.g. 28', 0, 100, '0.1', null, 'border-color:rgba(62,180,120,0.5);color:rgba(100,220,160,0.95);background:rgba(62,180,120,0.08)');
  c100Row.appendChild(carbInp);
  wrap.appendChild(c100Row);

  // Carbs per serving input
  var cServRow = document.createElement('div');
  cServRow.id = 'new-food-cserv-row';
  cServRow.style.cssText = 'margin-bottom:14px;display:none';
  cServRow.appendChild(lbl('carbs per serving (g)'));
  var cServInp = inp('new-food-cserv', 'number', 'e.g. 25', 0, 300, '0.1', null, 'border-color:rgba(62,180,120,0.5);color:rgba(100,220,160,0.95);background:rgba(62,180,120,0.08)');
  cServRow.appendChild(cServInp);
  wrap.appendChild(cServRow);

  // Serving sizes row — always visible
  var servRow = document.createElement('div');
  servRow.style.cssText = 'display:flex;gap:10px;margin-bottom:14px';
  var servDiv = document.createElement('div'); servDiv.style.flex = '1';
  servDiv.appendChild(lbl('serving size (g)'));
  servDiv.appendChild(inp('new-food-g_serv', 'number', 'e.g. 30', 0, 2000, '1', null, ''));
  var eachDiv = document.createElement('div'); eachDiv.style.flex = '1';
  eachDiv.appendChild(lbl('weight each (g)'));
  eachDiv.appendChild(inp('new-food-g_each', 'number', 'e.g. 2', 0, 1000, '0.1', null, ''));
  servRow.appendChild(servDiv);
  servRow.appendChild(eachDiv);
  wrap.appendChild(servRow);

  // ── Auto-calc GI section ──────────────────────────────────────────
  var giSection = document.createElement('div');
  giSection.style.cssText = 'margin-bottom:6px';

  var giHeader = document.createElement('div');
  giHeader.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px';

  var giLblEl = document.createElement('div');
  giLblEl.style.cssText = 'font-family:monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase;color:var(--rv-text-secondary)';
  giLblEl.textContent = 'glycaemic index';
  giHeader.appendChild(giLblEl);

  var giCalcBadge = document.createElement('div');
  giCalcBadge.id = 'new-food-gi-badge';
  giCalcBadge.style.cssText = 'font-family:monospace;font-size:8px;color:rgba(200,160,60,0.5);letter-spacing:0.5px';
  giCalcBadge.textContent = 'calculated';
  giHeader.appendChild(giCalcBadge);

  giSection.appendChild(giHeader);

  var giInp = inp('new-food-gi', 'number', '0–100', 0, 100, '1', suggestGI || 55,
    'border-color:rgba(200,160,60,0.5);color:rgba(220,180,80,0.95);background:rgba(200,160,60,0.07)');
  // Mark manually edited
  giInp.addEventListener('input', function() {
    var badge = document.getElementById('new-food-gi-badge');
    if (badge) { badge.textContent = 'edited'; badge.style.color = 'rgba(220,180,80,0.7)'; }
  });
  giSection.appendChild(giInp);

  // GI narrative
  var giNote = document.createElement('div');
  giNote.id = 'new-food-gi-note';
  giNote.style.cssText = 'font-family:monospace;font-size:9px;margin-top:8px;line-height:1.7;color:rgba(200,160,60,0.8);min-height:36px';
  giSection.appendChild(giNote);

  wrap.appendChild(giSection);

  // Curve preview — tiny sparkline showing absorption shape
  var curveWrap = document.createElement('div');
  curveWrap.style.cssText = 'margin-bottom:16px;border-radius:8px;border:1px solid var(--rv-panel-border);background:rgba(255,255,255,0.02);padding:10px 12px';
  var curveCanvas = document.createElement('canvas');
  curveCanvas.id = 'new-food-curve';
  curveCanvas.width = 276;
  curveCanvas.height = 44;
  curveCanvas.style.cssText = 'width:100%;height:44px;display:block';
  curveWrap.appendChild(curveCanvas);
  wrap.appendChild(curveWrap);

  // Preview summary line
  var preview = document.createElement('div');
  preview.id = 'new-food-preview';
  preview.style.cssText = 'font-family:monospace;font-size:10px;color:rgba(100,200,160,0.8);text-align:center;margin-bottom:16px;min-height:16px';
  wrap.appendChild(preview);

  // Buttons
  var btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px';

  var saveBtn = document.createElement('button');
  saveBtn.style.cssText = "flex:1;padding:13px;border-radius:10px;border:1px solid rgba(62,180,120,0.4);background:rgba(62,180,120,0.12);font-family:'Fraunces',serif;font-style:italic;font-weight:200;font-size:17px;color:rgba(100,220,160,0.95);cursor:pointer";
  saveBtn.textContent = 'save + add';
  saveBtn.onclick = function() { saveCustomFood(encodeURIComponent(name)); };

  var cancelBtn = document.createElement('button');
  cancelBtn.style.cssText = 'padding:13px 16px;border-radius:10px;border:1px solid rgba(255,255,255,0.15);background:transparent;font-family:monospace;font-size:10px;color:rgba(255,255,255,0.5);cursor:pointer';
  cancelBtn.textContent = 'cancel';
  cancelBtn.onclick = function() { el.remove(); };

  btnRow.appendChild(saveBtn);
  btnRow.appendChild(cancelBtn);
  wrap.appendChild(btnRow);

  el.appendChild(wrap);
  el.addEventListener('click', function(e){ if(e.target===el) el.remove(); });
  el.addEventListener('keydown', function(e){ if(e.key==='Escape') el.remove(); });
  document.body.appendChild(el);
  requestAnimationFrame(function(){ el.style.opacity='1'; });

  // Pre-fill from photo data if available
  if (_photoFoodData) {
    var pfd = _photoFoodData;
    _photoFoodData = null;
    setTimeout(function() {
      if (pfd.c100 !== undefined) { var c100el = document.getElementById('new-food-c100'); if (c100el) c100el.value = pfd.c100; }
      if (pfd.gi)   { var giel  = document.getElementById('new-food-gi');   if (giel)  { giel.value = pfd.gi; var badge = document.getElementById('new-food-gi-badge'); if (badge) { badge.textContent = 'from label'; badge.style.color = 'rgba(62,200,140,0.7)'; } } }
      if (pfd.g_serv) { var gsel = document.getElementById('new-food-g_serv'); if (gsel) gsel.value = pfd.g_serv; }
      // Add photo banner
      var banner = document.createElement('div');
      banner.style.cssText = 'font-family:monospace;font-size:9px;color:rgba(62,200,140,0.7);letter-spacing:.5px;text-align:center;margin-bottom:12px;padding:6px 10px;border-radius:7px;background:rgba(62,180,120,0.08);border:1px solid rgba(62,180,120,0.2)';
      banner.textContent = '📷 pre-filled from label — check and save';
      wrap.insertBefore(banner, sub.nextSibling);
      updateAddFoodPreview();
    }, 50);
  }

  // Init toggle state and run initial preview
  updateToggleState();
  setTimeout(function(){
    carbInp.focus();
    updateAddFoodPreview();
  }, 300);
}

function _drawCurvePreview(gi, c100) {
  var canvas = document.getElementById('new-food-curve');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (c100 <= 0 || gi <= 0) return;

  // Absorption curve: peaks at peakMin, width based on GI
  var peakMin = gi >= 90 ? 15 : gi >= 70 ? 25 : gi >= 55 ? 42 : gi >= 30 ? 58 : 70;
  var sigma   = gi >= 90 ? 10 : gi >= 70 ? 18 : gi >= 55 ? 28 : gi >= 30 ? 38 : 45;
  var maxT    = peakMin + sigma * 2.5;
  var col     = gi >= 90 ? [255, 80, 40] : gi >= 70 ? [220, 120, 40] : gi >= 55 ? [200, 160, 40] : [80, 180, 120];

  // Build points
  var pts = [];
  for (var i = 0; i <= 60; i++) {
    var t = (i / 60) * maxT;
    var v = Math.exp(-0.5 * Math.pow((t - peakMin) / sigma, 2));
    pts.push({ x: (i / 60) * W, y: H - 4 - v * (H - 10) });
  }

  // Fill
  var gr = ctx.createLinearGradient(0, 0, 0, H);
  gr.addColorStop(0,   'rgba(' + col + ',0.25)');
  gr.addColorStop(0.6, 'rgba(' + col + ',0.08)');
  gr.addColorStop(1,   'rgba(' + col + ',0)');
  ctx.beginPath();
  ctx.moveTo(0, H);
  pts.forEach(function(p){ ctx.lineTo(p.x, p.y); });
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fillStyle = gr;
  ctx.fill();

  // Line
  ctx.beginPath();
  pts.forEach(function(p, i){ i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y); });
  ctx.strokeStyle = 'rgba(' + col + ',0.7)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Peak label
  var peakX = (peakMin / maxT) * W;
  ctx.fillStyle = 'rgba(' + col + ',0.7)';
  ctx.font = "300 8px 'DM Mono',monospace";
  ctx.textAlign = 'center';
  ctx.fillText('peak ~' + peakMin + 'min', Math.max(30, Math.min(W - 30, peakX)), 10);
}

function updateAddFoodPreview() {
  var mode  = _addFoodMode || 'per100';
  var gServ = parseFloat((document.getElementById('new-food-g_serv')||{}).value)||0;
  var gEach = parseFloat((document.getElementById('new-food-g_each')||{}).value)||0;

  // Resolve c100 from whichever mode is active
  var c100;
  if (mode === 'per100') {
    c100 = parseFloat((document.getElementById('new-food-c100')||{}).value)||0;
    // If per-serving entered, back-calc c100 and update hidden field
    var cServEl = document.getElementById('new-food-cserv');
    if (cServEl) cServEl.value = (gServ > 0 && c100 > 0) ? (c100 * gServ / 100).toFixed(1) : '';
  } else {
    var cServ = parseFloat((document.getElementById('new-food-cserv')||{}).value)||0;
    // Back-calc c100 from serving
    c100 = (gServ > 0 && cServ > 0) ? (cServ / gServ * 100) : 0;
    var c100El = document.getElementById('new-food-c100');
    if (c100El) c100El.value = c100 > 0 ? c100.toFixed(1) : '';
  }

  // Determine GI — auto-calc unless user has manually edited
  var giBadge = document.getElementById('new-food-gi-badge');
  var giInpEl = document.getElementById('new-food-gi');
  var isEdited = giBadge && giBadge.textContent === 'edited';
  var gi;
  if (isEdited) {
    gi = parseInt((giInpEl||{}).value) || 0;
  } else {
    // Get food name from the sub div (second child of wrap)
    var overlay = document.getElementById('food-add-overlay');
    var foodName = overlay ? (overlay.querySelector('.food-name-sub') || {}).textContent || '' : '';
    gi = calcGIFromCarbs(c100, gServ, foodName.toLowerCase());
    if (giInpEl) giInpEl.value = gi;
  }

  // GI narrative
  var noteEl = document.getElementById('new-food-gi-note');
  if (noteEl) {
    var narr = giNarrative(gi, c100);
    noteEl.textContent = narr.text;
    noteEl.style.color = narr.col;
  }

  // Curve sparkline
  _drawCurvePreview(gi, c100);

  // Summary line
  var preEl = document.getElementById('new-food-preview');
  if (preEl) {
    var parts = [];
    if (c100 > 0) parts.push(c100.toFixed(1) + 'g carbs/100g');
    if (c100 > 0 && gServ > 0) parts.push('serving: ' + (c100*gServ/100).toFixed(1) + 'g');
    if (c100 > 0 && gEach > 0) parts.push('each: '    + (c100*gEach/100).toFixed(1) + 'g');
    preEl.textContent = parts.join(' · ');
  }
}

function saveCustomFood(encodedName) {
  var name  = decodeURIComponent(encodedName);
  // Always read c100 — updateAddFoodPreview keeps it in sync regardless of toggle mode
  var carbs = parseFloat((document.getElementById('new-food-c100')||{}).value) || 0;
  var gi    = parseInt((document.getElementById('new-food-gi')||{}).value) || 0;
  var gServ = parseFloat((document.getElementById('new-food-g_serv')||{}).value) || null;
  var gEach = parseFloat((document.getElementById('new-food-g_each')||{}).value) || null;
  var el    = document.getElementById('food-add-overlay');
  if (el) el.remove();
  var f = {name:name, c100:carbs, gi:gi, cat:'custom'};
  if (gServ) f.g_serv = gServ;
  if (gEach) f.g_each = gEach;
  FOOD_LIBRARY.push(f);
  saveFoodLibrary();
  addFoodItem(name);
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
  var _b = document.getElementById('in-bolus'); if (_b && _b.value !== '') _bolusVal = _b.value;
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
  // Prevent double-submit
  if (window._logMealLock) return;
  window._logMealLock = true;
  setTimeout(function(){ window._logMealLock = false; }, 2000);

  var totalCarbs = _mealItems.reduce(function(s,i){return s+i.carbs;},0);
  var t = getEntryTime();
  var u = 0;

  if (!carbsOnly) {
    var inp = document.getElementById('in-bolus');
    u = inp ? (parseFloat(inp.value) || 0) : 0;
  }

  // ── Input guardrails ──────────────────────────────────────────────
  if (totalCarbs > 300) {
    showToast('⚠️ ' + totalCarbs.toFixed(0) + 'g carbs is very high — check your entries');
    window._logMealLock = false;
    return;
  }
  if (u > 20) {
    showToast('⚠️ ' + u.toFixed(1) + 'U insulin is very high — max 20U per entry');
    window._logMealLock = false;
    return;
  }
  if (u > 15) {
    // Soft warning — allow proceed but show toast
    showToast('⚠️ ' + u.toFixed(1) + 'U logged — double-check this dose');
  }

  // Calculate avgGI first — used by suggestEatWait below
  var avgGI = _mealItems.length > 0
    ? _mealItems.reduce(function(s,i){return s+(i.food.gi||55)*i.carbs;},0) / Math.max(totalCarbs,1)
    : 55;

  // Insulin is given NOW (bolus time)
  // Carbs arrive LATER (after wait time) — but only when insulin is given
  var eatWaitNow = (u > 0)
    ? (_eatWaitOverride !== null ? _eatWaitOverride : suggestEatWait(dataAt(t).bg || 7, avgGI))
    : 0; // no insulin → no wait, log carbs at bolus time immediately
  var carbT = t + eatWaitNow * 60000; // when carbs enter the system

  // Log insulin at bolus time
  if (u > 0) {
    SESSION.push({t: t, c: 0, u: u});
    BOLUS_EVENTS.push({t: t, c: 0, u: u});
    LOGGED_EVENTS.push({t: t, c: 0, u: u, note: 'bolus', local: true});
  }

  // Log carbs at eat time — include per-food breakdown for GI-aware rendering
  var foodItems = _mealItems.map(function(i){
    return {name:i.food.name, carbs:i.carbs, gi:i.food.gi||55, g:i.grams};
  });
  if (totalCarbs > 0) {
    SESSION.push({t: carbT, c: totalCarbs, u: 0, gi: avgGI, items: foodItems});
    BOLUS_EVENTS.push({t: carbT, c: totalCarbs, u: 0, gi: avgGI, items: foodItems});
    LOGGED_EVENTS.push({t: carbT, c: totalCarbs, u: 0, gi: avgGI, items: foodItems, note: 'carbs', logged_by: _thisPersonId||'unknown', local: true});
  }

  try{localStorage.setItem('river_logged',JSON.stringify(LOGGED_EVENTS));}catch(err){}

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
      name:       (function() {
        var items = _mealItems.map(function(i){return i.food.name;});
        var now2  = new Date(t);
        var hr    = now2.getHours();
        var meal  = hr < 10 ? 'Breakfast' : hr < 14 ? 'Lunch' : hr < 17 ? 'Snack' : 'Dinner';
        var dateStr = now2.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'});
        return meal + ' · ' + dateStr + ' (' + items[0] + (items.length > 1 ? ' +' + (items.length-1) : '') + ')';
      })(),
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
  syncAfterLog();
  _ptCache = null;
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
  if (u > 20) { showToast('⚠️ ' + u.toFixed(1) + 'U is very high — max 20U per entry'); return; }
  if (u > 15) { showToast('⚠️ ' + u.toFixed(1) + 'U logged — double-check this dose'); }
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
    name: 'Demo mode',
    icon: '🎬',
    description: 'Explore Oskar\'s River with simulated data — no CGM required. Great for learning the interface or showing others how it works.',
    fields: [],
    async fetch()       { return []; },
    async fetchRecent() { return []; }
  }
};


// ── HYPO TREATMENT QUICK-LOG ──────────────────────────────────────
var HYPO_TREATMENTS = [
  {id:'glucose_tabs', name:'Glucose tabs', carbs:12, gi:100, desc:'4 tabs = 12g', carbs_each:3,   unit:'tab',   default_qty:4},
  {id:'jelly_babies', name:'Jelly babies', carbs:11, gi:80,  desc:'4 babies = 11g',carbs_each:2.75,unit:'baby',  default_qty:4},
  {id:'apple_juice',  name:'Apple juice',  carbs:13, gi:85,  desc:'125ml carton',  carbs_each:13,  unit:'carton',default_qty:1},
  {id:'lucozade',     name:'Lucozade',     carbs:15, gi:95,  desc:'half bottle',   carbs_each:15,  unit:'half',  default_qty:1},
  {id:'dextro',       name:'Dextro tabs',  carbs:9,  gi:100, desc:'3 tabs = 9g',   carbs_each:3,   unit:'tab',   default_qty:3},
];


async function suggestGI(foodName, inputEl) {
  if (!foodName || foodName.length < 2) return 55;
  if (inputEl) inputEl.placeholder = '...';
  try {
    var resp = await fetch('https://orange-surf-6f98.john-king-uk.workers.dev/claude', {
      method:'POST', headers:{'Content-Type':'application/json','anthropic-version':'2023-06-01'},
      body: JSON.stringify({model:'claude-sonnet-4-5', max_tokens:60,
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
      'text-transform:uppercase;color:var(--rv-close-btn);margin-bottom:5px">when</div>' +
    '<div style="display:flex;align-items:center;gap:8px">' +
    '<div id="' + id + '-display" style="flex:1;font-family:\'Fraunces\',serif;' +
      'font-style:italic;font-weight:200;font-size:15px;color:rgba(200,220,240,0.7)">' +
      fmtTime(val) + '</div>' +
    '<input id="' + id + '" type="datetime-local" value="' + val + '" ' + max + ' ' +
      'style="position:absolute;opacity:0;width:1px;height:1px" ' +
      'onchange="document.getElementById(\'' + id + '-display\').textContent=fmtTime(this.value)">' +
    '<button onclick="document.getElementById(\'' + id + '\').showPicker?.' +
      'call(document.getElementById(\'' + id + '\'))||document.getElementById(\'' + id + '\').click()" ' +
      'style="padding:5px 10px;border-radius:7px;border:1px solid var(--rv-panel-border);' +
      'background:var(--rv-input-bg);font-family:\'DM Mono\',monospace;font-size:9px;' +
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
  var _hypoDefault = _radialDefaultT ? new Date(_radialDefaultT) : new Date();
  if (_radialDefaultT) _radialDefaultT = null;
  var s='<div style="max-width:360px;width:100%">';
  s+='<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">';
  s+='<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:22px;color:rgba(255,210,40,0.9)">hypo treatment</div>';
  s+='<button onclick="closeHypoLog()" style="background:none;border:none;cursor:pointer;font-size:24px;color:var(--rv-text-dim);padding:4px;touch-action:manipulation">×</button>';
  s+='</div>';
  s+='<div style="font-family:\'DM Mono\',monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase;color:rgba(255,210,40,0.45);margin-bottom:14px">also for course correction &middot; hypo prevention</div>';
  s+=timePickerHTML('hypo-time', _hypoDefault, false);
  s+='<div style="display:flex;flex-direction:column;gap:8px">';
  HYPO_TREATMENTS.forEach(function(t){
    var dqty = t.default_qty || 1;
    var carbs_each = t.carbs_each || t.carbs;
    var totalCarbs = Math.round(dqty * carbs_each * 10) / 10;
    s+='<div style="display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:10px;background:rgba(60,45,10,0.4);border:1px solid rgba(255,210,40,0.2)">';
    s+='<div style="flex:1">';
    s+='<div style="font-family:\'Fraunces\',serif;font-weight:200;font-size:16px;color:rgba(255,230,120,0.95)">'+t.name+'</div>';
    s+='<div id="hypo-carbs-label-'+t.id+'" style="font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(255,210,40,0.45);margin-top:2px">'+totalCarbs+'g carbs</div>';
    s+='</div>';
    // Quantity stepper
    s+='<div style="display:flex;align-items:center;gap:4px">';
    s+='<button onclick="hypoQtyStep(\''+t.id+'\','+carbs_each+',-1)" style="width:28px;height:28px;border-radius:7px;border:1px solid rgba(255,210,40,0.3);background:rgba(50,40,5,0.5);font-size:16px;color:rgba(255,225,80,0.9);cursor:pointer;touch-action:manipulation;display:flex;align-items:center;justify-content:center;line-height:1">−</button>';
    s+='<div style="display:flex;flex-direction:column;align-items:center;gap:1px">';
    s+='<input id="hypo-qty-'+t.id+'" type="number" value="'+dqty+'" min="1" max="20" step="1" ';
    s+='style="width:36px;padding:4px;border-radius:6px;border:1px solid rgba(255,210,40,0.3);background:rgba(50,40,5,0.5);';
    s+='font-family:\'DM Mono\',monospace;font-size:14px;color:rgba(255,230,120,0.95);text-align:center;outline:none;touch-action:manipulation" ';
    s+='onchange="hypoQtyChanged(\''+t.id+'\','+carbs_each+',this.value)">';
    s+='<span style="font-family:\'DM Mono\',monospace;font-size:8px;color:rgba(255,210,40,0.4);letter-spacing:.5px">'+t.unit+'s</span>';
    s+='</div>';
    s+='<button onclick="hypoQtyStep(\''+t.id+'\','+carbs_each+',1)" style="width:28px;height:28px;border-radius:7px;border:1px solid rgba(255,210,40,0.3);background:rgba(50,40,5,0.5);font-size:16px;color:rgba(255,225,80,0.9);cursor:pointer;touch-action:manipulation;display:flex;align-items:center;justify-content:center;line-height:1">+</button>';
    s+='</div>';
    s+='<button onclick="logHypoTreatment(\''+t.id+'\')" style="padding:8px 14px;border-radius:8px;cursor:pointer;';
    s+='background:rgba(255,210,40,0.12);border:1px solid rgba(255,210,40,0.4);';
    s+='font-family:\'DM Mono\',monospace;font-size:10px;letter-spacing:.5px;text-transform:uppercase;color:rgba(255,225,80,0.9);touch-action:manipulation">log</button>';
    s+='</div>';
  });
  s+='</div><div style="text-align:center;margin-top:16px">';
  s+='<button onclick="closeHypoLog()" style="background:none;border:none;cursor:pointer;font-family:\'DM Mono\',monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase;color:rgba(255,210,40,0.3);padding:8px">cancel</button></div></div>';
  el.innerHTML=s; document.body.appendChild(el);
  requestAnimationFrame(function(){el.style.opacity='1';});
}
function closeHypoLog(){var el=document.getElementById('hypo-overlay');if(el){el.style.opacity='0';setTimeout(function(){el.remove();},250);}}
function hypoQtyStep(id, carbs_each, delta){
  var inp=document.getElementById('hypo-qty-'+id);
  if(!inp) return;
  var v=Math.max(1,Math.min(20,(parseInt(inp.value)||1)+delta));
  inp.value=v;
  hypoQtyChanged(id, carbs_each, v);
}
function hypoQtyChanged(id, carbs_each, qty){
  var v=Math.max(1,parseFloat(qty)||1);
  var totalCarbs=Math.round(v*carbs_each*10)/10;
  var lbl=document.getElementById('hypo-carbs-label-'+id);
  if(lbl) lbl.textContent=totalCarbs+'g carbs';
}
function logHypoTreatment(id){
  var t=HYPO_TREATMENTS.find(function(x){return x.id===id;});
  if(!t) return;
  var qtyInp=document.getElementById('hypo-qty-'+id);
  var qty=qtyInp?Math.max(1,parseFloat(qtyInp.value)||t.default_qty||1):(t.default_qty||1);
  var carbs_each=t.carbs_each||t.carbs;
  var carbs=Math.round(qty*carbs_each*10)/10;
  // Guardrail — 60g is already a very heavy hypo treatment for a child
  if(carbs>60){showToast('⚠️ '+carbs.toFixed(0)+'g is a very large hypo treatment — check quantity');return;}
  if(carbs>30){showToast('⚠️ '+carbs.toFixed(0)+'g logged — confirm this is correct');}
  var now=getTimeVal('hypo-time');
  SESSION.push({t:now,c:carbs,u:0,note:'hypo:'+id});
  try{localStorage.setItem('river_session',JSON.stringify(SESSION));}catch(e){}
  BOLUS_EVENTS.push({t:now,c:carbs,u:0,note:'hypo:'+id});
  LOGGED_EVENTS.push({t:now,c:carbs,u:0,note:'hypo:'+id,logged_by:_thisPersonId||'unknown', local:true});
  try{localStorage.setItem('river_logged',JSON.stringify(LOGGED_EVENTS));}catch(e){}
  syncAfterLog();
  closeHypoLog();
  var timeStr=document.getElementById('hypo-time-display')?.textContent||'';
  showToast(t.name+'\n'+qty+' '+t.unit+'s · '+carbs+'g logged'+(timeStr?'\n'+timeStr:''));
}

// ── CORRECTION QUICK-LOG ──────────────────────────────────────────
// ── BASAL LOG — confirm Degludec dose was given ─────────────────────────
function openBasalLog() {
  var ex = document.getElementById('basal-log-overlay');
  if (ex) { ex.remove(); return; }

  var dose = (_TREATMENT || _TREATMENT_DEFAULTS).basalDose || 6;
  var now  = new Date();
  var dtISO = now.getFullYear() + '-' +
    String(now.getMonth()+1).padStart(2,'0') + '-' +
    String(now.getDate()).padStart(2,'0') + 'T' +
    String(now.getHours()).padStart(2,'0') + ':' +
    String(now.getMinutes()).padStart(2,'0');

  var el = document.createElement('div');
  el.id = 'basal-log-overlay';
  el.style.cssText = 'position:fixed;inset:0;z-index:60;background:rgba(3,5,20,0.9);backdrop-filter:blur(14px);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;transition:opacity .25s;opacity:0';
  el.addEventListener('touchstart', function(e){ e.stopPropagation(); }, {passive:true});

  el.innerHTML =
    '<div style="max-width:340px;width:100%">' +
    '<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:24px;color:rgba(40,200,160,0.85);margin-bottom:4px">log basal</div>' +
    '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(40,200,160,0.35);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:24px">Degludec · confirm given</div>' +

    '<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">' +
    '<div style="font-family:\'DM Mono\',monospace;font-size:11px;color:rgba(120,160,180,0.5);flex:1">dose (U)</div>' +
    '<input id="basal-log-dose" type="number" inputmode="decimal" min="0" max="80" step="0.5" value="' + dose + '" ' +
    'style="width:80px;padding:10px;border-radius:8px;border:1px solid rgba(40,200,160,0.25);background:rgba(40,200,160,0.06);font-family:\'DM Mono\',monospace;font-size:16px;color:rgba(40,200,160,0.9);text-align:right;outline:none">' +
    '</div>' +

    '<div style="display:flex;align-items:center;gap:12px;margin-bottom:24px">' +
    '<div style="font-family:\'DM Mono\',monospace;font-size:11px;color:rgba(120,160,180,0.5);flex:1">time</div>' +
    '<input id="basal-log-dt" type="datetime-local" value="' + dtISO + '" ' +
    'style="padding:10px;border-radius:8px;border:1px solid rgba(40,200,160,0.15);background:rgba(40,200,160,0.04);font-family:\'DM Mono\',monospace;font-size:12px;color:rgba(120,160,180,0.7);outline:none">' +
    '</div>' +

    '<button onclick="commitBasalLog()" style="width:100%;padding:13px;border-radius:10px;border:1px solid rgba(40,200,160,0.3);background:rgba(40,200,160,0.1);font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:17px;color:rgba(40,200,160,0.9);cursor:pointer;margin-bottom:10px">✓ confirm given</button>' +
    '<button onclick="document.getElementById(\'basal-log-overlay\').remove()" style="width:100%;padding:10px;border-radius:9px;border:none;background:none;font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(120,140,160,0.3);cursor:pointer">cancel</button>' +
    '</div>';

  document.body.appendChild(el);
  requestAnimationFrame(function(){ el.style.opacity = '1'; });
}

function commitBasalLog() {
  var dtEl   = document.getElementById('basal-log-dt');
  var doseEl = document.getElementById('basal-log-dose');
  var t    = dtEl ? new Date(dtEl.value).getTime() : Date.now();
  var dose = parseFloat(doseEl && doseEl.value) || (_TREATMENT || _TREATMENT_DEFAULTS).basalDose || 6;

  LOGGED_EVENTS.push({ t: t, c: 0, u: dose, note: 'basal', logged_by: _thisPersonId || 'unknown', local: true });
  try { localStorage.setItem('river_logged', JSON.stringify(LOGGED_EVENTS)); } catch(e) {}
  syncAfterLog();

  var overlay = document.getElementById('basal-log-overlay');
  if (overlay) overlay.remove();

  showToast('basal ' + dose + 'U logged ✓\nteam can see it in the flow');
}

function openCorrectionLog(){
  var d=dataAt(viewTime);
  var ISF=(new Date(viewTime).getHours()>=9&&new Date(viewTime).getHours()<15)?7.0:6.0;
  var sug=Math.max(0,Math.round(((d.bg-6.0)/ISF)*2)/2);
  var ex=document.getElementById('corr-overlay');if(ex){ex.remove();return;}
  var el=document.createElement('div');el.id='corr-overlay';
  el.style.cssText='position:fixed;inset:0;z-index:60;background:rgba(3,5,20,0.9);backdrop-filter:blur(14px);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;transition:opacity .25s;opacity:0';
  var _corrDefault = _radialDefaultT ? new Date(_radialDefaultT) : new Date();
  if (_radialDefaultT) _radialDefaultT = null;
  var s='<div style="max-width:320px;width:100%">';
  s+='<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">';
  s+='<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:22px;color:rgba(100,160,255,0.9)">correction</div>';
  s+='<button onclick="closeCorrectionLog()" style="background:none;border:none;cursor:pointer;font-size:24px;color:var(--rv-text-dim);padding:4px;touch-action:manipulation">×</button>';
  s+='</div>';
  s+=timePickerHTML('corr-time', _corrDefault, false);
  s+='<div style="font-family:\'DM Mono\',monospace;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:rgba(100,150,255,0.6);text-align:center;margin-bottom:20px">bg '+d.bg.toFixed(1)+' mmol &middot; isf 1:'+ISF.toFixed(0)+'</div>';
  s+='<div style="text-align:center;margin-bottom:20px">';
  s+='<div style="font-family:\'Fraunces\',serif;font-weight:200;font-size:52px;color:rgba(120,170,255,0.95);letter-spacing:-2px">'+sug.toFixed(1)+'</div>';
  s+='<div style="font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(100,150,255,0.6)">suggested units</div></div>';
  s+='<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">';
  s+='<span style="font-family:\'DM Mono\',monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase;color:rgba(100,150,255,0.75)">actual</span>';
  s+='<input id="corr-units" type="number" step="0.5" min="0" max="20" inputmode="decimal" value="'+sug.toFixed(1)+'" oninput="_corrValidate()" style="flex:1;padding:10px;border-radius:8px;border:1px solid rgba(80,130,255,0.3);background:rgba(10,20,60,0.4);font-family:\'DM Mono\',monospace;font-size:18px;color:rgba(160,200,255,0.9);text-align:center;outline:none;transition:border-color .15s">';
  s+='<span style="font-family:\'DM Mono\',monospace;font-size:13px;color:rgba(100,150,255,0.75)">U</span></div>';
  s+='<div id="corr-err" style="font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(255,100,80,0.9);min-height:18px;margin-bottom:12px;text-align:center;letter-spacing:.3px"></div>';
  s+='<button id="corr-log-btn" onclick="logCorrection()" style="width:100%;padding:14px;border-radius:10px;border:1px solid rgba(80,130,255,0.3);background:rgba(20,40,120,0.3);font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:17px;color:rgba(140,190,255,0.9);cursor:pointer;margin-bottom:12px;transition:opacity .15s">log correction</button>';
  s+='<div style="text-align:center"><button onclick="closeCorrectionLog()" style="background:none;border:none;cursor:pointer;font-family:\'DM Mono\',monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase;color:rgba(100,150,255,0.4);padding:4px">cancel</button></div></div>';
  el.innerHTML=s; document.body.appendChild(el);
  requestAnimationFrame(function(){el.style.opacity='1';});
}
function closeCorrectionLog(){var el=document.getElementById('corr-overlay');if(el){el.style.opacity='0';setTimeout(function(){el.remove();},250);}}
function _corrValidate(){
  var inp=document.getElementById('corr-units');
  var btn=document.getElementById('corr-log-btn');
  var err=document.getElementById('corr-err');
  if(!inp) return;
  var v=parseFloat(inp.value)||0;
  var bad=v>20;
  var warn=v>10&&v<=20;
  if(err){
    err.textContent=bad?'⚠️ max 20U per correction':warn?'⚠️ high dose — double-check':'';
  }
  if(inp){
    inp.style.borderColor=bad?'rgba(255,80,60,0.7)':warn?'rgba(255,160,40,0.6)':'rgba(80,130,255,0.3)';
    inp.style.color=bad?'rgba(255,120,100,0.95)':warn?'rgba(255,200,80,0.95)':'rgba(160,200,255,0.9)';
  }
  if(btn){
    btn.disabled=bad;
    btn.style.opacity=bad?'0.35':'1';
    btn.style.cursor=bad?'not-allowed':'pointer';
  }
}
function logCorrection(){
  var u=parseFloat(document.getElementById('corr-units').value)||0;
  if(u<=0){closeCorrectionLog();return;}
  if(u>20){showToast('⚠️ '+u.toFixed(1)+'U is very high — max 20U per correction');return;}
  if(u>10){showToast('⚠️ '+u.toFixed(1)+'U logged — double-check this dose');}
  var now=getTimeVal('corr-time');
  SESSION.push({t:now,c:0,u:u});
  BOLUS_EVENTS.push({t:now,c:0,u:u,logged_by:_thisPersonId||'unknown'});
  LOGGED_EVENTS.push({t:now,c:0,u:u,note:'correction',logged_by:_thisPersonId||'unknown',local:true});
  try{localStorage.setItem('river_session',JSON.stringify(SESSION));}catch(e){}
  try{localStorage.setItem('river_logged',JSON.stringify(LOGGED_EVENTS));}catch(e){}
  ALERTS.snooze('corr_nudge',90*60000); ALERTS.snooze('corr_high',90*60000);
  _riverPebble=null;
  syncAfterLog();
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

var _historyIsStale = false; // true = showing persisted data, live CGM not yet connected

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
    _historyIsStale = true; // hide BG display until live data arrives
  } catch(e) {}
}

function ingestReadings(readings) {
  let changed = false;
  for (const r of readings) {
    if (!r.t || !r.bg || r.bg < 1 || r.bg > 30) continue;
    const existing = HISTORY_RAW.findIndex(h => Math.abs(h.t - r.t) < 90000);
    const entry = { t: r.t, bg: r.bg, iob: 0, cob: 0, pen: 1, trend: r.trend || null };
    if (existing >= 0) HISTORY_RAW[existing] = { ...HISTORY_RAW[existing], bg: r.bg, trend: r.trend || HISTORY_RAW[existing].trend || null };
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
  _historyIsStale = false; // live data confirmed — show real BG
  // Purge scenario-only BOLUS_EVENTS (not in LOGGED_EVENTS) — demo data gone
  if (_activeDemoId) {
    var _loggedTs = new Set(LOGGED_EVENTS.map(function(e){ return e.t; }));
    BOLUS_EVENTS = BOLUS_EVENTS.filter(function(b){ return _loggedTs.has(b.t); });
    SESSION      = SESSION.filter(function(s){ return _loggedTs.has(s.t); });
    _activeDemoId = null;
  }
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

  // Demo mode — no credentials needed, just load and show scenarios
  if (_selectedSource === 'manual') {
    saveCGMConfig('manual', {});
    dismissSetup();
    setTimeout(function(){ loadScenario('equilibrium'); }, 200);
    setTimeout(function(){ openDemoSelector(); }, 700);
    return;
  }

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
  el.style.cssText = 'position:fixed;inset:0;z-index:70;background:var(--rv-panel-bg);overflow-y:auto;transition:opacity .2s;opacity:0;-webkit-overflow-scrolling:touch;touch-action:pan-y;pointer-events:auto';

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
  html += '<button onclick="closeFoodManager()" style="padding:8px 12px;border-radius:9px;border:1px solid var(--rv-panel-border);background:transparent;font-family:\'DM Mono\',monospace;font-size:10px;color:var(--rv-text-muted);cursor:pointer">close</button>';
  html += '</div></div>';

  // Group by category
  cats.forEach(function(cat) {
    var items = all.filter(function(f){ return (f.cat||'custom') === cat; });
    if (items.length === 0) return;

    html += '<div style="margin-bottom:20px">';
    html += '<div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1.5px;text-transform:uppercase;color:var(--rv-text-dim);margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid rgba(255,255,255,0.06)">' + (catLabels[cat]||cat) + '</div>';

    items.forEach(function(f, i) {
      var isCustom = FOOD_LIBRARY.some(function(l){ return l.name===f.name; });
      var gi = f.gi || 0;
      var giC = gi>=70?'rgba(210,80,40,0.7)':gi>=55?'rgba(200,140,30,0.7)':'rgba(60,160,90,0.7)';
      var giLabel = gi>=70?'high':gi>=55?'med':'low';
      var servCarbs = f.g_serv ? (f.c100 * f.g_serv / 100).toFixed(1) : null;
      var fid = encodeURIComponent(f.name);

      html += '<div id="frow-' + fid + '" style="display:flex;align-items:center;gap:10px;padding:10px 8px;border-radius:10px;margin-bottom:4px;background:var(--rv-input-bg)">';

      // Name + note
      html += '<div style="flex:1;min-width:0">';
      html += '<div style="font-family:\'DM Mono\',monospace;font-size:12px;color:rgba(220,230,240,0.85);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + f.name + '</div>';
      if (f.note) html += '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:var(--rv-text-dim);margin-top:1px">' + f.note + '</div>';
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
      html += '<div style="font-family:\'DM Mono\',monospace;font-size:7px;color:var(--rv-text-dim)">gi</div>';
      html += '</div>';

      // c100
      html += '<div style="text-align:center;min-width:32px">';
      html += '<div style="font-family:\'DM Mono\',monospace;font-size:10px;color:var(--rv-text-muted)">' + f.c100 + '</div>';
      html += '<div style="font-family:\'DM Mono\',monospace;font-size:7px;color:var(--rv-text-dim)">c/100g</div>';
      html += '</div>';

      // Edit button
      html += '<button onclick="editFood(\'' + fid + '\')" style="padding:5px 10px;border-radius:7px;border:1px solid var(--rv-panel-border);background:transparent;font-family:\'DM Mono\',monospace;font-size:9px;color:var(--rv-text-muted);cursor:pointer">edit</button>';

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
  html += '<button onclick="renderFoodManager()" style="background:none;border:none;cursor:pointer;font-family:\'DM Mono\',monospace;font-size:10px;color:var(--rv-text-muted);padding:4px">← back</button>';
  html += '<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:22px;color:rgba(180,220,200,0.9)">' + (isNew?'new food':'edit food') + '</div>';
  html += '</div>';

  var fld = function(id, label, val, type, placeholder, note) {
    var v = (val!==undefined&&val!==null) ? val : '';
    return '<div style="margin-bottom:14px">' +
      '<div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1px;text-transform:uppercase;color:var(--rv-text-muted);margin-bottom:5px">' + label + (note?'<span style="opacity:0.5;margin-left:6px;font-size:7px">'+note+'</span>':'') + '</div>' +
      '<input id="fe-'+id+'" type="'+(type||'text')+'" value="'+v+'" placeholder="'+(placeholder||'')+'" ' +
      'style="width:100%;padding:10px 12px;border-radius:9px;border:1px solid var(--rv-panel-border);background:var(--rv-input-bg);font-family:\'DM Mono\',monospace;font-size:14px;color:rgba(220,230,240,0.9);outline:none;box-sizing:border-box">' +
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
  html += '<div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1px;text-transform:uppercase;color:var(--rv-text-muted);margin-bottom:5px">category</div>';
  html += '<select id="fe-cat" style="width:100%;padding:10px 12px;border-radius:9px;border:1px solid var(--rv-panel-border);background:var(--rv-input-bg);font-family:\'DM Mono\',monospace;font-size:13px;color:rgba(220,230,240,0.8);outline:none">' + catOpts + '</select>';
  html += '</div>';

  html += fld('note', 'note / description', f?f.note:'', 'text', 'e.g. 1 slice, 1 bowl');

  html += '<div style="display:flex;gap:8px;margin-top:24px">';
  html += '<button onclick="saveFoodEdit(\'' + (f?encodeURIComponent(f.name):'') + '\',' + (isNew?'true':'false') + ')" style="flex:1;padding:12px;border-radius:9px;border:1px solid rgba(62,180,120,0.3);background:rgba(62,180,120,0.08);font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:16px;color:rgba(62,180,120,0.9);cursor:pointer">save food</button>';
  if (!isNew) {
    html += '<button onclick="deleteFood(\'' + (f?encodeURIComponent(f.name):'') + '\')" style="padding:12px 16px;border-radius:9px;border:1px solid rgba(200,60,60,0.2);background:transparent;font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(200,80,80,0.5);cursor:pointer">delete</button>';
  }
  html += '<button onclick="renderFoodManager()" style="padding:12px 16px;border-radius:9px;border:1px solid var(--rv-panel-border);background:transparent;font-family:\'DM Mono\',monospace;font-size:10px;color:var(--rv-text-muted);cursor:pointer">cancel</button>';
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
var _radialDefaultT = null; // Set by long-press to pre-fill modals with river time at press position

function setupOrbLongPress() {
  // ── DOM BUTTON APPROACH ───────────────────────────────────────────────
  // Invisible button positioned over the orb each frame via rAF.
  // Completely decoupled from canvas touch/scroll system.
  // No passive:false conflicts. No scroll interference.

  var btn = document.getElementById('_orb_btn');
  if (!btn) {
    btn = document.createElement('div');
    btn.id = '_orb_btn';
    btn.style.cssText = [
      'position:fixed',
      'width:110px',
      'height:110px',
      'border-radius:50%',
      'z-index:30',
      'touch-action:none',
      'pointer-events:auto',
      'cursor:pointer',
      '-webkit-user-select:none',
      'user-select:none',
      'background:transparent',
      '-webkit-tap-highlight-color:transparent',
    ].join(';');
    document.body.appendChild(btn);
  }

  // Reposition each frame to track the orb
  (function positionBtn() {
    var cx = (typeof window._orbScreenX === 'number') ? window._orbScreenX : (NOW_X * W);
    var cy = (typeof window._orbScreenY === 'number') ? window._orbScreenY : (window.innerHeight * 0.5);
    btn.style.left = (cx - 55) + 'px';
    btn.style.top  = (cy - 55) + 'px';
    requestAnimationFrame(positionBtn);
  })();

  var _pressX = 0, _pressY = 0, _pressing = false;

  function _startPress(clientX, clientY) {
    if (_orbPressTimer) return;
    _pressing = true;
    _pressX = clientX;
    _pressY = clientY;
    _orbLongPressHint = 1.0;
    _orbPressTimer = setTimeout(function() {
      _orbPressTimer = null;
      if (!_pressing) return;
      if (navigator.vibrate) navigator.vibrate(30);
      openOrbRadialMenu(_pressX);
    }, 500);
  }

  function _cancelPress() {
    _pressing = false;
    if (_orbPressTimer) { clearTimeout(_orbPressTimer); _orbPressTimer = null; }
  }

  function _moveCheck(clientX, clientY) {
    if (!_orbPressTimer) return;
    var dx = clientX - _pressX, dy = clientY - _pressY;
    if (dx*dx + dy*dy > 144) _cancelPress(); // >12px = scroll intent
  }

  btn.addEventListener('touchstart', function(e) {
    if (e.touches.length > 1) { _cancelPress(); return; }
    e.stopPropagation();
    _startPress(e.touches[0].clientX, e.touches[0].clientY);
  }, {passive:true});

  btn.addEventListener('touchmove', function(e) {
    if (e.touches.length === 1) _moveCheck(e.touches[0].clientX, e.touches[0].clientY);
  }, {passive:true});

  btn.addEventListener('touchend', function(e) {
    e.stopPropagation();
    var wasPressing = _pressing;
    _cancelPress();
    if (wasPressing) { _orbTapHint = 1.0; _orbTapHintT = Date.now(); }
  }, {passive:true});

  btn.addEventListener('mousedown', function(e) { _startPress(e.clientX, e.clientY); });
  btn.addEventListener('mousemove', function(e) { _moveCheck(e.clientX, e.clientY); });
  btn.addEventListener('mouseup',   function()  { _cancelPress(); });
}

function openOrbRadialMenu(pressX) {
  // Always remove any existing menu and open fresh — never toggle closed.
  // The old toggle caused: previous menu still dying (160ms fade) → timer fires
  // → finds element → removes it → returns without opening. Menu never appeared.
  var ex = document.getElementById('orb-radial-menu');
  if (ex) ex.remove();

  var d     = dataAt ? dataAt(viewTime) : null;
  var orbX  = (pressX !== undefined) ? pressX : NOW_X * W;
  var orbY  = d ? bgToY(d.bg) : window.innerHeight * 0.5;

  // Items: label, icon, action, colour
  var items = [
    { label: 'log food',   icon: '◉', fn: 'openSheet()',          col: 'rgba(255,150,50,0.9)'  },
    { label: 'correct',    icon: '◎', fn: 'openCorrectionLog()',  col: 'rgba(80,130,220,0.9)'  },
    { label: 'hypo',       icon: '⬡', fn: 'openHypoLog()',        col: 'rgba(255,210,40,0.9)'  },
    { label: 'prick',      icon: '◆', fn: 'openBloodPrickLog()',  col: 'rgba(220,60,80,0.9)'   },
    { label: 'basal',      icon: '▬', fn: 'openBasalLog()',       col: 'rgba(40,200,160,0.9)'  },
    { label: 'whisper',    icon: '◌', fn: 'openWhisper()',        col: 'rgba(140,200,180,0.9)' },
  ];

  var el = document.createElement('div');
  el.id  = 'orb-radial-menu';
  el.style.cssText = 'position:fixed;inset:0;z-index:60;pointer-events:auto;touch-action:none';

  // Background dim
  var bg = document.createElement('div');
  bg.style.cssText = 'position:absolute;inset:0;background:rgba(3,5,18,0.55);backdrop-filter:blur(3px);transition:opacity .2s;opacity:0';
  el.appendChild(bg);
  setTimeout(function(){ bg.style.opacity = '1'; }, 10);

  // Guard: ignore close events for 350ms after open — prevents the finger-lift from the
  // long-press immediately firing a click/touchend on the backdrop and closing the menu.
  var _menuOpenT = Date.now();
  function _canClose() { return Date.now() - _menuOpenT > 600; }

  // Close on backdrop — touchend only (click fires too late and catches the lift from long-press)
  bg.addEventListener('touchend', function(e) {
    if (!_canClose()) return;
    e.preventDefault();
    closeOrbRadialMenu();
  });
  bg.addEventListener('click', function() {
    if (!_canClose()) return;
    closeOrbRadialMenu();
  });

  // Radial buttons
  var numItems = items.length;
  var radius   = Math.min(window.innerWidth, window.innerHeight) * 0.22;
  radius       = Math.max(90, Math.min(radius, 130));

  // Clamp orb position to safe zone
  var cx = Math.max(radius + 20, Math.min(window.innerWidth  - radius - 20, orbX));
  var cy = Math.max(radius + 60, Math.min(window.innerHeight - radius - 20, orbY));

  items.forEach(function(item, i) {
    var angle  = (i / numItems) * Math.PI * 2 - Math.PI / 2;
    var tx     = cx + Math.cos(angle) * radius;
    var ty     = cy + Math.sin(angle) * radius;

    var btn = document.createElement('button');
    btn.style.cssText = [
      'position:absolute',
      'left:' + (tx - 34) + 'px',
      'top:'  + (ty - 34) + 'px',
      'width:68px',
      'height:68px',
      'border-radius:50%',
      'border:1px solid ' + item.col.replace('0.9','0.4'),
      'background:rgba(5,8,22,0.88)',
      'backdrop-filter:blur(12px)',
      'cursor:pointer',
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'justify-content:center',
      'gap:3px',
      'opacity:0',
      'transform:scale(0.5)',
      'transition:opacity .25s ' + (i*0.04) + 's, transform .25s ' + (i*0.04) + 's',
      'pointer-events:auto',
      '-webkit-tap-highlight-color:transparent',
    ].join(';');
    btn.innerHTML =
      '<span style="font-size:18px;line-height:1;color:' + item.col + '">' + item.icon + '</span>' +
      '<span style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:0.5px;color:rgba(200,220,240,0.7);text-transform:uppercase;line-height:1">' + item.label + '</span>';

    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      closeOrbRadialMenu();
      // small delay so menu closes first
      setTimeout(function(){ try { eval(item.fn); } catch(err){} }, 80);
    });
    el.appendChild(btn);
    setTimeout(function(){ btn.style.opacity = '1'; btn.style.transform = 'scale(1)'; }, 10);
  });

  // Centre label
  var lbl = document.createElement('div');
  lbl.style.cssText = [
    'position:absolute',
    'left:' + (cx - 80) + 'px',
    'top:'  + (cy - 10) + 'px',
    'width:160px',
    'text-align:center',
    "font-family:'DM Mono',monospace",
    'font-size:9px',
    'letter-spacing:1px',
    'text-transform:uppercase',
    'color:rgba(180,200,220,0.4)',
    'pointer-events:none',
  ].join(';');
  lbl.textContent = 'What do you want to do?';
  el.appendChild(lbl);

  document.body.appendChild(el);
}

function closeOrbRadialMenu() {
  var el = document.getElementById('orb-radial-menu');
  if (!el) return;
  el.style.opacity = '0';
  el.style.transition = 'opacity .15s';
  setTimeout(function(){ if(el.parentNode) el.remove(); }, 160);
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
    '<button onclick="closeWhisper()" style="background:none;border:none;cursor:pointer;font-size:24px;color:var(--rv-close-btn);padding:4px;line-height:1;touch-action:manipulation">×</button>' +
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

  // Route fix: and add: prefixes to repair system instead of clinical whisper
  var lq = q.toLowerCase();
  if (lq.startsWith('fix:') || lq.startsWith('bug:')) {
    resp.textContent = 'sending to repair system...';
    await sendBugReport(q.slice(q.indexOf(':')+1).trim());
    resp.textContent = (document.getElementById('repair-status')||{}).textContent || 'sent';
    return;
  }
  if (lq.startsWith('add:') || lq.startsWith('feature:') || lq.startsWith('build:')) {
    resp.textContent = 'sending feature request...';
    await sendFeatureRequest(q.slice(q.indexOf(':')+1).trim());
    resp.textContent = (document.getElementById('repair-status')||{}).textContent || 'queued';
    return;
  }

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
    var r = await fetch('https://orange-surf-6f98.john-king-uk.workers.dev/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
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
  // Unlock AudioContext on first user gesture (Chrome autoplay policy)
  function _unlockAudio() {
    window._riverHasUserGesture = true;
    if (ALERTS._audioCtx && ALERTS._audioCtx.state === 'suspended') {
      ALERTS._audioCtx.resume();
    }
    document.removeEventListener('touchstart', _unlockAudio);
    document.removeEventListener('click', _unlockAudio);
  }
  document.addEventListener('touchstart', _unlockAudio, {once:true, passive:true});
  document.addEventListener('click', _unlockAudio, {once:true});
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


// ═══════════════════════════════════════════════════════════════════════
//  RIVER REPAIR SYSTEM
//  Bug reports, feature requests, and whisper-driven fixes
//  Routes via Cloudflare Worker → Claude → GitHub commit → auto-deploy
// ═══════════════════════════════════════════════════════════════════════

var PROXY_BASE = 'https://orange-surf-6f98.john-king-uk.workers.dev';
var _featureQueue = []; // pending feature requests

// ── Build context snapshot for bug/feature reports ────────────────────
function buildReportContext() {
  var d = (typeof dataAt === 'function') ? dataAt(viewTime) : {};
  return {
    build:     '__BUILD_ID__',
    bg:        d.bg ? d.bg.toFixed(1) : '?',
    iob:       d.iob ? d.iob.toFixed(2) : '0',
    cob:       d.cob ? d.cob.toFixed(1) : '0',
    sheetMode: typeof _sheetMode !== 'undefined' ? _sheetMode : 'unknown',
    errors:    (window.__debugLog || []).slice(0, 5).join(' | '),
    userAgent: navigator.userAgent.slice(0, 80),
    ts:        new Date().toISOString(),
  };
}

// ── Build a function index of app.js for targeted patching ────────────
// Returns array of {name, startLine, preview} — sent to Claude so it
// can request just the relevant section rather than the whole file
function buildFunctionIndex() {
  // We can't read our own source at runtime, but we can expose key function names
  // The Worker fetches app.js and does the sectioning server-side
  var fns = [];
  var knownFns = [
    'renderSheet', 'renderKitchen', 'openSheet', 'closeSheet',
    'logMealEntry', 'logCorrection', 'logHypoTreatment',
    'addFoodItem', 'addCustomFood', 'saveCustomFood', 'searchFood',
    'drawGasCloud', 'drawBGTrail', 'drawOrb', 'drawEquilibriumZone',
    'buildSmartForecast', 'drawUnknownForce',
    'syncNow', 'syncPushEvents', 'syncPullEvents',
    'openRecipeManager', 'cookRecipe', 'saveCookInstance',
    'openPeopleInFlow', 'openKitchen', 'openDebugPanel',
    'sendWhisper', 'deployToGitHub',
  ];
  // Return names that actually exist in window scope
  knownFns.forEach(function(fn) {
    if (typeof window[fn] === 'function') fns.push(fn);
  });
  return fns;
}

// ── Send a bug report → Worker → Claude → GitHub ─────────────────────
async function sendBugReport(description) {
  var ctx = buildReportContext();
  var fns = buildFunctionIndex();

  var statusEl = document.getElementById('repair-status');
  if (statusEl) { statusEl.textContent = 'sending to Claude...'; statusEl.style.color = 'rgba(200,200,100,0.8)'; }

  try {
    var resp = await fetch(PROXY_BASE + '/fix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error_msg:   description,
        context:     JSON.stringify(ctx),
        known_functions: fns,
        type:        'bug',
      })
    });

    var data = await resp.json();

    if (statusEl) {
      if (data.deployed) {
        statusEl.textContent = '✓ fix deployed · building...';
        statusEl.style.color = 'rgba(62,180,120,0.9)';
        showToast('fix on the way · ' + (data.diagnosis || ''));
      } else if (data.diagnosis) {
        statusEl.textContent = 'diagnosed: ' + data.diagnosis.slice(0, 60);
        statusEl.style.color = 'rgba(200,200,100,0.8)';
        showToast('Claude: ' + data.diagnosis);
      } else {
        statusEl.textContent = data.error || 'no fix generated';
        statusEl.style.color = 'rgba(220,80,60,0.8)';
      }
    }
  } catch(err) {
    console.warn('[repair] bug report failed:', err.message);
    if (statusEl) { statusEl.textContent = 'failed · ' + err.message.slice(0, 40); statusEl.style.color = 'rgba(220,80,60,0.8)'; }
  }
}

// ── Send a feature request → Worker → Claude → GitHub ────────────────
async function sendFeatureRequest(description) {
  var ctx = buildReportContext();
  var fns = buildFunctionIndex();

  var statusEl = document.getElementById('repair-status');
  if (statusEl) { statusEl.textContent = 'asking Claude...'; statusEl.style.color = 'rgba(200,200,100,0.8)'; }

  try {
    var resp = await fetch(PROXY_BASE + '/fix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error_msg:   description,
        context:     JSON.stringify(ctx),
        known_functions: fns,
        type:        'feature',
      })
    });

    var data = await resp.json();

    if (statusEl) {
      if (data.deployed) {
        statusEl.textContent = '✓ feature deployed · building...';
        statusEl.style.color = 'rgba(62,180,120,0.9)';
        showToast('feature added · ' + (data.fix_description || ''));
      } else {
        statusEl.textContent = data.note || data.error || 'queued';
        statusEl.style.color = 'rgba(180,160,60,0.8)';
        if (data.diagnosis) showToast('plan: ' + data.diagnosis);
      }
    }
  } catch(err) {
    console.warn('[repair] feature request failed:', err.message);
    if (statusEl) { statusEl.textContent = 'failed · ' + err.message.slice(0, 40); statusEl.style.color = 'rgba(220,80,60,0.8)'; }
  }
}

// ── Nuclear data clear — wipes all local river state ─────────────────
function nukeLocalData() {
  // Stop all timers first — prevent sync firing during reload and re-pushing events
  try{ if(typeof stopLivePolling==='function') stopLivePolling(); }catch(_e){}
  try{ if(typeof _syncTimer!=='undefined' && _syncTimer) clearInterval(_syncTimer); }catch(_e){}
  try{ if(typeof _pollTimer!=='undefined' && _pollTimer) clearInterval(_pollTimer); }catch(_e){}

  try {
    // Clear all river localStorage keys
    var keys = ['river_logged','river_session','river_meals','river_meal_hist',
                 'river_cgm_history','river_food_lib','river_people','river_recipes',
                 'river_visual_prefs','river_person_id','river_deleted_ts'];
    keys.forEach(function(k){ try{localStorage.removeItem(k);}catch(_e){} });
    // Clear in-memory arrays defensively
    try{ if(typeof LOGGED_EVENTS!=='undefined') LOGGED_EVENTS.length=0; }catch(_e){}
    try{ if(typeof BOLUS_EVENTS!=='undefined')  BOLUS_EVENTS.length=0;  }catch(_e){}
    try{ if(typeof SESSION!=='undefined')        SESSION.length=0;       }catch(_e){}
    try{ if(typeof MEAL_HISTORY!=='undefined')   MEAL_HISTORY.length=0;  }catch(_e){}
    try{ if(typeof HISTORY_RAW!=='undefined')    HISTORY_RAW.length=0;   }catch(_e){}
  } catch(_e) {}
  try { showToast('cache cleared — reloading'); } catch(_e){}
  setTimeout(function(){ window.location.reload(); }, 800);
}

async function nukeSupabaseEvents() {
  if (!SUPABASE_READY) { showToast('Supabase not configured'); return; }
  showToast('clearing Supabase events…');
  try {
    // Delete all events — requires RLS to allow DELETE for anon key
    // If this 400s, go to Supabase dashboard → Table Editor → events → delete all rows manually
    await _sbFetch('events?t=gte.0', { method: 'DELETE', prefer: 'return=minimal',
      headers: { 'Prefer': 'return=minimal' } });
    showToast('Supabase events cleared\nnow nuke local on each device');
  } catch(e) {
    // 400 usually means RLS blocks DELETE for anon key
    showToast('Supabase DELETE blocked (RLS)\nGo to Supabase dashboard →\nTable Editor → events →\ndelete all rows manually');
  }
}

function openDebugPanel() {
  var p = document.getElementById('debug-panel');
  if (p) { p.remove(); return; }
  var d = (typeof dataAt === 'function') ? dataAt(viewTime) : {};
  var age = (typeof _lastReadingT !== 'undefined' && _lastReadingT > 0) ? Math.round((Date.now() - _lastReadingT) / 60000) + ' min ago' : 'unknown';
  var src = (typeof _sourceId !== 'undefined') ? _sourceId : 'none';
  var hist = (typeof HISTORY_RAW !== 'undefined') ? HISTORY_RAW.length : '?';


  var el = document.createElement('div');
  el.id  = 'debug-panel';
  el.style.cssText = [
    'position:fixed', 'bottom:80px', 'left:8px', 'right:8px', 'z-index:200',
    'background:rgba(0,0,0,0.95)', 'border:1px solid var(--rv-panel-border)',
    'border-radius:12px', 'padding:12px', 'font-family:monospace', 'font-size:10px',
    'color:rgba(200,220,200,0.85)', 'max-height:70vh', 'overflow-y:auto',
    'touch-action:pan-y', 'pointer-events:auto',
  ].join(';');

  el.innerHTML =
    // Header row
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
      '<span style="color:rgba(62,207,160,0.9);font-weight:bold;font-size:11px">🌊 River Debug</span>' +
      '<div style="display:flex;gap:6px">' +
        '<button onclick="deployToGitHub()" style="padding:3px 8px;border-radius:6px;border:1px solid rgba(62,207,160,0.3);background:rgba(62,207,160,0.08);color:rgba(62,207,160,0.8);font-family:monospace;font-size:9px;cursor:pointer">⬆ deploy</button>' +
        '<button onclick="if(confirm(\'Clear all local data and reload?\'))nukeLocalData()" style="padding:3px 8px;border-radius:6px;border:1px solid rgba(220,80,60,0.4);background:rgba(220,80,60,0.08);color:rgba(220,80,60,0.8);font-family:monospace;font-size:9px;cursor:pointer">nuke local</button>' +
        '<button onclick="if(confirm(\'Delete ALL Supabase events? Cannot be undone.\'))nukeSupabaseEvents()" style="padding:3px 8px;border-radius:6px;border:1px solid rgba(220,80,60,0.6);background:rgba(220,80,60,0.12);color:rgba(220,80,60,0.9);font-family:monospace;font-size:9px;cursor:pointer">nuke supa</button>' +
        '<button onclick="document.getElementById(\'debug-panel\').remove()" style="background:none;border:none;color:var(--rv-text-muted);cursor:pointer;font-size:18px;padding:0;line-height:1">×</button>' +
      '</div>' +
    '</div>' +

    // Status strip
    '<div style="color:rgba(150,200,150,0.6);margin-bottom:8px;line-height:1.7;font-size:9px">' +
      '__BUILD_ID__ · ' + src + ' · last: ' + age + ' · ' + hist + ' readings<br>' +
      'BG: ' + (d.bg ? d.bg.toFixed(1) : '?') +
      ' IOB: ' + (d.iob ? d.iob.toFixed(2) : '?') +
      ' COB: ' + (d.cob ? d.cob.toFixed(1) : '?') +
    '</div>' +

    // Error log with copy button
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">' +
      '<div style="font-size:8px;letter-spacing:1px;text-transform:uppercase;color:var(--rv-text-dim)">log</div>' +
      '<button id="copy-log-btn" onclick="var t=(window.__debugLog||[]).join(\"\\n\");navigator.clipboard.writeText(t).then(function(){var b=document.getElementById(\'copy-log-btn\');b.textContent=\'\u2713 copied\';setTimeout(function(){b.textContent=\'copy\'},1500)})" style="padding:2px 7px;border-radius:5px;border:1px solid var(--rv-panel-border);background:var(--rv-input-bg);color:var(--rv-text-muted);font-family:monospace;font-size:8px;cursor:pointer">copy</button>' +
    '</div>' +
    '<div id="debug-content" style="margin-bottom:10px;min-height:20px;font-size:9px;line-height:1.5;user-select:text;-webkit-user-select:text"></div>' +

    // Divider
    '<div style="border-top:1px solid rgba(255,255,255,0.08);margin-bottom:10px"></div>' +

    // Bug report
    '<div style="margin-bottom:8px">' +
      '<div style="font-size:8px;letter-spacing:1px;text-transform:uppercase;color:var(--rv-text-muted);margin-bottom:5px">report a bug</div>' +
      '<div style="display:flex;gap:6px">' +
        '<input id="bug-input" type="text" placeholder="describe what broke..." ' +
          'style="flex:1;padding:6px 8px;border-radius:7px;border:1px solid rgba(255,80,80,0.25);background:rgba(255,80,80,0.05);font-family:monospace;font-size:10px;color:rgba(255,200,200,0.85);outline:none" ' +
          'onkeydown="if(event.key===\'Enter\'){sendBugReport(this.value);this.value=\'\'}">' +
        '<button onclick="var i=document.getElementById(\'bug-input\');sendBugReport(i.value);i.value=\'\'" ' +
          'style="padding:6px 10px;border-radius:7px;border:1px solid rgba(255,80,80,0.25);background:rgba(255,80,80,0.08);color:rgba(255,150,150,0.8);font-family:monospace;font-size:9px;cursor:pointer">fix it</button>' +
      '</div>' +
    '</div>' +

    // Feature request
    '<div style="margin-bottom:10px">' +
      '<div style="font-size:8px;letter-spacing:1px;text-transform:uppercase;color:var(--rv-text-muted);margin-bottom:5px">request a feature</div>' +
      '<div style="display:flex;gap:6px">' +
        '<input id="feature-input" type="text" placeholder="describe what you want..." ' +
          'style="flex:1;padding:6px 8px;border-radius:7px;border:1px solid rgba(62,130,220,0.25);background:rgba(62,130,220,0.05);font-family:monospace;font-size:10px;color:rgba(150,180,255,0.85);outline:none" ' +
          'onkeydown="if(event.key===\'Enter\'){sendFeatureRequest(this.value);this.value=\'\'}">' +
        '<button onclick="var i=document.getElementById(\'feature-input\');sendFeatureRequest(i.value);i.value=\'\'" ' +
          'style="padding:6px 10px;border-radius:7px;border:1px solid rgba(62,130,220,0.25);background:rgba(62,130,220,0.08);color:rgba(150,180,255,0.8);font-family:monospace;font-size:9px;cursor:pointer">build it</button>' +
      '</div>' +
    '</div>' +

    // Status line
    '<div id="repair-status" style="font-size:9px;color:var(--rv-text-muted);min-height:14px;text-align:center"></div>';

  document.body.appendChild(el);
  if (window.__updateDebugPanel) window.__updateDebugPanel();
}




// ── DEPLOY — push current app.js to GitHub ───────────────────────────
async function deployToGitHub() {
  var btn = document.querySelector('[onclick="deployToGitHub()"]');
  if (btn) { btn.textContent = '⬆ deploying...'; btn.disabled = true; }
  var statusEl = document.getElementById('repair-status');
  if (statusEl) { statusEl.textContent = 'fetching current build...'; statusEl.style.color = 'rgba(200,200,100,0.8)'; }

  try {
    var rawResp = await fetch('https://raw.githubusercontent.com/j-kinjo/oskars-river/main/app.js?t=' + Date.now());
    if (!rawResp.ok) throw new Error('Could not fetch app.js (' + rawResp.status + ')');
    var currentCode = await rawResp.text();

    if (statusEl) statusEl.textContent = 'committing to GitHub...';

    var resp = await fetch(PROXY_BASE + '/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: 'app.js',
        content: currentCode,
        message: 'manual deploy from debug panel · build __BUILD_ID__',
      })
    });

    var data = await resp.json();
    if (data.ok) {
      if (statusEl) { statusEl.textContent = '✓ committed · building ~30s'; statusEl.style.color = 'rgba(62,180,120,0.9)'; }
      if (btn) { btn.textContent = '✓ done'; }
      showToast('deployed · building...');
    } else {
      throw new Error(data.error || 'deploy failed');
    }
  } catch(err) {
    console.warn('[deploy]', err.message);
    if (statusEl) { statusEl.textContent = '✗ ' + err.message.slice(0, 50); statusEl.style.color = 'rgba(220,80,60,0.8)'; }
    if (btn) { btn.textContent = '⬆ deploy'; btn.disabled = false; }
  }
}

// ── EVENT EDITOR — edit or delete a logged event ─────────────────────
function openEventEditor(eventIdx) {
  var events = [...LOGGED_EVENTS, ...SESSION.map((s,i) => ({...s, _session: true, _idx: i}))];
  // Find by index in BOLUS_EVENTS
  var ev = BOLUS_EVENTS[eventIdx];
  if (!ev) return;

  var ex = document.getElementById('event-edit-overlay');
  if (ex) ex.remove();

  var el = document.createElement('div');
  el.id  = 'event-edit-overlay';
  el.style.cssText = 'position:fixed;inset:0;z-index:80;background:rgba(3,5,20,0.92);' +
    'backdrop-filter:blur(16px);display:flex;flex-direction:column;align-items:center;' +
    'justify-content:center;padding:32px;pointer-events:auto;touch-action:pan-y';
  el.addEventListener('touchstart', function(e){e.stopPropagation();},{passive:true});
  el.addEventListener('click', function(e){ if(e.target===el) el.remove(); });

  var dt = new Date(ev.t);
  var timeStr = dt.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'}) +
    ' · ' + dt.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});

  // Build time value for datetime-local input
  var tzOffset = dt.getTimezoneOffset() * 60000;
  var dtLocalISO = new Date(dt.getTime() - tzOffset).toISOString().slice(0,16);

  el.innerHTML =
    '<div style="max-width:320px;width:100%">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">' +
      '<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:20px;' +
        'color:rgba(180,220,200,0.8)">edit entry</div>' +
      '<button onclick="document.getElementById(\'event-edit-overlay\').remove()" ' +
        'style="background:none;border:none;cursor:pointer;font-size:22px;color:var(--rv-text-muted);padding:4px">×</button>' +
    '</div>' +
    // Time editor — editable for all event types
    '<div style="margin-bottom:16px">' +
      '<div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1px;' +
        'text-transform:uppercase;color:var(--rv-text-muted);margin-bottom:6px">when</div>' +
      '<input id="ee-time" type="datetime-local" value="' + dtLocalISO + '" ' +
        'style="width:100%;padding:9px 12px;border-radius:8px;border:1px solid var(--rv-panel-border);' +
        'background:var(--rv-input-bg);font-family:\'DM Mono\',monospace;font-size:13px;' +
        'color:rgba(200,220,240,0.8);outline:none;box-sizing:border-box">' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:20px">' +
      '<div>' +
        '<div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1px;' +
          'text-transform:uppercase;color:rgba(255,140,50,0.5);margin-bottom:5px">carbs (g)</div>' +
        '<input id="ee-carbs" type="number" value="' + (ev.c||0) + '" min="0" max="200" step="1" ' +
          'style="width:100%;padding:10px;border-radius:8px;border:1px solid rgba(255,140,50,0.2);' +
          'background:rgba(255,140,50,0.05);font-family:\'DM Mono\',monospace;font-size:16px;' +
          'color:rgba(255,140,50,0.9);text-align:center;outline:none">' +
      '</div>' +
      '<div>' +
        '<div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1px;' +
          'text-transform:uppercase;color:rgba(60,130,220,0.5);margin-bottom:5px">insulin (U)</div>' +
        '<input id="ee-units" type="number" value="' + (ev.u||0) + '" min="0" max="20" step="0.5" ' +
          'style="width:100%;padding:10px;border-radius:8px;border:1px solid rgba(60,130,220,0.2);' +
          'background:rgba(60,130,220,0.05);font-family:\'DM Mono\',monospace;font-size:16px;' +
          'color:rgba(60,130,220,0.9);text-align:center;outline:none">' +
      '</div>' +
      '<div>' +
        '<div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1px;' +
          'text-transform:uppercase;color:var(--rv-text-muted);margin-bottom:5px">wait (min)</div>' +
        '<input id="ee-wait" type="number" value="' + (ev.waitMins||0) + '" min="0" max="60" step="5" ' +
          'style="width:100%;padding:10px;border-radius:8px;border:1px solid var(--rv-panel-border);' +
          'background:var(--rv-input-bg);font-family:\'DM Mono\',monospace;font-size:16px;' +
          'color:rgba(200,200,200,0.9);text-align:center;outline:none">' +
      '</div>' +
    '</div>' +
    '<div style="display:flex;gap:8px">' +
      '<button onclick="saveEventEdit(' + eventIdx + ')" ' +
        'style="flex:1;padding:12px;border-radius:10px;border:1px solid rgba(62,180,120,0.3);' +
        'background:rgba(62,180,120,0.08);font-family:\'Fraunces\',serif;font-style:italic;' +
        'font-weight:200;font-size:16px;color:rgba(62,180,120,0.9);cursor:pointer">save</button>' +
      '<button onclick="deleteEvent(' + eventIdx + ')" ' +
        'style="padding:12px 16px;border-radius:10px;border:1px solid rgba(200,60,60,0.2);' +
        'background:transparent;font-family:\'DM Mono\',monospace;font-size:10px;' +
        'color:rgba(200,80,80,0.5);cursor:pointer">delete</button>' +
      '<button onclick="document.getElementById(\'event-edit-overlay\').remove()" ' +
        'style="padding:12px 14px;border-radius:10px;border:1px solid var(--rv-panel-border);' +
        'background:transparent;font-family:\'DM Mono\',monospace;font-size:10px;' +
        'color:var(--rv-close-btn);cursor:pointer">cancel</button>' +
    '</div>' +
    // Food items breakdown (read-only)
    (ev.items && ev.items.length > 0 ?
      '<div style="margin-top:16px;border-top:1px solid rgba(255,255,255,0.07);padding-top:14px">' +
        '<div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1.5px;text-transform:uppercase;color:rgba(180,200,220,0.35);margin-bottom:8px">meal breakdown</div>' +
        ev.items.map(function(item) {
          var gi = item.gi || 55;
          var giC = gi>=70?'rgba(210,80,40,0.6)':gi>=55?'rgba(200,140,30,0.6)':'rgba(60,160,90,0.6)';
          return '<div style="display:flex;justify-content:space-between;align-items:center;' +
            'padding:5px 8px;border-radius:6px;margin-bottom:4px;background:rgba(255,255,255,0.03)">' +
            '<span style="font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(200,220,240,0.7);flex:1">' + item.name + '</span>' +
            (gi ? '<span style="font-family:\'DM Mono\',monospace;font-size:8px;color:' + giC + ';margin-right:8px">GI ' + gi + '</span>' : '') +
            '<span style="font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(62,180,120,0.8)">' + (item.carbs||0).toFixed(1) + 'g</span>' +
          '</div>';
        }).join('') +
      '</div>'
    : '') +
    '</div>';

  document.body.appendChild(el);
}

function saveEventEdit(idx) {
  var c        = parseFloat(document.getElementById('ee-carbs').value) || 0;
  var u        = parseFloat(document.getElementById('ee-units').value) || 0;
  var waitMins = parseInt(document.getElementById('ee-wait').value)    || 0;
  var timeEl   = document.getElementById('ee-time');
  var newT     = timeEl && timeEl.value ? new Date(timeEl.value).getTime() : null;

  if (!BOLUS_EVENTS[idx]) { var el=document.getElementById('event-edit-overlay'); if(el) el.remove(); return; }

  var oldT = BOLUS_EVENTS[idx].t;
  var oldWait = BOLUS_EVENTS[idx].waitMins || 0;

  // --- Apply changes to BOLUS_EVENTS entry ---
  BOLUS_EVENTS[idx].c = c;
  BOLUS_EVENTS[idx].u = u;
  BOLUS_EVENTS[idx].waitMins = waitMins;
  if (newT && newT !== oldT) BOLUS_EVENTS[idx].t = newT;
  var updatedT = BOLUS_EVENTS[idx].t;

  // --- If this is a bolus event (u > 0) and wait changed, reposition linked carb chip ---
  // The carb event sits at bolusT + waitMins*60000. Find it and move it.
  if (u > 0) {
    var oldCarbT = oldT + oldWait * 60000;
    var newCarbT = updatedT + waitMins * 60000;
    if (oldCarbT !== newCarbT) {
      // Reposition in BOLUS_EVENTS
      var carbIdx = BOLUS_EVENTS.findIndex(function(e, i) {
        return i !== idx && e.c > 0 && e.u === 0 && Math.abs(e.t - oldCarbT) < 5 * 60000;
      });
      if (carbIdx >= 0) {
        BOLUS_EVENTS[carbIdx].t = newCarbT;
        // Sync carb event through SESSION and LOGGED_EVENTS too
        var csi = SESSION.findIndex(function(s){ return Math.abs(s.t - oldCarbT) < 5*60000 && s.c > 0 && !s.u; });
        if (csi >= 0) SESSION[csi].t = newCarbT;
        var cli = LOGGED_EVENTS.findIndex(function(s){ return Math.abs(s.t - oldCarbT) < 5*60000 && s.c > 0 && !s.u; });
        if (cli >= 0) LOGGED_EVENTS[cli].t = newCarbT;
      }
    }
  }

  // --- Sync the edited event through SESSION ---
  var si = SESSION.findIndex(function(s){ return s.t === oldT; });
  if (si >= 0) {
    SESSION[si].c = c; SESSION[si].u = u;
    if (newT && newT !== oldT) SESSION[si].t = updatedT;
  }
  try { localStorage.setItem('river_session', JSON.stringify(SESSION)); } catch(e) {}

  // --- Sync through LOGGED_EVENTS ---
  var li = LOGGED_EVENTS.findIndex(function(s){ return s.t === oldT; });
  if (li >= 0) {
    LOGGED_EVENTS[li].c = c; LOGGED_EVENTS[li].u = u;
    if (newT && newT !== oldT) LOGGED_EVENTS[li].t = updatedT;
  }
  try { localStorage.setItem('river_logged', JSON.stringify(LOGGED_EVENTS)); } catch(e) {}

  var el = document.getElementById('event-edit-overlay');
  if (el) el.remove();
  showToast('entry updated');

  // ── Sync edit to Supabase ────────────────────────────────────────────
  if (SUPABASE_READY) {
    var updatedEv = BOLUS_EVENTS[idx];
    if (!updatedEv) return;

    if (newT && newT !== oldT) {
      // Time changed: delete old row (by old t) and insert new row (new t)
      // Also add old t to blocklist so syncPull doesn't re-add it
      _deletedEventTs.add(oldT);
      _saveDeletedTs();
      _sbFetch('events?t=eq.' + oldT, { method: 'DELETE', prefer: 'return=minimal' })
        .catch(function(e){ console.warn('[edit] delete old row failed:', e.message); });
      var newRow = {
        t: updatedT, c: c, u: u, gi: updatedEv.gi || null,
        note: updatedEv.note || null, items: updatedEv.items || null,
        device_id: _deviceId, updated_at: new Date().toISOString(),
      };
      _sbFetch('events?on_conflict=t', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=minimal',
        body:   [newRow],
      }).catch(function(e){ console.warn('[edit] insert updated row failed:', e.message); });

      // If carb event was repositioned, also delete/re-insert its Supabase row
      if (u > 0) {
        var oldCarbT2 = oldT + (BOLUS_EVENTS[idx] ? (BOLUS_EVENTS[idx].waitMins || waitMins) : waitMins) * 60000;
        // find the carb event we moved
        var movedCarb = BOLUS_EVENTS.find(function(e, i){ return i !== idx && e.c > 0 && !e.u && Math.abs(e.t - (updatedT + waitMins * 60000)) < 5 * 60000; });
        if (movedCarb) {
          var oldCarbRow_t = oldT + oldWait * 60000;
          _deletedEventTs.add(oldCarbRow_t);
          _saveDeletedTs();
          _sbFetch('events?t=eq.' + oldCarbRow_t, { method: 'DELETE', prefer: 'return=minimal' })
            .catch(function(e){ console.warn('[edit] delete old carb row failed:', e.message); });
          var newCarbRow = {
            t: movedCarb.t, c: movedCarb.c, u: 0, gi: movedCarb.gi || null,
            note: movedCarb.note || null, items: movedCarb.items || null,
            device_id: _deviceId, updated_at: new Date().toISOString(),
          };
          _sbFetch('events?on_conflict=t', {
            method: 'POST',
            prefer: 'resolution=merge-duplicates,return=minimal',
            body:   [newCarbRow],
          }).catch(function(e){ console.warn('[edit] insert updated carb row failed:', e.message); });
        }
      }
    } else {
      // Time unchanged: PATCH existing row
      var patch = { c: c, u: u, updated_at: new Date().toISOString() };
      _sbFetch('events?t=eq.' + updatedT, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body:   patch,
      }).catch(function(e){ console.warn('[edit] patch failed:', e.message); });
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// BLOOD PRICK LOGGING
// ══════════════════════════════════════════════════════════════════════

var BLOOD_PRICKS = (function() {
  try { return JSON.parse(localStorage.getItem('river_pricks') || '[]'); } catch(e) { return []; }
})();

var _deletedPrickTs = (function() {
  try {
    var arr = JSON.parse(localStorage.getItem('river_deleted_pricks') || '[]');
    var cutoff = Date.now() - 30 * 86400000;
    return new Set(arr.filter(function(t){ return t > cutoff; }));
  } catch(e) { return new Set(); }
})();

function _savePricks() {
  try { localStorage.setItem('river_pricks', JSON.stringify(BLOOD_PRICKS)); } catch(e) {}
}

function _saveDeletedPrickTs() {
  try {
    var cutoff = Date.now() - 30 * 86400000;
    var arr = Array.from(_deletedPrickTs).filter(function(t){ return t > cutoff; });
    localStorage.setItem('river_deleted_pricks', JSON.stringify(arr));
    _deletedPrickTs = new Set(arr);
  } catch(e) {}
}

async function syncPullPricks() {
  if (!SUPABASE_READY) return;
  var sinceT = Date.now() - 7 * 86400000;
  try {
    var rows = await _sbFetch('events?note=eq.prick&t=gte.' + sinceT + '&order=t.desc', {});
    if (!Array.isArray(rows)) return;
    rows.forEach(function(row) {
      if (_deletedPrickTs.has(row.t)) return;
      var exists = BLOOD_PRICKS.findIndex(function(p){ return Math.abs(p.t - row.t) < 5000; });
      if (exists < 0) {
        BLOOD_PRICKS.push({ t: row.t, bg: row.gi || 0, logged_by: row.device_id || 'unknown' });
      }
    });
    BLOOD_PRICKS.sort(function(a,b){ return a.t - b.t; });
    _savePricks();
  } catch(e) { console.warn('[syncPullPricks]', e.message); }
}

// Canvas hitbox array, registered during draw
var _prickCards = [];

function drawBloodPricks() {
  if (!BLOOD_PRICKS || BLOOD_PRICKS.length === 0) return;
  _prickCards = [];
  var cutoff = Date.now() - 7 * 86400000;

  BLOOD_PRICKS.forEach(function(p) {
    if (!p.t || !p.bg || p.t < cutoff) return;
    var px = tX(p.t);
    if (px < -20 || px > W + 20) return;

    // CGM value at same timestamp for delta line
    var cgmD = dataAt ? dataAt(p.t) : null;
    var cgmBG = cgmD ? cgmD.bg : null;
    var py = bgToY(p.bg);

    // Dashed delta line to CGM trace if they differ by ≥ 0.3
    if (cgmBG && Math.abs(p.bg - cgmBG) >= 0.3) {
      var cgmY = bgToY(cgmBG);
      CX.save();
      CX.setLineDash([2, 4]);
      CX.strokeStyle = 'rgba(220,80,100,0.35)';
      CX.lineWidth = 1;
      CX.beginPath();
      CX.moveTo(px, py);
      CX.lineTo(px, cgmY);
      CX.stroke();
      CX.setLineDash([]);
      // Anchor dot on CGM trace
      CX.beginPath();
      CX.arc(px, cgmY, 2.5, 0, Math.PI * 2);
      CX.fillStyle = 'rgba(220,80,100,0.5)';
      CX.fill();
      CX.restore();
    }

    // Red diamond ◆
    CX.save();
    CX.translate(px, py);
    CX.rotate(Math.PI / 4);
    CX.beginPath();
    CX.rect(-5, -5, 10, 10);
    CX.fillStyle = 'rgba(220,60,80,0.85)';
    CX.strokeStyle = 'rgba(255,120,140,0.6)';
    CX.lineWidth = 1;
    CX.fill();
    CX.stroke();
    CX.restore();

    // Label above diamond
    CX.save();
    CX.font = "300 9px 'DM Mono',monospace";
    CX.fillStyle = 'rgba(255,140,160,0.8)';
    CX.textAlign = 'center';
    CX.fillText(p.bg.toFixed(1), px, py - 12);
    CX.restore();

    // Register hitbox
    _prickCards.push({ x: px, y: py, prick: p });
  });
}

function openBloodPrickLog() {
  var ex = document.getElementById('prick-overlay');
  if (ex) { ex.remove(); return; }

  var defaultT = _radialDefaultT || Date.now();
  if (_radialDefaultT) _radialDefaultT = null;

  // Get CGM reading at that time for delta hint
  var cgmD = dataAt ? dataAt(defaultT) : null;
  var cgmBG = cgmD ? cgmD.bg.toFixed(1) : null;

  var el = document.createElement('div');
  el.id  = 'prick-overlay';
  el.style.cssText = 'position:fixed;inset:0;z-index:72;background:rgba(20,4,8,0.94);' +
    'backdrop-filter:blur(16px);display:flex;flex-direction:column;align-items:center;' +
    'justify-content:center;padding:28px;opacity:0;transition:opacity .2s;pointer-events:auto';
  el.addEventListener('touchstart', function(e){ e.stopPropagation(); }, {passive:true});
  el.addEventListener('click', function(e){ if(e.target===el) closeBloodPrickLog(); });

  var dt = new Date(defaultT);
  var tzOff = dt.getTimezoneOffset() * 60000;
  var dtISO = new Date(defaultT - tzOff).toISOString().slice(0,16);

  var initialBG = cgmBG || '5.5';

  el.innerHTML =
    '<div style="max-width:300px;width:100%">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">' +
      '<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:22px;color:rgba(255,140,160,0.9)">◆ finger prick</div>' +
      '<button onclick="closeBloodPrickLog()" style="background:none;border:none;cursor:pointer;font-size:22px;color:rgba(180,100,120,0.6);padding:4px">×</button>' +
    '</div>' +

    // mmol/L input with stepper
    '<div style="text-align:center;margin-bottom:20px">' +
      '<div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1.5px;text-transform:uppercase;color:rgba(220,80,100,0.5);margin-bottom:10px">blood glucose mmol/L</div>' +
      '<div style="display:flex;align-items:center;justify-content:center;gap:12px">' +
        '<button onclick="_prickStep(-0.1)" style="width:40px;height:40px;border-radius:10px;border:1px solid rgba(220,80,100,0.3);background:rgba(60,10,20,0.5);font-size:20px;color:rgba(255,120,140,0.9);cursor:pointer;touch-action:manipulation">−</button>' +
        '<input id="prick-bg" type="number" value="' + initialBG + '" min="1.0" max="30.0" step="0.1" inputmode="decimal" ' +
          'style="width:90px;padding:10px;border-radius:10px;border:1px solid rgba(220,80,100,0.4);background:rgba(40,8,16,0.6);' +
          'font-family:\'DM Mono\',monospace;font-size:28px;color:rgba(255,160,180,0.95);text-align:center;outline:none" ' +
          'oninput="_prickValidate()">' +
        '<button onclick="_prickStep(0.1)" style="width:40px;height:40px;border-radius:10px;border:1px solid rgba(220,80,100,0.3);background:rgba(60,10,20,0.5);font-size:20px;color:rgba(255,120,140,0.9);cursor:pointer;touch-action:manipulation">+</button>' +
      '</div>' +
      (cgmBG ? '<div id="prick-delta" style="font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(220,80,100,0.5);margin-top:8px">CGM at this time: ' + cgmBG + ' mmol/L</div>' : '') +
    '</div>' +

    // Time picker
    '<div style="margin-bottom:20px">' +
      '<div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1px;text-transform:uppercase;color:rgba(180,100,120,0.5);margin-bottom:6px">when</div>' +
      '<input id="prick-time" type="datetime-local" value="' + dtISO + '" ' +
        'style="width:100%;padding:9px 12px;border-radius:8px;border:1px solid rgba(220,80,100,0.25);' +
        'background:rgba(30,6,12,0.5);font-family:\'DM Mono\',monospace;font-size:13px;' +
        'color:rgba(200,160,170,0.8);outline:none;box-sizing:border-box">' +
    '</div>' +

    '<div id="prick-err" style="font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(255,100,80,0.9);min-height:16px;margin-bottom:10px;text-align:center"></div>' +

    '<button id="prick-log-btn" onclick="logBloodPrick()" ' +
      'style="width:100%;padding:13px;border-radius:10px;border:1px solid rgba(220,80,100,0.35);' +
      'background:rgba(80,10,25,0.4);font-family:\'Fraunces\',serif;font-style:italic;' +
      'font-weight:200;font-size:17px;color:rgba(255,140,160,0.9);cursor:pointer;margin-bottom:10px">log prick</button>' +
    '<div style="text-align:center"><button onclick="closeBloodPrickLog()" ' +
      'style="background:none;border:none;cursor:pointer;font-family:\'DM Mono\',monospace;font-size:9px;' +
      'letter-spacing:1px;text-transform:uppercase;color:rgba(180,80,100,0.4);padding:6px">cancel</button></div>' +
    '</div>';

  document.body.appendChild(el);
  requestAnimationFrame(function(){ el.style.opacity = '1'; });
  setTimeout(function(){ var inp = document.getElementById('prick-bg'); if(inp) inp.focus(); }, 300);
}

function closeBloodPrickLog() {
  var el = document.getElementById('prick-overlay');
  if (el) { el.style.opacity = '0'; setTimeout(function(){ el.remove(); }, 220); }
}

function _prickStep(delta) {
  var inp = document.getElementById('prick-bg');
  if (!inp) return;
  var v = Math.round(((parseFloat(inp.value) || 5.0) + delta) * 10) / 10;
  inp.value = Math.max(1.0, Math.min(30.0, v)).toFixed(1);
  _prickValidate();
}

function _prickValidate() {
  var inp = document.getElementById('prick-bg');
  var btn = document.getElementById('prick-log-btn');
  var err = document.getElementById('prick-err');
  if (!inp) return;
  var v = parseFloat(inp.value);
  var bad = isNaN(v) || v < 1.0 || v > 30.0;
  if (err) err.textContent = bad ? '⚠️ enter a value between 1.0 – 30.0 mmol/L' : '';
  if (btn) btn.disabled = bad;
}

function logBloodPrick() {
  var inp = document.getElementById('prick-bg');
  var tEl = document.getElementById('prick-time');
  if (!inp) return;
  var bg = Math.round(parseFloat(inp.value) * 10) / 10;
  if (isNaN(bg) || bg < 1.0 || bg > 30.0) { _prickValidate(); return; }
  var t  = tEl && tEl.value ? new Date(tEl.value).getTime() : Date.now();

  var prick = { t: t, bg: bg, logged_by: _thisPersonId || 'unknown' };
  BLOOD_PRICKS.push(prick);
  BLOOD_PRICKS.sort(function(a,b){ return a.t - b.t; });
  _savePricks();

  // Push to Supabase via events table (note:'prick', gi=bg value)
  if (SUPABASE_READY) {
    _sbFetch('events?on_conflict=t', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: [{ t: t, c: 0, u: 0, gi: bg, note: 'prick',
               device_id: _deviceId, updated_at: new Date().toISOString() }],
    }).catch(function(e){ console.warn('[prick push]', e.message); });
  }

  closeBloodPrickLog();
  showToast('◆ ' + bg.toFixed(1) + ' mmol/L logged');
}

function openPrickEditor(prick) {
  var ex = document.getElementById('prick-edit-overlay');
  if (ex) ex.remove();

  var dt = new Date(prick.t);
  var tzOff = dt.getTimezoneOffset() * 60000;
  var dtISO = new Date(prick.t - tzOff).toISOString().slice(0,16);

  var el = document.createElement('div');
  el.id = 'prick-edit-overlay';
  el.style.cssText = 'position:fixed;inset:0;z-index:80;background:rgba(20,4,8,0.94);' +
    'backdrop-filter:blur(16px);display:flex;flex-direction:column;align-items:center;' +
    'justify-content:center;padding:28px;pointer-events:auto';
  el.addEventListener('click', function(e){ if(e.target===el) el.remove(); });

  el.innerHTML =
    '<div style="max-width:280px;width:100%">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px">' +
      '<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:20px;color:rgba(255,140,160,0.9)">edit prick</div>' +
      '<button onclick="document.getElementById(\'prick-edit-overlay\').remove()" style="background:none;border:none;cursor:pointer;font-size:22px;color:rgba(180,100,120,0.6);padding:4px">×</button>' +
    '</div>' +
    '<div style="margin-bottom:14px">' +
      '<div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1px;text-transform:uppercase;color:rgba(180,100,120,0.5);margin-bottom:6px">mmol/L</div>' +
      '<input id="pe-bg" type="number" value="' + prick.bg.toFixed(1) + '" min="1.0" max="30.0" step="0.1" ' +
        'style="width:100%;padding:10px;border-radius:8px;border:1px solid rgba(220,80,100,0.3);' +
        'background:rgba(30,6,12,0.5);font-family:\'DM Mono\',monospace;font-size:22px;' +
        'color:rgba(255,160,180,0.9);text-align:center;outline:none;box-sizing:border-box">' +
    '</div>' +
    '<div style="margin-bottom:18px">' +
      '<div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1px;text-transform:uppercase;color:rgba(180,100,120,0.5);margin-bottom:6px">when</div>' +
      '<input id="pe-time" type="datetime-local" value="' + dtISO + '" ' +
        'style="width:100%;padding:9px 12px;border-radius:8px;border:1px solid rgba(220,80,100,0.2);' +
        'background:rgba(30,6,12,0.5);font-family:\'DM Mono\',monospace;font-size:13px;' +
        'color:rgba(200,160,170,0.8);outline:none;box-sizing:border-box">' +
    '</div>' +
    '<div style="display:flex;gap:8px">' +
      '<button onclick="savePrickEdit(' + prick.t + ')" style="flex:1;padding:12px;border-radius:10px;border:1px solid rgba(220,80,100,0.3);background:rgba(60,8,20,0.4);font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:16px;color:rgba(255,140,160,0.9);cursor:pointer">save</button>' +
      '<button onclick="deletePrick(' + prick.t + ')" style="padding:12px 14px;border-radius:10px;border:1px solid rgba(200,60,60,0.2);background:transparent;font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(200,80,80,0.5);cursor:pointer">delete</button>' +
      '<button onclick="document.getElementById(\'prick-edit-overlay\').remove()" style="padding:12px 12px;border-radius:10px;border:1px solid var(--rv-panel-border);background:transparent;font-family:\'DM Mono\',monospace;font-size:10px;color:var(--rv-close-btn);cursor:pointer">cancel</button>' +
    '</div></div>';

  document.body.appendChild(el);
}

function savePrickEdit(oldT) {
  var bgEl = document.getElementById('pe-bg');
  var tEl  = document.getElementById('pe-time');
  var bg   = bgEl ? Math.round(parseFloat(bgEl.value) * 10) / 10 : null;
  var newT = tEl && tEl.value ? new Date(tEl.value).getTime() : oldT;
  if (!bg || isNaN(bg) || bg < 1 || bg > 30) { showToast('invalid value'); return; }

  var idx = BLOOD_PRICKS.findIndex(function(p){ return p.t === oldT; });
  if (idx < 0) { var el = document.getElementById('prick-edit-overlay'); if(el) el.remove(); return; }

  BLOOD_PRICKS[idx].bg = bg;
  BLOOD_PRICKS[idx].t  = newT;
  BLOOD_PRICKS.sort(function(a,b){ return a.t - b.t; });
  _savePricks();

  if (SUPABASE_READY && newT !== oldT) {
    _deletedPrickTs.add(oldT);
    _saveDeletedPrickTs();
    _sbFetch('events?t=eq.' + oldT + '&note=eq.prick', { method:'DELETE', prefer:'return=minimal' }).catch(function(){});
    _sbFetch('events?on_conflict=t', {
      method:'POST', prefer:'resolution=merge-duplicates,return=minimal',
      body:[{ t:newT, c:0, u:0, gi:bg, note:'prick', device_id:_deviceId, updated_at:new Date().toISOString() }]
    }).catch(function(e){ console.warn('[prick edit]', e.message); });
  } else if (SUPABASE_READY) {
    _sbFetch('events?t=eq.' + oldT + '&note=eq.prick', {
      method:'PATCH', prefer:'return=minimal', body:{ gi:bg, updated_at:new Date().toISOString() }
    }).catch(function(e){ console.warn('[prick patch]', e.message); });
  }

  var el = document.getElementById('prick-edit-overlay'); if(el) el.remove();
  showToast('prick updated');
}

function deletePrick(t) {
  BLOOD_PRICKS = BLOOD_PRICKS.filter(function(p){ return p.t !== t; });
  _savePricks();
  _deletedPrickTs.add(t);
  _saveDeletedPrickTs();
  if (SUPABASE_READY) {
    _sbFetch('events?t=eq.' + t + '&note=eq.prick', { method:'DELETE', prefer:'return=minimal' })
      .catch(function(e){ console.warn('[prick delete]', e.message); });
  }
  var el = document.getElementById('prick-edit-overlay'); if(el) el.remove();
  showToast('prick removed');
}

// ── DELETED EVENTS BLOCKLIST — prevents re-pull from Supabase ────────
// Timestamps of locally-deleted events. Persisted to localStorage.
// syncPullEvents skips any row whose t is in this set.
var _deletedEventTs = (function() {
  try { return new Set(JSON.parse(localStorage.getItem('river_deleted_ts')||'[]')); }
  catch(_e) { return new Set(); }
})();
function _saveDeletedTs() {
  try {
    var arr = Array.from(_deletedEventTs).filter(function(t){ return Date.now()-t < 7*86400000; });
    localStorage.setItem('river_deleted_ts', JSON.stringify(arr));
    _deletedEventTs = new Set(arr);
  } catch(_e) {}
}

function deleteEvent(idx) {
  var ev = BOLUS_EVENTS[idx];
  var t  = ev && ev.t;
  BOLUS_EVENTS.splice(idx, 1);
  if (t) {
    SESSION       = SESSION.filter(function(s){ return s.t !== t; });
    LOGGED_EVENTS = LOGGED_EVENTS.filter(function(s){ return s.t !== t; });
    try { localStorage.setItem('river_session', JSON.stringify(SESSION)); } catch(_e) {}
    try { localStorage.setItem('river_logged',  JSON.stringify(LOGGED_EVENTS)); } catch(_e) {}

    // Add to blocklist so it isn't re-pulled from Supabase
    _deletedEventTs.add(t);
    _saveDeletedTs();

    // Flush bubble cache so frog-spawn orbs clear immediately
    _ptCache = null;
    _lastPTSet = '';
    _curveBubbles.forEach(function(b){ b._dying = true; });

    // Delete from Supabase (best-effort — blocklist protects if this fails)
    if (SUPABASE_READY) {
      _sbFetch('events?t=eq.' + t, { method: 'DELETE', prefer: 'return=minimal' })
        .catch(function(e){ console.warn('[delete] Supabase delete failed:', e.message); });
    }
  }
  var el = document.getElementById('event-edit-overlay');
  if (el) el.remove();
  showToast('entry removed');
}

function openSettings() {
  // If tray already open, close it
  var ex = document.getElementById('settings-tray');
  if (ex) { closeSettingsTray(); return; }
  openSettingsTray();
}

function openSettingsTray() {
  var ex = document.getElementById('settings-tray');
  if (ex) { ex.remove(); }

  var tray = document.createElement('div');
  tray.id  = 'settings-tray';

  var safeBottom = 'max(72px, calc(env(safe-area-inset-bottom, 0px) + 72px))';
  tray.style.cssText = [
    'position:fixed',
    'bottom:' + safeBottom,
    'left:8px',
    'z-index:55',
    'display:flex',
    'flex-direction:column',
    'gap:5px',
    'pointer-events:auto',
    'opacity:0',
    'transform:translateY(12px)',
    'transition:opacity .2s, transform .2s',
  ].join(';');

  var items = [
    { label: 'debug',        icon: '⬡', fn: function(){ closeSettingsTray(); openDebugPanel(); },       col: 'rgba(120,180,120,0.8)' },
    { label: 'team',         icon: '◉', fn: function(){ closeSettingsTray(); openPeopleInFlow(); },     col: 'rgba(100,160,220,0.8)' },
    { label: 'cgm',          icon: '◎', fn: function(){ closeSettingsTray(); openCGMSettings(); },      col: 'rgba(80,200,180,0.8)'  },
    { label: 'food library', icon: '◌', fn: function(){ closeSettingsTray(); openFoodManager(); },      col: 'rgba(220,150,60,0.8)'  },
    { label: 'treatment',    icon: '◈', fn: function(){ closeSettingsTray(); openTreatmentPanel(); },   col: 'rgba(180,100,220,0.8)' },
    { label: 'insights',     icon: '◧', fn: function(){ closeSettingsTray(); openInsightsPanel(); },     col: 'rgba(255,180,80,0.8)'  },
    { label: 'visuals',      icon: '◐', fn: function(){ openVisualSettings(); },                         col: 'rgba(180,140,240,0.8)' },
  ];

  // Build items in reverse so they stack upward
  items.slice().reverse().forEach(function(item, ri) {
    var i = items.length - 1 - ri;
    var btn = document.createElement('button');
    btn.style.cssText = [
      'display:flex',
      'align-items:center',
      'gap:10px',
      'padding:9px 14px 9px 10px',
      'border-radius:20px',
      'border:1px solid ' + item.col.replace('0.8','0.25'),
      'background:var(--rv-panel-bg)',
      'backdrop-filter:blur(14px)',
      'cursor:pointer',
      "font-family:'DM Mono',monospace",
      'font-size:10px',
      'letter-spacing:0.5px',
      'text-transform:uppercase',
      'color:var(--rv-text-secondary)',
      'white-space:nowrap',
      'opacity:0',
      'transform:translateX(-8px)',
      'transition:opacity .18s ' + (ri * 0.04) + 's, transform .18s ' + (ri * 0.04) + 's',
      '-webkit-tap-highlight-color:transparent',
    ].join(';');
    btn.innerHTML =
      '<span style="font-size:14px;color:' + item.col + '">' + item.icon + '</span>' +
      '<span>' + item.label + '</span>';
    btn.addEventListener('click', item.fn);
    tray.appendChild(btn);
    setTimeout(function(){ btn.style.opacity='1'; btn.style.transform='translateX(0)'; }, 20);
  });

  // Backdrop to close
  var backdrop = document.createElement('div');
  backdrop.id = 'settings-tray-backdrop';
  backdrop.style.cssText = 'position:fixed;inset:0;z-index:54;pointer-events:auto';
  backdrop.addEventListener('click', closeSettingsTray);
  document.body.appendChild(backdrop);

  document.body.appendChild(tray);
  setTimeout(function(){ tray.style.opacity='1'; tray.style.transform='translateY(0)'; }, 10);
}


// ── VISUAL SETTINGS — background, trend line, carb palette, insulin colour ──
function openVisualSettings() {
  closeSettingsTray();
  var ex = document.getElementById('visual-settings-overlay');
  if (ex) { ex.remove(); return; }

  var el = document.createElement('div');
  el.id = 'visual-settings-overlay';
  el.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:80',
    'background:var(--rv-panel-bg)',
    'backdrop-filter:blur(18px)',
    'overflow-y:auto', '-webkit-overflow-scrolling:touch',
    'display:flex', 'flex-direction:column', 'align-items:center',
    'padding:48px 20px 60px',
    'opacity:0', 'transition:opacity .2s', 'pointer-events:auto',
  ].join(';');
  el.addEventListener('touchstart', function(e){ e.stopPropagation(); }, {passive:true});

  // ── helpers ──────────────────────────────────────────────────────
  function mono(s) { return "font-family:'DM Mono',monospace;font-size:" + (s||10) + "px"; }

  function hexToRgb(hex) {
    var r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    return [r,g,b];
  }
  function rgbToHex(arr) {
    return '#' + arr.map(function(v){ return Math.round(Math.max(0,Math.min(255,v))).toString(16).padStart(2,'0'); }).join('');
  }

  var vp = RIVER_VISUAL_PREFS;

  // Current/default values
  var curBg      = vp.bgTint  || '#060914';
  var curLine    = vp.bgLine  ? rgbToHex(vp.bgLine)  : '#64dca0';
  var curIOB     = vp.iobR    ? rgbToHex(vp.iobR)    : '#3c82dc';
  var curCarbHot = vp.carbHot ? rgbToHex(vp.carbHot) : '#ffd228';
  var curCarbCool= vp.carbCool? rgbToHex(vp.carbCool): '#5a64c8';

  // ── heading ──────────────────────────────────────────────────────
  var html = '';
  html += '<div style="width:100%;max-width:420px">';
  html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:28px">';
  html += '<div style="font-family:\'Fraunces\',serif;font-weight:200;font-style:italic;font-size:22px;color:var(--rv-text-primary)">visual settings</div>';
  html += '<button onclick="document.getElementById(\'visual-settings-overlay\').remove()" style="background:none;border:none;cursor:pointer;font-size:22px;color:var(--rv-close-btn);padding:4px">×</button>';
  html += '</div>';

  // ── section helper ────────────────────────────────────────────────
  function section(label, content) {
    return '<div style="margin-bottom:24px">' +
      '<div style="' + mono(9) + ';letter-spacing:1px;text-transform:uppercase;color:var(--rv-close-btn);margin-bottom:10px">' + label + '</div>' +
      content +
      '</div>';
  }
  function swatchRow(id, label, value, note) {
    return '<div style="display:flex;align-items:center;justify-content:space-between;' +
      'padding:11px 14px;border-radius:10px;background:var(--rv-input-bg);' +
      'border:1px solid var(--rv-panel-border);margin-bottom:8px">' +
      '<div>' +
        '<div style="' + mono(11) + ';color:var(--rv-text-secondary)">' + label + '</div>' +
        (note ? '<div style="' + mono(9) + ';color:var(--rv-close-btn);margin-top:2px">' + note + '</div>' : '') +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:8px">' +
        '<div style="width:26px;height:26px;border-radius:6px;background:' + value + ';border:1px solid var(--rv-panel-border);cursor:pointer" onclick="document.getElementById(\'' + id + '-picker\').click()"></div>' +
        '<input type="color" id="' + id + '-picker" value="' + value + '" style="width:0;height:0;opacity:0;border:none;padding:0">' +
      '</div>' +
      '</div>';
  }

  // Background tint
  html += section('background', swatchRow('bg', 'void colour', curBg, 'overall canvas dark tone'));

  // Trend line
  html += section('glucose trend line',
    swatchRow('line', 'in-range colour', curLine, 'colour when BG is within target') +
    '<div style="' + mono(9) + ';color:var(--rv-text-dim);padding:4px 4px 0">low → amber, high → warm white — these adapt automatically</div>'
  );

  // Insulin
  html += section('insulin (iob)', swatchRow('iob', 'insulin colour', curIOB, 'teardrops and reservoir'));

  // Carb palette
  html += section('carb palette',
    '<div style="margin-bottom:8px">' +
      swatchRow('carbHot', 'fast carbs (GI 100)', curCarbHot, 'jelly beans, glucose tabs, juice') +
      swatchRow('carbCool', 'slow carbs (GI 0)', curCarbCool, 'lentils, whole grain, low-GI foods') +
    '</div>' +
    '<div id="gi-ramp-preview" style="height:10px;border-radius:5px;margin-bottom:6px;border:1px solid var(--rv-panel-border)"></div>' +
    '<div style="display:flex;justify-content:space-between;' + mono(8) + ';color:var(--rv-text-dim)">' +
      '<span>GI 100</span><span>GI 50</span><span>GI 0</span>' +
    '</div>'
  );

  // Label opacity
  var curOpacity = vp.labelOpacity !== undefined ? vp.labelOpacity : 0.7;
  html += section('canvas labels',
    '<div style="display:flex;align-items:center;justify-content:space-between;' +
    'padding:11px 14px;border-radius:10px;background:var(--rv-input-bg);' +
    'border:1px solid var(--rv-panel-border);margin-bottom:8px">' +
      '<div>' +
        '<div style="font-family:\'DM Mono\',monospace;font-size:11px;color:var(--rv-text-secondary)">label weight</div>' +
        '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:var(--rv-text-muted);margin-top:2px">BG number, time labels, pebble text</div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:8px">' +
        '<span style="font-family:\'DM Mono\',monospace;font-size:9px;color:var(--rv-text-muted)">ghost</span>' +
        '<input type="range" id="label-opacity" min="0.1" max="1" step="0.05" value="' + curOpacity + '" ' +
          'style="width:80px;accent-color:var(--rv-text-secondary)">' +
        '<span style="font-family:\'DM Mono\',monospace;font-size:9px;color:var(--rv-text-muted)">full</span>' +
      '</div>' +
    '</div>'
  );

  // Preset themes
  html += section('quick themes',
    '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">' +
      _vsThemeBtn('river (default)', '#060914', '#64dca0', '#3c82dc', '#ffd228', '#5a64c8') +
      _vsThemeBtn('woodcut', '#100a06', '#c8b090', '#7060b0', '#e8c060', '#8090b0') +
      _vsThemeBtn('ink', '#080808', '#d0d0d0', '#404060', '#e0e0e0', '#606080') +
      _vsThemeBtn('dawn', '#100810', '#f0a080', '#4060c0', '#f8c040', '#a070d0') +
      _vsThemeBtn('ocean', '#040e18', '#40c8e0', '#2060c0', '#60e0c0', '#2080a0') +
      _vsThemeBtn('forest', '#040c06', '#80d070', '#306050', '#c0d040', '#405030') +
    '</div>'
  );

  html += '<div style="display:flex;gap:10px;margin-top:8px">';
  html += '<button onclick="applyVisualSettings()" style="flex:1;padding:13px;border-radius:10px;border:1px solid rgba(62,180,120,0.3);background:rgba(62,180,120,0.08);font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:16px;color:rgba(62,180,120,0.9);cursor:pointer">apply</button>';
  html += '<button onclick="resetVisualSettings()" style="padding:13px 16px;border-radius:10px;border:1px solid var(--rv-panel-border);background:transparent;' + mono(10) + ';color:var(--rv-text-muted);cursor:pointer">reset</button>';
  html += '</div>';
  html += '</div>';

  el.innerHTML = html;
  document.body.appendChild(el);
  setTimeout(function(){ el.style.opacity='1'; }, 10);

  _vsUpdateRampPreview();

  // Live preview on swatch change
  ['bg','line','iob','carbHot','carbCool'].forEach(function(id){
    var picker = document.getElementById(id+'-picker');
    if (!picker) return;
    picker.addEventListener('input', function() {
      var swatch = picker.previousElementSibling;
      if (swatch) swatch.style.background = picker.value;
      if (id==='carbHot'||id==='carbCool') _vsUpdateRampPreview();
      // Live token update — re-skin the overlay as bg changes
      if (id==='bg') applyUITokens(picker.value);
    });
  });
}

function _vsThemeBtn(name, bg, line, iob, carbHot, carbCool) {
  var dots = [carbHot, line, iob].map(function(c){
    return '<div style="width:8px;height:8px;border-radius:50%;background:'+c+'"></div>';
  }).join('');
  return '<button onclick="_vsApplyTheme(\''+bg+'\',\''+line+'\',\''+iob+'\',\''+carbHot+'\',\''+carbCool+'\')" ' +
    'style="padding:10px 8px;border-radius:9px;border:1px solid var(--rv-panel-border);' +
    'background:'+bg+';cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:5px">' +
    '<div style="display:flex;gap:4px">'+dots+'</div>' +
    '<div style="font-family:\'DM Mono\',monospace;font-size:8px;color:var(--rv-text-muted)">'+name+'</div>' +
    '</button>';
}

function _vsApplyTheme(bg, line, iob, carbHot, carbCool) {
  function setP(id, val) {
    var p = document.getElementById(id+'-picker');
    var s = p ? p.previousElementSibling : null;
    if (p) p.value = val;
    if (s) s.style.background = val;
  }
  setP('bg', bg); setP('line', line); setP('iob', iob);
  setP('carbHot', carbHot); setP('carbCool', carbCool);
  _vsUpdateRampPreview();
}

function _vsUpdateRampPreview() {
  var preview = document.getElementById('gi-ramp-preview');
  if (!preview) return;
  var hotPicker = document.getElementById('carbHot-picker');
  var coolPicker = document.getElementById('carbCool-picker');
  var hot = hotPicker ? hotPicker.value : '#ffd228';
  var cool = coolPicker ? coolPicker.value : '#5a64c8';
  preview.style.background = 'linear-gradient(to left, '+cool+', #6cb05a, #e06450, #ff8c32, '+hot+')';
}

function applyVisualSettings() {
  function hexToRgbA(id) {
    var p = document.getElementById(id+'-picker');
    if (!p) return null;
    var h = p.value;
    return [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
  }
  var vp = {};
  var bg = document.getElementById('bg-picker');
  if (bg) vp.bgTint = bg.value;
  vp.bgLine   = hexToRgbA('line');
  vp.iobR     = hexToRgbA('iob');
  vp.carbHot  = hexToRgbA('carbHot');
  vp.carbCool = hexToRgbA('carbCool');
  var lop = document.getElementById('label-opacity');
  if (lop) vp.labelOpacity = parseFloat(lop.value);
  RIVER_VISUAL_PREFS = vp;
  saveVisualPrefs();
  applyUITokens(vp.bgTint || '#060914');
  var el = document.getElementById('visual-settings-overlay');
  if (el) { el.style.opacity='0'; setTimeout(function(){ el.remove(); }, 200); }
}

function resetVisualSettings() {
  RIVER_VISUAL_PREFS = {};
  saveVisualPrefs();
  applyUITokens('#060914');
  var el = document.getElementById('visual-settings-overlay');
  if (el) { el.style.opacity='0'; setTimeout(function(){ el.remove(); }, 200); }
}

function closeSettingsTray() {
  var tray     = document.getElementById('settings-tray');
  var backdrop = document.getElementById('settings-tray-backdrop');
  if (tray) {
    tray.style.opacity   = '0';
    tray.style.transform = 'translateY(12px)';
    setTimeout(function(){ if(tray.parentNode) tray.remove(); }, 220);
  }
  if (backdrop) backdrop.remove();
}

function openCGMSettings() {
  const existing = document.getElementById('setup-screen');
  if (existing) existing.remove();
  document.body.insertAdjacentHTML('beforeend', buildSetupScreen());
  _selectedSource = loadCGMConfig()?.sourceId || 'nightscout';
  renderSourceFields(_selectedSource);
  const sc = document.getElementById('setup-screen');
  if (sc) {
    sc.querySelector('div').insertAdjacentHTML('afterbegin',
      '<button onclick="dismissSetup()" style="position:absolute;top:16px;right:16px;' +
      'background:none;border:none;cursor:pointer;font-size:22px;' +
      'color:rgba(40,55,50,0.3)">×</button>');
  }
}

// ── TREATMENT SETTINGS — stored in Supabase settings table ──────────
var _TREATMENT = null; // cached in memory, loaded on open

var _TREATMENT_DEFAULTS = {
  basalDose: 6,
  basalType: 'Degludec',
  hypoThreshold: 3.9,
  hypoCarbs: 15,
  ratios: [
    { period: 'Breakfast',  isf: 6.5, ic: 8.5  },
    { period: 'Lunch',      isf: 7.0, ic: 12   },
    { period: 'Afternoon',  isf: 7.0, ic: 15   },
    { period: 'Evening',    isf: 7.0, ic: 10   },
    { period: 'Overnight',  isf: 6.5, ic: null },
  ]
};

async function _loadTreatmentSettings() {
  // Try Supabase first
  if (SUPABASE_READY) {
    try {
      var res = await _sbFetch('settings?key=eq.treatment&select=value', {});
      if (res && res.length > 0 && res[0].value) {
        _TREATMENT = Object.assign({}, _TREATMENT_DEFAULTS, res[0].value);
        return;
      }
    } catch(e) {}
  }
  // Fall back to localStorage
  try {
    var local = JSON.parse(localStorage.getItem('river_treatment') || 'null');
    if (local) { _TREATMENT = Object.assign({}, _TREATMENT_DEFAULTS, local); return; }
  } catch(e) {}
  _TREATMENT = JSON.parse(JSON.stringify(_TREATMENT_DEFAULTS));
}

async function _saveTreatmentSettings(data) {
  _TREATMENT = data;
  try { localStorage.setItem('river_treatment', JSON.stringify(data)); } catch(e) {}
  if (!SUPABASE_READY) return;
  try {
    await _sbFetch('settings?on_conflict=key', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: [{ key: 'treatment', value: data, updated_at: new Date().toISOString() }],
    });
  } catch(e) { console.warn('[treatment] Supabase save failed:', e.message); }
}

function openTreatmentPanel() {
  var ex = document.getElementById('treatment-overlay');
  if (ex) { ex.remove(); return; }

  var el = document.createElement('div');
  el.id  = 'treatment-overlay';
  el.style.cssText = 'position:fixed;inset:0;z-index:70;background:var(--rv-panel-bg);' +
    'backdrop-filter:blur(16px);overflow-y:auto;-webkit-overflow-scrolling:touch;' +
    'display:flex;flex-direction:column;align-items:center;padding:48px 20px 60px;' +
    'opacity:0;transition:opacity .2s;pointer-events:auto';
  el.addEventListener('touchstart',function(e){e.stopPropagation();},{passive:true});

  el.innerHTML = '<div style="max-width:340px;width:100%">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px">' +
      '<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:22px;color:rgba(180,220,200,0.8)">treatment</div>' +
      '<button onclick="document.getElementById(\'treatment-overlay\').remove()" ' +
        'style="background:none;border:none;cursor:pointer;font-size:22px;color:var(--rv-close-btn);padding:4px">×</button>' +
    '</div>' +
    '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(120,140,160,0.4);text-align:center;margin-bottom:20px">loading…</div>' +
    '</div>';

  document.body.appendChild(el);
  setTimeout(function(){ el.style.opacity = '1'; }, 10);

  // Load then render editable form
  _loadTreatmentSettings().then(function() {
    _renderTreatmentForm(el);
  });
}

function _renderTreatmentForm(el) {
  var t = _TREATMENT;
  var inp = function(id, val, opts) {
    opts = opts || {};
    return '<input id="tr-' + id + '" type="number" value="' + val + '" ' +
      'min="' + (opts.min||0) + '" max="' + (opts.max||99) + '" step="' + (opts.step||0.5) + '" ' +
      'style="width:60px;padding:6px 8px;border-radius:7px;border:1px solid var(--rv-panel-border);' +
      'background:var(--rv-input-bg);font-family:\'DM Mono\',monospace;font-size:13px;' +
      'color:rgba(200,220,240,0.9);text-align:center;outline:none">';
  };

  var labelStyle = 'font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1.5px;' +
    'text-transform:uppercase;margin-bottom:10px;margin-top:20px';
  var rowStyle = 'display:flex;align-items:center;justify-content:space-between;' +
    'padding:10px 14px;border-radius:10px;background:var(--rv-input-bg);' +
    'border:1px solid var(--rv-panel-border);margin-bottom:8px;' +
    'font-family:\'DM Mono\',monospace;font-size:11px';

  var ratioRows = t.ratios.map(function(row, i) {
    return '<div style="' + rowStyle + '">' +
      '<span style="color:rgba(140,180,220,0.6);font-size:9px;text-transform:uppercase;letter-spacing:1px;width:90px">' + row.period + '</span>' +
      '<div style="display:flex;align-items:center;gap:4px">' +
        '<span style="font-size:9px;color:rgba(255,150,50,0.5)">I:C 1:</span>' +
        inp('ic-' + i, row.ic || '', {min:1, max:30, step:0.5}) +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:4px">' +
        '<span style="font-size:9px;color:rgba(80,140,220,0.5)">ISF 1:</span>' +
        inp('isf-' + i, row.isf, {min:1, max:20, step:0.5}) +
      '</div>' +
    '</div>';
  }).join('');

  el.querySelector('div').innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px">' +
      '<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:22px;color:rgba(180,220,200,0.8)">treatment</div>' +
      '<button onclick="document.getElementById(\'treatment-overlay\').remove()" ' +
        'style="background:none;border:none;cursor:pointer;font-size:22px;color:var(--rv-close-btn);padding:4px">×</button>' +
    '</div>' +

    '<div style="' + labelStyle + 'color:rgba(80,140,220,0.5)">basal</div>' +
    '<div style="' + rowStyle + '">' +
      '<span style="color:rgba(140,180,220,0.6)">Degludec</span>' +
      '<div style="display:flex;align-items:center;gap:6px">' +
        inp('basal', t.basalDose, {min:1, max:80, step:1}) +
        '<span style="font-size:11px;color:rgba(80,140,220,0.6)">U / day</span>' +
      '</div>' +
    '</div>' +

    '<div style="' + labelStyle + 'color:rgba(255,210,40,0.5)">hypo defaults</div>' +
    '<div style="' + rowStyle + '">' +
      '<span style="color:rgba(200,180,80,0.6)">threshold</span>' +
      '<div style="display:flex;align-items:center;gap:6px">' +
        inp('hypo-thr', t.hypoThreshold, {min:2, max:6, step:0.1}) +
        '<span style="font-size:10px;color:rgba(200,180,80,0.5)">mmol/L</span>' +
      '</div>' +
    '</div>' +
    '<div style="' + rowStyle + '">' +
      '<span style="color:rgba(200,180,80,0.6)">treatment</span>' +
      '<div style="display:flex;align-items:center;gap:6px">' +
        inp('hypo-carbs', t.hypoCarbs, {min:5, max:40, step:5}) +
        '<span style="font-size:10px;color:rgba(200,180,80,0.5)">g fast carbs</span>' +
      '</div>' +
    '</div>' +

    '<div style="' + labelStyle + 'color:rgba(255,150,50,0.5)">ratios</div>' +
    ratioRows +

    '<div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1.5px;text-transform:uppercase;color:rgba(100,180,140,0.5);margin-bottom:10px;margin-top:20px">bolus model</div>' +
    '<div style="' + rowStyle + 'color:rgba(200,220,240,0.6)">' +
      '<span style="color:rgba(140,180,160,0.6)">Novorapid</span>' +
      '<span>peak ~75 min</span>' +
      '<span style="color:rgba(100,140,120,0.5)">4hr tail</span>' +
    '</div>' +

    '<button onclick="saveTreatmentForm()" ' +
      'style="width:100%;margin-top:24px;padding:13px;border-radius:10px;' +
      'border:1px solid rgba(62,180,120,0.3);background:rgba(62,180,120,0.08);' +
      'font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:17px;' +
      'color:rgba(62,180,120,0.9);cursor:pointer">save & sync</button>' +

    '<div style="font-family:\'DM Mono\',monospace;font-size:8px;color:rgba(120,140,160,0.3);' +
      'text-align:center;margin-top:16px;line-height:1.6">' +
      'synced across all devices · always confirm with your clinical team' +
    '</div>';
}

function saveTreatmentForm() {
  var get = function(id) { var el = document.getElementById('tr-' + id); return el ? parseFloat(el.value) || 0 : 0; };
  var updated = {
    basalDose: get('basal'),
    basalType: 'Degludec',
    hypoThreshold: get('hypo-thr'),
    hypoCarbs: get('hypo-carbs'),
    ratios: (_TREATMENT || _TREATMENT_DEFAULTS).ratios.map(function(row, i) {
      return { period: row.period, isf: get('isf-' + i), ic: get('ic-' + i) || null };
    })
  };
  _saveTreatmentSettings(updated).then(function() {
    showToast('treatment settings saved ✓');
    var el = document.getElementById('treatment-overlay');
    if (el) el.remove();
  });
}

window.addEventListener('load',()=>{
  // Load any persisted CGM history from previous sessions
  loadPersistedReadings();

  // If no embedded history, start at now
  if (HISTORY_RAW.length === 0) updateCGMBounds();
  viewTime = CGM_END || Date.now();
  viewSpan = 2*3600000;
  try{
    SESSION=JSON.parse(localStorage.getItem('river_session')||'[]'); SESSION=SESSION.filter(s=>(Date.now()-s.t)<6*3600000);
  }catch(e){}
  const pal=palette(CGM_END);
  document.body.style.background='#05070f';
  document.getElementById('loading').style.background='#05070f';

  requestAnimationFrame(ts=>{t0=ts; requestAnimationFrame(frame);});
  setTimeout(()=>{
    document.getElementById('loading').classList.add('gone');
    setTimeout(()=>document.getElementById('loading').style.display='none',700);
  },1000);

  // Start Supabase sync
  startSyncPolling();
  // People in the flow — prompt if first run
  promptPersonIfNeeded();

  // CGM source — auto-connect if configured, show setup if not
  const saved = loadCGMConfig();
  if (saved && saved.sourceId && saved.sourceId !== 'manual') {
    // Re-use saved credentials silently
    setTimeout(()=> startLivePolling(saved.sourceId, saved.fields), 0); // immediate — don't show stale data
  } else if (saved && saved.sourceId === 'manual') {
    // Demo mode — load a scenario then show the scenario selector
    setTimeout(function(){ loadScenario('equilibrium'); }, 400);
    setTimeout(function(){ openDemoSelector(); }, 900);
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

// ═══════════════════════════════════════════════════════════════════════════
// INSIGHTS PANEL
// ═══════════════════════════════════════════════════════════════════════════

function openInsightsPanel() {
  var ex = document.getElementById('insights-overlay');
  if (ex) ex.remove();

  // ── Compute stats ────────────────────────────────────────────────────────
  var readings = HISTORY_RAW.filter(function(r){ return r && r.bg > 0; });
  var pricks   = (function(){
    try{ return JSON.parse(localStorage.getItem('river_pricks')||'[]'); }catch(e){ return []; }
  })();

  var inRange  = readings.filter(function(r){ return r.bg >= 3.9 && r.bg <= 10.0; }).length;
  var belowRange = readings.filter(function(r){ return r.bg < 3.9; }).length;
  var aboveRange = readings.filter(function(r){ return r.bg > 10.0; }).length;
  var total    = readings.length || 1;
  var meanBG   = readings.reduce(function(s,r){return s+r.bg;},0) / total;
  var eA1C     = ((meanBG + 2.59) / 1.59).toFixed(1);
  var tirPct   = Math.round(100 * inRange / total);
  var belPct   = Math.round(100 * belowRange / total);
  var abvPct   = Math.round(100 * aboveRange / total);

  var dateMin  = readings.length ? new Date(readings[0].t).toLocaleDateString('en-GB',{day:'numeric',month:'short'}) : '—';
  var dateMax  = readings.length ? new Date(readings[readings.length-1].t).toLocaleDateString('en-GB',{day:'numeric',month:'short'}) : '—';

  // ── Hourly buckets ───────────────────────────────────────────────────────
  var hourBuckets = [];
  for (var h = 0; h < 24; h++) hourBuckets.push([]);
  readings.forEach(function(r){ hourBuckets[new Date(r.t).getHours()].push(r.bg); });
  pricks.forEach(function(p){ if(p && p.bg && p.t) hourBuckets[new Date(p.t).getHours()].push(p.bg); });
  var hourMeans = hourBuckets.map(function(b){ return b.length ? b.reduce(function(s,v){return s+v;},0)/b.length : null; });
  var hourP10   = hourBuckets.map(function(b){ if(!b.length) return null; var s=[...b].sort(function(a,c){return a-c;}); return s[Math.floor(s.length*0.1)]; });
  var hourP90   = hourBuckets.map(function(b){ if(!b.length) return null; var s=[...b].sort(function(a,c){return a-c;}); return s[Math.floor(s.length*0.9)]; });

  // ── Meal response ────────────────────────────────────────────────────────
  var mealStats = (MEAL_HISTORY||[]).slice(0,8).map(function(m){
    var preMeal  = null, peakRise = null, timeToPeak = null;
    var window2hr = readings.filter(function(r){ return r.t >= m.t && r.t <= m.t + 7200000; });
    if (window2hr.length) {
      var prePts = readings.filter(function(r){ return r.t >= m.t - 600000 && r.t < m.t; });
      preMeal = prePts.length ? prePts[prePts.length-1].bg : window2hr[0].bg;
      var peak = window2hr.reduce(function(best,r){ return r.bg > best.bg ? r : best; }, window2hr[0]);
      peakRise = +(peak.bg - preMeal).toFixed(1);
      timeToPeak = Math.round((peak.t - m.t) / 60000);
    }
    return { name: m.name, totalCarbs: m.totalCarbs, preMeal: preMeal, peakRise: peakRise, timeToPeak: timeToPeak };
  }).filter(function(m){ return m.preMeal !== null; });

  var avgRise = mealStats.length ? (mealStats.reduce(function(s,m){return s+(m.peakRise||0);},0)/mealStats.length).toFixed(1) : '—';
  var avgPeak = mealStats.length ? Math.round(mealStats.reduce(function(s,m){return s+(m.timeToPeak||0);},0)/mealStats.length) : '—';

  // ── Sensor lag ───────────────────────────────────────────────────────────
  var lagPairs = pricks.map(function(p){
    var cgm = readings.find(function(r){ return Math.abs(r.t - p.t) < 600000; });
    return cgm ? { prick: p.bg, cgm: cgm.bg, delta: +(p.bg - cgm.bg).toFixed(1) } : null;
  }).filter(Boolean);
  var meanLag = lagPairs.length ? (lagPairs.reduce(function(s,p){return s+p.delta;},0)/lagPairs.length).toFixed(2) : null;
  var sdLag   = (lagPairs.length > 1) ? (function(){
    var m2 = lagPairs.reduce(function(s,p){return s+p.delta;},0)/lagPairs.length;
    return Math.sqrt(lagPairs.reduce(function(s,p){return s+Math.pow(p.delta-m2,2);},0)/lagPairs.length).toFixed(2);
  })() : null;

  // ── Build HTML ────────────────────────────────────────────────────────────
  var el = document.createElement('div');
  el.id  = 'insights-overlay';
  el.style.cssText = 'position:fixed;inset:0;z-index:90;background:rgba(3,5,20,0.97);' +
    'backdrop-filter:blur(20px);overflow-y:auto;-webkit-overflow-scrolling:touch;' +
    'font-family:"DM Mono",monospace;color:rgba(200,220,240,0.85);';

  var s = '<div style="max-width:540px;margin:0 auto;padding:env(safe-area-inset-top,24px) 20px 80px">';
  s += '<div style="display:flex;justify-content:space-between;align-items:center;' +
    'padding:20px 0 24px;border-bottom:1px solid rgba(255,255,255,0.07);margin-bottom:24px">';
  s += '<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;' +
    'font-size:22px;color:rgba(200,220,240,0.9)">insights</div>';
  s += '<button onclick="document.getElementById(\'insights-overlay\').remove()" ' +
    'style="background:none;border:none;cursor:pointer;font-size:24px;' +
    'color:rgba(200,220,240,0.4);padding:4px">×</button></div>';

  // ── Section 1: Overview ──────────────────────────────────────────────────
  s += '<div style="margin-bottom:28px">';
  s += '<div style="font-size:10px;letter-spacing:1.5px;text-transform:uppercase;' +
    'color:rgba(200,220,240,0.4);margin-bottom:14px">overview · ' + dateMin + ' – ' + dateMax + '</div>';
  s += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:14px">';
  // mean BG
  s += '<div style="background:rgba(255,255,255,0.04);border-radius:10px;padding:14px;text-align:center">';
  s += '<div style="font-size:24px;font-weight:500;color:rgba(62,180,160,0.9)">' + meanBG.toFixed(1) + '</div>';
  s += '<div style="font-size:9px;color:rgba(200,220,240,0.4);margin-top:4px">mean mmol</div></div>';
  // TIR
  s += '<div style="background:rgba(255,255,255,0.04);border-radius:10px;padding:14px;text-align:center">';
  s += '<div style="font-size:24px;font-weight:500;color:rgba(62,180,120,' + (tirPct>=70?'0.9':'0.6') + ')">' + tirPct + '%</div>';
  s += '<div style="font-size:9px;color:rgba(200,220,240,0.4);margin-top:4px">in range</div></div>';
  // eA1C
  s += '<div style="background:rgba(255,255,255,0.04);border-radius:10px;padding:14px;text-align:center">';
  s += '<div style="font-size:24px;font-weight:500;color:rgba(200,180,120,0.8)">' + eA1C + '</div>';
  s += '<div style="font-size:9px;color:rgba(200,220,240,0.4);margin-top:4px">est. A1c%</div></div>';
  s += '</div>';
  s += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">';
  s += '<div style="background:rgba(255,80,80,0.06);border-radius:8px;padding:10px 14px;' +
    'display:flex;justify-content:space-between;align-items:center">';
  s += '<span style="font-size:10px;color:rgba(255,130,100,0.6)">below 3.9</span>';
  s += '<span style="font-size:16px;font-weight:500;color:rgba(255,130,100,0.9)">' + belPct + '%</span></div>';
  s += '<div style="background:rgba(255,180,60,0.06);border-radius:8px;padding:10px 14px;' +
    'display:flex;justify-content:space-between;align-items:center">';
  s += '<span style="font-size:10px;color:rgba(255,180,60,0.6)">above 10</span>';
  s += '<span style="font-size:16px;font-weight:500;color:rgba(255,180,60,0.9)">' + abvPct + '%</span></div>';
  s += '</div>';
  s += '<div style="font-size:9px;color:rgba(200,220,240,0.3);margin-top:10px">' +
    total + ' readings · eA1c is a formula estimate, not a calibrated GMI</div></div>';

  // ── Section 2: 24-hour profile ───────────────────────────────────────────
  s += '<div style="margin-bottom:28px">';
  s += '<div style="font-size:10px;letter-spacing:1.5px;text-transform:uppercase;' +
    'color:rgba(200,220,240,0.4);margin-bottom:14px">24-hour profile</div>';
  s += '<canvas id="insights-hour-canvas" width="500" height="140" style="width:100%;height:auto;' +
    'border-radius:8px;background:rgba(255,255,255,0.03)"></canvas>';
  s += '</div>';

  // ── Section 3: Meal response ─────────────────────────────────────────────
  s += '<div style="margin-bottom:28px">';
  s += '<div style="font-size:10px;letter-spacing:1.5px;text-transform:uppercase;' +
    'color:rgba(200,220,240,0.4);margin-bottom:14px">meal response</div>';
  if (mealStats.length) {
    s += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">';
    s += '<div style="background:rgba(255,255,255,0.04);border-radius:8px;padding:10px 14px">';
    s += '<div style="font-size:18px;font-weight:500;color:rgba(255,160,60,0.9)">+' + avgRise + '</div>';
    s += '<div style="font-size:9px;color:rgba(200,220,240,0.4);margin-top:2px">avg rise (mmol)</div></div>';
    s += '<div style="background:rgba(255,255,255,0.04);border-radius:8px;padding:10px 14px">';
    s += '<div style="font-size:18px;font-weight:500;color:rgba(120,180,255,0.9)">' + avgPeak + 'min</div>';
    s += '<div style="font-size:9px;color:rgba(200,220,240,0.4);margin-top:2px">avg time to peak</div></div>';
    s += '</div>';
    s += '<div style="border-radius:8px;overflow:hidden;border:1px solid rgba(255,255,255,0.06)">';
    mealStats.forEach(function(m, i){
      var rise = m.peakRise || 0;
      var col  = rise < 2.5 ? 'rgba(62,180,120,0.8)' : rise < 4.5 ? 'rgba(255,180,60,0.8)' : 'rgba(255,100,80,0.8)';
      s += '<div style="display:grid;grid-template-columns:1fr auto auto;gap:12px;align-items:center;' +
        'padding:10px 14px;' + (i % 2 === 0 ? 'background:rgba(255,255,255,0.02)' : '') + '">';
      s += '<div style="font-size:10px;color:rgba(200,220,240,0.7);white-space:nowrap;overflow:hidden;' +
        'text-overflow:ellipsis">' + (m.name||'').split('·')[0].trim() + '</div>';
      s += '<div style="font-size:12px;font-weight:500;color:' + col + ';min-width:40px;text-align:right">+' + rise + '</div>';
      s += '<div style="font-size:10px;color:rgba(200,220,240,0.4);min-width:36px;text-align:right">' + (m.timeToPeak||'—') + 'm</div>';
      s += '</div>';
    });
    s += '</div>';
  } else {
    s += '<div style="padding:20px;text-align:center;font-size:11px;color:rgba(200,220,240,0.3);' +
      'border-radius:8px;border:1px dashed rgba(255,255,255,0.08)">no meal data yet — log meals to see response patterns</div>';
  }
  s += '</div>';

  // ── Section 4: Sensor lag ─────────────────────────────────────────────────
  s += '<div style="margin-bottom:28px">';
  s += '<div style="font-size:10px;letter-spacing:1.5px;text-transform:uppercase;' +
    'color:rgba(200,220,240,0.4);margin-bottom:14px">sensor lag · prick vs cgm</div>';
  if (lagPairs.length) {
    s += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">';
    s += '<div style="background:rgba(255,255,255,0.04);border-radius:8px;padding:10px 14px">';
    s += '<div style="font-size:18px;font-weight:500;color:rgba(200,220,240,0.8)">' + (meanLag > 0 ? '+' : '') + meanLag + '</div>';
    s += '<div style="font-size:9px;color:rgba(200,220,240,0.4);margin-top:2px">mean Δ (mmol)</div></div>';
    s += '<div style="background:rgba(255,255,255,0.04);border-radius:8px;padding:10px 14px">';
    s += '<div style="font-size:18px;font-weight:500;color:rgba(200,220,240,0.6)">±' + sdLag + '</div>';
    s += '<div style="font-size:9px;color:rgba(200,220,240,0.4);margin-top:2px">variability (SD)</div></div>';
    s += '</div>';
    if (Math.abs(parseFloat(meanLag)) > 1.0) {
      s += '<div style="padding:10px 14px;border-radius:8px;background:rgba(255,180,60,0.07);' +
        'border:1px solid rgba(255,180,60,0.15);font-size:10px;color:rgba(255,180,60,0.8);' +
        'margin-bottom:14px">CGM reading ' + (parseFloat(meanLag) > 0 ? 'lower' : 'higher') +
        ' than prick by ~' + Math.abs(parseFloat(meanLag)).toFixed(1) +
        ' mmol on average. Lag is more pronounced when BG is rising rapidly.</div>';
    }
    s += '<div style="border-radius:8px;overflow:hidden;border:1px solid rgba(255,255,255,0.06)">';
    lagPairs.slice(0,8).forEach(function(p, i){
      var col = Math.abs(p.delta) < 1.0 ? 'rgba(62,180,120,0.8)' : Math.abs(p.delta) < 2.0 ? 'rgba(255,180,60,0.8)' : 'rgba(255,100,80,0.8)';
      s += '<div style="display:grid;grid-template-columns:1fr auto auto auto;gap:10px;align-items:center;' +
        'padding:9px 14px;' + (i % 2 === 0 ? 'background:rgba(255,255,255,0.02)' : '') + '">';
      s += '<div style="font-size:10px;color:rgba(200,220,240,0.4)">' +
        new Date(pricks[i] && pricks[i].t || Date.now()).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}) + '</div>';
      s += '<div style="font-size:11px;color:rgba(255,200,100,0.8)">' + p.prick.toFixed(1) + '</div>';
      s += '<div style="font-size:11px;color:rgba(120,200,255,0.7)">' + p.cgm.toFixed(1) + '</div>';
      s += '<div style="font-size:11px;font-weight:500;color:' + col + '">' + (p.delta > 0 ? '+' : '') + p.delta + '</div>';
      s += '</div>';
    });
    s += '</div>';
  } else {
    s += '<div style="padding:20px;text-align:center;font-size:11px;color:rgba(200,220,240,0.3);' +
      'border-radius:8px;border:1px dashed rgba(255,255,255,0.08)">no finger prick readings yet — log pricks via the radial menu to build your personal lag profile</div>';
  }
  s += '</div>';

  // ── Section 5: Clinic export ──────────────────────────────────────────────
  s += '<div style="margin-bottom:40px">';
  s += '<div style="font-size:10px;letter-spacing:1.5px;text-transform:uppercase;' +
    'color:rgba(200,220,240,0.4);margin-bottom:14px">clinic export</div>';
  s += '<button onclick="insightsExport()" style="width:100%;padding:14px;border-radius:10px;' +
    'border:1px solid rgba(255,180,80,0.3);background:rgba(255,180,80,0.07);' +
    'font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:17px;' +
    'color:rgba(255,200,100,0.9);cursor:pointer">download clinic report</button>';
  s += '<div style="font-size:9px;color:rgba(200,220,240,0.3);margin-top:8px;text-align:center">' +
    'plain text · not a clinical document · for conversation with your team</div>';
  s += '</div>';

  s += '</div>'; // end max-width wrapper
  el.innerHTML = s;
  document.body.appendChild(el);

  // ── Draw 24-hour canvas ───────────────────────────────────────────────────
  requestAnimationFrame(function(){
    var cv = document.getElementById('insights-hour-canvas');
    if (!cv) return;
    var cx = cv.getContext('2d');
    var W = cv.width, H = cv.height;
    var PAD = { t:12, b:28, l:30, r:12 };
    var CW = W - PAD.l - PAD.r, CH = H - PAD.t - PAD.b;
    var bgMin = 2.0, bgMax = 14.0;
    function xOf(h){ return PAD.l + (h / 23) * CW; }
    function yOf(v){ return PAD.t + (1 - (v - bgMin) / (bgMax - bgMin)) * CH; }

    // target zone band
    cx.fillStyle = 'rgba(62,180,120,0.06)';
    cx.fillRect(PAD.l, yOf(10.0), CW, yOf(3.9) - yOf(10.0));

    // percentile band
    var pts10 = [], pts90 = [];
    for (var h = 0; h < 24; h++) {
      if (hourP10[h] !== null) pts10.push({x: xOf(h), y: yOf(hourP10[h])});
      if (hourP90[h] !== null) pts90.push({x: xOf(h), y: yOf(hourP90[h])});
    }
    if (pts10.length > 1 && pts90.length > 1) {
      cx.beginPath();
      cx.moveTo(pts10[0].x, pts10[0].y);
      pts10.forEach(function(p){ cx.lineTo(p.x, p.y); });
      pts90.slice().reverse().forEach(function(p){ cx.lineTo(p.x, p.y); });
      cx.closePath();
      cx.fillStyle = 'rgba(62,180,160,0.12)';
      cx.fill();
    }

    // mean line
    var meanPts = hourMeans.map(function(v, h){ return v !== null ? {x: xOf(h), y: yOf(v)} : null; }).filter(Boolean);
    if (meanPts.length > 1) {
      cx.beginPath();
      cx.moveTo(meanPts[0].x, meanPts[0].y);
      meanPts.forEach(function(p){ cx.lineTo(p.x, p.y); });
      cx.strokeStyle = 'rgba(62,200,180,0.8)';
      cx.lineWidth = 2;
      cx.stroke();
    }

    // x-axis labels
    cx.fillStyle = 'rgba(180,200,220,0.4)';
    cx.font = '9px "DM Mono",monospace';
    cx.textAlign = 'center';
    [0, 6, 12, 18, 23].forEach(function(h){
      cx.fillText(h + ':00', xOf(h), H - 6);
    });

    // y-axis labels
    cx.textAlign = 'right';
    [4, 7, 10, 13].forEach(function(v){
      cx.fillText(v, PAD.l - 4, yOf(v) + 3);
    });
  });
}

function insightsExport() {
  var readings = HISTORY_RAW.filter(function(r){ return r && r.bg > 0; });
  var pricks   = (function(){ try{ return JSON.parse(localStorage.getItem('river_pricks')||'[]'); }catch(e){ return []; } })();
  var total    = readings.length || 1;
  var meanBG   = readings.reduce(function(s,r){return s+r.bg;},0) / total;
  var inRange  = readings.filter(function(r){ return r.bg >= 3.9 && r.bg <= 10.0; }).length;
  var belowRange = readings.filter(function(r){ return r.bg < 3.9; }).length;
  var aboveRange = readings.filter(function(r){ return r.bg > 10.0; }).length;
  var eA1C     = ((meanBG + 2.59) / 1.59).toFixed(1);
  var dateMin  = readings.length ? new Date(readings[0].t).toLocaleDateString('en-GB') : '—';
  var dateMax  = readings.length ? new Date(readings[readings.length-1].t).toLocaleDateString('en-GB') : '—';

  var lines = [];
  lines.push('OSKAR\'S RIVER — CLINIC REPORT');
  lines.push('Generated: ' + new Date().toLocaleString('en-GB'));
  lines.push('Data range: ' + dateMin + ' – ' + dateMax);
  lines.push('NOT A CLINICAL DOCUMENT — for conversation with your care team only');
  lines.push('');
  lines.push('── GLUCOSE SUMMARY ─────────────────────────────────────────');
  lines.push('Mean BG:          ' + meanBG.toFixed(1) + ' mmol/L');
  lines.push('Time in range:    ' + Math.round(100*inRange/total) + '% (' + inRange + '/' + total + ' readings)');
  lines.push('Below 3.9 mmol:   ' + Math.round(100*belowRange/total) + '% (' + belowRange + ' readings)');
  lines.push('Above 10.0 mmol:  ' + Math.round(100*aboveRange/total) + '% (' + aboveRange + ' readings)');
  lines.push('Estimated A1c:    ' + eA1C + '% (formula estimate — not GMI)');
  lines.push('Total readings:   ' + total);
  lines.push('');

  // Hourly profile
  lines.push('── HOURLY PROFILE ──────────────────────────────────────────');
  lines.push('Hour  Mean    n   In-range');
  var hourBuckets = [];
  for (var h = 0; h < 24; h++) hourBuckets.push([]);
  readings.forEach(function(r){ hourBuckets[new Date(r.t).getHours()].push(r.bg); });
  hourBuckets.forEach(function(b, h){
    if (!b.length) return;
    var m = b.reduce(function(s,v){return s+v;},0)/b.length;
    var ir = b.filter(function(v){ return v>=3.9&&v<=10.0; }).length;
    var hStr = h.toString().padStart(2,'0') + ':00';
    lines.push(hStr + '  ' + m.toFixed(1).padStart(5) + '   ' + b.length.toString().padStart(3) + '   ' + Math.round(100*ir/b.length) + '%');
  });
  lines.push('');

  // Meal log
  lines.push('── MEAL LOG (last 30) ──────────────────────────────────────');
  (MEAL_HISTORY||[]).slice(0,30).forEach(function(m){
    var dt = new Date(m.t).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
    lines.push(dt + '  ' + (m.totalCarbs||0) + 'g  ' + (m.u||0) + 'U  — ' + (m.name||''));
    if (m.items && m.items.length) {
      m.items.forEach(function(i){ lines.push('         ' + (i.name||'') + ' ' + (i.carbs||0) + 'g carbs'); });
    }
  });
  lines.push('');

  // Bolus log
  lines.push('── BOLUS / CORRECTION LOG ──────────────────────────────────');
  (LOGGED_EVENTS||[]).filter(function(e){ return e.u > 0; }).slice(-40).forEach(function(e){
    var dt = new Date(e.t).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
    lines.push(dt + '  ' + e.u.toFixed(1) + 'U  ' + (e.note||'') + '  ' + (e.logged_by||''));
  });
  lines.push('');

  // Prick readings
  if (pricks.length) {
    lines.push('── FINGER PRICK READINGS ───────────────────────────────────');
    pricks.forEach(function(p){
      var dt = new Date(p.t).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
      lines.push(dt + '  ' + p.bg.toFixed(1) + ' mmol/L');
    });
    lines.push('');
  }

  // Hypo events
  var hypos = (LOGGED_EVENTS||[]).filter(function(e){ return e.note && e.note.indexOf('hypo')===0; });
  if (hypos.length) {
    lines.push('── HYPO EVENTS ─────────────────────────────────────────────');
    hypos.forEach(function(e){
      var dt = new Date(e.t).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
      lines.push(dt + '  ' + (e.c||0) + 'g treatment  ' + (e.logged_by||''));
    });
    lines.push('');
  }

  lines.push('────────────────────────────────────────────────────────────');
  lines.push('Oskar\'s River · Insight and capture layer, not clinical decision pathway');
  lines.push('CGM: Libre 3 via Nightscout/Gluroo · MDI · Oskar, T1D, diagnosed Aug 2025');

  var blob = new Blob([lines.join('\n')], {type:'text/plain'});
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  a.href   = url;
  a.download = 'oskar-river-clinic-' + new Date().toISOString().slice(0,10) + '.txt';
  a.click();
  URL.revokeObjectURL(url);
  showToast('clinic report downloaded');
}

// ═══════════════════════════════════════════════════════════════════════════
// PAD SCAN — Photo of handwritten meal notes → food log import
// ═══════════════════════════════════════════════════════════════════════════

var FOOD_ALIASES = (function(){
  try { return JSON.parse(localStorage.getItem('river_food_aliases')||'{}'); }
  catch(e) { return {}; }
})();

function saveAliases() {
  try { localStorage.setItem('river_food_aliases', JSON.stringify(FOOD_ALIASES)); } catch(e) {}
  // Sync to Supabase as a special event row
  var SB_URL = 'https://oafnrfxypmllyvdewztm.supabase.co';
  var SB_KEY = 'sb_publishable_MFxi8_3Nsj4O-8_oSG8a7Q_OwpnjKWy';
  fetch(SB_URL + '/rest/v1/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SB_KEY,
      'Authorization': 'Bearer ' + SB_KEY,
      'Prefer': 'resolution=merge-duplicates'
    },
    body: JSON.stringify({
      t: -9999,
      c: 0, u: 0,
      note: 'aliases:' + JSON.stringify(FOOD_ALIASES),
      logged_by: 'system'
    })
  }).catch(function(){});
}

function loadAliasesFromSupabase() {
  var SB_URL = 'https://oafnrfxypmllyvdewztm.supabase.co';
  var SB_KEY = 'sb_publishable_MFxi8_3Nsj4O-8_oSG8a7Q_OwpnjKWy';
  fetch(SB_URL + '/rest/v1/events?t=eq.-9999&select=note', {
    headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY }
  }).then(function(r){ return r.json(); })
    .then(function(rows){
      if (!rows || !rows.length) return;
      var row = rows[0];
      if (row.note && row.note.indexOf('aliases:') === 0) {
        try {
          var remote = JSON.parse(row.note.slice(8));
          Object.assign(FOOD_ALIASES, remote);
          saveAliases();
        } catch(e) {}
      }
    }).catch(function(){});
}

function resolveScannedFood(name) {
  var n = (name||'').toLowerCase().trim();
  // Check alias map first
  if (FOOD_ALIASES[n]) {
    var aliased = FOOD_ALIASES[n].toLowerCase();
    var found = (FOOD_DB||[]).find(function(f){ return f.name.toLowerCase() === aliased; }) ||
                (FOOD_LIBRARY||[]).find(function(f){ return f.name.toLowerCase() === aliased; });
    if (found) return found;
  }
  // Fuzzy match
  var all = [...(FOOD_DB||[]), ...(FOOD_LIBRARY||[])];
  var exact = all.find(function(f){ return f.name.toLowerCase() === n; });
  if (exact) return exact;
  var partial = all.filter(function(f){ return f.name.toLowerCase().includes(n) || n.includes(f.name.toLowerCase()); });
  return partial.length ? partial[0] : null;
}

function openPadScanInput() {
  var inp = document.getElementById('pad-photo-input');
  if (!inp) {
    inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.capture = 'environment';
    inp.id = 'pad-photo-input';
    inp.style.display = 'none';
    inp.addEventListener('change', function(){
      if (!inp.files || !inp.files[0]) return;
      processPadPhoto(inp.files[0]);
      inp.value = '';
    });
    document.body.appendChild(inp);
  }
  inp.click();
}

function processPadPhoto(file) {
  // Show spinner
  var spinner = document.createElement('div');
  spinner.id = 'pad-spinner';
  spinner.style.cssText = 'position:fixed;inset:0;z-index:200;background:rgba(3,5,20,0.92);' +
    'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
    'font-family:"DM Mono",monospace;color:rgba(200,220,240,0.7);font-size:13px;gap:16px';
  spinner.innerHTML = '<div style="width:32px;height:32px;border:2px solid rgba(255,180,80,0.3);' +
    'border-top-color:rgba(255,180,80,0.9);border-radius:50%;animation:spin 0.8s linear infinite"></div>' +
    '<div>reading your notes…</div>';
  document.body.appendChild(spinner);

  var reader = new FileReader();
  reader.onload = function(ev) {
    var base64 = ev.target.result.split(',')[1];
    var mediaType = file.type || 'image/jpeg';

    fetch('https://orange-surf-6f98.john-king-uk.workers.dev/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64 }
            },
            {
              type: 'text',
              text: 'This is a handwritten meal/diabetes log. Extract ALL of the following if present. ' +
                'Return ONLY valid JSON, no preamble:\n' +
                '{\n' +
                '  "items": [{name, carbs_g, weight_g}],\n' +
                '  "total_carbs": number or null,\n' +
                '  "bg_mmol": number or null,\n' +
                '  "insulin_units": number or null,\n' +
                '  "wait_mins": number or null,\n' +
                '  "meal_label": "breakfast"|"lunch"|"dinner"|"snack"|null,\n' +
                '  "time_written": "HH:MM" or null,\n' +
                '  "date_written": "DD/MM/YYYY" or null\n' +
                '}\n' +
                'Split compound descriptions into individual items. If weight_g is not written, estimate from context. ' +
                'Look carefully for a time written near any BG reading.'
            }
          ]
        }]
      })
    })
    .then(function(r){ return r.json(); })
    .then(function(data){
      var sp = document.getElementById('pad-spinner');
      if (sp) sp.remove();
      var text = (data.content||[]).map(function(c){ return c.text||''; }).join('');
      var clean = text.replace(/```json|```/g,'').trim();
      var first = clean.indexOf('{'), last = clean.lastIndexOf('}');
      if (first < 0 || last < 0) { showToast('couldn\'t read the notes — try a clearer photo'); return; }
      try {
        var parsed = JSON.parse(clean.slice(first, last+1));
        openPadImportScreen(parsed, file);
      } catch(e) {
        showToast('couldn\'t parse the notes — try a clearer photo');
      }
    })
    .catch(function(){
      var sp = document.getElementById('pad-spinner');
      if (sp) sp.remove();
      showToast('scan failed — check your connection');
    });
  };
  reader.readAsDataURL(file);
}

function openPadImportScreen(parsed, file) {
  var ex = document.getElementById('pad-import-overlay');
  if (ex) ex.remove();

  // Infer timestamp
  var inferredT = Date.now();
  if (parsed.time_written) {
    var parts = parsed.time_written.split(':');
    var candidate = new Date();
    candidate.setHours(parseInt(parts[0],10), parseInt(parts[1],10), 0, 0);
    if (candidate.getTime() > Date.now()) candidate.setDate(candidate.getDate() - 1);
    inferredT = candidate.getTime();
  } else if (parsed.date_written) {
    var dp = parsed.date_written.split('/');
    if (dp.length === 3) {
      var mealDefaults = {breakfast:8, lunch:12, dinner:18, snack:15};
      var mealHr = mealDefaults[parsed.meal_label] || 12;
      inferredT = new Date(parseInt(dp[2],10), parseInt(dp[1],10)-1, parseInt(dp[0],10), mealHr, 0, 0).getTime();
    }
  }

  // Build datetime-local string
  var dt2 = new Date(inferredT);
  var tzOff = dt2.getTimezoneOffset() * 60000;
  var dtISO  = new Date(dt2.getTime() - tzOff).toISOString().slice(0,16);

  var items = (parsed.items||[]).map(function(i, idx){
    var match = resolveScannedFood(i.name);
    return {
      raw: i.name,
      grams: i.weight_g || 100,
      carbs: match ? Math.round((match.c100||0) * (i.weight_g||100) / 100) : (i.carbs_g||0),
      matched: !!match,
      match: match,
      gi: match ? (match.gi||55) : 55,
      _gi_override: null,
      idx: idx
    };
  });

  var el = document.createElement('div');
  el.id  = 'pad-import-overlay';
  el.style.cssText = 'position:fixed;inset:0;z-index:150;background:rgba(3,5,20,0.98);' +
    'overflow-y:auto;-webkit-overflow-scrolling:touch;' +
    'font-family:"DM Mono",monospace;color:rgba(200,220,240,0.85);';

  function renderImportScreen() {
    var total = items.reduce(function(s,i){ return s + (parseFloat(i.carbs)||0); }, 0);
    var s = '<div style="max-width:400px;margin:0 auto;padding:env(safe-area-inset-top,24px) 20px 80px">';
    s += '<div style="display:flex;justify-content:space-between;align-items:center;' +
      'padding:20px 0 20px;margin-bottom:16px">';
    s += '<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:20px;' +
      'color:rgba(255,180,80,0.9)">pad import</div>';
    s += '<button onclick="document.getElementById(\'pad-import-overlay\').remove()" ' +
      'style="background:none;border:none;cursor:pointer;font-size:22px;color:rgba(200,220,240,0.4)">×</button></div>';

    // Meal label
    var labels = ['breakfast','lunch','dinner','snack'];
    var curLabel = parsed.meal_label || 'meal';
    s += '<div style="display:flex;gap:8px;margin-bottom:16px">';
    labels.forEach(function(lab){
      var active = lab === curLabel;
      s += '<button onclick="window._padLabel=\'' + lab + '\';document.getElementById(\'pad-import-overlay\').querySelector(\'[data-section]\').innerHTML=\'\'" ' +
        'style="flex:1;padding:7px 4px;border-radius:8px;border:1px solid ' +
        (active ? 'rgba(255,180,80,0.5)' : 'rgba(255,255,255,0.1)') + ';' +
        'background:' + (active ? 'rgba(255,180,80,0.1)' : 'transparent') + ';' +
        'font-family:\'DM Mono\',monospace;font-size:9px;letter-spacing:0.5px;' +
        'color:' + (active ? 'rgba(255,180,80,0.9)' : 'rgba(200,220,240,0.4)') + ';cursor:pointer">' +
        lab + '</button>';
    });
    s += '</div>';

    // Datetime
    s += '<div style="margin-bottom:16px">';
    s += '<div style="font-size:9px;letter-spacing:1px;text-transform:uppercase;' +
      'color:rgba(200,220,240,0.4);margin-bottom:6px">when</div>';
    s += '<input id="pad-import-dt" type="datetime-local" value="' + dtISO + '" ' +
      'style="width:100%;padding:9px 12px;border-radius:8px;border:1px solid rgba(255,255,255,0.1);' +
      'background:rgba(255,255,255,0.05);font-family:\'DM Mono\',monospace;font-size:13px;' +
      'color:rgba(200,220,240,0.8);outline:none;box-sizing:border-box">';
    if (parsed.bg_mmol) {
      s += '<div style="font-size:10px;color:rgba(255,180,80,0.6);margin-top:5px">BG from pad: ' + parsed.bg_mmol + ' mmol</div>';
    }
    s += '</div>';

    // Insulin
    s += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px">';
    s += '<div><div style="font-size:9px;letter-spacing:1px;text-transform:uppercase;' +
      'color:rgba(60,130,220,0.5);margin-bottom:5px">insulin (U)</div>';
    s += '<input id="pad-import-u" type="number" min="0" max="20" step="0.5" ' +
      'value="' + (parsed.insulin_units||0) + '" ' +
      'style="width:100%;padding:10px;border-radius:8px;border:1px solid rgba(60,130,220,0.2);' +
      'background:rgba(60,130,220,0.05);font-family:\'DM Mono\',monospace;font-size:16px;' +
      'color:rgba(60,130,220,0.9);text-align:center;outline:none"></div>';
    s += '<div><div style="font-size:9px;letter-spacing:1px;text-transform:uppercase;' +
      'color:rgba(200,220,240,0.4);margin-bottom:5px">wait (min)</div>';
    s += '<input id="pad-import-wait" type="number" min="0" max="60" step="5" ' +
      'value="' + (parsed.wait_mins||0) + '" ' +
      'style="width:100%;padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.1);' +
      'background:rgba(255,255,255,0.05);font-family:\'DM Mono\',monospace;font-size:16px;' +
      'color:rgba(200,200,200,0.9);text-align:center;outline:none"></div>';
    s += '</div>';

    // Items list
    s += '<div style="font-size:9px;letter-spacing:1px;text-transform:uppercase;' +
      'color:rgba(200,220,240,0.4);margin-bottom:8px">items</div>';
    items.forEach(function(item, idx){
      s += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;' +
        'background:rgba(255,255,255,0.03);border-radius:8px;padding:10px 12px">';
      s += '<div style="flex:1;font-size:11px;color:' +
        (item.matched ? 'rgba(200,220,240,0.8)' : 'rgba(255,180,80,0.7)') + '">' +
        item.raw + (item.matched ? '' : ' ?') + '</div>';
      s += '<input type="number" min="0" max="500" step="1" value="' + Math.round(item.carbs) + '" ' +
        'onchange="window._padItems[' + idx + '].carbs=parseFloat(this.value)||0;window._padUpdateTotal()" ' +
        'style="width:54px;padding:6px;border-radius:6px;border:1px solid rgba(255,140,50,0.2);' +
        'background:rgba(255,140,50,0.05);font-family:\'DM Mono\',monospace;font-size:14px;' +
        'color:rgba(255,140,50,0.9);text-align:center;outline:none">';
      s += '<span style="font-size:9px;color:rgba(200,220,240,0.3)">g</span>';
      if (!item.matched) {
        s += '<button onclick="openAliasLinker(' + idx + ')" ' +
          'style="padding:4px 8px;border-radius:6px;border:1px solid rgba(255,180,80,0.3);' +
          'background:rgba(255,180,80,0.07);font-family:\'DM Mono\',monospace;font-size:9px;' +
          'color:rgba(255,180,80,0.8);cursor:pointer">link</button>';
        s += '<button onclick="openAddFoodFromPad(' + idx + ')" ' +
          'style="padding:4px 8px;border-radius:6px;border:1px solid rgba(62,180,120,0.3);' +
          'background:rgba(62,180,120,0.07);font-family:\'DM Mono\',monospace;font-size:9px;' +
          'color:rgba(62,180,120,0.8);cursor:pointer">+ add</button>';
      }
      s += '<button onclick="window._padItems.splice(' + idx + ',1);window._padRerender()" ' +
        'style="background:none;border:none;cursor:pointer;font-size:14px;' +
        'color:rgba(200,220,240,0.3);padding:2px">×</button>';
      s += '</div>';
    });

    // Total + commit
    s += '<div style="display:flex;justify-content:space-between;align-items:center;' +
      'padding:14px 0;border-top:1px solid rgba(255,255,255,0.06);margin-top:8px;margin-bottom:20px">';
    s += '<div style="font-size:12px;color:rgba(200,220,240,0.5)">total carbs</div>';
    s += '<div id="pad-total" style="font-size:22px;font-weight:500;color:rgba(255,140,50,0.9)">' +
      total.toFixed(0) + 'g</div>';
    s += '</div>';

    s += '<button onclick="commitPadImport()" style="width:100%;padding:14px;border-radius:10px;' +
      'border:1px solid rgba(255,180,80,0.3);background:rgba(255,180,80,0.08);' +
      'font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:18px;' +
      'color:rgba(255,200,100,0.9);cursor:pointer">add to flow</button>';
    s += '</div>';

    el.innerHTML = s;
  }

  // Expose to window for onclick handlers
  window._padItems = items;
  window._padRerender = renderImportScreen;
  window._padUpdateTotal = function(){
    var tot = window._padItems.reduce(function(s,i){ return s+(parseFloat(i.carbs)||0); }, 0);
    var el2 = document.getElementById('pad-total');
    if (el2) el2.textContent = tot.toFixed(0) + 'g';
  };

  renderImportScreen();
  document.body.appendChild(el);
}

function openAliasLinker(itemIdx) {
  var item = window._padItems[itemIdx];
  if (!item) return;
  var all = [...(FOOD_DB||[]), ...(FOOD_LIBRARY||[])];

  var el = document.createElement('div');
  el.id  = 'alias-linker';
  el.style.cssText = 'position:fixed;inset:0;z-index:160;background:rgba(3,5,20,0.95);' +
    'display:flex;flex-direction:column;padding:32px 20px;font-family:"DM Mono",monospace';
  el.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">' +
      '<div style="font-size:14px;color:rgba(255,180,80,0.9)">link "' + item.raw + '" to…</div>' +
      '<button onclick="document.getElementById(\'alias-linker\').remove()" ' +
        'style="background:none;border:none;cursor:pointer;font-size:22px;' +
        'color:rgba(200,220,240,0.4)">×</button>' +
    '</div>' +
    '<input id="alias-search" type="text" placeholder="search food library…" ' +
      'style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid rgba(255,255,255,0.1);' +
      'background:rgba(255,255,255,0.05);font-family:\'DM Mono\',monospace;font-size:13px;' +
      'color:rgba(200,220,240,0.8);outline:none;box-sizing:border-box;margin-bottom:12px">' +
    '<div id="alias-results" style="flex:1;overflow-y:auto"></div>';

  function renderAliasResults(q) {
    var q2 = q.toLowerCase();
    var filtered = q2 ? all.filter(function(f){ return f.name.toLowerCase().includes(q2); }) : all.slice(0,20);
    var res = document.getElementById('alias-results');
    if (!res) return;
    res.innerHTML = filtered.map(function(f){
      return '<div onclick="applyAlias(' + itemIdx + ',\'' + encodeURIComponent(f.name) + '\')" ' +
        'style="padding:12px 14px;border-radius:8px;margin-bottom:4px;cursor:pointer;' +
        'background:rgba(255,255,255,0.03);color:rgba(200,220,240,0.8);font-size:12px">' +
        f.name + '<span style="float:right;color:rgba(200,220,240,0.4)">' + (f.c100||0) + 'g/100g</span></div>';
    }).join('');
  }

  document.body.appendChild(el);
  var inp = document.getElementById('alias-search');
  inp.addEventListener('input', function(){ renderAliasResults(inp.value); });
  renderAliasResults('');
}

function applyAlias(itemIdx, encodedName) {
  var name = decodeURIComponent(encodedName);
  var item = window._padItems[itemIdx];
  if (!item) return;
  // Save alias
  FOOD_ALIASES[item.raw.toLowerCase().trim()] = name;
  saveAliases();
  // Update item
  var match = resolveScannedFood(name);
  if (match) {
    item.matched = true;
    item.match   = match;
    item.carbs   = Math.round((match.c100||0) * item.grams / 100);
    item.gi      = match.gi || 55;
    item._gi_override = item.gi;
  }
  var linker = document.getElementById('alias-linker');
  if (linker) linker.remove();
  window._padRerender();
  showToast('"' + item.raw + '" → ' + name + ' saved');
}

function commitPadImport() {
  var items    = window._padItems || [];
  var dtInp    = document.getElementById('pad-import-dt');
  var uInp     = document.getElementById('pad-import-u');
  var waitInp  = document.getElementById('pad-import-wait');

  var t        = dtInp ? new Date(dtInp.value).getTime() : Date.now();
  var u        = parseFloat(uInp && uInp.value) || 0;
  var waitMins = parseFloat(waitInp && waitInp.value) || 0;
  var totalCarbs = items.reduce(function(s,i){ return s+(parseFloat(i.carbs)||0); }, 0);
  var carbT    = t + waitMins * 60000;

  var foodItems = items.map(function(i){
    var gi = i._gi_override || i.gi || 55;
    return { name: i.raw, carbs: parseFloat(i.carbs)||0, gi: gi, g: i.grams, source: 'pad' };
  });
  var avgGI = foodItems.length && totalCarbs > 0
    ? foodItems.reduce(function(s,i){ return s + (i.gi||55) * (i.carbs||0); }, 0) / totalCarbs
    : 55;

  if (u > 0) {
    SESSION.push({t:t, c:0, u:u, source:'pad'});
    BOLUS_EVENTS.push({t:t, c:0, u:u, source:'pad'});
    LOGGED_EVENTS.push({t:t, c:0, u:u, note:'bolus', source:'pad', logged_by:_thisPersonId||'unknown', local:true});
    topUpIOB(u);
  }
  if (totalCarbs > 0) {
    SESSION.push({t:carbT, c:totalCarbs, u:0, gi:avgGI, items:foodItems, source:'pad'});
    BOLUS_EVENTS.push({t:carbT, c:totalCarbs, u:0, gi:avgGI, items:foodItems, source:'pad'});
    LOGGED_EVENTS.push({t:carbT, c:totalCarbs, u:0, gi:avgGI, items:foodItems, note:'carbs', source:'pad',
      logged_by:_thisPersonId||'unknown', local:true});
    topUpCOB(totalCarbs);
  }

  try { localStorage.setItem('river_session',JSON.stringify(SESSION)); } catch(e) {}
  try { localStorage.setItem('river_logged',JSON.stringify(LOGGED_EVENTS)); } catch(e) {}
  syncAfterLog();
  _ptCache = null;

  var overlay = document.getElementById('pad-import-overlay');
  if (overlay) overlay.remove();

  // Save to meal history
  if (foodItems.length) {
    MEAL_HISTORY.unshift({
      name: 'Pad import · ' + new Date(t).toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'}),
      totalCarbs: Math.round(totalCarbs),
      items: foodItems,
      t: carbT,
      u: u,
      logged_by: _thisPersonId||'unknown',
      source: 'pad'
    });
    saveMealHistory();
  }

  showToast(totalCarbs.toFixed(0) + 'g carbs from pad\nadded to the flow');
}

// ── Load aliases on startup ──────────────────────────────────────────────
loadAliasesFromSupabase();
