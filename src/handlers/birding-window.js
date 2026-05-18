// birding_window — sunrise / civil twilight / activity-cutoff calculator.

import { coerceNumber } from './_shared.js';
import { resolveDate } from '../utils.js';
import { buildBirdingWindow } from '../birding-window.js';

export const tool = {
  name: 'birding_window',
  description:
    'Calculate sunrise, civil twilight, and recommended arrival time for a birding session at a given location and date.',
  inputSchema: {
    type: 'object',
    properties: {
      lat: { type: 'number', description: 'Latitude (default 39.1).' },
      lng: { type: 'number', description: 'Longitude (default -84.5).' },
      date: { type: 'string', description: 'Date. Defaults to today.' },
      temp_f: { type: 'number', description: 'Optional forecasted temperature (°F) — adjusts activity cutoff estimate.' },
    },
  },
};

export async function handle(args, ctx) {
  const lat = args.lat ?? ctx.config.lat;
  const lng = args.lng ?? ctx.config.lng;
  const dateInfo = resolveDate(args.date || 'today') ?? resolveDate('today');
  const tempF = args.temp_f != null ? coerceNumber(args.temp_f, null) : null;
  const tz = ctx.config.timezone || 'America/New_York';

  const win = buildBirdingWindow(dateInfo.date, lat, lng, tz, tempF);

  const civilTwilight  = win.civilTwilight  ?? 'N/A';
  const sunrise        = win.sunrise        ?? 'N/A';
  const goldenHourEnd  = win.goldenHourEnd  ?? 'N/A';
  const activityCutoff = win.activityCutoff ?? 'N/A';

  const tempNote = tempF != null ? ` at forecasted ${Math.round(tempF)}°F` : '';
  const recommendation = `Arrive by ${civilTwilight} (civil twilight). Peak songbird activity ${sunrise}–9:30 AM. Heat suppresses activity after ~${activityCutoff}${tempNote}.`;

  return { civilTwilight, sunrise, goldenHourEnd, activityCutoff, recommendation };
}
