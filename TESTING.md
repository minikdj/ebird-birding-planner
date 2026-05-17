# End-to-End Testing Guide

> Living document — update the Status column as tests are run.
> Last updated: 2026-05-17
>
> Key: ✅ Confirmed working · ⚠️ Partially tested · ❌ Not yet tested · 🔲 Needs re-test after change

---

## Table of Contents

1. [Feature Inventory](#1-feature-inventory)
2. [What Has Been Confirmed Working](#2-what-has-been-confirmed-working)
3. [MCP Tools — E2E Test Plan](#3-mcp-tools--e2e-test-plan)
4. [Routine Scripts — E2E Test Plan](#4-routine-scripts--e2e-test-plan)
5. [Routine Agent — Full Flow Tests](#5-routine-agent--full-flow-tests)
6. [Degraded / Failure Mode Tests](#6-degraded--failure-mode-tests)
7. [Email Rendering Tests](#7-email-rendering-tests)
8. [How to Run Tests](#8-how-to-run-tests)
   - [Section 5F: On-Demand Report](#test-f-on-demand-report-github-actions-)

---

## 1. Feature Inventory

### MCP Server Tools (Claude Desktop)

| # | Tool | Data Sources | Status |
|---|------|-------------|--------|
| 1 | `plan_birding_trip` | eBird + BirdCast + NWS + suncalc | ❌ Not documented |
| 2 | `migration_forecast` | BirdCast + NWS | ❌ Not documented |
| 3 | `hotspot_details` | eBird | ❌ Not documented |
| 4 | `compare_hotspots` | eBird + iNaturalist | ❌ Not documented |
| 5 | `species_finder` | eBird | ❌ Not documented |
| 6 | `best_day_to_bird` | BirdCast + eBird | ❌ Not documented |
| 7 | `birding_weather` | NWS + suncalc | ❌ Not documented |
| 8 | `verify_sighting` | iNaturalist | ❌ Not documented |
| 9 | `birding_window` | suncalc | ❌ Not documented |
| 10 | `species_frequency` | BirdCast | ❌ Not documented |
| 11 | `plan_vacation_birding` | eBird + BirdCast + iNat + NWS | ❌ Not documented |

### Routine Scripts

| Script | Purpose | Status |
|--------|---------|--------|
| `scripts/triage.js` | Fast triage: FULL_BRIEFING / QUIET_PERIOD / SILENT_SKIP | ✅ Confirmed (smoke test + 3 live runs) |
| `scripts/aggregate.js` | Comprehensive data aggregation → JSON | ✅ Confirmed (3 live runs) |
| `scripts/send.js` — Resend path | Email delivery via Resend | ✅ Confirmed (3 live runs) |
| `scripts/send.js` — SendGrid path | Fallback email delivery | ❌ Not tested |
| `scripts/send.js` — disk fallback | Save HTML when both APIs fail | ✅ Confirmed (2026-05-17) |
| `scripts/briefing.js` | Legacy template briefing | ❌ Not tested since architectural refactor |
| `scripts/test.js` | Smoke test suite | ✅ 6/6 passing |

### Routine Agent Paths

| Path | Trigger condition | Status |
|------|------------------|--------|
| FULL_BRIEFING | migrationScore ≥ 5 OR isHigh OR notables | ✅ Confirmed (3 live runs, May 16 2026) |
| QUIET_PERIOD | migrationScore 2–4, no notables | ❌ Not tested |
| SILENT_SKIP | migrationScore < 2 | ❌ Not tested |
| QUIET_PERIOD + reschedule | update_scheduled_task +4 days | ❌ Not tested |

---

## 2. What Has Been Confirmed Working

From three live Routine runs on 2026-05-16 (HIGH migration day, score 9/10):

### Routine pipeline
- `npm ci --silent` installs without modifying `package-lock.json` ✅
- `triage.js` outputs valid JSON with all required keys ✅
- `aggregate.js` outputs valid JSON with all data sections populated ✅
- Agent reasons holistically about data before writing email ✅
- Chase Targets section — three prize bird cards written with rarity context, field ID, where-to-look, time-sensitivity ✅
- `send.js` delivers via Resend with correct subject/body ✅
- Email received in Gmail inbox ✅
- No git hang (no git commands run) ✅

### Email content quality (confirmed in FINAL email)
- Birding window times display in Eastern time (5:55 AM civil twilight, not 9:55 AM UTC) ✅
- Season context surfaced: 45% below historical average with declining trend ✅
- Connecticut Warbler identified as prize bird with Mourning/Nashville comparison ✅
- Neotropic Cormorant gular pouch field mark correctly described ✅
- Bell's Vireo with alternating song cadence description ✅
- Suggested route (Armleder → Gilmore Ponds) generated from data ✅
- ★★ vs ★ rarity tiers applied in notables table ✅
- Monday May 18 identified as best upcoming day ✅
- Tuesday fallout scenario (65% overnight rain + 2% AM) identified ✅

### Smoke tests (automated)
- NWSClient.getBirdingWeather() ✅
- EBirdClient.getNearbyHotspots() ✅
- BirdCastClient.getExpectedSpecies() ✅
- INaturalistClient.getVerifiedSightings() ✅
- loadLifeList() from CSV ✅
- scripts/triage.js subprocess execution ✅

---

## 3. MCP Tools — E2E Test Plan

Run these in Claude Desktop after restarting it (to reload the MCP server).
Open Claude Desktop → new conversation → paste each prompt exactly.

### Tool 1: `plan_birding_trip`

**Prompt:**
```
Plan a birding trip for this weekend in Cincinnati
```

**Expected output contains:**
- [ ] Ranked list of hotspots (at least 3) with species counts
- [ ] Migration context (BirdCast birds aloft or "outside season" note)
- [ ] Birding window: civil twilight, sunrise, activity cutoff times in Eastern time
- [ ] Overnight wind direction and morning weather forecast
- [ ] Recommendation for which hotspot to visit first

**Edge case — out of range radius:**
```
Plan a birding trip for this weekend, radius 200km
```
- [ ] Radius clamped to 100km (no crash, no 200km scan)

---

### Tool 2: `migration_forecast`

**Prompt:**
```
What's the migration forecast for Cincinnati tonight?
```

**Expected output contains:**
- [ ] Cumulative birds aloft last night (or null if outside season)
- [ ] isHigh flag
- [ ] Peak flight direction and speed
- [ ] Season total vs. historical average
- [ ] Tonight's weather interpretation (overnight wind, precip)
- [ ] No crash

**Edge case — out of season:**
```
What was the migration forecast for Cincinnati on January 15?
```
- [ ] Graceful "outside migration season" message, no crash, no null pointer error

---

### Tool 3: `hotspot_details`

**Prompt:**
```
Give me details on Shawnee Lookout
```

**Expected output contains:**
- [ ] Hotspot name resolved from text to locId
- [ ] 7-day species count
- [ ] 14-day species count
- [ ] Notable/rare species seen recently (if any)
- [ ] No crash on name lookup

**Edge case — locId directly:**
```
Give me details on L273638
```
- [ ] locId passed through correctly (`/^L\d+$/` validation)

**Edge case — name that looks like a locId:**
```
Give me details on Lake Erie Metropark
```
- [ ] NOT treated as locId (name search, not direct locId)

---

### Tool 4: `compare_hotspots`

**Prompt:**
```
Compare Otto Armleder Memorial Park and Sharon Woods
```

**Expected output contains:**
- [ ] Species unique to each hotspot
- [ ] Species shared between both
- [ ] 7-day species count for each
- [ ] iNaturalist photo-verification called on top unique species (up to 3 calls)
- [ ] Confidence rating (high/moderate/low) for verified species

**Edge case — name that starts with "L":**
```
Compare Lake Erie Metropark and Sharon Woods
```
- [ ] "Lake Erie Metropark" not treated as locId (guard: `/^L\d+$/`)

---

### Tool 5: `species_finder`

**Prompt:**
```
Where has a Cerulean Warbler been seen near Cincinnati recently?
```

**Expected output contains:**
- [ ] List of locations where species was observed
- [ ] Deduplicated by location (same location not listed twice)
- [ ] Sorted by most recent observation date
- [ ] Distance from Cincinnati for each location

**Edge case — common species:**
```
Where has an American Robin been seen near Cincinnati recently?
```
- [ ] Returns results without crash even with many observations

---

### Tool 6: `best_day_to_bird`

**Prompt:**
```
What's the best day to go birding this week? I'm targeting warblers.
```

**Expected output contains:**
- [ ] Ranked days with scores
- [ ] Top recommendation with specific date
- [ ] Migration intensity factor per day
- [ ] Weather bonus/penalty per day (wind direction, precip)
- [ ] Note about target species (warblers) influencing recommendation

**Edge case — no target species:**
```
What's the best day to go birding this week?
```
- [ ] Works without target species, scores by migration + weather only

---

### Tool 7: `birding_weather`

**Prompt:**
```
What's the weather like for birding tomorrow morning?
```

**Expected output contains:**
- [ ] Overnight wind direction and speed
- [ ] Morning precipitation probability and temperature
- [ ] Plain-English migration interpretation
- [ ] `weatherUnavailable: false` (or graceful note if NWS is down)

---

### Tool 8: `verify_sighting`

**Prompt:**
```
Is there photo evidence of a Connecticut Warbler near Cincinnati recently?
```

**Expected output contains:**
- [ ] Photo-verified observation count from iNaturalist
- [ ] Confidence rating (high ≥3 / moderate 1-2 / low 0)
- [ ] Date of most recent verified observation
- [ ] Distance of nearest observation

**Edge case — rare bird with no iNat records:**
```
Is there photo evidence of a Kirtland's Warbler near Cincinnati?
```
- [ ] Returns low confidence / zero count, no crash

---

### Tool 9: `birding_window`

**Prompt:**
```
What time should I get to the park tomorrow?
```

**Expected output contains:**
- [ ] Civil twilight time (Eastern, not UTC)
- [ ] Sunrise time
- [ ] Golden hour end time
- [ ] Activity cutoff (temp-adjusted if temp > 75°F)
- [ ] Plain-English recommendation ("Arrive by X for peak dawn chorus")

**Edge case — hot day:**
```
What's the birding window for Cincinnati on a day when it's 90°F?
```
- [ ] Activity cutoff earlier than 10:30 AM (−15 min per 5°F above 75°F)
- [ ] Activity cutoff not earlier than 6:00 AM (clamp check)

---

### Tool 10: `species_frequency`

**Prompt:**
```
Is the Tennessee Warbler on time or late this year in Cincinnati?
```

**Expected output contains:**
- [ ] Current week probability for Hamilton County
- [ ] Peak week index and peak probability
- [ ] Pre-peak / at-peak / post-peak status
- [ ] Percentage of historical peak currently
- [ ] Plain-English phenology interpretation

---

### Tool 11: `plan_vacation_birding`

**Prompt (without life list):**
```
I'm going to Cape May, NJ May 20–25. What should I look for?
```

**Expected output contains:**
- [ ] Destination resolved to Cape May coordinates
- [ ] Two-tier target species list: ★ (won't find in Cincinnati) and ▲ (rare in Cincinnati)
- [ ] Top 5 hotspots ranked by recent checklist count (not all-time)
- [ ] Notable recent eBird sightings at destination
- [ ] Birding window for Cape May on the first trip date
- [ ] 10–20 meaningful target species (not >40, not <5)

**Prompt (with life list — requires EBIRD_LIFE_LIST_CSV set):**
```
I'm going to Cape May, NJ May 20–25. What should I look for? Use my life list.
```

**Expected output contains:**
- [ ] Primary tier: species new to life list (not in CSV)
- [ ] Secondary tier: seen before but rare at destination
- [ ] `lifeListLoaded: N` in response with count > 0

**Edge case — unmapped destination:**
```
I'm going to Chillicothe, OH next weekend. What should I look for?
```
- [ ] Graceful fallback (eBird region lookup or InputError), no crash

**Edge case — nearby destination with few unique species:**
```
I'm going to Columbus, OH this weekend. What should I look for?
```
- [ ] Relaxed filters applied, note that species overlap with Cincinnati is high
- [ ] No crash, still returns hotspots and recent sightings

---

## 4. Routine Scripts — E2E Test Plan

Run these locally from the project root.

### triage.js

```bash
node scripts/triage.js
```

**Verify:**
- [ ] Exits with code 0
- [ ] Prints valid JSON (not empty, not error)
- [ ] JSON contains all keys: `date`, `region`, `migrationScore`, `lastNight`, `notableSpecies`, `notableCount`, `weather`, `seasonStatus`, `recommendation`, `recommendationReason`
- [ ] `recommendation` is one of: `FULL_BRIEFING`, `QUIET_PERIOD`, `SILENT_SKIP`
- [ ] `migrationScore` is a number 0–10
- [ ] `weather.weatherUnavailable` is `false` (NWS is reachable)

---

### triage.js — BRIEFING_SKIP_BIRDCAST flag — item 15

**Status: PASS** (tested 2026-05-17)

```bash
source .env && BRIEFING_SKIP_BIRDCAST=true node scripts/triage.js 2>/dev/null
```

**Actual output (2026-05-17):**
```json
{
  "date": "2026-05-17",
  "region": "US-OH-061",
  "birdcastSkipped": true,
  "migrationScore": 4,
  "lastNight": null,
  "notableSpecies": ["Alder Flycatcher", "Black-bellied Plover", "Connecticut Warbler",
    "Lark Sparrow", "White-rumped Sandpiper", "Dickcissel", "Little Blue Heron"],
  "notableCount": 7,
  "weather": {
    "overnightWind": "S 7mph",
    "precipProbability": 2,
    "migrationInterpretation": "Favorable migration conditions. South winds with clear skies overnight — expect new arrivals at dawn.",
    "weatherUnavailable": false
  },
  "seasonStatus": null,
  "recommendation": "FULL_BRIEFING",
  "recommendationReason": "BirdCast skipped; 7 notable species found"
}
```

**Verify:**
- [x] `birdcastSkipped: true` present in output
- [x] `recommendation` is `FULL_BRIEFING` (not `SILENT_SKIP` — BirdCast skip does not force a skip)
- [x] `lastNight: null` (BirdCast migration data not fetched)
- [x] `notableSpecies` still populated (eBird notable observations still fetched)
- [x] Exits code 0

---

### aggregate.js

```bash
node scripts/aggregate.js
```

**Verify:**
- [ ] Exits with code 0
- [ ] Prints valid JSON (not empty, not error field)
- [ ] Top-level keys present: `date`, `region`, `location`, `migration`, `weather`, `birdingWindow`, `hotspots`, `notableObservations`, `flags`
- [ ] `birdingWindow.civilTwilight` displays in local (Eastern) time, not UTC — should be ~5–7 AM range, NOT 9–11 AM
- [ ] `weather.today.rainImpactNote` is non-null when morning precip ≥ 40%
- [ ] `flags.favorableOvernightWind` matches overnight wind direction in data
- [ ] `migration.topExpectedSpecies` has up to 20 entries
- [ ] `hotspots` has 1–5 entries, all with `speciesCount7Day > 0`

---

### send.js — Resend path

```bash
echo '{"subject":"Test","htmlBody":"<p>Test</p>"}' > /tmp/test-draft.json
RESEND_API_KEY=your_key node scripts/send.js /tmp/test-draft.json
```

**Verify:**
- [ ] Prints `RESULT: EMAIL SENT via Resend to ...`
- [ ] Email arrives in `BRIEFING_EMAIL_TO` inbox
- [ ] Exits code 0

---

### send.js — disk fallback (no API keys) — item 5

**Status: PASS** (tested 2026-05-17)

```bash
# Note: draftPath must be inside the repo root (security check)
echo '{"subject":"Test","htmlBody":"<h1>Test</h1>"}' > briefing-output/test-draft.json
RESEND_API_KEY="" node scripts/send.js briefing-output/test-draft.json
```
(Run with no `RESEND_API_KEY` and no `SENDGRID_API_KEY` set)

**Actual output:**
```
RESULT: EMAIL NOT SENT — RESEND_API_KEY is not configured.
RESULT: HTML SAVED to /Users/djm/claude/ebird-birding-planner/briefing-output/briefing-2026-05-17.html (no email sent — check secrets above)
```

**Verify:**
- [x] Prints `RESULT: HTML SAVED to .../briefing-output/briefing-YYYY-MM-DD.html`
- [x] File actually exists at that path
- [x] Exits code 0 (not 1)

**Note:** The draft JSON file must be within the repo root — `send.js` enforces a path-traversal guard (`resolvedDraft.startsWith(repoRoot + sep)`). Using `/tmp/` fails with "draftPath must be within the repo root".

---

### send.js — missing draft file

```bash
node scripts/send.js /tmp/does-not-exist.json
```

**Verify:**
- [ ] Exits code 1
- [ ] Error message is descriptive (not a raw stack trace)

---

### NWSClient.detectFrontalPassage() — item 21

**Status: PASS** (tested 2026-05-17)

```js
// /tmp/test-frontal.mjs
import { NWSClient } from '/Users/djm/claude/ebird-birding-planner/src/nws-client.js';
const nws = new NWSClient();
const result = await nws.detectFrontalPassage(39.1, -84.5, new Date().toISOString().split('T')[0]);
console.log(JSON.stringify(result, null, 2));
```

```bash
node /tmp/test-frontal.mjs
```

**Actual output (2026-05-17, Cincinnati OH, no frontal passage):**
```json
{
  "frontalPassage": false,
  "falloutPotential": false,
  "windShiftDetected": false,
  "clearingDetected": false,
  "frontalNote": null
}
```

**Verify:**
- [x] Returns all four required fields: `frontalPassage`, `windShiftDetected`, `clearingDetected`, `frontalNote`
- [x] Returns `falloutPotential` field
- [x] Does not require any API keys (uses NWS public API)
- [x] Does not crash when no frontal passage is detected (`frontalNote: null` is valid)
- [x] Exits without error

**Notes:** No frontal passage on 2026-05-17 in Cincinnati (quiet weather day, precip 2%, S wind).
The method hits the NWS hourly forecast API — output will vary by day and weather conditions.
Re-test on a day with cold front passage to verify `frontalPassage: true` and `frontalNote` populated.

---

### MediaClient — photo lookup (unit smoke test)

```bash
node --input-type=module <<'EOF'
import { MediaClient } from './src/media-client.js';
const media = new MediaClient();
const photo = await media.getTopPhoto('conwar', 'Connecticut Warbler');
console.log('source:', photo?.source);
console.log('url present:', !!photo?.url);
console.log('photographer:', photo?.photographer);
EOF
```

**Expected output checklist:**
- [ ] `source: macaulay` (primary source works)
- [ ] `url present: true`
- [ ] `photographer:` a non-empty name
- [ ] No crash, exits 0

**Fallback test — null speciesCode (forces Wikipedia path):**

```bash
node --input-type=module <<'EOF'
import { MediaClient } from './src/media-client.js';
const media = new MediaClient();
const photo = await media.getTopPhoto(null, 'Connecticut Warbler');
console.log('source:', photo?.source);
console.log('url present:', !!photo?.url);
EOF
```

**Expected:** `source: wikipedia`, `url present: true`

---

### aggregate.js — photo field verification

When running `node scripts/aggregate.js`, verify in the output:

- [ ] `notableObservations[0].photo` is either null or an object with keys: `url`, `thumbnailUrl`, `source`
- [ ] `notableObservations[0].speciesCode` is present and non-null

---

### briefing.js (legacy)

```bash
node scripts/briefing.js
```

**Verify:**
- [ ] Exits code 0 (no crash)
- [ ] Outputs HTML email content to stdout or saves to file
- [ ] Does not break after architectural refactor (aggregate.js / send.js changes)

---

## 5. Routine Agent — Full Flow Tests

These require triggering the Routine at claude.ai → Routines. Manually trigger to test.

### Test A: FULL_BRIEFING path (already confirmed ✅)

Conditions: Run during active migration season on a day with HIGH migration or notable species.

**Verify:**
- [x] triage.js runs and returns `FULL_BRIEFING`
- [x] aggregate.js runs and returns comprehensive JSON
- [x] Agent reasons holistically (check Step 4 reasoning in Routine logs)
- [x] Chase Targets section appears for genuine prize birds
- [x] No Chase Targets section on days with no notable species
- [x] Email subject matches format: `[Birding] HIGH migration · {species} · {date}`
- [x] Email delivered via Resend
- [x] No git commands run, no 403 errors
- [x] Birding window times display in Eastern time

---

### Test B: QUIET_PERIOD path ❌

Conditions: Run during a stretch of low migration (score 2–4, no notables). May need to wait for a naturally quiet period, or temporarily modify triage thresholds for testing.

**Verify:**
- [ ] triage.js returns `QUIET_PERIOD`
- [ ] aggregate.js runs (not skipped)
- [ ] Agent writes short conversational email (4–6 sentences, no big tables)
- [ ] Email references actual data: specific `weeklyTrend`, `comparisonNote`, best upcoming day with why
- [ ] Email subject matches format: `[Birding] Migration quiet · best day: {day} · {date}`
- [ ] Email delivered via Resend
- [ ] After send, agent calls `list_scheduled_tasks`
- [ ] Agent calls `update_scheduled_task` to set next run to {today+4} at 09:00 UTC
- [ ] If rescheduling fails: email was still sent, error logged, agent does not crash

---

### Test C: SILENT_SKIP path ❌

Conditions: Run during winter (outside migration season) or when migrationScore < 2.

**Verify:**
- [ ] triage.js returns `SILENT_SKIP`
- [ ] Agent outputs: `"Skipping — {recommendationReason}"`
- [ ] aggregate.js is NOT run
- [ ] No email sent
- [ ] No rescheduling

---

### Test D: Triage failure handling ❌

Simulate by temporarily unsetting `EBIRD_API_KEY` in Routine secrets.

**Verify:**
- [ ] triage.js outputs `{ "error": "Missing API keys" }`
- [ ] Agent outputs: `"Triage failed: Missing API keys"`
- [ ] Agent stops; no aggregate.js, no email

---

### Test E: aggregate.js failure handling ❌

Simulate by temporarily running aggregate.js with a bad BIRDCAST_API_KEY.

**Verify:**
- [ ] aggregate.js outputs `{ "error": "..." }`
- [ ] Agent outputs: `"Data aggregation failed: {error}"`
- [ ] Agent stops; no email sent

---

### Test F: On-Demand Report (GitHub Actions) ❌

#### Prerequisites
- [ ] `.github/workflows/report-on-demand.yml` exists in the repo
- [ ] `scripts/generate-email.js` exists
- [ ] GitHub repo secrets configured: `ANTHROPIC_API_KEY`, `EBIRD_API_KEY`, `BIRDCAST_API_KEY`, `RESEND_API_KEY`, `BRIEFING_EMAIL_TO`, `BRIEFING_FROM_EMAIL`, `NWS_CONTACT_EMAIL`
- [ ] Claude.ai Project "On-Demand Birding Report" created with GitHub MCP connector

#### Test F1: Manual workflow trigger via GitHub UI

1. Go to github.com/minikdj/ebird-birding-planner → Actions → On-Demand Birding Report → Run workflow
2. Fill in: location="Cape May, NJ", region="US-NJ-009", lat="38.93", lng="-74.96", focus="shorebirds"
3. Watch the run complete

**Verify:**
- [ ] All 4 steps complete (triage, aggregate, generate-email, send)
- [ ] Email arrives within 90 seconds
- [ ] Subject references "Cape May"
- [ ] Chase Target cards include bird photos (img tags present in HTML)
- [ ] No step fails with exit code 1

#### Test F2: SILENT_SKIP path

Trigger with a region that has no current activity (e.g. a winter month or low-activity region). Or temporarily set BRIEFING_FULL_THRESHOLD to a very high value in the workflow.

**Verify:**
- [ ] Workflow completes without error
- [ ] Minimal "nothing notable" email sent (not a full briefing)

#### Test F3: Claude.ai mobile trigger

1. Open Claude.ai mobile → On-Demand Birding Report project
2. Type: "Birding report for Magee Marsh, OH — what warblers are moving through?"

**Verify:**
- [ ] Claude identifies correct region code (US-OH-043 or similar)
- [ ] Claude triggers the GitHub workflow via GitHub MCP
- [ ] Claude responds with "Report triggered for Magee Marsh, OH — you'll receive an email within 60 seconds"
- [ ] Email arrives

---

## 6. Degraded / Failure Mode Tests

### NWS unreachable

Simulate by temporarily breaking the NWS User-Agent header in `src/nws-client.js` (add a test flag) or by running in an environment where NWS is blocked.

**Verify in aggregate.js output:**
- [ ] `weather.today.weatherUnavailable: true`
- [ ] `weather.today.overnight: null`
- [ ] `weather.today.rainImpactNote: null`
- [ ] `birdingWindow` still computed (suncalc needs no network)
- [ ] No crash

**Verify in Routine email:**
- [ ] "Weather data unavailable today" note in the email body
- [ ] Email still sends

---

### BirdCast outside migration season

Run triage.js or aggregate.js when `BRIEFING_REGION` is valid but date is outside Mar–Nov.

**Verify:**
- [ ] `migration.lastNight: null` in aggregate output
- [ ] `migration.season: null`
- [ ] triage.js `migrationScore` is ≤ 2 (from weather bonus only)
- [ ] `recommendation` is `SILENT_SKIP` (likely)
- [ ] No crash

---

### iNaturalist slow/down

iNat has no hard SLA. Simulate by temporarily setting a very short timeout in `src/inaturalist-client.js`.

**Verify in `verify_sighting` tool:**
- [ ] Returns `confidence: "low"`, `photoVerifiedCount: 0`
- [ ] No crash, no timeout thrown to caller

**Verify in `compare_hotspots` tool:**
- [ ] iNat verification calls fail gracefully
- [ ] Comparison still returns with `confidence: "low"` for verified species

---

### Resend API error (invalid key or unverified domain) ❌

Test by temporarily setting an invalid `RESEND_API_KEY` in Routine secrets.

**Verify in send.js:**
- [ ] Resend attempt logs the error to stderr
- [ ] If `SENDGRID_API_KEY` is set: SendGrid attempt is made
- [ ] If neither works: HTML saved to `briefing-output/`
- [ ] `RESULT:` line is either `EMAIL SENT` (SendGrid) or `HTML SAVED` (disk)
- [ ] Exits code 0 (disk save is not an error)

---

### Missing BRIEFING_LAT/LNG

Leave `BRIEFING_LAT` and `BRIEFING_LNG` unset in Routine secrets.

**Verify in aggregate.js:**
- [ ] Warning logged to stderr: "BRIEFING_LAT invalid or unset — using default"
- [ ] Falls back to Cincinnati coordinates (39.1, -84.5)
- [ ] No NaN propagated into API calls
- [ ] No crash

---

### Invalid locId in compare_hotspots

```
Compare Lagoon Park and Sharon Woods
```

**Verify:**
- [ ] "Lagoon Park" not treated as locId (fails `/^L\d+$/` test)
- [ ] Name lookup attempted instead
- [ ] Graceful error if name not found

---

## 7. Email Rendering Tests

### Gmail desktop ✅
- Confirmed working from three live Routine runs (2026-05-16)

### Gmail mobile (app) ❌
- [ ] Open the received FINAL email in Gmail iOS or Android app
- [ ] Table layout does not collapse or overflow
- [ ] Chase target cards display with left red border
- [ ] No horizontal scrolling required at 375px width
- [ ] Subject line readable in preview pane

### Apple Mail desktop ❌
- [ ] Open received email in Apple Mail
- [ ] Dark green header renders correctly
- [ ] Alternating table row colors display
- [ ] No image-blocked broken layout (no external images used)

### Apple Mail mobile ❌
- [ ] Open in Mail app on iPhone
- [ ] Same checks as Gmail mobile above

### Subject line ❌
- [ ] Fits in Gmail preview pane without truncation at typical screen widths
- [ ] Format: `[Birding] HIGH migration · Connecticut Warbler at Otto Armleder · May 16`
- [ ] Special characters (·) display correctly, not as encoded sequences

---

## 8. How to Run Tests

### Automated smoke tests (run anytime)
```bash
cd /Users/djm/claude/ebird-birding-planner
node scripts/test.js
# Expect: 6/6 tests passed
```

### Local script tests
```bash
# Triage
node scripts/triage.js | python3 -m json.tool

# Aggregate (slow — ~25s)
node scripts/aggregate.js | python3 -m json.tool

# Send — disk fallback (no API keys needed)
echo '{"subject":"Test subject","htmlBody":"<p>Hello</p>"}' > /tmp/test-draft.json
node scripts/send.js /tmp/test-draft.json
```

### MCP tool tests
1. Open Claude Desktop
2. Restart Claude Desktop to reload the MCP server (required after any `src/` change)
3. Paste each test prompt from Section 3 exactly as written
4. Check output against expected criteria
5. Note any failures here with date and symptom

### Routine tests
1. Go to claude.ai → Routines
2. Find the Daily Birding Briefing Routine
3. Click "Run now" (manual trigger)
4. Watch the execution log for each step
5. Check inbox for email within ~2 minutes

---

*Update Status column as tests are run. Mark ✅ when confirmed, add date and notes.*
