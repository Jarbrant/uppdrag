/* ============================================================
   FIL: src/admin.js  (HEL FIL)
   AO 5/6 (FAS 1.2) — Admin UI: skapa skattjakt (lokalt, utan konto)
   AO 6/6 (FAS 1.2) — Export: QR-länk + “kopiera JSON”
   AO 2/8 (FAS 1.5) — Klick → lägg checkpoint (cp=1..N) + lista (edit)
   KRAV (AO 2/8):
   - Klick på karta → lägg checkpoint: cp(1..N), lat, lng, radius(default 25m), code(tom/auto)
   - Markers med etikett “1,2,3…” (admin-map.js)
   - Lista i admin: redigera ledtråd, poäng, kod, radius
   - Fail-closed: om karta ej init → disable “lägg cp” (karta-klick blir no-op + tydlig status)
   Policy: UI-only, inga externa libs (Leaflet ok via CDN i admin.html), XSS-safe rendering
============================================================ */

import { copyToClipboard } from './util.js'; // AO 6/6

/* ============================================================
   BLOCK 1 — Storage key + draft shape (state/draft)
   Draft shape (bakåtkompatibel):
   {
     version: 1,
     name: string,
     checkpointCount: number (1..20),
     pointsPerCheckpoint: number (0..1000),
     clues: string[] (length = checkpointCount),
     // AO 2/8 (FAS 1.5): geo/checkpoints (optional, fail-soft)
     checkpoints?: Array<{
       lat?: number, lng?: number, radius?: number, code?: string,
       clue?: string, points?: number
     }>
   }
============================================================ */
const DRAFT_KEY = 'PARTY_DRAFT_V1'; // HOOK: draft-storage-key (stabil)

/* ============================================================
   BLOCK 2 — DOM hooks (UI)
============================================================ */
const $ = (sel) => document.querySelector(sel);

const elBack = $('#backBtn');              // HOOK: back-button
const elStatusSlot = $('#statusSlot');     // HOOK: status-slot
const elSavePill = $('#savePill');         // HOOK: save-pill

const elName = $('#partyNameInput');       // HOOK: party-name-input
const elCount = $('#cpCountInput');        // HOOK: checkpoint-count-input
const elPoints = $('#pointsPerInput');     // HOOK: points-per-input

const elCluesWrap = $('#cluesWrap');       // HOOK: clues-wrap  (AO 2/8: blir cp-list editor)
const elAddCp = $('#addCpBtn');            // HOOK: add-cp
const elRemoveCp = $('#removeCpBtn');      // HOOK: remove-cp
const elReset = $('#resetBtn');            // HOOK: reset-draft
const elSave = $('#saveBtn');              // HOOK: save-draft

const elErrName = $('#errPartyName');      // HOOK: err-party-name
const elErrCount = $('#errCpCount');       // HOOK: err-checkpoint-count
const elErrPoints = $('#errPointsPer');    // HOOK: err-points-per
const elErrClues = $('#errClues');         // HOOK: err-clues

const elPreviewName = $('#previewName');     // HOOK: preview-name
const elPreviewPoints = $('#previewPoints'); // HOOK: preview-points
const elPreviewCount = $('#previewCount');   // HOOK: preview-count
const elPreviewList = $('#previewList');     // HOOK: preview-list

/* ============================================================
   BLOCK 3 — Fail-closed storage guard
============================================================ */
let storageWritable = true; // HOOK: storage-writable

function showStatus(message, type = 'info') {
  if (!elStatusSlot) return;
  elStatusSlot.innerHTML = '';
  const div = document.createElement('div');
  div.className = `toast toast--${type === 'danger' ? 'danger' : type === 'warn' ? 'warn' : 'info'}`;
  div.setAttribute('role', 'status');
  div.textContent = message;
  elStatusSlot.appendChild(div);
}

