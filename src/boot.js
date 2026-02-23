/* ============================================================
   FIL: src/boot.js  (HEL FIL)
   AO 2/15 + AO 11/15 (PATCH) — Boot routing (subpath-safe)
   Mål: QR-länk ska “bara funka” även under /uppdrag/
============================================================ */

/* ============================================================
   BLOCK 1 — Imports
============================================================ */
import { qsGet, uid } from './util.js';

/* ============================================================
   BLOCK 2 — Routing targets (KRAV)
   FIX: bygg relativt current directory så /uppdrag/ följer med.
============================================================ */
const ROUTES = Object.freeze({
  zone: 'pages/play.html',   // HOOK: route-target-zone
  party: 'pages/party.html'  // HOOK: route-target-party
});

/* ============================================================
   BLOCK 3 — Error codes
============================================================ */
const ERR = Object.freeze({
  MISSING_MODE: 'MISSING_MODE',
  INVALID_MODE: 'INVALID_MODE',
  MISSING_ID: 'MISSING_ID',
  INVALID_ID: 'INVALID_ID'
});

/* ============================================================
   BLOCK 4 — Validation
============================================================ */
function normalizeMode(raw) {
  const m = (raw || '').toString().trim().toLowerCase();
  if (m === 'zone' || m === 'party') return m;
  return '';
}

function isValidId(raw) {
  const id = (raw || '').toString().trim();
  if (!id) return false;
  if (id.length < 1 || id.length > 64) return false;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return false;
  return true;
}

/* ============================================================
   BLOCK 5 — Helpers
============================================================ */
function currentBaseUrl() {
  // Gör base = katalogen vi står i, så det funkar på /uppdrag/
  const u = new URL(window.location.href);
  const p = u.pathname;
  u.pathname = p.endsWith('/') ? p : p.substring(0, p.lastIndexOf('/') + 1);
  u.search = '';
  u.hash = '';
  return u;
}

function redirectToIndex(errCode) {
  const code = (errCode || 'UNKNOWN').toString().trim() || 'UNKNOWN';
  const rid = uid('rid');

  const base = currentBaseUrl();
  base.pathname = base.pathname; // (för tydlighet)
  base.searchParams.set('err', code);
  base.searchParams.set('rid', rid);

  // Index ligger i base root (index.html)
  const url = new URL('index.html', base.toString());
  url.search = base.search;

  window.location.assign(url.toString());
}

/* ============================================================
   BLOCK 6 — Main boot
============================================================ */
(function boot() {
  'use strict';

  if (window.__AO11_BOOT_INIT__) return; // HOOK: init-guard-boot
  window.__AO11_BOOT_INIT__ = true;

  const rawMode = qsGet('mode'); // HOOK: qs-mode
  const rawId = qsGet('id');     // HOOK: qs-id

  // Om inga params: gör inget
  if (!rawMode && !rawId) return;

  if (!rawMode) return redirectToIndex(ERR.MISSING_MODE);
  if (!rawId) return redirectToIndex(ERR.MISSING_ID);

  const mode = normalizeMode(rawMode);
  if (!mode) return redirectToIndex(ERR.INVALID_MODE);

  if (!isValidId(rawId)) return redirectToIndex(ERR.INVALID_ID);

  const targetRel = ROUTES[mode];
  if (!targetRel) return redirectToIndex(ERR.INVALID_MODE);

  // Bygg target relativt base (/uppdrag/)
  const base = currentBaseUrl();
  const target = new URL(targetRel, base.toString());
  target.searchParams.set('mode', mode);
  target.searchParams.set('id', rawId);

  window.location.assign(target.toString());
})();
