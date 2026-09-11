/**
 * Static asset path containment (ADR 0009, AGENTS 27).
 *
 * The workbench serves files from two roots: the front end directory and the
 * compiled chart core under `/lib/`. Both must stay inside their root, and the
 * naive check for that — `resolved.startsWith(root)` — is wrong, because it
 * compares *characters* instead of path segments:
 *
 *   root      = /srv/app/public
 *   resolved  = /srv/app/public-internal/keys.json   ← starts with "/srv/app/public"
 *
 * One hop up and back into any sibling whose name merely *begins with* the root
 * name passes that test, which is exactly the escape the check exists to prevent.
 * Comparing whole segments closes the gap; `resolve` normalises `..` and any
 * remaining separator variance first, so the comparison is made on canonical
 * absolute paths on both sides.
 */

import { isAbsolute, resolve, sep } from "node:path";

/**
 * True when `candidate` is `root` itself or one of its descendants.
 *
 * Symlinks are not followed here — that is the deployment's job (serve only
 * files that were built by the build step, never a user-writable directory).
 */
export function isInsideDirectory(root: string, candidate: string): boolean {
  const base = resolve(root);
  const target = resolve(candidate);
  if (target === base) return true;
  return target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

/**
 * Resolve a request-relative path under `rootDir`, or `null` when the request
 * tries to leave it.
 *
 * `relative` comes straight off the URL path, so it is rejected before any file
 * system call: an absolute path would silently ignore the root (`resolve`
 * honours the last absolute argument), and a NUL byte truncates paths in the
 * underlying syscalls.
 */
export function resolveContained(rootDir: string, relative: string): string | null {
  if (
    relative.length === 0 ||
    relative.includes("\0") ||
    isAbsolute(relative) ||
    relative.startsWith("/")
  )
    return null;
  // `resolve` folds `..` segments away; what is left has to be inside the root.
  const candidate = resolve(resolve(rootDir), relative);
  return isInsideDirectory(rootDir, candidate) ? candidate : null;
}