/* ============================================================
   BLOCK 4 — Defaults + helpers
============================================================ */
function clampInt(n, min, max) {
  const x = Math.floor(Number(n));
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function safeText(x) {
  return (x ?? '').toString();
}

function defaultDraft() {
  return {
    version: 1,
    name: '',
    checkpointCount: 5,
    pointsPerCheckpoint: 10,
    clues: Array.from({ length: 5 }, (_, i) => `Checkpoint ${i + 1}: Ledtråd...`),
    checkpoints: Array.from({ length: 5 }, () => ({
      lat: null, lng: null,
      radius: 25,
      code: '',
      clue: '',
      points: null
    }))
  };
}

/* ============================================================
   BLOCK 5 — Draft load/save (local draft)
============================================================ */
function safeJSONParse(str) {
  try {
    const v = JSON.parse(str);
    return { ok: true, value: v };
  } catch (_) {
    return { ok: false, value: null };
  }
}

function readDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return defaultDraft();

    const parsed = safeJSONParse(raw);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') return defaultDraft();

    return migrateDraft(parsed.value);
  } catch (_) {
    storageWritable = false;
    showStatus('LocalStorage är inte tillgängligt. Du kan redigera, men utkast sparas inte.', 'warn');
    return defaultDraft();
  }
}

function writeDraft(draft) {
  if (!storageWritable) return false;
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    return true;
  } catch (_) {
    storageWritable = false;
    showStatus('Kunde inte spara utkast (localStorage write fail).', 'warn');
    return false;
  }
}

/* ============================================================
   BLOCK 6 — Migration/shape guard + sync (AO 2/8)
============================================================ */
function migrateDraft(raw) {
  const def = defaultDraft();
  const next = { ...def, ...(raw && typeof raw === 'object' ? raw : {}) };

  next.version = 1;
  next.name = safeText(next.name).trim();
  next.checkpointCount = clampInt(next.checkpointCount, 1, 20);
  next.pointsPerCheckpoint = clampInt(next.pointsPerCheckpoint, 0, 1000);

  if (!Array.isArray(next.clues)) next.clues = [];
  next.clues = next.clues.map((c) => safeText(c)).slice(0, 20);

  // AO 2/8: checkpoints geo/editor
  if (!Array.isArray(next.checkpoints)) next.checkpoints = [];
  next.checkpoints = next.checkpoints.map((cp) => {
    const o = (cp && typeof cp === 'object') ? cp : {};
    return {
      lat: Number.isFinite(Number(o.lat)) ? Number(o.lat) : null,
      lng: Number.isFinite(Number(o.lng)) ? Number(o.lng) : null,
      radius: clampInt(o.radius, 5, 5000),
      code: safeText(o.code).trim(),
      clue: safeText(o.clue).trim(),
      points: Number.isFinite(Number(o.points)) ? clampInt(o.points, 0, 1000) : null
    };
  }).slice(0, 20);

  // Sync arrays to checkpointCount
  syncCountToStructures(next, next.checkpointCount);

  // Sync clue strings into checkpoints if missing
  for (let i = 0; i < next.checkpointCount; i++) {
    if (!next.checkpoints[i]) continue;
    const c = safeText(next.clues[i] ?? '').trim();
    if (!next.checkpoints[i].clue) next.checkpoints[i].clue = c;
  }

  return next;
}

function syncCountToStructures(d, nextCount) {
  const n = clampInt(nextCount, 1, 20);
  d.checkpointCount = n;

  // clues
  while (d.clues.length < n) d.clues.push(`Checkpoint ${d.clues.length + 1}: Ledtråd...`);
  if (d.clues.length > n) d.clues = d.clues.slice(0, n);

  // checkpoints
  while (d.checkpoints.length < n) {
    d.checkpoints.push({ lat: null, lng: null, radius: 25, code: '', clue: '', points: null });
  }
  if (d.checkpoints.length > n) d.checkpoints = d.checkpoints.slice(0, n);
}

function syncDerivedFields() {
  // Se till att clues[] reflekterar cp.clue (så preview + export funkar stabilt)
  for (let i = 0; i < draft.checkpointCount; i++) {
    const cp = draft.checkpoints[i] || {};
    const c = safeText(cp.clue || draft.clues[i] || '').trim();
    draft.clues[i] = c || `Checkpoint ${i + 1}: Ledtråd...`;
  }
}

