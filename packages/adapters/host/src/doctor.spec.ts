import assert from "node:assert/strict";
import { CanableAdapter } from "@vdp/adapter-canable";
import { Elm327Adapter, MemoryByteStream } from "@vdp/adapter-elm327";
import { FakeSocketCanBinding, SocketCanAdapter } from "@vdp/adapter-socketcan";
import { TransportError } from "@vdp/shared";
import { test } from "vitest";
import { AdapterCatalog, type AdapterEntry } from "./catalog.js";
import { runAdapterDoctor } from "./doctor.js";

/* Fakes on real adapter code paths: the doctor drives the actual
 * Elm327Adapter/CanableAdapter handshake, with the memory stream as the wire. */

function elmEntry(): AdapterEntry {
  return {
    id: "elm327",
    displayName: "ELM327 / OBDLink (serial)",
    kind: "serial",
    transport: "can",
    description: "test entry",
    capabilities: Elm327Adapter.CAPABILITIES,
    requires: {},
    probe: async () => ({ available: true, detail: "device present (test)" }),
    create: async () => {
      throw new Error("doctor tests always inject createBus");
    },
  };
}

function slcanEntry(): AdapterEntry {
  return {
    id: "slcan",
    displayName: "CANable / CANtact (slcan)",
    kind: "serial",
    transport: "can",
    description: "test entry",
    capabilities: CanableAdapter.CAPABILITIES,
    requires: {},
    probe: async () => ({ available: true, detail: "device present (test)" }),
    create: async () => {
      throw new Error("doctor tests always inject createBus");
    },
  };
}

/** A scripted ELM327 on the memory stream, including a vehicular side. */
function scriptedElm(
  options: { silent?: boolean; voltage?: string; answerPing?: boolean } = {},
): Elm327Adapter {
  const stream = new MemoryByteStream();
  stream.open();
  stream.responder = (command) => {
    if (options.silent) return null;
    const trimmed = command.replace(/\r$/, "");
    if (trimmed === "ATZ") return "\rELM327 v2.1\r\n>";
    if (trimmed === "ATDP") return "\rAUTO, ISO 15765-4 (CAN 11/500)\r\n>";
    if (trimmed === "ATRV") return `\r${options.voltage ?? "13.8V"}\r\n>`;
    if (trimmed.startsWith("AT")) return "OK\r\n>";
    // The functional TesterPresent ping: one answering ECU if scripted.
    if (trimmed.includes("3E")) {
      const answer = options.answerPing === false ? "NO DATA" : "7E8 02 50 03";
      return `\r${answer}\r\n>`;
    }
    return "OK\r\n>";
  };
  return new Elm327Adapter({ stream, commandTimeoutMs: 200 });
}

function scriptedCanable(
  options: { belFirst?: boolean; answerPing?: boolean } = {},
): CanableAdapter {
  const stream = new MemoryByteStream();
  stream.open();
  let firstCommand = true;
  stream.responder = (command) => {
    const trimmed = command.replace(/\r$/, "");
    if (options.belFirst && firstCommand) {
      firstCommand = false;
      return "";
    }
    firstCommand = false;
    if (trimmed === "V") return "V0101\r";
    if (trimmed.includes("3E")) {
      // Lawicel acks the TX, then the ECU answers on the bus.
      return options.answerPing === false ? "\r" : "\rt7E825003\r";
    }
    return "\r";
  };
  return new CanableAdapter({ stream, commandTimeoutMs: 200 });
}

function catalogWith(...entries: AdapterEntry[]): AdapterCatalog {
  return new AdapterCatalog(entries);
}

function stepStatus(
  report: Awaited<ReturnType<typeof runAdapterDoctor>>,
  id: string,
): string | undefined {
  return report.steps.find((s) => s.id === id)?.status;
}

test("doctor: a healthy ELM327 setup passes end to end with firmware, voltage and responders", async () => {
  const adapter = scriptedElm();
  const report = await runAdapterDoctor(
    { id: "elm327", config: { device: "/dev/fake" } },
    {
      catalog: catalogWith(elmEntry()),
      createBus: async () => adapter,
      pingWindowMs: 100,
    },
  );
  assert.equal(report.verdict, "ready");
  assert.equal(report.openedAndClosed, true);
  for (const s of report.steps) {
    assert.notEqual(s.status, "fail", `step ${s.id} should not fail: ${s.detail}`);
  }
  assert.match(report.steps.find((s) => s.id === "identify")?.detail ?? "", /ELM327 v2\.1/);
  assert.match(report.steps.find((s) => s.id === "voltage")?.detail ?? "", /13\.8 V/);
  assert.match(report.steps.find((s) => s.id === "ping")?.detail ?? "", /0x7E8/);
});

