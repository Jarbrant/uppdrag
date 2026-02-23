/* ============================================================
   FIL: src/ui.js  (HEL FIL)
   AO 5/15 — UI helpers (render, dialogs, toasts) — no frameworks
   Policy: UI-only, XSS-safe (DOM API + textContent), fail-soft i render
============================================================ */

/* ============================================================
   BLOCK 1 — Small DOM helpers (XSS-safe)
============================================================ */
function el(tag, className = '', attrs = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (attrs && typeof attrs === 'object') {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null) continue;
      node.setAttribute(k, String(v));
    }
  }
  return node;
}

function setText(node, text) {
  if (!node) return;
  node.textContent = (text ?? '').toString();
}

function safeFocus(node) {
  try { node?.focus?.(); } catch (_) { /* ignore */ }
}

/* ============================================================
   BLOCK 2 — Global UI roots (toast stack + modal portal)
   - Init-guard: skapar bara en gång
   - HOOK: UI roots för senare vyer
============================================================ */
let _uiBooted = false; // HOOK: ui-init-guard
let _toastRoot = null; // HOOK: ui-toast-root
let _modalRoot = null; // HOOK: ui-modal-root
let _activeModal = null; // HOOK: ui-active-modal

function ensureUIRoots() {
  if (_uiBooted) return;
  _uiBooted = true;

  // Toast stack root
  _toastRoot = document.getElementById('toastRoot'); // HOOK: toastRoot (optional existing)
  if (!_toastRoot) {
    _toastRoot = el('div', 'toastStack', { id: 'toastRoot' }); // HOOK: toast-root
    document.body.appendChild(_toastRoot);
  }

  // Modal portal root
  _modalRoot = document.getElementById('modalRoot'); // HOOK: modalRoot (optional existing)
  if (!_modalRoot) {
    _modalRoot = el('div', 'modalPortal', { id: 'modalRoot' }); // HOOK: modal-root
    document.body.appendChild(_modalRoot);
  }
}

/* ============================================================
   BLOCK 3 — renderErrorCard(message, actions[])
   KRAV:
   - renderErrorCard(message, actions[])
   - actions[]: [{ label, onClick, variant, disabled }]
   - Returnerar DOM-element (card)
============================================================ */
export function renderErrorCard(message, actions = []) {
  ensureUIRoots();

  const card = el('section', 'card card--error', { role: 'alert' }); // HOOK: error-card
  const head = el('div', 'card__head');
  const icon = el('div', 'card__icon', { 'aria-hidden': 'true' });
  setText(icon, '⚠️');

  const titleWrap = el('div', 'card__meta');
  const title = el('h2', 'card__title');
  setText(title, 'Något gick fel');
  const desc = el('p', 'card__desc muted');
  setText(desc, message || 'Ett oväntat fel inträffade.');

  titleWrap.appendChild(title);
  titleWrap.appendChild(desc);

  head.appendChild(icon);
  head.appendChild(titleWrap);

  card.appendChild(head);

  const actionsRow = el('div', 'card__actions'); // HOOK: error-actions
  const list = Array.isArray(actions) ? actions : [];
  for (const a of list) {
    const label = (a?.label ?? 'OK').toString();
    const variant = (a?.variant ?? 'primary').toString(); // primary|ghost|danger
    const disabled = !!a?.disabled;

    const btnClass =
      variant === 'ghost' ? 'btn btn-ghost' :
      variant === 'danger' ? 'btn btn-danger' :
      'btn btn-primary';

    const btn = el('button', btnClass, { type: 'button' }); // HOOK: error-action-button
    setText(btn, label);
    btn.disabled = disabled;

    // No inline handlers — addEventListener
    if (typeof a?.onClick === 'function') {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        try { a.onClick(); } catch (_) { /* fail-soft */ }
      });
    }

    actionsRow.appendChild(btn);
  }

  if (actionsRow.childElementCount > 0) card.appendChild(actionsRow);
  return card;
}

/* ============================================================
   BLOCK 4 — toast(msg, type)
   KRAV:
   - toast(msg, type)
   - type: info|success|warn|danger (default info)
============================================================ */
let _toastSeq = 0; // HOOK: toast-seq

export function toast(msg, type = 'info', opts = {}) {
  ensureUIRoots();

  const t = (type || 'info').toString().toLowerCase();
  const cssType =
    t === 'success' ? 'toast--success' :
    t === 'warn' ? 'toast--warn' :
    t === 'danger' ? 'toast--danger' :
    'toast--info';

  const id = `toast_${++_toastSeq}`; // HOOK: toast-id
  const ttl = Number.isFinite(Number(opts.ttlMs)) ? Number(opts.ttlMs) : 3200;

  const item = el('div', `toast ${cssType}`, { role: 'status', 'aria-live': 'polite', 'data-toast-id': id });
  const row = el('div', 'toast__row');
  const text = el('div', 'toast__text');
  setText(text, msg || '');

  const closeBtn = el('button', 'toast__close btn btn-ghost', { type: 'button', 'aria-label': 'Stäng' }); // HOOK: toast-close
  setText(closeBtn, '✕');

  row.appendChild(text);
  row.appendChild(closeBtn);
  item.appendChild(row);

  const remove = () => {
    if (!item.isConnected) return;
    item.classList.add('toast--hide');
    window.setTimeout(() => item.remove(), 160);
  };

  closeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    remove();
  });

  _toastRoot.appendChild(item);

  if (ttl > 0) window.setTimeout(remove, ttl);
  return { id, remove };
}

