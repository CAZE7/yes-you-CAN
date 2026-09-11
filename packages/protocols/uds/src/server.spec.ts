/**
 * UDS ECU-side server tests (AGENTS 32).
 *
 * The server is the reference behaviour every client test runs against: session
 * gating, NRC correctness (ISO 14229-1) and the Response-Pending flow must be
 * exact, because a wrong answer here hides client bugs instead of exposing them.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'vitest';
import { createLogger } from '@vdp/shared';
import { NRC } from './nrc.js';
import { DTC_REPORT, SESSION, SID, SUPPRESS_POSITIVE_RESPONSE } from './services.js';
import { UdsServer, type UdsServerLink } from './server.js';

const logger = createLogger('uds-server-test', { level: 'ERROR' });

interface Harness {
  server: UdsServer;
  sent: Uint8Array[];
  send(payload: number[]): Promise<void>;
}

function h(options: Partial<ConstructorParameters<typeof UdsServer>[1]> = {}): Harness {
  const sent: Uint8Array[] = [];
  const link: UdsServerLink = {
    onMessage: () => () => undefined,
    send: async (payload) => {
      sent.push(payload);
    },
  };
  const server = new UdsServer(link, {
    name: 'test-ecu',
    logger,
    dids: [
      { did: 0xf190, value: () => new Uint8Array([0x57, 0x56, 0x57]) },
      { did: 0x0c00, value: () => new Uint8Array([0x09, 0x60]), writable: true },
      { did: 0x1234, value: () => new Uint8Array([0x01]), writable: false, sessions: [SESSION.EXTENDED] },
    ],
    dtcs: [
      { code: 'P0420', status: 0x2f, snapshot: new Uint8Array([0xaa, 0xbb]) },
      { code: 'P0301', status: 0x02, extendedData: new Uint8Array([0x11]) },
    ],
    routines: [{ id: 0x0203, run: (data) => new Uint8Array([data.length]) }],
    securityAccess: {
      seed: () => new Uint8Array([0x11, 0x22]),
      verifyKey: (level, key) => key[0] === level,
      lockoutMs: 500,
    },
    ...options,
  });
  return {
    server,
    sent,
    send: (payload: number[]) => server.handle(new Uint8Array(payload)),
  };
}

const P = 0x40;

describe('session control + tester present', () => {
  test('positive response echoes the session and reports P2/P2* (ISO 14229-2)', async () => {
    const env = h({ timing: { p2Ms: 0x0032, p2StarMs: 5000 } });
    await env.send([SID.DIAGNOSTIC_SESSION_CONTROL, SESSION.EXTENDED]);
    assert.deepEqual(Array.from(env.sent[0] ?? []), [P + 0x10, SESSION.EXTENDED, 0x00, 0x32, 0x01, 0xf4]);
  });

  test('an unsupported session is a negative response, not a silent fallback', async () => {
    const env = h({ sessions: [SESSION.DEFAULT] });
    await env.send([SID.DIAGNOSTIC_SESSION_CONTROL, SESSION.EXTENDED]);
    assert.deepEqual(Array.from(env.sent[0] ?? []), [0x7f, 0x10, NRC.SUB_FUNCTION_NOT_SUPPORTED]);
  });

  test('a too-short session request is a format error', async () => {
    const env = h();
    await env.send([SID.DIAGNOSTIC_SESSION_CONTROL]);
    assert.equal(env.sent[0]?.[2], NRC.INCORRECT_MESSAGE_LENGTH_OR_INVALID_FORMAT);
  });

  test('tester present answers positively and honours suppressPosRspMsgIndicationBit', async () => {
    const env = h();
    await env.send([SID.TESTER_PRESENT, 0x00]);
    assert.deepEqual(Array.from(env.sent[0] ?? []), [P + 0x3e, 0x00]);
    await env.send([SID.TESTER_PRESENT, SUPPRESS_POSITIVE_RESPONSE]);
    assert.equal(env.sent.length, 1, 'suppressed = no response at all');
  });
});

describe('ecu reset', () => {
  test('valid reset types answer positively and drop back to the default session', async () => {
    const env = h();
    await env.send([SID.DIAGNOSTIC_SESSION_CONTROL, SESSION.EXTENDED]);
    await env.send([SID.ECU_RESET, 0x01]); // hard reset
    assert.equal(env.sent[1]?.[0], P + 0x11);
    await env.send([SID.DIAGNOSTIC_SESSION_CONTROL, SESSION.EXTENDED]);
    // After the reset the server still accepts extended (it is in the supported list),
    // so verify the session reset differently: write DID requires extended.
    const env2 = h();
    await env2.send([SID.DIAGNOSTIC_SESSION_CONTROL, SESSION.EXTENDED]);
    await env2.send([SID.WRITE_DATA_BY_IDENTIFIER, 0x0c, 0x00, 0x01]);
    assert.equal(env2.sent[1]?.[0], P + 0x2e, 'write works in extended session');
    await env2.send([SID.ECU_RESET, 0x01]);
    await env2.send([SID.WRITE_DATA_BY_IDENTIFIER, 0x0c, 0x00, 0x02]);
    assert.equal(env2.sent[3]?.[2], NRC.SERVICE_NOT_SUPPORTED_IN_ACTIVE_SESSION);
  });

  test('reset type 0x00 is not assigned and is rejected', async () => {
    const env = h();
    await env.send([SID.ECU_RESET, 0x00]);
    assert.equal(env.sent[0]?.[2], NRC.SUB_FUNCTION_NOT_SUPPORTED);
  });

  test('a too-short reset request is a format error', async () => {
    const env = h();
    await env.send([SID.ECU_RESET]);
    assert.equal(env.sent[0]?.[2], NRC.INCORRECT_MESSAGE_LENGTH_OR_INVALID_FORMAT);
  });
});

describe('clear diagnostic information', () => {
  test('a truncated clear request is never interpreted as "clear everything"', async () => {
    const env = h();
    await env.send([SID.CLEAR_DIAGNOSTIC_INFORMATION, 0xff, 0xff]);
    assert.equal(env.sent[0]?.[0], 0x7f);
    assert.equal(env.sent[0]?.[2], NRC.INCORRECT_MESSAGE_LENGTH_OR_INVALID_FORMAT);
    assert.equal(env.server.stats.negativeResponses, 1);
  });

  test('an unknown group is out of range; clearing resets statuses but keeps present faults', async () => {
    const env = h();
    await env.send([SID.CLEAR_DIAGNOSTIC_INFORMATION, 0x12, 0x34, 0x56]);
    assert.equal(env.sent[0]?.[2], NRC.REQUEST_OUT_OF_RANGE);

    await env.send([SID.CLEAR_DIAGNOSTIC_INFORMATION, 0xff, 0xff, 0xff]);
    assert.equal(env.sent[1]?.[0], P + 0x14);
    // P0420 had testFailed (bit 0) set → comes back with 0x03; P0301 (0x01, no
    // testFailed) leaves the fault memory entirely.
    await env.send([SID.READ_DTC_INFORMATION, DTC_REPORT.REPORT_SUPPORTED_DTC]);
    const body = env.sent[2] ?? new Uint8Array();
    assert.equal(body.length, 3 + 4, 'only the still-present fault remains');
  });
});

describe('read DTC information', () => {
  test('report by status mask filters on the mask and reports the availability mask', async () => {
    const env = h({ dtcAvailabilityMask: 0x28 });
    await env.send([SID.READ_DTC_INFORMATION, DTC_REPORT.REPORT_DTC_BY_STATUS_MASK, 0x08]);
    const response = env.sent[0] ?? new Uint8Array();
    assert.equal(response[2], 0x28);
    assert.equal(response.length, 7, 'only P0420 (0x2f) matches mask 0x08');
    await env.send([SID.READ_DTC_INFORMATION, DTC_REPORT.REPORT_DTC_BY_STATUS_MASK, 0x80]);
    assert.equal((env.sent[1] ?? new Uint8Array()).length, 3, 'mask 0x80 matches nothing');
  });

  test('report number of DTCs encodes the count as a 16-bit field', async () => {
    const env = h();
    await env.send([SID.READ_DTC_INFORMATION, DTC_REPORT.REPORT_NUMBER_OF_DTC_BY_STATUS_MASK, 0xff]);
    const response = env.sent[0] ?? new Uint8Array();
    assert.equal(response[3], 0);
    assert.equal(response[4], 2);
  });

  test('snapshot records return environment data; unknown DTCs are out of range', async () => {
    const env = h();
    await env.send([SID.READ_DTC_INFORMATION, DTC_REPORT.REPORT_DTC_SNAPSHOT_RECORD_BY_DTC_NUMBER, 0x04, 0x20, 0x01, 0x02]);
    const response = env.sent[0] ?? new Uint8Array();
    assert.equal(response[0], P + 0x19);
    assert.deepEqual(Array.from(response.subarray(7)), [0xaa, 0xbb]);
    await env.send([SID.READ_DTC_INFORMATION, DTC_REPORT.REPORT_DTC_SNAPSHOT_RECORD_BY_DTC_NUMBER, 0x99, 0x99, 0x00]);
    assert.equal(env.sent[1]?.[2], NRC.REQUEST_OUT_OF_RANGE);
  });

  test('extended data records and unsupported sub-functions', async () => {
    const env = h();
    await env.send([SID.READ_DTC_INFORMATION, DTC_REPORT.REPORT_DTC_EXTENDED_DATA_RECORD_BY_DTC_NUMBER, 0x03, 0x01, 0x00]);
    assert.deepEqual(Array.from((env.sent[0] ?? new Uint8Array()).subarray(7)), [0x11]);
    await env.send([SID.READ_DTC_INFORMATION, 0x42]);
    assert.equal(env.sent[1]?.[2], NRC.SUB_FUNCTION_NOT_SUPPORTED);
  });
});

describe('read/write data by identifier', () => {
  test('multiple DIDs in one request, unknown ones skipped', async () => {
    const env = h();
    await env.send([SID.READ_DATA_BY_IDENTIFIER, 0xf1, 0x90, 0x99, 0x99, 0x0c, 0x00]);
    const response = env.sent[0] ?? new Uint8Array();
    assert.equal(response[0], P + 0x22);
    assert.deepEqual(Array.from(response.subarray(1, 3)), [0xf1, 0x90]);
    assert.deepEqual(Array.from(response.subarray(3, 6)), [0x57, 0x56, 0x57], 'VIN value');
    assert.deepEqual(Array.from(response.subarray(6, 8)), [0x0c, 0x00]);
    assert.deepEqual(Array.from(response.subarray(8)), [0x09, 0x60]);
  });

  test('odd-length and missing DIDs are format/range errors', async () => {
    const env = h();
    await env.send([SID.READ_DATA_BY_IDENTIFIER, 0xf1]);
    assert.equal(env.sent[0]?.[2], NRC.INCORRECT_MESSAGE_LENGTH_OR_INVALID_FORMAT);
    await env.send([SID.READ_DATA_BY_IDENTIFIER, 0x99, 0x99]);
    assert.equal(env.sent[1]?.[2], NRC.REQUEST_OUT_OF_RANGE);
  });

  test('session-restricted DIDs are invisible in the default session', async () => {
    const env = h();
    await env.send([SID.READ_DATA_BY_IDENTIFIER, 0x12, 0x34]);
    assert.equal(env.sent[0]?.[2], NRC.REQUEST_OUT_OF_RANGE);
    await env.send([SID.DIAGNOSTIC_SESSION_CONTROL, SESSION.EXTENDED]);
    await env.send([SID.READ_DATA_BY_IDENTIFIER, 0x12, 0x34]);
    assert.equal((env.sent[2] ?? new Uint8Array())[0], P + 0x22);
  });

  test('writes need extended session, a known DID and the writable flag', async () => {
    const env = h();
    await env.send([SID.WRITE_DATA_BY_IDENTIFIER, 0x0c, 0x00, 0x01]);
    assert.equal(env.sent[0]?.[2], NRC.SERVICE_NOT_SUPPORTED_IN_ACTIVE_SESSION);
    await env.send([SID.DIAGNOSTIC_SESSION_CONTROL, SESSION.EXTENDED]);
    await env.send([SID.WRITE_DATA_BY_IDENTIFIER, 0x99, 0x99, 0x01]);
    assert.equal(env.sent[2]?.[2], NRC.REQUEST_OUT_OF_RANGE);
    await env.send([SID.WRITE_DATA_BY_IDENTIFIER, 0x12, 0x34, 0x01]);
    assert.equal(env.sent[3]?.[2], NRC.CONDITIONS_NOT_CORRECT);
    await env.send([SID.WRITE_DATA_BY_IDENTIFIER, 0x0c, 0x00, 0x77, 0x88]);
    assert.deepEqual(Array.from(env.sent[4] ?? []), [P + 0x2e, 0x0c, 0x00]);
    await env.send([SID.READ_DATA_BY_IDENTIFIER, 0x0c, 0x00]);
    assert.deepEqual(Array.from((env.sent[5] ?? new Uint8Array()).subarray(3)), [0x77, 0x88], 'the write is observable');
  });

  test('a truncated write is a format error', async () => {
    const env = h();
    await env.send([SID.WRITE_DATA_BY_IDENTIFIER, 0x0c]);
    assert.equal(env.sent[0]?.[2], NRC.INCORRECT_MESSAGE_LENGTH_OR_INVALID_FORMAT);
  });
});

describe('security access', () => {
  test('odd levels return the seed, correct keys are accepted', async () => {
    const env = h();
    await env.send([SID.SECURITY_ACCESS, 0x01]);
    assert.deepEqual(Array.from(env.sent[0] ?? []), [P + 0x27, 0x01, 0x11, 0x22]);
    await env.send([SID.SECURITY_ACCESS, 0x02, 0x02]);
    assert.equal((env.sent[1] ?? new Uint8Array())[0], P + 0x27);
  });

  test('wrong keys escalate: invalid key → exceed attempts → time delay', async () => {
    const env = h();
    await env.send([SID.SECURITY_ACCESS, 0x02, 0x99]);
    assert.equal(env.sent[0]?.[2], NRC.INVALID_KEY);
    await env.send([SID.SECURITY_ACCESS, 0x02, 0x99]);
    assert.equal(env.sent[1]?.[2], NRC.INVALID_KEY);
    await env.send([SID.SECURITY_ACCESS, 0x02, 0x99]);
    assert.equal(env.sent[2]?.[2], NRC.EXCEED_NUMBER_OF_ATTEMPTS);
    await env.send([SID.SECURITY_ACCESS, 0x01]);
    assert.equal(env.sent[3]?.[2], NRC.REQUIRED_TIME_DELAY_NOT_EXPIRED, 'locked out');
  });

  test('without a securityAccess configuration the service is unsupported', async () => {
    const env = h({ securityAccess: undefined });
    await env.send([SID.SECURITY_ACCESS, 0x01]);
    assert.equal(env.sent[0]?.[2], NRC.SERVICE_NOT_SUPPORTED);
  });
});

describe('misc dispatch', () => {
  test('routine control runs the registered routine', async () => {
    const env = h();
    await env.send([SID.ROUTINE_CONTROL, 0x01, 0x02, 0x03, 0xaa, 0xbb]);
    assert.deepEqual(Array.from(env.sent[0] ?? []), [P + 0x31, 0x01, 0x02, 0x03, 2], 'routine result echoes id + data length');
  });

  test('unsupported services and empty payloads are handled without throwing', async () => {
    const env = h();
    await env.send([0x77]);
    assert.equal(env.sent[0]?.[2], NRC.SERVICE_NOT_SUPPORTED);
    await env.server.handle(new Uint8Array(0));
    assert.equal(env.sent.length, 1, 'empty payload is ignored');
  });

  test('a truncated routine request is a format error; unknown routines are out of range', async () => {
    const env = h();
    await env.send([SID.ROUTINE_CONTROL, 0x01, 0x02]);
    assert.equal(env.sent[0]?.[2], NRC.INCORRECT_MESSAGE_LENGTH_OR_INVALID_FORMAT);
    await env.send([SID.ROUTINE_CONTROL, 0x01, 0xaa, 0xbb]);
    assert.equal(env.sent[1]?.[2], NRC.REQUEST_OUT_OF_RANGE);
  });

  test('a throwing handler becomes GENERAL_REJECT, never a hang', async () => {
    const env = h({
      routines: [
        {
          id: 0x0203,
          run: () => {
            throw new Error('boom');
          },
        },
      ],
    });
    await env.send([SID.ROUTINE_CONTROL, 0x01, 0x02, 0x03]);
    assert.deepEqual(Array.from(env.sent[0] ?? []), [0x7f, 0x31, NRC.GENERAL_REJECT]);
  });
});

describe('response pending (NRC 0x78) simulation', () => {
  test('configured services answer pending first, then positively', async () => {
    let delayCalls = 0;
    const originalSetTimeout = globalThis.setTimeout;
    void originalSetTimeout;
    const env = h({ pendingResponseServices: [SID.READ_DATA_BY_IDENTIFIER], pendingResponseDelayMs: 5 });
    // Patch the module's delay indirectly: count pending stats instead of waiting long.
    await env.send([SID.READ_DATA_BY_IDENTIFIER, 0xf1, 0x90]);
    assert.equal(env.server.stats.pendingResponses, 1);
    assert.equal(env.server.stats.positiveResponses, 1);
    assert.equal(env.sent.length, 2);
    assert.equal(env.sent[0]?.[2], NRC.REQUEST_CORRECTLY_RECEIVED_RESPONSE_PENDING);
    assert.equal((env.sent[1] ?? new Uint8Array())[0], P + 0x22);
    delayCalls++;
    void delayCalls;
  });
});

describe('stats bookkeeping', () => {
  test('positive/negative counters separate cleanly', async () => {
    const env = h();
    await env.send([SID.TESTER_PRESENT, 0x00]);
    await env.send([0x77]);
    assert.deepEqual(env.server.stats, { requests: 2, positiveResponses: 1, negativeResponses: 1, pendingResponses: 0 });
  });
});

describe('lifecycle', () => {
  test('start/stop are idempotent and setDtcStatus creates or updates', async () => {
    const sent: Uint8Array[] = [];
    // Array instead of a bare `let` — TS cannot track closure reassignment and
    // would narrow the variable to `never` after the first read.
    const listeners: Array<(payload: Uint8Array) => void> = [];
    const server = new UdsServer(
      {
        onMessage: (fn) => {
          listeners.push(fn);
          return () => {
            listeners.length = 0;
          };
        },
        send: async (payload) => {
          sent.push(payload);
        },
      },
      { name: 'life', logger },
    );
    server.start();
    server.start();
    listeners[0]?.(new Uint8Array([SID.TESTER_PRESENT, 0x00]));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 1, 'double start registers the listener only once');
    server.stop();
    server.stop();
    server.setDtcStatus('P0299', 0x08);
    server.setDtcStatus('P0299', 0x09);
    // visible via readDtc:
    server.start();
    listeners[0]?.(new Uint8Array([SID.READ_DTC_INFORMATION, DTC_REPORT.REPORT_SUPPORTED_DTC]));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent[1]?.length, 3 + 4, 'one updated DTC (4 bytes) + header');
  });
});

beforeEach(() => undefined);