test("doctor: a silent wire fails at the open step with the handshake reason and hints", async () => {
  const report = await runAdapterDoctor(
    { id: "elm327", config: { device: "/dev/fake" } },
    {
      catalog: catalogWith(elmEntry()),
      createBus: async () => scriptedElm({ silent: true }),
    },
  );
  assert.equal(report.verdict, "needs-attention");
  assert.equal(stepStatus(report, "probe"), "ok", "the device itself was present");
  assert.equal(stepStatus(report, "open"), "fail");
  const openStep = report.steps.find((s) => s.id === "open");
  assert.match(openStep?.detail ?? "", /timed out/);
  assert.ok(
    (openStep?.hints ?? []).some((h) => h.includes("Baudrate")),
    `serial hints must name the baud question, got: ${(openStep?.hints ?? []).join(" | ")}`,
  );
});

test("doctor: no vehicle power and no answer are warnings, not fatal failures", async () => {
  const report = await runAdapterDoctor(
    { id: "elm327", config: {} },
    {
      catalog: catalogWith(elmEntry()),
      createBus: async () => scriptedElm({ voltage: "0.0V", answerPing: false }),
      pingWindowMs: 30,
    },
  );
  assert.equal(report.verdict, "ready", "warnings inform; they must not block day X");
  assert.equal(stepStatus(report, "voltage"), "warn");
  assert.equal(stepStatus(report, "ping"), "warn");
  assert.match(report.steps.find((s) => s.id === "ping")?.detail ?? "", /NO DATA/);
});

test("doctor: a healthy slcan setup reports its firmware and the answering ECU", async () => {
  const report = await runAdapterDoctor(
    { id: "slcan", config: { device: "/dev/fake" } },
    {
      catalog: catalogWith(slcanEntry()),
      createBus: async () => scriptedCanable(),
      pingWindowMs: 100,
    },
  );
  assert.equal(report.verdict, "ready");
  assert.equal(report.openedAndClosed, true);
  assert.match(report.steps.find((s) => s.id === "identify")?.detail ?? "", /0101/);
  assert.match(report.steps.find((s) => s.id === "ping")?.detail ?? "", /0x7E8/);
});

test("doctor: listen-only skips the vehicle ping deliberately", async () => {
  const report = await runAdapterDoctor(
    { id: "slcan", config: { listenOnly: true } },
    {
      catalog: catalogWith(slcanEntry()),
      createBus: async () => scriptedCanable(),
    },
  );
  assert.equal(report.verdict, "ready");
  assert.equal(stepStatus(report, "ping"), "skip");
  assert.match(report.steps.find((s) => s.id === "ping")?.detail ?? "", /Listen-only/);
});

test("doctor: a socketcan entry works, and the vcan hint names an empty bus benignly", async () => {
  const binding = new FakeSocketCanBinding();
  const socketcanEntry: AdapterEntry = {
    id: "socketcan",
    displayName: "SocketCAN (Linux)",
    kind: "socketcan",
    transport: "can",
    description: "test entry",
    capabilities: SocketCanAdapter.CAPABILITIES,
    requires: {},
    probe: async () => ({ available: true, detail: "binding fake (test)" }),
    create: async () => new SocketCanAdapter({ binding, iface: "vcan0" }),
  };
  const report = await runAdapterDoctor(
    { id: "socketcan", config: { channel: "vcan0" } },
    { catalog: catalogWith(socketcanEntry), pingWindowMs: 30 },
  );
  assert.equal(report.verdict, "ready");
  const ping = report.steps.find((s) => s.id === "ping");
  assert.equal(ping?.status, "warn");
  assert.ok(
    (ping?.hints ?? []).some((h) => h.includes("vcan0")),
    "the empty-bus answer must explain that an empty vcan is the expected world",
  );
});

test("doctor: an invalid selection is blocked before any device work", async () => {
  const report = await runAdapterDoctor(
    { id: "does-not-exist", config: {} },
    { catalog: catalogWith(elmEntry()) },
  );
  assert.equal(report.verdict, "blocked");
  assert.equal(report.steps.length, 1);
  assert.equal(report.steps[0]?.status, "fail");
});

test("doctor: a managed entry skips hardware checking", async () => {
  const managed: AdapterEntry = {
    ...elmEntry(),
    id: "simulator",
    displayName: "Simulator",
    managedBy: "application",
  };
  const report = await runAdapterDoctor(
    { id: "simulator", config: {} },
    { catalog: catalogWith(managed) },
  );
  assert.equal(report.verdict, "ready");
  assert.equal(stepStatus(report, "managed"), "skip");
});

test("doctor: a bus that fails to open reports the reason instead of exploding", async () => {
  const report = await runAdapterDoctor(
    { id: "elm327", config: {} },
    {
      catalog: catalogWith(elmEntry()),
      createBus: async () => {
        throw new TransportError("cannot open serial device /dev/fake: ENOENT");
      },
    },
  );
  assert.equal(report.verdict, "needs-attention");
  assert.equal(stepStatus(report, "open"), "fail");
  assert.match(report.steps.find((s) => s.id === "open")?.detail ?? "", /ENOENT/);
});

test("doctor: without a catalog only the settings step runs", async () => {
  const report = await runAdapterDoctor({ id: "elm327", config: {} });
  assert.equal(report.steps.length, 2);
  assert.match(report.steps[1]?.detail ?? "", /kein Katalog/);
});

