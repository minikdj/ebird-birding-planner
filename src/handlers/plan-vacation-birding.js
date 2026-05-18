// plan_vacation_birding — discovery report for a travel destination.

import { DEFAULTS, resolveDateRange, resolveLocation } from '../utils.js';
import { handle as handleBirdingWindow } from './birding-window.js';

const NOISE_SPECIES = new Set([
  'House Sparrow', 'European Starling', 'Rock Pigeon', 'American Robin',
  'Mourning Dove', 'Northern Cardinal', 'American Crow',
]);

export const tool = {
  name: 'plan_vacation_birding',
  description:
    "Discovery report for birding at a travel destination. Surfaces target species you won't easily find at your home location, ranks hotspots by active birder community, and provides a birding window for the trip. Uses BirdCast historical bar chart frequencies so it works for trips weeks or months in advance — not just this week's live data.",
  inputSchema: {
    type: 'object',
    properties: {
      destination: {
        type: 'string',
        description: 'Destination as city name (e.g. "Cape May, NJ"), region code (e.g. "US-NJ-009"), or "lat,lng". Known cities: Cape May, Acadia, Asheville, New York, Chicago, San Francisco, Austin, Portland.',
      },
      dates: {
        type: 'string',
        description: 'Trip dates: "May 20-25", "next week", "June 1-7", "July 4". Used to pick the right week of historical frequency data.',
      },
      home_region: {
        type: 'string',
        description: 'Home region code for novelty comparison (default "US-OH-061").',
      },
    },
    required: ['destination'],
  },
};

/**
 * Build the ranked target-species lists from destination vs. home frequency data.
 *
 * Pure function — no I/O, no side effects — so it is independently testable.
 *
 * @param {Array|null} destSpecies   - BirdCast expected species at destination
 * @param {Array|null} homeSpecies   - BirdCast expected species at home region
 * @param {Set|null}   lifeListSet   - normalized lowercased species names on life list
 * @param {object}     opts
 * @param {string}     opts.tripStartDate - YYYY-MM-DD, used in dataNote string
 * @param {string}     opts.regionCode    - destination region code, used in dataNote
 * @param {Function}   opts.hasName       - (name: string) => boolean life-list lookup
 * @param {number}     [opts.lifeListTotal] - total species count for note
 * @returns {{ targetSpecies: object, dataNote: string|null }}
 */
