/* ============================================================
   FIL: src/play.js  (HEL FIL)
   AO 1/6 (FAS 1.1) — Difficulty på uppdrag + UI-pill + filter (initialt: easy)
   Mål:
   - Missions kan vara easy|normal (default easy)
   - UI visar difficulty pill på missionkort
   - Missions listas filtrerat enligt aktiv difficulty (initialt: easy)
   Fail-closed:
   - okänd difficulty => treat as easy + console.warn
   Policy: UI-only, fail-closed, XSS-safe (DOM API + textContent), inga nya storage keys
============================================================ */

/* ============================================================
   BLOCK 1 — Imports
============================================================ */
import { qsGet } from './util.js';
import { createStore } from './store.js';
import { awardMissionComplete } from './engine.js';
import { loadZonePack } from './packs.js';
import { toast, modal, renderErrorCard } from './ui.js';
import { createCamera } from './camera.js';

/* ============================================================
   BLOCK 2 — DOM hooks (IDs i play.html)
   Inline-kommentarer vid UI hooks (KRAV)
============================================================ */
const $ = (sel) => document.querySelector(sel);

const elBack = $('#backBtn');                 // HOOK: back-button
const elPackName = $('#packName');            // HOOK: pack-name
const elLevelPill = $('#levelPill');          // HOOK: level-pill
const elXp = $('#xpLabel');                   // HOOK: progress-xp
const elPoints = $('#pointsLabel');           // HOOK: progress-points
const elStreak = $('#streakLabel');           // HOOK: progress-streak
const elActiveMissionPill = $('#activeMissionPill'); // HOOK: active-mission-pill

const elStatusSlot = $('#statusSlot');        // HOOK: status-slot
const elMissionCard = $('#missionCard');      // HOOK: mission-card
const elMissionTitle = $('#missionTitle');    // HOOK: mission-title
const elMissionInstruction = $('#missionInstruction'); // HOOK: mission-instruction
const elDifficultyPill = $('#difficultyPill'); // HOOK: difficulty-pill

const elMissionsList = $('#missionsList');    // HOOK: missions-list
const elComplete = $('#completeBtn');         // HOOK: complete-button
const elSwitch = $('#switchBtn');             // HOOK: switch-mission-button

/* ============================================================
   BLOCK 3 — State (controller)
============================================================ */
const store = createStore(); // HOOK: store
let pack = null;

// NOTE: activeIndex pekar alltid på ORIGINAL-index i pack.missions (inte filter-index)
let activeIndex = -1;

// Difficulty filter (KRAV: initialt easy)
let activeDifficulty = 'easy'; // HOOK: difficulty-filter (in-memory)

// Camera state (in-memory only)
let camera = null;           // HOOK: camera-instance
let cameraMountPoint = null; // HOOK: camera-mount-point

// Warn-once för okänd difficulty (fail-closed)
const warnedDifficulty = new Set(); // HOOK: warn-once-set

/* ============================================================
   BLOCK 4 — Fail-closed redirect helper
============================================================ */
function redirectToIndex(err) {
  const code = (err || 'PLAY_BAD_PARAMS').toString().trim() || 'PLAY_BAD_PARAMS';
  const url = new URL('../index.html', window.location.href); // subpath-safe
  url.searchParams.set('err', code);
  window.location.assign(url.toString());
}

/* ============================================================
   BLOCK 5 — Safe helpers
============================================================ */
function safeText(x) { return (x ?? '').toString(); }

function setText(node, text) {
  if (!node) return;
  node.textContent = safeText(text);
}

function clear(node) {
  try { while (node && node.firstChild) node.removeChild(node.firstChild); } catch (_) {}
}

function safeDisable(el, disabled) {
  try { if (el) el.disabled = !!disabled; } catch (_) {}
}

/* ============================================================
   BLOCK 6 — Mission shape + difficulty (KRAV)
   mission-shape (KRAV inline comment):
   mission = { id?, title|name, instruction|text|hint, difficulty?, points?, xp? }
============================================================ */
function missionTitleOf(m, i) {
  const t = safeText(m?.title ?? m?.name).trim();
  return t || `Uppdrag ${i + 1}`;
}

