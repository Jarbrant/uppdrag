/* ============================================================
   FIL: src/admin-checkpoints.js  (HEL FIL)
   AO 3/5 — Checkpoint editor render + input events (ur admin.js)

   PATCH (P0) — Återställer:
   - “Slumpkod” per CP (unik kod, exakt samma princip som tidigare)
   - “Spara” per CP (kallar deps.saveNowOrWarn om finns, annars fallback)
   - Kartklick sätter dirty/pill via deps.markDirtyLIGHT (ingen FULL render)

   Policy: UI-only, XSS-safe, fail-closed, inga nya storage keys
   Krav: INGA FULL re-render per tangenttryck (endast LIGHT via deps.markDirtyLIGHT)

   Exports:
     initAdminCheckpoints(deps) -> {
       renderCheckpointEditorFULL,
       setActiveCp,
       setActiveCpPositionFromMap,
       updateCoordText,
       clampActiveIndex
     }
============================================================ */

export function initAdminCheckpoints(deps) {
  const d = deps || {};

  const getDraft = typeof d.getDraft === 'function' ? d.getDraft : () => null;
  const getActiveCpIndex = typeof d.getActiveCpIndex === 'function' ? d.getActiveCpIndex : () => 0;
  const setActiveCpIndex = typeof d.setActiveCpIndex === 'function' ? d.setActiveCpIndex : () => {};

  const clampInt = typeof d.clampInt === 'function'
    ? d.clampInt
    : (x, min, max) => Math.max(min, Math.min(max, Math.floor(Number(x) || min)));

  const safeText = typeof d.safeText === 'function'
    ? d.safeText
    : (x) => (x ?? '').toString();

  const normalizeCode = typeof d.normalizeCode === 'function'
    ? d.normalizeCode
    : (s) => safeText(s).trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32);

  const enforceFinalOnlyOnLast = typeof d.enforceFinalOnlyOnLast === 'function' ? d.enforceFinalOnlyOnLast : () => {};
  const markDirtyLIGHT = typeof d.markDirtyLIGHT === 'function' ? d.markDirtyLIGHT : () => {};
  const scheduleSave = typeof d.scheduleSave === 'function' ? d.scheduleSave : () => {};
  const renderPreview = typeof d.renderPreview === 'function' ? d.renderPreview : () => {};
  const renderErrorsAndPill = typeof d.renderErrorsAndPill === 'function' ? d.renderErrorsAndPill : () => {};
  const broadcastDraftToMap = typeof d.broadcastDraftToMap === 'function' ? d.broadcastDraftToMap : () => {};
  const showStatus = typeof d.showStatus === 'function' ? d.showStatus : () => {};
  const saveNowOrWarn = typeof d.saveNowOrWarn === 'function' ? d.saveNowOrWarn : null;

  const elCluesWrap = d.elCluesWrap || null;
  const elActiveCpLabel = d.elActiveCpLabel || null;
  const elMapHint = d.elMapHint || null;

  // --- Random code helpers (för “Slumpkod”) ---
  const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

  function randomCode(len = 5) {
    const n = clampInt(len, 4, 12);
    let out = '';
    for (let i = 0; i < n; i++) out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return out;
  }

  function usedCodesSet(draft) {
    const set = new Set();
    const n = clampInt(draft?.checkpointCount || 0, 0, 99);
    for (let i = 0; i < n; i++) {
      const c = normalizeCode(draft?.checkpoints?.[i]?.code || '');
      if (c) set.add(c);
    }
    return set;
  }

  function generateUniqueCode(existingSet, len = 5) {
    for (let tries = 0; tries < 30; tries++) {
      const c = randomCode(len);
      if (!existingSet.has(c)) return c;
    }
    let base = randomCode(len);
    let suffix = 2;
    while (existingSet.has(`${base}${suffix}`) && suffix < 99) suffix++;
    return normalizeCode(`${base}${suffix}`);
  }

  // --- Map helpers ---
  function getMapApi() {
    if (typeof d.getMapApi === 'function') {
      try { return d.getMapApi(); } catch (_) { return null; }
    }
    return window.__ADMIN_MAP_API__ || null;
  }

  function isMapReady() {
    if (typeof d.isMapReady === 'function') {
      try { return !!d.isMapReady(); } catch (_) { return false; }
    }
    const api = getMapApi();
    return !!(api && typeof api.isReady === 'function' && api.isReady());
  }

  function clampActiveIndex() {
    const draft = getDraft();
    const max = Math.max(0, (draft?.checkpointCount || 1) - 1);
    const next = clampInt(getActiveCpIndex(), 0, max);
    setActiveCpIndex(next);
  }

  function updateCoordText(index) {
    const draft = getDraft();
    if (!draft?.checkpoints) return;

    const cp = draft.checkpoints[index] || {};
    const lat = Number.isFinite(Number(cp.lat)) ? Number(cp.lat).toFixed(5) : '—';
    const lng = Number.isFinite(Number(cp.lng)) ? Number(cp.lng).toFixed(5) : '—';

    try {
      const node = document.querySelector(`[data-cp-coord="${index}"]`);
      if (node) node.textContent = `(${lat}, ${lng})`;
    } catch (_) {}
  }

  function setActiveCp(index, { centerMap = true } = {}) {
    const draft = getDraft();
    if (!draft) return;

    clampActiveIndex();
    const max = Math.max(0, (draft?.checkpointCount || 1) - 1);
    const next = clampInt(index, 0, max);
    setActiveCpIndex(next);

    if (elActiveCpLabel) elActiveCpLabel.textContent = `CP ${next + 1}`;
    if (elMapHint) elMapHint.textContent = `Aktiv CP ${next + 1} — klicka på kartan för att sätta plats.`;

    try {
      document.querySelectorAll('[data-cp-row]').forEach((el) => {
        const i = Number(el.getAttribute('data-cp-row'));
        el.classList.toggle('is-active', i === next);
        el.setAttribute('aria-current', i === next ? 'true' : 'false');
      });
    } catch (_) {}

    if (centerMap) {
      const cp = draft?.checkpoints?.[next];
      const api = getMapApi();
      if (api && typeof api.setViewIfNeeded === 'function' && cp) {
        try { api.setViewIfNeeded(cp.lat, cp.lng, 15); } catch (_) {}
      }
    }
  }

  function setActiveCpPositionFromMap(lat, lng) {
    const draft = getDraft();
    if (!draft) return;

    if (!isMapReady()) {
      showStatus('Kartan är inte redo. Kan inte sätta position.', 'warn');
      return;
    }

    clampActiveIndex();
    const idx = getActiveCpIndex();

    const cp = draft.checkpoints?.[idx];
    if (!cp) {
      showStatus('Ingen aktiv checkpoint. Välj checkpoint först.', 'warn');
      return;
    }

    cp.lat = Number(lat);
    cp.lng = Number(lng);

    // P0: ska ge dirty/pill som förr, men utan FULL render
    markDirtyLIGHT(true, { rerenderQR: false });

    updateCoordText(idx);
    broadcastDraftToMap();
    renderErrorsAndPill();

    showStatus(`Plats satt för CP ${idx + 1}.`, 'info');
  }

  function renderCheckpointEditorFULL() {
    const draft = getDraft();

    if (!elCluesWrap) {
      showStatus('Checkpoint-editor saknar DOM hook (cluesWrap).', 'warn');
      return;
    }
    if (!draft || !Array.isArray(draft.checkpoints)) {
      showStatus('Draft saknas eller är korrupt. Kan inte rendera checkpoints.', 'warn');
      return;
    }

    clampActiveIndex();
    elCluesWrap.innerHTML = '';

    const activeIdxNow = getActiveCpIndex();

    for (let i = 0; i < draft.checkpointCount; i++) {
      const cp = draft.checkpoints[i] || {};
      const isLast = i === (draft.checkpointCount - 1);

      const row = document.createElement('div');
      row.className = 'clueRow';
      row.setAttribute('data-cp-row', String(i));
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', `Välj checkpoint ${i + 1}`);

      function isEditableTarget(evt) {
        const t = evt?.target;
        const tag = (t?.tagName || '').toUpperCase();
        return (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable === true);
      }

      row.addEventListener('click', (e) => {
        if (isEditableTarget(e)) return;
        setActiveCp(i, { centerMap: true });
      });

      row.addEventListener('keydown', (e) => {
        if (isEditableTarget(e)) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setActiveCp(i, { centerMap: true });
        }
      });

      if (i === activeIdxNow) row.classList.add('is-active');

      const meta = document.createElement('div');
      meta.className = 'clueMeta';

      const idx = document.createElement('div');
      idx.className = 'clueIdx';
      idx.textContent = `CP ${i + 1}`;

      const coord = document.createElement('div');
      coord.className = 'muted small';
      coord.setAttribute('data-cp-coord', String(i));
      const lat = Number.isFinite(Number(cp.lat)) ? Number(cp.lat).toFixed(5) : '—';
      const lng = Number.isFinite(Number(cp.lng)) ? Number(cp.lng).toFixed(5) : '—';
      coord.textContent = `(${lat}, ${lng})`;

      meta.appendChild(idx);
      meta.appendChild(coord);

      const clueInput = document.createElement('input');
      clueInput.className = 'input clueInput';
      clueInput.type = 'text';
      clueInput.autocomplete = 'off';
      clueInput.placeholder = isLast && cp.isFinal ? 'Skattkista: ledtråd…' : 'Skriv ledtråd…';
      clueInput.value = safeText(cp.clue || draft.clues?.[i] || '');
      clueInput.setAttribute('data-cp-index', String(i));

      clueInput.addEventListener('focus', () => setActiveCp(i, { centerMap: false }));
      clueInput.addEventListener('input', (e) => {
        const k = clampInt(e.target.getAttribute('data-cp-index'), 0, 99);
        if (!draft.checkpoints[k]) return;
        draft.checkpoints[k].clue = safeText(e.target.value);

        // KRAV 3: INGEN FULL re-render per tangenttryck
        markDirtyLIGHT(true, { rerenderQR: false });
      });

      const grid = document.createElement('div');
      grid.style.display = 'grid';
      grid.style.gridTemplateColumns = '1fr 1fr 1fr';
      grid.style.gap = '8px';

      function labeled(labelText, inputEl) {
        const wrap = document.createElement('div');
        wrap.style.display = 'grid';
        wrap.style.gap = '6px';
        const lab = document.createElement('div');
        lab.className = 'muted small';
        lab.textContent = labelText;
        wrap.appendChild(lab);
        wrap.appendChild(inputEl);
        return wrap;
      }

      const points = document.createElement('input');
      points.className = 'input';
      points.type = 'number';
      points.inputMode = 'numeric';
      points.min = '0';
      points.max = '1000';
      points.step = '1';
      points.placeholder = `${draft.pointsPerCheckpoint}`;
      points.value = (cp.points === null || cp.points === undefined) ? '' : String(cp.points);
      points.setAttribute('data-cp-points', String(i));

      points.addEventListener('focus', () => setActiveCp(i, { centerMap: false }));
      points.addEventListener('input', (e) => {
        const k = clampInt(e.target.getAttribute('data-cp-points'), 0, 99);
        if (!draft.checkpoints[k]) return;
        const v = safeText(e.target.value).trim();
        draft.checkpoints[k].points = v === '' ? null : clampInt(v, 0, 1000);
        markDirtyLIGHT(true, { rerenderQR: false });
      });

      const code = document.createElement('input');
      code.className = 'input';
      code.type = 'text';
      code.autocomplete = 'off';
      code.placeholder = 'ex: HJBH6';
      code.value = safeText(cp.code || '');
      code.setAttribute('data-cp-code', String(i));

      code.addEventListener('focus', () => setActiveCp(i, { centerMap: false }));
      code.addEventListener('input', (e) => {
        const k = clampInt(e.target.getAttribute('data-cp-code'), 0, 99);
        if (!draft.checkpoints[k]) return;
        draft.checkpoints[k].code = normalizeCode(e.target.value);
        markDirtyLIGHT(true, { rerenderQR: true });
      });

      const radius = document.createElement('input');
      radius.className = 'input';
      radius.type = 'number';
      radius.inputMode = 'numeric';
      radius.min = '5';
      radius.max = '5000';
      radius.step = '1';
      radius.placeholder = '25';
      radius.value = String(clampInt(cp.radius ?? 25, 5, 5000));
      radius.setAttribute('data-cp-radius', String(i));

      radius.addEventListener('focus', () => setActiveCp(i, { centerMap: false }));
      radius.addEventListener('input', (e) => {
        const k = clampInt(e.target.getAttribute('data-cp-radius'), 0, 99);
        if (!draft.checkpoints[k]) return;
        draft.checkpoints[k].radius = clampInt(e.target.value, 5, 5000);
        markDirtyLIGHT(true, { rerenderQR: false });
      });

      grid.appendChild(labeled('Poäng', points));
      grid.appendChild(labeled('Kod', code));
      grid.appendChild(labeled('Radie (m)', radius));

      // --- Code row: hint + actions (Slumpkod + Spara) ---
      const codeRow = document.createElement('div');
      codeRow.style.display = 'flex';
      codeRow.style.alignItems = 'center';
      codeRow.style.justifyContent = 'space-between';
      codeRow.style.gap = '10px';
      codeRow.style.marginTop = '6px';

      const codeHint = document.createElement('div');
      codeHint.className = 'muted small';
      codeHint.textContent = 'Kod är valfri (kan genereras).';

      const actionsWrap = document.createElement('div');
      actionsWrap.style.display = 'flex';
      actionsWrap.style.gap = '8px';
      actionsWrap.style.flexWrap = 'wrap';
      actionsWrap.style.justifyContent = 'flex-end';

      const btnRnd = document.createElement('button');
      btnRnd.type = 'button';
      btnRnd.className = 'btn btn-ghost miniBtn';
      btnRnd.textContent = 'Slumpkod';
      btnRnd.setAttribute('data-cp-rnd', String(i));

      btnRnd.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();

        const k = clampInt(btnRnd.getAttribute('data-cp-rnd'), 0, 99);
        setActiveCp(k, { centerMap: false });

        const cur = normalizeCode(draft.checkpoints?.[k]?.code || '');
        if (cur) { showStatus(`CP ${k + 1} har redan en kod.`, 'warn'); return; }

        const used = usedCodesSet(draft);
        const next = generateUniqueCode(used, 5);

        if (!draft.checkpoints?.[k]) return;
        draft.checkpoints[k].code = next;

        const input = document.querySelector(`input[data-cp-code="${k}"]`);
        if (input) input.value = next;

        markDirtyLIGHT(true, { rerenderQR: true });
        showStatus(`Kod skapad för CP ${k + 1}.`, 'info');
      });

      const btnSaveCp = document.createElement('button');
      btnSaveCp.type = 'button';
      btnSaveCp.className = 'btn btn-primary miniBtn';
      btnSaveCp.textContent = 'Spara';
      btnSaveCp.setAttribute('data-cp-save', String(i));

      btnSaveCp.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (saveNowOrWarn) {
          try { saveNowOrWarn(); } catch (_) {}
          return;
        }
        // Fallback: autosave-style
        scheduleSave();
        showStatus('Utkast sparas automatiskt.', 'info');
      });

      actionsWrap.appendChild(btnRnd);
      actionsWrap.appendChild(btnSaveCp);

      codeRow.appendChild(codeHint);
      codeRow.appendChild(actionsWrap);

      // --- Final row ---
      const finalRow = document.createElement('div');
      finalRow.style.display = 'flex';
      finalRow.style.alignItems = 'center';
      finalRow.style.justifyContent = 'space-between';
      finalRow.style.gap = '10px';
      finalRow.style.marginTop = '6px';

      const finalLeft = document.createElement('div');
      finalLeft.className = 'muted small';
      finalLeft.textContent = isLast ? 'Final (Skattkista)' : 'Final kan bara vara sista checkpoint';

      const finalToggleWrap = document.createElement('label');
      finalToggleWrap.style.display = 'inline-flex';
      finalToggleWrap.style.alignItems = 'center';
      finalToggleWrap.style.gap = '8px';
      finalToggleWrap.style.userSelect = 'none';

      const finalToggle = document.createElement('input');
      finalToggle.type = 'checkbox';
      finalToggle.checked = (isLast && cp.isFinal === true);
      finalToggle.disabled = !isLast;
      finalToggle.setAttribute('data-cp-final', String(i));
      finalToggle.setAttribute('aria-label', 'Markera som Skattkista (final)');
      finalToggle.addEventListener('click', (ev) => ev.stopPropagation());

      const finalText = document.createElement('span');
      finalText.className = 'muted small';
      finalText.textContent = 'Skattkista';

      finalToggleWrap.appendChild(finalToggle);
      finalToggleWrap.appendChild(finalText);

      finalToggle.addEventListener('change', (e) => {
        const k = clampInt(e.target.getAttribute('data-cp-final'), 0, 99);
        const isLastNow = k === (draft.checkpointCount - 1);
        if (!isLastNow) return;

        if (!draft.checkpoints?.[k]) return;
        draft.checkpoints[k].isFinal = !!e.target.checked;

        enforceFinalOnlyOnLast(draft);

        // INGEN FULL render här
        markDirtyLIGHT(true, { rerenderQR: false });
        renderPreview();
      });

      finalRow.appendChild(finalLeft);
      finalRow.appendChild(finalToggleWrap);

      // --- Assemble ---
      row.appendChild(meta);
      row.appendChild(clueInput);
      row.appendChild(grid);
      row.appendChild(codeRow);
      row.appendChild(finalRow);

      elCluesWrap.appendChild(row);
    }

    setActiveCp(getActiveCpIndex(), { centerMap: false });
  }

  // Robust DOM hint (fail-closed)
  if (!elCluesWrap || !elActiveCpLabel || !elMapHint) {
    showStatus('Admin checkpoints: viktiga DOM-element saknas. Editor kan vara ofullständig.', 'warn');
  }

  return {
    renderCheckpointEditorFULL,
    setActiveCp,
    setActiveCpPositionFromMap,
    updateCoordText,
    clampActiveIndex
  };
}
