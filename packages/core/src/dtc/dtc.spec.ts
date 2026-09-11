import assert from 'node:assert/strict';
import { test } from 'vitest';
import { fromHex, toHex } from '@vdp/shared';
import { genericPackage, indexPackage, type DtcDefinition } from '@vdp/definitions';
import type { DtcRecord } from '@vdp/protocols-uds';
import { DtcClearService, DtcScanner, SafetyManager, decodeFreezeFrame, type ClearableEcu } from '../index.js';

const index = indexPackage(genericPackage);
const catalyst = genericPackage.ecus.find((ecu) => ecu.id === 'engine')?.dtcs?.find((dtc) => dtc.code === 'P0420');

/** Snapshot record the simulator produces for P0420: rpm, load, coolant, speed. */
const VALID_SNAPSHOT = fromHex('0C 30 41 5D 4E');

/* -------------------------------------------------------- freeze frames */

test('a documented freeze frame is split into its declared fields and decoded', () => {
  const frame = decodeFreezeFrame(VALID_SNAPSHOT, {
    code: 'P0420',
    recordNumber: 0xff,
    definition: catalyst as DtcDefinition,
    signals: index.byId,
  });

  assert.equal(frame.documented, true);
  assert.deepEqual(frame.notes, []);
  assert.deepEqual(
    frame.fields.map((field) => field.did),
    [0xf40c, 0xf404, 0xf405, 0xf40d],
  );

  const [rpm, load, coolant, speed] = frame.fields;
  // 0x0C30 = 3120 raw → 780 rpm at 0.25 rpm per bit (PID 0x0C semantics).
  assert.equal(rpm?.values[0]?.value, 780);
  assert.equal(rpm?.values[0]?.unit, 'rpm');
  assert.equal(rpm?.rawHex, '0C 30');
  assert.equal(load?.values[0]?.value, 25.5);
  assert.equal(coolant?.values[0]?.value, 53);
  assert.equal(speed?.values[0]?.value, 78);
  assert.equal(speed?.values[0]?.unit, 'km/h');
  assert.equal(frame.unassignedHex, '');
});

test('a documented record with extra bytes keeps them raw instead of misreading them', () => {
  const frame = decodeFreezeFrame(fromHex('0C 30 41 5D 4E 99 88'), {
    code: 'P0420',
    recordNumber: 0xff,
    definition: catalyst as DtcDefinition,
    signals: index.byId,
  });

  assert.equal(frame.documented, false, 'unassigned bytes mean the layout is not fully understood');
  assert.equal(frame.unassignedHex, '99 88');
  assert.match(frame.notes.join('\n'), /kept raw/);
});

test('a record shorter than the declared layout is reported, not guessed', () => {
  const frame = decodeFreezeFrame(fromHex('0C 30 41'), {
    code: 'P0420',
    recordNumber: 0xff,
    definition: catalyst as DtcDefinition,
    signals: index.byId,
  });

  assert.equal(frame.fields.length, 2, 'only the fields that fit are decoded');
  assert.match(frame.notes.join('\n'), /shorter than the declared layout/);
  assert.equal(frame.documented, false);
});

test('an undocumented code returns the raw record instead of an invented layout', () => {
  const frame = decodeFreezeFrame(VALID_SNAPSHOT, { code: 'U0121', recordNumber: 1, signals: index.byId });
  assert.equal(frame.documented, false);
  assert.deepEqual(frame.fields, []);
  assert.equal(frame.unassignedHex, toHex(VALID_SNAPSHOT));
  assert.match(frame.notes.join('\n'), /no definition/);
});

test('a documented code without a freeze frame layout stays raw', () => {
  const definition: DtcDefinition = { code: 'P0171', description: 'lean' };
  const frame = decodeFreezeFrame(VALID_SNAPSHOT, { code: 'P0171', recordNumber: 1, definition, signals: index.byId });
  assert.equal(frame.documented, false);
  assert.match(frame.notes.join('\n'), /documents no freeze frame layout/);
});

/* --------------------------------------------------- clearing fault memory */

class FakeEcu implements ClearableEcu {
  id = 'ecu-engine';
  name = 'Engine Control Unit';
  sessionType = 0x03;
  cleared = 0;
  codes: DtcRecord[];

  constructor(codes: DtcRecord[]) {
    this.codes = codes;
  }

  async readDtcs(): Promise<DtcRecord[]> {
    return this.codes.map((record) => ({ ...record }));
  }

  async clearDiagnosticInformation(): Promise<void> {
    this.cleared++;
    // Real behaviour: the clear resets the status bits, and a fault that is still
    // present immediately sets testFailed again. Anything else disappears from a
    // status-mask read (a record with status 0x00 is filtered out by mask 0xFF).
    this.codes = this.codes
      .map((record) => ({ ...record, status: (record.status & 0x01) === 0 ? 0x00 : 0x03 }))
      .filter((record) => record.status !== 0x00);
  }
}

function record(code: string, status: number): DtcRecord {
  return {
    code,
    raw: code,
    failureType: '00',
    status,
    statusBits: {
      testFailed: (status & 0x01) !== 0,
      testFailedThisOperationCycle: (status & 0x02) !== 0,
      pendingDtc: (status & 0x04) !== 0,
      confirmedDtc: (status & 0x08) !== 0,
      testNotCompletedSinceLastClear: (status & 0x10) !== 0,
      testFailedSinceLastClear: (status & 0x20) !== 0,
      testNotCompletedThisOperationCycle: (status & 0x40) !== 0,
      warningIndicatorRequested: (status & 0x80) !== 0,
    },
    severity: 'major',
  };
}