function missionInstructionOf(m) {
  return safeText(m?.instruction ?? m?.text ?? m?.hint).trim()
    || 'Följ instruktionen och ta ett foto. Tryck “Klar” när du är klar.';
}

/* ============================================================
   BLOCK 7 — Difficulty normalize + filter (KRAV)
   - difficulty: "easy"|"normal" (default easy)
   - okänd => treat as easy + console.warn
============================================================ */
function normalizeDifficulty(m) {
  const raw = safeText(m?.difficulty).trim().toLowerCase();

  if (!raw) return 'easy';
  if (raw === 'easy' || raw === 'normal') return raw;

  // Fail-closed: okänd difficulty => easy + warn (en gång per mission)
  const key = safeText(m?.id || missionTitleOf(m, 0) || 'unknown');
  if (!warnedDifficulty.has(key)) {
    warnedDifficulty.add(key);
    console.warn('[PLAY] Unknown difficulty -> treat as easy', { mission: key, difficulty: raw });
  }
  return 'easy';
}

function filteredMissionIndexes() {
  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  const idxs = [];

  for (let i = 0; i < missions.length; i++) {
    const d = normalizeDifficulty(missions[i]);
    if (d === activeDifficulty) idxs.push(i);
  }

  return idxs; // ORIGINAL-indexar
}

/* ============================================================
   BLOCK 8 — Render: progress
============================================================ */
function renderProgress() {
  try {
    const s = store.getState();
    setText(elLevelPill, `Lvl ${s.level}`);
    setText(elXp, `XP: ${s.xp}`);
    setText(elPoints, `Poäng: ${s.points}`);
    setText(elStreak, `Streak: ${s.streak?.count ?? 0}`);
  } catch (_) {}
}

function renderPackHeader() {
  setText(elPackName, pack?.name || '—');
}

/* ============================================================
   BLOCK 9 — Camera UI
============================================================ */
function ensureCameraUI() {
  if (!elMissionCard) return;

  if (!cameraMountPoint) {
    cameraMountPoint = document.createElement('div');
    cameraMountPoint.setAttribute('data-hook', 'camera-slot'); // HOOK: camera-slot
    elMissionCard.appendChild(cameraMountPoint);
  }

  if (!camera) {
    camera = createCamera({
      maxBytes: 6_000_000,
      onChange: ({ hasPhoto }) => updateCTAState({ hasPhoto })
    });
  }

  camera.mount(cameraMountPoint);
}

/* ============================================================
   BLOCK 10 — CTA state (mission + foto)
============================================================ */
function updateCTAState({ hasPhoto } = {}) {
  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  const m = missions[activeIndex];

  const missionActive = activeIndex >= 0 && !!m;
  const photoOk = typeof hasPhoto === 'boolean'
    ? hasPhoto
    : (camera?.hasPhoto?.() || false);

  // Fail-closed: måste ha mission + foto
  safeDisable(elComplete, !(missionActive && photoOk));
}

/* ============================================================
   BLOCK 11 — Render: missions list (filtrerad)
============================================================ */
function renderMissionList() {
  clear(elMissionsList);

  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  if (!missions.length) {
    elMissionsList.appendChild(renderErrorCard('Paketet saknar uppdrag.', [
      { label: 'Tillbaka', variant: 'ghost', onClick: () => window.location.assign('../index.html') },
      { label: 'Försök igen', variant: 'primary', onClick: () => window.location.reload() }
    ]));
    return;
  }

  const idxs = filteredMissionIndexes(); // ORIGINAL-index list

  if (!idxs.length) {
    // Filter kan göra att listan blir tom (t.ex. normal saknas)
    elMissionsList.appendChild(renderErrorCard(
      `Inga uppdrag med difficulty "${activeDifficulty}" i detta paket.`,
      [{ label: 'Tillbaka', variant: 'ghost', onClick: () => window.location.assign('../index.html') }]
    ));
    return;
  }

  idxs.forEach((origIndex, visiblePos) => {
    const m = missions[origIndex];
    const d = normalizeDifficulty(m);

    const item = document.createElement('div');
    item.className = 'missionItem' + (origIndex === activeIndex ? ' is-active' : '');
    item.setAttribute('role', 'listitem');
    item.setAttribute('tabindex', '0');
    item.setAttribute('data-mission-index', String(origIndex)); // HOOK: mission-item-index (ORIGINAL)

    const meta = document.createElement('div');
    meta.className = 'missionItem__meta';

    const title = document.createElement('div');
    title.className = 'missionItem__title';
    title.textContent = missionTitleOf(m, visiblePos);

    const sub = document.createElement('div');
    sub.className = 'missionItem__sub muted';
    sub.textContent = `Svårighet: ${d}`;

    meta.appendChild(title);
    meta.appendChild(sub);

    const pill = document.createElement('span');
    pill.className = 'pill pill--difficulty';
    pill.textContent = d;

    item.appendChild(meta);
    item.appendChild(pill);

    item.addEventListener('click', () => setActiveMission(origIndex));
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setActiveMission(origIndex);
      }
    });

    elMissionsList.appendChild(item);
  });
}

