import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SocketCanFrameData } from "@vdp/adapter-socketcan";
import { TransportError } from "@vdp/shared";
import { afterAll, beforeAll, test } from "vitest";
import { waitFor } from "../../../../tests/helpers/wait.js";
import {
  type CandumpChild,
  type CanUtilsBindingOptions,
  canInterfaceState,
  createCanUtilsSocketCanBinding,
  findCanUtils,
  formatCansendFrame,
  listCanInterfaces,
  parseCandumpLine,
  resolveSocketCanBinding,
} from "./socketcan-fallback.js";

/* ------------------------------------------------------- temp environment */

let root = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "vdp-socketcan-fallback-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Build a tiny /sys/class/net tree: can0 (down), can1 (up), eth0 (not CAN). */
function makeSysfs(): string {
  const sysfs = join(root, `sysfs-${Math.random().toString(36).slice(2, 8)}`);
  const entries: Array<[string, string, string]> = [
    ["can0", "280", "down"],
    ["can1", "280", "up"],
    ["eth0", "1", "up"],
    ["vcan0", "280", "unknown"],
  ];
  for (const [name, type, operstate] of entries) {
    const dir = join(sysfs, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "type"), `${type}\n`);
    writeFileSync(join(dir, "operstate"), `${operstate}\n`);
  }
  return sysfs;
}

function makePathDir(...binaries: string[]): string {
  const dir = join(root, `bin-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  for (const binary of binaries) {
    const file = join(dir, binary);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  }
  return dir;
}

/** Controllable candump child: the test pushes lines/exits/errors through it. */
function fakeCandumpChild(): CandumpChild & {
  dataLine(line: string): void;
  exitChild(code: number | null): void;
  errorChild(error: Error): void;
  killed(): boolean;
} {
  const dataListeners: Array<(chunk: Uint8Array) => void> = [];
  const errorListeners: Array<(error: Error) => void> = [];
  const exitListeners: Array<(code: number | null) => void> = [];
  let killed = false;
  return {
    stdout: {
      on(_event: "data", listener: (chunk: Uint8Array) => void) {
        dataListeners.push(listener);
      },
    },
    onError(listener: (error: Error) => void) {
      errorListeners.push(listener);
    },
    onExit(listener: (code: number | null) => void) {
      exitListeners.push(listener);
    },
    kill() {
      killed = true;
    },
    dataLine(line: string) {
      const chunk = new TextEncoder().encode(`${line}\n`);
      for (const listener of dataListeners) listener(chunk);
    },
    exitChild(code: number | null) {
      for (const listener of exitListeners) listener(code);
    },
    errorChild(error: Error) {
      for (const listener of errorListeners) listener(error);
    },
    killed: () => killed,
  };
}

function bindingOptions(
  sysfs: string,
  pathDirs: string[],
  child: ReturnType<typeof fakeCandumpChild>,
  sent: string[] = [],
): CanUtilsBindingOptions {
  return {
    sysfsRoot: sysfs,
    pathDirs,
    startCandump: () => Promise.resolve(child),
    runCansend: (_iface, frame) => {
      sent.push(frame);
      return Promise.resolve();
    },
    startupWindowMs: 10,
    sendTimeoutMs: 100,
  };
}

/* --------------------------------------------------------------- /sys bits */

test("canInterfaceState reads presence, kind and up-state from /sys", () => {
  const sysfs = makeSysfs();
  assert.deepEqual(canInterfaceState("can1", sysfs), {
    present: true,
    isCan: true,
    up: true,
    operstate: "up",
  });
  assert.deepEqual(canInterfaceState("can0", sysfs), {
    present: true,
    isCan: true,
    up: false,
    operstate: "down",
  });
  // operstate "unknown" is what a vcan reports while perfectly usable.
  assert.equal(canInterfaceState("vcan0", sysfs).up, true);
  assert.equal(canInterfaceState("eth0", sysfs).isCan, false);
  assert.deepEqual(canInterfaceState("nope0", sysfs), {
    present: false,
    isCan: false,
    up: false,
    operstate: "absent",
  });
});

test("listCanInterfaces returns only real CAN interfaces, sorted", () => {
  const sysfs = makeSysfs();
  assert.deepEqual(listCanInterfaces(sysfs), ["can0", "can1", "vcan0"]);
  assert.deepEqual(listCanInterfaces(join(root, "no-such-sysfs")), []);
});

/* -------------------------------------------------------------- binaries */

test("findCanUtils finds only executable binaries on the given PATH", () => {
  const withBoth = makePathDir("candump", "cansend");
  const withOne = makePathDir("candump");
  const script = join(withOne, "not-executable");
  writeFileSync(script, "x");
  chmodSync(script, 0o644);
  assert.deepEqual(findCanUtils([withBoth]), {
    candump: join(withBoth, "candump"),
    cansend: join(withBoth, "cansend"),
  });
  assert.deepEqual(findCanUtils([withOne]), { candump: join(withOne, "candump"), cansend: null });
  assert.deepEqual(findCanUtils([]), { candump: null, cansend: null });
});

/* --------------------------------------------------------------- the wire */

test("formatCansendFrame formats standard and extended frames", () => {
  const standard: SocketCanFrameData = {
    id: 0x7e0,
    extended: false,
    data: Uint8Array.from([2, 62, 0]),
  };
  assert.equal(formatCansendFrame(standard), "7E0#023E00");
  const extended: SocketCanFrameData = {
    id: 0x18daf100,
    extended: true,
    data: Uint8Array.from([2, 62, 0]),
  };
  assert.equal(formatCansendFrame(extended), "18DAF100#023E00");
});

test("parseCandumpLine parses logcompact lines and refuses what it cannot prove", () => {
  const frame = parseCandumpLine("(1718534567.890123) can0 7E8#023E80");
  assert.ok(frame);
  assert.equal(frame.id, 0x7e8);
  assert.equal(frame.extended, false);
  assert.deepEqual(Array.from(frame.data), [2, 0x3e, 0x80]);

  const extended = parseCandumpLine("(1.5) vcan0 18DAF100#0222");
  assert.ok(extended);
  assert.equal(extended.extended, true);

  // What must never become a frame: remote requests, CAN-FD (## marker),
  // malformed hex, a byte cut in half, candump's own chatter.
  assert.equal(parseCandumpLine("(1.5) can0 7E8#R"), null, "remote frames carry no payload");
  assert.equal(parseCandumpLine("(1.5) can0 7E8##1023E80"), null, "FD frames are not classic CAN");
  assert.equal(parseCandumpLine("(1.5) can0 7E8#023E8"), null, "half a byte is not a byte");
  assert.equal(parseCandumpLine("(1.5) can0 7E8#023E80" + "1".repeat(18)), null);
  assert.equal(parseCandumpLine("candump: interface can0 is down"), null);
  assert.equal(parseCandumpLine(""), null);
  // Data longer than classic CAN (16 hex chars) is refused at the gate.
  assert.equal(parseCandumpLine(`(1.5) can0 7E8#${"00".repeat(9)}`), null);
});

