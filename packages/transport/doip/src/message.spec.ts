/**
 * DoIP message framing round trips (ISO 13400-2 §9).
 *
 * Property tests over generated VINs, addresses and payloads: whatever goes
 * through an encoder must come back identical through the decoder, and every
 * truncated input must be *rejected* (never silently mis-parsed).
 */

import assert from 'node:assert/strict';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { ProtocolError } from '@vdp/shared';
import {
  DOIP_HEADER_LENGTH,
  DOIP_PROTOCOL_VERSION,
  PAYLOAD_TYPE,
  ROUTING_ACTIVATION_TYPE,
  decodeDiagnosticAck,
  decodeDiagnosticMessage,
  decodeHeader,
  decodeRoutingActivationResponse,
  decodeVehicleIdentificationResponse,
  encodeDiagnosticMessage,
  encodeHeader,
  encodeMessage,
  encodeRoutingActivationRequest,
  encodeRoutingActivationResponse,
  encodeVehicleIdentificationRequest,
  encodeVehicleIdentificationResponse,
} from './message.js';

/** ISO 3779 VIN alphabet (no I, O, Q). */
const vinArb = fc
  .uint8Array({ minLength: 17, maxLength: 17 })
  .map((bytes) => Array.from(bytes, (b) => 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789'[b % 32]).join(''));

const addressArb = fc.nat({ max: 0xffff });

describe('generic header', () => {
  test('encode/decode round trip for every payload type and length', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...Object.values(PAYLOAD_TYPE)),
        fc.nat({ max: 0xffffffff }),
        (payloadType, payloadLength) => {
          const header = decodeHeader(encodeHeader(payloadType, payloadLength));
          assert.equal(header.version, DOIP_PROTOCOL_VERSION);
          assert.equal(header.payloadType, payloadType);
          assert.equal(header.payloadLength, payloadLength);
        },
      ),
    );
  });

  test('property: encodeMessage embeds the payload verbatim', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 128 }), addressArb, addressArb, (payload, source, target) => {
        const message = encodeMessage(PAYLOAD_TYPE.DIAGNOSTIC_MESSAGE, encodeDiagnosticMessage(source, target, payload));
        const header = decodeHeader(message.subarray(0, DOIP_HEADER_LENGTH));
        assert.equal(header.payloadType, PAYLOAD_TYPE.DIAGNOSTIC_MESSAGE);
        assert.equal(header.payloadLength, 4 + payload.length);
        const decoded = decodeDiagnosticMessage(message.subarray(DOIP_HEADER_LENGTH));
        assert.equal(decoded.sourceAddress, source);
        assert.equal(decoded.targetAddress, target);
        assert.deepEqual(Array.from(decoded.udsPayload), Array.from(payload));
      }),
    );
  });

  test('truncated headers are rejected, never guessed', () => {
    fc.assert(
      fc.property(fc.nat({ max: DOIP_HEADER_LENGTH - 1 }), (length) => {
        assert.throws(() => decodeHeader(new Uint8Array(length)), ProtocolError);
      }),
    );
  });

  test('a broken version inverse is rejected (ISO 13400-2 §7.2)', () => {
    const data = encodeHeader(0x0001, 0);
    data[1] = (data[1] ?? 0) ^ 0x55;
    assert.throws(() => decodeHeader(data), /version check failed/);
  });
});

describe('vehicle identification (ISO 13400-2 §9.2)', () => {
  test('property: VIN response round trip preserves VIN, addresses, EID/GID and status', () => {
    fc.assert(
      fc.property(
        vinArb,
        addressArb,
        fc.uint8Array({ minLength: 6, maxLength: 6 }),
        fc.uint8Array({ minLength: 6, maxLength: 6 }),
        fc.boolean(),
        fc.option(fc.nat({ max: 255 }), { nil: undefined }),
        (vin, logicalAddress, eid, gid, furtherAction, vinSyncStatus) => {
          const decoded = decodeVehicleIdentificationResponse(
            encodeVehicleIdentificationResponse({ vin, logicalAddress, eid, gid, furtherActionRequired: furtherAction, ...(vinSyncStatus !== undefined ? { vinSyncStatus } : {}) }),
          );
          assert.equal(decoded.vin, vin);
          assert.equal(decoded.logicalAddress, logicalAddress);
          assert.deepEqual(Array.from(decoded.eid), Array.from(eid));
          assert.deepEqual(Array.from(decoded.gid), Array.from(gid));
          assert.equal(decoded.furtherActionRequired, furtherAction);
          if (vinSyncStatus !== undefined) assert.equal(decoded.vinSyncStatus, vinSyncStatus);
        },
      ),
    );
  });

  test('short vehicle identification payloads are rejected', () => {
    assert.throws(() => decodeVehicleIdentificationResponse(new Uint8Array(31)), ProtocolError);
  });

  test('the VIN request is empty without VIN and 17 bytes with one', () => {
    assert.equal(encodeVehicleIdentificationRequest().length, 0);
    assert.equal(encodeVehicleIdentificationRequest('WVWZZZ1JZXW000000').length, 17);
  });
});

describe('routing activation (ISO 13400-2 §9.3)', () => {
  test('property: response round trip preserves addresses and every code byte', () => {
    fc.assert(
      fc.property(addressArb, addressArb, fc.nat({ max: 255 }), (tester, entity, code) => {
        const decoded = decodeRoutingActivationResponse(encodeRoutingActivationResponse(tester, entity, code));
        assert.equal(decoded.testerLogicalAddress, tester);
        assert.equal(decoded.entityLogicalAddress, entity);
        assert.equal(decoded.code, code);
      }),
    );
  });

  test('success and known codes carry their names, unknown codes stay reportable', () => {
    assert.equal(decodeRoutingActivationResponse(encodeRoutingActivationResponse(0x0e80, 0x0001, 0x10)).codeName, 'success');
    assert.match(decodeRoutingActivationResponse(encodeRoutingActivationResponse(0x0e80, 0x0001, 0x2a)).codeName, /unknown_0x2a/);
  });

  test('request embeds the activation type', () => {
    const request = encodeRoutingActivationRequest(0x0e80, ROUTING_ACTIVATION_TYPE.CENTRAL_SECURITY);
    assert.equal(request[0], 0x0e);
    assert.equal(request[1], 0x80);
    assert.equal(request[2], ROUTING_ACTIVATION_TYPE.CENTRAL_SECURITY);
  });

  test('short routing activation responses are rejected', () => {
    assert.throws(() => decodeRoutingActivationResponse(new Uint8Array(8)), ProtocolError);
  });
});

describe('diagnostic message + ack', () => {
  test('property: payload survives the diagnostic round trip byte for byte', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 4095 }), addressArb, addressArb, (udsPayload, source, target) => {
        const decoded = decodeDiagnosticMessage(encodeDiagnosticMessage(source, target, udsPayload));
        assert.equal(decoded.sourceAddress, source);
        assert.equal(decoded.targetAddress, target);
        assert.deepEqual(Array.from(decoded.udsPayload), Array.from(udsPayload));
      }),
    );
  });

  test('short diagnostic payloads and acks are rejected', () => {
    assert.throws(() => decodeDiagnosticMessage(new Uint8Array(3)), ProtocolError);
    assert.throws(() => decodeDiagnosticAck(new Uint8Array(4)), ProtocolError);
  });

  test('ack decodes source, target and code', () => {
    const ack = new Uint8Array([0x0e, 0x80, 0x00, 0x01, 0x00]);
    assert.deepEqual(decodeDiagnosticAck(ack), { sourceAddress: 0x0e80, targetAddress: 0x0001, ackCode: 0x00 });
  });
});
