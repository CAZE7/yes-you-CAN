/**
 * From observation to definition candidate (ADR 0058).
 *
 * The candidate has to pass the *same* validation a hand-written package passes —
 * that is the point of routing it through `@vdp/definitions` instead of writing a
 * second validator — and it has to be visibly harvested: `sourceType: "observed"`
 * on the package, on every ECU, on every DTC and on every signal, each with its own
 * source line. A candidate that looked like documented data would be the failure
 * mode this module exists to prevent.
 */

import assert from "node:assert/strict";
import { validateDefinitionPackage } from "@vdp/definitions";
import { test } from "vitest";
import { definitionCandidate, ecuId, encodingOf, harvestProvenance } from "./definition.js";
import type { HarvestedEcu, HarvestReport } from "./observation.js";

function ecu(partial: Partial<HarvestedEcu> = {}): HarvestedEcu {
  return {
    id: "ecu-7e8",
    name: "ECU 0x7e8",
    txId: 0x7e0,
    rxId: 0x7e8,
    extended: false,
    acceptedSessions: [],
    serviceProbes: [{ service: 0x22, outcome: "supported" }],
    supportedServices: [0x10, 0x19, 0x22, 0x3e],
    identification: [{ did: 0xf190, label: "VIN", rawHex: "575657", asciiHint: "WVW" }],
    dids: [],
    didRefusals: [],
    dtcs: [],
    gaps: [],
    ...partial,
  };
}

function fixture(ecus: HarvestedEcu[]): HarvestReport {
  return {
    kind: "vdp.harvest",
    version: 1,
    identity: {
      source: "adapter:socketcan:can0",
      platformVersion: "0.1.0",
      vin: "WVW**********3456",
      vinRedacted: true,
    },
    bus: { addressing: "11-bit", functionalId: 0x7df },
    startedAt: "2026-09-23T10:00:00.000Z",
    finishedAt: "2026-09-23T10:00:04.000Z",
    durationMs: 4_000,
    plan: {
      services: [0x22],
      sessions: [0x01],
      didRanges: [],
      standardDids: [0xf190],
      dtcRecordNumbers: [0xff],
      budgetPerEcuMs: 20_000,
      requestGapMs: 5,
    },
    ecus,
    unread: [],
    counts: {
      ecusAnswered: ecus.length,
      addressesUnread: 0,
      didsRead: 0,
      didsRefused: 0,
      dtcsFound: 0,
      snapshotsRead: 0,
      requestsSent: 0,
    },
    notes: ["Die Ernte blieb in der Default-Sitzung"],
  };
}

const statusBits = {
  testFailed: true,
  testFailedThisOperationCycle: true,
  pendingDtc: true,
  confirmedDtc: true,
  testNotCompletedSinceLastClear: false,
  testFailedSinceLastClear: true,
  testNotCompletedThisOperationCycle: false,
  warningIndicatorRequested: false,
};

test("a harvested candidate passes the same validation as a hand-written package", () => {
  const report = fixture([
    ecu({
      dids: [
        {
          did: 0xf190,
          rawHex: "5756575A5A5A33435A5745313233343536",
          byteLength: 17,
          asciiHint: "WVWZZZ3CZWE123456",
          origin: "standard",
        },
        { did: 0xf40c, rawHex: "10B2", byteLength: 2, origin: "range" },
        { did: 0xf18c, rawHex: "00112233", byteLength: 4, origin: "standard" },
      ],
      dtcs: [
        {
          code: "P0420",
          raw: "042000",
          failureType: "00",
          status: 0x2f,
          statusBits,
          severity: "critical",
          availabilityMask: 0x2f,
          snapshotRecordCount: 1,
        },
      ],
    }),
  ]);
  const candidate = definitionCandidate(report, { oem: "harvest" });
  const result = validateDefinitionPackage(candidate.pkg);
  assert.deepEqual(result.errors, [], result.errors.join("\n"));
  assert.equal(result.valid, true);
  assert.equal(candidate.pkg.ecus.length, 1);
  assert.equal(candidate.pkg.signals.length, 3);
  assert.equal(candidate.pkg.ecus[0]?.dtcs?.length, 1);
});

