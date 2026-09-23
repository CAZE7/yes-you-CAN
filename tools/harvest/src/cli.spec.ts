/**
 * The CLI as a program with a contract (ADR 0058).
 *
 * `runCli` takes argv and returns an exit code instead of calling `process.exit`,
 * so the whole program — including its refusals — is testable in process. What is
 * pinned: the flag grammar (and that a typo is a usage error with a sentence), the
 * `--print-plan` path that touches no bus, the missing-`--out` refusal, the
 * artifacts a successful simulator run writes, and the honest `odxtools NOT RUN`
 * line when no checker is installed.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, test } from "vitest";
import { type CliIo, EXIT, parseCli, parseSession, runCli, usage, writeArtifacts } from "./cli.js";

/** Captures what the CLI says, so a test can assert on the operator's view. */
function capture(): CliIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    write: (line) => out.push(line),
    error: (line) => err.push(line),
  };
}

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vdp-harvest-cli-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("the flag grammar", () => {
  test("every harvest flag is parsed, and adapter flags are passed through untouched", () => {
    const parsed = parseCli([
      "--simulator",
      "--out",
      "/tmp/x",
      "--format",
      "odx,json",
      "--oem",
      "vag",
      "--keep-vin",
      "--no-dtcs",
      "--no-dtc-records",
      "--probe-writes",
      "--verify-odx",
      "--odx-python",
      "/usr/bin/python3",
      "--gap",
      "12",
      "--session",
      "extended",
      "--log-level",
      "DEBUG",
      "--adapter",
      "socketcan",
      "--channel",
      "can0",
    ]);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.options.simulator, true);
    assert.equal(parsed.options.out, "/tmp/x");
    assert.deepEqual(parsed.options.formats, ["odx", "json"]);
    assert.equal(parsed.options.oem, "vag");
    assert.equal(parsed.options.keepVin, true);
    assert.equal(parsed.options.readDtcs, false);
    assert.equal(parsed.options.readDtcRecords, false);
    assert.equal(parsed.options.probeWrites, true);
    assert.equal(parsed.options.verifyOdx, true);
    assert.equal(parsed.options.odxPython, "/usr/bin/python3");
    assert.equal(parsed.options.requestGapMs, 12);
    assert.equal(parsed.options.enterSession, 0x03);
    assert.equal(parsed.options.logLevel, "DEBUG");
    assert.deepEqual(parsed.adapterArgv.slice(0, 2), ["--simulator", "--out"]);
  });

  test("a value may be given with = instead of a second argument", () => {
    const parsed = parseCli(["--out=/tmp/y", "--gap=3", "--session=0x03", "--oem=mercedes"]);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.options.out, "/tmp/y");
    assert.equal(parsed.options.requestGapMs, 3);
    assert.equal(parsed.options.enterSession, 3);
    assert.equal(parsed.options.oem, "mercedes");
  });

  test("an unknown flag and a stray argument are usage errors with a sentence", () => {
    // `--ouut` is unknown, so nothing consumes the following word: both it and the
    // positional argument are reported, and the operator sees all three problems.
    const parsed = parseCli(["--ouut", "/tmp/x", "harvest.json"]);
    assert.equal(parsed.errors.length, 3);
    assert.match(parsed.errors[0] ?? "", /unbekanntes Flag "--ouut"/);
    assert.match(parsed.errors[1] ?? "", /unerwartetes Argument "\/tmp\/x"/);
    assert.match(parsed.errors[2] ?? "", /unerwartetes Argument "harvest\.json"/);
  });

  test("a value that is not a number or not a session is refused, not defaulted", () => {
    assert.match(parseCli(["--gap", "schnell"]).errors[0] ?? "", /--gap braucht eine Zahl/);
    assert.match(parseCli(["--gap", "-5"]).errors[0] ?? "", /--gap braucht eine Zahl/);
    assert.match(
      parseCli(["--session", "turbo"]).errors[0] ?? "",
      /--session braucht einen Sitzungstyp/,
    );
    assert.match(parseCli(["--format", "yaml"]).errors[0] ?? "", /--format kennt "yaml" nicht/);
    assert.match(parseCli(["--out"]).errors[0] ?? "", /--out braucht ein Verzeichnis/);
  });

  test("sessions are accepted in the three forms an operator types", () => {
    assert.equal(parseSession("0x03"), 3);
    assert.equal(parseSession("3"), 3);
    assert.equal(parseSession("extended"), 3);
    assert.equal(parseSession("default"), 1);
    assert.equal(parseSession("programming"), 2);
    assert.equal(parseSession("0x100"), null, "outside one byte");
    assert.equal(parseSession("0"), null, "session type 0 is the unassigned probe, not a session");
    assert.equal(parseSession(undefined), null);
  });
});

