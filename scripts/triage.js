#!/usr/bin/env node
// Triage script — called by the Anthropic Routine agent at 4:00 AM ET.
// Fetches BirdCast + NWS data and prints a JSON decision summary to stdout.
// Exit 0 always (errors are captured in the JSON).

import { readFileSync } from 'fs';
import { BirdCastClient, degreesToCardinal } from '../src/birdcast-client.js';
import { NWSClient } from '../src/nws-client.js';
import { EBirdClient } from '../src/ebird-client.js';
import { DEFAULTS, formatNumber, toYMD, FAVORABLE_WINDS, RECOMMENDATION } from '../src/utils.js';
import { rateNight, loadThresholdsFromEnv } from '../src/migration-scoring.js';

async function main() {
  // TEST FIXTURE MODE — bypass all API calls with pre-baked scenario data.
  // Usage: BRIEFING_TEST_FIXTURE=full_lifer node scripts/triage.js
  // Scenarios: full_lifer  full_rain  full_fallout  quiet_period  silent_skip
  const fixture = (process.env.BRIEFING_TEST_FIXTURE || '').trim();
  if (fixture) {
    try {
      const data = readFileSync(new URL(`./fixtures/triage-${fixture}.json`, import.meta.url), 'utf8');
      process.stdout.write(data + '\n');
    } catch {
      process.stdout.write(JSON.stringify({ error: `Unknown test fixture: "${fixture}". Valid: full_lifer, full_rain, full_fallout, quiet_period, silent_skip` }) + '\n');
    }
    return;
  }

  const ebirdKey = (process.env.EBIRD_API_KEY || '').trim();
  const birdcastKey = (process.env.BIRDCAST_API_KEY || '').trim();

  if (!ebirdKey || !birdcastKey) {
    process.stdout.write(JSON.stringify({ error: 'Missing API keys', sendBriefing: false }, null, 2) + '\n');
    return;
  }

  const skipBirdCast = (process.env.BRIEFING_SKIP_BIRDCAST || '').trim().toLowerCase() === 'true';

  const lat = parseFloat((process.env.BRIEFING_LAT || String(DEFAULTS.lat)).trim());
  const lng = parseFloat((process.env.BRIEFING_LNG || String(DEFAULTS.lng)).trim());
  if (process.env.BRIEFING_LAT !== undefined) {
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      process.stdout.write(JSON.stringify({ error: 'BRIEFING_LAT is invalid — must be a number between -90 and 90', sendBriefing: false }, null, 2) + '\n');
      return;
    }
  }
  if (process.env.BRIEFING_LNG !== undefined) {
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      process.stdout.write(JSON.stringify({ error: 'BRIEFING_LNG is invalid — must be a number between -180 and 180', sendBriefing: false }, null, 2) + '\n');
      return;
    }
  }
  const region = (process.env.BRIEFING_REGION || DEFAULTS.regionCode).trim();
  if (!/^[A-Z]{2}-[A-Z]{2,3}(-\d{1,3})?$/i.test(region)) {
    process.stdout.write(JSON.stringify({ error: `BRIEFING_REGION "${region}" is not a valid eBird region code (expected format: US-OH or US-OH-061)`, sendBriefing: false }, null, 2) + '\n');
    return;
  }

  // Configurable migration thresholds — unified via src/migration-scoring.js.
  const thresholds = loadThresholdsFromEnv();
  const FULL_THRESHOLD  = thresholds.fullThreshold;
  const QUIET_THRESHOLD = thresholds.quietThreshold;

  const birdcast = new BirdCastClient(birdcastKey);
  const nws = new NWSClient();
  const ebird = new EBirdClient(ebirdKey);

  const today = toYMD(new Date());

  const [live, season, weather, notableObs] = await Promise.all([
    skipBirdCast ? Promise.resolve(null) : birdcast.getLiveMigration(region, today).catch(() => null),
    skipBirdCast ? Promise.resolve(null) : birdcast.getSeasonHistorical(region, today).catch(() => null),
    nws.getBirdingWeather(lat, lng, today).catch(() => null),
    ebird.getNearbyNotableObservations(lat, lng, 2, 50).catch(() => null),
  ]);

  const notableSpecies = Array.isArray(notableObs)
    ? [...new Set(notableObs.map((o) => o.comName).filter(Boolean))]
    : [];

  // Unified scoring (src/migration-scoring.js). Produces the same integer the
  // inlined logic did — see scripts/test-unit.js section 21d which inlines the
  // formula and is guaranteed to keep matching.
  const { score: migrationScore } = rateNight(live, weather, {
    notableSpeciesCount: notableSpecies.length,
    thresholds,
  });

  const overnightWind = weather?.overnight?.windDirection?.toUpperCase() ?? '';

  const peakInterval = Array.isArray(live?.nightSeries) && live.nightSeries.length > 0
    ? live.nightSeries.reduce((best, cur) => (cur.numAloft > (best?.numAloft ?? -1) ? cur : best), null)
    : null;

  const peakDir = peakInterval?.avgDirection != null ? degreesToCardinal(peakInterval.avgDirection) : null;
  const peakSpeedMph = peakInterval?.avgSpeed != null ? Math.round(peakInterval.avgSpeed) : null;

  let seasonStatus = null;
  if (season) {
    const currentSeries = season.season?.currentSeasonSeries;
    const avgSeries = season.season?.annualAvgSeries;
    if (Array.isArray(currentSeries) && currentSeries.length > 0 && Array.isArray(avgSeries) && avgSeries.length > 0) {
      const latestCurrent = currentSeries[currentSeries.length - 1];
      const latestAvg = avgSeries[avgSeries.length - 1];
      const currentTotal = latestCurrent?.totalBirds ?? latestCurrent?.value ?? (typeof latestCurrent === 'number' ? latestCurrent : null);
      const avgTotal = latestAvg?.totalBirds ?? latestAvg?.value ?? (typeof latestAvg === 'number' ? latestAvg : null);
      if (currentTotal != null && avgTotal != null && avgTotal !== 0) {
        const pct = Math.round(((currentTotal - avgTotal) / avgTotal) * 100);
        if (pct > 0) {
          seasonStatus = `above average by ${Math.abs(pct)}%`;
        } else if (pct < 0) {
          seasonStatus = `below average by ${Math.abs(pct)}%`;
        } else {
          seasonStatus = 'on par with historical average';
        }
      }
    }
  }

  const overnightWindStr = weather?.overnight?.windDirection && weather?.overnight?.windSpeedMph != null
    ? `${weather.overnight.windDirection} ${weather.overnight.windSpeedMph}mph`
    : null;

  let recommendation;
  let recommendationReason;

  if (skipBirdCast) {
    // BirdCast skipped (e.g. non-US location): use notable observations to drive the decision.
    // Never SILENT_SKIP — fall back to QUIET_PERIOD so the user always gets a briefing.
    if (notableSpecies.length > 0) {
      recommendation = RECOMMENDATION.FULL_BRIEFING;
      recommendationReason = `BirdCast skipped; ${notableSpecies.length} notable species found`;
    } else {
      recommendation = RECOMMENDATION.QUIET_PERIOD;
      recommendationReason = 'BirdCast skipped; no notable species found';
    }
  } else if (migrationScore >= FULL_THRESHOLD || live?.isHigh === true || notableSpecies.length > 0) {
    recommendation = RECOMMENDATION.FULL_BRIEFING;
    const reasons = [];
    if (live?.isHigh) reasons.push('High migration intensity (isHigh flag)');
    if (migrationScore >= FULL_THRESHOLD) reasons.push(`Migration score ${migrationScore}/10`);
    if (notableSpecies.length > 0) reasons.push(`${notableSpecies.length} notable species`);
    if (FAVORABLE_WINDS.has(overnightWind)) reasons.push('favorable weather');
    recommendationReason = reasons.join(' + ');
  } else if (migrationScore >= QUIET_THRESHOLD) {
    recommendation = RECOMMENDATION.QUIET_PERIOD;
    recommendationReason = `Migration score ${migrationScore}/10, no notable species`;
  } else {
    recommendation = RECOMMENDATION.SILENT_SKIP;
    recommendationReason = `Low migration score (${migrationScore}/10)`;
  }

  // SCHEMA CONTRACT: This JSON output is read by the Routine agent (Step 2 of
  // routine-prompt.md). If you add or rename fields, update the prompt's Step 2
  // field reference list. Key fields the agent reads:
  //   recommendation (FULL_BRIEFING | QUIET_PERIOD | SILENT_SKIP), migrationScore,
  //   notableSpecies[], weather, recommendationReason, birdcastSkipped?
  const output = {
    date: today,
    region,
    ...(skipBirdCast ? { birdcastSkipped: true } : {}),
    migrationScore,
    lastNight: live ? {
      cumulativeBirds: live.cumulativeBirds ?? null,
      formattedCount: live.cumulativeBirds != null ? formatNumber(live.cumulativeBirds) : null,
      isHigh: live.isHigh ?? null,
      peakDirection: peakDir,
      peakSpeedMph,
    } : null,
    notableSpecies,
    notableCount: notableSpecies.length,
    weather: weather ? {
      overnightWind: overnightWindStr,
      precipProbability: weather.overnight?.precipProbability ?? null,
      migrationInterpretation: weather.migrationInterpretation ?? null,
      weatherUnavailable: weather.weatherUnavailable ?? false,
    } : { weatherUnavailable: true },
    seasonStatus,
    recommendation,
    recommendationReason,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err.message, sendBriefing: false }, null, 2) + '\n');
  process.exit(0);
});
