/* ============================================================
   FIL: src/admin.js  (HEL FIL) — PATCH
   AO 3/5 + AO 4/5 + AO 5/5

   - AO 3/5: Flyttar checkpoint-editor render + input events till src/admin-checkpoints.js
   - AO 4/5: Flyttar boot + bindEvents-flöde till src/admin-boot.js (admin.js = state + API)
   - AO 5/5: Tydliga gränser, deterministisk init, inga dubletter (i denna baseline finns inga dubletter)

   Policy: UI-only, XSS-safe, fail-closed, inga nya storage keys
============================================================ */

import { copyToClipboard } from './util.js';
import { readLibrary, findLibraryEntry, upsertLibraryEntry, deleteLibraryEntry } from './admin-library.js';
import { initAdminExport } from './admin-export.js';
import { initAdminCheckpoints } from './admin-checkpoints.js';
import { bootAdmin } from './admin-boot.js';

/* ============================================================
   BLOCK 1 — Storage key + draft shape (state/draft)
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

const elCluesWrap = $('#cluesWrap');       // HOOK: clues-wrap (cp-editor)
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

// Layout v2
const elActiveCpLabel = $('#activeCpLabel'); // HOOK: active-cp-label
const elMapHint = $('#mapHint');             // HOOK: map-hint

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
  div.textContent = (message ?? '').toString();
  elStatusSlot.appendChild(div);
}

/* ============================================================
   BLOCK 3.5 — Loaded library context (för Radera-knapp)
============================================================ */
let loadedLibraryId = '';     // HOOK: loaded-library-id
let loadedLibraryName = '';   // HOOK: loaded-library-name

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

function safeJSONParse(str, fallback = null) {
  try { return JSON.parse(str); } catch (_) { return fallback; }
}

function uid(prefix = 'lib') {
  const p = (prefix || 'lib').toString().replace(/[^a-z0-9_-]/gi, '').slice(0, 16) || 'lib';
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 1e9).toString(36);
  return `${p}_${t}_${r}`;
}

function defaultDraft() {
  return {
    version: 1,
    name: '',
    checkpointCount: 5,
    pointsPerCheckpoint: 10,
    clues: Array.from({ length: 5 }, (_, i) => `Checkpoint ${i + 1}: Ledtråd...`),
    checkpoints: Array.from({ length: 5 }, () => ({
      lat: null,
      lng: null,
      radius: 25,
      code: '',
      clue: '',
      points: null,
      isFinal: false
    }))
  };
}

/* ============================================================
   BLOCK 5 — Draft load/save
============================================================ */
function safeJSONParseWrap(str) {
  try { return { ok: true, value: JSON.parse(str) }; }
  catch (_) { return { ok: false, value: null }; }
}

function readDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return defaultDraft();
    const parsed = safeJSONParseWrap(raw);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') return defaultDraft();
    return migrateDraft(parsed.value);
  } catch (_) {
    storageWritable = false;
    showStatus('LocalStorage är inte tillgängligt. Du kan redigera, men utkast sparas inte.', 'warn');
    return defaultDraft();
  }
}

function writeDraft(d) {
  if (!storageWritable) return false;
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    return true;
  } catch (_) {
    storageWritable = false;
    showStatus('Kunde inte spara utkast (localStorage write fail).', 'warn');
    return false;
  }
}

/* ============================================================
   BLOCK 5.5 — Library (flyttad till src/admin-library.js)
   Policy: admin.js sätter storageWritable=false vid read/write-fel
============================================================ */
function findLibraryEntryLocal(id) {
  const res = findLibraryEntry(id);
  if (!res.ok) {
    storageWritable = false;
    showStatus('LocalStorage är låst. Kan inte läsa biblioteket.', 'warn');
    return null;
  }
  return res.entry;
}

function upsertLibraryEntryLocal(entry) {
  if (!storageWritable) return false;
  const res = upsertLibraryEntry(entry);
  if (!res.ok) {
    storageWritable = false;
    showStatus('Kunde inte skriva till bibliotek (localStorage write fail).', 'warn');
    return false;
  }
  return true;
}

function deleteLibraryEntryLocal(id) {
  if (!storageWritable) return { ok: false, changed: false };
  const res = deleteLibraryEntry(id);
  if (!res.ok) {
    storageWritable = false;
    showStatus('Kunde inte skriva till bibliotek (localStorage write fail).', 'warn');
    return { ok: false, changed: false };
  }
  return { ok: true, changed: !!res.changed };
}

