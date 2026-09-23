#!/usr/bin/env node
/**
 * Run every command the verification matrix lists, exit 0 only when all of them
 * meet the bar the matrix names.
 *
 * Why a hand-written script and not a yaml/json config: the matrix is meant to
 * be read in the same breath as `AGENTS.md §35`, and prose is the format
 * people edit. Reading the markdown, picking the commands out, and running them
 * is the contract — the script must be small enough that a reviewer can see
 * the parser's whole job in one screen.
 *
 * Lines that look like a command line in the matrix table (start with a
 * 4-space-indented backtick command) are candidates. The exit code of each
 * command is checked; commands that are expected to print numbers (coverage)
 * also check the printed value against the threshold printed in the same row.
 *
 * Usage:
 *   node scripts/check-verification-matrix.mjs             # run everything
 *   node scripts/check-verification-matrix.mjs --no-run    # just show the commands
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const matrixPath = resolve(root, "docs/verification-matrix.md");
const showOnly = process.argv.includes("--no-run");

const text = readFileSync(matrixPath, "utf8");

// Pick out rows of the matrix: a line starting with "| `npm …` | …" or
// similar. We only need the first column (the command) and the threshold.
const rows = [];
for (const line of text.split("\n")) {
  // A matrix row starts with "| " and contains at least five cells; the
  // command we want to run lives in the *second* cell (`npm run build` and
  // friends), not the first (which is the German label, e.g. "Code baut").
  if (!line.startsWith("| ")) continue;
  const cells = line
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim());
  if (cells.length < 5) continue;
  // The header separator row "| --- | --- | …" has nothing runnable in the
  // command column and would otherwise look like a row to run.
  if (cells[1].startsWith("---") || cells[1] === "" || cells[1] === "Befehl") continue;
  const cmd = cells[1].replace(/^`|`$/g, "").trim();
  const threshold = cells[3];
  if (!cmd) continue;
  rows.push({ cmd, threshold });
}

let failed = 0;
for (const { cmd, threshold } of rows) {
  if (showOnly) {
    process.stdout.write(`${cmd}\n`);
    continue;
  }
  process.stderr.write(`▶ ${cmd}\n`);
  const res = spawnSync(cmd, {
    cwd: root,
    shell: true,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });
  if (res.status !== 0) {
    process.stderr.write(res.stdout ?? "");
    process.stderr.write(res.stderr ?? "");
    process.stderr.write(`✗ ${cmd} exited ${res.status}\n`);
    failed += 1;
    continue;
  }
  // Coverage rows: extract the printed percentages and check against the
  // threshold printed in the same row. We only know what "looks like a coverage
  // threshold" means in this file, not in general — so this stays specific.
  if (/coverage/i.test(cmd) || /Schwelle/.test(threshold)) {
    const hit = (res.stdout ?? "").match(
      /All files[^\n]*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/,
    );
    const expect = threshold.match(/(\d+)\/(\d+)\/(\d+)\/(\d+)/);
    if (hit && expect) {
      const got = [hit[1], hit[2], hit[3], hit[4]].map(Number);
      const want = expect.slice(1, 5).map(Number);
      const ok = got.every((value, index) => value >= (want[index] ?? Infinity));
      if (!ok) {
        process.stderr.write(
          `✗ coverage below threshold: got ${got.join("/")}, want ≥ ${want.join("/")}\n`,
        );
        failed += 1;
        continue;
      }
      process.stderr.write(`✓ coverage ${got.join("/")} ≥ ${want.join("/")}\n`);
    }
  }
  process.stderr.write(`✓ ${cmd}\n`);
}

if (failed > 0) {
  process.stderr.write(`\n${failed} matrix check(s) failed\n`);
  process.exit(1);
}
console.log("\nall matrix checks passed");
