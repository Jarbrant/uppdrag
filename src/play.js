/* ============================================================
   FIL: src/play.js  (HEL FIL)
   AO 6/15 + AO 7/15 + AO 12/15 — Play page controller
   - Kamera krävs för “Klar” (AO-7)
   - Difficulty unlock: normal låses upp efter 15 klarade (AO-12)
   Policy: UI-only, fail-closed, XSS-safe rendering (DOM API + textContent),
           inga nya storage keys/datamodell.
============================================================ */

/* ============================================================
   BLOCK 1 — Imports
============================================================ */
import { qsGet } from './util.js';
import { createStore } from './store.js';
import { awardMissionComplete, completedCount, isNormalUnlocked, NORMAL_UNLOCK_AFTER } from './engine.js';
import { loadZonePack } from './packs.js';
import { toast, modal, renderErrorCard } from './ui.js';
import { createCamera } from './camera.js';

/* ============================================================
   BLOCK 2 — DOM hooks
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
const elDifficulty = $('#difficultyPill');    // HOOK: difficulty-pill

const elMissionsList = $('#missionsList');    // HOOK: missions-list
const elComplete = $('#completeBtn');         // HOOK: complete-button
const elSwitch = $('#switchBtn');             // HOOK: switch-mission-button

/* ============================================================
   BLOCK 3 — State (controller)
============================================================ */
const store = createStore(); // HOOK: store
let pack = null;
let activeIndex = -1;

// Camera state (in-memory only)
let camera = null;           // HOOK: camera-instance
let cameraMountPoint = null; // HOOK: camera-mount-point

/* ============================================================
   BLOCK 4 — Fail-closed redirect helper (index.html?err=...)
============================================================ */
function redirectToIndex(err) {
  const code = (err || 'PLAY_BAD_PARAMS').toString().trim() || 'PLAY_BAD_PARAMS';
  const url = new URL('/index.html', window.location.origin);
  url.searchParams.set('err', code);
  window.location.assign(url.toString());
}

/* ============================================================
   BLOCK 5 — Rendering helpers (render = render)
============================================================ */
function setText(node, text) {
  if (!node) return;
  node.textContent = (text ?? '').toString();
}

function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

/* ============================================================
   BLOCK 6 — Difficulty rules (AO-12)
   KRAV: Missions har difficulty (easy|normal).
   - Vi accepterar även "intro" som easy (bakåtkompat).
============================================================ */
function missionDifficultyOf(m) {
  const raw = (m?.difficulty ?? 'easy').toString().trim().toLowerCase();
  if (raw === 'normal') return 'normal';
  if (raw === 'easy') return 'easy';
  if (raw === 'intro') return 'easy';
  return 'easy';
}

function isMissionLocked(m) {
  const d = missionDifficultyOf(m);
  if (d !== 'normal') return false; // easy alltid ok
  const s = store.getState();
  return !isNormalUnlocked(s, NORMAL_UNLOCK_AFTER);
}

function unlockHintText() {
  const s = store.getState();
  const done = completedCount(s);
  const left = Math.max(0, NORMAL_UNLOCK_AFTER - done);
  if (left <= 0) return '';
  return `Lås upp efter ${NORMAL_UNLOCK_AFTER} klarade (${left} kvar)`;
}

/* ============================================================
   BLOCK 7 — Render progress
============================================================ */
function renderProgress() {
  const s = store.getState();
  setText(elLevelPill, `Lvl ${s.level}`);
  setText(elXp, `XP: ${s.xp}`);
  setText(elPoints, `Poäng: ${s.points}`);
  setText(elStreak, `Streak: ${s.streak?.count ?? 0}`);
}

function missionTitleOf(m, i) {
  const t = (m?.title ?? m?.name ?? '').toString().trim();
  return t || `Uppdrag ${i + 1}`;
}

function missionInstructionOf(m) {
  return (m?.instruction ?? m?.text ?? m?.hint ?? '').toString().trim()
    || 'Följ instruktionen och ta ett foto. Tryck “Klar” när du är klar.';
}

function renderPackHeader() {
  setText(elPackName, pack?.name || '—');
}

