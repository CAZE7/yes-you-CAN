/**
 * The built-in scenarios of the virtual vehicle (AGENTS 32, master backlog P0 #16).
 *
 * Six scripted causes, each with the verdict its own model has to reach. They are
 * deliberately written as data: the same object drives a unit test on the bare model,
 * an end-to-end run over UDS, and (from the workbench) a live simulator. A scenario
 * that only exists as a test body cannot be replayed in a demo, and a demo scenario
 * nobody asserts on drifts — so the catalog is the single copy.
 *
 * What each entry states, in order: the **cause** (`steps`), the **physical result**
 * (`conditions`, checked against the model state, so a code cannot be explained by a
 * monitor bug alone) and the **fault-memory verdict** (`expectations`). `because`
 * carries the reasoning into the assertion message, so a failing check reads as an
 * explanation instead of a diff.
 *
 * Model times are compressed on purpose (`dischargeVPerSecond` in `VEHICLE_PHYSICS`
 * says so): a charging-system failure takes minutes on a car and 40 s here. The
 * sequence of states a technician would see is unchanged — only the wall clock is
 * shorter, and nothing in the platform depends on the wall clock (AGENTS 31).
 */

import type { VehicleScenario } from "./scenarios.js";

/**
 * Unterspannung beim Start: the battery is not dead, it is tired.
 *
 * Resting 12.3 V is above the BCM's window, so nothing is stored while the car
 * waits. The starter's current is what drops the terminals into the window — the
 * fault therefore appears *during* cranking and disappears when the alternator takes
 * over, which is exactly the shape of a "no clear reason, comes and goes" complaint.
 */
const underVoltageAtStart: VehicleScenario = {
  id: "under-voltage-at-start",
  title: "Unterspannung beim Start — cranking drags the supply into the window",
  summary:
    "A tired battery at 12.3 V rests above the undervoltage threshold; 90 A of starter " +
    "current drops it below, the BCM latches B1001, and the code heals once the " +
    "alternator carries the load.",
  durationMs: 7_000,
  steps: [
    // Key off first: an engine that is still turning from the last cycle catches in a
    // few hundred ms and the sag window would be over before any monitor could see it.
    { atMs: 0, cause: { kind: "ignition", state: "off" } },
    { atMs: 0, cause: { kind: "battery", volts: 12.3 } },
    { atMs: 200, cause: { kind: "electrical-load", amps: 20 } },
    { atMs: 1_000, cause: { kind: "ignition", state: "start" }, holdMs: 2_000 },
    { atMs: 3_000, cause: { kind: "ignition", state: "on" } },
  ],
  conditions: [
    {
      field: "supplyVoltage",
      below: 11.5,
      atMs: 1_500,
      because: "the terminal voltage under starter load is what the monitor measures",
    },
    {
      field: "engineRunning",
      equals: false,
      atMs: 1_500,
      because: "at 1.5 s of cranking the engine has not caught yet — the code is not a no-start",
    },
    {
      field: "engineRunning",
      equals: true,
      atMs: 7_000,
      because: "it does fire on the second second of cranking; the fault is a supply statement",
    },
    {
      field: "supplyVoltage",
      above: 13,
      atMs: 7_000,
      because: "with the alternator carrying the load the cause is gone",
    },
  ],
  expectations: [
    {
      ecu: "bcm",
      code: "B1001",
      state: "absent",
      atMs: 1_000,
      because: "at rest, with the key off, 12.3 V is inside the window — nothing is stored yet",
    },
    {
      ecu: "bcm",
      code: "B1001",
      state: "active",
      atMs: 1_500,
      because: "cranking holds the supply below 11.5 V for longer than the debounce",
    },
    {
      ecu: "engine",
      code: "P0300",
      state: "absent",
      because:
        "a slow crank with working coils is a starter statement, not a misfire: the " +
        "monitor reads the supply, and 10.9 V is above its floor",
    },
    {
      ecu: "bcm",
      code: "B1001",
      state: "stored",
      because: "the condition is over; the code stays in memory as a healed fault",
    },
  ],
};

/**
 * ABS intermittierend offline: a connector that makes contact now and then.
 *
 * Nothing in the scenario says "abs offline". It says "resistance at pin 3 comes and
 * goes", and the consequences are then measured by two independent observers: the
 * module itself (supply, so it answers or it does not) and the gateway (silence on the
 * wire, so it stores a U-code and heals it when the contact returns).
 */
