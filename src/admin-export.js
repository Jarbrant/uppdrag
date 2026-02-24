/* ============================================================
   FIL: src/admin-export.js  (HEL FIL)
   AO 2/5 — Split admin.js: Export + QR (UI-only)
   Policy: XSS-safe, fail-closed, inga nya storage keys
============================================================ */

export function initAdminExport(api) {
  const {
    getDraft,                 // () => draft
    clampInt,                 // (n,min,max) => int
    normalizeCode,            // (s) => normalized code
    getDraftJSON,             // ({pretty}) => json string
    hasBlockingErrors,        // () => boolean
    copyToClipboard,          // (text) => Promise<{ok:boolean}>
    showStatus,               // (msg,type) => void
    setPillState,             // (kind) => void
    scheduleSave,             // () => void
    renderAllFULL,            // (opts) => void
    onFillRandomCodes,        // () => number changed (muterar draft i admin.js)
    onPublishToLibrary,       // () => void
  } = api || {};

  const MAX_INLINE_QS_CHARS = 1400;

  // DOM hooks (finns i admin.html)
  const elQrSlot = document.getElementById('qrSlot');
  const elQrError = document.getElementById('qrError');
  const elPreviewList = document.getElementById('previewList');

  let qrTimer = null;

  // Export panel DOM
  let elExportRoot = null;
  let elExportMsg = null;
  let elExportLink = null;
  let elExportJSON = null;

  function setExportMessage(msg, type = 'info') {
    if (!elExportMsg) return;
    elExportMsg.textContent = msg || '';
    elExportMsg.style.color =
      type === 'danger' ? 'rgba(251,113,133,.95)' :
      type === 'warn' ? 'rgba(251,191,36,.95)' :
      'rgba(255,255,255,.85)';
  }

  function selectAll(el) {
    if (!el) return;
    try {
      el.focus();
      if (typeof el.select === 'function') el.select();
      if (typeof el.setSelectionRange === 'function') el.setSelectionRange(0, String(el.value || '').length);
    } catch (_) {}
  }

  function buildParticipantLinkOrFail() {
    const payloadJSON = getDraftJSON({ pretty: false });
    const encodedLen = encodeURIComponent(payloadJSON).length;

    if (encodedLen > MAX_INLINE_QS_CHARS) {
      return { ok: false, reason: 'too-large', encodedLength: encodedLen };
    }

    // admin ligger under /pages/ → party.html ligger också under /pages/
    const url = new URL('party.html', window.location.href);
    url.searchParams.set('mode', 'party');
    // Viktigt: sätt rå JSON, URLSearchParams kodar EN gång
    url.searchParams.set('payload', payloadJSON);

    return { ok: true, url: url.toString() };
  }

  async function onCopyJSON() {
    ensureExportPanel();

    const json = getDraftJSON({ pretty: true });
    if (elExportJSON) elExportJSON.value = json;

    if (hasBlockingErrors()) {
      setExportMessage('Rätta felen i formuläret innan du exporterar.', 'warn');
      selectAll(elExportJSON);
      return;
    }

    const res = await copyToClipboard(json);
    if (res && res.ok) { setExportMessage('JSON kopierat.', 'info'); return; }

    setExportMessage('Kopiering nekades. Markera JSON-rutan och kopiera manuellt (Ctrl/Cmd+C).', 'warn');
    selectAll(elExportJSON);
  }

  async function onCopyLink() {
    ensureExportPanel();

    if (hasBlockingErrors()) { setExportMessage('Rätta felen i formuläret innan du kopierar länk.', 'warn'); return; }

    const built = buildParticipantLinkOrFail();
    if (!built.ok) {
      setExportMessage('Payload för stor att dela som länk. Använd KOPIERA JSON istället.', 'danger');
      if (elExportLink) elExportLink.value = '';
      selectAll(elExportJSON);
      return;
    }

    if (elExportLink) elExportLink.value = built.url;

    const res = await copyToClipboard(built.url);
    if (res && res.ok) { setExportMessage('Länk kopierad (startar deltagarvyn).', 'info'); return; }

    setExportMessage('Kopiering nekades. Markera länken och kopiera manuellt.', 'warn');
    selectAll(elExportLink);
  }

  function onFillCodesClick() {
    const changed = onFillRandomCodes();
    if (changed <= 0) { setExportMessage('Inga tomma koder att fylla (alla har redan kod).', 'info'); return; }

    setPillState('dirty');
    scheduleSave();
    renderAllFULL({ broadcastMap: false, rerenderQR: true });
    setExportMessage(`Fyllde ${changed} slumpkod${changed === 1 ? '' : 'er'} (endast tomma).`, 'info');
  }

  function ensureExportPanel() {
    if (elExportRoot) return;

    const previewCard = elPreviewList?.closest?.('.card') || null;
    const mount = previewCard || document.querySelector('.container') || document.body;

    const card = document.createElement('section');
    card.className = 'card';
    card.setAttribute('aria-label', 'Export');

    const head = document.createElement('div');
    head.className = 'card__head';

    const meta = document.createElement('div');
    meta.className = 'card__meta';

    const h = document.createElement('h2');
    h.className = 'h2';
    h.style.margin = '0';
    h.textContent = 'Export';

    const p = document.createElement('p');
    p.className = 'muted small';
    p.style.margin = '6px 0 0 0';
    p.textContent = 'Kopiera JSON eller kopiera en länk som startar deltagarvyn. Du kan också publicera som spelkort på startsidan.';

    meta.appendChild(h);
    meta.appendChild(p);
    head.appendChild(meta);

    const body = document.createElement('div');
    body.style.display = 'grid';
    body.style.gap = '10px';
    body.style.padding = '12px 0 0 0';

    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '10px';
    row.style.flexWrap = 'wrap';

    const btnJson = document.createElement('button');
    btnJson.type = 'button';
    btnJson.className = 'btn btn-ghost miniBtn';
    btnJson.textContent = 'KOPIERA JSON';
    btnJson.addEventListener('click', async () => { await onCopyJSON(); });

    const btnLink = document.createElement('button');
    btnLink.type = 'button';
    btnLink.className = 'btn btn-ghost miniBtn';
    btnLink.textContent = 'KOPIERA LÄNK';
    btnLink.addEventListener('click', async () => { await onCopyLink(); });

    const btnFill = document.createElement('button');
    btnFill.type = 'button';
    btnFill.className = 'btn btn-ghost miniBtn';
    btnFill.textContent = 'FYLL SLUMPKODER (tomma)';
    btnFill.addEventListener('click', () => onFillCodesClick());

    const btnPub = document.createElement('button');
    btnPub.type = 'button';
    btnPub.className = 'btn btn-primary miniBtn';
    btnPub.textContent = 'PUBLICERA SOM SPELKORT';
    btnPub.addEventListener('click', () => onPublishToLibrary());

    row.appendChild(btnJson);
    row.appendChild(btnLink);
    row.appendChild(btnFill);
    row.appendChild(btnPub);

    const msg = document.createElement('div');
    msg.className = 'muted small';
    msg.style.minHeight = '18px';
    msg.style.marginTop = '2px';
    elExportMsg = msg;

    const linkBox = document.createElement('div');
    linkBox.style.display = 'grid';
    linkBox.style.gap = '6px';

    const linkLabel = document.createElement('div');
    linkLabel.className = 'muted small';
    linkLabel.textContent = 'Länk (fallback: markera och kopiera manuellt)';

    const linkInput = document.createElement('input');
    linkInput.className = 'input';
    linkInput.type = 'text';
    linkInput.readOnly = true;
    linkInput.value = '';
    linkInput.placeholder = 'Klicka KOPIERA LÄNK för att skapa + kopiera…';
    elExportLink = linkInput;

    linkBox.appendChild(linkLabel);
    linkBox.appendChild(linkInput);

    const jsonBox = document.createElement('div');
    jsonBox.style.display = 'grid';
    jsonBox.style.gap = '6px';

    const jsonLabel = document.createElement('div');
    jsonLabel.className = 'muted small';
    jsonLabel.textContent = 'JSON (fallback om kopiering nekas: markera och kopiera manuellt)';

    const ta = document.createElement('textarea');
    ta.className = 'input';
    ta.style.minHeight = '120px';
    ta.value = '';
    ta.readOnly = true;
    elExportJSON = ta;

    jsonBox.appendChild(jsonLabel);
    jsonBox.appendChild(ta);

    body.appendChild(row);
    body.appendChild(msg);
    body.appendChild(linkBox);
    body.appendChild(jsonBox);

    card.appendChild(head);
    card.appendChild(body);

    if (previewCard && previewCard.parentNode) previewCard.parentNode.insertBefore(card, previewCard.nextSibling);
    else mount.appendChild(card);

    elExportRoot = card;

    // Förifyll JSON vid första mount
    try { if (elExportJSON) elExportJSON.value = getDraftJSON({ pretty: true }); } catch (_) {}
  }

  // ===== QR per checkpoint =====
  function setQrError(msg) {
    if (!elQrError) return;
    elQrError.textContent = msg || '';
  }

  function clearQr() {
    if (elQrSlot) elQrSlot.innerHTML = '';
    setQrError('');
  }

  function qrImgUrlFor(text) {
    const size = 200;
    const enc = encodeURIComponent(text);
    return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${enc}`;
  }

  async function copyTextOrSelect(inputEl, text) {
    const res = await copyToClipboard(text);
    if (res && res.ok) { showStatus('Kopierat.', 'info'); return true; }
    if (inputEl) {
      try { inputEl.focus(); inputEl.select(); inputEl.setSelectionRange(0, inputEl.value.length); } catch (_) {}
    }
    showStatus('Kopiering nekades. Markera texten och kopiera manuellt.', 'warn');
    return false;
  }

  function renderQRPanelDebounced() {
    if (!elQrSlot) return;
    if (qrTimer) clearTimeout(qrTimer);
    qrTimer = setTimeout(() => renderQRPanel(), 180);
  }

  function renderQRPanel() {
    if (!elQrSlot) return;
    clearQr();

    if (hasBlockingErrors()) { setQrError('QR kräver att formuläret är utan fel. Rätta felen först.'); return; }

    const built = buildParticipantLinkOrFail();
    if (!built.ok) { setQrError('Payload för stor att dela som länk. Använd KOPIERA JSON istället.'); return; }

    const baseUrl = new URL(built.url);

    const d = getDraft();
    const count = clampInt(d?.checkpointCount ?? 0, 1, 20);

    for (let i = 0; i < count; i++) {
      const cp = (d?.checkpoints && d.checkpoints[i]) ? d.checkpoints[i] : {};
      const cpNo = i + 1;

      const u = new URL(baseUrl.toString());
      u.searchParams.set('cp', String(cpNo));
      const code = normalizeCode(cp?.code || '');
      if (code) u.searchParams.set('code', code);

      const link = u.toString();

      const row = document.createElement('div');
      row.className = 'qrRow';

      const top = document.createElement('div');
      top.className = 'qrRowTop';

      const title = document.createElement('div');
      title.className = 'qrTitle';
      const isFinal = (i === count - 1 && cp?.isFinal === true);
      title.textContent = `CP ${cpNo}${isFinal ? ' (Skattkista)' : ''}`;

      const actions = document.createElement('div');
      actions.className = 'qrActions';

      const btnCopy = document.createElement('button');
      btnCopy.type = 'button';
      btnCopy.className = 'btn btn-ghost miniBtn';
      btnCopy.textContent = 'Kopiera länk';

      const btnToggle = document.createElement('button');
      btnToggle.type = 'button';
      btnToggle.className = 'btn btn-ghost miniBtn';
      btnToggle.textContent = 'Visa QR';

      top.appendChild(title);
      top.appendChild(actions);
      actions.appendChild(btnCopy);
      actions.appendChild(btnToggle);

      const input = document.createElement('input');
      input.className = 'input';
      input.type = 'text';
      input.readOnly = true;
      input.value = link;

      const img = document.createElement('img');
      img.className = 'qrImg';
      img.alt = `QR för CP ${cpNo}`;
      img.loading = 'lazy';

      btnCopy.addEventListener('click', async (ev) => { ev.preventDefault(); await copyTextOrSelect(input, link); });
      btnToggle.addEventListener('click', (ev) => {
        ev.preventDefault();
        const showing = img.style.display === 'block';
        if (showing) { img.style.display = 'none'; btnToggle.textContent = 'Visa QR'; return; }
        if (!img.src) img.src = qrImgUrlFor(link);
        img.style.display = 'block';
        btnToggle.textContent = 'Dölj QR';
      });

      row.appendChild(top);
      row.appendChild(input);
      row.appendChild(img);

      elQrSlot.appendChild(row);
    }
  }

  return {
    ensureExportPanel,
    renderQRPanelDebounced,
    setExportMessage,
  };
}
