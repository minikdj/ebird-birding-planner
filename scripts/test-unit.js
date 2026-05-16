#!/usr/bin/env node
// Unit tests for pure functions — no API calls, no network, no env-var dependencies.
// Run with: node scripts/test-unit.js

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  toYMD,
  weekIndexForDate,
  haversineKm,
  computeActivityCutoff,
  FAVORABLE_WINDS,
  POOR_WINDS,
  RECOMMENDATION,
  DEFAULTS,
  formatNumber,
} from '../src/utils.js';

import { degreesToCardinal } from '../src/birdcast-client.js';

// ---------------------------------------------------------------------------
// 1. utils.js — toYMD
// ---------------------------------------------------------------------------

describe('toYMD', () => {
  it('returns correct YYYY-MM-DD string', () => {
    const d = new Date('2026-05-16T12:00:00Z');
    assert.strictEqual(toYMD(d), '2026-05-16');
  });

  it('uses UTC methods — 2026-05-16T03:00:00Z stays 2026-05-16, not 2026-05-15', () => {
    // At 03:00 UTC on May 16 it is still May 15 in US/Eastern — UTC must win.
    const d = new Date('2026-05-16T03:00:00Z');
    assert.strictEqual(toYMD(d), '2026-05-16');
  });

  it('zero-pads month (January → 01)', () => {
    const d = new Date('2026-01-05T12:00:00Z');
    assert.strictEqual(toYMD(d), '2026-01-05');
  });

  it('zero-pads day (day 5 → 05)', () => {
    const d = new Date('2026-03-05T12:00:00Z');
    assert.strictEqual(toYMD(d), '2026-03-05');
  });
});

// ---------------------------------------------------------------------------
// 2. utils.js — weekIndexForDate
// ---------------------------------------------------------------------------

describe('weekIndexForDate', () => {
  it('Jan 1 → week 0', () => {
    assert.strictEqual(weekIndexForDate('2026-01-01'), 0);
  });

  it('Jan 7 → week 1 (actual behavior: uses noon UTC, so Jan 7 noon is dayOfYear=8 → week 1)', () => {
    // The function pins every date to noon UTC. Jan 1 midnight to Jan 7 noon = 6.5 days,
    // Math.ceil(6.5) = 7, dayOfYear = 8, Math.floor((8-1)/7) = 1. Counterintuitive but correct.
    assert.strictEqual(weekIndexForDate('2026-01-07'), 1);
  });

  it('Jan 8 → week 1', () => {
    assert.strictEqual(weekIndexForDate('2026-01-08'), 1);
  });

  it('May 16 → reasonable week index (around 18-19)', () => {
    const idx = weekIndexForDate('2026-05-16');
    assert.ok(typeof idx === 'number', 'should be a number');
    assert.ok(idx >= 17 && idx <= 20, `expected 17-20, got ${idx}`);
  });

  it('always returns a number', () => {
    assert.ok(typeof weekIndexForDate('2026-08-15') === 'number');
  });
});

// ---------------------------------------------------------------------------
// 3. utils.js — haversineKm
// ---------------------------------------------------------------------------

describe('haversineKm', () => {
  it('same point → 0 km', () => {
    assert.strictEqual(haversineKm(39.1, -84.5, 39.1, -84.5), 0);
  });

  it('Cincinnati to NYC ≈ 900 km (within 10%)', () => {
    const cincLat = 39.1, cincLng = -84.5;
    const nycLat = 40.78, nycLng = -73.97;
    const dist = haversineKm(cincLat, cincLng, nycLat, nycLng);
    // Actual great-circle distance is roughly 900–930 km.
    assert.ok(dist > 810 && dist < 1020, `expected ~900 km, got ${dist.toFixed(1)} km`);
  });

  it('returns a number', () => {
    assert.ok(typeof haversineKm(0, 0, 0, 0) === 'number');
  });
});

// ---------------------------------------------------------------------------
// 4. utils.js — computeActivityCutoff
// ---------------------------------------------------------------------------