/* ============================================================
   BLOCK 6 — Migration/shape guard + sync (inkl isFinal)
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

  if (!Array.isArray(next.checkpoints)) next.checkpoints = [];
  next.checkpoints = next.checkpoints.map((cp) => {
    const o = (cp && typeof cp === 'object') ? cp : {};
    return {
      lat: Number.isFinite(Number(o.lat)) ? Number(o.lat) : null,
      lng: Number.isFinite(Number(o.lng)) ? Number(o.lng) : null,
      radius: clampInt(o.radius, 5, 5000),
      code: safeText(o.code).trim(),
      clue: safeText(o.clue).trim(),
      points: Number.isFinite(Number(o.points)) ? clampInt(o.points, 0, 1000) : null,
      isFinal: o.isFinal === true
    };
  }).slice(0, 20);

  syncCountToStructures(next, next.checkpointCount);

  for (let i = 0; i < next.checkpointCount; i++) {
    if (!next.checkpoints[i]) continue;
    const c = safeText(next.clues[i] ?? '').trim();
    if (!next.checkpoints[i].clue) next.checkpoints[i].clue = c;
  }

  enforceFinalOnlyOnLast(next);
  return next;
}

function syncCountToStructures(d, nextCount) {
  const n = clampInt(nextCount, 1, 20);
  d.checkpointCount = n;

  while (d.clues.length < n) d.clues.push(`Checkpoint ${d.clues.length + 1}: Ledtråd...`);
  if (d.clues.length > n) d.clues = d.clues.slice(0, n);

  while (d.checkpoints.length < n) {
    d.checkpoints.push({ lat: null, lng: null, radius: 25, code: '', clue: '', points: null, isFinal: false });
  }
  if (d.checkpoints.length > n) d.checkpoints = d.checkpoints.slice(0, n);

  enforceFinalOnlyOnLast(d);
}

function enforceFinalOnlyOnLast(d) {
  const n = clampInt(d.checkpointCount, 1, 20);
  const last = n - 1;

  for (let i = 0; i < d.checkpoints.length; i++) {
    if (!d.checkpoints[i]) continue;
    if (i !== last && d.checkpoints[i].isFinal === true) d.checkpoints[i].isFinal = false;
  }
  if (d.checkpoints[last] && d.checkpoints[last].isFinal !== true) d.checkpoints[last].isFinal = false;
}

function syncDerivedFields() {
  for (let i = 0; i < draft.checkpointCount; i++) {
    const cp = draft.checkpoints[i] || {};
    const c = safeText(cp.clue || draft.clues[i] || '').trim();
    draft.clues[i] = c || `Checkpoint ${i + 1}: Ledtråd...`;
  }
}

/* ============================================================
   BLOCK 6.5 — Load from library (?load=)
============================================================ */
function qsGet(key) {
  try {
    const usp = new URLSearchParams(window.location.search || '');
    return (usp.get(String(key)) ?? '').toString().trim();
  } catch (_) {
    return '';
  }
}

function payloadToDraft(payload) {
  const def = defaultDraft();
  const p = (payload && typeof payload === 'object') ? payload : {};

  const name = safeText(p.name).trim();
  const count = clampInt(p.checkpointCount ?? p.count ?? p.cpCount ?? def.checkpointCount, 1, 20);
  const points = clampInt(p.pointsPerCheckpoint ?? def.pointsPerCheckpoint, 0, 1000);

  const out = { ...def };
  out.name = name || def.name;
  out.checkpointCount = count;
  out.pointsPerCheckpoint = points;

  const clues = Array.isArray(p.clues) ? p.clues.map((x) => safeText(x).trim()).slice(0, 20) : [];
  const geo = Array.isArray(p.geo) ? p.geo.slice(0, 20) : [];

  out.clues = Array.from({ length: count }, (_, i) => clues[i] || `Checkpoint ${i + 1}: Ledtråd...`);
  out.checkpoints = Array.from({ length: count }, (_, i) => {
    const g = (geo[i] && typeof geo[i] === 'object') ? geo[i] : {};
    return {
      lat: Number.isFinite(Number(g.lat)) ? Number(g.lat) : null,
      lng: Number.isFinite(Number(g.lng)) ? Number(g.lng) : null,
      radius: clampInt(g.radius ?? 25, 5, 5000),
      code: safeText(g.code || '').trim(),
      clue: out.clues[i] || '',
      points: (g.points === null || g.points === undefined) ? null : clampInt(g.points, 0, 1000),
      isFinal: (i === count - 1) ? (g.isFinal === true) : false
    };
  });

  enforceFinalOnlyOnLast(out);
  return out;
}

