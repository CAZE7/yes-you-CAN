/**
 * The write path: transaction, port and the clear operation (AGENTS 20, 25, 26;
 * master backlog P0 #3, #4, #7).
 *
 * These tests used to live in `dtc.spec.ts` and asserted *thrown* refusals —
 * `assert.rejects(..., /refused/)`. That was a faithful description of a method
 * that threw, and a poor description of a write: the caller could not tell
 * "refused before touching the ECU" from "halfway through" without reading the
 * error. The assertions below are the same scenarios, moved onto the data the
 * write path produces:
 *
 * - refusals come back as `ok: false` with reasons *and* the stage they failed in,
 * - a stage that ran keeps its outcome even when a later one fails,
 * - `verified` is derived from a re-read, never from the positive response,
 * - nothing is written without a permit, and the permit is in the audit log.
 *
 * `FakeEcu` models the one thing a simulator must get right for these tests: a
 * clear resets status bits, and a fault that is still present sets `testFailed`
 * again immediately (status 0x03) — anything else disappears.
 */

import assert from "node:assert/strict";
import { genericPackage } from "@vdp/definitions";
import type { DtcRecord } from "@vdp/protocols-uds";
import { test } from "vitest";
import {
  type ClearDtcResult,
  type ClearableEcu,
  DtcScanner,
  SafetyManager,
  type WriteBinding,
  type WriteOperation,
  type WriteOperationResult,
  WritePort,
  createDtcClearOperation,
  createWritePort,
  precheckDtcClear,
  runDtcClear,
} from "../index.js";
import { DiagnosticTransaction } from "./transaction.js";