test("doctor: a failing probe stops the walk with its hints", async () => {
  const failing: AdapterEntry = {
    ...elmEntry(),
    probe: async () => ({
      available: false,
      detail: "no device candidates found",
      hints: ["ls -l /dev/ttyUSB*"],
    }),
  };
  const report = await runAdapterDoctor(
    { id: "elm327", config: {} },
    { catalog: catalogWith(failing) },
  );
  assert.equal(report.verdict, "needs-attention");
  const probeStep = report.steps.find((s) => s.id === "probe");
  assert.equal(probeStep?.status, "fail");
  assert.deepEqual(probeStep?.hints, ["ls -l /dev/ttyUSB*"]);
});

test("doctor: a socketcan open failure names the interface question", async () => {
  const brokenBinding = {
    name: "broken-binding",
    open: () => Promise.reject(new Error("NETDEV: network is down")),
  };
  const broken: AdapterEntry = {
    id: "socketcan",
    displayName: "SocketCAN (Linux)",
    kind: "socketcan",
    transport: "can",
    description: "test",
    capabilities: SocketCanAdapter.CAPABILITIES,
    requires: {},
    probe: async () => ({ available: true, detail: "ok" }),
    create: async () => new SocketCanAdapter({ binding: brokenBinding, iface: "can0" }),
  };
  const report = await runAdapterDoctor(
    { id: "socketcan", config: { channel: "can0" } },
    { catalog: catalogWith(broken) },
  );
  assert.equal(stepStatus(report, "open"), "fail");
  const hints = report.steps.find((s) => s.id === "open")?.hints ?? [];
  assert.ok(
    hints.some((h) => h.includes("ip -details link show")),
    `socketcan hints must name the interface inspection, got: ${hints.join(" | ")}`,
  );
});

test("doctor: an unregistered adapter kind gets no canned hints, no crash", async () => {
  const odd: AdapterEntry = {
    ...elmEntry(),
    id: "vendor-x",
  };
  const report = await runAdapterDoctor(
    { id: "vendor-x", config: {} },
    {
      catalog: catalogWith(odd),
      createBus: async () => {
        throw new TransportError("vendor said no");
      },
    },
  );
  assert.equal(report.verdict, "needs-attention");
  assert.equal(report.steps.length, 3);
});

test("doctor: a silent ATRV is a warning with the plug hints, not an abort", async () => {
  const silent: Elm327Adapter = scriptedElm({ silent: false });
  // Override the responder: everything answers, except ATRV stays silent.
  const stream = new MemoryByteStream();
  stream.open();
  stream.responder = (command) => {
    const trimmed = command.replace(/\r$/, "");
    if (trimmed === "ATZ") return "\rELM327 v2.1\r\n>";
    if (trimmed.startsWith("ATRV")) return null;
    if (trimmed.startsWith("AT")) return "OK\r\n>";
    if (trimmed.includes("3E")) return "\r7E8 02 50 03\r\n>";
    return "OK\r\n>";
  };
  const adapter = new Elm327Adapter({ stream, commandTimeoutMs: 60 });
  void silent;
  const report = await runAdapterDoctor(
    { id: "elm327", config: {} },
    { catalog: catalogWith(elmEntry()), createBus: async () => adapter, pingWindowMs: 100 },
  );
  assert.equal(stepStatus(report, "voltage"), "warn");
  assert.match(report.steps.find((s) => s.id === "voltage")?.detail ?? "", /ATRV/);
});

test("doctor: nonsense ATRV is reported as 'no voltage answer', not as 0 volts", async () => {
  const stream = new MemoryByteStream();
  stream.open();
  stream.responder = (command) => {
    const trimmed = command.replace(/\r$/, "");
    if (trimmed === "ATZ") return "\rELM327 v2.1\r\n>";
    if (trimmed.startsWith("ATRV")) return "\r?\r\n>";
    if (trimmed.startsWith("AT")) return "OK\r\n>";
    if (trimmed.includes("3E")) return "\r7E8 02 50 03\r\n>";
    return "OK\r\n>";
  };
  const adapter = new Elm327Adapter({ stream, commandTimeoutMs: 100 });
  const report = await runAdapterDoctor(
    { id: "elm327", config: {} },
    { catalog: catalogWith(elmEntry()), createBus: async () => adapter, pingWindowMs: 50 },
  );
  assert.equal(stepStatus(report, "voltage"), "warn");
  assert.match(
    report.steps.find((s) => s.id === "voltage")?.detail ?? "",
    /keine Spannungsantwort/,
  );
});

test("doctor: a bus whose close throws still reports, with openedAndClosed false", async () => {
  const adapter = scriptedElm();
  const report = await runAdapterDoctor(
    { id: "elm327", config: {} },
    {
      catalog: catalogWith(elmEntry()),
      createBus: async () => {
        const original = adapter.close.bind(adapter);
        adapter.close = async () => {
          await original();
          throw new TransportError("double close on the way out");
        };
        return adapter;
      },
      pingWindowMs: 100,
    },
  );
  assert.equal(report.openedAndClosed, false);
  // The walk finished nevertheless: the ping ran before the failing close.
  assert.equal(stepStatus(report, "ping"), "ok");
});
