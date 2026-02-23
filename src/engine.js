/* ============================================================
   FIL: src/engine.js  (HEL FIL)
   AO 3/15 + AO 10/15 + AO 12/15 — Engine: progression + unlock
   - Behåller befintliga exports/API
   - Lägger till (AO-12):
       completedCount(state)
       isNormalUnlocked(state, threshold=15)
   Policy: deterministiskt, robust, fail-closed i inputs
============================================================ */

/* ============================================================
   BLOCK 1 — Imports
============================================================ */
import { clamp, nowISO } from './util.js';

/* ============================================================
   BLOCK 2 — Level rules
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

  if (last === today) return s;

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
  const s = state;
  if (!s || typeof s !== 'object') {
    console.error('[ENGINE] awardMissionComplete FAIL', { code: 'STATE_BAD' });
    return null;
  }

  const p = payload && typeof payload === 'object' ? payload : {};
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
    type: 'mission_complete',
    points: addPoints,
    xp: addXp,
    levelAfter: s.level
  };

  s.history.push(entry);
  if (s.history.length > 200) s.history = s.history.slice(s.history.length - 200);

  return s;
}

/* ============================================================
   BLOCK 6 — awardCheckpointComplete (AO-10)
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
  if (s.history.length > 200) s.history = s.history.slice(s.history.length - 200);

  return s;
}

/* ============================================================
   BLOCK 7 — Difficulty unlock (AO-12)
   KRAV:
   - Engine håller completedCount och isNormalUnlocked()
   NOTE: Vi håller detta utan ny store-shape genom att räkna history.
============================================================ */
export const NORMAL_UNLOCK_AFTER = 15; // HOOK: normal-unlock-after

export function completedCount(state) {
  const s = state;
  const hist = Array.isArray(s?.history) ? s.history : [];
  let count = 0;

  for (const h of hist) {
    if (!h || typeof h !== 'object') continue;
    if (h.type === 'mission_complete') count += 1;
  }

  return count;
}

export function isNormalUnlocked(state, threshold = NORMAL_UNLOCK_AFTER) {
  const t = Math.floor(Number(threshold));
  const need = Number.isFinite(t) && t > 0 ? t : NORMAL_UNLOCK_AFTER;
  return completedCount(state) >= need;
}
