/**
 * The ODX projection of a harvest (ADR 0058, ISO 22901-1 / ASAM ODX 2.2).
 *
 * What is pinned here is the *shape* of the document: that it is well-formed XML,
 * that every observed conversation becomes a service whose request and response
 * are byte-exact recipes, that the DTC entries carry the codes the ECU reported
 * with their status and the availability mask, and that the provenance is stated
 * in the file itself. The claim that a reader which did not write this file accepts
 * it is checked separately, against `odxtools` (`verify.spec.ts`).
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import type { HarvestReport } from "../observation.js";
import {
  containerShortNameOf,
  dtcNumber,
  expectationsOf,
  observedServicesOf,
  renderOdxHarvest,
  toHexText,
} from "./diag-layer.js";

/** One ECU that answered two DIDs and reported two codes, one with a freeze frame. */
function fixture(): HarvestReport {
  return {
    kind: "vdp.harvest",
    version: 1,
    identity: {
      source: "adapter:socketcan:can0",
      platformVersion: "0.1.0",
      vin: "WVW***********3456",
      vinRedacted: true,
    },
    bus: { addressing: "11-bit", functionalId: 0x7df, channel: "can0", canFd: false },
    startedAt: "2026-09-23T10:00:00.000Z",
    finishedAt: "2026-09-23T10:00:04.000Z",
    durationMs: 4_000,
    plan: {
      services: [0x19, 0x22],
      sessions: [0x01],
      didRanges: [{ from: 0xf180, to: 0xf1ff }],
      standardDids: [0xf190],
      dtcRecordNumbers: [0xff, 0x01],
      budgetPerEcuMs: 20_000,
      requestGapMs: 5,
    },
    ecus: [
      {
        id: "ecu-7e8",
        name: "Engine Control Unit",
        txId: 0x7e0,
        rxId: 0x7e8,
        extended: false,
        definitionEcuId: "engine",
        acceptedSessions: [],
        timing: { p2Ms: 50, p2StarMs: 5_000 },
        serviceProbes: [{ service: 0x22, outcome: "supported", detail: "answered positively" }],
        supportedServices: [0x10, 0x19, 0x22, 0x3e],
        identification: [
          {
            did: 0xf190,
            label: "VIN",
            rawHex: "5756575A5A5A33435A5745313233343536",
            asciiHint: "WVWZZZ3CZWE123456",
          },
        ],
        dids: [
          {
            did: 0xf190,
            rawHex: "5756575A5A5A33435A5745313233343536",
            byteLength: 17,
            asciiHint: "WVWZZZ3CZWE123456",
            stable: true,
            origin: "standard",
          },
          { did: 0xf40c, rawHex: "10B2", byteLength: 2, stable: false, origin: "range" },
        ],
        didRefusals: [
          { origin: "identification", nrc: 0x31, count: 116, firstDid: 0xf180, lastDid: 0xf1ff },
        ],
        dtcAvailabilityMask: 0x2f,
        dtcCount: 2,
        dtcs: [
          {
            code: "P0420",
            raw: "042000",
            failureType: "00",
            status: 0x2f,
            statusBits: {
              testFailed: true,
              testFailedThisOperationCycle: true,
              pendingDtc: true,
              confirmedDtc: true,
              testNotCompletedSinceLastClear: false,
              testFailedSinceLastClear: true,
              testNotCompletedThisOperationCycle: false,
              warningIndicatorRequested: false,
            },
            severity: "critical",
            availabilityMask: 0x2f,
            snapshotRecordCount: 1,
            snapshots: [{ recordNumber: 1, rawHex: "0946003201F4" }],
          },
          {
            code: "P0300",
            raw: "030000",
            failureType: "00",
            status: 0x24,
            statusBits: {
              testFailed: false,
              testFailedThisOperationCycle: false,
              pendingDtc: true,
              confirmedDtc: false,
              testNotCompletedSinceLastClear: false,
              testFailedSinceLastClear: true,
              testNotCompletedThisOperationCycle: false,
              warningIndicatorRequested: false,
            },
            severity: "minor",
            availabilityMask: 0x2f,
            snapshotRecordCount: 0,
          },
        ],
        gaps: [{ stage: "dtc-snapshot-identification", reason: "subFunctionNotSupported (0x12)" }],
      },
    ],
    unread: [{ rxId: 0x7e9, txId: 0x7e1, extended: false, reason: "keine Antwort" }],
    counts: {
      ecusAnswered: 1,
      addressesUnread: 1,
      didsRead: 2,
      didsRefused: 116,
      dtcsFound: 2,
      snapshotsRead: 1,
      requestsSent: 130,
    },
    notes: ["Die Ernte blieb in der Default-Sitzung"],
  };
}