function tryLoadFromLibraryOnBoot() {
  const id = qsGet('load'); // HOOK: qs-load-library
  if (!id) return false;

  const entry = findLibraryEntryLocal(id);
  if (!entry || typeof entry.payloadJSON !== 'string') {
    showStatus('Kunde inte hitta den sparade kartan (load-id).', 'warn');
    return false;
  }

  const payload = safeJSONParse(entry.payloadJSON, null);
  if (!payload || typeof payload !== 'object') {
    showStatus('Sparad karta är korrupt (payload parse-fel).', 'warn');
    return false;
  }

  loadedLibraryId = String(entry.id);
  loadedLibraryName = safeText(entry.name || '').trim();

  draft = migrateDraft(payloadToDraft(payload));
  dirty = true;
  writeDraft(draft);
  showStatus(`Laddade: ${entry.name}`, 'info');
  return true;
}

/* ============================================================
   BLOCK 6.9 — Topbar: Radera-knapp (endast vid ?load=)
============================================================ */
function createDeleteButtonIfLoaded() {
  const urlLoadId = qsGet('load'); // HOOK: delete-source-id
  if (!urlLoadId) return;

  const headerRight = document.querySelector('.headerRight');
  if (!headerRight) return;

  if (document.getElementById('deleteGameBtn')) return;

  const btn = document.createElement('button');
  btn.id = 'deleteGameBtn';
  btn.type = 'button';
  btn.className = 'btn btn-ghost miniBtn';
  btn.textContent = 'Radera';
  btn.setAttribute('aria-label', 'Radera denna skattjakt');

  btn.addEventListener('click', () => {
    if (!storageWritable) {
      showStatus('LocalStorage är låst. Kan inte radera på denna enhet.', 'warn');
      return;
    }

    const entry = findLibraryEntryLocal(urlLoadId);
    const name = safeText(entry?.name || loadedLibraryName || 'denna skattjakt').trim();

    const ok = window.confirm(`Vill du verkligen radera "${name}"?`);
    if (!ok) return;

    const del = deleteLibraryEntryLocal(urlLoadId);
    if (!del.ok) {
      showStatus('Kunde inte radera (storage write fail).', 'warn');
      return;
    }
    if (!del.changed) {
      showStatus('Hittade inget att radera (id saknas i biblioteket).', 'warn');
      return;
    }

    try { localStorage.removeItem(DRAFT_KEY); } catch (_) {}
    showStatus('Raderad.', 'info');

    const u = new URL(window.location.href);
    u.search = '';
    u.hash = '';
    window.location.assign(u.toString());
  });

  headerRight.insertBefore(btn, elSavePill || null);
}

function clearLoadedLibraryContext() {
  loadedLibraryId = '';
  loadedLibraryName = '';
}

