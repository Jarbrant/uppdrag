/* ============================================================
   FIL: src/profile.js  (HEL FIL)
   AO 8/15 — Profile page controller (level/streak/historik)
   Mål: Visa progression + reset demo (confirm modal)
   Policy: UI-only, fail-closed, XSS-safe rendering (DOM API + textContent)
============================================================ */

/* ============================================================
   BLOCK 1 — Imports
============================================================ */
import { createStore } from './store.js';
import { calcLevel } from './engine.js';
import { toast, modal, renderErrorCard } from './ui.js';

/* ============================================================
   BLOCK 2 — DOM hooks
============================================================ */
const $ = (sel) => document.querySelector(sel);

const elBack = $('#backBtn');       // HOOK: back-button
const elReset = $('#resetBtn');     // HOOK: reset-demo

const elLevel = $('#levelValue');   // HOOK: level-value
const elStreakPill = $('#streakPill'); // HOOK: streak-pill
const elXpText = $('#xpText');      // HOOK: xp-text
const elXpBar = document.querySelector('.xpBar'); // HOOK: xp-bar
const elXpFill = $('#xpFill');      // HOOK: xp-fill

const elHistory = $('#historyList'); // HOOK: history-list

/* ============================================================
   BLOCK 3 — Store
============================================================ */
const store = createStore(); // HOOK: store

/* ============================================================
   BLOCK 4 — Helpers (render = render)
============================================================ */
function setText(node, text) {
  if (!node) return;
  node.textContent = (text ?? '').toString();
}

function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

function pct(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(100, x));
}

function formatTs(ts) {
  // Fail-soft: visa rå ISO om parsing misslyckas
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return (ts ?? '').toString();
    return d.toLocaleString('sv-SE');
  } catch (_) {
    return (ts ?? '').toString();
  }
}

/* ============================================================
   BLOCK 5 — Render: Level + XP bar + streak
   - XP bar visar progress inom aktuell level (100 XP per level enligt calcLevel)
============================================================ */
function renderStats() {
  const s = store.getState();

  const xp = Number(s.xp || 0);
  const level = calcLevel(xp); // robust: beräkna från xp
  const streak = Number(s.streak?.count || 0);

  setText(elLevel, String(level));
  setText(elStreakPill, `Streak: ${streak}`);

  // XP progress in current level (100 xp per level)
  const levelBase = (level - 1) * 100;
  const levelNext = level * 100;
  const inLevel = Math.max(0, xp - levelBase);
  const span = Math.max(1, levelNext - levelBase);
  const percent = pct((inLevel / span) * 100);

  setText(elXpText, `${inLevel} / ${span}`);
  if (elXpFill) elXpFill.style.width = `${percent}%`;
  if (elXpBar) elXpBar.setAttribute('aria-valuenow', String(Math.round(percent)));
}

/* ============================================================
   BLOCK 6 — Render: Historik (senaste först)
============================================================ */
function renderHistory() {
  const s = store.getState();
  const items = Array.isArray(s.history) ? s.history.slice() : [];

  // Senaste först
  items.sort((a, b) => {
    const at = (a?.ts ?? '').toString();
    const bt = (b?.ts ?? '').toString();
    return bt.localeCompare(at);
  });

  clear(elHistory);

  if (!items.length) {
    elHistory.appendChild(
      renderErrorCard('Ingen historik ännu.', [
        { label: 'Gå och spela', variant: 'primary', onClick: () => window.location.assign('/pages/play.html?mode=zone&id=skogsrundan') }
      ])
    );
    return;
  }

  const max = Math.min(items.length, 80);
  for (let i = 0; i < max; i++) {
    const it = items[i] || {};
    const type = (it.type ?? 'event').toString();
    const ts = formatTs(it.ts);
    const day = (it.day ?? '').toString();

    const row = document.createElement('div');
    row.className = 'historyItem';
    row.setAttribute('role', 'listitem');

    const left = document.createElement('div');
    left.className = 'historyItem__left';

    const title = document.createElement('div');
    title.className = 'historyItem__title';
    title.textContent = type === 'mission_complete' ? 'Uppdrag klart' : type;

    const meta = document.createElement('div');
    meta.className = 'historyItem__meta muted';
    meta.textContent = day ? `${ts} • ${day}` : ts;

    left.appendChild(title);
    left.appendChild(meta);

    const right = document.createElement('div');
    right.className = 'historyItem__right';

    const pts = Number(it.points || 0);
    const xp = Number(it.xp || 0);

    const ptsLine = document.createElement('div');
    ptsLine.className = 'delta delta--pts';
    ptsLine.textContent = pts ? `+${pts}p` : '';

    const xpLine = document.createElement('div');
    xpLine.className = 'delta delta--xp';
    xpLine.textContent = xp ? `+${xp}xp` : '';

    const lvlLine = document.createElement('div');
    lvlLine.className = 'muted small';
    const la = it.levelAfter !== undefined ? `Lvl ${it.levelAfter}` : '';
    lvlLine.textContent = la;

    right.appendChild(ptsLine);
    right.appendChild(xpLine);
    right.appendChild(lvlLine);

    row.appendChild(left);
    row.appendChild(right);

    elHistory.appendChild(row);
  }
}

/* ============================================================
   BLOCK 7 — Reset demo (confirm modal)
============================================================ */
function confirmReset() {
  modal({
    title: 'Reset demo?',
    body: 'Detta raderar din lokala progression (XP, level, streak och historik). Detta går inte att ångra.',
    primary: {
      label: 'Ja, reset',
      variant: 'danger',
      onClick: () => {
        try {
          store.reset();
          renderStats();
          renderHistory();
          toast('Demo resetad.', 'success');
        } catch (_) {
          toast('Kunde inte reseta demo.', 'danger');
        }
      }
    },
    secondary: { label: 'Avbryt', variant: 'ghost' }
  });
}

/* ============================================================
   BLOCK 8 — Boot
============================================================ */
(function bootProfile() {
  'use strict';

  // INIT-GUARD
  if (window.__AO8_PROFILE_INIT__) return; // HOOK: init-guard-profile
  window.__AO8_PROFILE_INIT__ = true;

  store.init();
  renderStats();
  renderHistory();

  if (elBack) {
    elBack.addEventListener('click', () => {
      if (window.history.length > 1) window.history.back();
      else window.location.assign('/index.html');
    });
  }

  if (elReset) {
    elReset.addEventListener('click', (e) => {
      e.preventDefault();
      confirmReset();
    });
  }

  // Live updates if another tab/page changes state
  store.subscribe(() => {
    renderStats();
    renderHistory();
  });
})();
