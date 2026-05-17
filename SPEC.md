# Birding Planner — Project Spec

> This is the living reference document for the eBird birding planner MCP server
> and daily briefing system. Update it as decisions change.

---

## Current State (as of 2026-05-17)

The system is fully implemented and confirmed working end-to-end in three live
Routine runs. The MCP server exposes 11 tools for Claude Desktop interactive use.
The Routine agent runs daily at 09:00 UTC, clones the GitHub repo, runs
`triage.js` → `aggregate.js`, writes a dynamic email, and delivers via Resend.
The FULL_BRIEFING path is confirmed. QUIET_PERIOD rescheduling and all fallback
delivery paths still need documented E2E verification (see Section 14).

**New as of 2026-05-17:** Life list lifer flagging (★ LIFER OPPORTUNITY badges),
moon phase + migration notes, frontal passage / fallout detection from NWS hourly
data, and Ohio-birds LISTSERV scraper (active — `scripts/wa.exe` URL confirmed,
surfaces community thread subjects as daily email "Community Buzz" section).
163 unit tests passing.

---

## Table of Contents

1. [Project Goal](#1-project-goal)
2. [Infrastructure Decision](#2-infrastructure-decision)
3. [Routine Agent Design](#3-routine-agent-design)
3B. [On-Demand Report — Mobile Trigger](#3b-on-demand-report--mobile-trigger)
4. [MCP Server](#4-mcp-server)
5. [New Tools — Phase 2](#5-new-tools--phase-2)
6. [Enrichments to Existing Tools](#6-enrichments-to-existing-tools)
6B. [Bird Photo Integration](#6b-bird-photo-integration)
7. [Email Design](#7-email-design)
8. [API Reference & Rate Limits](#8-api-reference--rate-limits)
9. [Configuration & Secrets](#9-configuration--secrets)
10. [Repo & Version Control Setup](#10-repo--version-control-setup)
11. [Testing Plan](#11-testing-plan)
12. [Code Review Findings](#12-code-review-findings)
13. [Vacation Discovery Report](#13-vacation-discovery-report)
14. [Still To Do](#14-still-to-do)
15. [Open Questions](#15-open-questions)

---

## 1. Project Goal

Build a smart daily birding briefing system that:

- Runs automatically every morning at 4:00 AM ET during migration season
- Uses Claude as an intelligent agent (not a dumb cron script) to decide whether
  the briefing is worth sending
- Sends a rich HTML email when migration is active or notable species are present
- Goes quiet for several days — and reschedules itself — when nothing is happening
- Pulls from BirdCast radar, eBird observations, NWS weather, iNaturalist
  photo-verification, computed sunrise/sunset/moon phase data, and NWS hourly
  forecasts for frontal passage detection
- Flags species as lifers against the user's personal eBird life list

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

1. A Routine is configured to run daily at 09:00 UTC (4:00 AM ET) during
   migration season
2. The agent wakes up, calls BirdCast + NWS as a fast triage check (~10s)
3. Based on that triage, it decides:
   - **Send full briefing** → calls all data sources, renders email, sends via Resend
   - **Send short "quiet period" note** → sends once, then reschedules to N days out
   - **Silent skip** → exits without sending (used when already in a quiet period)
4. The Routine's schedule is updated dynamically when the agent decides to sleep

### Routine configuration

- **Schedule**: daily at 09:00 UTC (cron: `0 9 * * *`) — 4:00 AM ET winter /
  5:00 AM ET summer; adjust `BRIEFING_TIMEZONE` for other regions
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
> `scripts/aggregate.js`) that import `EBirdClient`, `BirdCastClient`, and other
> API clients directly. Claude reasons about the script output to write and send
> the email. The MCP server (`src/index.js`) continues to exist unchanged for
> Claude Desktop interactive use — the Routine uses a parallel path.

---

## 3. Routine Agent Design

**Current prompt**: See `routine-prompt.md` in the repo root for the full prompt
to paste into claude.ai → Routines. Summary of the 7-step flow below.

### Execution flow

```
Step 1: npm ci --silent --ignore-scripts && node scripts/triage.js
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

The agent is the email renderer so it can:
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

## 3B. On-Demand Report — Mobile Trigger

### Goal

Generate a birding report for **any location, any time**, triggered from the Claude
mobile app with a natural-language request. Example:

> "Generate a birding report for Cape May, NJ this weekend — I want to know what
> warblers are moving through."

The user never opens a terminal. A single message in Claude.ai → report appears in
their email within ~60 seconds.

### Architecture: GitHub Actions + Claude.ai Project + GitHub MCP

```
Mobile (Claude.ai)
  │  User types natural language
  ▼
Claude.ai Project (On-Demand Birding)
  │  System prompt: resolve location, call GitHub API
  │  GitHub MCP cloud connector → POST /repos/.../actions/workflows/report-on-demand.yml/dispatches
  ▼
GitHub Actions: .github/workflows/report-on-demand.yml
  │  workflow_dispatch with inputs: location, region, lat, lng, focus
  ├─ npm ci --ignore-scripts
  ├─ node scripts/triage.js       (with BRIEFING_REGION / LAT / LNG overrides)
  ├─ node scripts/aggregate.js    (same overrides)
  ├─ node scripts/generate-email.js  (calls Anthropic API → writes briefing-draft.json)
  └─ node scripts/send.js briefing-draft.json   → EMAIL SENT
```

No always-on server required. GitHub Actions is free for public repos; the
Anthropic API call costs ~$0.02 per report at Haiku pricing.

### Workflow file: `.github/workflows/report-on-demand.yml`

```yaml
name: On-Demand Birding Report
on:
  workflow_dispatch:
    inputs:
      location:
        description: 'Location name (e.g. Cape May, NJ)'
        required: true
        type: string
      region:
        description: 'eBird region code (e.g. US-NJ-009)'
        required: true
        type: string
      lat:
        description: 'Latitude (decimal, e.g. 38.93)'
        required: true
        type: string
      lng:
        description: 'Longitude (decimal, e.g. -74.96)'
        required: true
        type: string
      focus:
        description: 'Optional focus or context (e.g. shorebirds, warblers, any rarity)'
        required: false
        type: string
        default: ''

jobs:
  generate-report:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci --ignore-scripts
      - name: Run triage
        env:
          EBIRD_API_KEY: ${{ secrets.EBIRD_API_KEY }}
          BIRDCAST_API_KEY: ${{ secrets.BIRDCAST_API_KEY }}
          BRIEFING_REGION: ${{ inputs.region }}
          BRIEFING_LAT: ${{ inputs.lat }}
          BRIEFING_LNG: ${{ inputs.lng }}
          BRIEFING_LOCATION_NAME: ${{ inputs.location }}
          BRIEFING_TIMEZONE: America/New_York
          NWS_CONTACT_EMAIL: ${{ secrets.NWS_CONTACT_EMAIL }}
        run: node scripts/triage.js
      - name: Run aggregate
        env:
          EBIRD_API_KEY: ${{ secrets.EBIRD_API_KEY }}
          BIRDCAST_API_KEY: ${{ secrets.BIRDCAST_API_KEY }}
          BRIEFING_REGION: ${{ inputs.region }}
          BRIEFING_LAT: ${{ inputs.lat }}
          BRIEFING_LNG: ${{ inputs.lng }}
          BRIEFING_LOCATION_NAME: ${{ inputs.location }}
          BRIEFING_TIMEZONE: America/New_York
          NWS_CONTACT_EMAIL: ${{ secrets.NWS_CONTACT_EMAIL }}
        run: node scripts/aggregate.js
      - name: Generate email with Claude
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          BRIEFING_LOCATION_NAME: ${{ inputs.location }}
          BRIEFING_FOCUS: ${{ inputs.focus }}
          BRIEFING_TIMEZONE: America/New_York
        run: node scripts/generate-email.js
      - name: Send email
        env:
          RESEND_API_KEY: ${{ secrets.RESEND_API_KEY }}
          SENDGRID_API_KEY: ${{ secrets.SENDGRID_API_KEY }}
          BRIEFING_EMAIL_TO: ${{ secrets.BRIEFING_EMAIL_TO }}
          BRIEFING_FROM_EMAIL: ${{ secrets.BRIEFING_FROM_EMAIL }}
        run: node scripts/send.js briefing-draft.json
```

### New script: `scripts/generate-email.js`

This script replaces the Routine agent's Step 5 email-writing task for the
on-demand path. It:

1. Reads `triage-output.json` and `aggregate-output.json` from disk (written by
   the preceding steps)
2. Reads `routine-prompt.md` (reused — same design system, same email rules)
3. Calls the Anthropic Messages API with `claude-haiku-4-5` (fast + cheap):
   - System prompt: the agent instructions from `routine-prompt.md` Steps 4–5
   - User message: triage JSON + aggregate JSON + optional focus note from
     `BRIEFING_FOCUS` env var
4. Parses `{ subject, htmlBody }` from Claude's response
5. Writes `briefing-draft.json` for `send.js` to consume

**Model choice**: Haiku is sufficient for the email-rendering step (structured
output with a clear spec). The reasoning step that the daily Routine uses
(`claude-sonnet-4-5`) is not needed here — the data is already fully structured
by `aggregate.js`.

**Triage gate**: `generate-email.js` reads `triage-output.json`. If
`recommendation === "SILENT_SKIP"`, it writes a minimal `briefing-draft.json`
with a short "nothing notable today" note and the workflow completes without
sending a full report. This preserves the same gate logic as the daily Routine.

### `triage.js` and `aggregate.js` — output files

Both scripts need a small change: in addition to printing JSON to stdout (for
the Routine path), they should write their output to disk when running in the
GitHub Actions context (`GITHUB_ACTIONS=true` env var, set automatically):

```js
// At the end of triage.js and aggregate.js:
if (process.env.GITHUB_ACTIONS) {
  const outFile = process.argv[1].includes('triage') ? 'triage-output.json' : 'aggregate-output.json';
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
}
```

Alternatively, the workflow steps can redirect stdout:
```yaml
run: node scripts/triage.js > triage-output.json
```

Either approach works; the redirect approach requires no code change.

### Claude.ai Project setup

1. Go to **claude.ai → Projects → New Project**
2. Name it: **On-Demand Birding Report**
3. Under **Integrations**, add the **GitHub** connector (cloud MCP — no local setup)
4. Authorize the connector to access the `minikdj/ebird-birding-planner` repo
5. Add this system prompt to the Project:

```
You are a birding report dispatcher. When the user asks for a birding report
for any location, your job is to:

1. Identify the location name, eBird region code, and coordinates.
   - Use your knowledge of eBird region codes (e.g. US-NJ-009 for Cape May County, NJ).
   - If unsure of the region code, use the state-level code (e.g. US-NJ).
   - Coordinates: look up approximate lat/lng for the city/area.

2. Ask for any specific focus if not mentioned (shorebirds, warblers, raptors, etc.)
   — but default to "any notable species" if not specified.

3. Trigger the GitHub Actions workflow using the GitHub tool:
   - Repo: minikdj/ebird-birding-planner
   - Workflow file: report-on-demand.yml
   - Inputs: { location, region, lat, lng, focus }

4. Tell the user: "Report triggered for [location] — you'll receive an email
   within 60 seconds."

Do not try to look up bird data yourself. Your only job is to dispatch the
workflow with the correct inputs and confirm it was triggered.
```

### User workflow from Claude mobile

1. Open Claude.ai → tap the **On-Demand Birding Report** Project
2. Type naturally:
   > "Birding report for Magee Marsh, OH — spring warbler fallout conditions?"
3. Claude resolves location → triggers the GitHub workflow via GitHub MCP
4. Email arrives within ~60 seconds

### GitHub secrets required

Add these in the GitHub repo → Settings → Secrets → Actions:

| Secret | Source |
|--------|--------|
| `EBIRD_API_KEY` | Same key as in Routine |
| `BIRDCAST_API_KEY` | Same key as in Routine |
| `ANTHROPIC_API_KEY` | Anthropic console — create a separate key for this |
| `RESEND_API_KEY` | Same key as in Routine |
| `SENDGRID_API_KEY` | Optional fallback |
| `BRIEFING_EMAIL_TO` | Your email address |
| `BRIEFING_FROM_EMAIL` | Same verified sender as in Routine |
| `NWS_CONTACT_EMAIL` | Your real email (NWS User-Agent) |

### Implementation checklist

- [ ] Create `.github/workflows/report-on-demand.yml`
- [ ] Write `scripts/generate-email.js` (Anthropic SDK, reads triage/aggregate output)
- [ ] Add `ANTHROPIC_API_KEY` to GitHub repo secrets
- [ ] Copy remaining secrets from Routine to GitHub repo secrets
- [ ] Create Claude.ai Project "On-Demand Birding Report" with GitHub MCP
- [ ] Add system prompt to Project
- [ ] Test from desktop: trigger workflow manually in GitHub Actions UI
- [ ] Test from mobile: type a request in the Claude.ai Project

### What this does NOT change

- The daily Routine continues to run on its own schedule unchanged
- The MCP server for Claude Desktop is unchanged
- No new npm dependencies required (only `@anthropic-ai/sdk`, already available in
  the GitHub Actions environment via `npm ci`)

> **Note:** `@anthropic-ai/sdk` must be added to `package.json` `dependencies` for
> `generate-email.js` to import it. It is not currently listed. Add it:
> `npm install @anthropic-ai/sdk` — this is the only code change needed to
> existing files.

---

## 4. MCP Server

All 11 tools are implemented and working.

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
- **Tool dispatch**: `TOOL_HANDLERS` Map in `src/index.js` (replaced switch statement) — adding a new tool is one `Map.set()` entry
- **In-memory cache** (`Cache` class in `utils.js`): shared by NWSClient and INaturalistClient; BirdCast 24h, taxonomy 1 week, hotspots 1 week
- **eBird rate limiter**: 90 req/min enforced in `EBirdClient` via promise-queue gate; gate resolves before HTTP call so concurrent requests are in flight correctly
- **Fetch timeouts**: `AbortSignal.timeout(10000)` (10s) on all fetch calls across all 5 API clients; prevents silent hangs in overnight Routine runs
- **BirdCast API key**: read from `process.env.BIRDCAST_API_KEY` (passed via constructor)
- **InputError class**: validation errors thrown as `InputError` propagate message to MCP caller; unexpected errors return generic message
- **RECOMMENDATION enum**: `RECOMMENDATION` constant (frozen object) exported from `utils.js` — used by triage.js and aggregate.js for `FULL_BRIEFING` / `QUIET_PERIOD` / `SILENT_SKIP` string literals; no magic strings
- **Favorite hotspots**: Mount Airy Forest, Shawnee Lookout, Otto Armleder, Middle Creek Park, Sharon Woods — defined as `FAVORITE_HOTSPOTS` in `utils.js`; `getFavoriteHotspots()` returns them, or overrides with `BRIEFING_FAVORITE_HOTSPOTS` env var if set; `locId` resolved dynamically at runtime
- **Life list**: loaded once from `EBIRD_LIFE_LIST_CSV` CSV export, cached in `_lifeListCache` module variable; header row parsed dynamically to find "Common Name" column

### Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@modelcontextprotocol/sdk` | `1.29.0` (pinned exact) | MCP server framework |
| `resend` | `^6.12.3` | Email delivery (used by `scripts/send.js`) |
| `suncalc` | `^1.9.0` | Sunrise/sunset/twilight computation |

---

## 4B. Script Architecture for Routines

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
│   ├── nws-client.js         ← shared by MCP server AND scripts; includes detectFrontalPassage()
│   ├── inaturalist-client.js ← shared by MCP server AND scripts
│   ├── ohio-birds-client.js  ← Ohio-birds LISTSERV scraper (active, index-based subject scraping)
│   └── utils.js              ← Cache, resolveLocation, toYMD, DEFAULTS, RECOMMENDATION, getFavoriteHotspots, …
├── data/
│   └── life-list.json        ← pre-processed eBird life list (163 species); regenerate with build-life-list.js
└── scripts/
    ├── triage.js             ← fast triage check (~10s): FULL_BRIEFING / QUIET_PERIOD / SILENT_SKIP
    ├── aggregate.js          ← comprehensive data aggregation (~25s): migration + weather + hotspots + moon + lifers
    ├── build-life-list.js    ← reads ~/Downloads/ebird_world_life_list.csv → data/life-list.json
    ├── send.js               ← email delivery: reads briefing-draft.json, sends via Resend/fallback
    ├── test.js               ← integration smoke test suite (6 tests, requires API keys)
    └── test-unit.js          ← unit test suite (163 tests, no API keys needed)
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
| `weather.outlook` | 5-day forward outlook: wind, precip, migration intensity, rain impact note, birding window per day |
| `birdingWindow` | Civil twilight, sunrise, golden hour end, activity cutoff (temp-adjusted) |
| `hotspots` | Top 5 by 7-day species count (active community proxy); filtered to > 0 species |
| `notableObservations` | Deduplicated notable/rare species (last 14 days, 50km); sorted by recency |
| `flags` | `{ highMigrationNight, hasNotables, morningRainLikely, favorableOvernightWind }` |

**Rain impact detection:** `rainImpactNote` is non-null when morning precip ≥ 40%.
At ≥ 70%: heavy rain, activity significantly suppressed, advice to check sheltered edges.
At 40–69%: moderate rain possible, plan shorter window.
Special case: high overnight precip + clear morning = potential fallout note.

**New fields added (2026-05-17):**

| Field | Description |
|-------|-------------|
| `moon` | `{ phaseName, illuminationPct, phase, migrationNote }` — moon phase for the date; `migrationNote` non-null when illumination is >85% (full) or <15% (new) |
| `lifeList` | `{ totalSpecies, source }` or null — summary of the loaded life list (from `data/life-list.json`) |
| `notableObservations[].isLifer` | boolean — true if the species is NOT in the user's life list |
| `notableObservations[].source` | `"ebird"` or `"ohio-birds-listserv"` |
| `listservSightings` | Array of recent Ohio-birds LISTSERV thread subjects: `{ subject, url, source }`. Index-based (no login required). |
| `flags.frontalPassage` | true if cold front passage detected (wind shift + clearing overnight) |
| `flags.falloutPotential` | true if fallout conditions detected (rain overnight → clearing at dawn) |
| `flags.liferOpportunities` | count of notableObservations with isLifer === true |
| `weather.today.frontalPassage` | same as flags.frontalPassage |
| `weather.today.falloutPotential` | same as flags.falloutPotential |
| `weather.today.windShiftDetected` | true if southerly→northerly wind shift detected overnight |
| `weather.today.clearingDetected` | true if precip drops from >40% to <20% overnight |
| `weather.today.frontalNote` | plain-English description of frontal/fallout conditions |

### `scripts/send.js`

Reads `briefing-draft.json` (format: `{ subject, htmlBody }`),
delivers via:
1. Resend (primary — `RESEND_API_KEY`)
2. SendGrid (fallback — `SENDGRID_API_KEY`)
3. Save to `./briefing-output/briefing-YYYY-MM-DD.html` (final fallback)

Outputs `RESULT: EMAIL SENT` or `RESULT: HTML SAVED` to stdout.
Exits 0 on success or disk-save fallback; exits 1 only on unrecoverable errors
(missing draft file, missing required fields in draft).

Recipient and sender addresses come from `BRIEFING_EMAIL_TO` and
`BRIEFING_FROM_EMAIL` Routine secrets — not from fields in the draft JSON.

### `scripts/test.js`

6-test smoke suite. Verifies each client module with real API calls.
Run with `node scripts/test.js`. All 6/6 passing.

---

## 5. New Tools — Phase 2

All new tools are implemented and working.

All new tools follow the same pattern: schema defined in `src/tools.js` (the
`tools[]` export), handler implemented as `handleXxx` in `src/index.js`, and an
entry added to the `TOOL_HANDLERS` Map. New external clients go in their own
files under `src/` and are imported by both `src/index.js` and `scripts/`.

---

### 5A. `birding_weather`

**Source**: NWS Weather API (`api.weather.gov`) — no API key required.

**New file**: `src/nws-client.js`

#### Input schema
```js
{
  lat: number,   // default from BRIEFING_LAT or 39.1
  lng: number,   // default from BRIEFING_LNG or -84.5
  date: string,  // optional, default "today"
}
```

#### Implementation steps
1. `GET https://api.weather.gov/points/{lat},{lng}` with
   `User-Agent: (birding-planner, {NWS_CONTACT_EMAIL})` header
2. Follow `properties.forecastHourly` URL from response
3. Filter hourly periods to overnight window (8 PM – 6 AM) and morning window
   (6 AM – 10 AM)
4. Extract: wind direction, wind speed, precipitation probability, short forecast
   description, temperature, dewpoint
5. Barometric pressure: NWS hourly doesn't include pressure directly —
   skipped for v1.
6. Compute a plain-English migration interpretation based on wind direction/speed
   and precipitation probability

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
  sunriseTime: "6:18 AM",       // computed via suncalc
  migrationInterpretation: "South winds 12mph overnight with clear skies — favorable migration. Expect new arrivals at dawn.",
  weatherUnavailable: false,    // set true if NWS call fails; other fields may be null
}
```

#### Error handling
If NWS is down or returns non-200: return `{ weatherUnavailable: true }`. The
caller (e.g. `migration_forecast`) includes this gracefully: "weather data
unavailable for tonight's interpretation."

#### Rate limits
NWS: no hard limit but throttles at >1 req/sec. Add 200ms delay between the
`/points` call and the forecast URL follow-up. Cache forecast data for 1 hour.

---

### 5B. `species_frequency`

**Source**: BirdCast bar chart endpoint (already implemented as `getExpectedSpecies`).

**New file**: none needed — uses `BirdCastClient` in `src/birdcast-client.js`.

#### Goal
Answer: "Is this species on time, early, or late compared to historical norms?
What's its peak week?"

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
  interpretation: "Tennessee Warbler is at 82% of its historical peak frequency. Peak is week 19 (mid-May). You're in week 20 — expect slight decline over next 1–2 weeks.",
}
```

---

### 5C. `verify_sighting`

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
  lat: number,          // default from BRIEFING_LAT or 39.1
  lng: number,          // default from BRIEFING_LNG or -84.5
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
iNaturalist: 60 requests/minute. Cache results for 6 hours.

---

### 5D. `birding_window`

**Source**: `suncalc` npm package (pure computation, no API call).

#### Goal
Return sunrise, civil twilight, and a recommended arrival time for a given
location and date. Integrated into `plan_birding_trip` output.

#### Input schema
```js
{
  lat: number,    // default from BRIEFING_LAT or 39.1
  lng: number,    // default from BRIEFING_LNG or -84.5
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

Activity cutoff: base is sunrise + 3 hours; subtract 15 min for every 5°F above 75°F
(heat suppresses songbird activity); clamped to a minimum of 6:00 AM.

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

These are modifications to existing handlers in `src/index.js`.

### `migration_forecast` — add weather interpretation

After fetching BirdCast data, call `birding_weather` internally. Append to the
result:
```js
result.weatherInterpretation = weather.migrationInterpretation;
result.overnightWinds = { direction: weather.overnight.windDirection, speedMph: weather.overnight.windSpeedMph };
result.weatherUnavailable = weather.weatherUnavailable;
```

Combined output answers both: "did birds fly last night?" AND "will they
fly tonight?"

### `plan_birding_trip` — add sunrise + weather

Call `birding_window` and `birding_weather` in parallel with the existing
hotspot/BirdCast fetches. Add to output:
```js
result.birdingWindow = { ... };   // from birding_window
result.weather = { ... };         // morning summary from birding_weather
```

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

## 6B. Bird Photo Integration

### Overview

Bird photos appear in Chase Target cards (hero image) and the Notable Sightings table (thumbnail column). Photos are sourced automatically by `aggregate.js` — no configuration required.

### Sources (in priority order)

| Source | Coverage | Quality | License |
|--------|----------|---------|---------|
| **Macaulay Library** (Cornell/eBird) | Most species with eBird data | Top-rated community photos, curated scores | "Any Lab Use=eBird" — non-commercial use as part of eBird ecosystem tools |
| **Wikipedia REST API** | Near-universal (any species with a Wikipedia article) | Wikimedia Commons thumbnails — good quality, CC-licensed | Creative Commons (varies by image) |

### Implementation

**New file: `src/media-client.js`**

- `MediaClient.getTopPhoto(speciesCode, commonName)` — primary lookup method. Tries Macaulay first (using eBird species code), falls back to Wikipedia by common name.
- `MediaClient.getPhotosForSpecies(speciesArray)` — batch lookup, 3 concurrent max, 250ms between batches. Returns `Record<commonName, photo | null>`.
- In-memory cache (7-day TTL) — photos fetched once per session, not per email.
- 6-second timeout per request — media fetches are non-critical path.

**Response schema** (`photo` field on each `notableObservations[]` entry):

```js
{
  url: string,           // 640px wide — fits 600px max-width email container
  thumbnailUrl: string,  // 320px — for Notable Sightings table rows
  photographer: string | null,  // null for Wikipedia (not surfaced in summary API)
  attribution: string,          // Full attribution line for display below photo
  source: 'macaulay' | 'wikipedia',
  rating: number | null,        // Macaulay rating 0–5 (null for Wikipedia)
}
```

**`aggregate.js` integration:**
- Photo lookup runs after notable observations are assembled
- Capped at first 10 species (bound latency — typically <3s for 10 batch lookups)
- `photo` field is `null` if both sources fail — email renders without an `<img>` tag

### Macaulay Library API details

No API key required. Public endpoint:
```
GET https://search.macaulaylibrary.org/api/v1/search?taxonCode={speciesCode}&count=1&sort=rating_rank_desc&mediaType=p
```
CDN image URL: `https://cdn.download.ams.birds.cornell.edu/api/v1/asset/{assetId}/{size}`

Valid sizes: `320` `480` `640` `900` `1200` `1800` `2400` — all confirmed working (HTTP 200).
For emails: use `640` (url) and `320` (thumbnailUrl).

### Wikipedia REST API details

No API key required. Public endpoint:
```
GET https://en.wikipedia.org/api/rest_v1/page/summary/{Species_Name}
```
Returns `thumbnail.source` (resizeable via pixel-width substitution in URL) and `originalimage.source`.

### Email rendering rules (defined in `routine-prompt.md` Design System)

- **Chase Target hero**: `<img>` at top of card, `width:100%; max-width:560px; height:200px; object-fit:cover` — covers the full card width, cropped to 200px height
- **Notable Sightings thumbnail**: 48×48 first column in the table, `object-fit:cover; border-radius:4px`
- **Attribution**: `font-size:10px; color:#999` — displayed below each photo
- **Null handling**: if `photo` is null, omit `<img>` entirely — never render a broken image or placeholder

---

## 7. Email Design

### Sending infrastructure

Email sent via **Resend** (resend.com). Simple REST API, generous free tier
(3,000 emails/month), excellent deliverability. Read API key from Routine secret
`RESEND_API_KEY`.

Fallback chain (tried in order if Resend unavailable):
1. SendGrid (`SENDGRID_API_KEY`)
2. Save HTML to `./briefing-output/briefing-YYYY-MM-DD.html` and log

### Email types

#### Full briefing email

**Subject**: `[Birding] {intensity} migration · {top notable species} · {date}`

**Structure** (table-based HTML, inline CSS only, mobile-friendly, max-width 600px):

```
┌─────────────────────────────────┐
│  3-bullet executive summary      │  Plain text, fits email preview pane
│  • Last night: X birds (HIGH)   │
│  • Tonight: south winds, clear  │
│  • Hot spot: Otto Armleder      │
│    → Connecticut Warbler (photo) │
├─────────────────────────────────┤
│  ★ Chase Targets                 │  Only when genuine prize birds present
│  (dedicated cards per bird)      │  Rarity context + where to look + field ID
├─────────────────────────────────┤
│  Migration Traffic card          │  BirdCast data
│  Weather card                    │  NWS overnight + morning
│  Top 3–5 Hotspots               │  Ranked by 7-day species count;
│                                  │  zeros filtered out
│  Notable / Rare Sightings        │  Supporting cast (prize birds above)
│  5-Day Outlook                   │  Migration intensity + overnight wind;
│                                  │  highlights best upcoming day
│  Birding Window                  │  Civil twilight, sunrise, cutoff
└─────────────────────────────────┘
```

Charts (7-day migration bar chart, warbler frequency trend line) are a
**future enhancement** — not currently implemented. `chart.js` and
`chartjs-node-canvas` have been removed from `package.json`. If re-added,
they should be `optionalDependencies` (require native `canvas` compilation
via `node-gyp`).

#### Quiet period email

**Subject**: `[Birding] Migration quiet · best day: {day} · {date}`

**Structure**: 4–6 conversational sentences. No cards, no tables. Uses actual
data:
- Current trend: weekly movement average, comparison to historical average
- Root cause: NW wind pattern, early/late season, unusual weather
- Best upcoming day in the 5-day outlook
- If notables present: mention species and location (one sentence)
- Check-back date

### Rendering

The Routine agent writes the email body dynamically in Step 5, using its
reasoning to determine emphasis and section content. All dynamic values sourced
from the aggregate JSON must be HTML-escaped before interpolation. The MCP
server tools are NOT called by the Routine — it imports the client modules
directly via the standalone scripts.

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
| Ohio-birds LISTSERV | None (public index) | Confirmed 2026-05-17 | `https://listserv.miamioh.edu/scripts/wa.exe` — index free, bodies require login |
| Macaulay Library (Cornell) | None | ~1 req/sec soft limit | `https://search.macaulaylibrary.org/api/v1/search` — top-rated bird photos by species code. CDN: `cdn.download.ams.birds.cornell.edu`. 3 concurrent max. |
| Wikipedia REST API | None | Generous | `https://en.wikipedia.org/api/rest_v1/page/summary/{title}` — species thumbnails from Wikimedia Commons. |

### Local data files

| File | Description | Generated by |
|------|-------------|--------------|
| `data/life-list.json` | Pre-processed eBird life list with `totalSpecies`, `generatedAt`, and `species[]` array | `node scripts/build-life-list.js` |

**`data/life-list.json` format:**
```json
{
  "generatedAt": "2026-05-17",
  "totalSpecies": 163,
  "species": ["American Robin", "Canada Goose", ...]
}
```

To regenerate: download your eBird World Life List CSV from ebird.org → My eBird → Download My Data, then run `node scripts/build-life-list.js`. The script reads from `/Users/djm/Downloads/ebird_world_life_list.csv` by default.

### NWS User-Agent

All NWS requests must include:
```
User-Agent: (birding-planner, {NWS_CONTACT_EMAIL})
```
Without this header NWS returns 403. `NWS_CONTACT_EMAIL` defaults to
`birding-briefing@example.com` if not set; set it to a real address.

### BirdCast API key note

The BirdCast key used in production is configured via `BIRDCAST_API_KEY` in the
Claude Desktop config and in Routine secrets. Whether this key is a formal API
key or a shared dashboard key is tracked in Open Question 3. If BirdCast requires
a proper API key, get one at https://birdcast.info.

---

## 9. Configuration & Secrets

### For local MCP server development

Environment variables for Claude Desktop are configured in
`~/Library/Application Support/Claude/claude_desktop_config.json` under the
server's `env` block:

```json
"env": {
  "EBIRD_API_KEY": "...",
  "BIRDCAST_API_KEY": "...",
  "EBIRD_LIFE_LIST_CSV": "/path/to/MyEBirdData.csv"
}
```

For running scripts locally (`scripts/test.js`, `scripts/triage.js`, etc.),
create `ebird-birding-planner/.env` (gitignored) with:

```
EBIRD_API_KEY=your_key_here
BIRDCAST_API_KEY=your_key_here
```

Note: `dotenv` is not a project dependency. Scripts read `.env` via the OS
environment or you can use `export $(grep -v '^#' .env | xargs)` before running.

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
| `BRIEFING_REGION` | eBird/BirdCast region code (default `US-OH-061`). Format: `US-OH` (state) or `US-OH-061` (county) |
| `BRIEFING_LAT` | Latitude of home birding location (default `39.1`) |
| `BRIEFING_LNG` | Longitude of home birding location (default `-84.5`) |
| `BRIEFING_TIMEZONE` | IANA timezone string (default `America/New_York`) — controls all displayed times |
| `BRIEFING_LOCATION_NAME` | Display name for your home location used in email subjects and body copy (e.g. `Cincinnati, OH`). If omitted, the agent derives a name from the region/hotspot data. |
| `BRIEFING_FAVORITE_HOTSPOTS` | Comma-separated eBird location IDs (e.g. `L123456,L234567`). Overrides the default hotspot list. Always included in trip planning. |
| `BRIEFING_SKIP_BIRDCAST` | Set to `true` for non-US locations where BirdCast has no data. Triage uses eBird notables only; sends FULL_BRIEFING if notables found, QUIET_PERIOD otherwise. |
| `NWS_CONTACT_EMAIL` | Contact email in NWS User-Agent header (default `birding-briefing@example.com`). Set to a real address. |
| `EBIRD_LIFE_LIST_CSV` | Path to eBird life list CSV export — enables "new for life list" highlights in vacation planning |
| `BRIEFING_SCORE_HIGH_BIRDS` | Birds-aloft threshold for +3 score bonus (default `500000`). Lower for Pacific coast or sparse-migration regions. |
| `BRIEFING_SCORE_MED_BIRDS` | Birds-aloft threshold for +2 score bonus (default `100000`). |
| `BRIEFING_SCORE_LOW_BIRDS` | Birds-aloft threshold for +1 score bonus (default `50000`). |
| `BRIEFING_FULL_THRESHOLD` | Minimum migrationScore for FULL_BRIEFING (default `5`). Raise for Gulf Coast spring where high scores are routine. |
| `BRIEFING_QUIET_THRESHOLD` | Minimum migrationScore for QUIET_PERIOD; below this is SILENT_SKIP (default `2`). |

### What does NOT need to be configured (hardcoded defaults)

- Home coordinates (39.1, -84.5) and region (US-OH-061) — override with BRIEFING_LAT/LNG/REGION
- Favorite hotspot list — defaults to Cincinnati parks; override with BRIEFING_FAVORITE_HOTSPOTS
- Migration season dates (Mar 15 – Jun 7, Aug 1 – Nov 15) — BirdCast service constraint, not configurable
- Activity cutoff thresholds (75°F heat penalty, 3h base window) — defined in `utils.js` constants

---

## 10. Repo & Version Control Setup

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
   briefing-draft.json
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

`scripts/test-unit.js` — **163 unit tests, all passing.** No API keys required. Run with `node scripts/test-unit.js`. Covers: toYMD, weekIndex, haversine, activityCutoff, wind constants, RECOMMENDATION enum, DEFAULTS, formatNumber, degreesToCardinal, email regex, path traversal guard, BRIEFING_REGION regex, triage scoring, moon phase names, lifer detection, parenthetical stripping, wind shift detection, clearing detection, and fallout potential logic.

`scripts/test.js` — 6 integration smoke tests (require API keys). Run with `node scripts/test.js`.

| Test | What it checks |
|------|---------------|
| NWSClient.getBirdingWeather() | Real NWS API call with configured coords |
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
- `npm ci --ignore-scripts` does not modify package-lock.json; git hang bug eliminated ✓
- Agent correctly identifies prize birds (Connecticut Warbler, Neotropic Cormorant, Bell's Vireo) ✓

Still needed:
- QUIET_PERIOD path with `update_scheduled_task` rescheduling
- SILENT_SKIP path
- SendGrid fallback and disk fallback delivery

### Email rendering — [PARTIAL]

Confirmed working in Gmail (desktop). Still needed:
- Mobile rendering (Gmail app / Apple Mail on iPhone)
- Apple Mail desktop rendering
- Subject line display in preview pane on mobile

---

## 12. Code Review Findings

Two full review passes completed (2026-05-15 and 2026-05-16). All CRIT, HIGH,
MEDIUM, and LOW findings are fixed. This section is the permanent audit record.

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
| M5 | `utils.js:348` | `isCincinnatiArea` matched all of Ohio via `startsWith("US-OH")` | Removed; replaced by `getFavoriteHotspots()` which uses haversine + BRIEFING_FAVORITE_HOTSPOTS env var |
| M6 | `index.js:104–120` | `getBirdCastData` has no inflight coalescing — two concurrent tool calls for same region/date both miss cache and fire duplicate requests | Store in-flight promises; return to concurrent waiters |
| M7 | `index.js:477` | Hotspot ID detection uses `!locId.startsWith("L")` — matches "Lagoon Park" as a location ID | Use `/^L\d+$/.test(locId)` |
| M8 | `index.js:699` | `best_day_to_bird` calls `birdcast.getLiveMigration` directly, bypassing the 24h cache | Route through `getBirdCastData` |
| M9 | `index.js:714–718` | `getRegionStats` fetched per past day but `statsNote` never used in ranking — wasted API quota | Include `stats.numSpecies` in day score, or remove the call |

### LOW — Originally tracked

| ID | File | Status | Finding |
|----|------|--------|---------|
| L1 | `index.js` | **FIXED** | Tool schemas extracted to `src/tools.js` (~213 lines). `index.js` reduced from ~1400 to ~1215 lines. Tool dispatch `switch` replaced with `TOOL_HANDLERS` Map — adding a tool is now one line. Full handler extraction deferred (requires dependency injection refactor). |
| L2 | `birdcast-client.js` | **FIXED** | `_get` → `#get` (true ES private method) |
| L3 | `index.js` | **FIXED** | `compare_hotspots` capped at 10 items |
| L4 | `index.js` | **FIXED** | `hotspot_details` name input capped at 200 chars |
| L5 | `index.js` | **FIXED** | Named constants for scoring weights and candidate limits |
| L6 | `index.js` | **FIXED** | `getHotspotSpeciesCounts` catch block now logs to stderr |
| L7 | `index.js` | **DONE** (already was) | `best_day_to_bird` stats bonus already applied at line 990 |
| L8 | `utils.js` | **FIXED** | Comment documenting "this weekend" asymmetry |
| L9 | `briefing.js` | **N/A** | `briefing.js` deleted — file no longer exists. Legacy fix applied before deletion. |

### Round 2 review findings (2026-05-16)

From architecture, security, and code quality reviews of the full repo.

#### Fixed in same pass

| ID | Severity | File | Finding |
|----|----------|------|---------|
| R2-1 | HIGH | `index.js` | `handleHotspotDetails`: `getRecentObservations` calls missing `.catch(() => [])` — eBird errors crash the handler |
| R2-2 | HIGH | `index.js` | `handleCompareHotspots`: same missing `.catch()` + `subId` absent makes checklist count always 1 (added `.filter(Boolean)`) |
| R2-3 | HIGH | `index.js` | `handleCompareHotspots`: `input.startsWith("L")` accepts "Lake Erie Metropark" as locId — replaced with `/^L\d+$/.test()` |
| R2-4 | MEDIUM | `index.js` | `handleMigrationForecast`: NWS weather always fetched for default coords regardless of `region_code` passed — now resolves region to coordinates |
| R2-5 | MEDIUM | `index.js` | `handleBirdingWindow`: `activityCutoff` unbounded below — clamped to minimum 6:00 AM |
| R2-6 | MEDIUM | `briefing.js` | HTML injection in template interpolation — fixed before file was deleted |
| R2-7 | MEDIUM | `index.js` | `handleBestDayToBird`: `getBirdCastData` not wrapped in `.catch()` — BirdCast failure kills entire tool response |
| R2-8 | LOW | `index.js` | `loadLifeList` reads from disk on every `plan_vacation_birding` call — now cached in `_lifeListCache` module-level variable |
| R2-9 | LOW | `package.json` | `chart.js` and `chartjs-node-canvas` listed as deps but never imported — removed. MCP SDK pinned to exact version `1.29.0` |

#### Investigated / resolved

| ID | Severity | File | Finding |
|----|----------|------|---------|
| R2-A | MEDIUM | `index.js` | Rate limiter concern investigated: the gate resolves *before* the HTTP call starts, so concurrent HTTP requests can be in flight. Effective throughput is not 1 req/RTT — the limiter is correct. `getHotspotSpeciesCounts` manual batching is redundant but harmless. No fix needed. |
| R2-B | MEDIUM | `index.js` | **FIXED** — Exported `toYMD()` from `utils.js`, replaced `toISOString().slice(0,10)` in `handleBestDayToBird`. Added `toYMD()` import in `scripts/triage.js` and `scripts/aggregate.js`. |
| R2-C | LOW | `index.js` | **FIXED** — `NWSClient` and `INaturalistClient` now import and use `Cache` from `utils.js`. Own `Map`-based caches deleted. |
| R2-D | LOW | `index.js` | **FIXED** — Added `InputError` class in `index.js`; outer MCP handler catches `instanceof InputError` and surfaces `.message` directly to caller. |
| R2-E | LOW | `index.js` | **FIXED** — `loadLifeList` now parses header row to find "Common Name" column index dynamically instead of hardcoding position. |
| R2-F | LOW | `scripts/` | **FIXED** — `degreesToCardinal` exported from `birdcast-client.js`. Duplicate `cardinalFromDeg` in `triage.js` deleted and replaced with import. |

### Email chart gap — Resolved (2026-05-17)

Charts are now built in pure HTML/CSS (no external libraries or PNG generation).
The `routine-prompt.md` Design System specifies four visual types:
- **Bar chart** (migration last night vs season avg; hotspot 7-day species counts) — HTML table rows with proportional-width colored `<div>` fills
- **Forecast strip** (5-day outlook) — single-row table with 5 color-coded cells, quality-mapped to `#1a3a2a` / `#2d6a4f` / `#52796f` / `#bbb` / `#c0392b`
- **Condition tiles** (weather) — 1×4 grid, all `#f5f5f5`, value emphasis via text only
- **Timeline bar** (birding window) — 4-cell row, civil twilight → sunrise → golden hour → cutoff, color progression from dark to amber/red

All four verified rendering correctly in iPhone Safari and all scenario test emails. `chartjs-node-canvas` not needed.

---

## 13. Vacation Discovery Report

### Goal

A new MCP tool for Claude Desktop conversations. When the user is traveling, they ask naturally: "I'm going to Cape May, NJ May 20–25 — what should I look for?" The tool returns a discovery-oriented report: target species, active hotspots, and a birding window for the destination.

This is **not** part of the Routine email system — it's purely an interactive Claude Desktop tool, called on demand before or during a trip.

### Historical data strategy

BirdCast bar chart data (`getExpectedSpecies`) is historical (multi-year eBird records indexed by week of year). It gives accurate species frequencies for any week of the year regardless of current conditions — perfect for trips planned weeks or months ahead. The tool explicitly sets `ignoreSeasonCheck: true` when calling BirdCast so it works outside of migration season too.

The tool clearly distinguishes historical frequency data from recent live sightings (last 14 days of eBird notable observations), and surfaces both in the response.

### New tool: `plan_vacation_birding`

Implemented in `src/index.js` as the 11th MCP tool.

#### Input schema
```js
{
  destination: string,   // free text: city, "lat,lng", or region code
  dates: string,         // optional: "May 20-25", "next week", "June 1-7"
  home_region: string,   // optional: defaults to BRIEFING_REGION or "US-OH-061"
}
```

#### Implementation steps

**Step 1 — Resolve destination**
Use `resolveLocation()` from `utils.js`. If free text doesn't match the lookup table, try resolving via eBird's `/ref/region/list` or fall back to a hotspot search to infer region code from nearby hotspots.

**Step 2 — Fetch destination data in parallel**
- eBird nearby hotspots: `getNearbyHotspots(lat, lng, 50)` — up to 50km radius
- eBird recent notable observations: `getNearbyNotableObservations(lat, lng, 14, 50)`
- BirdCast expected species for destination region + date
- BirdCast expected species for home region + same date — for comparison
- `birding_window` for destination lat/lng + first date of trip

**Step 3 — Rank hotspots by community activity**
For the top 15 candidate hotspots by all-time species count, fetch 7-day recent observations. Rank by **recent checklist count** (proxy for active birder community), not all-time species count. Filter out spots with 0 recent checklists. Return top 5.

**Step 4 — Compute target species ("new to you" list)**

Two filters prevent noise:
- **Findability filter**: destination frequency > 15% for the travel dates
- **Novelty filter**: home region frequency < 10% for the same calendar period
- **Ubiquity exclusion**: remove House Sparrow, European Starling, Rock Pigeon, American Robin, Mourning Dove, Northern Cardinal, American Crow

Edge case — **"Everything is new"**: If >40 species pass both filters, tighten to home < 5% AND destination > 25%. Goal is 10–20 meaningful targets.

Edge case — **"Nothing is new"** (nearby destination): If <5 species pass, relax destination threshold to >10% and add a note: "This location has similar species to your home region."

**Group the output into two tiers:**
1. `★ Won't find at home` — home frequency < 2%
2. `▲ Rare at home, common here` — home frequency 2–10%

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
    wontFindAtHome: [
      { name: "Saltmarsh Sparrow", destinationFrequency: 0.38, homeFrequency: 0.00 },
      ...
    ],
    rareAtHome: [
      { name: "Dunlin", destinationFrequency: 0.52, homeFrequency: 0.06 },
      ...
    ],
  },
  notableRecentSightings: [...],
  summary: "Cape May in late May is one of the best spots on the East Coast for shorebirds and warblers. ★ 8 species you won't find at home, ▲ 14 more that are rare there but common here. Top spot: Cape May Point State Park — 87 checklists this week.",
}
```

### Personal life list integration

The tool reads an eBird CSV data export (`EBIRD_LIFE_LIST_CSV` env var). When configured, target species output switches modes:

- **With life list**: primary tier = `newToYourLifeList` (findable at destination, not in user's history), secondary tier = `seenBeforeButRareHere`
- **Without life list**: falls back to home-region frequency comparison (`wontFindAtHome` / `rareAtHome`)

The CSV is the "Download My Data" export from ebird.org → My eBird. Column header "Common Name" is detected dynamically; parenthetical subspecies are normalized. Notable recent sightings are annotated with `onYourLifeList: true/false`. The `lifeListLoaded` field in the response reports how many species were parsed.

### What this does NOT do

- No email / no Routine integration — Claude Desktop conversation only
- Does not replace `plan_birding_trip` for local trip planning

---

## 14. Still To Do

**[USER ACTION]** = requires manual steps outside the codebase (dashboard, email client, Claude Desktop).
Resolved items are struck through and kept for historical reference.

### Requires user action

| # | Item | Category | Notes |
|---|------|----------|-------|
| 22 | ~~Build on-demand report system (Section 3B) — code complete~~ | Feature | `.github/workflows/report-on-demand.yml` and `scripts/generate-email.js` built 2026-05-17. GitHub secrets + Claude.ai Project setup remain as user-action items (see Section 3B checklist). |
| 1 | Run full E2E tests for all 11 MCP tools in Claude Desktop | Testing | Run each tool from `TESTING.md` Section 3 in Claude Desktop with the local MCP server running. |
| 2 | Test QUIET_PERIOD Routine path end-to-end | Testing | Requires a real Routine run on a low-migration night. See `TESTING.md` Test B. |
| 3 | Test SILENT_SKIP Routine path | Testing | Requires a real Routine run on a very quiet night. See `TESTING.md` Test C. |
| 4 | Test SendGrid fallback delivery | Testing | Set invalid RESEND_API_KEY in .env, run `send.js`, verify SendGrid fires. Requires both API keys in .env. |
| 6 | ~~Email rendering on mobile (Gmail app, Apple Mail)~~ | Testing | Verified 2026-05-17 — all 4 scenario HTML files tested on iPhone via iCloud Drive. Confirmed: tables render, charts display, color coding correct, 2-color design holds on mobile. |
| 7 | Email rendering in Apple Mail desktop | Testing | Open a sent briefing in Apple Mail. See `TESTING.md` Section 7. |
| 8 | Test degraded modes: NWS down, BirdCast outside season, iNat timeout | Testing | Mock API failures locally or run during a known outage window. |
| 9 | Verify Resend custom domain (`BRIEFING_FROM_EMAIL`) | Config | Go to resend.com/domains → add and verify your domain → set `BRIEFING_FROM_EMAIL=Birding Briefing <briefing@yourdomain.com>` in .env. Without this, delivery is limited to the Resend account owner's address. |
| 10 | Confirm BirdCast API key approved for programmatic use | Config | Contact birdcast.info to confirm your key is approved for automated requests. Working in practice; formal approval unconfirmed. |
| 13 | ~~GitHub branch protection on `main`~~ | Security | Applied 2026-05-17 via `gh api`. Requires 1 PR review. Force-push disabled. |
| 14 | Scope Resend API key | Security | In Resend dashboard, scope the key to your sending domain only. Set a spend alert. Limits blast radius if the key leaks. |
| 16 | ~~Test `BRIEFING_FAVORITE_HOTSPOTS` env var~~ | Testing | Verified 2026-05-17 — `getFavoriteHotspots()` returns 3-item array with correct `locId` fields when env var set to `L123456,L789012,L345678`. |
| 17 | ~~Test vacation-to-new-region flow~~ | Testing | Verified 2026-05-17 — `BRIEFING_REGION=US-NY-061 BRIEFING_LAT=40.7 BRIEFING_LNG=-74.0` produces FULL_BRIEFING score 11, 76 notable species. Region override works correctly. |

### Bug Fixes Identified in Testing

| # | Bug | Category | Status | Tracked in | Notes |
|---|-----|----------|--------|------------|-------|
| B1 | ~~`species_finder` crashes on common species~~ | Code fix | Fixed 2026-05-17 | TESTING.md Bug #1 | Cap at 500 obs before dedup; try/catch with user-friendly error; summary notes when capped |
| B2 | ~~`plan_vacation_birding` "City, ST" format fails~~ | Code fix | Fixed 2026-05-17 | TESTING.md Bug #2 | Strip trailing `, ST` suffix and retry resolveDestination if first attempt returns null |
| B3 | ~~`plan_vacation_birding` nearby-destination returns 0 target species~~ | Code fix | Fixed 2026-05-17 | TESTING.md Bug #3 | Final fallback: home < 0.05 AND dest > 0.10 with "significant overlap" note |
| B4 | ~~`verify_sighting` ambiguous "data unavailable" message~~ | Code fix | Fixed 2026-05-17 | TESTING.md Bug #8 | Zero results → "No photo-verified observations found…"; API errors keep error wording |

### Resolved

| # | Item | Resolved | Notes |
|---|------|----------|-------|
| 5 | ~~Test disk fallback delivery~~ | 2026-05-17 | `send.js` with no API keys saves HTML to `briefing-output/`. Verified by automated test. |
| 11 | ~~Hotspot micro-habitat knowledge base~~ | 2026-05-17 | `data/hotspot-notes.json` built for 9 Cincinnati-area hotspots; wired into `aggregate.js` and Chase Target card generation in `routine-prompt.md`. |
| 15 | ~~Test `BRIEFING_SKIP_BIRDCAST=true`~~ | 2026-05-17 | Verified: `birdcastSkipped:true` in output, recommendation always FULL_BRIEFING or QUIET_PERIOD (never SILENT_SKIP). |
| 18 | ~~Triage score threshold tuning~~ | 2026-05-17 | `BRIEFING_SCORE_HIGH_BIRDS`, `BRIEFING_SCORE_MED_BIRDS`, `BRIEFING_SCORE_LOW_BIRDS`, `BRIEFING_FULL_THRESHOLD`, `BRIEFING_QUIET_THRESHOLD` env vars added to `triage.js`. Defaults match original Ohio-calibrated values. |
| 19 | ~~Ohio-birds LISTSERV scraper~~ | 2026-05-17 | Full body scraping: index → A2 page → A3 iframe. No login required — browser UA bypasses IIS 403. Extracts species lists (12 species from Blacklick reports). Returns `{subject, body, species[], location, url}` per report. |
| 20 | ~~Life list auto-refresh~~ | 2026-05-17 | `aggregate.js` auto-rebuilds `data/life-list.json` if `~/Downloads/ebird_world_life_list.csv` is newer. |
| 21 | ~~Verify frontal passage detection~~ | 2026-05-17 | `detectFrontalPassage()` verified against live NWS hourly data. Results documented in `TESTING.md`. |

### Low priority / deferred

| # | Item | Category | Notes |
|---|------|----------|-------|
| 12 | ~~Inline email charts~~ | Enhancement | Implemented 2026-05-17 via pure HTML/CSS — bar charts, forecast strip, condition tiles, timeline bar. No chartjs-node-canvas needed. See Section 12 "Email chart gap" note. |

**Reference:** `TESTING.md` — full feature inventory, test prompts, expected outputs, and status tracking.

---

## 15. Open Questions

| # | Question | Status | Answer |
|---|----------|--------|--------|
| 1 | Does an Anthropic Routine have access to MCP tools registered in Claude Desktop, or does it run in a clean context? | **Resolved** | Routines run as full Claude Code cloud sessions. Local MCP servers (added via Claude Desktop or `claude mcp add`) are not accessible — they run on the user's Mac. The Routine clones the GitHub repo and runs Node scripts via bash instead. |
| 2 | Can a Routine execute Node.js subprocesses (e.g. to render charts via chartjs-node-canvas)? | **Resolved** | Yes. Routines have bash tool access and can run Node.js subprocesses. Charts via `chartjs-node-canvas` are feasible when re-added as optionalDependencies. |
| 3 | Is the BirdCast API key a valid key for programmatic use, or is it a scrape of the dashboard? | **Open** | Key now stored in `BIRDCAST_API_KEY` env var (not hardcoded). Confirmed working in practice; formal programmatic-use status unverified. Check https://birdcast.info if usage increases. |
| 4 | What is the Routine's compute/memory limit? A full briefing with 14 API calls may take 30–60 seconds. | **Resolved** | Routines are full Claude Code cloud sessions with no special time limit beyond normal tool use. Standard session limits apply. |
| 5 | Resend free tier: does it support sending from a custom domain, or only `@resend.dev` test addresses? | **Open** | Resend requires a verified domain for custom From addresses; `@resend.dev` works for testing only (delivers to Resend account owner email). |
| 6 | Should the quiet-period reschedule be implemented as updating the Routine's cron schedule, or as the agent simply not calling the email tools and relying on a state flag stored somewhere? | **Resolved** | Implemented as cron update via `update_scheduled_task` — simpler than external state, no persistent storage needed. |
| 7 | Does the Routine need to stay within migration season bounds automatically, or will we configure separate Routines for spring and fall? | **Resolved** | One Routine runs year-round. The agent prompt includes season dates and the agent exits cleanly outside migration season. No separate Routines needed. |

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
| 2026-05-16 | Personal life list CSV integration added to plan_vacation_birding (EBIRD_LIFE_LIST_CSV). Section 13 updated to reflect implementation. |
| 2026-05-16 | Spec cleanup: fixed time references (5:45 AM → 4:00 AM ET), marked Section 4B [DONE], added email chart gap note, updated Section 11 to IN PROGRESS. |
| 2026-05-16 | Full architecture + security + code quality re-review. Fixed R2-1 through R2-9 (HIGH/MEDIUM bugs: missing .catch(), wrong NWS coords, HTML injection, activityCutoff clamp, life list cache, package.json cleanup). Open items R2-A through R2-F tracked in Section 12. |
| 2026-05-16 | Fixed all remaining review items: R2-B (toYMD UTC bug), R2-C (Cache unification), R2-D (InputError class), R2-E (CSV header parsing), R2-F (deduped cardinal function), L1 (tools.js module split + TOOL_HANDLERS Map). R2-A investigated and found correct — no fix needed. 6/6 smoke tests passing. |
| 2026-05-16 | Architectural refactor of Routine email system: added `scripts/aggregate.js` (comprehensive data aggregation → JSON) and `scripts/send.js` (email delivery from draft JSON). Routine agent now writes the email body dynamically using its reasoning instead of filling a fixed template. Rain impact detection added. Section 3 and Section 4B updated. `routine-prompt.md` rewritten with 7-step agent flow. |
| 2026-05-16 | Full architecture + security + code review of new scripts. Fixed: SendGrid fallback unreachable on Resend API errors; disk fallback cwd-relative path; BRIEFING_LAT/LNG NaN propagation; buildOutlook sequential loop → parallel; buildOutlook date derivation from new Date() → today param; duplicate toLocalYMD → import toYMD; inline degreesToCardinal → import; wind constants unified (SSW/SE added); computeActivityCutoff h===0 edge; fallout rain threshold 60%→50%. Prompt: removed hardcoded location; fixed schedule to 09:00 UTC (DST-safe); added update_scheduled_task guidance; fixed quiet-period data references; added null-handling guidance. |
| 2026-05-16 | Three live Routine runs completed successfully. Fixed UTC birding-window bug (formatTime now uses BRIEFING_TIMEZONE env var, default America/New_York). Fixed Routine git-hang (npm install → npm ci --ignore-scripts). Added Chase Targets section to Routine prompt — prize birds now get dedicated cards with rarity context, where-to-look, field ID, and time-sensitivity. Section 11 updated to reflect live test results. Created TESTING.md as the living E2E test document. |
| 2026-05-16 | Reliability + evolvability pass (Kleppmann principles). AbortSignal.timeout(10s/15s) on every fetch() across all 5 clients; toYMD() fixed to UTC methods; EBirdClient.makeRequest() wraps response.json() in try/catch; buildOutlook() per-day try/catch; invalid BRIEFING_LAT/LNG now fatal in triage.js; BirdCast rate limiter serialized with promise queue; SendGrid error body consumed. FAVORABLE_WINDS/POOR_WINDS deduplicated in utils.js; RECOMMENDATION frozen enum exported from utils.js; 11-case switch replaced with TOOL_HANDLERS Map in index.js. |
| 2026-05-16 | Evolvability review. De-Cincinnati-ified entire codebase: routine-prompt.md no longer references specific city or ET timezone; output labels in plan_vacation_birding renamed to homeFrequency/notFindableAtHome/rareAtHome. isCincinnatiArea() replaced with getFavoriteHotspots() reading BRIEFING_FAVORITE_HOTSPOTS env var. BRIEFING_SKIP_BIRDCAST added. BRIEFING_LOCATION_NAME added. Section 9 secrets table updated. |
| 2026-05-16 | Three parallel code reviews plus a dedicated public-repo security audit. Implemented all actionable findings: URLSearchParams for BirdCast API key; NWS URL domain assertion; path traversal guard in send.js; lat/lng validation in all MCP handlers; batched eBird calls (5 at a time); staggered NWS calls (300ms); BRIEFING_REGION rejects invalid format; draft.emailTo/emailFrom overrides removed from send.js; npm ci --ignore-scripts in Routine prompt; HTML-escape rule added to Routine agent RULES; path validation for EBIRD_LIFE_LIST_CSV; legacy scripts/briefing.js deleted. |
| 2026-05-16 | SPEC.md comprehensive review and cleanup: removed all references to deleted scripts/briefing.js; updated Section 4 to document TOOL_HANDLERS Map and RECOMMENDATION enum; corrected Section 7 rendering description (agent writes dynamically, not via briefing.js); added BRIEFING_LOCATION_NAME to Section 9 secrets table; fixed L9 to note briefing.js deleted; resolved Open Question 6 (cron update chosen); removed duplicate Open Questions table; fixed TOC to correctly list sections 14 (Still To Do) and 15 (Open Questions); added briefing-draft.json to .gitignore list; clarified dotenv situation; added resend to dependencies table; added Current State summary box. |
| 2026-05-17 | Four new aggregate.js features: (1) Life list integration — `scripts/build-life-list.js` pre-processes eBird life list CSV to `data/life-list.json`; `notableObservations[].isLifer` flags species not on life list; `liferOpportunities` count in flags; lifer-aware Chase Target cards in routine-prompt.md. (2) Moon phase — `buildMoonInfo()` adds `moon` field with phase name, illumination %, and migration note for full/new moon conditions. (3) Ohio-birds LISTSERV scraper — `src/ohio-birds-client.js` created; archive currently unavailable (HTTP 404), returns empty array gracefully; `listservSightings` field added to output. (4) Frontal passage / fallout detection — `NWSClient.detectFrontalPassage()` analyses NWS hourly forecast for wind shifts and overnight clearing; `frontalPassage`, `falloutPotential`, and `frontalNote` fields added to `weather.today` and `flags`. Unit tests added for all 4 features (moon phase names, lifer detection, strip-parenthetical, wind shift, clearing, fallout logic). |
| 2026-05-17 | Ohio-birds LISTSERV scraper: full body access discovered — no login required. IIS blocks non-browser User-Agents with 403; browser UA reveals A3 iframe endpoint serving email body parts publicly. Pipeline upgraded to index → A2 page → A3 iframe → body text (`<pre>` block). Species parser extracts up to 12 species per report. Verified live: Blacklick Metro Park report yielded 12 species including Canada, Blackburnian, Tennessee, Bay-breasted, Cape May, Hooded warblers. `listservSightings` now returns `{subject, body, species[], location, url, source}`. Community Buzz section updated to write per-report summaries using real species data. |
| 2026-05-17 | Email redesign: new Design System baked into `routine-prompt.md` — 2-color palette (#1a3a2a + #c0392b only), universal ◉ LIFER badge on every occurrence of lifer species, section structure (2–4 bullets → visual → narrative), four HTML/CSS visual types (bar chart, forecast strip, condition tiles, timeline bar). All 4 scenario test emails regenerated and verified on iPhone. |
| 2026-05-17 | Bird photo integration: added `src/media-client.js` (`MediaClient`) pulling top-rated photos from Macaulay Library (primary, by eBird species code, no API key) with Wikipedia REST API fallback. `aggregate.js` now fetches photos for first 10 notable observations in parallel; `photo` field added to each `notableObservations[]` entry. `routine-prompt.md` Design System updated: Chase Target cards get hero photo (640px, object-fit cover), Notable Sightings table gets 48×48 thumbnail column. Section 6B added to SPEC. 163 unit tests still passing. |
| 2026-05-17 | Added Section 3B: On-Demand Report — Mobile Trigger. Architecture: GitHub Actions `workflow_dispatch` + `scripts/generate-email.js` (Anthropic Haiku) + Claude.ai Project with GitHub MCP cloud connector. User types natural language on mobile → Claude resolves location + triggers workflow → triage → aggregate → Haiku writes email → Resend sends. Implementation checklist in Section 3B; item #22 added to Section 14. |
| 2026-05-17 | Option A on-demand reports built: `scripts/generate-email.js` (reads triage/aggregate JSON, calls claude-3-5-haiku-20241022, three-stage JSON parse fallback, SILENT_SKIP fast-path writes minimal draft so user always gets a response); `.github/workflows/report-on-demand.yml` (workflow_dispatch with 5 inputs, triage gates aggregate/generate steps, generate+send always run so SILENT_SKIP yields a "nothing notable" email rather than silence); `@anthropic-ai/sdk` added to package.json. Item #22 code complete — GitHub secrets + Claude.ai Project remain as user-action steps. |
| 2026-05-17 | Four MCP bugs fixed in src/index.js (171 unit tests, 0 failures): B1 species_finder — cap at 500 obs before dedup + try/catch + capped-results summary; B2 plan_vacation_birding — strip ", ST" state suffix before resolveDestination lookup; B3 plan_vacation_birding — final fallback (home<0.05, dest>0.10) for nearby destinations + "significant overlap" note; B4 verify_sighting — distinguishes zero-results ("No photo-verified observations found") from API errors. SPEC Section 14 bug table updated to resolved. |
| 2026-05-17 | Batch completion: (1) Hotspot notes — `data/hotspot-notes.json` built for 9 Cincinnati-area hotspots with trail-level habitat notes; wired into `aggregate.js` and Chase Target cards. (2) Configurable triage thresholds — 5 env vars added (`BRIEFING_SCORE_HIGH_BIRDS`, `BRIEFING_SCORE_MED_BIRDS`, `BRIEFING_SCORE_LOW_BIRDS`, `BRIEFING_FULL_THRESHOLD`, `BRIEFING_QUIET_THRESHOLD`). (3) Life list auto-refresh — `aggregate.js` auto-rebuilds `data/life-list.json` when `~/Downloads/ebird_world_life_list.csv` is newer. (4) Automated test results documented for items 5, 15, 21. Section 14 (Still To Do) restructured into user-action / resolved / deferred tables. |
