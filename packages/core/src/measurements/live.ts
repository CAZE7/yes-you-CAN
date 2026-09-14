/**
 * Parallel live data acquisition (AGENTS 15).
 *
 * Concurrency rule made explicit, as AGENTS 15 demands:
 *  - requests towards ONE ECU are serialised (UDS allows no parallel requests on
 *    the same session),
 *  - several ECUs are polled concurrently, each on its own transport channel.
 *
 * Raw and decoded values are recorded separately (AGENTS 34.7).
 *
 * The decoder hands back a diagnostic IR observation (P0 #6): either a reading —
 * recorded as a sample — or a gap. Gaps are collected per round and counted, so a
 * live session reports "2 of 5 signals could not be observed, because …" instead
 * of simply producing fewer samples than somebody expected.
 */

import type { SignalDefinition } from "@vdp/definitions";
import { type SignalGap, type SignalObservation, signalGap } from "@vdp/diagnostic-ir";
import { type Logger, asError, createLogger, messageOf, toHex } from "@vdp/shared";
import type { DecodedSignal } from "./decoder.js";
import { toDecodedSignal } from "./decoder.js";
import type { MeasurementRecorder, MeasurementSample } from "./recorder.js";

export interface EcuReader {
  readonly ecuId: string;
  /** Read the raw payload of one DID. */
  readRaw(did: number): Promise<Uint8Array | null>;
}

export interface LiveDataOptions {
  /** Poll interval per ECU in ms. */
  intervalMs?: number;
  logger?: Logger;
  clock?: () => number;
  /** Stop after N poll rounds — used by tests and bounded recordings. */
  maxRounds?: number;
}

export interface PollRoundResult {
  ecuId: string;
  round: number;
  at: number;
  signals: DecodedSignal[];
  /**
   * Signals of this round that could not be observed, each with its reason
   * (`errors` stays the DID-level view of the same failures).
   */
  gaps: SignalGap[];
  /**
   * The samples the recorder stored for this round — same order as
   * {@link signals}. Listeners stream these instead of recording a second
   * time (AGENTS 16/34.25: exactly one sample per signal per round).
   */
  samples: MeasurementSample[];
  errors: Array<{ did: number; message: string }>;
}

export interface LiveDataStats {
  rounds: number;
  samples: number;
  errors: number;
  /** Signals that could not be observed across all rounds (P0 #6). */
  gaps: number;
  averageRoundMs: number;
}

export class LiveDataEngine {
  private readonly intervalMs: number;
  private readonly log: Logger;
  private readonly clock: () => number;
  private readonly maxRounds: number | undefined;
  private running = false;
  private stopRequested = false;
  private readonly stats: LiveDataStats = {
    rounds: 0,
    samples: 0,
    errors: 0,
    gaps: 0,
    averageRoundMs: 0,
  };
  private roundDurations: number[] = [];
  private listeners: Array<(result: PollRoundResult) => void> = [];
  private errorListeners: Array<(error: Error) => void> = [];

  constructor(
    private readonly decode: (signal: SignalDefinition, payload: Uint8Array) => SignalObservation,
    private readonly recorder: MeasurementRecorder,
    options: LiveDataOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 100;
    this.log = (options.logger ?? createLogger("decoder", { level: "INFO" })).child("decoder");
    this.clock = options.clock ?? (() => Date.now());
    this.maxRounds = options.maxRounds;
  }

  onRound(listener: (result: PollRoundResult) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /**
   * Subscribe to a crash of the poll loop. Per-DID failures are collected in
   * the round's `errors`; this hook fires only when the loop itself breaks —
   * the case a UI must not learn about from silence alone (AGENTS 34.25).
   */
  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.push(listener);
    return () => {
      this.errorListeners = this.errorListeners.filter((l) => l !== listener);
    };
  }

  get statistics(): LiveDataStats {
    return { ...this.stats };
  }

  get isRunning(): boolean {
    return this.running;
  }

  stop(): void {
    this.stopRequested = true;
  }

