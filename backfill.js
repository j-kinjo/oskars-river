// ═══════════════════════════════════════════════════════════════
//  RIVER — backfill.js  v1.1
//  Historical meal review module.
//  Compatible with app.js _supabase shim (uses _sbFetch internally).
//
//  Entry: initBackfill()      — call after app.js loads
//         openBackfillReview() — called from settings tray
// ═══════════════════════════════════════════════════════════════

'use strict';

// ── Config ─────────────────────────────────────────────────────
const BF_WORKER = 'https://orange-surf-6f98.john-king-uk.workers.dev';

// ── State ──────────────────────────────────────────────────────
let _bfQueue        = [];
let _bfFilter       = 'pending';
let _bfTypeFilter   = 'all';   // 'all' | 'bolus' | 'correction' | 'free'
let _bfDateFrom     = '';      // YYYY-MM-DD
let _bfDateTo       = '';      // YYYY-MM-DD
let _bfSheetOpen    = false;
let _bfPendingCount = 0;

// ── Helpers — use _sbFetch directly (matches app.js internals) ─
async function _bfFetch(path, opts) {
  // Delegates to app.js _sbFetch so credentials stay centralised
  return _sbFetch(path, opts || {});
}

// Normalise a cgm_curve array to {m: minsFromEvent, bg: mmol} regardless of
// stored format. Live data is {t: unix_ms, v: mmol} (confirmed universal
// across omnipod/mylife seed sources, June 2026) — minutes are relative to
// evT, not absolute. An older {m, bg} shape is also accepted for safety,
// matching the dual-format shim bfDrawCGM already used before this existed.
function _bfNormaliseCurve(cgm, evT) {
  return (cgm || []).map(function(p) {
    var mins = p.m != null ? p.m : (evT ? Math.round((p.t - evT) / 60000) : 0);
    var bg   = p.bg != null ? p.bg : p.v;
    return { m: mins, bg: bg };
  }).filter(function(p){ return p.bg != null; });
}

// ── Init ───────────────────────────────────────────────────────
async function initBackfill() {
  try {
    var rows = await _bfFetch(
      'backfill_queue?status=in.(pending,flagged)&select=id,status',
      { method: 'GET' }
    );
    _bfPendingCount = Array.isArray(rows) ? rows.length : 0;
    if (_bfPendingCount > 0) {
      if (typeof __debugLog === 'function') if (typeof __debugLog === 'function') __debugLog('backfill: ' + _bfPendingCount + ' events awaiting review');
      // Update settings tray label if it's currently open
      _bfUpdateTrayBadge();
    }
  } catch(e) {
    if (typeof __debugLog === 'function') if (typeof __debugLog === 'function') __debugLog('backfill init error: ' + e.message);
  }
}

function _bfUpdateTrayBadge() {
  // Find the meal history button in the settings tray (if open) and update label
  var tray = document.getElementById('settings-tray');
  if (!tray) return;
  tray.querySelectorAll('button').forEach(function(btn) {
    if (btn.textContent && btn.textContent.indexOf('meal history') >= 0 && _bfPendingCount > 0) {
      var span = btn.querySelector('span:last-child');
      if (span) span.textContent = 'meal history · ' + _bfPendingCount + ' pending';
    }
  });
}

// ── Count pending (re-exported for badge use) ──────────────────
async function bfPendingCount() {
  try {
    var rows = await _bfFetch('backfill_queue?status=eq.pending&select=id', { method: 'GET' });
    return Array.isArray(rows) ? rows.length : 0;
  } catch(e) { return 0; }
}

// ── Load queue ─────────────────────────────────────────────────
async function bfLoadQueue(filter) {
  filter = filter || 'pending';
  var params = [];

  // Status filter
  params.push(filter === 'all'
    ? 'status=in.(pending,flagged,approved)'
    : filter === 'flagged'
    ? 'status=eq.flagged'
    : 'status=eq.pending');

  // Date range
  if (_bfDateFrom) params.push('date=gte.' + _bfDateFrom);
  if (_bfDateTo)   params.push('date=lte.' + _bfDateTo);

  params.push('order=date.asc,time.asc');

  var rows = await _bfFetch('backfill_queue?' + params.join('&'), { method: 'GET' });
  var result = Array.isArray(rows) ? rows : [];

  // Type filter applied client-side (notes field holds type)
  if (_bfTypeFilter && _bfTypeFilter !== 'all') {
    result = result.filter(function(ev) {
      var t = ev.notes && ['bolus','correction','free','hypo','snack'].indexOf(ev.notes) >= 0
        ? ev.notes
        : (ev.units > 0 && ev.carbs_device > 0 ? 'bolus'
          : ev.units > 0 ? 'correction' : 'snack');
      // 'snack' filter also catches legacy 'free' records
      if (_bfTypeFilter === 'snack') return t === 'snack' || t === 'free';
      return t === _bfTypeFilter;
    });
  }
  return result;
}

// ── Open review sheet ──────────────────────────────────────────
async function openBackfillReview() {
  if (_bfSheetOpen) return;
  _bfSheetOpen = true;

  var sheet = document.createElement('div');
  sheet.id = 'bf-sheet';
  sheet.style.cssText = [
    'position:fixed', 'inset:0', 'background:#0c0c0f', 'z-index:500',
    'display:flex', 'flex-direction:column', 'overflow:hidden',
    "font-family:-apple-system,BlinkMacSystemFont,'SF Mono',monospace",
  ].join(';');

  sheet.innerHTML = [
    // ── Top bar: title + close ──
    '<div style="padding:12px 16px 8px;border-bottom:1px solid #26262f;display:flex;align-items:center;gap:12px;flex-shrink:0">',
      '<div style="flex:1">',
        '<div style="font-size:15px;font-weight:600;color:#e8e4dc">Event History Review</div>',
        '<div id="bf-progress" style="font-size:11px;color:#555;margin-top:1px">Loading…</div>',
      '</div>',
      '<button onclick="closeBackfillReview()" style="font-family:inherit;font-size:18px;background:none;border:none;color:#555;cursor:pointer;padding:0 4px;line-height:1">×</button>',
    '</div>',

    // ── Filter bar ──
    '<div style="padding:8px 16px;border-bottom:1px solid #1a1a1e;display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex-shrink:0;background:#0f0f12">',

      // Status filters
      '<div style="display:flex;gap:4px">',
        ['pending','flagged','all'].map(function(f) {
          var active = f === 'pending';
          return '<button onclick="bfSetFilter(\'' + f + '\')" id="bff-' + f + '" style="font-family:inherit;font-size:10px;padding:3px 9px;border:1px solid ' + (active?'#4a8fd4':'#26262f') + ';border-radius:4px;background:' + (active?'#0d1820':'transparent') + ';color:' + (active?'#4a8fd4':'#555') + ';cursor:pointer">' + f + '</button>';
        }).join(''),
      '</div>',

      '<span style="color:#26262f;font-size:14px">|</span>',

      // Type filters
      '<div style="display:flex;gap:4px">',
        [['all','all'],['bolus','meal'],['correction','corr'],['hypo','hypo'],['snack','snack']].map(function(p) {
          var active = p[0] === 'all';
          return '<button onclick="bfSetTypeFilter(\'' + p[0] + '\')" id="bftf-' + p[0] + '" style="font-family:inherit;font-size:10px;padding:3px 9px;border:1px solid ' + (active?'#40a870':'#26262f') + ';border-radius:4px;background:' + (active?'#0d180d':'transparent') + ';color:' + (active?'#40a870':'#555') + ';cursor:pointer">' + p[1] + '</button>';
        }).join(''),
      '</div>',

      '<span style="color:#26262f;font-size:14px">|</span>',

      // Date range
      '<input id="bf-date-from" type="date" placeholder="from" onchange="bfSetDateFilter()" ',
        'style="font-family:inherit;font-size:10px;padding:3px 6px;border:1px solid #26262f;border-radius:4px;background:#0c0c0f;color:#555;width:112px">',
      '<span style="color:#555;font-size:10px">→</span>',
      '<input id="bf-date-to" type="date" placeholder="to" onchange="bfSetDateFilter()" ',
        'style="font-family:inherit;font-size:10px;padding:3px 6px;border:1px solid #26262f;border-radius:4px;background:#0c0c0f;color:#555;width:112px">',
      '<button onclick="bfClearDates()" style="font-family:inherit;font-size:10px;padding:3px 7px;border:1px solid #26262f;border-radius:4px;background:transparent;color:#555;cursor:pointer">×</button>',

    '</div>',

    '<div id="bf-body" style="flex:1;overflow-y:auto;padding:12px 16px">',
      '<div style="text-align:center;color:#555;padding:40px;font-size:13px">Loading events…</div>',
    '</div>',
  ].join('');

  document.body.appendChild(sheet);

  try {
    _bfQueue = await bfLoadQueue('pending');
    _bfFilter = 'pending';
    bfRenderQueue();
  } catch(e) {
    var body = document.getElementById('bf-body');
    if (body) body.innerHTML = '<div style="color:#c0392b;padding:20px;font-size:13px">Error: ' + e.message + '</div>';
  }
}
window.openBackfillReview = openBackfillReview;

function closeBackfillReview() {
  var el = document.getElementById('bf-sheet');
  if (el) el.remove();
  _bfSheetOpen = false;
  _bfQueue = [];
}
window.closeBackfillReview = closeBackfillReview;

// ── Filter toggle ──────────────────────────────────────────────
async function bfSetFilter(f) {
  _bfFilter = f;
  ['pending','flagged','all'].forEach(function(btn) {
    var el = document.getElementById('bff-' + btn);
    if (!el) return;
    var active = btn === f;
    el.style.borderColor = active ? '#4a8fd4' : '#26262f';
    el.style.background  = active ? '#0d1820' : 'transparent';
    el.style.color       = active ? '#4a8fd4' : '#555';
  });
  await _bfReload();
}
window.bfSetFilter = bfSetFilter;

async function bfSetTypeFilter(f) {
  _bfTypeFilter = f;
  ['all','bolus','correction','hypo','snack'].forEach(function(t) {
    var el = document.getElementById('bftf-' + t);
    if (!el) return;
    var active = t === f;
    el.style.borderColor = active ? '#40a870' : '#26262f';
    el.style.background  = active ? '#0d180d' : 'transparent';
    el.style.color       = active ? '#40a870' : '#555';
  });
  await _bfReload();
}
window.bfSetTypeFilter = bfSetTypeFilter;

async function bfSetDateFilter() {
  _bfDateFrom = (document.getElementById('bf-date-from')||{}).value || '';
  _bfDateTo   = (document.getElementById('bf-date-to')  ||{}).value || '';
  await _bfReload();
}
window.bfSetDateFilter = bfSetDateFilter;

async function bfClearDates() {
  _bfDateFrom = ''; _bfDateTo = '';
  var f = document.getElementById('bf-date-from');
  var t = document.getElementById('bf-date-to');
  if (f) f.value = ''; if (t) t.value = '';
  await _bfReload();
}
window.bfClearDates = bfClearDates;

async function _bfReload() {
  var body = document.getElementById('bf-body');
  if (body) body.innerHTML = '<div style="text-align:center;color:#555;padding:40px;font-size:13px">Loading…</div>';
  try {
    _bfQueue = await bfLoadQueue(_bfFilter);
    bfRenderQueue();
  } catch(e) {
    var body2 = document.getElementById('bf-body');
    if (body2) body2.innerHTML = '<div style="color:#c0392b;padding:20px">' + e.message + '</div>';
  }
}

// ── Render queue ───────────────────────────────────────────────
function bfRenderQueue() {
  var body = document.getElementById('bf-body');
  if (!body) return;

  var done    = _bfQueue.filter(function(e){ return e.status==='approved'; }).length;
  var total   = _bfQueue.length;
  var pending = _bfQueue.filter(function(e){ return e.status==='pending'; }).length;

  var prog = document.getElementById('bf-progress');
  if (prog) prog.textContent = done + '/' + total + ' reviewed · ' + pending + ' pending';

  if (!_bfQueue.length) {
    body.innerHTML = '<div style="text-align:center;color:#1d9e72;padding:60px 20px;font-size:14px">✓ All ' + _bfFilter + ' events reviewed</div>';
    return;
  }
  // Detect split bolus pairs before rendering
  var splitPairs = _bfFindSplitPairs(_bfQueue);
  var splitPairMap = {}; // idxA → {a,b}
  splitPairs.forEach(function(p){ splitPairMap[p.a] = p; });

  // Render cards with insert-event affordance between each pair
  var parts = [];
  _bfQueue.forEach(function(ev, i) {
    parts.push(bfCardHTML(ev, i));

    if (i < _bfQueue.length - 1) {
      // Split bolus banner — replaces the thin insert row when a pair is detected
      if (splitPairMap[i]) {
        var p = splitPairMap[i];
        var eA = _bfQueue[p.a], eB = _bfQueue[p.b];
        var combinedC = ((parseFloat(eA.carbs_device)||0) + (parseFloat(eB.carbs_device)||0)).toFixed(1);
        var combinedU = ((parseFloat(eA.units)||0)        + (parseFloat(eB.units)||0)).toFixed(1);
        parts.push(
          '<div style="margin:-6px 0;padding:6px 10px;background:#0d180d;border:1px solid #40a87055;border-radius:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">',
            '<span style="font-size:10px;color:#40a870;font-weight:600">⟂ split bolus detected</span>',
            '<span style="font-size:10px;color:#555">' + eA.time + ' + ' + eB.time + ' · ' + eA.carbs_device + 'g + ' + eB.carbs_device + 'g = ' + combinedC + 'g total · ' + combinedU + 'U total</span>',
            '<button onclick="bfMergeSplitBolus(' + p.a + ',' + p.b + ')" ',
              'style="font-family:inherit;font-size:11px;padding:4px 12px;border:1px solid #40a870;border-radius:5px;background:transparent;color:#40a870;cursor:pointer;font-weight:600;margin-left:auto">',
              'merge &amp; approve →',
            '</button>',
            '<button onclick="bfDismissSplitHint(' + p.a + ',' + p.b + ')" ',
              'style="font-family:inherit;font-size:10px;padding:4px 8px;border:1px solid #26262f;border-radius:5px;background:transparent;color:#555;cursor:pointer">',
              'not a split',
            '</button>',
          '</div>'
        );
      } else {
        // Normal slim insert row
        var midT = Math.round((ev.t + _bfQueue[i+1].t) / 2);
        var midDate = new Date(midT);
        var pad = function(n){ return String(n).padStart(2,'0'); };
        var midVal = midDate.getFullYear()+'-'+pad(midDate.getMonth()+1)+'-'+pad(midDate.getDate())+'T'+pad(midDate.getHours())+':'+pad(midDate.getMinutes());
        parts.push(
          '<div class="bf-insert" style="display:flex;align-items:center;gap:6px;padding:0 4px;margin:-4px 0;height:18px;cursor:pointer;opacity:0.35" ' +
            'onmouseover="this.style.opacity=\'1\'" onmouseout="this.style.opacity=\'0.35\'" ' +
            'onclick="bfExpandInsert(this,\'' + midVal + '\')">' +
            '<div style="flex:1;height:1px;background:#26262f"></div>' +
            '<span style="font-size:10px;color:#555;padding:0 4px">+</span>' +
            '<div style="flex:1;height:1px;background:#26262f"></div>' +
          '</div>'
        );
      }
    }
  });
  body.innerHTML = parts.join('');
}