/* ============================================================
   BLOCK 7 — Validation (fail-closed: errors under fields)
============================================================ */
function validateDraft(d) {
  const errors = { name: '', count: '', points: '', clues: '' };

  if (!d.name || d.name.trim().length < 2) {
    errors.name = 'Skriv ett namn (minst 2 tecken).';
  } else if (d.name.length > 60) {
    errors.name = 'Namn är för långt (max 60 tecken).';
  }

  if (!Number.isFinite(Number(d.checkpointCount)) || d.checkpointCount < 1 || d.checkpointCount > 20) {
    errors.count = 'Antal checkpoints måste vara 1–20.';
  }

  if (!Number.isFinite(Number(d.pointsPerCheckpoint)) || d.pointsPerCheckpoint < 0 || d.pointsPerCheckpoint > 1000) {
    errors.points = 'Poäng måste vara 0–1000.';
  }

  // clues/editor validering (AO 2/8: per checkpoint)
  if (!Array.isArray(d.checkpoints) || d.checkpoints.length !== d.checkpointCount) {
    errors.clues = 'Checkpoints måste matcha antal.';
  } else {
    for (let i = 0; i < d.checkpoints.length; i++) {
      const cp = d.checkpoints[i] || {};
      const clue = safeText(cp.clue ?? d.clues[i]).trim();
      if (clue.length < 3) {
        errors.clues = `Ledtråd ${i + 1} är för kort (minst 3 tecken).`;
        break;
      }
      if (clue.length > 140) {
        errors.clues = `Ledtråd ${i + 1} är för lång (max 140 tecken).`;
        break;
      }
      const radius = clampInt(cp.radius, 5, 5000);
      if (!Number.isFinite(Number(radius)) || radius < 5 || radius > 5000) {
        errors.clues = `Radius ${i + 1} är ogiltig (5–5000 m).`;
        break;
      }
      const points = (cp.points === null || cp.points === undefined) ? d.pointsPerCheckpoint : cp.points;
      const p = clampInt(points, 0, 1000);
      if (!Number.isFinite(Number(p)) || p < 0 || p > 1000) {
        errors.clues = `Poäng ${i + 1} är ogiltig (0–1000).`;
        break;
      }
    }
  }

  return errors;
}

function renderErrors(errors) {
  if (elErrName) elErrName.textContent = errors.name || '';
  if (elErrCount) elErrCount.textContent = errors.count || '';
  if (elErrPoints) elErrPoints.textContent = errors.points || '';
  if (elErrClues) elErrClues.textContent = errors.clues || '';
}

/* ============================================================
   BLOCK 8 — Render loop (form + cp-list + preview)
============================================================ */
let draft = readDraft(); // HOOK: draft-state
let dirty = false;       // HOOK: dirty-state
let saveTimer = null;    // HOOK: autosave-timer

function setPill(text, ok = true) {
  if (!elSavePill) return;
  elSavePill.textContent = text;
  elSavePill.style.opacity = ok ? '1' : '0.8';
}

