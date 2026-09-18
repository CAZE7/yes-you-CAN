/**
 * ISO 15765-2 vectors: the strict reader of `vectors/isotp.json` (ADR 0045).
 *
 * The file is the one definition both sides are graded against, so parsing is
 * deliberately unforgiving (see `vector-schema.ts`). The parser is pure — text
 * in, data or errors out; reading files is the CLI's job, so this module
 * stays free of `node:`.
 */

import { ISO_TP_ERROR_CLASSES, type IsoTpResult } from "./canonical.js";
import {
  type Json,
  type Report,
  array,
  bool,
  bytes,
  fail,
  integer,
  oneOf,
  record,
  rejectExtras,
  str,
} from "./vector-schema.js";

export interface IsoTpRxEvent {
  /** A frame arriving on the wire, as raw payload bytes. */
  in?: number[];
  /** Model time passing without a frame — only meaningful with `checkCr`. */
  tickMs?: number;
  /** Ask the receiver whether its N_Cr guard fires (rx side). */
  checkCr?: boolean;
}

/**
 * A frame the peer sends, scheduled after the n-th frame *we* put on the wire
 * (0-based; default 0). Scheduling on our own emissions is what keeps a
 * transcript reproducible on a second implementation: the vector never depends
 * on wall-clock races. “Immediate” answers (before any emission) are refused
 * on both readers — that is a microtask race, not a protocol case.
 */
export type IsoTpTxPeerEntry = { after: number; frame: number[] };

export interface IsoTpVector {
  name: string;
  side: "rx" | "tx";
  config: IsoTpConfig;
  input: IsoTpRxEvent[];
  payload: number[];
  peer: IsoTpTxPeerEntry[];
  expect: IsoTpResult;
}

export interface IsoTpConfig {
  nBsMs: number;
  nCrMs: number;
  wftMax: number;
  maxRetries: number;
  blockSize: number;
  stMinMs: number;
  /** How long the runner waits for a response to arrive at all. */
  budgetMs: number;
}

const DEFAULT_CONFIG: IsoTpConfig = {
  nBsMs: 60,
  nCrMs: 60,
  wftMax: 8,
  maxRetries: 0,
  blockSize: 0,
  stMinMs: 0,
  budgetMs: 1_000,
};

function parseConfig(json: Json | undefined, path: string, report: Report): IsoTpConfig {
  if (!json) return { ...DEFAULT_CONFIG };
  rejectExtras(json, Object.keys(DEFAULT_CONFIG), path, report);
  const config: IsoTpConfig = { ...DEFAULT_CONFIG };
  for (const key of Object.keys(DEFAULT_CONFIG) as (keyof IsoTpConfig)[]) {
    const value = json[key];
    if (value === undefined) continue;
    const parsed = integer(value, `${path}.${key}`, report, 0, 600_000);
    if (parsed !== undefined) config[key] = parsed;
  }
  return config;
}