  /**
   * Poll the given ECUs until `stop()` is called or `maxRounds` is reached.
   * Each ECU runs its own serialised loop; ECUs run in parallel.
   */
  async run(
    readers: readonly EcuReader[],
    plan: Map<string, readonly SignalDefinition[]>,
  ): Promise<LiveDataStats> {
    if (this.running) throw new Error("live data engine is already running");
    this.running = true;
    this.stopRequested = false;
    this.log.info("live data started", { ecus: readers.length, intervalMs: this.intervalMs });

    try {
      return await this.pollUntilStopped(readers, plan);
    } catch (error) {
      this.running = false;
      const failure = asError(error);
      for (const listener of this.errorListeners) listener(failure);
      throw failure;
    }
  }

  private async pollUntilStopped(
    readers: readonly EcuReader[],
    plan: Map<string, readonly SignalDefinition[]>,
  ): Promise<LiveDataStats> {
    let round = 0;
    const activeReaders = readers.filter((r) => (plan.get(r.ecuId)?.length ?? 0) > 0);
    while (!this.stopRequested && (this.maxRounds === undefined || round < this.maxRounds)) {
      const roundStarted = this.clock();
      round++;
      const results = await Promise.all(
        activeReaders.map((reader) => this.pollEcu(reader, plan.get(reader.ecuId) ?? [], round)),
      );
      for (const result of results) {
        for (const listener of this.listeners) listener(result);
      }
      this.stats.rounds = round;
      const duration = this.clock() - roundStarted;
      this.roundDurations.push(duration);
      this.stats.averageRoundMs =
        this.roundDurations.reduce((a, b) => a + b, 0) / this.roundDurations.length;

      if (this.stopRequested || (this.maxRounds !== undefined && round >= this.maxRounds)) break;
      await sleep(Math.max(0, this.intervalMs - duration));
    }
    this.running = false;
    this.log.info("live data stopped", { ...this.stats });
    return { ...this.stats };
  }

  /** One serialised poll round for a single ECU. */
  private async pollEcu(
    reader: EcuReader,
    signals: readonly SignalDefinition[],
    round: number,
  ): Promise<PollRoundResult> {
    const at = this.clock();
    const result: PollRoundResult = {
      ecuId: reader.ecuId,
      round,
      at,
      signals: [],
      gaps: [],
      samples: [],
      errors: [],
    };
    // Group by DID so one 0x22 request feeds all signals that share it.
    const dids = Array.from(new Set(signals.map((s) => s.did)));
    for (const did of dids) {
      try {
        const payload = await reader.readRaw(did);
        if (!payload) {
          result.errors.push({ did, message: "no data returned" });
          this.stats.errors++;
          // The whole DID is missing: every signal it feeds is a gap, named at
          // the signal level as well — "no data returned" alone does not say
          // which measured value is missing (P0 #6).
          for (const signal of signals.filter((s) => s.did === did)) {
            result.gaps.push(
              signalGap({
                signalId: signal.id,
                name: signal.name,
                ecuId: reader.ecuId,
                did,
                reason: `no data returned for DID 0x${did.toString(16).toUpperCase()}`,
              }),
            );
            this.stats.gaps++;
          }
          continue;
        }
        const timestamp = this.clock();
        for (const signal of signals.filter((s) => s.did === did)) {
          const observation = this.decode(signal, payload);
          if (observation.kind === "signal-gap") {
            result.gaps.push(observation);
            this.stats.gaps++;
            continue;
          }
          const decoded = toDecodedSignal(observation);
          result.samples.push(this.recorder.record(decoded, timestamp));
          this.stats.samples++;
          result.signals.push(decoded);
        }
        this.log.trace("polled DID", {
          ecu: reader.ecuId,
          did: `0x${did.toString(16)}`,
          raw: toHex(payload),
        });
      } catch (error) {
        const message = messageOf(error);
        result.errors.push({ did, message });
        this.stats.errors++;
        this.log.warn("poll failed", {
          ecu: reader.ecuId,
          did: `0x${did.toString(16)}`,
          error: message,
        });
      }
    }
    return result;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
