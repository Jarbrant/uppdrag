/* ============================================================
   FIL: src/play.js  (HEL FIL)
   AO 1/6 + AO 2/6 + AO 3/6 + AO 4/6 + AO 5/6 (FAS 1.1)
   AO 5/6 — Boss-belöning: extra XP + confetti + extra toast

   Mål:
   - När boss klaras: extra belöning + “wow”-känsla
   - Ingen ny storage-key (in-memory effekter)
   - Fail-soft: confetti får aldrig krascha sidan

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
try { store = createStore(); } catch (_) { store = null; }

/* ============================================================
   BLOCK 3 — DOM hooks
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
   BLOCK 5 — Boss-round state (KRAV)
   Definition “runda”:
   - En runda = en session i denna play-view (in-memory).
   - Startar vid page-load och nollas vid reload/navigation.
============================================================ */
const ROUND_TARGET = 5;
let roundCompleted = 0;
let bossDoneThisRound = false;
let bossOfferVisible = false;

/* ============================================================
   BLOCK 6 — AO 5/6: Boss-belöning (konstanter)
   - Extra belöning ges UTÖVER packets points/xp.
   - Stabilt och enkelt: flat bonus.
============================================================ */
const BOSS_BONUS_POINTS = 20; // HOOK: boss-bonus-points
const BOSS_BONUS_XP = 25;     // HOOK: boss-bonus-xp

/* ============================================================
   BLOCK 7 — Helpers
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
   BLOCK 8 — Mission shape + difficulty + boss
   mission shape:
   { id?, title|name, instruction|text|hint, difficulty?, points?, xp?, isBoss?: boolean }
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

function isBossMission(m) {
  return m?.isBoss === true;
}

/* ============================================================
   BLOCK 9 — Lists: normal pool + boss pool
============================================================ */
function filteredMissionIndexes() {
  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  const idxs = [];
  for (let i = 0; i < missions.length; i++) {
    const m = missions[i];
    if (isBossMission(m)) continue; // Boss visas separat
    if (normalizeDifficulty(m) === activeDifficulty) idxs.push(i);
  }
  return idxs;
}

function bossMissionIndexesForDifficulty() {
  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  const idxs = [];
  for (let i = 0; i < missions.length; i++) {
    const m = missions[i];
    if (!isBossMission(m)) continue;
    if (normalizeDifficulty(m) === activeDifficulty) idxs.push(i);
  }
  return idxs;
}

/* ============================================================
   BLOCK 10 — Unlock UI state (AO 3/6)
============================================================ */
function updateUnlockUI() {
  if (!store) return;

  const s = store.getState();
  const unlocked = isNormalUnlocked(s);
  const done = getCompletedCount(s);
  const left = Math.max(0, NORMAL_UNLOCK_AFTER - done);

  if (elDiffNormal) {
    elDiffNormal.disabled = !unlocked;
    elDiffNormal.setAttribute('aria-disabled', unlocked ? 'false' : 'true');
  }

  if (elUnlockHintRow) elUnlockHintRow.hidden = unlocked;
  if (elUnlockHintText) {
    elUnlockHintText.textContent = unlocked
      ? 'Normal är upplåst.'
      : `Lås upp efter ${NORMAL_UNLOCK_AFTER} klarade (${left} kvar)`;
  }

  if (elDifficultyInfo) {
    elDifficultyInfo.textContent = unlocked
      ? 'Välj nivå för att filtrera uppdrag.'
      : `Normal är låst. Klara ${left} till för att låsa upp.`;
  }

  if (!unlocked && activeDifficulty === 'normal') {
    activeDifficulty = 'easy';
    setDifficultyUI();
    renderMissionList();
    autoSelectFirstInFilter();
    toast('Normal är låst. Du är tillbaka på Easy.', 'warn', { ttlMs: 1800 });
  }
}

