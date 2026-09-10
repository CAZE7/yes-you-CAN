/**
 * Project test runner.
 *
 * Collects every compiled `*.test.js` under the workspace and runs it through
 * Node's built-in test runner (no extra test dependency). Use `npm test`
 * (build + test) or `npm run test:only` when the build is already fresh.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = process.cwd();
const searchRoots = ['packages', 'tools', 'tests', 'apps'].map((dir) => resolve(root, dir));
const files = [];

function walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {
      if (full.endsWith('.test.js') && !full.includes(`${entry === 'node_modules' ? 'node_modules' : '@'}`)) files.push(full);
      continue;
    }
    if (entry === 'node_modules') continue;
    walk(full);
  }
}

for (const searchRoot of searchRoots) walk(searchRoot);

if (files.length === 0) {
  console.error('no compiled test files found — run `npm run build` first');
  process.exit(1);
}

files.sort();
console.log(`running ${files.length} compiled test files\n`);
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: root });
process.exit(result.status ?? 1);
