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
4. [MCP Server](#4-mcp-server)
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

- Runs automatically every morning at 4:00 AM ET during migration season
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

1. A Routine is configured to run daily at 4:00 AM ET during migration season
2. The agent wakes up, calls BirdCast + NWS as a fast triage check (~10s)
3. Based on that triage, it decides:
   - **Send full briefing** → calls all data sources, renders email, sends via Resend
   - **Send short "quiet period" note** → sends once, then reschedules to N days out
   - **Silent skip** → exits without sending (used when already in a quiet period)
4. The Routine's schedule is updated dynamically when the agent decides to sleep

### Routine configuration

- **Schedule**: daily at 4:00 AM ET (cron: `0 8 * * *` UTC)
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

**Current prompt**: See `routine-prompt.md` in the repo root for the full prompt
to paste into claude.ai → Routines. Summary of the 7-step flow below.

### Execution flow

```
Step 1: npm install --silent && node scripts/triage.js
        → Reads recommendation from JSON output

Step 2: SILENT_SKIP → log and done
        FULL_BRIEFING or QUIET_PERIOD → continue

Step 3: node scripts/aggregate.js
        → Comprehensive data JSON (~25s)

Step 4: Agent reasons about data holistically
        (rain impact? exceptional season? fallout conditions? best upcoming day?)

Step 5: Agent writes email HTML + subject (full briefing or quiet note)

Step 6: Agent saves briefing-draft.json { subject, htmlBody }

Step 7: node scripts/send.js briefing-draft.json
        → EMAIL SENT or HTML SAVED
        → If QUIET_PERIOD: also call update_scheduled_task +4 days
```

### Triage scoring rubric (computed in `scripts/triage.js`)

| Signal | Score delta | Notes |
|--------|-------------|-------|
| BirdCast `isHigh` flag | +4 | Always triggers FULL_BRIEFING regardless of total score |
| Cumulative birds > 500K | +3 | Exceptional night |
| Cumulative birds > 100K | +2 | Active night |
| Cumulative birds > 50K | +1 | Moderate night |
| Notable species present (eBird, 50km, 48h) | +2 | Any unusual species = always worth sending |
| S or SW overnight wind + precip < 30% | +2 | Favorable migration conditions |
| N or NW wind + precip > 60% | -2 | Suppressed migration |

Thresholds: score ≥ 5 OR isHigh OR notables → `FULL_BRIEFING`; score ≥ 2 → `QUIET_PERIOD`; score < 2 → `SILENT_SKIP`.

### Why the agent writes the email (not a script)

The previous architecture used `briefing.js` — a template that filled fixed slots
regardless of conditions. The current architecture puts the agent in the rendering
role so it can:
- Suppress irrelevant sections (no 5-day outlook if every day shows rain)
- Elevate unusual findings (rare species becomes the lede, not bullet 3)
- Cross-reference data (high overnight rain + clearing at dawn = fallout note)
- Write accurate quiet notes with actual data ("4 nights below 50K" not generic copy)
- Flag rain impact on morning birding explicitly when it matters

### Rescheduling logic

On QUIET_PERIOD: agent calls `update_scheduled_task` to reschedule +4 days.
On the resumed run: triage re-evaluates from current data; if conditions have
improved (score ≥ 5), sends full briefing and reverts to daily cadence.

---

## 4. MCP Server

**Status: [DONE]** — all 11 tools are implemented and working.

### Location

- `src/index.js` — MCP server entry point + all tool handlers (~1215 lines)
- `src/tools.js` — tool schema definitions extracted for readability (~213 lines)

No build step. Runs via `node src/index.js`.

### All tools

| Tool | Handler | Data source | Notes |
|------|---------|-------------|-------|
| `plan_birding_trip` | `handlePlanBirdingTrip` | eBird + BirdCast + NWS + suncalc | Ranks hotspots by score = species×2 + notable×5; includes weather + birding window |
| `migration_forecast` | `handleMigrationForecast` | BirdCast + NWS | Season-gated. Live data + season totals + resolved weather interpretation |
| `hotspot_details` | `handleHotspotDetails` | eBird | 7-day + 14-day species counts; `.catch(() => [])` guards on all eBird calls |
| `compare_hotspots` | `handleCompareHotspots` | eBird + iNaturalist | Shared vs unique species; iNat photo-verification for notable unique species; capped at 10 results |
| `species_finder` | `handleSpeciesFinder` | eBird | Deduplicates by location, sorts by recency |
| `best_day_to_bird` | `handleBestDayToBird` | BirdCast + eBird | Scores days by migration intensity; local-time date arithmetic (toYMD) |
| `birding_weather` | `handleBirdingWeather` | NWS | Overnight + morning forecast, migration interpretation, sunrise via suncalc |
| `verify_sighting` | `handleVerifySighting` | iNaturalist | Photo-verified research-grade observations within radius |
| `birding_window` | `handleBirdingWindow` | suncalc | Civil twilight, sunrise, activity cutoff (clamped ≥ 6:00 AM); temp-adjusted |
| `species_frequency` | `handleSpeciesFrequency` | BirdCast bar chart | Per-week probability, peak week, phenology status |
| `plan_vacation_birding` | `handlePlanVacationBirding` | eBird + BirdCast + iNat + NWS | Trip planner with target species diff, life list integration, community-ranked hotspots |

### Key implementation details

- **Module split**: tool schemas in `src/tools.js`, all handlers + wiring in `src/index.js`
- **In-memory cache** (`Cache` class in `utils.js`): used by NWSClient, INaturalistClient; BirdCast 24h, taxonomy 1 week, hotspots 1 week
- **eBird rate limiter**: 90 req/min enforced in `EBirdClient` via promise-queue gate; gate resolves before HTTP call so concurrent requests are in flight correctly
- **BirdCast API key**: read from `process.env.BIRDCAST_API_KEY` (passed via constructor)
- **InputError class**: validation errors thrown as `InputError` propagate message to MCP caller; unexpected errors return generic message
- **Favorite hotspots**: Mount Airy Forest, Shawnee Lookout, Otto Armleder, Middle Creek Park, Sharon Woods — defined in `utils.js`, `locId` resolved dynamically at runtime
- **Cincinnati-area detection**: `isCincinnatiArea()` uses haversine distance ≤50km from 39.1°N, 84.5°W plus county code set (no `startsWith("US-OH")` false matches)
- **Life list**: loaded once from `EBIRD_LIFE_LIST_CSV` CSV export, cached in `_lifeListCache` module variable; header row parsed dynamically to find "Common Name" column

### Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@modelcontextprotocol/sdk` | `1.29.0` (pinned exact) | MCP server framework |
| `suncalc` | latest | Sunrise/sunset/twilight computation |

---

## 4B. Script Architecture for Routines

**Status: [DONE]**

Because Routines cannot reach the local MCP server, a parallel execution path
uses standalone scripts under `scripts/` that import the same underlying client
code from `src/`. This keeps all API logic in one place and avoids duplication.

### Directory layout

```
ebird-birding-planner/
├── src/
│   ├── index.js              ← MCP server (Claude Desktop)
│   ├── tools.js              ← tool schema definitions (imported by index.js)
│   ├── ebird-client.js       ← shared by MCP server AND scripts
│   ├── birdcast-client.js    ← shared by MCP server AND scripts
│   ├── nws-client.js         ← shared by MCP server AND scripts
│   ├── inaturalist-client.js ← shared by MCP server AND scripts
│   └── utils.js              ← Cache, resolveLocation, toYMD, CITY_LOOKUP, …
└── scripts/
    ├── triage.js             ← fast triage check (~10s): FULL_BRIEFING / QUIET_PERIOD / SILENT_SKIP
    ├── aggregate.js          ← comprehensive data aggregation (~25s): all migration + weather + hotspot data
    ├── send.js               ← email delivery: reads briefing-draft.json, sends via Resend/fallback
    ├── briefing.js           ← legacy template-based briefing (kept as fallback reference)
    └── test.js               ← smoke test suite (6 tests)
```

### Routine execution flow

```
Step 1: node scripts/triage.js
        → JSON: { recommendation, migrationScore, notableSpecies, weather, recommendationReason }
        → SILENT_SKIP → done
        → FULL_BRIEFING or QUIET_PERIOD → continue

Step 2: node scripts/aggregate.js
        → JSON: { migration, weather, birdingWindow, hotspots, notableObservations, flags }
        → agent reads JSON and reasons holistically

Step 3: Agent writes email body + subject, saves to briefing-draft.json

Step 4: node scripts/send.js briefing-draft.json
        → RESULT: EMAIL SENT  (or HTML SAVED as fallback)
```

**Key design principle:** `triage.js` is cheap (one fast decision pass). `aggregate.js` is comprehensive but only runs when we've decided to send. The agent is the email renderer — it reasons about the full data rather than filling a template, so contextual factors (rain suppressing activity, exceptional season totals, fallout conditions) can influence the email content naturally.

### `scripts/triage.js`

Fast triage check (~10 seconds). Fetches BirdCast last-night intensity, eBird
notable observations (last 48h), and NWS overnight weather. Outputs JSON with:

| Field | Description |
|-------|-------------|
| `recommendation` | `"FULL_BRIEFING"` / `"QUIET_PERIOD"` / `"SILENT_SKIP"` |
| `migrationScore` | 0–10 composite score (BirdCast intensity + notable bonus + weather bonus) |
| `notableSpecies` | Array of notable species common names (last 48h, 50km) |
| `notableCount` | Length of notableSpecies |
| `lastNight` | `{ cumulativeBirds, formattedCount, isHigh, peakDirection, peakSpeedMph }` |
| `weather` | `{ overnightWind, precipProbability, migrationInterpretation, weatherUnavailable }` |
| `seasonStatus` | `"above average by 12%"` / `"below average by 8%"` / `null` |
| `recommendationReason` | Human-readable explanation of the decision |

Scoring rubric: `isHigh` → +4, `>500K birds` → +3, `>100K` → +2, `>50K` → +1,
notable species present → +2, S/SW wind + low precip → +2, N/NW + heavy rain → -2.
Thresholds: score ≥ 5 OR `isHigh` OR notables → FULL_BRIEFING; score ≥ 2 → QUIET_PERIOD;
score < 2 → SILENT_SKIP.

### `scripts/aggregate.js`

Comprehensive data aggregation (~25 seconds). Fetches all data sources in parallel.
Outputs JSON with:

| Field | Description |
|-------|-------------|
| `migration.lastNight` | BirdCast live: count, isHigh, peak flight direction/speed/altitude |
| `migration.season` | Season total vs multi-year average, weekly trend (building/declining/steady) |
| `migration.topExpectedSpecies` | Top 20 expected species by historical probability for this week |
| `migration.narrativeSummary` | Plain-English BirdCast summary |
| `weather.today` | NWS overnight + morning forecast; `rainImpactNote` if rain affects birding |
| `weather.outlook` | 5-day forward outlook: wind, precip, migration intensity, rain impact, birding window per day |
| `birdingWindow` | Civil twilight, sunrise, golden hour end, solar noon, activity cutoff (temp-adjusted) |
| `hotspots` | Top 5 by 7-day species count (active community proxy); filtered to > 0 species |
| `notableObservations` | Deduplicated notable/rare species (last 14 days, 50km); sorted by recency |
| `flags` | `{ highMigrationNight, hasNotables, morningRainLikely, favorableOvernightWind }` |

**Rain impact detection:** `rainImpactNote` is non-null when morning precip ≥ 40%.
At ≥ 70%: heavy rain, activity significantly suppressed, advice to check sheltered edges.
At 40–69%: moderate rain possible, plan shorter window.
Special case: high overnight precip + clear morning = potential fallout note.

### `scripts/send.js`

Reads `briefing-draft.json` (format: `{ subject, htmlBody, emailTo?, emailFrom? }`),
delivers via:
1. Resend (primary — `RESEND_API_KEY`)
2. SendGrid (fallback — `SENDGRID_API_KEY`)
3. Save to `./briefing-output/briefing-YYYY-MM-DD.html` (final fallback)

Outputs `RESULT: EMAIL SENT` or `RESULT: HTML SAVED` to stdout.
Exits 0 on success or disk-save fallback; exits 1 only on unrecoverable errors
(missing draft file, missing required fields in draft).

### `scripts/briefing.js` (legacy)

Original template-based briefing kept as a reference and fallback. Not used by the
current Routine flow. Can still be run manually:
- `node scripts/briefing.js` → full HTML email
- `node scripts/briefing.js --quiet` → short quiet-period email

### `scripts/test.js`

6-test smoke suite. Verifies each client module with real API calls.
Run with `node scripts/test.js`. All 6/6 passing.

---

## 5. New Tools — Phase 2

**Status: [DONE]**

All new tools follow the same pattern: schema defined in `src/tools.js` (the
`tools[]` export), handler implemented as `handleXxx` in `src/index.js`, and a
case added to the main switch. New external clients go in their own files under
`src/` and are imported by both `src/index.js` and `scripts/`.

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

Charts are a **future enhancement** — not currently implemented. `chart.js` and
`chartjs-node-canvas` were removed from `package.json` since they were never
imported and require native `canvas` compilation via `node-gyp`. If re-added,
they should be `optionalDependencies`.

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

The Routine runs `node scripts/briefing.js` (or `--quiet`). The script gathers
all data, renders a table-based HTML string with inline CSS, and POSTs to the
Resend API. All dynamic values are passed through `escHtml()` before template
interpolation. The MCP server tools are NOT called by the Routine — it imports
the client modules directly.

---

## 8. API Reference & Rate Limits

| API | Auth | Rate limit | Cache TTL used |
|-----|------|-----------|----------------|
| BirdCast | `BIRDCAST_API_KEY` env var (passed to `BirdCastClient` constructor) | Generous (undocumented) | 24h |
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

The BirdCast key used in production is configured via `BIRDCAST_API_KEY` in the
Claude Desktop config and in Routine secrets. Whether this key is a formal API
key or a shared dashboard key is tracked in Open Question 3. If BirdCast requires
a proper API key, get one at https://birdcast.info.

---

## 9. Configuration & Secrets

### For local MCP server development

For scripts (`scripts/test.js`, `scripts/triage.js`, `scripts/briefing.js`):
File: `ebird-birding-planner/.env` (gitignored)

```
EBIRD_API_KEY=your_key_here
BIRDCAST_API_KEY=your_key_here
```

For Claude Desktop, environment variables are configured in
`~/Library/Application Support/Claude/claude_desktop_config.json` under the
server's `env` block:

```json
"env": {
  "EBIRD_API_KEY": "...",
  "BIRDCAST_API_KEY": "...",
  "EBIRD_LIFE_LIST_CSV": "/path/to/MyEBirdData.csv"
}
```

`EBIRD_LIFE_LIST_CSV` is optional — omit it to disable personal life list
integration in `plan_vacation_birding`.

Get a free eBird API key: https://ebird.org/api/keygen

### For the Anthropic Routine

Secrets stored in the Routine configuration (not in any file). The agent reads
them from environment at runtime:

| Secret name | Purpose |
|-------------|---------|
| `EBIRD_API_KEY` | eBird API access |
| `BIRDCAST_API_KEY` | BirdCast migration API access |
| `RESEND_API_KEY` | Email sending |
| `SENDGRID_API_KEY` | Fallback email sending (optional) |
| `BRIEFING_EMAIL_TO` | Recipient address |
| `BRIEFING_FROM_EMAIL` | Sender address with verified domain |
| `BRIEFING_REGION` | eBird/BirdCast region code (default `US-OH-061`) |
| `BRIEFING_LAT` | Latitude (default `39.1`) |
| `BRIEFING_LNG` | Longitude (default `-84.5`) |
| `BRIEFING_TIMEZONE` | IANA timezone string (default `America/New_York`) — controls all displayed times |
| `BRIEFING_FAVORITE_HOTSPOTS` | Comma-separated eBird location IDs (e.g. `L123456,L234567`). Overrides the default Cincinnati hotspot list. Always included in trip planning. |
| `BRIEFING_SKIP_BIRDCAST` | Set to `true` for non-US locations where BirdCast has no data. Triage uses eBird notables only; sends FULL_BRIEFING if notables found, QUIET_PERIOD otherwise. |
| `NWS_CONTACT_EMAIL` | Contact email in NWS User-Agent header (default `birding-briefing@example.com`) |
| `EBIRD_LIFE_LIST_CSV` | Path to eBird life list CSV export — enables "new for life list" highlights in vacation planning |

### What does NOT need to be configured (hardcoded defaults)

- Home coordinates (39.1, -84.5) and region (US-OH-061) — override with BRIEFING_LAT/LNG/REGION
- Favorite hotspot list — defaults to Cincinnati parks; override with BRIEFING_FAVORITE_HOTSPOTS
- Migration season dates (Mar 15 – Jun 7, Aug 1 – Nov 15) — BirdCast service constraint, not configurable
- Activity cutoff thresholds (75°F heat penalty, 3h base window) — defined in utils.js constants

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

**Status: [IN PROGRESS]** — Routine full-briefing path confirmed in 3 live runs. MCP tools, quiet-period path, fallback delivery, and degraded modes still need documented E2E verification. See `TESTING.md` for the full living test plan.

### Automated smoke tests — [DONE]

`scripts/test.js` — 6 tests, all passing. Run with `node scripts/test.js`.

| Test | What it checks |
|------|---------------|
| NWSClient.getBirdingWeather() | Real NWS API call with Cincinnati coords |
| EBirdClient.getNearbyHotspots() | Real eBird API call |
| BirdCastClient.getExpectedSpecies() | Real BirdCast API call with ignoreSeasonCheck |
| INaturalistClient.getVerifiedSightings() | Real iNaturalist API call |
| loadLifeList() from CSV file | Parses EBIRD_LIFE_LIST_CSV, verifies count > 0 |
| scripts/triage.js execution | Subprocess; verifies JSON output with required keys |

### Routine agent — [DONE — FULL_BRIEFING path]

Three live runs completed 2026-05-16. Confirmed:
- triage.js → aggregate.js → agent email → send.js pipeline works end-to-end
- Email delivered via Resend to Gmail ✓
- Chase Targets section with field ID cards rendered correctly ✓
- Birding window times display in Eastern time (not UTC) ✓
- npm ci does not modify package-lock.json; git hang bug eliminated ✓
- Agent correctly identifies prize birds (Connecticut Warbler, Neotropic Cormorant, Bell's Vireo) ✓

Still needed:
- QUIET_PERIOD path with `update_scheduled_task` rescheduling
- SILENT_SKIP path
- SendGrid fallback and disk fallback delivery

### Email rendering — [PARTIAL]

Confirmed working in Gmail (desktop and received). Still needed:
- Mobile rendering (Gmail app / Apple Mail on iPhone)
- Apple Mail desktop rendering
- Subject line display in preview pane on mobile

---

## 12. Code Review Findings

**Status: [DONE]** — Two full review passes completed (2026-05-15 and 2026-05-16). All CRIT, HIGH, and MEDIUM findings are fixed. All LOW findings are fixed. One MEDIUM (R2-A) was investigated and found to be a non-issue. The section below is the permanent audit record.

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

### LOW — Originally tracked

| ID | File | Status | Finding |
|----|------|--------|---------|
| L1 | `index.js` | **FIXED** | Extracted tool schemas to `src/tools.js` (~213 lines). `index.js` reduced from ~1400 to ~1215 lines. Full handler extraction deferred (requires dependency injection refactor). |
| L2 | `birdcast-client.js` | **FIXED** | `_get` → `#get` (true ES private method) |
| L3 | `index.js` | **FIXED** | `compare_hotspots` capped at 10 items |
| L4 | `index.js` | **FIXED** | `hotspot_details` name input capped at 200 chars |
| L5 | `index.js` | **FIXED** | Named constants for scoring weights and candidate limits |
| L6 | `index.js` | **FIXED** | `getHotspotSpeciesCounts` catch block now logs to stderr |
| L7 | `index.js` | **DONE** (already was) | `best_day_to_bird` stats bonus already applied at line 990 |
| L8 | `utils.js` | **FIXED** | Comment documenting "this weekend" asymmetry |
| L9 | `briefing.js` | **FIXED** | Top hotspots re-ranked by 7-day recent species count, zeros filtered |

### Round 2 review findings (2026-05-16)

From architecture, security, and code quality reviews of the full repo.

#### Fixed in same pass

| ID | Severity | File | Finding |
|----|----------|------|---------|
| R2-1 | HIGH | `index.js` | `handleHotspotDetails`: `getRecentObservations` calls missing `.catch(() => [])` — eBird errors crash the handler |
| R2-2 | HIGH | `index.js` | `handleCompareHotspots`: same missing `.catch()` + `subId` absent makes checklist count always 1 (added `.filter(Boolean)`) |
| R2-3 | HIGH | `index.js` | `handleCompareHotspots`: `input.startsWith("L")` accepts "Lake Erie Metropark" as locId — replaced with `/^L\d+$/.test()` |
| R2-4 | MEDIUM | `index.js` | `handleMigrationForecast`: NWS weather always fetched for Cincinnati coords regardless of `region_code` passed — now resolves region to coordinates |
| R2-5 | MEDIUM | `index.js` | `handleBirdingWindow`: `activityCutoff` unbounded below — clamped to minimum 6:00 AM |
| R2-6 | MEDIUM | `briefing.js` | HTML injection: `bullet2`, `overnightWind`, `morningTemp`, 5-day outlook `d.wind`/`d.windSpeed` interpolated without `escHtml()` |
| R2-7 | MEDIUM | `index.js` | `handleBestDayToBird`: `getBirdCastData` not wrapped in `.catch()` — BirdCast failure kills entire tool response |
| R2-8 | LOW | `index.js` | `loadLifeList` reads from disk on every `plan_vacation_birding` call — now cached in `_lifeListCache` module-level variable |
| R2-9 | LOW | `package.json` | `chart.js` and `chartjs-node-canvas` listed as deps but never imported — removed. MCP SDK pinned to exact version `1.29.0` |

#### Investigated / resolved

| ID | Severity | File | Finding |
|----|----------|------|---------|
| R2-A | MEDIUM | `index.js` | Rate limiter concern investigated: the gate resolves *before* the HTTP call starts, so concurrent HTTP requests can be in flight. Effective throughput is not 1 req/RTT — the limiter is correct. `getHotspotSpeciesCounts` manual batching is redundant but harmless. No fix needed. |
| R2-B | MEDIUM | `index.js` | **FIXED** — Exported `toYMD()` from `utils.js`, replaced `toISOString().slice(0,10)` in `handleBestDayToBird`. Added `toLocalYMD()` helper in `scripts/briefing.js` and `scripts/triage.js`. |
| R2-C | LOW | `index.js` | **FIXED** — `NWSClient` and `INaturalistClient` now import and use `Cache` from `utils.js`. Own `Map`-based caches deleted. |
| R2-D | LOW | Multiple | **FIXED** — Added `InputError` class in `index.js`; outer MCP handler catches `instanceof InputError` and surfaces `.message` directly to caller. |
| R2-E | LOW | `index.js` | **FIXED** — `loadLifeList` now parses header row to find "Common Name" column index dynamically instead of hardcoding position. |
| R2-F | LOW | `scripts/` | **FIXED** — `degreesToCardinal` exported from `birdcast-client.js`. `cardinalFromDeg` in `triage.js` deleted and replaced with import. |

### Email chart gap [PLANNED]

Section 7 describes two inline PNG charts rendered via `chartjs-node-canvas`:
- 7-day migration bar chart (BirdCast `cumulativeBirds` per night)
- Warbler frequency trend line (BirdCast bar chart probability over the migration season)

`scripts/briefing.js` currently generates the email **without charts**. `chart.js` and `chartjs-node-canvas` have been removed from package.json since they are not used. If charts are re-added, they should be installed as `optionalDependencies` (require native `canvas` compilation via `node-gyp`). Tracking as future enhancement.

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

**Status: [DONE]** — implemented in `src/index.js` as the 11th tool.

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

### Personal life list integration [DONE]

The tool reads an eBird CSV data export (`EBIRD_LIFE_LIST_CSV` env var pointing to a local file). When configured, target species output switches modes:

- **With life list**: primary tier = `newToYourLifeList` (findable at destination, not in user's history), secondary tier = `seenBeforeButRareHere`
- **Without life list**: falls back to Cincinnati frequency comparison (`wontFindInCincinnati` / `rareInCincinnati`)

The CSV is the "Download My Data" export from ebird.org → My eBird. Column 1 (Common Name) is extracted; parenthetical subspecies are normalized. Notable recent sightings are annotated with `onYourLifeList: true/false`. The `lifeListLoaded` field in the response reports how many species were parsed.

### What this does NOT do

- No email / no Routine integration — Claude Desktop conversation only
- Does not replace `plan_birding_trip` for local trip planning — that tool handles the Cincinnati-area use case

---

## 14. Still To Do

Items that are known, tracked, and not yet completed. Ordered roughly by priority.

| # | Item | Category | Notes |
|---|------|----------|-------|
| 1 | Run full E2E tests for all 11 MCP tools in Claude Desktop | Testing | See `TESTING.md` Section 3 — each tool has a specific prompt and expected output criteria |
| 2 | Test QUIET_PERIOD Routine path end-to-end | Testing | Verify short email format, actual data references, and `update_scheduled_task` rescheduling. See `TESTING.md` Test B |
| 3 | Test SILENT_SKIP Routine path | Testing | Verify aggregate.js is not run and no email is sent. See `TESTING.md` Test C |
| 4 | Test SendGrid fallback delivery | Testing | Temporarily set invalid RESEND_API_KEY; verify fallback fires. See `TESTING.md` Section 6 |
| 5 | Test disk fallback delivery | Testing | Run `send.js` with no API keys; verify HTML file saved. See `TESTING.md` Section 4 |
| 6 | Email rendering on mobile (Gmail app, Apple Mail) | Testing | See `TESTING.md` Section 7 |
| 7 | Email rendering in Apple Mail desktop | Testing | See `TESTING.md` Section 7 |
| 8 | Test degraded modes: NWS down, BirdCast outside season, iNat timeout | Testing | See `TESTING.md` Section 6 |
| 9 | Verify Resend custom domain (`BRIEFING_FROM_EMAIL`) | Config | Requires domain verification in Resend dashboard; currently using `@resend.dev` test address |
| 10 | Confirm BirdCast API key is approved for programmatic use | Config | Working in practice; formal status with birdcast.info unverified |
| 11 | Hotspot micro-habitat knowledge base | Enhancement | A `hotspot-notes.json` file with trail-level notes per park (best spots for Connecticut Warbler, etc.) would let the agent give more specific field directions. Include in `aggregate.js` output. |
| 12 | Inline email charts | Enhancement | Section 7 describes 7-day migration bar chart and warbler frequency trend; removed from `package.json` as `optionalDependencies`. Add back if charts are re-introduced. |
| 13 | GitHub branch protection on `main` | Security | Require PR review before merge, no force-push, signed commits. Prevents a compromised GitHub account from landing malicious code that runs with live API keys in the next Routine execution. |
| 14 | Scope Resend/SendGrid API keys | Security | Scope Resend key to a single sending domain so a stolen key can't spam arbitrary addresses under your domain reputation. Set spending alerts on eBird/BirdCast if the providers support it. |
| 15 | Test `BRIEFING_SKIP_BIRDCAST=true` end-to-end | Testing | Set to true, run triage.js, verify BirdCast is not called and recommendation is based on eBird notables only |
| 16 | Test `BRIEFING_FAVORITE_HOTSPOTS` env var | Testing | Set comma-separated locIds, run plan_birding_trip, verify configured hotspots appear regardless of activity level |
| 17 | Test vacation-to-new-region flow | Testing | Change BRIEFING_REGION/LAT/LNG/TIMEZONE to a new location, verify triage + aggregate produce correct region data |
| 18 | Triage score threshold tuning for non-Ohio regions | Config/Enhancement | Current thresholds (>500k birds = +3, etc.) are calibrated for Ohio nocturnal migration volumes. Pacific coast, Gulf Coast, or sparse-region users may always get FULL_BRIEFING or always SILENT_SKIP. Document tuning guidance or expose `BRIEFING_SCORE_HIGH_BIRDS`, `BRIEFING_FULL_THRESHOLD` env vars. |

**Reference:** `TESTING.md` — full feature inventory, test prompts, expected outputs, and status tracking for all tests above. — full feature inventory, test prompts, expected outputs, and status tracking for all tests above.

---

## 15. Open Questions

These need answers before or during implementation. Update this section when
resolved.

| # | Question | Status | Answer |
|---|----------|--------|--------|
| 1 | Does an Anthropic Routine have access to MCP tools registered in Claude Desktop, or does it run in a clean context? | **Resolved** | Routines run as full Claude Code cloud sessions. Local MCP servers (added via Claude Desktop or `claude mcp add`) are not accessible — they run on the user's Mac. The Routine clones the GitHub repo and runs Node scripts via bash instead. |
| 2 | Can a Routine execute Node.js subprocesses (e.g. to render charts via chartjs-node-canvas)? | **Resolved** | Yes. Routines have bash tool access and can run Node.js subprocesses. Charts via `chartjs-node-canvas` are feasible. |
| 3 | Is the BirdCast API key a valid key for programmatic use, or is it a scrape of the dashboard? | **Open** | Key now stored in `BIRDCAST_API_KEY` env var (not hardcoded). Confirmed working in practice; formal programmatic-use status unverified. Check https://birdcast.info if usage increases. |
| 4 | What is the Routine's compute/memory limit? A full briefing with 14 API calls may take 30–60 seconds. | **Resolved** | Routines are full Claude Code cloud sessions with no special time limit beyond normal tool use. Standard session limits apply. |
| 5 | Resend free tier: does it support sending from a custom domain, or only `@resend.dev` test addresses? | **Open** | Resend requires a verified domain for custom From addresses; `@resend.dev` works for testing |
| 6 | Should the quiet-period reschedule be implemented as updating the Routine's cron schedule, or as the agent simply not calling the email tools and relying on a state flag stored somewhere? | **Open** | Leaning toward cron update; simpler than external state |

These need answers before or during implementation. Update this section when
resolved.

| # | Question | Status | Answer |
|---|----------|--------|--------|
| 1 | Does an Anthropic Routine have access to MCP tools registered in Claude Desktop, or does it run in a clean context? | **Resolved** | Routines run as full Claude Code cloud sessions. Local MCP servers (added via Claude Desktop or `claude mcp add`) are not accessible — they run on the user's Mac. The Routine clones the GitHub repo and runs Node scripts via bash instead. |
| 2 | Can a Routine execute Node.js subprocesses (e.g. to render charts via chartjs-node-canvas)? | **Resolved** | Yes. Routines have bash tool access and can run Node.js subprocesses. Charts via `chartjs-node-canvas` are feasible. |
| 3 | Is the BirdCast API key a valid key for programmatic use, or is it a scrape of the dashboard? | **Open** | Key now stored in `BIRDCAST_API_KEY` env var (not hardcoded). Confirmed working in practice; formal programmatic-use status unverified. Check https://birdcast.info if usage increases. |
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
| 2026-05-16 | Personal life list CSV integration added to plan_vacation_birding (EBIRD_LIFE_LIST_CSV). Section 13 updated to reflect implementation. |
| 2026-05-16 | Spec cleanup: fixed time references (5:45 AM → 4:00 AM ET), marked Section 4B [DONE], updated Section 12 L9 as fixed, added email chart gap note, updated Section 11 to IN PROGRESS. |
| 2026-05-16 | Full architecture + security + code quality re-review. Fixed R2-1 through R2-9 (HIGH/MEDIUM bugs: missing .catch(), wrong NWS coords, HTML injection, activityCutoff clamp, life list cache, package.json cleanup). Open items R2-A through R2-F tracked in Section 12. |
| 2026-05-16 | Fixed all remaining review items: R2-B (toYMD UTC bug), R2-C (Cache unification), R2-D (InputError class), R2-E (CSV header parsing), R2-F (deduped cardinal function), L1 (tools.js module split). R2-A investigated and found correct — no fix needed. 6/6 smoke tests passing. |
| 2026-05-16 | Architectural refactor of Routine email system: added `scripts/aggregate.js` (comprehensive data aggregation → JSON) and `scripts/send.js` (email delivery from draft JSON). Routine agent now writes the email body dynamically using its reasoning instead of filling a fixed template. Rain impact detection added. Section 3 and Section 4B updated. `routine-prompt.md` rewritten with 7-step agent flow. `briefing.js` retained as legacy fallback. |
| 2026-05-16 | Full architecture + security + code review of new scripts. Fixed: SendGrid fallback unreachable on Resend API errors; disk fallback cwd-relative path; BRIEFING_LAT/LNG NaN propagation; buildOutlook sequential loop → parallel; buildOutlook date derivation from new Date() → today param; duplicate toLocalYMD → import toYMD; inline degreesToCardinal → import; wind constants unified (SSW/SE added); computeActivityCutoff h===0 edge; fallout rain threshold 60%→50%. Prompt: removed hardcoded Cincinnati; fixed schedule to 09:00 UTC (DST-safe); added update_scheduled_task guidance; fixed quiet-period data references; added null-handling guidance. |
| 2026-05-16 | Three live Routine runs completed successfully. Fixed UTC birding-window bug (formatTime now uses BRIEFING_TIMEZONE env var, default America/New_York). Fixed Routine git-hang (npm install → npm ci; added explicit no-git-commands rule). Added Chase Targets section to Routine prompt — prize birds now get dedicated cards with rarity context, where-to-look, field ID, and time-sensitivity. Section 11 updated to reflect live test results. Created TESTING.md as the living E2E test document. |
| 2026-05-16 | Reliability + evolvability pass (Kleppmann principles). Reliability: AbortSignal.timeout(10s/15s) on every fetch() across all 5 clients — prevents silent 4am hang; toYMD() fixed to UTC methods so NWS period filtering works on UTC cloud runners; EBirdClient.makeRequest() wraps response.json() in try/catch (CDN HTML 200 pages no longer crash aggregate.js); buildOutlook() per-day try/catch so one bad day returns null not kills all 5; invalid BRIEFING_LAT/LNG now fatal in triage.js instead of silent SILENT_SKIP; BirdCast rate limiter serialized with promise queue; SendGrid error body consumed to release connection. Evolvability: FAVORABLE_WINDS/POOR_WINDS deduplicated — aggregate.js now imports from utils.js (was missing 'W'); nws-client.js wind comparisons use the same sets; RECOMMENDATION frozen enum exported from utils.js (no more magic strings); 11-case switch replaced with TOOL_HANDLERS Map in index.js (adding a tool is now one line); schema contract comments added to aggregate.js and triage.js output objects; 'Cincinnati' removed from tools.js descriptions. |
| 2026-05-16 | Evolvability review (Opus). Portability score raised from 6→9/10. De-Cincinnati-ified entire codebase: routine-prompt.md no longer references "4:00 AM ET" or "Cincinnati area"; all Cincinnati-specific output labels in plan_vacation_birding renamed to homeFrequency/notFindableAtHome/rareAtHome with dynamic home location name. isCincinnatiArea() gate replaced with getFavoriteHotspots() that reads BRIEFING_FAVORITE_HOTSPOTS env var (comma-separated locIds) and falls back to default Cincinnati parks. BRIEFING_SKIP_BIRDCAST=true added for non-US travel (triage uses eBird notables only). MCP tool handlers now read BRIEFING_LAT/LNG as default before falling back to DEFAULTS. computeActivityCutoff consolidated from 3 inline duplicates to single utils.js import. Section 9 secrets table updated with all current env vars. |
| 2026-05-16 | Three parallel code reviews (architecture, security, code quality + data flow) plus a dedicated public-repo Opus security audit. Zero secrets in git history, zero npm vulnerabilities. Implemented all actionable findings: FAVORABLE_WINDS/haversineKm/computeActivityCutoff/weekIndexForDate exported from utils.js; URLSearchParams for BirdCast API key; NWS URL domain assertion; path traversal guard in send.js; lat/lng validation in all MCP handlers; batched eBird calls (5 at a time); staggered NWS calls (300ms); BRIEFING_REGION now rejects (not warns) on invalid format; draft.emailTo/emailFrom overrides removed from send.js (always use env vars); npm ci --ignore-scripts in Routine prompt (supply-chain hardening); HTML-escape rule added to Routine agent RULES; path validation for EBIRD_LIFE_LIST_CSV; legacy scripts/briefing.js deleted. |
