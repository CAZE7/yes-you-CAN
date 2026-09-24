/**
 * DoIP sockets on Node — the host half of the DoIP link (ISO 13400-2, master
 * prompt P2, ADR 0061).
 *
 * `@vdp/transport-doip` deliberately knows no `node:net`: it accepts a
 * {@link DoipSocket} and a {@link DoipDatagramSocket} and does not care whether
 * a test double, a browser WebSocket or a real TCP connection is behind them.
 * This module is where a real one comes from — sockets are host bindings, and
 * host bindings live in this package (`node:net` is allowed here, and nowhere
 * below).
 *
 * Two things are not optional on a real socket and were the reason this file
 * exists:
 *
 * - **`onClose` and `onError`.** A TCP connection to a vehicle ends when the
 *   vehicle ends it. Without a close notification the transport above kept
 *   claiming `connected` and the next request died in its own timeout — a
 *   sleeping car read exactly like an ECU that answers nothing (ADR 0060/0061).
 * - **A connect timeout.** A DoIP entity that stopped answering still has a
 *   socket; `net.connect` waits for the OS, which takes ~2 minutes on a dropped
 *   route. The connect is bounded here and the reason names the timeout.
 */

import { createSocket as createUdpSocket, type Socket as UdpSocket } from "node:dgram";
import { createConnection, type Socket } from "node:net";
import { createLogger, type Logger, messageOf, TransportError } from "@vdp/shared";
import type { DoipDatagramSocket, DoipSocket } from "@vdp/transport-doip";

export interface DoipTcpSocketOptions {
  host: string;
  /** TCP port of the entity (13400 plaintext, 3496 TLS — ISO 13400-2). */
  port?: number;
  /** Bound on the TCP handshake (default 5000 ms). */
  connectTimeoutMs?: number;
  logger?: Logger;
}

/** Default DoIP TCP port (ISO 13400-2). */
export const DOIP_TCP_PORT = 13400;

/**
 * A real TCP socket in the DoIP socket contract.
 *
 * `isSecure()` is `false` here: this binding speaks plaintext TCP, which is what
 * ISO 13400-2 calls the non-TLS channel. A TLS channel needs a `tls.connect`
 * socket — the same contract, and `requireTls` on the transport refuses the
 * plaintext one instead of pretending (AGENTS 26).
 */
