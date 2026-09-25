/**
 * DoIP transport (ISO 13400) implementing the platform's VehicleTransport
 * contract (AGENTS 4/5/8).
 *
 * Flow implemented here:
 *   1. UDP vehicle identification (discovery) — optional, done by `discover()`
 *   2. TCP connect to port 13400 (TLS variant 3496 is announced, not implemented
 *      yet — see the security note in AGENTS 8)
 *   3. routing activation request/response
 *   4. UDS payloads inside diagnostic messages (UDSonIP, ISO 14229-5)
 *
 * The UDS layer above never learns that this is DoIP: it only sees
 * send/receive/getStatus.
 */

import {
  createLogger,
  type Logger,
  messageOf,
  ProtocolError,
  TransportClosedError,
  TransportError,
} from "@vdp/shared";
import type { ConnectionStatus, VehicleTransport } from "@vdp/transport-can";
import {
  DOIP_HEADER_LENGTH,
  DOIP_TLS_PORT,
  DOIP_UDP_PORT,
  type DoipHeader,
  decodeDiagnosticAck,
  decodeDiagnosticMessage,
  decodeHeader,
  decodeRoutingActivationResponse,
  encodeDiagnosticMessage,
  encodeHeader,
  encodeMessage,
  encodeRoutingActivationRequest,
  PAYLOAD_TYPE,
  ROUTING_ACTIVATION_TYPE,
} from "./message.js";

/** Minimal duplex socket contract so Node, browser and test doubles all fit. */
export interface DoipSocket {
  connect(): Promise<void>;
  send(data: Uint8Array): Promise<void>;
  onData(listener: (chunk: Uint8Array) => void): () => void;
  close(): Promise<void>;
  isOpen(): boolean;
  /** True when the socket provides TLS (ISO 13400-2 port 3496). */
  isSecure?(): boolean;
  /**
   * The peer (or the OS) closed the connection — a vehicle that went to sleep,
   * a Wi-Fi drop, an entity that restarted.
   *
   * Without this the transport kept claiming `connected` and every following
   * request died in its own timeout: an answer that never came looked exactly
   * like an ECU that answered nothing (AGENTS 34.21, ADR 0061). A socket that
   * cannot report its death simply keeps the old behaviour — the timeout — but
   * every socket this platform ships implements this.
   */
  onClose?(listener: (reason: string) => void): () => void;
  /** A socket-level error (write failure, TLS alert); the link is unusable afterwards. */
  onError?(listener: (error: Error) => void): () => void;
}

export interface DoipTransportOptions {
  socket: DoipSocket;
  /** Tester logical address (default 0x0E00 as used by many testers). */
  testerAddress?: number;
  /** Target ECU logical address. */
  targetAddress: number;
  activationType?: number;
  /** Timeout for the routing activation response. */
  activationTimeoutMs?: number;
  /** Default timeout for receive(). */
  receiveTimeoutMs?: number;
  logger?: Logger;
  /** Require a TLS socket — recommended once DoIP is used productively (AGENTS 26/27). */
  requireTls?: boolean;
  /**
   * Hard cap for a single DoIP message (header + payload) in bytes. The
   * payloads this transport carries are small (a UDS response is at most 4095
   * bytes), so 64 KiB has vast headroom. A peer that declares more — or that
   * trickles bytes into the reassembly buffer — is broken or hostile, and the
   * buffer must not follow its declared length (unbounded growth under a
   * sustained flood).
   */
  maxMessageBytes?: number;
  /**
   * Hard cap for diagnostic responses queued ahead of the next receive(). The
   * link is 1:1 request/response; a queue past a handful of unanswered
   * messages means the peer floods or the consumer stalled. The oldest queued
   * answer is dropped (it is the least likely answer to the pending request)
   * and the loss is counted in the status.
   */
  maxQueuedResponses?: number;
}

/** 64 KiB — far beyond any UDS payload, far short of an addressable DoIP length. */
export const DEFAULT_MAX_MESSAGE_BYTES = 65_536;
/** A 1:1 link should never be this far behind its peer. */
export const DEFAULT_MAX_QUEUED_RESPONSES = 16;

