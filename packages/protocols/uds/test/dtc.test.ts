import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeDtc,
  decodeDtcStatus,
  dtcSeverity,
  encodeDtc,
  encodeDtcStatus,
  encodeDtcToBytes,
  decodeDtcBytes,
} from '../src/dtc.js';

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
