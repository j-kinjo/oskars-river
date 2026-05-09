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
let _bfSheetOpen    = false;
let _bfPendingCount = 0;

// ── Helpers — use _sbFetch directly (matches app.js internals) ─
async function _bfFetch(path, opts) {
  // Delegates to app.js _sbFetch so credentials stay centralised
  return _sbFetch(path, opts || {});
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
      __debugLog('backfill: ' + _bfPendingCount + ' events awaiting review');
      // Update settings tray label if it's currently open
      _bfUpdateTrayBadge();
    }
  } catch(e) {
    __debugLog('backfill init error: ' + e.message);
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
  var statusFilter = filter === 'all'
    ? 'status=in.(pending,flagged,approved)'
    : filter === 'flagged'
    ? 'status=eq.flagged'
    : 'status=eq.pending';

  var rows = await _bfFetch(
    'backfill_queue?' + statusFilter + '&order=date.asc&order=time.asc',
    { method: 'GET' }
  );
  return Array.isArray(rows) ? rows : [];
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
    '<div id="bf-header" style="padding:14px 16px 10px;border-bottom:1px solid #26262f;',
    'display:flex;align-items:center;gap:12px;flex-shrink:0">',
      '<div style="flex:1">',
        '<div style="font-size:15px;font-weight:600;color:#e8e4dc">Meal History Review</div>',
        '<div id="bf-progress" style="font-size:12px;color:#555;margin-top:2px">Loading…</div>',
      '</div>',
      '<div id="bf-filters" style="display:flex;gap:6px">',
        ['pending','flagged','all'].map(function(f) {
          return '<button onclick="bfSetFilter(\'' + f + '\')" id="bff-' + f + '" style="' +
            'font-family:inherit;font-size:11px;padding:4px 10px;' +
            'border:1px solid ' + (f==='pending'?'#4a8fd4':'#26262f') + ';' +
            'border-radius:5px;background:' + (f==='pending'?'#0d1820':'transparent') + ';' +
            'color:' + (f==='pending'?'#4a8fd4':'#555') + ';cursor:pointer">' + f + '</button>';
        }).join(''),
      '</div>',
      '<button onclick="closeBackfillReview()" style="font-family:inherit;font-size:18px;',
      'background:none;border:none;color:#555;cursor:pointer;padding:0 4px;line-height:1">×</button>',
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
  var body = document.getElementById('bf-body');
  if (body) body.innerHTML = '<div style="text-align:center;color:#555;padding:40px;font-size:13px">Loading…</div>';
  try {
    _bfQueue = await bfLoadQueue(f);
    bfRenderQueue();
  } catch(e) {
    var body2 = document.getElementById('bf-body');
    if (body2) body2.innerHTML = '<div style="color:#c0392b;padding:20px">' + e.message + '</div>';
  }
}
window.bfSetFilter = bfSetFilter;

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
  body.innerHTML = _bfQueue.map(function(ev, i){ return bfCardHTML(ev, i); }).join('');
}

