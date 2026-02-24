/* ============================================================
 * FIL: worker/index.js (HEL FIL) — AO 2/3 Voucher API + Partner PIN
 *
 * Endpoints:
 *   POST /vouchers/create
 *   GET  /vouchers/:voucherId
 *   POST /vouchers/redeem
 *   POST /partners/set-pin   (admin)
 *
 * KV:
 *   VOUCHERS_KV  key: v:<voucherId>  -> voucher JSON
 *   PARTNERS_KV  key: p:<partnerId>  -> { pinHash, name?, updatedAt }
 *
 * Security:
 *   - PIN lagras hashed (SHA-256) med salt (env PIN_SALT)
 *   - Admin endpoint kräver X-ADMIN-KEY (env ADMIN_KEY)
 *   - CORS allowlist (env ALLOWED_ORIGINS, kommatecken-separerad)
 *
 * Policy:
 *   - Fail-closed på fel input/origin/pin/partner/status/expiry
 *   - Ingen persondata
 * ============================================================ */

/* ============================================================
 * BLOCK 1 — Helpers (Response, JSON, CORS)
 * ============================================================ */
function jsonResponse(body, status = 200, corsHeaders = {}) {
  const h = new Headers({
    'content-type': 'application/json; charset=utf-8',
    ...corsHeaders
  });
  return new Response(JSON.stringify(body), { status, headers: h });
}

function textResponse(text, status = 200, corsHeaders = {}) {
  const h = new Headers({ 'content-type': 'text/plain; charset=utf-8', ...corsHeaders });
  return new Response(text, { status, headers: h });
}

