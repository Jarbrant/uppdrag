/* ============================================================
   FIL: src/party-map.js  (HEL FIL)
   AO 4/8 (FAS 1.5) — Deltagarvy: karta + checkpoint + kod
   AO 5/8 (FAS 1.5) — Clear + reveal circle + nästa aktiv
   AO 7/8 (FAS 2.0) — Grid-läge (alternativ vy): Toggle Karta/Grid + grid UI-state
   AO 8/8 (FAS 2.0) — Auto-ledtråd + final “Skattkista”
   AO 1/3 (FAS 1.0) — Loot-val “Välj 1 av 3” efter varje checkpoint
   AO 2/3 (FAS 1.0) — Worker voucher API (extern)
   AO 3/3 (FAS 1.0) — Koppla loot -> voucher create + QR + verify + status refresh
   Policy: UI-only, fail-closed, ingen engine
   AO 3/3 policy: Inga nya storage-keys för vouchers (vouchers hålls i minnet)
============================================================ */

/* ============================================================
   BLOCK 0 — AO 3/3: Voucher API base (KRAV 1)
============================================================ */
const VOUCHER_API_BASE = 'https://uppdrag.andersmenyit.workers.dev';

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

// AO 1/3: loot + rewards list hooks
const elLootOverlay = $('#lootOverlay');     // HOOK: loot-overlay
const elLootCards = $('#lootCards');         // HOOK: loot-cards
const elLootSkip = $('#lootSkipBtn');        // HOOK: loot-skip
const elRewardsList = $('#rewardsList');     // HOOK: rewards-list
const elRewardsEmpty = $('#rewardsEmpty');   // HOOK: rewards-empty

// AO 3/3: voucher modal hooks
const elVoucherOverlay = $('#voucherOverlay');         // HOOK: voucher-overlay
const elVoucherMeta = $('#voucherMeta');               // HOOK: voucher-meta
const elVoucherStatusBadge = $('#voucherStatusBadge'); // HOOK: voucher-status-badge
const elVoucherQrImg = $('#voucherQrImg');             // HOOK: voucher-qr-img
const elVoucherCodeText = $('#voucherCodeText');       // HOOK: voucher-code
const elVoucherLinkInput = $('#voucherLinkInput');     // HOOK: voucher-link-input
const elVoucherCopyBtn = $('#voucherCopyBtn');         // HOOK: voucher-copy
const elVoucherShareBtn = $('#voucherShareBtn');       // HOOK: voucher-share
const elVoucherRefreshBtn = $('#voucherRefreshBtn');   // HOOK: voucher-refresh
const elVoucherCloseBtn = $('#voucherCloseBtn');       // HOOK: voucher-close
const elVoucherHint = $('#voucherHint');               // HOOK: voucher-hint

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
  div.className = `toast toast--${type === 'danger' ? 'danger' : type === 'warn' ? 'warn' : type === 'success' ? 'success' : 'info'}`;
  div.setAttribute('role', 'status');
  div.textContent = (message ?? '').toString();
  elStatusSlot.appendChild(div);
}

