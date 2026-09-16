/**
 * The wiring table on its own (AGENTS 32) — the four failure modes, the hysteresis-free
 * arithmetic of a corroded feed, and the cadence of a contact that comes and goes.
 *
 * Tested without a vehicle: the class reads a context, so a test can state the rail and
 * the clock directly. That is also the point of the split — if the wiring needed the model
 * to be observable, the two would still be one module.
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { WiringContext } from "./vehicle-wiring.js";
import { ModuleWiring } from "./vehicle-wiring.js";

function context(over: Partial<WiringContext> = {}): WiringContext {
  const base: WiringContext = {
    supplyVoltage: 12.6,
    timeMs: 0,
    stepMs: 20,
    brownoutV: 8,
    electricalLoadA: 0,
    random: () => 0.5,
    ...over,
  };
  return base;
}

/** A wiring table driven by a clock the test moves. */
function harness(initial: Partial<WiringContext> = {}): {
  wiring: ModuleWiring;
  advance(ms: number, over?: Partial<WiringContext>): void;
} {
  let current = context(initial);
  const wiring = new ModuleWiring(() => current);
  return {
    wiring,
    advance(ms, over) {
      current = { ...current, ...over, timeMs: current.timeMs + ms };
      wiring.step();
    },
  };
}

describe("supply at the pins", () => {
  test("an intact feed gets the rail", () => {
    const { wiring } = harness();
    assert.equal(wiring.supplyOf("abs"), 12.6);
    assert.equal(wiring.isPowered("abs"), true);
    assert.equal(wiring.isBusConnected("abs"), true);
  });

  test("a power cut takes both the supply and the bus", () => {
    const { wiring } = harness();
    wiring.set({ ecu: "abs", mode: "power-cut" });
    assert.equal(wiring.supplyOf("abs"), 0);
    assert.equal(wiring.isPowered("abs"), false);
    assert.equal(wiring.isBusConnected("abs"), false);
    assert.deepEqual(wiring.affected(), ["abs"]);
    wiring.clear("abs");
    assert.equal(wiring.isPowered("abs"), true, "and a repair is a repair, not a reboot");
    assert.deepEqual(wiring.affected(), []);
  });

  test("an open pair leaves the module alive and unheard", () => {
    const { wiring } = harness();
    wiring.set({ ecu: "gateway", mode: "bus-open" });
    assert.equal(wiring.supplyOf("gateway"), 12.6, "supply untouched");
    assert.equal(wiring.isPowered("gateway"), true);
    assert.equal(wiring.isBusConnected("gateway"), false, "and that difference is a diagnosis");
  });

  test("a corroded feed sags with the load, not at rest", () => {
    // 50 mΩ across a terminal is nothing on a bench and a fault in a car: the numbers
    // below are the same resistance at two different currents, and only the second one
    // crosses a threshold. A model that stored "faulty: true" cannot say that at all.
    const atRest = harness();
    atRest.wiring.set({ ecu: "bcm", mode: "supply-resistance", ohm: 0.05 });
    assert.ok(Math.abs(atRest.wiring.supplyOf("bcm") - (12.6 - 0.4 * 0.05)) < 1e-9);
    assert.equal(atRest.wiring.isPowered("bcm"), true, "at rest the fault is invisible");

    const loaded = new ModuleWiring(() => context({ supplyVoltage: 12.6, electricalLoadA: 30 }));
    loaded.set({ ecu: "bcm", mode: "supply-resistance", ohm: 0.05 });
    assert.equal(loaded.supplyOf("bcm"), 12.6 - 30.4 * 0.05, "30 A times the added resistance");

    const fatal = new ModuleWiring(() => context({ supplyVoltage: 12.6, electricalLoadA: 40 }));
    fatal.set({ ecu: "bcm", mode: "supply-resistance", ohm: 0.15 });
    assert.ok(
      fatal.supplyOf("bcm") < 8,
      `40 A across 150 mΩ is ${fatal.supplyOf("bcm")} V at the pin — below brown-out`,
    );
    assert.equal(fatal.isPowered("bcm"), false);
    assert.equal(
      fatal.isBusConnected("bcm"),
      false,
      "and a module that browns out under load goes silent on the bus with it, which is how the gateway notices",
    );
  });

  test("a below-threshold pin is not powered, whatever the battery says", () => {
    const { wiring } = harness({ supplyVoltage: 7.5 });
    assert.equal(wiring.isPowered("abs"), false);
    assert.equal(wiring.isBusConnected("abs"), false, "no supply, no frames either");
  });
});

