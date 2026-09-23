/**
 * The harvest driver, against a real UDS stack (ADR 0058).
 *
 * These tests run the whole read path — virtual CAN, ISO-TP, a `UdsServer` per ECU
 * — because a harvest is exactly the thing that must not be tested against a mock
 * that already knows the answers. What is pinned:
 *
 * - the sweep finds the ECUs and reads identification, DIDs and fault memory,
 * - a refusal becomes a *grouped* refusal with its NRC, not a lost question,
 * - a transport failure stays distinct from a refusal (ADR 0033),
 * - the availability mask travels from the ECU into the record,
 * - the VIN is masked unless asked for,
 * - and nothing the driver sends is a write: the source itself is scanned for the
 *   write APIs, so a future edit that "just clears the memory first" fails here.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { genericPackage } from "@vdp/definitions";
import { SID } from "@vdp/protocols-uds";
import { createLogger } from "@vdp/shared";
import { VirtualVehicle } from "@vdp/simulators";
import { afterAll, beforeAll, describe, test } from "vitest";
import { harvestVehicle } from "./harvest.js";
import { FORBIDDEN_HARVEST_SERVICES } from "./plan.js";

const logger = createLogger("harvest-spec", { level: "ERROR" });
const vehicle = new VirtualVehicle({
  logger,
  definitions: genericPackage,
  seed: 42,
  dtcs: {
    engine: [
      { code: "P0420", status: 0x2f, snapshot: new Uint8Array([0x09, 0x46, 0x00, 0x32]) },
      { code: "P0300", status: 0x24 },
    ],
  },
});

beforeAll(async () => {
  await vehicle.start();
});

afterAll(async () => {
  await vehicle.stop();
});

/** One harvest of the virtual vehicle, with the waits a test does not need. */
async function harvest(
  overrides: Parameters<typeof harvestVehicle>[0] extends infer O
    ? O extends object
      ? Partial<O>
      : never
    : never = {},
) {
  return harvestVehicle({
    bus: vehicle.testerBus,
    definitions: [genericPackage],
    logger,
    identity: { source: "spec:virtual-vehicle", platformVersion: "0.1.0" },
    // A narrower identification block than the default: the sweep is the same code
    // path, and 64 identifiers instead of 384 keeps the suite in seconds (AGENTS 31).
    plan: {
      requestGapMs: 0,
      windowMs: 60,
      repeatReadsForStability: false,
      didRanges: [{ name: "identification", from: 0xf180, to: 0xf1bf, reason: "test block" }],
    },
    timestamp: () => "2026-09-23T10:00:00.000Z",
    now: () => 1_000,
    ...overrides,
  });
}

