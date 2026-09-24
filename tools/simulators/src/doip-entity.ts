/**
 * Virtual DoIP entity — a vehicle that speaks ISO 13400-2 (master prompt P2,
 * ADR 0061).
 *
 * The DoIP side of the platform needs the same thing the CAN side already has:
 * a counterpart that answers for real, so the whole chain — UDP discovery,
 * routing activation, diagnostic messages, UDS inside them — can be driven
 * reproducibly without a car and without a fake socket. This entity listens on
 * real UDP and TCP sockets on loopback, decodes with the production codec (no
 * second copy of the framing) and answers from a UDS handler the caller
 * provides — typically `UdsServer` behind the same response function the virtual
 * CAN vehicle uses.
 *
 * It is a tool, not a layer (architecture.yaml): nothing in the product imports
 * it, and it exists so a test — or a demo — can point a real DoIP client at
 * something that behaves like an entity.
 *
 * What it can be told to do wrong, because the failures are the interesting
 * part (AGENTS 31, ADR 0005):
 *
 * | Knob | Models |
 * |---|---|
 * | `refuseRoutingActivation` | an entity that does not accept this tester |
 * | `silentRoutingActivation` | an entity whose stack is up but whose routing service is not |
 * | `diagnosticDelayMs` | a slow back end (P2/P2* pressure) |
 * | `dropAcknowledgements` | a peer that answers anyway (positive ack missing) |
 * | `killConnections()` | a vehicle that went to sleep / a Wi-Fi drop |
 * | `unreachableTargets` | a diagnostic message for an ECU this entity cannot route to (negative ack) |
 * | `genericNackFor` | an entity that refuses a payload type outright |
 */

import { createSocket as createUdpSocket, type Socket as UdpSocket } from "node:dgram";
import { createServer, type Server, type Socket } from "node:net";
import { createLogger, type Logger, messageOf, toHex } from "@vdp/shared";
import {
  DOIP_HEADER_LENGTH,
  decodeDiagnosticMessage,
  decodeHeader,
  encodeDiagnosticMessage,
  encodeMessage,
  encodeRoutingActivationResponse,
  encodeVehicleIdentificationResponse,
  NACK_CODES,
  PAYLOAD_TYPE,
  ROUTING_ACTIVATION_RESPONSE_CODES,
  type VehicleIdentificationResponse,
} from "@vdp/transport-doip";

/** Answers one UDS payload as the ECU would; `null` means "no answer". */
export type DoipUdsHandler = (
  payload: Uint8Array,
) => Uint8Array | null | Promise<Uint8Array | null>;

export interface VirtualDoipEntityOptions {
  /** VIN the vehicle announces (ISO 3779, 17 characters). */
  vin: string;
  /** Logical address of this entity (the "gateway"), e.g. 0x1000. */
  logicalAddress?: number;
  /** Logical addresses the entity can route diagnostic messages to. Empty = all. */
  routableTargets?: readonly number[];
  /** The UDS handler behind the diagnostic messages. */
  handleUds: DoipUdsHandler;
  /** Refuse routing activation with this code (0x10 is success, ISO 13400-2 Table 47). */
  routingActivationCode?: number;
  /** Accept the TCP connection but never answer the activation request. */
  silentRoutingActivation?: boolean;
  /** Delay every diagnostic answer — a slow vehicle, and P2 pressure. */
  diagnosticDelayMs?: number;
  /** Do not send the positive acknowledgement before the answer. */
  dropAcknowledgements?: boolean;
  /** Payload types that receive a generic NACK instead of an answer. */
  genericNackFor?: readonly number[];
  /** Vehicle identification response details (EID/GID come from the entity's own choice). */
  furtherAction?: number;
  logger?: Logger;
  /** Injectable wait, so tests do not spend the real delay. */
  sleep?: (ms: number) => Promise<void>;
}

