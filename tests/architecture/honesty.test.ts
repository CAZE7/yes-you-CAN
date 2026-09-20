/**
 * Honesty gates — claims in the tree that must stay true as text.
 *
 * A README that says "NOT RUN" while a test reports green is the class of lie
 * this file exists to catch (AGENTS 34.21, ADR 0045). The production code is
 * not the subject: the *record* is.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { repoRoot as root } from "./workspace.js";

test("the Haskell differential is documented as NOT RUN, never as green", () => {
  const readme = readFileSync(join(root, "formal/README.md"), "utf8");
  assert.match(
    readme,
    /haskell NOT RUN/,
    "formal/README.md must keep the literal 'haskell NOT RUN' — a comparison that did not run is never a pass (ADR 0045)",
  );
  assert.match(
    readme,
    /nicht geführter Vergleich ist nie ein grüner|not a green/,
    "the release rule has to say a skipped comparison is not a pass",
  );
});

test("DoIP TLS port 3496 stays announced-not-implemented", () => {
  const transport = readFileSync(join(root, "packages/transport/doip/src/transport.ts"), "utf8");
  assert.match(
    transport,
    /TLS variant 3496 is announced, not implemented/,
    "the DoIP transport must not claim to speak TLS on 3496 while it only checks a socket flag",
  );
  const message = readFileSync(join(root, "packages/transport/doip/src/message.ts"), "utf8");
  assert.match(message, /DOIP_TLS_PORT = 3496/, "the constant the spec names has to stay 3496");
});

test("npm run ci includes the audit gate, and the coverage floors only move up", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.match(
    manifest.scripts?.ci ?? "",
    /npm run audit\b/,
    "npm run ci must run npm audit — a lockfile with a moderate vuln is a red gate, not a footnote (ADR 0016)",
  );
  assert.match(
    manifest.scripts?.audit ?? "",
    /npm audit --audit-level=moderate/,
    "the audit script is the moderate-or-worse gate, not a bare npm audit that warns and exits 0",
  );

  const vitest = readFileSync(join(root, "vitest.config.ts"), "utf8");
  assert.match(
    vitest,
    /FROZEN FLOOR \(ADR 0017\): 76\/72 only moves up/,
    "the web coverage floor is a ratchet: the comment that says so has to stay next to the numbers",
  );
  assert.match(
    vitest,
    /'apps\/web\/src\/\*\*': \{ lines: 76, branches: 72, perFile: true \}/,
    "76/72 is the floor; lowering it is a review defect, not a config tweak",
  );
});
