/**
 * Recording a golden session (master backlog P0 #10).
 *
 * The recorder drives one session against the simulator, records the wire both
 * directions, redacts the VIN and derives the *expectations* from what it saw.
 *
 * Deriving them instead of writing them by hand is what makes the format usable:
 * the expectation is a photograph of today's behaviour, and the value of the
 * fixture is that any later change has to be an explicit, reviewable edit of that
 * photograph. A recipe is code (which vehicle, which fault memory, which defect),
 * the recording is data — the same split the definitions use.
 */

import {
  type ConnectDiscoveryOptions,
  createIdentityFromVin,
  type DecodedSignal,
  DiagnosticEngine,
  SessionLogger,
} from "@vdp/core";
import type { DefinitionPackage } from "@vdp/definitions";
import type { Logger } from "@vdp/shared";
import { VirtualVehicle, type VirtualVehicleOptions } from "@vdp/simulators";
import { stableEcuId } from "./ecu-identity.js";
import {
  GOLDEN_FORMAT,
  GOLDEN_FORMAT_VERSION,
  type GoldenDtcExpectation,
  type GoldenEcuExpectation,
  type GoldenRecording,
  type GoldenSession,
  type GoldenSignalExpectation,
  type GoldenSource,
  VIN_PLACEHOLDER,
} from "./format.js";
import { assertGoldenRedacted, redactGoldenSession } from "./redact.js";

/** Connect options every golden run uses — the recording and the replay must agree. */
export const GOLDEN_CONNECT_OPTIONS: ConnectDiscoveryOptions = { windowMs: 60, probeDelayMs: 0 };

export interface GoldenRecipe {
  /** File name without extension, e.g. `generic-stored-dtcs`. */
  id: string;
  title: string;
  /** What this recording is meant to preserve. */
  note?: string;
  /** Simulator setup: VIN, fault memory, defect injection. */
  vehicle: VirtualVehicleOptions;
  /** Timestamp written into the file — fixed so re-recording is diff-free. */
  recordedAt: string;
}

export interface RecordGoldenOptions {
  recipe: GoldenRecipe;
  definitions: DefinitionPackage;
  definitionsName: string;
  definitionsVersion: string;
  source?: GoldenSource;
  adapter?: string;
  recordedBy?: string;
  logger?: Logger;
}

export interface RecordedGolden {
  session: GoldenSession;
  /** What the live run produced, for the caller's log line. */
  observed: {
    vin: string | null;
    ecus: number;
    dtcs: number;
    signals: number;
    frames: number;
  };
}

function asExpectationValue(value: number | string | boolean): number | string | boolean {
  return typeof value === "number" ? Number(value.toFixed(6)) : value;
}

