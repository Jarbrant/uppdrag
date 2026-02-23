/* ============================================================
   FIL: src/admin.js  (HEL FIL)
   AO 5/6 (FAS 1.2) — Admin UI: skapa skattjakt (lokalt, utan konto)
   KRAV:
   - Formfält: namn, antal (1–20), poäng/checkpoint (default), ledtrådar (lista växer/krymper)
   - Live preview cp-lista
   - Local draft: localStorage med EN stabil key
   - Fail-closed: ogiltig input -> error text under fält (inte alert)
   Kodkrav: BLOCK för state/draft, render loop, events, validate
   Policy: UI-only, inga externa libs, XSS-safe rendering
============================================================ */

/* ============================================================
   BLOCK 1 — Storage key + draft shape (state/draft)  (KRAV)
   Draft shape:
   {
     version: 1,
     name: string,
     checkpointCount: number (1..20),
     pointsPerCheckpoint: number (0..1000),
     clues: string[] (length = checkpointCount)
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

const elCluesWrap = $('#cluesWrap');       // HOOK: clues-wrap
const elAddCp = $('#addCpBtn');            // HOOK: add-cp
const elRemoveCp = $('#removeCpBtn');      // HOOK: remove-cp
const elReset = $('#resetBtn');            // HOOK: reset-draft
const elSave = $('#saveBtn');              // HOOK: save-draft

const elErrName = $('#errPartyName');      // HOOK: err-party-name
const elErrCount = $('#errCpCount');       // HOOK: err-checkpoint-count
const elErrPoints = $('#errPointsPer');    // HOOK: err-points-per
const elErrClues = $('#errClues');         // HOOK: err-clues

const elPreviewName = $('#previewName');   // HOOK: preview-name
const elPreviewPoints = $('#previewPoints'); // HOOK: preview-points
const elPreviewCount = $('#previewCount'); // HOOK: preview-count
const elPreviewList = $('#previewList');   // HOOK: preview-list

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
   BLOCK 4 — Defaults + helpers (validate)
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
    clues: Array.from({ length: 5 }, (_, i) => `Checkpoint ${i + 1}: Ledtråd...`)
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

/* ============================================================
   BLOCK 6 — Migration/shape guard (KRAV: migrationslogik)
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

  // Säkerställ att clues.length matchar count
  while (next.clues.length < next.checkpointCount) {
    next.clues.push(`Checkpoint ${next.clues.length + 1}: Ledtråd...`);
  }
  if (next.clues.length > next.checkpointCount) {
    next.clues = next.clues.slice(0, next.checkpointCount);
  }

  return next;
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

  if (!Array.isArray(d.clues) || d.clues.length !== d.checkpointCount) {
    errors.clues = 'Ledtrådar måste matcha antal checkpoints.';
  } else {
    for (let i = 0; i < d.clues.length; i++) {
      const t = safeText(d.clues[i]).trim();
      if (t.length < 3) {
        errors.clues = `Ledtråd ${i + 1} är för kort (minst 3 tecken).`;
        break;
      }
      if (t.length > 140) {
        errors.clues = `Ledtråd ${i + 1} är för lång (max 140 tecken).`;
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
   BLOCK 8 — Render loop (form + preview)
============================================================ */
let draft = readDraft(); // HOOK: draft-state
let dirty = false;       // HOOK: dirty-state
let saveTimer = null;    // HOOK: autosave-timer

function setPill(text, ok = true) {
  if (!elSavePill) return;
  elSavePill.textContent = text;
  // Minimal state marker via text only (CSS tokens already)
  elSavePill.style.opacity = ok ? '1' : '0.8';
}

function renderClueInputs() {
  if (!elCluesWrap) return;
  elCluesWrap.innerHTML = '';

  for (let i = 0; i < draft.checkpointCount; i++) {
    const row = document.createElement('div');
    row.className = 'clueRow';

    const meta = document.createElement('div');
    meta.className = 'clueMeta';

    const idx = document.createElement('div');
    idx.className = 'clueIdx';
    idx.textContent = `Checkpoint ${i + 1}`;

    const badge = document.createElement('div');
    badge.className = 'muted small';
    badge.textContent = `${safeText(draft.pointsPerCheckpoint)}p`;

    meta.appendChild(idx);
    meta.appendChild(badge);

    const input = document.createElement('input');
    input.className = 'input clueInput';
    input.type = 'text';
    input.autocomplete = 'off';
    input.placeholder = 'Skriv ledtråd…';
    input.value = safeText(draft.clues[i] ?? '');
    input.setAttribute('data-clue-index', String(i)); // HOOK: clue-input-index

    input.addEventListener('input', (e) => {
      const k = clampInt(e.target.getAttribute('data-clue-index'), 0, 99);
      draft.clues[k] = safeText(e.target.value);
      markDirtyAndRender(false);
    });

    row.appendChild(meta);
    row.appendChild(input);
    elCluesWrap.appendChild(row);
  }
}

function renderPreview() {
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

function renderAll() {
  // Render inputs
  if (elName) elName.value = draft.name;
  if (elCount) elCount.value = String(draft.checkpointCount);
  if (elPoints) elPoints.value = String(draft.pointsPerCheckpoint);

  renderClueInputs();
  renderPreview();

  // Validate and show errors
  const errors = validateDraft(draft);
  renderErrors(errors);

  const hasErrors = !!(errors.name || errors.count || errors.points || errors.clues);
  setPill(hasErrors ? 'Utkast (fel)' : dirty ? 'Utkast (osparat)' : 'Utkast', !hasErrors);

  // If storage not writable, warn once
  if (!storageWritable) {
    showStatus('LocalStorage är låst. Utkast kan inte sparas på denna enhet.', 'warn');
  }
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
      // Liten återställning till "Utkast" efter en stund
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
   BLOCK 10 — Events
============================================================ */
function syncCountToClues(nextCount) {
  const n = clampInt(nextCount, 1, 20);
  draft.checkpointCount = n;

  while (draft.clues.length < n) {
    draft.clues.push(`Checkpoint ${draft.clues.length + 1}: Ledtråd...`);
  }
  if (draft.clues.length > n) draft.clues = draft.clues.slice(0, n);
}

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

  // Count
  if (elCount) {
    elCount.addEventListener('input', (e) => {
      syncCountToClues(e.target.value);
      markDirtyAndRender(true);
    });
  }

  // Points
  if (elPoints) {
    elPoints.addEventListener('input', (e) => {
      draft.pointsPerCheckpoint = clampInt(e.target.value, 0, 1000);
      markDirtyAndRender(true);
    });
  }

  // Add/Remove checkpoint buttons
  if (elAddCp) {
    elAddCp.addEventListener('click', () => {
      syncCountToClues(draft.checkpointCount + 1);
      markDirtyAndRender(true);
    });
  }
  if (elRemoveCp) {
    elRemoveCp.addEventListener('click', () => {
      syncCountToClues(draft.checkpointCount - 1);
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
      // Fail-closed: enkel confirm utan modal (ingen extern libs). Modal finns i ui.js, men admin kör standalone.
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
   BLOCK 11 — Boot
============================================================ */
(function bootAdmin() {
  'use strict';

  // INIT-GUARD
  if (window.__FAS12_AO5_ADMIN_INIT__) return; // HOOK: init-guard-admin
  window.__FAS12_AO5_ADMIN_INIT__ = true;

  bindEvents();
  renderAll();

  // Initial save-pill
  setPill('Utkast', true);
})();
