/**
 * The real DoIP sockets (ADR 0061) — pinned against a plain TCP/UDP server.
 *
 * These are the branches a test double never reaches and a real vehicle does:
 * a peer that closes the connection (the socket must *say so*, not let the layer
 * above wait out its timeout), a write into a destroyed socket, a connection to
 * a port where nothing listens, and the honest `false` of `isSecure()` on the
 * plaintext channel. The servers here are `node:net`/`node:dgram` only — the
 * virtual entity lives in the tool package and is used by the integration
 * pipeline test, not by this unit.
 */

import assert from "node:assert/strict";
import { createSocket as createUdpServer } from "node:dgram";
import { createServer, type Server, type Socket } from "node:net";
import type { DoipDatagramSocket, DoipSocket } from "@vdp/transport-doip";
import { test } from "vitest";
import { tick, waitFor } from "../../../../tests/helpers/wait.js";
import { createDoipTcpSocket, createDoipUdpSocket } from "./doip-socket.js";

/**
 * The hooks are optional in the contract (a browser WebSocket double cannot
 * report its death) — the real bindings must implement them, and the tests say
 * so once instead of using non-null assertions in every call.
 */
function deathHooks(socket: DoipSocket): {
  onClose: NonNullable<DoipSocket["onClose"]>;
  onError: NonNullable<DoipSocket["onError"]>;
} {
  const { onClose, onError } = socket;
  assert.ok(onClose && onError, "the TCP binding must report close and error");
  return { onClose, onError };
}

/**
 * Subscribe through a binding's data hook.
 *
 * The hook is required by both socket contracts; this wrapper exists so the
 * tests state that once (and so a binding that forgot it fails here rather than
 * as an undefined-is-not-a-function later).
 */
function subscribeTcp(socket: DoipSocket, listener: (chunk: Uint8Array) => void): () => void {
  const onData = socket.onData;
  assert.ok(typeof onData === "function", "the binding must deliver data");
  const off = onData(listener);
  assert.ok(typeof off === "function", "the binding must return an unsubscribe function");
  return off;
}

/** Same for the discovery socket (a different contract with the same hook shape). */
function subscribeUdp(
  socket: DoipDatagramSocket,
  listener: (chunk: Uint8Array) => void,
): () => void {
  const onData = socket.onData;
  assert.ok(typeof onData === "function", "the discovery socket must deliver datagrams");
  const off = onData(listener);
  assert.ok(typeof off === "function", "the discovery socket must return an unsubscribe function");
  return off;
}

