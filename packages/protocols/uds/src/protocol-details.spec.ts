/**
 * Small UDS support modules: ISO 14229-2 timing, NRC names, service constants.
 */

import assert from 'node:assert/strict';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { NRC, isTransientNrc, nrcName } from './nrc.js';
import { SID, isPositiveResponse, positiveResponseSid, serviceName } from './services.js';
import { DEFAULT_UDS_TIMING, parseSessionTiming } from './timing.js';
import { decodeDtcBytes } from './dtc.js';

describe('session timing (ISO 14229-2)', () => {
  test('P2 and P2* are parsed from the session control response', () => {
    assert.deepEqual(parseSessionTiming(new Uint8Array([0x50, 0x03, 0x00, 0x32, 0x01, 0xf4])), { p2Ms: 50, p2StarMs: 5000 });
  });

  test('short responses and the 0xFFFF "not reported" encodings yield null', () => {
    assert.equal(parseSessionTiming(new Uint8Array([0x50, 0x03, 0x00, 0x32, 0x01])), null);
    assert.equal(parseSessionTiming(new Uint8Array([0x50])), null, 'anything shorter than the 6-byte frame is rejected outright');
    assert.equal(parseSessionTiming(new Uint8Array([0x50, 0x03, 0xff, 0xff, 0x01, 0xf4])), null, 'P2 = not reported');
    assert.equal(parseSessionTiming(new Uint8Array([0x50, 0x03, 0x00, 0x32, 0xff, 0xff])), null, 'P2* = not reported');
  });

  test('property: P2*/10 ms units convert losslessly', () => {
    fc.assert(
      fc.property(fc.nat({ max: 0xfffe }), fc.nat({ max: 0xfffe }), (p2, p2StarUnits) => {
        const parsed = parseSessionTiming(new Uint8Array([0x50, 0x00, (p2 >> 8) & 0xff, p2 & 0xff, (p2StarUnits >> 8) & 0xff, p2StarUnits & 0xff]));
        expect(parsed).toEqual({ p2Ms: p2, p2StarMs: p2StarUnits * 10 });
      }),
    );
  });

  test('defaults follow the ISO server defaults (AGENTS 9)', () => {
    assert.equal(DEFAULT_UDS_TIMING.p2Ms, 50);
    assert.equal(DEFAULT_UDS_TIMING.p2StarMs, 5000);
    assert.equal(DEFAULT_UDS_TIMING.s3Ms, 5000);
  });
});

describe('NRC handling', () => {
  test('known NRCs carry names, unknown ones stay reportable', () => {
    assert.equal(nrcName(NRC.SERVICE_NOT_SUPPORTED), 'serviceNotSupported');
    assert.equal(nrcName(0xea), 'unknownNrc_0xea');
  });

  test('exactly the busy NRCs are transient', () => {
    assert.equal(isTransientNrc(NRC.BUSY_REPEAT_REQUEST), true);
    assert.equal(isTransientNrc(NRC.RESOURCE_TEMPORARILY_NOT_AVAILABLE), true);
    assert.equal(isTransientNrc(NRC.GENERAL_REJECT), false);
    assert.equal(isTransientNrc(NRC.REQUEST_CORRECTLY_RECEIVED_RESPONSE_PENDING), false, 'pending is a wait, not a retry');
  });
});

describe('service constants', () => {
  test('positive response SID offset is +0x40 with wrap-around', () => {
    assert.equal(positiveResponseSid(0x10), 0x50);
    assert.equal(positiveResponseSid(0xf0), 0x30, 'wraps in one byte');
  });

  test('isPositiveResponse matches only the offset SID', () => {
    assert.equal(isPositiveResponse(0x10, new Uint8Array([0x50])), true);
    assert.equal(isPositiveResponse(0x10, new Uint8Array([0x7f])), false);
    assert.equal(isPositiveResponse(0x10, new Uint8Array([])), false, 'empty response is never positive');
  });

  test('serviceName falls back to the hex form for unknown SIDs', () => {
    assert.equal(serviceName(SID.READ_DATA_BY_IDENTIFIER), 'READ_DATA_BY_IDENTIFIER');
    assert.equal(serviceName(0x77), 'SERVICE_0x77');
  });
});

describe('DTC byte decoding degenerate inputs', () => {
  test('short arrays decode as zeros, never throw', () => {
    assert.equal(decodeDtcBytes(new Uint8Array(0)).code, 'P0000');
    assert.equal(decodeDtcBytes(new Uint8Array([0x04])).code, 'P0400');
    assert.equal(decodeDtcBytes(new Uint8Array([0x04, 0x20, 0x2a])).failureType, '2A');
  });
});
