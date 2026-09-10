/**
 * Session schema migrations (AGENTS 34.13: version migrations,
 * AGENTS 34.14: keep old stored sessions compatible).
 *
 * Migrations are pure functions registered once and applied in order. They never
 * mutate in place, so a failed migration cannot leave a half-converted session.
 */

import { StorageError } from '@vdp/shared';
import { SESSION_SCHEMA_VERSION, type VehicleSessionData } from '@vdp/core';

export interface Migration {
  /** Version this migration upgrades *from*. */
  fromVersion: number;
  /** Version this migration produces. */
  toVersion: number;
  description: string;
  up(data: Record<string, unknown>): Record<string, unknown>;
}

export class MigrationRegistry {
  private readonly migrations: Migration[] = [];

  constructor(migrations: readonly Migration[] = defaultMigrations) {
    for (const migration of migrations) this.register(migration);
  }

  register(migration: Migration): void {
    if (migration.toVersion !== migration.fromVersion + 1) {
      throw new StorageError(`migration ${migration.fromVersion} → ${migration.toVersion} must advance exactly one version`, {
        fromVersion: migration.fromVersion,
        toVersion: migration.toVersion,
      });
    }
    this.migrations.push(migration);
    this.migrations.sort((a, b) => a.fromVersion - b.fromVersion);
  }

  get latestVersion(): number {
    return this.migrations.length > 0 ? (this.migrations.at(-1)?.toVersion ?? SESSION_SCHEMA_VERSION) : SESSION_SCHEMA_VERSION;
  }

  /** Apply every migration between the stored version and the current one. */
  migrate(data: Record<string, unknown>): { data: VehicleSessionData; applied: string[] } {
    let current = data;
    let version = typeof current['schemaVersion'] === 'number' ? (current['schemaVersion'] as number) : 0;
    const applied: string[] = [];

    while (version < SESSION_SCHEMA_VERSION) {
      const migration = this.migrations.find((m) => m.fromVersion === version);
      if (!migration) {
        throw new StorageError(`no migration registered from schema version ${version} (current is ${SESSION_SCHEMA_VERSION})`, {
          fromVersion: version,
        });
      }
      current = migration.up(current);
      current['schemaVersion'] = migration.toVersion;
      applied.push(`${migration.fromVersion}→${migration.toVersion}: ${migration.description}`);
      version = migration.toVersion;
    }
    if (version > SESSION_SCHEMA_VERSION) {
      throw new StorageError(`session was written by a newer version (schema ${version}, this build supports ${SESSION_SCHEMA_VERSION})`, {
        fromVersion: version,
      });
    }
    return { data: current as unknown as VehicleSessionData, applied };
  }
}

/**
 * Built-in migrations.
 *
 * Version 1 is the initial shape, so the registry starts empty; the first real
 * change appends a `fromVersion: 1` migration here and bumps SESSION_SCHEMA_VERSION.
 * Keeping the list explicit (rather than inferring it) is what makes old stored
 * sessions readable years later.
 */
export const defaultMigrations: readonly Migration[] = [];
