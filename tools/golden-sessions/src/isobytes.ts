/**
 * ISO-TP aware byte editing of a recorded trace (master backlog P0 #10).
 *
 * A VIN is 17 characters. On classic CAN an ISO-TP *single* frame carries 7 of
 * them at most, so the number is spread over a First Frame and Consecutive
 * Frames. Searching the recorded payloads for the 17 bytes therefore finds
 * nothing — and a redaction that finds nothing deletes nothing while looking like
 * it worked. That is the failure mode this module exists to remove: the frames are
 * reassembled into the messages they form, the replacement happens *inside a
 * message*, and the result is written back into exactly the frame bytes it came
 * from.
 *
 * The framing vocabulary (single/first/consecutive/flow control) comes from the
 * transport layer (`FRAME_TYPE`) rather than being restated here.
 */

import { FRAME_TYPE } from "@vdp/transport-iso-tp";
import type { GoldenTraceEntry } from "./format.js";

/** Where one byte of a reassembled message lives inside the trace. */
interface BytePosition {
  frameIndex: number;
  byteIndex: number;
}

export interface ReassembledMessage {
  /** Message payload without any PCI bytes. */
  payload: number[];
  /** For every payload byte: the frame byte it came from. */
  positions: BytePosition[];
  /** False when the trace ends before the announced length arrived. */
  complete: boolean;
}

/** One byte of the search sequence and where it was found. */
export interface ByteHit extends BytePosition {
  /** Index inside the search sequence (0 for its first byte). */
  sequenceIndex: number;
}

/** PCI bytes of a frame, honouring extended addressing (one address byte first). */
function pciOffset(entry: GoldenTraceEntry): number {
  return entry.extended === true ? 1 : 0;
}

/** Hex payload of a trace entry as bytes — the format `vdp.session` stores. */
export function frameBytes(entry: GoldenTraceEntry): number[] {
  const bytes: number[] = [];
  for (let index = 0; index + 1 < entry.payload.length; index += 2) {
    bytes.push(Number.parseInt(entry.payload.slice(index, index + 2), 16));
  }
  return bytes;
}

/** Bytes back into the uppercase hex form the trace uses. */
export function bytesToHex(bytes: readonly number[]): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0").toUpperCase();
  return out;
}

/**
 * Reassemble the ISO-TP messages one direction of one identifier forms.
 *
 * Flow control frames are skipped (they belong to the conversation, not to a
 * message payload), and a frame that continues no message is skipped as well — a
 * trace is evidence, and a reader that throws on an unexpected frame would make a
 * recording unreadable for a cosmetic reason.
 */
export function reassemble(
  trace: readonly GoldenTraceEntry[],
  frameIndexes: readonly number[],
): ReassembledMessage[] {
  const messages: ReassembledMessage[] = [];
  let current: ReassembledMessage | null = null;
  let remaining = 0;

  for (const frameIndex of frameIndexes) {
    const entry = trace[frameIndex];
    if (!entry) continue;
    const bytes = frameBytes(entry);
    const offset = pciOffset(entry);
    const pci = bytes[offset];
    if (pci === undefined) continue;
    const type = pci >> 4;

    if (current && remaining > 0 && type === FRAME_TYPE.CONSECUTIVE >> 4) {
      for (let index = offset + 1; index < bytes.length && remaining > 0; index++) {
        current.payload.push(bytes[index] as number);
        current.positions.push({ frameIndex, byteIndex: index });
        remaining--;
      }
      if (remaining === 0) {
        current.complete = true;
        messages.push(current);
        current = null;
      }
      continue;
    }

    if (type === FRAME_TYPE.SINGLE >> 4) {
      const length = pci & 0x0f;
      const message: ReassembledMessage = { payload: [], positions: [], complete: true };
      for (
        let index = offset + 1;
        index < bytes.length && message.payload.length < length;
        index++
      ) {
        message.payload.push(bytes[index] as number);
        message.positions.push({ frameIndex, byteIndex: index });
      }
      messages.push(message);
      current = null;
      remaining = 0;
      continue;
    }

    if (type === FRAME_TYPE.FIRST >> 4) {
      const length = ((pci & 0x0f) << 8) | (bytes[offset + 1] ?? 0);
      const message: ReassembledMessage = { payload: [], positions: [], complete: false };
      for (let index = offset + 2; index < bytes.length; index++) {
        message.payload.push(bytes[index] as number);
        message.positions.push({ frameIndex, byteIndex: index });
      }
      current = message;
      remaining = length - message.payload.length;
      if (remaining <= 0) {
        message.complete = true;
        messages.push(message);
        current = null;
        remaining = 0;
      }
      continue;
    }

    // Flow control (or a reserved type): not part of a message payload.
    current = null;
    remaining = 0;
  }

  if (current && !current.complete) messages.push(current);
  return messages;
}

