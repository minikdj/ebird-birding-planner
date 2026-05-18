// plan_birding_trip — rank nearby hotspots with migration + weather context.

import { DEFAULTS, resolveDate } from '../utils.js';
import {
  coerceNumber, loc, getBirdCastData, getHotspotSpeciesCounts,
  resolveFavoriteHotspots, getFavoriteHotspots,
} from './_shared.js';
import { handle as handleBirdingWindow } from './birding-window.js';

export const tool = {
  name: 'plan_birding_trip',
  description:
    'Plan a birding trip by finding the best nearby hotspots, combining recent species diversity, notable sightings, and BirdCast migration data. Returns ranked hotspots with migration context.',
  inputSchema: {
    type: 'object',
    properties: {
      location: {
        type: 'string',
        description: 'Region code (e.g. "US-OH-061"), lat/lng (e.g. "39.1,-84.5"), or city name (e.g. "Cincinnati"). Defaults to your home location.',
      },
      date: {
        type: 'string',
        description: 'Date for the trip: "today", "tomorrow", "this weekend", "next Saturday", "May 20", or "2026-05-20". Defaults to today.',
      },
      radius_km: {
        type: 'number',
        description: 'Search radius in km (default 30).',
      },
    },
  },
};

export async function handle(args, ctx) {
  const SCORE_SPECIES_WEIGHT = 2;
  const SCORE_NOTABLE_WEIGHT = 5;
  const HOTSPOT_CANDIDATE_LIMIT = 15;

  const location = loc(args.location, ctx.config);
  const dateInfo = resolveDate(args.date || 'today') ?? resolveDate('today');
  const radius = Math.min(Math.max(1, coerceNumber(args.radius_km, DEFAULTS.radiusKm)), 100);
  const { lat, lng, regionCode } = location;

  if (!lat || !lng) {
    return { error: `Cannot determine coordinates for "${args.location}". Try a region code like US-OH-061 or lat/lng.` };
  }

  const [nearbyHotspots, notable, bc, birdingWin, weather] = await Promise.all([
    ctx.clients.ebird.getNearbyHotspots(lat, lng, radius),
    ctx.clients.ebird.getNearbyNotableObservations(lat, lng, 14, radius),
    regionCode
      ? getBirdCastData(regionCode, dateInfo.date, ctx)
      : Promise.resolve({ live: null, season: null, species: null, summary: null }),
    handleBirdingWindow({ lat, lng, date: dateInfo.date }, ctx).catch(() => null),
    ctx.clients.nws.getBirdingWeather(lat, lng, dateInfo.date).catch(() => null),
  ]);

  const topHotspots = nearbyHotspots
    .sort((a, b) => (b.numSpeciesAllTime ?? 0) - (a.numSpeciesAllTime ?? 0))
    .slice(0, HOTSPOT_CANDIDATE_LIMIT);

  const enriched = await getHotspotSpeciesCounts(topHotspots, ctx);

  let favorites = [];
  const favHotspots = getFavoriteHotspots();
  if (favHotspots.length > 0) {
    favorites = await resolveFavoriteHotspots(ctx);
    for (const fav of favorites) {
      if (fav.locId && !enriched.find((h) => h.locId === fav.locId)) {
        try {
          const obs = await ctx.clients.ebird.getRecentObservations(fav.locId, 7);
          const speciesSet = new Set(obs.map((o) => o.speciesCode));
          enriched.push({
            locId: fav.locId,
            locName: fav.fullName,
            recentSpeciesCount: speciesSet.size,
            recentObservations: obs,
            speciesList: [...speciesSet],
            isFavorite: true,
          });
        } catch { /* skip */ }
      }
    }
    for (const h of enriched) {
      if (favorites.some((f) => f.locId === h.locId)) h.isFavorite = true;
    }
  }

  const notableByLoc = {};
  for (const obs of notable) {
    if (!obs.locId) continue;
    if (!notableByLoc[obs.locId]) notableByLoc[obs.locId] = [];
    notableByLoc[obs.locId].push({ species: obs.comName, date: obs.obsDt, locName: obs.locName });
  }

  const ranked = enriched
    .map((h) => {
      const notableHere = notableByLoc[h.locId] || [];
      const score = h.recentSpeciesCount * SCORE_SPECIES_WEIGHT + notableHere.length * SCORE_NOTABLE_WEIGHT;
      return { ...h, notableSightings: notableHere, score };
    })
    .sort((a, b) => b.score - a.score);

  const hotspotResults = ranked.map((h, i) => ({
    rank: i + 1,
    name: h.locName,
    locId: h.locId,
    isFavorite: h.isFavorite || false,
    recentSpeciesCount: h.recentSpeciesCount,
    notableSightings: h.notableSightings.slice(0, 5),
    score: h.score,
  }));

  const areaNotable = notable
    .filter((o, i, arr) => arr.findIndex((x) => x.speciesCode === o.speciesCode) === i)
    .slice(0, 10)
    .map((o) => ({ species: o.comName, location: o.locName, date: o.obsDt }));

  const summary = buildTripSummary(hotspotResults, areaNotable, bc, dateInfo, location);

  return {
    summary,
    date: dateInfo.label,
    location: location.name,
    hotspots: hotspotResults,
    areaNotableSightings: areaNotable,
    migration: bc.summary || 'No migration data available (outside season or unavailable).',
    expectedMigrants: bc.species?.slice(0, 10) ?? [],
    birdingWindow: birdingWin ?? null,
    weatherSummary: weather && !weather.weatherUnavailable ? weather.migrationInterpretation : null,
  };
}

function buildTripSummary(hotspots, notable, bc, dateInfo, location) {
  const parts = [`Birding plan for ${dateInfo.label} near ${location.name}:`];
  if (hotspots.length > 0) {
    const top3 = hotspots.slice(0, 3);
    parts.push(
      `Top hotspots: ${top3.map((h) => `${h.name} (${h.recentSpeciesCount} species this week${h.isFavorite ? ', ★ favorite' : ''})`).join(', ')}.`,
    );
  }
  if (notable.length > 0) {
    parts.push(
      `Notable sightings in the area: ${notable.slice(0, 5).map((n) => n.species).join(', ')}.`,
    );
  }
  if (bc.summary) parts.push(`Migration: ${bc.summary}`);
  if (bc.species?.length > 0) {
    parts.push(`Expected migrants: ${bc.species.slice(0, 5).map((s) => s.commonName).join(', ')}.`);
  }
  return parts.join('\n\n');
}
