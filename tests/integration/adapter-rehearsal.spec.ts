/**
 * Adapter rehearsal — the hardware-day scenarios, without the hardware (AGENTS 31, 32).
 *
 * A scripted adapter firmware + ECU sits on the far end of a socat PTY pair;
 * the production path runs through it end to end:
 * `openSerialStream → adapter → IsoTpConnection → UDS payload`.
 *
 * Why this file exists (symptoms it pins):
 * - An ELM327 is half-duplex: input inside its receive window aborts the window
 *   with `STOPPED` (PIC18F25K80 clones — prompt-before-window, frames arrive
 *   before the prompt). Before the adapter serialised its commands, ISO-TP's
 *   re-entrant Flow Control landed exactly there and *every multi-frame answer
 *   died* as `ISO-TP transmit failed: ELM327 refused the frame: STOPPED` —
 *   which reads like a silent ECU when it is the adapter stringing on itself.
 *   Device variants A (prompt immediately) and B (windowed + late prompt)
 *   model the two timings real units show.
 * - slcan answers every command (CR ack / BEL); before the open() handshake a
 *   CANable that never configured read as a connected-but-silent bus.
 *
 * `socat` is optional: without it the scenarios skip with their reason.
 */

import assert from "node:assert/strict";
import { constants } from "node:fs";
import { type FileHandle, open as openFile } from "node:fs/promises";
import { CanableAdapter } from "@vdp/adapter-canable";
import { Elm327Adapter } from "@vdp/adapter-elm327";
import { openSerialStream } from "@vdp/adapter-host";
import { createLogger, TransportError } from "@vdp/shared";
import { IsoTpConnection } from "@vdp/transport-iso-tp";
import { test } from "vitest";
import { createPtyPair, hasSocat, type PtyPair } from "../helpers/pty.js";
import { tick } from "../helpers/wait.js";

/* --------------------------------------------------------- shared plumbing */

interface WireEntry {
  t: number;
  dir: "host->dev" | "dev->host";
  text: string;
}

/** Serial device end of a PTY pair: reads command lines, emits reply bytes. */
abstract class PtyDevice {
  readonly wire: WireEntry[] = [];
  protected handle: FileHandle | null = null;
  private reading = false;
  private commandBuffer = Buffer.alloc(0);
  private readonly startedAt = Date.now();

  constructor(protected readonly path: string) {}

  async start(): Promise<void> {
    const { O_RDWR = 2, O_NOCTTY = 0, O_NONBLOCK = 0 } = constants ?? {};
    this.handle = await openFile(this.path, O_RDWR | O_NOCTTY | O_NONBLOCK);
    this.reading = true;
    void this.readLoop();
  }

  async stop(): Promise<void> {
    this.reading = false;
    await this.handle?.close().catch(() => undefined);
  }

  wireLog(): string {
    return this.wire
      .map(
        (e) =>
          `  ${String(e.t).padStart(5, " ")} ms ${e.dir === "host->dev" ? "→" : "←"} ${e.text}`,
      )
      .join("\n");
  }

  private log(dir: WireEntry["dir"], text: string): void {
    this.wire.push({ t: Date.now() - this.startedAt, dir, text });
  }

  protected async writeOut(text: string): Promise<void> {
    if (!this.handle) return;
    this.log("dev->host", JSON.stringify(text));
    for (;;) {
      try {
        await this.handle.write(Buffer.from(text, "latin1"));
        return;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "EAGAIN" || code === "EWOULDBLOCK") {
          await tick(5);
          continue;
        }
        return;
      }
    }
  }

  private async readLoop(): Promise<void> {
    const buffer = Buffer.allocUnsafe(4096);
    while (this.reading && this.handle) {
      try {
        const { bytesRead } = await this.handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) return;
        this.commandBuffer = Buffer.concat([this.commandBuffer, buffer.subarray(0, bytesRead)]);
        let index = this.commandBuffer.indexOf(0x0d);
        while (index >= 0) {
          const line = this.commandBuffer.subarray(0, index).toString("latin1");
          this.commandBuffer = this.commandBuffer.subarray(index + 1);
          this.log("host->dev", JSON.stringify(line));
          await this.onCommand(line);
          index = this.commandBuffer.indexOf(0x0d);
        }
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "EAGAIN" || code === "EWOULDBLOCK") {
          await tick(5);
          continue;
        }
        return;
      }
    }
  }

  protected abstract onCommand(line: string): Promise<void>;
}

