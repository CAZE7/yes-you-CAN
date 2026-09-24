import assert from "node:assert/strict";
import { MemoryByteStream } from "@vdp/adapter-elm327";
import { createLogger, fromHex, MemorySink, TransportError, toHex } from "@vdp/shared";
import { createFrame } from "@vdp/transport-can";
import { test } from "vitest";
import {
  BITRATES,
  CanableAdapter,
  formatSlcanFrame,
  isSlcanError,
  parseSlcanLine,
} from "./index.js";

/**
 * A scripted Lawicel device on the memory stream: every command is answered —
 * `V` with a version line by default (every real slcan firmware answers it),
 * every other command with the empty-CR ack. Overrides can replace one
 * command's answer (BEL `\u0007` for refused, `null` for silence).
 */
function answeringSlcan(overrides: Record<string, string | null> = {}): MemoryByteStream {
  const stream = new MemoryByteStream();
  stream.open();
  stream.responder = (command) => {
    const trimmed = command.replace(/\r$/, "");
    if (trimmed in overrides) return overrides[trimmed] ?? null;
    if (trimmed === "V") return "V0101\r";
    return "\r";
  };
  return stream;
}

test("standard and extended frames are formatted in slcan syntax", () => {
  assert.equal(formatSlcanFrame(createFrame(0x7e0, fromHex("02 3E 80"))), "t7E03023E80\r");
  // '02 3E 80' is three bytes, so the DLC field is 3.
  assert.equal(
    formatSlcanFrame(createFrame(0x18daf100, fromHex("02 3E 80"), { extended: true })),
    "T18DAF1003023E80\r",
  );
});

test("frame lines are parsed, including the optional timestamp suffix", () => {
  const frame = parseSlcanLine("t7E837F2231", "slcan0", 5000);
  assert.ok(frame);
  assert.equal(frame.id, 0x7e8);
  assert.equal(toHex(frame.payload), "7F 22 31");
  assert.equal(frame.extended, false);

  // Extended id + DLC 2 + payload 5003 + 3-digit timestamp suffix.
  const extended = parseSlcanLine("T18DA00F1250030FF", "slcan0", 9000);
  assert.ok(extended);
  assert.equal(extended.extended, true);
  assert.equal(extended.dlc, 2);
  assert.equal(toHex(extended.payload), "50 03");
});

test("the type character, not the digit count, decides how long the id is", () => {
  // `t` declares an 11-bit id: the digits after it belong to the DLC and the payload.
  // Reading the line as "8 id digits first" turned a normal OBD response into an
  // *extended* frame with an empty payload and the tail misread as a timestamp — a
  // plausible-looking frame that simply contained nothing.
  const frame = parseSlcanLine("t7E84410C0BB8", "slcan0", 5000);
  assert.ok(frame);
  assert.equal(frame.extended, false);
  assert.equal(frame.id, 0x7e8);
  assert.equal(frame.dlc, 4);
  assert.equal(toHex(frame.payload), "41 0C 0B B8");

  // The other direction: a `T` line must not fall back to the 3-digit reading either.
  assert.equal(
    parseSlcanLine("T7E837F2231", "slcan0"),
    null,
    "an extended frame needs all 8 id digits, not a standard id",
  );

  // And the timestamp suffix is still only ever the last three digits of the line.
  const stamped = parseSlcanLine("t7E837F22311A2", "slcan0", 5000);
  assert.ok(stamped);
  assert.equal(toHex(stamped.payload), "7F 22 31");
  assert.equal(stamped.timestamp, 5000 - 0x1a2, "the suffix is milliseconds already elapsed");
});

test("a frame that does not fit slcan is refused, not truncated", () => {
  // slcan has no FD variant: cutting a 20-byte payload to eight would put a valid
  // looking, silently shortened frame on the bus — the one mistake no receiver can
  // detect. Same rule as `send()` refusing `fd` frames, enforced at the encoder.
  const tooLong = createFrame(0x7e0, fromHex("02 3E 80 01 02 03 04 05 06 07 08 09 0A 0B"));
  assert.throws(() => formatSlcanFrame(tooLong), /at most 8 data bytes/);
  // Exactly eight still goes out, and the DLC follows the payload length.
  assert.equal(
    formatSlcanFrame(createFrame(0x7e0, fromHex("11 22 33 44 55 66 77 88"))),
    "t7E081122334455667788\r",
  );
  assert.equal(
    parseSlcanLine("t7E081122334455667788", "slcan0", 1)?.payload.length,
    8,
    "and it reads back the same",
  );
});

