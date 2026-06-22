#!/usr/bin/env node
// aggregate.js — Comprehensive data aggregation for the Routine briefing agent.
//
// Fetches all data sources in parallel and outputs a single JSON blob to stdout.
// The Routine agent reads this JSON, reasons about it, writes the email body,
// then calls send.js to deliver it.
//
// Usage: node scripts/aggregate.js
// Exit 0 always — errors are captured inside the JSON.

import suncalc from 'suncalc';
import { readFileSync } from 'fs';
import { statSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { BirdCastClient, degreesToCardinal } from '../src/birdcast-client.js';
import { NWSClient } from '../src/nws-client.js';
import { EBirdClient } from '../src/ebird-client.js';
import { OhioBirdsClient } from '../src/ohio-birds-client.js';
import { MediaClient } from '../src/media-client.js';
import { formatNumber, toYMD, FAVORABLE_WINDS } from '../src/utils.js';
import { loadLifeListSync, isLifer } from '../src/lifelist.js';
import { rateNight } from '../src/migration-scoring.js';
import { loadConfig } from '../src/config.js';
import { applyTripLeg } from '../src/trip-location.js';
import { buildBirdingWindow } from '../src/birding-window.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


/**
 * Strip control chars and shell metacharacters from untrusted LISTSERV prose,
 * then cap length. Birding subjects only ever need standard punctuation; the
 * allowlist removes anything with no legitimate use that could feed prompt-
 * injection or downstream-shell hazards.
 */
function sanitizeListservText(s, maxLen) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/[\x00-\x1f\x7f]/g, '')   // strip control chars
    .replace(/[<>{}|`\\]/g, '')         // strip chars that have no business in birding subjects
    .slice(0, maxLen)
    .trim();
}

/**
 * Derive a plain-English rain impact note for the morning birding window.
 * Returns null if rain is not a meaningful factor.
 */
function computeRainImpactNote(weather) {
  if (!weather || weather.weatherUnavailable) return null;

  const morningPrecip = weather.morning?.precipProbability ?? 0;
  const overnightPrecip = weather.overnight?.precipProbability ?? 0;

  if (morningPrecip >= 70) {
    return `Heavy rain expected through the morning birding window (${morningPrecip}% chance). ` +
      `Bird activity will be significantly suppressed at all hotspots. ` +
      `Any birds that flew overnight may concentrate at sheltered spots — ` +
      `check tree-line edges and protected marshes.`;
  }

  if (morningPrecip >= 40) {
    return `Moderate rain possible during morning birding hours (${morningPrecip}% chance). ` +
      `Dawn chorus can still be productive before rain arrives, but plan for a shorter window. ` +
      `Activity likely reduced after sunrise.`;
  }

  if (overnightPrecip >= 50 && morningPrecip < 30) {
    return `Rain overnight (${overnightPrecip}% chance) may have grounded migrating birds, ` +
      `creating potential fallout conditions at dawn. Check hotspots early.`;
  }

  return null;
}

/**
 * Compute moon phase and migration relevance for the given date.
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {{ phaseName, illuminationPct, phase, migrationNote }}
 */
function buildMoonInfo(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const moon = suncalc.getMoonIllumination(d);
  // moon.phase: 0=new, 0.25=first quarter, 0.5=full, 0.75=last quarter
  const fraction = moon.fraction; // 0-1 illumination
  const phase = moon.phase;

  let phaseName;
  if (phase < 0.0625 || phase >= 0.9375) phaseName = 'New Moon';
  else if (phase < 0.1875) phaseName = 'Waxing Crescent';
  else if (phase < 0.3125) phaseName = 'First Quarter';
  else if (phase < 0.4375) phaseName = 'Waxing Gibbous';
  else if (phase < 0.5625) phaseName = 'Full Moon';
  else if (phase < 0.6875) phaseName = 'Waning Gibbous';
  else if (phase < 0.8125) phaseName = 'Last Quarter';
  else phaseName = 'Waning Crescent';

  const illuminationPct = Math.round(fraction * 100);

  // Migration note: full/nearly full moon + clear conditions = favorable for nocturnal migration
  let migrationNote = null;
  if (fraction > 0.85) {
    migrationNote = `Full moon (${illuminationPct}% illuminated) — bright nights enhance nocturnal migration; birds can fly longer into the night.`;
  } else if (fraction < 0.15) {
    migrationNote = `New moon (${illuminationPct}% illuminated) — dark nights may concentrate migration in shorter windows around midnight.`;
  }

  return { phaseName, illuminationPct, phase: Math.round(phase * 100) / 100, migrationNote };
}

/**
 * Auto-refresh data/life-list.json if ~/Downloads/ebird_world_life_list.csv
 * (or the path in EBIRD_LIFE_LIST_CSV) is newer than the cached JSON.
 * Silently skips if either file is missing.
 */
function maybeRefreshLifeList() {
  const csvPath = process.env.EBIRD_LIFE_LIST_CSV ||
    `${process.env.HOME}/Downloads/ebird_world_life_list.csv`;
  const jsonPath = new URL('../data/life-list.json', import.meta.url).pathname;
  try {
    const csvMtime = statSync(csvPath).mtimeMs;
    const jsonMtime = statSync(jsonPath).mtimeMs;
    if (csvMtime > jsonMtime) {
      process.stderr.write('Life list CSV is newer than cache — rebuilding data/life-list.json...\n');
      execFileSync(process.execPath, [
        new URL('../scripts/build-life-list.js', import.meta.url).pathname,
      ], {
        // Silence child stdout so it can't corrupt the aggregate JSON envelope
        // on this process's stdout. Keep stderr inherited for diagnostics.
        stdio: ['ignore', 'ignore', 'inherit'],
        env: { ...process.env, EBIRD_LIFE_LIST_CSV: csvPath },
      });
    }
  } catch {
    // CSV or JSON missing — silently skip; build-life-list.js will handle errors if called directly
  }
}

/**
 * Load hotspot micro-habitat notes from data/hotspot-notes.json.
 * Returns an object keyed by eBird locId. Gracefully returns {} if missing.
 */
function loadHotspotNotes() {
  let hotspotNotes = {};
  try {
    hotspotNotes = JSON.parse(readFileSync(new URL('../data/hotspot-notes.json', import.meta.url)));
  } catch { /* optional — graceful if missing */ }
  return hotspotNotes;
}

/**
 * Load the static island birding guide for the active trip leg from
 * data/hawaii-hotspot-notes.json, keyed by guideKey (e.g. "kauai"). Returns
 * null when not on a trip or the file/key is missing. This is the stable
 * "where to go + what to target" reference layer that complements the live
 * eBird feed for the island.
 */
function loadTripGuide(guideKey) {
  if (!guideKey) return null;
  try {
    const all = JSON.parse(readFileSync(new URL('../data/hawaii-hotspot-notes.json', import.meta.url)));
    return all[guideKey] || null;
  } catch {
    return null;
  }
}

// Life list loading + lifer check are unified in src/lifelist.js
// (single source of truth for both the pipeline and the MCP server).
const LIFE_LIST_JSON_PATH = fileURLToPath(new URL('../data/life-list.json', import.meta.url));
function loadLifeList() {
  return loadLifeListSync({ jsonPath: LIFE_LIST_JSON_PATH });
}

/**
 * Build last-night migration summary from BirdCast live data.
 */
function buildLastNight(live) {
  if (!live) return null;

  const peakInterval = Array.isArray(live.nightSeries) && live.nightSeries.length > 0
    ? live.nightSeries.reduce(
        (best, cur) => (cur.numAloft > (best?.numAloft ?? -1) ? cur : best),
        null
      )
    : null;

  return {
    cumulativeBirds: live.cumulativeBirds ?? null,
    formattedCount: live.cumulativeBirds != null ? formatNumber(live.cumulativeBirds) : null,
    isHigh: live.isHigh ?? null,
    seasonName: live.season?.name ?? null,
    peakFlightDirection: peakInterval?.avgDirection != null
      ? degreesToCardinal(peakInterval.avgDirection)
      : null,
    peakFlightSpeedMph: peakInterval?.avgSpeed != null ? Math.round(peakInterval.avgSpeed) : null,
    peakMeanAltitudeM: peakInterval?.meanHeight != null ? Math.round(peakInterval.meanHeight) : null,
  };
}

/**
 * Build season comparison from BirdCast season historical data.
 */
function buildSeasonStatus(season) {
  if (!season) return null;

  const currentSeries = season.season?.currentSeasonSeries;
  const avgSeries = season.season?.annualAvgSeries;

  if (!Array.isArray(currentSeries) || !Array.isArray(avgSeries)) return null;

  const latestCurrent = currentSeries[currentSeries.length - 1];
  const latestAvg = avgSeries[avgSeries.length - 1];

  const currentTotal = latestCurrent?.totalBirds ?? latestCurrent?.value
    ?? (typeof latestCurrent === 'number' ? latestCurrent : null);
  const avgTotal = latestAvg?.totalBirds ?? latestAvg?.value
    ?? (typeof latestAvg === 'number' ? latestAvg : null);

  if (currentTotal == null || avgTotal == null || avgTotal === 0) return null;

  const pct = Math.round(((currentTotal - avgTotal) / avgTotal) * 100);

  // Weekly trend
  const weeklySeries = season.nightWeeklyAvgSeries;
  let weeklyTrend = null;
  if (Array.isArray(weeklySeries) && weeklySeries.length >= 2) {
    const last = weeklySeries[weeklySeries.length - 1]?.numAloft
      ?? weeklySeries[weeklySeries.length - 1]?.value
      ?? (typeof weeklySeries[weeklySeries.length - 1] === 'number'
        ? weeklySeries[weeklySeries.length - 1] : null);
    const prev = weeklySeries[weeklySeries.length - 2]?.numAloft
      ?? weeklySeries[weeklySeries.length - 2]?.value
      ?? (typeof weeklySeries[weeklySeries.length - 2] === 'number'
        ? weeklySeries[weeklySeries.length - 2] : null);
    if (last != null && prev != null) {
      weeklyTrend = last > prev ? 'building' : last < prev ? 'declining' : 'steady';
    }
  }

  return {
    currentSeasonTotal: currentTotal,
    formattedCurrentTotal: formatNumber(currentTotal),
    historicalAvgTotal: avgTotal,
    formattedHistoricalAvg: formatNumber(avgTotal),
    percentVsAverage: pct,
    comparisonNote: pct > 0
      ? `above average by ${Math.abs(pct)}%`
      : pct < 0
      ? `below average by ${Math.abs(pct)}%`
      : 'on par with historical average',
    weeklyTrend,
  };
}

/**
 * Build the 5-day forward outlook (days 1–5 from today).
 * All 5 days are fetched in parallel. Dates are derived from `today` (string)
 * to avoid new Date() skew near midnight.
 */
async function buildOutlook(birdcast, nws, config, today) {
  // Derive future dates from the `today` string, not from re-calling new Date(),
  // to avoid off-by-one when the script runs near midnight.
  const [todayYear, todayMonth, todayDay] = today.split('-').map(Number);

  const buildDay = async (i) => {
    const d = new Date(Date.UTC(todayYear, todayMonth - 1, todayDay + i));
    const dateStr = toYMD(d);
    const dayLabel = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
    const dayShort = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

    const [live, weather] = await Promise.all([
      // Skip BirdCast on non-CONUS legs (no coverage; avoids per-day timeouts).
      config.skipBirdcast === true
        ? Promise.resolve(null)
        : birdcast.getLiveMigration(config.region, dateStr).catch(() => null),
      nws.getBirdingWeather(config.lat, config.lng, dateStr).catch(() => null),
    ]);

    const birds = live?.cumulativeBirds ?? 0;
    const isHigh = live?.isHigh ?? false;
    const wind = weather?.overnight?.windDirection ?? null;
    const windSpeed = weather?.overnight?.windSpeedMph ?? null;
    const overnightPrecip = weather?.overnight?.precipProbability ?? null;
    const morningPrecip = weather?.morning?.precipProbability ?? null;
    const morningTemp = weather?.morning?.tempF ?? null;
    const cloudCover = weather?.overnight?.cloudCover ?? null;
    const rainImpactNote = computeRainImpactNote(weather);
    const birdingWindowRaw = buildBirdingWindow(dateStr, config.lat, config.lng, config.timezone, morningTemp);
    // Strip the raw sunrise Date — outlook day rows don't need it.
    const { _sunriseDate: _outlookSunriseDate, ...birdingWindow } = birdingWindowRaw;

    // Categorical outlook rating — unified via src/migration-scoring.js
    const { rating: outlookRating } = rateNight(live, weather);

    return {
      dateStr,
      dayLabel,
      dayShort,
      migrationBirds: birds,
      formattedBirds: birds > 0 ? formatNumber(birds) : null,
      isHigh,
      overnight: { windDirection: wind, windSpeedMph: windSpeed, precipProbability: overnightPrecip, cloudCover },
      morning: { precipProbability: morningPrecip, tempF: morningTemp },
      rainImpactNote,
      birdingWindow,
      outlookRating,
    };
  };

  // Parallel: per-client throttling already handles NWS rate limiting,
  // so we don't need an inter-day setTimeout stagger.
  return Promise.all([1, 2, 3, 4, 5].map(async (i) => {
    try {
      return await buildDay(i);
    } catch (err) {
      process.stderr.write(`buildOutlook day ${i} failed: ${err.message}\n`);
      return null;
    }
  }));
}

/**
 * Rank nearby hotspots by 7-day species count (community activity proxy).
 * Returns top 5 with notable species at each.
 */
async function buildHotspots(nearbyHotspots, ebird, lat, lng) {
  if (!Array.isArray(nearbyHotspots) || nearbyHotspots.length === 0) return [];

  const candidates = nearbyHotspots
    .sort((a, b) => (b.numSpeciesAllTime ?? 0) - (a.numSpeciesAllTime ?? 0))
    .slice(0, 20);

  const results = [];
  for (let i = 0; i < candidates.length; i += 5) {
    const chunk = candidates.slice(i, i + 5);
    const chunkResults = await Promise.all(chunk.map(async (h) => {
      const obs7day = await ebird.getRecentObservations(h.locId, 7).catch(() => []);
      const species7 = new Set((obs7day || []).map((o) => o.speciesCode).filter(Boolean));

      return {
        name: h.locName,
        locId: h.locId,
        allTimeSpecies: h.numSpeciesAllTime ?? 0,
        speciesCount7Day: species7.size,
        // Note: hotspot-level notables are not reliably extractable from getRecentObservations.
        // The top-level notableObservations field (from getNearbyNotableObservations) is the
        // canonical source — the agent can cross-reference by location name.
      };
    }));
    results.push(...chunkResults);
  }
  const hotspotData = results;

  return hotspotData
    .filter((h) => h.speciesCount7Day > 0)
    .sort((a, b) => b.speciesCount7Day - a.speciesCount7Day)
    .slice(0, 5);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // TEST FIXTURE MODE — bypass all API calls with pre-baked scenario data.
  // Usage: BRIEFING_TEST_FIXTURE=full_lifer node scripts/aggregate.js
  // Scenarios: full_lifer  full_rain  full_fallout  quiet_period  silent_skip
  const fixture = (process.env.BRIEFING_TEST_FIXTURE || '').trim();
  if (fixture) {
    try {
      const data = readFileSync(new URL(`./fixtures/aggregate-${fixture}.json`, import.meta.url), 'utf8');
      // Apply schema-contract guarantees even to fixture data so downstream
      // consumers (and tests) see the same shape as a live run:
      //   - strip listservSightings[].body (security: prompt-injection defense)
      //   - ensure sourceStatus exists (operability contract)
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed.listservSightings)) {
        parsed.listservSightings = parsed.listservSightings.map(({ body, ...rest }) => rest);
      }
      if (parsed.sourceStatus == null) {
        parsed.sourceStatus = { fixture: `ok: ${fixture}` };
      }
      process.stdout.write(JSON.stringify(parsed, null, 2) + '\n');
    } catch {
      process.stdout.write(JSON.stringify({ error: `Unknown test fixture: "${fixture}". Valid: full_lifer, full_rain, full_fallout, quiet_period` }) + '\n');
    }
    return;
  }

  // Auto-refresh life list cache if the source CSV is newer. Kept out of
  // module-import scope so importers and the fixture short-circuit above
  // never trigger a child process.
  maybeRefreshLifeList();

  let config;
  try {
    // applyTripLeg overrides location (region/coords/timezone/coverage/skipBirdcast)
    // when today falls within a trip itinerary leg; otherwise returns config as-is.
    config = applyTripLeg(loadConfig());
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err.message }, null, 2) + '\n');
    return;
  }

  if (!config.ebirdApiKey || !config.birdcastApiKey) {
    process.stdout.write(JSON.stringify({
      error: 'Missing API keys: EBIRD_API_KEY and BIRDCAST_API_KEY are required',
    }, null, 2) + '\n');
    return;
  }

  const birdcast = new BirdCastClient(config.birdcastApiKey);
  const nws = new NWSClient();
  const ebird = new EBirdClient(config.ebirdApiKey);
  const ohioBirds = new OhioBirdsClient();
  const media = new MediaClient();

  const today = toYMD(new Date());

  // Load hotspot notes (graceful — returns {} if file missing)
  const hotspotNotes = loadHotspotNotes();

  // Load life list (try/catch inside loadLifeList; returns null if missing)
  const lifeList = loadLifeList();
  if (!lifeList) {
    process.stderr.write('aggregate.js: Life list not loaded — lifer flags will be unavailable\n');
  }

  // --- Phase 1: Fast parallel fetches ---
  // Wrap each source with track() so per-source health lands in `sourceStatus`
  // rather than being silently swallowed as null/[]. The prompt can then
  // disclose unavailable sources instead of treating absence as evidence.
  const sourceStatus = {};
  const track = (name, p) =>
    p.then((v) => { sourceStatus[name] = 'ok'; return v; })
     .catch((e) => { sourceStatus[name] = `error: ${String(e?.message || e).slice(0, 200)}`; return null; });

  // LISTSERV is Ohio-specific — only fetch when the region is in US-OH. Non-OH
  // runs (Cape May, California, etc.) would otherwise surface irrelevant Ohio
  // sightings into listservSightings[].
  const isOhioRegion = config.region.startsWith('US-OH');
  const ohioBirdsPromise = isOhioRegion
    ? track('ohioBirds', ohioBirds.getRecentSightings(3))
    : Promise.resolve(null).then((v) => {
        sourceStatus.ohioBirds = 'skipped: non-OH region';
        return v;
      });

  // BirdCast has no coverage outside the continental US (Hawaii, Alaska). On
  // skipBirdcast legs, bypass the three BirdCast calls entirely — they would
  // otherwise each time out (~10s) and add nothing — and mark them skipped.
  const skipBC = config.skipBirdcast === true;
  const bcSkip = (name) => Promise.resolve(null).then((v) => {
    sourceStatus[name] = 'skipped: BirdCast has no coverage for this region';
    return v;
  });

  // Coverage mode (set by applyTripLeg): 'region' = island/region-wide eBird
  // feed via county code; 'radius' = point + radiusKm (Lanai, to stay off Maui).
  // Undefined coverage = normal home behavior (geo, 50km radius).
  const coverage = config.coverage === 'radius' ? 'radius'
    : config.coverage === 'region' ? 'region'
    : null;

  const notablesPromise = coverage === 'region'
    ? track('ebirdNotables', ebird.getRegionNotableObservations(config.region, 14))
    : track('ebirdNotables', ebird.getNearbyNotableObservations(config.lat, config.lng, 14, config.radiusKm || 50));

  const hotspotsPromise = coverage === 'region'
    ? track('ebirdHotspots', ebird.getRegionHotspots(config.region))
    : track('ebirdHotspots', ebird.getNearbyHotspots(config.lat, config.lng, config.radiusKm || 50));

  const [live, season, expectedSpecies, weather, notableObs, nearbyHotspots, frontalPassageData, ohioBirdsSightings] = await Promise.all([
    skipBC ? bcSkip('birdcastLive')     : track('birdcastLive',     birdcast.getLiveMigration(config.region, today)),
    skipBC ? bcSkip('birdcastSeason')   : track('birdcastSeason',   birdcast.getSeasonHistorical(config.region, today)),
    skipBC ? bcSkip('birdcastExpected') : track('birdcastExpected', birdcast.getExpectedSpecies(config.region, today, { ignoreSeasonCheck: false })),
    track('nws',              nws.getBirdingWeather(config.lat, config.lng, today)),
    notablesPromise,
    hotspotsPromise,
    track('frontalPassage',   nws.detectFrontalPassage(config.lat, config.lng, today)),
    ohioBirdsPromise,
  ]);

  // --- Phase 2: Sequential/slower fetches ---
  const [hotspots, outlook] = await Promise.all([
    buildHotspots(nearbyHotspots, ebird, config.lat, config.lng),
    buildOutlook(birdcast, nws, config, today),
  ]);

  // --- Derived / computed values ---
  const birdingWindowRaw = buildBirdingWindow(
    today, config.lat, config.lng, config.timezone, weather?.morning?.tempF ?? null,
  );
  const { _sunriseDate, ...birdingWindow } = birdingWindowRaw;
  const rainImpactNote = computeRainImpactNote(weather);
  const lastNight = buildLastNight(live);
  const seasonStatus = buildSeasonStatus(season);

  // Top expected species (historical frequency, top 20 by probability)
  const topExpectedSpecies = Array.isArray(expectedSpecies)
    ? expectedSpecies.slice(0, 20).map((s) => ({
        name: s.commonName,
        speciesCode: s.speciesCode,
        probability: Math.round((s.probability ?? 0) * 100),
      }))
    : null;

  // Notable observations — group all sightings by species, keep full recent trail.
  //
  // 48h cutoff: convert "YYYY-MM-DD HH:MM" to a numeric YYYYMMDDHHMM integer so
  // both sides of the comparison are in the same units. The cutoff is rendered
  // in the configured DISPLAY_TZ (sv-SE locale -> ISO-like format), then sliced
  // to "YYYY-MM-DD HH:MM" to match obsDt's shape.
  //
  // ASSUMES obsDt is in DISPLAY_TZ. eBird returns obsDt in the observation's
  // local time; we have no per-hotspot tz lookup, so cross-region accuracy is
  // bounded. Documented as Known Limitation in SPEC.
  const obsDtToInt = (s) => {
    if (!s) return 0;
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
    if (!m) return 0;
    return parseInt(m[1] + m[2] + m[3] + m[4] + m[5], 10);
  };
  const cutoffStr = new Date(Date.now() - 48 * 60 * 60 * 1000)
    .toLocaleString('sv-SE', { timeZone: config.timezone })  // "YYYY-MM-DD HH:MM:SS"
    .slice(0, 16);                                            // "YYYY-MM-DD HH:MM"
  const cutoffInt = obsDtToInt(cutoffStr);

  const notableGroupMap = new Map();
  for (const obs of (notableObs || [])) {
    if (!obs.comName) continue;
    if (!notableGroupMap.has(obs.comName)) notableGroupMap.set(obs.comName, []);
    notableGroupMap.get(obs.comName).push(obs);
  }

  // NOTE: Ohio-birds LISTSERV sightings are passed through to listservSightings (below)
  // as raw { subject, url, source } objects rather than merged into notableObservations.
  // The LISTSERV archive exposes subject lines publicly but message bodies require login,
  // so we surface thread subjects as community-buzz context in the email, not as species records.

  const notableObservationsRaw = [...notableGroupMap.entries()]
    .map(([comName, obsList]) => {
      // Sort all observations newest-first
      const sorted = [...obsList].sort((a, b) => (b.obsDt ?? '').localeCompare(a.obsDt ?? ''));
      const mostRecent = sorted[0];

      // All confirmed sightings within the last 48 hours (up to 5), newest first.
      // Used by the Routine to show the full recent location trail in Chase Target cards.
      const recentSightings = sorted
        .filter((o) => obsDtToInt(o.obsDt) >= cutoffInt)
        .slice(0, 5)
        .map((o) => ({
          location: o.locName,
          date: o.obsDt,
          count: o.howMany ?? null,
          locId: o.locId ?? null,
        }));

      return {
        species: comName,
        speciesCode: mostRecent.speciesCode ?? null,
        location: mostRecent.locName,
        date: mostRecent.obsDt,
        count: mostRecent.howMany ?? null,
        locId: mostRecent.locId ?? null,
        source: mostRecent._source ?? 'ebird',
        isLifer: isLifer(comName, lifeList),
        recentSightings,
      };
    })
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

  // Fetch top-rated photos AND audio recordings for notable species in parallel.
  // Cap at 10 species (same as photos) — prioritize lifers and then by order.
  // Photos: Macaulay primary, Wikipedia fallback. Audio: Macaulay only (no fallback).
  // Sort by isLifer desc BEFORE slicing so long common-notable lists can't
  // starve lifer species of photos. Also drop entries missing key fields.
  const mediaTargets = [...notableObservationsRaw]
    .sort((a, b) => Number(b.isLifer) - Number(a.isLifer))
    .slice(0, 10)
    .filter(o => o.speciesCode && o.species)
    .map(o => ({ speciesCode: o.speciesCode, commonName: o.species }));
  const [speciesPhotos, speciesRecordings] = await Promise.all([
    media.getPhotosForSpecies(mediaTargets).catch(() => ({})),
    media.getRecordingsForSpecies(mediaTargets).catch(() => ({})),
  ]);

  const notableObservations = notableObservationsRaw.map(o => ({
    ...o,
    photo: speciesPhotos[o.species] ?? null,
    recording: speciesRecordings[o.species] ?? null,
  }));

  // BirdCast plain-English migration summary — null when either source errored
  // so the prompt cannot confuse "no birds" (real signal) with "BirdCast down"
  // (outage). The prompt rule must fall back to sourceStatus disclosure.
  const migrationNarrativeSummary =
    (sourceStatus.birdcastLive === 'ok' && sourceStatus.birdcastSeason === 'ok')
      ? birdcast.summarizeMigration(live, season)
      : null;

  // ---------------------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------------------

  // SCHEMA CONTRACT: Field names in this output object are referenced by path in
  // routine-prompt.md (Step 3 field list). If you rename or restructure fields,
  // update the prompt documentation to match. Key paths the agent reads:
  //   migration.lastNight, migration.season, migration.topExpectedSpecies,
  //   migration.narrativeSummary, weather.today.overnight, weather.today.morning,
  //   weather.today.rainImpactNote, weather.today.migrationInterpretation,
  //   weather.today.weatherUnavailable, weather.outlook[], birdingWindow,
  //   hotspots[], notableObservations[], flags, moon, lifeList, listservSightings,
  //   hotspotNotes (keyed by locId), sourceStatus
  //
  // sourceStatus — Object mapping source name → 'ok' | 'error: ...'. Per-source
  //   health for every external fetch. The prompt MUST acknowledge unavailable
  //   sources rather than imply absence as evidence (e.g. don't say "no notable
  //   birds reported" when ebirdNotables is in error state — say the source is down).
  // listservSightings[] — { subject, species[], location, url, source }. The `body`
  //   field is intentionally REMOVED for security (prompt-injection defense): anyone
  //   can post to OHIO-BIRDS and the body would otherwise flow unsanitized into the
  //   LLM context. Build "Community Buzz" bullets from species[] + subject + location.
  // notableObservations[].recentSightings — filtered by a 48h cutoff computed
  //   against DISPLAY_TZ-interpreted obsDt; cross-region accuracy depends on each
  //   hotspot's true timezone (approximation; see parseObsDt comment above).
  //
  // notableObservations[].photo — { url, thumbnailUrl, photographer, attribution, source }
  //   or null if no photo found. Macaulay Library (primary) → Wikipedia (fallback).
  //   url = 640px wide (email-safe); thumbnailUrl = 320px (table row thumbnails).
  // notableObservations[].recording — { assetId, listenUrl, recordist, attribution, rating, source }
  //   or null if no recording found. Macaulay Library only (no fallback — Wikipedia has no audio).
  //   listenUrl points at the Macaulay asset page (autoplay-ready audio player + spectrogram).
  //   Email clients sandbox <audio> tags, so the Routine embeds this as a tappable link.
  // notableObservations[].recentSightings — all confirmed sightings of this species within
  //   the last 48 hours (up to 5), sorted newest-first. Each: { location, date, count, locId }.
  //   Use in Chase Target "Where to look" to show the full recent location trail.

  const liferOpportunities = notableObservations.filter(o => o.isLifer).length;

  // Trip context (null on normal home runs). `trip` tells the prompt it is in
  // travel mode (island-wide / resident-focus, BirdCast off); `tripGuide` is the
  // static island birding reference (sites, targets, seasonal + driving notes).
  const trip = config.tripActive
    ? {
        active: true,
        name: config.tripName,
        island: config.tripIsland,
        coverage,
        radiusKm: config.radiusKm ?? null,
        locationName: config.locationName,
      }
    : null;
  const tripGuide = config.tripActive ? loadTripGuide(config.tripGuideKey) : null;

  const output = {
    date: today,
    region: config.region,
    location: { lat: config.lat, lng: config.lng },
    trip,
    tripGuide,

    migration: {
      lastNight,
      season: seasonStatus,
      topExpectedSpecies,
      narrativeSummary: migrationNarrativeSummary,
    },

    weather: {
      today: {
        overnight: weather?.overnight ?? null,
        morning: weather?.morning ?? null,
        migrationInterpretation: weather?.migrationInterpretation ?? null,
        rainImpactNote,
        weatherUnavailable: weather?.weatherUnavailable ?? true,
        frontalPassage: frontalPassageData?.frontalPassage ?? false,
        falloutPotential: frontalPassageData?.falloutPotential ?? false,
        windShiftDetected: frontalPassageData?.windShiftDetected ?? false,
        clearingDetected: frontalPassageData?.clearingDetected ?? false,
        frontalNote: frontalPassageData?.frontalNote ?? null,
      },
      outlook,
    },

    birdingWindow: {
      ...birdingWindow,
      note: `Arrive by ${birdingWindow.civilTwilight ?? 'civil twilight'} for peak dawn chorus.`,
    },

    moon: buildMoonInfo(today),

    hotspots,

    notableObservations,

    // SECURITY: strip `body` — OHIO-BIRDS is public-post and the raw body would
    // flow into the LLM context (which has email-send + scheduling tools).
    // species[] + subject + location is enough for "Community Buzz" bullets.
    // Subject and location are additionally passed through a length+character
    // allowlist before entering aggregate output (strips control chars and
    // shell metas; caps lengths).
    listservSightings: (ohioBirdsSightings ?? []).map(s => ({
      subject: sanitizeListservText(s.subject, 200),
      species: Array.isArray(s.species)
        ? s.species.map(x => sanitizeListservText(x, 60)).filter(Boolean).slice(0, 30)
        : [],
      location: sanitizeListservText(s.location, 100),
      url: s.url,
      source: s.source,
    })),

    // Per-source health: 'ok' or 'error: ...'. See SCHEMA CONTRACT above.
    sourceStatus,

    hotspotNotes,

    // Life list summary (null if not loaded)
    lifeList: lifeList
      ? { totalSpecies: lifeList.total, source: lifeList.source }
      : null,

    // Convenience flags for the agent. Tri-state: when the underlying source
    // is in error, the flag is `null` (unknown) — not `false`. This prevents
    // the prompt from confusing "no notable birds" (real signal) with "eBird
    // returned an error" (outage). Schema and prompt are updated by R2-W2B.
    flags: (() => {
      const ebirdOk        = sourceStatus.ebirdNotables  === 'ok';
      const nwsOk          = sourceStatus.nws            === 'ok';
      const frontalOk      = sourceStatus.frontalPassage === 'ok';
      const birdcastLiveOk = sourceStatus.birdcastLive   === 'ok';
      return {
        highMigrationNight:     birdcastLiveOk ? Boolean(lastNight?.isHigh) : null,
        hasNotables:            ebirdOk        ? notableObservations.length > 0 : null,
        liferOpportunities:     ebirdOk        ? liferOpportunities : null,
        morningRainLikely:      nwsOk          ? (weather?.morning?.precipProbability ?? 0) >= 40 : null,
        favorableOvernightWind: nwsOk          ? FAVORABLE_WINDS.has(weather?.overnight?.windDirection?.toUpperCase() ?? '') : null,
        frontalPassage:         frontalOk      ? (frontalPassageData?.frontalPassage ?? false) : null,
        falloutPotential:       frontalOk      ? (frontalPassageData?.falloutPotential ?? false) : null,
      };
    })(),
  };

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({
    error: `aggregate.js crashed: ${err.message}`,
  }, null, 2) + '\n');
  process.exit(0);
});
