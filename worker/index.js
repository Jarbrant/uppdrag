/* ============================================================
 * FIL: worker/index.js (HEL FIL)
 * AO-LOGIN-01 (1/2) — Admin login + token (Bearer)
 *
 * Bindings (env):
 *   - DB (D1 binding)
 *   - PIN_SALT (secret, för pinHash)
 *   - CORS_ORIGINS (comma-separated origins, fail-closed)
 *
 * NEW Admin auth (Bearer token):
 *   - ADMIN_USER (t.ex. "anders")
 *   - ADMIN_PASS_HASH (sha256 hex av lösenordet)
 *   - ADMIN_TOKEN_SECRET (hemlig sträng för HMAC-signering)
 *   - ADMIN_TOKEN_TTL_MIN (default 60)
 *
 * Endpoints:
 *   Admin (Bearer):
 *     POST /admin/login                 { username, password } -> { ok:true, adminToken, expiresAt }
 *     POST /admin/partners/create
 *     POST /admin/partners/invite
 *     GET  /admin/partners/list
 *     GET  /admin/partners/:partnerId/rewards
 *     GET  /admin/stats/overview?windowHours=24
 *     GET  /admin/stats/partner/:partnerId?windowHours=24
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
 *   Vouchers (verify kompatibilitet + claim):
 *     POST /vouchers/claim        { gameId, checkpointIndex, rewardId }   // stock-- + voucher create
 *     GET  /vouchers/:voucherId
 *     POST /vouchers/redeem       { voucherId, partnerId, pin }
 *
 * Policy:
 *   - Fail-closed: validera input, 400/403/404/409/410/500
 *   - CORS: endast origins i CORS_ORIGINS, annars 403 (fail-closed)
 *   - Inga persondata (inga pinHash i svar)
 *
 * ÄNDRINGSLOGG (≤8):
 * 1) NY: /admin/login (username+password) -> HMAC-signad token + expiresAt
 * 2) NY: Bearer-verifiering för ALLA /admin/* endpoints (403 om saknas/ogiltig/utgången)
 * 3) CORS: allow-headers inkluderar Authorization
 *
 * TESTÄNDRING:
 * - Hårdkodad admin-login (anders / TestAdmin) för testmiljö
 * ============================================================ */

/* ============================================================
 * BLOCK 1 — Small utils
 * ============================================================ */
const enc = new TextEncoder();

/* ============================================================
 * BLOCK 1.0 — HARD CODED ADMIN (TEST ONLY)
 * ============================================================ */
const HARD_ADMIN_USER = 'anders';
const HARD_ADMIN_PASS = 'TestAdmin';

function nowMs() { return Date.now(); }

function asText(v) { return (v ?? '').toString().trim(); }

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

function intOrNaN(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : NaN;
}

function clampInt(v, min, max) {
  const n = intOrNaN(v);
  if (!Number.isFinite(n)) return NaN;
  return Math.max(min, Math.min(max, n));
}

function rid() {
  try { return crypto.randomUUID(); } catch (_) { return String(Math.random()).slice(2); }
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
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
      'access-control-allow-headers': 'content-type,authorization',
      'access-control-max-age': '86400',
      'access-control-allow-credentials': 'false'
    };
  }
  if (!allowed.includes(origin)) return null;

  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
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
  if (arr.length < 1) return [];

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
 * BLOCK 5 — Admin auth (AO-LOGIN-01): HMAC token
 * ============================================================ */
