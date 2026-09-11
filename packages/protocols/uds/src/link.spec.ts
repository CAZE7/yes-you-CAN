/**
 * UDS transport binding tests (AGENTS 5, 36).
 *
 * `UdsLink` is the seam that makes the UDS engine transport independent: the
 * structural checks and the byte-transport bridge are covered here so any new
 * transport (DoIP, gateway, replay) plugs in without touching the core.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { TransportClosedError } from '@vdp/shared';
import { IsoTpConnection } from '@vdp/transport-iso-tp';
import { isUdsLink } from './link.js';
import { RequestResponseLink, createRequestResponseLink, isMessageTransport } from './link-adapter.js';
import type { CanBus } from '@vdp/transport-can';

describe('isUdsLink / isMessageTransport', () => {
  test('structural checks accept complete objects only', () => {
    assert.equal(isUdsLink({ request: () => undefined, sendOnly: () => undefined, receive: () => undefined }), true);
    assert.equal(isUdsLink({ request: () => undefined }), false);
    assert.equal(isUdsLink(null), false);
    assert.equal(isMessageTransport({ send: () => undefined, receive: () => undefined }), true);
    assert.equal(isMessageTransport({ send: () => undefined }), false);
    assert.equal(isMessageTransport('nope'), false);
  });

  test('an IsoTpConnection satisfies UdsLink structurally (ISO 15765-2 case)', () => {
    const fakeBus = {
      info: { id: 'x', kind: 'virtual', name: 'x', channels: [] },
      capabilities: { can: true, canFd: false, doip: false, isoTpOffload: false, channels: 1 },
      open: async () => undefined,
      close: async () => undefined,
      isOpen: () => false,
      send: async () => undefined,
      subscribe: () => () => undefined,
    } as unknown as CanBus;
    assert.equal(isUdsLink(new IsoTpConnection(fakeBus, { txId: 0x7e0, rxId: 0x7e8 })), true);
  });
});

describe('RequestResponseLink', () => {
  interface FakeTransportOptions {
    response?: Uint8Array | null;
    failSend?: boolean;
  }

  function fakeTransport(options: FakeTransportOptions = {}) {
    const sent: Uint8Array[] = [];
    return {
      sent,
      async send(data: Uint8Array) {
        if (options.failSend) throw new Error('link down');
        sent.push(data);
      },
      async receive() {
        return options.response ?? null;
      },
    };
  }

  test('sendOnly and the responsePending tail are serialised too (AGENTS 15)', async () => {
    // This bridge is what every non-ISO-TP transport (DoIP, replay, gateway) plugs
    // into, so the one-request-per-session rule has to live here as well: a functional
    // send, or the deferred answer after NRC 0x78, must not cut into an open
    // transaction — otherwise the answer is handed to the wrong caller.
    const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
    const sent: Uint8Array[] = [];
    const waiters: Array<(value: Uint8Array | null) => void> = [];
    const transport = {
      async send(data: Uint8Array): Promise<void> {
        sent.push(data);
      },
      receive(): Promise<Uint8Array | null> {
        return new Promise<Uint8Array | null>((resolve) => {
          waiters.push(resolve);
        });
      },
    };
    const settle = (bytes: Uint8Array | null): void => {
      waiters.shift()?.(bytes);
    };
    const link = new RequestResponseLink(transport);

    const request = link.request(new Uint8Array([0x22, 0xf1, 0x90]));
    await tick();
    settle(new Uint8Array([0x7f, 0x22, 0x78]));
    assert.deepEqual(Array.from(await request), [0x7f, 0x22, 0x78]);

    const tail = link.receive();
    const testerPresent = link.sendOnly(new Uint8Array([0x3e, 0x00]));
    await tick();
    assert.deepEqual(sent.map((frame) => Array.from(frame)), [[0x22, 0xf1, 0x90]], 'the TesterPresent waits behind the open transaction');
    settle(new Uint8Array([0x62, 0xf1, 0x90, 0x11]));
    assert.deepEqual(Array.from((await tail) ?? new Uint8Array()), [0x62, 0xf1, 0x90, 0x11], 'the deferred answer reaches its own waiter');
    await testerPresent;
    assert.deepEqual(sent.map((frame) => Array.from(frame)), [[0x22, 0xf1, 0x90], [0x3e, 0x00]], 'and it is sent afterwards, not in the gap');
  });

  test('request sends, awaits and returns the response; stats track the exchange', async () => {
    const transport = fakeTransport({ response: new Uint8Array([0x50, 0x03]) });
    const link = new RequestResponseLink(transport, { defaultTimeoutMs: 1234 });
    const response = await link.request(new Uint8Array([0x10, 0x03]));
    assert.deepEqual(Array.from(response), [0x50, 0x03]);
    assert.deepEqual(link.stats, { requests: 1, responses: 1, timeouts: 0 });
  });

  test('a null receive is a timeout (TransportClosedError) counted in stats', async () => {
    const link = new RequestResponseLink(fakeTransport({ response: null }), { defaultTimeoutMs: 42 });
    await assert.rejects(() => link.request(new Uint8Array([0x10, 0x03])), TransportClosedError);
    assert.deepEqual(link.stats, { requests: 1, responses: 0, timeouts: 1 });
  });

  test('a failed send propagates and releases the serialisation lock', async () => {
    const link = new RequestResponseLink(fakeTransport({ failSend: true }));
    await assert.rejects(() => link.request(new Uint8Array([0x10])), /link down/);
    // The lock must be released: a follow-up request reaches the transport.
    const working = new RequestResponseLink(fakeTransport({ response: new Uint8Array([0x50]) }));
    await working.request(new Uint8Array([0x10]));
    assert.equal(working.stats.responses, 1);
  });

  test('requests are serialised even when issued concurrently (AGENTS 15)', async () => {
    const order: string[] = [];
    // Array indirection: TS cannot track the closure reassignment of a bare
    // `let` and would narrow it to `never` after the first optional call.
    const resolvers: Array<() => void> = [];
    const transport = {
      async send() {
        order.push('send');
      },
      async receive() {
        if (resolvers.length === 0) {
          await new Promise<void>((resolve) => {
            resolvers.push(resolve);
          });
        }
        return new Uint8Array([0x50]);
      },
    };
    const link = new RequestResponseLink(transport);
    const first = link.request(new Uint8Array([0x01]));
    const second = link.request(new Uint8Array([0x02]));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ['send'], 'the second request waits for the first');
    resolvers[0]?.();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['send', 'send']);
  });

  test('sendOnly bypasses the response expectation; receive proxies the transport', async () => {
    const transport = fakeTransport({ response: new Uint8Array([0x7f]) });
    const link = createRequestResponseLink(transport);
    await link.sendOnly(new Uint8Array([0x3e, 0x00]));
    assert.equal(transport.sent.length, 1);
    assert.deepEqual(Array.from((await link.receive(10)) as Uint8Array), [0x7f]);
  });

  test('factory returns a structurally valid UdsLink', () => {
    assert.equal(isUdsLink(createRequestResponseLink(fakeTransport())), true);
  });
});