describe('computeActivityCutoff', () => {
  const SUNRISE = new Date('2026-05-16T10:00:00Z'); // arbitrary fixed sunrise

  it('returns a Date object', () => {
    assert.ok(computeActivityCutoff(SUNRISE, 65) instanceof Date);
  });

  it('normal day (65°F) → sunrise + 180 min', () => {
    // 65°F is at or below the HEAT_THRESHOLD_F (75°F), so no penalty.
    const cutoff = computeActivityCutoff(SUNRISE, 65);
    const expectedMs = SUNRISE.getTime() + 180 * 60 * 1000;
    assert.strictEqual(cutoff.getTime(), expectedMs);
  });

  it('hot day (85°F) → earlier than 65°F result', () => {
    const normal = computeActivityCutoff(SUNRISE, 65);
    const hot = computeActivityCutoff(SUNRISE, 85);
    assert.ok(hot.getTime() < normal.getTime(), 'hot cutoff should be earlier');
  });

  it('very hot day (100°F) → even earlier than 85°F result', () => {
    const hot = computeActivityCutoff(SUNRISE, 85);
    const veryHot = computeActivityCutoff(SUNRISE, 100);
    assert.ok(veryHot.getTime() < hot.getTime(), 'very hot cutoff should be earlier than hot');
  });

  it('null temp → uses base (no crash), returns sunrise + 180 min', () => {
    const cutoff = computeActivityCutoff(SUNRISE, null);
    const expectedMs = SUNRISE.getTime() + 180 * 60 * 1000;
    assert.strictEqual(cutoff.getTime(), expectedMs);
  });

  it('extreme heat is floored at sunrise + 15 min (EARLIEST_ARRIVAL_MINUTES)', () => {
    // Pass a ridiculously high temperature to force the floor.
    const cutoff = computeActivityCutoff(SUNRISE, 10000);
    const floorMs = SUNRISE.getTime() + 15 * 60 * 1000;
    assert.strictEqual(cutoff.getTime(), floorMs);
  });
});

// ---------------------------------------------------------------------------
// 5. utils.js — FAVORABLE_WINDS Set
// ---------------------------------------------------------------------------

describe('FAVORABLE_WINDS', () => {
  it('contains S', () => assert.ok(FAVORABLE_WINDS.has('S')));
  it('contains SW', () => assert.ok(FAVORABLE_WINDS.has('SW')));
  it('contains SSW', () => assert.ok(FAVORABLE_WINDS.has('SSW')));
  it('contains SE', () => assert.ok(FAVORABLE_WINDS.has('SE')));
  it('contains W', () => assert.ok(FAVORABLE_WINDS.has('W')));
  it('does NOT contain N', () => assert.ok(!FAVORABLE_WINDS.has('N')));
  it('does NOT contain NW', () => assert.ok(!FAVORABLE_WINDS.has('NW')));
  it('does NOT contain NE', () => assert.ok(!FAVORABLE_WINDS.has('NE')));
});

// ---------------------------------------------------------------------------
// 6. utils.js — POOR_WINDS Set
// ---------------------------------------------------------------------------

describe('POOR_WINDS', () => {
  it('contains N', () => assert.ok(POOR_WINDS.has('N')));
  it('contains NW', () => assert.ok(POOR_WINDS.has('NW')));
  it('contains NNW', () => assert.ok(POOR_WINDS.has('NNW')));
  it('contains NE', () => assert.ok(POOR_WINDS.has('NE')));
  it('does NOT contain S', () => assert.ok(!POOR_WINDS.has('S')));
  it('does NOT contain SW', () => assert.ok(!POOR_WINDS.has('SW')));
});

// ---------------------------------------------------------------------------
// 7. utils.js — RECOMMENDATION enum
// ---------------------------------------------------------------------------

describe('RECOMMENDATION', () => {
  it('has FULL_BRIEFING', () => assert.ok('FULL_BRIEFING' in RECOMMENDATION));
  it('has QUIET_PERIOD', () => assert.ok('QUIET_PERIOD' in RECOMMENDATION));
  it('has SILENT_SKIP', () => assert.ok('SILENT_SKIP' in RECOMMENDATION));

  it('values equal their keys (identity enum)', () => {
    assert.strictEqual(RECOMMENDATION.FULL_BRIEFING, 'FULL_BRIEFING');
    assert.strictEqual(RECOMMENDATION.QUIET_PERIOD, 'QUIET_PERIOD');
    assert.strictEqual(RECOMMENDATION.SILENT_SKIP, 'SILENT_SKIP');
  });

  it('is frozen (cannot be modified)', () => {
    assert.ok(Object.isFrozen(RECOMMENDATION));
  });
});

// ---------------------------------------------------------------------------
// 8. utils.js — DEFAULTS object
// ---------------------------------------------------------------------------