export function createDoipTcpSocket(options: DoipTcpSocketOptions): DoipSocket {
  const log = (options.logger ?? createLogger("connection", { level: "INFO" })).child("connection");
  const port = options.port ?? DOIP_TCP_PORT;
  const connectTimeoutMs = options.connectTimeoutMs ?? 5000;
  let socket: Socket | null = null;
  const dataListeners = new Set<(chunk: Uint8Array) => void>();
  const closeListeners = new Set<(reason: string) => void>();
  const errorListeners = new Set<(error: Error) => void>();

  const announceDeath = (reason: string): void => {
    for (const listener of closeListeners) listener(reason);
  };

  return {
    async connect(): Promise<void> {
      if (socket !== null) return;
      const created = createConnection({ host: options.host, port });
      socket = created;
      created.on("data", (chunk: Buffer) => {
        const bytes = new Uint8Array(chunk);
        for (const listener of dataListeners) listener(bytes);
      });
      created.on("error", (error: Error) => {
        for (const listener of errorListeners) listener(error);
        // A socket error is also a closed connection: subscribers must not have
        // to wait for the 'close' event that may never come.
        announceDeath(messageOf(error));
      });
      created.on("close", () => announceDeath("the peer closed the connection"));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          created.destroy();
          reject(
            new TransportError(
              `no DoIP entity answered at ${options.host}:${port} within ${connectTimeoutMs} ms`,
              { host: options.host, port, connectTimeoutMs },
            ),
          );
        }, connectTimeoutMs);
        created.once("connect", () => {
          clearTimeout(timer);
          resolve();
        });
        created.once("error", (error: Error) => {
          clearTimeout(timer);
          reject(
            new TransportError(`cannot reach the DoIP entity at ${options.host}:${port}`, {
              host: options.host,
              port,
              cause: messageOf(error),
            }),
          );
        });
      });
      log.debug("DoIP TCP socket connected", { host: options.host, port });
    },

    async send(data: Uint8Array): Promise<void> {
      const active = socket;
      if (active === null || active.destroyed) {
        const failure = new TransportError("the DoIP socket is not connected");
        for (const listener of errorListeners) listener(failure);
        throw failure;
      }
      await new Promise<void>((resolve, reject) => {
        active.write(data, (error) => {
          if (!error) {
            resolve();
            return;
          }
          // A write that failed means the connection is unusable — the same
          // message a peer close carries, reported through the same listeners,
          // so the transport above has exactly one reason for one failure
          // (ADR 0061).
          const failure = new TransportError(`DoIP write failed: ${messageOf(error)}`);
          for (const listener of errorListeners) listener(failure);
          reject(failure);
        });
      });
    },

    onData(listener: (chunk: Uint8Array) => void): () => void {
      dataListeners.add(listener);
      return () => {
        dataListeners.delete(listener);
      };
    },

    onClose(listener: (reason: string) => void): () => void {
      closeListeners.add(listener);
      return () => {
        closeListeners.delete(listener);
      };
    },

    onError(listener: (error: Error) => void): () => void {
      errorListeners.add(listener);
      return () => {
        errorListeners.delete(listener);
      };
    },

    async close(): Promise<void> {
      const active = socket;
      socket = null;
      if (active === null) return;
      await new Promise<void>((resolve) => {
        active.once("close", () => resolve());
        active.end();
        // A peer that does not acknowledge the FIN must not hang teardown.
        setTimeout(() => {
          active.destroy();
          resolve();
        }, 500).unref?.();
      });
    },

    isOpen(): boolean {
      return socket !== null && !socket.destroyed && socket.readyState === "open";
    },

    isSecure(): boolean {
      return false;
    },
  };
}

/**
 * A UDP socket for ISO 13400-2 discovery: broadcast the identification request,
 * listen for announcements.
 *
 * `broadcast()` writes to the configured target (the subnet broadcast address,
 * `255.255.255.255` by default); discovery is a listen window, not a handshake.
 */
export function createDoipUdpSocket(options: {
  /** Local port to listen on; 0 lets the OS choose (default 13400). */
  port?: number;
  /** Where the identification request goes (default 255.255.255.255). */
  broadcastAddress?: string;
  broadcastPort?: number;
  logger?: Logger;
}): DoipDatagramSocket {
  const log = (options.logger ?? createLogger("connection", { level: "INFO" })).child("connection");
  const socket: UdpSocket = createUdpSocket({ type: "udp4", reuseAddr: true });
  const listeners = new Set<(chunk: Uint8Array) => void>();
  let bound = false;

  socket.on("message", (message: Buffer) => {
    const bytes = new Uint8Array(message);
    for (const listener of listeners) listener(bytes);
  });
  socket.on("error", (error: Error) => {
    log.warn("DoIP UDP socket error", { error: messageOf(error) });
  });

  const bind = async (): Promise<void> => {
    if (bound) return;
    await new Promise<void>((resolve, reject) => {
      socket.bind(options.port ?? 13400, () => {
        socket.setBroadcast(true);
        bound = true;
        resolve();
      });
      socket.once("error", (error: Error) =>
        reject(new TransportError(`cannot bind the DoIP discovery port: ${messageOf(error)}`)),
      );
    });
  };

  return {
    async broadcast(data: Uint8Array): Promise<void> {
      await bind();
      await new Promise<void>((resolve, reject) => {
        socket.send(
          data,
          options.broadcastPort ?? 13400,
          options.broadcastAddress ?? "255.255.255.255",
          (error) => {
            if (error) reject(new TransportError(`DoIP broadcast failed: ${messageOf(error)}`));
            else resolve();
          },
        );
      });
    },
    onData(listener: (chunk: Uint8Array) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    },
  };
}
