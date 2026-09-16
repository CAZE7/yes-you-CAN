/**
 * The monitors of the virtual vehicle — one measurement against one documented code.
 *
 * A monitor states a condition the *vehicle* satisfies or not (a voltage, a plausibility
 * gap, a peer that has been silent too long) and names the code its ECU stores when the
 * condition holds. The table doubles as the answer to "what does this simulator actually
 * diagnose?": a scenario that wants a code nobody documents has to write the
 * documentation first (AGENTS 20.1), because rule 3 of the model refuses the rest.
 */

import type { Monitor } from "./vehicle-state.js";

/**
 * Status bits the model writes (ISO 14229-1 §10.4, decoded by `DtcStatus` in
 * `@vdp/protocols-uds`).
 *
 * `0x2f` is what this repository calls an active fault: testFailed, the same bit of
 * this operation cycle, pending, confirmed, failed since last clear. `0x2e` is the
 * same list with testFailed *gone* — the memory state of "it failed, it does not
 * fail right now", which is what a technician finds at the shop and what a plain
 * `0x00` after a clear would erase.
 */
export const STATUS_ACTIVE = 0x2f;
export const STATUS_HEALED = 0x2e;

/**
 * The monitors of the virtual vehicle.
 *
 * The list doubles as the answer to "what does this simulator actually diagnose?":
 * one measurement against one documented code. A scenario that wants a code nobody
 * documents has to write the documentation first (AGENTS 20.1).
 */
