/**
 * PTY pair helper for hardware-less adapter tests.
 *
 * `socat` connects two pseudo terminals, so a test can open one end with the
 * production `SerialByteStream` and play the *device* on the other end. That
 * exercises the real serial code path — open, read loop, framing, close — with
 * no adapter plugged in (AGENTS 31, 32), which is exactly the gap unit tests
 * against an in-memory stream leave open.
 *
 * `socat` is optional: on a host without it the affected tests skip instead of
 * failing, because the platform itself does not need socat to work.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import type { Writable } from "node:stream";

export interface PtyPair {
  /** Paths of the two connected pseudo terminals. */
  a: string;
  b: string;
  dispose(): void;
}

export function hasSocat(): boolean {
  const probe = spawnSync("socat", ["-V"], { stdio: "ignore" });
  return probe.status === 0;
}

/** Create a connected PTY pair; resolves once both device paths are known. */
export function createPtyPair(timeoutMs = 5000): Promise<PtyPair> {
  return new Promise<PtyPair>((resolve, reject) => {
    const child = spawn(
      "socat",
      ["-d", "-d", "pty,raw,echo=0,mode=600", "pty,raw,echo=0,mode=600"],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    const paths: string[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(`socat did not report two PTYs within ${timeoutMs} ms; output: ${stderr.trim()}`),
      );
    }, timeoutMs);

    const onData = (chunk: Buffer): void => {
      stderr += chunk.toString("utf8");
      for (const match of stderr.matchAll(/PTY is (\S+)/g)) {
        const path = match[1];
        if (path && !paths.includes(path)) paths.push(path);
      }
      if (paths.length >= 2) {
        clearTimeout(timer);
        child.stderr?.off("data", onData);
        resolve({
          a: paths[0] as string,
          b: paths[1] as string,
          dispose: () => {
            child.kill("SIGKILL");
          },
        });
      }
    };

    child.stderr?.on("data", onData);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      if (paths.length < 2) {
        clearTimeout(timer);
        reject(
          new Error(
            `socat exited with code ${code} before creating the PTY pair: ${stderr.trim()}`,
          ),
        );
      }
    });
  });
}

export interface DeviceSide {
  sent: string[];
  received: string[];
  write(data: string): Promise<void>;
  close(): Promise<void>;
  /** Wait until the received buffer contains `needle` or the timeout expires. */
  waitFor(needle: string, timeoutMs?: number): Promise<string>;
  child: ChildProcess;
}

/**
 * Play a serial device on one end of a PTY using a shell-free helper script.
 *
 * A tiny Node child process is used rather than in-process `fs` handles so the
 * device side is a *separate* process: a crash there must not take the test
 * process down, just like a real adapter being unplugged does not.
 */
export interface DeviceSideOptions {
  /**
   * Answer every received command line with the ELM327 prompt sequence
   * (`OK\r>`). Needed for adapters that wait for a prompt before the next
   * command; slcan needs no answers at all.
   */
  respondWithPrompt?: boolean;
}

export function createDeviceSide(device: string, options: DeviceSideOptions = {}): DeviceSide {
  const mode = options.respondWithPrompt ? "elm327" : "silent";
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", DEVICE_SCRIPT, device, mode],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  // stdin carries the parent's WRITE commands to the device side.
  const stdin = child.stdin as Writable;
  const state: DeviceSide = {
    sent: [],
    received: [],
    child,
    async write(data: string) {
      state.sent.push(data);
      // The script reads commands from stdin and forwards them to the device.
      stdin.write(`WRITE:${Buffer.from(data, "latin1").toString("base64")}\n`);
    },
    async close() {
      stdin.end();
      child.kill("SIGTERM");
    },
    waitFor(needle: string, timeoutMs = 3000) {
      return new Promise<string>((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
          if (state.received.some((chunk) => chunk.includes(needle))) {
            clearInterval(timer);
            resolve(state.received.join(""));
          } else if (Date.now() - started > timeoutMs) {
            clearInterval(timer);
            reject(
              new Error(
                `device side never received "${needle}" (got: ${JSON.stringify(state.received.join(""))})`,
              ),
            );
          }
        }, 10);
      });
    },
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    state.received.push(chunk.toString("latin1"));
  });
  // A device double that cannot start must be visible, not look like a silent
  // adapter that never answers.
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.on("exit", (code) => {
    if (code !== 0 && stderr.trim().length > 0) {
      process.stderr.write(`[pty device side exited with code ${code}] ${stderr.trim()}\n`);
    }
  });
  return state;
}

/**
 * Device side implementation.
 *
 * stdin lines are commands: `WRITE:<base64>` sends bytes to the serial device,
 * anything else is ignored. Whatever the device sends is written to stdout as
 * latin1, which the parent collects verbatim.
 */
const DEVICE_SCRIPT = `
import { createInterface } from 'node:readline';
import { open } from 'node:fs/promises';

const CR = String.fromCharCode(13);
const device = process.argv[1];
const mode = process.argv[2] ?? 'silent';
const handle = await open(device, 'r+');
console.log('READY');

const reader = createInterface({ input: process.stdin });
reader.on('line', async (line) => {
  if (!line.startsWith('WRITE:')) return;
  const data = Buffer.from(line.slice('WRITE:'.length), 'base64');
  try {
    await handle.write(data);
  } catch (error) {
    console.error('device side write failed: ' + String(error));
  }
});
reader.on('close', async () => {
  await handle.close();
  process.exit(0);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const buffer = Buffer.allocUnsafe(4096);
let commandBuffer = '';
for (;;) {
  try {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    const chunk = buffer.subarray(0, bytesRead);
    process.stdout.write(chunk);
    if (mode === 'elm327') {
      commandBuffer += chunk.toString('latin1');
      let index = commandBuffer.indexOf(CR);
      while (index >= 0) {
        commandBuffer = commandBuffer.slice(index + 1);
        // A real ELM327 answers AT commands with OK and always ends with the '>' prompt.
        await handle.write(Buffer.from('OK' + CR + '>', 'latin1'));
        index = commandBuffer.indexOf(CR);
      }
    }
  } catch (error) {
    // EAGAIN on a non-blocking tty is "no byte yet", not a failure.
    if (error && (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK')) {
      await sleep(5);
      continue;
    }
    console.error('device side read failed: ' + String(error));
    process.exit(1);
  }
}
`;
