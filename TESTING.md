# Testing

Practical guide to running the test suites and reproducing pipeline
behavior offline. Spec contracts and security invariants are in
[SPEC.md](SPEC.md); this file documents how to verify them.

## Test suites

| Suite | Command | Count | Network? |
|---|---|---|---|
| Unit | `npm run test:unit` | 171 | No |
| Regression (security + contracts) | `node scripts/test-regressions.js` | ~30 | No |
| Schema | `npm run validate:schema -- <file>` | per-file | No |
| Integration smoke | `node scripts/test.js` | 6 | Yes (keys required) |

All four are runnable from the repo root.

### Unit (`scripts/test-unit.js`)

No API keys required. Pure-logic coverage:

- `utils.js`: `toYMD`, `weekIndexForDate`, `haversineKm`,
  `computeActivityCutoff`, `FAVORABLE_WINDS`, `POOR_WINDS`,
  `RECOMMENDATION`, `DEFAULTS`, `formatNumber`, `degreesToCardinal`,
  email regex, path traversal guard, `BRIEFING_REGION` regex.
- `migration-scoring.js`: triage threshold tiers and clamping.
- `aggregate.js` helpers: moon phase mapping, wind shift detection,
  clearing detection, fallout potential, lifer detection, parenthetical
  stripping.
- Degraded modes: BirdCast skipped, NWS unavailable, life list empty.
- Tool-input edge cases: vacation destination normalization,
  verify_sighting iNat interpretation.

Run:

```bash
npm run test:unit
```

Add a test by appending another `describe(...)` block — `node:test` is
the runner; no separate test file convention.

### Regression (`scripts/test-regressions.js`)

No API keys required. Pinned to security and data-contract invariants
from SPEC §5.3. Each test corresponds to one invariant (I1–I15). When a
test is named like `"BirdCast key redacted in error log"`, find the
matching invariant row in SPEC §5.3.

Run:

```bash
node scripts/test-regressions.js
```

These exist to catch regressions in defensively-coded edges that unit
tests don't naturally exercise (sanitization, fencing, idempotency,
path containment, tool-use enforcement, npm flags).

### Schema (`scripts/validate-schema.js`)

Validates `aggregate-output.json` (or any file matching that shape)
against `schemas/aggregate-output.schema.json` using Ajv (draft-07,
`strict: false`).

Run against a file:

```bash
npm run validate:schema -- aggregate-output.json
```

Or pipe from `aggregate.js`:

```bash
node scripts/aggregate.js | node scripts/validate-schema.js
```

CI enforces this on every on-demand workflow run (the "Validate
aggregate schema" step in `.github/workflows/report-on-demand.yml`).
Schema changes that aren't reflected in `aggregate.js` (or vice versa)
break the workflow at PR time.

### Integration smoke (`scripts/test.js`)

Requires live API keys. Slow. Not in CI. Run when you suspect upstream
API drift or before tagging a release.

```bash
node scripts/test.js
```

Verifies one happy-path call against each external API (eBird,
BirdCast, NWS, iNaturalist, Macaulay photos + audio, life-list CSV,
plus a triage subprocess).

## Fixture mode

Set `BRIEFING_TEST_FIXTURE=<scenario>` to bypass every API call in
`triage.js` and `aggregate.js`. The scripts emit pre-baked JSON from
`scripts/fixtures/`.

Scenarios:

| Name | Use for |
|---|---|
| `full_lifer` | FULL_BRIEFING with a lifer present — covers the headline path |
| `full_rain` | FULL_BRIEFING with morning rain — checks the rain-impact note |
| `full_fallout` | FULL_BRIEFING with overnight rain → dawn clearing |
| `quiet_period` | QUIET_PERIOD (low score, no notables) |
| `silent_skip` | SILENT_SKIP (triage only — aggregate is never called on SILENT_SKIP) |

End-to-end offline run:

```bash
export BRIEFING_TEST_FIXTURE=full_lifer
node scripts/triage.js > triage-output.json
node scripts/aggregate.js > aggregate-output.json
node scripts/validate-schema.js aggregate-output.json
ANTHROPIC_API_KEY=sk-... node scripts/generate-email.js  # only step that hits an API
node scripts/send.js briefing-draft.json                  # disk fallback if no Resend key
```

Adding a fixture: capture a real `aggregate-output.json` from a
relevant run, scrub PII (recipient emails, exact home coordinates if
sensitive), save as `aggregate-<scenario>.json`, and hand-craft a
matching `triage-<scenario>.json`. The fixture short-circuit in
`aggregate.js` still applies the security pipeline (strips
`listservSightings[].body`, injects `sourceStatus` if absent) so
fixtures and live data obey the same contracts.

## Manual end-to-end checks

### Daily briefing (Routine)

1. claude.ai → Routines → Daily Birding Briefing → "Run now"
2. Watch the execution log for `triage.js` → `aggregate.js` → write
   draft → `send.js`
3. Email arrives in `BRIEFING_EMAIL_TO` inbox within ~2 minutes

### On-demand briefing (GHA)

1. Open `bird-report.html` on iPhone home screen
2. Trigger with a location
3. GHA run completes in <90s; email arrives shortly after

Or trigger from the gh CLI:

```bash
gh workflow run report-on-demand.yml \
  -f location="Cape May, NJ" -f region="US-NJ-009" \
  -f lat="38.93" -f lng="-74.96" -f focus="warblers"
gh run watch
```

### MCP tools (Claude Desktop)

1. Restart Claude Desktop to reload the MCP server after any `src/`
   change
2. Ask each tool conversationally, e.g.:
   - `plan_birding_trip`: "Plan a birding trip for this weekend in
     Cincinnati"
   - `migration_forecast`: "What does BirdCast say about tonight?"
   - `plan_vacation_birding`: "I'm going to Cape May May 20–25 — what
     should I look for?"
3. Verify the JSON returned matches the handler's documented shape
   (see `src/handlers/<name>.js`).

### Email preview (no APIs)

```bash
node scripts/preview-notable-sightings.mjs
open /tmp/notable-preview.html
```

Renders the Notable Sightings layout at 360 / 600 / 800 px with
realistic sample data (long hyphenated names, missing photo, missing
recording, missing speciesCode). Use this to verify any prompt or
markup change before re-pasting into the Routine.

### Send via disk fallback (no email keys)

```bash
echo '{"subject":"Test","htmlBody":"<p>Hello</p>"}' > /tmp/draft.json
node scripts/send.js /tmp/draft.json
# → RESULT: HTML SAVED to briefing-output/briefing-YYYY-MM-DD.html
```

### Force re-send (bypass idempotency marker)

```bash
BRIEFING_FORCE_SEND=true node scripts/send.js briefing-draft.json
```

Or delete `briefing-output/.sent-<YMD>.marker` for the target date.

## CI

`.github/workflows/report-on-demand.yml` runs on every dispatch. It
checks out the repo, rate-caps to 20 dispatches/24h, validates
workflow inputs by regex, installs deps with `npm ci --ignore-scripts`,
runs triage + aggregate, runs `validate-schema.js` against the aggregate
output, generates the email via the Anthropic API, and sends it. A
schema-drift bug fails the run at the validate step before any model
spend is incurred.

There is no scheduled CI for the unit / regression suites today —
running them locally before pushing is the practice. Adding a
`pull_request`-triggered workflow that runs `npm run test:unit` and
`node scripts/test-regressions.js` is a small future improvement (see
SPEC §6.6 "Failure modes" — schema drift is the only currently-gated
check).
