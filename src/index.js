#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { EBirdClient } from "./ebird-client.js";
import { BirdCastClient } from "./birdcast-client.js";
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

const ebird = new EBirdClient(apiKey);
const birdcast = new BirdCastClient();
const cache = new Cache();

const TAXONOMY_CACHE_KEY = "taxonomy";
const TAXONOMY_TTL = 7 * 24 * 60 * 60 * 1000; // 1 week
const BIRDCAST_TTL = 24 * 60 * 60 * 1000;      // 1 day
const HOTSPOT_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

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

  const live = cache.has(liveKey) ? cache.get(liveKey) : await birdcast.getLiveMigration(regionCode, dateStr);
  const season = cache.has(seasonKey) ? cache.get(seasonKey) : await birdcast.getSeasonHistorical(regionCode, dateStr);
  const species = cache.has(speciesKey) ? cache.get(speciesKey) : await birdcast.getExpectedSpecies(regionCode, dateStr);

  if (live) cache.set(liveKey, live, BIRDCAST_TTL);
  if (season) cache.set(seasonKey, season, BIRDCAST_TTL);
  if (species) cache.set(speciesKey, species, BIRDCAST_TTL);

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
        } catch {
          return { ...h, recentSpeciesCount: 0, recentObservations: [], speciesList: [] };
        }
      })
    );
    results.push(...batchResults);
  }
  return results;
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
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handlePlanBirdingTrip(args) {
  const location = loc(args.location);
  const dateInfo = resolveDate(args.date || "today") ?? resolveDate("today");
  const radius = args.radius_km ?? DEFAULTS.radiusKm;
  const { lat, lng, regionCode } = location;

  if (!lat || !lng) {
    return { error: `Cannot determine coordinates for "${args.location}". Try a region code like US-OH-061 or lat/lng.` };
  }

  // Fetch hotspots, notable sightings, and BirdCast in parallel
  const [nearbyHotspots, notable, bc] = await Promise.all([
    ebird.getNearbyHotspots(lat, lng, radius),
    ebird.getNearbyNotableObservations(lat, lng, 14, radius),
    regionCode ? getBirdCastData(regionCode, dateInfo.date) : Promise.resolve({ live: null, season: null, species: null, summary: null }),
  ]);

  // Limit to top 15 hotspots by numSpeciesAllTime, then get recent obs for each
  const topHotspots = nearbyHotspots
    .sort((a, b) => (b.numSpeciesAllTime ?? 0) - (a.numSpeciesAllTime ?? 0))
    .slice(0, 15);

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
      const score = h.recentSpeciesCount * 2 + notableHere.length * 5;
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

  return result;
}

async function handleHotspotDetails(args) {
  let locId = args.hotspot;

  // If not a location ID pattern, search by name
  if (!locId.startsWith("L")) {
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
  const hotspotInputs = args.hotspots;
  if (!hotspotInputs || hotspotInputs.length < 2) {
    return { error: "Please provide at least 2 hotspot IDs or names to compare." };
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

  const summary = comparison
    .map((h) => `${h.name}: ${h.recentSpeciesCount} species, ${h.checklistsThisWeek} checklists, ${h.uniqueSpecies.length} unique`)
    .join(" | ");

  return {
    summary: `Comparison: ${summary}. ${sharedNames.length} species shared across all.`,
    sharedSpecies: sharedNames,
    sharedSpeciesCount: sharedNames.length,
    hotspots: comparison,
  };
}

async function handleSpeciesFinder(args) {
  const speciesName = args.species;
  const location = loc(args.location);
  const radius = args.radius_km ?? 50;

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
        bcData = await birdcast.getLiveMigration(regionCode, dateStr);
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
      content: [{ type: "text", text: `Error: ${error.message}` }],
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
