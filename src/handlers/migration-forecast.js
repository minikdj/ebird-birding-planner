// migration_forecast — BirdCast last-night summary + season + weather enrich.

import { DEFAULTS, resolveDate, resolveLocation } from '../utils.js';
import { getBirdCastData } from './_shared.js';

export const tool = {
  name: 'migration_forecast',
  description:
    "Get BirdCast migration data for a region: last night's traffic, expected species, seasonal totals, and a plain-English summary. Only available during migration seasons (Mar-Jun, Aug-Nov).",
  inputSchema: {
    type: 'object',
    properties: {
      region_code: {
        type: 'string',
        description: 'BirdCast region code (e.g. "US-OH-061"). Defaults to Hamilton County, OH.',
      },
      date: {
        type: 'string',
        description: 'Date for forecast. Defaults to today.',
      },
    },
  },
};

export async function handle(args, ctx) {
  const regionCode = args.region_code || DEFAULTS.regionCode;
  const dateInfo = resolveDate(args.date || 'today') ?? resolveDate('today');

  if (!ctx.clients.birdcast.isInMigrationSeason(dateInfo.date)) {
    return {
      summary: `${dateInfo.date} is outside migration season. BirdCast data is available March 1 - June 15 and August 1 - November 15.`,
      inSeason: false,
      regionCode,
      date: dateInfo.label,
    };
  }

  const bc = await getBirdCastData(regionCode, dateInfo.date, ctx)
    .catch((err) => ({ live: null, season: null, species: null, summary: null, error: err.message }));

  const result = {
    regionCode,
    date: dateInfo.label,
    inSeason: true,
    summary: bc.summary || 'Migration data unavailable for this region/date.',
    expectedSpecies: bc.species?.slice(0, 15) ?? [],
  };

  if (bc.live) {
    result.lastNight = {
      cumulativeBirds: bc.live.cumulativeBirds,
      isHighIntensity: bc.live.isHigh,
    };
    const series = bc.live.nightSeries || [];
    if (series.length > 0) {
      const peak = series.reduce(
        (best, cur) => (cur.numAloft > (best?.numAloft ?? 0) ? cur : best),
        null,
      );
      if (peak) {
        result.lastNight.peakBirdsInFlight = peak.numAloft;
        result.lastNight.peakDirection     = peak.avgDirection;
        result.lastNight.peakSpeed         = peak.avgSpeed;
        result.lastNight.peakAltitude      = peak.meanHeight;
      }
    }
  }

  if (bc.season?.season) {
    const current = bc.season.season.currentSeasonSeries;
    const avg = bc.season.season.annualAvgSeries;
    if (current?.length > 0) {
      const latest = current[current.length - 1];
      result.seasonTotal = latest.totalBirds ?? latest.value ?? latest;
    }
    if (avg?.length > 0) {
      const latestAvg = avg[avg.length - 1];
      result.historicalAverage = latestAvg.totalBirds ?? latestAvg.value ?? latestAvg;
    }
  }

  // Enrich with NWS weather interpretation
  try {
    const resolvedCoords = resolveLocation(regionCode) ?? { lat: ctx.config.lat, lng: ctx.config.lng };
    const weatherLat = resolvedCoords.lat ?? ctx.config.lat;
    const weatherLng = resolvedCoords.lng ?? ctx.config.lng;
    const weather = await ctx.clients.nws.getBirdingWeather(weatherLat, weatherLng, dateInfo.date);
    if (!weather.weatherUnavailable) {
      result.overnightWinds        = weather.overnight;
      result.morningWeather        = weather.morning;
      result.weatherInterpretation = weather.migrationInterpretation;
      result.summary = result.summary + '\n\nWeather: ' + weather.migrationInterpretation;
    }
  } catch { /* weather enrichment is best-effort */ }

  return result;
}
