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
import { BirdCastClient, degreesToCardinal } from '../src/birdcast-client.js';
import { NWSClient } from '../src/nws-client.js';
import { EBirdClient } from '../src/ebird-client.js';
import { DEFAULTS, formatNumber, toYMD } from '../src/utils.js';

// ---------------------------------------------------------------------------
// Shared constants — wind direction sets used for outlook rating + flags
// ---------------------------------------------------------------------------

const FAVORABLE_WINDS = new Set(['S', 'SW', 'SSW', 'SE']);
const POOR_WINDS = new Set(['N', 'NW', 'NNW', 'NE']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


function formatTime(date) {
  if (!date || isNaN(date.getTime())) return null;
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

/**
 * Activity cutoff estimate based on temperature.
 * Base: 10:30 AM. Subtract 15 min per 5°F above 75°F. Minimum 6:00 AM.
 */
function computeActivityCutoff(tempF) {
  let cutoffMinutes = 10 * 60 + 30; // 10:30 AM in minutes since midnight
  if (tempF != null && tempF > 75) {
    cutoffMinutes -= Math.floor((tempF - 75) / 5) * 15;
  }
  cutoffMinutes = Math.max(cutoffMinutes, 6 * 60); // clamp >= 6:00 AM
  const h = Math.floor(cutoffMinutes / 60);
  const m = String(cutoffMinutes % 60).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  // Handle 12-hour conversion correctly including h===0 (midnight, unreachable with clamp but safe)
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${m} ${ampm}`;
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
 */
function buildBirdingWindow(dateStr, lat, lng) {
  const d = new Date(dateStr + 'T07:00:00'); // mid-morning local, avoids DST edge
  const times = suncalc.getTimes(d, lat, lng);
  return {
    civilTwilight: formatTime(times.dawn),
    sunrise: formatTime(times.sunrise),
    goldenHourEnd: formatTime(times.goldenHourEnd), // suncalc: end of morning golden hour
    solarNoon: formatTime(times.solarNoon),
    sunset: formatTime(times.sunset),
  };
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

  // All 5 days in parallel
  return Promise.all([1, 2, 3, 4, 5].map(buildDay));
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

  const hotspotData = await Promise.all(
    candidates.map(async (h) => {
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
    })
  );

  return hotspotData
    .filter((h) => h.speciesCount7Day > 0)
    .sort((a, b) => b.speciesCount7Day - a.speciesCount7Day)
    .slice(0, 5);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const ebirdKey = process.env.EBIRD_API_KEY;
  const birdcastKey = process.env.BIRDCAST_API_KEY;

  if (!ebirdKey || !birdcastKey) {
    process.stdout.write(JSON.stringify({
      error: 'Missing API keys: EBIRD_API_KEY and BIRDCAST_API_KEY are required',
    }, null, 2) + '\n');
    return;
  }

  // Parse and validate coordinates — fall back to Cincinnati defaults if invalid
  const rawLat = parseFloat(process.env.BRIEFING_LAT || '');
  const rawLng = parseFloat(process.env.BRIEFING_LNG || '');
  const config = {
    lat: Number.isFinite(rawLat) && rawLat >= -90 && rawLat <= 90 ? rawLat : DEFAULTS.lat,
    lng: Number.isFinite(rawLng) && rawLng >= -180 && rawLng <= 180 ? rawLng : DEFAULTS.lng,
    region: process.env.BRIEFING_REGION || DEFAULTS.regionCode,
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

  const today = toYMD(new Date());

  // --- Phase 1: Fast parallel fetches ---
  const [live, season, expectedSpecies, weather, notableObs, nearbyHotspots] = await Promise.all([
    birdcast.getLiveMigration(config.region, today).catch(() => null),
    birdcast.getSeasonHistorical(config.region, today).catch(() => null),
    birdcast.getExpectedSpecies(config.region, today, { ignoreSeasonCheck: false }).catch(() => null),
    nws.getBirdingWeather(config.lat, config.lng, today).catch(() => null),
    ebird.getNearbyNotableObservations(config.lat, config.lng, 14, 50).catch(() => []),
    ebird.getNearbyHotspots(config.lat, config.lng, 50).catch(() => []),
  ]);

  // --- Phase 2: Sequential/slower fetches ---
  const [hotspots, outlook] = await Promise.all([
    buildHotspots(nearbyHotspots, ebird, config.lat, config.lng),
    buildOutlook(birdcast, nws, config, today),
  ]);

  // --- Derived / computed values ---
  const birdingWindow = buildBirdingWindow(today, config.lat, config.lng);
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
  const notableObservations = [...notableMap.values()]
    .sort((a, b) => (b.obsDt ?? '').localeCompare(a.obsDt ?? ''))
    .map((o) => ({
      species: o.comName,
      location: o.locName,
      date: o.obsDt,
      count: o.howMany ?? null,
      locId: o.locId,
    }));

  // BirdCast plain-English migration summary
  const migrationNarrativeSummary = birdcast.summarizeMigration(live, season);

  // ---------------------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------------------

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
      },
      outlook,
    },

    birdingWindow: {
      ...birdingWindow,
      activityCutoff: computeActivityCutoff(weather?.morning?.tempF),
      note: `Arrive by ${birdingWindow.civilTwilight ?? 'civil twilight'} for peak dawn chorus.`,
    },

    hotspots,

    notableObservations,

    // Convenience flags for the agent
    flags: {
      highMigrationNight: lastNight?.isHigh ?? false,
      hasNotables: notableObservations.length > 0,
      morningRainLikely: (weather?.morning?.precipProbability ?? 0) >= 40,
      favorableOvernightWind: FAVORABLE_WINDS.has(
        weather?.overnight?.windDirection?.toUpperCase() ?? ''
      ),
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
