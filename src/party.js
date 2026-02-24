/* ============================================================
   FIL: src/party.js  (HEL FIL)
   AO 10/15 (PATCH) — Party logic (checkpoint progression + poäng)
   AO 6/6 (FAS 1.2) — Starta party via payload (admin-export)
   FIX:
   - Subpath-safe data URLs via import.meta.url (GitHub Pages /uppdrag/)
   - Fail-closed redirect till ../index.html (inte /index.html)
   - Payload-stöd: mode=party&payload=... (id optional)
   - Stepper byggs dynamiskt efter pack-längd (1..20)
   Mål: Party-läge ger poäng per checkpoint, sparar lokalt.
============================================================ */

/* ============================================================
   BLOCK 1 — Imports
============================================================ */
import { qsGet, uid } from './util.js';
import { createStore } from './store.js';
import { awardCheckpointComplete } from './engine.js';
import { toast, renderErrorCard } from './ui.js';

/* ============================================================
   BLOCK 2 — Subpath-safe URLs
============================================================ */
function dataUrl(pathFromSrc) {
  return new URL(pathFromSrc, import.meta.url).toString();
}

const PARTIES_INDEX_URL = dataUrl('../data/parties.index.json'); // HOOK: parties-index-url
const PACKS_BASE_URL = dataUrl('../data/packs/');                // HOOK: packs-base-url

/* ============================================================
   BLOCK 3 — DOM hooks
============================================================ */
const $ = (sel) => document.querySelector(sel);

const elBack = $('#backBtn');         // HOOK: back-button
const elPartyName = $('#partyName');  // HOOK: party-name
const elStepPill = $('#stepPill');    // HOOK: step-pill
const elClueText = $('#clueText');    // HOOK: clue-text
const elNextBtn = $('#nextBtn');      // HOOK: next-button
const elStepper = $('#stepper');      // HOOK: stepper

/* ============================================================
   BLOCK 4 — Store
============================================================ */
const store = createStore(); // HOOK: store

/* ============================================================
   BLOCK 5 — Fail-closed redirect helper (subpath-safe)
============================================================ */
function redirectToIndex(err) {
  const code = (err || 'PARTY_BAD_PARAMS').toString().trim() || 'PARTY_BAD_PARAMS';
  const url = new URL('../index.html', window.location.href); // /uppdrag/index.html
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
    res = await fetch(url, { method: 'GET', credentials: 'include', cache: 'no-store' });
  } catch (_) {
    throw { code: 'P_PARTY_FETCH_NETWORK', message: 'Nätverksfel vid hämtning.', rid, url };
  }

  if (!res || !res.ok) {
    throw { code: 'P_PARTY_FETCH_HTTP', message: 'HTTP-fel vid hämtning.', rid, url, status: res?.status };
  }

  try {
    return await res.json();
  } catch (_) {
    throw { code: 'P_PARTY_FETCH_JSON', message: 'Kunde inte tolka JSON (parse-fel).', rid, url };
  }
}

