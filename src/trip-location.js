// trip-location.js — itinerary-aware location override.
//
// When a trip itinerary file (data/hawaii-itinerary.json by default) has a leg
// whose date range contains "today" (computed in the itinerary's own timezone),
// the daily report's location is overridden to follow that leg — region, coords,
// coverage mode, display timezone, and skipBirdcast. Outside any leg's date
// range the resolver returns null and the report falls back to the normal home
// (e.g. Ohio) config. This lets the report auto-follow a trip and auto-revert
// afterward with zero manual secret changes mid-trip.
//
// loadConfig() in config.js stays pure (env only); this override is applied
// explicitly by the pipeline entry points: `applyTripLeg(loadConfig())`.

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ymdInTimezone } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ITINERARY_PATH =
  process.env.TRIP_ITINERARY_PATH || join(__dirname, '..', 'data', 'hawaii-itinerary.json');

/**
 * Load and parse a trip itinerary file. Returns null if missing or unreadable
 * (the normal case when not on a trip) — never throws.
 */
export function loadItinerary(itineraryPath = DEFAULT_ITINERARY_PATH) {
  try {
    if (!existsSync(itineraryPath)) return null;
    const raw = readFileSync(itineraryPath, 'utf8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.legs)) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Find the leg whose [start, end] inclusive date range contains todayYmd.
 * Dates are plain "YYYY-MM-DD" strings compared lexicographically, which is
 * correct for that fixed-width format. Returns the leg object or null.
 * @param {object|null} itinerary
 * @param {string} todayYmd - "YYYY-MM-DD"
 */
export function resolveTripLeg(itinerary, todayYmd) {
  if (!itinerary || !Array.isArray(itinerary.legs) || !todayYmd) return null;
  for (const leg of itinerary.legs) {
    if (typeof leg.start !== 'string' || typeof leg.end !== 'string') continue;
    if (todayYmd >= leg.start && todayYmd <= leg.end) return leg;
  }
  return null;
}

/**
 * Apply the active trip leg (if any) to a base config, returning a new frozen
 * config. When no leg is active, returns the base config unchanged.
 *
 * @param {Readonly<object>} config - from loadConfig()
 * @param {{ today?: Date, todayYmd?: string, itinerary?: object|null, itineraryPath?: string }} [opts]
 * @returns {Readonly<object>}
 */
export function applyTripLeg(config, opts = {}) {
  const itinerary = opts.itinerary !== undefined
    ? opts.itinerary
    : loadItinerary(opts.itineraryPath);
  if (!itinerary) return config;

  // Resolve "today" in the itinerary's own timezone so leg boundaries are
  // correct regardless of whether the BRIEFING_TIMEZONE secret has been flipped.
  const tripTz = itinerary.timezone || config.timezone;
  const todayYmd = opts.todayYmd
    || ymdInTimezone(opts.today || new Date(), tripTz);

  const leg = resolveTripLeg(itinerary, todayYmd);
  if (!leg) return config;

  const overridden = {
    ...config,
    region: leg.regionCode || config.region,
    lat: typeof leg.lat === 'number' ? leg.lat : config.lat,
    lng: typeof leg.lng === 'number' ? leg.lng : config.lng,
    locationName: leg.locationName || config.locationName,
    timezone: tripTz,
    skipBirdcast: leg.skipBirdcast === true ? true : config.skipBirdcast,
    // Trip-specific fields consumed by aggregate.js / triage.js:
    coverage: leg.coverage === 'radius' ? 'radius' : 'region',
    radiusKm: typeof leg.radiusKm === 'number' ? leg.radiusKm : null,
    tripActive: true,
    tripName: itinerary.tripName || null,
    tripIsland: leg.island || null,
    tripGuideKey: leg.guideKey || null,
  };
  return Object.freeze(overridden);
}
