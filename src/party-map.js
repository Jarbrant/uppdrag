/* ============================================================
   FIL: src/party-map.js  (HEL FIL)
   AO 4/8 (FAS 1.5) — Deltagarvy: karta + checkpoint + kod
   AO 5/8 (FAS 1.5) — Clear + reveal circle + nästa aktiv
   AO 7/8 (FAS 2.0) — Grid-läge (alternativ vy): Toggle Karta/Grid + grid UI-state
   AO 8/8 (FAS 2.0) — Auto-ledtråd + final “Skattkista”
   NICE-TO-HAVE PACK (FAS 2.1) — Progress persist + auto-pan + final stamp (UI-only)
   Policy: UI-only, fail-closed, ingen engine
============================================================ */

/* ============================================================
   BLOCK 1 — DOM hooks
============================================================ */
const $ = (sel) => document.querySelector(sel);

const elBack = $('#backBtn');
const elStatusSlot = $('#statusSlot');
const elName = $('#partyName');
const elStepPill = $('#stepPill');
const elClue = $('#clueText');
const elCode = $('#codeInput');
const elErrCode = $('#errCode');
const elOk = $('#okBtn');
const elMap = $('#partyMap');
const elMapError = $('#mapError');

// view toggle
const elMapView = $('#mapView');
const elGridView = $('#gridView');
const elViewMapBtn = $('#viewMapBtn');
const elViewGridBtn = $('#viewGridBtn');
const elGridWrap = $('#gridWrap');
const elGridHint = $('#gridHint');

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

/* ============================================================
   BLOCK 4 — Checkpoints model (inkl AO 8/8 isFinal)
============================================================ */
let checkpoints = [];
let activeIndex = 0;
let cleared = new Set();

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
    const isFinal = (i === cc - 1) ? (g.isFinal === true) : false;

    cps.push({ index: i, clue: clues[i] || `Checkpoint ${i + 1}`, lat, lng, radius, code, isFinal });
  }
  return cps;
}

function getFinalIndex() {
  const last = checkpoints.length - 1;
  if (last >= 0 && checkpoints[last] && checkpoints[last].isFinal === true) return last;
  return -1;
}

function allBeforeFinalCleared(finalIdx) {
  if (finalIdx < 0) return true;
  for (let i = 0; i < finalIdx; i++) {
    if (!cleared.has(i)) return false;
  }
  return true;
}

/* ============================================================
   BLOCK 5 — NICE: Progress persist (sessionStorage, fail-closed)
   - Lagrar: cleared[], activeIndex, viewMode
   - Skyddar mot “fel jakt” via payloadFingerprint
============================================================ */
const PROGRESS_KEY = 'PARTY_PROGRESS_V1'; // HOOK: progress-key
let progressWritable = true;              // HOOK: progress-writable
let payloadFingerprint = '';              // HOOK: payload-fingerprint

function djb2Hash(str) {
  const s = (str ?? '').toString();
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) + s.charCodeAt(i);
    h = h >>> 0;
  }
  return h.toString(36);
}

function makePayloadFingerprint(payload) {
  // Fail-closed: använd bara stabila fält som påverkar struktur
  const base = {
    v: Number(payload?.version) || 0,
    name: asText(payload?.name),
    cc: Number(payload?.checkpointCount) || 0,
    // clues påverkar flow – inkludera kort hash
    clues: Array.isArray(payload?.clues) ? payload.clues.map((c) => asText(c)) : []
  };
  return djb2Hash(JSON.stringify(base));
}