/* ============================================================
   BLOCK 5 — modal({title, body, primary, secondary})
   KRAV:
   - modal({title, body, primary, secondary})
   - Escape + overlay-click stänger
   - Fail-soft: om modal redan öppen, ersätt den deterministiskt
   - Returnerar { close, update }
============================================================ */
export function modal(config = {}) {
  ensureUIRoots();

  // Stäng eventuell aktiv modal (deterministiskt)
  if (_activeModal?.close) {
    try { _activeModal.close({ reason: 'REPLACED' }); } catch (_) {}
  }

  const titleText = (config?.title ?? '').toString();
  const body = config?.body; // string | Node
  const primary = config?.primary || null;     // { label, onClick, variant }
  const secondary = config?.secondary || null; // { label, onClick, variant }

  const overlay = el('div', 'modalOverlay', { role: 'presentation' }); // HOOK: modal-overlay
  const dialog = el('div', 'modal', { role: 'dialog', 'aria-modal': 'true' }); // HOOK: modal-dialog
  const header = el('div', 'modal__header');
  const h = el('h2', 'modal__title');
  setText(h, titleText || 'Dialog');

  const xBtn = el('button', 'btn btn-ghost modal__close', { type: 'button', 'aria-label': 'Stäng dialog' }); // HOOK: modal-close
  setText(xBtn, '✕');

  header.appendChild(h);
  header.appendChild(xBtn);

  const content = el('div', 'modal__body'); // HOOK: modal-body
  if (body instanceof Node) {
    content.appendChild(body);
  } else {
    const p = el('p', 'muted');
    setText(p, (body ?? '').toString());
    content.appendChild(p);
  }

  const footer = el('div', 'modal__footer'); // HOOK: modal-footer

  function mkActionButton(action, fallbackLabel, fallbackVariant) {
    if (!action) return null;

    const label = (action?.label ?? fallbackLabel).toString();
    const variant = (action?.variant ?? fallbackVariant).toString(); // primary|ghost|danger

    const btnClass =
      variant === 'ghost' ? 'btn btn-ghost' :
      variant === 'danger' ? 'btn btn-danger' :
      'btn btn-primary';

    const b = el('button', btnClass, { type: 'button' }); // HOOK: modal-action
    setText(b, label);

    b.addEventListener('click', (e) => {
      e.preventDefault();
      try {
        const res = typeof action?.onClick === 'function' ? action.onClick() : null;
        // Om handlern returnerar false => stäng inte
        if (res === false) return;
      } catch (_) {
        // Fail-soft: visa toast istället för crash
        toast('Kunde inte utföra åtgärden.', 'danger');
      }
      close({ reason: 'ACTION' });
    });

    return b;
  }

  // Secondary först, sen primary (vanlig dialoglayout)
  const secBtn = mkActionButton(secondary, 'Avbryt', 'ghost');
  const priBtn = mkActionButton(primary, 'OK', 'primary');

  if (secBtn) footer.appendChild(secBtn);
  if (priBtn) footer.appendChild(priBtn);

  dialog.appendChild(header);
  dialog.appendChild(content);
  dialog.appendChild(footer);

  overlay.appendChild(dialog);
  _modalRoot.appendChild(overlay);

  // Focus management
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  // Close behavior
  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close({ reason: 'ESC' });
    }
  }

  function onOverlayClick(e) {
    // overlay-click stänger (men inte klick inne i dialog)
    if (e.target === overlay) {
      close({ reason: 'OVERLAY' });
    }
  }

  document.addEventListener('keydown', onKeyDown, true);
  overlay.addEventListener('click', onOverlayClick, { passive: true });
  xBtn.addEventListener('click', (e) => {
    e.preventDefault();
    close({ reason: 'X' });
  });

  // Förhindra att modalen "låser sidan": stängning är alltid möjlig
  function close({ reason = 'CLOSE' } = {}) {
    if (!overlay.isConnected) return;

    document.removeEventListener('keydown', onKeyDown, true);
    overlay.removeEventListener('click', onOverlayClick);

    overlay.classList.add('modalOverlay--hide');
    window.setTimeout(() => overlay.remove(), 160);

    // Restore focus
    if (previouslyFocused) safeFocus(previouslyFocused);

    _activeModal = null;
    return reason;
  }

  function update(next = {}) {
    if (typeof next?.title === 'string') setText(h, next.title);
    if (next?.body !== undefined) {
      content.innerHTML = ''; // safe: we are not injecting HTML, we rebuild nodes
      if (next.body instanceof Node) {
        content.appendChild(next.body);
      } else {
        const p = el('p', 'muted');
        setText(p, (next.body ?? '').toString());
        content.appendChild(p);
      }
    }
  }

  // Initial focus: primary om finns, annars close
  window.setTimeout(() => safeFocus(priBtn || xBtn), 0);

  _activeModal = { close, update }; // HOOK: active-modal
  return _activeModal;
}
