/**
 * `@vdp/diagnostic-ir` — the diagnostic intermediate representation (master
 * backlog P0 #6).
 *
 * The platform had one step between the vehicle and every consumer: protocol
 * byte in, domain projection out. Two things got lost on that single hop:
 *
 * 1. **Provenance** — which DID, which definition version, when, from which ECU.
 * 2. **The difference between "no value" and "not observed".**
 *
 * This package is that missing step: raw/protocol form → observation with
 * evidence → projection. It knows no transport and no protocol (the architecture
 * test enforces that) and it performs no I/O. Consumers project what they need:
 * the runtime into domain views, reports into their sections, the evidence engine
 * (#41) into findings.
 */

export type {
  Evidence,
  ObservationOrigin,
  Proven,
  Provenance,
  Unproven,
} from "./provenance.js";
export { describeEvidence, isProven, proven, unproven } from "./provenance.js";

export type {
  ObservationValue,
  SignalGap,
  SignalGapInput,
  SignalObservation,
  SignalReading,
  SignalReadingInput,
} from "./signal.js";
export { gaps, readings, signalGap, signalReading } from "./signal.js";

export type {
  DtcComparison,
  DtcEnrichment,
  DtcEnrichmentInput,
  DtcObservation,
  DtcObservationInput,
  DtcState,
  DtcStatusBits,
  RelatedSignal,
} from "./dtc.js";
export {
  compareDtcObservations,
  dtcEnrichment,
  dtcObservation,
} from "./dtc.js";

export type {
  EcuObservation,
  EcuObservationInput,
  EcuProtocol,
  EcuTelemetry,
  SessionObservation,
  SessionObservationInput,
} from "./session.js";
export { ecuObservation, reachableEcus, sessionObservation, unreachableEcus } from "./session.js";

export type { MeasurementWindow, WindowOptions } from "./window.js";
export { measurementWindow } from "./window.js";