test("the document is XML with the ODX root and the model version it is written against", () => {
  const document = renderOdxHarvest(fixture());
  assert.match(document, /^<\?xml version="1\.0" encoding="UTF-8" standalone="no" \?>\n/);
  assert.match(document, /<ODX MODEL-VERSION="2\.2\.0"/);
  assert.match(document, /<DIAG-LAYER-CONTAINER ID="harvest_adapter_socketcan_can0">/);
  assert.match(document, /<\/ODX>\n$/);
});

test("one base variant per ECU that answered, named by its address", () => {
  const document = renderOdxHarvest(fixture());
  assert.match(document, /<BASE-VARIANT ID="harvest_adapter_socketcan_can0\.ecu-7e8">/);
  assert.match(document, /<SHORT-NAME>ecu-7e8<\/SHORT-NAME>/);
  assert.match(document, /<LONG-NAME>Engine Control Unit<\/LONG-NAME>/);
});

test("every observed DID becomes a service with a byte-exact request and response", () => {
  const document = renderOdxHarvest(fixture());
  assert.match(document, /<DIAG-SERVICE ID="[^"]+\.read_did_F190" SEMANTIC="IDENTIFICATION">/);
  // The request: SID 0x22 + DID 0xF190 as two coded constants (8 and 16 bit).
  assert.match(
    document,
    /<SHORT-NAME>sid<\/SHORT-NAME>\s*<BYTE-POSITION>0<\/BYTE-POSITION>\s*<CODED-VALUE>34<\/CODED-VALUE>/,
  );
  assert.match(
    document,
    /<SHORT-NAME>data_id<\/SHORT-NAME>\s*<BYTE-POSITION>1<\/BYTE-POSITION>\s*<CODED-VALUE>61840<\/CODED-VALUE>/,
  );
  // The response payload is a byte field of exactly the observed length.
  assert.match(document, /<MIN-LENGTH>17<\/MIN-LENGTH>\s*<MAX-LENGTH>17<\/MAX-LENGTH>/);
  assert.match(document, /BASE-DATA-TYPE="A_BYTEFIELD"/);
});

test("a refused DID range is stated as a count, not as invented services", () => {
  const document = renderOdxHarvest(fixture());
  assert.match(document, /SI="dids-refused"/);
  assert.match(document, /identification 0xF180-0xF1FF: 116× NRC 0x31/);
  assert.equal(
    /read_did_F180/.test(document),
    false,
    "no service exists for an identifier that never answered",
  );
});

test("observed codes become DTC entries with status, mask and the honest text", () => {
  const document = renderOdxHarvest(fixture());
  assert.match(document, /<DTC-DOP ID="[^"]+\.dtcs">/);
  assert.match(document, /<TROUBLE-CODE>270336<\/TROUBLE-CODE>/, "P0420-00 as a 24-bit number");
  assert.match(document, /<DISPLAY-TROUBLE-CODE>P0420-00<\/DISPLAY-TROUBLE-CODE>/);
  assert.match(document, /Meaning not documented in this file: it is a harvest observation\./);
  assert.match(document, /SI="availability-mask">0x2f</);
  assert.match(
    document,
    /SI="status-bits-set">testFailed,testFailedThisOperationCycle,pendingDtc,confirmedDtc,testFailedSinceLastClear</,
  );
  assert.match(document, /SI="snapshot-records">1</);
});

test("the trouble code number is the three wire bytes, as ISO 14229-1 transmits them", () => {
  assert.equal(dtcNumber({ raw: "042000" }), 0x042000);
  assert.equal(dtcNumber({ raw: "04201F" }), 0x04201f, "the failure type is the low byte");
  assert.equal(dtcNumber({ raw: "C1234A" }), 0xc1234a);
});

