/* ============================================================
   FIL: src/play.js  (HEL FIL)
   AO 6/15 + AO 7/15 + AO 12/15 + AO 13/15 — Play page controller
   Mål: Robust felhantering (pack saknas / nätfel / tom missions)
   KRAV:
   - Alla fetch-fel mappas till tydliga felkoder (packs.js)
   - play.js visar Error Card + “Tillbaka” + “Försök igen”
   - Inga okontrollerade exceptions
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

let camera = null;           // HOOK: camera-instance
let cameraMountPoint = null; // HOOK: camera-mount-point
let lockHintNode = null;     // HOOK: lock-hint-node

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
   BLOCK 5 — Safe utils (no uncontrolled exceptions)
============================================================ */
function safeText(x) {
  return (x ?? '').toString();
}

function setText(node, text) {
  if (!node) return;
  node.textContent = safeText(text);
}

function clear(node) {
  try {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  } catch (_) { /* ignore */ }
}

function safeDisable(el, disabled) {
  try { if (el) el.disabled = !!disabled; } catch (_) {}
}

function safeHide(el, hidden) {
  try { if (el) el.hidden = !!hidden; } catch (_) {}
}

function mapPackError(e) {
  // KRAV: tydliga felkoder
  const code = safeText(e?.code || 'UNKNOWN');
  const rid = safeText(e?.requestId || '');
  const msg = safeText(e?.message || 'Kunde inte ladda paket.');

  const suffix = rid ? ` (rid: ${rid})` : '';
  return {
    code,
    message: `${msg} Felkod: ${code}${suffix}`
  };
}

/* ============================================================
   BLOCK 6 — Difficulty rules (AO-12)
============================================================ */
function missionDifficultyOf(m) {
  const raw = safeText(m?.difficulty || 'easy').trim().toLowerCase();
  if (raw === 'normal') return 'normal';
  if (raw === 'easy') return 'easy';
  if (raw === 'intro') return 'easy';
  return 'easy';
}

function isMissionLocked(m) {
  const d = missionDifficultyOf(m);
  if (d !== 'normal') return false;
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
  try {
    const s = store.getState();
    setText(elLevelPill, `Lvl ${s.level}`);
    setText(elXp, `XP: ${s.xp}`);
    setText(elPoints, `Poäng: ${s.points}`);
    setText(elStreak, `Streak: ${s.streak?.count ?? 0}`);
  } catch (_) {
    // Fail-soft: lämna UI, store är redan fail-closed i sig
  }
}

function missionTitleOf(m, i) {
  const t = safeText(m?.title ?? m?.name).trim();
  return t || `Uppdrag ${i + 1}`;
}

function missionInstructionOf(m) {
  return safeText(m?.instruction ?? m?.text ?? m?.hint).trim()
    || 'Följ instruktionen och ta ett foto. Tryck “Klar” när du är klar.';
}

function renderPackHeader() {
  setText(elPackName, pack?.name || '—');
}

/* ============================================================
   BLOCK 8 — Error handling UI (KRAV)
============================================================ */
function renderStatusError(message, actions = []) {
  clear(elStatusSlot);
  try {
    elStatusSlot.appendChild(renderErrorCard(message, actions));
  } catch (_) {
    // Absolut sista fallback
    const p = document.createElement('p');
    p.textContent = message;
    elStatusSlot.appendChild(p);
  }
}

function showFatalError(errObj) {
  const message = safeText(errObj?.message || 'Okänt fel.');

  // Disable/lock UI fail-closed
  safeDisable(elComplete, true);
  safeDisable(elSwitch, true);
  safeHide(elMissionCard, true);

  renderStatusError(message, [
    { label: 'Tillbaka', variant: 'ghost', onClick: () => window.location.assign('/index.html') },
    { label: 'Försök igen', variant: 'primary', onClick: () => window.location.reload() }
  ]);
}

