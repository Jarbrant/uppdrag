/* ============================================================
   FIL: src/play.js  (HEL FIL)   (NY FIL)
   AO 6/15 — Play page controller (missions + progress) utan kamera
   Mål: Spelvy som visar uppdrag och “Klar” (utan foto än).
   Policy: UI-only, fail-closed, XSS-safe rendering (DOM API + textContent),
           inga nya storage keys/datamodell.
============================================================ */

/* ============================================================
   BLOCK 1 — Imports
============================================================ */
import { qsGet } from './util.js';
import { createStore } from './store.js';
import { awardMissionComplete } from './engine.js';
import { loadZonePack } from './packs.js';
import { toast, modal, renderErrorCard } from './ui.js';

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
   BLOCK 5 — Rendering (render = render)
============================================================ */
function setText(node, text) {
  if (!node) return;
  node.textContent = (text ?? '').toString();
}

function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

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
  return (m?.instruction ?? m?.text ?? m?.hint ?? '').toString().trim() || 'Följ instruktionen och tryck “Klar” när du är klar.';
}

function missionDifficultyOf(m) {
  const d = (m?.difficulty ?? 'normal').toString().trim().toLowerCase();
  if (d === 'intro' || d === 'advanced' || d === 'normal') return d;
  return 'normal';
}

function renderPackHeader() {
  setText(elPackName, pack?.name || '—');
}

function renderMissionList() {
  clear(elMissionsList);

  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  if (!missions.length) {
    elMissionsList.appendChild(renderErrorCard('Paketet saknar uppdrag.', [
      { label: 'Tillbaka', variant: 'ghost', onClick: () => window.location.assign('/index.html') }
    ]));
    return;
  }

  missions.forEach((m, i) => {
    const item = document.createElement('div');
    item.className = 'missionItem' + (i === activeIndex ? ' is-active' : '');
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
    sub.textContent = `Svårighet: ${missionDifficultyOf(m)}`;

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

function renderActiveMission() {
  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  const m = missions[activeIndex];

  if (!m) {
    elMissionCard.hidden = true;
    setText(elActiveMissionPill, 'Inget uppdrag valt');
    elComplete.disabled = true;
    return;
  }

  elMissionCard.hidden = false;
  setText(elMissionTitle, missionTitleOf(m, activeIndex));
  setText(elMissionInstruction, missionInstructionOf(m));
  setText(elDifficulty, missionDifficultyOf(m));
  setText(elActiveMissionPill, `Aktivt: ${activeIndex + 1}/${missions.length}`);
  elComplete.disabled = false;

  // Markera list items
  document.querySelectorAll('.missionItem').forEach((n) => {
    const idx = Number(n.getAttribute('data-mission-index'));
    n.classList.toggle('is-active', idx === activeIndex);
  });
}

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
   BLOCK 6 — Controller actions
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
  // Stub: foto kommer senare. Vi ger poäng/XP ändå.
  const points = Number.isFinite(Number(m?.points)) ? Number(m.points) : 10;
  const xp = Number.isFinite(Number(m?.xp)) ? Number(m.xp) : 25;
  return { points, xp };
}

function completeActiveMission() {
  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  const m = missions[activeIndex];
  if (!m) return;

  // Stub för foto: här skulle vi normalt kräva foto/validering i senare AO.
  // HOOK: photo-stub

  const award = getAwardForMission(m);

  const res = store.update((s) => {
    // Engine muterar state-draft och returnerar state (ok)
    const next = awardMissionComplete(s, award);
    return next || s;
  });

  if (!res.ok) {
    toast('Kunde inte spara progression.', 'danger');
    return;
  }

  renderProgress();
  toast(`Klar! +${award.points} poäng • +${award.xp} XP`, 'success');

  // Auto: gå till nästa uppdrag om finns
  if (activeIndex + 1 < missions.length) {
    setActiveMission(activeIndex + 1);
  } else {
    setActiveMission(activeIndex); // behåll sista
    toast('Alla uppdrag i paketet är klara (för nu).', 'info', { ttlMs: 2400 });
  }
}

function openSwitchMissionDialog() {
  const missions = Array.isArray(pack?.missions) ? pack.missions : [];
  if (!missions.length) return;

  const body = document.createElement('div');
  body.style.display = 'grid';
  body.style.gap = '8px';

  missions.forEach((m, i) => {
    const b = document.createElement('button');
    b.className = 'btn btn-ghost';
    b.type = 'button';
    b.textContent = `${i + 1}. ${missionTitleOf(m, i)}`;

    b.addEventListener('click', () => {
      setActiveMission(i);
      // stäng modal via primary/secondary action? Vi stänger via modal replace trick:
      // enklast: öppna en ny modal = close existing; men vi har ingen ref här.
      // Vi lägger i stället en toast och låter användaren trycka X/ESC.
      toast('Uppdrag bytt.', 'info', { ttlMs: 1400 });
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
   BLOCK 7 — Boot (load pack + bind UI)
============================================================ */
(function bootPlay() {
  'use strict';

  // INIT-GUARD
  if (window.__AO6_PLAY_INIT__) return; // HOOK: init-guard-play
  window.__AO6_PLAY_INIT__ = true;

  // Params
  const mode = qsGet('mode'); // HOOK: qs-mode
  const id = qsGet('id');     // HOOK: qs-id

  // Fail-closed: kräver mode/id
  if (!mode || !id) return redirectToIndex('PLAY_MISSING_PARAMS');

  // Start store
  store.init();
  renderProgress();

  // Back button
  if (elBack) {
    elBack.addEventListener('click', () => {
      // Fail-soft: om history finns, gå back, annars index
      if (window.history.length > 1) window.history.back();
      else window.location.assign('/index.html');
    });
  }

  // Bind CTA
  if (elComplete) elComplete.addEventListener('click', completeActiveMission);
  if (elSwitch) elSwitch.addEventListener('click', openSwitchMissionDialog);

  // Load pack
  renderStatusLoading('Laddar paket…');

  (async () => {
    try {
      if (mode !== 'zone') {
        // Party-pack kommer senare AO. Fail-closed här.
        throw { name: 'ModeError', code: 'MODE_NOT_SUPPORTED', message: 'Endast zonpaket stöds i AO-6.' };
      }

      // id tolkas som zoneId i AO-6
      pack = await loadZonePack(id);

      // UI
      clear(elStatusSlot);
      renderPackHeader();
      renderMissionList();

      // Auto-select första missionen
      setActiveMission(0);
      renderActiveMission();
      toast('Paket laddat.', 'success', { ttlMs: 1200 });
    } catch (e) {
      const msg = (e?.message || 'Kunde inte ladda paketet.').toString();

      renderStatusError(msg, [
        { label: 'Tillbaka', variant: 'ghost', onClick: () => window.location.assign('/index.html') },
        { label: 'Försök igen', variant: 'primary', onClick: () => window.location.reload() }
      ]);

      // Disable CTAs fail-closed
      if (elComplete) elComplete.disabled = true;
      if (elSwitch) elSwitch.disabled = true;
    }
  })();
})();
