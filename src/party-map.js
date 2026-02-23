/* ============================================================
   FIL: src/party-map.js  (NY FIL)
   /* AO 4/8 (FAS 1.5) — Deltagarvy: karta + checkpoint 1 + kod */
   Mål:
   - Läsa payload (eller partyId/id)
   - Rendera Leaflet-karta + marker för första checkpoint
   - Visa ledtråd + kod-input + OK
   Fail-closed:
   - saknas payload/id → error card + tillbaka
   Policy: UI-only, Leaflet via CDN, inga externa libs
============================================================ */

/* ============================================================
   BLOCK 1 — DOM hooks
============================================================ */
const $ = (sel) => document.querySelector(sel);

const elBack = $('#backBtn');         // HOOK: back-button
const elStatusSlot = $('#statusSlot'); // HOOK: status-slot
const elName = $('#partyName');       // HOOK: party-name
const elClue = $('#clueText');        // HOOK: clue-text
const elCode = $('#codeInput');       // HOOK: code-input
const elErrCode = $('#errCode');      // HOOK: err-code
const elOk = $('#okBtn');             // HOOK: ok-button
const elMap = $('#partyMap');         // HOOK: party-map
const elMapError = $('#mapError');    // HOOK: map-error

/* ============================================================
   BLOCK 2 — UI helpers (fail-closed)
============================================================ */
function setText(node, text) {
  if (!node) return;
  node.textContent = (text ?? '').toString();
}

function showStatus(message, type = 'info') {
  if (!elStatusSlot) return;
  elStatusSlot.innerHTML = '';
  const div = document.createElement('div');
  div.className = `toast toast--${type === 'danger' ? 'danger' : type === 'warn' ? 'warn' : 'info'}`;
  div.setAttribute('role', 'status');
  div.textContent = (message ?? '').toString();
  elStatusSlot.appendChild(div);
}

function showMapError(message) {
  setText(elMapError, message || '');
}

function redirectToIndex(errCode = 'PARTY_MISSING_PAYLOAD') {
  const url = new URL('../index.html', window.location.href);
  url.searchParams.set('err', errCode);
  window.location.assign(url.toString());
}

/* ============================================================
   BLOCK 3 — Query helpers
============================================================ */
function qsGet(key) {
  const usp = new URLSearchParams(window.location.search || '');
  return (usp.get(String(key)) ?? '').toString().trim();
}

