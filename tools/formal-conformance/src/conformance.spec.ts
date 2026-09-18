import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { type CliIo, USAGE, parseArgs, runConformanceCli } from "./conformance.js";

const isoVectors = JSON.stringify({
  vectorSet: "spec",
  modelDomain: "spec",
  vectors: [
    {
      name: "rx-ok",
      side: "rx",
      input: [{ in: [1, 65] }],
      expect: {
        delivered: [65],
        sentFrames: [],
        counters: { sequenceErrors: 0, timeouts: 0, retries: 0 },
      },
    },
  ],
});

const safetyVectors = JSON.stringify({
  vectorSet: "spec",
  modelDomain: "spec",
  config: { minBatteryVoltage: 12 },
  vectors: [
    {
      family: "precheck",
      name: "pre-ok",
      context: {
        risk: "low",
        userConfirmed: true,
        backupAvailable: true,
        sessionType: 3,
        definitionVersion: "1.0.0",
      },
      vehicle: { stationary: true, ignitionOn: true, batteryVoltage: 12.5, parkingBrake: null },
      expect: { granted: true },
    },
  ],
});

interface Fake {
  io: CliIo;
  files: Map<string, string>;
  written: Map<string, string>;
  haskellCalls: string[];
}

function fakeIo(overrides: Partial<{ haskell: boolean; hsJson: string }> = {}): Fake {
  const files = new Map<string, string>([
    ["iso.json", isoVectors],
    ["safe.json", safetyVectors],
  ]);
  const written = new Map<string, string>();
  const haskellCalls: string[] = [];
  const io: CliIo = {
    readFile: (path) => {
      const text = files.get(path);
      if (text === undefined) throw new Error(`ENOENT ${path}`);
      return text;
    },
    writeFile: (path, text) => void written.set(path, text),
    hasHaskell: () => overrides.haskell ?? false,
    runHaskell: async (set) => {
      haskellCalls.push(set);
      return (
        overrides.hsJson ??
        '{"name":"rx-ok","result":{"delivered":[65],"error":null,"sentFrames":[],"counters":{"sequenceErrors":0,"timeouts":0,"retries":0}}}\n{"name":"pre-ok","result":{"kind":"precheck","granted":true,"failed":0,"unproven":0}}'
      );
    },
    time: {
      sleep: () => new Promise<void>((resolve) => setImmediate(resolve)),
    },
  };
  return { io, files, written, haskellCalls };
}

const argv = ["--isotp", "iso.json", "--safety", "safe.json"];

describe("conformance CLI (pure core, injected io)", () => {
  test("usage errors exit 2 and unknown arguments are named", async () => {
    const result = await runConformanceCli(["--wat"], fakeIo().io);
    assert.equal(result.exit, 2);
    assert.match(result.report, /unknown argument "--wat"/);
    const help = parseArgs(["--help"]);
    assert.ok("usage" in help);
    assert.equal(help.usage, USAGE);
  });

  test("a missing vector file is exit 2 with the path", async () => {
    const fake = fakeIo();
    fake.files.delete("iso.json");
    const result = await runConformanceCli(argv, fake.io);
    assert.equal(result.exit, 2);
    assert.match(result.report, /cannot read iso\.json/);
  });

  test("an invalid vector file reports its parse errors, not an empty pass", async () => {
    const fake = fakeIo();
    fake.files.set(
      "iso.json",
      JSON.stringify({ vectorSet: "x", modelDomain: "y", vectors: [{ name: "n" }] }),
    );
    const result = await runConformanceCli(argv, fake.io);
    assert.equal(result.exit, 2);
    assert.match(result.report, /invalid vector file/);
    assert.match(result.report, /vectors\[0\]/);
  });

  test("without --compare the report says haskell NOT RUN — silence is never agreement", async () => {
    const result = await runConformanceCli(argv, fakeIo().io);
    assert.equal(result.exit, 0);
    assert.match(result.report, /28 vectors|1 vectors/);
    assert.match(result.report, /haskell NOT RUN/);
  });

  test("--compare without a toolchain refuses (exit 2) instead of pretending", async () => {
    const result = await runConformanceCli([...argv, "--compare"], fakeIo().io);
    assert.equal(result.exit, 2);
    assert.match(result.report, /needs a Haskell toolchain/);
  });

  test("--compare with a clean driver run reports the differential as clean", async () => {
    const fake = fakeIo({ haskell: true });
    const result = await runConformanceCli([...argv, "--compare"], fake.io);
    assert.equal(result.exit, 0, result.report);
    assert.match(result.report, /differential clean/);
    assert.deepEqual(fake.haskellCalls, ["isotp", "safety"]);
  });

  test("--compare with a deviating driver run names the vector, both results and the path", async () => {
    const fake = fakeIo({
      haskell: true,
      hsJson:
        '{"name":"rx-ok","result":{"delivered":[66],"error":null,"sentFrames":[],"counters":{"sequenceErrors":0,"timeouts":0,"retries":0}}}',
    });
    const result = await runConformanceCli([...argv, "--compare"], fake.io);
    assert.equal(result.exit, 1);
    assert.match(result.report, /deviation: rx-ok/);
    assert.match(result.report, /difference:/);
    assert.match(result.report, /delivered\[0\]/);
    assert.match(result.report, /ts:/);
    assert.match(result.report, /haskell:/);
  });

  test("a driver line for a refused vector becomes a named deviation, not a missing pass", async () => {
    const fake = fakeIo({
      haskell: true,
      hsJson: '{"name":"rx-ok","error":"model refused this vector"}',
    });
    const result = await runConformanceCli([...argv, "--compare"], fake.io);
    assert.equal(result.exit, 1);
    assert.match(result.report, /model refused this vector/);
  });

  test("--json writes the combined record set the caller can diff later", async () => {
    const fake = fakeIo({ haskell: true });
    const result = await runConformanceCli([...argv, "--compare", "--json", "out.json"], fake.io);
    assert.equal(result.exit, 0);
    const written = fake.written.get("out.json");
    assert.ok(written);
    const parsed = JSON.parse(written) as { sets: Record<string, { name: string }[]> };
    assert.deepEqual(Object.keys(parsed.sets).sort(), ["iso15765-2", "write-safety"]);
    assert.equal(parsed.sets["iso15765-2"]?.[0]?.name, "rx-ok");
  });
});