function b64urlFromBytes(bytes) {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlFromString(str) {
  return b64urlFromBytes(enc.encode((str ?? '').toString()));
}

function b64urlToBytes(b64url) {
  const s = asText(b64url).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacSignBytes(secret, dataStr) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(asText(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(asText(dataStr)));
  return new Uint8Array(sig);
}

async function timingSafeEqualBytes(a, b) {
  const aa = a instanceof Uint8Array ? a : new Uint8Array(a || []);
  const bb = b instanceof Uint8Array ? b : new Uint8Array(b || []);
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= (aa[i] ^ bb[i]);
  return diff === 0;
}

function adminTokenTtlMin(env) {
  const n = clampInt(env.ADMIN_TOKEN_TTL_MIN, 5, 24 * 60);
  return Number.isFinite(n) ? n : 60;
}

async function makeAdminToken(env, username) {
  const secret = asText(env.ADMIN_TOKEN_SECRET);
  if (!secret) return { ok: false, token: '' };

  const iat = nowMs();
  const exp = iat + adminTokenTtlMin(env) * 60 * 1000;

  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { sub: asText(username), iat, exp };

  const p1 = b64urlFromString(JSON.stringify(header));
  const p2 = b64urlFromString(JSON.stringify(payload));
  const signingInput = `${p1}.${p2}`;

  const sigBytes = await hmacSignBytes(secret, signingInput);
  const sig = b64urlFromBytes(sigBytes);

  return { ok: true, token: `${signingInput}.${sig}`, exp };
}

async function verifyAdminToken(env, token) {
  const secret = asText(env.ADMIN_TOKEN_SECRET);
  if (!secret) return { ok: false, code: 'forbidden' };

  const raw = asText(token);
  const parts = raw.split('.');
  if (parts.length !== 3) return { ok: false, code: 'forbidden' };

  const [p1, p2, sig] = parts;
  if (!p1 || !p2 || !sig) return { ok: false, code: 'forbidden' };

  // verify signature
  const signingInput = `${p1}.${p2}`;
  let expectedSigBytes;
  try {
    expectedSigBytes = await hmacSignBytes(secret, signingInput);
  } catch (_) {
    return { ok: false, code: 'forbidden' };
  }

  let gotSigBytes;
  try {
    gotSigBytes = b64urlToBytes(sig);
  } catch (_) {
    return { ok: false, code: 'forbidden' };
  }

  const sigOk = await timingSafeEqualBytes(expectedSigBytes, gotSigBytes);
  if (!sigOk) return { ok: false, code: 'forbidden' };

  // parse payload
  let payload;
  try {
    const payloadJson = new TextDecoder().decode(b64urlToBytes(p2));
    payload = JSON.parse(payloadJson);
  } catch (_) {
    return { ok: false, code: 'forbidden' };
  }

  const sub = asText(payload?.sub);
  const iat = Number(payload?.iat);
  const exp = Number(payload?.exp);

  if (!sub || !Number.isFinite(iat) || !Number.isFinite(exp)) return { ok: false, code: 'forbidden' };
  if (exp <= nowMs()) return { ok: false, code: 'forbidden' };

  // Fail-closed: lås till env.ADMIN_USER (MVP)
  // TEST: tillåt även hårdkodad admin-user
  const envUser = asText(env.ADMIN_USER);
  const okUser = (envUser && sub === envUser) || (sub === HARD_ADMIN_USER);
  if (!okUser) return { ok: false, code: 'forbidden' };

  return { ok: true, sub, iat, exp };
}

function bearerFromAuthHeader(req) {
  const h = asText(req.headers.get('authorization'));
  if (!h) return '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? asText(m[1]) : '';
}

async function requireAdminBearer(req, env) {
  const token = bearerFromAuthHeader(req);
  if (!token) return { ok: false };
  const v = await verifyAdminToken(env, token);
  return v.ok ? { ok: true, sub: v.sub, exp: v.exp } : { ok: false };
}

/* ============================================================
 * BLOCK 5.1 — Admin login (ÄNDRAD: test fallback hardcoded)
 * ============================================================ */
async function adminLogin(req, env) {
  const parsed = await readJson(req);
  if (!parsed.ok || !isPlainObject(parsed.value)) return { status: 400, body: { ok: false, error: 'bad_request' } };

  const username = asText(parsed.value.username);
  const password = asText(parsed.value.password);

  if (!username || !password) return { status: 403, body: { ok: false, error: 'forbidden' } };

  // TEST MODE: hårdkodad admin-login
  if (username === HARD_ADMIN_USER && password === HARD_ADMIN_PASS) {
    const tok = await makeAdminToken(env, username);
    if (!tok.ok || !tok.token) return { status: 500, body: { ok: false, error: 'server_error' } };
    return { status: 200, body: { ok: true, adminToken: tok.token, expiresAt: tok.exp } };
  }

  // PROD MODE: env-secrets (som tidigare)
  const envUser = asText(env.ADMIN_USER);
  const envPassHash = asText(env.ADMIN_PASS_HASH);

  if (!username || !password || !envUser || !envPassHash) return { status: 403, body: { ok: false, error: 'forbidden' } };
  if (username !== envUser) return { status: 403, body: { ok: false, error: 'forbidden' } };

  const ph = await sha256Hex(password);
  if (ph !== envPassHash) return { status: 403, body: { ok: false, error: 'forbidden' } };

  const tok = await makeAdminToken(env, username);
  if (!tok.ok || !tok.token) return { status: 500, body: { ok: false, error: 'server_error' } };

  return { status: 200, body: { ok: true, adminToken: tok.token, expiresAt: tok.exp } };
}

/* ============================================================
 * BLOCK 6 — Partner PIN auth
 * ============================================================ */
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
 * BLOCK 7 — Vouchers table guard (fail-closed)
 * ============================================================ */
async function vouchersTableOk(env) {
  try {
    await env.DB.prepare('SELECT voucherId FROM vouchers LIMIT 1').all();
    return true;
  } catch (_) {
    return false;
  }
}

function dbMissingTableResponse() {
  const requestId = rid();
  return { status: 500, body: { ok: false, error: 'db_missing_table', rid: requestId } };
}

/* ============================================================
 * BLOCK 8 — Endpoint handlers: Admin (POST)
 * ============================================================ */
async function adminCreatePartner(req, env) {
  const parsed = await readJson(req);
  if (!parsed.ok || !isPlainObject(parsed.value)) return { status: 400, body: { ok: false, error: 'bad_request' } };

  const partnerId = asText(parsed.value.partnerId);
  const name = asText(parsed.value.name);

  if (!partnerId || partnerId.length > 80) return { status: 400, body: { ok: false, error: 'bad_request' } };
  if (!name || name.length > 120) return { status: 400, body: { ok: false, error: 'bad_request' } };

  const createdAt = nowMs();

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

/* ============================================================
 * BLOCK 9 — Endpoint handlers: Admin (GET) AO 6/6
 * ============================================================ */
async function adminPartnersList(env) {
  const out = await env.DB
    .prepare(`SELECT partnerId, name, isActive, createdAt,
                     CASE WHEN pinHash IS NULL OR pinHash = '' THEN 0 ELSE 1 END AS hasPin
              FROM partners
              ORDER BY createdAt DESC`)
    .all();

  return { status: 200, body: { ok: true, partners: out.results || [] } };
}

async function adminPartnerRewards(env, partnerId) {
  const pid = asText(partnerId);
  if (!pid || pid.length > 80) return { status: 400, body: { ok: false, error: 'bad_request' } };

  const p = await env.DB.prepare('SELECT partnerId FROM partners WHERE partnerId = ?').bind(pid).first();
  if (!p) return { status: 404, body: { ok: false, error: 'not_found' } };

  const out = await env.DB
    .prepare(`SELECT rewardId, title, type, valueText, tier, ttlMinutes, stock, isActive, updatedAt
              FROM rewards
              WHERE partnerId = ?
              ORDER BY updatedAt DESC`)
    .bind(pid)
    .all();

  return { status: 200, body: { ok: true, rewards: out.results || [] } };
}

function windowHoursFromUrl(url) {
  const wh = clampInt(url.searchParams.get('windowHours'), 1, 24 * 30);
  return Number.isFinite(wh) ? wh : 24;
}

async function adminStatsOverview(env, url) {
  const tableOk = await vouchersTableOk(env);
  if (!tableOk) return dbMissingTableResponse();

  const wh = windowHoursFromUrl(url);
  const now = nowMs();
  const since = now - wh * 60 * 60 * 1000;

  const counts = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN createdAt >= ? THEN 1 ELSE 0 END) AS vouchersCreated,
      SUM(CASE WHEN redeemedAt IS NOT NULL AND redeemedAt >= ? THEN 1 ELSE 0 END) AS vouchersRedeemed,
      COUNT(DISTINCT CASE WHEN createdAt >= ? AND gameId IS NOT NULL AND gameId <> '' THEN gameId ELSE NULL END) AS uniqueGames
    FROM vouchers
  `).bind(since, since, since).first();

  const topPartners = await env.DB.prepare(`
    SELECT
      v.partnerId AS partnerId,
      p.name AS name,
      SUM(CASE WHEN v.createdAt >= ? THEN 1 ELSE 0 END) AS created,
      SUM(CASE WHEN v.redeemedAt IS NOT NULL AND v.redeemedAt >= ? THEN 1 ELSE 0 END) AS redeemed
    FROM vouchers v
    LEFT JOIN partners p ON p.partnerId = v.partnerId
    WHERE v.createdAt >= ? OR (v.redeemedAt IS NOT NULL AND v.redeemedAt >= ?)
    GROUP BY v.partnerId
    ORDER BY created DESC, redeemed DESC
    LIMIT 5
  `).bind(since, since, since, since).all();

  const topRewards = await env.DB.prepare(`
    SELECT
      v.rewardId AS rewardId,
      r.title AS title,
      v.partnerId AS partnerId,
      SUM(CASE WHEN v.createdAt >= ? THEN 1 ELSE 0 END) AS created,
      SUM(CASE WHEN v.redeemedAt IS NOT NULL AND v.redeemedAt >= ? THEN 1 ELSE 0 END) AS redeemed
    FROM vouchers v
    LEFT JOIN rewards r ON r.rewardId = v.rewardId
    WHERE v.createdAt >= ? OR (v.redeemedAt IS NOT NULL AND v.redeemedAt >= ?)
    GROUP BY v.rewardId
    ORDER BY created DESC, redeemed DESC
    LIMIT 5
  `).bind(since, since, since, since).all();

  return {
    status: 200,
    body: {
      ok: true,
      windowHours: wh,
      vouchersCreated: Number(counts?.vouchersCreated) || 0,
      vouchersRedeemed: Number(counts?.vouchersRedeemed) || 0,
      uniqueGames: Number(counts?.uniqueGames) || 0,
      topPartners: topPartners.results || [],
      topRewards: topRewards.results || []
    }
  };
}

async function adminStatsPartner(env, partnerId, url) {
  const tableOk = await vouchersTableOk(env);
  if (!tableOk) return dbMissingTableResponse();

  const pid = asText(partnerId);
  if (!pid || pid.length > 80) return { status: 400, body: { ok: false, error: 'bad_request' } };

  const p = await env.DB.prepare('SELECT partnerId, name FROM partners WHERE partnerId = ?').bind(pid).first();
  if (!p) return { status: 404, body: { ok: false, error: 'not_found' } };

  const wh = windowHoursFromUrl(url);
  const now = nowMs();
  const since = now - wh * 60 * 60 * 1000;

  const counts = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN createdAt >= ? THEN 1 ELSE 0 END) AS created,
      SUM(CASE WHEN redeemedAt IS NOT NULL AND redeemedAt >= ? THEN 1 ELSE 0 END) AS redeemed
    FROM vouchers
    WHERE partnerId = ?
  `).bind(since, since, pid).first();

  const rewardCounts = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN isActive = 1 THEN 1 ELSE 0 END) AS activeRewards,
      SUM(CASE WHEN stock <= 0 THEN 1 ELSE 0 END) AS outOfStockRewards
    FROM rewards
    WHERE partnerId = ?
  `).bind(pid).first();

  return {
    status: 200,
    body: {
      ok: true,
      partnerId: pid,
      name: asText(p.name),
      windowHours: wh,
      created: Number(counts?.created) || 0,
      redeemed: Number(counts?.redeemed) || 0,
      activeRewards: Number(rewardCounts?.activeRewards) || 0,
      outOfStockRewards: Number(rewardCounts?.outOfStockRewards) || 0
    }
  };
}

/* ============================================================
 * BLOCK 10 — Partner invite flow
 * ============================================================ */
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

/* ============================================================
 * BLOCK 11 — Rewards CRUD (partnerId+pin)
 * ============================================================ */
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
    fields.push('title = ?'); binds.push(title);
  }
  if (b.valueText !== undefined) {
    const v = asText(b.valueText);
    if (!v || v.length > 140) return { status: 400, body: { ok: false, error: 'bad_request' } };
    fields.push('valueText = ?'); binds.push(v);
  }
  if (b.stock !== undefined) {
    const s = clampInt(b.stock, 0, 1_000_000);
    if (!Number.isFinite(s)) return { status: 400, body: { ok: false, error: 'bad_request' } };
    fields.push('stock = ?'); binds.push(s);
  }
  if (b.ttlMinutes !== undefined) {
    const t = clampInt(b.ttlMinutes, 1, 60 * 24 * 30);
    if (!Number.isFinite(t)) return { status: 400, body: { ok: false, error: 'bad_request' } };
    fields.push('ttlMinutes = ?'); binds.push(t);
  }
  if (b.tier !== undefined) {
    const t = asText(b.tier);
    if (!validateTier(t)) return { status: 400, body: { ok: false, error: 'bad_request' } };
    fields.push('tier = ?'); binds.push(t);
  }
  if (b.isActive !== undefined) {
    const ia = intOrNaN(b.isActive);
    if (!Number.isFinite(ia) || (ia !== 0 && ia !== 1)) return { status: 400, body: { ok: false, error: 'bad_request' } };
    fields.push('isActive = ?'); binds.push(ia);
  }

  if (fields.length === 0) return { status: 400, body: { ok: false, error: 'bad_request' } };

  fields.push('updatedAt = ?'); binds.push(nowMs());
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

/* ============================================================
 * BLOCK 12 — Game: pick3 (fail-soft 0..3)
 * ============================================================ */
async function rewardsPick3(req, env, url) {
  const tierQ = asText(url.searchParams.get('tier'));
  const tier = tierQ ? tierQ : 'cp';
  if (!validateTier(tier)) return { status: 400, body: { ok: false, error: 'bad_request' } };

  const seed = asText(url.searchParams.get('seed'));
  const pool = asText(url.searchParams.get('partnerPool'));

  let partnerIds = [];
  if (pool) {
    partnerIds = pool.split(',').map((s) => s.trim()).filter(Boolean);
    if (partnerIds.length > 50) return { status: 400, body: { ok: false, error: 'bad_request' } };
  }

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

  if (!all.length) return { status: 200, body: { ok: true, picks: [] } };

  const rng = seed ? mulberry32(seedToUint32(seed)) : (() => Math.random());
  const picks = pick3Unique(all, rng);

  return { status: 200, body: { ok: true, picks } };
}

/* ============================================================
 * BLOCK 13 — Vouchers (verify kompatibilitet + claim)
 * ============================================================ */
function normalizeVoucherStatus(row) {
  const s = asText(row?.status);
  if (s === 'redeemed' || s === 'expired' || s === 'valid') return s;
  return 'valid';
}

async function voucherGet(req, env, voucherId) {
  const tableOk = await vouchersTableOk(env);
  if (!tableOk) return dbMissingTableResponse();

  const id = asText(voucherId);
  if (!id || id.length > 80) return { status: 400, body: { ok: false, error: 'bad_request' } };

  const row = await env.DB.prepare(`
    SELECT voucherId, partnerId, rewardId, status, createdAt, expiresAt, redeemedAt, gameId, checkpointIndex
    FROM vouchers WHERE voucherId = ?
  `).bind(id).first();

  if (!row) return { status: 404, body: { ok: false, error: 'not_found' } };

  const now = nowMs();
  let status = normalizeVoucherStatus(row);

  if (status === 'valid' && Number(row.expiresAt) < now) {
    status = 'expired';
    try {
      await env.DB.prepare(`UPDATE vouchers SET status = 'expired' WHERE voucherId = ? AND status = 'valid'`).bind(id).run();
    } catch (_) {}
  }

  return {
    status: 200,
    body: {
      ok: true,
      voucher: {
        voucherId: asText(row.voucherId),
        partnerId: asText(row.partnerId),
        rewardId: asText(row.rewardId),
        status,
        expiresAt: Number(row.expiresAt) || 0,
        createdAt: Number(row.createdAt) || 0,
        redeemedAt: row.redeemedAt === null || row.redeemedAt === undefined ? null : Number(row.redeemedAt)
      }
    }
  };
}

async function voucherRedeem(req, env) {
  const tableOk = await vouchersTableOk(env);
  if (!tableOk) return dbMissingTableResponse();

  const parsed = await readJson(req);
  if (!parsed.ok || !isPlainObject(parsed.value)) return { status: 400, body: { ok: false, error: 'bad_request' } };

  const voucherId = asText(parsed.value.voucherId);
  const partnerId = asText(parsed.value.partnerId);
  const pin = asText(parsed.value.pin);

  if (!voucherId || !partnerId || !pin) return { status: 400, body: { ok: false, error: 'bad_request' } };
  if (voucherId.length > 80 || partnerId.length > 80 || pin.length > 32) return { status: 400, body: { ok: false, error: 'bad_request' } };

  const auth = await verifyPartnerPin(partnerId, pin, env);
  if (!auth.ok) return { status: auth.code === 'not_found' ? 404 : 403, body: { ok: false, error: auth.code === 'not_found' ? 'not_found' : 'forbidden' } };

  const row = await env.DB.prepare(`
    SELECT voucherId, partnerId, status, expiresAt, redeemedAt
    FROM vouchers WHERE voucherId = ?
  `).bind(voucherId).first();

  if (!row) return { status: 404, body: { ok: false, error: 'not_found' } };
  if (asText(row.partnerId) !== partnerId) return { status: 403, body: { ok: false, error: 'forbidden' } };

  const now = nowMs();
  let status = normalizeVoucherStatus(row);

  if (status === 'valid' && Number(row.expiresAt) < now) {
    try {
      await env.DB.prepare(`UPDATE vouchers SET status = 'expired' WHERE voucherId = ? AND status = 'valid'`).bind(voucherId).run();
    } catch (_) {}
    return { status: 410, body: { ok: false, error: 'expired' } };
  }

  if (status === 'expired') return { status: 410, body: { ok: false, error: 'expired' } };
  if (status === 'redeemed') return { status: 409, body: { ok: false, error: 'already_redeemed' } };

  const redeemedAt = now;
  const upd = await env.DB.prepare(`
    UPDATE vouchers
    SET status = 'redeemed', redeemedAt = ?
    WHERE voucherId = ? AND status = 'valid'
  `).bind(redeemedAt, voucherId).run();

  if (!upd || Number(upd.changes) !== 1) {
    const again = await env.DB.prepare('SELECT status, expiresAt FROM vouchers WHERE voucherId = ?').bind(voucherId).first();
    const s2 = normalizeVoucherStatus(again);
    if (s2 === 'redeemed') return { status: 409, body: { ok: false, error: 'already_redeemed' } };
    if (s2 === 'valid' && Number(again.expiresAt) < now) return { status: 410, body: { ok: false, error: 'expired' } };
    return { status: 500, body: { ok: false, error: 'server_error' } };
  }

  return { status: 200, body: { ok: true, status: 'redeemed', redeemedAt } };
}

async function voucherClaim(req, env) {
  const tableOk = await vouchersTableOk(env);
  if (!tableOk) return dbMissingTableResponse();

  const parsed = await readJson(req);
  if (!parsed.ok || !isPlainObject(parsed.value)) return { status: 400, body: { ok: false, error: 'bad_request' } };

  const gameId = asText(parsed.value.gameId) || 'demo';
  const checkpointIndex = clampInt(parsed.value.checkpointIndex, 0, 999);
  const rewardId = asText(parsed.value.rewardId);

  if (!rewardId || rewardId.length > 80) return { status: 400, body: { ok: false, error: 'bad_request' } };
  if (!Number.isFinite(checkpointIndex)) return { status: 400, body: { ok: false, error: 'bad_request' } };

  const ts = nowMs();

  const upd = await env.DB.prepare(`
    UPDATE rewards
    SET stock = stock - 1, updatedAt = ?
    WHERE rewardId = ? AND isActive = 1 AND stock > 0
  `).bind(ts, rewardId).run();

  if (!upd || Number(upd.changes) !== 1) {
    const ex = await env.DB.prepare('SELECT rewardId, isActive, stock FROM rewards WHERE rewardId = ?').bind(rewardId).first();
    if (!ex) return { status: 404, body: { ok: false, error: 'not_found' } };
    if (Number(ex.isActive) !== 1) return { status: 404, body: { ok: false, error: 'not_found' } };
    if (Number(ex.stock) <= 0) return { status: 409, body: { ok: false, error: 'out_of_stock' } };
    return { status: 500, body: { ok: false, error: 'server_error' } };
  }

  const r = await env.DB.prepare(`
    SELECT r.rewardId, r.partnerId, r.title, r.ttlMinutes, r.tier, p.name AS partnerName
    FROM rewards r
    JOIN partners p ON p.partnerId = r.partnerId
    WHERE r.rewardId = ?
  `).bind(rewardId).first();

  if (!r) return { status: 500, body: { ok: false, error: 'server_error' } };

  const ttlMinutes = clampInt(r.ttlMinutes, 1, 60 * 24 * 30);
  const expiresAt = ts + (Number.isFinite(ttlMinutes) ? ttlMinutes : 120) * 60 * 1000;

  const voucherId = safeUuid();
  const partnerId = asText(r.partnerId);

  try {
    await env.DB.prepare(`
      INSERT INTO vouchers
      (voucherId, partnerId, rewardId, status, createdAt, expiresAt, redeemedAt, gameId, checkpointIndex)
      VALUES (?, ?, ?, 'valid', ?, ?, NULL, ?, ?)
    `).bind(
      voucherId,
      partnerId,
      rewardId,
      ts,
      expiresAt,
      gameId,
      checkpointIndex
    ).run();
  } catch (_) {
    return { status: 500, body: { ok: false, error: 'server_error' } };
  }

  return {
    status: 200,
    body: {
      ok: true,
      voucherId,
      partnerId,
      partnerName: asText(r.partnerName),
      rewardId,
      rewardTitle: asText(r.title),
      expiresAt,
      status: 'valid'
    }
  };
}

/* ============================================================
 * BLOCK 14 — Router
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
      // ======================================================
      // Admin login (no token required)
      // ======================================================
      if (path === '/admin/login' && method === 'POST') {
        const out = await adminLogin(req, env);
        return json(out.body, out.status, cors);
      }

      // ======================================================
      // Admin endpoints (Bearer required)
      // ======================================================
      if (path.startsWith('/admin/')) {
        const auth = await requireAdminBearer(req, env);
        if (!auth.ok) return json({ ok: false, error: 'forbidden' }, 403, cors);

        if (path === '/admin/partners/create' && method === 'POST') {
          const out = await adminCreatePartner(req, env);
          return json(out.body, out.status, cors);
        }

        if (path === '/admin/partners/invite' && method === 'POST') {
          const out = await adminInvitePartner(req, env);
          return json(out.body, out.status, cors);
        }

        if (path === '/admin/partners/list' && method === 'GET') {
          const out = await adminPartnersList(env);
          return json(out.body, out.status, cors);
        }

        // /admin/partners/:id/rewards
        if (path.startsWith('/admin/partners/') && path.endsWith('/rewards') && method === 'GET') {
          const mid = path.replace('/admin/partners/', '').replace('/rewards', '');
          const out = await adminPartnerRewards(env, mid);
          return json(out.body, out.status, cors);
        }

        if (path === '/admin/stats/overview' && method === 'GET') {
          const out = await adminStatsOverview(env, url);
          return json(out.body, out.status, cors);
        }

        // /admin/stats/partner/:id
        if (path.startsWith('/admin/stats/partner/') && method === 'GET') {
          const pid = path.replace('/admin/stats/partner/', '');
          const out = await adminStatsPartner(env, pid, url);
          return json(out.body, out.status, cors);
        }

        return json({ ok: false, error: 'not_found' }, 404, cors);
      }

      // ======================================================
      // Partner invite flow
      // ======================================================
      if (path === '/partners/set-pin' && method === 'POST') {
        const out = await partnerSetPin(req, env);
        return json(out.body, out.status, cors);
      }

      // ======================================================
      // Rewards CRUD (partnerId+pin)
      // ======================================================
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

      // ======================================================
      // Game pick3
      // ======================================================
      if (path === '/rewards/pick3' && method === 'GET') {
        const out = await rewardsPick3(req, env, url);
        return json(out.body, out.status, cors);
      }

      // ======================================================
      // Vouchers
      // ======================================================
      if (path === '/vouchers/claim' && method === 'POST') {
        const out = await voucherClaim(req, env);
        return json(out.body, out.status, cors);
      }

      if (path.startsWith('/vouchers/') && method === 'GET') {
        const vid = path.replace('/vouchers/', '');
        const out = await voucherGet(req, env, vid);
        return json(out.body, out.status, cors);
      }

      if (path === '/vouchers/redeem' && method === 'POST') {
        const out = await voucherRedeem(req, env);
        return json(out.body, out.status, cors);
      }

      return json({ ok: false, error: 'not_found' }, 404, cors);
    } catch (_) {
      return json({ ok: false, error: 'server_error' }, 500, cors);
    }
  }
};

/* ============================================================
 * TESTNOTERINGAR (snabb)
 * 1) POST /admin/login (anders/TestAdmin) -> 200 + token
 * 2) GET /admin/partners/list utan Authorization -> 403
 * 3) GET /admin/partners/list med Bearer token -> 200
 * 4) Vänta > TTL -> samma call -> 403
 *
 * RISK/EDGE CASES
 * - CORS_ORIGINS måste inkludera din dashboard-origin, annars får du 403 i browsern.
 * - ADMIN_TOKEN_SECRET måste vara satt, annars blir login 500/server_error eller admin 403.
 * ============================================================ */
