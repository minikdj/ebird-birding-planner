#!/usr/bin/env node
// Triage script — called by the Anthropic Routine agent at 4:00 AM ET.
// Fetches BirdCast + NWS data and prints a JSON decision summary to stdout.
// Exit 0 always (errors are captured in the JSON).

import { BirdCastClient, degreesToCardinal } from '../src/birdcast-client.js';
import { NWSClient } from '../src/nws-client.js';
import { EBirdClient } from '../src/ebird-client.js';
import { DEFAULTS, formatNumber, toYMD, FAVORABLE_WINDS, POOR_WINDS } from '../src/utils.js';

async function main() {
  const ebirdKey = (process.env.EBIRD_API_KEY || '').trim();
  const birdcastKey = (process.env.BIRDCAST_API_KEY || '').trim();

  if (!ebirdKey || !birdcastKey) {
    process.stdout.write(JSON.stringify({ error: 'Missing API keys', sendBriefing: false }, null, 2) + '\n');
    return;
  }

  const lat = parseFloat(process.env.BRIEFING_LAT || String(DEFAULTS.lat));
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) { process.stderr.write('Warning: BRIEFING_LAT invalid\n'); }
  const lng = parseFloat(process.env.BRIEFING_LNG || String(DEFAULTS.lng));
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) { process.stderr.write('Warning: BRIEFING_LNG invalid\n'); }
  const region = (process.env.BRIEFING_REGION || DEFAULTS.regionCode).trim();
  if (!/^[A-Z]{2}-[A-Z]{2,3}(-\d{1,3})?$/i.test(region)) {
    process.stdout.write(JSON.stringify({ error: `BRIEFING_REGION "${region}" is not a valid eBird region code (expected format: US-OH or US-OH-061)`, sendBriefing: false }, null, 2) + '\n');
    return;
  }

  const birdcast = new BirdCastClient(birdcastKey);
  const nws = new NWSClient();
  const ebird = new EBirdClient(ebirdKey);

  const today = toYMD(new Date());

  const [live, season, weather, notableObs] = await Promise.all([
    birdcast.getLiveMigration(region, today).catch(() => null),
    birdcast.getSeasonHistorical(region, today).catch(() => null),
    nws.getBirdingWeather(lat, lng, today).catch(() => null),
    ebird.getNearbyNotableObservations(lat, lng, 2, 50).catch(() => null),
  ]);

  let migrationScore = 0;

  if (live?.isHigh === true) {
    migrationScore += 4;
  }

  const cumBirds = live?.cumulativeBirds ?? 0;
  if (cumBirds > 500000) {
    migrationScore += 3;
  } else if (cumBirds > 100000) {
    migrationScore += 2;
  } else if (cumBirds > 50000) {
    migrationScore += 1;
  }

  const notableSpecies = Array.isArray(notableObs)
    ? [...new Set(notableObs.map((o) => o.comName).filter(Boolean))]
    : [];

  if (notableSpecies.length > 0) {
    migrationScore += 2;
  }

  const overnightWind = weather?.overnight?.windDirection?.toUpperCase() ?? '';
  const overnightPrecip = weather?.overnight?.precipProbability ?? null;

  // Use shared FAVORABLE_WINDS / POOR_WINDS from utils (imported at top)
  if (FAVORABLE_WINDS.has(overnightWind) && overnightPrecip != null && overnightPrecip < 30) {
    migrationScore += 2;
  } else if (POOR_WINDS.has(overnightWind) && overnightPrecip != null && overnightPrecip > 60) {
    migrationScore -= 2;
  }

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

  if (migrationScore >= 5 || live?.isHigh === true || notableSpecies.length > 0) {
    recommendation = 'FULL_BRIEFING';
    const reasons = [];
    if (live?.isHigh) reasons.push('High migration intensity (isHigh flag)');
    if (migrationScore >= 5) reasons.push(`Migration score ${migrationScore}/10`);
    if (notableSpecies.length > 0) reasons.push(`${notableSpecies.length} notable species`);
    if (overnightWind === 'S' || overnightWind === 'SW') reasons.push('favorable weather');
    recommendationReason = reasons.join(' + ');
  } else if (migrationScore >= 2) {
    recommendation = 'QUIET_PERIOD';
    recommendationReason = `Migration score ${migrationScore}/10, no notable species`;
  } else {
    recommendation = 'SILENT_SKIP';
    recommendationReason = `Low migration score (${migrationScore}/10)`;
  }

  const output = {
    date: today,
    region,
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
