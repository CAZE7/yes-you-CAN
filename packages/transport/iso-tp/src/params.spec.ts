/**
 * ISO-TP parameter encoding (ISO 15765-2) — unit + property tests.
 */

import assert from 'node:assert/strict';
import fc from 'fast-check';
import { describe, test } from 'vitest';
import { DEFAULT_TIMING, encodeStMin, parseStMin } from './params.js';

describe('STmin encoding (ISO 15765-2 §9.4.5.4)', () => {
  test('the ms range is the identity', () => {
    for (let ms = 0; ms <= 0x7f; ms++) assert.equal(encodeStMin(ms), ms);
  });

  test('values above 127 ms clamp to the maximum', () => {
    assert.equal(encodeStMin(128), 0x7f);
    assert.equal(encodeStMin(10_000), 0x7f);
  });

  test('negative values clamp to zero', () => {
    assert.equal(encodeStMin(-1), 0);
  });

  test('property: parseStMin inverts encodeStMin on the ms domain', () => {
    fc.assert(
      fc.property(fc.nat({ max: 0x7f }), (ms) => {
        assert.equal(parseStMin(encodeStMin(ms)), ms);
      }),
    );
  });

  test('property: reserved bytes degrade to 127 ms (never to a busy 0)', () => {
    fc.assert(
      fc.property(fc.nat({ max: 255 }).filter((b) => b > 0x7f && (b < 0xf1 || b > 0xf9)), (reserved) => {
        assert.equal(parseStMin(reserved), 0x7f);
      }),
    );
  });
});

describe('default timing', () => {
  test('defaults are ISO-typical and overridable', () => {
    assert.equal(DEFAULT_TIMING.blockSize, 0);
    assert.equal(DEFAULT_TIMING.maxRetries, 0);
    assert.ok(DEFAULT_TIMING.nBsMs > 0);
  });
});
