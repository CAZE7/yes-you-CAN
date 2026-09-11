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

// Ids (§24)
export type { Id, VehicleId, SessionId, EcuId, TraceId, ActionId, DefinitionId, MeasurementId, EventId, IdKind } from './ids.js';
export { ID_PREFIXES, asId, asIdOfKind, hasIdPrefix } from './ids.js';

// Capabilities (§6, §8)
export type { DiagnosticCapability, DiagnosticCapabilities } from './capabilities.js';
export {
  ALL_CAPABILITIES,
  capabilitiesOf,
  describeCapability,
  hasAllCapabilities,
  hasCapability,
  isDiagnosticCapability,
  missingCapabilities,
} from './capabilities.js';

// Risk policy (§15)
export type { RiskLevel, WriteOperationKind, WriteOperationPolicy } from './risk.js';
export { WRITE_OPERATION_KINDS, WRITE_OPERATION_POLICIES, isWriteOperationKind, policyForWriteOperation } from './risk.js';

// Domain data contracts (§32 Phase 1)
export type {
  ClearDtcOutcome,
  DiagnosticOperationResult,
  DtcInfo,
  EcuSummary,
  IdentificationEntry,
  MeasurementReading,
  RawDidReading,
  SessionSummary,
  VehicleStateReading,
  VehicleSummary,
} from './model.js';

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
} from './events.js';
export { DIAGNOSTIC_EVENT_NAMES } from './events.js';

// Ports (§2, §4, §32 Phase 3)
export type { Clock } from './ports/clock.js';
export { FixedClock, clockFrom, systemClock } from './ports/clock.js';
export type { IdGenerator } from './ports/id-generator.js';
export { DefaultIdGenerator, FixedIdGenerator } from './ports/id-generator.js';
export type { EventBus, RecordedEvent, Unsubscribe } from './ports/event-bus.js';
export { InMemoryEventBus, RecordingEventBus } from './ports/event-bus.js';
export type { ConnectionCapabilities, DiagnosticRequestOptions, DiagnosticTransport, VehicleConnection } from './ports/connection.js';
export type {
  DidDefinitionRef,
  DefinitionProvider,
  EcuAddressRef,
  EcuDefinitionRef,
  FindDidQuery,
  FindEcuQuery,
  SignalDefinitionRef,
  VehicleDefinitionRef,
} from './ports/definition-provider.js';
export { NullDefinitionProvider, StaticDefinitionProvider } from './ports/definition-provider.js';
export type { SessionStore, StoredSessionInfo } from './ports/session-store.js';
export { InMemorySessionStore } from './ports/session-store.js';
