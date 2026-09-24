import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeSocketCanBinding, type SocketCanBinding } from "@vdp/adapter-socketcan";
import { AdapterUnsupportedError, createLogger, MemorySink, TransportError } from "@vdp/shared";
import { createFrame } from "@vdp/transport-can";
import { test } from "vitest";
import {
  AdapterCatalog,
  type AdapterEntry,
  assertAdapterUsable,
  createHostAdapterCatalog,
  describeAdapterConfig,
  ELM327_DEFAULT_BAUD,
  formatAdapterHelp,
  isWindowsBareComPort,
  isWindowsComPortName,
  missingRequiredSettings,
  openSerialStream,
  parseAdapterArgv,
  SLCAN_DEFAULT_BAUD,
  selectionFromPayload,
  supportedBitrates,
  validateSelection,
} from "./index.js";

/* ------------------------------------------------------- argument parsing */

test("adapter arguments are parsed in both --flag=value and --flag value form", () => {
  const parsed = parseAdapterArgv([
    "--port=8080",
    "--adapter=slcan",
    "--device=/dev/ttyUSB0",
    "--bitrate=250k",
    "--baud",
    "115200",
  ]);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.selection.id, "slcan");
  assert.equal(parsed.selection.config.device, "/dev/ttyUSB0");
  assert.equal(parsed.selection.config.bitrate, "250k");
  assert.equal(parsed.selection.config.baudRate, 115200);
});

test("a following flag is not swallowed as a value", () => {
  const parsed = parseAdapterArgv([
    "--adapter=slcan",
    "--listen-only",
    "--port=8080",
    "--channel=can0",
  ]);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.selection.config.listenOnly, true);
  assert.equal(parsed.selection.config.channel, "can0");
});

test("--can-fd is a SocketCAN flag without a value, refused with one", () => {
  const parsed = parseAdapterArgv(["--adapter=socketcan", "--channel=can0", "--can-fd"]);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.selection.config.canFd, true);

  const refused = parseAdapterArgv(["--can-fd=please"]);
  assert.equal(refused.errors.length, 1);
  assert.match(refused.errors[0] ?? "", /does not take a value/);
  assert.equal(refused.selection.config.canFd, undefined);
});

test("a flag that takes no value rejects one", () => {
  const parsed = parseAdapterArgv(["--listen-only=yes"]);
  assert.equal(parsed.errors.length, 1);
  assert.match(parsed.errors[0] ?? "", /does not take a value/);
  assert.equal(parsed.selection.config.listenOnly, undefined);
});

test("a non-numeric baud rate is rejected instead of silently ignored", () => {
  const parsed = parseAdapterArgv(["--baud=fast"]);
  assert.match(parsed.errors[0] ?? "", /--baud must be a positive integer/);
});

test("the reconnect policy is a bounded pair of flags (E34)", () => {
  const parsed = parseAdapterArgv([
    "--adapter=elm327",
    "--device=/dev/ttyUSB0",
    "--reconnect-attempts=3",
    "--reconnect-delay-ms=500",
  ]);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.selection.config.reconnectAttempts, 3);
  assert.equal(parsed.selection.config.reconnectDelayMs, 500);

  // Fail closed, like --baud: an unbounded or fractional policy is a usage
  // error, never a silently ignored number that turns into a loop.
  const tooMany = parseAdapterArgv(["--reconnect-attempts=99"]);
  assert.match(tooMany.errors[0] ?? "", /--reconnect-attempts must be an integer between 0 and 10/);
  assert.equal(tooMany.selection.config.reconnectAttempts, undefined);
  const fractional = parseAdapterArgv(["--reconnect-delay-ms=1.5"]);
  assert.match(fractional.errors[0] ?? "", /--reconnect-delay-ms must be an integer/);
  const word = parseAdapterArgv(["--reconnect-delay-ms=soon"]);
  assert.match(word.errors[0] ?? "", /--reconnect-delay-ms must be an integer/);

  // Zero is legitimate: it restores the old final state on purpose.
  const off = parseAdapterArgv(["--reconnect-attempts=0"]);
  assert.deepEqual(off.errors, []);
  assert.equal(off.selection.config.reconnectAttempts, 0);
});

test("an HTTP body carries the reconnect policy only as a bounded integer", () => {
  const selection = selectionFromPayload({
    id: "elm327",
    device: "/dev/ttyUSB0",
    reconnectAttempts: 2,
    reconnectDelayMs: "300",
  });
  assert.equal(selection.config.reconnectAttempts, 2);
  assert.equal(selection.config.reconnectDelayMs, 300);
  // Unbounded, fractional or wordy input does not cross the trust boundary.
  const lied = selectionFromPayload({
    id: "elm327",
    reconnectAttempts: 99,
    reconnectDelayMs: "forever",
  });
  assert.equal(lied.config.reconnectAttempts, undefined);
  assert.equal(lied.config.reconnectDelayMs, undefined);
});