describe("an intermittent contact", () => {
  test("a window shorter than the step is widened to one step", () => {
    const { wiring } = harness();
    wiring.set({ ecu: "abs", mode: "connector-loose", flapMs: 5, duty: 0 });
    // flapMs 5 < stepMs 20, so the window becomes one step and the very first step
    // decides; and a duty of 0 can never hold. A model that clamped this the other way
    // would decide once a minute and call it intermittent.
    wiring.step();
    assert.equal(wiring.isPowered("abs"), false);
  });

  test("random pattern draws from the injected source, and from nowhere else", () => {
    const holds = new ModuleWiring(() => context({ random: () => 0.2 }));
    holds.set({ ecu: "abs", mode: "connector-loose", duty: 0.5, flapMs: 100 });
    holds.step();
    assert.equal(holds.isPowered("abs"), true, "0.2 < 0.5 → the contact holds");

    const open = new ModuleWiring(() => context({ random: () => 0.9 }));
    open.set({ ecu: "abs", mode: "connector-loose", duty: 0.5, flapMs: 100 });
    open.step();
    assert.equal(open.isPowered("abs"), false, "0.9 ≥ 0.5 → it does not");

    // Before the first decision the module is treated as wired: a fault that had not been
    // sampled yet must not read as a defect that was never applied.
    const fresh = new ModuleWiring(() => context({ random: () => 0.9 }));
    fresh.set({ ecu: "abs", mode: "connector-loose", duty: 0.5, flapMs: 100 });
    assert.equal(fresh.isPowered("abs"), true);
  });

  test("the alternate pattern alternates on the clock, and repeats exactly", () => {
    const run = (): boolean[] => {
      const { wiring, advance } = harness();
      wiring.set({ ecu: "abs", mode: "connector-loose", flapMs: 100, pattern: "alternate" });
      const seen: boolean[] = [];
      for (let i = 0; i < 6; i++) {
        advance(100);
        seen.push(wiring.isPowered("abs"));
      }
      return seen;
    };
    const first = run();
    assert.deepEqual(first, run(), "two runs of the same clock agree — no rng involved");
    assert.equal(new Set(first).size, 2, "and both contact states were reached");
  });

  test("a window shorter than the step still decides once per step", () => {
    const { wiring, advance } = harness();
    wiring.set({ ecu: "abs", mode: "connector-loose", flapMs: 1, pattern: "alternate" });
    const seen = new Set<boolean>();
    for (let i = 0; i < 4; i++) {
      advance(20);
      seen.add(wiring.isPowered("abs"));
    }
    assert.equal(seen.size, 2, "clamped to the step, not frozen at one decision");
  });

  test("clearing a fault restores the contact immediately", () => {
    const { wiring, advance } = harness();
    wiring.set({ ecu: "abs", mode: "connector-loose", flapMs: 1000, pattern: "alternate" });
    advance(1_000);
    assert.equal(wiring.isPowered("abs"), false, "mid-window, open");
    wiring.clear("abs");
    assert.equal(wiring.isPowered("abs"), true, "repaired, without waiting for the window");
  });
});

describe("the table", () => {
  test("clearAll forgets every defect and its cadence", () => {
    const { wiring, advance } = harness();
    wiring.set({ ecu: "abs", mode: "connector-loose", flapMs: 100, pattern: "alternate" });
    wiring.set({ ecu: "bcm", mode: "power-cut" });
    advance(100);
    assert.deepEqual(wiring.affected(), ["abs", "bcm"]);
    wiring.clearAll();
    assert.deepEqual(wiring.affected(), []);
    assert.equal(wiring.supplyOf("abs"), 12.6);
    assert.equal(wiring.supplyOf("bcm"), 12.6);
  });

  test("re-applying a fault restarts its window", () => {
    const { wiring, advance } = harness();
    wiring.set({ ecu: "abs", mode: "connector-loose", flapMs: 100, pattern: "alternate" });
    advance(100);
    assert.equal(wiring.isPowered("abs"), false, "window 1 of the first application: open");
    wiring.set({ ecu: "abs", mode: "connector-loose", flapMs: 100, pattern: "alternate" });
    assert.equal(wiring.faultOf("abs")?.mode, "connector-loose");
    assert.equal(wiring.isPowered("abs"), true, "a fresh window starts where a fresh fault starts");
    advance(100);
    assert.equal(wiring.isPowered("abs"), false, "and the phase counts from the re-application");
  });
});
