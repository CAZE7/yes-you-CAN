/**
 * DoIP end-to-end over the transport seam (ISO 13400; AGENTS 5, 36).
 *
 * The same engine that runs over CAN is driven over DoIP using the runtime's
 * `DoipEcuLinkFactory`: one TCP endpoint per ECU, routing activation, UDS inside
 * diagnostic messages. The endpoint is a fake socket, so no network is touched —
 * but the bytes on the wire are real DoIP framing, decoded by the production
 * `DoipTransport`.
 */

import assert from "node:assert/strict";
import { DiagnosticEngine } from "@vdp/core";
import { createDoipEcuLinkFactory } from "@vdp/runtime";
import { createLogger, fromHex } from "@vdp/shared";
import {
  DOIP_HEADER_LENGTH,
  type DoipSocket,
  PAYLOAD_TYPE,
  decodeDiagnosticMessage,
  decodeHeader,
  encodeDiagnosticMessage,
  encodeMessage,
} from "@vdp/transport-doip";
import { test } from "vitest";

const logger = createLogger("doip-engine", { level: "ERROR" });
const VIN = "1HGCM82633A004352";

/** Fake TCP endpoint: activates routing and answers one UDS DID read. */
class FakeDoipEndpoint implements DoipSocket {
  private listeners: Array<(chunk: Uint8Array) => void> = [];
  private opened = false;
  readonly received: Uint8Array[] = [];

  constructor(private readonly secure = false) {}

  async connect(): Promise<void> {
    this.opened = true;
  }
  async send(data: Uint8Array): Promise<void> {
    this.received.push(data);
    const header = decodeHeader(data);
    const payload = data.subarray(DOIP_HEADER_LENGTH);
    if (header.payloadType === PAYLOAD_TYPE.ROUTING_ACTIVATION_REQUEST) {
      this.emit(
        encodeMessage(
          PAYLOAD_TYPE.ROUTING_ACTIVATION_RESPONSE,
          fromHex("0E 00 10 00 10 00 00 00 00"),
        ),
      );
      return;
    }
    if (header.payloadType === PAYLOAD_TYPE.DIAGNOSTIC_MESSAGE) {
      const decoded = decodeDiagnosticMessage(payload);
      const uds = decoded.udsPayload;
      // 0x22 F1 90 → positive response with the VIN.
      const reply =
        uds[0] === 0x22 && uds[1] === 0xf1 && uds[2] === 0x90
          ? fromHex(
              `62 F1 90 ${Buffer.from(VIN, "ascii").toString("hex").toUpperCase().match(/.{2}/g)?.join(" ") ?? ""}`,
            )
          : new Uint8Array([(uds[0] ?? 0) + 0x40, 0x00]);
      this.emit(
        encodeMessage(PAYLOAD_TYPE.DIAGNOSTIC_MESSAGE_POSITIVE_ACK, fromHex("10 00 0E 00 00")),
      );
      this.emit(
        encodeMessage(
          PAYLOAD_TYPE.DIAGNOSTIC_MESSAGE,
          encodeDiagnosticMessage(decoded.targetAddress, decoded.sourceAddress, reply),
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
    this.opened = false;
  }
  isOpen(): boolean {
    return this.opened;
  }
  isSecure(): boolean {
    return this.secure;
  }
  private emit(chunk: Uint8Array): void {
    for (const listener of this.listeners) listener(chunk);
  }
}

test("DoipEcuLinkFactory drives the engine over DoIP (no CAN anywhere)", async () => {
  const endpoints: FakeDoipEndpoint[] = [];
  const engine = new DiagnosticEngine({
    logger,
    linkFactory: createDoipEcuLinkFactory({
      createSocket: (_targetAddress) => {
        const endpoint = new FakeDoipEndpoint();
        endpoints.push(endpoint);
        return endpoint;
      },
      logicalAddressFor: () => 0x1000,
      responseTimeoutMs: 500,
    }),
  });

  const handle = await engine.attach({ txId: 0x0e00, rxId: 0x1000 });
  assert.equal(handle.session.record.reachable, true);

  // Routing activation must have run before the first UDS request.
  assert.ok(endpoints.length >= 1);
  const first = endpoints[0] as FakeDoipEndpoint;
  assert.equal(
    decodeHeader(first.received[0] as Uint8Array).payloadType,
    PAYLOAD_TYPE.ROUTING_ACTIVATION_REQUEST,
  );

  const vin = await handle.session.client.readVin();
  assert.equal(vin, VIN);

  await engine.disconnect();
});

test("DoipEcuLinkFactory honours per-ECU logical addressing", async () => {
  const openedTargets: number[] = [];
  const engine = new DiagnosticEngine({
    logger,
    linkFactory: createDoipEcuLinkFactory({
      createSocket: (targetAddress) => {
        openedTargets.push(targetAddress);
        return new FakeDoipEndpoint();
      },
      responseTimeoutMs: 200,
    }),
  });

  // Without logicalAddressFor the response identifier is the logical address.
  await engine.attach({ txId: 0x0e00, rxId: 0x1000 });
  await engine.attach({ txId: 0x0e00, rxId: 0x1001 });
  assert.deepEqual(openedTargets, [0x1000, 0x1001]);

  await engine.disconnect();
});

test("tester address, TLS enforcement and the default response timeout", async () => {
  // A secure endpoint satisfies requireTls.
  const engine = new DiagnosticEngine({
    logger,
    linkFactory: createDoipEcuLinkFactory({
      createSocket: () => new FakeDoipEndpoint(true),
      testerAddress: 0x0e88,
      requireTls: true,
      // no responseTimeoutMs → the link's own default is used
    }),
  });
  const handle = await engine.attach({ txId: 0x0e88, rxId: 0x1000 });
  assert.equal(handle.session.record.reachable, true);
  const vin = await handle.session.client.readVin();
  assert.equal(vin, VIN);
  await engine.disconnect();

  // requireTls against a plaintext endpoint must refuse to connect.
  const refusing = new DiagnosticEngine({
    logger,
    linkFactory: createDoipEcuLinkFactory({
      createSocket: () => new FakeDoipEndpoint(false),
      requireTls: true,
    }),
  });
  await assert.rejects(refusing.attach({ txId: 0x0e00, rxId: 0x1000 }), /TLS is required/);
});

test("a failing socket teardown is logged by the factory, never thrown", async () => {
  const engine = new DiagnosticEngine({
    logger,
    linkFactory: createDoipEcuLinkFactory({
      createSocket: () => {
        const endpoint = new FakeDoipEndpoint();
        endpoint.close = async () => {
          throw new Error("socket teardown failed");
        };
        return endpoint;
      },
      responseTimeoutMs: 200,
    }),
  });

  const handle = await engine.attach({ txId: 0x0e00, rxId: 0x1000 });
  assert.equal(handle.session.record.reachable, true);
  // disconnect() must resolve even though the socket close rejects (the factory
  // swallows and logs the teardown error).
  await engine.disconnect();
  // Give the swallowed rejection a tick to run through the catch handler.
  await new Promise((resolve) => setTimeout(resolve, 5));
});
