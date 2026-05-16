#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { EBirdClient } from "./ebird-client.js";
import { BirdCastClient } from "./birdcast-client.js";
import { NWSClient } from "./nws-client.js";
import { INaturalistClient } from "./inaturalist-client.js";
import suncalc from "suncalc";
import {
  Cache,
  resolveLocation,
  resolveDate,
  resolveDateRange,
  FAVORITE_HOTSPOTS,
  DEFAULTS,
  isCincinnatiArea,
  formatNumber,
} from "./utils.js";

// ---------------------------------------------------------------------------
// Clients & caches
// ---------------------------------------------------------------------------

const apiKey = process.env.EBIRD_API_KEY;
if (!apiKey) {
  process.stderr.write("ERROR: EBIRD_API_KEY environment variable is required.\n");
  process.exit(1);
}

const birdcastKey = process.env.BIRDCAST_API_KEY;
if (!birdcastKey) {
  process.stderr.write("ERROR: BIRDCAST_API_KEY environment variable is required.\n");
  process.exit(1);
}

const ebird = new EBirdClient(apiKey);
const birdcast = new BirdCastClient(birdcastKey);
const nws = new NWSClient();
const inat = new INaturalistClient();
const cache = new Cache();

const TAXONOMY_CACHE_KEY = "taxonomy";
const TAXONOMY_TTL = 7 * 24 * 60 * 60 * 1000; // 1 week
const BIRDCAST_TTL = 24 * 60 * 60 * 1000;      // 1 day
const HOTSPOT_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const NWS_CACHE_TTL = 60 * 60 * 1000;       // 1 hour
const INAT_CACHE_TTL = 6 * 60 * 60 * 1000;  // 6 hours

const inflightBirdCast = new Map();

// ---------------------------------------------------------------------------
// Taxonomy + species resolution
// ---------------------------------------------------------------------------

async function getTaxonomy() {
  if (cache.has(TAXONOMY_CACHE_KEY)) return cache.get(TAXONOMY_CACHE_KEY);
  const data = await ebird.getTaxonomy();
  cache.set(TAXONOMY_CACHE_KEY, data, TAXONOMY_TTL);
  return data;
}

async function resolveSpeciesCode(commonName) {
  const taxonomy = await getTaxonomy();
  const lower = commonName.toLowerCase();
  const match = taxonomy.find(
    (t) => t.comName?.toLowerCase() === lower
  );
  if (match) return match.speciesCode;
  // Partial match
  const partial = taxonomy.find(
    (t) => t.comName?.toLowerCase().includes(lower)
  );
  return partial?.speciesCode ?? null;
}

// ---------------------------------------------------------------------------
// Favorite hotspot resolution
// ---------------------------------------------------------------------------

