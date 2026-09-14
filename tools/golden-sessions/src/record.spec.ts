import assert from "node:assert/strict";
import type { DecodedSignal } from "@vdp/core";
import { genericPackage } from "@vdp/definitions/generic";
import { createLogger } from "@vdp/shared";
import { test } from "vitest";
import { findVinLikeTokens, goldenSessionToJson, parseGoldenSession } from "./index.js";
import { STANDARD_RECIPES } from "./recipes.js";
import {
  GOLDEN_CONNECT_OPTIONS,
  type GoldenRecipe,
  recordGoldenSession,
  signalExpectations,
} from "./record.js";

const logger = createLogger("golden", { level: "ERROR" });

function signal(
  partial: Partial<DecodedSignal> & { signalId: string; value: number | string | boolean },
): DecodedSignal {
  return {
    name: partial.signalId,
    raw: new Uint8Array([0x00]),
    rawHex: "00",
    rawValue: partial.value,
    outOfRange: false,
    did: 0xf40c,
    ecu: "engine",
    ...partial,
  };
}

test("a deterministic signal becomes an equality expectation", () => {
  const expectations = signalExpectations([
    signal({ signalId: "engine.rpm", value: 850 }),
    signal({ signalId: "engine.rpm", value: 850 }),
  ]);
  assert.equal(expectations.length, 1);
  assert.equal(expectations[0]?.signal, "engine.rpm");
  assert.equal(expectations[0]?.ecu, "engine");
  assert.equal(expectations[0]?.equal, 850);
  assert.equal(expectations[0]?.minSamples, undefined, "one sample is enough for a fixed value");
});

test("a moving signal becomes a range plus a sample requirement", () => {
  const expectations = signalExpectations([
    signal({ signalId: "engine.rpm", value: 850 }),
    signal({ signalId: "engine.rpm", value: 3120 }),
    signal({ signalId: "vehicle.speed", value: 0 }),
    signal({ signalId: "vehicle.speed", value: 78 }),
  ]);
  assert.deepEqual(
    expectations.map((expectation) => [expectation.signal, expectation.min, expectation.max]),
    [
      ["engine.rpm", 850, 3120],
      ["vehicle.speed", 0, 78],
    ],
    "expectations are sorted by key so two recordings produce the same file",
  );
  assert.equal(expectations[0]?.equal, undefined);
  assert.equal(expectations[0]?.minSamples, 1);
});

test("signals of different ECUs stay separate expectations", () => {
  const expectations = signalExpectations([
    signal({ signalId: "engine.rpm", value: 850 }),
    signal({ signalId: "engine.rpm", value: 850, ecu: "abs" }),
  ]);
  assert.equal(expectations.length, 2);
  assert.deepEqual(
    expectations.map((expectation) => expectation.ecu),
    ["abs", "engine"],
  );
});

test("non-numeric values are compared by value, not by rounding", () => {
  const expectations = signalExpectations([
    signal({ signalId: "engine.vin", value: "REDACTED-VIN-0000" }),
    signal({ signalId: "engine.vin", value: "REDACTED-VIN-0000" }),
    signal({ signalId: "engine.rpm", value: 850.1234567 }),
    signal({ signalId: "engine.rpm", value: 850.1234567 }),
  ]);
  const bySignal = new Map(expectations.map((expectation) => [expectation.signal, expectation]));
  assert.equal(bySignal.get("engine.vin")?.equal, "REDACTED-VIN-0000");
  assert.equal(
    bySignal.get("engine.rpm")?.equal,
    850.123457,
    "floating point noise is rounded away",
  );
});

test("recording a recipe produces a redacted, self-consistent session", async () => {
  const recipe: GoldenRecipe = {
    ...(STANDARD_RECIPES[0] as GoldenRecipe),
    id: "recorder-spec",
  };
  const { session, observed } = await recordGoldenSession({
    recipe,
    definitions: genericPackage,
    definitionsName: "generic",
    definitionsVersion: genericPackage.version,
    logger,
  });

  assert.equal(session.format, "vdp.golden");
  assert.equal(session.id, "recorder-spec");
  assert.equal(session.provenance.recordedBy, "npm run golden:record");
  assert.equal(session.provenance.source, "simulator");
  assert.deepEqual(session.provenance.redaction, ["vin"]);
  assert.equal(observed.frames, session.recording.trace.length);
  assert.ok(observed.ecus >= 3, "the simulator answers for three ECUs");
  assert.ok(observed.dtcs > 0, "the recipe keeps the package fault memory");

  // The VIN of the run is gone from the file — from the text *and* from the frames,
  // which is what a text-only redaction would miss.
  const json = goldenSessionToJson(session);
  assert.equal(json.includes("1HGCM82633A004352"), false);
  assert.deepEqual(findVinLikeTokens(JSON.stringify(session.recording)), []);
  assert.equal(session.expectations.identity?.vin, "REDACTED-VIN-0000");
  assert.equal(
    session.expectations.identity?.vinDerived?.includes("modelYear"),
    true,
    "the model year comes out of the VIN analysis and cannot survive redaction",
  );

  // Recording a fact has to be readable back as the same fact.
  assert.deepEqual(parseGoldenSession(json, recipe.id), session);
  assert.equal(GOLDEN_CONNECT_OPTIONS.probeDelayMs, 0);
  assert.equal(GOLDEN_CONNECT_OPTIONS.windowMs, 60);
});
