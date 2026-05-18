// compare_hotspots — side-by-side comparison of multiple hotspots.

import { loc } from './_shared.js';

export const tool = {
  name: 'compare_hotspots',
  description:
    'Compare multiple eBird hotspots side-by-side: unique species, shared species, notable sightings, and checklist activity at each.',
  inputSchema: {
    type: 'object',
    properties: {
      hotspots: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of hotspot location IDs (e.g. ["L12345", "L67890"]) or names.',
      },
      location: {
        type: 'string',
        description: 'Location context for name-based search (optional).',
      },
    },
    required: ['hotspots'],
  },
};

export async function handle(args, ctx) {
  let hotspotInputs = args.hotspots;
  if (!hotspotInputs || hotspotInputs.length < 2) {
    return { error: 'Please provide at least 2 hotspot IDs or names to compare.' };
  }

  let capped = false;
  if (hotspotInputs.length > 10) {
    capped = true;
    hotspotInputs = hotspotInputs.slice(0, 10);
  }

  const location = loc(args.location, ctx.config);
  let nearbyHotspots = null;
  const resolvedIds = [];
  for (const input of hotspotInputs) {
    if (/^L\d+$/.test(input)) {
      resolvedIds.push(input);
    } else {
      if (!nearbyHotspots && location.lat && location.lng) {
        nearbyHotspots = await ctx.clients.ebird.getNearbyHotspots(location.lat, location.lng, 50);
      }
      const match = nearbyHotspots?.find((h) =>
        h.locName?.toLowerCase().includes(input.toLowerCase()),
      );
      if (match) resolvedIds.push(match.locId);
      else return { error: `Could not find hotspot matching "${input}".` };
    }
  }

  const hotspotData = await Promise.all(
    resolvedIds.map(async (locId) => {
      const [info, obs] = await Promise.all([
        ctx.clients.ebird.getHotspotInfo(locId).catch(() => null),
        ctx.clients.ebird.getRecentObservations(locId, 7).catch(() => []),
      ]);
      const speciesSet = new Set(obs.map((o) => o.speciesCode));
      return {
        locId,
        name: info?.locName ?? locId,
        speciesCodes: speciesSet,
        speciesNames: new Map(obs.map((o) => [o.speciesCode, o.comName])),
        checklistCount: new Set(obs.map((o) => o.subId).filter(Boolean)).size,
        recentSpeciesCount: speciesSet.size,
        totalSpeciesAllTime: info?.numSpeciesAllTime ?? null,
      };
    }),
  );

  const allCodes = new Set(hotspotData.flatMap((h) => [...h.speciesCodes]));
  const shared = [...allCodes].filter((code) => hotspotData.every((h) => h.speciesCodes.has(code)));

  const comparison = hotspotData.map((h) => {
    const unique = [...h.speciesCodes].filter(
      (code) => !hotspotData.some((other) => other.locId !== h.locId && other.speciesCodes.has(code)),
    );
    return {
      locId: h.locId,
      name: h.name,
      recentSpeciesCount: h.recentSpeciesCount,
      totalSpeciesAllTime: h.totalSpeciesAllTime,
      checklistsThisWeek: h.checklistCount,
      uniqueSpecies: unique.map((c) => h.speciesNames.get(c) ?? c),
    };
  });

  const nameMap = new Map();
  for (const h of hotspotData) {
    for (const [code, name] of h.speciesNames) {
      if (!nameMap.has(code)) nameMap.set(code, name);
    }
  }
  const sharedNames = shared.map((c) => nameMap.get(c) ?? c);

  if (Number.isFinite(location.lat) && Number.isFinite(location.lng)) {
    const allUnique = comparison.flatMap((h) => h.uniqueSpecies).slice(0, 3);
    const verifications = await Promise.all(
      allUnique.map((sp) =>
        ctx.clients.inat
          .getVerifiedSightings(sp, location.lat ?? ctx.config.lat, location.lng ?? ctx.config.lng, 30, 14)
          .catch(() => null),
      ),
    );
    const verifiedMap = {};
    allUnique.forEach((sp, i) => {
      if (verifications[i]) {
        verifiedMap[sp] = { confidence: verifications[i].confidence, photoCount: verifications[i].photoVerifiedCount };
      }
    });
    for (const h of comparison) {
      h.uniqueSpeciesVerified = h.uniqueSpecies.map((sp) => ({ species: sp, ...(verifiedMap[sp] ?? {}) }));
    }
  }

  const summary = comparison
    .map((h) => `${h.name}: ${h.recentSpeciesCount} species, ${h.checklistsThisWeek} checklists, ${h.uniqueSpecies.length} unique`)
    .join(' | ');

  const result = {
    summary: `Comparison: ${summary}. ${sharedNames.length} species shared across all.`,
    sharedSpecies: sharedNames,
    sharedSpeciesCount: sharedNames.length,
    hotspots: comparison,
  };
  if (capped) result.note = 'Input was limited to 10 hotspots.';
  return result;
}
