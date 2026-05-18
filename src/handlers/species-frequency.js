// species_frequency — historical BirdCast bar-chart probability lookup.

import { DEFAULTS, resolveDate } from '../utils.js';
import { resolveSpeciesCode } from './_shared.js';

export const tool = {
  name: 'species_frequency',
  description:
    'Look up historical frequency data for a species in a region using BirdCast bar chart data. Returns peak week, current probability, and whether the species is early/on-time/late relative to its historical peak.',
  inputSchema: {
    type: 'object',
    properties: {
      species:     { type: 'string', description: 'Common name of the species (e.g. "Tennessee Warbler").' },
      region_code: { type: 'string', description: 'eBird region code (default "US-OH-061").' },
      date:        { type: 'string', description: 'Date for the lookup. Defaults to today.' },
    },
    required: ['species'],
  },
};

export async function handle(args, ctx) {
  if (!args.species) return { error: 'species is required.' };
  const regionCode = args.region_code || DEFAULTS.regionCode;
  const dateInfo = resolveDate(args.date || 'today') ?? resolveDate('today');

  if (!ctx.clients.birdcast.isInMigrationSeason(dateInfo.date)) {
    return {
      summary: `${dateInfo.date} is outside migration season. Frequency data is only available March–June and August–November.`,
    };
  }

  const speciesCode = await resolveSpeciesCode(args.species, ctx);
  if (!speciesCode) {
    return { error: `Could not find species "${args.species}" in eBird taxonomy.` };
  }

  const allSpecies = await ctx.clients.birdcast.getExpectedSpecies(regionCode, dateInfo.date);
  if (!allSpecies) {
    return { error: 'BirdCast frequency data unavailable for this region/date.' };
  }

  const entry = allSpecies.find(
    (s) => s.speciesCode === speciesCode || s.commonName?.toLowerCase() === args.species.toLowerCase(),
  );
  if (!entry || entry.probability == null) {
    return {
      species: args.species,
      speciesCode,
      currentWeekProbability: 0,
      interpretation: `${args.species} has no BirdCast frequency data for ${regionCode}.`,
    };
  }

  const currentProb = entry.probability;
  const d = new Date(dateInfo.date + 'T12:00:00Z');
  const startOfYear = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekIndex = Math.min(Math.floor((d - startOfYear) / (7 * 24 * 60 * 60 * 1000)), 47);

  let phenologyStatus;
  if (weekIndex < 17) phenologyStatus = 'pre-peak';
  else if (weekIndex <= 22) phenologyStatus = 'at-peak';
  else phenologyStatus = 'post-peak';

  const interpretation = `${args.species} has a current-week BirdCast probability of ${(currentProb * 100).toFixed(0)}% in ${regionCode}. Season status: ${phenologyStatus} (week ${weekIndex} of 47).`;

  return {
    species: args.species,
    speciesCode,
    currentWeekProbability: currentProb,
    weekIndex,
    phenologyStatus,
    interpretation,
  };
}
