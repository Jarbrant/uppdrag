/* ============================================================
   FIL: src/party-map.js  (HEL FIL)
   AO 4/8 (FAS 1.5) — Deltagarvy: karta + checkpoint + kod
   AO 5/8 (FAS 1.5) — Clear + reveal circle + nästa aktiv
   AO 7/8 (FAS 2.0) — Grid-läge (alternativ vy): Toggle Karta/Grid + grid UI-state
   Mål:
   - Toggle mellan “Karta” och “Grid”
   - Grid visar 1..N med status: låst/aktiv/klar
   - Ingen ny engine-logik: UI-state här i party-map.js
   Fail-closed:
   - fel kod → toast utan state-ändring
============================================================ */

/* ============================================================
   BLOCK 1 — DOM hooks
============================================================ */
const $ = (sel) => document.querySelector(sel);

const elBack = $('#backBtn');            // HOOK: back-button
const elStatusSlot = $('#statusSlot');   // HOOK: status-slot
const elName = $('#partyName');          // HOOK: party-name
const elStepPill = $('#stepPill');       // HOOK: step-pill
const elClue = $('#clueText');           // HOOK: clue-text
const elCode = $('#codeInput');          // HOOK: code-input
const elErrCode = $('#errCode');         // HOOK: err-code
const elOk = $('#okBtn');                // HOOK: ok-button
const elMap = $('#partyMap');            // HOOK: party-map
const elMapError = $('#mapError');       // HOOK: map-error

// AO 7/8 — view toggle hooks
const elMapView = $('#mapView');         // HOOK: map-view
const elGridView = $('#gridView');       // HOOK: grid-view
const elViewMapBtn = $('#viewMapBtn');   // HOOK: view-map-btn
const elViewGridBtn = $('#viewGridBtn'); // HOOK: view-grid-btn
const elGridWrap = $('#gridWrap');       // HOOK: grid-wrap
const elGridHint = $('#gridHint');       // HOOK: grid-hint

/* ============================================================
   BLOCK 2 — UI helpers
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
  if (!elStatusSlot) return;
  const div = document.createElement('div');
  div.className = `toast toast--${type === 'danger' ? 'danger' : type === 'warn' ? 'warn' : 'info'}`;
  div.setAttribute('role', 'status');
  div.textContent = (message ?? '').toString();
  elStatusSlot.appendChild(div);
  setTimeout(() => { try { div.remove(); } catch (_) {} }, Math.max(400, Number(ttlMs) || 1400));
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
   BLOCK 3 — Query + payload parsing
============================================================ */
function qsGet(key) {
  const usp = new URLSearchParams(window.location.search || '');
  return (usp.get(String(key)) ?? '').toString().trim();
}

function safeDecodePayload(raw) {
  const s = (raw ?? '').toString().trim();
  if (!s) return { ok: false, value: '' };

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
    cps.push({ index: i, clue: clues[i] || `Checkpoint ${i + 1}`, lat, lng, radius, code });
  }
  return cps;
}

/* ============================================================
   BLOCK 4 — Leaflet map state (AO 5/8)
============================================================ */
let map = null;
let markerLayer = null;
let revealCircle = null;

let checkpoints = [];
let activeIndex = 0;
let cleared = new Set();

/* ============================================================
   BLOCK 5 — AO 7/8 view state (UI-only)
============================================================ */
let viewMode = 'map'; // 'map' | 'grid'  (HOOK: view-mode)

function setViewMode(next) {
  const m = (next === 'grid') ? 'grid' : 'map';
  viewMode = m;

  // Fail-soft om DOM saknas
  if (elMapView) elMapView.classList.toggle('is-hidden', viewMode !== 'map');
  if (elGridView) elGridView.classList.toggle('is-hidden', viewMode !== 'grid');

  if (elViewMapBtn) {
    elViewMapBtn.classList.toggle('is-active', viewMode === 'map');
    elViewMapBtn.setAttribute('aria-selected', viewMode === 'map' ? 'true' : 'false');
  }
  if (elViewGridBtn) {
    elViewGridBtn.classList.toggle('is-active', viewMode === 'grid');
    elViewGridBtn.setAttribute('aria-selected', viewMode === 'grid' ? 'true' : 'false');
  }

  // När vi går till karta: invalidation/recenter lite så Leaflet ritar rätt
  if (viewMode === 'map' && map) {
    try { setTimeout(() => map.invalidateSize(), 60); } catch (_) {}
  }

  // Grid render varje gång vi visar grid (UI state)
  if (viewMode === 'grid') renderGrid();
}