test("freeze frames become ENV-DATA, raw, with the code they belong to", () => {
  const document = renderOdxHarvest(fixture());
  assert.match(document, /<ENV-DATA-DESC ID="[^"]+\.snapshot_desc">/);
  assert.match(document, /<DTC-DOP-REF ID-REF="[^"]+\.dtcs"\/>/);
  assert.match(document, /<DTC-VALUE>270336<\/DTC-VALUE>/);
  assert.match(document, /SI="snapshot-hex">0946003201F4</);
  assert.match(
    document,
    /the record layout to the manufacturer, so nothing here/,
    "the file says it does not interpret the record",
  );
});

test("provenance is stated in the document, not only in the harvest record", () => {
  const document = renderOdxHarvest(fixture());
  assert.match(document, /SI="provenance">observed</);
  assert.match(document, /SI="source">adapter:socketcan:can0</);
  assert.match(document, /SI="retrieved-at">2026-09-23T10:00:00\.000Z</);
  assert.match(document, /SI="vin-redacted">true</);
  assert.match(document, /SI="platform-version">0\.1\.0</);
  assert.match(
    document,
    /Nicht enthalten: die ODX-C-Kommunikationsparameter/,
    "the document states what it does not contain",
  );
});

test("the addressing, timing and gaps of an ECU travel as its special data", () => {
  const document = renderOdxHarvest(fixture());
  assert.match(document, /SI="tx-id">0x7e0</);
  assert.match(document, /SI="rx-id">0x7e8</);
  assert.match(document, /SI="p2-ms">50</);
  assert.match(document, /SI="supported-services">0x10,0x19,0x22,0x3e</);
  assert.match(document, /SI="dtc-availability-mask">0x2f</);
  assert.match(
    document,
    /SI="gaps">dtc-snapshot-identification: subFunctionNotSupported \(0x12\)</,
  );
  assert.match(document, /SI="definition-ecu">engine</);
});

test("a character that would break XML is escaped, not dropped", () => {
  const report = fixture();
  const ecu = report.ecus[0];
  assert.ok(ecu);
  const did = ecu.dids[1];
  assert.ok(did);
  // A spare-part number with an ampersand and a quote: both are real OEM data.
  did.asciiHint = 'A&B "123" <x>';
  did.rawHex = toHexText(new TextEncoder().encode('A&B "123" <x>'));
  did.byteLength = 12;
  const document = renderOdxHarvest(report);
  // In text content XML escapes &, < and >; a quote needs no escape there (it is
  // only special inside an attribute value), so the hint reads exactly like this:
  assert.match(document, /A&amp;B "123" &lt;x&gt;/);
  assert.equal(document.includes("A&B"), false, "the ampersand must never reach the file raw");
  assert.equal(document.includes("<x>"), false, "nor an angle bracket that would open a tag");
});

test("the round trips the document promises are listed as data", () => {
  const expectations = expectationsOf(fixture());
  assert.equal(expectations.length, 3, "two DIDs plus the fault-memory read");
  assert.deepEqual(expectations[0], {
    variant: "ecu-7e8",
    service: "read_did_F190",
    requestHex: "22F190",
    responseHex: "62F1905756575A5A5A33435A5745313233343536",
  });
  const list = expectations.find((entry) => entry.service === "read_dtc_by_status_mask");
  assert.ok(list);
  assert.equal(list.requestHex, "1902FF");
  assert.equal(
    list.responseHex,
    "5902 2F 042000 2F 030000 24".replaceAll(" ", ""),
    "header, availability mask, then DTC(3)+status(1) per code",
  );
});

test("an ECU with no answers produces no service and no DTC-DOP", () => {
  const report = fixture();
  const ecu = report.ecus[0];
  assert.ok(ecu);
  ecu.dids = [];
  ecu.dtcs = [];
  const services = observedServicesOf(ecu);
  assert.deepEqual(services, []);
  const document = renderOdxHarvest(report);
  assert.equal(/DIAG-SERVICE/.test(document), false);
  assert.equal(/DTC-DOP/.test(document), false);
});

test("the container short name is a legal ODX name, whatever the source looked like", () => {
  const report = fixture();
  assert.equal(containerShortNameOf(report), "harvest_adapter_socketcan_can0");
  report.identity.source = "1. Fahrzeug (Test) & mehr";
  assert.match(containerShortNameOf(report), /^[A-Za-z][A-Za-z0-9_]*$/);
});
