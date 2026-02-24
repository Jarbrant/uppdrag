/* ============================================================
 * FIL: worker/index.js (HEL FIL)
 * AO 5/6 — Game Reward Pool + Claim (stock--) + Voucher i D1
 *
 * ÄNDRINGAR I DENNA FIL (AO 5/6):
 *   - /rewards/pick3: FAIL-SOFT (0–3 picks), tier default = cp, seed-stöd
 *   - NY: POST /vouchers/claim  (stock-- + skapa voucher i D1)
 *   - NY: GET  /vouchers/:id    (verify-stöd)
 *   - NY: POST /vouchers/redeem (verify-stöd, partnerId+pin)
 *   - Vouchers lagras i D1 (CREATE TABLE IF NOT EXISTS vid behov)
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
 *     GET  /admin/partners/list
 *     GET  /admin/rewards/stats
 *     GET  /admin/rewards/list?partnerId=<optional>
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
 *     GET  /rewards/pick3?tier=cp|final(optional)&partnerPool=csv(optional)&seed=string(optional)
 *     POST /vouchers/claim        { gameId, checkpointIndex, rewardId }
 *
 *   Verify:
 *     GET  /vouchers/:voucherId
 *     POST /vouchers/redeem       { voucherId, partnerId, pin }
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

/**
 * FAIL-SOFT: returnera 0–3 unika rows beroende på pool.
 */
