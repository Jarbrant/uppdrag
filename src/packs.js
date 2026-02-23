/* ============================================================
   FIL: src/packs.js  (HEL FIL)
   AO 4/15 — Packs loader + data-validering (fail-closed)
   Mål: Ladda zonpaket via index och validera.
   Policy: UI-only, fail-closed, inga nya storage keys, inga console secrets
============================================================ */

/* ============================================================
   BLOCK 1 — Imports
============================================================ */
import { uid } from './util.js';

/* ============================================================
   BLOCK 2 — Paths (kontrakt)
   - Index: listar vilka zoner som finns + vilket pack-filnamn som gäller
   - Packs: faktiska pack-filer (JSON)
============================================================ */
export const ZONES_INDEX_PATH = '/data/zones.index.json'; // HOOK: zones-index-path
export const PACKS_BASE_PATH = '/data/packs/';            // HOOK: packs-base-path

/* ============================================================
   BLOCK 3 — Controlled error (fail-closed)
   KRAV: Vid fel → kasta kontrollerat felobjekt
============================================================ */
export function PackError(code, message, details = {}) {
  return {
    name: 'PackError',
    code: String(code || 'PACK_ERROR'),
    message: String(message || 'Pack error'),
    requestId: uid('pack'), // HOOK: requestId (för spårbarhet i UI)
    details: details && typeof details === 'object' ? details : {}
  };
}

/* ============================================================
   BLOCK 4 — Helpers
============================================================ */
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function asTextSafe(x) {
  return (x ?? '').toString().trim();
}

async function fetchJson(url) {
  const rid = uid('fetch'); // HOOK: fetch-requestId
  let res;

  try {
    res = await fetch(url, {
      method: 'GET',
      credentials: 'include', // AEGIS: om cookies finns i framtiden (ok även utan)
      cache: 'no-store'
    });
  } catch (e) {
    throw PackError('FETCH_NETWORK', 'Kunde inte hämta data (nätverksfel).', { url, rid });
  }

  if (!res || !res.ok) {
    throw PackError('FETCH_HTTP', 'Kunde inte hämta data (HTTP-fel).', { url, rid, status: res?.status });
  }

  try {
    return await res.json();
  } catch (_) {
    throw PackError('FETCH_JSON', 'Kunde inte tolka JSON (parse-fel).', { url, rid });
  }
}

/* ============================================================
   BLOCK 5 — Validation: zones index
   Minsta shape (fail-closed):
   {
     "version": 1,
     "zones": [
       { "id": "skogsrundan", "name": "Skogsrundan", "file": "zone_skogsrundan.json" }
     ]
   }
============================================================ */
function validateZonesIndex(idx) {
  if (!isPlainObject(idx)) throw PackError('INDEX_BAD', 'zones.index.json har fel format (inte objekt).');

  const zones = idx.zones;
  if (!Array.isArray(zones) || zones.length < 1) {
    throw PackError('INDEX_EMPTY', 'zones.index.json saknar zones[] eller är tom.');
  }

  // Fail-closed: validera varje entry minimalt
  const map = new Map();
  for (const z of zones) {
    if (!isPlainObject(z)) throw PackError('INDEX_ZONE_BAD', 'zones[] innehåller fel typ (inte objekt).');

    const id = asTextSafe(z.id);
    const name = asTextSafe(z.name);
    const file = asTextSafe(z.file);

    if (!id) throw PackError('INDEX_ZONE_ID_MISSING', 'Zone saknar id.', { zone: z });
    if (!name) throw PackError('INDEX_ZONE_NAME_MISSING', 'Zone saknar name.', { zoneId: id });
    if (!file) throw PackError('INDEX_ZONE_FILE_MISSING', 'Zone saknar file.', { zoneId: id });

    // Enkel fil-guard (fail-closed): bara filnamn, inga paths
    if (!/^[a-zA-Z0-9._-]+\.json$/.test(file)) {
      throw PackError('INDEX_ZONE_FILE_INVALID', 'Zone file har ogiltigt filnamn.', { zoneId: id, file });
    }

    if (map.has(id)) {
      throw PackError('INDEX_ZONE_DUPLICATE', 'Dubbel zone id i index.', { zoneId: id });
    }
    map.set(id, { id, name, file });
  }

  return map;
}

/* ============================================================
   BLOCK 6 — Validation: zone pack
   KRAV: Validera minsta fält (id, name, missions[])
   - missions[] måste vara array (min 1 rekommenderat, men KRAV säger bara missions[])
============================================================ */
function validateZonePack(pack) {
  if (!isPlainObject(pack)) throw PackError('PACK_BAD', 'Pack JSON har fel format (inte objekt).');

  const id = asTextSafe(pack.id);
  const name = asTextSafe(pack.name);
  const missions = pack.missions;

  if (!id) throw PackError('PACK_ID_MISSING', 'Pack saknar id.');
  if (!name) throw PackError('PACK_NAME_MISSING', 'Pack saknar name.');
  if (!Array.isArray(missions)) throw PackError('PACK_MISSIONS_BAD', 'Pack saknar missions[] eller fel typ.', { packId: id });

  // Fail-closed light: missions entries ska vara objekt (om finns)
  for (let i = 0; i < missions.length; i++) {
    const m = missions[i];
    if (!isPlainObject(m)) {
      throw PackError('PACK_MISSION_BAD', 'missions[] innehåller fel typ (inte objekt).', { packId: id, index: i });
    }
  }

  return { id, name, missionsCount: missions.length };
}

/* ============================================================
   BLOCK 7 — Public API
   KRAV: loadZonePack(zoneId) → fetch /data/packs/...json via index
============================================================ */
let _zonesIndexCache = null; // in-memory only (ingen storage) // HOOK: zones-index-cache

export async function loadZonesIndex({ force = false } = {}) {
  if (_zonesIndexCache && !force) return _zonesIndexCache;

  const idx = await fetchJson(ZONES_INDEX_PATH);
  const map = validateZonesIndex(idx);
  _zonesIndexCache = map;
  return map;
}

/**
 * loadZonePack(zoneId)
 * - Slår upp zon i zones.index.json
 * - Hämtar /data/packs/<file>.json
 * - Validerar minsta pack-fält
 */
export async function loadZonePack(zoneId, { forceIndex = false } = {}) {
  const zid = asTextSafe(zoneId);
  if (!zid) throw PackError('ZONE_ID_MISSING', 'zoneId saknas.');

  const indexMap = await loadZonesIndex({ force: forceIndex });
  const entry = indexMap.get(zid);

  if (!entry) {
    throw PackError('ZONE_NOT_FOUND', 'Zon finns inte i index.', { zoneId: zid });
  }

  const packUrl = `${PACKS_BASE_PATH}${entry.file}`;
  const pack = await fetchJson(packUrl);

  // Validera pack
  validateZonePack(pack);

  // Returnera pack (som-is) – UI/engine kan tolka vidare i senare AO
  return pack;
}
