import assert from "node:assert/strict";
import { AdapterUnsupportedError, fromHex, toHex } from "@vdp/shared";
import { createFrame } from "@vdp/transport-can";
import { test } from "vitest";
import {
  Elm327Adapter,
  MemoryByteStream,
  formatIdentifier,
  formatSendPayload,
  isElmError,
  parseFrameLine,
} from "./index.js";

/** Minimal ELM327 emulation: answers AT commands and echoes one response frame. */
function createFakeElm(options: { response?: string; error?: string } = {}) {
  const stream = new MemoryByteStream();
  stream.open();
  const sent: string[] = [];
  stream.responder = (command) => {
    const trimmed = command.replace(/\r$/, "");
    sent.push(trimmed);
    if (trimmed === "ATZ") return "ELM327 v2.1\r\n>";
    if (trimmed.startsWith("ATRV")) return "13.8V\r\n>";
    if (trimmed.startsWith("ATSH")) return "OK\r\n>";
    if (trimmed.startsWith("AT")) return "OK\r\n>";
    // A data command: answer with a frame line (or an error).
    if (options.error) return `${options.error}\r\n>`;
    const reply = options.response ?? "7E8 03 7F 22 31";
    return `${reply}\r\n>`;
  };
  return { stream, sent };
}

test("frame lines with headers are parsed into CAN frames", () => {
  const frame = parseFrameLine("7E8 06 62 F1 90 57 56 57", "elm0", 1000);
  assert.ok(frame);
  assert.equal(frame.id, 0x7e8);
  assert.equal(frame.extended, false);
  assert.equal(toHex(frame.payload), "62 F1 90 57 56 57");
  assert.equal(frame.dlc, 6);
  assert.equal(frame.direction, "rx");
});

test("29-bit identifiers are recognised by their 8 hex digits", () => {
  const frame = parseFrameLine("18DA00F1 02 50 03", "elm0");
  assert.ok(frame);
  assert.equal(frame.id, 0x18da00f1);
  assert.equal(frame.extended, true);
});

test("non-frame lines are rejected instead of guessed", () => {
  assert.equal(parseFrameLine("OK", "elm0"), null);
  assert.equal(parseFrameLine("7E8 06 62", "elm0"), null, "declared length must match the payload");
  assert.equal(parseFrameLine("ELM327 v2.1", "elm0"), null);
  assert.equal(parseFrameLine("7E8 06 62 F1 90 57 56 ZZ", "elm0"), null);
});

test("ELM error strings are detected", () => {
  assert.equal(isElmError("NO DATA"), "NO DATA");
  assert.equal(isElmError("UNABLE TO CONNECT"), "UNABLE TO CONNECT");
  assert.equal(isElmError("?"), "?");
  assert.equal(isElmError("7E8 03 7F 22 31"), null);
});

test("send payload uses the ELM length-prefixed format", () => {
  const frame = createFrame(0x7e0, fromHex("22 F1 90"));
  assert.equal(formatSendPayload(frame), "03 22 F1 90");
});

test("identifier formatting differs for 11-bit and 29-bit addressing", () => {
  assert.equal(formatIdentifier(0x7e0, false), "7e0");
  assert.equal(formatIdentifier(0x18daf100, true), "18daf100");
});

test("open() runs the AT init sequence and records the firmware version", async () => {
  const { stream, sent } = createFakeElm();
  const adapter = new Elm327Adapter({ stream, commandTimeoutMs: 500 });
  await adapter.open();
  assert.equal(adapter.isOpen(), true);
  assert.equal(adapter.status.version, "ELM327 v2.1");
  assert.ok(sent.includes("ATZ"));
  assert.ok(sent.includes("ATE0"), "echo must be disabled");
  assert.ok(sent.includes("ATH1"), "headers must be enabled or multi-ECU buses are unusable");
});

test("send() switches the transmit identifier with ATSH only when it changes", async () => {
  const { stream, sent } = createFakeElm();
  const adapter = new Elm327Adapter({ stream, commandTimeoutMs: 500 });
  await adapter.open();
  await adapter.send(createFrame(0x7e0, fromHex("22 F1 90")));
  await adapter.send(createFrame(0x7e0, fromHex("22 F1 8C")));
  await adapter.send(createFrame(0x7e1, fromHex("22 F1 90")));
  const atsh = sent.filter((command) => command.startsWith("ATSH"));
  assert.equal(atsh.length, 2, "ATSH only on identifier change");
  assert.deepEqual(atsh, ["ATSH 7e0", "ATSH 7e1"]);
});

test("received frames reach subscribers and honour filters", async () => {
  const { stream } = createFakeElm({ response: "7E8 03 7F 22 31" });
  const adapter = new Elm327Adapter({ stream, commandTimeoutMs: 500 });
  await adapter.open();
  const received: string[] = [];
  adapter.subscribe(
    (frame) => received.push(`0x${frame.id.toString(16)}`),
    [{ id: 0x7e8, mask: 0x7ff }],
  );
  const ignored: number[] = [];
  adapter.subscribe((frame) => ignored.push(frame.id), [{ id: 0x7e9, mask: 0x7ff }]);

  await adapter.send(createFrame(0x7e0, fromHex("22 F1 90")));
  assert.deepEqual(received, ["0x7e8"]);
  assert.deepEqual(ignored, []);
  assert.equal(adapter.counters.rx, 1);
});

test("ELM errors are surfaced in the adapter status, not swallowed", async () => {
  const { stream } = createFakeElm({ error: "NO DATA" });
  const adapter = new Elm327Adapter({ stream, commandTimeoutMs: 500 });
  await adapter.open();
  await adapter.send(createFrame(0x7e0, fromHex("22 F1 90")));
  assert.deepEqual(adapter.status.errors, ["NO DATA"]);
});

test("battery voltage can be read for the safety layer", async () => {
  const { stream } = createFakeElm();
  const adapter = new Elm327Adapter({ stream, commandTimeoutMs: 500 });
  await adapter.open();
  assert.equal(await adapter.readVoltage(), 13.8);
});

test("CAN-FD frames are rejected with a typed error", async () => {
  const { stream } = createFakeElm();
  const adapter = new Elm327Adapter({ stream, commandTimeoutMs: 500 });
  await adapter.open();
  await assert.rejects(
    adapter.send(createFrame(0x7e0, new Uint8Array(10).fill(1), { fd: true })),
    AdapterUnsupportedError,
  );
  assert.equal(adapter.capabilities.canFd, false);
});

test("a missing prompt surfaces as a transport timeout", async () => {
  const stream = new MemoryByteStream();
  stream.open();
  stream.responder = () => null; // never answers
  const adapter = new Elm327Adapter({ stream, commandTimeoutMs: 30 });
  await assert.rejects(adapter.open(), /timed out/);
});
