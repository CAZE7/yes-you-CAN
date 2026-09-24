/**
 * The evidence service (P0 #39, ADR 0038).
 *
 * The assembly itself is tested in `@vdp/core/src/evidence/`; what belongs here is
 * the seam: the service is on the composed runtime, it reads *that* runtime's
 * session (so a caller cannot hand it a stale one), and an empty session still
 * answers with its open questions instead of an empty list.
 */

import assert from "node:assert/strict";
import { genericPackage } from "@vdp/definitions";
import { createLogger } from "@vdp/shared";
import { type CanBus, type CanFilter, type CanFrame, connectionStatusOf } from "@vdp/transport-can";
import { test } from "vitest";
import { createDiagnosticRuntime } from "./runtime.js";

const logger = createLogger("evidence-test", { level: "ERROR" });

/** A bus that opens but carries no traffic: discovery finds nothing, session stays empty. */
function makeSilentBus(): CanBus {
  let open = false;
  return {
    info: { id: "stub", kind: "stub", name: "Stub", channels: ["stub0"] },
    capabilities: { can: true, canFd: false, doip: false, isoTpOffload: false, channels: 1 },
    async open() {
      open = true;
    },
    async close() {
      open = false;
    },
    getStatus: () => connectionStatusOf(open, "stub"),
    isOpen: () => open,
    async send(_frame: CanFrame) {},
    subscribe(_listener: (frame: CanFrame) => void, _filters?: readonly CanFilter[]) {
      return () => undefined;
    },
  };
}

test("without a session the service refuses instead of answering about nothing", async () => {
  const runtime = createDiagnosticRuntime({
    bus: makeSilentBus(),
    definitions: [genericPackage],
    logger,
  });
  try {
    assert.throws(() => runtime.evidence.snapshot(), /no session — call vehicle.connect\(\) first/);
    assert.throws(() => runtime.evidence.collect(), /no session/);
    assert.throws(() => runtime.evidence.hypotheses(), /no session/);
  } finally {
    await runtime.dispose();
  }
});

test("advanceDiagnosis names what the measurement changed, and nothing more", async () => {
  const bus = makeSilentBus();
  const runtime = createDiagnosticRuntime({ bus, definitions: [genericPackage], logger });
  try {
    await runtime.vehicle.connect({ windowMs: 20, probeDelayMs: 0 });
    const before = runtime.evidence.guidedDiagnosis();
    assert.equal(before.status, "inconclusive");
    assert.equal(before.stepsCompleted, 0);

    // The measurement lands in the recorder; the re-judged state must name the
    // new evidence item, and no outcome (there is no documented pattern yet).
    const step = runtime.evidence.advanceDiagnosis("engine.coolant_temperature", 88, 0);
    assert.equal(step.before, before, "the step carries the state it left behind");
    assert.equal(step.after.stepsCompleted, 1, "the loop counted the step");
    assert.ok(
      step.changes.some(
        (change) =>
          change.kind === "evidence" &&
          change.itemId === "signal:engine.coolant_temperature" &&
          change.change === "added",
      ),
      "the measured signal appears as new evidence",
    );
    assert.ok(
      step.changes.every((change) => change.kind !== "outcome"),
      "no documented pattern, so no hypothesis may claim a transition",
    );

    // The same measurement again: the recorder consolidates it, the diff is
    // empty — the loop reports no progress it did not make.
    const idle = runtime.evidence.advanceDiagnosis("engine.coolant_temperature", 88, 1);
    assert.deepEqual(idle.changes, [], "consolidated measurement, empty diff");
    assert.equal(idle.after.stepsCompleted, 2);

    // A new connection is a new loop: the diff base is dropped.
    runtime.evidence.resetGuidedDiagnosis();
    const afterReset = runtime.evidence.advanceDiagnosis("engine.coolant_temperature", 92, 2);
    assert.equal(afterReset.after.stepsCompleted, 3);
    assert.ok(
      afterReset.changes.every(
        (change) => !(change.kind === "evidence" && change.change === "added"),
      ),
      "same signal, new value: the evidence item consolidates, it does not reappear",
    );
  } finally {
    await runtime.dispose();
  }
});

test("the step API refuses to run about nothing, like the rest of the service", async () => {
  const runtime = createDiagnosticRuntime({
    bus: makeSilentBus(),
    definitions: [genericPackage],
    logger,
  });
  try {
    assert.throws(() => runtime.evidence.advanceDiagnosis("engine.rpm", 1), /no session/);
    assert.throws(() => runtime.evidence.guidedDiagnosis(), /no session/);
  } finally {
    await runtime.dispose();
  }
});

test("an empty session answers with its open questions, not with a blank", async () => {
  const bus = makeSilentBus();
  const runtime = createDiagnosticRuntime({ bus, definitions: [genericPackage], logger });
  try {
    await runtime.vehicle.connect({ windowMs: 20, probeDelayMs: 0 });
    const snapshot = runtime.evidence.snapshot();
    assert.equal(snapshot.evidence.kind, "evidence");
    assert.deepEqual(
      snapshot.evidence.items.map((item) => [item.kind, item.subject]),
      [
        ["vehicle", "determination"],
        ["gap", "signals"],
      ],
      "an unanswered resolution and an empty recording are each a finding; the " +
        "session is not silent about either",
    );
    assert.ok(
      snapshot.evidence.items.every((item) => item.evidence.kind === "unproven"),
      "nothing here was measured, so nothing may be printed as proven",
    );
    assert.deepEqual(snapshot.hypotheses, [], "no scan, so no documented pattern to judge");
    const guided = runtime.evidence.guidedDiagnosis();
    assert.equal(guided.status, "inconclusive");
    assert.match(guided.summary, /No diagnostic hypotheses/);
  } finally {
    await runtime.dispose();
  }
});
