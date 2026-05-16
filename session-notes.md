# Session Notes — 2026-05-16

Saved for reference before the architectural refactor of the Routine.
These will be updated once the new architecture is implemented.

---

## Full Functionality Summary

### MCP Server (Claude Desktop — 11 tools)

**`plan_birding_trip`** — All-in-one morning planner. Ranks hotspots within radius
(score = species×2 + notable×5), includes BirdCast migration context, NWS overnight
+ morning weather with migration interpretation, and birding window (civil twilight,
sunrise, activity cutoff adjusted for temperature).

**`migration_forecast`** — BirdCast radar for a region/date. Last night's cumulative
bird count, isHigh flag, overnight flight direction/speed/altitude, season total vs
multi-year average, 7-day rolling trend, tonight's weather interpretation. Season-gated
(Mar–Jun, Aug–Nov), degrades gracefully outside season.

**`hotspot_details`** — Deep dive on a single hotspot (by locId or name). 7-day and
14-day species counts, notable/rare alerts with observer info.

**`compare_hotspots`** — Side-by-side comparison of 2–10 hotspots. Unique species per
hotspot, shared species, checklist activity. iNaturalist photo-verification called on
top unique species (up to 3 calls). locId validated with `/^L\d+$/`.

**`species_finder`** — "Where has [species] been seen recently?" Searches within
radius, deduplicates by location, sorts by recency.

**`best_day_to_bird`** — Scores each day in a date range by BirdCast intensity,
historical eBird frequency, and recent notable bonus. Optional target species to bias
scoring. Returns ranked days with recommendation. Local-time date arithmetic (toYMD).

**`birding_weather`** — NWS weather interpreted for birding. Overnight window (wind,
precip), morning forecast (temp, feels-like), plain-English migration interpretation.
1-hour cache. Degrades gracefully if NWS unreachable.

**`verify_sighting`** — Cross-references eBird report against iNaturalist photo-verified
observations. Returns confidence (high/moderate/low), count, nearest obs distance. 6-hour cache.

**`birding_window`** — Pure computation via suncalc. Civil twilight, sunrise, activity
cutoff (10:30 AM base, -15 min per 5°F above 75°F, clamped ≥ 6:00 AM).

**`species_frequency`** — BirdCast bar chart data. Current week probability, peak week
index, pre/at/post-peak status, plain-English phenology interpretation.

**`plan_vacation_birding`** — Pre-trip discovery report. Resolves destination (20+
cities pre-mapped), fetches BirdCast historical frequencies for both destination and
Cincinnati, computes two-tier target species list (★ won't find in Cincy / ▲ rare in
Cincy), community-ranked hotspots by recent checklist count, notable recent sightings.
With EBIRD_LIFE_LIST_CSV: switches to life-list mode (new to you / seen before but rare
here). Works year-round (ignoreSeasonCheck).

### Routine (Daily Email — scripts/)

**`scripts/triage.js`** — Fast triage (~10s). BirdCast last night + NWS weather +
eBird notable obs. Outputs JSON with migrationScore, recommendation (FULL_BRIEFING /
QUIET_PERIOD / SILENT_SKIP), recommendationReason, notableSpecies, seasonStatus.

**`scripts/briefing.js`** — Template-based HTML email. Gathers all data, renders
executive summary, migration card, weather card, top 3 hotspots, 5-day outlook, rare
alerts. Sends via Resend (fallback: SendGrid → Gmail → disk). Supports --quiet flag.

**`scripts/test.js`** — 6-test smoke suite (all live API calls). 6/6 passing.

---

## End-to-End Test Plan

### Phase 1: MCP tools in Claude Desktop

Restart Claude Desktop first, then run each prompt:

