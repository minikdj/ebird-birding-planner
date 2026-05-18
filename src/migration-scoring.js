// migration-scoring.js — unified migration favorability scoring.
//
// Replaces three parallel implementations that drifted:
//   - scripts/triage.js:        env-overridable bird thresholds + wind/precip
//                               bonuses, FULL/QUIET thresholds at 5/2.
//   - scripts/aggregate.js:     hard-coded outlook ratings derived from
//                               cumulativeBirds + favorable/poor wind.
//   - src/index.js:             compact 0..3 score used to rank dates in
//                               handleBestDayToBird.
//
// One function — rateNight(live, weather, thresholds) — returns
//   { score, rating, reasons }
// where:
//   - score is the same additive integer that triage.js used (can be < 0),
//   - rating is the categorical bucket used by aggregate.buildOutlook,
//   - reasons is a short list of human-readable score contributors.

import { FAVORABLE_WINDS, POOR_WINDS } from './utils.js';

/**
 * Default scoring thresholds. All values can be overridden via env vars
 * by calling loadThresholdsFromEnv(); .env.example documents each.
 */
export const DEFAULT_THRESHOLDS = Object.freeze({
  // BirdCast cumulativeBirds tiers (triage.js parity)
  highBirds:     500_000,
  mediumBirds:   100_000,
  lowBirds:      50_000,

  // Aggregate outlook tier (used when isHigh=false but birds are very heavy)
  excellentBirds: 300_000,

  // Decision thresholds (triage.js parity)
  fullThreshold:  5,
  quietThreshold: 2,

  // Wind/precip bonus magnitudes
  favorableBonus: 2,
  poorPenalty:    2,
  notableBonus:   2,
  isHighBonus:    4,

  // Wind/precip cutoffs
  favorablePrecipMax: 30, // strictly <
  poorPrecipMin:      60, // strictly >
});

/**
 * Build a thresholds object from environment overrides, falling back to defaults.
 * Mirrors the BRIEFING_SCORE_* names already documented in .env.example.
 */
export function loadThresholdsFromEnv(env = process.env) {
  const num = (key, fallback) => {
    const raw = env[key];
    if (raw == null || String(raw).trim() === '') return fallback;
    const n = parseInt(String(raw).trim(), 10);
    return Number.isFinite(n) ? n : fallback;
  };
  return Object.freeze({
    ...DEFAULT_THRESHOLDS,
    highBirds:      num('BRIEFING_SCORE_HIGH_BIRDS',  DEFAULT_THRESHOLDS.highBirds),
    mediumBirds:    num('BRIEFING_SCORE_MED_BIRDS',   DEFAULT_THRESHOLDS.mediumBirds),
    lowBirds:       num('BRIEFING_SCORE_LOW_BIRDS',   DEFAULT_THRESHOLDS.lowBirds),
    fullThreshold:  num('BRIEFING_FULL_THRESHOLD',    DEFAULT_THRESHOLDS.fullThreshold),
    quietThreshold: num('BRIEFING_QUIET_THRESHOLD',   DEFAULT_THRESHOLDS.quietThreshold),
  });
}

/**
 * Rate one night's migration favorability.
 *
 * @param {object|null} live      BirdCast live-migration object (or null when
 *                                outside season / unavailable). Reads:
 *                                  - cumulativeBirds (number|null)
 *                                  - isHigh (boolean|null)
 * @param {object|null} weather   NWS weather object (or null). Reads:
 *                                  - overnight.windDirection (string, e.g. "S")
 *                                  - overnight.precipProbability (0-100)
 * @param {object} [opts]
 * @param {number} [opts.notableSpeciesCount=0]  count of nearby notables (triage only)
 * @param {object} [opts.thresholds]             override default thresholds
 * @returns {{ score: number, rating: string, reasons: string[] }}
 *
 * `score` matches scripts/triage.js's prior scoring formula exactly so the
 * unit-test inlined logic continues to pass.
 *
 * `rating` is one of:
 *   'Excellent' | 'Good' | 'Moderate' | 'Quiet' | 'Poor'
 * derived from cumulativeBirds + isHigh + wind/precip favorability — same
 * decision tree previously embedded in aggregate.buildOutlook.
 */
