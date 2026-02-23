/* ============================================================
   FIL: src/party-map.js  (HEL FIL)
   AO 4/8 (FAS 1.5) — Deltagarvy: karta + checkpoint 1 + kod
   AO 5/8 (FAS 1.5) — När klar: markera + avtäcka radie (enkel fog)
   Mål:
   - Deltagare ser karta + aktiv checkpoint + kodfält
   - Godkänd kod → checkpoint får state "cleared"
   - Visuellt: cleared marker = "klar" + avtäckt radie = Leaflet circle overlay
   - Nästa checkpoint blir aktiv
   Fail-closed:
   - saknas payload → error + tillbaka
   - fel kod → toast/feedback utan att ändra state
   Policy: UI-only, Leaflet via CDN, inga externa libs
============================================================ */

/* ============================================================
   BLOCK 1 — DOM hooks
============================================================ */
const $ = (sel) => document.querySelector(sel);

const elBack = $('#backBtn');          // HOOK: back-button
const elStatusSlot = $('#statusSlot'); // HOOK: status-slot
const elName = $('#partyName');        // HOOK: party-name
const elStepPill = $('#stepPill');     // HOOK: step-pill
const elClue = $('#clueText');         // HOOK: clue-text
const elCode = $('#codeInput');        // HOOK: code-input
const elErrCode = $('#errCode');       // HOOK: err-code
const elOk = $('#okBtn');              // HOOK: ok-button
const elMap = $('#partyMap');          // HOOK: party-map
const elMapError = $('#mapError');     // HOOK: map-error

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

function toast(message, type = 'info', ttlMs = 1400) {
  // Minimal toast: återanvänder statusSlot. Fail-soft om slot saknas.
  if (!elStatusSlot) return;
  const div = document.createElement('div');
  div.className = `toast toast--${type === 'danger' ? 'danger' : type === 'warn' ? 'warn' : 'info'}`;
  div.setAttribute('role', 'status');
  div.textContent = (message ?? '').toString();
  elStatusSlot.appendChild(div);
  setTimeout(() => {
    try { div.remove(); } catch (_) {}
  }, Math.max(400, Number(ttlMs) || 1400));
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
   BLOCK 4 — Payload model
   Inline policy:
   - payload är JSON (v1) från admin:
     { version, name, checkpointCount, pointsPerCheckpoint, clues, geo[]? }
   - Vi bygger checkpoints[] där varje cp kan ha lat/lng/radius/code/clue
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

  // geo är optional i v1
  if (obj.geo !== undefined && !Array.isArray(obj.geo)) return false;

  return true;
}

function buildCheckpointsFromPayload(payload) {
  const cc = clampInt(payload.checkpointCount, 1, 20);
  const clues = payload.clues.slice(0, cc).map((c) => asText(c));
  const geo = Array.isArray(payload.geo) ? payload.geo : [];

  const cps = [];
  for (let i = 0; i < cc; i++) {
    const g = (geo[i] && typeof geo[i] === 'object') ? geo[i] : {};
    const lat = Number.isFinite(Number(g.lat)) ? Number(g.lat) : null;
    const lng = Number.isFinite(Number(g.lng)) ? Number(g.lng) : null;
    const radius = clampInt(g.radius ?? 25, 5, 5000);
    const code = asText(g.code ?? '');
    cps.push({
      index: i,
      clue: clues[i] || `Checkpoint ${i + 1}`,
      lat,
      lng,
      radius,
      code
    });
  }
  return cps;
}

/* ============================================================
   BLOCK 5 — Leaflet map state + overlays (AO 5/8)
============================================================ */
let map = null;
let markerLayer = null;   // layer group for markers
let revealCircle = null;  // active checkpoint circle overlay
let checkpoints = [];
let activeIndex = 0;
let cleared = new Set();

function leafletReady() {
  return !!(window.L && elMap);
}

