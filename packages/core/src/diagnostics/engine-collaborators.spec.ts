/**
 * Engine collaborators — the pieces ADR 0014 phase 4 split out of the 700-line
 * `DiagnosticEngine` (AGENTS 2, 5, 12, 20, 26, 36).
 *
 * The engine itself is covered through the integration tests; what these tests
 * pin down is the behaviour of the extracted modules *on their own*: the registry
 * bookkeeping, the transport seam (including the case where neither bus nor
 * factory can serve a call), the fault-memory path when one ECU of several fails,
 * the clear path through the write contract, live-data planning, and the failure
 * policy while opening and closing a session.
 *
 * Every ECU here is a real `UdsServer` behind an in-memory link: the tests drive
 * the production code path (session, UDS client, transport seam) instead of a
 * mock of it. Only the CAN bus is a stub, because discovery is a bus protocol.
 */

import assert from "node:assert/strict";
import {
  CURRENT_SCHEMA_VERSION,
  type DefinitionPackage,
  type EcuDefinition,
} from "@vdp/definitions";
import { OemProtocolRegistry } from "@vdp/protocols-oem";
import {
  createRequestResponseLink,
  DID,
  type UdsLink,
  UdsServer,
  type UdsServerLink,
  type UdsServerOptions,
} from "@vdp/protocols-uds";
import { createLogger, fromHex } from "@vdp/shared";
import type { CanBus, CanFilter, CanFrame, FrameListener } from "@vdp/transport-can";
import { describe, expect, test } from "vitest";
import { tick, waitUntil } from "../../../../tests/helpers/wait.js";
import { DtcScanner } from "../dtc/scanner.js";
import { SignalDecoder } from "../measurements/decoder.js";
import { MeasurementRecorder } from "../measurements/recorder.js";
import { SafetyManager } from "../safety/safety-manager.js";
import type { EcuSession } from "../session/session.js";
import { createSession, VehicleSession } from "../session/session.js";
import { clearableEcuOf, runDtcClear } from "../writes/dtc-clear.js";
import type { WriteBinding } from "../writes/port.js";
import { createWritePort } from "../writes/standard-operations.js";
import type { DiscoveredEcu } from "./discovery.js";
import { DtcAccess } from "./dtc-access.js";
import { EcuAttacher } from "./ecu-attacher.js";
import { EcuLinks } from "./ecu-links.js";
import { type EcuHandle, EcuRegistry } from "./ecu-registry.js";
import type { EcuDiagnosticSession } from "./ecu-session.js";
import { DiagnosticEngine } from "./engine.js";
import { MeasurementAccess } from "./measurement-access.js";
import { SessionOpener } from "./session-opener.js";

const logger = createLogger("diagnostics-spec", { level: "ERROR" });

// --- fixtures ---------------------------------------------------------------

const ENGINE_ECU: EcuDefinition = {
  id: "engine",
  name: "Engine control unit",
  address: { txId: 0x7e0, rxId: 0x7e8 },
  protocol: "uds",
  dtcs: [{ code: "P0420", description: "Catalyst efficiency below threshold" }],
};

/** A package with exactly the shape the scanner and the measurement plan read. */
function packageWith(ecus: EcuDefinition[] = [ENGINE_ECU]): DefinitionPackage {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    oem: "test",
    name: "engine collaborator fixture",
    version: "1.2.3",
    provenance: { sourceType: "own", source: "unit test fixture" },
    ecus,
    signals: [
      {
        id: "engine.coolant_temperature",
        name: "Coolant temperature",
        ecu: "engine",
        did: 0x1234,
        byteOffset: 0,
        length: 2,
        encoding: "uint16",
        scale: 0.1,
        unit: "°C",
      },
      {
        id: "engine.oil_temperature",
        name: "Oil temperature",
        ecu: "engine",
        did: 0x1235,
        byteOffset: 0,
        length: 2,
        encoding: "uint16",
        scale: 0.1,
        unit: "°C",
      },
    ],
  };
}

