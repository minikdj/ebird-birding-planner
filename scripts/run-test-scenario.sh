#!/usr/bin/env bash
# run-test-scenario.sh — Run the daily briefing pipeline with a fixture scenario.
#
# Usage:
#   scripts/run-test-scenario.sh full_lifer     # High migration, CT Warbler lifer
#   scripts/run-test-scenario.sh full_rain      # Good migration, morning rain
#   scripts/run-test-scenario.sh full_fallout   # Fallout event, urgent
#   scripts/run-test-scenario.sh quiet_period   # Low migration, short email
#   scripts/run-test-scenario.sh silent_skip    # Dead night, no email
#
# What it does:
#   1. Runs triage.js with fixture data (no API keys needed)
#   2. If FULL_BRIEFING or QUIET_PERIOD, runs aggregate.js with fixture data
#   3. Saves combined output to /tmp/test-<scenario>-triage.json and /tmp/test-<scenario>-aggregate.json
#
# The Routine agent (when you spawn it) should be told to run commands with
# BRIEFING_TEST_FIXTURE=<scenario> prepended.

set -euo pipefail

SCENARIO="${1:-full_lifer}"
VALID="full_lifer full_rain full_fallout quiet_period silent_skip"

if ! echo "$VALID" | grep -qw "$SCENARIO"; then
  echo "Error: unknown scenario '$SCENARIO'"
  echo "Valid scenarios: $VALID"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "=== TEST SCENARIO: $SCENARIO ==="
echo ""

# Step 1: Triage
echo "--- triage.js output ---"
TRIAGE_OUTPUT=$(BRIEFING_TEST_FIXTURE="$SCENARIO" node scripts/triage.js)
echo "$TRIAGE_OUTPUT" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log('  recommendation:', d.recommendation); console.log('  migrationScore:', d.migrationScore); console.log('  notableSpecies:', JSON.stringify(d.notableSpecies));"
echo "$TRIAGE_OUTPUT" > "/tmp/test-${SCENARIO}-triage.json"
echo "  [saved to /tmp/test-${SCENARIO}-triage.json]"
echo ""

# Extract recommendation
RECOMMENDATION=$(echo "$TRIAGE_OUTPUT" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).recommendation || 'ERROR')")

if [ "$RECOMMENDATION" = "SILENT_SKIP" ]; then
  echo "SILENT_SKIP — no email generated (correct behavior)"
  exit 0
fi

if [ "$RECOMMENDATION" = "FULL_BRIEFING" ] || [ "$RECOMMENDATION" = "QUIET_PERIOD" ]; then
  echo "--- aggregate.js output ---"
  AGG_OUTPUT=$(BRIEFING_TEST_FIXTURE="$SCENARIO" node scripts/aggregate.js 2>/dev/null)
  echo "$AGG_OUTPUT" | node -e "
const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
console.log('  notableObservations:', d.notableObservations?.length ?? 0);
console.log('  liferOpportunities:', d.flags?.liferOpportunities ?? 0);
console.log('  frontalPassage:', d.flags?.frontalPassage ?? false);
console.log('  falloutPotential:', d.flags?.falloutPotential ?? false);
console.log('  morningRain:', d.flags?.morningRainLikely ?? false);
console.log('  listservSightings:', d.listservSightings?.length ?? 0);
"
  echo "$AGG_OUTPUT" > "/tmp/test-${SCENARIO}-aggregate.json"
  echo "  [saved to /tmp/test-${SCENARIO}-aggregate.json]"
fi

echo ""
echo "=== Ready to spawn Routine agent for scenario: $SCENARIO ==="
echo "The agent should run commands as:"
echo "  BRIEFING_TEST_FIXTURE=$SCENARIO node scripts/triage.js"
echo "  BRIEFING_TEST_FIXTURE=$SCENARIO node scripts/aggregate.js"
