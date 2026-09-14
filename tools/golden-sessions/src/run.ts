/**
 * Running a golden session (master backlog P0 #10).
 *
 * The run is the *whole* pipeline against a recorded wire: replay transport, real
 * ISO-TP, real UDS client, real definitions, the same connect options the recorder
 * used. Nothing is stubbed, because the questions a golden session answers are
 * exactly the ones a stub would answer wrongly:
 *
 *   - does the same request still get the same answer off the same frames?
 *   - does the discovery still find the same ECUs?
 *   - does the decoding still produce the same fault codes and values?
 *
 * The result is a list of named checks — never a boolean. A failing golden session
 * has to say *what* it compared and what it found instead, otherwise the first
 * person to look at it has to re-run the whole thing by hand.
 */

import { type ConnectDiscoveryOptions, type DecodedSignal, DiagnosticEngine } from "@vdp/core";
import type { DefinitionPackage } from "@vdp/definitions";
import {
  type DtcObservation,
  type EcuObservation,
  type SessionObservation,
  compareDtcObservations,
  dtcObservation,
  ecuObservation,
  sessionObservation,
} from "@vdp/diagnostic-ir";
import type { Logger } from "@vdp/shared";
import { ReplayTransport, recordingFromSessionJson } from "@vdp/transport-can";
import { resolveStableEcuId, stableEcuId } from "./ecu-identity.js";
import type {
  GoldenCheck,
  GoldenRunResult,
  GoldenSession,
  GoldenSignalExpectation,
} from "./format.js";
import { GOLDEN_CONNECT_OPTIONS } from "./record.js";

export interface RunGoldenOptions {
  definitions: DefinitionPackage;
  logger?: Logger;
  connect?: ConnectDiscoveryOptions;
  /** Report a replay that had to answer outside the recording (default: yes). */
  strictReplay?: boolean;
}

const NUMBER_TOLERANCE = 1e-9;

function compare(name: string, expected: string, actual: string): GoldenCheck {
  return { name, ok: expected === actual, expected, actual };
}

function hexByte(value: number): string {
  return `0x${value.toString(16).padStart(2, "0").toUpperCase()}`;
}

function matches(expectation: GoldenSignalExpectation, signal: DecodedSignal): boolean {
  if (expectation.equal !== undefined) {
    if (typeof expectation.equal === "number" && typeof signal.value === "number") {
      return Math.abs(expectation.equal - signal.value) <= NUMBER_TOLERANCE;
    }
    return expectation.equal === signal.value;
  }
  if (typeof signal.value !== "number") return false;
  if (expectation.min !== undefined && signal.value < expectation.min - NUMBER_TOLERANCE)
    return false;
  if (expectation.max !== undefined && signal.value > expectation.max + NUMBER_TOLERANCE)
    return false;
  return true;
}

function describeValue(value: unknown): string {
  if (value instanceof Uint8Array) return `[${value.length} bytes]`;
  return JSON.stringify(value) ?? String(value);
}

function checkSignals(
  expectations: readonly GoldenSignalExpectation[],
  signals: readonly DecodedSignal[],
): GoldenCheck[] {
  const checks: GoldenCheck[] = [];
  for (const expectation of expectations) {
    const name = `signal ${expectation.signal}${expectation.ecu ? `@${expectation.ecu}` : ""}`;
    const candidates = signals.filter(
      (signal) =>
        signal.signalId === expectation.signal &&
        (expectation.ecu === undefined || signal.ecu === expectation.ecu),
    );
    const wanted =
      expectation.equal !== undefined
        ? `= ${describeValue(expectation.equal)}`
        : `${expectation.min ?? "-inf"} … ${expectation.max ?? "+inf"}`;
    if (candidates.length === 0) {
      checks.push({
        name,
        ok: false,
        expected: wanted,
        actual: "no value in the recording — the replay produced no sample for it",
      });
      continue;
    }
    const wrong = candidates.filter((signal) => !matches(expectation, signal));
    const minSamples = expectation.minSamples ?? 1;
    if (wrong.length > 0) {
      checks.push({
        name,
        ok: false,
        expected: wanted,
        actual: `${wrong.length}/${candidates.length} samples outside it, e.g. ${describeValue(wrong[0]?.value)}`,
      });
      continue;
    }
    if (candidates.length < minSamples) {
      checks.push({
        name,
        ok: false,
        expected: `at least ${minSamples} sample(s)`,
        actual: `${candidates.length} sample(s)`,
      });
      continue;
    }
    checks.push({
      name,
      ok: true,
      expected: wanted,
      actual: `${candidates.length} sample(s) matched`,
    });
  }
  return checks;
}

