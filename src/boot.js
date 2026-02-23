/* ============================================================
   FIL: src/boot.js  (HEL FIL)
   AO 2/15 + AO 11/15 — Boot routing (URL → rätt sida) + fail-closed
   Mål: QR-länk ska “bara funka”
   - /?mode=zone&id=skogsrundan  -> pages/play.html?mode=zone&id=skogsrundan
   - /?mode=party&id=kalas_demo  -> pages/party.html?mode=party&id=kalas_demo
   Policy: UI-only (GitHub Pages), inga nya storage keys, XSS-safe
============================================================ */

/* ============================================================
   BLOCK 1 — Imports
============================================================ */
import { qsGet, uid } from './util.js';

/* ============================================================
   BLOCK 2 — Routing targets (KRAV)
   OBS: använd RELATIVA paths för att fungera på GitHub Pages repo-subpath.
============================================================ */
const ROUTES = Object.freeze({
  zone: './pages/play.html',   // HOOK: route-target-zone
  party: './pages/party.html'  // HOOK: route-target-party
});

/* ============================================================
   BLOCK 3 — Error codes (fail-closed)
============================================================ */
const ERR = Object.freeze({
  MISSING_MODE: 'MISSING_MODE',
  INVALID_MODE: 'INVALID_MODE',
  MISSING_ID: 'MISSING_ID',
  INVALID_ID: 'INVALID_ID'
});

/* ============================================================
   BLOCK 4 — Validation (fail-closed)
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
   BLOCK 5 — Redirect helper
   - Till index med err=... (KRAV)
   - rid=<requestId> för spårbarhet (ingen storage)
============================================================ */
function redirectToIndex(errCode) {
  const code = (errCode || 'UNKNOWN').toString().trim() || 'UNKNOWN';
  const rid = uid('rid'); // HOOK: requestId

  // Viktigt: RELATIVT index för GitHub Pages
  const url = new URL('./index.html', window.location.href);
  url.searchParams.set('err', code);
  url.searchParams.set('rid', rid);

  window.location.assign(url.toString());
}

/* ============================================================
   BLOCK 6 — Main boot
   - Kör bara om mode/id finns i URL (annars: gör inget på index).
   - Fail-closed om partial/ogiltigt.
============================================================ */
(function boot() {
  'use strict';

  // INIT-GUARD
  if (window.__AO11_BOOT_INIT__) return; // HOOK: init-guard-boot
  window.__AO11_BOOT_INIT__ = true;

  const rawMode = qsGet('mode'); // HOOK: qs-mode
  const rawId = qsGet('id');     // HOOK: qs-id

  // Om inga params: boot gör inget (så index utan QR inte loopar)
  if (!rawMode && !rawId) return;

  // Om någon param saknas: fail-closed
  if (!rawMode) return redirectToIndex(ERR.MISSING_MODE);
  if (!rawId) return redirectToIndex(ERR.MISSING_ID);

  const mode = normalizeMode(rawMode);
  if (!mode) return redirectToIndex(ERR.INVALID_MODE);

  if (!isValidId(rawId)) return redirectToIndex(ERR.INVALID_ID);

  const targetPath = ROUTES[mode];
  if (!targetPath) return redirectToIndex(ERR.INVALID_MODE);

  // Bygg target URL och behåll mode/id
  const target = new URL(targetPath, window.location.href);
  target.searchParams.set('mode', mode);
  target.searchParams.set('id', rawId);

  window.location.assign(target.toString());
})();
