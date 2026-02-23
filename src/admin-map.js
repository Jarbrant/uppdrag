/* ============================================================
   FIL: src/admin-map.js  (HEL FIL)
   AO 1/8 (FAS 1.5) — Admin Leaflet init
   AO 2/8 (FAS 1.5) — Klick → dispatch admin:map-click
   PATCH (FAS 2.1) — Default view: Stockholm + invalidateSize + (valfri) geolocation
   Policy: UI-only, Leaflet via CDN, fail-closed
============================================================ */

/* ============================================================
   BLOCK 1 — DOM hooks
============================================================ */
const $ = (sel) => document.querySelector(sel);

const elMap = $('#map');               // HOOK: map-container
const elMapError = $('#mapError');     // HOOK: map-error
const elStatusSlot = $('#statusSlot'); // HOOK: status-slot

/* ============================================================
   BLOCK 2 — UI helpers (fail-closed)
============================================================ */
function setText(node, text) {
  if (!node) return;
  node.textContent = (text ?? '').toString();
}

function showStatus(message, type = 'warn') {
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
   BLOCK 3 — Map state (Leaflet refs)
============================================================ */
let map = null;                 // HOOK: leaflet-map-ref
let markers = [];               // HOOK: leaflet-markers
let isReady = false;            // HOOK: map-ready

/* ============================================================
   BLOCK 4 — Marker helpers
============================================================ */
function clearMarkers() {
  try { markers.forEach((m) => { try { m.remove(); } catch (_) {} }); } catch (_) {}
  markers = [];
}

function makeNumberIcon(n) {
  const html = `
    <div style="
      width:28px;height:28px;border-radius:999px;
      background:rgba(110,231,255,.20);
      border:1px solid rgba(110,231,255,.55);
      color:rgba(255,255,255,.95);
      display:flex;align-items:center;justify-content:center;
      font-weight:900;font-size:13px;
      box-shadow: 0 6px 14px rgba(0,0,0,.25);
    ">${String(n)}</div>
  `;
  return window.L.divIcon({
    className: 'cpMarker',
    html,
    iconSize: [28, 28],
    iconAnchor: [14, 14]
  });
}

function renderMarkersFromCheckpoints(checkpoints) {
  if (!isReady || !map || !window.L) return;
  clearMarkers();

  const list = Array.isArray(checkpoints) ? checkpoints : [];
  for (let i = 0; i < list.length; i++) {
    const cp = list[i] || {};
    const lat = Number(cp.lat);
    const lng = Number(cp.lng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const marker = window.L.marker([lat, lng], {
      icon: makeNumberIcon(i + 1),
      keyboard: false
    });

    marker.addTo(map);
    markers.push(marker);
  }
}

/* ============================================================
   BLOCK 5 — Public API (för admin.js)
============================================================ */
function installMapAPI() {
  window.__ADMIN_MAP_API__ = {
    isReady: () => !!isReady,
    setCheckpoints: (list) => renderMarkersFromCheckpoints(list),
    setViewIfNeeded: (lat, lng, zoom = 14) => {
      if (!isReady || !map) return;
      const a = Number(lat), b = Number(lng);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return;
      try { map.setView([a, b], zoom); } catch (_) {}
    }
  };
}

/* ============================================================
   BLOCK 6 — Leaflet init
============================================================ */
function initLeaflet() {
  if (!elMap) {
    showStatus('Karta: #map saknas i DOM. (Init avbruten)', 'warn');
    return;
  }

  const L = window.L;
  if (!L) {
    showMapError('Leaflet saknas (CDN blockerat/offline). Kartan kan inte visas.');
    showStatus('Karta: Leaflet saknas. Kontrollera nätverk/CDN.', 'warn');
    return;
  }

  try {
    // Default view: STOCKHOLM (KRAV)
    const center = [59.3293, 18.0686];
    const zoom = 12;

    map = L.map(elMap, {
      zoomControl: true,
      attributionControl: true
    });

    map.setView(center, zoom);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap'
    }).addTo(map);

    // Fix: om container storlek inte är klar vid init → Leaflet kan hamna konstigt
    setTimeout(() => {
      try { map.invalidateSize(); } catch (_) {}
      try { map.setView(center, zoom); } catch (_) {}
    }, 120);

    // Valfritt: browser geolocation (utan IP-tjänst)
    // Fail-closed: om nekad/timeout → stanna i Stockholm
    if (navigator.geolocation && typeof navigator.geolocation.getCurrentPosition === 'function') {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const lat = Number(pos?.coords?.latitude);
          const lng = Number(pos?.coords?.longitude);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
          try { map.setView([lat, lng], 13); } catch (_) {}
        },
        () => { /* ignore */ },
        { enableHighAccuracy: false, timeout: 1200, maximumAge: 60_000 }
      );
    }

    // Klick → dispatch event
    map.on('click', (ev) => {
      if (!isReady) return;
      const lat = ev?.latlng?.lat;
      const lng = ev?.latlng?.lng;
      if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return;

      window.dispatchEvent(new CustomEvent('admin:map-click', {
        detail: { lat: Number(lat), lng: Number(lng) }
      }));
    });

    isReady = true;
    window.__ADMIN_LEAFLET_MAP__ = map;
    installMapAPI();
    setText(elMapError, '');
  } catch (_) {
    isReady = false;
    showMapError('Kunde inte initiera kartan (okänt fel).');
    showStatus('Karta: init-fel. (fail-closed)', 'danger');
  }
}

/* ============================================================
   BLOCK 7 — Listen: draft updates → re-render markers
============================================================ */
function bindDraftEvents() {
  window.addEventListener('admin:draft-changed', (e) => {
    if (!isReady) return;
    const cps = e?.detail?.checkpoints;
    renderMarkersFromCheckpoints(cps);
  });
}

/* ============================================================
   BLOCK 8 — Boot
============================================================ */
(function bootAdminMap() {
  'use strict';

  if (window.__AO15_FAS15_ADMIN_MAP_INIT__) return;
  window.__AO15_FAS15_ADMIN_MAP_INIT__ = true;

  initLeaflet();
  bindDraftEvents();
})();