/**
 * Compare the fault memory the recording reports with the expected one.
 *
 * The comparison runs through the IR (`compareDtcObservations`, P0 #6): an
 * expectation is an observation, the scan is an observation, and the difference
 * names what changed — codes that appeared, codes that are gone, codes whose
 * status byte moved. A clear that silently lost a code and a code that comes back
 * with a different status are not the same defect.
 */
function checkDtcs(session: GoldenSession, observed: readonly DtcObservation[]): GoldenCheck[] {
  const expected: DtcObservation[] = session.expectations.dtcs.map((dtc) =>
    dtcObservation({
      code: dtc.code,
      raw: dtc.code,
      failureType: "",
      status: dtc.status ?? 0,
      statusBits: {
        testFailed: false,
        testFailedThisOperationCycle: false,
        pendingDtc: false,
        confirmedDtc: false,
        testNotCompletedSinceLastClear: false,
        testFailedSinceLastClear: false,
        testNotCompletedThisOperationCycle: false,
        warningIndicatorRequested: false,
      },
      ecuId: dtc.ecu,
      ecuName: dtc.ecu,
      at: session.provenance.recordedAt,
    }),
  );
  const key = (dtc: DtcObservation): string => `${dtc.ecuId}:${dtc.code}`;
  const observedByKey = new Map(observed.map((dtc) => [key(dtc), dtc]));
  const names = (list: readonly DtcObservation[]): string =>
    [...list.map(key)].sort().join(", ") || "(none)";

  const checks: GoldenCheck[] = [
    compare("fault memory: codes present", names(expected), names(observed)),
  ];
  const comparison = compareDtcObservations(expected, observed);
  for (const changed of comparison.changed) {
    const before = expected.find((dtc) => key(dtc) === key(changed));
    if (!before) continue;
    const declared = session.expectations.dtcs.find(
      (dtc) => `${dtc.ecu}:${dtc.code}` === key(changed),
    );
    if (declared?.status === null) continue;
    checks.push(
      compare(
        `fault memory: status of ${key(changed)}`,
        hexByte(before.status),
        hexByte(observedByKey.get(key(changed))?.status ?? changed.status),
      ),
    );
  }
  return checks;
}

function checkEcus(session: GoldenSession, observed: readonly string[]): GoldenCheck[] {
  const expected = session.expectations.ecus
    .filter((ecu) => ecu.unreachable !== true)
    .map((ecu) => `${ecu.ecu}@0x${ecu.rxId.toString(16)}`)
    .sort();
  const actual = [...observed].sort();
  const checks = [
    compare("discovery: which ECUs answered", expected.join(", "), actual.join(", ")),
  ];
  for (const ecu of session.expectations.ecus.filter((entry) => entry.unreachable === true)) {
    const wanted = `no handle for 0x${ecu.rxId.toString(16)}`;
    checks.push(
      compare(
        `discovery: ${ecu.ecu} stays unreachable`,
        wanted,
        actual.includes(`${ecu.ecu}@0x${ecu.rxId.toString(16)}`) ? "a handle exists" : wanted,
      ),
    );
  }
  return checks;
}

