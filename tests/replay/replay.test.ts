/**
 * Replay tests (AGENTS 31.5).
 *
 * A recorded session is played back through the replay transport and must decode
 * to exactly the same values. This is what makes protocol work safe to change:
 * the recording is the witness.
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createLogger } from '@vdp/shared';
import { ReplayTransport, recordingFromSessionJson } from '@vdp/transport-can';
import { IsoTpConnection } from '@vdp/transport-iso-tp';
import { DiagnosticEngine, SessionLogger, SignalDecoder } from '@vdp/core';
import { UdsClient } from '@vdp/protocols-uds';
import { genericPackage } from '@vdp/definitions';
import { VirtualVehicle } from '@vdp/simulators';

const logger = createLogger('replay', { level: 'ERROR' });
const VIN = '1HGCM82633A004352';

interface Recording {
  json: string;
  /** Decoded values captured during the live run, for comparison. */
  values: Array<{ signal: string; value: number | string | boolean }>;
  vin: string | null;
  traceFrames: number;
}

/** Run a real diagnostic session against the simulator and record every frame. */
async function recordSession(): Promise<Recording> {
  const sessionLogger = new SessionLogger();
  const vehicle = new VirtualVehicle({
    vin: VIN,
    definitions: genericPackage,
    logger,
    // Both directions must be recorded, otherwise half the conversation is lost.
    networkOptions: { echoToSender: true },
  });
  await vehicle.start();

  const unsubscribe = vehicle.testerBus.subscribe((frame) => {
    sessionLogger.recordFrame(frame);
  });

  const engine = new DiagnosticEngine({ bus: vehicle.testerBus, definitions: [genericPackage], logger });
  await engine.connect();
  const identity = await engine.detectVehicleIdentity();
  const snapshot = await engine.snapshotSignals();

  const { samples, markers } = engine.recorder.export();
  const trace = sessionLogger.snapshot().trace;
  const json = SessionLogger.toJson({
    meta: { sessionId: engine.vehicleSession?.data.id ?? 'test', vin: VIN },
    samples,
    markers,
    dtcs: [],
    trace,
    log: sessionLogger.snapshot().log,
  });

  const values = snapshot
    .filter((signal): signal is NonNullable<typeof signal> => signal !== null && signal !== undefined)
    .map((signal) => ({ signal: signal.signalId, value: signal.value }));

  unsubscribe();
  await engine.disconnect();
  await vehicle.stop();

  return {
    json,
    values,
    vin: identity?.vin ?? null,
    traceFrames: trace.length,
  };
}

test('a recorded session contains both directions of the conversation', async () => {
  const recording = await recordSession();
  const parsed = JSON.parse(recording.json) as { trace: Array<{ direction: string }> };
  const directions = new Set(parsed.trace.map((entry) => entry.direction));
  assert.ok(directions.has('tx'), 'the tester requests must be recorded');
  assert.ok(directions.has('rx'), 'the ECU responses must be recorded');
  assert.ok(recording.traceFrames > 10, `expected a substantial trace, got ${recording.traceFrames} frames`);
  assert.equal(recording.vin, VIN);
});

test('a session export round-trips into a replay recording', async () => {
  const recording = await recordSession();
  const replayRecording = recordingFromSessionJson(recording.json);
  assert.ok(replayRecording.frames.length > 10);
  assert.ok(
    replayRecording.frames.every((frame) => frame.payload instanceof Uint8Array),
    'payloads must be decoded back to bytes',
  );
  assert.ok(replayRecording.frames.some((frame) => frame.direction === 'tx'));
});

test('a non-session export is rejected instead of replaying garbage', () => {
  assert.throws(() => recordingFromSessionJson(JSON.stringify({ format: 'something-else', trace: [] })), /not a vdp.session export/);
});

test('the same requests replayed from the recording yield the same responses', async () => {
  const recording = await recordSession();
  const replayRecording = recordingFromSessionJson(recording.json);
  const bus = new ReplayTransport(replayRecording, { logger, immediate: true });
  await bus.open();

  const connection = new IsoTpConnection(bus, { txId: 0x7e0, rxId: 0x7e8, channel: 'vcan0' }, logger);
  connection.open();
  const client = new UdsClient(connection, { name: 'replayed-engine' });

  const vin = await client.readVin();
  assert.equal(vin, VIN, 'the replayed VIN must match the recorded one');

  const serial = await client.readDid(0xf18c);
  assert.ok(serial && serial.length > 0, 'the serial number DID must be answered from the recording');

  assert.equal(bus.deviations.length, 0, `replay must not deviate: ${JSON.stringify(bus.deviations)}`);
  assert.ok(bus.stats.matched >= 2, `expected matched exchanges, got ${JSON.stringify(bus.stats)}`);
  await bus.close();
});

