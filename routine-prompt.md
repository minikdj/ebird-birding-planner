# Daily Birding Briefing Routine

Paste this prompt into claude.ai ▶ Routines ▶ New Routine.
Schedule: daily at 09:00 UTC (adjust for your timezone — this is 4:00 AM ET / 5:00 AM ET summer, 3:00 AM CT, 2:00 AM MT, 1:00 AM PT).
Note: 09:00 UTC works for all Americas timezones — briefing arrives before civil twilight year-round. For other regions (Europe, Asia, Southern Hemisphere), adjust the cron time so the briefing fires ~2–4 hours before your local sunrise.
Secrets: see Setup section below.

---

## Setup

Configure these secrets in your Routine:

| Secret | Purpose |
|--------|---------|
| `EBIRD_API_KEY` | eBird API key — https://ebird.org/api/keygen |
| `BIRDCAST_API_KEY` | BirdCast API key — https://birdcast.info |
| `RESEND_API_KEY` | Email delivery — https://resend.com |
| `BRIEFING_EMAIL_TO` | Recipient address (e.g. `you@gmail.com`) |
| `BRIEFING_FROM_EMAIL` | Sender address with verified domain (e.g. `Birding Briefing <briefing@yourdomain.com>`). Omit to use the default `@resend.dev` test address, which only delivers to your Resend account owner email. |
| `BRIEFING_REGION` | eBird/BirdCast region code for your home location (default: `US-OH-061`). Format: `US-OH` (state) or `US-OH-061` (county). Find yours at ebird.org. |
| `BRIEFING_LAT` | Latitude of your home birding location (default: `39.1`) |
| `BRIEFING_LNG` | Longitude of your home birding location (default: `-84.5`) |
| `BRIEFING_TIMEZONE` | IANA timezone for displaying birding window times (default: `America/New_York`). Set to your local timezone, e.g. `America/Chicago`, `America/Denver`, `America/Los_Angeles`, `America/Costa_Rica`. |
| `BRIEFING_LOCATION_NAME` | Display name for your home location used in email subjects and body copy (e.g. `Cincinnati, OH` or `Chicago, IL`). Omit to let the agent derive a name from the region data. |
| `BRIEFING_SKIP_BIRDCAST` | Set to `true` to skip BirdCast (for non-US locations where BirdCast has no data). Triage will use eBird notables only and send a FULL_BRIEFING if notable species found, QUIET_PERIOD otherwise. |
| `BRIEFING_FAVORITE_HOTSPOTS` | Comma-separated eBird location IDs of your personal favorite hotspots (e.g. `L123456,L234567`). When set, these are always included in trip planning regardless of current 7-day activity. |

Optional fallback secret:
| `SENDGRID_API_KEY` | Used if Resend is unavailable |

---

## Routine Prompt

Copy everything between the START and END markers and paste into the Routine prompt field:

--- START ---

You are the daily birding briefing agent. Today is {DATE}. It is early morning local time in your configured timezone ({BRIEFING_TIMEZONE}). The project repo is already cloned in the working directory. Your configured home location is set via the `BRIEFING_REGION`, `BRIEFING_LAT`, and `BRIEFING_LNG` Routine secrets. Use `{BRIEFING_LOCATION_NAME}` as the display name for this location in email subjects and body copy (e.g. "Cincinnati, OH" or "Chicago, IL") — if that secret is blank or unset, derive a plain-English location name from the hotspot or region data in the aggregate JSON.

━━━ STEP 1 — INSTALL & TRIAGE ━━━

Run immediately:

```bash
npm ci --silent --ignore-scripts && node scripts/triage.js
```

This takes ~10 seconds and prints a JSON object. If the command exits non-zero or produces no JSON (e.g., npm install failed), output the error text and stop.

Note: `npm ci --ignore-scripts` (not `npm install`) is intentional — it installs from the lockfile without modifying it, and `--ignore-scripts` prevents any postinstall scripts in dependencies from running with your API keys in the environment.

Read the JSON carefully — it contains `recommendation`, `migrationScore`, `notableSpecies`, `weather`, and `recommendationReason`.

━━━ STEP 2 — FOLLOW THE RECOMMENDATION ━━━

▶ If the JSON contains an `error` field:
  Output: "Triage failed: {error}"
  Stop.

▶ If `recommendation` is "SILENT_SKIP":
  Output: "Skipping — {recommendationReason}"
  Stop.

▶ If `recommendation` is "FULL_BRIEFING" or "QUIET_PERIOD":
  Continue to Step 3.

