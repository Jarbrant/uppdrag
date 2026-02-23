/* ============================================================
   FIL: src/party.js  (HEL FIL)
   AO 10/15 — Party logic (checkpoint progression + poäng)
   Mål: Party-läge ger poäng per checkpoint, sparar lokalt.
   Policy: UI-only, fail-closed, XSS-safe (DOM API + textContent),
           inga nya storage keys/datamodell.
============================================================ */

/* ============================================================
   BLOCK 1 — Imports
============================================================ */
import { qsGet, uid } from './util.js';
import { createStore } from './store.js';
import { awardCheckpointComplete } from './engine.js';
import { toast, renderErrorCard } from './ui.js';

/* ============================================================
   BLOCK 2 — Constants (paths)
============================================================ */
const PARTIES_INDEX_PATH = '/data/parties.index.json'; // HOOK: parties-index-path
const PACKS_BASE_PATH = '/data/packs/';                // HOOK: packs-base-path

/* ============================================================
   BLOCK 3 — DOM hooks (party.html)
============================================================ */
const $ = (sel) => document.querySelector(sel);

const elBack = $('#backBtn');      // HOOK: back-button
const elPartyName = $('#partyName'); // HOOK: party-name
const elStepPill = $('#stepPill'); // HOOK: step-pill
const elClueText = $('#clueText'); // HOOK: clue-text
const elNextBtn = $('#nextBtn');   // HOOK: next-button
const elStepper = $('#stepper');   // HOOK: stepper

/* ============================================================
   BLOCK 4 — Store
============================================================ */
const store = createStore(); // HOOK: store

/* ============================================================
   BLOCK 5 — Fail-closed redirect helper
============================================================ */
function redirectToIndex(err) {
  const code = (err || 'PARTY_BAD_PARAMS').toString().trim() || 'PARTY_BAD_PARAMS';
  const url = new URL('/index.html', window.location.origin);
  url.searchParams.set('err', code);
  window.location.assign(url.toString());
}

/* ============================================================
   BLOCK 6 — Controlled fetch + validation (fail-closed)
============================================================ */
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function asTextSafe(x) {
  return (x ?? '').toString().trim();
}

async function fetchJson(url) {
  const rid = uid('party_fetch');
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store'
    });
  } catch (_) {
    throw { code: 'FETCH_NETWORK', message: 'Nätverksfel vid hämtning.', rid, url };
  }

  if (!res || !res.ok) {
    throw { code: 'FETCH_HTTP', message: 'HTTP-fel vid hämtning.', rid, url, status: res?.status };
  }

  try {
    return await res.json();
  } catch (_) {
    throw { code: 'FETCH_JSON', message: 'JSON-parsefel.', rid, url };
  }
}

function validatePartiesIndex(idx) {
  if (!isPlainObject(idx)) throw { code: 'INDEX_BAD', message: 'parties.index.json har fel format.' };
  const parties = idx.parties;
  if (!Array.isArray(parties) || parties.length < 1) throw { code: 'INDEX_EMPTY', message: 'parties.index.json saknar parties[] eller är tom.' };

  const map = new Map();
  for (const p of parties) {
    if (!isPlainObject(p)) throw { code: 'INDEX_ITEM_BAD', message: 'parties[] innehåller fel typ.' };
    const id = asTextSafe(p.id);
    const name = asTextSafe(p.name);
    const file = asTextSafe(p.file);

    if (!id) throw { code: 'INDEX_ID_MISSING', message: 'Party saknar id.' };
    if (!name) throw { code: 'INDEX_NAME_MISSING', message: 'Party saknar name.', partyId: id };
    if (!file) throw { code: 'INDEX_FILE_MISSING', message: 'Party saknar file.', partyId: id };
    if (!/^[a-zA-Z0-9._-]+\.json$/.test(file)) throw { code: 'INDEX_FILE_INVALID', message: 'Party file har ogiltigt filnamn.', partyId: id, file };

    if (map.has(id)) throw { code: 'INDEX_DUPLICATE', message: 'Dubbel party id i index.', partyId: id };
    map.set(id, { id, name, file });
  }

  return map;
}

function normalizeCheckpoint(cp, index) {
  const obj = isPlainObject(cp) ? cp : {};
  const clue = asTextSafe(obj.clue ?? obj.hint ?? obj.text ?? obj.instruction ?? obj.title);
  const points = Number.isFinite(Number(obj.points)) ? Math.floor(Number(obj.points)) : 10;
  const xp = Number.isFinite(Number(obj.xp)) ? Math.floor(Number(obj.xp)) : 10;

  return {
    index,
    clue: clue || `Checkpoint ${index + 1}`,
    points: Math.max(0, Math.min(1_000_000, points)),
    xp: Math.max(0, Math.min(1_000_000, xp))
  };
}