test("lines that are not frames are rejected", () => {
  assert.equal(parseSlcanLine("V1234", "slcan0"), null);
  assert.equal(parseSlcanLine("OK", "slcan0"), null);
  assert.equal(
    parseSlcanLine("t7E837F22", "slcan0"),
    null,
    "payload shorter than the DLC must not be accepted",
  );
  assert.equal(parseSlcanLine("r7E80", "slcan0"), null, "remote frames carry no payload");
});

test("BEL answers are counted as errors", () => {
  assert.equal(isSlcanError("\u0007"), true);
  assert.equal(isSlcanError("\r"), false);
});

test("open() proves the device, then configures bitrate, timestamps and opens the channel", async () => {
  const stream = answeringSlcan();
  const adapter = new CanableAdapter({ stream, bitrate: "500k", commandTimeoutMs: 100 });
  await adapter.open();
  assert.equal(adapter.isOpen(), true);
  // Order matters: the V handshake comes first — it is what separates a slcan
  // firmware at this baud rate from any other silent thing on the wire.
  assert.deepEqual(stream.written, ["V\r", `${BITRATES["500k"]}\r`, "Z1\r", "O\r"]);
  assert.equal(adapter.version, "0101");
});

test("sent frames reach the stream and received frames reach subscribers", async () => {
  const stream = answeringSlcan();
  const adapter = new CanableAdapter({ stream, commandTimeoutMs: 100 });
  await adapter.open();
  const received: string[] = [];
  adapter.subscribe((frame) => received.push(toHex(frame.payload)));
  await adapter.send(createFrame(0x7e0, fromHex("02 3E 80")));
  assert.ok(
    stream.written.includes("t7E03023E80\r"),
    `expected the slcan frame, got ${stream.written.join(" | ")}`,
  );

  stream.emit("t7E837F2231\r");
  assert.deepEqual(received, ["7F 22 31"]);
  assert.equal(adapter.counters.rx, 1);
});

test("BEL responses increment the error counter", async () => {
  const stream = answeringSlcan();
  const adapter = new CanableAdapter({ stream, commandTimeoutMs: 100 });
  await adapter.open();
  stream.emit("\u0007");
  assert.equal(adapter.counters.errors, 1);
});

test("CAN-FD frames are rejected", async () => {
  const stream = answeringSlcan();
  const adapter = new CanableAdapter({ stream, commandTimeoutMs: 100 });
  await adapter.open();
  await assert.rejects(
    adapter.send(createFrame(0x7e0, new Uint8Array(12).fill(1), { fd: true })),
    /CAN-FD/,
  );
});

test("close() sends the close command and stops delivery", async () => {
  const stream = answeringSlcan();
  const adapter = new CanableAdapter({ stream, commandTimeoutMs: 100 });
  await adapter.open();
  await adapter.close();
  assert.equal(adapter.isOpen(), false);
  assert.ok(stream.written.at(-1) === "C\r");
});

test("closing a broken channel reports the reason instead of swallowing it", async () => {
  // Symptom before the fix: `close()` caught the failing "C" command in an
  // empty `catch {}` (AGENTS 34.25 forbids that). Closing must still succeed —
  // the caller is on its way out — but the reason has to leave a trace.
  const stream = answeringSlcan();
  const sink = new MemorySink();
  const adapter = new CanableAdapter({
    stream,
    commandTimeoutMs: 100,
    logger: createLogger("can", { level: "DEBUG" }, [sink]),
  });
  await adapter.open();
  // The device disappears before the close command reaches it.
  stream.close();
  await adapter.close();

  assert.equal(adapter.isOpen(), false, "the adapter is closed either way");
  const reported = sink.all().find((record) => record.message === "slcan close command failed");
  assert.ok(
    reported,
    `expected a debug record, got ${sink
      .all()
      .map((r) => r.message)
      .join("|")}`,
  );
  assert.equal(reported?.level, "DEBUG");
  assert.match(String(reported?.fields?.error ?? ""), /slcan write failed/);
});