async function resolveFavoriteHotspots() {
  const cacheKey = "favorite-hotspots";
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  try {
    const hotspots = await ebird.getNearbyHotspots(DEFAULTS.lat, DEFAULTS.lng, 30);
    const resolved = FAVORITE_HOTSPOTS.map((fav) => {
      const match = hotspots.find((h) =>
        h.locName?.toLowerCase().includes(fav.name.toLowerCase())
      );
      return { ...fav, locId: match?.locId ?? null, fullName: match?.locName ?? fav.name };
    });
    cache.set(cacheKey, resolved, HOTSPOT_CACHE_TTL);
    return resolved;
  } catch (err) {
    process.stderr.write(`Failed to resolve favorites: ${err.message}\n`);
    return FAVORITE_HOTSPOTS;
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function loc(input) {
  return resolveLocation(input) ?? {
    lat: DEFAULTS.lat,
    lng: DEFAULTS.lng,
    regionCode: DEFAULTS.regionCode,
    name: DEFAULTS.name,
  };
}

async function getBirdCastData(regionCode, dateStr) {
  if (!regionCode) return { live: null, season: null, species: null, summary: null };
  const liveKey = `bc-live-${regionCode}-${dateStr}`;
  const seasonKey = `bc-season-${regionCode}-${dateStr}`;
  const speciesKey = `bc-species-${regionCode}-${dateStr}`;

  async function fetchWithCoalesce(cacheKey, fetcher) {
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    if (inflightBirdCast.has(cacheKey)) return inflightBirdCast.get(cacheKey);
    const promise = fetcher().then(result => {
      if (result) cache.set(cacheKey, result, BIRDCAST_TTL);
      inflightBirdCast.delete(cacheKey);
      return result;
    }).catch(err => {
      inflightBirdCast.delete(cacheKey);
      throw err;
    });
    inflightBirdCast.set(cacheKey, promise);
    return promise;
  }

  const [live, season, species] = await Promise.all([
    fetchWithCoalesce(liveKey, () => birdcast.getLiveMigration(regionCode, dateStr)),
    fetchWithCoalesce(seasonKey, () => birdcast.getSeasonHistorical(regionCode, dateStr)),
    fetchWithCoalesce(speciesKey, () => birdcast.getExpectedSpecies(regionCode, dateStr)),
  ]);

  const summary = birdcast.summarizeMigration(live, season);
  return { live, season, species, summary };
}

async function getHotspotSpeciesCounts(hotspots) {
  const results = [];
  // Process in batches of 10 to respect rate limits
  for (let i = 0; i < hotspots.length; i += 10) {
    const batch = hotspots.slice(i, i + 10);
    const batchResults = await Promise.all(
      batch.map(async (h) => {
        try {
          const obs = await ebird.getRecentObservations(h.locId, 7);
          const speciesSet = new Set(obs.map((o) => o.speciesCode));
          return {
            ...h,
            recentSpeciesCount: speciesSet.size,
            recentObservations: obs,
            speciesList: [...speciesSet],
          };
        } catch (err) {
          process.stderr.write(`getHotspotSpeciesCounts error for ${h.locId}: ${err.message}\n`);
          return { ...h, recentSpeciesCount: 0, recentObservations: [], speciesList: [] };
        }
      })
    );
    results.push(...batchResults);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Numeric input helpers
// ---------------------------------------------------------------------------

function coerceNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const tools = [
  {
    name: "plan_birding_trip",
    description:
      "Plan a birding trip by finding the best nearby hotspots, combining recent species diversity, notable sightings, and BirdCast migration data. Returns ranked hotspots with migration context.",
    inputSchema: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description:
            'Region code (e.g. "US-OH-061"), lat/lng (e.g. "39.1,-84.5"), or city name (e.g. "Cincinnati"). Defaults to Cincinnati.',
        },
        date: {
          type: "string",
          description:
            'Date for the trip: "today", "tomorrow", "this weekend", "next Saturday", "May 20", or "2026-05-20". Defaults to today.',
        },
        radius_km: {
          type: "number",
          description: "Search radius in km (default 30).",
        },
      },
    },
  },
  {
    name: "migration_forecast",
    description:
      "Get BirdCast migration data for a region: last night's traffic, expected species, seasonal totals, and a plain-English summary. Only available during migration seasons (Mar-Jun, Aug-Nov).",
    inputSchema: {
      type: "object",
      properties: {
        region_code: {
          type: "string",
          description: 'BirdCast region code (e.g. "US-OH-061"). Defaults to Hamilton County, OH.',
        },
        date: {
          type: "string",
          description: 'Date for forecast. Defaults to today.',
        },
      },
    },
  },
  {
    name: "hotspot_details",
    description:
      "Get detailed info about a specific eBird hotspot: recent species, notable sightings, and frequency data for this time of year.",
    inputSchema: {
      type: "object",
      properties: {
        hotspot: {
          type: "string",
          description:
            'Hotspot location ID (e.g. "L12345") or name to search for.',
        },
        location: {
          type: "string",
          description: "Location context for name-based search (optional).",
        },
      },
      required: ["hotspot"],
    },
  },
  {
    name: "compare_hotspots",
    description:
      "Compare multiple eBird hotspots side-by-side: unique species, shared species, notable sightings, and checklist activity at each.",
    inputSchema: {
      type: "object",
      properties: {
        hotspots: {
          type: "array",
          items: { type: "string" },
          description:
            'Array of hotspot location IDs (e.g. ["L12345", "L67890"]) or names.',
        },
        location: {
          type: "string",
          description: "Location context for name-based search (optional).",
        },
      },
      required: ["hotspots"],
    },
  },
  {
    name: "species_finder",
    description:
      "Find where a specific bird species has been seen recently near a location, sorted by most recent observation.",
    inputSchema: {
      type: "object",
      properties: {
        species: {
          type: "string",
          description: 'Common name of the species (e.g. "Cerulean Warbler").',
        },
        location: {
          type: "string",
          description: "Region code, lat/lng, or city name. Defaults to Cincinnati.",
        },
        radius_km: {
          type: "number",
          description: "Search radius in km (default 50).",
        },
      },
      required: ["species"],
    },
  },
  {
    name: "best_day_to_bird",
    description:
      "Recommend the best day to go birding within a date range, combining BirdCast migration forecasts, historical eBird frequency data, and recent observation trends.",
    inputSchema: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "Region code, lat/lng, or city name. Defaults to Cincinnati.",
        },
        date_range: {
          type: "string",
          description:
            'Date range: "this week", "this weekend", "next 5 days", "May 15-22". Defaults to this week.',
        },
        target_species: {
          type: "string",
          description: "Optional common name of a target species to optimize for.",
        },
      },
    },
  },
  {
    name: "birding_weather",
    description:
      "Get NWS weather data interpreted for birding: overnight wind direction/speed (the key migration predictor), morning forecast, and a plain-English migration interpretation. Automatically combined into migration_forecast output.",
    inputSchema: {
      type: "object",
      properties: {
        lat: { type: "number", description: "Latitude (default 39.1 for Cincinnati)." },
        lng: { type: "number", description: "Longitude (default -84.5 for Cincinnati)." },
        date: { type: "string", description: "Date for forecast. Defaults to today." },
      },
    },
  },
  {
    name: "verify_sighting",
    description:
      "Cross-reference an eBird species sighting against iNaturalist photo-verified observations nearby. Returns confidence level and count of research-grade (photo-verified) reports.",
    inputSchema: {
      type: "object",
      properties: {
        species: { type: "string", description: "Common or scientific name of the species." },
        lat: { type: "number", description: "Latitude (default 39.1)." },
        lng: { type: "number", description: "Longitude (default -84.5)." },
        radius_km: { type: "number", description: "Search radius in km (default 30)." },
        days_back: { type: "number", description: "Days to look back (default 14)." },
      },
      required: ["species"],
    },
  },
  {
    name: "birding_window",
    description:
      "Calculate sunrise, civil twilight, and recommended arrival time for a birding session at a given location and date.",
    inputSchema: {
      type: "object",
      properties: {
        lat: { type: "number", description: "Latitude (default 39.1)." },
        lng: { type: "number", description: "Longitude (default -84.5)." },
        date: { type: "string", description: "Date. Defaults to today." },
        temp_f: { type: "number", description: "Optional forecasted temperature (°F) — adjusts activity cutoff estimate." },
      },
    },
  },
  {
    name: "species_frequency",
    description:
      "Look up historical frequency data for a species in a region using BirdCast bar chart data. Returns peak week, current probability, and whether the species is early/on-time/late relative to its historical peak.",
    inputSchema: {
      type: "object",
      properties: {
        species: { type: "string", description: "Common name of the species (e.g. \"Tennessee Warbler\")." },
        region_code: { type: "string", description: "eBird region code (default \"US-OH-061\")." },
        date: { type: "string", description: "Date for the lookup. Defaults to today." },
      },
      required: ["species"],
    },
  },
  {
    name: "plan_vacation_birding",
    description:
      "Discovery report for birding at a travel destination. Surfaces target species you won't easily find in Cincinnati, ranks hotspots by active birder community, and provides a birding window for the trip. Uses BirdCast historical bar chart frequencies so it works for trips weeks or months in advance — not just this week's live data.",
    inputSchema: {
      type: "object",
      properties: {
        destination: {
          type: "string",
          description: 'Destination as city name (e.g. "Cape May, NJ"), region code (e.g. "US-NJ-009"), or "lat,lng". Known cities: Cape May, Acadia, Asheville, New York, Chicago, San Francisco, Austin, Portland.',
        },
        dates: {
          type: "string",
          description: 'Trip dates: "May 20-25", "next week", "June 1-7", "July 4". Used to pick the right week of historical frequency data.',
        },
        home_region: {
          type: "string",
          description: 'Home region code for novelty comparison (default "US-OH-061" = Cincinnati).',
        },
      },
      required: ["destination"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handlePlanBirdingTrip(args) {
  const SCORE_SPECIES_WEIGHT = 2;
  const SCORE_NOTABLE_WEIGHT = 5;
  const HOTSPOT_CANDIDATE_LIMIT = 15;

  const location = loc(args.location);
  const dateInfo = resolveDate(args.date || "today") ?? resolveDate("today");
  const radius = Math.min(Math.max(1, coerceNumber(args.radius_km, DEFAULTS.radiusKm)), 100);
  const { lat, lng, regionCode } = location;

  if (!lat || !lng) {
    return { error: `Cannot determine coordinates for "${args.location}". Try a region code like US-OH-061 or lat/lng.` };
  }

  // Fetch hotspots, notable sightings, and BirdCast in parallel
  const [nearbyHotspots, notable, bc, birdingWin, weather] = await Promise.all([
    ebird.getNearbyHotspots(lat, lng, radius),
    ebird.getNearbyNotableObservations(lat, lng, 14, radius),
    regionCode ? getBirdCastData(regionCode, dateInfo.date) : Promise.resolve({ live: null, season: null, species: null, summary: null }),
    handleBirdingWindow({ lat, lng, date: dateInfo.date }).catch(() => null),
    nws.getBirdingWeather(lat, lng, dateInfo.date).catch(() => null),
  ]);

  // Limit to top candidates by numSpeciesAllTime, then get recent obs for each
  const topHotspots = nearbyHotspots
    .sort((a, b) => (b.numSpeciesAllTime ?? 0) - (a.numSpeciesAllTime ?? 0))
    .slice(0, HOTSPOT_CANDIDATE_LIMIT);

  const enriched = await getHotspotSpeciesCounts(topHotspots);

  // Check for favorites in Cincinnati area
  let favorites = [];
  if (isCincinnatiArea(lat, lng, regionCode)) {
    favorites = await resolveFavoriteHotspots();
    // Merge favorites that aren't already in the list
    for (const fav of favorites) {
      if (fav.locId && !enriched.find((h) => h.locId === fav.locId)) {
        try {
          const obs = await ebird.getRecentObservations(fav.locId, 7);
          const speciesSet = new Set(obs.map((o) => o.speciesCode));
          enriched.push({
            locId: fav.locId,
            locName: fav.fullName,
            recentSpeciesCount: speciesSet.size,
            recentObservations: obs,
            speciesList: [...speciesSet],
            isFavorite: true,
          });
        } catch { /* skip */ }
      }
    }
    // Mark existing favorites
    for (const h of enriched) {
      if (favorites.some((f) => f.locId === h.locId)) h.isFavorite = true;
    }
  }

  // Map notable sightings to hotspots
  const notableByLoc = {};
  for (const obs of notable) {
    const lid = obs.locId;
    if (!notableByLoc[lid]) notableByLoc[lid] = [];
    notableByLoc[lid].push({ species: obs.comName, date: obs.obsDt, locName: obs.locName });
  }

  // Score and rank
  const ranked = enriched
    .map((h) => {
      const notableHere = notableByLoc[h.locId] || [];
      const score = h.recentSpeciesCount * SCORE_SPECIES_WEIGHT + notableHere.length * SCORE_NOTABLE_WEIGHT;
      return { ...h, notableSightings: notableHere, score };
    })
    .sort((a, b) => b.score - a.score);

  // Build response
  const hotspotResults = ranked.map((h, i) => ({
    rank: i + 1,
    name: h.locName,
    locId: h.locId,
    isFavorite: h.isFavorite || false,
    recentSpeciesCount: h.recentSpeciesCount,
    notableSightings: h.notableSightings.slice(0, 5),
    score: h.score,
  }));

  // Area-wide notable sightings not tied to a ranked hotspot
  const areaNotable = notable
    .filter((o, i, arr) => arr.findIndex((x) => x.speciesCode === o.speciesCode) === i)
    .slice(0, 10)
    .map((o) => ({ species: o.comName, location: o.locName, date: o.obsDt }));

  const summary = buildTripSummary(hotspotResults, areaNotable, bc, dateInfo, location);

  return {
    summary,
    date: dateInfo.label,
    location: location.name,
    hotspots: hotspotResults,
    areaNotableSightings: areaNotable,
    migration: bc.summary || "No migration data available (outside season or unavailable).",
    expectedMigrants: bc.species?.slice(0, 10) ?? [],
    birdingWindow: birdingWin ?? null,
    weatherSummary: weather && !weather.weatherUnavailable ? weather.migrationInterpretation : null,
  };
}

async function handleBirdingWeather(args) {
  const lat = args.lat ?? DEFAULTS.lat;
  const lng = args.lng ?? DEFAULTS.lng;
  const dateInfo = resolveDate(args.date || "today") ?? resolveDate("today");
  return nws.getBirdingWeather(lat, lng, dateInfo.date);
}

async function handleVerifySighting(args) {
  if (!args.species) return { error: "species is required." };
  const lat = args.lat ?? DEFAULTS.lat;
  const lng = args.lng ?? DEFAULTS.lng;
  const radius = Math.min(Math.max(1, coerceNumber(args.radius_km, 30)), 200);
  const daysBack = Math.min(Math.max(1, coerceNumber(args.days_back, 14)), 30);
  return inat.getVerifiedSightings(args.species, lat, lng, radius, daysBack);
}

async function handleBirdingWindow(args) {
  const lat = args.lat ?? DEFAULTS.lat;
  const lng = args.lng ?? DEFAULTS.lng;
  const dateInfo = resolveDate(args.date || "today") ?? resolveDate("today");
  const tempF = args.temp_f != null ? coerceNumber(args.temp_f, null) : null;

  const dateObj = new Date(dateInfo.date + "T12:00:00");
  const times = suncalc.getTimes(dateObj, lat, lng);

  function fmtTime(d) {
    if (!d || isNaN(d.getTime())) return "N/A";
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/New_York" });
  }

  const civilTwilight = fmtTime(times.dawn);
  const sunrise = fmtTime(times.sunrise);
  const goldenHourEnd = fmtTime(times.goldenHour);

  // Activity cutoff: base 10:30 AM, subtract 15 min per 5°F above 75°F
  let cutoffMinutes = 10 * 60 + 30; // 10:30 AM in minutes from midnight
  if (tempF != null && tempF > 75) {
    cutoffMinutes -= Math.floor((tempF - 75) / 5) * 15;
  }
  const cutoffH = Math.floor(cutoffMinutes / 60);
  const cutoffM = cutoffMinutes % 60;
  const activityCutoff = `${cutoffH > 12 ? cutoffH - 12 : cutoffH}:${String(cutoffM).padStart(2, "0")} ${cutoffH >= 12 ? "PM" : "AM"}`;

  const tempNote = tempF != null ? ` at forecasted ${Math.round(tempF)}°F` : "";
  const recommendation = `Arrive by ${civilTwilight} (civil twilight). Peak songbird activity ${sunrise}–9:30 AM. Heat suppresses activity after ~${activityCutoff}${tempNote}.`;

  return { civilTwilight, sunrise, goldenHourEnd, activityCutoff, recommendation };
}

async function handleSpeciesFrequency(args) {
  if (!args.species) return { error: "species is required." };
  const regionCode = args.region_code || DEFAULTS.regionCode;
  const dateInfo = resolveDate(args.date || "today") ?? resolveDate("today");

  if (!birdcast.isInMigrationSeason(dateInfo.date)) {
    return { summary: `${dateInfo.date} is outside migration season. Frequency data is only available March–June and August–November.` };
  }

  const speciesCode = await resolveSpeciesCode(args.species);
  if (!speciesCode) {
    return { error: `Could not find species "${args.species}" in eBird taxonomy.` };
  }

  const allSpecies = await birdcast.getExpectedSpecies(regionCode, dateInfo.date);
  if (!allSpecies) {
    return { error: "BirdCast frequency data unavailable for this region/date." };
  }

  const entry = allSpecies.find((s) => s.speciesCode === speciesCode || s.commonName?.toLowerCase() === args.species.toLowerCase());
  if (!entry || !entry.probability) {
    return { species: args.species, speciesCode, currentWeekProbability: 0, interpretation: `${args.species} has no BirdCast frequency data for ${regionCode}.` };
  }

  // Find peak week from the full bar chart — getExpectedSpecies already computed per-week probabilities
  // We only have the current week's value from the returned entry. For peak, re-fetch and scan all weeks.
  // For now use the current week value and note peak detection requires full bar chart.
  const currentProb = entry.probability;

  // Determine week of year for phenology status
  const d = new Date(dateInfo.date + "T12:00:00Z");
  const startOfYear = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekIndex = Math.min(Math.floor((d - startOfYear) / (7 * 24 * 60 * 60 * 1000)), 47);

  // Spring peak weeks for warblers typically 17-22 (late April - late May)
  // Rough phenology: if weekIndex < 10 → early season, 10-20 → building, 20-25 → peak, >25 → declining
  let phenologyStatus;
  if (weekIndex < 17) phenologyStatus = "pre-peak";
  else if (weekIndex <= 22) phenologyStatus = "at-peak";
  else phenologyStatus = "post-peak";

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

function buildTripSummary(hotspots, notable, bc, dateInfo, location) {
  const parts = [`Birding plan for ${dateInfo.label} near ${location.name}:`];

  if (hotspots.length > 0) {
    const top3 = hotspots.slice(0, 3);
    parts.push(
      `Top hotspots: ${top3.map((h) => `${h.name} (${h.recentSpeciesCount} species this week${h.isFavorite ? ", ★ favorite" : ""})`).join(", ")}.`
    );
  }

  if (notable.length > 0) {
    parts.push(
      `Notable sightings in the area: ${notable.slice(0, 5).map((n) => n.species).join(", ")}.`
    );
  }

  if (bc.summary) {
    parts.push(`Migration: ${bc.summary}`);
  }

  if (bc.species?.length > 0) {
    parts.push(
      `Expected migrants: ${bc.species.slice(0, 5).map((s) => s.commonName).join(", ")}.`
    );
  }

  return parts.join("\n\n");
}

async function handleMigrationForecast(args) {
  const regionCode = args.region_code || DEFAULTS.regionCode;
  const dateInfo = resolveDate(args.date || "today") ?? resolveDate("today");

  if (!birdcast.isInMigrationSeason(dateInfo.date)) {
    return {
      summary: `${dateInfo.date} is outside migration season. BirdCast data is available March 1 - June 15 and August 1 - November 15.`,
      inSeason: false,
      regionCode,
      date: dateInfo.label,
    };
  }

  const bc = await getBirdCastData(regionCode, dateInfo.date);

  const result = {
    regionCode,
    date: dateInfo.label,
    inSeason: true,
    summary: bc.summary || "Migration data unavailable for this region/date.",
    expectedSpecies: bc.species?.slice(0, 15) ?? [],
  };

  if (bc.live) {
    result.lastNight = {
      cumulativeBirds: bc.live.cumulativeBirds,
      isHighIntensity: bc.live.isHigh,
    };

    // Find peak from nightSeries
    const series = bc.live.nightSeries || [];
    if (series.length > 0) {
      const peak = series.reduce((best, cur) => (cur.numAloft > (best?.numAloft ?? 0) ? cur : best), null);
      if (peak) {
        result.lastNight.peakBirdsInFlight = peak.numAloft;
        result.lastNight.peakDirection = peak.avgDirection;
        result.lastNight.peakSpeed = peak.avgSpeed;
        result.lastNight.peakAltitude = peak.meanHeight;
      }
    }
  }

  if (bc.season?.season) {
    const current = bc.season.season.currentSeasonSeries;
    const avg = bc.season.season.annualAvgSeries;
    if (current?.length > 0) {
      const latest = current[current.length - 1];
      result.seasonTotal = latest.totalBirds ?? latest.value ?? latest;
    }
    if (avg?.length > 0) {
      const latestAvg = avg[avg.length - 1];
      result.historicalAverage = latestAvg.totalBirds ?? latestAvg.value ?? latestAvg;
    }
  }

  // Enrich with NWS weather interpretation
  try {
    const weather = await nws.getBirdingWeather(DEFAULTS.lat, DEFAULTS.lng, dateInfo.date);
    if (!weather.weatherUnavailable) {
      result.overnightWinds = weather.overnight;
      result.morningWeather = weather.morning;
      result.weatherInterpretation = weather.migrationInterpretation;
      result.summary = result.summary + "\n\nWeather: " + weather.migrationInterpretation;
    }
  } catch { /* weather enrichment is best-effort */ }

  return result;
}

async function handleHotspotDetails(args) {
  let locId = args.hotspot;

  // If not a location ID pattern, search by name
  if (!/^L\d+$/.test(locId)) {
    // Cap string input at 200 chars to avoid excessively long searches
    if (typeof locId === 'string' && locId.length > 200) {
      locId = locId.slice(0, 200);
    }
    const location = loc(args.location);
    if (location.lat && location.lng) {
      const hotspots = await ebird.getNearbyHotspots(location.lat, location.lng, 50);
      const match = hotspots.find((h) =>
        h.locName?.toLowerCase().includes(locId.toLowerCase())
      );
      if (!match) {
        return { error: `No hotspot found matching "${locId}" near ${location.name}.` };
      }
      locId = match.locId;
    } else if (location.regionCode) {
      const hotspots = await ebird.searchHotspotsByRegion(location.regionCode);
      const match = hotspots.find((h) =>
        h.locName?.toLowerCase().includes(locId.toLowerCase())
      );
      if (!match) {
        return { error: `No hotspot found matching "${locId}" in ${location.regionCode}.` };
      }
      locId = match.locId;
    }
  }

  const [info, recentObs, notableObs] = await Promise.all([
    ebird.getHotspotInfo(locId).catch(() => null),
    ebird.getRecentObservations(locId, 7),
    ebird.getRecentObservations(locId, 14),
  ]);

  const speciesSet = new Set(recentObs.map((o) => o.speciesCode));
  const speciesWithDates = {};
  for (const obs of recentObs) {
    if (!speciesWithDates[obs.speciesCode]) {
      speciesWithDates[obs.speciesCode] = {
        name: obs.comName,
        lastSeen: obs.obsDt,
        count: obs.howMany,
      };
    }
  }

  // Get 14-day species for "frequency" approximation
  const allSpecies14 = new Set(notableObs.map((o) => o.speciesCode));

  return {
    summary: `${info?.locName ?? locId}: ${speciesSet.size} species in the last 7 days, ${allSpecies14.size} in the last 14 days.`,
    locId,
    name: info?.locName ?? locId,
    coordinates: info ? { lat: info.latitude, lng: info.longitude } : null,
    recentSpeciesCount: speciesSet.size,
    recentSpecies: Object.values(speciesWithDates)
      .sort((a, b) => b.lastSeen?.localeCompare(a.lastSeen))
      .slice(0, 50),
    totalSpeciesAllTime: info?.numSpeciesAllTime ?? null,
  };
}

async function handleCompareHotspots(args) {
  let hotspotInputs = args.hotspots;
  if (!hotspotInputs || hotspotInputs.length < 2) {
    return { error: "Please provide at least 2 hotspot IDs or names to compare." };
  }

  let capped = false;
  if (hotspotInputs.length > 10) {
    capped = true;
    hotspotInputs = hotspotInputs.slice(0, 10);
  }

  const location = loc(args.location);

  // Resolve names to IDs if needed
  let nearbyHotspots = null;
  const resolvedIds = [];
  for (const input of hotspotInputs) {
    if (input.startsWith("L")) {
      resolvedIds.push(input);
    } else {
      if (!nearbyHotspots && location.lat && location.lng) {
        nearbyHotspots = await ebird.getNearbyHotspots(location.lat, location.lng, 50);
      }
      const match = nearbyHotspots?.find((h) =>
        h.locName?.toLowerCase().includes(input.toLowerCase())
      );
      if (match) {
        resolvedIds.push(match.locId);
      } else {
        return { error: `Could not find hotspot matching "${input}".` };
      }
    }
  }

  // Fetch data for each hotspot in parallel
  const hotspotData = await Promise.all(
    resolvedIds.map(async (locId) => {
      const [info, obs] = await Promise.all([
        ebird.getHotspotInfo(locId).catch(() => null),
        ebird.getRecentObservations(locId, 7),
      ]);
      const speciesSet = new Set(obs.map((o) => o.speciesCode));
      return {
        locId,
        name: info?.locName ?? locId,
        speciesCodes: speciesSet,
        speciesNames: new Map(obs.map((o) => [o.speciesCode, o.comName])),
        checklistCount: new Set(obs.map((o) => o.subId)).size,
        recentSpeciesCount: speciesSet.size,
        totalSpeciesAllTime: info?.numSpeciesAllTime ?? null,
      };
    })
  );

  // Compute shared and unique species
  const allCodes = new Set(hotspotData.flatMap((h) => [...h.speciesCodes]));
  const shared = [...allCodes].filter((code) => hotspotData.every((h) => h.speciesCodes.has(code)));

  const comparison = hotspotData.map((h) => {
    const unique = [...h.speciesCodes].filter(
      (code) => !hotspotData.some((other) => other.locId !== h.locId && other.speciesCodes.has(code))
    );
    return {
      locId: h.locId,
      name: h.name,
      recentSpeciesCount: h.recentSpeciesCount,
      totalSpeciesAllTime: h.totalSpeciesAllTime,
      checklistsThisWeek: h.checklistCount,
      uniqueSpecies: unique.map((c) => h.speciesNames.get(c) ?? c),
    };
  });

  // Resolve shared codes to names
  const nameMap = hotspotData[0].speciesNames;
  const sharedNames = shared.map((c) => nameMap.get(c) ?? c);

  // Verify up to 3 unique species via iNaturalist
  if (location.lat != null) {
    const allUnique = comparison.flatMap((h) => h.uniqueSpecies).slice(0, 3);
    const verifications = await Promise.all(
      allUnique.map((sp) => inat.getVerifiedSightings(sp, location.lat ?? DEFAULTS.lat, location.lng ?? DEFAULTS.lng, 30, 14).catch(() => null))
    );
    const verifiedMap = {};
    allUnique.forEach((sp, i) => {
      if (verifications[i]) verifiedMap[sp] = { confidence: verifications[i].confidence, photoCount: verifications[i].photoVerifiedCount };
    });
    // Attach to each hotspot's uniqueSpecies
    for (const h of comparison) {
      h.uniqueSpeciesVerified = h.uniqueSpecies.map((sp) => ({ species: sp, ...(verifiedMap[sp] ?? {}) }));
    }
  }

  const summary = comparison
    .map((h) => `${h.name}: ${h.recentSpeciesCount} species, ${h.checklistsThisWeek} checklists, ${h.uniqueSpecies.length} unique`)
    .join(" | ");

  const result = {
    summary: `Comparison: ${summary}. ${sharedNames.length} species shared across all.`,
    sharedSpecies: sharedNames,
    sharedSpeciesCount: sharedNames.length,
    hotspots: comparison,
  };

  if (capped) {
    result.note = "Input was limited to 10 hotspots.";
  }

  return result;
}

async function handleSpeciesFinder(args) {
  const speciesName = args.species;
  const location = loc(args.location);
  const radius = Math.min(Math.max(1, coerceNumber(args.radius_km, 50)), 100);

  const speciesCode = await resolveSpeciesCode(speciesName);
  if (!speciesCode) {
    return { error: `Could not find species "${speciesName}" in eBird taxonomy. Try the full common name (e.g. "Cerulean Warbler").` };
  }

  if (!location.lat || !location.lng) {
    return { error: `Cannot determine coordinates for "${args.location}". Provide lat/lng or a known city.` };
  }

  const observations = await ebird.getNearbySpeciesObservations(
    location.lat, location.lng, speciesCode, 30, radius
  );

  if (!observations || observations.length === 0) {
    return {
      summary: `No recent sightings of ${speciesName} within ${radius}km of ${location.name} in the last 30 days.`,
      species: speciesName,
      speciesCode,
      sightings: [],
    };
  }

  // Deduplicate by location, keeping most recent
  const byLoc = {};
  for (const obs of observations) {
    if (!byLoc[obs.locId] || obs.obsDt > byLoc[obs.locId].obsDt) {
      byLoc[obs.locId] = obs;
    }
  }

  const sightings = Object.values(byLoc)
    .sort((a, b) => b.obsDt.localeCompare(a.obsDt))
    .map((o) => ({
      location: o.locName,
      locId: o.locId,
      date: o.obsDt,
      count: o.howMany ?? "present",
      lat: o.lat,
      lng: o.lng,
    }));

  return {
    summary: `${speciesName} seen at ${sightings.length} locations near ${location.name} in the last 30 days. Most recent: ${sightings[0].location} on ${sightings[0].date}.`,
    species: speciesName,
    speciesCode,
    sightings: sightings.slice(0, 20),
  };
}

async function handleBestDayToBird(args) {
  const location = loc(args.location);
  const range = resolveDateRange(args.date_range || "this week") ?? resolveDateRange("this week");
  const regionCode = location.regionCode || DEFAULTS.regionCode;

  // Generate dates in range
  const dates = [];
  const start = new Date(range.start + "T12:00:00");
  const end = new Date(range.end + "T12:00:00");
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    dates.push(new Date(d));
  }

  if (dates.length > 14) {
    return { error: "Date range too large. Please use a range of 14 days or fewer." };
  }

  // Get BirdCast data for each date
  const dayAnalysis = await Promise.all(
    dates.map(async (d) => {
      const dateStr = d.toISOString().slice(0, 10);
      const dayName = d.toLocaleDateString("en-US", { weekday: "long" });
      const label = `${dayName} ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

      let migrationScore = 0;
      let migrationNote = "";
      let bcData = null;

      if (birdcast.isInMigrationSeason(dateStr)) {
        const bcResult = await getBirdCastData(regionCode, dateStr);
        bcData = bcResult.live;
        if (bcData) {
          const birds = bcData.cumulativeBirds ?? 0;
          migrationScore = bcData.isHigh ? 3 : birds > 100000 ? 2 : birds > 10000 ? 1 : 0;
          migrationNote = `${formatNumber(birds)} birds${bcData.isHigh ? " (HIGH)" : ""}`;
        }
      }

      // Get checklist stats for the date (if in the past)
      let statsNote = "";
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (d <= today) {
        try {
          const stats = await ebird.getRegionStats(regionCode, d.getFullYear(), d.getMonth() + 1, d.getDate());
          if (stats) {
            statsNote = `${stats.numChecklists ?? 0} checklists, ${stats.numSpecies ?? 0} species reported`;
            if (stats?.numSpecies) {
              migrationScore += Math.min(Math.floor(stats.numSpecies / 10), 2); // up to +2 bonus
            }
          }
        } catch { /* future date, no stats */ }
      }

      return { date: dateStr, label, migrationScore, migrationNote, statsNote, bcData };
    })
  );

  // Target species check
  let targetNote = "";
  if (args.target_species) {
    const code = await resolveSpeciesCode(args.target_species);
    if (code && location.lat && location.lng) {
      const obs = await ebird.getNearbySpeciesObservations(
        location.lat, location.lng, code, 14, 50
      );
      if (obs?.length > 0) {
        targetNote = `${args.target_species} has been seen at ${new Set(obs.map((o) => o.locId)).size} locations in the last 14 days. Most recent: ${obs[0].obsDt} at ${obs[0].locName}.`;
      } else {
        targetNote = `${args.target_species} has not been reported nearby in the last 14 days.`;
      }
    }
  }

  // Rank days
  const ranked = dayAnalysis.sort((a, b) => b.migrationScore - a.migrationScore);

  const bestDay = ranked[0];
  const parts = [`Best day recommendation for ${range.label} near ${location.name}:`];
  parts.push(`${bestDay.label} looks best${bestDay.migrationNote ? ` — ${bestDay.migrationNote} overnight migration` : ""}.`);

  if (targetNote) parts.push(targetNote);

  const dayDetails = dayAnalysis.map((d) => ({
    date: d.date,
    label: d.label,
    migrationIntensity: d.migrationNote || "no data",
    ebirdActivity: d.statsNote || "no data yet",
    score: d.migrationScore,
  }));

  return {
    summary: parts.join("\n\n"),
    recommendation: bestDay.label,
    dateRange: range.label,
    location: location.name,
    days: dayDetails,
    targetSpecies: targetNote || null,
  };
}

// ---------------------------------------------------------------------------
// plan_vacation_birding
// ---------------------------------------------------------------------------

const NOISE_SPECIES = new Set([
  'House Sparrow', 'European Starling', 'Rock Pigeon', 'American Robin',
  'Mourning Dove', 'Northern Cardinal', 'American Crow',
]);

async function resolveDestination(raw) {
  const fromLookup = resolveLocation(raw);
  if (fromLookup) return fromLookup;

  // Fall back to BirdCast region search
  const regions = await birdcast.findRegion(raw).catch(() => []);
  if (!regions.length) return null;

  const regionCode = regions[0].code;
  const dest = { lat: null, lng: null, regionCode, name: regions[0].name || raw };

  if (regionCode && /^[A-Z]{2}-[A-Z]{2,3}(-\d{1,3})?$/i.test(regionCode)) {
    const hotspots = await ebird.searchHotspotsByRegion(regionCode).catch(() => []);
    if (hotspots?.length > 0) {
      dest.lat = hotspots[0].lat ?? null;
      dest.lng = hotspots[0].lng ?? null;
    }
  }
  return dest;
}

async function loadLifeList(csvPath) {
  if (!csvPath) return null;
  try {
    const { readFile } = await import('fs/promises');
    const content = await readFile(csvPath, 'utf8');
    const seen = new Set();
    const lines = content.split('\n');
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      // Common Name is column index 1; species names never contain commas
      const firstComma = line.indexOf(',');
      const secondComma = line.indexOf(',', firstComma + 1);
      if (firstComma < 0 || secondComma < 0) continue;
      const name = line.slice(firstComma + 1, secondComma).trim();
      // Normalize parenthetical subspecies: "Rock Pigeon (Feral Pigeon)" → "Rock Pigeon"
      const normalized = name.replace(/\s*\(.*?\)$/, '').trim();
      if (normalized) {
        seen.add(name);
        seen.add(normalized);
      }
    }
    return seen.size > 0 ? seen : null;
  } catch (err) {
    process.stderr.write(`Life list CSV error: ${err.message}\n`);
    return null;
  }
}

async function handlePlanVacationBirding(args) {
  const homeRegion = args.home_region || DEFAULTS.regionCode;
  const destination = await resolveDestination(args.destination);

  if (!destination) {
    return { error: `Cannot resolve "${args.destination}". Try a region code (e.g. "US-NJ-009"), "lat,lng", or a recognized city name.` };
  }
  if (!destination.lat || !destination.lng) {
    return { error: `Cannot determine coordinates for "${args.destination}". Please provide as "lat,lng" or a county-level region code.` };
  }

  const dateRange = args.dates ? resolveDateRange(args.dates) : null;
  const tripStartDate = dateRange?.start ?? new Date().toISOString().split('T')[0];
  const tripLabel = dateRange?.label ?? 'upcoming trip';

  const { lat, lng, regionCode } = destination;

  // Fetch all data in parallel — life list loads alongside API calls
  const [nearbyHotspots, notableObs, destSpecies, homeSpecies, birdingWin, lifeList] = await Promise.all([
    ebird.getNearbyHotspots(lat, lng, 50).catch(() => []),
    ebird.getNearbyNotableObservations(lat, lng, 14, 50).catch(() => []),
    regionCode
      ? birdcast.getExpectedSpecies(regionCode, tripStartDate, { ignoreSeasonCheck: true }).catch(() => null)
      : Promise.resolve(null),
    birdcast.getExpectedSpecies(homeRegion, tripStartDate, { ignoreSeasonCheck: true }).catch(() => null),
    handleBirdingWindow({ lat, lng, date: tripStartDate }).catch(() => null),
    loadLifeList(process.env.EBIRD_LIFE_LIST_CSV),
  ]);

  // Rank top 15 hotspots by all-time count, then re-rank by recent checklist count
  const candidates = Array.isArray(nearbyHotspots)
    ? nearbyHotspots.sort((a, b) => (b.numSpeciesAllTime ?? 0) - (a.numSpeciesAllTime ?? 0)).slice(0, 15)
    : [];

  const hotspotData = (await Promise.all(
    candidates.map(async (h) => {
      const obs = await ebird.getRecentObservations(h.locId, 7).catch(() => []);
      const speciesCount = new Set((obs || []).map((o) => o.speciesCode)).size;
      const checklistCount = new Set((obs || []).map((o) => o.subId).filter(Boolean)).size;
      return { name: h.locName, locId: h.locId, recentSpecies: speciesCount, recentChecklists: checklistCount };
    })
  ))
    .sort((a, b) => b.recentChecklists - a.recentChecklists)
    .filter((h) => h.recentChecklists > 0)
    .slice(0, 5);

  // Compute target species using BirdCast historical bar chart frequencies
  let targetSpecies;
  let dataNote;

  if (destSpecies) {
    const homeMap = homeSpecies
      ? new Map(homeSpecies.map((s) => [s.commonName, s.probability]))
      : new Map();

    let destThreshold = 0.15;
    const homeThreshold = 0.10;

    let pool = destSpecies
      .filter((s) => s.commonName && !NOISE_SPECIES.has(s.commonName))
      .filter((s) => s.probability >= destThreshold)
      .map((s) => ({ ...s, homeProbability: homeMap.get(s.commonName) ?? 0 }));

    if (lifeList) {
      // Life-list mode: primary split is seen vs. not seen
      // Still filter to species that are rare/absent in Cincinnati to keep the list focused
      pool = pool.filter((s) => s.homeProbability < homeThreshold);

      // Tighten if too many
      if (pool.length > 40) {
        pool = pool.filter((s) => s.probability > 0.25 && s.homeProbability < 0.05);
      }
      // Relax if too few
      if (pool.length < 5) {
        destThreshold = 0.10;
        pool = destSpecies
          .filter((s) => s.commonName && !NOISE_SPECIES.has(s.commonName))
          .filter((s) => s.probability >= destThreshold)
          .filter((s) => (homeMap.get(s.commonName) ?? 0) < homeThreshold)
          .map((s) => ({ ...s, homeProbability: homeMap.get(s.commonName) ?? 0 }));
      }

      const toEntry = (s) => ({
        name: s.commonName,
        destinationFrequency: Math.round(s.probability * 100) / 100,
        cincinnatiFrequency: Math.round(s.homeProbability * 100) / 100,
        onYourLifeList: lifeList.has(s.commonName),
      });

      const notSeen = pool.filter((s) => !lifeList.has(s.commonName));
      const alreadySeen = pool.filter((s) => lifeList.has(s.commonName));

      targetSpecies = {
        newToYourLifeList: notSeen
          .sort((a, b) => b.probability - a.probability)
          .slice(0, 15)
          .map(toEntry),
        seenBeforeButRareHere: alreadySeen
          .sort((a, b) => b.probability - a.probability)
          .slice(0, 10)
          .map(toEntry),
      };

      const lifeTally = lifeList.size;
      dataNote = `Using your eBird life list (${lifeTally} species). ` +
        `"New to your life list" = findable here (>${Math.round(destThreshold * 100)}% frequency) but not in your records. ` +
        `Frequencies from BirdCast historical bar chart for the week of ${tripStartDate}.`;
    } else {
      // No life list: fall back to Cincinnati frequency comparison
      pool = pool.filter((s) => s.homeProbability < homeThreshold);

      if (pool.length > 40) {
        pool = pool.filter((s) => s.probability > 0.25 && s.homeProbability < 0.05);
      }

      let similarNote = null;
      if (pool.length < 5) {
        destThreshold = 0.10;
        pool = destSpecies
          .filter((s) => s.commonName && !NOISE_SPECIES.has(s.commonName))
          .filter((s) => s.probability >= destThreshold)
          .filter((s) => (homeMap.get(s.commonName) ?? 0) < homeThreshold)
          .map((s) => ({ ...s, homeProbability: homeMap.get(s.commonName) ?? 0 }));
        similarNote = 'This destination has similar species to Cincinnati — thresholds relaxed to show the most distinctive local birds.';
      }

      const toEntry = (s) => ({
        name: s.commonName,
        destinationFrequency: Math.round(s.probability * 100) / 100,
        cincinnatiFrequency: Math.round(s.homeProbability * 100) / 100,
      });

      targetSpecies = {
        wontFindInCincinnati: pool
          .filter((s) => s.homeProbability < 0.02)
          .sort((a, b) => b.probability - a.probability)
          .slice(0, 15)
          .map(toEntry),
        rareInCincinnati: pool
          .filter((s) => s.homeProbability >= 0.02)
          .sort((a, b) => b.probability - a.probability)
          .slice(0, 15)
          .map(toEntry),
      };

      dataNote = similarNote
        ?? `Frequencies from BirdCast historical bar chart for the week of ${tripStartDate}. Set EBIRD_LIFE_LIST_CSV for personalized life-list comparisons.`;
    }
  } else {
    targetSpecies = lifeList
      ? { newToYourLifeList: [], seenBeforeButRareHere: [] }
      : { wontFindInCincinnati: [], rareInCincinnati: [] };
    dataNote = regionCode
      ? 'BirdCast frequency data unavailable for this destination or date. Target species comparison omitted.'
      : 'No region code available — target species comparison requires a county-level region code or recognized city.';
  }

  // Notable recent sightings (deduped by species), annotated with life-list status
  const notableRecentSightings = Array.isArray(notableObs)
    ? [...new Map(notableObs.map((o) => [o.speciesCode, o])).values()]
        .map((o) => ({
          name: o.comName,
          date: o.obsDt,
          location: o.locName,
          ...(lifeList ? { onYourLifeList: lifeList.has(o.comName) } : {}),
        }))
        .slice(0, 10)
    : [];

  // Build summary
  const primaryCount = lifeList
    ? (targetSpecies.newToYourLifeList?.length ?? 0)
    : (targetSpecies.wontFindInCincinnati?.length ?? 0);
  const secondaryCount = lifeList
    ? (targetSpecies.seenBeforeButRareHere?.length ?? 0)
    : (targetSpecies.rareInCincinnati?.length ?? 0);

  const topSpot = hotspotData[0];
  const parts = [`${destination.name} — ${tripLabel}.`];
  if (primaryCount > 0 || secondaryCount > 0) {
    if (lifeList) {
      parts.push(`★ ${primaryCount} species not on your life list that are findable here, ▲ ${secondaryCount} you've seen before but are rare in Cincinnati.`);
    } else {
      parts.push(`★ ${primaryCount} species you won't find in Cincinnati, ▲ ${secondaryCount} more that are rare there but common here.`);
    }
  }
  if (topSpot) {
    parts.push(`Top spot: ${topSpot.name} — ${topSpot.recentChecklists} checklists and ${topSpot.recentSpecies} species in the last week.`);
  }
  if (destSpecies) {
    parts.push('Frequency data is historical (multi-year eBird records) — reliable for planning ahead regardless of current conditions.');
  }

  return {
    destination: destination.name,
    dates: tripLabel,
    lifeListLoaded: lifeList ? `${lifeList.size} species` : null,
    birdingWindow: birdingWin,
    topHotspots: hotspotData,
    targetSpecies,
    notableRecentSightings,
    dataNote,
    summary: parts.join(' '),
  };
}

// ---------------------------------------------------------------------------
// MCP server setup
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "ebird-birding-planner", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;
    switch (name) {
      case "plan_birding_trip":
        result = await handlePlanBirdingTrip(args);
        break;
      case "migration_forecast":
        result = await handleMigrationForecast(args);
        break;
      case "hotspot_details":
        result = await handleHotspotDetails(args);
        break;
      case "compare_hotspots":
        result = await handleCompareHotspots(args);
        break;
      case "species_finder":
        result = await handleSpeciesFinder(args);
        break;
      case "best_day_to_bird":
        result = await handleBestDayToBird(args);
        break;
      case "birding_weather":
        result = await handleBirdingWeather(args);
        break;
      case "verify_sighting":
        result = await handleVerifySighting(args);
        break;
      case "birding_window":
        result = await handleBirdingWindow(args);
        break;
      case "species_frequency":
        result = await handleSpeciesFrequency(args);
        break;
      case "plan_vacation_birding":
        result = await handlePlanVacationBirding(args);
        break;
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    process.stderr.write(`Error in ${name}: ${error.message}\n${error.stack}\n`);
    return {
      content: [{ type: "text", text: "An error occurred fetching birding data. Check server logs for details." }],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("ebird-birding-planner MCP server running\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
