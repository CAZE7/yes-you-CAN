/**
 * Time-Travel Replay Engine (Task 9; Master Backlog #44).
 *
 * Implements deterministic time travel over recorded CAN traces:
 * - Scrubbing to any millisecond timestamp `seekTo(t)`.
 * - Frame-by-frame forward / backward stepping.
 * - Dynamic playback speeds (0.25x, 0.5x, 1x, 2x, 5x, 10x).
 * - Bookmarking & jump-to-marker points.
 * - Emits as a virtual `CanBus` so the rest of the stack (UDS, Live Data, Measurements)
 *   can consume replayed frames as if connected to a vehicle.
 */

import type { Logger } from "@vdp/shared";
import { createLogger } from "@vdp/shared";
import type { CanBus, FrameListener } from "./bus.js";
import { type CanFilter, type CanFrame, createFrame, frameMatchesFilters } from "./frame.js";
import type { ReplayFrameEntry } from "./replay.js";
import type { AdapterCapabilities, AdapterInfo } from "./transport.js";

export interface TimeTravelBookmark {
  id: string;
  t: number;
  label: string;
  frameIndex: number;
}

export type TimeTravelStatus = "idle" | "playing" | "paused" | "completed";

export interface TimeTravelState {
  status: TimeTravelStatus;
  currentT: number;
  currentIndex: number;
  totalFrames: number;
  totalDurationMs: number;
  speed: number;
  bookmarks: readonly TimeTravelBookmark[];
}

export interface TimeTravelOptions {
  channel?: string;
  speed?: number;
  logger?: Logger;
}

export class TimeTravelCanBus implements CanBus {
  readonly info: AdapterInfo = {
    id: "time-travel-replay",
    kind: "replay",
    name: "Time-Travel CAN Replay",
    channels: ["replay0"],
  };

  readonly capabilities: AdapterCapabilities = {
    can: true,
    canFd: true,
    doip: false,
    isoTpOffload: false,
    channels: 1,
  };

  private readonly log: Logger;
  private readonly channel: string;
  private opened = false;
  private frames: ReplayFrameEntry[] = [];
  private currentIndex = 0;
  private currentT = 0;
  private status: TimeTravelStatus = "idle";
  private speed = 1.0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners: Array<{ listener: FrameListener; filters?: readonly CanFilter[] }> =
    [];
  private readonly stateListeners = new Set<(state: TimeTravelState) => void>();
  private readonly bookmarks: TimeTravelBookmark[] = [];

  constructor(options: TimeTravelOptions = {}) {
    this.log = options.logger ?? createLogger("time-travel", { level: "INFO" });
    this.channel = options.channel ?? "replay0";
    this.speed = options.speed ?? 1.0;
  }

  async open(): Promise<void> {
    this.opened = true;
  }

  async close(): Promise<void> {
    this.pause();
    this.opened = false;
  }

  isOpen(): boolean {
    return this.opened;
  }

  async send(_frame: CanFrame): Promise<void> {
    // In passive time-travel replay, external transmits are accepted or no-op
  }

