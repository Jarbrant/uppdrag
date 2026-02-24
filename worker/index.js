/* ============================================================
 * FIL: worker/index.js (HEL FIL)
 * AO 1/6 — Worker + D1: Partners + Invites + Rewards + pick3
 *
 * Bindings (env):
 *   - DB (D1 binding)
 *   - ADMIN_KEY (secret)
 *   - PIN_SALT (secret, för pinHash)
 *   - CORS_ORIGINS (comma-separated origins, fail-closed)
 *
 * Endpoints:
 *   Admin (X-ADMIN-KEY):
 *     POST /admin/partners/create
 *     POST /admin/partners/invite
 *
 *   Partner invite flow:
 *     POST /partners/set-pin      { inviteToken, pin }
 *
 *   Partner rewards (auth via partnerId+pin):
 *     POST /rewards/create
 *     POST /rewards/update
 *     GET  /rewards/list?partnerId=...&pin=...
 *
 *   Game:
 *     GET  /rewards/pick3?tier=cp|final&partnerPool=csv(optional)&seed=string(optional)
 *
 * Policy:
 *   - Fail-closed: validera input, 400/403/404
 *   - CORS: endast origins i CORS_ORIGINS, annars 403 (fail-closed)
 *   - Inga persondata
 * ============================================================ */

/* ============================================================
 * BLOCK 1 — Small utils
 * ============================================================ */
const enc = new TextEncoder();

function nowMs() {
  return Date.now();
}

function asText(v) {
  return (v ?? '').toString().trim();
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function intOrNaN(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : NaN;
}

function clampInt(v, min, max) {
  const n = intOrNaN(v);
  if (!Number.isFinite(n)) return NaN;
  return Math.max(min, Math.min(max, n));
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...headers
    }
  });
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

/* ============================================================
 * BLOCK 2 — CORS (fail-closed)
 * ============================================================ */
function parseOrigins(env) {
  const raw = asText(env.CORS_ORIGINS);
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function corsHeadersFor(req, allowed) {
  const origin = req.headers.get('origin');
  // curl/postman utan origin: OK
  if (!origin) {
    return {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type,x-admin-key',
      'access-control-max-age': '86400',
      'access-control-allow-credentials': 'false'
    };
  }
  if (!allowed.includes(origin)) return null;

  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-admin-key',
    'access-control-max-age': '86400',
    'access-control-allow-credentials': 'false'
  };
}

/* ============================================================
 * BLOCK 3 — Crypto: SHA-256 hex + PIN hash
 * ============================================================ */
