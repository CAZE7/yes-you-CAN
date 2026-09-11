/**
 * Architecture tests (target architecture §28/§29: "Der Dependency Graph
 * sollte eine harte Regel bekommen", "Architekturtests schreiben").
 *
 * Unit tests prove behaviour; these tests prove *structure*. They scan every
 * workspace package's production sources, build the real import graph and
 * fail on any edge that is not explicitly allowed. That keeps the rules
 * enforceable in CI — today and in five years:
 *
 *  - domain/application stay protocol-, transport- and I/O-free,
 *  - protocols never import adapters,
 *  - no package imports the UI,
 *  - every new package must declare its place in the graph consciously.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface PackageNode {
  name: string;
  dir: string;
  vdpDeps: Set<string>;
  nodeBuiltins: Set<string>;
}

/** Directories that hold workspace packages (mirrors `workspaces` in the root manifest). */
const WORKSPACE_ROOTS: ReadonlyArray<{ root: string; depth: number }> = [
  { root: 'packages', depth: 1 },
  { root: 'packages', depth: 2 },
  { root: 'tools', depth: 1 },
  { root: 'apps', depth: 1 },
];

function discoverPackages(): PackageNode[] {
  const found = new Map<string, PackageNode>();
  const seenDirs = new Set<string>();
  for (const { root: workspaceRoot, depth } of WORKSPACE_ROOTS) {
    const base = join(root, workspaceRoot);
    if (!existsSync(base)) continue;
    const collect = (dir: string, level: number): void => {
      if (existsSync(join(dir, 'package.json'))) {
        seenDirs.add(dir);
        return;
      }
      if (level >= depth) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
        collect(join(dir, entry.name), level + 1);
      }
    };
    collect(base, 0);
  }

  for (const dir of seenDirs) {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string };
    if (!manifest.name) continue;
    const node: PackageNode = { name: manifest.name, dir, vdpDeps: new Set(), nodeBuiltins: new Set() };
    const src = join(dir, 'src');
    if (existsSync(src)) {
      for (const file of listTsFiles(src)) {
        // Co-located specs are tests, not production structure.
        if (file.endsWith('.spec.ts')) continue;
        scanImports(readFileSync(file, 'utf8'), node);
      }
    }
    found.set(node.name, node);
  }
  return Array.from(found.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function listTsFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...listTsFiles(full));
    else if (entry.name.endsWith('.ts')) result.push(full);
  }
  return result;
}

