/**
 * Markdown link gate — the prose of this repository is part of the product.
 *
 * Measured 2026-09-24 over the tree: **443 relative links** in 148 markdown
 * files, and **10 of them did not resolve** — six in `.ai/contracts/*.md`
 * (`../docs/…` where `../../docs/…` was meant, because those files sit one
 * directory deeper than the author assumed) and four in
 * `docs/standards/conformance.md` (`0053-…`/`0054-…` where `../adr/` was
 * missing). The `.ai/` context layer is generated *from* the same rule that
 * drives `check:deps` (ADR 0043), so a contract file that points at nothing is
 * an AI agent reading a dead pointer — the exact failure the layer exists to
 * prevent.
 *
 * The gate is the part that keeps the number at zero. Every other gate in this
 * directory proves something about *code*; this one proves something about the
 * documentation, which in a repository whose norm is "the repository wins over
 * the documentation" (AGENTS 34.24) is load-bearing too: a reader who follows a
 * broken link has no way to tell a typo from a decision.
 *
 * Scope, deliberately: relative links only. Absolute URLs are a network call,
 * not a repository fact, and a gate that depends on the network is a gate that
 * fails for reasons the repository did not cause. Anchors into another file
 * (`./x.md#heading`) are checked for the file, not the heading — a heading
 * rename is prose churn, and this gate is about pointers that resolve to
 * *nothing at all*.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "vitest";
import { repoRoot as root } from "./workspace.js";

/** Never reviewed source, and never a document. */
const IGNORED_DIRS = new Set(["node_modules", "dist", "coverage", ".git", ".arena", ".cache"]);

/** One `[text](target)` occurrence, with the line it was found on. */
export interface LinkOccurrence {
  /** 1-based line number — the identifier a reader can act on. */
  line: number;
  /** The link text, for the failure message. */
  text: string;
  /** The raw target as written. */
  target: string;
}

/**
 * Markdown source with fenced code blocks and inline code spans blanked out.
 *
 * Why: a fenced example that *shows* markdown syntax (`SG_ … : 0|16@1+` style
 * documentation lives in this repository) is not a link, and neither is a
 * backticked `` `[a](b)` ``. Blanking keeps the check honest instead of
 * forbidding the repository from documenting its own syntax. Only the link
 * *syntax* is removed; the surrounding prose and its line numbering stay, so a
 * reported line still points at the real place.
 */
export function withoutCode(source: string): string {
  // Fenced blocks first: their content can contain a ``` line only by closing.
  const unfenced = source.replace(
    /^[ \t]*(?:```|~~~)[^\n]*\n[\s\S]*?^[ \t]*(?:```|~~~)[^\n]*$/gm,
    (block) => block.replace(/[^\n]/g, " "),
  );
  // Inline spans: shortest match, non-greedy, no newline inside.
  return unfenced.replace(/`[^`\n]*`/g, (span) => span.replace(/[^\n]/g, " "));
}

/**
 * Every link occurrence whose target is a *relative* path.
 *
 * `http:`/`https:`/`mailto:` and pure `#anchor` targets are skipped here rather
 * than filtered at the call site: the caller asks for "the links this gate can
 * judge", and a target that needs the network is not one of them.
 */
export function relativeLinks(source: string): LinkOccurrence[] {
  const code = withoutCode(source);
  const found: LinkOccurrence[] = [];
  for (const [index, line] of code.split("\n").entries()) {
    for (const match of line.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)) {
      const target = match[2] ?? "";
      if (target === "" || target.startsWith("#")) continue;
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) continue; // scheme: http, mailto, …
      if (target.startsWith("//")) continue; // protocol-relative
      found.push({ line: index + 1, text: match[1] ?? "", target });
    }
  }
  return found;
}

/**
 * Resolve a relative link target against the file that contains it.
 * Returns the absolute path, or `null` when the target does not exist.
 */