// AO 2/8: cp-list editor (renderas i cluesWrap)
function renderCheckpointEditor() {
  if (!elCluesWrap) return;
  elCluesWrap.innerHTML = '';

  for (let i = 0; i < draft.checkpointCount; i++) {
    const cp = draft.checkpoints[i] || {};
    const row = document.createElement('div');
    row.className = 'clueRow';

    // Meta
    const meta = document.createElement('div');
    meta.className = 'clueMeta';

    const idx = document.createElement('div');
    idx.className = 'clueIdx';
    idx.textContent = `CP ${i + 1}`;

    const coord = document.createElement('div');
    coord.className = 'muted small';
    const lat = Number.isFinite(Number(cp.lat)) ? Number(cp.lat).toFixed(5) : '—';
    const lng = Number.isFinite(Number(cp.lng)) ? Number(cp.lng).toFixed(5) : '—';
    coord.textContent = `(${lat}, ${lng})`;

    meta.appendChild(idx);
    meta.appendChild(coord);

    // Ledtråd
    const clueInput = document.createElement('input');
    clueInput.className = 'input clueInput';
    clueInput.type = 'text';
    clueInput.autocomplete = 'off';
    clueInput.placeholder = 'Skriv ledtråd…';
    clueInput.value = safeText(cp.clue || draft.clues[i] || '');
    clueInput.setAttribute('data-cp-index', String(i)); // HOOK: cp-clue-index

    clueInput.addEventListener('input', (e) => {
      const k = clampInt(e.target.getAttribute('data-cp-index'), 0, 99);
      draft.checkpoints[k].clue = safeText(e.target.value);
      markDirtyAndRender(false);
    });

    // Grid row: points / code / radius
    const grid = document.createElement('div');
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = '1fr 1fr 1fr';
    grid.style.gap = '8px';

    const points = document.createElement('input');
    points.className = 'input';
    points.type = 'number';
    points.inputMode = 'numeric';
    points.min = '0';
    points.max = '1000';
    points.step = '1';
    points.placeholder = `Poäng (${draft.pointsPerCheckpoint})`;
    points.value = (cp.points === null || cp.points === undefined) ? '' : String(cp.points);
    points.setAttribute('data-cp-points', String(i)); // HOOK: cp-points

    points.addEventListener('input', (e) => {
      const k = clampInt(e.target.getAttribute('data-cp-points'), 0, 99);
      const v = safeText(e.target.value).trim();
      draft.checkpoints[k].points = v === '' ? null : clampInt(v, 0, 1000);
      markDirtyAndRender(false);
    });

    const code = document.createElement('input');
    code.className = 'input';
    code.type = 'text';
    code.autocomplete = 'off';
    code.placeholder = 'Kod (valfri)';
    code.value = safeText(cp.code || '');
    code.setAttribute('data-cp-code', String(i)); // HOOK: cp-code

    code.addEventListener('input', (e) => {
      const k = clampInt(e.target.getAttribute('data-cp-code'), 0, 99);
      draft.checkpoints[k].code = safeText(e.target.value).trim();
      markDirtyAndRender(false);
    });

    const radius = document.createElement('input');
    radius.className = 'input';
    radius.type = 'number';
    radius.inputMode = 'numeric';
    radius.min = '5';
    radius.max = '5000';
    radius.step = '1';
    radius.placeholder = 'Radius (m)';
    radius.value = String(clampInt(cp.radius ?? 25, 5, 5000));
    radius.setAttribute('data-cp-radius', String(i)); // HOOK: cp-radius

    radius.addEventListener('input', (e) => {
      const k = clampInt(e.target.getAttribute('data-cp-radius'), 0, 99);
      draft.checkpoints[k].radius = clampInt(e.target.value, 5, 5000);
      markDirtyAndRender(false);
    });

    grid.appendChild(points);
    grid.appendChild(code);
    grid.appendChild(radius);

    row.appendChild(meta);
    row.appendChild(clueInput);
    row.appendChild(grid);

    elCluesWrap.appendChild(row);
  }
}

function renderPreview() {
  syncDerivedFields();

  if (elPreviewName) elPreviewName.textContent = draft.name?.trim() ? draft.name.trim() : '—';
  if (elPreviewPoints) elPreviewPoints.textContent = `${draft.pointsPerCheckpoint} p`;
  if (elPreviewCount) elPreviewCount.textContent = `${draft.checkpointCount}`;

  if (elPreviewList) {
    elPreviewList.innerHTML = '';
    for (let i = 0; i < draft.checkpointCount; i++) {
      const li = document.createElement('li');
      li.className = 'previewItem';
      li.textContent = safeText(draft.clues[i] ?? `Checkpoint ${i + 1}`);
      elPreviewList.appendChild(li);
    }
  }
}

function broadcastDraftToMap() {
  // HOOK: draft-changed-event
  window.dispatchEvent(new CustomEvent('admin:draft-changed', {
    detail: { checkpoints: draft.checkpoints }
  }));

  // Om map API finns, kör setCheckpoints direkt också (fail-soft)
  const api = window.__ADMIN_MAP_API__;
  if (api && typeof api.setCheckpoints === 'function') {
    try { api.setCheckpoints(draft.checkpoints); } catch (_) {}
  }
}

