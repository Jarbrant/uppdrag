/* ============================================================
   FIL: src/admin.js  (HEL FIL)
   PATCH (FAS 2.1) — FIX: skrivbar editor (ingen re-render per bokstav)
                    + tydliga labels (Poäng/Kod/Radius)
                    + tydligare Final-toggle
   Policy: UI-only, XSS-safe, fail-closed
============================================================ */

import { copyToClipboard } from './util.js';

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
const elQrSlot = $('#qrSlot');               // HOOK: qr-slot
const elQrError = $('#qrError');             // HOOK: qr-error

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
function safeJSONParse(str) {
  try { return { ok: true, value: JSON.parse(str) }; }
  catch (_) { return { ok: false, value: null }; }
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
   BLOCK 10 — Render (FULL vs LIGHT)
   FULL: bygger om editorn (används vid count/add/remove/map coords)
   LIGHT: uppdaterar preview+fel+pill utan att röra editor DOM (fixar skriv-problemet)
============================================================ */
let draft = readDraft(); // HOOK: draft-state
let dirty = false;       // HOOK: dirty-state
let saveTimer = null;    // HOOK: autosave-timer
let qrTimer = null;

function setPill(text, ok = true) {
  if (!elSavePill) return;
  elSavePill.textContent = text;
  elSavePill.style.opacity = ok ? '1' : '0.8';
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
  setPill(hasErrors ? 'Utkast (fel)' : dirty ? 'Utkast (osparat)' : 'Utkast', !hasErrors);

  if (!storageWritable) showStatus('LocalStorage är låst. Utkast kan inte sparas på denna enhet.', 'warn');
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

    // ==============================
    // FIX: Space/Enter ska INTE sabotera input-fält
    // - Om fokus är i ett input/textarea/select/contentEditable -> ignorera
    // ==============================
    function isEditableTarget(evt) {
      const t = evt?.target;
      const tag = (t?.tagName || '').toUpperCase();
      return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        t?.isContentEditable === true
      );
    }

    row.addEventListener('click', (e) => {
      if (isEditableTarget(e)) return; // klick i input ska inte “välja rad”
      setActiveCp(i, { centerMap: true });
    });

    row.addEventListener('keydown', (e) => {
      if (isEditableTarget(e)) return; // FIX: mellanslag funkar i input
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
    coord.setAttribute('data-cp-coord', String(i)); // HOOK: cp-coord
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

    // Labels + inputs: Poäng / Kod / Radius
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

    // Random code (endast om tom)
    const codeRow = document.createElement('div');
    codeRow.style.display = 'flex';
    codeRow.style.alignItems = 'center';
    codeRow.style.justifyContent = 'space-between';
    codeRow.style.gap = '10px';
    codeRow.style.marginTop = '6px';

    const codeHint = document.createElement('div');
    codeHint.className = 'muted small';
    codeHint.textContent = 'Kod är valfri (kan genereras).';

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

    codeRow.appendChild(codeHint);
    codeRow.appendChild(btnRnd);

    // Final toggle (endast sista cp)
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
  if (rerenderQR) renderQRPanelDebounced();
}

function renderAllLIGHT({ rerenderQR = false } = {}) {
  // viktig: rör inte editor DOM här -> fixar “1 bokstav”
  renderPreview();
  renderErrorsAndPill();
  if (rerenderQR) renderQRPanelDebounced();
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
      setPill('Utkast sparat', true);
      setTimeout(() => { if (!dirty) setPill('Utkast', true); }, 1200);
    }
  }, 350);
}

function markDirtyLIGHT(triggerSave = true, { rerenderQR = false } = {}) {
  dirty = true;
  setPill('Utkast (osparat)', true);
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
    });
  }
}

/* ============================================================
   BLOCK 14 — Export (KOPIERA JSON + KOPIERA LÄNK) + Fill random codes
============================================================ */
const MAX_INLINE_QS_CHARS = 1400; // HOOK: max-inline-payload-policy

let elExportRoot = null;
let elExportMsg = null;
let elExportLink = null;
let elExportJSON = null;
let elBtnCopyJSON = null;
let elBtnCopyLink = null;
let elBtnFillCodes = null;

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

function setExportMessage(msg, type = 'info') {
  if (!elExportMsg) return;
  elExportMsg.textContent = msg || '';
  elExportMsg.style.color =
    type === 'danger' ? 'rgba(251,113,133,.95)' :
    type === 'warn' ? 'rgba(251,191,36,.95)' :
    'rgba(255,255,255,.85)';
}