/* ------------------------------------------------------------ the binding */

test("the can-utils binding opens, relays frames in and formats cansend out", async () => {
  const sysfs = makeSysfs();
  const pathDirs = [makePathDir("candump", "cansend")];
  const child = fakeCandumpChild();
  const sent: string[] = [];
  const binding = createCanUtilsSocketCanBinding(bindingOptions(sysfs, pathDirs, child, sent));
  assert.equal(binding.name, "can-utils");
  assert.deepEqual(await binding.listInterfaces?.(), ["can0", "can1", "vcan0"]);

  const channel = await binding.open("can1");
  const seen: SocketCanFrameData[] = [];
  channel.onData((frame) => seen.push(frame));
  child.dataLine("(1718534567.890123) can1 7E8#023E80");
  child.dataLine("(1718534567.900123) can1 7E8#R");
  assert.deepEqual(seen.length, 1);
  assert.deepEqual(Array.from(seen[0]?.data ?? new Uint8Array()), [2, 0x3e, 0x80]);

  await channel.send({ id: 0x7e0, extended: false, data: Uint8Array.from([2, 0x3e, 0]) });
  assert.deepEqual(sent, ["7E0#023E00"]);

  await channel.close();
  assert.equal(child.killed(), true, "close kills the candump child");
  await assert.rejects(
    channel.send({ id: 0x7e0, extended: false, data: new Uint8Array() }),
    /closed/,
  );
});