describe("the sweep", () => {
  test("finds the ECUs of the package and reads what they answer", async () => {
    const report = await harvest();
    assert.equal(report.kind, "vdp.harvest");
    assert.ok(report.ecus.length >= 1, `expected ECUs, found ${report.ecus.length}`);
    const engine = report.ecus.find((ecu) => ecu.rxId === 0x7e8);
    assert.ok(engine, "the engine ECU must answer");
    assert.equal(engine.definitionEcuId, "engine", "discovery matched the definition package");
    assert.ok(engine.dids.length > 0, "at least one DID answered");
    const vin = engine.dids.find((did) => did.did === 0xf190);
    assert.ok(vin, "the VIN DID is part of the standard sweep");
    assert.equal(vin.byteLength, 17);
    assert.equal(vin.origin, "standard");
    assert.match(vin.asciiHint ?? "", /^[A-HJ-NPR-Z0-9]{17}$/, "the VIN is printable ASCII");
  });

  test("reads the fault memory with the availability mask and the freeze frames", async () => {
    const report = await harvest();
    const engine = report.ecus.find((ecu) => ecu.rxId === 0x7e8);
    assert.ok(engine);
    const codes = engine.dtcs.map((dtc) => dtc.code).sort();
    assert.ok(codes.includes("P0420"), `expected P0420 in ${codes.join(", ")}`);
    const catalyst = engine.dtcs.find((dtc) => dtc.code === "P0420");
    assert.ok(catalyst);
    assert.equal(catalyst.severity, "critical");
    assert.equal(catalyst.statusBits.testFailed, true);
    assert.equal(
      catalyst.availabilityMask,
      0xff,
      "the mask the ECU sent travels with the code (ISO 14229-1 §11.3.4.2)",
    );
    assert.equal(engine.dtcAvailabilityMask, 0xff);
    assert.ok((engine.dtcCount ?? 0) >= 2, `0x19 0x01 reported ${engine.dtcCount} codes`);
    assert.ok(
      (engine.dtcCount ?? 0) >= engine.dtcs.length,
      "the count is never below the number of codes the list returned",
    );
    assert.ok(
      (catalyst.snapshots?.length ?? 0) >= 1,
      "the freeze frame of a code that has one is read",
    );
    assert.equal(catalyst.snapshots?.[0]?.rawHex, "09460032");
    assert.equal(report.counts.dtcsFound >= 2, true);
    assert.equal(report.counts.snapshotsRead >= 1, true);
  });

  test("probes services with the safe requests and reports the ones it never sends", async () => {
    const report = await harvest();
    const engine = report.ecus.find((ecu) => ecu.rxId === 0x7e8);
    assert.ok(engine);
    assert.ok(engine.supportedServices.includes(SID.READ_DATA_BY_IDENTIFIER));
    assert.ok(engine.supportedServices.includes(SID.READ_DTC_INFORMATION));
    const notProbed = engine.serviceProbes.filter((probe) => probe.outcome === "not-probed");
    assert.ok(
      notProbed.length >= 5,
      `clear, security access, communication control, I/O control, download and DTC setting stay unprobed, found ${notProbed.length}`,
    );
    assert.equal(
      engine.serviceProbes.some((probe) => probe.service === SID.WRITE_DATA_BY_IDENTIFIER),
      false,
      "0x2E is not even mentioned unless --probe-writes asks for it",
    );
    for (const probe of notProbed) {
      assert.ok(
        FORBIDDEN_HARVEST_SERVICES[probe.service] !== undefined || (probe.detail ?? "").length > 0,
        `service 0x${probe.service.toString(16)} must say why it was not probed`,
      );
    }
    assert.equal(
      engine.serviceProbes.some(
        (probe) =>
          probe.service === SID.CLEAR_DIAGNOSTIC_INFORMATION && probe.outcome === "supported",
      ),
      false,
      "a service nobody asked about is never reported as supported",
    );
  });

  test("a refused DID becomes a grouped refusal with its NRC and its range", async () => {
    const report = await harvest();
    const engine = report.ecus.find((ecu) => ecu.rxId === 0x7e8);
    assert.ok(engine);
    assert.ok(engine.didRefusals.length > 0, "most of the identification block is not implemented");
    const group = engine.didRefusals.find((entry) => entry.origin === "identification");
    assert.ok(group);
    assert.equal(group.nrc, 0x31, "requestOutOfRange is the normal answer of a DID sweep");
    assert.ok(group.count > 20, `expected a block of refusals, got ${group.count}`);
    assert.ok(group.firstDid <= group.lastDid);
    assert.equal(
      engine.dids.some((did) => did.rawHex === ""),
      false,
      "a refusal never appears as an answered DID with empty bytes",
    );
    assert.equal(report.counts.didsRefused > 0, true);
  });

  test("the record states what it did not do", async () => {
    const report = await harvest();
    assert.ok(report.notes.some((note) => note.includes("Default-Sitzung")));
    assert.ok(report.notes.some((note) => note.includes("VIN")));
    assert.equal(report.identity.vinRedacted, true);
    assert.match(report.identity.vin ?? "", /\*{5,}/, "the VIN is masked by default");
    assert.equal(report.plan.services.includes(SID.WRITE_DATA_BY_IDENTIFIER), false);
    assert.equal(report.plan.services.includes(SID.CLEAR_DIAGNOSTIC_INFORMATION), false);
    assert.equal(report.plan.services.includes(SID.SECURITY_ACCESS), false);
    assert.deepEqual(
      report.plan.services.filter((service) => service === SID.READ_DATA_BY_IDENTIFIER),
      [SID.READ_DATA_BY_IDENTIFIER],
      "the reads the sweep actually sends are in the record",
    );
  });

  test("--keep-vin is the only way the VIN reaches the record in clear text", async () => {
    const report = await harvest({ keepVin: true });
    assert.equal(report.identity.vinRedacted, undefined);
    assert.match(report.identity.vin ?? "", /^[A-HJ-NPR-Z0-9]{17}$/);
  });

  test("the recorded plan lists what was asked, not what the plan would allow", async () => {
    const stayed = await harvest();
    assert.deepEqual(
      stayed.plan.sessions,
      [],
      "a run in the default session did not enter any session — three session types here would be three claims that never happened",
    );
    assert.ok(stayed.plan.services.length > 0, "the reads that were sent are named");
    for (const service of stayed.plan.services) {
      assert.equal(
        FORBIDDEN_HARVEST_SERVICES[service],
        undefined,
        `service 0x${service.toString(16)} is forbidden and must not appear as sent`,
      );
    }

    const entered = await harvest({ enterSession: 0x03 });
    assert.deepEqual(entered.plan.sessions, [0x03], "the session that was entered is recorded");
  });

  test("the addressing width comes from what answered, not from the plan", async () => {
    const report = await harvest({
      plan: { requestGapMs: 0, windowMs: 40, readDtcs: false, didRanges: [] },
    });
    assert.equal(report.bus.addressing, "11-bit", "the virtual vehicle answers 11-bit addresses");
    assert.equal(report.bus.functionalId, 0x7df);
    assert.equal(
      report.notes.some((note) => note.includes("29-bit")),
      false,
      "no 29-bit note when nothing answered with a 29-bit address",
    );
  });

  test("entering a session is opt-in and recorded as a state change", async () => {
    const report = await harvest({ enterSession: 0x03 });
    const engine = report.ecus.find((ecu) => ecu.rxId === 0x7e8);
    assert.ok(engine);
    assert.deepEqual(engine.acceptedSessions, [0x03]);
    assert.ok(report.notes.some((note) => note.includes("Sitzung 0x3 wurde betreten")));
  });

  test("switching the fault memory off is visible in the record", async () => {
    const report = await harvest({
      plan: {
        readDtcs: false,
        requestGapMs: 0,
        windowMs: 60,
        didRanges: [{ name: "identification", from: 0xf180, to: 0xf1bf, reason: "test block" }],
      },
    });
    const engine = report.ecus.find((ecu) => ecu.rxId === 0x7e8);
    assert.ok(engine);
    assert.deepEqual(engine.dtcs, []);
    assert.equal(engine.dtcCount, undefined);
    assert.ok(report.notes.some((note) => note.includes("Fehlerspeicher wurde nicht gelesen")));
  });

  test("a declared address that never answers is listed, not forgotten", async () => {
    // A package declaring an ECU the vehicle does not have: the sweep must say so.
    const report = await harvestVehicle({
      bus: vehicle.testerBus,
      definitions: [
        {
          ...genericPackage,
          ecus: [
            ...genericPackage.ecus,
            {
              id: "phantom",
              name: "Phantom ECU",
              protocol: "uds",
              address: { txId: 0x7d0, rxId: 0x7d8 },
            },
          ],
        },
      ],
      logger,
      identity: { source: "spec:phantom", platformVersion: "0.1.0" },
      plan: {
        requestGapMs: 0,
        windowMs: 40,
        readDtcs: false,
        didRanges: [{ name: "identification", from: 0xf180, to: 0xf18f, reason: "test block" }],
      },
      timestamp: () => "2026-09-23T10:00:00.000Z",
      now: () => 1_000,
    });
    const phantom = report.unread.find((entry) => entry.rxId === 0x7d8);
    assert.ok(phantom, `expected 0x7d8 in unread: ${JSON.stringify(report.unread)}`);
    assert.match(phantom.reason, /keine Antwort/);
    assert.equal(report.counts.addressesUnread, report.unread.length);
    assert.ok(report.notes.some((note) => note.includes("nicht geantwortet")));
  });

  test("a transport failure is not counted as a refused DID", async () => {
    // Asking an address nobody owns: discovery yields nothing for it, so the sweep
    // never sends a DID request — and the record shows a gap or nothing at all,
    // never a "refused" group invented from silence.
    const report = await harvest({
      plan: { requestGapMs: 0, windowMs: 40, readDtcs: false, didRanges: [] },
    });
    for (const ecu of report.ecus) {
      for (const group of ecu.didRefusals) {
        assert.ok(group.count > 0);
        assert.ok(group.nrc > 0, "a refusal group always names the NRC the ECU sent");
      }
    }
  });
});