function selectAll(el) {
  if (!el) return;
  try {
    el.focus();
    if (typeof el.select === 'function') el.select();
    if (typeof el.setSelectionRange === 'function') el.setSelectionRange(0, String(el.value || '').length);
  } catch (_) {}
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
  p.textContent = 'Kopiera JSON eller kopiera en länk som startar deltagarvyn.';

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
  btnJson.textContent = 'KOPIERA JSON';
  elBtnCopyJSON = btnJson;

  const btnLink = document.createElement('button');
  btnLink.type = 'button';
  btnLink.className = 'btn btn-ghost miniBtn';
  btnLink.textContent = 'KOPIERA LÄNK';
  elBtnCopyLink = btnLink;

  const btnFill = document.createElement('button');
  btnFill.type = 'button';
  btnFill.className = 'btn btn-ghost miniBtn';
  btnFill.textContent = 'FYLL SLUMPKODER (tomma)';
  elBtnFillCodes = btnFill;

  row.appendChild(btnJson);
  row.appendChild(btnLink);
  row.appendChild(btnFill);

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
  linkLabel.textContent = 'Länk (fallback: markera och kopiera manuellt)';

  const linkInput = document.createElement('input');
  linkInput.className = 'input';
  linkInput.type = 'text';
  linkInput.readOnly = true;
  linkInput.value = '';
  linkInput.placeholder = 'Klicka KOPIERA LÄNK för att skapa + kopiera…';
  elExportLink = linkInput;

  linkBox.appendChild(linkLabel);
  linkBox.appendChild(linkInput);

  const jsonBox = document.createElement('div');
  jsonBox.style.display = 'grid';
  jsonBox.style.gap = '6px';

  const jsonLabel = document.createElement('div');
  jsonLabel.className = 'muted small';
  jsonLabel.textContent = 'JSON (fallback om kopiering nekas: markera och kopiera manuellt)';

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

  if (previewCard && previewCard.parentNode) previewCard.parentNode.insertBefore(card, previewCard.nextSibling);
  else mount.appendChild(card);

  elExportRoot = card;

  if (elBtnCopyJSON) elBtnCopyJSON.addEventListener('click', async () => { await onCopyJSON(); });
  if (elBtnCopyLink) elBtnCopyLink.addEventListener('click', async () => { await onCopyLink(); });
  if (elBtnFillCodes) elBtnFillCodes.addEventListener('click', () => { onFillRandomCodes(); });
}

function renderExportUI() {
  if (!elExportRoot) return;
  const json = getDraftJSON({ pretty: true });
  if (elExportJSON) elExportJSON.value = json;
}

function buildParticipantLinkOrFail() {
  const payloadJSON = getDraftJSON({ pretty: false });
  const encoded = encodeURIComponent(payloadJSON);

  if (encoded.length > MAX_INLINE_QS_CHARS) {
    return { ok: false, reason: 'too-large', encodedLength: encoded.length };
  }

  const url = new URL('party.html', window.location.href);
  url.searchParams.set('mode', 'party');
  url.searchParams.set('payload', encoded);

  return { ok: true, url: url.toString(), encodedLength: encoded.length, payloadEncoded: encoded };
}

function onFillRandomCodes() {
  const changed = fillRandomCodesForEmpty({ len: 5 });
  if (changed <= 0) { setExportMessage('Inga tomma koder att fylla (alla har redan kod).', 'info'); return; }
  dirty = true;
  scheduleSave();
  renderAllFULL({ broadcastMap: false, rerenderQR: true });
  setExportMessage(`Fyllde ${changed} slumpkod${changed === 1 ? '' : 'er'} (endast tomma).`, 'info');
}

async function onCopyJSON() {
  ensureExportPanel();

  const json = getDraftJSON({ pretty: true });
  if (elExportJSON) elExportJSON.value = json;

  if (hasBlockingErrors()) { setExportMessage('Rätta felen i formuläret innan du exporterar.', 'warn'); selectAll(elExportJSON); return; }

  const res = await copyToClipboard(json);
  if (res && res.ok) { setExportMessage('JSON kopierat.', 'info'); return; }

  setExportMessage('Kopiering nekades. Markera JSON-rutan och kopiera manuellt (Ctrl/Cmd+C).', 'warn');
  selectAll(elExportJSON);
}

async function onCopyLink() {
  ensureExportPanel();

  if (hasBlockingErrors()) { setExportMessage('Rätta felen i formuläret innan du kopierar länk.', 'warn'); return; }

  const built = buildParticipantLinkOrFail();
  if (!built.ok) {
    if (built.reason === 'too-large') {
      setExportMessage('Payload för stor att dela som länk. Använd KOPIERA JSON istället.', 'danger');
      if (elExportLink) elExportLink.value = '';
      selectAll(elExportJSON);
      return;
    }
    setExportMessage('Kunde inte skapa länk (okänt fel).', 'danger');
    return;
  }

  if (elExportLink) elExportLink.value = built.url;

  const res = await copyToClipboard(built.url);
  if (res && res.ok) { setExportMessage('Länk kopierad (startar deltagarvyn).', 'info'); return; }

  setExportMessage('Kopiering nekades. Markera länken och kopiera manuellt.', 'warn');
  selectAll(elExportLink);
}