describe("the program", () => {
  test("--help prints the usage and touches no bus", async () => {
    const io = capture();
    assert.equal(await runCli(["--help"], io), EXIT.ok);
    assert.match(io.out.join("\n"), /read-only auslesen/);
    assert.match(io.out.join("\n"), /0x14 \(Löschen\), 0x27 \(Security Access\)/);
  });

  test("--print-plan answers what would be asked, without opening anything", async () => {
    const io = capture();
    const code = await runCli(["--print-plan", "--gap", "7"], io);
    assert.equal(code, EXIT.ok);
    const text = io.out.join("\n");
    assert.match(text, /DIDs: \d+/);
    assert.match(text, /Abstand 7 ms/);
    assert.match(text, /Schreib-Unterstützung sondieren: nein/);
    assert.deepEqual(io.err, [], "printing a plan is not an error");
  });

  test("--probe-writes says so in the plan it prints", async () => {
    const io = capture();
    assert.equal(await runCli(["--print-plan", "--probe-writes"], io), EXIT.ok);
    assert.match(io.out.join("\n"), /Schreib-Unterstützung sondieren: ja/);
  });

  test("a missing --out is a usage error before any bus is opened", async () => {
    const io = capture();
    assert.equal(await runCli(["--simulator"], io), EXIT.usage);
    assert.match(io.err.join("\n"), /--out fehlt/);
  });

  test("unknown flags stop the program before it starts", async () => {
    const io = capture();
    assert.equal(await runCli(["--nope", "--out", "/tmp/x"], io), EXIT.usage);
    assert.match(io.err.join("\n"), /unbekanntes Flag/);
  });

  test("a simulator run writes every artifact and reports what it left out", async () => {
    const dir = tempDir();
    const io = capture();
    const code = await runCli(
      [
        "--simulator",
        "--out",
        dir,
        "--gap",
        "0",
        "--oem",
        "harvest-test",
        "--format",
        "all",
        "--log-level",
        "ERROR",
      ],
      io,
    );
    assert.equal(code, EXIT.ok, io.err.join("\n"));
    const written = io.out.filter((line) => line.startsWith("geschrieben:"));
    assert.equal(written.length, 4, written.join("\n"));

    const record = JSON.parse(readFileSync(join(dir, "harvest.json"), "utf8")) as {
      kind: string;
      identity: { vin?: string; vinRedacted?: boolean };
      ecus: unknown[];
    };
    assert.equal(record.kind, "vdp.harvest");
    assert.equal(record.identity.vinRedacted, true, "the VIN is masked unless --keep-vin");
    assert.ok(record.ecus.length > 0);

    const odx = readFileSync(join(dir, "harvest_simulator.odx-d"), "utf8");
    assert.match(odx, /<ODX MODEL-VERSION="2\.2\.0"/);
    assert.match(odx, /SI="provenance">observed</);

    const candidate = JSON.parse(
      readFileSync(join(dir, "harvest-test-definition.json"), "utf8"),
    ) as {
      provenance: { sourceType: string };
      ecus: unknown[];
    };
    assert.equal(candidate.provenance.sourceType, "observed");
    assert.ok(candidate.ecus.length > 0);

    assert.ok(existsSync(join(dir, "harvest_simulator.pdx")), "the PDX container is written");
    assert.match(io.out.join("\n"), /Definitions-Kandidat: \d+ ECU/);
  }, 60_000);

  test("--format json writes only the record", async () => {
    const dir = tempDir();
    const io = capture();
    const code = await runCli(
      ["--simulator", "--out", dir, "--gap", "0", "--format", "json", "--log-level", "ERROR"],
      io,
    );
    assert.equal(code, EXIT.ok, io.err.join("\n"));
    assert.equal(io.out.filter((line) => line.startsWith("geschrieben:")).length, 1);
    assert.ok(existsSync(join(dir, "harvest.json")));
  }, 60_000);

  test("--keep-vin is the only way the clear text reaches the file", async () => {
    const dir = tempDir();
    const io = capture();
    const code = await runCli(
      [
        "--simulator",
        "--out",
        dir,
        "--gap",
        "0",
        "--keep-vin",
        "--format",
        "json",
        "--log-level",
        "ERROR",
      ],
      io,
    );
    assert.equal(code, EXIT.ok, io.err.join("\n"));
    const record = JSON.parse(readFileSync(join(dir, "harvest.json"), "utf8")) as {
      identity: { vin?: string; vinRedacted?: boolean };
    };
    assert.equal(record.identity.vinRedacted, undefined);
    assert.match(record.identity.vin ?? "", /^[A-HJ-NPR-Z0-9]{17}$/);
  }, 60_000);

  test("--verify-odx without a checker reports NOT RUN and stays green", async () => {
    const dir = tempDir();
    const io = capture();
    const code = await runCli(
      [
        "--simulator",
        "--out",
        dir,
        "--gap",
        "0",
        "--verify-odx",
        "--odx-python",
        "/nonexistent/python-vdp",
        "--format",
        "odx",
        "--log-level",
        "ERROR",
      ],
      io,
    );
    assert.equal(code, EXIT.ok, "a check that cannot run has not failed");
    assert.match(io.out.join("\n"), /odxtools NOT RUN/);
    assert.match(io.out.join("\n"), /optionaler externer Prüfer/);
  }, 60_000);

  test("an adapter that this host does not have is a clear refusal, not a crash", async () => {
    const dir = tempDir();
    const io = capture();
    const code = await runCli(
      ["--adapter", "elm327", "--device", "/dev/does-not-exist-vdp", "--out", dir, "--gap", "0"],
      io,
    );
    assert.equal(code, EXIT.noBus);
    assert.match(io.err.join("\n"), /nicht verfügbar|konnte nicht geöffnet werden|device/i);
  }, 60_000);
});