function bindViewToggle() {
  if (elViewMapBtn) elViewMapBtn.addEventListener('click', () => setViewMode('map'));
  if (elViewGridBtn) elViewGridBtn.addEventListener('click', () => setViewMode('grid'));
}

/* ============================================================
   BLOCK 6 — Marker + circle visuals
============================================================ */
function leafletReady() {
  return !!(window.L && elMap);
}

function makeIconNumber(n, variant = 'normal') {
  const baseBg =
    variant === 'cleared' ? 'rgba(74,222,128,.22)' :
    variant === 'active' ? 'rgba(110,231,255,.22)' :
    'rgba(255,255,255,.10)';

  const baseBorder =
    variant === 'cleared' ? 'rgba(74,222,128,.55)' :
    variant === 'active' ? 'rgba(110,231,255,.55)' :
    'rgba(255,255,255,.22)';

  const text = (variant === 'cleared') ? '✓' : String(n);

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
    className: 'partyCpMarker',
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

    m.on('click', () => {
      if (cleared.has(i)) {
        toast(`Checkpoint ${i + 1} är redan klar.`, 'info', 1200);
        return;
      }
      // UI-only: grid/logik säger att bara aktiva (eller tidigare) är valbara
      // För karta tillåter vi byta till valfri icke-cleared (fail-soft).
      setActiveCheckpoint(i);
    });

    m.addTo(markerLayer);
  }
}

function renderRevealCircle() {
  if (!map || !window.L) return;

  try { revealCircle?.remove?.(); } catch (_) {}
  revealCircle = null;

  const cp = checkpoints[activeIndex];
  if (!cp) return;

  if (!Number.isFinite(cp.lat) || !Number.isFinite(cp.lng)) {
    showMapError('Aktiv checkpoint saknar position. Be admin sätta punkt på kartan.');
    return;
  }
  showMapError('');

  revealCircle = window.L.circle([cp.lat, cp.lng], {
    radius: clampInt(cp.radius ?? 25, 5, 5000),
    color: 'rgba(110,231,255,.65)',
    weight: 2,
    fillColor: 'rgba(110,231,255,.20)',
    fillOpacity: 0.35
  }).addTo(map);
}

/* ============================================================
   BLOCK 7 — Grid render (AO 7/8)
   Status:
   - cleared: i <activeIndex? (cleared set) => klar
   - active: i === activeIndex och ej cleared
   - locked: i > activeIndex och ej cleared
============================================================ */
function computeCellStatus(i) {
  if (cleared.has(i)) return 'cleared';
  if (i === activeIndex) return 'active';
  if (i > activeIndex) return 'locked';
  // i < activeIndex men inte cleared (kan hända om reload) → behandla som locked för fail-closed
  return 'locked';
}

function renderGrid() {
  if (!elGridWrap) return;

  elGridWrap.innerHTML = '';

  const total = checkpoints.length;
  for (let i = 0; i < total; i++) {
    const status = computeCellStatus(i);

    const cell = document.createElement('div');
    cell.className = `gridCell ${status === 'active' ? 'is-active' : status === 'cleared' ? 'is-cleared' : 'is-locked'}`;
    cell.setAttribute('role', 'listitem');
    cell.setAttribute('data-idx', String(i));
    cell.textContent = String(i + 1);

    const disabled = (status === 'locked');
    cell.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    cell.setAttribute('aria-label',
      status === 'cleared' ? `Checkpoint ${i + 1} klar` :
      status === 'active' ? `Checkpoint ${i + 1} aktiv` :
      `Checkpoint ${i + 1} låst`
    );

    // Klick: bara cleared/active är klickbara (ingen ny engine)
    cell.addEventListener('click', () => {
      if (disabled) {
        toast('🔒 Låst. Klara aktiv checkpoint först.', 'warn', 1400);
        return;
      }
      // Om cleared: visa info. Om active: scroll till kodfält.
      if (status === 'cleared') {
        toast(`Checkpoint ${i + 1} är redan klar.`, 'info', 1200);
        return;
      }
      setActiveCheckpoint(i);
      // Auto: gå till karta om man vill se position (fail-soft)
      // Men vi lämnar vyvalet till användaren.
      try { elCode?.focus?.(); } catch (_) {}
    });

    elGridWrap.appendChild(cell);
  }

  if (elGridHint) {
    const remaining = total - cleared.size;
    elGridHint.textContent = remaining > 0
      ? `Kvar: ${remaining} checkpoint${remaining === 1 ? '' : 's'} • Aktiv: ${activeIndex + 1}`
      : 'Alla checkpoints klara.';
  }
}

