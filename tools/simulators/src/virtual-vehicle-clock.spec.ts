/**
 * The clock of the dynamic signal model is a parameter, not the machine's speed.
 *
 * Measured before this existed: `npm run golden:record` on an unchanged tree produced
 * **44 drifting value lines** — `abs.wheel_speed` 40,76 → 40,78, `engine.rpm`
 * 831,3 → 832, `maf` 4,23 → 4,24. The cause was one line: `signalValue` derived every
 * evolving signal from `Date.now() - startedAt`, so a recording taken a second later
 * was another car (ADR 0052).
 *
 * The assertions go over the wire, not against a field of the simulator — a `0x22`
 * read of the coolant temperature, the same way a diagnosis would ask — the rule
 * `high-fidelity-vehicle.spec.ts` states for the whole simulator suite.
 */

import assert from "node:assert/strict";
import { genericPackage } from "@vdp/definitions";
import { UdsClient } from "@vdp/protocols-uds";
import { createLogger } from "@vdp/shared";
import { IsoTpConnection } from "@vdp/transport-iso-tp";
import { describe, test } from "vitest";
import { VirtualVehicle } from "./virtual-vehicle.js";

const logger = createLogger("clock-spec", { level: "ERROR" });

/** Engine coolant temperature as the engine reports it on DID 0xF405. */
const COOLANT_DID = 0xf405;

/**
 * A tester on the vehicle's bus, addressed the way a diagnosis addresses the engine.
 *
 * The clock the vehicle was given is deliberately *not* the tester's: the ISO-TP
 * timing needs a real clock to time out, which is why only the signal model reads the
 * injected one.
 */
function engineTester(vehicle: VirtualVehicle): UdsClient {
  const ecu = vehicle.ecus.find((candidate) =>
    candidate.signals.some((signal) => signal.id === "engine.coolant_temperature"),
  );
  if (ecu === undefined) throw new Error("the package declares no engine coolant temperature");
  const isoTp = new IsoTpConnection(
    // The tester sits on the shared bus, addressed from the tester's side — the same
    // convention `high-fidelity-vehicle.spec.ts` documents, so the ids are not swapped.
    vehicle.testerBus,
    {
      txId: ecu.definition.address.txId,
      rxId: ecu.definition.address.rxId,
      extended: ecu.definition.address.extended ?? false,
      addressing: ecu.definition.address.addressing ?? "normal",
      padding: true,
    },
    logger,
  );
  isoTp.open();
  return new UdsClient(isoTp, {
    name: ecu.definition.name,
    logger,
    timing: { p2Ms: 200, p2StarMs: 400, s3Ms: 5_000 },
  });
}

/** The coolant temperature off the wire, in °C (one byte, offset −40). */
async function readCoolant(tester: UdsClient): Promise<number> {
  const payload = await tester.readDid(COOLANT_DID);
  assert.ok(payload !== null && payload.length >= 1, "the engine answers 0xF405");
  return (payload?.[0] ?? 0) - 40;
}

describe("the dynamic signal model reads an injected clock", () => {
  test("two vehicles with the same seed and the same clock report the same value", async () => {
    // This is the property a golden recording needs: the recipe decides the car, not
    // the moment the recording ran.
    const read = async (): Promise<number> => {
      let ms = 0;
      const vehicle = new VirtualVehicle({
        definitions: genericPackage,
        seed: 4242,
        clock: () => 1_700_000_000_000 + ms,
      });
      await vehicle.start();
      try {
        ms = 30_000; // the same step the recorder would take
        return await readCoolant(engineTester(vehicle));
      } finally {
        await vehicle.stop();
      }
    };
    const first = await read();
    const second = await read();
    assert.equal(first, second, "the same recipe is the same car");
    // The second half is what makes this assertion bite: on the wall clock the model
    // would compute `20 + 0.8 × elapsed` for the ~1000 days between the injected epoch
    // (2023-11) and now, and the ceiling would answer 105 for every recipe. Equality
    // alone would then hold for the wrong reason.
    assert.ok(
      first < 100,
      `the clock is the model's, not the machine's (${first} °C — 105 is the ceiling ` +
        "a wall clock produces against this epoch)",
    );
  });

  test("advancing the clock moves the signal — so the clock is really the source", async () => {
    // Without the injection this assertion fails: `elapsedS` would come from
    // `Date.now()`, and the few milliseconds a test takes would leave the coolant
    // temperature where it was. That is the bite.
    let ms = 0;
    const vehicle = new VirtualVehicle({
      definitions: genericPackage,
      seed: 4242,
      clock: () => 1_700_000_000_000 + ms,
    });
    await vehicle.start();
    try {
      const tester = engineTester(vehicle);
      const cold = await readCoolant(tester);
      ms = 60_000; // a minute of model time
      const warm = await readCoolant(tester);
      assert.ok(
        warm > cold,
        `the coolant warms as the model's clock runs (cold ${cold} °C, warm ${warm} °C)`,
      );
    } finally {
      await vehicle.stop();
    }
  });

  test("without a clock option the vehicle still runs on the wall clock", async () => {
    // The demo case: nothing passed, nothing broken. Asserted because the default is
    // the behaviour every existing caller relies on.
    const vehicle = new VirtualVehicle({ definitions: genericPackage, seed: 4242 });
    await vehicle.start();
    try {
      const value = await readCoolant(engineTester(vehicle));
      assert.ok(value >= 15 && value <= 105, `a plausible coolant temperature (${value} °C)`);
    } finally {
      await vehicle.stop();
    }
  });
});
