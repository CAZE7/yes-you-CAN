import assert from "node:assert/strict";
import { AdapterCatalog, type AdapterDoctorReport, type AdapterEntry } from "@vdp/adapter-host";
import { test } from "vitest";
import { DOCTOR_EXIT, formatDoctorReport, runDoctorCli } from "../src/doctor-cli.js";

const entry: AdapterEntry = {
  id: "simulator",
  displayName: "Simulator",
  kind: "simulator",
  transport: "can",
  description: "test",
  capabilities: {
    can: true,
    canFd: false,
    doip: false,
    isoTpOffload: false,
    channels: 1,
  },
  requires: {},
  managedBy: "application",
  probe: async () => ({ available: true, detail: "immer verfügbar" }),
  create: async () => {
    throw new Error("managed");
  },
};

function report(verdict: AdapterDoctorReport["verdict"], failing?: string): AdapterDoctorReport {
  return {
    adapterId: "simulator",
    selection: { id: "simulator", config: {} },
    steps: [
      { id: "settings", label: "Einstellungen", status: "ok", detail: "gültig" },
      {
        id: "probe",
        label: "Verfügbarkeit",
        status: failing === "probe" ? "fail" : "ok",
        detail: "probe-detail",
        hints: ["hint-a", "hint-b"],
      },
      {
        id: "open",
        label: "Adapter öffnen",
        status: failing === "open" ? "fail" : "ok",
        detail: failing === "open" ? "timed out" : "geöffnet",
        hints: failing === "open" ? ["Baudrate prüfen"] : [],
      },
    ],
    verdict,
    openedAndClosed: verdict !== "needs-attention",
  };
}

test("the report format carries icons, hints and the verdict line", () => {
  const text = formatDoctorReport(report("needs-attention", "open"));
  assert.match(text, /Adapter-Doctor: simulator/);
  assert.match(text, /✓ Einstellungen: gültig/);
  assert.match(text, /✓ Verfügbarkeit: probe-detail/);
  assert.match(text, /× |✗ Adapter öffnen: timed out/);
  assert.match(text, /→ Baudrate prüfen/);
  assert.match(text, /Aufmerksamkeit nötig/);
});

test("runDoctorCli exits 0/2/3 with the report in between", async () => {
  const catalog = new AdapterCatalog([entry]);

  const ready = await runDoctorCli(["--doctor", "--adapter", "simulator"], {
    catalog,
    runDoctor: async () => report("ready"),
    write: () => undefined,
  });
  assert.equal(ready, DOCTOR_EXIT.ready);

  const captured: string[] = [];
  const attention = await runDoctorCli([], {
    catalog,
    runDoctor: async () => report("needs-attention", "open"),
    write: (text) => captured.push(text),
  });
  assert.equal(attention, DOCTOR_EXIT.attention);
  assert.match(captured.join(""), /timed out/, "the wiring problem text reached the console");

  const blocked = await runDoctorCli([], {
    catalog,
    runDoctor: async () => report("blocked", "probe"),
    write: () => undefined,
  });
  assert.equal(blocked, DOCTOR_EXIT.usage);

  const usage = await runDoctorCli(["--doctor", "--bad-flag-value"], {
    catalog,
    runDoctor: async () => report("ready"),
    write: () => undefined,
  });
  assert.equal(usage, DOCTOR_EXIT.ready, "unknown non-adapter flags are not the doctor's problem");

  const malformed = await runDoctorCli(["--doctor", "--baud=abc"], {
    catalog,
    runDoctor: async () => report("ready"),
    write: () => undefined,
  });
  assert.equal(malformed, DOCTOR_EXIT.usage, "a malformed adapter flag is a usage error");
});
