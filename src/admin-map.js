/* ============================================================
   FIL: src/admin-map.js  (NY FIL)
   /* AO 1/8 (FAS 1.5) — Admin Leaflet init */
   Mål: Admin-sidan kan visa Leaflet-karta (utan checkpoints än).
   KRAV:
   - Init map, set view, tile layer
   - Fail-closed om Leaflet saknas (visa tydligt fel)
   Policy: UI-only, lätt dependency via CDN, inga externa libs utöver Leaflet
============================================================ */

/* ============================================================
   BLOCK 1 — DOM hooks
============================================================ */
const $ = (sel) => document.querySelector(sel);

const elMap = $('#map');             // HOOK: map-container
const elMapError = $('#mapError');   // HOOK: map-error
const elStatusSlot = $('#statusSlot'); // HOOK: status-slot

/* ============================================================
   BLOCK 2 — UI helpers (fail-closed)
============================================================ */
function setText(node, text) {
  if (!node) return;
  node.textContent = (text ?? '').toString();
}

function showStatus(message, type = 'warn') {
  // Vi gör en minimal “toast-lik” status utan att kräva ui.js
  if (!elStatusSlot) return;
  const div = document.createElement('div');
  div.className = `toast toast--${type === 'danger' ? 'danger' : type === 'info' ? 'info' : 'warn'}`;
  div.setAttribute('role', 'status');
  div.textContent = (message ?? '').toString();
  elStatusSlot.appendChild(div);
}

function showMapError(message) {
  setText(elMapError, message || 'Kunde inte starta kartan.');
}

/* ============================================================
   BLOCK 3 — Leaflet init
============================================================ */
function initLeaflet() {
  // Fail-closed: map container måste finnas
  if (!elMap) {
    showStatus('Karta: #map saknas i DOM. (Init avbruten)', 'warn');
    return;
  }

  // Fail-closed: Leaflet måste vara laddat via CDN (window.L)
  const L = window.L;
  if (!L) {
    showMapError('Leaflet saknas (CDN blockerat/offline). Kartan kan inte visas.');
    showStatus('Karta: Leaflet saknas. Kontrollera nätverk/CDN.', 'warn');
    return;
  }

  try {
    // Default view: Stockholm-ish (kan ändras senare)
    const center = [59.3293, 18.0686];
    const zoom = 12;

    const map = L.map(elMap, {
      zoomControl: true,
      attributionControl: true
    });

    map.setView(center, zoom);

    // OSM tile layer
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap'
    }).addTo(map);

    // Spara referens om vi behöver senare (AO 2/8+)
    window.__ADMIN_LEAFLET_MAP__ = map; // HOOK: admin-leaflet-map
    setText(elMapError, '');
  } catch (e) {
    showMapError('Kunde inte initiera kartan (okänt fel).');
    showStatus('Karta: init-fel. (fail-closed)', 'danger');
  }
}

/* ============================================================
   BLOCK 4 — Boot
============================================================ */
(function bootAdminMap() {
  'use strict';

  if (window.__AO15_FAS15_ADMIN_MAP_INIT__) return; // HOOK: init-guard-admin-map
  window.__AO15_FAS15_ADMIN_MAP_INIT__ = true;

  initLeaflet();
})();
