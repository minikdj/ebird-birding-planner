// hotspot_details — recent observations + species summary for a hotspot.

import { loc } from './_shared.js';

export const tool = {
  name: 'hotspot_details',
  description:
    'Get detailed info about a specific eBird hotspot: recent species, notable sightings, and frequency data for this time of year.',
  inputSchema: {
    type: 'object',
    properties: {
      hotspot: {
        type: 'string',
        description: 'Hotspot location ID (e.g. "L12345") or name to search for.',
      },
      location: {
        type: 'string',
        description: 'Location context for name-based search (optional).',
      },
    },
    required: ['hotspot'],
  },
};

export async function handle(args, ctx) {
  let locId = args.hotspot;
  if (typeof locId === 'string' && locId.length > 200) locId = locId.slice(0, 200);

  if (!/^L\d+$/.test(locId)) {
    const location = loc(args.location, ctx.config);
    if (location.lat && location.lng) {
      const hotspots = await ctx.clients.ebird.getNearbyHotspots(location.lat, location.lng, 50);
      const match = hotspots.find((h) => h.locName?.toLowerCase().includes(locId.toLowerCase()));
      if (!match) return { error: `No hotspot found matching "${locId}" near ${location.name}.` };
      locId = match.locId;
    } else if (location.regionCode) {
      const hotspots = await ctx.clients.ebird.searchHotspotsByRegion(location.regionCode);
      const match = hotspots.find((h) => h.locName?.toLowerCase().includes(locId.toLowerCase()));
      if (!match) return { error: `No hotspot found matching "${locId}" in ${location.regionCode}.` };
      locId = match.locId;
    }
  }

  const [info, recentObs, notableObs] = await Promise.all([
    ctx.clients.ebird.getHotspotInfo(locId).catch(() => null),
    ctx.clients.ebird.getRecentObservations(locId, 7).catch(() => []),
    ctx.clients.ebird.getRecentObservations(locId, 14).catch(() => []),
  ]);

  const speciesSet = new Set(recentObs.map((o) => o.speciesCode).filter(Boolean));
  const speciesWithDates = {};
  for (const obs of recentObs) {
    if (!speciesWithDates[obs.speciesCode]) {
      speciesWithDates[obs.speciesCode] = {
        name: obs.comName,
        lastSeen: obs.obsDt,
        count: obs.howMany,
      };
    }
  }

  const allSpecies14 = new Set(notableObs.map((o) => o.speciesCode).filter(Boolean));

  return {
    summary: `${info?.locName ?? locId}: ${speciesSet.size} species in the last 7 days, ${allSpecies14.size} in the last 14 days.`,
    locId,
    name: info?.locName ?? locId,
    coordinates: info ? { lat: info.latitude, lng: info.longitude } : null,
    recentSpeciesCount: speciesSet.size,
    recentSpecies: Object.values(speciesWithDates)
      .sort((a, b) => b.lastSeen?.localeCompare(a.lastSeen))
      .slice(0, 50),
    totalSpeciesAllTime: info?.numSpeciesAllTime ?? null,
  };
}
