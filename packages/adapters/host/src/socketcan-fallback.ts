/**
 * SocketCAN fallback paths for the host (AGENTS 4, 29).
 *
 * The native `socketcan` npm module is optional and may be absent — its build
 * needs a compiler toolchain most laptops do not have ready on calibration
 * day. Linux still offers two checks that decide failure before a single
 * native call, and one working transport with no native build at all:
 *
 * - **interface truth from `/sys/class/net`**: which CAN interfaces exist
 *   (ARPHRD_CAN = 280) and whether they are up (`operstate`). A missing or
 *   down interface is the most common real SocketCAN failure, and it is
 *   visible without root, without opening anything.
 * - **can-utils as transport**: `candump`/`cansend` are plain user-space
 *   binaries. One process per transmitted frame makes them slower than a
 *   native binding — a labelled fallback, but a SocketCAN day that works with
 *   `apt install can-utils` beats one that ends at node-gyp.
 */

import { execFile, spawn } from "node:child_process";
import { accessSync, constants, readdirSync, readFileSync, statSync } from "node:fs";
import {
  type SocketCanBinding,
  type SocketCanChannel,
  type SocketCanFrameData,
  tryLoadSocketCanBinding,
} from "@vdp/adapter-socketcan";
import { createLogger, type Logger, messageOf, TransportError } from "@vdp/shared";

/* ------------------------------------------------------------- /sys truth */

export interface CanInterfaceState {
  /** A network interface with this name exists at all. */
  present: boolean;
  /** It is a CAN interface (ARPHRD_CAN = 280). */
  isCan: boolean;
  /** operstate reads `up` or `unknown` (virtual CAN reports unknown while up). */
  up: boolean;
  /** Raw operstate value, kept for messages. */
  operstate: string;
}

/** Read what the kernel knows about an interface — never opens or writes anything. */
export function canInterfaceState(iface: string, sysfs = "/sys/class/net"): CanInterfaceState {
  const path = `${sysfs}/${iface}`;
  let present: boolean;
  try {
    present = statSync(path).isDirectory();
  } catch {
    present = false;
  }
  if (!present) return { present, isCan: false, up: false, operstate: "absent" };
  const isCan = readTrimmedOrNull(`${path}/type`) === "280";
  const operstate = readTrimmedOrNull(`${path}/operstate`) ?? "unknown";
  return {
    present: true,
    isCan,
    up: operstate === "up" || operstate === "unknown",
    operstate,
  };
}

/** All interfaces the kernel reports as CAN (ARPHRD_CAN = 280). Best effort. */
export function listCanInterfaces(sysfs = "/sys/class/net"): string[] {
  let entries: string[];
  try {
    entries = readdirSync(sysfs);
  } catch {
    return [];
  }
  return entries.filter((entry) => readTrimmedOrNull(`${sysfs}/${entry}/type`) === "280").sort();
}

function readTrimmedOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- can-utils */

export interface CanUtilsPaths {
  candump: string | null;
  cansend: string | null;
}

/**
 * Find the can-utils binaries on PATH (or in the well-known locations).
 * Read-only: probing whether a file is executable never runs it.
 */
export function findCanUtils(dirs?: readonly string[]): CanUtilsPaths {
  const search = [...(dirs ?? process.env.PATH?.split(":") ?? [])];
  const find = (name: "candump" | "cansend"): string | null => {
    for (const dir of search) {
      const candidate = `${dir}/${name}`;
      if (isExecutable(candidate)) return candidate;
    }
    return null;
  };
  return { candump: find("candump"), cansend: find("cansend") };
}

/** "Executable here?" — the two unreadable cases (absent, wrong mode) both read as false. */
function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** A spawned candump process, cut down to what the binding needs (injected in tests). */
export interface CandumpChild {
  stdout: { on(event: "data", listener: (chunk: Uint8Array) => void): void };
  onError(listener: (error: Error) => void): void;
  onExit(listener: (code: number | null) => void): void;
  kill(): void;
}

export type SpawnCandump = (iface: string) => Promise<CandumpChild>;
export type SpawnCansend = (iface: string, frame: string) => Promise<void>;

/** The binaries the factories above run, once resolved for this binding. */
interface ResolvedBinaries {
  candump: string | null;
  cansend: string | null;
}

export interface CanUtilsBindingOptions {
  /** Inject the process spawn for `candump -L <iface>` (tests). */
  startCandump?: SpawnCandump;
  /** Inject the one-shot `cansend <iface> <frame>` (tests). */
  runCansend?: SpawnCansend;
  /**
   * Explicit paths to the binaries. Overrides PATH lookup — useful when
   * can-utils lives outside PATH, and what lets tests point the default
   * implementations at stub binaries instead of installing can-utils.
   */
  candumpPath?: string;
  cansendPath?: string;
  /**
   * How long open() waits for the first output or an early exit of candump
   * before declaring the channel listening (ms). An idle but healthy
   * interface prints nothing: silence on an idle bus is indistinguishable
   * from listening correctly, so the wait is bounded and success is the
   * absence of an early exit.
   */
  startupWindowMs?: number;
  /** Per-frame cansend timeout (ms). */
  sendTimeoutMs?: number;
  /** Directories searched for the binaries (tests inject a temp PATH). */
  pathDirs?: readonly string[];
  /** `/sys/class/net` root (tests inject a temp sysfs layout). */
  sysfsRoot?: string;
  logger?: Logger;
}

