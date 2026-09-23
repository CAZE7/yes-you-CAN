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
  ANALYSIS_PROMPT_VERSION,
  type AnalysisResult,
  AnalysisService,
  HeuristicAnalysisProvider,
} from "@vdp/ai";
import {
  addMarker,
  type ConnectVehicleOptions,
  clearDtcs,
  connectVehicle,
  getDtcClearPrecheck,
  getDtcScanGaps,
  getMarkers,
  identifyEcus,
  readDtcFreezeFrame,
  readDtcs,
  resolveVehicle,
  startMeasurements,
} from "@vdp/application";
import {
  type DefinitionPackage,
  genericPackage,
  highFidelityPackage,
  simulatorPackage,
} from "@vdp/definitions";
import type { DiagnosisTransition, GuidedDiagnosisState } from "@vdp/diagnostic-ir";
import type { DtcClearPrecheckInfo, VehicleResolutionRef } from "@vdp/domain";
import type { DtcRecord } from "@vdp/protocols-uds";
import {
  createDiagnosticRuntime,
  type DiagnosticRuntime,
  PLATFORM_VERSION,
  type WriteBinding,
} from "@vdp/runtime";
import {
  AdapterUnsupportedError,
  createLogger,
  type Logger,
  messageOf,
  TransportClosedError,
  TransportError,
} from "@vdp/shared";
import {
  CanChaosBus,
  ChaosLab,
  DEFAULT_VIN,
  HighFidelityVehicle,
  VirtualVehicle,
} from "@vdp/simulators";
import {
  createNodeManifestSigner,
  FileSystemSessionRepository,
  type ManifestSigner,
  nodeIntegrityPort,
  type RawTraceManifest,
  SessionLogger,
  type SessionRepository,
  type StoredSessionSummary,
  signRawTraceManifest,
  traceIdFromManifest,
  type VehicleSessionData,
} from "@vdp/storage";
import {
  type CanBus,
  type ReplayRecording,
  ReplayTransport,
  recordingFromSessionJson,
} from "@vdp/transport-can";
import {
  createWebAdapterCatalog,
  isApplicationManaged,
  REPLAY_ADAPTER_ID,
  SIMULATOR_5ECU_ADAPTER_ID,
  SIMULATOR_ADAPTER_ID,
} from "./adapters.js";
import type {
  AdaptationResultView,
  AdvancedSignalAnalysisView,
  AppState,
  BackendEvent,
  BackendMode,
  ChaosStatusView,
  CodingResultView,
  DtcClearPrecheck,
  DtcClearView,
  DtcView,
  EcuView,
  FreezeFrameView,
  GuidedDiagnosisView,
  HistoryView,
  SampleView,
  VehicleResolutionView,
  VehicleStateView,
} from "./views.js";

/**
 * The wire contract (AGENTS 16) lives in `views.ts` — node-free, so the browser
 * project can be checked against it. Re-exported here so the backend, its tests
 * and the front end keep importing from one place.
 */
export type {
  AppState,
  BackendEvent,
  BackendMode,
  DtcClearPrecheck,
  DtcClearView,
  DtcView,
  EcuView,
  FreezeFrameView,
  HistoryView,
  MarkerView,
  SampleView,
  SignalStatisticsView,
  TraceView,
  VehicleStateView,
} from "./views.js";

import { buildAnalysisInput } from "./analysis-input.js";
import { toDtcView, toUnreadEcuView, type UnreadEcuView } from "./dtc-view.js";
import { toEcuView, toFreezeFrameView } from "./ecu-view.js";
import { loadScenarioCatalog } from "./scenario-source.js";
import {
  type ScenarioCatalogView,
  type ScenarioPanelView,
  type ScenarioRunView,
  toScenarioCatalogView,
  toScenarioPanelView,
  toScenarioRunView,
} from "./scenario-view.js";
import { formatCanId, toMarkerView, toSampleView, toTraceView } from "./trace-view.js";
import { toVehicleResolutionView } from "./vehicle-view.js";

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
  /** Signer for export and session trace manifests (ADR 0057). */
  manifestSigner?: ManifestSigner;
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