function pickUpTo3Unique(rows, rngFn) {
  const arr = Array.isArray(rows) ? rows.slice() : [];
  if (arr.length === 0) return [];

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
 * BLOCK 5.1 — Ensure vouchers table (D1)
 * ============================================================ */
async function ensureVouchersTable(env) {
  // Fail-soft: CREATE IF NOT EXISTS (idempotent)
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS vouchers (
        voucherId TEXT PRIMARY KEY,
        partnerId TEXT NOT NULL,
        rewardId TEXT NOT NULL,
        status TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL,
        redeemedAt INTEGER,
        gameId TEXT,
        checkpointIndex INTEGER
      )
    `).run();

    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_vouchers_partnerId ON vouchers(partnerId)`).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_vouchers_status ON vouchers(status)`).run();
  } catch (_) {
    // Om D1 är read-only/misconfigured → server_error senare i callers
  }
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
 * BLOCK 6.1 — Admin GET: partners list
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

/* ============================================================
 * BLOCK 6.2 — Admin GET: rewards stats
 * ============================================================ */
async function adminRewardsStats(env) {
  const partnersTotal = await env.DB.prepare('SELECT COUNT(1) AS n FROM partners').first();
  const partnersActive = await env.DB.prepare('SELECT COUNT(1) AS n FROM partners WHERE isActive = 1').first();

  const rewardsTotal = await env.DB.prepare('SELECT COUNT(1) AS n FROM rewards').first();
  const rewardsActive = await env.DB.prepare('SELECT COUNT(1) AS n FROM rewards WHERE isActive = 1').first();
  const rewardsInStock = await env.DB.prepare('SELECT COUNT(1) AS n FROM rewards WHERE stock > 0').first();
  const rewardsOutStock = await env.DB.prepare('SELECT COUNT(1) AS n FROM rewards WHERE stock <= 0').first();

  const rewardsCp = await env.DB.prepare("SELECT COUNT(1) AS n FROM rewards WHERE tier = 'cp'").first();
  const rewardsFinal = await env.DB.prepare("SELECT COUNT(1) AS n FROM rewards WHERE tier = 'final'").first();

  return {
    status: 200,
    body: {
      ok: true,
      partners: {
        total: Number(partnersTotal?.n) || 0,
        active: Number(partnersActive?.n) || 0
      },
      rewards: {
        total: Number(rewardsTotal?.n) || 0,
        active: Number(rewardsActive?.n) || 0,
        inStock: Number(rewardsInStock?.n) || 0,
        outOfStock: Number(rewardsOutStock?.n) || 0,
        cpTotal: Number(rewardsCp?.n) || 0,
        finalTotal: Number(rewardsFinal?.n) || 0
      }
    }
  };
}

/* ============================================================
 * BLOCK 6.3 — Admin GET: rewards list
 * ============================================================ */
async function adminRewardsList(env, url) {
  const partnerId = asText(url.searchParams.get('partnerId'));

  if (partnerId && partnerId.length > 80) {
    return { status: 400, body: { ok: false, error: 'bad_request' } };
  }

  let sql = `SELECT rewardId, partnerId, title, type, valueText, stock, ttlMinutes, tier, isActive, createdAt, updatedAt
             FROM rewards`;
  const binds = [];

  if (partnerId) {
    sql += ' WHERE partnerId = ?';
    binds.push(partnerId);
  }

  sql += ' ORDER BY updatedAt DESC';

  const out = await env.DB.prepare(sql).bind(...binds).all();
  return { status: 200, body: { ok: true, rewards: out.results || [] } };
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

/* ============================================================
 * BLOCK 6.4 — Game: pick3 (FAIL-SOFT + tier default cp)
 * ============================================================ */
async function rewardsPick3(req, env, url) {
  const tierRaw = asText(url.searchParams.get('tier'));
  const tier = validateTier(tierRaw) ? tierRaw : 'cp'; // default cp (KRAV)

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

  // FAIL-SOFT: returnera 0–3 picks
  const rng = seed ? mulberry32(seedToUint32(seed)) : (() => Math.random());
  const picks = pickUpTo3Unique(all, rng);

  return { status: 200, body: { ok: true, picks } };
}

/* ============================================================
 * BLOCK 6.5 — Game: claim (stock-- + voucher create)
 * POST /vouchers/claim
 * Body: { gameId, checkpointIndex, rewardId }
 * ============================================================ */
async function vouchersClaim(req, env) {
  await ensureVouchersTable(env);

  const parsed = await readJson(req);
  if (!parsed.ok || !isPlainObject(parsed.value)) return { status: 400, body: { ok: false, error: 'bad_request' } };

  const b = parsed.value;

  const gameId = asText(b.gameId);
  const checkpointIndex = intOrNaN(b.checkpointIndex);
  const rewardId = asText(b.rewardId);

  if (!gameId || gameId.length > 120) return { status: 400, body: { ok: false, error: 'bad_request' } };
  if (!Number.isFinite(checkpointIndex) || checkpointIndex < 0 || checkpointIndex > 999) return { status: 400, body: { ok: false, error: 'bad_request' } };
  if (!rewardId || rewardId.length > 80) return { status: 400, body: { ok: false, error: 'bad_request' } };

  // Hämta reward + partner info
  const r = await env.DB.prepare(`
      SELECT r.rewardId, r.partnerId, p.name AS partnerName, r.title, r.ttlMinutes, r.tier, r.isActive, r.stock
      FROM rewards r
      JOIN partners p ON p.partnerId = r.partnerId
      WHERE r.rewardId = ?
    `).bind(rewardId).first();

  if (!r) return { status: 404, body: { ok: false, error: 'not_found' } };
  if (Number(r.isActive) !== 1) return { status: 404, body: { ok: false, error: 'not_found' } };

  const stockNow = Number(r.stock);
  if (!Number.isFinite(stockNow) || stockNow <= 0) {
    return { status: 409, body: { ok: false, error: 'out_of_stock' } };
  }

  const ts = nowMs();
  const ttlMinutes = clampInt(r.ttlMinutes, 1, 60 * 24 * 30);
  if (!Number.isFinite(ttlMinutes)) return { status: 400, body: { ok: false, error: 'bad_request' } };

  const expiresAt = ts + ttlMinutes * 60 * 1000;
  const voucherId = safeUuid();

  // Best-effort atomik:
  // 1) UPDATE stock med guard stock>0
  // 2) INSERT voucher
  // Om insert failar: försök återställa stock (+1) (fail-soft)
  try {
    const up = await env.DB.prepare(`
        UPDATE rewards
        SET stock = stock - 1, updatedAt = ?
        WHERE rewardId = ? AND isActive = 1 AND stock > 0
      `).bind(ts, rewardId).run();

    const changes = Number(up?.meta?.changes) || 0;
    if (changes !== 1) {
      return { status: 409, body: { ok: false, error: 'out_of_stock' } };
    }

    await env.DB.prepare(`
        INSERT INTO vouchers (voucherId, partnerId, rewardId, status, createdAt, expiresAt, redeemedAt, gameId, checkpointIndex)
        VALUES (?, ?, ?, 'valid', ?, ?, NULL, ?, ?)
      `).bind(
      voucherId,
      asText(r.partnerId),
      rewardId,
      ts,
      expiresAt,
      gameId,
      checkpointIndex
    ).run();

    return {
      status: 200,
      body: {
        ok: true,
        voucherId,
        partnerId: asText(r.partnerId),
        partnerName: asText(r.partnerName),
        rewardId,
        rewardTitle: asText(r.title),
        expiresAt,
        status: 'valid'
      }
    };
  } catch (_) {
    // försök kompensera stock (best effort)
    try {
      await env.DB.prepare(`
          UPDATE rewards SET stock = stock + 1, updatedAt = ?
          WHERE rewardId = ?
        `).bind(nowMs(), rewardId).run();
    } catch (_)2 {}
    return { status: 500, body: { ok: false, error: 'server_error' } };
  }
}

/* ============================================================
 * BLOCK 6.6 — Verify: GET voucher
 * GET /vouchers/:voucherId
 * ============================================================ */
async function vouchersGet(env, voucherId) {
  await ensureVouchersTable(env);

  const vid = asText(voucherId);
  if (!vid) return { status: 400, body: { ok: false, error: 'bad_request' } };

  const v = await env.DB.prepare(`
      SELECT voucherId, partnerId, rewardId, status, createdAt, expiresAt, redeemedAt, gameId, checkpointIndex
      FROM vouchers WHERE voucherId = ?
    `).bind(vid).first();

  if (!v) return { status: 404, body: { ok: false, error: 'not_found' } };

  // status-derivation: expired om passerat och inte redeemed
  const now = nowMs();
  let status = asText(v.status) || 'valid';
  const exp = Number(v.expiresAt) || 0;
  const redAt = v.redeemedAt !== null && v.redeemedAt !== undefined ? Number(v.redeemedAt) : 0;

  if (status !== 'redeemed' && exp > 0 && now > exp) {
    status = 'expired';
    // best-effort persist
    try {
      await env.DB.prepare(`UPDATE vouchers SET status = 'expired' WHERE voucherId = ? AND status != 'redeemed'`).bind(vid).run();
    } catch (_) {}
  }

  return {
    status: 200,
    body: {
      ok: true,
      voucher: {
        voucherId: asText(v.voucherId),
        partnerId: asText(v.partnerId),
        rewardId: asText(v.rewardId),
        status: status === 'redeemed' ? 'redeemed' : status === 'expired' ? 'expired' : 'valid',
        expiresAt: exp,
        createdAt: Number(v.createdAt) || 0,
        redeemedAt: redAt || 0,
        gameId: asText(v.gameId),
        checkpointIndex: Number(v.checkpointIndex) || 0
      }
    }
  };
}

/* ============================================================
 * BLOCK 6.7 — Verify: redeem
 * POST /vouchers/redeem { voucherId, partnerId, pin }
 * ============================================================ */
async function vouchersRedeem(req, env) {
  await ensureVouchersTable(env);

  const parsed = await readJson(req);
  if (!parsed.ok || !isPlainObject(parsed.value)) return { status: 400, body: { ok: false, error: 'bad_request' } };

  const b = parsed.value;
  const voucherId = asText(b.voucherId);
  const partnerId = asText(b.partnerId);
  const pin = asText(b.pin);

  if (!voucherId) return { status: 400, body: { ok: false, error: 'bad_request' } };
  if (!partnerId || !pin) return { status: 400, body: { ok: false, error: 'bad_request' } };

  // auth partner pin
  const auth = await verifyPartnerPin(partnerId, pin, env);
  if (!auth.ok) return { status: auth.code === 'not_found' ? 404 : 403, body: { ok: false, error: auth.code === 'not_found' ? 'not_found' : 'forbidden' } };

  // read voucher
  const v = await env.DB.prepare(`
      SELECT voucherId, partnerId, rewardId, status, createdAt, expiresAt, redeemedAt
      FROM vouchers WHERE voucherId = ?
    `).bind(voucherId).first();

  if (!v) return { status: 404, body: { ok: false, error: 'not_found' } };

  // partner match
  if (asText(v.partnerId) !== partnerId) return { status: 403, body: { ok: false, error: 'forbidden' } };

  const now = nowMs();
  const exp = Number(v.expiresAt) || 0;

  // already redeemed
  if (asText(v.status) === 'redeemed' || (v.redeemedAt !== null && v.redeemedAt !== undefined && Number(v.redeemedAt) > 0)) {
    return { status: 409, body: { ok: false, error: 'already_redeemed' } };
  }

  // expired
  if (exp > 0 && now > exp) {
    // best-effort persist expired
    try {
      await env.DB.prepare(`UPDATE vouchers SET status = 'expired' WHERE voucherId = ? AND status != 'redeemed'`).bind(voucherId).run();
    } catch (_) {}
    return { status: 410, body: { ok: false, error: 'expired' } };
  }

  // only valid can redeem
  if (asText(v.status) !== 'valid') {
    return { status: 403, body: { ok: false, error: 'forbidden' } };
  }

  // redeem
  try {
    const up = await env.DB.prepare(`
        UPDATE vouchers
        SET status = 'redeemed', redeemedAt = ?
        WHERE voucherId = ? AND status = 'valid'
      `).bind(now, voucherId).run();

    const changes = Number(up?.meta?.changes) || 0;
    if (changes !== 1) return { status: 409, body: { ok: false, error: 'already_redeemed' } };

    return { status: 200, body: { ok: true, status: 'redeemed', redeemedAt: now } };
  } catch (_) {
    return { status: 500, body: { ok: false, error: 'server_error' } };
  }
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

/* ============================================================
 * BLOCK 8 — Fetch
 * ============================================================ */
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
      // Admin endpoints
      // ======================================================
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

      if (path === '/admin/partners/list' && method === 'GET') {
        if (!requireAdmin(req, env)) return json({ ok: false, error: 'forbidden' }, 403, cors);
        const out = await adminPartnersList(env);
        return json(out.body, out.status, cors);
      }

      if (path === '/admin/rewards/stats' && method === 'GET') {
        if (!requireAdmin(req, env)) return json({ ok: false, error: 'forbidden' }, 403, cors);
        const out = await adminRewardsStats(env);
        return json(out.body, out.status, cors);
      }

      if (path === '/admin/rewards/list' && method === 'GET') {
        if (!requireAdmin(req, env)) return json({ ok: false, error: 'forbidden' }, 403, cors);
        const out = await adminRewardsList(env, url);
        return json(out.body, out.status, cors);
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
      // Game: pick3 + claim
      // ======================================================
      if (path === '/rewards/pick3' && method === 'GET') {
        const out = await rewardsPick3(req, env, url);
        return json(out.body, out.status, cors);
      }

      if (path === '/vouchers/claim' && method === 'POST') {
        const out = await vouchersClaim(req, env);
        return json(out.body, out.status, cors);
      }

      // ======================================================
      // Verify: GET /vouchers/:id + POST /vouchers/redeem
      // ======================================================
      if (path === '/vouchers/redeem' && method === 'POST') {
        const out = await vouchersRedeem(req, env);
        return json(out.body, out.status, cors);
      }

      // Dynamic GET /vouchers/:id
      if (method === 'GET') {
        const m = /^\/vouchers\/([^/]+)$/.exec(path);
        if (m && m[1]) {
          const out = await vouchersGet(env, m[1]);
          return json(out.body, out.status, cors);
        }
      }

      return json({ ok: false, error: 'not_found' }, 404, cors);
    } catch (_) {
      return json({ ok: false, error: 'server_error' }, 500, cors);
    }
  }
};
