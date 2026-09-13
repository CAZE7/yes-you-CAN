import assert from "node:assert/strict";
import {
  type ClearDtcResult,
  type DecodedSignal,
  type DtcVariantKnowledge,
  type EcuSession,
  type EnrichedDtc,
  type MeasurementSample,
  type VehicleIdentity,
  VehicleSession,
  createSession,
} from "@vdp/core";
import type { AdapterInfo, TransportInfo } from "@vdp/transport-can";
import { describe, test } from "vitest";
import { type FixturePatch, patched, without } from "../../../tests/helpers/fixture.js";
import {
  capabilitiesFromServices,
  decodedToReading,
  deniedClearOutcome,
  toClearDtcOutcome,
  toDtcInfo,
  toDtcKnowledge,
  toEcuSummary,
  toMeasurementReading,
  toSessionSummary,
  toVehicleSummary,
} from "./index.js";

function makeEcuSession(overrides: FixturePatch<EcuSession> = {}): EcuSession {
  return patched(
    {
      id: "ecu_1",
      definitionEcuId: "engine",
      name: "Engine Control Unit",
      protocol: "uds",
      txId: 0x7e0,
      rxId: 0x7e8,
      extended: false,
      identification: [{ label: "VIN", value: "WVWZZZ1KZAW000001" }],
      supportedServices: [0x10, 0x19, 0x22, 0x3e],
      sessionType: 0x01,
      timing: { p2Ms: 50, p2StarMs: 5000 },
      reachable: true,
    },
    overrides,
  );
}

describe("toEcuSummary", () => {
  test("derives capabilities from probed services", () => {
    const summary = toEcuSummary(makeEcuSession());
    assert.equal(summary.ecuId, "ecu_1");
    assert.equal(summary.definitionEcuId, "engine");
    assert.equal(summary.txId, 0x7e0);
    assert.equal(summary.rxId, 0x7e8);
    assert.deepEqual(summary.identification, [{ label: "VIN", value: "WVWZZZ1KZAW000001" }]);
    assert.equal(summary.p2Ms, 50);
    assert.equal(summary.dtcCount, 0);
    assert.deepEqual(summary.supportedServices, [0x10, 0x19, 0x22, 0x3e]);
    assert.ok(summary.capabilities.includes("read-dtc"));
    assert.ok(summary.capabilities.includes("read-did"));
    assert.ok(!summary.capabilities.includes("clear-dtc"), "0x14 was not probed positive");
  });

  test("optional fields are omitted when absent", () => {
    const summary = toEcuSummary(
      makeEcuSession({ definitionEcuId: undefined, lastError: undefined }),
    );
    assert.equal("definitionEcuId" in summary, false);
    assert.equal("lastError" in summary, false);
  });

  test("errors and unreachable state travel with the summary", () => {
    const summary = toEcuSummary(makeEcuSession({ reachable: false, lastError: "timeout" }));
    assert.equal(summary.reachable, false);
    assert.equal(summary.lastError, "timeout");
  });
});

describe("toMeasurementReading", () => {
  const sample: MeasurementSample = {
    timestamp: "2026-09-11T10:00:00.000Z",
    t: 1200,
    signal: "engine.rpm",
    value: 850,
    rawValue: 3400,
    rawHex: "0D 48",
    unit: "rpm",
    outOfRange: false,
  };

  test("maps recorder samples into the domain contract", () => {
    const reading = toMeasurementReading(sample, "Engine speed");
    assert.equal(reading.signalId, "engine.rpm");
    assert.equal(reading.name, "Engine speed");
    assert.equal(reading.value, 850);
    assert.equal(reading.rawValue, 3400);
    assert.equal(reading.rawHex, "0D 48");
    assert.equal(reading.unit, "rpm");
    assert.equal(reading.t, 1200);
    assert.equal(reading.outOfRange, false);
  });

  test("omits optional text fields when missing", () => {
    const reading = toMeasurementReading(without(sample, "unit"));
    assert.equal("unit" in reading, false);
    assert.equal("enumText" in reading, false);
    assert.equal("name" in reading, false);
  });

  test("enum text travels with the sample", () => {
    const reading = toMeasurementReading({ ...sample, enumText: "closed loop" });
    assert.equal(reading.enumText, "closed loop");
  });
});