const absIntermittentlyOffline: VehicleScenario = {
  id: "abs-intermittently-offline",
  title: "ABS intermittierend offline — ein wackelnder Stecker, nicht ein Flag",
  summary:
    "A loose connector at the ABS holds for 35 % of the steps. The module drops in and " +
    "out of supply, the gateway's bus timeout latches U0121 while it is silent and " +
    "heals it afterwards; the code survives as a stored fault.",
  durationMs: 10_000,
  steps: [
    { atMs: 0, cause: { kind: "ignition", state: "on" } },
    // 1 s contact windows on the clock: longer than the gateway's bus timeout (so a
    // break is a real silence) and longer than the monitor's heal window (so a make is
    // a real recovery). Anything faster is white noise and a U-code from it is an
    // artefact of the model, not a finding. `alternate` keeps the verdict independent
    // of the caller's random source.
    {
      atMs: 500,
      cause: {
        kind: "wiring",
        ecu: "abs",
        mode: "connector-loose",
        flapMs: 1_200,
        pattern: "alternate",
      },
      holdMs: 8_000,
    },
  ],
  conditions: [
    {
      field: "ignition",
      equals: "on",
      atMs: 10_000,
      because: "the key stays on — nobody switched anything off in this scenario",
    },
  ],
  expectations: [
    {
      ecu: "gateway",
      code: "U0121",
      state: "intermittent",
      minRaises: 2,
      because:
        "the contact makes and breaks, so the gateway latches U0121, heals it and latches " +
        "it again — the history is the diagnosis here, not the status byte of one instant",
    },
    {
      ecu: "gateway",
      code: "U0140",
      state: "absent",
      because: "the BCM keeps answering — the fault is one node, not the whole bus",
    },
  ],
};

/**
 * CAN-Bus-Aussetzer: a cut and a degradation, on the same node.
 *
 * The pair is the point. A wire that carries nothing at all for 1.2 s must latch the
 * gateway's timeout monitor; a wire that loses 40 % of its frames must *not* — a
 * peer that is heard again within the timeout window is a degraded bus, not a lost
 * module. The debounce of the monitor is what separates the two diagnoses, and a
 * scenario that cannot tell them apart proves nothing about either.
 */
const canBusDropouts: VehicleScenario = {
  id: "can-bus-dropouts",
  title: "CAN-Bus-Aussetzer — ein offener Draht zählt, ein rauer Bus nicht",
  summary:
    "The transmission's traffic is fully swallowed for 1.2 s (the gateway latches " +
    "U0101), then only 40 % is lost (it must not latch again). One code, two bus " +
    "conditions, two verdicts.",
  durationMs: 8_000,
  steps: [
    { atMs: 0, cause: { kind: "ignition", state: "on" } },
    { atMs: 1_000, cause: { kind: "bus", ecu: "transmission", mode: "open" }, holdMs: 1_200 },
    {
      atMs: 4_000,
      cause: { kind: "bus", ecu: "transmission", mode: "stutter", dropRate: 0.4 },
      holdMs: 1_500,
    },
  ],
  conditions: [
    {
      field: "timeMs",
      above: 7_000,
      atMs: 8_000,
      because: "the run is long enough for the heal window to have passed twice",
    },
  ],
  expectations: [
    {
      ecu: "gateway",
      code: "U0101",
      state: "active",
      atMs: 2_100,
      because: "1.2 s of silence on a wire with a 400 ms timeout is a lost node",
    },
    {
      ecu: "gateway",
      code: "U0101",
      state: "stored",
      atMs: 4_000,
      because: "the wire carries again, so the monitor heals the code without clearing it",
    },
    {
      ecu: "gateway",
      code: "U0101",
      state: "stored",
      because:
        "a 40 % frame loss never keeps the gateway silent for a whole timeout window, " +
        "so a rough bus must not be re-reported as a dead module",
    },
  ],
};

/**
 * Sensorwerte außerhalb plausibler Grenzen: two faults, four consequences.
 *
 * One cut wheel-sensor channel and one air-flow meter that reads too little. Neither
 * sets a code directly: the first fails the ABS's rationality test against the other
 * three wheels, the second makes the engine fuel lean, the trim climbs for seconds,
 * and only then do the mixture and catalyst monitors latch — with the gear ECU
 * recording that the engine asked for the lamp. Four codes, one cause each.
 */
const sensorOutOfPlausibleRange: VehicleScenario = {
  id: "sensor-out-of-plausible-range",
  title: "Sensorwerte außerhalb plausibler Grenzen — ein Kanal, eine Leseabweichung",
  summary:
    "Front left wheel speed reads zero at 60 km/h (C0035 from the rationality test), " +
    "the MAF reports 45 % of the air the engine breathes (P0171 from the trim, then " +
    "P0420 from the catalyst monitor, then P0700 on the gear ECU).",
  durationMs: 30_000,
  steps: [
    { atMs: 0, cause: { kind: "ignition", state: "on" } },
    { atMs: 200, cause: { kind: "driver", demandSpeedKph: 60, gear: 4 } },
    {
      atMs: 500,
      cause: { kind: "sensor", signal: "abs.wheel_speed_front_left", mode: "open-circuit" },
    },
    { atMs: 1_000, cause: { kind: "sensor", signal: "engine.maf_airflow", mode: "drift-low" } },
  ],
  conditions: [
    {
      field: "speedKph",
      above: 40,
      atMs: 4_000,
      because: "a wheel-speed rationality test only runs when the car is moving",
    },
    {
      field: "longTermTrimPct",
      above: 12,
      atMs: 30_000,
      because: "the learned correction is the measurement the lean monitor reads",
    },
  ],
  expectations: [
    {
      ecu: "abs",
      code: "C0035",
      state: "active",
      atMs: 2_000,
      because: "front left at 0 km/h while the other three read 60 km/h is implausible",
    },
    {
      ecu: "engine",
      code: "P0171",
      state: "active",
      because:
        "a meter that under-reads by 45 % leaves the engine lean and the trim above the window",
    },
    {
      ecu: "engine",
      code: "P0420",
      state: "active",
      because:
        "the catalyst monitor is enabled after warm-up and the mixture never converges, " +
        "so the efficiency test fails as a consequence of the same meter",
    },
    {
      ecu: "transmission",
      code: "P0700",
      state: "active",
      because: "the engine's latched code is what asks for the lamp — propagated, not copied",
    },
  ],
};

