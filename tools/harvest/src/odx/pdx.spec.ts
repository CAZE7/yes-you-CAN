/**
 * The PDX container (ADR 0058).
 *
 * A `.pdx` is a ZIP with an `index.xml` catalog. Two things are pinned: the catalog
 * lists exactly the files that are in the archive with their MIME type, and the
 * archive can be read back — with the ZIP reader this repository already has
 * (`@vdp/storage`), so the container format is checked by something that did not
 * write it.
 */

import assert from "node:assert/strict";
import { listZipEntries } from "@vdp/storage";
import { test } from "vitest";
import type { HarvestReport } from "../observation.js";
import { createPdx, ODX_MIME_TYPES, pdxFilesOf, renderPdxIndex, toOdxDate } from "./pdx.js";

function fixture(): HarvestReport {
  return {
    kind: "vdp.harvest",
    version: 1,
    identity: { source: "adapter:socketcan:can0", platformVersion: "0.1.0" },
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
    ecus: [
      {
        id: "ecu-7e8",
        name: "Engine Control Unit",
        txId: 0x7e0,
        rxId: 0x7e8,
        extended: false,
        acceptedSessions: [],
        serviceProbes: [],
        supportedServices: [0x22],
        identification: [],
        dids: [
          {
            did: 0xf190,
            rawHex: "575657",
            byteLength: 3,
            asciiHint: "WVW",
            origin: "standard",
          },
        ],
        didRefusals: [],
        dtcs: [],
        gaps: [],
      },
    ],
    unread: [],
    counts: {
      ecusAnswered: 1,
      addressesUnread: 0,
      didsRead: 1,
      didsRefused: 0,
      dtcsFound: 0,
      snapshotsRead: 0,
      requestsSent: 4,
    },
    notes: [],
  };
}

test("the container holds the catalog and the diagnostic-layer document", () => {
  const archive = createPdx(fixture());
  const entries = listZipEntries(archive);
  assert.deepEqual(entries.sort(), ["harvest_adapter_socketcan_can0.odx-d", "index.xml"]);
});

test("the catalog lists every file it contains, with MIME type and creation date", () => {
  const report = fixture();
  const files = pdxFilesOf(report);
  const catalog = renderPdxIndex("harvest_demo", files);
  assert.match(catalog, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<CATALOG /);
  assert.match(catalog, /F-DTD-VERSION="ODX-2\.2\.0"/);
  assert.match(catalog, /<SHORT-NAME>harvest_demo<\/SHORT-NAME>/);
  for (const file of files) {
    assert.ok(
      catalog.includes(
        `<FILE CREATION-DATE="2026-09-23T10:00:00" MIME-TYPE="${file.mimeType}">${file.name}</FILE>`,
      ),
      file.name,
    );
  }
  assert.match(catalog, /<ABLOCK UPD="UNCHANGED">/);
});

test("the ODX-D entry carries the MIME type an ODX reader looks for", () => {
  const files = pdxFilesOf(fixture());
  assert.equal(files.length, 1);
  assert.equal(files[0]?.mimeType, ODX_MIME_TYPES.diagLayerContainer);
  assert.equal(files[0]?.mimeType, "application/x-asam.odx.odx-d");
  assert.equal(files[0]?.name.endsWith(".odx-d"), true);
});

test("the ODX dates carry second precision, not milliseconds and not a zone", () => {
  assert.equal(toOdxDate("2026-09-23T10:00:00.000Z"), "2026-09-23T10:00:00");
  assert.equal(toOdxDate("2026-09-23T10:00:00+02:00"), "2026-09-23T10:00:00");
  assert.equal(
    toOdxDate("not-a-date"),
    "not-a-date",
    "an unusable timestamp is passed through, not invented",
  );
});

test("an explicit container name is used everywhere — file name, catalog and ODX id", () => {
  const report = fixture();
  const files = pdxFilesOf(report, { containerShortName: "my_car" });
  assert.equal(files[0]?.name, "my_car.odx-d");
  assert.match(files[0]?.content ?? "", /<DIAG-LAYER-CONTAINER ID="my_car">/);
  assert.match(renderPdxIndex("my_car", files), /<SHORT-NAME>my_car<\/SHORT-NAME>/);
});

test("the document inside the archive is the same one the writer produces", () => {
  const report = fixture();
  const files = pdxFilesOf(report);
  const archive = createPdx(report);
  // The archive is a store-method ZIP, so the file content appears verbatim.
  const content = new TextDecoder().decode(archive);
  assert.ok(content.includes("<DIAG-LAYER-CONTAINER"), "the ODX document is inside the archive");
  assert.ok(
    content.includes(files[0]?.content.slice(200, 400) ?? "___"),
    "byte-for-byte, not re-rendered",
  );
});