/* ============================================================
   BLOCK 8 — Missions list render (med lock UI)
   KRAV: UI visar lock-ikon + “Lås upp efter 15 klarade” (hook).
============================================================ */
function renderMissionList() {
  clear(elMissionsList);

  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  if (!missions.length) {
    elMissionsList.appendChild(renderErrorCard('Paketet saknar uppdrag.', [
      { label: 'Tillbaka', variant: 'ghost', onClick: () => window.location.assign('/index.html') }
    ]));
    return;
  }

  const hint = unlockHintText();

  missions.forEach((m, i) => {
    const locked = isMissionLocked(m);

    const item = document.createElement('div');
    item.className = 'missionItem' + (i === activeIndex ? ' is-active' : '') + (locked ? ' is-locked' : '');
    item.setAttribute('role', 'listitem');
    item.setAttribute('tabindex', '0');
    item.setAttribute('data-mission-index', String(i)); // HOOK: mission-item-index

    const meta = document.createElement('div');
    meta.className = 'missionItem__meta';

    const title = document.createElement('div');
    title.className = 'missionItem__title';
    title.textContent = missionTitleOf(m, i);

    const sub = document.createElement('div');
    sub.className = 'missionItem__sub muted';

    if (locked) {
      // KRAV: lock-ikon + unlock-text (hook)
      sub.innerHTML = ''; // safe: we build nodes, not inject user content
      const lock = document.createElement('span');
      lock.textContent = '🔒';
      lock.setAttribute('aria-hidden', 'true');
      lock.style.marginRight = '6px';

      const txt = document.createElement('span');
      txt.textContent = hint || `Lås upp efter ${NORMAL_UNLOCK_AFTER} klarade`;
      txt.setAttribute('data-hook', 'unlock-hint'); // HOOK: unlock-hint

      sub.appendChild(lock);
      sub.appendChild(txt);
    } else {
      sub.textContent = `Svårighet: ${missionDifficultyOf(m)}`;
    }

    meta.appendChild(title);
    meta.appendChild(sub);

    const pill = document.createElement('span');
    pill.className = 'pill pill--difficulty';
    pill.textContent = missionDifficultyOf(m);

    item.appendChild(meta);
    item.appendChild(pill);

    item.addEventListener('click', () => setActiveMission(i));
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setActiveMission(i);
      }
    });

    elMissionsList.appendChild(item);
  });
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
      onChange: ({ hasPhoto }) => {
        updateCTAState({ hasPhoto });
      }
    });
  }

  camera.mount(cameraMountPoint);
}

/* ============================================================
   BLOCK 10 — CTA state (mission + lock + foto)
============================================================ */
function updateCTAState({ hasPhoto } = {}) {
  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  const m = missions[activeIndex];

  const missionActive = activeIndex >= 0 && !!m;
  const locked = m ? isMissionLocked(m) : false;

  const photoOk = typeof hasPhoto === 'boolean'
    ? hasPhoto
    : (camera?.hasPhoto?.() || false);

  if (elComplete) {
    // Fail-closed: kräver mission + ej locked + foto
    elComplete.disabled = !(missionActive && !locked && photoOk);
  }
}

/* ============================================================
   BLOCK 11 — Active mission render (med lock-hint)
============================================================ */
let lockHintNode = null; // HOOK: lock-hint-node

function renderActiveMission() {
  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  const m = missions[activeIndex];

  // cleanup lock hint
  if (lockHintNode && lockHintNode.isConnected) lockHintNode.remove();
  lockHintNode = null;

  if (!m) {
    elMissionCard.hidden = true;
    setText(elActiveMissionPill, 'Inget uppdrag valt');
    if (camera) camera.clear();
    updateCTAState({ hasPhoto: false });
    return;
  }

  const locked = isMissionLocked(m);

  elMissionCard.hidden = false;
  setText(elMissionTitle, missionTitleOf(m, activeIndex));
  setText(elMissionInstruction, missionInstructionOf(m));
  setText(elDifficulty, missionDifficultyOf(m));
  setText(elActiveMissionPill, `Aktivt: ${activeIndex + 1}/${missions.length}`);

  // Lock hint under instruction (KRAV hook)
  if (locked) {
    lockHintNode = document.createElement('div');
    lockHintNode.className = 'muted small';
    lockHintNode.setAttribute('data-hook', 'unlock-hint'); // HOOK: unlock-hint
    lockHintNode.style.marginTop = '8px';
    lockHintNode.textContent = `🔒 ${unlockHintText() || `Lås upp efter ${NORMAL_UNLOCK_AFTER} klarade`}`;
    elMissionInstruction.insertAdjacentElement('afterend', lockHintNode);
  }

  // Camera always shown, but “Klar” blocked if locked
  ensureCameraUI();

  // Ny mission => nytt foto krävs (fail-closed)
  if (camera) camera.clear();
  updateCTAState({ hasPhoto: false });

  // Markera list items
  document.querySelectorAll('.missionItem').forEach((n) => {
    const idx = Number(n.getAttribute('data-mission-index'));
    n.classList.toggle('is-active', idx === activeIndex);
  });
}

/* ============================================================
   BLOCK 12 — Status render
============================================================ */
function renderStatusLoading(text = 'Laddar paket…') {
  clear(elStatusSlot);
  const node = document.createElement('div');
  node.className = 'toast toast--info';
  node.setAttribute('role', 'status');
  node.textContent = text;
  elStatusSlot.appendChild(node);
}