function safeDecodePayload(raw) {
  const s = (raw ?? '').toString().trim();
  if (!s) return { ok: false, value: '' };

  // Försök decode 1–2 gånger (admin kan råka dubbel-encoda)
  try {
    const once = decodeURIComponent(s);
    try {
      const twice = decodeURIComponent(once);
      const best = looksLikeJSON(twice) ? twice : once;
      return { ok: true, value: best };
    } catch (_) {
      return { ok: true, value: once };
    }
  } catch (_) {
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

/* ============================================================
   BLOCK 4 — Payload → first checkpoint model
   Inline policy:
   - payload är JSON (v1) från admin:
     { version, name, checkpointCount, pointsPerCheckpoint, clues, geo[]? }
   - Vi använder geo[0] om lat/lng finns, annars faller tillbaka till clue utan position.
============================================================ */
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function asText(x) {
  return (x ?? '').toString().trim();
}

function clampInt(n, min, max) {
  const x = Math.floor(Number(n));
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function isValidPayloadV1(obj) {
  if (!isPlainObject(obj)) return false;
  if (Number(obj.version) !== 1) return false;

  const name = asText(obj.name);
  if (name.length < 2 || name.length > 60) return false;

  const cc = Number(obj.checkpointCount);
  if (!Number.isFinite(cc) || cc < 1 || cc > 20) return false;

  const pp = Number(obj.pointsPerCheckpoint);
  if (!Number.isFinite(pp) || pp < 0 || pp > 1000) return false;

  if (!Array.isArray(obj.clues) || obj.clues.length !== cc) return false;
  for (let i = 0; i < obj.clues.length; i++) {
    const t = asText(obj.clues[i]);
    if (t.length < 3 || t.length > 140) return false;
  }

  return true;
}

function getFirstCheckpointFromPayload(payload) {
  const clue = asText(payload.clues?.[0] ?? '—');
  const geo0 = Array.isArray(payload.geo) ? payload.geo[0] : null;

  const lat = geo0 && Number.isFinite(Number(geo0.lat)) ? Number(geo0.lat) : null;
  const lng = geo0 && Number.isFinite(Number(geo0.lng)) ? Number(geo0.lng) : null;
  const radius = clampInt(geo0?.radius ?? 25, 5, 5000);
  const code = asText(geo0?.code ?? '');

  return { clue, lat, lng, radius, code };
}

/* ============================================================
   BLOCK 5 — Leaflet map init
============================================================ */
let map = null;
let marker = null;

function initMapOrFail(cp) {
  if (!elMap) {
    showStatus('Karta saknas i DOM (#partyMap).', 'danger');
    return false;
  }

  const L = window.L;
  if (!L) {
    showMapError('Leaflet saknas (CDN blockerat/offline). Kartan kan inte visas.');
    showStatus('Leaflet saknas. Kontrollera nätverk.', 'warn');
    return false;
  }

  try {
    const fallbackCenter = [59.3293, 18.0686];
    const center = (Number.isFinite(cp.lat) && Number.isFinite(cp.lng)) ? [cp.lat, cp.lng] : fallbackCenter;
    const zoom = (Number.isFinite(cp.lat) && Number.isFinite(cp.lng)) ? 16 : 12;

    map = L.map(elMap, { zoomControl: true, attributionControl: true });
    map.setView(center, zoom);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap'
    }).addTo(map);

    // Marker för checkpoint 1 om coords finns
    if (Number.isFinite(cp.lat) && Number.isFinite(cp.lng)) {
      marker = L.marker([cp.lat, cp.lng]).addTo(map);
      marker.bindPopup(`Checkpoint 1 • radius ${cp.radius}m`).openPopup();
      showMapError('');
    } else {
      showMapError('Checkpoint 1 saknar position (lat/lng). Admin måste sätta punkt på kartan.');
    }

    return true;
  } catch (_) {
    showStatus('Kunde inte initiera kartan.', 'danger');
    showMapError('Kunde inte initiera kartan.');
    return false;
  }
}

/* ============================================================
   BLOCK 6 — Code check (fail-closed)
   - Om payload code är tom: acceptera valfri icke-tom kod (MVP)
   - Om code finns: matcha case-insensitive trim
============================================================ */
function validateCodeInput(value) {
  const t = asText(value);
  if (t.length < 1) return 'Skriv in en kod.';
  if (t.length > 32) return 'Koden är för lång (max 32 tecken).';
  return '';
}

function codesMatch(expected, entered) {
  const a = asText(expected);
  const b = asText(entered);
  if (!a) return true; // MVP: om admin inte satte kod → allt ok
  return a.toLowerCase() === b.toLowerCase();
}

/* ============================================================
   BLOCK 7 — Boot
============================================================ */
(function bootPartyMap() {
  'use strict';

  if (window.__AO4_PARTY_MAP_INIT__) return; // HOOK: init-guard-party-map
  window.__AO4_PARTY_MAP_INIT__ = true;

  // Back
  if (elBack) {
    elBack.addEventListener('click', () => {
      if (window.history.length > 1) window.history.back();
      else window.location.assign('../index.html');
    });
  }

  const mode = qsGet('mode');
  const payloadRaw = qsGet('payload');
  const id = qsGet('id'); // partyId fallback (inte fullt implementerat här)

  if (mode !== 'party') {
    showStatus('Fel läge. (mode=party krävs)', 'danger');
    return redirectToIndex('PARTY_MODE_REQUIRED');
  }

  // KRAV: saknas payload → error card + tillbaka
  // (id-stöd kan byggas i nästa AO om du vill läsa från parties.index.json)
  if (!payloadRaw && !id) {
    showStatus('Saknar payload. Be admin kopiera länk eller JSON.', 'danger');
    return redirectToIndex('MISSING_ID_OR_PAYLOAD');
  }
  if (!payloadRaw) {
    showStatus('Saknar payload. Denna vy kräver payload-länk i AO 4/8.', 'danger');
    return redirectToIndex('MISSING_PAYLOAD');
  }

  const dec = safeDecodePayload(payloadRaw);
  if (!dec.ok) {
    showStatus('Kunde inte läsa payload.', 'danger');
    return redirectToIndex('INVALID_PAYLOAD');
  }

  const parsed = safeJSONParse(dec.value);
  if (!parsed.ok || !isValidPayloadV1(parsed.value)) {
    showStatus('Ogiltig payload. Be admin kopiera JSON igen.', 'danger');
    return redirectToIndex('INVALID_PAYLOAD');
  }

  const payload = parsed.value;
  const cp1 = getFirstCheckpointFromPayload(payload);

  setText(elName, payload.name || 'Skattjakt');
  setText(elClue, cp1.clue || '—');

  const okMap = initMapOrFail(cp1);
  if (!okMap) {
    // fail-closed: karta kan saknas, men vi kan fortfarande visa clue/kod
    showStatus('Karta kunde inte laddas. Du kan fortfarande testa kod.', 'warn');
  }

  function setErr(text) {
    setText(elErrCode, text || '');
  }

  if (elOk) {
    elOk.addEventListener('click', () => {
      const val = asText(elCode?.value);
      const err = validateCodeInput(val);
      if (err) {
        setErr(err);
        return;
      }
      setErr('');

      if (!codesMatch(cp1.code, val)) {
        setErr('Fel kod. Försök igen.');
        return;
      }

      showStatus('✅ Checkpoint 1 godkänd! (MVP)', 'info');
    });
  }
})();
