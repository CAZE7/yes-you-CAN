import assert from "node:assert/strict";
import { type DtcDefinition, genericPackage, indexPackage } from "@vdp/definitions";
import type { DtcRecord } from "@vdp/protocols-uds";
import { fromHex, toHex } from "@vdp/shared";
import { test } from "vitest";
import {
  type ClearableEcu,
  createWritePort,
  DtcScanner,
  decodeFreezeFrame,
  runDtcClear,
  SafetyManager,
} from "../index.js";

const index = indexPackage(genericPackage);
const catalyst = genericPackage.ecus
  .find((ecu) => ecu.id === "engine")
  ?.dtcs?.find((dtc) => dtc.code === "P0420");

/** Snapshot record the simulator produces for P0420: rpm, load, coolant, speed. */
const VALID_SNAPSHOT = fromHex("0C 30 41 5D 4E");

/* -------------------------------------------------------- freeze frames */

test("a documented freeze frame is split into its declared fields and decoded", () => {
  const frame = decodeFreezeFrame(VALID_SNAPSHOT, {
    code: "P0420",
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
  assert.equal(rpm?.values[0]?.unit, "rpm");
  assert.equal(rpm?.rawHex, "0C 30");
  assert.equal(load?.values[0]?.value, 25.5);
  assert.equal(coolant?.values[0]?.value, 53);
  assert.equal(speed?.values[0]?.value, 78);
  assert.equal(speed?.values[0]?.unit, "km/h");
  assert.equal(frame.unassignedHex, "");
});

test("a documented record with extra bytes keeps them raw instead of misreading them", () => {
  const frame = decodeFreezeFrame(fromHex("0C 30 41 5D 4E 99 88"), {
    code: "P0420",
    recordNumber: 0xff,
    definition: catalyst as DtcDefinition,
    signals: index.byId,
  });

  assert.equal(frame.documented, false, "unassigned bytes mean the layout is not fully understood");
  assert.equal(frame.unassignedHex, "99 88");
  assert.match(frame.notes.join("\n"), /kept raw/);
});

test("a record shorter than the declared layout is reported, not guessed", () => {
  const frame = decodeFreezeFrame(fromHex("0C 30 41"), {
    code: "P0420",
    recordNumber: 0xff,
    definition: catalyst as DtcDefinition,
    signals: index.byId,
  });

  assert.equal(frame.fields.length, 2, "only the fields that fit are decoded");
  assert.match(frame.notes.join("\n"), /shorter than the declared layout/);
  assert.equal(frame.documented, false);
});

test("an undocumented code returns the raw record instead of an invented layout", () => {
  const frame = decodeFreezeFrame(VALID_SNAPSHOT, {
    code: "U0121",
    recordNumber: 1,
    signals: index.byId,
  });
  assert.equal(frame.documented, false);
  assert.deepEqual(frame.fields, []);
  assert.equal(frame.unassignedHex, toHex(VALID_SNAPSHOT));
  assert.match(frame.notes.join("\n"), /no definition/);
});

test("a documented code without a freeze frame layout stays raw", () => {
  const definition: DtcDefinition = { code: "P0171", description: "lean" };
  const frame = decodeFreezeFrame(VALID_SNAPSHOT, {
    code: "P0171",
    recordNumber: 1,
    definition,
    signals: index.byId,
  });
  assert.equal(frame.documented, false);
  assert.match(frame.notes.join("\n"), /documents no freeze frame layout/);
});

/* --------------------------------------------------- clearing fault memory */

/**
 * The clear path itself (stages, permit, verification, refusals) is covered in
 * `../writes/writes.spec.ts` — one suite per behaviour, not two. What stays here
 * is the *contract* the write side relies on: an ECU that is already in a
 * writable session needs no session switch at all.
 */

class FakeEcu implements ClearableEcu {
  id = "ecu-engine";
  name = "Engine Control Unit";
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
    this.codes = this.codes
      .map((record) => ({ ...record, status: (record.status & 0x01) === 0 ? 0x00 : 0x03 }))
      .filter((record) => record.status !== 0x00);
  }
}

function record(code: string, status: number): DtcRecord {
  return {
    code,
    raw: code,
    failureType: "00",
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
    severity: "major",
  };
}

test("an ECU without a session switch is cleared while it stays writable (fail-safe contract)", async () => {
  // `prepareWrite` is optional on purpose: an ECU that must not switch sessions
  // on its own can still be written while it already is in the right one. The
  // operation must not require the switch.
  const safety = new SafetyManager();
  const writes = createWritePort({
    safety,
    scanner: new DtcScanner({ definitions: [genericPackage] }),
  });
  const ecu = new FakeEcu([record("P0300", 0x08)]);

  const result = await runDtcClear(
    writes,
    { target: ecu, userConfirmed: true },
    {
      ecuId: ecu.id,
      ecuName: ecu.name,
      sessionType: ecu.sessionType,
      definitionVersion: "1.0.0",
      vehicleState: {
        stationary: true,
        ignitionOn: true,
        batteryVoltage: 12.6,
        parkingBrake: true,
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(ecu.cleared, 1);
  assert.equal(result.value?.verified, true);
});