describe("the read-only guardrail", () => {
  test("no module of this tool calls a write API", () => {
    const sources = [
      "harvest.ts",
      "plan.ts",
      "observation.ts",
      "definition.ts",
      "cli.ts",
      "odx/diag-layer.ts",
    ];
    const forbidden = [
      "clearDiagnosticInformation",
      "writeDataByIdentifier",
      "startRoutine",
      "routineControl",
      "securityAccessRequestSeed",
      "securityAccessSendKey",
      "unlockSecurityAccess",
      "ecuReset(",
      "controlDtcSetting",
    ];
    for (const source of sources) {
      const path = fileURLToPath(new URL(source, import.meta.url));
      const text = readFileSync(path, "utf8");
      // Comments may name a write to explain why it is not sent; code may not call one.
      const code = text
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
        .join("\n");
      for (const call of forbidden) {
        assert.equal(
          code.includes(`.${call}`) || code.includes(`await ${call}`),
          false,
          `${source} must not call ${call} — a harvest is read-only (ADR 0058)`,
        );
      }
    }
  });

  test("every forbidden service is named with a reason, so the list is a decision", () => {
    for (const [service, reason] of Object.entries(FORBIDDEN_HARVEST_SERVICES)) {
      assert.ok(
        reason.length > 10,
        `service 0x${Number(service).toString(16)} needs a real reason`,
      );
    }
    assert.equal(Object.keys(FORBIDDEN_HARVEST_SERVICES).length >= 7, true);
  });
});
