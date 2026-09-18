/**
 * `@vdp/formal-conformance` — shared test vectors between the TypeScript
 * production implementations and the Haskell formal reference (ADR 0045).
 *
 * The package is a *tool*: nothing imports it at runtime. It owns the vector
 * format, the runners that drive the production code with the vectors' input,
 * the comparison of the two sides' results, and the CLI (`npm run
 * formal:conform`). The Haskell side lives in `formal/` and reads the same
 * vector files.
 */

export * from "./canonical.js";
export * from "./conformance.js";
export * from "./isotp-runner.js";
export * from "./report.js";
export * from "./safety-runner.js";
export * from "./vectors.js";
