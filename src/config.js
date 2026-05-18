// config.js — single source of truth for all environment configuration.
//
// Every script and module that reads `process.env.*` should obtain its value
// from `loadConfig()` instead. The only exception is `scripts/build-life-list.js`,
// which validates a homedir-relative CSV path that needs special handling.

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

function assertPositiveInt(name, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name}: ${value} (must be a positive integer)`);
  }
}

function assertNoCRLF(name, value) {
  if (value && /[\r\n]/.test(value)) {
    throw new Error(`Invalid ${name}: contains CR/LF (possible header injection)`);
  }
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

  // Score thresholds — validated as positive integers below.
  const scoreThresholds = {
    highBirds:         parseInt(env.BRIEFING_SCORE_HIGH_BIRDS     || '500000', 10),
    goodBirds:         parseInt(env.BRIEFING_SCORE_GOOD_BIRDS     || '100000', 10),
    moderateBirds:     parseInt(env.BRIEFING_SCORE_MODERATE_BIRDS || '50000',  10),
    fullBriefingScore: parseInt(env.BRIEFING_SCORE_FULL_BRIEFING  || '5',      10),
    quietPeriodScore:  parseInt(env.BRIEFING_SCORE_QUIET_PERIOD   || '2',      10),
  };
  for (const [k, v] of Object.entries(scoreThresholds)) {
    assertPositiveInt(`scoreThresholds.${k}`, v);
  }

  const emailTo   = env.BRIEFING_EMAIL_TO   || null;
  const emailFrom = env.BRIEFING_FROM_EMAIL || null;
  assertNoCRLF('BRIEFING_EMAIL_TO',   emailTo);
  assertNoCRLF('BRIEFING_FROM_EMAIL', emailFrom);

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
    // Legacy flat fields retained for existing consumers.
    scoreHighBirds:     parseIntOr(env.BRIEFING_SCORE_HIGH_BIRDS, 500_000),
    scoreMedBirds:      parseIntOr(env.BRIEFING_SCORE_MED_BIRDS,  100_000),
    scoreLowBirds:      parseIntOr(env.BRIEFING_SCORE_LOW_BIRDS,  50_000),
    fullThreshold:      parseIntOr(env.BRIEFING_FULL_THRESHOLD,   5),
    quietThreshold:     parseIntOr(env.BRIEFING_QUIET_THRESHOLD,  2),

    // Life list (CSV is optional; aggregate also caches it as JSON)
    lifeListCsvPath:    (env.EBIRD_LIFE_LIST_CSV || '').trim() || null,

    // Anthropic API (used by scripts/generate-email.js)
    anthropicApiKey:    env.ANTHROPIC_API_KEY,
    anthropicModel:     env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',

    // Email delivery (used by scripts/send.js)
    resendApiKey:       env.RESEND_API_KEY,
    sendgridApiKey:     env.SENDGRID_API_KEY,
    emailTo,
    emailFrom,  // optional; defaults to @resend.dev test sender in send.js
    forceSend:          env.BRIEFING_FORCE_SEND === 'true',

    // On-demand pipeline focus (used by scripts/generate-email.js)
    briefingFocus:      env.BRIEFING_FOCUS || '',

    // Migration scoring threshold overrides (triage.js + src/migration-scoring.js)
    scoreThresholds:    Object.freeze(scoreThresholds),

    // Test fixture mode (used by triage.js + aggregate.js)
    testFixture:        env.BRIEFING_TEST_FIXTURE || null,
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

/**
 * Return YYYY-MM-DD for the given Date interpreted in the given IANA timezone.
 * @param {Date} date - Defaults to new Date()
 * @param {string} tz  - IANA timezone (e.g. 'America/New_York')
 * @returns {string} 'YYYY-MM-DD'
 */
export function ymdInTimezone(date = new Date(), tz = 'America/New_York') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

/**
 * Return the local wall-clock hour (0-23) for the given ISO timestamp
 * interpreted in the given IANA timezone.
 * @param {string|Date} isoString
 * @param {string} tz
 * @returns {number|null} 0-23, or null if the input doesn't parse
 */
export function localHourInTimezone(isoString, tz = 'America/New_York') {
  const d = isoString instanceof Date ? isoString : new Date(isoString);
  if (isNaN(d)) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', hour12: false,
  }).formatToParts(d);
  const hourPart = parts.find(p => p.type === 'hour');
  if (!hourPart) return null;
  // 'en-US' returns "24" for midnight in hour12:false — normalize to 0
  const h = parseInt(hourPart.value, 10);
  return h === 24 ? 0 : h;
}
