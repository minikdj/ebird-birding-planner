// birding-window.js — single source of truth for the daylight / birding window
// computation used by scripts/aggregate.js and src/handlers/birding-window.js.
//
// Returns formatted civil twilight / sunrise / golden hour / solar noon / sunset
// times in the requested IANA timezone, plus an activity cutoff derived from the
// raw sunrise Date and an optional forecasted morning temperature.

import suncalc from 'suncalc';
import { computeActivityCutoff } from './utils.js';

function formatTime(date, tz) {
  if (!date || isNaN(date.getTime())) return null;
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: tz,
  });
}

/**
 * Build a birding window object for the given date and coordinates.
 *
 * @param {string} dateStr  YYYY-MM-DD date (interpreted at solar noon UTC)
 * @param {number} lat
 * @param {number} lng
 * @param {string} [tz='America/New_York']  IANA timezone for formatted times
 * @param {number|null} [tempF=null]  Optional forecasted morning temperature (°F)
 *                                    used to adjust the activity cutoff estimate.
 * @returns {{
 *   civilTwilight: string|null,
 *   sunrise: string|null,
 *   goldenHourEnd: string|null,
 *   solarNoon: string|null,
 *   sunset: string|null,
 *   activityCutoff: string|null,
 *   _sunriseDate: Date
 * }}
 */
export function buildBirdingWindow(dateStr, lat, lng, tz = 'America/New_York', tempF = null) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const times = suncalc.getTimes(d, lat, lng);
  return {
    civilTwilight: formatTime(times.dawn, tz),
    sunrise: formatTime(times.sunrise, tz),
    goldenHourEnd: formatTime(times.goldenHourEnd, tz),
    solarNoon: formatTime(times.solarNoon, tz),
    sunset: formatTime(times.sunset, tz),
    activityCutoff: times.sunrise && !isNaN(times.sunrise.getTime())
      ? formatTime(computeActivityCutoff(times.sunrise, tempF), tz)
      : null,
    _sunriseDate: times.sunrise,
  };
}
