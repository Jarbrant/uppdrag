/* ============================================================
   FIL: src/admin.js  (HEL FIL)
   AO 5/6 (FAS 1.2) — Admin UI: skapa skattjakt (lokalt, utan konto)
   AO 6/6 (FAS 1.2) — Export: QR-länk + “kopiera JSON”
   KRAV:
   - Formfält: namn, antal (1–20), poäng/checkpoint (default), ledtrådar (lista växer/krymper)
   - Live preview cp-lista
   - Local draft: localStorage med EN stabil key
   - Fail-closed: ogiltig input -> error text under fält (inte alert)
   - Export 1: Kopiera JSON (clipboard) med fallback (markera text)
   - Export 2: Skapa QR-länk (delbar länk) med copy-knapp
       - inline payload i querystring endast om liten nog, annars fel “för stor att dela som länk”
   Kodkrav: BLOCK för state/draft, render loop, events, validate (+ export/util)
   Policy: UI-only, inga externa libs, XSS-safe rendering
============================================================ */

import { copyToClipboard } from './util.js'; // AO 6/6

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

const elPreviewName = $('#previewName');     // HOOK: preview-name
const elPreviewPoints = $('#previewPoints'); // HOOK: preview-points
const elPreviewCount = $('#previewCount');   // HOOK: preview-count
const elPreviewList = $('#previewList');     // HOOK: preview-list

// AO 6/6 — Export UI mount (skapas via JS för att hålla 2-filsgränsen)
let elExportRoot = null;   // HOOK: export-root
let elExportMsg = null;    // HOOK: export-msg
let elExportLink = null;   // HOOK: export-link
let elExportJSON = null;   // HOOK: export-json
let elBtnCopyJSON = null;  // HOOK: btn-copy-json
let elBtnMakeLink = null;  // HOOK: btn-make-link
let elBtnCopyLink = null;  // HOOK: btn-copy-link

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

function renderExportUI() {
  // Export UI är injected (ingen admin.html-ändring i AO 6/6)
  if (!elExportRoot) return;

  // JSON textarea alltid uppdaterad (för fallback-markering)
  const json = getDraftJSON({ pretty: true });
  if (elExportJSON) elExportJSON.value = json;

  // Link box uppdateras bara när vi skapar ny länk (ej varje render)
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

  // Export panel (AO 6/6)
  renderExportUI();
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
      const ok = window.confirm('Rensa lokalt utkast?');
      if (!ok) return;

      draft = defaultDraft();
      dirty = true;

      try { localStorage.removeItem(DRAFT_KEY); } catch (_) {}
      renderAll();
      showStatus('Utkast rensat.', 'info');
    });
  }

  // AO 6/6 — Export events
  if (elBtnCopyJSON) {
    elBtnCopyJSON.addEventListener('click', async () => {
      await onCopyJSON();
    });
  }
  if (elBtnMakeLink) {
    elBtnMakeLink.addEventListener('click', async () => {
      await onMakeShareLink();
    });
  }
  if (elBtnCopyLink) {
    elBtnCopyLink.addEventListener('click', async () => {
      await onCopyLink();
    });
  }
}

/* ============================================================
   BLOCK 11 — AO 6/6 Export: JSON + QR-länk (inline payload)
   - Ingen admin.html-ändring: vi injicerar en export-panel i DOM
   - Fail-closed: för stor payload => felmeddelande
   - Clipboard nekas => fallback: textarea markeras
============================================================ */

// Rimlig maxlängd för querystring payload.
// (Browser/servers varierar, men vi failar tidigt för stabilitet.)
const MAX_INLINE_QS_CHARS = 1400; // HOOK: max-inline-payload

function hasBlockingErrors() {
  const errors = validateDraft(draft);
  return !!(errors.name || errors.count || errors.points || errors.clues);
}

function getDraftJSON({ pretty = false } = {}) {
  // Minifierad men läsbar: vi väljer 2 spaces för att vara mänskligt läsbar.
  // (Vill du mer “minify” senare kan vi byta till JSON.stringify(obj) utan spaces.)
  const payload = {
    version: 1,
    name: safeText(draft.name).trim(),
    checkpointCount: clampInt(draft.checkpointCount, 1, 20),
    pointsPerCheckpoint: clampInt(draft.pointsPerCheckpoint, 0, 1000),
    clues: Array.isArray(draft.clues) ? draft.clues.map((c) => safeText(c).trim()) : []
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

function ensureExportPanel() {
  if (elExportRoot) return;

  // Mount: lägg export-panel under preview-kortet om möjligt, annars under main container
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

  // Insert: om previewCard finns, lägg efter den. Annars längst ned i mount.
  if (previewCard && previewCard.parentNode) {
    previewCard.parentNode.insertBefore(card, previewCard.nextSibling);
  } else {
    mount.appendChild(card);
  }

  elExportRoot = card;

  // Bind export events (nu när knapparna finns)
  bindEventsExportOnly();
}

function bindEventsExportOnly() {
  if (elBtnCopyJSON) elBtnCopyJSON.addEventListener('click', async () => { await onCopyJSON(); });
  if (elBtnMakeLink) elBtnMakeLink.addEventListener('click', async () => { await onMakeShareLink(); });
  if (elBtnCopyLink) elBtnCopyLink.addEventListener('click', async () => { await onCopyLink(); });
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

  // Fail-closed fallback: visa instruktion + markera text
  setExportMessage('Kopiering nekades. Markera JSON-rutan och kopiera manuellt (Ctrl/Cmd+C).', 'warn');
  selectAll(elExportJSON);
}

function makeInlineShareURL(payloadJSON) {
  // Bygg en länk mot spelstart (antag ../index.html från pages/admin.html)
  // Parametrar:
  // - mode=party (framtida koppling)
  // - payload=<urlencoded json>
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

  setExportMessage('Länk skapad. Du kan nu kopiera den eller göra QR i nästa steg i appen.', 'info');
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
   BLOCK 12 — Boot
============================================================ */
(function bootAdmin() {
  'use strict';

  // INIT-GUARD
  if (window.__FAS12_AO5_ADMIN_INIT__) return; // HOOK: init-guard-admin
  window.__FAS12_AO5_ADMIN_INIT__ = true;

  // Skapa export-panel direkt (AO 6/6) — men utan att kräva admin.html-ändring
  ensureExportPanel();

  bindEvents();
  renderAll();

  // Initial save-pill
  setPill('Utkast', true);
})();
