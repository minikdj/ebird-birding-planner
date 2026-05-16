# Birding Planner

MCP server + daily email briefing for Cincinnati-area migration monitoring.

## MCP Server Tools

All 10 tools for interactive birding planning in Claude Desktop:

| Tool | What it does |
|------|-------------|
| `plan_birding_trip` | Ranks nearby hotspots by recent species count + migration activity |
| `migration_forecast` | BirdCast radar data + NWS weather interpretation |
| `hotspot_details` | Recent species and notable sightings at a single hotspot |
| `compare_hotspots` | Side-by-side species comparison with iNaturalist verification |
| `species_finder` | Where a species has been seen recently near a location |
| `best_day_to_bird` | Recommends the best day in a date range using migration + weather |
| `birding_weather` | NWS overnight/morning forecast interpreted for migration prediction |
| `verify_sighting` | Cross-references eBird reports against iNaturalist photo-verified obs |
| `birding_window` | Sunrise, civil twilight, and recommended arrival time |
| `species_frequency` | Historical peak week and current phenology status via BirdCast |
| `plan_vacation_birding` | Discovery report for a travel destination: target species you won't find in Cincinnati, hotspots ranked by active birder community, and birding window. Uses historical bar chart data — works weeks or months ahead. |

## Setup

### 1. API Keys

- **eBird API key** (required): https://ebird.org/api/keygen — free
- **BirdCast API key** (required): contact BirdCast at https://birdcast.info for API access
- **Resend API key** (for email): https://resend.com — free tier, 3,000 emails/month

### 2. Environment

Copy `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
```

### 3. Install dependencies

```bash
npm install
```

### 4. Claude Desktop Integration

Add to your Claude Desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ebird-birding-planner": {
      "command": "node",
      "args": ["/absolute/path/to/ebird-birding-planner/src/index.js"],
      "env": {
        "EBIRD_API_KEY": "your_key_here",
        "BIRDCAST_API_KEY": "your_key_here",
        "EBIRD_LIFE_LIST_CSV": "/path/to/MyEBirdData.csv"
      }
    }
  }
}
```

## Daily Briefing (Anthropic Routine)

The briefing runs as a cloud-hosted Anthropic Routine — no machine needs to be on.

### How it works

1. Agent runs at 4:00 AM ET daily during migration season
2. `scripts/triage.js` fetches BirdCast + NWS data and outputs a JSON recommendation
3. Agent decides: full briefing / quiet-period note / silent skip
4. `scripts/briefing.js` builds HTML email and sends via Resend

### Test locally

```bash
# Run triage check (outputs JSON recommendation)
node scripts/triage.js

# Generate briefing HTML (saves to ./briefing-output/ if no Resend key)
node scripts/briefing.js

# Generate quiet-period email
node scripts/briefing.js --quiet
```

### Set up the Routine

See `routine-prompt.md` for the exact prompt to paste into claude.ai when creating the Routine. Required secrets to configure:

- `EBIRD_API_KEY`
- `BIRDCAST_API_KEY`
- `RESEND_API_KEY`
- `BRIEFING_EMAIL_TO`
- `BRIEFING_REGION` (default: US-OH-061)
- `BRIEFING_LAT` / `BRIEFING_LNG` (default: 39.1 / -84.5)

## Architecture

```
src/
  index.js          — MCP server (10 tools)
  ebird-client.js   — eBird API v2 wrapper
  birdcast-client.js — BirdCast radar data
  nws-client.js     — NWS Weather API
  inaturalist-client.js — iNaturalist photo verification
  utils.js          — Cache, location resolution, date parsing

scripts/
  triage.js         — Fast migration check, outputs JSON
  briefing.js       — HTML email builder + Resend sender
```