/* ============================================================
   BLOCK 15 — QR per checkpoint (NICE) — debounced
============================================================ */
function setQrError(msg) {
  if (!elQrError) return;
  elQrError.textContent = msg || '';
}

function clearQr() {
  if (elQrSlot) elQrSlot.innerHTML = '';
  setQrError('');
}

function qrImgUrlFor(text) {
  const size = 200;
  const enc = encodeURIComponent(text);
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${enc}`;
}

async function copyTextOrSelect(inputEl, text) {
  const res = await copyToClipboard(text);
  if (res && res.ok) { showStatus('Kopierat.', 'info'); return true; }
  if (inputEl) {
    try { inputEl.focus(); inputEl.select(); inputEl.setSelectionRange(0, inputEl.value.length); } catch (_) {}
  }
  showStatus('Kopiering nekades. Markera texten och kopiera manuellt.', 'warn');
  return false;
}

function renderQRPanelDebounced() {
  if (!elQrSlot) return;
  if (qrTimer) clearTimeout(qrTimer);
  qrTimer = setTimeout(() => renderQRPanel(), 180);
}

function renderQRPanel() {
  if (!elQrSlot) return;
  clearQr();

  if (hasBlockingErrors()) { setQrError('QR kräver att formuläret är utan fel. Rätta felen först.'); return; }

  const built = buildParticipantLinkOrFail();
  if (!built.ok) { setQrError('Payload för stor att dela som länk. Använd KOPIERA JSON istället.'); return; }

  const baseUrl = new URL(built.url);
  const payloadEncoded = built.payloadEncoded;

  for (let i = 0; i < draft.checkpointCount; i++) {
    const cp = draft.checkpoints[i] || {};
    const cpNo = i + 1;

    const u = new URL(baseUrl.toString());
    u.searchParams.set('payload', payloadEncoded);
    u.searchParams.set('cp', String(cpNo));
    const code = normalizeCode(cp.code || '');
    if (code) u.searchParams.set('code', code);

    const link = u.toString();

    const row = document.createElement('div');
    row.className = 'qrRow';

    const top = document.createElement('div');
    top.className = 'qrRowTop';

    const title = document.createElement('div');
    title.className = 'qrTitle';
    title.textContent = `CP ${cpNo}${(i === draft.checkpointCount - 1 && cp.isFinal) ? ' (Skattkista)' : ''}`;

    const actions = document.createElement('div');
    actions.className = 'qrActions';

    const btnCopy = document.createElement('button');
    btnCopy.type = 'button';
    btnCopy.className = 'btn btn-ghost miniBtn';
    btnCopy.textContent = 'Kopiera länk';

    const btnToggle = document.createElement('button');
    btnToggle.type = 'button';
    btnToggle.className = 'btn btn-ghost miniBtn';
    btnToggle.textContent = 'Visa QR';

    top.appendChild(title);
    top.appendChild(actions);
    actions.appendChild(btnCopy);
    actions.appendChild(btnToggle);

    const input = document.createElement('input');
    input.className = 'input';
    input.type = 'text';
    input.readOnly = true;
    input.value = link;

    const img = document.createElement('img');
    img.className = 'qrImg';
    img.alt = `QR för CP ${cpNo}`;
    img.loading = 'lazy';

    btnCopy.addEventListener('click', async (ev) => { ev.preventDefault(); await copyTextOrSelect(input, link); });
    btnToggle.addEventListener('click', (ev) => {
      ev.preventDefault();
      const showing = img.style.display === 'block';
      if (showing) { img.style.display = 'none'; btnToggle.textContent = 'Visa QR'; return; }
      if (!img.src) img.src = qrImgUrlFor(link);
      img.style.display = 'block';
      btnToggle.textContent = 'Dölj QR';
    });

    row.appendChild(top);
    row.appendChild(input);
    row.appendChild(img);

    elQrSlot.appendChild(row);
  }
}

/* ============================================================
   BLOCK 16 — Boot
============================================================ */
(function bootAdmin() {
  'use strict';

  if (window.__FAS12_AO5_ADMIN_INIT__) return; // HOOK: init-guard-admin
  window.__FAS12_AO5_ADMIN_INIT__ = true;

  ensureExportPanel();
  bindMapEvents();
  bindEvents();

  // init hints
  if (elActiveCpLabel) elActiveCpLabel.textContent = 'CP 1';
  if (elMapHint) elMapHint.textContent = 'Aktiv CP 1 — klicka på kartan för att sätta plats.';

  renderAllFULL({ broadcastMap: true, rerenderQR: true });
  setPill('Utkast', true);

  if (!isMapReady()) showStatus('Karta ej redo. (Leaflet/CDN?)', 'warn');
})();
