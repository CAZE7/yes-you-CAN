/**
 * Serial byte stream over a POSIX character device (AGENTS 4, 29).
 *
 * The adapter packages stay hardware-free: they speak to a `ByteStream` that the
 * host provides. This is the Node host implementation of that contract, so the
 * same ELM327/slcan protocol code that unit tests drive with a memory stream can
 * drive a real USB adapter.
 *
 * Deliberate properties:
 *
 * - **Ordered writes.** Diagnostic traffic is a request/response conversation; a
 *   reordered AT or slcan command would desynchronise the adapter. Writes are
 *   therefore serialised through a promise chain instead of fired in parallel.
 * - **No surprise configuration.** Opening a device never changes it. Line
 *   settings are only applied when `configureSerialPort` is called explicitly
 *   (or `configure: true`), because guessing the wrong baud rate on a live bus
 *   is worse than failing.
 * - **Read-only tolerance.** A closed device, a pulled USB plug and a tty that
 *   reports `EAGAIN` are normal states, not crashes: the stream reports them
 *   through `onError` and moves to `closed`.
 */

import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import type { ByteStream } from "@vdp/adapter-elm327";
import {
  AdapterUnsupportedError,
  type Logger,
  TransportError,
  asError,
  createLogger,
  messageOf,
} from "@vdp/shared";

export interface SerialStreamOptions {
  /** Character device, e.g. `/dev/ttyUSB0` (Linux) or `COM3` (Windows). */
  device: string;
  /** Human readable transport description for the UI adapter panel. */
  label?: string;
  /** Bytes requested per read syscall. 512 is plenty for a CAN adapter. */
  readChunkBytes?: number;
  /** Delay after `EAGAIN`/`EWOULDBLOCK` before the next read attempt. */
  idlePollMs?: number;
  logger?: Logger;
}

export interface SerialPortConfig {
  /** Applies line settings with `stty` before the device is opened. */
  baudRate: number;
  /** Extra `stty` flags; defaults to raw 8N1 without flow control. */
  flags?: readonly string[];
  /** Command timeout in ms. */
  timeoutMs?: number;
}

/**
 * POSIX `EAGAIN`. Reading a serial device that has no byte available yet is the
 * normal case for a tty opened non-blocking, so it must not be an error.
 */
