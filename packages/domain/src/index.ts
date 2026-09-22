/**
 * @vdp/domain — public API (target architecture ADR 0014).
 *
 * The domain layer holds contracts only: entities/projections, ports,
 * capabilities, risk policy and the domain event catalogue. It performs no
 * I/O and imports nothing but `@vdp/shared`. The architecture tests
 * (`tests/architecture`) enforce that this stays true.
 *
 * The exports below are the package's deliberate public surface (§30/§31);
 * internal helpers are not re-exported.
 */

// Capabilities (§6, §8)
export type { DiagnosticCapabilities, DiagnosticCapability } from "./capabilities.js";
export {
  ALL_CAPABILITIES,
  capabilitiesOf,
  describeCapability,
  hasAllCapabilities,
  hasCapability,
  isDiagnosticCapability,
  missingCapabilities,
} from "./capabilities.js";
// Domain events (§10)
export type {
  ActionExecutedPayload,
  DiagnosticErrorPayload,
  DiagnosticEventMap,
  DiagnosticEventName,
  DidReadPayload,
  DtcsClearedPayload,
  DtcsReadPayload,
  EcuCapabilitiesUpdatedPayload,
  EcuDiscoveredPayload,
  MeasurementsRecordedPayload,
  SafetyApprovalDeniedPayload,
  SafetyApprovalGrantedPayload,
  SafetyApprovalRequestedPayload,
  VehicleConnectedPayload,
  VehicleDisconnectedPayload,
} from "./events.js";
export { DIAGNOSTIC_EVENT_NAMES } from "./events.js";
// Ids (§24)
export type {
  ActionId,
  DefinitionId,
  EcuId,
  EventId,
  Id,
  IdKind,
  MeasurementId,
  SessionId,
  TraceId,
  VehicleId,
} from "./ids.js";
export { asId, asIdOfKind, hasIdPrefix, ID_PREFIXES } from "./ids.js";

// Domain data contracts (§32 Phase 1)
export type {
  AnomalyInfo,
  ClearDtcOutcome,
  DiagnosticOperationResult,
  DtcCheckInfo,
  DtcClearPrecheckInfo,
  DtcInfo,
  DtcKnowledgeInfo,
  DtcPatternInfo,
  EcuSummary,
  FreezeFrameFieldInfo,
  FreezeFrameInfo,
  FreezeFrameValueInfo,
  IdentificationEntry,
  MarkerInfo,
  MeasurementReading,
  MeasurementStatus,
  RawDidReading,
  RecordingHistory,
  SessionSummary,
  SignalInfo,
  SignalStatisticsInfo,
  UnreadEcuInfo,
  VehicleStateReading,
  VehicleSummary,
  WriteStageInfo,
} from "./model.js";
// Ports (§2, §4, §32 Phase 3)
export type { Clock } from "./ports/clock.js";
export { clockFrom, FixedClock, systemClock } from "./ports/clock.js";
export type {
  ConnectionCapabilities,
  DiagnosticRequestOptions,
  DiagnosticTransport,
  VehicleConnection,
} from "./ports/connection.js";
export type {
  DefinitionProvider,
  DidDefinitionRef,
  EcuAddressFactRef,
  EcuAddressRef,
  EcuDefinitionRef,
  FindDidQuery,
  FindEcuQuery,
  IdentificationFactRef,
  ResolveVehicleQuery,
  SignalDefinitionRef,
  VehicleCandidateRef,
  VehicleDefinitionRef,
  VehicleEvidenceRef,
  VehicleResolutionRef,
  VinLookupRef,
} from "./ports/definition-provider.js";
export {
  NullDefinitionProvider,
  StaticDefinitionProvider,
  unresolvedVehicleResolution,
} from "./ports/definition-provider.js";
export type { EventBus, RecordedEvent, Unsubscribe } from "./ports/event-bus.js";
export { InMemoryEventBus, RecordingEventBus } from "./ports/event-bus.js";
export type { IdGenerator } from "./ports/id-generator.js";
export { DefaultIdGenerator, FixedIdGenerator } from "./ports/id-generator.js";
export type { SessionStore, StoredSessionInfo } from "./ports/session-store.js";
export { InMemorySessionStore } from "./ports/session-store.js";
// Risk policy (§15)
export type { RiskLevel, WriteOperationKind, WriteOperationPolicy } from "./risk.js";
export {
  isWriteOperationKind,
  policyForWriteOperation,
  WRITE_OPERATION_KINDS,
  WRITE_OPERATION_POLICIES,
} from "./risk.js";
