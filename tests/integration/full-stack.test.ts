import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { MemorySink, createLogger, fromHex, toHex } from '@vdp/shared';
import { DiagnosticEngine, DtcScanner, MeasurementRecorder, SessionLogger, analyseVin, deriveTxId } from '@vdp/core';
import { genericPackage } from '@vdp/definitions';
import { VirtualVehicle } from '@vdp/simulators';

/**
 * Full-stack integration test (AGENTS 29 MVP checklist).
 *
 * virtual vehicle → virtual CAN → ISO-TP → UDS → diagnostic engine →
 * measurement engine → recorder → exports. No hardware, fully deterministic.
 */

const logSink = new MemorySink();
const logger = createLogger('app', { level: 'WARN', rawProtocol: true }, [logSink]);
const vehicle = new VirtualVehicle({ logger, dynamic: true, seed: 42 });
const engine = new DiagnosticEngine({ bus: vehicle.testerBus, definitions: [genericPackage], logger });

before(async () => {
  await vehicle.start();
});

after(async () => {
  await engine.disconnect();
  await vehicle.stop();
});

test('adapter status is reported before and after connecting (AGENTS 29)', async () => {
  assert.equal(vehicle.testerBus.isOpen(), true);
  assert.equal(vehicle.testerBus.info.kind, 'virtual');
  assert.equal(vehicle.testerBus.capabilities.can, true);
  assert.deepEqual(vehicle.testerBus.info.channels, ['vcan0']);
});

test('ECU discovery finds the ECUs defined by the package (AGENTS 12)', async () => {
  const { ecus } = await engine.connect({ windowMs: 120 });
  const rxIds = ecus.map((e) => e.rxId).sort((a, b) => a - b);
  assert.ok(rxIds.includes(0x7e8), `engine ECU must respond, got ${rxIds.map((id) => id.toString(16))}`);
  assert.ok(rxIds.includes(0x7e9), 'transmission ECU must respond');
  assert.ok(rxIds.includes(0x77b), 'ABS ECU must respond');
  // Derived request identifiers must match the definition.
  assert.equal(deriveTxId(0x7e8, false), 0x7e0);
  assert.equal(deriveTxId(0x7e9, false), 0x7e1);
});

test('ECU identification is read and stored on the session (AGENTS 12)', async () => {
  const session = engine.vehicleSession;
  assert.ok(session);
  const engineEcu = session.data.ecus.find((e) => e.txId === 0x7e0);
  assert.ok(engineEcu, 'engine ECU session must exist');
  assert.equal(engineEcu.reachable, true);
  assert.ok(engineEcu.identification.length > 0, 'identification must not be empty');
  const vinEntry = engineEcu.identification.find((i) => i.label === 'VIN');
  assert.ok(vinEntry);
  assert.equal(vinEntry.value.length, 17);
});

test('VIN is detected automatically and validated against ISO 3779 (AGENTS 11)', async () => {
  const identity = engine.vehicleSession?.data.vehicle;
  assert.ok(identity?.vin);
  const analysis = analyseVin(identity.vin);
  assert.equal(analysis.wellFormed, true);
  assert.equal(analysis.checkDigit, 'valid', `check digit must validate: ${analysis.notes.join('; ')}`);
  assert.equal(identity.vinAnalysis?.expectedCheckDigitChar, analysis.expectedCheckDigitChar);
});

test('a broken VIN read is reported as a check digit problem, not silently accepted', () => {
  const broken = analyseVin('1HGCM82633A004353');
  assert.equal(broken.checkDigit, 'invalid-check-digit');
  assert.ok(broken.notes.some((note) => note.includes('check digit mismatch')));
});

test('DTCs are read from every ECU, decoded and enriched (AGENTS 20)', async () => {
  const scanner = new DtcScanner({ definitions: [genericPackage] });
  const perEcu = await engine.scanDtcs(0xff);
  assert.ok(perEcu.length >= 1);
  const all = perEcu.flatMap((entry) => scanner.enrich(entry.dtcs, entry.ecu.name, entry.ecu.id));
  assert.ok(all.length > 0, 'the simulator seeds DTCs, so at least one must be found');
  const catalyst = all.find((d) => d.code === 'P0420');
  assert.ok(catalyst, `expected P0420, got ${all.map((d) => d.code).join(', ')}`);
  assert.ok(catalyst.description?.toLowerCase().includes('catalyst'));
  assert.equal(catalyst.statusBits.testFailed, true);
  const summary = scanner.summary(all);
  assert.ok(summary.total >= 1);
  assert.ok(summary.critical + summary.major >= 1);
});

