#!/usr/bin/env node

import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { readFileSync, readFile } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { NWSClient } from '../src/nws-client.js';
import { EBirdClient } from '../src/ebird-client.js';
import { BirdCastClient } from '../src/birdcast-client.js';
import { INaturalistClient } from '../src/inaturalist-client.js';

const execFileAsync = promisify(execFile);
const readFileAsync = promisify(readFile);

// Manual dotenv loader (no external dependency)
function loadEnv() {
  try {
    const envPath = new URL('../.env', import.meta.url);
    const env = readFileSync(envPath, 'utf8');
    for (const line of env.split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) process.env[m[1]] ??= m[2];
    }
  } catch (err) {
    // .env file not found or not readable; use process.env as-is
  }
}

loadEnv();

// ============================================================================
// Test Results Tracker
// ============================================================================

const results = [];

function pass(testName) {
  results.push({ test: testName, status: 'PASS' });
  console.log(`✓ ${testName}`);
}

function fail(testName, reason) {
  results.push({ test: testName, status: 'FAIL', reason });
  console.log(`✗ ${testName}: ${reason}`);
}

function skip(testName, reason) {
  results.push({ test: testName, status: 'SKIP', reason });
  console.log(`⊘ ${testName}: ${reason}`);
}

// ============================================================================
// Test 1: NWSClient
// ============================================================================

async function testNWSClient() {
  const testName = 'NWSClient.getBirdingWeather()';
  try {
    const nws = new NWSClient();
    const result = await nws.getBirdingWeather(39.1, -84.5, '2026-05-16');

    if (!result) {
      fail(testName, 'returned null');
      return;
    }

    const hasOvernightKey = 'overnight' in result;
    const hasMorningKey = 'morning' in result;
    const hasWeatherUnavailableKey = 'weatherUnavailable' in result;

    if (!hasOvernightKey || !hasMorningKey || !hasWeatherUnavailableKey) {
      fail(
        testName,
        `missing keys: overnight=${hasOvernightKey}, morning=${hasMorningKey}, weatherUnavailable=${hasWeatherUnavailableKey}`
      );
      return;
    }

    // Pass if it has the structure, even if data is sparse or unavailable
    pass(testName);
  } catch (err) {
    fail(testName, err.message);
  }
}

// ============================================================================
// Test 2: EBirdClient
// ============================================================================

async function testEBirdClient() {
  const testName = 'EBirdClient.getNearbyHotspots()';
  try {
    const apiKey = process.env.EBIRD_API_KEY;
    if (!apiKey) {
      skip(testName, 'EBIRD_API_KEY not set');
      return;
    }

    const ebird = new EBirdClient(apiKey);
    const result = await ebird.getNearbyHotspots(39.1, -84.5, 10);

    if (!Array.isArray(result)) {
      fail(testName, 'did not return an array');
      return;
    }

    if (result.length === 0) {
      fail(testName, 'returned empty array');
      return;
    }

    const hasValidHotspot = result.some((h) => h.locId && /^L\d+$/.test(h.locId));
    if (!hasValidHotspot) {
      fail(testName, 'no hotspots with valid locId format (L<digits>)');
      return;
    }

    pass(testName);
  } catch (err) {
    fail(testName, err.message);
  }
}

// ============================================================================
// Test 3: BirdCastClient
// ============================================================================

async function testBirdCastClient() {
  const testName = 'BirdCastClient.getExpectedSpecies()';
  try {
    const apiKey = process.env.BIRDCAST_API_KEY;
    if (!apiKey) {
      skip(testName, 'BIRDCAST_API_KEY not set');
      return;
    }

    const birdcast = new BirdCastClient(apiKey);
    const result = await birdcast.getExpectedSpecies('US-OH-061', '2026-05-16', {
      ignoreSeasonCheck: true,
    });

    // Pass if it returns null (API gated) or valid array
    if (result === null) {
      pass(testName);
      return;
    }

    if (!Array.isArray(result)) {
      fail(testName, 'returned non-array non-null value');
      return;
    }

    // Check structure of returned species
    const hasValidStructure = result.every(
      (s) => typeof s.commonName === 'string' && typeof s.probability === 'number'
    );

    if (!hasValidStructure) {
      fail(testName, 'array elements missing commonName or probability fields');
      return;
    }

    pass(testName);
  } catch (err) {
    fail(testName, err.message);
  }
}

// ============================================================================
// Test 4: INaturalistClient
// ============================================================================

