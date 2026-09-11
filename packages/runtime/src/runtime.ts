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
 * The underlying `DiagnosticEngine` is still exposed as an escape hatch
 * while it is being decomposed (ADR 0014 Phase 4); new code should prefer
 * the services and the command bus.
 */

import { createLogger, type Logger } from '@vdp/shared';
import { DiagnosticEngine, type DiagnosticEngineOptions, type SafetyManager, type VehicleSessionData } from '@vdp/core';
import type { DefinitionPackage } from '@vdp/definitions';
import type { CanBus } from '@vdp/transport-can';
import { ActionRegistry, CommandBus, createStandardActions } from '@vdp/application';
import { DefaultIdGenerator, InMemoryEventBus, type Clock, type EventBus, type IdGenerator, type SessionStore } from '@vdp/domain';
import { PackageDefinitionProvider } from './definition-service.js';
import { registerRuntimeHandlers } from './handlers.js';
import { DtcService, EcuService, MeasurementService, SafetyService, SessionService, VehicleService } from './services.js';

export interface RuntimeOptions {
  /** The frame-level bus below ISO-TP — any `CanBus` implementation. */
  bus: CanBus;
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
  isoTpDefaults?: DiagnosticEngineOptions['isoTpDefaults'];
  /** Manufacturer hooks, consulted only where definitions are silent. */
  oemProtocols?: DiagnosticEngineOptions['oemProtocols'];
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
  /** Escape hatch while the engine decomposition is in progress (ADR 0014). */
  readonly engine: DiagnosticEngine;
  /** Disconnect (if connected) and release the runtime. Idempotent. */
  dispose(): Promise<void>;
}

export function createDiagnosticRuntime(options: RuntimeOptions): DiagnosticRuntime {
  const events = options.events ?? new InMemoryEventBus();
  const log = (options.logger ?? createLogger('runtime', { level: 'INFO' })).child('runtime');
  const clock = options.clock;
  const ids = options.idGenerator ?? new DefaultIdGenerator(clock);

  const engineOptions: DiagnosticEngineOptions = {
    bus: options.bus,
    logger: log,
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
  const vehicle = new VehicleService(engine, ecus, events, log);
  const measurements = new MeasurementService(engine, events, log);
  const session = new SessionService(engine, options.sessionStore);
  const safety = new SafetyService(engine);
  const definitions = new PackageDefinitionProvider(options.definitions ?? []);

  const actions = new ActionRegistry();
  for (const action of createStandardActions()) actions.register(action);

  const commands = new CommandBus();
  registerRuntimeHandlers(commands, { vehicle, ecus, dtc, measurements, session, actions });

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
    engine,
    dispose: async () => {
      // `endedAt` marks a session the engine already closed (vehicle.disconnect
      // or an earlier dispose); closing the bus twice is not safe.
      const openSession = engine.vehicleSession;
      if (openSession && openSession.data.endedAt === undefined) await engine.disconnect();
    },
  };
}
