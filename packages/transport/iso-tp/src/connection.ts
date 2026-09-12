/**
 * ISO 15765-2 (ISO-TP / DoCAN) connection.
 *
 * Responsibilities (AGENTS 7): Single Frame, First Frame, Consecutive Frame,
 * Flow Control, timeouts (N_Bs/N_Cr), retries, error states.
 * Nothing above this layer sees CAN frames; nothing here interprets UDS.
 */

import {
  IsoTpError,
  type Logger,
  TransportError,
  concatBytes,
  createLogger,
  messageOf,
} from "@vdp/shared";
import { type CanBus, type CanFrame, createFrame } from "@vdp/transport-can";
import {
  DEFAULT_TIMING,
  FLOW_STATUS,
  FRAME_TYPE,
  type IsoTpOptions,
  type IsoTpTiming,
  encodeStMin,
  parseStMin,
} from "./params.js";

export interface IsoTpStats {
  txFrames: number;
  rxFrames: number;
  /** Single Frames sent / received. */
  txSingleFrames: number;
  rxSingleFrames: number;
  /** Segmented messages sent / reassembled messages received. */
  txMultiFrameMessages: number;
  rxMultiFrameMessages: number;
  /** Flow Control frames sent / received. */
  txFlowControlFrames: number;
  rxFlowControlFrames: number;
  timeouts: number;
  retries: number;
  sequenceErrors: number;
}

const FC_QUEUE_LIMIT = 16;

interface FlowControlFrame {
  status: number;
  blockSize: number;
  stMinMs: number;
}

interface RxState {
  expectedLength: number;
  chunks: Uint8Array[];
  received: number;
  nextSequence: number;
  lastFrameAt: number;
  /** Consecutive frames received since the last Flow Control we sent. */
  blockCount: number;
}

interface PendingRequest {
  /** Monotonic id so a timeout can tell whether the slot still belongs to it. */
  id: number;
  resolve: (payload: Uint8Array) => void;
  reject: (error: unknown) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class IsoTpConnection {
  readonly timing: IsoTpTiming;
  readonly stats: IsoTpStats = {
    txFrames: 0,
    rxFrames: 0,
    txSingleFrames: 0,
    rxSingleFrames: 0,
    txMultiFrameMessages: 0,
    rxMultiFrameMessages: 0,
    txFlowControlFrames: 0,
    rxFlowControlFrames: 0,
    timeouts: 0,
    retries: 0,
    sequenceErrors: 0,
  };

  private readonly bus: CanBus;
  private readonly options: IsoTpOptions;
  private readonly log: Logger;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly mtu: number;
  private rxState: RxState | null = null;
  private pending: PendingRequest | null = null;
  private unsubscribe: (() => void) | null = null;
  private unsolicitedListeners: Array<(payload: Uint8Array) => void> = [];
  private transmitLock: Promise<unknown> = Promise.resolve();

  constructor(bus: CanBus, options: IsoTpOptions, logger?: Logger) {
    this.bus = bus;
    this.options = options;
    this.timing = { ...DEFAULT_TIMING, ...(options.timing ?? {}) };
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => Date.now());
    this.log = (logger ?? createLogger("isotp", { level: "INFO" })).child("isotp");
    this.mtu = options.fd && bus.capabilities.canFd ? 64 : 8;
  }

  /** Effective payload of one frame after PCI/address-extension bytes. */
  get framePayloadCapacity(): number {
    const addressingOverhead = this.options.addressing === "extended" ? 1 : 0;
    return this.mtu - addressingOverhead;
  }

  open(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.bus.subscribe(
      (frame) => this.handleFrame(frame),
      [{ id: this.options.rxId, mask: this.options.extended ? 0x1fffffff : 0x7ff }],
    );
    this.log.debug("ISO-TP open", {
      txId: hex(this.options.txId),
      rxId: hex(this.options.rxId),
      mtu: this.mtu,
    });
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.failPending(new IsoTpError("ISO-TP connection closed"));
    // Everything waiting on the *send* side has to be released as well, or the
    // serialisation queue keeps a transaction that can never finish: Flow Control
    // waiters are settled with a close reason, the lock is handed an already resolved
    // promise so the next open() starts clean, and a waiting receive() gets its answer
    // instead of hanging for the rest of its timeout (§34.26).
    for (const waiter of this.fcWaiters.splice(0)) waiter(null);
    // A write that never returns is abandoned as well, and every transaction that was
    // still queued behind it is invalidated instead of being run on a closed socket.
    for (const abort of this.writeWaiters.splice(0))
      abort(new IsoTpError("ISO-TP connection closed while a frame was being written"));
    this.queueGeneration++;
    this.fcQueue = [];
    this.rxState = null;
    this.transmitLock = Promise.resolve();
    for (const wake of this.receiveWaiters.splice(0)) wake();
  }