/**
 * Load dump: the regulator sticks, and the *measurement* leaves its declared range.
 *
 * The same code as the undervoltage case, from the opposite end of the window — with
 * one addition that matters downstream: 24 V on a signal whose package declares
 * 0…20 V is an out-of-range sample for every consumer of it, so the recording, the
 * statistics and the evidence set all carry the event, not only the fault memory.
 */
const loadDumpOvervoltage: VehicleScenario = {
  id: "load-dump-overvoltage",
  title: "Load dump — die Lichtmaschine regelt nicht mehr ab",
  summary:
    "A stuck regulator puts 24 V on the supply. The BCM's window monitor fails at the " +
    "upper end, the decoded battery voltage leaves its declared range, and the code " +
    "heals when the system is brought back to 13.9 V.",
  durationMs: 6_000,
  steps: [
    { atMs: 0, cause: { kind: "ignition", state: "on" } },
    { atMs: 500, cause: { kind: "battery", volts: 24 } },
    { atMs: 4_000, cause: { kind: "battery", volts: 13.9 } },
  ],
  conditions: [
    {
      field: "supplyVoltage",
      above: 20,
      atMs: 2_000,
      because: "the pin voltage itself is what a reader has to be able to verify",
    },
  ],
  expectations: [
    {
      ecu: "bcm",
      code: "B1001",
      state: "active",
      atMs: 2_000,
      because: "overvoltage is the same statement about the supply as undervoltage",
    },
    {
      ecu: "bcm",
      code: "B1001",
      state: "stored",
      because: "at 13.9 V the monitor has run and passed, so testFailed leaves the record",
    },
  ],
};

/**
 * Charging system failure: one dead diode, and the car goes out one module at a time.
 *
 * Nothing is switched off and no state is set — the alternator stops contributing, the
 * electrical load spends the battery, and the vehicle falls apart in the order its
 * thresholds say: first a supply code, then misfires, then an engine that stops, then
 * modules that brown out and stop answering entirely.
 */
const chargingSystemFailure: VehicleScenario = {
  id: "charging-system-failure",
  title: "Lichtmaschine ausgefallen — eine Ursache, eine Kaskade",
  summary:
    "Alternator at 0 % with 45 A of consumers. The battery is spent in tens of seconds " +
    "of model time: B1001 first, then P0300 as combustion stops having a working coil, " +
    "then the engine stalls, and the supply finally leaves the modules' own window.",
  durationMs: 20_000,
  steps: [
    { atMs: 0, cause: { kind: "ignition", state: "on" } },
    { atMs: 300, cause: { kind: "electrical-load", amps: 45 } },
    { atMs: 500, cause: { kind: "alternator", efficiency: 0 } },
  ],
  conditions: [
    {
      field: "supplyVoltage",
      below: 9.6,
      atMs: 20_000,
      because: "the cascade is a voltage curve, and the curve is the evidence",
    },
    {
      field: "engineRunning",
      equals: false,
      atMs: 20_000,
      because: "an engine without a working supply stops — the model does not pretend otherwise",
    },
  ],
  expectations: [
    {
      ecu: "bcm",
      code: "B1001",
      state: "active",
      atMs: 8_000,
      because: "the drain crosses 11.5 V well before anything else in the car notices",
    },
    {
      ecu: "engine",
      code: "P0300",
      state: "active",
      atMs: 20_000,
      because:
        "below 9.6 V the coils cannot fire the engine, which is what the misfire monitor measures",
    },
    {
      ecu: "transmission",
      code: "P0700",
      state: "active",
      atMs: 20_000,
      because: "the engine asked for the lamp, so the gear ECU records that it did",
    },
  ],
};

/**
 * Every built-in scenario, in the order a reader should meet them.
 *
 * Tests iterate this list, so a new scenario arrives with its own test cases in the
 * integration suite, the model spec and the catalog checks — without a second file to
 * remember. `scenarioById` is for a caller that names one (workbench, CLI).
 */
export const SCENARIO_CATALOG: readonly VehicleScenario[] = [
  underVoltageAtStart,
  absIntermittentlyOffline,
  canBusDropouts,
  sensorOutOfPlausibleRange,
  loadDumpOvervoltage,
  chargingSystemFailure,
];

export function scenarioById(id: string): VehicleScenario | undefined {
  return SCENARIO_CATALOG.find((scenario) => scenario.id === id);
}

/** A scenario with its steps removed — the negative control every run is measured against. */
export function withoutCauses(scenario: VehicleScenario): VehicleScenario {
  return { ...scenario, steps: [] };
}