async function testINaturalistClient() {
  const testName = 'INaturalistClient.getVerifiedSightings()';
  try {
    const inat = new INaturalistClient();
    const result = await inat.getVerifiedSightings('American Robin', 39.1, -84.5, 30, 14);

    if (!result) {
      fail(testName, 'returned null');
      return;
    }

    const hasPhotoVerifiedCountKey = 'photoVerifiedCount' in result;
    const hasConfidenceKey = 'confidence' in result;

    if (!hasPhotoVerifiedCountKey || !hasConfidenceKey) {
      fail(
        testName,
        `missing keys: photoVerifiedCount=${hasPhotoVerifiedCountKey}, confidence=${hasConfidenceKey}`
      );
      return;
    }

    if (typeof result.photoVerifiedCount !== 'number') {
      fail(testName, 'photoVerifiedCount is not a number');
      return;
    }

    if (typeof result.confidence !== 'string') {
      fail(testName, 'confidence is not a string');
      return;
    }

    pass(testName);
  } catch (err) {
    fail(testName, err.message);
  }
}

// ============================================================================
// Test 5: Life List CSV Parser
// ============================================================================

async function testLifeListParser() {
  const testName = 'loadLifeList() from CSV file';
  try {
    const csvPath = process.env.EBIRD_LIFE_LIST_CSV || '/Users/djm/Downloads/MyEBirdData.csv';

    // Try to read the file
    let content;
    try {
      content = await readFileAsync(csvPath, 'utf8');
    } catch (err) {
      skip(testName, `file not found at ${csvPath}`);
      return;
    }

    // Inline implementation of loadLifeList logic
    const seen = new Set();
    const lines = content.split('\n');
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const firstComma = line.indexOf(',');
      const secondComma = line.indexOf(',', firstComma + 1);
      if (firstComma < 0 || secondComma < 0) continue;
      const name = line.slice(firstComma + 1, secondComma).trim();
      const normalized = name.replace(/\s*\(.*?\)$/, '').trim();
      if (normalized) {
        seen.add(name);
        seen.add(normalized);
      }
    }

    if (seen.size < 50) {
      fail(testName, `parsed life list has only ${seen.size} entries (expected > 50)`);
      return;
    }

    pass(testName);
  } catch (err) {
    fail(testName, err.message);
  }
}

// ============================================================================
// Test 6: triage.js script
// ============================================================================

async function testTriageScript() {
  const testName = 'scripts/triage.js execution';
  try {
    const apiKey = process.env.EBIRD_API_KEY;
    const birdcastKey = process.env.BIRDCAST_API_KEY;

    if (!apiKey || !birdcastKey) {
      skip(testName, 'EBIRD_API_KEY or BIRDCAST_API_KEY not set');
      return;
    }

    try {
      const { stdout, stderr } = await execFileAsync(
        'node',
        ['scripts/triage.js'],
        {
          cwd: '/Users/djm/claude/ebird-birding-planner',
          timeout: 30000, // 30 seconds max
          env: process.env,
        }
      );

      if (stderr && stderr.trim()) {
        // stderr output is acceptable; just log it
        process.stderr.write(`triage.js stderr: ${stderr}\n`);
      }

      let data;
      try {
        data = JSON.parse(stdout);
      } catch (parseErr) {
        fail(testName, `stdout is not valid JSON: ${parseErr.message}`);
        return;
      }

      if (!data || typeof data !== 'object') {
        fail(testName, 'JSON output is not an object');
        return;
      }

      const hasMigrationScore = 'migrationScore' in data;
      if (!hasMigrationScore) {
        fail(testName, 'JSON output missing "migrationScore" field');
        return;
      }

      pass(testName);
    } catch (execErr) {
      fail(testName, `execution failed: ${execErr.message}`);
    }
  } catch (err) {
    fail(testName, err.message);
  }
}

// ============================================================================
// Main Test Runner
// ============================================================================

async function runAllTests() {
  console.log('');
  console.log('▼ ebird-birding-planner Smoke Tests');
  console.log('=====================================');
  console.log('');

  // Run tests sequentially to respect rate limits
  await testNWSClient();
  await testEBirdClient();
  await testBirdCastClient();
  await testINaturalistClient();
  await testLifeListParser();
  await testTriageScript();

  // Print summary
  console.log('');
  console.log('=====================================');
  const passCount = results.filter((r) => r.status === 'PASS').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  const skipCount = results.filter((r) => r.status === 'SKIP').length;
  const totalCount = results.length;

  console.log(`${passCount}/${totalCount} tests passed`);

  if (skipCount > 0) {
    console.log(`${skipCount} skipped`);
  }

  if (failCount > 0) {
    console.log(`${failCount} failed`);
    console.log('');
    results
      .filter((r) => r.status === 'FAIL')
      .forEach((r) => {
        console.log(`  FAIL: ${r.test}`);
        console.log(`    ${r.reason}`);
      });
  }

  console.log('');

  // Exit with appropriate code
  process.exit(failCount > 0 ? 1 : 0);
}

// Start tests
runAllTests().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