/* ============================================================
   BLOCK 12 — Render: active mission card + difficulty pill (KRAV)
============================================================ */
function renderActiveMission() {
  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  const m = missions[activeIndex];

  if (!m) {
    if (elMissionCard) elMissionCard.hidden = true;
    setText(elActiveMissionPill, 'Inget uppdrag valt');
    if (camera) camera.clear();
    updateCTAState({ hasPhoto: false });
    return;
  }

  if (elMissionCard) elMissionCard.hidden = false;

  setText(elMissionTitle, missionTitleOf(m, activeIndex));
  setText(elMissionInstruction, missionInstructionOf(m));

  // KRAV: difficulty pill på missionkort
  const d = normalizeDifficulty(m);
  setText(elDifficultyPill, d);

  setText(elActiveMissionPill, `Aktivt: ${activeIndex + 1}/${missions.length}`);

  ensureCameraUI();

  // Nytt uppdrag => nytt foto krävs (fail-closed)
  if (camera) camera.clear();
  updateCTAState({ hasPhoto: false });

  // Markera list items
  document.querySelectorAll('.missionItem').forEach((n) => {
    const idx = Number(n.getAttribute('data-mission-index'));
    n.classList.toggle('is-active', idx === activeIndex);
  });
}

/* ============================================================
   BLOCK 13 — Controller actions
============================================================ */
function setActiveMission(origIndex) {
  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  if (!missions.length) return;

  const idx = Number(origIndex);
  if (!Number.isFinite(idx) || idx < 0 || idx >= missions.length) return;

  // Guard: mission måste matcha aktiv difficulty (filtrerat läge)
  const d = normalizeDifficulty(missions[idx]);
  if (d !== activeDifficulty) {
    toast(`Det uppdraget är "${d}". Du är i läge "${activeDifficulty}".`, 'warn', { ttlMs: 2200 });
    return;
  }

  activeIndex = idx;
  renderMissionList();
  renderActiveMission();
}

function getAwardForMission(m) {
  const points = Number.isFinite(Number(m?.points)) ? Number(m.points) : 10;
  const xp = Number.isFinite(Number(m?.xp)) ? Number(m.xp) : 25;
  return { points, xp };
}

function completeActiveMission() {
  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  const m = missions[activeIndex];
  if (!m) return;

  // Fail-closed: foto krävs
  const file = camera?.getFile?.() || null; // HOOK: photo-file
  if (!file) {
    toast('Du måste ta/välja en bild innan du kan markera “Klar”.', 'warn', { ttlMs: 2600 });
    updateCTAState({ hasPhoto: false });
    return;
  }

  const award = getAwardForMission(m);

  const res = store.update((s) => {
    const next = awardMissionComplete(s, award);
    return next || s;
  });

  if (!res.ok) {
    toast('Kunde inte spara progression.', 'danger');
    return;
  }

  renderProgress();

  toast(`Klar! +${award.points} poäng • +${award.xp} XP`, 'success');

  // Rensa foto efter completion
  if (camera) camera.clear();
  updateCTAState({ hasPhoto: false });

  // Auto-advance inom samma difficulty-filter
  const idxs = filteredMissionIndexes();
  const pos = idxs.indexOf(activeIndex);
  const nextOrig = pos >= 0 && pos + 1 < idxs.length ? idxs[pos + 1] : null;

  if (nextOrig !== null && nextOrig !== undefined) {
    setActiveMission(nextOrig);
  } else {
    // Stanna kvar (eller visa info)
    renderMissionList();
    renderActiveMission();
    toast(`Alla "${activeDifficulty}"-uppdrag klara (för nu).`, 'info', { ttlMs: 2200 });
  }
}

