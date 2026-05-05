// river-sync.test.js
// Tests for River event storage refactor: BOLUS_EVENTS as live alias for LOGGED_EVENTS
// Run: node river-sync.test.js

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('✓', name);
    passed++;
  } catch (e) {
    console.error('✗', name, '\n  ', e.message);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEq(a, b, msg) {
  if (a !== b) throw new Error((msg || 'expected equal') + ` — got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
}

// ── Minimal stub environment ───────────────────────────────────────────────
// We replicate the exact init pattern from app.js so tests exercise the same code.

function makeState() {
  let LOGGED_EVENTS = [];
  let BOLUS_EVENTS = LOGGED_EVENTS; // live alias — same reference
  let SESSION = [];
  let _deletedEventTs = new Set();
  return { LOGGED_EVENTS, BOLUS_EVENTS, SESSION, _deletedEventTs };
}

// Minimal syncPullEvents logic (extracted from app.js, dependency-free)
function syncPullEvents(state, remoteRows) {
  const { _deletedEventTs } = state;
  const _pullCutoff = Date.now() - 24 * 3600000;

  const rowsByT = {};
  remoteRows.forEach(function (row) { rowsByT[row.t] = row; });
  const deduped = Object.values(rowsByT);
  const remoteTs = new Set(deduped.map(r => r.t));

  // Remove stale non-local events no longer in Supabase
  const removedTs = new Set();
  state.LOGGED_EVENTS = state.LOGGED_EVENTS.filter(function (e) {
    if (e.local) return true;
    if (e.t < _pullCutoff) return true;
    if (remoteTs.has(e.t)) return true;
    removedTs.add(e.t);
    return false;
  });
  // Keep alias in sync after array replacement
  state.BOLUS_EVENTS = state.LOGGED_EVENTS;

  let added = 0;
  deduped.forEach(function (row) {
    if (row.note === 'food_library') return;
    if (_deletedEventTs.has(row.t)) return;
    const rowItems = typeof row.items === 'string' ? (() => { try { return JSON.parse(row.items); } catch (_e) { return null; } })() : (row.items || null);

    const existsL = state.LOGGED_EVENTS.findIndex(e => e.t === row.t);
    if (existsL >= 0) {
      state.LOGGED_EVENTS[existsL].c    = row.c || 0;
      state.LOGGED_EVENTS[existsL].u    = row.u || 0;
      state.LOGGED_EVENTS[existsL].gi   = row.gi;
      state.LOGGED_EVENTS[existsL].note = row.note;
      if (rowItems) state.LOGGED_EVENTS[existsL].items = rowItems;
      state.LOGGED_EVENTS[existsL].local = false;
      // BOLUS_EVENTS is a live alias — already updated above.
    } else {
      const ev = { t: row.t, c: row.c || 0, u: row.u || 0, gi: row.gi, note: row.note, items: rowItems, local: false };
      state.LOGGED_EVENTS.push(ev);
      added++;
    }
  });

  return added;
}

function deleteEvent(state, idx) {
  const ev = state.LOGGED_EVENTS[idx];
  const t = ev && ev.t;
  state.LOGGED_EVENTS.splice(idx, 1);
  if (t) {
    state.SESSION = state.SESSION.filter(s => s.t !== t);
    state._deletedEventTs.add(t);
  }
}


// ── 1. Alias invariant ─────────────────────────────────────────────────────

test('BOLUS_EVENTS and LOGGED_EVENTS are the same array reference', () => {
  const s = makeState();
  assert(s.BOLUS_EVENTS === s.LOGGED_EVENTS, 'should be same reference');
});

test('push to LOGGED_EVENTS is visible via BOLUS_EVENTS', () => {
  const s = makeState();
  s.LOGGED_EVENTS.push({ t: 1000, c: 32, u: 0 });
  assertEq(s.BOLUS_EVENTS.length, 1, 'BOLUS_EVENTS should see the push');
  assertEq(s.BOLUS_EVENTS[0].c, 32);
});

test('mutation via LOGGED_EVENTS index is visible via BOLUS_EVENTS', () => {
  const s = makeState();
  s.LOGGED_EVENTS.push({ t: 1000, c: 32, u: 0 });
  s.LOGGED_EVENTS[0].c = 45;
  assertEq(s.BOLUS_EVENTS[0].c, 45, 'mutation should be visible via alias');
});


// ── 2. syncPullEvents — pull updates single array ──────────────────────────

test('pull updates carbs on existing event (the bug this refactor fixes)', () => {
  const s = makeState();
  const t = Date.now() - 1000;
  s.LOGGED_EVENTS.push({ t, c: 30, u: 0, note: 'carbs', local: false });

  const remoteRows = [{ t, c: 40, u: 0, gi: 55, note: 'carbs', items: null }];
  syncPullEvents(s, remoteRows);

  assertEq(s.LOGGED_EVENTS[0].c, 40, 'LOGGED_EVENTS carbs not updated');
  assertEq(s.BOLUS_EVENTS[0].c,  40, 'BOLUS_EVENTS carbs not updated (alias check)');
});

test('pull inserts new event into LOGGED_EVENTS', () => {
  const s = makeState();
  const t = Date.now() - 5000;
  syncPullEvents(s, [{ t, c: 20, u: 0, gi: 55, note: 'carbs', items: null }]);

  assertEq(s.LOGGED_EVENTS.length, 1, 'should have 1 event');
  assertEq(s.BOLUS_EVENTS.length,  1, 'alias should also show 1 event');
  assertEq(s.LOGGED_EVENTS[0].c, 20);
});

test('pull removes stale non-local event no longer in Supabase', () => {
  const s = makeState();
  const t = Date.now() - 5000;
  s.LOGGED_EVENTS.push({ t, c: 30, u: 0, note: 'carbs', local: false });

  // Pull returns nothing → event should be removed
  syncPullEvents(s, []);

  assertEq(s.LOGGED_EVENTS.length, 0, 'stale event should be removed from LOGGED_EVENTS');
  assertEq(s.BOLUS_EVENTS.length,  0, 'stale event should be removed from alias too');
});

test('pull does not remove local:true events absent from Supabase', () => {
  const s = makeState();
  const t = Date.now() - 5000;
  s.LOGGED_EVENTS.push({ t, c: 30, u: 0, note: 'carbs', local: true }); // not yet pushed

  syncPullEvents(s, []); // Supabase returns nothing

  assertEq(s.LOGGED_EVENTS.length, 1, 'local event must survive pull');
});

test('pull respects _deletedEventTs blocklist', () => {
  const s = makeState();
  const t = Date.now() - 5000;
  s._deletedEventTs.add(t); // user deleted this on device

  // Supabase still has it (not yet propagated)
  syncPullEvents(s, [{ t, c: 20, u: 0, gi: 55, note: 'carbs', items: null }]);

  assertEq(s.LOGGED_EVENTS.length, 0, 'deleted event must not be re-added');
});

test('pull skips food_library sentinel rows', () => {
  const s = makeState();
  const t = Date.now() - 5000;
  syncPullEvents(s, [{ t, c: 0, u: 0, note: 'food_library', items: null }]);

  assertEq(s.LOGGED_EVENTS.length, 0, 'food_library row must be skipped');
});

test('backdated event arrives in pull and lands in LOGGED_EVENTS', () => {
  const s = makeState();
  const t = Date.now() - 4 * 3600000; // 4h ago — within 24h window
  syncPullEvents(s, [{ t, c: 35, u: 0, gi: 55, note: 'carbs', items: null }]);

  assertEq(s.LOGGED_EVENTS.length, 1, 'backdated event should be added');
  assertEq(s.LOGGED_EVENTS[0].c, 35);
});

test('pull deduplicates rows with same t (last-write-wins)', () => {
  const s = makeState();
  const t = Date.now() - 2000;
  // Supabase returns two rows with same t — should keep only one
  syncPullEvents(s, [
    { t, c: 30, u: 0, gi: 55, note: 'carbs', items: null },
    { t, c: 40, u: 0, gi: 55, note: 'carbs', items: null }, // last-write-wins
  ]);

  assertEq(s.LOGGED_EVENTS.length, 1, 'should deduplicate to 1 event');
});


// ── 3. Write paths — single-array consistency ──────────────────────────────

function logBolus(state, t, u) {
  state.SESSION.push({ t, c: 0, u });
  state.LOGGED_EVENTS.push({ t, c: 0, u, note: 'bolus', local: true });
}

function logCarbs(state, t, c, gi) {
  state.SESSION.push({ t, c, u: 0, gi });
  state.LOGGED_EVENTS.push({ t, c, u: 0, gi, note: 'plate', local: true });
}

function logHypo(state, t, c) {
  state.SESSION.push({ t, c, u: 0, note: 'hypo:glucose' });
  state.LOGGED_EVENTS.push({ t, c, u: 0, note: 'hypo:glucose', local: true });
}

function logCorrection(state, t, u) {
  state.SESSION.push({ t, c: 0, u });
  state.LOGGED_EVENTS.push({ t, c: 0, u, note: 'correction', local: true });
}

test('bolusNow: event present in LOGGED_EVENTS and visible via BOLUS_EVENTS', () => {
  const s = makeState();
  const t = Date.now();
  logBolus(s, t, 3.5);
  assertEq(s.LOGGED_EVENTS.length, 1);
  assertEq(s.BOLUS_EVENTS.length,  1, 'alias must see bolus');
  assertEq(s.BOLUS_EVENTS[0].u, 3.5);
});

test('logPlate: carb event present in LOGGED_EVENTS', () => {
  const s = makeState();
  const t = Date.now() + 15 * 60000; // eat in 15min
  logCarbs(s, t, 45, 55);
  assertEq(s.LOGGED_EVENTS.length, 1);
  assertEq(s.BOLUS_EVENTS[0].c, 45);
});

test('hypoTreatment: event in LOGGED_EVENTS with correct note', () => {
  const s = makeState();
  const t = Date.now();
  logHypo(s, t, 15);
  assertEq(s.LOGGED_EVENTS[0].note, 'hypo:glucose');
  assertEq(s.BOLUS_EVENTS[0].c, 15);
});

test('logCorrection: event in LOGGED_EVENTS', () => {
  const s = makeState();
  const t = Date.now();
  logCorrection(s, t, 2.0);
  assertEq(s.LOGGED_EVENTS[0].u, 2.0);
  assertEq(s.BOLUS_EVENTS[0].note, 'correction');
});

test('no BOLUS_EVENTS.push calls needed — pushing to LOGGED_EVENTS is sufficient', () => {
  // This test documents the invariant: since BOLUS_EVENTS === LOGGED_EVENTS,
  // a single push to LOGGED_EVENTS is visible via both names.
  const s = makeState();
  assert(s.BOLUS_EVENTS === s.LOGGED_EVENTS, 'prerequisite: must be same reference');
  s.LOGGED_EVENTS.push({ t: 1, c: 0, u: 5 });
  assertEq(s.BOLUS_EVENTS.length, 1, 'one push to LOGGED_EVENTS is enough');
});


// ── 4. deleteEvent ─────────────────────────────────────────────────────────

test('deleteEvent removes from LOGGED_EVENTS by index', () => {
  const s = makeState();
  const t = Date.now();
  s.LOGGED_EVENTS.push({ t, c: 32, u: 0, note: 'carbs', local: true });
  assertEq(s.LOGGED_EVENTS.length, 1);

  deleteEvent(s, 0);

  assertEq(s.LOGGED_EVENTS.length, 0, 'event should be gone from LOGGED_EVENTS');
  assertEq(s.BOLUS_EVENTS.length,  0, 'event should be gone from BOLUS_EVENTS alias');
});

test('deleteEvent adds t to _deletedEventTs blocklist', () => {
  const s = makeState();
  const t = Date.now();
  s.LOGGED_EVENTS.push({ t, c: 0, u: 3, local: true });
  deleteEvent(s, 0);

  assert(s._deletedEventTs.has(t), 'deleted t must be in blocklist');
});

test('deleteEvent removes from SESSION', () => {
  const s = makeState();
  const t = Date.now();
  s.LOGGED_EVENTS.push({ t, c: 0, u: 3, local: true });
  s.SESSION.push({ t, c: 0, u: 3 });

  deleteEvent(s, 0);

  assertEq(s.SESSION.length, 0, 'event should be removed from SESSION too');
});

test('after delete, pull does not re-add event due to blocklist', () => {
  const s = makeState();
  const t = Date.now() - 1000;
  s.LOGGED_EVENTS.push({ t, c: 32, u: 0, note: 'carbs', local: false });
  deleteEvent(s, 0);

  // Supabase still has the event — pull must ignore it
  syncPullEvents(s, [{ t, c: 32, u: 0, gi: 55, note: 'carbs', items: null }]);

  assertEq(s.LOGGED_EVENTS.length, 0, 'deleted event must not be re-added by pull');
});


// ── 5. Startup dedup ───────────────────────────────────────────────────────

test('startup dedup: two events with same t collapse to one', () => {
  const t = Date.now() - 1000;
  let LOGGED_EVENTS = [{ t, c: 30, u: 0 }, { t, c: 30, u: 0 }]; // duplicate t
  const _loadSeenT = {};
  LOGGED_EVENTS = LOGGED_EVENTS.filter(function (e) {
    if (_loadSeenT[e.t]) return false;
    _loadSeenT[e.t] = true;
    return true;
  });
  assertEq(LOGGED_EVENTS.length, 1, 'duplicate t should be removed on startup');
});

test('startup dedup: different t values both survive', () => {
  const t1 = Date.now() - 2000;
  const t2 = Date.now() - 1000;
  let LOGGED_EVENTS = [{ t: t1, c: 30, u: 0 }, { t: t2, c: 20, u: 0 }];
  const _loadSeenT = {};
  LOGGED_EVENTS = LOGGED_EVENTS.filter(function (e) {
    if (_loadSeenT[e.t]) return false;
    _loadSeenT[e.t] = true;
    return true;
  });
  assertEq(LOGGED_EVENTS.length, 2, 'distinct events must both survive dedup');
});


// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
