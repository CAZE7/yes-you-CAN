import assert from "node:assert/strict";
import { AdapterUnsupportedError, asError, fromHex, TransportError, toHex } from "@vdp/shared";
import { type CanFrame, createFrame } from "@vdp/transport-can";
import { describe, test } from "vitest";
import {
  assertCanSupport,
  DEFAULT_INIT_SEQUENCE,
  ELM_CAN_PROTOCOLS,
  Elm327Adapter,
  formatIdentifier,
  formatSendPayload,
  isElmError,
  MemoryByteStream,
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

test("raw CAN multi-byte frames (e.g. UDS First Frame 8 bytes) are parsed without dropped frames", () => {
  const frame = parseFrameLine("7E8 10 14 62 F1 90 57 56 57", "elm0");
  assert.ok(frame);
  assert.equal(frame.id, 0x7e8);
  assert.equal(frame.dlc, 8);
  assert.equal(toHex(frame.payload), "10 14 62 F1 90 57 56 57");
});

test("frames with garbage characters (trailing prompt, null bytes, CR) are sanitized", () => {
  const frame = parseFrameLine("7E8 03 41 0C 1F >\r\0", "elm0");
  assert.ok(frame);
  assert.equal(frame.id, 0x7e8);
  assert.equal(toHex(frame.payload), "41 0C 1F");
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

test("a filter that states extended means it — no low-bit accidental match", async () => {
  // 18DAF1EF is a 29-bit frame whose low 11 bits are 0x1EF; a subscriber that
  // asks for the 11-bit id 0x1EF must not receive it. The shared filter
  // vocabulary (`frameMatchesFilters`) is what makes the flag count here too.
  const { stream } = createFakeElm({ response: "18DAF1EF 03 7F 22 31" });
  const adapter = new Elm327Adapter({ stream, commandTimeoutMs: 500 });
  await adapter.open();
  const received: number[] = [];
  adapter.subscribe(
    (frame) => received.push(frame.id),
    [{ id: 0x1ef, mask: 0x7ff, extended: false }],
  );
  const extended: number[] = [];
  adapter.subscribe(
    (frame) => extended.push(frame.id),
    [{ id: 0x1ef, mask: 0x7ff, extended: true }],
  );

  await adapter.send(createFrame(0x7e0, fromHex("22 F1 90")));
  assert.deepEqual(received, [], "the 29-bit frame is not an 11-bit answer");
  assert.deepEqual(extended, [0x18daf1ef]);
});

test("echo frames from cheap clones are suppressed and not dispatched as rx", async () => {
  const stream = new MemoryByteStream();
  stream.open();
  // Echo the command ATSH or the sent payload before responding
  stream.responder = (cmd) => {
    if (cmd.startsWith("AT")) return "OK\r\n>";
    return `${cmd}\r\n7E8 03 62 F1 90\r\n>`;
  };
  const adapter = new Elm327Adapter({ stream, commandTimeoutMs: 500 });
  await adapter.open();

  const received: string[] = [];
  adapter.subscribe((f) => received.push(`0x${f.id.toString(16)}`));
  await adapter.send(createFrame(0x7e0, fromHex("22 F1 90")));

  // Only the 0x7E8 response is dispatched, NOT the echoed 0x7E0 request!
  assert.deepEqual(received, ["0x7e8"]);
});

test("an ELM error fails the send and is still on record", async () => {
  const { stream } = createFakeElm({ error: "NO DATA" });
  const adapter = new Elm327Adapter({ stream, commandTimeoutMs: 500 });
  await adapter.open();
  // Both halves matter. The throw is the contract: `NO DATA` means the frame
  // never reached the bus, so returning normally would tell ISO-TP the opposite
  // and make it wait for an answer nobody was asked for. The record is the
  // evidence: `status.errors` is what the UI panel and a trace show.
  await assert.rejects(
    adapter.send(createFrame(0x7e0, fromHex("22 F1 90"))),
    (error: unknown) =>
      error instanceof TransportError &&
      error.message.includes("NO DATA") &&
      error.details?.command === "03 22 F1 90" &&
      error.details?.frameId === 0x7e0,
    "the refusal names the error and the command that caused it",
  );
  assert.deepEqual(adapter.status.errors, ["NO DATA"]);
});

test("the AT init sequence asks for the wire format the parser reads", async () => {
  // `parseFrameLine` splits on whitespace and needs a two-digit DLC, so the
  // sequence must ask for spaces (`ATS1`) and must not let the adapter's own
  // firmware build flow control frames (`ATCAF0`) while the platform runs its
  // own ISO-TP. These three are one claim: the two ends must agree.
  const sequence = DEFAULT_INIT_SEQUENCE;
  assert.ok(sequence.includes("ATS1"), "spaces on — the parser splits on them");
  assert.ok(!sequence.includes("ATS0"), "spaces off would drop every frame");
  assert.ok(sequence.includes("ATCAF0"), "auto-formatting off — ISO-TP is ours");
  assert.ok(sequence.includes("ATH1"), "headers on — no identifier, no frame");
  assert.ok(sequence.includes("ATSP6"), "11-bit 500 kBaud by default");
});

test("a 29-bit bus is reachable without editing the default sequence", async () => {
  const { stream } = createFakeElm();
  const adapter = new Elm327Adapter({
    stream,
    commandTimeoutMs: 500,
    canProtocol: ELM_CAN_PROTOCOLS.CAN_29BIT_500K,
  });
  await adapter.open();
  const commands = stream.written.map((line) => line.trim());
  assert.ok(commands.includes("ATSP7"), "protocol 7 is ISO 15765-4, 29-bit");
  assert.ok(!commands.includes("ATSP6"), "and the 11-bit default is not sent too");
  // The default is untouched, so the other 2 500 tests that rely on it hold.
  assert.ok(DEFAULT_INIT_SEQUENCE.includes("ATSP6"));
});

test("a bare carriage return ends a line as surely as a newline", async () => {
  // An ELM327 with `ATL0`, and many Bluetooth SPP links, end lines with `\r`
  // alone and only put the prompt `>` at the very end. Splitting on `\n` alone
  // then glues both frames into one line, which `parseFrameLine` rejects — the
  // bus looks silent rather than chatty. Two frames, not one: a single frame
  // still reaches the parser through the prompt path, which is exactly the
  // masking that would let this bug survive.
  const stream = new MemoryByteStream();
  stream.open();
  stream.responder = (command) =>
    command.replace(/\r$/, "").startsWith("AT") ? "OK\r>" : "7E8 03 62 F1 90\r7E9 03 62 F1 91\r>";
  const adapter = new Elm327Adapter({ stream, commandTimeoutMs: 500 });
  const frames: CanFrame[] = [];
  adapter.subscribe((frame) => frames.push(frame));
  await adapter.open();
  await adapter.send(createFrame(0x7e0, fromHex("22 F1 90")));
  assert.equal(frames.length, 2, "both frames arrived, each on its own carriage return");
  assert.deepEqual([...frames[0]!.payload], [0x62, 0xf1, 0x90]);
  assert.deepEqual([...frames[1]!.payload], [0x62, 0xf1, 0x91]);
});

test("a stream that reports its own death takes the adapter down with it", async () => {
  const stream = new MemoryByteStream();
  stream.open();
  let answering = true;
  stream.responder = (command) => {
    if (!answering) return null; // the device stopped talking
    return command.startsWith("AT") ? "OK\r>" : "7E8 03 62 F1 90\r>";
  };
  const adapter = new Elm327Adapter({ stream, commandTimeoutMs: 5_000 });
  await adapter.open();
  assert.equal(adapter.isOpen(), true);

  // One request in flight — and then the link goes away underneath it. The
  // point is that it fails *now*, with the stream's own reason, instead of
  // walking into its own timeout five seconds later.
  answering = false;
  const inFlight = adapter.command("ATRV").then(
    () => {
      throw new Error("a command whose stream died must not resolve");
    },
    (error: unknown) => asError(error),
  );
  stream.emitError(new Error("the Bluetooth link dropped"));

  const failure = await inFlight;
  assert.match(failure.message, /byte stream failed: the Bluetooth link dropped/);
  assert.equal(adapter.isOpen(), false, "an adapter whose device left is not an adapter");
  assert.equal(
    adapter.status.errors.some((entry) => entry.includes("Bluetooth")),
    true,
    "the reason is on record, not just the state change",
  );
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

/**
 * The two thin protocol helpers (0.E E16).
 *
 * `parseFrameLine` is a chain of guards, and every guard that never fires in a test is
 * a line that can be broken without anyone noticing — the frame is either parsed or it
 * is not, and "not" is five different answers. `MemoryByteStream` is the double every
 * adapter test runs on, so its own edges (writing while closed, a responder that stays
 * silent, the unsubscribe function) belong in a test rather than in the middle of an
 * adapter scenario.
 */

describe("parseFrameLine guard chain", () => {
  test("each rejection says which shape it rejected, by being the only thing that fails", () => {
    const cases: Array<[string, string]> = [
      ["", "no tokens at all"],
      ["7E8", "one token is not a frame"],
      ["XYZ 02 3E 80", "a non-hex token is not a frame"],
      ["7E88 02 3E 80", "four identifier digits are neither 11-bit nor 29-bit"],
      ["7E8 2 3E 80", "the length field must be two hex digits"],
      ["7E8 08 3E", "fewer bytes than the declared length are a truncated frame"],
    ];
    for (const [line, why] of cases) {
      assert.equal(
        parseFrameLine(line, "vcan0"),
        null,
        `${why} — line was ${JSON.stringify(line)}`,
      );
    }
  });

  test("both identifier widths and an explicit timestamp reach the frame", () => {
    const std = parseFrameLine("7E8 03 41 0C 1F", "vcan0");
    assert.equal(std?.id, 0x7e8);
    assert.equal(std?.extended, false);
    assert.equal(std?.dlc, 3);
    assert.equal(std?.payload.length, 3);

    const ext = parseFrameLine("18DAF110 02 3E 80", "vcan0", 1_234);
    assert.equal(ext?.id, 0x18daf110);
    assert.equal(ext?.extended, true);
    assert.equal(ext?.timestamp, 1_234, "a caller that names the instant gets it back verbatim");

    const now = parseFrameLine("7E8 01 00", "vcan0");
    assert.ok(typeof now?.timestamp === "number" && now.timestamp > 0, "default timestamp is real");
  });

  test("a frame that declares no data is valid, not truncated", () => {
    const empty = parseFrameLine("7E8 00", "vcan0");
    assert.ok(empty, "DLC 0 exists in CAN");
    assert.equal(empty.payload.length, 0);
  });
});

describe("isElmError", () => {
  test("empty and unrelated lines are not errors", () => {
    assert.equal(isElmError(""), null, "whitespace-only noise is dropped, not flagged");
    assert.equal(isElmError("   "), null);
    assert.equal(isElmError("BUS INIT: ...OK"), null);
  });

  test("exact matches and prefixes are both recognised, lower case included", () => {
    assert.equal(isElmError("STOPPED"), "STOPPED");
    assert.equal(isElmError("?"), "?");
    assert.equal(isElmError(" unable to connect "), "UNABLE TO CONNECT");
    // The prefix arm matters: the device appends a reason to the short code.
    assert.equal(isElmError("<DATA ERROR: bad checksum"), "<DATA ERROR");
    assert.equal(isElmError("FB ERROR from bus"), "FB ERROR");
  });
});

describe("assertCanSupport", () => {
  test("CAN-FD is refused by name, and the refusal is typed", () => {
    assert.throws(() => assertCanSupport(true), AdapterUnsupportedError);
    assert.equal(assertCanSupport(false), undefined, "classical CAN is supported");
  });
});

describe("MemoryByteStream edges", () => {
  test("isOpen and describe report the state the tests drive", async () => {
    const stream = new MemoryByteStream();
    assert.equal(stream.isOpen(), false);
    stream.open();
    assert.equal(stream.isOpen(), true);
    assert.equal(stream.describe(), "MemoryByteStream");
    await stream.close();
    assert.equal(stream.isOpen(), false, "a closed stream says so");
  });

  test("writing into a closed stream fails, but the bytes are still on record", async () => {
    const stream = new MemoryByteStream();
    await assert.rejects(() => stream.write("ATZ\r"), /stream is closed/);
    assert.deepEqual(stream.written, ["ATZ\r"], "nothing vanishes between the push and the throw");
  });

  test("a responder that says nothing stays silent, and unloading stops delivery", async () => {
    const stream = new MemoryByteStream();
    stream.open();
    const seen: string[] = [];
    const unsubscribe = stream.onData((chunk) => seen.push(chunk));
    stream.responder = () => null;
    await stream.write("ATRV\r");
    assert.deepEqual(seen, [], "no canned answer means no answer, not an empty one");

    stream.responder = (command) => (command === "ATZ\r" ? "> " : null);
    await stream.write("ATZ\r");
    assert.deepEqual(seen, ["> "]);
    unsubscribe();
    await stream.write("ATZ\r");
    assert.equal(seen.length, 1, "the subscription is gone");

    await stream.close();
    assert.equal(stream.isOpen(), false);
  });
});

test("a transient ELM error asks for a retry, a permanent one does not", async () => {
  // The classification lives here, the decision lives in ISO-TP (`isRetryable`
  // in connection.ts). This pins the contract between them: an adapter error
  // that the adapter itself calls transient must carry `retryable: true` into
  // the details, because that flag is the only channel between the two layers.
  // Without it a single `BUS BUSY` on a Bluetooth SPP link kills the whole
  // request instead of buying one more attempt.
  const transient = [
    "NO DATA",
    "BUFFER FULL",
    "BUS BUSY",
    "BUS ERROR",
    "CAN ERROR",
    "UNABLE TO CONNECT",
    "FB ERROR",
    "STOPPED",
  ];
  for (const error of transient) {
    const { stream } = createFakeElm({ error });
    const adapter = new Elm327Adapter({ stream, commandTimeoutMs: 500 });
    await adapter.open();
    await assert.rejects(
      adapter.send(createFrame(0x7e0, fromHex("22 F1 90"))),
      (thrown: unknown) => thrown instanceof TransportError && thrown.details?.retryable === true,
      `${error} must be classified transient`,
    );
  }

  const permanent = ["DATA ERROR", "<DATA ERROR", "ERR", "?"];
  for (const error of permanent) {
    const { stream } = createFakeElm({ error });
    const adapter = new Elm327Adapter({ stream, commandTimeoutMs: 500 });
    await adapter.open();
    await assert.rejects(
      adapter.send(createFrame(0x7e0, fromHex("22 F1 90"))),
      (thrown: unknown) => thrown instanceof TransportError && thrown.details?.retryable === false,
      `${error} must be classified permanent`,
    );
  }
});

/* ------------------------------------------------ command serialisation
 *
 * Symptom (reproduced over a PTY with a windowed device emulator, regression
 * documented in tests/integration/adapter-rehearsal.spec.ts): an ELM327 is
 * half-duplex — input while a command's receive window is still open aborts it
 * with `STOPPED`, and a second in-flight command shared exactly one
 * `currentLines` collector, so two parallel commands meant "every multi-frame
 * answer dies as `ISO-TP transmit failed: ELM327 refused the frame: STOPPED`".
 * The device-level trigger is ISO-TP sending Flow Control from inside the
 * frame listener, re-entrantly, while the triggering frame's TX still waits
 * for its prompt. The guard: one command on the wire at a time.
 */

/**
 * Drain microtasks until `needle` was written — the queue steps are promise
 * continuations, so a bounded microtask flush is the deterministic substitute
 * for a timer (AGENTS 31: no real time in unit tests).
 */
async function untilWritten(stream: MemoryByteStream, needle: string): Promise<void> {
  for (let i = 0; i < 1000 && !stream.written.some((line) => line.includes(needle)); i++) {
    await Promise.resolve();
  }
  assert.ok(
    stream.written.some((line) => line.includes(needle)),
    `"${needle}" was never written (got: ${JSON.stringify(stream.written)})`,
  );
}

test("two overlapping commands run one at a time, in order, with their own lines", async () => {
  const stream = new MemoryByteStream();
  stream.open();
  const adapter = new Elm327Adapter({
    stream,
    initSequence: [],
    commandTimeoutMs: 500,
  });
  await adapter.open();

  const first = adapter.command("ATDP");
  const second = adapter.command("ATRV");
  await untilWritten(stream, "ATDP");
  assert.equal(
    stream.written.filter((line) => line.includes("ATRV")).length,
    0,
    "the queued command must not reach the wire while the first waits for its prompt",
  );
  stream.emit("\rISO 15765-4 (CAN 11/500)\r\n>");
  assert.deepEqual(await first, ["ISO 15765-4 (CAN 11/500)"]);
  await untilWritten(stream, "ATRV");
  stream.emit("\r14.1V\r\n>");
  assert.deepEqual(await second, ["14.1V"]);
});

test("a command issued re-entrantly from a frame listener does not clobber the pending one", async () => {
  const stream = new MemoryByteStream();
  stream.open();
  const adapter = new Elm327Adapter({
    stream,
    initSequence: [],
    commandTimeoutMs: 500,
  });
  await adapter.open();

  let reentrant: Promise<string[]> | null = null;
  // The frame listener plays ISO-TP's part: a frame arrives and the reaction
  // is another command (the Flow Control send) *while the triggering command
  // is still waiting for its prompt*.
  adapter.subscribe(() => {
    reentrant = adapter.command("ATDP");
  });

  const first = adapter.command("0100");
  await untilWritten(stream, "0100");
  // The device answers with a frame line, prompt still owed.
  stream.emit("\r7E8 04 41 00 BE 3F\r\n");
  assert.ok(reentrant !== null, "the frame was dispatched");
  await Promise.resolve();
  assert.equal(
    stream.written.some((line) => line.includes("ATDP")),
    false,
    "the re-entrant command stays queued behind the pending one",
  );
  stream.emit(">");
  const firstLines = await first;
  assert.deepEqual(
    firstLines,
    ["7E8 04 41 00 BE 3F"],
    "clobbering currentLines used to make the triggering command lose its own frame line",
  );
  await untilWritten(stream, "ATDP");
  stream.emit("\rAUTO, ISO 15765-4\r\n>");
  assert.deepEqual(await reentrant, ["AUTO, ISO 15765-4"]);
});

test("a timed-out command dies alone: the queued successor still runs", async () => {
  const stream = new MemoryByteStream();
  stream.open();
  const adapter = new Elm327Adapter({
    stream,
    initSequence: [],
    commandTimeoutMs: 40,
  });
  await adapter.open();

  const first = adapter.command("ATZ");
  const second = adapter.command("ATDP");
  await untilWritten(stream, "ATZ");
  await assert.rejects(first, /timed out/, "the silent command times out");
  // The queue survived the timeout: the next command heads to the wire.
  await untilWritten(stream, "ATDP");
  stream.emit("\rAUTO, ISO 15765-4\r\n>");
  assert.deepEqual(await second, ["AUTO, ISO 15765-4"]);
  assert.ok(
    adapter.status.errors.some((message) => message.includes("timed out")),
    "the timeout is on record, not swallowed",
  );
});

test("close() fails the active and every queued command with the close as the reason", async () => {
  const stream = new MemoryByteStream();
  stream.open();
  const adapter = new Elm327Adapter({
    stream,
    initSequence: [],
    commandTimeoutMs: 5000,
  });
  await adapter.open();

  const first = adapter.command("ATZ");
  const second = adapter.command("ATDP");
  await untilWritten(stream, "ATZ");
  await adapter.close();
  await assert.rejects(first, /adapter closed/, "the active command fails with the reason");
  await assert.rejects(second, /adapter closed/, "the queued command fails with the reason");
  await assert.rejects(
    adapter.command("ATRV"),
    /adapter closed/,
    "a command issued after close fails fast instead of racing the wire",
  );
});
