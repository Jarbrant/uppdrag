/* ============================================================
   FIL: src/packs.js  (HEL FIL)
   AO 4/15 + AO 13/15 — Packs loader + robust felkoder (fail-closed)
   Mål: Alla fetch-fel mappas till tydliga felkoder.
   Policy: UI-only, fail-closed, inga nya storage keys, inga token-loggar
============================================================ */

/* ============================================================
   BLOCK 1 — Imports
============================================================ */
import { uid } from './util.js';

/* ============================================================
   BLOCK 2 — Paths (kontrakt)
============================================================ */
export const ZONES_INDEX_PATH = '/data/zones.index.json'; // HOOK: zones-index-path
export const PACKS_BASE_PATH = '/data/packs/';            // HOOK: packs-base-path

/* ============================================================
   BLOCK 3 — Error codes (KRAV)
============================================================ */
export const PACK_ERR = Object.freeze({
  // input
  ZONE_ID_MISSING: 'P_ZONE_ID_MISSING',

  // index fetch/parse
  INDEX_FETCH_NETWORK: 'P_INDEX_FETCH_NETWORK',
  INDEX_FETCH_HTTP: 'P_INDEX_FETCH_HTTP',
  INDEX_FETCH_JSON: 'P_INDEX_FETCH_JSON',

  // index validation
  INDEX_BAD: 'P_INDEX_BAD',
  INDEX_EMPTY: 'P_INDEX_EMPTY',
  INDEX_ZONE_BAD: 'P_INDEX_ZONE_BAD',
  INDEX_ZONE_ID_MISSING: 'P_INDEX_ZONE_ID_MISSING',
  INDEX_ZONE_NAME_MISSING: 'P_INDEX_ZONE_NAME_MISSING',
  INDEX_ZONE_FILE_MISSING: 'P_INDEX_ZONE_FILE_MISSING',
  INDEX_ZONE_FILE_INVALID: 'P_INDEX_ZONE_FILE_INVALID',
  INDEX_ZONE_DUPLICATE: 'P_INDEX_ZONE_DUPLICATE',
  ZONE_NOT_FOUND: 'P_ZONE_NOT_FOUND',

  // pack fetch/parse
  PACK_FETCH_NETWORK: 'P_PACK_FETCH_NETWORK',
  PACK_FETCH_HTTP: 'P_PACK_FETCH_HTTP',
  PACK_FETCH_JSON: 'P_PACK_FETCH_JSON',

  // pack validation
  PACK_BAD: 'P_PACK_BAD',
  PACK_ID_MISSING: 'P_PACK_ID_MISSING',
  PACK_NAME_MISSING: 'P_PACK_NAME_MISSING',
  PACK_MISSIONS_BAD: 'P_PACK_MISSIONS_BAD',
  PACK_MISSION_BAD: 'P_PACK_MISSION_BAD'
});

/* ============================================================
   BLOCK 4 — Controlled error object
   KRAV: Vid fel → kasta kontrollerat felobjekt
============================================================ */
export function PackError(code, message, details = {}) {
  return {
    name: 'PackError',
    code: String(code || 'PACK_ERROR'),
    message: String(message || 'Pack error'),
    requestId: uid('pack'), // HOOK: requestId
    details: details && typeof details === 'object' ? details : {}
  };
}

/* ============================================================
   BLOCK 5 — Helpers
============================================================ */
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function asTextSafe(x) {
  return (x ?? '').toString().trim();
}

async function fetchJson(url, { scope = 'GEN' } = {}) {
  // scope: INDEX | PACK | GEN
  const rid = uid('fetch'); // HOOK: fetch-requestId
  let res;

  try {
    res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store'
    });
  } catch (_) {
    throw PackError(
      scope === 'INDEX' ? PACK_ERR.INDEX_FETCH_NETWORK : PACK_ERR.PACK_FETCH_NETWORK,
      'Kunde inte hämta data (nätverksfel).',
      { url, rid }
    );
  }

  if (!res || !res.ok) {
    throw PackError(
      scope === 'INDEX' ? PACK_ERR.INDEX_FETCH_HTTP : PACK_ERR.PACK_FETCH_HTTP,
      'Kunde inte hämta data (HTTP-fel).',
      { url, rid, status: res?.status }
    );
  }

  try {
    return await res.json();
  } catch (_) {
    throw PackError(
      scope === 'INDEX' ? PACK_ERR.INDEX_FETCH_JSON : PACK_ERR.PACK_FETCH_JSON,
      'Kunde inte tolka JSON (parse-fel).',
      { url, rid }
    );
  }
}

