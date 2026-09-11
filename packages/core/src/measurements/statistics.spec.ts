/**
 * Measurement statistics — the single source of "the average of a signal"
 * (AGENTS 15/16). The recorder, storage and session comparison all consume
 * these numbers, so their edge cases are contract, not detail.
 */

import assert from 'node:assert/strict';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { MeasurementSample } from './types.js';
import { summarizeAllSamples, summarizeSamples } from './statistics.js';

function sample(signal: string, value: number | string | boolean, overrides: Partial<MeasurementSample> = {}): MeasurementSample {
  return {
    timestamp: '2026-09-11T08:00:00.000Z',
    t: 0,
    signal,
    value,
    rawValue: value,
    rawHex: '00',
    outOfRange: false,
    ...overrides,
  };
}

describe('summarizeSamples', () => {
  test('an empty list yields the explicit zero form', () => {
    const stats = summarizeSamples('engine.rpm', []);
    assert.deepEqual(stats, {
      signal: 'engine.rpm',
      name: 'engine.rpm',
      outOfRangeCount: 0,
      samples: 0,
      min: null,
      max: null,
      average: null,
      delta: null,
      first: null,
      last: null,
    });
  });

  test('non-numeric and non-finite samples are excluded from the math but not hidden', () => {
    const stats = summarizeSamples('mix', [
      sample('mix', 10),
      sample('mix', 'OPEN'),
      sample('mix', true),
      sample('mix', Number.NaN),
      sample('mix', Number.POSITIVE_INFINITY),
      sample('mix', 20, { outOfRange: true }),
    ]);
    assert.equal(stats.samples, 2);
    assert.equal(stats.min, 10);
    assert.equal(stats.max, 20);
    assert.equal(stats.average, 15);
    assert.equal(stats.outOfRangeCount, 1);
  });

  test('first and last preserve the sample order, delta is max - min', () => {
    const stats = summarizeSamples('t', [sample('t', 5), sample('t', 1), sample('t', 9)]);
    assert.equal(stats.first, 5);
    assert.equal(stats.last, 9);
    assert.equal(stats.delta, 8);
  });

  test('unit comes from the samples, falling back to the provided unit map', () => {
    assert.equal(summarizeSamples('s', [sample('s', 1, { unit: 'rpm' })]).unit, 'rpm');
    assert.equal(summarizeSamples('s', [sample('s', 1)], { units: new Map([['s', '°C']]) }).unit, '°C');
    assert.equal(summarizeSamples('s', [sample('s', 1)]).unit, undefined);
  });

  test('property: min ≤ average ≤ max and the average is the arithmetic mean', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -1000, max: 1000 }), { minLength: 1, maxLength: 200 }), (values) => {
        const stats = summarizeSamples('p', values.map((v) => sample('p', v)));
        assert.equal(stats.samples, values.length);
        assert.ok((stats.min as number) <= (stats.average as number));
        assert.ok((stats.average as number) <= (stats.max as number));
        const expected = values.reduce((a, b) => a + b, 0) / values.length;
        assert.ok(Math.abs((stats.average as number) - expected) < 1e-9);
      }),
    );
  });
});

describe('summarizeAllSamples', () => {
  test('groups mixed samples per signal in first-appearance order', () => {
    const stats = summarizeAllSamples([
      sample('a', 1),
      sample('b', 2),
      sample('a', 3),
    ]);
    assert.deepEqual(
      stats.map((entry) => entry.signal),
      ['a', 'b'],
    );
    assert.equal(stats[0]?.samples, 2);
    assert.equal(stats[0]?.average, 2);
  });

  test('names/units maps label the output for the UI', () => {
    const stats = summarizeAllSamples([sample('engine.ct', 90)], {
      names: new Map([['engine.ct', 'Coolant temperature']]),
      units: new Map([['engine.ct', '°C']]),
    });
    assert.equal(stats[0]?.name, 'Coolant temperature');
    assert.equal(stats[0]?.unit, '°C');
  });
});