function renderAll() {
  // Render inputs
  if (elName) elName.value = draft.name;
  if (elCount) elCount.value = String(draft.checkpointCount);
  if (elPoints) elPoints.value = String(draft.pointsPerCheckpoint);

  renderCheckpointEditor();
  renderPreview();

  // Validate and show errors
  const errors = validateDraft(draft);
  renderErrors(errors);

  const hasErrors = !!(errors.name || errors.count || errors.points || errors.clues);
  setPill(hasErrors ? 'Utkast (fel)' : dirty ? 'Utkast (osparat)' : 'Utkast', !hasErrors);

  if (!storageWritable) {
    showStatus('LocalStorage är låst. Utkast kan inte sparas på denna enhet.', 'warn');
  }

  // Uppdatera karta-markers
  broadcastDraftToMap();
}

/* ============================================================
   BLOCK 9 — Autosave (debounced)
============================================================ */
function scheduleSave() {
  if (!storageWritable) return;
  if (saveTimer) clearTimeout(saveTimer);

  saveTimer = setTimeout(() => {
    const ok = writeDraft(draft);
    if (ok) {
      dirty = false;
      setPill('Utkast sparat', true);
      setTimeout(() => { if (!dirty) setPill('Utkast', true); }, 1200);
    }
  }, 350);
}

function markDirtyAndRender(triggerSave = true) {
  dirty = true;
  renderAll();
  if (triggerSave) scheduleSave();
}

/* ============================================================
   BLOCK 10 — AO 2/8: add checkpoint from map click
============================================================ */
function isMapReady() {
  const api = window.__ADMIN_MAP_API__;
  return !!(api && typeof api.isReady === 'function' && api.isReady());
}

function addCheckpointFromMap(lat, lng) {
  if (!isMapReady()) {
    // Fail-closed: karta inte init → disable “lägg cp” (klick blir no-op + status)
    showStatus('Kartan är inte redo. Kan inte lägga checkpoint.', 'warn');
    return;
  }

  if (draft.checkpointCount >= 20) {
    showStatus('Max 20 checkpoints nått.', 'warn');
    return;
  }

  // Ny CP sist
  const nextIndex = draft.checkpointCount; // 0-based
  syncCountToStructures(draft, draft.checkpointCount + 1);

  const cp = draft.checkpoints[nextIndex];
  cp.lat = Number(lat);
  cp.lng = Number(lng);
  cp.radius = 25;
  cp.code = '';
  cp.points = null;
  cp.clue = draft.clues[nextIndex] || `Checkpoint ${nextIndex + 1}: Ledtråd...`;

  // Center view lite på första koordinat
  const api = window.__ADMIN_MAP_API__;
  if (api && typeof api.setViewIfNeeded === 'function' && nextIndex === 0) {
    try { api.setViewIfNeeded(cp.lat, cp.lng, 15); } catch (_) {}
  }

  markDirtyAndRender(true);
  showStatus(`Checkpoint ${nextIndex + 1} tillagd från karta.`, 'info');
}

function bindMapEvents() {
  window.addEventListener('admin:map-click', (e) => {
    const lat = e?.detail?.lat;
    const lng = e?.detail?.lng;
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return;
    addCheckpointFromMap(lat, lng);
  });
}

