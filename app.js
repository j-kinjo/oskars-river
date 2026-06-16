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

// Thin PostgREST shim so backfill.js (which uses _supabase.from())
// can run alongside app.js (which uses _sbFetch directly).
// Supports: .from(table).select(cols) / .insert(rows) / .update(data)
//           .upsert(rows) / .delete() / .eq(col,val) / .in(col,vals)
//           .order(col,{ascending}) / .limit(n) / .count (via head:true)
var _supabase = (function() {
  function _chain(table, filters, opts) {
    var _filters = filters || [];
    var _opts    = opts    || {};

    function _buildQS() {
      var qs = _filters.map(function(f) { return f; }).join('&');
      if (_opts.order) {
        qs += (qs ? '&' : '') + 'order=' + _opts.order.col +
              '.' + (_opts.order.ascending === false ? 'desc' : 'asc');
      }
      if (_opts.limit) qs += (qs ? '&' : '') + 'limit=' + _opts.limit;
      if (_opts.select && _opts.select !== '*') {
        qs += (qs ? '&' : '') + 'select=' + encodeURIComponent(_opts.select);
      }
      return qs ? '?' + qs : '';
    }

    var api = {
      select: function(cols, selectOpts) {
        _opts.select = cols || '*';
        if (selectOpts && selectOpts.head) _opts.head = true;
        // execute immediately — returns thenable
        return _exec('GET');
      },
      insert: function(rows) {
        return _exec('POST', Array.isArray(rows) ? rows : [rows]);
      },
      upsert: function(rows, upsertOpts) {
        _opts.upsert = upsertOpts || {};
        return _exec('POST', Array.isArray(rows) ? rows : [rows], true);
      },
      update: function(data) {
        return _exec('PATCH', data);
      },
      delete: function() {
        return _exec('DELETE');
      },
      eq: function(col, val) {
        _filters.push(col + '=eq.' + encodeURIComponent(val));
        return api;
      },
      in: function(col, vals) {
        _filters.push(col + '=in.(' + vals.map(encodeURIComponent).join(',') + ')');
        return api;
      },
      not: function(col, op, val) {
        _filters.push(col + '=not.' + op + '.' + encodeURIComponent(val));
        return api;
      },
      order: function(col, orderOpts) {
        _opts.order = { col: col, ascending: !(orderOpts && orderOpts.ascending === false) };
        return api;
      },
      limit: function(n) {
        _opts.limit = n;
        return api;
      },
      // count support — .select('*', {count:'exact', head:false})
      // returns {data, count, error}
    };

    function _exec(method, body, isUpsert) {
      var path = table + _buildQS();
      var prefer = 'return=minimal';
      if (isUpsert && _opts.upsert && _opts.upsert.onConflict) {
        path = table + '?on_conflict=' + _opts.upsert.onConflict + (_buildQS() ? _buildQS().replace('?','&') : '');
        prefer = 'resolution=merge-duplicates,return=minimal';
        // Deduplicate timestamps in body to avoid 21000 constraint violation
        if (body && Array.isArray(body) && _opts.upsert.onConflict === 't') {
          var seen = {};
          body = body.map(function(row) {
            if (row.t !== undefined) {
              var key = row.t;
              while (seen[key]) key++;
              seen[key] = true;
              if (key !== row.t) row = Object.assign({}, row, {t: key});
            }
            return row;
          });
        }
      }
      var fetchOpts = { method: method, prefer: prefer };
      if (body !== undefined) fetchOpts.body = body;

      return _sbFetch(path, fetchOpts).then(function(data) {
        return { data: data, error: null, count: Array.isArray(data) ? data.length : null };
      }).catch(function(err) {
        return { data: null, error: { message: err.message }, count: null };
      });
    }

    return api;
  }

  return {
    from: function(table) { return _chain(table, [], {}); }
  };
})();


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
//
// ── P1 REQUIRED: UNIQUE constraint on events.t (run once in Supabase SQL Editor) ──
// Without this, upsert on_conflict=t silently falls back to plain INSERT causing duplicates.
// Safe to run even if table has existing data (will fail if dupes exist — clean them first).
//
// -- Step 1: remove any duplicate t rows (keep newest id)
// DELETE FROM events WHERE id NOT IN (
//   SELECT DISTINCT ON (t) id FROM events ORDER BY t, id DESC
// );
// -- Step 2: add the constraint
// ALTER TABLE events ADD CONSTRAINT events_t_unique UNIQUE (t);
//
// ── library table (key-value config store — food library, future: recipes, aliases) ──
// create table if not exists library (
//   key        text primary key,
//   value      jsonb not null,
//   updated_at timestamptz default now()
// );
// alter table library enable row level security;
// create policy "anyone can read library"  on library for select using (true);
// create policy "anyone can insert library" on library for insert with check (true);
// create policy "anyone can update library" on library for update using (true);

// ── DEBUG LOGGING ──────────────────────────────────────────────────────
function __debugLog(msg) {
  if (typeof console !== 'undefined' && console.log) {
    console.log('[backfill] ' + msg);
  }
}

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
  // On first sync (sinceT=0), pull last 30 days — bulk history loaded separately via _bulkFetchHistory.
  // Subsequent syncs use _lastSyncT to only fetch new readings (capped at 500).
  var since = sinceT || (Date.now() - 30 * 24 * 3600000);
  var limit = sinceT ? 500 : 20000;
  var rows  = await _sbFetch(
    'readings?t=gte.' + since + '&order=t.asc&limit=' + limit,
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
  // Always pull full 24h window by event time — ignore _lastSyncT lower bound.
  // This ensures backdated events and remote edits/deletes are always reflected.
  var _pullCutoff = Date.now() - 24 * 3600000;
  var rows  = await _sbFetch(
    'events?t=gte.' + _pullCutoff + '&order=t.asc&limit=500',
    { method: 'GET' }
  );
  if (!rows || rows.length === 0) return 0;
  // Deduplicate rows from Supabase by t (last-write-wins on same t)
  var rowsByT = {};
  rows.forEach(function(row){ rowsByT[row.t] = row; });
  var deduped = Object.values(rowsByT);
  var remoteTs = new Set(deduped.map(function(r){ return r.t; }));

  // ── Remove local non-local events no longer in Supabase ──────────
  // Catches: remote deletes, remote time-edits (e.g. 14:42 → 14:32 on another device).
  // Only acts within the 24h pull window. Never removes local:true (not yet synced).
  // IMPORTANT: mutate in-place (splice) to preserve BOLUS_EVENTS alias reference.
  var removedTs = new Set();
  for (var _i = LOGGED_EVENTS.length - 1; _i >= 0; _i--) {
    var _e = LOGGED_EVENTS[_i];
    if (_e.local) continue;           // not yet pushed — keep
    if (_e.t < _pullCutoff) continue; // outside pull window — keep
    if (remoteTs.has(_e.t)) continue; // still in Supabase — keep
    removedTs.add(_e.t);
    LOGGED_EVENTS.splice(_i, 1);      // gone from Supabase — drop (in-place)
  }
  if (removedTs.size > 0) {
    // BOLUS_EVENTS is a live alias for LOGGED_EVENTS — already filtered above.
    console.log('[sync] removed ' + removedTs.size + ' stale local event(s): ' +
      Array.from(removedTs).map(function(t){
        return new Date(t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
      }).join(', '));
  }

  var added = 0;
  deduped.forEach(function(row) {
    // Skip food library sentinel row
    if (row.note === 'food_library') return;
    // Skip events the user has explicitly deleted on this device
    if (typeof _deletedEventTs !== 'undefined' && _deletedEventTs.has(row.t)) return;
    var rowItems = row.items;
    if (typeof rowItems === 'string') { try { rowItems = JSON.parse(rowItems); } catch(_e) { rowItems = null; } }
    // Merge into LOGGED_EVENTS — update if exists (catches remote edits), insert if new
    var existsL = LOGGED_EVENTS.findIndex(function(e){ return e.t === row.t; });
    if (existsL >= 0) {
      // Remote edit: update all fields in case they changed on another device
      LOGGED_EVENTS[existsL].c    = row.c||0;
      LOGGED_EVENTS[existsL].u    = row.u||0;
      LOGGED_EVENTS[existsL].gi   = row.gi;
      LOGGED_EVENTS[existsL].note = row.note;
      if (rowItems) LOGGED_EVENTS[existsL].items = rowItems;
      LOGGED_EVENTS[existsL].local = false;
      // BOLUS_EVENTS is a live alias — LOGGED_EVENTS[existsL] is already updated above.
    } else {
      var ev = { t: row.t, c: row.c||0, u: row.u||0, gi: row.gi, note: row.note, items: rowItems, local: false };
      LOGGED_EVENTS.push(ev);
      // Do NOT push into SESSION — historical Supabase events must not drive dataAt().
      added++;
    }
  });
  // Always write back — removal may have changed the list even if added=0
  try { localStorage.setItem('river_logged', JSON.stringify(LOGGED_EVENTS)); } catch(e){}
  // ── DEV ASSERTION: BOLUS_EVENTS and LOGGED_EVENTS must always be the same object ──
  if (BOLUS_EVENTS !== LOGGED_EVENTS) {
    console.error('[sync] ARRAY DIVERGENCE — BOLUS_EVENTS is no longer the same reference as LOGGED_EVENTS. This is a bug.');
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
    await syncFoodLibraryFromSupabase();
    await syncMealHistoryFromSupabase();
    await _bootstrapPatternLibrary(); // seed pattern library on first sync after session 7
    await loadObservedISF(); // refresh adaptive ISF from bolus_outcomes
    _derivePersonalRamp();   // refresh personalised absorption ramp from meal outcomes
    await _syncTimerEvents(); // cross-device timer state sync
    _backfillPredictedCurves(); // reconstruct prediction curves for historic meal records
    await runOutcomeBackfill(); // unified meal/bolus outcome backfill (partial + complete)

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
  loadSensorOutages();    // load outage history
  _syncTimer = setInterval(function(){ syncNow(true); }, 5 * 60000);
  // Check for duplicate events in Supabase (symptom of missing UNIQUE constraint on events.t)
  setTimeout(_checkForDuplicateEvents, 8000);
}

async function _checkForDuplicateEvents() {
  if (!SUPABASE_READY) return;
  try {
    var since = Date.now() - 7 * 86400000;
    var rows = await _sbFetch('events?t=gte.' + since + '&select=t&order=t.asc&limit=1000', {});
    if (!Array.isArray(rows)) return;
    var seen = {}, dupes = 0;
    rows.forEach(function(r){ if (seen[r.t]) dupes++; else seen[r.t] = true; });
    if (dupes > 0) {
      console.warn('[river] ⚠️ ' + dupes + ' duplicate event rows detected in Supabase. ' +
        'Run the P1 SQL in app.js comments to add UNIQUE constraint and clean duplicates. ' +
        'Edits may not sync correctly across devices until this is done.');
    }
  } catch(e) {}
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


var LOGGED_EVENTS = [];
try { LOGGED_EVENTS = JSON.parse(localStorage.getItem('river_logged')||'[]');
  // Keep only last 24h — viewable window when scrolling back. 6h was too short.
  var _sixHoursAgo = Date.now() - 24 * 3600000;
  LOGGED_EVENTS = LOGGED_EVENTS.filter(function(e){ return e.t >= _sixHoursAgo; });
  // Dedup by t on startup — cleans any duplicates that slipped in via edit flow
  var _loadSeenT = {};
  LOGGED_EVENTS = LOGGED_EVENTS.filter(function(e) {
    if (_loadSeenT[e.t]) return false;
    _loadSeenT[e.t] = true;
    return true;
  });
  // Write trimmed+deduped list back so it doesn't grow indefinitely
  try { localStorage.setItem('river_logged', JSON.stringify(LOGGED_EVENTS)); } catch(_le){}
} catch(err) {}

// BOLUS_EVENTS is a live alias for LOGGED_EVENTS — single source of truth.
// Do not push to BOLUS_EVENTS directly; push to LOGGED_EVENTS instead.
var BOLUS_EVENTS = LOGGED_EVENTS;

// ── CLINICAL TIMER OVERLAY — state ────────────────────────────────────────
// Three ambient pills: ketone check, hypo recovery, correction window.
// Clinical state is derived from live data; UI state (minimised) is localStorage.
let _activeTimers = {
  ketone: {
    state: 'inactive',       // inactive | counting | prompt | resolved_remote
    episode_start_t: null,   // timestamp of FIRST reading >= threshold in this episode
    below_since_t: null,     // timestamp when BG first dipped below threshold mid-episode
    thresholdMmol: 14.0,     // overridden from _TREATMENT on load
    durationMins: 120,       // overridden from _TREATMENT on load
    minimised: false,        // device-local; never synced
    remote: null,            // { value, display_name, t, note } when resolved_remote
    _optionsOpen: false,     // transient: options panel expanded
    _peekUntil: 0,           // transient: timestamp when minimised peek expires
  },
  hypo: {
    state: 'inactive',       // inactive | counting | prompt | resolved_remote
    treatmentT: null,        // timestamp of hypo treatment event that triggered this
    recheckMins: 15,         // overridden from _TREATMENT on load
    remote: null,
  },
  correction: {
    state: 'inactive',       // inactive | watching | trending_down | nudge
    trending: null,
    lastCorrectionT: null,
  }
};
let _timerLastEval = 0; // throttle guard — ms timestamp of last _updateTimers() run

// ── COLLISION-SAFE TIMESTAMP ───────────────────────────────────────────────
// Returns a timestamp guaranteed not to collide with any existing local event.
// When two events are logged within the same minute, ms-level jitter separates
// them so the upsert on_conflict=t never overwrites one with the other.
function _safeEventT(baseT) {
  var t = baseT || Date.now();
  while (LOGGED_EVENTS.some(function(e){ return e.t === t; })) { t++; }
  return t;
}

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
// Wall clock is the master timeline. CGM data attaches to it.
let viewTime = Date.now();
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
// Nearest known BG to time t — used to place chips sensibly inside CGM
// gaps/outages, where histAt() returns bg:null (gap sentinel). Without
// this, chips inside a gap collapse to bgToY(null) = vertical centre,
// which can land them off their expected position and, when several
// gap-zone chips collapse to the same coordinates, makes individual
// chips unreliable to tap.
function nearestKnownBG(t) {
  if (!HISTORY_RAW || HISTORY_RAW.length === 0) return 7.0;
  var best = HISTORY_RAW[0], bestDiff = Math.abs(HISTORY_RAW[0].t - t);
  for (var i = 1; i < HISTORY_RAW.length; i++) {
    var diff = Math.abs(HISTORY_RAW[i].t - t);
    if (diff < bestDiff && HISTORY_RAW[i].bg > 0) { best = HISTORY_RAW[i]; bestDiff = diff; }
  }
  return (best && best.bg > 0) ? best.bg : 7.0;
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
    if (s.note === 'basal') continue; // basal is not rapid-acting — no IOB curve
    si += (s.u||0)*iobF(m, _insulinForEvent(s));
    sc += (s.c||0)*cobF(m);
  }
  return { bg:h.bg, iob:h.iob+si, cob:h.cob+sc, pen:h.pen };
}

var _iobNormCache = {}; // cache {'diaMins_peakMins': norm} to avoid recomputing every frame
// Generic biexponential-shaped IOB decay curve. peakMins defaults to the
// historic 0.3125*diaMins fraction (== 75min @ 240min DIA, i.e. Novorapid)
// when not given explicitly — insulin-specific peaks (e.g. Fiasp ~55min)
// should be passed in via _getInsulinProfile().
function _iobShape(m, diaMins, peakMins) {
  diaMins  = diaMins  || 240;
  peakMins = peakMins || (diaMins * 0.3125);
  if (m<=0) return 1; if (m>=diaMins) return 0;
  var peakM = peakMins;
  var tailM = diaMins - peakM;
  var cacheKey = diaMins + '_' + peakM;
  if (!_iobNormCache[cacheKey]) {
    var norm=0; for(var x=0;x<diaMins;x+=2) norm+=(x<=peakM?x/peakM:Math.max(0,1-(x-peakM)/tailM))*2;
    _iobNormCache[cacheKey] = norm;
  }
  var d=0; for(var x=0;x<m;x+=2) d+=(x<=peakM?x/peakM:Math.max(0,1-(x-peakM)/tailM))*2;
  return Math.max(0,1-Math.min(1,d/_iobNormCache[cacheKey]));
}
// insulinName: which insulin was used for this dose — resolves to its
// pharmacokinetic profile (Novorapid/Fiasp/etc). Falls back to the current
// default insulin, then to _TREATMENT.dia, then the 240min hardcoded default.
function iobF(m, insulinName) {
  if (insulinName) {
    var p = _getInsulinProfile(insulinName);
    return _iobShape(m, p.diaMins, p.peakMins);
  }
  var diaMins = (_TREATMENT && _TREATMENT.dia) ? _TREATMENT.dia : 240;
  return _iobShape(m, diaMins);
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
  const leftT = xT(0);
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
    const bg = (d.bg !== null && d.bg !== undefined) ? d.bg : null; // null → bgToY returns mid-canvas
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
  _drawSmoothLine(pts);  // gap-aware — lifts pen at sensor gaps
  CX.stroke();

  // Mid glow
  CX.globalAlpha = 0.22;
  CX.lineWidth   = 6;
  _drawSmoothLine(pts);  // gap-aware
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
          // Find first real point after the gap
          let afterGap = null;
          for (let gi = i; gi < pts.length; gi++) {
            if (!pts[gi].gap) { afterGap = pts[gi]; break; }
          }
          if (afterGap) {
            CX.save();
            CX.globalAlpha = 0.15;
            CX.strokeStyle = 'rgba(180,200,220,1)';
            CX.lineWidth = 1;
            CX.setLineDash([3, 8]);
            CX.beginPath();
            CX.moveTo(pts[i-1].x, pts[i-1].y);
            CX.lineTo(afterGap.x, afterGap.y);
            CX.stroke();
            CX.setLineDash([]);
            CX.restore();
          }
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

  // Reading dots every ~15min — skip gap points (no real reading there)
  const dotGap = (viewSpan/W)*W/16;
  let lastDotT = 0;
  for (const p of pts) {
    if (p.gap) continue; // don't render dots in sensor gaps
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

  // Prediction landing dot removed — prediction shown via drawForecastTrace

  CX.globalAlpha = 1;
  CX.restore();
}

function _drawSmoothLine(pts) {
  if (pts.length < 2) return;
  CX.beginPath();
  let penDown = false;
  for (let i=0; i<pts.length; i++) {
    if (pts[i].gap) { penDown = false; continue; } // lift pen at sensor gaps
    if (!penDown) { CX.moveTo(pts[i].x, pts[i].y); penDown = true; continue; }
    const next = pts[i+1] && !pts[i+1].gap ? pts[i+1] : null;
    if (next) {
      const mx = (pts[i].x + next.x)/2;
      const my = (pts[i].y + next.y)/2;
      CX.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    } else {
      CX.lineTo(pts[i].x, pts[i].y);
    }
  }
}

// ── FORCE RIBBONS ─────────────────────────────────────────────────────
// Carbs: warm buoyant ribbon — flows ABOVE the BG line, pushing it up
// Insulin: cool gravity ribbon — flows BELOW the BG line, pulling it down
// Both taper toward the boat (now-point), widen into the past

function buildForcePts(valueKey, direction, lookAhead) {
  const nowT  = viewTime;
  const leftT = xT(0);
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

  // Future projection dashes removed

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
  // Cutoff is 24h before the earlier of viewTime or now.
  // When scrubbing back, shows meals visible at that point in time.
  // Cap at 24h to avoid loading ancient history into the canvas.
  var refT   = Math.min(Date.now(), viewTime);
  var cutoff = refT - 24 * 3600000;
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
  var refT   = Math.min(Date.now(), viewTime);
  var cutoff = refT - 24 * 3600000;
  var events = [], seen = {};
  BOLUS_EVENTS.concat(SESSION).forEach(function(ev) {
    if (!ev.u || ev.u <= 0 || ev.t < cutoff) return;
    if (ev.note === 'basal') return; // basal shows as chip only — no IOB bell
    var key = Math.round(ev.t / 30000);
    if (seen[key]) return;
    seen[key] = true;
    events.push({ t: ev.t, u: ev.u, insulin_type: _insulinForEvent(ev) });
  });
  return events.sort(function(a,b){ return a.t-b.t; });
}

// ── PERSONALISED ABSORPTION RAMP ─────────────────────────────────────────
// Derived from meal_history: for each GI band, compare predicted peak_t
// (from therapy_snapshot + GI formula) vs actual peak_t from actual_curve.
// Returns a multiplier on the default peakMin formula: >1 = slower absorber,
// <1 = faster. Cached and refreshed after each sync.
// Minimum 3 outcomes per band before adapting. Blended 70% observed / 30% default.

var _personalRampCache = {};  // { 'fast'|'medium'|'slow': multiplier }
var _personalRampUpdated = 0;

function _giToBand(gi) {
  return gi >= 70 ? 'fast' : gi >= 45 ? 'medium' : 'slow';
}

function _getPersonalRamp(gi) {
  var band = _giToBand(gi);
  return _personalRampCache[band] || 1.0;
}

function _derivePersonalRamp() {
  if (Date.now() - _personalRampUpdated < 10 * 60000) return; // max every 10min
  _personalRampUpdated = Date.now();

  var meals = (MEAL_HISTORY || []).filter(function(m) {
    return m.actual_curve && m.actual_curve.length > 3 && m.items && m.items.length > 0 && m.peak_t;
  });

  if (meals.length < 3) return; // not enough data

  var bandData = { fast: [], medium: [], slow: [] };

  meals.forEach(function(m) {
    // Dominant GI band of this meal (weighted by carbs)
    var totalC = m.items.reduce(function(s,i){ return s+(i.carbs||0); }, 0);
    if (!totalC) return;
    var avgGI = m.items.reduce(function(s,i){ return s+(i.gi||55)*(i.carbs||0); }, 0) / totalC;
    var band = _giToBand(avgGI);

    // Default predicted peak mins from formula
    var defPeakMins = Math.max(15, 95 - avgGI);
    // Actual peak from stored peak_t
    var actualPeakMins = m.peak_t ? (m.peak_t - m.t) / 60000 : null;
    if (!actualPeakMins || actualPeakMins < 5 || actualPeakMins > 180) return;

    bandData[band].push(actualPeakMins / defPeakMins);
  });

  ['fast', 'medium', 'slow'].forEach(function(band) {
    var obs = bandData[band];
    if (obs.length < 3) return; // need minimum 3 per band
    var median = obs.slice().sort(function(a,b){return a-b;})[Math.floor(obs.length/2)];
    // Blend: 70% observed, 30% default (1.0) — prevents wild swings from sparse data
    var blended = median * 0.7 + 1.0 * 0.3;
    // Clamp: don't allow more than ±40% shift from default
    _personalRampCache[band] = Math.max(0.6, Math.min(1.4, blended));
  });
}


function _cobFgi(mins, gi) {
  gi = gi || 55;
  if (mins <= 0) return 1; if (mins >= 240) return 0;
  // Apply personalised peak-mins multiplier if available
  var rampMult = _getPersonalRamp(gi);
  var pk = Math.max(15, (95 - gi) * rampMult), s = pk / 2.2, z = (mins - pk) / s;
  return Math.max(0, 1 - Math.min(1, 0.5*(1+Math.tanh(0.7978845608*(z+0.044715*z*z*z)))));
}

// Thin wrapper over the shared _iobShape — kept for call sites that pass
// diaMins/peakMins directly (e.g. per-insulin curve rendering).
function _iobFn(mins, diaMins, peakMins) {
  return _iobShape(mins, diaMins, peakMins);
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

  // Sinusoidal colour drift — 4s cycle, shared across all COB bells
  var _phase = (Date.now() % 4000) / 4000 * Math.PI * 2;

  mealEvents.forEach(function(meal) {
    if (!meal.items) return;
    meal.items.forEach(function(food) {
      if (!food.carbs || food.carbs <= 0) return;
      var gi         = food.gi || 55;
      var peakMin    = Math.max(15, 95 - gi);
      var peakT      = meal.t + peakMin * 60000;
      var peakX      = tX(peakT);
      var elapsedMin = (viewTime - meal.t) / 60000;
      var remaining  = _cobFgi(elapsedMin, gi);

      // Base colour from GI — warm ramp orange→amber→gold
      var giCol = giToColour(gi);
      var rv0 = giCol[0], gv0 = giCol[1], bv0 = giCol[2];
      // Sinusoidal drift: orange→gold→amber cycle, independent of remaining
      var drift  = Math.sin(_phase + gi * 0.05) * 0.5 + 0.5; // 0..1
      var rv = Math.round(rv0 * (1 - drift * 0.08) + 255 * drift * 0.08);
      var gv = Math.round(gv0 * (1 - drift * 0.15) + 200 * drift * 0.15);
      var bv = Math.round(bv0 * (1 - drift * 0.05) + 40  * drift * 0.05);

      var sigmaFactor = gi >= 70 ? 0.6 : gi >= 55 ? 1.0 : 1.5;
      var sigma  = _bellSigma(sigmaFactor);
      // COB rises from canvas bottom — buoyancy from below
      var chipY     = H;
      var maxD      = Math.min(H * 0.85, 90 * (food.carbs / 20));
      var minD      = 12;
      maxD = Math.max(minD, maxD);

      var sigmaMins   = peakMin / 2.2;
      var mealT_local = meal.t;

      var bellH = function(px) {
        var t_px = viewTime + (px - NOW_X * W) / W * viewSpan;
        if (t_px < mealT_local) return 0;
        var rampMins = Math.min(1.0, (t_px - mealT_local) / (8 * 60000));
        var ramp     = rampMins * rampMins * (3 - 2 * rampMins);
        var minsDist = (t_px - peakT) / 60000;
        return Math.exp(-0.5 * Math.pow(minsDist / sigmaMins, 2)) * maxD * ramp;
      };

      // ── Depletion guard — skip if bell is essentially flat ───────────
      var _maxBellH = 0;
      for (var _gi = 0; _gi <= 20; _gi++) {
        var _h = bellH((_gi / 20) * W);
        if (_h > _maxBellH) _maxBellH = _h;
      }
      if (_maxBellH < 2) return; // nothing visible — don't draw flat line

      // ── Fill — bell rises from canvas bottom ─────────────────────────
      CX.save();
      CX.beginPath();
      CX.moveTo(0, chipY);
      for (var i = 0; i <= 280; i++) {
        var px = (i / 280) * W;
        CX.lineTo(px, chipY - bellH(px));
      }
      CX.lineTo(W, chipY);
      CX.closePath();
      var breathe = 0.18 + Math.sin(_phase * 1.3) * 0.06;
      var gr = CX.createLinearGradient(0, chipY, 0, chipY - maxD);
      gr.addColorStop(0,   'rgba(' + rv + ',' + gv + ',' + bv + ',' + (breathe + 0.12) + ')');
      gr.addColorStop(0.5, 'rgba(' + rv + ',' + gv + ',' + bv + ',' + (breathe * 0.5) + ')');
      gr.addColorStop(1,   'rgba(' + rv + ',' + gv + ',' + bv + ',0)');
      CX.fillStyle = gr; CX.fill();
      CX.restore();

      // ── Rim — bell surface, always drawn ─────────────────────────────
      CX.save();
      CX.beginPath();
      for (var i = 0; i <= 280; i++) {
        var px = (i / 280) * W;
        var py = chipY - bellH(px);
        i === 0 ? CX.moveTo(px, py) : CX.lineTo(px, py);
      }
      CX.strokeStyle = 'rgba(' + rv + ',' + gv + ',' + bv + ',0.55)';
      CX.lineWidth = 1.2; CX.stroke();
      CX.restore();

      // ── Living bubbles — distributed along full bell surface ─────────
      // Bubbles sit on the rim and pulse/drift upward. No peak/trough bias.
      var chipXpx = tX(meal.t);
      var nBubbles = Math.min(18, Math.max(4, Math.floor(food.carbs * 0.5)));
      for (var bi = 0; bi < nBubbles; bi++) {
        var bFrac   = (bi + 0.5) / nBubbles;
        var bPx     = bFrac * W;
        var bH      = bellH(bPx);
        if (bH < 3) continue;
        // Each bubble has its own drift cycle offset
        var bPhase  = _phase + bi * 0.7 + gi * 0.02;
        var bRise   = (Math.sin(bPhase * 0.8) * 0.5 + 0.5) * bH * 0.35;
        var bWobX   = Math.sin(bPhase * 1.1) * 3;
        var bY      = chipY - bH * (0.15 + bFrac * 0.5) - bRise;
        var bR      = 1.5 + Math.sin(bPhase * 1.3 + bi) * 0.8 + food.carbs / 60;
        var bAlpha  = 0.25 + Math.sin(bPhase * 0.9) * 0.15;
        if (bY > chipY || bY < chipY - maxD - 5) continue;

        // Bubble: translucent fill + bright rim + highlight
        CX.beginPath();
        CX.arc(bPx + bWobX, bY, bR, 0, Math.PI * 2);
        CX.fillStyle = 'rgba(' + rv + ',' + gv + ',' + bv + ',' + (bAlpha * 0.2) + ')';
        CX.fill();
        CX.strokeStyle = 'rgba(' + rv + ',' + gv + ',' + bv + ',' + bAlpha + ')';
        CX.lineWidth = 0.8; CX.stroke();
        // Highlight
        CX.beginPath();
        CX.arc(bPx + bWobX - bR * 0.28, bY - bR * 0.3, bR * 0.28, 0, Math.PI * 2);
        CX.fillStyle = 'rgba(255,240,180,' + (bAlpha * 0.55) + ')';
        CX.fill();
      }

      // ── Fast-sugar inner spike (GI ≥ 80) ─────────────────────────────
      if (gi >= 80) {
        var fastPeakMin = Math.max(10, 95 - gi) * 0.6;
        var fastPeakT   = meal.t + fastPeakMin * 60000;
        var fastSigmaM  = fastPeakMin / 1.6;
        var fastMaxD    = maxD * 0.55;
        var fastBellH = function(px2) {
          var t_px2 = viewTime + (px2 - NOW_X * W) / W * viewSpan;
          if (t_px2 < mealT_local) return 0;
          var ramp2 = Math.min(1, (t_px2 - mealT_local) / (4 * 60000));
          var md2   = (t_px2 - fastPeakT) / 60000;
          return Math.exp(-0.5 * Math.pow(md2 / fastSigmaM, 2)) * fastMaxD * ramp2;
        };
        CX.save();
        CX.beginPath();
        CX.moveTo(0, chipY);
        for (var fi = 0; fi <= 280; fi++) {
          var fpx = (fi / 280) * W;
          CX.lineTo(fpx, chipY - fastBellH(fpx));
        }
        CX.lineTo(W, chipY); CX.closePath();
        var fgr = CX.createLinearGradient(0, chipY, 0, chipY - fastMaxD);
        fgr.addColorStop(0,   'rgba(255,220,80,0.30)');
        fgr.addColorStop(0.5, 'rgba(255,220,80,0.10)');
        fgr.addColorStop(1,   'rgba(255,220,80,0)');
        CX.fillStyle = fgr; CX.fill();
        CX.beginPath();
        for (var fi2 = 0; fi2 <= 280; fi2++) {
          var fpx2 = (fi2 / 280) * W;
          fi2 === 0 ? CX.moveTo(fpx2, chipY - fastBellH(fpx2)) : CX.lineTo(fpx2, chipY - fastBellH(fpx2));
        }
        CX.strokeStyle = 'rgba(255,230,100,0.45)';
        CX.lineWidth = 0.8; CX.stroke();
        CX.restore();
      }

      // ── Food label — always shown if bell is visible ──────────────────
      if (maxD > 8) {
        var labelX = Math.max(30, Math.min(W - 30, peakX));
        var labelH = bellH(labelX);
        if (labelH > maxD * 0.12) {
          CX.globalAlpha = 0.65;
          CX.fillStyle   = 'rgba(' + rv + ',' + gv + ',' + bv + ',1)';
          CX.font        = "300 8px 'DM Mono',monospace";
          CX.textAlign   = 'center';
          var carbStr = food.carbs < 1 ? food.carbs.toFixed(1) + 'g' : food.carbs.toFixed(0) + 'g';
          CX.fillText(food.name.slice(0, 14) + ' ' + carbStr, labelX, chipY - labelH - 6);
          CX.globalAlpha = 1;
        }
      }

      // Track peak Y for pill positioning
      var thisPeakY = chipY - maxD;
      if (_lastCOBPeakY < 0 || thisPeakY < _lastCOBPeakY) _lastCOBPeakY = thisPeakY;
    });
  });
}

function _drawIOBReservoir() {
  var bolusEvents = _getActiveBolusEvents();
  if (bolusEvents.length === 0) return;

  // Sinusoidal colour drift — 4s cycle, cool blue→indigo→steel
  var _phase = (Date.now() % 4000) / 4000 * Math.PI * 2;

  bolusEvents.forEach(function(bolus) {
    var elapsedMin  = (viewTime - bolus.t) / 60000;
    var insProfile  = _getInsulinProfile(bolus.insulin_type);
    var diaMins     = insProfile.diaMins;
    var peakMins    = insProfile.peakMins;
    var remaining   = _iobFn(elapsedMin, diaMins, peakMins);

    var peakT       = bolus.t + peakMins * 60000;
    // Bell sigma scales with the insulin's peak/tail timing — ratios
    // preserve the original Novorapid feel (32min rise / 70min fall @ 75/240).
    var sigmaRMins  = peakMins * (32 / 75);
    var sigmaFMins  = (diaMins - peakMins) * (70 / 165);

    // Chip Y — origin on CGM line where this bell is born
    var chipY     = bgToY(dataAt(bolus.t).bg || dataAt(viewTime).bg);
    var availableH = Math.max(chipY - 8, 40); // space above chip toward top of canvas
    var maxD       = Math.min(availableH * 0.90, 110 * (bolus.u / 3));
    var minD       = Math.min(availableH * 0.12, 18);
    maxD = Math.max(minD, maxD);

    var bolusT_local = bolus.t;

    // bellSurfaceY: the bottom edge of the insulin cloud.
    // At peak: surface rises toward y=0 (insulin at maximum depth, cloud thinnest there).
    // Wait — that's still wrong. Let me think:
    //
    // DESIRED VISUAL: insulin cloud is a valley pressing FROM THE TOP.
    // The cloud fills the top portion of canvas. At the bolus peak it presses DEEPEST
    // toward the CGM line. Like a thumb pressing down on the top of the screen.
    //
    // Fill region = y=0 to surfaceY at every pixel.
    // surfaceY at peak = maxD (deepest, closest to CGM)
    // surfaceY at edges = 0 (no fill — cloud has retreated to top)
    //
    // That IS a hill shape in terms of surfaceY values. But visually it fills FROM THE TOP.
    // moveTo(0,0) → trace surfaceY → lineTo(W,0) → close fills the correct valley shape.
    // The GRADIENT must go from y=0 (transparent) to y=maxD (dense) — INVERTED vs carbs.
    // Dense color at the BOTTOM of the fill (near CGM), fading to transparent at the top.
    var bellSurfaceY = function(px) {
      var t_px     = viewTime + (px - NOW_X * W) / W * viewSpan;
      var minsDist = (t_px - peakT) / 60000;
      var rampMins = Math.min(1.0, Math.max(0, (t_px - bolusT_local) / (12 * 60000)));
      var ramp     = rampMins * rampMins * (3 - 2 * rampMins);
      var sigma    = minsDist < 0 ? sigmaRMins : sigmaFMins;
      return Math.exp(-0.5 * Math.pow(minsDist / sigma, 2)) * maxD * ramp;
    };

    // ── Depletion guard ───────────────────────────────────────────────
    var _maxIobH = 0;
    for (var _ii = 0; _ii <= 20; _ii++) {
      var _ih = bellSurfaceY((_ii / 20) * W);
      if (_ih > _maxIobH) _maxIobH = _ih;
    }
    if (_maxIobH < 2) {
      if (_lastIOBPeakY < 0 || maxD > _lastIOBPeakY) _lastIOBPeakY = maxD;
      return;
    }

    // Colour drift: blue→indigo→steel cycle
    var drift = Math.sin(_phase + bolus.u * 0.3) * 0.5 + 0.5;
    var rv = Math.round(COL_IOB[0] * (1 - drift * 0.15) + 80  * drift * 0.15);
    var gv = Math.round(COL_IOB[1] * (1 - drift * 0.10) + 100 * drift * 0.10);
    var bv = Math.round(COL_IOB[2] * (1 - drift * 0.05) + 255 * drift * 0.05);

    // ── Fill — insulin cloud from top, valley pressing down at peak ───
    // Path traces from y=0 at edges to maxD at peak. Fill covers y=0→surface.
    // Gradient: transparent at top (y=0), dense at surface (y=maxD).
    // This gives the "pressing down from sky" visual — deepest at peak.
    CX.save();
    CX.beginPath();
    CX.moveTo(0, 0);
    CX.lineTo(0, bellSurfaceY(0));
    for (var i = 1; i <= 280; i++) {
      var px = (i / 280) * W;
      CX.lineTo(px, bellSurfaceY(px));
    }
    CX.lineTo(W, 0); CX.closePath();

    var breathe = 0.18 + Math.sin(_phase * 1.1 + 1.5) * 0.06;
    // Gradient: y=0 (transparent) → y=maxD (dense) — color accumulates at the surface
    var gr = CX.createLinearGradient(0, 0, 0, _maxIobH);
    gr.addColorStop(0,    'rgba(' + rv + ',' + gv + ',' + bv + ',0)');
    gr.addColorStop(0.3,  'rgba(' + rv + ',' + gv + ',' + bv + ',' + (breathe * 0.3) + ')');
    gr.addColorStop(0.75, 'rgba(' + rv + ',' + gv + ',' + bv + ',' + (breathe * 0.8) + ')');
    gr.addColorStop(1,    'rgba(' + rv + ',' + gv + ',' + bv + ',' + (breathe + 0.15) + ')');
    CX.fillStyle = gr; CX.fill();

    // Soft blur at the surface edge — mist touching the river
    CX.shadowColor = 'rgba(' + rv + ',' + gv + ',' + bv + ',0.4)';
    CX.shadowBlur  = 14;
    CX.beginPath();
    for (var i = 0; i <= 280; i++) {
      var px = (i / 280) * W;
      i === 0 ? CX.moveTo(px, bellSurfaceY(px)) : CX.lineTo(px, bellSurfaceY(px));
    }
    CX.strokeStyle = 'rgba(' + rv + ',' + gv + ',' + bv + ',0.55)';
    CX.lineWidth = 1.2; CX.stroke();
    CX.shadowBlur = 0; CX.shadowColor = 'transparent';
    CX.restore();

    // ── Distributed bubbles inside the insulin cloud ──────────────────
    var nBubbles = Math.min(14, Math.max(3, Math.floor(bolus.u * 2.5)));
    for (var bi = 0; bi < nBubbles; bi++) {
      var bFrac  = (bi + 0.5) / nBubbles;
      var bPx    = bFrac * W;
      var bSurf  = bellSurfaceY(bPx); // surface Y at this pixel (0=top, maxD=deepest)
      if (bSurf < 3) continue;
      var bPhase = _phase + bi * 0.65 + bolus.u * 0.1;
      // Bubbles drift within the cloud — between y=0 and the surface
      var bY     = bSurf * (0.2 + Math.sin(bPhase * 0.8) * 0.3 + 0.3);
      var bWobX  = Math.sin(bPhase * 1.2) * 3;
      var bR     = 1.2 + Math.sin(bPhase * 1.4 + bi) * 0.6 + bolus.u / 8;
      var bAlpha = 0.22 + Math.sin(bPhase) * 0.12;
      if (bY < 0 || bY > bSurf + 5) continue;

      // Teardrop-like bubble for insulin (cooler, denser than carb)
      CX.beginPath();
      CX.arc(bPx + bWobX, bY, bR, 0, Math.PI * 2);
      CX.fillStyle   = 'rgba(' + rv + ',' + gv + ',' + bv + ',' + (bAlpha * 0.18) + ')';
      CX.fill();
      CX.strokeStyle = 'rgba(' + rv + ',' + gv + ',' + bv + ',' + bAlpha + ')';
      CX.lineWidth = 0.7; CX.stroke();
      // Cool highlight
      CX.beginPath();
      CX.arc(bPx + bWobX + bR * 0.25, bY - bR * 0.3, bR * 0.25, 0, Math.PI * 2);
      CX.fillStyle = 'rgba(195,228,255,' + (bAlpha * 0.5) + ')';
      CX.fill();
    }

    // Three-curve DIA overlay removed — was source of grey dashes across canvas

    // Label at peak — sits just below the deepest surface point
    // Label at deepest visible surface point — scan on-screen pixels
    var bestLabelX = -1, bestLabelSurf = 0;
    for (var li = 5; li <= 275; li += 5) {
      var lSurf = bellSurfaceY(li);
      if (lSurf > bestLabelSurf) { bestLabelSurf = lSurf; bestLabelX = li; }
    }
    if (bestLabelX > 0 && bestLabelSurf > 8) {
      CX.globalAlpha = 0.65;
      CX.fillStyle   = 'rgba(' + rv + ',' + gv + ',' + bv + ',1)';
      CX.font        = "300 9px 'DM Mono',monospace";
      CX.textAlign   = 'center';
      CX.fillText(bolus.u.toFixed(1) + 'U', bestLabelX, bestLabelSurf + 12);
      CX.globalAlpha = 1;
    }

    if (_lastIOBPeakY < 0 || maxD > _lastIOBPeakY) _lastIOBPeakY = maxD;
  });
}

// Smart forecast — per-food GI curves + IOB decay
// Build prediction traces anchored to the earliest active event.
// These are fixed absolute-time curves — visible at all scrub positions.
// The prediction doesn't change when you scrub — it was set at event time.
// _snapshotPrediction: called at every log event.
// Computes prediction from current state, stores globally and in localStorage.
// This is the immutable "what we thought would happen" curve for this event.
// Prediction formula version — bump when formula changes to bust stale cache
var _PRED_FORMULA_VERSION = 2; // v2 = net imbalance formula

var _activePredictedCurves = (function() {
  try {
    var vKey = 'river_predicted_curves_v' + _PRED_FORMULA_VERSION;
    // Clear old version keys
    localStorage.removeItem('river_predicted_curves');
    localStorage.removeItem('river_predicted_curves_v1');
    var stored = localStorage.getItem(vKey);
    return stored ? JSON.parse(stored) : [];
  } catch(e) { return []; }
})();


// Push a prediction snapshot onto _activePredictedCurves — dedupes by anchor
// time, keeps newest-first order, trims to 20, persists to localStorage.
// Shared by _snapshotPrediction and the meal-logging call sites so any new
// curve (whichever path produced it) is immediately the one the canvas
// "mist" overlay and forecast trace pick up — not whatever was already there
// from a previous session's localStorage cache.
function _pushActivePredictedCurve(pts, loggedAt) {
  if (!pts || pts.length < 2) return;
  var anchorT = pts[0].t;
  loggedAt = loggedAt || anchorT;
  var dup = _activePredictedCurves.some(function(s) {
    return s.pts && s.pts[0] && Math.abs(s.pts[0].t - anchorT) < 60000;
  });
  if (dup) {
    _activePredictedCurves.forEach(function(s) {
      if (s.pts && s.pts[0] && Math.abs(s.pts[0].t - anchorT) < 60000) {
        s.pts = pts;
        s.loggedAt = loggedAt;
      }
    });
  } else {
    _activePredictedCurves.unshift({ loggedAt: loggedAt, pts: pts });
  }
  _activePredictedCurves.sort(function(a,b){ return b.loggedAt - a.loggedAt; });
  if (_activePredictedCurves.length > 20) _activePredictedCurves.length = 20;
  try { localStorage.setItem('river_predicted_curves_v' + _PRED_FORMULA_VERSION, JSON.stringify(_activePredictedCurves)); } catch(e) {}
}

// Remove any _activePredictedCurves entry (and matching MEAL_HISTORY._predictedCurve)
// anchored at time `t` — called whenever the underlying event/meal is deleted or
// repositioned, so a stale "ghost prediction" line can't keep rendering for an
// event that no longer exists at that time. Same ~60s anchor tolerance as the
// dedupe check in _pushActivePredictedCurve.
function _removeActivePredictedCurve(t) {
  if (!t) return;
  var before = _activePredictedCurves.length;
  for (var i = _activePredictedCurves.length - 1; i >= 0; i--) {
    var s = _activePredictedCurves[i];
    if (s.pts && s.pts[0] && s.pts[0].t === t) {
      _activePredictedCurves.splice(i, 1);
    }
  }
  if (_activePredictedCurves.length !== before) {
    try { localStorage.setItem('river_predicted_curves_v' + _PRED_FORMULA_VERSION, JSON.stringify(_activePredictedCurves)); } catch(e) {}
  }
  if (MEAL_HISTORY) {
    var mealsTouched = false;
    MEAL_HISTORY.forEach(function(meal) {
      var curveAnchorMatch = meal._predictedCurve && meal._predictedCurve[0] &&
        meal._predictedCurve[0].t === t;
      if (curveAnchorMatch) {
        delete meal._predictedCurve;
        // Mark so _backfillPredictedCurves doesn't regenerate this ghost
        // on the next sync — the underlying event was deliberately deleted.
        meal._curveDeleted = true;
        mealsTouched = true;
      }
    });
    if (mealsTouched) saveMealHistory();
  }
}

function _snapshotPrediction() {
  // Anchor to now — so the prediction starts from current BG and shows
  // the effect of ALL active events from this moment forward.
  // This means corrections, boluses, hypos immediately shift the curve.
  var pts = buildSmartForecast(CGM_END || Date.now());
  if (!pts || pts.length < 2) return;
  _pushActivePredictedCurve(pts, Date.now());
  // Also store on most recent MEAL_HISTORY entry if present
  if (MEAL_HISTORY && MEAL_HISTORY[0]) MEAL_HISTORY[0]._predictedCurve = pts;
}
// Shared net-imbalance forecast generator — SINGLE SOURCE OF TRUTH for the
// prediction formula. Both the live forecast (buildSmartForecast) and the
// historical reconstruction (_backfillPredictedCurves) call this, so the two
// paths can never silently diverge on a future formula change.
//
// meals:   [{ t, items:[{carbs, gi}, ...] }, ...]
// boluses: [{ t, u }, ...]
// historicalRatios: optional ratios array ([{start,end,isf,ic,target}]) used
//   to reconstruct ISF/IC as they were at a past point in time (backfill).
//   When omitted, getISF/getIC fall back to live _TREATMENT + observed-ISF
//   adaptation, exactly as the original buildSmartForecast did.
function _computeForecastCurve(anchorT, bg, meals, boluses, historicalRatios) {
  var ISF = getISF(anchorT, historicalRatios);
  var lagMins = 10;
  var pts = [];

  // Helper: find covering bolus units for a meal (bolus within 90min before meal)
  function coveringUnits(meal) {
    var u = 0;
    boluses.forEach(function(bolus) {
      var age = (meal.t - bolus.t) / 60000; // positive = bolus before meal
      if (age >= -15 && age <= 90) u += bolus.u;
    });
    return u;
  }

  // Helper: average GI for a meal
  function mealAvgGI(meal) {
    var totalC = 0, giSum = 0;
    (meal.items || []).forEach(function(f) {
      if (f.carbs > 0) { giSum += (f.gi || 55) * f.carbs; totalC += f.carbs; }
    });
    return totalC > 0 ? giSum / totalC : 55;
  }

  // Helper: net BG effect at `mins` minutes from anchor
  // Uses imbalance formula: (carbs_absorbed - insulin_covered_carbs) / IC * ISF
  // When bolus perfectly covers carbs, net = 0 (flat BG prediction)
  function netBGEffect(mins) {
    var net = 0;

    meals.forEach(function(meal) {
      if (!meal.items) return;
      var IC   = getIC(meal.t, historicalRatios)  || 10;
      var ISFm = getISF(meal.t, historicalRatios) || ISF;
      var totalCarbs = 0;
      meal.items.forEach(function(f) { totalCarbs += (f.carbs || 0); });
      if (totalCarbs <= 0) return;

      var avgGI     = mealAvgGI(meal);
      var coverU    = coveringUnits(meal);
      var mAnchor   = (anchorT - meal.t) / 60000; // mins between meal and anchor (negative = meal after anchor)

      // Carbs absorbed from anchor to anchor+mins
      var absAtAnchor = totalCarbs * Math.max(0, 1 - _cobFgi(Math.max(0, mAnchor),       avgGI));
      var absAtFuture = totalCarbs * Math.max(0, 1 - _cobFgi(Math.max(0, mAnchor + mins), avgGI));
      var carbsWindow = Math.max(0, absAtFuture - absAtAnchor);

      // Insulin covering pro-rated to absorbed fraction
      var insFrac           = totalCarbs > 0 ? carbsWindow / totalCarbs : 0;
      var insulinCoveredC   = coverU * IC * insFrac;

      // Net: positive = carbs winning, negative = insulin winning
      net += (carbsWindow - insulinCoveredC) / IC * ISFm;
    });

    // Uncovered corrections (boluses not matched to any meal) — pure IOB suppression
    boluses.forEach(function(bolus) {
      var covered = meals.some(function(meal) {
        var age = (meal.t - bolus.t) / 60000;
        return age >= -15 && age <= 90;
      });
      if (covered) return;
      var bm   = (anchorT - bolus.t) / 60000;
      var bISF = getISF(bolus.t, historicalRatios) || ISF;
      var bProfile = _getInsulinProfile(bolus.insulin_type);
      net -= bolus.u * (_iobFn(Math.max(0, bm), bProfile.diaMins, bProfile.peakMins) -
                         _iobFn(Math.max(0, bm) + mins, bProfile.diaMins, bProfile.peakMins)) * bISF;
    });

    return net;
  }

  for (var i = 0; i <= 36; i++) {
    var mins    = i * 5;
    var ft      = anchorT + mins * 60000;
    var cgmMins = Math.max(0, mins - lagMins);

    var predBlood = Math.max(2.0, Math.min(22, bg + netBGEffect(mins)));
    var predCGM   = Math.max(2.0, Math.min(22, bg + netBGEffect(cgmMins)));

    pts.push({
      t: ft, mins: mins,
      bgBlood: predBlood, bgCGM: predCGM,
      bg: predCGM, predicted_bg: predCGM
    });
  }
  return pts;
}

function buildSmartForecast(forceAnchorT) {
  var meals   = _getActiveMealEvents();
  var boluses = _getActiveBolusEvents();
  if (meals.length === 0 && boluses.length === 0) return [];

  var anchorT;
  if (forceAnchorT) {
    anchorT = forceAnchorT;
  } else {
    var allTs = [];
    meals.forEach(function(m)   { allTs.push(m.t); });
    boluses.forEach(function(b) { allTs.push(b.t); });
    anchorT = Math.min.apply(null, allTs);
  }

  var d0  = dataAt(anchorT);
  var bg  = (d0 && d0.bg > 0) ? d0.bg : (dataAt(CGM_END || Date.now()).bg || 7.0);

  return _computeForecastCurve(anchorT, bg, meals, boluses, null);
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
      // Particle spawning disabled — animated drops/bubbles removed
      // if(Math.random()<_cobReservoir*0.88) _spawnForceParticle('cob',_domGI);
      // if(Math.random()<_iobReservoir*0.82) _spawnForceParticle('iob');
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
    // Animated drops/bubbles removed — visual noise, superseded by ribbon system
    // _drawPressureGlow(lineY);
    // _drawForceParticles(lineY);
    // _drawSparks();
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
  var phi2 = _mistFrame * 0.018;

  // ── MIST = gap between predicted CGM and actual CGM ──────────────────
  // Get the current best prediction curve
  var predCurve = null;
  if (_activePredictedCurves.length > 0) {
    predCurve = _activePredictedCurves[0].pts;
  } else if (MEAL_HISTORY.length > 0 && MEAL_HISTORY[0]._predictedCurve) {
    predCurve = MEAL_HISTORY[0]._predictedCurve;
  }
  if (!predCurve || predCurve.length < 2) return;

  // Build lookup from chained segments — same logic as drawForecastTrace
  var snaps2 = _activePredictedCurves.slice();
  MEAL_HISTORY.forEach(function(meal) {
    if (!meal._predictedCurve || meal._predictedCurve.length < 2) return;
    var aT = meal._predictedCurve[0].t;
    var dup = snaps2.some(function(s) { return s.pts && s.pts[0] && Math.abs(s.pts[0].t - aT) < 60000; });
    if (!dup) snaps2.push({ loggedAt: aT, pts: meal._predictedCurve });
  });
  snaps2.sort(function(a,b){ return b.loggedAt - a.loggedAt; });
  var segs2 = snaps2.map(function(snap) {
    return {
      pts: snap.pts,
      startT: snap.pts[0].t,
      endT:   snap.pts[snap.pts.length - 1].t
    };
  });

  // Interpolate predicted BG at a given time using the correct segment
  function getPredictedBG(t_px) {
    for (var si2 = 0; si2 < segs2.length; si2++) {
      var seg2 = segs2[si2];
      if (t_px < seg2.startT || t_px > seg2.endT) continue;
      var pts2 = seg2.pts;
      for (var pi2 = 0; pi2 < pts2.length - 1; pi2++) {
        if (t_px >= pts2[pi2].t && t_px <= pts2[pi2+1].t) {
          var frac = (t_px - pts2[pi2].t) / (pts2[pi2+1].t - pts2[pi2].t);
          return (pts2[pi2].bgCGM || pts2[pi2].bg) * (1 - frac) + (pts2[pi2+1].bgCGM || pts2[pi2+1].bg) * frac;
        }
      }
    }
    return null;
  }

  // Sample across visible canvas — compare predicted vs actual at each pixel
  var steps = 80;
  var mistPts = [];
  for (var si = 0; si <= steps; si++) {
    var px   = (si / steps) * W;
    var t_px = viewTime + (px - NOW_X * W) / W * viewSpan;
    if (t_px > (CGM_END || Date.now()) + 60000) continue;
    var actual = dataAt(t_px).bg;
    if (!actual || actual <= 0) continue;
    var cgmY = bgToY(actual);
    var predBG = getPredictedBG(t_px);
    if (predBG === null) continue;
    var predY = bgToY(predBG);
    var delta = Math.abs(cgmY - predY);
    if (delta < 3) continue;
    mistPts.push({ px: px, cgmY: cgmY, predY: predY, delta: delta });
  }

  if (mistPts.length < 2) return;

  CX.save();

  // ── Filled mist — between prediction and actual ───────────────────────
  var shimmerBase = Math.sin(phi2 * 1.8) * 0.5 + 0.5;
  var mistAlpha   = 0.07 + shimmerBase * 0.04;

  // Build a single path: top edge (prediction or actual, whichever is higher)
  // then bottom edge (the other one)
  CX.beginPath();
  mistPts.forEach(function(pt, i) {
    var topY  = Math.min(pt.cgmY, pt.predY);
    var swirl = Math.sin(phi2 * 1.1 + pt.px * 0.05) * 1.5;
    i === 0 ? CX.moveTo(pt.px, topY + swirl) : CX.lineTo(pt.px, topY + swirl);
  });
  for (var mi2 = mistPts.length - 1; mi2 >= 0; mi2--) {
    CX.lineTo(mistPts[mi2].px, Math.max(mistPts[mi2].cgmY, mistPts[mi2].predY));
  }
  CX.closePath();

  var mGr = CX.createLinearGradient(0, 0, 0, H);
  mGr.addColorStop(0,   'rgba(175,198,228,' + (mistAlpha * 0.5) + ')');
  mGr.addColorStop(0.5, 'rgba(185,205,232,' + mistAlpha + ')');
  mGr.addColorStop(1,   'rgba(175,195,225,' + (mistAlpha * 0.5) + ')');
  CX.fillStyle = mGr; CX.fill();

  // Sparse wisps inside the mist zone
  var nWisps = Math.min(5, Math.floor(mistPts.length / 8));
  for (var wi = 0; wi < nWisps; wi++) {
    var wPt = mistPts[Math.floor((wi / nWisps) * mistPts.length)];
    if (!wPt || wPt.delta < 8) continue;
    var wPhase = phi2 * 0.9 + wi * 0.8;
    var wY = Math.min(wPt.cgmY, wPt.predY) + wPt.delta * (0.25 + Math.sin(wPhase) * 0.25 + 0.25);
    var wR = 3 + Math.sin(wPhase * 1.3) * 2;
    CX.beginPath();
    CX.arc(wPt.px + Math.sin(wPhase * 0.7) * 4, wY, wR, 0, Math.PI * 2);
    CX.fillStyle = 'rgba(195,215,238,' + (mistAlpha * 0.5) + ')';
    CX.fill();
  }

  CX.restore();
}

// ── FORECAST TRACE — event-anchored prediction, always visible ───────────
// Anchored to earliest active event time. Renders identically whether
// scrubbing back or at now. Blood=warm amber, CGM=bold white, mist tunnel.
// ── FORECAST TRACE — overlapping prediction curves ──────────────────────
// Each snapshot is drawn at its own full length (anchor → anchor+3h).
// Curves are drawn oldest-first so a newer prediction visually overlays
// an older one where their windows overlap — no hard chaining cliffs,
// and short gaps between closely-spaced events (e.g. a snack 13min
// before lunch) no longer get clipped down to a sliver.
function drawForecastTrace(pal) {
  var R = pal.bgLine[0], G = pal.bgLine[1], B = pal.bgLine[2];
  var phi = (_mistFrame || 0) * 0.015;

  // Collect all snapshots sorted newest-first
  var snaps = _activePredictedCurves.slice(); // newest first
  // Add MEAL_HISTORY curves not already covered
  MEAL_HISTORY.forEach(function(meal) {
    if (!meal._predictedCurve || meal._predictedCurve.length < 2) return;
    var anchorT = meal._predictedCurve[0].t;
    var dup = snaps.some(function(s) { return s.pts && s.pts[0] && Math.abs(s.pts[0].t - anchorT) < 60000; });
    if (!dup) snaps.push({ loggedAt: anchorT, pts: meal._predictedCurve });
  });
  // Sort newest first
  snaps.sort(function(a,b){ return b.loggedAt - a.loggedAt; });

  // Fallback: live calculation
  if (snaps.length === 0) {
    var livePts = buildSmartForecast(CGM_END || Date.now());
    if (livePts && livePts.length >= 2) snaps = [{ loggedAt: Date.now(), pts: livePts }];
  }
  if (snaps.length === 0) return;

  // Each curve is drawn over its own full span — no chaining/clipping.
  var refT = CGM_END || Date.now();
  var segments = snaps.map(function(snap) {
    var startT = snap.pts[0].t;
    var endT   = snap.pts[snap.pts.length - 1].t;
    return { pts: snap.pts, startT: startT, endT: endT };
  }).filter(function(seg) {
    // Only show segments within 24h of current view
    return Math.abs(seg.startT - refT) < 24 * 3600000;
  });

  if (segments.length === 0) return;

  // Draw oldest-first so newer predictions overlay older ones on overlap.
  segments.sort(function(a,b){ return a.startT - b.startT; });

  CX.save();

  segments.forEach(function(seg) {
    // Map to screen coords, clipped to this segment's validity window
    var mapped = seg.pts
      .filter(function(p) { return p.t >= seg.startT && p.t <= seg.endT; })
      .map(function(p) {
        return {
          x:       tX(p.t),
          t:       p.t,
          mins:    p.mins,
          bgCGM:   p.bgCGM || p.bg || 7,
          bgBlood: p.bgBlood || p.bgCGM || p.bg || 7,
          yCGM:    bgToY(p.bgCGM  || p.bg || 7),
          yBlood:  bgToY(p.bgBlood || p.bgCGM || p.bg || 7)
        };
      });
    var visible = mapped.filter(function(p) { return p.x > -W * 0.5 && p.x < W * 1.5; });
    if (visible.length < 2) return;

    // ── Blood prediction — red, solid ────────────────────────────
    CX.beginPath();
    visible.forEach(function(p, i) {
      i === 0 ? CX.moveTo(p.x, p.yBlood) : CX.lineTo(p.x, p.yBlood);
    });
    CX.strokeStyle = 'rgba(220,80,60,0.45)';
    CX.lineWidth   = 1.0;
    CX.setLineDash([]);
    CX.stroke();

    // ── Lag ribbon — between blood and CGM prediction ─────────────
    CX.beginPath();
    visible.forEach(function(p, i) {
      i === 0 ? CX.moveTo(p.x, p.yBlood) : CX.lineTo(p.x, p.yBlood);
    });
    for (var ri = visible.length - 1; ri >= 0; ri--) {
      CX.lineTo(visible[ri].x, visible[ri].yCGM);
    }
    CX.closePath();
    CX.fillStyle = 'rgba(220,180,100,0.06)';
    CX.fill();

    // ── CGM prediction — dashed, same colour as actual CGM ────────
    CX.beginPath();
    visible.forEach(function(p, i) {
      i === 0 ? CX.moveTo(p.x, p.yCGM) : CX.lineTo(p.x, p.yCGM);
    });
    CX.strokeStyle = 'rgba(' + R + ',' + G + ',' + B + ',0.45)';
    CX.lineWidth   = 1.2;
    CX.setLineDash([6, 5]);
    CX.stroke();
    CX.setLineDash([]);

    // ── Value labels at 30min ─────────────────────────────────────
    CX.font = "400 8px 'DM Mono',monospace";
    CX.textAlign = 'center';
    visible.forEach(function(p) {
      if (p.mins === 0 || p.mins % 30 !== 0) return;
      if (p.x < 4 || p.x > W - 4) return;
      if (p.t > (CGM_END || Date.now()) + 60000) return; // future only
      CX.fillStyle = 'rgba(' + R + ',' + G + ',' + B + ',0.38)';
      CX.fillText(p.bgCGM.toFixed(1), p.x, p.yCGM - 7);
    });
  });

  CX.globalAlpha = 1;
  CX.restore();
}


function drawFutureClouds(cobPts, iobPts, d, pal) {
  // Future clouds removed — forward scrub disabled, predictions via drawForecastTrace
}

// ── ORB — the present moment, buoyant on the BG line ─────────────────
function drawOrb(pal, d) {
  if (!d) return;
  const x    = NOW_X * W;
  const y    = bgToY(d.bg);
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

  // ── Pass 1: collect chip positions for arc linking ─────────────────
  // Key: event timestamp → {x, carbY, bolusY} for drawing arcs between paired chips
  var _chipPos = {};

  for (var _bIdx = 0; _bIdx < allEvents.length; _bIdx++) {
    const b = allEvents[_bIdx];
    const x   = tX(b.t);
    if (x < -80 || x > W + 80) continue;
    const d   = dataAt(b.t);
    const bgY = bgToY(d.bg != null ? d.bg : nearestKnownBG(b.t));

    if (b.c > 1) {
      var _isHypo = b.note && typeof b.note === 'string' && b.note.indexOf('hypo') === 0;
      const r = _isHypo ? 255 : pal.cobR[0],
            g = _isHypo ? 210 : pal.cobR[1],
            bv= _isHypo ?  40 : pal.cobR[2];
      const cardY = bgY - 30 - Math.min(b.c * 0.4, 36);
      CX.globalAlpha = 0.35;
      CX.strokeStyle = 'rgba(' + r + ',' + g + ',' + bv + ',0.7)';
      CX.lineWidth   = 0.8; CX.setLineDash([2,5]);
      CX.beginPath(); CX.moveTo(x, bgY - 5); CX.lineTo(x, cardY + 12); CX.stroke();
      CX.setLineDash([]);
      CX.globalAlpha = 0.9; CX.fillStyle = 'rgba(' + r + ',' + g + ',' + bv + ',1)';
      CX.shadowColor = 'rgba(' + r + ',' + g + ',' + bv + ',0.8)'; CX.shadowBlur = 5;
      CX.beginPath(); CX.arc(x, bgY, 3.2, 0, Math.PI*2); CX.fill(); CX.shadowBlur = 0;
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
      window._eventCards.push({x:x, y:cardY+8, w:lw+4, h:17, data:b, idx:_bIdx, type:'carb'});
      _chipPos[b.t] = Object.assign(_chipPos[b.t] || {}, { cx: x, carbY: cardY + 8 });
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
      _chipPos[b.t] = Object.assign(_chipPos[b.t] || {}, { bx: x, bolusY: cardY + 7 });
    }
  }

  // ── Pass 2: draw bolus→carb arc links ─────────────────────────────
  // For each pure bolus event (u>0, c=0), find a carb event within 30min after it.
  // Draw a subtle curved arc from the bolus chip bottom to the carb chip bottom.
  CX.save();
  for (var _ai = 0; _ai < allEvents.length; _ai++) {
    var _ab = allEvents[_ai];
    if (!(_ab.u > 0 && !_ab.c)) continue; // only pure bolus events
    var _abPos = _chipPos[_ab.t];
    if (!_abPos || _abPos.bolusY == null) continue;
    var _abx = _abPos.bx;
    var _aby = _abPos.bolusY;
    // Find paired carb within 30 min after
    for (var _ci2 = 0; _ci2 < allEvents.length; _ci2++) {
      var _ac = allEvents[_ci2];
      if (!(_ac.c > 0 && !_ac.u)) continue;
      var gap = _ac.t - _ab.t;
      if (gap <= 0 || gap > 30 * 60000) continue;
      var _acPos = _chipPos[_ac.t];
      if (!_acPos || _acPos.carbY == null) continue;
      var _acx = _acPos.cx;
      var _acy = _acPos.carbY;
      // Arc from right edge of bolus chip to left edge of carb chip
      var _bHalfW   = 20;
      var arcStartX = _abx + _bHalfW;
      var arcEndX   = _acx - _bHalfW;
      if (arcEndX <= arcStartX) { arcStartX = _abx; arcEndX = _acx; }
      var midX    = (arcStartX + arcEndX) / 2;
      var arcDepth = Math.max(22, Math.abs(_aby - _acy) * 0.3 + 18);
      var cpY = Math.max(_aby, _acy) + arcDepth;
      CX.globalAlpha = 0.7;
      CX.strokeStyle = 'rgba(160,200,255,0.9)';
      CX.lineWidth = 1.5;
      CX.setLineDash([]);
      CX.beginPath();
      CX.moveTo(arcStartX, _aby);
      CX.quadraticCurveTo(midX, cpY, arcEndX, _acy);
      CX.stroke();
      var waitM = Math.round(gap / 60000);
      if (waitM > 0) {
        var tParam = 0.5;
        var lblX = (1-tParam)*(1-tParam)*arcStartX + 2*(1-tParam)*tParam*midX + tParam*tParam*arcEndX;
        var lblY = (1-tParam)*(1-tParam)*_aby + 2*(1-tParam)*tParam*cpY + tParam*tParam*_acy;
        CX.globalAlpha = 0.75;
        CX.font = "500 8px 'DM Mono',monospace";
        CX.fillStyle = 'rgba(160,200,255,1)';
        CX.textAlign = 'center';
        CX.fillText(waitM + 'min', lblX, lblY + 12);
      }
      break; // one link per bolus
    }
  }
  CX.setLineDash([]);
  CX.globalAlpha = 1; CX.restore();

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
  // DOM chip removed — correction nudges now handled by timer overlay system
}

// Called from frame to keep nudge chip visibility in sync with scroll state
function updateNudgeChipVisibility() {
  // Chip removed — correction nudges handled by timer overlay system
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
  // Only draw when: first poll done, viewing live (isAtNow), and gap > 10min
  if (!_cgmPolledOnce) return;           // suppress false positive on cold load
  if (!_isAtNow) return;                 // hide when scrubbing history
  if (HISTORY_RAW.length === 0) return;

  var lastT   = HISTORY_RAW[HISTORY_RAW.length-1].t;
  var gapMs   = Date.now() - lastT;
  var gapMins = Math.floor(gapMs / 60000); // integer minutes — never milliseconds

  if (gapMs < 10 * 60000) {
    // Gap closed — hide stale warn
    var sw = document.getElementById('stale-warn');
    if (sw) sw.style.display = 'none';
    return;
  }

  var lastReading = HISTORY_RAW[HISTORY_RAW.length-1];
  var x0 = tX(lastReading.t); // x of last known reading
  var x1 = NOW_X * W;         // always the orb position — Date.now() when live
  var midY = bgToY(lastReading.bg);

  // Only draw if the gap zone is visible
  if (x1 <= 0 || x0 >= W) {
    var sw = document.getElementById('stale-warn');
    if (sw) sw.style.display = 'none';
    return;
  }

  var x0c = Math.max(0, x0);
  var x1c = Math.min(W, x1);
  if (x1c <= x0c) return;

  var pulse = 0.5 + 0.5 * Math.sin(phi * 1.8);

  CX.save();

  // Soft blue-grey fog across the gap
  var laneGrad = CX.createLinearGradient(x0c, 0, x1c, 0);
  laneGrad.addColorStop(0,    'rgba(130,155,185,' + (0.05 + pulse * 0.03) + ')');
  laneGrad.addColorStop(0.3,  'rgba(150,175,205,' + (0.12 + pulse * 0.05) + ')');
  laneGrad.addColorStop(1,    'rgba(100,130,170,0)');
  CX.fillStyle = laneGrad;
  CX.fillRect(x0c, midY - 32, x1c - x0c, 64);

  // Marching dashed line — "searching"
  CX.setLineDash([3, 8]);
  CX.lineDashOffset = -(phi * 18) % 11;
  CX.strokeStyle = 'rgba(140,168,200,' + (0.25 + pulse * 0.12) + ')';
  CX.lineWidth = 1.0;
  CX.beginPath();
  CX.moveTo(x0c, midY);
  CX.lineTo(x1c, midY);
  CX.stroke();
  CX.setLineDash([]);
  CX.lineDashOffset = 0;

  // ── START BOUNDARY — vertical tick at last known reading ──
  if (x0 >= 0 && x0 <= W) {
    CX.strokeStyle = 'rgba(140,165,200,0.55)';
    CX.lineWidth = 1.2;
    CX.beginPath();
    CX.moveTo(x0, midY - 20);
    CX.lineTo(x0, midY + 20);
    CX.stroke();
    // "last reading" label below tick
    CX.globalAlpha = 0.45;
    CX.font = "400 10px 'DM Mono',monospace";
    CX.fillStyle  = 'rgba(150,175,205,1)';
    CX.textAlign  = 'center';
    CX.fillText('last reading', x0, midY + 34);
    CX.globalAlpha = 1;
  }

  // ── CENTRE LABEL — duration, only if zone is wide enough ──
  var zoneW = x1c - x0c;
  if (zoneW > 60) {
    var labelX = x0c + zoneW * 0.5;
    CX.globalAlpha = 0.6 + pulse * 0.15;
    CX.font = "400 11px 'DM Mono',monospace";
    CX.fillStyle   = 'rgba(155,180,215,1)';
    CX.textAlign   = 'center';
    CX.fillText('no sensor  ' + gapMins + 'm', labelX, midY - 38);
    CX.globalAlpha = 1;
  }

  CX.restore();

  // Drive stale-warn HTML element (single source — updateHUD no longer writes it)
  var sw = document.getElementById('stale-warn');
  if (sw) {
    sw.style.display = 'block';
    sw.textContent   = 'no sensor · ' + gapMins + 'm';
  }
}

// Lightweight replacement for drawNoDataOrb() when canvas visuals are stubbed.
// Keeps the stale-warn text element alive without drawing fog/orb on canvas.
function _updateStaleWarnOnly() {
  if (!_cgmPolledOnce) return;
  if (!_isAtNow) return;
  if (HISTORY_RAW.length === 0) return;
  var lastT   = HISTORY_RAW[HISTORY_RAW.length-1].t;
  var gapMs   = Date.now() - lastT;
  var gapMins = Math.floor(gapMs / 60000);
  var sw = document.getElementById('stale-warn');
  if (!sw) return;
  if (gapMs < 10 * 60000) {
    sw.style.display = 'none';
  } else {
    sw.style.display = 'block';
    sw.textContent   = 'no sensor · ' + gapMins + 'm';
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
  // Banner replaced by timer overlay system — route to toast for eat reminders
  showToast(msg);
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

  // Correction window state tracked for ketone timer context — no card shown
  // (correction nudges handled by timer overlay system, Steps 3–7)
  var iobClear = d.iob < 0.5;
  var bolusGap = minsSinceLastBolus > 90;
  var high = d.bg > 10.5;
  if (high && iobClear && bolusGap) {
    _alertState = 'correction';
    // Audio-only nudge — no DOM card
    if (ALERTS.canFire('corr_nudge', 60*60000)) {
      ALERTS.correctionNudge();
      ALERTS.fire('corr_nudge');
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

  // Stale-warn element is managed exclusively by drawNoDataOrb()
  // (removed from here to prevent duplication and millisecond-value bugs)

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

  // Mana pill — fixed position to the right of the orb, IOB above / COB below
  // No longer tracks reservoir peaks (too jumpy) — anchored relative to orb
  var pill = document.getElementById('mana-pill');
  if (pill) {
    var orbX = NOW_X * W;
    var orbY = d ? bgToY(d.bg) : window.innerHeight / 2;
    var hasActive = d.cob > 0.5 || d.iob > 0.1;
    pill.style.opacity = hasActive ? '1' : '0';
    // Position pill canvas-relative: right of orb
    // Use fixed CSS positioning relative to window
    var pillRight = Math.round(window.innerWidth * (1 - NOW_X) - 60);
    pill.style.left  = 'auto';
    pill.style.right = pillRight + 'px';
    pill.style.transform = 'none';
    pill.style.bottom = 'auto';
    // Centre vertically on the orb screen position
    var orbScreenY = Math.round((orbY / H) * window.innerHeight);
    pill.style.top = Math.max(40, orbScreenY - 24) + 'px';
    pill.style.flexDirection = 'column-reverse'; // IOB (second in DOM) appears above COB
  }
}

function returnToNow() {
  _isAtNow = true;
  viewTime = Date.now(); // wall clock — not CGM_END
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

// ═══════════════════════════════════════════════════════════════════════════
// CLINICAL TIMER OVERLAY — Steps 1, 2, 3
// Ambient pills: ketone check | hypo recovery | correction window
// ═══════════════════════════════════════════════════════════════════════════

// ── localStorage persistence (UI state only — not clinical state) ─────────
function _saveTimerState() {
  try {
    localStorage.setItem('river_timers', JSON.stringify({
      ketone_minimised: _activeTimers.ketone.minimised,
    }));
  } catch(e) {}
}

function _loadTimerState() {
  try {
    var saved = JSON.parse(localStorage.getItem('river_timers') || 'null');
    if (saved) {
      if (saved.ketone_minimised !== undefined) {
        _activeTimers.ketone.minimised = !!saved.ketone_minimised;
      }
    }
  } catch(e) {}
}

// ── _getDisplayName — human-readable label for this device ────────────────
function _getDisplayName() {
  return localStorage.getItem('river_display_name') || 'Someone';
}

// ── _writeTimerEvent — fire-and-forget write to timer_events ─────────────
async function _writeTimerEvent(payload) {
  if (!SUPABASE_READY) return;
  try {
    await fetch(SUPABASE_URL + '/rest/v1/timer_events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        t:               Date.now(),
        timer_type:      payload.timer_type,
        event_type:      payload.event_type,
        value:           payload.value   ?? null,
        note:            payload.note    ?? null,
        logged_by:       _deviceId,
        display_name:    _getDisplayName(),
        episode_start_t: payload.episode_start_t ?? null,
      }),
    });
  } catch(e) {
    console.warn('[Timer] write failed:', e);
  }
}

// ── _syncTimerEvents — pull remote entries for active episodes ────────────
async function _syncTimerEvents() {
  if (!SUPABASE_READY) return;
  var ketoneEpisode = _activeTimers.ketone.episode_start_t;
  var hypoEpisode   = _activeTimers.hypo.treatmentT;
  if (!ketoneEpisode && !hypoEpisode) return;

  var episodeTimes = [ketoneEpisode, hypoEpisode].filter(Boolean);
  var qs = 'episode_start_t=in.(' + episodeTimes.join(',') + ')' +
           '&event_type=eq.entry_logged' +
           '&logged_by=neq.' + _deviceId +
           '&order=t.desc&limit=5';
  try {
    var res = await fetch(SUPABASE_URL + '/rest/v1/timer_events?' + qs, {
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
    });
    var rows = await res.json();
    if (!Array.isArray(rows)) return;
    var now = Date.now();

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.timer_type === 'ketone' && row.episode_start_t === ketoneEpisode) {
        if (_activeTimers.ketone.state !== 'inactive' && _activeTimers.ketone.state !== 'resolved_remote') {
          _activeTimers.ketone.state     = 'resolved_remote';
          _activeTimers.ketone.minimised = false;
          _activeTimers.ketone.remote    = {
            value:        row.value,
            display_name: row.display_name || 'Someone',
            t:            row.t,
            note:         row.note,
            shown_at:     now,
          };
          _saveTimerState();
        }
      }
      if (row.timer_type === 'hypo' && row.episode_start_t === hypoEpisode) {
        if (_activeTimers.hypo.state !== 'inactive' && _activeTimers.hypo.state !== 'resolved_remote') {
          _activeTimers.hypo.state  = 'resolved_remote';
          _activeTimers.hypo.remote = {
            value:        row.value,
            display_name: row.display_name || 'Someone',
            t:            row.t,
            note:         row.note,
            shown_at:     now,
          };
          _saveTimerState();
        }
      }
    }
    // _renderTimerOverlay(); // [STUBBED] timer pills hidden pending UX fix
  } catch(e) {
    console.warn('[Timer] sync failed:', e);
  }
}

// ── _updateTimers — throttled evaluation (runs at most every 30s) ─────────
function _updateTimers() {
  var now = Date.now();
  if (now - _timerLastEval < 30000) return;
  _timerLastEval = now;

  var latest = HISTORY_RAW[HISTORY_RAW.length - 1];
  if (!latest) return;

  var latestBG = latest.bg;
  var latestT  = latest.t;

  // ── Ketone timer ───────────────────────────────────────────────────────
  var threshold  = (_TREATMENT && _TREATMENT.ketone_threshold  != null) ? _TREATMENT.ketone_threshold  : 14.0;
  var windowMins = (_TREATMENT && _TREATMENT.ketone_window_mins != null) ? _TREATMENT.ketone_window_mins : 120;
  var showKetone = (_TREATMENT && _TREATMENT.show_ketone_timer != null)  ? _TREATMENT.show_ketone_timer  : true;
  var k = _activeTimers.ketone;

  if (showKetone && latestBG !== undefined) {
    if (latestBG >= threshold) {
      k.below_since_t = null; // clear any partial dip

      if (k.state === 'inactive') {
        k.state           = 'counting';
        k.episode_start_t = latestT;
        k.minimised       = false;
        _writeTimerEvent({
          timer_type:      'ketone',
          event_type:      'episode_start',
          value:           latestBG,
          episode_start_t: k.episode_start_t,
        });
        _saveTimerState();
      }

      if (k.state === 'counting') {
        var elapsed = now - k.episode_start_t;
        if (elapsed >= windowMins * 60 * 1000) {
          k.state     = 'prompt';
          k.minimised = false; // always surface prompt
          _saveTimerState();
        }
      }

    } else {
      // BG below threshold — track how long
      if (k.state !== 'inactive' && k.state !== 'resolved_remote') {
        if (!k.below_since_t) k.below_since_t = latestT;
        var belowDuration = now - k.below_since_t;
        if (belowDuration >= 30 * 60 * 1000) {
          // Sustained 30 min below — episode over
          k.state           = 'inactive';
          k.episode_start_t = null;
          k.below_since_t   = null;
          k.minimised       = false;
          k.remote          = null;
          k._optionsOpen    = false;
          _saveTimerState();
        }
      }
    }
  }

  // ── resolved_remote auto-clear (10 min) ──────────────────────────────
  if (k.state === 'resolved_remote' && k.remote && k.remote.shown_at) {
    if (now - k.remote.shown_at > 10 * 60 * 1000) {
      k.state = 'inactive'; k.remote = null; k.episode_start_t = null; _saveTimerState();
    }
  }
  if (_activeTimers.hypo.state === 'resolved_remote' && _activeTimers.hypo.remote && _activeTimers.hypo.remote.shown_at) {
    if (now - _activeTimers.hypo.remote.shown_at > 10 * 60 * 1000) {
      _activeTimers.hypo.state = 'inactive'; _activeTimers.hypo.remote = null; _activeTimers.hypo.treatmentT = null; _saveTimerState();
    }
  }

  // ── Hypo timer — trigger on hypo: events ─────────────────────────────
  var showHypo = (_TREATMENT && _TREATMENT.show_hypo_timer != null) ? _TREATMENT.show_hypo_timer : true;
  if (showHypo) {
    var recheckMins = (_TREATMENT && _TREATMENT.hypo_recheck_mins != null) ? _TREATMENT.hypo_recheck_mins : 15;
    var h = _activeTimers.hypo;
    if (h.state === 'inactive') {
      // Look for an unhandled recent hypo event
      var cutoff = now - recheckMins * 2 * 60 * 1000;
      var hypoEvt = null;
      for (var ei = LOGGED_EVENTS.length - 1; ei >= 0; ei--) {
        var ev = LOGGED_EVENTS[ei];
        if (ev.t < cutoff) break;
        if (ev.note && ev.note.indexOf('hypo:') === 0 && ev.t > (h._lastHandledT || 0)) {
          hypoEvt = ev; break;
        }
      }
      if (hypoEvt) {
        h.state      = 'counting';
        h.treatmentT = hypoEvt.t;
        h._lastHandledT = hypoEvt.t;
        _saveTimerState();
      }
    }
    if (h.state === 'counting') {
      var hypoElapsed = now - h.treatmentT;
      var recheckMs   = recheckMins * 60 * 1000;
      if (hypoElapsed >= recheckMs) {
        h.state = 'prompt';
        _saveTimerState();
      }
    }
  }

  console.log('[Timer eval] BG:', latestBG, 'states:', _activeTimers.ketone.state, _activeTimers.hypo.state, _activeTimers.correction.state);
  // _renderTimerOverlay(); // [STUBBED] timer pills hidden pending UX fix
}

// ── Helper: format ms to H:MM or MM:SS ───────────────────────────────────
function _formatTimerRemaining(ms) {
  if (ms <= 0) return '0:00';
  var totalSec = Math.ceil(ms / 1000);
  var mins     = Math.floor(totalSec / 60);
  var secs     = totalSec % 60;
  if (mins >= 60) {
    var hrs = Math.floor(mins / 60);
    var rem = mins % 60;
    return hrs + ':' + (rem < 10 ? '0' : '') + rem;
  }
  return mins + ':' + (secs < 10 ? '0' : '') + secs;
}

function _formatTime(ms) {
  var d = new Date(ms);
  return d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
}

// ── _ketoneHide — mid-timer hide action ──────────────────────────────────
function _ketoneHide(reason) {
  _writeTimerEvent({
    timer_type:      'ketone',
    event_type:      'hide',
    note:            'ketone_hide:' + reason,
    episode_start_t: _activeTimers.ketone.episode_start_t,
  });
  if (reason === 'blood_below_14') {
    var latestBG = (HISTORY_RAW[HISTORY_RAW.length - 1] || {}).bg;
    var thr = (_TREATMENT && _TREATMENT.ketone_threshold != null) ? _TREATMENT.ketone_threshold : 14.0;
    if (latestBG < thr) {
      _activeTimers.ketone.state           = 'inactive';
      _activeTimers.ketone.episode_start_t = null;
      _activeTimers.ketone.below_since_t   = null;
    }
  }
  _activeTimers.ketone._optionsOpen = false;
  _saveTimerState();
  // _renderTimerOverlay(); // [STUBBED]
}

// ── _ketoneMinimise — collapse to dot ────────────────────────────────────
function _ketoneMinimise() {
  _activeTimers.ketone.minimised    = true;
  _activeTimers.ketone._optionsOpen = false;
  _saveTimerState();
  // _renderTimerOverlay(); // [STUBBED]
}

// ── openKetoneModal — stub for Step 4 ────────────────────────────────────
function openKetoneModal() {
  console.log('[Ketone] modal not yet built. episode_start_t:', _activeTimers.ketone.episode_start_t);
  showToast('Ketone entry coming soon');
}

// ── _renderTimerOverlay — build/update DOM pill container ─────────────────
// [STUBBED] Pills are hidden until clear/persist bugs are fixed. All state/sync logic intact.
function _renderTimerOverlay() {
  // STUB: hide timer overlay UI — reinstate once clear/persist logic is fixed
  var el = document.getElementById('timer-overlay');
  if (el) el.innerHTML = '';
  return;
  // --- original render below (unreachable until stub removed) ---
  var el = document.getElementById('timer-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'timer-overlay';
    el.style.cssText = [
      'position:fixed',
      'top:16px',
      'right:16px',
      'z-index:200',
      'display:flex',
      'flex-direction:column',
      'align-items:flex-end',
      'gap:8px',
      'pointer-events:none',
      'font-family:DM Mono,monospace',
    ].join(';');

    // Inject CSS for pulse + peek animations once
    if (!document.getElementById('timer-overlay-css')) {
      var style = document.createElement('style');
      style.id = 'timer-overlay-css';
      style.textContent = [
        '@keyframes timer-pulse{',
        '0%,100%{box-shadow:0 0 0 0 rgba(186,117,23,0.5)}',
        '50%{box-shadow:0 0 0 10px rgba(186,117,23,0)}',
        '}',
        '@keyframes hypo-pulse{',
        '0%,100%{box-shadow:0 0 0 0 rgba(220,80,80,0.5)}',
        '50%{box-shadow:0 0 0 10px rgba(220,80,80,0)}',
        '}',
        '.timer-pill{',
        'pointer-events:auto;',
        'border-radius:20px;',
        'padding:6px 14px;',
        'font-size:13px;',
        'font-weight:600;',
        'cursor:pointer;',
        'user-select:none;',
        '-webkit-user-select:none;',
        'transition:all 0.2s;',
        'white-space:nowrap;',
        '}',
        '.timer-pill-amber{background:rgba(186,117,23,0.92);color:#fffbe0;}',
        '.timer-pill-coral{background:rgba(210,70,70,0.92);color:#fff5f5;}',
        '.timer-pill-green{background:rgba(40,160,90,0.92);color:#e8fff0;}',
        '.timer-pill-gray{background:rgba(80,90,100,0.75);color:rgba(220,230,240,0.8);}',
        '.timer-pill-pulse-amber{animation:timer-pulse 1.5s ease-in-out infinite;}',
        '.timer-pill-pulse-coral{animation:hypo-pulse 1.5s ease-in-out infinite;}',
        '.timer-dot{',
        'pointer-events:auto;',
        'width:12px;height:12px;',
        'border-radius:50%;',
        'cursor:pointer;',
        '}',
        '.timer-options{',
        'pointer-events:auto;',
        'background:rgba(15,20,35,0.96);',
        'border:1px solid rgba(186,117,23,0.35);',
        'border-radius:14px;',
        'overflow:hidden;',
        'margin-top:4px;',
        '}',
        '.timer-option-row{',
        'padding:10px 16px;',
        'font-size:12px;',
        'color:rgba(220,200,160,0.9);',
        'cursor:pointer;',
        'border-bottom:1px solid rgba(186,117,23,0.15);',
        '}',
        '.timer-option-row:last-child{border-bottom:none;}',
        '.timer-option-row:active{background:rgba(186,117,23,0.15);}',
      ].join('');
      document.head.appendChild(style);
    }

    document.body.appendChild(el);
  }

  var now = Date.now();
  var html = '';

  // ── Ketone pill ──────────────────────────────────────────────────────
  var k = _activeTimers.ketone;
  var windowMins = (_TREATMENT && _TREATMENT.ketone_window_mins != null) ? _TREATMENT.ketone_window_mins : 120;
  var showKetone = (_TREATMENT && _TREATMENT.show_ketone_timer != null) ? _TREATMENT.show_ketone_timer : true;

  if (showKetone) {
    if (k.state === 'counting') {
      if (k.minimised) {
        // Minimised dot — tap to peek
        var dotColor = 'rgba(186,117,23,0.85)';
        if (k._peekUntil && now < k._peekUntil) {
          // Peek: show time inline then re-minimise
          var remMs  = Math.max(0, windowMins * 60 * 1000 - (now - k.episode_start_t));
          var remStr = _formatTimerRemaining(remMs);
          html += '<div class="timer-pill timer-pill-amber" style="font-size:11px;opacity:0.85" ' +
                  'onclick="_activeTimers.ketone._peekUntil=0;_renderTimerOverlay()">' +
                  '⚠ ' + remStr + ' remaining</div>';
        } else {
          html += '<div class="timer-dot" style="background:' + dotColor + ';margin-right:2px" ' +
                  'title="Ketone check in progress — tap to peek" ' +
                  'onclick="_activeTimers.ketone._peekUntil=Date.now()+3000;_renderTimerOverlay()"></div>';
        }
      } else {
        // Full pill + optional options panel
        var rem  = Math.max(0, windowMins * 60 * 1000 - (now - k.episode_start_t));
        var remS = _formatTimerRemaining(rem);
        html += '<div style="display:flex;flex-direction:column;align-items:flex-end">';
        html += '<div class="timer-pill timer-pill-amber" ' +
                'onclick="_activeTimers.ketone._optionsOpen=!_activeTimers.ketone._optionsOpen;_renderTimerOverlay()">' +
                '⚠ Check ketones in ' + remS + ' &nbsp;×</div>';
        if (k._optionsOpen) {
          html += '<div class="timer-options" style="min-width:220px">';
          html += '<div class="timer-option-row" onclick="_ketoneHide(\'blood_below_14\')">Blood prick showed &lt; 14</div>';
          html += '<div class="timer-option-row" onclick="_ketoneHide(\'already_checked\');openKetoneModal()">Already checked ketones</div>';
          html += '<div class="timer-option-row" onclick="_ketoneMinimise()">Minimise</div>';
          html += '</div>';
        }
        html += '</div>';
      }
    } else if (k.state === 'prompt') {
      html += '<div class="timer-pill timer-pill-amber timer-pill-pulse-amber" ' +
              'onclick="openKetoneModal()">⚠ Enter ketone reading →</div>';
    } else if (k.state === 'resolved_remote' && k.remote) {
      var note = k.remote.note || '';
      var val  = (k.remote.value != null) ? k.remote.value.toFixed(1) + ' mmol' : '';
      var who  = k.remote.display_name || 'Someone';
      var when = _formatTime(k.remote.t);
      var text = note.indexOf('skipped') !== -1
        ? '✓ Ketones not checked · ' + who + ' · ' + when
        : '✓ Ketones ' + val + ' · ' + who + ' · ' + when;
      html += '<div class="timer-pill timer-pill-green" ' +
              'onclick="_activeTimers.ketone.state=\'inactive\';_activeTimers.ketone.remote=null;_renderTimerOverlay()">' +
              text + '</div>';
    }
  }

  // ── Hypo pill ────────────────────────────────────────────────────────
  var hy = _activeTimers.hypo;
  var showHypo = (_TREATMENT && _TREATMENT.show_hypo_timer != null) ? _TREATMENT.show_hypo_timer : true;
  var recheckMins = (_TREATMENT && _TREATMENT.hypo_recheck_mins != null) ? _TREATMENT.hypo_recheck_mins : 15;

  if (showHypo) {
    if (hy.state === 'counting') {
      var hyRem  = Math.max(0, recheckMins * 60 * 1000 - (now - hy.treatmentT));
      var hyRemS = _formatTimerRemaining(hyRem);
      html += '<div class="timer-pill timer-pill-coral">🍬 Recheck in ' + hyRemS + '</div>';
    } else if (hy.state === 'prompt') {
      html += '<div class="timer-pill timer-pill-coral timer-pill-pulse-coral">🍬 Recheck blood now →</div>';
    } else if (hy.state === 'resolved_remote' && hy.remote) {
      var hyNote = hy.remote.note || '';
      var hyVal  = (hy.remote.value != null) ? hy.remote.value.toFixed(1) + ' mmol' : '';
      var hyWho  = hy.remote.display_name || 'Someone';
      var hyWhen = _formatTime(hy.remote.t);
      var hyText = hyNote.indexOf('skip') !== -1
        ? '✓ Recheck skipped · ' + hyWho
        : '✓ Recheck done · ' + hyVal + ' · ' + hyWho + ' · ' + hyWhen;
      html += '<div class="timer-pill timer-pill-green" ' +
              'onclick="_activeTimers.hypo.state=\'inactive\';_activeTimers.hypo.remote=null;_renderTimerOverlay()">' +
              hyText + '</div>';
    }
  }

  // ── Correction pill ──────────────────────────────────────────────────
  var c = _activeTimers.correction;
  var showCorr = (_TREATMENT && _TREATMENT.show_correction_timer != null) ? _TREATMENT.show_correction_timer : true;
  if (showCorr && c.state === 'trending_down') {
    html += '<div class="timer-pill timer-pill-gray" style="font-size:11px">↓ Trending down — watching</div>';
  }

  // ── Debug pill (dev only) ────────────────────────────────────────────
  if (!html && window.RIVER_DEBUG) {
    html = '<div style="pointer-events:none;font-size:9px;color:rgba(150,160,180,0.4);padding:2px 8px">[timers ok]</div>';
  }

  el.innerHTML = html;
}

function frame(ts) {
  try {
  const dt=Math.min((ts-t0)/1000, 0.05); t0=ts;
  phi+=0.4*dt;
  treeScrollX+=10*dt; // river current speed

  // Wall clock drives the timeline. When live, viewTime IS Date.now().
  if (_isAtNow) viewTime = Date.now();
  const d   = dataAt(viewTime);
  const pal = palette(viewTime);
  if (!d || !pal) { requestAnimationFrame(frame); return; }

  _updateTimers(); // clinical timer evaluation — throttled to 30s

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
  // drawSensorOutageZones();   // [STUBBED] amber haze — hidden pending better UX
  drawBloodPricks();         // red diamond prick markers

  // ── CONTEXT ─────────────────────────────────────────────────────
  drawTransition(pal);
  drawFutureClouds(cobPts, iobPts, d, pal);
  drawForecastTrace(pal);   // forecast BG line beyond now (navigable)
  drawTimeLabels(pal);

  // Forward scrub disabled — viewTime is capped at CGM_END

  // ── THE ORB — buoyant on BG line ────────────────────────────────
  drawOrb(pal, d);

  // ── NOW PULSE — breath at current moment ─────────────────────
  drawNowPulse(pal, d);
  drawRiverPebble(pal);
  drawHoverTooltip(pal);
  // drawNoDataOrb(pal);  // [STUBBED] sensor gap fog/orb — hidden pending better UX
  _updateStaleWarnOnly(); // still drives stale-warn text element

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

  // Show "return to now" when scrolled away from wall-clock now
  const awayFromNow = (Date.now() - viewTime) > 8 * 60000;
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
      "font-family:DM Mono,monospace",
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
  // Label and colour differ for future vs past scrub
  nowBtn.textContent = 'now ›';
  nowBtn.style.borderColor = 'rgba(62,180,120,0.35)';
  nowBtn.style.color = 'rgba(62,200,140,0.85)';

  // time labels handled by drawTimeLabels

  checkAlerts(_isAtNow ? d : null);
  drawHypoPulse(pal);
  updateHUD(d, pal);
  updateNudgeChipVisibility();
  _maybeDetectGhostEvent(); // throttled to 5min
  _maybeDetectOutage();     // throttled to 60s — auto-log sensor gaps
  if (!window._ghostPebbleCards) window._ghostPebbleCards = [];
  window._ghostPebbleCards = [];
  drawGhostPebbles(pal);
  _maybeDetectUnannouncedMeal(); // throttled to 15min intervals internally

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
    viewTime=Math.max(CGM_START, Math.min(Date.now(), drag.t0-(e.touches[0].clientX-drag.x0)*(viewSpan/W))); _isAtNow=false;
    _maybeLoadOlderHistory();
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
let md={on:false,dragging:false,x0:0,t0:0};
CV.addEventListener('mousedown',e=>{if(!e.target.closest('#sheet,#flow-dock,.dock-btn,#whisper-overlay,#food-mgr-overlay,#hypo-overlay,#corr-overlay,#food-add-overlay,[id$=-overlay],button,input,textarea,select'))md={on:true,dragging:false,x0:e.clientX,t0:viewTime}});
CV.addEventListener('mousemove',e=>{if(md.on){var dx=e.clientX-md.x0;if(!md.dragging&&Math.abs(dx)<5)return;md.dragging=true;_isAtNow=false;viewTime=Math.max(CGM_START, Math.min(Date.now(), md.t0-dx*(viewSpan/W)));_maybeLoadOlderHistory();}});
CV.addEventListener('mouseup',()=>{md.on=false;md.dragging=false;});

// ── QUICK JUMP DAY STRIP ──────────────────────────────────────────────────
// Floating bottom strip: last 14 days as tappable date pills.
// Each pill shows a mini TIR bar. Tap to jump to midday of that date.
// Appears on long-press of the canvas background (no chip hit), or via
// the calendar button (injected into debug tray). Auto-hides after 4s.

var _dayStripVisible = false;
var _dayStripHideTimer = null;

function showDayStrip() {
  var ex = document.getElementById('day-strip');
  if (ex) { ex.remove(); _dayStripVisible = false; return; } // toggle

  _dayStripVisible = true;
  var strip = document.createElement('div');
  strip.id = 'day-strip';
  strip.style.cssText = 'position:fixed;bottom:80px;left:0;right:0;z-index:70;' +
    'display:flex;justify-content:center;pointer-events:none;padding:0 8px';
  strip.addEventListener('touchstart', function(e){ e.stopPropagation(); }, {passive:true});

  var inner = document.createElement('div');
  inner.style.cssText = 'display:flex;gap:5px;overflow-x:auto;padding:8px 10px;' +
    'background:rgba(6,10,24,0.94);backdrop-filter:blur(12px);border-radius:14px;' +
    'border:1px solid rgba(255,255,255,0.07);pointer-events:auto;' +
    '-webkit-overflow-scrolling:touch;scrollbar-width:none;max-width:100%';

  var today = new Date();
  today.setHours(0,0,0,0);
  var DAYS = 21; // 3 weeks back

  for (var di = DAYS - 1; di >= 0; di--) {
    var dayT = today.getTime() - di * 86400000;
    var dayDate = new Date(dayT);
    var dateStr = dayDate.toISOString().slice(0,10);
    var isToday = di === 0;

    // Mini TIR for this day from HISTORY_RAW
    var dayReadings = HISTORY_RAW.filter(function(r){ return r.t >= dayT && r.t < dayT + 86400000 && r.bg > 0; });
    var tirPct = 0, lowPct = 0, highPct = 0, hasData = dayReadings.length >= 4;
    if (hasData) {
      tirPct  = Math.round(dayReadings.filter(function(r){ return r.bg >= 3.9 && r.bg <= 10; }).length / dayReadings.length * 100);
      lowPct  = Math.round(dayReadings.filter(function(r){ return r.bg < 3.9; }).length / dayReadings.length * 100);
      highPct = 100 - tirPct - lowPct;
    }

    // Day label
    var dayLabel = isToday ? 'today' :
      di === 1 ? 'yest' :
      dayDate.toLocaleDateString('en-GB', {weekday:'short'}).toLowerCase() +
      ' ' + dayDate.getDate();

    // Has events?
    var hasEvents = BOLUS_EVENTS.some(function(e){ return e.t >= dayT && e.t < dayT + 86400000; });

    var pill = document.createElement('button');
    pill.style.cssText = 'flex:0 0 auto;display:flex;flex-direction:column;align-items:center;' +
      'gap:2px;padding:5px 8px;border-radius:9px;border:1px solid ' +
      (isToday ? 'rgba(62,180,120,0.4)' : hasData ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)') + ';' +
      'background:' + (isToday ? 'rgba(62,180,120,0.08)' : 'rgba(255,255,255,0.03)') + ';' +
      'cursor:pointer;touch-action:manipulation;min-width:38px';

    // TIR bar
    var barHtml = hasData
      ? '<div style="width:32px;height:3px;border-radius:2px;overflow:hidden;display:flex;background:rgba(255,255,255,0.05)">' +
          '<div style="width:' + lowPct + '%;background:rgba(255,210,40,0.8)"></div>' +
          '<div style="width:' + tirPct + '%;background:rgba(62,180,120,0.8)"></div>' +
          '<div style="width:' + highPct + '%;background:rgba(220,100,40,0.7)"></div>' +
        '</div>'
      : '<div style="width:32px;height:3px;border-radius:2px;background:rgba(255,255,255,0.05)"></div>';

    var dotHtml = hasEvents
      ? '<div style="width:3px;height:3px;border-radius:50%;background:rgba(62,180,120,0.6)"></div>'
      : '<div style="width:3px;height:3px"></div>';

    pill.innerHTML =
      '<span style="font-family:DM Mono,monospace;font-size:8px;color:' +
        (isToday ? 'rgba(62,180,120,0.9)' : hasData ? 'rgba(180,200,220,0.6)' : 'rgba(120,140,160,0.35)') +
        ';white-space:nowrap">' + dayLabel + '</span>' +
      barHtml +
      (hasData ? '<span style="font-family:DM Mono,monospace;font-size:7px;color:rgba(62,180,120,0.6)">' + tirPct + '%</span>' : '') +
      dotHtml;

    (function(jumpT) {
      pill.addEventListener('click', function() {
        viewTime = jumpT + 12 * 3600000;
        _isAtNow = false;
        hideDayStrip();
      });
    })(dayT);

    inner.appendChild(pill);
  }

  strip.appendChild(inner);
  document.body.appendChild(strip);

  // ── RECENT ENTRIES — fallback edit list ──────────────────────────
  // Chips on the canvas can become unclickable (e.g. a meal/bolus logged
  // at a time when the CGM was offline can render with a degenerate hit
  // box). This list gives a guaranteed tap target straight into
  // openContextCard for today's logged events, bypassing canvas hit-testing.
  var todayStart = today.getTime();
  var todayEnd   = todayStart + 86400000;
  var todaysEntries = [];
  for (var _ei = 0; _ei < LOGGED_EVENTS.length; _ei++) {
    var _e = LOGGED_EVENTS[_ei];
    if (_e.t >= todayStart && _e.t < todayEnd && (_e.c > 0 || _e.u > 0)) {
      todaysEntries.push({ idx: _ei, ev: _e });
    }
  }
  todaysEntries.sort(function(a,b){ return b.ev.t - a.ev.t; }); // most recent first

  if (todaysEntries.length > 0) {
    var recentWrap = document.createElement('div');
    recentWrap.style.cssText = 'display:flex;justify-content:center;pointer-events:none;' +
      'padding:6px 8px 0';

    var recentInner = document.createElement('div');
    recentInner.style.cssText = 'display:flex;gap:5px;overflow-x:auto;padding:6px 10px;' +
      'background:rgba(6,10,24,0.94);backdrop-filter:blur(12px);border-radius:14px;' +
      'border:1px solid rgba(255,255,255,0.07);pointer-events:auto;' +
      '-webkit-overflow-scrolling:touch;scrollbar-width:none;max-width:100%';
    recentInner.addEventListener('touchstart', function(e){ e.stopPropagation(); }, {passive:true});

    todaysEntries.slice(0, 12).forEach(function(item) {
      var ev = item.ev;
      var dt = new Date(ev.t);
      var timeStr = dt.toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'});
      var parts = [];
      if (ev.c > 0) parts.push(ev.c + 'g');
      if (ev.u > 0) parts.push(ev.u.toFixed(1) + 'U');

      var btn = document.createElement('button');
      btn.style.cssText = 'flex:0 0 auto;display:flex;flex-direction:column;align-items:center;' +
        'gap:2px;padding:5px 9px;border-radius:9px;border:1px solid rgba(255,255,255,0.08);' +
        'background:rgba(255,255,255,0.03);cursor:pointer;touch-action:manipulation;min-width:48px';
      btn.innerHTML =
        '<span style="font-family:DM Mono,monospace;font-size:8px;color:rgba(180,200,220,0.6);white-space:nowrap">' + timeStr + '</span>' +
        '<span style="font-family:DM Mono,monospace;font-size:9px;color:rgba(220,230,240,0.9);white-space:nowrap">' + parts.join(' · ') + '</span>';

      (function(eventIdx, evData) {
        btn.addEventListener('click', function() {
          hideDayStrip();
          openContextCard(eventIdx, evData);
        });
      })(item.idx, ev);

      recentInner.appendChild(btn);
    });

    recentWrap.appendChild(recentInner);
    strip.appendChild(recentWrap);
  }

  // Scroll to end (today)
  requestAnimationFrame(function(){ inner.scrollLeft = inner.scrollWidth; });

  // Auto-hide after 8s (extended to give time to use recent entries list)
  if (_dayStripHideTimer) clearTimeout(_dayStripHideTimer);
  _dayStripHideTimer = setTimeout(hideDayStrip, 8000);
}

function hideDayStrip() {
  var el = document.getElementById('day-strip');
  if (el) el.remove();
  _dayStripVisible = false;
  if (_dayStripHideTimer) { clearTimeout(_dayStripHideTimer); _dayStripHideTimer = null; }
}

// Long-press on canvas background (no chip hit) → show day strip
// Reuse the _canvasTapTimer mechanism: if long press fires with no chip, open strip
var _canvasLongPressNoChip = false;
(function() {
  var _orig = _handleCanvasHit;
  // Patch the long-press path: if no chip found, show day strip
  window._handleCanvasHitNoChip = function() { showDayStrip(); };
})();


// When the user scrubs back past what we have, fetch the next chunk.
// Readings: from Supabase (7-day retention) — falls back gracefully if not available.
// Events: same — pulls a wider window from Supabase.
// All fetches throttled: one in flight at a time, 30s minimum between fetches.

var _olderHistoryFetching = false;
// If HISTORY_RAW is thin (< 2h of data) relative to CGM_START age,
// reset fetchedTo to now so lazy fetch triggers immediately on scroll.
var _olderHistoryFetchedTo = (function() {
  var age = Date.now() - CGM_START;
  var thin = HISTORY_RAW.length < 30; // fewer than ~2.5h of readings
  return (thin && age > 2 * 3600000) ? Date.now() : CGM_START;
})();
var _olderHistoryLastFetch = 0;
var _olderHistoryToast = null;

function _maybeLoadOlderHistory() {
  if (!SUPABASE_READY) { console.log('[hist] blocked: supabase not ready'); return; }
  if (_olderHistoryFetching) { return; }
  var leftEdgeT = viewTime - viewSpan * NOW_X;
  var triggerT  = CGM_START + viewSpan;
  if (leftEdgeT >= triggerT) { console.log('[hist] blocked: not scrolled far enough. left='+new Date(leftEdgeT).toISOString().slice(0,16)+' trigger='+new Date(triggerT).toISOString().slice(0,16)); return; }
  if (_olderHistoryFetchedTo <= leftEdgeT - viewSpan) { console.log('[hist] blocked: already fetched this range. fetchedTo='+new Date(_olderHistoryFetchedTo).toISOString().slice(0,16)); return; }
  if (Date.now() - _olderHistoryLastFetch < 30000) { console.log('[hist] blocked: throttle. next in '+Math.round((30000-(Date.now()-_olderHistoryLastFetch))/1000)+'s'); return; }
  console.log('[hist] firing fetch. CGM_START='+new Date(CGM_START).toISOString().slice(0,16));
  _loadOlderHistory();
}

async function _loadOlderHistory() {
  if (_olderHistoryFetching) return;
  _olderHistoryFetching = true;
  _olderHistoryLastFetch = Date.now();

  // Show a subtle loading nudge on the canvas (not a blocking toast)
  var _histLoadEl = document.createElement('div');
  _histLoadEl.id = 'hist-load-indicator';
  _histLoadEl.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);' +
    'font-family:"DM Mono",monospace;font-size:10px;color:rgba(160,190,210,0.5);' +
    'pointer-events:none;z-index:999;letter-spacing:0.05em;transition:opacity .4s';
  _histLoadEl.textContent = 'loading history…';
  document.body.appendChild(_histLoadEl);

  try {
    // Fetch 24h before current oldest reading
    var fetchFrom = CGM_START - 24 * 3600000;
    var fetchTo   = CGM_START;

    // ── Readings from Supabase ──
    var readRows = await _sbFetch(
      'readings?t=gte.' + fetchFrom + '&t=lt.' + fetchTo + '&order=t.asc&limit=1000',
      { method: 'GET' }
    );
    if (Array.isArray(readRows) && readRows.length > 0) {
      readRows.forEach(function(row) {
        var exists = HISTORY_RAW.findIndex(function(h){ return Math.abs(h.t - row.t) < 90000; });
        if (exists < 0) HISTORY_RAW.push({ t: row.t, bg: row.bg, iob: 0, cob: 0, pen: 1 });
      });
      HISTORY_RAW.sort(function(a,b){ return a.t - b.t; });
      updateCGMBounds();
      persistReadings();
    }

    // ── Events from Supabase ──
    var evRows = await _sbFetch(
      'events?t=gte.' + fetchFrom + '&t=lt.' + fetchTo + '&order=t.asc&limit=200&note=neq.food_library',
      { method: 'GET' }
    );
    if (Array.isArray(evRows) && evRows.length > 0) {
      var addedEvs = 0;
      evRows.forEach(function(row) {
        if (typeof _deletedEventTs !== 'undefined' && _deletedEventTs.has(row.t)) return;
        if (row.note === 'food_library') return;
        var existsL = LOGGED_EVENTS.findIndex(function(e){ return e.t === row.t; });
        if (existsL < 0) {
          var rowItems = row.items;
          if (typeof rowItems === 'string') { try { rowItems = JSON.parse(rowItems); } catch(_e) { rowItems = null; } }
          var ev = { t: row.t, c: row.c||0, u: row.u||0, gi: row.gi, note: row.note, items: rowItems, local: false };
          LOGGED_EVENTS.push(ev);
          addedEvs++;
        }
      });
      if (addedEvs > 0) {
        try { localStorage.setItem('river_logged', JSON.stringify(LOGGED_EVENTS)); } catch(e) {}
      }
    }

    _olderHistoryFetchedTo = fetchFrom;

  } catch(e) {
    console.warn('[history scroll]', e.message);
  }

  _olderHistoryFetching = false;
  // Fade out the indicator
  if (_histLoadEl && _histLoadEl.parentNode) {
    _histLoadEl.style.opacity = '0';
    setTimeout(function(){ if (_histLoadEl.parentNode) _histLoadEl.remove(); }, 500);
  }
}
// ── NIGHTSCOUT BACKFILL — fetches CGM readings from NS for gap periods ──
async function _backfillFromNightscout(fromDate, toDate) {
  var cfg = loadCGMConfig();
  if (!cfg || !cfg.fields) { showToast('No CGM config found\nSet up Nightscout in settings first'); return; }
  var nsUrl = (cfg.fields.url || '').replace(/\/+$/, '');
  var token = cfg.fields.token || '';
  if (!nsUrl) { showToast('No Nightscout URL configured'); return; }

  var indEl = document.getElementById('bulk-hist-indicator');
  if (!indEl) {
    indEl = document.createElement('div');
    indEl.id = 'bulk-hist-indicator';
    indEl.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);' +
      'font-family:"DM Mono",monospace;font-size:10px;color:rgba(160,190,210,0.8);' +
      'background:rgba(3,5,20,0.8);padding:6px 12px;border-radius:8px;' +
      'pointer-events:none;z-index:999;letter-spacing:0.05em';
    document.body.appendChild(indEl);
  }

  var fromT  = fromDate instanceof Date ? fromDate : new Date(fromDate);
  var toT    = toDate   instanceof Date ? toDate   : new Date(toDate);
  var cursor = toT.getTime();
  var target = fromT.getTime();
  var totalAdded = 0;

  while (cursor > target) {
    var chunkEnd   = cursor;
    var chunkStart = Math.max(target, cursor - 24 * 3600000);
    indEl.textContent = 'NS backfill… ' + new Date(chunkStart).toLocaleDateString('en-GB',{day:'numeric',month:'short'});

    try {
      var auth = token ? '&token=' + encodeURIComponent(token) : '';
      var nsTarget = nsUrl + '/api/v1/entries/sgv.json?find[date][$gte]=' + chunkStart +
                     '&find[date][$lte]=' + chunkEnd + '&count=500' + auth;
      var proxyUrl = 'https://orange-surf-6f98.john-king-uk.workers.dev/?url=' + encodeURIComponent(nsTarget);

      var resp = await fetch(proxyUrl);
      if (!resp.ok) throw new Error('NS ' + resp.status);
      var entries = await resp.json();

      if (Array.isArray(entries) && entries.length > 0) {
        var toInsert = [];
        entries.forEach(function(e) {
          var t  = e.date || (new Date(e.dateString).getTime());
          var bg = e.sgv ? +(e.sgv / 18).toFixed(1) : null;
          if (!t || !bg) return;
          var exists = HISTORY_RAW.findIndex(function(h){ return Math.abs(h.t - t) < 90000; });
          if (exists < 0) {
            HISTORY_RAW.push({ t: t, bg: bg, iob: 0, cob: 0, pen: 1 });
            toInsert.push({ t: t, bg: bg });
            totalAdded++;
          }
        });

        if (toInsert.length > 0) {
          HISTORY_RAW.sort(function(a,b){ return a.t - b.t; });
          updateCGMBounds();
          persistReadings();
          // Write to Supabase
          try {
            await _sbFetch('readings?on_conflict=t', {
              method: 'POST',
              prefer: 'resolution=ignore-duplicates,return=minimal',
              body: toInsert,
            });
          } catch(e) { console.warn('[NS backfill supabase]', e.message); }
        }
      }
    } catch(e) {
      console.warn('[NS backfill]', e.message);
      indEl.textContent = 'error: ' + e.message;
      await new Promise(function(r){ setTimeout(r, 2000); });
    }

    cursor = chunkStart;
    await new Promise(function(r){ setTimeout(r, 300); });
  }

  indEl.textContent = '✓ NS backfill: ' + totalAdded + ' readings added';
  setTimeout(function(){ if (indEl.parentNode) indEl.remove(); }, 3000);
  showToast('NS backfill done\n' + totalAdded + ' readings added');
}

// ── BULK HISTORY FETCH — pulls all history from a start date in one go ──
async function _bulkFetchHistory(fromDate) {
  var bulkEl = document.getElementById('bulk-hist-indicator');
  if (!bulkEl) {
    bulkEl = document.createElement('div');
    bulkEl.id = 'bulk-hist-indicator';
    bulkEl.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);' +
      'font-family:"DM Mono",monospace;font-size:10px;color:rgba(160,190,210,0.8);' +
      'background:rgba(3,5,20,0.8);padding:6px 12px;border-radius:8px;' +
      'pointer-events:none;z-index:999;letter-spacing:0.05em';
    document.body.appendChild(bulkEl);
  }

  var targetStart = fromDate instanceof Date ? fromDate.getTime() : new Date(fromDate).getTime();
  var cursor = Date.now();
  var totalAdded = 0;
  var chunk = 0;

  while (cursor > targetStart) {
    var fetchTo   = cursor;
    var fetchFrom = Math.max(targetStart, cursor - 24 * 3600000); // 24h chunks
    chunk++;
    bulkEl.textContent = 'loading history… ' + new Date(fetchFrom).toLocaleDateString('en-GB',{day:'numeric',month:'short'});

    try {
      var readRows = await _sbFetch(
        'readings?t=gte.' + fetchFrom + '&t=lt.' + fetchTo + '&order=t.asc&limit=500',
        { method: 'GET' }
      );
      if (Array.isArray(readRows) && readRows.length > 0) {
        readRows.forEach(function(row) {
          var exists = HISTORY_RAW.findIndex(function(h){ return Math.abs(h.t - row.t) < 90000; });
          if (exists < 0) { HISTORY_RAW.push({ t: row.t, bg: row.bg, iob: 0, cob: 0, pen: 1 }); totalAdded++; }
        });
        HISTORY_RAW.sort(function(a,b){ return a.t - b.t; });
        updateCGMBounds();
        persistReadings();
      }
      var evRows = await _sbFetch(
        'events?t=gte.' + fetchFrom + '&t=lt.' + fetchTo + '&order=t.asc&limit=500&note=neq.food_library',
        { method: 'GET' }
      );
      if (Array.isArray(evRows) && evRows.length > 0) {
        evRows.forEach(function(row) {
          if (typeof _deletedEventTs !== 'undefined' && _deletedEventTs.has(row.t)) return;
          var existsL = LOGGED_EVENTS.findIndex(function(e){ return e.t === row.t; });
          if (existsL < 0) {
            var rowItems = row.items;
            if (typeof rowItems === 'string') { try { rowItems = JSON.parse(rowItems); } catch(_e) { rowItems = null; } }
            LOGGED_EVENTS.push({ t: row.t, c: row.c||0, u: row.u||0, gi: row.gi, note: row.note, items: rowItems, local: false });
          }
        });
        try { localStorage.setItem('river_logged', JSON.stringify(LOGGED_EVENTS)); } catch(e) {}
      }
    } catch(e) {
      console.warn('[bulkFetch]', e.message);
    }

    cursor = fetchFrom;
    await new Promise(function(r){ setTimeout(r, 200); }); // 200ms between chunks
  }

  _olderHistoryFetchedTo = targetStart;
  bulkEl.textContent = '✓ loaded ' + totalAdded + ' readings';
  setTimeout(function(){ if (bulkEl.parentNode) bulkEl.remove(); }, 3000);
  showToast('history loaded\n' + totalAdded + ' readings added');
}

// ── CANVAS LONG-PRESS DETECTION ──────────────────────────────────────────
// Any tap/click on a chip → openContextCard (unified card with inline edit)
// Long press on background → showDayStrip
var _canvasTapStart = 0;
var _canvasTapTimer = null;
var _canvasTapMx = 0;
var _canvasTapMy = 0;
var _canvasTapMoved = false;

CV.addEventListener('touchstart', function(e) {
  if (e.touches.length !== 1) return;
  _canvasTapStart = Date.now();
  _canvasTapMoved = false;
  var rect = CV.getBoundingClientRect();
  _canvasTapMx = e.touches[0].clientX - rect.left;
  _canvasTapMy = e.touches[0].clientY - rect.top;
  // Long-press: fire edit after 450ms if not moved
  if (_canvasTapTimer) clearTimeout(_canvasTapTimer);
  _canvasTapTimer = setTimeout(function() {
    if (_canvasTapMoved) return;
    _handleCanvasHit(_canvasTapMx, _canvasTapMy, true);
  }, 450);
}, {passive: true});

CV.addEventListener('touchmove', function(e) {
  if (e.touches.length !== 1) return;
  var rect = CV.getBoundingClientRect();
  var dx = (e.touches[0].clientX - rect.left) - _canvasTapMx;
  var dy = (e.touches[0].clientY - rect.top) - _canvasTapMy;
  if (Math.sqrt(dx*dx + dy*dy) > 8) {
    _canvasTapMoved = true;
    if (_canvasTapTimer) { clearTimeout(_canvasTapTimer); _canvasTapTimer = null; }
  }
}, {passive: true});

CV.addEventListener('touchend', function(e) {
  if (_canvasTapTimer) { clearTimeout(_canvasTapTimer); _canvasTapTimer = null; }
  if (_canvasTapMoved) return;
  var held = Date.now() - _canvasTapStart;
  _lastTouchEndTime = Date.now(); // suppress synthetic click
  if (held < 450) {
    _handleCanvasHit(_canvasTapMx, _canvasTapMy, false);
  }
}, {passive: true});

var _lastTouchEndTime = 0;

CV.addEventListener('click', function(e) {
  // Suppress synthetic click fired after touchend (~300ms later on mobile)
  if (Date.now() - _lastTouchEndTime < 500) return;
  // Mouse clicks → context card
  var rect = CV.getBoundingClientRect();
  var mx = e.clientX - rect.left;
  var my = e.clientY - rect.top;
  // Only fire if mouse wasn't dragged
  if (md.dragging) return;
  _handleCanvasHit(mx, my, false);
});

function _handleCanvasHit(mx, my, isLongPress) {
  // Ghost pebbles → always ghost sheet
  if (window._ghostPebbleCards && _ghostPebbleCards.length > 0) {
    for (var _gi2 = 0; _gi2 < _ghostPebbleCards.length; _gi2++) {
      var _gc = _ghostPebbleCards[_gi2];
      if (Math.abs(mx - _gc.x) < 14 && Math.abs(my - _gc.y) < 14) {
        openGhostSheet(_gc.ghost);
        return;
      }
    }
  }
  // Prick diamonds
  if (window._prickCards && _prickCards.length > 0) {
    for (var pi = 0; pi < _prickCards.length; pi++) {
      var pc = _prickCards[pi];
      if (Math.abs(mx - pc.x) < 14 && Math.abs(my - pc.y) < 14) {
        openPrickEditor(pc.prick);
        return;
      }
    }
  }
  // Event chips — any tap/click opens unified context card (with inline edit)
  if (window._eventCards && _eventCards.length > 0) {
    for (var ci = 0; ci < _eventCards.length; ci++) {
      var c = _eventCards[ci];
      if (mx >= c.x - c.w/2 && mx <= c.x + c.w/2 && my >= c.y - 12 && my <= c.y + 12) {
        openContextCard(c.idx, c.data);
        return;
      }
    }
  }
  // Nothing hit — long-press on background shows day strip
  if (isLongPress) {
    showDayStrip();
  }
}
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
      font-family:DM Mono,monospace;font-size:10px;color:rgba(40,55,50,0.55);
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
    const _ic  = getIC(_now.getTime());
    const _isf = getISF(_now.getTime());
    const _target = getTarget(_now.getTime());
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

// ONE-TIME MIGRATION: nuke legacy food library cache so Supabase wins clean.
// Remove this block once all devices have reloaded once.
if (localStorage.getItem('river_food_lib_nuked') !== '2') {
  localStorage.removeItem('river_food_lib');
  localStorage.setItem('river_food_lib_nuked', '2');
}

var FOOD_LIBRARY = (function() {
  try { return JSON.parse(localStorage.getItem('river_food_lib') || '[]'); } catch(e) { return []; }
})();

function saveFoodLibrary() {
  try { localStorage.setItem('river_food_lib', JSON.stringify(FOOD_LIBRARY)); } catch(e) {}
  // Push to Supabase so library is shared across devices
  syncFoodLibraryToSupabase();
}

// ── FOOD LIBRARY SUPABASE SYNC ─────────────────────────────────────────
// Uses the `library` table (key/value store): key='food_library', value=jsonb array.
// Upsert on key so it's always a single row, no sentinel tricks.

async function syncFoodLibraryToSupabase() {
  if (!SUPABASE_READY) return;
  try {
    await _sbFetch('library?on_conflict=key', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: [{
        key:        'food_library',
        value:      FOOD_LIBRARY,
        updated_at: new Date().toISOString(),
      }],
    });
    console.log('[syncFoodLib] pushed ' + FOOD_LIBRARY.length + ' items to Supabase library');
  } catch(e) { console.warn('[syncFoodLib push]', e.message); }
}

async function syncFoodLibraryFromSupabase() {
  if (!SUPABASE_READY) return;
  try {
    var rows = await _sbFetch('library?key=eq.food_library', {});
    if (!rows || rows.length === 0) {
      // Remote is empty — seed it from local if we have items
      if (FOOD_LIBRARY.length > 0) {
        console.log('[syncFoodLib] remote empty, seeding from local (' + FOOD_LIBRARY.length + ' items)');
        await syncFoodLibraryToSupabase();
      }
      return;
    }
    var remoteLib = rows[0].value;
    if (typeof remoteLib === 'string') { try { remoteLib = JSON.parse(remoteLib); } catch(e) { return; } }
    if (!Array.isArray(remoteLib)) return;

    // Remote wins — replace local entirely with remote state.
    // This is correct: every write (add/delete/edit) pushes the full library to Supabase,
    // so remote is always the authoritative source. Additive merge was causing deleted items
    // to be resurrected on next pull.
    // Remote always wins — Supabase is the single source of truth.
    // Never push local up during a pull; saves go through syncFoodLibraryToSupabase explicitly.
    FOOD_LIBRARY.length = 0;
    remoteLib.forEach(function(f){ FOOD_LIBRARY.push(f); });
    try { localStorage.setItem('river_food_lib', JSON.stringify(FOOD_LIBRARY)); } catch(e) {}
    console.log('[syncFoodLib] replaced local with remote (' + FOOD_LIBRARY.length + ' items)');
  } catch(e) { console.warn('[syncFoodLib pull]', e.message); }
}

// ── MEAL HISTORY ──────────────────────────────────────────────────────
var MEAL_HISTORY = (function() {
  try { return JSON.parse(localStorage.getItem('river_meal_hist') || '[]'); } catch(e) { return []; }
})();

function saveMealHistory() {
  // No longer capped at 30 — store everything locally, Supabase is the longitudinal record
  try { localStorage.setItem('river_meal_hist', JSON.stringify(MEAL_HISTORY)); } catch(e) {}
}

// ═══════════════════════════════════════════════════════════════════════
//  OUTCOME TRACKING — predicted vs actual, insulin curves, ghost meals
//
//  Three subsystems:
//  1+2. Meal & bolus outcomes — unified idempotent backfill (see below)
//  3. Unannounced meal detection — watch for ghost COB signatures
//
//  All store to Supabase. Daily rollup into model_accuracy table.
//  "It takes N weeks to see results" comes from model_accuracy.
// ═══════════════════════════════════════════════════════════════════════

// ── 1+2. MEAL & BOLUS OUTCOME TRACKING — unified backfill ───────────────
// Replaces the old +2h/+4h setTimeout-based collection
// (_collectMealOutcome/_collectBolusOutcome via scheduleMealOutcome/
// scheduleBolusOutcome), which only produced a result if the app stayed
// open continuously for the whole window — observed survival rates ~70%
// (meal curve), ~5% (meal scoring), 0% (bolus curve).
//
// Instead:
//   - meal_history rows are written with is_partial:true at log time
//     (syncMealToSupabase), already carrying predicted_curve.
//   - bolus_outcomes rows are written with is_partial:true at bolus time
//     (_createBolusOutcomeBaseline).
//   - runOutcomeBackfill() — called from syncNow, i.e. on load and every
//     5min — scans both tables for rows where actual_curve IS NULL OR
//     is_partial = true, and:
//       - t + window < now   → compute the COMPLETE record, is_partial=false
//       - 0 < now-t < window → compute a PARTIAL record from whatever
//         readings exist so far, is_partial stays true
//     partial → complete is a one-way transition (matches the immutability
//     principle already used for predicted_curve itself). This also turns
//     "where is he now vs predicted" into a queryable historical fact for
//     in-progress meals/boluses, not just a live-view-only one.

var MEAL_OUTCOME_WINDOW_MINS  = 120; // +2h
var BOLUS_OUTCOME_WINDOW_MINS = 240; // +4h
var _outcomeBackfillRunning   = false;

// Shared curve/residual computation for a meal. maxMins caps how far into
// the window to look — MEAL_OUTCOME_WINDOW_MINS for a complete record, or
// however much time has actually elapsed (rounded down to a 5min step) for
// a partial one.
function _computeMealActualCurve(mealT, maxMins, predictedCurve, preBGFallback) {
  var step = 5;
  var actualCurve = [];
  var residuals   = [];

  for (var mins = step; mins <= maxMins; mins += step) {
    var t = mealT + mins * 60000;
    var d = dataAt(t);
    if (!d || d.bg <= 0) continue;
    actualCurve.push({ mins: mins, bg: +d.bg.toFixed(2) });
    if (predictedCurve) {
      var pred = predictedCurve.find(function(p){ return p.mins === mins; });
      if (pred) residuals.push({ mins: mins, residual: +(d.bg - pred.bg).toFixed(2) });
    }
  }
  if (actualCurve.length === 0) return null;

  var preBG = actualCurve[0] ? actualCurve[0].bg : preBGFallback;
  var peak  = actualCurve.reduce(function(best, p){ return p.bg > best.bg ? p : best; }, actualCurve[0]);

  // Return-to-baseline (within 0.8 of pre-meal BG)
  var returnMins = null;
  for (var i = 0; i < actualCurve.length; i++) {
    if (actualCurve[i].mins > peak.mins && Math.abs(actualCurve[i].bg - (preBG || peak.bg)) < 0.8) {
      returnMins = actualCurve[i].mins;
      break;
    }
  }

  var errors = residuals.map(function(r){ return Math.abs(r.residual); });
  var rmse = errors.length > 0
    ? +Math.sqrt(errors.reduce(function(s,e){return s+e*e;},0) / errors.length).toFixed(3)
    : null;
  var mae = errors.length > 0
    ? +(errors.reduce(function(s,e){return s+e;},0) / errors.length).toFixed(3)
    : null;

  var predPeak = predictedCurve
    ? predictedCurve.reduce(function(best, p){ return p.bg > best.bg ? p : best; }, predictedCurve[0] || {bg:0, mins:0})
    : null;
  var peakError   = predPeak ? +(predPeak.bg - peak.bg).toFixed(2) : null;
  var timingError = predPeak ? (predPeak.mins - peak.mins) : null;

  var result = {
    actual_curve:      actualCurve,
    peak_bg:           +peak.bg.toFixed(2),
    peak_t:            mealT + peak.mins * 60000,
    return_t:          returnMins ? mealT + returnMins * 60000 : null,
    rmse:              rmse,
    mae:               mae,
    peak_error:        peakError,
    timing_error_mins: timingError,
  };

  // mean_residual / max_residual / residual_direction — the working
  // negative-space dataset (computed for the original 238 rows via SQL on
  // 11 Jun; computed here going forward for any row with a predicted_curve).
  if (residuals.length > 0) {
    var meanResidual = +(residuals.reduce(function(s,r){return s+r.residual;},0) / residuals.length).toFixed(2);
    var maxResidual  = residuals.reduce(function(m,r){ return Math.abs(r.residual) > Math.abs(m) ? r.residual : m; }, 0);
    result.mean_residual = meanResidual;
    result.max_residual  = +maxResidual.toFixed(2);
    result.residual_direction = meanResidual > 0.3  ? 'higher_than_predicted'
                               : meanResidual < -0.3 ? 'lower_than_predicted'
                               : 'as_predicted';
  }

  return result;
}

// Shared curve computation for a bolus — same partial/complete split as
// _computeMealActualCurve, applied to the +4h IOB tail.
function _computeBolusActualCurve(bolusT, maxMins, predictedCurve, preBG, units) {
  var actualCurve = [];
  var errors      = [];

  for (var mins = 5; mins <= maxMins; mins += 5) {
    var t = bolusT + mins * 60000;
    var d = dataAt(t);
    if (!d || d.bg <= 0) continue;
    actualCurve.push({ mins: mins, bg: +d.bg.toFixed(2) });
    if (predictedCurve) {
      var pred = predictedCurve.find(function(p){ return p.mins === mins; });
      if (pred) errors.push(Math.abs(pred.bg - d.bg));
    }
  }
  if (actualCurve.length < 2) return null; // not enough data even for a partial

  // Nadir (lowest point so far)
  var nadir     = actualCurve.reduce(function(lo, p){ return p.bg < lo.bg ? p : lo; }, actualCurve[0]);
  var nadirBG   = nadir.bg;
  var nadirMins = nadir.mins;

  // Observed ISF: bg drop per unit, normalised to insulin-only effect
  var bgDrop      = (preBG || 0) - nadirBG;
  var observedISF = units > 0 ? +(bgDrop / units).toFixed(2) : null;
  var expectedISF = _currentTherapySnapshot(bolusT);
  var isfError    = (observedISF && expectedISF) ? +(expectedISF.isf - observedISF).toFixed(2) : null;

  // Return-to-pre (within 1.0 of pre-bolus BG)
  var returnMins = null;
  for (var j = 0; j < actualCurve.length; j++) {
    if (actualCurve[j].mins > nadirMins && Math.abs(actualCurve[j].bg - (preBG || 0)) < 1.0) {
      returnMins = actualCurve[j].mins;
      break;
    }
  }

  var rmse = errors.length > 0
    ? +Math.sqrt(errors.reduce(function(s,e){return s+e*e;},0)/errors.length).toFixed(3)
    : null;

  var result = {
    actual_curve: actualCurve,
    nadir_bg:     +nadirBG.toFixed(2),
    nadir_t:      bolusT + nadirMins * 60000,
    nadir_mins:   nadirMins,
    return_mins:  returnMins,
    rmse:         rmse,
  };
  // Observed ISF is only meaningful once a real nadir has formed — leave
  // null on very early partials rather than writing a noisy estimate.
  if (observedISF !== null) {
    result.observed_isf = observedISF;
    result.isf_error    = isfError;
  }
  return result;
}

// Write the bolus_outcomes baseline row immediately at bolus time — replaces
// scheduleBolusOutcome's +4h-deferred POST (0/238 survival rate). The row
// carries predicted_curve/formula_version/is_partial:true; actual_curve etc.
// are filled in later by runOutcomeBackfill.
async function _createBolusOutcomeBaseline(ev, predictedCurve) {
  if (!SUPABASE_READY || !ev || !ev.u) return;
  try {
    var bolusT = ev.t;
    var preBG  = _preBG(bolusT) || 0;
    var d0     = dataAt(bolusT);
    var hour   = new Date(bolusT).getHours();
    var period = hour >= 6 && hour < 10 ? 'Breakfast'
               : hour >= 10 && hour < 14 ? 'Lunch'
               : hour >= 14 && hour < 18 ? 'Afternoon'
               : hour >= 18 && hour < 22 ? 'Evening' : 'Overnight';

    var row = {
      t:                bolusT,
      units:            ev.u,
      pre_bg:           +preBG.toFixed(2),
      iob_at_bolus:     d0 ? +d0.iob.toFixed(2) : null,
      cob_at_bolus:     d0 ? +d0.cob.toFixed(2) : null,
      therapy_snapshot: _currentTherapySnapshot(bolusT),
      predicted_curve:  predictedCurve || null,
      formula_version:  predictedCurve ? _PRED_FORMULA_VERSION : null,
      is_partial:       true,
      period:           period,
      logged_by:        ev.logged_by || null,
      device_id:        _deviceId,
    };

    await _sbFetch('bolus_outcomes?on_conflict=t', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body:   [row],
    });
  } catch(e) {
    console.warn('[bolusOutcomeBaseline]', e.message);
  }
}

// Wraps _createBolusOutcomeBaseline with a read-after-write verify and one
// retry. On second failure, flags events.needs_outcome_baseline=true so the
// row gets a sweep pass later instead of silently never existing (was
// dropping ~1 in 10 bolus_outcomes rows — fire-and-forget swallowed errors).
async function _createBolusOutcomeBaselineWithRetry(ev, predictedCurve, attempt) {
  attempt = attempt || 1;
  console.log('[bolusOutcomeBaseline] wrapper called, attempt', attempt, ev);
  try {
    await _createBolusOutcomeBaseline(ev, predictedCurve);
    var check = await _sbFetch('bolus_outcomes?t=eq.' + ev.t + '&select=t', {});
    if (Array.isArray(check) && check.length > 0) return true;
    throw new Error('baseline row not found after write');
  } catch (e) {
    if (attempt < 2) {
      await new Promise(function(r){ setTimeout(r, 1500); });
      return _createBolusOutcomeBaselineWithRetry(ev, predictedCurve, attempt + 1);
    }
    console.warn('[bolusOutcomeBaseline] failed after retry, flagging for sweep:', e.message);
    try {
      await _sbFetch('events?t=eq.' + ev.t, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { needs_outcome_baseline: true },
      });
    } catch (e2) { /* best-effort flag */ }
    return false;
  }
}

// Sweep for events flagged needs_outcome_baseline=true (set when the live
// retry-and-verify in _createBolusOutcomeBaselineWithRetry exhausted its
// retry). Deliberately unbounded by time — unlike _backfillBolusOutcomes'
// 24h window — since a flagged row can sit unactioned indefinitely if this
// sweep itself doesn't run for a while.
async function _sweepNeedsOutcomeBaseline() {
  var rows;
  try {
    rows = await _sbFetch('events?needs_outcome_baseline=eq.true&select=t,u,c,note,insulin_type,logged_by', {});
  } catch(e) { console.warn('[outcomeBaselineSweep] fetch failed:', e.message); return; }
  if (!Array.isArray(rows) || !rows.length) return;

  for (var i = 0; i < rows.length; i++) {
    var ev = rows[i];
    if (!ev.u) continue; // only bolus/correction events carry units
    try {
      await _createBolusOutcomeBaseline(
        {t: ev.t, u: ev.u, insulin_type: ev.insulin_type, logged_by: ev.logged_by},
        null // predicted_curve not reconstructable after the fact; baseline still written
      );
      var check = await _sbFetch('bolus_outcomes?t=eq.' + ev.t + '&select=t', {});
      if (Array.isArray(check) && check.length > 0) {
        await _sbFetch('events?t=eq.' + ev.t, {
          method: 'PATCH', prefer: 'return=minimal',
          body: { needs_outcome_baseline: false },
        });
      }
    } catch(e) { console.warn('[outcomeBaselineSweep] retry failed for t=' + ev.t, e.message); }
  }
}

// Unified idempotent backfill — called from syncNow (on load + every 5min).
// Covers both meal_history and bolus_outcomes, tiered partial/complete.
async function runOutcomeBackfill() {
  if (!SUPABASE_READY || _outcomeBackfillRunning) return;
  _outcomeBackfillRunning = true;
  try {
    await _backfillMealOutcomes();
    await _backfillBolusOutcomes();
    await _sweepNeedsOutcomeBaseline();
    _maybeRollupModelAccuracy();
  } catch(e) {
    console.warn('[outcomeBackfill]', e.message);
  } finally {
    _outcomeBackfillRunning = false;
  }
}

async function _backfillMealOutcomes() {
  var now   = Date.now();
  var since = now - 24 * 3600000; // bound the query — older rows have long since completed
  var rows;
  try {
    rows = await _sbFetch(
      'meal_history?t=gte.' + since + '&t=lt.' + now +
      '&or=(actual_curve.is.null,is_partial.eq.true)' +
      '&select=t,predicted_curve,pre_bg', {});
  } catch(e) { console.warn('[mealBackfill] fetch failed:', e.message); return; }
  if (!Array.isArray(rows)) return;

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var elapsedMins = (now - row.t) / 60000;
    if (elapsedMins < 5) continue; // not even one data point yet

    var isComplete = elapsedMins >= MEAL_OUTCOME_WINDOW_MINS;
    var maxMins     = isComplete ? MEAL_OUTCOME_WINDOW_MINS : Math.floor(elapsedMins / 5) * 5;
    if (maxMins < 5) continue;

    var predCurve = row.predicted_curve;
    if (typeof predCurve === 'string') { try { predCurve = JSON.parse(predCurve); } catch(e) { predCurve = null; } }

    var result = _computeMealActualCurve(row.t, maxMins, predCurve, row.pre_bg);
    if (!result || result.actual_curve.length === 0) continue;
    result.is_partial = !isComplete;

    try {
      await _sbFetch('meal_history?t=eq.' + row.t, { method: 'PATCH', prefer: 'return=minimal', body: result });
    } catch(e) { console.warn('[mealBackfill] patch failed:', e.message); }
  }
}

async function _backfillBolusOutcomes() {
  var now   = Date.now();
  var since = now - 24 * 3600000;
  var rows;
  try {
    rows = await _sbFetch(
      'bolus_outcomes?t=gte.' + since + '&t=lt.' + now +
      '&or=(actual_curve.is.null,is_partial.eq.true)' +
      '&select=t,units,pre_bg,predicted_curve', {});
  } catch(e) { console.warn('[bolusBackfill] fetch failed:', e.message); return; }
  if (!Array.isArray(rows)) return;

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var elapsedMins = (now - row.t) / 60000;
    if (elapsedMins < 5) continue;

    var isComplete = elapsedMins >= BOLUS_OUTCOME_WINDOW_MINS;
    var maxMins     = isComplete ? BOLUS_OUTCOME_WINDOW_MINS : Math.floor(elapsedMins / 5) * 5;
    if (maxMins < 5) continue;

    var predCurve = row.predicted_curve;
    if (typeof predCurve === 'string') { try { predCurve = JSON.parse(predCurve); } catch(e) { predCurve = null; } }

    var result = _computeBolusActualCurve(row.t, maxMins, predCurve, row.pre_bg, row.units);
    if (!result) continue;
    result.is_partial = !isComplete;

    try {
      await _sbFetch('bolus_outcomes?t=eq.' + row.t, { method: 'PATCH', prefer: 'return=minimal', body: result });
    } catch(e) { console.warn('[bolusBackfill] patch failed:', e.message); }
  }
}

// ── BACKFILL REVIEW: confidence-scored suggestion + immediate complete outcome ──
// Distinct from the live logging flow and from runOutcomeBackfill's 24h-bounded
// sweep. For a historical row (CGM/insulin seed data already present, items
// not yet confirmed), this:
//   1. Pulls the raw BG trace already sitting in `readings` for the window
//      after `t` (it already happened — no waiting needed).
//   2. Scores it against previously-CONFIRMED meal_history rows using the same
//      shape/timing/time-of-day matching _matchGhostToMealHistory uses for
//      ghosts, so candidates mature as you work through the queue in order —
//      each confirmed row becomes a comparison point for the next.
//   3. On confirm, reconstructs IC/ISF/target as they were live at `t` via
//      getTherapyAt (NOT today's settings, NOT the live-adaptive blend —
//      getISF/getIC already skip the observed-ISF layer when historicalRatios
//      is passed, which is correct: a March prediction must not be computed
//      using insulin sensitivity learned in May).
//   4. Writes meal_history + bolus_outcomes rows already COMPLETE
//      (actual_curve/observed_isf/rmse filled in the same call), bypassing
//      the 24h sweep entirely — the outcome window already elapsed in real
//      time, the readings exist, there is nothing to wait for.
//
// KNOWN LIMITATION: dataAt(t).iob/.cob only reflect SESSION/BOLUS_EVENTS from
// the last 6h (_cgmFloor), so historical IOB-at-meal-time cannot be read back
// out of dataAt() for old rows. predicted_curve generation here is therefore
// withheld rather than guessed (see mealRow.predicted_curve below) — a wrong
// single-bolus curve written as if it were the live model's real prediction
// would be worse than no curve. observed_isf/actual_curve are NOT affected —
// they only need preBG/nadirBG from the CGM trace itself, which dataAt(t).bg
// resolves correctly for any historical t via readings.

async function suggestBackfillCandidates(t, estCarbs, windowMins) {
  windowMins = windowMins || 120;
  var curve = [];
  for (var mins = 0; mins <= windowMins; mins += 5) {
    var d = dataAt(t + mins * 60000);
    if (d && d.bg > 0) curve.push({ mins: mins, bg: +d.bg.toFixed(2) });
  }
  if (curve.length < 4) return { curve: curve, candidates: [] };

  var preBG = curve[0].bg;
  var peakPt = curve.reduce(function(best,p){ return p.bg > best.bg ? p : best; }, curve[0]);

  var candidates = await _matchGhostToMealHistory(curve, peakPt.mins, estCarbs || 0, t, 0);
  return { curve: curve, preBG: preBG, peak: peakPt, candidates: candidates };
}

// Confirm a backfill row: items + bolus units as transcribed from the
// notepad/source data, t = the ORIGINAL historical timestamp (so it sits
// correctly on the canvas), everything else computed as-of t.
async function confirmBackfillEntry(t, items, bolusUnits, opts) {
  opts = opts || {};
  if (!SUPABASE_READY) return { ok:false, error:'supabase not ready' };

  var totalCarbs = (items||[]).reduce(function(s,i){ return s + (i.carbs||0); }, 0);
  var avgGI = items && items.length
    ? items.reduce(function(s,i){ return s + (i.gi||55)*(i.carbs||0); }, 0) / Math.max(totalCarbs,1)
    : 55;

  // Historical therapy context — NOT live/adaptive (getTherapyAt → historicalRatios
  // path in getISF/getIC deliberately skips the observed-ISF blend layer).
  var therapyRow = await getTherapyAt(t);
  var ratios = therapyRow ? therapyRow.ratios : null;
  var ic  = getIC(t, ratios);
  var isf = getISF(t, ratios);
  var tgt = getTarget(t, ratios);

  var preBG = _preBG(t) || (dataAt(t).bg || null);

  var carbDose = totalCarbs > 0 ? totalCarbs / ic : 0;
  var rawCorr  = (preBG && preBG > tgt) ? Math.max(0, (preBG - tgt) / isf) : 0;
  var suggestedUnits = +((carbDose + rawCorr).toFixed(2));
  var u = (typeof bolusUnits === 'number') ? bolusUnits : suggestedUnits;

  var hour = new Date(t).getHours();
  var period = hour >= 6 && hour < 10 ? 'Breakfast'
             : hour >= 10 && hour < 14 ? 'Lunch'
             : hour >= 14 && hour < 18 ? 'Afternoon'
             : hour >= 18 && hour < 22 ? 'Evening' : 'Overnight';

  var therapySnap = {
    period: period, isf: isf, ic: ic, target: tgt,
    basal: therapyRow && therapyRow.basal_dose,
    basalType: therapyRow && therapyRow.basal_type,
    insulinType: therapyRow && therapyRow.bolus_type,
  };

  // Outcome window already elapsed in real time — compute complete, not partial.
  var mealResult  = _computeMealActualCurve(t, 120, null, preBG) || {};
  var bolusResult = u > 0 ? _computeBolusActualCurve(t, 240, null, preBG, u) : null;

  var mealRow = {
    t: t,
    name: period + ' · ' + new Date(t).toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'}) +
          (items && items[0] ? ' (' + items[0].name + (items.length>1?' +'+(items.length-1):'') + ')' : ''),
    total_carbs: +totalCarbs.toFixed(1),
    items: items || [],
    bolus_u: u || null,
    bolus_t: t,
    wait_mins: opts.waitMins != null ? opts.waitMins : null, // null = genuinely unknown, NOT assumed
    pre_bg: preBG,
    therapy_snapshot: therapySnap,
    predicted_curve: null, // intentionally withheld — see KNOWN LIMITATION above
    is_partial: false,
    source: 'backfill_reviewed',
    logged_by: opts.loggedBy || null,
  };
  Object.assign(mealRow, mealResult);

  try {
    await _sbFetch('meal_history?on_conflict=t', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: [mealRow],
    });
  } catch(e) {
    console.warn('[confirmBackfillEntry] meal_history write failed:', e.message);
    return { ok:false, error:e.message };
  }

  if (u > 0) {
    var bolusRow = {
      t: t,
      units: u,
      pre_bg: preBG,
      iob_at_bolus: null, // see KNOWN LIMITATION — cannot reconstruct historical stacked IOB
      therapy_snapshot: therapySnap,
      predicted_curve: null,
      formula_version: null,
      is_partial: false,
      period: period,
      device_id: _deviceId,
    };
    if (bolusResult) Object.assign(bolusRow, bolusResult);

    try {
      await _sbFetch('bolus_outcomes?on_conflict=t', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=minimal',
        body: [bolusRow],
      });
    } catch(e) {
      console.warn('[confirmBackfillEntry] bolus_outcomes write failed:', e.message);
    }
  }

  // Mirror into events so the canvas chip renders, matching the live logging shape.
  try {
    var rows = [{ t: t, c: totalCarbs, u: 0, gi: +avgGI.toFixed(1), note: 'carbs', items: items || [], pre_bg: preBG }];
    if (u > 0) rows.push({ t: t, c: 0, u: u, note: 'bolus', suggested_units: suggestedUnits });
    await _sbFetch('events?on_conflict=t', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: rows,
    });
  } catch(e) {
    console.warn('[confirmBackfillEntry] events write failed:', e.message);
  }

  return { ok:true, meal_t:t, total_carbs:totalCarbs, suggested_units:suggestedUnits, delivered_units:u, observed_isf: bolusResult && bolusResult.observed_isf };
}

// ── 3. UNANNOUNCED MEAL DETECTION ─────────────────────────────────────
// Runs every 15min. Looks for a sustained positive residual (BG rising
// faster than IOB/COB model predicts) with a bell-curve shape matching
// carb absorption. No meal logged in that window = candidate ghost meal.

var _lastUnannouncedCheck = 0;
var _detectedUnannouncedTs = new Set(); // avoid re-detecting same event

function _maybeDetectUnannouncedMeal() {
  var now = Date.now();
  if (now - _lastUnannouncedCheck < 15 * 60000) return; // throttle to 15min
  _lastUnannouncedCheck = now;

  try {
    // Look back 2h at residuals. Need 30+ min of sustained positive residual.
    var WINDOW_MS  = 2 * 3600000;
    var STEP_MS    = 5 * 60000;
    var MIN_RISE   = 1.5;   // mmol — minimum rise to flag
    var MIN_DURATION = 6;   // steps (~30 min)

    var positiveRun = [];
    var preBG = null;

    for (var i = 0; i <= WINDOW_MS / STEP_MS; i++) {
      var t      = now - WINDOW_MS + i * STEP_MS;
      var actual = dataAt(t);
      if (!actual || actual.bg <= 0) continue;

      var tPrev   = t - STEP_MS;
      var dPrev   = dataAt(tPrev);
      if (!dPrev || dPrev.bg <= 0) continue;

      var ISF      = _currentTherapySnapshot(t);
      var isf      = ISF ? ISF.isf : 6.5;
      var cobDelta = dPrev.cob > 0 ? dPrev.cob * (1 - cobF(5)) * 0.055 : 0;
      var iobDelta = dPrev.iob > 0 ? -dPrev.iob * (1 - iobF(5)) * isf  : 0;
      var predicted = dPrev.bg + cobDelta + iobDelta;
      var residual  = actual.bg - predicted;

      if (residual > 0.25) {
        if (positiveRun.length === 0) preBG = dPrev.bg;
        positiveRun.push({ t: t, residual: residual, actual: actual.bg });
      } else {
        if (positiveRun.length >= MIN_DURATION) {
          _evaluateUnannouncedMeal(positiveRun, preBG);
        }
        positiveRun = [];
        preBG = null;
      }
    }
    // Check open run at end of window
    if (positiveRun.length >= MIN_DURATION) {
      _evaluateUnannouncedMeal(positiveRun, preBG);
    }
  } catch(e) {}
}

// ── Normalise a curve array to 0→1 range (removes amplitude, preserves shape) ──
function _normaliseCurve(pts) {
  var vals = pts.map(function(p){ return p.residual !== undefined ? p.residual : (p.bg || 0); });
  var mn = Math.min.apply(null, vals);
  var mx = Math.max.apply(null, vals);
  var range = mx - mn;
  if (range < 0.01) return vals.map(function(){ return 0.5; });
  return vals.map(function(v){ return (v - mn) / range; });
}

// ── Pearson correlation coefficient between two equal-length arrays ──
function _pearsonR(a, b) {
  var n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  var ma = a.slice(0,n).reduce(function(s,v){return s+v;},0)/n;
  var mb = b.slice(0,n).reduce(function(s,v){return s+v;},0)/n;
  var num=0, da=0, db=0;
  for (var i=0;i<n;i++){
    var aa=a[i]-ma, bb=b[i]-mb;
    num+=aa*bb; da+=aa*aa; db+=bb*bb;
  }
  var denom = Math.sqrt(da*db);
  return denom < 1e-9 ? 0 : Math.max(-1, Math.min(1, num/denom));
}

// ── Resample array to fixed N points via linear interpolation ──
function _resample(arr, n) {
  if (arr.length === 0) return [];
  if (arr.length === 1) return Array(n).fill(arr[0]);
  var out = [];
  for (var i=0;i<n;i++){
    var pos = i*(arr.length-1)/(n-1);
    var lo  = Math.floor(pos);
    var hi  = Math.min(lo+1, arr.length-1);
    out.push(arr[lo] + (arr[hi]-arr[lo])*(pos-lo));
  }
  return out;
}

// ── Time-of-day label ──
function _mealPeriod(t) {
  var h = new Date(t).getHours();
  if (h < 10) return 'breakfast';
  if (h < 14) return 'lunch';
  if (h < 18) return 'afternoon';
  return 'evening';
}

// ── Match ghost residual curve against meal_history composite curves ──
// Returns top 3 candidates sorted by composite confidence.
async function _matchGhostToMealHistory(residualRun, peakMins, estCarbs, startT, iob) {
  // Fetch meal_history rows that have actual_curve populated, excluding used_suggested
  var rows;
  try {
    rows = await _sbFetch(
      'meal_history?actual_curve=not.is.null&rmse=not.is.null&source=neq.used_suggested&order=t.desc&limit=300',
      { method: 'GET' }
    );
  } catch(e) { rows = []; }
  if (!Array.isArray(rows) || rows.length === 0) return [];

  // Normalise ghost residual
  var ghostNorm = _normaliseCurve(residualRun);
  ghostNorm = _resample(ghostNorm, 24); // resample to 24 points (≈5min intervals over 2h)

  var ghostPeriod = _mealPeriod(startT);
  var ghostIob    = iob || 0;

  // Score each meal_history row
  var scored = [];
  rows.forEach(function(row) {
    var curve = row.actual_curve;
    if (!Array.isArray(curve) || curve.length < 4) return;
    if (!row.name) return;

    // Normalise actual_curve (bg values over time since meal)
    var histNorm = _normaliseCurve(curve);
    histNorm = _resample(histNorm, 24);

    // 1. Curve shape — Pearson R → 0..1
    var shapeR    = _pearsonR(ghostNorm, histNorm);
    var shapeScore = (shapeR + 1) / 2; // map -1..1 → 0..1

    // 2. Peak timing match
    var histPeakIdx = 0;
    curve.forEach(function(p, idx){ if((p.bg||0) > (curve[histPeakIdx].bg||0)) histPeakIdx=idx; });
    var histPeakMins = curve[histPeakIdx] ? (curve[histPeakIdx].mins || histPeakIdx * 5) : 60;
    var timingDelta  = Math.abs(histPeakMins - peakMins);
    var timingScore  = Math.max(0, 1 - timingDelta / 60);

    // 3. Carb estimate match
    var histCarbs   = row.total_carbs || 0;
    var carbScore   = 0;
    var carbVariance = 0;
    if (histCarbs > 0 && estCarbs > 0) {
      carbVariance = Math.abs(histCarbs - estCarbs) / Math.max(histCarbs, estCarbs);
      carbScore    = Math.max(0, 1 - carbVariance * 1.5);
    } else { carbScore = 0.5; }
    var gramWarning = carbVariance > 0.3;

    // 4. Time-of-day match
    var histPeriod   = _mealPeriod(row.t);
    var timeScore    = histPeriod === ghostPeriod ? 1.0 : 0.3;

    // 5. IOB context match
    var histIob      = (row.therapy_snapshot && row.therapy_snapshot.iob_at_meal) || 0;
    var iobDelta     = Math.abs(histIob - ghostIob);
    var iobScore     = Math.max(0, 1 - iobDelta / 3);

    // Composite confidence (weighted)
    var confidence = (
      shapeScore   * 0.35 +
      timingScore  * 0.25 +
      timeScore    * 0.20 +
      carbScore    * 0.12 +
      iobScore     * 0.08
    );

    scored.push({
      meal_t:        row.t,
      name:          row.name,
      total_carbs:   row.total_carbs,
      items:         row.items || null,
      confidence:    +confidence.toFixed(3),
      shape_match:   +shapeScore.toFixed(3),
      peak_timing_match: +timingScore.toFixed(3),
      carb_match:    +carbScore.toFixed(3),
      time_match:    +timeScore.toFixed(3),
      iob_match:     +iobScore.toFixed(3),
      gram_warning:  gramWarning,
    });
  });

  if (scored.length === 0) return [];

  // Aggregate by meal name — average scores across observations
  var byName = {};
  scored.forEach(function(s) {
    var k = s.name;
    if (!byName[k]) byName[k] = { samples: [], name: k };
    byName[k].samples.push(s);
  });

  var aggregated = Object.keys(byName).map(function(k) {
    var samps = byName[k].samples;
    var n     = samps.length;
    var avg   = function(fn){ return samps.reduce(function(s,x){return s+fn(x);},0)/n; };
    var obs   = n;
    var dq    = obs >= 10 ? 'solid' : obs >= 4 ? 'moderate' : 'preliminary';
    return {
      meal_t:        samps[0].meal_t,
      name:          k,
      total_carbs:   +avg(function(s){return s.total_carbs||0;}).toFixed(1),
      items:         samps[0].items,
      observations:  obs,
      confidence:    +avg(function(s){return s.confidence;}).toFixed(3),
      shape_match:   +avg(function(s){return s.shape_match;}).toFixed(3),
      peak_timing_match: +avg(function(s){return s.peak_timing_match;}).toFixed(3),
      carb_match:    +avg(function(s){return s.carb_match;}).toFixed(3),
      time_match:    +avg(function(s){return s.time_match;}).toFixed(3),
      iob_match:     +avg(function(s){return s.iob_match;}).toFixed(3),
      data_quality:  dq,
      gram_warning:  samps.some(function(s){return s.gram_warning;}),
    };
  });

  aggregated.sort(function(a,b){return b.confidence - a.confidence;});

  // Flag ambiguous: top-2 within 10% of each other
  if (aggregated.length >= 2 &&
      Math.abs(aggregated[0].confidence - aggregated[1].confidence) < 0.10) {
    aggregated[0].ambiguous = true;
    aggregated[1].ambiguous = true;
  }

  return aggregated.slice(0, 3);
}

async function _evaluateUnannouncedMeal(run, preBG) {
  if (!SUPABASE_READY) return;
  var startT = run[0].t;
  var peakPt = run.reduce(function(best, p){ return p.actual > best.actual ? p : best; }, run[0]);
  var rise   = peakPt.actual - (preBG || run[0].actual);

  if (rise < 1.5) return; // too small to be a meal

  // Check no meal was logged within 30min of startT
  var nearbyMeal = LOGGED_EVENTS.find(function(e){
    return e.c > 0 && Math.abs(e.t - startT) < 30 * 60000;
  });
  if (nearbyMeal) return; // announced meal — skip

  // Avoid re-detecting same event (within 1h)
  for (var ts of _detectedUnannouncedTs) {
    if (Math.abs(ts - startT) < 3600000) return;
  }
  _detectedUnannouncedTs.add(startT);

  // Estimate carbs from rise, discounting known IOB effect
  var d0         = dataAt(startT);
  var therapy    = _currentTherapySnapshot(startT);
  var isf        = therapy ? therapy.isf : 6.5;
  var iob        = d0 ? +d0.iob.toFixed(2) : 0;
  var iobEffect  = iob > 0 ? iob * isf * 0.4 : 0;
  var netRise    = Math.max(0, rise - iobEffect);
  var estCarbs   = +(netRise / 0.055).toFixed(0);
  var peakMins   = (peakPt.t - startT) / 60000;

  // ── Primary: match against meal_history composite curves ──────────────
  var candidateMeals = await _matchGhostToMealHistory(run, peakMins, estCarbs, startT, iob);

  // ── Fallback: food library GI curves (when meal_history has <3 viable rows) ──
  var allFoods    = FOOD_LIBRARY.slice();
  var candidateFoods = allFoods.map(function(f) {
    var gi = f.gi || 55;
    var expectedPeak = Math.max(15, 95 - gi);
    var timingDelta  = Math.abs(expectedPeak - peakMins);
    var confidence   = Math.max(0, 1 - timingDelta / 60);
    var estGrams     = f.c100 > 0 ? Math.round(estCarbs / (f.c100 / 100)) : null;
    return { name: f.name, gi: gi, confidence: +confidence.toFixed(2), estimated_g: estGrams };
  }).filter(function(c){ return c.confidence > 0.3; })
    .sort(function(a,b){ return b.confidence - a.confidence; })
    .slice(0, 5);

  var row = {
    t:               startT,
    detection_t:     Date.now(),
    pre_bg:          +(preBG || run[0].actual).toFixed(2),
    peak_bg:         +peakPt.actual.toFixed(2),
    peak_t:          peakPt.t,
    peak_mins:       Math.round(peakMins),
    total_rise:      +rise.toFixed(2),
    residual_curve:  run.map(function(p){ return { t: p.t, residual: +p.residual.toFixed(3) }; }),
    estimated_carbs: estCarbs,
    candidate_foods: candidateFoods.length > 0 ? candidateFoods : null,
    candidate_meals: candidateMeals.length > 0 ? candidateMeals : null,
    iob_at_t:        iob,
    therapy_snapshot: therapy,
    device_id:       _deviceId,
    confirmed:       false,
  };

  try {
    await _sbFetch('unannounced_meals?on_conflict=t', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: [row],
    });
    var best = candidateMeals[0] || candidateFoods[0];
    var bestLabel = best ? best.name + ' (' + Math.round((best.confidence||0)*100) + '%)' : 'no match';
    console.log('[ghost meal] ' + new Date(startT).toLocaleDateString('en-GB',{day:'2-digit',month:'short'}) +
      ' ' + new Date(startT).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}) +
      ' — ' + estCarbs + 'g est · pre ' + (preBG||run[0].actual).toFixed(1) +
      ' → peak ' + peakPt.actual.toFixed(1) + 'mmol at +' + Math.round(peakMins) + 'min' +
      ' · best: ' + bestLabel);
  } catch(e) {
    console.warn('[unannouncedMeal save]', e.message);
  }
}

// ── FEATURE 2: GHOST EVENT DETECTOR ─────────────────────────────────────
// Throttled to min 5min between runs. Writes to ghost_events table.
// Does NOT surface in UI yet — collect first. Pebbles added separately.

var _lastGhostCheck = 0;
var _ghostPebbles = []; // [{t, ghost_type, implied_units, implied_carbs, confidence, sheet_shown}]

function _ghostCarerContext(t) {
  var d = new Date(t);
  var h = d.getHours();
  var day = d.getDay(); // 0=Sun, 6=Sat
  var isWeekday = day >= 1 && day <= 5;
  if (isWeekday && h >= 9 && h < 15) return 'school_hours';
  if (h >= 0 && h < 6) return 'night';
  return 'daytime_family';
}

async function _maybeDetectGhostEvent() {
  var now = Date.now();
  if (now - _lastGhostCheck < 5 * 60000) return; // throttle 5min
  _lastGhostCheck = now;
  if (!SUPABASE_READY) return;

  try {
    var STEP = 5 * 60000; // 5-min steps
    var isf = getISF(now);

    // (a) unlogged_correction: BG dropping >0.25 mmol/min sustained 20+ min, IOB insufficient
    (function detectUnloggedCorrection() {
      try {
        var DROP_RATE = 0.25; // mmol/min threshold
        var MIN_DURATION_MS = 20 * 60000;
        var WINDOW_MS = 90 * 60000;
        var run = [];
        for (var i = 0; i <= WINDOW_MS / STEP; i++) {
          var t = now - WINDOW_MS + i * STEP;
          var d1 = dataAt(t);
          var d2 = dataAt(t - STEP);
          if (!d1 || !d2 || !d1.bg || !d2.bg) { run = []; continue; }
          var rate = (d1.bg - d2.bg) / 5; // mmol/min
          if (rate < -DROP_RATE) {
            run.push({ t: t, rate: rate, bg: d1.bg, iob: d1.iob });
          } else {
            if (run.length >= 4) { // 20+ min
              var evalRun = run.slice();
              (async function(runSlice) {
                var startT2 = runSlice[0].t;
                var endT    = runSlice[runSlice.length - 1].t;
                var bgDrop  = runSlice[0].bg - runSlice[runSlice.length - 1].bg;
                var avgIOB  = runSlice.reduce(function(s,p){return s+p.iob;},0)/runSlice.length;
                var predictedIobEffect = avgIOB * isf * 0.3;
                if (bgDrop <= predictedIobEffect * 1.4) return; // IOB explains it
                // Check no logged correction nearby
                var nearby = LOGGED_EVENTS.find(function(e){
                  return e.u > 0 && Math.abs(e.t - startT2) < 30 * 60000;
                });
                if (nearby) return;
                var impliedUnits = +(bgDrop / isf).toFixed(2);
                var ctx = _ghostCarerContext(startT2);
                await _writeGhostEvent({
                  t: startT2, ghost_type: 'unlogged_correction',
                  bg_at_detect: +runSlice[0].bg.toFixed(2),
                  residual_curve: runSlice.map(function(p){return {t:p.t,bg:p.bg};}),
                  implied_units: impliedUnits, implied_carbs: null,
                  confidence: ctx === 'school_hours' ? 0.55 : 0.72,
                  period: new Date(startT2).getHours() < 10 ? 'Breakfast' :
                          new Date(startT2).getHours() < 14 ? 'Lunch' :
                          new Date(startT2).getHours() < 18 ? 'Afternoon' :
                          new Date(startT2).getHours() < 22 ? 'Evening' : 'Overnight',
                  carer_context: ctx,
                });
              })(evalRun);
            }
            run = [];
          }
        }
      } catch(e) { console.warn('[ghost corr]', e.message); }
    })();

    // (b) unexplained_stabilisation: was trending high, now flat in target
    (function detectUnexplainedStabilisation() {
      try {
        var was_high_start = now - 35 * 60000;
        var was_high_end   = now - 20 * 60000;
        var d_was = dataAt(was_high_start);
        var d_mid = dataAt(was_high_end);
        if (!d_was || !d_mid || d_was.bg < 10 || !d_was.bg) return;
        var rise_rate = (d_mid.bg - d_was.bg) / 15;
        if (rise_rate < 0.08) return; // wasn't trending high enough
        // Now check flat in target
        var flatCount = 0;
        for (var fi = 0; fi < 4; fi++) {
          var ft = now - fi * STEP;
          var fd = dataAt(ft);
          if (fd && fd.bg >= 3.9 && fd.bg <= 10 && Math.abs(
            (dataAt(ft) && dataAt(ft - STEP) ? dataAt(ft).bg - dataAt(ft - STEP).bg : 1) / 5
          ) < 0.05) flatCount++;
        }
        if (flatCount < 3) return;
        // Check no correction/bolus nearby
        var nearbyCorr = LOGGED_EVENTS.find(function(e){
          return (e.u > 0 || e.c > 0) && Math.abs(e.t - now) < 20 * 60000;
        });
        if (nearbyCorr) return;
        var d_now = dataAt(now);
        (async function() {
          await _writeGhostEvent({
            t: now - 20 * 60000, ghost_type: 'unexplained_stabilisation',
            bg_at_detect: d_now ? +d_now.bg.toFixed(2) : null,
            residual_curve: null, implied_units: null, implied_carbs: null,
            confidence: 0.45, period: null, carer_context: _ghostCarerContext(now),
          });
        })();
      } catch(e) { console.warn('[ghost stab]', e.message); }
    })();

    // (c) unlogged_bolus (school/night): like correction but lower confidence
    (function detectUnloggedBolusContext() {
      try {
        var ctx = _ghostCarerContext(now);
        if (ctx !== 'school_hours' && ctx !== 'night') return;
        // Similar to correction detector but lower confidence threshold
        // Already covered by (a) with carer context = school_hours / night
        // This hook is for future specialisation — skip duplicate detection
      } catch(e) {}
    })();

    // (d) unexplained_rise: link to unannounced_meals if both detected for same window
    // Already handled by _maybeDetectUnannouncedMeal + ghost_events linkage below

  } catch(e) {
    console.warn('[ghostDetector]', e.message);
  }
}

var _ghostWrittenTs = new Set(); // avoid re-writing same event

async function _writeGhostEvent(data) {
  if (!SUPABASE_READY || !data.t) return;
  // Avoid duplicate writes for same window
  for (var gt of _ghostWrittenTs) {
    if (Math.abs(gt - data.t) < 25 * 60000) return;
  }
  try {
    var row = Object.assign({
      confirmed: null,
      confirmed_note: null,
      model_version: (window['__BUILD'+'_ID__'] || 'dev'),
    }, data);
    await _sbFetch('ghost_events?on_conflict=t', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: [row],
    });
    _ghostWrittenTs.add(data.t);
    // Add pebble to history scroll
    _ghostPebbles.push({
      t: data.t,
      ghost_type: data.ghost_type,
      implied_units: data.implied_units,
      implied_carbs: data.implied_carbs,
      confidence: data.confidence,
      confirmed: null,
    });
    console.log('[ghost] wrote', data.ghost_type, 'at', new Date(data.t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}));
  } catch(e) {
    console.warn('[ghost write]', e.message);
  }
}

// ── Ghost pebble rendering in history scroll ──────────────────────────────
// Called from drawBolusMarkers / event drawing section.
// Soft grey, '?' icon. Tap → bottom sheet.
function drawGhostPebbles(pal) {
  if (!_ghostPebbles || _ghostPebbles.length === 0) return;
  var now = Date.now();
  _ghostPebbles.forEach(function(g) {
    if (g.confirmed === 'dismissed') return;
    var x = tX(g.t);
    if (x < -20 || x > W + 20) return;
    var y = H * 0.18; // top area
    var alpha = 0.55;
    CX.save();
    CX.globalAlpha = alpha;
    CX.fillStyle = 'rgba(160,170,180,0.18)';
    CX.strokeStyle = 'rgba(160,170,190,' + alpha + ')';
    CX.lineWidth = 1;
    CX.beginPath();
    CX.arc(x, y, 9, 0, Math.PI * 2);
    CX.fill();
    CX.stroke();
    CX.globalAlpha = alpha * 0.9;
    CX.fillStyle = 'rgba(200,210,220,0.9)';
    CX.font = "bold 10px 'DM Mono',monospace";
    CX.textAlign = 'center';
    CX.textBaseline = 'middle';
    CX.fillText('?', x, y);
    CX.globalAlpha = 1;
    CX.restore();
    // Register hit target
    if (!window._ghostPebbleCards) window._ghostPebbleCards = [];
    window._ghostPebbleCards.push({ x: x, y: y, ghost: g });
  });
}

function openGhostSheet(ghost) {
  var ex = document.getElementById('ghost-sheet');
  if (ex) ex.remove();
  var el = document.createElement('div');
  el.id = 'ghost-sheet';
  el.style.cssText = 'position:fixed;inset:0;z-index:80;background:rgba(3,5,20,0.92);' +
    'backdrop-filter:blur(16px);display:flex;flex-direction:column;align-items:center;' +
    'justify-content:flex-end;padding:0;pointer-events:auto;touch-action:pan-y';
  el.addEventListener('click', function(e){ if(e.target===el) el.remove(); });

  var t = ghost.t;
  var timeStr = new Date(t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
  var dateStr = new Date(t).toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'});

  var inner = document.createElement('div');
  inner.style.cssText = 'width:100%;max-width:400px;background:rgba(10,14,30,0.98);' +
    'border-top-left-radius:18px;border-top-right-radius:18px;' +
    'padding:24px 20px 40px;box-sizing:border-box;' +
    'font-family:"DM Mono",monospace';

  inner.innerHTML =
    '<div style="text-align:center;font-size:28px;margin-bottom:8px">?</div>' +
    '<div style="font-style:italic;font-size:18px;color:rgba(180,200,220,0.85);text-align:center;margin-bottom:6px">we noticed something unexplained</div>' +
    '<div style="font-size:9px;letter-spacing:1px;text-transform:uppercase;color:rgba(160,180,200,0.4);text-align:center;margin-bottom:20px">' + dateStr + ' · ' + timeStr + ' · ' + (ghost.ghost_type||'').replace(/_/g,' ') + '</div>' +
    (ghost.implied_units ? '<div style="font-size:11px;color:rgba(100,160,240,0.7);text-align:center;margin-bottom:16px">implied correction ≈ ' + ghost.implied_units + 'U</div>' : '') +
    (ghost.implied_carbs ? '<div style="font-size:11px;color:rgba(240,160,60,0.7);text-align:center;margin-bottom:16px">implied carbs ≈ ' + ghost.implied_carbs + 'g</div>' : '') +
    '<div style="display:flex;flex-direction:column;gap:10px;margin-top:8px">' +
      '<button id="ghost-yes-btn" style="width:100%;padding:14px;border-radius:10px;border:1px solid rgba(62,180,120,0.4);background:rgba(62,180,120,0.08);font-style:italic;font-size:16px;color:rgba(62,200,140,0.9);cursor:pointer">yes — add it</button>' +
      '<button id="ghost-explain-btn" style="width:100%;padding:12px;border-radius:10px;border:1px solid rgba(180,200,220,0.2);background:transparent;font-size:10px;letter-spacing:0.5px;color:rgba(180,200,220,0.5);cursor:pointer">no — explain</button>' +
      '<button id="ghost-dismiss-btn" style="width:100%;padding:10px;border-radius:10px;border:none;background:transparent;font-size:9px;color:rgba(140,160,180,0.3);cursor:pointer">dismiss</button>' +
    '</div>';

  el.appendChild(inner);
  document.body.appendChild(el);

  var _ghostT = t;
  document.getElementById('ghost-yes-btn').addEventListener('click', function(){ window._ghostYes(_ghostT); });
  document.getElementById('ghost-explain-btn').addEventListener('click', function(){ window._ghostExplain(_ghostT); });
  document.getElementById('ghost-dismiss-btn').addEventListener('click', function(){ window._ghostDismiss(_ghostT); });
  window._ghostYes = function(ts) {
    el.remove();
    var g2 = _ghostPebbles.find(function(p){ return p.t == ts; });
    // Open log entry pre-filled
    if (g2 && g2.ghost_type === 'unlogged_correction') {
      openCorrectionLog();
    } else {
      openSheet();
    }
  };
  window._ghostExplain = function(ts) {
    var note = prompt('What was happening at ' + timeStr + '?');
    if (!note) return;
    var g2 = _ghostPebbles.find(function(p){ return p.t == ts; });
    if (g2) g2.confirmed = 'no_explained';
    if (SUPABASE_READY) {
      _sbFetch('ghost_events?t=eq.' + ts, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { confirmed: false, confirmed_note: note }
      }).catch(function(){});
    }
    el.remove();
  };
  window._ghostDismiss = function(ts) {
    var g2 = _ghostPebbles.find(function(p){ return p.t == ts; });
    if (g2) g2.confirmed = 'dismissed';
    if (SUPABASE_READY) {
      _sbFetch('ghost_events?t=eq.' + ts, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { confirmed: false, confirmed_note: 'dismissed' }
      }).catch(function(){});
    }
    el.remove();
  };
}

// ── 4. DAILY MODEL ACCURACY ROLLUP ───────────────────────────────────
// Runs after each outcome is collected. Aggregates today's meal/bolus
// outcomes into model_accuracy table. "N weeks to see results" queries
// run against this table.

var _lastAccuracyRollup = 0;

async function _maybeRollupModelAccuracy() {
  if (Date.now() - _lastAccuracyRollup < 10 * 60000) return; // max once per 10min
  _lastAccuracyRollup = Date.now();
  if (!SUPABASE_READY) return;

  try {
    var today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    var dayStart = new Date(today).getTime();
    var dayEnd   = dayStart + 86400000;

    // Pull today's outcomes from Supabase
    var mealRows  = await _sbFetch('meal_history?created_at=gte.' + new Date(dayStart).toISOString() + '&rmse=not.is.null&select=rmse,peak_error', {});
    var bolusRows = await _sbFetch('bolus_outcomes?created_at=gte.' + new Date(dayStart).toISOString() + '&select=rmse,observed_isf', {});
    var unRows    = await _sbFetch('unannounced_meals?created_at=gte.' + new Date(dayStart).toISOString() + '&select=id', {});

    if (!Array.isArray(mealRows)) mealRows = [];
    if (!Array.isArray(bolusRows)) bolusRows = [];
    if (!Array.isArray(unRows)) unRows = [];

    var mealRMSE = mealRows.length > 0
      ? mealRows.reduce(function(s,r){return s+(r.rmse||0);},0) / mealRows.length : null;
    var bolusRMSE = bolusRows.length > 0
      ? bolusRows.reduce(function(s,r){return s+(r.rmse||0);},0) / bolusRows.length : null;
    var isfValues = bolusRows.map(function(r){return r.observed_isf;}).filter(Boolean);
    var isfMean   = isfValues.length > 0 ? isfValues.reduce(function(s,v){return s+v;},0)/isfValues.length : null;
    var isfSD     = isfValues.length > 1
      ? Math.sqrt(isfValues.reduce(function(s,v){return s+Math.pow(v-isfMean,2);},0)/isfValues.length)
      : null;

    // TIR for today from HISTORY_RAW
    var todayReadings = HISTORY_RAW.filter(function(r){ return r.t >= dayStart && r.t < dayEnd && r.bg > 0; });
    var tir      = todayReadings.length > 0
      ? todayReadings.filter(function(r){return r.bg >= 3.9 && r.bg <= 10;}).length / todayReadings.length * 100 : null;
    var tirTight = todayReadings.length > 0
      ? todayReadings.filter(function(r){return r.bg >= 4.5 && r.bg <= 8;}).length / todayReadings.length * 100 : null;

    await _sbFetch('model_accuracy?on_conflict=date', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: [{
        date:              today,
        meal_rmse:         mealRMSE   ? +mealRMSE.toFixed(4)  : null,
        bolus_rmse:        bolusRMSE  ? +bolusRMSE.toFixed(4) : null,
        isf_mean:          isfMean    ? +isfMean.toFixed(2)    : null,
        isf_sd:            isfSD      ? +isfSD.toFixed(2)      : null,
        tir:               tir        ? +tir.toFixed(1)        : null,
        tir_tight:         tirTight   ? +tirTight.toFixed(1)   : null,
        meal_count:        mealRows.length,
        bolus_count:       bolusRows.length,
        unannounced_count: unRows.length,
        model_version:     (window['__BUILD'+'_ID__'] || 'dev'),
      }],
    });
  } catch(e) {
    console.warn('[accuracyRollup]', e.message);
  }
}

// ── CONTEXT STAMPING HELPERS ──────────────────────────────────────────
// Called at moment of logging to capture therapy + glucose context.
// Stored on events and meal_history for longitudinal pattern analysis.

// ── ADAPTIVE THERAPY RESOLUTION ──────────────────────────────────────
// Single source of truth for ISF and I:C at any given time.
// Priority:
//   1. Observed ISF from bolus_outcomes (if enough data — MIN_OUTCOMES_FOR_ADAPTATION)
//   2. _TREATMENT ratios (Supabase-synced therapy settings)
//   3. Hardcoded defaults (Oskar's original values — last resort only)
//
// "reading.count < something" logic:
// MIN_OUTCOMES_FOR_ADAPTATION = 10 bolus outcomes in a period.
// Below that: use _TREATMENT. Above: blend observed mean (70%) with _TREATMENT (30%).
// This prevents early noisy data from destabilising the model prematurely.

const MIN_OUTCOMES_FOR_ADAPTATION = 10; // min bolus_outcomes rows per period before trusting observed ISF

// In-memory cache of observed ISF means, populated from bolus_outcomes on sync.
// Structure: { Breakfast: {mean: 6.8, count: 14}, Lunch: {mean: 7.1, count: 8}, ... }
var _observedISF = {};

async function loadObservedISF() {
  if (!SUPABASE_READY) return;
  try {
    var rows = await _sbFetch(
      'bolus_outcomes?select=period,observed_isf,return_mins&observed_isf=not.is.null&order=t.desc&limit=500',
      { method: 'GET' }
    );
    if (!Array.isArray(rows) || rows.length === 0) return;
    var byPeriod = {};
    var returnMinsAll = [];
    rows.forEach(function(r) {
      if (!r.period || !r.observed_isf) return;
      if (!byPeriod[r.period]) byPeriod[r.period] = [];
      byPeriod[r.period].push(r.observed_isf);
      if (r.return_mins && r.return_mins > 0) returnMinsAll.push(r.return_mins);
    });
    _observedISF = {};
    Object.keys(byPeriod).forEach(function(period) {
      var vals = byPeriod[period];
      var mean = vals.reduce(function(s,v){return s+v;},0) / vals.length;
      _observedISF[period] = { mean: +mean.toFixed(2), count: vals.length };
    });
    // Median observed DIA from return_mins — used for the observed IOB curve overlay
    if (returnMinsAll.length >= 3) {
      var sorted = returnMinsAll.slice().sort(function(a,b){return a-b;});
      window._medianReturnMins = sorted[Math.floor(sorted.length / 2)];
      console.log('[observed DIA] median return_mins:', window._medianReturnMins + 'min from ' + returnMinsAll.length + ' outcomes');
    }
    if (Object.keys(_observedISF).length > 0) {
      console.log('[adaptive ISF] loaded:', JSON.stringify(_observedISF));
    }
  } catch(e) {
    console.warn('[loadObservedISF]', e.message);
  }
}

// ── TIME-BASED SEGMENT LOOKUP ─────────────────────────────────────────────
// ratios rows use {start:"HH:MM", end:"HH:MM", ic, isf, target} — no labels.
// "end":"24:00" is treated as midnight (exclusive upper bound = next day 00:00).

function _hhmm(t) {
  // Returns "HH:MM" string for a unix-ms timestamp (local time)
  var d = new Date(t || Date.now());
  return (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' +
         (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
}

function _ratioForTime(ratios, t) {
  // Finds the matching segment in a time-based ratios array for timestamp t.
  // Segments: {start:"HH:MM", end:"HH:MM", ic, isf, target}
  // end:"24:00" wraps to "00:00" for comparison.
  if (!ratios || !ratios.length) return null;
  var hhmm = _hhmm(t);
  for (var i = 0; i < ratios.length; i++) {
    var r = ratios[i];
    if (!r.start || !r.end) continue;
    var end = r.end === '24:00' ? '99:99' : r.end; // 24:00 always wins as last slot
    if (hhmm >= r.start && hhmm < end) return r;
  }
  return ratios[ratios.length - 1]; // fallback: last segment
}

// Cache for getTherapyAt — keyed by therapy_history.t (not event t), filled lazily.
var _therapyHistoryCache = null; // full sorted array, loaded once

async function _loadTherapyHistory() {
  if (_therapyHistoryCache !== null) return _therapyHistoryCache;
  try {
    var rows = await _sbFetch(
      'therapy_history?order=t.asc&select=t,ratios,basal_dose,basal_type,hypo_threshold,hypo_carbs,dia',
      {}
    );
    _therapyHistoryCache = Array.isArray(rows) ? rows : [];
  } catch(e) {
    console.warn('[getTherapyAt] load failed:', e.message);
    _therapyHistoryCache = [];
  }
  return _therapyHistoryCache;
}

async function getTherapyAt(t) {
  // Returns the therapy_history row active at unix-ms timestamp t.
  // Uses binary search on the pre-loaded sorted cache.
  var rows = await _loadTherapyHistory();
  if (!rows.length) return null;
  // Find last row where row.t <= t
  var result = null;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].t <= t) result = rows[i];
    else break;
  }
  return result;
}

function getISF(t, historicalRatios) {
  // historicalRatios: optional pre-fetched ratios array from getTherapyAt (for backfill paths)
  var now = t || Date.now();
  var ratios = historicalRatios ||
    (typeof _TREATMENT !== 'undefined' && _TREATMENT && _TREATMENT.ratios) || null;

  // Layer 1: Find segment for this time in ratios (time-based or label-based)
  var treatmentISF = null;
  if (ratios) {
    var seg = _ratioForTime(ratios, now);
    if (seg && seg.isf) treatmentISF = seg.isf;
  }

  // Layer 2: Observed ISF from bolus_outcomes (only in live/current context, not backfill)
  if (!historicalRatios) {
    var h = new Date(now).getHours();
    var periodKey = h >= 6 && h < 10 ? '06:30' : h >= 10 && h < 14 ? '09:30' :
                    h >= 14 && h < 18 ? '11:30' : h >= 18 && h < 22 ? '16:30' : '00:00';
    var obs = _observedISF[periodKey] || _observedISF[_hhmm(now)];
    if (obs && obs.count >= MIN_OUTCOMES_FOR_ADAPTATION) {
      if (treatmentISF) {
        var blended = obs.mean * 0.7 + treatmentISF * 0.3;
        return +blended.toFixed(2);
      }
      return obs.mean;
    }
  }

  if (treatmentISF) return treatmentISF;
  // Hardcoded fallback
  var hh = new Date(now).getHours();
  return hh >= 9 && hh < 15 ? 7.0 : 6.5;
}

function getIC(t, historicalRatios) {
  // historicalRatios: optional pre-fetched ratios array from getTherapyAt (for backfill paths)
  var now = t || Date.now();
  var ratios = historicalRatios ||
    (typeof _TREATMENT !== 'undefined' && _TREATMENT && _TREATMENT.ratios) || null;
  if (ratios) {
    var seg = _ratioForTime(ratios, now);
    if (seg && seg.ic) return seg.ic;
  }
  // Hardcoded fallback
  var h = new Date(now).getHours();
  return h >= 6 && h < 10 ? 8.5 : h >= 10 && h < 14 ? 12 : h >= 14 && h < 18 ? 15 : 10;
}

function getTarget(t, historicalRatios) {
  var now = t || Date.now();
  var ratios = historicalRatios ||
    (typeof _TREATMENT !== 'undefined' && _TREATMENT && _TREATMENT.ratios) || null;
  if (ratios) {
    var seg = _ratioForTime(ratios, now);
    if (seg && seg.target) return seg.target;
  }
  return (typeof _TREATMENT !== 'undefined' && _TREATMENT && _TREATMENT.targetBG)
    ? _TREATMENT.targetBG : 6.0;
}

function _currentTherapySnapshot(t) {
  var now = t || Date.now();
  var ratios = (typeof _TREATMENT !== 'undefined' && _TREATMENT && _TREATMENT.ratios) || null;
  if (!ratios) return null;
  var seg = _ratioForTime(ratios, now);
  if (!seg) return null;
  return {
    period: (seg.start + '-' + seg.end), // time-range string replaces label
    isf: seg.isf, ic: seg.ic,
    basal: _TREATMENT && _TREATMENT.basalDose,
    basalType: _TREATMENT && _TREATMENT.basalType,
    insulinType: _currentSelectedInsulin(),
  };
}

function _preBG(t) {
  if (typeof dataAt !== 'function') return null;
  var d = dataAt((t || Date.now()) - 2 * 60000);
  return (d && d.bg > 0) ? +d.bg.toFixed(1) : null;
}

// ── MEAL HISTORY SUPABASE SYNC ─────────────────────────────────────────
// Every meal logged also writes to meal_history table for longitudinal pattern analysis.
// Includes therapy snapshot at time of meal — critical for "porridge on old vs new ratio" queries.

async function syncMealToSupabase(meal) {
  if (!SUPABASE_READY || !meal || !meal.t) return;
  try {
    // Capture therapy snapshot for active period at meal time
    var therapySnap = _currentTherapySnapshot(meal.t);

    // Capture pre-meal BG (nearest reading before meal time)
    var preBG = null;
    if (typeof dataAt === 'function') {
      var d = dataAt(meal.t - 2 * 60000); // 2 min before
      if (d && d.bg > 0) preBG = +d.bg.toFixed(1);
    }

    var row = {
      t:                meal.t,
      name:             meal.name || null,
      total_carbs:      meal.totalCarbs || 0,
      items:            meal.items || null,
      bolus_u:          meal.u || null,
      bolus_t:          meal.boluT || meal.t || null,
      wait_mins:        meal.waitMins || null,
      pre_bg:           preBG,
      therapy_snapshot: therapySnap,
      source:           meal.source || 'manual',
      logged_by:        meal.logged_by || _thisPersonId || null,
      device_id:        _deviceId,
      predicted_curve:  meal._predictedCurve || null,
      formula_version:  meal._predictedCurve ? _PRED_FORMULA_VERSION : null,
      is_partial:       true,
    };

    await _sbFetch('meal_history?on_conflict=t', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: [row],
    });
  } catch(e) {
    console.warn('[syncMeal]', e.message);
  }
}

async function syncMealHistoryFromSupabase() {
  if (!SUPABASE_READY) return;
  try {
    var oldest = MEAL_HISTORY.length > 0
      ? Math.min.apply(null, MEAL_HISTORY.map(function(m){ return m.t; }))
      : 0;
    var since = oldest > 0 ? oldest - 24 * 3600000 : 0;
    var rows = await _sbFetch(
      'meal_history?t=gte.' + since + '&order=t.desc&limit=500&select=t,name,total_carbs,items,bolus_u,pre_bg,therapy_snapshot,source,logged_by,predicted_curve',
      { method: 'GET' }
    );
    if (!Array.isArray(rows) || rows.length === 0) return;
    var localMap = {};
    MEAL_HISTORY.forEach(function(m) { localMap[m.t] = m; });
    var added = 0;
    rows.forEach(function(row) {
      // Skip rows for events the user has explicitly deleted locally —
      // otherwise a ghost prediction curve gets re-pulled on every sync.
      if (typeof _deletedEventTs !== 'undefined' && _deletedEventTs.has(row.t)) return;

      var items = row.items;
      if (typeof items === 'string') { try { items = JSON.parse(items); } catch(e) { items = null; } }
      // Parse predicted_curve from Supabase
      var predCurve = row.predicted_curve;
      if (typeof predCurve === 'string') { try { predCurve = JSON.parse(predCurve); } catch(e) { predCurve = null; } }

      if (localMap[row.t]) {
        // Don't resurrect a curve the user deliberately cleared locally
        if (localMap[row.t]._curveDeleted) return;
        // Update existing record with Supabase predicted_curve if available
        if (predCurve && predCurve.length > 1) {
          localMap[row.t]._predictedCurve = predCurve;
        }
      } else {
        var rec = {
          t: row.t,
          name: row.name,
          totalCarbs: row.total_carbs,
          items: items,
          u: row.bolus_u,
          pre_bg: row.pre_bg,
          therapy_snapshot: row.therapy_snapshot,
          source: row.source,
          logged_by: row.logged_by,
        };
        if (predCurve && predCurve.length > 1) rec._predictedCurve = predCurve;
        MEAL_HISTORY.push(rec);
        added++;
      }
    });
    if (added > 0) {
      MEAL_HISTORY.sort(function(a,b){ return b.t - a.t; });
      saveMealHistory();
    }
    // Only backfill JS-computed curves for records still missing them
    _backfillPredictedCurves();
    // Populate _activePredictedCurves from Supabase-sourced curves
    _loadActiveCurvesFromMealHistory();
  } catch(e) {
    console.warn('[syncMealHistory pull]', e.message);
  }
}

// Load _activePredictedCurves from MEAL_HISTORY._predictedCurve values.
// Called after syncMealHistoryFromSupabase so Supabase-computed curves take precedence.
function _loadActiveCurvesFromMealHistory() {
  var refT = CGM_END || Date.now();
  MEAL_HISTORY.forEach(function(meal) {
    if (!meal._predictedCurve || meal._predictedCurve.length < 2) return;
    var anchorT = meal._predictedCurve[0].t;
    if (Math.abs(anchorT - refT) > 24 * 3600000) return; // only last 24h
    var dup = _activePredictedCurves.some(function(s) {
      return s.pts && s.pts[0] && Math.abs(s.pts[0].t - anchorT) < 60000;
    });
    if (!dup) {
      _activePredictedCurves.push({ loggedAt: anchorT, pts: meal._predictedCurve });
    } else {
      // Replace with Supabase version (more accurate)
      _activePredictedCurves.forEach(function(s) {
        if (s.pts && s.pts[0] && Math.abs(s.pts[0].t - anchorT) < 60000) {
          s.pts = meal._predictedCurve;
        }
      });
    }
  });
  _activePredictedCurves.sort(function(a,b){ return b.loggedAt - a.loggedAt; });
  if (_activePredictedCurves.length > 20) _activePredictedCurves.length = 20;
  try { localStorage.setItem('river_predicted_curves_v' + _PRED_FORMULA_VERSION, JSON.stringify(_activePredictedCurves)); } catch(e) {}
}

// Reconstruct _predictedCurve for MEAL_HISTORY records that don't have one.
// Uses stored pre_bg and therapy_snapshot to replay the prediction as it would
// have been computed at log time. Also populates _activePredictedCurves.
function _backfillPredictedCurves() {
  var now = Date.now();
  MEAL_HISTORY.forEach(function(meal) {
    if (meal._curveDeleted) return; // user deleted this event — don't resurrect the ghost
    if (meal._predictedCurve && meal._predictedCurve.length > 1) return; // already have it
    if (!meal.t) return;
    if (now - meal.t > 24 * 3600000) return; // only backfill last 24h for rendering

    var anchorT  = meal.t;
    var baseBG   = meal.pre_bg || 7.0;
    var snap     = meal.therapy_snapshot || {};

    // Reconstruct a single-segment ratios array from the stored snapshot so
    // getISF/getIC (via _computeForecastCurve) return what was actually in
    // force at log time, not whatever the live treatment plan says now.
    var historicalRatios = (snap.isf || snap.ic)
      ? [{ start: '00:00', end: '24:00', isf: snap.isf, ic: snap.ic, target: snap.target }]
      : null;

    // Total carbs + average GI from the meal's own items
    var totalCarbs = 0, avgGI = 55;
    if (meal.items) {
      meal.items.forEach(function(f) { totalCarbs += (f.carbs || 0); });
      if (totalCarbs > 0) {
        var giSum = 0;
        meal.items.forEach(function(f) { if (f.carbs > 0) giSum += (f.gi || 55) * f.carbs; });
        avgGI = giSum / totalCarbs;
      }
    }

    var mealsForCurve = [{
      t: anchorT,
      items: (meal.items && meal.items.length) ? meal.items : [{ name: 'meal', carbs: totalCarbs, gi: avgGI }]
    }];

    // Covering units — boluses within 90min before this meal, attributed
    // only if this is the NEAREST meal to that bolus. Without this, a
    // single bolus given between two closely-logged meals (e.g. 13 min
    // apart) gets counted in full against BOTH meals' curves, making each
    // look massively over-bolused and predicting a crash to the floor.
    var activeBoluses = [];
    LOGGED_EVENTS.forEach(function(ev) {
      if (!ev.u || ev.u <= 0 || ev.note === 'basal') return;
      var bAge = (anchorT - ev.t) / 60000;
      if (bAge < -15 || bAge > 90) return;
      var myDist = Math.abs(ev.t - anchorT);
      var closerToOther = MEAL_HISTORY.some(function(other) {
        if (other === meal || !other.t) return false;
        return Math.abs(ev.t - other.t) < myDist;
      });
      if (closerToOther) return;
      activeBoluses.push({ t: ev.t, u: ev.u });
    });
    if (activeBoluses.length === 0 && meal.u && meal.u > 0) {
      activeBoluses.push({ t: meal.bolus_t || anchorT, u: meal.u });
    }

    // Same shared formula as the live forecast — no independent reimplementation.
    var pts = _computeForecastCurve(anchorT, baseBG, mealsForCurve, activeBoluses, historicalRatios);

    meal._predictedCurve = pts;

    // Also add to _activePredictedCurves if not already present
    var dup = _activePredictedCurves.some(function(s) {
      return s.pts && s.pts[0] && Math.abs(s.pts[0].t - anchorT) < 60000;
    });
    if (!dup) _activePredictedCurves.push({ loggedAt: anchorT, pts: pts });
  });

  // Sort newest first, trim to 20
  _activePredictedCurves.sort(function(a,b){ return b.loggedAt - a.loggedAt; });
  if (_activePredictedCurves.length > 20) _activePredictedCurves.length = 20;
  try { localStorage.setItem('river_predicted_curves_v' + _PRED_FORMULA_VERSION, JSON.stringify(_activePredictedCurves)); } catch(e) {}
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
  window._selectedInsulinType = null; // reset to default — re-derived by _insulinSelectorHTML
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
  var all  = FOOD_LIBRARY.slice();
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
          // Insulin selector (only shown when >1 insulin active)
          _insulinSelectorHTML('rgba(60,130,220,OPACITY)') +
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
  var all = FOOD_LIBRARY.slice();
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
  var insType = _currentSelectedInsulin();
  SESSION.push({t:t, c:0, u:u});
  LOGGED_EVENTS.push({t:t, c:0, u:u, note:'bolus', insulin_type:insType, logged_by:_thisPersonId||'unknown', local:true});
  try{localStorage.setItem('river_session',JSON.stringify(SESSION));}catch(e){}
  try{localStorage.setItem('river_logged',JSON.stringify(LOGGED_EVENTS));}catch(e){}
  topUpIOB(u);
  // Snapshot IOB prediction curve for outcome tracking
  (function() {
    console.log('[bolusOutcomeBaseline] IIFE entered', t, u, insType);
    try {
      var bolusEv = {t:t, u:u, insulin_type:insType, logged_by:_thisPersonId||'unknown'};
      var iobCurve = [];
      var d0 = dataAt(t);
      var ISF = _currentTherapySnapshot(t);
      var isf = ISF ? ISF.isf : 6.5;
      var insProfile = _getInsulinProfile(insType);
      for (var m = 5; m <= 240; m += 5) {
        var predBG = d0 ? Math.max(1.8, d0.bg - u * (1 - _iobFn(m, insProfile.diaMins, insProfile.peakMins)) * isf) : 0;
        iobCurve.push({mins: m, bg: +predBG.toFixed(2)});
      }
      console.log('[bolusOutcomeBaseline] about to call wrapper', bolusEv);
      // Fire-and-forget deliberately: UI must not block on the ~1.5s retry.
      // Failures are caught internally and flagged via needs_outcome_baseline
      // for the sweep, not surfaced here.
      _createBolusOutcomeBaselineWithRetry(bolusEv, iobCurve);
    } catch (diagErr) {
      console.warn('[bolusOutcomeBaseline] IIFE setup threw before reaching wrapper:', diagErr);
    }
  })();
  syncAfterLog();
  _ptCache = null;
  _plateBolused = true;
  _plateBolusU  = u;
  _plateBolusTm = t;
  // Snapshot prediction at bolus time
  _snapshotPrediction();
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
  var carbT    = _safeEventT(t + eatWait*60000);
  var foodItems= _plateItems.map(function(i){return {name:i.name,carbs:i.carbs,gi:i.gi||55,g:i.grams};});

  if (total>0) {
    SESSION.push({t:carbT, c:total, u:0, gi:avgGI, items:foodItems});
    LOGGED_EVENTS.push({t:carbT, c:total, u:0, gi:avgGI, items:foodItems, note:'plate',
      logged_by:_thisPersonId||'unknown', local:true,
      therapy_snapshot: _currentTherapySnapshot(carbT),
      pre_bg: _preBG(carbT)});
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
    (function(){
      var _snap = buildSmartForecast(MEAL_HISTORY[0] ? MEAL_HISTORY[0].t : (CGM_END || Date.now()));
      if (MEAL_HISTORY[0]) MEAL_HISTORY[0]._predictedCurve = _snap;
      _pushActivePredictedCurve(_snap, Date.now());
      syncMealToSupabase(MEAL_HISTORY[0]);
    })();

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
  var all=FOOD_LIBRARY.slice();
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
  var ic   = getIC(entryTime);
  var isf  = getISF(entryTime);
  var tgt  = getTarget(entryTime);
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
// ── FEATURE 1: BOLUS OVERRIDE CLASSIFIER ─────────────────────────────────
// Pen doses are 0.5U increments. Classifies whether a user override was
// a forced rounding, a directional choice, or a deliberate true override.
function classifyBolusOverride(suggested, delivered) {
  if (typeof suggested !== 'number' || typeof delivered !== 'number') return null;
  var diff = delivered - suggested;
  var absDiff = Math.abs(diff);
  var direction = diff > 0 ? 'up' : 'down';
  var type;
  if (absDiff <= 0.25) {
    type = 'forced'; // no meaningful choice — nearest 0.5 from suggested is delivered
  } else if (absDiff <= 0.55) {
    type = 'direction'; // chose which way to round
  } else {
    type = 'true'; // deliberate override beyond rounding
  }
  return { type: type, direction: direction, magnitude: +absDiff.toFixed(2) };
}

// ── BOLUS OVERRIDE STORE ─────────────────────────────────────────────────
// Called after a bolus event is logged. Stores override classification to Supabase events.
async function _storeBolusOverride(bolusT, suggestedUnits, deliveredUnits) {
  if (!SUPABASE_READY || !suggestedUnits || !deliveredUnits) return;
  var cls = classifyBolusOverride(suggestedUnits, deliveredUnits);
  if (!cls) return;
  try {
    await _sbFetch('events?t=eq.' + bolusT, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: {
        override_type: cls.type,
        override_dir:  cls.direction,
        override_mag:  cls.magnitude,
        suggested_units: +suggestedUnits.toFixed(2),
        updated_at: new Date().toISOString(),
      }
    });
  } catch(e) {
    console.warn('[bolusOverride]', e.message);
  }
}

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
  var ISF  = getISF(viewTime);
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
  window._selectedInsulinType = null; // reset to default — re-derived by _insulinSelectorHTML
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

function _giFromNameRegex(n){
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

        // Insulin selector (only shown when >1 insulin active)
        _insulinSelectorHTML('rgba(40,85,200,OPACITY)') +

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
          ' oninput="_debouncedSearchFood(this.value)" onpaste="setTimeout(function(){checkFoodPaste(document.getElementById(\'food-search\').value)},50)">' +
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
        _insulinSelectorHTML('rgba(40,85,200,OPACITY)') +
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

// ── Debounced search — prevents inline form stealing focus on every keystroke ──
var _searchDebounceTimer = null;
function _debouncedSearchFood(q) {
  clearTimeout(_searchDebounceTimer);
  // Show matches immediately (fast feedback); only show no-match inline form after pause
  var all = FOOD_LIBRARY.slice();
  var ql = q.toLowerCase();
  var matches = q && q.length >= 1 ? all.filter(function(f){ return f.name.toLowerCase().indexOf(ql) >= 0; }).slice(0,8) : [];
  if (matches.length > 0) {
    // Results exist — show immediately, no debounce needed
    searchFood(q);
  } else if (!q || q.length < 1) {
    var results = document.getElementById('food-results');
    if (results) results.style.display = 'none';
  } else {
    // No match — wait for typing to pause before showing inline form
    _searchDebounceTimer = setTimeout(function(){ searchFood(q); }, 420);
  }
}

function searchFood(q) {
  var results = document.getElementById('food-results');
  if (!q || q.length < 1) { results.style.display='none'; return; }
  var ql = q.toLowerCase();

  // Combine DB + library
  var all = FOOD_LIBRARY.slice();
  var matches = all.filter(function(f) { return f.name.toLowerCase().indexOf(ql) >= 0; }).slice(0, 8);

  if (matches.length === 0) {
    // No match — show a clear prompt row; user taps to open the add-food modal.
    // Don't auto-open — too surprising if they just paused mid-type.
    results.style.display = 'block';
    results.innerHTML =
      '<div onclick="document.getElementById(\'food-results\').style.display=\'none\';addCustomFood(\'' + q.replace(/'/g,"\\'") + '\')" ' +
        'style="padding:11px 14px;cursor:pointer;display:flex;align-items:center;gap:10px">' +
        '<div style="width:26px;height:26px;border-radius:50%;border:1px solid rgba(62,180,120,0.4);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:14px;color:rgba(100,220,160,0.7)">+</div>' +
        '<div>' +
          '<div style="font-family:\'DM Mono\',monospace;font-size:12px;color:rgba(220,235,250,0.85)">' + q + '</div>' +
          '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:rgba(62,180,120,0.5);margin-top:1px">not in library — tap to add &amp; save</div>' +
        '</div>' +
      '</div>';
    return;
  }

  // Has matches — show results + "add exactly what I typed" if it's not an exact match
  var exactMatch = matches.find(function(f){ return f.name.toLowerCase() === ql; });
  results.style.display='block';
  var matchHtml = matches.map(function(f) {
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

  // Offer "add exactly what I typed" at the bottom if not an exact match
  var addExactRow = !exactMatch
    ? '<div onclick="addCustomFood(\'' + q.replace(/'/g,"\\'") + '\')" style="padding:9px 14px;cursor:pointer;border-top:1px solid rgba(255,255,255,0.05);font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(130,160,220,0.6)">+ add &#8220;' + q + '&#8221; as new food</div>'
    : '';

  results.innerHTML = matchHtml + addExactRow;
}

// ── Prevent non-numeric input on number fields (fixes letter entry on iOS) ──
function _numericOnly(e) {
  var allowed = ['Backspace','Delete','Tab','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Enter','.'];
  if (allowed.indexOf(e.key) >= 0) return true;
  if (e.key >= '0' && e.key <= '9') return true;
  e.preventDefault(); return false;
}


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
  var libraryHint = FOOD_LIBRARY.slice().slice(0,30).map(function(f){ return f.name; }).join(', ');

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
  var all2 = FOOD_LIBRARY.slice();

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
  var all2 = FOOD_LIBRARY.slice();
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
  var all   = FOOD_LIBRARY.slice();
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
  var ex = document.getElementById('food-ai-loader');
  if (ex) ex.remove();

  var el = document.createElement('div');
  el.id = 'food-ai-loader';
  el.style.cssText = 'position:fixed;inset:0;z-index:200;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(10,18,28,0.82);backdrop-filter:blur(8px)';

  // Orbiting orbs animation — River-coloured
  el.innerHTML =
    '<style>' +
    '@keyframes rv-orbit{from{transform:rotate(0deg) translateX(28px) rotate(0deg)}to{transform:rotate(360deg) translateX(28px) rotate(-360deg)}}' +
    '@keyframes rv-orbit2{from{transform:rotate(120deg) translateX(28px) rotate(-120deg)}to{transform:rotate(480deg) translateX(28px) rotate(-480deg)}}' +
    '@keyframes rv-orbit3{from{transform:rotate(240deg) translateX(28px) rotate(-240deg)}to{transform:rotate(600deg) translateX(28px) rotate(-600deg)}}' +
    '@keyframes rv-orb-pulse{0%,100%{transform:scale(1);opacity:0.9}50%{transform:scale(1.5);opacity:1}}' +
    '@keyframes rv-orb-pulse2{0%,100%{transform:scale(1);opacity:0.8}50%{transform:scale(1.6);opacity:1}}' +
    '@keyframes rv-orb-pulse3{0%,100%{transform:scale(0.9);opacity:0.75}50%{transform:scale(1.4);opacity:1}}' +
    '</style>' +
    '<div style="position:relative;width:64px;height:64px;margin-bottom:20px">' +
      '<div style="position:absolute;inset:0;border-radius:50%;background:radial-gradient(circle,rgba(62,180,120,0.15),transparent);display:flex;align-items:center;justify-content:center">' +
        '<div style="width:12px;height:12px;border-radius:50%;background:rgba(62,180,120,0.5);box-shadow:0 0 10px rgba(62,180,120,0.4)"></div>' +
      '</div>' +
      '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">' +
        '<div style="width:8px;height:8px;border-radius:50%;background:rgba(100,220,200,0.9);box-shadow:0 0 8px rgba(100,220,200,0.6);animation:rv-orbit 1.1s linear infinite">' +
          '<div style="width:100%;height:100%;border-radius:50%;animation:rv-orb-pulse 1.1s ease-in-out infinite"></div>' +
        '</div>' +
      '</div>' +
      '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">' +
        '<div style="width:6px;height:6px;border-radius:50%;background:rgba(200,160,60,0.85);box-shadow:0 0 7px rgba(200,160,60,0.5);animation:rv-orbit2 1.1s linear infinite">' +
          '<div style="width:100%;height:100%;border-radius:50%;animation:rv-orb-pulse2 1.4s ease-in-out infinite 0.3s"></div>' +
        '</div>' +
      '</div>' +
      '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">' +
        '<div style="width:5px;height:5px;border-radius:50%;background:rgba(130,160,230,0.8);box-shadow:0 0 6px rgba(130,160,230,0.5);animation:rv-orbit3 1.1s linear infinite">' +
          '<div style="width:100%;height:100%;border-radius:50%;animation:rv-orb-pulse3 1.2s ease-in-out infinite 0.6s"></div>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div style="font-family:\'DM Mono\',monospace;font-size:13px;color:rgba(180,220,200,0.85);letter-spacing:1px">' + msg + '</div>';

  document.body.appendChild(el);
}

function _hideFoodAIStatus() {
  var el = document.getElementById('food-ai-loader');
  if (el) el.remove();
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

  _showFoodAIStatus('reading photo…');

  try {
    // ── Resize before encoding — prevents iOS OOM on full-res camera images ──
    // Camera photos are often 4–8MB. We cap at 1024px longest side, quality 0.82.
    // Claude Vision reads labels and whole foods fine at this resolution.
    var base64 = await new Promise(function(res, rej) {
      var img = new Image();
      var objectUrl = URL.createObjectURL(file);
      img.onload = function() {
        URL.revokeObjectURL(objectUrl); // free immediately
        var MAX = 1024;
        var w = img.naturalWidth, h = img.naturalHeight;
        if (w > MAX || h > MAX) {
          var scale = MAX / Math.max(w, h);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        var dataUrl = canvas.toDataURL('image/jpeg', 0.82);
        res(dataUrl.split(',')[1]);
      };
      img.onerror = function() { URL.revokeObjectURL(objectUrl); rej(new Error('Image load failed')); };
      img.src = objectUrl;
    });

    var mediaType = 'image/jpeg'; // always jpeg after canvas re-encode
    var r = await fetch('https://orange-surf-6f98.john-king-uk.workers.dev/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 500,
        system: 'You extract nutritional information from food photos. Return ONLY a JSON object, no markdown, no explanation.\n\nFor NUTRITION LABEL photos: read the label directly.\nFor WHOLE FOOD photos (fruit, vegetables, bread, plate of food, etc.): estimate from known nutritional values. Use visual cues (hand for scale, plate size, reference objects) to estimate weight. Set weight_estimated:true.\n\nFields: {"name":"product or food name","c100":carbs_per_100g_as_number,"gi":estimated_gi_as_number,"g_serv":serving_size_grams_as_number_or_null,"sugar":sugars_per_100g_as_number_or_null,"weight_estimated":false,"cat":"bread|cereal|pasta|fruit|vegetable|dairy|protein|snack|hypo|drink|main|custom","note":"brief context e.g. medium apple estimated 140g"}.\n\nUse "Carbohydrate" row for c100 (not sugars). Estimate GI from food type: white bread~75, wholemeal~55, pasta~48, biscuits~70, oats~55, fruit~45, jelly sweets~95, glucose tablets~100, milk~35, potato~78.\n\nIf image is completely unreadable: return {"error":"cannot read"}.',
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: 'Extract nutritional info. If this is a whole food rather than a label, estimate weight from visual cues and use known nutritional values.' }
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

    if (info.error) { showToast('Could not read photo — try again'); return; }
    if (!info.name || !info.c100) { showToast('Could not identify food — try again'); return; }

    // Show compact confirm card (1c) — one tap to save, edit details if wrong
    _showPhotoConfirmCard(info);
  } catch(err) {
    _hideFoodAIStatus();
    console.warn('[photo food] error:', err);
    showToast('Could not read photo — try again');
  }
}

// ── Photo → confirm card (integrated editable form) ──────────────────────────
// Scan results appear as an editable form — weight is the primary decision, c100 secondary.
// Connected to the logging context — not a detached bottom sheet.
function _showPhotoConfirmCard(info) {
  var ex = document.getElementById('photo-confirm-card');
  if (ex) ex.remove();

  var gServ   = info.g_serv || 100;
  var c100    = info.c100;
  var gi      = info.gi || _giFromCategory(info.cat || 'custom', (info.name||'').toLowerCase()).gi;
  var giEst   = info.gi ? '' : ' est.';
  var giCol   = gi >= 70 ? 'rgba(210,80,40,0.85)' : gi >= 55 ? 'rgba(200,140,30,0.85)' : 'rgba(60,160,90,0.85)';

  var card = document.createElement('div');
  card.id = 'photo-confirm-card';
  // Slide up from bottom, attached to the page rather than floating detached
  card.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:95;background:var(--rv-panel-bg);backdrop-filter:blur(16px);border-top:2px solid rgba(62,180,120,0.25);border-radius:16px 16px 0 0;padding:20px 20px 36px;transform:translateY(100%);transition:transform .28s ease';

  var weightEstWarning = info.weight_estimated
    ? '<div style="font-family:\'DM Mono\',monospace;font-size:8px;color:rgba(200,160,60,0.7);margin-bottom:10px;letter-spacing:.3px">⚠ weight estimated from photo — adjust below if needed</div>'
    : '';

  card.innerHTML =
    // Header
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">' +
      '<div style="font-family:monospace;font-size:8px;letter-spacing:1.5px;text-transform:uppercase;color:rgba(62,200,140,0.5)">📷 scanned</div>' +
      '<button onclick="document.getElementById(\'photo-confirm-card\').remove()" style="background:none;border:none;font-size:18px;color:rgba(180,200,220,0.3);cursor:pointer;padding:4px;touch-action:manipulation">✕</button>' +
    '</div>' +

    // Food name — bigger, clearer
    '<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:22px;color:rgba(220,235,250,0.95);margin-bottom:2px">' + info.name + '</div>' +

    // GI + GL side by side, with tooltips — secondary metadata
    '<div style="display:flex;gap:10px;align-items:center;margin-bottom:10px;flex-wrap:nowrap">' +
      '<span style="font-family:\'DM Mono\',monospace;font-size:11px;color:rgba(100,200,160,0.6);cursor:help" title="Carbohydrate content per 100g of this food">' + info.c100 + 'g carbs/100g</span>' +
      '<span style="color:rgba(100,200,160,0.3)">·</span>' +
      '<span style="font-family:\'DM Mono\',monospace;font-size:11px;color:' + giCol + ';cursor:help" title="Glycaemic Index — how fast this food raises blood sugar (0–100). Higher = faster. ' + gi + (giEst ? ' — estimated from food type' : '') + '">GI ' + gi + giEst + '</span>' +
      '<span style="color:rgba(100,200,160,0.3)">·</span>' +
      '<span id="photo-gl-badge" style="font-family:\'DM Mono\',monospace;font-size:11px;color:rgba(200,160,60,0.7);cursor:help" title="Glycaemic Load — GI × carbs in this portion ÷ 100. Tells you the actual blood sugar impact of this serving.">GL —</span>' +
    '</div>' +

    weightEstWarning +

    // Weight — primary input + CTA on same row
    '<div style="display:flex;gap:8px;align-items:flex-end;margin-bottom:8px">' +
      '<div style="flex:1">' +
        '<div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1px;text-transform:uppercase;color:rgba(160,180,200,0.55);margin-bottom:5px">grams to add now</div>' +
        '<input id="photo-confirm-grams" type="number" inputmode="decimal" min="1" max="2000" step="1" value="' + gServ + '"' +
          ' style="width:100%;padding:12px;border-radius:10px;border:2px solid rgba(62,180,120,0.35);background:rgba(62,180,120,0.06);font-family:monospace;font-size:20px;color:rgba(100,220,160,0.95);text-align:center;outline:none;box-sizing:border-box"' +
          ' oninput="_updatePhotoConfirmPreview(' + c100 + ',' + gi + ')" onkeydown="return _numericOnly(event)">' +
        '<div id="photo-confirm-preview" style="font-family:\'DM Mono\',monospace;font-size:11px;color:rgba(100,220,160,0.75);text-align:center;margin-top:4px;min-height:16px;font-weight:500"></div>' +
      '</div>' +
      '<button id="photo-confirm-save" style="flex-shrink:0;padding:12px 16px;border-radius:10px;border:1px solid rgba(62,180,120,0.4);background:rgba(62,180,120,0.12);font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:16px;color:rgba(100,220,160,0.95);cursor:pointer;touch-action:manipulation;white-space:nowrap;height:50px">add to meal</button>' +
    '</div>' +

    // Retake — subdued
    '<button id="photo-confirm-retake" style="width:100%;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.07);background:transparent;font-family:monospace;font-size:9px;color:rgba(140,160,180,0.35);cursor:pointer;touch-action:manipulation">retake photo</button>';

  document.body.appendChild(card);
  requestAnimationFrame(function(){ card.style.transform = 'translateY(0)'; });

  // Run initial preview
  _updatePhotoConfirmPreview(c100, gi);

  // Focus weight field
  setTimeout(function(){
    var g = document.getElementById('photo-confirm-grams');
    if (g) { g.focus(); g.select(); }
  }, 300);

  // Add to meal — save library + add at whatever weight user set
  document.getElementById('photo-confirm-save').onclick = function() {
    var gramsEl = document.getElementById('photo-confirm-grams');
    var grams = parseFloat((gramsEl||{}).value) || gServ;
    card.remove();
    var cat = info.cat || _categoryFromName((info.name||'').toLowerCase());
    var f = {name:info.name, c100:c100, gi:gi, cat:cat, g_serv:grams, g_each:grams};
    var all = FOOD_LIBRARY.slice();
    var existing = all.find(function(x){ return x.name.toLowerCase() === info.name.toLowerCase(); });
    if (!existing) { FOOD_LIBRARY.push(f); saveFoodLibrary(); }
    addFoodItemGrams(info.name, grams);
    showToast('added: ' + info.name);
  };

  // Retake
  document.getElementById('photo-confirm-retake').onclick = function() {
    card.remove();
    var inp = document.getElementById('food-photo-input');
    if (inp) inp.click();
  };
}

function _updatePhotoConfirmPreview(c100, gi) {
  var gramsEl = document.getElementById('photo-confirm-grams');
  var prevEl  = document.getElementById('photo-confirm-preview');
  var glBadge = document.getElementById('photo-gl-badge');
  var grams = parseFloat((gramsEl||{}).value) || 0;
  if (grams > 0 && c100 > 0) {
    var carbs = c100 * grams / 100;
    var gl    = gi * carbs / 100;
    if (prevEl)  prevEl.textContent  = carbs.toFixed(1) + 'g carbs this portion';
    if (glBadge) glBadge.textContent = 'GL ' + gl.toFixed(1);
  } else {
    if (prevEl)  prevEl.textContent  = '';
    if (glBadge) glBadge.textContent = 'GL —';
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
  var all = FOOD_LIBRARY.slice();
  var existing = all.filter(function(f){ return f.name === item.name; })[0];
  if (!existing) {
    var newFood = { name: item.name, c100: item.c100, gi: item.gi || 55, g_serv: item.g_serv || 100 };
    FOOD_LIBRARY.push(newFood);
    saveFoodLibrary();
  }
  // Add to meal
  addFoodItemGrams(item.name, item.g_serv || 100);
}

function addFoodItem(name) {
  var all   = FOOD_LIBRARY.slice();
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

// ── Category auto-detect from food name ──────────────────────────────────
function _categoryFromName(nameLower) {
  if (/bread|toast|wrap|pitta|pita|naan|bagel|baguette|roll|bun|sourdough|rye|seeded/.test(nameLower)) return 'bread';
  if (/cereal|cornflake|weetabix|muesli|granola|bran|cheerio|shreddies/.test(nameLower)) return 'cereal';
  if (/pasta|spaghetti|noodle|macaroni|penne|fusilli|lasagne/.test(nameLower)) return 'pasta';
  if (/rice|risotto|couscous/.test(nameLower)) return 'cereal';
  if (/potato|chips|fries|parsnip|sweet.potato/.test(nameLower)) return 'main';
  if (/oat|porridge/.test(nameLower)) return 'cereal';
  if (/apple|pear|banana|orange|mango|grape|berry|fruit/.test(nameLower)) return 'fruit';
  if (/carrot|broccoli|cauliflower|spinach|kale|courgette|zucchini|pepper|pea|bean|lentil|tomato|cucumber|lettuce|celery|cabbage|leek|onion|garlic|beetroot|asparagus|mushroom|corn|sweetcorn|veggie|vegetable|veg\b/.test(nameLower)) return 'vegetable';
  if (/milk|yoghurt|yogurt|cheese|dairy|cream/.test(nameLower)) return 'dairy';
  if (/chicken|beef|pork|fish|egg|meat|bacon|ham|salmon|tuna/.test(nameLower)) return 'protein';
  if (/biscuit|cookie|cake|chocolate|crisp|quaver|snack|bar/.test(nameLower)) return 'snack';
  if (/jelly|gummy|glucose|dextrose|dextro|lucozade|jelly.bean|jelly.baby|vitamin/.test(nameLower)) return 'hypo';
  if (/juice|drink|squash|cola|fizzy|ribena|smoothie/.test(nameLower)) return 'drink';
  return 'custom';
}

// GI estimate by category — returns {gi, basis} for the estimate label
function _giFromCategory(cat, nameLower) {
  var map = {
    bread:     {gi: 65, basis: 'starchy bread'},
    cereal:    {gi: 70, basis: 'refined grain cereal'},
    pasta:     {gi: 48, basis: 'pasta (slow starch)'},
    fruit:     {gi: 45, basis: 'typical fruit'},
    vegetable: {gi: 20, basis: 'non-starchy vegetable'},
    protein:   {gi: 15, basis: 'protein — minimal carbs'},
    dairy:     {gi: 35, basis: 'dairy'},
    snack:     {gi: 72, basis: 'processed snack'},
    hypo:      {gi: 95, basis: 'fast sugar — hypo treatment'},
    drink:     {gi: 65, basis: 'sugary drink'},
    main:      {gi: 60, basis: 'mixed meal'},
    custom:    {gi: 55, basis: 'estimate — confirm if known'},
  };
  // Override for known specific foods
  if (/oat|porridge/.test(nameLower))       return {gi: 55, basis: 'oats (slow release)'};
  if (/jelly.bab|jelly.bean|glucose|dextrose|lucozade/.test(nameLower)) return {gi: 95, basis: 'pure fast sugar'};
  if (/sweet.potato/.test(nameLower))        return {gi: 44, basis: 'sweet potato (lower GI)'};
  if (/basmati/.test(nameLower))             return {gi: 58, basis: 'basmati (lower than white rice)'};
  if (/sourdough|rye/.test(nameLower))       return {gi: 55, basis: 'fermented/wholegrain bread'};
  if (/white.*bread|baguette|naan/.test(nameLower)) return {gi: 75, basis: 'white bread (refined)'};
  return map[cat] || map.custom;
}

function addCustomFood(name) {
  var ex = document.getElementById('food-add-overlay');
  if (ex) ex.remove();
  _addFoodMode = 'per100';

  var lname = name.toLowerCase();
  // Auto-detect category and derive initial GI estimate from it
  var autoCat   = _categoryFromName(lname);
  var giEst     = _giFromCategory(autoCat, lname);
  var initGI    = giEst.gi;

  var el = document.createElement('div');
  el.id = 'food-add-overlay';
  el.style.cssText = 'position:fixed;inset:0;z-index:600;background:var(--rv-panel-bg);backdrop-filter:blur(14px);display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:24px 24px 40px;transition:opacity .2s;opacity:0;overflow-y:auto;-webkit-overflow-scrolling:touch';

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

  // ── Header row: title + close ────────────────────────────────────
  var headerRow = document.createElement('div');
  headerRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px';
  var titleEl = document.createElement('div');
  titleEl.style.cssText = "font-family:Fraunces,serif;font-style:italic;font-weight:200;font-size:14px;color:rgba(180,220,200,0.5)";
  titleEl.textContent = 'add food';
  var closeBtn2 = document.createElement('button');
  closeBtn2.style.cssText = 'background:none;border:none;cursor:pointer;font-size:22px;color:rgba(180,200,220,0.4);padding:0;line-height:1;touch-action:manipulation';
  closeBtn2.textContent = '×';
  closeBtn2.onclick = function() { window._foodAddCallback = null; el.remove(); };
  headerRow.appendChild(titleEl);
  headerRow.appendChild(closeBtn2);
  wrap.appendChild(headerRow);

  // ── Food name — large, prominent, editable ───────────────────────
  var nameInpEl = document.createElement('input');
  nameInpEl.id = 'new-food-name';
  nameInpEl.type = 'text';
  nameInpEl.value = name;
  nameInpEl.autocomplete = 'off';
  nameInpEl.style.cssText = "width:100%;padding:10px 0;border:none;border-bottom:1px solid rgba(62,180,120,0.3);background:transparent;font-family:Fraunces,serif;font-style:italic;font-weight:300;font-size:26px;color:rgba(220,240,230,0.95);outline:none;box-sizing:border-box;margin-bottom:18px";
  wrap.appendChild(nameInpEl);

  // ── Camera — first action ────────────────────────────────────────
  var camBtn = document.createElement('button');
  camBtn.style.cssText = 'width:100%;margin-bottom:16px;padding:10px;border-radius:9px;border:1px solid rgba(62,180,120,0.2);background:rgba(62,180,120,0.06);font-family:monospace;font-size:10px;color:rgba(100,220,160,0.6);cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;touch-action:manipulation';
  camBtn.innerHTML = '📷 <span>scan nutrition label or food</span>';
  camBtn.onclick = function() { el.remove(); openPhotoFood(); };
  wrap.appendChild(camBtn);

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
  var btnDirect = makeToggleBtn('just the carbs', 'direct');
  toggleWrap.appendChild(btn100);
  toggleWrap.appendChild(btnServ);
  toggleWrap.appendChild(btnDirect);
  wrap.appendChild(toggleWrap);

  function updateToggleState() {
    var is100    = _addFoodMode === 'per100';
    var isServ   = _addFoodMode === 'perServing';
    var isDirect = _addFoodMode === 'direct';
    btn100.style.background    = is100    ? 'rgba(62,180,120,0.18)' : 'transparent';
    btn100.style.color         = is100    ? 'rgba(100,220,160,0.95)' : 'rgba(180,200,220,0.45)';
    btnServ.style.background   = isServ   ? 'rgba(62,180,120,0.18)' : 'transparent';
    btnServ.style.color        = isServ   ? 'rgba(100,220,160,0.95)' : 'rgba(180,200,220,0.45)';
    btnDirect.style.background = isDirect ? 'rgba(62,180,120,0.18)' : 'transparent';
    btnDirect.style.color      = isDirect ? 'rgba(100,220,160,0.95)' : 'rgba(180,200,220,0.45)';
    var c100Row    = document.getElementById('new-food-c100-row');
    var cServRow   = document.getElementById('new-food-cserv-row');
    var cDirectRow = document.getElementById('new-food-cdirect-row');
    if (c100Row)    c100Row.style.display    = is100    ? '' : 'none';
    if (cServRow)   cServRow.style.display   = isServ   ? '' : 'none';
    if (cDirectRow) cDirectRow.style.display = isDirect ? '' : 'none';
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

  // Direct carbs input — "I just know this portion has Xg carbs"
  var cDirectRow = document.createElement('div');
  cDirectRow.id = 'new-food-cdirect-row';
  cDirectRow.style.cssText = 'margin-bottom:14px;display:none';
  cDirectRow.appendChild(lbl('carbs in this portion (g)', '· e.g. 35g for a pizza slice'));
  var cDirectInp = inp('new-food-cdirect', 'number', 'e.g. 35', 0, 500, '0.1', null, 'border-color:rgba(62,180,120,0.5);color:rgba(100,220,160,0.95);background:rgba(62,180,120,0.08)');
  cDirectRow.appendChild(cDirectInp);
  var cDirectNote = document.createElement('div');
  cDirectNote.style.cssText = 'font-family:monospace;font-size:8px;color:rgba(62,180,120,0.4);margin-top:4px';
  cDirectNote.textContent = 'stored as-is — enter portion weight below if you know it';
  cDirectRow.appendChild(cDirectNote);
  wrap.appendChild(cDirectRow);
  var servRow = document.createElement('div');
  servRow.style.cssText = 'margin-bottom:14px';
  servRow.appendChild(lbl('typical serving', '· weighed portion (g)'));
  servRow.appendChild(inp('new-food-g_serv', 'number', 'e.g. 75', 0, 2000, '1', null, ''));
  wrap.appendChild(servRow);
  // Hidden g_each — keep for compatibility, not shown
  var gEachHidden = document.createElement('input');
  gEachHidden.type = 'hidden'; gEachHidden.id = 'new-food-g_each'; gEachHidden.value = '';
  wrap.appendChild(gEachHidden);

  // ── Category — themed segmented chips ───────────────────────────
  var catRow = document.createElement('div');
  catRow.style.cssText = 'margin-bottom:16px';
  catRow.appendChild(lbl('category'));
  var catCats = ['bread','cereal','pasta','fruit','vegetable','dairy','protein','snack','hypo','drink','main','custom'];
  var _selCat = autoCat;
  var catChips = document.createElement('div');
  catChips.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px';
  catCats.forEach(function(c) {
    var chip = document.createElement('button');
    chip.id = 'catbtn-' + c;
    chip.textContent = c;
    chip.style.cssText = 'padding:5px 10px;border-radius:20px;border:1px solid rgba(255,255,255,0.12);background:transparent;font-family:monospace;font-size:9px;color:rgba(160,180,200,0.5);cursor:pointer;touch-action:manipulation;transition:all .12s';
    chip.onclick = function() {
      _selCat = c;
      catCats.forEach(function(x) {
        var b = document.getElementById('catbtn-' + x);
        if (!b) return;
        var active = x === c;
        b.style.background = active ? 'rgba(62,180,120,0.18)' : 'transparent';
        b.style.color      = active ? 'rgba(100,220,160,0.9)' : 'rgba(160,180,200,0.5)';
        b.style.borderColor= active ? 'rgba(62,180,120,0.4)'  : 'rgba(255,255,255,0.12)';
      });
      // Update hidden input for updateAddFoodPreview compatibility
      var hidCat = document.getElementById('new-food-cat');
      if (hidCat) hidCat.value = c;
      var badge = document.getElementById('new-food-gi-badge');
      if (badge && !badge.textContent.startsWith('AI')) {
        var newEst = _giFromCategory(c, lname);
        var giEl = document.getElementById('new-food-gi');
        if (giEl) giEl.value = newEst.gi;
        badge.textContent = '~' + newEst.gi + ' est. — ' + newEst.basis;
      }
      updateAddFoodPreview();
    };
    if (c === autoCat) {
      chip.style.background  = 'rgba(62,180,120,0.18)';
      chip.style.color       = 'rgba(100,220,160,0.9)';
      chip.style.borderColor = 'rgba(62,180,120,0.4)';
    }
    catChips.appendChild(chip);
  });
  catRow.appendChild(catChips);
  // Hidden input keeps compatibility with updateAddFoodPreview which reads #new-food-cat
  var catHidden = document.createElement('input');
  catHidden.type = 'hidden'; catHidden.id = 'new-food-cat'; catHidden.value = autoCat;
  catRow.appendChild(catHidden);
  wrap.appendChild(catRow);

  // ── GI — always visible, auto-estimated, confirmable ────────────
  var giSection = document.createElement('div');
  giSection.style.cssText = 'margin-bottom:6px';

  var giHeader = document.createElement('div');
  giHeader.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px';

  var giLblEl = document.createElement('div');
  giLblEl.style.cssText = 'font-family:monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase;color:var(--rv-text-secondary);cursor:help';
  giLblEl.textContent = 'glycaemic index';
  giLblEl.title = 'Glycaemic Index — how fast this food raises blood sugar relative to pure glucose (100). Low: <55, Medium: 55–70, High: >70.';
  giHeader.appendChild(giLblEl);

  var giCalcBadge = document.createElement('div');
  giCalcBadge.id = 'new-food-gi-badge';
  giCalcBadge.style.cssText = 'font-family:monospace;font-size:8px;color:rgba(200,160,60,0.65);letter-spacing:0.3px;max-width:170px;text-align:right;line-height:1.3';
  giCalcBadge.textContent = '~' + initGI + ' est. — ' + giEst.basis;
  giHeader.appendChild(giCalcBadge);

  giSection.appendChild(giHeader);

  var giInp = inp('new-food-gi', 'number', '0–100', 0, 100, '1', initGI,
    'border-color:rgba(200,160,60,0.5);color:rgba(220,180,80,0.95);background:rgba(200,160,60,0.07)');
  // When user edits GI directly — mark as user-confirmed
  giInp.addEventListener('input', function() {
    var badge = document.getElementById('new-food-gi-badge');
    if (badge) { badge.textContent = 'confirmed'; badge.style.color = 'rgba(62,200,140,0.8)'; }
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
  curveWrap.style.cssText = 'margin-bottom:10px;border-radius:8px;border:1px solid var(--rv-panel-border);background:rgba(255,255,255,0.02);padding:10px 12px';
  var curveCanvas = document.createElement('canvas');
  curveCanvas.id = 'new-food-curve';
  curveCanvas.width = 276;
  curveCanvas.height = 44;
  curveCanvas.style.cssText = 'width:100%;height:44px;display:block';
  curveWrap.appendChild(curveCanvas);
  wrap.appendChild(curveWrap);

  // ── Carbs per serving + GL — always visible, live-calculated ────
  var calcRow = document.createElement('div');
  calcRow.id = 'new-food-calc-row';
  calcRow.style.cssText = 'display:flex;gap:10px;margin-bottom:16px;padding:10px 12px;border-radius:8px;border:1px solid rgba(62,180,120,0.15);background:rgba(62,180,120,0.04)';
  var calcC = document.createElement('div'); calcC.style.flex = '1';
  var calcCLbl = document.createElement('div');
  calcCLbl.style.cssText = 'font-family:monospace;font-size:7px;letter-spacing:1px;text-transform:uppercase;color:rgba(100,200,160,0.5);margin-bottom:3px';
  calcCLbl.textContent = 'carbs / serving';
  var calcCVal = document.createElement('div');
  calcCVal.id = 'new-food-carbs-serv';
  calcCVal.style.cssText = 'font-family:monospace;font-size:18px;color:rgba(100,220,160,0.9)';
  calcCVal.textContent = '—';
  calcC.appendChild(calcCLbl); calcC.appendChild(calcCVal);
  var calcGL = document.createElement('div'); calcGL.style.flex = '1';
  var calcGLLbl = document.createElement('div');
  calcGLLbl.style.cssText = 'font-family:monospace;font-size:7px;letter-spacing:1px;text-transform:uppercase;color:rgba(200,160,60,0.5);margin-bottom:3px;cursor:help';
  calcGLLbl.textContent = 'GL / serving';
  calcGLLbl.title = 'Glycaemic Load = GI × carbs in this serving ÷ 100. Under 10 = low impact, 10–20 = medium, 20+ = high. More useful than GI alone — accounts for portion size.';
  var calcGLVal = document.createElement('div');
  calcGLVal.id = 'new-food-gl-serv';
  calcGLVal.style.cssText = 'font-family:monospace;font-size:18px;color:rgba(220,180,80,0.9)';
  calcGLVal.textContent = '—';
  calcGL.appendChild(calcGLLbl); calcGL.appendChild(calcGLVal);
  calcRow.appendChild(calcC); calcRow.appendChild(calcGL);
  wrap.appendChild(calcRow);

  // Buttons
  var btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px';

  var saveBtn = document.createElement('button');
  saveBtn.style.cssText = "flex:1;padding:13px;border-radius:10px;border:1px solid rgba(62,180,120,0.4);background:rgba(62,180,120,0.12);font-family:Fraunces,serif;font-style:italic;font-weight:200;font-size:17px;color:rgba(100,220,160,0.95);cursor:pointer";
  saveBtn.textContent = 'save + add';
  saveBtn.onclick = function() {
    var mode    = _addFoodMode || 'per100';
    var cat     = (document.getElementById('new-food-cat')||{}).value || 'custom';
    var c100val = parseFloat((document.getElementById('new-food-c100')||{}).value);
    var cServVal   = parseFloat((document.getElementById('new-food-cserv')||{}).value);
    var cDirectVal = parseFloat((document.getElementById('new-food-cdirect')||{}).value);
    // At least one carb value must be present (unless protein category)
    var hasCarbs = (c100val > 0) || (cServVal > 0) || (cDirectVal > 0);
    if (!hasCarbs && cat !== 'protein') {
      var focusEl = mode === 'direct' ? document.getElementById('new-food-cdirect')
                  : mode === 'perServing' ? document.getElementById('new-food-cserv')
                  : document.getElementById('new-food-c100');
      if (focusEl) { focusEl.style.borderColor='rgba(220,80,60,0.7)'; setTimeout(function(){ focusEl.style.borderColor='rgba(62,180,120,0.5)'; },1500); }
      if (typeof showToast === 'function') showToast('enter the carbs first');
      return;
    }
    var nameEl = document.getElementById('new-food-name');
    var finalName = nameEl ? nameEl.value.trim() : name;
    if (!finalName) { if (typeof showToast === 'function') showToast('enter a food name'); return; }
    saveCustomFood(encodeURIComponent(finalName));
  };

  var cancelBtn = document.createElement('button');
  cancelBtn.style.cssText = 'padding:13px 16px;border-radius:10px;border:1px solid rgba(255,255,255,0.15);background:transparent;font-family:monospace;font-size:10px;color:rgba(255,255,255,0.5);cursor:pointer';
  cancelBtn.textContent = 'cancel';
  cancelBtn.onclick = function() { window._foodAddCallback = null; el.remove(); };

  btnRow.appendChild(saveBtn);
  btnRow.appendChild(cancelBtn);
  wrap.appendChild(btnRow);

  el.appendChild(wrap);
  el.addEventListener('keydown', function(e){ if(e.key==='Escape') { window._foodAddCallback = null; el.remove(); } });
  document.body.appendChild(el);
  requestAnimationFrame(function(){ el.style.opacity='1'; });

  // Fire Claude GI lookup immediately — fills GI field async without blocking
  suggestGI(name, document.getElementById('new-food-gi'));

  // Pre-fill from photo data if available
  if (_photoFoodData) {
    var pfd = _photoFoodData;
    _photoFoodData = null;
    setTimeout(function() {
      if (pfd.c100 !== undefined) { var c100el = document.getElementById('new-food-c100'); if (c100el) c100el.value = pfd.c100; }
      if (pfd.gi) {
        var giel = document.getElementById('new-food-gi');
        if (giel) { giel.value = pfd.gi; }
        var badge = document.getElementById('new-food-gi-badge');
        if (badge) { badge.textContent = '~' + pfd.gi + ' from label'; badge.style.color = 'rgba(62,200,140,0.8)'; }
      }
      if (pfd.g_serv) { var gsel = document.getElementById('new-food-g_serv'); if (gsel) gsel.value = pfd.g_serv; }
      if (pfd.cat)    { var csel = document.getElementById('new-food-cat');   if (csel) csel.value = pfd.cat; }
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

  // Resolve c100 from whichever mode is active
  var c100;
  if (mode === 'per100') {
    c100 = parseFloat((document.getElementById('new-food-c100')||{}).value)||0;
    var cServEl = document.getElementById('new-food-cserv');
    if (cServEl) cServEl.value = (gServ > 0 && c100 > 0) ? (c100 * gServ / 100).toFixed(1) : '';
  } else if (mode === 'perServing') {
    var cServ = parseFloat((document.getElementById('new-food-cserv')||{}).value)||0;
    // Compute c100 only if we have a weight; otherwise use cServ as a nominal c100
    c100 = (gServ > 0 && cServ > 0) ? (cServ / gServ * 100) : cServ;
    var c100El = document.getElementById('new-food-c100');
    if (c100El && gServ > 0) c100El.value = c100 > 0 ? c100.toFixed(1) : '';
  } else {
    // direct mode — user entered carbs for a known portion
    var cDirect = parseFloat((document.getElementById('new-food-cdirect')||{}).value)||0;
    // Use cDirect as c100 proxy (will be overridden if gServ is known)
    c100 = (gServ > 0 && cDirect > 0) ? (cDirect / gServ * 100) : cDirect;
    var c100ElD = document.getElementById('new-food-c100');
    if (c100ElD && gServ > 0) c100ElD.value = c100 > 0 ? c100.toFixed(1) : '';
  }

  // ── GI: re-estimate from category + c100 unless user has confirmed manually ──
  var giInpEl  = document.getElementById('new-food-gi');
  var badge    = document.getElementById('new-food-gi-badge');
  var isLocked = badge && badge.textContent === 'confirmed';
  var gi;

  if (!isLocked && giInpEl) {
    // Re-derive from current category selection
    var catEl  = document.getElementById('new-food-cat');
    var cat    = catEl ? catEl.value : 'custom';
    var overlay = document.getElementById('food-add-overlay');
    var nameSub = overlay ? ((overlay.querySelector('#new-food-name')||overlay.querySelector('.food-name-sub')||{}).value||(overlay.querySelector('#new-food-name')||overlay.querySelector('.food-name-sub')||{}).textContent||'') : '';
    var est    = _giFromCategory(cat, nameSub.toLowerCase());

    // Nudge GI by c100 density: very low carb (<5) → protein/fat, very high (>75) → likely refined
    var adjustedGI = est.gi;
    var basis      = est.basis;
    if (c100 > 0 && c100 < 5)  { adjustedGI = Math.min(adjustedGI, 20); basis = 'very low carb — minimal impact'; }
    if (c100 >= 75)             { adjustedGI = Math.max(adjustedGI, 65); basis = 'high carb density — likely refined'; }

    giInpEl.value = adjustedGI;
    gi = adjustedGI;
    if (badge) {
      badge.textContent = '~' + adjustedGI + ' est. — ' + basis;
      badge.style.color = 'rgba(200,160,60,0.65)';
    }
  } else {
    gi = parseInt((giInpEl||{}).value) || 0;
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

  // ── Carbs per serving + GL ─────────────────────────────────────
  var carbsServEl = document.getElementById('new-food-carbs-serv');
  var glServEl    = document.getElementById('new-food-gl-serv');
  if (carbsServEl) {
    if (c100 > 0 && gServ > 0) {
      var carbsServ = c100 * gServ / 100;
      var gl = gi * carbsServ / 100;
      carbsServEl.textContent = carbsServ.toFixed(1) + 'g';
      if (glServEl) glServEl.textContent = gl.toFixed(1);
    } else {
      carbsServEl.textContent = '—';
      if (glServEl) glServEl.textContent = '—';
    }
  }
}

function saveCustomFood(encodedName) {
  var name  = decodeURIComponent(encodedName);
  var mode  = _addFoodMode || 'per100';
  var gi    = parseInt((document.getElementById('new-food-gi')||{}).value) || 0;
  var gServ = parseFloat((document.getElementById('new-food-g_serv')||{}).value) || null;
  var cat   = (document.getElementById('new-food-cat')||{}).value || 'custom';

  // Resolve c100 from whichever mode was active
  var carbs;
  if (mode === 'per100') {
    carbs = parseFloat((document.getElementById('new-food-c100')||{}).value) || 0;
  } else if (mode === 'perServing') {
    var cServ = parseFloat((document.getElementById('new-food-cserv')||{}).value) || 0;
    carbs = (gServ && gServ > 0 && cServ > 0) ? Math.round(cServ / gServ * 1000) / 10 : cServ;
    if (!gServ && cServ > 0) gServ = null; // no weight known
  } else {
    // direct mode — carbs for one portion; store as c100 (best we can do without weight)
    var cDirect = parseFloat((document.getElementById('new-food-cdirect')||{}).value) || 0;
    carbs = (gServ && gServ > 0 && cDirect > 0) ? Math.round(cDirect / gServ * 1000) / 10 : cDirect;
    if (!gServ && cDirect > 0) gServ = null;
  }

  var el = document.getElementById('food-add-overlay');
  if (el) el.remove();
  var f = {name:name, c100:carbs, gi:gi, cat:cat};
  if (gServ) { f.g_serv = gServ; f.g_each = gServ; }

  // Save to library
  var lname = name.toLowerCase();
  if (!FOOD_LIBRARY.some(function(x){ return x.name.toLowerCase() === lname; })) {
    FOOD_LIBRARY.push(f);
    saveFoodLibrary();
  }

  // ── Caller callbacks — checked in priority order ──────────────────
  // 1. Backfill callback (set by backfill.js before calling addCustomFood)
  if (typeof window._foodAddCallback === 'function') {
    var cb = window._foodAddCallback;
    window._foodAddCallback = null;
    cb(f);
    return;
  }
  // 2. Pad import callback
  if (typeof window._padAddCallback === 'function') {
    var pcb = window._padAddCallback;
    window._padAddCallback = null;
    pcb(f);
    // Re-open pad import overlay (it was obscured by food-add-overlay)
    var padOverlay = document.getElementById('pad-import-overlay');
    if (padOverlay) padOverlay.style.display = '';
    return;
  }
  // 3. Default: add directly to the current meal plate
  addFoodItem(name);
}
// Export so backfill.js (loaded separately) can call it
window.addCustomFood = addCustomFood;

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
    var all  = FOOD_LIBRARY.slice();
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

  // Log insulin at bolus time — computed/pushed BEFORE carbT so that, when
  // eatWaitNow===0, _safeEventT(carbT) sees this event already in
  // LOGGED_EVENTS and bumps carbT by 1ms. Without this, a bolus+carbs logged
  // with zero wait both resolve to the same t, and the on_conflict=t upsert
  // silently merges/overwrites one event's events row with the other's.
  if (u > 0) {
    var bolusT = _safeEventT(t);
    SESSION.push({t: bolusT, c: 0, u: u});
    LOGGED_EVENTS.push({t: bolusT, c: 0, u: u, note: 'bolus', insulin_type: _currentSelectedInsulin(), local: true});
    // Snapshot IOB prediction curve for outcome tracking — this path never
    // wrote a bolus_outcomes baseline at all (same gap as logCorrection;
    // distinct from the fire-and-forget race already fixed in bolusNow()).
    (function() {
      try {
        var mealBolusInsType = _currentSelectedInsulin();
        var mealBolusEv = {t: bolusT, u: u, insulin_type: mealBolusInsType, logged_by: _thisPersonId||'unknown'};
        var iobCurve = [];
        var d0 = dataAt(bolusT);
        var ISF = _currentTherapySnapshot(bolusT);
        var isf = ISF ? ISF.isf : 6.5;
        var insProfile = _getInsulinProfile(mealBolusInsType);
        for (var m = 5; m <= 240; m += 5) {
          var predBG = d0 ? Math.max(1.8, d0.bg - u * (1 - _iobFn(m, insProfile.diaMins, insProfile.peakMins)) * isf) : 0;
          iobCurve.push({mins: m, bg: +predBG.toFixed(2)});
        }
        _createBolusOutcomeBaselineWithRetry(mealBolusEv, iobCurve);
      } catch (diagErr) {
        console.warn('[bolusOutcomeBaseline] logMealEntry IIFE setup threw:', diagErr);
      }
    })();
  }

  var carbT = _safeEventT(t + eatWaitNow * 60000); // when carbs enter the system

  // Log carbs at eat time — include per-food breakdown for GI-aware rendering
  var foodItems = _mealItems.map(function(i){
    return {name:i.food.name, carbs:i.carbs, gi:i.food.gi||55, g:i.grams};
  });
  if (totalCarbs > 0) {
    SESSION.push({t: carbT, c: totalCarbs, u: 0, gi: avgGI, items: foodItems});
    LOGGED_EVENTS.push({t: carbT, c: totalCarbs, u: 0, gi: avgGI, items: foodItems, note: 'carbs', logged_by: _thisPersonId||'unknown', local: true,
      therapy_snapshot: _currentTherapySnapshot(carbT),
      pre_bg: _preBG(carbT)});
  }

  // Bolus-with-carbs: classify any rounding/override vs the suggested dose
  if (u > 0 && totalCarbs > 0) {
    var _suggested = calcBolus(totalCarbs, dataAt(bolusT).bg, bolusT).total;
    _storeBolusOverride(bolusT, _suggested, u);
  }

  try{localStorage.setItem('river_logged',JSON.stringify(LOGGED_EVENTS));}catch(err){}

  try { localStorage.setItem('river_session',JSON.stringify(SESSION)); } catch(e) {}

  // Wall clock is master — no need to extend HISTORY_RAW for future events

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
    (function(){
      var _snap = buildSmartForecast(MEAL_HISTORY[0] ? MEAL_HISTORY[0].t : (CGM_END || Date.now()));
      if (MEAL_HISTORY[0]) MEAL_HISTORY[0]._predictedCurve = _snap;
      _pushActivePredictedCurve(_snap, Date.now());
      syncMealToSupabase(MEAL_HISTORY[0]);
    })();
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
    (function(){
      var _snap = buildSmartForecast(MEAL_HISTORY[0] ? MEAL_HISTORY[0].t : (CGM_END || Date.now()));
      if (MEAL_HISTORY[0]) MEAL_HISTORY[0]._predictedCurve = _snap;
      _pushActivePredictedCurve(_snap, Date.now());
      syncMealToSupabase(MEAL_HISTORY[0]);
    })();
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
  var manualInsType = _currentSelectedInsulin();
  SESSION.push({t: t, c: 0, u: u, insulin_type: manualInsType});
  try { localStorage.setItem('river_session',JSON.stringify(SESSION)); } catch(e) {}
  // Snapshot IOB prediction curve for outcome tracking — this path never
  // wrote a bolus_outcomes baseline at all (same gap as logCorrection and
  // logMealEntry; distinct from the fire-and-forget race fixed in bolusNow()).
  (function() {
    try {
      var manualEv = {t: t, u: u, insulin_type: manualInsType, logged_by: _thisPersonId||'unknown'};
      var iobCurve = [];
      var d0 = dataAt(t);
      var ISF = _currentTherapySnapshot(t);
      var isf = ISF ? ISF.isf : 6.5;
      var insProfile = _getInsulinProfile(manualInsType);
      for (var m = 5; m <= 240; m += 5) {
        var predBG = d0 ? Math.max(1.8, d0.bg - u * (1 - _iobFn(m, insProfile.diaMins, insProfile.peakMins)) * isf) : 0;
        iobCurve.push({mins: m, bg: +predBG.toFixed(2)});
      }
      _createBolusOutcomeBaselineWithRetry(manualEv, iobCurve);
    } catch (diagErr) {
      console.warn('[bolusOutcomeBaseline] commitManualBolus IIFE setup threw:', diagErr);
    }
  })();
  _snapshotPrediction();
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

  // ── NEW BREAKFAST SCENARIOS ──────────────────────────────────────────
  {
    id: 'happy_state',
    name: 'Happy state',
    desc: 'Ticking along at 5.5. Forces balanced. Nothing to act on.',
    emoji: '\u223c',
    bgColor: 'rgba(30,110,70,0.7)',
  },
  {
    id: 'breakfast_too_early',
    name: 'Bolus too early',
    desc: 'Porridge bolused 10min pre-food. Insulin peaks before carbs arrive. Now is 11:45.',
    emoji: '\u21d3\u21d1',
    bgColor: 'rgba(80,40,140,0.7)',
  },
  {
    id: 'breakfast_too_late',
    name: 'Bolus too late',
    desc: 'Porridge bolused 30min post-food. Carbs peak before insulin. Now is 11:45.',
    emoji: '\u21d1\u21d1',
    bgColor: 'rgba(180,60,30,0.7)',
  },
  {
    id: 'breakfast_goldilocks',
    name: 'Goldilocks bolus',
    desc: 'Porridge bolused 20min pre-food. Carbs and insulin arrive together. Now is 11:45.',
    emoji: '\u2714',
    bgColor: 'rgba(30,120,80,0.7)',
  },
  {
    id: 'running_high',
    name: 'Running high',
    desc: 'Stuck at 14+ for 90min. IOB cleared. Correction given 15min ago.',
    emoji: '\u25b2',
    bgColor: 'rgba(160,80,20,0.7)',
  },
  {
    id: 'pre_hypo_snack',
    name: 'Pre-hypo snack',
    desc: 'Dropping to 4.2 with active IOB. 2 jelly babies. Gentle recovery, no rebound.',
    emoji: '\u21d3',
    bgColor: 'rgba(50,90,200,0.7)',
  },
  {
    id: 'active_hypo',
    name: 'Active hypo',
    desc: 'At 3.2. Glucose tabs just logged. COB lifting. Recovery underway.',
    emoji: '\u26a1',
    bgColor: 'rgba(30,50,180,0.7)',
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

    // ── NEW SCENARIOS ────────────────────────────────────────────────────

    case 'happy_state': {
      // Gentle cruise at 5.5, small sine variations. 4h window. No active forces.
      // A small snack 3h ago, fully resolved. Just the zen.
      for (let m=240; m>=0; m-=5) {
        const wave = Math.sin(m*0.07)*0.4 + Math.sin(m*0.19)*0.15;
        const bg   = 5.5 + wave;
        pushPt(m, parseFloat(bg.toFixed(1)), 0, 0);
      }
      break;
    }

    case 'breakfast_too_early': {
      // now = 11:45. Breakfast at 7:15 with 10min pre-bolus (too early).
      // Overnight: 8.0 dropping gently to 5.5 by 7:00, dawn nudges to 5.8.
      // Bolus at 7:05 (270min ago). Food at 7:15 (260min ago).
      // Insulin peaks before carbs — BG dips to ~4.0 at ~40min post-bolus,
      // then carbs arrive late and overshoot to ~12. Settles by 10:30.
      // now = 11:45 so 4.5h of history
      const nowMins = 270; // 4.5h = 270min
      for (let m = nowMins; m >= 0; m -= 5) {
        let bg, iob, cob;
        // Overnight descent 8→5.5 over first 60min, then dawn creep
        if (m > nowMins - 60) {
          const t = nowMins - m; // mins from start
          bg  = 8.0 - t * 0.042 + Math.sin(t*0.08)*0.2;
          iob = 0; cob = 0;
        } else if (m > nowMins - 60 && m <= nowMins) {
          bg = 5.5; iob = 0; cob = 0;
        } else {
          // m relative to bolus time (bolus = 270min ago => m=270 is bolus time)
          const sinceFood   = nowMins - 10 - m;  // mins since food (food = 260min ago)
          const sinceBolus  = nowMins - m;        // mins since bolus (bolus = 270min ago)
          if (sinceBolus < 0) {
            bg = 5.8; iob = 0; cob = 0;
          } else {
            // IOB: peaks fast, decays over 4h
            iob = sinceBolus < 240 ? 3.0 * Math.exp(-sinceBolus / 85) : 0;
            // COB: porridge medium GI, peaks ~45min after eating
            const sf = Math.max(0, sinceFood);
            cob = sf < 240 ? 38 * (sf/45) * Math.exp(-(sf-45)/55) * (sf>0?1:0) : 0;
            cob = Math.max(0, cob);
            // BG: insulin hits first (dip), then carbs rescue but overshoot
            const preFood  = 5.8 - Math.min(sinceBolus, 40) * 0.048; // insulin dip
            const dip      = Math.max(3.8, preFood);
            const carbLift = sf > 0 ? Math.min(sf/45, 1) * 7.5 * Math.exp(-(sf-45)/70) : 0;
            bg = dip + Math.max(0, carbLift);
            // Overshoot peak ~12, settled by 3h post-food
            if (sf > 180) bg = Math.max(5.0, 12 - (sf-180)*0.035);
            bg = Math.max(3.8, Math.min(13, bg));
          }
        }
        pushPt(m, parseFloat(bg.toFixed(1)), parseFloat(Math.max(0,iob).toFixed(2)), parseFloat(Math.max(0,cob).toFixed(1)));
      }
      pushBolus(270, 0, 3.0);     // bolus
      pushBolus(260, 38, 0);      // porridge carbs
      break;
    }

    case 'breakfast_too_late': {
      // now = 11:45. Breakfast at 7:15, bolus at 7:45 (30min post-food, too late).
      // Carbs absorb unchecked for 30min — BG rockets to 14+ before insulin catches up.
      // Settles but still elevated at 11:45.
      const nowMins = 270;
      for (let m = nowMins; m >= 0; m -= 5) {
        let bg, iob, cob;
        if (m > 260) {
          // Pre-breakfast: overnight 8→5.5
          const t = nowMins - m;
          bg  = 8.0 - t * 0.047;
          bg  = Math.max(5.5, bg);
          iob = 0; cob = 0;
        } else {
          const sinceFood   = 260 - m;  // food 260min ago
          const sinceBolus  = Math.max(0, 230 - m); // bolus 230min ago (30min after food)
          iob = sinceBolus > 0 ? 3.0 * Math.max(0, Math.exp(-sinceBolus/85)) : 0;
          const sf = Math.max(0, sinceFood);
          cob = sf < 240 ? Math.max(0, 38 * (sf/40) * Math.exp(-(sf-40)/50)) : 0;
          // Carbs absorb freely for 30min — steep rocket
          if (sf < 30) {
            bg = 5.5 + sf * 0.28; // fast rise unchecked
          } else if (sf < 90) {
            bg = 5.5 + 30*0.28 + (sf-30)*0.1; // continues rising, insulin just starting
          } else {
            bg = 5.5 + 30*0.28 + 60*0.1 - (sf-90)*0.06;
          }
          bg = Math.max(6.5, Math.min(15.5, bg));
          // Elevated plateau by 11:45
          if (sf > 230) bg = Math.max(7.5, bg);
        }
        pushPt(m, parseFloat(bg.toFixed(1)), parseFloat(Math.max(0,iob).toFixed(2)), parseFloat(Math.max(0,cob).toFixed(1)));
      }
      pushBolus(230, 0, 3.0);    // bolus 30min after food
      pushBolus(260, 38, 0);     // porridge carbs
      break;
    }

    case 'breakfast_goldilocks': {
      // now = 11:45. Breakfast 7:15 with 20min pre-bolus (just right).
      // Insulin and carbs arrive together — BG rises to 8.5, clean return to range.
      const nowMins = 270;
      for (let m = nowMins; m >= 0; m -= 5) {
        let bg, iob, cob;
        if (m > 250) {
          const t = nowMins - m;
          bg = 8.0 - t * 0.047;
          bg = Math.max(5.5, bg);
          iob = 0; cob = 0;
        } else {
          const sinceBolus = 250 - m;  // bolus 250min ago (20min pre-food)
          const sinceFood  = 230 - m;  // food 230min ago
          iob = sinceBolus < 240 ? 3.0 * Math.max(0, Math.exp(-sinceBolus/85)) : 0;
          const sf = Math.max(0, sinceFood);
          cob = sf > 0 && sf < 240 ? Math.max(0, 38 * (sf/45) * Math.exp(-(sf-45)/55)) : 0;
          // Well-matched: gentle rise to 8.5, clean return
          if (sinceBolus < 20) {
            bg = 5.5 - sinceBolus * 0.025; // slight pre-food dip as insulin starts
          } else if (sf < 0) {
            bg = 5.0;
          } else if (sf < 60) {
            bg = 5.0 + sf * 0.06; // gentle rise, insulin matching carbs
          } else if (sf < 120) {
            bg = 5.0 + 60*0.06 + (sf-60)*0.01; // plateaus near 8.5
          } else {
            bg = 8.5 - (sf-120) * 0.02; // gentle return
          }
          bg = Math.max(4.8, Math.min(9.0, bg));
        }
        pushPt(m, parseFloat(bg.toFixed(1)), parseFloat(Math.max(0,iob).toFixed(2)), parseFloat(Math.max(0,cob).toFixed(1)));
      }
      pushBolus(250, 0, 3.0);   // bolus 20min pre-food
      pushBolus(230, 38, 0);    // porridge carbs
      break;
    }

    case 'running_high': {
      // Stuck at 14+ for 90min. IOB from earlier meal cleared.
      // Correction of 1.5U given 15min ago. Starting to come down.
      for (let m = 120; m >= 0; m -= 5) {
        let bg, iob, cob;
        cob = 0;
        if (m > 15) {
          // Plateau high with slow drift
          bg  = 14.2 + Math.sin(m*0.1)*0.4;
          iob = 0;
        } else {
          // Correction 15min ago starting to work
          const sincCorr = 15 - m;
          iob = 1.5 * Math.exp(-sincCorr/90);
          bg  = 14.2 - sincCorr * 0.04;
          bg  = Math.max(13.0, bg);
        }
        pushPt(m, parseFloat(bg.toFixed(1)), parseFloat(iob.toFixed(2)), 0);
      }
      pushBolus(15, 0, 1.5); // correction
      break;
    }

    case 'pre_hypo_snack': {
      // BG dropping steadily to 4.2 with residual IOB.
      // 2 jelly babies (11g, high GI) given 20min ago. Gentle lift, no rebound.
      for (let m = 120; m >= 0; m -= 5) {
        let bg, iob, cob;
        if (m > 20) {
          // Dropping: overcorrection earlier, IOB still active
          const sinceDrop = 120 - m;
          iob = 0.8 * Math.max(0, 1 - sinceDrop/100);
          cob = 0;
          bg  = 7.2 - sinceDrop * 0.025;
          bg  = Math.max(4.0, bg);
        } else {
          // Jelly babies 20min ago — fast GI, gentle lift
          const sinceSnack = 20 - m;
          iob = 0.2 * Math.max(0, Math.exp(-sinceSnack/80));
          cob = 11 * Math.max(0, 1 - sinceSnack/30);
          bg  = 4.2 + sinceSnack * 0.055;
          bg  = Math.min(6.5, bg);
        }
        pushPt(m, parseFloat(bg.toFixed(1)), parseFloat(iob.toFixed(2)), parseFloat(cob.toFixed(1)));
      }
      pushBolus(20, 11, 0); // jelly babies carbs only
      break;
    }

    case 'active_hypo': {
      // BG hit 3.1 at 20min ago. Glucose tabs (12g) just logged.
      // COB lifting BG. Recovery underway. No insulin.
      for (let m = 120; m >= 0; m -= 5) {
        let bg, iob, cob;
        if (m > 20) {
          // Descent into hypo
          const sinceDrop = 120 - m;
          iob = 1.2 * Math.max(0, Math.exp(-sinceDrop/70));
          cob = 0;
          bg  = 8.5 - sinceDrop * 0.049;
          bg  = Math.max(3.0, bg);
        } else {
          // Glucose tabs — very high GI, fast absorption
          const sinceRx = 20 - m;
          cob = 12 * Math.max(0, 1 - sinceRx/25);
          iob = 0.3 * Math.max(0, Math.exp(-sinceRx/60));
          bg  = 3.1 + sinceRx * 0.12;
          bg  = Math.min(9.0, bg);
        }
        pushPt(m, parseFloat(bg.toFixed(1)), parseFloat(iob.toFixed(2)), parseFloat(cob.toFixed(1)));
      }
      pushBolus(20, 12, 0); // glucose tabs
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

  // Replace LOGGED_EVENTS with scenario bolus data (BOLUS_EVENTS is an alias)
  LOGGED_EVENTS.length = 0;
  for (const b of s.bolus) LOGGED_EVENTS.push(b);

  // Clear session
  SESSION.length = 0;

  // Reset view to now — breakfast scenarios use 4.5h window to show full arc
  updateCGMBounds();
  viewTime = CGM_END;
  var _breakfastScenarios = ['breakfast_too_early','breakfast_too_late','breakfast_goldilocks','happy_state'];
  viewSpan = _breakfastScenarios.indexOf(id) >= 0 ? 4.5 * 3600000 : 2 * 3600000;

  // Close selector
  var sel = document.getElementById('scenario-selector');
  if (sel) { sel.style.opacity='0'; setTimeout(function(){ sel.remove(); }, 300); }

  _activeDemoId = id;

  // Show scenario name as toast, then welcome card on first load
  var sc = DEMO_SCENARIOS.find(function(s){ return s.id===id; });
  if (sc) showToast(sc.name);
}

var _activeDemoId = null;
var openDemoSelector = function() { openScenarioSelector(); }; // alias

function showDemoWelcome() {
  // Full-screen welcome card for demo mode — readable, dismissable
  var ex = document.getElementById('_demo_welcome');
  if (ex) ex.remove();
  var el = document.createElement('div');
  el.id = '_demo_welcome';
  el.style.cssText = [
    'position:fixed','inset:0','z-index:95',
    'display:flex','align-items:center','justify-content:center',
    'padding:24px',
    'background:rgba(3,5,18,0.88)',
    'backdrop-filter:blur(20px)',
    '-webkit-backdrop-filter:blur(20px)',
    'transition:opacity .4s','opacity:0',
  ].join(';');
  el.innerHTML = [
    '<div style="max-width:360px;width:100%;text-align:center">',
      '<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:32px;',
        'color:rgba(200,230,255,0.95);letter-spacing:-1px;margin-bottom:8px">Oskar\'s River</div>',
      '<div style="font-family:\'DM Mono\',monospace;font-size:10px;letter-spacing:2px;',
        'text-transform:uppercase;color:rgba(140,180,220,0.5);margin-bottom:28px">demo mode</div>',
      '<div style="font-family:\'DM Mono\',monospace;font-size:12px;line-height:1.7;',
        'color:rgba(180,210,240,0.75);margin-bottom:32px">',
        'Explore a live glucose flow.<br>',
        'Hold the orb to log food, corrections,<br>',
        'hypos — or switch scenario.',
      '</div>',
      '<button onclick="document.getElementById(\'_demo_welcome\').style.opacity=\'0\';setTimeout(function(){document.getElementById(\'_demo_welcome\').remove();},400);" style="',
        'padding:12px 32px;border-radius:24px;border:1px solid rgba(100,180,255,0.3);',
        'background:rgba(40,80,140,0.4);',
        'font-family:\'DM Mono\',monospace;font-size:11px;letter-spacing:1px;',
        'color:rgba(180,220,255,0.9);cursor:pointer;margin-bottom:16px;',
        'display:block;width:100%;touch-action:manipulation">explore</button>',
      '<button onclick="document.getElementById(\'_demo_welcome\').style.opacity=\'0\';setTimeout(function(){document.getElementById(\'_demo_welcome\').remove();openScenarioSelector();},400);" style="',
        'padding:10px 32px;border-radius:24px;border:1px solid rgba(80,120,180,0.2);',
        'background:transparent;',
        'font-family:\'DM Mono\',monospace;font-size:10px;letter-spacing:1px;',
        'color:rgba(140,180,220,0.5);cursor:pointer;',
        'display:block;width:100%;touch-action:manipulation">choose scenario</button>',
    '</div>',
  ].join('');
  document.body.appendChild(el);
  requestAnimationFrame(function(){ el.style.opacity='1'; });
}

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
// HYPO_TREATMENTS: derived live from FOOD_LIBRARY cat='hypo'.
// Add/remove hypo options by editing the food library in Supabase.
function getHypoTreatments() {
  return FOOD_LIBRARY.filter(function(f){ return f.cat === 'hypo'; })
    .map(function(f) {
      var carbs_each = Math.round((f.c100 * (f.g_each || f.g_serv)) / 100 * 100) / 100;
      var id = f.name.toLowerCase().replace(/[^a-z0-9]+/g,'_');
      return { id: id, name: f.name, carbs_each: carbs_each, carbs: carbs_each,
               gi: f.gi, unit: 'item', default_qty: 1, note: f.note || '' };
    });
}


async function suggestGI(foodName, inputEl) {
  if (!foodName || foodName.length < 2) return 55;
  // Show loading state on the input and any adjacent basis div
  if (inputEl) {
    inputEl.placeholder = '⏳';
    inputEl.style.opacity = '0.5';
  }
  // Support both the old inline-gi-basis (now gone) and the overlay badge
  var basisEl = document.getElementById('inline-gi-basis') || document.getElementById('new-food-gi-badge');
  if (basisEl) basisEl.textContent = 'looking up GI…';

  try {
    var resp = await fetch('https://orange-surf-6f98.john-king-uk.workers.dev/claude', {
      method:'POST', headers:{'Content-Type':'application/json','anthropic-version':'2023-06-01'},
      body: JSON.stringify({model:'claude-sonnet-4-5', max_tokens:80,
        system: 'Return ONLY a JSON object: {"gi":<integer 1-100>,"note":"<one phrase e.g. white bread equivalent>"}. If primarily fat/protein with negligible carbs return gi:5. Never return null for gi.',
        messages:[{role:'user', content:'Glycaemic index for: "'+foodName+'"'}]})
    });
    var d = await resp.json();
    var raw = ((d.content||[])[0]||{}).text || '{}';
    var result = {};
    try { result = JSON.parse(raw.replace(/```json|```/g,'').trim()); } catch(e) {}
    var gi = Math.max(1, Math.min(100, parseInt(result.gi)||55));
    if (inputEl) {
      inputEl.value = gi;
      inputEl.placeholder = 'GI';
      inputEl.style.opacity = '';
      // Colour-code the field by GI band
      inputEl.style.color = gi >= 70 ? 'rgba(210,80,40,0.9)' : gi >= 55 ? 'rgba(220,180,80,0.9)' : 'rgba(100,220,160,0.9)';
    }
    var note = result.note ? 'AI · ' + result.note : 'AI estimate';
    if (basisEl) {
      basisEl.textContent = note;
      // If it's the overlay badge, also mark as AI-confirmed so category change won't clobber it
      if (basisEl.id === 'new-food-gi-badge') {
        basisEl.style.color = 'rgba(62,200,140,0.8)';
        basisEl.textContent = 'AI · ' + (result.note || 'estimated');
      }
    }
    // Trigger preview update if the overlay form is visible
    if (typeof updateAddFoodPreview === 'function') updateAddFoodPreview();
    return gi;
  } catch(e) {
    if (inputEl) { inputEl.placeholder = 'GI'; inputEl.style.opacity = ''; }
    if (basisEl) basisEl.textContent = 'est. from category';
    return 55;
  }
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
      'onchange="document.getElementById(\'' + id + '-display\').textContent=fmtTime(this.value);window._pickerOpen=false">' +
    '<button onclick="event.stopPropagation();window._pickerOpen=true;var _p=document.getElementById(\'' + id + '\');_p.showPicker?_p.showPicker():_p.click()" ' +
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
  el.style.cssText='position:fixed;inset:0;z-index:60;background:rgba(3,5,20,0.9);backdrop-filter:blur(14px);display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:24px;padding-top:max(40px,env(safe-area-inset-top,40px));overflow-y:auto;-webkit-overflow-scrolling:touch;transition:opacity .25s;opacity:0;touch-action:pan-y;pointer-events:auto';
  el.addEventListener('touchstart',function(e){e.stopPropagation();},{passive:true});
  el.addEventListener('click',function(e){if(window._pickerOpen)return;if(e.target===el)closeHypoLog();});
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
  getHypoTreatments().forEach(function(t){
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
  var t=getHypoTreatments().find(function(x){return x.id===id;});
  if(!t) return;
  var qtyInp=document.getElementById('hypo-qty-'+id);
  var qty=qtyInp?Math.max(1,parseFloat(qtyInp.value)||t.default_qty||1):(t.default_qty||1);
  var carbs_each=t.carbs_each||t.carbs;
  var carbs=Math.round(qty*carbs_each*10)/10;
  // Guardrail — 60g is already a very heavy hypo treatment for a child
  if(carbs>60){showToast('⚠️ '+carbs.toFixed(0)+'g is a very large hypo treatment — check quantity');return;}
  if(carbs>30){showToast('⚠️ '+carbs.toFixed(0)+'g logged — confirm this is correct');}
  var now=_safeEventT(getTimeVal('hypo-time'));
  SESSION.push({t:now,c:carbs,u:0,note:'hypo:'+id});
  try{localStorage.setItem('river_session',JSON.stringify(SESSION));}catch(e){}
  LOGGED_EVENTS.push({t:now,c:carbs,u:0,note:'hypo:'+id,logged_by:_thisPersonId||'unknown', local:true});
  try{localStorage.setItem('river_logged',JSON.stringify(LOGGED_EVENTS));}catch(e){}
  syncAfterLog();
  closeHypoLog();
  var timeStr=document.getElementById('hypo-time-display')?.textContent||'';
  // Snapshot prediction at log time
  _snapshotPrediction();
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
  window._selectedInsulinType = null; // reset to default — re-derived by _insulinSelectorHTML
  var d=dataAt(viewTime);
  var ISF=getISF(viewTime);
  var sug=Math.max(0,Math.round(((d.bg-getTarget(viewTime))/ISF)*2)/2);
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
  s+=_insulinSelectorHTML('rgba(100,150,255,OPACITY)');
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
  var now=_safeEventT(getTimeVal('corr-time'));
  var insType=_currentSelectedInsulin();
  SESSION.push({t:now,c:0,u:u});
  LOGGED_EVENTS.push({t:now,c:0,u:u,note:'correction',insulin_type:insType,logged_by:_thisPersonId||'unknown',local:true});
  try{localStorage.setItem('river_session',JSON.stringify(SESSION));}catch(e){}
  try{localStorage.setItem('river_logged',JSON.stringify(LOGGED_EVENTS));}catch(e){}
  // Snapshot IOB prediction curve for outcome tracking — corrections never
  // wrote a bolus_outcomes baseline at all (separate gap from the meal-bolus
  // fire-and-forget bug; this path had no call here whatsoever before now).
  (function() {
    try {
      var corrEv = {t:now, u:u, insulin_type:insType, logged_by:_thisPersonId||'unknown'};
      var iobCurve = [];
      var d0 = dataAt(now);
      var ISF = _currentTherapySnapshot(now);
      var isf = ISF ? ISF.isf : 6.5;
      var insProfile = _getInsulinProfile(insType);
      for (var m = 5; m <= 240; m += 5) {
        var predBG = d0 ? Math.max(1.8, d0.bg - u * (1 - _iobFn(m, insProfile.diaMins, insProfile.peakMins)) * isf) : 0;
        iobCurve.push({mins: m, bg: +predBG.toFixed(2)});
      }
      // Fire-and-forget deliberately: UI must not block on the ~1.5s retry.
      _createBolusOutcomeBaselineWithRetry(corrEv, iobCurve);
    } catch (diagErr) {
      console.warn('[bolusOutcomeBaseline] correction IIFE setup threw:', diagErr);
    }
  })();
  // Snapshot prediction at log time — stored globally for drawForecastTrace
  _snapshotPrediction();
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
let _cgmPolledOnce = false; // suppresses outage detection until first poll is done
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
      viewTime = Date.now(); // wall clock master
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
    } finally {
      _cgmPolledOnce = true; // first poll attempted — gap detection now valid
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
const PERSIST_MAX_DAYS = 90; // keep 90 days of readings as local cache — Supabase is source of truth

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
  const wasAtNow = _isAtNow || (Date.now() - viewTime) < 10 * 60000;
  if (wasAtNow || viewTime < CGM_START || viewTime > Date.now() + 60000) {
    viewTime = Date.now(); // wall clock master
    _isAtNow = true;
  }
  if (changed) persistReadings();
  _historyIsStale = false; // live data confirmed — show real BG
  // Purge scenario-only BOLUS_EVENTS (not in LOGGED_EVENTS) — demo data gone
  if (_activeDemoId) {
    // BOLUS_EVENTS is an alias for LOGGED_EVENTS — no separate purge needed.
    SESSION = SESSION.filter(function(s){ return LOGGED_EVENTS.some(function(e){ return e.t===s.t; }); });
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
  font-family:DM Sans,sans-serif;padding:24px;overflow-y:auto;
">
  <div style="max-width:440px;width:100%">
    <!-- Logo -->
    <div style="text-align:center;margin-bottom:28px">
      <div style="font-family:Fraunces,serif;font-style:italic;font-weight:200;
        font-size:32px;color:rgba(40,55,50,0.75);letter-spacing:-1px">Oskar's River</div>
      <div style="font-family:DM Mono,monospace;font-size:9px;color:rgba(40,55,50,0.3);
        letter-spacing:2px;text-transform:uppercase;margin-top:4px">connect your cgm</div>
    </div>

    <!-- Source selector -->
    <div style="display:flex;gap:8px;margin-bottom:20px" id="source-tabs">
      ${Object.entries(CGM_SOURCES).map(([id,src]) => `
        <button onclick="selectSource('${id}')"
          id="stab-${id}"
          style="flex:1;padding:10px 6px;border-radius:10px;cursor:pointer;
            font-family:DM Sans,sans-serif;font-size:11px;text-align:center;
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
      text-align:center;margin-bottom:12px;min-height:18px;font-family:DM Mono,monospace"></div>

    <!-- Connect button -->
    <button onclick="connectCGM()" id="connect-btn"
      style="width:100%;padding:14px;border-radius:10px;
        border:1px solid rgba(40,55,50,0.2);
        background:rgba(40,55,50,0.08);
        color:rgba(40,55,50,0.7);font-family:Fraunces,serif;
        font-style:italic;font-weight:200;font-size:17px;
        cursor:pointer;transition:all .12s;letter-spacing:-.2px">
      begin the flow
    </button>

    <!-- Skip -->
    <div style="text-align:center;margin-top:12px">
      <button onclick="skipSetup()"
        style="background:none;border:none;cursor:pointer;
          font-family:DM Mono,monospace;font-size:9px;letter-spacing:1px;
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
    <div style="text-align:center;margin-top:10px;font-family:DM Mono,monospace;font-size:8px;color:rgba(40,55,50,0.15);letter-spacing:1px">__BUILD_ID__</div>
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
        <label style="font-family:DM Mono,monospace;font-size:9px;letter-spacing:1px;
          text-transform:uppercase;color:rgba(40,55,50,0.4);display:block;margin-bottom:5px">${f.label}</label>
        <select id="sf-${f.key}"
          style="width:100%;padding:10px 12px;border-radius:8px;
            border:1px solid rgba(40,55,50,0.15);background:rgba(255,255,255,0.7);
            font-family:DM Sans,sans-serif;font-size:14px;color:rgba(40,55,50,0.8);
            outline:none;-webkit-appearance:none">
          ${f.options.map(o => `<option value="${o.value}" ${(saved[f.key]||'ous')===o.value?'selected':''}>${o.label}</option>`).join('')}
        </select>
      </div>`;
    }
    return `<div>
      <label style="font-family:DM Mono,monospace;font-size:9px;letter-spacing:1px;
        text-transform:uppercase;color:rgba(40,55,50,0.4);display:block;margin-bottom:5px">${f.label}</label>
      <input id="sf-${f.key}" type="${f.type}" placeholder="${f.placeholder}"
        value="${saved[f.key]||''}"
        style="width:100%;padding:11px 14px;border-radius:8px;
          border:1px solid rgba(40,55,50,0.15);background:rgba(255,255,255,0.7);
          font-family:DM Mono,monospace;font-size:13px;color:rgba(40,55,50,0.8);
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
    setTimeout(function(){ showDemoWelcome(); }, 700);
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
      if (data.foods) {
        localStorage.setItem('river_food_lib', JSON.stringify(data.foods));
        // Also push imported library to Supabase so other devices get it
        try { FOOD_LIBRARY.length = 0; data.foods.forEach(function(f){ FOOD_LIBRARY.push(f); }); } catch(_e) {}
        syncFoodLibraryToSupabase();
      }
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

  var all = FOOD_LIBRARY;

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
  var all  = FOOD_LIBRARY.slice();
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

  // Edit goes into FOOD_LIBRARY (single source of truth)
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

  // Capture the canvas time at the press position so modal time-pickers pre-fill correctly
  _radialDefaultT = viewTime;

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
    { label: 'outage',     icon: '📡', fn: 'openOutageLog()',      col: 'rgba(200,175,80,0.9)'  },
    { label: 'patterns',   icon: '◑', fn: 'openPatternExplorer()', col: 'rgba(160,120,240,0.9)' },
    { label: 'whisper',    icon: '◌', fn: 'openWhisper()',        col: 'rgba(140,200,180,0.9)' },
  ];
  if (_activeDemoId) {
    // In demo mode: replace whisper with scenarios switcher
    items[items.length - 1] = { label: 'scenarios', icon: '◈', fn: 'openScenarioSelector()', col: 'rgba(140,200,180,0.9)' };
  }

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
    "font-family:DM Mono,monospace",
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
    'ISF: breakfast ' + getISF(new Date().setHours(8,0,0,0)) + ' mmol/U · daytime ' + getISF(new Date().setHours(12,0,0,0)) + ' · evening ' + getISF(new Date().setHours(19,0,0,0)) + ' · overnight ' + getISF(new Date().setHours(2,0,0,0)) + (_observedISF && Object.keys(_observedISF).length >= 2 ? ' (observed)' : ' (therapy settings)'),
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

  // Intercept browser back button — River is a SPA, back should close any open overlay
  // rather than navigating away to a 404.
  history.pushState({river:true}, '', location.href);
  window.addEventListener('popstate', function(e) {
    // Re-push so the back button always has somewhere to go without leaving the app
    history.pushState({river:true}, '', location.href);
    // Close whatever is open: overlays, sheets, photo cards
    var toClose = ['food-add-overlay','photo-confirm-card','food-ai-loader'];
    toClose.forEach(function(id){ var el = document.getElementById(id); if(el) el.remove(); });
    // Also close food results panel
    var res = document.getElementById('food-results');
    if (res) res.style.display = 'none';
    var srch = document.getElementById('food-search');
    if (srch) srch.value = '';
  });
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
    '_showPhotoConfirmCard', '_numericOnly', '_updatePhotoConfirmPreview', '_debouncedSearchFood',
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
    // BOLUS_EVENTS is a live alias for LOGGED_EVENTS — cleared above.
    try{ if(typeof SESSION!=='undefined')        SESSION.length=0;       }catch(_e){}
    try{ if(typeof MEAL_HISTORY!=='undefined')   MEAL_HISTORY.length=0;  }catch(_e){}
    try{ if(typeof HISTORY_RAW!=='undefined')    HISTORY_RAW.length=0;   }catch(_e){}
    try{ if(typeof FOOD_LIBRARY!=='undefined')   FOOD_LIBRARY.length=0;  }catch(_e){}
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

// ═══════════════════════════════════════════════════════════════════════
//  FEATURE 3: DAILY COMPLETENESS SCORE
// ═══════════════════════════════════════════════════════════════════════
function _computeDayCompleteness(dateStr) {
  // dateStr: 'YYYY-MM-DD'
  var dayStart = new Date(dateStr).getTime();
  var dayEnd   = dayStart + 86400000;

  // CGM readings that day
  var dayReadings = HISTORY_RAW.filter(function(r){ return r.t >= dayStart && r.t < dayEnd && r.bg > 0; });
  if (dayReadings.length === 0) {
    return { score: 0, label: '○', components: { data_source: 'none' } };
  }

  // Meal history that day
  var dayMeals = (MEAL_HISTORY||[]).filter(function(m){ return m.t >= dayStart && m.t < dayEnd; });
  // Estimated meal occasions: breakfast(1) + lunch(1) + dinner(1) = 3 default
  var estMealOccasions = 3;
  var meal_coverage = dayMeals.length / Math.max(1, estMealOccasions);

  // Bolus events that day
  var dayBoluses = LOGGED_EVENTS.filter(function(e){ return e.t >= dayStart && e.t < dayEnd && e.u > 0; });
  // Ghost corrections that day (for denominator)
  var dayGhosts = _ghostPebbles.filter(function(g){ return g.t >= dayStart && g.t < dayEnd; });
  var resolvedGhosts = dayGhosts.filter(function(g){ return g.confirmed !== null; });
  var bolus_coverage = dayBoluses.length / Math.max(1, dayMeals.length || 1);
  var ghost_rate = dayGhosts.length > 0 ? resolvedGhosts.length / dayGhosts.length : 1;

  var data_source = dayMeals.length > 0 ? 'full' : dayBoluses.length > 0 ? 'raw' : 'cgm_only';

  var score;
  if (dayMeals.length > 0 && bolus_coverage > 0.8 && dayGhosts.filter(function(g){return g.confirmed===null;}).length === 0) {
    score = 3;
  } else if (dayMeals.length > 0 || dayBoluses.length > 0) {
    score = 2;
  } else if (dayReadings.length > 0) {
    score = 1;
  } else {
    score = 0;
  }
  var labels = ['○','★','★★','★★★'];
  return {
    score: score,
    label: labels[score],
    components: { meal_coverage: +meal_coverage.toFixed(2), bolus_coverage: +bolus_coverage.toFixed(2), ghost_rate: +ghost_rate.toFixed(2), data_source: data_source }
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  FEATURE 4: ISF DRIFT CHART
// ═══════════════════════════════════════════════════════════════════════
function drawISFDriftChart(canvas, data) {
  // data: { outcomes: [{t, period, observed_isf, therapy_snapshot}], therapyHistory: [{t, ratios}] }
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var CW = canvas.width, CH = canvas.height;
  ctx.clearRect(0, 0, CW, CH);

  if (!data || !data.outcomes || data.outcomes.length === 0) {
    ctx.fillStyle = 'rgba(160,180,200,0.3)';
    ctx.font = "9px 'DM Mono',monospace";
    ctx.textAlign = 'center';
    ctx.fillText('no bolus outcome data yet', CW / 2, CH / 2);
    return;
  }

  var outcomes = data.outcomes;
  var PAD = { t: 12, b: 24, l: 32, r: 10 };
  var W2 = CW - PAD.l - PAD.r;
  var H2 = CH - PAD.t - PAD.b;

  var tMin = Math.min.apply(null, outcomes.map(function(o){return o.t;}));
  var tMax = Math.max.apply(null, outcomes.map(function(o){return o.t;})) || (tMin + 1);
  var yMin = 0, yMax = 12;

  function xOf(t) { return PAD.l + ((t - tMin) / (tMax - tMin || 1)) * W2; }
  function yOf(v) { return PAD.t + (1 - (v - yMin) / (yMax - yMin)) * H2; }

  // Target zone
  ctx.fillStyle = 'rgba(62,180,120,0.06)';
  ctx.fillRect(PAD.l, yOf(8), W2, yOf(5) - yOf(8));

  var PERIOD_COLOURS = {
    Breakfast:  [0,  210, 200],
    Lunch:      [60, 200,  80],
    Afternoon:  [200,160,  40],
    Evening:    [120, 90, 220],
    Overnight:  [140,160,180],
  };

  var byPeriod = {};
  outcomes.forEach(function(o) {
    if (!o.period || !o.observed_isf) return;
    if (!byPeriod[o.period]) byPeriod[o.period] = [];
    byPeriod[o.period].push({ t: o.t, isf: o.observed_isf });
  });

  var highlighted = data.highlightedPeriod || null;
  Object.keys(PERIOD_COLOURS).forEach(function(period) {
    var pts = byPeriod[period];
    if (!pts || pts.length === 0) return;
    pts.sort(function(a,b){return a.t-b.t;});

    var col = PERIOD_COLOURS[period];
    var dimmed = highlighted && highlighted !== period;
    var baseAlpha = dimmed ? 0.15 : 1.0;

    // N-based alpha for individual points
    ctx.save();
    pts.forEach(function(pt) {
      var n = pts.length;
      var ptAlpha = n < 5 ? 0.4 : n < 10 ? 0.75 : 1.0;
      ptAlpha *= baseAlpha;
      ctx.globalAlpha = ptAlpha;
      ctx.fillStyle = 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',1)';
      ctx.beginPath();
      ctx.arc(xOf(pt.t), yOf(pt.isf), 3, 0, Math.PI * 2);
      ctx.fill();
    });

    // Polyline
    ctx.globalAlpha = baseAlpha * 0.6;
    ctx.strokeStyle = 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',1)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    pts.forEach(function(pt, i) {
      i === 0 ? ctx.moveTo(xOf(pt.t), yOf(pt.isf)) : ctx.lineTo(xOf(pt.t), yOf(pt.isf));
    });
    ctx.stroke();
    ctx.restore();

    // Period label at last point
    if (!dimmed) {
      ctx.save();
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',1)';
      ctx.font = "8px 'DM Mono',monospace";
      ctx.textAlign = 'left';
      var last = pts[pts.length - 1];
      ctx.fillText(period.slice(0, 3), xOf(last.t) + 4, yOf(last.isf) + 3);
      ctx.restore();
    }
  });

  // Programmed ISF dashed line
  if (data.therapyHistory && data.therapyHistory.length > 0) {
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = 'rgba(180,200,220,1)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 6]);
    data.therapyHistory.forEach(function(th, i) {
      if (!th.ratios || !th.ratios.length) return;
      var ratioISF = th.ratios[0].isf || 6.5;
      var startX = xOf(th.t);
      var endX = i < data.therapyHistory.length - 1 ? xOf(data.therapyHistory[i+1].t) : CW - PAD.r;
      ctx.beginPath();
      ctx.moveTo(startX, yOf(ratioISF));
      ctx.lineTo(endX, yOf(ratioISF));
      ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.restore();
  }

  // Y-axis labels
  ctx.fillStyle = 'rgba(160,180,200,0.4)';
  ctx.font = "8px 'DM Mono',monospace";
  ctx.textAlign = 'right';
  [2, 4, 6, 8, 10, 12].forEach(function(v) {
    ctx.fillText(v, PAD.l - 3, yOf(v) + 3);
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 0.5;
    ctx.moveTo(PAD.l, yOf(v)); ctx.lineTo(CW - PAD.r, yOf(v));
    ctx.stroke();
  });
}

async function _loadISFDriftData() {
  if (!SUPABASE_READY) return { outcomes: [], therapyHistory: [] };
  try {
    var rows = await _sbFetch(
      'bolus_outcomes?select=t,period,observed_isf,therapy_snapshot&observed_isf=not.is.null&order=t.asc&limit=300',
      { method: 'GET' }
    );
    var th = await _sbFetch('therapy_history?order=t.asc&select=t,ratios', { method: 'GET' });
    return {
      outcomes: Array.isArray(rows) ? rows : [],
      therapyHistory: Array.isArray(th) ? th : [],
    };
  } catch(e) { return { outcomes: [], therapyHistory: [] }; }
}

// ═══════════════════════════════════════════════════════════════════════
//  FEATURE 5: PATTERN LIBRARY BOOTSTRAP
// ═══════════════════════════════════════════════════════════════════════
var _patternLibraryBootstrapped = false;

async function _bootstrapPatternLibrary() {
  if (_patternLibraryBootstrapped) return;
  _patternLibraryBootstrapped = true;
  if (!SUPABASE_READY) return;
  try {
    // Guard: only runs if pattern_library is empty
    var countRows = await _sbFetch('pattern_library?select=id&limit=1', { method: 'GET' });
    if (Array.isArray(countRows) && countRows.length > 0) return; // already seeded

    var now = new Date().toISOString();
    var newPatterns = [];

    // (a) food_variance: foods appearing ≥3x with SD > 2.5 mmol
    var meals = (MEAL_HISTORY || []).filter(function(m){ return m.items && m.peak_bg; });
    var byFood = {};
    meals.forEach(function(m) {
      (m.items || []).forEach(function(item) {
        var key = (item.name || '').toLowerCase();
        if (!byFood[key]) byFood[key] = [];
        if (m.peak_bg) byFood[key].push(m.peak_bg);
      });
    });
    Object.keys(byFood).forEach(function(foodKey) {
      var bgs = byFood[foodKey];
      if (bgs.length < 3) return;
      var mean = bgs.reduce(function(s,v){return s+v;},0) / bgs.length;
      var sd = Math.sqrt(bgs.reduce(function(s,v){return s+Math.pow(v-mean,2);},0)/bgs.length);
      if (sd > 2.5) {
        newPatterns.push({
          pattern_type: 'food_variance',
          name: 'High BG variance for ' + foodKey,
          description: 'Peak BG varies widely across instances of this food.',
          food_key: foodKey,
          parameters: { food_key: foodKey, mean_peak: +mean.toFixed(2), sd: +sd.toFixed(2), instances: bgs.length },
          status: 'emerging',
          model_version: (window['__BUILD'+'_ID__'] || 'dev'),
          created_at: now, updated_at: now,
        });
      }
    });

    // (b) override_bias: periods with ≥5 direction overrides, ratio > 0.65
    if (SUPABASE_READY) {
      try {
        var evRows = await _sbFetch(
          'events?override_type=eq.direction&select=t,override_dir&limit=300',
          { method: 'GET' }
        );
        if (Array.isArray(evRows)) {
          var byPeriod2 = {};
          evRows.forEach(function(ev) {
            var h = new Date(ev.t).getHours();
            var p = h >= 6 && h < 10 ? 'Breakfast' : h >= 10 && h < 14 ? 'Lunch' :
                    h >= 14 && h < 18 ? 'Afternoon' : h >= 18 && h < 22 ? 'Evening' : 'Overnight';
            if (!byPeriod2[p]) byPeriod2[p] = { up: 0, down: 0 };
            if (ev.override_dir === 'up') byPeriod2[p].up++;
            else byPeriod2[p].down++;
          });
          Object.keys(byPeriod2).forEach(function(period) {
            var counts = byPeriod2[period];
            var total2 = counts.up + counts.down;
            if (total2 < 5) return;
            var pctDown = counts.down / total2;
            var pctUp   = counts.up   / total2;
            if (pctDown > 0.65 || pctUp > 0.65) {
              newPatterns.push({
                pattern_type: 'override_bias',
                name: 'Directional bias at ' + period,
                description: 'Calculator may be slightly miscalibrated for this period.',
                parameters: { period: period, pct_down: +pctDown.toFixed(2), pct_up: +pctUp.toFixed(2), n_instances: total2 },
                status: 'emerging',
                model_version: (window['__BUILD'+'_ID__'] || 'dev'),
                created_at: now, updated_at: now,
              });
            }
          });
        }
      } catch(e2) { console.warn('[patternLib override_bias]', e2.message); }
    }

    // (c) sequence_effect: meal after high predecessor
    var seqGroups = {};
    (MEAL_HISTORY || []).forEach(function(m) {
      if (!m.peak_bg) return;
      // Find meal 3h before
      var before = (MEAL_HISTORY || []).find(function(prev) {
        return prev.t < m.t && m.t - prev.t < 3 * 3600000 && prev.peak_bg > 12;
      });
      var key2 = (m.name || '').toLowerCase();
      if (!seqGroups[key2]) seqGroups[key2] = { withHigh: [], withoutHigh: [] };
      if (before) seqGroups[key2].withHigh.push(m.peak_bg);
      else seqGroups[key2].withoutHigh.push(m.peak_bg);
    });
    Object.keys(seqGroups).forEach(function(k) {
      var g = seqGroups[k];
      if (g.withHigh.length < 3 || g.withoutHigh.length < 1) return;
      var meanWith    = g.withHigh.reduce(function(s,v){return s+v;},0)/g.withHigh.length;
      var meanWithout = g.withoutHigh.reduce(function(s,v){return s+v;},0)/g.withoutHigh.length;
      var delta = meanWith - meanWithout;
      if (Math.abs(delta) > 1.5) {
        newPatterns.push({
          pattern_type: 'sequence_effect',
          name: 'High predecessor effect for ' + k,
          description: 'This meal peaks higher when preceded by high BG.',
          parameters: { prior_high_threshold: 12, mean_delta: +delta.toFixed(2), instances: g.withHigh.length },
          status: 'emerging',
          model_version: (window['__BUILD'+'_ID__'] || 'dev'),
          created_at: now, updated_at: now,
        });
      }
    });

    if (newPatterns.length > 0) {
      await _sbFetch('pattern_library', {
        method: 'POST',
        prefer: 'return=minimal',
        body: newPatterns,
      });
      console.log('[patternLib] seeded', newPatterns.length, 'patterns');
    } else {
      console.log('[patternLib] no patterns to seed yet (not enough data)');
    }
  } catch(e) {
    console.warn('[bootstrapPatternLibrary]', e.message);
  }
}

async function _loadPatternLibrary() {
  if (!SUPABASE_READY) return [];
  try {
    var rows = await _sbFetch(
      'pattern_library?status=neq.superseded&order=updated_at.desc&limit=50',
      { method: 'GET' }
    );
    return Array.isArray(rows) ? rows : [];
  } catch(e) { return []; }
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
        '<button onclick="_bulkFetchHistory(new Date(\'2026-03-07\'))" style="padding:3px 8px;border-radius:6px;border:1px solid rgba(80,160,220,0.4);background:rgba(80,160,220,0.08);color:rgba(80,160,220,0.8);font-family:monospace;font-size:9px;cursor:pointer">load all history</button>' +
        '<button onclick="_backfillFromNightscout(new Date(\'2026-03-07\'), new Date())" style="padding:3px 8px;border-radius:6px;border:1px solid rgba(120,200,150,0.4);background:rgba(120,200,150,0.08);color:rgba(120,200,150,0.8);font-family:monospace;font-size:9px;cursor:pointer">NS backfill</button>' +
        '<button onclick="if(confirm(\'Delete ALL Supabase events? Cannot be undone.\'))nukeSupabaseEvents()" style="padding:3px 8px;border-radius:6px;border:1px solid rgba(220,80,60,0.6);background:rgba(220,80,60,0.12);color:rgba(220,80,60,0.9);font-family:monospace;font-size:9px;cursor:pointer">nuke supa</button>' +
        '<button onclick="document.getElementById(\'debug-panel\').remove()" style="background:none;border:none;color:var(--rv-text-muted);cursor:pointer;font-size:18px;padding:0;line-height:1">×</button>' +
      '</div>' +
    '</div>' +

    // Status strip
    '<div style="color:rgba(150,200,150,0.6);margin-bottom:8px;line-height:1.7;font-size:9px">' +
      '__BUILD_ID__ · ' + src + ' · last: ' + age + ' · ' + hist + ' readings<br>' +
      'BG: ' + (d.bg ? d.bg.toFixed(1) : '?') +
      ' IOB: ' + (d.iob ? d.iob.toFixed(2) : '?') +
      ' COB: ' + (d.cob ? d.cob.toFixed(1) : '?') + '<br>' +
      'CGM: ' + HISTORY_RAW.length + ' pts · oldest: ' + (HISTORY_RAW.length ? new Date(HISTORY_RAW[0].t).toLocaleDateString('en-GB',{day:'numeric',month:'short'}) : 'none') + '<br>' +
      'foods: ' + FOOD_LIBRARY.length + ' · fetchedTo: ' + (_olderHistoryFetchedTo ? new Date(_olderHistoryFetchedTo).toLocaleDateString('en-GB',{day:'numeric',month:'short'}) : 'none') + ' · fetching: ' + _olderHistoryFetching +
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
    '<div id="repair-status" style="font-size:9px;color:var(--rv-text-muted);min-height:14px;text-align:center"></div>' +

    // Backlog
    '<div style="border-top:1px solid rgba(255,255,255,0.08);margin-top:10px;padding-top:10px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
        '<div style="font-size:8px;letter-spacing:1px;text-transform:uppercase;color:var(--rv-text-muted)">backlog</div>' +
        '<div style="display:flex;gap:4px">' +
          '<button onclick="loadDebugBacklog(\'open\')" id="blq-btn-open" style="padding:2px 6px;border-radius:4px;border:1px solid rgba(62,207,160,0.3);background:rgba(62,207,160,0.08);color:rgba(62,207,160,0.8);font-family:monospace;font-size:8px;cursor:pointer">open</button>' +
          '<button onclick="loadDebugBacklog(\'p0\')" id="blq-btn-p0" style="padding:2px 6px;border-radius:4px;border:1px solid rgba(220,80,60,0.3);background:rgba(220,80,60,0.08);color:rgba(220,80,60,0.8);font-family:monospace;font-size:8px;cursor:pointer">p0</button>' +
          '<button onclick="loadDebugBacklog(\'done\')" id="blq-btn-done" style="padding:2px 6px;border-radius:4px;border:1px solid rgba(100,100,100,0.3);background:rgba(100,100,100,0.08);color:rgba(150,150,150,0.8);font-family:monospace;font-size:8px;cursor:pointer">done</button>' +
        '</div>' +
      '</div>' +
      '<div id="backlog-list" style="font-size:9px;line-height:1.6;color:rgba(180,200,180,0.7)">loading…</div>' +
    '</div>';

  // ── Backfill Progress Bar ──────────────────────────────────────────────
  var bpDiv = document.createElement('div');
  bpDiv.style.cssText = 'margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.08)';
  bpDiv.innerHTML =
    '<div style="font-size:8px;letter-spacing:1px;text-transform:uppercase;color:var(--rv-text-dim);margin-bottom:6px">backfill progress</div>' +
    '<canvas id="backfill-bar-canvas" width="400" height="16" style="width:100%;height:16px;border-radius:4px;cursor:pointer"></canvas>' +
    '<div id="backfill-bar-stats" style="font-size:8px;color:rgba(180,200,180,0.5);margin-top:4px"></div>' +
    '<button onclick="_jumpToNextGap()" style="margin-top:6px;padding:3px 8px;border-radius:5px;border:1px solid rgba(80,160,220,0.3);background:rgba(80,160,220,0.06);color:rgba(80,160,220,0.7);font-family:monospace;font-size:8px;cursor:pointer">jump to next gap ○</button>' +
    '<button onclick="showDayStrip();document.getElementById(\'debug-panel\').remove()" style="margin-top:4px;padding:3px 8px;border-radius:5px;border:1px solid rgba(62,180,120,0.3);background:rgba(62,180,120,0.06);color:rgba(62,180,120,0.7);font-family:monospace;font-size:8px;cursor:pointer">📅 day strip</button>' +
    '<button onclick="openOutageHistory();document.getElementById(\'debug-panel\').remove()" style="margin-top:4px;margin-left:4px;padding:3px 8px;border-radius:5px;border:1px solid rgba(200,175,80,0.3);background:rgba(200,175,80,0.06);color:rgba(200,175,80,0.7);font-family:monospace;font-size:8px;cursor:pointer">📡 outages</button>';
  el.appendChild(bpDiv);
  _renderBackfillBar(bpDiv.querySelector('#backfill-bar-canvas'), bpDiv.querySelector('#backfill-bar-stats'));

  // ── River Health Panel ───────────────────────────────────────────────────
  var healthDiv = document.createElement('div');
  healthDiv.style.cssText = 'margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.08)';
  var healthOpen = false;
  var healthToggle = document.createElement('div');
  healthToggle.style.cssText = 'display:flex;justify-content:space-between;align-items:center;cursor:pointer;user-select:none';
  healthToggle.innerHTML =
    '<div style="font-size:8px;letter-spacing:1px;text-transform:uppercase;color:rgba(62,207,160,0.7)">River Health</div>' +
    '<span id="health-toggle-icon" style="font-size:10px;color:rgba(62,207,160,0.5)">▼</span>';
  var healthBody = document.createElement('div');
  healthBody.id = 'river-health-body';
  healthBody.style.cssText = 'display:none;margin-top:10px';
  healthToggle.addEventListener('click', function() {
    healthOpen = !healthOpen;
    healthBody.style.display = healthOpen ? 'block' : 'none';
    document.getElementById('health-toggle-icon').textContent = healthOpen ? '▲' : '▼';
    if (healthOpen && !healthBody.dataset.loaded) {
      healthBody.dataset.loaded = '1';
      _renderRiverHealth(healthBody);
    }
  });
  healthDiv.appendChild(healthToggle);
  healthDiv.appendChild(healthBody);
  el.appendChild(healthDiv);

  // ── ISF Drift Chart ──────────────────────────────────────────────────────
  var isfDiv = document.createElement('div');
  isfDiv.style.cssText = 'margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.08)';
  var isfOpen = false;
  var isfToggle = document.createElement('div');
  isfToggle.style.cssText = 'display:flex;justify-content:space-between;align-items:center;cursor:pointer;user-select:none';
  isfToggle.innerHTML =
    '<div style="font-size:8px;letter-spacing:1px;text-transform:uppercase;color:rgba(180,160,240,0.7)">ISF Drift</div>' +
    '<span id="isf-toggle-icon" style="font-size:10px;color:rgba(180,160,240,0.5)">▼</span>';
  var isfBody = document.createElement('div');
  isfBody.id = 'isf-drift-body';
  isfBody.style.display = 'none';
  isfToggle.addEventListener('click', function() {
    isfOpen = !isfOpen;
    isfBody.style.display = isfOpen ? 'block' : 'none';
    document.getElementById('isf-toggle-icon').textContent = isfOpen ? '▲' : '▼';
    if (isfOpen && !isfBody.dataset.loaded) {
      isfBody.dataset.loaded = '1';
      _loadISFDriftData().then(function(data) {
        var cv = document.createElement('canvas');
        cv.width = 500; cv.height = 180;
        cv.style.cssText = 'width:100%;height:auto;display:block;margin-top:8px;border-radius:6px;background:rgba(255,255,255,0.02)';
        isfBody.appendChild(cv);
        drawISFDriftChart(cv, data);
        var legend = document.createElement('div');
        legend.style.cssText = 'font-size:8px;color:rgba(180,200,220,0.4);margin-top:4px;line-height:1.8';
        var PERIOD_COLS = {Breakfast:'rgb(0,210,200)',Lunch:'rgb(60,200,80)',Afternoon:'rgb(200,160,40)',Evening:'rgb(120,90,220)',Overnight:'rgb(140,160,180)'};
        legend.innerHTML = Object.keys(PERIOD_COLS).map(function(p){
          return '<span style="color:' + PERIOD_COLS[p] + ';cursor:pointer;margin-right:8px" data-period="' + p + '">' + p.slice(0,3) + '</span>';
        }).join('');
        isfBody.appendChild(legend);
        legend.addEventListener('click', function(e){ var sp = e.target.closest('[data-period]'); if(sp) { data.highlightedPeriod = data.highlightedPeriod===sp.dataset.period?null:sp.dataset.period; drawISFDriftChart(cv,data); } });
        window._isfHighlight = function(period) {
          data.highlightedPeriod = data.highlightedPeriod === period ? null : period;
          drawISFDriftChart(cv, data);
        };
        // Dashed = programmed ISF note
        var note = document.createElement('div');
        note.style.cssText = 'font-size:8px;color:rgba(180,200,220,0.3);margin-top:3px';
        note.textContent = '--- programmed ISF · dots = observations';
        isfBody.appendChild(note);
      });
    }
  });
  isfDiv.appendChild(isfToggle);
  isfDiv.appendChild(isfBody);
  el.appendChild(isfDiv);

  // ── Patterns sub-section ────────────────────────────────────────────────
  var patDiv = document.createElement('div');
  patDiv.style.cssText = 'margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.08)';
  var patOpen = false;
  var patToggle = document.createElement('div');
  patToggle.style.cssText = 'display:flex;justify-content:space-between;align-items:center;cursor:pointer;user-select:none';
  patToggle.innerHTML =
    '<div style="font-size:8px;letter-spacing:1px;text-transform:uppercase;color:rgba(255,180,80,0.7)">Patterns</div>' +
    '<span id="pat-toggle-icon" style="font-size:10px;color:rgba(255,180,80,0.4)">▼</span>';
  var patBody = document.createElement('div');
  patBody.id = 'pattern-lib-body';
  patBody.style.display = 'none';
  patToggle.addEventListener('click', function() {
    patOpen = !patOpen;
    patBody.style.display = patOpen ? 'block' : 'none';
    document.getElementById('pat-toggle-icon').textContent = patOpen ? '▲' : '▼';
    if (patOpen && !patBody.dataset.loaded) {
      patBody.dataset.loaded = '1';
      patBody.innerHTML = '<div style="font-size:9px;color:rgba(180,200,180,0.4);margin-top:6px">loading…</div>';
      _loadPatternLibrary().then(function(patterns) {
        if (!patterns.length) { patBody.innerHTML = '<div style="font-size:9px;color:rgba(180,200,180,0.3);margin-top:6px">no patterns yet — more data needed</div>'; return; }
        var statusIcons = { emerging: '◌', confirmed: '●', superseded: '○' };
        patBody.innerHTML = patterns.map(function(p) {
          var icon = statusIcons[p.status] || '◌';
          var col = p.status === 'confirmed' ? 'rgba(62,200,140,0.8)' : p.status === 'superseded' ? 'rgba(120,130,140,0.4)' : 'rgba(220,160,60,0.7)';
          return '<div style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:9px;line-height:1.6">' +
            '<span style="color:' + col + ';margin-right:6px">' + icon + '</span>' +
            '<span style="color:rgba(200,220,200,0.8)">' + (p.name||'') + '</span>' +
            (p.clinical_note ? '<div style="color:rgba(180,200,180,0.4);font-size:8px;padding-left:16px">' + p.clinical_note + '</div>' : '') +
            '<div style="color:rgba(140,160,140,0.3);font-size:7px;padding-left:16px">' + JSON.stringify(p.parameters||{}).slice(0,80) + '</div>' +
          '</div>';
        }).join('');
      });
    }
  });
  patDiv.appendChild(patToggle);
  patDiv.appendChild(patBody);
  el.appendChild(patDiv);

  document.body.appendChild(el);
  if (window.__updateDebugPanel) window.__updateDebugPanel();
  loadDebugBacklog('open');
}




// ── BACKFILL PROGRESS BAR ─────────────────────────────────────────────────
var _backfillHighlightDate = null;
function _renderBackfillBar(canvas, statsEl) {
  if (!canvas) return;
  var startDate = new Date('2026-01-10');
  var today = new Date();
  var totalDays = Math.floor((today - startDate) / 86400000) + 1;
  var CW = canvas.width || 400;
  var CH = canvas.height || 16;
  var ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, CW, CH);

  var counts = { teal: 0, green: 0, grey: 0, dark: 0 };

  for (var di = 0; di < totalDays; di++) {
    var dayT = startDate.getTime() + di * 86400000;
    var dateStr2 = new Date(dayT).toISOString().slice(0, 10);
    var comp = _computeDayCompleteness(dateStr2);
    var col;
    if (comp.score >= 3) { col = '#0F766E'; counts.teal++; }
    else if (comp.score >= 1) { col = '#22C55E'; counts.green++; }
    else {
      // Check if any CGM readings that day
      var hasReadings = HISTORY_RAW.some(function(r){ return r.t >= dayT && r.t < dayT + 86400000; });
      if (hasReadings) { col = '#CBD5E1'; counts.grey++; }
      else { col = '#1E293B'; counts.dark++; }
    }
    var x = Math.round(di / totalDays * CW);
    var w = Math.max(1, Math.round((di + 1) / totalDays * CW) - x);
    ctx.fillStyle = col;
    ctx.fillRect(x, 0, w, CH);
  }

  if (statsEl) {
    statsEl.textContent = counts.teal + ' fully logged · ' + counts.green + ' partial · ' + counts.grey + ' CGM only · ' + counts.dark + ' gaps';
  }

  canvas.addEventListener('click', function(e) {
    var rect = canvas.getBoundingClientRect();
    var px = e.clientX - rect.left;
    var frac = px / rect.width;
    var dayIdx = Math.floor(frac * totalDays);
    var dayT2 = startDate.getTime() + dayIdx * 86400000;
    var dateStr3 = new Date(dayT2).toISOString().slice(0,10);
    var comp2 = _computeDayCompleteness(dateStr3);
    var dayReadings2 = HISTORY_RAW.filter(function(r){ return r.t >= dayT2 && r.t < dayT2 + 86400000; });
    var dayGhosts2 = _ghostPebbles.filter(function(g){ return g.t >= dayT2 && g.t < dayT2 + 86400000; });
    showToast(dateStr3 + '\n' + comp2.label + ' · ' + dayReadings2.length + ' readings · ' + dayGhosts2.length + ' ghosts');
    // Jump to midday of that date
    viewTime = dayT2 + 12 * 3600000;
    _isAtNow = false;
  });
}

function _jumpToNextGap() {
  var startDate2 = new Date('2026-01-10');
  var today2 = new Date();
  var totalDays2 = Math.floor((today2 - startDate2) / 86400000) + 1;
  for (var di2 = 0; di2 < totalDays2; di2++) {
    var dayT3 = startDate2.getTime() + di2 * 86400000;
    var hasReadings3 = HISTORY_RAW.some(function(r){ return r.t >= dayT3 && r.t < dayT3 + 86400000; });
    if (!hasReadings3) {
      viewTime = dayT3 + 12 * 3600000;
      _isAtNow = false;
      showToast('jumped to gap: ' + new Date(dayT3).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}));
      // Close debug panel
      var dp = document.getElementById('debug-panel');
      if (dp) dp.remove();
      return;
    }
  }
  showToast('no gaps found — great backfill!');
}

// ── RIVER HEALTH PANEL RENDERER ────────────────────────────────────────────
async function _renderRiverHealth(container) {
  container.innerHTML = '<div style="font-size:9px;color:rgba(180,200,180,0.4)">loading…</div>';
  try {
    var now = Date.now();
    var day7 = now - 7 * 86400000;

    // ── 4a Engagement ──────────────────────────────────────────────────────
    var todayStr = new Date().toISOString().slice(0, 10);
    var dayStart4 = new Date(todayStr).getTime();
    var mealsToday = (MEAL_HISTORY||[]).filter(function(m){ return m.t >= dayStart4; }).length;
    var meals7day  = (MEAL_HISTORY||[]).filter(function(m){ return m.t >= day7; }).length;
    var mealsAll   = (MEAL_HISTORY||[]).length;

    // Logging streak
    var streak = 0;
    var streakDate = new Date();
    for (var sd = 0; sd < 90; sd++) {
      var sDateStr = new Date(streakDate.getTime() - sd * 86400000).toISOString().slice(0,10);
      var sDayStart = new Date(sDateStr).getTime();
      var hasMeal = (MEAL_HISTORY||[]).some(function(m){ return m.t >= sDayStart && m.t < sDayStart + 86400000; });
      if (hasMeal) streak++;
      else break;
    }

    // Items per meal 7-day
    var mealsWith7 = (MEAL_HISTORY||[]).filter(function(m){ return m.t >= day7 && m.items && m.items.length; });
    var avgItems = mealsWith7.length > 0
      ? (mealsWith7.reduce(function(s,m){return s+(m.items||[]).length;},0) / mealsWith7.length).toFixed(1)
      : '—';

    // Source split
    var sources = {};
    (MEAL_HISTORY||[]).filter(function(m){return m.t >= day7;}).forEach(function(m){
      var src = m.source || 'manual';
      sources[src] = (sources[src] || 0) + 1;
    });
    var totalSrc = Object.values(sources).reduce(function(s,v){return s+v;},0) || 1;

    // ── 4b Model Maturity ──────────────────────────────────────────────────
    var periods = ['Breakfast','Lunch','Afternoon','Evening','Overnight'];
    var periodCounts = {};
    var bolusOutRows = [];
    try {
      bolusOutRows = await _sbFetch('bolus_outcomes?select=period,observed_isf&order=t.desc&limit=500', { method: 'GET' });
      if (!Array.isArray(bolusOutRows)) bolusOutRows = [];
    } catch(e2) { bolusOutRows = []; }
    bolusOutRows.forEach(function(r) {
      if (!r.period) return;
      periodCounts[r.period] = (periodCounts[r.period] || 0) + 1;
    });

    // RMSE trend
    var rmse7 = null, rmse14 = null;
    try {
      var mRows = await _sbFetch('model_accuracy?date=gte.' + new Date(day7).toISOString().slice(0,10) + '&select=meal_rmse,date', { method: 'GET' });
      if (Array.isArray(mRows) && mRows.length > 0) {
        var rmsVals = mRows.map(function(r){return r.meal_rmse;}).filter(Boolean);
        rmse7 = rmsVals.length ? +(rmsVals.reduce(function(s,v){return s+v;},0)/rmsVals.length).toFixed(3) : null;
      }
      var mRows14 = await _sbFetch('model_accuracy?date=gte.' + new Date(now - 14*86400000).toISOString().slice(0,10) + '&date=lt=' + new Date(day7).toISOString().slice(0,10) + '&select=meal_rmse', { method: 'GET' });
      if (Array.isArray(mRows14) && mRows14.length > 0) {
        var rmsVals14 = mRows14.map(function(r){return r.meal_rmse;}).filter(Boolean);
        rmse14 = rmsVals14.length ? +(rmsVals14.reduce(function(s,v){return s+v;},0)/rmsVals14.length).toFixed(3) : null;
      }
    } catch(e3) {}

    // ── 4c Override Analysis ──────────────────────────────────────────────
    var overrideRows = [];
    try {
      overrideRows = await _sbFetch('events?override_type=in.(direction,true)&select=t,override_type,override_dir&limit=300', { method: 'GET' });
      if (!Array.isArray(overrideRows)) overrideRows = [];
    } catch(e4) {}
    var overridePeriods = {};
    overrideRows.forEach(function(ev) {
      if (ev.override_type !== 'direction') return;
      var h2 = new Date(ev.t).getHours();
      var p2 = h2 >= 6 && h2 < 10 ? 'Breakfast' : h2 >= 10 && h2 < 14 ? 'Lunch' :
               h2 >= 14 && h2 < 18 ? 'Afternoon' : h2 >= 18 && h2 < 22 ? 'Evening' : 'Overnight';
      if (!overridePeriods[p2]) overridePeriods[p2] = { up: 0, down: 0 };
      if (ev.override_dir === 'up') overridePeriods[p2].up++;
      else overridePeriods[p2].down++;
    });
    var trueOverride30 = overrideRows.filter(function(ev){ return ev.override_type === 'true' && ev.t >= now - 30*86400000; }).length;

    // ── Render ───────────────────────────────────────────────────────────────
    var mono = "font-family:DM Mono,monospace;font-size:9px";
    var dim  = "color:rgba(180,200,180,0.45)";
    var bright = "color:rgba(200,220,200,0.85)";

    function section4(title, content) {
      return '<div style="margin-bottom:10px">' +
        '<div style="' + mono + ';font-size:7px;letter-spacing:1px;text-transform:uppercase;color:rgba(62,207,160,0.5);margin-bottom:5px">' + title + '</div>' +
        content + '</div>';
    }

    var srcBars = Object.keys(sources).map(function(k) {
      var pct = Math.round(sources[k]/totalSrc*100);
      return '<span style="' + mono + ';' + dim + ';margin-right:6px">' + k + ' ' + pct + '%</span>';
    }).join('');

    var engHtml = 
      '<div style="' + mono + ';' + bright + '">meals: <b>' + mealsToday + '</b> today · <b>' + meals7day + '</b> 7d · <b>' + mealsAll + '</b> all</div>' +
      '<div style="' + mono + ';' + dim + ';margin-top:2px">🔥 ' + streak + ' day streak · ' + avgItems + ' items/meal</div>' +
      (srcBars ? '<div style="margin-top:3px">' + srcBars + '</div>' : '');

    var matHtml = periods.map(function(p3) {
      var n3 = periodCounts[p3] || 0;
      var pct3 = Math.min(10, n3);
      var bars = '■'.repeat(pct3) + '□'.repeat(Math.max(0, 10 - pct3));
      var active = n3 >= MIN_OUTCOMES_FOR_ADAPTATION;
      var colP = active ? 'rgba(62,200,140,0.8)' : 'rgba(200,180,60,0.6)';
      return '<div style="' + mono + ';' + dim + ';margin-bottom:2px">' +
        '<span style="min-width:70px;display:inline-block">' + p3 + '</span>' +
        '<span style="color:' + colP + ';letter-spacing:0">' + bars + '</span>' +
        ' ' + n3 + '/10' +
        (active ? ' <span style="color:rgba(62,200,140,0.7)">ACTIVE</span>' : '') + '</div>';
    }).join('');

    // ISF divergence table
    var isfObs = {};
    var byPer3 = {};
    bolusOutRows.forEach(function(r) { if (!r.period || !r.observed_isf) return; if (!byPer3[r.period]) byPer3[r.period] = []; byPer3[r.period].push(r.observed_isf); });
    Object.keys(byPer3).forEach(function(p4) { var vals4 = byPer3[p4]; var m4 = vals4.reduce(function(s,v){return s+v;},0)/vals4.length; isfObs[p4] = { mean: +m4.toFixed(2), count: vals4.length }; });

    var isfTable = periods.map(function(p5) {
      var obs5 = isfObs[p5];
      var obsStr = (obs5 && obs5.count >= 3) ? obs5.mean.toFixed(2) : '—';
      var prog5 = getISF(new Date().setHours(['Breakfast','Lunch','Afternoon','Evening','Overnight'].indexOf(p5) < 3 ? 8 : p5==='Evening'?19:2, 0, 0, 0));
      var delta5 = (obs5 && obs5.count >= 3) ? (obs5.mean - prog5).toFixed(2) : '—';
      var deltaCol = delta5 !== '—' ? (parseFloat(delta5) > 0.5 ? 'rgba(240,150,60,0.8)' : 'rgba(62,200,140,0.6)') : dim;
      return '<div style="display:grid;grid-template-columns:70px 40px 40px 40px;' + mono + ';' + dim + ';margin-bottom:2px">' +
        '<span>' + p5.slice(0,3) + '</span>' +
        '<span>' + prog5.toFixed(1) + '</span>' +
        '<span>' + obsStr + '</span>' +
        '<span style="color:' + deltaCol + '">' + (delta5 !== '—' ? (parseFloat(delta5)>0?'+':'') + delta5 : '—') + '</span>' +
      '</div>';
    }).join('');

    var rmseArrow = (rmse7 && rmse14) ? (rmse7 < rmse14 ? ' ↓' : ' ↑') : '';
    var rmseStr = rmse7 ? rmse7.toFixed(3) + rmseArrow : '—';
    matHtml += '<div style="margin-top:6px;' + mono + ';' + dim + ';font-size:7px;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:3px">ISF Period | Prog | Obs | Δ</div>' + isfTable;
    matHtml += '<div style="margin-top:6px;' + mono + ';' + dim + '">7d RMSE: <b style="' + bright + '">' + rmseStr + '</b></div>';

    var ovHtml = Object.keys(overridePeriods).map(function(p6) {
      var oc = overridePeriods[p6];
      var tot6 = oc.up + oc.down;
      if (tot6 < 3) return '';
      var pctDown6 = Math.round(oc.down / tot6 * 100);
      var pctUp6   = Math.round(oc.up   / tot6 * 100);
      var bias = pctDown6 > pctUp6 ? pctDown6 + '% ↓' : pctUp6 + '% ↑';
      var flag = (pctDown6 > 65 || pctUp6 > 65)
        ? '<div style="' + mono + ';font-size:7px;color:rgba(240,160,60,0.7);padding-left:8px">→ may reflect calculator miscalibration</div>'
        : '';
      return '<div style="' + mono + ';' + dim + ';margin-bottom:2px">' + p6 + ': <b>' + bias + '</b> at ' + p6 + '</div>' + flag;
    }).filter(Boolean).join('');
    ovHtml += '<div style="' + mono + ';' + dim + ';margin-top:4px">true overrides (30d): <b>' + trueOverride30 + '</b></div>';
    if (!ovHtml.trim()) ovHtml = '<div style="' + dim + ';' + mono + '">no override data yet</div>';

    container.innerHTML =
      section4('Engagement', engHtml) +
      section4('Model Maturity', matHtml) +
      section4('Override Analysis', ovHtml);

  } catch(e) {
    container.innerHTML = '<div style="font-size:9px;color:rgba(220,80,60,0.6)">error loading health: ' + e.message.slice(0,60) + '</div>';
    console.warn('[riverHealth]', e.message);
  }
}

// ── BACKLOG — fetch and render backlog items in debug panel ──────────
var _blqFilter = 'open';
async function loadDebugBacklog(filter) {
  _blqFilter = filter || _blqFilter;
  var el = document.getElementById('backlog-list');
  if (!el) return;
  el.textContent = 'loading…';
  try {
    var qs = _blqFilter === 'p0'
      ? '?select=id,title,priority,status,type,session_id&priority=eq.p0&status=eq.open&order=created_at.asc'
      : _blqFilter === 'done'
        ? '?select=id,title,priority,status,type,session_id&status=eq.done&order=updated_at.desc&limit=10'
        : '?select=id,title,priority,status,type,session_id&status=in.(open,in_session)&order=priority.asc,created_at.asc';
    var r = await fetch(SUPABASE_URL + '/rest/v1/backlog' + qs, {
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }
    });
    if (!r.ok) throw new Error(await r.text());
    var items = await r.json();
    if (!items.length) { el.textContent = 'none'; return; }
    var priColor = { p0: 'rgba(220,80,60,0.9)', p1: 'rgba(220,160,40,0.9)', p2: 'rgba(80,150,220,0.9)', future: 'rgba(120,120,120,0.7)' };
    el.innerHTML = items.map(function(item) {
      var done = ['done','deferred','wont_do'].includes(item.status);
      return '<div style="display:flex;align-items:baseline;gap:6px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.04)">' +
        '<span style="color:' + (priColor[item.priority]||'#aaa') + ';min-width:22px;font-size:8px">' + item.priority + '</span>' +
        '<span style="flex:1;' + (done ? 'opacity:0.4;text-decoration:line-through;' : '') + '">' + item.title + '</span>' +
        (item.session_id ? '<span style="color:rgba(62,207,160,0.4);font-size:8px">' + item.session_id + '</span>' : '') +
        (!done ? '<button onclick="markBacklogDone(\'' + item.id + '\')" style="padding:1px 5px;border-radius:3px;border:1px solid rgba(62,207,160,0.2);background:none;color:rgba(62,207,160,0.6);font-family:monospace;font-size:8px;cursor:pointer">✓</button>' : '') +
      '</div>';
    }).join('');
  } catch(e) {
    if (el) el.textContent = 'error: ' + e.message.slice(0, 60);
  }
}
async function markBacklogDone(id) {
  await fetch(SUPABASE_URL + '/rest/v1/backlog?id=eq.' + id, {
    method: 'PATCH',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify({ status: 'done' })
  });
  loadDebugBacklog();
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
// ═══════════════════════════════════════════════════════════════════════
//  CONTEXT CARD — full event story panel
//  Tap any chip on the river to see the full context of that moment:
//  what led up to it, what happened next, cognitive load breakdown,
//  meal items with GI/GL, prediction vs actual curves, ghosts, and
//  what River suggested at that point.
// ═══════════════════════════════════════════════════════════════════════

function openContextCard(eventIdx, chipData) {
  // ── Re-resolve eventIdx by timestamp ────────────────────────────────
  // LOGGED_EVENTS is mutated in place (splice on sync/delete, push on new
  // local entries). An idx captured when a chip was drawn — or when the
  // recent-entries list was built — can go stale by the time the user taps
  // it, pointing at the wrong event or past the end of the array.
  // chipData.t is stable, so use it to find the current correct index.
  if (chipData && chipData.t != null) {
    var _freshIdx = LOGGED_EVENTS.findIndex(function(e){ return e.t === chipData.t; });
    if (_freshIdx < 0) {
      // The event this chip pointed to no longer exists (e.g. removed by
      // sync as a duplicate/stale row). Don't fall back to the original
      // eventIdx — it may now point at an unrelated event. Tell the user
      // instead of failing silently.
      showToast('that entry was just updated\\nrefreshing…');
      return;
    }
    eventIdx = _freshIdx;
  }
  var ev = LOGGED_EVENTS[eventIdx];
  if (!ev) return;

  // Remove any existing context card
  var ex = document.getElementById('ctx-card-overlay');
  if (ex) ex.remove();

  var t = ev.t;
  var dt = new Date(t);
  var timeStr = dt.toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'});
  var dateStr = dt.toLocaleDateString('en-GB', {weekday:'short', day:'numeric', month:'short'});
  var h = dt.getHours();
  var period = h < 6 ? 'Overnight' : h < 10 ? 'Breakfast' : h < 14 ? 'Lunch' : h < 18 ? 'Afternoon' : h < 22 ? 'Evening' : 'Overnight';

  // ── Classify event type ────────────────────────────────────────────
  var isHypo       = ev.note && ev.note.indexOf('hypo') === 0;
  var isMealBolus  = ev.c > 0 && ev.u > 0;
  var isCarbOnly   = ev.c > 0 && !ev.u;
  var isBolus      = ev.u > 0 && !ev.c;
  // Quick-look paired carb detection: if this is a pure bolus chip and there
  // is a carb chip within 30min after it, it's a meal bolus not a correction.
  var _hasPairedCarbAhead = isBolus && BOLUS_EVENTS.some(function(e) {
    return e.c > 0 && !e.u && e.t > t && (e.t - t) <= 30 * 60000;
  });
  var isCorrection = isBolus && !_hasPairedCarbAhead && (ev.note === 'correction' || ev.note === 'bolus');
  var isMealBolusOrPairedBolus = isMealBolus || _hasPairedCarbAhead;
  var isMeal       = isMealBolusOrPairedBolus || (isCarbOnly && !isHypo);
  var isPrick      = ev.note === 'prick';

  // Carb-only events: use time period as label (not generic "Snack")
  var _carbOnlyLabel = period === 'Breakfast' ? 'Breakfast' :
                       period === 'Lunch'     ? 'Lunch'     :
                       period === 'Afternoon' ? 'Snack'     :
                       period === 'Evening'   ? 'Dinner'    : 'Snack';

  var typeLabel, typeIcon, typeColor;
  if (isHypo)                    { typeLabel='Hypo Treatment'; typeIcon='🍬'; typeColor='rgba(255,210,40,0.9)'; }
  else if (isMealBolusOrPairedBolus) { typeLabel='Meal + Bolus'; typeIcon='🍽'; typeColor='rgba(255,140,50,0.9)'; }
  else if (isCarbOnly)           { typeLabel=_carbOnlyLabel; typeIcon='🍽'; typeColor='rgba(255,160,60,0.8)'; }
  else if (isCorrection)         { typeLabel='Correction'; typeIcon='💉'; typeColor='rgba(60,130,220,0.9)'; }
  else if (isBolus)              { typeLabel='Bolus'; typeIcon='💉'; typeColor='rgba(60,130,220,0.9)'; }
  else if (isPrick)              { typeLabel='Blood Prick'; typeIcon='🩸'; typeColor='rgba(220,60,60,0.9)'; }
  else                           { typeLabel='Event'; typeIcon='·'; typeColor='rgba(180,200,220,0.8)'; }

  // ── Context data ───────────────────────────────────────────────────
  var d        = dataAt(t);
  var bgNow    = d.bg;
  // Prior IOB: use dataAt(t-1) to exclude this event's own insulin from the reading.
  // dataAt(t) includes the event at t because iobF(0)=1 — showing the bolus itself as IOB.
  var _dPrior  = dataAt(t - 1);
  var iobNow   = _dPrior.iob;
  var cobNow   = _dPrior.cob;

  // ── Paired bolus detection ─────────────────────────────────────────
  // A carb chip (c>0, u=0) is always spawned at bolusT + waitMins*60000.
  // The bolus chip (u>0, c=0) that owns this meal sits earlier by exactly
  // that wait. Find it so we can surface it as part of the event, not as
  // a preceding event.
  var pairedBolus = null;
  if (ev.c > 0 && !ev.u) {
    // Search BOLUS_EVENTS for a bolus within 30 min before this carb event
    // that has no carbs (pure bolus chip). Prefer the closest one.
    var candidates = BOLUS_EVENTS.filter(function(e) {
      return e.u > 0 && !e.c && e.t < t && (t - e.t) <= 30 * 60000;
    });
    if (candidates.length > 0) {
      pairedBolus = candidates.reduce(function(best, e) {
        return (!best || Math.abs(e.t - t) < Math.abs(best.t - t)) ? e : best;
      }, null);
    }
  }
  // If this is a bolus chip (u>0, c=0), look ahead for its paired carb chip
  var pairedCarb = null;
  if (ev.u > 0 && !ev.c) {
    var carbCandidates = BOLUS_EVENTS.filter(function(e) {
      return e.c > 0 && !e.u && e.t > t && (e.t - t) <= 30 * 60000;
    });
    if (carbCandidates.length > 0) {
      pairedCarb = carbCandidates.reduce(function(best, e) {
        return (!best || Math.abs(e.t - t) < Math.abs(best.t - t)) ? e : best;
      }, null);
    }
  }

  // Meal items — from event directly, or from paired carb event
  var mealItems = (ev.items && ev.items.length) ? ev.items
    : (pairedCarb && pairedCarb.items && pairedCarb.items.length) ? pairedCarb.items
    : [];

  // The wait mins: stored on the bolus event or inferred from the gap
  var waitMinsDisplay = ev.waitMins != null ? ev.waitMins
    : pairedBolus ? Math.round((t - pairedBolus.t) / 60000)
    : pairedCarb  ? Math.round((pairedCarb.t - t) / 60000)
    : null;

  // BG at bolus time (for paired bolus context)
  var bolusT = pairedBolus ? pairedBolus.t : (pairedCarb ? t : t);
  var dAtBolus = pairedBolus ? dataAt(pairedBolus.t) : d;

  // Preceding and following events (±90 min), excluding the paired bolus/carb
  var lookback = 90 * 60000;
  var lookahead = 90 * 60000;
  var _pairedTs = new Set();
  if (pairedBolus) _pairedTs.add(pairedBolus.t);
  if (pairedCarb)  _pairedTs.add(pairedCarb.t);

  var precedingEvts = BOLUS_EVENTS.filter(function(e) {
    return e.t < t && e.t >= t - lookback && (e.c > 0 || e.u > 0) && !_pairedTs.has(e.t);
  }).sort(function(a,b){ return b.t - a.t; });

  var followingEvts = BOLUS_EVENTS.filter(function(e) {
    return e.t > t && e.t <= t + lookahead && (e.c > 0 || e.u > 0) && !_pairedTs.has(e.t);
  }).sort(function(a,b){ return a.t - b.t; });

  // Ghosts within ±60min
  var nearbyGhosts = (_ghostPebbles || []).filter(function(g) {
    return Math.abs(g.t - t) <= 60 * 60000;
  });

  // MEAL_HISTORY enrichment (peak_bg, rmse, items, therapy_snapshot)
  var mealRec = null;
  if (isMeal || isMealBolus) {
    mealRec = (MEAL_HISTORY || []).find(function(m) { return Math.abs(m.t - t) < 5 * 60000; });
  }

  // ── Cognitive load score ─────────────────────────────────────────
  var clFactors = [];
  var clScore = 0;
  if (h < 6 || h >= 22)                     { clFactors.push({label:'Overnight', val:1, color:'rgba(120,140,220,0.7)'}); clScore+=1; }
  var corrIob = iobNow; // rough — actual correction IOB not split here
  if (iobNow > 1.0)                          { clFactors.push({label:'IOB stacking risk (>1U)', val:2, color:'rgba(60,130,220,0.8)'}); clScore+=2; }
  else if (iobNow > 0.3)                     { clFactors.push({label:'Correction IOB active', val:2, color:'rgba(60,130,220,0.6)'}); clScore+=2; }
  if (bgNow < 3.9)                           { clFactors.push({label:'Hypo active', val:2, color:'rgba(255,210,40,0.9)'}); clScore+=2; }
  var recentCorr = precedingEvts.find(function(e){ return e.u>0 && !e.c && (t-e.t)<90*60000; });
  if (recentCorr)                            { clFactors.push({label:'Correction in last 90min', val:1, color:'rgba(60,130,220,0.6)'}); clScore+=1; }
  if (nearbyGhosts.length > 0)              { clFactors.push({label:'Ghost event nearby', val:1, color:'rgba(180,160,240,0.7)'}); clScore+=1; }
  if (cobNow > 30)                           { clFactors.push({label:'High COB (>30g absorbing)', val:1, color:'rgba(255,140,50,0.7)'}); clScore+=1; }
  clScore = Math.min(10, clScore);
  var clColor = clScore >= 7 ? 'rgba(220,60,60,0.8)' : clScore >= 4 ? 'rgba(200,140,30,0.8)' : 'rgba(62,180,120,0.8)';

  // ── Suggested / audit trail ───────────────────────────────────────
  var hasSuggestion = ev.suggested_units || ev.override_type;
  var suggHtml = '';
  if (hasSuggestion) {
    var sug = ev.suggested_units ? ev.suggested_units.toFixed(1) + 'U' : '—';
    var del = ev.u ? ev.u.toFixed(1) + 'U' : '—';
    var overrideTxt = '';
    if (ev.override_type === 'forced')    overrideTxt = '<span style="color:rgba(62,180,120,0.7)">· rounding only</span>';
    if (ev.override_type === 'direction') overrideTxt = '<span style="color:rgba(200,140,30,0.7)">· chose ' + (ev.override_dir||'') + ' rounding</span>';
    if (ev.override_type === 'true')      overrideTxt = '<span style="color:rgba(220,80,60,0.8)">· deliberate override ' + (ev.override_dir==='up'?'↑':'↓') + (ev.override_mag?(' '+ev.override_mag+'U'):'') + '</span>';
    suggHtml = '<div style="margin-bottom:4px"><span style="color:rgba(180,200,220,0.5);font-size:9px">suggested </span><span style="color:rgba(180,200,220,0.85)">' + sug + '</span>'
      + '&nbsp;&nbsp;<span style="color:rgba(180,200,220,0.5);font-size:9px">given </span><span style="color:rgba(180,200,220,0.85)">' + del + '</span>'
      + '&nbsp;&nbsp;' + overrideTxt + '</div>';
    // Wait suggestion
    if (ev.waitMins != null) {
      var ws = typeof suggestEatWait === 'function' ? suggestEatWait(bgNow, ev.gi) : null;
      if (ws != null) {
        suggHtml += '<div style="font-size:9px;color:rgba(180,200,220,0.4)">wait suggested: ' + ws + 'min · actual: ' + (ev.waitMins||0) + 'min</div>';
      }
    }
  }

  // ── Inline CGM curve SVG (−60min to +90min window) ───────────────
  function _buildCurveSVG() {
    var winBack = 60 * 60000, winFwd = 90 * 60000;
    var pts = (HISTORY_RAW || []).filter(function(r){ return r.t >= t - winBack && r.t <= t + winFwd && r.bg > 0; });
    if (pts.length < 3) return '';
    var W3 = 290, H5 = 52, PAD3 = 6;
    var tMin3 = t - winBack, tMax3 = t + winFwd;
    var bgVals = pts.map(function(p){ return p.bg; });
    var bgMin3 = Math.max(2, Math.min.apply(null,bgVals) - 0.5);
    var bgMax3 = Math.min(18, Math.max.apply(null,bgVals) + 0.5);
    if (bgMax3 === bgMin3) bgMax3 = bgMin3 + 2;
    function sx3(ts){ return PAD3 + (ts-tMin3)/(tMax3-tMin3)*(W3-PAD3*2); }
    function sy3(bg){ return PAD3 + (1-(bg-bgMin3)/(bgMax3-bgMin3))*(H5-PAD3*2); }
    var pathD3 = pts.map(function(p,i){ return (i===0?'M':'L')+sx3(p.t).toFixed(1)+','+sy3(p.bg).toFixed(1); }).join(' ');
    var evX = sx3(t).toFixed(1);
    var bandY1 = sy3(Math.min(bgMax3,10)).toFixed(1);
    var bandY2 = sy3(Math.max(bgMin3,3.9)).toFixed(1);
    // Predicted curve from meal record
    var predPath = '';
    if (mealRec && mealRec.predicted_curve && mealRec.predicted_curve.length > 1) {
      var predPts = mealRec.predicted_curve.filter(function(p){ return p.mins != null && p.predicted_bg != null; });
      if (predPts.length > 1) {
        predPath = predPts.map(function(p,i){
          var ptT = t + p.mins * 60000;
          return (i===0?'M':'L') + sx3(ptT).toFixed(1) + ',' + sy3(p.predicted_bg).toFixed(1);
        }).join(' ');
      }
    }
    return '<svg width="'+W3+'" height="'+H5+'" style="display:block;overflow:visible;margin-top:4px">' +
      '<rect x="'+PAD3+'" y="'+bandY1+'" width="'+(W3-PAD3*2)+'" height="'+(parseFloat(bandY2)-parseFloat(bandY1))+'" fill="rgba(62,180,120,0.07)" rx="2"/>' +
      (predPath ? '<path d="'+predPath+'" fill="none" stroke="rgba(140,180,240,0.35)" stroke-width="1.5" stroke-dasharray="3,3"/>' : '') +
      '<path d="'+pathD3+'" fill="none" stroke="rgba(62,180,120,0.8)" stroke-width="1.5" stroke-linecap="round"/>' +
      '<line x1="'+evX+'" y1="'+PAD3+'" x2="'+evX+'" y2="'+(H5-PAD3)+'" stroke="rgba(255,255,255,0.25)" stroke-width="1" stroke-dasharray="2,3"/>' +
      '<text x="'+PAD3+'" y="'+(H5-1)+'" font-size="7" fill="rgba(160,180,200,0.4)" font-family="DM Mono,monospace">−60min</text>' +
      '<text x="'+(W3-PAD3)+'" y="'+(H5-1)+'" font-size="7" fill="rgba(160,180,200,0.4)" font-family="DM Mono,monospace" text-anchor="end">+90min</text>' +
      '</svg>';
  }

  // ── Helper: render a linked event row ─────────────────────────────
  function _evRow(e, relation) {
    var eDt   = new Date(e.t);
    var eTime = eDt.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
    var diffMins = Math.round(Math.abs(e.t - t) / 60000);
    var diffLabel = relation === 'before' ? diffMins + 'min before' : diffMins + 'min after';
    var isEHypo   = e.note && e.note.indexOf('hypo') === 0;
    var eType = (e.u > 0 && e.c > 0) ? 'meal+bolus' : e.u > 0 ? (e.note==='correction'?'correction':'bolus') : isEHypo ? 'hypo' : 'snack';
    var eBadge = eType === 'correction' ? 'rgba(60,130,220,0.7)' :
                 eType === 'bolus'      ? 'rgba(60,130,220,0.7)' :
                 eType === 'hypo'       ? 'rgba(255,210,40,0.8)' :
                 'rgba(255,140,50,0.7)';
    var eDetail = '';
    if (e.c > 0) eDetail += e.c + 'g';
    if (e.u > 0) eDetail += (eDetail?'·':'')+e.u.toFixed(1)+'U';
    var eBg = dataAt(e.t);
    if (eBg && eBg.bg > 0) eDetail += (eDetail?' · ':'')+eBg.bg.toFixed(1)+' mmol';
    return '<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.04)">' +
      '<span style="font-family:DM Mono,monospace;font-size:9px;color:rgba(180,200,220,0.4);min-width:42px">' + eTime + '</span>' +
      '<span style="font-size:8px;padding:1px 6px;border-radius:8px;background:' + eBadge + ';color:rgba(255,255,255,0.85);font-family:DM Mono,monospace;white-space:nowrap">' + eType + '</span>' +
      '<span style="font-family:DM Mono,monospace;font-size:9px;color:rgba(180,200,220,0.7);flex:1">' + eDetail + '</span>' +
      '<span style="font-family:DM Mono,monospace;font-size:8px;color:rgba(160,180,200,0.35)">' + diffLabel + '</span>' +
      '</div>';
  }

  // ── Prediction confidence per item ───────────────────────────────
  // Derived from: (1) whether GI is user-confirmed vs estimated,
  // (2) how many times this food appears in MEAL_HISTORY with outcome data,
  // (3) RMSE across those meals
  function _itemConfidence(item) {
    var name = (item.name || '').toLowerCase();
    var gi   = item.gi || 55;
    // Find food in library
    var libEntry = (FOOD_LIBRARY || []).find(function(f){ return (f.name||'').toLowerCase() === name; }) ||
                   (FOOD_DB || []).find(function(f){ return (f.name||'').toLowerCase() === name; });
    var giConfirmed = libEntry && libEntry.gi_confirmed;
    // Find historical outcomes for this food
    var withOutcomes = (MEAL_HISTORY || []).filter(function(m) {
      return m.rmse != null && m.items && m.items.some(function(i){ return (i.name||'').toLowerCase() === name; });
    });
    var count = withOutcomes.length;
    var avgRmse = count > 0 ? withOutcomes.reduce(function(s,m){ return s+(m.rmse||0); },0)/count : null;
    // Score: confirmed GI + outcome history
    var conf = giConfirmed ? 0.6 : 0.3;
    if (count >= 10) conf += 0.4;
    else if (count >= 5) conf += 0.3;
    else if (count >= 2) conf += 0.15;
    conf = Math.min(1, conf);
    var label = conf >= 0.8 ? 'high' : conf >= 0.5 ? 'medium' : 'low';
    var color = conf >= 0.8 ? 'rgba(62,180,120,0.8)' : conf >= 0.5 ? 'rgba(200,140,30,0.8)' : 'rgba(180,100,80,0.7)';
    var note  = giConfirmed ? 'GI confirmed' : 'GI estimated';
    if (count > 0) note += ' · ' + count + ' meals logged';
    if (avgRmse != null) note += ' · avg error ' + avgRmse.toFixed(2);
    return { conf: conf, label: label, color: color, note: note };
  }

  // ── Hypo-specific context ─────────────────────────────────────────
  // How long was BG below threshold? What was the nadir? How fast did it recover?
  var hypoContextHtml = '';
  if (isHypo) {
    var hypoBand = (HISTORY_RAW || []).filter(function(r){ return r.bg < 3.9 && Math.abs(r.t - t) < 60*60000; });
    var hypoNadir = hypoBand.length > 0 ? Math.min.apply(null, hypoBand.map(function(r){ return r.bg; })) : bgNow;
    var hypoDurMins = hypoBand.length > 0 ? Math.round(hypoBand.length * 5) : 0; // approx 5min readings
    var hypoType = ev.note ? ev.note.replace('hypo:', '').replace(/_/g,' ') : 'treatment';
    var recoveryReading = (HISTORY_RAW || []).find(function(r){ return r.t > t + 15*60000 && r.bg >= 4.0; });
    var recoveryMins = recoveryReading ? Math.round((recoveryReading.t - t) / 60000) : null;
    hypoContextHtml =
      '<div style="display:grid;grid-template-columns:1fr 1fr ' + (recoveryMins ? '1fr' : '') + ';gap:6px;margin-bottom:8px">' +
        _miniStat('nadir', hypoNadir.toFixed(1) + ' mmol', 'rgba(255,210,40,0.9)') +
        _miniStat('below 3.9', hypoDurMins > 0 ? '~' + hypoDurMins + ' min' : '< 5 min', 'rgba(255,210,40,0.7)') +
        (recoveryMins ? _miniStat('back to 4+', recoveryMins + ' min', 'rgba(62,180,120,0.8)') : '') +
      '</div>' +
      '<div style="font-size:9px;color:rgba(180,200,220,0.5);font-family:DM Mono,monospace;padding:4px 0">' +
        'treatment: ' + hypoType + ' · ' + ev.c + 'g fast carbs' +
      '</div>';
  }

  // ── Prick-specific context ────────────────────────────────────────
  var prickContextHtml = '';
  if (isPrick) {
    var prickBG  = ev.gi || ev.c; // pricks stored as gi field
    var cgmAtPrick = bgNow; // dataAt(t).bg
    var lagDelta = prickBG && cgmAtPrick > 0 ? +(prickBG - cgmAtPrick).toFixed(1) : null;
    var lagLabel = lagDelta == null ? '—'
      : lagDelta > 1.5  ? 'CGM lagging ↓ ' + lagDelta + ' mmol behind'
      : lagDelta < -1.5 ? 'CGM reading ↑ ' + Math.abs(lagDelta) + ' mmol above prick'
      : 'good agreement (< 1.5 mmol)';
    var lagColor = lagDelta == null ? 'rgba(180,200,220,0.4)'
      : Math.abs(lagDelta) > 1.5 ? 'rgba(200,140,30,0.8)' : 'rgba(62,180,120,0.8)';
    prickContextHtml =
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px">' +
        _miniStat('finger prick', prickBG ? prickBG.toFixed(1) + ' mmol' : '—', prickBG < 3.9 ? 'rgba(255,210,40,0.9)' : prickBG > 10 ? 'rgba(220,100,40,0.9)' : 'rgba(62,180,120,0.9)') +
        _miniStat('CGM at same time', cgmAtPrick > 0 ? cgmAtPrick.toFixed(1) + ' mmol' : '—', 'rgba(180,200,220,0.6)') +
      '</div>' +
      '<div style="padding:6px 8px;border-radius:8px;background:rgba(255,255,255,0.03);font-family:DM Mono,monospace;font-size:9px;color:' + lagColor + '">' + lagLabel + '</div>';
  }

  // ── Correction-specific context ───────────────────────────────────
  var corrContextHtml = '';
  if (isCorrection) {
    var corrIsf    = getISF ? getISF(t) : null;
    var corrTarget = getTarget ? getTarget(t) : 6.0;
    var corrExpectedDrop = (corrIsf && ev.u) ? +(ev.u * corrIsf).toFixed(1) : null;
    var corrExpectedNadir = (corrExpectedDrop && bgNow) ? +(bgNow - corrExpectedDrop).toFixed(1) : null;
    // Find actual nadir in next 3h
    var corrActualNadir = null;
    var nadirReadings = (HISTORY_RAW || []).filter(function(r){ return r.t > t && r.t <= t + 3*3600000; });
    if (nadirReadings.length > 0) {
      corrActualNadir = Math.min.apply(null, nadirReadings.map(function(r){ return r.bg; }));
    }
    corrContextHtml =
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:8px">' +
        _miniStat('dose', ev.u ? ev.u.toFixed(1) + 'U' : '—', 'rgba(60,130,220,0.9)') +
        _miniStat('ISF used', corrIsf ? corrIsf.toFixed(1) : '—', 'rgba(180,200,220,0.6)') +
        _miniStat('target', corrTarget ? corrTarget.toFixed(1) + ' mmol' : '—', 'rgba(180,200,220,0.6)') +
      '</div>' +
      (corrExpectedDrop ?
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px">' +
          _miniStat('expected drop', '−' + corrExpectedDrop + ' mmol', 'rgba(60,130,220,0.7)') +
          _miniStat('expected nadir', corrExpectedNadir ? corrExpectedNadir.toFixed(1) + ' mmol' : '—',
            corrExpectedNadir < 3.9 ? 'rgba(255,210,40,0.9)' : corrExpectedNadir < 5.0 ? 'rgba(200,140,30,0.8)' : 'rgba(62,180,120,0.8)') +
        '</div>'
      : '') +
      (corrActualNadir != null ?
        '<div style="padding:6px 8px;border-radius:8px;background:rgba(255,255,255,0.03);font-family:DM Mono,monospace;font-size:9px;margin-bottom:6px">' +
          '<span style="color:rgba(160,180,200,0.4)">actual nadir: </span>' +
          '<span style="color:' + (corrActualNadir < 3.9 ? 'rgba(255,210,40,0.9)' : 'rgba(62,180,120,0.8)') + '">' + corrActualNadir.toFixed(1) + ' mmol</span>' +
          (corrExpectedNadir ? '<span style="color:rgba(160,180,200,0.3)"> · error ' + (corrActualNadir - corrExpectedNadir).toFixed(1) + ' mmol</span>' : '') +
        '</div>'
      : '');
  }


  var itemsHtml = '';
  if (mealItems.length > 0) {
    itemsHtml = mealItems.map(function(item) {
      var gi    = item.gi || 55;
      var carbs = item.carbs || 0;
      var gl    = Math.round((gi * carbs) / 100);
      var giC   = gi >= 70 ? 'rgba(210,80,40,0.8)' : gi >= 55 ? 'rgba(200,140,30,0.8)' : 'rgba(62,180,120,0.8)';
      var conf  = _itemConfidence(item);
      return '<div style="padding:5px 6px;border-radius:6px;background:rgba(255,255,255,0.025);margin-bottom:3px">' +
        '<div style="display:grid;grid-template-columns:1fr 36px 40px 36px;gap:4px;align-items:center">' +
          '<span style="font-family:DM Mono,monospace;font-size:10px;color:rgba(200,220,240,0.85)">' + (item.name||'—') + '</span>' +
          '<span style="font-family:DM Mono,monospace;font-size:9px;color:rgba(255,140,50,0.85);text-align:right">' + carbs.toFixed(1) + 'g</span>' +
          '<span style="font-family:DM Mono,monospace;font-size:9px;color:' + giC + ';text-align:right">GI ' + gi + '</span>' +
          '<span style="font-family:DM Mono,monospace;font-size:9px;color:rgba(180,200,220,0.6);text-align:right">GL ' + gl + '</span>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:5px;margin-top:3px">' +
          '<span style="font-size:7px;padding:1px 5px;border-radius:6px;background:' + conf.color.replace('0.8','0.12') + ';color:' + conf.color + ';font-family:DM Mono,monospace">confidence: ' + conf.label + '</span>' +
          '<span style="font-size:7px;color:rgba(160,180,200,0.3);font-family:DM Mono,monospace">' + conf.note + '</span>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  // ── What happened next — outcome ─────────────────────────────────
  var outcomeHtml = '';
  if (mealRec && mealRec.peak_bg) {
    var peakErr = mealRec.peak_error != null ? mealRec.peak_error.toFixed(1) : null;
    var peakErrTxt = peakErr ? (parseFloat(peakErr) > 0 ? '↑ over by '+peakErr : '↓ under by '+Math.abs(peakErr)) : '';
    var peakErrCol = !peakErr ? '' : Math.abs(parseFloat(peakErr)) < 1 ? 'rgba(62,180,120,0.8)' : Math.abs(parseFloat(peakErr)) < 2 ? 'rgba(200,140,30,0.8)' : 'rgba(220,60,60,0.8)';
    outcomeHtml += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px">' +
      _miniStat('peak BG', mealRec.peak_bg.toFixed(1) + ' mmol', 'rgba(255,140,50,0.8)') +
      _miniStat('predicted', (mealRec.predicted_curve && mealRec.predicted_curve.length ? '~' + (mealRec.predicted_curve[Math.floor(mealRec.predicted_curve.length*0.6)] && mealRec.predicted_curve[Math.floor(mealRec.predicted_curve.length*0.6)].predicted_bg ? mealRec.predicted_curve[Math.floor(mealRec.predicted_curve.length*0.6)].predicted_bg.toFixed(1) : '—') : '—') + ' mmol', 'rgba(140,180,240,0.7)') +
      _miniStat('peak error', peakErrTxt || '—', peakErrCol || 'rgba(180,200,220,0.4)') +
      _miniStat('RMSE', mealRec.rmse != null ? mealRec.rmse.toFixed(2) : '—', 'rgba(180,200,220,0.4)') +
      '</div>';
  }
  // Following linked events
  if (followingEvts.length > 0) {
    outcomeHtml += followingEvts.map(function(e){ return _evRow(e, 'after'); }).join('');
  }
  if (!outcomeHtml) outcomeHtml = '<div style="font-size:9px;color:rgba(160,180,200,0.3);padding:6px 0">no outcome data yet</div>';

  // ── Ghost section ────────────────────────────────────────────────
  var ghostHtml = nearbyGhosts.length > 0
    ? nearbyGhosts.map(function(g) {
        var gTime = new Date(g.t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
        var diffM = Math.round(Math.abs(g.t - t)/60000);
        var gType = (g.ghost_type||'unexplained').replace(/_/g,' ');
        var gDetail = '';
        if (g.implied_carbs) gDetail += 'implied ' + g.implied_carbs + 'g carbs';
        if (g.implied_units) gDetail += (gDetail?' · ':'') + 'implied ' + g.implied_units + 'U';
        if (g.bg_at_detect)  gDetail += (gDetail?' · ':'') + g.bg_at_detect.toFixed(1) + ' mmol at detect';
        return '<div style="padding:6px 8px;border-radius:8px;background:rgba(180,160,240,0.06);border:1px solid rgba(180,160,240,0.15);margin-bottom:5px">' +
          '<div style="display:flex;justify-content:space-between;margin-bottom:2px">' +
            '<span style="font-size:9px;font-family:DM Mono,monospace;color:rgba(180,160,240,0.8)">? ' + gType + '</span>' +
            '<span style="font-size:8px;color:rgba(160,180,200,0.4);font-family:DM Mono,monospace">' + gTime + ' · ' + diffM + 'min ' + (g.t < t ? 'before' : 'after') + '</span>' +
          '</div>' +
          (gDetail ? '<div style="font-size:9px;color:rgba(180,160,240,0.6);font-family:DM Mono,monospace">' + gDetail + '</div>' : '') +
          (g.confirmed_note ? '<div style="font-size:9px;color:rgba(160,180,200,0.4);font-family:DM Mono,monospace;margin-top:3px">' + g.confirmed_note + '</div>' : '') +
          '</div>';
      }).join('')
    : '<div style="font-size:9px;color:rgba(160,180,200,0.3);padding:4px 0">no unexplained events nearby</div>';

  // ── Build collapsible section helper ─────────────────────────────
  var _secCount = 0;
  function _section(title, content, defaultOpen) {
    var id = 'ctx-sec-' + (++_secCount);
    return '<div style="border-bottom:1px solid rgba(255,255,255,0.05);padding-bottom:2px;margin-bottom:2px">' +
      '<button onclick="(function(){var c=document.getElementById(\''+id+'\');var a=document.getElementById(\''+id+'-arrow\');c.style.display=c.style.display===\'none\'?\'block\':\'none\';a.textContent=c.style.display===\'none\'?\'▸\':\'▾\';})()" ' +
        'style="width:100%;background:none;border:none;cursor:pointer;display:flex;justify-content:space-between;align-items:center;padding:9px 0 5px;touch-action:manipulation">' +
        '<span style="font-family:DM Mono,monospace;font-size:8px;letter-spacing:1.2px;text-transform:uppercase;color:rgba(180,200,220,0.4)">' + title + '</span>' +
        '<span id="'+id+'-arrow" style="font-size:9px;color:rgba(180,200,220,0.3)">' + (defaultOpen?'▾':'▸') + '</span>' +
      '</button>' +
      '<div id="'+id+'" style="display:' + (defaultOpen?'block':'none') + '">' + content + '</div>' +
      '</div>';
  }

  function _miniStat(label, val, color) {
    return '<div style="background:rgba(255,255,255,0.03);border-radius:6px;padding:6px 8px">' +
      '<div style="font-family:DM Mono,monospace;font-size:7px;letter-spacing:0.8px;text-transform:uppercase;color:rgba(160,180,200,0.35);margin-bottom:2px">' + label + '</div>' +
      '<div style="font-family:DM Mono,monospace;font-size:13px;font-weight:600;color:' + (color||'rgba(200,220,240,0.8)') + '">' + val + '</div>' +
      '</div>';
  }

  // ── Build HTML ────────────────────────────────────────────────────
  var contextHTML = '';

  // HEADER
  contextHTML += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">' +
    '<span style="font-size:24px">' + typeIcon + '</span>' +
    '<div style="flex:1">' +
      '<div style="font-family:Fraunces,serif;font-style:italic;font-weight:200;font-size:18px;color:' + typeColor + '">' + typeLabel + '</div>' +
      '<div style="font-family:DM Mono,monospace;font-size:9px;color:rgba(160,180,200,0.4);letter-spacing:0.5px;margin-top:2px">' + dateStr + ' · ' + timeStr + ' · ' + period + '</div>' +
    '</div>' +
    '<button onclick="document.getElementById(\'ctx-card-overlay\').remove()" style="background:none;border:none;font-size:22px;color:rgba(160,180,200,0.4);cursor:pointer;padding:4px;line-height:1">×</button>' +
    '</div>';

  // AT THIS MOMENT — always open
  // Effective carbs and units — merge paired chip values
  var effectiveCarbs  = ev.c > 0 ? ev.c : (pairedCarb  ? pairedCarb.c  : 0);
  var effectiveUnits  = ev.u > 0 ? ev.u : (pairedBolus ? pairedBolus.u : 0);
  var effectiveItems  = (ev.items && ev.items.length) ? ev.items : (pairedCarb && pairedCarb.items ? pairedCarb.items : mealItems);
  // BG at bolus moment and at eat time (end of wait)
  var bgAtBolus = dAtBolus && dAtBolus.bg > 0 ? dAtBolus.bg : bgNow;
  // BG at carb time — when eating actually started (end of wait window)
  var eatT = pairedCarb ? pairedCarb.t : (pairedBolus ? t : t);
  var dAtEat = dataAt(eatT);
  var bgAtEat = dAtEat && dAtEat.bg > 0 ? dAtEat.bg : null;
  var bgVariance = (bgAtBolus > 0 && bgAtEat && bgAtEat > 0 && waitMinsDisplay > 0)
    ? +(bgAtEat - bgAtBolus).toFixed(1) : null;
  // Colour the delta by where BG landed at eat time, not the direction of change.
  // A −2.5 from 14 is a good outcome; a −2.5 from 5.5 is a problem.
  var varianceColor = bgVariance == null ? '' :
    bgAtEat < 3.9  ? 'rgba(255,210,40,0.9)'  :  // hypo at eat time — always bad
    bgAtEat < 5.0  ? 'rgba(200,140,30,0.8)'  :  // borderline low at eat
    bgAtEat <= 10.0 ? 'rgba(62,180,120,0.8)' :  // in range at eat — good regardless of direction
    bgAtEat <= 13.0 ? 'rgba(200,140,30,0.8)' :  // above target at eat
    'rgba(220,100,40,0.9)';                       // still high at eat

  contextHTML += _section('At this moment',
    // BG row: bolus BG / eat BG / variance — show all three if a wait exists
    (bgAtEat && waitMinsDisplay > 0
      ? '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:8px">' +
          _miniStat('BG · bolus', bgAtBolus.toFixed(1) + ' mmol', bgAtBolus < 3.9 ? 'rgba(255,210,40,0.9)' : bgAtBolus > 10 ? 'rgba(220,100,40,0.9)' : 'rgba(62,180,120,0.9)') +
          _miniStat('BG · ate', bgAtEat.toFixed(1) + ' mmol', bgAtEat < 3.9 ? 'rgba(255,210,40,0.9)' : bgAtEat > 10 ? 'rgba(220,100,40,0.9)' : 'rgba(62,180,120,0.9)') +
          _miniStat('Δ during wait', (bgVariance > 0 ? '+' : '') + bgVariance + ' mmol', varianceColor) +
        '</div>'
      : '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:8px">' +
          _miniStat('BG at bolus', bgAtBolus.toFixed(1) + ' mmol', bgAtBolus < 3.9 ? 'rgba(255,210,40,0.9)' : bgAtBolus > 10 ? 'rgba(220,100,40,0.9)' : 'rgba(62,180,120,0.9)') +
          _miniStat('IOB', iobNow > 0 ? iobNow.toFixed(2) + 'U' : '0U', 'rgba(60,130,220,0.8)') +
          _miniStat('COB', cobNow > 0 ? cobNow.toFixed(0) + 'g' : '0g', 'rgba(255,140,50,0.8)') +
        '</div>'
    ) +
    // IOB/COB row always shown
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px">' +
      _miniStat('IOB at bolus', iobNow > 0 ? iobNow.toFixed(2) + 'U' : '0U', 'rgba(60,130,220,0.8)') +
      _miniStat('COB at bolus', cobNow > 0 ? cobNow.toFixed(0) + 'g' : '0g', 'rgba(255,140,50,0.8)') +
    '</div>' +
    (effectiveCarbs > 0 || effectiveUnits > 0 ?
      // ── This event: bolus + wait + carbs as one unit ──
      '<div style="background:rgba(255,255,255,0.03);border-radius:10px;padding:10px 12px;margin-bottom:8px">' +
        '<div style="font-family:DM Mono,monospace;font-size:7px;letter-spacing:1px;text-transform:uppercase;color:rgba(160,180,200,0.35);margin-bottom:8px">this event</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr ' + (waitMinsDisplay != null ? '1fr' : '') + ';gap:6px">' +
          (effectiveUnits > 0 ? _miniStat('insulin', effectiveUnits.toFixed(1) + 'U', 'rgba(60,130,220,0.9)') : '') +
          (effectiveCarbs > 0 ? _miniStat('carbs', effectiveCarbs + 'g', 'rgba(255,140,50,0.9)') : '') +
          (waitMinsDisplay != null ? _miniStat('wait', waitMinsDisplay + ' min', waitMinsDisplay >= 15 ? 'rgba(62,180,120,0.8)' : 'rgba(200,140,30,0.7)') : '') +
        '</div>' +
        (mealRec && mealRec.therapy_snapshot && mealRec.therapy_snapshot.ratios ?
          (function() {
            var r = (mealRec.therapy_snapshot.ratios || []).find(function(rx){ return rx.period === period; });
            return r ? '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px">' +
              _miniStat('IC ratio', '1:' + r.ic, 'rgba(180,200,220,0.6)') +
              _miniStat('ISF', r.isf, 'rgba(180,200,220,0.6)') +
              '</div>' : '';
          })()
        : '') +
      '</div>'
    : '') +
    _buildCurveSVG()
  , true);

  // MEAL ITEMS — use merged items (works from either the bolus or carb chip)
  mealItems = effectiveItems && effectiveItems.length ? effectiveItems : mealItems;
  if (mealItems.length > 0) {
    var totalCarbs = mealItems.reduce(function(s,i){ return s+(i.carbs||0); }, 0);
    var avgGI = mealItems.length > 0 ? Math.round(mealItems.reduce(function(s,i){ return s+(i.gi||55)*(i.carbs||0); },0) / Math.max(1,totalCarbs)) : 0;
    var totalGL = Math.round((avgGI * totalCarbs) / 100);
    contextHTML += _section('Meal breakdown · ' + totalCarbs.toFixed(0) + 'g · GI avg ' + avgGI + ' · GL ' + totalGL,
      itemsHtml
    , true);
  }

  // HYPO-SPECIFIC SECTION
  if (isHypo && hypoContextHtml) {
    contextHTML += _section('Hypo detail', hypoContextHtml, true);
  }

  // PRICK-SPECIFIC SECTION
  if (isPrick && prickContextHtml) {
    contextHTML += _section('Sensor accuracy', prickContextHtml, true);
  }

  // CORRECTION-SPECIFIC SECTION
  if (isCorrection && corrContextHtml) {
    contextHTML += _section('Correction detail', corrContextHtml, true);
  }

  // COGNITIVE LOAD
  var clBar = '<div style="height:4px;border-radius:2px;background:rgba(255,255,255,0.08);margin-bottom:10px;overflow:hidden"><div style="height:100%;width:'+Math.round(clScore*10)+'%;background:'+clColor+';border-radius:2px;transition:width .3s"></div></div>';
  var clRows = clFactors.length > 0
    ? clFactors.map(function(f) {
        return '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.03)">' +
          '<span style="font-family:DM Mono,monospace;font-size:9px;color:rgba(180,200,220,0.6)">' + f.label + '</span>' +
          '<span style="font-family:DM Mono,monospace;font-size:9px;color:' + f.color + ';font-weight:600">+' + f.val + '</span>' +
          '</div>';
      }).join('')
    : '<div style="font-size:9px;color:rgba(160,180,200,0.35);font-family:DM Mono,monospace">no load factors active</div>';
  contextHTML += _section('Cognitive load · ' + clScore + '/10',
    clBar + clRows
  , false);

  // PRECEDING EVENTS
  contextHTML += _section('Preceding events (90min)',
    precedingEvts.length > 0
      ? precedingEvts.map(function(e){ return _evRow(e, 'before'); }).join('')
      : '<div style="font-size:9px;color:rgba(160,180,200,0.3);padding:6px 0">nothing logged in prior 90min</div>'
  , true);

  // WHAT HAPPENED NEXT
  contextHTML += _section('What happened next',
    outcomeHtml
  , true);

  // UNEXPLAINED / GHOSTS
  contextHTML += _section('Unexplained nearby (' + nearbyGhosts.length + ')',
    ghostHtml
  , nearbyGhosts.length > 0);

  // WHAT WAS SUGGESTED
  contextHTML += _section('What River suggested',
    hasSuggestion
      ? suggHtml
      : '<div style="font-size:9px;color:rgba(160,180,200,0.3);padding:4px 0">no suggestion recorded at this event</div>'
  , false);

  // ── INLINE EDIT SECTION ──────────────────────────────────────────────
  // Build time value for datetime-local input
  var tzOffset = dt.getTimezoneOffset() * 60000;
  var dtLocalISO = new Date(dt.getTime() - tzOffset).toISOString().slice(0,16);

  // Which fields to show based on event type
  var editFields = '';

  // Time — always editable
  editFields += '<div style="margin-bottom:12px">' +
    '<div style="font-family:DM Mono,monospace;font-size:8px;letter-spacing:1px;text-transform:uppercase;color:rgba(160,180,200,0.4);margin-bottom:5px">when</div>' +
    '<input id="ee-time" type="datetime-local" value="' + dtLocalISO + '" ' +
      'style="width:100%;padding:9px 12px;border-radius:8px;border:1px solid rgba(255,255,255,0.08);' +
      'background:rgba(255,255,255,0.04);font-family:DM Mono,monospace;font-size:12px;' +
      'color:rgba(200,220,240,0.8);outline:none;box-sizing:border-box">' +
    '</div>';

  if (isMealBolus || isMeal || isCarbOnly || isHypo) {
    // Carbs field
    editFields += '<div style="margin-bottom:12px">' +
      '<div style="font-family:DM Mono,monospace;font-size:8px;letter-spacing:1px;text-transform:uppercase;color:rgba(255,140,50,0.5);margin-bottom:5px">carbs (g)</div>' +
      '<input id="ee-carbs" type="number" value="' + (ev.c||0) + '" min="0" max="300" step="1" ' +
        'style="width:100%;padding:10px;border-radius:8px;border:1px solid rgba(255,140,50,0.2);' +
        'background:rgba(255,140,50,0.04);font-family:DM Mono,monospace;font-size:18px;' +
        'color:rgba(255,140,50,0.9);text-align:center;outline:none;box-sizing:border-box">' +
      '</div>';
  } else {
    editFields += '<input id="ee-carbs" type="hidden" value="' + (ev.c||0) + '">';
  }

  if (isMealBolus || isCorrection || isBolus) {
    // Insulin field
    editFields += '<div style="margin-bottom:12px">' +
      '<div style="font-family:DM Mono,monospace;font-size:8px;letter-spacing:1px;text-transform:uppercase;color:rgba(60,130,220,0.5);margin-bottom:5px">insulin (U)</div>' +
      '<input id="ee-units" type="number" value="' + (ev.u||0) + '" min="0" max="20" step="0.5" ' +
        'style="width:100%;padding:10px;border-radius:8px;border:1px solid rgba(60,130,220,0.2);' +
        'background:rgba(60,130,220,0.04);font-family:DM Mono,monospace;font-size:18px;' +
        'color:rgba(60,130,220,0.9);text-align:center;outline:none;box-sizing:border-box">' +
      '</div>';
  } else {
    editFields += '<input id="ee-units" type="hidden" value="' + (ev.u||0) + '">';
  }

  if (isMealBolus) {
    // Wait mins field — only relevant for bolus+meal pairs
    editFields += '<div style="margin-bottom:12px">' +
      '<div style="font-family:DM Mono,monospace;font-size:8px;letter-spacing:1px;text-transform:uppercase;color:rgba(160,180,200,0.4);margin-bottom:5px">wait before eating (min)</div>' +
      '<input id="ee-wait" type="number" value="' + (waitMinsDisplay||0) + '" min="0" max="60" step="5" ' +
        'style="width:100%;padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.07);' +
        'background:rgba(255,255,255,0.03);font-family:DM Mono,monospace;font-size:18px;' +
        'color:rgba(200,200,200,0.9);text-align:center;outline:none;box-sizing:border-box">' +
      '</div>';
  } else {
    editFields += '<input id="ee-wait" type="hidden" value="' + (waitMinsDisplay||0) + '">';
  }

  var editSectionHTML =
    '<div style="border-top:1px solid rgba(255,255,255,0.06);margin-top:20px;padding-top:18px">' +
      '<div style="font-family:DM Mono,monospace;font-size:8px;letter-spacing:1.5px;text-transform:uppercase;color:rgba(160,180,200,0.3);margin-bottom:14px">edit entry</div>' +
      editFields +
      '<div style="display:flex;gap:8px;margin-top:4px">' +
        '<button onclick="saveEventEdit(' + eventIdx + ')" ' +
          'style="flex:1;padding:12px;border-radius:10px;border:1px solid rgba(62,180,120,0.3);' +
          'background:rgba(62,180,120,0.07);font-family:Fraunces,serif;font-style:italic;' +
          'font-weight:200;font-size:16px;color:rgba(62,180,120,0.9);cursor:pointer;touch-action:manipulation">save</button>' +
        '<button onclick="deleteEvent(' + eventIdx + ')" ' +
          'style="padding:12px 16px;border-radius:10px;border:1px solid rgba(200,60,60,0.2);' +
          'background:transparent;font-family:DM Mono,monospace;font-size:10px;' +
          'color:rgba(200,80,80,0.5);cursor:pointer;touch-action:manipulation">delete</button>' +
        '<button onclick="document.getElementById(\'ctx-card-overlay\').remove()" ' +
          'style="padding:12px 14px;border-radius:10px;border:1px solid rgba(255,255,255,0.07);' +
          'background:transparent;font-family:DM Mono,monospace;font-size:10px;' +
          'color:rgba(140,160,180,0.4);cursor:pointer;touch-action:manipulation">close</button>' +
      '</div>' +
    '</div>';

  contextHTML += editSectionHTML;


  // ── Build overlay ────────────────────────────────────────────────
  var el = document.createElement('div');
  el.id = 'ctx-card-overlay';
  el.style.cssText = 'position:fixed;inset:0;z-index:80;background:rgba(3,5,20,0.88);' +
    'backdrop-filter:blur(18px);display:flex;flex-direction:column;align-items:center;' +
    'justify-content:flex-end;padding:0;pointer-events:auto;touch-action:pan-y';
  // Suppress close-on-background-click for the same window mobile browsers use
  // to fire a synthetic 'click' after touchend (~300ms). Without this, the
  // synthetic click that follows the touchend which opened this overlay can
  // land on `el` itself (inset:0 covers the whole screen) and immediately
  // remove it — the card flashes open and closes before it can be seen.
  var _ctxOpenedAt = Date.now();
  el.addEventListener('click', function(e){
    if (Date.now() - _ctxOpenedAt < 500) return;
    if (e.target === el) el.remove();
  });
  el.addEventListener('touchstart', function(e){ e.stopPropagation(); }, {passive:true});

  var inner = document.createElement('div');
  inner.style.cssText = 'width:100%;max-width:440px;max-height:88vh;overflow-y:auto;' +
    'background:rgba(8,12,28,0.99);border-top-left-radius:20px;border-top-right-radius:20px;' +
    'padding:20px 18px 48px;box-sizing:border-box;-webkit-overflow-scrolling:touch';
  inner.innerHTML = contextHTML;

  el.appendChild(inner);
  document.body.appendChild(el);
}


function openEventEditor(eventIdx) {
  // Find by index in LOGGED_EVENTS (BOLUS_EVENTS is a live alias)
  var ev = LOGGED_EVENTS[eventIdx];
  if (!ev) return;

  var ex = document.getElementById('ctx-card-overlay') || document.getElementById('event-edit-overlay');
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

  if (!LOGGED_EVENTS[idx]) { var el=document.getElementById('ctx-card-overlay') || document.getElementById('event-edit-overlay'); if(el) el.remove(); return; }

  var oldT = LOGGED_EVENTS[idx].t;
  var oldWait = LOGGED_EVENTS[idx].waitMins || 0;

  // --- Apply changes to LOGGED_EVENTS entry (BOLUS_EVENTS is a live alias) ---
  LOGGED_EVENTS[idx].c = c;
  LOGGED_EVENTS[idx].u = u;
  LOGGED_EVENTS[idx].waitMins = waitMins;
  if (newT && newT !== oldT) LOGGED_EVENTS[idx].t = newT;
  var updatedT = LOGGED_EVENTS[idx].t;

  // If the event moved in time, any prediction curve anchored to its old
  // timestamp no longer corresponds to a real event there — clear it
  // (same ghost-prediction fix as deleteEvent).
  if (newT && newT !== oldT) {
    _removeActivePredictedCurve(oldT);
  }

  // --- If this is a bolus event (u > 0) and wait changed, reposition linked carb chip ---
  // The carb event sits at bolusT + waitMins*60000. Find it and move it.
  if (u > 0) {
    var oldCarbT = oldT + oldWait * 60000;
    var newCarbT = updatedT + waitMins * 60000;
    if (oldCarbT !== newCarbT) {
      // Reposition linked carb event in LOGGED_EVENTS (BOLUS_EVENTS is a live alias)
      var carbIdx = LOGGED_EVENTS.findIndex(function(e, i) {
        return i !== idx && e.c > 0 && e.u === 0 && Math.abs(e.t - oldCarbT) < 5 * 60000;
      });
      if (carbIdx >= 0) {
        LOGGED_EVENTS[carbIdx].t = newCarbT;
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

  var el = document.getElementById('ctx-card-overlay') || document.getElementById('event-edit-overlay');
  if (el) el.remove();
  showToast('entry updated');

  // ── Sync edit to Supabase ────────────────────────────────────────────
  if (SUPABASE_READY) {
    var updatedEv = LOGGED_EVENTS[idx];
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
        var oldCarbT2 = oldT + (LOGGED_EVENTS[idx] ? (LOGGED_EVENTS[idx].waitMins || waitMins) : waitMins) * 60000;
        // find the carb event we moved
        var movedCarb = LOGGED_EVENTS.find(function(e, i){ return i !== idx && e.c > 0 && !e.u && Math.abs(e.t - (updatedT + waitMins * 60000)) < 5 * 60000; });
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
      var patch = { c: c, u: u, waitMins: waitMins, updated_at: new Date().toISOString() };
      _sbFetch('events?t=eq.' + updatedT, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body:   patch,
      }).catch(function(e){ console.warn('[edit] patch failed:', e.message); });
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// SENSOR OUTAGE SYSTEM
// Outages are first-class events — logged at lived time, independent of
// CGM trace data. Backfill does not remove them. They represent the true
// experience of having no live data, which the trace cannot show once filled.
// ══════════════════════════════════════════════════════════════════════

var SENSOR_OUTAGES = []; // { id, start_t, end_t, cause_category, cause_note }
var _outageCheckTimer = null;
var _activeOutageId   = null; // uuid of the currently open outage, if any

// Load from Supabase on startup
async function loadSensorOutages() {
  if (!SUPABASE_READY) return;
  try {
    var rows = await _sbFetch('sensor_outages?order=start_t.desc&limit=100', {});
    if (Array.isArray(rows)) {
      SENSOR_OUTAGES.length = 0;
      rows.forEach(function(r) {
        SENSOR_OUTAGES.push({
          id:             r.id,
          start_t:        r.start_t,
          end_t:          r.end_t || null,
          cause_category: r.cause_category || 'unknown',
          cause_note:     r.cause_note || '',
          bg_before:      r.bg_before != null ? r.bg_before : null,
          trend_before:   r.trend_before || null,
          expected_t:     r.expected_t || null,
          bg_on_return:   r.bg_on_return != null ? r.bg_on_return : null,
          trend_on_return: r.trend_on_return || null,
          was_backfilled: r.was_backfilled != null ? r.was_backfilled : null,
        });
      });
    }
  } catch(e) { console.warn('[outage] load failed:', e.message); }
}

// Called from the frame loop (throttled) — auto-detects a new outage
var _lastOutageCheck = 0;
function _maybeDetectOutage() {
  if (!_cgmPolledOnce) return;           // don't log outages before first poll
  var now = Date.now();
  if (now - _lastOutageCheck < 60000) return; // check every 60s
  _lastOutageCheck = now;

  if (HISTORY_RAW.length === 0) return;
  var lastT  = HISTORY_RAW[HISTORY_RAW.length-1].t;
  var gapMs  = now - lastT;

  if (gapMs >= 20 * 60000) {
    // We have a sensor gap ≥20 min
    // Check if we already have an open outage covering this gap
    var alreadyLogged = SENSOR_OUTAGES.some(function(o) {
      return o.end_t === null && Math.abs(o.start_t - lastT) < 5 * 60000;
    });
    if (!alreadyLogged && !_activeOutageId) {
      // Auto-open outage — start_t anchored to last known reading
      _openOutage(lastT);
    }
  } else if (_activeOutageId) {
    // Gap closed (sensor recovered) — auto-close the outage
    _closeOutage(now);
  }
}

async function _openOutage(startT) {
  if (_activeOutageId) return; // already open
  if (!SUPABASE_READY) return;
  try {
    // Capture last-known reading before the gap, and the time we'd have
    // expected the next one — both first-class facts about what was known
    // at the moment the outage was detected (sensor_outages enrichment).
    var last       = HISTORY_RAW.length > 0 ? HISTORY_RAW[HISTORY_RAW.length - 1] : null;
    var bgBefore   = (last && last.bg > 0) ? +last.bg.toFixed(2) : null;
    var trendBefore = last ? (last.trend || null) : null;
    var expectedT  = startT + 5 * 60000; // ~5min, Libre's nominal cadence

    var result = await _sbFetch('sensor_outages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: [{
        start_t: startT, cause_category: 'unknown', device_id: _thisPersonId || 'unknown',
        bg_before: bgBefore, trend_before: trendBefore, expected_t: expectedT,
      }]
    });
    if (Array.isArray(result) && result[0] && result[0].id) {
      _activeOutageId = result[0].id;
      SENSOR_OUTAGES.unshift({
        id:             result[0].id,
        start_t:        startT,
        end_t:          null,
        cause_category: 'unknown',
        cause_note:     '',
        bg_before:      bgBefore,
        trend_before:   trendBefore,
        expected_t:     expectedT,
      });
      // Prompt user to log cause — non-blocking nudge
      // _showOutageNudge(startT); // [STUBBED] outage nudge hidden pending UX review
    }
  } catch(e) { console.warn('[outage] open failed:', e.message); }
}

async function _closeOutage(endT) {
  if (!_activeOutageId || !SUPABASE_READY) return;
  var id = _activeOutageId;
  _activeOutageId = null;
  try {
    var patch = { end_t: endT };

    // Capture the returning reading's bg/trend, and whether it arrived
    // "live" or was backfilled by Libre after the fact (was_backfilled is
    // true if the reading's own t is >10min before its readings.inserted_at).
    var last = HISTORY_RAW.length > 0 ? HISTORY_RAW[HISTORY_RAW.length - 1] : null;
    if (last && last.bg > 0) {
      patch.bg_on_return    = +last.bg.toFixed(2);
      patch.trend_on_return = last.trend || null;
      try {
        var rows = await _sbFetch('readings?t=eq.' + last.t + '&select=t,inserted_at', {});
        if (Array.isArray(rows) && rows[0] && rows[0].inserted_at) {
          var insertedAt = new Date(rows[0].inserted_at).getTime();
          patch.was_backfilled = (insertedAt - last.t) > 10 * 60000;
        }
      } catch(e2) { console.warn('[outage] inserted_at lookup failed:', e2.message); }
    }

    await _sbFetch('sensor_outages?id=eq.' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: patch
    });
    var idx = SENSOR_OUTAGES.findIndex(function(o){ return o.id === id; });
    if (idx >= 0) Object.assign(SENSOR_OUTAGES[idx], patch);
    // Remove the nudge if still showing
    var nudge = document.getElementById('outage-nudge');
    if (nudge) nudge.remove();
    showToast('sensor recovered · outage logged');
  } catch(e) { console.warn('[outage] close failed:', e.message); }
}

// Non-blocking nudge — appears at bottom of screen, one tap to log cause
function _showOutageNudge(startT) {
  var ex = document.getElementById('outage-nudge');
  if (ex) return; // already showing

  var el = document.createElement('div');
  el.id = 'outage-nudge';
  el.style.cssText = [
    'position:fixed', 'bottom:80px', 'left:50%', 'transform:translateX(-50%)',
    'z-index:65', 'background:rgba(10,18,36,0.92)', 'backdrop-filter:blur(14px)',
    'border:1px solid rgba(160,175,210,0.25)', 'border-radius:14px',
    'padding:12px 16px', 'display:flex', 'align-items:center', 'gap:10px',
    'max-width:300px', 'opacity:0', 'transition:opacity .25s'
  ].join(';');

  var gapMins = Math.round((Date.now() - startT) / 60000);
  el.innerHTML =
    '<div style="font-size:18px">📡</div>' +
    '<div style="flex:1">' +
      '<div style="font-family:\'DM Mono\',monospace;font-size:9px;letter-spacing:1px;' +
        'text-transform:uppercase;color:rgba(160,175,210,0.6);margin-bottom:2px">sensor gap · ' + gapMins + 'm</div>' +
      '<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;' +
        'font-size:13px;color:rgba(180,195,230,0.9)">log what happened?</div>' +
    '</div>' +
    '<button onclick="openOutageLog()" style="padding:7px 12px;border-radius:9px;' +
      'border:1px solid rgba(160,175,210,0.3);background:rgba(40,55,100,0.4);' +
      'font-family:\'DM Mono\',monospace;font-size:9px;letter-spacing:0.5px;' +
      'text-transform:uppercase;color:rgba(180,200,240,0.85);cursor:pointer;' +
      'touch-action:manipulation">log</button>' +
    '<button onclick="document.getElementById(\'outage-nudge\').remove()" ' +
      'style="background:none;border:none;cursor:pointer;font-size:18px;' +
      'color:rgba(140,155,190,0.4);padding:2px;line-height:1">×</button>';

  document.body.appendChild(el);
  requestAnimationFrame(function(){ el.style.opacity = '1'; });

  // Auto-dismiss after 30s
  setTimeout(function() {
    var n = document.getElementById('outage-nudge');
    if (n) { n.style.opacity = '0'; setTimeout(function(){ if(n.parentNode) n.remove(); }, 300); }
  }, 30000);
}

// Full outage logging modal
function openOutageLog() {
  var nudge = document.getElementById('outage-nudge');
  if (nudge) nudge.remove();

  var ex = document.getElementById('outage-overlay');
  if (ex) { ex.remove(); return; }

  // Find the active outage or most recent
  var outage = SENSOR_OUTAGES.find(function(o){ return o.end_t === null; })
            || SENSOR_OUTAGES[0];

  var startStr = outage
    ? new Date(outage.start_t).toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'})
    : '--:--';
  var gapMins = outage ? Math.round((Date.now() - outage.start_t) / 60000) : 0;

  var causes = [
    { key: 'heat',         label: '🌡️ heat', desc: 'overheating / hot weather' },
    { key: 'water',        label: '💧 water', desc: 'pool, bath, shower' },
    { key: 'adhesion',     label: '🩹 adhesion', desc: 'sensor lifting / fell off' },
    { key: 'compression',  label: '🛏️ compression', desc: 'lying on sensor' },
    { key: 'bluetooth',    label: '📶 bluetooth', desc: 'signal / pairing lost' },
    { key: 'sensor_error', label: '⚠️ sensor error', desc: 'device reported error' },
    { key: 'unknown',      label: '❓ unknown', desc: '' }
  ];

  var currentCause = outage ? outage.cause_category : 'unknown';

  var el = document.createElement('div');
  el.id = 'outage-overlay';
  el.style.cssText = 'position:fixed;inset:0;z-index:72;background:rgba(8,14,30,0.95);' +
    'backdrop-filter:blur(18px);display:flex;flex-direction:column;align-items:center;' +
    'justify-content:center;padding:28px;opacity:0;transition:opacity .2s;pointer-events:auto';
  el.addEventListener('click', function(e){ if(e.target===el) el.remove(); });

  var causeButtons = causes.map(function(c) {
    var isSelected = c.key === currentCause;
    return '<button onclick="_outageSelectCause(\'' + c.key + '\')" id="oc-' + c.key + '" ' +
      'style="width:100%;padding:10px 12px;border-radius:10px;text-align:left;cursor:pointer;' +
      'font-family:\'DM Mono\',monospace;font-size:11px;letter-spacing:0.3px;' +
      'border:1px solid ' + (isSelected ? 'rgba(160,185,240,0.5)' : 'rgba(160,175,210,0.15)') + ';' +
      'background:' + (isSelected ? 'rgba(40,60,120,0.4)' : 'transparent') + ';' +
      'color:' + (isSelected ? 'rgba(190,210,255,0.95)' : 'rgba(150,165,200,0.7)') + ';' +
      'touch-action:manipulation">' +
      c.label + (c.desc ? '<span style="opacity:0.45;margin-left:6px">' + c.desc + '</span>' : '') +
    '</button>';
  }).join('');

  el.innerHTML =
    '<div style="max-width:320px;width:100%">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
        '<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;' +
          'font-size:22px;color:rgba(160,185,240,0.9)">📡 sensor gap</div>' +
        '<button onclick="document.getElementById(\'outage-overlay\').remove()" ' +
          'style="background:none;border:none;cursor:pointer;font-size:22px;' +
          'color:rgba(140,155,190,0.5);padding:4px">×</button>' +
      '</div>' +
      '<div style="font-family:\'DM Mono\',monospace;font-size:9px;letter-spacing:1px;' +
        'text-transform:uppercase;color:rgba(140,155,190,0.5);margin-bottom:20px">' +
        'started ' + startStr + ' · ' + gapMins + 'm ago' +
      '</div>' +

      '<div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1.2px;' +
        'text-transform:uppercase;color:rgba(140,155,190,0.45);margin-bottom:8px">what happened?</div>' +
      '<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px">' +
        causeButtons +
      '</div>' +

      '<div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1.2px;' +
        'text-transform:uppercase;color:rgba(140,155,190,0.45);margin-bottom:6px">notes (optional)</div>' +
      '<textarea id="outage-note" rows="2" placeholder="e.g. spent 3h in pool, sensor started falling off..." ' +
        'style="width:100%;box-sizing:border-box;padding:9px 12px;border-radius:8px;' +
        'border:1px solid rgba(160,175,210,0.2);background:rgba(20,30,60,0.4);' +
        'font-family:\'DM Mono\',monospace;font-size:11px;color:rgba(170,185,225,0.85);' +
        'resize:none;outline:none;margin-bottom:16px">' + (outage ? outage.cause_note || '' : '') + '</textarea>' +

      '<button onclick="saveOutageLog()" ' +
        'style="width:100%;padding:13px;border-radius:10px;border:1px solid rgba(160,185,240,0.3);' +
        'background:rgba(30,50,110,0.4);font-family:\'Fraunces\',serif;font-style:italic;' +
        'font-weight:200;font-size:17px;color:rgba(180,205,255,0.9);cursor:pointer;' +
        'touch-action:manipulation">save outage</button>' +
    '</div>';

  document.body.appendChild(el);
  requestAnimationFrame(function(){ el.style.opacity = '1'; });
}

var _selectedOutageCause = null;
function _outageSelectCause(key) {
  _selectedOutageCause = key;
  // Update button styles
  var causes = ['heat','water','adhesion','compression','bluetooth','sensor_error','unknown'];
  causes.forEach(function(c) {
    var btn = document.getElementById('oc-' + c);
    if (!btn) return;
    var sel = c === key;
    btn.style.borderColor   = sel ? 'rgba(160,185,240,0.5)' : 'rgba(160,175,210,0.15)';
    btn.style.background    = sel ? 'rgba(40,60,120,0.4)'   : 'transparent';
    btn.style.color         = sel ? 'rgba(190,210,255,0.95)' : 'rgba(150,165,200,0.7)';
  });
}

async function saveOutageLog() {
  var cause = _selectedOutageCause;
  var note  = (document.getElementById('outage-note') || {}).value || '';

  // Find the target outage (open or most recent)
  var outage = SENSOR_OUTAGES.find(function(o){ return o.end_t === null; })
            || SENSOR_OUTAGES[0];
  if (!outage || !outage.id) {
    document.getElementById('outage-overlay').remove();
    return;
  }

  var patch = {};
  if (cause) patch.cause_category = cause;
  if (note)  patch.cause_note = note;

  if (!SUPABASE_READY || Object.keys(patch).length === 0) {
    document.getElementById('outage-overlay').remove();
    return;
  }

  try {
    await _sbFetch('sensor_outages?id=eq.' + outage.id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: patch
    });
    // Update local
    if (cause) outage.cause_category = cause;
    if (note)  outage.cause_note = note;
    showToast('outage saved');
  } catch(e) {
    console.warn('[outage] save failed:', e.message);
    showToast('save failed — try again');
  }

  _selectedOutageCause = null;
  var el = document.getElementById('outage-overlay');
  if (el) el.remove();
}

// Draw logged sensor outage zones on the river canvas
// These persist even after CGM backfill — they represent lived experience
function drawSensorOutageZones() {
  if (!SENSOR_OUTAGES || SENSOR_OUTAGES.length === 0) return;

  var now = Date.now();
  var viewLeft  = viewTime - viewSpan * NOW_X;
  var viewRight = viewTime + viewSpan * (1 - NOW_X);

  SENSOR_OUTAGES.forEach(function(o) {
    var oStart = o.start_t;
    var oEnd   = o.end_t || now;

    if (oEnd < viewLeft || oStart > viewRight) return;

    var x0 = tX(oStart);
    var x1 = tX(oEnd);
    var x0c = Math.max(0, x0);
    var x1c = Math.min(W, x1);
    if (x1c <= x0c) return;

    var pulse = 0.5 + 0.5 * Math.sin(phi * 1.2);
    var zoneW = x1c - x0c;

    CX.save();

    // Amber haze fill — full height, feathered edges
    var zoneGrad = CX.createLinearGradient(x0c, 0, x1c, 0);
    zoneGrad.addColorStop(0,    'rgba(180,160,100,0.0)');
    zoneGrad.addColorStop(0.12, 'rgba(170,150,90,0.08)');
    zoneGrad.addColorStop(0.88, 'rgba(170,150,90,0.08)');
    zoneGrad.addColorStop(1,    'rgba(180,160,100,0.0)');
    CX.fillStyle = zoneGrad;
    CX.fillRect(x0c, 0, zoneW, H);

    // ── START BOUNDARY ── clear vertical line at outage start
    if (x0 >= 0 && x0 <= W) {
      CX.strokeStyle = 'rgba(200,175,100,0.6)';
      CX.lineWidth = 1.5;
      CX.setLineDash([]);
      CX.beginPath();
      CX.moveTo(x0, 0); CX.lineTo(x0, H);
      CX.stroke();
      // "gap start" label
      CX.globalAlpha = 0.6;
      CX.font = "400 9px 'DM Mono',monospace";
      CX.fillStyle   = 'rgba(210,190,120,1)';
      CX.textAlign   = 'left';
      CX.fillText('◀ gap start', x0 + 4, 14);
      CX.globalAlpha = 1;
    }

    // ── END BOUNDARY ── clear vertical line at outage end (only if it has ended)
    if (o.end_t && x1 >= 0 && x1 <= W) {
      CX.strokeStyle = 'rgba(200,175,100,0.6)';
      CX.lineWidth = 1.5;
      CX.setLineDash([]);
      CX.beginPath();
      CX.moveTo(x1, 0); CX.lineTo(x1, H);
      CX.stroke();
      CX.globalAlpha = 0.6;
      CX.font = "400 9px 'DM Mono',monospace";
      CX.fillStyle   = 'rgba(210,190,120,1)';
      CX.textAlign   = 'right';
      CX.fillText('gap end ▶', x1 - 4, 14);
      CX.globalAlpha = 1;
    }

    // ── CENTRE LABEL — cause + duration, only when zone is wide enough ──
    if (zoneW > 50) {
      var durationMins = Math.round((oEnd - oStart) / 60000);
      var causeLabel = {
        heat: '🌡️ heat', water: '💧 water', adhesion: '🩹 adhesion',
        compression: '🛏️ compression', bluetooth: '📶 bt', sensor_error: '⚠️ error', unknown: '📡 gap'
      }[o.cause_category] || '📡 gap';

      var labelX = Math.max(x0c + 4, Math.min(x1c - 4, (x0c + x1c) / 2));
      CX.globalAlpha = 0.6 + pulse * 0.1;
      CX.font = "400 11px 'DM Mono',monospace";
      CX.fillStyle   = 'rgba(210,190,120,1)';
      CX.textAlign   = 'center';
      CX.fillText(causeLabel + '  ' + durationMins + 'm', labelX, 30);
    }

    CX.globalAlpha = 1;
    CX.restore();
  });
}

// Outage history screen
function openOutageHistory() {
  var ex = document.getElementById('outage-history-overlay');
  if (ex) { ex.remove(); return; }

  var el = document.createElement('div');
  el.id = 'outage-history-overlay';
  el.style.cssText = 'position:fixed;inset:0;z-index:72;background:rgba(8,14,30,0.97);' +
    'backdrop-filter:blur(18px);overflow-y:auto;padding:28px 20px;opacity:0;transition:opacity .2s';

  var html =
    '<div style="max-width:400px;margin:0 auto">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">' +
        '<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;' +
          'font-size:22px;color:rgba(210,190,120,0.9)">📡 sensor outages</div>' +
        '<button onclick="document.getElementById(\'outage-history-overlay\').remove()" ' +
          'style="background:none;border:none;cursor:pointer;font-size:22px;' +
          'color:rgba(180,165,110,0.5);padding:4px">×</button>' +
      '</div>';

  if (SENSOR_OUTAGES.length === 0) {
    html += '<div style="font-family:\'DM Mono\',monospace;font-size:11px;' +
      'color:rgba(150,160,180,0.5);text-align:center;padding:40px 0">no outages logged yet</div>';
  } else {
    // Summary stats
    var totalOutages = SENSOR_OUTAGES.length;
    var totalMins = SENSOR_OUTAGES.reduce(function(acc, o) {
      return acc + Math.round(((o.end_t || Date.now()) - o.start_t) / 60000);
    }, 0);
    var causeCounts = {};
    SENSOR_OUTAGES.forEach(function(o) {
      causeCounts[o.cause_category] = (causeCounts[o.cause_category] || 0) + 1;
    });
    var topCause = Object.entries(causeCounts).sort(function(a,b){ return b[1]-a[1]; })[0];

    html +=
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:20px">' +
        _outageStatBox(totalOutages + '', 'total outages') +
        _outageStatBox(totalMins >= 60 ? Math.round(totalMins/60) + 'h' : totalMins + 'm', 'total lost') +
        _outageStatBox(topCause ? topCause[0] : '—', 'top cause') +
      '</div>';

    // Outage list
    SENSOR_OUTAGES.forEach(function(o, i) {
      var dMins = Math.round(((o.end_t || Date.now()) - o.start_t) / 60000);
      var startDt = new Date(o.start_t);
      var dateStr = startDt.toLocaleDateString('en-GB', {day:'numeric', month:'short'});
      var timeStr = startDt.toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'});
      var statusStr = o.end_t ? (dMins + 'm') : (dMins + 'm · open');
      var causeLabel = {
        heat: '🌡️ heat', water: '💧 water', adhesion: '🩹 adhesion',
        compression: '🛏️ compression', bluetooth: '📶 bluetooth',
        sensor_error: '⚠️ sensor error', unknown: '❓ unknown'
      }[o.cause_category] || '❓ unknown';

      html +=
        '<div style="padding:12px 14px;border-radius:12px;border:1px solid rgba(200,180,110,0.15);' +
          'background:rgba(20,28,55,0.4);margin-bottom:8px;cursor:pointer" ' +
          'onclick="openOutageDetail(\'' + o.id + '\')">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">' +
            '<div style="font-family:\'DM Mono\',monospace;font-size:10px;' +
              'color:rgba(210,190,120,0.85)">' + dateStr + ' · ' + timeStr + '</div>' +
            '<div style="font-family:\'DM Mono\',monospace;font-size:10px;' +
              'color:' + (o.end_t ? 'rgba(140,155,185,0.6)' : 'rgba(220,180,80,0.8)') + '">' + statusStr + '</div>' +
          '</div>' +
          '<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;' +
            'font-size:14px;color:rgba(190,175,130,0.9)">' + causeLabel + '</div>' +
          (o.cause_note ? '<div style="font-family:\'DM Mono\',monospace;font-size:9px;' +
            'color:rgba(150,160,185,0.55);margin-top:4px">' + o.cause_note + '</div>' : '') +
        '</div>';
    });
  }

  html += '</div>';
  el.innerHTML = html;
  document.body.appendChild(el);
  requestAnimationFrame(function(){ el.style.opacity = '1'; });
}

function _outageStatBox(val, label) {
  return '<div style="background:rgba(20,28,55,0.5);border:1px solid rgba(200,180,110,0.15);' +
    'border-radius:10px;padding:10px;text-align:center">' +
    '<div style="font-family:\'DM Mono\',monospace;font-size:16px;font-weight:500;' +
      'color:rgba(210,190,120,0.9);margin-bottom:3px">' + val + '</div>' +
    '<div style="font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1px;' +
      'text-transform:uppercase;color:rgba(150,160,185,0.5)">' + label + '</div>' +
  '</div>';
}

function openOutageDetail(id) {
  // Jump the river to the outage time and close history screen
  var outage = SENSOR_OUTAGES.find(function(o){ return o.id === id; });
  if (!outage) return;
  var el = document.getElementById('outage-history-overlay');
  if (el) el.remove();
  viewTime  = outage.start_t + Math.round(((outage.end_t || Date.now()) - outage.start_t) / 2);
  viewSpan  = 2 * 3600000;
  _isAtNow  = false;
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
  var t  = _safeEventT(tEl && tEl.value ? new Date(tEl.value).getTime() : Date.now());

  var prick = { t: t, bg: bg, logged_by: _thisPersonId || 'unknown' };
  BLOOD_PRICKS.push(prick);
  BLOOD_PRICKS.sort(function(a,b){ return a.t - b.t; });
  _savePricks();

  // Push to Supabase via events table (note:'prick', gi=bg back-compat, value=bg canonical)
  if (SUPABASE_READY) {
    _sbFetch('events?on_conflict=t', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: [{ t: t, c: 0, u: 0, gi: bg, value: bg, note: 'prick',
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
      body:[{ t:newT, c:0, u:0, gi:bg, value:bg, note:'prick', device_id:_deviceId, updated_at:new Date().toISOString() }]
    }).catch(function(e){ console.warn('[prick edit]', e.message); });
  } else if (SUPABASE_READY) {
    _sbFetch('events?t=eq.' + oldT + '&note=eq.prick', {
      method:'PATCH', prefer:'return=minimal', body:{ gi:bg, value:bg, updated_at:new Date().toISOString() }
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

// ── ORPHAN PREDICTION CURVE CLEANUP (one-time, on load) ───────────────
// Catches "ghost" prediction curves left anchored to timestamps for events
// that were deleted before _removeActivePredictedCurve existed (or where the
// anchor time didn't line up exactly with the event's own t). Anything whose
// anchor falls within 60s of a blocklisted deleted-event timestamp is purged
// from _activePredictedCurves and from MEAL_HISTORY._predictedCurve.
(function _pruneGhostPredictedCurves() {
  if (!_deletedEventTs || _deletedEventTs.size === 0) return;
  var deletedTs = Array.from(_deletedEventTs);
  function isOrphan(anchorT) {
    if (anchorT == null) return false;
    return deletedTs.indexOf(anchorT) !== -1;
  }

  var curvesChanged = false;
  for (var i = _activePredictedCurves.length - 1; i >= 0; i--) {
    var s = _activePredictedCurves[i];
    var anchorT = s.pts && s.pts[0] && s.pts[0].t;
    if (isOrphan(anchorT)) { _activePredictedCurves.splice(i, 1); curvesChanged = true; }
  }
  if (curvesChanged) {
    try { localStorage.setItem('river_predicted_curves_v' + _PRED_FORMULA_VERSION, JSON.stringify(_activePredictedCurves)); } catch(e) {}
  }

  var mealsChanged = false;
  MEAL_HISTORY.forEach(function(meal) {
    var anchorT = meal._predictedCurve && meal._predictedCurve[0] && meal._predictedCurve[0].t;
    if (isOrphan(anchorT)) {
      delete meal._predictedCurve; mealsChanged = true;
      if (!meal._curveDeleted)  { meal._curveDeleted = true;   mealsChanged = true; }
    }
  });
  if (mealsChanged) saveMealHistory();
})();

// ── BACKFILL ON LOAD ────────────────────────────────────────────────
// Previously only ran inside syncNow (gated on SUPABASE_READY). Run it
// unconditionally here too so historic prediction curves reconstruct for
// today's events even before/without a Supabase sync (e.g. a curve that
// got cleared by _removeActivePredictedCurve for an unrelated event due
// to anchor-time matching, or first load offline).
_backfillPredictedCurves();

function deleteEvent(idx) {
  var ev = LOGGED_EVENTS[idx];
  var t  = ev && ev.t;
  LOGGED_EVENTS.splice(idx, 1);
  if (t) {
    SESSION       = SESSION.filter(function(s){ return s.t !== t; });
    LOGGED_EVENTS = LOGGED_EVENTS.filter(function(s){ return s.t !== t; });
    try { localStorage.setItem('river_session', JSON.stringify(SESSION)); } catch(_e) {}
    try { localStorage.setItem('river_logged',  JSON.stringify(LOGGED_EVENTS)); } catch(_e) {}

    // Add to blocklist so it isn't re-pulled from Supabase
    _deletedEventTs.add(t);
    _saveDeletedTs();

    // Clear any stale prediction curve anchored to this event (ghost prediction fix)
    _removeActivePredictedCurve(t);

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
  var el = document.getElementById('ctx-card-overlay') || document.getElementById('event-edit-overlay');
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
    { label: 'meal history',  icon: '▤', fn: function(){ closeSettingsTray(); window.openBackfillReview && window.openBackfillReview(); }, col: 'rgba(74,143,212,0.8)'  },
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
      "font-family:DM Mono,monospace",
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
  function mono(s) { return "font-family:DM Mono,monospace;font-size:" + (s||10) + "px"; }

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

// ── INSULIN PROFILES ───────────────────────────────────────────────────
// Pharmacokinetic shape per insulin type — drives the IOB curve (peak
// timing + duration of action). `_TREATMENT.insulins` holds the rotation
// of insulins currently in use; these are the known-shape defaults that
// get applied when an insulin is added/switched to.
const INSULIN_PROFILES = {
  Novorapid: { label: 'NovoRapid', peakMins: 75, diaMins: 240, info: 'peak ~75 min · 4 hr tail' },
  Fiasp:     { label: 'Fiasp',     peakMins: 55, diaMins: 210, info: 'peak ~55 min · 3.5 hr tail' },
  Humalog:   { label: 'Humalog',   peakMins: 75, diaMins: 240, info: 'peak ~75 min · 4 hr tail' },
  Apidra:    { label: 'Apidra',    peakMins: 70, diaMins: 240, info: 'peak ~70 min · 4 hr tail' },
  Lyumjev:   { label: 'Lyumjev',   peakMins: 50, diaMins: 210, info: 'peak ~50 min · 3.5 hr tail' },
};

// Returns {name, peakMins, diaMins, label} — merges any user override stored
// on _TREATMENT.insulins with the known INSULIN_PROFILES shape, falling back
// to Novorapid's shape for anything unrecognised.
function _getInsulinProfile(name) {
  var base   = INSULIN_PROFILES[name] || INSULIN_PROFILES.Novorapid;
  var list   = (_TREATMENT && _TREATMENT.insulins) || [];
  var custom = list.find(function(i){ return i.name === name; });
  return {
    name:     name || 'Novorapid',
    peakMins: (custom && custom.peakMins) || base.peakMins,
    diaMins:  (custom && custom.diaMins)  || base.diaMins,
    label:    base.label || name || 'Novorapid',
  };
}

// All insulins currently "in rotation" (active=true). Always returns at
// least one entry, even before _TREATMENT has loaded.
function _activeInsulins() {
  var list = (_TREATMENT && _TREATMENT.insulins) || _TREATMENT_DEFAULTS.insulins;
  var active = list.filter(function(i){ return i.active; });
  return active.length ? active : list.slice(0, 1);
}

// The default/primary insulin — pre-selected at correction/meal time and
// used as the fallback for events with no explicit insulin_type.
function _defaultInsulin() {
  var list = (_TREATMENT && _TREATMENT.insulins) || _TREATMENT_DEFAULTS.insulins;
  return list.find(function(i){ return i.isDefault; }) || list[0] || { name: 'Novorapid' };
}

// Which insulin was used for a given logged event — explicit per-event
// insulin_type wins, otherwise the current default.
function _insulinForEvent(ev) {
  return (ev && ev.insulin_type) || _defaultInsulin().name;
}

// Which insulin is selected in the currently-open logging sheet/overlay —
// set by the insulin-selector chips (only shown when >1 insulin is active).
// Falls back to the default/primary insulin when nothing has been picked.
function _currentSelectedInsulin() {
  return window._selectedInsulinType || _defaultInsulin().name;
}

// Renders a row of insulin-selector chips when more than one insulin is
// "active" (in rotation). Returns '' (nothing rendered) when there's only
// one — keeps single-insulin households free of extra UI.
// onSelect: name of a global function to call on tap, e.g. '_pickLogInsulin'
function _insulinSelectorHTML(accentRGBA) {
  var active = _activeInsulins();
  if (active.length <= 1) {
    window._selectedInsulinType = active[0] ? active[0].name : _defaultInsulin().name;
    return '';
  }
  if (!window._selectedInsulinType || !active.some(function(i){ return i.name === window._selectedInsulinType; })) {
    window._selectedInsulinType = _defaultInsulin().name;
  }
  var chips = active.map(function(i) {
    var sel = i.name === window._selectedInsulinType;
    return '<button onclick="_pickLogInsulin(\'' + i.name + '\',this)" style="' +
      'padding:5px 12px;border-radius:6px;border:1px solid ' +
      (sel ? accentRGBA.replace('OPACITY','0.5') : 'var(--rv-panel-border)') + ';' +
      'background:' + (sel ? accentRGBA.replace('OPACITY','0.12') : 'transparent') + ';' +
      'font-family:\'DM Mono\',monospace;font-size:11px;' +
      'color:' + (sel ? accentRGBA.replace('OPACITY','0.9') : 'rgba(200,220,240,0.4)') + ';cursor:pointer">' +
      i.name + '</button>';
  }).join('');
  return '<div style="display:flex;align-items:center;gap:6px;margin-bottom:10px">' +
    '<span style="font-family:\'DM Mono\',monospace;font-size:9px;letter-spacing:1px;' +
    'text-transform:uppercase;color:rgba(140,160,180,0.4);margin-right:4px">insulin</span>' +
    chips + '</div>';
}

// Tap handler for the insulin-selector chips above.
function _pickLogInsulin(name, btnEl) {
  window._selectedInsulinType = name;
  if (!btnEl || !btnEl.parentElement) return;
  Array.prototype.forEach.call(btnEl.parentElement.querySelectorAll('button'), function(b) {
    var sel = b.textContent === name;
    b.style.borderColor = sel ? 'rgba(100,200,160,0.5)' : 'var(--rv-panel-border)';
    b.style.background  = sel ? 'rgba(100,200,160,0.12)' : 'transparent';
    b.style.color       = sel ? 'rgba(100,200,160,0.9)'  : 'rgba(200,220,240,0.4)';
  });
}

// Build a single-insulin `insulins` array from a legacy bolus_type string —
// used when reading old therapy_history rows that predate multi-insulin support.
// legacyDia: the row's existing top-level `dia` (e.g. 150 for Oskar's 2.5hr) —
// takes priority over the generic INSULIN_PROFILES default (240/210) so the
// migration doesn't silently widen a patient-configured DIA.
function _deriveInsulinsFromBolusType(bolusType, legacyDia) {
  var name = bolusType || 'Novorapid';
  var p = INSULIN_PROFILES[name] || INSULIN_PROFILES.Novorapid;
  return [{ name: name, peakMins: p.peakMins, diaMins: legacyDia || p.diaMins, active: true, isDefault: true }];
}

var _TREATMENT_DEFAULTS = {
  basalDose: 6,
  basalType: 'Degludec',
  basalTime: '17:00',
  bolusType: 'Novorapid',
  insulins: [
    { name: 'Novorapid', peakMins: 75, diaMins: 240, active: true,  isDefault: true },
    { name: 'Fiasp',     peakMins: 55, diaMins: 210, active: false, isDefault: false },
  ],
  hypoThreshold: 3.9,
  hypoCarbs: 15,
  ratios: [
    { start: '00:00', end: '06:30', ic: 20.0, isf: 6.0, target: 5.5 },
    { start: '06:30', end: '09:30', ic:  6.0, isf: 6.0, target: 5.5 },
    { start: '09:30', end: '11:30', ic: 15.0, isf: 6.0, target: 5.5 },
    { start: '11:30', end: '15:00', ic: 11.5, isf: 6.0, target: 5.5 },
    { start: '15:00', end: '16:30', ic: 15.0, isf: 6.0, target: 5.5 },
    { start: '16:30', end: '19:30', ic: 11.0, isf: 6.0, target: 5.5 },
    { start: '19:30', end: '24:00', ic: 16.0, isf: 6.0, target: 5.5 },
  ]
};

async function _loadTreatmentSettings() {
  // Primary: latest therapy_history row (written on every save, audit-safe)
  if (SUPABASE_READY) {
    try {
      var rows = await _sbFetch(
        'therapy_history?order=t.desc&limit=1&select=ratios,basal_dose,basal_type,basal_time,bolus_type,insulins,hypo_threshold,hypo_carbs,dia,ketone_threshold,ketone_window_mins,hypo_recheck_mins,show_ketone_timer,show_hypo_timer,show_correction_timer',
        {}
      );
      if (rows && rows.length > 0) {
        var r = rows[0];
        // insulins: new multi-insulin rotation. Older rows predate this column
        // (or the column doesn't exist yet) — derive a single-insulin rotation
        // from the legacy bolus_type so existing setups keep working.
        var insulinsList = (Array.isArray(r.insulins) && r.insulins.length)
          ? r.insulins
          : _deriveInsulinsFromBolusType(r.bolus_type, r.dia);
        var defaultIns = insulinsList.find(function(i){ return i.isDefault; }) || insulinsList[0];
        _TREATMENT = Object.assign({}, _TREATMENT_DEFAULTS, {
          basalDose:     r.basal_dose,
          basalType:     r.basal_type     || _TREATMENT_DEFAULTS.basalType,
          basalTime:     r.basal_time     || _TREATMENT_DEFAULTS.basalTime,
          bolusType:     r.bolus_type     || (defaultIns && defaultIns.name) || _TREATMENT_DEFAULTS.bolusType,
          insulins:      insulinsList,
          hypoThreshold: r.hypo_threshold || _TREATMENT_DEFAULTS.hypoThreshold,
          hypoCarbs:     r.hypo_carbs     || _TREATMENT_DEFAULTS.hypoCarbs,
          ratios:        r.ratios         || _TREATMENT_DEFAULTS.ratios,
          dia:           r.dia            || 150,
          // Timer overlay settings (schema migration already applied May 2026)
          ketone_threshold:    r.ketone_threshold    ?? 14.0,
          ketone_window_mins:  r.ketone_window_mins  ?? 120,
          hypo_recheck_mins:   r.hypo_recheck_mins   ?? 15,
          show_ketone_timer:   r.show_ketone_timer   ?? true,
          show_hypo_timer:     r.show_hypo_timer     ?? true,
          show_correction_timer: r.show_correction_timer ?? true,
        });
        return;
      }
    } catch(e) { console.warn('[treatment] therapy_history load failed:', e.message); }
  }
  // Fall back to localStorage
  try {
    var local = JSON.parse(localStorage.getItem('river_treatment') || 'null');
    if (local) { _TREATMENT = Object.assign({}, _TREATMENT_DEFAULTS, local); return; }
  } catch(e) {}
  _TREATMENT = JSON.parse(JSON.stringify(_TREATMENT_DEFAULTS));
}

async function _saveTreatmentSettings(data, effectiveT) {
  _TREATMENT = data;
  try { localStorage.setItem('river_treatment', JSON.stringify(data)); } catch(e) {}
  if (!SUPABASE_READY) return;
  // therapy_history is the sole Supabase target — append-only audit log.
  // (settings table removed — _loadTreatmentSettings reads therapy_history instead)
  // effectiveT lets a therapy change be backdated to when it was actually
  // implemented (e.g. "we switched to Fiasp at dinner two days ago") —
  // defaults to now for a normal settings save.
  var insulinsList = data.insulins || _TREATMENT_DEFAULTS.insulins;
  var defaultIns   = insulinsList.find(function(i){ return i.isDefault; }) || insulinsList[0];
  try {
    await _sbFetch('therapy_history', {
      method: 'POST',
      prefer: 'return=minimal',
      body: [{
        t:              effectiveT || Date.now(),
        basal_dose:     data.basalDose,
        basal_type:     data.basalType,
        basal_time:     data.basalTime,
        bolus_type:     (defaultIns && defaultIns.name) || data.bolusType,
        insulins:       insulinsList,
        hypo_threshold: data.hypoThreshold,
        hypo_carbs:     data.hypoCarbs,
        ratios:         data.ratios,
        dia:            data.dia || 150,
        changed_by:     _deviceId,
      }],
    });
  } catch(e) { console.warn('[treatment] therapy_history save failed:', e.message); }
  // Invalidate the therapy_history lookup cache so backdated/new rows are picked up
  _therapyHistoryCache = null;
}

// ── RETROACTIVE THERAPY CORRECTION ────────────────────────────────────
// River is a SECONDARY record of therapy — the pump/pen app is primary,
// and changes there often only get reflected here days later. Whenever a
// settings save is backdated ("applies from" in the past), every event
// logged from that point onward was actually under the NEW settings, even
// though it was recorded under the old ones. This corrects:
//   - insulin_type on bolus/correction events (drives the IOB curve shape)
//   - therapy_snapshot on events/meal_history/bolus_outcomes (ISF/IC/basal/
//     insulin active at that moment — drives historical analysis/replay)
// Local in-memory + localStorage are corrected immediately (canvas updates
// without reload); Supabase is corrected best-effort, bounded per table —
// larger backdates beyond the cap should go through a SQL backfill session
// (see RIVER_ERD.md maintenance notes).
var THERAPY_CORRECTION_CAP = 200; // rows per table — keep inline correction bounded

// Builds the therapy_snapshot a logged event/meal/outcome at time `t` would
// have captured under `settings` (the just-saved treatment) — mirrors
// _currentTherapySnapshot() but for an arbitrary (possibly backdated) settings object.
function _snapshotFromTherapy(settings, t) {
  var seg = _ratioForTime(settings.ratios, t);
  var insulins = settings.insulins || _TREATMENT_DEFAULTS.insulins;
  var defaultIns = insulins.find(function(i){ return i.isDefault; }) || insulins[0];
  return {
    period: seg ? (seg.start + '-' + seg.end) : null,
    isf: seg && seg.isf,
    ic:  seg && seg.ic,
    basal: settings.basalDose,
    basalType: settings.basalType,
    insulinType: defaultIns ? defaultIns.name : 'Novorapid',
  };
}

async function _correctTherapyForBackdate(fromT, updated) {
  if (!fromT) return;
  var insulins   = updated.insulins || _TREATMENT_DEFAULTS.insulins;
  var defaultIns = insulins.find(function(i){ return i.isDefault; }) || insulins[0];

  // ── Local in-memory + localStorage — immediate canvas/UI correctness ────
  [SESSION, LOGGED_EVENTS, BOLUS_EVENTS].forEach(function(arr) {
    (arr || []).forEach(function(ev) {
      if (!ev || ev.t < fromT) return;
      if ((ev.u || 0) > 0) ev.insulin_type = defaultIns.name;
      if (ev.therapy_snapshot) ev.therapy_snapshot = _snapshotFromTherapy(updated, ev.t);
    });
  });
  (MEAL_HISTORY || []).forEach(function(m) {
    if (m && m.t >= fromT && m.therapy_snapshot) m.therapy_snapshot = _snapshotFromTherapy(updated, m.t);
  });
  try { localStorage.setItem('river_logged', JSON.stringify(LOGGED_EVENTS)); } catch(e) {}
  try { localStorage.setItem('river_session', JSON.stringify(SESSION)); } catch(e) {}
  try { saveMealHistory(); } catch(e) {}

  if (!SUPABASE_READY) return;

  // ── Supabase: insulin_type — single value for all matching rows, cheap bulk PATCH ──
  try {
    await _sbFetch('events?t=gte.' + Math.round(fromT) + '&u=gt.0', {
      method: 'PATCH', prefer: 'return=minimal',
      body: { insulin_type: defaultIns.name },
    });
  } catch(e) { console.warn('[treatment] insulin_type correction PATCH failed:', e.message); }

  // ── Supabase: therapy_snapshot + epoch_t — both vary per row (time-of-day
  // ratio segment / which therapy_history row is now "active as of t"), so
  // correct row-by-row, bounded by THERAPY_CORRECTION_CAP.
  //
  // epoch_t exists so outcome rows can be grouped by "which treatment version
  // produced this result" (e.g. comparing observed-ISF before/after a basal
  // change). A backdated treatment save — logging today that basal actually
  // went up three days ago — must walk every outcome row written in the
  // interim and re-point epoch_t at the (now-earlier) correct version, or
  // those rows stay silently misattributed to the wrong regimen, the same
  // failure mode as a stale predicted_curve.
  ['events', 'meal_history', 'bolus_outcomes'].forEach(function(table) {
    (async function() {
      try {
        var rows = await _sbFetch(
          table + '?t=gte.' + Math.round(fromT) + '&therapy_snapshot=not.is.null' +
          '&select=t&order=t.asc&limit=' + THERAPY_CORRECTION_CAP,
          {}
        );
        for (var i = 0; i < (rows || []).length; i++) {
          var snap = _snapshotFromTherapy(updated, rows[i].t);
          var patchBody = { therapy_snapshot: snap };
          // epoch_t only applies to meal_history/bolus_outcomes (events has no such column).
          // Re-derive per-row via getTherapyAt rather than hardcoding fromT — if there have
          // been multiple therapy changes since fromT (e.g. basal backdated to the 13th, then
          // ISF changed live on the 15th), rows after the 15th must point at the 15th's
          // therapy_history.t, not the 13th's. getTherapyAt already does the correct
          // "last row where row.t <= rows[i].t" lookup, same logic _snapshotFromTherapy's
          // ratio segment relies on, so this stays consistent with the snapshot itself.
          if (table === 'meal_history' || table === 'bolus_outcomes') {
            try {
              var epochRow = await getTherapyAt(rows[i].t);
              patchBody.epoch_t = epochRow ? epochRow.t : fromT;
            } catch(e) { patchBody.epoch_t = fromT; }
          }
          try {
            await _sbFetch(table + '?t=eq.' + rows[i].t, {
              method: 'PATCH', prefer: 'return=minimal',
              body: patchBody,
            });
          } catch(e) { /* best-effort — skip this row */ }
        }
        if (rows && rows.length === THERAPY_CORRECTION_CAP) {
          console.warn('[treatment] ' + table + ' therapy_snapshot/epoch_t correction hit the ' +
            THERAPY_CORRECTION_CAP + '-row cap — older rows need a SQL backfill session');
        }
      } catch(e) { console.warn('[treatment] ' + table + ' therapy_snapshot/epoch_t correction failed:', e.message); }
    })();
  });
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
    return '<input id="tr-' + id + '" type="' + (opts.type||'number') + '" value="' + (val||'') + '" ' +
      (opts.type !== 'time' ? 'min="' + (opts.min||0) + '" max="' + (opts.max||99) + '" step="' + (opts.step||0.5) + '" ' : '') +
      'style="width:' + (opts.w||'60px') + ';padding:6px 8px;border-radius:7px;' +
      'border:1px solid var(--rv-panel-border);background:var(--rv-input-bg);' +
      'font-family:\'DM Mono\',monospace;font-size:13px;' +
      'color:rgba(200,220,240,0.9);text-align:center;outline:none">';
  };

  var ls = 'font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:1.5px;' +
    'text-transform:uppercase;margin-bottom:10px;margin-top:20px;';
  var rs = 'display:flex;align-items:center;justify-content:space-between;' +
    'padding:10px 14px;border-radius:10px;background:var(--rv-input-bg);' +
    'border:1px solid var(--rv-panel-border);margin-bottom:8px;' +
    'font-family:\'DM Mono\',monospace;font-size:11px;';
  var lbl = function(c, tx) {
    return '<span style="font-size:9px;color:' + c + ';min-width:34px;text-align:right">' + tx + '</span>';
  };

  // ── bolus insulin — multi-insulin rotation ───────────────────────────────
  if (!t.insulins || !t.insulins.length) t.insulins = JSON.parse(JSON.stringify(_TREATMENT_DEFAULTS.insulins));

  var insulinRows = _insulinRowsHTML();
  var effectiveTimeHTML = timePickerHTML('tr-effective-time', new Date(), false);

  // ── IC/ISF ratio rows — time-based ──────────────────────────────────────
  var ratioHeader = '<div style="display:flex;align-items:center;justify-content:flex-end;gap:4px;' +
    'padding:0 14px;margin-bottom:4px">' +
    lbl('rgba(255,150,50,0.5)', 'I:C') +
    '<span style="width:60px"></span>' +
    lbl('rgba(80,140,220,0.5)', 'ISF') +
    '<span style="width:60px"></span>' +
    '</div>';

  var ratioRows = ratioHeader + t.ratios.map(function(row, i) {
    var label = (row.start && row.end) ? (row.start + ' – ' + row.end) : (row.period || '');
    return '<div style="' + rs + '">' +
      '<span style="color:rgba(140,180,220,0.6);font-size:10px;min-width:100px;letter-spacing:0.3px">' + label + '</span>' +
      '<div style="display:flex;align-items:center;gap:4px">' +
        lbl('rgba(255,150,50,0.35)', '1:') +
        inp('ic-' + i, row.ic || '', {min:1, max:30, step:0.5}) +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:4px">' +
        lbl('rgba(80,140,220,0.35)', '1:') +
        inp('isf-' + i, row.isf || '', {min:1, max:20, step:0.5}) +
      '</div>' +
    '</div>';
  }).join('');

  el.querySelector('div').innerHTML =
    // ── header ──────────────────────────────────────────────────────────────
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px">' +
      '<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:22px;color:rgba(180,220,200,0.8)">treatment</div>' +
      '<div style="display:flex;gap:10px;align-items:center">' +
        '<button onclick="openTherapyHistory()" style="background:none;border:none;cursor:pointer;' +
          'font-family:\'DM Mono\',monospace;font-size:9px;letter-spacing:1px;text-transform:uppercase;' +
          'color:rgba(140,180,220,0.4);padding:4px 0">view history</button>' +
        '<button onclick="document.getElementById(\'treatment-overlay\').remove()" ' +
          'style="background:none;border:none;cursor:pointer;font-size:22px;color:var(--rv-close-btn);padding:4px">×</button>' +
      '</div>' +
    '</div>' +

    // ── basal ────────────────────────────────────────────────────────────────
    '<div style="' + ls + 'color:rgba(80,140,220,0.5)">basal injection · Degludec</div>' +
    '<div style="' + rs + '">' +
      '<span style="color:rgba(140,180,220,0.6)">daily dose</span>' +
      '<div style="display:flex;align-items:center;gap:6px">' +
        inp('basal', t.basalDose, {min:1, max:80, step:1}) +
        '<span style="font-size:11px;color:rgba(80,140,220,0.6)">U / day</span>' +
      '</div>' +
    '</div>' +
    '<div style="' + rs + '">' +
      '<span style="color:rgba(140,180,220,0.6)">injection time</span>' +
      '<div style="display:flex;align-items:center;gap:6px">' +
        inp('basal-time', t.basalTime || '17:00', {type:'time', w:'90px'}) +
      '</div>' +
    '</div>' +

    // ── bolus insulin ────────────────────────────────────────────────────────
    '<div style="' + ls + 'color:rgba(100,180,140,0.5)">bolus insulin · rotation</div>' +
    '<div id="tr-insulins-section">' + insulinRows + '</div>' +
    '<div style="font-family:\'DM Mono\',monospace;font-size:8px;color:rgba(120,140,160,0.4);' +
      'line-height:1.6;margin:6px 0 4px;padding:0 2px">' +
      'tap <b>default</b> to set the primary insulin used for new doses · ' +
      'toggle <b>active</b> to keep an insulin available in the at-dose selector ' +
      'without making it the default · peak/DIA per insulin are editable and ' +
      'versioned with every save' +
    '</div>' +
    '<div style="' + ls + 'color:rgba(140,180,220,0.5)">this save applies from</div>' +
    effectiveTimeHTML +
    '<div style="font-family:\'DM Mono\',monospace;font-size:8px;color:rgba(120,140,160,0.4);' +
      'line-height:1.6;margin:-4px 0 4px;padding:0 2px">' +
      'River is a secondary record — the pump/pen app is primary, so changes ' +
      'here are often entered after the fact. If anything on this screen ' +
      '(insulin, ratios, basal, DIA, hypo settings) actually changed earlier, ' +
      'set this to when it really happened. Every bolus/correction/meal logged ' +
      'from that time onward will be corrected to match — insulin curve shape, ' +
      'ISF/IC/basal snapshot, all of it' +
    '</div>' +

    // ── hypo ─────────────────────────────────────────────────────────────────
    '<div style="' + ls + 'color:rgba(255,210,40,0.5)">hypo</div>' +
    '<div style="' + rs + '">' +
      '<span style="color:rgba(200,180,80,0.6)">hypo threshold</span>' +
      '<div style="display:flex;align-items:center;gap:6px">' +
        inp('hypo-thr', t.hypoThreshold, {min:2, max:6, step:0.1}) +
        '<span style="font-size:10px;color:rgba(200,180,80,0.5)">mmol/L</span>' +
      '</div>' +
    '</div>' +
    '<div style="' + rs + '">' +
      '<span style="color:rgba(200,180,80,0.6)">hypo treatment</span>' +
      '<div style="display:flex;align-items:center;gap:6px">' +
        inp('hypo-carbs', t.hypoCarbs, {min:5, max:40, step:5}) +
        '<span style="font-size:10px;color:rgba(200,180,80,0.5)">g fast carbs</span>' +
      '</div>' +
    '</div>' +

    // ── ratios ───────────────────────────────────────────────────────────────
    '<div style="' + ls + 'color:rgba(255,150,50,0.5)">' +
      '<span>ratios</span>' +
      '<span style="float:right;font-size:8px;opacity:0.5">I:C = carbs per unit · ISF = mmol drop per unit</span>' +
    '</div>' +
    ratioRows +

    // ── save / footer ────────────────────────────────────────────────────────
    '<button onclick="saveTreatmentForm()" ' +
      'style="width:100%;margin-top:24px;padding:13px;border-radius:10px;' +
      'border:1px solid rgba(62,180,120,0.3);background:rgba(62,180,120,0.08);' +
      'font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:17px;' +
      'color:rgba(62,180,120,0.9);cursor:pointer">save & sync</button>' +
    '<div style="font-family:\'DM Mono\',monospace;font-size:8px;color:rgba(120,140,160,0.3);' +
      'text-align:center;margin-top:16px;line-height:1.6">' +
      'synced across all devices · every save is logged · confirm changes with your clinical team' +
    '</div>';
}

// ── INSULIN ROTATION MANAGEMENT (treatment panel) ───────────────────────
// Renders the per-insulin rows: name + PK info, "default" + "active"
// toggles, plus an "add" row for any known insulin not yet in rotation.
function _insulinRowsHTML() {
  if (!_TREATMENT) _TREATMENT = JSON.parse(JSON.stringify(_TREATMENT_DEFAULTS));
  var insulins = _TREATMENT.insulins || _TREATMENT_DEFAULTS.insulins;

  var rowStyle = 'display:flex;align-items:center;justify-content:space-between;' +
    'padding:9px 12px;border-radius:9px;background:var(--rv-input-bg);' +
    'border:1px solid var(--rv-panel-border);margin-bottom:6px;';

  var btn = function(label, on, onColor) {
    return 'style="padding:5px 10px;border-radius:6px;border:1px solid ' +
      (on ? onColor.replace('OPACITY', '0.5') : 'var(--rv-panel-border)') + ';' +
      'background:' + (on ? onColor.replace('OPACITY', '0.1') : 'transparent') + ';' +
      'font-family:\'DM Mono\',monospace;font-size:9px;letter-spacing:0.5px;text-transform:uppercase;' +
      'color:' + (on ? onColor.replace('OPACITY', '0.9') : 'rgba(200,220,240,0.4)') + ';cursor:pointer">' + label + '</button>';
  };

  var numInp = function(id, val, opts) {
    return '<input id="' + id + '" type="number" value="' + val + '" ' +
      'min="' + opts.min + '" max="' + opts.max + '" step="' + opts.step + '" ' +
      'onchange="_setInsulinTiming(\'' + opts.name + '\',\'' + opts.field + '\',this.value)" ' +
      'style="width:46px;padding:4px 6px;border-radius:6px;' +
      'border:1px solid var(--rv-panel-border);background:var(--rv-panel-bg);' +
      'font-family:\'DM Mono\',monospace;font-size:11px;color:rgba(200,220,240,0.85);' +
      'text-align:center;outline:none">';
  };

  var rows = insulins.map(function(ins) {
    var rowId = 'tr-ins-' + ins.name.replace(/[^a-z0-9]/gi,'');
    return '<div style="' + rowStyle + 'flex-direction:column;align-items:stretch;gap:8px">' +
      '<div style="display:flex;align-items:center;justify-content:space-between">' +
        '<div style="font-size:11px;color:rgba(200,220,240,0.85)">' + ins.name +
          (ins.isDefault ? ' <span style="font-size:8px;color:rgba(100,200,160,0.7);letter-spacing:0.5px;text-transform:uppercase">· default</span>' : '') +
        '</div>' +
        '<div style="display:flex;gap:6px;flex-shrink:0">' +
          '<button onclick="_setDefaultInsulinUI(\'' + ins.name + '\')" ' +
            btn('default', !!ins.isDefault, 'rgba(100,200,160,OPACITY)') +
          '<button onclick="_toggleInsulinActive(\'' + ins.name + '\')" ' +
            btn(ins.active ? 'active' : 'inactive', !!ins.active, 'rgba(80,140,220,OPACITY)') +
        '</div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:14px">' +
        '<div style="display:flex;align-items:center;gap:6px">' +
          numInp(rowId + '-peak', ins.peakMins, {min:10, max:180, step:5, name:ins.name, field:'peakMins'}) +
          '<span style="font-size:9px;color:rgba(160,200,180,0.5)">peak min</span>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:6px">' +
          numInp(rowId + '-dia', +(ins.diaMins/60).toFixed(1), {min:1, max:8, step:0.5, name:ins.name, field:'diaMins'}) +
          '<span style="font-size:9px;color:rgba(160,200,180,0.5)">DIA hrs</span>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  // Offer any known insulin not yet in the rotation
  var available = Object.keys(INSULIN_PROFILES).filter(function(name) {
    return !insulins.some(function(i){ return i.name === name; });
  });
  var addRow = '';
  if (available.length) {
    addRow = '<div style="display:flex;gap:6px;margin-top:4px">' +
      '<select id="tr-add-insulin" style="flex:1;padding:7px 8px;border-radius:7px;' +
        'border:1px solid var(--rv-panel-border);background:var(--rv-input-bg);' +
        'font-family:\'DM Mono\',monospace;font-size:10px;color:rgba(200,220,240,0.7)">' +
        available.map(function(name) {
          return '<option value="' + name + '">' + name + ' — ' + (INSULIN_PROFILES[name].info || '') + '</option>';
        }).join('') +
      '</select>' +
      '<button onclick="_addInsulinToRotation(document.getElementById(\'tr-add-insulin\').value)" ' +
        'style="padding:7px 12px;border-radius:7px;border:1px solid rgba(100,200,160,0.3);' +
        'background:rgba(100,200,160,0.08);font-family:\'DM Mono\',monospace;font-size:10px;' +
        'color:rgba(100,200,160,0.8);cursor:pointer">+ add</button>' +
    '</div>';
  }

  return rows + addRow;
}

function _refreshInsulinSection() {
  var section = document.getElementById('tr-insulins-section');
  if (section) section.innerHTML = _insulinRowsHTML();
}

// Sets the primary/default insulin — used for new doses by default, and as
// the fallback for any logged event with no explicit insulin_type. The
// default insulin is always kept active.
function _setDefaultInsulinUI(name) {
  if (!_TREATMENT) return;
  (_TREATMENT.insulins || []).forEach(function(i) {
    i.isDefault = (i.name === name);
    if (i.name === name) i.active = true;
  });
  _refreshInsulinSection();
}

// Updates peak/DIA for one insulin in the rotation — patient-configurable
// (e.g. Oskar's bolus calc uses 2.5hr DIA, not the generic Novorapid 4hr
// default). Persisted via the normal save → versioned in therapy_history.insulins.
function _setInsulinTiming(name, field, rawValue) {
  if (!_TREATMENT) return;
  var ins = (_TREATMENT.insulins || []).find(function(i){ return i.name === name; });
  if (!ins) return;
  var v = parseFloat(rawValue);
  if (!v || v <= 0) return;
  ins[field] = (field === 'diaMins') ? Math.round(v * 60) : Math.round(v); // DIA input is in hours
}

// Toggles whether an insulin is "in rotation" (offered at correction/meal
// time when more than one is active). The default insulin can't be
// deactivated — switch the default first.
function _toggleInsulinActive(name) {
  if (!_TREATMENT) return;
  var ins = (_TREATMENT.insulins || []).find(function(i){ return i.name === name; });
  if (!ins) return;
  if (ins.isDefault) { showToast('default insulin stays active — set a different default first'); return; }
  ins.active = !ins.active;
  _refreshInsulinSection();
}

// Adds a known insulin (Novorapid/Fiasp/Humalog/etc) to the rotation,
// inactive by default — toggle it active once ready to use it.
function _addInsulinToRotation(name) {
  if (!_TREATMENT || !name) return;
  if ((_TREATMENT.insulins || []).some(function(i){ return i.name === name; })) return;
  var p = INSULIN_PROFILES[name] || INSULIN_PROFILES.Novorapid;
  if (!_TREATMENT.insulins) _TREATMENT.insulins = [];
  _TREATMENT.insulins.push({ name: name, peakMins: p.peakMins, diaMins: p.diaMins, active: false, isDefault: false });
  _refreshInsulinSection();
}

async function openTherapyHistory() {
  var ex = document.getElementById('therapy-hist-overlay');
  if (ex) { ex.remove(); return; }

  var el = document.createElement('div');
  el.id = 'therapy-hist-overlay';
  el.style.cssText = 'position:fixed;inset:0;z-index:80;background:rgba(3,5,20,0.97);' +
    'backdrop-filter:blur(16px);overflow-y:auto;display:flex;flex-direction:column;' +
    'align-items:center;padding:env(safe-area-inset-top,48px) 20px 60px;font-family:\'DM Mono\',monospace';
  el.innerHTML = '<div style="max-width:380px;width:100%">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;padding:20px 0 16px">' +
      '<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:20px;' +
        'color:rgba(180,220,200,0.8)">therapy history</div>' +
      '<button onclick="document.getElementById(\'therapy-hist-overlay\').remove()" ' +
        'style="background:none;border:none;cursor:pointer;font-size:22px;color:rgba(200,220,240,0.4)">×</button>' +
    '</div>' +
    '<div style="font-size:10px;color:rgba(140,160,180,0.4);text-align:center;padding:20px 0">loading…</div>' +
    '</div>';
  document.body.appendChild(el);

  try {
    // Fetch most-recent-first; we reverse to do oldest→newest for diffing, then re-reverse for display
    var rows = await _sbFetch(
      'therapy_history?order=t.asc&limit=60&select=t,basal_dose,basal_type,bolus_type,basal_time,hypo_threshold,hypo_carbs,ratios,dia,changed_by',
      {}
    );
    if (!rows || !rows.length) {
      el.querySelector('div').innerHTML = el.querySelector('div').innerHTML.replace(
        'loading…', 'no history yet');
      return;
    }

    // ── diff helpers ─────────────────────────────────────────────────────────
    function _diffRows(prev, curr) {
      // Returns array of {label, from, to} for every field that changed
      var diffs = [];
      function chk(label, a, b) {
        if (a === null || a === undefined) a = '—';
        if (b === null || b === undefined) b = '—';
        if (String(a) !== String(b)) diffs.push({label: label, from: String(a), to: String(b)});
      }
      if (!prev) return null; // first row — no diff, show as baseline

      chk('basal dose', prev.basal_dose, curr.basal_dose);
      chk('basal type', prev.basal_type, curr.basal_type);
      chk('basal time', prev.basal_time, curr.basal_time);
      chk('bolus type', prev.bolus_type, curr.bolus_type);
      chk('hypo threshold', prev.hypo_threshold, curr.hypo_threshold);
      chk('hypo treatment', prev.hypo_carbs, curr.hypo_carbs);
      chk('DIA', prev.dia, curr.dia);

      // Ratio diffs — match segments by index (same structure assumed)
      var pr = prev.ratios || [], cr = curr.ratios || [];
      var len = Math.max(pr.length, cr.length);
      for (var i = 0; i < len; i++) {
        var ps = pr[i], cs = cr[i];
        if (!ps && cs) { diffs.push({label: (cs.start||cs.period||'seg '+i), from: '—', to: 'added'}); continue; }
        if (ps && !cs) { diffs.push({label: (ps.start||ps.period||'seg '+i), from: 'present', to: 'removed'}); continue; }
        var segLabel = (cs.start && cs.end) ? cs.start + '–' + cs.end : (cs.period || 'seg ' + i);
        if (String(ps.ic) !== String(cs.ic))  diffs.push({label: segLabel + ' I:C', from: '1:'+ps.ic, to: '1:'+cs.ic});
        if (String(ps.isf) !== String(cs.isf)) diffs.push({label: segLabel + ' ISF', from: String(ps.isf), to: String(cs.isf)});
        if (String(ps.start) !== String(cs.start) || String(ps.end) !== String(cs.end))
          diffs.push({label: 'seg ' + i + ' times', from: (ps.start||'')+'–'+(ps.end||''), to: (cs.start||'')+'–'+(cs.end||'')});
      }
      return diffs;
    }

    function _whoLabel(changed_by, isMe) {
      if (changed_by === 'backfill') return { text: 'backfill import', col: 'rgba(160,140,200,0.5)' };
      if (!changed_by)              return { text: 'unknown',         col: 'rgba(140,160,180,0.3)' };
      var shortId = changed_by.replace('dev_','').slice(0,8);
      if (isMe) return { text: 'this device (' + shortId + ')', col: 'rgba(100,200,160,0.6)' };
      return       { text: shortId,                              col: 'rgba(140,180,220,0.5)' };
    }

    // Build display newest-first; diffs reference the row that came before
    var displayRows = rows.slice().reverse(); // newest first
    var srcRows     = rows;                   // oldest first — index i in displayRows = srcRows[rows.length-1-i]

    var html = '<div style="max-width:380px;width:100%">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:20px 0 4px">' +
        '<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:20px;' +
          'color:rgba(180,220,200,0.8)">therapy history</div>' +
        '<button onclick="document.getElementById(\'therapy-hist-overlay\').remove()" ' +
          'style="background:none;border:none;cursor:pointer;font-size:22px;color:rgba(200,220,240,0.4)">×</button>' +
      '</div>' +
      '<div style="font-size:9px;color:rgba(140,160,180,0.35);margin-bottom:18px;letter-spacing:0.5px">' +
        displayRows.length + ' entries · newest first · highlighted = changed from previous' +
      '</div>';

    displayRows.forEach(function(r, di) {
      var srcIdx  = srcRows.length - 1 - di;
      var prev    = srcIdx > 0 ? srcRows[srcIdx - 1] : null;
      var diffs   = _diffRows(prev, r);
      var isFirst = !prev;
      var isMe    = r.changed_by === _deviceId;
      var who     = _whoLabel(r.changed_by, isMe);

      var d = new Date(r.t);
      var dateStr = d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
      var timeStr = d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});

      // Card border: amber if has diffs (user-initiated change), muted if backfill/baseline
      var isBackfill = r.changed_by === 'backfill';
      var hasDiffs   = diffs && diffs.length > 0;
      var borderCol  = isBackfill  ? 'rgba(160,140,200,0.15)'
                     : hasDiffs    ? 'rgba(255,180,60,0.25)'
                     : 'rgba(255,255,255,0.06)';
      var bgCol      = isBackfill  ? 'rgba(160,140,200,0.03)'
                     : hasDiffs    ? 'rgba(255,180,60,0.04)'
                     : 'rgba(255,255,255,0.02)';

      html += '<div style="border:1px solid ' + borderCol + ';border-radius:10px;' +
        'padding:12px 14px;margin-bottom:10px;background:' + bgCol + '">';

      // ── card header ────────────────────────────────────────────────────────
      html += '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">' +
        '<div>' +
          '<span style="font-size:11px;color:rgba(180,220,200,0.8);font-weight:500">' + dateStr + '</span>' +
          '<span style="font-size:10px;color:rgba(140,180,160,0.5);margin-left:6px">' + timeStr + '</span>' +
        '</div>' +
        '<span style="font-size:9px;color:' + who.col + ';text-align:right">' + who.text + '</span>' +
      '</div>';

      // ── baseline vs diff summary ───────────────────────────────────────────
      // Helper: render full ratio table (used for first row and expand toggles)
      function _fullRatioTable(ratios, opacity) {
        var op = opacity || '0.45';
        return (ratios||[]).map(function(seg) {
          var label = (seg.start && seg.end) ? seg.start + '–' + seg.end : (seg.period||'');
          return '<div style="display:grid;grid-template-columns:100px 1fr 1fr;' +
            'font-size:9px;color:rgba(200,220,240,' + op + ');padding:2px 0;gap:4px">' +
            '<span>' + label + '</span>' +
            '<span style="color:rgba(255,150,50,0.6)">I:C 1:' + (seg.ic||'—') + '</span>' +
            '<span style="color:rgba(80,140,220,0.55)">ISF ' + (seg.isf||'—') + '</span>' +
            '</div>';
        }).join('');
      }

      // Helper: render diff lines
      function _diffLines(diffs) {
        return diffs.map(function(diff) {
          return '<div style="display:flex;align-items:center;gap:6px;' +
            'padding:4px 8px;margin-bottom:3px;border-radius:6px;' +
            'background:rgba(255,180,60,0.06);border:1px solid rgba(255,180,60,0.12)">' +
            '<span style="font-size:9px;color:rgba(200,220,240,0.4);min-width:110px;flex-shrink:0">' +
              diff.label + '</span>' +
            '<span style="font-size:10px;color:rgba(255,120,80,0.7);text-decoration:line-through;' +
              'white-space:nowrap">' + diff.from + '</span>' +
            '<span style="font-size:10px;color:rgba(140,160,180,0.4);flex-shrink:0">→</span>' +
            '<span style="font-size:10px;color:rgba(100,200,150,0.9);font-weight:500;' +
              'white-space:nowrap">' + diff.to + '</span>' +
            '</div>';
        }).join('');
      }

      var toggleId = 'th-expand-' + di;

      if (isFirst) {
        // Very first (oldest) row — always show full table as baseline
        html += '<div style="font-size:9px;color:rgba(100,180,140,0.5);margin-bottom:6px">baseline snapshot</div>';
        html += '<div style="font-size:9px;color:rgba(140,180,220,0.5);margin-bottom:6px">' +
          (r.basal_type||'') + (r.basal_dose ? ' · ' + r.basal_dose + 'U/day' : '') +
          (r.basal_time ? ' · inj ' + r.basal_time : '') +
          (r.bolus_type ? ' · ' + r.bolus_type : '') + '</div>';
        html += _fullRatioTable(r.ratios);

      } else if (hasDiffs) {
        // Has changes — show diffs, with expand toggle for full table
        html += '<div style="margin-top:2px">' + _diffLines(diffs) + '</div>';
        // Always offer the full table as a toggle below the diffs
        html += '<button onclick="var s=document.getElementById(\''+toggleId+'\');' +
          's.style.display=s.style.display===\'none\'?\'block\':\'none\';' +
          'this.textContent=s.style.display===\'none\'?\'show full settings ▾\':\'hide ▴\'" ' +
          'style="background:none;border:none;cursor:pointer;font-size:9px;' +
          'color:rgba(140,160,180,0.3);padding:2px 0;margin-top:4px">show full settings ▾</button>';
        html += '<div id="' + toggleId + '" style="display:none;margin-top:6px;' +
          'padding-top:6px;border-top:1px solid rgba(255,255,255,0.05)">' +
          _fullRatioTable(r.ratios) + '</div>';

      } else {
        // No changes from previous (e.g. re-save without edits)
        html += '<div style="font-size:9px;color:rgba(140,160,180,0.3);font-style:italic">no changes from previous</div>';
        html += '<button onclick="var s=document.getElementById(\''+toggleId+'\');' +
          's.style.display=s.style.display===\'none\'?\'block\':\'none\';' +
          'this.textContent=s.style.display===\'none\'?\'show settings ▾\':\'hide ▴\'" ' +
          'style="background:none;border:none;cursor:pointer;font-size:9px;' +
          'color:rgba(140,160,180,0.25);padding:2px 0;margin-top:4px">show settings ▾</button>';
        html += '<div id="' + toggleId + '" style="display:none;margin-top:6px">' +
          _fullRatioTable(r.ratios) + '</div>';
      }

      html += '</div>'; // end card
    });

    html += '</div>';
    el.innerHTML = html;
  } catch(e) {
    console.error('[therapyHistory]', e);
    var inner = el.querySelector('div');
    if (inner) inner.innerHTML = inner.innerHTML.replace('loading…',
      '<span style="color:rgba(255,100,80,0.7)">failed to load: ' + e.message + '</span>');
  }
}

function saveTreatmentForm() {
  var getN = function(id) { var el = document.getElementById('tr-' + id); return el ? parseFloat(el.value) || 0 : 0; };
  var getS = function(id) { var el = document.getElementById('tr-' + id); return el ? el.value : ''; };
  var insulinsList = (_TREATMENT && _TREATMENT.insulins) || _TREATMENT_DEFAULTS.insulins;
  var defaultEntry = insulinsList.find(function(i){ return i.isDefault; }) || insulinsList[0];
  var newDefault   = defaultEntry.name;
  var updated = {
    basalDose:     getN('basal'),
    basalType:     'Degludec',
    basalTime:     getS('basal-time') || '17:00',
    bolusType:     newDefault,
    insulins:      insulinsList,
    hypoThreshold: getN('hypo-thr'),
    hypoCarbs:     getN('hypo-carbs'),
    // Legacy single-DIA fallback (used by iobF when no insulin is specified) —
    // kept in sync with the default insulin's (now patient-editable) DIA.
    dia:           defaultEntry.diaMins || (_TREATMENT && _TREATMENT.dia) || 150,
    ratios: (_TREATMENT || _TREATMENT_DEFAULTS).ratios.map(function(row, i) {
      return {
        start:  row.start  || null,
        end:    row.end    || null,
        period: row.period || null,
        isf: getN('isf-' + i),
        ic:  getN('ic-'  + i) || null,
        target: row.target || 5.5,
      };
    })
  };

  // "applies from" — lets ANY treatment change (ratios, basal, hypo, DIA,
  // insulin) be backdated to when it actually took effect on the
  // pump/pen — River is a secondary record and edits here are often
  // retrospective. Anything more than a few minutes in the past triggers
  // the retroactive correction below.
  var effectiveT = getTimeVal('tr-effective-time');
  var isBackdated = (Date.now() - effectiveT) > 5 * 60000;

  _saveTreatmentSettings(updated, effectiveT).then(function() {
    if (isBackdated) {
      // Retroactively correct insulin_type + therapy_snapshot on every
      // event/meal/outcome logged since effectiveT — they were under
      // these new settings even though logged before this save.
      _correctTherapyForBackdate(effectiveT, updated).then(function() {
        showToast('treatment saved ✓\napplied from ' +
          new Date(effectiveT).toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) +
          ' — past entries corrected');
        _ptCache = null;
      });
    } else {
      showToast('treatment settings saved ✓');
    }
    var el = document.getElementById('treatment-overlay');
    if (el) el.remove();
  });
}

window.addEventListener('load',()=>{
  // Load any persisted CGM history from previous sessions
  loadPersistedReadings();
  _loadTimerState(); // restore timer UI state (minimised flags) from localStorage

  // If no embedded history, start at now
  if (HISTORY_RAW.length === 0) updateCGMBounds();
  viewTime = Date.now(); // wall clock master
  viewSpan = 2*3600000;
  try{
    SESSION=JSON.parse(localStorage.getItem('river_session')||'[]'); SESSION=SESSION.filter(s=>(Date.now()-s.t)<6*3600000);
  }catch(e){}
  const pal=palette(Date.now());
  document.body.style.background='#05070f';
  document.getElementById('loading').style.background='#05070f';

  requestAnimationFrame(ts=>{t0=ts; requestAnimationFrame(frame);});
  setTimeout(()=>{
    document.getElementById('loading').classList.add('gone');
    setTimeout(()=>document.getElementById('loading').style.display='none',700);
  },1000);

  // Start Supabase sync
  startSyncPolling();
  // Backfill review module
    if (typeof initBackfill === 'function') initBackfill();
  
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
    setTimeout(function(){ showDemoWelcome(); }, 900);
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

async function openInsightsPanel() {
  var ex = document.getElementById('insights-overlay');
  if (ex) ex.remove();

  // ── Show loading shell immediately ───────────────────────────────────────
  var el = document.createElement('div');
  el.id  = 'insights-overlay';
  el.style.cssText = 'position:fixed;inset:0;z-index:90;background:rgba(3,5,20,0.97);' +
    'backdrop-filter:blur(20px);overflow-y:auto;-webkit-overflow-scrolling:touch;' +
    'font-family:"DM Mono",monospace;color:rgba(200,220,240,0.85);';
  el.innerHTML = '<div style="max-width:540px;margin:0 auto;padding:env(safe-area-inset-top,24px) 20px 80px">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;padding:20px 0 24px;border-bottom:1px solid rgba(255,255,255,0.07);margin-bottom:24px">' +
    '<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:22px;color:rgba(200,220,240,0.9)">insights</div>' +
    '<button onclick="document.getElementById(\'insights-overlay\').remove()" style="background:none;border:none;cursor:pointer;font-size:24px;color:rgba(200,220,240,0.4);padding:4px">×</button></div>' +
    '<div id="insights-loading" style="text-align:center;padding:40px 0;font-size:10px;letter-spacing:1px;color:rgba(200,220,240,0.3)">loading from supabase…</div>' +
    '</div>';
  document.body.appendChild(el);

  // ── Fetch from Supabase ──────────────────────────────────────────────────
  var now = Date.now();
  var windowMs = 90 * 24 * 3600000;
  var since = now - windowMs;

  var sbReadings = [], sbMeals = [], sbEvents = [];
  try {
    var rRows = await _sbFetch(
      'readings?t=gte.' + since + '&order=t.asc&limit=50000',
      { method: 'GET' }
    );
    if (Array.isArray(rRows)) sbReadings = rRows;
  } catch(e) { console.warn('[insights panel] CGM fetch:', e.message); }

  try {
    var mRows = await _sbFetch(
      'meal_history?t=gte.' + since + '&order=t.desc&limit=200&select=t,name,total_carbs,bolus_u,pre_bg,peak_bg,items',
      { method: 'GET' }
    );
    if (Array.isArray(mRows)) sbMeals = mRows;
  } catch(e) { console.warn('[insights panel] meal fetch:', e.message); }

  try {
    var eRows = await _sbFetch(
      'events?t=gte.' + since + '&note=eq.prick&select=t,gi&order=t.asc&limit=500',
      { method: 'GET' }
    );
    if (Array.isArray(eRows)) sbEvents = eRows;
  } catch(e) { console.warn('[insights panel] prick fetch:', e.message); }

  // ── Merge Supabase with in-memory (Supabase wins on overlap) ────────────
  var localTs = new Set(sbReadings.map(function(r){ return r.t; }));
  var readings = sbReadings.slice();
  HISTORY_RAW.forEach(function(r){
    if (r && r.bg > 0 && !localTs.has(r.t)) readings.push({ t: r.t, bg: r.bg });
  });
  readings.sort(function(a,b){ return a.t - b.t; });

  var pricks = sbEvents.filter(function(e){ return e.gi > 0; }).map(function(e){
    return { t: e.t, bg: e.gi, cgm_reading: e.cgm_reading };
  });
  // Also add localStorage pricks not in Supabase
  var sbPrickTs = new Set(pricks.map(function(p){ return p.t; }));
  var localPricks = (function(){ try{ return JSON.parse(localStorage.getItem('river_pricks')||'[]'); }catch(e){ return []; } })();
  localPricks.forEach(function(p){ if(p && p.bg && p.t && !sbPrickTs.has(p.t)) pricks.push(p); });

  var meals = sbMeals.length ? sbMeals.map(function(m){
    return { t: m.t, name: m.name, totalCarbs: m.total_carbs, u: m.bolus_u, pre_bg: m.pre_bg, peak_bg: m.peak_bg, items: m.items };
  }) : (MEAL_HISTORY || []);

  // ── Compute stats ─────────────────────────────────────────────────────────
  var inRange    = readings.filter(function(r){ return r.bg >= 3.9 && r.bg <= 10.0; }).length;
  var belowRange = readings.filter(function(r){ return r.bg < 3.9; }).length;
  var aboveRange = readings.filter(function(r){ return r.bg > 10.0; }).length;
  var total      = readings.length || 1;
  var meanBG     = readings.reduce(function(s,r){return s+r.bg;},0) / total;
  var eA1C       = ((meanBG + 2.59) / 1.59).toFixed(1);
  var tirPct     = Math.round(100 * inRange / total);
  var belPct     = Math.round(100 * belowRange / total);
  var abvPct     = Math.round(100 * aboveRange / total);

  var dateMin = readings.length ? new Date(readings[0].t).toLocaleDateString('en-GB',{day:'numeric',month:'short'}) : '—';
  var dateMax = readings.length ? new Date(readings[readings.length-1].t).toLocaleDateString('en-GB',{day:'numeric',month:'short'}) : '—';

  // ── Hourly buckets ────────────────────────────────────────────────────────
  var hourBuckets = [];
  for (var h = 0; h < 24; h++) hourBuckets.push([]);
  readings.forEach(function(r){ hourBuckets[new Date(r.t).getHours()].push(r.bg); });
  pricks.forEach(function(p){ if(p && p.bg && p.t) hourBuckets[new Date(p.t).getHours()].push(p.bg); });
  var hourMeans = hourBuckets.map(function(b){ return b.length ? b.reduce(function(s,v){return s+v;},0)/b.length : null; });
  var hourP10   = hourBuckets.map(function(b){ if(!b.length) return null; var s=[...b].sort(function(a,c){return a-c;}); return s[Math.floor(s.length*0.1)]; });
  var hourP90   = hourBuckets.map(function(b){ if(!b.length) return null; var s=[...b].sort(function(a,c){return a-c;}); return s[Math.floor(s.length*0.9)]; });

  // ── Meal response ─────────────────────────────────────────────────────────
  var mealStats = meals.slice(0,8).map(function(m){
    var preMeal = m.pre_bg || null;
    var peakRise = (m.peak_bg && preMeal) ? +(m.peak_bg - preMeal).toFixed(1) : null;
    var window2hr = readings.filter(function(r){ return r.t >= m.t && r.t <= m.t + 7200000; });
    if (!preMeal && window2hr.length) {
      var prePts = readings.filter(function(r){ return r.t >= m.t - 600000 && r.t < m.t; });
      preMeal = prePts.length ? prePts[prePts.length-1].bg : window2hr[0].bg;
      var peak = window2hr.reduce(function(best,r){ return r.bg > best.bg ? r : best; }, window2hr[0]);
      peakRise = +(peak.bg - preMeal).toFixed(1);
    }
    return { name: m.name, totalCarbs: m.totalCarbs, preMeal: preMeal, peakRise: peakRise };
  }).filter(function(m){ return m.preMeal !== null && m.peakRise !== null; });

  var avgRise = mealStats.length ? (mealStats.reduce(function(s,m){return s+(m.peakRise||0);},0)/mealStats.length).toFixed(1) : '—';

  // ── Sensor lag ────────────────────────────────────────────────────────────
  var lagPairs = pricks.map(function(p){
    var cgm = readings.find(function(r){ return Math.abs(r.t - p.t) < 600000; });
    return cgm ? { prick: p.bg, cgm: cgm.bg, delta: +(p.bg - cgm.bg).toFixed(1), t: p.t } : null;
  }).filter(Boolean);
  var meanLag = lagPairs.length ? (lagPairs.reduce(function(s,p){return s+p.delta;},0)/lagPairs.length).toFixed(2) : null;
  var sdLag   = (lagPairs.length > 1) ? (function(){
    var m2 = lagPairs.reduce(function(s,p){return s+p.delta;},0)/lagPairs.length;
    return Math.sqrt(lagPairs.reduce(function(s,p){return s+Math.pow(p.delta-m2,2);},0)/lagPairs.length).toFixed(2);
  })() : null;

  // ── Replace loading state with full content ───────────────────────────────
  var s = '<div style="max-width:540px;margin:0 auto;padding:env(safe-area-inset-top,24px) 20px 80px">';
  s += '<div style="display:flex;justify-content:space-between;align-items:center;' +
    'padding:20px 0 24px;border-bottom:1px solid rgba(255,255,255,0.07);margin-bottom:24px">';
  s += '<div style="font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;' +
    'font-size:22px;color:rgba(200,220,240,0.9)">insights</div>';
  s += '<button onclick="document.getElementById(\'insights-overlay\').remove()" ' +
    'style="background:none;border:none;cursor:pointer;font-size:24px;' +
    'color:rgba(200,220,240,0.4);padding:4px">×</button></div>';

  // Section 1: Overview
  s += '<div style="margin-bottom:28px">';
  s += '<div style="font-size:10px;letter-spacing:1.5px;text-transform:uppercase;' +
    'color:rgba(200,220,240,0.4);margin-bottom:14px">overview · ' + dateMin + ' – ' + dateMax + '</div>';
  s += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:14px">';
  s += '<div style="background:rgba(255,255,255,0.04);border-radius:10px;padding:14px;text-align:center">';
  s += '<div style="font-size:24px;font-weight:500;color:rgba(62,180,160,0.9)">' + meanBG.toFixed(1) + '</div>';
  s += '<div style="font-size:9px;color:rgba(200,220,240,0.4);margin-top:4px">mean mmol</div></div>';
  s += '<div style="background:rgba(255,255,255,0.04);border-radius:10px;padding:14px;text-align:center">';
  s += '<div style="font-size:24px;font-weight:500;color:rgba(62,180,120,' + (tirPct>=70?'0.9':'0.6') + ')">' + tirPct + '%</div>';
  s += '<div style="font-size:9px;color:rgba(200,220,240,0.4);margin-top:4px">in range</div></div>';
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
    total + ' readings · ' + (sbReadings.length ? sbReadings.length + ' from supabase' : 'local cache only') +
    ' · eA1c is a formula estimate, not a calibrated GMI</div></div>';

  // Section 2: 24-hour profile
  s += '<div style="margin-bottom:28px">';
  s += '<div style="font-size:10px;letter-spacing:1.5px;text-transform:uppercase;' +
    'color:rgba(200,220,240,0.4);margin-bottom:14px">24-hour profile</div>';
  s += '<canvas id="insights-hour-canvas" width="500" height="140" style="width:100%;height:auto;' +
    'border-radius:8px;background:rgba(255,255,255,0.03)"></canvas>';
  s += '</div>';

  // Section 3: Meal response
  s += '<div style="margin-bottom:28px">';
  s += '<div style="font-size:10px;letter-spacing:1.5px;text-transform:uppercase;' +
    'color:rgba(200,220,240,0.4);margin-bottom:14px">meal response</div>';
  if (mealStats.length) {
    s += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">';
    s += '<div style="background:rgba(255,255,255,0.04);border-radius:8px;padding:10px 14px">';
    s += '<div style="font-size:18px;font-weight:500;color:rgba(255,160,60,0.9)">+' + avgRise + '</div>';
    s += '<div style="font-size:9px;color:rgba(200,220,240,0.4);margin-top:2px">avg rise (mmol)</div></div>';
    s += '</div>';
    s += '<div style="border-radius:8px;overflow:hidden;border:1px solid rgba(255,255,255,0.06)">';
    mealStats.forEach(function(m, i){
      var rise = m.peakRise || 0;
      var col  = rise < 2.5 ? 'rgba(62,180,120,0.8)' : rise < 4.5 ? 'rgba(255,180,60,0.8)' : 'rgba(255,100,80,0.8)';
      s += '<div style="display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center;' +
        'padding:10px 14px;' + (i % 2 === 0 ? 'background:rgba(255,255,255,0.02)' : '') + '">';
      s += '<div style="font-size:10px;color:rgba(200,220,240,0.7);white-space:nowrap;overflow:hidden;' +
        'text-overflow:ellipsis">' + (m.name||'').split('·')[0].trim() + '</div>';
      s += '<div style="font-size:12px;font-weight:500;color:' + col + ';min-width:40px;text-align:right">+' + rise + '</div>';
      s += '</div>';
    });
    s += '</div>';
  } else {
    s += '<div style="padding:20px;text-align:center;font-size:11px;color:rgba(200,220,240,0.3);' +
      'border-radius:8px;border:1px dashed rgba(255,255,255,0.08)">no meal data yet</div>';
  }
  s += '</div>';

  // Section 4: Sensor lag
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
    s += '<div style="border-radius:8px;overflow:hidden;border:1px solid rgba(255,255,255,0.06)">';
    lagPairs.slice(0,8).forEach(function(p, i){
      var col = Math.abs(p.delta) < 1.0 ? 'rgba(62,180,120,0.8)' : Math.abs(p.delta) < 2.0 ? 'rgba(255,180,60,0.8)' : 'rgba(255,100,80,0.8)';
      s += '<div style="display:grid;grid-template-columns:1fr auto auto auto;gap:10px;align-items:center;' +
        'padding:9px 14px;' + (i % 2 === 0 ? 'background:rgba(255,255,255,0.02)' : '') + '">';
      s += '<div style="font-size:10px;color:rgba(200,220,240,0.4)">' + new Date(p.t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}) + '</div>';
      s += '<div style="font-size:11px;color:rgba(255,200,100,0.8)">' + p.prick.toFixed(1) + '</div>';
      s += '<div style="font-size:11px;color:rgba(120,200,255,0.7)">' + p.cgm.toFixed(1) + '</div>';
      s += '<div style="font-size:11px;font-weight:500;color:' + col + '">' + (p.delta > 0 ? '+' : '') + p.delta + '</div>';
      s += '</div>';
    });
    s += '</div>';
  } else {
    s += '<div style="padding:20px;text-align:center;font-size:11px;color:rgba(200,220,240,0.3);' +
      'border-radius:8px;border:1px dashed rgba(255,255,255,0.08)">no finger prick readings yet</div>';
  }
  s += '</div>';

  // Section 5: Clinic export
  s += '<div style="margin-bottom:40px">';
  s += '<div style="font-size:10px;letter-spacing:1.5px;text-transform:uppercase;' +
    'color:rgba(200,220,240,0.4);margin-bottom:14px">clinic export</div>';
  s += '<button onclick="insightsExport()" style="width:100%;padding:14px;border-radius:10px;' +
    'border:1px solid rgba(255,180,80,0.3);background:rgba(255,180,80,0.07);' +
    'font-family:\'Fraunces\',serif;font-style:italic;font-weight:200;font-size:17px;' +
    'color:rgba(255,200,100,0.9);cursor:pointer">download clinic report</button>';
  s += '<div style="font-size:9px;color:rgba(200,220,240,0.3);margin-top:8px;text-align:center">' +
    'html · not a clinical document · for conversation with your team</div>';
  s += '</div>';

  s += '</div>'; // end max-width wrapper

  el.innerHTML = s;

  // Draw 24-hour canvas
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

    cx.fillStyle = 'rgba(62,180,120,0.06)';
    cx.fillRect(PAD.l, yOf(10.0), CW, yOf(3.9) - yOf(10.0));

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

    var meanPts = hourMeans.map(function(v, h){ return v !== null ? {x: xOf(h), y: yOf(v)} : null; }).filter(Boolean);
    if (meanPts.length > 1) {
      cx.beginPath();
      cx.moveTo(meanPts[0].x, meanPts[0].y);
      meanPts.forEach(function(p){ cx.lineTo(p.x, p.y); });
      cx.strokeStyle = 'rgba(62,200,180,0.8)';
      cx.lineWidth = 2;
      cx.stroke();
    }

    cx.fillStyle = 'rgba(180,200,220,0.4)';
    cx.font = '9px "DM Mono",monospace';
    cx.textAlign = 'center';
    [0, 6, 12, 18, 23].forEach(function(h){
      cx.fillText(h + ':00', xOf(h), H - 6);
    });
    cx.textAlign = 'right';
    [4, 7, 10, 13].forEach(function(v){
      cx.fillText(v, PAD.l - 4, yOf(v) + 3);
    });
  });
}


// ═══════════════════════════════════════════════════════════════════
//  PATTERN EXPLORER — unknown forces review screen
//  Entry: radial menu → "patterns"
//  Three tabs: Ghost Meals · Other Forces · Resolved
// ═══════════════════════════════════════════════════════════════════

var _patternExplorerOpen = false;

async function openPatternExplorer() {
  if (_patternExplorerOpen) return;
  _patternExplorerOpen = true;

  var ex = document.getElementById('pattern-explorer-overlay');
  if (ex) ex.remove();

  // Build shell immediately, load data async
  var el = document.createElement('div');
  el.id  = 'pattern-explorer-overlay';
  el.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:70',
    'background:rgba(3,8,20,0.97)',
    'backdrop-filter:blur(20px)',
    'display:flex', 'flex-direction:column',
    'overflow:hidden',
    'pointer-events:auto',
    'touch-action:pan-y',
    'font-family:\'DM Mono\',monospace',
  ].join(';');
  el.addEventListener('touchstart', function(e){ e.stopPropagation(); }, {passive:true});

  // ── Header ──
  var header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:52px 20px 12px;flex-shrink:0;border-bottom:1px solid rgba(160,120,240,0.15)';
  header.innerHTML =
    '<div style="display:flex;flex-direction:column;gap:2px">' +
      '<span style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:rgba(160,120,240,0.9)">◑ Patterns</span>' +
      '<span style="font-size:9px;letter-spacing:1px;text-transform:uppercase;color:rgba(180,200,220,0.35)">Unknown forces review</span>' +
    '</div>' +
    '<button id="pe-close" style="width:36px;height:36px;border-radius:50%;border:1px solid rgba(180,200,220,0.15);background:rgba(10,15,35,0.6);color:rgba(180,200,220,0.6);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center">✕</button>';
  el.appendChild(header);

  // ── Tabs ──
  var tabBar = document.createElement('div');
  tabBar.style.cssText = 'display:flex;gap:0;flex-shrink:0;border-bottom:1px solid rgba(160,120,240,0.12)';
  var TAB_DEFS = [
    { id:'ghosts',  label:'Ghost Meals' },
    { id:'forces',  label:'Other Forces' },
    { id:'resolved',label:'Resolved' },
  ];
  var _activeTab = 'ghosts';
  TAB_DEFS.forEach(function(td) {
    var tb = document.createElement('button');
    tb.id  = 'pe-tab-' + td.id;
    tb.setAttribute('data-tab', td.id);
    tb.style.cssText = [
      'flex:1', 'padding:10px 4px', 'border:none',
      'background:transparent', 'cursor:pointer',
      'font-family:\'DM Mono\',monospace',
      'font-size:9px', 'letter-spacing:0.8px',
      'text-transform:uppercase',
      'color:' + (td.id === 'ghosts' ? 'rgba(160,120,240,0.9)' : 'rgba(180,200,220,0.35)'),
      'border-bottom:2px solid ' + (td.id === 'ghosts' ? 'rgba(160,120,240,0.7)' : 'transparent'),
      'transition:color .2s,border-color .2s',
    ].join(';');
    tb.textContent = td.label;
    tb.addEventListener('click', function() {
      _activeTab = td.id;
      TAB_DEFS.forEach(function(t2) {
        var btn2 = document.getElementById('pe-tab-' + t2.id);
        var active2 = t2.id === td.id;
        if (btn2) {
          btn2.style.color = active2 ? 'rgba(160,120,240,0.9)' : 'rgba(180,200,220,0.35)';
          btn2.style.borderBottom = active2 ? '2px solid rgba(160,120,240,0.7)' : '2px solid transparent';
        }
        var pane = document.getElementById('pe-pane-' + t2.id);
        if (pane) pane.style.display = t2.id === td.id ? 'block' : 'none';
      });
    });
    tabBar.appendChild(tb);
  });
  el.appendChild(tabBar);

  // ── Content area ──
  var content = document.createElement('div');
  content.style.cssText = 'flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain';

  // Panes
  TAB_DEFS.forEach(function(td) {
    var pane = document.createElement('div');
    pane.id  = 'pe-pane-' + td.id;
    pane.style.cssText = 'padding:16px 16px 40px;' + (td.id === 'ghosts' ? '' : 'display:none');
    if (td.id === 'ghosts') {
      pane.innerHTML = '<div style="text-align:center;padding:32px 0;color:rgba(180,200,220,0.3);font-size:10px;letter-spacing:1px">Loading ghost meals…</div>';
    } else if (td.id === 'forces') {
      pane.innerHTML = '<div style="text-align:center;padding:32px 0;color:rgba(180,200,220,0.3);font-size:10px;letter-spacing:1px">Loading unexplained drops…</div>';
    } else {
      pane.innerHTML = '<div style="text-align:center;padding:32px 0;color:rgba(180,200,220,0.3);font-size:10px;letter-spacing:1px">Loading resolved items…</div>';
    }
    content.appendChild(pane);
  });

  el.appendChild(content);
  document.body.appendChild(el);

  // ── Toast helper ──
  function _peToast(msg) {
    var t = document.createElement('div');
    t.style.cssText = 'position:fixed;bottom:40px;left:50%;transform:translateX(-50%);background:rgba(160,120,240,0.9);color:#fff;padding:10px 20px;border-radius:20px;font-family:\'DM Mono\',monospace;font-size:10px;letter-spacing:1px;z-index:99;pointer-events:none;white-space:nowrap';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function(){ t.style.transition='opacity .4s'; t.style.opacity='0'; setTimeout(function(){if(t.parentNode)t.remove();},400); }, 2200);
  }

  // ── Rerun evaluation on all unconfirmed ghosts ──
  async function _rerunAllGhosts() {
    _peToast('↻ Re-running pattern matching…');
    try {
      var rows = await _sbFetch('unannounced_meals?confirmed=eq.false&order=t.desc&limit=50', { method: 'GET' });
      if (!Array.isArray(rows) || rows.length === 0) { _peToast('No unconfirmed ghosts to rerun'); return; }
      for (var row of rows) {
        if (!row.residual_curve || !Array.isArray(row.residual_curve)) continue;
        var resampled = row.residual_curve; // already in run format {t, residual}
        var candidates = await _matchGhostToMealHistory(
          resampled, row.peak_mins || 60, row.estimated_carbs || 0, row.t, row.iob_at_t || 0
        );
        if (candidates.length > 0) {
          await _sbFetch('unannounced_meals?t=eq.' + row.t, {
            method: 'PATCH',
            prefer: 'return=minimal',
            body: { candidate_meals: candidates },
          });
        }
      }
      _peToast('✓ Matching complete');
      _loadAllPanes();
    } catch(e) {
      console.warn('[rerun ghosts]', e);
      _peToast('Rerun failed — see console');
    }
  }

  // ── Confirm a ghost meal — save to meal_history with used_suggested ──
  async function _confirmGhostMeal(ghost, candidate, editedItems) {
    try {
      var items  = editedItems || candidate.items || null;
      var carbs  = items ? items.reduce(function(s,i){return s+(i.carbs||0);},0) : candidate.total_carbs;
      var mealRow = {
        t:           ghost.t,
        name:        candidate.name,
        total_carbs: +carbs.toFixed(1),
        items:       items,
        bolus_u:     null,
        pre_bg:      ghost.pre_bg,
        therapy_snapshot: ghost.therapy_snapshot,
        source:      'used_suggested',
        device_id:   _deviceId,
        logged_by:   _thisPersonId || null,
      };
      await _sbFetch('meal_history?on_conflict=t', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=minimal',
        body: [mealRow],
      });
      // Mark ghost confirmed
      await _sbFetch('unannounced_meals?t=eq.' + ghost.t, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: { confirmed: true, dismissed: false },
      });
      _peToast('Saved · re-running matching…');
      // Async rerun of remaining unconfirmed ghosts
      setTimeout(function(){ _rerunAllGhosts(); }, 500);
    } catch(e) {
      console.warn('[confirmGhost]', e);
      _peToast('Save failed — see console');
    }
  }

  // ── Dismiss a ghost — mark confirmed+dismissed, don't write meal_history ──
  async function _dismissGhost(t) {
    try {
      await _sbFetch('unannounced_meals?t=eq.' + t, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: { confirmed: true, dismissed: true },
      });
    } catch(e) { console.warn('[dismissGhost]', e); }
  }

  // ── Draw mini sparkline SVG for a residual curve ──
  function _sparklineSVG(curve, w, h) {
    if (!curve || curve.length < 2) return '';
    var vals = curve.map(function(p){ return p.residual || 0; });
    var mn = Math.min.apply(null, vals);
    var mx = Math.max.apply(null, vals);
    var range = mx - mn || 1;
    var pts = vals.map(function(v, i) {
      var x = (i / (vals.length - 1)) * w;
      var y = h - ((v - mn) / range) * h;
      return x.toFixed(1) + ',' + y.toFixed(1);
    });
    return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
      '<polyline points="' + pts.join(' ') + '" fill="none" stroke="rgba(80,220,200,0.7)" stroke-width="1.5" stroke-linejoin="round"/>' +
      '</svg>';
  }

  // ── Confidence bar HTML ──
  function _confBar(val, amber) {
    var pct = Math.round((val || 0) * 100);
    var col = amber ? 'rgba(255,200,80,0.7)' : 'rgba(160,120,240,0.7)';
    return '<div style="display:flex;align-items:center;gap:6px">' +
      '<div style="flex:1;height:4px;background:rgba(255,255,255,0.08);border-radius:2px">' +
        '<div style="width:' + pct + '%;height:4px;background:' + col + ';border-radius:2px"></div>' +
      '</div>' +
      '<span style="font-size:9px;color:rgba(200,220,240,0.5);min-width:26px;text-align:right">' + pct + '%</span>' +
    '</div>';
  }

  // ── Detail view for a ghost meal (Review tap) ──
  function _openGhostDetail(ghost, candidate, allCandidates, onSaved) {
    var det = document.createElement('div');
    det.id  = 'pe-detail-overlay';
    det.style.cssText = 'position:fixed;inset:0;z-index:80;background:rgba(3,8,20,0.98);backdrop-filter:blur(20px);overflow-y:auto;-webkit-overflow-scrolling:touch;font-family:\'DM Mono\',monospace;padding:0;pointer-events:auto;touch-action:pan-y';
    det.addEventListener('touchstart',function(e){e.stopPropagation();},{passive:true});

    var ghostTime = new Date(ghost.t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
    var ghostDate = new Date(ghost.t).toLocaleDateString('en-GB',{day:'2-digit',month:'short'});
    var period    = _mealPeriod(ghost.t);
    var items     = (candidate && candidate.items) ? JSON.parse(JSON.stringify(candidate.items)) : [];
    var dq        = candidate ? candidate.data_quality : 'preliminary';
    var dqLabel   = dq === 'solid' ? '● Solid match' : dq === 'moderate' ? '◑ Moderate match' : '○ Preliminary — few observations';
    var dqCol     = dq === 'solid' ? 'rgba(80,220,160,0.8)' : dq === 'moderate' ? 'rgba(255,200,80,0.8)' : 'rgba(180,200,220,0.4)';

    // Build items editor HTML
    function _itemsEditorHTML() {
      if (!items || items.length === 0) return '<div style="color:rgba(180,200,220,0.3);font-size:9px;padding:8px 0">No item breakdown available</div>';
      return items.map(function(it, idx) {
        return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05)">' +
          '<span style="flex:1;font-size:10px;color:rgba(180,200,220,0.7)">' + (it.name||'Item') + '</span>' +
          '<input type="number" step="1" value="' + Math.round(it.grams||0) + '" data-idx="' + idx + '" data-field="grams"' +
            ' style="width:50px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:4px;color:rgba(200,220,240,0.8);font-family:\'DM Mono\',monospace;font-size:10px;padding:4px 6px;text-align:right"> g' +
          '<span style="font-size:10px;color:rgba(180,200,220,0.4)">' + (it.carbs !== undefined ? (it.carbs||0).toFixed(1) + 'g carbs' : '') + '</span>' +
        '</div>';
      }).join('');
    }

    var ambiguousWarning = (candidate && candidate.ambiguous) ?
      '<div style="background:rgba(255,200,80,0.08);border:1px solid rgba(255,200,80,0.25);border-radius:8px;padding:10px 12px;margin-bottom:12px">' +
        '<span style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;color:rgba(255,200,80,0.8)">⚠ Ambiguous — multiple similar matches. Review all dimensions before confirming.</span>' +
      '</div>' : '';

    det.innerHTML =
      '<div style="padding:52px 20px 60px">' +
        // Header
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">' +
          '<div>' +
            '<div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:rgba(160,120,240,0.9)">Ghost meal — ' + period + '</div>' +
            '<div style="font-size:9px;color:rgba(180,200,220,0.4);margin-top:2px">' + ghostDate + ' · ' + ghostTime + '</div>' +
          '</div>' +
          '<button id="pe-det-close" style="width:36px;height:36px;border-radius:50%;border:1px solid rgba(180,200,220,0.15);background:rgba(10,15,35,0.6);color:rgba(180,200,220,0.6);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center">✕</button>' +
        '</div>' +

        // Candidate name + data quality
        (candidate ?
          '<div style="background:rgba(160,120,240,0.08);border:1px solid rgba(160,120,240,0.2);border-radius:10px;padding:12px 14px;margin-bottom:12px">' +
            '<div style="font-size:13px;color:rgba(200,220,240,0.9);margin-bottom:4px">' + candidate.name + '</div>' +
            '<div style="font-size:9px;letter-spacing:0.8px;color:' + dqCol + '">' + dqLabel + ' · ' + (candidate.observations||1) + ' observation' + ((candidate.observations||1)!==1?'s':'') + '</div>' +
          '</div>'
        : '<div style="color:rgba(180,200,220,0.4);font-size:10px;padding:12px 0">No candidate match found</div>') +

        ambiguousWarning +

        // Sparkline
        '<div style="margin-bottom:14px">' +
          '<div style="font-size:8px;letter-spacing:1px;text-transform:uppercase;color:rgba(180,200,220,0.3);margin-bottom:6px">Residual curve</div>' +
          '<div style="background:rgba(255,255,255,0.03);border-radius:8px;padding:10px;overflow:hidden">' +
            _sparklineSVG(ghost.residual_curve || [], 280, 50) +
          '</div>' +
        '</div>' +

        // Match breakdown
        (candidate ?
          '<div style="margin-bottom:16px">' +
            '<div style="font-size:8px;letter-spacing:1px;text-transform:uppercase;color:rgba(180,200,220,0.3);margin-bottom:8px">Match breakdown</div>' +
            '<div style="display:flex;flex-direction:column;gap:6px">' +
              '<div><div style="font-size:9px;color:rgba(180,200,220,0.5);margin-bottom:3px">Curve shape</div>' + _confBar(candidate.shape_match, false) + '</div>' +
              '<div><div style="font-size:9px;color:rgba(180,200,220,0.5);margin-bottom:3px">Peak timing</div>' + _confBar(candidate.peak_timing_match, false) + '</div>' +
              '<div><div style="font-size:9px;color:rgba(255,200,80,0.7);margin-bottom:3px">Carb estimate' + (candidate.gram_warning ? ' ⚠' : '') + '</div>' + _confBar(candidate.carb_match, candidate.gram_warning) + '</div>' +
              '<div><div style="font-size:9px;color:rgba(180,200,220,0.5);margin-bottom:3px">Time of day</div>' + _confBar(candidate.time_match, false) + '</div>' +
              '<div><div style="font-size:9px;color:rgba(255,200,80,0.7);margin-bottom:3px">IOB context ⚠</div>' + _confBar(candidate.iob_match, true) + '</div>' +
            '</div>' +
          '</div>'
        : '') +

        // Items editor
        '<div style="margin-bottom:16px">' +
          '<div style="font-size:8px;letter-spacing:1px;text-transform:uppercase;color:rgba(180,200,220,0.3);margin-bottom:6px">Meal items</div>' +
          '<div style="background:rgba(255,255,255,0.03);border-radius:8px;padding:10px 12px" id="pe-det-items">' +
            _itemsEditorHTML() +
          '</div>' +
          '<div style="font-size:8px;color:rgba(180,200,220,0.25);margin-top:6px;line-height:1.5">Gram estimates derived from carb back-calculation. Adjust if known.</div>' +
        '</div>' +

        // Source pill
        '<div style="display:inline-block;padding:4px 10px;background:rgba(160,120,240,0.12);border:1px solid rgba(160,120,240,0.25);border-radius:20px;font-size:8px;letter-spacing:0.8px;color:rgba(160,120,240,0.7);margin-bottom:20px">used-suggestion</div>' +

        // Actions
        '<div style="display:flex;gap:10px">' +
          '<button id="pe-det-confirm" style="flex:1;padding:13px;border-radius:10px;border:1px solid rgba(80,220,160,0.3);background:rgba(80,220,160,0.1);color:rgba(80,220,160,0.9);font-family:\'DM Mono\',monospace;font-size:10px;letter-spacing:1px;cursor:pointer">Confirm + save</button>' +
          '<button id="pe-det-cancel" style="padding:13px 18px;border-radius:10px;border:1px solid rgba(180,200,220,0.15);background:transparent;color:rgba(180,200,220,0.5);font-family:\'DM Mono\',monospace;font-size:10px;letter-spacing:1px;cursor:pointer">Cancel</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(det);

    // Wire gram input changes into items array
    det.querySelectorAll('input[type=number]').forEach(function(inp) {
      inp.addEventListener('change', function() {
        var idx = +inp.getAttribute('data-idx');
        var g   = parseFloat(inp.value) || 0;
        if (items[idx]) {
          items[idx].grams = g;
          if (items[idx].c100 !== undefined) items[idx].carbs = +(g * items[idx].c100 / 100).toFixed(1);
        }
      });
    });

    det.querySelector('#pe-det-close').addEventListener('click', function(){ if(det.parentNode) det.remove(); });
    det.querySelector('#pe-det-cancel').addEventListener('click', function(){ if(det.parentNode) det.remove(); });
    det.querySelector('#pe-det-confirm').addEventListener('click', async function() {
      if (!candidate) { if(det.parentNode) det.remove(); return; }
      det.querySelector('#pe-det-confirm').disabled = true;
      det.querySelector('#pe-det-confirm').textContent = 'Saving…';
      await _confirmGhostMeal(ghost, candidate, items.length ? items : null);
      if(det.parentNode) det.remove();
      if(onSaved) onSaved();
    });
  }

  // ── Render ghost meals pane ──
  async function _loadGhostPane(rows) {
    var pane = document.getElementById('pe-pane-ghosts');
    if (!pane) return;

    if (!rows || rows.length === 0) {
      pane.innerHTML = '<div style="text-align:center;padding:48px 20px">' +
        '<div style="font-size:28px;margin-bottom:12px;opacity:0.3">◑</div>' +
        '<div style="font-size:10px;letter-spacing:1px;text-transform:uppercase;color:rgba(180,200,220,0.3)">No ghost meals detected</div>' +
        '<div style="font-size:9px;color:rgba(180,200,220,0.2);margin-top:6px">Unannounced rises will appear here</div>' +
      '</div>';
      return;
    }

    pane.innerHTML = '';
    rows.forEach(function(ghost) {
      var cands  = ghost.candidate_meals || [];
      var top    = cands[0] || null;
      var period = _mealPeriod(ghost.t);
      var timeStr = new Date(ghost.t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
      var dateStr = new Date(ghost.t).toLocaleDateString('en-GB',{day:'2-digit',month:'short'});
      var dq      = top ? top.data_quality : null;
      var ambiguous = cands.length >= 2 && cands[0] && cands[1] &&
        Math.abs((cands[0].confidence||0) - (cands[1].confidence||0)) < 0.10;
      var showAcceptTop = top && dq !== 'preliminary' && !ambiguous;

      var card = document.createElement('div');
      card.style.cssText = 'background:rgba(255,255,255,0.03);border:1px solid rgba(160,120,240,0.12);border-radius:12px;padding:14px;margin-bottom:12px;position:relative';

      // Card header
      var cardHTML =
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">' +
          '<div>' +
            '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:rgba(200,220,240,0.8)">Unannounced — ' + period + '</div>' +
            '<div style="font-size:9px;color:rgba(180,200,220,0.35);margin-top:2px">' + dateStr + ' · ' + timeStr + '</div>' +
          '</div>' +
          '<div style="text-align:right">' +
            '<div style="font-size:12px;color:rgba(80,220,200,0.8)">+' + (ghost.total_rise||0).toFixed(1) + '</div>' +
            '<div style="font-size:8px;color:rgba(180,200,220,0.3)">mmol rise</div>' +
          '</div>' +
        '</div>' +

        // Stats row
        '<div style="display:flex;gap:16px;margin-bottom:10px">' +
          '<div><div style="font-size:8px;color:rgba(180,200,220,0.3);text-transform:uppercase;letter-spacing:0.5px">Est. carbs</div><div style="font-size:11px;color:rgba(200,220,240,0.7)">' + (ghost.estimated_carbs||0) + 'g</div></div>' +
          '<div><div style="font-size:8px;color:rgba(180,200,220,0.3);text-transform:uppercase;letter-spacing:0.5px">Peak at</div><div style="font-size:11px;color:rgba(200,220,240,0.7)">+' + (ghost.peak_mins||0) + 'min</div></div>' +
          '<div><div style="font-size:8px;color:rgba(180,200,220,0.3);text-transform:uppercase;letter-spacing:0.5px">IOB</div><div style="font-size:11px;color:rgba(200,220,240,0.7)">' + (ghost.iob_at_t||0).toFixed(1) + 'U</div></div>' +
        '</div>' +

        // Sparkline
        '<div style="margin-bottom:10px">' + _sparklineSVG(ghost.residual_curve || [], 260, 36) + '</div>';

      // Candidate list
      if (cands.length > 0) {
        cardHTML += '<div style="margin-bottom:10px">';
        cands.forEach(function(c, ci) {
          var pct = Math.round((c.confidence||0)*100);
          var isTop = ci === 0;
          cardHTML +=
            '<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.04)">' +
              '<span style="font-size:9px;color:' + (isTop ? 'rgba(200,220,240,0.8)' : 'rgba(180,200,220,0.4)') + ';flex:1">' + c.name + '</span>' +
              '<span style="font-size:8px;color:rgba(180,200,220,0.3)">' + (c.observations||1) + '×</span>' +
              '<div style="width:50px;height:4px;background:rgba(255,255,255,0.08);border-radius:2px">' +
                '<div style="width:' + pct + '%;height:4px;background:' + (isTop ? 'rgba(160,120,240,0.7)' : 'rgba(100,80,160,0.4)') + ';border-radius:2px"></div>' +
              '</div>' +
              '<span style="font-size:9px;color:rgba(180,200,220,0.4);min-width:28px;text-align:right">' + pct + '%</span>' +
            '</div>';
        });
        cardHTML += '</div>';
      } else {
        cardHTML += '<div style="font-size:9px;color:rgba(180,200,220,0.25);padding:4px 0 8px">No match found yet — rerun matching after logging more meals</div>';
      }

      // Ambiguous warning
      if (ambiguous) {
        cardHTML += '<div style="background:rgba(255,200,80,0.07);border:1px solid rgba(255,200,80,0.2);border-radius:6px;padding:8px 10px;margin-bottom:10px;font-size:8px;letter-spacing:0.5px;color:rgba(255,200,80,0.7)">⚠ Multiple similar matches — review required before accepting</div>';
      }

      // Preliminary warning
      if (dq === 'preliminary') {
        cardHTML += '<div style="font-size:8px;color:rgba(255,200,80,0.6);margin-bottom:8px">○ Preliminary data — fewer than 4 observations. Accept top disabled.</div>';
      }

      // Action row
      cardHTML +=
        '<div style="display:flex;gap:8px;margin-top:2px">' +
          (showAcceptTop ?
            '<button class="pe-accept-top" style="flex:1;padding:10px 6px;border-radius:8px;border:1px solid rgba(80,220,160,0.3);background:rgba(80,220,160,0.08);color:rgba(80,220,160,0.9);font-family:\'DM Mono\',monospace;font-size:9px;letter-spacing:0.8px;cursor:pointer">Accept top</button>'
          : '') +
          '<button class="pe-review" style="flex:1;padding:10px 6px;border-radius:8px;border:1px solid rgba(160,120,240,0.25);background:transparent;color:rgba(160,120,240,0.8);font-family:\'DM Mono\',monospace;font-size:9px;letter-spacing:0.8px;cursor:pointer">Review</button>' +
          '<button class="pe-dismiss" style="padding:10px 12px;border-radius:8px;border:1px solid rgba(180,200,220,0.1);background:transparent;color:rgba(180,200,220,0.3);font-family:\'DM Mono\',monospace;font-size:9px;letter-spacing:0.8px;cursor:pointer">Dismiss</button>' +
        '</div>';

      card.innerHTML = cardHTML;

      // Wire buttons
      var acceptBtn = card.querySelector('.pe-accept-top');
      if (acceptBtn) {
        acceptBtn.addEventListener('click', async function() {
          acceptBtn.disabled = true; acceptBtn.textContent = 'Saving…';
          await _confirmGhostMeal(ghost, top, null);
          card.style.opacity = '0.3';
          card.style.pointerEvents = 'none';
          _peToast('Accepted: ' + top.name);
          setTimeout(function(){ _loadAllPanes(); }, 600);
        });
      }
      var reviewBtn = card.querySelector('.pe-review');
      reviewBtn.addEventListener('click', function() {
        _openGhostDetail(ghost, top, cands, function(){ _loadAllPanes(); });
      });
      var dismissBtn = card.querySelector('.pe-dismiss');
      dismissBtn.addEventListener('click', async function() {
        await _dismissGhost(ghost.t);
        card.style.transition = 'opacity .3s';
        card.style.opacity    = '0';
        setTimeout(function(){ if(card.parentNode) card.remove(); }, 300);
      });

      pane.appendChild(card);
    });
  }

  // ── Other Forces pane ──
  async function _loadForcesPane(rows) {
    var pane = document.getElementById('pe-pane-forces');
    if (!pane) return;

    if (!rows || rows.length === 0) {
      pane.innerHTML = '<div style="text-align:center;padding:48px 20px">' +
        '<div style="font-size:28px;margin-bottom:12px;opacity:0.3">↓</div>' +
        '<div style="font-size:10px;letter-spacing:1px;text-transform:uppercase;color:rgba(180,200,220,0.3)">No unexplained drops</div>' +
        '<div style="font-size:9px;color:rgba(180,200,220,0.2);margin-top:6px">Unexplained BG drops will appear here</div>' +
      '</div>';
      return;
    }

    var FORCE_TAGS = [
      { id:'swimming',   label:'Swimming'          },
      { id:'exercise',   label:'Exercise'           },
      { id:'stress',     label:'Stress · adrenaline'},
      { id:'illness',    label:'Illness · fever'    },
      { id:'growth',     label:'Growth phase'       },
      { id:'newsite',    label:'New insulin site'   },
    ];

    pane.innerHTML = '';
    rows.forEach(function(drop) {
      var timeStr = new Date(drop.t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
      var dateStr = new Date(drop.t).toLocaleDateString('en-GB',{day:'2-digit',month:'short'});
      var selectedTags = {};

      var card = document.createElement('div');
      card.style.cssText = 'background:rgba(255,255,255,0.03);border:1px solid rgba(80,160,220,0.15);border-radius:12px;padding:14px;margin-bottom:12px';

      var cardHTML =
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">' +
          '<div>' +
            '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:rgba(200,220,240,0.8)">Unexplained drop</div>' +
            '<div style="font-size:9px;color:rgba(180,200,220,0.35);margin-top:2px">' + dateStr + ' · ' + timeStr + '</div>' +
          '</div>' +
          '<div style="text-align:right">' +
            '<div style="font-size:12px;color:rgba(80,160,220,0.8)">' + (drop.total_rise||0).toFixed(1) + '</div>' +
            '<div style="font-size:8px;color:rgba(180,200,220,0.3)">mmol drop</div>' +
          '</div>' +
        '</div>' +

        '<div style="display:flex;gap:16px;margin-bottom:12px">' +
          '<div><div style="font-size:8px;color:rgba(180,200,220,0.3);text-transform:uppercase">Duration</div><div style="font-size:11px;color:rgba(200,220,240,0.7)">+' + (drop.peak_mins||60) + 'min</div></div>' +
          '<div><div style="font-size:8px;color:rgba(180,200,220,0.3);text-transform:uppercase">IOB</div><div style="font-size:11px;color:rgba(200,220,240,0.7)">' + (drop.iob_at_t||0).toFixed(1) + 'U</div></div>' +
        '</div>' +

        '<div style="font-size:8px;letter-spacing:0.8px;text-transform:uppercase;color:rgba(180,200,220,0.3);margin-bottom:8px">What caused this drop?</div>' +
        '<div id="pe-tags-' + drop.t + '" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">' +
          FORCE_TAGS.map(function(ft) {
            return '<button class="pe-force-tag" data-tag="' + ft.id + '" style="padding:5px 10px;border-radius:14px;border:1px solid rgba(80,160,220,0.2);background:transparent;color:rgba(180,200,220,0.5);font-family:\'DM Mono\',monospace;font-size:8px;letter-spacing:0.5px;cursor:pointer">' + ft.label + '</button>';
          }).join('') +
        '</div>' +
        '<div style="display:flex;gap:8px">' +
          '<button class="pe-save-force" style="flex:1;padding:10px;border-radius:8px;border:1px solid rgba(80,160,220,0.3);background:rgba(80,160,220,0.08);color:rgba(80,160,220,0.9);font-family:\'DM Mono\',monospace;font-size:9px;letter-spacing:0.8px;cursor:pointer">Save tag</button>' +
          '<button class="pe-dismiss-force" style="padding:10px 14px;border-radius:8px;border:1px solid rgba(180,200,220,0.1);background:transparent;color:rgba(180,200,220,0.3);font-family:\'DM Mono\',monospace;font-size:9px;letter-spacing:0.8px;cursor:pointer">Dismiss</button>' +
        '</div>';

      card.innerHTML = cardHTML;

      // Tag toggle
      card.querySelectorAll('.pe-force-tag').forEach(function(tb) {
        tb.addEventListener('click', function() {
          var tag = tb.getAttribute('data-tag');
          selectedTags[tag] = !selectedTags[tag];
          tb.style.background = selectedTags[tag] ? 'rgba(80,160,220,0.2)' : 'transparent';
          tb.style.color       = selectedTags[tag] ? 'rgba(80,160,220,0.9)' : 'rgba(180,200,220,0.5)';
          tb.style.borderColor = selectedTags[tag] ? 'rgba(80,160,220,0.5)' : 'rgba(80,160,220,0.2)';
        });
      });

      // Save force tag
      card.querySelector('.pe-save-force').addEventListener('click', async function() {
        var tags = Object.keys(selectedTags).filter(function(k){return selectedTags[k];});
        if (tags.length === 0) { _peToast('Select at least one tag'); return; }
        try {
          await _sbFetch('unannounced_meals?t=eq.' + drop.t, {
            method: 'PATCH',
            prefer: 'return=minimal',
            body: { confirmed: true, force_tags: tags, dismissed: false },
          });
          card.style.transition='opacity .3s'; card.style.opacity='0';
          setTimeout(function(){if(card.parentNode)card.remove();},300);
          _peToast('Tagged: ' + tags.join(', '));
        } catch(e) { _peToast('Save failed'); }
      });

      card.querySelector('.pe-dismiss-force').addEventListener('click', async function() {
        await _dismissGhost(drop.t);
        card.style.transition='opacity .3s'; card.style.opacity='0';
        setTimeout(function(){if(card.parentNode)card.remove();},300);
      });

      pane.appendChild(card);
    });
  }

  // ── Resolved pane ──
  async function _loadResolvedPane(rows) {
    var pane = document.getElementById('pe-pane-resolved');
    if (!pane) return;
    pane.innerHTML = '';

    // Rerun button
    var rerunBtn = document.createElement('button');
    rerunBtn.style.cssText = 'width:100%;padding:11px;border-radius:10px;border:1px solid rgba(160,120,240,0.25);background:rgba(160,120,240,0.07);color:rgba(160,120,240,0.8);font-family:\'DM Mono\',monospace;font-size:9px;letter-spacing:1px;cursor:pointer;margin-bottom:16px;text-transform:uppercase';
    rerunBtn.textContent = '↻ Re-run pattern matching with updated history';
    rerunBtn.addEventListener('click', function() {
      rerunBtn.disabled = true; rerunBtn.textContent = 'Running…';
      _rerunAllGhosts().then(function(){ rerunBtn.disabled=false; rerunBtn.textContent='↻ Re-run pattern matching with updated history'; });
    });
    pane.appendChild(rerunBtn);

    if (!rows || rows.length === 0) {
      var empty = document.createElement('div');
      empty.style.cssText = 'text-align:center;padding:32px 20px';
      empty.innerHTML = '<div style="font-size:10px;letter-spacing:1px;text-transform:uppercase;color:rgba(180,200,220,0.3)">No resolved items yet</div>';
      pane.appendChild(empty);
      return;
    }

    rows.forEach(function(item) {
      var timeStr = new Date(item.t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
      var dateStr = new Date(item.t).toLocaleDateString('en-GB',{day:'2-digit',month:'short'});
      var top     = (item.candidate_meals||[])[0];
      var tags    = item.force_tags || [];
      var label   = item.dismissed ? 'Dismissed' : top ? top.name : (tags.length ? tags.join(', ') : 'Resolved');
      var source  = item.dismissed ? 'dismissed' : (item.source || (tags.length ? 'manually tagged' : 'accepted suggestion'));

      var card = document.createElement('div');
      card.style.cssText = 'background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:12px 14px;margin-bottom:10px;opacity:0.7';
      card.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center">' +
          '<div>' +
            '<div style="font-size:10px;color:rgba(200,220,240,0.7)">' + label + '</div>' +
            '<div style="font-size:8px;color:rgba(180,200,220,0.3);margin-top:2px">' + dateStr + ' · ' + timeStr + '</div>' +
          '</div>' +
          '<div style="text-align:right">' +
            '<div style="font-size:8px;padding:3px 8px;background:rgba(255,255,255,0.05);border-radius:10px;color:rgba(180,200,220,0.4)">' + source + '</div>' +
            (top && top.confidence ? '<div style="font-size:8px;color:rgba(160,120,240,0.5);margin-top:3px">' + Math.round(top.confidence*100) + '% match</div>' : '') +
          '</div>' +
        '</div>';
      pane.appendChild(card);
    });
  }

  // ── Load all panes from Supabase ──
  async function _loadAllPanes() {
    try {
      // Ghost meals: positive rises, unconfirmed
      var ghostRows = await _sbFetch(
        'unannounced_meals?confirmed=eq.false&total_rise=gte.0&order=t.desc&limit=30',
        { method: 'GET' }
      );
      // Other forces: negative rises (drops), unconfirmed
      var forceRows = await _sbFetch(
        'unannounced_meals?confirmed=eq.false&total_rise=lt.0&order=t.desc&limit=30',
        { method: 'GET' }
      );
      // Resolved: confirmed items
      var resolvedRows = await _sbFetch(
        'unannounced_meals?confirmed=eq.true&order=t.desc&limit=50',
        { method: 'GET' }
      );
      ghostRows   = Array.isArray(ghostRows)   ? ghostRows   : [];
      forceRows   = Array.isArray(forceRows)   ? forceRows   : [];
      resolvedRows= Array.isArray(resolvedRows) ? resolvedRows : [];

      _loadGhostPane(ghostRows);
      _loadForcesPane(forceRows);
      _loadResolvedPane(resolvedRows);

      // Update tab labels with counts
      var ghostTab = document.getElementById('pe-tab-ghosts');
      if (ghostTab && ghostRows.length > 0) ghostTab.textContent = 'Ghost Meals (' + ghostRows.length + ')';
      var forcesTab = document.getElementById('pe-tab-forces');
      if (forcesTab && forceRows.length > 0) forcesTab.textContent = 'Other Forces (' + forceRows.length + ')';

    } catch(e) {
      console.warn('[patternExplorer load]', e);
      ['ghosts','forces','resolved'].forEach(function(id){
        var p = document.getElementById('pe-pane-' + id);
        if(p) p.innerHTML = '<div style="text-align:center;padding:32px;color:rgba(220,80,80,0.7);font-size:9px">Failed to load — check connection</div>';
      });
    }
  }

  // Wire close
  document.getElementById('pe-close').addEventListener('click', function() {
    _patternExplorerOpen = false;
    if(el.parentNode) el.remove();
  });

  // Load data
  _loadAllPanes();
}

async function insightsExport() {
  showToast('fetching from supabase…');

  // ── Report window: last 7 days ────────────────────────────────────────────
  var now = Date.now();
  var reportEnd   = now;
  var reportStart = now - 7 * 24 * 3600000;
  var windowStart = reportStart - 8 * 3600000; // overnight buffer

  // ── Fetch all data from Supabase ──────────────────────────────────────────
  var sbReadings = [], sbEvents = [], sbMeals = [], sbGhosts = [], sbPricks = [];

  try {
    var r1 = await _sbFetch(
      'readings?t=gte.' + windowStart + '&t=lte.' + reportEnd + '&order=t.asc&limit=50000',
      { method: 'GET' }
    );
    if (Array.isArray(r1)) sbReadings = r1;
  } catch(e) { console.warn('[export] CGM fetch:', e.message); }

  try {
    var r2 = await _sbFetch(
      'events?t=gte.' + windowStart + '&t=lte.' + reportEnd + '&select=t,c,u,gi,note,items&order=t.asc&limit=5000',
      { method: 'GET' }
    );
    if (Array.isArray(r2)) sbEvents = r2;
  } catch(e) { console.warn('[export] events fetch:', e.message); }

  try {
    var r3 = await _sbFetch(
      'meal_history?t=gte.' + windowStart + '&t=lte.' + reportEnd +
      '&select=t,name,total_carbs,items,bolus_u,pre_bg,peak_bg,therapy_snapshot,wait_mins,source&order=t.asc&limit=500',
      { method: 'GET' }
    );
    if (Array.isArray(r3)) sbMeals = r3;
  } catch(e) { console.warn('[export] meals fetch:', e.message); }

  try {
    var r4 = await _sbFetch(
      'ghost_events?t=gte.' + windowStart + '&t=lte.' + reportEnd +
      '&select=t,ghost_type,bg_at_detect,implied_units,implied_carbs,confidence,carer_context,confirmed,confirmed_note&order=t.asc&limit=200',
      { method: 'GET' }
    );
    if (Array.isArray(r4)) sbGhosts = r4;
  } catch(e) { console.warn('[export] ghosts fetch:', e.message); }

  try {
    var r5 = await _sbFetch(
      'events?t=gte.' + windowStart + '&t=lte.' + reportEnd + '&note=eq.prick&select=t,gi&order=t.asc&limit=500',
      { method: 'GET' }
    );
    if (Array.isArray(r5)) sbPricks = r5.filter(function(e){ return e.gi > 0; });
  } catch(e) { console.warn('[export] pricks fetch:', e.message); }

  // ── Merge Supabase CGM with in-memory for gaps ────────────────────────────
  var sbReadingTs = new Set(sbReadings.map(function(r){ return r.t; }));
  var readings = sbReadings.slice();
  HISTORY_RAW.forEach(function(r){
    if (r && r.bg > 0 && r.t >= windowStart && r.t <= reportEnd && !sbReadingTs.has(r.t))
      readings.push({ t: r.t, bg: r.bg });
  });
  readings.sort(function(a,b){ return a.t - b.t; });

  var pricks = sbPricks.map(function(e){ return { t: e.t, bg: e.gi, cgm_reading: e.cgm_reading }; });
  var localPricks = (function(){ try{ return JSON.parse(localStorage.getItem('river_pricks')||'[]'); }catch(e){ return []; } })();
  var sbPrickTs = new Set(pricks.map(function(p){ return p.t; }));
  localPricks.forEach(function(p){ if(p && p.bg && p.t >= windowStart && !sbPrickTs.has(p.t)) pricks.push(p); });

  var total = readings.length || 1;
  var meanBG     = readings.reduce(function(s,r){return s+r.bg;},0) / total;
  var inRange    = readings.filter(function(r){ return r.bg >= 3.9 && r.bg <= 10.0; }).length;
  var belowRange = readings.filter(function(r){ return r.bg < 3.9; }).length;
  var aboveRange = readings.filter(function(r){ return r.bg > 10.0; }).length;
  var eA1C       = ((meanBG + 2.59) / 1.59).toFixed(1);
  var tirPct     = Math.round(100 * inRange / total);
  var belPct     = Math.round(100 * belowRange / total);
  var abvPct     = Math.round(100 * aboveRange / total);
  var cvArr      = readings.map(function(r){ return r.bg; });
  var sdBG       = cvArr.length > 1 ? (function(){ var m2=cvArr.reduce(function(s,v){return s+v;},0)/cvArr.length; return Math.sqrt(cvArr.reduce(function(s,v){return s+Math.pow(v-m2,2);},0)/cvArr.length); })() : 0;
  var cv         = meanBG > 0 ? Math.round(100*sdBG/meanBG) : 0;
  var dateMinStr = readings.length ? new Date(readings[0].t).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}) : '—';
  var dateMaxStr = readings.length ? new Date(readings[readings.length-1].t).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}) : '—';

  // Hypos & near-misses from CGM
  var hypoEvents = [], nearMissEvents = [];
  var inHypo = false, inNear = false, hypoStart = null, nearStart = null;
  readings.forEach(function(r) {
    if (r.bg < 3.9) {
      if (!inHypo) { inHypo = true; hypoStart = r.t; } inNear = false; nearStart = null;
    } else {
      if (inHypo) { hypoEvents.push({ t: hypoStart, end: r.t, nadir: Math.min.apply(null, readings.filter(function(x){return x.t>=hypoStart&&x.t<r.t;}).map(function(x){return x.bg;})) }); inHypo = false; }
      if (r.bg < 5.4) { if (!inNear) { inNear = true; nearStart = r.t; } }
      else { if (inNear) { nearMissEvents.push({ t: nearStart, end: r.t, nadir: Math.min.apply(null, readings.filter(function(x){return x.t>=nearStart&&x.t<r.t;}).map(function(x){return x.bg;})) }); inNear = false; } }
    }
  });

  // Events
  var mealEvents = sbEvents.filter(function(e){ return e.c > 0; });
  var bolusEvents = sbEvents.filter(function(e){ return e.u > 0; });
  var totalCarbs  = mealEvents.reduce(function(s,e){return s+(e.c||0);},0);
  var totalBolus  = bolusEvents.reduce(function(s,e){return s+(e.u||0);},0);

  // Hourly buckets
  var hourBuckets = [];
  for (var hb = 0; hb < 24; hb++) hourBuckets.push([]);
  readings.forEach(function(r){ hourBuckets[new Date(r.t).getHours()].push(r.bg); });

  // CGM chart data
  var cgmPoints  = readings.map(function(r){ return { x: r.t, y: +r.bg.toFixed(2) }; });
  var prickPoints = pricks.map(function(p){ return { x: p.t, y: +p.bg.toFixed(2) }; });

  // Build meal markers from Supabase meals
  var mealMarkers = sbMeals.map(function(m){
    var nearby = readings.filter(function(r){ return Math.abs(r.t-m.t)<600000; });
    var bg = nearby.length ? nearby.reduce(function(best,r){ return Math.abs(r.t-m.t)<Math.abs(best.t-m.t)?r:best; }, nearby[0]).bg : (m.pre_bg||null);
    return { x: m.t, y: bg, type:'meal', carbs: m.total_carbs, bolus: m.bolus_u };
  });
  var corrMarkers = sbEvents.filter(function(e){ return e.u > 0 && (!e.c || e.c === 0); }).map(function(e){
    var nearby = readings.filter(function(r){ return Math.abs(r.t-e.t)<600000; });
    var bg = nearby.length ? nearby.reduce(function(best,r){ return Math.abs(r.t-e.t)<Math.abs(best.t-e.t)?r:best; }, nearby[0]).bg : null;
    return { x: e.t, y: bg, type:'corr' };
  });
  var ghostMarkers = sbGhosts.map(function(g){
    var nearby = readings.filter(function(r){ return Math.abs(r.t-g.t)<600000; });
    var bg = nearby.length ? nearby.reduce(function(best,r){ return Math.abs(r.t-g.t)<Math.abs(best.t-g.t)?r:best; }, nearby[0]).bg : null;
    return { x: g.t, y: bg, type:'ghost', ghost_type: g.ghost_type||'' };
  });
  var hypoMarkers = hypoEvents.map(function(h){ return { x: h.t, y: h.nadir, type:'hypo' }; });

  // Day map for event log
  function _dayKey(t){ return new Date(t).toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'}); }
  var dayMap = {};
  sbMeals.forEach(function(m){
    var dk = _dayKey(m.t);
    if (!dayMap[dk]) dayMap[dk] = { meals:[], corrections:[], ghosts:[], t_first: m.t };
    var time = new Date(m.t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
    var nearby = readings.filter(function(r){ return Math.abs(r.t-m.t)<600000; });
    var bg = nearby.length ? nearby.reduce(function(best,r){ return Math.abs(r.t-m.t)<Math.abs(best.t-m.t)?r:best; }, nearby[0]).bg : (m.pre_bg||null);
    var items = m.items;
    if (typeof items === 'string') { try { items = JSON.parse(items); } catch(e2) { items = null; } }
    dayMap[dk].meals.push({ time:time, carbs:m.total_carbs, bolus:m.bolus_u, bg:bg, items:items, name:m.name, iob:0, t:m.t });
  });
  sbEvents.filter(function(e){ return e.u > 0 && (!e.c || e.c===0); }).forEach(function(e){
    var dk = _dayKey(e.t);
    if (!dayMap[dk]) dayMap[dk] = { meals:[], corrections:[], ghosts:[], t_first: e.t };
    var time = new Date(e.t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
    var nearby = readings.filter(function(r){ return Math.abs(r.t-e.t)<600000; });
    var bg = nearby.length ? nearby.reduce(function(best,r){ return Math.abs(r.t-e.t)<Math.abs(best.t-e.t)?r:best; }, nearby[0]).bg : null;
    dayMap[dk].corrections.push({ time:time, bolus:e.u, bg:bg, note:e.note, t:e.t });
  });
  sbGhosts.forEach(function(g){
    var dk = _dayKey(g.t);
    if (!dayMap[dk]) dayMap[dk] = { meals:[], corrections:[], ghosts:[], t_first: g.t };
    var time = new Date(g.t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
    dayMap[dk].ghosts.push({ time:time, ghost_type:g.ghost_type, implied_units:g.implied_units, implied_carbs:g.implied_carbs, confidence:g.confidence, confirmed:g.confirmed, t:g.t });
  });

  // ── Build HTML ─────────────────────────────────────────────────────────────
  var gen = new Date().toLocaleString('en-GB',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});

  var H = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">';
  H += '<title>Oskar Anderson-King — River Clinical Report ' + dateMaxStr + '</title>';
  H += '<style>';
  H += '*{box-sizing:border-box;margin:0;padding:0}html{font-size:13px}';
  H += 'body{font-family:"DM Mono",ui-monospace,monospace;background:#03050f;color:rgba(200,220,240,0.85);line-height:1.6;padding:0}';
  H += '.page{max-width:820px;margin:0 auto;padding:40px 24px 80px}';
  H += '.rh{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:1px solid rgba(255,255,255,0.08);padding-bottom:20px;margin-bottom:32px}';
  H += '.rh-title{font-size:28px;font-style:italic;font-weight:200;color:rgba(200,220,240,0.9);line-height:1.2}';
  H += '.rh-meta{text-align:right;font-size:10px;color:rgba(200,220,240,0.3);line-height:1.8}';
  H += '.sec-label{font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:rgba(200,220,240,0.35);margin-bottom:14px;border-bottom:1px solid rgba(255,255,255,0.05);padding-bottom:6px}';
  H += '.sec{margin-bottom:36px}';
  H += '.stat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}';
  H += '.stat{background:rgba(255,255,255,0.04);border-radius:10px;padding:14px 12px;text-align:center}';
  H += '.stat-val{font-size:26px;font-weight:500;line-height:1}.stat-lbl{font-size:9px;color:rgba(200,220,240,0.35);margin-top:5px}.stat-sub{font-size:9px;color:rgba(200,220,240,0.25);margin-top:2px}';
  H += '.tir-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:16px}';
  H += '.tir-bar{border-radius:6px;padding:9px 12px;display:flex;justify-content:space-between;align-items:center}';
  H += '.chart-wrap{position:relative;width:100%;height:300px;background:rgba(255,255,255,0.02);border-radius:10px;overflow:hidden;margin-bottom:8px}';
  H += '.chart-leg{display:flex;flex-wrap:wrap;gap:14px;font-size:10px;color:rgba(200,220,240,0.4);margin-bottom:28px}';
  H += '.chart-leg span{display:flex;align-items:center;gap:5px}.dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}.line{width:18px;height:2px;flex-shrink:0}';
  H += '.day-block{border:1px solid rgba(255,255,255,0.06);border-radius:10px;overflow:hidden;margin-bottom:12px}';
  H += '.day-hdr{background:rgba(255,255,255,0.04);padding:8px 14px;font-size:10px;color:rgba(200,220,240,0.5);display:flex;gap:16px;flex-wrap:wrap}';
  H += '.day-hdr b{color:rgba(200,220,240,0.8);font-weight:500;font-size:11px}';
  H += '.ev-row{display:grid;grid-template-columns:48px 66px 1fr auto;gap:8px;align-items:start;padding:8px 14px;border-bottom:1px solid rgba(255,255,255,0.04);font-size:11px}';
  H += '.ev-row:last-child{border-bottom:none}';
  H += '.ev-time{color:rgba(200,220,240,0.35);font-size:10px;padding-top:1px;font-variant-numeric:tabular-nums}';
  H += '.badge{display:inline-block;font-size:9px;font-weight:500;padding:2px 6px;border-radius:4px;white-space:nowrap}';
  H += '.b-meal{background:rgba(62,180,120,0.15);color:rgba(62,200,140,0.9)}.b-corr{background:rgba(255,180,60,0.12);color:rgba(255,180,60,0.8)}.b-ghost{background:rgba(140,120,240,0.12);color:rgba(180,160,240,0.8)}.b-hypo{background:rgba(255,80,80,0.12);color:rgba(255,120,100,0.85)}.b-near{background:rgba(255,160,40,0.12);color:rgba(255,160,40,0.8)}';
  H += '.ev-main{color:rgba(200,220,240,0.8);font-weight:500;margin-bottom:2px}.ev-sub{color:rgba(200,220,240,0.35);font-size:10px}.ev-items{color:rgba(200,220,240,0.3);font-size:10px;margin-top:3px;font-style:italic}';
  H += '.bg-num{font-variant-numeric:tabular-nums;font-weight:500;font-size:13px;white-space:nowrap;padding-top:1px}';
  H += '.bg-high{color:rgba(255,160,60,0.85)}.bg-ok{color:rgba(62,200,140,0.85)}.bg-low{color:rgba(255,100,80,0.9)}.bg-dim{color:rgba(200,220,240,0.3)}';
  H += '.compound-flag{background:rgba(100,140,255,0.06);border-left:2px solid rgba(100,140,255,0.3)}';
  H += '.iob-pill{display:inline-block;background:rgba(100,160,255,0.12);color:rgba(140,190,255,0.8);font-size:9px;padding:1px 5px;border-radius:3px;margin-left:4px}';
  H += '.cob-pill{display:inline-block;background:rgba(80,200,120,0.12);color:rgba(80,200,120,0.8);font-size:9px;padding:1px 5px;border-radius:3px;margin-left:4px}';
  H += '.ghost-block{border:1px solid rgba(140,120,240,0.2);border-radius:10px;padding:14px;margin-bottom:10px;background:rgba(140,120,240,0.04)}';
  H += '.footer{border-top:1px solid rgba(255,255,255,0.06);padding-top:20px;font-size:9px;color:rgba(200,220,240,0.25);line-height:2;text-align:center}';
  H += '@media print{body{background:#fff;color:#111}.stat,.day-block,.ghost-block{border:1px solid #ddd;background:#f9f9f9}.chart-wrap{border:1px solid #ddd}}';
  H += '</style></head><body><div class="page">';

  H += '<div class="rh"><div><div class="rh-title">Oskar\'s River</div>';
  H += '<div style="font-size:10px;color:rgba(200,220,240,0.3);margin-top:4px">clinical summary · ' + dateMinStr + ' – ' + dateMaxStr + '</div></div>';
  H += '<div class="rh-meta">Oskar Anderson-King · DOB 12 Jan 2014<br>T1D · MDI (Degludec + MyLife)<br>CGM: Libre 3 / Dexcom G7<br>Generated ' + gen + '<br>' + sbReadings.length + ' readings from Supabase</div></div>';

  H += '<div style="font-size:9px;background:rgba(255,160,40,0.07);border:1px solid rgba(255,160,40,0.15);border-radius:8px;padding:8px 12px;color:rgba(255,160,40,0.6);margin-bottom:28px">';
  H += 'NOT A CLINICAL DOCUMENT — generated by River. For conversation with your care team only. All times BST (UTC+1).</div>';

  // Stats
  H += '<div class="sec"><div class="sec-label">glucose summary</div><div class="stat-grid">';
  var meanCol2 = meanBG < 8 ? 'rgba(62,200,140,0.9)' : meanBG < 10 ? 'rgba(255,180,60,0.9)' : 'rgba(255,100,80,0.85)';
  H += '<div class="stat"><div class="stat-val" style="color:' + meanCol2 + '">' + meanBG.toFixed(1) + '</div><div class="stat-lbl">mean mmol/L</div></div>';
  var tirCol2 = tirPct >= 70 ? 'rgba(62,200,140,0.9)' : tirPct >= 50 ? 'rgba(255,180,60,0.9)' : 'rgba(255,100,80,0.85)';
  H += '<div class="stat"><div class="stat-val" style="color:' + tirCol2 + '">' + tirPct + '%</div><div class="stat-lbl">in range 3.9–10</div><div class="stat-sub">' + inRange + '/' + total + '</div></div>';
  H += '<div class="stat"><div class="stat-val" style="color:rgba(200,180,120,0.85)">' + eA1C + '%</div><div class="stat-lbl">est. A1c</div><div class="stat-sub">formula, not GMI</div></div>';
  H += '<div class="stat"><div class="stat-val" style="color:rgba(180,200,220,0.7)">' + cv + '%</div><div class="stat-lbl">coeff. variation</div><div class="stat-sub">target &lt;36%</div></div>';
  H += '</div><div class="tir-row">';
  H += '<div class="tir-bar" style="background:rgba(255,80,80,0.06)"><span style="font-size:10px;color:rgba(255,130,100,0.6)">below 3.9</span><span style="font-size:18px;font-weight:500;color:rgba(255,130,100,0.9)">' + belPct + '%</span></div>';
  H += '<div class="tir-bar" style="background:rgba(62,180,120,0.06)"><span style="font-size:10px;color:rgba(62,180,120,0.6)">3.9–10.0</span><span style="font-size:18px;font-weight:500;color:rgba(62,200,140,0.9)">' + tirPct + '%</span></div>';
  H += '<div class="tir-bar" style="background:rgba(255,180,60,0.06)"><span style="font-size:10px;color:rgba(255,180,60,0.6)">above 10.0</span><span style="font-size:18px;font-weight:500;color:rgba(255,180,60,0.9)">' + abvPct + '%</span></div>';
  H += '</div>';
  H += '<div style="font-size:9px;color:rgba(200,220,240,0.25)">' + total + ' CGM readings · ' + sbMeals.length + ' meals · ' + (bolusEvents.length - mealEvents.length) + ' corrections · ' + hypoEvents.length + ' hypo episode(s) · ' + sbGhosts.length + ' ghost event(s)</div></div>';

  // CGM chart
  H += '<div class="sec"><div class="sec-label">continuous glucose trace · ' + dateMinStr + ' – ' + dateMaxStr + '</div>';
  H += '<div class="chart-wrap"><canvas id="cgm-main" style="width:100%;height:100%"></canvas></div>';
  H += '<div class="chart-leg">';
  H += '<span><span class="line" style="background:rgba(62,180,160,0.8)"></span>CGM</span>';
  H += '<span><span class="dot" style="background:rgba(255,200,100,0.9)"></span>prick</span>';
  H += '<span><span class="dot" style="background:rgba(62,200,120,0.85)"></span>meal</span>';
  H += '<span><span class="dot" style="background:rgba(255,160,40,0.85)"></span>correction</span>';
  H += '<span><span class="dot" style="background:rgba(180,140,255,0.85)"></span>ghost ?</span>';
  H += '<span><span class="dot" style="background:rgba(255,80,80,0.9)"></span>hypo ≤3.9</span>';
  H += '</div></div>';

  // Hourly heatmap
  H += '<div class="sec"><div class="sec-label">24-hour pattern</div>';
  H += '<canvas id="hr-chart" width="760" height="120" style="width:100%;height:auto;border-radius:8px;background:rgba(255,255,255,0.02)"></canvas></div>';

  // Hypos & near-misses
  if (hypoEvents.length || nearMissEvents.length) {
    H += '<div class="sec"><div class="sec-label">hypos & near-misses</div>';
    hypoEvents.forEach(function(hv){
      var ts = new Date(hv.t).toLocaleString('en-GB',{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
      H += '<div class="ev-row" style="border-left:2px solid rgba(255,80,80,0.4);background:rgba(255,80,60,0.05)">';
      H += '<div class="ev-time">' + new Date(hv.t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}) + '</div>';
      H += '<div><span class="badge b-hypo">HYPO</span></div>';
      H += '<div class="ev-main">' + ts + ' · nadir ' + hv.nadir.toFixed(1) + ' mmol/L</div>';
      H += '<div class="bg-num bg-low">' + hv.nadir.toFixed(1) + '</div></div>';
    });
    nearMissEvents.forEach(function(nm){
      var ts = new Date(nm.t).toLocaleString('en-GB',{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
      H += '<div class="ev-row"><div class="ev-time">' + new Date(nm.t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}) + '</div>';
      H += '<div><span class="badge b-near">near</span></div>';
      H += '<div class="ev-main">' + ts + ' · nadir ' + nm.nadir.toFixed(1) + ' mmol/L · falling ≤5.4</div>';
      H += '<div class="bg-num" style="color:rgba(255,160,40,0.8)">' + nm.nadir.toFixed(1) + '</div></div>';
    });
    H += '</div>';
  }

  // Ghost events
  if (sbGhosts.length) {
    H += '<div class="sec"><div class="sec-label">unexplained ghost events</div>';
    H += '<div style="font-size:10px;color:rgba(200,220,240,0.3);margin-bottom:12px">BG patterns with no matching log entry detected by River.</div>';
    sbGhosts.forEach(function(g){
      var ts = new Date(g.t).toLocaleString('en-GB',{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
      var typeLabel = (g.ghost_type||'unknown').replace(/_/g,' ');
      var confPct = g.confidence ? Math.round(g.confidence*100)+'%' : '—';
      var status = g.confirmed === null ? 'unreviewed' : g.confirmed === false ? 'dismissed' : 'confirmed';
      H += '<div class="ghost-block">';
      H += '<div style="font-size:10px;color:rgba(180,160,240,0.8);margin-bottom:6px">? ' + ts + ' · ' + typeLabel + ' · ' + confPct + ' confidence · ' + status + '</div>';
      H += '<div style="font-size:10px;color:rgba(200,220,240,0.4)">';
      if (g.implied_units) H += 'Implied correction ≈ ' + g.implied_units + 'U<br>';
      if (g.implied_carbs) H += 'Implied carbs ≈ ' + g.implied_carbs + 'g<br>';
      if (g.carer_context) H += 'Context: ' + g.carer_context.replace(/_/g,' ');
      H += '</div></div>';
    });
    H += '</div>';
  }

  // Helper: find nearest CGM reading to timestamp t
  function _nearestBG(t, rds, windowMs) {
    var w = windowMs || 600000;
    var nearby = rds.filter(function(r){ return Math.abs(r.t - t) < w; });
    if (!nearby.length) return null;
    return nearby.reduce(function(best,r){ return Math.abs(r.t-t)<Math.abs(best.t-t)?r:best; }, nearby[0]);
  }

  // Helper: estimate active IOB at time t from prior bolus events
  // Uses a simple bi-exponential decay (DIA ~2.5h, peak ~60min)
  function _estimateIOB(t, evts) {
    var DIA_MS = 150 * 60000; // 2.5h in ms
    var iob = 0;
    evts.forEach(function(e) {
      if (!e.u || e.u <= 0) return;
      var age = t - e.t;
      if (age < 0 || age > DIA_MS) return;
      var frac = age / DIA_MS;
      // Rough remaining insulin fraction (linear decay is close enough for display)
      var remaining = Math.max(0, 1 - frac);
      iob += e.u * remaining;
    });
    return +iob.toFixed(2);
  }

  // Helper: estimate active COB at time t from prior meal events (45min absorption)
  function _estimateCOB(t, evts) {
    var ABS_MS = 120 * 60000; // 2h rough absorption window
    var cob = 0;
    evts.forEach(function(e) {
      if (!e.c || e.c <= 0) return;
      var age = t - e.t;
      if (age < 0 || age > ABS_MS) return;
      var remaining = Math.max(0, 1 - age / ABS_MS);
      cob += e.c * remaining;
    });
    return +cob.toFixed(1);
  }

  // Helper: build a mini inline CGM sparkline for ±2h window around a meal
  function _mealSparkline(t, rds) {
    var W2 = 120, H4 = 28, PAD2 = 2;
    var windowMs2 = 2 * 3600000;
    var pts = rds.filter(function(r){ return r.t >= t - windowMs2 && r.t <= t + windowMs2; });
    if (pts.length < 3) return '';
    var bgVals = pts.map(function(p){ return p.bg; });
    var bgMin2 = Math.min.apply(null, bgVals);
    var bgMax2 = Math.max.apply(null, bgVals);
    if (bgMax2 === bgMin2) bgMax2 = bgMin2 + 1;
    var tMin2 = t - windowMs2, tMax2 = t + windowMs2;
    function sx(ts){ return PAD2 + (ts - tMin2) / (tMax2 - tMin2) * (W2 - PAD2*2); }
    function sy(bg){ return PAD2 + (1 - (bg - bgMin2) / (bgMax2 - bgMin2)) * (H4 - PAD2*2); }
    var pathD = pts.map(function(p, i){ return (i===0?'M':'L') + sx(p.t).toFixed(1) + ',' + sy(p.bg).toFixed(1); }).join(' ');
    var mealX = sx(t).toFixed(1);
    // Target band
    var bandY1 = sy(Math.min(bgMax2, 10)).toFixed(1);
    var bandY2 = sy(Math.max(bgMin2, 3.9)).toFixed(1);
    return '<svg width="' + W2 + '" height="' + H4 + '" style="display:block;margin-top:5px;overflow:visible">' +
      '<rect x="' + PAD2 + '" y="' + bandY1 + '" width="' + (W2-PAD2*2) + '" height="' + (parseFloat(bandY2)-parseFloat(bandY1)) + '" fill="rgba(62,180,120,0.1)"/>' +
      '<path d="' + pathD + '" fill="none" stroke="rgba(62,180,160,0.7)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<line x1="' + mealX + '" y1="' + PAD2 + '" x2="' + mealX + '" y2="' + (H4-PAD2) + '" stroke="rgba(62,200,120,0.6)" stroke-width="1" stroke-dasharray="2,2"/>' +
      '<text x="2" y="9" fill="rgba(200,220,240,0.3)" font-size="6" font-family="monospace">' + bgMin2.toFixed(1) + '</text>' +
      '<text x="2" y="' + (H4-2) + '" fill="rgba(200,220,240,0.3)" font-size="6" font-family="monospace">' + bgMax2.toFixed(1) + '</text>' +
      '</svg>';
  }

  // Day-by-day log
  H += '<div class="sec"><div class="sec-label">day-by-day event log</div>';
  var dayKeys = Object.keys(dayMap).sort(function(a,b){ return dayMap[a].t_first - dayMap[b].t_first; });
  dayKeys.forEach(function(dk){
    var d = dayMap[dk];
    var dayCarbs = d.meals.reduce(function(s,m){return s+(m.carbs||0);},0);
    var dayBolus = d.meals.reduce(function(s,m){return s+(m.bolus||0);},0) + d.corrections.reduce(function(s,c){return s+(c.bolus||0);},0);
    var dayBgs = d.meals.map(function(m){return m.bg;}).concat(d.corrections.map(function(c){return c.bg;})).filter(Boolean);
    var dayMin = dayBgs.length ? Math.min.apply(null,dayBgs).toFixed(1) : '—';
    var dayMax = dayBgs.length ? Math.max.apply(null,dayBgs).toFixed(1) : '—';
    H += '<div class="day-block"><div class="day-hdr"><b>' + dk + '</b>';
    H += '<span>' + dayCarbs.toFixed(0) + 'g carbs</span><span>' + dayBolus.toFixed(1) + 'U</span>';
    H += '<span>BG ' + dayMin + '–' + dayMax + ' mmol</span>';
    if (d.ghosts.length) H += '<span style="color:rgba(180,140,255,0.7)">?' + d.ghosts.length + ' ghost</span>';
    H += '</div>';

    var allRows = [];
    d.meals.forEach(function(m){ allRows.push({t:m.t,type:'meal',data:m}); });
    d.corrections.forEach(function(c){ allRows.push({t:c.t,type:'corr',data:c}); });
    d.ghosts.forEach(function(g){ allRows.push({t:g.t,type:'ghost',data:g}); });
    allRows.sort(function(a,b){ return a.t-b.t; });

    allRows.forEach(function(row){
      // Compute IOB/COB from prior events
      var priorEvts = sbEvents.filter(function(e){ return e.t < row.t && e.t >= row.t - 3*3600000; });
      var iobAtRow = _estimateIOB(row.t, priorEvts);
      var cobAtRow = _estimateCOB(row.t, priorEvts);
      var isCompound = iobAtRow > 0.5;

      H += '<div class="ev-row' + (isCompound ? ' compound-flag' : '') + '">';
      H += '<div class="ev-time">' + row.data.time + '</div>';

      if (row.type === 'meal') {
        var snap = row.data.therapy_snapshot || {};
        var snapRatios = snap.ratios || [];
        // Find the ratio for the current period
        var mealH = new Date(row.t).getHours();
        var mealPeriod = mealH < 10 ? 'Breakfast' : mealH < 14 ? 'Lunch' : mealH < 18 ? 'Afternoon' : mealH < 22 ? 'Evening' : 'Overnight';
        var periodRatio = snapRatios.find(function(r){ return r.period === mealPeriod; });
        var ic  = periodRatio ? periodRatio.ic  : (snap.ic  || null);
        var isf = periodRatio ? periodRatio.isf : (snap.isf || null);
        var bgCol = !row.data.bg ? 'bg-dim' : row.data.bg < 3.9 ? 'bg-low' : row.data.bg > 10 ? 'bg-high' : 'bg-ok';

        H += '<div><span class="badge b-meal">meal</span></div><div>';
        H += '<div class="ev-main">' + (row.data.carbs||0) + 'g · ' + (row.data.bolus||0) + 'U';
        if (iobAtRow > 0.3) H += '<span class="iob-pill">IOB ' + iobAtRow.toFixed(1) + 'U</span>';
        if (cobAtRow > 2)   H += '<span class="cob-pill">COB ' + cobAtRow.toFixed(0) + 'g</span>';
        H += '</div>';
        // Therapy context
        var ctxParts = [];
        if (ic)  ctxParts.push('IC 1:' + ic);
        if (isf) ctxParts.push('ISF ' + isf);
        if (row.data.wait_mins != null) ctxParts.push('wait ' + row.data.wait_mins + 'min');
        if (ctxParts.length) H += '<div class="ev-sub">' + ctxParts.join(' · ') + '</div>';
        if (row.data.name) H += '<div class="ev-sub">' + row.data.name + '</div>';
        if (row.data.items && row.data.items.length) {
          var itemArr = Array.isArray(row.data.items) ? row.data.items : [];
          if (itemArr.length) H += '<div class="ev-items">' + itemArr.map(function(it){ return (it.name||'') + (it.carbs ? ' ' + it.carbs + 'g' : ''); }).join(' · ') + '</div>';
        }
        // Mini CGM sparkline ±2h
        H += _mealSparkline(row.t, readings);
        H += '</div><div class="bg-num ' + bgCol + '">' + (row.data.bg ? row.data.bg.toFixed(1) : '—') + '</div>';

      } else if (row.type === 'corr') {
        var bgColC = !row.data.bg ? 'bg-dim' : row.data.bg < 3.9 ? 'bg-low' : row.data.bg > 10 ? 'bg-high' : 'bg-ok';
        H += '<div><span class="badge b-corr">correction</span></div>';
        H += '<div><div class="ev-main">' + (row.data.bolus||0) + 'U';
        if (iobAtRow > 0.3) H += '<span class="iob-pill">IOB ' + iobAtRow.toFixed(1) + 'U</span>';
        H += '</div>';
        if (cobAtRow > 2) H += '<div class="ev-sub"><span class="cob-pill" style="margin-left:0">COB ' + cobAtRow.toFixed(0) + 'g still active</span></div>';
        if (row.data.note && ['bolus','correction','free','hypo','snack'].indexOf(row.data.note) < 0) {
          H += '<div class="ev-note" style="font-size:10px;color:rgba(255,180,80,0.5);margin-top:2px">' + row.data.note + '</div>';
        }
        H += '</div><div class="bg-num ' + bgColC + '">' + (row.data.bg ? row.data.bg.toFixed(1) : '—') + '</div>';

      } else if (row.type === 'ghost') {
        H += '<div><span class="badge b-ghost">? ghost</span></div>';
        H += '<div><div class="ev-main">' + (row.data.ghost_type||'').replace(/_/g,' ');
        if (row.data.confidence) H += ' · ' + Math.round(row.data.confidence*100) + '%';
        H += '</div>';
        if (row.data.implied_units) H += '<div class="ev-sub">implied ≈' + row.data.implied_units + 'U</div>';
        if (row.data.implied_carbs) H += '<div class="ev-sub">implied ≈' + row.data.implied_carbs + 'g carbs</div>';
        H += '</div><div class="bg-num bg-dim">?</div>';
      }
      H += '</div>';
    });
    H += '</div>';
  });
  H += '</div>';

  H += '<div class="footer">Oskar\'s River · glucose observation and pattern memory · not a clinical decision pathway<br>';
  H += 'CGM: Libre 3 via Nightscout · MDI · Oskar Anderson-King, T1D, diagnosed Aug 2025<br>';
  H += 'River build ' + (window['__BUILD'+'_ID__']||'dev') + ' · ' + sbReadings.length + ' Supabase readings · generated ' + gen + '</div>';

  // Inline charts script
  H += '<scr'+'ipt>';
  H += 'var cgmPts=' + JSON.stringify(cgmPoints) + ';';
  H += 'var prickPts=' + JSON.stringify(prickPoints) + ';';
  H += 'var mealMkr=' + JSON.stringify(mealMarkers) + ';';
  H += 'var corrMkr=' + JSON.stringify(corrMarkers) + ';';
  H += 'var ghostMkr=' + JSON.stringify(ghostMarkers) + ';';
  H += 'var hypoMkr=' + JSON.stringify(hypoMarkers) + ';';
  H += 'var hourBkts=' + JSON.stringify(hourBuckets.map(function(b){ return b.length?+(b.reduce(function(s,v){return s+v;},0)/b.length).toFixed(2):null; })) + ';';
  H += 'var hourCnts=' + JSON.stringify(hourBuckets.map(function(b){ return b.length; })) + ';';
  H += '(function(){';
  H += 'var cv=document.getElementById("cgm-main");if(!cv)return;';
  H += 'var par=cv.parentElement;cv.width=par.offsetWidth||760;cv.height=par.offsetHeight||300;';
  H += 'var ctx=cv.getContext("2d");var W=cv.width,H2=cv.height;';
  H += 'var pad={t:20,r:16,b:32,l:44};';
  H += 'var tMin=cgmPts.length?cgmPts[0].x:Date.now()-7*86400000;';
  H += 'var tMax=cgmPts.length?cgmPts[cgmPts.length-1].x:Date.now();';
  H += 'var bgMin=2.0,bgMax=20.0;';
  H += 'function tx(t){return pad.l+(t-tMin)/(tMax-tMin)*(W-pad.l-pad.r);}';
  H += 'function ty(bg){return pad.t+(1-(bg-bgMin)/(bgMax-bgMin))*(H2-pad.t-pad.b);}';
  H += 'ctx.fillStyle="rgba(62,180,120,0.08)";ctx.fillRect(pad.l,ty(10),W-pad.l-pad.r,ty(3.9)-ty(10));';
  H += '[4,6,8,10,14,18].forEach(function(v){ctx.strokeStyle=v===4||v===10?"rgba(255,255,255,0.12)":"rgba(255,255,255,0.05)";ctx.lineWidth=v===4||v===10?1:0.5;ctx.setLineDash([]);ctx.beginPath();ctx.moveTo(pad.l,ty(v));ctx.lineTo(W-pad.r,ty(v));ctx.stroke();ctx.fillStyle="rgba(200,220,240,0.3)";ctx.font="9px monospace";ctx.textAlign="right";ctx.fillText(v,pad.l-4,ty(v)+3);});';
  H += 'var day=86400000;var d0=Math.ceil(tMin/day)*day;for(var td=d0;td<=tMax;td+=day){var xd=tx(td);ctx.strokeStyle="rgba(255,255,255,0.08)";ctx.lineWidth=0.5;ctx.setLineDash([3,4]);ctx.beginPath();ctx.moveTo(xd,pad.t);ctx.lineTo(xd,H2-pad.b);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle="rgba(200,220,240,0.35)";ctx.font="9px monospace";ctx.textAlign="center";ctx.fillText(new Date(td).toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"}),xd,H2-pad.b+14);}';
  H += 'if(cgmPts.length>1){ctx.beginPath();ctx.strokeStyle="rgba(62,180,160,0.75)";ctx.lineWidth=1.5;ctx.setLineDash([]);var gap=15*60000;ctx.moveTo(tx(cgmPts[0].x),ty(cgmPts[0].y));for(var i=1;i<cgmPts.length;i++){if(cgmPts[i].x-cgmPts[i-1].x>gap){ctx.stroke();ctx.beginPath();ctx.moveTo(tx(cgmPts[i].x),ty(cgmPts[i].y));}else ctx.lineTo(tx(cgmPts[i].x),ty(cgmPts[i].y));}ctx.stroke();}';
  H += 'prickPts.forEach(function(p){ctx.beginPath();ctx.arc(tx(p.x),ty(p.y),4,0,Math.PI*2);ctx.fillStyle="rgba(255,200,100,0.9)";ctx.fill();});';
  H += 'mealMkr.forEach(function(m){if(!m.y)return;ctx.beginPath();ctx.arc(tx(m.x),ty(m.y),5,0,Math.PI*2);ctx.fillStyle="rgba(62,200,120,0.85)";ctx.fill();});';
  H += 'corrMkr.forEach(function(m){if(!m.y)return;ctx.beginPath();ctx.arc(tx(m.x),ty(m.y),4,0,Math.PI*2);ctx.fillStyle="rgba(255,160,40,0.85)";ctx.fill();});';
  H += 'ghostMkr.forEach(function(m){if(!m.y)return;ctx.beginPath();ctx.arc(tx(m.x),ty(m.y),5,0,Math.PI*2);ctx.fillStyle="rgba(180,140,255,0.8)";ctx.fill();ctx.fillStyle="rgba(255,255,255,0.7)";ctx.font="bold 8px monospace";ctx.textAlign="center";ctx.fillText("?",tx(m.x),ty(m.y)+3);});';
  H += 'hypoMkr.forEach(function(m){ctx.beginPath();ctx.arc(tx(m.x),ty(m.y||3.9),5,0,Math.PI*2);ctx.fillStyle="rgba(255,80,80,0.9)";ctx.fill();});';
  H += '})();';
  H += '(function(){var hcv=document.getElementById("hr-chart");if(!hcv)return;var hctx=hcv.getContext("2d");var W2=hcv.width,H3=hcv.height;var cellW=Math.floor((W2-32)/24);var cellH=H3-28;var offX=16;var offY=8;';
  H += 'hourBkts.forEach(function(mean,h){var x=offX+h*cellW;if(mean===null){hctx.fillStyle="rgba(255,255,255,0.03)";hctx.fillRect(x,offY,cellW-2,cellH);return;}var r,g,b;if(mean<3.9){r=255;g=80;b=80;}else if(mean<=7){r=62;g=200;b=140;}else if(mean<=10){r=Math.round(62+200*((mean-7)/3));g=Math.round(200-140*((mean-7)/3));b=100;}else{r=255;g=Math.round(160-80*Math.min(1,(mean-10)/4));b=40;}var alpha=hourCnts[h]>0?0.7:0.1;hctx.fillStyle="rgba("+r+","+g+","+b+","+alpha+")";hctx.fillRect(x,offY,cellW-2,cellH);if(hourCnts[h]>0){hctx.fillStyle="rgba(255,255,255,0.6)";hctx.font="8px monospace";hctx.textAlign="center";hctx.fillText(mean.toFixed(1),x+cellW/2-1,offY+cellH/2+3);}});';
  H += '[0,3,6,9,12,15,18,21].forEach(function(h){hctx.fillStyle="rgba(200,220,240,0.3)";hctx.font="8px monospace";hctx.textAlign="center";hctx.fillText(h.toString().padStart(2,"0"),offX+h*cellW+cellW/2-1,H3-6);});';
  H += '})();';
  H += '</'+'script>';
  H += '</div></body></html>';

  var blob = new Blob([H], { type: 'text/html;charset=utf-8' });
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  a.href   = url;
  a.download = 'oskar-river-clinic-' + new Date().toISOString().slice(0,10) + '.html';
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
    var found = (FOOD_LIBRARY||[]).find(function(f){ return f.name.toLowerCase() === aliased; });
    if (found) return found;
  }
  // Fuzzy match
  var all = [...(FOOD_LIBRARY||[])];
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
              text: 'This is a handwritten meal/diabetes log. Extract ALL items listed, including those with 0 or no carbs written.\n\n' +
                'CRITICAL CARB RULES:\n' +
                '1. carbs_g = the TOTAL carbohydrate grams for that item AS EATEN (not per 100g unless weight_g is 100).\n' +
                '2. If the note shows "Xg carbs" or "carbs: X" next to an item, use X directly as carbs_g.\n' +
                '3. If the note shows a carbs-per-100g value (e.g. "9.9/100g" or "c100=9.9") AND a weight, calculate: carbs_g = (c100 * weight_g / 100). E.g. 9.9g/100g × 25g bag = 2.5g carbs.\n' +
                '4. Decimal values like "9.9" or "2.5" must be preserved exactly — do NOT round to whole numbers.\n' +
                '5. If no carbs are written for an item, set carbs_g to null (do NOT skip the item).\n' +
                '6. Abbreviations: "clem"/"clementine" = fruit ~8g carbs per fruit; include if written even without explicit carb count.\n\n' +
                'Return ONLY valid JSON, no preamble:\n' +
                '{\n' +
                '  "items": [{"name": string, "carbs_g": number|null, "weight_g": number|null}],\n' +
                '  "total_carbs": number or null,\n' +
                '  "bg_mmol": number or null,\n' +
                '  "insulin_units": number or null,\n' +
                '  "wait_mins": number or null,\n' +
                '  "meal_label": "breakfast"|"lunch"|"dinner"|"snack"|null,\n' +
                '  "time_written": "HH:MM" or null,\n' +
                '  "date_written": "DD/MM/YYYY" or null\n' +
                '}\n' +
                'Include ALL items visible, even if carbs_g is null. Split compound descriptions into individual items. Look carefully for a time written near any BG reading.'
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
    var carbs;
    if (match) {
      // Use food library c100 × weight for matched items
      carbs = Math.round((match.c100||0) * (i.weight_g||100) / 100 * 10) / 10;
    } else if (i.carbs_g !== null && i.carbs_g !== undefined) {
      // Use AI-extracted carbs directly, preserving decimals
      carbs = Math.round(i.carbs_g * 10) / 10;
    } else {
      // No carbs written — leave blank so user must fill in
      carbs = '';
    }
    return {
      raw: i.name,
      displayName: i.name,
      grams: i.weight_g || null,
      carbs: carbs,
      carbsNull: (i.carbs_g === null || i.carbs_g === undefined) && !match,
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
      var carbsIsBlank = item.carbs === '' || item.carbs === null || item.carbs === undefined;
      var carbBorderCol = carbsIsBlank ? 'rgba(220,80,80,0.5)' : 'rgba(255,140,50,0.2)';
      var carbBgCol     = carbsIsBlank ? 'rgba(220,80,80,0.07)' : 'rgba(255,140,50,0.05)';
      var carbVal       = carbsIsBlank ? '' : item.carbs;
      s += '<div style="background:rgba(255,255,255,0.03);border-radius:8px;padding:10px 12px;margin-bottom:8px">';
      // Row 1: editable name + carbs + delete
      s += '<div style="display:flex;align-items:center;gap:8px">';
      s += '<input type="text" value="' + (item.displayName||item.raw).replace(/"/g,'&quot;') + '" ' +
        'onchange="window._padItems[' + idx + '].displayName=this.value;window._padItems[' + idx + '].raw=this.value" ' +
        'style="flex:1;min-width:0;font-size:11px;padding:4px 7px;border-radius:5px;' +
        'border:1px solid rgba(255,255,255,0.08);background:transparent;' +
        'font-family:\'DM Mono\',monospace;' +
        'color:' + (item.matched ? 'rgba(200,220,240,0.85)' : 'rgba(255,180,80,0.85)') + ';outline:none">';
      s += '<input type="number" min="0" max="500" step="0.5" ' +
        (carbVal !== '' ? 'value="' + carbVal + '" ' : '') +
        'placeholder="?" ' +
        'onchange="window._padItems[' + idx + '].carbs=this.value===\'\' ? \'\'  : parseFloat(this.value)||0;window._padUpdateTotal()" ' +
        'style="width:54px;padding:6px;border-radius:6px;border:1px solid ' + carbBorderCol + ';' +
        'background:' + carbBgCol + ';font-family:\'DM Mono\',monospace;font-size:14px;' +
        'color:rgba(255,140,50,0.9);text-align:center;outline:none">';
      s += '<span style="font-size:9px;color:rgba(200,220,240,0.3)">g</span>';
      s += '<button onclick="window._padItems.splice(' + idx + ',1);window._padRerender()" ' +
        'style="background:none;border:none;cursor:pointer;font-size:14px;' +
        'color:rgba(200,220,240,0.3);padding:2px">×</button>';
      s += '</div>';
      // Row 2: link / add buttons for unmatched items
      if (!item.matched) {
        s += '<div style="display:flex;gap:6px;margin-top:7px">';
        s += '<button onclick="openAliasLinker(' + idx + ')" ' +
          'style="padding:4px 8px;border-radius:6px;border:1px solid rgba(255,180,80,0.3);' +
          'background:rgba(255,180,80,0.07);font-family:\'DM Mono\',monospace;font-size:9px;' +
          'color:rgba(255,180,80,0.8);cursor:pointer">link to library</button>';
        s += '<button onclick="openAddFoodFromPad(' + idx + ')" ' +
          'style="padding:4px 8px;border-radius:6px;border:1px solid rgba(62,180,120,0.3);' +
          'background:rgba(62,180,120,0.07);font-family:\'DM Mono\',monospace;font-size:9px;' +
          'color:rgba(62,180,120,0.8);cursor:pointer">+ add to library</button>';
        s += '</div>';
      }
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
    var tot = window._padItems.reduce(function(s,i){ return s+(i.carbs===''||i.carbs===null||i.carbs===undefined ? 0 : parseFloat(i.carbs)||0); }, 0);
    var el2 = document.getElementById('pad-total');
    if (el2) el2.textContent = tot.toFixed(1) + 'g';
  };

  renderImportScreen();
  document.body.appendChild(el);
}

function openAddFoodFromPad(itemIdx) {
  // Opens the standard addCustomFood overlay pre-filled with the scanned item name,
  // then on save patches the pad item with the new food's c100 and updates carbs.
  var item = window._padItems[itemIdx];
  if (!item) return;
  var padName = item.displayName || item.raw;

  // Stash a callback so saveCustomFood can update the pad item
  window._padAddCallback = function(savedFood) {
    if (!savedFood) return;
    item.matched = true;
    item.match   = savedFood;
    item.carbs   = savedFood.c100 > 0
      ? Math.round((savedFood.c100 * (item.grams||100) / 100) * 10) / 10
      : item.carbs;
    item.gi      = savedFood.gi || 55;
    if (window._padRerender) window._padRerender();
    showToast(padName + ' added to library');
  };

  addCustomFood(padName);
}

function openAliasLinker(itemIdx) {
  var item = window._padItems[itemIdx];
  if (!item) return;
  var all = [...(FOOD_LIBRARY||[])];

  var el = document.createElement('div');
  el.id  = 'alias-linker';
  el.style.cssText = 'position:fixed;inset:0;z-index:160;background:rgba(3,5,20,0.95);' +
    'display:flex;flex-direction:column;padding:32px 20px;font-family:"DM Mono",monospace';
  el.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">' +
      '<div style="font-size:14px;color:rgba(255,180,80,0.9)">link "' + (item.displayName||item.raw) + '" to…</div>' +
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

  var foodItems = items.map(function(i){
    var gi = i._gi_override || i.gi || 55;
    return { name: i.displayName||i.raw, carbs: parseFloat(i.carbs)||0, gi: gi, g: i.grams, source: 'pad' };
  });
  var avgGI = foodItems.length && totalCarbs > 0
    ? foodItems.reduce(function(s,i){ return s + (i.gi||55) * (i.carbs||0); }, 0) / totalCarbs
    : 55;

  // Reserve the bolus t BEFORE computing carbT — when waitMins===0, carbT
  // would otherwise collide with t and the on_conflict=t upsert would
  // silently merge/overwrite one event's row with the other's.
  if (u > 0) {
    t = _safeEventT(t);
    // Store waitMins on the bolus event so the event editor can correctly
    // find and reposition the linked carb event when wait time is edited.
    SESSION.push({t:t, c:0, u:u, waitMins:waitMins, source:'pad'});
    LOGGED_EVENTS.push({t:t, c:0, u:u, waitMins:waitMins, note:'bolus', source:'pad', logged_by:_thisPersonId||'unknown', local:true});
    topUpIOB(u);
    // Snapshot IOB prediction curve for outcome tracking — this path never
    // wrote a bolus_outcomes baseline at all (same gap as logCorrection,
    // logMealEntry, commitManualBolus). insulin_type isn't carried on pad
    // events, so fall back to the currently-selected insulin type.
    (function() {
      try {
        var padInsType = _currentSelectedInsulin();
        var padEv = {t: t, u: u, insulin_type: padInsType, logged_by: _thisPersonId||'unknown'};
        var iobCurve = [];
        var d0 = dataAt(t);
        var ISF = _currentTherapySnapshot(t);
        var isf = ISF ? ISF.isf : 6.5;
        var insProfile = _getInsulinProfile(padInsType);
        for (var m = 5; m <= 240; m += 5) {
          var predBG = d0 ? Math.max(1.8, d0.bg - u * (1 - _iobFn(m, insProfile.diaMins, insProfile.peakMins)) * isf) : 0;
          iobCurve.push({mins: m, bg: +predBG.toFixed(2)});
        }
        _createBolusOutcomeBaselineWithRetry(padEv, iobCurve);
      } catch (diagErr) {
        console.warn('[bolusOutcomeBaseline] commitPadImport IIFE setup threw:', diagErr);
      }
    })();
  }
  var carbT = _safeEventT(t + waitMins * 60000);
  if (totalCarbs > 0) {
    SESSION.push({t:carbT, c:totalCarbs, u:0, gi:avgGI, items:foodItems, source:'pad'});
    LOGGED_EVENTS.push({t:carbT, c:totalCarbs, u:0, gi:avgGI, items:foodItems, note:'carbs', source:'pad',
      logged_by:_thisPersonId||'unknown', local:true});
    topUpCOB(totalCarbs);
  }

  // Bolus-with-carbs: classify any rounding/override vs the suggested dose
  if (u > 0 && totalCarbs > 0) {
    var _suggested = calcBolus(totalCarbs, dataAt(t).bg, t).total;
    _storeBolusOverride(t, _suggested, u);
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
    (function(){
      var _snap = buildSmartForecast(MEAL_HISTORY[0] ? MEAL_HISTORY[0].t : (CGM_END || Date.now()));
      if (MEAL_HISTORY[0]) MEAL_HISTORY[0]._predictedCurve = _snap;
      _pushActivePredictedCurve(_snap, Date.now());
      syncMealToSupabase(MEAL_HISTORY[0]);
    })();
  }

  // Set eat reminder — same as logMealEntry
  if (u > 0 && waitMins > 0) {
    var eatAt = t + waitMins * 60000;
    if (_eatReminder) clearTimeout(_eatReminder);
    _eatReminder = setTimeout(function() {
      if (document.getElementById('sheet') && document.getElementById('sheet').classList.contains('open')) return;
      showRiverPebble('time to eat (~' + waitMins + 'min since bolus)', 'eat');
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    }, Math.max(0, eatAt - Date.now()));
  }

  // Build a meaningful toast covering both bolus and carbs
  var parts = [];
  if (u > 0) parts.push(u.toFixed(1) + 'U insulin');
  if (totalCarbs > 0) parts.push(totalCarbs.toFixed(0) + 'g carbs');
  if (u > 0 && waitMins > 0) parts.push('eat in ' + waitMins + 'min');
  showToast((parts.join(' · ') || 'logged') + '\nadded to the flow');
}

// ── Load aliases on startup ──────────────────────────────────────────────
loadAliasesFromSupabase();