function validatePartiesIndex(idx) {
  if (!isPlainObject(idx)) throw { code: 'P_PARTY_INDEX_BAD', message: 'parties.index.json har fel format.' };

  const parties = idx.parties;
  if (!Array.isArray(parties) || parties.length < 1) {
    throw { code: 'P_PARTY_INDEX_EMPTY', message: 'parties.index.json saknar parties[] eller är tom.' };
  }

  const map = new Map();
  for (const p of parties) {
    if (!isPlainObject(p)) throw { code: 'P_PARTY_INDEX_ITEM_BAD', message: 'parties[] innehåller fel typ.' };

    const id = asTextSafe(p.id);
    const name = asTextSafe(p.name);
    const file = asTextSafe(p.file);

    if (!id) throw { code: 'P_PARTY_INDEX_ID_MISSING', message: 'Party saknar id.' };
    if (!name) throw { code: 'P_PARTY_INDEX_NAME_MISSING', message: 'Party saknar name.', partyId: id };
    if (!file) throw { code: 'P_PARTY_INDEX_FILE_MISSING', message: 'Party saknar file.', partyId: id };
    if (!/^[a-zA-Z0-9._-]+\.json$/.test(file)) throw { code: 'P_PARTY_INDEX_FILE_INVALID', message: 'Party file har ogiltigt filnamn.', partyId: id, file };

    if (map.has(id)) throw { code: 'P_PARTY_INDEX_DUPLICATE', message: 'Dubbel party id i index.', partyId: id };
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
  if (!isPlainObject(pack)) throw { code: 'P_PARTY_PACK_BAD', message: 'Party pack har fel format.' };

  const id = asTextSafe(pack.id);
  const name = asTextSafe(pack.name);

  const rawList =
    Array.isArray(pack.checkpoints) ? pack.checkpoints :
    Array.isArray(pack.steps) ? pack.steps :
    Array.isArray(pack.missions) ? pack.missions :
    null;

  if (!id) throw { code: 'P_PARTY_PACK_ID_MISSING', message: 'Party pack saknar id.' };
  if (!name) throw { code: 'P_PARTY_PACK_NAME_MISSING', message: 'Party pack saknar name.' };
  if (!Array.isArray(rawList)) throw { code: 'P_PARTY_PACK_CHECKPOINTS_BAD', message: 'Party pack saknar checkpoints[] (eller steps[]).' };

  const checkpoints = rawList.map((cp, i) => normalizeCheckpoint(cp, i));
  if (checkpoints.length < 1) throw { code: 'P_PARTY_PACK_CHECKPOINTS_EMPTY', message: 'Party pack har inga checkpoints.' };

  return { id, name, checkpoints };
}

async function loadPartyPack(partyId) {
  const idx = await fetchJson(PARTIES_INDEX_URL);
  const map = validatePartiesIndex(idx);
  const entry = map.get(partyId);

  if (!entry) throw { code: 'P_PARTY_NOT_FOUND', message: 'Party finns inte i index.', partyId };

  const packUrl = new URL(entry.file, PACKS_BASE_URL).toString();
  const pack = await fetchJson(packUrl);
  const norm = validateAndNormalizePartyPack(pack);

  if (norm.id && norm.id !== partyId) {
    throw { code: 'P_PARTY_PACK_ID_MISMATCH', message: 'Party pack id matchar inte URL id.', partyId, packId: norm.id };
  }

  return { ...norm, displayName: entry.name };
}

/* ============================================================
   BLOCK 6.1 — AO 6/6: payload → pack (fail-closed)
   - Admin-export skickar draft shape:
     { version:1, name, checkpointCount, pointsPerCheckpoint, clues[] }
   - Vi bygger ett "partyPack" i samma shape som loadPartyPack() levererar.
============================================================ */
function safeDecodePayload(raw) {
  const s = (raw ?? '').toString().trim();
  if (!s) return { ok: false, value: '' };

  // decode 1 gång
  try {
    const once = decodeURIComponent(s);
    // prova decode 2 ggr om det ser dubbelkodat ut
    try {
      const twice = decodeURIComponent(once);
      const best = looksLikeJSON(twice) ? twice : once;
      return { ok: true, value: best };
    } catch (_) {
      return { ok: true, value: once };
    }
  } catch (_) {
    // kanske redan plain
    return { ok: true, value: s };
  }
}

function looksLikeJSON(str) {
  const t = (str ?? '').toString().trim();
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
}

function safeJSONParseLocal(str) {
  try {
    return { ok: true, value: JSON.parse(str) };
  } catch (_) {
    return { ok: false, value: null };
  }
}

function clampInt(n, min, max) {
  const x = Math.floor(Number(n));
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function isValidDraftPayload(obj) {
  if (!isPlainObject(obj)) return false;

  const v = Number(obj.version);
  if (!Number.isFinite(v) || v !== 1) return false;

  const name = asTextSafe(obj.name);
  if (name.length < 2 || name.length > 60) return false;

  const cc = Number(obj.checkpointCount);
  if (!Number.isFinite(cc) || cc < 1 || cc > 20) return false;

  const pp = Number(obj.pointsPerCheckpoint);
  if (!Number.isFinite(pp) || pp < 0 || pp > 1000) return false;

  if (!Array.isArray(obj.clues) || obj.clues.length !== cc) return false;

  for (let i = 0; i < obj.clues.length; i++) {
    const t = asTextSafe(obj.clues[i]);
    if (t.length < 3 || t.length > 140) return false;
  }

  return true;
}

// Stabil "id" för payload utan att lagra något: enkel deterministisk hash av payload-JSON.
function hashStringDJB2(input) {
  const s = (input ?? '').toString();
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) + s.charCodeAt(i);
    h = h >>> 0;
  }
  return h.toString(36);
}

function buildPartyPackFromDraftPayload(payloadRaw, payloadObj) {
  const name = asTextSafe(payloadObj.name);
  const cc = clampInt(payloadObj.checkpointCount, 1, 20);
  const pp = clampInt(payloadObj.pointsPerCheckpoint, 0, 1000);

  const clues = payloadObj.clues.map((c) => asTextSafe(c));

  const id = `payload_${hashStringDJB2(payloadRaw)}`; // stabilt mellan reload så länge payload är samma
  const checkpoints = clues.slice(0, cc).map((clue, i) => ({
    index: i,
    clue,
    points: pp,
    xp: pp // enkel baseline: xp = points (kan justeras senare utan att bryta)
  }));

  return {
    id,
    name,
    displayName: name,
    checkpoints
  };
}

/* ============================================================
   BLOCK 7 — Progress model (utan ny store-shape)
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
  return getCompletedSet(state, partyId).has(index);
}

/* ============================================================
   BLOCK 8 — Render
============================================================ */
function setText(node, text) {
  if (!node) return;
  node.textContent = (text ?? '').toString();
}

function ensurePrevButton() {
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

  const next = elNextBtn;
  if (next && next.parentElement === bar) bar.insertBefore(prev, next);
  else bar.appendChild(prev);

  return prev;
}

