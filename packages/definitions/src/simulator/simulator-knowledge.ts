/**
 * Fault knowledge for the virtual vehicle (AGENTS 20, 23).
 *
 * This is the data that turns a fault list into a diagnosis for the one vehicle
 * the platform can always reach: the simulator. Every entry says what a code
 * means *here* — with this engine, with this gearbox — which causes are worth
 * measuring first, and which measuring window makes the measurement comparable.
 *
 * **Where it comes from, and where it deliberately stops.** The reasoning is
 * written for this repository from public SAE J1979 / ISO 15031-5 signal
 * semantics (PID meanings, fuel-trim behaviour, monitor enable conditions). It
 * uses no OEM repair documentation and no third-party database (AGENTS 24), so
 * `provenance.sourceType` is `own` on every entry.
 *
 * Numeric windows are therefore *measuring conditions*, not manufacturer
 * thresholds: "coolant above 80 °C" says when the catalyst monitor can have run,
 * not what this engine's ECU is calibrated to. A window this file cannot justify
 * from public semantics is not declared — the check then says what to look at and
 * leaves the judgement to the technician, visibly (see `MeasurementCheckDefinition`).
 *
 * What is missing on purpose:
 *
 *  - **lambda sensor signals.** `genericPackage` does not define PID 0x14–0x1B,
 *    so a catalyst check cannot be evaluated from oxygen storage activity here.
 *    Inventing a signal id would produce a check that can never run; the honest
 *    shape is a pattern whose checks use the signals that do exist (fuel trims)
 *    and say what they can and cannot prove.
 *  - **an entry for U0121.** "Lost communication with the ABS control module"
 *    means the same thing for every engine, every gearbox and every equipment
 *    line — its causes sit in supply, ground and bus wiring, none of which this
 *    variant narrows down. Variant wording for it would be padding that dresses
 *    up as knowledge, so the package-wide description stays the answer and the
 *    UI says so (`scope: "package"`, AGENTS 20.1).
 *
 * Two kinds of window appear below and neither is a calibration value:
 * `45…55 km/h` for a wheel speed names the *test condition* (a straight run at
 * roughly 50 km/h, stated in `expect`), and `3…4` for the gear selector reads
 * this package's own `enumMapping` (drive, sport) — the only place where a
 * numeric window is legitimate for a signal that is really a set of states.
 * Where no bound can be justified but the observation is real, the check keeps
 * `windowMs` and drops the bounds — the wheel-speed dropout watch below is such a
 * case, and the view then says "only a human can judge this" instead of showing a
 * range nobody documented (`measurable`). Where the package defines no signal that
 * could show the fault at all, the pattern says so in its explanation and checks
 * only the condition the fault needs — pretending otherwise with a proxy signal
 * would be a check that always passes.
 */

import type { DtcKnowledgeDefinition, Provenance } from "../schema.js";

/** Shared by every entry below: the knowledge is authored here, not licensed. */
const KNOWLEDGE_PROVENANCE: Provenance = {
  sourceType: "own",
  source: "written for this repository from public SAE J1979 / ISO 15031-5 signal semantics",
  notes:
    "Diagnostic reasoning and measuring windows authored here; no OEM repair documentation and " +
    "no third-party database used (AGENTS 24). Windows describe when a measurement is comparable, " +
    "not manufacturer calibration thresholds.",
};

