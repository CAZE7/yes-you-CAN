/**
 * ISO 15765-2 frame reader and trace validator.
 *
 * Deliberately independent of `@vdp/transport-iso-tp`: the point of validating a
 * recorded trace is to catch a wrong implementation, and an implementation can
 * only be checked by something that does not share its code path. This module
 * therefore reads PCI bytes straight from the standard (ISO 15765-2 §8/§9) and
 * reassembles segmented messages itself.
 *
 * Used by `tests/integration/iso-tp-trace.spec.ts` to prove the recorded candump
 * fixtures are structurally valid ISO-TP before they are replayed through the
 * real stack.
 */

/** Flow status of a Flow Control frame (ISO 15765-2 Table 22). */
export type FlowStatus = "continueToSend" | "wait" | "overflow" | "reserved";

export interface SingleFrameInfo {
  kind: "single";
  /** SF_DL — the length the PCI announces. */
  announcedLength: number;
  data: Uint8Array;
}

export interface FirstFrameInfo {
  kind: "first";
  /** FF_DL — the length of the whole message. */
  announcedLength: number;
  data: Uint8Array;
}

export interface ConsecutiveFrameInfo {
  kind: "consecutive";
  sequenceNumber: number;
  data: Uint8Array;
}

export interface FlowControlInfo {
  kind: "flow-control";
  status: FlowStatus;
  /** Block Size: 0 means "send the rest without further Flow Control". */
  blockSize: number;
  /** STmin converted to milliseconds (0xF1–0xF9 are sub-millisecond). */
  separationTimeMs: number;
  /** The raw STmin byte, as recorded. */
  separationTimeRaw: number;
  /** True when STmin lies in a reserved range (0x80–0xF0, 0xFA–0xFF). */
  separationTimeReserved: boolean;
}

export type IsoTpFrameInfo =
  | SingleFrameInfo
  | FirstFrameInfo
  | ConsecutiveFrameInfo
  | FlowControlInfo
  | { kind: "invalid"; reason: string };

/** Decode one frame's PCI. `frameLength` is the CAN MTU the frame was sent with. */
export function readIsoTpFrame(
  payload: Uint8Array,
  options: { fd?: boolean; frameLength?: number } = {},
): IsoTpFrameInfo {
  const fd = options.fd ?? false;
  const mtu = options.frameLength ?? (fd ? 64 : 8);
  const first = payload[0];
  if (first === undefined) return { kind: "invalid", reason: "frame without data" };
  const pci = first >> 4;

  switch (pci) {
    case 0x0: {
      let announcedLength = first & 0x0f;
      let dataStart = 1;
      if (announcedLength === 0) {
        // SF_DL = 0 is the CAN FD escape: the length follows in the next byte
        // (ISO 15765-2 §9.4.2). On classic CAN it is a protocol error.
        if (!fd) return { kind: "invalid", reason: "SF_DL = 0 is only valid on CAN FD" };
        const escaped = payload[1];
        if (escaped === undefined)
          return { kind: "invalid", reason: "SF escape without length byte" };
        announcedLength = escaped;
        dataStart = 2;
      }
      if (announcedLength > mtu - dataStart) {
        return {
          kind: "invalid",
          reason: `SF_DL ${announcedLength} exceeds the ${mtu - dataStart} data bytes the frame can carry`,
        };
      }
      return {
        kind: "single",
        announcedLength,
        data: payload.subarray(dataStart, dataStart + announcedLength),
      };
    }
    case 0x1: {
      const high = first & 0x0f;
      const low = payload[1];
      if (low === undefined) return { kind: "invalid", reason: "First Frame without length byte" };
      let announcedLength = (high << 8) | low;
      let dataStart = 2;
      if (announcedLength === 0) {
        // FF_DL = 0 is the CAN FD escape: a 32-bit length follows (ISO 15765-2 §9.5.2).
        if (!fd) return { kind: "invalid", reason: "FF_DL = 0 is only valid on CAN FD" };
        const escaped =
          (payload[2] ?? 0) * 0x1000000 +
          (payload[3] ?? 0) * 0x10000 +
          (payload[4] ?? 0) * 0x100 +
          (payload[5] ?? 0);
        announcedLength = escaped;
        dataStart = 6;
      }
      if (announcedLength <= mtu - 1) {
        return {
          kind: "invalid",
          reason: `FF_DL ${announcedLength} would have fit into a Single Frame`,
        };
      }
      return { kind: "first", announcedLength, data: payload.subarray(dataStart) };
    }
    case 0x2:
      return { kind: "consecutive", sequenceNumber: first & 0x0f, data: payload.subarray(1) };
    case 0x3: {
      const blockSize = payload[1];
      const stmin = payload[2];
      if (blockSize === undefined || stmin === undefined) {
        return { kind: "invalid", reason: "Flow Control without BS or STmin" };
      }
      return {
        kind: "flow-control",
        status: flowStatusOf(first & 0x0f),
        blockSize,
        ...separationTimeOf(stmin),
      };
    }
    default:
      return { kind: "invalid", reason: `reserved PCI type 0x${pci.toString(16)}` };
  }
}