class FakeEcu implements ClearableEcu {
  id = "ecu-engine";
  name = "Engine Control Unit";
  sessionType = 0x03;
  cleared = 0;
  codes: DtcRecord[];
  /** Set by tests that exercise a refused session switch. */
  prepareWrite?: (sessionType?: number) => Promise<{ sessionType: number; switched: boolean }>;

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

/** A port with the standard operations and its own safety manager. */
function port(): { port: WritePort; safety: SafetyManager } {
  const safety = new SafetyManager();
  const writePort = createWritePort({ safety, scanner: scanner() });
  return { port: writePort, safety };
}

function scanner(): DtcScanner {
  return new DtcScanner({ definitions: [genericPackage] });
}

/** A second registration of the same kind — the port must refuse it. */
function duplicateClearOperation() {
  return createDtcClearOperation({ scanner: scanner() });
}

function binding(ecu: ClearableEcu, vehicleState = READY_STATE): WriteBinding {
  return {
    ecuId: ecu.id,
    ecuName: ecu.name,
    sessionId: "session_1",
    sessionType: ecu.sessionType,
    definitionVersion: "1.0.0",
    vehicleState,
  };
}

const READY_STATE = {
  stationary: true,
  ignitionOn: true,
  batteryVoltage: 12.6,
  parkingBrake: true,
};

/* ---------------------------------------------- transaction state machine */

test("a transaction reports the stage that failed and where it stopped", async () => {
  const transaction = new DiagnosticTransaction({
    binding: { kind: "clear-dtc", risk: "medium", ecuId: "ecu_1", ecuName: "Engine" },
  });
  assert.equal(transaction.state, "open");

  const prepare = await transaction.stage("prepare", () => ({ ok: true, value: { codes: 2 } }));
  assert.equal(prepare.state, "ok");
  assert.equal(transaction.state, "prepared");
  assert.deepEqual(transaction.value("prepare"), { codes: 2 });

  const report = await transaction.stage("confirm", () => ({ ok: false, reasons: ["no permit"] }));
  assert.equal(report.state, "failed");
  assert.deepEqual(report.reasons, ["no permit"]);
  assert.equal(transaction.state, "prepared", "a failed stage does not advance the state");

  transaction.abort("operator cancelled");
  assert.equal(transaction.state, "aborted");
  const snapshot = transaction.snapshot;
  assert.equal(snapshot.stages.length, 2);
  assert.equal(snapshot.stages[0]?.stage, "prepare");
  assert.equal(snapshot.journal.at(-1)?.state, "aborted");
  assert.equal(snapshot.reason, "operator cancelled");
  assert.ok(snapshot.endedAt, "an ended transaction carries its end");
});

test("a stage that throws becomes a failed report instead of an exception", async () => {
  const transaction = new DiagnosticTransaction({
    binding: { kind: "clear-dtc", risk: "medium", ecuId: "ecu_1", ecuName: "Engine" },
  });
  const report = await transaction.stage("prepare", () => {
    throw new Error("transport lost");
  });
  assert.equal(report.state, "failed");
  assert.deepEqual(report.reasons, ["transport lost"]);
  assert.equal(transaction.state, "open", "the transaction itself is still only open");
});

test("stages are order-checked: nothing verifies a write that never happened", async () => {
  const transaction = new DiagnosticTransaction({
    binding: { kind: "clear-dtc", risk: "medium", ecuId: "ecu_1", ecuName: "Engine" },
  });
  const report = await transaction.stage("verify", () => ({ ok: true }));
  assert.equal(report.state, "failed");
  assert.match(report.reasons[0] ?? "", /not allowed in state "open"/);
  assert.equal(transaction.state, "aborted", "an out-of-order stage fails closed");
});

test("an interrupted write is a state that can be resumed, not a lost call stack", async () => {
  const transaction = new DiagnosticTransaction({
    binding: { kind: "clear-dtc", risk: "medium", ecuId: "ecu_1", ecuName: "Engine" },
  });
  await transaction.stage("prepare", () => ({ ok: true, value: "backup" }));
  transaction.suspend("waiting for the operator");
  assert.equal(transaction.state, "suspended");
  assert.equal(transaction.resume(), true);
  assert.equal(transaction.state, "prepared", "resume continues where it stopped");
  await transaction.stage("confirm", () => ({ ok: true }));
  assert.equal(transaction.state, "confirmed");
  assert.equal(transaction.resume(), false, "a running transaction is not resumed twice");

  transaction.abort("operator aborted");
  assert.equal(transaction.state, "aborted");
  assert.equal(transaction.resume(), false, "a finished transaction stays finished");
});

/* ------------------------------------------------------------- pre-check */

test("the pre-check reports every missing precondition without writing", () => {
  const { port: writes } = port();
  const ecu = new FakeEcu([record("P0420", 0x2f)]);
  const result = precheckDtcClear(writes, { target: ecu, userConfirmed: false }, binding(ecu), {
    userConfirmed: false,
  });
  assert.equal(result.ok, false);
  assert.match(result.failed.join("; "), /confirmation/);
  assert.equal(ecu.cleared, 0, "a pre-check never touches the ECU");
  assert.equal(writes.history.length, 1, "and it is still auditable");
  assert.equal(writes.history[0]?.state, "aborted");
  assert.match(writes.history[0]?.reason ?? "", /pre-check only/);
});

/* ------------------------------------------------------------ write path */

test("clearing fault memory needs the operator confirmation", async () => {
  const { port: writes } = port();
  const ecu = new FakeEcu([record("P0420", 0x2f)]);
  const result = await runDtcClear(writes, { target: ecu, userConfirmed: false }, binding(ecu));

  assert.equal(result.ok, false);
  assert.match(result.reasons.join("; "), /confirmation/);
  assert.equal(ecu.cleared, 0, "a refused clear must not touch the ECU");
  const confirm = result.stages.find((stage) => stage.stage === "confirm");
  assert.equal(confirm?.state, "failed", "the refusal is attributed to the confirm stage");
  assert.equal(result.transaction.state, "aborted");
});

test("clearing fault memory needs a safe vehicle state", async () => {
  const { port: writes } = port();
  const ecu = new FakeEcu([record("P0420", 0x2f)]);
  const result = await runDtcClear(
    writes,
    { target: ecu, userConfirmed: true },
    binding(ecu, {
      stationary: false,
      ignitionOn: true,
      batteryVoltage: 11.2,
      parkingBrake: false,
    }),
  );
  const failed = result.reasons.join("; ");
  assert.equal(result.ok, false);
  assert.match(failed, /not stationary/);
  assert.match(failed, /below the required/);
  assert.equal(ecu.cleared, 0);
});

test("a clear in the default session is refused (ISO 14229-1 §11.3 gating)", async () => {
  const { port: writes } = port();
  const ecu = new FakeEcu([record("P0420", 0x2f)]);
  ecu.sessionType = 0x01;
  const result = await runDtcClear(writes, { target: ecu, userConfirmed: true }, binding(ecu));
  assert.equal(result.ok, false);
  assert.match(result.reasons.join("; "), /default diagnostic session/);
  assert.equal(ecu.cleared, 0);
  assert.ok(
    !result.stages.some((stage) => stage.stage === "execute"),
    "the write stage is never reached",
  );
});

test("a confirmed clear records a backup, verifies by re-reading and reports what survived", async () => {
  const { port: writes } = port();
  const ecu = new FakeEcu([record("P0420", 0x2f), record("P0300", 0x08)]);
  const snapshots: Array<{ label: string; count: number }> = [];
  const actions: string[] = [];

  const result = await runDtcClear(
    writes,
    {
      target: ecu,
      userConfirmed: true,
      recordSnapshot: (records, label) => snapshots.push({ label, count: records.length }),
      recordAction: (action) => actions.push(action.kind),
    },
    binding(ecu),
  );

  assert.equal(result.ok, true);
  assert.equal(ecu.cleared, 1);
  const cleared: ClearDtcResult | undefined = result.value;
  assert.ok(cleared, "a successful run carries the clear result");
  assert.equal(cleared.before.length, 2);
  assert.deepEqual(snapshots, [{ label: "before clear (Engine Control Unit)", count: 2 }]);
  assert.deepEqual(actions, ["clear-dtc"]);
  assert.equal(cleared.permit.risk, "medium");

  // P0300 was confirmed but not currently failing → gone. P0420 is still failing
  // → it stays with a reset status. Both outcomes have to be visible.
  assert.deepEqual(
    cleared.comparison.removed.map((dtc) => dtc.code),
    ["P0300"],
  );
  assert.deepEqual(
    cleared.comparison.changed.map((entry) => entry.code),
    ["P0420"],
  );
  assert.equal(cleared.comparison.unchanged.length, 0);
  assert.equal(cleared.verified, true);
  assert.equal(result.transaction.state, "verified");
  assert.deepEqual(
    result.stages.map((stage) => stage.stage),
    ["prepare", "confirm", "execute", "verify"],
  );
  assert.equal(
    result.stages.find((stage) => stage.stage === "rollback"),
    undefined,
    "rollback is only recorded when it was needed",
  );
});

test("an ECU that ignores the clear is reported as unverified, not as success", async () => {
  const { port: writes, safety } = port();
  const ecu = new FakeEcu([record("P0420", 0x2f), record("P0171", 0x08)]);
  // An ECU that answers positively without doing anything is the failure mode
  // this verification step exists for.
  ecu.clearDiagnosticInformation = async () => {
    ecu.cleared++;
  };

  const result = await runDtcClear(writes, { target: ecu, userConfirmed: true }, binding(ecu));
  assert.equal(result.ok, true, "the request itself succeeded");
  assert.equal(result.value?.verified, false, "but the re-read does not confirm it");
  assert.equal(result.value?.comparison.unchanged.length, 2);
  assert.match(result.warnings.join("; "), /weiterhin an/, "and the caller is told why");
  assert.ok(
    safety.audit.some((entry) => entry.action === "write-failed"),
    "an executed but unconfirmed clear is not a success in the audit log either",
  );
});

test("a failed write is audited and reported with its stage instead of being swallowed", async () => {
  const { port: writes, safety } = port();
  const ecu = new FakeEcu([record("P0420", 0x2f)]);
  ecu.clearDiagnosticInformation = async () => {
    throw new Error("transport lost");
  };
  const result = await runDtcClear(writes, { target: ecu, userConfirmed: true }, binding(ecu));

  assert.equal(result.ok, false);
  assert.match(result.reasons.join("; "), /transport lost/);
  const execute = result.stages.find((stage) => stage.stage === "execute");
  assert.equal(execute?.state, "failed");
  assert.equal(result.transaction.state, "aborted");
  // The rollback stage is recorded as skipped *with the reason*: a clear cannot
  // be undone, and the audit log says so instead of pretending.
  const rollback = result.stages.find((stage) => stage.stage === "rollback");
  assert.equal(rollback?.state, "skipped");
  assert.match(rollback?.reasons[0] ?? "", /keinen Dienst/);
  assert.ok(
    safety.audit.some((entry) => entry.action === "write-failed"),
    "the audit log has to record the failure",
  );
});

test("a refused session switch aborts before anything is written", async () => {
  const { port: writes } = port();
  const ecu = new FakeEcu([record("P0420", 0x2f)]);
  ecu.sessionType = 0x01;
  ecu.prepareWrite = async () => {
    throw new Error("ECU refused the session switch");
  };
  const actions: string[] = [];
  const result = await runDtcClear(
    writes,
    { target: ecu, userConfirmed: true, recordAction: (action) => actions.push(action.kind) },
    binding(ecu),
  );

  assert.equal(result.ok, false);
  assert.equal(ecu.cleared, 0);
  const prepare = result.stages.find((stage) => stage.stage === "prepare");
  assert.equal(prepare?.state, "failed");
  assert.match(prepare?.reasons[0] ?? "", /Sitzung nicht umschaltbar/);
  assert.deepEqual(actions, ["clear-dtc"], "the audit action is written by the operation");
  assert.equal(
    result.stages.filter((stage) => stage.stage === "confirm").length,
    0,
    "no permit is requested for a write that cannot start",
  );
  assert.equal(result.transaction.state, "aborted");
});

test("a fault memory that cannot be read aborts the clear before anything is written", async () => {
  const { port: writes } = port();
  const ecu = new FakeEcu([record("P0420", 0x2f)]);
  ecu.readDtcs = async () => {
    throw new Error("no response");
  };
  const result = await runDtcClear(writes, { target: ecu, userConfirmed: true }, binding(ecu));

  assert.equal(result.ok, false);
  assert.equal(ecu.cleared, 0);
  const prepare = result.stages.find((stage) => stage.stage === "prepare");
  assert.equal(prepare?.state, "failed");
  assert.match(prepare?.reasons[0] ?? "", /nicht lesbar/);
  assert.equal(result.transaction.state, "aborted");
});

test("a stage that rejects with a non-error still yields a readable reason", async () => {
  const { port: writes } = port();

  // A rejected string travels verbatim — Promise.reject("boom") never becomes an Error.
  const stringEcu = new FakeEcu([record("P0420", 0x2f)]);
  stringEcu.readDtcs = () => Promise.reject("boom");
  const stringResult = await runDtcClear(
    writes,
    { target: stringEcu, userConfirmed: true },
    binding(stringEcu),
  );
  assert.equal(stringResult.ok, false);
  assert.match(stringResult.reasons.join("; "), /boom/);

  const numberEcu = new FakeEcu([record("P0420", 0x2f)]);
  numberEcu.readDtcs = () => Promise.reject(42);
  const numberResult = await runDtcClear(
    writes,
    { target: numberEcu, userConfirmed: true },
    binding(numberEcu),
  );
  assert.equal(numberResult.ok, false);
  assert.match(numberResult.reasons.join("; "), /unbekannter Fehler/);
});

test("a write without a definition version describes itself without one", () => {
  const operation = createDtcClearOperation({ scanner: scanner() });
  const ecu = new FakeEcu([record("P0420", 0x2f)]);
  const transaction = new DiagnosticTransaction({
    binding: { kind: "clear-dtc", risk: "medium", ecuId: ecu.id, ecuName: ecu.name },
  });
  const described = operation.describe(
    transaction,
    { target: ecu, userConfirmed: true },
    undefined,
    ecu.sessionType,
  );
  assert.ok(!("definitionVersion" in described.context));
});

test("verification without a logged permit refuses, even when the re-read is clean", async () => {
  const operation = createDtcClearOperation({ scanner: scanner() });
  assert.ok(operation.verify, "the operation verifies by re-read");
  const ecu = new FakeEcu([]);
  // A fresh transaction never confirmed anything — no permit was logged.
  const transaction = new DiagnosticTransaction({
    binding: { kind: "clear-dtc", risk: "medium", ecuId: ecu.id, ecuName: ecu.name },
  });
  const outcome = await operation.verify(
    transaction,
    { target: ecu, userConfirmed: true },
    { before: [], sessionType: ecu.sessionType },
    // The arm under test returns before touching the execute value.
    undefined as unknown as ClearDtcResult,
  );
  assert.equal(outcome.ok, false);
  assert.match(outcome.reasons?.join("; ") ?? "", /kein Write-Permit/);
});

test("an unverified clear says so in its audit description", async () => {
  const { port: writes } = port();
  const ecu = new FakeEcu([record("P0420", 0x2f)]);
  ecu.clearDiagnosticInformation = async () => {
    ecu.cleared++;
  };
  const descriptions: string[] = [];
  const result = await runDtcClear(
    writes,
    {
      target: ecu,
      userConfirmed: true,
      recordAction: (action) => descriptions.push(action.description),
    },
    binding(ecu),
  );
  assert.equal(result.value?.verified, false);
  assert.match(descriptions.join("; "), /nicht vollständig bestätigt/);
});

/* ----------------------------------------------- the port as a machine */

/**
 * The generic paths of the port — verified with an operation that has no
 * domain meaning at all, because that is what the port must be able to run.
 * `clear-dtc` is one operation; the port is the machine every later one (coding,
 * adaptation, routine — master backlog P2) will use.
 */
function testOperation(
  overrides: Partial<WriteOperation<TestInput, string, string>> = {},
): WriteOperation<TestInput, string, string> {
  return {
    kind: "test-write",
    title: "Testwrite",
    risk: "low",
    async prepare() {
      return { ok: true, value: "backup" };
    },
    describe(transaction) {
      // Same rule as the real operation: the definition version comes from the
      // binding, so the permit is never described with a different version than
      // the transaction records.
      const definitionVersion = transaction.snapshot.binding.definitionVersion;
      return {
        context: {
          ecuId: "ecu-test",
          ecuName: "Test ECU",
          newValue: "0x01",
          risk: "low",
          userConfirmed: true,
          backupAvailable: true,
          activeSessionType: 0x03,
          ...(definitionVersion !== undefined ? { definitionVersion } : {}),
        },
      };
    },
    async execute() {
      return { ok: true, value: "done" };
    },
    ...overrides,
  };
}

interface TestInput {
  userConfirmed: boolean;
}

function testPort(
  operation: WriteOperation<TestInput, string, string>,
  options: { historySize?: number } = {},
): WritePort {
  const port = new WritePort({
    safety: new SafetyManager(),
    ...(options.historySize !== undefined ? { historySize: options.historySize } : {}),
  });
  port.register(operation);
  return port;
}

const TEST_BINDING: WriteBinding = {
  ecuId: "ecu-test",
  ecuName: "Test ECU",
  sessionType: 0x03,
  definitionVersion: "9.9.9",
  vehicleState: { stationary: true, ignitionOn: true, batteryVoltage: 12.6, parkingBrake: true },
};

test("an operation without a read-back verification says so instead of pretending", async () => {
  const port = testPort(testOperation());
  const result = await runTestWrite(port);
  assert.equal(result.ok, true);
  const verify = result.stages.find((stage) => stage.stage === "verify");
  assert.equal(verify?.state, "skipped");
  assert.match(verify?.reasons[0] ?? "", /no read-back verification/);
});

test("an operation that can be undone is rolled back, and the state says so", async () => {
  const calls: string[] = [];
  const port = testPort(
    testOperation({
      async execute() {
        return { ok: false, reasons: ["write rejected by the ECU"] };
      },
      async rollback(_transaction, _input, reason) {
        calls.push(reason);
        return { ok: true };
      },
    }),
  );
  const result = await runTestWrite(port);
  assert.equal(result.ok, false);
  assert.deepEqual(calls, ["write rejected by the ECU"]);
  assert.equal(result.transaction.state, "rolled-back");
  const rollback = result.stages.find((stage) => stage.stage === "rollback");
  assert.equal(rollback?.state, "ok");
});

test("a rollback that itself fails is reported as an abort, not as a rollback", async () => {
  const port = testPort(
    testOperation({
      async execute() {
        return { ok: false, reasons: ["write rejected"] };
      },
      async rollback() {
        throw new Error("undo also failed");
      },
    }),
  );
  const result = await runTestWrite(port);
  assert.equal(result.transaction.state, "aborted");
  assert.match(result.transaction.reason ?? "", /rollback failed: undo also failed/);
});

test("a pre-check works without a session type — the default session is assumed, not required", () => {
  const port = testPort(testOperation());
  const { sessionType: _omitted, ...withoutSessionType } = TEST_BINDING;
  const result = port.precheck("test-write", { userConfirmed: true }, withoutSessionType, {
    userConfirmed: true,
  });
  assert.equal(result.ok, true);
  assert.match(result.transactionId, /^tx_/);
});

test("a prepare that fails without reasons still aborts with a named reason", async () => {
  const port = testPort(
    testOperation({
      async prepare() {
        return { ok: false, reasons: [] };
      },
    }),
  );
  const result = await runTestWrite(port);
  assert.equal(result.ok, false);
  assert.equal(result.transaction.state, "aborted");
  assert.equal(result.transaction.reason, "prepare did not capture the previous state");
});

test("a permit refused at issue-time aborts the confirm stage instead of running on", async () => {
  const safety = new SafetyManager();
  safety.requestPermit = () => {
    throw new Error("permit printer jammed");
  };
  const port = new WritePort({ safety });
  port.register(testOperation());
  const result = await runTestWrite(port);
  assert.equal(result.ok, false);
  assert.equal(result.transaction.state, "aborted");
  assert.match(result.reasons.join("; "), /permit printer jammed/);
});

test("a failed confirm tells missing proofs apart from violations (P0 #5)", async () => {
  const port = testPort(testOperation());
  const { batteryVoltage: _omitted, ...restedState } = TEST_BINDING.vehicleState;
  const result = await port.run<TestInput, string, string>(
    "test-write",
    { userConfirmed: true },
    { ...TEST_BINDING, vehicleState: restedState },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.unproven, [
    "battery voltage unknown — cannot prove the supply is stable",
  ]);
  assert.ok(result.reasons.some((reason) => reason.includes("battery voltage unknown")));
});

test("a reason-less execute failure aborts with the operation kind as the reason", async () => {
  const port = testPort(
    testOperation({
      async execute() {
        return { ok: false, reasons: [] };
      },
    }),
  );
  const result = await runTestWrite(port);
  assert.equal(result.ok, false);
  assert.equal(result.transaction.state, "aborted");
  assert.equal(result.transaction.reason, "test-write failed");
  const rollback = result.stages.find((stage) => stage.stage === "rollback");
  assert.equal(rollback?.state, "skipped");
  assert.match(rollback?.reasons[0] ?? "", /provides no rollback/);
});

test("a write without a value finishes without claiming one", async () => {
  const port = testPort(
    testOperation({
      async execute() {
        return { ok: true };
      },
    }),
  );
  const result = await runTestWrite(port);
  assert.equal(result.ok, true);
  assert.ok(!("value" in result));
});

test("a run without a session type anywhere describes the write in the default session", async () => {
  let seen: number | undefined;
  const port = testPort(
    testOperation({
      describe(transaction, _input, _prepared, sessionType) {
        seen = sessionType;
        const definitionVersion = transaction.snapshot.binding.definitionVersion;
        return {
          context: {
            ecuId: "ecu-test",
            ecuName: "Test ECU",
            newValue: "0x01",
            risk: "low",
            userConfirmed: true,
            backupAvailable: true,
            activeSessionType: 0x03,
            ...(definitionVersion !== undefined ? { definitionVersion } : {}),
          },
        };
      },
    }),
  );
  const { sessionType: _omitted, ...withoutSessionType } = TEST_BINDING;
  const result = await port.run<TestInput, string, string>(
    "test-write",
    { userConfirmed: true },
    withoutSessionType,
  );
  assert.equal(result.ok, true);
  assert.equal(seen, 0x01);
});

test("a run without a definition version is refused — nothing is verified, nothing runs", async () => {
  const port = testPort(testOperation());
  const { definitionVersion: _omitted, ...withoutDefinition } = TEST_BINDING;
  const result = await port.run<TestInput, string, string>(
    "test-write",
    { userConfirmed: true },
    withoutDefinition,
  );
  assert.equal(result.ok, false);
  assert.ok(!("definitionVersion" in result.transaction.binding));
  assert.match(result.reasons.join("; "), /no definition version/);
  assert.equal(result.transaction.state, "aborted");
});

test("the port forgets old transactions first — an audit trail with a bound", async () => {
  const port = testPort(testOperation(), { historySize: 1 });
  await runTestWrite(port);
  await runTestWrite(port);
  assert.equal(port.history.length, 1, "only the newest transaction is kept");
});

test("an operation that reports its own outcome decides what the audit log says", async () => {
  const safety = new SafetyManager();
  const port = new WritePort({ safety });
  port.register(testOperation({ outcomeOf: () => false }));
  const result = await runTestWrite(port);
  assert.equal(result.ok, true, "the write itself succeeded");
  assert.ok(
    safety.audit.some((entry) => entry.action === "write-failed"),
    "but the operation says it did not reach its goal",
  );
});

test("an unknown operation kind is a programming error, not a denied write", async () => {
  const { port: writes } = port();
  assert.deepEqual(writes.kinds, ["clear-dtc", "coding", "adaptation"]);
  const empty = new WritePort({ safety: new SafetyManager() });
  await assert.rejects(
    empty.run("flash", { userConfirmed: true }, TEST_BINDING),
    /unknown write operation "flash" — registered: \(none\)/,
  );
  await assert.rejects(
    writes.run("flash", { target: new FakeEcu([]), userConfirmed: true }, binding(new FakeEcu([]))),
    /unknown write operation "flash"/,
  );
  assert.throws(() => writes.register(duplicateClearOperation()), /already registered/);
});

/** Run the test operation the way the runtime would: through the port. */
function runTestWrite(port: WritePort): Promise<WriteOperationResult<string>> {
  return port.run<TestInput, string, string>("test-write", { userConfirmed: true }, TEST_BINDING);
}