test("the adapter description names a configured reconnect policy", () => {
  const entry = createHostAdapterCatalog().require("elm327");
  const described = describeAdapterConfig(entry, {
    device: "/dev/ttyUSB0",
    reconnectAttempts: 2,
    reconnectDelayMs: 500,
  });
  assert.match(described, /reconnect 2×\/500 ms/);
  // The default policy stays out of the one-liner: a decision not made is not
  // a fact worth a line.
  const silent = describeAdapterConfig(entry, { device: "/dev/ttyUSB0" });
  assert.doesNotMatch(silent, /reconnect/);
});

test("unrelated arguments stay untouched by the adapter parser", () => {
  const parsed = parseAdapterArgv(["--sessions=./x", "--interval=100"]);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.selection.id, "simulator");
  assert.deepEqual(parsed.selection.config, {});
});

/* -------------------------------------------------------- catalog checks */

test("the host catalog ships the adapters AGENTS 4 requires", () => {
  const catalog = createHostAdapterCatalog();
  const ids = catalog.ids();
  for (const id of ["elm327", "slcan", "socketcan"])
    assert.ok(ids.includes(id), `missing adapter ${id}`);
  assert.equal(catalog.get("elm327")?.capabilities.can, true);
  assert.equal(
    catalog.get("elm327")?.capabilities.isoTpOffload,
    false,
    "ISO-TP stays in this platform (AGENTS 5)",
  );
});

test("an unknown adapter id fails with the list of known ids", () => {
  const catalog = createHostAdapterCatalog();
  assert.throws(
    () => catalog.require("obd-link-9000"),
    (error: unknown) => {
      assert.ok(error instanceof AdapterUnsupportedError);
      assert.match(error.message, /unknown adapter "obd-link-9000"/);
      assert.match(error.message, /elm327/);
      return true;
    },
  );
});

test("a serial adapter without a device reports the missing setting, not a device error", async () => {
  const catalog = createHostAdapterCatalog();
  const described = await catalog.describe("slcan");
  assert.equal(described.probe.available, false);
  assert.match(described.probe.detail, /missing --device=<serial device>/);
  assert.equal(described.kind, "serial");
  assert.equal(described.transport, "can");
  assert.equal(described.defaults?.baudRate, SLCAN_DEFAULT_BAUD);
});

test("probing a device path that does not exist is reported, never thrown", async () => {
  const catalog = createHostAdapterCatalog();
  const described = await catalog.describe("elm327", { device: "/dev/definitely-not-there" });
  assert.equal(described.probe.available, false);
  assert.match(described.probe.detail, /not usable/);
  assert.ok((described.probe.hints ?? []).length > 0, "a failed probe must suggest a next step");
});

test("required settings are derived from the entry, not from the caller", () => {
  const catalog = createHostAdapterCatalog();
  assert.deepEqual(missingRequiredSettings(catalog.require("elm327"), {}), [
    "--device=<serial device>",
  ]);
  // socketcan declares a channel *default* (can0), so nothing is missing — a
  // default is a decision, not an omission, and must not be reported as an error.
  assert.deepEqual(missingRequiredSettings(catalog.require("socketcan"), {}), []);
  assert.deepEqual(missingRequiredSettings(catalog.require("socketcan"), { channel: "" }), [
    "--channel=<can interface>",
  ]);
});

test("the socketcan probe never throws, whatever the binding does", async () => {
  const catalog = createHostAdapterCatalog();
  const described = await catalog.describe("socketcan", { channel: "can0" });
  assert.equal(typeof described.probe.available, "boolean");
  assert.ok(described.probe.detail.length > 0);
});

/* ------------------------------------------------------ selection checks */

test("validation collects every problem at once", () => {
  const catalog = createHostAdapterCatalog();
  const result = validateSelection(catalog, { id: "slcan", config: {} });
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0] ?? "", /--device/);
});

test("validation applies the entry defaults to the resolved config", () => {
  const catalog = createHostAdapterCatalog();
  const result = validateSelection(catalog, { id: "elm327", config: { device: "/dev/null" } });
  assert.equal(result.ok, true);
  assert.equal(result.resolved.baudRate, ELM327_DEFAULT_BAUD);
  assert.equal(result.resolved.channel, "elm0");
});

