#!/usr/bin/env node
/**
 * Documentation link gate (T9).
 *
 * Scans every Markdown file in the repository, follows relative links and
 * image references, and fails the process if any are broken. Markdown inside
 * fenced code blocks and inline code spans is ignored, so this script does not
 * trip on example links like `](docs/example.md)` shown in documentation.
 *
 * The check is deliberately small: no dependencies, no AST library, no
 * config files. It exists to make the rule "no broken doc links merge"
 * mechanically enforceable, so reviewers can stop scanning by hand.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const root = resolve(process.cwd());

/** Recursive walk that yields absolute paths. */
function* walk(dir) {
  const entries = readdirSync(dir);
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

/** Skip directories that never ship with a PR. */
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage", "sessions-local", ".ai"]);

/** Patterns recognised as Markdown links. The first capture is the target. */
const LINK_PATTERN = /\[(?:\[[^\]]*\]|[^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const IMAGE_PATTERN = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** Strip code regions so example links in ``` blocks do not count. */
function stripCodeRegions(source) {
  return source.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
}

/** A link target that we will (or will not) try to resolve. */
function classifyTarget(target) {
  if (!target) return "skip";
  if (target.startsWith("http://") || target.startsWith("https://")) {
    return "external";
  }
  if (target.startsWith("#")) return "anchor";
  if (target.startsWith("mailto:")) return "external";
  if (target.startsWith("/")) return "absolute";
  return "relative";
}

/** Strip query and fragment from a path-like link target. */
function cleanPath(target) {
  const hashIndex = target.indexOf("#");
  const queryIndex = target.indexOf("?");
  let end = target.length;
  if (hashIndex >= 0) end = Math.min(end, hashIndex);
  if (queryIndex >= 0) end = Math.min(end, queryIndex);
  return target.slice(0, end);
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function resolveTarget(fromFile, target) {
  const pathPart = cleanPath(target);
  if (!pathPart) return null;
  const fromDir = dirname(fromFile);
  if (pathPart.startsWith("/")) {
    return resolve(root, "." + pathPart);
  }
  return resolve(fromDir, pathPart);
}

function targetExists(absPath) {
  if (!absPath) return false;
  if (existsSync(absPath)) return true;
  // Try adding a Markdown extension; many doc links omit it.
  if (existsSync(absPath + ".md")) return true;
  // Directory + README.md is the convention for index-style links.
  if (isDirectory(absPath) && existsSync(join(absPath, "README.md"))) {
    return true;
  }
  return false;
}

function shouldSkipDir(name) {
  return SKIP_DIRS.has(name) || name.startsWith(".");
}

/** Filter the directory walk to Markdown files outside skip paths. */
function* findMarkdownFiles(dir) {
  for (const path of walk(dir)) {
    const rel = relative(root, path).split(sep);
    if (rel.some((part) => shouldSkipDir(part))) continue;
    if (path.endsWith(".md")) yield path;
  }
}

function checkFile(absPath) {
  const source = readFileSync(absPath, "utf8");
  const visible = stripCodeRegions(source);
  const broken = [];

  for (const pattern of [LINK_PATTERN, IMAGE_PATTERN]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(visible);
    while (match !== null) {
      const target = match[1];
      const kind = classifyTarget(target);
      if (kind === "external" || kind === "anchor" || kind === "skip") {
        match = pattern.exec(visible);
        continue;
      }
      const resolved = resolveTarget(absPath, target);
      if (!targetExists(resolved)) {
        broken.push({ target, line: lineOf(source, match.index) });
      }
      match = pattern.exec(visible);
    }
  }
  return broken;
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function main() {
  let totalChecked = 0;
  let totalBroken = 0;
  const offenders = [];

  for (const file of findMarkdownFiles(root)) {
    totalChecked++;
    const broken = checkFile(file);
    if (broken.length > 0) {
      totalBroken += broken.length;
      offenders.push({ file, broken });
    }
  }

  const summary = {
    files: totalChecked,
    broken: totalBroken,
  };

  if (totalBroken > 0) {
    for (const { file, broken } of offenders) {
      for (const { target, line } of broken) {
        process.stderr.write(`BROKEN ${relative(root, file)}:${line} → ${target}\n`);
      }
    }
    process.stderr.write(`\n${summary.files} Markdown files, ${summary.broken} broken link(s)\n`);
    process.exit(1);
  }

  process.stderr.write(`\n${summary.files} Markdown files, 0 broken links\n`);
}

main();