/* ============================================================
   BLOCK 8 — Active checkpoint UI
============================================================ */
function setActiveCheckpoint(nextIndex) {
  const idx = clampInt(nextIndex, 0, Math.max(0, checkpoints.length - 1));
  if (idx < 0 || idx >= checkpoints.length) return;

  // Fail-closed: tillåt inte hoppa framåt i grid-logik
  // (karta kan fortfarande hoppa via marker; men här begränsar vi UI-state)
  if (idx > activeIndex && !cleared.has(idx)) {
    toast('🔒 Du kan inte hoppa till låsta checkpoints.', 'warn', 1400);
    return;
  }

  activeIndex = idx;

  const cp = checkpoints[activeIndex];
  setText(elStepPill, `Checkpoint ${activeIndex + 1}`);
  setText(elClue, cp?.clue || '—');
  setText(elErrCode, '');

  if (elCode) elCode.value = '';

  renderMarkers();
  renderRevealCircle();
  if (viewMode === 'grid') renderGrid();

  if (map && cp && Number.isFinite(cp.lat) && Number.isFinite(cp.lng)) {
    try { map.setView([cp.lat, cp.lng], Math.max(14, map.getZoom() || 14)); } catch (_) {}
  }
}

/* ============================================================
   BLOCK 9 — Code validation + clear/advance
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

function findNextUnclearedIndex(fromIndex) {
  for (let i = fromIndex; i < checkpoints.length; i++) {
    if (!cleared.has(i)) return i;
  }
  return -1;
}

function onCheckpointApproved() {
  cleared.add(activeIndex);

  renderMarkers();
  if (viewMode === 'grid') renderGrid();

  toast(`✅ Checkpoint ${activeIndex + 1} klar!`, 'info', 1400);

  const next = findNextUnclearedIndex(activeIndex + 1);
  if (next === -1) {
    showStatus('🎉 Alla checkpoints klara! (MVP)', 'info');
    if (elOk) elOk.disabled = true;
    if (viewMode === 'grid') renderGrid();
    return;
  }

  // Nästa checkpoint blir aktiv
  setActiveCheckpoint(next);
}

/* ============================================================
   BLOCK 10 — Boot
============================================================ */
(function bootPartyMap() {
  'use strict';

  if (window.__AO4_PARTY_MAP_INIT__) return; // HOOK: init-guard-party-map
  window.__AO4_PARTY_MAP_INIT__ = true;

  if (elBack) {
    elBack.addEventListener('click', () => {
      if (window.history.length > 1) window.history.back();
      else window.location.assign('../index.html');
    });
  }

  bindViewToggle();

  const mode = qsGet('mode');
  const payloadRaw = qsGet('payload');
  const id = qsGet('id'); // fallback ej implementerad här

  if (mode !== 'party') {
    showStatus('Fel läge. (mode=party krävs)', 'danger');
    return redirectToIndex('PARTY_MODE_REQUIRED');
  }

  if (!payloadRaw && !id) {
    showStatus('Saknar payload. Be admin kopiera länk eller JSON.', 'danger');
    return redirectToIndex('MISSING_ID_OR_PAYLOAD');
  }
  if (!payloadRaw) {
    showStatus('Saknar payload. Denna vy kräver payload-länk i AO 4/8–7/8.', 'danger');
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

  // Init map (fail-soft)
  if (!leafletReady()) {
    showMapError('Leaflet saknas (CDN blockerat/offline) eller #partyMap saknas.');
    showStatus('Karta kunde inte laddas. Grid fungerar ändå.', 'warn');
  } else {
    const firstWithPos = checkpoints.find((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng));
    const center = firstWithPos ? [firstWithPos.lat, firstWithPos.lng] : [59.3293, 18.0686];
    const zoom = firstWithPos ? 15 : 12;
    try {
      initMap(center, zoom);
    } catch (_) {
      showMapError('Kunde inte initiera kartan.');
      showStatus('Karta kunde inte laddas. Grid fungerar ändå.', 'warn');
    }
  }

  // Init view mode: karta default
  setViewMode('map');

  // Init active
  setActiveCheckpoint(0);

  function setErr(text) { setText(elErrCode, text || ''); }

  if (elOk) {
    elOk.addEventListener('click', () => {
      const entered = asText(elCode?.value);
      const err = validateCodeInput(entered);
      if (err) { setErr(err); return; }
      setErr('');

      const cp = checkpoints[activeIndex];
      if (!cp) return;

      // Fail-closed: fel kod → feedback utan state-ändring
      if (!codesMatch(cp.code, entered)) {
        toast('❌ Fel kod. Försök igen.', 'danger', 1400);
        return;
      }

      onCheckpointApproved();
    });
  }

  // Render grid once (så den finns direkt när man togglar)
  renderGrid();
})();