export class DemoBackend {
  readonly log: Logger;
  readonly analysisService: AnalysisService;
  readonly adapters: AdapterCatalog;
  private vehicle: VirtualVehicle | undefined;
  private hfVehicle: HighFidelityVehicle | undefined;
  private chaosBus: CanChaosBus | undefined;
  private bus: CanBus | undefined;
  /**
   * The headless diagnostic runtime (ADR 0014): the backend owns transport and
   * presentation only — every vehicle operation goes through the command/query
   * bus, never through the engine below it.
   */
  private runtime: DiagnosticRuntime | undefined;
  private selection: AdapterSelection;
  private mode: BackendMode;
  private probe: AdapterProbe | undefined;
  /**
   * The raw trace and its witness (ADR 0047): the workbench runs on Node, so it
   * injects the persistence layer's `node:crypto` port — the core itself stays free of
   * platform crypto and refuses a manifest it cannot compute.
   */
  private readonly sessionLogger = new SessionLogger({ integrity: nodeIntegrityPort });
  private readonly manifestSigner: ManifestSigner;
  private readonly listeners = new Set<(event: BackendEvent) => void>();
  private unsubscribeBus: (() => void) | undefined;
  private unsubscribeSamples: (() => void) | undefined;
  private unsubscribeEvents: (() => void) | undefined;
  private ecus: EcuView[] = [];
  private dtcs: DtcView[] = [];
  /** Modules the last full scan could not read (ADR 0049) — the scan's other half. */
  private unreadEcus: UnreadEcuView[] = [];
  private live = false;
  private connected = false;
  private readonly vin: string;
  private definitions: readonly DefinitionPackage[];
  private resolution: VehicleResolutionView | undefined;
  private readonly repository?: SessionRepository;
  private guidedDiagnosisSteps = 0;
  private chaosDropRate = 0;
  private chaosDropBurst = 0;
  /** The id the last armed burst was aimed at; `undefined` is the bus-wide form. */
  private chaosDropBurstCanId: number | undefined;
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
    this.definitions = options.definitions ?? defaultDefinitionsFor(this.mode, this.selection.id);
    this.manifestSigner = options.manifestSigner ?? createNodeManifestSigner({ logger: this.log });
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
    this.definitions = this.options.definitions ?? defaultDefinitionsFor(this.mode, selection.id);
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

    data.platformVersion = PLATFORM_VERSION;
    if (this.lastScenario?.title && this.lastScenario.seed !== undefined) {
      data.scenario = {
        id: this.lastScenario.id,
        title: this.lastScenario.title,
        seed: this.lastScenario.seed,
      };
    }
    const manifest = this.signedManifest();
    if (manifest) {
      data.traceId = traceIdFromManifest(manifest);
    }

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
      const inner = await this.openBus();
      // Chaos belongs *in* the path, not beside it (0.E E24): this wrapper is the bus the
      // runtime and the raw-trace recorder see, so a switch thrown after `start` changes
      // what the session experiences instead of counting what a bystander watched. With no
      // rule armed it is a pass-through — one call per frame, no behaviour of its own.
      this.chaosBus = new CanChaosBus(inner);
      const bus = this.chaosBus;
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
      if (this.selection.id === SIMULATOR_5ECU_ADAPTER_ID) {
        this.hfVehicle = new HighFidelityVehicle({ vin: this.vin, logger: this.log });
        await this.hfVehicle.start();
        return this.hfVehicle.testerBus;
      }
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
    await this.hfVehicle?.stop().catch((error: unknown) => {
      this.log.warn("high-fidelity simulator stop failed", { error: messageOf(error) });
    });
    this.hfVehicle = undefined;
    this.chaosBus = undefined;
    this.bus = undefined;
    this.connected = false;
    this.ecus = [];
    this.dtcs = [];
    this.unreadEcus = [];
    this.resolution = undefined;
    this.guidedDiagnosisSteps = 0;
    this.chaosDropRate = 0;
    this.chaosDropBurst = 0;
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