// ── Card HTML ──────────────────────────────────────────────────
function bfCardHTML(ev, idx) {
  var PERIODS = {
    'Breakfast':      '#0d1820:#4a8fd4',
    'Morning snack':  '#0d180d:#40a870',
    'Lunch':          '#0d180d:#40a870',
    'Afternoon snack':'#1a1008:#c08040',
    'Dinner':         '#1a1008:#c08040',
    'Bedtime snack':  '#180d1a:#906090',
    'Unknown':        '#1a1a1a:#666'
  };
  var parts    = ((PERIODS[ev.period] || PERIODS.Unknown)).split(':');
  var pbg      = parts[0], pco = parts[1];
  var items    = ev.items || [];
  var totalLogged = items.reduce(function(s,i){ return s+(parseFloat(i.carbs)||0); }, 0);
  var carbDiff = ev.carbs_device && totalLogged > 0
    ? Math.abs(totalLogged - ev.carbs_device) : null;
  var diffWarning = carbDiff && carbDiff > 2
    ? '<span style="color:#b07820;font-size:11px"> ⚠ ' + totalLogged.toFixed(1) + 'g logged vs ' + ev.carbs_device + 'g device</span>'
    : '';
  var waitHint = ev.wait_src === 'written'
    ? '✓ written'
    : ev.wait_mins != null ? '≈ ' + ev.wait_mins + 'm · BG rule' : '';
  var statusCol = ev.status==='approved' ? '#1d9e72' : ev.status==='flagged' ? '#c0392b' : '#555';
  var borderLeft = ev.status==='approved' ? 'border-left:2px solid #1d9e72'
    : ev.status==='flagged' ? 'border-left:2px solid #c0392b' : '';

  return [
    '<div id="bfc-' + idx + '" style="background:#141418;border:1px solid #26262f;border-radius:8px;margin-bottom:10px;overflow:hidden;' + borderLeft + '">',
      // Header row — tap to expand
      '<div onclick="bfToggle(' + idx + ')" style="display:flex;align-items:center;gap:10px;padding:10px 12px;cursor:pointer">',
        '<span style="font-size:11px;color:#555;min-width:76px">' + ev.date + '</span>',
        '<span style="font-size:11px;color:#555;min-width:40px">' + (ev.time||'?') + '</span>',
        '<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;background:' + pbg + ';color:' + pco + ';min-width:88px;text-align:center;text-transform:uppercase;letter-spacing:0.05em">' + (ev.period||'?') + '</span>',
        '<span style="font-size:14px;font-weight:600;color:#e8e4dc;min-width:50px">' + (ev.carbs_device||'?') + 'g</span>',
        '<span style="font-size:11px;color:#555;flex:1">' + (ev.units||'?') + 'U' + (ev.ic_ratio?' · 1:'+ev.ic_ratio:'') + '</span>',
        ev.peak_bg ? '<span style="font-size:11px;color:' + (ev.peak_bg>12?'#c0392b':ev.peak_bg>10?'#b07820':'#1d9e72') + '">↑' + ev.peak_bg + ' +' + ev.peak_mins + 'm</span>' : '',
        '<span style="font-size:10px;color:' + statusCol + '">' + ev.status + '</span>',
      '</div>',

      // Expandable detail
      '<div id="bfd-' + idx + '" style="display:none;padding:0 12px 12px;border-top:1px solid #26262f">',
        '<div style="display:grid;grid-template-columns:1fr 200px;gap:12px;margin-top:10px">',

          // Left: food items + controls
          '<div>',
            '<div style="font-size:10px;color:#555;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px">food items ' + diffWarning + '</div>',
            '<div id="bfi-' + idx + '">',
              items.map(function(item, ii){ return bfItemRow(idx, ii, item); }).join(''),
            '</div>',
            '<button onclick="bfAddItem(' + idx + ')" style="font-family:inherit;font-size:11px;color:#555;border:1px dashed #26262f;border-radius:4px;padding:3px 8px;cursor:pointer;background:none;margin-top:4px;width:100%;text-align:left">+ add item</button>',

            // Wait time
            '<div style="display:flex;align-items:center;gap:8px;margin-top:10px">',
              '<span style="font-size:11px;color:#555;min-width:70px;text-transform:uppercase;letter-spacing:0.05em">bolus wait</span>',
              '<input type="number" min="0" max="60" step="5" id="bfw-' + idx + '" value="' + (ev.wait_mins!=null?ev.wait_mins:'') + '" placeholder="mins" onchange="bfUpdateWait(' + idx + ',this.value)" style="font-family:inherit;font-size:12px;width:60px;border:1px solid #26262f;border-radius:4px;padding:3px 6px;background:#0c0c0f;color:#e8e4dc;text-align:center">',
              '<span style="font-size:11px;color:#555">' + waitHint + '</span>',
            '</div>',

            // Notes
            '<textarea id="bfn-' + idx + '" placeholder="notes, unknowns, context…" onchange="bfUpdateNotes(' + idx + ',this.value)" style="font-family:inherit;font-size:12px;width:100%;margin-top:8px;border:1px solid #26262f;border-radius:4px;padding:5px 8px;background:#0c0c0f;color:#e8e4dc;resize:vertical;min-height:44px">' + (ev.notes||'') + '</textarea>',

            // Actions
            '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">',
              '<button onclick="bfApprove(' + idx + ')" style="font-family:inherit;font-size:12px;padding:6px 14px;border:1px solid #1d9e72;border-radius:5px;background:transparent;color:#1d9e72;cursor:pointer;font-weight:600">approve</button>',
              '<button onclick="bfFlag(' + idx + ')" style="font-family:inherit;font-size:12px;padding:6px 14px;border:1px solid #c0392b;border-radius:5px;background:transparent;color:#c0392b;cursor:pointer">flag</button>',
              '<button onclick="bfSkip(' + idx + ')" style="font-family:inherit;font-size:12px;padding:6px 14px;border:1px solid #26262f;border-radius:5px;background:transparent;color:#555;cursor:pointer">skip →</button>',
            '</div>',
          '</div>',

          // Right: CGM chart + meta
          '<div>',
            '<canvas id="bfcgm-' + idx + '" style="width:100%;height:110px;display:block;border-radius:4px"></canvas>',
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 8px;margin-top:8px">',
              [
                ['pre-BG', ev.pre_bg ? ev.pre_bg+' mmol' : '—'],
                ['units',  ev.units  ? ev.units+'U'      : '—'],
                ['peak',   ev.peak_bg || '—'],
                ['peak at',ev.peak_mins ? '+'+ev.peak_mins+'m' : '—'],
                ['I:C',    ev.ic_ratio  ? '1:'+ev.ic_ratio     : '—'],
                ['src',    ev.src       || '—'],
              ].map(function(row) {
                return '<div style="display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px solid #1a1a1e;font-size:11px"><span style="color:#555">' + row[0] + '</span><span style="font-weight:500;color:#e8e4dc">' + row[1] + '</span></div>';
              }).join(''),
            '</div>',
          '</div>',

        '</div>',
      '</div>',
    '</div>',
  ].join('');
}