async function sha256Hex(str) {
  const buf = enc.encode((str ?? '').toString());
  const hash = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(hash);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

async function pinHash(pin, env) {
  const salt = asText(env.PIN_SALT);
  return sha256Hex(`${salt}::${asText(pin)}`);
}

function safeUuid() {
  return crypto.randomUUID();
}

/* ============================================================
 * BLOCK 4 — Deterministic pick helper (seed optional)
 * ============================================================ */
function seedToUint32(seedStr) {
  const s = (seedStr ?? '').toString();
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) + s.charCodeAt(i);
    h >>>= 0;
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = (seed >>> 0);
  return function rng() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick3Unique(rows, rngFn) {
  const arr = Array.isArray(rows) ? rows.slice() : [];
  if (arr.length < 3) return [];

  // Shuffle (Fisher-Yates)
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rngFn() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }

  const picks = [];
  const seen = new Set();
  for (let i = 0; i < arr.length; i++) {
    const id = asText(arr[i]?.rewardId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    picks.push(arr[i]);
    if (picks.length === 3) break;
  }
  return picks;
}

/* ============================================================
 * BLOCK 5 — Auth helpers
 * ============================================================ */
function requireAdmin(req, env) {
  const adminKey = asText(env.ADMIN_KEY);
  const headerKey = asText(req.headers.get('x-admin-key'));
  if (!adminKey || headerKey !== adminKey) return false;
  return true;
}

async function verifyPartnerPin(partnerId, pin, env) {
  const expected = await env.DB
    .prepare('SELECT pinHash, isActive FROM partners WHERE partnerId = ?')
    .bind(partnerId)
    .first();

  if (!expected) return { ok: false, code: 'not_found' };
  if (Number(expected.isActive) !== 1) return { ok: false, code: 'forbidden' };

  const stored = asText(expected.pinHash);
  if (!stored) return { ok: false, code: 'forbidden' };

  const actual = await pinHash(pin, env);
  if (actual !== stored) return { ok: false, code: 'forbidden' };

  return { ok: true };
}

/* ============================================================
 * BLOCK 6 — Endpoint handlers
 * ============================================================ */
async function adminCreatePartner(req, env) {
  const parsed = await readJson(req);
  if (!parsed.ok || !isPlainObject(parsed.value)) return { status: 400, body: { ok: false, error: 'bad_request' } };

  const partnerId = asText(parsed.value.partnerId);
  const name = asText(parsed.value.name);

  if (!partnerId || partnerId.length > 80) return { status: 400, body: { ok: false, error: 'bad_request' } };
  if (!name || name.length > 120) return { status: 400, body: { ok: false, error: 'bad_request' } };

  const createdAt = nowMs();

  // Fail-closed: insert, men om redan finns -> 400
  try {
    await env.DB
      .prepare('INSERT INTO partners (partnerId, name, pinHash, isActive, createdAt) VALUES (?, ?, NULL, 1, ?)')
      .bind(partnerId, name, createdAt)
      .run();
  } catch (_) {
    return { status: 400, body: { ok: false, error: 'bad_request' } };
  }

  return { status: 200, body: { ok: true } };
}

async function adminInvitePartner(req, env) {
  const parsed = await readJson(req);
  if (!parsed.ok || !isPlainObject(parsed.value)) return { status: 400, body: { ok: false, error: 'bad_request' } };

  const partnerId = asText(parsed.value.partnerId);
  const ttlMinutes = clampInt(parsed.value.ttlMinutes, 1, 60 * 24 * 30);

  if (!partnerId || !Number.isFinite(ttlMinutes)) return { status: 400, body: { ok: false, error: 'bad_request' } };

  // Partner must exist
  const p = await env.DB
    .prepare('SELECT partnerId FROM partners WHERE partnerId = ?')
    .bind(partnerId)
    .first();

  if (!p) return { status: 404, body: { ok: false, error: 'not_found' } };

  const createdAt = nowMs();
  const expiresAt = createdAt + ttlMinutes * 60 * 1000;
  const inviteToken = safeUuid();

  await env.DB
    .prepare('INSERT INTO partner_invites (inviteToken, partnerId, expiresAt, usedAt, createdAt) VALUES (?, ?, ?, NULL, ?)')
    .bind(inviteToken, partnerId, expiresAt, createdAt)
    .run();

  return { status: 200, body: { ok: true, inviteToken, expiresAt } };
}

async function partnerSetPin(req, env) {
  const parsed = await readJson(req);
  if (!parsed.ok || !isPlainObject(parsed.value)) return { status: 400, body: { ok: false, error: 'bad_request' } };

  const inviteToken = asText(parsed.value.inviteToken);
  const pin = asText(parsed.value.pin);

  if (!inviteToken || inviteToken.length < 10) return { status: 400, body: { ok: false, error: 'bad_request' } };
  if (!pin || pin.length < 3 || pin.length > 32) return { status: 400, body: { ok: false, error: 'bad_request' } };

  const inv = await env.DB
    .prepare('SELECT inviteToken, partnerId, expiresAt, usedAt FROM partner_invites WHERE inviteToken = ?')
    .bind(inviteToken)
    .first();

  if (!inv) return { status: 404, body: { ok: false, error: 'not_found' } };

  const now = nowMs();
  if (Number(inv.expiresAt) <= now) return { status: 403, body: { ok: false, error: 'forbidden' } };
  if (inv.usedAt !== null && inv.usedAt !== undefined) return { status: 403, body: { ok: false, error: 'forbidden' } };

  const partnerId = asText(inv.partnerId);
  if (!partnerId) return { status: 403, body: { ok: false, error: 'forbidden' } };

  // Update partner pinHash + mark invite usedAt (transaction)
  const h = await pinHash(pin, env);

  const tx = env.DB.batch([
    env.DB.prepare('UPDATE partners SET pinHash = ? WHERE partnerId = ?').bind(h, partnerId),
    env.DB.prepare('UPDATE partner_invites SET usedAt = ? WHERE inviteToken = ?').bind(now, inviteToken)
  ]);

  try {
    await tx;
  } catch (_) {
    return { status: 500, body: { ok: false, error: 'server_error' } };
  }

  return { status: 200, body: { ok: true, partnerId } };
}

function validateRewardType(t) {
  const x = asText(t);
  return x === 'percent' || x === 'freebie' || x === 'bogo' || x === 'custom';
}

function validateTier(t) {
  const x = asText(t);
  return x === 'cp' || x === 'final';
}

async function rewardsCreate(req, env) {
  const parsed = await readJson(req);
  if (!parsed.ok || !isPlainObject(parsed.value)) return { status: 400, body: { ok: false, error: 'bad_request' } };

  const b = parsed.value;
  const partnerId = asText(b.partnerId);
  const pin = asText(b.pin);
  const title = asText(b.title);
  const type = asText(b.type);
  const valueText = asText(b.valueText);
  const stock = clampInt(b.stock, 0, 1_000_000);
  const ttlMinutes = clampInt(b.ttlMinutes, 1, 60 * 24 * 30);
  const tier = asText(b.tier);

  if (!partnerId || !pin) return { status: 400, body: { ok: false, error: 'bad_request' } };
  if (!title || title.length > 140) return { status: 400, body: { ok: false, error: 'bad_request' } };
  if (!validateRewardType(type)) return { status: 400, body: { ok: false, error: 'bad_request' } };
  if (!valueText || valueText.length > 140) return { status: 400, body: { ok: false, error: 'bad_request' } };
  if (!Number.isFinite(stock) || !Number.isFinite(ttlMinutes)) return { status: 400, body: { ok: false, error: 'bad_request' } };
  if (!validateTier(tier)) return { status: 400, body: { ok: false, error: 'bad_request' } };

  const auth = await verifyPartnerPin(partnerId, pin, env);
  if (!auth.ok) return { status: auth.code === 'not_found' ? 404 : 403, body: { ok: false, error: auth.code === 'not_found' ? 'not_found' : 'forbidden' } };

  const rewardId = safeUuid();
  const ts = nowMs();

  await env.DB
    .prepare(`INSERT INTO rewards
      (rewardId, partnerId, title, type, valueText, stock, ttlMinutes, tier, isActive, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
    .bind(rewardId, partnerId, title, type, valueText, stock, ttlMinutes, tier, ts, ts)
    .run();

  return { status: 200, body: { ok: true, rewardId } };
}

async function rewardsUpdate(req, env) {
  const parsed = await readJson(req);
  if (!parsed.ok || !isPlainObject(parsed.value)) return { status: 400, body: { ok: false, error: 'bad_request' } };

  const b = parsed.value;
  const partnerId = asText(b.partnerId);
  const pin = asText(b.pin);
  const rewardId = asText(b.rewardId);

  if (!partnerId || !pin || !rewardId) return { status: 400, body: { ok: false, error: 'bad_request' } };

  const auth = await verifyPartnerPin(partnerId, pin, env);
  if (!auth.ok) return { status: auth.code === 'not_found' ? 404 : 403, body: { ok: false, error: auth.code === 'not_found' ? 'not_found' : 'forbidden' } };

  // Reward must exist and belong to partner
  const existing = await env.DB
    .prepare('SELECT rewardId, partnerId FROM rewards WHERE rewardId = ?')
    .bind(rewardId)
    .first();

  if (!existing) return { status: 404, body: { ok: false, error: 'not_found' } };
  if (asText(existing.partnerId) !== partnerId) return { status: 403, body: { ok: false, error: 'forbidden' } };

  const fields = [];
  const binds = [];

  if (b.title !== undefined) {
    const title = asText(b.title);
    if (!title || title.length > 140) return { status: 400, body: { ok: false, error: 'bad_request' } };
    fields.push('title = ?');
    binds.push(title);
  }
  if (b.valueText !== undefined) {
    const v = asText(b.valueText);
    if (!v || v.length > 140) return { status: 400, body: { ok: false, error: 'bad_request' } };
    fields.push('valueText = ?');
    binds.push(v);
  }
  if (b.stock !== undefined) {
    const s = clampInt(b.stock, 0, 1_000_000);
    if (!Number.isFinite(s)) return { status: 400, body: { ok: false, error: 'bad_request' } };
    fields.push('stock = ?');
    binds.push(s);
  }
  if (b.ttlMinutes !== undefined) {
    const t = clampInt(b.ttlMinutes, 1, 60 * 24 * 30);
    if (!Number.isFinite(t)) return { status: 400, body: { ok: false, error: 'bad_request' } };
    fields.push('ttlMinutes = ?');
    binds.push(t);
  }
  if (b.tier !== undefined) {
    const t = asText(b.tier);
    if (!validateTier(t)) return { status: 400, body: { ok: false, error: 'bad_request' } };
    fields.push('tier = ?');
    binds.push(t);
  }
  if (b.isActive !== undefined) {
    const ia = intOrNaN(b.isActive);
    if (!Number.isFinite(ia) || (ia !== 0 && ia !== 1)) return { status: 400, body: { ok: false, error: 'bad_request' } };
    fields.push('isActive = ?');
    binds.push(ia);
  }

  if (fields.length === 0) return { status: 400, body: { ok: false, error: 'bad_request' } };

  // updatedAt
  fields.push('updatedAt = ?');
  binds.push(nowMs());

  const sql = `UPDATE rewards SET ${fields.join(', ')} WHERE rewardId = ?`;
  binds.push(rewardId);

  await env.DB.prepare(sql).bind(...binds).run();

  return { status: 200, body: { ok: true } };
}

async function rewardsList(req, env, url) {
  const partnerId = asText(url.searchParams.get('partnerId'));
  const pin = asText(url.searchParams.get('pin'));

  if (!partnerId || !pin) return { status: 400, body: { ok: false, error: 'bad_request' } };

  const auth = await verifyPartnerPin(partnerId, pin, env);
  if (!auth.ok) return { status: auth.code === 'not_found' ? 404 : 403, body: { ok: false, error: auth.code === 'not_found' ? 'not_found' : 'forbidden' } };

  const out = await env.DB
    .prepare(`SELECT rewardId, partnerId, title, type, valueText, stock, ttlMinutes, tier, isActive, createdAt, updatedAt
              FROM rewards WHERE partnerId = ? ORDER BY createdAt DESC`)
    .bind(partnerId)
    .all();

  return { status: 200, body: { ok: true, rewards: out.results || [] } };
}

async function rewardsPick3(req, env, url) {
  const tier = asText(url.searchParams.get('tier'));
  if (!validateTier(tier)) return { status: 400, body: { ok: false, error: 'bad_request' } };

  const seed = asText(url.searchParams.get('seed'));
  const pool = asText(url.searchParams.get('partnerPool'));

  let partnerIds = [];
  if (pool) {
    partnerIds = pool.split(',').map((s) => s.trim()).filter(Boolean);
    // fail-closed: för många
    if (partnerIds.length > 50) return { status: 400, body: { ok: false, error: 'bad_request' } };
  }

  // SQL: isActive=1 och stock>0 + tier
  let sql = `
    SELECT r.rewardId, r.partnerId, p.name AS partnerName, r.title, r.type, r.valueText, r.ttlMinutes, r.tier
    FROM rewards r
    JOIN partners p ON p.partnerId = r.partnerId
    WHERE r.isActive = 1 AND r.stock > 0 AND r.tier = ? AND p.isActive = 1
  `;
  const binds = [tier];

  if (partnerIds.length > 0) {
    const placeholders = partnerIds.map(() => '?').join(',');
    sql += ` AND r.partnerId IN (${placeholders})`;
    binds.push(...partnerIds);
  }

  const rows = await env.DB.prepare(sql).bind(...binds).all();
  const all = rows.results || [];

  if (all.length < 3) {
    // fail-closed: om katalogen inte kan ge 3 -> 404 (eller 200 med färre? men KRAV säger alltid 3)
    return { status: 404, body: { ok: false, error: 'not_found' } };
  }

  const rng = seed ? mulberry32(seedToUint32(seed)) : (() => Math.random());
  const picks = pick3Unique(all, rng);

  if (picks.length < 3) return { status: 404, body: { ok: false, error: 'not_found' } };

  return { status: 200, body: { ok: true, picks } };
}

/* ============================================================
 * BLOCK 7 — Router
 * ============================================================ */
function route(req) {
  const url = new URL(req.url);
  const path = (url.pathname || '/').replace(/\/$/, '');
  const method = (req.method || 'GET').toUpperCase();
  return { url, path: path || '/', method };
}

export default {
  async fetch(req, env) {
    const allowed = parseOrigins(env);
    const cors = corsHeadersFor(req, allowed);

    // OPTIONS preflight
    if ((req.method || '').toUpperCase() === 'OPTIONS') {
      if (!cors) return json({ ok: false, error: 'forbidden' }, 403);
      return new Response(null, { status: 204, headers: cors });
    }

    // Fail-closed: browser origin men ej tillåten
    if (!cors) return json({ ok: false, error: 'forbidden' }, 403);

    const { url, path, method } = route(req);

    try {
      // Admin auth
      if (path === '/admin/partners/create' && method === 'POST') {
        if (!requireAdmin(req, env)) return json({ ok: false, error: 'forbidden' }, 403, cors);
        const out = await adminCreatePartner(req, env);
        return json(out.body, out.status, cors);
      }

      if (path === '/admin/partners/invite' && method === 'POST') {
        if (!requireAdmin(req, env)) return json({ ok: false, error: 'forbidden' }, 403, cors);
        const out = await adminInvitePartner(req, env);
        return json(out.body, out.status, cors);
      }

      // Partner invite flow
      if (path === '/partners/set-pin' && method === 'POST') {
        const out = await partnerSetPin(req, env);
        return json(out.body, out.status, cors);
      }

      // Rewards CRUD (partnerId+pin)
      if (path === '/rewards/create' && method === 'POST') {
        const out = await rewardsCreate(req, env);
        return json(out.body, out.status, cors);
      }
      if (path === '/rewards/update' && method === 'POST') {
        const out = await rewardsUpdate(req, env);
        return json(out.body, out.status, cors);
      }
      if (path === '/rewards/list' && method === 'GET') {
        const out = await rewardsList(req, env, url);
        return json(out.body, out.status, cors);
      }

      // Game pick3
      if (path === '/rewards/pick3' && method === 'GET') {
        const out = await rewardsPick3(req, env, url);
        return json(out.body, out.status, cors);
      }

      return json({ ok: false, error: 'not_found' }, 404, cors);
    } catch (_) {
      return json({ ok: false, error: 'server_error' }, 500, cors);
    }
  }
};
