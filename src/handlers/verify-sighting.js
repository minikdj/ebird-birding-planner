// verify_sighting — cross-reference an eBird sighting against iNaturalist photos.

import { coerceNumber } from './_shared.js';

export const tool = {
  name: 'verify_sighting',
  description:
    'Cross-reference an eBird species sighting against iNaturalist photo-verified observations nearby. Returns confidence level and count of research-grade (photo-verified) reports.',
  inputSchema: {
    type: 'object',
    properties: {
      species:   { type: 'string', description: 'Common or scientific name of the species.' },
      lat:       { type: 'number', description: 'Latitude (default 39.1).' },
      lng:       { type: 'number', description: 'Longitude (default -84.5).' },
      radius_km: { type: 'number', description: 'Search radius in km (default 30).' },
      days_back: { type: 'number', description: 'Days to look back (default 14).' },
    },
    required: ['species'],
  },
};

export async function handle(args, ctx) {
  if (!args.species) return { error: 'species is required.' };
  const lat = args.lat ?? ctx.config.lat;
  const lng = args.lng ?? ctx.config.lng;
  if (!Number.isFinite(Number(lat)) || Number(lat) < -90 || Number(lat) > 90) {
    return { error: 'Invalid latitude: must be a number between -90 and 90' };
  }
  if (!Number.isFinite(Number(lng)) || Number(lng) < -180 || Number(lng) > 180) {
    return { error: 'Invalid longitude: must be a number between -180 and 180' };
  }
  const radius   = Math.min(Math.max(1, coerceNumber(args.radius_km, 30)), 200);
  const daysBack = Math.min(Math.max(1, coerceNumber(args.days_back, 14)), 30);
  const result = await ctx.clients.inat.getVerifiedSightings(args.species, lat, lng, radius, daysBack);

  // Distinguish zero-results from API error (see comment in old src/index.js).
  if (
    result.photoVerifiedCount === 0 &&
    result.confidence === 'low' &&
    typeof result.interpretation === 'string' &&
    result.interpretation.includes('data unavailable')
  ) {
    result.interpretation = `No photo-verified observations found on iNaturalist within ${radius}km in the last ${daysBack} days.`;
  }

  return result;
}