test('replayed values decode identically to the live run', async () => {
  const recording = await recordSession();
  const replayRecording = recordingFromSessionJson(recording.json);
  const bus = new ReplayTransport(replayRecording, { logger, immediate: true });
  await bus.open();

  const connection = new IsoTpConnection(bus, { txId: 0x7e0, rxId: 0x7e8, channel: 'vcan0' }, logger);
  connection.open();
  const client = new UdsClient(connection, { name: 'replayed-engine' });
  const decoder = new SignalDecoder({ logger });

  // engine.coolant_temperature is a single byte at DID 0xF405 — a stable value.
  const signal = genericPackage.signals.find((candidate) => candidate.id === 'engine.coolant_temperature');
  assert.ok(signal, 'the definition must contain engine.coolant_temperature');

  const raw = await client.readDid(signal.did);
  assert.ok(raw, 'the recorded DID response must be replayed');
  const decoded = decoder.decode(signal, raw);
  assert.ok(decoded, 'the replayed bytes must decode');

  const live = recording.values.find((entry) => entry.signal === 'engine.coolant_temperature');
  assert.ok(live, 'the live run must have captured the same signal');
  assert.equal(decoded.value, live.value, 'replay must decode to the recorded value');
  await bus.close();
});

test('a request on an identifier the recording never used is reported', async () => {
  const recording = await recordSession();
  const replayRecording = recordingFromSessionJson(recording.json);
  const bus = new ReplayTransport(replayRecording, { logger, immediate: true, matchByIdOnly: false });
  await bus.open();

  // 0x6FF is not part of the recorded conversation at all, so there is no
  // exchange to fall back on — this is the "no recorded request" case. A request
  // on a *known* identifier with different bytes is the payload case instead.
  const connection = new IsoTpConnection(bus, { txId: 0x6ff, rxId: 0x6fe, channel: 'vcan0' }, logger);
  connection.open();
  const client = new UdsClient(connection, { name: 'replayed-unknown', timing: { p2Ms: 40 } });

  await assert.rejects(client.readDid(0xf190));
  assert.ok(bus.deviations.length > 0, 'an unknown request must be reported, not silently ignored');
  assert.equal(bus.deviations[0]?.kind, 'no-recorded-request');
  assert.equal(bus.deviations[0]?.canId, 0x6ff);
  await bus.close();
});

test('replaying twice reports the exchanges the second run never used', async () => {
  const recording = await recordSession();
  const replayRecording = recordingFromSessionJson(recording.json);
  const bus = new ReplayTransport(replayRecording, { logger, immediate: true });
  await bus.open();

  const connection = new IsoTpConnection(bus, { txId: 0x7e0, rxId: 0x7e8, channel: 'vcan0' }, logger);
  connection.open();
  const client = new UdsClient(connection, { name: 'replayed-engine' });
  await client.readVin();

  const unused = bus.unusedExchanges();
  assert.ok(unused.length > 0, 'a single DID read cannot consume a whole recorded session');
  assert.ok(bus.durationMs > 0, 'the recording must expose its duration');
  await bus.close();
});

test('a changed request payload is reported when matching strictly', async () => {
  const recording = await recordSession();
  const replayRecording = recordingFromSessionJson(recording.json);
  const bus = new ReplayTransport(replayRecording, { logger, immediate: true, matchByIdOnly: false });
  await bus.open();

  const connection = new IsoTpConnection(bus, { txId: 0x7e0, rxId: 0x7e8, channel: 'vcan0' }, logger);
  connection.open();
  const client = new UdsClient(connection, { name: 'replayed-engine', timing: { p2Ms: 40 } });

  // Read a DID that exists in the recording but request it with a different DID
  // number, so the identifier matches while the payload does not.
  await assert.rejects(client.readDid(0xf18d));
  const payloadDiffers = bus.deviations.filter((deviation) => deviation.kind === 'payload-differs');
  assert.ok(payloadDiffers.length > 0, `expected a payload deviation, got ${JSON.stringify(bus.deviations)}`);
  assert.ok(payloadDiffers[0]?.recordedPayload, 'the deviation must name the recorded payload for comparison');
  await bus.close();
});

test('replay delivers frames to subscribers with direction rx', async () => {
  const recording = await recordSession();
  const replayRecording = recordingFromSessionJson(recording.json);
  const bus = new ReplayTransport(replayRecording, { logger, immediate: true });
  await bus.open();

  const seen: Array<{ id: number; direction?: string }> = [];
  bus.subscribe((frame) => seen.push({ id: frame.id, ...(frame.direction ? { direction: frame.direction } : {}) }));

  const connection = new IsoTpConnection(bus, { txId: 0x7e0, rxId: 0x7e8, channel: 'vcan0' }, logger);
  connection.open();
  const client = new UdsClient(connection, { name: 'replayed-engine' });
  await client.readVin();

  assert.ok(seen.length > 0, 'replayed frames must reach subscribers');
  assert.ok(seen.every((frame) => frame.direction === 'rx'), 'replayed frames are received, never transmitted');
  await bus.close();
});
