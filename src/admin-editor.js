/* ============================================================
   FIL: src/admin-editor.js  (HEL FIL)
   AO 3/5 — Bryt ut checkpoint-editor + aktiv CP-state från admin.js
   Syfte:
   - Hålla admin.js kortare
   - Lättare felsökning: editor + aktiv CP + coord-render på ett ställe
   Policy: UI-only, XSS-safe, fail-closed, inga nya storage keys
============================================================ */

export function createAdminEditor(opts = {}) {
  const clampInt = opts.clampInt || ((n, min, max) => {
    const x = Math.floor(Number(n));
    if (!Number.isFinite(x)) return min;
    return Math.max(min, Math.min(max, x));
  });

  const safeText = opts.safeText || ((x) => (x ?? '').toString());
  const normalizeCode = opts.normalizeCode || ((s) => safeText(s).trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32));

  const showStatus = typeof opts.showStatus === 'function' ? opts.showStatus : (() => {});
  const onMarkDirty = typeof opts.onMarkDirty === 'function' ? opts.onMarkDirty : (() => {});
  const onSaveNow = typeof opts.onSaveNow === 'function' ? opts.onSaveNow : (() => {});
  const onCenterMap = typeof opts.onCenterMap === 'function' ? opts.onCenterMap : (() => {});

  const usedCodesSet = typeof opts.usedCodesSet === 'function' ? opts.usedCodesSet : (() => new Set());
  const generateUniqueCode = typeof opts.generateUniqueCode === 'function' ? opts.generateUniqueCode : (() => '');

  const enforceFinalOnlyOnLast = typeof opts.enforceFinalOnlyOnLast === 'function'
    ? opts.enforceFinalOnlyOnLast
    : (() => {});

  const onAfterFinalToggle = typeof opts.onAfterFinalToggle === 'function'
    ? opts.onAfterFinalToggle
    : (() => {});

  // DOM hooks (finns i pages/admin.html)
  const elCluesWrap = document.getElementById('cluesWrap');       // HOOK: clues-wrap
  const elActiveCpLabel = document.getElementById('activeCpLabel'); // HOOK: active-cp-label
  const elMapHint = document.getElementById('mapHint');           // HOOK: map-hint

  let activeCpIndex = 0; // HOOK: active-cp-index (module)

  function getActiveCpIndex() {
    return activeCpIndex;
  }

  function clampActiveIndex(draft) {
    const max = Math.max(0, (draft?.checkpointCount || 1) - 1);
    activeCpIndex = clampInt(activeCpIndex, 0, max);
  }

  function setActiveCp(draft, index, { centerMap = true } = {}) {
    clampActiveIndex(draft);
    const max = Math.max(0, (draft?.checkpointCount || 1) - 1);
    activeCpIndex = clampInt(index, 0, max);

    if (elActiveCpLabel) elActiveCpLabel.textContent = `CP ${activeCpIndex + 1}`;
    if (elMapHint) elMapHint.textContent = `Aktiv CP ${activeCpIndex + 1} — klicka på kartan för att sätta plats.`;

    // Markera aktiv rad (utan att skriva HTML)
    try {
      document.querySelectorAll('[data-cp-row]').forEach((el) => {
        const i = Number(el.getAttribute('data-cp-row'));
        el.classList.toggle('is-active', i === activeCpIndex);
        el.setAttribute('aria-current', i === activeCpIndex ? 'true' : 'false');
      });
    } catch (_) {}

    if (centerMap) {
      const cp = draft?.checkpoints?.[activeCpIndex];
      onCenterMap(cp?.lat, cp?.lng, 15);
    }
  }

  function updateCoordText(draft, index) {
    const cp = draft?.checkpoints?.[index] || {};
    const lat = Number.isFinite(Number(cp.lat)) ? Number(cp.lat).toFixed(5) : '—';
    const lng = Number.isFinite(Number(cp.lng)) ? Number(cp.lng).toFixed(5) : '—';
    const node = document.querySelector(`[data-cp-coord="${index}"]`);
    if (node) node.textContent = `(${lat}, ${lng})`;
  }

  function setActiveCpPositionFromMap(draft, lat, lng) {
    clampActiveIndex(draft);

    const cp = draft?.checkpoints?.[activeCpIndex];
    if (!cp) { showStatus('Ingen aktiv checkpoint. Välj checkpoint först.', 'warn'); return; }

    cp.lat = Number(lat);
    cp.lng = Number(lng);

    updateCoordText(draft, activeCpIndex);
    onMarkDirty({ rerenderQR: false, broadcastMap: true });

    showStatus(`Plats satt för CP ${activeCpIndex + 1}.`, 'info');
  }

  function isEditableTarget(evt) {
    const t = evt?.target;
    const tag = (t?.tagName || '').toUpperCase();
    return (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable === true);
  }

  function renderCheckpointEditorFULL(draft) {
    if (!elCluesWrap) return;
    clampActiveIndex(draft);

    elCluesWrap.innerHTML = '';

    const count = clampInt(draft?.checkpointCount ?? 1, 1, 20);

    for (let i = 0; i < count; i++) {
      const cp = (draft?.checkpoints && draft.checkpoints[i]) ? draft.checkpoints[i] : {};
      const isLast = i === (count - 1);

      const row = document.createElement('div');
      row.className = 'clueRow';
      row.setAttribute('data-cp-row', String(i));
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', `Välj checkpoint ${i + 1}`);

      row.addEventListener('click', (e) => {
        if (isEditableTarget(e)) return;
        setActiveCp(draft, i, { centerMap: true });
      });

      row.addEventListener('keydown', (e) => {
        if (isEditableTarget(e)) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setActiveCp(draft, i, { centerMap: true });
        }
      });

      if (i === activeCpIndex) row.classList.add('is-active');

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
      clueInput.value = safeText(cp.clue || draft?.clues?.[i] || '');
      clueInput.setAttribute('data-cp-index', String(i));
      clueInput.addEventListener('focus', () => setActiveCp(draft, i, { centerMap: false }));
      clueInput.addEventListener('input', (e) => {
        const k = clampInt(e.target.getAttribute('data-cp-index'), 0, 99);
        if (draft?.checkpoints?.[k]) draft.checkpoints[k].clue = safeText(e.target.value);
        onMarkDirty({ rerenderQR: false, broadcastMap: false });
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
      points.placeholder = `${draft?.pointsPerCheckpoint ?? 10}`;
      points.value = (cp.points === null || cp.points === undefined) ? '' : String(cp.points);
      points.setAttribute('data-cp-points', String(i));
      points.addEventListener('focus', () => setActiveCp(draft, i, { centerMap: false }));
      points.addEventListener('input', (e) => {
        const k = clampInt(e.target.getAttribute('data-cp-points'), 0, 99);
        const v = safeText(e.target.value).trim();
        if (draft?.checkpoints?.[k]) draft.checkpoints[k].points = v === '' ? null : clampInt(v, 0, 1000);
        onMarkDirty({ rerenderQR: false, broadcastMap: false });
      });

      const code = document.createElement('input');
      code.className = 'input';
      code.type = 'text';
      code.autocomplete = 'off';
      code.placeholder = 'ex: HJBH6';
      code.value = safeText(cp.code || '');
      code.setAttribute('data-cp-code', String(i));
      code.addEventListener('focus', () => setActiveCp(draft, i, { centerMap: false }));
      code.addEventListener('input', (e) => {
        const k = clampInt(e.target.getAttribute('data-cp-code'), 0, 99);
        if (draft?.checkpoints?.[k]) draft.checkpoints[k].code = normalizeCode(e.target.value);
        onMarkDirty({ rerenderQR: true, broadcastMap: false });
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
      radius.addEventListener('focus', () => setActiveCp(draft, i, { centerMap: false }));
      radius.addEventListener('input', (e) => {
        const k = clampInt(e.target.getAttribute('data-cp-radius'), 0, 99);
        if (draft?.checkpoints?.[k]) draft.checkpoints[k].radius = clampInt(e.target.value, 5, 5000);
        onMarkDirty({ rerenderQR: false, broadcastMap: false });
      });

      grid.appendChild(labeled('Poäng', points));
      grid.appendChild(labeled('Kod', code));
      grid.appendChild(labeled('Radie (m)', radius));

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
        setActiveCp(draft, k, { centerMap: false });

        const cur = normalizeCode(draft?.checkpoints?.[k]?.code || '');
        if (cur) { showStatus(`CP ${k + 1} har redan en kod.`, 'warn'); return; }

        const used = usedCodesSet();
        const next = generateUniqueCode(used, 5);
        if (draft?.checkpoints?.[k]) draft.checkpoints[k].code = next;

        const input = document.querySelector(`input[data-cp-code="${k}"]`);
        if (input) input.value = next;

        onMarkDirty({ rerenderQR: true, broadcastMap: false });
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
        onSaveNow();
      });

      actionsWrap.appendChild(btnRnd);
      actionsWrap.appendChild(btnSaveCp);

      codeRow.appendChild(codeHint);
      codeRow.appendChild(actionsWrap);

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
        const isLastNow = k === (count - 1);
        if (!isLastNow) return;
        if (draft?.checkpoints?.[k]) draft.checkpoints[k].isFinal = !!e.target.checked;
        enforceFinalOnlyOnLast(draft);
        onMarkDirty({ rerenderQR: false, broadcastMap: false });
        onAfterFinalToggle();
      });

      finalRow.appendChild(finalLeft);
      finalRow.appendChild(finalToggleWrap);

      row.appendChild(meta);
      row.appendChild(clueInput);
      row.appendChild(grid);
      row.appendChild(codeRow);
      row.appendChild(finalRow);

      elCluesWrap.appendChild(row);
    }

    setActiveCp(draft, activeCpIndex, { centerMap: false });
  }

  return {
    // state
    getActiveCpIndex,
    clampActiveIndex,

    // UI actions
    setActiveCp,
    updateCoordText,
    setActiveCpPositionFromMap,

    // render
    renderCheckpointEditorFULL,
  };
}
