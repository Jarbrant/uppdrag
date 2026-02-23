/* ============================================================
   FIL: src/camera.js  (HEL FIL)
   AO 7/15 — Camera module (capture + preview)
   Mål: Kamera/filuppladdning funkar på mobil (input capture)
   Policy: UI-only, fail-closed, XSS-safe (ingen innerHTML), inga storage keys
============================================================ */

/* ============================================================
   BLOCK 1 — Helpers
============================================================ */
function el(tag, className = '', attrs = {}) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (attrs && typeof attrs === 'object') {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null) continue;
      n.setAttribute(k, String(v));
    }
  }
  return n;
}

function setText(node, text) {
  if (!node) return;
  node.textContent = (text ?? '').toString();
}

function isImageFile(file) {
  return !!file && typeof file.type === 'string' && file.type.startsWith('image/');
}

/* ============================================================
   BLOCK 2 — createCamera()
   KRAV:
   - Primärt: <input type="file" accept="image/*" capture="environment">
   - Preview: visa vald bild i UI
   - Fail-closed: validera type/size, annars ingen foto state
============================================================ */
export function createCamera(opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const maxBytes = Number.isFinite(Number(options.maxBytes)) ? Number(options.maxBytes) : 6_000_000; // ~6MB
  const onChange = typeof options.onChange === 'function' ? options.onChange : null;

  let _file = null;          // HOOK: camera-file (in-memory)
  let _previewUrl = '';      // HOOK: camera-preview-url
  let _mounted = false;

  // DOM (created on mount)
  let _root = null;          // HOOK: camera-root
  let _input = null;         // HOOK: camera-input
  let _img = null;           // HOOK: camera-preview-img
  let _meta = null;          // HOOK: camera-meta
  let _clearBtn = null;      // HOOK: camera-clear

  function revokePreview() {
    if (_previewUrl) {
      try { URL.revokeObjectURL(_previewUrl); } catch (_) {}
      _previewUrl = '';
    }
  }

  function clear() {
    _file = null;
    revokePreview();
    if (_input) _input.value = '';
    if (_img) {
      _img.src = '';
      _img.alt = '';
      _img.style.display = 'none';
    }
    if (_meta) setText(_meta, 'Ingen bild vald.');
    if (onChange) {
      try { onChange({ hasPhoto: false, file: null, previewUrl: '' }); } catch (_) {}
    }
  }

  function setFile(file) {
    // Fail-closed: type/size checks
    if (!file || !isImageFile(file)) {
      clear();
      return { ok: false, code: 'NOT_IMAGE' };
    }
    if (file.size > maxBytes) {
      clear();
      return { ok: false, code: 'TOO_LARGE' };
    }

    _file = file;
    revokePreview();
    _previewUrl = URL.createObjectURL(file);

    if (_img) {
      _img.src = _previewUrl;
      _img.alt = 'Förhandsvisning av vald bild';
      _img.style.display = 'block';
    }
    if (_meta) {
      const kb = Math.round(file.size / 1024);
      setText(_meta, `Vald bild: ${file.name || 'foto'} • ${kb} KB`);
    }

    if (onChange) {
      try { onChange({ hasPhoto: true, file: _file, previewUrl: _previewUrl }); } catch (_) {}
    }

    return { ok: true, code: 'OK' };
  }

  function openPicker() {
    if (!_input) return false;
    _input.click();
    return true;
  }

  function mount(container) {
    if (_mounted) return _root;
    if (!container || !(container instanceof Element)) return null;

    _mounted = true;

    _root = el('div', 'cameraBox'); // HOOK: camera-box
    _root.style.display = 'grid';
    _root.style.gap = '8px';
    _root.style.marginTop = '12px';

    const row = el('div', 'cameraRow');
    row.style.display = 'flex';
    row.style.gap = '8px';
    row.style.alignItems = 'center';
    row.style.flexWrap = 'wrap';

    _input = el('input', 'cameraInput', {
      type: 'file',
      accept: 'image/*',
      capture: 'environment' // KRAV: environment camera on mobile
    });
    // HOOK: camera-file-input
    _input.style.position = 'absolute';
    _input.style.left = '-9999px';
    _input.style.width = '1px';
    _input.style.height = '1px';
    _input.style.opacity = '0';

    const pickBtn = el('button', 'btn btn-ghost', { type: 'button' });
    // HOOK: camera-pick-button
    setText(pickBtn, 'Ta foto / Välj bild');

    _clearBtn = el('button', 'btn btn-ghost', { type: 'button' });
    // HOOK: camera-clear-button
    setText(_clearBtn, 'Rensa');

    row.appendChild(_input);
    row.appendChild(pickBtn);
    row.appendChild(_clearBtn);

    _img = el('img', 'cameraPreview', {});
    // HOOK: camera-preview
    _img.style.width = '100%';
    _img.style.maxWidth = '520px';
    _img.style.borderRadius = '18px';
    _img.style.border = '1px solid rgba(255,255,255,.10)';
    _img.style.boxShadow = '0 10px 28px rgba(0,0,0,.14)';
    _img.style.display = 'none';

    _meta = el('div', 'muted small');
    // HOOK: camera-meta
    setText(_meta, 'Ingen bild vald.');

    _root.appendChild(row);
    _root.appendChild(_img);
    _root.appendChild(_meta);

    // Events (no inline handlers)
    pickBtn.addEventListener('click', (e) => {
      e.preventDefault();
      openPicker();
    });

    _clearBtn.addEventListener('click', (e) => {
      e.preventDefault();
      clear();
    });

    _input.addEventListener('change', () => {
      const f = _input.files && _input.files[0] ? _input.files[0] : null;
      setFile(f);
    });

    container.appendChild(_root);
    return _root;
  }

  function getFile() {
    return _file;
  }

  function hasPhoto() {
    return !!_file;
  }

  function getPreviewUrl() {
    return _previewUrl || '';
  }

  return {
    mount,        // HOOK: camera-mount
    openPicker,   // HOOK: camera-open
    clear,        // HOOK: camera-clear
    getFile,      // HOOK: camera-getFile
    hasPhoto,     // HOOK: camera-hasPhoto
    getPreviewUrl // HOOK: camera-getPreviewUrl
  };
}
