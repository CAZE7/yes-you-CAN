/**
 * Documentation is a gate, not a habit (ADR 0059; AGENTS 34.24).
 *
 * Two defects this file exists for, and both are invisible until somebody clicks:
 *
 * 1. **A dead link.** The repo links across 120+ markdown files (docs, ADRs, package
 *    READMEs) and nothing ever opened them. Measured 2026-09-23: the check found two
 *    broken links in `docs/standards/conformance.md` — ADR links written without the
 *    `../adr/` prefix, which GitHub renders as a 404 and a reader reads as "the ADR was
 *    never written". A relative link that does not resolve is a documentation defect like
 *    an unbuildable test: it fails silently for the author, loudly for the reader.
 * 2. **A seam without a page.** Every contract names the document that describes it
 *    (`docs` in `architecture/architecture.yaml`). The point of the contract record is
 *    that somebody *outside* this repo can build against the surface — and they cannot
 *    read our source to find out what the surface means.
 *
 * The link check is deliberately part of the architecture suite instead of a markdown
 * linter: no new dependency (ADR 0002/0010), and it runs in `npm run test` where the other
 * gates live. It checks files *and* anchors — an anchor is where documentation drift
 * hides, because the file still exists while the sentence it pointed at is gone.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "vitest";
import { repoRoot as root } from "./workspace.js";

/* ------------------------------------------------------- the check and its rules */

/** Directories no link check should walk into. */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  "sessions-local",
  "harvest-local",
  ".git",
  ".ai",
]);

/** A fenced code block: its content is an example, not a promise. */
function withoutCodeBlocks(text: string): string {
  return text.replace(/^```[\s\S]*?^```/gm, "");
}

/** GitHub's heading slug, close enough for the anchors this repo writes. */
export function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

function markdownFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".") && entry.name !== ".github") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) markdownFiles(full, found);
    else if (entry.name.endsWith(".md")) found.push(full);
  }
  return found;
}

export interface LinkProblem {
  file: string;
  target: string;
  reason: "missing file" | "missing anchor";
}

/**
 * Every relative markdown link in `root`, resolved. Anchors are checked against the
 * headings of the target file (a link to a sentence that moved is broken in the way that
 * matters). `http(s)`, `mailto:` and bare fragments pointing at themselves are out of
 * scope — this is about links inside the repository.
 */