describe("writing artifacts", () => {
  test("a directory that cannot be created is reported, not thrown", () => {
    const io = capture();
    const written = writeArtifacts(
      minimalReport(),
      join(tempDir(), "\u0000-not-a-path"),
      ["json"],
      { argv: [] },
      io,
    );
    assert.deepEqual(written, []);
    assert.match(io.err.join("\n"), /Ausgabeverzeichnis|harvest\.json/);
  });
});

function minimalReport() {
  return {
    kind: "vdp.harvest" as const,
    version: 1,
    identity: { source: "spec:cli", platformVersion: "0.1.0" },
    bus: { addressing: "11-bit" as const, functionalId: 0x7df },
    startedAt: "2026-09-23T10:00:00.000Z",
    finishedAt: "2026-09-23T10:00:01.000Z",
    durationMs: 1_000,
    plan: {
      services: [0x22],
      sessions: [0x01],
      didRanges: [],
      standardDids: [],
      dtcRecordNumbers: [],
      budgetPerEcuMs: 1_000,
      requestGapMs: 0,
    },
    ecus: [],
    unread: [],
    counts: {
      ecusAnswered: 0,
      addressesUnread: 0,
      didsRead: 0,
      didsRefused: 0,
      dtcsFound: 0,
      snapshotsRead: 0,
      requestsSent: 0,
    },
    notes: [],
  };
}

test("the usage text names every flag the parser knows", () => {
  const text = usage();
  for (const flag of [
    "--out",
    "--format",
    "--simulator",
    "--oem",
    "--definitions",
    "--print-plan",
    "--keep-vin",
    "--no-dtcs",
    "--no-dtc-records",
    "--probe-writes",
    "--session",
    "--gap",
    "--verify-odx",
    "--odx-python",
    "--log-level",
  ]) {
    assert.ok(text.includes(flag), `the help must document ${flag}`);
  }
});
