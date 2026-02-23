/* ============================================================
   FIL: src/boot.js  (HEL FIL)
   AO 2/15 — Boot routing (URL → rätt sida) + fail-closed
   Policy: UI-only (GitHub Pages), inga nya storage keys, XSS-safe
============================================================ */

/* ============================================================
   BLOCK 1 — Imports
============================================================ */
import { qsGet, uid } from './util.js';

/* ============================================================
   BLOCK 2 — Routing targets (kontrakt)
   - HOOK: Dessa paths kan ändras i senare AO när riktiga sidor finns.
   - "zone"  = zonpaket (Naturjakt)
   - "party" = kalaspaket (Skattjakt)
============================================================ */
const ROUTES = Object.freeze({
  zone: '/zone/index.html',   // HOOK: route-target-zone
  party: '/party/index.html'  // HOOK: route-target-party
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
   BLOCK 4 — Validation
   - Fail-closed: minsta osäkerhet => error redirect
============================================================ */
function normalizeMode(raw) {
  const m = (raw || '').toString().trim().toLowerCase();

  // Tillåt bara exakt "zone" eller "party"
  if (m === 'zone' || m === 'party') return m;
  return '';
}

function isValidId(raw) {
  const id = (raw || '').toString().trim();

  // Fail-closed: kräver 1..64 tecken, begränsat set (URL-safe)
  // OBS: Detta är en UI-guard, inte en säkerhet mot server.
  if (!id) return false;
  if (id.length < 1 || id.length > 64) return false;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return false;
  return true;
}

/* ============================================================
   BLOCK 5 — Redirect helper
   - Skickar tillbaka till /index.html med err=...
   - Lägger med rid=<requestId> för spårbarhet (ingen storage)
   - HOOK: index.html kan visa err + rid i UI senare
============================================================ */
function redirectToIndex(errCode) {
  const code = (errCode || 'UNKNOWN').toString().trim() || 'UNKNOWN';
  const rid = uid('rid'); // HOOK: requestId

  // Bygg URL med tydliga params (ingen raw stack / ingen känslig data)
  const url = new URL('/index.html', window.location.origin);
  url.searchParams.set('err', code);
  url.searchParams.set('rid', rid);

  // Fail-closed: hård navigation
  window.location.assign(url.toString());
}

/* ============================================================
   BLOCK 6 — Main boot
   KRAV:
   - Läs mode (zone|party) och id från querystring
   - Fail-closed: saknas/ogiltigt → tillbaka till /index.html?err=...
============================================================ */
(function boot() {
  'use strict';

  // INIT-GUARD: undvik dubbel boot (t.ex. om script inkluderas flera gånger)
  if (window.__AO2_BOOT_INIT__) return; // HOOK: init-guard-boot
  window.__AO2_BOOT_INIT__ = true;

  const rawMode = qsGet('mode'); // HOOK: qs-mode
  const rawId = qsGet('id');     // HOOK: qs-id

  if (!rawMode) return redirectToIndex(ERR.MISSING_MODE);

  const mode = normalizeMode(rawMode);
  if (!mode) return redirectToIndex(ERR.INVALID_MODE);

  if (!rawId) return redirectToIndex(ERR.MISSING_ID);
  if (!isValidId(rawId)) return redirectToIndex(ERR.INVALID_ID);

  const targetPath = ROUTES[mode];
  if (!targetPath) return redirectToIndex(ERR.INVALID_MODE);

  // Bygg target URL och behåll mode/id för nästa sida (UI-only routing)
  const target = new URL(targetPath, window.location.origin);
  target.searchParams.set('mode', mode);
  target.searchParams.set('id', rawId);

  // HOOK: framtida params (ex: campaign, lang, debug) kan whitelistas här
  // Exempel: const lang = qsGet('lang'); if (lang) target.searchParams.set('lang', lang);

  window.location.assign(target.toString());
})();
