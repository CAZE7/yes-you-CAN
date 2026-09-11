import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  decodeDtc,
  decodeDtcStatus,
  dtcSeverity,
  encodeDtc,
  encodeDtcStatus,
  encodeDtcToBytes,
  decodeDtcBytes,
} from './dtc.js';

test('P0420 decodes into letter, digits and failure type', () => {
  const decoded = decodeDtc(0x04, 0x20, 0x00);
  assert.equal(decoded.code, 'P0420');
  assert.equal(decoded.letter, 'P');
  assert.equal(decoded.digits, '0420');
  assert.equal(decoded.raw, '042000');
});

test('letter prefix follows the two high bits (P/C/B/U)', () => {
  assert.equal(decodeDtc(0x00, 0x00).letter, 'P');
  assert.equal(decodeDtc(0x40, 0x00).letter, 'C');
  assert.equal(decodeDtc(0x80, 0x00).letter, 'B');
  assert.equal(decodeDtc(0xc0, 0x00).letter, 'U');
  assert.equal(decodeDtc(0xc1, 0x23).code, 'U0123');
});

test('encode/decode round trip for all four families', () => {
  for (const code of ['P0420', 'P1234', 'C1234', 'B0001', 'U0155']) {
    const { high, low } = encodeDtc(code);
    assert.equal(decodeDtc(high, low).code, code);
  }
});

test('encodeDtcToBytes produces the three-byte wire form', () => {
  assert.deepEqual(encodeDtcToBytes('P0420', 0x1f), new Uint8Array([0x04, 0x20, 0x1f]));
  assert.equal(decodeDtcBytes(encodeDtcToBytes('U0155')).code, 'U0155');
});

test('encodeDtc rejects malformed codes', () => {
  assert.throws(() => encodeDtc('X0420'));
  assert.throws(() => encodeDtc('P4420'), /Invalid DTC/);
  assert.throws(() => encodeDtc('P04'));
});

test('status bits map to ISO 14229-1 bit positions', () => {
  const bits = decodeDtcStatus(0x2f);
  assert.equal(bits.testFailed, true);
  assert.equal(bits.testFailedThisOperationCycle, true);
  assert.equal(bits.pendingDtc, true);
  assert.equal(bits.confirmedDtc, true);
  assert.equal(bits.testNotCompletedSinceLastClear, false);
  assert.equal(bits.testFailedSinceLastClear, true);
  assert.equal(bits.testNotCompletedThisOperationCycle, false);
  assert.equal(bits.warningIndicatorRequested, false);
});

test('status encode/decode round trip', () => {
  const bits = { confirmedDtc: true, pendingDtc: true } as const;
  assert.equal(encodeDtcStatus(bits), 0x0c);
  assert.deepEqual(decodeDtcStatus(0x0c), { ...decodeDtcStatus(0), ...bits });
});

test('severity is derived from status bits', () => {
  assert.equal(dtcSeverity(decodeDtcStatus(0x01)), 'critical');
  assert.equal(dtcSeverity(decodeDtcStatus(0x08)), 'major');
  assert.equal(dtcSeverity(decodeDtcStatus(0x04)), 'minor');
  assert.equal(dtcSeverity(decodeDtcStatus(0x50)), 'info');
});

/* ------------------------------------------------------------------ *
 * Property round trips (fast-check, testing standards).              *
 * ------------------------------------------------------------------ */

import fc from 'fast-check';
import { describe, expect } from 'vitest';
import { DTC_LETTERS } from './dtc.js';

const validCodeArb = fc
  .tuple(fc.constantFrom(...DTC_LETTERS), fc.nat({ max: 3 }), fc.nat({ max: 15 }), fc.nat({ max: 15 }), fc.nat({ max: 15 }))
  .map(([letter, d1, d2, d3, d4]) => `${letter}${d1}${d2.toString(16)}${d3.toString(16)}${d4.toString(16)}`.toUpperCase());

describe('DTC property round trips (ISO 14229-1 Annex C)', () => {
  test('property: encodeDtc ∘ decodeDtc is the identity on every representable code', () => {
    fc.assert(
      fc.property(validCodeArb, (code) => {
        const { high, low } = encodeDtc(code);
        expect(decodeDtc(high, low).code).toBe(code);
      }),
      { numRuns: 1000 },
    );
  });

  test('property: encodeDtcToBytes ∘ decodeDtcBytes is the identity incl. failure type', () => {
    fc.assert(
      fc.property(validCodeArb, fc.nat({ max: 255 }), (code, failureType) => {
        const decoded = decodeDtcBytes(encodeDtcToBytes(code, failureType));
        expect(decoded.code).toBe(code);
        expect(decoded.failureType).toBe(failureType.toString(16).padStart(2, '0').toUpperCase());
      }),
    );
  });

  test('property: the raw hex form is stable for every byte pair', () => {
    fc.assert(
      fc.property(fc.nat({ max: 255 }), fc.nat({ max: 255 }), (high, low) => {
        const decoded = decodeDtc(high, low);
        expect(decoded.raw).toBe(
          `${high.toString(16).padStart(2, '0')}${low.toString(16).padStart(2, '0')}00`.toUpperCase(),
        );
      }),
    );
  });
});

describe('DTC status byte round trips (ISO 14229-1 §8.3)', () => {
  const bitNames = [
    'testFailed',
    'testFailedThisOperationCycle',
    'pendingDtc',
    'confirmedDtc',
    'testNotCompletedSinceLastClear',
    'testFailedSinceLastClear',
    'testNotCompletedThisOperationCycle',
    'warningIndicatorRequested',
  ] as const;

  test('property: every one of the 256 status byte values decodes and re-encodes identically', () => {
    fc.assert(
      fc.property(fc.nat({ max: 255 }), (status) => {
        const bits = decodeDtcStatus(status);
        expect(encodeDtcStatus(bits)).toBe(status);
      }),
      { numRuns: 256 },
    );
  });

  test('property: each generated bit pattern round trips through the named fields', () => {
    fc.assert(
      fc.property(fc.record(Object.fromEntries(bitNames.map((n) => [n, fc.boolean()]))) as unknown as fc.Arbitrary<Record<(typeof bitNames)[number], boolean>>, (bits) => {
        expect(encodeDtcStatus(bits)).toBe(encodeDtcStatus(decodeDtcStatus(encodeDtcStatus(bits))));
        const decoded = decodeDtcStatus(encodeDtcStatus(bits));
        for (const name of bitNames) expect(decoded[name]).toBe(bits[name]);
      }),
    );
  });

  test('severity escalates with the status bits', () => {
    expect(dtcSeverity(decodeDtcStatus(0x01))).toBe('critical');
    expect(dtcSeverity(decodeDtcStatus(0x08))).toBe('major');
    expect(dtcSeverity(decodeDtcStatus(0x04))).toBe('minor');
    expect(dtcSeverity(decodeDtcStatus(0x40))).toBe('info');
  });
});
