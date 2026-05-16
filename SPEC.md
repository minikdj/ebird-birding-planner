# Birding Planner — Project Spec

> This is the living reference document for all planned and completed work on the
> eBird birding planner MCP server and daily briefing system. Update it as
> decisions change. Sections marked **[DONE]** are implemented; **[PLANNED]**
> are not yet started; **[IN PROGRESS]** are actively being built.

---

## Table of Contents

1. [Project Goal](#1-project-goal)
2. [Infrastructure Decision](#2-infrastructure-decision)
3. [Routine Agent Design](#3-routine-agent-design)
4. [Existing MCP Server](#4-existing-mcp-server)
5. [New Tools — Phase 2](#5-new-tools--phase-2)
6. [Enrichments to Existing Tools](#6-enrichments-to-existing-tools)
7. [Email Design](#7-email-design)
8. [API Reference & Rate Limits](#8-api-reference--rate-limits)
9. [Configuration & Secrets](#9-configuration--secrets)
10. [Repo & Version Control Setup](#10-repo--version-control-setup)
11. [Testing Plan](#11-testing-plan)
12. [Code Review Findings](#12-code-review-findings)
13. [Vacation Discovery Report](#13-vacation-discovery-report)
14. [Open Questions](#14-open-questions)

---

## 1. Project Goal

Build a smart daily birding briefing system that:

- Runs automatically every morning at 5:45 AM ET during migration season
- Uses Claude as an intelligent agent (not a dumb cron script) to decide whether
  the briefing is worth sending
- Sends a rich HTML email when migration is active or notable species are present
- Goes quiet for several days — and reschedules itself — when nothing is happening
- Pulls from BirdCast radar, eBird observations, NWS weather, iNaturalist
  photo-verification, and computed sunrise/sunset times

The key insight driving the architecture: a rules-based script would require
hard-coding thresholds for "interesting enough." The agent can reason about
context — e.g. a slow week but a rare fallout species, or a weather front about
to arrive — and make a judgment call.

---

## 2. Infrastructure Decision

**Chosen: Anthropic Routines** (cloud-hosted scheduled agent)

### Why Routines over the alternatives

| Option | Verdict | Reason |
|--------|---------|--------|
| System cron + Node.js script | Rejected | MacBook sleeps at night; bare cron silently misses jobs. Would need `launchd` plist with `WakeToRun=true`. Script logic can't reason. |
| macOS `launchd` | Viable fallback | Works on always-on machines. No AI reasoning. Would need separate state file to implement "skip for N days" logic. |
| GitHub Actions | Viable fallback | Cloud-hosted, free. Fixed schedule only — can't self-reschedule. No reasoning. Good if Routines don't work out. |
| Claude Desktop scheduled task | Rejected | Requires Desktop app to be running at 5:45 AM. Unreliable for overnight runs. |
| **Anthropic Routines** | **Chosen** | Cloud-hosted (machine off). Agent reasons at runtime. Can self-reschedule via `update_scheduled_task`. Included in Pro subscription. |

### How Routines work for this project

1. A Routine is configured to run daily at 5:45 AM ET during migration season
2. The agent wakes up, calls BirdCast + NWS as a fast triage check (~10s)
3. Based on that triage, it decides:
   - **Send full briefing** → calls all data sources, renders email, sends via Resend
   - **Send short "quiet period" note** → sends once, then reschedules to N days out
   - **Silent skip** → exits without sending (used when already in a quiet period)
4. The Routine's schedule is updated dynamically when the agent decides to sleep

### Routine configuration

- **Schedule**: daily at 5:45 AM ET (cron: `45 9 * * *` UTC)
- **Season gating**: the agent prompt includes season dates; agent exits cleanly
  outside season (Mar 15 – Jun 7 spring, Aug 1 – Nov 15 fall)
- **Self-reschedule tool**: `mcp__scheduled-tasks__update_scheduled_task`

### Constraint: Routines run on Anthropic's cloud

- Cannot access local files or local MCP server process — the local MCP server
  runs on the user's Mac and is unreachable from the cloud runner
- Cannot access locally-registered MCP servers (those added via Claude Desktop
  or `claude mcp add`) — local servers are not reachable from the cloud
- Cannot read a local `.env` file — API keys must be stored as Routine secrets
- **CAN** run shell commands and Node.js subprocesses via the bash tool
- **CAN** access MCP connectors registered at claude.ai (cloud integrations like
  Slack, Notion, etc.) — but this project's MCP server is local, so it's not
  available via that route either
- Routines clone the project's GitHub repo and can run scripts from it
- No persistent state between Routine runs — each run starts fresh

> **Resolved**: The Routine runs as a full Claude Code cloud session. It cannot
> call the local MCP server tools directly. Instead it clones the GitHub repo
> and uses the bash tool to run Node.js scripts (`scripts/triage.js`,
> `scripts/briefing.js`) that import `EBirdClient`, `BirdCastClient`, and other
> API clients directly. Claude reasons about the script output to decide which
> action to take. The MCP server (`src/index.js`) continues to exist unchanged
> for Claude Desktop interactive use — the Routine uses a parallel path.

---

## 3. Routine Agent Design

### Triage prompt (runs first, fast)

```
You are a migration monitoring agent for Cincinnati, OH (Hamilton County,
US-OH-061, 39.1°N 84.5°W).

Today is {DATE}. Time is 5:45 AM ET.

You are running as a Claude Code cloud session. The project repo has been cloned
to the working directory. Use the bash tool to run Node scripts.

STEP 1 — TRIAGE (do this first, takes ~10 seconds):
  Run: node scripts/triage.js
  This script fetches BirdCast migration data and NWS weather for last night
  and tonight, then prints a JSON summary to stdout.
  Reason about the JSON output to proceed.

STEP 2 — DECIDE:
  Based on the triage output, choose one of three actions:

  A) FULL BRIEFING — send if ANY of these are true:
     - Last night's migration was HIGH intensity (>500K birds over Hamilton County)
     - Any rare/unusual species reported in the last 48h within 50km
     - Tonight's conditions favor heavy migration (south winds >10mph, clear skies)
     - It's been more than 5 days since the last briefing (send a catch-up)

  B) QUIET PERIOD — send a short note if:
     - Migration has been LOW for 3+ consecutive nights
     - Next 4-day forecast shows unfavorable conditions (north winds, persistent rain)
     - You have NOT sent a quiet-period note in the last 5 days
     Then: reschedule this Routine to run again in 4 days.

  C) SILENT SKIP — exit without sending if:
     - You are within a quiet period (last action was QUIET PERIOD < 5 days ago)
     - AND conditions have not changed meaningfully
     Note: You have no persistent memory between runs, so reason from the data:
     if migration has been consistently low for >5 days, assume quiet period.

STEP 3 — EXECUTE:
  For FULL BRIEFING: run node scripts/briefing.js — this script gathers full
    data from all sources, renders the HTML email, and sends it via Resend.
  For QUIET PERIOD: run node scripts/briefing.js --quiet — sends short note,
    then call update_scheduled_task to reschedule to +4 days.
  For SILENT SKIP: log "Skipping — quiet period active" and exit.
```

### Scoring rubric the agent uses

| Signal | Weight | Notes |
|--------|--------|-------|
| BirdCast cumulative birds (last night) | High | >500K = almost always send |
| BirdCast `isHigh` flag | High | Overrides other signals |
| Notable species in 50km (eBird) | High | Any review-species = always send |
| Tonight's wind direction (NWS) | Medium | S/SW winds = favorable; N/NW = poor |
| Consecutive low nights | Medium | 3+ nights of <50K = quiet period |
| Days since last briefing | Medium | >5 days = send catch-up regardless |
| Pressure trend | Low | Falling = front coming, rising = fallout window |

### Rescheduling logic

When the agent decides QUIET PERIOD:
1. Note today's date
2. Estimate when conditions improve (next front, end of unfavorable pattern)
3. Default to +4 days if uncertain
4. Call `update_scheduled_task` to set next run to that date
5. Revert to daily schedule on the resumed run

---

## 4. Existing MCP Server

**Status: [DONE]** — all six tools are implemented and working.

### Location

`ebird-birding-planner/src/index.js` — single-file MCP server, plain JavaScript
(ESM), Node.js. No build step. Runs via `node src/index.js`.

### Existing tools

| Tool | Handler | Data source | Notes |
|------|---------|-------------|-------|
| `plan_birding_trip` | `handlePlanBirdingTrip` | eBird + BirdCast | Ranks hotspots by score = species×2 + notable×5 |
| `migration_forecast` | `handleMigrationForecast` | BirdCast | Season-gated. Returns live data + season totals |
| `hotspot_details` | `handleHotspotDetails` | eBird | 7-day + 14-day species counts |
| `compare_hotspots` | `handleCompareHotspots` | eBird | Shared vs unique species across hotspots |
| `species_finder` | `handleSpeciesFinder` | eBird | Deduplicates by location, sorts by recency |
| `best_day_to_bird` | `handleBestDayToBird` | BirdCast + eBird | Scores days by migration intensity |

### Key implementation details

- **In-memory cache** (`Cache` class in `utils.js`): taxonomy 1 week, BirdCast
  24h, hotspots 1 week
- **eBird rate limiter**: 90 req/min enforced in `EBirdClient` via sliding window
- **BirdCast API key**: hardcoded as `BirdCastClient.API_KEY = 'BIRDCAST_API_KEY_PLACEHOLDER'`
  (this is a public/shared key — verify it's still valid before shipping)
- **Favorite hotspots**: Mount Airy Forest, Shawnee Lookout, Otto Armleder,
  Middle Creek Park, Sharon Woods — defined in `utils.js`, `locId` resolved
  dynamically at runtime
- **Cincinnati-area detection**: `isCincinnatiArea()` uses haversine distance
  ≤50km from 39.1°N, 84.5°W, plus county code matching

### Dependency

`@modelcontextprotocol/sdk ^1.12.1` — only production dependency.

---

## 4B. Script Architecture for Routines

**Status: [PLANNED]**

Because Routines cannot reach the local MCP server, a parallel execution path
uses standalone scripts under `scripts/` that import the same underlying client
code from `src/`. This keeps all API logic in one place and avoids duplication.

```
ebird-birding-planner/
├── src/
│   ├── ebird-client.js       ← shared by MCP server AND scripts
│   ├── birdcast-client.js    ← shared by MCP server AND scripts
│   ├── nws-client.js         ← shared by MCP server AND scripts
│   └── index.js              ← MCP server (Claude Desktop, unchanged)
└── scripts/
    ├── triage.js             ← fast check for Routine STEP 1
    └── briefing.js           ← full data gather + email for Routine STEP 3
```

### `scripts/triage.js`

Fast triage check that the Routine runs first (~10 seconds). Imports
`EBirdClient` and `BirdCastClient` directly. Fetches:
- BirdCast migration intensity for last night
- NWS overnight wind direction/speed and tonight's forecast

Exits with a JSON object printed to stdout so the Routine agent can reason about
it. No email sending. Designed to be cheap and quick.

### `scripts/briefing.js`

Full data gather, email rendering, and send. Accepts a `--quiet` flag to send
the short quiet-period email instead of the full briefing. Imports all clients
from `src/`, gathers all data sources in parallel, renders the HTML email
(including charts via `chartjs-node-canvas`), and sends via Resend.

Both scripts read secrets from environment variables (populated by the Routine's
secret configuration at runtime).

---

## 5. New Tools — Phase 2

**Status: [DONE]**

All new tools go into `src/index.js` alongside existing handlers, following the
same pattern (define in `tools[]` array, implement as `handleXxx` function, add
case to the switch). New external clients go in their own files under `src/`.

---

### 5A. `birding_weather` [DONE]

**Source**: NWS Weather API (`api.weather.gov`) — no API key required.

**New file**: `src/nws-client.js`

#### Input schema
```js
{
  lat: number,   // default 39.1
  lng: number,   // default -84.5
  date: string,  // optional, default "today"
}
```

#### Implementation steps
1. `GET https://api.weather.gov/points/{lat},{lng}` with
   `User-Agent: (birding-planner, minikdj11@gmail.com)` header
2. Follow `properties.forecastHourly` URL from response
3. Filter hourly periods to overnight window (8 PM – 6 AM) and morning window
   (6 AM – 10 AM)
4. Extract: wind direction, wind speed, precipitation probability, short forecast
   description, temperature, dewpoint
5. Barometric pressure: NWS hourly doesn't include pressure directly — either
   skip or use a secondary endpoint. **Decision**: skip pressure for v1, add as
   enhancement if a clean endpoint is found.
6. Compute a plain-English migration interpretation:

```
South winds 12mph, clear overnight → "Favorable migration conditions.
  Expect new arrivals at dawn."
North winds + rain → "Birds grounded. Poor new migration but potential
  fallout from prior nights."
Variable/light winds → "Mixed conditions. Moderate migration possible."
```

#### Output
```js
{
  overnight: {
    windDirection: "S",
    windSpeedMph: 12,
    precipProbability: 10,
    cloudCover: "Clear",       // from shortForecast text
  },
  morning: {
    windDirection: "SW",
    windSpeedMph: 8,
    tempF: 58,
    feelsLikeF: 55,
    precipProbability: 5,
  },
  sunriseTime: "6:18 AM",       // computed via suncalc (see 5D)
  migrationInterpretation: "South winds 12mph overnight with clear skies — favorable migration. Expect new arrivals at dawn.",
  weatherUnavailable: false,    // set true if NWS call fails; other fields may be null
}
```

#### Error handling
If NWS is down or returns non-200: return `{ weatherUnavailable: true }`. The
caller (e.g. `migration_forecast`) should include this gracefully: "weather data
unavailable for tonight's interpretation."

#### Rate limits
NWS: no hard limit but throttles at >1 req/sec. Add 200ms delay between the
`/points` call and the forecast URL follow-up. Cache forecast data for 1 hour.

---

### 5B. `species_frequency` [DONE]

**Source**: eBird API v2 — requires `EBIRD_API_KEY` (already available).

**New file**: none needed — add to `EBirdClient` in `src/ebird-client.js`.

#### Goal
Answer: "Is this species on time, early, or late compared to historical norms?
What's its peak week?"

#### Implementation notes
The eBird bar chart frequency endpoint is:
```
GET /v2/product/spplist/{regionCode}
```
This returns a species list but not frequency. The actual frequency/bar-chart
data is not available via the v2 API in a clean JSON endpoint — it's embedded in
the web UI. **Approach for v1**: use BirdCast's bar chart endpoint (already
implemented as `getExpectedSpecies`) which returns per-week probability per
species. This is close enough for the "peak week" and "on time vs late"
calculation.

**Revised tool**: `species_frequency` takes a species name, resolves it to a
BirdCast species code via `getExpectedSpecies`, and returns:
- Current week's probability
- Peak week (index 0–47) and peak probability
- Whether the species is pre-peak, at-peak, or post-peak
- Percentage of peak probability currently (e.g. "at 68% of historical peak")

**Fallback**: if BirdCast has no bar chart data for the species, return a note
that frequency data is unavailable and only recent eBird sightings are provided.

#### Input schema
```js
{
  species: string,         // common name, e.g. "Tennessee Warbler"
  region_code: string,     // default "US-OH-061"
  date: string,            // optional, default today
}
```

#### Output
```js
{
  species: "Tennessee Warbler",
  speciesCode: "tenwar",
  currentWeekProbability: 0.28,
  peakWeekIndex: 19,           // week of year (0-based), ~mid May
  peakProbability: 0.34,
  percentOfPeak: 82,
  phenologyStatus: "at-peak",  // "pre-peak" | "at-peak" | "post-peak"
  interpretation: "Tennessee Warbler is at 82% of its historical peak frequency for Hamilton County. Peak is week 19 (mid-May). You're in week 20 — expect slight decline over next 1–2 weeks.",
}
```

---

### 5C. `verify_sighting` [DONE]

**Source**: iNaturalist API (`api.inaturalist.org/v1`) — no API key required
for read-only.

**New file**: `src/inaturalist-client.js`

#### Goal
Cross-reference an eBird sighting (often audio-only for warblers) against
iNaturalist photo-verified observations. Answers: "Is there actually photo
evidence this species is present?"

#### Endpoint
```
GET https://api.inaturalist.org/v1/observations
  ?taxon_name={species}
  &lat={lat}
  &lng={lng}
  &radius={radius_km}
  &d1={start_date}
  &d2={end_date}
  &quality_grade=research
  &photos=true
  &per_page=10
```

#### Input schema
```js
{
  species: string,      // common or scientific name
  lat: number,          // default 39.1
  lng: number,          // default -84.5
  radius_km: number,    // default 30
  days_back: number,    // default 14
}
```

#### Output
```js
{
  species: "Connecticut Warbler",
  photoVerifiedCount: 3,
  mostRecentDate: "2026-05-12",
  nearestObservationKm: 8.4,
  hotspotOverlap: true,    // true if any iNat obs is within 5km of a known eBird hotspot
  confidence: "high",      // "high" (>=3 research-grade), "moderate" (1-2), "low" (0)
  interpretation: "3 photo-verified Connecticut Warbler reports within 30km in the last 14 days — high confidence this species is present.",
}
```

#### Rate limits
iNaturalist: 60 requests/minute. Cache results for 6 hours (species sightings
don't change that fast).

---

### 5D. `birding_window` [DONE]

**Source**: `suncalc` npm package (pure computation, no API call).

**New dependency**: `npm install suncalc`

#### Goal
Return sunrise, civil twilight, and a recommended arrival time for a given
location and date. Integrate into `plan_birding_trip` output.

#### Input schema
```js
{
  lat: number,    // default 39.1
  lng: number,    // default -84.5
  date: string,   // default "today"
  temp_f: number, // optional — from birding_weather; affects activity cutoff
}
```

#### Computation
Using `suncalc.getTimes(date, lat, lng)`:
- `dawn` → civil twilight start (birds start singing)
- `sunrise` → sunrise
- `goldenHour` → end of golden hour
- `solarNoon` → peak heat begins

Activity cutoff: base is 10:30 AM; subtract 15 min for every 5°F above 75°F
(heat suppresses songbird activity).

#### Output
```js
{
  civilTwilight: "5:58 AM",
  sunrise: "6:18 AM",
  goldenHourEnd: "6:47 AM",
  activityCutoff: "10:30 AM",   // adjusted for temperature if provided
  recommendation: "Arrive by 5:58 AM (civil twilight). Peak songbird activity 6:18–9:30 AM. Heat activity suppression begins ~10:30 AM at forecasted 82°F.",
}
```

---

## 6. Enrichments to Existing Tools

**Status: [DONE]**

These are modifications to existing handlers in `src/index.js`.

### `migration_forecast` — add weather interpretation

After fetching BirdCast data, call `birding_weather` internally. Append to the
result:
```js
result.weatherInterpretation = weather.migrationInterpretation;
result.overnightWinds = { direction: weather.overnight.windDirection, speedMph: weather.overnight.windSpeedMph };
result.weatherUnavailable = weather.weatherUnavailable;
```

Combined output should answer both: "did birds fly last night?" AND "will they
fly tonight?"

### `plan_birding_trip` — add sunrise + weather

Call `birding_window` and `birding_weather` in parallel with the existing
hotspot/BirdCast fetches. Add to output:
```js
result.birdingWindow = { ... };   // from birding_window
result.weather = { ... };         // morning summary from birding_weather
```

Update `buildTripSummary` to include "Arrive by {civilTwilight} — sunrise at
{sunrise}."

### `best_day_to_bird` — factor weather into scoring

Currently scores days by `migrationScore` (BirdCast intensity). Add a
`weatherBonus` to each day's score:
- South/SW winds the night before: +2
- Clear overnight: +1
- Rain or north winds: -2
- No data: 0

Fetch `birding_weather` for each day in the range (or the prior evening).
**Rate limit note**: this is up to 14 NWS calls for a 14-day range — space 200ms
apart. Only do this if `date_range` spans ≤7 days to avoid excessive NWS calls.

### `compare_hotspots` — add iNaturalist verification for notable species

After building the comparison, identify species that appear in only one hotspot
(i.e., notable/unique). For each unique species in the comparison, call
`verify_sighting`. Add to each hotspot's result:
```js
uniqueSpeciesVerified: [
  { species: "Connecticut Warbler", confidence: "high", photoCount: 3 },
]
```

Cap at 3 verify calls per compare request (iNaturalist rate limit + latency).

---

## 7. Email Design

**Status: [DONE]**

### Sending infrastructure

Email sent via **Resend** (resend.com). Simple REST API, generous free tier
(3,000 emails/month), excellent deliverability. Read API key from Routine secret
`RESEND_API_KEY`.

Fallback chain (tried in order if Resend unavailable):
1. SendGrid (`SENDGRID_API_KEY`)
2. Nodemailer + Gmail (`GMAIL_USER`, `GMAIL_APP_PASSWORD`)
3. Save HTML to `./briefing-output/briefing-YYYY-MM-DD.html` and log

### Email types

#### Full briefing email

**Subject**: `[Birding] Migration active — {intensity} night, {top notable species}`

**Structure** (table-based HTML, inline CSS only, mobile-friendly):

```
┌─────────────────────────────────┐
│  3-bullet executive summary      │  Plain text, fits email preview pane
│  • Last night: X birds (HIGH)   │
│  • Tonight: south winds, clear  │
│  • Hot spot: Otto Armleder      │
│    → Connecticut Warbler (photo) │
├─────────────────────────────────┤
│  Migration Traffic card          │  BirdCast data
│  Weather card                    │  NWS overnight + morning
│  Top 3 Hotspots — ranked by     │  With species counts + notable
│  RECENT species count (7-day),   │  + iNat verification badges
│  not all-time; filter out spots  │
│  with 0 recent species           │
│  5-Day Outlook                   │  Migration intensity forecast +
│                                  │  overnight wind for next 5 days;
│                                  │  highlight best day
│  Rare/Notable Alerts             │  + iNat verification badges
├─────────────────────────────────┤
│  7-day migration bar chart       │  PNG, base64 inline
│  Warbler frequency trend line    │  PNG, base64 inline
└─────────────────────────────────┘
```

Charts rendered server-side using `chartjs-node-canvas`.
**New dependency**: `npm install chartjs-node-canvas chart.js`
**Confirmed feasible**: Routines run full Claude Code cloud sessions with bash
tool access; Node.js subprocesses work, so `chartjs-node-canvas` is supported.

#### Quiet period email

**Subject**: `[Birding] Migration quiet — checking back {date}`

**Structure**: 3-4 sentences only. No charts. Example:
```
Migration has been light for the past 4 nights (average 28,000 birds/night).
North winds and rain in the forecast through Thursday make heavy movement
unlikely before the weekend. I'll check back Saturday morning — if a front
moves through Friday night, conditions could be excellent Sunday.

Last notable: Cerulean Warbler at Shawnee Lookout on May 11.
```

### Rendering

The agent constructs the HTML string directly in its response. For the full
briefing, it uses the MCP tools to gather data and then assembles the email.

For charts: `scripts/briefing.js` renders Chart.js to PNG via
`chartjs-node-canvas` and embeds the result as base64 inline in the email.
This is confirmed feasible — Routines can run Node.js subprocesses via bash.

---

## 8. API Reference & Rate Limits

| API | Auth | Rate limit | Cache TTL used |
|-----|------|-----------|----------------|
| BirdCast | Hardcoded key `BIRDCAST_API_KEY_PLACEHOLDER` | Generous (undocumented) | 24h |
| eBird v2 | `EBIRD_API_KEY` env var | 90 req/min | Taxonomy: 1wk; hotspots: 1wk |
| NWS Weather | None (User-Agent header required) | ~1 req/sec soft limit | 1h |
| iNaturalist | None | 60 req/min | 6h |
| `suncalc` | N/A (npm package) | N/A | N/A |
| Resend | `RESEND_API_KEY` | 10 req/sec | N/A |

### NWS User-Agent

All NWS requests must include:
```
User-Agent: (birding-planner, minikdj11@gmail.com)
```
Without this header NWS returns 403.

### BirdCast API key note

The key `BIRDCAST_API_KEY_PLACEHOLDER` appears to be a shared/public dashboard key. Confirm
it's valid and acceptable for programmatic use. If BirdCast requires a proper
API key, get one at https://birdcast.info.

---

## 9. Configuration & Secrets

### For local MCP server development

File: `ebird-birding-planner/.env` (gitignored)

```
EBIRD_API_KEY=your_key_here
```

Get a free eBird API key: https://ebird.org/api/keygen

### For the Anthropic Routine

Secrets stored in the Routine configuration (not in any file). The agent reads
them from environment at runtime:

| Secret name | Purpose |
|-------------|---------|
| `EBIRD_API_KEY` | eBird API access |
| `RESEND_API_KEY` | Email sending |
| `BRIEFING_EMAIL_TO` | Recipient address |
| `BRIEFING_REGION` | eBird/BirdCast region code (default `US-OH-061`) |
| `BRIEFING_LAT` | Latitude (default `39.1`) |
| `BRIEFING_LNG` | Longitude (default `-84.5`) |
| `BRIEFING_HOTSPOTS` | Comma-separated favorite locIds |

### What does NOT need to be configured (hardcoded defaults)

- Cincinnati coordinates (39.1, -84.5)
- Hamilton County region code (US-OH-061)
- Favorite hotspot names (resolved dynamically from eBird)
- Migration season dates (Mar 15 – Jun 7, Aug 1 – Nov 15)

---

## 10. Repo & Version Control Setup

**Status: [DONE]**

### What to version control

The `ebird-birding-planner/` directory is the project root for version control.
The parent `/Users/djm/claude/` directory contains unrelated projects (Notion
reading list) and should NOT be in the same repo.

### Steps

1. `cd ebird-birding-planner && git init`
2. Create `.gitignore`:
   ```
   node_modules/
   .env
   stderr.log
   briefing-output/
   ```
3. Initial commit with existing source
4. Create GitHub repo (public or private — user's choice)
5. Push: `git remote add origin <url> && git push -u origin main`

### Branch strategy

Simple: `main` is always deployable. Feature branches for each Phase 2 tool.
PRs for review before merging.

---

## 11. Testing Plan

**Status: [PLANNED]**

### MCP server tools (existing)

Testable via Claude Desktop: open a conversation and ask the server questions.
No automated test suite yet.

### New tools (Phase 2)

For each new tool, write a minimal smoke test:
```bash
node -e "
  import('./src/nws-client.js').then(({ NWSClient }) => {
    const c = new NWSClient();
    c.getBirdingWeather(39.1, -84.5, '2026-05-15').then(console.log);
  });
"
```

Test offline/failure path: verify that `{ weatherUnavailable: true }` is
returned when NWS is unreachable (mock with a bad URL in test env).

### Routine agent

1. Trigger the Routine manually via Claude Desktop
2. Verify correct email arrives in inbox
3. Verify quiet-period logic: manually call with low-migration data and confirm
   the agent sends the quiet email and reschedules

### Email rendering

Send test emails to both Gmail and Apple Mail. Check:
- Images load (base64 inline PNGs)
- Layout doesn't break on mobile
- Subject line fits preview pane
- Unsubscribe text present in footer

---

## 12. Code Review Findings

**Status: fixes in progress** — reviewed 2026-05-15. All CRIT and HIGH findings fixed in commit after the review. Medium findings fixed in same pass. Low findings tracked below.

### CRIT — Fix immediately

| ID | File | Finding | Fix |
|----|------|---------|-----|
| CRIT-1 | `birdcast-client.js:13` | BirdCast API key hardcoded as `static API_KEY` — committed in plain text, appears in every URL, leaks in logs | Move to `process.env.BIRDCAST_API_KEY`; pass via constructor same pattern as `EBirdClient` |
| CRIT-2 | `ebird-client.js:54–99` | `locId`, `regionCode`, `speciesCode`, `y/m/d` interpolated directly into URL path segments with no format validation — path traversal injection against eBird API | Validate: `locId` → `/^L\d+$/`; `regionCode` → existing `REGION_CODE_RE`; `y/m/d` → integer range checks |
| CRIT-3 | `ebird-client.js:11–27` | Rate limiter has TOCTOU gap under concurrent `Promise.all` — all 10 callers can read the limit check before any pushes a timestamp, sending a burst | Chain requests through a shared promise queue so only one caller executes the gate at a time |

### MEDIUM — Fix in same pass

| ID | File | Finding | Fix |
|----|------|---------|-----|
| M1 | `index.js:813`, `ebird-client.js:47` | Raw `error.message` including endpoint path returned to MCP caller — leaks internal URL structure | Log full error to stderr; return generic message to caller |
| M2 | `birdcast-client.js:60–68` | BirdCast error logs include full URL with API key | Strip key param before logging: `url.replace(/([?&]key=)[^&]+/, '$1***')` |
| M3 | `index.js:291,621` | `radius_km` accepted as string — silent NaN if LLM passes `"30"` instead of `30` | Add `coerceNumber(v, fallback)` helper; use throughout |
| M4 | `index.js:291` | `radius_km` unbounded — caller can trigger 500km scan + fan-out API calls | Clamp to `Math.min(Math.max(1, radius), 100)` |
| M5 | `utils.js:348` | `isCincinnatiArea` matches all of Ohio via `startsWith("US-OH")` — triggers Cincinnati favorites for Columbus, Cleveland, Dayton | Remove the `startsWith("US-OH")` branch; county set + haversine already handle it |
| M6 | `index.js:104–120` | `getBirdCastData` has no inflight coalescing — two concurrent tool calls for same region/date both miss cache and fire duplicate requests | Store in-flight promises; return to concurrent waiters |
| M7 | `index.js:477` | Hotspot ID detection uses `!locId.startsWith("L")` — matches "Lagoon Park" as a location ID | Use `/^L\d+$/.test(locId)` |
| M8 | `index.js:699` | `best_day_to_bird` calls `birdcast.getLiveMigration` directly, bypassing the 24h cache | Route through `getBirdCastData` |
| M9 | `index.js:714–718` | `getRegionStats` fetched per past day but `statsNote` never used in ranking — wasted API quota | Include `stats.numSpecies` in day score, or remove the call |

### LOW — Track, don't block Phase 2

| ID | File | Finding |
|----|------|---------|
| L1 | `index.js` | File will exceed 1200 lines after Phase 2 — split into schemas / handlers / helpers / server |
| L2 | `ebird-client.js` | `_get` in BirdCastClient should be `#get` (true private, consistent with EBirdClient's `#enforceRateLimit`) |
| L3 | `index.js` | `compare_hotspots` accepts unbounded hotspot arrays — cap at 10 |
| L4 | `index.js:477` | `hotspot_details` name input has no length limit — cap at 200 chars |
| L5 | `index.js` | Magic numbers in scoring (`×2`, `×5`, `slice(0,15)`) should be named constants |
| L6 | `index.js:138` | `getHotspotSpeciesCounts` catch block swallows errors silently — log to stderr |
| L7 | `index.js:741` | `best_day_to_bird` ranking ignores fetched eBird stats — fetches but doesn't score |
| L8 | `utils.js:185` | "This weekend" returns one day in `resolveDate` but two in `resolveDateRange` — inconsistent |
| L9 | `scripts/briefing.js` | Top hotspots taken from first 3 by all-time species count — includes restricted/inactive spots with 0 recent species | Fetch top 20, sort by 7-day recent species count, take top 3 with count > 0 |

---

## 13. Vacation Discovery Report

**Status: [DONE]**

### Goal

A new MCP tool for Claude Desktop conversations. When the user is traveling, they ask naturally: "I'm going to Cape May, NJ May 20–25 — what should I look for?" The tool returns a discovery-oriented report: target species, active hotspots, and a birding window for the destination.

This is **not** part of the Routine email system — it's purely an interactive Claude Desktop tool, called on demand before or during a trip.

### Historical data strategy

BirdCast bar chart data (`getExpectedSpecies`) is historical (multi-year eBird records indexed by week of year). It gives accurate species frequencies for any week of the year regardless of current conditions — perfect for trips planned weeks or months ahead. The tool explicitly sets `ignoreSeasonCheck: true` when calling BirdCast so it works outside of migration season too.

The tool clearly distinguishes historical frequency data from recent live sightings (last 14 days of eBird notable observations), and surfaces both in the response.

### New tool: `plan_vacation_birding`

**Status: [DONE]**

Add to `src/index.js` alongside the existing 10 tools.

#### Input schema
```js
{
  destination: string,   // free text: city, "lat,lng", or region code
  dates: string,         // optional: "May 20-25", "next week", "June 1-7"
  home_region: string,   // optional: defaults to "US-OH-061" (Cincinnati)
}
```

#### Implementation steps

**Step 1 — Resolve destination**
Use `resolveLocation()` from `utils.js`. If free text doesn't match the lookup table, try resolving via eBird's `/ref/region/list` or fall back to a hotspot search to infer region code from nearby hotspots.

**Step 2 — Fetch destination data in parallel**
- eBird nearby hotspots: `getNearbyHotspots(lat, lng, 50)` — up to 50km radius
- eBird recent notable observations: `getNearbyNotableObservations(lat, lng, 14, 50)`
- BirdCast expected species for destination region + date
- BirdCast expected species for home region (US-OH-061) + same date — for comparison
- `birding_window` for destination lat/lng + first date of trip

**Step 3 — Rank hotspots by community activity**
For the top 15 candidate hotspots by all-time species count, fetch 7-day recent observations. Rank by **recent checklist count** (proxy for active birder community), not all-time species count. Filter out spots with 0 recent checklists. Return top 5.

Why checklist count: a hotspot with 40 checklists this week is where birders are actually going. All-time count favors well-documented historic spots that may no longer be active.

**Step 4 — Compute target species ("new to you" list)**

The goal: surface species that are meaningfully findable at the destination AND meaningfully absent from Cincinnati. Two filters prevent noise:

- **Findability filter**: destination frequency > 15% for the travel dates (realistic chance of seeing it)
- **Novelty filter**: home region (Cincinnati) frequency < 10% for the same calendar period
- **Ubiquity exclusion**: remove species on a hardcoded noise list: House Sparrow, European Starling, Rock Pigeon, American Robin, Mourning Dove, Northern Cardinal, American Crow — these pass both filters in most US locations but aren't interesting as targets

Edge case — **"Everything is new"**: If >40 species pass both filters (e.g., traveling to coastal Florida or Texas), tighten the novelty filter to Cincinnati < 5% AND destination > 25%. The goal is 10–20 meaningful targets, not an exhaustive list.

Edge case — **"Nothing is new"** (nearby destination): If <5 species pass the filters (e.g., trip to Columbus, OH), relax destination threshold to >10% and add a note: "This location has similar species to Cincinnati. Notable local spots and recent sightings below."

**Group the output into two tiers:**
1. `★ Won't find in Cincinnati` — Cincinnati frequency < 2%
2. `▲ Rare in Cincinnati, common here` — Cincinnati frequency 2–10%

Sort each tier by destination frequency descending.

**Step 5 — Build response**

```js
{
  destination: "Cape May, NJ",
  dates: "May 20–25",
  birdingWindow: { sunrise: "5:52 AM", recommendation: "Arrive by 5:30 AM..." },
  topHotspots: [
    { name: "Cape May Point State Park", locId: "L...", recentChecklists: 87, recentSpecies: 112 },
    ...
  ],
  targetSpecies: {
    wontFindInCincinnati: [
      { name: "Saltmarsh Sparrow", destinationFrequency: 0.38, cincinnatiFrequency: 0.00 },
      ...
    ],
    rareInCincinnati: [
      { name: "Dunlin", destinationFrequency: 0.52, cincinnatiFrequency: 0.06 },
      ...
    ],
  },
  notableRecentSightings: [...],   // from eBird notable obs
  summary: "Cape May in late May is one of the best spots on the East Coast for shorebirds and warblers. ★ 8 species you won't find in Cincinnati, ▲ 14 more that are rare there but common here. Top spot: Cape May Point State Park — 87 checklists this week.",
}
```

### Data source notes

- BirdCast bar chart data (`getExpectedSpecies`) provides per-week species probability for any US region — this is the frequency source for both destination and Cincinnati comparison
- iNaturalist `verify_sighting` can optionally be called for the top 3 target species to add photo-verification confidence
- NWS weather is US-only; for international destinations, weather data will be unavailable (return gracefully)
- BirdCast covers US only; for international trips, fall back to eBird recent observations only and omit the frequency comparison

### What this does NOT do

- No email / no Routine integration — Claude Desktop conversation only
- Does not know the user's personal life list — "new to you" means "uncommon in Cincinnati," not literally new to the individual
- Does not replace `plan_birding_trip` for local trip planning — that tool handles the Cincinnati-area use case

### Future consideration

If the user wants to add personal life list tracking (so "new to you" means literally never seen before), that would require a separate data source (e.g., eBird personal checklist export). Tracked as a future enhancement, not in scope now.

---

## 14. Open Questions

These need answers before or during implementation. Update this section when
resolved.

| # | Question | Status | Answer |
|---|----------|--------|--------|
| 1 | Does an Anthropic Routine have access to MCP tools registered in Claude Desktop, or does it run in a clean context? | **Resolved** | Routines run as full Claude Code cloud sessions. Local MCP servers (added via Claude Desktop or `claude mcp add`) are not accessible — they run on the user's Mac. The Routine clones the GitHub repo and runs Node scripts via bash instead. |
| 2 | Can a Routine execute Node.js subprocesses (e.g. to render charts via chartjs-node-canvas)? | **Resolved** | Yes. Routines have bash tool access and can run Node.js subprocesses. Charts via `chartjs-node-canvas` are feasible. |
| 3 | Is the BirdCast API key `BIRDCAST_API_KEY_PLACEHOLDER` a valid key for programmatic use, or is it a scrape of the dashboard? | **Open** | — |
| 4 | What is the Routine's compute/memory limit? A full briefing with 14 API calls may take 30–60 seconds. | **Resolved** | Routines are full Claude Code cloud sessions with no special time limit beyond normal tool use. Standard session limits apply. |
| 5 | Resend free tier: does it support sending from a custom domain, or only `@resend.dev` test addresses? | **Open** | Resend requires a verified domain for custom From addresses; `@resend.dev` works for testing |
| 6 | Should the quiet-period reschedule be implemented as updating the Routine's cron schedule, or as the agent simply not calling the email tools and relying on a state flag stored somewhere? | **Open** | Leaning toward cron update; simpler than external state |
| 7 | Does the Routine need to stay within migration season bounds automatically, or will we configure separate Routines for spring and fall? | **Resolved** | One Routine runs year-round. The agent prompt includes season dates and the agent exits cleanly outside migration season (checks the date inline and skips itself). No separate Routines needed. |

---

## Change Log

| Date | Change |
|------|--------|
| 2026-05-15 | Initial spec created. Infrastructure decision: Anthropic Routines. All Phase 2 tools and enrichments documented. |
| 2026-05-15 | Updated architecture: Routines run Node scripts via bash, not MCP tools directly. Resolved open questions 1, 2, 4, 7. Added Section 4B (Script Architecture for Routines). Confirmed chartjs-node-canvas feasible. |
| 2026-05-15 | Added Section 12: code review findings (security + architecture). CRIT and MEDIUM fixes applied. |
| 2026-05-16 | User feedback: fix hotspot ranking (filter zero-activity spots), add 5-day forward outlook section to briefing email. |
| 2026-05-16 | Implemented Section 13: plan_vacation_birding MCP tool. Added historical data strategy (BirdCast bar chart with ignoreSeasonCheck), checklist-count hotspot ranking, two-tier target species algorithm, and 20+ known destination entries in CITY_LOOKUP. |
| 2026-05-16 | Updated SPEC status markers — all Phase 2 tools, enrichments, email, and repo setup marked [DONE]. |
| 2026-05-16 | Added Section 13: Vacation Discovery Report spec — new MCP tool plan_vacation_birding for Claude Desktop, with target species algorithm and hotspot ranking by community activity. |