describe("capabilitiesFromServices edge cases", () => {
  test("a session-control-only ECU gets no write capabilities", () => {
    assert.deepEqual(capabilitiesFromServices([0x10, 0x3e]), ["session-control", "tester-present"]);
  });
});

describe("toVehicleSummary", () => {
  test("maps a fully known identity", () => {
    const identity: VehicleIdentity = {
      vin: "WVWZZZ1KZAW000001",
      manufacturer: "Volkswagen",
      brand: "VW",
      model: "Golf",
      modelYear: 2010,
      platform: "PQ35",
    };
    const summary = toVehicleSummary(identity);
    assert.ok(summary);
    assert.equal(summary.vin, "WVWZZZ1KZAW000001");
    assert.equal(summary.manufacturer, "Volkswagen");
    assert.equal(summary.model, "Golf");
    assert.equal(summary.modelYear, 2010);
    assert.ok(summary.description.includes("Golf"));
  });

  test("omits unknown fields and handles undefined input", () => {
    const sparse = toVehicleSummary({});
    assert.ok(sparse);
    assert.equal("vin" in sparse, false);
    assert.equal("modelYear" in sparse, false);
    assert.equal(toVehicleSummary(undefined), undefined);
  });
});

describe("toSessionSummary", () => {
  const adapter: AdapterInfo = { id: "sim", kind: "virtual", name: "Sim", channels: ["vcan0"] };
  const transport: TransportInfo = { kind: "virtual", channel: "vcan0", mtu: 8 };

  test("summarises a fresh session without optional fields", () => {
    const session = new VehicleSession(createSession({ adapter, transport }));
    const summary = toSessionSummary(session);
    assert.equal(summary.sessionId, session.id);
    assert.equal(summary.schemaVersion, 1);
    assert.equal(summary.ecuCount, 0);
    assert.equal("endedAt" in summary, false);
    assert.equal("title" in summary, false);
    assert.equal("vehicle" in summary, false);
    assert.equal("definitionPackage" in summary, false);
  });

  test("carries title, vehicle, definition package and close state", () => {
    const session = new VehicleSession(
      createSession({
        adapter,
        transport,
        title: "Workshop visit",
        definitionPackage: { oem: "generic", version: "1.2.3" },
      }),
    );
    session.data.vehicle = { vin: "WVWZZZ1KZAW000001", brand: "VW", model: "Golf" };
    session.close();
    const summary = toSessionSummary(session);
    assert.equal(summary.title, "Workshop visit");
    assert.equal(summary.vehicle?.vin, "WVWZZZ1KZAW000001");
    assert.equal(summary.definitionPackage?.oem, "generic");
    assert.equal(summary.definitionPackage?.version, "1.2.3");
    assert.ok(summary.endedAt);
  });
});

