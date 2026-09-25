/**
 * DoIP transport seam (ISO 13400; AGENTS 5, 36, blueprint: transport is
 * pluggable).
 *
 * `DiagnosticEngine` obtains each ECU's link through an {@link EcuLinkFactory}.
 * On CAN the engine builds an ISO-TP connection itself; this factory is the
 * drop-in for DoIP: one TCP connection per target ECU, UDS payloads wrapped by
 * `DoipTransport`, exposed to the UDS layer as a plain {@link UdsLink} via
 * `createRequestResponseLink`. Nothing above the link changes — the engine,
 * sessions and services are identical for CAN and DoIP.
 *
 * What this module owns beyond the wiring (master prompt P2, ADR 0061):
 *
 * - **The connection lifecycle.** A DoIP session is a TCP connection that a
 *   vehicle ends on its own schedule (sleep, Wi-Fi drop, entity restart) while
 *   the diagnostic session above it believes it is still talking. The link
 *   therefore reports a {@link ConnectionStatus} like every adapter does, and a
 *   lost connection is an `error` with the cause — not a request that times out
 *   and reads like a silent ECU.
 * - **The bounded reconnect.** Attempts and delay come from the shared policy
 *   vocabulary (`@vdp/shared`, the same rule the serial supervisor uses): one
 *   revival per incident by default, `recovering` while the budget is being
 *   spent, `error` when it is gone. A revival re-opens the socket *and* runs
 *   routing activation again — a TCP connection without routing activation is
 *   not a diagnostic link.
 * - **Error propagation.** A request in flight when the connection dies fails
 *   with the death's reason instead of running into its own timeout; the next
 *   request either finds a revived link or the honest `error` state.
 */

import type { EcuLinkFactory, OpenedEcuLink } from "@vdp/core";
import { createRequestResponseLink, type UdsLink } from "@vdp/protocols-uds";
import {
  createLogger,
  type Logger,
  messageOf,
  type ReconnectPolicy,
  reconnectPolicyOf,
} from "@vdp/shared";
import {
  type AdapterConnectionState,
  type ConnectionStatus,
  ConnectionTracker,
} from "@vdp/transport-can";
import { type DoipSocket, DoipTransport } from "@vdp/transport-doip";

export interface DoipEcuLinkFactoryOptions {
  /**
   * Opens the transport for one target ECU. Node returns a TLS/plain TCP
   * socket, a browser a WebSocket, a test a fake endpoint — the factory does
   * not care which.
   */
  createSocket: (targetAddress: number) => DoipSocket;
  /** Tester logical address (default 0x0E00, like most external testers). */
  testerAddress?: number;
  /** Require TLS (ISO 13400-2 port 3496) — recommended for productive use. */
  requireTls?: boolean;
  /** Default UDS response timeout in ms, handed to the request/response link. */
  responseTimeoutMs?: number;
  /**
   * Maps the engine's ECU addressing to a DoIP logical address. Defaults to the
   * response identifier, which matches how definition packages address DoIP ECUs.
   */
  logicalAddressFor?: (ecu: { txId: number; rxId: number; extended?: boolean }) => number;
  /**
   * Bounded reconnect policy per link loss (`attempts`, `delayMs`). Absent means
   * {@link DEFAULT_RECONNECT_POLICY}: one attempt after two seconds.
   */
  reconnect?: { attempts?: number; delayMs?: number };
  /** Injectable wait, so a test does not have to spend the real delay. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * How the session record should name this connection, e.g. `192.168.0.10:13400`.
   * Defaults to `doip`; the address is a fact about the tester's network, so it
   * comes from the caller and is never guessed (ADR 0061).
   */
  endpoint?: string;
  /** ISO-TP-equivalent payload size of the connection: DoIP carries 64 KiB. */
  mtu?: number;
  logger?: Logger;
}

/**
 * A DoIP link that survives a dropped connection within its budget.
 *
 * The engine holds this object for the whole session; the socket below it does
 * not have to survive that long. Every request goes to the *current* transport,
 * and a connection that died is replaced under the same link — which is why the
 * layer above needs no knowledge of DoIP at all.
 */