function buildTargetSpecies(destSpecies, homeSpecies, lifeListSet, opts = {}) {
  const { tripStartDate, regionCode, hasName = () => false, lifeListTotal } = opts;

  if (!destSpecies) {
    const targetSpecies = lifeListSet
      ? { newToYourLifeList: [], seenBeforeButRareHere: [] }
      : { notFindableAtHome: [], rareAtHome: [] };
    const dataNote = regionCode
      ? `BirdCast frequency data is not available for region ${regionCode}. Hotspots and recent sightings are shown above.`
      : 'No region code available — target species comparison requires a county-level region code or recognized city.';
    return { targetSpecies, dataNote };
  }

  const homeMap = homeSpecies ? new Map(homeSpecies.map((s) => [s.commonName, s.probability])) : new Map();
  let destThreshold = 0.15;
  const homeThreshold = 0.10;

  let pool = destSpecies
    .filter((s) => s.commonName && !NOISE_SPECIES.has(s.commonName))
    .filter((s) => s.probability >= destThreshold)
    .map((s) => ({ ...s, homeProbability: homeMap.get(s.commonName) ?? 0 }));

  if (lifeListSet) {
    pool = pool.filter((s) => s.homeProbability < homeThreshold);
    if (pool.length > 40) pool = pool.filter((s) => s.probability > 0.25 && s.homeProbability < 0.05);
    if (pool.length < 5) {
      destThreshold = 0.10;
      pool = destSpecies
        .filter((s) => s.commonName && !NOISE_SPECIES.has(s.commonName))
        .filter((s) => s.probability >= destThreshold)
        .filter((s) => (homeMap.get(s.commonName) ?? 0) < homeThreshold)
        .map((s) => ({ ...s, homeProbability: homeMap.get(s.commonName) ?? 0 }));
    }

    const toEntry = (s) => ({
      name: s.commonName,
      destinationFrequency: Math.round(s.probability * 100) / 100,
      homeFrequency: Math.round(s.homeProbability * 100) / 100,
      onYourLifeList: hasName(s.commonName),
    });

    const notSeen = pool.filter((s) => !hasName(s.commonName));
    const alreadySeen = pool.filter((s) => hasName(s.commonName));

    const targetSpecies = {
      newToYourLifeList: notSeen.sort((a, b) => b.probability - a.probability).slice(0, 15).map(toEntry),
      seenBeforeButRareHere: alreadySeen.sort((a, b) => b.probability - a.probability).slice(0, 10).map(toEntry),
    };

    const lifeTally = lifeListTotal ?? lifeListSet.size;
    const dataNote = `Using your eBird life list (${lifeTally} species). ` +
      `"New to your life list" = findable here (>${Math.round(destThreshold * 100)}% frequency) but not in your records. ` +
      `Frequencies from BirdCast historical bar chart for the week of ${tripStartDate}.`;

    return { targetSpecies, dataNote };
  } else {
    pool = pool.filter((s) => s.homeProbability < homeThreshold);
    if (pool.length > 40) pool = pool.filter((s) => s.probability > 0.25 && s.homeProbability < 0.05);

    let similarNote = null;
    if (pool.length < 5) {
      destThreshold = 0.10;
      pool = destSpecies
        .filter((s) => s.commonName && !NOISE_SPECIES.has(s.commonName))
        .filter((s) => s.probability >= destThreshold)
        .filter((s) => (homeMap.get(s.commonName) ?? 0) < homeThreshold)
        .map((s) => ({ ...s, homeProbability: homeMap.get(s.commonName) ?? 0 }));
      similarNote = 'This destination has similar species to your home location — thresholds relaxed to show the most distinctive local birds.';
    }
    if (pool.length < 3) {
      const relaxedHomeThreshold = 0.05;
      const relaxedDestThreshold = 0.10;
      pool = destSpecies
        .filter((s) => s.commonName && !NOISE_SPECIES.has(s.commonName))
        .filter((s) => s.probability >= relaxedDestThreshold)
        .filter((s) => (homeMap.get(s.commonName) ?? 0) < relaxedHomeThreshold)
        .map((s) => ({ ...s, homeProbability: homeMap.get(s.commonName) ?? 0 }));
      similarNote = 'This destination has significant species overlap with your home region. Showing species that are findable here but uncommon at home.';
    }

    const toEntry = (s) => ({
      name: s.commonName,
      destinationFrequency: Math.round(s.probability * 100) / 100,
      homeFrequency: Math.round(s.homeProbability * 100) / 100,
    });

    const targetSpecies = {
      notFindableAtHome: pool.filter((s) => s.homeProbability < 0.02).sort((a, b) => b.probability - a.probability).slice(0, 15).map(toEntry),
      rareAtHome: pool.filter((s) => s.homeProbability >= 0.02).sort((a, b) => b.probability - a.probability).slice(0, 15).map(toEntry),
    };

    const dataNote = similarNote
      ?? `Frequencies from BirdCast historical bar chart for the week of ${tripStartDate}. Set EBIRD_LIFE_LIST_CSV for personalized life-list comparisons.`;

    return { targetSpecies, dataNote };
  }
}

async function resolveDestination(raw, ctx) {
  const fromLookup = resolveLocation(raw);
  if (fromLookup) return fromLookup;

  let query = raw.slice(0, 200);
  const regions = await ctx.clients.birdcast.findRegion(query).catch(() => []);
  if (!regions.length) return null;

  const regionCode = regions[0].code;
  const dest = { lat: null, lng: null, regionCode, name: regions[0].name || raw };

  if (regionCode && /^[A-Z]{2}-[A-Z]{2,3}(-\d{1,3})?$/i.test(regionCode)) {
    const hotspots = await ctx.clients.ebird.searchHotspotsByRegion(regionCode).catch(() => []);
    if (hotspots?.length > 0) {
      dest.lat = hotspots[0].lat ?? null;
      dest.lng = hotspots[0].lng ?? null;
    }
  }
  return dest;
}

