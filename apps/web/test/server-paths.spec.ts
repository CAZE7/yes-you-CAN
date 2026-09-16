/**
 * The paths of the HTTP layer that a happy demo run never walks.
 *
 * These are the branches E17 named (a thin coverage buffer under `apps/web/src`) and
 * each of them is a rule someone could break without any test noticing:
 *
 * - **The freeze frame is a read.** `/api/dtc/snapshot` is how the panel shows *what the
 *   ECU saw when it latched*; its bytes have to come back decoded, and a record number has
 *   to travel to the request instead of being improvised here.
 * - **A refusal is an answer.** A missing code, an id that is not a CAN identifier, a body
 *   that is not JSON, a body of two megabytes — the workbench answers each of them with a
 *   status and a sentence, never with a hang and never with a stack trace in the panel.
 * - **A marker is data the operator adds.** The graphs and the scenario timeline read what
 *   was marked, so the POST route has to put the label where the history exposes it.
 *
 * Deliberately *not* here: the CLI block at the bottom of `server.ts` (`--demo`,
 * `--list-adapters`). Spawning it would prove the behaviour but not the coverage — a child
 * process is not in the parent's v8 counters — and pretending otherwise would be a number
 * obtained by deleting a finding.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { json, post, withServer } from "../../../tests/helpers/workbench.js";
import type { FreezeFrameView } from "../src/ecu-view.js";
import { WebServer } from "../src/server.js";

/** What `/api/history` exposes of the recording — only the part these tests read. */
type HistoryView = {
  markers: Array<{ id: string; t: number; label: string; kind: string; detail?: string }>;
};

/** The engine of the simulated vehicle and the code the demo seeds into it. */
const ENGINE_RX_ID = "0x7E8";
const SEEDED_CODE = "P0420";

async function started(run: (base: string) => Promise<void>): Promise<void> {
  await withServer(async (base) => {
    const start = await post(base, "/api/start");
    assert.equal(start.status, 200, "the simulated vehicle must be reachable for this test");
    await run(base);
  });
}

test("a freeze frame comes back decoded, and every value names the bytes it came from", async () => {
  await started(async (base) => {
    const response = await post(base, "/api/dtc/snapshot", {
      rxId: ENGINE_RX_ID,
      code: SEEDED_CODE,
    });
    assert.equal(response.status, 200);
    const frame = (response.body as { snapshot: FreezeFrameView }).snapshot;
    assert.equal(frame.code, SEEDED_CODE);
    assert.equal(frame.documented, true, "the definition package describes this code");
    assert.equal(
      frame.recordNumber,
      0xff,
      "the route asks for the *general* record when the caller does not name one",
    );
    const dids = frame.fields.map((field) => field.did);
    for (const did of ["0xF40C", "0xF404", "0xF405", "0xF40D"]) {
      assert.ok(dids.includes(did), `the documented frame carries ${did}, got ${dids.join()}`);
    }
    const rpm = frame.fields
      .flatMap((field) => field.values)
      .find((value) => value.signal === "engine.rpm");
    assert.ok(rpm, "the frame decodes the engine speed");
    // 0x30C0 is 12480, and J1979 scales rpm by 1/4 — the value has to be the arithmetic,
    // not a restatement of the byte. `rawHex` travels so a reader can check that itself.
    assert.equal(rpm.rawHex, "30 C0");
    assert.equal(rpm.value, "3120");
    assert.equal(rpm.unit, "rpm");
    assert.equal(rpm.outOfRange, false, "a plausible value is not flagged as an outlier");
  });
});

test("the record number the caller asks for is the record number the answer states", async () => {
  await started(async (base) => {
    const response = await post(base, "/api/dtc/snapshot", {
      rxId: ENGINE_RX_ID,
      code: SEEDED_CODE,
      recordNumber: 1,
    });
    assert.equal(response.status, 200);
    const frame = (response.body as { snapshot: FreezeFrameView }).snapshot;
    assert.equal(frame.recordNumber, 1, "no improvising a record here — the ECU was asked");
    assert.ok(
      frame.fields.length > 0,
      "the vehicle answers for the record it holds; the request must not invent one",
    );
  });
});

test("an ECU id is accepted as a number or as the text a technician writes", async () => {
  await started(async (base) => {
    const numeric = await post(base, "/api/dtc/snapshot", {
      rxId: 0x7e8, // the number the panel keeps after parsing the id once
      code: SEEDED_CODE,
    });
    assert.equal(numeric.status, 200, "the panel may hand over the parsed id");
    const text = await post(base, "/api/dtc/snapshot", { rxId: "7e8", code: SEEDED_CODE });
    assert.equal(text.status, 200, "…and the raw form without a 0x prefix");
    assert.deepEqual(
      (numeric.body as { snapshot: FreezeFrameView }).snapshot.fields.map((f) => f.did),
      (text.body as { snapshot: FreezeFrameView }).snapshot.fields.map((f) => f.did),
      "the two spellings address the same ECU",
    );
  });
});

