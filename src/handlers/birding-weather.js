// birding_weather — NWS weather interpreted for migration/birding.

import { resolveDate } from '../utils.js';

export const tool = {
  name: 'birding_weather',
  description:
    'Get NWS weather data interpreted for birding: overnight wind direction/speed (the key migration predictor), morning forecast, and a plain-English migration interpretation. Automatically combined into migration_forecast output.',
  inputSchema: {
    type: 'object',
    properties: {
      lat: { type: 'number', description: 'Latitude (default 39.1 for Cincinnati).' },
      lng: { type: 'number', description: 'Longitude (default -84.5 for Cincinnati).' },
      date: { type: 'string', description: 'Date for forecast. Defaults to today.' },
    },
  },
};

export async function handle(args, ctx) {
  const lat = args.lat ?? ctx.config.lat;
  const lng = args.lng ?? ctx.config.lng;
  if (!Number.isFinite(Number(lat)) || Number(lat) < -90 || Number(lat) > 90) {
    return { error: 'Invalid latitude: must be a number between -90 and 90' };
  }
  if (!Number.isFinite(Number(lng)) || Number(lng) < -180 || Number(lng) > 180) {
    return { error: 'Invalid longitude: must be a number between -180 and 180' };
  }
  const dateInfo = resolveDate(args.date || 'today') ?? resolveDate('today');
  return ctx.clients.nws.getBirdingWeather(lat, lng, dateInfo.date);
}