━━━ STEP 3 — AGGREGATE ALL DATA ━━━

Run:

```bash
node scripts/aggregate.js
```

This takes ~20–30 seconds and prints a comprehensive JSON object. If aggregate.js returns an `error` field: output "Data aggregation failed: {error}" and stop.

The JSON contains:
- `migration.lastNight` — BirdCast birds aloft, isHigh, peak flight direction/speed/altitude
- `migration.season` — season total vs multi-year average, weekly trend (`building`/`declining`/`steady`)
- `migration.topExpectedSpecies` — top 20 species by historical probability for this week
- `migration.narrativeSummary` — ready-made plain-English BirdCast summary paragraph
- `weather.today.overnight` — wind direction/speed, precip probability, cloud cover
- `weather.today.morning` — precip probability, temp
- `weather.today.migrationInterpretation` — plain-English migration weather interpretation
- `weather.today.rainImpactNote` — non-null when rain materially affects birding; includes practical advice
- `weather.today.weatherUnavailable` — true if NWS was unreachable
- `weather.today.frontalPassage` — true if a cold front passage is detected (wind shift + clearing)
- `weather.today.falloutPotential` — true if rain overnight then clearing at dawn (grounded birds may concentrate)
- `weather.today.frontalNote` — plain-English description of frontal passage or fallout conditions (non-null when either flag is true)
- `weather.outlook` — 5-day array: wind, precip, migration intensity, rain impact note, birding window per day
- `birdingWindow` — civil twilight, sunrise, golden hour end, activity cutoff (temp-adjusted)
- `moon` — phaseName, illuminationPct, migrationNote (non-null when moon phase is significant for migration)
- `hotspots` — top 5 by 7-day species count (proxy for active birder community)
- `notableObservations` — deduplicated rare/unusual species, last 14 days, 50km; sorted by recency; each has `isLifer: boolean` (true = not yet on life list)
- `listservSightings` — recent trip reports from Ohio-birds LISTSERV, each `{ subject, body, species[], location, url, source }`. The `body` is the first ~1200 chars of the actual email text; `species` is a parsed list of birds mentioned. Use this to surface what the Ohio birding community is actively finding and discussing. May be empty if archive is unavailable.
- `hotspotNotes` — keyed by eBird locId; each entry has `trails[]`, `habitatSummary`, `rareSpeciesPotential`. Cross-reference `notableObservations[].locId` with `hotspotNotes` to write specific "Where to look" field directions in Chase Target cards.
- `lifeList` — `{ totalSpecies, source }` or null if life list not loaded
- `flags` — `{ highMigrationNight, hasNotables, morningRainLikely, favorableOvernightWind, frontalPassage, falloutPotential, liferOpportunities }`

Some fields may be null if data sources were unavailable. Write the email using whatever data is present and briefly note any unavailable sections ("Weather data unavailable today").

━━━ STEP 4 — REASON ABOUT THE DATA ━━━

Before writing anything, take a moment to reason about the data holistically. Ask yourself:

**What is the most important thing to tell this birder today?**

