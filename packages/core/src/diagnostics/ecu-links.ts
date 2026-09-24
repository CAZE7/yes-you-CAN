/**
 * Transport seam of the diagnostic engine (AGENTS 5, 36).
 *
 * The engine must not know which transport sits below it: on CAN one ECU talks
 * over an {@link IsoTpConnection}, on DoIP over a request/response link on a TCP
 * socket, and a future transport plugs in the same way. This module owns that
 * seam — building the link, building the UDS client on top of it, and reporting
 * clearly when there is no bus to fall back to.
 */

import { UdsClient, type UdsLink } from "@vdp/protocols-uds";
import type { Logger } from "@vdp/shared";
import type { AdapterInfo, CanBus, TransportInfo } from "@vdp/transport-can";
import { IsoTpConnection, type IsoTpOptions } from "@vdp/transport-iso-tp";

/**
 * Transport-neutral link one ECU talks on (AGENTS 5, 36). The engine never
 * inspects the concrete transport: on CAN it is an {@link IsoTpConnection}, on
 * DoIP it is a request/response link over a TCP socket (see
 * `createRequestResponseLink`). `close` releases this one ECU's resources.
 */
export interface OpenedEcuLink {
  link: UdsLink;
  close: () => void;
}

/**
 * The transport seam: produces a {@link OpenedEcuLink} for one ECU. Supplying a
 * factory is how DoIP — or any future transport — plugs in without the UDS
 * layer changing at all. When absent, the engine falls back to ISO-TP over the
 * CAN {@link CanBus}.
 */
export interface EcuLinkFactory {
  open(ecu: {
    txId: number;
    rxId: number;
    extended?: boolean;
  }): Promise<OpenedEcuLink> | OpenedEcuLink;
  /**
   * What this factory carries frames on — the transport half of a session record
   * (master prompt P2, ADR 0061).
   *
   * A CAN session gets its adapter and transport from the bus it opened. A DoIP
   * session has no bus, so without this the session opened for explicitly
   * attached ECUs could not say *how* it was measured, and a report built from
   * it would have to leave the transport blank. Optional: a factory that cannot
   * describe itself (a test double, a scripted link) attaches without a session
   * record instead of inventing one (AGENTS 34.21).
   */
  describe?(): { adapter: AdapterInfo; transport: TransportInfo };
}

/** One ECU as it is addressed on the bus. */
export interface EcuTarget {
  txId: number;
  rxId: number;
  extended?: boolean;
}

export interface EcuLinksOptions {
  /**
   * CAN bus — required for functional discovery and for the default ISO-TP link
   * factory. May be omitted when a {@link EcuLinkFactory} is provided and ECUs
   * are attached explicitly via the engine's `attach` (the DoIP path).
   *
   * Spelled `| undefined` on purpose: this options object is forwarded from the
   * engine verbatim, and under `exactOptionalPropertyTypes` a forwarded
   * maybe-value would otherwise need a conditional spread at every hop.
   */
  bus?: CanBus | undefined;
  /** Overrides per-ECU link construction so a non-CAN transport can drive the engine. */
  linkFactory?: EcuLinkFactory | undefined;
  /** Extra ISO-TP settings (padding, addressing, timing) applied to every ECU. */
  isoTpDefaults?: Partial<IsoTpOptions> | undefined;
}

export class EcuLinks {
  private readonly bus: CanBus | undefined;
  private readonly linkFactory: EcuLinkFactory | undefined;
  private readonly isoTpDefaults: Partial<IsoTpOptions>;

  constructor(
    options: EcuLinksOptions,
    private readonly log: Logger,
  ) {
    this.bus = options.bus;
    this.linkFactory = options.linkFactory;
    this.isoTpDefaults = options.isoTpDefaults ?? {};
  }

  /**
   * Open the link for one ECU through the transport seam (AGENTS 5, 36). A
   * {@link EcuLinkFactory} wins when provided — that is the DoIP path — and the
   * engine falls back to ISO-TP over the CAN bus otherwise.
   */
  async open(ecu: { txId: number; rxId: number; extended: boolean }): Promise<OpenedEcuLink> {
    if (this.linkFactory) {
      return this.linkFactory.open(ecu);
    }
    const isoTp = this.createIsoTp(ecu.txId, ecu.rxId, ecu.extended);
    return { link: isoTp, close: () => isoTp.close() };
  }

  /**
   * What the transport seam carries, when it can say (ADR 0061).
   *
   * `undefined` for the CAN fallback — there the bus is the description, and the
   * session opener reads it directly.
   */
  describeTransport(): { adapter: AdapterInfo; transport: TransportInfo } | undefined {
    return this.linkFactory?.describe?.();
  }

  /**
   * An ISO-TP connection on the bus, built outside the seam.
   *
   * Used when an ECU could not be attached through the seam: the session that
   * carries the failure still has to exist, and it has to speak the same
   * transport as a working one.
   */
  createIsoTp(txId: number, rxId: number, extended: boolean): IsoTpConnection {
    return new IsoTpConnection(
      this.requireBus("createIsoTp()"),
      {
        txId,
        rxId,
        extended,
        ...this.isoTpDefaults,
      },
      this.log,
    );
  }

  /**
   * Any UdsLink drives the client — IsoTpConnection satisfies it structurally
   * (the CAN path), a RequestResponseLink over a DoIP socket satisfies it too —
   * so swapping transports never touches the UDS layer (AGENTS 5, 36).
   */
  createClient(link: UdsLink, name: string): UdsClient {
    return new UdsClient(link, { name, logger: this.log });
  }

  /** The bus, or a clear error naming the call that needed one. */
  requireBus(context: string): CanBus {
    const bus = this.bus;
    if (!bus) throw new Error(`${context} needs a CAN bus — pass one or provide a linkFactory`);
    return bus;
  }

  /** True when a bus is available (functional discovery needs one). */
  get hasBus(): boolean {
    return this.bus !== undefined;
  }
}
