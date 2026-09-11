/**
 * `@vdp/adapter-host` — everything that turns "an adapter exists in the code
 * base" into "this machine can open it" (AGENTS 4, 29).
 *
 * Layer position: above the concrete adapters, below the application. It never
 * imports `core`, `protocols` or `simulators`, so the dependency direction of
 * ADR 0001 holds and the simulator can stay a registration done by the app.
 */

export * from "./serial.js";
export * from "./catalog.js";
export * from "./selection.js";