function service(options: { vehicleState?: Parameters<typeof DtcClearService.prototype.clear>[1] } = {}) {
  void options;
  const safety = new SafetyManager({ logger: undefined });
  const scanner = new DtcScanner({ definitions: [genericPackage] });
  return {
    safety,
    scanner,
    service: new DtcClearService({ safety, scanner }),
  };
}

const READY_STATE = { stationary: true, ignitionOn: true, batteryVoltage: 12.6, parkingBrake: true };

test('clearing fault memory needs the operator confirmation', async () => {
  const { service: clearer } = service();
  const ecu = new FakeEcu([record('P0420', 0x2f)]);
  await assert.rejects(
    () => clearer.clear(ecu, { userConfirmed: false, vehicleState: READY_STATE, definitionVersion: '1.0.0' }),
    /refused/,
  );
  assert.equal(ecu.cleared, 0, 'a refused clear must not touch the ECU');
  assert.match(clearer.evaluate(ecu, { userConfirmed: false, vehicleState: READY_STATE }).failed.join('; '), /confirmation/);
});

test('clearing fault memory needs a safe vehicle state', async () => {
  const { service: clearer } = service();
  const ecu = new FakeEcu([record('P0420', 0x2f)]);
  await assert.rejects(
    () =>
      clearer.clear(ecu, {
        userConfirmed: true,
        definitionVersion: '1.0.0',
        vehicleState: { stationary: false, ignitionOn: true, batteryVoltage: 11.2, parkingBrake: false },
      }),
    (error: unknown) => {
      const failed = ((error as { failedPreconditions?: string[] }).failedPreconditions ?? []).join('; ');
      assert.match(failed, /not stationary/);
      assert.match(failed, /below the required/);
      return true;
    },
  );
  assert.equal(ecu.cleared, 0);
});

test('a clear in the default session is refused (ISO 14229-1 §11.3 gating)', async () => {
  const { service: clearer } = service();
  const ecu = new FakeEcu([record('P0420', 0x2f)]);
  ecu.sessionType = 0x01;
  await assert.rejects(
    () => clearer.clear(ecu, { userConfirmed: true, vehicleState: READY_STATE, definitionVersion: '1.0.0' }),
    (error: unknown) => {
      assert.match(JSON.stringify((error as { failedPreconditions?: string[] }).failedPreconditions), /default diagnostic session/);
      return true;
    },
  );
  assert.equal(ecu.cleared, 0);
});

test('a confirmed clear records a backup, verifies by re-reading and reports what survived', async () => {
  const { service: clearer } = service();
  const ecu = new FakeEcu([record('P0420', 0x2f), record('P0300', 0x08)]);
  const snapshots: Array<{ label: string; count: number }> = [];
  const actions: string[] = [];

  const result = await clearer.clear(ecu, {
    userConfirmed: true,
    vehicleState: READY_STATE,
    definitionVersion: '1.0.0',
    recordSnapshot: (records, label) => snapshots.push({ label, count: records.length }),
    recordAction: (action) => actions.push(action.kind),
  });

  assert.equal(result.cleared, true);
  assert.equal(ecu.cleared, 1);
  assert.equal(result.before.length, 2);
  assert.deepEqual(snapshots, [{ label: 'before clear (Engine Control Unit)', count: 2 }]);
  assert.deepEqual(actions, ['clear-dtc']);
  assert.equal(result.permit.risk, 'medium');

  // P0300 was confirmed but not currently failing → gone. P0420 is still failing
  // → it stays with a reset status. Both outcomes have to be visible.
  assert.deepEqual(result.comparison.removed.map((dtc) => dtc.code), ['P0300']);
  assert.deepEqual(result.comparison.changed.map((entry) => entry.code), ['P0420']);
  assert.equal(result.comparison.unchanged.length, 0);
  assert.equal(result.verified, true);
});

test('an ECU that ignores the clear is reported as unverified, not as success', async () => {
  const { service: clearer } = service();
  const ecu = new FakeEcu([record('P0420', 0x2f), record('P0171', 0x08)]);
  // An ECU that answers positively without doing anything is the failure mode
  // this verification step exists for.
  ecu.clearDiagnosticInformation = async () => {
    ecu.cleared++;
  };

  const result = await clearer.clear(ecu, { userConfirmed: true, vehicleState: READY_STATE, definitionVersion: '1.0.0' });
  assert.equal(result.cleared, true, 'the request itself succeeded');
  assert.equal(result.verified, false, 'but the re-read does not confirm it');
  assert.equal(result.comparison.unchanged.length, 2);
});

test('a failed write is audited and rethrown instead of being swallowed', async () => {
  const { service: clearer, safety } = service();
  const ecu = new FakeEcu([record('P0420', 0x2f)]);
  ecu.clearDiagnosticInformation = async () => {
    throw new Error('transport lost');
  };
  await assert.rejects(
    () => clearer.clear(ecu, { userConfirmed: true, vehicleState: READY_STATE, definitionVersion: '1.0.0' }),
    /transport lost/,
  );
  assert.ok(safety.audit.some((entry) => entry.action === 'write-failed'), 'the audit log has to record the failure');
});
