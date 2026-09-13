/**
 * Command/query handler registration (target architecture §8/§9/§26).
 *
 * This is the only place where command kinds meet implementations. The UI
 * (and every other client) dispatches plain command/query objects and never
 * calls a service directly — so the interface stays stable when the engine
 * below it is decomposed.
 */

import {
  type ActionRegistry,
  type AddMarkerCommand,
  type ClearDtcsCommand,
  type CommandBus,
  CommandKinds,
  type ConnectVehicleCommand,
  type ConnectVehicleResult,
  type DiagnosticContext,
  type GetAvailableActionsQuery,
  type GetDtcClearPrecheckQuery,
  type GetDtcListQuery,
  type GetEcuCapabilitiesQuery,
  type GetEcuQuery,
  type GetMeasurementsQuery,
  type GetRecordingHistoryQuery,
  QueryKinds,
  type ReadDidCommand,
  type ReadDtcFreezeFrameCommand,
  type ReadDtcsCommand,
  type ResolveVehicleQuery,
  type SnapshotSignalsCommand,
  type StartMeasurementsCommand,
} from "@vdp/application";
import type {
  DtcService,
  EcuService,
  MeasurementService,
  SessionService,
  VehicleService,
} from "./services.js";

export interface RuntimeServices {
  vehicle: VehicleService;
  ecus: EcuService;
  dtc: DtcService;
  measurements: MeasurementService;
  session: SessionService;
  actions: ActionRegistry;
}

export function registerRuntimeHandlers(bus: CommandBus, services: RuntimeServices): void {
  const { vehicle, ecus, dtc, measurements, session, actions } = services;

  // Commands — operations that change state.
  bus.registerCommand<ConnectVehicleResult>(CommandKinds.ConnectVehicle, (command) =>
    vehicle.connect((command as ConnectVehicleCommand).options),
  );
  bus.registerCommand<void>(CommandKinds.DisconnectVehicle, () => vehicle.disconnect());
  bus.registerCommand(CommandKinds.IdentifyEcus, () => ecus.identifyAll());
  bus.registerCommand(CommandKinds.ReadDtcFreezeFrame, (command) => {
    const cmd = command as ReadDtcFreezeFrameCommand;
    return dtc.freezeFrame(cmd.ecuId, cmd.code, cmd.recordNumber);
  });
  bus.registerCommand(CommandKinds.AddMarker, (command) => {
    const cmd = command as AddMarkerCommand;
    return measurements.addMarker(cmd.label, cmd.markerKind, cmd.detail);
  });
  bus.registerCommand(CommandKinds.ReadDtcs, (command) => {
    const cmd = command as ReadDtcsCommand;
    return dtc.scan(cmd.ecuId, cmd.statusMask);
  });
  bus.registerCommand(CommandKinds.ClearDtcs, (command) => {
    const cmd = command as ClearDtcsCommand;
    return dtc.clear(cmd.ecuId, {
      userConfirmed: cmd.userConfirmed,
      vehicleState: cmd.vehicleState,
      ...(cmd.definitionVersion !== undefined ? { definitionVersion: cmd.definitionVersion } : {}),
    });
  });
  bus.registerCommand(CommandKinds.ReadDid, (command) => {
    const cmd = command as ReadDidCommand;
    return ecus.readDid(cmd.ecuId, cmd.did);
  });
  bus.registerCommand(CommandKinds.SnapshotSignals, (command) => {
    const cmd = command as SnapshotSignalsCommand;
    return measurements.snapshot(cmd.signalIds);
  });
  bus.registerCommand<void>(CommandKinds.StartMeasurements, async (command) => {
    const cmd = command as StartMeasurementsCommand;
    await measurements.start({
      ...(cmd.signalIds !== undefined ? { signalIds: cmd.signalIds } : {}),
      ...(cmd.intervalMs !== undefined ? { intervalMs: cmd.intervalMs } : {}),
    });
  });
  bus.registerCommand<void>(CommandKinds.StopMeasurements, () => {
    measurements.stop();
  });

  // Queries — read-only, served from the live state (read model today).
  bus.registerQuery(QueryKinds.GetSession, () => session.current());
  bus.registerQuery(QueryKinds.GetVehicle, () => vehicle.identity());
  bus.registerQuery(QueryKinds.ResolveVehicle, (query) =>
    vehicle.resolve((query as ResolveVehicleQuery).hints),
  );
  bus.registerQuery(QueryKinds.GetEcuList, () => ecus.list());
  bus.registerQuery(QueryKinds.GetEcu, (query) => ecus.get((query as GetEcuQuery).ecuId));
  bus.registerQuery(QueryKinds.GetEcuCapabilities, (query) =>
    ecus.capabilities((query as GetEcuCapabilitiesQuery).ecuId),
  );
  bus.registerQuery(QueryKinds.GetDtcList, (query) => {
    const { ecuId } = query as GetDtcListQuery;
    const all = dtc.lastScanResult;
    return ecuId === undefined ? all : all.filter((dtcInfo) => dtcInfo.ecuId === ecuId);
  });
  bus.registerQuery(QueryKinds.GetDtcClearPrecheck, (query) => {
    const cmd = query as GetDtcClearPrecheckQuery;
    return dtc.precheckClear(cmd.ecuId, cmd.vehicleState);
  });
  bus.registerQuery(QueryKinds.GetSignalList, () => measurements.signals());
  bus.registerQuery(QueryKinds.GetMarkers, () => measurements.markers());
  bus.registerQuery(QueryKinds.GetStatistics, () => measurements.statistics());
  bus.registerQuery(QueryKinds.GetAnomalies, () => measurements.anomalies());
  bus.registerQuery(QueryKinds.GetRecordingHistory, (query) =>
    measurements.history((query as GetRecordingHistoryQuery).limit),
  );
  bus.registerQuery(QueryKinds.GetMeasurementStatus, () => measurements.status());
  bus.registerQuery(QueryKinds.GetMeasurements, (query) =>
    measurements.samples((query as GetMeasurementsQuery).signalId),
  );
  bus.registerQuery(QueryKinds.GetAvailableActions, (query) => {
    const { ecuId } = query as GetAvailableActionsQuery;
    const context: DiagnosticContext = {
      connected: session.current() !== undefined,
      ...(ecuId !== undefined ? { ecu: ecus.get(ecuId) } : {}),
    };
    return actions.available(context);
  });
}