// AO 6/6: stepper kan vara 1..20, så vi bygger den dynamiskt
function ensureStepperDots(total) {
  if (!elStepper) return;

  const t = clampInt(total, 1, 20);

  // Rebuild alltid när pack laddas (enkel, stabilt)
  elStepper.innerHTML = '';

  for (let i = 1; i <= t; i++) {
    const btn = document.createElement('button');
    btn.className = 'stepDot' + (i === 1 ? ' is-active' : '');
    btn.type = 'button';
    btn.setAttribute('data-step', String(i));
    btn.setAttribute('aria-label', `Steg ${i}`);
    btn.textContent = String(i);
    elStepper.appendChild(btn);
  }
}

function setActiveDot(stepIndex) {
  const dots = Array.from(elStepper?.querySelectorAll?.('.stepDot') || []);
  dots.forEach((d) => {
    const s = Number(d.getAttribute('data-step'));
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
    d.classList.toggle('is-done', completedSet.has(idx)); // HOOK: done-class
  });
}

function renderErrorCardInMain(message, code, rid) {
  const main = document.querySelector('.container');
  if (!main) return;

  const suffix = rid ? ` (rid: ${rid})` : '';
  const msg = code ? `${message} Felkod: ${code}${suffix}` : `${message}${suffix}`;

  const card = renderErrorCard(msg, [
    { label: 'Tillbaka', variant: 'ghost', onClick: () => window.location.assign('../index.html') },
    { label: 'Försök igen', variant: 'primary', onClick: () => window.location.reload() }
  ]);

  main.prepend(card);
}

/* ============================================================
   BLOCK 9 — Controller (next/prev + award)
============================================================ */
let partyId = '';
let partyPack = null;
let stepIndex = 0;
let prevBtn = null;

function renderStep() {
  if (!partyPack) return;

  const total = partyPack.checkpoints.length;
  const s = store.getState();
  const completed = getCompletedSet(s, partyId);

  setText(elPartyName, partyPack.displayName || partyPack.name || 'Skattjakt');
  setText(elStepPill, `Steg ${stepIndex + 1}/${total}`);

  const cp = partyPack.checkpoints[stepIndex];
  setText(elClueText, cp?.clue || '—');

  setActiveDot(stepIndex);
  markCompletedDots(completed);

  if (prevBtn) prevBtn.disabled = stepIndex <= 0;

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

  if (stepIndex < total - 1) {
    stepIndex += 1;
    renderStep();
  } else {
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

  if (window.__AO10_PARTY_INIT__) return; // HOOK: init-guard-party
  window.__AO10_PARTY_INIT__ = true;

  const mode = qsGet('mode');      // HOOK: qs-mode
  const id = qsGet('id');          // HOOK: qs-id (partyId)
  const payload = qsGet('payload'); // HOOK: qs-payload (AO 6/6)

  if (!mode) return redirectToIndex('PARTY_MISSING_PARAMS');
  if (mode !== 'party') return redirectToIndex('PARTY_MODE_REQUIRED');

  store.init();

  if (elBack) {
    elBack.addEventListener('click', () => {
      if (window.history.length > 1) window.history.back();
      else window.location.assign('../index.html');
    });
  }

  prevBtn = ensurePrevButton();
  if (prevBtn) prevBtn.addEventListener('click', (e) => { e.preventDefault(); goPrev(); });

  if (elNextBtn) elNextBtn.addEventListener('click', (e) => { e.preventDefault(); awardIfNeededAndAdvance(); });

  // Klick på dots: (binds efter vi byggt steppern)
  function bindDotClicks() {
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
  }

  (async () => {
    try {
      // =======================================================
      // AO 6/6: payload prioriteras om den finns
      // =======================================================
      if (payload) {
        const dec = safeDecodePayload(payload);
        if (!dec.ok) return redirectToIndex('INVALID_PAYLOAD');

        const parsed = safeJSONParseLocal(dec.value);
        if (!parsed.ok) return redirectToIndex('INVALID_PAYLOAD');

        if (!isValidDraftPayload(parsed.value)) return redirectToIndex('INVALID_PAYLOAD');

        const pack = buildPartyPackFromDraftPayload(dec.value, parsed.value);
        partyId = pack.id;
        partyPack = pack;

        ensureStepperDots(partyPack.checkpoints.length); // dynamiskt 1..20
        bindDotClicks();

        renderStep();
        store.subscribe(() => renderStep());
        return;
      }

      // =======================================================
      // Legacy/demo: id krävs (oförändrat beteende)
      // =======================================================
      if (!id) return redirectToIndex('PARTY_MISSING_PARAMS');

      partyId = id;

      partyPack = await loadPartyPack(partyId);

      ensureStepperDots(partyPack.checkpoints.length); // dynamiskt även för demo
      bindDotClicks();

      renderStep();
      store.subscribe(() => renderStep());
    } catch (e) {
      const msg = (e?.message || 'Kunde inte ladda party-pack.').toString();
      renderErrorCardInMain(msg, e?.code, e?.rid);
      if (elNextBtn) elNextBtn.disabled = true;
      if (prevBtn) prevBtn.disabled = true;
    }
  })();
})();