function toast(message, type = 'info', ttlMs = 1400) {
  if (!elStatusSlot) return;
  const div = document.createElement('div');
  div.className = `toast toast--${type === 'danger' ? 'danger' : type === 'warn' ? 'warn' : type === 'success' ? 'success' : 'info'}`;
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
   (AO 3/3: INGA nya keys för vouchers, men denna key fanns redan)
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
  const base = {
    v: Number(payload?.version) || 0,
    name: asText(payload?.name),
    cc: Number(payload?.checkpointCount) || 0,
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
  const maxIdx = Math.max(0, checkpoints.length - 1);
  let idx = clampInt(nextIndex, 0, maxIdx);

  if (idx < 0 || idx > maxIdx) return;

  const finalIdx = getFinalIndex();

  if (cleared.has(idx)) {
    const nextPlayable = findNextPlayableIndex(idx + 1);
    if (nextPlayable === -1) {
      showStatus('🎉 Alla checkpoints klara! (MVP)', 'info');
      if (elOk) elOk.disabled = true;
      if (elCode) elCode.disabled = true;
      if (viewMode === 'grid') renderGrid();
      safeWriteProgress();
      return;
    }
    idx = nextPlayable;
  }

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

  if (elCode) {
    elCode.value = '';
    const needsCode = !!asText(cp?.code);
    elCode.placeholder = needsCode ? 'Skriv koden här…' : 'Ingen kod krävs — tryck OK';
  }

  renderMarkers();
  renderRevealCircle();
  if (viewMode === 'grid') renderGrid();

  if (opts.pan && map && cp && Number.isFinite(cp.lat) && Number.isFinite(cp.lng)) {
    try {
      const targetZoom = Math.max(15, map.getZoom() || 15);
      map.flyTo([cp.lat, cp.lng], targetZoom, { duration: 0.8 });
    } catch (_) {}
  }

  safeWriteProgress();
}

/* ============================================================
   BLOCK 10 — Code validation + clear/advance + final stamp
============================================================ */
function validateCodeInput(value, expectedCode) {
  const expected = asText(expectedCode);
  const entered = asText(value);

  if (!expected) return '';

  if (entered.length < 1) return 'Skriv in en kod.';
  if (entered.length > 32) return 'Koden är för lång (max 32 tecken).';
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

function lockCompletedUI() {
  showStatus('🎉 Alla checkpoints klara! (MVP)', 'info');
  if (elOk) elOk.disabled = true;
  if (elCode) elCode.disabled = true;
  if (viewMode === 'grid') renderGrid();
  safeWriteProgress();
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

  safeWriteProgress();

  const next = findNextPlayableIndex(activeIndex + 1);
  if (next === -1) {
    lockCompletedUI();
    return;
  }

  setActiveCheckpoint(next, { pan: true });
}

/* ============================================================
   BLOCK 10.1 — AO 1/3 + AO 3/3 State (IN-MEMORY)
   - rewardsUnlocked: historik av val (bakgrund)
   - vouchers: det som visas i listan + kan öppnas i voucher-modal
============================================================ */
const state = {
  rewardsUnlocked: [],            // { partnerId, partnerName, rewardId, rewardTitle, rewardShort, tier, expiresMinutes, cpIndex }
  vouchers: [],                   // { voucherId, partnerId, partnerName, rewardId, rewardTitle, expiresAt, status, verifyUrl, cpIndex, tier }
  lootOptionsByCheckpoint: {}     // { [cpIndex]: [rewardId, rewardId, rewardId] }
};

// AO 1/3 demo catalog (12–20 rewards)
const partnerRewardsCatalog = [
  { partnerId: 'p1', partnerName: 'Café Nova',      rewardId: 'r1',  rewardTitle: 'Gratis saft',           rewardShort: 'En liten saft i kassan.',       tier: 'cp',    expiresMinutes: 120 },
  { partnerId: 'p1', partnerName: 'Café Nova',      rewardId: 'r2',  rewardTitle: 'Kanelbulle -30%',       rewardShort: 'Rabatt på en bulle.',          tier: 'cp',    expiresMinutes: 120 },
  { partnerId: 'p2', partnerName: 'Glasspiraten',   rewardId: 'r3',  rewardTitle: 'Strösselbonus',         rewardShort: 'Extra strössel på glassen.',   tier: 'cp',    expiresMinutes: 120 },
  { partnerId: 'p2', partnerName: 'Glasspiraten',   rewardId: 'r4',  rewardTitle: 'Mini-glass',            rewardShort: 'En mini-glass (MVP).',         tier: 'cp',    expiresMinutes: 120 },
  { partnerId: 'p3', partnerName: 'Bokhörnan',      rewardId: 'r5',  rewardTitle: 'Mysterie-klistermärke', rewardShort:'Välj 1 av 3 stickers.',          tier: 'cp',    expiresMinutes: 120 },
  { partnerId: 'p3', partnerName: 'Bokhörnan',      rewardId: 'r6',  rewardTitle: 'Bokmärke',              rewardShort: 'Ett bokmärke i disken.',       tier: 'cp',    expiresMinutes: 120 },
  { partnerId: 'p4', partnerName: 'SportZonen',     rewardId: 'r7',  rewardTitle: 'Vatten -20%',           rewardShort: 'Rabatt på vattenflaska.',      tier: 'cp',    expiresMinutes: 120 },
  { partnerId: 'p4', partnerName: 'SportZonen',     rewardId: 'r8',  rewardTitle: 'Power high-five',       rewardShort: 'Ett hemligt handslag (lol).',  tier: 'cp',    expiresMinutes: 120 },
  { partnerId: 'p5', partnerName: 'Pizzaplaneten',  rewardId: 'r9',  rewardTitle: 'Extra topping',         rewardShort: 'En extra topping (MVP).',      tier: 'cp',    expiresMinutes: 120 },
  { partnerId: 'p5', partnerName: 'Pizzaplaneten',  rewardId: 'r10', rewardTitle: 'Dipp',                 rewardShort: 'Valfri dipp i kassan.',        tier: 'cp',    expiresMinutes: 120 },

  // Final-tier (skattkista)
  { partnerId: 'pf', partnerName: 'Skattkistan',    rewardId: 'f1',  rewardTitle: 'Stjärnmynt',            rewardShort: 'FINAL-belöning (MVP).',        tier: 'final', expiresMinutes: 720 },
  { partnerId: 'pf', partnerName: 'Skattkistan',    rewardId: 'f2',  rewardTitle: 'Guldbadge',             rewardShort: 'FINAL-belöning (MVP).',        tier: 'final', expiresMinutes: 720 },
  { partnerId: 'pf', partnerName: 'Skattkistan',    rewardId: 'f3',  rewardTitle: 'Hemlig kod',            rewardShort: 'FINAL-belöning (MVP).',        tier: 'final', expiresMinutes: 720 },
  { partnerId: 'pf', partnerName: 'Skattkistan',    rewardId: 'f4',  rewardTitle: 'Superbonus',            rewardShort: 'FINAL-belöning (MVP).',        tier: 'final', expiresMinutes: 720 }
];

function byRewardId(id) {
  const rid = asText(id);
  if (!rid) return null;
  return partnerRewardsCatalog.find((r) => asText(r.rewardId) === rid) || null;
}

/* ============================================================
   BLOCK 10.2 — Deterministic “random” (seed -> rng)
============================================================ */
function seedToUint32(seedStr) {
  const s = (seedStr ?? '').toString();
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) + s.charCodeAt(i);
    h = h >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = (seed >>> 0);
  return function rng() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickUnique3(list, rng) {
  const arr = Array.isArray(list) ? list.slice() : [];
  if (arr.length <= 3) return arr.slice(0, 3);

  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr.slice(0, 3);
}

function computeLootOptionsForCheckpoint(cpIndex, tier) {
  const idx = Number(cpIndex);
  const t = (tier === 'final') ? 'final' : 'cp';

  const cached = state.lootOptionsByCheckpoint[String(idx)];
  if (Array.isArray(cached) && cached.length === 3) return cached.slice(0, 3);

  const urlId = asText(qsGet('id'));
  const gameId = urlId || payloadFingerprint || asText(elName?.textContent) || 'game';
  const seedStr = `${gameId}::${idx}::${t}`;

  let rng = null;
  try {
    const seed = seedToUint32(seedStr);
    rng = mulberry32(seed);
  } catch (_) {
    rng = null;
  }

  const tierPool = partnerRewardsCatalog.filter((r) => asText(r.tier) === t);
  const pool = (tierPool.length >= 3) ? tierPool : partnerRewardsCatalog.slice();

  const rand = rng || (() => Math.random());

  const picked = pickUnique3(pool, rand)
    .map((r) => asText(r.rewardId))
    .filter((x) => !!x);

  const uniq = [];
  for (const id of picked) {
    if (!uniq.includes(id)) uniq.push(id);
    if (uniq.length === 3) break;
  }
  if (uniq.length < 3) {
    for (const r of pool) {
      const id = asText(r.rewardId);
      if (!id) continue;
      if (uniq.includes(id)) continue;
      uniq.push(id);
      if (uniq.length === 3) break;
    }
  }
  if (uniq.length < 3) {
    for (const r of partnerRewardsCatalog) {
      const id = asText(r.rewardId);
      if (!id) continue;
      if (uniq.includes(id)) continue;
      uniq.push(id);
      if (uniq.length === 3) break;
    }
  }

  state.lootOptionsByCheckpoint[String(idx)] = uniq.slice(0, 3);
  return uniq.slice(0, 3);
}

/* ============================================================
   BLOCK 10.3 — AO 3/3: Base url (subpath-safe) + verify url + QR
============================================================ */
function currentBaseUrl() {
  // party.html ligger i /pages/party.html → base = repo-root
  try {
    const u = new URL(window.location.href);
    u.hash = '';
    u.search = '';
    u.pathname = u.pathname.replace(/\/pages\/[^/]+$/, '/');
    const s = u.toString();
    return s.endsWith('/') ? s.slice(0, -1) : s;
  } catch (_) {
    return (window.location.origin || '').toString();
  }
}

function buildVerifyUrl(voucherId, partnerId) {
  const base = currentBaseUrl();
  const v = encodeURIComponent(asText(voucherId));
  const p = encodeURIComponent(asText(partnerId));
  return `${base}/pages/verify.html?voucher=${v}&partner=${p}`;
}

function buildQrUrl(dataUrl, sizePx = 220) {
  // enkel QR via qrserver (ingen lib)
  const s = Math.max(120, Math.min(320, Number(sizePx) || 220));
  const encoded = encodeURIComponent(dataUrl);
  return `https://api.qrserver.com/v1/create-qr-code/?size=${s}x${s}&data=${encoded}`;
}

/* ============================================================
   BLOCK 10.4 — AO 3/3: Voucher API calls (KRAV 1/2/4)
============================================================ */
async function apiCreateVoucher(payload) {
  const url = `${VOUCHER_API_BASE.replace(/\/$/, '')}/vouchers/create`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

async function apiGetVoucher(voucherId) {
  const url = `${VOUCHER_API_BASE.replace(/\/$/, '')}/vouchers/${encodeURIComponent(asText(voucherId))}`;
  const res = await fetch(url, { method: 'GET' });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

/* ============================================================
   BLOCK 10.5 — Rewards list render (AO 3/3)
   - Varje rad: status badge + Visa-knapp
============================================================ */
function statusLabel(status) {
  const s = asText(status);
  if (s === 'redeemed') return 'ANVÄND';
  if (s === 'expired') return 'UTGÅNGEN';
  if (s === 'valid') return 'GILTIG';
  return '—';
}

function statusClass(status) {
  const s = asText(status);
  if (s === 'redeemed') return 'badge badge--redeemed';
  if (s === 'expired') return 'badge badge--expired';
  if (s === 'valid') return 'badge badge--valid';
  return 'badge badge--neutral';
}

function renderRewardsPanel() {
  if (!elRewardsList) return;

  try { elRewardsList.innerHTML = ''; } catch (_) {}

  const items = Array.isArray(state.vouchers) ? state.vouchers : [];
  const hasAny = items.length > 0;

  if (elRewardsEmpty) elRewardsEmpty.style.display = hasAny ? 'none' : '';

  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};

    const li = document.createElement('li');
    li.className = 'rewardItem';

    const meta = document.createElement('div');
    meta.className = 'rewardItem__meta';

    const partner = document.createElement('div');
    partner.className = 'rewardPartner';
    partner.textContent = asText(it.partnerName) || asText(it.partnerId) || 'Partner';

    const title = document.createElement('div');
    title.className = 'rewardTitle';
    title.textContent = asText(it.rewardTitle) || asText(it.rewardId) || 'Belöning';

    const small = document.createElement('div');
    small.className = 'muted small';
    small.textContent = it.expiresAt ? `Går ut: ${formatTime(it.expiresAt)}` : '';

    meta.appendChild(partner);
    meta.appendChild(title);
    if (small.textContent) meta.appendChild(small);

    const right = document.createElement('div');
    right.className = 'rewardRight';

    const badge = document.createElement('span');
    badge.className = statusClass(it.status);
    badge.textContent = statusLabel(it.status);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost';
    btn.textContent = 'Visa';

    const hasVoucher = !!asText(it.voucherId) && !!asText(it.verifyUrl);
    btn.disabled = !hasVoucher;

    btn.addEventListener('click', () => {
      if (!hasVoucher) {
        toast('Voucher saknas (API fel?)', 'warn', 1400);
        return;
      }
      openVoucherModal(it, { refresh: true });
    });

    right.appendChild(badge);
    right.appendChild(btn);

    li.appendChild(meta);
    li.appendChild(right);
    elRewardsList.appendChild(li);
  }
}

/* ============================================================
   BLOCK 10.6 — AO 3/3: Voucher modal (KRAV 3/4/7)
============================================================ */
let activeVoucherRef = null;

function voucherDomOk() {
  return !!(
    elVoucherOverlay &&
    elVoucherStatusBadge &&
    elVoucherQrImg &&
    elVoucherLinkInput &&
    elVoucherCopyBtn &&
    elVoucherShareBtn &&
    elVoucherRefreshBtn &&
    elVoucherCloseBtn
  );
}

function openVoucherOverlay() {
  if (!elVoucherOverlay) return false;
  elVoucherOverlay.classList.remove('is-hidden');
  elVoucherOverlay.setAttribute('aria-hidden', 'false');
  return true;
}

function closeVoucherOverlay() {
  if (!elVoucherOverlay) return;
  elVoucherOverlay.classList.add('is-hidden');
  elVoucherOverlay.setAttribute('aria-hidden', 'true');
  activeVoucherRef = null;
  if (elVoucherHint) setText(elVoucherHint, '');
}

function setVoucherBadge(status) {
  if (!elVoucherStatusBadge) return;
  const s = asText(status);
  elVoucherStatusBadge.className = statusClass(s);
  elVoucherStatusBadge.textContent = statusLabel(s);
}

function formatTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  try {
    const d = new Date(n);
    return d.toLocaleString('sv-SE', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
  } catch (_) {
    return String(n);
  }
}

async function refreshVoucherStatus(v) {
  const voucherId = asText(v?.voucherId);
  if (!voucherId) return false;

  try {
    const out = await apiGetVoucher(voucherId);
    if (!out.ok || !out.data || out.data.ok !== true || !out.data.voucher) {
      toast('Kunde inte uppdatera status', 'warn', 1400);
      return false;
    }

    const status = asText(out.data.voucher.status);
    const expiresAt = Number(out.data.voucher.expiresAt) || 0;

    // uppdatera i state (in-memory)
    for (let i = 0; i < state.vouchers.length; i++) {
      if (asText(state.vouchers[i]?.voucherId) === voucherId) {
        state.vouchers[i].status = status || state.vouchers[i].status;
        if (expiresAt) state.vouchers[i].expiresAt = expiresAt;
      }
    }

    // uppdatera modal om den visar samma voucher
    if (activeVoucherRef && asText(activeVoucherRef.voucherId) === voucherId) {
      activeVoucherRef.status = status || activeVoucherRef.status;
      if (expiresAt) activeVoucherRef.expiresAt = expiresAt;
      setVoucherBadge(activeVoucherRef.status);
      if (elVoucherHint) setText(elVoucherHint, `Status: ${statusLabel(activeVoucherRef.status)} • Går ut: ${formatTime(activeVoucherRef.expiresAt)}`);
    }

    renderRewardsPanel();
    toast('Status uppdaterad', 'success', 1000);
    return true;
  } catch (_) {
    toast('Kunde inte uppdatera status', 'warn', 1400);
    return false;
  }
}

function openVoucherModal(voucherObj, opts = {}) {
  if (!voucherDomOk()) {
    toast('Voucher UI saknas', 'warn', 1600);
    return;
  }

  const ok = openVoucherOverlay();
  if (!ok) {
    toast('Voucher UI saknas', 'warn', 1600);
    return;
  }

  activeVoucherRef = { ...(voucherObj || {}) };

  const partner = asText(activeVoucherRef.partnerName) || asText(activeVoucherRef.partnerId) || 'Partner';
  const title = asText(activeVoucherRef.rewardTitle) || asText(activeVoucherRef.rewardId) || 'Belöning';

  setText(elVoucherMeta, `${partner} • ${title}`);
  setVoucherBadge(activeVoucherRef.status);

  const verifyUrl = asText(activeVoucherRef.verifyUrl);
  setText(elVoucherCodeText, asText(activeVoucherRef.voucherId) || '—');

  if (elVoucherLinkInput) elVoucherLinkInput.value = verifyUrl || '';
  if (elVoucherQrImg) elVoucherQrImg.src = verifyUrl ? buildQrUrl(verifyUrl, 220) : '';

  if (elVoucherHint) {
    const exp = activeVoucherRef.expiresAt ? `Går ut: ${formatTime(activeVoucherRef.expiresAt)}` : '';
    setText(elVoucherHint, exp);
  }

  if (opts.refresh) {
    refreshVoucherStatus(activeVoucherRef);
  }
}

function bindVoucherModalStaticEvents() {
  if (elVoucherCloseBtn) {
    elVoucherCloseBtn.addEventListener('click', () => closeVoucherOverlay());
  }

  if (elVoucherOverlay) {
    elVoucherOverlay.addEventListener('click', (e) => {
      const t = e?.target;
      const isBackdrop = !!(t && t.getAttribute && t.getAttribute('data-close') === '1');
      if (!isBackdrop) return;
      closeVoucherOverlay();
    });
  }

  if (elVoucherCopyBtn) {
    elVoucherCopyBtn.addEventListener('click', async () => {
      const link = (elVoucherLinkInput && elVoucherLinkInput.value) ? elVoucherLinkInput.value : '';
      if (!link) return toast('Ingen länk att kopiera', 'warn', 1200);
      try {
        await navigator.clipboard.writeText(link);
        toast('Länk kopierad', 'success', 1000);
      } catch (_) {
        // fail-soft fallback
        try {
          elVoucherLinkInput.focus();
          elVoucherLinkInput.select();
          document.execCommand('copy');
          toast('Länk kopierad', 'success', 1000);
        } catch (_)2 {
          toast('Kunde inte kopiera', 'warn', 1200);
        }
      }
    });
  }

  if (elVoucherShareBtn) {
    elVoucherShareBtn.addEventListener('click', async () => {
      const link = (elVoucherLinkInput && elVoucherLinkInput.value) ? elVoucherLinkInput.value : '';
      if (!link) return toast('Ingen länk att dela', 'warn', 1200);

      try {
        if (navigator.share) {
          await navigator.share({ title: 'Voucher', text: 'Verifiera belöning', url: link });
          toast('Delat', 'success', 900);
        } else {
          toast('Dela stöds ej här', 'warn', 1200);
        }
      } catch (_) {
        toast('Kunde inte dela', 'warn', 1200);
      }
    });
  }

  if (elVoucherRefreshBtn) {
    elVoucherRefreshBtn.addEventListener('click', () => {
      if (!activeVoucherRef) return toast('Ingen voucher vald', 'warn', 1200);
      refreshVoucherStatus(activeVoucherRef);
    });
  }
}

/* ============================================================
   BLOCK 10.7 — Loot modal UI (open/close + render)
============================================================ */
function lootDomOk() {
  return !!(elLootOverlay && elLootCards && elLootSkip);
}

function openLootModal() {
  if (!elLootOverlay) return false;
  elLootOverlay.classList.remove('is-hidden');
  elLootOverlay.setAttribute('aria-hidden', 'false');
  return true;
}

function closeLootModal() {
  if (!elLootOverlay) return;
  elLootOverlay.classList.add('is-hidden');
  elLootOverlay.setAttribute('aria-hidden', 'true');
  try { if (elLootCards) elLootCards.innerHTML = ''; } catch (_) {}
}

function renderLootCards(rewardIds, onPick, isFinalLoot) {
  if (!elLootCards) return false;

  try { elLootCards.innerHTML = ''; } catch (_) {}

  const ids = Array.isArray(rewardIds) ? rewardIds : [];
  for (let i = 0; i < ids.length; i++) {
    const rid = ids[i];
    const r = byRewardId(rid);
    if (!r) continue;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lootCardBtn';
    btn.setAttribute('role', 'listitem');
    btn.setAttribute('data-reward-id', asText(r.rewardId));

    const partner = document.createElement('div');
    partner.className = 'lootCardPartner';
    partner.textContent = asText(r.partnerName) || 'Partner';

    const title = document.createElement('div');
    title.className = 'lootCardTitle';

    // AO 3/3: FINAL badge (KRAV 5)
    const titleText = document.createElement('span');
    titleText.textContent = asText(r.rewardTitle) || 'Belöning';

    title.appendChild(titleText);
    if (isFinalLoot || asText(r.tier) === 'final') {
      const pill = document.createElement('span');
      pill.className = 'lootFinalPill';
      pill.textContent = 'FINAL';
      title.appendChild(pill);
    }

    const short = document.createElement('div');
    short.className = 'lootCardShort muted small';
    short.textContent = asText(r.rewardShort) || '';

    btn.appendChild(partner);
    btn.appendChild(title);
    if (asText(r.rewardShort)) btn.appendChild(short);

    btn.addEventListener('click', () => {
      try { onPick?.(r); } catch (_) {}
    });

    elLootCards.appendChild(btn);
  }

  return true;
}

function bindLootModalStaticEvents() {
  if (elLootSkip) {
    elLootSkip.addEventListener('click', () => {
      try { window.__AO1_LOOT_SKIP__?.(); } catch (_) {}
    });
  }

  if (elLootOverlay) {
    elLootOverlay.addEventListener('click', (e) => {
      const t = e?.target;
      const isBackdrop = !!(t && t.getAttribute && t.getAttribute('data-close') === '1');
      if (!isBackdrop) return;
      try { window.__AO1_LOOT_SKIP__?.(); } catch (_) {}
    });
  }
}

/* ============================================================
   BLOCK 10.8 — AO 3/3 Trigger: loot pick -> voucher create -> add to list
============================================================ */
let lootInProgress = false;

async function createVoucherForReward({ gameId, checkpointIndex, reward }) {
  const r = reward || {};
  const tier = asText(r.tier) === 'final' ? 'final' : 'cp';

  // TTL: reward.expiresMinutes eller default cp=120, final=720
  const ttl = Number.isFinite(Number(r.expiresMinutes))
    ? Number(r.expiresMinutes)
    : (tier === 'final' ? 720 : 120);

  const payload = {
    gameId: asText(gameId) || 'demo',
    checkpointIndex: Number.isFinite(Number(checkpointIndex)) ? Number(checkpointIndex) : 0,
    partnerId: asText(r.partnerId),
    rewardId: asText(r.rewardId),
    ttlMinutes: clampInt(ttl, 1, 60 * 24 * 30)
  };

  // validation fail-closed
  if (!payload.partnerId || !payload.rewardId) {
    return { ok: false, error: 'bad_reward' };
  }

  try {
    const out = await apiCreateVoucher(payload);
    if (!out.ok || !out.data || out.data.ok !== true || !out.data.voucherId) {
      return { ok: false, error: (out.data && out.data.error) ? out.data.error : 'api_error' };
    }

    const voucherId = asText(out.data.voucherId);
    const expiresAt = Number(out.data.expiresAt) || 0;

    return {
      ok: true,
      voucher: {
        voucherId,
        expiresAt,
        status: 'valid'
      }
    };
  } catch (_) {
    return { ok: false, error: 'network_error' };
  }
}

function triggerLootAfterCheckpoint(cpIndex, isFinal, onDone) {
  if (!lootDomOk()) {
    toast('Belöningar kunde inte visas', 'warn', 1600);
    try { onDone?.(); } catch (_) {}
    return;
  }

  if (lootInProgress) return;
  lootInProgress = true;

  const tier = isFinal ? 'final' : 'cp';
  const options = computeLootOptionsForCheckpoint(cpIndex, tier);

  const finish = () => {
    lootInProgress = false;
    closeLootModal();
    try { onDone?.(); } catch (_) {}
  };

  window.__AO1_LOOT_SKIP__ = () => {
    toast('Hoppar över belöning', 'info', 900);
    finish();
  };

  const ok = openLootModal();
  if (!ok) {
    toast('Belöningar kunde inte visas', 'warn', 1600);
    finish();
    return;
  }

  renderLootCards(options, async (reward) => {
    const r = reward || {};

    // logga valet i rewardsUnlocked (bakgrund)
    const rewardItem = {
      partnerId: asText(r.partnerId),
      partnerName: asText(r.partnerName),
      rewardId: asText(r.rewardId),
      rewardTitle: asText(r.rewardTitle),
      rewardShort: asText(r.rewardShort),
      tier: asText(r.tier),
      expiresMinutes: Number.isFinite(Number(r.expiresMinutes)) ? Number(r.expiresMinutes) : 0,
      cpIndex: Number(cpIndex)
    };
    const dupReward = state.rewardsUnlocked.some((x) => asText(x?.rewardId) === rewardItem.rewardId && Number(x?.cpIndex) === rewardItem.cpIndex);
    if (!dupReward) state.rewardsUnlocked.push(rewardItem);

    // AO 3/3: skapa voucher via API (fail-closed: ingen crash)
    const urlId = asText(qsGet('id'));
    const gameId = urlId || payloadFingerprint || 'demo';

    toast('Skapar voucher…', 'info', 1100);

    const created = await createVoucherForReward({
      gameId,
      checkpointIndex: Number(cpIndex),
      reward: r
    });

    if (!created.ok || !created.voucher) {
      toast('API offline — belöning sparad utan voucher', 'warn', 1800);

      // spara ändå något i listan, men utan Visa
      const fallbackVoucher = {
        voucherId: '',
        partnerId: asText(r.partnerId),
        partnerName: asText(r.partnerName),
        rewardId: asText(r.rewardId),
        rewardTitle: asText(r.rewardTitle),
        expiresAt: 0,
        status: '—',
        verifyUrl: '',
        cpIndex: Number(cpIndex),
        tier: asText(r.tier)
      };
      state.vouchers.push(fallbackVoucher);
      renderRewardsPanel();
      finish();
      return;
    }

    const voucherId = asText(created.voucher.voucherId);
    const expiresAt = Number(created.voucher.expiresAt) || 0;
    const verifyUrl = buildVerifyUrl(voucherId, asText(r.partnerId));

    const vObj = {
      voucherId,
      partnerId: asText(r.partnerId),
      partnerName: asText(r.partnerName),
      rewardId: asText(r.rewardId),
      rewardTitle: asText(r.rewardTitle),
      expiresAt,
      status: 'valid',
      verifyUrl,
      cpIndex: Number(cpIndex),
      tier: asText(r.tier)
    };

    // dedupe per checkpoint (om dubbelklick)
    const exists = state.vouchers.some((x) => asText(x?.voucherId) === voucherId);
    if (!exists) state.vouchers.push(vObj);

    renderRewardsPanel();
    toast('Voucher skapad', 'success', 1200);

    // auto-öppna voucher-modal så spelaren ser QR direkt
    openVoucherModal(vObj, { refresh: false });

    finish();
  }, isFinal);
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
  bindLootModalStaticEvents();
  bindVoucherModalStaticEvents(); // AO 3/3

  const mode = qsGet('mode');
  const payloadRaw = qsGet('payload');
  const id = qsGet('id');

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

  // init rewards panel (AO 3/3)
  renderRewardsPanel();

  // Map init (fail-soft)
  let mapOk = false;
  if (!leafletReady()) {
    showMapError('Leaflet saknas (CDN blockerat/offline) eller #partyMap saknas.');
    showStatus('Karta kunde inte laddas. Grid fungerar ändå.', 'warn');
  } else {
    const firstWithPos = checkpoints.find((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng));
    const center = firstWithPos ? [firstWithPos.lat, firstWithPos.lng] : [59.3293, 18.0686];
    const zoom = firstWithPos ? 15 : 12;
    try {
      initMap(center, zoom);
      mapOk = !!map;
    } catch (_) {
      showMapError('Kunde inte initiera kartan.');
      showStatus('Karta kunde inte laddas. Grid fungerar ändå.', 'warn');
      mapOk = false;
    }
  }

  if (!mapOk) {
    setViewMode('grid');
    if (elViewMapBtn) elViewMapBtn.disabled = true;
  }

  const restored = safeReadProgress();
  if (restored) {
    cleared = restored.cleared;
    activeIndex = restored.activeIndex;
    setViewMode(restored.viewMode);
    toast('Återställde progress.', 'info', 900);
  } else {
    if (mapOk) setViewMode('map');
  }

  if (cleared && cleared.has(activeIndex)) {
    const nextPlayable = findNextPlayableIndex(activeIndex + 1);
    if (nextPlayable === -1) {
      showStatus('🎉 Alla checkpoints klara! (MVP)', 'info');
      if (elOk) elOk.disabled = true;
      if (elCode) elCode.disabled = true;
      renderGrid();
      safeWriteProgress();
      return;
    }
    activeIndex = nextPlayable;
  }

  setActiveCheckpoint(activeIndex || 0, { pan: false });
  renderGrid();

  function setErr(text) { setText(elErrCode, text || ''); }

  if (elCode) {
    elCode.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        try { elOk?.click?.(); } catch (_) {}
      }
    });
  }

  if (elOk) {
    elOk.disabled = false;
    elOk.addEventListener('click', () => {
      const cp = checkpoints[activeIndex];
      if (!cp) return;

      const entered = asText(elCode?.value);
      const err = validateCodeInput(entered, cp.code);
      if (err) { setErr(err); return; }
      setErr('');

      if (!codesMatch(cp.code, entered)) {
        toast('❌ Fel kod. Försök igen.', 'danger', 1400);
        return;
      }

      const cpIndex = Number(cp.index);
      const isFinal = (cp.isFinal === true);

      // AO 3/3: loot -> voucher -> sedan checkpoint clear
      triggerLootAfterCheckpoint(cpIndex, isFinal, () => {
        onCheckpointApproved();
      });
    });
  }

  safeWriteProgress();
})();
