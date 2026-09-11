/**
 * @vdp/runtime — public API (target architecture ADR 0014).
 *
 * The runtime is the headless diagnostic platform: one `createDiagnosticRuntime`
 * call composes engine, services, command bus and domain events. It has no
 * dependency on HTTP, DOM or any UI toolkit.
 */

export { createDiagnosticRuntime } from "./runtime.js";
export type { DiagnosticRuntime, RuntimeOptions } from "./runtime.js";

export { DoipEcuLinkFactory, createDoipEcuLinkFactory } from "./transport.js";
export type { DoipEcuLinkFactoryOptions } from "./transport.js";

export { EventAuditRecorder } from "./event-recorder.js";
export type { AuditEntry } from "./event-recorder.js";

export { capabilitiesFromServices, UDS_SERVICE_CAPABILITIES } from "./capability-map.js";

export { PackageDefinitionProvider } from "./definition-service.js";

export {
  DtcService,
  EcuService,
  MeasurementService,
  SafetyService,
  SessionService,
  VehicleService,
  parseEcuAddress,
  unknownEcu,
} from "./services.js";

export { registerRuntimeHandlers } from "./handlers.js";
export type { RuntimeServices } from "./handlers.js";

export {
  decodedToReading,
  deniedClearOutcome,
  toClearDtcOutcome,
  toDtcInfo,
  toEcuSummary,
  toMeasurementReading,
  toSessionSummary,
  toVehicleSummary,
} from "./mappers.js";
