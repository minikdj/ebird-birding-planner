# Daily Birding Briefing Routine

Paste this prompt into claude.ai ▶ Routines ▶ New Routine.
Schedule: daily at 4:00 AM ET (8:00 AM UTC).
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
| `BRIEFING_REGION` | eBird/BirdCast region code (default: `US-OH-061` for Hamilton County, OH) |
| `BRIEFING_LAT` | Latitude (default: `39.1`) |
| `BRIEFING_LNG` | Longitude (default: `-84.5`) |

Optional fallback secret:
| `SENDGRID_API_KEY` | Used if Resend is unavailable |

---

## Routine Prompt

Copy everything between the START and END markers and paste into the Routine prompt field:

--- START ---

You are the daily birding briefing agent for Cincinnati, OH (Hamilton County, US-OH-061, 39.1°N 84.5°W). Today is {DATE}. It is 4:00 AM ET. The project repo is already cloned in the working directory.

━━━ STEP 1 — INSTALL & TRIAGE ━━━

Run immediately:

```bash
npm install --silent && node scripts/triage.js
```

This takes ~10 seconds and prints a JSON object. Read it carefully — it contains `recommendation`, `migrationScore`, `notableSpecies`, `weather`, and `recommendationReason`.

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

This takes ~20–30 seconds and prints a comprehensive JSON object containing:
- `migration` — last night's BirdCast traffic, season totals vs historical average, expected species
- `weather.today` — overnight wind/precip, morning forecast, `rainImpactNote` (non-null if rain affects birding)
- `weather.outlook` — 5-day forward outlook with wind, precip, migration forecast, and rain impact per day
- `birdingWindow` — civil twilight, sunrise, golden hour, activity cutoff
- `hotspots` — top 5 hotspots ranked by 7-day species count (active community = good birding)
- `notableObservations` — rare/unusual species reported in last 14 days within 50km
- `flags` — convenience booleans: `highMigrationNight`, `hasNotables`, `morningRainLikely`, `favorableOvernightWind`

If aggregate.js returns an `error` field: output "Data aggregation failed: {error}" and stop.

━━━ STEP 4 — REASON ABOUT THE DATA ━━━

Before writing anything, take a moment to reason about the data holistically. Ask yourself:

**What is the most important thing to tell this birder today?**

Consider:
- Is migration exceptional (very high or very low for the season)?
- Does `rainImpactNote` exist? If so, this must be prominently mentioned — rain directly affects whether it's worth going out.
- Are there notable/rare species that override everything else?
- Is the overnight wind pattern creating a fallout opportunity (rain overnight + clearing at dawn)?
- Does the 5-day outlook show a much better day coming up soon? If so, say so.
- Is the season running significantly above or below historical average? That's meaningful context.
- Are the top hotspots showing strong 7-day activity, or is birding unusually slow?

The goal: write an email that a serious birder would find genuinely useful — not a slot-filled template, but an intelligent synthesis that highlights what actually matters today.

━━━ STEP 5 — WRITE THE EMAIL ━━━

Based on your reasoning in Step 4, write the email.

**For FULL_BRIEFING:**

Structure your email as inline-CSS HTML (mobile-friendly, max-width 600px, table-based layout, dark green `#1a3a2a` header). Include these sections, but adapt their content and emphasis based on what's actually interesting today:

1. **Executive summary** (3 bullets at top, fits email preview pane):
   - Migration intensity last night
   - Rain / weather impact on this morning's birding (if `rainImpactNote` is present, this is bullet 2)
   - Top notable species OR best upcoming day if today is poor

2. **Migration Last Night** — BirdCast birds aloft, isHigh flag, flight direction/speed if available, season total vs historical average with trend

3. **Weather & Birding Conditions** — Overnight wind, morning forecast, `migrationInterpretation`, and critically: if `rainImpactNote` is not null, include it prominently with practical advice (e.g., "Plan for a shorter window", "Check sheltered edges")

4. **Top Hotspots This Week** — The top 3–5 from aggregate data, showing 7-day species count. If a hotspot has recent notables, call them out. If `morningRainLikely` is true, add a note that conditions may suppress counts at open hotspots.

5. **Notable / Rare Sightings** — Only if `hasNotables` is true. List species, location, date. Highlight anything exceptional.

6. **5-Day Outlook** — Table of upcoming days. Call out the single best day explicitly. If today is poor (rain, north winds), tell the birder which day to target instead and why.

7. **Birding Window** — Civil twilight, sunrise, recommended arrival, activity cutoff.

Adjust emphasis freely. If rain dominates, lead with that. If a Kirtland's Warbler was just spotted, that's the lede. If the season is 40% above average and last night was HIGH, open with that excitement.

**For QUIET_PERIOD:**

Write a short, conversational 4–6 sentence email (no cards, no tables). Be specific — use the actual data:
- How many nights has migration been slow? What's the trend?
- Is there a reason (weather pattern, wind direction, early/late season)?
- What's the best upcoming day in the 5-day outlook, and why?
- Was there anything interesting recently despite the quiet period?
- When will you check back?

Avoid generic filler. "Migration has been light" is weak. "Migration has averaged 28,000 birds/night for the past 5 nights — well below the season average — with persistent NW winds blocking movement. Saturday looks much better with a SW wind shift." is good.

━━━ STEP 6 — SAVE THE DRAFT ━━━

Write the draft to `briefing-draft.json`:

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
node scripts/send.js briefing-draft.json
```

Read the RESULT line in the output.
- If "EMAIL SENT": output "Done. {RESULT line}" and stop.
- If "HTML SAVED": output "Done. Draft saved but not emailed — check Routine secrets." and stop.
- If it crashes: output the error and stop. Do not retry.

**If this was a QUIET_PERIOD send:** also call `update_scheduled_task` to reschedule this Routine to run again in +4 days from today.

━━━ RULES ━━━

- Do not read any files other than the JSON output of the scripts.
- Do not edit any source files.
- Do not retry a failed send — the email may have partially delivered.
- The triage script is the single source of truth for send/skip decisions. Do not second-guess the `recommendation` field.
- Your job in Steps 4–5 is to be a thoughtful editor, not a template filler. Use your reasoning to make the email genuinely useful.

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
| `node scripts/briefing.js` | Legacy template briefing | HTML email (kept for reference/fallback) |