// ── Split bolus detection ──────────────────────────────────────
// Identifies adjacent queue rows that look like halves of an Omnipod-style
// split bolus: same calendar date, within 90 minutes, both carbs entries,
// carbs within 5g of each other (Omnipod re-enters half the carbs for each dose).
// Returns array of {a: idxA, b: idxB} pairs.
function _bfFindSplitPairs(queue) {
  var pairs = [];
  var seen  = {};
  for (var i = 0; i < queue.length - 1; i++) {
    if (seen[i]) continue;
    var ea = queue[i];
    var eb = queue[i + 1];
    if (!ea || !eb) continue;
    // Skip if dismissed this session
    if (ea._splitDismissed || eb._splitDismissed) continue;
    // Both must have carbs > 0
    if (!ea.carbs_device || !eb.carbs_device) continue;
    // Within 90 minutes
    var dtMs = Math.abs((eb.t || 0) - (ea.t || 0));
    if (dtMs > 90 * 60000) continue;
    // Carbs close to each other (Omnipod enters each half separately)
    var carbDiff = Math.abs(parseFloat(ea.carbs_device) - parseFloat(eb.carbs_device));
    if (carbDiff > 5) continue;
    // At least one must still be pending
    if (ea.status === 'approved' && eb.status === 'approved') continue;
    pairs.push({ a: i, b: i + 1 });
    seen[i] = true;
    seen[i + 1] = true;
  }
  return pairs;
}

// ── Merge two split bolus cards into one meal_history row ──────
async function bfMergeSplitBolus(idxA, idxB) {
  var ea = _bfQueue[idxA];
  var eb = _bfQueue[idxB];
  if (!ea || !eb) return;

  var u1         = parseFloat(ea.units) || 0;
  var u2         = parseFloat(eb.units) || 0;
  var totalCarbs = (parseFloat(ea.carbs_device) || 0) + (parseFloat(eb.carbs_device) || 0);
  var totalUnits = u1 + u2;
  var delayMins  = Math.round(Math.abs((eb.t || 0) - (ea.t || 0)) / 60000);

  // Use first event's items as the food list
  var items = (ea.items && ea.items.length) ? ea.items : (eb.items || []);

  // Preserve non-type notes from both sides
  var combinedNotes = [ea.notes, eb.notes]
    .filter(function(n){ return n && ['bolus','correction','free','hypo','snack'].indexOf(n) < 0; })
    .join(' | ') || '';

  // Store split bolus metadata on the first event — used by bfApprove and bfCardHTML
  ea.split_bolus = {
    t2:         eb.t,
    time2:      eb.time || '',
    u1:         u1,
    u2:         u2,
    delay_mins: delayMins,
  };

  // Update ea in-memory with merged values
  ea.carbs_device = totalCarbs;
  ea.units        = totalUnits;
  ea.items        = items;
  ea.notes        = combinedNotes;

  // Mark the second event as skipped in Supabase immediately
  try {
    await _bfFetch('backfill_queue?t=eq.' + eb.t, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { status: 'skipped', notes: 'merged into split bolus at t=' + ea.t }
    });
    eb.status = 'skipped';
    // Fade and remove second card
    var card2 = document.getElementById('bfc-' + idxB);
    if (card2) {
      card2.style.transition = 'opacity 0.2s';
      card2.style.opacity = '0';
      setTimeout(function(){ if(card2.parentNode) card2.remove(); }, 200);
    }
    // Also remove the split banner between them
    var banner = document.getElementById('bfc-' + idxA) &&
      document.getElementById('bfc-' + idxA).nextElementSibling;
    if (banner && banner.style && banner.style.background === '#0d180d') banner.remove();
  } catch(e) {
    if (typeof __debugLog === 'function') __debugLog('backfill merge skip error: ' + e.message);
  }

  // Re-render first card with split_bolus metadata (shows the ⟂ pill, updated totals)
  var cardEl = document.getElementById('bfc-' + idxA);
  if (cardEl) {
    var tmp = document.createElement('div');
    tmp.innerHTML = bfCardHTML(ea, idxA);
    var newCard = tmp.firstElementChild;
    cardEl.replaceWith(newCard);
    // Auto-expand so reviewer can add food items immediately
    setTimeout(function(){
      bfToggle(idxA);
    }, 50);
  }

  if (typeof __debugLog === 'function') __debugLog('backfill: merged split bolus ' + ea.time + '+' + eb.time + ' ' + totalCarbs + 'g ' + totalUnits + 'U delay=' + delayMins + 'm');
}
window.bfMergeSplitBolus = bfMergeSplitBolus;

// ── Dismiss split hint without merging ────────────────────────
function bfDismissSplitHint(idxA, idxB) {
  // Mark both events so they won't be paired again this session
  if (_bfQueue[idxA]) _bfQueue[idxA]._splitDismissed = true;
  if (_bfQueue[idxB]) _bfQueue[idxB]._splitDismissed = true;
  // Re-render — detection will skip dismissed pairs
  bfRenderQueue();
}
window.bfDismissSplitHint = bfDismissSplitHint;

// ── Card HTML ──────────────────────────────────────────────────
function bfCardHTML(ev, idx) {
  var PERIODS = {
    'Breakfast':        '#0d1820:#4a8fd4',
    'Morning snack':    '#0d180d:#40a870',
    'Lunch':            '#0d180d:#40a870',
    'Afternoon snack':  '#1a1008:#c08040',
    'Dinner':           '#1a1008:#c08040',
    'Evening snack':    '#180d1a:#906090',
    'Bedtime snack':    '#180d1a:#906090',
    'Overnight':        '#0d0d1a:#6060a0',
    'Unknown':          '#1a1a1a:#666'
  };
  var parts  = (PERIODS[ev.period] || PERIODS.Unknown).split(':');
  var pbg    = parts[0], pco = parts[1];

  // Event type — stored in notes field from new seeder, fallback to inferring
  var evType = ev.notes && ['bolus','correction','free','hypo','snack'].indexOf(ev.notes) >= 0
    ? ev.notes
    : (ev.units > 0 && ev.carbs_device > 0 ? 'bolus'
      : ev.units > 0 ? 'correction' : 'free');
  // Migrate legacy 'free' → show as 'free' (still handled below); new entries use 'hypo' or 'snack'

  var TYPE_LABELS = {
    bolus:      {label:'meal',        col:'#4a8fd4', bg:'#0d1820'},
    correction: {label:'correction',  col:'#b07820', bg:'#1a1008'},
    hypo:       {label:'hypo',        col:'#c0392b', bg:'#1a0808'},
    snack:      {label:'snack',       col:'#906090', bg:'#180d1a'},
    free:       {label:'no insulin',  col:'#906090', bg:'#180d1a'},  // legacy
  };
  var tInfo = TYPE_LABELS[evType] || TYPE_LABELS.bolus;

  var items       = ev.items || [];
  var totalLogged = items.reduce(function(s,i){ return s+(parseFloat(i.carbs)||0); }, 0);
  var carbDiff    = ev.carbs_device && totalLogged > 0 ? Math.abs(totalLogged - ev.carbs_device) : null;
  var diffWarning = carbDiff && carbDiff > 2
    ? '<span style="color:#b07820;font-size:11px"> ⚠ ' + totalLogged.toFixed(1) + 'g logged vs ' + ev.carbs_device + 'g device</span>'
    : '';
  // Auto-fill wait_mins from BG rule if not already set
  if (ev.wait_mins == null && evType === 'bolus' && ev.pre_bg != null) {
    ev.wait_mins = _bfAutoWait(ev.pre_bg);
  }
  var waitHint   = ev.wait_src === 'written' ? '✓ written'
    : ev.wait_mins != null ? '≈ ' + ev.wait_mins + 'm · BG rule' : '';
  var statusCol  = ev.status==='approved'?'#1d9e72':ev.status==='flagged'?'#c0392b':'#555';
  var borderLeft = ev.status==='approved'?'border-left:3px solid #1d9e72'
    : ev.status==='flagged'?'border-left:3px solid #c0392b':'border-left:3px solid #26262f';

  // Header summary differs by type
  var headerCarbs = evType === 'correction'
    ? '<span style="font-size:11px;color:#b07820;min-width:50px">BG corr.</span>'
    : '<span style="font-size:14px;font-weight:600;color:#e8e4dc;min-width:50px">' + (ev.carbs_device||'?') + 'g</span>';

  var headerUnits = ev.units
    ? '<span style="font-size:11px;color:#555;flex:1">' + ev.units + 'U' + (ev.ic_ratio?' · 1:'+ev.ic_ratio:'') + '</span>'
    : '<span style="font-size:11px;color:#555;flex:1">no insulin</span>';

  // Left panel content — differs by type
  var leftPanel;
  if (evType === 'correction') {
    leftPanel = [
      '<div style="padding:12px;background:#1a1008;border-radius:6px;margin-bottom:10px">',
        '<div style="font-size:11px;color:#b07820;margin-bottom:4px">Correction bolus — no food logged</div>',
        '<div style="font-size:11px;color:#555">BG was ' + (ev.pre_bg||'?') + ' mmol/L · ' + ev.units + 'U delivered</div>',
      '</div>',
      // Notes only — no items
      '<textarea id="bfn-' + idx + '" placeholder="context, reason for correction…" onchange="bfUpdateNotes(' + idx + ',this.value)" ',
        'style="font-family:inherit;font-size:12px;width:100%;border:1px solid #26262f;border-radius:4px;padding:5px 8px;background:#0c0c0f;color:#e8e4dc;resize:vertical;min-height:44px;box-sizing:border-box">' + (ev.notes&&ev.notes!=='correction'?ev.notes:'') + '</textarea>',
      '<div style="display:flex;gap:8px;margin-top:8px">',
        '<button onclick="bfApprove(' + idx + ')" style="font-family:inherit;font-size:12px;padding:6px 14px;border:1px solid #1d9e72;border-radius:5px;background:transparent;color:#1d9e72;cursor:pointer;font-weight:600">approve</button>',
        '<button onclick="bfFlag(' + idx + ')" style="font-family:inherit;font-size:12px;padding:6px 14px;border:1px solid #c0392b;border-radius:5px;background:transparent;color:#c0392b;cursor:pointer">flag</button>',
        '<button onclick="bfSkip(' + idx + ')" style="font-family:inherit;font-size:12px;padding:6px 14px;border:1px solid #26262f;border-radius:5px;background:transparent;color:#555;cursor:pointer">skip →</button>',
      '</div>',
    ].join('');
  } else {
    // bolus, hypo, snack, or legacy free — show food items
    var isHypo  = evType === 'hypo';
    var isSnack = evType === 'snack' || evType === 'free';
    var itemsLabel = isHypo
      ? '<span style="color:#c0392b">⚡ hypo treatment</span>' + (diffWarning ? ' ' + diffWarning : '')
      : isSnack
      ? 'snack items · no insulin given' + (diffWarning ? ' ' + diffWarning : '')
      : 'food items · carbs per item'   + (diffWarning ? ' ' + diffWarning : '');
    leftPanel = [
      '<div id="bfsugg-' + idx + '" style="margin-bottom:8px"></div>',
      '<div style="font-size:10px;color:#555;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px">' + itemsLabel + '</div>',
      '<div id="bfi-' + idx + '">',
        items.map(function(item, ii){ return bfItemRow(idx, ii, item); }).join(''),
      '</div>',
      '<button onclick="bfAddItem(' + idx + ')" style="font-family:inherit;font-size:11px;color:#555;border:1px dashed #26262f;border-radius:4px;padding:3px 8px;cursor:pointer;background:none;margin-top:4px;width:100%;text-align:left">+ add item</button>',

      // Wait time — only meaningful for bolus events
      evType === 'bolus' ? [
        '<div style="display:flex;align-items:center;gap:8px;margin-top:10px">',
          '<span style="font-size:11px;color:#555;min-width:70px;text-transform:uppercase;letter-spacing:0.05em">bolus wait</span>',
          '<input type="number" min="0" max="60" step="5" id="bfw-' + idx + '" value="' + (ev.wait_mins!=null?ev.wait_mins:'') + '" placeholder="mins" onchange="bfUpdateWait(' + idx + ',this.value)" style="font-family:inherit;font-size:12px;width:60px;border:1px solid #26262f;border-radius:4px;padding:3px 6px;background:#0c0c0f;color:#e8e4dc;text-align:center">',
          '<span style="font-size:11px;color:#555">' + waitHint + '</span>',
        '</div>',
      ].join('') : '',

      '<textarea id="bfn-' + idx + '" placeholder="' + (isHypo ? 'symptoms, cause, recovery time\u2026' : 'notes, unknowns, context\u2026') + '" onchange="bfUpdateNotes(' + idx + ',this.value)" ',
        'style="font-family:inherit;font-size:12px;width:100%;margin-top:8px;border:1px solid #26262f;border-radius:4px;padding:5px 8px;background:#0c0c0f;color:#e8e4dc;resize:vertical;min-height:44px;box-sizing:border-box">' + (ev.notes&&['bolus','correction','free','hypo','snack'].indexOf(ev.notes)<0?ev.notes:'') + '</textarea>',

      '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">',
        '<button onclick="bfApprove(' + idx + ')" style="font-family:inherit;font-size:12px;padding:6px 14px;border:1px solid #1d9e72;border-radius:5px;background:transparent;color:#1d9e72;cursor:pointer;font-weight:600">approve</button>',
        '<button onclick="bfFlag(' + idx + ')" style="font-family:inherit;font-size:12px;padding:6px 14px;border:1px solid #c0392b;border-radius:5px;background:transparent;color:#c0392b;cursor:pointer">flag</button>',
        '<button onclick="bfSkip(' + idx + ')" style="font-family:inherit;font-size:12px;padding:6px 14px;border:1px solid #26262f;border-radius:5px;background:transparent;color:#555;cursor:pointer">skip →</button>',
      '</div>',
    ].join('');
  }

  // Split bolus pill — shown when ev.split_bolus is set (after merge)
  var splitPill = ev.split_bolus
    ? '<span title="Split bolus: ' + ev.split_bolus.u1 + 'U at ' + (ev.time||'') + ' + ' + ev.split_bolus.u2 + 'U at ' + ev.split_bolus.time2 + '" ' +
        'style="font-size:9px;font-weight:700;padding:2px 7px;border-radius:3px;background:#0d180d;color:#40a870;border:1px solid #40a87055;letter-spacing:0.04em;white-space:nowrap">' +
        '⟂ +' + ev.split_bolus.delay_mins + 'm' +
      '</span>'
    : '';

  // Split bolus dose rows for the right-panel meta grid
  var splitMetaRows = ev.split_bolus ? [
    ['1st dose', ev.split_bolus.u1 + 'U @ ' + (ev.time||'—')],
    ['2nd dose', ev.split_bolus.u2 + 'U @ ' + ev.split_bolus.time2 + ' (+' + ev.split_bolus.delay_mins + 'm)'],
  ] : [];

  return [
    '<div id="bfc-' + idx + '" style="background:#141418;border:1px solid ' + (ev.split_bolus ? '#40a87044' : '#26262f') + ';border-radius:8px;margin-bottom:10px;overflow:hidden;' + borderLeft + '">',

      // Header — tap to expand
      '<div onclick="bfToggle(' + idx + ')" style="display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer">',
        '<span style="font-size:11px;color:#555;min-width:76px">' + ev.date + '</span>',
        '<span style="font-size:11px;color:#555;min-width:40px">' + (ev.time||'?') + '</span>',
        '<span style="font-size:9px;font-weight:700;padding:2px 6px;border-radius:3px;background:' + tInfo.bg + ';color:' + tInfo.col + ';min-width:52px;text-align:center;text-transform:uppercase;letter-spacing:0.05em">' + tInfo.label + '</span>',
        splitPill,
        // Period selector — dropdown select; hide for correction
        evType !== 'correction' ? (function(){
          var selOpts = _BF_PERIODS_LIST.map(function(p){
            var s = _BF_PERIOD_STYLES[p] || {bg:'#1a1a1a',col:'#666'};
            return '<option value="' + p + '"' + (p===(ev.period||'Unknown')?' selected':'') + '>' + p + '</option>';
          }).join('');
          return '<select id="bfperiod-' + idx + '" onchange="bfSetPeriod(' + idx + ',this.value)" onclick="event.stopPropagation()" ' +
            'style="font-family:inherit;font-size:9px;font-weight:600;padding:2px 4px;border-radius:3px;background:' + pbg + ';color:' + pco + ';border:1px solid ' + pco + '33;text-transform:uppercase;letter-spacing:0.04em;cursor:pointer;outline:none;appearance:none;-webkit-appearance:none;min-width:80px">' +
            selOpts + '</select>';
        })() : '',
        headerCarbs,
        headerUnits,
        ev.peak_bg ? '<span style="font-size:11px;color:' + (ev.peak_bg>12?'#c0392b':ev.peak_bg>10?'#b07820':'#1d9e72') + '">↑' + ev.peak_bg + ' +' + ev.peak_mins + 'm</span>' : '',
        '<span style="font-size:10px;color:' + statusCol + ';margin-left:auto">' + ev.status + '</span>',
      '</div>',

      // Expandable detail
      '<div id="bfd-' + idx + '" style="display:none;padding:0 12px 12px;border-top:1px solid #26262f">',
        '<div style="display:grid;grid-template-columns:1fr 200px;gap:12px;margin-top:10px">',

          '<div>' + leftPanel + '</div>',

          // Right: CGM + meta
          '<div>',
            '<canvas id="bfcgm-' + idx + '" style="width:100%;height:130px;display:block;border-radius:4px"></canvas>',
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 8px;margin-top:8px">',
              [
                ['pre-BG', ev.pre_bg ? ev.pre_bg+' mmol' : '—'],
                ['units',  ev.units  ? ev.units+'U'      : 'none'],
                ['peak',   ev.peak_bg  || '—'],
                ['peak at',ev.peak_mins ? '+'+ev.peak_mins+'m' : '—'],
                ['I:C',    ev.ic_ratio  ? '1:'+ev.ic_ratio    : '—'],
                ['src',    ev.src       || '—'],
              ].concat(splitMetaRows).map(function(row) {
                return '<div style="display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px solid #1a1a1e;font-size:11px">' +
                  '<span style="color:#555">' + row[0] + '</span>' +
                  '<span style="font-weight:500;color:' + (row[2]||'#e8e4dc') + '">' + row[1] + '</span></div>';
              }).join(''),
            '</div>',
          '</div>',

        '</div>',
      '</div>',
    '</div>',
  ].join('');
}

