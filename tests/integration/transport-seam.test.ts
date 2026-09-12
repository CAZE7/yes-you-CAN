/**
 * Transport seam proof (AGENTS 5, 36; blueprint: "Protocol-Schicht kennt kein
 * CAN, nur ein Transport-Interface").
 *
 * The whole diagnostic stack — engine, ECU session, UDS client — is driven over
 * a link that is NOT ISO-TP/CAN: a `RequestResponseLink` wrapping an in-memory
 * byte transport that talks to a `UdsServer`. This is exactly the shape DoIP
 * (ISO 13400) arrives in, so the test demonstrates that swapping the transport
 * requires nothing but a different {@link EcuLinkFactory} — no UDS, engine or
 * session code changes.
 */

import assert from "node:assert/strict";
import { DiagnosticEngine, type OpenedEcuLink } from "@vdp/core";
import type { DefinitionPackage } from "@vdp/definitions";
import {
  type UdsLink,
  UdsServer,
  type UdsServerLink,
  createRequestResponseLink,
} from "@vdp/protocols-uds";
import { createLogger } from "@vdp/shared";
import { test } from "vitest";
import { tick } from "../helpers/wait.js";

const logger = createLogger("transport-seam", { level: "ERROR" });

/** Structural shape `createRequestResponseLink` consumes (send/receive only). */
interface ByteTransport {
  send(data: Uint8Array): Promise<void>;
  receive(timeoutMs?: number): Promise<Uint8Array | null>;
}

/**
 * Wire one UDS client to one in-memory `UdsServer` through a loopback byte
 * transport. The server's outgoing messages become the client's incoming ones.
 */
function createInMemoryEcu(server: ConstructorParameters<typeof UdsServer>[1]): OpenedEcuLink {
  let serverListener: ((payload: Uint8Array) => void) | null = null;
  const inbox: Uint8Array[] = [];
  let wake: (() => void) | null = null;

  const serverLink: UdsServerLink = {
    onMessage: (listener) => {
      serverListener = listener;
      return () => {
        serverListener = null;
      };
    },
    send: async (payload) => {
      inbox.push(payload);
      wake?.();
    },
  };

  const ecu = new UdsServer(serverLink, { logger, ...server });
  ecu.start();

  const transport: ByteTransport = {
    send: async (data) => {
      const listener = serverListener;
      if (!listener) throw new Error("in-memory ECU is not listening");
      // Deliver asynchronously the way a real wire would hand the frame over.
      queueMicrotask(() => listener(data));
    },
    receive: async (timeoutMs = 2000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        while (inbox.length > 0) {
          const message = inbox.shift() as Uint8Array;
          // Response-pending (7F <sid> 0x78) is not the final answer — keep waiting.
          if (message.length === 3 && message[0] === 0x7f && message[2] === 0x78) continue;
          return message;
        }
        if (Date.now() >= deadline) return null;
        await new Promise<void>((resolve) => {
          wake = resolve;
          void tick(Math.max(1, deadline - Date.now())).then(resolve);
        });
        wake = null;
      }
    },
  };

  const link: UdsLink = createRequestResponseLink(transport, { logger });
  return { link, close: () => ecu.stop() };
}

const VIN = "WVWZZZ1KZAW000001";

function ecuOptions() {
  return {
    name: "doip-style-ecu",
    dids: [
      { did: 0xf190, value: () => new TextEncoder().encode(VIN) },
      // 0x0C00 engine speed: raw 0x0B B8 → 3000 rpm with factor 0.25
      { did: 0x0c00, value: () => new Uint8Array([0x0b, 0xb8]) },
    ],
    dtcs: [
      { code: "P0420", status: 0x2f },
      { code: "P0301", status: 0x24 },
    ],
  };
}