test("open() refuses a missing, non-CAN, or down interface with the fix in the message", async () => {
  const sysfs = makeSysfs();
  const pathDirs = [makePathDir("candump", "cansend")];
  const binding = createCanUtilsSocketCanBinding(
    bindingOptions(sysfs, pathDirs, fakeCandumpChild()),
  );
  await assert.rejects(binding.open("nope0"), (error: unknown) =>
    error instanceof TransportError
      ? error.message.includes("does not exist") && error.message.includes("vcan0")
      : false,
  );
  await assert.rejects(binding.open("eth0"), (error: unknown) =>
    error instanceof TransportError ? error.message.includes("not a CAN interface") : false,
  );
  await assert.rejects(binding.open("can0"), (error: unknown) =>
    error instanceof TransportError
      ? error.message.includes("is down (down)") &&
        error.message.includes("ip link set dev can0 up")
      : false,
  );
});

test("open() fails clearly when the binaries are missing", async () => {
  const sysfs = makeSysfs();
  const binding = createCanUtilsSocketCanBinding({
    sysfsRoot: sysfs,
    pathDirs: [makePathDir("nothing-in-here")],
    startupWindowMs: 10,
  });
  await assert.rejects(binding.open("can1"), (error: unknown) =>
    error instanceof TransportError ? error.message.includes("apt install can-utils") : false,
  );
});

test("an early candump exit fails the open with the interface question named", async () => {
  const sysfs = makeSysfs();
  const pathDirs = [makePathDir("candump", "cansend")];
  const child = fakeCandumpChild();
  const binding = createCanUtilsSocketCanBinding(bindingOptions(sysfs, pathDirs, child));
  const opening = binding.open("can1");
  await Promise.resolve();
  child.exitChild(1);
  await assert.rejects(opening, (error: unknown) =>
    error instanceof TransportError
      ? error.message.includes("exited with code 1") && error.message.includes("can1")
      : false,
  );
});

test("a cansend that exits non-zero is a transport error, not a swallowed failure", async () => {
  const sysfs = makeSysfs();
  const pathDirs = [makePathDir("candump", "cansend")];
  const child = fakeCandumpChild();
  const binding = createCanUtilsSocketCanBinding({
    ...bindingOptions(sysfs, pathDirs, child),
    runCansend: () => Promise.reject(new Error("write: no buffer space available")),
  });
  const channel = await binding.open("can1");
  await assert.rejects(
    channel.send({ id: 0x7e0, extended: false, data: Uint8Array.from([1]) }),
    /cansend .* failed: .*no buffer space/,
  );
  await channel.close();
});

/* ---------------------------------------------------------- the fallback chain */

test("resolveSocketCanBinding prefers the native binding", async () => {
  const native = { name: "native-fake", open: async () => ({}) as never };
  const resolution = await resolveSocketCanBinding({
    tryNative: async () => native as never,
    canUtilsAvailable: () => true,
    createCanUtils: () => {
      throw new Error("must not be called when the native one works");
    },
  });
  assert.equal(resolution.source, "native");
  assert.equal(resolution.binding, native);
});

test("resolveSocketCanBinding falls back to can-utils when the native module is absent", async () => {
  const fallback = { name: "can-utils-fake", open: async () => ({}) as never };
  const resolution = await resolveSocketCanBinding({
    tryNative: async () => {
      throw new Error("module not found");
    },
    canUtilsAvailable: () => true,
    createCanUtils: () => fallback as never,
  });
  assert.equal(resolution.source, "can-utils");
  assert.equal(resolution.binding, fallback);
});

test("resolveSocketCanBinding names both missing pieces when neither path exists", async () => {
  const resolution = await resolveSocketCanBinding({
    tryNative: async () => {
      throw new Error("module not found");
    },
    canUtilsAvailable: () => false,
  });
  assert.equal(resolution.source, "none");
  assert.equal(resolution.binding, null);
  assert.match(resolution.reason ?? "", /npm i socketcan/);
  assert.match(resolution.reason ?? "", /apt install can-utils/);
});