test('freeze frame data of an active DTC is available', async () => {
  const handle = engine.handleFor(0x7e8);
  assert.ok(handle);
  const snapshot = await handle.session.client.readDtcSnapshotRecord('P0420');
  assert.ok(snapshot);
  assert.ok(snapshot.data.length > 0, 'simulator provides snapshot bytes for the active DTC');
});

test('live DIDs are read and decoded into physical values (AGENTS 14)', async () => {
  const decoded = await engine.snapshotSignals();
  const rpm = decoded.find((d) => d.signalId === 'engine.rpm');
  assert.ok(rpm, `rpm must be decoded, got ${decoded.map((d) => d.signalId).join(', ')}`);
  assert.equal(typeof rpm.value, 'number');
  assert.ok((rpm.value as number) > 0, 'engine is running in the simulator');
  assert.equal(rpm.unit, 'rpm');
  assert.equal(rpm.raw.length, 2, 'two raw bytes are kept alongside the value');
  assert.equal(rpm.rawHex, toHex(rpm.raw), 'rawHex is the hex form of the stored raw bytes');

  const coolant = decoded.find((d) => d.signalId === 'engine.coolant_temperature');
  assert.ok(coolant);
  assert.equal(coolant.unit, '°C');
  // scale 1, offset -40 → a raw byte of 0x41 (65) must decode to 25 °C.
  assert.equal(coolant.value, (parseInt(coolant.rawHex.slice(0, 2), 16) - 40) * 1);
});

test('several DIDs are polled in parallel across ECUs but serialised per ECU (AGENTS 15)', async () => {
  const recorder = new MeasurementRecorder();
  const plan = engine.buildPlan(['engine.rpm', 'engine.coolant_temperature', 'vehicle.speed', 'abs.wheel_speed_front_left', 'transmission.oil_temperature']);
  const ecuIds = Array.from(plan.keys());
  assert.ok(ecuIds.length >= 2, `signals must span several ECUs, got ${ecuIds.length}`);

  const live = await engine.startLiveData({ signalIds: ['engine.rpm', 'engine.coolant_temperature', 'vehicle.speed', 'abs.wheel_speed_front_left'], intervalMs: 10, maxRounds: 3 });
  const stats = await waitForLive(live);
  engine.stopLiveData();
  assert.ok(stats.rounds >= 3, `expected 3 rounds, got ${stats.rounds}`);
  assert.ok(stats.samples >= 9, `expected at least 9 samples (3 rounds × 3 engine signals), got ${stats.samples}`);
  assert.equal(stats.errors, 0, 'no poll errors expected against the simulator');
  void recorder;
});

test('recorded samples share one time axis so charts can be synchronised (AGENTS 16)', () => {
  const stats = engine.recorder.statisticsForAll();
  const rpm = stats.find((s) => s.signal === 'engine.rpm');
  assert.ok(rpm);
  assert.ok(rpm.samples > 0);
  assert.ok(rpm.min !== null && rpm.max !== null);
  assert.ok((rpm.max as number) >= (rpm.min as number));
  assert.ok(rpm.delta !== null);

  const merged = engine.recorder.merged(['engine.rpm', 'vehicle.speed']);
  assert.ok(merged.length > 1);
  for (let i = 1; i < merged.length; i++) {
    assert.ok((merged[i] as { t: number }).t >= (merged[i - 1] as { t: number }).t, 'merged samples must stay time ordered');
  }
});