async function readJson(req) {
  try {
    const ct = (req.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('application/json')) return { ok: false, value: null };
    const data = await req.json();
    return { ok: true, value: data };
  } catch (_) {
    return { ok: false, value: null };
  }
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function asText(v) {
  return (v ?? '').toString().trim();
}

function asInt(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : NaN;
}

function nowMs() {
  return Date.now();
}

/* ============================================================
 * BLOCK 2 — CORS (fail-closed för okänd origin; curl utan Origin tillåts)
 * env.ALLOWED_ORIGINS = "https://<din-gh-pages>,http://localhost:5173"
 * ============================================================ */
function parseAllowedOrigins(env) {
  const raw = asText(env.ALLOWED_ORIGINS);
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function isOriginAllowed(origin, allowedList) {
  if (!origin) return true; // Ingen Origin (curl/postman) → OK
  return allowedList.includes(origin);
}

function corsHeadersFor(origin, allowedList) {
  // Fail-closed: om origin finns men ej tillåten → inga CORS headers
  if (origin && !isOriginAllowed(origin, allowedList)) return null;

  // För browser: echo origin, annars wildcard för non-browser
  const allowOrigin = origin ? origin : '*';

  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-admin-key',
    'access-control-max-age': '86400',
    // credentials = false (enkelt, säkrare här)
    'access-control-allow-credentials': 'false'
  };
}

/* ============================================================
 * BLOCK 3 — Crypto: SHA-256 hex (PIN hash med salt)
 * ============================================================ */
async function sha256Hex(input) {
  const enc = new TextEncoder();
  const buf = enc.encode(input);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(hash);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

async function hashPin(pin, env) {
  const salt = asText(env.PIN_SALT);
  // Fail-closed: saknas salt → ändå hash (men rekommenderas sättas)
  const base = `${salt}::${asText(pin)}`;
  return sha256Hex(base);
}

/* ============================================================
 * BLOCK 4 — Voucher model & KV helpers
 * ============================================================ */
function voucherKey(voucherId) {
  return `v:${asText(voucherId)}`;
}
function partnerKey(partnerId) {
  return `p:${asText(partnerId)}`;
}

function computeStatus(voucher, now) {
  const v = voucher || {};
  const status = asText(v.status);
  const expiresAt = Number(v.expiresAt);

  if (status === 'redeemed') return 'redeemed';
  if (!Number.isFinite(expiresAt)) return 'expired';
  if (now > expiresAt) return 'expired';
  return 'valid';
}

function sanitizeVoucherOut(voucher) {
  const v = voucher || {};
  return {
    voucherId: asText(v.voucherId),
    partnerId: asText(v.partnerId),
    rewardId: asText(v.rewardId),
    status: asText(v.status),
    expiresAt: Number(v.expiresAt),
    createdAt: Number(v.createdAt)
  };
}

/* ============================================================
 * BLOCK 5 — Routing
 * ============================================================ */
function route(req) {
  const url = new URL(req.url);
  const path = url.pathname || '/';
  const method = (req.method || 'GET').toUpperCase();

  // Normalize (inga trailing slashes för enkelhet)
  const p = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;

  return { method, path: p, url };
}

/* ============================================================
 * BLOCK 6 — Handlers
 * ============================================================ */
async function handleCreateVoucher(req, env) {
  const parsed = await readJson(req);
  if (!parsed.ok || !isPlainObject(parsed.value)) {
    return { res: { ok: false, error: 'bad_request' }, status: 400 };
  }

  const body = parsed.value;

  const gameId = asText(body.gameId);
  const checkpointIndex = asInt(body.checkpointIndex);
  const partnerId = asText(body.partnerId);
  const rewardId = asText(body.rewardId);
  const ttlMinutes = asInt(body.ttlMinutes);

  // Fail-closed validation
  if (!gameId || gameId.length > 120) return { res: { ok: false, error: 'bad_request' }, status: 400 };
  if (!Number.isFinite(checkpointIndex) || checkpointIndex < 0 || checkpointIndex > 999) return { res: { ok: false, error: 'bad_request' }, status: 400 };
  if (!partnerId || partnerId.length > 80) return { res: { ok: false, error: 'bad_request' }, status: 400 };
  if (!rewardId || rewardId.length > 80) return { res: { ok: false, error: 'bad_request' }, status: 400 };
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0 || ttlMinutes > 60 * 24 * 30) return { res: { ok: false, error: 'bad_request' }, status: 400 };

  const createdAt = nowMs();
  const expiresAt = createdAt + ttlMinutes * 60 * 1000;

  const voucherId = crypto.randomUUID();

  const voucher = {
    voucherId,
    gameId,
    checkpointIndex,
    partnerId,
    rewardId,
    status: 'valid',
    createdAt,
    expiresAt,
    redeemedAt: null
  };

  await env.VOUCHERS_KV.put(voucherKey(voucherId), JSON.stringify(voucher));

  return {
    res: {
      ok: true,
      voucherId,
      expiresAt,
      status: 'valid'
    },
    status: 200
  };
}

async function handleGetVoucher(req, env, voucherId) {
  const vid = asText(voucherId);
  if (!vid) return { res: { ok: false, error: 'bad_request' }, status: 400 };

  const raw = await env.VOUCHERS_KV.get(voucherKey(vid));
  if (!raw) {
    // Fail-closed: ok=false (men 404 är rimligt)
    return { res: { ok: false, error: 'not_found' }, status: 404 };
  }

  let voucher = null;
  try {
    voucher = JSON.parse(raw);
  } catch (_) {
    return { res: { ok: false, error: 'corrupt' }, status: 500 };
  }

  const now = nowMs();
  const computed = computeStatus(voucher, now);

  // Om status behöver uppdateras (expired) → spara
  if (computed !== asText(voucher.status)) {
    voucher.status = computed;
    await env.VOUCHERS_KV.put(voucherKey(vid), JSON.stringify(voucher));
  }

  return {
    res: {
      ok: true,
      voucher: sanitizeVoucherOut(voucher)
    },
    status: 200
  };
}

async function handleRedeemVoucher(req, env) {
  const parsed = await readJson(req);
  if (!parsed.ok || !isPlainObject(parsed.value)) {
    return { res: { ok: false, error: 'bad_request' }, status: 400 };
  }

  const body = parsed.value;

  const voucherId = asText(body.voucherId);
  const partnerId = asText(body.partnerId);
  const pin = asText(body.pin);

  if (!voucherId || !partnerId || !pin) return { res: { ok: false, error: 'bad_request' }, status: 400 };
  if (pin.length > 32) return { res: { ok: false, error: 'bad_request' }, status: 400 };

  // Läs voucher
  const rawV = await env.VOUCHERS_KV.get(voucherKey(voucherId));
  if (!rawV) return { res: { ok: false, error: 'not_found' }, status: 404 };

  let voucher = null;
  try { voucher = JSON.parse(rawV); } catch (_) {
    return { res: { ok: false, error: 'corrupt' }, status: 500 };
  }

  // Partner match
  if (asText(voucher.partnerId) !== partnerId) {
    return { res: { ok: false, error: 'forbidden' }, status: 403 };
  }

  // Status/expiry check (fail-closed)
  const now = nowMs();
  const computed = computeStatus(voucher, now);

  if (computed === 'redeemed') {
    return { res: { ok: false, error: 'already_redeemed' }, status: 409 };
  }
  if (computed === 'expired') {
    // uppdatera status i KV så GET blir korrekt
    voucher.status = 'expired';
    await env.VOUCHERS_KV.put(voucherKey(voucherId), JSON.stringify(voucher));
    return { res: { ok: false, error: 'expired' }, status: 410 };
  }
  if (computed !== 'valid') {
    return { res: { ok: false, error: 'forbidden' }, status: 403 };
  }

  // Läs partner PIN-hash
  const rawP = await env.PARTNERS_KV.get(partnerKey(partnerId));
  if (!rawP) {
    // Fail-closed: inga partner-credentials = forbidden
    return { res: { ok: false, error: 'forbidden' }, status: 403 };
  }

  let partner = null;
  try { partner = JSON.parse(rawP); } catch (_) {
    return { res: { ok: false, error: 'forbidden' }, status: 403 };
  }

  const expectedHash = asText(partner?.pinHash);
  if (!expectedHash) return { res: { ok: false, error: 'forbidden' }, status: 403 };

  const actualHash = await hashPin(pin, env);
  if (actualHash !== expectedHash) {
    return { res: { ok: false, error: 'forbidden' }, status: 403 };
  }

  // Redeem
  const redeemedAt = now;
  voucher.status = 'redeemed';
  voucher.redeemedAt = redeemedAt;

  await env.VOUCHERS_KV.put(voucherKey(voucherId), JSON.stringify(voucher));

  return {
    res: {
      ok: true,
      status: 'redeemed',
      redeemedAt
    },
    status: 200
  };
}

async function handleSetPartnerPin(req, env) {
  // Admin auth
  const adminKey = asText(env.ADMIN_KEY);
  const headerKey = asText(req.headers.get('x-admin-key'));

  // Fail-closed
  if (!adminKey || headerKey !== adminKey) {
    return { res: { ok: false, error: 'forbidden' }, status: 403 };
  }

  const parsed = await readJson(req);
  if (!parsed.ok || !isPlainObject(parsed.value)) {
    return { res: { ok: false, error: 'bad_request' }, status: 400 };
  }

  const body = parsed.value;
  const partnerId = asText(body.partnerId);
  const pin = asText(body.pin);

  if (!partnerId || partnerId.length > 80) return { res: { ok: false, error: 'bad_request' }, status: 400 };
  if (!pin || pin.length < 3 || pin.length > 32) return { res: { ok: false, error: 'bad_request' }, status: 400 };

  const pinHash = await hashPin(pin, env);
  const record = {
    pinHash,
    updatedAt: nowMs()
  };

  await env.PARTNERS_KV.put(partnerKey(partnerId), JSON.stringify(record));

  return { res: { ok: true }, status: 200 };
}

/* ============================================================
 * BLOCK 7 — Main fetch
 * ============================================================ */
export default {
  async fetch(req, env) {
    const allowedOrigins = parseAllowedOrigins(env);
    const origin = req.headers.get('origin');
    const cors = corsHeadersFor(origin, allowedOrigins);

    // OPTIONS preflight
    if ((req.method || '').toUpperCase() === 'OPTIONS') {
      if (!cors) return textResponse('forbidden', 403);
      return new Response(null, { status: 204, headers: cors });
    }

    // Fail-closed: om origin finns men ej tillåten
    if (!cors) return jsonResponse({ ok: false, error: 'forbidden' }, 403);

    const { method, path } = route(req);

    // Routing
    try {
      // POST /vouchers/create
      if (method === 'POST' && path === '/vouchers/create') {
        const out = await handleCreateVoucher(req, env);
        return jsonResponse(out.res, out.status, cors);
      }

      // GET /vouchers/:voucherId
      if (method === 'GET' && path.startsWith('/vouchers/')) {
        const voucherId = path.split('/')[2] || '';
        const out = await handleGetVoucher(req, env, voucherId);
        return jsonResponse(out.res, out.status, cors);
      }

      // POST /vouchers/redeem
      if (method === 'POST' && path === '/vouchers/redeem') {
        const out = await handleRedeemVoucher(req, env);
        return jsonResponse(out.res, out.status, cors);
      }

      // POST /partners/set-pin (admin)
      if (method === 'POST' && path === '/partners/set-pin') {
        const out = await handleSetPartnerPin(req, env);
        return jsonResponse(out.res, out.status, cors);
      }

      // Default 404
      return jsonResponse({ ok: false, error: 'not_found' }, 404, cors);
    } catch (err) {
      // Fail-closed: inga stacktraces
      return jsonResponse({ ok: false, error: 'server_error' }, 500, cors);
    }
  }
};

/* ============================================================
 * BLOCK 8 — ENV / Bindings (för wrangler.toml)
 *   KV namespaces:
 *     VOUCHERS_KV
 *     PARTNERS_KV
 *   Vars:
 *     ADMIN_KEY
 *     PIN_SALT
 *     ALLOWED_ORIGINS
 * ============================================================ */