function flowStatusOf(value: number): FlowStatus {
  switch (value) {
    case 0x0:
      return "continueToSend";
    case 0x1:
      return "wait";
    case 0x2:
      return "overflow";
    default:
      return "reserved";
  }
}

/** STmin → milliseconds; reserved ranges are reported, not silently zeroed. */
export function separationTimeOf(stmin: number): {
  separationTimeMs: number;
  separationTimeRaw: number;
  separationTimeReserved: boolean;
} {
  if (stmin <= 0x7f) {
    return { separationTimeMs: stmin, separationTimeRaw: stmin, separationTimeReserved: false };
  }
  if (stmin >= 0xf1 && stmin <= 0xf9) {
    // 100 µs … 900 µs (ISO 15765-2 Table 24).
    return {
      separationTimeMs: (stmin - 0xf0) / 10,
      separationTimeRaw: stmin,
      separationTimeReserved: false,
    };
  }
  return { separationTimeMs: 0, separationTimeRaw: stmin, separationTimeReserved: true };
}

/** One frame of a trace, as far as ISO-TP validation is concerned. */
export interface TraceFrameLike {
  canId: number;
  direction: "tx" | "rx";
  payload: Uint8Array;
  fd?: boolean;
}

/** A message the validator reassembled from one or more frames. */
export interface ReassembledMessage {
  canId: number;
  direction: "tx" | "rx";
  payload: Uint8Array;
  /** Indices into the validated frame list, in wire order. */
  frameIndices: number[];
  segmented: boolean;
  /** FF_DL, for segmented messages. */
  announcedLength?: number;
}

/** A Flow Control frame, with the First Frame it answers. */
export interface FlowControlEvent {
  frameIndex: number;
  /** Index of the First Frame this Flow Control answers, when there was one. */
  answersFrameIndex: number | null;
  info: FlowControlInfo;
}

export interface IsoTpTraceValidation {
  messages: ReassembledMessage[];
  flowControls: FlowControlEvent[];
  /** Rule violations, each prefixed with the offending frame index. */
  problems: string[];
}

interface PendingMessage {
  canId: number;
  direction: "tx" | "rx";
  announcedLength: number;
  chunks: Uint8Array[];
  received: number;
  expectedSequence: number;
  frameIndices: number[];
  flowControlSeen: boolean;
}

/**
 * Validate a frame list against ISO 15765-2 and reassemble its messages.
 *
 * Checks, in wire order: PCI ranges, SF_DL against the frame's own data length,
 * FF_DL against the reassembled total, Sequence Numbers incrementing modulo 16,
 * a Flow Control after every First Frame (from the other side of the conversation),
 * and no interleaved second message on the same identifier.
 */