export function linkProblems(base: string): LinkProblem[] {
  const problems: LinkProblem[] = [];
  for (const file of markdownFiles(base)) {
    const text = withoutCodeBlocks(readFileSync(file, "utf8"));
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1] ?? "";
      if (/^(https?:|mailto:|#!|#?$)/.test(target)) continue;
      const [pathPart = "", anchor] = target.split("#");
      const resolved = pathPart === "" ? file : join(dirname(file), pathPart);
      if (pathPart !== "" && !existsSync(resolved)) {
        problems.push({ file: relative(base, file), target, reason: "missing file" });
        continue;
      }
      if (
        anchor !== undefined &&
        anchor !== "" &&
        resolved.endsWith(".md") &&
        existsSync(resolved)
      ) {
        const headings = withoutCodeBlocks(readFileSync(resolved, "utf8"))
          .split("\n")
          .filter((line) => /^#{1,6}\s+/.test(line))
          .map((line) => slug(line.replace(/^#{1,6}\s+/, "")));
        if (!headings.includes(slug(anchor))) {
          problems.push({ file: relative(base, file), target, reason: "missing anchor" });
        }
      }
    }
  }
  return problems;
}

function summarise(problems: LinkProblem[]): string {
  return problems
    .map((problem) => `${problem.file} → ${problem.target} (${problem.reason})`)
    .join("\n");
}

/* ------------------------------------------------------------------------- the tree */

test("no relative link in this repository is dead", () => {
  const problems = linkProblems(root);
  assert.deepEqual(
    problems,
    [],
    `a link that does not resolve is a documentation defect (AGENTS 34.24):\n${summarise(problems)}`,
  );
});

test("the link check bites — a dead link and a moved anchor are both found", () => {
  const base = mkdtempSync(join(tmpdir(), "vdp-links-"));
  try {
    mkdirSync(join(base, "docs"), { recursive: true });
    writeFileSync(
      join(base, "docs/target.md"),
      "# Ein Kapitel\n\nText.\n\n## Zweites Kapitel\n\nMehr Text.\n",
    );
    writeFileSync(
      join(base, "docs/index.md"),
      [
        "# Index",
        "",
        "- [Datei fehlt](missing.md)",
        "- [Anker verschoben](target.md#drittes-kapitel)",
        "- [Alles gut](target.md#zweites-kapitel)",
        "- [Auch gut](#index)",
        "- [Extern](https://example.com/egal)",
        "```md",
        "- [Im Beispielcode](auch-fehlt.md)",
        "```",
      ].join("\n"),
    );
    const problems = linkProblems(base).map(
      (problem) => `${relative(base, join(base, problem.file))}:${problem.reason}`,
    );
    assert.deepEqual(
      problems.sort(),
      ["docs/index.md:missing anchor", "docs/index.md:missing file"],
      "exactly the two defects — a good anchor, an own anchor, an external URL and a code sample must not be reported",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the ADR register lists every ADR, and each listed one exists", () => {
  const register = readFileSync(join(root, "docs/adr/README.md"), "utf8");
  const listed = new Set(
    [...register.matchAll(/\((\d{4}-[a-z0-9-]+\.md)\)/g)].map((match) => match[1] ?? ""),
  );
  const present = readdirSync(join(root, "docs/adr")).filter((name) => /^\d{4}-.*\.md$/.test(name));
  const missingFromRegister = present.filter((name) => !listed.has(name));
  const listedButAbsent = [...listed].filter((name) => !present.includes(name));
  assert.deepEqual(
    { missingFromRegister, listedButAbsent },
    { missingFromRegister: [], listedButAbsent: [] },
    "an ADR that is not in the register is an ADR nobody finds; a register entry without a file is worse",
  );
});

/* ----------------------------------------------------------------- the seam pages */

interface ContractEntry {
  why?: string;
  entry?: string;
  docs?: string;
}

const yaml = JSON.parse(readFileSync(join(root, "architecture/architecture.yaml"), "utf8")) as {
  contracts?: Record<string, ContractEntry>;
};
const contracts = yaml.contracts ?? {};

test("every contract names the document that describes it, and that file is there", () => {
  assert.ok(Object.keys(contracts).length > 0, "the fixture would be vacuous without contracts");
  const problems: string[] = [];
  for (const [name, contract] of Object.entries(contracts)) {
    const docs = contract.docs;
    if (docs === undefined || docs.trim() === "") {
      problems.push(`${name} has no "docs" — a surface somebody else builds against needs a page`);
      continue;
    }
    if (!docs.startsWith("docs/") || docs.startsWith("/") || docs.includes("..")) {
      problems.push(`${name}.docs must be a repository-relative path below docs/, found "${docs}"`);
      continue;
    }
    if (!docs.endsWith(".md")) {
      problems.push(`${name}.docs must name a markdown file, found "${docs}"`);
      continue;
    }
    const file = join(root, docs);
    if (!existsSync(file)) {
      problems.push(`${name}.docs names ${docs}, which does not exist`);
      continue;
    }
    // The page has to be *about this contract*: the href alone would let a seam point at
    // any page that happens to exist.
    const text = readFileSync(file, "utf8");
    if (!text.includes(name)) {
      problems.push(`${name}.docs (${docs}) never names ${name} — that is not a seam page`);
    }
  }
  assert.deepEqual(problems, [], `the seam documentation is incomplete:\n${problems.join("\n")}`);
});

test("every seam page is reachable from the boundary flow", () => {
  const flowFile = "docs/flows/open-core-boundary.md";
  const flow = readFileSync(join(root, flowFile), "utf8");
  const hrefs = new Set(
    [...flow.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)].map((match) => match[1] ?? ""),
  );
  for (const [name, contract] of Object.entries(contracts)) {
    const docs = contract.docs ?? "";
    // The flow has to *link* the page, and the link has to be the one a reader can click:
    // the relative href from the flow's own directory.
    const expected = relative(dirname(join(root, flowFile)), join(root, docs))
      .split("\\")
      .join("/");
    assert.ok(
      hrefs.has(expected),
      `${flowFile} must link \`${expected}\` (${name}) — the boundary is one story, not seven pages nobody connects`,
    );
  }
});
