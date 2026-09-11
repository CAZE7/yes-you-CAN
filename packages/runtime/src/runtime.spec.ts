import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createLogger } from '@vdp/shared';
import type { CanBus, CanFrame, CanFilter } from '@vdp/transport-can';
import { genericPackage } from '@vdp/definitions';
import { SafetyManager } from '@vdp/core';
import { NoHandlerError } from '@vdp/application';
import {
  clearDtcs,
  disconnectVehicle,
  getAvailableActions,
  getDtcList,
  getEcu,
  getEcuCapabilities,
  getEcuList,
  getMeasurements,
  getSession,
  readDtcs,
  snapshotSignals,
  startMeasurements,
  stopMeasurements,
} from '@vdp/application';
import { FixedClock, FixedIdGenerator, InMemorySessionStore, RecordingEventBus } from '@vdp/domain';
import { createDiagnosticRuntime, parseEcuAddress, unknownEcu } from './index.js';

/** A bus that opens but carries no traffic — discovery finds nothing. */
const quietLogger = createLogger('runtime-test', { level: 'ERROR' });

function makeSilentBus(): CanBus {
  let open = false;
  return {
    info: { id: 'stub', kind: 'stub', name: 'Stub', channels: ['stub0'] },
    capabilities: { can: true, canFd: false, doip: false, isoTpOffload: false, channels: 1 },
    async open() {
      open = true;
    },
    async close() {
      open = false;
    },
    isOpen: () => open,
    async send(_frame: CanFrame) {},
    subscribe(_listener: (frame: CanFrame) => void, _filters?: readonly CanFilter[]) {
      return () => undefined;
    },
  };
}

describe('runtime composition', () => {
  test('composes without a connection and answers queries with empty state', async () => {
    const events = new RecordingEventBus();
    const runtime = createDiagnosticRuntime({ bus: makeSilentBus(), definitions: [genericPackage], events, logger: quietLogger });
    assert.equal(runtime.session.current(), undefined);
    assert.deepEqual(runtime.ecus.list(), []);
    assert.deepEqual(await runtime.commands.query(getSession()), undefined);
    assert.deepEqual(await runtime.commands.query(getEcuList()), []);
    assert.deepEqual(runtime.dtc.lastScanResult, []);
    await runtime.dispose();
  });

  test('the definition provider exposes the injected packages', () => {
    const runtime = createDiagnosticRuntime({ bus: makeSilentBus(), definitions: [genericPackage], logger: quietLogger });
    assert.equal(runtime.definitions.listPackages()[0]?.oem, 'generic');
    assert.ok(runtime.definitions.findEcu({ rxId: 0x7e8 }));
  });

  test('standard actions are registered and capability-aware', () => {
    const runtime = createDiagnosticRuntime({ bus: makeSilentBus(), definitions: [genericPackage], logger: quietLogger });
    const ids = runtime.actions.list().map((action) => action.id);
    assert.ok(ids.includes('dtc.read'));
    assert.ok(ids.includes('dtc.clear'));
    // Without a connection nothing is executable.
    assert.deepEqual(runtime.actions.available({ connected: false }), []);
  });

  test('commands refuse to run before connecting', async () => {
    const runtime = createDiagnosticRuntime({ bus: makeSilentBus(), definitions: [genericPackage], logger: quietLogger });
    await assert.rejects(runtime.commands.dispatch(readDtcs()), /no session/);
    await assert.rejects(runtime.dtc.scan(), /no session/);
    await assert.rejects(runtime.measurements.snapshot(), /no session/);
    await assert.rejects(runtime.session.save(), /no session/);
    assert.equal(runtime.ecus.get('0x7e8'), undefined, 'no session means no ECU lookup');
    assert.deepEqual(runtime.ecus.capabilities('ecu_missing'), []);
  });

  test('connecting on an empty bus opens a session with zero ECUs', async () => {
    const runtime = createDiagnosticRuntime({ bus: makeSilentBus(), definitions: [genericPackage], logger: quietLogger });
    const result = await runtime.vehicle.connect({ windowMs: 30 });
    assert.equal(result.ecus.length, 0);
    assert.ok(result.session.sessionId.length > 0);
    assert.equal(result.session.ecuCount, 0);
    await assert.rejects(
      runtime.dtc.clear('0x7e8', { userConfirmed: true, vehicleState: { stationary: true } }),
      /unknown ECU/,
    );
    await runtime.dispose();
  });

  test('unknown command kinds raise NoHandlerError', async () => {
    const runtime = createDiagnosticRuntime({ bus: makeSilentBus(), logger: quietLogger });
    await assert.rejects(runtime.commands.dispatch({ kind: 'no.such.command' }), NoHandlerError);
  });

  test('saving without a store configured is a configuration error', async () => {
    const runtime = createDiagnosticRuntime({ bus: makeSilentBus(), logger: quietLogger });
    await runtime.vehicle.connect({ windowMs: 30 });
    await assert.rejects(runtime.session.save(), /no session store/);
    await runtime.dispose();
  });

  test('disconnect is a no-op without a session', async () => {
    const runtime = createDiagnosticRuntime({ bus: makeSilentBus(), logger: quietLogger });
    await assert.doesNotReject(() => runtime.vehicle.disconnect());
    await runtime.dispose();
  });
});

