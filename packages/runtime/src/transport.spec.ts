/**
 * Unit coverage for the DoIP link factory seams that the integration pipeline
 * does not exercise on its own: the `closeAll` teardown, the close callback that
 * must never throw into a session, the `states()`/`describe()` projections, a
 * refused routing activation, and the `summariseLinkStates` ordering. The
 * revival paths themselves are covered by `tests/integration/doip-pipeline.test.ts`
 * over real sockets.
 */

import assert from "node:assert/strict";
import { createLogger } from "@vdp/shared";
import type { ConnectionStatus } from "@vdp/transport-can";
import {
  DOIP_HEADER_LENGTH,
  type DoipSocket,
  DoipTransport,
  encodeMessage,
  encodeRoutingActivationResponse,
  PAYLOAD_TYPE,
} from "@vdp/transport-doip";
import { afterEach, test } from "vitest";
import { settle } from "../../../tests/helpers/wait.js";
import { createDoipEcuLinkFactory, type DoipEcuLinkFactoryOptions } from "./index.js";
import { summariseLinkStates } from "./transport.js";

const logger = createLogger("transport-factory", { level: "ERROR" });
const TESTER = 0x0e00;
const ECU = 0x1000;

const running: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (running.length > 0) await running.pop()?.();
});

/** Fake endpoint: answers the routing activation; `closeFails` breaks the teardown. */
class FakeEndpoint implements DoipSocket {
  private listeners: Array<(chunk: Uint8Array) => void> = [];
  private opened = false;

  constructor(
    private readonly closeFails = false,
    private readonly refuseActivation = false,
  ) {}

  async connect(): Promise<void> {
    this.opened = true;
  }
  async send(data: Uint8Array): Promise<void> {
    // The routing activation request (payload type 0x0005); anything else is ignored —
    // the factory tests need a usable link, not a conversation.
    if (
      data.length >= DOIP_HEADER_LENGTH &&
      data[2] === 0x00 &&
      data[3] === PAYLOAD_TYPE.ROUTING_ACTIVATION_REQUEST
    ) {
      this.emit(
        encodeMessage(
          PAYLOAD_TYPE.ROUTING_ACTIVATION_RESPONSE,
          // Code 0x10 = success, 0x06 = routingActivationDenied (ISO 13400-2).
          encodeRoutingActivationResponse(TESTER, ECU, this.refuseActivation ? 0x06 : 0x10),
        ),
      );
    }
  }
  onData(listener: (chunk: Uint8Array) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
  async close(): Promise<void> {
    if (this.closeFails) throw new Error("the socket refuses to close");
    this.opened = false;
  }
  isOpen(): boolean {
    return this.opened;
  }
  isSecure(): boolean {
    return false;
  }
  private emit(chunk: Uint8Array): void {
    for (const listener of this.listeners) listener(chunk);
  }
}

function factoryOf(options: Partial<DoipEcuLinkFactoryOptions> & { socket?: FakeEndpoint } = {}): {
  factory: ReturnType<typeof createDoipEcuLinkFactory>;
  endpoint: FakeEndpoint;
} {
  const { socket, ...rest } = options;
  const endpoint = socket ?? new FakeEndpoint();
  return {
    endpoint,
    factory: createDoipEcuLinkFactory({
      createSocket: () => endpoint,
      testerAddress: TESTER,
      logicalAddressFor: (ecu) => ecu.rxId,
      sleep: async () => undefined,
      logger,
      ...rest,
    }),
  };
}

const ecuRef = { txId: ECU, rxId: ECU };

test("open() connects the link; states() names it and describe() carries the addresses", async () => {
  const { factory } = factoryOf();
  running.push(async () => factory.closeAll());
  const opened = await factory.open(ecuRef);
  const states = factory.states();
  assert.equal(states.length, 1);
  assert.equal(states[0]?.targetAddress, ECU);
  assert.equal(states[0]?.status.state, "connected");
  const described = factory.describe();
  assert.equal(described.adapter.id, "doip");
  assert.equal(described.transport.kind, "doip");
  assert.equal(described.transport.doipAddresses?.testerAddress, TESTER);
  assert.equal(
    described.transport.doipAddresses?.targetAddress,
    ECU,
    "the session record names the address the link really carries, not a placeholder",
  );
  opened.close();
  await settle(5, "the fire-and-forget close has to finish before the test ends");
});

test("describe() without an open link names no target — an address is not invented", () => {
  const { factory } = factoryOf();
  const described = factory.describe();
  assert.equal(described.transport.doipAddresses, undefined, "no open link, no target to report");
  assert.equal(described.transport.kind, "doip");
});

test("closeAll() closes every open link and forgets them", async () => {
  const { factory } = factoryOf();
  await factory.open(ecuRef);
  await factory.open({ txId: ECU + 1, rxId: ECU + 1 });
  assert.equal(factory.states().length, 2);
  await factory.closeAll();
  assert.equal(factory.states().length, 0, "the factory holds no open link after closeAll");
});

test("a link whose socket refuses to close is logged, not thrown — and dropped from the set", async () => {
  const { factory } = factoryOf({ socket: new FakeEndpoint(true) });
  const opened = await factory.open(ecuRef);
  assert.equal(factory.states().length, 1);
  // The session teardown calls close without awaiting — a rejection may not
  // escape into the caller (a refusal is data, a crash is not).
  opened.close();
  await settle(5, "the rejected close has to be caught and logged before asserting");
  assert.equal(
    factory.states().length,
    0,
    "the link is unregistered even though the socket would not close",
  );
});

test("a refused routing activation registers no link", async () => {
  const { factory } = factoryOf({ socket: new FakeEndpoint(false, true) });
  await assert.rejects(factory.open(ecuRef), /routing activation refused/);
  assert.equal(factory.states().length, 0, "the failed open left nothing behind");
});

test("requesting through a link that was never open says which ECU and why", async () => {
  const { factory } = factoryOf();
  const opened = await factory.open(ecuRef);
  await factory.closeAll();
  await settle(5, "the closed transport has to finish unwinding before the request");
  await assert.rejects(opened.link.request(new Uint8Array([0x3e, 0x00])), /not open/);
});

test("summariseLinkStates orders the six link states by severity", () => {
  const state = (name: ConnectionStatus["state"]): ConnectionStatus => ({
    state: name,
    adapterId: "doip",
  });
  assert.equal(summariseLinkStates([]), "none");
  assert.equal(summariseLinkStates([state("disconnected")]), "disconnected");
  assert.equal(summariseLinkStates([state("connected")]), "connected");
  assert.equal(
    summariseLinkStates([state("connected"), state("degraded")]),
    "degraded",
    "a degraded link is the headline over a healthy one",
  );
  assert.equal(summariseLinkStates([state("degraded"), state("connecting")]), "connecting");
  assert.equal(summariseLinkStates([state("connecting"), state("recovering")]), "recovering");
  assert.equal(
    summariseLinkStates([state("recovering"), state("error")]),
    "error",
    "an error beats everything — the technician needs to see it first",
  );
});

// Keep the import honest: DoipTransport is what the factory builds, and a test
// that imports it without naming it would not fail if the seam changed.
void DoipTransport;