export function standardMonitors(): Monitor[] {
  return [
    {
      id: "bcm-supply-voltage",
      ecu: "bcm",
      code: "B1001",
      note: "battery supply voltage outside the documented window",
      enabled: (ctx) => ctx.state.ignition !== "lock",
      failing: (ctx) => {
        const supply = ctx.supplyOf("bcm");
        const t = ctx.thresholds;
        // A supply of 0 V is not "too low", it is "not there": a module with no power
        // does not report anything, and the model says so in one place (its monitors
        // only run while it is powered).
        if (supply <= 0) return false;
        // Both ends of the window, because the code covers both: undervoltage and a
        // load dump are the same statement about the supply.
        return supply < t.undervoltageV || supply > t.overvoltageV;
      },
      clear: (ctx) => {
        const supply = ctx.supplyOf("bcm");
        const t = ctx.thresholds;
        // Hysteresis: heal above 12.0 V, or below 15.5 V after a load dump. A value
        // that sits on a threshold cannot make the code chatter on every step.
        return supply > t.recoveryVoltageV && supply < t.overvoltageRecoveryV;
      },
    },
    {
      id: "engine-misfire",
      ecu: "engine",
      code: "P0300",
      // Long by this model's standards on purpose: cranking passes through a low rpm
      // *every* start, and a monitor that latched there would report a healthy starter
      // as an engine fault. 600 ms of it is a fault.
      debounceMs: 600,
      note: "supply too weak to fire, or rpm far off the idle target",
      enabled: (ctx) => ctx.state.engineRunning || ctx.state.starterCranking,
      failing: (ctx) => {
        const t = ctx.thresholds;
        if (!ctx.state.engineRunning) {
          // While the engine only cranks, a low rpm is *normal*: what makes it a
          // misfire is a supply too weak for the coils, so the monitor reads the
          // cause instead of the symptom every starter produces.
          return ctx.state.starterCranking && ctx.supplyOf("engine") < t.crankingStartV;
        }
        if (ctx.supplyOf("engine") < t.misfireVoltageV) return true;
        const deviation = Math.abs(ctx.state.rpm - t.idleRpm) / Math.max(1, t.idleRpm);
        return ctx.state.throttlePct < 5 && deviation > 0.3;
      },
    },
    {
      id: "engine-mixture-lean",
      ecu: "engine",
      code: "P0171",
      note: "long-term fuel trim above the lean window while closed loop",
      enabled: (ctx) =>
        ctx.state.engineRunning && ctx.state.coolantC >= ctx.thresholds.closedLoopCoolantC,
      failing: (ctx) => ctx.state.longTermTrimPct > ctx.thresholds.leanTrimPct,
    },
    {
      id: "engine-catalyst-efficiency",
      ecu: "engine",
      code: "P0420",
      note: "catalyst monitor: warm, loaded, and still correcting a lean mixture",
      // A catalyst cannot be tested cold, and not while the misfire monitor has a
      // hold on the engine — enable conditions first, verdict afterwards.
      enabled: (ctx) =>
        ctx.state.engineRunning &&
        ctx.state.coolantC >= ctx.thresholds.closedLoopCoolantC &&
        ctx.state.runtimeS > 4 &&
        !ctx.monitorActive("engine-misfire"),
      failing: (ctx) =>
        ctx.state.longTermTrimPct > 6 &&
        ctx.state.speedKph > 20 &&
        ctx.state.loadPct > 25 &&
        ctx.state.loadPct < 70,
    },
    {
      id: "abs-front-left-circuit",
      ecu: "abs",
      code: "C0035",
      note: "front left wheel speed implausible against the other three while moving",
      enabled: (ctx) => ctx.state.speedKph > ctx.thresholds.plausibilityKph,
      failing: (ctx) => {
        const wheels = ctx.state.wheelSpeedKph;
        const others = (wheels.frontRight + wheels.rearLeft + wheels.rearRight) / 3;
        if (others <= ctx.thresholds.plausibilityKph) return false;
        // A rationality test in both directions: a cut channel reads zero and a
        // channel shorted to the rail reads absurd speed, and a real wheel-speed
        // circuit monitor fails on either. Comparing only against zero would model
        // half the failure mode and miss the other half.
        const gap = Math.abs(wheels.frontLeft - others);
        return gap > Math.max(ctx.thresholds.plausibilityKph, others * 0.5);
      },
    },
    {
      id: "transmission-requested-lamp",
      ecu: "transmission",
      code: "P0700",
      note: "the engine ECU asked for the malfunction indicator lamp",
      enabled: () => true,
      // P0700 on a gear ECU means what it says: *a code in the engine's memory lit the
      // MIL*. Derived from a peer's state, never set alongside it by hand.
      failing: (ctx) =>
        ctx.monitorActive("engine-misfire") || ctx.monitorActive("engine-mixture-lean"),
    },
    {
      id: "transmission-input-speed",
      ecu: "transmission",
      code: "P0715",
      note: "input speed implausible: gear engaged, car moving, sensor silent",
      enabled: (ctx) => ctx.state.gear >= 2 && ctx.state.speedKph > 10,
      failing: (ctx) => {
        const fault = ctx.sensorFault("transmission.input_speed");
        return fault !== undefined && (fault.mode === "open-circuit" || fault.mode === "stuck");
      },
    },
    ...communicationMonitors(),
  ];
}

/**
 * One "lost communication with X" monitor per peer the gateway supervises.
 *
 * Generated from the topology instead of hand-written per pair, because "the gateway
 * watches these nodes" is already a fact about the vehicle; a second copy of it in
 * the simulator would be a rule that drifts from the thing it describes.
 */
function communicationMonitors(): Monitor[] {
  const codeForPeer: Record<string, string> = {
    engine: "U0100",
    transmission: "U0101",
    abs: "U0121",
    bcm: "U0140",
  };
  return Object.entries(codeForPeer).map(([peer, code]) => ({
    id: `gateway-lost-${peer}`,
    ecu: "gateway",
    code,
    // The bus timeout already *is* the debounce of this monitor: a peer is silent for
    // longer than a node is allowed to stay quiet, and nothing is added on top.
    debounceMs: 0,
    note: `no frame from ${peer} within the bus timeout`,
    enabled: (ctx) => ctx.state.ignition !== "lock",
    failing: (ctx) => ctx.silentPeersOf("gateway").includes(peer),
  }));
}