function sequenceStarts(haystack: readonly number[], needle: readonly number[]): number[] {
  const starts: number[] = [];
  if (needle.length === 0 || haystack.length < needle.length) return starts;
  outer: for (let start = 0; start <= haystack.length - needle.length; start++) {
    for (let index = 0; index < needle.length; index++) {
      if (haystack[start + index] !== needle[index]) continue outer;
    }
    starts.push(start);
  }
  return starts;
}

/** Which trace frames belong to which reassembly group (direction + id + mode). */
function groupFrames(
  trace: readonly GoldenTraceEntry[],
  filter: (entry: GoldenTraceEntry) => boolean,
): number[][] {
  const groups = new Map<string, number[]>();
  trace.forEach((entry, index) => {
    if (!filter(entry)) return;
    const key = `${entry.direction}:${entry.canId}:${entry.extended === true ? "e" : "n"}`;
    const list = groups.get(key) ?? [];
    list.push(index);
    groups.set(key, list);
  });
  return [...groups.values()];
}

/**
 * Every place in the trace where `search` appears inside a *reassembled* message.
 *
 * The caller decides what to do with the hits; this function only reports
 * positions, so "was a replacement possible at all" is observable and testable —
 * the point of the exercise.
 */
export function findBytesInMessages(
  trace: readonly GoldenTraceEntry[],
  search: readonly number[],
  filter: (entry: GoldenTraceEntry) => boolean = () => true,
): ByteHit[] {
  const hits: ByteHit[] = [];
  for (const frameIndexes of groupFrames(trace, filter)) {
    for (const message of reassemble(trace, frameIndexes)) {
      for (const start of sequenceStarts(message.payload, search)) {
        for (let index = 0; index < search.length; index++) {
          const position = message.positions[start + index];
          if (position) hits.push({ ...position, sequenceIndex: index });
        }
      }
    }
  }
  return hits;
}

/** True when at least one message contains the sequence. */
export function containsInMessages(
  trace: readonly GoldenTraceEntry[],
  search: readonly number[],
): boolean {
  return findBytesInMessages(trace, search).length > 0;
}

/**
 * Apply replacements to a trace, returning new entries — the input is not touched.
 *
 * The replacement is written per byte, which is what keeps frame structure,
 * lengths and every checksum-free offset downstream intact: only the characters
 * change.
 */
export function applyReplacements(
  trace: readonly GoldenTraceEntry[],
  hits: readonly ByteHit[],
  replacement: readonly number[],
): GoldenTraceEntry[] {
  const byFrame = new Map<number, ByteHit[]>();
  for (const hit of hits) {
    const list = byFrame.get(hit.frameIndex) ?? [];
    list.push(hit);
    byFrame.set(hit.frameIndex, list);
  }
  return trace.map((entry, index) => {
    const frameHits = byFrame.get(index);
    if (!frameHits || frameHits.length === 0) return entry;
    const bytes = frameBytes(entry);
    for (const hit of frameHits) {
      const value = replacement[hit.sequenceIndex];
      if (value !== undefined) bytes[hit.byteIndex] = value;
    }
    return { ...entry, payload: bytesToHex(bytes) };
  });
}
