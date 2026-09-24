/**
 * The cross-check against the reference implementation (ADR 0058).
 *
 * Two halves, deliberately separated:
 *
 * 1. **Always run:** the parts this repository owns — that a missing checker is
 *    reported as `not-run` with a reason and never as a pass, that the checker's
 *    output is parsed into findings, and that a document the reference
 *    implementation rejects is reported as `failed`.
 * 2. **Only when `odxtools` is installed:** the real differential check — the
 *    harvested ODX-D document parses, every observed request encodes back to the
 *    bytes that were sent, and every observed response decodes back to the bytes
 *    that came home. When the library is absent the suite says so instead of going
 *    quietly green, the same rule `formal/README.md` states for the Haskell
 *    reference: `NOT RUN` is never a pass.
 *
 * `odxtools` is MIT-licensed and external; it is a checker, not a dependency
 * (ADR 0002). Install it with `pip install odxtools`, or point `VDP_ODX_PYTHON` at
 * an interpreter that has it.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { genericPackage } from "@vdp/definitions";
import { createLogger } from "@vdp/shared";
import { VirtualVehicle } from "@vdp/simulators";
import { afterAll, beforeAll, describe, test } from "vitest";
import { harvestVehicle } from "../harvest.js";
import { expectationsOf, renderOdxHarvest } from "./diag-layer.js";
import {
  ODX_CHECKER_CANDIDATES,
  parseCheckerOutput,
  verificationCounts,
  verifyOdxDocument,
} from "./verify.js";

/** Is there an interpreter with `odxtools` on this host? Measured, not assumed. */
function findChecker(): string | undefined {
  for (const candidate of ODX_CHECKER_CANDIDATES) {
    const probe = spawnSync(candidate, ["-c", "import odxtools"], {
      encoding: "utf8",
      timeout: 20_000,
    });
    if (probe.status === 0 && probe.error === undefined) return candidate;
  }
  return undefined;
}

const checker = findChecker();

describe("the cross-check reports honestly", () => {
  test("a checker that is not installed is not-run, with the reason", () => {
    const verification = verifyOdxDocument("<ODX/>", { checker: "/nonexistent/python-vdp" });
    assert.equal(verification.state, "not-run");
    assert.match(verification.reason ?? "", /is not usable as a checker|not importable/);
    assert.deepEqual(verificationCounts(verification), {
      variants: 0,
      services: 0,
      dtcs: 0,
      encodeOk: 0,
      decodeOk: 0,
      mismatch: 0,
    });
  });

  test("an interpreter without odxtools is not-run, and says which one was tried", () => {
    // `sh` exists on every host this runs on and cannot import a Python module.
    const verification = verifyOdxDocument("<ODX/>", { checker: "sh" });
    assert.equal(verification.state, "not-run");
    assert.match(
      verification.reason ?? "",
      /odxtools is not importable|is not usable as a checker/,
    );
  });

  test("the checker's key=value lines become findings, in order, without the noise", () => {
    const findings = parseCheckerOutput(
      [
        "parse=ok",
        "",
        "  odxtools=11.6.0  ",
        "variants=3",
        "Traceback (most recent call last):",
        "decode.a.b=62F190",
      ].join("\n"),
    );
    assert.deepEqual(findings, ["parse=ok", "odxtools=11.6.0", "variants=3", "decode.a.b=62F190"]);
    assert.deepEqual(parseCheckerOutput(""), []);
  });

  test("counts are read from the findings and default to zero, never to a guess", () => {
    const counts = verificationCounts({
      state: "verified",
      findings: [
        "variants=3",
        "services=29",
        "dtcs=7",
        "encode_ok=29",
        "decode_ok=29",
        "mismatch=0",
      ],
    });
    assert.deepEqual(counts, {
      variants: 3,
      services: 29,
      dtcs: 7,
      encodeOk: 29,
      decodeOk: 29,
      mismatch: 0,
    });
    assert.deepEqual(verificationCounts({ state: "not-run", findings: [] }).services, 0);
  });

  test("the candidates list honours VDP_ODX_PYTHON and never contains an empty entry", () => {
    assert.ok(ODX_CHECKER_CANDIDATES.length > 0);
    assert.equal(
      ODX_CHECKER_CANDIDATES.some((entry) => entry.length === 0),
      false,
    );
    assert.ok(
      ODX_CHECKER_CANDIDATES.includes("python3") || process.env.VDP_ODX_PYTHON !== undefined,
      "python3 is the default checker",
    );
  });
});

/**
 * The differential check itself.
 *
 * Skipped with a message when `odxtools` is not installed — the alternative
 * (asserting on a check that cannot run) would be the dishonest version.
 */
