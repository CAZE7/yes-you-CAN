/**
 * Vehicle session model (AGENTS 10): creation, live view, actions audit trail.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import type { DtcRecord } from '@vdp/protocols-uds';
import type { AdapterInfo, TransportInfo } from '@vdp/transport-can';
import { createEcuSession, createSession, VehicleSession, type VehicleSessionData } from './session.js';

const adapter: AdapterInfo = { id: 'virtual', name: 'Virtual CAN' };
const transport: TransportInfo = { kind: 'virtual', channel: 'vcan0' };

const dtc = (severity: DtcRecord['severity']): DtcRecord => ({
  code: severity === 'critical' ? 'P0299' : 'P0420',
  raw: '04202A',
  failureType: '2A',
  status: 0x2f,
  statusBits: {
    testFailed: true,
    testFailedThisOperationCycle: true,
    pendingDtc: true,
    confirmedDtc: true,
    testNotCompletedSinceClear: false,
    testFailedSinceLastClear: true,
    testNotCompletedThisOperationCycle: false,
    warningIndicatorRequested: false,
  },
  severity,
});

function startedSession(overrides: Partial<VehicleSessionData> = {}): VehicleSession {
  return new VehicleSession({ ...createSession({ adapter, transport, title: 'T' }), ...overrides });
}

describe('createSession', () => {
  test('a new session has the current schema version and empty collections', () => {
    const session = createSession({ adapter, transport });
    assert.equal(session.schemaVersion, 1);
    assert.match(session.id, /^session_/);
    assert.equal(typeof session.startedAt, 'string');
    assert.equal(session.title, undefined);
    assert.equal(session.definitionPackage, undefined);
    assert.deepEqual(
      { ecus: session.ecus, dtcSnapshots: session.dtcSnapshots, measurements: session.measurements, actions: session.actions, notes: session.notes, tags: session.tags },
      { ecus: [], dtcSnapshots: [], measurements: [], actions: [], notes: [], tags: [] },
    );
    assert.deepEqual(session.adapter, adapter);
    assert.deepEqual(session.transport, transport);
    assert.equal('title' in session, false, 'absent option means absent key');
    assert.equal('definitionPackage' in session, false);
  });

  test('title, definition package and id are honoured; the clock is injectable', () => {
    const session = createSession({
      adapter,
      transport,
      title: 'Auslesung #12',
      definitionPackage: { oem: 'VAG', version: '1.2.0' },
      id: 'session_fixed',
      clock: () => 1_700_000_000_000,
    });
    assert.equal(session.id, 'session_fixed');
    assert.equal(session.title, 'Auslesung #12');
    assert.deepEqual(session.definitionPackage, { oem: 'VAG', version: '1.2.0' });
    assert.equal(new Date(session.startedAt).getTime(), 1_700_000_000_000);
  });
});

describe('createEcuSession', () => {
  test('defaults: unknown protocol, base timing, not reachable', () => {
    const ecu = createEcuSession({ name: 'Motor', txId: 0x7e0, rxId: 0x7e8 });
    assert.match(ecu.id, /^ecu_/);
    assert.equal(ecu.protocol, 'unknown');
    assert.equal(ecu.extended, false);
    assert.equal(ecu.sessionType, 0x01);
    assert.deepEqual(ecu.timing, { p2Ms: 50, p2StarMs: 5000 });
    assert.equal(ecu.reachable, false);
    assert.deepEqual(ecu.identification, []);
    assert.deepEqual(ecu.supportedServices, []);
    assert.equal('definitionEcuId' in ecu, false);
    assert.equal('lastError' in ecu, false);
    assert.equal('dtcs' in ecu, false);
  });

  test('UDS specifics are preserved', () => {
    const ecu = createEcuSession({ name: 'Getriebe', protocol: 'uds', txId: 0x711, rxId: 0x77a, extended: true, definitionEcuId: 'vag-getriebe' });
    assert.equal(ecu.protocol, 'uds');
    assert.equal(ecu.extended, true);
    assert.equal(ecu.definitionEcuId, 'vag-getriebe');
  });
});

describe('VehicleSession live view', () => {
  test('upsertEcu inserts by identity and updates by id or by tx/rx pair', () => {
    const session = startedSession();
    const first = createEcuSession({ name: 'Motor', txId: 0x7e0, rxId: 0x7e8 });
    session.upsertEcu(first);
    session.upsertEcu({ ...first, reachable: true });
    assert.equal(session.data.ecus.length, 1, 'same id → update');
    assert.equal(session.data.ecus[0]?.reachable, true);

    const sameAddresses = createEcuSession({ name: 'Motor (neu)', txId: 0x7e0, rxId: 0x7e8 });
    session.upsertEcu(sameAddresses);
    assert.equal(session.data.ecus.length, 1, 'same tx/rx → update, no duplicate ECU');
    assert.equal(session.data.ecus[0]?.name, 'Motor (neu)');

    session.upsertEcu(createEcuSession({ name: 'Airbag', txId: 0x714, rxId: 0x77c }));
    assert.equal(session.data.ecus.length, 2);
  });

  test('findEcu resolves by session id and by definition package id', () => {
    const session = startedSession();
    const ecu = createEcuSession({ name: 'Motor', txId: 0x7e0, rxId: 0x7e8, definitionEcuId: 'vag-motor' });
    session.upsertEcu(ecu);
    assert.equal(session.findEcu(ecu.id)?.name, 'Motor');
    assert.equal(session.findEcu('vag-motor')?.name, 'Motor');
    assert.equal(session.findEcu('missing'), undefined);
  });

  test('recordAction keeps the audit trail and honours explicit timestamps', () => {
    const session = startedSession();
    const entry = session.recordAction({ kind: 'read', ecuId: 'ecu_1', description: 'VIN gelesen', result: 'success' });
    assert.match(entry.id, /^act_/);
    assert.equal(typeof entry.timestamp, 'string');
    assert.equal('previousValue' in entry, false);
    const stamped = session.recordAction({ kind: 'write', ecuId: 'ecu_1', description: 'DID geschrieben', result: 'failed', timestamp: '2026-01-01T00:00:00.000Z', previousValue: '00', newValue: '01' });
    assert.equal(stamped.timestamp, '2026-01-01T00:00:00.000Z');
    assert.equal(session.data.actions.length, 2);
  });

  test('notes and DTC snapshots carry optional metadata without phantom keys', () => {
    const session = startedSession();
    const note = session.addNote('Zündung muss an sein');
    assert.equal('author' in note, false);
    assert.equal(session.addNote('durchgeführt', 'tech').author, 'tech');

    const labelled = session.addDtcSnapshot([dtc('critical')], 'vor dem Löschen');
    assert.equal(labelled.label, 'vor dem Löschen');
    assert.match(labelled.id, /^dtc_/);
    const plain = session.addDtcSnapshot([]);
    assert.equal('label' in plain, false);
    assert.equal(session.data.dtcSnapshots.length, 2);
  });

  test('close sets endedAt; duration is null before and computed after', () => {
    const data = createSession({ adapter, transport, clock: () => 1_000 });
    const session = new VehicleSession(data);
    assert.equal(session.durationMs(), null);
    data.endedAt = new Date(4_500).toISOString();
    assert.equal(session.durationMs(), 3_500);
    session.close();
    assert.ok(data.endedAt);
  });

  test('summary counts ECUs, the latest DTC snapshot and critical severities', () => {
    const session = startedSession();
    const motor = createEcuSession({ name: 'Motor', txId: 0x7e0, rxId: 0x7e8 });
    motor.reachable = true;
    session.upsertEcu(motor);
    session.upsertEcu(createEcuSession({ name: 'Airbag', txId: 0x714, rxId: 0x77c }));
    session.addDtcSnapshot([dtc('critical'), dtc('moderate')], 'alt');
    session.addDtcSnapshot([dtc('critical')], 'neu');
    session.recordAction({ kind: 'read', ecuId: 'ecu_1', description: 'x', result: 'success' });
    session.data.measurements.push({ signalId: 'rpm', name: 'Drehzahl', samples: 3 });
    assert.deepEqual(session.summary(), { ecuCount: 2, reachableEcuCount: 1, dtcCount: 1, criticalDtcCount: 1, actionCount: 1, signalCount: 1 }, 'only the newest snapshot is summarised');
  });

  test('id and startedAt are exposed read-only', () => {
    const data = createSession({ adapter, transport, id: 'session_x' });
    const session = new VehicleSession(data);
    assert.equal(session.id, 'session_x');
    assert.equal(session.startedAt, data.startedAt);
  });
});