function parseResult(value: unknown, path: string, report: Report): IsoTpResult | undefined {
  const json = record(value, path, report);
  if (!json) return undefined;
  rejectExtras(json, ["delivered", "error", "sentFrames", "counters"], path, report);
  let delivered: number[] | null = null;
  if (json.delivered !== undefined && json.delivered !== null) {
    delivered = bytes(json.delivered, `${path}.delivered`, report, 4095) ?? null;
  }
  let error: IsoTpResult["error"] = null;
  if (json.error !== undefined && json.error !== null) {
    error = oneOf(json.error, `${path}.error`, report, ISO_TP_ERROR_CLASSES) ?? null;
  }
  const frames: IsoTpResult["sentFrames"] = [];
  const sentList = array(json.sentFrames ?? [], `${path}.sentFrames`, report) ?? [];
  sentList.forEach((entry, i) => {
    const frame = record(entry, `${path}.sentFrames[${i}]`, report);
    if (!frame) return;
    const pci = oneOf(frame.pci, `${path}.sentFrames[${i}].pci`, report, [
      "single",
      "first",
      "consecutive",
      "flow-control",
    ] as const);
    if (pci === "single") {
      const payload = bytes(frame.payload, `${path}.sentFrames[${i}].payload`, report, 7);
      if (payload) frames.push({ pci, payload });
    } else if (pci === "first") {
      const totalLength = integer(
        frame.totalLength,
        `${path}.sentFrames[${i}].totalLength`,
        report,
        8,
        4095,
      );
      const payload = bytes(frame.payload, `${path}.sentFrames[${i}].payload`, report, 6);
      if (totalLength !== undefined && payload) {
        frames.push({ pci, totalLength, payload });
      }
    } else if (pci === "consecutive") {
      const sn = integer(frame.sn, `${path}.sentFrames[${i}].sn`, report, 0, 15);
      const payload = bytes(frame.payload, `${path}.sentFrames[${i}].payload`, report, 7);
      if (sn !== undefined && payload) frames.push({ pci, sn, payload });
    } else if (pci === "flow-control") {
      const status = integer(frame.status, `${path}.sentFrames[${i}].status`, report, 0, 2) ?? 0;
      const blockSize =
        integer(frame.blockSize, `${path}.sentFrames[${i}].blockSize`, report, 0, 255) ?? 0;
      const stMin = integer(frame.stMin, `${path}.sentFrames[${i}].stMin`, report, 0, 127) ?? 0;
      frames.push({ pci, status, blockSize, stMin });
    }
  });
  const countersJson = record(json.counters, `${path}.counters`, report);
  const counters: IsoTpResult["counters"] = { sequenceErrors: 0, timeouts: 0, retries: 0 };
  if (countersJson) {
    rejectExtras(
      countersJson,
      ["sequenceErrors", "timeouts", "retries"],
      `${path}.counters`,
      report,
    );
    const seq = integer(
      countersJson.sequenceErrors ?? 0,
      `${path}.counters.sequenceErrors`,
      report,
      0,
      999,
    );
    const to = integer(countersJson.timeouts ?? 0, `${path}.counters.timeouts`, report, 0, 999);
    const re = integer(countersJson.retries ?? 0, `${path}.counters.retries`, report, 0, 999);
    if (seq !== undefined) counters.sequenceErrors = seq;
    if (to !== undefined) counters.timeouts = to;
    if (re !== undefined) counters.retries = re;
  }
  return { delivered, error, sentFrames: frames, counters };
}