test("every level carries observed provenance with its own source line", () => {
  const report = fixture([
    ecu({
      dids: [{ did: 0xf40c, rawHex: "10B2", byteLength: 2, origin: "range" }],
      dtcs: [
        {
          code: "P0420",
          raw: "042000",
          failureType: "00",
          status: 0x2f,
          statusBits,
          severity: "critical",
        },
      ],
    }),
  ]);
  const { pkg } = definitionCandidate(report, { oem: "harvest" });
  assert.equal(pkg.provenance.sourceType, "observed");
  assert.equal(pkg.provenance.retrievedAt, "2026-09-23", "the date comes from the harvest clock");
  const ecuEntry = pkg.ecus[0];
  assert.ok(ecuEntry);
  assert.equal(ecuEntry.provenance?.sourceType, "observed");
  assert.match(ecuEntry.provenance?.source ?? "", /ECU 0x7e8/);
  const signal = pkg.signals[0];
  assert.ok(signal);
  assert.equal(signal.provenance?.sourceType, "observed");
  assert.match(signal.provenance?.source ?? "", /DID 0xf40c/);
  assert.match(signal.provenance?.notes ?? "", /roh 10B2/, "the bytes themselves are the evidence");
  const dtc = ecuEntry.dtcs?.[0];
  assert.ok(dtc);
  assert.equal(dtc.provenance?.sourceType, "observed");
  assert.match(dtc.provenance?.notes ?? "", /Verfügbarkeitsmaske/);
});

test("the package provenance states what the harvest could not do", () => {
  const report = fixture([ecu()]);
  report.counts.addressesUnread = 3;
  report.notes.push("3 Adresse(n) haben nicht geantwortet");
  const provenance = harvestProvenance(report, { oem: "harvest", operator: "werkstatt-1" });
  assert.match(provenance.notes ?? "", /addresses without an answer: 3/);
  assert.match(provenance.notes ?? "", /VIN masked/);
  assert.match(provenance.notes ?? "", /operator: werkstatt-1/);
  assert.match(provenance.version ?? "", /harvest v1, platform 0\.1\.0/);
});

test("only a length with a documented encoding becomes a signal", () => {
  assert.equal(encodingOf({ byteLength: 1 }), "uint8");
  assert.equal(encodingOf({ byteLength: 2 }), "uint16");
  assert.equal(encodingOf({ byteLength: 3 }), "uint24");
  assert.equal(encodingOf({ byteLength: 4 }), "uint32");
  assert.equal(encodingOf({ byteLength: 17, asciiHint: "WVWZZZ3CZWE123456" }), "ascii");
  assert.equal(
    encodingOf({ byteLength: 5 }),
    null,
    "five bytes are not a uint32 plus a stray byte",
  );
  assert.equal(encodingOf({ byteLength: 11 }), null);

  const report = fixture([
    ecu({
      dids: [
        { did: 0xf1a3, rawHex: "0102030405", byteLength: 5, origin: "range" },
        { did: 0xf40c, rawHex: "10B2", byteLength: 2, origin: "range" },
      ],
    }),
  ]);
  const candidate = definitionCandidate(report, { oem: "harvest" });
  assert.equal(candidate.pkg.signals.length, 1, "only the two-byte DID became a signal");
  assert.equal(candidate.skipped.length, 1);
  assert.equal(candidate.skipped[0]?.item, "did:0xf1a3");
  assert.match(candidate.skipped[0]?.reason ?? "", /keine Kodierung passt/);
  assert.match(
    candidate.skipped[0]?.reason ?? "",
    /bleibt im Ernte-Datensatz/,
    "the observation is not lost, it just is not a decoding",
  );
});

test("a code outside the J2012 character form is skipped, not bent into shape", () => {
  const report = fixture([
    ecu({
      dtcs: [
        {
          code: "PA123",
          raw: "0A1230",
          failureType: "30",
          status: 0x24,
          statusBits,
          severity: "minor",
        },
        {
          code: "P0420",
          raw: "042000",
          failureType: "00",
          status: 0x2f,
          statusBits,
          severity: "critical",
        },
      ],
    }),
  ]);
  const candidate = definitionCandidate(report, { oem: "harvest" });
  assert.equal(candidate.pkg.ecus[0]?.dtcs?.length, 1);
  assert.equal(candidate.pkg.ecus[0]?.dtcs?.[0]?.code, "P0420");
  assert.equal(candidate.skipped.length, 1);
  assert.match(candidate.skipped[0]?.item ?? "", /^dtc:PA123-30$/);
  assert.match(candidate.skipped[0]?.reason ?? "", /SAE-J2012/);
});