/* ============================================================
   BLOCK 7 — Validation (fail-closed)
============================================================ */
function validateDraft(d) {
  const errors = { name: '', count: '', points: '', clues: '' };

  if (!d.name || d.name.trim().length < 2) errors.name = 'Skriv ett namn (minst 2 tecken).';
  else if (d.name.length > 60) errors.name = 'Namn är för långt (max 60 tecken).';

  if (!Number.isFinite(Number(d.checkpointCount)) || d.checkpointCount < 1 || d.checkpointCount > 20) {
    errors.count = 'Antal checkpoints måste vara 1–20.';
  }

  if (!Number.isFinite(Number(d.pointsPerCheckpoint)) || d.pointsPerCheckpoint < 0 || d.pointsPerCheckpoint > 1000) {
    errors.points = 'Poäng måste vara 0–1000.';
  }

  if (!Array.isArray(d.checkpoints) || d.checkpoints.length !== d.checkpointCount) {
    errors.clues = 'Checkpoints måste matcha antal.';
  } else {
    for (let i = 0; i < d.checkpoints.length; i++) {
      const cp = d.checkpoints[i] || {};
      const clue = safeText(cp.clue ?? d.clues[i]).trim();
      if (clue.length < 3) { errors.clues = `Ledtråd ${i + 1} är för kort (minst 3 tecken).`; break; }
      if (clue.length > 140) { errors.clues = `Ledtråd ${i + 1} är för lång (max 140 tecken).`; break; }

      const radius = clampInt(cp.radius, 5, 5000);
      if (!Number.isFinite(Number(radius)) || radius < 5 || radius > 5000) {
        errors.clues = `Radius ${i + 1} är ogiltig (5–5000 m).`; break;
      }

      const points = (cp.points === null || cp.points === undefined) ? d.pointsPerCheckpoint : cp.points;
      const p = clampInt(points, 0, 1000);
      if (!Number.isFinite(Number(p)) || p < 0 || p > 1000) {
        errors.clues = `Poäng ${i + 1} är ogiltig (0–1000).`; break;
      }

      const code = safeText(cp.code).trim();
      if (code.length > 32) { errors.clues = `Kod ${i + 1} är för lång (max 32 tecken).`; break; }
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
   BLOCK 8 — NICE: Random code generator
============================================================ */
const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function randomCode(len = 5) {
  const n = clampInt(len, 4, 12);
  let out = '';
  for (let i = 0; i < n; i++) out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return out;
}

function normalizeCode(s) {
  return safeText(s).trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32);
}

function usedCodesSet() {
  const set = new Set();
  for (let i = 0; i < draft.checkpointCount; i++) {
    const c = normalizeCode(draft.checkpoints[i]?.code || '');
    if (c) set.add(c);
  }
  return set;
}

function generateUniqueCode(existingSet, len = 5) {
  for (let tries = 0; tries < 30; tries++) {
    const c = randomCode(len);
    if (!existingSet.has(c)) return c;
  }
  let base = randomCode(len);
  let suffix = 2;
  while (existingSet.has(`${base}${suffix}`) && suffix < 99) suffix++;
  return normalizeCode(`${base}${suffix}`);
}

function fillRandomCodesForEmpty({ len = 5 } = {}) {
  const used = usedCodesSet();
  let changed = 0;

  for (let i = 0; i < draft.checkpointCount; i++) {
    const cp = draft.checkpoints[i];
    if (!cp) continue;
    const cur = normalizeCode(cp.code || '');
    if (cur) { used.add(cur); continue; }

    const next = generateUniqueCode(used, len);
    cp.code = next;
    used.add(next);
    changed++;
  }
  return changed;
}

/* ============================================================
   BLOCK 9 — State: active checkpoint index (UI använder checkpointsUI)
============================================================ */
let activeCpIndex = 0; // HOOK: active-cp-index

function getActiveCpIndex() { return activeCpIndex; }
function setActiveCpIndex(i) { activeCpIndex = clampInt(i, 0, 999); }

/* ============================================================
   BLOCK 10 — Render (FULL vs LIGHT) + Save-pill state
============================================================ */
let draft = readDraft(); // HOOK: draft-state
let dirty = false;       // HOOK: dirty-state
let saveTimer = null;    // HOOK: autosave-timer

// Export-modul initas deterministiskt en gång
let exportUI = null;     // HOOK: export-ui

// Checkpoints-modul initas deterministiskt en gång
let checkpointsUI = null; // HOOK: checkpoints-ui

function setPillState(kind) {
  if (!elSavePill) return;

  elSavePill.style.color = '';
  elSavePill.style.borderColor = '';
  elSavePill.style.background = '';

  if (kind === 'saved') {
    elSavePill.textContent = 'Sparat';
    elSavePill.style.color = 'rgba(34,197,94,.95)';
    elSavePill.style.borderColor = 'rgba(34,197,94,.35)';
    elSavePill.style.background = 'rgba(34,197,94,.08)';
    return;
  }

  if (kind === 'dirty') {
    elSavePill.textContent = 'Osparat';
    return;
  }

  if (kind === 'error') {
    elSavePill.textContent = 'Fel';
    elSavePill.style.color = 'rgba(251,113,133,.95)';
    elSavePill.style.borderColor = 'rgba(251,113,133,.35)';
    elSavePill.style.background = 'rgba(251,113,133,.08)';
    return;
  }

  if (kind === 'readonly') {
    elSavePill.textContent = 'Read-only';
    elSavePill.style.color = 'rgba(251,191,36,.95)';
    elSavePill.style.borderColor = 'rgba(251,191,36,.35)';
    elSavePill.style.background = 'rgba(251,191,36,.08)';
    return;
  }

  elSavePill.textContent = 'Utkast';
}

function saveNowOrWarn() {
  if (!storageWritable) {
    showStatus('LocalStorage är låst. Kan inte spara här.', 'warn');
    setPillState('readonly');
    return false;
  }
  const ok = writeDraft(draft);
  if (ok) {
    dirty = false;
    setPillState('saved');
    showStatus('Utkast sparat lokalt.', 'info');
    return true;
  }
  showStatus('Kunde inte spara utkast.', 'warn');
  setPillState('readonly');
  return false;
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
      const cp = draft.checkpoints[i] || {};
      const label = (i === draft.checkpointCount - 1 && cp.isFinal)
        ? `🎁 Skattkista: ${draft.clues[i]}`
        : draft.clues[i];
      li.textContent = safeText(label ?? `Checkpoint ${i + 1}`);
      elPreviewList.appendChild(li);
    }
  }
}

