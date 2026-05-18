#!/usr/bin/env node
// index.js — entry point for the ebird-birding-planner MCP server.
//
// All real logic lives in dedicated modules:
//   - config.js              — env parsing + validation
//   - lifelist.js            — life-list loading
//   - server.js              — MCP boilerplate + request dispatch
//   - handlers/<name>.js     — one file per MCP tool
//
// Previously this file was a 1306-line god module that read env vars at
// import time and called process.exit() on missing keys. That made it
// impossible to import in tests. The new shape boots lazily — handlers
// fail per-call rather than crashing the runner — so tests can import
// individual modules in isolation.

import { loadConfig } from './config.js';
import { loadLifeListSync, defaultCsvPath } from './lifelist.js';
import { EBirdClient } from './ebird-client.js';
import { BirdCastClient } from './birdcast-client.js';
import { NWSClient } from './nws-client.js';
import { INaturalistClient } from './inaturalist-client.js';
import { MediaClient } from './media-client.js';
import { startServer } from './server.js';

async function main() {
  const config = loadConfig();

  // Warn (not fail) on missing API keys: the server can still answer some
  // tool calls (e.g. birding_window doesn't need any) and surfacing the
  // error per-tool is more useful than crashing the process at startup.
  if (!config.ebirdApiKey) {
    process.stderr.write('WARNING: EBIRD_API_KEY not set — eBird-backed tools will fail.\n');
  }
  if (!config.birdcastApiKey) {
    process.stderr.write('WARNING: BIRDCAST_API_KEY not set — BirdCast-backed tools will fail.\n');
  }

  const clients = {
    ebird:    new EBirdClient(config.ebirdApiKey),
    birdcast: new BirdCastClient(config.birdcastApiKey),
    nws:      new NWSClient(),
    inat:     new INaturalistClient(),
    media:    new MediaClient(),
  };

  // Resolve a life-list path: project JSON cache → env CSV → home-default CSV.
  // Loaded synchronously so the server starts ready; null if neither exists.
  const jsonPath = new URL('../data/life-list.json', import.meta.url).pathname;
  const csvPath = config.lifeListCsvPath || defaultCsvPath();
  const lifeList = loadLifeListSync({ jsonPath, csvPath });

  await startServer({ clients, config, lifeList });
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