// ── Item row ───────────────────────────────────────────────────
function bfItemRow(cardIdx, itemIdx, item) {
  var name  = (item.library_name || item.name || item.raw_name || '').replace(/"/g,'&quot;');
  var carbs = item.carbs != null ? parseFloat(item.carbs).toFixed(1) : '';
  return [
    '<div class="bfi-row" style="display:flex;align-items:center;gap:6px;margin-bottom:4px">',
      '<div style="flex:1;position:relative">',
        '<input style="font-family:inherit;font-size:12px;width:100%;border:1px solid #26262f;border-radius:4px;padding:3px 6px;background:#0c0c0f;color:#e8e4dc" ',
          'value="' + name + '" placeholder="food name…" autocomplete="off" ',
          'oninput="bfNameInput(' + cardIdx + ',' + itemIdx + ',this)" ',
          'onchange="bfUpdateItem(' + cardIdx + ',' + itemIdx + ',\'name\',this.value)">',
        '<div id="bfac-' + cardIdx + '-' + itemIdx + '" style="position:absolute;top:100%;left:0;right:0;background:#1c1c22;border:1px solid #26262f;border-radius:4px;max-height:140px;overflow-y:auto;z-index:600;display:none"></div>',
      '</div>',
      '<input type="number" step="0.1" value="' + carbs + '" placeholder="g" ',
        'onchange="bfUpdateItem(' + cardIdx + ',' + itemIdx + ',\'carbs\',this.value)" ',
        'style="font-family:inherit;font-size:12px;width:56px;text-align:right;border:1px solid ' + (!carbs?'#4a1a1a':'#26262f') + ';border-radius:4px;padding:3px 6px;background:#0c0c0f;color:#e8e4dc">',
      '<button onclick="bfDelItem(' + cardIdx + ',' + itemIdx + ')" style="font-family:inherit;background:none;border:none;color:#555;cursor:pointer;font-size:15px;padding:0 2px">×</button>',
    '</div>',
  ].join('');
}

// ── Toggle expand ──────────────────────────────────────────────
function bfToggle(idx) {
  var det = document.getElementById('bfd-' + idx);
  if (!det) return;
  var open = det.style.display !== 'none';
  det.style.display = open ? 'none' : 'block';
  if (!open) setTimeout(function(){ bfDrawCGM(idx, _bfQueue[idx] && _bfQueue[idx].cgm_curve); }, 30);
}
window.bfToggle = bfToggle;

// ── CGM sparkline ──────────────────────────────────────────────
function bfDrawCGM(idx, cgm) {
  var cv = document.getElementById('bfcgm-' + idx);
  if (!cv || !cgm || !cgm.length) return;
  var W = cv.width = cv.offsetWidth || 200, H = cv.height = 110;
  var ctx = cv.getContext('2d');
  ctx.clearRect(0,0,W,H);
  var pad = {l:24,r:6,t:6,b:16};
  var ms  = cgm.map(function(p){return p.m;}), vs = cgm.map(function(p){return p.bg;});
  var mn  = Math.min.apply(null,ms), mx = Math.max.apply(null,ms);
  var mV  = Math.min(3,Math.min.apply(null,vs)), xV = Math.max(12,Math.max.apply(null,vs));
  var xs  = function(m){ return (m-mn)/(mx-mn)*(W-pad.l-pad.r)+pad.l; };
  var ys  = function(v){ return H-pad.b-(v-mV)/(xV-mV)*(H-pad.t-pad.b); };

  [[4,'rgba(192,57,43,0.35)'],[7,'rgba(255,255,255,0.07)'],[10,'rgba(176,120,32,0.35)']].forEach(function(r){
    ctx.beginPath(); ctx.strokeStyle=r[1]; ctx.lineWidth=0.5; ctx.setLineDash([3,4]);
    ctx.moveTo(pad.l,ys(r[0])); ctx.lineTo(W-pad.r,ys(r[0])); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle='rgba(180,180,180,0.35)'; ctx.font='9px monospace';
    ctx.fillText(r[0],2,ys(r[0])+3);
  });

  var x0 = xs(0);
  ctx.beginPath(); ctx.strokeStyle='rgba(74,143,212,0.4)'; ctx.lineWidth=1; ctx.setLineDash([2,3]);
  ctx.moveTo(x0,pad.t); ctx.lineTo(x0,H-pad.b); ctx.stroke(); ctx.setLineDash([]);

  ctx.beginPath();
  cgm.forEach(function(p,i){ i===0?ctx.moveTo(xs(p.m),ys(p.bg)):ctx.lineTo(xs(p.m),ys(p.bg)); });
  ctx.strokeStyle='#4a8fd4'; ctx.lineWidth=1.5; ctx.stroke();

  cgm.forEach(function(p){
    ctx.beginPath(); ctx.arc(xs(p.m),ys(p.bg),2,0,Math.PI*2);
    ctx.fillStyle=p.bg>=10?'#c0392b':p.bg<=4?'#c0392b':'#4a8fd4';
    ctx.fill();
  });
  [0,60,120,180].forEach(function(m){
    if(m>=mn&&m<=mx){
      ctx.fillStyle='rgba(180,180,180,0.35)'; ctx.font='9px monospace';
      ctx.fillText(m===0?'0':'+'+m+'m',xs(m)-8,H-2);
    }
  });
}

// ── Autocomplete ───────────────────────────────────────────────
function bfSearchFoods(q) {
  if (!q || q.length < 2) return [];
  var lq = q.toLowerCase();
  var combined = [].concat(
    typeof FOOD_LIBRARY !== 'undefined' ? FOOD_LIBRARY : [],
    typeof FOOD_DB !== 'undefined' ? FOOD_DB : []
  );
  return combined.filter(function(f){ return (f.name||'').toLowerCase().includes(lq); }).slice(0,6);
}

function bfNameInput(cardIdx, itemIdx, input) {
  var ac = document.getElementById('bfac-' + cardIdx + '-' + itemIdx);
  if (!ac) return;
  var results = bfSearchFoods(input.value);
  if (!results.length) { ac.style.display='none'; return; }
  ac.innerHTML = results.map(function(f){
    var enc = encodeURIComponent(f.name);
    return '<div onclick="bfSelectFood(' + cardIdx + ',' + itemIdx + ',decodeURIComponent(\'' + enc + '\'))" ' +
      'style="padding:5px 8px;cursor:pointer;border-bottom:1px solid #26262f;font-size:12px;color:#e8e4dc" ' +
      'onmouseover="this.style.background=\'#0d1820\'" onmouseout="this.style.background=\'\'">' +
      f.name + '<span style="float:right;font-size:10px;color:#555">' + (f.typical_carbs||f.carbs_per_portion||f.c100||'?') + 'g</span></div>';
  }).join('');
  ac.style.display = 'block';
}
window.bfNameInput = bfNameInput;

function bfSelectFood(cardIdx, itemIdx, name) {
  var combined = [].concat(
    typeof FOOD_LIBRARY !== 'undefined' ? FOOD_LIBRARY : [],
    typeof FOOD_DB !== 'undefined' ? FOOD_DB : []
  );
  var food = combined.find(function(f){ return f.name === name; });
  if (!food || !_bfQueue[cardIdx]) return;
  var items = _bfQueue[cardIdx].items || [];
  items[itemIdx] = {
    name:       food.name,
    library_id: food.id || null,
    carbs:      food.typical_carbs || food.carbs_per_portion || food.c100 || null,
    gi:         food.gi || null,
    gi_cat:     food.gi_cat || null,
    grams:      null
  };
  _bfQueue[cardIdx].items = items;
  var ac = document.getElementById('bfac-' + cardIdx + '-' + itemIdx);
  if (ac) ac.style.display = 'none';
  var container = document.getElementById('bfi-' + cardIdx);
  if (container) container.innerHTML = items.map(function(item,ii){ return bfItemRow(cardIdx,ii,item); }).join('');
}
window.bfSelectFood = bfSelectFood;

// ── Item mutations ─────────────────────────────────────────────
function bfUpdateItem(cardIdx, itemIdx, field, val) {
  if (!_bfQueue[cardIdx]) return;
  var items = _bfQueue[cardIdx].items || [];
  if (!items[itemIdx]) return;
  if (field === 'carbs') items[itemIdx].carbs = val==='' ? null : parseFloat(val);
  else items[itemIdx][field] = val;
  _bfQueue[cardIdx].items = items;
}
window.bfUpdateItem = bfUpdateItem;

function bfAddItem(cardIdx) {
  if (!_bfQueue[cardIdx]) return;
  _bfQueue[cardIdx].items = (_bfQueue[cardIdx].items||[]).concat([{name:'',carbs:null}]);
  var container = document.getElementById('bfi-' + cardIdx);
  if (container) container.innerHTML = _bfQueue[cardIdx].items.map(function(item,ii){ return bfItemRow(cardIdx,ii,item); }).join('');
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

// ── Approve ────────────────────────────────────────────────────
async function bfApprove(idx) {
  var ev = _bfQueue[idx];
  if (!ev) return;

  try {
    var items = (ev.items||[]).map(function(i){
      return { name:i.library_name||i.name||'', carbs:i.carbs, gi:i.gi||null, g:i.grams||null };
    });
    var totalCarbs  = items.reduce(function(s,i){ return s+(parseFloat(i.carbs)||0); }, 0);
    var weightedGI  = totalCarbs > 0
      ? items.reduce(function(s,i){ return s+((i.carbs||0)*(i.gi||50)); }, 0) / totalCarbs
      : null;

    var evRow = {
      t:         ev.t,
      c:         totalCarbs || ev.carbs_device,
      u:         ev.units,
      gi:        weightedGI ? +weightedGI.toFixed(1) : null,
      note:      'carbs',
      items:     items,
      pre_bg:    ev.pre_bg,
      logged_by: 'backfill',
      device_id: ev.src || 'backfill'
    };

    var cgm     = ev.cgm_curve || [];
    var postCgm = cgm.filter(function(p){ return p.m>0; });
    var peakPt  = postCgm.length ? postCgm.reduce(function(a,b){ return b.bg>a.bg?b:a; }) : null;

    var mhRow = {
      t:            ev.t,
      name:         (ev.period||'meal') + ' · ' + ev.date,
      total_carbs:  totalCarbs || ev.carbs_device,
      items:        items,
      bolus_u:      ev.units,
      wait_mins:    ev.wait_mins,
      pre_bg:       ev.pre_bg,
      peak_bg:      peakPt ? peakPt.bg : null,
      peak_t:       peakPt ? ev.t + peakPt.m*60000 : null,
      actual_curve: cgm.map(function(p){ return {mins:p.m, actual_bg:p.bg}; }),
      source:       'backfill',
    };

    // POST to worker
    var res = await fetch(BF_WORKER + '/backfill', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({events:[evRow], meal_history:[mhRow]})
    });
    if (!res.ok) throw new Error('Worker ' + res.status);
    var result = await res.json();
    if (result.errors && Object.keys(result.errors).length) throw new Error(JSON.stringify(result.errors));

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
          notes:       ev.notes
        }
      }
    );

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

    __debugLog('backfill: approved ' + ev.date + ' ' + ev.period);

  } catch(e) {
    __debugLog('backfill approve error: ' + e.message);
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
    __debugLog('backfill flag error: ' + e.message);
  }
}
window.bfFlag = bfFlag;

// ── Skip ───────────────────────────────────────────────────────
function bfSkip(idx) {
  var det = document.getElementById('bfd-' + idx);
  if (det) det.style.display = 'none';
  var next = document.getElementById('bfc-' + (idx+1));
  if (next) next.scrollIntoView({behavior:'smooth', block:'start'});
}
window.bfSkip = bfSkip;

// ── Close autocomplete on outside click ───────────────────────
document.addEventListener('click', function(e) {
  if (!e.target.closest || !e.target.closest('.bfi-row')) {
    document.querySelectorAll('[id^="bfac-"]').forEach(function(el){ el.style.display='none'; });
  }
});

// ── Exports ────────────────────────────────────────────────────
window.bfPendingCount = bfPendingCount;
window.initBackfill   = initBackfill;
