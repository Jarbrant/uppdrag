/* ============================================================
   FIL: src/admin-library.js  (HEL FIL)
   AO 1/5 — Split admin.js: Library (PARTY_LIBRARY_V1)
   Policy: UI-only, XSS-safe, fail-closed, inga nya storage keys
============================================================ */

const LIB_KEY = 'PARTY_LIBRARY_V1'; // HOOK: library-storage-key (stabil)

function safeJSONParse(str, fallback = null) {
  try { return JSON.parse(str); } catch (_) { return fallback; }
}

/**
 * Read library list
 * Returns: { ok:true, list:[] } or { ok:false, list:[], reason:'read-fail' }
 */
export function readLibrary() {
  try {
    const raw = localStorage.getItem(LIB_KEY);
    if (!raw) return { ok: true, list: [] };
    const v = safeJSONParse(raw, []);
    if (!Array.isArray(v)) return { ok: true, list: [] };
    const list = v.filter((x) => x && typeof x === 'object' && typeof x.id === 'string');
    return { ok: true, list };
  } catch (_) {
    return { ok: false, list: [], reason: 'read-fail' };
  }
}

/**
 * Write library list
 * Returns: { ok:true } or { ok:false, reason:'write-fail' }
 */
export function writeLibrary(list) {
  try {
    const payload = JSON.stringify(Array.isArray(list) ? list : []);
    localStorage.setItem(LIB_KEY, payload);
    return { ok: true };
  } catch (_) {
    return { ok: false, reason: 'write-fail' };
  }
}

/**
 * Find entry by id
 * Returns: { ok:true, entry:null|object } or { ok:false, entry:null, reason:'read-fail' }
 */
export function findLibraryEntry(id) {
  const rid = String(id || '').trim();
  if (!rid) return { ok: true, entry: null };

  const res = readLibrary();
  if (!res.ok) return { ok: false, entry: null, reason: res.reason };

  const entry = res.list.find((x) => x && String(x.id) === rid) || null;
  return { ok: true, entry };
}

/**
 * Upsert entry (max 200)
 * Returns: { ok:true } or { ok:false, reason:'read-fail'|'write-fail' }
 */
export function upsertLibraryEntry(entry) {
  const res = readLibrary();
  if (!res.ok) return { ok: false, reason: res.reason };

  const next = Array.isArray(res.list) ? res.list.slice(0, 200) : [];
  const id = String(entry?.id || '').trim();
  if (!id) return { ok: false, reason: 'bad-entry' };

  const idx = next.findIndex((x) => x && String(x.id) === id);
  if (idx >= 0) next[idx] = entry;
  else next.unshift(entry);

  return writeLibrary(next);
}

/**
 * Delete entry by id
 * Returns: { ok:true, changed:true|false } or { ok:false, changed:false, reason:'read-fail'|'write-fail' }
 */
export function deleteLibraryEntry(id) {
  const rid = String(id || '').trim();
  if (!rid) return { ok: true, changed: false };

  const res = readLibrary();
  if (!res.ok) return { ok: false, changed: false, reason: res.reason };

  const before = res.list.length;
  const next = res.list.filter((x) => x && String(x.id) !== rid);
  const after = next.length;

  const wrote = writeLibrary(next);
  if (!wrote.ok) return { ok: false, changed: false, reason: wrote.reason };

  return { ok: true, changed: before !== after };
}
