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
import { DEFAULTS, formatNumber, toYMD, computeActivityCutoff, FAVORABLE_WINDS, POOR_WINDS } from '../src/utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


// Use configured timezone (or default to Eastern) so times display correctly
// regardless of the server's local timezone (cloud runners are typically UTC).
const DISPLAY_TZ = process.env.BRIEFING_TIMEZONE || 'America/New_York';

function formatTime(date) {
  if (!date || isNaN(date.getTime())) return null;
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: DISPLAY_TZ,
  });
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
 * Derive a daylight / birding window from suncalc for a given date + coordinates.
 * Returns formatted times plus the raw sunrise Date for activity cutoff computation.
 */
function buildBirdingWindow(dateStr, lat, lng) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const times = suncalc.getTimes(d, lat, lng);
  return {
    civilTwilight: formatTime(times.dawn),
    sunrise: formatTime(times.sunrise),
    goldenHourEnd: formatTime(times.goldenHourEnd), // suncalc: end of morning golden hour
    solarNoon: formatTime(times.solarNoon),
    sunset: formatTime(times.sunset),
    _sunriseDate: times.sunrise, // raw Date for computeActivityCutoff; stripped from output below
  };
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
        stdio: 'inherit',
        env: { ...process.env, EBIRD_LIFE_LIST_CSV: csvPath },
      });
    }
  } catch {
    // CSV or JSON missing — silently skip; build-life-list.js will handle errors if called directly
  }
}
maybeRefreshLifeList();

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
 * Load the user's life list from data/life-list.json.
 * Returns a Set of normalized species names (lowercase, parentheticals stripped).
 * Returns null if the file is missing or unreadable.
 */
function loadLifeList() {
  try {
    const lifeListPath = new URL('../data/life-list.json', import.meta.url);
    const raw = readFileSync(fileURLToPath(lifeListPath), 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.species)) {
      process.stderr.write('aggregate.js: life-list.json has no species array\n');
      return { set: null, total: 0, source: 'data/life-list.json' };
    }
    const normalizedSet = new Set(
      data.species.map(name => name.replace(/\s*\([^)]*\)\s*$/, '').toLowerCase().trim())
    );
    return { set: normalizedSet, total: data.totalSpecies, source: 'data/life-list.json' };
  } catch (err) {
    process.stderr.write(`aggregate.js: Could not load life list — ${err.message}\n`);
    return null;
  }
}

/**
 * Check if a species name is NOT in the life list (i.e., it would be a lifer).
 * @param {string} speciesName - common name of the species
 * @param {{ set: Set<string> } | null} lifeList
 * @returns {boolean} true if this species is NOT on the life list
 */
