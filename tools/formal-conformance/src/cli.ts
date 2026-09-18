/**
 * The real `io` for the conformance CLI (ADR 0045) — the only file in this
 * package that touches the filesystem and the process table, mirroring the
 * `tools/golden-sessions/src/cli.ts` pattern: the *logic* is pure in
 * `conformance.ts`, this wiring is exercised by running it for real.
 *
 * `npm run formal:conform` executes this file from `dist/` (after `npm run
 * build`); with `--compare` it additionally runs `formal/ConformanceDriver.hs`
 * through `runghc`/`runhaskell` if present, else compiles it with `ghc` into a
 * temporary binary. No toolchain: the CLI exits 2 for `--compare` and never
 * reports a not-run comparison as agreement.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type CliIo, runConformanceCli } from "./conformance.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Repo root: dist/src → dist → package dir → tools → root. */
const ROOT = resolve(HERE, "..", "..", "..", "..");

const RUNNERS = ["runghc", "runhaskell", "ghc"] as const;
type Runner = (typeof RUNNERS)[number];

function which(runner: Runner): string | null {
  const probe = spawnSync("sh", ["-c", `command -v ${runner}`], { encoding: "utf8" });
  return probe.status === 0 ? (probe.stdout ?? "").trim() || null : null;
}

function findRunner(): Runner | null {
  for (const runner of RUNNERS) {
    if (which(runner) !== null) return runner;
  }
  return null;
}

function absolute(path: string): string {
  return isAbsolute(path) ? path : resolve(ROOT, path);
}

function runSync(command: string, args: readonly string[]): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    cwd: ROOT,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail =
      (result.stderr ?? "").trim() || (result.stdout ?? "").trim() || `exit ${result.status}`;
    throw new Error(`${command} ${args[0] ?? ""}… failed: ${detail.slice(0, 400)}`);
  }
  return result.stdout ?? "";
}

/** `runghc` interprets; `ghc` compiles into a temp binary and runs that. */
export function runHaskellDriver(runner: Runner, set: string, vectorsPath: string): string {
  const formal = join(ROOT, "formal");
  const driver = join(formal, "ConformanceDriver.hs");
  if (runner === "ghc") {
    const binary = join(tmpdir(), `vdp-conformance-driver-${process.pid}`);
    try {
      runSync("ghc", ["-v0", "-i" + formal, "-outputdir", tmpdir(), "-o", binary, driver]);
      return runSync(binary, [set, vectorsPath]);
    } finally {
      rmSync(binary, { force: true });
    }
  }
  return runSync(runner, ["-i" + formal, driver, set, vectorsPath]);
}

export function createRealIo(): CliIo {
  let runner: Runner | null | undefined;
  return {
    readFile: (path) => readFileSync(absolute(path), "utf8"),
    writeFile: (path, text) => writeFileSync(absolute(path), text, "utf8"),
    hasHaskell: () => {
      if (runner === undefined) runner = findRunner();
      return runner !== null;
    },
    runHaskell: async (set, vectorsPath) => {
      if (runner === undefined) runner = findRunner();
      if (runner === null) throw new Error("no Haskell toolchain — the comparison cannot run");
      return runHaskellDriver(runner, set, absolute(vectorsPath));
    },
    time: {
      sleep: (ms) => (ms > 0 ? new Promise<void>((res) => setTimeout(res, ms)) : Promise.resolve()),
    },
  };
}

async function main(): Promise<number> {
  const result = await runConformanceCli(process.argv.slice(2), createRealIo());
  process.stdout.write(result.report + "\n");
  return result.exit;
}

const exitCode = await main();
process.exit(exitCode);