test("a bitrate the adapter cannot use is rejected before opening the port", () => {
  const catalog = createHostAdapterCatalog();
  const result = validateSelection(catalog, {
    id: "slcan",
    config: { device: "/dev/null", bitrate: "500m" },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /unsupported bitrate "500m"/);
  assert.ok(supportedBitrates().includes("500k"));
});

test("a selection from an HTTP body ignores unknown fields and coerces a numeric baud rate", () => {
  const selection = selectionFromPayload({
    id: "slcan",
    device: " /dev/ttyUSB0 ",
    bitrate: "500k",
    listenOnly: true,
    baudRate: "115200",
    // An attacker-controlled extra field must not reach the adapter config.
    evil: "rm -rf",
  });
  assert.equal(selection.id, "slcan");
  assert.deepEqual(selection.config, {
    device: "/dev/ttyUSB0",
    bitrate: "500k",
    listenOnly: true,
    baudRate: 115200,
  });
});

test("an HTTP body can ask for CAN-FD, and only as the boolean true", () => {
  const enabled = selectionFromPayload({ id: "socketcan", channel: "can0", canFd: true });
  assert.equal(enabled.config.canFd, true);
  // A string is not a promise: `canFd: "yes"` stays off, like every other
  // boolean in this trust boundary.
  const lied = selectionFromPayload({ id: "socketcan", channel: "can0", canFd: "yes" });
  assert.equal(lied.config.canFd, undefined);
});

test("a non-object body falls back to the default adapter instead of crashing", () => {
  const selection = selectionFromPayload(null, "simulator");
  assert.deepEqual(selection, { id: "simulator", config: {} });
});

test("assertAdapterUsable refuses an unusable device with a transport error", async () => {
  const catalog = createHostAdapterCatalog();
  await assert.rejects(
    () => assertAdapterUsable(catalog.require("elm327"), { device: "/dev/definitely-not-there" }),
    /not usable/,
  );
});

test("the help text lists every registered adapter", () => {
  const catalog = createHostAdapterCatalog();
  const help = formatAdapterHelp(catalog);
  for (const id of catalog.ids()) assert.match(help, new RegExp(id));
  assert.match(help, /--can-fd/, "the FD opt-in is part of the common settings line");
});

test("opening a device that does not exist produces an actionable error", async () => {
  await assert.rejects(
    () => openSerialStream({ device: "/dev/definitely-not-there" }),
    (error: unknown) => {
      assert.ok(error instanceof AdapterUnsupportedError);
      assert.match(error.message, /cannot open serial device/);
      return true;
    },
  );
  await assert.rejects(() => openSerialStream({ device: "  " }), /serial device path is required/);
});

/* ------------------------------------------------------------- utilities */

test("a 29-bit vehicle is reachable from the CLI without editing the code", () => {
  const parsed = parseAdapterArgv(["--adapter=elm327", "--device=/dev/ttyUSB0", "--protocol=7"]);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.selection.config.protocol, 7);
  assert.equal(parsed.selection.config.device, "/dev/ttyUSB0");

  // Both forms, and the refusal: an unknown protocol number must not silently
  // become 6, because 6 is 11-bit and a 29-bit vehicle would then never answer.
  const inline = parseAdapterArgv(["--protocol=9"]);
  assert.equal(inline.selection.config.protocol, 9);
  const bad = parseAdapterArgv(["--protocol=42"]);
  assert.equal(bad.selection.config.protocol, undefined, "a bad number does not take effect");
  assert.match(bad.errors.join(" "), /ISO 15765-4/);
  const word = parseAdapterArgv(["--protocol=seven"]);
  assert.match(word.errors.join(" "), /ISO 15765-4/);
});

test("the protocol survives validation and shows up in the description", () => {
  const catalog = createHostAdapterCatalog();
  const { resolved: config } = validateSelection(catalog, {
    id: "elm327",
    config: { device: "/dev/ttyUSB0", protocol: 7 },
  });
  // The create path is the one that must not drop it: `formatIdentifier` already
  // follows the frame's width, and `canProtocol` makes the bus the adapter
  // listens on follow too. `ATSP7` itself is pinned in the adapter's own spec.
  assert.equal(config.protocol, 7);
  const described = describeAdapterConfig(catalog.list().find((e) => e.id === "elm327")!, config);
  assert.match(described, /ISO 15765-4 protocol 7/, `description was: ${described}`);

  // And it crosses the untrusted-body boundary as a number, never as a word.
  const fromBody = selectionFromPayload({ id: "elm327", device: "COM3", protocol: "9" });
  assert.equal(fromBody.config.protocol, 9);
  assert.equal(
    selectionFromPayload({ id: "elm327", protocol: "seven" }).config.protocol,
    undefined,
    "a word is not a protocol number",
  );
  assert.equal(
    selectionFromPayload({ id: "elm327", protocol: 42 }).config.protocol,
    undefined,
    "and neither is an out-of-range one",
  );
});