describe.skipIf(checker === undefined)("the reference implementation accepts a harvest", () => {
  const logger = createLogger("verify-spec", { level: "ERROR" });
  const vehicle = new VirtualVehicle({
    logger,
    definitions: genericPackage,
    seed: 7,
    dtcs: { engine: [{ code: "P0420", status: 0x2f, snapshot: new Uint8Array([0x09, 0x46]) }] },
  });
  let document = "";
  let expectations: ReturnType<typeof expectationsOf> = [];

  beforeAll(async () => {
    await vehicle.start();
    const report = await harvestVehicle({
      bus: vehicle.testerBus,
      definitions: [genericPackage],
      logger,
      identity: { source: "spec:odx-cross-check", platformVersion: "0.1.0" },
      plan: {
        requestGapMs: 0,
        windowMs: 60,
        repeatReadsForStability: false,
        didRanges: [{ name: "identification", from: 0xf180, to: 0xf19f, reason: "test block" }],
      },
      timestamp: () => "2026-09-23T10:00:00.000Z",
      now: () => 1_000,
    });
    document = renderOdxHarvest(report);
    expectations = expectationsOf(report);
  });

  afterAll(async () => {
    await vehicle.stop();
  });

  test("the harvested document parses and describes every ECU that answered", () => {
    const verification = verifyOdxDocument(document, { checker, expectations });
    assert.equal(verification.state, "verified", verification.reason ?? verification.output ?? "");
    const counts = verificationCounts(verification);
    assert.ok(counts.variants >= 1, `expected at least one variant, got ${counts.variants}`);
    assert.ok(counts.services >= expectations.length, "every observed conversation is described");
    assert.ok(counts.dtcs >= 1, "the injected P0420 is described");
  }, 120_000);

  test("every observed request encodes back to the bytes that were sent", () => {
    const verification = verifyOdxDocument(document, { checker, expectations });
    const counts = verificationCounts(verification);
    assert.equal(counts.encodeOk, expectations.length, "one round trip per observed conversation");
    assert.equal(
      counts.mismatch,
      0,
      verification.findings.filter((f) => f.startsWith("finding=")).join("\n"),
    );
  }, 120_000);

  test("every observed response decodes back to the bytes that came home", () => {
    const verification = verifyOdxDocument(document, { checker, expectations });
    const counts = verificationCounts(verification);
    assert.equal(counts.decodeOk, expectations.length);
    const decoded = verification.findings.filter((line) => line.startsWith("decode."));
    assert.equal(decoded.length, expectations.length);
    for (const expectation of expectations) {
      const line = decoded.find((entry) =>
        entry.startsWith(`decode.${expectation.variant}.${expectation.service}=`),
      );
      assert.ok(line, `no decode line for ${expectation.variant}.${expectation.service}`);
      assert.equal(line?.split("=")[1], expectation.responseHex, "byte-exact round trip");
    }
  }, 120_000);

  test("a wrong expectation is rejected, so the cross-check has teeth", () => {
    // Same document, one claim that is not true of it: the checker has to say so
    // instead of reporting a pass. Without this the green result above would only
    // prove that the checker ran, not that it compares anything.
    // The request the first service claims to encode, changed by one nibble: the
    // document still parses, so only the byte comparison can catch it.
    const tampered = expectations.map((entry, index) =>
      index === 0 ? { ...entry, requestHex: entry.requestHex.replace(/F190$/, "F191") } : entry,
    );
    const verification = verifyOdxDocument(document, { checker, expectations: tampered });
    assert.equal(verification.state, "failed");
    assert.match(verification.reason ?? "", /encodes|decodes to|missing/);
    assert.ok(verificationCounts(verification).mismatch > 0);
  }, 120_000);

  test("a document with no variant at all is refused, not read as empty", () => {
    const empty = renderOdxHarvest({
      kind: "vdp.harvest",
      version: 1,
      identity: { source: "spec:empty", platformVersion: "0.1.0" },
      bus: { addressing: "11-bit", functionalId: 0x7df },
      startedAt: "2026-09-23T10:00:00.000Z",
      finishedAt: "2026-09-23T10:00:00.000Z",
      durationMs: 0,
      plan: {
        services: [],
        sessions: [],
        didRanges: [],
        standardDids: [],
        dtcRecordNumbers: [],
        budgetPerEcuMs: 0,
        requestGapMs: 0,
      },
      ecus: [],
      unread: [],
      counts: {
        ecusAnswered: 0,
        addressesUnread: 0,
        didsRead: 0,
        didsRefused: 0,
        dtcsFound: 0,
        snapshotsRead: 0,
        requestsSent: 0,
      },
      notes: [],
    });
    const verification = verifyOdxDocument(empty, { checker });
    assert.equal(verification.state, "failed");
    assert.match(verification.reason ?? "", /no base variant/);
  }, 120_000);
});
