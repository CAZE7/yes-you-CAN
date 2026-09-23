/**
 * Cross-checking the ODX output against the reference implementation (ADR 0058).
 *
 * A writer that only its own tests read proves nothing about the format: the tests
 * and the writer share one author's reading of ISO 22901-1. So the generated
 * document is handed to **`odxtools`** — the MIT-licensed ODX reference library
 * maintained by Mercedes-Benz — which parses it with its own reading of the
 * standard and then *encodes* the observed request and *decodes* the observed
 * response back out of the file. That is the same argument the Haskell conformance
 * runner makes for ISO-TP (ADR 0045): two implementations, one artifact, and a
 * difference is a finding.
 *
 * `odxtools` is **not a dependency of this repository** (ADR 0002). It is an
 * optional, external checker: this module spawns a Python interpreter that already
 * has it, and reports honestly when there is none —
 * `state: "not-run"` with the reason, never a silent pass. A cross-check that can
 * be skipped is still worth having; a cross-check that pretends to have run is not.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messageOf } from "@vdp/shared";
import type { OdxExpectation } from "./diag-layer.js";

/** What the cross-check found. */
export type OdxVerificationState = "verified" | "failed" | "not-run";

export interface OdxVerification {
  state: OdxVerificationState;
  /** Interpreter and library that ran, when one ran. */
  checker?: string;
  /** What the checker reported: parsed layers, services, DTCs, encode/decode results. */
  findings: string[];
  /** Why it did not run, when it did not. */
  reason?: string;
  /** Raw stdout, kept for a report that has to show the evidence. */
  output?: string;
}

/** Candidate interpreters, in the order they are tried. */
export const ODX_CHECKER_CANDIDATES: readonly string[] = [
  process.env.VDP_ODX_PYTHON ?? "",
  "python3",
  "python",
].filter((entry) => entry.length > 0);

/**
 * The Python program the checker runs.
 *
 * It prints one `key=value` line per finding, in a form this module can read
 * without a JSON parser in Python's path — and it exits non-zero when the document
 * does not parse, so "the file was unreadable" cannot be reported as a pass.
 *
 * The checks are the ones that matter for a harvested description:
 *
 * 1. the document parses (schema shape, IDs, references resolve),
 * 2. every base variant and its services are visible,
 * 3. each service **encodes** to the request bytes the harvest observed,
 * 4. each service **decodes** the response bytes back to the same values,
 * 5. the DTC entries carry the trouble codes the ECU reported.
 */
const CHECKER_PROGRAM = `
import json, sys, traceback
import odxtools

document_path = sys.argv[1]
expectations_path = sys.argv[2]

try:
    db = odxtools.load_file(document_path)
except Exception:
    print("parse=failed")
    traceback.print_exc(file=sys.stderr)
    sys.exit(2)

with open(expectations_path, "r", encoding="utf-8") as handle:
    expectations = json.load(handle)

print("parse=ok")
print("odxtools=%s" % getattr(odxtools, "__version__", "unknown"))

variants = {}
dtcs = 0
services = 0
for container in db.diag_layer_containers:
    for variant in list(container.base_variants) + list(container.ecu_variants):
        variants[variant.short_name] = variant
        services += len(variant.services)
        for dop in variant.diag_data_dictionary_spec.dtc_dops:
            dtcs += len(dop.dtcs)

print("variants=%d" % len(variants))
print("services=%d" % services)
print("dtcs=%d" % dtcs)

if len(variants) == 0:
    print("finding=no base variant in the document")
    sys.exit(3)

encode_ok = encode_bad = decode_ok = decode_bad = mismatch = 0
for expectation in expectations:
    variant = variants.get(expectation["variant"])
    if variant is None:
        mismatch += 1
        print("finding=variant %s is missing" % expectation["variant"])
        continue
    service = next((s for s in variant.services if s.short_name == expectation["service"]), None)
    if service is None:
        mismatch += 1
        print("finding=service %s.%s is missing" % (expectation["variant"], expectation["service"]))
        continue
    # 1. the file encodes the request that was sent
    try:
        encoded = bytes(service.encode_request()).hex().upper()
        if encoded == expectation["requestHex"]:
            encode_ok += 1
        else:
            encode_bad += 1
            mismatch += 1
            print("finding=%s.%s encodes %s, the harvest sent %s"
                  % (expectation["variant"], expectation["service"], encoded, expectation["requestHex"]))
    except Exception as error:
        encode_bad += 1
        mismatch += 1
        print("finding=%s.%s could not be encoded: %s"
              % (expectation["variant"], expectation["service"], error))
    # 2. the file decodes the response that came back, to the same bytes
    try:
        raw = bytes.fromhex(expectation["responseHex"])
        message = service.decode_message(raw)
        decoded = bytes(message.coded_message).hex().upper()
        if decoded == expectation["responseHex"]:
            decode_ok += 1
            print("decode.%s.%s=%s" % (expectation["variant"], expectation["service"], decoded))
        else:
            decode_bad += 1
            mismatch += 1
            print("finding=%s.%s decodes to %s, the ECU sent %s"
                  % (expectation["variant"], expectation["service"], decoded, expectation["responseHex"]))
    except Exception as error:
        decode_bad += 1
        mismatch += 1
        print("finding=%s.%s could not be decoded: %s"
              % (expectation["variant"], expectation["service"], error))

print("encode_ok=%d" % encode_ok)
print("encode_bad=%d" % encode_bad)
print("decode_ok=%d" % decode_ok)
print("decode_bad=%d" % decode_bad)
print("mismatch=%d" % mismatch)
if mismatch > 0:
    sys.exit(4)
`;