/* ============================================================
   BLOCK 11 — Events (form + buttons)
============================================================ */
function bindEvents() {
  // Back
  if (elBack) {
    elBack.addEventListener('click', () => {
      if (window.history.length > 1) window.history.back();
      else window.location.assign('../index.html');
    });
  }

  // Name
  if (elName) {
    elName.addEventListener('input', (e) => {
      draft.name = safeText(e.target.value);
      markDirtyAndRender(true);
    });
  }

  // Count (manual)
  if (elCount) {
    elCount.addEventListener('input', (e) => {
      syncCountToStructures(draft, e.target.value);
      markDirtyAndRender(true);
    });
  }

  // Points (default per cp)
  if (elPoints) {
    elPoints.addEventListener('input', (e) => {
      draft.pointsPerCheckpoint = clampInt(e.target.value, 0, 1000);
      markDirtyAndRender(true);
    });
  }

  // Add/Remove checkpoint buttons (behåll gamla knappar som count +/-)
  if (elAddCp) {
    elAddCp.addEventListener('click', () => {
      syncCountToStructures(draft, draft.checkpointCount + 1);
      markDirtyAndRender(true);
    });
  }
  if (elRemoveCp) {
    elRemoveCp.addEventListener('click', () => {
      syncCountToStructures(draft, draft.checkpointCount - 1);
      markDirtyAndRender(true);
    });
  }

  // Save
  if (elSave) {
    elSave.addEventListener('click', () => {
      const errors = validateDraft(draft);
      renderErrors(errors);
      const hasErrors = !!(errors.name || errors.count || errors.points || errors.clues);
      if (hasErrors) {
        showStatus('Rätta felen i formuläret innan du sparar.', 'warn');
        setPill('Utkast (fel)', false);
        return;
      }
      syncDerivedFields();
      const ok = writeDraft(draft);
      if (ok) {
        dirty = false;
        showStatus('Utkast sparat lokalt.', 'info');
        setPill('Utkast sparat', true);
        setTimeout(() => { if (!dirty) setPill('Utkast', true); }, 1200);
      } else {
        showStatus('Kunde inte spara utkast.', 'warn');
      }
    });
  }

  // Reset
  if (elReset) {
    elReset.addEventListener('click', () => {
      const ok = window.confirm('Rensa lokalt utkast?');
      if (!ok) return;

      draft = defaultDraft();
      dirty = true;

      try { localStorage.removeItem(DRAFT_KEY); } catch (_) {}
      renderAll();
      showStatus('Utkast rensat.', 'info');
    });
  }
}

/* ============================================================
   BLOCK 12 — AO 6/6 Export helpers (behåll befintlig export om den redan finns)
   - Vi lämnar export-panelen injected som tidigare.
   - Uppdaterar JSON så att den fortfarande innehåller v1 fields + extra geo (fail-soft).
============================================================ */

// Rimlig maxlängd för querystring payload.
const MAX_INLINE_QS_CHARS = 1400; // HOOK: max-inline-payload

let elExportRoot = null;
let elExportMsg = null;
let elExportLink = null;
let elExportJSON = null;
let elBtnCopyJSON = null;
let elBtnMakeLink = null;
let elBtnCopyLink = null;

function hasBlockingErrors() {
  const errors = validateDraft(draft);
  return !!(errors.name || errors.count || errors.points || errors.clues);
}

function getDraftJSON({ pretty = false } = {}) {
  syncDerivedFields();

  // Bas (måste vara kompatibel med party.js payload-validator i tidigare AO)
  const payload = {
    version: 1,
    name: safeText(draft.name).trim(),
    checkpointCount: clampInt(draft.checkpointCount, 1, 20),
    pointsPerCheckpoint: clampInt(draft.pointsPerCheckpoint, 0, 1000),
    clues: Array.isArray(draft.clues) ? draft.clues.map((c) => safeText(c).trim()) : []
  };

  // AO 2/8 extra geo: fail-soft (party.js ignorerar okända fält)
  payload.geo = Array.isArray(draft.checkpoints)
    ? draft.checkpoints.map((cp) => ({
        lat: Number.isFinite(Number(cp.lat)) ? Number(cp.lat) : null,
        lng: Number.isFinite(Number(cp.lng)) ? Number(cp.lng) : null,
        radius: clampInt(cp.radius ?? 25, 5, 5000),
        code: safeText(cp.code).trim(),
        points: (cp.points === null || cp.points === undefined) ? null : clampInt(cp.points, 0, 1000)
      }))
    : [];

  return JSON.stringify(payload, null, pretty ? 2 : 0);
}

function setExportMessage(msg, type = 'info') {
  if (!elExportMsg) return;
  elExportMsg.textContent = msg || '';
  elExportMsg.style.color =
    type === 'danger' ? 'rgba(251,113,133,.95)' :
    type === 'warn' ? 'rgba(251,191,36,.95)' :
    'rgba(255,255,255,.85)';
}