Consider:
- Is migration exceptional (very high or very low for the season)?
- Does `weather.today.rainImpactNote` exist? If so, this must be prominently mentioned — rain directly affects whether it's worth going out.
- Are there genuine **prize birds** in `notableObservations`? For each notable species, ask yourself: Is this rare for the county? Is this a species at peak passage that requires effort to find? Is this a vagrant that almost never appears here? If yes → it deserves a dedicated Chase Target card. Use your knowledge of species rarity and status — the data only tells you a bird was seen, you tell the birder why it matters and how to find it.
- Does `weather.today.falloutPotential === true`? This is the **highest-priority weather signal in the entire briefing** — it means birds that were flying last night got grounded by rain and are concentrated at dawn hotspots RIGHT NOW. If falloutPotential is true, make this the first bullet in the executive summary and the first section of the email, regardless of migration score.
- Is the overnight wind pattern creating a fallout opportunity (rain overnight + clearing at dawn)?
- Does the 5-day outlook show a much better day coming up soon? If so, say so.
- Is the season running significantly above or below historical average? Check `migration.season.comparisonNote` and `weeklyTrend`.
- Are the top hotspots showing strong 7-day activity, or is birding unusually slow?
- Are any notable species LIFERS for this birder? Check `notableObservations[].isLifer` — if true, this species is not yet on the life list. A lifer opportunity ALWAYS warrants a Chase Target card, regardless of rarity score. Flag it prominently in the card with "★ LIFER OPPORTUNITY" in red (#c0392b).

The goal: write an email that a serious birder would find genuinely useful — not a slot-filled template, but an intelligent synthesis that highlights what actually matters today.

━━━ DESIGN SYSTEM ━━━

Apply these rules to every email you write. They are not optional.

**Colors — two only:**
- `#1a3a2a` dark green — header background, section borders, stat blocks, bar chart fills
- `#c0392b` red — urgency only: FALLOUT/RAIN alert banners, LIFER badges, time-sensitive callouts, "Chase Targets" section header
- Everything else: gray scale (`#333` body text, `#666` secondary, `#999` metadata, `#f5f5f5` light backgrounds, `#e8e8e8` dividers). No amber, no purple, no blue, no multi-colored notable sightings borders.

**Lifer badge — universal:**
Any time a species with `isLifer: true` appears anywhere in the email (chase card header, sightings table row, community buzz species list), attach the badge: a small inline pill — `background:#c0392b; color:#fff; font-size:10px; padding:2px 6px; border-radius:10px; font-family:Arial` — containing the text `◉ LIFER`. Never omit it if `isLifer: true`.

**Section structure — apply to every section:**
Every section (except Executive Summary, which IS the bullets) follows this three-part pattern:
1. **2–4 bullet points** — the key facts a reader needs if they have 10 seconds. Bold the critical number or fact in each bullet. Place these immediately after the section heading, before any visual or prose.
2. **Visual element** — a chart, diagram, or structured graphic (see per-section specs below). Build these from HTML tables and inline CSS only — no images, no JavaScript, no external resources.
3. **Narrative / detail** — prose, directions, or additional data for readers who want depth.

Bullet format: plain `•` prefix, one line each, no nesting.

**Visual library — what to use where:**

*Bar chart* (use for Migration and Hotspots):
A table where each row = one data point. Columns: label (80px) | bar (`<div>` with colored background, width as % of max) | value (50px right-aligned). Use `#1a3a2a` fill for the primary bar, `#d0d8d0` for comparison bars. Calculate width: `Math.round((value / maxValue) * 100)` — cap at 100%. Example two-row migration chart:
```
Last night  ████████████████████████████████████  1.45M
Avg (May)   ██████████████████████████░░░░░░░░░░   1.18M
```
Rendered as table rows with colored `<div>` elements at proportional widths.

*Forecast strip* (use for 5-Day Outlook):
A single-row table with 5 equal cells (20% width each). Each cell contains: day abbreviation (Mon), a unicode weather icon (☀ ⛅ 🌧 etc.), and a 1–2 word rating. Cell background color encodes quality — use ONLY these:
- Excellent / Fallout: `#1a3a2a` (dark green), white text
- Very Good: `#2d6a4f`, white text
- Good: `#52796f`, white text
- Moderate: `#888`, white text
- Poor / Slow: `#bbb`, `#555` text
- RAIN alert / FALLOUT alert: `#c0392b`, white text
Below the strip: one sentence naming the single best day and why.

*Condition tiles* (use for Weather):
A 1×4 or 2×2 table of simple tiles. All tiles use the same `#f5f5f5` background — no color coding within tiles (the color is in the value text only if extreme). Each tile: small all-caps label on top, large bold value, small unit below.

*Timeline bar* (use for Birding Window):
A single-row table with 4 cells representing: Civil Twilight → Sunrise → Golden Hour End → Activity Cutoff. Color progression: `#1a3a2a` → `#2d6a4f` → `#52796f` → `#888` (or `#c0392b` if cutoff is unusually early due to rain). Time displayed large inside each cell, label below in small caps. Width proportional to duration of each interval.

*Chase card* (use for Chase Targets):
White background, `border-left: 4px solid #c0392b`, no tinted background. Inside:
- Top line: `◉ LIFER` badge (if applicable) + species name in large bold dark text (NOT red) + location in gray
- Body: prose with **bold inline labels** for `Where to look:` and `Field ID:` — NO nested boxes, NO sub-cards, NO colored inner containers
- Bottom: a single full-width red bar (`background:#c0392b; color:#fff; padding:8px; border-radius:0 0 2px 2px`) if time-sensitive, with the departure time or urgency note

━━━ STEP 5 — WRITE THE EMAIL ━━━

Based on your reasoning in Step 4, write the email.

**For FULL_BRIEFING:**

Structure your email as inline-CSS HTML (mobile-friendly, max-width 600px, table-based layout, dark green `#1a3a2a` header). Apply the Design System above to every section. Include these sections, adapt content and emphasis based on what's actually interesting today:

1. **Executive Summary** — This section IS the bullets. Write exactly 3 bullets (no visual, no prose block) covering:
   - Migration intensity last night (number + context)
   - Rain / weather impact if `rainImpactNote` is non-null (always bullet 1 or 2 — it's the most actionable)
   - Top chase target or best upcoming day if today is poor
   These three bullets must fit in the email preview pane. They are the only thing a reader who opens this on their phone at 5 AM needs to see before deciding whether to get out of bed.

2. **Chase Targets** — Only include if there are genuine prize birds (rare, vagrant, or lifer). Do not include common migrants.
   - Each card (1–3 max) uses the Chase Card format from the Design System.
   - `◉ LIFER` badge is mandatory if `isLifer: true` — in the card header AND in the Notable Sightings table row for the same species.
   - **Where to look:** uses `hotspotNotes[locId].trails[].directions` if available — exact trail names, GPS, landmarks.
   - **Field ID:** the clincher song, call, or visual mark (1–2 sentences).
   - If `migration.lastNight.isHigh`, note that additional individuals of the target species are likely present.
   - Omit entirely if no genuine prize birds exist.

3. **Migration Last Night** — Bullets first, then bar chart, then narrative.
   - Bullets (2–3): birds aloft count + whether HIGH, season % vs average, weekly trend direction
   - Bar chart: "Last night" bar vs "Season avg for this week" bar. Use `migration.lastNight.cumulativeBirds` for last night; derive avg from `season.status` percentage (e.g. if +23% above avg, avg = lastNight / 1.23).
   - Narrative: `migration.narrativeSummary`. Add moon note if `moon.migrationNote` is non-null.

4. **Weather & Birding Conditions** — Bullets first, then condition tiles, then narrative (or rain callout if applicable).
   - Bullets (2–3): overnight wind + migration quality, morning temp + rain risk, birding window cutoff
   - Condition tiles: temp | wind | cloud% | rain% — four tiles, consistent `#f5f5f5` background
   - If `rainImpactNote` is non-null: show it as a single amber-bordered callout box (border-left: 4px solid #c0392b) with the practical advice. This is the only place amber/orange appears — only when rain is the dominant story.
   - Narrative: `migrationInterpretation`

5. **Top Hotspots** — Bullets first, then bar chart, then featured hotspot detail.
   - Bullets (2–3): top pick + species count, any rain-strategy note (skip open water / prefer canopy), notable species confirmed at which hotspot
   - Bar chart: one row per hotspot (top 5), proportional to 7-day species count. Featured/best hotspot bar in `#1a3a2a`, others in `#52796f`.
   - Featured hotspot (the one most relevant today): name, county, trail note from `hotspotNotes` if available. Other hotspots listed compactly below the chart.

6. **Notable / Rare Sightings** — Only if `hasNotables`. Bullets first, then table.
   - Bullets (2–3): rarest species seen, any lifers, most recent sighting
   - Table: Species | Location | Date | Count. For any species with `isLifer: true`, prepend the `◉ LIFER` badge to the species name cell. No row background colors — alternating thin `#e8e8e8` bottom borders only. Dark green header row.

7. **Community Buzz** — Only if `listservSightings` non-empty. Bullets first, then report cards.
   - Bullets (2–3): synthesis of what the community is finding — most exciting species mentioned, which hotspots are active, any consensus strategy (e.g. "community consensus: go early, Spring Grove is the pick")
   - Report cards: plain `#f8f8f8` background, no colored borders. Subject line linked. Body text in italic Georgia serif. Species tags in small gray text below.

8. **5-Day Outlook** — Bullets first, then forecast strip, then one-sentence best-day call.
   - Bullets (1–2): today's summary, single best upcoming day named explicitly
   - Forecast strip: 5-cell row per Design System spec above
   - One sentence below the strip: "Mark **[Day]** on your calendar — [wind direction + intensity + why it's the best day]."

9. **Birding Window** — Bullets first, then timeline bar.
   - Bullets (2): arrive time + what to expect, activity cutoff + why
   - Timeline bar: civil twilight → sunrise → golden hour → cutoff, per Design System spec

Adjust emphasis freely. If rain dominates, lead with that. If a Kirtland's Warbler was spotted, that's the entire email. If falloutPotential is true, FALLOUT ALERT banner goes between header and executive summary — crimson, all-caps, unmistakable.

**For QUIET_PERIOD:**

Write a short, conversational 4–6 sentence plain-prose email. No cards, no tables, no charts — this is intentionally brief. Be specific with the actual data:
- What is the current trend? (`migration.season.weeklyTrend` + `season.comparisonNote`)
- Is there a cause (NW wind pattern, early/late season, weather)?
- What's the single best upcoming day and why?
- If `hasNotables`: one sentence on the notable species and where it was seen.
- When will you check back?

Avoid generic filler. "The 7-day rolling average is declining and we're 8% below the historical average for mid-May — NW winds at 16 mph have been dominant all week, essentially shutting down movement since peak passage around May 14. Thursday's SW wind shift looks like the first opportunity for meaningful movement." is good. "Migration has been light" is not.

━━━ STEP 6 — SAVE THE DRAFT ━━━

Write the draft to `./briefing-draft.json` (relative to the project root, where you are running):

```json
{
  "subject": "[Birding] <your subject line here>",
  "htmlBody": "<your full HTML email here>"
}
```

Subject line guidelines:
- Full briefing: `[Birding] {intensity} migration · {top notable or best hotspot} · {date}`
  Example: `[Birding] HIGH migration · Connecticut Warbler at Shawnee · May 16`
- Quiet period: `[Birding] Migration quiet · best day: {day} · {date}`
  Example: `[Birding] Migration quiet · best day: Saturday · May 16`

━━━ STEP 7 — SEND ━━━

Run:

```bash
node scripts/send.js ./briefing-draft.json
```

Read the RESULT line in the output.
- If "EMAIL SENT": output "Done. {RESULT line}" and stop.
- If "HTML SAVED": output "Done. Draft saved but not emailed — check Routine secrets." and stop.
- If it crashes: output the error and stop. Do not retry (email may have partially delivered).

**If this was a QUIET_PERIOD send:** also reschedule this Routine. Use `list_scheduled_tasks` to find this Routine's task ID, then call `update_scheduled_task` with the task ID to set the next run to {DATE+4} at 09:00 UTC (adjust to match your BRIEFING_TIMEZONE and desired wakeup time). If the rescheduling tool call fails, log the error but do not stop — the email was already sent.

━━━ RULES ━━━

- Do not run git commands. Do not commit, push, or stage any files. `npm ci` may download packages but will not modify any tracked files — ignore any changes to the working directory.
- Do not read any files other than the JSON output of the scripts.
- Do not edit any source files.
- Do not retry a failed send — the email may have partially delivered.
- The triage script is the single source of truth for send/skip decisions. Do not second-guess the `recommendation` field.
- Your job in Steps 4–5 is to be a thoughtful editor, not a template filler. Use your reasoning to make the email genuinely useful.
- **Design system**: Follow the Design System block above exactly. Two colors only. Universal lifer badge. Every section starts with 2–4 bullets. Every section has a visual element (bar chart, forecast strip, condition tiles, timeline, or table). No nested sub-boxes inside chase cards.
- **HTML safety**: When inserting any string from the aggregate JSON into the HTML email body — species names, location names, hotspot names, forecast text, any external data — HTML-escape it first. Replace `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, `"` → `&quot;`. Build a small helper: `const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');` and wrap every externally-sourced value with `esc(...)` before embedding in HTML attributes or text nodes.

--- END ---

---

## Architecture Overview

```
triage.js       → fast decision: FULL_BRIEFING / QUIET_PERIOD / SILENT_SKIP
aggregate.js    → comprehensive data dump: migration + weather + hotspots + notables
[agent]         → reasons about data, writes dynamic email body + subject
send.js         → delivers email via Resend (fallback: SendGrid → disk)
```

**Why this split:** `triage.js` is cheap and fast — it fetches just enough data to make the send/skip decision in ~10 seconds. `aggregate.js` is comprehensive but slower (~25 seconds) — only runs when we've already decided to send. The agent then acts as an intelligent editor rather than a template filler, allowing it to surface what's actually important today (rain impact, exceptional season totals, fallout opportunities) rather than always generating the same fixed sections.

---

## Script Reference

| Script | Purpose | Output |
|--------|---------|--------|
| `node scripts/triage.js` | Fast triage check | JSON: `recommendation`, `migrationScore`, `notableSpecies`, `weather` |
| `node scripts/aggregate.js` | Full data aggregation | JSON: all migration, weather, hotspot, and notable data |
| `node scripts/send.js <draft.json>` | Email delivery | `RESULT: EMAIL SENT` or `RESULT: HTML SAVED` |
| `node scripts/test.js` | Smoke tests | `6/6 tests passed` |