test("a Windows COM-port name is recognised in both spellings, and only the bare one is refused", () => {
  // `fs.stat("COM3")` on Windows throws ENOENT for a port that exists, which the
  // probe used to report as "is the adapter plugged in?" — an operator sent to
  // look for a cable that is plugged in. The `\\.\` form the Win32 API wants is
  // left to the filesystem, which resolves it.
  assert.equal(isWindowsComPortName("COM3"), true);
  assert.equal(isWindowsComPortName("com12"), true);
  assert.equal(isWindowsComPortName("  COM7  "), true, "surrounding space is not a name");
  assert.equal(isWindowsComPortName("\\\\.\\COM3"), true, "the device-path form is a port too");
  assert.equal(isWindowsComPortName("COM"), false, "a name with no number is not a port");
  assert.equal(isWindowsComPortName("COMX"), false);
  assert.equal(isWindowsComPortName("/dev/ttyUSB0"), false);
  assert.equal(isWindowsComPortName(""), false);

  // The platform is injectable so the branch is testable from Linux.
  assert.equal(isWindowsBareComPort("COM3", "win32"), true);
  assert.equal(isWindowsBareComPort("\\\\.\\COM3", "win32"), false, "already prefixed");
  assert.equal(isWindowsBareComPort("/dev/ttyUSB0", "win32"), false);
  assert.equal(
    isWindowsBareComPort("COM3", "linux"),
    false,
    "on POSIX a COM name is just a file name",
  );
});

test("on this platform a COM name is answered by the filesystem, not by the Windows branch", async () => {
  // Whatever platform the suite runs on, the probe must not take the Windows
  // branch unless it really is Windows — otherwise a POSIX file named `COM3`
  // would be refused with advice about a device path it does not need.
  const catalog = createHostAdapterCatalog();
  const described = await catalog.describe("elm327", { device: "COM3" });
  if (process.platform === "win32") {
    assert.equal(described.probe.available, false);
    assert.match(described.probe.detail, /Windows port name/);
    assert.match(described.probe.hints?.join(" ") ?? "", /device path/i);
  } else {
    assert.match(described.probe.detail, /not usable|is present/);
    assert.doesNotMatch(described.probe.detail, /Windows port name/);
  }
});