export async function handle(args, ctx) {
  const homeRegion = args.home_region || DEFAULTS.regionCode;
  const rawDest = args.destination || '';
  let destination = await resolveDestination(rawDest, ctx);
  if (!destination) {
    const stripped = rawDest.replace(/,\s*[A-Z]{2}$/i, '').trim();
    if (stripped && stripped !== rawDest) {
      destination = await resolveDestination(stripped, ctx);
    }
  }
  if (!destination) {
    return { error: `Cannot resolve "${args.destination}". Try a region code (e.g. "US-NJ-009"), "lat,lng", or a recognized city name.` };
  }
  if (!destination.lat || !destination.lng) {
    return { error: `Cannot determine coordinates for "${args.destination}". Please provide as "lat,lng" or a county-level region code.` };
  }

  const dateRange = args.dates ? resolveDateRange(args.dates) : null;
  const tripStartDate = dateRange?.start ?? new Date().toISOString().split('T')[0];
  const tripLabel = dateRange?.label ?? 'upcoming trip';
  const { lat, lng, regionCode } = destination;

  // Life list comes from ctx (loaded at server startup); for backward compat
  // it's a Set<string> of normalized names.
  const lifeListSet = ctx.lifeList?.set ?? null;
  const hasName = (name) => lifeListSet?.has(name.toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').trim()) ?? false;

  const [nearbyHotspots, notableObs, destSpecies, homeSpecies, birdingWin] = await Promise.all([
    ctx.clients.ebird.getNearbyHotspots(lat, lng, 50).catch(() => []),
    ctx.clients.ebird.getNearbyNotableObservations(lat, lng, 14, 50).catch(() => []),
    regionCode
      ? ctx.clients.birdcast.getExpectedSpecies(regionCode, tripStartDate, { ignoreSeasonCheck: true }).catch(() => null)
      : Promise.resolve(null),
    ctx.clients.birdcast.getExpectedSpecies(homeRegion, tripStartDate, { ignoreSeasonCheck: true }).catch(() => null),
    handleBirdingWindow({ lat, lng, date: tripStartDate }, ctx).catch(() => null),
  ]);

  const candidates = Array.isArray(nearbyHotspots)
    ? nearbyHotspots.sort((a, b) => (b.numSpeciesAllTime ?? 0) - (a.numSpeciesAllTime ?? 0)).slice(0, 15)
    : [];

  const hotspotData = (await Promise.all(
    candidates.map(async (h) => {
      const obs = await ctx.clients.ebird.getRecentObservations(h.locId, 7).catch(() => []);
      const speciesCount = new Set((obs || []).map((o) => o.speciesCode)).size;
      const checklistCount = new Set((obs || []).map((o) => o.subId).filter(Boolean)).size;
      return { name: h.locName, locId: h.locId, recentSpecies: speciesCount, recentChecklists: checklistCount };
    }),
  ))
    .sort((a, b) => b.recentChecklists - a.recentChecklists)
    .filter((h) => h.recentChecklists > 0)
    .slice(0, 5);

  const { targetSpecies, dataNote } = buildTargetSpecies(destSpecies, homeSpecies, lifeListSet, {
    tripStartDate,
    regionCode,
    hasName,
    lifeListTotal: ctx.lifeList?.total,
  });

  const notableRecentSightings = Array.isArray(notableObs)
    ? [...new Map(notableObs.map((o) => [o.speciesCode, o])).values()]
        .map((o) => ({
          name: o.comName,
          date: o.obsDt,
          location: o.locName,
          ...(lifeListSet ? { onYourLifeList: hasName(o.comName) } : {}),
        }))
        .slice(0, 10)
    : [];

  const primaryCount = lifeListSet
    ? (targetSpecies.newToYourLifeList?.length ?? 0)
    : (targetSpecies.notFindableAtHome?.length ?? 0);
  const secondaryCount = lifeListSet
    ? (targetSpecies.seenBeforeButRareHere?.length ?? 0)
    : (targetSpecies.rareAtHome?.length ?? 0);

  const topSpot = hotspotData[0];
  const parts = [`${destination.name} — ${tripLabel}.`];
  if (primaryCount > 0 || secondaryCount > 0) {
    if (lifeListSet) {
      parts.push(`★ ${primaryCount} species not on your life list that are findable here, ▲ ${secondaryCount} you've seen before but are not typically found at your home location.`);
    } else {
      parts.push(`★ ${primaryCount} species not typically found at your home location, ▲ ${secondaryCount} more that are rare at home but common here.`);
    }
  }
  if (topSpot) parts.push(`Top spot: ${topSpot.name} — ${topSpot.recentChecklists} checklists and ${topSpot.recentSpecies} species in the last week.`);
  if (destSpecies) parts.push('Frequency data is historical (multi-year eBird records) — reliable for planning ahead regardless of current conditions.');

  return {
    destination: destination.name,
    dates: tripLabel,
    lifeListLoaded: lifeListSet ? `${ctx.lifeList.total ?? lifeListSet.size} species` : null,
    birdingWindow: birdingWin,
    topHotspots: hotspotData,
    targetSpecies,
    notableRecentSightings,
    dataNote,
    summary: parts.join(' '),
  };
}