function renderHeaderInputs() {
  if (elName) elName.value = draft.name;
  if (elCount) elCount.value = String(draft.checkpointCount);
  if (elPoints) elPoints.value = String(draft.pointsPerCheckpoint);
}

function renderErrorsAndPill() {
  const errors = validateDraft(draft);
  renderErrors(errors);

  const hasErrors = !!(errors.name || errors.count || errors.points || errors.clues);

  if (!storageWritable) {
    setPillState('readonly');
    showStatus('LocalStorage är låst. Utkast kan inte sparas på denna enhet.', 'warn');
    return;
  }

  if (hasErrors) { setPillState('error'); return; }
  if (dirty) { setPillState('dirty'); return; }
  setPillState('saved');
}

function broadcastDraftToMap() {
  window.dispatchEvent(new CustomEvent('admin:draft-changed', {
    detail: { checkpoints: draft.checkpoints, activeCpIndex }
  }));
  const api = window.__ADMIN_MAP_API__;
  if (api && typeof api.setCheckpoints === 'function') {
    try { api.setCheckpoints(draft.checkpoints); } catch (_) {}
  }
}

function ensureCheckpointsModuleOnce() {
  if (checkpointsUI) return;

  checkpointsUI = initAdminCheckpoints({
    // state
    getDraft: () => draft,
    setDraft: (next) => { draft = next; },
    getActiveCpIndex: () => activeCpIndex,
    setActiveCpIndex: (i) => { activeCpIndex = clampInt(i, 0, 999); },

    // helpers
    clampInt,
    safeText,
    normalizeCode,
    enforceFinalOnlyOnLast,

    // ops
    markDirtyLIGHT,
    scheduleSave,
    renderPreview,
    renderErrorsAndPill,
    broadcastDraftToMap,
    showStatus,

    // map
    isMapReady,
    getMapApi: () => window.__ADMIN_MAP_API__,

    // dom hooks
    elCluesWrap,
    elActiveCpLabel,
    elMapHint
  });
}

function renderAllFULL({ broadcastMap = true, rerenderQR = true } = {}) {
  ensureCheckpointsModuleOnce();
  checkpointsUI?.clampActiveIndex?.();

  renderHeaderInputs();
  checkpointsUI?.renderCheckpointEditorFULL?.();
  renderPreview();
  renderErrorsAndPill();

  if (broadcastMap) broadcastDraftToMap();
  if (rerenderQR && exportUI && typeof exportUI.renderQRPanelDebounced === 'function') exportUI.renderQRPanelDebounced();
}

function renderAllLIGHT({ rerenderQR = false } = {}) {
  renderPreview();
  renderErrorsAndPill();
  if (rerenderQR && exportUI && typeof exportUI.renderQRPanelDebounced === 'function') exportUI.renderQRPanelDebounced();
}

/* ============================================================
   BLOCK 11 — Autosave (debounced)
============================================================ */
function scheduleSave() {
  if (!storageWritable) return;
  if (saveTimer) clearTimeout(saveTimer);

  saveTimer = setTimeout(() => {
    const ok = writeDraft(draft);
    if (ok) {
      dirty = false;
      setPillState('saved');
    }
  }, 350);
}

