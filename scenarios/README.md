# Reproducible scenarios

Scenario files are portable, reviewable inputs for the simulator, integration tests,
replay tooling and demos. The canonical JSON schema is
`tools/simulators/scenario.schema.json`. The TypeScript `SCENARIO_CATALOG` remains the
strongly typed built-in catalog; file adapters can validate this format before mapping
steps to `VehicleScenario` causes.

`alternator_failure.json` is the reference causal scenario: it does not set a voltage
field. It fails the alternator, lets model time advance, and expects the resulting
low-voltage observation and DTC. A runner must use a deterministic model clock and seed
so replay and regression runs receive the same input and output.
