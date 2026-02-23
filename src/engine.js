/* ============================================================
   FIL: src/engine.js  (HEL FIL)
   AO 3/15 + AO 10/15 — Engine: poäng/XP/level + streak per dag
   - Behåller befintliga exports/API
   - Lägger till: awardCheckpointComplete() (separat från mission)
   Policy: deterministiskt, robust, fail-closed i inputs
============================================================ */

/* ============================================================
   BLOCK 1 — Imports
============================================================ */
import { clamp, nowISO } from './util.js';

/* ============================================================
   BLOCK 2 — Level rules
   KRAV: calcLevel(xp)
   - Enkel, stabil modell: 0–99 => lvl 1, 100–199 => lvl 2, osv.
============================================================ */
export function calcLevel(xp) {
  const x = Number(xp);
  if (!Number.isFinite(x) || x < 0) return 1;
  return Math.floor(x / 100) + 1;
}

/* ============================================================
   BLOCK 3 — Day helpers (streak per dag)
============================================================ */
function pad2(n) { return String(n).padStart(2, '0'); }

export function localDayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date();
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  return `${y}-${m}-${day}`; // YYYY-MM-DD
}

function dayDiff(a, b) {
  // a,b = YYYY-MM-DD (local). Beräkna diff i dagar genom att tolka som local midnatt.
  // Fail-soft: om fel format => stor diff => streak reset
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return 999;

  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);

  const da = new Date(ay, am - 1, ad, 0, 0, 0, 0);
  const db = new Date(by, bm - 1, bd, 0, 0, 0, 0);

  const ms = db.getTime() - da.getTime();
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

/* ============================================================
   BLOCK 4 — Streak logic
   - Om första logg => streak = 1
   - Om samma dag => ingen ändring
   - Om igår => +1
   - Annars => reset till 1
============================================================ */
export function applyStreak(state, dayKey) {
  const s = state;
  const today = dayKey || localDayKey(new Date());

  if (!s.streak || typeof s.streak !== 'object') {
    s.streak = { count: 0, lastDay: '' };
  }

  const last = (s.streak.lastDay || '').toString();
  const count = Number(s.streak.count);

  if (!last) {
    s.streak.count = 1;
    s.streak.lastDay = today;
    return s;
  }

  if (last === today) {
    return s;
  }

  const diff = dayDiff(last, today);
  if (diff === 1) {
    s.streak.count = clamp(Number.isFinite(count) ? count + 1 : 1, 1, 9999);
    s.streak.lastDay = today;
    return s;
  }

  s.streak.count = 1;
  s.streak.lastDay = today;
  return s;
}

/* ============================================================
   BLOCK 5 — awardMissionComplete
   KRAV: awardMissionComplete({points,xp})
============================================================ */
export function awardMissionComplete(state, payload) {
  // Fail-closed input guards
  const s = state;
  if (!s || typeof s !== 'object') {
    console.error('[ENGINE] awardMissionComplete FAIL', { code: 'STATE_BAD' });
    return null;
  }

  const p = payload && typeof payload === 'object' ? payload : {};
  const addPoints = clamp(Math.floor(Number(p.points || 0)), 0, 1_000_000);
  const addXp = clamp(Math.floor(Number(p.xp || 0)), 0, 1_000_000);

  // Säkerställ shape (minimalt, store validerar ändå)
  s.points = clamp(Math.floor(Number(s.points || 0)), 0, 1_000_000_000) + addPoints;
  s.xp = clamp(Math.floor(Number(s.xp || 0)), 0, 1_000_000_000) + addXp;

  const nextLevel = calcLevel(s.xp);
  s.level = clamp(nextLevel, 1, 9999);

  // Streak
  const dayKey = localDayKey(new Date());
  applyStreak(s, dayKey);

  // History
  if (!Array.isArray(s.history)) s.history = [];
  const entry = {
    ts: nowISO(),
    day: dayKey,
    type: 'mission_complete',
    points: addPoints,
    xp: addXp,
    levelAfter: s.level
  };

  s.history.push(entry);

  // Keep last 200 entries
  if (s.history.length > 200) {
    s.history = s.history.slice(s.history.length - 200);
  }

  return s;
}

/* ============================================================
   BLOCK 6 — awardCheckpointComplete (AO-10)
   KRAV: Engine: awardCheckpointComplete() separat från mission.
   - Uppdaterar points/xp/level
   - Uppdaterar streak per dag (checkpoint räknas som aktivitet)
   - Lägger history-entry med partyId + checkpointIndex
   - Ingen ny store shape krävs: progress kan härledas från history
============================================================ */
export function awardCheckpointComplete(state, payload) {
  const s = state;
  if (!s || typeof s !== 'object') {
    console.error('[ENGINE] awardCheckpointComplete FAIL', { code: 'STATE_BAD' });
    return null;
  }

  const p = payload && typeof payload === 'object' ? payload : {};
  const partyId = (p.partyId ?? '').toString().trim();
  const checkpointIndex = Math.floor(Number(p.checkpointIndex));

  // Fail-closed payload basics
  if (!partyId) {
    console.error('[ENGINE] awardCheckpointComplete FAIL', { code: 'PARTY_ID_MISSING' });
    return null;
  }
  if (!Number.isFinite(checkpointIndex) || checkpointIndex < 0 || checkpointIndex > 9999) {
    console.error('[ENGINE] awardCheckpointComplete FAIL', { code: 'CHECKPOINT_INDEX_BAD' });
    return null;
  }

  const addPoints = clamp(Math.floor(Number(p.points || 0)), 0, 1_000_000);
  const addXp = clamp(Math.floor(Number(p.xp || 0)), 0, 1_000_000);

  s.points = clamp(Math.floor(Number(s.points || 0)), 0, 1_000_000_000) + addPoints;
  s.xp = clamp(Math.floor(Number(s.xp || 0)), 0, 1_000_000_000) + addXp;

  const nextLevel = calcLevel(s.xp);
  s.level = clamp(nextLevel, 1, 9999);

  const dayKey = localDayKey(new Date());
  applyStreak(s, dayKey);

  if (!Array.isArray(s.history)) s.history = [];
  const entry = {
    ts: nowISO(),
    day: dayKey,
    type: 'checkpoint_complete',
    partyId,
    checkpointIndex,
    points: addPoints,
    xp: addXp,
    levelAfter: s.level
  };

  s.history.push(entry);

  if (s.history.length > 200) {
    s.history = s.history.slice(s.history.length - 200);
  }

  return s;
}
