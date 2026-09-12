/**
 * Commands — operations that change state (target architecture §9).
 *
 * A command is a plain, serialisable object naming an *intention*; the
 * handler that carries it out is registered separately on the {@link CommandBus}.
 * Keeping commands as data means the UI, CLI, API and AI all dispatch the
 * same objects, and they can be logged, queued and replayed.
 */

import type {
  ClearDtcOutcome,
  DtcInfo,
  EcuSummary,
  FreezeFrameInfo,
  MarkerInfo,
  MeasurementReading,
  RawDidReading,
  SessionSummary,
  VehicleStateReading,
  VehicleSummary,
} from "@vdp/domain";
import type { Command } from "./command-bus.js";

/** Stable string kinds — shared between producers and the handler registry. */
export const CommandKinds = {
  ConnectVehicle: "vehicle.connect",
  DisconnectVehicle: "vehicle.disconnect",
  IdentifyEcus: "ecu.identify",
  ReadDtcs: "dtc.read",
  ReadDtcFreezeFrame: "dtc.freeze-frame",
  ClearDtcs: "dtc.clear",
  ReadDid: "did.read",
  SnapshotSignals: "measurement.snapshot",
  StartMeasurements: "measurement.start",
  StopMeasurements: "measurement.stop",
  AddMarker: "marker.add",
} as const;

export type CommandKind = (typeof CommandKinds)[keyof typeof CommandKinds];

export interface ConnectVehicleResult {
  session: SessionSummary;
  vehicle?: VehicleSummary;
  ecus: readonly EcuSummary[];
}

export interface ConnectVehicleOptions {
  /**
   * Discovery listen window in ms; the engine default applies when omitted.
   * Bounds the two listen phases only — the probe loop adds one
   * {@link ConnectVehicleOptions.probeDelayMs} per candidate.
   */
  windowMs?: number;
  /**
   * Pause between two single ECU probes in ms; the core default (15) applies
   * when omitted. Tests and deterministic replays pass 0 (AGENTS 31).
   */
  probeDelayMs?: number;
}

export interface ConnectVehicleCommand extends Command<ConnectVehicleResult> {
  readonly kind: typeof CommandKinds.ConnectVehicle;
  readonly options?: ConnectVehicleOptions;
}

export function connectVehicle(options?: ConnectVehicleOptions): ConnectVehicleCommand {
  return options === undefined
    ? { kind: CommandKinds.ConnectVehicle }
    : { kind: CommandKinds.ConnectVehicle, options };
}

export interface DisconnectVehicleCommand extends Command<void> {
  readonly kind: typeof CommandKinds.DisconnectVehicle;
}

export function disconnectVehicle(): DisconnectVehicleCommand {
  return { kind: CommandKinds.DisconnectVehicle };
}

export interface IdentifyEcusCommand extends Command<readonly EcuSummary[]> {
  readonly kind: typeof CommandKinds.IdentifyEcus;
}

/** Re-read identification DIDs from every attached ECU (read-only, AGENTS 12). */
export function identifyEcus(): IdentifyEcusCommand {
  return { kind: CommandKinds.IdentifyEcus };
}

export interface ReadDtcFreezeFrameCommand extends Command<FreezeFrameInfo> {
  readonly kind: typeof CommandKinds.ReadDtcFreezeFrame;
  /** ECU reference: session id, definition id or "0x…" address. */
  readonly ecuId: string;
  readonly code: string;
  /** Snapshot record number; 0xff reads the ECU's default record. */
  readonly recordNumber?: number;
}

export function readDtcFreezeFrame(
  ecuId: string,
  code: string,
  recordNumber?: number,
): ReadDtcFreezeFrameCommand {
  return {
    kind: CommandKinds.ReadDtcFreezeFrame,
    ecuId,
    code,
    ...(recordNumber !== undefined ? { recordNumber } : {}),
  };
}

export interface AddMarkerCommand extends Command<MarkerInfo> {
  readonly kind: typeof CommandKinds.AddMarker;
  readonly label: string;
  /** Marker category; defaults to a user marker. `kind` names the command. */
  readonly markerKind?: MarkerInfo["kind"];
  readonly detail?: string;
}

export function addMarker(
  label: string,
  markerKind?: MarkerInfo["kind"],
  detail?: string,
): AddMarkerCommand {
  return {
    kind: CommandKinds.AddMarker,
    label,
    ...(markerKind !== undefined ? { markerKind } : {}),
    ...(detail !== undefined ? { detail } : {}),
  };
}

export interface ReadDtcsCommand extends Command<readonly DtcInfo[]> {
  readonly kind: typeof CommandKinds.ReadDtcs;
  /** Restrict the scan to one ECU; undefined means "every reachable ECU". */
  readonly ecuId?: string;
  /** ISO 14229-1 status mask; defaults to all statuses. */
  readonly statusMask?: number;
}

export function readDtcs(ecuId?: string, statusMask?: number): ReadDtcsCommand {
  return {
    kind: CommandKinds.ReadDtcs,
    ...(ecuId !== undefined ? { ecuId } : {}),
    ...(statusMask !== undefined ? { statusMask } : {}),
  };
}

export interface ClearDtcsCommand extends Command<ClearDtcOutcome> {
  readonly kind: typeof CommandKinds.ClearDtcs;
  readonly ecuId: string;
  /** Explicit operator confirmation — the safety chain refuses without it. */
  readonly userConfirmed: boolean;
  readonly vehicleState: VehicleStateReading;
  /** Definition version the clear is validated against (audit log). */
  readonly definitionVersion?: string;
}

export function clearDtcs(
  ecuId: string,
  userConfirmed: boolean,
  vehicleState: VehicleStateReading,
  definitionVersion?: string,
): ClearDtcsCommand {
  return {
    kind: CommandKinds.ClearDtcs,
    ecuId,
    userConfirmed,
    vehicleState,
    ...(definitionVersion !== undefined ? { definitionVersion } : {}),
  };
}

export interface ReadDidCommand extends Command<RawDidReading> {
  readonly kind: typeof CommandKinds.ReadDid;
  readonly ecuId: string;
  readonly did: number;
}

export function readDid(ecuId: string, did: number): ReadDidCommand {
  return { kind: CommandKinds.ReadDid, ecuId, did };
}

export interface SnapshotSignalsCommand extends Command<readonly MeasurementReading[]> {
  readonly kind: typeof CommandKinds.SnapshotSignals;
  /** Restrict to these signal ids; omitted means "every defined signal". */
  readonly signalIds?: readonly string[];
}

export function snapshotSignals(signalIds?: readonly string[]): SnapshotSignalsCommand {
  return signalIds === undefined
    ? { kind: CommandKinds.SnapshotSignals }
    : { kind: CommandKinds.SnapshotSignals, signalIds };
}

export interface StartMeasurementsCommand extends Command<void> {
  readonly kind: typeof CommandKinds.StartMeasurements;
  readonly signalIds?: readonly string[];
  readonly intervalMs?: number;
}

export function startMeasurements(
  signalIds?: readonly string[],
  intervalMs?: number,
): StartMeasurementsCommand {
  return {
    kind: CommandKinds.StartMeasurements,
    ...(signalIds !== undefined ? { signalIds } : {}),
    ...(intervalMs !== undefined ? { intervalMs } : {}),
  };
}

export interface StopMeasurementsCommand extends Command<void> {
  readonly kind: typeof CommandKinds.StopMeasurements;
}

export function stopMeasurements(): StopMeasurementsCommand {
  return { kind: CommandKinds.StopMeasurements };
}
