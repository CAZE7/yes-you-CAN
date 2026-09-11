/**
 * Demo backend (AGENTS 19: simulator instead of a real car).
 *
 * Owns the diagnostic engine and the transport it talks over, and publishes
 * already decoded values to the UI. The front end never receives a CAN frame it
 * would have to interpret — it gets decoded signals plus raw trace entries that
 * are explicitly labelled raw (AGENTS 5, 34.3, 18).
 *
 * Three transport sources are supported, chosen through the adapter catalog
 * (AGENTS 4, 29):
 *
 * - `simulator` — a virtual vehicle, so the workbench runs without hardware;
 * - `replay`    — a recorded session, so a problem is reproducible without the car;
 * - a real adapter (`elm327`, `slcan`, `socketcan`, …) opened by the host layer.
 *
 * The engine code path is identical for all three: the backend only decides
 * which `CanBus` it hands over, which is exactly what ADR 0001 promises.
 */

import { readFile } from "node:fs/promises";
import {
  type AdapterCatalog,
  type AdapterDescription,
  type AdapterProbe,
  type AdapterSelection,
  validateSelection,
} from "@vdp/adapter-host";
import {
  type AnalysisInput,
  type AnalysisResult,
  AnalysisService,
  HeuristicAnalysisProvider,
} from "@vdp/ai";
import {
  type DecodedSignal,
  DiagnosticEngine,
  type EnrichedDtc,
  type FreezeFrame,
  type Marker,
  type MeasurementSample,
  type RawTraceEntry,
  SessionLogger,
  type SignalStatistics,
  type VehicleSessionData,
} from "@vdp/core";
import { type DefinitionPackage, genericPackage } from "@vdp/definitions";
import type { DtcRecord } from "@vdp/protocols-uds";
import { AdapterUnsupportedError, type Logger, TransportError, createLogger } from "@vdp/shared";
import { DEFAULT_VIN, VirtualVehicle } from "@vdp/simulators";
import {
  FileSystemSessionRepository,
  type SessionRepository,
  type StoredSessionSummary,
} from "@vdp/storage";
import {
  type CanBus,
  type ReplayRecording,
  ReplayTransport,
  recordingFromSessionJson,
} from "@vdp/transport-can";
import {
  REPLAY_ADAPTER_ID,
  SIMULATOR_ADAPTER_ID,
  createWebAdapterCatalog,
  isApplicationManaged,
} from "./adapters.js";

export interface EcuView {
  id: string;
  name: string;
  txId: string;
  rxId: string;
  extended: boolean;
  reachable: boolean;
  identification: Array<{ label: string; value: string }>;
  services: string[];
  sessionType: number;
  p2Ms: number;
  dtcCount: number;
  lastError?: string;
}

/**
 * Freeze frame of a fault code, as shown in the UI (AGENTS 20).
 *
 * Decoded values and raw bytes both travel to the front end so an operator can
 * see that a value came from a byte range, not from a guess.
 */
export interface FreezeFrameView {
  code: string;
  recordNumber: number;
  documented: boolean;
  notes: string[];
  unassignedHex: string;
  fields: Array<{
    did: string;
    name: string;
    rawHex: string;
    values: Array<{
      signal: string;
      name: string;
      value: string;
      unit?: string;
      rawHex: string;
      outOfRange: boolean;
    }>;
  }>;
}

/**
 * Vehicle preconditions for a write, as asserted by the operator (AGENTS 26).
 *
 * They are asserted, not measured: the workbench cannot see whether the car is
 * stationary, so the operator confirms each one and the safety layer records who
 * asserted what. A value that a real adapter *can* measure (battery voltage via
 * ATRV) is passed through when it is known.
 */
export interface VehicleStateView {
  stationary: boolean;
  ignitionOn: boolean;
  parkingBrake?: boolean;
  batteryVoltage?: number;
}

/** Result of a cleared fault memory, including the before/after comparison. */
export interface DtcClearView {
  ecu: string;
  cleared: boolean;
  /** The re-read confirms that the clear took effect. */
  verified: boolean;
  before: string[];
  after: string[];
  /** Codes that are gone after the clear. */
  removed: string[];
  /** Codes that are still stored because the fault condition is still present. */
  stillFailing: string[];
  /** Codes whose status did not change at all — the ECU ignored the clear. */
  unchanged: string[];
}

export interface DtcClearPrecheck {
  rxId: string;
  ecu: string;
  ok: boolean;
  failed: string[];
  warnings: string[];
}

export interface DtcView {
  code: string;
  raw: string;
  /** Response id of the ECU that reported the code, so the UI can address it. */
  rxId: string;
  /** Description from the definition package, or the raw protocol fallback. */
  description: string;
  severity: string;
  ecu: string;
  status: string;
  confirmed: boolean;
  pending: boolean;
  testFailed: boolean;
  /** Next diagnostic step from the definition package, when one is documented. */
  hint?: string;
  /** First scan in this session that saw the code (AGENTS 20). */
  firstSeen?: string;
  /** Most recent scan that saw the code (AGENTS 20). */
  lastSeen?: string;
  /** True when the code appeared for the first time in the latest scan. */
  isNew?: boolean;
  /** Signals the definition package relates to this code (AGENTS 20). */
  relatedSignals?: Array<{ id: string; name: string }>;
  /**
   * Whether reading a freeze frame for this code is meaningful: the ECU returned
   * a snapshot record before, or the definition documents a layout.
   */
  freezeFrame?: boolean;
  /** Provenance of the description — never present invented knowledge (AGENTS 24). */
  provenance?: string;
}

