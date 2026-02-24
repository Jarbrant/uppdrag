/* ============================================================
   FIL: src/admin.js  (HEL FIL)
   PATCH (FAS 2.2) — Radera spel från library (PARTY_LIBRARY_V1) vid ?load=
                    + Topbar-knapp “Radera” med confirm
                    + Save-pill: “Sparat” (grön) / “Osparat” / “Fel”
   AO 2/5 — Flytta Export + QR till src/admin-export.js (kortare admin.js)
   Policy: UI-only, XSS-safe, fail-closed, inga nya storage keys
============================================================ */

import { copyToClipboard } from './util.js';
import { readLibrary, findLibraryEntry, upsertLibraryEntry, deleteLibraryEntry } from './admin-library.js';
import { initAdminExport } from './admin-export.js';

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
   BLOCK 9 — Aktiv checkpoint (för kart-flöde)
============================================================ */
let activeCpIndex = 0; // HOOK: active-cp-index

function clampActiveIndex() {
  const max = Math.max(0, (draft?.checkpointCount || 1) - 1);
  activeCpIndex = clampInt(activeCpIndex, 0, max);
}

function setActiveCp(index, { centerMap = true } = {}) {
  clampActiveIndex();
  const max = Math.max(0, (draft?.checkpointCount || 1) - 1);
  activeCpIndex = clampInt(index, 0, max);

  if (elActiveCpLabel) elActiveCpLabel.textContent = `CP ${activeCpIndex + 1}`;
  if (elMapHint) elMapHint.textContent = `Aktiv CP ${activeCpIndex + 1} — klicka på kartan för att sätta plats.`;

  try {
    document.querySelectorAll('[data-cp-row]').forEach((el) => {
      const i = Number(el.getAttribute('data-cp-row'));
      el.classList.toggle('is-active', i === activeCpIndex);
      el.setAttribute('aria-current', i === activeCpIndex ? 'true' : 'false');
    });
  } catch (_) {}

  if (centerMap) {
    const cp = draft?.checkpoints?.[activeCpIndex];
    const api = window.__ADMIN_MAP_API__;
    if (api && typeof api.setViewIfNeeded === 'function' && cp) {
      try { api.setViewIfNeeded(cp.lat, cp.lng, 15); } catch (_) {}
    }
  }
}

/* ============================================================
   BLOCK 10 — Render (FULL vs LIGHT) + Save-pill state
============================================================ */
let draft = readDraft(); // HOOK: draft-state
let dirty = false;       // HOOK: dirty-state
let saveTimer = null;    // HOOK: autosave-timer

// Export-modul initas senare (för att undvika TDZ/cirklar)
let exportUI = null;     // HOOK: export-ui

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

