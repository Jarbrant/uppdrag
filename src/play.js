/* ============================================================
   FIL: src/play.js  (HEL FIL)
   AO 1/6 + AO 2/6 + AO 3/6 (FAS 1.1) — Difficulty toggle + unlock overlay
   Mål:
   - Spelaren kan välja Easy/Normal
   - Normal är låst tills engine.isNormalUnlocked(state) == true
   KRAV:
   - Normal-knapp disabled + "Lås upp efter 15 klarade" info när låst
   - När Normal låses upp: UI uppdateras utan reload
   - Fail-closed: om store saknas -> felruta + tillbaka
============================================================ */

/* ============================================================
   BLOCK 1 — Imports
============================================================ */
import { qsGet } from './util.js';
import { createStore } from './store.js';
import { awardMissionComplete, isNormalUnlocked, getCompletedCount, NORMAL_UNLOCK_AFTER } from './engine.js';
import { loadZonePack } from './packs.js';
import { toast, modal, renderErrorCard } from './ui.js';
import { createCamera } from './camera.js';

/* ============================================================
   BLOCK 2 — Fail-closed: store must exist
============================================================ */
let store;
try {
  store = createStore(); // HOOK: store
} catch (_) {
  store = null;
}

/* ============================================================
   BLOCK 3 — DOM hooks (KRAV)
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

// Difficulty toggle hooks
const elDiffEasy = $('#diffEasyBtn');         // HOOK: diff-easy
const elDiffNormal = $('#diffNormalBtn');     // HOOK: diff-normal
const elDifficultyInfo = $('#difficultyInfo'); // HOOK: difficulty-info
const elUnlockHintRow = $('#unlockHintRow');  // HOOK: unlock-hint-row
const elUnlockHintText = $('#unlockHintText'); // HOOK: unlock-hint

/* ============================================================
   BLOCK 4 — State
============================================================ */
let pack = null;

// activeIndex = ORIGINAL index in pack.missions
let activeIndex = -1;

// difficulty filter (initial easy)
let activeDifficulty = 'easy'; // HOOK: difficulty-filter

// camera
let camera = null;           // HOOK: camera-instance
let cameraMountPoint = null; // HOOK: camera-mount-point

// warn-once unknown difficulty
const warnedDifficulty = new Set();

/* ============================================================
   BLOCK 5 — Helpers
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

function showFatal(message) {
  clear(elStatusSlot);
  elStatusSlot.appendChild(renderErrorCard(message, [
    { label: 'Tillbaka', variant: 'ghost', onClick: () => window.location.assign('../index.html') },
    { label: 'Försök igen', variant: 'primary', onClick: () => window.location.reload() }
  ]));
  safeDisable(elComplete, true);
  safeDisable(elSwitch, true);
  if (elMissionCard) elMissionCard.hidden = true;
}

/* ============================================================
   BLOCK 6 — Mission shape + difficulty normalize (KRAV)
============================================================ */
function missionTitleOf(m, i) {
  const t = safeText(m?.title ?? m?.name).trim();
  return t || `Uppdrag ${i + 1}`;
}

function missionInstructionOf(m) {
  return safeText(m?.instruction ?? m?.text ?? m?.hint).trim()
    || 'Följ instruktionen och ta ett foto. Tryck “Klar” när du är klar.';
}

function normalizeDifficulty(m) {
  const raw = safeText(m?.difficulty).trim().toLowerCase();

  if (!raw) return 'easy';
  if (raw === 'easy' || raw === 'normal') return raw;

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
    if (normalizeDifficulty(missions[i]) === activeDifficulty) idxs.push(i);
  }
  return idxs;
}

/* ============================================================
   BLOCK 7 — Unlock UI state (KRAV)
============================================================ */
function updateUnlockUI() {
  if (!store) return;

  const s = store.getState();
  const unlocked = isNormalUnlocked(s);
  const done = getCompletedCount(s);
  const left = Math.max(0, NORMAL_UNLOCK_AFTER - done);

  // Normal button disabled/aria
  if (elDiffNormal) {
    elDiffNormal.disabled = !unlocked;
    elDiffNormal.setAttribute('aria-disabled', unlocked ? 'false' : 'true');
  }

  // Lock hint row + text
  if (elUnlockHintRow) elUnlockHintRow.hidden = unlocked;
  if (elUnlockHintText) {
    elUnlockHintText.textContent = unlocked
      ? 'Normal är upplåst.'
      : `Lås upp efter ${NORMAL_UNLOCK_AFTER} klarade (${left} kvar)`;
  }

  // Info text
  if (elDifficultyInfo) {
    elDifficultyInfo.textContent = unlocked
      ? 'Välj nivå för att filtrera uppdrag.'
      : `Normal är låst. Klara ${left} till för att låsa upp.`;
  }

  // Om vi står på normal men den är låst (fail-closed) -> tvinga easy
  if (!unlocked && activeDifficulty === 'normal') {
    activeDifficulty = 'easy';
    setDifficultyUI();
    renderMissionList();
    autoSelectFirstInFilter();
    toast('Normal är låst. Du är tillbaka på Easy.', 'warn', { ttlMs: 1800 });
  }
}

