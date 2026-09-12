import assert from "node:assert/strict";
import { UdsClient, createRequestResponseLink } from "@vdp/protocols-uds";
import { ProtocolError, fromHex, toHex } from "@vdp/shared";
import { test } from "vitest";
import { settle, waitFor } from "../../../../tests/helpers/wait.js";
import {
  DEFAULT_DISCOVERY_WINDOW_MS,
  DOIP_HEADER_LENGTH,
  DoipDiscovery,
  type DoipSocket,
  DoipTransport,
  PAYLOAD_TYPE,
  decodeDiagnosticMessage,
  decodeHeader,
  decodeRoutingActivationResponse,
  decodeVehicleIdentificationResponse,
  encodeDiagnosticMessage,
  encodeMessage,
  encodeRoutingActivationRequest,
  encodeRoutingActivationResponse,
  encodeVehicleIdentificationResponse,
} from "./index.js";

/** Fake TCP endpoint that speaks enough DoIP to activate routing and echo UDS. */
class FakeDoipEndpoint implements DoipSocket {
  private listeners: Array<(chunk: Uint8Array) => void> = [];
  private opened = false;
  private secure: boolean;
  readonly received: Uint8Array[] = [];
  /** UDS payload returned for the next diagnostic message. */
  responder: ((uds: Uint8Array) => Uint8Array) | null = null;
  activationCode = 0x10;
  /** Set to false for an entity that never answers the routing activation. */
  answersActivation = true;
  /** When set, `send` rejects — used for the alive-check failure path. */
  sendError: Error | null = null;

  constructor(options: { secure?: boolean } = {}) {
    this.secure = options.secure ?? false;
  }