export interface OdxVerifyOptions {
  /**
   * Interpreter to use instead of {@link ODX_CHECKER_CANDIDATES}.
   *
   * Spelled `| undefined` on purpose: a caller that measured whether a checker
   * exists hands the result over verbatim, and under `exactOptionalPropertyTypes`
   * a forwarded maybe-value would otherwise need a conditional spread at every hop
   * (the same reasoning as `EcuLinksOptions.bus`).
   */
  checker?: string | undefined;
  /**
   * The round trips the document has to reproduce. Without them the checker can
   * only prove that the file parses; with them it proves that the file *encodes
   * the request that was sent* and *decodes the response that came back* — which
   * is the whole claim a harvested description makes.
   */
  expectations?: readonly OdxExpectation[];
}

/**
 * Verify one ODX document with `odxtools`, if this host has it.
 *
 * @param document the ODX-D XML text
 */
export function verifyOdxDocument(
  document: string,
  options: OdxVerifyOptions = {},
): OdxVerification {
  const candidates =
    options.checker !== undefined ? [options.checker] : [...ODX_CHECKER_CANDIDATES];
  let directory: string | null = null;
  try {
    directory = mkdtempSync(join(tmpdir(), "vdp-odx-"));
    const documentPath = join(directory, "harvest.odx-d");
    const programPath = join(directory, "check.py");
    const expectationsPath = join(directory, "expectations.json");
    writeFileSync(documentPath, document, "utf8");
    writeFileSync(programPath, CHECKER_PROGRAM, "utf8");
    writeFileSync(expectationsPath, JSON.stringify(options.expectations ?? []), "utf8");

    let lastError = "no Python interpreter with odxtools was found";
    for (const candidate of candidates) {
      const probe = spawnSync(candidate, ["-c", "import odxtools"], {
        encoding: "utf8",
        timeout: 20_000,
      });
      if (probe.error !== undefined || probe.status !== 0) {
        lastError =
          probe.error !== undefined
            ? `${candidate} is not usable as a checker: ${messageOf(probe.error)}`
            : `${candidate}: odxtools is not importable`;
        continue;
      }
      const run = spawnSync(candidate, [programPath, documentPath, expectationsPath], {
        encoding: "utf8",
        timeout: 60_000,
      });
      const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
      const findings = parseCheckerOutput(run.stdout ?? "");
      if (run.error !== undefined) {
        return {
          state: "not-run",
          checker: candidate,
          findings,
          reason: `${candidate} could not be run: ${messageOf(run.error)}`,
          output,
        };
      }
      if (run.status !== 0) {
        const stated = findings.filter((line) => line.startsWith("finding="));
        return {
          state: "failed",
          checker: `${candidate} + odxtools`,
          findings,
          // The exit code says *that* the reference implementation disagreed; its own
          // findings say *what* it disagreed about, and a reason without them would
          // send the reader into the raw output for the one interesting sentence.
          reason: [
            `the reference implementation rejected the document (exit ${run.status})`,
            ...stated,
          ].join(" — "),
          output,
        };
      }
      const failed = findings.filter(
        (line) => line.includes("=ERROR") || line.startsWith("finding="),
      );
      return {
        state: failed.length > 0 ? "failed" : "verified",
        checker: `${candidate} + ${findings.find((line) => line.startsWith("odxtools="))?.slice("odxtools=".length) ?? "odxtools"}`,
        findings,
        ...(failed.length > 0 ? { reason: failed.join("; ") } : {}),
        output,
      };
    }
    return { state: "not-run", findings: [], reason: lastError };
  } catch (error) {
    return {
      state: "not-run",
      findings: [],
      reason: `the cross-check could not be prepared: ${messageOf(error)}`,
    };
  } finally {
    if (directory !== null) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch (error) {
        // A temporary directory that cannot be removed is worth one debug line and
        // nothing more — the verification result is already decided (AGENTS 34.25).
        process.stderr.write(`odx cross-check: temporary directory kept (${messageOf(error)})\n`);
      }
    }
  }
}

/** The `key=value` lines of the checker, in order, without the empty ones. */
export function parseCheckerOutput(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.includes("="));
}

/**
 * The counts a report prints: services that encoded, services that decoded, DTCs.
 *
 * Returned as data instead of prose so a test can assert on the numbers and a
 * report can print them next to the harvest counts.
 */
export function verificationCounts(verification: OdxVerification): {
  variants: number;
  services: number;
  dtcs: number;
  encodeOk: number;
  decodeOk: number;
  mismatch: number;
} {
  const value = (key: string): number => {
    const line = verification.findings.find((entry) => entry.startsWith(`${key}=`));
    const parsed =
      line === undefined ? Number.NaN : Number.parseInt(line.slice(key.length + 1), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    variants: value("variants"),
    services: value("services"),
    dtcs: value("dtcs"),
    encodeOk: value("encode_ok"),
    decodeOk: value("decode_ok"),
    mismatch: value("mismatch"),
  };
}
