import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  CommandKinds,
  QueryKinds,
  clearDtcs,
  connectVehicle,
  disconnectVehicle,
  getAvailableActions,
  getDtcList,
  getEcu,
  getEcuCapabilities,
  getEcuList,
  getMeasurements,
  getSession,
  getVehicle,
  readDid,
  readDtcs,
  snapshotSignals,
  startMeasurements,
  stopMeasurements,
} from './index.js';

describe('command factories', () => {
  test('connectVehicle carries optional discovery options', () => {
    assert.deepEqual(connectVehicle(), { kind: 'vehicle.connect' });
    assert.deepEqual(connectVehicle({ windowMs: 120 }), { kind: 'vehicle.connect', options: { windowMs: 120 } });
  });

  test('disconnectVehicle is a plain intent', () => {
    assert.deepEqual(disconnectVehicle(), { kind: 'vehicle.disconnect' });
  });

  test('readDtcs targets all ECUs unless restricted', () => {
    assert.deepEqual(readDtcs(), { kind: 'dtc.read' });
    assert.deepEqual(readDtcs('ecu_1'), { kind: 'dtc.read', ecuId: 'ecu_1' });
    assert.deepEqual(readDtcs('ecu_1', 0x01), { kind: 'dtc.read', ecuId: 'ecu_1', statusMask: 0x01 });
  });

  test('clearDtcs always carries confirmation and vehicle state', () => {
    const state = { stationary: true, ignitionOn: true, parkingBrake: true, batteryVoltage: 13 };
    const command = clearDtcs('ecu_1', true, state, '2026.1');
    assert.equal(command.kind, 'dtc.clear');
    assert.equal(command.ecuId, 'ecu_1');
    assert.equal(command.userConfirmed, true);
    assert.deepEqual(command.vehicleState, state);
    assert.equal(command.definitionVersion, '2026.1');
  });

  test('readDid, snapshot and live commands keep their payload minimal', () => {
    assert.deepEqual(readDid('ecu_1', 0xf190), { kind: 'did.read', ecuId: 'ecu_1', did: 0xf190 });
    assert.deepEqual(snapshotSignals(), { kind: 'measurement.snapshot' });
    assert.deepEqual(snapshotSignals(['engine.rpm']), { kind: 'measurement.snapshot', signalIds: ['engine.rpm'] });
    assert.deepEqual(startMeasurements(), { kind: 'measurement.start' });
    assert.deepEqual(startMeasurements(['engine.rpm'], 50), { kind: 'measurement.start', signalIds: ['engine.rpm'], intervalMs: 50 });
    assert.deepEqual(stopMeasurements(), { kind: 'measurement.stop' });
  });

  test('kinds stay the stable wire contract', () => {
    assert.deepEqual(
      Object.values(CommandKinds).sort(),
      ['did.read', 'dtc.clear', 'dtc.read', 'measurement.snapshot', 'measurement.start', 'measurement.stop', 'vehicle.connect', 'vehicle.disconnect'],
    );
  });
});

describe('query factories', () => {
  test('queries carry only the filter they need', () => {
    assert.deepEqual(getSession(), { kind: 'session.get' });
    assert.deepEqual(getVehicle(), { kind: 'vehicle.get' });
    assert.deepEqual(getEcuList(), { kind: 'ecu.list' });
    assert.deepEqual(getEcu('ecu_1'), { kind: 'ecu.get', ecuId: 'ecu_1' });
    assert.deepEqual(getEcuCapabilities('ecu_1'), { kind: 'ecu.capabilities', ecuId: 'ecu_1' });
    assert.deepEqual(getDtcList(), { kind: 'dtc.list' });
    assert.deepEqual(getDtcList('ecu_1'), { kind: 'dtc.list', ecuId: 'ecu_1' });
    assert.deepEqual(getMeasurements(), { kind: 'measurement.list' });
    assert.deepEqual(getMeasurements('engine.rpm'), { kind: 'measurement.list', signalId: 'engine.rpm' });
    assert.deepEqual(getAvailableActions(), { kind: 'actions.available' });
    assert.deepEqual(getAvailableActions('ecu_1'), { kind: 'actions.available', ecuId: 'ecu_1' });
  });

  test('kinds stay the stable wire contract', () => {
    assert.deepEqual(
      Object.values(QueryKinds).sort(),
      ['actions.available', 'dtc.list', 'ecu.capabilities', 'ecu.get', 'ecu.list', 'measurement.list', 'session.get', 'vehicle.get'],
    );
  });
});
