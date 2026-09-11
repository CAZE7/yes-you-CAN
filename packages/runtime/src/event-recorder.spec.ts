import assert from "node:assert/strict";
import { FixedClock, InMemoryEventBus } from "@vdp/domain";
import { test } from "vitest";
import { EventAuditRecorder } from "./event-recorder.js";

test("records every event with the injected clock and filters by session, ecu and kind", () => {
  const bus = new InMemoryEventBus();
  const clock = new FixedClock(1_000);
  const recorder = new EventAuditRecorder(bus, clock);

  bus.publish("vehicle-connected", { sessionId: "s1", ecuCount: 2 });
  bus.publish("ecu-discovered", {
    sessionId: "s1",
    ecuId: "e1",
    name: "ECU",
    txId: 0x7e0,
    rxId: 0x7e8,
    reachable: true,
  });
  // No sessionId on this payload — exercises the "no correlation id" path.
  bus.publish("ecu-capabilities-updated", { ecuId: "e1", capabilities: ["read-dtc"] });
  clock.advance(50);
  bus.publish("vehicle-disconnected", { sessionId: "s1", durationMs: 50 });

  assert.equal(recorder.all.length, 4);
  assert.equal(recorder.all[0]?.at, 1_000);
  assert.equal(recorder.forEvent("vehicle-disconnected")[0]?.at, 1_050);
  // The capabilities event has no sessionId, so the session trail is shorter.
  assert.equal(recorder.forSession("s1").length, 3);
  assert.equal(recorder.forEcu("e1").length, 2);

  const before = recorder.all.length;
  recorder.dispose();
  bus.publish("vehicle-connected", { sessionId: "s2", ecuCount: 0 });
  assert.equal(recorder.all.length, before, "dispose stops observation but keeps the trail");
});

test("falls back to the system clock when none is injected", () => {
  const bus = new InMemoryEventBus();
  const recorder = new EventAuditRecorder(bus);
  bus.publish("vehicle-connected", { sessionId: "s", ecuCount: 0 });
  assert.ok((recorder.all[0]?.at ?? 0) > 0);
  recorder.dispose();
});