export function resolveLink(fromFile: string, target: string): string | null {
  const withoutFragment = target.split("#")[0] ?? "";
  if (withoutFragment === "") return null;
  const absolute = resolve(dirname(fromFile), withoutFragment);
  return existsSync(absolute) ? absolute : null;
}

/** Every markdown file in the repository, as repo-relative POSIX paths, sorted. */
export function markdownFiles(base: string = root): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSyncSorted(dir)) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(absolute);
      } else if (entry.name.endsWith(".md")) {
        found.push(relative(base, absolute).split(sep).join("/"));
      }
    }
  };
  walk(base);
  return found.sort();
}

/** `readdirSync` with a stable order, so a failure message is reproducible. */
function readdirSyncSorted(dir: string): Array<{ name: string; isDirectory: () => boolean }> {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
}

/** The gate: every relative link in every markdown file resolves. */
test("every relative markdown link resolves to a file that exists", () => {
  const files = markdownFiles();
  const broken: string[] = [];
  let checked = 0;

  for (const rel of files) {
    const absolute = join(root, rel);
    const source = readFileSync(absolute, "utf8");
    for (const link of relativeLinks(source)) {
      checked += 1;
      if (resolveLink(absolute, link.target) === null) {
        broken.push(`${rel}:${link.line}  [${link.text}](${link.target})`);
      }
    }
  }

  // A count that is not asserted is a count that can silently become zero.
  assert.ok(
    checked > 300,
    `expected the repository's documentation to carry hundreds of relative links, found ${checked} — ` +
      "if the markdown set really shrank, this floor is the number to update",
  );

  assert.deepEqual(
    broken,
    [],
    `broken relative links (${broken.length} of ${checked}):\n${broken.join("\n")}`,
  );
});

/**
 * The gate bites.
 *
 * Every other test in this directory carries a fixture that proves its rule can
 * fail (ADR 0031 §"a rule that cannot fail is not a rule"). This one is the
 * same argument applied to prose: a checker that never reports anything is
 * indistinguishable from a checker that is never called, and both were true of
 * this repository until 2026-09-24.
 */
test("the link gate reports a broken link instead of passing over it", () => {
  const dir = mkdtempSync(join(tmpdir(), "vdp-link-gate-"));
  try {
    const good = join(dir, "good.md");
    const brokenFile = join(dir, "broken.md");
    writeFileSync(good, "# present\n");
    writeFileSync(brokenFile, "# absent\n\n[gone](./nowhere.md)\n[here](./good.md)\n");

    const links = relativeLinks(readFileSync(brokenFile, "utf8"));
    assert.equal(links.length, 2, "both links must be seen, including the one that resolves");

    assert.equal(resolveLink(brokenFile, "./good.md"), good, "a link that exists must resolve");
    assert.equal(
      resolveLink(brokenFile, "./nowhere.md"),
      null,
      "a link that does not exist must not",
    );

    const reported = links.filter((l) => resolveLink(brokenFile, l.target) === null);
    assert.deepEqual(
      reported.map((l) => `${l.line}:${l.target}`),
      ["3:./nowhere.md"],
      "the failure must name the line and the target, not just count",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Documented syntax is not a link.
 *
 * This repository documents its own markdown, DBC and JSON grammar in fenced
 * blocks (see `tools/definition-importer`, `docs/api/*`). Treating that prose
 * as links would make the gate a reason to stop documenting — the wrong
 * trade. The blanking is tested here so a change to `withoutCode` cannot
 * quietly turn examples into failures.
 */
test("fenced and inline code is not read as a link", () => {
  const source = [
    "Prose with a real [link](./real.md).",
    "",
    "```md",
    "[not a link](./fenced.md)",
    "```",
    "",
    "Inline `[also not](./inline.md)` stays prose.",
  ].join("\n");

  const links = relativeLinks(source);
  assert.deepEqual(
    links.map((l) => l.target),
    ["./real.md"],
    "only the prose link survives; the fence and the inline span are blanked",
  );
});