export interface SampleView {
  signal: string;
  name: string;
  /** Formatted for display — the UI shows this string verbatim. */
  value: string;
  /**
   * Numeric value for the graphs, `null` for textual/enum signals.
   * Charts must never parse a formatted string back into a number: the decimal
   * separator and the precision belong to the presentation layer (AGENTS 14).
   */
  numeric: number | null;
  /** Undecoded value next to the decoded one (AGENTS 34.7). */
  rawValue: number | string | boolean;
  rawHex: string;
  unit?: string;
  outOfRange: boolean;
  t: number;
  timestamp: string;
}

/** Marker on the shared time axis (AGENTS 16 "Event-Marker", AGENTS 20 DTC events). */
export interface MarkerView {
  id: string;
  t: number;
  timestamp: string;
  label: string;
  kind: "dtc" | "action" | "note" | "user" | "anomaly";
  detail?: string;
}

export interface TraceView {
  t: number;
  timestamp: string;
  canId: string;
  direction: "tx" | "rx";
  dlc: number;
  data: string;
  channel: string;
  extended: boolean;
}

export interface HistoryView {
  /** Wall clock at recording start, so the UI can convert relative times. */
  startedAt: number;
  live: boolean;
  samples: SampleView[];
  markers: MarkerView[];
}

export interface AppState {
  connected: boolean;
  /** Which transport source is selected (AGENTS 4, 29, 32). */
  mode: BackendMode;
  sessionId: string;
  vin?: string;
  vehicle: string;
  mileageKm?: number;
  adapter: { id: string; name: string; kind: string; channels: string[] };
  /** Adapter the user selected, including its settings, so the UI can show them. */
  adapterSelection: AdapterSelection;
  /** Live probe result of the selected adapter (never a guess). */
  adapterProbe?: AdapterProbe;
  transport: { kind: string; channel: string; mtu: number };
  ecus: EcuView[];
  dtcs: DtcView[];
  samples: SampleView[];
  statistics: SignalStatistics[];
  trace: TraceView[];
  live: boolean;
  signals: Array<{ id: string; name: string; unit?: string; critical: boolean }>;
  anomalies: Array<{ signal: string; reason: string; value?: number }>;
  actions: Array<{
    timestamp: string;
    kind: string;
    ecuId: string;
    description: string;
    result: string;
  }>;
}

/**
 * Events pushed to the UI over SSE. Every member here has an `emit()` call
 * site below; `'log'` was dropped because nothing ever sent or listened for
 * it (the `'log'` string elsewhere is a storage line kind, not an SSE event).
 */
export interface BackendEvent {
  /** 'marker' adds one event, 'markers' replaces the whole list (after a scan). */
  type: "sample" | "trace" | "dtc" | "ecu" | "analysis" | "error" | "marker" | "markers";
  payload: unknown;
}

export interface BackendOptions {
  logger?: Logger;
  vin?: string;
  definitions?: readonly DefinitionPackage[];
  liveIntervalMs?: number;
  /** Seed the simulator with fault codes so the DTC view is not empty. */
  seedDtcs?: boolean;
  /** Where sessions are persisted (AGENTS 10, 29). Omitted disables persistence. */
  sessionDir?: string;
  repository?: SessionRepository;
  /**
   * Adapter catalog. Defaults to the workbench catalog (simulator, replay and
   * every adapter this host can drive); tests inject their own.
   */
  adapters?: AdapterCatalog;
  /** Adapter selected at startup; the simulator by default. */
  selection?: AdapterSelection;
  /**
   * Pre-built bus (test/embedding hook): when set, the backend uses it instead
   * of creating one from the selection. The catalog still describes the choice
   * for the UI, so both views stay consistent.
   */
  bus?: CanBus;
  /** Trace used by the replay adapter, as a file path or raw JSON text. */
  trace?: string;
}

const _MAX_TRACE = 800;

/**
 * Where the CAN traffic comes from.
 *
 * `simulator` and `replay` are application-owned transports; `hardware` means a
 * real adapter builds the bus.
 */
export type BackendMode = "simulator" | "replay" | "hardware";

export class DemoBackend {
  readonly log: Logger;
  readonly analysisService: AnalysisService;
  readonly adapters: AdapterCatalog;
  private vehicle?: VirtualVehicle;
  private bus?: CanBus;
  private engine?: DiagnosticEngine;
  private selection: AdapterSelection;
  private mode: BackendMode;
  private probe?: AdapterProbe;
  private readonly sessionLogger = new SessionLogger();
  private readonly listeners = new Set<(event: BackendEvent) => void>();
  private unsubscribeBus?: () => void;
  private ecus: EcuView[] = [];
  private dtcs: DtcView[] = [];
  private live = false;
  private connected = false;
  private readonly vin: string;
  private readonly definitions: readonly DefinitionPackage[];
  private readonly repository?: SessionRepository;
  /**
   * Turns raw protocol codes into described fault entries. Descriptions come
   * from definition packages only — a code nobody documented stays undescribed
   * instead of being guessed (AGENTS 13, 20, 24).
   */

