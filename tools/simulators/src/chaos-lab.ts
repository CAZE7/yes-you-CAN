/**
 * Chaos Laboratory & Fault Injection Engine (Task 4; AGENTS 9, 29).
 *
 * Provides targeted chaos injection across the full diagnostic stack:
 * - CAN layer: Frame drops, burst loss, bit flips, frame corruption
 * - ISO-TP layer: Sequence number faults (out of order, invalid SN),
 *   flow control overflow (OVFLW), invalid flow status (FS 3..15)
 * - UDS / Timing layer: P2/P2* timeout, NRC 0x78 pending loops, truncated responses
 * - Write path chaos: Mid-write connection drop, verification readback corruption, session reset
 *
 * Proves that the platform fails closed (AGENTS 26) without data corruption or safety breaches.
 */

import type {
  AdapterCapabilities,
  AdapterInfo,
  CanBus,
  CanFilter,
  CanFrame,
  FrameListener,
} from "@vdp/transport-can";
import { frameMatchesFilters } from "@vdp/transport-can";
import type { VirtualCanBus } from "./virtual-can.js";

/** Types of chaos injected at the CAN bus level. */
export type CanChaosRule =
  /** Drops all frames where predicate returns true. */
  | { kind: "drop-predicate"; match: (frame: CanFrame) => boolean }
  /**
   * Drops N frames. With `id` only frames carrying that arbitration id; without it
   * the next N frames of this bus, whatever they address. The second form is what a
   * "drop a burst of N frames" switch on a whole connection means: aimed at one id,
   * the burst silently takes nothing on a vehicle that does not talk on that id
   * (AGENTS 0.E → docs/architecture/backlog.md E24 measured exactly that silence).
   */
  | { kind: "drop-count"; id?: number; count: number }
  /** Corrupts payload of matching frames. */
  | { kind: "corrupt-payload"; id: number; modifier: (data: Uint8Array) => Uint8Array }
  /** Delays matching frames by ms. */
  | { kind: "delay"; id: number; delayMs: number };

/**
 * A proxy wrapping a CanBus that injects CAN-level chaos.
 */
export class CanChaosBus implements CanBus {
  private readonly rules: CanChaosRule[] = [];
  private readonly droppedFrames: CanFrame[] = [];
  private corruptedFrameCount = 0;
  private delayedFrameCount = 0;
  private readonly listeners: Array<{
    listener: FrameListener;
    filters?: readonly CanFilter[];
  }> = [];
  private readonly innerBus: CanBus;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(
    innerBus: CanBus,
    options: { sleep?: (ms: number) => Promise<void>; random?: () => number } = {},
  ) {
    this.innerBus = innerBus;
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;

    // Forward received frames from inner bus through chaos filter
    this.innerBus.subscribe((frame) => {
      this.processIncoming(frame);
    });
  }

  get info(): AdapterInfo {
    return this.innerBus.info;
  }

  get capabilities(): AdapterCapabilities {
    return this.innerBus.capabilities;
  }

  get dropped(): readonly CanFrame[] {
    return this.droppedFrames;
  }

  get corruptedCount(): number {
    return this.corruptedFrameCount;
  }

  get delayedCount(): number {
    return this.delayedFrameCount;
  }

  get remainingBurstDrops(): number {
    let count = 0;
    for (const rule of this.rules) {
      if (rule.kind === "drop-count") count += rule.count;
    }
    return count;
  }

  addRule(rule: CanChaosRule): void {
    this.rules.push(rule);
  }

  injectDropRate(rate: number): void {
    const random = this.random;
    this.rules.push({
      kind: "drop-predicate",
      match: () => random() < rate,
    });
  }

  clearRules(): void {
    this.rules.length = 0;
  }

  async open(): Promise<void> {
    await this.innerBus.open();
  }

  async close(): Promise<void> {
    await this.innerBus.close();
  }

  isOpen(): boolean {
    return this.innerBus.isOpen();
  }

  async send(frame: CanFrame): Promise<void> {
    // Check if outgoing frame should be dropped or modified
    let frameToSend = frame;
    for (const rule of this.rules) {
      if (rule.kind === "drop-predicate" && rule.match(frame)) {
        this.droppedFrames.push(frame);
        return; // Dropped on send
      }
      if (
        rule.kind === "drop-count" &&
        (rule.id === undefined || rule.id === frame.id) &&
        rule.count > 0
      ) {
        rule.count--;
        this.droppedFrames.push(frame);
        return; // Dropped on send
      }
      if (rule.kind === "corrupt-payload" && rule.id === frame.id) {
        this.corruptedFrameCount++;
        frameToSend = { ...frameToSend, payload: rule.modifier(frameToSend.payload) };
      }
    }
    await this.innerBus.send(frameToSend);
  }

