/**
 * Protocol conformance tests (AGENTS 31.3).
 *
 * These exercise the wire behaviour of ISO 15765-2 and ISO 14229-1 against a
 * scripted peer built from the public simulator API — no vehicle, no adapter.
 * Every case here is a behaviour a real ECU is allowed to produce, so a failure
 * means we would misread a real car.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogger, fromHex, toHex } from '@vdp/shared';
import { IsoTpConnection } from '@vdp/transport-iso-tp';
import { createVirtualCanNetwork } from '@vdp/simulators';
import type { CanFrame } from '@vdp/transport-can';

const logger = createLogger('protocol', { level: 'ERROR' });

interface Pair {
  /** Frames the ECU side received from the tester, in order. */
  received: CanFrame[];
  /** Send a raw frame from the ECU side. */
  emit(payload: Uint8Array, opts?: { id?: number }): void;
  /** Wait until the ECU side has seen at least `count` frames. */
  waitFor(count: number, timeoutMs?: number): Promise<void>;
  /** The tester side ISO-TP connection under test. */
  connection: IsoTpConnection;
}

/**
 * One shared virtual network with a scripted ECU on one side and the ISO-TP
 * connection under test on the other.
 *
 * Both buses must live on the *same* network instance — two separately created
 * networks are two isolated buses that never meet, which silently turns every
 * wire assertion into a timeout.
 */
function createPair(channel: string, overrides: Record<string, unknown> = {}): Pair {
  const network = createVirtualCanNetwork({ channel });
  const testerBus = network.createBus('tester');
  const ecuBus = network.createBus('ecu');
  const received: CanFrame[] = [];
  const waiters: Array<() => void> = [];

  void testerBus.open();
  void ecuBus.open();
  ecuBus.subscribe((frame) => {
    received.push(frame);
    for (const waiter of waiters.splice(0)) waiter();
  });

  const connection = new IsoTpConnection(testerBus, { txId: 0x7e0, rxId: 0x7e8, channel, ...overrides }, logger);
  connection.open();

  return {
    received,
    connection,
    emit(payload, opts = {}) {
      void ecuBus.send({
        timestamp: Date.now(),
        id: opts.id ?? 0x7e8,
        extended: false,
        fd: false,
        dlc: payload.length,
        payload,
        channel,
        direction: 'tx',
      });
    },
    async waitFor(count, timeoutMs = 1000) {
      const deadline = Date.now() + timeoutMs;
      while (received.length < count) {
        if (Date.now() > deadline) throw new Error(`ECU side saw only ${received.length}/${count} frames`);
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 5);
        });
      }
    },
  };
}

const flowStatus = (frame: CanFrame | undefined): number => ((frame?.payload[0] ?? 0xff) >> 4);

test('a single frame request is padded to eight bytes and answered in kind', async () => {
  const pair = createPair('proto-sf', { padding: true, padByte: 0xaa });

  const pending = pair.connection.request(fromHex('22 F1 90'), 500);
  await pair.waitFor(1);
  assert.equal(toHex(pair.received[0]?.payload ?? new Uint8Array()), '03 22 F1 90 AA AA AA AA');

  pair.emit(fromHex('07 62 F1 90 31 48 47 43'));
  const response = await pending;
  assert.equal(toHex(response), '62 F1 90 31 48 47 43');
});

test('a long response is reassembled from first and consecutive frames', async () => {
  const pair = createPair('proto-ff');

  const pending = pair.connection.request(fromHex('22 F1 90'), 1000);
  await pair.waitFor(1);

  // 20 byte payload: 62 F1 90 plus the 17 byte VIN
  pair.emit(fromHex('10 14 62 F1 90 31 48 47'));
  await pair.waitFor(2);
  assert.equal(flowStatus(pair.received[1]), 3, 'a first frame must be answered with flow control');

  pair.emit(fromHex('21 43 4D 38 32 36 33 33'));
  pair.emit(fromHex('22 41 30 30 34 33 35 32'));

  const response = await pending;
  assert.equal(response.length, 20);
  assert.equal(toHex(response), '62 F1 90 31 48 47 43 4D 38 32 36 33 33 41 30 30 34 33 35 32');
});

test('block size limits how many consecutive frames the tester accepts at once', async () => {
  const pair = createPair('proto-bs', { timing: { blockSize: 2 } });

  // 27 bytes need three consecutive frames (6 + 7 + 7 + 7), so with a block size
  // of two the tester must ask for permission again part way through.
  const pending = pair.connection.request(fromHex('22 F1 90'), 2000);
  await pair.waitFor(1);
  pair.emit(fromHex('10 1B 62 F1 90 41 42 43'));
  await pair.waitFor(2);
  assert.equal(flowStatus(pair.received[1]), 3, 'the first frame must be answered with flow control');

  pair.emit(fromHex('21 44 45 46 47 48 49 4A'));
  pair.emit(fromHex('22 4B 4C 4D 4E 4F 50 51'));
  await pair.waitFor(3);
  assert.equal(flowStatus(pair.received[2]), 3, 'a second flow control must follow the exhausted block');

  pair.emit(fromHex('23 52 53 54 55 56 57 58'));

  const response = await pending;
  assert.equal(response.length, 27);
  assert.equal(toHex(response), '62 F1 90 41 42 43 44 45 46 47 48 49 4A 4B 4C 4D 4E 4F 50 51 52 53 54 55 56 57 58');
});