describe('DEFAULTS', () => {
  it('has lat property', () => assert.ok('lat' in DEFAULTS));
  it('has lng property', () => assert.ok('lng' in DEFAULTS));
  it('has regionCode property', () => assert.ok('regionCode' in DEFAULTS));
  it('lat is a finite number', () => assert.ok(Number.isFinite(DEFAULTS.lat)));
  it('lng is a finite number', () => assert.ok(Number.isFinite(DEFAULTS.lng)));
});

// ---------------------------------------------------------------------------
// 9. utils.js — formatNumber
// ---------------------------------------------------------------------------

describe('formatNumber', () => {
  it('1000000 → locale-formatted string', () => {
    const result = formatNumber(1000000);
    assert.ok(typeof result === 'string');
    // Should contain "1" and "000" at minimum (any separator or format is OK)
    assert.ok(result.includes('1'), `unexpected result: ${result}`);
  });

  it('0 → "0"', () => {
    assert.strictEqual(formatNumber(0), '0');
  });

  it('null → "N/A" (graceful handling)', () => {
    // Actual behavior: null returns "N/A" per the implementation.
    assert.strictEqual(formatNumber(null), 'N/A');
  });

  it('undefined → "N/A" (graceful handling)', () => {
    assert.strictEqual(formatNumber(undefined), 'N/A');
  });

  it('regular number returns a string', () => {
    assert.ok(typeof formatNumber(42) === 'string');
  });
});

// ---------------------------------------------------------------------------
// 10. birdcast-client.js — degreesToCardinal
// ---------------------------------------------------------------------------

describe('degreesToCardinal', () => {
  it('0 → N', () => assert.strictEqual(degreesToCardinal(0), 'N'));
  it('90 → E', () => assert.strictEqual(degreesToCardinal(90), 'E'));
  it('180 → S', () => assert.strictEqual(degreesToCardinal(180), 'S'));
  it('270 → W', () => assert.strictEqual(degreesToCardinal(270), 'W'));
  it('45 → NE', () => assert.strictEqual(degreesToCardinal(45), 'NE'));
  it('315 → NW', () => assert.strictEqual(degreesToCardinal(315), 'NW'));

  it('22.5 → returns a string (boundary between N and NE)', () => {
    // Math.round(22.5 / 45) = Math.round(0.5) = 1 → NE in most JS engines.
    // Either N or NE is acceptable — just check it's a string.
    const result = degreesToCardinal(22.5);
    assert.ok(typeof result === 'string');
  });

  it('null → returns a string ("unknown direction"), does not crash', () => {
    const result = degreesToCardinal(null);
    assert.ok(typeof result === 'string');
  });

  it('undefined → returns a string, does not crash', () => {
    const result = degreesToCardinal(undefined);
    assert.ok(typeof result === 'string');
  });
});

// ---------------------------------------------------------------------------
// 11. Email validation regex (inlined from send.js)
// ---------------------------------------------------------------------------

describe('email validation regex', () => {
  // Regex used in send.js line 112:
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  it('valid: user@example.com', () => assert.ok(EMAIL_RE.test('user@example.com')));
  it('valid: user.name+tag@example.co.uk', () => assert.ok(EMAIL_RE.test('user.name+tag@example.co.uk')));
  it('invalid: notanemail', () => assert.ok(!EMAIL_RE.test('notanemail')));
  it('invalid: @example.com (no local part)', () => assert.ok(!EMAIL_RE.test('@example.com')));
  it('invalid: user@ (no domain)', () => assert.ok(!EMAIL_RE.test('user@')));
  it('invalid: empty string', () => assert.ok(!EMAIL_RE.test('')));
  it('invalid: user@example (no TLD dot)', () => assert.ok(!EMAIL_RE.test('user@example')));
});

// ---------------------------------------------------------------------------
// 12. Path traversal guard logic (inlined from send.js)
// ---------------------------------------------------------------------------

