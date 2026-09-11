/**
 * Replay transport tests (AGENTS 31.5) — unit level.
 *
 * The replay bus is the backbone of the fixture-driven replay suite: request/
 * response grouping, deviation reporting and the session-JSON import path are
 * all contract here.
 */

import assert from 'node:assert/strict';
import { describe, expect, test } from 'vitest';
import { createFrame } from './frame.js';
import { ReplayTransport, recordingFromSessionJson, type ReplayFrameEntry } from './replay.js';
import { createLogger } from '@vdp/shared';

const logger = createLogger('replay-test', { level: 'ERROR' });

function entry(t: number, canId: number, direction: 'tx' | 'rx', payload: number[]): ReplayFrameEntry {
  return { t, canId, direction, payload: new Uint8Array(payload) };
}

function transport(frames: ReplayFrameEntry[], options: ConstructorParameters<typeof ReplayTransport>[1] = {}) {
  return new ReplayTransport({ channel: 'replay-test', frames }, { logger, ...options });
}

async function drained(transportInstance: ReplayTransport): Promise<void> {
  await transportInstance.open();
  // Awaiting one macrotask lets queued deliveries land.
  await new Promise((resolve) => setImmediate(resolve));
}

describe('exchange matching', () => {
  test('a sent request is answered with its recorded response, exactly once', async () => {
    const replay = transport([entry(0, 0x7e0, 'tx', [0x22, 0xf1, 0x90]), entry(5, 0x7e8, 'rx', [0x62, 0xf1, 0x90, 0x57])]);
    const received: Array<ReturnType<typeof createFrame>> = [];
    await drained(replay);
    replay.subscribe((frame) => received.push(frame));
    await replay.send(createFrame(0x7e0, new Uint8Array([0x22, 0xf1, 0x90])));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(received.length, 1);
    assert.equal(received[0]?.id, 0x7e8);
    assert.deepEqual(Array.from(received[0]?.payload ?? []), [0x62, 0xf1, 0x90, 0x57]);
    assert.equal(received[0]?.direction, 'rx');
    assert.equal(replay.stats.matched, 1);
    assert.equal(replay.stats.delivered, 1);
    assert.equal(replay.unusedExchanges().length, 0);
  });

  test('a changed request is answered from the recording but reported as a deviation', async () => {
    const replay = transport([entry(0, 0x7e0, 'tx', [0x10, 0x03]), entry(5, 0x7e8, 'rx', [0x50, 0x03])]);
    await drained(replay);
    await replay.send(createFrame(0x7e0, new Uint8Array([0x22, 0xf1, 0x90])));
    assert.equal(replay.stats.matched, 1, 'default mode answers anyway');
    assert.equal(replay.stats.delivered, 1);
    assert.equal(replay.deviations.length, 1);
    assert.equal(replay.deviations[0]?.kind, 'payload-differs');
    assert.match(replay.deviations[0]?.message ?? '', /payload differs/);
  });

  test('a request the recording never saw is of kind no-recorded-request', async () => {
    const replay = transport([entry(0, 0x7e0, 'tx', [0x10, 0x03])]);
    await drained(replay);
    await replay.send(createFrame(0x123, new Uint8Array([0x01])));
    assert.equal(replay.deviations[0]?.kind, 'no-recorded-request');
  });

  test('strict mode (matchByIdOnly: false) refuses to answer on a payload mismatch', async () => {
    const replay = transport([entry(0, 0x7e0, 'tx', [0x10, 0x03]), entry(5, 0x7e8, 'rx', [0x50, 0x03])], { matchByIdOnly: false });
    await drained(replay);
    await replay.send(createFrame(0x7e0, new Uint8Array([0x22, 0xf1, 0x90])));
    assert.equal(replay.stats.delivered, 0);
    assert.equal(replay.deviations[0]?.kind, 'payload-differs');
    assert.ok(replay.deviations[0]?.recordedPayload);
  });

  test('each recorded exchange is consumed once; the second identical request goes unmatched', async () => {
    const frames = [
      entry(0, 0x7e0, 'tx', [0x3e, 0x00]),
      entry(2, 0x7e8, 'rx', [0x7e, 0x00]),
    ];
    const replay = transport(frames);
    await drained(replay);
    await replay.send(createFrame(0x7e0, new Uint8Array([0x3e, 0x00])));
    await replay.send(createFrame(0x7e0, new Uint8Array([0x3e, 0x00])));
    assert.equal(replay.stats.matched, 1);
    assert.equal(replay.stats.unmatched, 1);
    assert.equal(replay.unusedExchanges().length, 0);
  });

  test('rx frames before any tx are ambient traffic and never replayed as responses', () => {
    const replay = transport([entry(0, 0x123, 'rx', [0x01])]);
    assert.equal(replay.unusedExchanges().length, 0);
    assert.equal(replay.durationMs, 0);
  });

  test('multi-frame responses are delivered in recorded order with the recorded clock', async () => {
    const replay = transport([
      entry(0, 0x7e0, 'tx', [0x22, 0xf1, 0x90]),
      entry(4, 0x7e8, 'rx', [0x10, 0x14, 0x62, 0xf1, 0x90, 0x31]),
      entry(8, 0x7e8, 'rx', [0x21, 0x48, 0x47]),
      entry(12, 0x7e8, 'rx', [0x22, 0x4d, 0x38]),
    ]);
    const received: number[][] = [];
    await drained(replay);
    replay.subscribe((frame) => received.push(Array.from(frame.payload)));
    await replay.send(createFrame(0x7e0, new Uint8Array([0x22, 0xf1, 0x90])));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(received, [
      [0x10, 0x14, 0x62, 0xf1, 0x90, 0x31],
      [0x21, 0x48, 0x47],
      [0x22, 0x4d, 0x38],
    ]);
    assert.equal(replay.durationMs, 12);
  });

  test('sending while closed throws', async () => {
    const replay = transport([entry(0, 0x7e0, 'tx', [0x10])]);
    await assert.rejects(() => replay.send(createFrame(0x7e0, new Uint8Array([0x10]))), /not open/);
  });
});

describe('session JSON import', () => {
  test('a vdp.session export converts into a replayable recording', async () => {
    const session = {
      format: 'vdp.session',
      formatVersion: 1,
      trace: [
        { t: 0, canId: 0x7e0, direction: 'tx', payload: '10 03', channel: 'can0', extended: false, fd: false },
        { t: 12, canId: 0x7e8, direction: 'rx', payload: '5003' },
      ],
    };
    const replay = new ReplayTransport(recordingFromSessionJson(JSON.stringify(session)), { logger });
    await drained(replay);
    const received: number[][] = [];
    replay.subscribe((frame) => received.push(Array.from(frame.payload)));
    await replay.send(createFrame(0x7e0, new Uint8Array([0x10, 0x03])));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(received, [[0x50, 0x03]]);
  });

  test('a foreign format is rejected with a clear error', () => {
    assert.throws(() => recordingFromSessionJson(JSON.stringify({ format: 'candump' })), /not a vdp\.session/);
  });
});
