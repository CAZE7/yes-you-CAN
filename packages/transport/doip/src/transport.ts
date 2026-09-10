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

import { ProtocolError, TransportClosedError, TransportError, createLogger, type Logger } from '@vdp/shared';
import type { ConnectionStatus, VehicleTransport } from '@vdp/transport-can';
import {
  DOIP_HEADER_LENGTH,
  DOIP_TLS_PORT,
  DOIP_UDP_PORT,
  PAYLOAD_TYPE,
  ROUTING_ACTIVATION_TYPE,
  decodeDiagnosticAck,
  decodeDiagnosticMessage,
  decodeHeader,
  decodeRoutingActivationResponse,
  encodeDiagnosticMessage,
  encodeHeader,
  encodeMessage,
  encodeRoutingActivationRequest,
} from './message.js';

/** Minimal duplex socket contract so Node, browser and test doubles all fit. */
export interface DoipSocket {
  connect(): Promise<void>;
  send(data: Uint8Array): Promise<void>;
  onData(listener: (chunk: Uint8Array) => void): () => void;
  close(): Promise<void>;
  isOpen(): boolean;
  /** True when the socket provides TLS (ISO 13400-2 port 3496). */
  isSecure?(): boolean;
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
}

export class DoipTransport implements VehicleTransport {
  private readonly log: Logger;
  private readonly testerAddress: number;
  private readonly targetAddress: number;
  private readonly activationType: number;
  private readonly activationTimeoutMs: number;
  private readonly receiveTimeoutMs: number;
  private readonly requireTls: boolean;

  private buffer: Uint8Array = new Uint8Array();
  private unsubscribe: (() => void) | null = null;
  private queue: Uint8Array[] = [];
  private waiters: Array<{ resolve: (payload: Uint8Array | null) => void; timer: ReturnType<typeof setTimeout> }> = [];
  private state: ConnectionStatus['state'] = 'disconnected';
  private lastError: string | undefined;
  private lastActivityAt: number | undefined;
  private txCount = 0;
  private rxCount = 0;
  private entityLogicalAddress: number | null = null;

  constructor(private readonly options: DoipTransportOptions) {
    this.log = (options.logger ?? createLogger('connection', { level: 'INFO' })).child('connection');
    this.testerAddress = options.testerAddress ?? 0x0e00;
    this.targetAddress = options.targetAddress;
    this.activationType = options.activationType ?? ROUTING_ACTIVATION_TYPE.DEFAULT;
    this.activationTimeoutMs = options.activationTimeoutMs ?? 3000;
    this.receiveTimeoutMs = options.receiveTimeoutMs ?? 5000;
    this.requireTls = options.requireTls ?? false;
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
      this.state = 'error';
      this.lastError = 'TLS is required but the socket is not secure (ISO 13400-2 port 3496)';
      throw new TransportError(this.lastError);
    }
    this.state = 'connecting';
    await this.options.socket.connect();
    this.unsubscribe = this.options.socket.onData((chunk) => this.onData(chunk));
    await this.activateRouting();
    this.state = 'connected';
    this.log.info('DoIP routing activated', {
      tester: `0x${this.testerAddress.toString(16)}`,
      target: `0x${this.targetAddress.toString(16)}`,
      secure: this.isSecure,
    });
  }

  async disconnect(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.options.socket.close();
    this.state = 'disconnected';
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    this.waiters = [];
  }

  async send(data: Uint8Array): Promise<void> {
    if (this.state !== 'connected') throw new TransportClosedError('DoIP transport is not connected');
    const payload = encodeDiagnosticMessage(this.testerAddress, this.targetAddress, data);
    this.txCount++;
    this.lastActivityAt = Date.now();
    this.log.raw('doip tx', { type: 'diagnosticMessage', bytes: payload.length });
    await this.options.socket.send(encodeMessage(PAYLOAD_TYPE.DIAGNOSTIC_MESSAGE, payload));
  }

  async receive(timeoutMs?: number): Promise<Uint8Array | null> {
    if (this.state !== 'connected') throw new TransportClosedError('DoIP transport is not connected');
    const queued = this.queue.shift();
    if (queued) return queued;
    const limit = timeoutMs ?? this.receiveTimeoutMs;
    return new Promise<Uint8Array | null>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
        resolve(null);
      }, limit);
      this.waiters.push({ resolve, timer });
    });
  }

  getStatus(): ConnectionStatus {
    return {
      state: this.state,
      adapterId: 'doip',
      detail: `DoIP target 0x${this.targetAddress.toString(16)}${this.isSecure ? ' (TLS)' : ''}`,
      txCount: this.txCount,
      rxCount: this.rxCount,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.lastActivityAt ? { lastActivityAt: this.lastActivityAt } : {}),
    };
  }

  private async activateRouting(): Promise<void> {
    const request = encodeMessage(
      PAYLOAD_TYPE.ROUTING_ACTIVATION_REQUEST,
      encodeRoutingActivationRequest(this.testerAddress, this.activationType),
    );
    // Register the waiter before sending: a peer (or a test double) may answer
    // synchronously inside send(), and an unregistered waiter would drop it.
    const responsePromise = this.waitForPayload(PAYLOAD_TYPE.ROUTING_ACTIVATION_RESPONSE, this.activationTimeoutMs);
    await this.options.socket.send(request);
    const response = await responsePromise;
    if (!response) throw new TransportError('no routing activation response within the timeout');
    const decoded = decodeRoutingActivationResponse(response);
    if (decoded.code !== 0x10) {
      this.state = 'error';
      this.lastError = `routing activation refused: ${decoded.codeName}`;
      throw new TransportError(this.lastError, { code: decoded.code, codeName: decoded.codeName });
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

  private routingWaiters: Array<{ payloadType: number; resolve: (payload: Uint8Array | null) => void; timer: ReturnType<typeof setTimeout> }> = [];

  private onData(chunk: Uint8Array): void {
    this.buffer = concat(this.buffer, chunk);
    for (;;) {
      if (this.buffer.length < DOIP_HEADER_LENGTH) return;
      let header;
      try {
        header = decodeHeader(this.buffer);
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.log.error('DoIP framing error', { error: this.lastError });
        this.buffer = new Uint8Array();
        return;
      }
      const total = DOIP_HEADER_LENGTH + header.payloadLength;
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
        this.log.raw('doip rx', { type: 'diagnosticMessage', from: `0x${decoded.sourceAddress.toString(16)}` });
        this.deliver(decoded.udsPayload);
        return;
      }
      case PAYLOAD_TYPE.DIAGNOSTIC_MESSAGE_POSITIVE_ACK: {
        const ack = decodeDiagnosticAck(payload);
        this.log.trace('diagnostic message acknowledged', { ackCode: ack.ackCode });
        return;
      }
      case PAYLOAD_TYPE.DIAGNOSTIC_MESSAGE_NEGATIVE_ACK: {
        const ack = decodeDiagnosticAck(payload);
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
          .send(encodeMessage(PAYLOAD_TYPE.ALIVE_CHECK_RESPONSE, new Uint8Array([(this.testerAddress >> 8) & 0xff, this.testerAddress & 0xff])))
          .catch((error) => this.log.warn('alive check response failed', { error: messageOf(error) }));
        return;
      }
      default:
        this.log.debug('unhandled DoIP payload type', { payloadType: `0x${payloadType.toString(16)}` });
    }
  }

  private deliver(payload: Uint8Array): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(payload);
      return;
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { DOIP_UDP_PORT, DOIP_TLS_PORT, encodeHeader, ProtocolError };