const VDP_IMPORT = /from\s+['"](@vdp\/[^'"]+)['"]/g;
const NODE_IMPORT = /from\s+['"]node:([^'"]+)['"]/g;
const DYNAMIC_VDP_IMPORT = /import\(\s*['"](@vdp\/[^'"]+)['"]/g;

function scanImports(source: string, node: PackageNode): void {
  for (const match of source.matchAll(VDP_IMPORT)) {
    const specifier = match[1] as string;
    node.vdpDeps.add(baseName(specifier));
  }
  for (const match of source.matchAll(DYNAMIC_VDP_IMPORT)) {
    const specifier = match[1] as string;
    node.vdpDeps.add(baseName(specifier));
  }
  for (const match of source.matchAll(NODE_IMPORT)) {
    node.nodeBuiltins.add(match[1] as string);
  }
}

/** `@vdp/definitions/generic` → `@vdp/definitions`. */
function baseName(specifier: string): string {
  const parts = specifier.split('/');
  return `${parts[0]}/${parts[1]}`;
}

/**
 * The allowed dependency graph — the hard rule (target architecture §28).
 *
 * Every workspace package MUST appear here; a new package without an entry
 * fails the suite, forcing a conscious placement decision. Edges point from
 * the importing package to what it may import. Nothing above may import
 * something below its own foundation:
 *
 *   shared → domain → application → protocols/definitions →
 *   transports → adapters → core → runtime/storage/reports/ai → apps/tools
 */
const ALLOWED_VDP_DEPS: Record<string, readonly string[]> = {
  // Foundation: no dependencies at all.
  '@vdp/shared': [],
  '@vdp/charts': [],
  '@vdp/protocols-oem': [],

  // Domain contracts: shared primitives only — never protocols, transports or I/O.
  '@vdp/domain': ['@vdp/shared'],

  // Application layer: commands/queries/actions speak domain only.
  '@vdp/application': ['@vdp/domain'],

  // Definitions are data + validation; no diagnostic logic.
  '@vdp/definitions': ['@vdp/shared'],

  // Transports: frame/segmentation layer, no protocols above them.
  '@vdp/transport-can': ['@vdp/shared'],
  '@vdp/transport-iso-tp': ['@vdp/shared', '@vdp/transport-can'],
  '@vdp/transport-doip': ['@vdp/shared', '@vdp/transport-can'],

  // Protocols: speak through transport links, never touch adapters or the core.
  '@vdp/protocols-uds': ['@vdp/shared'],
  '@vdp/protocols-kwp2000': ['@vdp/shared', '@vdp/protocols-uds'],

  // Adapters implement the CAN bus contract; hardware specifics stay here.
  '@vdp/adapter-generic-can': ['@vdp/shared', '@vdp/transport-can'],
  '@vdp/adapter-elm327': ['@vdp/shared', '@vdp/transport-can'],
  '@vdp/adapter-canable': ['@vdp/shared', '@vdp/transport-can', '@vdp/adapter-elm327'],
  '@vdp/adapter-socketcan': ['@vdp/shared', '@vdp/transport-can'],
  '@vdp/adapter-host': [
    '@vdp/shared',
    '@vdp/transport-can',
    '@vdp/adapter-canable',
    '@vdp/adapter-elm327',
    '@vdp/adapter-socketcan',
  ],

  // The (still monolithic) diagnostic core: protocols + transports + definitions.
  '@vdp/core': [
    '@vdp/shared',
    '@vdp/definitions',
    '@vdp/protocols-uds',
    '@vdp/protocols-oem',
    '@vdp/transport-can',
    '@vdp/transport-iso-tp',
  ],

  // Runtime: composition root over core + application/domain contracts.
  // The runtime is the composition root: it wires the transport seam, so it may
  // reach the concrete transports (CAN, DoIP) and the UDS link adapter. Domain
  // and application stay protocol/transport free.
  '@vdp/runtime': [
    '@vdp/shared',
    '@vdp/domain',
    '@vdp/application',
    '@vdp/core',
    '@vdp/definitions',
    '@vdp/protocols-uds',
    '@vdp/transport-can',
    '@vdp/transport-doip',
  ],

  // Infrastructure above the core.
  '@vdp/storage': ['@vdp/shared', '@vdp/core'],
  '@vdp/reports': ['@vdp/core'],
  '@vdp/ai': ['@vdp/shared'],

  // Tools and apps sit on top of everything.
  '@vdp/simulators': [
    '@vdp/shared',
    '@vdp/core',
    '@vdp/definitions',
    '@vdp/protocols-uds',
    '@vdp/transport-can',
    '@vdp/transport-iso-tp',
  ],
  '@vdp/trace-analyzer': ['@vdp/shared', '@vdp/definitions', '@vdp/protocols-uds', '@vdp/transport-can'],
  '@vdp/definition-importer': ['@vdp/shared', '@vdp/definitions'],
  '@vdp/web': [
    '@vdp/shared',
    '@vdp/core',
    '@vdp/definitions',
    '@vdp/protocols-uds',
    '@vdp/transport-can',
    '@vdp/storage',
    '@vdp/reports',
    '@vdp/ai',
    '@vdp/simulators',
    '@vdp/adapter-host',
  ],
};

/**
 * Packages that must stay free of Node builtins: everything that is meant to
 * run headless/portable (domain, application, protocols, transports, core,
 * runtime). File system and sockets belong to storage, host adapters and apps.
 */
const NODE_BUILTINS_ALLOWED: readonly string[] = ['@vdp/adapter-host', '@vdp/storage', '@vdp/web'];

const packages = discoverPackages();

test('every workspace package has a declared place in the dependency graph', () => {
  const missing = packages.filter((pkg) => !(pkg.name in ALLOWED_VDP_DEPS)).map((pkg) => pkg.name);
  assert.deepEqual(
    missing,
    [],
    `new packages must be placed in the architecture graph (tests/architecture): ${missing.join(', ')}`,
  );
  const stale = Object.keys(ALLOWED_VDP_DEPS).filter((name) => !packages.some((pkg) => pkg.name === name));
  assert.deepEqual(stale, [], `rules for packages that no longer exist: ${stale.join(', ')}`);
});

test('all imports follow the allowed dependency graph (target architecture §28)', () => {
  const violations: string[] = [];
  for (const pkg of packages) {
    const allowed = new Set(ALLOWED_VDP_DEPS[pkg.name] ?? []);
    for (const dep of pkg.vdpDeps) {
      if (dep === pkg.name) continue;
      if (!allowed.has(dep)) {
        violations.push(`${pkg.name} → ${dep}  (${relative(root, pkg.dir)})`);
      }
    }
  }
  assert.deepEqual(violations, [], 'forbidden dependency edges found:\n' + violations.join('\n'));
});

test('no package imports the UI', () => {
  const offenders = packages.filter((pkg) => pkg.name !== '@vdp/web' && pkg.vdpDeps.has('@vdp/web'));
  assert.deepEqual(offenders.map((pkg) => pkg.name), [], 'packages must never import the web app');
});

test('portable layers stay free of Node builtins (§28: domain ❌ fs, protocols ❌ I/O)', () => {
  const allowed = new Set(NODE_BUILTINS_ALLOWED);
  const violations: string[] = [];
  for (const pkg of packages) {
    if (allowed.has(pkg.name)) continue;
    for (const builtin of pkg.nodeBuiltins) {
      violations.push(`${pkg.name} imports node:${builtin}`);
    }
  }
  assert.deepEqual(violations, [], 'Node builtins in portable layers:\n' + violations.join('\n'));
});

test('domain and application are protocol- and transport-free (§1, §3)', () => {
  const forbiddenPrefixes = ['@vdp/protocols', '@vdp/transport', '@vdp/adapters', '@vdp/core', '@vdp/runtime', '@vdp/storage'];
  const violations: string[] = [];
  for (const pkg of packages) {
    if (pkg.name !== '@vdp/domain' && pkg.name !== '@vdp/application') continue;
    for (const dep of pkg.vdpDeps) {
      if (forbiddenPrefixes.some((prefix) => dep.startsWith(prefix))) {
        violations.push(`${pkg.name} → ${dep}`);
      }
    }
  }
  assert.deepEqual(violations, [], 'domain/application must stay protocol-free:\n' + violations.join('\n'));
});

test('protocols never import adapters, transports never import protocols (§28)', () => {
  const violations: string[] = [];
  for (const pkg of packages) {
    if (pkg.name.startsWith('@vdp/protocols')) {
      for (const dep of pkg.vdpDeps) {
        if (dep.startsWith('@vdp/adapters')) violations.push(`${pkg.name} → ${dep}`);
      }
    }
    if (pkg.name.startsWith('@vdp/transport')) {
      for (const dep of pkg.vdpDeps) {
        if (dep.startsWith('@vdp/protocols')) violations.push(`${pkg.name} → ${dep}`);
      }
    }
    if (pkg.name.startsWith('@vdp/adapters')) {
      for (const dep of pkg.vdpDeps) {
        if (dep.startsWith('@vdp/protocols') || dep.startsWith('@vdp/core')) violations.push(`${pkg.name} → ${dep}`);
      }
    }
  }
  assert.deepEqual(violations, [], 'layer violations:\n' + violations.join('\n'));
});

test('the production graph matches the documented structure snapshot', () => {
  // This snapshot is the *current* truthful graph. When an edge changes, the
  // diff forces a review: intentional architecture move or accident?
  const snapshot = packages
    .map((pkg) => `${pkg.name}: ${Array.from(pkg.vdpDeps).sort().join(' ') || '(none)'}`)
    .join('\n');
  assert.match(snapshot, /@vdp\/domain: @vdp\/shared/);
  assert.match(snapshot, /@vdp\/application: @vdp\/domain/);
  assert.match(snapshot, /@vdp\/runtime: @vdp\/application @vdp\/core @vdp\/definitions @vdp\/domain @vdp\/protocols-uds @vdp\/shared @vdp\/transport-can @vdp\/transport-doip/);
  assert.match(snapshot, /@vdp\/protocols-uds: @vdp\/shared/);
  // DoIP stays low-level: it must not pull in the protocol layer itself.
  assert.doesNotMatch(snapshot, /@vdp\/transport-doip:.*protocols/);
});