test("what the request got wrong is said back, with the status for it", async () => {
  await started(async (base) => {
    const cases: Array<{ body: unknown; status: number; message: RegExp; why: string }> = [
      {
        body: { rxId: ENGINE_RX_ID },
        status: 400,
        message: /a DTC code is required/,
        why: "a snapshot without a code is not a read of anything",
      },
      {
        body: { rxId: "", code: SEEDED_CODE },
        status: 400,
        message: /rxId\) is required/,
        why: "an empty id is a missing id, not the id zero",
      },
      {
        body: { rxId: "0xZZ", code: SEEDED_CODE },
        status: 400,
        message: /is not a CAN identifier/,
        why: "the field has a grammar, and the panel must not guess which part was wrong",
      },
      {
        body: { rxId: 2 ** 33, code: SEEDED_CODE },
        status: 400,
        message: /is not a CAN identifier/,
        why: "beyond 29 bits there is no such frame id (CAN extended range)",
      },
      {
        body: { rxId: -1, code: SEEDED_CODE },
        status: 400,
        message: /is not a CAN identifier/,
        why: 'a number was given, so the number grammar answers it — not "nothing was given"',
      },
      {
        body: { rxId: 2024.5, code: SEEDED_CODE },
        status: 400,
        message: /is not a CAN identifier/,
        why: "no half an identifier",
      },
      {
        body: { rxId: "7e8xyz", code: SEEDED_CODE },
        status: 400,
        message: /is not a CAN identifier/,
        why: "trailing keys must not silently retarget the read to another ECU",
      },
    ];
    for (const testCase of cases) {
      const response = await post(base, "/api/dtc/snapshot", testCase.body);
      assert.equal(response.status, testCase.status, testCase.why);
      assert.match((response.body as { error: string }).error, testCase.message, testCase.why);
    }
  });
});

test("an id that is not on this bus is answered, and the server keeps working", async () => {
  await started(async (base) => {
    const response = await post(base, "/api/dtc/snapshot", {
      rxId: "0x7F0",
      code: SEEDED_CODE,
    });
    // Pinned as it is, not as it should be: an operator's wrong id reaches the runtime as a
    // plain Error, so the HTTP layer reports 500 and logs "request failed" as if the server
    // had broken. The sentence is right; the status is a 409 case. 0.E E23 carries that,
    // because changing a pinned status is a decision of its own, not a side effect.
    assert.equal(response.status, 500);
    assert.match(
      (response.body as { error: string }).error,
      /unknown ECU "0x7f0" — connect first or check the id/,
      "the answer names the id it could not find, lower-case as the ECU reference is spelled",
    );
    const state = await json(base, "/api/state");
    assert.equal(state.status, 200, "one failed read must not take the workbench with it");
  });
});

test("a marker lands in the recording, with a label even when the caller gives none", async () => {
  await started(async (base) => {
    const labelled = await post(base, "/api/marker", { label: "Zündung an, Messfahrt beginnt" });
    assert.deepEqual(labelled.body, { ok: true });
    // No body at all: `readBody` treats an empty stream as an empty object, and the route
    // has to keep its default label instead of writing `undefined` into the recording.
    const bare = await json(base, "/api/marker", { method: "POST" });
    assert.equal(bare.status, 200);

    const history = (await json(base, "/api/history")).body as HistoryView;
    const labels = history.markers.map((marker) => marker.label);
    assert.ok(labels.includes("Zündung an, Messfahrt beginnt"), `got ${labels.join(", ")}`);
    assert.ok(labels.includes("marker"), "the default label is a word, not a hole");
    for (const label of ["Zündung an, Messfahrt beginnt", "marker"]) {
      const marker = history.markers.find((entry) => entry.label === label);
      assert.ok(marker, `${label} is missing from the history`);
      assert.equal(marker.kind, "user", "an operator's marker is not an ECU event");
      assert.match(marker.id, /^marker_\d+$/);
      assert.ok(Number.isFinite(marker.t), "a marker without a time cannot be plotted");
    }
  });
});

test("a body that is broken or oversized is refused before anything is parsed", async () => {
  await withServer(async (base) => {
    const broken = await json(base, "/api/marker", {
      method: "POST",
      body: "{oops",
      headers: { "content-type": "application/json" },
    });
    assert.equal(broken.status, 400);
    assert.match(
      (broken.body as { error: string }).error,
      /request body is not valid JSON/,
      "the message says what was wrong with the body, not that something failed",
    );

    // 1 MB is the limit (`MAX_BODY_BYTES`); one byte more must be an answer while the
    // stream is still open, which is the point of counting the size while reading.
    const oversized = await json(base, "/api/marker", {
      method: "POST",
      body: `{"label":"${"a".repeat(1_000_000)}"}`,
      headers: { "content-type": "application/json" },
    });
    assert.equal(oversized.status, 413);
    assert.match(
      (oversized.body as { error: string }).error,
      /request body exceeds the 1000000 byte limit/,
      "the limit is named in the refusal, so the operator can act on it",
    );
  });
});

test("binding every interface is allowed, and the address it prints says localhost", async () => {
  // ADR 0009: the workbench has no authentication, so the opt-out is loud in the log and
  // the URL it hands back is the one that works from this machine. Both halves are the
  // contract of this branch; a silent `--host=0.0.0.0` would be the security story lost.
  const server = new WebServer({ port: 0, host: "0.0.0.0", liveIntervalMs: 60 });
  const { port, url } = await server.listen();
  try {
    assert.match(url, /^http:\/\/localhost:\d+$/, `the printed address must work locally: ${url}`);
    const response = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(response.status, 200, "the server is reachable on the wildcard bind");
  } finally {
    await server.close();
  }
});