/* ------------------------------------------------ the open() handshake
 *
 * Symptom that motivated it: a CANable that never configures successfully
 * looked exactly like a silent vehicle — the bitrate command was written once
 * and nothing checked whether the device behind the wire even was a slcan
 * adapter. Every day-1 failure (wrong path, wrong baud, an ELM327 selected as
 * slcan, the bitrate refused with BEL) ended in "no frames" instead of an
 * error naming the cause. Lawicel answers every command (CR ack / BEL), so
 * open() now waits for those answers.
 */

test("open() fails on a silent wire with the cause, not with a fake connected state", async () => {
  const stream = answeringSlcan({ V: null }); // the device never says a word
  const adapter = new CanableAdapter({ stream, bitrate: "500k", commandTimeoutMs: 30 });
  await assert.rejects(
    adapter.open(),
    (error: unknown) =>
      error instanceof TransportError &&
      error.message.includes("version query") &&
      error.message.includes("30 ms") &&
      error.message.includes("wrong baud rate") &&
      error.message.includes("do not answer each other's hello"),
    "the error must say what was not answered and name the usual causes",
  );
  assert.equal(adapter.isOpen(), false, "and the adapter does not pretend to be open");
});

test("a BEL on the version query fails open() with the refused purpose in the message", async () => {
  const stream = answeringSlcan({ V: "" });
  const adapter = new CanableAdapter({ stream, bitrate: "500k", commandTimeoutMs: 30 });
  await assert.rejects(
    adapter.open(),
    (error: unknown) =>
      error instanceof TransportError &&
      error.message.includes("slcan refused") &&
      error.message.includes("version query") &&
      error.message.includes("BEL"),
  );
  assert.equal(adapter.counters.errors, 1, "the refusal is counted");
});

test("a BEL on the bitrate command fails open() naming the bitrate", async () => {
  const stream = answeringSlcan({ S6: "" });
  const adapter = new CanableAdapter({ stream, bitrate: "500k", commandTimeoutMs: 30 });
  await assert.rejects(
    adapter.open(),
    (error: unknown) =>
      error instanceof TransportError &&
      error.message.includes("bitrate command") &&
      error.message.includes("500k"),
  );
});

test("a firmware without timestamp mode opens anyway — warned, not failed", async () => {
  const stream = answeringSlcan({ Z1: "" });
  const sink = new MemorySink();
  const adapter = new CanableAdapter({
    stream,
    bitrate: "500k",
    commandTimeoutMs: 100,
    logger: createLogger("can", { level: "DEBUG" }, [sink]),
  });
  await adapter.open();
  assert.equal(adapter.isOpen(), true);
  assert.ok(
    sink.all().some((record) => record.message.includes("no timestamp mode")),
    `expected the downgrade warning, got ${sink
      .all()
      .map((record) => record.message)
      .join(" | ")}`,
  );
});

test("listen-only opens with L and never writes O", async () => {
  const stream = answeringSlcan();
  const adapter = new CanableAdapter({
    stream,
    bitrate: "500k",
    commandTimeoutMs: 100,
    listenOnly: true,
  });
  await adapter.open();
  assert.equal(adapter.isOpen(), true);
  assert.deepEqual(stream.written, ["V\r", `${BITRATES["500k"]}\r`, "Z1\r", "L\r"]);
  assert.equal(
    stream.written.some((line) => line.trim() === "O"),
    false,
    "Lawicel reads O as the normal-mode open — writing both silently undoes listen-only",
  );
});

test("a dying stream fails the in-flight handshake and stops the adapter", async () => {
  const stream = answeringSlcan({ V: null }); // silent until …
  const adapter = new CanableAdapter({ stream, bitrate: "500k", commandTimeoutMs: 5000 });
  const opening = adapter.open();
  stream.emitError(new Error("device removed"));
  await assert.rejects(opening, (error: unknown) =>
    error instanceof TransportError ? error.message.includes("slcan link failed") : false,
  );
  assert.equal(
    adapter.isOpen(),
    false,
    "an adapter whose device left is not an adapter — silence here is the silent-vehicle bug",
  );
});

test("a dying stream while idle reports closed instead of pretending connected", async () => {
  const stream = answeringSlcan();
  const adapter = new CanableAdapter({ stream, bitrate: "500k", commandTimeoutMs: 100 });
  await adapter.open();
  assert.equal(adapter.isOpen(), true);
  stream.emitError(new Error("device removed"));
  assert.equal(adapter.isOpen(), false);
  assert.equal(adapter.counters.errors > 0, true);
});