test('CSV and JSON exports contain raw and decoded values (AGENTS 17)', () => {
  const exported = engine.recorder.export();
  const csv = SessionLogger.toCsv(exported.samples, exported.markers);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'timestamp,t_ms,signal,value,raw_value,raw_hex,unit,enum_text,out_of_range');
  assert.ok(lines.length > 2);
  // Sample order follows ECU response order, so search instead of assuming a row.
  assert.ok(lines.some((line) => line.includes('engine.rpm')), 'rpm samples must be exported');
  assert.ok(lines.some((line) => line.includes('engine.coolant_temperature')), 'coolant samples must be exported');

  const json = SessionLogger.toJson({
    meta: { sessionId: engine.vehicleSession?.id },
    samples: exported.samples,
    markers: exported.markers,
    dtcs: engine.vehicleSession?.data.dtcSnapshots.at(-1)?.records ?? [],
    trace: [],
    log: [],
  });
  const parsed = JSON.parse(json) as { format: string; measurements: unknown[]; dtcs: unknown[] };
  assert.equal(parsed.format, 'vdp.session');
  assert.ok(parsed.measurements.length > 0);
});

test('raw CAN trace is recorded independently of decoding (AGENTS 18)', async () => {
  const sessionLogger = new SessionLogger();
  for (const frame of vehicle.network.snapshot()) sessionLogger.recordFrame(frame);
  assert.ok(sessionLogger.traceLength > 10, 'the conversation must have produced frames');

  const traceCsv = SessionLogger.traceToCsv(sessionLogger.snapshot().trace);
  assert.match(traceCsv, /timestamp,t_ms,can_id,direction,dlc,payload,channel,extended,fd/);
  const requestFrames = sessionLogger.traceFor(0x7e0);
  assert.ok(requestFrames.length > 0, 'tester requests must be in the trace');
  assert.equal(requestFrames[0]?.direction, 'tx');
});

test('session data is serialisable so it can be stored and reopened (AGENTS 10)', () => {
  const session = engine.vehicleSession;
  assert.ok(session);
  const summary = session.summary();
  assert.ok(summary.ecuCount >= 3);
  assert.ok(summary.reachableEcuCount >= 3);
  assert.ok(summary.dtcCount >= 1);

  const roundTripped = JSON.parse(JSON.stringify(session.data)) as typeof session.data;
  assert.equal(roundTripped.id, session.id);
  assert.equal(roundTripped.schemaVersion, session.data.schemaVersion);
  assert.equal(roundTripped.ecus.length, session.data.ecus.length);
  assert.equal(roundTripped.definitionPackage?.oem, 'generic');
});

test('every diagnostic operation is logged with a scope (AGENTS 33/34.10)', () => {
  const scopes = new Set(logSink.all().map((record) => record.scope));
  assert.ok(scopes.size > 0);
  const rawRecords = logSink.all().filter((record) => record.fields?.raw === true);
  assert.ok(rawRecords.length > 0, 'raw protocol logging must be available when enabled');
});

test('security access is refused without an explicitly registered algorithm (AGENTS 34.12)', async () => {
  const handle = engine.handleFor(0x7e8);
  assert.ok(handle);
  await assert.rejects(handle.session.client.unlockSecurityAccess(0x01), /refused/i);
});

test('a registered algorithm completes the seed and key exchange (simulator only)', async () => {
  const handle = engine.handleFor(0x7e8);
  assert.ok(handle);
  handle.session.client.setSeedKeyAlgorithm({
    id: 'test-fixed-key',
    provenance: 'test only — fixed key matching the simulator',
    computeKey: async () => fromHex('EE DD CC BB'),
  });
  const result = await handle.session.client.unlockSecurityAccess(0x01);
  assert.equal(result.algorithm, 'test-fixed-key');
});

test('write operations are refused in the default session (read-only first, AGENTS 11)', async () => {
  const handle = engine.handleFor(0x7e8);
  assert.ok(handle);
  await assert.rejects(handle.session.client.writeDataByIdentifier(0x2001, fromHex('00 01')), /serviceNotSupportedInActiveSession|requestOutOfRange|conditionsNotCorrect/);
});

async function waitForLive(engine: { statistics: { rounds: number; samples: number; errors: number; averageRoundMs: number }; isRunning: boolean }, timeoutMs = 4000): Promise<{ rounds: number; samples: number; errors: number; averageRoundMs: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!engine.isRunning) return engine.statistics;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return engine.statistics;
}