function isLiferOpportunity(speciesName, lifeList) {
  if (!lifeList || !lifeList.set) return false;
  const normalized = speciesName.replace(/\s*\([^)]*\)\s*$/, '').toLowerCase().trim();
  return !lifeList.set.has(normalized);
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
      birdcast.getLiveMigration(config.region, dateStr).catch(() => null),
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
    const birdingWindow = buildBirdingWindow(dateStr, config.lat, config.lng);

    const favorable = FAVORABLE_WINDS.has(wind ?? '') && (overnightPrecip ?? 100) < 30;
    const poor = POOR_WINDS.has(wind ?? '') || (overnightPrecip ?? 0) > 60;

    let outlookRating;
    if (isHigh || (birds > 300_000 && favorable)) outlookRating = 'Excellent';
    else if (birds > 100_000 && favorable) outlookRating = 'Good';
    else if (birds > 50_000 && !poor) outlookRating = 'Moderate';
    else if (poor) outlookRating = 'Poor';
    else outlookRating = 'Quiet';

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

  // Sequential with 300ms stagger to avoid NWS rate limiting
  const outlookResults = [];
  for (const i of [1, 2, 3, 4, 5]) {
    try {
      outlookResults.push(await buildDay(i));
    } catch (err) {
      process.stderr.write(`buildOutlook day ${i} failed: ${err.message}\n`);
      outlookResults.push(null);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return outlookResults;
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
  const ebirdKey = (process.env.EBIRD_API_KEY || '').trim();
  const birdcastKey = (process.env.BIRDCAST_API_KEY || '').trim();

  if (!ebirdKey || !birdcastKey) {
    process.stdout.write(JSON.stringify({
      error: 'Missing API keys: EBIRD_API_KEY and BIRDCAST_API_KEY are required',
    }, null, 2) + '\n');
    return;
  }

  // Parse and validate region + coordinates — fall back to defaults if invalid
  const region = (process.env.BRIEFING_REGION || DEFAULTS.regionCode).trim();
  if (!/^[A-Z]{2}-[A-Z]{2,3}(-\d{1,3})?$/i.test(region)) {
    process.stdout.write(JSON.stringify({ error: `BRIEFING_REGION "${region}" is not a valid eBird region code (expected format: US-OH or US-OH-061)` }, null, 2) + '\n');
    return;
  }

  const rawLat = parseFloat(process.env.BRIEFING_LAT || '');
  const rawLng = parseFloat(process.env.BRIEFING_LNG || '');
  const config = {
    lat: Number.isFinite(rawLat) && rawLat >= -90 && rawLat <= 90 ? rawLat : DEFAULTS.lat,
    lng: Number.isFinite(rawLng) && rawLng >= -180 && rawLng <= 180 ? rawLng : DEFAULTS.lng,
    region,
  };
  if (!Number.isFinite(rawLat)) {
    process.stderr.write('aggregate.js: BRIEFING_LAT invalid or unset — using default\n');
  }
  if (!Number.isFinite(rawLng)) {
    process.stderr.write('aggregate.js: BRIEFING_LNG invalid or unset — using default\n');
  }

  const birdcast = new BirdCastClient(birdcastKey);
  const nws = new NWSClient();
  const ebird = new EBirdClient(ebirdKey);
  const ohioBirds = new OhioBirdsClient();

  const today = toYMD(new Date());

  // Load hotspot notes (graceful — returns {} if file missing)
  const hotspotNotes = loadHotspotNotes();

  // Load life list (try/catch inside loadLifeList; returns null if missing)
  const lifeList = loadLifeList();
  if (!lifeList) {
    process.stderr.write('aggregate.js: Life list not loaded — lifer flags will be unavailable\n');
  }

  // --- Phase 1: Fast parallel fetches ---
  const [live, season, expectedSpecies, weather, notableObs, nearbyHotspots, frontalPassageData, ohioBirdsSightings] = await Promise.all([
    birdcast.getLiveMigration(config.region, today).catch(() => null),
    birdcast.getSeasonHistorical(config.region, today).catch(() => null),
    birdcast.getExpectedSpecies(config.region, today, { ignoreSeasonCheck: false }).catch(() => null),
    nws.getBirdingWeather(config.lat, config.lng, today).catch(() => null),
    ebird.getNearbyNotableObservations(config.lat, config.lng, 14, 50).catch(() => []),
    ebird.getNearbyHotspots(config.lat, config.lng, 50).catch(() => []),
    nws.detectFrontalPassage(config.lat, config.lng, today).catch(() => null),
    ohioBirds.getRecentSightings(3).catch(() => []),
  ]);

  // --- Phase 2: Sequential/slower fetches ---
  const [hotspots, outlook] = await Promise.all([
    buildHotspots(nearbyHotspots, ebird, config.lat, config.lng),
    buildOutlook(birdcast, nws, config, today),
  ]);

  // --- Derived / computed values ---
  const birdingWindowRaw = buildBirdingWindow(today, config.lat, config.lng);
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

  // Notable observations — deduplicate by species, keep most recent per species
  const notableMap = new Map();
  for (const obs of (notableObs || [])) {
    if (!obs.comName) continue;
    if (!notableMap.has(obs.comName) || obs.obsDt > notableMap.get(obs.comName).obsDt) {
      notableMap.set(obs.comName, obs);
    }
  }

  // NOTE: Ohio-birds LISTSERV sightings are passed through to listservSightings (below)
  // as raw { subject, url, source } objects rather than merged into notableObservations.
  // The LISTSERV archive exposes subject lines publicly but message bodies require login,
  // so we surface thread subjects as community-buzz context in the email, not as species records.

  const notableObservations = [...notableMap.values()]
    .sort((a, b) => (b.obsDt ?? '').localeCompare(a.obsDt ?? ''))
    .map((o) => ({
      species: o.comName,
      location: o.locName,
      date: o.obsDt,
      count: o.howMany ?? null,
      locId: o.locId ?? null,
      source: o._source ?? 'ebird',
      isLifer: isLiferOpportunity(o.comName, lifeList),
    }));

  // BirdCast plain-English migration summary
  const migrationNarrativeSummary = birdcast.summarizeMigration(live, season);

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
  //   hotspots[], notableObservations[], flags, moon, lifeList, listservSightings

  const liferOpportunities = notableObservations.filter(o => o.isLifer).length;

  const output = {
    date: today,
    region: config.region,
    location: { lat: config.lat, lng: config.lng },

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
      activityCutoff: _sunriseDate && !isNaN(_sunriseDate.getTime())
        ? formatTime(computeActivityCutoff(_sunriseDate, weather?.morning?.tempF ?? null))
        : null,
      note: `Arrive by ${birdingWindow.civilTwilight ?? 'civil twilight'} for peak dawn chorus.`,
    },

    moon: buildMoonInfo(today),

    hotspots,

    notableObservations,

    listservSightings: ohioBirdsSightings ?? [],

    // Life list summary (null if not loaded)
    lifeList: lifeList
      ? { totalSpecies: lifeList.total, source: lifeList.source }
      : null,

    // Convenience flags for the agent
    flags: {
      highMigrationNight: lastNight?.isHigh ?? false,
      hasNotables: notableObservations.length > 0,
      morningRainLikely: (weather?.morning?.precipProbability ?? 0) >= 40,
      favorableOvernightWind: FAVORABLE_WINDS.has(
        weather?.overnight?.windDirection?.toUpperCase() ?? ''
      ),
      frontalPassage: frontalPassageData?.frontalPassage ?? false,
      falloutPotential: frontalPassageData?.falloutPotential ?? false,
      liferOpportunities,
    },
  };

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({
    error: `aggregate.js crashed: ${err.message}`,
  }, null, 2) + '\n');
  process.exit(0);
});