function markDirtyLIGHT(triggerSave = true, { rerenderQR = false } = {}) {
  dirty = true;
  setPillState('dirty');
  if (triggerSave) scheduleSave();
  renderAllLIGHT({ rerenderQR });
}

/* ============================================================
   BLOCK 12 — Map integration (kart-klick sätter position på aktiv CP)
============================================================ */
function isMapReady() {
  const api = window.__ADMIN_MAP_API__;
  return !!(api && typeof api.isReady === 'function' && api.isReady());
}

function bindMapEvents() {
  ensureCheckpointsModuleOnce();
  window.addEventListener('admin:map-click', (e) => {
    const lat = e?.detail?.lat;
    const lng = e?.detail?.lng;
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return;
    checkpointsUI?.setActiveCpPositionFromMap?.(lat, lng);
  });
}

/* ============================================================
   BLOCK 13 — Events (form)
============================================================ */
function bindEvents() {
  ensureCheckpointsModuleOnce();

  if (elBack) {
    elBack.addEventListener('click', () => {
      if (window.history.length > 1) window.history.back();
      else window.location.assign('../index.html');
    });
  }

  if (elName) {
    elName.addEventListener('input', (e) => {
      draft.name = safeText(e.target.value);
      markDirtyLIGHT(true, { rerenderQR: true });
    });
  }

  if (elCount) {
    elCount.addEventListener('input', (e) => {
      syncCountToStructures(draft, e.target.value);
      renderAllFULL({ broadcastMap: true, rerenderQR: true });
      dirty = true;
      setPillState('dirty');
      scheduleSave();
    });
  }

  if (elPoints) {
    elPoints.addEventListener('input', (e) => {
      draft.pointsPerCheckpoint = clampInt(e.target.value, 0, 1000);
      markDirtyLIGHT(true, { rerenderQR: false });
    });
  }

  if (elAddCp) {
    elAddCp.addEventListener('click', () => {
      syncCountToStructures(draft, draft.checkpointCount + 1);
      activeCpIndex = draft.checkpointCount - 1;
      dirty = true;
      setPillState('dirty');
      renderAllFULL({ broadcastMap: true, rerenderQR: true });
      scheduleSave();
      showStatus(`Ny checkpoint skapad (CP ${activeCpIndex + 1}). Klicka på kartan för plats.`, 'info');
    });
  }

  if (elRemoveCp) {
    elRemoveCp.addEventListener('click', () => {
      syncCountToStructures(draft, draft.checkpointCount - 1);
      dirty = true;
      setPillState('dirty');
      renderAllFULL({ broadcastMap: true, rerenderQR: true });
      scheduleSave();
    });
  }

  if (elSave) {
    elSave.addEventListener('click', () => {
      const errors = validateDraft(draft);
      renderErrors(errors);
      const hasErrors = !!(errors.name || errors.count || errors.points || errors.clues);
      if (hasErrors) {
        showStatus('Rätta felen i formuläret innan du sparar.', 'warn');
        setPillState('error');
        return;
      }
      syncDerivedFields();
      const ok = writeDraft(draft);
      if (ok) {
        dirty = false;
        showStatus('Utkast sparat lokalt.', 'info');
        setPillState('saved');
      } else {
        showStatus('Kunde inte spara utkast.', 'warn');
        setPillState('readonly');
      }
    });
  }

  if (elReset) {
    elReset.addEventListener('click', () => {
      const ok = window.confirm('Rensa lokalt utkast?');
      if (!ok) return;

      draft = defaultDraft();
      dirty = true;
      activeCpIndex = 0;

      try { localStorage.removeItem(DRAFT_KEY); } catch (_) {}
      renderAllFULL({ broadcastMap: true, rerenderQR: true });
      scheduleSave();
      showStatus('Utkast rensat.', 'info');
      setPillState('dirty');
    });
  }
}

/* ============================================================
   BLOCK 13.5 — Export helpers (behövs av export-modulen)
============================================================ */
function hasBlockingErrors() {
  const errors = validateDraft(draft);
  return !!(errors.name || errors.count || errors.points || errors.clues);
}

