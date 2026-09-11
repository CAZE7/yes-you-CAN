/**
 * @vdp/application — public API (target architecture ADR 0014).
 *
 * The application layer defines *what* clients can ask the platform to do:
 * commands, queries, the command bus and capability-driven actions. It
 * depends only on `@vdp/domain` — how anything is executed is a matter for
 * the runtime layer that registers handlers here.
 */

// Command bus (§8, §9)
export { CommandBus, DuplicateHandlerError, NoHandlerError } from './command-bus.js';
export type { Command, CommandHandler, Query, QueryHandler } from './command-bus.js';

// Commands (§9)
export {
  CommandKinds,
  clearDtcs,
  connectVehicle,
  disconnectVehicle,
  readDid,
  readDtcs,
  snapshotSignals,
  startMeasurements,
  stopMeasurements,
} from './commands.js';
export type {
  ClearDtcsCommand,
  CommandKind,
  ConnectVehicleCommand,
  ConnectVehicleOptions,
  ConnectVehicleResult,
  DisconnectVehicleCommand,
  ReadDidCommand,
  ReadDtcsCommand,
  SnapshotSignalsCommand,
  StartMeasurementsCommand,
  StopMeasurementsCommand,
} from './commands.js';

// Queries (§9)
export {
  QueryKinds,
  getAvailableActions,
  getDtcList,
  getEcu,
  getEcuCapabilities,
  getEcuList,
  getMeasurements,
  getSession,
  getVehicle,
} from './queries.js';
export type {
  GetAvailableActionsQuery,
  GetDtcListQuery,
  GetEcuCapabilitiesQuery,
  GetEcuListQuery,
  GetEcuQuery,
  GetMeasurementsQuery,
  GetSessionQuery,
  GetVehicleQuery,
  QueryKind,
} from './queries.js';

// Capability-driven actions (§7)
export { ActionRegistry, createStandardActions } from './actions.js';
export type { ActionDescriptor, ActionVerdict, DiagnosticActionDefinition, DiagnosticContext } from './actions.js';
