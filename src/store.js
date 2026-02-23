/* ============================================================
   FIL: src/store.js  (HEL FIL)
   AO 3/15 — Store (localStorage state) — fail-closed
   Policy: UI-only, XSS-safe (ingen rendering här), robusthet först
============================================================ */

/* ============================================================
   BLOCK 1 — Imports
============================================================ */
import { safeJSONParse, nowISO } from './util.js';

/* ============================================================
   BLOCK 2 — Storage config
   HOOK: STORAGE_KEY (används av UI/engine)
============================================================ */
export const STORAGE_KEY = 'GAME_STATE_V1'; // HOOK: storage-key (localStorage state)

/* ============================================================
   BLOCK 3 — Default state model (KRAV: profil, xp, level, streak, historik)
============================================================ */
export function defaultState() {
  const createdAt = nowISO();
  return {
    version: 1,
    profile: {
      displayName: '',       // HOOK: profile-displayName (UI binder senare)
      createdAt
    },
    xp: 0,
    level: 1,
    points: 0,
    streak: {
      count: 0,
      lastDay: ''            // YYYY-MM-DD (local day) // HOOK: streak-lastDay
    },
    history: []              // senaste händelser (missions etc) // HOOK: history-array
  };
}

/* ============================================================
   BLOCK 4 — Validators (fail-closed)
============================================================ */
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isNonNegInt(n) {
  return Number.isFinite(n) && n >= 0 && Math.floor(n) === n;
}

function isValidDayString(s) {
  if (typeof s !== 'string') return false;
  if (!s) return true; // tillåter tom default
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function validateStateShape(s) {
  if (!isPlainObject(s)) return { ok: false, code: 'STATE_NOT_OBJECT' };

  if (!isPlainObject(s.profile)) return { ok: false, code: 'PROFILE_BAD' };
  if (typeof s.profile.displayName !== 'string') return { ok: false, code: 'PROFILE_NAME_BAD' };
  if (typeof s.profile.createdAt !== 'string') return { ok: false, code: 'PROFILE_CREATED_BAD' };

  if (!isNonNegInt(s.xp)) return { ok: false, code: 'XP_BAD' };
  if (!isNonNegInt(s.level) || s.level < 1) return { ok: false, code: 'LEVEL_BAD' };
  if (!isNonNegInt(s.points)) return { ok: false, code: 'POINTS_BAD' };

  if (!isPlainObject(s.streak)) return { ok: false, code: 'STREAK_BAD' };
  if (!isNonNegInt(s.streak.count)) return { ok: false, code: 'STREAK_COUNT_BAD' };
  if (!isValidDayString(s.streak.lastDay)) return { ok: false, code: 'STREAK_DAY_BAD' };

  if (!Array.isArray(s.history)) return { ok: false, code: 'HISTORY_BAD' };

  return { ok: true, code: 'OK' };
}

/* ============================================================
   BLOCK 5 — Safe load/save (fail-closed)
============================================================ */
function safeReadLocalStorage(key) {
  try {
    return window.localStorage.getItem(key);
  } catch (_) {
    return null;
  }
}

function safeWriteLocalStorage(key, value) {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch (_) {
    return false;
  }
}

function safeRemoveLocalStorage(key) {
  try {
    window.localStorage.removeItem(key);
    return true;
  } catch (_) {
    return false;
  }
}

function resetToDefault(reasonCode) {
  const s = defaultState();

  // Fail-closed: tydlig logg (ingen känslig data)
  console.error('[STORE] RESET_DEFAULT', { reason: reasonCode || 'UNKNOWN' });

  // Försök spara default (men fortsätt även om storage är trasigt)
  safeWriteLocalStorage(STORAGE_KEY, JSON.stringify(s));
  return s;
}

/* ============================================================
   BLOCK 6 — Store implementation
   - Fail-closed: trasigt state => reset default + return
   - update(fn): muterar via kopia och validerar innan commit
============================================================ */
export function createStore() {
  let state = null;
  const listeners = new Set();

  function notify() {
    listeners.forEach((fn) => {
      try { fn(getState()); } catch (_) { /* fail-soft */ }
    });
  }

  function getState() {
    if (!state) {
      // Lazy init om init() inte anropats
      init();
    }
    // Returnera en “safe-ish” copy för att minska oavsiktliga mutationer
    return structuredClone ? structuredClone(state) : JSON.parse(JSON.stringify(state));
  }

  function init() {
    const raw = safeReadLocalStorage(STORAGE_KEY);
    const parsed = safeJSONParse(raw, null);

    if (!parsed) {
      state = resetToDefault('STATE_MISSING_OR_UNPARSABLE');
      notify();
      return state;
    }

    const v = validateStateShape(parsed);
    if (!v.ok) {
      state = resetToDefault(v.code);
      notify();
      return state;
    }

    state = parsed;
    notify();
    return state;
  }

  function save(nextState) {
    // Fail-closed: validera innan commit
    const v = validateStateShape(nextState);
    if (!v.ok) {
      state = resetToDefault('SAVE_REJECTED_' + v.code);
      notify();
      return { ok: false, code: v.code, state: getState() };
    }

    state = nextState;

    const ok = safeWriteLocalStorage(STORAGE_KEY, JSON.stringify(state));
    if (!ok) {
      // Storage trasig => fail-closed: behåll state i minne men logga
      console.error('[STORE] SAVE_FAILED_STORAGE', { code: 'LS_WRITE_FAIL' });
      // OBS: vi crashar inte — UI kan fortsätta i sessionen
    }

    notify();
    return { ok: true, code: 'OK', state: getState() };
  }

  function update(mutatorFn) {
    if (typeof mutatorFn !== 'function') {
      return { ok: false, code: 'MUTATOR_NOT_FUNCTION', state: getState() };
    }

    const current = getState();
    let draft = current;

    try {
      const result = mutatorFn(draft);
      // Tillåt mutator att returnera ett helt nytt state
      if (result && typeof result === 'object') draft = result;
    } catch (e) {
      console.error('[STORE] UPDATE_FAILED', { code: 'MUTATOR_THROW' });
      return { ok: false, code: 'MUTATOR_THROW', state: getState() };
    }

    return save(draft);
  }

  function reset() {
    safeRemoveLocalStorage(STORAGE_KEY);
    state = resetToDefault('MANUAL_RESET');
    notify();
    return getState();
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return {
    init,        // HOOK: store-init
    getState,    // HOOK: store-get
    update,      // HOOK: store-update
    reset,       // HOOK: store-reset
    subscribe    // HOOK: store-subscribe
  };
}