function getDraftJSON({ pretty = false } = {}) {
  syncDerivedFields();
  enforceFinalOnlyOnLast(draft);

  const payload = {
    version: 1,
    name: safeText(draft.name).trim(),
    checkpointCount: clampInt(draft.checkpointCount, 1, 20),
    pointsPerCheckpoint: clampInt(draft.pointsPerCheckpoint, 0, 1000),
    clues: Array.isArray(draft.clues) ? draft.clues.map((c) => safeText(c).trim()) : [],
    geo: Array.isArray(draft.checkpoints)
      ? draft.checkpoints.map((cp, i) => ({
          lat: Number.isFinite(Number(cp.lat)) ? Number(cp.lat) : null,
          lng: Number.isFinite(Number(cp.lng)) ? Number(cp.lng) : null,
          radius: clampInt(cp.radius ?? 25, 5, 5000),
          code: normalizeCode(cp.code || ''),
          points: (cp.points === null || cp.points === undefined) ? null : clampInt(cp.points, 0, 1000),
          isFinal: (i === draft.checkpointCount - 1) ? (cp.isFinal === true) : false
        }))
      : []
  };

  return JSON.stringify(payload, null, pretty ? 2 : 0);
}

/* ============================================================
   BLOCK 14 — Export + QR module wiring (AO 2/5)
============================================================ */
function onPublishToLibrary() {
  if (!exportUI) return;

  exportUI.ensureExportPanel();

  if (!storageWritable) {
    exportUI.setExportMessage('LocalStorage är låst. Kan inte publicera på denna enhet.', 'warn');
    return;
  }

  if (hasBlockingErrors()) {
    exportUI.setExportMessage('Rätta felen i formuläret innan du publicerar.', 'warn');
    return;
  }

  const payloadJSON = getDraftJSON({ pretty: false });
  const name = safeText(draft.name).trim() || 'Skattjakt';

  const entryId = loadedLibraryId ? loadedLibraryId : uid('party');

  const entry = {
    id: entryId,
    name,
    checkpointCount: clampInt(draft.checkpointCount, 1, 20),
    updatedAt: Date.now(),
    payloadJSON
  };

  const ok = upsertLibraryEntryLocal(entry);
  if (!ok) {
    exportUI.setExportMessage('Kunde inte publicera (storage write fail).', 'danger');
    return;
  }

  loadedLibraryId = entryId;
  loadedLibraryName = name;

  createDeleteButtonIfLoaded();

  exportUI.setExportMessage('Publicerad! Du hittar den som spelkort på startsidan.', 'info');
  showStatus('Publicerad som spelkort.', 'info');

  try {
    const u = new URL(window.location.href);
    u.searchParams.set('load', entryId);
    exportUI.setExportLinkValue(u.toString());
  } catch (_) {}
}

function initExportModule() {
  if (exportUI) return; // deterministisk init (AO 5/5)
  exportUI = initAdminExport({
    // state
    getDraft: () => draft,

    // helpers
    clampInt,
    normalizeCode,
    getDraftJSON,
    hasBlockingErrors,

    // ops
    copyToClipboard,
    showStatus,
    setPillState,
    scheduleSave,
    renderAllFULL,

    // hooks/actions
    onFillRandomCodes: () => fillRandomCodesForEmpty({ len: 5 }),
    onPublishToLibrary,

    // mount context
    elPreviewList,
  });
}

function getExportUI() {
  return exportUI;
}

/* ============================================================
   BLOCK 16 — Boot (AO 4/5: flyttad till admin-boot.js)
============================================================ */
(function bootAdminMain() {
  'use strict';

  bootAdmin({
    // url
    qsGet,

    // ui
    showStatus,
    isMapReady,
    elActiveCpLabel,
    elMapHint,

    // state getters/setters
    getDraft: () => draft,
    setDraft: (next) => { draft = next; },
    defaultDraft,

    getDirty: () => dirty,
    setDirty: (v) => { dirty = !!v; },

    getActiveCpIndex,
    setActiveCpIndex: (i) => { activeCpIndex = clampInt(i, 0, 999); },

    // draft ops
    readDraft,
    writeDraft,
    removeDraftKey: () => { try { localStorage.removeItem(DRAFT_KEY); } catch (_) {} },

    // loaded context ops
    clearLoadedLibraryContext,

    // library boot
    tryLoadFromLibraryOnBoot,
    createDeleteButtonIfLoaded,

    // export boot
    initExportModule,
    getExportUI,

    // binds
    bindMapEvents,
    bindEvents,

    // render
    renderAllFULL,
    renderErrorsAndPill
  });
})();