function validateAndNormalizePartyPack(pack) {
  if (!isPlainObject(pack)) throw { code: 'PACK_BAD', message: 'Party pack har fel format.' };

  const id = asTextSafe(pack.id);
  const name = asTextSafe(pack.name);

  // Tillåt flera namn för arrayen för robusthet
  const rawList =
    Array.isArray(pack.checkpoints) ? pack.checkpoints :
    Array.isArray(pack.steps) ? pack.steps :
    Array.isArray(pack.missions) ? pack.missions :
    null;

  if (!id) throw { code: 'PACK_ID_MISSING', message: 'Party pack saknar id.' };
  if (!name) throw { code: 'PACK_NAME_MISSING', message: 'Party pack saknar name.' };
  if (!Array.isArray(rawList)) throw { code: 'PACK_CHECKPOINTS_BAD', message: 'Party pack saknar checkpoints[] (eller steps[]).' };

  const checkpoints = rawList.map((cp, i) => normalizeCheckpoint(cp, i));
  if (checkpoints.length < 1) throw { code: 'PACK_CHECKPOINTS_EMPTY', message: 'Party pack har inga checkpoints.' };

  return { id, name, checkpoints };
}

async function loadPartyPack(partyId) {
  const idx = await fetchJson(PARTIES_INDEX_PATH);
  const map = validatePartiesIndex(idx);
  const entry = map.get(partyId);

  if (!entry) throw { code: 'PARTY_NOT_FOUND', message: 'Party finns inte i index.', partyId };

  const url = `${PACKS_BASE_PATH}${entry.file}`;
  const pack = await fetchJson(url);
  const norm = validateAndNormalizePartyPack(pack);

  // Fail-closed: partyId i URL måste matcha pack.id om pack.id finns
  if (norm.id && norm.id !== partyId) {
    // tillåt om pack.id är annan men logiskt? här fail-closed
    throw { code: 'PACK_ID_MISMATCH', message: 'Party pack id matchar inte URL id.', partyId, packId: norm.id };
  }

  return { ...norm, displayName: entry.name };
}

/* ============================================================
   BLOCK 7 — Progress model (utan ny store-shape)
   - Vi härleder "completed checkpoints" från history entries:
     type=checkpoint_complete, partyId, checkpointIndex
============================================================ */
function getCompletedSet(state, partyId) {
  const set = new Set();
  const hist = Array.isArray(state?.history) ? state.history : [];
  for (const h of hist) {
    if (!h || typeof h !== 'object') continue;
    if (h.type !== 'checkpoint_complete') continue;
    if ((h.partyId ?? '') !== partyId) continue;
    const idx = Number(h.checkpointIndex);
    if (Number.isFinite(idx) && idx >= 0 && idx <= 9999) set.add(idx);
  }
  return set;
}

function isCheckpointCompleted(state, partyId, index) {
  const set = getCompletedSet(state, partyId);
  return set.has(index);
}

/* ============================================================
   BLOCK 8 — Render
============================================================ */
function setText(node, text) {
  if (!node) return;
  node.textContent = (text ?? '').toString();
}

function ensurePrevButton() {
  // KRAV: next/prev — om page saknar prev skapar vi en minimal (utan att ändra layout mycket)
  const bar = document.querySelector('.ctaBar__inner');
  if (!bar) return null;

  let prev = document.getElementById('prevBtn'); // HOOK: prev-button
  if (prev) return prev;

  prev = document.createElement('button');
  prev.id = 'prevBtn';
  prev.className = 'btn btn-ghost';
  prev.type = 'button';
  prev.textContent = 'Föregående';
  // HOOK: prev-button (created)

  // Lägg före nästa-knappen
  const next = elNextBtn;
  if (next && next.parentElement === bar) {
    bar.insertBefore(prev, next);
  } else {
    bar.appendChild(prev);
  }

  return prev;
}

function setActiveDot(stepIndex) {
  // stepIndex: 0-based
  const dots = Array.from(elStepper?.querySelectorAll?.('.stepDot') || []);
  dots.forEach((d) => {
    const s = Number(d.getAttribute('data-step')); // 1..N
    const isActive = (s - 1) === stepIndex;
    d.classList.toggle('is-active', isActive);
    d.setAttribute('aria-current', isActive ? 'step' : 'false');
  });
}

function markCompletedDots(completedSet) {
  const dots = Array.from(elStepper?.querySelectorAll?.('.stepDot') || []);
  dots.forEach((d) => {
    const s = Number(d.getAttribute('data-step'));
    const idx = s - 1;
    const done = completedSet.has(idx);
    d.classList.toggle('is-done', done); // HOOK: done-class (CSS kan läggas senare)
  });
}

function renderError(message) {
  // Sätt clueText om finns, annars injicera error card i main
  if (elClueText) {
    setText(elClueText, message);
    return;
  }
  const main = document.querySelector('.container');
  if (!main) return;
  const card = renderErrorCard(message, [
    { label: 'Tillbaka', variant: 'ghost', onClick: () => window.location.assign('/index.html') },
    { label: 'Försök igen', variant: 'primary', onClick: () => window.location.reload() }
  ]);
  main.prepend(card);
}