/* ------------------------------------------ the scripted ECU (both worlds) */

interface ScriptedHit {
  first: number[][];
  afterFc: number[][];
}

/** 22-byte identification string: multi-frame on classic CAN. */
const LONG_DID = Array.from("YESYOUCAN-DEMO-IDENT01").map((c) => c.charCodeAt(0));

/** UDS service table of the demo ECU, expressed on its own CAN payloads. */
function scriptedEcu(canPayload: number[]): ScriptedHit | "nodata" {
  // Unwrap the ISO-TP Single Frame PCI (ISO 15765-2 §7.2): PCI 0x0? means the
  // service bytes start at index 1.
  const payload = (canPayload[0] ?? 0) >> 4 === 0 ? canPayload.slice(1) : canPayload;
  if (payload[0] === 0x22 && payload[1] === 0xf1 && payload[2] === 0x90) {
    const body = [0x62, 0xf1, 0x90, ...LONG_DID];
    const first = [0x10 | ((body.length >> 8) & 0x0f), body.length & 0xff, ...body.slice(0, 6)];
    const rest: number[][] = [];
    let offset = 6;
    let seq = 1;
    while (offset < body.length) {
      rest.push([0x20 | (seq & 0x0f), ...body.slice(offset, offset + 7)]);
      offset += 7;
      seq++;
    }
    return { first: [first], afterFc: rest };
  }
  if (payload[0] === 0x3e) {
    return { first: [[0x02, 0x7e, 0x00, 0, 0, 0, 0, 0]], afterFc: [] };
  }
  return "nodata";
}

/* ----------------------------------------------------------- ELM327 device */

type ElmVariant = "A" | "B";

/**
 * The ELM327 device: AT table, data commands with a scripted ECU behind them,
 * and the two prompt timings real units show.
 *
 * - Variant A: receive window closes immediately after the due frames — `>`
 *   right behind every answer.
 * - Variant B: the window stays open for `windowMs`; input inside the window
 *   aborts it with `STOPPED` and the prompt (PIC18F25K80 behaviour).
 */
class Elm327Device extends PtyDevice {
  private windowTimer: ReturnType<typeof setTimeout> | null = null;
  private heldAfterFc: number[][] = [];
  private atsh = 0x7df;

  constructor(
    path: string,
    private readonly variant: ElmVariant,
    private readonly windowMs = 300,
  ) {
    super(path);
  }

  protected async onCommand(line: string): Promise<void> {
    if (line.length === 0) return;
    if (this.variant === "B" && this.windowTimer) {
      clearTimeout(this.windowTimer);
      this.windowTimer = null;
      await this.writeOut("STOPPED\r\n>");
    }
    const upper = line.trim().toUpperCase();
    if (upper.startsWith("AT")) {
      await this.handleAt(upper);
      return;
    }
    await this.handleData(line.trim());
  }

  private async handleAt(upper: string): Promise<void> {
    if (upper === "ATZ") {
      await this.writeOut("\rELM327 v2.1\r\n>");
      return;
    }
    if (upper === "ATRV") {
      await this.writeOut("\r13.8V\r\n>");
      return;
    }
    if (upper === "ATDP") {
      await this.writeOut("\rAUTO, ISO 15765-4 (CAN 11/500)\r\n>");
      return;
    }
    if (upper.startsWith("ATSH")) {
      this.atsh = Number.parseInt(upper.slice(4).trim(), 16);
      await this.writeOut("OK\r\n>");
      return;
    }
    if (/^AT(E0|L1|H1|S1|CAF0|SP\d)$/.test(upper)) {
      await this.writeOut("OK\r\n>");
      return;
    }
    await this.writeOut("?\r\n>");
  }

  private async endWindow(trailer: string): Promise<void> {
    if (this.variant === "A") {
      await this.writeOut(trailer);
      return;
    }
    if (this.windowTimer) clearTimeout(this.windowTimer);
    this.windowTimer = setTimeout(() => {
      this.windowTimer = null;
      void this.writeOut(trailer);
    }, this.windowMs);
  }

