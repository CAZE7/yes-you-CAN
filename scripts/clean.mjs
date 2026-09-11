import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = ["packages", "tools", "apps", "tests"];
const removed = [];

function walk(dir, depth = 0) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    if (entry === "node_modules") continue;
    if (entry === "dist") {
      rmSync(full, { recursive: true, force: true });
      removed.push(full);
      continue;
    }
    if (depth < 4) walk(full, depth + 1);
  }
}

for (const r of roots) walk(r);
for (const f of readdirSync(".").filter((f) => f.endsWith(".tsbuildinfo"))) {
  rmSync(f);
  removed.push(f);
}
console.log(`cleaned ${removed.length} dist dirs`);