test("a DTC description says the code was reported, never what it means", () => {
  const report = fixture([
    ecu({
      dtcs: [
        {
          code: "P0420",
          raw: "042000",
          failureType: "00",
          status: 0x2f,
          statusBits,
          severity: "critical",
          availabilityMask: 0x2f,
          snapshots: [{ recordNumber: 1, rawHex: "0946003201F4" }],
        },
      ],
    }),
  ]);
  const candidate = definitionCandidate(report, { oem: "harvest" });
  const dtc = candidate.pkg.ecus[0]?.dtcs?.[0];
  assert.ok(dtc);
  assert.match(dtc.description, /gemeldet/);
  assert.match(dtc.description, /Bedeutung nicht dokumentiert/);
  assert.match(dtc.description, /Freeze Frames: #1 0946003201F4/);
  assert.equal(dtc.severity, "critical", "the graded severity travels with the code");
  // The freeze-frame layout stays unknown, so the record is raw bytes with a length.
  assert.equal(dtc.freezeFrame?.length, 1);
  assert.equal(dtc.freezeFrame?.[0]?.length, 6);
  assert.match(dtc.freezeFrame?.[0]?.name ?? "", /roh, Layout undokumentiert/);
});

test("supported services come from the probes that were answered, not from the plan", () => {
  const report = fixture([
    ecu({
      supportedServices: [0x22, 0x19],
      serviceProbes: [
        { service: 0x22, outcome: "supported" },
        { service: 0x19, outcome: "supported" },
        { service: 0x14, outcome: "not-probed", detail: "clears fault memory" },
        { service: 0x2e, outcome: "unsupported" },
      ],
    }),
  ]);
  const candidate = definitionCandidate(report, { oem: "harvest" });
  assert.deepEqual(candidate.pkg.ecus[0]?.services, [0x19, 0x22], "sorted, and only what answered");
});

test("an ECU a definition package declared keeps that id, so a candidate merges", () => {
  const declared = ecu({ definitionEcuId: "engine" });
  assert.equal(ecuId(declared), "engine");
  assert.equal(ecuId(ecu()), "ecu-7e8");
  const candidate = definitionCandidate(fixture([declared]), { oem: "harvest" });
  assert.equal(candidate.pkg.ecus[0]?.id, "engine");
});

test("gaps of an ECU are written into its provenance, not dropped", () => {
  const withGaps = ecu({ gaps: [{ stage: "dtc-list", reason: "no response within 75 ms" }] });
  const candidate = definitionCandidate(fixture([withGaps]), { oem: "harvest" });
  assert.match(
    candidate.pkg.ecus[0]?.provenance?.notes ?? "",
    /nicht lesbar: dtc-list: no response within 75 ms/,
  );
});

test("the version is SemVer with the harvest date as build metadata", () => {
  const candidate = definitionCandidate(fixture([ecu()]), { oem: "harvest" });
  assert.equal(candidate.pkg.version, "0.1.0+20260923");
  assert.equal(validateDefinitionPackage(candidate.pkg).valid, true);
  const explicit = definitionCandidate(fixture([ecu()]), {
    oem: "vag",
    version: "0.2.0",
    name: "Golf VII Harvest",
  });
  assert.equal(explicit.pkg.version, "0.2.0");
  assert.equal(explicit.pkg.name, "Golf VII Harvest");
  assert.equal(explicit.pkg.oem, "vag");
});

test("a harvest with no ECU yields an empty but valid candidate", () => {
  const candidate = definitionCandidate(fixture([]), { oem: "harvest" });
  assert.deepEqual(candidate.pkg.ecus, []);
  assert.deepEqual(candidate.pkg.signals, []);
  assert.equal(validateDefinitionPackage(candidate.pkg).valid, true);
});