  constructor(private readonly options: BackendOptions = {}) {
    this.log = (options.logger ?? createLogger("web", { level: "INFO" })).child("backend");
    this.vin = options.vin ?? DEFAULT_VIN;
    this.definitions = options.definitions ?? [genericPackage];
    this.analysisService = new AnalysisService({
      providers: [new HeuristicAnalysisProvider()],
      logger: this.log,
    });
    this.adapters = options.adapters ?? createWebAdapterCatalog();
    this.selection = options.selection ?? { id: SIMULATOR_ADAPTER_ID, config: {} };
    this.mode = modeForSelection(this.selection, this.adapters);
    // Persistence is opt-in so tests and ephemeral runs stay side-effect free.
    if (options.repository) this.repository = options.repository;
    else if (options.sessionDir)
      this.repository = new FileSystemSessionRepository({
        rootDir: options.sessionDir,
        logger: this.log,
      });
  }

  /** Transport source currently selected. */
  get currentMode(): BackendMode {
    return this.mode;
  }

  /** Adapter the user selected, with its settings. */
  get adapterSelection(): AdapterSelection {
    return this.selection;
  }

  /**
   * The bus the engine talks to. Exposed for tests and embedding so a caller can
   * drive frames directly (e.g. the replay regression suites).
   */
  get canBus(): CanBus | undefined {
    return this.bus;
  }

  /**
   * Adapters this host can use, with a live probe result each.
   *
   * Probing never opens a bus, so listing is safe while a vehicle is connected
   * — that is what lets the UI offer a different adapter without disconnecting
   * first (AGENTS 4, 29).
   */
  async listAdapters(): Promise<AdapterDescription[]> {
    const described = await this.adapters.describeAll(this.selection.config);
    return described;
  }

  /**
   * Select an adapter.
   *
   * Validation happens before anything is opened or closed: an unusable choice
   * must leave the running session untouched rather than disconnect the user
   * from a vehicle because of a typo.
   */
  async selectAdapter(
    selection: AdapterSelection,
  ): Promise<{ description: AdapterDescription; reconnectRequired: boolean }> {
    const validation = validateSelection(this.adapters, selection);
    if (!validation.ok) {
      throw new AdapterUnsupportedError(
        `adapter selection rejected: ${validation.errors.join("; ")}`,
        {
          adapterId: selection.id,
          errors: validation.errors,
        },
      );
    }
    const wasConnected = this.connected;
    if (wasConnected) await this.stop();
    this.selection = selection;
    this.mode = modeForSelection(selection, this.adapters);
    const description = await this.adapters.describe(selection.id, selection.config, {
      logger: this.log,
    });
    this.probe = description.probe;
    this.log.info("adapter selected", {
      adapter: selection.id,
      mode: this.mode,
      available: description.probe.available,
    });
    return { description, reconnectRequired: wasConnected };
  }

  /** Persist the current session, its samples and its raw trace (AGENTS 10, 29). */
  async saveSession(): Promise<{ id: string; repository: boolean }> {
    const engine = this.requireEngine();
    const data = engine.vehicleSession?.data;
    if (!data) throw new Error("no session to save — call start() first");
    if (!this.repository) return { id: data.id, repository: false };

    await this.repository.save(data);
    const { samples } = engine.recorder.export();
    await this.repository.appendSamples(data.id, samples);
    const snapshot = this.sessionLogger.snapshot();
    await this.repository.appendLines(
      data.id,
      "trace",
      snapshot.trace.map((entry) => JSON.stringify({ ...entry, payload: entry.payloadHex })),
    );
    await this.repository.appendLines(
      data.id,
      "log",
      snapshot.log.map((entry) => JSON.stringify(entry)),
    );
    this.log.info("session saved", {
      id: data.id,
      samples: samples.length,
      trace: snapshot.trace.length,
    });
    return { id: data.id, repository: true };
  }

  /** Stored sessions, newest first. */
  async listSessions(): Promise<StoredSessionSummary[]> {
    if (!this.repository) return [];
    return this.repository.list();
  }

  /** ZIP session package for handover to another workstation (AGENTS 17). */
  async sessionPackage(id: string): Promise<Uint8Array> {
    if (!this.repository) throw new Error("session persistence is not enabled");
    return this.repository.exportPackage(id);
  }

