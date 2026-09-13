/**
 * Opening a diagnostic session (AGENTS 2, 11, 12, 34.11).
 *
 * Connecting is a sequence with a failure policy: open the bus, create the
 * durable session record, discover ECUs, attach each responder — and when one
 * does not answer, keep it visible in the session instead of dropping it. The
 * engine used to carry that sequence inline; it lives here because "bring a
 * session up" is a responsibility of its own, while the engine stays the façade
 * over the collaborators.
 */

import type { DefinitionPackage } from "@vdp/definitions";
import type { Logger } from "@vdp/shared";
import { messageOf } from "@vdp/shared";
import type { CanBus, TransportInfo } from "@vdp/transport-can";
import { VehicleSession, createSession } from "../session/session.js";
import { describeVehicle } from "../vehicle/identity.js";
import { type DiscoveredEcu, EcuDiscovery } from "./discovery.js";
import type { EcuAttacher } from "./ecu-attacher.js";
import type { EcuRegistry } from "./ecu-registry.js";

export interface ConnectResult {
  session: VehicleSession;
  ecus: DiscoveredEcu[];
}

/** Discovery timing of one `connect()` call. */
export interface ConnectDiscoveryOptions {
  windowMs?: number;
  candidates?: Array<{ txId: number; rxId: number; extended?: boolean }>;
  /** Pause between single probes (see `DiscoveryOptions.probeDelayMs`). */
  probeDelayMs?: number;
}

export interface SessionOpenerOptions {
  /** CAN bus — required for functional discovery (AGENTS 12). */
  bus?: CanBus | undefined;
  definitions: readonly DefinitionPackage[];
  attacher: EcuAttacher;
  registry: EcuRegistry;
  logger: Logger;
  clock?: (() => number) | undefined;
}

export class SessionOpener {
  private readonly bus: CanBus | undefined;
  private readonly definitions: readonly DefinitionPackage[];
  private readonly attacher: EcuAttacher;
  private readonly registry: EcuRegistry;
  private readonly log: Logger;
  private readonly clock: (() => number) | undefined;

  constructor(options: SessionOpenerOptions) {
    this.bus = options.bus;
    this.definitions = options.definitions;
    this.attacher = options.attacher;
    this.registry = options.registry;
    this.log = options.logger;
    this.clock = options.clock;
  }

  /**
   * Open the session: discover ECUs, attach a UDS client to each responder and
   * read identification. Read-only only (AGENTS 11/34.11).
   */
  async open(discoveryOptions: ConnectDiscoveryOptions = {}): Promise<ConnectResult> {
    const bus = this.requireBus();
    if (!bus.isOpen()) await bus.open();

    const transportInfo: TransportInfo = {
      kind: bus.capabilities.canFd ? "can-fd" : "can",
      channel: bus.info.channels[0] ?? "can0",
      mtu: bus.capabilities.canFd ? 64 : 8,
    };
    const activePackage = this.definitions[0];
    const data = createSession({
      adapter: bus.info,
      transport: transportInfo,
      ...(activePackage
        ? {
            definitionPackage: { oem: activePackage.oem, version: activePackage.version },
          }
        : {}),
      ...(this.clock ? { clock: this.clock } : {}),
    });
    const session = new VehicleSession(data);

    const discovery = new EcuDiscovery(bus, {
      logger: this.log,
      ...(discoveryOptions.windowMs !== undefined ? { windowMs: discoveryOptions.windowMs } : {}),
      ...(discoveryOptions.candidates ? { candidates: discoveryOptions.candidates } : {}),
      ...(discoveryOptions.probeDelayMs !== undefined
        ? { probeDelayMs: discoveryOptions.probeDelayMs }
        : {}),
    });
    const discovered = await discovery.discover(this.definitions);

    for (const ecu of discovered) {
      try {
        const handle = await this.attacher.attach(ecu);
        await this.attacher.identify(handle);
        session.upsertEcu(handle.session.record);
      } catch (error) {
        const message = messageOf(error);
        this.log.warn("ECU attach failed", { rxId: `0x${ecu.rxId.toString(16)}`, error: message });
        session.upsertEcu(this.attacher.attachFailed(ecu, message));
      }
    }

    await this.attacher.detectVehicleIdentity(session);
    this.log.info("session opened", {
      session: session.id,
      ecus: session.data.ecus.length,
      reachable: session.data.ecus.filter((e) => e.reachable).length,
      vehicle: describeVehicle(session.data.vehicle),
    });
    return { session, ecus: discovered };
  }

  /** Close the session: every link, then the bus (AGENTS 10). */
  async close(session: VehicleSession | null): Promise<void> {
    for (const handle of this.registry.all) {
      handle.session.client.stopTesterPresent();
      handle.session.closeLink();
    }
    this.registry.clear();
    session?.close();
    if (this.bus) await this.bus.close();
  }

  private requireBus(): CanBus {
    const bus = this.bus;
    if (!bus) throw new Error("connect() needs a CAN bus — pass one or provide a linkFactory");
    return bus;
  }
}