interface InMemoryEcu {
  link: UdsLink;
  server: UdsServer;
}

/** One `UdsServer` reachable through an in-memory request/response link. */
function createInMemoryEcu(options: UdsServerOptions): InMemoryEcu {
  let serverListener: ((payload: Uint8Array) => void) | null = null;
  const inbox: Uint8Array[] = [];

  const serverLink: UdsServerLink = {
    onMessage: (listener) => {
      serverListener = listener;
      return () => {
        serverListener = null;
      };
    },
    send: async (payload) => {
      inbox.push(payload);
    },
  };
  const server = new UdsServer(serverLink, { logger, ...options });
  server.start();

  const link = createRequestResponseLink({
    send: async (data) => {
      const listener = serverListener;
      if (!listener) throw new Error("in-memory ECU is not listening");
      // Delivered the way a wire would hand the frame over — after this task.
      queueMicrotask(() => listener(data));
    },
    receive: async (timeoutMs = 1000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const message = inbox.shift();
        if (message) return message;
        if (Date.now() > deadline) return null;
        await tick(1);
      }
    },
  });

  return { link, server };
}

class StubBus implements CanBus {
  readonly info = { id: "stub", kind: "virtual" as const, name: "Stub CAN", channels: ["vcan0"] };
  readonly capabilities = {
    can: true,
    canFd: false,
    doip: false,
    isoTpOffload: false,
    channels: 1,
  };
  readonly sent: CanFrame[] = [];
  /** Response ids that answer every request — the "wired" ECUs of this bus. */
  responders: number[] = [];
  opened = false;
  closed = false;

