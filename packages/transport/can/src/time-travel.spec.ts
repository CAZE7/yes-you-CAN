/**
 * Time-Travel CAN Replay Unit Tests (Task 9; Master Backlog #44).
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createFrame } from "./frame.js";
import type { ReplayFrameEntry } from "./replay.js";
import { TimeTravelCanBus } from "./time-travel.js";

function makeFrame(
  t: number,
  canId: number,
  data: number[],
  options: { channel?: string; extended?: boolean; fd?: boolean } = {},
): ReplayFrameEntry {
  return {
    t,
    canId,
    direction: "rx",
    payload: new Uint8Array(data),
    ...options,
  };
}

describe("TimeTravelCanBus", () => {
  const sampleFrames: ReplayFrameEntry[] = [
    makeFrame(0, 0x100, [0x01]),
    makeFrame(100, 0x200, [0x02]),
    makeFrame(250, 0x300, [0x03], { extended: true }),
    makeFrame(500, 0x400, [0x04], { fd: true }),
  ];

  test("loads frames and exposes initial paused state", () => {
    const bus = new TimeTravelCanBus();
    assert.equal(bus.isOpen(), false);
    assert.equal(bus.state().status, "idle");
    assert.equal(bus.state().totalFrames, 0);
    assert.equal(bus.state().totalDurationMs, 0);

    bus.loadFrames(sampleFrames);

    const s = bus.state();
    assert.equal(s.totalFrames, 4);
    assert.equal(s.totalDurationMs, 500);
    assert.equal(s.currentIndex, 0);
    assert.equal(s.status, "paused");
  });

  test("lifecycle: open, close, isOpen, send", async () => {
    const bus = new TimeTravelCanBus({ channel: "can0", speed: 2.0 });
    assert.equal(bus.isOpen(), false);
    await bus.open();
    assert.equal(bus.isOpen(), true);

    bus.loadFrames(sampleFrames);
    bus.play();
    assert.equal(bus.state().status, "playing");

    await bus.close();
    assert.equal(bus.isOpen(), false);
    assert.equal(bus.state().status, "paused");

    // send is a safe no-op on replay bus
    await assert.doesNotReject(() => bus.send(createFrame(0x123, new Uint8Array([1]))));
  });

  test("steps forward and backward frame by frame", () => {
    const bus = new TimeTravelCanBus();
    bus.loadFrames(sampleFrames);

    const emitted: number[] = [];
    bus.subscribe((frame) => emitted.push(frame.id));

    // Step 1
    const f1 = bus.stepForward();
    assert.equal(f1?.id, 0x100);
    assert.equal(bus.state().currentIndex, 1);
    assert.equal(bus.state().currentT, 0);

    // Step 2
    const f2 = bus.stepForward();
    assert.equal(f2?.id, 0x200);
    assert.equal(bus.state().currentIndex, 2);
    assert.equal(bus.state().currentT, 100);

    // Step Backward
    const fBack = bus.stepBackward();
    assert.equal(fBack?.id, 0x200);
    assert.equal(bus.state().currentIndex, 1);

    // Step Backward to start
    const fStart = bus.stepBackward();
    assert.equal(fStart?.id, 0x100);
    assert.equal(bus.state().currentIndex, 0);

    // Step Backward past start
    const pastStart = bus.stepBackward();
    assert.equal(pastStart, undefined);
    assert.equal(bus.state().currentIndex, 0);

    assert.deepEqual(emitted, [0x100, 0x200, 0x200, 0x100]);
  });

  test("steps forward to completion", () => {
    const bus = new TimeTravelCanBus();
    bus.loadFrames([makeFrame(0, 0x100, [1])]);

    const f1 = bus.stepForward();
    assert.equal(f1?.id, 0x100);
    assert.equal(bus.state().status, "completed");

    const pastEnd = bus.stepForward();
    assert.equal(pastEnd, undefined);
    assert.equal(bus.state().status, "completed");
  });

  test("seeks to timestamp t and to frame index", () => {
    const bus = new TimeTravelCanBus();
    // Seek on empty frames
    bus.seekTo(100);
    bus.seekToIndex(1);
    assert.equal(bus.state().totalFrames, 0);

    bus.loadFrames(sampleFrames);

    bus.seekTo(200);
    // 200ms is after frame 1 (100ms) and before frame 2 (250ms)
    assert.equal(bus.state().currentIndex, 2);
    assert.equal(bus.state().currentT, 200);

    // Seek past end
    bus.seekTo(1000);
    assert.equal(bus.state().currentIndex, 4);
    assert.equal(bus.state().status, "completed");

    bus.seekToIndex(3);
    assert.equal(bus.state().currentIndex, 3);
    assert.equal(bus.state().status, "paused");

    // Seek past index bounds
    bus.seekToIndex(99);
    assert.equal(bus.state().currentIndex, 4);
    assert.equal(bus.state().status, "completed");

    bus.seekToIndex(-5);
    assert.equal(bus.state().currentIndex, 0);
  });

  test("creates bookmarks and jumps directly to them", () => {
    const bus = new TimeTravelCanBus();
    bus.loadFrames(sampleFrames);

    bus.stepForward(); // index 1
    bus.stepForward(); // index 2
    const bm = bus.addBookmark("Engine RPM spike");

    assert.equal(bm.label, "Engine RPM spike");
    assert.equal(bm.frameIndex, 2);

    bus.seekToIndex(0);
    assert.equal(bus.state().currentIndex, 0);

    const jumped = bus.jumpToBookmark(bm.id);
    assert.equal(jumped, true);
    assert.equal(bus.state().currentIndex, 2);

    const missingJump = bus.jumpToBookmark("nonexistent");
    assert.equal(missingJump, false);
  });

  test("subscription filtering, unsubscription, and error isolation", () => {
    const bus = new TimeTravelCanBus();
    bus.loadFrames(sampleFrames);

    const filtered: number[] = [];
    const unsubscribe = bus.subscribe((f) => filtered.push(f.id), [{ id: 0x200, mask: 0x7ff }]);

    // Throwing listener
    bus.subscribe(() => {
      throw new Error("listener error test");
    });

    bus.stepForward(); // 0x100
    bus.stepForward(); // 0x200

    assert.deepEqual(filtered, [0x200]);

    unsubscribe();
    bus.stepBackward(); // 0x200
    assert.deepEqual(filtered, [0x200]); // no new emissions
  });

  test("speed controls and validation", () => {
    const bus = new TimeTravelCanBus();
    assert.throws(() => bus.setSpeed(0), /must be positive/);
    assert.throws(() => bus.setSpeed(-1), /must be positive/);

    bus.setSpeed(5.0);
    assert.equal(bus.state().speed, 5.0);

    bus.loadFrames(sampleFrames);
    bus.play();
    assert.equal(bus.state().status, "playing");
    bus.setSpeed(2.0);
    assert.equal(bus.state().speed, 2.0);
    bus.pause();
    assert.equal(bus.state().status, "paused");
  });

  test("state change listener subscription and error tolerance", () => {
    const bus = new TimeTravelCanBus();
    const states: string[] = [];

    const unsub = bus.onStateChange((s) => states.push(s.status));
    assert.equal(states[0], "idle");

    // Add a throwing state listener
    bus.onStateChange(() => {
      throw new Error("faulty subscriber");
    });

    bus.loadFrames(sampleFrames);
    assert.ok(states.includes("paused"));

    unsub();
  });

  test("timed playback runs and completes", async () => {
    const quickFrames: ReplayFrameEntry[] = [
      makeFrame(0, 0x10, [1]),
      makeFrame(5, 0x20, [2]),
      makeFrame(10, 0x30, [3]),
    ];
    const bus = new TimeTravelCanBus({ speed: 100 }); // 100x speed
    bus.loadFrames(quickFrames);

    const received: number[] = [];
    bus.subscribe((f) => received.push(f.id));

    bus.play();
    assert.equal(bus.state().status, "playing");

    // Wait for playback to complete
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (bus.state().status === "completed") {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    assert.equal(bus.state().status, "completed");
    assert.deepEqual(received, [0x10, 0x20, 0x30]);

    // play again when completed restarts from beginning
    bus.play();
    assert.equal(bus.state().status, "playing");
    bus.pause();
    assert.equal(bus.state().status, "paused");
  });
});