function setDifficultyUI() {
  // Active classes + aria-selected
  if (elDiffEasy) {
    const a = activeDifficulty === 'easy';
    elDiffEasy.classList.toggle('is-active', a);
    elDiffEasy.setAttribute('aria-selected', a ? 'true' : 'false');
  }
  if (elDiffNormal) {
    const a = activeDifficulty === 'normal';
    elDiffNormal.classList.toggle('is-active', a);
    elDiffNormal.setAttribute('aria-selected', a ? 'true' : 'false');
  }
}

/* ============================================================
   BLOCK 8 — Render: progress
============================================================ */
function renderProgress() {
  if (!store) return;
  const s = store.getState();

  setText(elLevelPill, `Lvl ${s.level}`);
  setText(elXp, `XP: ${s.xp}`);
  setText(elPoints, `Poäng: ${s.points}`);
  setText(elStreak, `Streak: ${s.streak?.count ?? 0}`);
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
  const photoOk = typeof hasPhoto === 'boolean' ? hasPhoto : (camera?.hasPhoto?.() || false);

  safeDisable(elComplete, !(missionActive && photoOk));
}

/* ============================================================
   BLOCK 11 — Render list + active mission
============================================================ */
function renderMissionList() {
  clear(elMissionsList);

  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  if (!missions.length) {
    elMissionsList.appendChild(renderErrorCard('Paketet saknar uppdrag.', [
      { label: 'Tillbaka', variant: 'ghost', onClick: () => window.location.assign('../index.html') }
    ]));
    return;
  }

  const idxs = filteredMissionIndexes();
  if (!idxs.length) {
    elMissionsList.appendChild(renderErrorCard(
      `Inga uppdrag på "${activeDifficulty}" i detta paket.`,
      [{ label: 'Byt till Easy', variant: 'primary', onClick: () => setDifficulty('easy') }]
    ));
    return;
  }

  idxs.forEach((origIndex) => {
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
    title.textContent = missionTitleOf(m, origIndex);

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
  setText(elDifficultyPill, normalizeDifficulty(m)); // KRAV: pill på missionkort
  setText(elActiveMissionPill, `Aktivt: ${activeIndex + 1}/${missions.length}`);

  ensureCameraUI();
  if (camera) camera.clear();
  updateCTAState({ hasPhoto: false });

  document.querySelectorAll('.missionItem').forEach((n) => {
    const idx = Number(n.getAttribute('data-mission-index'));
    n.classList.toggle('is-active', idx === activeIndex);
  });
}

/* ============================================================
   BLOCK 12 — Controller actions
============================================================ */
function setActiveMission(origIndex) {
  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  if (!missions.length) return;

  const idx = Number(origIndex);
  if (!Number.isFinite(idx) || idx < 0 || idx >= missions.length) return;

  // Guard: mission måste matcha filter
  if (normalizeDifficulty(missions[idx]) !== activeDifficulty) return;

  activeIndex = idx;
  renderMissionList();
  renderActiveMission();
}

function autoSelectFirstInFilter() {
  const idxs = filteredMissionIndexes();
  if (idxs.length) setActiveMission(idxs[0]);
  else renderActiveMission();
}

function setDifficulty(next) {
  const n = safeText(next).toLowerCase() === 'normal' ? 'normal' : 'easy';

  // Fail-closed: normal får inte väljas om låst
  if (n === 'normal' && store && !isNormalUnlocked(store.getState())) {
    toast(`Normal är låst. ${elUnlockHintText?.textContent || ''}`, 'warn', { ttlMs: 2200 });
    return;
  }

  activeDifficulty = n;
  setDifficultyUI();
  renderMissionList();
  autoSelectFirstInFilter();
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

  const file = camera?.getFile?.() || null; // HOOK: photo-file
  if (!file) {
    toast('Du måste ta/välja en bild innan du kan markera “Klar”.', 'warn', { ttlMs: 2200 });
    updateCTAState({ hasPhoto: false });
    return;
  }

  if (!store) {
    showFatal('Store saknas. Kan inte spara progression.');
    return;
  }

  const award = getAwardForMission(m);

  const res = store.update((s) => {
    const nextState = awardMissionComplete(s, award); // AO 2/6: increments completedCount
    return nextState || s;
  });

  if (!res.ok) {
    toast('Kunde inte spara progression.', 'danger');
    return;
  }

  renderProgress();

  // KRAV: när Normal låses upp -> UI uppdateras utan reload
  updateUnlockUI();

  toast(`Klar! +${award.points}p • +${award.xp}xp`, 'success');

  if (camera) camera.clear();
  updateCTAState({ hasPhoto: false });

  // auto-advance inom filter
  const idxs = filteredMissionIndexes();
  const pos = idxs.indexOf(activeIndex);
  const nextOrig = pos >= 0 && pos + 1 < idxs.length ? idxs[pos + 1] : null;

  if (nextOrig !== null && nextOrig !== undefined) setActiveMission(nextOrig);
  else {
    renderMissionList();
    renderActiveMission();
    toast(`Alla "${activeDifficulty}"-uppdrag klara (för nu).`, 'info', { ttlMs: 1800 });
  }
}

function openSwitchMissionDialog() {
  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  const idxs = filteredMissionIndexes();
  if (!idxs.length) return;

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

  modal({ title: `Byt uppdrag (${activeDifficulty})`, body, secondary: { label: 'Stäng', variant: 'ghost' } });
}

/* ============================================================
   BLOCK 13 — Boot
============================================================ */
(function bootPlay() {
  'use strict';

  if (window.__FAS11_AO3_PLAY_INIT__) return; // HOOK: init-guard-play
  window.__FAS11_AO3_PLAY_INIT__ = true;

  if (!store) {
    showFatal('Store saknas. Kan inte starta säkert.');
    return;
  }

  const mode = qsGet('mode');
  const id = qsGet('id');

  if (!mode || !id) return redirectToIndex('PLAY_MISSING_PARAMS');
  if (mode !== 'zone') return redirectToIndex('PLAY_MODE_REQUIRED');

  store.init();
  renderProgress();

  if (elBack) {
    elBack.addEventListener('click', () => {
      if (window.history.length > 1) window.history.back();
      else window.location.assign('../index.html');
    });
  }

  if (elComplete) elComplete.addEventListener('click', completeActiveMission);
  if (elSwitch) elSwitch.addEventListener('click', openSwitchMissionDialog);

  // Difficulty button binds
  if (elDiffEasy) elDiffEasy.addEventListener('click', () => setDifficulty('easy'));
  if (elDiffNormal) elDiffNormal.addEventListener('click', () => setDifficulty('normal'));

  safeDisable(elComplete, true);

  // Loading
  clear(elStatusSlot);
  const loading = document.createElement('div');
  loading.className = 'toast toast--info';
  loading.setAttribute('role', 'status');
  loading.textContent = 'Laddar paket…';
  elStatusSlot.appendChild(loading);

  (async () => {
    try {
      pack = await loadZonePack(id);

      if (!pack || typeof pack !== 'object' || !Array.isArray(pack.missions) || pack.missions.length < 1) {
        showFatal('Paketet saknar uppdrag (missions är tom).');
        return;
      }

      clear(elStatusSlot);
      renderPackHeader();

      // initial easy
      activeDifficulty = 'easy';
      setDifficultyUI();

      // unlock UI state based on store.completedCount
      updateUnlockUI();

      renderMissionList();
      autoSelectFirstInFilter();

      // Live updates: unlock can flip when completedCount changes in this tab
      store.subscribe(() => {
        renderProgress();
        updateUnlockUI(); // KRAV: uppdateras utan reload
      });
    } catch (e) {
      const code = safeText(e?.code || 'UNKNOWN');
      const rid = safeText(e?.requestId || '');
      const msg = safeText(e?.message || 'Kunde inte ladda paket.');
      showFatal(`${msg} Felkod: ${code}${rid ? ` (rid: ${rid})` : ''}`);
    }
  })();
})();

function redirectToIndex(err) {
  const code = (err || 'PLAY_BAD_PARAMS').toString().trim() || 'PLAY_BAD_PARAMS';
  const url = new URL('../index.html', window.location.href);
  url.searchParams.set('err', code);
  window.location.assign(url.toString());
}
