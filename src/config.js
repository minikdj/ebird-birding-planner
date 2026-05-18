// config.js — single source of truth for environment configuration.
//
// Reads every BRIEFING_*, EBIRD_*, BIRDCAST_*, NWS_* env var the project
// consumes, validates them, and returns a frozen plain object. Entry points
// (src/index.js, scripts/aggregate.js, scripts/triage.js) call loadConfig()
// once at startup; downstream code receives the config object as a parameter
// rather than reading process.env directly.

import { DEFAULTS } from './utils.js';

const REGION_RE = /^[A-Z]{2}-[A-Z]{2,3}(-\d{1,3})?$/i;

function parseFloatOr(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = parseFloat(String(raw).trim());
  return Number.isFinite(n) ? n : fallback;
}

function parseIntOr(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = parseInt(String(raw).trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Build and validate a frozen configuration object from process.env.
 * @returns {Readonly<object>}
 */
export function loadConfig(env = process.env) {
  const region = (env.BRIEFING_REGION || DEFAULTS.regionCode).trim();
  if (!REGION_RE.test(region)) {
    throw new Error(
      `Invalid BRIEFING_REGION "${region}" (expected format like US-OH or US-OH-061)`,
    );
  }

  const lat = parseFloatOr(env.BRIEFING_LAT, DEFAULTS.lat);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new Error(`Invalid BRIEFING_LAT: ${env.BRIEFING_LAT}`);
  }

  const lng = parseFloatOr(env.BRIEFING_LNG, DEFAULTS.lng);
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new Error(`Invalid BRIEFING_LNG: ${env.BRIEFING_LNG}`);
  }

  const timezone = (env.BRIEFING_TIMEZONE || 'America/New_York').trim();

  const config = Object.freeze({
    // API credentials (may be empty — entry points enforce via requireKeys)
    ebirdApiKey:        (env.EBIRD_API_KEY || '').trim(),
    birdcastApiKey:     (env.BIRDCAST_API_KEY || '').trim(),
    nwsContactEmail:    (env.NWS_CONTACT_EMAIL || '').trim() || null,

    // Location
    region,
    lat,
    lng,
    timezone,
    locationName:       (env.BRIEFING_LOCATION_NAME || '').trim() || null,

    // Behaviour flags
    skipBirdcast:       (env.BRIEFING_SKIP_BIRDCAST || '').trim().toLowerCase() === 'true',
    favoriteHotspots:   (env.BRIEFING_FAVORITE_HOTSPOTS || '')
                           .split(',').map(s => s.trim()).filter(Boolean),

    // Triage scoring thresholds (mirror migration-scoring.js defaults)
    scoreHighBirds:     parseIntOr(env.BRIEFING_SCORE_HIGH_BIRDS, 500_000),
    scoreMedBirds:      parseIntOr(env.BRIEFING_SCORE_MED_BIRDS,  100_000),
    scoreLowBirds:      parseIntOr(env.BRIEFING_SCORE_LOW_BIRDS,  50_000),
    fullThreshold:      parseIntOr(env.BRIEFING_FULL_THRESHOLD,   5),
    quietThreshold:     parseIntOr(env.BRIEFING_QUIET_THRESHOLD,  2),

    // Life list (CSV is optional; aggregate also caches it as JSON)
    lifeListCsvPath:    (env.EBIRD_LIFE_LIST_CSV || '').trim() || null,
  });

  return config;
}

/**
 * Throws if any of the named keys is falsy on the config object.
 * Used by entry points that need API access; MCP tool handlers should
 * NOT call this at module load time so the server can boot for a subset.
 */
export function requireKeys(config, keys) {
  const missing = keys.filter(k => !config[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required configuration: ${missing.join(', ')}. ` +
      `Set the corresponding environment variable(s).`,
    );
  }
}