  subscribe(listener: (event: BackendEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(type: BackendEvent["type"], payload: unknown): void {
    for (const listener of this.listeners) {
      try {
        listener({ type, payload });
      } catch (error) {
        this.log.warn("event listener failed", { error: messageOf(error) });
      }
    }
  }

  /** Open the selected transport and run ECU discovery. */
  async start(): Promise<AppState> {
    if (this.connected) return this.state();
    this.log.info("backend starting", {
      mode: this.mode,
      adapter: this.selection.id,
      vin: this.vin,
    });
    try {
      // Probe first and report the result, but let the adapter itself produce the
      // authoritative error: a probe is allowed to be more conservative than the
      // real open (for example when a SocketCAN binding cannot list interfaces).
      const described = await this.adapters.describe(this.selection.id, this.selection.config, {
        logger: this.log,
      });
      this.probe = described.probe;
      if (!described.probe.available) {
        this.log.warn("adapter probe reports unavailable", {
          adapter: this.selection.id,
          detail: described.probe.detail,
        });
      }
      const bus = await this.openBus();
      this.bus = bus;

      // Raw trace: every frame on the bus is recorded verbatim (AGENTS 18).
      this.unsubscribeBus = bus.subscribe((frame) => {
        const entry = this.sessionLogger.recordFrame(frame);
        this.emit("trace", toTraceView(entry));
      });

      this.engine = new DiagnosticEngine({ bus, definitions: this.definitions, logger: this.log });
      const result = await this.engine.connect();
      this.connected = true;
      this.ecus = result.ecus.map((discovered) => this.toEcuView(discovered.rxId));
      this.sessionLogger.log("backend", "connected", {
        adapter: this.selection.id,
        ecus: result.ecus.length,
      });
      this.log.info("backend connected", { adapter: this.selection.id, ecus: result.ecus.length });
      await this.identify();
      return this.state();
    } catch (error) {
      // A failed start must not leave a half-open transport behind: the next
      // attempt would then fail with "already open" instead of the real reason.
      await this.teardown();
      throw error;
    }
  }

  /**
   * Build the bus for the selected adapter.
   *
   * This is the single seam between the application and the transport layer
   * (ADR 0001): everything above it — ISO-TP, UDS, measurement engine, session —
   * is identical for simulator, replay and hardware.
   */
  private async openBus(): Promise<CanBus> {
    if (this.options.bus) {
      this.log.info("using the injected bus", { adapter: this.selection.id });
      return this.options.bus;
    }
    if (this.mode === "simulator") {
      this.vehicle = this.createVirtualVehicle();
      await this.vehicle.start();
      return this.vehicle.testerBus;
    }
    if (this.mode === "replay") {
      return this.createReplayBus();
    }
    const entry = this.adapters.require(this.selection.id);
    if (isApplicationManaged(entry)) {
      throw new AdapterUnsupportedError(
        `adapter "${entry.id}" is managed by the application and cannot be opened by the adapter layer`,
        { adapterId: entry.id },
      );
    }
    const probe = await this.adapters.describe(entry.id, this.selection.config, {
      logger: this.log,
    });
    this.probe = probe.probe;
    this.log.info("opening adapter", {
      adapter: entry.id,
      detail: probe.probe.detail,
      config: this.selection.config,
    });
    return entry.create(this.selection.config, { logger: this.log });
  }

  private createVirtualVehicle(): VirtualVehicle {
    return new VirtualVehicle({
      vin: this.vin,
      // The simulator takes a single package; the first one is the baseline.
      definitions: this.definitions[0] ?? genericPackage,
      logger: this.log,
      dynamic: true,
      // Echo our own frames back so the raw trace records requests *and*
      // responses; a trace with only rx frames cannot be replayed or paired.
      networkOptions: { echoToSender: true },
      ...(this.options.seedDtcs === false
        ? {}
        : {
            dtcs: {
              engine: [
                { code: "P0420", status: 0x2f },
                { code: "P0300", status: 0x2f },
              ],
              abs: [{ code: "C1234", status: 0x08 }],
            },
          }),
    });
  }

  /**
   * Replay a recorded session instead of talking to a vehicle (AGENTS 19).
   *
   * The recording is either a stored session (repository) or a session export
   * file. Deviations are kept, not smoothed over: replay is a diagnostic tool,
   * and a silent mismatch is worse than a reported one.
   */
  private async createReplayBus(): Promise<CanBus> {
    const recording = await this.loadRecording();
    const transport = new ReplayTransport(recording, { logger: this.log });
    this.log.info("replay transport ready", {
      frames: recording.frames.length,
      channel: recording.channel,
    });
    return transport;
  }

  private async loadRecording(): Promise<ReplayRecording> {
    const reference = this.selection.config.trace;
    if (!reference) {
      throw new AdapterUnsupportedError(
        "replay needs a recording: pass a stored session id or a session export file",
      );
    }
    // A stored session id is looked up in the repository; anything else is
    // treated as a path to a session export and finally as inline JSON.
    if (this.repository && (await this.repository.exists(reference))) {
      const { data } = await this.repository.load(reference);
      const trace = await this.repository.readTrace(reference);
      if (trace.length === 0) {
        throw new TransportError(
          `session ${reference} contains no raw trace to replay — was it saved without one?`,
          { id: reference },
        );
      }
      this.log.info("replaying stored session", {
        id: reference,
        frames: trace.length,
        vin: data.vehicle?.vin,
      });
      return {
        channel: data.transport.channel,
        frames: trace.map((line) => ({
          t: line.t,
          canId: line.canId,
          direction: line.direction,
          payload: hexToBytes(line.payload),
          ...(line.channel ? { channel: line.channel } : {}),
          ...(line.extended === undefined ? {} : { extended: line.extended }),
          ...(line.fd === undefined ? {} : { fd: line.fd }),
        })),
      };
    }
    const text = reference.trimStart().startsWith("{")
      ? reference
      : await readFile(reference, "utf8").catch((error: unknown) => {
          throw new TransportError(`cannot read recording "${reference}": ${messageOf(error)}`, {
            reference,
          });
        });
    return recordingFromSessionJson(text);
  }

  /**
   * Close everything the current session owns.
   *
   * Idempotent on purpose: it runs after a failed start, on stop and before an
   * adapter change, and every one of those paths must be safe to repeat.
   */
  private async teardown(): Promise<void> {
    this.stopLive();
    this.unsubscribeBus?.();
    this.unsubscribeBus = undefined;
    await this.engine?.disconnect().catch((error: unknown) => {
      this.log.warn("engine disconnect failed", { error: messageOf(error) });
    });
    this.engine = undefined;
    await this.vehicle?.stop().catch((error: unknown) => {
      this.log.warn("simulator stop failed", { error: messageOf(error) });
    });
    this.vehicle = undefined;
    this.bus = undefined;
    this.connected = false;
    this.ecus = [];
    this.dtcs = [];
  }

  /** Read identification DIDs from every discovered ECU (read-only, AGENTS 34.11). */
  async identify(): Promise<EcuView[]> {
    const engine = this.requireEngine();
    for (const view of this.ecus) {
      const handle = engine.handleFor(Number.parseInt(view.rxId, 16));
      if (!handle) continue;
      try {
        await handle.session.readIdentification();
        const record = this.session()?.ecus.find((ecu) => ecu.rxId === handle.discovered.rxId);
        if (record) {
          view.id = record.id;
          view.name = record.name;
          view.identification = record.identification.map((entry) => ({
            label: entry.label,
            value: entry.value,
          }));
          view.services = record.supportedServices.map(
            (sid) => `0x${sid.toString(16).toUpperCase()}`,
          );
          view.sessionType = record.sessionType;
          view.p2Ms = record.timing.p2Ms;
          view.reachable = record.reachable;
        }
        this.emit("ecu", view);
      } catch (error) {
        view.lastError = messageOf(error);
        this.log.warn("identification failed", { ecu: view.rxId, error: messageOf(error) });
      }
    }
    return this.ecus;
  }

  /** Read fault codes from all ECUs. */
  async scanDtcs(): Promise<DtcView[]> {
    const engine = this.requireEngine();
    const scanned = await engine.scanDtcs();
    this.dtcs = [];
    for (const entry of scanned) {
      // The engine already enriched the codes with the definition package
      // (description, severity, first/last seen, related signals); the backend
      // only maps them to the view shape the UI consumes (AGENTS 13/20).
      const rxId = formatCanId(entry.ecu.rxId);
      for (const dtc of entry.dtcs) {
        const view = toDtcView(dtc, entry.ecu.name, rxId);
        this.dtcs.push(view);
        this.emit("dtc", view);
        // The DTC markers themselves are written by the diagnostic engine while
        // scanning (one per code) — the backend only forwards the table row.
      }
    }
    this.sessionLogger.log("dtc", "scan complete", { count: this.dtcs.length });
    this.log.info("DTC scan complete", { count: this.dtcs.length });
    // The engine wrote one marker per fault code; publish the complete list so
    // open graphs show them immediately without waiting for a history reload.
    this.emit("markers", toMarkerViews(engine.recorder.markers));
    return this.dtcs;
  }

  /**
   * Read the freeze frame of one fault code from one ECU (AGENTS 20 "Snapshot").
   *
   * The response always carries the raw bytes as well: a snapshot whose layout no
   * definition documents is still evidence and must not be dropped.
   */
  async readFreezeFrame(rxId: number, code: string, recordNumber = 0xff): Promise<FreezeFrameView> {
    const engine = this.requireEngine();
    const frame = await engine.readDtcSnapshot(rxId, code, recordNumber);
    if (!frame) throw new Error(`ECU 0x${rxId.toString(16)} has no freeze frame for ${code}`);
    this.sessionLogger.log("dtc", `freeze frame ${code}`, {
      ecu: `0x${rxId.toString(16)}`,
      documented: frame.documented,
    });
    return toFreezeFrameView(frame);
  }

  /**
   * What the safety layer would require for clearing an ECU (AGENTS 26).
   * The UI asks this before showing the confirmation so the operator sees the
   * missing preconditions instead of a refusal afterwards.
   */
  async precheckDtcClear(rxId: number, vehicleState: VehicleStateView): Promise<DtcClearPrecheck> {
    const engine = this.requireEngine();
    const handle = engine.handleFor(rxId);
    if (!handle) throw new Error(`no ECU session for 0x${rxId.toString(16)}`);
    const checks = engine.evaluateDtcClear(rxId, {
      // `userConfirmed: false` is intentional: the precheck lists everything that
      // still has to happen, including the confirmation itself.
      userConfirmed: false,
      vehicleState,
    });
    return {
      rxId: formatCanId(rxId),
      ecu: handle.session.record.name,
      // `userConfirmed: false` is intentional: the precheck lists everything that
      // still has to happen, including the confirmation itself.
      ok: checks.ok,
      failed: checks.failed,
      warnings: checks.warnings,
    };
  }

  /**
   * Clear the fault memory of one ECU.
   *
   * This is the platform's only write operation so far, and it runs through the
   * whole safety chain: backup snapshot → explicit confirmation → write →
   * verification by re-read → audit log (AGENTS 20, 25, 26).
   */
  async clearDtcs(
    rxId: number,
    request: { confirmed: boolean; vehicleState: VehicleStateView },
  ): Promise<DtcClearView> {
    const engine = this.requireEngine();
    const result = await engine.clearDtcs(rxId, {
      userConfirmed: request.confirmed,
      vehicleState: request.vehicleState,
    });
    // The table has to reflect the new state, not the pre-clear one.
    await this.scanDtcs();
    this.emit(
      "marker",
      toMarkerViews(
        [
          engine.recorder.addMarker(
            `Fehlerspeicher ${result.ecuName} gelöscht`,
            "action",
            result.verified ? "verifiziert" : "nicht bestätigt",
          ),
        ].filter((m): m is Marker => m !== null),
      )[0],
    );
    this.log.info("fault memory cleared", {
      ecu: result.ecuName,
      removed: result.comparison.removed.length,
      verified: result.verified,
    });
    return {
      ecu: result.ecuName,
      cleared: result.cleared,
      verified: result.verified,
      before: result.before.map((dtc) => dtc.code),
      after: result.after.map((dtc) => dtc.code),
      removed: result.comparison.removed.map((dtc) => dtc.code),
      stillFailing: result.comparison.changed.map((dtc) => dtc.code),
      unchanged: result.comparison.unchanged.map((dtc) => dtc.code),
    };
  }

  /** Start polling the selected signals. */
  async startLive(signalIds?: readonly string[]): Promise<void> {
    const engine = this.requireEngine();
    if (this.live) return;
    this.live = true;
    const readers = this.liveReaders(engine);
    const live = await engine.startLiveData({
      signalIds,
      intervalMs: this.options.liveIntervalMs ?? 250,
    });
    live.onRound((round) => {
      for (const decoded of round.signals) {
        const sample = engine.recorder.record(decoded);
        const view = toSampleView(sample, decoded.name);
        this.emit("sample", view);
      }
      for (const error of round.errors) {
        this.log.warn("live poll error", {
          ecu: round.ecuId,
          did: error.did,
          message: error.message,
        });
      }
    });
    void live.run(readers, engine.buildPlan(signalIds)).catch((error) => {
      this.log.error("live data run failed", { error: messageOf(error) });
      this.emit("error", { message: messageOf(error) });
    });
    this.log.info("live data started", {
      signals: signalIds?.length ?? "all",
      intervalMs: this.options.liveIntervalMs ?? 250,
    });
  }

  stopLive(): void {
    this.engine?.stopLiveData();
    this.live = false;
    this.log.info("live data stopped");
  }

  private liveReaders(
    engine: DiagnosticEngine,
  ): Array<{ ecuId: string; readRaw(did: number): Promise<Uint8Array | null> }> {
    const readers: Array<{ ecuId: string; readRaw(did: number): Promise<Uint8Array | null> }> = [];
    for (const view of this.ecus) {
      const handle = engine.handleFor(Number.parseInt(view.rxId, 16));
      if (handle) readers.push(handle.reader);
    }
    return readers;
  }

  /** Record a user marker into the measurement recording. */
  addMarker(label: string): void {
    const marker = this.engine?.recorder.addMarker(label);
    this.sessionLogger.log("marker", label);
    if (marker) this.emit("marker", toMarkerViews([marker])[0]);
  }

  /**
   * The complete recording: samples, markers and the recording start.
   *
   * The SSE stream only carries what happens from now on; the graphs need the
   * whole window to zoom, pan and select a time range (AGENTS 16).
   */
  history(limit = 50_000): HistoryView {
    const engine = this.engine;
    if (!engine) return { startedAt: Date.now(), live: this.live, samples: [], markers: [] };
    const { samples, startedAt } = engine.recorder.export();
    const capped = samples.slice(-limit);
    return {
      startedAt,
      live: this.live,
      samples: capped.map((sample) =>
        toSampleView(sample, engine.findSignal(sample.signal)?.name ?? sample.signal),
      ),
      markers: toMarkerViews(engine.recorder.markers),
    };
  }

  async analyze(): Promise<AnalysisResult> {
    const engine = this.requireEngine();
    const input: AnalysisInput = {
      mileageKm: this.session()?.mileageKm,
      signals: engine.recorder.statisticsForAll().map((stat) => ({
        signal: stat.signal,
        name: stat.name,
        ...(stat.unit ? { unit: stat.unit } : {}),
        samples: stat.samples,
        min: stat.min ?? 0,
        max: stat.max ?? 0,
        average: stat.average ?? 0,
        delta: stat.delta ?? 0,
        outOfRangeCount: stat.outOfRangeCount,
      })),
      dtcs: this.dtcs.map((dtc) => ({
        code: dtc.code,
        description: dtc.description,
        severity: dtc.severity,
        ecu: dtc.ecu,
      })),
      anomalies: engine.recorder.anomalies(),
      notes: (this.session()?.notes ?? []).map((note) => note.text),
    };
    const result = await this.analysisService.analyze({ input });
    this.emit("analysis", result);
    return result;
  }

  /** Export the recording as CSV. */
  exportCsv(): string {
    const engine = this.requireEngine();
    const { samples, markers } = engine.recorder.export();
    return SessionLogger.toCsv(samples, markers);
  }

  /** Export the raw trace as CSV — raw stays raw (AGENTS 18). */
  exportTraceCsv(): string {
    return SessionLogger.traceToCsv(this.sessionLogger.snapshot().trace);
  }

  exportJson(): string {
    const engine = this.requireEngine();
    const { samples, markers } = engine.recorder.export();
    const snapshot = this.sessionLogger.snapshot();
    return SessionLogger.toJson({
      meta: {
        sessionId: this.session()?.id ?? "unknown",
        vin: this.session()?.vehicle?.vin,
        mode: this.mode,
        adapter: this.selection.id,
        adapterConfig: this.selection.config,
      },
      samples,
      markers,
      dtcs: this.allDtcRecords(),
      trace: snapshot.trace,
      log: snapshot.log,
    });
  }

  private allDtcRecords(): DtcRecord[] {
    return (this.session()?.ecus ?? []).flatMap((ecu) => ecu.dtcs ?? []);
  }

  state(): AppState {
    const engine = this.engine;
    const session = this.session();
    const identity = session?.vehicle;
    const trace = this.sessionLogger.snapshot().trace.slice(-200);
    return {
      connected: this.connected,
      mode: this.mode,
      sessionId: session?.id ?? "not-started",
      ...(identity?.vin ? { vin: identity.vin } : {}),
      vehicle: describe(identity),
      ...(session?.mileageKm !== undefined ? { mileageKm: session.mileageKm } : {}),
      adapter: session
        ? {
            id: session.adapter.id,
            name: session.adapter.name,
            kind: session.adapter.kind,
            channels: session.adapter.channels,
          }
        : { id: "none", name: "not connected", kind: "none", channels: [] },
      adapterSelection: this.selection,
      ...(this.probe ? { adapterProbe: this.probe } : {}),
      transport: session
        ? {
            kind: session.transport.kind,
            channel: session.transport.channel,
            mtu: session.transport.mtu,
          }
        : { kind: "none", channel: "-", mtu: 0 },
      ecus: this.ecus,
      dtcs: this.dtcs,
      samples: this.recentSamples(engine),
      statistics: engine ? engine.recorder.statisticsForAll() : [],
      trace: trace.map(toTraceView),
      live: this.live,
      signals: this.signalList(engine),
      anomalies: engine ? engine.recorder.anomalies() : [],
      actions: (session?.actions ?? []).map((action) => ({
        timestamp: action.timestamp,
        kind: action.kind,
        ecuId: action.ecuId,
        description: action.description,
        result: action.result,
      })),
    };
  }

  private recentSamples(engine: DiagnosticEngine | undefined): SampleView[] {
    if (!engine) return [];
    const { samples } = engine.recorder.export();
    // A recorded sample carries only the signal id; the human readable name comes
    // from the definition so the snapshot and the live stream agree.
    return samples
      .slice(-200)
      .map((sample) =>
        toSampleView(sample, engine.findSignal(sample.signal)?.name ?? sample.signal),
      );
  }

  private signalList(engine: DiagnosticEngine | undefined): AppState["signals"] {
    if (!engine) return [];
    const seen = new Set<string>();
    const list: AppState["signals"] = [];
    for (const signals of engine.buildPlan().values()) {
      for (const signal of signals) {
        if (seen.has(signal.id)) continue;
        seen.add(signal.id);
        list.push({
          id: signal.id,
          name: signal.name,
          ...(signal.unit ? { unit: signal.unit } : {}),
          critical: signal.critical ?? false,
        });
      }
    }
    return list;
  }

  /**
   * The underlying session record. Exposed because the report builder consumes a
   * VehicleSessionData (AGENTS 21) — the UI itself never needs it.
   */
  sessionData(): VehicleSessionData {
    const session = this.engine?.vehicleSession?.data;
    if (!session) throw new Error("backend not started — call start() first");
    return session;
  }

  private session() {
    return this.engine?.vehicleSession?.data;
  }

  private toEcuView(rxId: number): EcuView {
    const engine = this.engine;
    const record = engine?.vehicleSession?.data.ecus.find((ecu) => ecu.rxId === rxId);
    const discovered = engine?.handleFor(rxId)?.discovered;
    return {
      id: record?.id ?? `ecu_0x${rxId.toString(16)}`,
      name: record?.name ?? `ECU 0x${rxId.toString(16)}`,
      txId: `0x${(discovered?.txId ?? 0).toString(16).toUpperCase()}`,
      rxId: `0x${rxId.toString(16).toUpperCase()}`,
      extended: discovered?.extended ?? false,
      reachable: record?.reachable ?? false,
      identification: (record?.identification ?? []).map((entry) => ({
        label: entry.label,
        value: entry.value,
      })),
      services: (record?.supportedServices ?? []).map(
        (sid) => `0x${sid.toString(16).toUpperCase()}`,
      ),
      sessionType: record?.sessionType ?? 0,
      p2Ms: record?.timing.p2Ms ?? 0,
      dtcCount: record?.dtcs?.length ?? 0,
      ...(record?.lastError ? { lastError: record.lastError } : {}),
    };
  }

  private requireEngine(): DiagnosticEngine {
    if (!this.engine) throw new Error("backend not started — call start() first");
    return this.engine;
  }

  /** Close the transport and reset the session state; safe to call twice. */
  async stop(): Promise<void> {
    await this.teardown();
    this.log.info("backend stopped", { mode: this.mode });
  }
}

function toFreezeFrameView(frame: FreezeFrame): FreezeFrameView {
  return {
    code: frame.dtcCode,
    recordNumber: frame.recordNumber,
    documented: frame.documented,
    notes: frame.notes,
    unassignedHex: frame.unassignedHex,
    fields: frame.fields.map((field) => ({
      did: `0x${field.did.toString(16).toUpperCase()}`,
      name: field.name,
      rawHex: field.rawHex,
      values: field.values.map((value) => ({
        signal: value.signalId,
        name: value.name,
        value: formatValue(value.value),
        ...(value.unit ? { unit: value.unit } : {}),
        rawHex: value.rawHex,
        outOfRange: value.outOfRange,
      })),
    })),
  };
}

function toSampleView(sample: MeasurementSample, name: string): SampleView {
  return {
    signal: sample.signal,
    name,
    value: formatValue(sample.value),
    numeric:
      typeof sample.value === "number" && Number.isFinite(sample.value) ? sample.value : null,
    rawValue: sample.rawValue,
    rawHex: sample.rawHex,
    ...(sample.unit ? { unit: sample.unit } : {}),
    outOfRange: sample.outOfRange,
    t: sample.t,
    timestamp: sample.timestamp,
  };
}

function toMarkerViews(markers: readonly Marker[]): MarkerView[] {
  return markers.map((marker) => ({
    id: marker.id,
    t: marker.t,
    timestamp: marker.timestamp,
    label: marker.label,
    kind: marker.kind,
    ...(marker.detail ? { detail: marker.detail } : {}),
  }));
}

function toTraceView(entry: RawTraceEntry): TraceView {
  return {
    t: entry.t,
    timestamp: entry.timestamp,
    canId: entry.canIdHex,
    direction: entry.direction,
    dlc: entry.dlc,
    data: entry.payloadHex,
    channel: entry.channel,
    extended: entry.extended,
  };
}

/** CAN identifier as it is displayed and sent back by the UI (e.g. `0x7E8`). */
function formatCanId(id: number): string {
  return `0x${id.toString(16).toUpperCase()}`;
}

function toDtcView(dtc: EnrichedDtc, ecuName: string, rxId: string): DtcView {
  return {
    code: dtc.code,
    raw: dtc.raw,
    rxId,
    // A code without a definition stays honest: the raw failure type is shown
    // instead of an invented description (AGENTS 24).
    description: dtc.description ?? `Fehlertyp 0x${dtc.failureType}`,
    severity: dtc.severity,
    ...(dtc.hint ? { hint: dtc.hint } : {}),
    ecu: ecuName,
    status: `0x${dtc.status.toString(16).toUpperCase().padStart(2, "0")}`,
    confirmed: dtc.statusBits.confirmedDtc,
    pending: dtc.statusBits.pendingDtc,
    testFailed: dtc.statusBits.testFailed,
    ...(dtc.firstSeen ? { firstSeen: dtc.firstSeen } : {}),
    ...(dtc.lastSeen ? { lastSeen: dtc.lastSeen } : {}),
    ...(dtc.firstSeenInThisScan ? { isNew: true } : {}),
    ...(dtc.relatedSignals ? { relatedSignals: dtc.relatedSignals } : {}),
    freezeFrame: (dtc.snapshot?.length ?? 0) > 0,
  };
}

function formatValue(value: number | string | boolean): string {
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return String(value);
}

function describe(
  identity: { brand?: string; model?: string; modelYear?: number } | undefined,
): string {
  if (!identity) return "unknown vehicle";
  const parts = [identity.brand, identity.model, identity.modelYear].filter(
    (part): part is string | number => Boolean(part),
  );
  return parts.length > 0 ? parts.join(" ") : "unknown vehicle";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Which transport source a selection implies (AGENTS 4, 29, 32). */
function modeForSelection(selection: AdapterSelection, catalog: AdapterCatalog): BackendMode {
  if (selection.id === SIMULATOR_ADAPTER_ID) return "simulator";
  if (selection.id === REPLAY_ADAPTER_ID) return "replay";
  // An unknown id stays "hardware": the catalog rejects it with a clear message
  // when the bus is opened instead of silently falling back to the simulator.
  void catalog;
  return "hardware";
}

/** Hex text (space separated or continuous) back into bytes. */
function hexToBytes(hex: string): Uint8Array {
  const compact = hex.replace(/[^0-9a-fA-F]/g, "");
  const bytes = new Uint8Array(Math.floor(compact.length / 2));
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(compact.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export type { DecodedSignal };