/* ============================================================
   BLOCK 9 — Missions list render (med lock UI)
============================================================ */
function renderMissionList() {
  clear(elMissionsList);

  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  if (!missions.length) {
    // KRAV: tom missions hanteras med Error Card
    elMissionsList.appendChild(renderErrorCard('Paketet saknar uppdrag (missions är tom).', [
      { label: 'Tillbaka', variant: 'ghost', onClick: () => window.location.assign('/index.html') },
      { label: 'Försök igen', variant: 'primary', onClick: () => window.location.reload() }
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
      // Lock-ikon + unlock-text (hook)
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
   BLOCK 10 — Camera UI
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
   BLOCK 11 — CTA state (mission + lock + foto)
============================================================ */
function updateCTAState({ hasPhoto } = {}) {
  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  const m = missions[activeIndex];

  const missionActive = activeIndex >= 0 && !!m;
  const locked = m ? isMissionLocked(m) : false;

  const photoOk = typeof hasPhoto === 'boolean'
    ? hasPhoto
    : (camera?.hasPhoto?.() || false);

  safeDisable(elComplete, !(missionActive && !locked && photoOk));
}

/* ============================================================
   BLOCK 12 — Active mission render (med lock-hint)
============================================================ */
function renderActiveMission() {
  try {
    const missions = Array.isArray(pack?.missions) ? pack.missions : [];
    const m = missions[activeIndex];

    if (lockHintNode && lockHintNode.isConnected) lockHintNode.remove();
    lockHintNode = null;

    if (!m) {
      safeHide(elMissionCard, true);
      setText(elActiveMissionPill, 'Inget uppdrag valt');
      if (camera) camera.clear();
      updateCTAState({ hasPhoto: false });
      return;
    }

    const locked = isMissionLocked(m);

    safeHide(elMissionCard, false);
    setText(elMissionTitle, missionTitleOf(m, activeIndex));
    setText(elMissionInstruction, missionInstructionOf(m));
    setText(elDifficulty, missionDifficultyOf(m));
    setText(elActiveMissionPill, `Aktivt: ${activeIndex + 1}/${missions.length}`);

    if (locked) {
      lockHintNode = document.createElement('div');
      lockHintNode.className = 'muted small';
      lockHintNode.setAttribute('data-hook', 'unlock-hint'); // HOOK: unlock-hint
      lockHintNode.style.marginTop = '8px';
      lockHintNode.textContent = `🔒 ${unlockHintText() || `Lås upp efter ${NORMAL_UNLOCK_AFTER} klarade`}`;
      elMissionInstruction.insertAdjacentElement('afterend', lockHintNode);
    }

    ensureCameraUI();
    if (camera) camera.clear(); // ny mission => nytt foto krävs
    updateCTAState({ hasPhoto: false });

    document.querySelectorAll('.missionItem').forEach((n) => {
      const idx = Number(n.getAttribute('data-mission-index'));
      n.classList.toggle('is-active', idx === activeIndex);
    });
  } catch (_) {
    showFatalError({ message: 'UI-rendering misslyckades.' });
  }
}

/* ============================================================
   BLOCK 13 — Controller actions
============================================================ */
function setActiveMission(i) {
  try {
    const missions = Array.isArray(pack?.missions) ? pack.missions : [];
    if (!missions.length) return;

    const idx = Number(i);
    if (!Number.isFinite(idx) || idx < 0 || idx >= missions.length) return;

    activeIndex = idx;
    renderMissionList();
    renderActiveMission();
  } catch (_) {
    showFatalError({ message: 'Kunde inte välja uppdrag.' });
  }
}

function getAwardForMission(m) {
  const points = Number.isFinite(Number(m?.points)) ? Number(m.points) : 10;
  const xp = Number.isFinite(Number(m?.xp)) ? Number(m.xp) : 25;
  return { points, xp };
}

function completeActiveMission() {
  try {
    const missions = Array.isArray(pack?.missions) ? pack.missions : [];
    const m = missions[activeIndex];
    if (!m) return;

    if (isMissionLocked(m)) {
      toast(`Låst: ${unlockHintText() || `Lås upp efter ${NORMAL_UNLOCK_AFTER} klarade`}`, 'warn', { ttlMs: 2600 });
      updateCTAState({ hasPhoto: camera?.hasPhoto?.() || false });
      return;
    }

    const file = camera?.getFile?.() || null;
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
    renderMissionList();

    toast(`Klar! +${award.points} poäng • +${award.xp} XP`, 'success');

    if (camera) camera.clear();
    updateCTAState({ hasPhoto: false });

    if (activeIndex + 1 < missions.length) {
      setActiveMission(activeIndex + 1);
    } else {
      setActiveMission(activeIndex);
      toast('Alla uppdrag i paketet är klara (för nu).', 'info', { ttlMs: 2200 });
    }
  } catch (_) {
    showFatalError({ message: 'Kunde inte slutföra uppdrag.' });
  }
}

function openSwitchMissionDialog() {
  try {
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
  } catch (_) {
    toast('Kunde inte öppna listan.', 'danger');
  }
}

/* ============================================================
   BLOCK 14 — Boot
============================================================ */
(function bootPlay() {
  'use strict';

  try {
    if (window.__AO13_PLAY_INIT__) return; // HOOK: init-guard-play
    window.__AO13_PLAY_INIT__ = true;

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

    safeDisable(elComplete, true);

    // Loading state (fail-soft)
    clear(elStatusSlot);
    const loading = document.createElement('div');
    loading.className = 'toast toast--info';
    loading.setAttribute('role', 'status');
    loading.textContent = 'Laddar paket…';
    elStatusSlot.appendChild(loading);

    (async () => {
      try {
        if (mode !== 'zone') {
          showFatalError({ message: 'Endast zonpaket stöds här.' });
          return;
        }

        pack = await loadZonePack(id);

        // Pack saknas/ogiltigt (tom missions) → fail-closed
        if (!pack || typeof pack !== 'object') {
          showFatalError({ message: 'Paket saknas eller är ogiltigt.' });
          return;
        }

        if (!Array.isArray(pack.missions) || pack.missions.length < 1) {
          // Tom missions: visa error card + actions
          clear(elStatusSlot);
          renderMissionList();
          safeDisable(elComplete, true);
          safeDisable(elSwitch, true);
          return;
        }

        clear(elStatusSlot);
        renderPackHeader();
        renderMissionList();
        setActiveMission(0);
        renderActiveMission();

        if (!isNormalUnlocked(store.getState(), NORMAL_UNLOCK_AFTER)) {
          toast(`Normal låses upp efter ${NORMAL_UNLOCK_AFTER} klarade.`, 'info', { ttlMs: 2200 });
        }

        // Live updates
        store.subscribe(() => {
          renderProgress();
          renderMissionList();
          renderActiveMission();
        });
      } catch (e) {
        // KRAV: fetch-fel mappas till tydliga felkoder
        const mapped = mapPackError(e);
        showFatalError(mapped);
      }
    })();
  } catch (_) {
    // Absolut sista skyddet
    showFatalError({ message: 'Start misslyckades (okänt fel).' });
  }
})();
