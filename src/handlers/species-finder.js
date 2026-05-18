// species_finder — recent sightings of a species near a location.

import { coerceNumber, loc, resolveSpeciesCode } from './_shared.js';

export const tool = {
  name: 'species_finder',
  description:
    'Find where a specific bird species has been seen recently near a location, sorted by most recent observation.',
  inputSchema: {
    type: 'object',
    properties: {
      species: { type: 'string', description: 'Common name of the species (e.g. "Cerulean Warbler").' },
      location: { type: 'string', description: 'Region code, lat/lng, or city name. Defaults to your home location.' },
      radius_km: { type: 'number', description: 'Search radius in km (default 50).' },
    },
    required: ['species'],
  },
};

export async function handle(args, ctx) {
  const speciesName = args.species;
  const location = loc(args.location, ctx.config);
  const radius = Math.min(Math.max(1, coerceNumber(args.radius_km, 50)), 100);

  const speciesCode = await resolveSpeciesCode(speciesName, ctx);
  if (!speciesCode) {
    return { error: `Could not find species "${speciesName}" in eBird taxonomy. Try the full common name (e.g. "Cerulean Warbler").` };
  }
  if (!location.lat || !location.lng) {
    return { error: `Cannot determine coordinates for "${args.location}". Provide lat/lng or a known city.` };
  }

  let observations;
  try {
    observations = await ctx.clients.ebird.getNearbySpeciesObservations(
      location.lat, location.lng, speciesCode, 30, radius,
    );
  } catch (err) {
    process.stderr.write(`handleSpeciesFinder error for ${speciesName}: ${err.message}\n`);
    return {
      error: `Could not fetch sightings for "${speciesName}" near ${location.name}. Try again with a smaller radius (e.g. radius_km: 25).`,
    };
  }

  if (!observations || observations.length === 0) {
    return {
      summary: `No recent sightings of ${speciesName} within ${radius}km of ${location.name} in the last 30 days.`,
      species: speciesName, speciesCode, sightings: [],
    };
  }

  const MAX_OBS = 500;
  const capped = observations.length > MAX_OBS;
  const obsToProcess = capped ? observations.slice(0, MAX_OBS) : observations;

  const byLoc = {};
  for (const obs of obsToProcess) {
    if (!byLoc[obs.locId] || obs.obsDt > byLoc[obs.locId].obsDt) byLoc[obs.locId] = obs;
  }

  const allSightings = Object.values(byLoc).sort((a, b) => (b.obsDt || '').localeCompare(a.obsDt || ''));
  const sightings = allSightings.map((o) => ({
    location: o.locName,
    locId: o.locId,
    date: o.obsDt,
    count: o.howMany ?? 'present',
    lat: o.lat,
    lng: o.lng,
  }));

  const totalLocations = sightings.length;
  const shown = sightings.slice(0, 20);

  if (shown.length === 0) {
    return {
      summary: `No recent sightings of ${speciesName} within ${radius}km of ${location.name} in the last 30 days.`,
      species: speciesName, speciesCode, sightings: [],
    };
  }

  const summaryPrefix = capped
    ? `Showing top 20 of ${totalLocations} locations (results capped for common species).`
    : `${speciesName} seen at ${totalLocations} locations near ${location.name} in the last 30 days.`;

  return {
    summary: `${summaryPrefix} Most recent: ${shown[0].location} on ${shown[0].date}.`,
    species: speciesName, speciesCode, sightings: shown,
  };
}
