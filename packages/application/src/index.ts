/**
 * @vdp/application — public API (target architecture ADR 0014).
 *
 * The application layer defines *what* clients can ask the platform to do:
 * commands, queries, the command bus and capability-driven actions. It
 * depends only on `@vdp/domain` — how anything is executed is a matter for
 * the runtime layer that registers handlers here.
 */

export type {
  ActionDescriptor,
  ActionVerdict,
  DiagnosticActionDefinition,
  DiagnosticContext,
} from "./actions.js";
// Capability-driven actions (§7)
export { ActionRegistry, createStandardActions } from "./actions.js";
export type { Command, CommandHandler, Query, QueryHandler } from "./command-bus.js";
// Command bus (§8, §9)
export { CommandBus, DuplicateHandlerError, NoHandlerError } from "./command-bus.js";
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
// Commands (§9)
export {
  addMarker,
  CommandKinds,
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
  GetAnomaliesQuery,
  GetAvailableActionsQuery,
  GetDtcClearPrecheckQuery,
  GetDtcListQuery,
  GetDtcScanGapsQuery,
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
// Queries (§9)
export {
  getAnomalies,
  getAvailableActions,
  getDtcClearPrecheck,
  getDtcList,
  getDtcScanGaps,
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
  QueryKinds,
  resolveVehicle,
} from "./queries.js";
