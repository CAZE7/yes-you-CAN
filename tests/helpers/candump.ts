/**
 * Reader for candump / SocketCAN logs (AGENTS 7, 18, 31.5).
 *
 * A trace fixture is a *recording of a bus*, not a table of expectations, so it
 * arrives in the syntax the CAN tools write. `candump` has two families of it:
 *
 * ```text
 * (1790035200.001000) vcan0 7E8#101462F190314847      candump -l / -L  (log file)
 * (1790035200.001000) vcan0 7E8##00101462F1903148      candump -l of a CAN-FD frame
 * (0.001000)  vcan0  7E8   [8]  10 14 62 F1 90 31 48   candump -tz / -ta (console)
 *   vcan0  7E8   [8]  10 14 62 F1 90 31 48 47          candump (console, no clock)
 * ```
 *
 * The first three forms are parsed here; the fourth (no timestamp at all) is
 * delegated to `parseTraceLine` from `@vdp/trace-analyzer`, which already reads
 * the console form for offline analysis — a second reader for the same line
 * would be a second opinion about what a trace says (AGENTS 34.2: reuse).
 *
 * Two decisions matter for the tests that use this:
 *
 *  - **A line this reader does not understand is reported, never dropped.** The
 *    fixtures are witnesses; silently skipping half a trace would turn a broken
 *    recording into a green test. `rejected` carries line number, text and reason,
 *    `ignored` carries frames that are on the bus but not part of the conversation
 *    (foreign identifiers), and `comments` carries the documentation of the file.
 *  - **Direction comes from the identifier pair.** A candump log records what the
 *    socket saw — both directions, without a marker. The caller says which id is
 *    its own transmission (`txId`); everything on `rxId` is incoming. That is how
 *    every workshop tool splits a log, and it is why the fixtures document their
 *    identifier pair in the header.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fromHex } from "@vdp/shared";
import { parseTraceLine } from "@vdp/trace-analyzer";
import type { ReplayFrameEntry, ReplayRecording } from "@vdp/transport-can";

/** Directory the trace fixtures live in. */
export const TRACES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/traces");

/** What the caller knows about the bus the log was recorded on. */
export interface CandumpOptions {
  /** Identifier this node transmits on — those frames are `tx`. */
  txId: number;
  /**
   * Identifier the peer transmits on — those frames are `rx`. Optional: without
   * it every foreign frame counts as incoming, which is right for a point-to-point
   * log and wrong for a busy bus.
   */
  rxId?: number;
  /** Interface name the log must have been recorded on; other lines are ignored. */
  channel?: string;
}

/** One line of the log, classified. */
export interface CandumpLine {
  /** 1-based line number in the file. */
  line: number;
  /** The line as it stands in the file. */
  text: string;
  kind: "frame" | "comment" | "blank" | "rejected" | "ignored";
  /** Why a line was not read as a frame of this conversation. */
  reason?: string;
}

/**
 * A frame the reader accepted. `seconds` is `null` for the console form, which
 * carries no clock at all — the caller's synthetic grid replaces it.
 */
interface ParsedFrame {
  seconds: number | null;
  channel: string;
  canId: number;
  extended: boolean;
  fd: boolean;
  payload: Uint8Array;
}

/** A frame with its clock resolved — the synthetic grid replaced a missing one. */
interface TimedFrame extends ParsedFrame {
  seconds: number;
}

/** The whole log: frames ready for replay, plus everything the reader refused. */
export interface CandumpTrace {
  /** Interface name seen in the log (`vcan0`), or the one the caller asked for. */
  channel: string;
  /** Frames of this conversation, `t` in milliseconds relative to the first frame. */
  frames: ReplayFrameEntry[];
  /** Duration of the recording in ms — the trace's own timing, not a replay budget. */
  durationMs: number;
  /** Comment lines (`#`, `;`, `//`) — the fixture documentation lives here. */
  comments: string[];
  /** Lines that are neither a known frame form nor a comment: a broken log. */
  rejected: CandumpLine[];
  /** Frames on the bus that do not belong to this conversation. */
  ignored: CandumpLine[];
  /** Every classified line, for a test that wants to see the whole reading. */
  lines: CandumpLine[];
}

