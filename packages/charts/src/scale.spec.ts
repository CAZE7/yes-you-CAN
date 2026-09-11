/**
 * Axis mathematics: pure functions, exhaustive over their guard branches.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { computeYRange, formatClock, formatDuration, formatValue, niceStep, niceTicks, niceTimeTicks } from './scale.js';

describe('niceStep', () => {
  test('snaps to 1 / 2 / 2.5 / 5 / 10 multiples of the magnitude', () => {
    assert.equal(niceStep(0.9), 1);
    assert.equal(niceStep(1.2), 2);
    assert.equal(niceStep(2.1), 2.5);
    assert.equal(niceStep(3), 5);
    assert.equal(niceStep(7), 10);
    assert.equal(niceStep(120), 200, 'magnitudes cascade: 1.2·10² → 2·10²');
  });

  test('degenerate input collapses to 1', () => {
    assert.equal(niceStep(0), 1);
    assert.equal(niceStep(-5), 1);
    assert.equal(niceStep(Number.NaN), 1);
    assert.equal(niceStep(Number.POSITIVE_INFINITY), 1);
  });
});

describe('niceTicks', () => {
  test('both ends land on the grid when they fit', () => {
    assert.deepEqual(niceTicks(0, 10, 5), [0, 2, 4, 6, 8, 10], 'step 2 from rough 2');
  });

  test('no floating point noise in labels', () => {
    for (const tick of niceTicks(0, 1, 3)) {
      assert.equal(Number.isInteger(tick * 1000), true, `${tick} is grid-clean`);
    }
  });

  test('degenerate ranges return a single tick, never throw', () => {
    assert.deepEqual(niceTicks(5, 5), [5]);
    assert.deepEqual(niceTicks(7, 3), [7]);
    assert.deepEqual(niceTicks(Number.NaN, 10), [Number.NaN]);
  });
});

describe('computeYRange', () => {
  test('an empty series falls back to 0…1 plus padding', () => {
    const range = computeYRange([]);
    assert.ok(range.min < 0);
    assert.ok(range.max > 1);
  });

  test('a flat line is widened so it is visible', () => {
    const range = computeYRange([42, 42, 42]);
    assert.ok(range.min < 42 && range.max > 42);
  });

  test('definition limits win over observed data', () => {
    const range = computeYRange([10, 90], { min: 0, max: 100 });
    assert.ok(range.min <= 0 - 8 * 0.01, 'limit is included, padding goes beyond');
    assert.ok(range.max >= 100);
  });

  test('explicit limits also bound the fallback of an empty series', () => {
    const range = computeYRange([], { min: 5 });
    assert.ok(range.min <= 5);
    assert.ok(range.max > 5);
  });

  test('non-finite values are ignored, not propagated', () => {
    const range = computeYRange([Number.NaN, Infinity, -Infinity, 2, 8]);
    assert.ok(range.min < 2);
    assert.ok(range.max > 8);
  });
});

describe('formatValue', () => {
  test('missing values render as an em dash', () => {
    assert.equal(formatValue(null), '—');
    assert.equal(formatValue(undefined), '—');
    assert.equal(formatValue(Number.NaN), '—');
    assert.equal(formatValue(Infinity), '—');
  });

  test('magnitude decides the decimals', () => {
    assert.equal(formatValue(123456), '123.456');
    assert.equal(formatValue(1234.6), '1235', 'still the ≥100 branch, rounded');
    assert.equal(formatValue(123.4), '123');
    assert.equal(formatValue(42.75), '42.8');
    assert.equal(formatValue(3.14159), '3.14');
    assert.equal(formatValue(0), '0');
    assert.equal(formatValue(0.5), '0.500');
  });
});

describe('formatDuration', () => {
  test('sub-millisecond, milliseconds and seconds', () => {
    assert.equal(formatDuration(0.25), '0.25 ms');
    assert.equal(formatDuration(250), '250 ms');
    assert.equal(formatDuration(1500), '1.5 s', 'roundTo drops the trailing zero');
    assert.equal(formatDuration(15_000), '15 s');
  });

  test('minutes are mm:ss,d with a sign for negatives', () => {
    assert.equal(formatDuration(65_250), '1:05.3 min');
    assert.equal(formatDuration(-65_250), '-1:05.3 min');
  });
});

describe('formatClock', () => {
  test('mm:ss.mmm with sign and zero padding', () => {
    assert.equal(formatClock(65_250), '01:05.250');
    assert.equal(formatClock(0), '00:00.000');
    assert.equal(formatClock(-2_500), '-00:02.500');
  });
});

describe('niceTimeTicks', () => {
  test('bounded tick count for a time window', () => {
    const ticks = niceTimeTicks(0, 10_000, 6);
    assert.ok(ticks.length >= 5 && ticks.length <= 8);
    assert.equal(ticks[0], 0);
  });

  test('a non-advancing window yields a single tick', () => {
    assert.deepEqual(niceTimeTicks(5, 5), [5]);
    assert.deepEqual(niceTimeTicks(10, 2), [10]);
  });
});
