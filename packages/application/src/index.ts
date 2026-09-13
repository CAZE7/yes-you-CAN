/**
 * @vdp/application — public API (target architecture ADR 0014).
 *
 * The application layer defines *what* clients can ask the platform to do:
 * commands, queries, the command bus and capability-driven actions. It
 * depends only on `@vdp/domain` — how anything is executed is a matter for
 * the runtime layer that registers handlers here.
 */

// Command bus (§8, §9)
export { CommandBus, DuplicateHandlerError, NoHandlerError } from "./command-bus.js";
export type { Command, CommandHandler, Query, QueryHandler } from "./command-bus.js";

// Commands (§9)
export {
  CommandKinds,
  addMarker,
  clearDtcs,
  connectVehicle,
  disconnectVehicle,
  identifyEcus,
  readDid,
  readDtcFreezeFrame,
  readDtcs,
  snapshotSignals,
  startMeasurements,
  stopMeasurements,
} from "./commands.js";
export type {
  AddMarkerCommand,
  ClearDtcsCommand,
  CommandKind,
  ConnectVehicleCommand,
  ConnectVehicleOptions,
  ConnectVehicleResult,
  DisconnectVehicleCommand,
  IdentifyEcusCommand,
  ReadDidCommand,
  ReadDtcFreezeFrameCommand,
  ReadDtcsCommand,
  SnapshotSignalsCommand,
  StartMeasurementsCommand,
  StopMeasurementsCommand,
} from "./commands.js";

// Queries (§9)
export {
  QueryKinds,
  getAnomalies,
  getAvailableActions,
  getDtcClearPrecheck,
  getDtcList,
  getEcu,
  getEcuCapabilities,
  getEcuList,
  getMarkers,
  getMeasurementStatus,
  getMeasurements,
  getRecordingHistory,
  getSession,
  getSignalList,
  getStatistics,
  getVehicle,
  resolveVehicle,
} from "./queries.js";
export type {
  GetAnomaliesQuery,
  GetAvailableActionsQuery,
  GetDtcClearPrecheckQuery,
  GetDtcListQuery,
  GetEcuCapabilitiesQuery,
  GetEcuListQuery,
  GetEcuQuery,
  GetMarkersQuery,
  GetMeasurementStatusQuery,
  GetMeasurementsQuery,
  GetRecordingHistoryQuery,
  GetSessionQuery,
  GetSignalListQuery,
  GetStatisticsQuery,
  GetVehicleQuery,
  QueryKind,
  ResolveVehicleHints,
  ResolveVehicleQuery,
} from "./queries.js";

// Capability-driven actions (§7)
export { ActionRegistry, createStandardActions } from "./actions.js";
export type {
  ActionDescriptor,
  ActionVerdict,
  DiagnosticActionDefinition,
  DiagnosticContext,
} from "./actions.js";