const RETRYABLE_CODES = new Set(["EAGAIN", "EWOULDBLOCK", "EINTR", "EBUSY"]);

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SerialByteStream implements ByteStream {
  private handle: FileHandle | null = null;
  private closed = false;
  private listeners: Array<(chunk: string) => void> = [];
  private errorListeners: Array<(error: Error) => void> = [];
  private writeChain: Promise<void> = Promise.resolve();
  private readLoop: Promise<void> | null = null;
  private readonly log: Logger;
  private readonly readChunkBytes: number;
  private readonly idlePollMs: number;
  readonly device: string;
  private readonly label: string;

  /** Bytes written to the device, counted for the adapter panel and tests. */
  bytesWritten = 0;
  /** Bytes read from the device. */
  bytesRead = 0;

  constructor(options: SerialStreamOptions, handle: FileHandle) {
    if (options.readChunkBytes !== undefined && options.readChunkBytes <= 0) {
      throw new AdapterUnsupportedError("readChunkBytes must be greater than zero", {
        device: options.device,
      });
    }
    this.device = options.device;
    this.label = options.label ?? `serial ${options.device}`;
    this.readChunkBytes = options.readChunkBytes ?? 512;
    this.idlePollMs = options.idlePollMs ?? 5;
    this.log = (options.logger ?? createLogger("can", { level: "INFO" })).child("can");
    this.handle = handle;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async write(data: string): Promise<void> {
    // Serialise writes: two interleaved AT commands would arrive as one corrupt
    // line and the adapter would answer with an error nobody can attribute.
    const next = this.writeChain.then(async () => {
      const handle = this.handle;
      if (this.closed || !handle)
        throw new TransportError(`serial device ${this.device} is not open`);
      const buffer = Buffer.from(data, "latin1");
      try {
        await handle.write(buffer);
        this.bytesWritten += buffer.length;
      } catch (error) {
        throw new TransportError(`serial write to ${this.device} failed: ${messageOf(error)}`, {
          device: this.device,
        });
      }
    });
    // Keep the chain alive after a rejection, otherwise one failed write would
    // block every later write for the rest of the session.
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  onData(listener: (chunk: string) => void): () => void {
    this.listeners.push(listener);
    this.startReadLoop();
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener);
    };
  }

  /** Transport-level failures (unplugged device, I/O error) — never silent. */
  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.push(listener);
    return () => {
      this.errorListeners = this.errorListeners.filter((entry) => entry !== listener);
    };
  }

  isOpen(): boolean {
    return !this.closed && this.handle !== null;
  }

  describe(): string {
    return this.label;
  }

  /**
   * Close the device.
   *
   * The descriptor is closed *before* the read loop is awaited: a read that is
   * still in flight would otherwise keep `close()` waiting forever, and a
   * diagnostic tool that cannot disconnect from a silent ECU is useless. The
   * loop itself only ever blocks for one poll interval, because the device is
   * opened non-blocking (see `openSerialStream`).
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const handle = this.handle;
    this.handle = null;
    // Wait for in-flight writes before dropping the descriptor, otherwise the
    // last command (e.g. slcan "C") could be truncated at the OS layer.
    await this.writeChain.catch(() => undefined);
    await handle?.close().catch((error: unknown) => {
      this.log.debug("serial close failed", { device: this.device, error: String(error) });
    });
    await this.waitForReadLoop();
    this.listeners = [];
    this.log.info("serial device closed", {
      device: this.device,
      bytesRead: this.bytesRead,
      bytesWritten: this.bytesWritten,
    });
  }

  /** Bounded wait: never let a broken device block shutdown or a test. */
  private async waitForReadLoop(timeoutMs = 1000): Promise<void> {
    const loop = this.readLoop;
    this.readLoop = null;
    if (!loop) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        loop.catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Test/tooling hook: push a chunk as if the device had sent it. */
  emit(chunk: string): void {
    this.emitChunk(chunk);
  }

  private startReadLoop(): void {
    if (this.readLoop || this.closed || !this.handle) return;
    this.readLoop = this.runReadLoop().catch((error: unknown) => {
      this.fail(asError(error));
    });
  }

  private async runReadLoop(): Promise<void> {
    const buffer = Buffer.allocUnsafe(this.readChunkBytes);
    while (!this.closed) {
      const handle = this.handle;
      if (!handle) return;
      if (this.closed) return;
      try {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) {
          // End of file on a character device means the device disappeared.
          this.fail(
            new TransportError(
              `serial device ${this.device} reached end of stream (device removed?)`,
              { device: this.device },
            ),
          );
          return;
        }
        this.bytesRead += bytesRead;
        this.emitChunk(buffer.subarray(0, bytesRead).toString("latin1"));
      } catch (error) {
        if (this.closed) return;
        const code = errorCode(error);
        if (code && RETRYABLE_CODES.has(code)) {
          await sleep(this.idlePollMs);
          continue;
        }
        this.fail(
          new TransportError(`serial read from ${this.device} failed: ${messageOf(error)}`, {
            device: this.device,
            code: code ?? null,
          }),
        );
        return;
      }
    }
  }

  private emitChunk(chunk: string): void {
    if (chunk.length === 0) return;
    // A listener that throws must not kill the read loop of a live adapter.
    for (const listener of [...this.listeners]) {
      try {
        listener(chunk);
      } catch (error) {
        this.log.warn("serial stream listener failed", {
          device: this.device,
          error: messageOf(error),
        });
      }
    }
  }

  private fail(error: Error): void {
    this.log.warn("serial stream failed", { device: this.device, error: error.message });
    const listeners = [...this.errorListeners];
    this.errorListeners = [];
    for (const listener of listeners) {
      try {
        listener(error);
      } catch (listenerError) {
        // An error listener that throws is not worth another error — but it is
        // worth a structured debug line (AGENTS 34.25).
        this.log.debug("serial error listener failed", {
          device: this.device,
          error: messageOf(listenerError),
        });
      }
    }
    void this.close();
  }
}

