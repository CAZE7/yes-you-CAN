/**
 * DoIP end to end, over real sockets (ISO 13400-2; master prompt P2, ADR 0061).
 *
 * The existing `doip-engine.test.ts` proves the transport seam with a fake
 * socket. This file proves the *pipeline*: a virtual entity on loopback UDP and
 * TCP, the production discovery, the production socket bindings, the production
 * link factory, the engine, the diagnostic IR and the evidence set —
 *
 *   discovery (UDP) → routing activation → diagnostic message → UDS → engine
 *     → IR observation → evidence
 *
 * — plus the five ways a DoIP session goes wrong, because that is what a
 * technician meets: an entity that refuses routing activation, one that never
 * answers it, one that cannot route the target address, one that drops the
 * connection mid-session, and one that is not TLS while TLS is required.
 */

import assert from "node:assert/strict";
import { createDoipTcpSocket, createDoipUdpSocket } from "@vdp/adapter-host";
import { collectEvidence, DiagnosticEngine, sessionObservationOf } from "@vdp/core";
import { unreachableEcus } from "@vdp/diagnostic-ir";
import { createDoipEcuLinkFactory } from "@vdp/runtime";
import { createLogger, fromHex } from "@vdp/shared";
import { startVirtualDoipEntity, type VirtualDoipHandle } from "@vdp/simulators";
import { DoipDiscovery } from "@vdp/transport-doip";
import { afterEach, test } from "vitest";
import { waitFor } from "../helpers/wait.js";

const logger = createLogger("doip-pipeline", { level: "ERROR" });
const VIN = "WVWZZZ1JZXW000001";
/** Logical addresses: the entity's gateway and one ECU behind it. */
const ENTITY_ADDRESS = 0x1000;
const ENGINE_ECU = 0x1010;
const TESTER = 0x0e00;

/** A scripted UDS responder: VIN, one stored DTC, session control, tester present. */
function udsHandler(options: { vin?: string; silenceFor?: readonly number[] } = {}) {
  const vin = options.vin ?? VIN;
  return (payload: Uint8Array): Uint8Array | null => {
    const service = payload[0] ?? 0;
    if (options.silenceFor?.includes(service)) return null;
    if (service === 0x3e) return Uint8Array.from([0x7e, payload[1] ?? 0x00]);
    if (service === 0x10)
      return Uint8Array.from([0x50, payload[1] ?? 0x03, 0x00, 0x32, 0x01, 0xf4]);
    if (service === 0x22 && payload[1] === 0xf1 && payload[2] === 0x90) {
      const bytes = Array.from(vin, (character) => character.charCodeAt(0));
      return Uint8Array.from([0x62, 0xf1, 0x90, ...bytes]);
    }
    if (service === 0x22) return Uint8Array.from([0x62, payload[1] ?? 0, payload[2] ?? 0, 0x00]);
    if (service === 0x19 && payload[1] === 0x02) {
      // reportDTCByStatusMask: one confirmed DTC (P0301, status 0x09 = testFailed+confirmed).
      return fromHex("59 02 FF 03 01 00 09");
    }
    if (service === 0x19 && payload[1] === 0x01) return fromHex("59 01 FF 01 03 01 00 09");
    if (service === 0x19) return fromHex("59 0A 01");
    return Uint8Array.from([service + 0x40, 0x00]);
  };
}

const running: VirtualDoipHandle[] = [];
afterEach(async () => {
  while (running.length > 0) await running.pop()?.close();
});

/** Start the virtual entity, keeping it for teardown even when a test fails. */
async function startEntity(
  options: Partial<Parameters<typeof startVirtualDoipEntity>[0]> = {},
): Promise<VirtualDoipHandle> {
  const entity = await startVirtualDoipEntity({
    vin: VIN,
    logicalAddress: ENTITY_ADDRESS,
    handleUds: udsHandler(),
    logger,
    sleep: async () => undefined,
    ...options,
  });
  running.push(entity);
  return entity;
}

function linkFactory(entity: VirtualDoipHandle) {
  return createDoipEcuLinkFactory({
    createSocket: () =>
      createDoipTcpSocket({
        host: "127.0.0.1",
        port: entity.tcpPort,
        connectTimeoutMs: 2000,
      }),
    logicalAddressFor: (ecu) => ecu.rxId,
    testerAddress: TESTER,
    responseTimeoutMs: 700,
    sleep: async () => undefined,
    logger,
  });
}