function renderCheckpointEditorFULL() {
  if (!elCluesWrap) return;
  clampActiveIndex();

  elCluesWrap.innerHTML = '';

  for (let i = 0; i < draft.checkpointCount; i++) {
    const cp = draft.checkpoints[i] || {};
    const isLast = i === (draft.checkpointCount - 1);

    const row = document.createElement('div');
    row.className = 'clueRow';
    row.setAttribute('data-cp-row', String(i));
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `Välj checkpoint ${i + 1}`);

    function isEditableTarget(evt) {
      const t = evt?.target;
      const tag = (t?.tagName || '').toUpperCase();
      return (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable === true);
    }

    row.addEventListener('click', (e) => {
      if (isEditableTarget(e)) return;
      setActiveCp(i, { centerMap: true });
    });

    row.addEventListener('keydown', (e) => {
      if (isEditableTarget(e)) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setActiveCp(i, { centerMap: true });
      }
    });

    if (i === activeCpIndex) row.classList.add('is-active');

    const meta = document.createElement('div');
    meta.className = 'clueMeta';

    const idx = document.createElement('div');
    idx.className = 'clueIdx';
    idx.textContent = `CP ${i + 1}`;

    const coord = document.createElement('div');
    coord.className = 'muted small';
    coord.setAttribute('data-cp-coord', String(i));
    const lat = Number.isFinite(Number(cp.lat)) ? Number(cp.lat).toFixed(5) : '—';
    const lng = Number.isFinite(Number(cp.lng)) ? Number(cp.lng).toFixed(5) : '—';
    coord.textContent = `(${lat}, ${lng})`;

    meta.appendChild(idx);
    meta.appendChild(coord);

    const clueInput = document.createElement('input');
    clueInput.className = 'input clueInput';
    clueInput.type = 'text';
    clueInput.autocomplete = 'off';
    clueInput.placeholder = isLast && cp.isFinal ? 'Skattkista: ledtråd…' : 'Skriv ledtråd…';
    clueInput.value = safeText(cp.clue || draft.clues[i] || '');
    clueInput.setAttribute('data-cp-index', String(i));
    clueInput.addEventListener('focus', () => setActiveCp(i, { centerMap: false }));
    clueInput.addEventListener('input', (e) => {
      const k = clampInt(e.target.getAttribute('data-cp-index'), 0, 99);
      draft.checkpoints[k].clue = safeText(e.target.value);
      markDirtyLIGHT(true, { rerenderQR: false });
    });

    const grid = document.createElement('div');
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = '1fr 1fr 1fr';
    grid.style.gap = '8px';

    function labeled(labelText, inputEl) {
      const wrap = document.createElement('div');
      wrap.style.display = 'grid';
      wrap.style.gap = '6px';
      const lab = document.createElement('div');
      lab.className = 'muted small';
      lab.textContent = labelText;
      wrap.appendChild(lab);
      wrap.appendChild(inputEl);
      return wrap;
    }

    const points = document.createElement('input');
    points.className = 'input';
    points.type = 'number';
    points.inputMode = 'numeric';
    points.min = '0';
    points.max = '1000';
    points.step = '1';
    points.placeholder = `${draft.pointsPerCheckpoint}`;
    points.value = (cp.points === null || cp.points === undefined) ? '' : String(cp.points);
    points.setAttribute('data-cp-points', String(i));
    points.addEventListener('focus', () => setActiveCp(i, { centerMap: false }));
    points.addEventListener('input', (e) => {
      const k = clampInt(e.target.getAttribute('data-cp-points'), 0, 99);
      const v = safeText(e.target.value).trim();
      draft.checkpoints[k].points = v === '' ? null : clampInt(v, 0, 1000);
      markDirtyLIGHT(true, { rerenderQR: false });
    });

    const code = document.createElement('input');
    code.className = 'input';
    code.type = 'text';
    code.autocomplete = 'off';
    code.placeholder = 'ex: HJBH6';
    code.value = safeText(cp.code || '');
    code.setAttribute('data-cp-code', String(i));
    code.addEventListener('focus', () => setActiveCp(i, { centerMap: false }));
    code.addEventListener('input', (e) => {
      const k = clampInt(e.target.getAttribute('data-cp-code'), 0, 99);
      draft.checkpoints[k].code = normalizeCode(e.target.value);
      markDirtyLIGHT(true, { rerenderQR: true });
    });

    const radius = document.createElement('input');
    radius.className = 'input';
    radius.type = 'number';
    radius.inputMode = 'numeric';
    radius.min = '5';
    radius.max = '5000';
    radius.step = '1';
    radius.placeholder = '25';
    radius.value = String(clampInt(cp.radius ?? 25, 5, 5000));
    radius.setAttribute('data-cp-radius', String(i));
    radius.addEventListener('focus', () => setActiveCp(i, { centerMap: false }));
    radius.addEventListener('input', (e) => {
      const k = clampInt(e.target.getAttribute('data-cp-radius'), 0, 99);
      draft.checkpoints[k].radius = clampInt(e.target.value, 5, 5000);
      markDirtyLIGHT(true, { rerenderQR: false });
    });

    grid.appendChild(labeled('Poäng', points));
    grid.appendChild(labeled('Kod', code));
    grid.appendChild(labeled('Radie (m)', radius));

    const codeRow = document.createElement('div');
    codeRow.style.display = 'flex';
    codeRow.style.alignItems = 'center';
    codeRow.style.justifyContent = 'space-between';
    codeRow.style.gap = '10px';
    codeRow.style.marginTop = '6px';

    const codeHint = document.createElement('div');
    codeHint.className = 'muted small';
    codeHint.textContent = 'Kod är valfri (kan genereras).';

    const actionsWrap = document.createElement('div');
    actionsWrap.style.display = 'flex';
    actionsWrap.style.gap = '8px';
    actionsWrap.style.flexWrap = 'wrap';
    actionsWrap.style.justifyContent = 'flex-end';

    const btnRnd = document.createElement('button');
    btnRnd.type = 'button';
    btnRnd.className = 'btn btn-ghost miniBtn';
    btnRnd.textContent = 'Slumpkod';
    btnRnd.setAttribute('data-cp-rnd', String(i));
    btnRnd.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const k = clampInt(btnRnd.getAttribute('data-cp-rnd'), 0, 99);
      setActiveCp(k, { centerMap: false });

      const cur = normalizeCode(draft.checkpoints[k]?.code || '');
      if (cur) { showStatus(`CP ${k + 1} har redan en kod.`, 'warn'); return; }

      const used = usedCodesSet();
      const next = generateUniqueCode(used, 5);
      draft.checkpoints[k].code = next;

      const input = document.querySelector(`input[data-cp-code="${k}"]`);
      if (input) input.value = next;

      markDirtyLIGHT(true, { rerenderQR: true });
      showStatus(`Kod skapad för CP ${k + 1}.`, 'info');
    });

    const btnSaveCp = document.createElement('button');
    btnSaveCp.type = 'button';
    btnSaveCp.className = 'btn btn-primary miniBtn';
    btnSaveCp.textContent = 'Spara';
    btnSaveCp.setAttribute('data-cp-save', String(i));
    btnSaveCp.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      saveNowOrWarn();
    });

    actionsWrap.appendChild(btnRnd);
    actionsWrap.appendChild(btnSaveCp);

    codeRow.appendChild(codeHint);
    codeRow.appendChild(actionsWrap);

    const finalRow = document.createElement('div');
    finalRow.style.display = 'flex';
    finalRow.style.alignItems = 'center';
    finalRow.style.justifyContent = 'space-between';
    finalRow.style.gap = '10px';
    finalRow.style.marginTop = '6px';

    const finalLeft = document.createElement('div');
    finalLeft.className = 'muted small';
    finalLeft.textContent = isLast ? 'Final (Skattkista)' : 'Final kan bara vara sista checkpoint';

    const finalToggleWrap = document.createElement('label');
    finalToggleWrap.style.display = 'inline-flex';
    finalToggleWrap.style.alignItems = 'center';
    finalToggleWrap.style.gap = '8px';
    finalToggleWrap.style.userSelect = 'none';

    const finalToggle = document.createElement('input');
    finalToggle.type = 'checkbox';
    finalToggle.checked = (isLast && cp.isFinal === true);
    finalToggle.disabled = !isLast;
    finalToggle.setAttribute('data-cp-final', String(i));
    finalToggle.setAttribute('aria-label', 'Markera som Skattkista (final)');
    finalToggle.addEventListener('click', (ev) => ev.stopPropagation());

    const finalText = document.createElement('span');
    finalText.className = 'muted small';
    finalText.textContent = 'Skattkista';

    finalToggleWrap.appendChild(finalToggle);
    finalToggleWrap.appendChild(finalText);

    finalToggle.addEventListener('change', (e) => {
      const k = clampInt(e.target.getAttribute('data-cp-final'), 0, 99);
      const isLastNow = k === (draft.checkpointCount - 1);
      if (!isLastNow) return;
      draft.checkpoints[k].isFinal = !!e.target.checked;
      enforceFinalOnlyOnLast(draft);
      markDirtyLIGHT(true, { rerenderQR: false });
      renderPreview();
    });

    finalRow.appendChild(finalLeft);
    finalRow.appendChild(finalToggleWrap);

    row.appendChild(meta);
    row.appendChild(clueInput);
    row.appendChild(grid);
    row.appendChild(codeRow);
    row.appendChild(finalRow);

    elCluesWrap.appendChild(row);
  }

  setActiveCp(activeCpIndex, { centerMap: false });
}