function renderStatusError(message, actions = []) {
  clear(elStatusSlot);
  elStatusSlot.appendChild(renderErrorCard(message, actions));
}

/* ============================================================
   BLOCK 13 — Controller actions
============================================================ */
function setActiveMission(i) {
  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  if (!missions.length) return;

  const idx = Number(i);
  if (!Number.isFinite(idx) || idx < 0 || idx >= missions.length) return;

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

  // KRAV: låst normal blockas (fail-closed)
  if (isMissionLocked(m)) {
    toast(`Låst: ${unlockHintText() || `Lås upp efter ${NORMAL_UNLOCK_AFTER} klarade`}`, 'warn', { ttlMs: 2600 });
    updateCTAState({ hasPhoto: camera?.hasPhoto?.() || false });
    return;
  }

  // KRAV: Fail-closed om ingen bild
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

  // Viktigt: unlock kan ändras efter award → rerender list för lock states
  renderProgress();
  renderMissionList();

  toast(`Klar! +${award.points} poäng • +${award.xp} XP`, 'success');

  // Rensa foto efter completion
  if (camera) camera.clear();
  updateCTAState({ hasPhoto: false });

  // Auto: gå till nästa mission om finns
  if (activeIndex + 1 < missions.length) {
    setActiveMission(activeIndex + 1);
  } else {
    setActiveMission(activeIndex);
    toast('Alla uppdrag i paketet är klara (för nu).', 'info', { ttlMs: 2200 });
  }
}

function openSwitchMissionDialog() {
  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  if (!missions.length) return;

  const body = document.createElement('div');
  body.style.display = 'grid';
  body.style.gap = '8px';

  missions.forEach((m, i) => {
    const locked = isMissionLocked(m);

    const b = document.createElement('button');
    b.className = 'btn btn-ghost';
    b.type = 'button';
    b.textContent = locked
      ? `🔒 ${i + 1}. ${missionTitleOf(m, i)}`
      : `${i + 1}. ${missionTitleOf(m, i)}`;

    b.addEventListener('click', () => {
      setActiveMission(i);
      toast(locked ? 'Uppdrag valt (låst).' : 'Uppdrag bytt.', 'info', { ttlMs: 1400 });
    });

    body.appendChild(b);
  });

  modal({
    title: 'Byt uppdrag',
    body,
    secondary: { label: 'Stäng', variant: 'ghost' }
  });
}

/* ============================================================
   BLOCK 14 — Boot
============================================================ */
(function bootPlay() {
  'use strict';

  if (window.__AO12_PLAY_INIT__) return; // HOOK: init-guard-play
  window.__AO12_PLAY_INIT__ = true;

  const mode = qsGet('mode'); // HOOK: qs-mode
  const id = qsGet('id');     // HOOK: qs-id

  if (!mode || !id) return redirectToIndex('PLAY_MISSING_PARAMS');

  store.init();
  renderProgress();

  if (elBack) {
    elBack.addEventListener('click', () => {
      if (window.history.length > 1) window.history.back();
      else window.location.assign('/index.html');
    });
  }

  if (elComplete) elComplete.addEventListener('click', completeActiveMission);
  if (elSwitch) elSwitch.addEventListener('click', openSwitchMissionDialog);

  if (elComplete) elComplete.disabled = true;

  renderStatusLoading('Laddar paket…');

  (async () => {
    try {
      if (mode !== 'zone') {
        throw { name: 'ModeError', code: 'MODE_NOT_SUPPORTED', message: 'Endast zonpaket stöds här.' };
      }

      pack = await loadZonePack(id);

      clear(elStatusSlot);
      renderPackHeader();
      renderMissionList();

      setActiveMission(0);
      renderActiveMission();

      // info: om normal låst, visa hint via toast en gång
      if (!isNormalUnlocked(store.getState(), NORMAL_UNLOCK_AFTER)) {
        toast(`Normal låses upp efter ${NORMAL_UNLOCK_AFTER} klarade.`, 'info', { ttlMs: 2200 });
      }
    } catch (e) {
      const msg = (e?.message || 'Kunde inte ladda paketet.').toString();

      renderStatusError(msg, [
        { label: 'Tillbaka', variant: 'ghost', onClick: () => window.location.assign('/index.html') },
        { label: 'Försök igen', variant: 'primary', onClick: () => window.location.reload() }
      ]);

      if (elComplete) elComplete.disabled = true;
      if (elSwitch) elSwitch.disabled = true;
    }
  })();

  // Live updates if another tab/page changes state
  store.subscribe(() => {
    renderProgress();
    renderMissionList();
    renderActiveMission();
  });
})();