function setDifficultyUI() {
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
   BLOCK 11 — AO 4/6 Boss offer UI logic
============================================================ */
function shouldOfferBoss() {
  if (bossDoneThisRound) return false;

  const bossIdxs = bossMissionIndexesForDifficulty();
  if (!bossIdxs.length) return false; // Fail-closed

  if (roundCompleted >= ROUND_TARGET) return true;

  const idxs = filteredMissionIndexes();
  if (!idxs.length) return true;

  return false;
}

function maybeShowBossOfferToast() {
  const offer = shouldOfferBoss();
  if (offer && !bossOfferVisible) {
    bossOfferVisible = true;
    toast('Boss (valfritt) är nu tillgänglig!', 'info', { ttlMs: 2200 });
  }
  if (!offer) bossOfferVisible = false;
}

function openBossDialog() {
  const bossIdxs = bossMissionIndexesForDifficulty();
  if (!bossIdxs.length) {
    toast('Ingen boss finns i detta paket.', 'info', { ttlMs: 1600 });
    return;
  }
  if (bossDoneThisRound) {
    toast('Boss är redan gjord i denna runda.', 'warn', { ttlMs: 1600 });
    return;
  }
  if (!shouldOfferBoss()) {
    toast(`Boss låses upp efter ${ROUND_TARGET} klarade i rundan.`, 'info', { ttlMs: 1800 });
    return;
  }

  const missions = pack.missions;

  const body = document.createElement('div');
  body.style.display = 'grid';
  body.style.gap = '8px';

  const info = document.createElement('div');
  info.className = 'muted small';
  info.textContent = 'Boss är valfri och kan göras en gång per runda.';
  body.appendChild(info);

  bossIdxs.forEach((origIndex, i) => {
    const m = missions[origIndex];
    const b = document.createElement('button');
    b.className = 'btn btn-primary';
    b.type = 'button';
    b.textContent = `${i + 1}. ${missionTitleOf(m, origIndex)}`;

    b.addEventListener('click', () => {
      setActiveBossMission(origIndex);
      toast('Boss vald.', 'success', { ttlMs: 1200 });
    });

    body.appendChild(b);
  });

  modal({ title: 'Boss (valfritt)', body, secondary: { label: 'Stäng', variant: 'ghost' } });
}

function setActiveBossMission(origIndex) {
  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  const idx = Number(origIndex);
  if (!Number.isFinite(idx) || idx < 0 || idx >= missions.length) return;

  const m = missions[idx];
  if (!isBossMission(m)) return;
  if (normalizeDifficulty(m) !== activeDifficulty) return;

  activeIndex = idx;
  renderMissionList();
  renderActiveMission();
}

/* ============================================================
   BLOCK 12 — Render: progress
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
   BLOCK 13 — Camera UI
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
   BLOCK 14 — CTA state
============================================================ */
function updateCTAState({ hasPhoto } = {}) {
  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  const m = missions[activeIndex];

  const missionActive = activeIndex >= 0 && !!m;
  const photoOk = typeof hasPhoto === 'boolean' ? hasPhoto : (camera?.hasPhoto?.() || false);

  safeDisable(elComplete, !(missionActive && photoOk));
}

/* ============================================================
   BLOCK 15 — Render: list + active mission
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

  maybeShowBossOfferToast();

  // Boss CTA-rad – endast om boss finns och offer är aktivt
  if (shouldOfferBoss()) {
    const bossRow = document.createElement('div');
    bossRow.className = 'card card--info';
    bossRow.style.marginBottom = '10px';

    const title = document.createElement('div');
    title.style.fontWeight = '900';
    title.textContent = 'Boss (valfritt)';

    const desc = document.createElement('div');
    desc.className = 'muted small';
    desc.textContent = bossDoneThisRound
      ? 'Boss är redan gjord i denna runda.'
      : `Tillgänglig nu. (1 gång per runda)`;

    const actions = document.createElement('div');
    actions.className = 'card__actions';

    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.type = 'button';
    btn.textContent = bossDoneThisRound ? 'Boss klar' : 'Välj Boss';
    btn.disabled = bossDoneThisRound;
    btn.addEventListener('click', () => openBossDialog());

    actions.appendChild(btn);
    bossRow.appendChild(title);
    bossRow.appendChild(desc);
    bossRow.appendChild(actions);

    elMissionsList.appendChild(bossRow);
  }

  if (!idxs.length) {
    elMissionsList.appendChild(renderErrorCard(
      `Inga fler uppdrag på "${activeDifficulty}" i denna runda.`,
      [
        // Boss-knapp visas bara om boss finns/erbjuds
        ...(shouldOfferBoss() ? [{ label: 'Boss (valfritt)', variant: 'primary', onClick: () => openBossDialog() }] : []),
        { label: 'Tillbaka', variant: 'ghost', onClick: () => window.location.assign('../index.html') }
      ]
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

  const d = normalizeDifficulty(m);
  const bossTag = isBossMission(m) ? ' • Boss' : '';

  setText(elMissionTitle, missionTitleOf(m, activeIndex));
  setText(elMissionInstruction, missionInstructionOf(m));
  setText(elDifficultyPill, `${d}${bossTag}`);
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
   BLOCK 16 — Controller actions
============================================================ */
function setActiveMission(origIndex) {
  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  if (!missions.length) return;

  const idx = Number(origIndex);
  if (!Number.isFinite(idx) || idx < 0 || idx >= missions.length) return;

  const m = missions[idx];
  if (isBossMission(m)) return; // boss via dialog
  if (normalizeDifficulty(m) !== activeDifficulty) return;

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

  if (n === 'normal' && store && !isNormalUnlocked(store.getState())) {
    toast(`Normal är låst. ${elUnlockHintText?.textContent || ''}`, 'warn', { ttlMs: 2200 });
    return;
  }

  activeDifficulty = n;
  setDifficultyUI();

  renderMissionList();
  autoSelectFirstInFilter();
}

/* ============================================================
   BLOCK 17 — AO 5/6: Boss bonus award + confetti
============================================================ */
function getAwardForMission(m) {
  const basePoints = Number.isFinite(Number(m?.points)) ? Number(m.points) : 10;
  const baseXp = Number.isFinite(Number(m?.xp)) ? Number(m.xp) : 25;

  if (isBossMission(m)) {
    // Boss får extra belöning (flat bonus)
    return {
      points: basePoints + BOSS_BONUS_POINTS,
      xp: baseXp + BOSS_BONUS_XP,
      bossBonus: { points: BOSS_BONUS_POINTS, xp: BOSS_BONUS_XP } // HOOK: boss-bonus-meta
    };
  }

  return { points: basePoints, xp: baseXp, bossBonus: null };
}

function fireConfetti() {
  // Fail-soft: confetti får aldrig krascha.
  try {
    const root = document.body;
    if (!root) return;

    const existing = document.getElementById('confettiOverlay'); // HOOK: confetti-overlay
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'confettiOverlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.pointerEvents = 'none';
    overlay.style.zIndex = '2000';

    const style = document.createElement('style');
    style.textContent = `
      @keyframes confettiFall {
        0%   { transform: translate3d(var(--x,0px), -20px, 0) rotate(0deg); opacity: 1; }
        100% { transform: translate3d(var(--x,0px), calc(100vh + 40px), 0) rotate(720deg); opacity: 0.95; }
      }
      .confettiPiece {
        position: absolute;
        top: -20px;
        width: 10px;
        height: 14px;
        border-radius: 3px;
        opacity: 0.98;
        animation: confettiFall var(--t, 1800ms) linear forwards;
        will-change: transform;
        filter: drop-shadow(0 6px 10px rgba(0,0,0,.18));
      }
    `;

    overlay.appendChild(style);

    const count = 36;
    for (let i = 0; i < count; i++) {
      const p = document.createElement('div');
      p.className = 'confettiPiece';

      // Random placement
      const left = Math.random() * 100;
      p.style.left = `${left}%`;

      // Random color (no custom palette required)
      p.style.background = `hsl(${Math.floor(Math.random() * 360)}, 90%, 60%)`;

      // Random drift + duration
      const drift = Math.floor((Math.random() * 260) - 130);
      const dur = Math.floor(1400 + Math.random() * 1200);

      p.style.setProperty('--x', `${drift}px`);
      p.style.setProperty('--t', `${dur}ms`);

      overlay.appendChild(p);
    }

    root.appendChild(overlay);

    // Cleanup
    setTimeout(() => {
      try { overlay.remove(); } catch (_) {}
    }, 2300);
  } catch (_) {
    // ignore
  }
}

function completeActiveMission() {
  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  const m = missions[activeIndex];
  if (!m) return;

  const file = camera?.getFile?.() || null;
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
    const nextState = awardMissionComplete(s, { points: award.points, xp: award.xp });
    return nextState || s;
  });

  if (!res.ok) {
    toast('Kunde inte spara progression.', 'danger');
    return;
  }

  // Runda-logik:
  if (isBossMission(m)) bossDoneThisRound = true;
  else roundCompleted += 1;

  renderProgress();
  updateUnlockUI();

  // AO 5/6: extra “wow” för boss
  if (isBossMission(m)) {
    fireConfetti();
    const bonus = award.bossBonus;
    toast(
      bonus
        ? `🏆 BOSS KLAR! Bonus +${bonus.points}p • +${bonus.xp}xp`
        : '🏆 BOSS KLAR!',
      'success',
      { ttlMs: 2400 }
    );
  } else {
    toast(`Klar! +${award.points}p • +${award.xp}xp`, 'success');
  }

  if (camera) camera.clear();
  updateCTAState({ hasPhoto: false });

  maybeShowBossOfferToast();

  // Auto-advance
  if (isBossMission(m)) {
    const idxs = filteredMissionIndexes();
    if (idxs.length) setActiveMission(idxs[0]);
    else {
      renderMissionList();
      renderActiveMission();
      toast('Rundan klar (inga fler uppdrag).', 'info', { ttlMs: 1800 });
    }
    return;
  }

  const idxs = filteredMissionIndexes();
  const pos = idxs.indexOf(activeIndex);
  const nextOrig = pos >= 0 && pos + 1 < idxs.length ? idxs[pos + 1] : null;

  if (nextOrig !== null && nextOrig !== undefined) setActiveMission(nextOrig);
  else {
    renderMissionList();
    renderActiveMission();
    toast('Uppdragspoolen är slut.', 'info', { ttlMs: 1600 });
  }
}