export function rateNight(live, weather, opts = {}) {
  const t = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const notableSpeciesCount = opts.notableSpeciesCount ?? 0;

  const isHigh = live?.isHigh === true;
  const cumBirds = live?.cumulativeBirds ?? 0;
  const wind = (weather?.overnight?.windDirection ?? '').toUpperCase();
  const overnightPrecip = weather?.overnight?.precipProbability ?? null;

  const favorable = FAVORABLE_WINDS.has(wind)
    && overnightPrecip != null
    && overnightPrecip < t.favorablePrecipMax;
  const poor = POOR_WINDS.has(wind)
    && overnightPrecip != null
    && overnightPrecip > t.poorPrecipMin;

  // ---- Numeric score (triage.js parity) -----------------------------------
  let score = 0;
  const reasons = [];

  if (isHigh) {
    score += t.isHighBonus;
    reasons.push('high migration intensity');
  }

  if (cumBirds > t.highBirds) {
    score += 3;
    reasons.push(`${cumBirds.toLocaleString()} birds aloft`);
  } else if (cumBirds > t.mediumBirds) {
    score += 2;
    reasons.push(`${cumBirds.toLocaleString()} birds aloft`);
  } else if (cumBirds > t.lowBirds) {
    score += 1;
    reasons.push(`${cumBirds.toLocaleString()} birds aloft`);
  }

  if (notableSpeciesCount > 0) {
    score += t.notableBonus;
    reasons.push(`${notableSpeciesCount} notable species nearby`);
  }

  if (favorable) {
    score += t.favorableBonus;
    reasons.push(`favorable ${wind} winds`);
  } else if (poor) {
    score -= t.poorPenalty;
    reasons.push(`poor ${wind} winds + rain`);
  }

  // ---- Categorical rating (aggregate.buildOutlook parity) -----------------
  // Soft favorable/poor for rating: looks at wind even when precip is unknown,
  // matching the old buildOutlook semantics ((overnightPrecip ?? 100) < 30).
  const softFavorable = FAVORABLE_WINDS.has(wind) && (overnightPrecip ?? 100) < t.favorablePrecipMax;
  const softPoor      = POOR_WINDS.has(wind)      || (overnightPrecip ?? 0)   > t.poorPrecipMin;

  let rating;
  if (isHigh || (cumBirds > t.excellentBirds && softFavorable)) {
    rating = 'Excellent';
  } else if (cumBirds > t.mediumBirds && softFavorable) {
    rating = 'Good';
  } else if (cumBirds > (t.lowBirds / 2) && cumBirds > 0 && !softPoor) {
    // Matches aggregate's `birds > 50_000 && !poor` → 'Moderate'
    // Note: divide-by-2 reproduces the original literal 50_000 cutoff when
    // lowBirds is 100_000 elsewhere; with default lowBirds=50k this equals
    // 25k which is more generous. The original literal was 50_000, so:
    rating = cumBirds > 50_000 && !softPoor ? 'Moderate' : (softPoor ? 'Poor' : 'Quiet');
  } else if (softPoor) {
    rating = 'Poor';
  } else {
    rating = 'Quiet';
  }

  return { score, rating, reasons };
}

/**
 * Map a raw score to a recommendation bucket.
 * Returns one of: 'FULL_BRIEFING' | 'QUIET_PERIOD' | 'SILENT_SKIP'.
 *
 * Caller may override by passing thresholds; see DEFAULT_THRESHOLDS.
 */
export function recommendationForScore(score, thresholds = DEFAULT_THRESHOLDS) {
  if (score >= thresholds.fullThreshold) return 'FULL_BRIEFING';
  if (score >= thresholds.quietThreshold) return 'QUIET_PERIOD';
  return 'SILENT_SKIP';
}

/**
 * Compact 0..N integer used by best_day_to_bird to rank candidate days.
 * Matches the old `bcData.isHigh ? 3 : birds > 100000 ? 2 : birds > 10000 ? 1 : 0`
 * rubric so the date-ranking behaviour is preserved.
 */
export function compactDayScore(live, thresholds = DEFAULT_THRESHOLDS) {
  if (!live) return 0;
  if (live.isHigh) return 3;
  const birds = live.cumulativeBirds ?? 0;
  if (birds > thresholds.mediumBirds) return 2;
  if (birds > 10_000) return 1;
  return 0;
}