test('an interface without an operstate file reads as "unknown" — and usable (vcan semantics)', () => {
  const sysfs = join(root, `sysfs-no-operstate-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(sysfs, "can7"), { recursive: true });
  writeFileSync(join(sysfs, "can7", "type"), "280\n");
  const state = canInterfaceState("can7", sysfs);
  assert.equal(state.operstate, "unknown");
  assert.equal(state.up, true, 'a missing operstate must not be read as "down"');
});

test("a candump spawn error fails the startup with the cause in the message", async () => {
  const sysfs = makeSysfs();
  const pathDirs = [makePathDir("candump", "cansend")];
  const child = fakeCandumpChild();
  const binding = createCanUtilsSocketCanBinding(bindingOptions(sysfs, pathDirs, child));
  const opening = binding.open("can1");
  await Promise.resolve();
  child.errorChild(new Error("spawn candump ENOENT"));
  await assert.rejects(opening, (error: unknown) =>
    error instanceof TransportError ? error.message.includes("could not start candump") : false,
  );
});

test("the default spawn/execFile implementations drive real stub binaries end to end", async () => {
  // Real processes, real stdio — but pointing at shell-script stubs instead of
  // can-utils (the explicit binary paths exist exactly for this). The stub's
  // echo is deliberately delayed *behind* the startup window: a frame between
  // candump-start and the first listener is dropped in production as well —
  // the test subscribes before the echo and must see exactly one frame.
  const sysfs = makeSysfs();
  const bin = join(root, `stub-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(bin, { recursive: true });
  const sentLog = join(bin, "cansend.log");
  const candumpScript = join(bin, "candump");
  writeFileSync(
    candumpScript,
    '#!/bin/sh\nsleep 0.4\necho "(1718534567.01) can1 7E8#023E80"\nexec sleep 30\n',
  );
  const cansendScript = join(bin, "cansend");
  writeFileSync(cansendScript, `#!/bin/sh\necho "$@" >> ${sentLog}\nexit 0\n`);
  chmodSync(candumpScript, 0o755);
  chmodSync(cansendScript, 0o755);

  const binding = createCanUtilsSocketCanBinding({
    sysfsRoot: sysfs,
    candumpPath: candumpScript,
    cansendPath: cansendScript,
    startupWindowMs: 100,
  });
  const channel = await binding.open("can1");
  try {
    const seen: SocketCanFrameData[] = [];
    channel.onData((frame) => seen.push(frame));
    await waitFor(() => seen.length > 0, undefined, {
      timeoutMs: 5000,
      message: "the stub's frame line reaches onData",
    });
    assert.deepEqual(Array.from(seen[0]?.data ?? new Uint8Array()), [2, 0x3e, 0x80]);

    await channel.send({ id: 0x7e0, extended: false, data: Uint8Array.from([2, 0x3e, 0]) });
    const sent = readFileSync(sentLog, "utf8").trim().split("\n");
    assert.deepEqual(sent, ["can1 7E0#023E00"], "cansend got interface and frame as separate args");
  } finally {
    await channel.close();
  }
});

test("a stub cansend exiting non-zero surfaces the failure through the default runner", async () => {
  const sysfs = makeSysfs();
  const bin = join(root, `stubfail-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(bin, { recursive: true });
  const candumpScript = join(bin, "candump");
  writeFileSync(candumpScript, "#!/bin/sh\nexec sleep 30\n");
  const cansendScript = join(bin, "cansend");
  writeFileSync(cansendScript, "#!/bin/sh\necho 'write: no buffer space available' >&2\nexit 1\n");
  chmodSync(candumpScript, 0o755);
  chmodSync(cansendScript, 0o755);
  const binding = createCanUtilsSocketCanBinding({
    sysfsRoot: sysfs,
    candumpPath: candumpScript,
    cansendPath: cansendScript,
    startupWindowMs: 30,
  });
  const channel = await binding.open("can1");
  try {
    await assert.rejects(
      channel.send({ id: 0x7e0, extended: false, data: Uint8Array.from([1]) }),
      /cansend .* failed:/,
    );
  } finally {
    await channel.close();
  }
});

test("a default cansend that outlasts its budget is a transport error, bounded", async () => {
  const sysfs = makeSysfs();
  const bin = join(root, `stubslow-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(bin, { recursive: true });
  const candumpScript = join(bin, "candump");
  writeFileSync(candumpScript, "#!/bin/sh\nexec sleep 30\n");
  const cansendScript = join(bin, "cansend");
  writeFileSync(cansendScript, "#!/bin/sh\nexec sleep 30\n");
  chmodSync(candumpScript, 0o755);
  chmodSync(cansendScript, 0o755);
  const binding = createCanUtilsSocketCanBinding({
    sysfsRoot: sysfs,
    candumpPath: candumpScript,
    cansendPath: cansendScript,
    startupWindowMs: 30,
    sendTimeoutMs: 40,
  });
  const channel = await binding.open("can1");
  try {
    await assert.rejects(
      channel.send({ id: 0x7e0, extended: false, data: Uint8Array.from([1]) }),
      /did not finish within 40 ms/,
    );
  } finally {
    await channel.close();
  }
});