function makeIconNumber(n, variant = 'normal') {
  // variant: normal | active | cleared
  const baseBg =
    variant === 'cleared' ? 'rgba(74,222,128,.22)' :
    variant === 'active' ? 'rgba(110,231,255,.22)' :
    'rgba(255,255,255,.10)';

  const baseBorder =
    variant === 'cleared' ? 'rgba(74,222,128,.55)' :
    variant === 'active' ? 'rgba(110,231,255,.55)' :
    'rgba(255,255,255,.22)';

  const text =
    variant === 'cleared' ? '✓' : String(n);

  const html = `
    <div style="
      width:30px;height:30px;border-radius:999px;
      background:${baseBg};
      border:1px solid ${baseBorder};
      color:rgba(255,255,255,.95);
      display:flex;align-items:center;justify-content:center;
      font-weight:900;font-size:13px;
      box-shadow: 0 6px 14px rgba(0,0,0,.25);
    ">${text}</div>
  `;
  return window.L.divIcon({
    className: 'partyCpMarker', // HOOK: party-cp-marker
    html,
    iconSize: [30, 30],
    iconAnchor: [15, 15]
  });
}

function initMap(center, zoom) {
  const L = window.L;
  map = L.map(elMap, { zoomControl: true, attributionControl: true });
  map.setView(center, zoom);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap'
  }).addTo(map);

  markerLayer = L.layerGroup().addTo(map);
}

function clearMarkers() {
  try { markerLayer?.clearLayers?.(); } catch (_) {}
}

function renderMarkers() {
  if (!map || !markerLayer || !window.L) return;

  clearMarkers();

  for (let i = 0; i < checkpoints.length; i++) {
    const cp = checkpoints[i];
    if (!Number.isFinite(cp.lat) || !Number.isFinite(cp.lng)) continue;

    const isCleared = cleared.has(i);
    const isActive = i === activeIndex && !isCleared;

    const icon = makeIconNumber(i + 1, isCleared ? 'cleared' : isActive ? 'active' : 'normal');
    const m = window.L.marker([cp.lat, cp.lng], { icon, keyboard: false });

    // Klick på marker: sätt aktiv om inte cleared (fail-soft)
    m.on('click', () => {
      if (cleared.has(i)) {
        toast(`Checkpoint ${i + 1} är redan klar.`, 'info', 1200);
        return;
      }
      setActiveCheckpoint(i);
    });

    m.addTo(markerLayer);
  }
}

function renderRevealCircle() {
  if (!map || !window.L) return;

  // Ta bort gammal
  try { revealCircle?.remove?.(); } catch (_) {}
  revealCircle = null;

  const cp = checkpoints[activeIndex];
  if (!cp) return;

  if (!Number.isFinite(cp.lat) || !Number.isFinite(cp.lng)) {
    showMapError('Aktiv checkpoint saknar position. Be admin sätta punkt på kartan.');
    return;
  }

  showMapError('');

  // AO 5/8: “avtäckt radie” = circle overlay
  // Enkel fog: vi visar den avtäcka zonen som en mjukt fylld cirkel.
  revealCircle = window.L.circle([cp.lat, cp.lng], {
    radius: clampInt(cp.radius ?? 25, 5, 5000),
    color: 'rgba(110,231,255,.65)',
    weight: 2,
    fillColor: 'rgba(110,231,255,.20)',
    fillOpacity: 0.35
  }).addTo(map);
}

/* ============================================================
   BLOCK 6 — UI: aktiv checkpoint (AO 5/8)
============================================================ */
function setActiveCheckpoint(nextIndex) {
  const idx = clampInt(nextIndex, 0, Math.max(0, checkpoints.length - 1));
  if (idx < 0 || idx >= checkpoints.length) return;

  activeIndex = idx;

  const cp = checkpoints[activeIndex];
  setText(elStepPill, `Checkpoint ${activeIndex + 1}`);
  setText(elClue, cp?.clue || '—');

  // Töm feltext när vi byter checkpoint
  setText(elErrCode, '');

  // Töm kodfält vid byte (fail-soft)
  if (elCode) elCode.value = '';

  // Render visuals
  renderMarkers();
  renderRevealCircle();

  // Centera kartan på aktiv cp
  if (map && cp && Number.isFinite(cp.lat) && Number.isFinite(cp.lng)) {
    try { map.setView([cp.lat, cp.lng], Math.max(14, map.getZoom() || 14)); } catch (_) {}
  }
}