describe("toDtcInfo", () => {
  function makeDtc(overrides: FixturePatch<EnrichedDtc> = {}): EnrichedDtc {
    return patched(
      {
        code: "P0420",
        raw: "042000",
        failureType: "00",
        status: 0x24,
        statusBits: {
          testFailed: true,
          testFailedThisOperationCycle: true,
          pendingDtc: false,
          confirmedDtc: true,
          testNotCompletedSinceLastClear: false,
          testFailedSinceLastClear: true,
          testNotCompletedThisOperationCycle: false,
          warningIndicatorRequested: false,
        },
        severity: "major",
        ecuId: "ecu_1",
        ecuName: "Engine Control Unit",
      },
      overrides,
    );
  }

  test("maps a fully enriched code", () => {
    const info = toDtcInfo(
      makeDtc({
        description: "Catalyst efficiency below threshold",
        hint: "Check lambda probes",
        firstSeen: "2026-09-11T09:00:00.000Z",
        lastSeen: "2026-09-11T10:00:00.000Z",
        relatedSignals: [{ id: "engine.lambda", name: "Lambda" }],
      }),
    );
    assert.equal(info.code, "P0420");
    assert.equal(info.status, 0x24);
    assert.equal(info.severity, "major");
    assert.equal(info.description, "Catalyst efficiency below threshold");
    assert.equal(info.hint, "Check lambda probes");
    assert.deepEqual(info.relatedSignals, [{ id: "engine.lambda", name: "Lambda" }]);
  });

  test("keeps the protocol truth next to the enrichment", () => {
    const info = toDtcInfo(makeDtc({ snapshot: new Uint8Array([1, 2, 3]) }));
    assert.equal(info.raw, "042000");
    assert.equal(info.failureType, "00");
    assert.equal(info.confirmed, true);
    assert.equal(info.pending, false);
    assert.equal(info.testFailed, true);
    assert.equal(info.hasFreezeFrame, true);
    assert.equal(toDtcInfo(makeDtc()).hasFreezeFrame, false);
  });

  test("omits enrichment the scanner could not provide", () => {
    const info = toDtcInfo(makeDtc({ severity: undefined }));
    assert.equal("description" in info, false);
    assert.equal("hint" in info, false);
    assert.equal("firstSeen" in info, false);
    assert.equal("relatedSignals" in info, false);
    assert.equal("knowledge" in info, false, "no vehicle, no variant knowledge");
  });

  test("carries the variant knowledge of the scan it came from", () => {
    const info = toDtcInfo(
      makeDtc({
        knowledge: {
          scope: "vehicle-engine",
          vehicleId: "virtual-vehicle",
          patterns: [
            {
              id: "catalyst-aged",
              name: "Aged catalyst",
              scope: "vehicle-engine",
              checks: [
                {
                  signal: "engine.long_term_fuel_trim",
                  signalName: "Long term fuel trim",
                  expect: "neutral",
                  min: -5,
                  max: 5,
                  measurable: true,
                },
              ],
            },
          ],
          notes: [],
        },
      }),
    );
    assert.equal(info.knowledge?.scope, "vehicle-engine");
    assert.equal(info.knowledge?.vehicleId, "virtual-vehicle");
    assert.deepEqual(info.knowledge?.patterns[0]?.checks[0], {
      signalId: "engine.long_term_fuel_trim",
      name: "Long term fuel trim",
      expect: "neutral",
      min: -5,
      max: 5,
      measurable: true,
    });
  });
});

describe("decodedToReading / clear outcomes", () => {
  test("decodedToReading keeps raw and decoded together", () => {
    const decoded: DecodedSignal = {
      signalId: "engine.rpm",
      name: "Engine speed",
      ecu: "engine",
      raw: new Uint8Array([0x0d, 0x48]),
      rawHex: "0D 48",
      rawValue: 3400,
      value: 850,
      unit: "rpm",
      outOfRange: false,
      did: 0xf40c,
    };
    const reading = decodedToReading(decoded, "2026-09-11T10:00:00.000Z");
    assert.equal(reading.signalId, "engine.rpm");
    assert.equal(reading.timestamp, "2026-09-11T10:00:00.000Z");
    assert.equal(reading.unit, "rpm");
    const withoutUnit = decodedToReading({ ...without(decoded, "unit"), enumText: "idle" }, "x");
    assert.equal("unit" in withoutUnit, false);
    assert.equal(withoutUnit.enumText, "idle");
  });

  test("toClearDtcOutcome reports survivors and warnings", () => {
    const result = {
      cleared: true,
      ecuId: "ecu_1",
      ecuName: "Engine Control Unit",
      before: [{ code: "P0420" }, { code: "P0171" }],
      after: [{ code: "P0420" }],
      comparison: { added: [], removed: [], changed: [], unchanged: [] },
      verified: true,
      permit: { id: "permit_1" },
      clearedAt: "2026-09-11T10:00:00.000Z",
    } as unknown as ClearDtcResult;
    const outcome = toClearDtcOutcome(result, ["battery voltage unknown"]);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.verified, true);
    assert.equal(outcome.beforeCount, 2);
    assert.equal(outcome.afterCount, 1);
    assert.deepEqual(outcome.remainingCodes, ["P0420"]);
    assert.deepEqual(outcome.reasons, ["battery voltage unknown"]);
    assert.equal(outcome.permitId, "permit_1");
  });

  test("deniedClearOutcome carries the refusal reasons", () => {
    const outcome = deniedClearOutcome("ecu_1", "Engine", ["no confirmation"]);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.verified, false);
    assert.deepEqual(outcome.reasons, ["no confirmation"]);
    assert.deepEqual(outcome.remainingCodes, []);
  });
});