  private async handleData(line: string): Promise<void> {
    const tokens = line.split(/\s+/).filter((t) => t.length > 0);
    const dlc = Number.parseInt(tokens[0] ?? "0", 16);
    const payload = tokens.slice(1, 1 + dlc).map((t) => Number.parseInt(t, 16));
    // ISO 15765-2 Flow Control from the tester (PCI 0x30) releases held CFs.
    if ((payload[0] ?? 0) >> 4 === 0x3) {
      for (const frame of this.heldAfterFc) await this.printFrame(frame);
      this.heldAfterFc = [];
      await this.endWindow("\r>");
      return;
    }
    const hit = scriptedEcu(payload);
    if (hit === "nodata") {
      await this.endWindow("NO DATA\r\n>");
      return;
    }
    for (const frame of hit.first) await this.printFrame(frame);
    this.heldAfterFc = hit.afterFc;
    await this.endWindow("\r>");
  }

  private async printFrame(frame: number[]): Promise<void> {
    const id = (this.atsh + 8).toString(16).toUpperCase().padStart(3, "0");
    const dlc = frame.length.toString(16).toUpperCase().padStart(2, "0");
    const data = frame.map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ");
    await this.writeOut(`${id} ${dlc} ${data}\r\n`);
  }
}

/* ------------------------------------------------------------- slcan device */

class SlcanDevice extends PtyDevice {
  private heldAfterFc: number[][] = [];

  protected async onCommand(line: string): Promise<void> {
    if (line.length === 0) return;
    if (line === "V") {
      await this.writeOut("V0101\r");
      return;
    }
    const type = line[0];
    if (type === "t" || type === "T") {
      await this.handleFrameTx(line);
      return;
    }
    // Lawicel acks every other command with the empty CR.
    await this.writeOut("\r");
  }

  private async handleFrameTx(line: string): Promise<void> {
    await this.writeOut("\r");
    const type = line[0] as string;
    const idLength = type === "T" ? 8 : 3;
    const id = Number.parseInt(line.slice(1, 1 + idLength), 16);
    const dlc = Number.parseInt(line.slice(1 + idLength, 2 + idLength), 16);
    const data: number[] = [];
    for (let i = 0; i < dlc; i++) {
      data.push(Number.parseInt(line.slice(2 + idLength + i * 2, 4 + idLength + i * 2), 16));
    }
    if ((data[0] ?? 0) >> 4 === 0x3) {
      for (const frame of this.heldAfterFc) await this.printFrame(id + 8, frame);
      this.heldAfterFc = [];
      return;
    }
    const hit = scriptedEcu(data);
    if (hit === "nodata") return;
    for (const frame of hit.first) await this.printFrame(id + 8, frame);
    this.heldAfterFc = hit.afterFc;
  }

  private async printFrame(id: number, frame: number[]): Promise<void> {
    const idHex = id.toString(16).toUpperCase().padStart(3, "0");
    const dlcHex = frame.length.toString(16).toLowerCase();
    const data = frame.map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join("");
    await this.writeOut(`t${idHex}${dlcHex}${data}\r`);
  }
}

/* -------------------------------------------------------------- scenarios */

interface ScenarioResult {
  outcome: { kind: "ok"; payload: number[] } | { kind: "error"; message: string };
  durationMs: number;
  wireLog: string;
}

/**
 * Full production walk: create the bus from an adapter at a real serial port
 * and read a DID through ISO-TP. Mirrors what the workbench does on day X.
 */
async function runOnElm(
  pair: PtyPair,
  device: PtyDevice,
  requestPayload: number[],
): Promise<ScenarioResult> {
  const started = Date.now();
  const stream = await openSerialStream({ device: pair.a });
  const adapter = new Elm327Adapter({
    stream,
    commandTimeoutMs: 2500,
    logger: createLogger("rehearsal", { level: "ERROR" }),
  });
  let outcome: ScenarioResult["outcome"];
  try {
    await adapter.open();
    const connection = new IsoTpConnection(adapter, { txId: 0x7e0, rxId: 0x7e8 });
    connection.open();
    try {
      const response = await connection.request(Uint8Array.from(requestPayload), 5000);
      outcome = { kind: "ok", payload: Array.from(response) };
    } finally {
      connection.close();
    }
  } catch (error) {
    outcome = { kind: "error", message: (error as Error).message };
  }
  const durationMs = Date.now() - started;
  await adapter.close().catch(() => undefined);
  await stream.close().catch(() => undefined);
  return { outcome, durationMs, wireLog: device.wireLog() };
}