  async connect(): Promise<void> {
    this.opened = true;
  }
  async send(data: Uint8Array): Promise<void> {
    this.received.push(data);
    if (this.sendError) throw this.sendError;
    const header = decodeHeader(data);
    const payload = data.subarray(DOIP_HEADER_LENGTH);
    if (header.payloadType === PAYLOAD_TYPE.ROUTING_ACTIVATION_REQUEST) {
      if (!this.answersActivation) return;
      // ISO 13400-2 layout: tester address, entity address, response code at byte 4,
      // then four reserved bytes. Written out as wire bytes, not via our own encoder,
      // so a wrong offset on one side cannot be certified by the other.
      this.emit(
        encodeMessage(
          PAYLOAD_TYPE.ROUTING_ACTIVATION_RESPONSE,
          fromHex(`0E 00 10 00 ${this.activationCode.toString(16).padStart(2, "0")} 00 00 00 00`),
        ),
      );
      return;
    }
    if (header.payloadType === PAYLOAD_TYPE.DIAGNOSTIC_MESSAGE) {
      const decoded = decodeDiagnosticMessage(payload);
      const reply =
        this.responder?.(decoded.udsPayload) ??
        new Uint8Array([(decoded.udsPayload[0] ?? 0) + 0x40, 0x00]);
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
  emit(chunk: Uint8Array): void {
    for (const listener of this.listeners) listener(chunk);
  }
}

test("DoIP header encodes version, inverse version, type and length", () => {
  const message = encodeMessage(
    PAYLOAD_TYPE.ROUTING_ACTIVATION_REQUEST,
    new Uint8Array([0x0e, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
  );
  const header = decodeHeader(message);
  assert.equal(header.version, 0x02);
  assert.equal(message[1], 0xfd, "inverse version byte");
  assert.equal(header.payloadType, PAYLOAD_TYPE.ROUTING_ACTIVATION_REQUEST);
  assert.equal(header.payloadLength, 7);
  assert.equal(message.length, DOIP_HEADER_LENGTH + 7);
});

test("a broken version/inverse pair is rejected", () => {
  const message = encodeMessage(PAYLOAD_TYPE.DIAGNOSTIC_MESSAGE, new Uint8Array(4));
  message[1] = 0x00;
  assert.throws(() => decodeHeader(message), ProtocolError);
});

test("routing activation request carries source address and activation type", () => {
  const request = encodeRoutingActivationRequest(0x0e00, 0x01);
  assert.equal(toHex(request.subarray(0, 2)), "0E 00");
  assert.equal(request[2], 0x01);
});

test("routing activation response is decoded with its response code name", () => {
  // Byte-level fixture from ISO 13400-2 Table 23 (payload type 0x0006):
  //   0-1 tester logical address, 2-3 entity logical address, 4 response code,
  //   5-8 reserved (ISO). A real DoIP entity may also stop after byte 4.
  const decoded = decodeRoutingActivationResponse(fromHex("0E 00 10 00 10 00 00 00 00"));
  assert.equal(decoded.testerLogicalAddress, 0x0e00);
  assert.equal(decoded.entityLogicalAddress, 0x1000);
  assert.equal(decoded.code, 0x10);
  assert.equal(decoded.codeName, "success");
  const refused = decodeRoutingActivationResponse(fromHex("0E 00 10 00 00 00 00 00 00"));
  assert.equal(refused.code, 0x00);
  assert.equal(refused.codeName, "unknownSourceAddress");
  const short = decodeRoutingActivationResponse(fromHex("0E 00 10 00 03"));
  assert.equal(
    short.codeName,
    "sourceAddressMissingAuthentication",
    "the reserved bytes are optional on the wire",
  );
  // Reading the code at the wrong offset used to accept a refusal as a success: byte 8
  // of a denial is always zero, so this is the shape that silently "worked".
  assert.equal(decodeRoutingActivationResponse(fromHex("0E 00 10 00 03 00 00 00 00")).code, 0x03);
});

test("the activation response is encoded the way the standard writes it", () => {
  // Our own encoder is the mirror image — the simulated vehicle in the tests and the
  // desktop mock ECU use it, so it has to agree with the fixture above byte for byte.
  assert.equal(
    toHex(encodeRoutingActivationResponse(0x0e00, 0x1000, 0x10)),
    "0E 00 10 00 10 00 00 00 00",
  );
  assert.equal(encodeRoutingActivationResponse(0x0e00, 0x1000, 0x10).length, 9);
  assert.equal(
    decodeRoutingActivationResponse(encodeRoutingActivationResponse(0x0e80, 0x0e00, 0x08)).code,
    0x08,
  );
});

test("diagnostic messages wrap and unwrap the UDS payload", () => {
  const encoded = encodeDiagnosticMessage(0x0e00, 0x1000, fromHex("22 F1 90"));
  const decoded = decodeDiagnosticMessage(encoded);
  assert.equal(decoded.sourceAddress, 0x0e00);
  assert.equal(decoded.targetAddress, 0x1000);
  assert.equal(toHex(decoded.udsPayload), "22 F1 90");
});

test("vehicle identification responses round trip", () => {
  const original = {
    vin: "1HGCM82633A004352",
    logicalAddress: 0x1000,
    eid: fromHex("00 11 22 33 44 55"),
    gid: fromHex("66 77 88 99 AA BB"),
    furtherActionRequired: false,
  };
  const decoded = decodeVehicleIdentificationResponse(
    encodeVehicleIdentificationResponse(original),
  );
  assert.equal(decoded.vin, original.vin);
  assert.equal(decoded.logicalAddress, 0x1000);
  assert.equal(toHex(decoded.eid), "00 11 22 33 44 55");
  assert.equal(decoded.furtherActionRequired, false);
});

test("connect() performs routing activation and stores the entity address", async () => {
  const endpoint = new FakeDoipEndpoint();
  const transport = new DoipTransport({
    socket: endpoint,
    targetAddress: 0x1000,
    activationTimeoutMs: 500,
  });
  await transport.connect();
  assert.equal(transport.getStatus().state, "connected");
  assert.equal(transport.assignedEntityAddress, 0x1000);
});

test("a refused routing activation surfaces with the code name", async () => {
  const endpoint = new FakeDoipEndpoint();
  endpoint.activationCode = 0x06;
  const transport = new DoipTransport({
    socket: endpoint,
    targetAddress: 0x1000,
    activationTimeoutMs: 500,
  });
  await assert.rejects(transport.connect(), /routing activation refused: routingActivationDenied/);
  assert.equal(transport.getStatus().state, "error");
  assert.equal(endpoint.isOpen(), false, "a refused activation must not leave a half-open socket");
});

test("UDS runs over DoIP without the client knowing the transport (AGENTS 5)", async () => {
  const endpoint = new FakeDoipEndpoint();
  endpoint.responder = (uds) => {
    if ((uds[0] ?? 0) === 0x22)
      return fromHex("62 F1 90 31 48 47 43 4D 38 32 36 33 33 41 30 30 34 33 35 32");
    return new Uint8Array([(uds[0] ?? 0) + 0x40]);
  };
  const transport = new DoipTransport({
    socket: endpoint,
    targetAddress: 0x1000,
    activationTimeoutMs: 500,
  });
  await transport.connect();
  const client = new UdsClient(createRequestResponseLink(transport, { defaultTimeoutMs: 500 }), {
    name: "doip-ecu",
  });
  const vin = await client.readVin();
  assert.equal(vin, "1HGCM82633A004352");
  assert.equal(transport.getStatus().txCount, 1);
  assert.ok(transport.getStatus().detail?.includes("DoIP"));
});

test("TLS can be enforced (AGENTS 8 security note, AGENTS 26/27)", async () => {
  const plain = new FakeDoipEndpoint({ secure: false });
  const transport = new DoipTransport({ socket: plain, targetAddress: 0x1000, requireTls: true });
  await assert.rejects(transport.connect(), /TLS is required/);

  const secure = new FakeDoipEndpoint({ secure: true });
  const secureTransport = new DoipTransport({
    socket: secure,
    targetAddress: 0x1000,
    requireTls: true,
  });
  await secureTransport.connect();
  assert.equal(secureTransport.isSecure, true);
});

test("send/receive are rejected when the transport is not connected", async () => {
  const endpoint = new FakeDoipEndpoint();
  const transport = new DoipTransport({ socket: endpoint, targetAddress: 0x1000 });
  await assert.rejects(transport.send(fromHex("3E 00")), /not connected/);
  await assert.rejects(transport.receive(10), /not connected/);
});

test("receive() returns null after the timeout", async () => {
  const endpoint = new FakeDoipEndpoint();
  const transport = new DoipTransport({
    socket: endpoint,
    targetAddress: 0x1000,
    activationTimeoutMs: 500,
  });
  await transport.connect();
  assert.equal(await transport.receive(20), null);
});

test("alive check requests are answered with the tester address", async () => {
  const endpoint = new FakeDoipEndpoint();
  const transport = new DoipTransport({
    socket: endpoint,
    targetAddress: 0x1000,
    activationTimeoutMs: 500,
  });
  await transport.connect();
  const before = endpoint.received.length;
  endpoint.emit(encodeMessage(PAYLOAD_TYPE.ALIVE_CHECK_REQUEST, new Uint8Array()));
  await waitFor(
    () => endpoint.received.length,
    (count) => count > before,
    {
      message: "the alive check response",
    },
  );
  assert.equal(endpoint.received.length, before + 1);
  const reply = endpoint.received.at(-1);
  assert.ok(reply);
  assert.equal(decodeHeader(reply).payloadType, PAYLOAD_TYPE.ALIVE_CHECK_RESPONSE);
});

test("discovery broadcasts the identification request and parses announcements", async () => {
  const sent: Uint8Array[] = [];
  let listener: ((chunk: Uint8Array) => void) | null = null;
  const socket = {
    async broadcast(data: Uint8Array) {
      sent.push(data);
      // Answer with an announcement.
      listener?.(
        encodeMessage(
          PAYLOAD_TYPE.VEHICLE_ANNOUNCEMENT_RESPONSE,
          encodeVehicleIdentificationResponse({
            vin: "1HGCM82633A004352",
            logicalAddress: 0x1000,
            eid: fromHex("00 11 22 33 44 55"),
            gid: fromHex("66 77 88 99 AA BB"),
            furtherActionRequired: false,
          }),
        ),
      );
    },
    onData(cb: (chunk: Uint8Array) => void) {
      listener = cb;
      return () => {
        listener = null;
      };
    },
    async close() {},
  };
  const discovery = new DoipDiscovery({ socket, windowMs: 30 });
  const found = await discovery.discover();
  assert.equal(sent.length, 1);
  assert.equal(
    decodeHeader(sent[0] as Uint8Array).payloadType,
    PAYLOAD_TYPE.VEHICLE_IDENTIFICATION_REQUEST,
  );
  assert.equal(found.length, 1);
  assert.equal(found[0]?.vin, "1HGCM82633A004352");
  assert.equal(found[0]?.logicalAddress, 0x1000);
});

test("a missing routing activation response fails connect without a half-open socket", async () => {
  // ISO 13400-2: no activation response within the timeout is a failure. The
  // transport used to stay in "connecting" with its listener still subscribed,
  // so getStatus() reported a state that could never become true again and the
  // next connect() found an open socket.
  const endpoint = new FakeDoipEndpoint();
  endpoint.answersActivation = false;
  const transport = new DoipTransport({
    socket: endpoint,
    targetAddress: 0x1000,
    activationTimeoutMs: 20,
  });
  await assert.rejects(transport.connect(), /no routing activation response/);
  const status = transport.getStatus();
  assert.equal(status.state, "error");
  assert.match(status.lastError ?? "", /no routing activation response/);
  assert.equal(endpoint.isOpen(), false, "the socket is released, not left half-open");
});

test("a broken DoIP frame is reported and the transport keeps working", async () => {
  const endpoint = new FakeDoipEndpoint();
  const transport = new DoipTransport({
    socket: endpoint,
    targetAddress: 0x1000,
    activationTimeoutMs: 500,
  });
  await transport.connect();
  // Version/inverse pair does not XOR to 0xFF → decodeHeader throws
  // (ISO 13400-2 §7.2 header layout).
  endpoint.emit(fromHex("02 02 00 00 00 00 00 08"));
  assert.match(transport.getStatus().lastError ?? "", /version check failed/);
  // A framing error must not poison the stream: the next valid message works.
  endpoint.emit(
    encodeMessage(
      PAYLOAD_TYPE.DIAGNOSTIC_MESSAGE,
      encodeDiagnosticMessage(0x1000, 0x0e00, fromHex("62 F1 90 01")),
    ),
  );
  assert.deepEqual(await transport.receive(50), fromHex("62 F1 90 01"));
  assert.equal(transport.getStatus().state, "connected");
});

test("a message split across TCP segments is reassembled", async () => {
  const endpoint = new FakeDoipEndpoint();
  const transport = new DoipTransport({
    socket: endpoint,
    targetAddress: 0x1000,
    activationTimeoutMs: 500,
  });
  await transport.connect();
  const whole = encodeMessage(
    PAYLOAD_TYPE.DIAGNOSTIC_MESSAGE,
    encodeDiagnosticMessage(0x1000, 0x0e00, fromHex("62 F1 90 31 48 47")),
  );
  const rxBefore = transport.getStatus().rxCount ?? 0;
  // TCP is a byte stream, not a message transport: split mid-header and
  // mid-payload and expect the message to survive.
  endpoint.emit(whole.subarray(0, 3));
  assert.equal(await transport.receive(10), null, "an incomplete header yields nothing");
  endpoint.emit(whole.subarray(3, 10));
  assert.equal(await transport.receive(10), null, "an incomplete payload yields nothing");
  endpoint.emit(whole.subarray(10));
  assert.deepEqual(await transport.receive(50), fromHex("62 F1 90 31 48 47"));
  assert.equal(
    transport.getStatus().rxCount ?? 0,
    rxBefore + 1,
    "only the finished message counts",
  );
});

test("receive() called before the answer arrives resolves with the payload", async () => {
  const endpoint = new FakeDoipEndpoint();
  const transport = new DoipTransport({
    socket: endpoint,
    targetAddress: 0x1000,
    activationTimeoutMs: 500,
  });
  await transport.connect();
  const pending = transport.receive(500);
  endpoint.emit(
    encodeMessage(
      PAYLOAD_TYPE.DIAGNOSTIC_MESSAGE,
      encodeDiagnosticMessage(0x1000, 0x0e00, fromHex("7E 00")),
    ),
  );
  assert.deepEqual(await pending, fromHex("7E 00"), "the waiter is served, nothing is queued");
});

test("disconnect() settles a pending receive with null", async () => {
  const endpoint = new FakeDoipEndpoint();
  const transport = new DoipTransport({
    socket: endpoint,
    targetAddress: 0x1000,
    activationTimeoutMs: 500,
  });
  await transport.connect();
  const pending = transport.receive(5_000);
  await transport.disconnect();
  assert.equal(await pending, null, "no promise may outlive the connection");
  assert.equal(transport.getStatus().state, "disconnected");
});

test("a diagnostic negative ack and a generic NACK become the reported error", async () => {
  const endpoint = new FakeDoipEndpoint();
  const transport = new DoipTransport({
    socket: endpoint,
    targetAddress: 0x1000,
    activationTimeoutMs: 500,
  });
  await transport.connect();
  // ISO 13400-2 §7.4.2: the ack carries source, target and the ack code.
  endpoint.emit(
    encodeMessage(PAYLOAD_TYPE.DIAGNOSTIC_MESSAGE_NEGATIVE_ACK, fromHex("10 00 0E 00 03")),
  );
  assert.match(transport.getStatus().lastError ?? "", /negative ack 0x3/);
  endpoint.emit(encodeMessage(PAYLOAD_TYPE.GENERIC_NACK, fromHex("02")));
  assert.match(transport.getStatus().lastError ?? "", /generic NACK 0x2/);
  assert.equal(transport.getStatus().state, "connected", "a NACK is data, not a broken link");
});

test("an unknown payload type is ignored without disturbing the stream", async () => {
  const endpoint = new FakeDoipEndpoint();
  const transport = new DoipTransport({
    socket: endpoint,
    targetAddress: 0x1000,
    activationTimeoutMs: 500,
  });
  await transport.connect();
  endpoint.emit(encodeMessage(0x7fff, fromHex("01 02")));
  endpoint.emit(
    encodeMessage(
      PAYLOAD_TYPE.DIAGNOSTIC_MESSAGE,
      encodeDiagnosticMessage(0x1000, 0x0e00, fromHex("62 F1 90 02")),
    ),
  );
  assert.deepEqual(await transport.receive(50), fromHex("62 F1 90 02"));
});

test("a failing alive-check response is logged instead of thrown", async () => {
  const endpoint = new FakeDoipEndpoint();
  const transport = new DoipTransport({
    socket: endpoint,
    targetAddress: 0x1000,
    activationTimeoutMs: 500,
  });
  await transport.connect();
  endpoint.sendError = new Error("EPIPE: the entity closed the socket");
  endpoint.emit(encodeMessage(PAYLOAD_TYPE.ALIVE_CHECK_REQUEST, new Uint8Array()));
  // The answer is fire-and-forget; an unhandled rejection would fail the run,
  // so what remains to assert is that the transport is simply still usable.
  await settle(5, "the fire-and-forget answer must reach its catch handler first");
  assert.equal(transport.getStatus().state, "connected");
});

test("discovery parse rejects short datagrams, other payload types and broken payloads", () => {
  const discovery = new DoipDiscovery({
    socket: { async broadcast() {}, onData: () => () => {}, async close() {} },
    sleep: async () => undefined,
  });
  assert.equal(discovery.parse(fromHex("02 FD")), null, "shorter than a DoIP header");
  assert.equal(
    discovery.parse(encodeMessage(PAYLOAD_TYPE.GENERIC_NACK, fromHex("00"))),
    null,
    "a datagram that is not an announcement",
  );
  // Announcement type, but a payload the decoder cannot read (needs 32 bytes).
  assert.equal(
    discovery.parse(encodeMessage(PAYLOAD_TYPE.VEHICLE_ANNOUNCEMENT_RESPONSE, fromHex("00 01"))),
    null,
    "an invalid announcement is reported and skipped, not guessed",
  );
});

test("discovery listens for the default window and unsubscribes when the broadcast fails", async () => {
  const waited: number[] = [];
  let subscribed = 0;
  const socket = {
    async broadcast() {
      throw new Error("ENETUNREACH: no route to the broadcast address");
    },
    onData(_listener: (chunk: Uint8Array) => void) {
      subscribed += 1;
      return () => {
        subscribed -= 1;
      };
    },
    async close() {},
  };
  const discovery = new DoipDiscovery({ socket, sleep: async (ms) => void waited.push(ms) });
  await assert.rejects(discovery.discover(), /ENETUNREACH/);
  assert.deepEqual(waited, [], "the broadcast failed before the listen window started");
  assert.equal(subscribed, 0, "the listener is removed even on the failure path");

  const okWaited: number[] = [];
  const quiet = new DoipDiscovery({
    socket: { async broadcast() {}, onData: () => () => {}, async close() {} },
    sleep: async (ms) => void okWaited.push(ms),
  });
  assert.deepEqual(await quiet.discover(), []);
  assert.deepEqual(okWaited, [DEFAULT_DISCOVERY_WINDOW_MS], "the default window is documented");
});
