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

**This directory is the catalog.** Since ADR 0048 there is no second, typed
list in code: every file here is loaded through `loadScenarioLibrary`
(`tools/simulators/src/scenario-library.ts`) — the workbench server at startup
(`apps/web/src/scenario-source.ts`), the suites through
`tests/helpers/scenario-files.ts`. A file that does not parse, or an id that
appears twice, stops the consumer with the file named; a scenario is never
silently missing.

`alternator_failure.json` is the reference causal scenario: it does not set a
voltage field. It fails the alternator, lets model time advance, and expects
the resulting low-voltage observation and the BCM's supply code. A runner must
use the file's `determinism` (`clock: "model-time"`, integer `seed`) so replay
and regression runs receive the same input and output — the field is therefore
required, not a hint.

On the workbench this is enforced by the vehicle, not by discipline:
`HighFidelityVehicle.runScenario` puts the car back to its born state before
every run (clock at 0, fresh supply, module memories as they were attached, no
bus impairment left on the wire) and then applies the file's seed — so the run a
visitor triggers over HTTP is the same run the regression suites execute. The
aftermath of a run stays visible on the vehicle until the next run or a
reconnect; the run after it starts clean again.

Where to look:

- run on the bare model (fast, no wire): `runScenario(modelTarget(model), file.scenario)`
- run on the vehicle with UDS attached — with the file's seed, exactly as the
  workbench runs it: `HighFidelityVehicle.runScenario(file.scenario, { seed: file.determinism.seed })`.
  A DTC expectation needs the attached modules; the bare model only carries conditions
- the end-to-end proof (file → model → UDS 0x19 → IR → evidence):
  `tests/integration/scenario-file.test.ts`; every file through the wire:
  `tests/integration/scenario-chain.test.ts`