function defaultStartCandump(iface: string, binary: string): Promise<CandumpChild> {
  const child = spawn(binary, ["-L", iface], { stdio: ["ignore", "pipe", "inherit"] });
  const out = child.stdout;
  if (!out) throw new TransportError(`candump produced no stdout for ${iface}`);
  return Promise.resolve({
    stdout: {
      on(event: "data", listener: (chunk: Uint8Array) => void): void {
        out.on(event, listener);
      },
    },
    onError(listener: (error: Error) => void): void {
      child.on("error", listener);
    },
    onExit(listener: (code: number | null) => void): void {
      child.on("exit", listener);
    },
    kill(): void {
      child.kill("SIGTERM");
    },
  });
}

async function defaultRunCansend(iface: string, frame: string, binary: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(binary, [iface, frame], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** Format one frame the way `cansend` expects it: `7E0#023E80`, 8 digits for extended. */
export function formatCansendFrame(frame: SocketCanFrameData): string {
  const id = (
    frame.extended ? frame.id.toString(16).padStart(8, "0") : frame.id.toString(16).padStart(3, "0")
  ).toUpperCase();
  const data = Array.from(frame.data)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  return `${id}#${data}`;
}

/**
 * Parse one `candump -L` (logcompact) line: `(timestamp) iface ID#DATA`.
 * Returns null for remote frames (`ID#R`), CAN-FD frames (`ID##...` — this
 * binding is classic-CAN-only) and anything else that is not a classic frame —
 * a line the parser cannot prove is never guessed into a frame.
 */
export function parseCandumpLine(line: string): SocketCanFrameData | null {
  const match = /^\(\d+(?:\.\d+)?\)\s+(\S+)\s+([0-9A-Fa-f]{1,8})#([0-9A-Fa-f]*)$/.exec(line.trim());
  if (!match) return null;
  const idHex = match[2] as string;
  const dataHex = match[3] ?? "";
  if (dataHex.length % 2 !== 0 || dataHex.length > 16) return null;
  const data = new Uint8Array(dataHex.length / 2);
  for (let i = 0; i < data.length; i++) {
    data[i] = Number.parseInt(dataHex.slice(i * 2, i * 2 + 2), 16);
  }
  return { id: Number.parseInt(idHex, 16), extended: idHex.length > 3, data };
}

/**
 * A SocketCanBinding over `candump`/`cansend` — the zero-native-build path.
 *
 * Honest about its limits: classic CAN only, and every `cansend` spawns a
 * process (~1–5 ms on a typical laptop), so a traffic-heavy bus belongs to
 * the native binding. What it *guarantees* is a transport that works on a
 * fresh Linux box with can-utils installed.
 */
export function createCanUtilsSocketCanBinding(
  options: CanUtilsBindingOptions = {},
): SocketCanBinding {
  const log = (options.logger ?? createLogger("can", { level: "INFO" })).child("can");
  const startupWindowMs = options.startupWindowMs ?? 300;
  const sendTimeoutMs = options.sendTimeoutMs ?? 1000;
  const sysfs = options.sysfsRoot ?? "/sys/class/net";
  const found = findCanUtils(options.pathDirs);
  const paths: ResolvedBinaries = {
    candump: options.candumpPath ?? found.candump,
    cansend: options.cansendPath ?? found.cansend,
  };
  const startCandump: SpawnCandump =
    options.startCandump ??
    ((iface: string) => defaultStartCandump(iface, paths.candump ?? "candump"));
  const runCansend: SpawnCansend =
    options.runCansend ??
    ((iface: string, frame: string) => defaultRunCansend(iface, frame, paths.cansend ?? "cansend"));

  return {
    name: "can-utils",
    async listInterfaces(): Promise<string[]> {
      return listCanInterfaces(sysfs);
    },
    async open(iface: string): Promise<SocketCanChannel> {
      if (!paths.candump || !paths.cansend) {
        throw new TransportError(
          `can-utils not installed (candump: ${paths.candump ?? "missing"}, cansend: ${paths.cansend ?? "missing"}) — install with: sudo apt install can-utils`,
        );
      }
      // Decide from /sys first: the two most common real failures are named
      // there, and a candump start cannot be distinguished from success on an
      // idle interface that does not exist.
      const state = canInterfaceState(iface, sysfs);
      if (!state.present) {
        throw new TransportError(
          `CAN interface ${iface} does not exist — check the device (ip -details link show) or for a dry run without hardware: sudo modprobe vcan && sudo ip link add dev vcan0 type vcan && sudo ip link set up vcan0`,
          { iface },
        );
      }
      if (!state.isCan) {
        throw new TransportError(
          `interface ${iface} exists but is not a CAN interface — did you mean channel can0/vcan0? Existing CAN interfaces: ${listCanInterfaces(sysfs).join(", ") || "none"}`,
          { iface, operstate: state.operstate },
        );
      }
      if (!state.up) {
        throw new TransportError(
          `CAN interface ${iface} is down (${state.operstate}) — bring it up: sudo ip link set dev ${iface} up (with a bitrate first if needed: sudo ip link set dev ${iface} type can bitrate 500000)`,
          { iface, operstate: state.operstate },
        );
      }
      const child = await startCandump(iface);
      const listeners = new Set<(frame: SocketCanFrameData) => void>();
      let buffer = "";
      let closed = false;
      const emitLine = (line: string): void => {
        if (line.trim().length === 0) return;
        const frame = parseCandumpLine(line);
        if (!frame) {
          // candump also prints its own headers on some versions; RTR and FD
          // lines land here too — dropped deliberately (see parseCandumpLine).
          log.debug("candump line without a provable frame, dropped", { line });
          return;
        }
        for (const listener of [...listeners]) listener(frame);
      };
      const decoder = new TextDecoder("latin1");
      child.stdout.on("data", (chunk) => {
        buffer += decoder.decode(chunk, { stream: true });
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          emitLine(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf("\n");
        }
      });

      // The startup budget: candump exits early when the interface is
      // unusable even though /sys looked fine (e.g. permission problems);
      // silence on an idle bus means nothing, so the wait is bounded.
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          log.debug("candump startup window elapsed without output — treating as listening", {
            iface,
          });
          resolve();
        }, startupWindowMs);
        child.onError((error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(
            new TransportError(`could not start candump on ${iface}: ${messageOf(error)}`, {
              iface,
            }),
          );
        });
        child.onExit((code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(
            new TransportError(
              `candump exited with code ${code ?? "null"} on ${iface} — does the interface really work? (ip -details link show ${iface})`,
              { iface, code },
            ),
          );
        });
      });

      let sendChain: Promise<void> = Promise.resolve();
      return {
        send(frame: SocketCanFrameData): Promise<void> {
          // One process per frame: serialised so a burst does not spawn a
          // process per millisecond, with the timeout as the leak guard.
          const line = formatCansendFrame(frame);
          const next = sendChain.then(async () => {
            if (closed) throw new TransportError(`can-utils channel ${iface} is closed`);
            await withTimeout(
              runCansend(iface, line),
              sendTimeoutMs,
              `cansend ${line} on ${iface}`,
            );
          });
          sendChain = next.catch(() => undefined);
          return next;
        },
        onData(listener: (frame: SocketCanFrameData) => void): () => void {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        async close(): Promise<void> {
          closed = true;
          listeners.clear();
          child.kill();
        },
      };
    },
  };
}