describe('address helpers', () => {
  test('parseEcuAddress understands hex addresses only', () => {
    assert.equal(parseEcuAddress('0x7e8'), 0x7e8);
    assert.equal(parseEcuAddress('0x0'), 0);
    assert.equal(parseEcuAddress('ecu_1'), undefined);
    assert.equal(parseEcuAddress('0xzzz'), undefined);
    assert.equal(parseEcuAddress('0x-1'), undefined);
  });

  test('unknownEcu errors are descriptive', () => {
    assert.match(unknownEcu('0x7e8').message, /0x7e8/);
  });
});

describe('event wiring', () => {
  test('an injected bus receives lifecycle events on connect', async () => {
    const events = new RecordingEventBus();
    const runtime = createDiagnosticRuntime({ bus: makeSilentBus(), definitions: [genericPackage], events, logger: quietLogger });
    await runtime.vehicle.connect({ windowMs: 30 });
    const connected = events.ofType('vehicle-connected');
    assert.equal(connected.length, 1);
    assert.equal(connected[0]?.ecuCount, 0, 'the silent bus answers no ECUs');
    await runtime.dispose();
  });

  test('the audit recorder observes lifecycle events by default and keeps a reconstructable trail', async () => {
    const clock = new FixedClock(1_700_000_000_000);
    const runtime = createDiagnosticRuntime({ bus: makeSilentBus(), definitions: [genericPackage], logger: quietLogger, clock });

    const result = await runtime.vehicle.connect({ windowMs: 30 });
    const sessionId = result.session.sessionId;
    clock.advance(500);
    await runtime.commands.dispatch(disconnectVehicle());

    // Every lifecycle event is observed, timestamped from the injected clock.
    const connected = runtime.audit.forEvent('vehicle-connected');
    assert.equal(connected.length, 1);
    assert.equal(connected[0]?.sessionId, sessionId);
    assert.equal(connected[0]?.at, 1_700_000_000_000);

    const disconnected = runtime.audit.forEvent('vehicle-disconnected');
    assert.equal(disconnected.length, 1);
    assert.equal(disconnected[0]?.at, 1_700_000_000_500);

    // The correlation id ties the trail back to the session (§24).
    const trail = runtime.audit.forSession(sessionId);
    assert.ok(trail.some((entry) => entry.event === 'vehicle-connected'));
    assert.ok(trail.some((entry) => entry.event === 'vehicle-disconnected'));

    // dispose stops observation; the captured trail survives.
    const before = runtime.audit.all.length;
    await runtime.dispose();
    assert.equal(runtime.audit.all.length, before);
  });
});