/* ============================================================
   BLOCK 6 — Validation: zones index
============================================================ */
function validateZonesIndex(idx) {
  if (!isPlainObject(idx)) throw PackError(PACK_ERR.INDEX_BAD, 'zones.index.json har fel format (inte objekt).');

  const zones = idx.zones;
  if (!Array.isArray(zones) || zones.length < 1) {
    throw PackError(PACK_ERR.INDEX_EMPTY, 'zones.index.json saknar zones[] eller är tom.');
  }

  const map = new Map();
  for (const z of zones) {
    if (!isPlainObject(z)) throw PackError(PACK_ERR.INDEX_ZONE_BAD, 'zones[] innehåller fel typ (inte objekt).');

    const id = asTextSafe(z.id);
    const name = asTextSafe(z.name);
    const file = asTextSafe(z.file);

    if (!id) throw PackError(PACK_ERR.INDEX_ZONE_ID_MISSING, 'Zone saknar id.', { zone: z });
    if (!name) throw PackError(PACK_ERR.INDEX_ZONE_NAME_MISSING, 'Zone saknar name.', { zoneId: id });
    if (!file) throw PackError(PACK_ERR.INDEX_ZONE_FILE_MISSING, 'Zone saknar file.', { zoneId: id });

    if (!/^[a-zA-Z0-9._-]+\.json$/.test(file)) {
      throw PackError(PACK_ERR.INDEX_ZONE_FILE_INVALID, 'Zone file har ogiltigt filnamn.', { zoneId: id, file });
    }

    if (map.has(id)) {
      throw PackError(PACK_ERR.INDEX_ZONE_DUPLICATE, 'Dubbel zone id i index.', { zoneId: id });
    }

    map.set(id, { id, name, file });
  }

  return map;
}

/* ============================================================
   BLOCK 7 — Validation: zone pack (minsta fält)
============================================================ */
function validateZonePack(pack) {
  if (!isPlainObject(pack)) throw PackError(PACK_ERR.PACK_BAD, 'Pack JSON har fel format (inte objekt).');

  const id = asTextSafe(pack.id);
  const name = asTextSafe(pack.name);
  const missions = pack.missions;

  if (!id) throw PackError(PACK_ERR.PACK_ID_MISSING, 'Pack saknar id.');
  if (!name) throw PackError(PACK_ERR.PACK_NAME_MISSING, 'Pack saknar name.');
  if (!Array.isArray(missions)) throw PackError(PACK_ERR.PACK_MISSIONS_BAD, 'Pack saknar missions[] eller fel typ.', { packId: id });

  for (let i = 0; i < missions.length; i++) {
    const m = missions[i];
    if (!isPlainObject(m)) {
      throw PackError(PACK_ERR.PACK_MISSION_BAD, 'missions[] innehåller fel typ (inte objekt).', { packId: id, index: i });
    }
  }

  return { id, name, missionsCount: missions.length };
}

/* ============================================================
   BLOCK 8 — Public API
============================================================ */
let _zonesIndexCache = null; // in-memory only // HOOK: zones-index-cache

export async function loadZonesIndex({ force = false } = {}) {
  if (_zonesIndexCache && !force) return _zonesIndexCache;

  const idx = await fetchJson(ZONES_INDEX_PATH, { scope: 'INDEX' });
  const map = validateZonesIndex(idx);
  _zonesIndexCache = map;
  return map;
}

export async function loadZonePack(zoneId, { forceIndex = false } = {}) {
  const zid = asTextSafe(zoneId);
  if (!zid) throw PackError(PACK_ERR.ZONE_ID_MISSING, 'zoneId saknas.');

  const indexMap = await loadZonesIndex({ force: forceIndex });
  const entry = indexMap.get(zid);

  if (!entry) {
    throw PackError(PACK_ERR.ZONE_NOT_FOUND, 'Zon finns inte i index.', { zoneId: zid });
  }

  const packUrl = `${PACKS_BASE_PATH}${entry.file}`;
  const pack = await fetchJson(packUrl, { scope: 'PACK' });

  validateZonePack(pack);
  return pack;
}