  /**
   * Read fault codes from all ECUs.
   *
   * Both halves of the scan come back (ADR 0049): the codes that were read, and
   * the modules that did not answer. An empty list on its own is not the answer to
   * "is the car free of faults" — it is the answer over the modules that answered,
   * and the panel has to be able to say which ones stayed silent.
   */
  async scanDtcs(): Promise<{ dtcs: DtcView[]; unread: UnreadEcuView[] }> {
    const runtime = this.requireRuntime();
    const infos = await runtime.commands.dispatch(readDtcs());
    // The runtime already enriched the codes with the definition package
    // (description, severity, first/last seen, related signals); the backend
    // only maps them to the view shape the UI consumes (AGENTS 13/20).
    this.dtcs = infos.map((info) => toDtcView(info, this.ecus));
    const gaps = await runtime.commands.query(getDtcScanGaps());
    this.unreadEcus = gaps.map(toUnreadEcuView);
    for (const view of this.dtcs) this.emit("dtc", view);
    this.sessionLogger.log("dtc", "scan complete", {
      count: this.dtcs.length,
      unread: this.unreadEcus.length,
    });
    this.log.info("DTC scan complete", {
      count: this.dtcs.length,
      unread: this.unreadEcus.length,
    });
    // The runtime wrote one marker per fault code while scanning; publish the
    // complete list so open graphs show them without waiting for a history
    // reload.
    const markers = await runtime.commands.query(getMarkers());
    this.emit("markers", markers.map(toMarkerView));
    return { dtcs: this.dtcs, unread: this.unreadEcus };
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
      unproven: [...info.unproven],
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
   * Evaluates the current session through the Guided Diagnosis Engine (Task 6).
   * Ranks hypotheses and recommends the next discriminating test.
   *
   * With a step measurement this is one loop step (ADR 0056): the measurement
   * is recorded, the evidence and hypotheses are re-judged, and the view
   * carries the named diff (`changes`) — which outcome moved where, which
   * evidence appeared. The panel can then say "this measurement did X"
   * instead of "something changed".
   */
  async guidedDiagnosis(stepMeasurement?: {
    signalId: string;
    value: number;
  }): Promise<GuidedDiagnosisView> {
    const runtime = this.requireRuntime();
    let changes: readonly DiagnosisTransition[] | undefined;
    let state: GuidedDiagnosisState;
    if (stepMeasurement) {
      this.guidedDiagnosisSteps += 1;
      const step = runtime.evidence.advanceDiagnosis(
        stepMeasurement.signalId,
        stepMeasurement.value,
        this.guidedDiagnosisSteps - 1,
      );
      state = step.after;
      changes = step.changes;
      const marker = await runtime.commands.dispatch(
        addMarker(`Prüfschritt: ${stepMeasurement.signalId}=${stepMeasurement.value}`, "action"),
      );
      this.emit("marker", toMarkerView(marker));
    } else {
      state = runtime.evidence.guidedDiagnosis(this.guidedDiagnosisSteps);
    }
    return {
      status: state.status,
      summary: state.summary,
      stepsCompleted: state.stepsCompleted,
      hypotheses: state.hypotheses.map((h) => ({
        id: h.id,
        claim: h.claim,
        confidence: h.confidence,
        outcome: h.outcome,
        checks: h.checks.map((c) => ({
          signal: c.test.signal,
          expect: c.test.expect,
          outcome: c.outcome,
        })),
        supporting: h.supporting.map((citation) => ({
          itemId: citation.itemId,
          why: citation.why,
        })),
        against: h.against.map((citation) => ({ itemId: citation.itemId, why: citation.why })),
        ...(h.nextTest ? { nextTest: h.nextTest } : {}),
      })),
      ...(changes !== undefined && changes.length > 0 ? { changes: [...changes] } : {}),
      ...(state.nextRecommendedTest
        ? {
            nextRecommendedTest: {
              hypothesisId: state.nextRecommendedTest.hypothesisId,
              rationale: state.nextRecommendedTest.rationale,
              test: state.nextRecommendedTest.test,
              ...(state.nextRecommendedTest.discriminatesAgainst
                ? { discriminatesAgainst: [...state.nextRecommendedTest.discriminatesAgainst] }
                : {}),
              ...(state.nextRecommendedTest.uncertaintyReduction !== undefined
                ? { uncertaintyReduction: state.nextRecommendedTest.uncertaintyReduction }
                : {}),
            },
          }
        : {}),
    };
  }

  /**
   * Prechecks ECU variant coding write (Task 8).
   */
  async precheckCoding(
    rxId: number,
    did: number,
    data: string,
    vehicleState: VehicleStateView,
  ): Promise<{ ok: boolean; failed: string[]; unproven: string[]; warnings: string[] }> {
    const runtime = this.requireRuntime();
    const binding: WriteBinding = {
      ecuId: this.ecuRef(rxId),
      ecuName:
        this.ecus.find((e) => e.rxId === formatCanId(rxId))?.name ?? `ECU_${formatCanId(rxId)}`,
      vehicleState: {
        stationary: vehicleState.stationary,
        ignitionOn: vehicleState.ignitionOn,
        ...(vehicleState.parkingBrake !== undefined
          ? { parkingBrake: vehicleState.parkingBrake }
          : {}),
        ...(vehicleState.batteryVoltage !== undefined
          ? { batteryVoltage: vehicleState.batteryVoltage }
          : {}),
      },
    };
    const precheck = await runtime.writes.precheck("coding", { did, data }, binding, {
      userConfirmed: false,
    });
    return {
      ok: precheck.ok,
      failed: [...precheck.failed],
      unproven: [...precheck.unproven],
      warnings: [...precheck.warnings],
    };
  }

  /**
   * Executes ECU variant coding write (Task 8).
   */
  async writeCoding(
    rxId: number,
    did: number,
    data: string,
    confirmed: boolean,
    vehicleState: VehicleStateView,
  ): Promise<CodingResultView> {
    const runtime = this.requireRuntime();
    const ecuName =
      this.ecus.find((e) => e.rxId === formatCanId(rxId))?.name ?? `ECU_${formatCanId(rxId)}`;
    const binding: WriteBinding = {
      ecuId: this.ecuRef(rxId),
      ecuName,
      vehicleState: {
        stationary: vehicleState.stationary,
        ignitionOn: vehicleState.ignitionOn,
        ...(vehicleState.parkingBrake !== undefined
          ? { parkingBrake: vehicleState.parkingBrake }
          : {}),
        ...(vehicleState.batteryVoltage !== undefined
          ? { batteryVoltage: vehicleState.batteryVoltage }
          : {}),
      },
    };
    const result = await runtime.writes.run<unknown, unknown, unknown>(
      "coding",
      { did, data, userConfirmed: confirmed },
      binding,
    );
    const originalHex =
      result.value && typeof result.value === "object" && "originalHex" in result.value
        ? String(result.value.originalHex)
        : undefined;
    const writtenHex =
      result.value && typeof result.value === "object" && "writtenHex" in result.value
        ? String(result.value.writtenHex)
        : undefined;
    return {
      ok: result.ok,
      verified: Boolean(
        result.value &&
          typeof result.value === "object" &&
          "verified" in result.value &&
          result.value.verified,
      ),
      ecuId: binding.ecuId,
      did,
      ...(originalHex !== undefined ? { originalHex } : {}),
      ...(writtenHex !== undefined ? { writtenHex } : {}),
      reasons: [...result.reasons],
      warnings: [...result.warnings],
      transactionId: result.transaction.id,
    };
  }

  /**
   * Prechecks ECU parameter adaptation write (Task 8).
   */
  async precheckAdaptation(
    rxId: number,
    did: number,
    value: number,
    vehicleState: VehicleStateView,
  ): Promise<{ ok: boolean; failed: string[]; unproven: string[]; warnings: string[] }> {
    const runtime = this.requireRuntime();
    const binding: WriteBinding = {
      ecuId: this.ecuRef(rxId),
      ecuName:
        this.ecus.find((e) => e.rxId === formatCanId(rxId))?.name ?? `ECU_${formatCanId(rxId)}`,
      vehicleState: {
        stationary: vehicleState.stationary,
        ignitionOn: vehicleState.ignitionOn,
        ...(vehicleState.parkingBrake !== undefined
          ? { parkingBrake: vehicleState.parkingBrake }
          : {}),
        ...(vehicleState.batteryVoltage !== undefined
          ? { batteryVoltage: vehicleState.batteryVoltage }
          : {}),
      },
    };
    const precheck = await runtime.writes.precheck("adaptation", { did, value }, binding, {
      userConfirmed: false,
    });
    return {
      ok: precheck.ok,
      failed: [...precheck.failed],
      unproven: [...precheck.unproven],
      warnings: [...precheck.warnings],
    };
  }

  /**
   * Executes ECU parameter adaptation write (Task 8).
   */
  async writeAdaptation(
    rxId: number,
    did: number,
    value: number,
    confirmed: boolean,
    vehicleState: VehicleStateView,
  ): Promise<AdaptationResultView> {
    const runtime = this.requireRuntime();
    const ecuName =
      this.ecus.find((e) => e.rxId === formatCanId(rxId))?.name ?? `ECU_${formatCanId(rxId)}`;
    const binding: WriteBinding = {
      ecuId: this.ecuRef(rxId),
      ecuName,
      vehicleState: {
        stationary: vehicleState.stationary,
        ignitionOn: vehicleState.ignitionOn,
        ...(vehicleState.parkingBrake !== undefined
          ? { parkingBrake: vehicleState.parkingBrake }
          : {}),
        ...(vehicleState.batteryVoltage !== undefined
          ? { batteryVoltage: vehicleState.batteryVoltage }
          : {}),
      },
    };
    const result = await runtime.writes.run<unknown, unknown, unknown>(
      "adaptation",
      { did, value, userConfirmed: confirmed },
      binding,
    );
    const originalValue =
      result.value && typeof result.value === "object" && "originalValue" in result.value
        ? Number(result.value.originalValue)
        : undefined;
    const writtenValue =
      result.value && typeof result.value === "object" && "writtenValue" in result.value
        ? Number(result.value.writtenValue)
        : undefined;
    const unit =
      result.value && typeof result.value === "object" && "unit" in result.value
        ? String(result.value.unit)
        : undefined;
    return {
      ok: result.ok,
      verified: Boolean(
        result.value &&
          typeof result.value === "object" &&
          "verified" in result.value &&
          result.value.verified,
      ),
      ecuId: binding.ecuId,
      did,
      ...(originalValue !== undefined ? { originalValue } : {}),
      ...(writtenValue !== undefined ? { writtenValue } : {}),
      ...(unit !== undefined ? { unit } : {}),
      reasons: [...result.reasons],
      warnings: [...result.warnings],
      transactionId: result.transaction.id,
    };
  }

  /**
   * Signal analysis with FFT spectrum and anomaly detection (Task 5).
   */
  analyzeSignal(signalId: string): AdvancedSignalAnalysisView {
    const runtime = this.requireRuntime();
    const res = runtime.signalAnalysis.analyze(signalId);
    return {
      signalId: res.signalId,
      sampleCount: res.sampleCount,
      ...(res.statistics
        ? {
            statistics: {
              min: res.statistics.min,
              max: res.statistics.max,
              mean: res.statistics.mean,
              median: res.statistics.median,
              variance: res.statistics.variance,
              stdDev: res.statistics.stdDev,
              skewness: res.statistics.skewness,
              kurtosis: res.statistics.kurtosis,
              p5: res.statistics.percentiles.p5,
              p50: res.statistics.percentiles.p50,
              p95: res.statistics.percentiles.p95,
            },
          }
        : {}),
      spectrum: {
        dominantFrequency: res.spectrum.dominantFrequency,
        dominantMagnitude: res.spectrum.dominantMagnitude,
        snrDb: res.spectrum.snrDb,
      },
      anomalies: res.anomalies.map((a) => ({
        kind: a.kind,
        value: a.value,
        severity: a.severity,
        description: a.description,
      })),
    };
  }

  /**
   * Injects chaos into CAN transport (Task 4).
   *
   * The switches act on the bus the session runs on, which exists only while
   * something is connected — `start()` installs the chaos layer there (E24). Before a
   * connection there is nothing to inject into, and answering that with a silent
   * no-op is how the panel came to report a chaos that never touched the vehicle:
   * refused instead, with the reason, as a `TransportClosedError` the HTTP layer
   * turns into 409 (ADR 0018: a refusal is an answer with reasons).
   *
   * `dropBurstCanId` aims the burst at one arbitration id; left out, the burst takes
   * the next `dropBurst` frames of the whole connection. Aiming is what makes the
   * switch meaningful per ECU, and the panel shows which of the two is armed
   * (`chaosStatus().dropBurstScope`) because a burst aimed at an id nobody uses takes
   * nothing — measured in 0.E E24 as 6 of 6 frames on the demo vehicle against 0 of 6
   * on the managed one, both reporting `active: true`.
   */
  injectChaos(options: {
    dropBurst?: number;
    dropBurstCanId?: number;
    dropRate?: number;
    corruptSequenceCanId?: number;
  }): void {
    const chaosBus = this.chaosBus;
    if (!chaosBus) {
      throw new TransportClosedError(
        "chaos needs an open connection — start the vehicle first, the switches act on the live bus",
        { adapter: this.selection.id },
      );
    }
    if (options.dropBurst !== undefined) {
      this.chaosDropBurst = options.dropBurst;
      this.chaosDropBurstCanId = options.dropBurstCanId;
      ChaosLab.injectBurstFrameDrop(chaosBus, options.dropBurstCanId, options.dropBurst);
    }
    if (options.dropRate !== undefined) {
      this.chaosDropRate = options.dropRate;
      ChaosLab.injectDropRate(chaosBus, options.dropRate);
    }
    if (options.corruptSequenceCanId !== undefined) {
      ChaosLab.injectIsoTpSequenceCorruption(chaosBus, options.corruptSequenceCanId);
    }
  }

  /**
   * The scenario catalog of the workbench — the `scenarios/` files, projected for a
   * picker (ADR 0048). Data, not a copy: a new scenario is in the panel the moment its
   * file is in the directory, and a file that does not parse stopped the server with
   * the file named instead of quietly vanishing from this list.
   */
  scenarios(): ScenarioCatalogView {
    return toScenarioCatalogView(this.scenarioFiles.map((entry) => entry.scenario));
  }

  /**
   * Run one scenario on the connected virtual vehicle and report both verdicts.
   *
   * The answer is data, never a thrown error: "this adapter has no behaviour model" and
   * "no such scenario" are states of the *request*, and a 500 with a stack trace would
   * describe neither. `ok: false` says what is missing in the caller's words.
   */
  /**
   * The scenario most recently run on this connection. The analysis input names
   * it so an answer can say what it was reasoning about (master prompt §14); it
   * lives here because this object is the only one that knows a scenario ever
   * ran — the analysis layer must not guess it from the fault codes alone.
   */
  private lastScenario: { id: string; title?: string; seed?: number } | undefined;

  /**
   * The scenario files, loaded once per process (ADR 0048): the one catalog there is.
   * A file that does not parse fails here — loudly, at startup, with its name — because
   * a picker that silently offers fewer scenarios is a bench that lies about the car.
   */
  private readonly scenarioFiles = loadScenarioCatalog();

  async runScenario(
    id: string,
  ): Promise<
    { ok: true; run: ScenarioRunView; panel: ScenarioPanelView } | { ok: false; error: string }
  > {
    const vehicle = this.hfVehicle;
    if (vehicle === undefined) {
      return {
        ok: false,
        error:
          'no scenario support on this connection — select the "High-fidelity virtual vehicle" adapter',
      };
    }
    const entry = this.scenarioFiles.find((file) => file.id === id.trim());
    if (entry === undefined) {
      const known = this.scenarioFiles.map((file) => file.id).join(", ");
      return { ok: false, error: `unknown scenario "${id}" — known: ${known}` };
    }
    // The file's seed drives the run (ADR 0046/0048): the same file is the same run,
    // on the demo vehicle and in a regression suite.
    const run = await vehicle.runScenario(entry.scenario, { seed: entry.determinism.seed });
    // The analysis input names the scenario this session was driven by (§14) — with the
    // seed, so the run it reasoned about is reproducible from the answer alone.
    this.lastScenario = {
      id: entry.id,
      title: entry.scenario.title,
      seed: entry.determinism.seed,
    };
    const memory = vehicle.modules().flatMap((module) =>
      vehicle.model.dtcMemoryOf(module.ecuId).map((dtc) => ({
        ecu: module.ecuId,
        code: dtc.code,
        status: dtc.status ?? 0,
        active: ((dtc.status ?? 0) & 0x01) !== 0,
      })),
    );
    const view = toScenarioRunView(run, memory);
    // The panel's rows are projected here, not in the browser: `public/*.js` has no test
    // runner, and every one of those rows is a claim about the vehicle (ADR 0030 §2).
    return { ok: true, run: view, panel: toScenarioPanelView(view) };
  }

  /**
   * Disarms every rule on the live bus. The counters keep their values: they report
   * what happened on this connection, and a reset that also erased the record would
   * make the panel's numbers untrustworthy in exactly the moment someone checks them.
   */
  resetChaos(): void {
    this.chaosBus?.clearRules();
    this.chaosDropRate = 0;
    this.chaosDropBurst = 0;
    this.chaosDropBurstCanId = undefined;
  }

  chaosStatus(): ChaosStatusView {
    const burstRemaining = this.chaosBus?.remainingBurstDrops ?? 0;
    const isActuallyActive =
      this.chaosBus !== undefined && (this.chaosDropRate > 0 || burstRemaining > 0);
    return {
      active: isActuallyActive,
      dropRate: this.chaosDropRate,
      dropBurstRemaining: burstRemaining,
      dropBurstTarget:
        this.chaosDropBurstCanId === undefined ? null : formatCanId(this.chaosDropBurstCanId),
      dropBurstScope:
        this.chaosDropBurst <= 0
          ? "none"
          : this.chaosDropBurstCanId === undefined
            ? "bus-wide"
            : "targeted",
      droppedFrames: this.chaosBus?.dropped.length ?? 0,
      corruptedFrames: this.chaosBus?.corruptedCount ?? 0,
      delayedFrames: this.chaosBus?.delayedCount ?? 0,
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
    const session = this.session();
    // One assembly, one place: `analysis-input.ts` projects the provider's input from
    // the read models plus the runtime's evidence snapshot, so an answer can cite the
    // items it rests on (AGENTS 22, P0 #39/#42).
    const input = buildAnalysisInput({
      session,
      identity: runtime.vehicle.identity(),
      dtcs: this.dtcs,
      statistics: runtime.measurements.statistics(),
      anomalies: runtime.measurements.anomalies(),
      evidence: runtime.evidence.snapshot(),
      // The loop state at this moment (ADR 0056): the answer can say which
      // evidence speaks for and against the leading hypothesis and which test
      // reduces the uncertainty the most — machine-readable, cited, not prose.
      diagnosis: runtime.evidence.guidedDiagnosis(this.guidedDiagnosisSteps),
      ...(this.lastScenario !== undefined ? { scenario: this.lastScenario } : {}),
      versions: {
        promptVersion: ANALYSIS_PROMPT_VERSION,
        runtimeVersion: PLATFORM_VERSION,
        ...(session?.definitionPackage !== undefined
          ? {
              definitionVersion: `${session.definitionPackage.oem}@${session.definitionPackage.version}`,
            }
          : {}),
        packageVersions: runtime.definitions
          .listPackages()
          .map((pkg) => `${pkg.oem}@${pkg.version}`),
      },
    });
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
    const manifest = this.signedManifest();
    return SessionLogger.toJson({
      meta: {
        sessionId: this.session()?.id ?? "unknown",
        vin: this.session()?.vehicle?.vin,
        mode: this.mode,
        adapter: this.selection.id,
        adapterConfig: this.selection.config,
        platformVersion: PLATFORM_VERSION,
        ...(this.lastScenario ? { scenario: this.lastScenario } : {}),
        ...(manifest ? { traceId: traceIdFromManifest(manifest) } : {}),
      },
      samples,
      markers,
      dtcs: this.allDtcRecords(),
      trace: snapshot.trace,
      log: snapshot.log,
      // The export carries the signed witness of exactly the trace it carries (ADR 0057).
      ...(manifest ? { rawTraceManifest: manifest } : {}),
    });
  }

  private signedManifest(): RawTraceManifest | undefined {
    try {
      const unsigned = this.sessionLogger.rawTraceManifest();
      return signRawTraceManifest(unsigned, this.manifestSigner);
    } catch {
      return undefined;
    }
  }

  private allDtcRecords(): DtcRecord[] {
    return (this.session()?.ecus ?? []).flatMap((ecu) => ecu.dtcs ?? []);
  }

  state(): AppState {
    const runtime = this.runtime;
    const session = this.session();
    // The read model, not the raw identity: it is the only place that knows both
    // what was measured and what the resolution concluded (ADR 0026).
    const identity = runtime?.vehicle.identity();
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
      unreadEcus: this.unreadEcus,
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
function defaultDefinitionsFor(
  mode: BackendMode,
  adapterId?: string,
): readonly DefinitionPackage[] {
  if (mode === "hardware") return [genericPackage];
  if (adapterId === SIMULATOR_5ECU_ADAPTER_ID) return [highFidelityPackage];
  return [simulatorPackage];
}

function modeForSelection(selection: AdapterSelection, catalog: AdapterCatalog): BackendMode {
  if (selection.id === SIMULATOR_ADAPTER_ID || selection.id === SIMULATOR_5ECU_ADAPTER_ID)
    return "simulator";
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