/* ============================================================
   BLOCK 7 — Code validation (fail-closed)
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
   BLOCK 8 — AO 5/8: clear + advance
============================================================ */
function onCheckpointApproved() {
  // Markera cleared
  cleared.add(activeIndex);

  // Visuellt: marker blir "klar" (✓) via renderMarkers()
  renderMarkers();

  // “Avtäckt radie” är redan visad för aktiv cp. Vi låter cirkeln ligga kvar en stund,
  // men nästa checkpoint blir aktiv direkt.
  toast(`✅ Checkpoint ${activeIndex + 1} klar!`, 'info', 1400);

  // Advance
  const next = findNextUnclearedIndex(activeIndex + 1);
  if (next === -1) {
    showStatus('🎉 Alla checkpoints klara! (MVP)', 'info');
    // disable OK
    if (elOk) elOk.disabled = true;
    return;
  }

  setActiveCheckpoint(next);
}

function findNextUnclearedIndex(fromIndex) {
  for (let i = fromIndex; i < checkpoints.length; i++) {
    if (!cleared.has(i)) return i;
  }
  return -1;
}

/* ============================================================
   BLOCK 9 — Boot
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
  const id = qsGet('id'); // partyId fallback (ej implementerad i denna AO)

  if (mode !== 'party') {
    showStatus('Fel läge. (mode=party krävs)', 'danger');
    return redirectToIndex('PARTY_MODE_REQUIRED');
  }

  // KRAV: saknas payload → error card + tillbaka
  if (!payloadRaw && !id) {
    showStatus('Saknar payload. Be admin kopiera länk eller JSON.', 'danger');
    return redirectToIndex('MISSING_ID_OR_PAYLOAD');
  }
  if (!payloadRaw) {
    showStatus('Saknar payload. Denna vy kräver payload-länk i AO 4/8–5/8.', 'danger');
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
  checkpoints = buildCheckpointsFromPayload(payload);

  setText(elName, payload.name || 'Skattjakt');

  // Init map
  if (!leafletReady()) {
    showMapError('Leaflet saknas (CDN blockerat/offline) eller #partyMap saknas.');
    showStatus('Karta kunde inte laddas. Du kan fortfarande testa kod.', 'warn');
  } else {
    // Centera på första cp med coords, annars fallback
    const firstWithPos = checkpoints.find((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng));
    const center = firstWithPos ? [firstWithPos.lat, firstWithPos.lng] : [59.3293, 18.0686];
    const zoom = firstWithPos ? 15 : 12;
    try {
      initMap(center, zoom);
    } catch (_) {
      showMapError('Kunde inte initiera kartan.');
      showStatus('Karta kunde inte laddas. Du kan fortfarande testa kod.', 'warn');
    }
  }

  // Starta på checkpoint 1 (index 0)
  setActiveCheckpoint(0);

  // OK handler
  function setErr(text) {
    setText(elErrCode, text || '');
  }

  if (elOk) {
    elOk.addEventListener('click', () => {
      const entered = asText(elCode?.value);
      const err = validateCodeInput(entered);
      if (err) {
        setErr(err);
        return;
      }
      setErr('');

      const cp = checkpoints[activeIndex];
      if (!cp) return;

      // Fail-closed: fel kod → feedback (toast) utan state-ändring
      if (!codesMatch(cp.code, entered)) {
        toast('❌ Fel kod. Försök igen.', 'danger', 1400);
        return;
      }

      onCheckpointApproved();
    });
  }
})();
