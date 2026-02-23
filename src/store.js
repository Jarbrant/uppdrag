/* ============================================================
   FIL: src/store.js  (HEL FIL)
   AO 3/15 + AO 2/6 (FAS 1.1) — Store (localStorage state) + migration
   Mål:
   - Spara completedCount (antal klarade missions totalt)
   - Fail-closed: om state trasigt -> reset default + console.warn
   - Migration: om gamla state saknar fält -> fyll med defaults
   Policy: UI-only, localStorage-first, XSS-safe (ingen rendering här)
============================================================ */

/* ============================================================
   BLOCK 1 — Imports
============================================================ */
import { safeJSONParse } from './util.js';

/* ============================================================
   BLOCK 2 — Storage key
============================================================ */
const STORAGE_KEY = 'GAME_STATE_V1'; // HOOK: storage-key

/* ============================================================
   BLOCK 3 — Default state-shape (KRAV)
   State shape:
   {
     profile: { id, createdAt },
     points: number,
     xp: number,
     level: number,
     streak: { count, lastDay },
     history: [ { ts, day, type, points, xp, ... } ],
     completedCount: number   <-- AO 2/6 (FAS 1.1)
   }
============================================================ */
function defaultState() {
  return {
    profile: {
      id: 'demo',
      createdAt: new Date().toISOString()
    },
    points: 0,
    xp: 0,
    level: 1,
    streak: { count: 0, lastDay: '' },
    history: [],
    completedCount: 0 // KRAV: spara antal klarade missions totalt
  };
}

/* ============================================================
   BLOCK 4 — Guard helpers
============================================================ */
function clampInt(n, min, max) {
  const x = Math.floor(Number(n));
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/* ============================================================
   BLOCK 5 — Migration logic (KRAV)
   - Om gamla state saknar completedCount => sätt 0
   - Om andra fält saknas => fyll defaults (utan att krascha)
============================================================ */
function migrateState(raw) {
  const def = defaultState();

  // Fail-closed: fel typ => default
  if (!isPlainObject(raw)) return def;

  const next = { ...def, ...raw };

  // profile
  if (!isPlainObject(next.profile)) next.profile = def.profile;
  if (typeof next.profile.id !== 'string') next.profile.id = def.profile.id;
  if (typeof next.profile.createdAt !== 'string') next.profile.createdAt = def.profile.createdAt;

  // numbers
  next.points = clampInt(next.points, 0, 1_000_000_000);
  next.xp = clampInt(next.xp, 0, 1_000_000_000);
  next.level = clampInt(next.level, 1, 9999);

  // streak
  if (!isPlainObject(next.streak)) next.streak = { ...def.streak };
  next.streak.count = clampInt(next.streak.count, 0, 9999);
  if (typeof next.streak.lastDay !== 'string') next.streak.lastDay = '';

  // history
  if (!Array.isArray(next.history)) next.history = [];
  // keep it bounded
  if (next.history.length > 200) next.history = next.history.slice(next.history.length - 200);

  // AO 2/6: completedCount
  // Fail-closed: saknas => 0
  next.completedCount = clampInt(next.completedCount, 0, 1_000_000_000);

  return next;
}

/* ============================================================
   BLOCK 6 — Storage read/write (fail-closed)
============================================================ */
function readStateFromStorage() {
  try {
    const rawStr = localStorage.getItem(STORAGE_KEY);
    if (!rawStr) return defaultState();

    const parsed = safeJSONParse(rawStr);
    if (!parsed.ok) {
      console.warn('[STORE] State parse failed -> reset', { code: 'STATE_PARSE_FAIL' });
      return defaultState();
    }

    return migrateState(parsed.value);
  } catch (e) {
    console.warn('[STORE] Storage read failed -> reset', { code: 'STORAGE_READ_FAIL' });
    return defaultState();
  }
}

function writeStateToStorage(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (_) {
    console.warn('[STORE] Storage write failed -> read-only mode', { code: 'STORAGE_WRITE_FAIL' });
    return false;
  }
}

/* ============================================================
   BLOCK 7 — Store implementation
============================================================ */
export function createStore() {
  let _state = defaultState();
  let _subs = [];

  function notify() {
    for (const fn of _subs) {
      try { fn(_state); } catch (_) {}
    }
  }

  function init() {
    _state = readStateFromStorage();
    notify();
  }

  function getState() {
    return _state;
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    _subs.push(fn);
    return () => {
      _subs = _subs.filter((x) => x !== fn);
    };
  }

  function update(mutatorFn) {
    // Fail-closed: om mutator inte är funktion => avbryt
    if (typeof mutatorFn !== 'function') return { ok: false, code: 'MUTATOR_BAD' };

    // Kör mutation på en shallow copy (räcker för vår state)
    let next;
    try {
      next = mutatorFn({ ..._state });
      if (!next || typeof next !== 'object') next = { ..._state };
    } catch (e) {
      console.warn('[STORE] update failed', { code: 'UPDATE_THROW' });
      return { ok: false, code: 'UPDATE_THROW' };
    }

    // Migrate/validate igen (fail-closed)
    const migrated = migrateState(next);

    // Persist
    const ok = writeStateToStorage(migrated);
    _state = migrated;

    notify();

    return { ok, code: ok ? 'OK' : 'STORAGE_WRITE_FAIL' };
  }

  function reset() {
    const s = defaultState();
    writeStateToStorage(s);
    _state = s;
    notify();
  }

  return { init, getState, subscribe, update, reset };
}