// ── Auto bolus wait from pre_bg ───────────────────────────────
function _bfAutoWait(pre_bg) {
  // Rules: bg < 5.0 → 0 min, 5.0–6.0 → 10 min, > 6.0 → 15 min
  if (pre_bg == null) return null;
  if (pre_bg < 5.0)  return 0;
  if (pre_bg <= 6.0) return 10;
  return 15;
}

// ── Library lookup (name + alias aware) ───────────────────────
function _bfLibLookup(name) {
  if (!name) return null;
  var lname = name.toLowerCase();
  var combined = [].concat(
    typeof FOOD_LIBRARY !== 'undefined' ? FOOD_LIBRARY : [],
    typeof FOOD_DB      !== 'undefined' ? FOOD_DB      : []
  );
  // Exact name match first
  var match = combined.find(function(f){ return (f.name||'').toLowerCase() === lname; });
  if (match) return match;
  // Alias match
  return combined.find(function(f){
    return Array.isArray(f.aliases) && f.aliases.some(function(a){ return a.toLowerCase() === lname; });
  }) || null;
}

// ── Item row ───────────────────────────────────────────────────
function bfItemRow(cardIdx, itemIdx, item) {
  var name  = (item.library_name || item.name || item.raw_name || '').replace(/"/g,'&quot;');
  var carbs = item.carbs != null ? parseFloat(item.carbs).toFixed(1) : '';
  var c100  = item.c100  != null ? parseFloat(item.c100).toFixed(1)  : '';

  // Resolve against library — catches alias matches too
  var libMatch = _bfLibLookup(name);
  if (libMatch) {
    if (!c100 && libMatch.c100) c100 = parseFloat(libMatch.c100).toFixed(1);
  }

  var inLibrary = !!libMatch;

  // Sub-row shown beneath when not in library: "+lib" and "this is actually…"
  // Rendered as a second flex row so it doesn't crowd the main item row
  var subRow = '';
  if (name && !inLibrary) {
    var enc = encodeURIComponent(name);
    subRow = '<div style="display:flex;align-items:center;gap:8px;padding:0 0 4px 4px">' +
      '<span onclick="bfOpenAddToLib(\'' + cardIdx + '\',\'' + itemIdx + '\',decodeURIComponent(\'' + enc + '\'))" ' +
        'style="font-size:9px;color:#40a870;cursor:pointer;text-decoration:underline;text-decoration-color:#40a87055;white-space:nowrap" ' +
        'onmouseover="this.style.color=\'#5ed09a\'" onmouseout="this.style.color=\'#40a870\'">+ add to library</span>' +
      '<span style="font-size:9px;color:#333">\u00b7</span>' +
      '<span onclick="bfShowAliasFor(\'' + cardIdx + '\',\'' + itemIdx + '\',decodeURIComponent(\'' + enc + '\'))" ' +
        'style="font-size:9px;color:#555;cursor:pointer;font-style:italic;text-decoration:underline;text-decoration-color:#333" ' +
        'onmouseover="this.style.color=\'#4a8fd4\'" onmouseout="this.style.color=\'#555\'">this is actually\u2026</span>' +
    '</div>';
  }

  // GI hint — updates live via bfUpdateGIHint without re-rendering the row
  var giCol  = item.gi ? (item.gi>=70?'#c0392b':item.gi>=55?'#b07820':'#1d9e72') : '#333';
  var giText = item.gi ? 'GI ' + item.gi : 'GI?';

  return [
    // bfi-row-wrap — class used by _bfRenderItemRow to target single rows
    '<div class="bfi-row-wrap" style="margin-bottom:' + (subRow?'0':'6px') + '">',
      '<div style="display:flex;align-items:center;gap:6px">',
        '<div style="flex:1;position:relative">',
          '<input style="font-family:inherit;font-size:12px;width:100%;border:1px solid #26262f;border-radius:4px;padding:3px 6px;background:#0c0c0f;color:#e8e4dc" ',
            'value="' + name + '" placeholder="food name\u2026" autocomplete="off" ',
            'oninput="bfNameInput(' + cardIdx + ',' + itemIdx + ',this)" ',
            'onblur="bfNameBlur(' + cardIdx + ',' + itemIdx + ',this)">',
          '<div id="bfac-' + cardIdx + '-' + itemIdx + '" style="position:absolute;left:0;right:0;background:#1c1c22;border:1px solid #26262f;border-radius:4px;z-index:600;display:none"></div>',
        '</div>',
        // c100 — oninput updates GI hint in-place without re-render
        '<div style="display:flex;flex-direction:column;align-items:center;gap:1px">',
          '<input type="number" step="0.1" min="0" max="100" value="' + c100 + '" placeholder="\u2014" ',
            'title="carbs per 100g \u2014 saved to food library" ',
            'onchange="bfUpdateItem(' + cardIdx + ',' + itemIdx + ',\'c100\',this.value)" ',
            'oninput="bfUpdateGIHint(' + cardIdx + ',' + itemIdx + ',this.value)" ',
            'style="font-family:inherit;font-size:11px;width:44px;text-align:right;border:1px solid ' + (!c100?'#4a2800':'#26262f') + ';border-radius:4px;padding:2px 5px;background:#0c0c0f;color:' + (!c100?'#b07820':'#e8e4dc') + '">',
          '<span style="font-size:8px;color:#333;line-height:1">/100g</span>',
        '</div>',
        '<span id="bfgi-' + cardIdx + '-' + itemIdx + '" style="font-size:8px;color:' + giCol + ';min-width:28px;text-align:center" title="glycaemic index">' + giText + '</span>',
        // Portion / weight — derived from carbs ÷ c100 × 100; editable
        '<div style="display:flex;flex-direction:column;align-items:center;gap:1px">',
          '<input type="number" step="1" min="0" value="' + (carbs && c100 ? Math.round(parseFloat(carbs)/parseFloat(c100)*100) : '') + '" placeholder="g" ',
            'title="portion weight (g) — updates carbs automatically" ',
            'oninput="bfPortionInput(' + cardIdx + ',' + itemIdx + ',this.value)" ',
            'style="font-family:inherit;font-size:11px;width:44px;text-align:right;border:1px solid #1a1a22;border-radius:4px;padding:2px 5px;background:#0c0c0f;color:#888">',
          '<span style="font-size:8px;color:#333;line-height:1">wt g</span>',
        '</div>',
        // carbs (g) — labelled
        '<div style="display:flex;flex-direction:column;align-items:center;gap:1px">',
          '<input type="number" step="0.1" value="' + carbs + '" placeholder="g" ',
            'title="total carbs for this portion" ',
            'onchange="bfUpdateItem(' + cardIdx + ',' + itemIdx + ',\'carbs\',this.value);bfUpdatePortionFromCarbs(' + cardIdx + ',' + itemIdx + ')" ',
            'style="font-family:inherit;font-size:12px;width:52px;text-align:right;border:1px solid ' + (!carbs?'#4a1a1a':'#26262f') + ';border-radius:4px;padding:3px 6px;background:#0c0c0f;color:#e8e4dc">',
          '<span style="font-size:8px;color:#555;line-height:1">carbs g</span>',
        '</div>',
        '<button onclick="bfDelItem(' + cardIdx + ',' + itemIdx + ')" style="font-family:inherit;background:none;border:none;color:#555;cursor:pointer;font-size:15px;padding:0 2px">\u00d7</button>',
      '</div>',
      subRow,
    '</div>',
  ].join('');
}

// ── GI hint update — fires on c100 oninput, no re-render ──────
function bfUpdateGIHint(cardIdx, itemIdx, c100val) {
  var span = document.getElementById('bfgi-' + cardIdx + '-' + itemIdx);
  if (!span) return;
  var c100 = parseFloat(c100val);
  if (isNaN(c100) || c100 <= 0) { span.textContent = 'GI?'; span.style.color = '#333'; return; }
  // Lookup GI from item state, or estimate from category
  var items = _bfQueue[cardIdx] && _bfQueue[cardIdx].items;
  var item  = items && items[itemIdx];
  var gi    = item && item.gi;
  if (!gi && item && item.name && typeof _giFromCategory === 'function' && typeof _categoryFromName === 'function') {
    var cat = _categoryFromName(item.name.toLowerCase());
    gi = _giFromCategory(cat, item.name.toLowerCase()).gi;
  }
  if (!gi) { span.textContent = 'GI?'; span.style.color = '#333'; return; }
  var col = gi >= 70 ? '#c0392b' : gi >= 55 ? '#b07820' : '#1d9e72';
  span.textContent = 'GI ' + gi;
  span.style.color = col;
  span.title = 'GI ' + gi + ' · GL ' + (gi * c100 / 100).toFixed(1);
}
window.bfUpdateGIHint = bfUpdateGIHint;

// ── Portion weight helpers ─────────────────────────────────────
// When weight input changes → recalculate carbs from c100
function bfPortionInput(cardIdx, itemIdx, wtVal) {
  var wt = parseFloat(wtVal);
  if (isNaN(wt) || wt <= 0) return;
  var items = _bfQueue[cardIdx] && _bfQueue[cardIdx].items;
  var item  = items && items[itemIdx];
  if (!item) return;
  var c100 = parseFloat(item.c100);
  if (isNaN(c100) || c100 <= 0) return;
  var carbs = +(wt * c100 / 100).toFixed(1);
  item.carbs = carbs;
  // Update carbs input live — target the second number input in this row
  var container = document.getElementById('bfi-' + cardIdx);
  if (!container) return;
  var rows = container.querySelectorAll('.bfi-row-wrap');
  var row  = rows[itemIdx];
  if (!row) return;
  // Carbs input is the second number input (first is c100, then portion wt, then carbs)
  var numInputs = row.querySelectorAll('input[type=number]');
  // Layout: c100(idx0), portion-wt(idx1), carbs(idx2)
  var carbsInp = numInputs[2];
  if (carbsInp) {
    carbsInp.value = carbs;
    carbsInp.style.borderColor = '#26262f';
    carbsInp.style.color = '#e8e4dc';
  }
}
window.bfPortionInput = bfPortionInput;

// When carbs changed manually → back-calculate and update weight input
function bfUpdatePortionFromCarbs(cardIdx, itemIdx) {
  var items = _bfQueue[cardIdx] && _bfQueue[cardIdx].items;
  var item  = items && items[itemIdx];
  if (!item) return;
  var c100  = parseFloat(item.c100);
  var carbs = parseFloat(item.carbs);
  if (isNaN(c100) || c100 <= 0 || isNaN(carbs)) return;
  var wt = Math.round(carbs / c100 * 100);
  var container = document.getElementById('bfi-' + cardIdx);
  if (!container) return;
  var rows     = container.querySelectorAll('.bfi-row-wrap');
  var row      = rows[itemIdx];
  if (!row) return;
  var numInputs = row.querySelectorAll('input[type=number]');
  var wtInp     = numInputs[1]; // portion weight is index 1
  if (wtInp) wtInp.value = wt;
}
window.bfUpdatePortionFromCarbs = bfUpdatePortionFromCarbs;

// ── Name blur — re-resolve against library after manual edit ──
function bfNameBlur(cardIdx, itemIdx, input) {
  var name = (input.value || '').trim();
  if (!name) return;

  bfUpdateItem(cardIdx, itemIdx, 'name', name);

  var match = _bfLibLookup(name);
  if (match) {
    var items = _bfQueue[cardIdx] && _bfQueue[cardIdx].items;
    if (items && items[itemIdx]) {
      if (match.c100)   items[itemIdx].c100   = match.c100;
      if (match.gi)     items[itemIdx].gi     = match.gi;
      if (match.gi_cat) items[itemIdx].gi_cat = match.gi_cat;
      if ((match.name||'').toLowerCase() !== name.toLowerCase()) {
        items[itemIdx].name = match.name;
      }
    }
    // Re-render only this row — preserves other rows' in-progress edits
    _bfRenderItemRow(cardIdx, itemIdx);
  }
  // No match: skip re-render — debounce timer will show bfShowInlineNew
}
window.bfNameBlur = bfNameBlur;

// ── Toggle expand ──────────────────────────────────────────────
function bfToggle(idx) {
  var det = document.getElementById('bfd-' + idx);
  if (!det) return;
  var open = det.style.display !== 'none';
  det.style.display = open ? 'none' : 'block';
  if (!open) {
    setTimeout(function(){ bfDrawCGM(idx, _bfQueue[idx] && _bfQueue[idx].cgm_curve); }, 30);
    bfSuggestCandidates(idx);
  }
}
window.bfToggle = bfToggle;

// ── Confidence-scored candidate suggestions ─────────────────────
// Reuses _matchGhostToMealHistory (app.js) — the same shape/timing/
// time-of-day scoring used for ghost/unannounced-meal detection — applied
// to this row's already-known cgm_curve instead of a live residual. Matches
// against ANY previously-approved meal_history row with actual_curve set,
// backfill or live, so candidates genuinely mature as the queue is worked
// through in order: row 50's suggestion benefits from rows 1-49 having
// already been confirmed, exactly as requested.
//
// Only meaningful for bolus/snack/hypo cards with unconfirmed item names —
// skipped for correction cards (no food to suggest) and for rows where every
// item already has a name typed in (nothing left to suggest).
async function bfSuggestCandidates(idx) {
  var ev = _bfQueue[idx];
  if (!ev || typeof _matchGhostToMealHistory !== 'function') return;

  var evType = ev.notes && ['bolus','correction','free','hypo','snack'].indexOf(ev.notes) >= 0
    ? ev.notes
    : (ev.units > 0 && ev.carbs_device > 0 ? 'bolus' : ev.units > 0 ? 'correction' : 'snack');
  if (evType === 'correction') return;

  var hasUnnamed = (ev.items||[]).some(function(i){ return !i.name || !i.name.trim(); }) || !ev.items || !ev.items.length;
  if (!hasUnnamed) return; // every item already identified — nothing to suggest

  var box = document.getElementById('bfsugg-' + idx);
  if (!box) return; // card not using the suggestion-box layout (shouldn't happen post-render, but be safe)
  box.innerHTML = '<div style="font-size:10px;color:#555;padding:4px 0">checking past meals…</div>';

  try {
    var cgm = _bfNormaliseCurve(ev.cgm_curve, ev.t);
    if (cgm.length < 4) { box.innerHTML = ''; return; }
    var postCgm = cgm.filter(function(p){ return p.m > 0; });
    var peakPt  = postCgm.length ? postCgm.reduce(function(a,b){ return b.bg>a.bg?b:a; }) : null;
    var estCarbs = ev.carbs_device || 0;

    var candidates = await _matchGhostToMealHistory(postCgm.length ? postCgm : cgm, peakPt ? peakPt.m : 60, estCarbs, ev.t, 0);
    if (!candidates || !candidates.length) { box.innerHTML = ''; return; }

    // Only surface candidates worth showing — same bar as the unannounced-
    // meals UI elsewhere in the app, avoid suggesting noise when the queue
    // hasn't matured enough yet to have a good match.
    var shown = candidates.filter(function(c){ return c.confidence >= 0.35; }).slice(0,3);
    if (!shown.length) { box.innerHTML = ''; return; }

    box.innerHTML = '<div style="font-size:10px;color:#555;margin-bottom:4px">similar past meals — tap to fill items</div>' +
      '<div style="display:flex;flex-direction:column;gap:4px">' +
      shown.map(function(c) {
        var pct = Math.round(c.confidence * 100);
        var col = pct >= 65 ? '#1d9e72' : pct >= 45 ? '#b07820' : '#555';
        return '<div onclick="bfApplyCandidate(' + idx + ',' + JSON.stringify(JSON.stringify(c.items||[])) + ')" ' +
          'style="display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid ' + col + '44;border-radius:5px;cursor:pointer;background:' + col + '11">' +
          '<span style="font-size:9px;font-weight:700;color:' + col + ';min-width:32px">' + pct + '%</span>' +
          '<span style="font-size:11px;color:#e8e4dc;flex:1">' + (c.name||'meal') + (c.total_carbs?' · '+c.total_carbs+'g':'') + '</span>' +
          (c.gram_warning ? '<span style="font-size:9px;color:#b07820">⚠ qty differs</span>' : '') +
          '</div>';
      }).join('') +
      '</div>';
  } catch(e) {
    box.innerHTML = '';
    if (typeof __debugLog === 'function') __debugLog('backfill: suggestion match failed: ' + e.message);
  }
}
window.bfSuggestCandidates = bfSuggestCandidates;

// Apply a suggested candidate's items onto this card's item rows, then let
// the user confirm/edit/add carbs precisely (food name is the part that
// genuinely repeats across days; quantities still need a human check since
// portion size is exactly what gram_warning flags as uncertain).
function bfApplyCandidate(idx, itemsJSON) {
  var ev = _bfQueue[idx];
  if (!ev) return;
  var items;
  try { items = JSON.parse(itemsJSON); } catch(e) { return; }
  if (!Array.isArray(items) || !items.length) return;

  ev.items = items.map(function(i){
    return { name: i.name || '', carbs: i.carbs != null ? i.carbs : null, gi: i.gi || null, grams: i.grams || i.g || null };
  });

  var container = document.getElementById('bfi-' + idx);
  if (container) container.innerHTML = ev.items.map(function(it,ii){ return bfItemRow(idx, ii, it); }).join('');
  var box = document.getElementById('bfsugg-' + idx);
  if (box) box.innerHTML = '';
}
window.bfApplyCandidate = bfApplyCandidate;

// ── Period constants ───────────────────────────────────────────
var _BF_PERIODS_LIST = ['Breakfast','Morning snack','Lunch','Afternoon snack','Dinner','Evening snack','Bedtime snack','Overnight','Unknown'];
var _BF_PERIOD_STYLES = {
  'Breakfast':        {bg:'#0d1820',col:'#4a8fd4'},
  'Morning snack':    {bg:'#0d180d',col:'#40a870'},
  'Lunch':            {bg:'#0d180d',col:'#40a870'},
  'Afternoon snack':  {bg:'#1a1008',col:'#c08040'},
  'Dinner':           {bg:'#1a1008',col:'#c08040'},
  'Evening snack':    {bg:'#180d1a',col:'#906090'},
  'Bedtime snack':    {bg:'#180d1a',col:'#906090'},
  'Overnight':        {bg:'#0d0d1a',col:'#6060a0'},
  'Unknown':          {bg:'#1a1a1a',col:'#666'},
};

// ── Set period / meal type label from dropdown ─────────────────
function bfSetPeriod(idx, period) {
  var ev = _bfQueue[idx];
  if (!ev) return;
  ev.period = period;
  // Update select styling to match chosen period colour
  var sel = document.getElementById('bfperiod-' + idx);
  if (sel) {
    var style = _BF_PERIOD_STYLES[period] || _BF_PERIOD_STYLES.Unknown;
    sel.style.background = style.bg;
    sel.style.color = style.col;
    sel.style.borderColor = style.col + '33';
  }
  // Persist immediately — PATCH backfill_queue
  _bfFetch('backfill_queue?t=eq.' + ev.t, {
    method: 'PATCH', prefer: 'return=minimal', body: { period: period }
  }).catch(function(e){ if (typeof __debugLog === 'function') __debugLog('backfill period update error: ' + e.message); });
}
window.bfSetPeriod = bfSetPeriod;

// ── CGM sparkline ──────────────────────────────────────────────
function bfDrawCGM(idx, cgm) {
  var cv = document.getElementById('bfcgm-' + idx);
  if (!cv || !cgm || !cgm.length) return;
  var W = cv.width = cv.offsetWidth || 200, H = cv.height = 130;
  var ctx = cv.getContext('2d');
  ctx.clearRect(0,0,W,H);
  var pad = {l:24,r:6,t:6,b:16};

  // New data format: {t: unix_ms, v: mmol} — convert to relative minutes from event time
  var ev = _bfQueue[idx];
  var evT = ev ? ev.t : null;
  var pts = cgm.map(function(p) {
    // Support both old format (p.m/p.bg) and new format (p.t/p.v)
    var mins = p.m != null ? p.m : (evT ? Math.round((p.t - evT) / 60000) : 0);
    var val  = p.bg != null ? p.bg : p.v;
    return {m: mins, v: val};
  }).filter(function(p){ return p.v != null; });

  if (!pts.length) return;

  var ms  = pts.map(function(p){return p.m;});
  var vs  = pts.map(function(p){return p.v;});
  var mn  = Math.min.apply(null, ms);
  var mx  = Math.max.apply(null, ms);
  var mV  = Math.min(3,  Math.min.apply(null, vs));
  var xV  = Math.max(12, Math.max.apply(null, vs));
  var xs  = function(m){ return (m-mn)/(mx-mn)*(W-pad.l-pad.r)+pad.l; };
  var ys  = function(v){ return H-pad.b-(v-mV)/(xV-mV)*(H-pad.t-pad.b); };

  // BG threshold lines
  [[4,'rgba(192,57,43,0.35)'],[7,'rgba(255,255,255,0.07)'],[10,'rgba(176,120,32,0.35)']].forEach(function(r){
    ctx.beginPath(); ctx.strokeStyle=r[1]; ctx.lineWidth=0.5; ctx.setLineDash([3,4]);
    ctx.moveTo(pad.l,ys(r[0])); ctx.lineTo(W-pad.r,ys(r[0])); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle='rgba(180,180,180,0.35)'; ctx.font='9px monospace';
    ctx.fillText(r[0],2,ys(r[0])+3);
  });

  // T=0 vertical line — the event time
  if (mn <= 0 && mx >= 0) {
    var x0 = xs(0);
    ctx.beginPath(); ctx.strokeStyle='rgba(74,143,212,0.6)'; ctx.lineWidth=1.5; ctx.setLineDash([2,3]);
    ctx.moveTo(x0,pad.t); ctx.lineTo(x0,H-pad.b); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle='rgba(74,143,212,0.7)'; ctx.font='8px monospace';
    ctx.fillText(ev ? ev.time : '0', x0-8, pad.t+8);
  }

  // CGM line
  ctx.beginPath();
  pts.forEach(function(p,i){ i===0?ctx.moveTo(xs(p.m),ys(p.v)):ctx.lineTo(xs(p.m),ys(p.v)); });
  ctx.strokeStyle='#4a8fd4'; ctx.lineWidth=1.5; ctx.stroke();

  // Dots — red if hypo or high
  pts.forEach(function(p){
    ctx.beginPath(); ctx.arc(xs(p.m),ys(p.v),1.5,0,Math.PI*2);
    ctx.fillStyle=p.v>=10?'#c0392b':p.v<=4?'#c0392b':'#4a8fd4';
    ctx.fill();
  });

  // X-axis labels: -120, -60, 0, +60, +120, +180
  [-120,-60,0,60,120,180].forEach(function(m){
    if(m>=mn-5&&m<=mx+5){
      ctx.fillStyle='rgba(180,180,180,0.45)'; ctx.font='8px monospace';
      var label = m===0?'0':( m>0?'+'+m+'m':m+'m' );
      ctx.fillText(label, xs(m)-10, H-2);
    }
  });
}

// ── Autocomplete + inline-new-food + alias linking ─────────────

var _bfDebounceTimers = {};
var _bfInlineModes    = {}; // keyed "cardIdx-itemIdx"

function bfSearchFoods(q) {
  if (!q || q.length < 2) return [];
  var lq = q.toLowerCase();
  var combined = [].concat(
    typeof FOOD_LIBRARY !== 'undefined' ? FOOD_LIBRARY : [],
    typeof FOOD_DB      !== 'undefined' ? FOOD_DB      : []
  );
  // Match on name OR any alias
  return combined.filter(function(f){
    if ((f.name||'').toLowerCase().indexOf(lq) >= 0) return true;
    if (Array.isArray(f.aliases) && f.aliases.some(function(a){ return a.toLowerCase().indexOf(lq) >= 0; })) return true;
    return false;
  }).slice(0, 7);
}

function bfNameInput(cardIdx, itemIdx, input) {
  var ac = document.getElementById('bfac-' + cardIdx + '-' + itemIdx);
  if (!ac) return;
  var q = input.value;
  if (!q || q.length < 2) { ac.style.display = 'none'; return; }

  var results = bfSearchFoods(q);

  if (results.length > 0) {
    // Show matches immediately
    var matchHtml = results.map(function(f) {
      var enc    = encodeURIComponent(f.name);
      var c100d  = f.c100 ? f.c100 + '/100g' : '?';
      var giCol  = f.gi >= 70 ? '#c0392b' : f.gi >= 55 ? '#b07820' : '#1d9e72';
      var aliasMatch = Array.isArray(f.aliases) && f.aliases.some(function(a){ return a.toLowerCase().indexOf(q.toLowerCase()) >= 0; });
      return '<div onclick="bfSelectFood(' + cardIdx + ',' + itemIdx + ',decodeURIComponent(\'' + enc + '\'))" ' +
        'style="padding:6px 8px;cursor:pointer;border-bottom:1px solid #26262f;display:flex;align-items:center;gap:6px" ' +
        'onmouseover="this.style.background=\'#0d1820\'" onmouseout="this.style.background=\'\'">' +
        '<div style="flex:1">' +
          '<div style="font-size:12px;color:#e8e4dc">' + f.name + '</div>' +
          (aliasMatch ? '<div style="font-size:9px;color:#555;font-style:italic">alias match</div>' : '') +
        '</div>' +
        '<span style="font-size:10px;color:#555">' + c100d + '</span>' +
        (f.gi ? '<span style="font-size:9px;color:' + giCol + '">GI&nbsp;' + f.gi + '</span>' : '') +
      '</div>';
    }).join('');

    // "→ alias for…" at the bottom
    var aliasRow = '<div onclick="bfShowAliasFor(\'' + cardIdx + '\',\'' + itemIdx + '\',\'' + q.replace(/'/g,"\\'") + '\')" ' +
      'style="padding:5px 8px;cursor:pointer;border-top:1px solid #26262f;font-size:10px;color:#555;font-style:italic" ' +
      'onmouseover="this.style.color=\'#4a8fd4\'" onmouseout="this.style.color=\'#555\'">' +
      '→ \u201c' + q + '\u201d is an alias for\u2026</div>';

    // "Add as new" at the very bottom — always present so user can add "Butter" even when "Peanut butter" matched
    var addNewRow = '<div onclick="bfShowInlineNew(\'' + cardIdx + '\',\'' + itemIdx + '\',\'' + q.replace(/'/g,"\\'") + '\')" ' +
      'style="padding:5px 8px;cursor:pointer;border-top:1px solid #1a1a1e;font-size:10px;color:#40a870;display:flex;align-items:center;gap:5px" ' +
      'onmouseover="this.style.background=\'#0d180d\'" onmouseout="this.style.background=\'\'">' +
      '<span style="font-size:11px">+</span> add \u201c' + q + '\u201d as new library item</div>';

    ac.innerHTML = matchHtml + aliasRow + addNewRow;
    ac.style.top    = '100%';
    ac.style.bottom = 'auto';
    ac.style.display = 'block';
    // Flip above if list clips off bottom of viewport
    var rect = ac.getBoundingClientRect();
    if (rect.bottom > window.innerHeight - 20) {
      ac.style.top    = 'auto';
      ac.style.bottom = '100%';
    }

    // Cancel any pending inline-new debounce
    clearTimeout(_bfDebounceTimers[cardIdx + '-' + itemIdx]);
  } else {
    // No match — brief debounce then open the full-screen add-food modal
    ac.style.display = 'none';
    var key = cardIdx + '-' + itemIdx;
    clearTimeout(_bfDebounceTimers[key]);
    _bfDebounceTimers[key] = setTimeout(function() {
      bfShowInlineNew(cardIdx, itemIdx, q, ac);
    }, 500);
  }
}
window.bfNameInput = bfNameInput;

// ── New food entry — delegates entirely to app.js addCustomFood overlay ──
// All entry points funnel here. Sets window._foodAddCallback so saveCustomFood
// can write back into the backfill queue item and re-render the row.

function _bfOpenAddFoodModal(cardIdx, itemIdx, name) {
  if (typeof window.addCustomFood !== 'function') {
    if (typeof __debugLog === 'function') __debugLog('addCustomFood not available — app.js not loaded?');
    return;
  }
  // Close any open autocomplete dropdown for this item
  var ac = document.getElementById('bfac-' + cardIdx + '-' + itemIdx);
  if (ac) ac.style.display = 'none';

  // Callback: called by saveCustomFood after library save
  window._foodAddCallback = function(savedFood) {
    // Merge the saved food into the queue item
    if (_bfQueue[cardIdx]) {
      var items = _bfQueue[cardIdx].items || [];
      items[itemIdx] = Object.assign(items[itemIdx] || {}, {
        name:    savedFood.name,
        c100:    savedFood.c100,
        gi:      savedFood.gi,
        gi_cat:  savedFood.cat,
      });
      _bfQueue[cardIdx].items = items;
    }
    // Re-render only this row
    _bfRenderItemRow(cardIdx, itemIdx);
    if (typeof __debugLog === 'function') __debugLog('backfill: food "' + savedFood.name + '" saved via shared overlay c100=' + savedFood.c100);
  };

  window.addCustomFood(name);
}
window._bfOpenAddFoodModal = _bfOpenAddFoodModal;

// bfShowInlineNew — previously showed an inline dropdown form.
// Now opens the full-screen shared modal instead.
function bfShowInlineNew(cardIdx, itemIdx, q, ac) {
  if (ac) ac.style.display = 'none';
  _bfOpenAddFoodModal(cardIdx, itemIdx, q);
}
window.bfShowInlineNew = bfShowInlineNew;

// bfOpenAddToLib — "add to library" link from the sub-row.
function bfOpenAddToLib(cardIdx, itemIdx, name) {
  bfUpdateItem(cardIdx, itemIdx, 'name', name);
  _bfOpenAddFoodModal(cardIdx, itemIdx, name);
}
window.bfOpenAddToLib = bfOpenAddToLib;

// _bfOpenAddFoodModalInsert — used by the insert-item rows (bfInsertItemNameInput).
// Writes the saved food back to window._bfInsertItems[idx].
function _bfOpenAddFoodModalInsert(idx, name) {
  if (typeof window.addCustomFood !== 'function') return;
  window._foodAddCallback = function(savedFood) {
    if (window._bfInsertItems && window._bfInsertItems[idx]) {
      window._bfInsertItems[idx].name  = savedFood.name;
      window._bfInsertItems[idx].c100  = savedFood.c100;
      window._bfInsertItems[idx].gi    = savedFood.gi;
    }
    var nameInp = document.getElementById('bfins-name-' + idx);
    var c100Inp = document.getElementById('bfins-c100-' + idx);
    var giSpan  = document.getElementById('bfinsgi-'    + idx);
    if (nameInp) nameInp.value = savedFood.name;
    if (c100Inp && savedFood.c100) c100Inp.value = savedFood.c100;
    if (giSpan && savedFood.gi) {
      giSpan.textContent = 'GI ' + savedFood.gi;
      giSpan.style.color = savedFood.gi>=70?'#c0392b':savedFood.gi>=55?'#b07820':'#1d9e72';
    }
  };
  window.addCustomFood(name);
}
window._bfOpenAddFoodModalInsert = _bfOpenAddFoodModalInsert;

// ── Alias linking ──────────────────────────────────────────────
function bfShowAliasFor(cardIdx, itemIdx, alias) {
  var ac = document.getElementById('bfac-' + cardIdx + '-' + itemIdx);
  if (!ac) return;

  ac.innerHTML =
    '<div style="padding:8px 10px">' +
      '<div style="font-size:9px;color:#555;margin-bottom:6px;font-style:italic">\u201c' + alias + '\u201d is an alias for:</div>' +
      '<input id="bfalias-search-' + cardIdx + '-' + itemIdx + '" type="text" placeholder="type canonical name\u2026" autocomplete="off" ' +
        'oninput="bfAliasSearch(\'' + cardIdx + '\',\'' + itemIdx + '\',\'' + alias.replace(/'/g,"\\'") + '\',this.value)" ' +
        'style="width:100%;padding:5px 8px;border-radius:5px;border:1px solid #26262f;background:#0c0c0f;color:#e8e4dc;font-family:inherit;font-size:12px;outline:none;box-sizing:border-box">' +
      '<div id="bfalias-results-' + cardIdx + '-' + itemIdx + '" style="margin-top:4px"></div>' +
      '<button onclick="document.getElementById(\'bfac-' + cardIdx + '-' + itemIdx + '\').style.display=\'none\'" ' +
        'style="font-family:inherit;width:100%;margin-top:6px;padding:5px;border:1px solid #26262f;border-radius:5px;background:transparent;font-size:10px;color:#555;cursor:pointer">cancel</button>' +
    '</div>';

  ac.style.display = 'block';
  setTimeout(function(){
    var si = document.getElementById('bfalias-search-' + cardIdx + '-' + itemIdx);
    if (si) si.focus();
  }, 30);
}
window.bfShowAliasFor = bfShowAliasFor;

function bfAliasSearch(cardIdx, itemIdx, alias, q) {
  var res = document.getElementById('bfalias-results-' + cardIdx + '-' + itemIdx);
  if (!res) return;
  if (!q || q.length < 2) { res.innerHTML = ''; return; }
  var matches = bfSearchFoods(q);
  if (!matches.length) { res.innerHTML = '<div style="font-size:10px;color:#555;padding:5px 8px">no matches</div>'; return; }
  res.innerHTML = matches.map(function(f) {
    var enc = encodeURIComponent(f.name);
    return '<div onclick="bfLinkAlias(\'' + cardIdx + '\',\'' + itemIdx + '\',\'' + alias.replace(/'/g,"\\'") + '\',decodeURIComponent(\'' + enc + '\'))" ' +
      'style="padding:5px 8px;cursor:pointer;border-bottom:1px solid #26262f;font-size:12px;color:#e8e4dc" ' +
      'onmouseover="this.style.background=\'#0d1820\'" onmouseout="this.style.background=\'\'">' +
      f.name + '<span style="float:right;font-size:10px;color:#555">' + (f.c100||'?') + '/100g</span></div>';
  }).join('');
}
window.bfAliasSearch = bfAliasSearch;

function bfLinkAlias(cardIdx, itemIdx, alias, canonicalName) {
  // Attach alias to the canonical library entry and push
  if (typeof FOOD_LIBRARY !== 'undefined' && typeof saveFoodLibrary === 'function') {
    var canonical = FOOD_LIBRARY.find(function(f){ return (f.name||'').toLowerCase() === canonicalName.toLowerCase(); });
    if (canonical) {
      canonical.aliases = canonical.aliases || [];
      var aliaslc = alias.toLowerCase();
      if (!canonical.aliases.some(function(a){ return a.toLowerCase() === aliaslc; })) {
        canonical.aliases.push(alias);
      }
      saveFoodLibrary();
      if (typeof __debugLog === 'function') if (typeof __debugLog === 'function') __debugLog('backfill: alias "' + alias + '" \u2192 "' + canonicalName + '"');
    }
  }
  // Resolve this item to the canonical food (reuses bfSelectFood)
  bfSelectFood(cardIdx, itemIdx, canonicalName);
}
window.bfLinkAlias = bfLinkAlias;

function bfSelectFood(cardIdx, itemIdx, name) {
  var food = _bfLibLookup(name);
  if (!food || !_bfQueue[cardIdx]) return;
  var items = _bfQueue[cardIdx].items || [];
  var existing = items[itemIdx] || {};
  items[itemIdx] = {
    name:       food.name,
    library_id: food.id   || null,
    c100:       food.c100 || null,
    carbs:      existing.carbs || null,  // preserve existing total carbs
    gi:         food.gi   || null,
    gi_cat:     food.gi_cat || null,
  };
  _bfQueue[cardIdx].items = items;
  // Close autocomplete
  var ac = document.getElementById('bfac-' + cardIdx + '-' + itemIdx);
  if (ac) ac.style.display = 'none';
  // Re-render only the affected row — not the whole list
  _bfRenderItemRow(cardIdx, itemIdx);
}
window.bfSelectFood = bfSelectFood;

// Re-render a single item row in-place without touching other rows
function _bfRenderItemRow(cardIdx, itemIdx) {
  var items = _bfQueue[cardIdx] && _bfQueue[cardIdx].items;
  if (!items) return;
  // Find the row div by position within the container
  var container = document.getElementById('bfi-' + cardIdx);
  if (!container) return;
  var rows = container.querySelectorAll('.bfi-row-wrap');
  if (rows[itemIdx]) {
    rows[itemIdx].outerHTML = bfItemRow(cardIdx, itemIdx, items[itemIdx]);
  } else {
    // Fallback — full re-render (e.g. after add/delete)
    container.innerHTML = items.map(function(item,ii){ return bfItemRow(cardIdx,ii,item); }).join('');
  }
}

// ── Item mutations ─────────────────────────────────────────────
function bfUpdateItem(cardIdx, itemIdx, field, val) {
  if (!_bfQueue[cardIdx]) return;
  var items = _bfQueue[cardIdx].items || [];
  if (!items[itemIdx]) return;
  if (field === 'carbs' || field === 'c100') items[itemIdx][field] = val==='' ? null : parseFloat(val);
  else items[itemIdx][field] = val;
  _bfQueue[cardIdx].items = items;
}
window.bfUpdateItem = bfUpdateItem;

function bfAddItem(cardIdx) {
  if (!_bfQueue[cardIdx]) return;
  var items = _bfQueue[cardIdx].items || [];
  var newIdx = items.length;
  items.push({name:'',carbs:null,c100:null});
  _bfQueue[cardIdx].items = items;
  // Append only the new row — do NOT wipe existing live inputs
  var container = document.getElementById('bfi-' + cardIdx);
  if (container) {
    var tmp = document.createElement('div');
    tmp.innerHTML = bfItemRow(cardIdx, newIdx, items[newIdx]);
    var rowEl = tmp.firstElementChild;
    if (rowEl) {
      container.appendChild(rowEl);
      var nameInp = rowEl.querySelector('input');
      if (nameInp) setTimeout(function(){ nameInp.focus(); }, 30);
    }
  }
}
window.bfAddItem = bfAddItem;

function bfDelItem(cardIdx, itemIdx) {
  if (!_bfQueue[cardIdx]) return;
  _bfQueue[cardIdx].items.splice(itemIdx,1);
  var container = document.getElementById('bfi-' + cardIdx);
  if (container) container.innerHTML = _bfQueue[cardIdx].items.map(function(item,ii){ return bfItemRow(cardIdx,ii,item); }).join('');
}
window.bfDelItem = bfDelItem;

function bfUpdateWait(cardIdx, val) {
  if (!_bfQueue[cardIdx]) return;
  _bfQueue[cardIdx].wait_mins = val==='' ? null : parseInt(val);
}
window.bfUpdateWait = bfUpdateWait;

function bfUpdateNotes(cardIdx, val) {
  if (!_bfQueue[cardIdx]) return;
  _bfQueue[cardIdx].notes = val;
}
window.bfUpdateNotes = bfUpdateNotes;

// ── Sync new foods to FOOD_LIBRARY after approve ───────────────
// For each approved item that has a name + c100 and isn't already in
// the library, add it and push to Supabase. This is how the library
// gets rebuilt progressively through backfill review.
function _bfSyncNewFoodsToLibrary(items) {
  if (!items || !items.length) return;
  if (typeof FOOD_LIBRARY === 'undefined' || typeof saveFoodLibrary !== 'function') return;

  var added = 0;
  items.forEach(function(item) {
    var name = (item.name || '').trim();
    var c100 = parseFloat(item.c100);
    if (!name || isNaN(c100) || c100 <= 0) return;

    // Skip if already in library (case-insensitive match)
    var exists = FOOD_LIBRARY.some(function(f){ return (f.name||'').toLowerCase() === name.toLowerCase(); });
    if (exists) return;

    // Build a food library entry — keep it consistent with inline-new-food format in app.js
    var entry = {
      name:   name,
      c100:   Math.round(c100 * 10) / 10,
      gi:     item.gi    || null,
      cat:    item.gi_cat || null,
      g_serv: null,
      g_each: null,
    };
    FOOD_LIBRARY.push(entry);
    added++;
    if (typeof __debugLog === 'function') if (typeof __debugLog === 'function') __debugLog('backfill: added "' + name + '" to library (c100=' + entry.c100 + ')');
  });

  if (added > 0) {
    saveFoodLibrary(); // persists to localStorage + Supabase
    if (typeof __debugLog === 'function') if (typeof __debugLog === 'function') __debugLog('backfill: library now ' + FOOD_LIBRARY.length + ' items (+' + added + ')');
  }
}

// ── Approve ────────────────────────────────────────────────────
async function bfApprove(idx) {
  var ev = _bfQueue[idx];
  if (!ev) return;

  // Determine event type
  var evType = ev.notes && ['bolus','correction','free','hypo','snack'].indexOf(ev.notes) >= 0
    ? ev.notes
    : (ev.units > 0 && ev.carbs_device > 0 ? 'bolus' : ev.units > 0 ? 'correction' : 'snack');

  // Pre-flight: correction cards skip item check — no food to log
  var missing = evType === 'correction' ? [] : (ev.items||[]).reduce(function(acc, item, ii) {
    var name = (item.name || '').trim();
    if (name && !item.c100) acc.push(ii);
    return acc;
  }, []);

  if (missing.length) {
    // Highlight the offending rows — amber border on the c100 input
    missing.forEach(function(ii) {
      var inp = document.querySelector('#bfi-' + idx + ' .bfi-row:nth-child(' + (ii+1) + ') input[type=number]');
      // Simpler: find by scanning all c100 inputs in this card
      var allRows = document.querySelectorAll('#bfi-' + idx + ' .bfi-row');
      if (allRows[ii]) {
        var c100inp = allRows[ii].querySelector('input[type=number]');
        if (c100inp) {
          c100inp.style.borderColor = '#c0392b';
          c100inp.style.boxShadow   = '0 0 0 2px rgba(192,57,43,0.3)';
          c100inp.focus();
        }
      }
    });
    if (typeof __debugLog === 'function') __debugLog('backfill: approve blocked — ' + missing.length + ' item(s) missing carbs/100g');
    // Show brief message near the approve button
    var btn = document.querySelector('#bfc-' + idx + ' button[onclick*="bfApprove"]');
    if (btn) {
      var orig = btn.textContent;
      btn.textContent = missing.length + ' item' + (missing.length>1?'s':' ') + ' need carbs/100g';
      btn.style.color = '#c0392b';
      btn.style.borderColor = '#c0392b';
      setTimeout(function(){ btn.textContent = orig; btn.style.color = ''; btn.style.borderColor = ''; }, 2500);
    }
    return;
  }

  try {
    var items = (ev.items||[]).map(function(i){
      return { name:i.library_name||i.name||'', carbs:i.carbs, gi:i.gi||null, g:i.grams||null };
    });
    var totalCarbs  = items.reduce(function(s,i){ return s+(parseFloat(i.carbs)||0); }, 0);
    var weightedGI  = totalCarbs > 0
      ? items.reduce(function(s,i){ return s+((i.carbs||0)*(i.gi||50)); }, 0) / totalCarbs
      : null;

    // Look up historical therapy settings for this event's timestamp
    var historicalTherapy = null;
    if (typeof getTherapyAt === 'function') {
      try { historicalTherapy = await getTherapyAt(ev.t); } catch(e) {}
    }
    var histRatios = historicalTherapy && historicalTherapy.ratios || null;
    var evIC  = typeof getIC  === 'function' ? getIC(ev.t,  histRatios) : null;
    var evISF = typeof getISF === 'function' ? getISF(ev.t, histRatios) : null;
    // epoch_t — which therapy_history version was active for this outcome.
    // Used to segment "what does this regimen do for Oskar" from prior
    // regimens, rather than blending all history into one running average.
    // Safe under retroactive correction: _correctTherapyForBackdate already
    // walks meal_history/bolus_outcomes and re-derives epoch_t per-row via
    // getTherapyAt whenever a backdated treatment save happens, so a value
    // written here today gets fixed up automatically if the regimen history
    // changes later.
    var epochT = historicalTherapy ? historicalTherapy.t : null;

    var evRow = {
      t:           ev.t,
      c:           totalCarbs || ev.carbs_device,
      u:           ev.units,
      gi:          weightedGI ? +weightedGI.toFixed(1) : null,
      note:        ev.split_bolus ? 'split_bolus_1st' : 'carbs',
      items:       items,
      pre_bg:      ev.pre_bg,
      ic_ratio:    evIC  ? +evIC.toFixed(2)  : null,
      isf:         evISF ? +evISF.toFixed(2) : null,
      logged_by:   'backfill',
      device_id:   ev.src || 'backfill',
      split_bolus: ev.split_bolus || null,
    };

    var cgm     = _bfNormaliseCurve(ev.cgm_curve, ev.t);
    var postCgm = cgm.filter(function(p){ return p.m>0; });
    var peakPt  = postCgm.length ? postCgm.reduce(function(a,b){ return b.bg>a.bg?b:a; }) : null;

    var mhRow = {
      t:            ev.t,
      name:         (ev.period||'meal') + ' · ' + ev.date,
      total_carbs:  totalCarbs || ev.carbs_device,
      items:        items,
      bolus_u:      ev.units,
      wait_mins:    ev.wait_mins,
      wait_reason:  ev.wait_src === 'written' ? 'logged' : (ev.wait_mins != null ? 'bg_rule' : null),
      pre_bg:       ev.pre_bg,
      peak_bg:      peakPt ? peakPt.bg : null,
      peak_t:       peakPt ? ev.t + peakPt.m*60000 : null,
      actual_curve: cgm.map(function(p){ return {mins:p.m, actual_bg:p.bg}; }),
      source:       'backfill',
      split_bolus:  ev.split_bolus || null,
      epoch_t:      epochT,
      is_partial:   false, // outcome window already elapsed in real time — nothing to wait for
    };

    // ── bolus_outcomes: observed_isf/nadir/rmse from the already-fetched
    // cgm_curve. This is the piece bfApprove was previously missing entirely
    // — without it, MIN_OUTCOMES_FOR_ADAPTATION can never be reached from
    // backfill-approved rows, no matter how many get approved. predicted_curve
    // is deliberately left null (see KNOWN LIMITATION note above
    // confirmBackfillEntry in app.js — historical IOB-at-bolus-time can't be
    // reliably reconstructed, so a fabricated curve here would be worse than
    // no curve).
    var boRow = null;
    if (ev.units > 0 && postCgm.length >= 2) {
      var preBG  = ev.pre_bg || (cgm[0] && cgm[0].bg) || null;
      // Nadir must come from POST-bolus points only — cgm_curve windows often
      // include readings from well before the event (this row's window starts
      // ~113min pre-snack at BG 5.7, which is not a "drop caused by this dose").
      // Using the full array's minimum would attribute a pre-existing low BG
      // to this bolus and produce a false, inflated observed_isf.
      var nadir  = postCgm.reduce(function(lo, p){ return (lo===null || p.bg < lo.bg) ? p : lo; }, null);
      var bgDrop      = (preBG != null && nadir) ? (preBG - nadir.bg) : null;
      var observedISF = (bgDrop != null && ev.units > 0) ? +(bgDrop / ev.units).toFixed(2) : null;
      var isfError    = (observedISF != null && evISF != null) ? +(evISF - observedISF).toFixed(2) : null;

      var returnMins = null;
      if (nadir) {
        for (var ci = 0; ci < postCgm.length; ci++) {
          if (postCgm[ci].m > nadir.m && preBG != null && Math.abs(postCgm[ci].bg - preBG) < 1.0) {
            returnMins = postCgm[ci].m;
            break;
          }
        }
      }

      var hour = new Date(ev.t).getHours();
      var period = hour >= 6 && hour < 10 ? 'Breakfast'
                 : hour >= 10 && hour < 14 ? 'Lunch'
                 : hour >= 14 && hour < 18 ? 'Afternoon'
                 : hour >= 18 && hour < 22 ? 'Evening' : 'Overnight';

      boRow = {
        t:                ev.t,
        units:            ev.units,
        pre_bg:           preBG,
        therapy_snapshot: historicalTherapy ? {
          period: period, isf: evISF, ic: evIC,
          basal: historicalTherapy.basal_dose, basalType: historicalTherapy.basal_type,
        } : null,
        predicted_curve:  null,
        actual_curve:     cgm.map(function(p){ return {mins:p.m, bg:p.bg}; }),
        nadir_bg:         nadir ? +nadir.bg.toFixed(2) : null,
        nadir_mins:       nadir ? nadir.m : null,
        return_mins:      returnMins,
        period:           period,
        epoch_t:          epochT,
        is_partial:       false,
        device_id:        ev.src || 'backfill',
      };
      if (observedISF != null) { boRow.observed_isf = observedISF; boRow.isf_error = isfError; }
    }

    // POST to worker
    var res = await fetch(BF_WORKER + '/backfill', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({events:[evRow], meal_history:[mhRow]})
    });
    if (!res.ok) throw new Error('Worker ' + res.status);
    var result = await res.json();
    if (result.errors && Object.keys(result.errors).length) throw new Error(JSON.stringify(result.errors));

    // bolus_outcomes — written directly via _bfFetch (separate from the
    // events/meal_history worker round-trip above; no worker route needed
    // since this is an additive insert, not part of the events-table
    // collision-avoidance logic the worker handles for /backfill).
    if (boRow) {
      try {
        await _bfFetch('bolus_outcomes?on_conflict=t', {
          method: 'POST',
          prefer: 'resolution=merge-duplicates,return=minimal',
          body: [boRow],
        });
      } catch(e) {
        if (typeof __debugLog === 'function') __debugLog('backfill: bolus_outcomes write failed: ' + e.message);
      }
    }

    // Save any new food items to the library — this is how we rebuild the
    // library progressively through backfill. First "pita" → added to library.
    // Second "pita" entry → autocompletes from library.
    _bfSyncNewFoodsToLibrary(ev.items);

    // Mark approved in backfill_queue
    await _bfFetch(
      'backfill_queue?t=eq.' + ev.t,
      {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: {
          status:      'approved',
          reviewed_at: Date.now(),
          reviewed_by: typeof DEVICE_ID !== 'undefined' ? DEVICE_ID : (typeof _deviceId !== 'undefined' ? _deviceId : 'unknown'),
          items:       ev.items,
          wait_mins:   ev.wait_mins,
          notes:       ev.notes,
          split_bolus: ev.split_bolus || null,
        }
      }
    );

    // Update in-memory status so re-renders don't bring the card back
    ev.status = 'approved';

    // Remove card from UI
    var card = document.getElementById('bfc-' + idx);
    if (card) {
      card.style.transition = 'opacity 0.2s';
      card.style.opacity = '0';
      setTimeout(function(){ if(card.parentNode) card.remove(); }, 200);
    }

    _bfPendingCount = Math.max(0, _bfPendingCount - 1);
    var prog = document.getElementById('bf-progress');
    if (prog) prog.textContent = _bfPendingCount + ' pending remaining';

    if (typeof __debugLog === 'function') __debugLog('backfill: approved ' + ev.date + ' ' + ev.period);

  } catch(e) {
    if (typeof __debugLog === 'function') __debugLog('backfill approve error: ' + e.message);
    alert('Error saving: ' + e.message);
  }
}
window.bfApprove = bfApprove;

// ── Flag ───────────────────────────────────────────────────────
async function bfFlag(idx) {
  var ev = _bfQueue[idx];
  if (!ev) return;
  try {
    var n = document.getElementById('bfn-' + idx);
    if (n) ev.notes = n.value;
    await _bfFetch(
      'backfill_queue?t=eq.' + ev.t,
      { method:'PATCH', prefer:'return=minimal', body:{status:'flagged', notes:ev.notes, items:ev.items} }
    );
    ev.status = 'flagged';
    var card = document.getElementById('bfc-' + idx);
    if (card) card.style.borderLeft = '2px solid #c0392b';
  } catch(e) {
    if (typeof __debugLog === 'function') __debugLog('backfill flag error: ' + e.message);
  }
}
window.bfFlag = bfFlag;

// ── Skip — marks as skipped so it leaves pending ──────────────
async function bfSkip(idx) {
  var ev = _bfQueue[idx];
  if (!ev) return;

  // Mark as skipped in Supabase — out of pending, visible in 'all'
  try {
    await _bfFetch('backfill_queue?t=eq.' + ev.t, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { status: 'skipped' }
    });
    ev.status = 'skipped';
  } catch(e) {
    if (typeof __debugLog === 'function') if (typeof __debugLog === 'function') __debugLog('backfill skip error: ' + e.message);
  }

  // Remove from pending view
  var card = document.getElementById('bfc-' + idx);
  if (card) {
    card.style.transition = 'opacity 0.15s';
    card.style.opacity = '0';
    setTimeout(function(){
      if (card.parentNode) card.remove();
      // Scroll to next
      var next = document.getElementById('bfc-' + (idx+1));
      if (next) next.scrollIntoView({behavior:'smooth', block:'start'});
    }, 150);
  }

  _bfPendingCount = Math.max(0, _bfPendingCount - 1);
  var prog = document.getElementById('bf-progress');
  if (prog) prog.textContent = _bfPendingCount + ' pending remaining';
}
window.bfSkip = bfSkip;

// ── Insert event between cards ────────────────────────────────
function bfExpandInsert(el, defaultDt) {
  // Collapse any other open insert forms first
  document.querySelectorAll('.bf-insert-form').forEach(function(f){ f.remove(); });

  // If this one was already expanded, just collapse
  if (el.dataset.expanded === '1') {
    el.dataset.expanded = '0';
    el.style.opacity = '0.35';
    return;
  }
  el.dataset.expanded = '1';
  el.style.opacity = '1';

  var form = document.createElement('div');
  form.className = 'bf-insert-form';
  form.style.cssText = 'background:#141418;border:1px solid #26262f;border-radius:8px;padding:12px 14px;margin:4px 0;font-family:inherit';

  form.innerHTML = [
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">',
      '<span style="font-size:10px;color:#555;text-transform:uppercase;letter-spacing:0.06em">Insert event</span>',
      '<button onclick="bfCloseInsert()" style="font-family:inherit;margin-left:auto;background:none;border:none;color:#555;cursor:pointer;font-size:14px;padding:0">×</button>',
    '</div>',

    // Date + time
    '<div style="display:flex;gap:8px;margin-bottom:10px">',
      '<div style="flex:1">',
        '<div style="font-size:8px;color:#555;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px">date &amp; time</div>',
        '<input id="bfins-dt" type="datetime-local" value="' + defaultDt + '" ',
          'style="font-family:inherit;font-size:11px;width:100%;padding:4px 6px;border:1px solid #26262f;border-radius:4px;background:#0c0c0f;color:#e8e4dc;outline:none;box-sizing:border-box">',
      '</div>',
    '</div>',

    // Type selector
    '<div style="margin-bottom:10px">',
      '<div style="font-size:8px;color:#555;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">type</div>',
      '<div style="display:flex;gap:4px">',
        [['prick','◆ blood prick','#4a8fd4','#0d1820'],
         ['hypo','⚡ hypo treatment','#c0392b','#1a0808'],
         ['snack','◇ snack','#906090','#180d1a'],
         ['split','⟂ split bolus','#40a870','#0d180d'],
         ['note','✎ note','#555','#1a1a1a']].map(function(t) {
          return '<button onclick="bfInsertTypeSelect(this,\'' + t[0] + '\')" data-itype="' + t[0] + '" ' +
            'style="font-family:inherit;font-size:10px;padding:4px 8px;border:1px solid #26262f;border-radius:4px;background:transparent;color:#555;cursor:pointer">' + t[1] + '</button>';
        }).join(''),
      '</div>',
    '</div>',

    // Dynamic fields — swapped by type
    '<div id="bfins-fields" style="margin-bottom:10px"></div>',

    '<div style="display:flex;gap:6px">',
      '<button onclick="bfSaveInsert()" ',
        'style="font-family:inherit;flex:2;padding:7px;border-radius:6px;border:1px solid rgba(62,180,120,0.4);background:rgba(62,180,120,0.1);font-size:12px;color:#40a870;cursor:pointer;font-weight:600">save</button>',
      '<button onclick="bfCloseInsert()" ',
        'style="font-family:inherit;flex:1;padding:7px;border-radius:6px;border:1px solid #26262f;background:transparent;font-size:11px;color:#555;cursor:pointer">cancel</button>',
    '</div>',
  ].join('');

  el.insertAdjacentElement('afterend', form);

  // Pre-select blood prick as default
  var firstBtn = form.querySelector('[data-itype="prick"]');
  if (firstBtn) bfInsertTypeSelect(firstBtn, 'prick');
}
function bfCloseInsert() {
  document.querySelectorAll('.bf-insert-form').forEach(function(f){ f.remove(); });
  document.querySelectorAll('.bf-insert[data-expanded="1"]').forEach(function(el){
    el.dataset.expanded = '0';
    el.style.opacity = '0.35';
  });
}
window.bfCloseInsert = bfCloseInsert;
window.bfExpandInsert = bfExpandInsert;

function bfInsertTypeSelect(btn, type) {
  // Update button styles
  btn.closest('div').querySelectorAll('[data-itype]').forEach(function(b) {
    b.style.borderColor = '#26262f';
    b.style.color = '#555';
    b.style.background = 'transparent';
  });
  btn.style.borderColor = type==='prick'?'#4a8fd4':type==='hypo'?'#c0392b':type==='snack'?'#906090':type==='split'?'#40a870':'#555';
  btn.style.color       = type==='prick'?'#4a8fd4':type==='hypo'?'#c0392b':type==='snack'?'#906090':type==='split'?'#40a870':'#aaa';
  btn.style.background  = type==='prick'?'#0d1820':type==='hypo'?'#1a0808':type==='snack'?'#180d1a':type==='split'?'#0d180d':'#1a1a1a';
  btn.dataset.active = '1';

  var fields = document.getElementById('bfins-fields');
  if (!fields) return;

  if (type === 'prick') {
    fields.innerHTML =
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:6px">' +
        '<div>' +
          '<div style="font-size:8px;color:#555;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px">Blood Prick (mmol/L)</div>' +
          '<input id="bfins-bg" type="number" step="0.1" min="1" max="30" inputmode="decimal" placeholder="e.g. 6.2" ' +
            'style="font-family:inherit;font-size:18px;width:100%;padding:6px 8px;border:1px solid rgba(74,143,212,0.4);border-radius:5px;background:rgba(74,143,212,0.06);color:#4a8fd4;outline:none;text-align:center;font-weight:600;box-sizing:border-box" ' +
            'onkeydown="if(event.key===\'Enter\')bfSaveInsert()">' +
          '<div style="font-size:8px;color:#555;margin-top:3px">fingerstick result</div>' +
        '</div>' +
        '<div>' +
          '<div style="font-size:8px;color:#555;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px">CGM Reading (mmol/L)</div>' +
          '<input id="bfins-cgm" type="number" step="0.1" min="1" max="30" inputmode="decimal" placeholder="optional" ' +
            'style="font-family:inherit;font-size:18px;width:100%;padding:6px 8px;border:1px solid rgba(100,160,90,0.35);border-radius:5px;background:rgba(100,160,90,0.05);color:#6aaa60;outline:none;text-align:center;font-weight:600;box-sizing:border-box" ' +
            'onkeydown="if(event.key===\'Enter\')bfSaveInsert()">' +
          '<div style="font-size:8px;color:#555;margin-top:3px">sensor value at same time</div>' +
        '</div>' +
      '</div>' +
      '<div style="font-size:9px;color:#555">The prick will anchor to the nearest CGM reading on the River (±5 min). If you also enter the CGM value it will be stored alongside for calibration comparison.</div>';
    setTimeout(function(){ var i=document.getElementById('bfins-bg'); if(i)i.focus(); }, 30);

  } else if (type === 'hypo') {
    // Hypo treatment — clinical, known carb amount (e.g. Dextro tabs, juice)
    if (!window._bfInsertItems) window._bfInsertItems = [];
    window._bfInsertItems = [{name:'',carbs:null,c100:null}];

    fields.innerHTML =
      '<div style="font-size:9px;color:#c0392b;margin-bottom:8px;padding:5px 8px;background:#1a080855;border:1px solid #c0392b33;border-radius:4px">⚡ Hypo treatment — log what was eaten to raise BG. No insulin given.</div>' +
      '<div style="font-size:8px;color:#555;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">treatment items</div>' +
      '<div id="bfins-items">' + bfInsertItemRow(0, window._bfInsertItems[0]) + '</div>' +
      '<button onclick="bfInsertAddItem()" style="font-family:inherit;font-size:11px;color:#555;border:1px dashed #26262f;border-radius:4px;padding:3px 8px;cursor:pointer;background:none;margin-top:4px;width:100%;text-align:left">+ add item</button>';

    setTimeout(function(){ var i=document.getElementById('bfins-name-0'); if(i)i.focus(); }, 30);

  } else if (type === 'snack') {
    // Snack — no insulin, discretionary or clinical but not a hypo
    if (!window._bfInsertItems) window._bfInsertItems = [];
    window._bfInsertItems = [{name:'',carbs:null,c100:null}];

    fields.innerHTML =
      '<div style="font-size:8px;color:#555;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">snack items — no insulin given</div>' +
      '<div id="bfins-items">' + bfInsertItemRow(0, window._bfInsertItems[0]) + '</div>' +
      '<button onclick="bfInsertAddItem()" style="font-family:inherit;font-size:11px;color:#555;border:1px dashed #26262f;border-radius:4px;padding:3px 8px;cursor:pointer;background:none;margin-top:4px;width:100%;text-align:left">+ add item</button>';

    setTimeout(function(){ var i=document.getElementById('bfins-name-0'); if(i)i.focus(); }, 30);

  } else if (type === 'split') {
    // Split bolus: meal carbs + initial insulin + delayed insulin (no extra carbs)
    if (!window._bfInsertItems) window._bfInsertItems = [];
    window._bfInsertItems = [{name:'',carbs:null,c100:null}];

    fields.innerHTML = [
      '<div style="font-size:9px;color:#40a870;margin-bottom:8px;line-height:1.4">',
        'Split bolus: log the meal with the first insulin dose, then log the second dose below (insulin only, no extra carbs).',
      '</div>',
      // Food items — same as free/meal
      '<div style="font-size:8px;color:#555;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">food items eaten</div>',
      '<div id="bfins-items">' + bfInsertItemRow(0, window._bfInsertItems[0]) + '</div>',
      '<button onclick="bfInsertAddItem()" style="font-family:inherit;font-size:11px;color:#555;border:1px dashed #26262f;border-radius:4px;padding:3px 8px;cursor:pointer;background:none;margin-top:4px;width:100%;text-align:left">+ add item</button>',
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px">',
        '<div>',
          '<div style="font-size:8px;color:#555;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px">1st insulin (U)</div>',
          '<input id="bfins-u1" type="number" step="0.1" min="0" inputmode="decimal" placeholder="e.g. 4" ' +
            'style="font-family:inherit;font-size:16px;width:100%;padding:5px 8px;border:1px solid rgba(74,143,212,0.4);border-radius:5px;background:rgba(74,143,212,0.06);color:#4a8fd4;outline:none;text-align:center;font-weight:600;box-sizing:border-box">',
          '<div style="font-size:8px;color:#555;margin-top:2px">given with meal</div>',
        '</div>',
        '<div>',
          '<div style="font-size:8px;color:#555;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px">2nd insulin (U)</div>',
          '<input id="bfins-u2" type="number" step="0.1" min="0" inputmode="decimal" placeholder="e.g. 2" ' +
            'style="font-family:inherit;font-size:16px;width:100%;padding:5px 8px;border:1px solid rgba(192,128,64,0.4);border-radius:5px;background:rgba(192,128,64,0.06);color:#c08040;outline:none;text-align:center;font-weight:600;box-sizing:border-box">',
          '<div style="font-size:8px;color:#555;margin-top:2px">delayed dose (insulin only)</div>',
        '</div>',
      '</div>',
      '<div style="margin-top:8px">',
        '<div style="font-size:8px;color:#555;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px">delay (mins)</div>',
        '<input id="bfins-split-delay" type="number" step="5" min="0" max="120" value="20" placeholder="e.g. 20" ' +
          'style="font-family:inherit;font-size:14px;width:80px;padding:4px 8px;border:1px solid #26262f;border-radius:5px;background:#0c0c0f;color:#e8e4dc;outline:none;text-align:center;box-sizing:border-box">',
        '<span style="font-size:9px;color:#555;margin-left:6px">minutes after 1st dose that the 2nd dose was given</span>',
      '</div>',
    ].join('');

    setTimeout(function(){ var i=document.getElementById('bfins-name-0'); if(i)i.focus(); }, 30);

  } else if (type === 'note') {
    fields.innerHTML =
      '<div style="font-size:8px;color:#555;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px">note</div>' +
      '<textarea id="bfins-note" placeholder="context, observation…" ' +
        'style="font-family:inherit;font-size:12px;width:100%;padding:5px 8px;border:1px solid #26262f;border-radius:4px;background:#0c0c0f;color:#e8e4dc;resize:vertical;min-height:52px;outline:none;box-sizing:border-box"></textarea>';
    setTimeout(function(){ var i=document.getElementById('bfins-note'); if(i)i.focus(); }, 30);
  }
  var form = fields.closest('.bf-insert-form');
  if (form) form.dataset.itype = type;
}
window.bfInsertTypeSelect = bfInsertTypeSelect;

async function bfSaveInsert() {
  var form = document.querySelector('.bf-insert-form');
  if (!form) return;

  var type  = form.dataset.itype || 'prick';
  var dtEl  = document.getElementById('bfins-dt');
  if (!dtEl || !dtEl.value) return;

  var dt = new Date(dtEl.value);
  if (isNaN(dt.getTime())) return;
  var t = dt.getTime();

  try {
    if (type === 'prick') {
      var bg = parseFloat((document.getElementById('bfins-bg')||{}).value);
      if (isNaN(bg) || bg < 1) { var i=document.getElementById('bfins-bg'); if(i){i.style.borderColor='#c0392b';i.focus();} return; }
      var cgmReading = parseFloat((document.getElementById('bfins-cgm')||{}).value) || null;

      // Find nearest CGM reading to anchor the prick to the river rendering
      var cgmAnchorT = t; // fallback: exact time entered
      if (typeof HISTORY_RAW !== 'undefined' && HISTORY_RAW.length > 0) {
        var bestDiff = Infinity;
        HISTORY_RAW.forEach(function(r) {
          var diff = Math.abs(r.t - t);
          if (diff < bestDiff) { bestDiff = diff; cgmAnchorT = r.t; }
        });
        // Only use CGM anchor if within 5 minutes
        if (bestDiff > 5 * 60000) cgmAnchorT = t;
      }

      // Build prick event — gi field holds the fingerstick BG; cgm_reading is the sensor value at that moment
      var prickBody = { t: cgmAnchorT, c: 0, u: 0, gi: bg, note: 'prick',
               device_id: typeof _deviceId !== 'undefined' ? _deviceId : 'backfill',
               updated_at: new Date().toISOString() };
      if (cgmReading !== null) prickBody.cgm_reading = cgmReading;

      await _sbFetch('events?on_conflict=t', {
        method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
        body: [prickBody],
      });

      if (typeof BLOOD_PRICKS !== 'undefined' && typeof _savePricks === 'function') {
        BLOOD_PRICKS.push({ t: cgmAnchorT, bg: bg, cgm_reading: cgmReading, logged_by: 'backfill' });
        BLOOD_PRICKS.sort(function(a,b){ return a.t-b.t; });
        _savePricks();
      }

    } else if (type === 'hypo' || type === 'snack') {
      var freeItems = (window._bfInsertItems || []).filter(function(it){ return (it.name||'').trim() || it.carbs; });
      var totalCarbs = freeItems.reduce(function(s,it){ return s+(parseFloat(it.carbs)||0); }, 0);

      // Sync any new foods to the library
      _bfSyncNewFoodsToLibrary(freeItems);

      // Write to events — note field identifies the clinical context
      await _sbFetch('events?on_conflict=t', {
        method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
        body: [{ t: t, c: totalCarbs, u: 0, gi: null,
                 note: type === 'hypo' ? 'hypo_treatment' : 'carbs',
                 items: freeItems.map(function(it){ return {name:it.name||'',carbs:it.carbs,gi:it.gi||null}; }),
                 device_id: typeof _deviceId !== 'undefined' ? _deviceId : 'backfill',
                 updated_at: new Date().toISOString() }],
      });
      window._bfInsertItems = [];

    } else if (type === 'split') {
      var splitItems = (window._bfInsertItems || []).filter(function(it){ return (it.name||'').trim() || it.carbs; });
      var splitCarbs = splitItems.reduce(function(s,it){ return s+(parseFloat(it.carbs)||0); }, 0);
      var u1 = parseFloat((document.getElementById('bfins-u1')||{}).value) || 0;
      var u2 = parseFloat((document.getElementById('bfins-u2')||{}).value) || 0;
      var delay = parseInt((document.getElementById('bfins-split-delay')||{}).value) || 20;

      if (!u1 && !u2) { var uel=document.getElementById('bfins-u1'); if(uel){uel.style.borderColor='#c0392b';uel.focus();} return; }

      _bfSyncNewFoodsToLibrary(splitItems);

      // 1st event: meal + first bolus at logged time
      await _sbFetch('events?on_conflict=t', {
        method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
        body: [{ t: t, c: splitCarbs, u: u1, gi: null,
                 note: 'carbs',
                 items: splitItems.map(function(it){ return {name:it.name||'',carbs:it.carbs,gi:it.gi||null}; }),
                 device_id: typeof _deviceId !== 'undefined' ? _deviceId : 'backfill',
                 updated_at: new Date().toISOString() }],
      });

      // 2nd event: insulin-only correction at t + delay — no carbs
      if (u2 > 0) {
        var t2 = t + delay * 60000;
        await _sbFetch('events?on_conflict=t', {
          method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
          body: [{ t: t2, c: 0, u: u2, gi: null,
                   note: 'split_bolus_2nd',
                   items: [],
                   device_id: typeof _deviceId !== 'undefined' ? _deviceId : 'backfill',
                   updated_at: new Date().toISOString() }],
        });
      }

      window._bfInsertItems = [];

    } else {
      var noteText = ((document.getElementById('bfins-note')||{}).value || '').trim();
      if (!noteText) { var ni=document.getElementById('bfins-note'); if(ni){ni.style.borderColor='#c0392b';ni.focus();} return; }

      await _bfFetch('backfill_queue', {
        method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
        body: [{ t: t, date: dt.toISOString().slice(0,10), time: dtEl.value.slice(11,16),
                 period: 'Note', status: 'approved', notes: noteText,
                 src: 'manual', carbs_device: 0, units: 0, items: [], cgm_curve: [] }],
      });
    }

    // Replace form with slim confirmed row
    var pad = function(n){ return String(n).padStart(2,'0'); };
    var timeStr = pad(dt.getHours()) + ':' + pad(dt.getMinutes());
    var typeLabels = {prick: '◆ prick', hypo: '⚡ hypo', snack: 'snack', split: '⟂ split bolus', note: '✎ note'};
    var typeDetail = (['hypo','snack','split'].indexOf(type) >= 0) && (window._bfInsertItems||[]).length
      ? (typeLabels[type]||type) + ' · ' + window._bfInsertItems.filter(function(it){return it.name;}).map(function(it){return it.name;}).join(', ')
      : (typeLabels[type]||type);
    var confirmed = document.createElement('div');
    confirmed.style.cssText = 'display:flex;align-items:center;gap:8px;padding:3px 4px;margin:2px 0;border-left:2px solid #1d9e72;background:rgba(29,158,114,0.05);border-radius:0 4px 4px 0';
    confirmed.innerHTML =
      '<span style="font-size:9px;color:#1d9e72">✓</span>' +
      '<span style="font-size:10px;color:#555">' + dt.toLocaleDateString('en-GB',{day:'numeric',month:'short'}) + ' ' + timeStr + '</span>' +
      '<span style="font-size:10px;color:#555">' + typeDetail + '</span>';

    form.replaceWith(confirmed);

    if (typeof __debugLog === 'function') if (typeof __debugLog === 'function') __debugLog('backfill: inserted ' + type + ' at ' + timeStr);

  } catch(e) {
    if (typeof __debugLog === 'function') if (typeof __debugLog === 'function') __debugLog('backfill insert error: ' + e.message);
    alert('Error saving: ' + e.message);
  }
}
window.bfSaveInsert = bfSaveInsert;

// ── Mini item row for the free-food insert form ───────────────
// Mirrors bfItemRow but uses a separate state array (_bfInsertItems)
// and simplified IDs so it doesn't collide with card-level rows.
function bfInsertItemRow(idx, item) {
  var name  = (item.name||'').replace(/"/g,'&quot;');
  var carbs = item.carbs != null ? parseFloat(item.carbs).toFixed(1) : '';
  var c100  = item.c100  != null ? parseFloat(item.c100).toFixed(1)  : '';
  var libMatch = _bfLibLookup(name);
  if (libMatch && !c100 && libMatch.c100) c100 = parseFloat(libMatch.c100).toFixed(1);
  var giText = item.gi ? 'GI ' + item.gi : 'GI?';
  var giCol  = item.gi ? (item.gi>=70?'#c0392b':item.gi>=55?'#b07820':'#1d9e72') : '#333';

  return '<div class="bfins-item-row" style="display:flex;align-items:center;gap:6px;margin-bottom:4px">' +
    '<div style="flex:1;position:relative">' +
      '<input id="bfins-name-' + idx + '" type="text" value="' + name + '" placeholder="food name…" autocomplete="off" ' +
        'oninput="bfInsertItemNameInput(' + idx + ',this)" ' +
        'onblur="bfInsertItemNameBlur(' + idx + ',this)" ' +
        'style="font-family:inherit;font-size:12px;width:100%;border:1px solid #26262f;border-radius:4px;padding:3px 6px;background:#0c0c0f;color:#e8e4dc;box-sizing:border-box">' +
      '<div id="bfinsac-' + idx + '" style="position:fixed;background:#1c1c22;border:1px solid #26262f;border-radius:4px;z-index:700;display:none;min-width:200px;max-width:300px"></div>' +
    '</div>' +
    '<div style="display:flex;flex-direction:column;align-items:center;gap:1px">' +
      '<input id="bfins-c100-' + idx + '" type="number" step="0.1" min="0" max="100" value="' + c100 + '" placeholder="—" ' +
        'title="carbs per 100g" ' +
        'onchange="bfInsertItemUpdate(' + idx + ',\'c100\',this.value)" ' +
        'style="font-family:inherit;font-size:11px;width:44px;text-align:right;border:1px solid ' + (!c100?'#4a2800':'#26262f') + ';border-radius:4px;padding:2px 5px;background:#0c0c0f;color:' + (!c100?'#b07820':'#e8e4dc') + '">' +
      '<span style="font-size:8px;color:#333;line-height:1">/100g</span>' +
    '</div>' +
    '<span id="bfinsgi-' + idx + '" style="font-size:8px;color:' + giCol + ';min-width:28px;text-align:center">' + giText + '</span>' +
    '<div style="display:flex;flex-direction:column;align-items:center;gap:1px">' +
      '<input id="bfins-carbs-' + idx + '" type="number" step="0.1" value="' + carbs + '" placeholder="g" ' +
        'title="total carbs (g)" ' +
        'onchange="bfInsertItemUpdate(' + idx + ',\'carbs\',this.value)" ' +
        'style="font-family:inherit;font-size:12px;width:52px;text-align:right;border:1px solid ' + (!carbs?'#4a1a1a':'#26262f') + ';border-radius:4px;padding:3px 6px;background:#0c0c0f;color:#e8e4dc">' +
      '<span style="font-size:8px;color:#555;line-height:1">carbs g</span>' +
    '</div>' +
    '<button onclick="bfInsertDelItem(' + idx + ')" style="font-family:inherit;background:none;border:none;color:#555;cursor:pointer;font-size:15px;padding:0 2px">×</button>' +
  '</div>';
}
window.bfInsertItemRow = bfInsertItemRow;

function bfInsertItemUpdate(idx, field, val) {
  if (!window._bfInsertItems || !window._bfInsertItems[idx]) return;
  if (field === 'carbs' || field === 'c100') window._bfInsertItems[idx][field] = val==='' ? null : parseFloat(val);
  else window._bfInsertItems[idx][field] = val;
}
window.bfInsertItemUpdate = bfInsertItemUpdate;

function bfInsertAddItem() {
  if (!window._bfInsertItems) window._bfInsertItems = [];
  var newIdx = window._bfInsertItems.length;
  window._bfInsertItems.push({name:'',carbs:null,c100:null});
  var container = document.getElementById('bfins-items');
  if (container) {
    var tmp = document.createElement('div');
    tmp.innerHTML = bfInsertItemRow(newIdx, window._bfInsertItems[newIdx]);
    if (tmp.firstElementChild) container.appendChild(tmp.firstElementChild);
    var inp = document.getElementById('bfins-name-' + newIdx);
    if (inp) setTimeout(function(){ inp.focus(); }, 30);
  }
}
window.bfInsertAddItem = bfInsertAddItem;

function bfInsertDelItem(idx) {
  if (!window._bfInsertItems) return;
  window._bfInsertItems.splice(idx, 1);
  var container = document.getElementById('bfins-items');
  if (container) container.innerHTML = window._bfInsertItems.map(function(it,i){ return bfInsertItemRow(i,it); }).join('');
}
window.bfInsertDelItem = bfInsertDelItem;

function bfInsertItemNameInput(idx, input) {
  var q  = input.value;
  var ac = document.getElementById('bfinsac-' + idx);
  if (!ac) return;
  if (!q || q.length < 2) { ac.style.display='none'; return; }
  var results = bfSearchFoods(q);
  var rect = input.getBoundingClientRect();
  ac.style.left  = rect.left + 'px';
  ac.style.top   = (rect.bottom + 2) + 'px';
  ac.style.width = rect.width + 'px';

  var matchHtml = results.map(function(f) {
    var enc = encodeURIComponent(f.name);
    return '<div onclick="bfInsertSelectFood(' + idx + ',decodeURIComponent(\'' + enc + '\'))" ' +
      'style="padding:5px 8px;cursor:pointer;border-bottom:1px solid #26262f;display:flex;align-items:center;gap:6px" ' +
      'onmouseover="this.style.background=\'#0d1820\'" onmouseout="this.style.background=\'\'">' +
      '<span style="flex:1;font-size:12px;color:#e8e4dc">' + f.name + '</span>' +
      '<span style="font-size:10px;color:#555">' + (f.c100||'?') + '/100g</span>' +
    '</div>';
  }).join('');

  // Always show "add as new" row at the bottom
  var addRow = '<div onclick="var _ac=document.getElementById(\'bfinsac-' + idx + '\');if(_ac)_ac.style.display=\'none\';_bfOpenAddFoodModalInsert(' + idx + ',\'' + q.replace(/'/g,"\\'") + '\')" ' +
    'style="padding:6px 8px;cursor:pointer;display:flex;align-items:center;gap:6px;' + (results.length ? 'border-top:1px solid #1a1a1e;' : '') + '">' +
    '<span style="font-size:11px;color:#40a870">+</span>' +
    '<span style="font-size:11px;color:#40a870">' + (results.length ? 'add \u201c' + q + '\u201d as new' : '\u201c' + q + '\u201d not in library — add it') + '</span>' +
  '</div>';

  ac.innerHTML = matchHtml + addRow;
  ac.style.display = 'block';
}
window.bfInsertItemNameInput = bfInsertItemNameInput;

function bfInsertItemNameBlur(idx, input) {
  setTimeout(function(){
    var ac = document.getElementById('bfinsac-' + idx);
    if (ac) ac.style.display = 'none';
    var name = (input.value||'').trim();
    if (window._bfInsertItems && window._bfInsertItems[idx]) {
      window._bfInsertItems[idx].name = name;
    }
  }, 200);
}
window.bfInsertItemNameBlur = bfInsertItemNameBlur;

// _bfLookupGIForInsert removed — GI is now populated via the shared addCustomFood
// overlay. Library items with missing GI can be updated by opening addCustomFood.

function bfInsertSelectFood(idx, name) {
  var food = _bfLibLookup(name);
  if (!window._bfInsertItems) window._bfInsertItems = [];
  var existing = window._bfInsertItems[idx] || {};
  window._bfInsertItems[idx] = {
    name:  food ? food.name : name,
    c100:  food ? food.c100 : null,
    gi:    food ? food.gi   : null,
    carbs: existing.carbs || null,
  };
  // Update the row inputs in place
  var nameInp  = document.getElementById('bfins-name-'  + idx);
  var c100Inp  = document.getElementById('bfins-c100-'  + idx);
  var giSpan   = document.getElementById('bfinsgi-'     + idx);
  var ac       = document.getElementById('bfinsac-'     + idx);
  if (nameInp) nameInp.value = window._bfInsertItems[idx].name;
  if (c100Inp && food && food.c100) { c100Inp.value = food.c100; c100Inp.style.borderColor = '#26262f'; c100Inp.style.color = '#e8e4dc'; }
  if (giSpan && food && food.gi) {
    giSpan.textContent = 'GI ' + food.gi;
    giSpan.style.color = food.gi>=70?'#c0392b':food.gi>=55?'#b07820':'#1d9e72';
  } else if (food && !food.gi && typeof window.addCustomFood === 'function') {
    // Library match but no GI — open the overlay so the user can fill it in
    // (this saves the GI back to the library entry too)
    giSpan && (giSpan.textContent = 'GI?');
    window._foodAddCallback = function(savedFood) {
      window._bfInsertItems[idx].gi = savedFood.gi;
      if (giSpan && savedFood.gi) {
        giSpan.textContent = 'GI ' + savedFood.gi;
        giSpan.style.color = savedFood.gi>=70?'#c0392b':savedFood.gi>=55?'#b07820':'#1d9e72';
      }
    };
    window.addCustomFood(food.name);
  }
  if (ac) ac.style.display = 'none';
}
window.bfInsertSelectFood = bfInsertSelectFood;

// ── Close autocomplete on outside click ───────────────────────
document.addEventListener('click', function(e) {
  if (!e.target.closest || !e.target.closest('.bfi-row')) {
    document.querySelectorAll('[id^="bfac-"]').forEach(function(el){ el.style.display='none'; });
  }
});

// ── Exports ────────────────────────────────────────────────────
window.bfPendingCount = bfPendingCount;
window.initBackfill   = initBackfill;
