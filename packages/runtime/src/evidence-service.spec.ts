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
import type { CanBus, CanFilter, CanFrame } from "@vdp/transport-can";
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
  } finally {
    await runtime.dispose();
  }
});
