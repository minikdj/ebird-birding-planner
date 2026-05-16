#!/usr/bin/env node
// Triage script — called by the Anthropic Routine agent at 5:45 AM ET.
// Fetches BirdCast + NWS data and prints a JSON decision summary to stdout.
// Exit 0 always (errors are captured in the JSON).

import { BirdCastClient } from '../src/birdcast-client.js';
import { NWSClient } from '../src/nws-client.js';
import { EBirdClient } from '../src/ebird-client.js';
import { DEFAULTS, formatNumber } from '../src/utils.js';

async function main() {
  const ebirdKey = process.env.EBIRD_API_KEY;
  const birdcastKey = process.env.BIRDCAST_API_KEY;

  if (!ebirdKey || !birdcastKey) {
    process.stdout.write(JSON.stringify({ error: 'Missing API keys', sendBriefing: false }, null, 2) + '\n');
    return;
  }

  const lat = parseFloat(process.env.BRIEFING_LAT || String(DEFAULTS.lat));
  const lng = parseFloat(process.env.BRIEFING_LNG || String(DEFAULTS.lng));
  const region = process.env.BRIEFING_REGION || DEFAULTS.regionCode;

  const birdcast = new BirdCastClient(birdcastKey);
  const nws = new NWSClient();
  const ebird = new EBirdClient(ebirdKey);

  const today = new Date().toISOString().split('T')[0];

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

  if ((overnightWind === 'S' || overnightWind === 'SW') && overnightPrecip != null && overnightPrecip < 30) {
    migrationScore += 2;
  } else if ((overnightWind === 'N' || overnightWind === 'NW') && overnightPrecip != null && overnightPrecip > 60) {
    migrationScore -= 2;
  }

  const peakInterval = Array.isArray(live?.nightSeries) && live.nightSeries.length > 0
    ? live.nightSeries.reduce((best, cur) => (cur.numAloft > (best?.numAloft ?? -1) ? cur : best), null)
    : null;

  const peakDir = peakInterval?.avgDirection != null ? cardinalFromDeg(peakInterval.avgDirection) : null;
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

function cardinalFromDeg(degrees) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const index = Math.round(degrees / 45) % 8;
  return dirs[(index + 8) % 8];
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err.message, sendBriefing: false }, null, 2) + '\n');
  process.exit(0);
});
