/**
 * Live data engine tests (AGENTS 15).
 *
 * Determinism: no real timers — maxRounds bounds the run and the injectable
 * clock/stubbed readers replace real ECUs. Unit tests never touch a transport.
 */

import assert from 'node:assert/strict';
import { describe, expect, test, vi } from 'vitest';
import { createLogger, toHex } from '@vdp/shared';
import type { SignalDefinition } from '@vdp/definitions';
import type { DecodedSignal } from './decoder.js';
import type { MeasurementRecorder } from './recorder.js';
import { LiveDataEngine, type EcuReader } from './live.js';

const logger = createLogger('live-test', { level: 'ERROR' });

function signal(did: number, id = `engine.did_${did.toString(16)}`): SignalDefinition {
  return { id, name: id, ecu: 'engine', did, byteOffset: 0, length: 2, encoding: 'uint16' };
}

function fakeRecorder(): MeasurementRecorder & { samples: Array<{ signal: string; at: number }> } {
  const samples: Array<{ signal: string; at: number }> = [];
  return {
    samples,
    record(decodedSignal: DecodedSignal, at: number) {
      samples.push({ signal: decodedSignal.signalId, at });
      return {
        timestamp: new Date(at).toISOString(),
        t: at,
        signal: decodedSignal.signalId,
        value: decodedSignal.value,
        rawValue: decodedSignal.rawValue,
        rawHex: decodedSignal.rawHex,
        outOfRange: false,
      };
    },
  } as unknown as MeasurementRecorder & { samples: Array<{ signal: string; at: number }> };
}

function reader(ecuId: string, payloads: Map<number, Uint8Array | null>, throws: number[] = []): EcuReader & { calls: number[] } {
  const calls: number[] = [];
  return {
    ecuId,
    calls,
    async readRaw(did: number) {
      calls.push(did);
      if (throws.includes(did)) throw new Error('bus off');
      return payloads.get(did) ?? null;
    },
  };
}

function decodeAll(signalDef: SignalDefinition, payload: Uint8Array): DecodedSignal | null {
  const value = (payload[0] ?? 0) * 256 + (payload[1] ?? 0);
  return {
    signalId: signalDef.id,
    name: signalDef.name,
    raw: payload,
    rawHex: toHex(payload),
    rawValue: value,
    value,
    outOfRange: false,
    did: signalDef.did,
    ecu: signalDef.ecu,
  };
}

describe('LiveDataEngine', () => {
  test('polls each ECU serially per round and groups signals by DID', async () => {
    const recorder = fakeRecorder();
    const engine = new LiveDataEngine(decodeAll, recorder as unknown as MeasurementRecorder, { maxRounds: 2, intervalMs: 1, logger });
    const readerA = reader('engine', new Map([[0x0c, new Uint8Array([0x09, 0x60])]]));
    const enginePlan = new Map<string, readonly SignalDefinition[]>([
      ['engine', [signal(0x0c, 'engine.rpm'), signal(0x0c, 'engine.rpm2'), signal(0x05, 'engine.coolant')]],
    ]);
    const stats = await engine.run([readerA], enginePlan);
    assert.equal(stats.rounds, 2);
    // One DID read per round even when several signals share it.
    assert.deepEqual(readerA.calls, [0x0c, 0x05, 0x0c, 0x05]);
    assert.equal(stats.samples, 4, 'rpm + rpm2 + coolant per round');
    assert.equal(engine.statistics.rounds, 2);
    expect(engine.isRunning).toBe(false);
  });

  test('missing payloads and reader errors become per-DID errors, not crashes', async () => {
    const recorder = fakeRecorder();
    const engine = new LiveDataEngine(decodeAll, recorder as unknown as MeasurementRecorder, { maxRounds: 1, intervalMs: 1, logger });
    const flaky = reader(
      'engine',
      new Map([
        [0x0c, null],
        [0x05, new Uint8Array([0x32])],
      ]),
      [0x11],
    );
    const result = await engine.run([flaky], new Map([['engine', [signal(0x0c), signal(0x05), signal(0x11)]]]));
    assert.equal(result.rounds, 1);
    assert.equal(engine.statistics.errors, 2, 'null payload + thrown read');
    assert.equal(engine.statistics.samples, 1);
    assert.ok(flaky.calls.includes(0x11));
  });

  test('ECUs with an empty plan are skipped entirely', async () => {
    const recorder = fakeRecorder();
    const engine = new LiveDataEngine(decodeAll, recorder as unknown as MeasurementRecorder, { maxRounds: 1, intervalMs: 1, logger });
    const idle = reader('idle', new Map());
    const active = reader('engine', new Map([[0x0c, new Uint8Array([0x01, 0x02])]]));
    await engine.run([idle, active], new Map([['engine', [signal(0x0c)]]]));
    assert.deepEqual(idle.calls, []);
    assert.deepEqual(active.calls, [0x0c]);
  });

  test('round listeners see every result; stop() ends the loop after the current round', async () => {
    const recorder = fakeRecorder();
    const engine = new LiveDataEngine(decodeAll, recorder as unknown as MeasurementRecorder, { intervalMs: 1, logger });
    const results: number[] = [];
    const off = engine.onRound((result) => {
      results.push(result.round);
      engine.stop();
    });
    const active = reader('engine', new Map([[0x0c, new Uint8Array([0x00, 0x64])]]));
    await engine.run([active], new Map([['engine', [signal(0x0c)]]]));
    assert.deepEqual(results, [1]);
    off();
    const resultsAfterOff: number[] = [];
    engine.onRound((result) => resultsAfterOff.push(result.round));
    assert.deepEqual(resultsAfterOff, []);
  });

  test('double start is rejected', async () => {
    const recorder = fakeRecorder();
    const engine = new LiveDataEngine(decodeAll, recorder as unknown as MeasurementRecorder, { logger });
    const run = engine.run([reader('engine', new Map([[0x0c, new Uint8Array([0, 1])]]))], new Map([['engine', [signal(0x0c)]]]));
    await assert.rejects(() => engine.run([], new Map()), /already running/);
    engine.stop();
    await run;
  });

  test('averageRoundMs tracks the injectable clock', async () => {
    let now = 0;
    const recorder = fakeRecorder();
    const engine = new LiveDataEngine(decodeAll, recorder as unknown as MeasurementRecorder, { maxRounds: 2, intervalMs: 0, logger, clock: () => now });
    const active = reader('engine', new Map([[0x0c, new Uint8Array([0x00, 0x64])]]));
    const originalPoll = engine['pollEcu']?.bind(engine);
    void originalPoll;
    // Advance the clock from inside the round listener (between rounds).
    engine.onRound((result) => {
      now = result.round * 25;
    });
    const stats = await engine.run([active], new Map([['engine', [signal(0x0c)]]]));
    assert.equal(stats.averageRoundMs, 25);
  });
});