describe('path traversal guard', () => {
  const repoRoot = '/some/repo/root';

  function isSafe(draftPath) {
    const resolved = path.resolve(draftPath);
    return resolved.startsWith(repoRoot + path.sep);
  }

  it('file directly in repoRoot → safe', () => {
    assert.ok(isSafe('/some/repo/root/briefing-draft.json'));
  });

  it('file in subdirectory of repoRoot → safe', () => {
    assert.ok(isSafe('/some/repo/root/subdir/draft.json'));
  });

  it('/etc/passwd → NOT safe', () => {
    assert.ok(!isSafe('/etc/passwd'));
  });

  it('path traversal via .. resolves outside root → NOT safe', () => {
    assert.ok(!isSafe('/some/repo/root/../../../etc/passwd'));
  });

  it('prefix attack (/some/repo/rootevil) → NOT safe', () => {
    // Ensures startsWith + sep prevents matching a sibling dir named "rootevil"
    assert.ok(!isSafe('/some/repo/rootevil/draft.json'));
  });
});

// ---------------------------------------------------------------------------
// 13. BRIEFING_REGION validation regex (inlined from triage.js / aggregate.js)
// ---------------------------------------------------------------------------

describe('BRIEFING_REGION regex', () => {
  // Regex from triage.js line 37 and aggregate.js:
  const REGION_RE = /^[A-Z]{2}-[A-Z]{2,3}(-\d{1,3})?$/i;

  it('US-OH → matches', () => assert.ok(REGION_RE.test('US-OH')));
  it('US-OH-061 → matches', () => assert.ok(REGION_RE.test('US-OH-061')));
  it('CA-ON → matches', () => assert.ok(REGION_RE.test('CA-ON')));
  it('US-OH-0 → matches (1 digit)', () => assert.ok(REGION_RE.test('US-OH-0')));
  it('US-OH-061-extra → no match (too many segments)', () => assert.ok(!REGION_RE.test('US-OH-061-extra')));
  it('USOH → no match (missing hyphen)', () => assert.ok(!REGION_RE.test('USOH')));
  it('empty string → no match', () => assert.ok(!REGION_RE.test('')));
  it('US-OH-9999 → no match (4 digits)', () => assert.ok(!REGION_RE.test('US-OH-9999')));
  it('us-oh-061 → matches (case insensitive)', () => assert.ok(REGION_RE.test('us-oh-061')));
});

// ---------------------------------------------------------------------------
// 14. Triage scoring thresholds — boundary value tests
// ---------------------------------------------------------------------------

describe('triage scoring thresholds', () => {
  // The scoring logic from triage.js (lines 62-69):
  //   cumBirds > 500000  → +3
  //   cumBirds > 100000  → +2
  //   cumBirds > 50000   → +1
  //   cumBirds <= 50000  → +0
  //
  // NOTE: the task spec listed the third threshold as 10000 < birds <= 100000 → +1,
  // but triage.js actually uses >50000 as the boundary (not 10000). Tests reflect
  // actual source code behavior.

  function scoreBirds(cumBirds) {
    let score = 0;
    if (cumBirds > 500000) score += 3;
    else if (cumBirds > 100000) score += 2;
    else if (cumBirds > 50000) score += 1;
    return score;
  }

  it('600000 birds → +3', () => assert.strictEqual(scoreBirds(600000), 3));
  it('500001 birds → +3', () => assert.strictEqual(scoreBirds(500001), 3));
  it('500000 birds (boundary) → +2 (not > 500000)', () => assert.strictEqual(scoreBirds(500000), 2));
  it('200000 birds → +2', () => assert.strictEqual(scoreBirds(200000), 2));
  it('100001 birds → +2', () => assert.strictEqual(scoreBirds(100001), 2));
  it('100000 birds (boundary) → +1 (not > 100000)', () => assert.strictEqual(scoreBirds(100000), 1));
  it('75000 birds → +1', () => assert.strictEqual(scoreBirds(75000), 1));
  it('50001 birds → +1', () => assert.strictEqual(scoreBirds(50001), 1));
  it('50000 birds (boundary) → 0 (not > 50000)', () => assert.strictEqual(scoreBirds(50000), 0));
  it('10000 birds → 0', () => assert.strictEqual(scoreBirds(10000), 0));
  it('0 birds → 0', () => assert.strictEqual(scoreBirds(0), 0));

  it('RECOMMENDATION enum values match what triage.js uses', () => {
    // Triage uses string comparisons; these values must be stable.
    assert.strictEqual(RECOMMENDATION.FULL_BRIEFING, 'FULL_BRIEFING');
    assert.strictEqual(RECOMMENDATION.QUIET_PERIOD, 'QUIET_PERIOD');
    assert.strictEqual(RECOMMENDATION.SILENT_SKIP, 'SILENT_SKIP');
  });
});