function safeReadProgress() {
  try {
    const raw = sessionStorage.getItem(PROGRESS_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    if (obj.v !== 1) return null;
    if (asText(obj.fp) !== payloadFingerprint) return null;

    const cl = Array.isArray(obj.cleared) ? obj.cleared : [];
    const set = new Set();
    for (const x of cl) {
      const idx = Number(x);
      if (Number.isFinite(idx) && idx >= 0 && idx <= 999) set.add(idx);
    }

    const ai = Number(obj.activeIndex);
    const vi = asText(obj.viewMode) === 'grid' ? 'grid' : 'map';

    return {
      cleared: set,
      activeIndex: Number.isFinite(ai) ? clampInt(ai, 0, Math.max(0, checkpoints.length - 1)) : 0,
      viewMode: vi
    };
  } catch (_) {
    progressWritable = false;
    return null;
  }
}

function safeWriteProgress() {
  if (!progressWritable) return false;
  try {
    const obj = {
      v: 1,
      fp: payloadFingerprint,
      cleared: Array.from(cleared.values()).sort((a, b) => a - b),
      activeIndex,
      viewMode
    };
    sessionStorage.setItem(PROGRESS_KEY, JSON.stringify(obj));
    return true;
  } catch (_) {
    progressWritable = false;
    return false;
  }
}

/* ============================================================
   BLOCK 6 — View state (Karta/Grid)
============================================================ */
let viewMode = 'map';

function setViewMode(next) {
  const m = (next === 'grid') ? 'grid' : 'map';
  viewMode = m;

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

  if (viewMode === 'map' && map) {
    try { setTimeout(() => map.invalidateSize(), 60); } catch (_) {}
  }

  if (viewMode === 'grid') renderGrid();

  // NICE: persist view choice
  safeWriteProgress();
}

function bindViewToggle() {
  if (elViewMapBtn) elViewMapBtn.addEventListener('click', () => setViewMode('map'));
  if (elViewGridBtn) elViewGridBtn.addEventListener('click', () => setViewMode('grid'));
}

/* ============================================================
   BLOCK 7 — Leaflet map state + visuals
============================================================ */
let map = null;
let markerLayer = null;
let revealCircle = null;

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

      const finalIdx = getFinalIndex();
      if (i === finalIdx && finalIdx >= 0 && !allBeforeFinalCleared(finalIdx)) {
        toast('🎁 Skattkistan är låst. Klara alla före först.', 'warn', 1600);
        return;
      }

      // Fail-closed: ingen hoppa framåt
      if (i > activeIndex) {
        toast('🔒 Du kan inte hoppa till låsta checkpoints.', 'warn', 1400);
        return;
      }

      setActiveCheckpoint(i, { pan: true });
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
   BLOCK 8 — Grid render (inkl final)
============================================================ */
function computeCellStatus(i) {
  const finalIdx = getFinalIndex();

  if (cleared.has(i)) return 'cleared';
  if (i === finalIdx && finalIdx >= 0 && !allBeforeFinalCleared(finalIdx)) return 'locked';
  if (i === activeIndex) return 'active';
  if (i > activeIndex) return 'locked';
  return 'locked';
}

function cellLabel(i) {
  const finalIdx = getFinalIndex();
  if (i === finalIdx && finalIdx >= 0 && allBeforeFinalCleared(finalIdx) && !cleared.has(finalIdx)) return '🎁';
  return String(i + 1);
}

function cellAriaLabel(i, status) {
  const finalIdx = getFinalIndex();
  const isFinal = (i === finalIdx && finalIdx >= 0);

  if (isFinal && status !== 'locked' && !cleared.has(i)) return 'Skattkista aktiv';
  if (isFinal && cleared.has(i)) return 'Skattkista klar';
  if (isFinal && status === 'locked') return 'Skattkista låst';

  return (
    status === 'cleared' ? `Checkpoint ${i + 1} klar` :
    status === 'active' ? `Checkpoint ${i + 1} aktiv` :
    `Checkpoint ${i + 1} låst`
  );
}

function renderGrid() {
  if (!elGridWrap) return;

  elGridWrap.innerHTML = '';

  const total = checkpoints.length;
  for (let i = 0; i < total; i++) {
    const status = computeCellStatus(i);

    const cell = document.createElement('div');
    cell.className = `gridCell ${
      status === 'active' ? 'is-active' :
      status === 'cleared' ? 'is-cleared' :
      'is-locked'
    }`;

    cell.setAttribute('role', 'listitem');
    cell.setAttribute('data-idx', String(i));
    cell.textContent = cellLabel(i);

    const disabled = (status === 'locked');
    cell.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    cell.setAttribute('aria-label', cellAriaLabel(i, status));

    cell.addEventListener('click', () => {
      if (disabled) {
        toast('🔒 Låst. Klara aktiv checkpoint först.', 'warn', 1400);
        return;
      }
      if (status === 'cleared') {
        const finalIdx = getFinalIndex();
        if (i === finalIdx && finalIdx >= 0) toast('🎁 Skattkistan är redan klar.', 'info', 1200);
        else toast(`Checkpoint ${i + 1} är redan klar.`, 'info', 1200);
        return;
      }
      setActiveCheckpoint(i, { pan: true });
      try { elCode?.focus?.(); } catch (_) {}
    });

    elGridWrap.appendChild(cell);
  }

  if (elGridHint) {
    const totalRemaining = checkpoints.length - cleared.size;
    const finalIdx = getFinalIndex();
    const finalLocked = (finalIdx >= 0 && !cleared.has(finalIdx) && !allBeforeFinalCleared(finalIdx));
    elGridHint.textContent = totalRemaining > 0
      ? `Kvar: ${totalRemaining} • Aktiv: ${activeIndex + 1}${finalLocked ? ' • Skattkista låst' : ''}`
      : 'Alla checkpoints klara.';
  }
}

/* ============================================================
   BLOCK 9 — Active checkpoint UI + NICE: auto-pan
============================================================ */
function setActiveCheckpoint(nextIndex, opts = {}) {
  const idx = clampInt(nextIndex, 0, Math.max(0, checkpoints.length - 1));
  if (idx < 0 || idx >= checkpoints.length) return;

  const finalIdx = getFinalIndex();

  if (idx === finalIdx && finalIdx >= 0 && !allBeforeFinalCleared(finalIdx)) {
    toast('🎁 Skattkistan är låst. Klara alla före först.', 'warn', 1600);
    return;
  }

  if (idx > activeIndex && !cleared.has(idx)) {
    toast('🔒 Du kan inte hoppa till låsta checkpoints.', 'warn', 1400);
    return;
  }

  activeIndex = idx;

  const cp = checkpoints[activeIndex];
  const isFinalActive = (activeIndex === finalIdx && finalIdx >= 0);

  setText(elStepPill, isFinalActive ? 'Skattkista' : `Checkpoint ${activeIndex + 1}`);
  setText(elClue, cp?.clue || '—');
  setText(elErrCode, '');

  if (elCode) elCode.value = '';

  renderMarkers();
  renderRevealCircle();
  if (viewMode === 'grid') renderGrid();

  // NICE: auto-pan (mjuk)
  if (opts.pan && map && cp && Number.isFinite(cp.lat) && Number.isFinite(cp.lng)) {
    try {
      const targetZoom = Math.max(15, map.getZoom() || 15);
      map.flyTo([cp.lat, cp.lng], targetZoom, { duration: 0.8 });
    } catch (_) {}
  }

  // persist progress
  safeWriteProgress();
}

/* ============================================================
   BLOCK 10 — Code validation + clear/advance + final stamp
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
  if (!a) return true;
  return a.toLowerCase() === b.toLowerCase();
}

function findNextPlayableIndex(fromIndex) {
  const finalIdx = getFinalIndex();

  for (let i = fromIndex; i < checkpoints.length; i++) {
    if (cleared.has(i)) continue;
    if (finalIdx >= 0 && i === finalIdx) continue;
    return i;
  }

  if (finalIdx >= 0 && !cleared.has(finalIdx) && allBeforeFinalCleared(finalIdx)) return finalIdx;
  return -1;
}

function showFinalStamp() {
  // CSS-free fallback: overlay med inline styles (ser “papper/stämpel”-aktigt ut)
  const existing = document.getElementById('finalStamp');
  if (existing) return;

  const wrap = document.createElement('div');
  wrap.id = 'finalStamp';
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-live', 'polite');
  wrap.textContent = '🎁 SKATT FUNNEN!';
  wrap.style.position = 'fixed';
  wrap.style.left = '50%';
  wrap.style.top = '18%';
  wrap.style.transform = 'translateX(-50%) rotate(-6deg)';
  wrap.style.zIndex = '2000';
  wrap.style.padding = '14px 18px';
  wrap.style.borderRadius = '18px';
  wrap.style.border = '1px solid rgba(255,214,150,.28)';
  wrap.style.background = 'rgba(16, 26, 47, .78)';
  wrap.style.boxShadow = '0 18px 40px rgba(0,0,0,.35)';
  wrap.style.fontWeight = '900';
  wrap.style.letterSpacing = '.08em';
  wrap.style.backdropFilter = 'blur(10px)';
  wrap.style.userSelect = 'none';

  document.body.appendChild(wrap);

  setTimeout(() => {
    try { wrap.style.opacity = '0'; wrap.style.transition = 'opacity .25s ease'; } catch (_) {}
    setTimeout(() => { try { wrap.remove(); } catch (_) {} }, 320);
  }, 1800);
}

function onCheckpointApproved() {
  const finalIdx = getFinalIndex();
  const wasFinal = (finalIdx >= 0 && activeIndex === finalIdx);

  cleared.add(activeIndex);

  renderMarkers();
  if (viewMode === 'grid') renderGrid();

  if (wasFinal) {
    toast('🎁 Skattkistan är hittad!', 'success', 1800);
    showFinalStamp();
  } else {
    toast(`✅ Checkpoint ${activeIndex + 1} klar!`, 'info', 1400);
  }

  // Persist
  safeWriteProgress();

  // Auto-ledtråd: nästa blir aktiv direkt
  const next = findNextPlayableIndex(activeIndex + 1);

  if (next === -1) {
    showStatus('🎉 Alla checkpoints klara! (MVP)', 'info');
    if (elOk) elOk.disabled = true;
    if (viewMode === 'grid') renderGrid();
    safeWriteProgress();
    return;
  }

  setActiveCheckpoint(next, { pan: true });
}

/* ============================================================
   BLOCK 11 — Boot
============================================================ */
(function bootPartyMap() {
  'use strict';

  if (window.__AO4_PARTY_MAP_INIT__) return;
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
    showStatus('Saknar payload. Denna vy kräver payload-länk.', 'danger');
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
  payloadFingerprint = makePayloadFingerprint(payload);

  checkpoints = buildCheckpointsFromPayload(payload);

  setText(elName, payload.name || 'Skattjakt');

  // Map init (fail-soft)
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

  // NICE: restore progress (fail-closed)
  const restored = safeReadProgress();
  if (restored) {
    cleared = restored.cleared;
    activeIndex = restored.activeIndex;
    setViewMode(restored.viewMode);
    toast('Återställde progress.', 'info', 900);
  } else {
    setViewMode('map');
  }

  // Init active UI (pan soft)
  setActiveCheckpoint(activeIndex || 0, { pan: false });

  // Render grid once (så den finns direkt när man togglar)
  renderGrid();

  function setErr(text) { setText(elErrCode, text || ''); }

  if (elOk) {
    elOk.disabled = false;
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

  // Persist initial state
  safeWriteProgress();
})();