function openSwitchMissionDialog() {
  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  const idxs = filteredMissionIndexes();
  if (!idxs.length) return;

  const body = document.createElement('div');
  body.style.display = 'grid';
  body.style.gap = '8px';

  if (shouldOfferBoss() && !bossDoneThisRound && bossMissionIndexesForDifficulty().length) {
    const bossBtn = document.createElement('button');
    bossBtn.className = 'btn btn-primary';
    bossBtn.type = 'button';
    bossBtn.textContent = 'Boss (valfritt)';
    bossBtn.addEventListener('click', () => openBossDialog());
    body.appendChild(bossBtn);
  }

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
   BLOCK 18 — Boot
============================================================ */
(function bootPlay() {
  'use strict';

  if (window.__FAS11_AO5_PLAY_INIT__) return;
  window.__FAS11_AO5_PLAY_INIT__ = true;

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

  if (elDiffEasy) elDiffEasy.addEventListener('click', () => setDifficulty('easy'));
  if (elDiffNormal) elDiffNormal.addEventListener('click', () => setDifficulty('normal'));

  safeDisable(elComplete, true);

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

      // Initial filter: easy
      activeDifficulty = 'easy';
      setDifficultyUI();
      updateUnlockUI();

      // Round resets on page load (in-memory)
      roundCompleted = 0;
      bossDoneThisRound = false;
      bossOfferVisible = false;

      renderMissionList();
      autoSelectFirstInFilter();

      store.subscribe(() => {
        renderProgress();
        updateUnlockUI();
        renderMissionList();
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
