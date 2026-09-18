# Reproducible scenarios

Scenario files are portable, reviewable inputs for the simulator, integration
tests, replay tooling and demos. The executable grammar lives in
`tools/simulators/src/scenario-file.ts` (`parseScenarioFile`); the canonical
JSON Schema in `tools/simulators/scenario.schema.json` mirrors it, and the
loader owns any disagreement — it parses strictly, so an unknown key or a
malformed comparison is an error with a path, never a silent no-op.

A step is a cause on the timeline (`wait` advances model time; there is no
setter for results). An expectation is a check the runner evaluates — DTC
states through the fault memory, voltages through model state. Nothing in a
file says "set DTC X": a code that the model cannot produce from causes makes
the scenario fail, which is the point.

`alternator_failure.json` is the reference causal scenario: it does not set a
voltage field. It fails the alternator, lets model time advance, and expects
the resulting low-voltage observation and the BCM's supply code. A runner must
use the file's `determinism` (`clock: "model-time"`, integer `seed`) so replay
and regression runs receive the same input and output — the field is therefore
required, not a hint.

Where to look:

- run on the bare model (fast, no wire): `runScenario(modelTarget(model), file.scenario)`
- run on the vehicle with UDS attached: `HighFidelityVehicle.runScenario(file.scenario)` —
  a DTC expectation needs the attached modules, the bare model only carries conditions
- the end-to-end proof (file → model → UDS 0x19 → IR → evidence):
  `tests/integration/scenario-file.test.ts`
- the built-in typed catalog remains `SCENARIO_CATALOG` in the same package;
  files and catalog share the runner, not a second engine