| # | Prompt | Verifies |
|---|--------|----------|
| 1 | "Plan a birding trip for this weekend in Cincinnati" | plan_birding_trip — ranked hotspots, weather, birding window, migration context |
| 2 | "What's the migration forecast for Cincinnati tonight?" | migration_forecast — BirdCast + NWS weather interpretation |
| 3 | "Give me details on Shawnee Lookout" | hotspot_details — name resolution, 7/14-day counts, notables |
| 4 | "Compare Otto Armleder and Sharon Woods" | compare_hotspots — unique/shared species, iNat verification |
| 5 | "Where has a Cerulean Warbler been seen near Cincinnati recently?" | species_finder — deduplicated, sorted by recency |
| 6 | "What's the best day to go birding this week? I'm targeting warblers." | best_day_to_bird — ranked days, target species note |
| 7 | "What's the weather like for birding tomorrow morning?" | birding_weather — overnight wind, temp, migration interpretation |
| 8 | "Is there photo evidence of a Connecticut Warbler near Cincinnati?" | verify_sighting — iNat confidence level + count |
| 9 | "What time should I get to the park tomorrow?" | birding_window — twilight, sunrise, cutoff recommendation |
| 10 | "Is the Tennessee Warbler on time or late this year in Cincinnati?" | species_frequency — current probability, peak week, phenology |
| 11 | "I'm going to Cape May, NJ May 20–25. What should I look for?" | plan_vacation_birding — two-tier species list, life list annotations, ranked hotspots, birding window |

**Edge cases:**
- Tool 2 with out-of-season date: "Migration forecast for January 15" → graceful null, no crash
- Tool 11 with unmapped city → graceful fallback or InputError
- Tool 4 with "Lake Erie Metropark" → NOT treated as locId (regex guard)

### Phase 2: Routine scripts

```bash
cd /Users/djm/claude/ebird-birding-planner
node scripts/triage.js          # JSON with migrationScore, recommendation, notableSpecies
node scripts/briefing.js        # Full HTML email (or saves to briefing-output/ if no Resend key)
node scripts/briefing.js --quiet  # Short 3-4 sentence email
```

Verify triage JSON has: `migrationScore`, `recommendation`, `recommendationReason`,
`notableSpecies`, `lastNight`, `weather`, `seasonStatus` keys.

### Phase 3: Smoke tests

```bash
node scripts/test.js  # Expect: 6/6 tests passed
```

### Phase 4: Failure/degraded modes

- Out-of-season date for migration_forecast → null from BirdCast, graceful text
- verify_sighting with obscure species → confidence: "low", zero count, no error
- Bad lat/lng for birding_weather → weatherUnavailable: true, no crash

---

## Routine Prompt (v2 — improved, pre-architecture refactor)

This replaces the version in `routine-prompt.md`.
The key improvement: reads the `recommendation` field triage.js already computed
instead of re-implementing the decision logic.

```
You are the daily birding briefing agent for Cincinnati, OH (Hamilton County, US-OH-061, 39.1°N 84.5°W).

Today is {DATE}. It is 4:00 AM ET. The project repo is already cloned in the working directory.

━━━ STEP 1 — INSTALL & TRIAGE ━━━

Run this immediately:
  npm install --silent && node scripts/triage.js

Takes ~10 seconds. Prints a JSON object to stdout. Read it.

━━━ STEP 2 — ACT ON THE JSON ━━━

The JSON contains a `recommendation` field. Follow exactly one branch:

▶ If the JSON contains an `error` field:
  Output: "Triage failed: {error}"
  Stop.

▶ If recommendation is "FULL_BRIEFING":
  Run: node scripts/briefing.js
  Output: "Sent full briefing. Reason: {recommendationReason}"
  Stop.

▶ If recommendation is "QUIET_PERIOD":
  Run: node scripts/briefing.js --quiet
  Call update_scheduled_task to reschedule this Routine +4 days from today.
  Output: "Sent quiet note. Rescheduled to {date+4}. Reason: {recommendationReason}"
  Stop.

▶ If recommendation is "SILENT_SKIP":
  Output: "Skipping — {recommendationReason}"
  Stop.

━━━ RULES ━━━
- Do not read any files. Do not edit any files. Do not do anything else.
- The triage script handles all decision logic — trust the recommendation field entirely.
- If npm install fails, output the error and stop.
- If briefing.js fails, output the error and stop (do not retry — email may have partially sent).
```

---

*This file will be deleted or superseded once the architectural refactor is complete
and the prompts above have been updated to reflect the new system.*