async function runOnSlcan(
  pair: PtyPair,
  device: PtyDevice,
  requestPayload: number[],
): Promise<ScenarioResult> {
  const started = Date.now();
  const stream = await openSerialStream({ device: pair.a });
  const adapter = new CanableAdapter({
    stream,
    bitrate: "500k",
    commandTimeoutMs: 1000,
    logger: createLogger("rehearsal", { level: "ERROR" }),
  });
  let outcome: ScenarioResult["outcome"];
  try {
    await adapter.open();
    const connection = new IsoTpConnection(adapter, { txId: 0x7e0, rxId: 0x7e8 });
    connection.open();
    try {
      const response = await connection.request(Uint8Array.from(requestPayload), 5000);
      outcome = { kind: "ok", payload: Array.from(response) };
    } finally {
      connection.close();
    }
  } catch (error) {
    outcome = { kind: "error", message: (error as Error).message };
  }
  const durationMs = Date.now() - started;
  await adapter.close().catch(() => undefined);
  await stream.close().catch(() => undefined);
  return { outcome, durationMs, wireLog: device.wireLog() };
}

const TESTER_PRESENT = [0x3e, 0x00];
const READ_VIN_DID = [0x22, 0xf1, 0x90];
const EXPECTED_VIN_ANSWER = [0x62, 0xf1, 0x90, ...LONG_DID];

for (const variant of ["A", "B"] as const) {
  test.skipIf(!hasSocat())(
    `ELM327 variant ${variant} (prompt ${variant === "A" ? "immediate" : "windowed"}): single-frame round trip`,
    async () => {
      const pair = await createPtyPair();
      const device = new Elm327Device(pair.b, variant);
      await device.start();
      try {
        const { outcome, wireLog } = await runOnElm(pair, device, TESTER_PRESENT);
        assert.deepEqual(outcome, { kind: "ok", payload: [0x7e, 0x00] }, `wire:\n${wireLog}`);
      } finally {
        await device.stop();
        pair.dispose();
      }
    },
  );

  test.skipIf(!hasSocat())(
    `ELM327 variant ${variant} (prompt ${variant === "A" ? "immediate" : "windowed"}): multi-frame answer completes (the STOPPED regression)`,
    async () => {
      const pair = await createPtyPair();
      const device = new Elm327Device(pair.b, variant);
      await device.start();
      try {
        const { outcome, wireLog } = await runOnElm(pair, device, READ_VIN_DID);
        if (outcome.kind !== "ok") {
          // The day-X failure shape before the fix: every multi-frame answer
          // died as "ELM327 refused the frame: STOPPED" against a windowed
          // adapter. The wire log must carry the proof when this red-fails.
          assert.fail(
            `multi-frame through a windowed ELM327 must succeed, got: ${outcome.message}\nwire:\n${wireLog}`,
          );
        }
        assert.deepEqual(outcome.payload, EXPECTED_VIN_ANSWER, `wire:\n${wireLog}`);
        if (variant === "B") {
          assert.ok(
            !device.wire.some((entry) => entry.text.includes("STOPPED")),
            `the serialised adapter must never poke an open window:\n${device.wireLog()}`,
          );
        }
      } finally {
        await device.stop();
        pair.dispose();
      }
    },
  );
}

test.skipIf(!hasSocat())(
  "CANable: full multi-frame round trip over a real serial port",
  async () => {
    const pair = await createPtyPair();
    const device = new SlcanDevice(pair.b);
    await device.start();
    try {
      const { outcome, wireLog } = await runOnSlcan(pair, device, READ_VIN_DID);
      if (outcome.kind !== "ok") {
        assert.fail(`slcan round trip must succeed, got: ${outcome.message}\nwire:\n${wireLog}`);
      }
      assert.deepEqual(outcome.payload, EXPECTED_VIN_ANSWER, `wire:\n${wireLog}`);
    } finally {
      await device.stop();
      pair.dispose();
    }
  },
);

test.skipIf(!hasSocat())(
  "CANable: a silent serial line fails open() with the handshake cause (real serial port)",
  async () => {
    const pair = await createPtyPair();
    // Nobody answers on the far end at all — the pre-handshake bug read
    // exactly like a connected bus with a silent vehicle behind it.
    const stream = await openSerialStream({ device: pair.a });
    const adapter = new CanableAdapter({
      stream,
      bitrate: "500k",
      commandTimeoutMs: 250,
      logger: createLogger("rehearsal", { level: "ERROR" }),
    });
    try {
      await assert.rejects(
        adapter.open(),
        (error: unknown) =>
          error instanceof TransportError &&
          error.message.includes("version query") &&
          error.message.includes("250 ms"),
      );
      assert.equal(adapter.isOpen(), false);
    } finally {
      await adapter.close().catch(() => undefined);
      await stream.close().catch(() => undefined);
      pair.dispose();
    }
  },
);