test("engine drives a UDS session over a non-CAN link via a linkFactory", async () => {
  let closed = false;
  const engine = new DiagnosticEngine({
    logger,
    linkFactory: {
      open: async () => {
        const opened = createInMemoryEcu(ecuOptions());
        return {
          link: opened.link,
          close: () => {
            closed = true;
            opened.close();
          },
        };
      },
    },
  });

  // No CAN bus, no discovery — attach by address, the DoIP addressing model.
  const handle = await engine.attach({ txId: 0x7e0, rxId: 0x7e8 });
  assert.equal(handle.session.record.reachable, true);

  // VIN (DID 0xF190) read through the transport-neutral link.
  const vin = await handle.session.client.readVin();
  assert.equal(vin, VIN);

  // A plain DID read over the same link.
  const raw = await handle.session.readRaw(0x0c00);
  assert.ok(raw);
  assert.equal(Array.from(raw as Uint8Array).join(","), "11,184");

  // Fault memory over the same link.
  const dtcs = await handle.session.readDtcs();
  assert.deepEqual(dtcs.map((d) => d.code).sort(), ["P0301", "P0420"]);

  await engine.disconnect();
  assert.equal(closed, true, "disconnect() must close the transport-neutral link");
});

test("two ECUs on independent non-CAN links", async () => {
  const engine = new DiagnosticEngine({
    logger,
    linkFactory: { open: async () => createInMemoryEcu(ecuOptions()) },
  });

  const a = await engine.attach({ txId: 0x7e0, rxId: 0x7e8 });
  const b = await engine.attach({ txId: 0x710, rxId: 0x718 });
  assert.equal(engine.ecuHandles.length, 2);

  const vinA = await a.session.client.readVin();
  const vinB = await b.session.client.readVin();
  assert.equal(vinA, VIN);
  assert.equal(vinB, VIN);

  await engine.disconnect();
  assert.equal(engine.ecuHandles.length, 0);
});

/** One ECU with two signals on two different DIDs, recording every 0x22 read. */
function createRecordingEcu(): { link: UdsLink; didRequests: number[] } {
  const didRequests: number[] = [];
  const link: UdsLink = {
    request: async (payload) => {
      const service = payload[0] ?? 0;
      if (service === 0x22) {
        const did = ((payload[1] ?? 0) << 8) | (payload[2] ?? 0);
        didRequests.push(did);
        return new Uint8Array([0x62, payload[1] ?? 0, payload[2] ?? 0, 0x0b, 0xb8]);
      }
      return new Uint8Array([service + 0x40]);
    },
    sendOnly: async () => {},
    receive: async () => null,
  };
  return { link, didRequests };
}

const filterPackage: DefinitionPackage = {
  schemaVersion: 1,
  oem: "generic",
  name: "snapshot-filter-test",
  version: "1.0.0",
  provenance: { sourceType: "example-placeholder", source: "transport-seam test" },
  ecus: [{ id: "engine", name: "Engine", address: { txId: 0x7e0, rxId: 0x7e8 }, protocol: "uds" }],
  signals: [
    {
      id: "engine.rpm",
      name: "Engine speed",
      ecu: "engine",
      did: 0x0c00,
      byteOffset: 0,
      length: 2,
      encoding: "uint16",
    },
    {
      id: "engine.coolant",
      name: "Coolant temperature",
      ecu: "engine",
      did: 0x0c01,
      byteOffset: 0,
      length: 2,
      encoding: "uint16",
    },
  ],
};

test("snapshotSignals(filter) only requests the filtered DID on the wire", async () => {
  const ecu = createRecordingEcu();
  const engine = new DiagnosticEngine({
    logger,
    definitions: [filterPackage],
    linkFactory: { open: async () => ({ link: ecu.link, close: () => {} }) },
  });

  await engine.attach({ txId: 0x7e0, rxId: 0x7e8, definitionEcuId: "generic:engine" });
  // attach() reads identification DIDs — ignore those, measure the snapshot only.
  ecu.didRequests.length = 0;

  // No filter → both signal DIDs are requested.
  await engine.snapshotSignals();
  assert.deepEqual([...ecu.didRequests].sort(), [0x0c00, 0x0c01]);

  // Filter → only the requested signal's DID crosses the transport.
  ecu.didRequests.length = 0;
  const decoded = await engine.snapshotSignals(["engine.rpm"]);
  assert.deepEqual(ecu.didRequests, [0x0c00]);
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0]?.signalId, "engine.rpm");

  await engine.disconnect();
});