describe("toDtcKnowledge", () => {
  /** Variant knowledge as the DTC system records it (AGENTS 20, 23). */
  function knowledge(overrides: FixturePatch<DtcVariantKnowledge> = {}): DtcVariantKnowledge {
    return patched(
      {
        scope: "vehicle-engine",
        vehicleId: "virtual-vehicle",
        conditions: "only in closed loop above 80 °C",
        patterns: [
          {
            id: "catalyst-aged",
            name: "Aged catalyst",
            explanation: "Oxygen storage is gone",
            likelihood: "common",
            repair: "Replace it after the checks hold",
            scope: "vehicle-engine",
            checks: [
              {
                signal: "engine.long_term_fuel_trim",
                signalName: "Long term fuel trim",
                expect: "neutral",
                min: -5,
                max: 5,
                measurable: true,
              },
              {
                signal: "engine.coolant_temperature",
                signalName: "Coolant temperature",
                expect: "listen at operating temperature",
                measurable: false,
              },
            ],
          },
        ],
        provenanceType: "licensed",
        provenanceSource: "workshop manual",
        notes: ["the evidence did not narrow the powertrain"],
      },
      overrides,
    );
  }

  test("maps to the domain's field names and keeps every statement", () => {
    const info = toDtcKnowledge(knowledge());
    assert.equal(info.scope, "vehicle-engine");
    assert.equal(info.vehicleId, "virtual-vehicle");
    assert.equal(info.conditions, "only in closed loop above 80 °C");
    assert.equal(info.provenanceType, "licensed");
    assert.equal(info.provenanceSource, "workshop manual");
    assert.deepEqual(info.notes, ["the evidence did not narrow the powertrain"]);

    const pattern = info.patterns[0];
    assert.ok(pattern);
    assert.equal(pattern.id, "catalyst-aged");
    assert.equal(pattern.likelihood, "common");
    assert.equal(pattern.repair, "Replace it after the checks hold");
    assert.equal(pattern.scope, "vehicle-engine");
    assert.deepEqual(pattern.checks[0], {
      signalId: "engine.long_term_fuel_trim",
      name: "Long term fuel trim",
      expect: "neutral",
      min: -5,
      max: 5,
      measurable: true,
    });
    assert.deepEqual(pattern.checks[1], {
      signalId: "engine.coolant_temperature",
      name: "Coolant temperature",
      expect: "listen at operating temperature",
      measurable: false,
    });
  });

  test("what is not documented stays absent instead of becoming empty", () => {
    const info = toDtcKnowledge(
      knowledge({
        vehicleId: undefined,
        conditions: undefined,
        provenanceType: undefined,
        provenanceSource: undefined,
        patterns: [{ id: "prose", name: "Only prose", scope: "vehicle", checks: [] }],
        notes: [],
      }),
    );
    assert.equal("vehicleId" in info, false);
    assert.equal("conditions" in info, false);
    assert.equal("provenanceType" in info, false);
    assert.equal("provenanceSource" in info, false);
    assert.deepEqual(info.patterns[0], {
      id: "prose",
      name: "Only prose",
      scope: "vehicle",
      checks: [],
    });
    assert.deepEqual(info.notes, []);
  });
});