function withTimeout(promise: Promise<void>, timeoutMs: number, what: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new TransportError(`${what} did not finish within ${timeoutMs} ms`)),
      timeoutMs,
    );
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error) => {
        clearTimeout(timer);
        reject(new TransportError(`${what} failed: ${messageOf(error)}`));
      },
    );
  });
}

/* ------------------------------------------------- binding fallback chain */

export interface SocketCanBindingResolution {
  binding: SocketCanBinding | null;
  /** Which path produced the binding — surfaced in probe details. */
  source: "native" | "can-utils" | "none";
  /** Why no binding was found, when source is "none". */
  reason?: string;
}

/**
 * Resolve the best available SocketCAN binding for this host.
 *
 * Order: native module (fast) → can-utils (no build) → none, with the reason
 * spelled out. All three lookups are side-effect-free: nothing is opened,
 * nothing is written.
 */
export async function resolveSocketCanBinding(deps?: {
  tryNative?: () => Promise<SocketCanBinding>;
  canUtilsAvailable?: () => boolean;
  createCanUtils?: () => SocketCanBinding;
  logger?: Logger;
}): Promise<SocketCanBindingResolution> {
  const tryNative = deps?.tryNative ?? tryLoadSocketCanBinding;
  const canUtilsAvailable =
    deps?.canUtilsAvailable ??
    (() => {
      const paths = findCanUtils();
      return Boolean(paths.candump && paths.cansend);
    });
  const log = (deps?.logger ?? createLogger("can", { level: "INFO" })).child("can");

  try {
    const binding = await tryNative();
    return { binding, source: "native" };
  } catch (error) {
    log.debug("native SocketCAN binding unavailable, checking can-utils fallback", {
      error: messageOf(error),
    });
  }
  if (canUtilsAvailable()) {
    const binding = deps?.createCanUtils
      ? deps.createCanUtils()
      : createCanUtilsSocketCanBinding({ ...(deps?.logger ? { logger: deps.logger } : {}) });
    return { binding, source: "can-utils" };
  }
  return {
    binding: null,
    source: "none",
    reason:
      "no native SocketCAN binding module (`npm i socketcan`) and no can-utils (`sudo apt install can-utils`) found",
  };
}
