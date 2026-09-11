/**
 * UdsClient engine edge cases (ISO 14229-1/-2) not covered by the service tests.
 *
 * Focus: the response evaluation loop — pending overflow, transient retries,
 * foreign SIDs, timeout accounting — plus degenerate parse paths.
 */

import assert from 'node:assert/strict';
import { describe, expect, test, vi } from 'vitest';
import { ProtocolError, UdsNegativeResponseError, UdsTimeoutError, createLogger } from '@vdp/shared';
import { NRC } from './nrc.js';
import { DID, NEGATIVE_RESPONSE_SID, SESSION } from './services.js';
import { UdsClient, didToBytes, parseMultiDidResponse, parseSingleDidResponse } from './client.js';
import type { UdsLink } from './link.js';

const logger = createLogger('uds-client-test', { level: 'ERROR' });
const NO_SLEEP = async () => undefined;

/** Queue-based link: every request consumes the next scripted response. */
function scriptedLink(responses: Array<Uint8Array | 'timeout'>, receiveQueue: Array<Uint8Array | null> = []): UdsLink & { requests: Uint8Array[] } {
  const requests: Uint8Array[] = [];
  let index = 0;
  return {
    requests,
    async request() {
      const next = responses[index++];
      requests.push(new Uint8Array(0));
      if (!next || next === 'timeout') throw new UdsTimeoutError('scripted timeout', {});
      return next;
    },
    async sendOnly() {
      requests.push(new Uint8Array(0));
    },
    async receive() {
      return receiveQueue.shift() ?? null;
    },
  };
}

const positive = (sid: number, ...rest: number[]): Uint8Array => new Uint8Array([sid + 0x40, ...rest]);

describe('response evaluation loop', () => {
  test('ResponsePending beyond maxPendingResponses aborts with UdsTimeoutError', async () => {
    const pending = new Uint8Array([NEGATIVE_RESPONSE_SID, 0x22, NRC.REQUEST_CORRECTLY_RECEIVED_RESPONSE_PENDING]);
    const link = scriptedLink([pending, pending], [pending, pending, pending]);
    const client = new UdsClient(link, { logger, sleep: NO_SLEEP, maxPendingResponses: 2, timing: { p2Ms: 1, p2StarMs: 1 } });
    await expect(client.readDid(DID.VEHICLE_IDENTIFIER_NUMBER)).rejects.toThrow(/beyond 2 iterations/);
    assert.equal(client.stats.pendingResponses, 2);
    assert.equal(client.stats.timeouts, 0, 'the overflow is a protocol abort, not a transport timeout');
  });

  test('a transient NRC is retried once, then succeeds', async () => {
    const busy = new Uint8Array([NEGATIVE_RESPONSE_SID, 0x22, NRC.BUSY_REPEAT_REQUEST]);
    const link = scriptedLink([busy, positive(0x22, 0xf1, 0x90, 0x57)]);
    const client = new UdsClient(link, { logger, sleep: NO_SLEEP });
    const value = await client.readDid(DID.VEHICLE_IDENTIFIER_NUMBER);
    assert.deepEqual(Array.from(value ?? []), [0x57]);
    assert.equal(client.stats.negativeResponses, 1);
    assert.equal(client.stats.responses, 2);
  });

  test('a persistent transient NRC fails after exactly one retry', async () => {
    const busy = new Uint8Array([NEGATIVE_RESPONSE_SID, 0x22, NRC.RESOURCE_TEMPORARILY_NOT_AVAILABLE]);
    const link = scriptedLink([busy, busy]);
    const client = new UdsClient(link, { logger, sleep: NO_SLEEP });
    await expect(client.readDid(DID.VEHICLE_IDENTIFIER_NUMBER)).rejects.toThrow(UdsNegativeResponseError);
    assert.equal(link.requests.length, 2, 'exactly one wire-level retry');
  });

  test('retryTransientNrc: false throws the negative response immediately', async () => {
    const busy = new Uint8Array([NEGATIVE_RESPONSE_SID, 0x22, NRC.BUSY_REPEAT_REQUEST]);
    const link = scriptedLink([busy]);
    const client = new UdsClient(link, { logger, sleep: NO_SLEEP, retryTransientNrc: false });
    await expect(client.readDid(DID.VEHICLE_IDENTIFIER_NUMBER)).rejects.toThrow(UdsNegativeResponseError);
    assert.equal(client.stats.requests, 1);
  });

  test('a response with a foreign SID is a ProtocolError, not a silent accept', async () => {
    const link = scriptedLink([positive(0x31, 0x00)]);
    const client = new UdsClient(link, { logger, sleep: NO_SLEEP });
    await expect(client.readDid(DID.VEHICLE_IDENTIFIER_NUMBER)).rejects.toThrow(ProtocolError);
  });

  test('link timeouts are counted and rethrown', async () => {
    const link = scriptedLink(['timeout']);
    const client = new UdsClient(link, { logger, sleep: NO_SLEEP });
    await expect(client.readDid(DID.VEHICLE_IDENTIFIER_NUMBER)).rejects.toThrow(UdsTimeoutError);
    assert.equal(client.stats.timeouts, 1);
  });
});