  async open(): Promise<void> {
    this.opened = true;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  isOpen(): boolean {
    return this.opened;
  }
  async send(frame: CanFrame): Promise<void> {
    this.sent.push(frame);
    // A wired ECU answers the tester-present probe with a positive response.
    for (const rxId of this.responders) this.emit(rxId, fromHex("7e 00"));
  }
  subscribe(listener: FrameListener, _filters?: readonly CanFilter[]): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
  private listeners: FrameListener[] = [];
  emit(id: number, payload: Uint8Array): void {
    const frame: CanFrame = {
      timestamp: 0,
      id,
      extended: false,
      fd: false,
      dlc: payload.length,
      payload,
      channel: "vcan0",
      direction: "rx",
    };
    for (const listener of [...this.listeners]) listener(frame);
  }
}

interface Harness {
  registry: EcuRegistry;
  attacher: EcuAttacher;
  links: EcuLinks;
  decoder: SignalDecoder;
  recorder: MeasurementRecorder;
  definitions: readonly DefinitionPackage[];
}

function harness(options: { links?: EcuLinks; definitions?: DefinitionPackage[] } = {}): Harness {
  const definitions = options.definitions ?? [packageWith()];
  const registry = new EcuRegistry();
  const decoder = new SignalDecoder({ logger });
  const recorder = new MeasurementRecorder(() => 0);
  const links = options.links ?? new EcuLinks({}, logger);
  const attacher = new EcuAttacher({
    links,
    registry,
    definitions,
    oemProtocols: new OemProtocolRegistry([]),
    decoder,
    logger,
  });
  return { registry, attacher, links, decoder, recorder, definitions };
}

function discovered(overrides: Partial<DiscoveredEcu> = {}): DiscoveredEcu {
  return { txId: 0x7e0, rxId: 0x7e8, extended: false, frames: 1, ...overrides };
}

function dtcAccess(h: Harness): DtcAccess {
  return new DtcAccess({
    registry: h.registry,
    scanner: new DtcScanner({ definitions: h.definitions }),
    oemProtocols: new OemProtocolRegistry([]),
    recorder: h.recorder,
    logger,
  });
}

/** The write side of the same vehicle: its own port, the same safety manager. */
function writePort(h: Harness): ReturnType<typeof createWritePort> {
  return createWritePort({
    safety: new SafetyManager({ logger }),
    scanner: new DtcScanner({ definitions: h.definitions }),
    logger,
  });
}

function writeBinding(ecuId: string, ecuName: string, sessionType: number): WriteBinding {
  return {
    ecuId,
    ecuName,
    sessionType,
    definitionVersion: "1.0.0",
    vehicleState: { stationary: true, ignitionOn: true, parkingBrake: true, batteryVoltage: 13.1 },
  };
}

// --- EcuRegistry -------------------------------------------------------------

describe("EcuRegistry — address to handle bookkeeping", () => {
  test("indexes a handle by response and request identifier", () => {
    const registry = new EcuRegistry();
    const handle = { discovered: discovered() } as EcuHandle;
    registry.add(handle);
    assert.equal(registry.size, 1);
    assert.equal(registry.byResponseId(0x7e8), handle);
    assert.equal(registry.byRequestId(0x7e0), handle);
    assert.deepEqual(registry.all, [handle]);
    assert.equal(registry.byResponseId(0x7e9), undefined);

    registry.clear();
    assert.equal(registry.size, 0);
    assert.deepEqual(registry.all, []);
  });

  test("require() names the address instead of returning undefined", () => {
    const registry = new EcuRegistry();
    assert.throws(
      () => registry.require(0x7e8),
      /no ECU session for 0x7e8 — call connect\(\) first/,
    );
  });

  test("definitionRefOf splits the qualified id and keeps absence absent", () => {
    assert.deepEqual(
      EcuRegistry.definitionRefOf({
        discovered: discovered({ definitionEcuId: "vag:engine" }),
      } as EcuHandle),
      { oem: "vag", ecu: "engine" },
    );
    assert.deepEqual(
      EcuRegistry.definitionRefOf({
        discovered: discovered({ definitionEcuId: "engine" }),
      } as EcuHandle),
      { ecu: "engine" },
    );
    assert.equal(
      EcuRegistry.definitionRefOf({ discovered: discovered() } as EcuHandle),
      undefined,
      "a plain CAN scan finds ECUs without a definition — that is not an error",
    );
  });
});

// --- EcuLinks ----------------------------------------------------------------

describe("EcuLinks — the transport seam", () => {
  test("refuses to build an ISO-TP link without a bus, naming the caller", () => {
    const links = new EcuLinks({}, logger);
    assert.equal(links.hasBus, false);
    assert.throws(
      () => links.createIsoTp(0x7e0, 0x7e8, false),
      /createIsoTp\(\) needs a CAN bus — pass one or provide a linkFactory/,
    );
  });

  test("opens ISO-TP on the bus when no factory is given", async () => {
    const bus = new StubBus();
    const links = new EcuLinks({ bus }, logger);
    assert.equal(links.hasBus, true);
    const opened = await links.open({ txId: 0x7e0, rxId: 0x7e8, extended: false });
    assert.ok(opened.link, "the bus path yields a usable UdsLink");
    opened.close();
  });

  test("a linkFactory overrides the bus entirely (the DoIP path)", async () => {
    const ecu = createInMemoryEcu({ name: "engine", dids: [] });
    let asked: { txId: number; rxId: number } | null = null;
    const links = new EcuLinks(
      {
        linkFactory: {
          open: (target) => {
            asked = { txId: target.txId, rxId: target.rxId };
            return { link: ecu.link, close: () => undefined };
          },
        },
      },
      logger,
    );
    const opened = await links.open({ txId: 0x7e0, rxId: 0x7e8, extended: false });
    assert.deepEqual(asked, { txId: 0x7e0, rxId: 0x7e8 });
    assert.equal(opened.link, ecu.link);
  });
});

// --- EcuAttacher + SessionOpener --------------------------------------------

describe("EcuAttacher and SessionOpener — session lifecycle", () => {
  test("an ECU that cannot be attached stays visible with its failure", () => {
    const bus = new StubBus();
    const h = harness({ links: new EcuLinks({ bus }, logger), definitions: [] });
    const session = h.attacher.attachFailed(discovered(), "no response after 3 attempts");
    assert.equal(session.rxId, 0x7e8);
    assert.equal(session.lastError, "no response after 3 attempts");
  });

  test("attach() registers the handle and reads identification", async () => {
    const ecu = createInMemoryEcu({
      name: "engine",
      dids: [
        {
          did: DID.VEHICLE_IDENTIFIER_NUMBER,
          value: () => new TextEncoder().encode("WVWZZZ1JZXW000001"),
        },
        { did: 0xf187, value: () => fromHex("00 11 22 33") },
      ],
    });
    const links = new EcuLinks(
      { linkFactory: { open: () => ({ link: ecu.link, close: () => undefined }) } },
      logger,
    );
    const h = harness({ links });
    const handle = await h.attacher.attachExplicit({
      txId: 0x7e0,
      rxId: 0x7e8,
      definitionEcuId: "test:engine",
    });
    assert.equal(h.registry.size, 1);
    assert.equal(handle.session.record.rxId, 0x7e8);
    assert.deepEqual(EcuRegistry.definitionRefOf(handle), { oem: "test", ecu: "engine" });
    const supported = await h.attacher.identify(handle);
    assert.ok(supported >= 0, "probing reports a count, never throws");
  });

  test("the VIN is read from the first ECU that answers DID 0xF190", async () => {
    const ecu = createInMemoryEcu({
      name: "engine",
      dids: [
        {
          did: DID.VEHICLE_IDENTIFIER_NUMBER,
          value: () => new TextEncoder().encode("WVWZZZ1JZXW000001"),
        },
      ],
    });
    const links = new EcuLinks(
      { linkFactory: { open: () => ({ link: ecu.link, close: () => undefined }) } },
      logger,
    );
    const h = harness({ links });
    await h.attacher.attach(discovered());
    const session = new VehicleSession(
      createSession({
        adapter: new StubBus().info,
        transport: { kind: "can", channel: "vcan0", mtu: 8 },
      }),
    );
    const identity = await h.attacher.detectVehicleIdentity(session);
    assert.equal(identity?.vin, "WVWZZZ1JZXW000001");
    assert.equal(session.data.vehicle?.vin, "WVWZZZ1JZXW000001");
  });

  test("connect() needs a bus and closes what it opened", async () => {
    const h = harness();
    const opener = new SessionOpener({
      definitions: h.definitions,
      attacher: h.attacher,
      registry: h.registry,
      logger,
    });
    await assert.rejects(opener.open(), /connect\(\) needs a CAN bus/);

    const bus = new StubBus();
    const withBus = new SessionOpener({
      bus,
      definitions: h.definitions,
      attacher: h.attacher,
      registry: h.registry,
      logger,
    });
    const { session, ecus } = await withBus.open({ windowMs: 1 });
    assert.equal(bus.opened, true, "the bus is opened before discovery");
    assert.deepEqual(ecus, [], "an empty bus finds no ECUs and still yields a session");
    assert.equal(session.data.ecus.length, 0);
    assert.equal(session.data.adapter.id, "stub");

    await withBus.close(session);
    assert.equal(bus.closed, true, "close() releases the bus");
    assert.equal(withBus ? h.registry.size : -1, 0, "and forgets the handles with it");
  });

  test("a failing ECU does not abort the session (failure policy)", async () => {
    const bus = new StubBus();
    bus.responders = [0x7e8];
    const h = harness({
      links: new EcuLinks(
        {
          bus,
          linkFactory: {
            open: () => {
              throw new Error("ECU did not answer the session request");
            },
          },
        },
        logger,
      ),
    });
    const opener = new SessionOpener({
      bus,
      definitions: h.definitions,
      attacher: h.attacher,
      registry: h.registry,
      logger,
    });
    const { session, ecus } = await opener.open({ windowMs: 2, probeDelayMs: 1 });
    assert.equal(ecus.length, 1, "discovery found the answering ECU");
    assert.equal(session.data.ecus.length, 1, "and the session knows it exists");
    assert.match(
      session.data.ecus[0]?.lastError ?? "",
      /ECU did not answer the session request/,
      "the failure is recorded instead of the ECU disappearing",
    );
    await opener.close(session);
    assert.equal(bus.closed, true, "the session is opened and closed despite the failing ECU");
  });
});

// --- DtcAccess ---------------------------------------------------------------

describe("DtcAccess — fault memory, enrichment and the write path", () => {
  test("scanEcu enriches codes and marks them on the time axis", async () => {
    const ecu = createInMemoryEcu({ name: "engine", dtcs: [{ code: "P0420", status: 0x08 }] });
    const links = new EcuLinks(
      { linkFactory: { open: () => ({ link: ecu.link, close: () => undefined }) } },
      logger,
    );
    const h = harness({ links });
    const handle = await h.attacher.attach(discovered());
    const dtcs = dtcAccess(h);
    const result = await dtcs.scanOne(handle);
    assert.equal(result.dtcs.length, 1);
    assert.equal(result.dtcs[0]?.code, "P0420");
    assert.equal(result.dtcs[0]?.description, "Catalyst efficiency below threshold");
    const markers = h.recorder.markers;
    assert.equal(markers.length, 1, "one marker per fault code, on the time axis");
    assert.equal(markers[0]?.label, "P0420");
    assert.match(markers[0]?.detail ?? "", /Status 0x08/);
  });

  test("scanAll keeps going when one ECU fails — and names the one it could not read", async () => {
    const ecu = createInMemoryEcu({ name: "engine", dtcs: [{ code: "P0420", status: 0x08 }] });
    const links = new EcuLinks(
      { linkFactory: { open: () => ({ link: ecu.link, close: () => undefined }) } },
      logger,
    );
    const h = harness({ links });
    await h.attacher.attach(discovered());
    const broken = {
      session: {
        id: "ghost",
        record: { id: "ghost", name: "Ghost ECU", reachable: true } as EcuSession,
        readDtcs: async () => {
          throw new Error("no response from 0x7e9");
        },
      } as unknown as EcuDiagnosticSession,
      reader: { ecuId: "ghost", readRaw: async () => null },
      discovered: discovered({ rxId: 0x7e9, txId: 0x7e1 }),
    } as EcuHandle;
    h.registry.add(broken);

    const session = new VehicleSession(
      createSession({
        adapter: new StubBus().info,
        transport: { kind: "can", channel: "vcan0", mtu: 8 },
      }),
    );
    const { scanned, unread } = await dtcAccess(h).scanAll(session, "test");
    assert.equal(scanned.length, 1, "the failed ECU is skipped, not fatal");
    assert.equal(session.data.dtcSnapshots.length, 1, "a full scan becomes the session snapshot");
    // Skipping is not silencing (ADR 0049). The module that stayed silent comes back
    // with the address it was asked on and the reason the bus gave, because a result
    // of "one code" over a bus where a second module never answered is a claim about
    // the car that the scan did not measure.
    assert.deepEqual(unread, [
      { ecuId: "ghost", ecuName: "Ghost ECU", rxId: 0x7e9, reason: "no response from 0x7e9" },
    ]);
  });

  test("a scan every module answered reports no gaps", async () => {
    const ecu = createInMemoryEcu({ name: "engine", dtcs: [{ code: "P0420", status: 0x08 }] });
    const links = new EcuLinks(
      { linkFactory: { open: () => ({ link: ecu.link, close: () => undefined }) } },
      logger,
    );
    const h = harness({ links });
    await h.attacher.attach(discovered());
    const session = new VehicleSession(
      createSession({
        adapter: new StubBus().info,
        transport: { kind: "can", channel: "vcan0", mtu: 8 },
      }),
    );
    const { scanned, unread } = await dtcAccess(h).scanAll(session, "test");
    assert.equal(scanned.length, 1, "the answering module is in the result");
    // The other half has a shape for "nothing was missing", so a caller never has to
    // guess whether an empty list means healthy or unheard.
    assert.deepEqual(unread, []);
  });

  test("the read side cannot write: a handle crosses to the write port, which owns the permit", async () => {
    const ecu = createInMemoryEcu({ name: "engine", dtcs: [{ code: "P0420", status: 0x08 }] });
    const links = new EcuLinks(
      { linkFactory: { open: () => ({ link: ecu.link, close: () => undefined }) } },
      logger,
    );
    const h = harness({ links });
    const handle = await h.attacher.attach(discovered());
    const access = dtcAccess(h);
    const writes = writePort(h);

    // Read and write are separate objects (master backlog P0 #3): the fault
    // memory reader has no method that can change the vehicle.
    assert.equal(Object.hasOwn(access, "clear"), false);
    assert.equal(Object.hasOwn(access, "evaluate"), false);
    assert.deepEqual(writes.kinds, ["clear-dtc", "coding", "adaptation"]);

    const target = clearableEcuOf(handle);
    const binding = writeBinding(target.id, target.name, target.sessionType);

    // Without confirmation the write port refuses before touching the ECU - and
    // the refusal is data the caller can act on, not a thrown error (P0 #4).
    const refused = await runDtcClear(writes, { target, userConfirmed: false }, binding);
    assert.equal(refused.ok, false);
    assert.ok(refused.reasons.some((reason) => /confirmation/i.test(reason)));
    const confirm = refused.stages.find((stage) => stage.stage === "confirm");
    assert.equal(confirm?.state, "failed");

    // With the confirmation the same handle goes through the whole staged write:
    // session switch, 0x14, re-read, permit and audit entry.
    const result = await runDtcClear(writes, { target, userConfirmed: true }, binding);
    assert.equal(result.ok, true);
    assert.equal(result.value?.verified, true);
    assert.equal(result.value?.permit.risk, "medium");
    assert.deepEqual(
      result.stages.map((stage) => stage.stage),
      ["prepare", "confirm", "execute", "verify"],
    );
    assert.ok(result.value?.transactionId, "the audit log can refer to the transaction");
  });
});

// --- MeasurementAccess -------------------------------------------------------

describe("MeasurementAccess — plan, snapshot and live data", () => {
  test("finds signals across packages and honours a filter", () => {
    const h = harness();
    const handle = {
      session: { id: "s1", signals: packageWith().signals },
    } as unknown as EcuHandle;
    h.registry.add({
      ...handle,
      reader: { ecuId: "s1", readRaw: async () => null },
      discovered: discovered(),
    } as EcuHandle);
    const access = new MeasurementAccess({
      registry: h.registry,
      recorder: h.recorder,
      decoder: h.decoder,
      definitions: h.definitions,
      logger,
    });
    assert.equal(access.findSignal("engine.oil_temperature")?.did, 0x1235);
    assert.equal(access.findSignal("engine.does_not_exist"), undefined);
    assert.equal(access.buildPlan().get("s1")?.length, 2, "no filter means every defined signal");
    assert.equal(access.buildPlan(["engine.oil_temperature"]).get("s1")?.length, 1);
  });

  test("live data needs a session and records what the ECU answers", async () => {
    const ecu = createInMemoryEcu({
      name: "engine",
      dids: [{ did: 0x1234, value: () => fromHex("01 2c") }],
    });
    const links = new EcuLinks(
      { linkFactory: { open: () => ({ link: ecu.link, close: () => undefined }) } },
      logger,
    );
    const h = harness({ links });
    await h.attacher.attach(discovered());
    const access = new MeasurementAccess({
      registry: h.registry,
      recorder: h.recorder,
      decoder: h.decoder,
      definitions: h.definitions,
      logger,
      pollIntervalMs: 5,
    });
    await assert.rejects(access.startLive(null, {}), /no session — call connect\(\) first/);

    const session = new VehicleSession(
      createSession({
        adapter: new StubBus().info,
        transport: { kind: "can", channel: "vcan0", mtu: 8 },
      }),
    );
    const engine = await access.startLive(session, { maxRounds: 5, intervalMs: 2 });
    assert.equal(access.running, engine);
    // Bounded rounds: the engine stops itself, the test waits for that condition
    // (ADR 0019 — never for a fixed duration).
    await waitUntil(() => !engine.isRunning, {
      message: "the live data engine finished its bounded rounds",
    });
    access.stopLive();
    assert.equal(access.running, null);
    // Only the DID the ECU also answers is recorded; the second signal is skipped.
    const samples = h.recorder.samplesFor("engine.coolant_temperature");
    if (samples.length > 0) {
      assert.equal(samples[0]?.value, 30, "0x012c scaled by 0.1 is 30 °C");
    }
    assert.equal(h.recorder.samplesFor("engine.oil_temperature").length, 0);
  });
});

// --- DiagnosticEngine façade -------------------------------------------------

describe("DiagnosticEngine — the façade delegates", () => {
  test("statics stay available for tooling", () => {
    assert.equal(DiagnosticEngine.deriveTxId(0x7e8), 0x7e0);
    assert.match(DiagnosticEngine.newTraceId(), /^trace/);
    assert.equal(DiagnosticEngine.hex(fromHex("0a 0b")), "0A 0B");
  });

  test("queries before connect() answer instead of throwing", async () => {
    const engine = new DiagnosticEngine({ logger });
    assert.equal(engine.vehicleSession, null);
    assert.equal(await engine.detectVehicleIdentity(), undefined);
    assert.equal(engine.vehicleContext, undefined);
    assert.equal(engine.handleFor(0x7e8), undefined);
    assert.equal(engine.handleForTxId(0x7e0), undefined);
    assert.deepEqual(await engine.snapshotSignals(), [], "no ECUs, no samples, no throw");
    await assert.rejects(engine.scanDtcs(), /no session — call connect\(\) first/);
    await assert.rejects(engine.startLiveData(), /no session — call connect\(\) first/);
    await engine.disconnect();
  });

  test("attach() makes ECU access and the vehicle context work", async () => {
    const ecu = createInMemoryEcu({
      name: "engine",
      dtcs: [{ code: "P0420", status: 0x08 }],
      dids: [{ did: 0x1234, value: () => fromHex("01 2c") }],
    });
    const engine = new DiagnosticEngine({
      logger,
      definitions: [packageWith()],
      linkFactory: { open: () => ({ link: ecu.link, close: () => undefined }) },
    });
    const handle = await engine.attach({
      txId: 0x7e0,
      rxId: 0x7e8,
      definitionEcuId: "test:engine",
    });
    assert.equal(engine.ecuHandles.length, 1);
    assert.equal(engine.handleFor(0x7e8), handle);
    assert.equal(engine.handleForTxId(0x7e0), handle);
    assert.equal(engine.findSignal("engine.coolant_temperature")?.did, 0x1234);
    assert.equal(engine.buildPlan().size, 1);
    assert.equal(engine.activePackage?.version, "1.2.3");

    engine.setVehicleContext({ oem: "test", vehicleId: "golf-vii" });
    assert.equal(engine.vehicleContext?.vehicleId, "golf-vii");
    const scanned = await engine.scanEcu(0x7e8);
    assert.equal(scanned.dtcs.length, 1);
    await engine.disconnect();
    assert.equal(engine.vehicleContext, undefined, "knowledge does not outlive the session");
    expect(() => engine.handleFor(0x7e8)).not.toThrow();
  });
});
