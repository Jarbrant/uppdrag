/* ============================================================
   FIL: src/boot.js  (HEL FIL)
   AO 2/15 + AO 11/15 (PATCH) — Boot routing (subpath-safe)
   AO 6/6 (FAS 1.2) — Boot stöd för party via payload (admin-export)
   Mål: QR-länk ska “bara funka” även under /uppdrag/
   Nytt:
   - Stöd för mode=party + payload=... (id blir optional för party)
   - Fail-closed validering av payload (decode + JSON shape)
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
  INVALID_ID: 'INVALID_ID',

  // AO 6/6: party kan startas med payload istället för id
  MISSING_ID_OR_PAYLOAD: 'MISSING_ID_OR_PAYLOAD',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD'
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

// AO 6/6 — payload validation (fail-closed)
// OBS: Admin-export kan råka bli dubbel-URL-encoded, så vi provar decode 1–2 ggr.
function safeDecodePayload(raw) {
  const s = (raw ?? '').toString().trim();
  if (!s) return { ok: false, value: '' };

  // 1) decode 1 gång
  try {
    const once = decodeURIComponent(s);
    // Om det fortfarande innehåller mycket %7B/%22 kan det vara dubbel-enc.
    // Vi provar en gång till, men fail-closed om det kraschar.
    try {
      const twice = decodeURIComponent(once);
      // Välj den som ser mest ut som JSON
      const best = looksLikeJSON(twice) ? twice : once;
      return { ok: true, value: best };
    } catch (_) {
      return { ok: true, value: once };
    }
  } catch (_) {
    // Om decode kraschar: kanske redan är plain JSON
    return { ok: true, value: s };
  }
}

function looksLikeJSON(str) {
  const t = (str ?? '').toString().trim();
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
}

function safeJSONParse(str) {
  try {
    return { ok: true, value: JSON.parse(str) };
  } catch (_) {
    return { ok: false, value: null };
  }
}

function isValidPartyPayload(obj) {
  // Draft shape (från admin.js):
  // { version:1, name:string, checkpointCount:1..20, pointsPerCheckpoint:0..1000, clues:string[] }
  if (!obj || typeof obj !== 'object') return false;

  const v = Number(obj.version);
  if (!Number.isFinite(v) || v !== 1) return false;

  const name = (obj.name ?? '').toString().trim();
  if (name.length < 2 || name.length > 60) return false;

  const cc = Number(obj.checkpointCount);
  if (!Number.isFinite(cc) || cc < 1 || cc > 20) return false;

  const pp = Number(obj.pointsPerCheckpoint);
  if (!Number.isFinite(pp) || pp < 0 || pp > 1000) return false;

  if (!Array.isArray(obj.clues) || obj.clues.length !== cc) return false;

  for (let i = 0; i < obj.clues.length; i++) {
    const t = (obj.clues[i] ?? '').toString().trim();
    if (t.length < 3 || t.length > 140) return false;
  }

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

  const rawMode = qsGet('mode');    // HOOK: qs-mode
  const rawId = qsGet('id');        // HOOK: qs-id
  const rawPayload = qsGet('payload'); // HOOK: qs-payload (AO 6/6)

  // Om inga params: gör inget
  if (!rawMode && !rawId && !rawPayload) return;

  if (!rawMode) return redirectToIndex(ERR.MISSING_MODE);

  const mode = normalizeMode(rawMode);
  if (!mode) return redirectToIndex(ERR.INVALID_MODE);

  // =========================================================
  // Zone kräver alltid id (som innan)
  // =========================================================
  if (mode === 'zone') {
    if (!rawId) return redirectToIndex(ERR.MISSING_ID);
    if (!isValidId(rawId)) return redirectToIndex(ERR.INVALID_ID);

    const targetRel = ROUTES[mode];
    if (!targetRel) return redirectToIndex(ERR.INVALID_MODE);

    const base = currentBaseUrl();
    const target = new URL(targetRel, base.toString());
    target.searchParams.set('mode', mode);
    target.searchParams.set('id', rawId);

    window.location.assign(target.toString());
    return;
  }

  // =========================================================
  // Party: tillåt id ELLER payload (AO 6/6)
  // =========================================================
  if (mode === 'party') {
    const hasId = !!(rawId && isValidId(rawId));
    const hasPayload = !!(rawPayload && rawPayload.toString().trim());

    if (!hasId && !hasPayload) return redirectToIndex(ERR.MISSING_ID_OR_PAYLOAD);

    // Om payload finns: validera fail-closed innan routing
    if (hasPayload) {
      const decoded = safeDecodePayload(rawPayload);
      if (!decoded.ok) return redirectToIndex(ERR.INVALID_PAYLOAD);

      const parsed = safeJSONParse(decoded.value);
      if (!parsed.ok) return redirectToIndex(ERR.INVALID_PAYLOAD);

      if (!isValidPartyPayload(parsed.value)) return redirectToIndex(ERR.INVALID_PAYLOAD);
    }

    const targetRel = ROUTES[mode];
    if (!targetRel) return redirectToIndex(ERR.INVALID_MODE);

    const base = currentBaseUrl();
    const target = new URL(targetRel, base.toString());
    target.searchParams.set('mode', mode);

    // Prioritet: payload om det finns, annars id
    if (hasPayload) target.searchParams.set('payload', rawPayload);
    else target.searchParams.set('id', rawId);

    window.location.assign(target.toString());
    return;
  }

  // Fallback (ska ej nås)
  redirectToIndex(ERR.INVALID_MODE);
})();
