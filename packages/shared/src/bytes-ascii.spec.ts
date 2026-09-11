/**
 * ascii()/asciiBytes() helpers: NUL termination, padding and lossy encoding.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { ascii, asciiBytes } from './bytes.js';

describe('ascii', () => {
  test('decodes until NUL and trims whitespace padding', () => {
    assert.equal(ascii(new Uint8Array([0x57, 0x56, 0x57, 0x00, 0x58])), 'WVW');
    assert.equal(ascii(new Uint8Array([0x20, 0x41, 0x42, 0x20, 0x20])), 'AB');
  });
});

describe('asciiBytes', () => {
  test('encodes and pads with spaces to the requested length', () => {
    assert.deepEqual(Array.from(asciiBytes('VIN17', 8)), [0x56, 0x49, 0x4e, 0x31, 0x37, 0x20, 0x20, 0x20]);
  });

  test('out-of-range characters are truncated to one byte', () => {
    assert.deepEqual(Array.from(asciiBytes('\xe9')), [0xe9]);
  });

  test('positions past the end of the string pad with spaces, not NaN', () => {
    assert.deepEqual(Array.from(asciiBytes('A', 3)), [0x41, 0x20, 0x20]);
  });
});
