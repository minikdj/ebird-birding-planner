// _shared.js — internal helpers used by multiple handler modules.
//
// These were previously top-level functions in src/index.js. They depend on
// the context object (`{ clients, config, cache, lifeList }`) rather than
// module-level singletons, so handlers are independently testable.

import {
  Cache,
  resolveLocation,
  DEFAULTS,
  FAVORITE_HOTSPOTS,
  getFavoriteHotspots,
} from '../utils.js';

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}

// TTLs (previously top-level constants in src/index.js)
export const TAXONOMY_TTL  = 7 * 24 * 60 * 60 * 1000;
export const BIRDCAST_TTL  = 24 * 60 * 60 * 1000;
export const HOTSPOT_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

const TAXONOMY_CACHE_KEY = 'taxonomy';

// A module-level cache singleton + in-flight coalesce map. Handlers receive
// the cache via ctx but the in-flight map only needs to live as long as the
// process, so keep it here.
const inflightBirdCast = new Map();

/**
 * Build a fresh shared context. Called once by src/server.js / src/index.js.
 */
export function createContext({ clients, config, lifeList }) {
  return {
    clients,
    config,
    lifeList,
    cache: new Cache(),
  };
}

export function coerceNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Resolve a location string with config defaults as fallback.
 */
export function loc(input, config) {
  return resolveLocation(input) ?? {
    lat: config.lat,
    lng: config.lng,
    regionCode: DEFAULTS.regionCode,
    name: DEFAULTS.name,
  };
}

export async function getTaxonomy(ctx) {
  if (ctx.cache.has(TAXONOMY_CACHE_KEY)) return ctx.cache.get(TAXONOMY_CACHE_KEY);
  const data = await ctx.clients.ebird.getTaxonomy();
  ctx.cache.set(TAXONOMY_CACHE_KEY, data, TAXONOMY_TTL);
  return data;
}

export async function resolveSpeciesCode(commonName, ctx) {
  const taxonomy = await getTaxonomy(ctx);
  const lower = commonName.toLowerCase();
  const match = taxonomy.find((t) => t.comName?.toLowerCase() === lower);
  if (match) return match.speciesCode;
  const partial = taxonomy.find((t) => t.comName?.toLowerCase().includes(lower));
  return partial?.speciesCode ?? null;
}

export async function resolveFavoriteHotspots(ctx) {
  const cacheKey = 'favorite-hotspots';
  if (ctx.cache.has(cacheKey)) return ctx.cache.get(cacheKey);
  try {
    const hotspots = await ctx.clients.ebird.getNearbyHotspots(ctx.config.lat, ctx.config.lng, 30);
    const resolved = FAVORITE_HOTSPOTS.map((fav) => {
      const match = hotspots.find((h) =>
        h.locName?.toLowerCase().includes(fav.name.toLowerCase())
      );
      return { ...fav, locId: match?.locId ?? null, fullName: match?.locName ?? fav.name };
    });
    ctx.cache.set(cacheKey, resolved, HOTSPOT_CACHE_TTL);
    return resolved;
  } catch (err) {
    process.stderr.write(`Failed to resolve favorites: ${err.message}\n`);
    return FAVORITE_HOTSPOTS;
  }
}

export { getFavoriteHotspots };

/**
 * Fetch BirdCast live/season/species data for a region+date with caching
 * and in-flight-request coalescing.
 */
export async function getBirdCastData(regionCode, dateStr, ctx) {
  if (!regionCode) return { live: null, season: null, species: null, summary: null };
  const liveKey    = `bc-live-${regionCode}-${dateStr}`;
  const seasonKey  = `bc-season-${regionCode}-${dateStr}`;
  const speciesKey = `bc-species-${regionCode}-${dateStr}`;

  async function fetchWithCoalesce(cacheKey, fetcher) {
    if (ctx.cache.has(cacheKey)) return ctx.cache.get(cacheKey);
    if (inflightBirdCast.has(cacheKey)) return inflightBirdCast.get(cacheKey);
    const promise = fetcher().then((result) => {
      if (result) ctx.cache.set(cacheKey, result, BIRDCAST_TTL);
      inflightBirdCast.delete(cacheKey);
      return result;
    }).catch((err) => {
      inflightBirdCast.delete(cacheKey);
      throw err;
    });
    inflightBirdCast.set(cacheKey, promise);
    return promise;
  }

  const [live, season, species] = await Promise.all([
    fetchWithCoalesce(liveKey,    () => ctx.clients.birdcast.getLiveMigration(regionCode, dateStr)),
    fetchWithCoalesce(seasonKey,  () => ctx.clients.birdcast.getSeasonHistorical(regionCode, dateStr)),
    fetchWithCoalesce(speciesKey, () => ctx.clients.birdcast.getExpectedSpecies(regionCode, dateStr)),
  ]);

  const summary = ctx.clients.birdcast.summarizeMigration(live, season);
  return { live, season, species, summary };
}

export async function getHotspotSpeciesCounts(hotspots, ctx) {
  const results = [];
  for (let i = 0; i < hotspots.length; i += 10) {
    const batch = hotspots.slice(i, i + 10);
    const batchResults = await Promise.all(
      batch.map(async (h) => {
        try {
          const obs = await ctx.clients.ebird.getRecentObservations(h.locId, 7);
          const speciesSet = new Set(obs.map((o) => o.speciesCode));
          return {
            ...h,
            recentSpeciesCount: speciesSet.size,
            recentObservations: obs,
            speciesList: [...speciesSet],
          };
        } catch (err) {
          process.stderr.write(`getHotspotSpeciesCounts error for ${h.locId}: ${err.message}\n`);
          return { ...h, recentSpeciesCount: 0, recentObservations: [], speciesList: [] };
        }
      })
    );
    results.push(...batchResults);
  }
  return results;
}
