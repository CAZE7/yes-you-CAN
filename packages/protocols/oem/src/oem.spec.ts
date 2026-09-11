import assert from "node:assert/strict";
import { test } from "vitest";
import { OemProtocolRegistry, vagExampleProtocol } from "./index.js";

test("the registry resolves an ECU role from a discovered identifier", () => {
  const registry = new OemProtocolRegistry([vagExampleProtocol]);
  assert.deepEqual(registry.identifyEcu(0x7e8, false), { oem: "vag", role: "engine" });
  assert.deepEqual(registry.identifyEcu(0x7e9, false), { oem: "vag", role: "transmission" });
  assert.equal(registry.identifyEcu(0x123, false), undefined);
});

test("identification hints are scoped to the OEM and role", () => {
  const registry = new OemProtocolRegistry([vagExampleProtocol]);
  assert.equal(registry.identificationDids("vag", "engine").length, 2);
  assert.deepEqual(registry.identificationDids("vag", "transmission"), []);
  assert.deepEqual(registry.identificationDids(undefined, "engine"), [], "no OEM means no hints");
});

test("DTC interpretation falls back to undefined when unknown", () => {
  const registry = new OemProtocolRegistry([vagExampleProtocol]);
  assert.equal(registry.interpretDtc("vag", "P1234")?.severity, "minor");
  assert.equal(registry.interpretDtc("vag", "P0420"), undefined);
  assert.equal(registry.interpretDtc("mercedes", "P1234"), undefined);
});

test("registry listing exposes provenance (AGENTS 24)", () => {
  const registry = new OemProtocolRegistry([vagExampleProtocol]);
  const listed = registry.list();
  assert.equal(listed.length, 1);
  assert.match(listed[0]?.provenance ?? "", /example-placeholder/);
});

test("a later registration replaces the previous one for the same OEM", () => {
  const registry = new OemProtocolRegistry([vagExampleProtocol]);
  registry.register({ ...vagExampleProtocol, displayName: "Replaced" });
  assert.equal(registry.list().length, 1);
  assert.equal(registry.get("vag")?.displayName, "Replaced");
});
