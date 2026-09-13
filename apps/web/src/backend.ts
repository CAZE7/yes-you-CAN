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
  type ConnectVehicleOptions,
  addMarker,
  clearDtcs,
  connectVehicle,
  getDtcClearPrecheck,
  getMarkers,
  identifyEcus,
  readDtcFreezeFrame,
  readDtcs,
  resolveVehicle,
  startMeasurements,
} from "@vdp/application";
import { type DefinitionPackage, genericPackage, simulatorPackage } from "@vdp/definitions";
import type {
  DtcClearPrecheckInfo,
  DtcInfo,
  EcuSummary,
  FreezeFrameInfo,
  MarkerInfo,
  MeasurementReading,
  VehicleResolutionRef,
} from "@vdp/domain";
import type { DtcRecord } from "@vdp/protocols-uds";
import { type DiagnosticRuntime, createDiagnosticRuntime } from "@vdp/runtime";
import {
  AdapterUnsupportedError,
  type Logger,
  TransportError,
  createLogger,
  messageOf,
} from "@vdp/shared";
import { DEFAULT_VIN, VirtualVehicle } from "@vdp/simulators";
import {
  FileSystemSessionRepository,
  type RawTraceEntry,
  SessionLogger,
  type SessionRepository,
  type StoredSessionSummary,
  type VehicleSessionData,
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
import { type VehicleResolutionView, toVehicleResolutionView } from "./vehicle-view.js";

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
  /**
   * Why the safety chain refused (only present when {@link cleared} is false):
   * a rejection is an answer with reasons, not an HTTP error (AGENTS 26,
   * ADR 0018).
   */
  reasons?: string[];
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

/**
 * Window statistics of one recorded signal as the UI consumes them
 * (AGENTS 16 "Min/Max/Durchschnitt/Delta"). Domain-shaped — the web app
 * stays free of core imports (storage/persistence seam, roadmap steps 10–13).
 */
export interface SignalStatisticsView {
  signal: string;
  name: string;
  unit?: string;
  samples: number;
  min: number | null;
  max: number | null;
  average: number | null;
  delta: number | null;
  first: number | null;
  last: number | null;
  outOfRangeCount: number;
}

export interface AppState {
  connected: boolean;
  /** Which transport source is selected (AGENTS 4, 29, 32). */
  mode: BackendMode;
  sessionId: string;
  vin?: string;
  vehicle: string;
  /**
   * Last vehicle resolution (AGENTS 11) — the hypotheses with their evidence.
   * Absent until something was resolved; never a guess about the identity.
   */
  vehicleResolution?: VehicleResolutionView;
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
  statistics: SignalStatisticsView[];
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
  type:
    | "sample"
    | "trace"
    | "dtc"
    | "ecu"
    | "analysis"
    | "error"
    | "marker"
    | "markers"
    | "vehicle";
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
  /**
   * Discovery timing for {@link DemoBackend.start}. When omitted the backend
   * picks per mode — see {@link SIMULATOR_DISCOVERY}.
   */
  discovery?: ConnectVehicleOptions;
}

const _MAX_TRACE = 800;

/**
 * Discovery timing while the simulator is the transport.
 *
 * `VirtualCanNetwork` dispatches in-process and without latency unless
 * `latencyMs` is configured, so the core default (1200 ms listen window plus
 * 15 ms per candidate) is dead time before the first ECU is visible. Measured
 * 2026-09-12 on Node 22: `DemoBackend.start()` against the simulator took
 * 1413.5 ms with the core default and 69.1 ms with this budget — same result
 * (`connected: true`, 3 ECUs) — and every integration test used to pay the
 * slow variant once per start. Replay and hardware keep the core default:
 * there the window is what makes late responders visible at all (AGENTS 12).
 */
const SIMULATOR_DISCOVERY: ConnectVehicleOptions = { windowMs: 40, probeDelayMs: 0 };

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
  /**
   * The headless diagnostic runtime (ADR 0014): the backend owns transport and
   * presentation only — every vehicle operation goes through the command/query
   * bus, never through the engine below it.
   */
  private runtime?: DiagnosticRuntime;
  private selection: AdapterSelection;
  private mode: BackendMode;
  private probe?: AdapterProbe;
  private readonly sessionLogger = new SessionLogger();
  private readonly listeners = new Set<(event: BackendEvent) => void>();
  private unsubscribeBus?: () => void;
  private unsubscribeSamples?: () => void;
  private unsubscribeEvents?: () => void;
  private ecus: EcuView[] = [];
  private dtcs: DtcView[] = [];
  private live = false;
  private connected = false;
  private readonly vin: string;
  private definitions: readonly DefinitionPackage[];
  private resolution?: VehicleResolutionView;
  private readonly repository?: SessionRepository;
  /**
   * Turns raw protocol codes into described fault entries. Descriptions come
   * from definition packages only — a code nobody documented stays undescribed
   * instead of being guessed (AGENTS 13, 20, 24).
   */

  constructor(private readonly options: BackendOptions = {}) {
    this.log = (options.logger ?? createLogger("web", { level: "INFO" })).child("backend");
    this.vin = options.vin ?? DEFAULT_VIN;
    this.analysisService = new AnalysisService({
      providers: [new HeuristicAnalysisProvider()],
      logger: this.log,
    });
    this.adapters = options.adapters ?? createWebAdapterCatalog();
    this.selection = options.selection ?? { id: SIMULATOR_ADAPTER_ID, config: {} };
    this.mode = modeForSelection(this.selection, this.adapters);
    this.definitions = options.definitions ?? defaultDefinitionsFor(this.mode);
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
    // Which definitions describe the bus changes with the source: the simulated
    // car answers with simulated identification values, a real one does not.
    this.definitions = this.options.definitions ?? defaultDefinitionsFor(this.mode);
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
    const runtime = this.requireRuntime();
    const data = runtime.session.data();
    if (!data) throw new Error("no session to save — call start() first");
    if (!this.repository) return { id: data.id, repository: false };

    await this.repository.save(data);
    const { samples } = runtime.measurements.rawExport();
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

  /**
   * Discovery timing for this start: explicit option wins, otherwise the
   * simulator gets a short window and every real transport keeps the default.
   */
  private discoveryTiming(): ConnectVehicleOptions {
    if (this.options.discovery) return this.options.discovery;
    return this.mode === "simulator" ? SIMULATOR_DISCOVERY : {};
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

      this.runtime = createDiagnosticRuntime({
        bus,
        definitions: this.definitions,
        logger: this.log,
      });
      // Runtime failures that belong to the operator (a crashed poll loop)
      // travel as domain events; the SSE stream forwards them (AGENTS 34.25).
      this.unsubscribeEvents = this.runtime.events.subscribe("diagnostic-error", (payload) => {
        this.emit("error", { message: payload.message });
      });
      const result = await this.runtime.commands.dispatch(connectVehicle(this.discoveryTiming()));
      this.connected = true;
      this.ecus = result.ecus.map((summary) => toEcuView(summary));
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
      definitions: this.definitions[0] ?? simulatorPackage,
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
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = undefined;
    // dispose() disconnects an open session and otherwise closes a bus a
    // failed connect left open — no half-open transport survives (AGENTS 5).
    await this.runtime?.dispose().catch((error: unknown) => {
      this.log.warn("runtime dispose failed", { error: messageOf(error) });
    });
    this.runtime = undefined;
    await this.vehicle?.stop().catch((error: unknown) => {
      this.log.warn("simulator stop failed", { error: messageOf(error) });
    });
    this.vehicle = undefined;
    this.bus = undefined;
    this.connected = false;
    this.ecus = [];
    this.dtcs = [];
    this.resolution = undefined;
  }

  /** Read identification DIDs from every discovered ECU (read-only, AGENTS 34.11). */
  async identify(): Promise<EcuView[]> {
    const runtime = this.requireRuntime();
    const summaries = await runtime.commands.dispatch(identifyEcus());
    this.ecus = summaries.map((summary) => toEcuView(summary));
    for (const view of this.ecus) this.emit("ecu", view);
    return this.ecus;
  }

  /**
   * Which vehicle is connected (AGENTS 11).
   *
   * Read-only by construction: the runtime query weighs the VIN, the
   * identification values and the addresses that answered against the installed
   * definitions and returns ranked hypotheses. Nothing is written to the bus and
   * nothing is asserted — an empty answer is a legitimate result.
   */
  async resolveVehicle(): Promise<VehicleResolutionView> {
    const runtime = this.requireRuntime();
    const resolution: VehicleResolutionRef = await runtime.commands.query(resolveVehicle());
    this.resolution = toVehicleResolutionView(resolution);
    this.emit("vehicle", this.resolution);
    this.log.info("vehicle resolution", {
      candidates: this.resolution.candidates.length,
      best: this.resolution.best?.vehicleId,
      score: this.resolution.best?.scorePercent,
    });
    return this.resolution;
  }

  /** Read fault codes from all ECUs. */
  async scanDtcs(): Promise<DtcView[]> {
    const runtime = this.requireRuntime();
    const infos = await runtime.commands.dispatch(readDtcs());
    // The runtime already enriched the codes with the definition package
    // (description, severity, first/last seen, related signals); the backend
    // only maps them to the view shape the UI consumes (AGENTS 13/20).
    this.dtcs = infos.map((info) => this.toDtcView(info));
    for (const view of this.dtcs) this.emit("dtc", view);
    this.sessionLogger.log("dtc", "scan complete", { count: this.dtcs.length });
    this.log.info("DTC scan complete", { count: this.dtcs.length });
    // The runtime wrote one marker per fault code while scanning; publish the
    // complete list so open graphs show them without waiting for a history
    // reload.
    const markers = await runtime.commands.query(getMarkers());
    this.emit("markers", markers.map(toMarkerView));
    return this.dtcs;
  }

  /**
   * Read the freeze frame of one fault code from one ECU (AGENTS 20 "Snapshot").
   *
   * The response always carries the raw bytes as well: a snapshot whose layout no
   * definition documents is still evidence and must not be dropped.
   */
  async readFreezeFrame(rxId: number, code: string, recordNumber = 0xff): Promise<FreezeFrameView> {
    const runtime = this.requireRuntime();
    const info = await runtime.commands.dispatch(
      readDtcFreezeFrame(this.ecuRef(rxId), code, recordNumber),
    );
    this.sessionLogger.log("dtc", `freeze frame ${code}`, {
      ecu: formatCanId(rxId),
      documented: info.documented,
    });
    return toFreezeFrameView(info);
  }

  /**
   * What the safety layer would require for clearing an ECU (AGENTS 26).
   * The UI asks this before showing the confirmation so the operator sees the
   * missing preconditions instead of a refusal afterwards.
   */
  async precheckDtcClear(rxId: number, vehicleState: VehicleStateView): Promise<DtcClearPrecheck> {
    const runtime = this.requireRuntime();
    // The runtime evaluates with `userConfirmed: false`: the precheck lists
    // everything that still has to happen, including the confirmation itself.
    const info: DtcClearPrecheckInfo = await runtime.commands.query(
      getDtcClearPrecheck(this.ecuRef(rxId), vehicleState),
    );
    return {
      rxId: formatCanId(rxId),
      ecu: info.ecuName,
      ok: info.ok,
      failed: [...info.failed],
      warnings: [...info.warnings],
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
    const runtime = this.requireRuntime();
    const outcome = await runtime.commands.dispatch(
      clearDtcs(this.ecuRef(rxId), request.confirmed, request.vehicleState),
    );
    // The table has to reflect the new state, not the pre-clear one.
    await this.scanDtcs();
    const marker = await runtime.commands.dispatch(
      addMarker(
        `Fehlerspeicher ${outcome.ecuName} gelöscht`,
        "action",
        outcome.verified ? "verifiziert" : "nicht bestätigt",
      ),
    );
    this.emit("marker", toMarkerView(marker));
    this.log.info("fault memory cleared", {
      ecu: outcome.ecuName,
      removed: outcome.removedCodes.length,
      verified: outcome.verified,
    });
    return {
      ecu: outcome.ecuName,
      cleared: outcome.ok,
      verified: outcome.verified,
      before: [...outcome.beforeCodes],
      after: [...outcome.afterCodes],
      removed: [...outcome.removedCodes],
      stillFailing: [...outcome.stillFailingCodes],
      unchanged: [...outcome.unchangedCodes],
      ...(outcome.ok ? {} : { reasons: [...outcome.reasons] }),
    };
  }

  /**
   * Start polling the selected signals.
   *
   * The runtime records every sample exactly once inside the poll loop; the
   * backend subscribes to the recorded rounds and forwards them to the UI.
   * (The old engine-level path recorded twice and started the loop twice —
   * both are gone with the move behind the command bus, AGENTS 16/34.25.)
   */
  async startLive(signalIds?: readonly string[]): Promise<void> {
    const runtime = this.requireRuntime();
    if (this.live) return;
    this.live = true;
    // Subscribe before the start command: the service buffers listeners until
    // the poll loop exists, so no round of this run can be missed.
    this.unsubscribeSamples = runtime.measurements.onSample((round) => {
      for (const reading of round.readings) this.emit("sample", toSampleView(reading));
    });
    await runtime.commands.dispatch(
      startMeasurements(signalIds, this.options.liveIntervalMs ?? 250),
    );
    this.log.info("live data started", {
      signals: signalIds?.length ?? "all",
      intervalMs: this.options.liveIntervalMs ?? 250,
    });
  }

  stopLive(): void {
    this.unsubscribeSamples?.();
    this.unsubscribeSamples = undefined;
    this.runtime?.measurements.stop();
    this.live = false;
    this.log.info("live data stopped");
  }

  /** Record a user marker into the measurement recording. */
  addMarker(label: string): void {
    this.sessionLogger.log("marker", label);
    if (!this.runtime) return;
    void this.runtime.commands
      .dispatch(addMarker(label))
      .then((marker) => this.emit("marker", toMarkerView(marker)))
      .catch((error: unknown) => this.log.warn("marker rejected", { error: messageOf(error) }));
  }

  /**
   * The complete recording: samples, markers and the recording start.
   *
   * The SSE stream only carries what happens from now on; the graphs need the
   * whole window to zoom, pan and select a time range (AGENTS 16).
   */
  history(limit = 50_000): HistoryView {
    const runtime = this.runtime;
    if (!runtime) return { startedAt: Date.now(), live: this.live, samples: [], markers: [] };
    const recording = runtime.measurements.history(limit);
    return {
      startedAt: recording.startedAt,
      live: this.live,
      samples: recording.samples.map(toSampleView),
      markers: recording.markers.map(toMarkerView),
    };
  }

  async analyze(): Promise<AnalysisResult> {
    const runtime = this.requireRuntime();
    const input: AnalysisInput = {
      mileageKm: this.session()?.mileageKm,
      signals: runtime.measurements.statistics().map((stat) => ({
        signal: stat.signalId,
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
      anomalies: runtime.measurements.anomalies().map((anomaly) => ({
        signal: anomaly.signalId,
        reason: anomaly.reason,
        ...(anomaly.value !== undefined ? { value: anomaly.value } : {}),
      })),
      notes: (this.session()?.notes ?? []).map((note) => note.text),
    };
    const result = await this.analysisService.analyze({ input });
    this.emit("analysis", result);
    return result;
  }

  /** Export the recording as CSV. */
  exportCsv(): string {
    const runtime = this.requireRuntime();
    const { samples, markers } = runtime.measurements.rawExport();
    return SessionLogger.toCsv(samples, markers);
  }

  /** Export the raw trace as CSV — raw stays raw (AGENTS 18). */
  exportTraceCsv(): string {
    return SessionLogger.traceToCsv(this.sessionLogger.snapshot().trace);
  }

  exportJson(): string {
    const runtime = this.requireRuntime();
    const { samples, markers } = runtime.measurements.rawExport();
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
    const runtime = this.runtime;
    const session = this.session();
    const identity = session?.vehicle;
    const trace = this.sessionLogger.snapshot().trace.slice(-200);
    return {
      connected: this.connected,
      mode: this.mode,
      sessionId: session?.id ?? "not-started",
      ...(identity?.vin ? { vin: identity.vin } : {}),
      vehicle: describe(identity),
      ...(this.resolution ? { vehicleResolution: this.resolution } : {}),
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
      samples: this.recentSamples(),
      statistics: runtime
        ? runtime.measurements.statistics().map((stat) => ({
            signal: stat.signalId,
            name: stat.name,
            ...(stat.unit !== undefined ? { unit: stat.unit } : {}),
            samples: stat.samples,
            min: stat.min,
            max: stat.max,
            average: stat.average,
            delta: stat.delta,
            first: stat.first,
            last: stat.last,
            outOfRangeCount: stat.outOfRangeCount,
          }))
        : [],
      trace: trace.map(toTraceView),
      live: this.live,
      signals: runtime
        ? runtime.measurements.signals().map((signal) => ({
            id: signal.signalId,
            name: signal.name,
            ...(signal.unit ? { unit: signal.unit } : {}),
            critical: signal.critical,
          }))
        : [],
      anomalies: runtime
        ? runtime.measurements.anomalies().map((anomaly) => ({
            signal: anomaly.signalId,
            reason: anomaly.reason,
            ...(anomaly.value !== undefined ? { value: anomaly.value } : {}),
          }))
        : [],
      actions: (session?.actions ?? []).map((action) => ({
        timestamp: action.timestamp,
        kind: action.kind,
        ecuId: action.ecuId,
        description: action.description,
        result: action.result,
      })),
    };
  }

  private recentSamples(): SampleView[] {
    const runtime = this.runtime;
    if (!runtime) return [];
    // A recorded sample carries only the signal id; the runtime resolves the
    // human readable name from the definition so snapshot and live stream agree.
    return runtime.measurements.history(200).samples.map(toSampleView);
  }

  /**
   * The underlying session record. Exposed because the report builder consumes a
   * VehicleSessionData (AGENTS 21) — the UI itself never needs it.
   */
  sessionData(): VehicleSessionData {
    const session = this.runtime?.session.data();
    if (!session) throw new Error("backend not started — call start() first");
    return session;
  }

  private session() {
    return this.runtime?.session.data();
  }

  /** DTC table row from the runtime read model (AGENTS 13/20). */
  private toDtcView(info: DtcInfo): DtcView {
    const ecu = this.ecus.find((view) => view.id === info.ecuId);
    return {
      code: info.code,
      raw: info.raw,
      rxId: ecu?.rxId ?? info.ecuId,
      // A code without a definition stays honest: the raw failure type is shown
      // instead of an invented description (AGENTS 24).
      description: info.description ?? `Fehlertyp 0x${info.failureType}`,
      severity: info.severity ?? "info",
      ...(info.hint ? { hint: info.hint } : {}),
      ecu: info.ecuName,
      status: `0x${info.status.toString(16).toUpperCase().padStart(2, "0")}`,
      confirmed: info.confirmed,
      pending: info.pending,
      testFailed: info.testFailed,
      ...(info.firstSeen ? { firstSeen: info.firstSeen } : {}),
      ...(info.lastSeen ? { lastSeen: info.lastSeen } : {}),
      ...(info.firstSeenInThisScan ? { isNew: true } : {}),
      ...(info.relatedSignals ? { relatedSignals: [...info.relatedSignals] } : {}),
      freezeFrame: info.hasFreezeFrame,
    };
  }

  /** ECU reference as the runtime understands it: session id or "0x…" address. */
  private ecuRef(rxId: number): string {
    return `0x${rxId.toString(16)}`;
  }

  private requireRuntime(): DiagnosticRuntime {
    if (!this.runtime) throw new Error("backend not started — call start() first");
    return this.runtime;
  }

  /** Close the transport and reset the session state; safe to call twice. */
  async stop(): Promise<void> {
    await this.teardown();
    this.log.info("backend stopped", { mode: this.mode });
  }
}

function toEcuView(summary: EcuSummary): EcuView {
  return {
    id: summary.ecuId,
    name: summary.name,
    txId: formatCanId(summary.txId),
    rxId: formatCanId(summary.rxId),
    extended: summary.extended,
    reachable: summary.reachable,
    identification: summary.identification.map((entry) => ({
      label: entry.label,
      value: entry.value,
    })),
    services: summary.supportedServices.map((sid) => `0x${sid.toString(16).toUpperCase()}`),
    sessionType: summary.sessionType,
    p2Ms: summary.p2Ms,
    dtcCount: summary.dtcCount,
    ...(summary.lastError ? { lastError: summary.lastError } : {}),
  };
}

function toFreezeFrameView(info: FreezeFrameInfo): FreezeFrameView {
  return {
    code: info.code,
    recordNumber: info.recordNumber,
    documented: info.documented,
    notes: [...info.notes],
    unassignedHex: info.unassignedHex,
    fields: info.fields.map((field) => ({
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

function toSampleView(reading: MeasurementReading): SampleView {
  return {
    signal: reading.signalId,
    name: reading.name ?? reading.signalId,
    value: formatValue(reading.value),
    numeric:
      typeof reading.value === "number" && Number.isFinite(reading.value) ? reading.value : null,
    rawValue: reading.rawValue,
    rawHex: reading.rawHex,
    ...(reading.unit ? { unit: reading.unit } : {}),
    outOfRange: reading.outOfRange,
    t: reading.t,
    timestamp: reading.timestamp,
  };
}

function toMarkerView(marker: MarkerInfo): MarkerView {
  return {
    id: marker.markerId,
    t: marker.t,
    timestamp: marker.timestamp,
    label: marker.label,
    kind: marker.kind,
    ...(marker.detail ? { detail: marker.detail } : {}),
  };
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

/** Which transport source a selection implies (AGENTS 4, 29, 32). */
/**
 * Which definition packages the demo runs on.
 *
 * A simulated or replayed session gets `simulatorPackage`: genericPackage's ECUs,
 * signals and fault codes plus the vehicle definition that makes the virtual car
 * resolvable at all. A real adapter keeps the OEM-neutral baseline — describing a
 * customer's car with the simulator's identification values would be exactly the
 * kind of invented vehicle truth AGENTS 24 forbids.
 */
function defaultDefinitionsFor(mode: BackendMode): readonly DefinitionPackage[] {
  return mode === "hardware" ? [genericPackage] : [simulatorPackage];
}

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
