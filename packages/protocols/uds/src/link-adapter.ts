/**
 * Bridge from a byte-oriented transport to the UDS request/response model.
 *
 * `IsoTpConnection` already provides request/sendOnly/receive, so it can be used
 * directly. Transports that only offer `send`/`receive` — DoIP (ISO 13400), a
 * replay transport, a future gateway — get the same semantics from this adapter,
 * which keeps the UDS layer completely transport agnostic (AGENTS 5, 36).
 */

import { type Logger, TransportClosedError, createLogger } from "@vdp/shared";
import type { UdsLink } from "./link.js";

/** Structural subset of VehicleTransport — deliberately not importing it. */
export interface MessageTransport {
  send(data: Uint8Array): Promise<void>;
  receive(timeoutMs?: number): Promise<Uint8Array | null>;
}

export interface RequestResponseLinkOptions {
  /** Default response timeout when the caller does not pass one. */
  defaultTimeoutMs?: number;
  logger?: Logger;
}

export interface RequestResponseStats {
  requests: number;
  responses: number;
  timeouts: number;
}

export class RequestResponseLink implements UdsLink {
  readonly stats: RequestResponseStats = { requests: 0, responses: 0, timeouts: 0 };
  private readonly defaultTimeoutMs: number;
  private readonly log: Logger;
  /** Requests are serialised: UDS allows no parallel requests per session. */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly transport: MessageTransport,
    options: RequestResponseLinkOptions = {},
  ) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5000;
    this.log = (options.logger ?? createLogger("uds", { level: "WARN" })).child("uds");
  }

  async request(payload: Uint8Array, timeoutMs?: number): Promise<Uint8Array> {
    return this.enqueue(async () => {
      const limit = timeoutMs ?? this.defaultTimeoutMs;
      this.stats.requests++;
      await this.transport.send(payload);
      const response = await this.transport.receive(limit);
      if (!response) {
        this.stats.timeouts++;
        throw new TransportClosedError(`no response within ${limit} ms`, { timeoutMs: limit });
      }
      this.stats.responses++;
      return response;
    });
  }

  /** Functional requests and suppressed responses: sent, never answered — under the same lock. */
  async sendOnly(payload: Uint8Array): Promise<void> {
    await this.enqueue(() => this.transport.send(payload));
  }

  /**
   * The final response of a service that announced NRC 0x78. It is still the same
   * transaction, so the wait holds the lock: a TesterPresent released into that gap
   * would be answered with the payload this caller is waiting for.
   */
  async receive(timeoutMs?: number): Promise<Uint8Array | null> {
    return this.enqueue(() => this.transport.receive(timeoutMs));
  }

  /** One transaction at a time per link (AGENTS 15: UDS forbids parallel requests per session). */
  private async enqueue<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
    }
  }
}

export function createRequestResponseLink(
  transport: MessageTransport,
  options: RequestResponseLinkOptions = {},
): UdsLink {
  return new RequestResponseLink(transport, options);
}

export function isMessageTransport(candidate: unknown): candidate is MessageTransport {
  const value = candidate as Partial<MessageTransport> | null;
  return typeof value?.send === "function" && typeof value?.receive === "function";
}