function ensureExportPanel() {
  if (elExportRoot) return;

  const previewCard = elPreviewList?.closest('.card') || null;
  const mount = previewCard || document.querySelector('.container') || document.body;

  const card = document.createElement('section');
  card.className = 'card';
  card.setAttribute('aria-label', 'Export');

  const head = document.createElement('div');
  head.className = 'card__head';
  const meta = document.createElement('div');
  meta.className = 'card__meta';

  const h = document.createElement('h2');
  h.className = 'h2';
  h.style.margin = '0';
  h.textContent = 'Export';

  const p = document.createElement('p');
  p.className = 'muted small';
  p.style.margin = '6px 0 0 0';
  p.textContent = 'Dela jakten utan konto: kopiera JSON eller skapa en delbar länk.';

  meta.appendChild(h);
  meta.appendChild(p);
  head.appendChild(meta);

  const body = document.createElement('div');
  body.style.display = 'grid';
  body.style.gap = '10px';
  body.style.padding = '12px 0 0 0';

  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.gap = '10px';
  row.style.flexWrap = 'wrap';

  const btnJson = document.createElement('button');
  btnJson.type = 'button';
  btnJson.className = 'btn btn-ghost miniBtn';
  btnJson.textContent = 'Kopiera JSON';
  elBtnCopyJSON = btnJson;

  const btnLink = document.createElement('button');
  btnLink.type = 'button';
  btnLink.className = 'btn btn-ghost miniBtn';
  btnLink.textContent = 'Skapa QR-länk';
  elBtnMakeLink = btnLink;

  const btnCopyLink = document.createElement('button');
  btnCopyLink.type = 'button';
  btnCopyLink.className = 'btn btn-ghost miniBtn';
  btnCopyLink.textContent = 'Kopiera länk';
  btnCopyLink.disabled = true;
  elBtnCopyLink = btnCopyLink;

  row.appendChild(btnJson);
  row.appendChild(btnLink);
  row.appendChild(btnCopyLink);

  const msg = document.createElement('div');
  msg.className = 'muted small';
  msg.style.minHeight = '18px';
  msg.style.marginTop = '2px';
  msg.textContent = '';
  elExportMsg = msg;

  const linkBox = document.createElement('div');
  linkBox.style.display = 'grid';
  linkBox.style.gap = '6px';

  const linkLabel = document.createElement('div');
  linkLabel.className = 'muted small';
  linkLabel.textContent = 'Delbar länk';

  const linkInput = document.createElement('input');
  linkInput.className = 'input';
  linkInput.type = 'text';
  linkInput.readOnly = true;
  linkInput.value = '';
  linkInput.placeholder = 'Skapa länk för att visa här…';
  elExportLink = linkInput;

  linkBox.appendChild(linkLabel);
  linkBox.appendChild(linkInput);

  const jsonBox = document.createElement('div');
  jsonBox.style.display = 'grid';
  jsonBox.style.gap = '6px';
  jsonBox.style.marginTop = '6px';

  const jsonLabel = document.createElement('div');
  jsonLabel.className = 'muted small';
  jsonLabel.textContent = 'JSON (fallback om kopiering nekas: markera texten och kopiera manuellt)';

  const ta = document.createElement('textarea');
  ta.className = 'input';
  ta.style.minHeight = '120px';
  ta.value = '';
  ta.readOnly = true;
  elExportJSON = ta;

  jsonBox.appendChild(jsonLabel);
  jsonBox.appendChild(ta);

  body.appendChild(row);
  body.appendChild(msg);
  body.appendChild(linkBox);
  body.appendChild(jsonBox);

  card.appendChild(head);
  card.appendChild(body);

  if (previewCard && previewCard.parentNode) {
    previewCard.parentNode.insertBefore(card, previewCard.nextSibling);
  } else {
    mount.appendChild(card);
  }

  elExportRoot = card;

  // Bind export events
  if (elBtnCopyJSON) elBtnCopyJSON.addEventListener('click', async () => { await onCopyJSON(); });
  if (elBtnMakeLink) elBtnMakeLink.addEventListener('click', async () => { await onMakeShareLink(); });
  if (elBtnCopyLink) elBtnCopyLink.addEventListener('click', async () => { await onCopyLink(); });
}

