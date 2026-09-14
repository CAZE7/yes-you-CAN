import assert from "node:assert/strict";
import { test } from "vitest";
import { type EcuIdentityLike, resolveStableEcuId, stableEcuId } from "./ecu-identity.js";

test("stableEcuId prefers the definition id and falls back to the name", () => {
  assert.equal(
    stableEcuId({ id: "ecu_1", definitionEcuId: "engine", name: "Engine Control Unit" }),
    "engine",
  );
  assert.equal(stableEcuId({ id: "ecu_2", name: "Engine Control Unit" }), "Engine Control Unit");
});

test("stableEcuId ignores the per-run identifier, which is gone on the next run", () => {
  // A discovered ECU carries `id: "ecu_…"`; an expectation keyed on it would fail on
  // every second run (ADR 0036 §4: a golden session is reproducible or it is noise).
  assert.equal(
    stableEcuId({ id: "ecu_7f3a91", definitionEcuId: "abs", name: "Brake Control Unit" }),
    "abs",
  );
  assert.equal(stableEcuId({ id: "ecu_7f3a91", name: "Brake Control Unit" }), "Brake Control Unit");
});

test("resolveStableEcuId maps a per-run DTC identifier back to the stable one", () => {
  const handles = [
    { session: { record: { id: "ecu_aaa", definitionEcuId: "engine", name: "Engine" } } },
    { session: { record: { id: "ecu_bbb", name: "Transmission Control Unit" } } },
  ] satisfies ReadonlyArray<{ session: { record: EcuIdentityLike } }>;
  assert.equal(resolveStableEcuId(handles, "ecu_aaa"), "engine");
  assert.equal(resolveStableEcuId(handles, "ecu_bbb"), "Transmission Control Unit");
});

test("resolveStableEcuId keeps an unknown identifier instead of inventing one", () => {
  const handles = [
    { session: { record: { id: "ecu_aaa", definitionEcuId: "engine", name: "Engine" } } },
  ] satisfies ReadonlyArray<{ session: { record: EcuIdentityLike } }>;
  assert.equal(resolveStableEcuId(handles, "ecu_unknown"), "ecu_unknown");
  assert.equal(resolveStableEcuId([], "ecu_aaa"), "ecu_aaa");
});
