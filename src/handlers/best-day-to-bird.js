// best_day_to_bird — rank candidate dates by migration favorability.

import { DEFAULTS, resolveDateRange, formatNumber, toYMD } from '../utils.js';
import { loc, getBirdCastData, resolveSpeciesCode } from './_shared.js';
import { compactDayScore } from '../migration-scoring.js';

export const tool = {
  name: 'best_day_to_bird',
  description:
    'Recommend the best day to go birding within a date range, combining BirdCast migration forecasts, historical eBird frequency data, and recent observation trends.',
  inputSchema: {
    type: 'object',
    properties: {
      location: { type: 'string', description: 'Region code, lat/lng, or city name. Defaults to your home location.' },
      date_range: { type: 'string', description: 'Date range: "this week", "this weekend", "next 5 days", "May 15-22". Defaults to this week.' },
      target_species: { type: 'string', description: 'Optional common name of a target species to optimize for.' },
    },
  },
};

export async function handle(args, ctx) {
  const location = loc(args.location, ctx.config);
  const range = resolveDateRange(args.date_range || 'this week') ?? resolveDateRange('this week');
  const regionCode = location.regionCode || DEFAULTS.regionCode;

  const dates = [];
  const start = new Date(range.start + 'T12:00:00');
  const end = new Date(range.end + 'T12:00:00');
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    dates.push(new Date(d));
  }

  if (dates.length > 14) {
    return { error: 'Date range too large. Please use a range of 14 days or fewer.' };
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dayAnalysis = await Promise.all(
    dates.map(async (d) => {
      const dateStr = toYMD(d);
      const dayName = d.toLocaleDateString('en-US', { weekday: 'long' });
      const label = `${dayName} ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

      let migrationScore = 0;
      let migrationNote = '';
      let bcData = null;

      if (ctx.clients.birdcast.isInMigrationSeason(dateStr)) {
        const bcResult = await getBirdCastData(regionCode, dateStr, ctx);
        bcData = bcResult.live;
        if (bcData) {
          const birds = bcData.cumulativeBirds ?? 0;
          migrationScore = compactDayScore(bcData);
          migrationNote = `${formatNumber(birds)} birds${bcData.isHigh ? ' (HIGH)' : ''}`;
        }
      }

      let statsNote = '';
      if (d <= today) {
        try {
          const stats = await ctx.clients.ebird.getRegionStats(regionCode, d.getFullYear(), d.getMonth() + 1, d.getDate());
          if (stats) {
            statsNote = `${stats.numChecklists ?? 0} checklists, ${stats.numSpecies ?? 0} species reported`;
            if (stats?.numSpecies) {
              migrationScore += Math.min(Math.floor(stats.numSpecies / 10), 2);
            }
          }
        } catch { /* future date, no stats */ }
      }

      return { date: dateStr, label, migrationScore, migrationNote, statsNote, bcData };
    }),
  );

  let targetNote = '';
  if (args.target_species) {
    const code = await resolveSpeciesCode(args.target_species, ctx);
    if (code && location.lat && location.lng) {
      const obs = await ctx.clients.ebird.getNearbySpeciesObservations(
        location.lat, location.lng, code, 14, 50,
      );
      if (obs?.length > 0) {
        targetNote = `${args.target_species} has been seen at ${new Set(obs.map((o) => o.locId)).size} locations in the last 14 days. Most recent: ${obs[0].obsDt} at ${obs[0].locName}.`;
      } else {
        targetNote = `${args.target_species} has not been reported nearby in the last 14 days.`;
      }
    }
  }

  const ranked = dayAnalysis.sort((a, b) => b.migrationScore - a.migrationScore);
  const bestDay = ranked[0];
  const parts = [`Best day recommendation for ${range.label} near ${location.name}:`];
  parts.push(`${bestDay.label} looks best${bestDay.migrationNote ? ` — ${bestDay.migrationNote} overnight migration` : ''}.`);
  if (targetNote) parts.push(targetNote);

  const dayDetails = dayAnalysis.map((d) => ({
    date: d.date,
    label: d.label,
    migrationIntensity: d.migrationNote || 'no data',
    ebirdActivity: d.statsNote || 'no data yet',
    score: d.migrationScore,
  }));

  return {
    summary: parts.join('\n\n'),
    recommendation: bestDay.label,
    dateRange: range.label,
    location: location.name,
    days: dayDetails,
    targetSpecies: targetNote || null,
  };
}