function openSwitchMissionDialog() {
  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  if (!missions.length) return;

  const idxs = filteredMissionIndexes();

  const body = document.createElement('div');
  body.style.display = 'grid';
  body.style.gap = '8px';

  idxs.forEach((origIndex, i) => {
    const m = missions[origIndex];
    const b = document.createElement('button');
    b.className = 'btn btn-ghost';
    b.type = 'button';
    b.textContent = `${i + 1}. ${missionTitleOf(m, origIndex)}`;

    b.addEventListener('click', () => {
      setActiveMission(origIndex);
      toast('Uppdrag bytt.', 'info', { ttlMs: 1200 });
    });

    body.appendChild(b);
  });

  modal({
    title: `Byt uppdrag (${activeDifficulty})`,
    body,
    secondary: { label: 'Stäng', variant: 'ghost' }
  });
}

/* ============================================================
   BLOCK 14 — Boot
============================================================ */
(function bootPlay() {
  'use strict';

  // INIT-GUARD
  if (window.__FAS11_AO1_PLAY_INIT__) return; // HOOK: init-guard-play
  window.__FAS11_AO1_PLAY_INIT__ = true;

  const mode = qsGet('mode'); // HOOK: qs-mode
  const id = qsGet('id');     // HOOK: qs-id

  if (!mode || !id) return redirectToIndex('PLAY_MISSING_PARAMS');
  if (mode !== 'zone') return redirectToIndex('PLAY_MODE_REQUIRED');

  // Start store
  store.init();
  renderProgress();

  // Back
  if (elBack) {
    elBack.addEventListener('click', () => {
      if (window.history.length > 1) window.history.back();
      else window.location.assign('../index.html');
    });
  }

  // Bind CTA
  if (elComplete) elComplete.addEventListener('click', completeActiveMission);
  if (elSwitch) elSwitch.addEventListener('click', openSwitchMissionDialog);
  safeDisable(elComplete, true);

  // Loading state
  clear(elStatusSlot);
  const loading = document.createElement('div');
  loading.className = 'toast toast--info';
  loading.setAttribute('role', 'status');
  loading.textContent = 'Laddar paket…';
  elStatusSlot.appendChild(loading);

  (async () => {
    try {
      pack = await loadZonePack(id);

      // Fail-closed: tom missions
      if (!pack || typeof pack !== 'object' || !Array.isArray(pack.missions) || pack.missions.length < 1) {
        clear(elStatusSlot);
        elStatusSlot.appendChild(renderErrorCard('Paketet saknar uppdrag (missions är tom).', [
          { label: 'Tillbaka', variant: 'ghost', onClick: () => window.location.assign('../index.html') },
          { label: 'Försök igen', variant: 'primary', onClick: () => window.location.reload() }
        ]));
        safeDisable(elComplete, true);
        safeDisable(elSwitch, true);
        return;
      }

      clear(elStatusSlot);
      renderPackHeader();

      // KRAV: initialt easy filter
      activeDifficulty = 'easy';

      renderMissionList();

      // Auto-select första mission i filtret
      const idxs = filteredMissionIndexes();
      if (idxs.length) setActiveMission(idxs[0]);
      else renderActiveMission();

      // Live updates
      store.subscribe(() => {
        renderProgress();
        // missions påverkas inte av store, men UI håller sig fräscht
      });
    } catch (e) {
      const code = safeText(e?.code || 'UNKNOWN');
      const rid = safeText(e?.requestId || '');
      const msg = safeText(e?.message || 'Kunde inte ladda paket.');

      clear(elStatusSlot);
      elStatusSlot.appendChild(renderErrorCard(`${msg} Felkod: ${code}${rid ? ` (rid: ${rid})` : ''}`, [
        { label: 'Tillbaka', variant: 'ghost', onClick: () => window.location.assign('../index.html') },
        { label: 'Försök igen', variant: 'primary', onClick: () => window.location.reload() }
      ]));

      safeDisable(elComplete, true);
      safeDisable(elSwitch, true);
    }
  })();
})();
