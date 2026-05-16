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

Copy everything between the START and END markers and paste into the Routine prompt field:

--- START ---

Run this command immediately. No exploration, no file reading first.

```bash
npm install --silent 2>/dev/null && node scripts/triage.js
```

Read the JSON output. Then follow exactly one of these three paths:

**If the JSON contains `"error"`:** output "Triage failed: {error}" and stop.

**If `isHigh` is true OR `notableCount > 0` OR `migrationScore >= 5`:** run:
```bash
node scripts/briefing.js
```
Then stop.

**If `migrationScore` is 2–4 with no notables:** run:
```bash
node scripts/briefing.js --quiet
```
Then call `update_scheduled_task` to reschedule this Routine +4 days. Then stop.

**If `migrationScore` < 2:** output "Skipping — migration quiet (score: {migrationScore})" and stop.

Do not read any files. Do not edit any files. Do not check for inconsistencies. Do not do anything else.

--- END ---
