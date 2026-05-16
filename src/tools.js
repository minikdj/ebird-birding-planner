// Tool schema definitions for the ebird-birding-planner MCP server.

export const tools = [
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
            'Region code (e.g. "US-OH-061"), lat/lng (e.g. "39.1,-84.5"), or city name (e.g. "Cincinnati"). Defaults to your home location.',
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
          description: "Region code, lat/lng, or city name. Defaults to your home location.",
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
          description: "Region code, lat/lng, or city name. Defaults to your home location.",
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
      "Discovery report for birding at a travel destination. Surfaces target species you won't easily find at your home location, ranks hotspots by active birder community, and provides a birding window for the trip. Uses BirdCast historical bar chart frequencies so it works for trips weeks or months in advance — not just this week's live data.",
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
          description: 'Home region code for novelty comparison (default "US-OH-061").',
        },
      },
      required: ["destination"],
    },
  },
];