/** Run one golden session and report every comparison it made. */
export async function runGoldenSession(
  session: GoldenSession,
  options: RunGoldenOptions,
): Promise<GoldenRunResult> {
  const logger = options.logger;
  const bus = new ReplayTransport(recordingFromSessionJson(JSON.stringify(session.recording)), {
    ...(logger ? { logger } : {}),
    // A recorded session carries its pacing, and the pacing is part of the answer:
    // an ECU that sends "response pending" and then the real response 30 ms later
    // cannot be replayed as one burst without losing the second message.
    pace: true,
  });
  await bus.open();

  const engine = new DiagnosticEngine({
    ...(logger ? { logger } : {}),
    bus,
    definitions: [options.definitions],
  });

  try {
    await engine.connect(options.connect ?? GOLDEN_CONNECT_OPTIONS);
    const identity = await engine.detectVehicleIdentity();
    const signals = await engine.snapshotSignals();
    const scanned = await engine.scanDtcs();

    const at = session.provenance.recordedAt;
    const version = session.provenance.definitions.version;
    const ecuObservations: EcuObservation[] = engine.ecuHandles.map((handle) => {
      const record = handle.session.record;
      return ecuObservation({
        // Stable identity: a per-run `ecu_…` id would make the expectation fail on
        // every second run (see ecu-identity.ts).
        ecuId: stableEcuId(record),
        name: record.name,
        ...(record.definitionEcuId !== undefined
          ? { definitionEcuId: record.definitionEcuId }
          : {}),
        protocol: record.protocol,
        txId: handle.discovered.txId,
        rxId: handle.discovered.rxId,
        extended: handle.discovered.extended,
        reachable: record.reachable,
        sessionType: record.sessionType,
        p2Ms: record.timing.p2Ms,
        p2StarMs: record.timing.p2StarMs,
        supportedServices: record.supportedServices,
        identification: record.identification.map((entry) => ({
          label: entry.label,
          value: entry.value,
          ...(entry.did !== undefined ? { did: entry.did } : {}),
        })),
        ...(record.lastError !== undefined ? { lastError: record.lastError } : {}),
        at,
      });
    });

    const dtcObservations: DtcObservation[] = scanned.flatMap((entry) =>
      entry.dtcs.map((dtc) =>
        dtcObservation({
          code: dtc.code,
          raw: dtc.raw,
          failureType: dtc.failureType,
          status: dtc.status,
          statusBits: dtc.statusBits,
          ecuId: resolveStableEcuId(engine.ecuHandles, dtc.ecuId),
          ecuName: dtc.ecuName,
          at,
          definitionVersion: version,
          ...(dtc.snapshot !== undefined ? { snapshot: dtc.snapshot } : {}),
        }),
      ),
    );

    const checks: GoldenCheck[] = [];
    checks.push(
      ...checkEcus(
        session,
        ecuObservations.map((ecu) => `${ecu.ecuId}@0x${ecu.rxId.toString(16)}`),
      ),
    );

    const expectedIdentity = session.expectations.identity;
    // A redacted recording cannot reproduce what the VIN analysis read out of the
    // number itself. Those checks are reported as skipped with the reason — never
    // silently dropped and never failed for a privacy decision.
    const fromVin = new Set(expectedIdentity?.vinDerived ?? []);
    const skipReason = "derived from the VIN analysis — a redacted recording cannot reproduce it";
    const optionalCheck = (field: "manufacturer" | "model" | "modelYear"): GoldenCheck => {
      const wanted = expectedIdentity?.[field];
      const actual = identity?.[field];
      const label = field === "modelYear" ? "model year" : field;
      if (actual === undefined && fromVin.has(field)) {
        return {
          name: `identity: ${label}`,
          ok: true,
          skipped: true,
          expected: String(wanted),
          actual: skipReason,
        };
      }
      return compare(`identity: ${label}`, String(wanted), String(actual ?? "(not read)"));
    };
    if (expectedIdentity) {
      checks.push(compare("identity: VIN", expectedIdentity.vin, identity?.vin ?? "(not read)"));
      if (expectedIdentity.manufacturer !== undefined) checks.push(optionalCheck("manufacturer"));
      if (expectedIdentity.model !== undefined) checks.push(optionalCheck("model"));
      if (expectedIdentity.modelYear !== undefined) checks.push(optionalCheck("modelYear"));
    }

    checks.push(...checkDtcs(session, dtcObservations));
    checks.push(...checkSignals(session.expectations.signals, signals));

    if (options.strictReplay !== false) {
      const deviations = bus.deviations;
      checks.push(
        deviations.length === 0
          ? {
              name: "replay: every request came from the recording",
              ok: true,
              expected: "0 deviations",
              actual: "0 deviations",
            }
          : {
              name: "replay: every request came from the recording",
              ok: false,
              expected: "0 deviations",
              actual: `${deviations.length}: ${deviations
                .slice(0, 3)
                .map((entry) => `${entry.kind}@0x${entry.canId.toString(16)}`)
                .join(", ")}`,
            },
      );
    }

    const sessionObservationValue: SessionObservation = sessionObservation({
      sessionId: session.id,
      adapter: { kind: "replay", channels: [session.provenance.adapter] },
      transport: { kind: "replay", channel: session.provenance.adapter },
      startedAt: at,
      endedAt: at,
      ecus: ecuObservations,
    });

    return {
      sessionId: session.id,
      ok: checks.every((check) => check.ok),
      checks,
      sessionObservation: sessionObservationValue,
      dtcObservations,
    };
  } finally {
    await engine.disconnect();
    await bus.close();
  }
}