export function parseIsoTpVectorFile(
  text: string,
): { ok: true; vectors: IsoTpVector[] } | { ok: false; errors: string[] } {
  const report: Report = { errors: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`invalid JSON: ${error instanceof Error ? error.message : "?"}`] };
  }
  const file = record(parsed, "file", report);
  if (!file) return { ok: false, errors: report.errors };
  rejectExtras(file, ["vectorSet", "modelDomain", "vectors"], "file", report);
  str(file.vectorSet, "file.vectorSet", report);
  str(file.modelDomain, "file.modelDomain", report);
  const list = array(file.vectors, "file.vectors", report) ?? [];
  if (list.length === 0)
    fail(report, "file.vectors", "a vector set must carry at least one vector");
  const vectors: IsoTpVector[] = [];
  list.forEach((entry, i) => {
    const path = `vectors[${i}]`;
    const json = record(entry, path, report);
    if (!json) return;
    rejectExtras(
      json,
      ["name", "side", "config", "input", "payload", "payloadLength", "peer", "expect"],
      path,
      report,
    );
    const name = str(json.name, `${path}.name`, report);
    const side = oneOf(json.side, `${path}.side`, report, ["rx", "tx"] as const);
    const configJson =
      json.config === undefined ? undefined : record(json.config, `${path}.config`, report);
    const config = parseConfig(configJson, `${path}.config`, report);
    const input: IsoTpRxEvent[] = [];
    const inputList = array(json.input ?? [], `${path}.input`, report) ?? [];
    inputList.forEach((event, j) => {
      const epath = `${path}.input[${j}]`;
      const ejson = record(event, epath, report);
      if (!ejson) return;
      rejectExtras(ejson, ["in", "tickMs", "checkCr"], epath, report);
      const eventOut: IsoTpRxEvent = {};
      let seen = 0;
      if (ejson.in !== undefined) {
        const frame = bytes(ejson.in, `${epath}.in`, report, 8);
        if (frame) {
          eventOut.in = frame;
          seen++;
        }
      }
      if (ejson.tickMs !== undefined) {
        const tick = integer(ejson.tickMs, `${epath}.tickMs`, report, 1, 600_000);
        if (tick !== undefined) {
          eventOut.tickMs = tick;
          seen++;
        }
      }
      if (ejson.checkCr !== undefined) {
        if (bool(ejson.checkCr, `${epath}.checkCr`, report) === true) {
          eventOut.checkCr = true;
          seen++;
        }
      }
      if (seen === 0) fail(report, epath, "must name in, tickMs or checkCr");
      input.push(eventOut);
    });
    // An empty tx payload is legal: it is the vector for the refusal itself.
    let payload: number[] = [];
    if (json.payload !== undefined) {
      const parsed = bytes(json.payload, `${path}.payload`, report, 4096, 0);
      if (parsed) payload = parsed;
    }
    if (json.payloadLength !== undefined) {
      if (json.payload !== undefined) {
        fail(report, `${path}.payloadLength`, "payload and payloadLength are alternatives");
      } else {
        const length = integer(json.payloadLength, `${path}.payloadLength`, report, 1, 8192);
        // Canonical fill (ADR 0045): `payloadLength: n` means n copies of 0x5A.
        // Both readers materialise the payload this way — no file bloat for
        // boundary vectors around the 4095-byte FF_DL ceiling.
        if (length !== undefined) payload = new Array<number>(length).fill(0x5a);
      }
    }
    const peer: IsoTpTxPeerEntry[] = [];
    const peerList = array(json.peer ?? [], `${path}.peer`, report) ?? [];
    peerList.forEach((entry, j) => {
      const ppath = `${path}.peer[${j}]`;
      const peerJson = record(entry, ppath, report);
      if (!peerJson) return;
      rejectExtras(peerJson, ["after", "frame"], ppath, report);
      // `after` is the index of our emission the entry waits for; “immediate”
      // is refused on both readers: a response before the first frame is a
      // microtask race, not a protocol case (ADR 0045).
      let after = 0;
      if (peerJson.after !== undefined) {
        const idx = integer(peerJson.after, `${ppath}.after`, report, 0, 64);
        if (idx === undefined) return;
        after = idx;
      }
      const frame = bytes(peerJson.frame, `${ppath}.frame`, report, 8);
      if (frame) peer.push({ after, frame });
    });
    const expect = parseResult(json.expect, `${path}.expect`, report);
    if (side === "rx" && input.length === 0)
      fail(report, `${path}.input`, "an rx vector needs input frames");
    if (side === "tx" && json.payload === undefined && json.payloadLength === undefined) {
      fail(report, `${path}.payload`, "a tx vector needs a payload or payloadLength");
    }
    if (name !== undefined && side !== undefined && expect) {
      vectors.push({ name, side, config, input, payload, peer, expect });
    }
  });
  const names = new Map<string, number>();
  vectors.forEach((v, i) => {
    const seen = names.get(v.name);
    if (seen !== undefined) {
      fail(
        report,
        `vectors[${i}]`,
        `duplicate vector name "${v.name}" (first seen at vectors[${seen}])`,
      );
    }
    names.set(v.name, i);
  });
  if (report.errors.length === 0 && vectors.length !== list.length) {
    fail(
      report,
      "file.vectors",
      "some vectors were dropped without a parse error — the parser is wrong, not the file",
    );
  }
  if (report.errors.length > 0) return { ok: false, errors: report.errors };
  return { ok: true, vectors };
}