  subscribe(listener: FrameListener, filters?: readonly CanFilter[]): () => void {
    const entry = { listener, ...(filters !== undefined ? { filters } : {}) };
    this.listeners.push(entry);
    return () => {
      const idx = this.listeners.indexOf(entry);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  private processIncoming(frame: CanFrame): void {
    let frameToDeliver = frame;
    for (const rule of this.rules) {
      if (rule.kind === "drop-predicate" && rule.match(frame)) {
        this.droppedFrames.push(frame);
        return;
      }
      if (
        rule.kind === "drop-count" &&
        (rule.id === undefined || rule.id === frame.id) &&
        rule.count > 0
      ) {
        rule.count--;
        this.droppedFrames.push(frame);
        return;
      }
      if (rule.kind === "corrupt-payload" && rule.id === frame.id) {
        this.corruptedFrameCount++;
        frameToDeliver = { ...frameToDeliver, payload: rule.modifier(frameToDeliver.payload) };
      }
      if (rule.kind === "delay" && rule.id === frame.id) {
        this.delayedFrameCount++;
        void this.sleep(rule.delayMs).then(() => {
          this.emit(frameToDeliver);
        });
        return;
      }
    }
    this.emit(frameToDeliver);
  }

  private emit(frame: CanFrame): void {
    // The filters a subscriber passed are part of its contract; a chaos proxy that
    // stores them and ignores them hands the caller frames it asked not to see.
    for (const entry of this.listeners) {
      if (entry.filters !== undefined && !frameMatchesFilters(frame, entry.filters)) continue;
      entry.listener(frame);
    }
  }
}

/** Pre-configured chaos scenarios for validation. */
export const ChaosLab = {
  /**
   * Creates a CAN chaos bus on the virtual network.
   */
  wrapCanBus(
    bus: VirtualCanBus,
    options: { sleep?: (ms: number) => Promise<void> } = {},
  ): CanChaosBus {
    return new CanChaosBus(bus, options);
  },

  /**
   * Configures ISO-TP Consecutive Frame (CF) sequence number corruption.
   * Modifies the PCI byte of consecutive frames to simulate out-of-order delivery.
   */
  injectIsoTpSequenceCorruption(bus: CanChaosBus, ecuTxId: number): void {
    bus.addRule({
      kind: "corrupt-payload",
      id: ecuTxId,
      modifier: (data: Uint8Array) => {
        // ISO-TP CF PCI is 0x20..0x2F (nibble 0x2 with sequence number)
        if (data.length > 0 && ((data[0] ?? 0) & 0xf0) === 0x20) {
          const corrupted = new Uint8Array(data);
          // Jump sequence number by +3 to guarantee a sequence error
          const currentSn = (data[0] ?? 0) & 0x0f;
          const badSn = (currentSn + 3) & 0x0f;
          corrupted[0] = 0x20 | badSn;
          return corrupted;
        }
        return data;
      },
    });
  },

  /**
   * Configures ISO-TP Flow Control Overflow (OVFLW) frame.
   * Intercepts FC frame and sets Flow Status to 2 (Overflow).
   */
  injectIsoTpFlowControlOverflow(bus: CanChaosBus, testerTxId: number): void {
    bus.addRule({
      kind: "corrupt-payload",
      id: testerTxId,
      modifier: (data: Uint8Array) => {
        // ISO-TP FC PCI is 0x30 (Flow Status: 0=CTS, 1=WAIT, 2=OVFLW)
        if (data.length > 0 && ((data[0] ?? 0) & 0xf0) === 0x30) {
          const corrupted = new Uint8Array(data);
          corrupted[0] = 0x32; // Flow Status = 2 (OVFLW)
          return corrupted;
        }
        return data;
      },
    });
  },

  /**
   * Configures burst loss: drops the next N frames, on one arbitration ID when an id
   * is given and on the whole bus when it is not (`canId: undefined`).
   */
  injectBurstFrameDrop(bus: CanChaosBus, canId: number | undefined, dropCount: number): void {
    bus.addRule({
      kind: "drop-count",
      // No `id: undefined` in the object: `exactOptionalPropertyTypes` distinguishes
      // "field absent" from "field undefined", and the bus-wide form is the absence.
      ...(canId === undefined ? {} : { id: canId }),
      count: dropCount,
    });
  },

  /**
   * Configures probabilistic drop rate (0.0 to 1.0).
   */
  injectDropRate(bus: CanChaosBus, dropRate: number): void {
    bus.injectDropRate(dropRate);
  },
};
