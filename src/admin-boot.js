/* ============================================================
   FIL: src/admin-boot.js  (NY FIL)
   AO 4/5 — Flytta “Boot + bindEvents” till egen modul

   Policy: UI-only, XSS-safe, fail-closed, inga nya storage keys
   Beteende: ska vara identiskt med tidigare boot i admin.js
============================================================ */

export function bootAdmin(deps) {
  const d = deps || {};
  const qsGet = d.qsGet;
  const showStatus = d.showStatus;
  const isMapReady = d.isMapReady;

  const getDraft = d.getDraft;
  const setDraft = d.setDraft;
  const defaultDraft = d.defaultDraft;

  const getDirty = d.getDirty;
  const setDirty = d.setDirty;

  const getActiveCpIndex = d.getActiveCpIndex;
  const setActiveCpIndex = d.setActiveCpIndex;

  const readDraft = d.readDraft;
  const writeDraft = d.writeDraft;

  const tryLoadFromLibraryOnBoot = d.tryLoadFromLibraryOnBoot;
  const createDeleteButtonIfLoaded = d.createDeleteButtonIfLoaded;

  const initExportModule = d.initExportModule;
  const getExportUI = d.getExportUI;

  const bindEvents = d.bindEvents;
  const bindMapEvents = d.bindMapEvents;

  const renderAllFULL = d.renderAllFULL;
  const renderErrorsAndPill = d.renderErrorsAndPill;

  const elActiveCpLabel = d.elActiveCpLabel || null;
  const elMapHint = d.elMapHint || null;

  if (typeof qsGet !== 'function' || typeof showStatus !== 'function') return;

  // Guard: kör bara en gång
  if (window.__FAS12_AO5_ADMIN_INIT__) return;
  window.__FAS12_AO5_ADMIN_INIT__ = true;

  // 0) FORCE NEW: ?new=1
  const forceNew = qsGet('new') === '1';
  if (forceNew) {
    try { d.removeDraftKey?.(); } catch (_) {}

    try { d.clearLoadedLibraryContext?.(); } catch (_) {}

    setDraft(defaultDraft());
    setDirty(true);
    setActiveCpIndex(0);

    showStatus('Nytt utkast skapat.', 'info');

    // städa URL
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete('new');
      window.history.replaceState({}, '', u.toString());
    } catch (_) {}
  } else {
    // om inte forceNew: säkerställ att draft finns
    if (!getDraft()) {
      try { setDraft(readDraft()); } catch (_) { setDraft(defaultDraft()); }
    }
  }

  // 1) ?load=
  try { tryLoadFromLibraryOnBoot(); } catch (_) {}

  // 2) Radera-knapp om ?load=
  try { createDeleteButtonIfLoaded(); } catch (_) {}

  // 3) Init export UI (AO 2/5)
  try { initExportModule(); } catch (_) {}
  try {
    const exportUI = getExportUI?.();
    if (exportUI && typeof exportUI.ensureExportPanel === 'function') exportUI.ensureExportPanel();
  } catch (_) {}

  // 4) Bind events
  try { bindMapEvents(); } catch (_) {}
  try { bindEvents(); } catch (_) {}

  // 5) Init labels
  if (elActiveCpLabel) elActiveCpLabel.textContent = `CP ${getActiveCpIndex() + 1}`;
  if (elMapHint) elMapHint.textContent = `Aktiv CP ${getActiveCpIndex() + 1} — klicka på kartan för att sätta plats.`;

  // 6) Render
  try { renderAllFULL({ broadcastMap: true, rerenderQR: true }); } catch (_) {}
  try { renderErrorsAndPill(); } catch (_) {}

  // 7) Map status
  try {
    if (typeof isMapReady === 'function' && !isMapReady()) showStatus('Karta ej redo. (Leaflet/CDN?)', 'warn');
  } catch (_) {}
}