function renderExportUI() {
  if (!elExportRoot) return;
  const json = getDraftJSON({ pretty: true });
  if (elExportJSON) elExportJSON.value = json;
}

function selectAll(el) {
  if (!el) return;
  try {
    el.focus();
    if (typeof el.select === 'function') el.select();
    if (typeof el.setSelectionRange === 'function') el.setSelectionRange(0, String(el.value || '').length);
  } catch (_) {}
}

async function onCopyJSON() {
  ensureExportPanel();
  const json = getDraftJSON({ pretty: true });
  if (elExportJSON) elExportJSON.value = json;

  if (hasBlockingErrors()) {
    setExportMessage('Rätta felen i formuläret innan du exporterar.', 'warn');
    selectAll(elExportJSON);
    return;
  }

  const res = await copyToClipboard(json);
  if (res && res.ok) {
    setExportMessage('JSON kopierat.', 'info');
    return;
  }

  setExportMessage('Kopiering nekades. Markera JSON-rutan och kopiera manuellt (Ctrl/Cmd+C).', 'warn');
  selectAll(elExportJSON);
}

function makeInlineShareURL(payloadJSON) {
  const url = new URL('../index.html', window.location.href);

  const encoded = encodeURIComponent(payloadJSON);
  if (encoded.length > MAX_INLINE_QS_CHARS) {
    return { ok: false, reason: 'too-large', encodedLength: encoded.length };
  }

  url.searchParams.set('mode', 'party');
  url.searchParams.set('payload', encoded);

  return { ok: true, url: url.toString(), encodedLength: encoded.length };
}

async function onMakeShareLink() {
  ensureExportPanel();

  if (hasBlockingErrors()) {
    setExportMessage('Rätta felen i formuläret innan du skapar länk.', 'warn');
    return;
  }

  const jsonMin = getDraftJSON({ pretty: false });
  const out = makeInlineShareURL(jsonMin);

  if (!out.ok) {
    if (out.reason === 'too-large') {
      setExportMessage('För stor att dela som länk. Använd “Kopiera JSON” istället.', 'danger');
      if (elExportLink) elExportLink.value = '';
      if (elBtnCopyLink) elBtnCopyLink.disabled = true;
      return;
    }
    setExportMessage('Kunde inte skapa länk (okänt fel).', 'danger');
    return;
  }

  if (elExportLink) elExportLink.value = out.url;
  if (elBtnCopyLink) elBtnCopyLink.disabled = false;

  setExportMessage('Länk skapad. Du kan nu kopiera den.', 'info');
  selectAll(elExportLink);
}

async function onCopyLink() {
  ensureExportPanel();

  const link = safeText(elExportLink?.value).trim();
  if (!link) {
    setExportMessage('Skapa en länk först.', 'warn');
    return;
  }

  const res = await copyToClipboard(link);
  if (res && res.ok) {
    setExportMessage('Länk kopierad.', 'info');
    return;
  }

  setExportMessage('Kopiering nekades. Markera länken och kopiera manuellt.', 'warn');
  selectAll(elExportLink);
}

/* ============================================================
   BLOCK 13 — Boot
============================================================ */
(function bootAdmin() {
  'use strict';

  if (window.__FAS12_AO5_ADMIN_INIT__) return; // HOOK: init-guard-admin
  window.__FAS12_AO5_ADMIN_INIT__ = true;

  // Export-panel (AO 6/6)
  ensureExportPanel();

  // Events
  bindMapEvents();
  bindEvents();

  // First render
  renderAll();
  renderExportUI();

  setPill('Utkast', true);

  // Fail-closed: om kartan inte är init, indikera att map-klick inte kan lägga cp
  if (!isMapReady()) {
    showStatus('Karta ej redo: Klick på karta kan inte lägga checkpoints just nu.', 'warn');
  }
})();
