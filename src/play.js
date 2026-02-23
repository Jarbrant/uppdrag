/* ============================================================
   FIL: src/play.js  (HEL FIL)
   AO 1/6 + AO 2/6 + AO 3/6 + AO 4/6 (FAS 1.1) — Boss-uppdrag (valfritt)
   Mål:
   - Pack kan ha missions med isBoss:true (0..N)
   - Boss ska bara kunna göras en gång per "runda"
   - UI: “Boss (valfritt)” visas när spelaren klarat 5 uppdrag i rundan
         (eller när missionpoolen tar slut) — enkel stabil regel
   Fail-closed:
   - inga boss-missions => ingen boss-UI visas
   Kodkrav:
   - Inlinekommentar: definition av “runda” (lokalt i play-state, ej ny storage-key)
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
   Definition “runda” (KRAV inline):
   - En runda = en session i denna play-view (minnesstate i play.js).
   - Den startar när sidan laddas och nollas vid reload/navigation.
   - Ingen ny storage-key i FAS 1.1.
============================================================ */
const ROUND_TARGET = 5;      // enkel stabil regel (5 uppdrag i rundan)
let roundCompleted = 0;      // antal klarade (icke-boss) i denna runda
let bossDoneThisRound = false; // boss får bara göras 1 gång per runda
let bossOfferVisible = false;  // UI-state i minne

/* ============================================================
   BLOCK 6 — Helpers
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
   BLOCK 7 — Mission shape + difficulty + boss (KRAV)
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

function filteredMissionIndexes() {
  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  const idxs = [];
  for (let i = 0; i < missions.length; i++) {
    const m = missions[i];
    // Boss ska inte ligga i vanliga listan (visas via “Boss (valfritt)”)
    if (isBossMission(m)) continue;
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
   BLOCK 8 — Unlock UI state (AO 3/6)
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
   BLOCK 9 — Boss offer UI (AO 4/6)
   Regel:
   - Visa boss-offer när roundCompleted >= 5
     ELLER när missionpoolen (i filtret) är slut.
   - Boss kan göras 1 gång per runda.
   - Fail-closed: inga boss-missions => visa inte.
============================================================ */
function shouldOfferBoss() {
  if (bossDoneThisRound) return false;

  const bossIdxs = bossMissionIndexesForDifficulty();
  if (!bossIdxs.length) return false; // Fail-closed

  // Regel A: efter 5 klarade i rundan
  if (roundCompleted >= ROUND_TARGET) return true;

  // Regel B: när poolen tar slut i filtret
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

  modal({
    title: 'Boss (valfritt)',
    body,
    secondary: { label: 'Stäng', variant: 'ghost' }
  });
}

function setActiveBossMission(origIndex) {
  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  const idx = Number(origIndex);
  if (!Number.isFinite(idx) || idx < 0 || idx >= missions.length) return;

  const m = missions[idx];
  if (!isBossMission(m)) return;

  // Boss måste matcha difficulty-filter (stabilt)
  if (normalizeDifficulty(m) !== activeDifficulty) return;

  activeIndex = idx;
  renderMissionList();
  renderActiveMission();
}

/* ============================================================
   BLOCK 10 — Render: progress
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
   BLOCK 11 — Camera UI
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
   BLOCK 12 — CTA state
============================================================ */
function updateCTAState({ hasPhoto } = {}) {
  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  const m = missions[activeIndex];

  const missionActive = activeIndex >= 0 && !!m;
  const photoOk = typeof hasPhoto === 'boolean' ? hasPhoto : (camera?.hasPhoto?.() || false);

  safeDisable(elComplete, !(missionActive && photoOk));
}

/* ============================================================
   BLOCK 13 — Render list + active mission
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
    // Pool slut => boss kan triggas
    maybeShowBossOfferToast();

    elMissionsList.appendChild(renderErrorCard(
      `Inga fler uppdrag på "${activeDifficulty}" i denna runda.`,
      [
        { label: 'Boss (valfritt)', variant: 'primary', onClick: () => openBossDialog() },
        { label: 'Byt till Easy', variant: 'ghost', onClick: () => setDifficulty('easy') }
      ]
    ));
    return;
  }

  // Boss CTA-rad (valfritt) – bara om offer är aktivt
  maybeShowBossOfferToast();
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
  setText(elDifficultyPill, `${d}${bossTag}`); // UI: visar att det är boss
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
   BLOCK 14 — Controller actions
============================================================ */
function setActiveMission(origIndex) {
  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  if (!missions.length) return;

  const idx = Number(origIndex);
  if (!Number.isFinite(idx) || idx < 0 || idx >= missions.length) return;

  // Guard: mission måste matcha filter och inte vara boss (boss hanteras separat)
  const m = missions[idx];
  if (isBossMission(m)) return;
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

  // Ny difficulty => "runda" fortsätter (vi nollställer inte runda här)
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
    const nextState = awardMissionComplete(s, award);
    return nextState || s;
  });

  if (!res.ok) {
    toast('Kunde inte spara progression.', 'danger');
    return;
  }

  // Runda-logik (KRAV):
  // - Endast “vanliga” missions räknas mot ROUND_TARGET
  // - Boss får bara 1 gång per runda
  if (isBossMission(m)) {
    bossDoneThisRound = true;
  } else {
    roundCompleted += 1;
  }

  renderProgress();
  updateUnlockUI();

  toast(`Klar! +${award.points}p • +${award.xp}xp`, 'success');

  if (camera) camera.clear();
  updateCTAState({ hasPhoto: false });

  // Boss-offer kan triggas efter completion
  maybeShowBossOfferToast();

  // Auto-advance:
  // - Om boss just gjord -> återgå till vanliga poolen (om finns)
  // - Annars -> nästa i filtret
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
    toast(`Uppdragspoolen är slut.`, 'info', { ttlMs: 1600 });
  }
}

function openSwitchMissionDialog() {
  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  const idxs = filteredMissionIndexes();
  if (!idxs.length) return;

  const body = document.createElement('div');
  body.style.display = 'grid';
  body.style.gap = '8px';

  // Boss CTA som första val (om tillgänglig)
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
   BLOCK 15 — Boot
============================================================ */
(function bootPlay() {
  'use strict';

  if (window.__FAS11_AO4_PLAY_INIT__) return;
  window.__FAS11_AO4_PLAY_INIT__ = true;

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

      // Round resets on page load (KRAV: in-memory)
      roundCompleted = 0;
      bossDoneThisRound = false;
      bossOfferVisible = false;

      renderMissionList();
      autoSelectFirstInFilter();

      store.subscribe(() => {
        renderProgress();
        updateUnlockUI();
        // Boss-offer kan ändras pga user action i samma tab (men round state är lokalt)
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
