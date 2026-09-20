/**
 * Chaos on the session bus (0.E E24).
 *
 * One wrapper, one place: `start()` installs this around the opened bus so the
 * runtime, the raw trace and the switches see the same object. A switch thrown
 * before a connection is a refusal, not a silent counter (ADR 0018).
 */

import { TransportClosedError } from "@vdp/shared";
import { CanChaosBus, ChaosLab } from "@vdp/simulators";
import type { CanBus } from "@vdp/transport-can";
import { formatCanId } from "./trace-view.js";
import type { ChaosStatusView } from "./views.js";

export class ChaosSession {
  private bus: CanChaosBus | undefined;
  private dropRate = 0;
  private dropBurst = 0;
  private dropBurstCanId: number | undefined;
  private adapterId = "none";

  wrap(inner: CanBus, adapterId: string): CanChaosBus {
    this.adapterId = adapterId;
    this.bus = new CanChaosBus(inner);
    return this.bus;
  }

  inject(options: {
    dropBurst?: number;
    dropBurstCanId?: number;
    dropRate?: number;
    corruptSequenceCanId?: number;
  }): void {
    const chaosBus = this.bus;
    if (!chaosBus) {
      throw new TransportClosedError(
        "chaos needs an open connection — start the vehicle first, the switches act on the live bus",
        { adapter: this.adapterId },
      );
    }
    if (options.dropBurst !== undefined) {
      this.dropBurst = options.dropBurst;
      this.dropBurstCanId = options.dropBurstCanId;
      ChaosLab.injectBurstFrameDrop(chaosBus, options.dropBurstCanId, options.dropBurst);
    }
    if (options.dropRate !== undefined) {
      this.dropRate = options.dropRate;
      ChaosLab.injectDropRate(chaosBus, options.dropRate);
    }
    if (options.corruptSequenceCanId !== undefined) {
      ChaosLab.injectIsoTpSequenceCorruption(chaosBus, options.corruptSequenceCanId);
    }
  }

  reset(): void {
    this.bus?.clearRules();
    this.dropRate = 0;
    this.dropBurst = 0;
    this.dropBurstCanId = undefined;
  }

  dispose(): void {
    this.reset();
    this.bus = undefined;
  }

  status(): ChaosStatusView {
    const burstRemaining = this.bus?.remainingBurstDrops ?? 0;
    const isActuallyActive = this.bus !== undefined && (this.dropRate > 0 || burstRemaining > 0);
    return {
      active: isActuallyActive,
      dropRate: this.dropRate,
      dropBurstRemaining: burstRemaining,
      dropBurstTarget: this.dropBurstCanId === undefined ? null : formatCanId(this.dropBurstCanId),
      dropBurstScope:
        this.dropBurst <= 0 ? "none" : this.dropBurstCanId === undefined ? "bus-wide" : "targeted",
      droppedFrames: this.bus?.dropped.length ?? 0,
      corruptedFrames: this.bus?.corruptedCount ?? 0,
      delayedFrames: this.bus?.delayedCount ?? 0,
    };
  }
}
