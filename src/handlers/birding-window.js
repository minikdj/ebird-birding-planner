// birding_window — sunrise / civil twilight / activity-cutoff calculator.

import suncalc from 'suncalc';
import { computeActivityCutoff } from '../utils.js';
import { coerceNumber } from './_shared.js';
import { resolveDate } from '../utils.js';

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

  const dateObj = new Date(dateInfo.date + 'T12:00:00');
  const times = suncalc.getTimes(dateObj, lat, lng);

  const tz = ctx.config.timezone || 'America/New_York';
  function fmtTime(d) {
    if (!d || isNaN(d.getTime())) return 'N/A';
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz });
  }

  const civilTwilight  = fmtTime(times.dawn);
  const sunrise        = fmtTime(times.sunrise);
  const goldenHourEnd  = fmtTime(times.goldenHour);

  const cutoffDate = computeActivityCutoff(times.sunrise, tempF ?? null);
  const activityCutoff = fmtTime(cutoffDate);

  const tempNote = tempF != null ? ` at forecasted ${Math.round(tempF)}°F` : '';
  const recommendation = `Arrive by ${civilTwilight} (civil twilight). Peak songbird activity ${sunrise}–9:30 AM. Heat suppresses activity after ~${activityCutoff}${tempNote}.`;

  return { civilTwilight, sunrise, goldenHourEnd, activityCutoff, recommendation };
}