test('a Wait flow control from the tester does not abort the transfer', async () => {
  const pair = createPair('proto-wait', { timing: { blockSize: 1, stMinMs: 0 } });

  const payload = new Uint8Array(40).fill(0x5a);
  const pending = pair.connection.sendOnly(payload).then(() => 'sent');

  await pair.waitFor(1);
  assert.equal(flowStatus(pair.received[0]), 1, 'the transfer must open with a first frame');

  pair.emit(fromHex('31 00 00 00 00 00 00 00')); // Wait
  pair.emit(fromHex('30 00 00 00 00 00 00 00')); // Continue, block size 0

  assert.equal(await pending, 'sent');
  const consecutive = pair.received.filter((frame) => flowStatus(frame) === 2);
  assert.ok(consecutive.length >= 4, `expected the remaining frames to be sent, got ${consecutive.length}`);
});

test('a payload longer than 4095 bytes uses the escape sequence in the first frame', async () => {
  const pair = createPair('proto-escape', { fd: true });

  const payload = new Uint8Array(5000).fill(0x11);
  const pending = pair.connection.sendOnly(payload).then(() => 'sent');
  await pair.waitFor(1);

  const firstFrame = pair.received[0]?.payload ?? new Uint8Array();
  assert.equal(firstFrame[0] ?? 0, 0x10, 'the low nibble must be zero to signal the escape sequence');
  const announced = ((firstFrame[2] ?? 0) << 24) | ((firstFrame[3] ?? 0) << 16) | ((firstFrame[4] ?? 0) << 8) | (firstFrame[5] ?? 0);
  assert.equal(announced, 5000, 'the 32-bit length field must carry the real length');

  pair.emit(fromHex('30 00 00 00 00 00 00 00'));
  assert.equal(await pending, 'sent');
});

test('frameCountFor accounts for first frame and consecutive frames', () => {
  const { connection } = createPair('proto-count');
  assert.equal(connection.frameCountFor(7), 1, 'seven bytes fit in one single frame');
  assert.equal(connection.frameCountFor(8), 2, 'eight bytes need a first plus a consecutive frame');
  // A first frame carries 6 payload bytes, each consecutive frame 7.
  assert.equal(connection.frameCountFor(20), 3, 'a 20 byte VIN response spans 6 + 7 + 7 bytes');
  assert.equal(connection.frameCountFor(21), 4, 'one byte more needs a fourth frame');
});

test('a missing flow control surfaces as N_Bs timeout rather than hanging', async () => {
  const pair = createPair('proto-nbs', { timing: { nBsMs: 60, maxRetries: 0 } });

  const payload = new Uint8Array(60).fill(0x22);
  await assert.rejects(pair.connection.sendOnly(payload), /N_Bs|flow control/i);
  assert.ok(pair.received.length >= 1, 'the first frame must have been attempted');
});

test('sequence numbers wrap from 0xF back to 0x0 across a long transfer', async () => {
  const pair = createPair('proto-seq');

  // 16 consecutive frames are needed to observe the wrap (1..15, then 0).
  const payload = new Uint8Array(6 + 16 * 7).fill(0x33);
  const pending = pair.connection.sendOnly(payload).then(() => 'sent');
  await pair.waitFor(1);
  pair.emit(fromHex('30 00 00 00 00 00 00 00'));
  assert.equal(await pending, 'sent');

  const sequences = pair.received.filter((frame) => flowStatus(frame) === 2).map((frame) => (frame.payload[0] ?? 0) & 0x0f);
  assert.equal(sequences.length, 16, `expected 16 consecutive frames, got ${sequences.length}`);
  assert.deepEqual(sequences.slice(0, 15), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.equal(sequences[15], 0, 'the sequence counter must wrap to zero');
});

test('extended addressing prepends the address byte to every frame', async () => {
  const pair = createPair('proto-ae', { addressing: 'extended', targetAddress: 0xf1 });

  await pair.connection.sendOnly(fromHex('3E 00'));
  await pair.waitFor(1);

  const sent = pair.received[0]?.payload ?? new Uint8Array();
  assert.equal(sent[0], 0xf1, 'the target address must precede the PCI byte');
  assert.equal(sent[1] ?? 0, 0x02, 'the single frame length follows the address byte');
});

test('unsolicited frames reach the listener instead of being dropped', async () => {
  const pair = createPair('proto-unsolicited');

  const seen: Uint8Array[] = [];
  pair.connection.onUnsolicited((payload) => seen.push(payload));
  pair.emit(fromHex('03 7F 3E 11'));

  const deadline = Date.now() + 500;
  while (seen.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(seen.length, 1);
  assert.equal(toHex(seen[0] ?? new Uint8Array()), '7F 3E 11');
});