function renderAllFULL({ broadcastMap = true, rerenderQR = true } = {}) {
  clampActiveIndex();
  renderHeaderInputs();
  renderCheckpointEditorFULL();
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

function updateCoordText(index) {
  const cp = draft.checkpoints[index] || {};
  const lat = Number.isFinite(Number(cp.lat)) ? Number(cp.lat).toFixed(5) : '—';
  const lng = Number.isFinite(Number(cp.lng)) ? Number(cp.lng).toFixed(5) : '—';
  const node = document.querySelector(`[data-cp-coord="${index}"]`);
  if (node) node.textContent = `(${lat}, ${lng})`;
}

function setActiveCpPositionFromMap(lat, lng) {
  if (!isMapReady()) { showStatus('Kartan är inte redo. Kan inte sätta position.', 'warn'); return; }
  clampActiveIndex();

  const cp = draft.checkpoints[activeCpIndex];
  if (!cp) { showStatus('Ingen aktiv checkpoint. Välj checkpoint först.', 'warn'); return; }

  cp.lat = Number(lat);
  cp.lng = Number(lng);

  dirty = true;
  setPillState('dirty');
  scheduleSave();

  updateCoordText(activeCpIndex);
  broadcastDraftToMap();

  showStatus(`Plats satt för CP ${activeCpIndex + 1}.`, 'info');
  renderErrorsAndPill();
}

function bindMapEvents() {
  window.addEventListener('admin:map-click', (e) => {
    const lat = e?.detail?.lat;
    const lng = e?.detail?.lng;
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return;
    setActiveCpPositionFromMap(lat, lng);
  });
}

/* ============================================================
   BLOCK 13 — Events (form)
============================================================ */
function bindEvents() {
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
      clampActiveIndex();
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
      clampActiveIndex();
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

/* ============================================================
   BLOCK 16 — Boot
============================================================ */
(function bootAdmin() {
  'use strict';

  if (window.__FAS12_AO5_ADMIN_INIT__) return; // HOOK: init-guard-admin
  window.__FAS12_AO5_ADMIN_INIT__ = true;

  // 0) FORCE NEW: om admin öppnas med ?new=1 → starta ny skattjakt
  const forceNew = qsGet('new') === '1';
  if (forceNew) {
    try { localStorage.removeItem(DRAFT_KEY); } catch (_) {}
    loadedLibraryId = '';
    loadedLibraryName = '';
    draft = defaultDraft();
    dirty = true;

    showStatus('Nytt utkast skapat.', 'info');

    // städa URL så man inte fastnar i new=1
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete('new');
      window.history.replaceState({}, '', u.toString());
    } catch (_) {}
  }

  // 1) Försök ladda från library om ?load= finns
  tryLoadFromLibraryOnBoot();

  // 2) Skapa Radera-knapp om URL har ?load=
  createDeleteButtonIfLoaded();

  // 3) Init export-modul (AO 2/5) + UI events
  initExportModule();
  if (exportUI) exportUI.ensureExportPanel();

  bindMapEvents();
  bindEvents();

  // 4) Init labels
  if (elActiveCpLabel) elActiveCpLabel.textContent = 'CP 1';
  if (elMapHint) elMapHint.textContent = 'Aktiv CP 1 — klicka på kartan för att sätta plats.';

  // 5) Render
  renderAllFULL({ broadcastMap: true, rerenderQR: true });
  renderErrorsAndPill();

  // 6) Map status
  if (!isMapReady()) showStatus('Karta ej redo. (Leaflet/CDN?)', 'warn');
})();
