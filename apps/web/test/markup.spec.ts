/**
 * The page and its scripts have to agree about the element ids (AGENTS 16, 34.21).
 *
 * Why this is a test and not a hope: `apps/web/public/*.js` has no DOM and no runner — its
 * safety net is `tsconfig.frontend.json` (types against the wire contract) and this file.
 * The strict helpers (`must`, `select`, `button`, `input`) throw `TypeError` at *runtime*
 * when a selector has no element, so a renamed host in `index.html` breaks a panel in the
 * browser and nothing else notices. A panel that throws on boot also swallows the modules
 * that boot after it, so the failure is bigger than the card that changed.
 *
 * The rule is deliberately narrower than "every selector in the front end": `$()` is the
 * lenient lookup, and the modules are reusable on pages without every panel (that is what
 * its JSDoc says). Only the strict helpers are pinned, and only against `index.html`,
 * because that is the one page the repository ships and serves.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "vitest";

const PUBLIC_DIR = join(import.meta.dirname, "..", "public");
const MARKUP = readFileSync(join(PUBLIC_DIR, "index.html"), "utf8");

/** Helpers that throw when the element is missing, and the selectors they take first. */
const STRICT_HELPERS = ["must", "select", "button", "input"] as const;

/** Ids `index.html` actually contains. */
const idsInMarkup = new Set<string>(
  [...MARKUP.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1] ?? ""),
);

/**
 * `#id` selectors handed to a strict helper anywhere in `public/*.js`.
 *
 * One regex per helper, matching the call as written (`must("#x")`, `select("#picker")`);
 * a dynamic selector would not be matched, and none is used — the workbench looks its hosts
 * up by literal, which is what makes this check possible at all.
 *
 * @returns {Map<string, string[]>} selector → files that require it
 */
function strictSelectors(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of readdirSync(PUBLIC_DIR)
    .filter((name) => name.endsWith(".js"))
    .sort()) {
    const source = readFileSync(join(PUBLIC_DIR, file), "utf8");
    for (const helper of STRICT_HELPERS) {
      const call = new RegExp(`\\b${helper}\\(\\s*"(#[A-Za-z0-9_-]+)"`, "g");
      for (const match of source.matchAll(call)) {
        const selector = match[1];
        if (selector === undefined) continue;
        const users = found.get(selector) ?? [];
        users.push(file);
        found.set(selector, users);
      }
    }
  }
  return found;
}

describe("the workbench markup and its scripts", () => {
  test("every host a script requires exists in the page", () => {
    const required = strictSelectors();
    assert.ok(required.size > 20, `the scan found ${required.size} selectors — too few to be real`);
    const missing = [...required.entries()]
      .filter(([selector]) => !idsInMarkup.has(selector.slice(1)))
      .map(([selector, files]) => `${selector} (gebraucht von ${[...new Set(files)].join(", ")})`)
      .sort();
    assert.deepEqual(missing, [], `index.html hat diese Hosts nicht:\n${missing.join("\n")}`);
  });

  test("the scenario panel is reachable, not only renderable", () => {
    // E21 was exactly this: the panel's data existed and nothing on the page used it. A
    // tab button and a section are the whole difference between an endpoint and a workbench.
    assert.match(MARKUP, /data-view="scenarios"/, 'the tab "Szenarien" is missing');
    assert.match(MARKUP, /id="view-scenarios"/, "the section is missing");
    for (const id of [
      "scenario-picker",
      "btn-scenario-run",
      "btn-scenario-refresh",
      "scenario-verdict",
      "scenario-checks",
      "scenario-memory-rows",
      "scenario-model-rows",
      "scenario-memory-note",
      "scenario-timeline",
    ]) {
      assert.ok(idsInMarkup.has(id), `#${id} — the panel cannot render without its host`);
    }
  });
});