/** An entity that is running and can be pointed at with a real TCP socket. */
export interface VirtualDoipHandle {
  /** UDP port that answers vehicle identification requests. */
  udpPort: number;
  /** TCP port that accepts routing activation and diagnostic messages. */
  tcpPort: number;
  /** The announcement the entity answers discovery with. */
  identification(): VehicleIdentificationResponse;
  /** How many TCP connections are open right now. */
  openConnections(): number;
  /** Kill every open connection as a sleeping vehicle would. */
  killConnections(reason?: string): void;
  /** Diagnostics for the test: every payload type and UDS payload seen. */
  received(): ReadonlyArray<{ payloadType: number; uds?: number[] }>;
  close(): Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Start a virtual DoIP entity on loopback (UDP + TCP, ephemeral ports). */
export async function startVirtualDoipEntity(
  options: VirtualDoipEntityOptions,
): Promise<VirtualDoipHandle> {
  const log = (options.logger ?? createLogger("simulator", { level: "INFO" })).child("simulator");
  const sleep = options.sleep ?? defaultSleep;
  const logicalAddress = options.logicalAddress ?? 0x1000;
  const seen: Array<{ payloadType: number; uds?: number[] }> = [];
  const sockets = new Set<Socket>();

  const identification = (): VehicleIdentificationResponse => ({
    vin: options.vin,
    logicalAddress,
    eid: Uint8Array.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]),
    gid: Uint8Array.from([0x00, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e]),
    furtherActionRequired: (options.furtherAction ?? 0x00) !== 0x00,
  });

  /* ------------------------------------------------------------------ UDP */
  const udp: UdpSocket = createUdpSocket({ type: "udp4" });
  udp.on("message", (message: Buffer, remote) => {
    let payloadType: number;
    try {
      payloadType = decodeHeader(new Uint8Array(message)).payloadType;
    } catch (error) {
      log.debug("ignoring a malformed discovery datagram", { error: messageOf(error) });
      return;
    }
    if (payloadType !== PAYLOAD_TYPE.VEHICLE_IDENTIFICATION_REQUEST) return;
    const response = encodeMessage(
      PAYLOAD_TYPE.VEHICLE_ANNOUNCEMENT_RESPONSE,
      encodeVehicleIdentificationResponse(identification()),
    );
    udp.send(response, remote.port, remote.address, (error) => {
      if (error) log.warn("the announcement could not be sent", { error: messageOf(error) });
    });
  });
  await new Promise<void>((resolve, reject) => {
    udp.bind(0, "127.0.0.1", () => resolve());
    udp.once("error", reject);
  });
  const udpPort = (udp.address() as { port: number }).port;

  /* ------------------------------------------------------------------ TCP */
  const handleChunk = async (socket: Socket, buffer: Uint8Array): Promise<void> => {
    // Frame by frame; the entity keeps no state between messages, because a DoIP
    // entity is message oriented (ISO 13400-2 §7).
    let pending = buffer;
    while (pending.length >= DOIP_HEADER_LENGTH) {
      const header = decodeHeader(pending);
      const total = DOIP_HEADER_LENGTH + header.payloadLength;
      if (pending.length < total) break;
      const payload = pending.subarray(DOIP_HEADER_LENGTH, total).slice();
      pending = new Uint8Array(pending.subarray(total));
      await handleMessage(socket, header.payloadType, payload);
    }
    return;
  };

  const handleMessage = async (
    socket: Socket,
    payloadType: number,
    payload: Uint8Array,
  ): Promise<void> => {
    seen.push({ payloadType });
    if (options.genericNackFor?.includes(payloadType)) {
      await write(socket, encodeMessage(PAYLOAD_TYPE.GENERIC_NACK, new Uint8Array([0x04])));
      return;
    }
    if (payloadType === PAYLOAD_TYPE.ROUTING_ACTIVATION_REQUEST) {
      if (options.silentRoutingActivation) {
        log.debug("routing activation deliberately left unanswered");
        return;
      }
      const code = options.routingActivationCode ?? 0x10;
      const response = encodeMessage(
        PAYLOAD_TYPE.ROUTING_ACTIVATION_RESPONSE,
        encodeRoutingActivationResponse(
          ((payload[0] ?? 0) << 8) | (payload[1] ?? 0),
          logicalAddress,
          code,
        ),
      );
      log.info("routing activation answered", {
        code: ROUTING_ACTIVATION_RESPONSE_CODES[code] ?? `0x${code.toString(16)}`,
      });
      await write(socket, response);
      return;
    }
    if (payloadType !== PAYLOAD_TYPE.DIAGNOSTIC_MESSAGE) return;

    const decoded = decodeDiagnosticMessage(payload);
    seen.push({ payloadType, uds: Array.from(decoded.udsPayload) });
    const routable =
      options.routableTargets === undefined ||
      options.routableTargets.includes(decoded.targetAddress);
    if (!routable) {
      // ISO 13400-2 §9.4.5: the entity could not route the message to an ECU.
      await write(
        socket,
        encodeMessage(
          PAYLOAD_TYPE.DIAGNOSTIC_MESSAGE_NEGATIVE_ACK,
          Uint8Array.from([
            decoded.sourceAddress >> 8,
            decoded.sourceAddress & 0xff,
            decoded.targetAddress >> 8,
            decoded.targetAddress & 0xff,
            0x03, // unknown target address
          ]),
        ),
      );
      return;
    }
    if (options.diagnosticDelayMs) await sleep(options.diagnosticDelayMs);
    const answer = await options.handleUds(decoded.udsPayload);
    if (answer === null) return;
    if (!options.dropAcknowledgements) {
      await write(
        socket,
        encodeMessage(
          PAYLOAD_TYPE.DIAGNOSTIC_MESSAGE_POSITIVE_ACK,
          Uint8Array.from([
            decoded.targetAddress >> 8,
            decoded.targetAddress & 0xff,
            decoded.sourceAddress >> 8,
            decoded.sourceAddress & 0xff,
            0x00,
          ]),
        ),
      );
    }
    await write(
      socket,
      encodeMessage(
        PAYLOAD_TYPE.DIAGNOSTIC_MESSAGE,
        encodeDiagnosticMessage(decoded.targetAddress, decoded.sourceAddress, answer),
      ),
    );
  };

  const write = async (socket: Socket, data: Uint8Array): Promise<void> => {
    if (socket.destroyed) return;
    await new Promise<void>((resolve) => {
      socket.write(data, () => resolve());
    });
  };

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    let buffer = new Uint8Array();
    socket.on("data", (chunk: Buffer) => {
      buffer = new Uint8Array(Buffer.concat([Buffer.from(buffer), chunk]));
      void handleChunk(socket, buffer).catch((error) =>
        log.warn("the entity could not answer a message", { error: messageOf(error) }),
      );
      buffer = new Uint8Array();
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", (error) => {
      log.debug("connection error in the virtual entity", { error: messageOf(error) });
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const tcpPort = (server.address() as { port: number }).port;
  log.info("virtual DoIP entity listening", {
    udp: udpPort,
    tcp: tcpPort,
    vin: options.vin,
    logicalAddress: `0x${logicalAddress.toString(16)}`,
  });

  return {
    udpPort,
    tcpPort,
    identification,
    openConnections: () => sockets.size,
    killConnections: (reason = "the vehicle ended the connection") => {
      for (const socket of sockets) {
        log.info("virtual entity drops a connection", { reason, peers: toHex(new Uint8Array()) });
        socket.destroy();
      }
      sockets.clear();
    },
    received: () => seen,
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => udp.close(() => resolve()));
    },
  };
}

/** The payload-type names, for readable assertions in tests. */
export const DOIP_PAYLOAD_NAMES: Readonly<Record<number, string>> = {
  [PAYLOAD_TYPE.GENERIC_NACK]: NACK_CODES[0x04] ?? "generic nack",
  [PAYLOAD_TYPE.VEHICLE_IDENTIFICATION_REQUEST]: "vehicle identification request",
  [PAYLOAD_TYPE.VEHICLE_ANNOUNCEMENT_RESPONSE]: "vehicle announcement / identification response",
  [PAYLOAD_TYPE.ROUTING_ACTIVATION_REQUEST]: "routing activation request",
  [PAYLOAD_TYPE.ROUTING_ACTIVATION_RESPONSE]: "routing activation response",
  [PAYLOAD_TYPE.DIAGNOSTIC_MESSAGE]: "diagnostic message",
  [PAYLOAD_TYPE.DIAGNOSTIC_MESSAGE_POSITIVE_ACK]: "diagnostic message positive ack",
  [PAYLOAD_TYPE.DIAGNOSTIC_MESSAGE_NEGATIVE_ACK]: "diagnostic message negative ack",
};