/** A TCP server that records what arrived and can hang up on command. */
async function tcpServer(options: { reply?: Uint8Array } = {}) {
  const received: Uint8Array[] = [];
  const connections = new Set<Socket>();
  const server: Server = createServer((socket) => {
    connections.add(socket);
    socket.on("data", (chunk: Buffer) => {
      received.push(new Uint8Array(chunk));
      if (options.reply) socket.write(options.reply);
    });
    socket.on("close", () => connections.delete(socket));
    socket.on("error", () => connections.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    server,
    port: (server.address() as { port: number }).port,
    received,
    openConnections: () => connections.size,
    /** The vehicle hangs up — the case the transport must be told about. */
    dropConnections: (): void => {
      for (const connection of connections) connection.destroy();
      connections.clear();
    },
  };
}

test("a TCP socket connects, sends, receives and reports open/closed honestly", async () => {
  const endpoint = await tcpServer({ reply: Uint8Array.from([0x02, 0xfd, 0xe8]) });
  const socket = createDoipTcpSocket({ host: "127.0.0.1", port: endpoint.port });
  const received: Uint8Array[] = [];
  try {
    assert.equal(socket.isOpen(), false, "a fresh socket is closed");
    // `isSecure` is optional in the contract; a real binding must answer it,
    // because `requireTls` above refuses a transport that cannot say.
    assert.ok(typeof socket.isSecure === "function", "the binding must state its security");
    assert.equal(socket.isSecure(), false, "the plaintext channel says it is not TLS");
    subscribeTcp(socket, (chunk) => received.push(chunk));
    await socket.connect();
    assert.equal(socket.isOpen(), true);
    await socket.send(Uint8Array.from([0x02, 0x10, 0x00]));
    await waitFor(() => received.length > 0, Boolean, {
      timeoutMs: 1000,
      message: "the answer the server echoed must arrive",
    });
    assert.deepEqual(endpoint.received[0] && Array.from(endpoint.received[0]), [0x02, 0x10, 0x00]);
    assert.deepEqual(received[0] && Array.from(received[0]), [0x02, 0xfd, 0xe8]);

    // Connecting twice is not an error (the transport may call connect() again).
    await socket.connect();
    assert.equal(socket.isOpen(), true);

    await socket.close();
    assert.equal(socket.isOpen(), false, "a closed socket is closed");
    await socket.close(); // closing twice must not hang or throw
    await assert.rejects(() => socket.send(Uint8Array.from([0x00])), /not connected/);
  } finally {
    await socket.close().catch(() => undefined);
    await new Promise<void>((resolve) => endpoint.server.close(() => resolve()));
  }
});

test("the peer hanging up is reported to onClose with a reason, and unsubscribe works", async () => {
  const endpoint = await tcpServer();
  const socket = createDoipTcpSocket({ host: "127.0.0.1", port: endpoint.port });
  const reasons: string[] = [];
  const { onClose } = deathHooks(socket);
  onClose((reason) => reasons.push(reason));
  try {
    await socket.connect();
    await waitFor(() => endpoint.openConnections() === 1, Boolean, {
      timeoutMs: 1000,
      message: "the server must hold the connection before it drops it",
    });
    // The vehicle ends the connection: this notification is what the transport
    // above turns into an `error` state instead of waiting out a timeout.
    endpoint.dropConnections();
    await waitFor(() => reasons.length > 0, Boolean, {
      timeoutMs: 1000,
      message: "the close notification must arrive",
    });
    assert.match(reasons[0] ?? "", /close/i);

    // A listener that unsubscribed hears nothing more.
    const late: string[] = [];
    const off = onClose((reason) => late.push(reason));
    off();
    await tick(5);
    assert.deepEqual(late, []);
  } finally {
    await socket.close().catch(() => undefined);
    await new Promise<void>((resolve) => endpoint.server.close(() => resolve()));
  }
});

test("a write into a destroyed socket fails and reports through onError", async () => {
  const endpoint = await tcpServer();
  const socket = createDoipTcpSocket({ host: "127.0.0.1", port: endpoint.port });
  const errors: Error[] = [];
  const closes: string[] = [];
  const { onClose, onError } = deathHooks(socket);
  onError((error) => errors.push(error));
  onClose((reason) => closes.push(reason));
  try {
    await socket.connect();
    await waitFor(() => endpoint.openConnections() === 1, Boolean, { timeoutMs: 1000 });
    endpoint.dropConnections();
    await waitFor(() => closes.length > 0, Boolean, {
      timeoutMs: 1000,
      message: "the peer's close must be reported before the write is attempted",
    });
    // The connection is gone; a send must fail. Either the socket is already
    // destroyed (the guard) or the write itself fails (the callback) — both
    // paths are legitimate, and both must be *reported*, not swallowed.
    await assert.rejects(() => socket.send(Uint8Array.from([0x01])));
    await waitFor(() => errors.length > 0, Boolean, {
      timeoutMs: 1000,
      message: "a failed write must reach the error listeners, not stay silent",
    });
  } finally {
    await socket.close().catch(() => undefined);
    await new Promise<void>((resolve) => endpoint.server.close(() => resolve()));
  }
});

test("a port where nothing listens fails with the address, not with silence", async () => {
  // Bind a server and close it again: the port is then free and refuses.
  const endpoint = await tcpServer();
  const port = endpoint.port;
  await new Promise<void>((resolve) => endpoint.server.close(() => resolve()));
  const socket = createDoipTcpSocket({ host: "127.0.0.1", port, connectTimeoutMs: 500 });
  await assert.rejects(
    () => socket.connect(),
    (error: unknown) =>
      error instanceof Error &&
      /cannot reach the DoIP entity/.test(error.message) &&
      new RegExp(String(port)).test(error.message),
    "the reason names the endpoint, so a technician knows where to look",
  );
  await socket.close();
});

test("closing a socket that was never opened is a no-op", async () => {
  const socket = createDoipTcpSocket({ host: "127.0.0.1", port: 1 });
  await socket.close();
  assert.equal(socket.isOpen(), false);
});

test("the UDP socket broadcasts, hands answers to listeners and stops after unsubscribe", async () => {
  const received: Uint8Array[] = [];
  const responder = createUdpServer({ type: "udp4" });
  responder.on("message", (message: Buffer, remote) => {
    // Answer like an entity announcing itself.
    responder.send(
      Uint8Array.from([0x02, 0xfd, 0x00, 0x04, ...new Uint8Array(message)]),
      remote.port,
      remote.address,
    );
  });
  await new Promise<void>((resolve) => responder.bind(0, "127.0.0.1", () => resolve()));
  const responderPort = (responder.address() as { port: number }).port;

  const socket = createDoipUdpSocket({
    port: 0,
    broadcastAddress: "127.0.0.1",
    broadcastPort: responderPort,
  });
  try {
    const off = subscribeUdp(socket, (chunk) => received.push(chunk));
    await socket.broadcast(Uint8Array.from([0x02, 0xfd, 0x00, 0x01]));
    await waitFor(() => received.length > 0, Boolean, {
      timeoutMs: 1000,
      message: "the announcement must arrive",
    });
    assert.equal(received[0]?.[3], 0x04, "the payload type of the answer survives the transport");

    off();
    const after = received.length;
    // Second broadcast on the already-bound socket: no rebind, and the
    // unsubscribed listener hears nothing more.
    await socket.broadcast(Uint8Array.from([0x02, 0xfd, 0x00, 0x01]));
    await tick(10);
    assert.equal(received.length, after, "an unsubscribed listener hears nothing more");
  } finally {
    await socket.close();
    await new Promise<void>((resolve) => responder.close(() => resolve()));
  }
});
