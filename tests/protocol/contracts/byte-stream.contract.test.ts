/**
 * Byte stream contract (AGENTS 4/29/31, Master-Backlog P0 #8).
 *
 * Every serial adapter (ELM327, CANable/slcan, future USB-CAN bridges) speaks to
 * a `ByteStream`, never to a serial port. Two implementations exist: the
 * in-memory stream the unit tests use, and the POSIX host stream that drives a
 * real character device. They must behave identically — an adapter that works
 * over one and not the other is the classic "green tests, dead hardware" bug.
 *
 * The contract is deliberately small: ordered writes, ordered delivery, working
 * unsubscription, idempotent close, and a typed error when writing into a closed
 * stream. Framing, timeouts and protocol semantics belong to the adapters.
 */

import assert from "node:assert/strict";
import type { FileHandle } from "node:fs/promises";
import { type ByteStream, MemoryByteStream } from "@vdp/adapter-elm327";
import { SerialByteStream } from "@vdp/adapter-host";
import { TransportError } from "@vdp/shared";
import { test } from "vitest";

interface ByteStreamFixture {
  stream: ByteStream & { emit(chunk: string): void };
  /** Everything that reached the device, concatenated. */
  written(): string;
  cleanup(): Promise<void>;
}

interface ByteStreamSubject {
  name: string;
  create(): ByteStreamFixture | Promise<ByteStreamFixture>;
}

/** A file handle that records writes and never has data of its own. */
function fakeHandle(): { handle: FileHandle; written: string[] } {
  const written: string[] = [];
  const handle = {
    async write(buffer: Uint8Array): Promise<{ bytesWritten: number; buffer: Uint8Array }> {
      written.push(Buffer.from(buffer).toString("latin1"));
      return { bytesWritten: buffer.length, buffer };
    },
    async read(): Promise<{ bytesRead: number; buffer: Uint8Array }> {
      // A serial tty with nothing to read: EAGAIN is the normal case. No timer —
      // the stream's own poll interval covers the pause (ADR 0019).
      throw Object.assign(new Error("resource temporarily unavailable"), { code: "EAGAIN" });
    },
    async close(): Promise<void> {
      // Nothing to release in the double.
    },
  };
  return { handle: handle as unknown as FileHandle, written };
}

const subjects: ByteStreamSubject[] = [
  {
    name: "memory stream",
    create() {
      const stream = new MemoryByteStream();
      stream.open();
      return {
        stream,
        written: () => stream.written.join(""),
        async cleanup() {
          await stream.close();
        },
      };
    },
  },
  {
    name: "host serial stream",
    create() {
      const { handle, written } = fakeHandle();
      const stream = new SerialByteStream({ device: "/dev/fake0", idlePollMs: 5 }, handle);
      return {
        stream,
        written: () => written.join(""),
        async cleanup() {
          await stream.close();
        },
      };
    },
  },
];

for (const subject of subjects) {
  test(`${subject.name}: writes reach the device in order`, async () => {
    const fixture = await subject.create();
    try {
      await fixture.stream.write("ATZ\r");
      await fixture.stream.write("ATI\r");
      assert.equal(fixture.written(), "ATZ\rATI\r");
    } finally {
      await fixture.cleanup();
    }
  });

  test(`${subject.name}: incoming chunks reach listeners in order`, async () => {
    const fixture = await subject.create();
    const chunks: string[] = [];
    try {
      const off = fixture.stream.onData((chunk) => chunks.push(chunk));
      fixture.stream.emit("ELM327 v2.1\r");
      fixture.stream.emit("OK\r");
      assert.deepEqual(chunks, ["ELM327 v2.1\r", "OK\r"]);

      off();
      fixture.stream.emit("late\r");
      assert.deepEqual(chunks, ["ELM327 v2.1\r", "OK\r"], "an unsubscribed listener is silent");
      off();
      assert.doesNotThrow(() => off(), "unsubscribing twice must not throw");
    } finally {
      await fixture.cleanup();
    }
  });

  test(`${subject.name}: close() ends the stream and can be repeated`, async () => {
    const fixture = await subject.create();
    await fixture.stream.close();
    assert.equal(fixture.stream.isOpen(), false);
    await fixture.stream.close();
    assert.equal(fixture.stream.isOpen(), false, "closing twice is not an error");
  });

  test(`${subject.name}: writing into a closed stream is a typed error`, async () => {
    const fixture = await subject.create();
    try {
      await fixture.stream.close();
      await assert.rejects(
        () => fixture.stream.write("ATZ\r"),
        TransportError,
        "a command written into a closed stream must not disappear",
      );
    } finally {
      await fixture.cleanup();
    }
  });

  test(`${subject.name}: the stream describes itself`, async () => {
    const fixture = await subject.create();
    try {
      assert.equal(typeof fixture.stream.describe, "function");
      const description = fixture.stream.describe?.() ?? "";
      assert.ok(description.length > 0, "an adapter panel needs something to show");
    } finally {
      await fixture.cleanup();
    }
  });
}
