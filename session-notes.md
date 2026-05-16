# Session Notes — 2026-05-16

Reference document capturing the full functionality summary, E2E test plan, and
the current Routine prompt. Updated after the architectural refactor and review pass.

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

**`species_finder`** — "Where has [species] been seen recently?" Searches within radius,
deduplicates by location, sorts by recency.

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

**`plan_vacation_birding`** — Pre-trip discovery report. Resolves destination (20+ cities
pre-mapped), fetches BirdCast historical frequencies for both destination and Cincinnati,
computes two-tier target species list (★ won't find in Cincy / ▲ rare in Cincy),
community-ranked hotspots by recent checklist count, notable recent sightings. With
EBIRD_LIFE_LIST_CSV: switches to life-list mode (new to you / seen before but rare here).
Works year-round (ignoreSeasonCheck).

---

### Routine (Daily Email — scripts/)

**Current architecture:**
```
triage.js        → fast triage: FULL_BRIEFING / QUIET_PERIOD / SILENT_SKIP (~10s)
aggregate.js     → comprehensive data JSON: all migration + weather + hotspot data (~25s)
[Routine agent]  → reasons about data, writes email body + subject dynamically
send.js          → delivers email via Resend (fallback: SendGrid → disk)
briefing.js      → legacy template briefing (kept as reference/fallback, not used in flow)
test.js          → smoke test suite: 6/6 passing
```

**`scripts/triage.js`** — Fast decision pass. BirdCast last night + NWS weather + eBird
notables. Outputs JSON: `{ recommendation, migrationScore, notableSpecies, weather,
lastNight, seasonStatus, recommendationReason }`. Scoring: isHigh→+4, >500K birds→+3,
>100K→+2, >50K→+1, notables→+2, favorable S/SW/SSW/SE wind→+2, poor N/NW/NNW/NE→-2.

**`scripts/aggregate.js`** — Comprehensive data dump. All data sources in parallel.
Outputs: migration.lastNight, migration.season, migration.topExpectedSpecies,
migration.narrativeSummary, weather.today (with rainImpactNote for rain ≥ 40%),
weather.outlook (5-day, parallel fetch), birdingWindow, hotspots (top 5 by 7-day
activity), notableObservations (14d, 50km, deduplicated), flags.

**`scripts/send.js`** — Reads `briefing-draft.json { subject, htmlBody }`, delivers:
1. Resend (API error AND network errors both fall through to SendGrid)
2. SendGrid fallback
3. `briefing-output/briefing-YYYY-MM-DD.html` disk fallback (repo-relative path)

---

## End-to-End Test Plan

### Phase 1: MCP tools in Claude Desktop

Restart Claude Desktop first to reload the server, then run each prompt:

| # | Prompt | Verifies |
|---|--------|----------|
| 1 | "Plan a birding trip for this weekend in Cincinnati" | plan_birding_trip — ranked hotspots, weather, birding window, migration context |
| 2 | "What's the migration forecast for Cincinnati tonight?" | migration_forecast — BirdCast + NWS weather interpretation; no crash if outside season |
| 3 | "Give me details on Shawnee Lookout" | hotspot_details — name resolution to locId, 7/14-day counts, notables |
| 4 | "Compare Otto Armleder and Sharon Woods" | compare_hotspots — unique/shared species, iNat photo-verification on top uniques |
| 5 | "Where has a Cerulean Warbler been seen near Cincinnati recently?" | species_finder — deduplicated by location, sorted by recency |
| 6 | "What's the best day to go birding this week? I'm targeting warblers." | best_day_to_bird — ranked days, target species note in scoring |
| 7 | "What's the weather like for birding tomorrow morning?" | birding_weather — overnight wind, morning temp, migration interpretation |
| 8 | "Is there photo evidence of a Connecticut Warbler near Cincinnati?" | verify_sighting — iNat confidence level + count |
| 9 | "What time should I get to the park tomorrow?" | birding_window — twilight, sunrise, cutoff, recommendation |
| 10 | "Is the Tennessee Warbler on time or late this year in Cincinnati?" | species_frequency — current probability, peak week, phenology |
| 11 | "I'm going to Cape May, NJ May 20–25. What should I look for?" | plan_vacation_birding — two-tier species list, life list annotations, ranked hotspots, birding window |

**Edge cases:**
- Tool 2 with out-of-season date: "Migration forecast for January 15" → graceful null, no crash
- Tool 11 with unmapped destination → graceful InputError or fallback  
- Tool 4 with "Lake Erie Metropark" → NOT treated as locId (`/^L\d+$/` guard)

### Phase 2: Routine scripts (simulate cloud agent locally)

```bash
cd /Users/djm/claude/ebird-birding-planner

# Fast triage — verify JSON keys and recommendation field
node scripts/triage.js
# Expect: { recommendation: "FULL_BRIEFING"|"QUIET_PERIOD"|"SILENT_SKIP", migrationScore, ... }

# Comprehensive aggregation — verify all data sections populated
node scripts/aggregate.js
# Expect: top-level keys: date, region, location, migration, weather, birdingWindow,
#         hotspots, notableObservations, flags
# Verify: weather.today.rainImpactNote present if precip ≥ 40%
# Verify: flags.favorableOvernightWind consistent with overnight wind direction

# Email delivery — test the draft file path and disk fallback
echo '{"subject":"Test","htmlBody":"<p>Test</p>"}' > /tmp/test-draft.json
node scripts/send.js /tmp/test-draft.json
# Expect: RESULT: HTML SAVED to .../briefing-output/briefing-YYYY-MM-DD.html
#         (since RESEND_API_KEY is not set locally)

# Legacy template briefing (for comparison)
node scripts/briefing.js
```

### Phase 3: Automated smoke tests

```bash
node scripts/test.js
# Expect: 6/6 tests passed
```

### Phase 4: Failure / degraded modes

- **No BirdCast data** (outside season): triage.js will return migrationScore ≈ 0–2 from weather
  only, likely SILENT_SKIP. aggregate.js will have `migration.lastNight: null`, `migration.season: null`.
- **NWS unreachable**: aggregate.js `weather.today.weatherUnavailable: true`, `rainImpactNote: null`.
  Email should note weather unavailability.
- **iNat slow/down**: verify_sighting returns `confidence: "low"`, zero count, no crash.
- **Resend API error** (domain not verified): send.js logs Resend error, attempts SendGrid, falls
  through to disk. Check that RESULT line says SAVED, not SENT.
- **Missing BRIEFING_LAT/LNG**: aggregate.js logs warning to stderr, falls back to Cincinnati defaults.

### Phase 5: Full Routine simulation

Manually trigger the Routine in claude.ai. Verify:
1. Agent runs triage and reads recommendation
2. Agent runs aggregate for FULL_BRIEFING or QUIET_PERIOD
3. Agent reasons about data in Step 4 before writing (check Routine logs)
4. Agent writes meaningful, non-generic email body
5. Agent calls send.js with draft file
6. Email arrives in inbox (or check briefing-output/ on disk)
7. For QUIET_PERIOD: agent calls update_scheduled_task +4 days

---

## Routine Prompt (current — post-refactor + review)

The full prompt is in `routine-prompt.md`. Key summary:

```
Step 1: npm install --silent && node scripts/triage.js  → recommendation JSON
Step 2: SILENT_SKIP → done; FULL_BRIEFING|QUIET_PERIOD → continue
Step 3: node scripts/aggregate.js  → comprehensive data JSON
Step 4: Agent reasons holistically (rain? exceptional season? rare species? best day?)
Step 5: Agent writes email HTML + subject
Step 6: Agent saves ./briefing-draft.json { subject, htmlBody }
Step 7: node scripts/send.js ./briefing-draft.json  → EMAIL SENT or HTML SAVED
        QUIET_PERIOD: also call update_scheduled_task (+4 days, 09:00 UTC)
```

Key improvements over original prompt:
- Agent writes email body using reasoning (not fixed template)
- Rain impact prominently featured when morningPrecip ≥ 40%
- Agent reads `recommendation` field (single source of truth) not re-implementing logic
- Quiet period emails use actual weeklyTrend + comparisonNote data
- Hardcoded Cincinnati removed — location from Routine secrets
- SendGrid fallback fixed (triggers on API errors, not just network throws)
- Schedule: 09:00 UTC (DST-safe — 4 AM ET winter / 5 AM ET summer)
- `npm ci` instead of `npm install` — does not modify package-lock.json
- RULES: explicit "do not run git commands" — prevents Routine from committing/pushing
- `BRIEFING_TIMEZONE` secret added — fixes UTC vs local time display in birding window

---

## Live Test Results — 2026-05-16

First live Routine run. Email delivered successfully via Resend to minikdj11@gmail.com.
Subject: `[Birding] HIGH migration · Connecticut Warbler at Armleder · May 16`

**What worked well:**
- Email content quality was excellent: 3.6M birds aloft, Connecticut Warbler as lede
- Season context (45% below average) prominently featured with "burst not trend" framing
- Neotropic Cormorant at Gilmore Ponds called out as exceptional
- Monday May 18 identified as best day, Tuesday fallout opportunity predicted
- Dynamic agent-written email clearly superior to fixed template

**Bugs found and fixed:**

### Bug 1 — Routine hung on git push (FIXED)
After sending the email, the agent autonomously committed `package-lock.json` (changed
by `npm install`) and tried to push to GitHub. Got 403 errors, retried 4+ times with
exponential backoff, hanging the Routine.

Fix 1: Changed `npm install --silent` → `npm ci --silent` in Step 1. `npm ci` installs
from the lockfile without modifying it, so package-lock.json stays clean.

Fix 2: Added explicit rule to RULES section: "Do not run git commands. Do not commit,
push, or stage any files."

### Bug 2 — Birding window times off by 4 hours (FIXED)
Email showed: "Civil Twilight: 9:55 AM, Sunrise: 10:25 AM" — exactly 4h late.
Cloud runner is UTC; suncalc returns correct Date objects but `formatTime` called
`toLocaleTimeString` without a `timeZone` arg, so it rendered in server local time (UTC).
Cincinnati is EDT (UTC-4), so all times appeared 4 hours late.

Fix: Added `DISPLAY_TZ = process.env.BRIEFING_TIMEZONE || 'America/New_York'` constant
in aggregate.js and passed it as `timeZone` to every `toLocaleTimeString` call in `formatTime`.
Added `BRIEFING_TIMEZONE` to the Routine secrets table in routine-prompt.md.

---

*This file is a working reference — not checked for code accuracy, not committed history.*