/**
 * Open a character device as a `ByteStream`.
 *
 * The device is opened read/write and non-blocking-safe: reads that report
 * `EAGAIN` are polled instead of treated as failures.
 */
export async function openSerialStream(options: SerialStreamOptions): Promise<SerialByteStream> {
  if (!options.device || options.device.trim().length === 0) {
    throw new AdapterUnsupportedError(
      "a serial device path is required (e.g. --device=/dev/ttyUSB0)",
    );
  }
  const logger = (options.logger ?? createLogger("can", { level: "INFO" })).child("can");
  try {
    const handle = await open(options.device, serialOpenFlags());
    const stream = new SerialByteStream(options, handle);
    logger.info("serial device opened", { device: options.device });
    return stream;
  } catch (error) {
    throw new AdapterUnsupportedError(
      `cannot open serial device ${options.device}: ${messageOf(error)}`,
      { device: options.device, code: errorCode(error) ?? null },
    );
  }
}

/**
 * `O_RDWR | O_NOCTTY | O_NONBLOCK`.
 *
 * Numeric flags are used instead of the `'r+'` shorthand because the read side
 * *must* be non-blocking: a blocking tty read parks a threadpool thread until a
 * device finally sends something, which makes closing a silent adapter hang.
 * With `O_NONBLOCK` a read without data returns `EAGAIN`, and the poll loop
 * stays interruptible. `O_NOCTTY` prevents the device from becoming the process
 * controlling terminal when the tool runs under a supervisor.
 */
function serialOpenFlags(): number {
  const { O_RDWR = 2, O_NOCTTY = 0, O_NONBLOCK = 0 } = constants ?? {};
  return O_RDWR | O_NOCTTY | O_NONBLOCK;
}

/**
 * Apply line settings to a serial device using the platform `stty` tool.
 *
 * Baud rate and flow control cannot be set through Node's `fs` API, and pulling
 * in a native addon would violate ADR 0002 (no runtime dependencies). `stty` is
 * present on every POSIX system and is the same mechanism a user would apply by
 * hand, which keeps the behaviour inspectable.
 */
export async function configureSerialPort(
  device: string,
  config: SerialPortConfig,
  logger?: Logger,
): Promise<string> {
  const { spawn } = await import("node:child_process");
  const log = (logger ?? createLogger("can", { level: "INFO" })).child("can");
  const flags = config.flags ?? ["raw", "-echo", "-echoe", "-echok", "-crtscts", "clocal"];
  const args = ["-F", device, String(config.baudRate), ...flags];
  const timeoutMs = config.timeoutMs ?? 3000;

  return new Promise<string>((resolve, reject) => {
    const child = spawn("stty", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new TransportError(`stty ${args.join(" ")} timed out after ${timeoutMs} ms`, { device }),
      );
    }, timeoutMs);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      reject(
        new AdapterUnsupportedError(
          `cannot configure ${device}: "stty" is unavailable (${error.message}). Set the line settings manually or pass configure: false.`,
          { device },
        ),
      );
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      const command = `stty ${args.join(" ")}`;
      if (code !== 0) {
        reject(
          new TransportError(
            `${command} exited with code ${code}: ${stderr.trim() || "no output"}`,
            { device },
          ),
        );
        return;
      }
      log.info("serial port configured", { device, baudRate: config.baudRate });
      resolve(command);
    });
  });
}