class SupervisedDoipLink implements UdsLink {
  private readonly connection: ConnectionTracker;
  private readonly log: Logger;
  private current: { transport: DoipTransport; link: UdsLink } | null = null;
  private attemptsSpent = 0;
  private reviving: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly target: {
      targetAddress: number;
      testerAddress?: number;
      requireTls: boolean;
      responseTimeoutMs?: number;
      policy: ReconnectPolicy;
      sleep: (ms: number) => Promise<void>;
      createSocket: (targetAddress: number) => DoipSocket;
      logger: Logger;
    },
  ) {
    this.log = target.logger.child("doip");
    this.connection = new ConnectionTracker({
      adapterId: "doip",
      detail: `DoIP link 0x${target.targetAddress.toString(16)}${target.requireTls ? " (TLS)" : ""}`,
    });
  }

  /** Logical address of the ECU this link talks to (ISO 13400-2). */
  get targetAddress(): number {
    return this.target.targetAddress;
  }

  /** Open (or re-open) the connection and activate routing. */
  async connect(): Promise<void> {
    this.connection.connect(
      this.current === null ? "opening the DoIP connection" : "reconnecting the DoIP connection",
    );
    const transport = new DoipTransport({
      socket: this.target.createSocket(this.target.targetAddress),
      targetAddress: this.target.targetAddress,
      logger: this.log,
      ...(this.target.testerAddress !== undefined
        ? { testerAddress: this.target.testerAddress }
        : {}),
      ...(this.target.requireTls ? { requireTls: true } : {}),
    });
    try {
      await transport.connect();
    } catch (error) {
      // A handshake that failed is an error with the transport's own reason
      // (TLS refused, routing activation refused, no activation answer) — the
      // caller must see it, not a generic "connection failed".
      this.connection.fail(messageOf(error));
      throw error;
    }
    this.current = {
      transport,
      link: createRequestResponseLink(
        transport,
        this.target.responseTimeoutMs !== undefined
          ? { defaultTimeoutMs: this.target.responseTimeoutMs, logger: this.log }
          : { logger: this.log },
      ),
    };
    this.connection.connected(
      `DoIP 0x${this.target.targetAddress.toString(16)} ${this.target.requireTls ? "over TLS" : "in plaintext"}`,
    );
  }

  get status(): ConnectionStatus {
    // The transport knows more about the connection than this wrapper does while
    // it is alive (frame counters, a degraded phase); the wrapper owns the
    // lifecycle states only it can know (recovering, exhausted budget).
    const lifecycle = this.connection.status();
    if (lifecycle.state === "recovering" || lifecycle.state === "error") return lifecycle;
    const inner = this.current?.transport.getStatus();
    return inner ? { ...inner, adapterId: "doip" } : lifecycle;
  }

  async request(payload: Uint8Array, timeoutMs?: number): Promise<Uint8Array> {
    const active = this.require();
    try {
      return await active.request(payload, timeoutMs);
    } catch (error) {
      await this.recoverAfter(error, "request");
      throw error;
    }
  }

  async sendOnly(payload: Uint8Array): Promise<void> {
    const active = this.require();
    try {
      await active.sendOnly(payload);
    } catch (error) {
      await this.recoverAfter(error, "send");
      throw error;
    }
  }

  async receive(timeoutMs?: number): Promise<Uint8Array | null> {
    const active = this.require();
    return active.receive(timeoutMs);
  }

  /** Close for good: no revival after this, and the socket is released. */
  async close(): Promise<void> {
    this.closed = true;
    const pair = this.current;
    this.current = null;
    this.connection.disconnected("closed by the caller");
    await pair?.transport.disconnect();
  }

  private require(): UdsLink {
    if (this.current === null) {
      // The engine's contract is a link per open ECU; asking a dead one is a
      // programming error, and the message says which one.
      throw new Error(
        `DoIP link 0x${this.target.targetAddress.toString(16)} is not open — the connection is ${this.connection.state}`,
      );
    }
    return this.current.link;
  }

  /**
   * A failed operation may be a symptom of a dead connection. This is where the
   * policy decides: is the transport still usable (then nothing happened) or
   * does the link need a revival (then it is started once, bounded)?
   */
  private async recoverAfter(error: unknown, what: string): Promise<void> {
    if (this.closed) return;
    const state = this.current?.transport.getStatus().state;
    if (state === "connected" || state === "degraded" || state === "connecting") {
      // The connection is fine; this was an ECU answer, an NRC or a timeout.
      // A timeout is not a connection loss: retrying it here would be a second,
      // hidden retry on top of ISO-TP's own policy.
      return;
    }
    this.log.warn("DoIP link lost during a diagnostic request", {
      target: `0x${this.target.targetAddress.toString(16)}`,
      what,
      error: messageOf(error),
    });
    await this.reviveOnce(messageOf(error));
  }

  /** Spend the budget on one revival; safe to call from several failures. */
  private async reviveOnce(reason: string): Promise<void> {
    if (this.reviving) return this.reviving;
    if (this.attemptsSpent >= this.target.policy.attempts) {
      this.connection.fail(`no reconnect attempt left: ${reason}`);
      return;
    }
    this.attemptsSpent++;
    this.connection.recovering(`link lost (${reason}) — reconnect scheduled`);
    const attempt = (async (): Promise<void> => {
      try {
        await this.target.sleep(this.target.policy.delayMs);
        if (this.closed) return;
        const previous = this.current;
        this.current = null;
        await previous?.transport.disconnect().catch(() => undefined);
        await this.connect();
        this.attemptsSpent = 0;
        this.log.info("DoIP link restored", {
          target: `0x${this.target.targetAddress.toString(16)}`,
          reason,
        });
      } catch (error) {
        this.log.warn("DoIP reconnect attempt failed", {
          target: `0x${this.target.targetAddress.toString(16)}`,
          error: messageOf(error),
        });
        this.connection.fail(`reconnect failed: ${messageOf(error)} (no attempt left: ${reason})`);
      } finally {
        this.reviving = null;
      }
    })();
    this.reviving = attempt;
    return attempt;
  }
}