describe('session handling details', () => {
  test('a suppressed positive response keeps the configured timing', async () => {
    const link = scriptedLink([]);
    const client = new UdsClient(link, { logger, sleep: NO_SLEEP, timing: { p2Ms: 33, p2StarMs: 660 } });
    const result = await client.diagnosticSessionControl(SESSION.EXTENDED, { suppressPositiveResponse: true });
    assert.deepEqual(result, { sessionType: SESSION.EXTENDED, p2Ms: 33, p2StarMs: 660 });
    assert.equal(client.activeSessionType, SESSION.DEFAULT, 'no response, no session change');
  });

  test('unknown session types render as hex in the name', async () => {
    const link = scriptedLink([positive(0x10, 0x60, 0x00, 0x32, 0x01, 0xf4)]);
    const client = new UdsClient(link, { logger, sleep: NO_SLEEP });
    await client.diagnosticSessionControl(0x60);
    assert.equal(client.activeSessionType, 0x60);
    assert.equal(client.activeSessionName, 'session_0x60');
  });

  test('updateTiming merges without losing unspecified fields', () => {
    const client = new UdsClient(scriptedLink([]), { logger, timing: { p2Ms: 20 } });
    client.updateTiming({ p2StarMs: 3000 });
    assert.equal(client.timing.p2Ms, 20);
    assert.equal(client.timing.p2StarMs, 3000);
    assert.equal(client.timing.s3Ms, 5000);
  });
});

describe('tester present scheduler', () => {
  test('sends periodically and stops cleanly (fake timers, no real waiting)', async () => {
    vi.useFakeTimers();
    try {
      const link = scriptedLink([new Uint8Array([]), new Uint8Array([]), new Uint8Array([])]);
      const client = new UdsClient(link, { logger, sleep: NO_SLEEP });
      client.startTesterPresent(1000);
      await vi.advanceTimersByTimeAsync(2500);
      client.stopTesterPresent();
      const sendsAfterStop = link.requests.length;
      await vi.advanceTimersByTimeAsync(5000);
      assert.equal(link.requests.length, sendsAfterStop, 'no sends after stop');
      client.stopTesterPresent();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('degenerate parse paths', () => {
  test('snapshot and extended data return null on short responses', async () => {
    const link = scriptedLink([new Uint8Array([0x59, 0x04]), new Uint8Array([0x59, 0x06])]);
    const client = new UdsClient(link, { logger, sleep: NO_SLEEP });
    assert.equal(await client.readDtcSnapshotRecord('P0420'), null);
    assert.equal(await client.readDtcExtendedDataRecord('P0420'), null);
  });

  test('readVin returns null when the ECU returns no usable data', async () => {
    const noEcho = scriptedLink([positive(0x22, 0x12, 0x34)]);
    assert.equal(await new UdsClient(noEcho, { logger, sleep: NO_SLEEP }).readVin(), null, 'DID echo mismatch');
    const emptyValue = scriptedLink([positive(0x22, 0xf1, 0x90)]);
    assert.equal(await new UdsClient(emptyValue, { logger, sleep: NO_SLEEP }).readVin(), null, 'empty VIN field');
  });

  test('readDid of a DID that echoes nothing yields an empty map', async () => {
    const link = scriptedLink([positive(0x22, 0x12, 0x34)]);
    const client = new UdsClient(link, { logger, sleep: NO_SLEEP });
    const map = await client.readDataByIdentifier([DID.VEHICLE_IDENTIFIER_NUMBER]);
    assert.equal(map.size, 0, 'a mismatching DID echo is dropped');
  });

  test('parseSingleDidResponse guards short and mismatching responses', () => {
    assert.equal(parseSingleDidResponse(new Uint8Array([0x62]), 0xf190), null);
    assert.equal(parseSingleDidResponse(new Uint8Array([0x62, 0xf1, 0x90]), 0x0c00), null);
    assert.deepEqual(Array.from(parseSingleDidResponse(new Uint8Array([0x62, 0xf1, 0x90, 0x57]) as Uint8Array, 0xf190) as Uint8Array), [0x57]);
  });

  test('parseMultiDidResponse rejects a truncated tail', () => {
    const response = new Uint8Array([0x62, 0xf1, 0x90, 0x57]);
    assert.throws(() => parseMultiDidResponse(response, new Map([[0xf190, 4]])), /declares 4 bytes/);
  });

  test('didToBytes splits big-endian', () => {
    assert.deepEqual(Array.from(didToBytes(0xf190)), [0xf1, 0x90]);
  });
});

describe('security unlock', () => {
  test('unlockSecurityAccess runs the full seed/key handshake with the registered algorithm', async () => {
    const responses = [positive(0x27, 0x01, 0xaa, 0xbb), positive(0x27, 0x02)];
    const link = scriptedLink(responses);
    const client = new UdsClient(link, { logger, sleep: NO_SLEEP });
    client.setSeedKeyAlgorithm({
      id: 'xor-test',
      provenance: 'unit test only',
      computeKey: async ({ seed }) => new Uint8Array(Array.from(seed, (b) => b ^ 0xff)),
    });
    const result = await client.unlockSecurityAccess(0x01);
    assert.deepEqual(result, { algorithm: 'xor-test', provenance: 'unit test only' });
    // Second request carries the computed key at level+1.
    assert.equal(client.stats.requests, 2);
  });

  test('raw() escapes the service model with logging', async () => {
    const link = scriptedLink([positive(0x3e, 0x00)]);
    const client = new UdsClient(link, { logger, sleep: NO_SLEEP });
    const response = await client.raw(new Uint8Array([0x3e, 0x00]));
    assert.equal(response[0], 0x7e);
  });
});
