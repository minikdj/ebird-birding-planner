# Daily Birding Briefing Routine

Paste this prompt into claude.ai ▶ Routines ▶ New Routine.
Schedule: daily at 4:00 AM ET (8:00 AM UTC).
Secrets: see Setup section below.

---

## Setup

Configure these secrets in your Routine:

- `EBIRD_API_KEY` — eBird API key from https://ebird.org/api/keygen
- `BIRDCAST_API_KEY` — BirdCast API key from https://birdcast.info
- `RESEND_API_KEY` — Resend email API key from https://resend.com
- `BRIEFING_EMAIL_TO` — recipient email address
- `BRIEFING_REGION` — eBird region code (default: `US-OH-061` for Hamilton County)
- `BRIEFING_LAT` — latitude (default: `39.1`)
- `BRIEFING_LNG` — longitude (default: `-84.5`)

---

## Routine Prompt

Copy everything below this line and paste into the Routine prompt field:

```
Your ONLY job is to run two shell scripts and send a birding email. Do NOT explore the repo. Do NOT read or modify any files. Do NOT fix anything you notice. Just run the scripts in order.

You are a daily migration monitoring agent for Cincinnati, OH (Hamilton County, US-OH-061). You run at 4:00 AM ET.

STEP 1 — Season check (do this in your head, no tools needed):
If today is outside March 15–June 7 or August 1–November 15, output "Outside migration season — done." and stop immediately.

STEP 2 — Run triage (one bash command, nothing else):
```bash
npm install --silent 2>/dev/null && node scripts/triage.js
```
Read the JSON output. Note the `recommendation` field and `migrationScore`.

STEP 3 — Decide (use judgment, but the rules are clear):
- `isHigh` is true OR `notableCount` > 0 OR `migrationScore` >= 5 → FULL_BRIEFING
- `migrationScore` 2–4, no notables → QUIET_PERIOD
- `migrationScore` < 2 → SILENT_SKIP
- If triage output contains `"error"` → SILENT_SKIP, log the error

STEP 4 — Execute exactly one of these, then stop:

FULL_BRIEFING:
```bash
node scripts/briefing.js
```

QUIET_PERIOD:
```bash
node scripts/briefing.js --quiet
```
Then call update_scheduled_task to reschedule this Routine to run again in 4 days.

SILENT_SKIP:
Output "Skipping — quiet period (score: {score})" and stop.

That is everything. Do not do anything else.
```
