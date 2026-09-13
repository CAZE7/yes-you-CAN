/**
 * Definition package migration (AGENTS 13).
 *
 * A recorded session references the exact definition version it was made with,
 * so an older package has to stay readable after the model moves on. Migration
 * is therefore *upward only* and explicit: a package is never rewritten in place
 * (it is versioned data someone else still references), and a version this build
 * does not know is an error rather than a guess.
 */

import { DefinitionError } from "@vdp/shared";
import {
  CURRENT_SCHEMA_VERSION,
  type DefinitionPackage,
  SUPPORTED_SCHEMA_VERSIONS,
} from "./schema.js";

/** True when this build can read the package's schema version at all. */
export function isSupportedSchemaVersion(schemaVersion: number): boolean {
  return SUPPORTED_SCHEMA_VERSIONS.includes(schemaVersion);
}

/** True when the package predates {@link CURRENT_SCHEMA_VERSION} and can be upgraded. */
export function needsUpgrade(pkg: DefinitionPackage): boolean {
  return pkg.schemaVersion < CURRENT_SCHEMA_VERSION;
}

/**
 * Return the package at {@link CURRENT_SCHEMA_VERSION}.
 *
 * Already current packages are returned by identity — callers keep their
 * `WeakMap` index caches and a no-op upgrade cannot accidentally detach a
 * package from the object a session recorded.
 *
 * Steps run in order, one per version, because a version 1 package has to pass
 * through version 2 to reach the current one:
 *
 * - **1 → 2** adds the vehicle axis. A version 1 package has no vehicles to carry
 *   over, so the step only widens the shape: `vehicles` becomes an empty list,
 *   which every reader already treats as "OEM-wide, no narrowing".
 * - **2 → 3** adds fault knowledge per variant (`dtcKnowledge` on a vehicle).
 *   Again nothing is carried over — a version 2 package has no variant knowledge,
 *   and readers treat its absence as "only the package-wide fault descriptions
 *   exist" instead of dressing a generic text up as variant knowledge (§24).
 */
export function upgradePackage(pkg: DefinitionPackage): DefinitionPackage {
  if (pkg.schemaVersion === CURRENT_SCHEMA_VERSION) return pkg;
  if (!isSupportedSchemaVersion(pkg.schemaVersion)) {
    throw new DefinitionError(
      `definition package "${pkg.name}" uses schema version ${pkg.schemaVersion}, ` +
        `this build supports ${SUPPORTED_SCHEMA_VERSIONS.join(", ")}`,
      { package: pkg.name, schemaVersion: pkg.schemaVersion },
    );
  }
  let upgraded = pkg;
  if (upgraded.schemaVersion === 1) {
    upgraded = { ...upgraded, schemaVersion: 2, vehicles: upgraded.vehicles ?? [] };
  }
  if (upgraded.schemaVersion === 2) {
    upgraded = { ...upgraded, schemaVersion: 3 };
  }
  if (upgraded.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    // Every supported older version has an explicit step above; reaching this line
    // means a version was added to SUPPORTED_SCHEMA_VERSIONS without a migration.
    throw new DefinitionError(
      `no migration defined for schema version ${pkg.schemaVersion} → ${CURRENT_SCHEMA_VERSION}`,
      { package: pkg.name, schemaVersion: pkg.schemaVersion },
    );
  }
  return upgraded;
}