  subscribe(listener: FrameListener, filters?: readonly CanFilter[]): () => void {
    const entry = filters !== undefined ? { listener, filters } : { listener };
    this.listeners.push(entry);
    return () => {
      const idx = this.listeners.indexOf(entry);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  onStateChange(listener: (state: TimeTravelState) => void): () => void {
    this.stateListeners.add(listener);
    try {
      listener(this.state());
    } catch (err) {
      this.log.debug("time-travel initial state listener threw", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  loadFrames(frames: readonly ReplayFrameEntry[]): void {
    this.pause();
    this.frames = [...frames].sort((a, b) => a.t - b.t);
    this.currentIndex = 0;
    this.currentT = this.frames[0]?.t ?? 0;
    this.status = this.frames.length > 0 ? "paused" : "idle";
    this.notifyState();
  }

  play(): void {
    if (this.frames.length === 0) return;
    if (this.currentIndex >= this.frames.length) {
      // Loop or restart from beginning if at the end
      this.currentIndex = 0;
      this.currentT = this.frames[0]?.t ?? 0;
    }
    this.status = "playing";
    this.notifyState();
    this.scheduleNextFrame();
  }

  pause(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.status === "playing") {
      this.status = "paused";
      this.notifyState();
    }
  }

  setSpeed(factor: number): void {
    if (factor <= 0) throw new Error("Replay speed factor must be positive");
    this.speed = factor;
    if (this.status === "playing") {
      // Reschedule next with new speed
      if (this.timer !== undefined) {
        clearTimeout(this.timer);
        this.timer = undefined;
      }
      this.scheduleNextFrame();
    }
    this.notifyState();
  }

  stepForward(): CanFrame | undefined {
    this.pause();
    if (this.currentIndex >= this.frames.length) {
      this.status = "completed";
      this.notifyState();
      return undefined;
    }

    const recorded = this.frames[this.currentIndex];
    if (!recorded) return undefined;

    this.currentIndex++;
    this.currentT = recorded.t;
    const frame = this.emitFrame(recorded);

    if (this.currentIndex >= this.frames.length) {
      this.status = "completed";
    } else {
      this.status = "paused";
    }
    this.notifyState();
    return frame;
  }

  stepBackward(): CanFrame | undefined {
    this.pause();
    if (this.currentIndex <= 0) {
      this.currentIndex = 0;
      this.currentT = this.frames[0]?.t ?? 0;
      this.notifyState();
      return undefined;
    }

    this.currentIndex--;
    const recorded = this.frames[this.currentIndex];
    if (!recorded) return undefined;

    this.currentT = recorded.t;
    const frame = this.emitFrame(recorded);
    this.status = "paused";
    this.notifyState();
    return frame;
  }

  seekTo(targetT: number): void {
    this.pause();
    if (this.frames.length === 0) return;

    // Find closest frame at or just before targetT
    let idx = 0;
    while (idx < this.frames.length && (this.frames[idx]?.t ?? 0) < targetT) {
      idx++;
    }

    this.currentIndex = Math.min(idx, this.frames.length);
    this.currentT = targetT;
    this.status = this.currentIndex >= this.frames.length ? "completed" : "paused";
    this.notifyState();
  }

  seekToIndex(index: number): void {
    this.pause();
    if (this.frames.length === 0) return;
    this.currentIndex = Math.max(0, Math.min(index, this.frames.length));
    this.currentT =
      this.frames[this.currentIndex]?.t ?? this.frames[this.frames.length - 1]?.t ?? 0;
    this.status = this.currentIndex >= this.frames.length ? "completed" : "paused";
    this.notifyState();
  }

  addBookmark(label: string): TimeTravelBookmark {
    const bm: TimeTravelBookmark = {
      id: `bm-${Date.now()}-${this.bookmarks.length + 1}`,
      t: this.currentT,
      label,
      frameIndex: this.currentIndex,
    };
    this.bookmarks.push(bm);
    this.notifyState();
    return bm;
  }

  jumpToBookmark(id: string): boolean {
    const bm = this.bookmarks.find((b) => b.id === id);
    if (!bm) return false;
    this.seekToIndex(bm.frameIndex);
    return true;
  }

  state(): TimeTravelState {
    const totalFrames = this.frames.length;
    const totalDurationMs =
      totalFrames > 0 ? (this.frames[totalFrames - 1]?.t ?? 0) - (this.frames[0]?.t ?? 0) : 0;

    return {
      status: this.status,
      currentT: this.currentT,
      currentIndex: this.currentIndex,
      totalFrames,
      totalDurationMs,
      speed: this.speed,
      bookmarks: [...this.bookmarks],
    };
  }

  private scheduleNextFrame(): void {
    if (this.status !== "playing" || this.currentIndex >= this.frames.length) {
      this.status = "completed";
      this.notifyState();
      return;
    }

    const currentFrame = this.frames[this.currentIndex];
    if (!currentFrame) return;

    const nextIndex = this.currentIndex + 1;
    let delayMs = 0;

    if (nextIndex < this.frames.length) {
      const nextFrame = this.frames[nextIndex];
      if (nextFrame) {
        const delta = Math.max(0, nextFrame.t - currentFrame.t);
        delayMs = Math.round(delta / this.speed);
      }
    }

    this.timer = setTimeout(
      () => {
        if (this.status !== "playing") return;
        this.emitFrame(currentFrame);
        this.currentIndex = nextIndex;
        this.currentT = currentFrame.t;

        if (this.currentIndex >= this.frames.length) {
          this.status = "completed";
          this.notifyState();
        } else {
          this.notifyState();
          this.scheduleNextFrame();
        }
      },
      Math.min(delayMs, 5000),
    );
  }

  private emitFrame(entry: ReplayFrameEntry): CanFrame {
    const frame = createFrame(entry.canId, entry.payload, {
      channel: entry.channel ?? this.channel,
      extended: entry.extended ?? false,
      fd: entry.fd ?? false,
    });

    for (const { listener, filters } of this.listeners) {
      if (!filters || filters.length === 0 || frameMatchesFilters(frame, filters)) {
        try {
          listener(frame);
        } catch (err) {
          this.log.error("Error in frame listener during time travel", { err });
        }
      }
    }

    return frame;
  }

  private notifyState(): void {
    const s = this.state();
    for (const listener of this.stateListeners) {
      try {
        listener(s);
      } catch (err) {
        this.log.debug("time-travel state listener threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