export function validateIsoTpTrace(frames: readonly TraceFrameLike[]): IsoTpTraceValidation {
  const messages: ReassembledMessage[] = [];
  const flowControls: FlowControlEvent[] = [];
  const problems: string[] = [];
  const pending = new Map<number, PendingMessage>();
  /** Identifier of the message that is waiting for its Flow Control. */
  let awaitingFlowControlFor: number | null = null;
  let awaitingFlowControlIndex = -1;

  frames.forEach((frame, index) => {
    const info = readIsoTpFrame(frame.payload, { fd: frame.fd ?? false });
    if (info.kind === "invalid") {
      problems.push(`frame ${index} (0x${frame.canId.toString(16)}): ${info.reason}`);
      return;
    }

    if (info.kind === "flow-control") {
      flowControls.push({
        frameIndex: index,
        answersFrameIndex: awaitingFlowControlFor === null ? null : awaitingFlowControlIndex,
        info,
      });
      if (awaitingFlowControlFor === null) {
        problems.push(`frame ${index}: Flow Control without a preceding First Frame`);
        return;
      }
      const state = pending.get(awaitingFlowControlFor);
      if (state) state.flowControlSeen = true;
      if (info.status === "overflow") {
        problems.push(`frame ${index}: receiver reported buffer overflow (FS = 2)`);
      }
      awaitingFlowControlFor = null;
      return;
    }

    if (info.kind === "single") {
      if (info.announcedLength !== info.data.length) {
        problems.push(
          `frame ${index}: SF_DL ${info.announcedLength} but ${info.data.length} data bytes in the frame`,
        );
      }
      if (pending.has(frame.canId)) {
        problems.push(
          `frame ${index}: Single Frame while a segmented message on 0x${frame.canId.toString(16)} is still open`,
        );
      }
      messages.push({
        canId: frame.canId,
        direction: frame.direction,
        payload: Uint8Array.from(info.data),
        frameIndices: [index],
        segmented: false,
      });
      return;
    }

    if (info.kind === "first") {
      if (pending.has(frame.canId)) {
        problems.push(
          `frame ${index}: First Frame while a segmented message on 0x${frame.canId.toString(16)} is still open`,
        );
        pending.delete(frame.canId);
      }
      pending.set(frame.canId, {
        canId: frame.canId,
        direction: frame.direction,
        announcedLength: info.announcedLength,
        chunks: [Uint8Array.from(info.data)],
        received: info.data.length,
        expectedSequence: 1,
        frameIndices: [index],
        flowControlSeen: false,
      });
      awaitingFlowControlFor = frame.canId;
      awaitingFlowControlIndex = index;
      return;
    }

    // Consecutive Frame.
    const state = pending.get(frame.canId);
    if (!state) {
      problems.push(
        `frame ${index}: Consecutive Frame on 0x${frame.canId.toString(16)} without a First Frame`,
      );
      return;
    }
    if (!state.flowControlSeen) {
      problems.push(
        `frame ${index}: Consecutive Frame before the Flow Control for frame ${awaitingFlowControlIndex} arrived`,
      );
    }
    if (info.sequenceNumber !== state.expectedSequence) {
      problems.push(
        `frame ${index}: Sequence Number ${info.sequenceNumber}, expected ${state.expectedSequence}`,
      );
    }
    state.expectedSequence = (state.expectedSequence + 1) % 16;
    state.chunks.push(Uint8Array.from(info.data));
    state.received += info.data.length;
    state.frameIndices.push(index);

    if (state.received >= state.announcedLength) {
      const payload = concat(state.chunks).subarray(0, state.announcedLength);
      if (state.received !== state.announcedLength) {
        problems.push(
          `frame ${index}: FF_DL ${state.announcedLength} but the Consecutive Frames carried ${state.received} bytes`,
        );
      }
      messages.push({
        canId: state.canId,
        direction: state.direction,
        payload: Uint8Array.from(payload),
        frameIndices: state.frameIndices,
        segmented: true,
        announcedLength: state.announcedLength,
      });
      pending.delete(frame.canId);
      if (awaitingFlowControlFor === frame.canId) awaitingFlowControlFor = null;
    }
  });

  for (const state of pending.values()) {
    problems.push(
      `frame ${state.frameIndices[0]}: message on 0x${state.canId.toString(16)} never completed — FF_DL ${state.announcedLength}, ${state.received} bytes received`,
    );
  }

  return { messages, flowControls, problems };
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
