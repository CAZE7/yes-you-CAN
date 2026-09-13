/**
 * Package migration (AGENTS 13).
 *
 * A recorded session references the definition version it was made with, so the
 * migration rules are contractual: upward only, never in place, and never a
 * silent guess for a version this build does not know.
 */

import assert from "node:assert/strict";
import { DefinitionError } from "@vdp/shared";
import { test } from "vitest";
import { genericPackage } from "./generic/generic-package.js";
import { isSupportedSchemaVersion, needsUpgrade, upgradePackage } from "./migrate.js";
import {
  CURRENT_SCHEMA_VERSION,
  type DefinitionPackage,
  SUPPORTED_SCHEMA_VERSIONS,
} from "./schema.js";

function legacy(overrides: Partial<DefinitionPackage> = {}): DefinitionPackage {
  return {
    schemaVersion: 1,
    oem: "legacy",
    name: "Legacy package",
    version: "1.0.0",
    provenance: { sourceType: "own", source: "test fixture" },
    ecus: [],
    signals: [],
    ...overrides,
  };
}

test("the supported range contains the current version and stays readable below it", () => {
  assert.ok(SUPPORTED_SCHEMA_VERSIONS.includes(CURRENT_SCHEMA_VERSION));
  assert.ok(isSupportedSchemaVersion(1));
  assert.ok(isSupportedSchemaVersion(CURRENT_SCHEMA_VERSION));
  assert.ok(!isSupportedSchemaVersion(CURRENT_SCHEMA_VERSION + 1));
  assert.ok(!isSupportedSchemaVersion(0));
});

test("a version 1 package upgrades to the current model without losing data", () => {
  const before = legacy({ ecus: genericPackage.ecus, signals: genericPackage.signals });
  const after = upgradePackage(before);

  assert.equal(after.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(after.ecus, before.ecus);
  assert.deepEqual(after.signals, before.signals);
  assert.deepEqual(after.vehicles, [], "version 1 has no vehicles to carry over");
  assert.equal(after.oem, before.oem);
  assert.equal(after.version, before.version);
  assert.deepEqual(after.provenance, before.provenance);
});

test("upgrading never edits the package a session may still reference", () => {
  const before = legacy();
  const after = upgradePackage(before);
  assert.notEqual(after, before, "the upgraded package must be a new object");
  assert.equal(before.schemaVersion, 1, "the original stays at its recorded version");
  assert.equal(before.vehicles, undefined);
});

test("a current package is returned by identity, so index caches stay attached", () => {
  const current = legacy({ schemaVersion: CURRENT_SCHEMA_VERSION, vehicles: [] });
  assert.equal(upgradePackage(current), current);
  assert.equal(needsUpgrade(current), false);
});

test("needsUpgrade marks every supported older version", () => {
  assert.equal(needsUpgrade(legacy()), true);
  assert.equal(needsUpgrade(legacy({ schemaVersion: CURRENT_SCHEMA_VERSION })), false);
});

test("an unknown version is an error, not a guess", () => {
  const unsupported = CURRENT_SCHEMA_VERSION + 1;
  assert.throws(
    () => upgradePackage(legacy({ schemaVersion: unsupported })),
    (error: unknown) => {
      assert.ok(error instanceof DefinitionError);
      assert.match(error.message, new RegExp(`schema version ${unsupported}`));
      assert.match(error.message, new RegExp(`supports ${SUPPORTED_SCHEMA_VERSIONS.join(", ")}`));
      return true;
    },
  );
});

test("a version 1 package that already carries vehicles keeps them", () => {
  // Hand-edited or partially migrated sources exist; the upgrade must not drop
  // data just because the version number says it cannot be there.
  const before = legacy({
    schemaVersion: 1,
    vehicles: [{ id: "v", brand: "B", model: "M" }],
  });
  const after = upgradePackage(before);
  assert.equal(after.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(after.vehicles, before.vehicles);
});