export class DoipTransport implements VehicleTransport {
  private readonly log: Logger;
  private readonly testerAddress: number;
  private readonly targetAddress: number;
  private readonly activationType: number;
  private readonly activationTimeoutMs: number;
  private readonly receiveTimeoutMs: number;
  private readonly requireTls: boolean;
  private readonly maxMessageBytes: number;
  private readonly maxQueuedResponses: number;
  private droppedRxCount = 0;

  private buffer: Uint8Array = new Uint8Array();
  private unsubscribe: (() => void) | null = null;
  private queue: Uint8Array[] = [];
  private waiters: Array<{
    resolve: (payload: Uint8Array | null) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private state: ConnectionStatus["state"] = "disconnected";
  private lastError: string | undefined;
  private lastStateReason: string | undefined;
  private changedAt = Date.now();
  private unsubscribeClose: (() => void) | null = null;
  private unsubscribeSocketError: (() => void) | null = null;
  private lastActivityAt: number | undefined;
  private txCount = 0;
  private rxCount = 0;
  private entityLogicalAddress: number | null = null;

  /** Move to a state, remembering why and when — never a bare flag. */
  private enter(state: ConnectionStatus["state"], reason: string, error?: string): void {
    this.state = state;
    this.lastStateReason = reason;
    this.changedAt = Date.now();
    if (error !== undefined) this.lastError = error;
  }

  constructor(private readonly options: DoipTransportOptions) {
    this.log = (options.logger ?? createLogger("connection", { level: "INFO" })).child(
      "connection",
    );
    this.testerAddress = options.testerAddress ?? 0x0e00;
    this.targetAddress = options.targetAddress;
    this.activationType = options.activationType ?? ROUTING_ACTIVATION_TYPE.DEFAULT;
    this.activationTimeoutMs = options.activationTimeoutMs ?? 3000;
    this.receiveTimeoutMs = options.receiveTimeoutMs ?? 5000;
    this.requireTls = options.requireTls ?? false;
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this.maxQueuedResponses = options.maxQueuedResponses ?? DEFAULT_MAX_QUEUED_RESPONSES;
  }

  /** Logical address the DoIP entity assigned us (from the routing activation response). */
  get assignedEntityAddress(): number | null {
    return this.entityLogicalAddress;
  }

  get isSecure(): boolean {
    return this.options.socket.isSecure?.() ?? false;
  }

  async connect(): Promise<void> {
    if (this.requireTls && !this.isSecure) {
      const reason = "TLS is required but the socket is not secure (ISO 13400-2 port 3496)";
      this.enter("error", reason, reason);
      throw new TransportError(reason);
    }
    this.enter("connecting", "opening the DoIP connection and activating routing");
    await this.options.socket.connect();
    this.unsubscribe = this.options.socket.onData((chunk) => this.onData(chunk));
    // A connection that dies must say so here, not in the next request's
    // timeout (ADR 0061). Both hooks are optional for sockets that cannot
    // report their own death (a browser WebSocket double, a scripted test).
    if (this.options.socket.onClose) {
      this.unsubscribeClose = this.options.socket.onClose((reason) => this.onSocketDeath(reason));
    }
    if (this.options.socket.onError) {
      this.unsubscribeSocketError = this.options.socket.onError((error) => {
        this.onSocketDeath(messageOf(error));
      });
    }
    try {
      await this.activateRouting();
    } catch (error) {
      // A refused or missing routing activation must not leave a half-open
      // transport behind — the socket would stay connected with a listener
      // still subscribed, and the next connect() attempt would report a stale
      // state instead of the real reason (same rule the workbench backend
      // follows for a failed start, AGENTS 35 "Error Handling").
      this.enter("error", messageOf(error), this.lastError ?? messageOf(error));
      await this.releaseSocket();
      throw error;
    }
    this.enter("connected", "routing activated");
    this.log.info("DoIP routing activated", {
      tester: `0x${this.testerAddress.toString(16)}`,
      target: `0x${this.targetAddress.toString(16)}`,
      secure: this.isSecure,
    });
  }

  async disconnect(): Promise<void> {
    await this.releaseSocket();
    this.enter("disconnected", "closed by the caller");
  }

  /**
   * The connection died. Record the reason, refuse further sends and — the part
   * that used to be missing — settle what is in flight with the *cause* instead
   * of letting it run into its own timeout.
   */
  private onSocketDeath(reason: string): void {
    if (this.state === "disconnected") return;
    this.enter(
      "error",
      `the DoIP connection died: ${reason}`,
      `the DoIP connection died: ${reason}`,
    );
    this.log.warn("DoIP connection lost", {
      target: `0x${this.targetAddress.toString(16)}`,
      reason,
    });
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeClose?.();
    this.unsubscribeClose = null;
    this.unsubscribeSocketError?.();
    this.unsubscribeSocketError = null;
    this.buffer = new Uint8Array();
    this.settleWaiters(new TransportClosedError(`the DoIP connection died: ${reason}`));
  }

  /** Settle everything waiting with one error — a dead link has no answers. */
  private settleWaiters(error: Error): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters = [];
    for (const waiter of this.routingWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    this.routingWaiters = [];
  }

  /**
   * Drop the listener, close the socket and settle every pending waiter with
   * `null` — the callers see "no answer" instead of a promise that never
   * resolves. A socket that refuses to close is logged, not rethrown: the
   * transport is on its way out either way (AGENTS 34.25, no silent catch).
   */
  private async releaseSocket(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeClose?.();
    this.unsubscribeClose = null;
    this.unsubscribeSocketError?.();
    this.unsubscribeSocketError = null;
    try {
      await this.options.socket.close();
    } catch (error) {
      this.log.debug("DoIP socket close failed", { error: messageOf(error) });
    }
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    this.waiters = [];
    for (const waiter of this.routingWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    this.routingWaiters = [];
  }

  async send(data: Uint8Array): Promise<void> {
    this.requireUsable("send");
    const payload = encodeDiagnosticMessage(this.testerAddress, this.targetAddress, data);
    this.txCount++;
    this.lastActivityAt = Date.now();
    this.log.raw("doip tx", { type: "diagnosticMessage", bytes: payload.length });
    try {
      await this.options.socket.send(encodeMessage(PAYLOAD_TYPE.DIAGNOSTIC_MESSAGE, payload));
    } catch (error) {
      // The write failed: the connection is gone even if nobody told us yet.
      // Report it through the same path as a peer-closed socket, so callers see
      // one reason for one failure (ADR 0061).
      this.onSocketDeath(messageOf(error));
      throw error;
    }
  }

  async receive(timeoutMs?: number): Promise<Uint8Array | null> {
    this.requireUsable("receive");
    const queued = this.queue.shift();
    if (queued) return queued;
    const limit = timeoutMs ?? this.receiveTimeoutMs;
    return new Promise<Uint8Array | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
        resolve(null);
      }, limit);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  /**
   * Refuse an operation on a link that cannot carry it, and say *why* it is down.
   *
   * The base message is unchanged (callers and tests match it), but the reason
   * the connection died is appended: "not connected" alone tells a technician
   * nothing about whether the car slept, the cable moved or routing was refused
   * (ADR 0061).
   */
  private requireUsable(operation: string): void {
    if (this.state === "connected" || this.state === "degraded") return;
    const reason = this.lastError ?? this.lastStateReason;
    throw new TransportClosedError(
      reason === undefined
        ? `DoIP transport is not connected (${operation})`
        : `DoIP transport is not connected: ${reason}`,
    );
  }

  getStatus(): ConnectionStatus {
    return {
      state: this.state,
      adapterId: "doip",
      detail: `DoIP target 0x${this.targetAddress.toString(16)}${this.isSecure ? " (TLS)" : ""}`,
      ...(this.lastStateReason !== undefined ? { stateReason: this.lastStateReason } : {}),
      txCount: this.txCount,
      rxCount: this.rxCount,
      ...(this.droppedRxCount > 0 ? { droppedRxCount: this.droppedRxCount } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.lastActivityAt ? { lastActivityAt: this.lastActivityAt } : {}),
      since: this.changedAt,
    };
  }

  private async activateRouting(): Promise<void> {
    const request = encodeMessage(
      PAYLOAD_TYPE.ROUTING_ACTIVATION_REQUEST,
      encodeRoutingActivationRequest(this.testerAddress, this.activationType),
    );
    // Register the waiter before sending: a peer (or a test double) may answer
    // synchronously inside send(), and an unregistered waiter would drop it.
    const responsePromise = this.waitForPayload(
      PAYLOAD_TYPE.ROUTING_ACTIVATION_RESPONSE,
      this.activationTimeoutMs,
    );
    await this.options.socket.send(request);
    const response = await responsePromise;
    if (!response) throw new TransportError("no routing activation response within the timeout");
    const decoded = decodeRoutingActivationResponse(response);
    if (decoded.code !== 0x10) {
      const reason = `routing activation refused: ${decoded.codeName}`;
      this.enter("error", reason, reason);
      throw new TransportError(reason, { code: decoded.code, codeName: decoded.codeName });
    }
    this.entityLogicalAddress = decoded.entityLogicalAddress;
  }

  private waitForPayload(payloadType: number, timeoutMs: number): Promise<Uint8Array | null> {
    return new Promise<Uint8Array | null>((resolve) => {
      const timer = setTimeout(() => {
        this.routingWaiters = this.routingWaiters.filter((w) => w.resolve !== resolve);
        resolve(null);
      }, timeoutMs);
      this.routingWaiters.push({ payloadType, resolve, timer });
    });
  }

  private routingWaiters: Array<{
    payloadType: number;
    resolve: (payload: Uint8Array | null) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  private onData(chunk: Uint8Array): void {
    this.buffer = concat(this.buffer, chunk);
    // Defense in depth against a huge single chunk: once the buffer exceeds
    // the largest allowed message plus its header, no valid message can live
    // inside it — reset before we grow without bound.
    if (this.buffer.length > this.maxMessageBytes + DOIP_HEADER_LENGTH) {
      const reason = `DoIP reassembly buffer exceeded ${
        this.maxMessageBytes + DOIP_HEADER_LENGTH
      } bytes — framing dropped`;
      this.lastError = reason;
      this.log.error(reason);
      this.buffer = new Uint8Array();
      return;
    }
    for (;;) {
      if (this.buffer.length < DOIP_HEADER_LENGTH) return;
      let header: DoipHeader;
      try {
        header = decodeHeader(this.buffer);
      } catch (error) {
        this.lastError = messageOf(error);
        this.log.error("DoIP framing error", { error: this.lastError });
        this.buffer = new Uint8Array();
        return;
      }
      // The declared length is peer data, not a contract: a hostile entity can
      // claim gigabytes and trickle bytes. The reassembly buffer must not
      // follow that declaration (unbounded growth under a sustained flood).
      const total = DOIP_HEADER_LENGTH + header.payloadLength;
      if (total > this.maxMessageBytes) {
        const reason = `DoIP message declares ${header.payloadLength} payload bytes, above the ${
          this.maxMessageBytes
        } byte cap — framing dropped`;
        this.lastError = reason;
        this.log.error(reason);
        this.buffer = new Uint8Array();
        return;
      }
      if (this.buffer.length < total) return;
      const payload = this.buffer.subarray(DOIP_HEADER_LENGTH, total).slice();
      // Copy so the underlying buffer is not aliased by later appends.
      this.buffer = new Uint8Array(this.buffer.subarray(total));
      this.rxCount++;
      this.lastActivityAt = Date.now();
      this.handleMessage(header.payloadType, payload);
    }
  }

  private handleMessage(payloadType: number, payload: Uint8Array): void {
    const routingWaiter = this.routingWaiters.find((w) => w.payloadType === payloadType);
    if (routingWaiter) {
      this.routingWaiters = this.routingWaiters.filter((w) => w !== routingWaiter);
      clearTimeout(routingWaiter.timer);
      routingWaiter.resolve(payload);
      return;
    }

    switch (payloadType) {
      case PAYLOAD_TYPE.DIAGNOSTIC_MESSAGE: {
        const decoded = decodeDiagnosticMessage(payload);
        this.log.raw("doip rx", {
          type: "diagnosticMessage",
          from: `0x${decoded.sourceAddress.toString(16)}`,
        });
        // This transport is a 1:1 link to one target ECU (ISO 13400-2): a
        // diagnostic message is only ours when the entity says it came from the
        // ECU we addressed and is addressed to us. A message from any other
        // logical address — another ECU's unsolicited traffic, or an entity
        // that forwards forged addresses — must not be delivered, because the
        // UDS layer above treats the next message it receives as the answer to
        // the request it just sent. Dropping it (with the proof logged) is the
        // only attribution-safe choice.
        if (
          decoded.sourceAddress !== this.targetAddress ||
          decoded.targetAddress !== this.testerAddress
        ) {
          this.log.warn("diagnostic message from an unexpected address — dropped", {
            from: `0x${decoded.sourceAddress.toString(16)}`,
            to: `0x${decoded.targetAddress.toString(16)}`,
            expectedFrom: `0x${this.targetAddress.toString(16)}`,
            expectedTo: `0x${this.testerAddress.toString(16)}`,
          });
          return;
        }
        this.deliver(decoded.udsPayload);
        return;
      }
      case PAYLOAD_TYPE.DIAGNOSTIC_MESSAGE_POSITIVE_ACK: {
        const ack = decodeDiagnosticAck(payload);
        this.log.trace("diagnostic message acknowledged", { ackCode: ack.ackCode });
        return;
      }
      case PAYLOAD_TYPE.DIAGNOSTIC_MESSAGE_NEGATIVE_ACK: {
        const ack = decodeDiagnosticAck(payload);
        // A NACK is *data*, not a broken link (the existing suite pins that): the
        // entity is reachable and refused this one message. It is recorded as the
        // last error so a report can name it, and the state stays `connected` —
        // `degraded` is reserved for a link that carried a failure and survived.
        this.lastError = `diagnostic message negative ack 0x${ack.ackCode.toString(16)}`;
        this.log.warn(this.lastError);
        return;
      }
      case PAYLOAD_TYPE.GENERIC_NACK: {
        const code = payload[0] ?? 0;
        this.lastError = `DoIP generic NACK 0x${code.toString(16)}`;
        this.log.error(this.lastError);
        return;
      }
      case PAYLOAD_TYPE.ALIVE_CHECK_REQUEST: {
        // Answer with our tester address so the entity keeps the connection.
        void this.options.socket
          .send(
            encodeMessage(
              PAYLOAD_TYPE.ALIVE_CHECK_RESPONSE,
              new Uint8Array([(this.testerAddress >> 8) & 0xff, this.testerAddress & 0xff]),
            ),
          )
          .catch((error) =>
            this.log.warn("alive check response failed", { error: messageOf(error) }),
          );
        return;
      }
      default:
        this.log.debug("unhandled DoIP payload type", {
          payloadType: `0x${payloadType.toString(16)}`,
        });
    }
  }

  private deliver(payload: Uint8Array): void {
    if (this.state === "degraded") this.enter("connected", "answers are arriving again");
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(payload);
      return;
    }
    if (this.queue.length >= this.maxQueuedResponses) {
      // The consumer is not keeping up (or the peer floods): the queue must not
      // grow without bound. The oldest queued answer is the least likely to
      // belong to the request the caller is making next, so it goes — and the
      // loss is named, not hidden (a dropped UDS answer is data loss).
      this.queue.shift();
      this.droppedRxCount++;
      this.log.warn("response queue overflow — oldest queued answer dropped", {
        queued: this.queue.length,
        dropped: this.droppedRxCount,
      });
    }
    this.queue.push(payload);
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export { DOIP_TLS_PORT, DOIP_UDP_PORT, encodeHeader, ProtocolError };
