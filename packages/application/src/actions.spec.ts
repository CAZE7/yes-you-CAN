import assert from "node:assert/strict";
import type { EcuSummary } from "@vdp/domain";
import { describe, test } from "vitest";
import { ActionRegistry, type DiagnosticContext, createStandardActions } from "./index.js";

function makeEcu(overrides: Partial<EcuSummary> = {}): EcuSummary {
  return {
    ecuId: "ecu_1",
    name: "Engine",
    protocol: "uds",
    txId: 0x7e0,
    rxId: 0x7e8,
    extended: false,
    reachable: true,
    sessionType: 0x03,
    p2Ms: 50,
    dtcCount: 0,
    supportedServices: [0x10, 0x19, 0x22, 0x2e],
    capabilities: ["read-dtc", "clear-dtc", "read-did", "write-did"],
    identification: [],
    ...overrides,
  };
}

function makeRegistry(): ActionRegistry {
  const registry = new ActionRegistry();
  for (const action of createStandardActions()) registry.register(action);
  return registry;
}

describe("standard action set", () => {
  test("read actions are available on a connected ECU with the capability", () => {
    const registry = makeRegistry();
    const context: DiagnosticContext = { connected: true, ecu: makeEcu() };
    const ids = registry.available(context).map((action) => action.id);
    assert.ok(ids.includes("dtc.read"));
    assert.ok(ids.includes("did.read"));
    assert.ok(ids.includes("dtc.clear"));
    assert.ok(ids.includes("did.write"));
    assert.ok(!ids.includes("routine.run"), "routine needs the routine-control capability");
  });

  test("write actions disappear in the default session", () => {
    const registry = makeRegistry();
    const context: DiagnosticContext = { connected: true, ecu: makeEcu({ sessionType: 0x01 }) };
    const ids = registry.available(context).map((action) => action.id);
    assert.ok(!ids.includes("dtc.clear"), "clear must not be offered in the default session");
    assert.ok(!ids.includes("did.write"), "write must not be offered in the default session");
    assert.ok(ids.includes("dtc.read"), "reads stay available");
  });

  test("nothing is offered without a connection", () => {
    const registry = makeRegistry();
    assert.deepEqual(registry.available({ connected: false }), []);
  });

  test("missing capabilities hide the action", () => {
    const registry = makeRegistry();
    const context: DiagnosticContext = {
      connected: true,
      ecu: makeEcu({ capabilities: ["read-did"] }),
    };
    const ids = registry.available(context).map((action) => action.id);
    assert.deepEqual(ids, ["did.read"]);
  });

  test("without an ECU only capability-free actions qualify", () => {
    const registry = makeRegistry();
    assert.deepEqual(registry.available({ connected: true }), []);
  });
});

describe("action registry", () => {
  test("rejects duplicate ids", () => {
    const registry = new ActionRegistry();
    const [first] = createStandardActions();
    assert.ok(first);
    registry.register(first);
    assert.throws(() => registry.register(first), /already registered/);
  });

  test("list exposes descriptors without execution logic", () => {
    const registry = makeRegistry();
    const list = registry.list();
    assert.ok(list.length >= 5);
    const clear = list.find((action) => action.id === "dtc.clear");
    assert.ok(clear);
    assert.equal(clear.operation, "clear-dtc");
    assert.deepEqual(clear.requiredCapabilities, ["clear-dtc"]);
  });

  test("get returns the definition for a known id", () => {
    const registry = makeRegistry();
    assert.ok(registry.get("dtc.read"));
    assert.equal(registry.get("nope"), undefined);
  });

  test("canExecute reports the blocking reason", () => {
    const registry = makeRegistry();
    const read = registry.get("dtc.read");
    assert.ok(read);
    const verdict = read.canExecute({ connected: false });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason ?? "", /connection/);
  });

  test("custom actions without a description are listed and offered", () => {
    const registry = makeRegistry();
    registry.register({
      id: "custom.probe",
      name: "Probe",
      operation: "read",
      requiredCapabilities: [],
      canExecute: (context) =>
        context.connected ? { ok: true } : { ok: false, reason: "no connection" },
    });
    const listed = registry.list().find((action) => action.id === "custom.probe");
    assert.ok(listed);
    assert.equal("description" in listed, false);
    const available = registry.available({ connected: true });
    assert.ok(available.some((action) => action.id === "custom.probe"));
  });
});