test("temporary files are not mistaken for usable serial devices", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vdp-host-"));
  try {
    const file = join(dir, "not-a-tty.txt");
    await writeFile(file, "hello", "utf8");
    const catalog = createHostAdapterCatalog();
    // A regular file passes the probe by design (FIFO/pipe development setups),
    // but it must never be reported as a serial device in the UI detail text.
    const described = await catalog.describe("elm327", { device: file });
    assert.equal(described.probe.available, true);
    assert.match(described.probe.detail, /present and read\/write accessible/);
    const directory = await catalog.describe("elm327", { device: dir });
    assert.equal(directory.probe.available, false);
    assert.match(directory.probe.detail, /is a directory/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("registering the same adapter twice is a configuration error", () => {
  const catalog = new AdapterCatalog();
  const entry = createHostAdapterCatalog().require("elm327");
  catalog.register(entry);
  assert.throws(() => catalog.register(entry), /already registered/);
});

/* --------------------------------------- catalog: probes, creation, cleanup */

/** An entry that is not one of the shipped ones, for rules no shipped entry triggers. */
function syntheticEntry(overrides: Partial<AdapterEntry> = {}): AdapterEntry {
  return { ...createHostAdapterCatalog().require("elm327"), id: "synthetic", ...overrides };
}

/**
 * A regular file stands in for a serial device: `openSerialStream` opens with
 * `O_RDWR | O_NOCTTY | O_NONBLOCK`, which a regular file satisfies — enough to
 * exercise probing and creation without hardware (AGENTS 31, ADR 0016 §2).
 */
async function withDeviceFile<T>(run: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "vdp-host-"));
  const file = join(dir, "tty-like");
  try {
    await writeFile(file, "", "utf8");
    return await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("required settings cover a trace, and a default is a decision not an omission", () => {
  const replay = syntheticEntry({ requires: { trace: true }, defaults: {} });
  assert.deepEqual(missingRequiredSettings(replay, {}), ["--trace=<trace file>"]);
  assert.deepEqual(missingRequiredSettings(replay, { trace: "trace.json" }), []);
  const decided = syntheticEntry({ requires: { trace: true }, defaults: { trace: "d.json" } });
  assert.deepEqual(missingRequiredSettings(decided, {}), []);
  const everything = syntheticEntry({
    requires: { device: true, channel: true, trace: true },
    defaults: {},
  });
  assert.deepEqual(missingRequiredSettings(everything, {}), [
    "--device=<serial device>",
    "--channel=<can interface>",
    "--trace=<trace file>",
  ]);
});

test("a probe that throws is an unusable adapter, never a crashed caller", async () => {
  const boom = syntheticEntry({ requires: {}, probe: () => Promise.reject(new Error("boom")) });
  await assert.rejects(
    () => assertAdapterUsable(boom, {}),
    (error: unknown) => {
      assert.ok(error instanceof TransportError);
      assert.match(error.message, /probe failed: boom/);
      assert.equal(error.details.adapterId, "synthetic");
      assert.equal(error.details.detail, "probe failed: boom");
      return true;
    },
  );
  // A thrown non-error must still produce a readable reason, not "[object Object]".
  const notAnError = syntheticEntry({ requires: {}, probe: () => Promise.reject("plain string") });
  await assert.rejects(() => assertAdapterUsable(notAnError, {}), /probe failed: plain string/);
});

test("assertAdapterUsable names the missing settings instead of probing", async () => {
  const catalog = createHostAdapterCatalog();
  await assert.rejects(
    () => assertAdapterUsable(catalog.require("elm327"), {}),
    (error: unknown) => {
      assert.ok(error instanceof AdapterUnsupportedError);
      assert.match(error.message, /elm327 needs --device=<serial device>/);
      assert.deepEqual(error.details.missing, ["--device=<serial device>"]);
      return true;
    },
  );
});

test("assertAdapterUsable returns the probe of a usable adapter", () =>
  withDeviceFile(async (file) => {
    const catalog = createHostAdapterCatalog();
    // No context at all: the default parameter must work for CLI callers.
    const probe = await assertAdapterUsable(catalog.require("elm327"), { device: file });
    assert.equal(probe.available, true);
    assert.match(probe.detail, /present and read\/write accessible/);
  }));

test("a device path through a regular file is reported, not thrown", () =>
  withDeviceFile(async (file) => {
    const catalog = createHostAdapterCatalog();
    const described = await catalog.describe("elm327", { device: join(file, "child") });
    assert.equal(described.probe.available, false);
    assert.match(described.probe.detail, /not usable/);
    const hints = described.probe.hints ?? [];
    if (process.platform === "win32") {
      // Windows treats a child of a file as ERROR_PATH_NOT_FOUND (ENOENT in libuv)
      assert.ok(hints.some((hint) => hint.includes("plugged in")));
    } else {
      assert.ok(
        hints.some((hint) => hint.includes("permissions")),
        `a failure that is not ENOENT must point at permissions, got: ${hints.join(" | ")}`,
      );
      assert.ok(
        !hints.some((hint) => hint.includes("plugged in")),
        "absence hints would send the operator looking for a cable that is plugged in",
      );
    }
  }));

test("a device the process may not access reports permissions, not absence", () =>
  withDeviceFile(async (file) => {
    await chmod(file, 0o000);
    try {
      const catalog = createHostAdapterCatalog();
      const described = await catalog.describe("elm327", { device: file });
      if (process.getuid?.() === 0) {
        // root bypasses the permission bits, so the probe legitimately succeeds;
        // insisting on failure here would make the test environment-dependent.
        assert.equal(described.probe.available, true);
        return;
      }
      assert.equal(described.probe.available, false);
      assert.match(described.probe.detail, /not usable/);
      assert.ok(
        (described.probe.hints ?? []).some((hint) => hint.includes("permissions")),
        "the permission branch must be distinguishable from a missing device",
      );
    } finally {
      await chmod(file, 0o644);
    }
  }));

test("creating a serial adapter without a device fails before touching the host", async () => {
  const catalog = createHostAdapterCatalog();
  await assert.rejects(
    () => catalog.require("elm327").create({}, {}),
    /serial device path is required/,
  );
});

test("configurePort runs stty and reports its failure instead of ignoring it", () =>
  withDeviceFile(async (file) => {
    const catalog = createHostAdapterCatalog();
    // A regular file is not a tty, so stty must fail — and the failure must
    // reach the caller instead of being swallowed on the way to the adapter.
    await assert.rejects(
      () => catalog.require("elm327").create({ device: file, configurePort: true }, {}),
      /exited with code|cannot configure/,
    );
  }));

test("slcan creation rejects an unsupported bitrate before writing to the device", () =>
  withDeviceFile(async (file) => {
    const catalog = createHostAdapterCatalog();
    await assert.rejects(
      () => catalog.require("slcan").create({ device: file, bitrate: "500m" }, {}),
      /unsupported slcan bitrate/,
    );
    assert.equal(await readFile(file, "utf8"), "", "a rejected setting must not reach the wire");
  }));

test("slcan listen-only stays an option until open(), which owns the wire sequence", () =>
  withDeviceFile(async (file) => {
    const catalog = createHostAdapterCatalog();
    const bus = await catalog
      .require("slcan")
      .create({ device: file, bitrate: "500k", listenOnly: true }, {});
    try {
      // Symptom before this contract: the catalog wrote "L" to the raw stream
      // at create-time and open() sent its own "O" afterwards — Lawicel reads
      // `O` as the normal-mode open, so the override order silently undid
      // listen-only. Now create() touches nothing and the adapter's open()
      // owns the sequence (the L-instead-of-O order is pinned in
      // canable.spec.ts, where a scripted device answers).
      assert.equal(
        await readFile(file, "utf8"),
        "",
        "creating the bus must not write a single byte (probe-and-create stay side-effect free)",
      );
      assert.equal(bus.isOpen(), false);
      assert.equal(bus.info.id, "canable");
    } finally {
      await bus.close();
    }
  }));

test("closing a created adapter releases the stream the catalog opened", () =>
  withDeviceFile(async (file) => {
    const catalog = createHostAdapterCatalog();
    const sink = new MemorySink();
    const logger = createLogger("can", { level: "DEBUG" }, [sink]);
    const bus = await catalog
      .require("elm327")
      .create({ device: file, channel: "elm0" }, { logger });
    assert.equal(bus.isOpen(), false, "creation must not open the adapter");
    assert.equal(bus.info.id, "elm327");
    assert.deepEqual(bus.info.channels, ["elm0"]);
    assert.equal(bus.capabilities.can, true);
    assert.equal(bus.capabilities.canFd, false);

    // The wrapper delegates instead of reimplementing, so the adapter's own
    // behaviour and wording must survive it.
    const seen: unknown[] = [];
    const off = bus.subscribe((frame) => {
      seen.push(frame);
    });
    assert.equal(typeof off, "function", "subscribe must hand back its unsubscribe");
    off();
    await assert.rejects(
      () =>
        bus.send({
          timestamp: Date.now(),
          id: 0x7e0,
          extended: false,
          fd: false,
          dlc: 2,
          payload: new Uint8Array([0x02, 0x3e]),
          channel: "elm0",
        }),
      /ELM327 adapter is not open/,
    );

    await bus.close();
    // Portable proof: "serial device closed" is logged by SerialByteStream.close()
    // and by nothing else, so its presence proves the stream was released.
    assert.ok(
      sink.all().some((record) => record.message === "serial device closed"),
      "close() must reach the stream — the adapter does not own it, so nobody else does",
    );
    await bus.close(); // disconnecting twice is a normal operator mistake, not an error
    // open() is delegated as well: with the stream released the initialisation
    // fails on its first write instead of hanging on a device that never answers.
    await assert.rejects(() => bus.open(), /is not open/);

    if (existsSync("/proc/self/fd")) {
      // Linux counts the descriptors, which turns the leak into a number:
      // measured before the fix, 24 → 25 after create() and still 25 after close().
      const before = readdirSync("/proc/self/fd").length;
      const second = await catalog.require("elm327").create({ device: file }, {});
      assert.ok(
        readdirSync("/proc/self/fd").length > before,
        "opening a device costs a descriptor",
      );
      await second.close();
      assert.equal(
        readdirSync("/proc/self/fd").length,
        before,
        "every reconnect must give its descriptor back, or the process hits its limit",
      );
    }
  }));

test("the socketcan probe reports what an injected binding lists", async () => {
  const catalog = createHostAdapterCatalog();
  const binding = new FakeSocketCanBinding();
  const context = { loadSocketCanBinding: () => Promise.resolve<SocketCanBinding>(binding) };

  const present = await catalog.describe("socketcan", { channel: "can0" }, context);
  assert.equal(present.probe.available, true);
  assert.match(present.probe.detail, /binding "fake-socketcan" loaded, interface can0/);

  const absent = await catalog.describe("socketcan", { channel: "can9" }, context);
  assert.equal(absent.probe.available, false);
  assert.match(absent.probe.detail, /interface can9 not found/);
  assert.ok(
    (absent.probe.hints ?? []).some((hint) => hint.includes("can0, vcan0")),
    "an unknown interface must be answered with the list of known ones",
  );
});

test("the socketcan probe needs a channel even when the binding loads", async () => {
  const catalog = createHostAdapterCatalog();
  // Called directly: `describe` short-circuits on missing required settings, so
  // this is the defence-in-depth branch behind that check.
  const probe = await catalog
    .require("socketcan")
    .probe(
      {},
      { loadSocketCanBinding: () => Promise.resolve<SocketCanBinding>(new FakeSocketCanBinding()) },
    );
  assert.equal(probe.available, false);
  assert.match(probe.detail, /no --channel given/);
});

test("a binding that cannot load is reported with the reason as a hint", async () => {
  const catalog = createHostAdapterCatalog();
  const described = await catalog.describe(
    "socketcan",
    { channel: "can0" },
    {
      loadSocketCanBinding: () =>
        Promise.reject(new AdapterUnsupportedError('module "socketcan" is not installed')),
    },
  );
  assert.equal(described.probe.available, false);
  assert.match(described.probe.detail, /no SocketCAN transport available/);
  const hints = described.probe.hints ?? [];
  assert.equal(hints.length, 2, "the hint must carry the loader's reason");
  assert.match(hints[0] ?? "", /not installed/);
});

test("a failing interface listing does not decide availability, and is logged", async () => {
  const catalog = createHostAdapterCatalog();
  const sink = new MemorySink();
  const broken: SocketCanBinding = {
    name: "listing-broken",
    open: () => Promise.reject(new Error("not used by the probe")),
    listInterfaces: () => Promise.reject(new Error("ioctl failed")),
  };
  const described = await catalog.describe(
    "socketcan",
    { channel: "can0" },
    {
      loadSocketCanBinding: () => Promise.resolve(broken),
      logger: createLogger("can", { level: "DEBUG" }, [sink]),
    },
  );
  assert.equal(
    described.probe.available,
    true,
    "listing interfaces is best effort — a binding that loaded is usable",
  );
  assert.ok(
    sink.all().some((record) => record.message === "interface listing failed"),
    "the swallowed listing error must leave a structured trace (AGENTS 34.25)",
  );
});

test("socketcan creation needs a channel and uses the injected binding", async () => {
  const catalog = createHostAdapterCatalog();
  await assert.rejects(
    () => catalog.require("socketcan").create({}, {}),
    /SocketCAN interface is required/,
  );
  await assert.rejects(
    () =>
      catalog
        .require("socketcan")
        .create(
          { channel: "can0" },
          { loadSocketCanBinding: () => Promise.reject(new Error("no binding here")) },
        ),
    /no binding here/,
  );

  const binding = new FakeSocketCanBinding();
  const bus = await catalog.require("socketcan").create(
    { channel: "vcan0" },
    {
      loadSocketCanBinding: () => Promise.resolve<SocketCanBinding>(binding),
      logger: createLogger("can", { level: "ERROR" }),
    },
  );
  try {
    await bus.open();
    assert.deepEqual(binding.opened, ["vcan0"], "the injected binding must be the one opened");
    assert.equal(bus.isOpen(), true);
  } finally {
    await bus.close();
  }
  assert.equal(binding.closed, true);
});

test("--can-fd reaches the created adapter and its advertised capabilities", async () => {
  // FD is opt-in at the catalog seam: without the flag the adapter must not
  // advertise it (an interface that cannot carry FD would then receive frames
  // it has to refuse), with the flag ISO-TP may segment into 64-byte frames.
  const catalog = createHostAdapterCatalog();
  const binding = new FakeSocketCanBinding();
  const context = {
    loadSocketCanBinding: () => Promise.resolve<SocketCanBinding>(binding),
    logger: createLogger("can", { level: "ERROR" }),
  };
  const classic = await catalog.require("socketcan").create({ channel: "can0" }, context);
  assert.equal(classic.capabilities.canFd, false);
  const fd = await catalog.require("socketcan").create({ channel: "can0", canFd: true }, context);
  assert.equal(fd.capabilities.canFd, true);
  await fd.open();
  await fd.send(createFrame(0x7e0, new Uint8Array(12).fill(1), { fd: true }));
  assert.equal(binding.sent[0]?.fd, true, "the flag survives the hop into the binding");
  await fd.close();
});

test("describeAdapterConfig prints what is set and nothing else", () => {
  const catalog = createHostAdapterCatalog();
  const slcan = catalog.require("slcan");
  assert.equal(describeAdapterConfig(slcan, {}), slcan.displayName);
  assert.equal(
    describeAdapterConfig(slcan, {
      device: "/dev/ttyUSB0",
      channel: "slcan0",
      baudRate: SLCAN_DEFAULT_BAUD,
      bitrate: "500k",
      trace: "trace.json",
      listenOnly: true,
    }),
    "CANable / CANtact / USBtin (slcan) · /dev/ttyUSB0 · channel slcan0 · 115200 baud · 500k · trace.json · listen-only",
  );
  assert.equal(
    describeAdapterConfig(catalog.require("socketcan"), { channel: "can0", canFd: true }),
    "SocketCAN (Linux) · channel can0 · CAN-FD",
  );
});

test("describeAll probes every entry without opening a device", async () => {
  const catalog = createHostAdapterCatalog();
  const described = await catalog.describeAll();
  assert.deepEqual(
    described.map((entry) => entry.id).sort(),
    catalog.ids().sort(),
    "the operator list must contain exactly the registered adapters",
  );
  for (const entry of described) {
    assert.equal(typeof entry.probe.available, "boolean");
    assert.ok(entry.probe.detail.length > 0, "every entry must say why it is (not) usable");
  }
  // No device is configured here, so the serial entries must report the missing
  // setting instead of a device error — this list is what the operator reads first.
  assert.match(
    described.find((entry) => entry.id === "slcan")?.probe.detail ?? "",
    /missing --device=<serial device>/,
  );
});

test("the slcan probe validates the bitrate before it looks at the device", async () => {
  const catalog = createHostAdapterCatalog();
  const noDevice = await catalog.require("slcan").probe({}, {});
  assert.equal(noDevice.available, false);
  assert.match(noDevice.detail, /no --device given/);

  const badBitrate = await catalog.describe("slcan", { device: "/dev/ttyUSB0", bitrate: "500m" });
  assert.equal(badBitrate.probe.available, false);
  assert.match(badBitrate.probe.detail, /unsupported bitrate "500m"/);
  assert.ok(
    (badBitrate.probe.hints ?? []).some((hint) => hint.includes("500k")),
    "an unsupported bitrate must be answered with the supported ones",
  );

  const absent = await catalog.describe("slcan", { device: "/dev/definitely-not-there" });
  assert.equal(absent.probe.available, false);
  assert.match(absent.probe.detail, /not usable/, "the 500k default must reach the device probe");

  await withDeviceFile(async (file) => {
    const usable = await catalog.describe("slcan", { device: file });
    assert.equal(usable.probe.available, true);
    assert.match(usable.probe.detail, /read\/write accessible/);
  });
});

test("a binding without interface listing is usable, a non-error still readable", async () => {
  const catalog = createHostAdapterCatalog();
  // `listInterfaces` is optional in the binding contract: without it the probe
  // must fall back to "no information" and stay available instead of reporting
  // an interface it never asked about.
  const silent: SocketCanBinding = {
    name: "no-listing",
    open: () => Promise.reject(new Error("not used by the probe")),
  };
  const described = await catalog.describe(
    "socketcan",
    { channel: "can0" },
    { loadSocketCanBinding: () => Promise.resolve(silent) },
  );
  assert.equal(described.probe.available, true);
  assert.match(described.probe.detail, /binding "no-listing" loaded/);

  // A loader that rejects with something that is not an Error must still yield
  // a readable hint instead of "[object Object]".
  const odd = await catalog.describe(
    "socketcan",
    { channel: "can0" },
    { loadSocketCanBinding: () => Promise.reject("binding exploded") },
  );
  assert.equal(odd.probe.available, false);
  assert.ok(
    (odd.probe.hints ?? []).some((hint) => hint.includes("binding exploded")),
    `the rejection reason must survive as a hint, got: ${(odd.probe.hints ?? []).join(" | ")}`,
  );
});

test("slcan without listen-only writes nothing before the channel opens", () =>
  withDeviceFile(async (file) => {
    const catalog = createHostAdapterCatalog();
    const bus = await catalog.require("slcan").create({ device: file, bitrate: "500k" }, {});
    try {
      assert.equal(
        await readFile(file, "utf8"),
        "",
        "without listenOnly nothing may reach the wire at creation time",
      );
      assert.equal(bus.isOpen(), false);
    } finally {
      await bus.close();
    }
  }));

test("slcan creation keeps every optional setting optional", () =>
  withDeviceFile(async (file) => {
    const catalog = createHostAdapterCatalog();
    // No bitrate (500k default), no channel, no logger: an operator who passes
    // only --device must still get a working bus.
    const plain = await catalog.require("slcan").create({ device: file }, {});
    try {
      assert.deepEqual(plain.info.channels, ["slcan0"], "the adapter default channel applies");
      assert.equal(plain.capabilities.can, true);
      assert.equal(plain.capabilities.canFd, false);
    } finally {
      await plain.close();
    }

    const configured = await catalog
      .require("slcan")
      .create(
        { device: file, bitrate: "500k", channel: "slcan1" },
        { logger: createLogger("can", { level: "ERROR" }, [new MemorySink()]) },
      );
    try {
      assert.deepEqual(configured.info.channels, ["slcan1"], "the configured channel must win");
    } finally {
      await configured.close();
    }
  }));

test("socketcan creation works without a host logger", async () => {
  const catalog = createHostAdapterCatalog();
  const binding = new FakeSocketCanBinding();
  const bus = await catalog
    .require("socketcan")
    .create(
      { channel: "can0" },
      { loadSocketCanBinding: () => Promise.resolve<SocketCanBinding>(binding) },
    );
  try {
    await bus.open();
    assert.deepEqual(binding.opened, ["can0"]);
    assert.equal(bus.isOpen(), true);
    assert.equal(bus.info.id, "socketcan");
  } finally {
    await bus.close();
  }
  assert.equal(binding.closed, true, "closing the bus must close the channel");
});
