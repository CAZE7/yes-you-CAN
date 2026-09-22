/**
 * @vdp/runtime — public API (target architecture ADR 0014).
 *
 * The runtime is the headless diagnostic platform: one `createDiagnosticRuntime`
 * call composes engine, services, command bus and domain events. It has no
 * dependency on HTTP, DOM or any UI toolkit.
 */

export { capabilitiesFromServices, UDS_SERVICE_CAPABILITIES } from "./capability-map.js";
export { PackageDefinitionProvider } from "./definition-service.js";
export { DtcService } from "./dtc-service.js";
export type { AuditEntry } from "./event-recorder.js";
export { EventAuditRecorder } from "./event-recorder.js";
export type { EvidenceSnapshot } from "./evidence-service.js";
export { EvidenceService } from "./evidence-service.js";
export type { RuntimeServices } from "./handlers.js";
export { registerRuntimeHandlers } from "./handlers.js";
export {
  decodedToReading,
  deniedClearOutcome,
  toClearDtcOutcome,
  toDtcInfo,
  toDtcKnowledge,
  toEcuSummary,
  toMeasurementReading,
  toSessionSummary,
  toVehicleSummary,
} from "./mappers.js";
export type { DiagnosticRuntime, RuntimeOptions } from "./runtime.js";
export { createDiagnosticRuntime } from "./runtime.js";
export type {
  WriteBinding,
  WriteOperationResult,
  WritePort,
  WritePrecheckResult,
} from "./services.js";
export {
  EcuService,
  MeasurementService,
  parseEcuAddress,
  SafetyService,
  SessionService,
  unknownEcu,
  VehicleService,
} from "./services.js";
export type {
  AdvancedSignalStatistics,
  DetectedSignalAnomaly,
  FrequencySpectrum,
  SignalCorrelationResult,
} from "./signal-analysis-service.js";
export { SignalAnalysisService } from "./signal-analysis-service.js";
export type { DoipEcuLinkFactoryOptions } from "./transport.js";
export { createDoipEcuLinkFactory, DoipEcuLinkFactory } from "./transport.js";
/** The version an analysis cites as `runtimeVersion` (P0 #42). */
export { PLATFORM_VERSION } from "./version.js";
