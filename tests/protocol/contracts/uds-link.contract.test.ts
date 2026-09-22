/**
 * UDS link contract (AGENTS 5/36, Master-Backlog P0 #8).
 *
 * The UDS layer talks to `UdsLink` — three methods, no transport. Two
 * implementations exist today: `IsoTpConnection` (ISO 15765-2 on CAN) and
 * `RequestResponseLink` (anything that can send and receive a message: DoIP, a
 * gateway, a replay transport). Both are driven here by the same suite, so a
 * change in one cannot quietly change the semantics of the other.
 *
 * The rules that matter above the transport are the ones checked here: a
 * request gets exactly the peer's bytes, silence is a *typed* error, one
 * transaction at a time per link, and `receive()` reports a timeout instead of
 * hanging forever.
 */

import assert from "node:assert/strict";
import { RequestResponseLink, type UdsLink } from "@vdp/protocols-uds";
import { createLogger, fromHex, VdpError } from "@vdp/shared";
import { createVirtualCanNetwork } from "@vdp/simulators";
import { createFrame } from "@vdp/transport-can";
import { IsoTpConnection } from "@vdp/transport-iso-tp";
import { test } from "vitest";

const logger = createLogger("contract", { level: "ERROR" });

interface UdsLinkFixture {
  link: UdsLink;
  /** Payloads the peer received, in order. */
  received(): Uint8Array[];
  /** Answer the next request with these bytes; `null` means: stay silent. */
  answer(payload: Uint8Array | null): void;
  cleanup(): Promise<void>;
}

interface UdsLinkSubject {
  name: string;
  create(): UdsLinkFixture | Promise<UdsLinkFixture>;
}

const REQUEST = fromHex("22 F1 90");
const RESPONSE = fromHex("62 F1 90 57 56 57");
const OTHER_REQUEST = fromHex("22 F1 91");
const OTHER_RESPONSE = fromHex("62 F1 91 30 31 32");

const subjects: UdsLinkSubject[] = [
  {
    name: "ISO-TP connection",
    async create() {
      const network = createVirtualCanNetwork({ channel: "vcan0" });
      const testerBus = network.createBus("tester");
      const ecuBus = network.createBus("ecu");
      await testerBus.open();
      await ecuBus.open();

      const link = new IsoTpConnection(
        testerBus,
        {
          txId: 0x7e0,
          rxId: 0x7e8,
          // Deterministic and fast: no real waiting, one attempt per request.
          timing: { nBsMs: 20, nCrMs: 40, maxRetries: 0 },
          sleep: async () => undefined,
        },
        logger,
      );
      link.open();

      const received: Uint8Array[] = [];
      const planned: Array<Uint8Array | null> = [];
      ecuBus.subscribe((frame) => {
        if (frame.id !== 0x7e0) return;
        const pci = frame.payload[0] ?? 0;
        if ((pci & 0xf0) !== 0x00) return; // this contract uses single frames only
        const payload = frame.payload.slice(1, 1 + (pci & 0x0f));
        received.push(payload.slice());
        const next = planned.shift();
        // Silence is a valid peer behaviour and must stay valid: no answer is
        // recorded, the caller sees a timeout.
        if (!next) return;
        void ecuBus.send(
          createFrame(0x7e8, Uint8Array.from([next.length, ...next]), { direction: "tx" }),
        );
      });

      return {
        link,
        received: () => received,
        answer(payload) {
          planned.push(payload);
        },
        async cleanup() {
          link.close();
          await ecuBus.close();
          await testerBus.close();
        },
      };
    },
  },
  {
    name: "request/response link (DoIP, replay, gateway)",
    create() {
      const received: Uint8Array[] = [];
      const planned: Array<Uint8Array | null> = [];
      const transport = {
        async send(data: Uint8Array): Promise<void> {
          received.push(data.slice());
        },
        async receive(): Promise<Uint8Array | null> {
          return planned.shift() ?? null;
        },
      };
      return {
        link: new RequestResponseLink(transport, { defaultTimeoutMs: 40, logger }),
        received: () => received,
        answer(payload) {
          planned.push(payload);
        },
        async cleanup() {
          // Nothing to release: the transport belongs to the caller.
        },
      };
    },
  },
];

for (const subject of subjects) {
  test(`${subject.name}: a request is answered with exactly the peer's bytes`, async () => {
    const fixture = await subject.create();
    try {
      fixture.answer(RESPONSE);
      const response = await fixture.link.request(REQUEST, 200);
      assert.deepEqual(Array.from(response), Array.from(RESPONSE));
      assert.deepEqual(
        fixture.received().map((entry) => Array.from(entry)),
        [Array.from(REQUEST)],
        "the peer saw the request unchanged",
      );
    } finally {
      await fixture.cleanup();
    }
  });

  test(`${subject.name}: silence is a typed error, not an empty response`, async () => {
    const fixture = await subject.create();
    try {
      fixture.answer(null);
      await assert.rejects(
        () => fixture.link.request(REQUEST, 60),
        (error: unknown) => {
          assert.ok(isVdpError(error), `expected a VdpError, got ${String(error)}`);
          assert.match(
            error.message,
            /timeout|no response/i,
            "the message has to name the reason: nobody answered",
          );
          return true;
        },
      );
    } finally {
      await fixture.cleanup();
    }
  });

  test(`${subject.name}: sendOnly does not wait for an answer`, async () => {
    const fixture = await subject.create();
    try {
      fixture.answer(null);
      await fixture.link.sendOnly(REQUEST);
      assert.deepEqual(
        fixture.received().map((entry) => Array.from(entry)),
        [Array.from(REQUEST)],
      );
    } finally {
      await fixture.cleanup();
    }
  });

  test(`${subject.name}: two parallel requests are serialised and keep their answers`, async () => {
    const fixture = await subject.create();
    try {
      // The peer answers in the order it receives: if the link let two requests
      // interleave, each caller would get the other one's response.
      fixture.answer(RESPONSE);
      fixture.answer(OTHER_RESPONSE);
      const [first, second] = await Promise.all([
        fixture.link.request(REQUEST, 300),
        fixture.link.request(OTHER_REQUEST, 300),
      ]);
      assert.deepEqual(Array.from(first), Array.from(RESPONSE));
      assert.deepEqual(Array.from(second), Array.from(OTHER_RESPONSE));
      assert.deepEqual(
        fixture.received().map((entry) => Array.from(entry)),
        [Array.from(REQUEST), Array.from(OTHER_REQUEST)],
        "requests reach the peer in call order",
      );
    } finally {
      await fixture.cleanup();
    }
  });

  test(`${subject.name}: receive() reports a timeout as null instead of hanging`, async () => {
    const fixture = await subject.create();
    try {
      const received = await fixture.link.receive(30);
      assert.equal(received, null, "nobody sent anything, so there is nothing to receive");
    } finally {
      await fixture.cleanup();
    }
  });
}

function isVdpError(error: unknown): error is VdpError {
  return error instanceof VdpError;
}
