/**
 * Diagnostic runtime — the composition root (target architecture §12, §33).
 *
 * `createDiagnosticRuntime` wires everything a headless diagnostic session
 * needs: the engine, the domain services, the command/query bus, the event
 * bus and the injected ports (clock, ids, session store, definitions).
 *
 * The runtime works without HTTP, DOM, browser or WebSocket — Web, Desktop,
 * Mobile, CLI and AI agents all compose the same object:
 *
 * ```ts
 * const runtime = createDiagnosticRuntime({ bus, definitions });
 * const { session, ecus } = await runtime.vehicle.connect();
 * const dtcs = await runtime.commands.dispatch(readDtcs());
 * ```
 *
 * Below the services the runtime still composes the (monolithic) diagnostic
 * engine of `@vdp/core`; it is an internal implementation detail now. Nothing
 * outside this package reaches it — the public surface is services and the
 * command bus (ADR 0014; the core-internal decomposition of the engine class
 * itself is the remaining Phase 4 work).
 */

import { ActionRegistry, CommandBus, createStandardActions } from "@vdp/application";
import {
  DiagnosticEngine,
  type DiagnosticEngineOptions,
  type EcuLinkFactory,
  type SafetyManager,
  type VehicleSessionData,
} from "@vdp/core";
import type { DefinitionPackage } from "@vdp/definitions";
import {
  type Clock,
  DefaultIdGenerator,
  type EventBus,
  type IdGenerator,
  InMemoryEventBus,
  type SessionStore,
} from "@vdp/domain";
import { type Logger, createLogger } from "@vdp/shared";
import type { CanBus } from "@vdp/transport-can";
import { PackageDefinitionProvider } from "./definition-service.js";
import { EventAuditRecorder } from "./event-recorder.js";
import { registerRuntimeHandlers } from "./handlers.js";
import {
  DtcService,
  EcuService,
  MeasurementService,
  SafetyService,
  SessionService,
  VehicleService,
} from "./services.js";

export interface RuntimeOptions {
  /**
   * The frame-level bus below ISO-TP — any `CanBus` implementation. Required for
   * the CAN discovery/connect flow. May be omitted when {@link linkFactory}
   * drives a non-CAN transport and ECUs are attached via `engine.attach()`.
   */
  bus?: CanBus;
  /**
   * Transport seam (AGENTS 5, 36): supplies each ECU's link. Supply a
   * {@link DoipEcuLinkFactory} — or any custom factory — to run the whole
   * diagnostic stack over a non-CAN transport.
   */
  linkFactory?: EcuLinkFactory;
  /** Definition packages used for discovery, decoding and enrichment. */
  definitions?: readonly DefinitionPackage[];
  logger?: Logger;
  /** Safety manager for write operations; a private one is created otherwise. */
  safety?: SafetyManager;
  /** Domain event bus; an in-memory bus is created otherwise. */
  events?: EventBus;
  /** Persistence port for sessions (file system, cloud, in-memory, …). */
  sessionStore?: SessionStore<VehicleSessionData>;
  /** Id generation; wall-clock based otherwise (§24). */
  idGenerator?: IdGenerator;
  /** Time source; inject a fixed clock for deterministic runs (§32). */
  clock?: Clock;
  /** Poll interval for live measurements. */
  pollIntervalMs?: number;
  /** Extra ISO-TP settings applied to every ECU (pass-through). */
  isoTpDefaults?: DiagnosticEngineOptions["isoTpDefaults"];
  /** Manufacturer hooks, consulted only where definitions are silent. */
  oemProtocols?: DiagnosticEngineOptions["oemProtocols"];
}

export interface DiagnosticRuntime {
  readonly vehicle: VehicleService;
  readonly ecus: EcuService;
  readonly dtc: DtcService;
  readonly measurements: MeasurementService;
  readonly session: SessionService;
  readonly safety: SafetyService;
  readonly definitions: PackageDefinitionProvider;
  readonly actions: ActionRegistry;
  readonly commands: CommandBus;
  readonly events: EventBus;
  /**
   * Timestamped trail of every domain event — the platform's audit log and the
   * basis for reports, replay and safety review (§10/§24).
   */
  readonly audit: EventAuditRecorder;
  /** Disconnect (if connected) and release the runtime. Idempotent. */
  dispose(): Promise<void>;
}

export function createDiagnosticRuntime(options: RuntimeOptions): DiagnosticRuntime {
  const events = options.events ?? new InMemoryEventBus();
  const log = (options.logger ?? createLogger("runtime", { level: "INFO" })).child("runtime");
  const clock = options.clock;
  const ids = options.idGenerator ?? new DefaultIdGenerator(clock);

  const engineOptions: DiagnosticEngineOptions = {
    logger: log,
    ...(options.bus !== undefined ? { bus: options.bus } : {}),
    ...(options.linkFactory !== undefined ? { linkFactory: options.linkFactory } : {}),
    ...(options.definitions !== undefined ? { definitions: options.definitions } : {}),
    ...(options.safety !== undefined ? { safety: options.safety } : {}),
    ...(clock !== undefined ? { clock: () => clock.now() } : {}),
    ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
    ...(options.isoTpDefaults !== undefined ? { isoTpDefaults: options.isoTpDefaults } : {}),
    ...(options.oemProtocols !== undefined ? { oemProtocols: options.oemProtocols } : {}),
  };
  const engine = new DiagnosticEngine(engineOptions);

  const ecus = new EcuService(engine, events, log);
  const dtc = new DtcService(engine, ecus, events, log, ids);
  const definitions = new PackageDefinitionProvider(options.definitions ?? []);
  const vehicle = new VehicleService(engine, ecus, events, log, definitions);
  const measurements = new MeasurementService(engine, events, log);
  const session = new SessionService(engine, options.sessionStore);
  const safety = new SafetyService(engine);

  const actions = new ActionRegistry();
  for (const action of createStandardActions()) actions.register(action);

  const commands = new CommandBus();
  registerRuntimeHandlers(commands, { vehicle, ecus, dtc, measurements, session, actions });

  // The event trail is on by default: every diagnostic event is observed and
  // kept, so a session can always be reconstructed from its events (§10/§24).
  const audit = new EventAuditRecorder(events, clock);

  return {
    vehicle,
    ecus,
    dtc,
    measurements,
    session,
    safety,
    definitions,
    actions,
    commands,
    events,
    audit,
    dispose: async () => {
      audit.dispose();
      // `endedAt` marks a session the engine already closed (vehicle.disconnect
      // or an earlier dispose); closing the bus twice is not safe.
      const openSession = engine.vehicleSession;
      if (openSession && openSession.data.endedAt === undefined) {
        await engine.disconnect();
        return;
      }
      // No open session — e.g. a failed connect that already opened the bus.
      // A half-open transport must not survive the runtime: the next attempt
      // would fail with "already open" instead of the real reason.
      engine.stopLiveData();
      const bus = options.bus;
      if (bus?.isOpen()) await bus.close();
    },
  };
}
