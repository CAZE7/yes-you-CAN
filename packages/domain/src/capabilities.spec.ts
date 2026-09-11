import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  ALL_CAPABILITIES,
  capabilitiesOf,
  describeCapability,
  hasAllCapabilities,
  hasCapability,
  isDiagnosticCapability,
  missingCapabilities,
} from "./index.js";

describe("capability vocabulary", () => {
  test("every capability is recognised by the type guard", () => {
    for (const capability of ALL_CAPABILITIES) {
      assert.equal(isDiagnosticCapability(capability), true);
    }
    assert.equal(isDiagnosticCapability("not-a-capability"), false);
  });

  test("every capability has a human readable label", () => {
    for (const capability of ALL_CAPABILITIES) {
      const label = describeCapability(capability);
      assert.ok(label.length > 0, `label missing for ${capability}`);
    }
  });

  test("capabilitiesOf de-duplicates", () => {
    const set = capabilitiesOf("read-dtc", "read-dtc", "clear-dtc");
    assert.equal(set.size, 2);
  });
});

describe("capability set operations", () => {
  const set = capabilitiesOf("read-dtc", "read-did", "clear-dtc");

  test("hasCapability", () => {
    assert.equal(hasCapability(set, "read-dtc"), true);
    assert.equal(hasCapability(set, "flash"), false);
  });

  test("hasAllCapabilities", () => {
    assert.equal(hasAllCapabilities(set, ["read-dtc", "read-did"]), true);
    assert.equal(hasAllCapabilities(set, ["read-dtc", "coding"]), false);
    assert.equal(hasAllCapabilities(set, []), true, "no requirements are always fulfilled");
  });

  test("missingCapabilities keeps the requested order", () => {
    assert.deepEqual(missingCapabilities(set, ["flash", "read-dtc", "coding"]), [
      "flash",
      "coding",
    ]);
    assert.deepEqual(missingCapabilities(set, []), []);
  });
});