describe('runtime options', () => {
  test('accepts every injected port and honours the clock', async () => {
    const events = new RecordingEventBus();
    const store = new InMemorySessionStore<{ id: string; startedAt: string }>();
    const clock = new FixedClock(1_700_000_000_000);
    const runtime = createDiagnosticRuntime({
      bus: makeSilentBus(),
      definitions: [genericPackage],
      logger: quietLogger,
      events,
      sessionStore: store as never,
      idGenerator: new FixedIdGenerator('test'),
      clock,
      safety: new SafetyManager({ logger: quietLogger }),
      pollIntervalMs: 50,
      isoTpDefaults: { padByte: 0xcc, padding: true },
      oemProtocols: [],
    });
    const result = await runtime.vehicle.connect();
    assert.ok(result.session.sessionId.length > 0);
    clock.advance(1000);
    await runtime.commands.dispatch(disconnectVehicle());
    assert.equal(events.ofType('vehicle-disconnected').length, 1);
  });

  test('session.save persists through the configured store', async () => {
    const store = new InMemorySessionStore<{ id: string; startedAt: string }>();
    const runtime = createDiagnosticRuntime({
      bus: makeSilentBus(),
      definitions: [genericPackage],
      logger: quietLogger,
      sessionStore: store as never,
    });
    await runtime.vehicle.connect({ windowMs: 30 });
    const id = await runtime.session.save();
    assert.equal(await store.exists(id), true);
    await runtime.dispose();
  });

  test('the safety service exposes the engine safety manager', () => {
    const runtime = createDiagnosticRuntime({ bus: makeSilentBus(), logger: quietLogger });
    assert.ok(runtime.safety.manager);
    assert.deepEqual(runtime.safety.audit, []);
    const verdict = runtime.safety.evaluate(
      {
        ecuId: 'ecu_1',
        ecuName: 'Engine',
        newValue: 'x',
        risk: 'low',
        userConfirmed: true,
        backupAvailable: true,
        activeSessionType: 0x03,
        definitionVersion: '1.0.0',
      },
      { stationary: true, ignitionOn: true, parkingBrake: true, batteryVoltage: 13 },
    );
    assert.equal(typeof verdict.ok, 'boolean');
  });
});

describe('command bus wiring against an empty vehicle', () => {
  function connectedRuntime() {
    return createDiagnosticRuntime({ bus: makeSilentBus(), definitions: [genericPackage], logger: quietLogger });
  }

  test('query variants answer on a session without ECUs', async () => {
    const runtime = connectedRuntime();
    await runtime.vehicle.connect({ windowMs: 30 });
    assert.deepEqual(await runtime.commands.query(getEcu('ecu_missing')), undefined);
    assert.deepEqual(await runtime.commands.query(getEcuCapabilities('ecu_missing')), []);
    assert.deepEqual(await runtime.commands.query(getDtcList('ecu_missing')), []);
    assert.deepEqual(await runtime.commands.query(getMeasurements()), []);
    assert.deepEqual(await runtime.commands.query(getMeasurements('engine.rpm')), []);
    const actions = await runtime.commands.query(getAvailableActions('ecu_missing'));
    assert.deepEqual(actions, [], 'no ECU means no ECU-scoped actions');
    assert.deepEqual(await runtime.commands.query(getSession()), await Promise.resolve(runtime.session.current()));
    await runtime.dispose();
  });

  test('write and live commands refuse before and after connecting', async () => {
    const runtime = connectedRuntime();
    const state = { stationary: true, ignitionOn: true, parkingBrake: true, batteryVoltage: 13.1 };
    await assert.rejects(runtime.commands.dispatch(clearDtcs('0x7e8', true, state, 'def-2026')), /no session/);
    await assert.rejects(runtime.commands.dispatch(startMeasurements(['engine.rpm'], 10)), /no session/);

    await runtime.vehicle.connect();
    await assert.rejects(runtime.commands.dispatch(clearDtcs('0x7e8', true, state, 'def-2026')), /unknown ECU/);
    await assert.rejects(runtime.commands.dispatch(readDtcs('0x7e8')), /unknown ECU/);
    await runtime.commands.dispatch(startMeasurements(['engine.rpm'], 10));
    runtime.measurements.stop();
    await runtime.dispose();
  });

  test('no-filter variants of snapshot, live start and action queries', async () => {
    const runtime = connectedRuntime();
    await runtime.vehicle.connect({ windowMs: 30 });
    // Zero ECUs on the silent bus — but the code paths all run.
    assert.deepEqual(await runtime.commands.dispatch(snapshotSignals()), []);
    await runtime.commands.dispatch(startMeasurements());
    await runtime.commands.dispatch(stopMeasurements());
    assert.deepEqual(await runtime.commands.query(getAvailableActions()), []);
    await assert.rejects(runtime.ecus.readDid('0x7e8', 0xf190), /unknown ECU/);
    await runtime.dispose();
  });

  test('a runtime without an explicit logger still works', async () => {
    const runtime = createDiagnosticRuntime({ bus: makeSilentBus(), definitions: [genericPackage] });
    const result = await runtime.vehicle.connect({ windowMs: 30 });
    assert.ok(result.session.sessionId);
    await runtime.dispose();
  });
});