/* ============================================================
   BLOCK 9 — Controller (next/prev + award)
============================================================ */
let partyId = '';
let partyPack = null;
let stepIndex = 0; // 0-based
let prevBtn = null;

function renderStep() {
  if (!partyPack) return;

  const total = partyPack.checkpoints.length;
  const s = store.getState();
  const completed = getCompletedSet(s, partyId);

  // Header
  setText(elPartyName, partyPack.displayName || partyPack.name || 'Skattjakt');
  setText(elStepPill, `Steg ${stepIndex + 1}/${total}`);

  // Clue
  const cp = partyPack.checkpoints[stepIndex];
  setText(elClueText, cp?.clue || '—');

  // Stepper active + completed
  setActiveDot(stepIndex);
  markCompletedDots(completed);

  // Buttons
  if (prevBtn) prevBtn.disabled = stepIndex <= 0;

  // Nästa: om sista steg och redan klar => lås knapp
  const isLast = stepIndex >= total - 1;
  const done = completed.has(stepIndex);
  if (elNextBtn) {
    if (isLast && done) {
      elNextBtn.textContent = 'Klar!';
      elNextBtn.disabled = true;
    } else {
      elNextBtn.textContent = 'Nästa';
      elNextBtn.disabled = false;
    }
  }
}

function awardIfNeededAndAdvance() {
  if (!partyPack) return;

  const total = partyPack.checkpoints.length;
  const cp = partyPack.checkpoints[stepIndex];
  const s = store.getState();

  const alreadyDone = isCheckpointCompleted(s, partyId, stepIndex);

  // Award endast första gången per checkpoint
  if (!alreadyDone) {
    const res = store.update((draft) => {
      const next = awardCheckpointComplete(draft, {
        partyId,
        checkpointIndex: stepIndex,
        points: cp?.points ?? 10,
        xp: cp?.xp ?? 10
      });
      return next || draft;
    });

    if (!res.ok) {
      toast('Kunde inte spara checkpoint.', 'danger');
      return;
    }

    toast(`Checkpoint klar! +${cp?.points ?? 10}p • +${cp?.xp ?? 10}xp`, 'success', { ttlMs: 1800 });
  }

  // Advance
  if (stepIndex < total - 1) {
    stepIndex += 1;
    renderStep();
  } else {
    // Sista steget: render visar "Klar!" om done
    renderStep();
    toast('Skattjakten är klar (demo).', 'info', { ttlMs: 2200 });
  }
}

function goPrev() {
  if (!partyPack) return;
  if (stepIndex <= 0) return;
  stepIndex -= 1;
  renderStep();
}

/* ============================================================
   BLOCK 10 — Boot
============================================================ */
(function bootParty() {
  'use strict';

  // INIT-GUARD
  if (window.__AO10_PARTY_INIT__) return; // HOOK: init-guard-party
  window.__AO10_PARTY_INIT__ = true;

  // Params
  const mode = qsGet('mode'); // HOOK: qs-mode
  const id = qsGet('id');     // HOOK: qs-id (partyId)

  if (!mode || !id) return redirectToIndex('PARTY_MISSING_PARAMS');
  if (mode !== 'party') return redirectToIndex('PARTY_MODE_REQUIRED');

  partyId = id;

  // Store init
  store.init();

  // Back
  if (elBack) {
    elBack.addEventListener('click', () => {
      if (window.history.length > 1) window.history.back();
      else window.location.assign('/index.html');
    });
  }

  // Prev button (created if missing)
  prevBtn = ensurePrevButton();
  if (prevBtn) prevBtn.addEventListener('click', (e) => { e.preventDefault(); goPrev(); });

  // Next
  if (elNextBtn) elNextBtn.addEventListener('click', (e) => { e.preventDefault(); awardIfNeededAndAdvance(); });

  // Stepper click to navigate (prev/next support via direct)
  const dots = Array.from(elStepper?.querySelectorAll?.('.stepDot') || []);
  dots.forEach((d) => {
    d.addEventListener('click', () => {
      const s = Number(d.getAttribute('data-step'));
      const idx = s - 1;
      if (!Number.isFinite(idx) || idx < 0) return;
      stepIndex = idx;
      renderStep();
    });
  });

  // Load pack
  (async () => {
    try {
      partyPack = await loadPartyPack(partyId);

      // Fail-closed: stepper måste matcha antal checkpoints (demo page har 1..5)
      // Om pack inte har 5 checkpoints, kör ändå men låt pill visa total.
      renderStep();

      // Live updates if another tab/page changes state
      store.subscribe(() => renderStep());
    } catch (e) {
      const msg = (e?.message || 'Kunde inte ladda party-pack.').toString();
      renderError(msg);
      if (elNextBtn) elNextBtn.disabled = true;
      if (prevBtn) prevBtn.disabled = true;
    }
  })();
})();
