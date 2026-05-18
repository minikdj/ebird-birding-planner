# Birding Planner

MCP server + daily / on-demand email briefing for migration monitoring.
Defaults to Cincinnati, configurable for any region.

**Full specification:** [SPEC.md](SPEC.md). **Tests:** [TESTING.md](TESTING.md).
**Email rendering rules:** [routine-prompt.md](routine-prompt.md).

## MCP Server Tools

All 11 tools, used interactively from Claude Desktop:

| Tool | What it does |
|------|-------------|
| `plan_birding_trip` | Ranks nearby hotspots by recent species count + migration activity |
| `migration_forecast` | BirdCast radar data + NWS weather interpretation |
| `hotspot_details` | Recent species and notable sightings at a single hotspot |
| `compare_hotspots` | Side-by-side species comparison with iNaturalist verification |
| `species_finder` | Where a species has been seen recently near a location |
| `best_day_to_bird` | Recommends the best day in a date range using migration + weather |
| `birding_weather` | NWS overnight/morning forecast interpreted for migration prediction |
| `verify_sighting` | Cross-references eBird reports against iNaturalist photo-verified obs |
| `birding_window` | Sunrise, civil twilight, and recommended arrival time |
| `species_frequency` | Historical peak week and current phenology status via BirdCast |
| `plan_vacation_birding` | Discovery report for a travel destination: target species, top hotspots, birding window. Works weeks or months ahead using historical bar-chart data. |

Per-tool details (inputs/outputs, edge cases) are in SPEC §3.5; each tool
lives in `src/handlers/<name>.js`.

## Setup

### 1. API keys

- **eBird API key** (required): https://ebird.org/api/keygen — free
- **BirdCast API key** (required): contact https://birdcast.info
- **Resend API key** (for email): https://resend.com — 3,000 emails/month free
- **Anthropic API key** (for on-demand briefing only): console.anthropic.com

### 2. Environment

```bash
cp .env.example .env   # then fill in keys
```

Every env var is documented in SPEC §6.2.

### 3. Install dependencies

```bash
npm install
```

`ajv` is required for schema validation; `sanitize-html` for email
delivery. Both ship in `package.json` dependencies — no extra steps.

### 4. Claude Desktop integration

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ebird-birding-planner": {
      "command": "node",
      "args": ["/absolute/path/to/ebird-birding-planner/src/index.js"],
      "env": {
        "EBIRD_API_KEY": "your_key_here",
        "BIRDCAST_API_KEY": "your_key_here",
        "EBIRD_LIFE_LIST_CSV": "/path/to/MyEBirdData.csv"
      }
    }
  }
}
```

## Daily briefing (Anthropic Routine)

Cloud-hosted scheduled agent — no machine needs to be on.

1. Routine runs at 09:00 UTC daily
2. `scripts/triage.js` outputs a JSON decision (FULL_BRIEFING /
   QUIET_PERIOD / SILENT_SKIP)
3. `scripts/aggregate.js` runs comprehensive data aggregation → single
   JSON blob (conforms to `schemas/aggregate-output.schema.json`)
4. Agent reads the JSON, writes the email body as HTML, saves to
   `./briefing-draft.json`
5. `scripts/send.js` delivers via Resend (SendGrid + disk fallbacks)

See `routine-prompt.md` for the exact prompt to paste into the Routine.
Required secrets: SPEC §6.2.

## On-demand reports (mobile)

Trigger an ad-hoc report from your iPhone via the home-screen web app
(`bird-report.html`). The page POSTs `workflow_dispatch` to
`.github/workflows/report-on-demand.yml`, which runs the same
triage → aggregate → generate-email → send pipeline with
`claude-sonnet-4-5` (Anthropic SDK, tool-use mode) writing the HTML.

The PAT stored in `localStorage` must be a **fine-grained** PAT scoped to
this repo only, Actions Read+Write. Classic PATs are not supported (see
SPEC §5.2). Workflow rate-capped at 20 dispatches per 24h.

## Local testing

```bash
npm run test:unit                                  # 171 unit tests, no keys
node scripts/test-regressions.js                   # ~30 security/contract tests
BRIEFING_TEST_FIXTURE=full_lifer npm run aggregate # offline fixture run
node scripts/aggregate.js | npm run validate:schema -- /dev/stdin
node scripts/triage.js                             # live triage (keys required)
```

Fixture scenarios: `full_lifer`, `full_rain`, `full_fallout`,
`quiet_period`, `silent_skip`. See TESTING.md.

## Architecture (post Wave 2C decomp)

```
src/
  index.js              entry: loadConfig + clients + startServer
  server.js             MCP stdio dispatch
  config.js             frozen env-var config object
  lifelist.js           JSON-cache-first life list loader
  migration-scoring.js  unified rateNight() + threshold loader
  utils.js              Cache, fetchWithRetry, resolveLocation, …
  handlers/             one file per MCP tool
    _shared.js          createContext(), InputError, helpers
    index.js            HANDLERS[] + TOOL_HANDLERS Map
    <tool>.js           { tool, handle } per tool
  *-client.js           6 external API wrappers (retry + timeout + redaction)

scripts/
  triage.js             fast decision (~10s)
  aggregate.js          comprehensive data (~25s, schema-validated)
  generate-email.js     on-demand: Anthropic tool-use → draft
  send.js               sanitize → Resend → SendGrid → disk; idempotency
  validate-schema.js    Ajv against schemas/aggregate-output.schema.json
  test-unit.js          171 tests
  test-regressions.js   ~30 security + contract invariants
  fixtures/             pre-baked triage / aggregate JSON

schemas/aggregate-output.schema.json   data contract (CI-gated)
.github/workflows/report-on-demand.yml on-demand pipeline
routine-prompt.md                       daily briefing prompt + design system
```

See SPEC.md for the full specification.