test("discovery finds the vehicle, and the logical address becomes the ECU target", async () => {
  const entity = await startEntity();
  const socket = createDoipUdpSocket({
    port: 0,
    broadcastAddress: "127.0.0.1",
    broadcastPort: entity.udpPort,
  });
  try {
    const discovery = new DoipDiscovery({
      socket,
      windowMs: 120,
      logger,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    const found = await discovery.discover();
    assert.equal(found.length, 1, "exactly the entity that answered");
    const vehicle = found[0];
    assert.equal(
      vehicle?.vin,
      VIN,
      "the announcement carries the VIN — the identity the session starts from",
    );
    assert.equal(
      vehicle?.logicalAddress,
      ENTITY_ADDRESS,
      "and the logical address the ECU is addressed by",
    );
    assert.equal(vehicle?.furtherActionRequired, false);
  } finally {
    await socket.close();
  }
});

test("the whole pipeline: discovery → routing activation → UDS → IR → evidence", async () => {
  const entity = await startEntity();
  const factory = linkFactory(entity);
  const engine = new DiagnosticEngine({ logger, linkFactory: factory });

  // The addressing step of the pipeline: the ECU target is the logical address
  // the discovery answered with, not a CAN identifier.
  const handle = await engine.attach({ txId: TESTER, rxId: ENGINE_ECU });
  assert.equal(handle.session.record.reachable, true);
  assert.equal(handle.session.record.rxId, ENGINE_ECU);

  // Routing activation ran before the first UDS request (ISO 13400-2 §9.3).
  assert.equal(
    entity.received()[0]?.payloadType,
    0x0005,
    "the first message on the connection is the routing activation request",
  );

  const vin = await handle.session.client.readVin();
  assert.equal(vin, VIN, "the VIN read over DoIP is the one the entity announced");

  // The engine's scan stores the snapshot, which is what the evidence set reads.
  const scan = await engine.scanDtcs(0xff);
  assert.equal(scan.unread.length, 0, "the one ECU was readable");
  const scanned = scan.scanned.flatMap((ecu) => ecu.dtcs);
  assert.equal(scanned.length, 1, "one stored DTC came back over DoIP");
  assert.equal(scanned[0]?.code, "P0301");

  await engine.disconnect();

  // IR: the session as observations, not as a log line. The explicit attach
  // opened the session record, because the DoIP link factory describes its
  // transport (ADR 0061).
  const session = engine.vehicleSession?.data;
  assert.ok(session, "an explicit DoIP attach produces a session record");
  assert.equal(session.transport.kind, "doip", "the record names the transport");
  assert.equal(session.adapter.id, "doip");
  const observation = sessionObservationOf(session);
  assert.equal(observation.transport.kind, "doip", "the session says which transport carried it");
  assert.equal(observation.ecus.length, 1);
  assert.equal(observation.ecus[0]?.reachable, true);
  assert.equal(unreachableEcus(observation).length, 0);

  // Evidence: every item cites the session and keeps its provenance.
  const evidence = collectEvidence({ session, collectedAt: "2026-09-24T10:00:00.000Z" });
  assert.equal(evidence.kind, "evidence");
  assert.equal(evidence.sessionId, session.id);
  const dtcItem = evidence.items.find((item) => item.kind === "dtc");
  assert.ok(
    dtcItem,
    `a stored DTC must become an evidence item: ${JSON.stringify(evidence.items.map((i) => i.kind))}`,
  );
  // The code was observed on the bus — but the generic package documents nothing
  // for P0301, so the *meaning* stays unproven and says why. An evidence item
  // that claimed more than the data supports is exactly what the IR forbids
  // (ADR 0033/0058) — and this is the DoIP path producing that honest answer.
  assert.equal(dtcItem.subject, "P0301", "the observed code is the item's subject");
  assert.match(dtcItem.statement, /P0301|status/, "the statement says what was read");
  // …and the missing documentation becomes its own visible gap item instead of
  // an invented description (ADR 0033/0058: missing evidence is a failure state,
  // not a footnote).
  const gap = evidence.items.find((item) => item.kind === "gap" && item.subject === "P0301");
  assert.ok(
    gap,
    `the undocumented code must also be a gap: ${JSON.stringify(evidence.items.map((i) => i.id))}`,
  );
  assert.ok(
    gap.evidence.kind === "unproven" && /no description|documented/i.test(gap.evidence.reason),
    "the gap says why the code stays unproven",
  );
  const dtcEvidence = dtcItem.evidence;
  assert.ok(
    dtcEvidence.kind === "unproven" && /no description|documented/i.test(dtcEvidence.reason),
    `the DTC item must be honest about the missing documentation: ${JSON.stringify(dtcEvidence)}`,
  );
  // Every item is addressable and timestamped: a report or an analysis cites
  // these ids, so a DoIP session is as quotable as a CAN one.
  assert.ok(evidence.items.every((item) => item.id.length > 0 && item.at.length > 0));
  assert.ok(
    evidence.items.some((item) => item.kind === "vehicle" || item.kind === "gap"),
    "the set says what the session knows about the car and what it could not read",
  );
});

test("a refused routing activation is an error with the entity's own code", async () => {
  // ISO 13400-2 Table 47: 0x02 = "tester address already in use"/refused.
  const entity = await startEntity({ routingActivationCode: 0x02 });
  const engine = new DiagnosticEngine({ logger, linkFactory: linkFactory(entity) });
  await assert.rejects(
    () => engine.attach({ txId: TESTER, rxId: ENGINE_ECU }),
    (error: unknown) =>
      error instanceof Error &&
      /routing activation refused/.test(error.message) &&
      /sourceAddressAlreadyRegistered|0x02/.test(error.message),
    "the refusal names the entity's response code instead of a generic connection error",
  );
  await engine.disconnect();
});

test("an entity that never answers routing activation fails on the activation timeout", async () => {
  const entity = await startEntity({ silentRoutingActivation: true });
  const engine = new DiagnosticEngine({
    logger,
    linkFactory: createDoipEcuLinkFactory({
      createSocket: () =>
        createDoipTcpSocket({ host: "127.0.0.1", port: entity.tcpPort, connectTimeoutMs: 2000 }),
      logicalAddressFor: (ecu) => ecu.rxId,
      responseTimeoutMs: 300,
      logger,
    }),
  });
  await assert.rejects(
    () => engine.attach({ txId: TESTER, rxId: ENGINE_ECU }),
    /no routing activation response within the timeout/,
    "a stack that is up but not routing must say so, not look like a silent ECU",
  );
  await engine.disconnect();
});

test("a diagnostic message the entity cannot route comes back as a negative ack on the state", async () => {
  const entity = await startEntity({ routableTargets: [0x1011] });
  const factory = linkFactory(entity);
  const engine = new DiagnosticEngine({ logger, linkFactory: factory });
  const handle = await engine.attach({ txId: TESTER, rxId: ENGINE_ECU });
  await assert.rejects(
    () => handle.session.client.readVin(),
    /no response|timeout|no answer/i,
    "no ECU answer arrives — the entity refused to route the message",
  );
  const status = factory.states().find((state) => state.targetAddress === ENGINE_ECU)?.status;
  assert.match(
    String(status?.lastError),
    /negative ack 0x3/,
    `the reason must be the entity's refusal, not a silence: ${JSON.stringify(status)}`,
  );
  await engine.disconnect();
});

test("a connection that dies mid-session is revived once, under the same link", async () => {
  const entity = await startEntity();
  const factory = createDoipEcuLinkFactory({
    createSocket: () =>
      createDoipTcpSocket({ host: "127.0.0.1", port: entity.tcpPort, connectTimeoutMs: 2000 }),
    logicalAddressFor: (ecu) => ecu.rxId,
    testerAddress: TESTER,
    responseTimeoutMs: 400,
    reconnect: { attempts: 1, delayMs: 0 },
    sleep: async () => undefined,
    logger,
  });
  const engine = new DiagnosticEngine({ logger, linkFactory: factory });
  const handle = await engine.attach({ txId: TESTER, rxId: ENGINE_ECU });
  assert.equal(await handle.session.client.readVin(), VIN, "precondition: the link works");

  // The vehicle ends the connection — sleep, Wi-Fi drop, entity restart. The
  // death travels through the socket's close notification, so the state moves on
  // its own; wait for the state the test is about instead of guessing a delay.
  entity.killConnections("the vehicle went to sleep");
  await waitFor(
    () => {
      const state = factory.states().find((entry) => entry.targetAddress === ENGINE_ECU)
        ?.status.state;
      return state === "error" || state === "recovering";
    },
    Boolean,
    { timeoutMs: 2000, message: "the killed connection must show up as error or recovering" },
  );

  // The in-flight request fails with the connection's death — not with a
  // timeout that reads like a silent ECU, and not with a silent success.
  await assert.rejects(
    () => handle.session.client.readVin(),
    /not connected|died/i,
    "the request that met the dead connection fails with its cause",
  );

  // The same link object revives within its budget: the session above never
  // re-attached, and the next request answers again.
  const vinAfter = await handle.session.client.readVin();
  assert.equal(vinAfter, VIN, "the same link answers again after the revival");
  const alive = factory.states().find((state) => state.targetAddress === ENGINE_ECU)?.status;
  assert.equal(
    alive?.state,
    "connected",
    `the link reports \`connected\` again: ${JSON.stringify(alive)}`,
  );
  // The revival is a fresh connection *with* routing activation — a new socket
  // without activation is not a diagnostic link.
  const routingRequests = entity.received().filter((entry) => entry.payloadType === 0x0005).length;
  assert.ok(routingRequests >= 2, "the revival activated routing again");
  await engine.disconnect();
});

test("with no attempt left, a dead connection stays an error with the reason", async () => {
  const entity = await startEntity();
  const factory = createDoipEcuLinkFactory({
    createSocket: () =>
      createDoipTcpSocket({ host: "127.0.0.1", port: entity.tcpPort, connectTimeoutMs: 500 }),
    logicalAddressFor: (ecu) => ecu.rxId,
    responseTimeoutMs: 300,
    reconnect: { attempts: 0, delayMs: 0 },
    logger,
  });
  const engine = new DiagnosticEngine({ logger, linkFactory: factory });
  const handle = await engine.attach({ txId: TESTER, rxId: ENGINE_ECU });
  entity.killConnections("gone for good");
  await waitFor(
    () =>
      factory.states().find((entry) => entry.targetAddress === ENGINE_ECU)?.status.state ===
      "error",
    Boolean,
    { timeoutMs: 2000, message: "the killed connection must be reported as an error" },
  );
  await assert.rejects(
    () => handle.session.client.readVin(),
    /not connected|died/i,
    "the request fails with the connection's death",
  );
  const status = factory.states().find((state) => state.targetAddress === ENGINE_ECU)?.status;
  assert.equal(
    status?.state,
    "error",
    `no attempts left means \`error\`, got ${JSON.stringify(status)}`,
  );
  assert.match(String(status?.lastError ?? status?.stateReason), /no reconnect attempt left/);
  await engine.disconnect();
});

test("requireTls refuses the plaintext binding instead of using it", async () => {
  const entity = await startEntity();
  const engine = new DiagnosticEngine({
    logger,
    linkFactory: createDoipEcuLinkFactory({
      createSocket: () =>
        createDoipTcpSocket({ host: "127.0.0.1", port: entity.tcpPort, connectTimeoutMs: 1000 }),
      logicalAddressFor: (ecu) => ecu.rxId,
      requireTls: true,
      logger,
    }),
  });
  await assert.rejects(
    () => engine.attach({ txId: TESTER, rxId: ENGINE_ECU }),
    /TLS is required/,
    "AGENTS 26: a safety-relevant session over plaintext is refused, not downgraded",
  );
  await engine.disconnect();
});

test("a TCP endpoint that is not there fails with the address, not with silence", async () => {
  const engine = new DiagnosticEngine({
    logger,
    linkFactory: createDoipEcuLinkFactory({
      // Port 1 on loopback: nothing listens there.
      createSocket: () =>
        createDoipTcpSocket({ host: "127.0.0.1", port: 1, connectTimeoutMs: 500 }),
      logicalAddressFor: (ecu) => ecu.rxId,
      logger,
    }),
  });
  await assert.rejects(
    () => engine.attach({ txId: TESTER, rxId: ENGINE_ECU }),
    /cannot reach the DoIP entity/,
  );
  await engine.disconnect();
});
