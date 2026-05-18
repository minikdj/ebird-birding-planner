// handlers/index.js — registry of all MCP tool handlers.
//
// Each handler module exports:
//   - `tool`: the MCP tool schema (name, description, inputSchema)
//   - `handle(args, ctx)`: async function returning a JSON-serializable result
//
// To add a new tool: drop a file in this directory and append it to HANDLERS.

import * as planBirdingTrip     from './plan-birding-trip.js';
import * as migrationForecast   from './migration-forecast.js';
import * as hotspotDetails      from './hotspot-details.js';
import * as compareHotspots     from './compare-hotspots.js';
import * as speciesFinder       from './species-finder.js';
import * as bestDayToBird       from './best-day-to-bird.js';
import * as birdingWeather      from './birding-weather.js';
import * as verifySighting      from './verify-sighting.js';
import * as birdingWindow       from './birding-window.js';
import * as speciesFrequency    from './species-frequency.js';
import * as planVacationBirding from './plan-vacation-birding.js';

export const HANDLERS = [
  planBirdingTrip,
  migrationForecast,
  hotspotDetails,
  compareHotspots,
  speciesFinder,
  bestDayToBird,
  birdingWeather,
  verifySighting,
  birdingWindow,
  speciesFrequency,
  planVacationBirding,
];

export const TOOLS = HANDLERS.map((h) => h.tool);
export const TOOL_HANDLERS = new Map(HANDLERS.map((h) => [h.tool.name, h.handle]));