  onUnsolicited(listener: (payload: Uint8Array) => void): () => void {
    this.unsolicitedListeners.push(listener);
    return () => {
      this.unsolicitedListeners = this.unsolicitedListeners.filter((l) => l !== listener);
    };
  }

  /** Send + wait for the matching response. Requests are serialised (AGENTS 15: UDS forbids parallel requests per session). */
  request(payload: Uint8Array, timeoutMs?: number): Promise<Uint8Array> {
    this.open();
    return this.enqueue(() => this.requestExclusive(payload, timeoutMs));
  }

  /**
   * Fire-and-forget transmission (functional addressing / suppress-positive-response).
   * Also under the serialisation lock: two transmissions from one connection
   * interleaving on the wire do not produce two messages but one corrupted pair, and
   * cutting a frame into somebody else's First/Consecutive sequence is AGENTS 15
   * broken at the transport level.
   */
  sendOnly(payload: Uint8Array): Promise<void> {
    this.open();
    return this.enqueue(() => this.transmit(payload));
  }

  /** Counts closes, so a transaction queued before one never runs after it. */
  private queueGeneration = 0;

  /** One transaction at a time per connection, whatever kind of transaction it is. */
  private async enqueue<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.transmitLock;
    const generation = this.queueGeneration;
    let release!: () => void;
    this.transmitLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      if (generation !== this.queueGeneration) {
        throw new IsoTpError("ISO-TP connection was closed while this transaction was queued", {
          serialised: true,
          closed: true,
        });
      }
      return await task();
    } finally {
      // Also on the refusal above: a queue slot that is not released is the exact wedge
      // this whole path exists to prevent, and everything behind it would inherit it.
      release();
    }
  }

  /**
   * Wait for the next ISO-TP message that is not the answer to a pending request.
   * Needed by the UDS layer for the ISO 14229-2 "Response Pending" (NRC 0x78) flow,
   * where the final response arrives as a separate message after P2*Client.
   */
  receive(timeoutMs?: number): Promise<Uint8Array | null> {
    this.open();
    const limit = timeoutMs ?? this.timing.nCrMs;
    let wake: () => void = () => undefined;
    // Listening starts at the moment of the call — a message that arrives one
    // microtask later must not be missed — while the queue claim below keeps every
    // other transaction off the wire until the answer has been delivered.
    const awaited = new Promise<Uint8Array | null>((resolve) => {
      const finish = (value: Uint8Array | null): void => {
        clearTimeout(timer);
        const index = this.receiveWaiters.indexOf(wake);
        if (index >= 0) this.receiveWaiters.splice(index, 1);
        off();
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), limit);
      wake = () => finish(null);
      this.receiveWaiters.push(wake);
      const off = this.onUnsolicited((payload) => finish(payload));
    });
    return this.enqueue(() => awaited);
  }

  /** Receivers waiting for an unsolicited message; woken by close(). */
  private readonly receiveWaiters: Array<() => void> = [];

  private async requestExclusive(payload: Uint8Array, timeoutMs?: number): Promise<Uint8Array> {
    const deadline = timeoutMs ?? this.timing.nBsMs + this.timing.nCrMs * 4;
    let attempt = 0;
    // Retries cover both directions: an N_Bs timeout happens while transmitting
    // (no Flow Control arrived), an N_Cr/response timeout while waiting
    // (AGENTS 7 "Timeouts" + "Retries").
    for (;;) {
      const responsePromise = this.awaitResponse(deadline);
      // If the transmit side fails and we retry, this promise is abandoned —
      // mark it handled so it cannot surface as an unhandled rejection.
      responsePromise.catch(() => undefined);
      try {
        await this.transmit(payload);
        return await responsePromise;
      } catch (error) {
        this.failPending(error);
        if (attempt >= this.timing.maxRetries || !isRetryable(error)) throw error;
        attempt++;
        this.stats.retries++;
        this.log.warn("retrying ISO-TP request", { attempt, reason: messageOf(error) });
        await this.sleep(this.timing.nAsMs);
      }
    }
  }

  private pendingSequence = 0;

  private awaitResponse(timeoutMs: number): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      if (this.pending) {
        // One slot per connection is what makes a response reach the right requester.
        // Filling it twice means something bypassed the serialisation lock — instead of
        // silently orphaning the first request until its timeout, fail it and log it.
        const stale = this.pending;
        this.pending = null;
        this.log.error(
          "ISO-TP response slot reused while a request is still open — serialisation bypassed",
          {
            txId: this.options.txId,
            rxId: this.options.rxId,
          },
        );
        stale.reject(
          new IsoTpError("another request took over while this one awaited its response", {
            serialised: false,
          }),
        );
      }
      const id = ++this.pendingSequence;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (this.pending?.id === id) this.pending = null;
        this.stats.timeouts++;
        reject(
          new IsoTpError(`ISO-TP response timeout after ${timeoutMs} ms`, {
            timeoutMs,
            timeout: "response",
          }),
        );
      }, timeoutMs);
      this.pending = {
        id,
        resolve: (payload) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(payload);
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      };
    });
  }

  private failPending(error: unknown): void {
    this.pending?.reject(error);
    this.pending = null;
  }

  /**
   * Largest payload a Single Frame can carry. On classic CAN the PCI nibble states the
   * length, so 7 of 8 usable bytes; on CAN FD the escape form (PCI 0x00 plus an
   * explicit length byte) reaches capacity - 2. Anything larger is a multi-frame
   * message — choosing the frame by what fits, instead of demanding a Single Frame and
   * throwing, is what keeps a 63-byte FD payload sendable at all.
   */
  private get singleFrameCapacity(): number {
    const capacity = this.framePayloadCapacity;
    return capacity > 8 ? capacity - 2 : Math.min(capacity - 1, 7);
  }

  private async transmit(payload: Uint8Array): Promise<void> {
    if (payload.length <= this.singleFrameCapacity) {
      await this.sendSingleFrame(payload);
      return;
    }
    await this.sendMultiFrame(payload);
  }

  private async sendSingleFrame(payload: Uint8Array): Promise<void> {
    // A Single Frame carries the length in the low nibble (1..7 on classic CAN).
    // Longer payloads need the escape form: PCI 0x00 + explicit length byte
    // (ISO 15765-2 §9.4.2), only available when the frame has room for it.
    const needsEscape = payload.length > 7;
    if (needsEscape && payload.length > this.framePayloadCapacity - 2) {
      throw new IsoTpError(
        `payload of ${payload.length} bytes does not fit a Single Frame on this MTU`,
        {
          payloadLength: payload.length,
          capacity: this.framePayloadCapacity,
        },
      );
    }
    const header = needsEscape
      ? [FRAME_TYPE.SINGLE, payload.length]
      : [FRAME_TYPE.SINGLE | (payload.length & 0x0f)];
    const body = new Uint8Array(header.length + payload.length);
    body.set(header, 0);
    body.set(payload, header.length);
    await this.writeFrame(this.padded(body));
    this.stats.txSingleFrames++;
  }

  private async sendMultiFrame(payload: Uint8Array): Promise<void> {
    const capacity = this.framePayloadCapacity;
    const length = payload.length;
    // Drop any Flow Control left over from a previous transmission.
    this.fcQueue = [];
    this.waitCount = 0;

    const ffHeader =
      length > 0xfff
        ? [
            FRAME_TYPE.FIRST,
            0x00,
            (length >>> 24) & 0xff,
            (length >>> 16) & 0xff,
            (length >>> 8) & 0xff,
            length & 0xff,
          ]
        : [FRAME_TYPE.FIRST | ((length >>> 8) & 0x0f), length & 0xff];
    const firstChunkLength = Math.min(capacity - ffHeader.length, length);
    const first = new Uint8Array(ffHeader.length + firstChunkLength);
    first.set(ffHeader, 0);
    first.set(payload.subarray(0, firstChunkLength), ffHeader.length);
    await this.writeFrame(this.padded(first));

    const fc = await this.awaitFlowControl();
    let offset = firstChunkLength;
    let sequence = 1;
    let inBlock = 0;
    let currentBlock = fc.blockSize;
    let stMin = fc.stMinMs;

    while (offset < length) {
      const chunkLength = Math.min(capacity - 1, length - offset);
      const frame = new Uint8Array(1 + chunkLength);
      frame[0] = FRAME_TYPE.CONSECUTIVE | (sequence & 0x0f);
      frame.set(payload.subarray(offset, offset + chunkLength), 1);
      await this.writeFrame(this.padded(frame));
      offset += chunkLength;
      sequence = (sequence + 1) & 0x0f;
      inBlock++;
      if (offset >= length) break;
      if (stMin > 0) await this.sleep(stMin);
      if (currentBlock > 0 && inBlock >= currentBlock) {
        const next = await this.awaitFlowControl();
        currentBlock = next.blockSize;
        stMin = next.stMinMs;
        inBlock = 0;
      }
    }
    this.stats.txMultiFrameMessages++;
  }

  /** Waiters for the next Flow Control; a `null` frame settles them as "closed". */
  private fcWaiters: Array<(fc: FlowControlFrame | null) => void> = [];
  /**
   * Flow Control frames can arrive before the sender has registered its waiter
   * (the bus may deliver synchronously), and several may pile up — e.g. repeated
   * "Wait" frames. They are queued FIFO instead of dropped, and the queue is
   * cleared at the start of every multi-frame transmission.
   */
  private fcQueue: FlowControlFrame[] = [];
  private waitCount = 0;

  private awaitFlowControl(): Promise<FlowControlFrame> {
    return new Promise<FlowControlFrame>((resolve, reject) => {
      const settle = (fc: FlowControlFrame): void => {
        if (fc.status === FLOW_STATUS.WAIT) {
          // ISO 15765-2: WFTmax exceeded → abort (receiver too slow).
          this.waitCount += 1;
          if (this.waitCount > this.timing.wftMax) {
            this.stats.timeouts++;
            reject(
              new IsoTpError("WFTmax exceeded while waiting for Flow Control", {
                timeout: "WFTmax",
              }),
            );
            return;
          }
          this.awaitFlowControl().then(resolve, reject);
          return;
        }
        if (fc.status === FLOW_STATUS.OVERFLOW) {
          reject(
            new IsoTpError("Flow Control reported buffer overflow — message too long for receiver"),
          );
          return;
        }
        this.waitCount = 0;
        resolve(fc);
      };

      const buffered = this.fcQueue.shift();
      if (buffered) {
        settle(buffered);
        return;
      }

      const waiter = (fc: FlowControlFrame | null): void => {
        clearTimeout(timer);
        if (!fc) {
          reject(
            new IsoTpError("ISO-TP connection closed while waiting for a Flow Control frame", {
              timeout: "N_Bs",
            }),
          );
          return;
        }
        settle(fc);
      };
      const timer = setTimeout(() => {
        this.fcWaiters = this.fcWaiters.filter((w) => w !== waiter);
        this.stats.timeouts++;
        reject(
          new IsoTpError(`N_Bs timeout: no Flow Control frame within ${this.timing.nBsMs} ms`, {
            timeout: "N_Bs",
          }),
        );
      }, this.timing.nBsMs);
      this.fcWaiters.push(waiter);
    });
  }

  private padded(body: Uint8Array): Uint8Array {
    const addressingOverhead = this.options.addressing === "extended" ? 1 : 0;
    const target = this.options.padding ? this.mtu - addressingOverhead : body.length;
    if (body.length >= target) return body;
    const out = new Uint8Array(target);
    out.set(body, 0);
    out.fill(this.options.padByte ?? 0xaa, body.length);
    return out;
  }

  private async writeFrame(body: Uint8Array): Promise<void> {
    const withAddress =
      this.options.addressing === "extended"
        ? concatBytes([new Uint8Array([this.options.targetAddress ?? 0x00]), body])
        : body;
    const frame = createFrame(this.options.txId, withAddress, {
      extended: this.options.extended ?? this.options.txId > 0x7ff,
      fd: this.options.fd ?? false,
      channel: this.options.channel ?? this.bus.info.channels[0] ?? "can0",
      timestamp: this.now(),
      direction: "tx",
    });
    this.stats.txFrames++;
    this.log.raw("isotp tx", { id: hex(frame.id), data: frame.payload });
    // Bound the hand-off to the adapter: a `send()` that never settles used to keep the
    // serialisation lock — and every request behind it — pending for as long as the
    // cable stayed half-dead (§34.26). A rejection is still reported the same way.
    const limit = this.timing.sendTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let detach: () => void = () => undefined;
    try {
      const write = Promise.resolve(this.bus.send(frame));
      // A stall timer *and* close() both have to reach a write that is already in
      // flight: without this, a teardown leaves the caller waiting for the stall timeout.
      const aborted = new Promise<never>((_, reject) => {
        const waiter = (reason: Error): void => reject(reason);
        this.writeWaiters.push(waiter);
        detach = () => {
          const index = this.writeWaiters.indexOf(waiter);
          if (index >= 0) this.writeWaiters.splice(index, 1);
        };
        if (limit > 0) {
          timer = setTimeout(
            () =>
              reject(
                new TransportError(
                  `ISO-TP transmit stalled: the adapter did not accept the frame within ${limit} ms`,
                  { cause: "N_As", txId: this.options.txId },
                ),
              ),
            limit,
          );
        }
      });
      await Promise.race([write, aborted]);
    } catch (error) {
      throw new TransportError(`ISO-TP transmit failed: ${messageOf(error)}`, {
        cause: messageOf(error),
      });
    } finally {
      clearTimeout(timer);
      detach();
    }
  }

  /** In-flight adapter writes; close() rejects them so the queue cannot outlive the connection. */
  private readonly writeWaiters: Array<(reason: Error) => void> = [];

  private handleFrame(frame: CanFrame): void {
    this.stats.rxFrames++;
    this.log.raw("isotp rx", { id: hex(frame.id), data: frame.payload });
    let body = frame.payload;
    if (this.options.addressing === "extended") {
      if (body.length < 2) return;
      const address = body[0] ?? 0;
      if (this.options.sourceAddress !== undefined && address !== this.options.sourceAddress)
        return;
      body = body.subarray(1);
    }
    const pci = body[0] ?? 0;
    const type = pci & 0xf0;

    if (type === FRAME_TYPE.SINGLE) {
      const length = pci & 0x0f;
      const payload =
        length === 0 ? body.subarray(2, 2 + (body[1] ?? 0)) : body.subarray(1, 1 + length);
      this.stats.rxSingleFrames++;
      this.rxState = null;
      this.deliver(payload.slice());
      return;
    }

    if (type === FRAME_TYPE.FIRST) {
      // FF_DL is a 12-bit field: low nibble of the PCI plus the next byte.
      // FF_DL == 0 selects the escape form where a 4-byte length follows
      // (ISO 15765-2 §9.5.2). Checking only the PCI nibble would misread every
      // message whose length is below 256 bytes.
      const ffDl = ((pci & 0x0f) << 8) | (body[1] ?? 0);
      const escaped = ffDl === 0;
      const length = escaped
        ? ((body[2] ?? 0) << 24) | ((body[3] ?? 0) << 16) | ((body[4] ?? 0) << 8) | (body[5] ?? 0)
        : ffDl;
      const headerLength = escaped ? 6 : 2;
      const first = body.subarray(headerLength);
      this.rxState = {
        expectedLength: length,
        chunks: [first.slice()],
        received: first.length,
        nextSequence: 1,
        lastFrameAt: this.now(),
        blockCount: 0,
      };
      void this.sendFlowControl(FLOW_STATUS.CONTINUE_TO_SEND);
      return;
    }

    if (type === FRAME_TYPE.CONSECUTIVE) {
      const state = this.rxState;
      if (!state) {
        this.stats.sequenceErrors++;
        this.log.warn("Consecutive Frame without an active reception — dropped");
        return;
      }
      const sequence = pci & 0x0f;
      if (sequence !== state.nextSequence) {
        this.stats.sequenceErrors++;
        const error = new IsoTpError(
          `ISO-TP sequence error: expected ${state.nextSequence}, got ${sequence}`,
        );
        this.rxState = null;
        this.failPending(error);
        return;
      }
      const remaining = state.expectedLength - state.received;
      const chunk = body.subarray(1, 1 + Math.min(remaining, body.length - 1));
      state.chunks.push(chunk.slice());
      state.received += chunk.length;
      state.nextSequence = (state.nextSequence + 1) & 0x0f;
      state.lastFrameAt = this.now();
      state.blockCount++;
      if (state.received >= state.expectedLength) {
        const payload = concatBytes(state.chunks).subarray(0, state.expectedLength);
        this.rxState = null;
        this.stats.rxMultiFrameMessages++;
        this.deliver(payload.slice());
        return;
      }
      // BS > 0 means the sender must stop after that many consecutive frames and
      // wait for the next Flow Control (ISO 15765-2 §9.6.4). Advertising a block
      // size without enforcing it would let a sender overrun our buffer.
      const blockSize = this.timing.blockSize;
      if (blockSize > 0 && state.blockCount >= blockSize) {
        state.blockCount = 0;
        void this.sendFlowControl(FLOW_STATUS.CONTINUE_TO_SEND);
      }
      return;
    }

    if (type === FRAME_TYPE.FLOW_CONTROL) {
      this.stats.rxFlowControlFrames++;
      const fc: FlowControlFrame = {
        status: pci & 0x0f,
        blockSize: body[1] ?? 0,
        stMinMs: parseStMin(body[2] ?? 0),
      };
      const waiter = this.fcWaiters.shift();
      if (waiter) waiter(fc);
      else if (this.fcQueue.length < FC_QUEUE_LIMIT) this.fcQueue.push(fc);
      else
        this.log.warn("Flow Control queue overflow — frame dropped", {
          queueLength: this.fcQueue.length,
        });
      return;
    }

    this.log.debug("unknown ISO-TP PCI dropped", { pci });
  }

  private async sendFlowControl(status: number): Promise<void> {
    const body = new Uint8Array([
      FRAME_TYPE.FLOW_CONTROL | status,
      this.timing.blockSize & 0xff,
      encodeStMin(this.timing.stMinMs),
    ]);
    this.stats.txFlowControlFrames++;
    try {
      await this.writeFrame(body);
    } catch (error) {
      // This runs from the *receive* path, where nobody awaits us — a rejection would be
      // an unhandled one, i.e. a dead process over a log line. The sender of the First
      // Frame is not lost: its own N_Bs expires and it retries the whole message.
      this.log.warn("Flow Control could not be written", { status, error: messageOf(error) });
    }
  }

  private deliver(payload: Uint8Array): void {
    const pending = this.pending;
    if (pending) {
      this.pending = null;
      pending.resolve(payload);
      return;
    }
    for (const listener of this.unsolicitedListeners) listener(payload);
  }

  /** Abort an in-flight reception because N_Cr elapsed (called by tests/tooling). */
  checkCrTimeout(): boolean {
    const state = this.rxState;
    if (!state) return false;
    if (this.now() - state.lastFrameAt > this.timing.nCrMs) {
      this.rxState = null;
      this.stats.timeouts++;
      this.failPending(
        new IsoTpError(`N_Cr timeout: Consecutive Frame missing for ${this.timing.nCrMs} ms`, {
          timeout: "N_Cr",
        }),
      );
      return true;
    }
    return false;
  }

  /** Internal helper exposed for tests: number of frames needed for a payload. */
  frameCountFor(payloadLength: number): number {
    const capacity = this.framePayloadCapacity - 1;
    if (payloadLength <= capacity) return 1;
    const firstChunk = this.framePayloadCapacity - 2;
    return 1 + Math.ceil((payloadLength - firstChunk) / capacity);
  }
}

function isRetryable(error: unknown): boolean {
  return (
    error instanceof IsoTpError &&
    (error.details["timeout"] === "N_Bs" || error.details["timeout"] === "N_Cr")
  );
}

function hex(id: number): string {
  return `0x${id.toString(16).toUpperCase()}`;
}