export const simulatorDtcKnowledge: DtcKnowledgeDefinition[] = [
  {
    code: "P0420",
    ecu: "engine",
    engine: "sim-petrol",
    description:
      "Catalyst efficiency below threshold on the simulated 2.4 L petrol engine: the monitor " +
      "judges the catalyst by how far it smooths the upstream lambda signal, in closed loop only.",
    conditions:
      "Needs closed loop, coolant above 80 °C and steady load; it is stored after three " +
      "qualifying drive cycles, so the code is older than the measuring point it names.",
    hint:
      "Rule out mixture and exhaust leaks before the catalyst: on this engine the same code also " +
      "appears when extra oxygen reaches the downstream sensor from somewhere else.",
    relatedSignals: ["engine.fuel_system_status", "vehicle.speed"],
    patterns: [
      {
        id: "catalyst-aged",
        name: "Aged catalyst — oxygen storage capacity lost",
        likelihood: "common",
        explanation:
          "The catalyst no longer buffers oxygen, so its efficiency drops while the mixture itself " +
          "stays correct. Neutral fuel trims are what separates this from a lean or rich condition.",
        checks: [
          {
            signal: "engine.long_term_fuel_trim",
            expect: "long term trim stays inside ±5 % — the mixture is not the cause",
            min: -5,
            max: 5,
          },
          {
            signal: "engine.short_term_fuel_trim",
            expect: "short term trim stays inside ±10 % while the loop is closed",
            min: -10,
            max: 10,
          },
          {
            signal: "engine.coolant_temperature",
            expect: "coolant above 80 °C, otherwise the monitor has not run at all",
            min: 80,
          },
        ],
        repair:
          "Replace the catalytic converter only after these checks hold in closed loop and no " +
          "exhaust leak upstream of it was found.",
      },
      {
        id: "exhaust-leak-before-catalyst",
        name: "Exhaust leak upstream of the catalyst",
        likelihood: "possible",
        explanation:
          "False air behind the manifold or a cracked flex pipe lets oxygen reach the downstream " +
          "sensor, which reads like a catalyst that stopped working.",
        checks: [
          {
            signal: "engine.long_term_fuel_trim",
            expect:
              "long term trim corrected above +8 %, because the ECU enriches against the extra oxygen",
            min: 8,
          },
          {
            signal: "engine.coolant_temperature",
            expect:
              "coolant above 80 °C so the correction is a closed-loop value, not a warm-up one",
            min: 80,
          },
        ],
        repair:
          "Find the leak first — soot marks, a ticking noise on cold start — and reseal before " +
          "re-testing; replacing the catalyst does not survive the next leak.",
      },
    ],
    provenance: KNOWLEDGE_PROVENANCE,
  },
  {
    code: "P0300",
    ecu: "engine",
    severity: "critical",
    description:
      "Random misfire across cylinders on the virtual vehicle. The code names no cylinder, so the " +
      "operating point in the freeze frame is the only thing that narrows the cause down.",
    conditions:
      "Detected inside one drive cycle; a misfire under load is stored immediately, one at idle " +
      "only after several occurrences.",
    hint:
      "Read the freeze frame before measuring live: misfire under load points at ignition or fuel " +
      "supply, misfire at idle points at unmetered air.",
    relatedSignals: ["engine.fuel_rail_pressure", "engine.intake_manifold_pressure"],
    patterns: [
      {
        id: "ignition-under-load",
        name: "Ignition fault that only shows under load",
        likelihood: "common",
        explanation:
          "A weak coil or a worn plug breaks down when cylinder pressure is highest, which is why " +
          "the fault disappears at idle and reappears when the engine is asked for torque.",
        checks: [
          {
            signal: "engine.load",
            expect: "load above 30 % — reproduce the misfire under load, not at idle",
            min: 30,
          },
          {
            signal: "engine.rpm",
            expect: "engine speed held between 1500 and 3500 rpm while measuring",
            min: 1500,
            max: 3500,
          },
        ],
        repair:
          "Inspect plugs and coils; swapping a coil between cylinders proves the cause when the " +
          "misfire moves with it.",
      },
      {
        id: "fuel-pressure-under-load",
        name: "Fuel supply cannot follow the demand",
        likelihood: "possible",
        explanation:
          "A weak pump or a clogged filter leans the mixture exactly when flow is needed most, and " +
          "the correction limit is reached before the ECU can compensate.",
        checks: [
          {
            signal: "engine.fuel_rail_pressure",
            expect:
              "rail pressure below 250 kPa while load is high — the supply drops under demand",
            max: 250,
          },
          {
            signal: "engine.long_term_fuel_trim",
            expect: "long term trim above +8 % as the ECU enriches against the lean condition",
            min: 8,
          },
        ],
        repair:
          "Measure delivery volume and pressure under load before replacing injectors; a pressure " +
          "reading at idle alone does not show this fault.",
      },
      {
        id: "unmetered-air-at-idle",
        name: "Unmetered air at idle",
        likelihood: "rare",
        explanation:
          "A vacuum leak leans the mixture where the correction has the least reserve, so the " +
          "misfire is an idle phenomenon and disappears as soon as load rises.",
        checks: [
          {
            signal: "engine.rpm",
            expect: "idle speed below 900 rpm and visibly unstable during the window",
            max: 900,
            windowMs: 5000,
          },
          {
            signal: "engine.intake_manifold_pressure",
            expect: "manifold pressure above 40 kPa at idle — higher than a sealed intake shows",
            min: 40,
          },
        ],
        repair:
          "Smoke-test the intake; the brake booster hose is the usual suspect at this operating point.",
      },
    ],
    provenance: KNOWLEDGE_PROVENANCE,
  },
  {
    code: "P0171",
    ecu: "engine",
    engine: "sim-petrol",
    description:
      "System too lean, bank 1: the simulated petrol engine corrects in one direction and reaches " +
      "its limit. The trim value in the freeze frame says how far it had to go.",
    hint:
      "Compare the trim at idle with the trim under load — a leak shows at idle, a fuel supply " +
      "problem shows under load.",
    relatedSignals: ["engine.maf_airflow", "engine.intake_manifold_pressure"],
    patterns: [
      {
        id: "false-air-after-maf",
        name: "Air entering after the mass air flow sensor",
        likelihood: "common",
        explanation:
          "Air that bypasses the sensor is not measured, so the ECU injects for less air than the " +
          "engine actually draws. The correction grows with vacuum, which is why idle is worst.",
        checks: [
          {
            signal: "engine.long_term_fuel_trim",
            expect: "long term trim above +10 %, and higher at idle than under load",
            min: 10,
          },
          {
            signal: "engine.maf_airflow",
            expect: "measured airflow below 5 g/s at idle while the engine clearly draws more",
            max: 5,
            windowMs: 3000,
          },
        ],
        repair:
          "Smoke-test the intake tract behind the sensor, including the brake booster line and the " +
          "crankcase ventilation hose.",
      },
      {
        id: "fuel-supply-starved",
        name: "Fuel supply starved at demand",
        likelihood: "possible",
        explanation:
          "Low rail pressure produces the same lean correction, but the fault follows the load " +
          "instead of the vacuum — which is what tells the two causes apart.",
        checks: [
          {
            signal: "engine.fuel_rail_pressure",
            expect: "rail pressure below 250 kPa while the engine is under load",
            max: 250,
          },
          {
            signal: "engine.load",
            expect:
              "load above 40 % when measuring, otherwise the supply is simply not asked for anything",
            min: 40,
          },
        ],
        repair:
          "Test pressure and volume under load; replace the filter before the pump unless the " +
          "volume test says otherwise.",
      },
    ],
    provenance: KNOWLEDGE_PROVENANCE,
  },
  {
    code: "P0700",
    ecu: "transmission",
    gearbox: "sim-automatic",
    description:
      "Transmission control system malfunction on the simulated five-speed automatic. The code " +
      "carries no fault of its own: it is the request to look at what else the module stored, and " +
      "its whole diagnostic value is the code that sits beside it.",
    conditions:
      "Stored when the transmission control module decides a fault is worth the warning lamp — set " +
      "with that decision, not with the underlying symptom, and it survives the repair until it is " +
      "cleared.",
    hint:
      "Read the module's own code list before measuring anything: diagnosing P0700 on its own is " +
      "always a guess about a fault nobody has named yet.",
    relatedSignals: ["transmission.gear_position", "transmission.oil_temperature"],
    patterns: [
      {
        id: "underlying-code-in-module",
        name: "Another code in the same module is the actual fault",
        likelihood: "common",
        explanation:
          "P0700 has no enable condition and no freeze frame of its own; the companion code — on " +
          "this gearbox typically P0715 — carries the operating point that makes the fault " +
          "measurable. The step is reading the module again, not measuring the bus.",
        checks: [
          {
            signal: "transmission.gear_position",
            expect:
              "selector in drive or sport (3…4 in this package's own enum mapping) — in park or " +
              "neutral the gearbox performs no shifts, so no shift monitor can confirm anything",
            min: 3,
            max: 4,
          },
        ],
        repair:
          "Diagnose the companion code, not this one; clearing P0700 without it comes back on the " +
          "next drive cycle.",
      },
      {
        id: "request-outlived-the-fault",
        name: "The request outlived the fault it was set for",
        likelihood: "possible",
        explanation:
          "Because the code is stored with the lamp request, repairing and clearing the companion " +
          "fault leaves P0700 behind when only the companion was erased. The status bits then read " +
          "confirmed without test-failed (ISO 14229-1): a memory entry, not a live fault.",
        checks: [
          {
            signal: "transmission.oil_temperature",
            expect:
              "oil temperature above 60 °C before believing a clean run — below that the shift and " +
              "converter monitors are inactive and cannot have re-tested anything",
            min: 60,
          },
        ],
        repair:
          "Clear the module's codes after the companion fault is repaired and run the drive cycle " +
          "again; if P0700 returns on its own, the companion code was never the whole story.",
      },
      {
        id: "module-self-test",
        name: "The control module's own self-test failed",
        likelihood: "rare",
        explanation:
          "An internal electronic fault requests the lamp without any sensor circuit being " +
          "involved. No signal in this package decides that, so the pattern deliberately carries " +
          "no check — the judgement needs the module's own diagnosis instead of a measurement.",
        repair:
          "Rule out supply, ground and the harness to the module first; replacing the module " +
          "before the companion codes were read is a guess with a part number on it.",
      },
    ],
    provenance: KNOWLEDGE_PROVENANCE,
  },
  {
    code: "P0715",
    ecu: "transmission",
    gearbox: "sim-automatic",
    description:
      "Input/turbine speed sensor circuit on the simulated five-speed automatic. Without the input " +
      "speed the gearbox cannot calculate converter slip, which is what every shift quality " +
      " judgement is built on.",
    conditions:
      "Stored as soon as the signal is implausible; an intermittent harness fault sets it only " +
      "once the gearbox is at operating temperature.",
    hint:
      "Compare input speed with engine speed: a plausible slip ratio means the signal is there and " +
      "noisy, not missing.",
    relatedSignals: ["transmission.oil_temperature"],
    patterns: [
      {
        id: "input-sensor-open-circuit",
        name: "Input speed sensor circuit open",
        likelihood: "common",
        explanation:
          "No signal at all: the control unit falls back to engine speed and stores the code " +
          "immediately, so the fault is present from the first moment the gearbox is warm.",
        checks: [
          {
            signal: "transmission.oil_temperature",
            expect:
              "oil temperature above 60 °C — below that the converter lock-up is inactive and a " +
              "missing slip value proves nothing",
            min: 60,
          },
        ],
        repair:
          "Check the harness and the connector at the gearbox housing first; the circuit fails far " +
          "more often than the sensor itself.",
      },
      {
        id: "input-sensor-intermittent",
        name: "Intermittent signal from a chafed harness",
        likelihood: "possible",
        explanation:
          "The signal drops out only when the loom moves or heats up, so a snapshot taken at the " +
          "right moment looks perfectly healthy. This package defines no input/turbine speed " +
          "signal — the gearbox answers oil temperature and gear position only — so nothing here " +
          "can observe the dropout. The step is a person's: watch the code's status bits for at " +
          "least 30 s while the loom is moved. What a tool can check is the condition under which " +
          "the fault appears at all.",
        checks: [
          {
            signal: "transmission.oil_temperature",
            expect:
              "oil temperature above 60 °C before judging it — a chafed loom drops out when it is " +
              "warm and expanded, so a cold gearbox proves nothing in either direction",
            min: 60,
          },
        ],
        repair:
          "Move the loom while watching the signal; repair the chafed section instead of replacing " +
          "a sensor that measures correctly.",
      },
    ],
    provenance: KNOWLEDGE_PROVENANCE,
  },
  {
    code: "C0035",
    ecu: "abs",
    description:
      "Left front wheel speed sensor circuit on the virtual vehicle. The code names the circuit, " +
      "not the sensor element: the module stopped seeing a plausible speed from that corner, and " +
      "the sensor itself is the smaller share of the causes behind it.",
    conditions:
      "Set when the module's plausibility check against the other wheels fails; at standstill that " +
      "check is inactive, so the code only appears once the vehicle moves.",
    hint:
      "The opposite corner and the OBD road speed are answered by different sources — compare all " +
      "three before anything at the left front corner is replaced.",
    relatedSignals: ["abs.wheel_speed_front_right", "vehicle.speed"],
    patterns: [
      {
        id: "implausible-speed-on-straight-run",
        name: "The corner reports a speed the other wheels do not confirm",
        likelihood: "common",
        explanation:
          "On a straight run every wheel turns at the same rate, so a fixed offset or a value that " +
          "stays at zero while the vehicle moves belongs to the sensor circuit — not to a bearing " +
          "and not to a brake. The OBD road speed is the independent reference precisely because " +
          "another module answers it.",
        checks: [
          {
            signal: "abs.wheel_speed_front_left",
            expect:
              "45…55 km/h on a straight run at roughly 50 km/h — the stated test condition, not a " +
              "tolerance taken from a calibration",
            min: 45,
            max: 55,
            windowMs: 5000,
          },
          {
            signal: "abs.wheel_speed_front_right",
            expect:
              "the same 45…55 km/h on the opposite corner — it is the reference the comparison is " +
              "made against",
            min: 45,
            max: 55,
            windowMs: 5000,
          },
          {
            signal: "vehicle.speed",
            expect:
              "45…55 km/h from the engine module while the ABS corner disagrees — two modules, one " +
              "road speed",
            min: 45,
            max: 55,
            windowMs: 5000,
          },
        ],
        repair:
          "Check the air gap and the reluctor ring before the sensor: a ring that lost teeth sets " +
          "the same code and is invisible from the connector.",
      },
      {
        id: "intermittent-wheel-harness",
        name: "Chafed harness or corroded connector at the wheel",
        likelihood: "possible",
        explanation:
          "The signal drops out only when the loom moves or the connector is wet, so a snapshot " +
          "taken in the workshop looks healthy. Judging it needs a window and movement, and no " +
          "signal in this package can decide it numerically — hence a window without bounds.",
        checks: [
          {
            signal: "abs.wheel_speed_front_left",
            expect:
              "readable and plausible for the whole 30 s while the loom is moved and the wheel is " +
              "turned by hand — any dropout inside the window is the harness, not the sensor",
            windowMs: 30000,
          },
        ],
        repair:
          "Repair the chafed section or the connector; replacing a sensor that measures correctly " +
          "leaves the fault where it is, in the loom.",
      },
    ],
    provenance: KNOWLEDGE_PROVENANCE,
  },
];