/** One expectation per (ecu, signal); equal when the recording is deterministic. */
export function signalExpectations(signals: readonly DecodedSignal[]): GoldenSignalExpectation[] {
  const byKey = new Map<string, DecodedSignal[]>();
  for (const signal of signals) {
    const key = `${signal.ecu}\u0000${signal.signalId}`;
    const list = byKey.get(key) ?? [];
    list.push(signal);
    byKey.set(key, list);
  }
  const expectations: GoldenSignalExpectation[] = [];
  for (const [, list] of [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const first = list[0];
    if (!first) continue;
    const expectation: GoldenSignalExpectation = { signal: first.signalId, ecu: first.ecu };
    const values = list.map((entry) => entry.value);
    const firstValue = values[0];
    const constant = values.every((value) => value === firstValue);
    if (constant && firstValue !== undefined && firstValue !== null) {
      expectation.equal = asExpectationValue(firstValue);
    } else {
      const numbers = values.filter((value): value is number => typeof value === "number");
      if (numbers.length === values.length && numbers.length > 0) {
        expectation.min = Number(Math.min(...numbers).toFixed(6));
        expectation.max = Number(Math.max(...numbers).toFixed(6));
      }
      // A non-constant signal is witnessed by its samples, not by a single value.
      expectation.minSamples = 1;
    }
    expectations.push(expectation);
  }
  return expectations;
}

/**
 * Record one session against the simulator and turn it into a golden file.
 *
 * The VIN of the run is redacted on the bytes, and the recorder refuses to hand
 * back a file that still contains it — a redaction that is only checked by a
 * reader can be forgotten by a writer.
 */
export async function recordGoldenSession(options: RecordGoldenOptions): Promise<RecordedGolden> {
  const logger = options.logger;
  // The recorder's own clock, advanced at fixed points below.
  //
  // Without it the vehicle reads the wall clock for every evolving signal
  // (`signalValue` derives elapsed seconds from it), so two recordings of the same
  // recipe differ by however fast the machine happened to be — measured before this
  // existed: `abs.wheel_speed` 40,76 → 40,78, `engine.rpm` 831,3 → 832, 44 value
  // lines drifting on an unchanged tree (ADR 0052).
  //
  // Stepped, not frozen: a frozen clock would pin every signal to its t=0 value and
  // the fixture would stop showing a car in motion. One step per phase keeps the
  // values inside a phase constant — which is what makes an `equal` expectation an
  // `equal` expectation instead of a range.
  const PHASE_MS = 50;
  let modelMs = 0;
  const modelClock = (): number => 1_700_000_000_000 + modelMs;
  const advancePhase = (): void => {
    modelMs += PHASE_MS;
  };

  const vehicle = new VirtualVehicle({
    definitions: options.definitions,
    ...(logger ? { logger } : {}),
    // Both directions have to be recorded, otherwise half the conversation — and
    // therefore half of the replay — is missing.
    networkOptions: { echoToSender: true },
    clock: modelClock,
    ...options.recipe.vehicle,
  });
  await vehicle.start();

  // A deterministic clock: the trace timestamps are relative to the session start
  // and must not change between two recordings of the same recipe.
  let tick = 0;
  const timestamp = (): number => {
    tick += 1;
    return 1_700_000_000_000 + tick;
  };
  const sessionLogger = new SessionLogger({ clock: timestamp });
  const unsubscribe = vehicle.testerBus.subscribe((frame) => sessionLogger.recordFrame(frame));

  const engine = new DiagnosticEngine({
    ...(logger ? { logger } : {}),
    bus: vehicle.testerBus,
    definitions: [options.definitions],
  });

  try {
    await engine.connect(GOLDEN_CONNECT_OPTIONS);
    advancePhase();
    const identity = await engine.detectVehicleIdentity();
    advancePhase();
    const signals = await engine.snapshotSignals();
    advancePhase();
    const { scanned } = await engine.scanDtcs();
    const { samples, markers } = engine.recorder.export();
    const { trace, log } = sessionLogger.snapshot();

    const rawVin = identity?.vin ?? options.recipe.vehicle.vin ?? null;
    const sessionJson = SessionLogger.toJson({
      meta: {
        sessionId: options.recipe.id,
        vin: rawVin,
        adapter: options.adapter ?? "virtual-can",
        definitions: `${options.definitionsName}@${options.definitionsVersion}`,
      },
      samples,
      markers,
      dtcs: [],
      trace,
      log,
    });

    const recording = JSON.parse(sessionJson) as GoldenRecording & { exportedAt?: string };
    recording.exportedAt = options.recipe.recordedAt;
    const vtrace = recording.trace;

    const ecus: GoldenEcuExpectation[] = engine.ecuHandles
      .map((handle) => ({
        ecu: stableEcuId(handle.session.record),
        rxId: handle.discovered.rxId,
      }))
      .sort((a, b) => a.rxId - b.rxId);

    const dtcs: GoldenDtcExpectation[] = scanned
      .flatMap((entry) =>
        entry.dtcs.map((dtc) => ({
          // Stable identity, never the generated session id — see ecu-identity.ts.
          ecu: stableEcuId(entry.ecu),
          code: dtc.code,
          status: dtc.status,
        })),
      )
      .sort((a, b) => `${a.ecu}:${a.code}`.localeCompare(`${b.ecu}:${b.code}`));

    // Which identity fields did the VIN analysis produce? Ask the same code that
    // produced them, with the placeholder: everything that differs cannot come back
    // from a redacted recording, and the runner has to say so instead of failing.
    const vinDerived = rawVin
      ? (["manufacturer", "model", "modelYear"] as const).filter((field) => {
          const redacted = createIdentityFromVin(VIN_PLACEHOLDER);
          const live = identity?.[field];
          const fromPlaceholder = redacted[field];
          return live !== undefined && String(live) !== String(fromPlaceholder);
        })
      : [];

    const draft: GoldenSession = {
      format: GOLDEN_FORMAT,
      formatVersion: GOLDEN_FORMAT_VERSION,
      id: options.recipe.id,
      title: options.recipe.title,
      provenance: {
        source: options.source ?? "simulator",
        recordedAt: options.recipe.recordedAt,
        recordedBy: options.recordedBy ?? "npm run golden:record",
        adapter: options.adapter ?? "virtual-can",
        definitions: { package: options.definitionsName, version: options.definitionsVersion },
        redaction: rawVin ? ["vin"] : [],
        ...(options.recipe.note ? { note: options.recipe.note } : {}),
      },
      expectations: {
        ecus,
        ...(identity
          ? {
              identity: {
                // The raw VIN goes in here on purpose: the redaction below turns it
                // into the placeholder, in the expectations *and* in the frames.
                vin: rawVin ?? "",
                ...(vinDerived.length > 0 ? { vinDerived } : {}),
                ...(identity.manufacturer !== undefined
                  ? { manufacturer: identity.manufacturer }
                  : {}),
                ...(identity.model !== undefined ? { model: identity.model } : {}),
                ...(identity.modelYear !== undefined ? { modelYear: identity.modelYear } : {}),
              },
            }
          : {}),
        dtcs,
        signals: signalExpectations(signals),
      },
      recording,
    };

    // Redaction happens once, on the finished session, and the file is only handed
    // back when the VIN is provably gone — from text, from hex and from the
    // reassembled ISO-TP messages.
    const session = rawVin ? redactGoldenSession(draft, rawVin) : draft;
    if (rawVin) assertGoldenRedacted(session, rawVin, options.recipe.id);

    return {
      session,
      observed: {
        vin: rawVin,
        ecus: ecus.length,
        dtcs: dtcs.length,
        signals: session.expectations.signals.length,
        frames: vtrace.length,
      },
    };
  } finally {
    unsubscribe();
    await engine.disconnect();
    await vehicle.stop();
  }
}