/** `(<seconds>.<microseconds>) <iface> <id>#<data>` — candump log format. */
const LOG_LINE = /^\((\d+(?:\.\d+)?)\)\s+(\S+)\s+([0-9A-Fa-f]{3,8})(##?)([0-9A-Fa-f]*)$/;

/** `(<seconds>) <iface> <id> [<dlc>] <data bytes>` — candump console with a clock. */
const STAMPED_CONSOLE_LINE =
  /^\((\d+(?:\.\d+)?)\)\s+(\S+)\s+([0-9A-Fa-f]{3,8})\s+\[(\d+)]\s*((?:[0-9A-Fa-f]{2}\s*)*)$/i;

const COMMENT = /^\s*(?:#|;|\/\/)/;

/** `  vcan0  7E0   [3]  …` — the console form's leading interface name. */
const CONSOLE_INTERFACE = /^\s*([A-Za-z][\w-]*)\s+[0-9A-Fa-f]{3,8}\s+\[\d+]/;

/** Read a fixture from `tests/fixtures/traces/` and parse it. */
export function readTraceFixture(fileName: string, options: CandumpOptions): CandumpTrace {
  return parseCandumpLog(readFileSync(join(TRACES_DIR, fileName), "utf8"), options);
}

/**
 * Parse a candump/SocketCAN log.
 *
 * Timestamps become milliseconds relative to the first frame of the conversation,
 * which is the unit `ReplayTransport` replays with. Absolute epoch seconds are
 * kept in the log because that is what `candump -l` writes; a log without any
 * clock (console form) gets the same synthetic 1 ms grid `parseTrace` uses.
 */
export function parseCandumpLog(text: string, options: CandumpOptions): CandumpTrace {
  const lines: CandumpLine[] = [];
  const comments: string[] = [];
  const accepted: Array<{ frame: TimedFrame; line: CandumpLine }> = [];
  const ignored: CandumpLine[] = [];
  const rejected: CandumpLine[] = [];

  let syntheticSeconds = 0;
  const raw = text.split("\n");
  for (let index = 0; index < raw.length; index += 1) {
    const text0 = raw[index] ?? "";
    const line = index + 1;
    if (text0.trim() === "") {
      lines.push({ line, text: text0, kind: "blank" });
      continue;
    }
    if (COMMENT.test(text0)) {
      const entry: CandumpLine = { line, text: text0, kind: "comment" };
      comments.push(text0.replace(/^\s*(?:#\s?|;\s?|\/\/\s?)/, ""));
      lines.push(entry);
      continue;
    }

    const parsed = readFrameLine(text0.trim());
    if (parsed === null) {
      const entry: CandumpLine = {
        line,
        text: text0,
        kind: "rejected",
        reason: "not a known candump line (log, FD log or console form)",
      };
      rejected.push(entry);
      lines.push(entry);
      continue;
    }
    if (parsed.problem !== undefined) {
      const entry: CandumpLine = { line, text: text0, kind: "rejected", reason: parsed.problem };
      rejected.push(entry);
      lines.push(entry);
      continue;
    }
    const frame = parsed.frame;
    if (frame === undefined) continue; // unreachable: `problem` was handled above
    if (options.channel !== undefined && frame.channel !== options.channel) {
      const entry: CandumpLine = {
        line,
        text: text0,
        kind: "ignored",
        reason: `interface ${frame.channel}, the caller asked for ${options.channel}`,
      };
      ignored.push(entry);
      lines.push(entry);
      continue;
    }
    const isTx = frame.canId === options.txId;
    const isRx = options.rxId === undefined ? !isTx : frame.canId === options.rxId;
    if (!isTx && !isRx) {
      const entry: CandumpLine = {
        line,
        text: text0,
        kind: "ignored",
        reason: `identifier 0x${frame.canId.toString(16)} is not part of the 0x${options.txId.toString(16)}/0x${(options.rxId ?? 0).toString(16)} pair`,
      };
      ignored.push(entry);
      lines.push(entry);
      continue;
    }
    // The console form carries no clock: a 1 ms grid keeps the order and gives
    // the replay something to pace with, exactly like `parseTrace` does.
    const seconds = frame.seconds ?? (syntheticSeconds += 0.001);
    const entry: CandumpLine = { line, text: text0, kind: "frame" };
    lines.push(entry);
    accepted.push({ frame: { ...frame, seconds }, line: entry });
  }

  const first = accepted[0]?.frame.seconds ?? 0;
  const frames: ReplayFrameEntry[] = accepted.map(({ frame }) => ({
    t: relativeMs(frame.seconds, first),
    canId: frame.canId,
    direction: frame.canId === options.txId ? ("tx" as const) : ("rx" as const),
    payload: frame.payload,
    channel: frame.channel,
    extended: frame.extended,
    fd: frame.fd,
  }));
  const last = accepted.at(-1)?.frame.seconds ?? first;

  return {
    channel: accepted[0]?.frame.channel ?? options.channel ?? "can0",
    frames,
    durationMs: relativeMs(last, first),
    comments,
    rejected,
    ignored,
    lines,
  };
}

/** Milliseconds between two log timestamps, without float dust. */
function relativeMs(seconds: number, base: number): number {
  return Number(((seconds - base) * 1000).toFixed(3));
}

/** One frame line in any of the supported syntaxes; `problem` when it does not parse. */
function readFrameLine(
  line: string,
): { frame: ParsedFrame; problem?: undefined } | { frame?: undefined; problem: string } {
  const log = LOG_LINE.exec(line);
  if (log) {
    const seconds = Number.parseFloat(log[1] ?? "0");
    const channel = log[2] ?? "";
    const idText = log[3] ?? "";
    const fdMarker = log[4] ?? "#";
    const dataText = log[5] ?? "";
    if (dataText.length % 2 !== 0) {
      return { problem: `odd number of hex digits in the frame data ("${dataText}")` };
    }
    // `##` is the CAN-FD form: the first byte after it is the frame's flags byte
    // (candump writes it as two hex digits), the rest is data.
    const flagsLength = fdMarker === "##" ? 2 : 0;
    if (dataText.length < flagsLength) {
      return { problem: "CAN FD marker without a flags byte" };
    }
    const payload = fromHex(dataText.slice(flagsLength));
    if (payload.length === 0) {
      return { problem: "frame without data bytes" };
    }
    return {
      frame: {
        seconds,
        channel,
        canId: Number.parseInt(idText, 16),
        extended: idText.length > 3,
        fd: fdMarker === "##",
        payload,
      },
    };
  }

  const stamped = STAMPED_CONSOLE_LINE.exec(line);
  if (stamped) {
    const seconds = Number.parseFloat(stamped[1] ?? "0");
    const channel = stamped[2] ?? "";
    const idText = stamped[3] ?? "";
    const dlc = Number.parseInt(stamped[4] ?? "0", 10);
    const payload = fromHex((stamped[5] ?? "").replace(/\s+/g, ""));
    if (payload.length !== dlc) {
      // A frame whose data is shorter than its DLC was cut off — reading it as a
      // shorter message would invent bytes the sender never put on the bus
      // (ADR 0039: a truncated frame is an error, not an empty buffer).
      return { problem: `DLC ${dlc} but ${payload.length} data byte(s) in the line` };
    }
    if (payload.length === 0) {
      return { problem: "frame without data bytes" };
    }
    return {
      frame: {
        seconds,
        channel,
        canId: Number.parseInt(idText, 16),
        extended: idText.length > 3,
        fd: false,
        payload,
      },
    };
  }

  // The console form without a clock is already read by the offline analyzer; this
  // reader adds the timestamp and the DLC discipline on top of that one answer.
  // `parseTraceLine` takes the interface name from its caller (it cannot know which
  // token of a line is the socket), so the console shape hands it over here.
  const plain = parseTraceLine(line, CONSOLE_INTERFACE.exec(line)?.[1] ?? "trace");
  if (plain) {
    const payload = Uint8Array.from(plain.frame.payload);
    if (payload.length === 0) return { problem: "frame without data bytes" };
    if (payload.length !== plain.frame.dlc) {
      return {
        problem: `DLC ${plain.frame.dlc} but ${payload.length} data byte(s) in the line`,
      };
    }
    return {
      frame: {
        seconds: null,
        channel: plain.frame.channel,
        canId: plain.frame.id,
        extended: plain.frame.extended,
        fd: plain.frame.fd,
        payload,
      },
    };
  }
  return { problem: "not a known candump line (log, FD log or console form)" };
}

/** The frames of a trace as a `ReplayTransport` recording. */
export function toRecording(trace: CandumpTrace): ReplayRecording {
  return { channel: trace.channel, frames: trace.frames };
}
