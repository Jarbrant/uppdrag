/* ============================================================
   FIL: src/util.js  (HEL FIL)
   AO 2/15 — Util: safe parse + query helpers + misc
   AO 6/6 (FAS 1.2) — Export helper: copyToClipboard(text) med robust fallback
   AO 3/8 (FAS 1.5) — Export: används av Admin (KOPIERA JSON / KOPIERA LÄNK)
   Policy: UI-only, fail-closed helpers, inga nya storage keys
============================================================ */

/* ============================================================
   BLOCK 1 — safeJSONParse
   - Fail-soft: returnerar fallback vid parse-fel
   - HOOK: används av store/state senare (ingen storage här)
============================================================ */
export function safeJSONParse(input, fallback = null) {
  try {
    if (input === null || input === undefined) return fallback;
    if (typeof input !== 'string') return fallback;
    const s = input.trim();
    if (!s) return fallback;
    return JSON.parse(s);
  } catch (_) {
    return fallback;
  }
}

/* ============================================================
   BLOCK 2 — Querystring helpers
   - qsGet: hämta första förekomsten av en nyckel
   - qsAll: hämta alla förekomster av en nyckel
   - HOOK: boot/router använder dessa (URL → state)
============================================================ */
export function qsGet(key, search = window.location.search) {
  if (!key) return '';
  const usp = new URLSearchParams(search || '');
  const v = usp.get(String(key));
  return (v ?? '').toString().trim();
}

export function qsAll(key, search = window.location.search) {
  if (!key) return [];
  const usp = new URLSearchParams(search || '');
  return usp.getAll(String(key)).map((v) => (v ?? '').toString().trim());
}

/* ============================================================
   BLOCK 3 — clamp
   - Begränsa tal till intervall [min, max]
============================================================ */
export function clamp(n, min, max) {
  const num = Number(n);
  const lo = Number(min);
  const hi = Number(max);
  if (!Number.isFinite(num) || !Number.isFinite(lo) || !Number.isFinite(hi)) return lo;
  if (lo > hi) return hi;
  return Math.min(hi, Math.max(lo, num));
}

/* ============================================================
   BLOCK 4 — nowISO
   - ISO-tid i UTC (för logg/telemetri UI-only)
============================================================ */
export function nowISO() {
  return new Date().toISOString();
}

/* ============================================================
   BLOCK 5 — uid
   - Enkel UID för client-side (ej kryptografisk)
   - HOOK: används för requestId/logg senare
============================================================ */
export function uid(prefix = 'id') {
  const p = (prefix || 'id').toString().replace(/[^a-z0-9_-]/gi, '').slice(0, 16) || 'id';
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 1e9).toString(36);
  return `${p}_${t}_${r}`;
}

/* ============================================================
   BLOCK 6 — copyToClipboard
   - Robust: navigator.clipboard (secure context) → fallback via textarea + execCommand
   - Fail-closed: returnerar { ok:false, reason } vid nekad/blocked
   - OBS: Ingen storage, UI-only helper
============================================================ */
export async function copyToClipboard(text) {
  const value = (text ?? '').toString();

  // 1) Modern clipboard (kräver ofta https + user gesture)
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return { ok: true, method: 'navigator.clipboard' };
    }
  } catch (err) {
    // fallthrough → fallback
  }

  // 2) Fallback: temporary textarea + select + execCommand
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);

    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);

    const ok = document.execCommand && document.execCommand('copy');
    document.body.removeChild(ta);

    if (ok) return { ok: true, method: 'execCommand' };
    return { ok: false, method: 'execCommand', reason: 'copy-denied' };
  } catch (_) {
    return { ok: false, method: 'fallback', reason: 'fallback-failed' };
  }
}