/** The engine's transport seam, implemented for DoIP. */
export class DoipEcuLinkFactory implements EcuLinkFactory {
  private readonly log: Logger;
  private readonly openLinks = new Set<SupervisedDoipLink>();

  constructor(private readonly options: DoipEcuLinkFactoryOptions) {
    this.log = (options.logger ?? createLogger("doip", { level: "INFO" })).child("doip");
  }

  async open(ecu: { txId: number; rxId: number; extended?: boolean }): Promise<OpenedEcuLink> {
    const targetAddress = this.options.logicalAddressFor?.(ecu) ?? ecu.rxId;
    // The shared policy parser speaks the config vocabulary (`reconnectAttempts`,
    // `reconnectDelayMs`); this option object is the same two numbers.
    const policy = reconnectPolicyOf({
      ...(this.options.reconnect?.attempts !== undefined
        ? { reconnectAttempts: this.options.reconnect.attempts }
        : {}),
      ...(this.options.reconnect?.delayMs !== undefined
        ? { reconnectDelayMs: this.options.reconnect.delayMs }
        : {}),
    });
    const link = new SupervisedDoipLink({
      targetAddress,
      ...(this.options.testerAddress !== undefined
        ? { testerAddress: this.options.testerAddress }
        : {}),
      requireTls: this.options.requireTls ?? false,
      ...(this.options.responseTimeoutMs !== undefined
        ? { responseTimeoutMs: this.options.responseTimeoutMs }
        : {}),
      policy,
      sleep: this.options.sleep ?? defaultSleep,
      createSocket: this.options.createSocket,
      logger: this.log,
    });
    this.openLinks.add(link);
    try {
      await link.connect();
    } catch (error) {
      this.openLinks.delete(link);
      throw error;
    }
    this.log.debug("DoIP link opened", { target: `0x${targetAddress.toString(16)}` });
    return {
      link,
      close: () => {
        this.openLinks.delete(link);
        // Disconnecting is not the diagnostic path: a failure to close is logged
        // (the link is on its way out either way), never thrown into a caller.
        void link.close().catch((error) => {
          this.log.warn("DoIP disconnect failed", {
            target: `0x${targetAddress.toString(16)}`,
            error: messageOf(error),
          });
        });
      },
    };
  }

  /**
   * What this factory carries frames on — the transport half of the session
   * record (ADR 0061). This is why an ECU attached over DoIP produces a real
   * session: the platform above (IR, evidence, report) needs to know how it was
   * measured, and this is the only place that knows.
   */
  describe(): {
    adapter: { id: string; kind: string; name: string; channels: string[] };
    transport: {
      kind: "doip";
      channel: string;
      mtu: number;
      doipAddresses?: { testerAddress: number; targetAddress: number };
    };
  } {
    const channel = this.options.endpoint ?? "doip";
    const tester = this.options.testerAddress ?? 0x0e00;
    // The target is what the open link actually carries — and only that. The
    // description feeds the session record, which is where the platform proves
    // where a measurement was taken; an address nobody opened is an invented
    // value (AGENTS 24), so with no open link the field is absent, not 0.
    const target = this.openLinks.values().next().value?.targetAddress;
    return {
      adapter: {
        id: "doip",
        kind: "doip",
        name: `DoIP (${channel})`,
        channels: [channel],
      },
      transport: {
        kind: "doip",
        channel,
        mtu: this.options.mtu ?? 65535,
        ...(target !== undefined
          ? { doipAddresses: { testerAddress: tester, targetAddress: target } }
          : {}),
      },
    };
  }

  /** The state of every open link — what the workbench shows for a DoIP session. */
  states(): Array<{ targetAddress: number; status: ConnectionStatus }> {
    return Array.from(this.openLinks).map((link) => ({
      targetAddress: link.targetAddress,
      status: link.status,
    }));
  }

  /** Close every open link (session teardown, tests). */
  async closeAll(): Promise<void> {
    const links = Array.from(this.openLinks);
    this.openLinks.clear();
    await Promise.all(links.map((link) => link.close().catch(() => undefined)));
  }
}

/** The worst state of all links, so one DoIP session has one headline state. */
export function summariseLinkStates(
  states: readonly ConnectionStatus[],
): AdapterConnectionState | "none" {
  if (states.length === 0) return "none";
  if (states.some((status) => status.state === "error")) return "error";
  if (states.some((status) => status.state === "recovering")) return "recovering";
  if (states.some((status) => status.state === "connecting")) return "connecting";
  if (states.some((status) => status.state === "degraded")) return "degraded";
  if (states.some((status) => status.state === "connected")) return "connected";
  return "disconnected";
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Convenience constructor mirroring the engine's other `create*` helpers. */
export function createDoipEcuLinkFactory(options: DoipEcuLinkFactoryOptions): DoipEcuLinkFactory {
  return new DoipEcuLinkFactory(options);
}
