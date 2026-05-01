import type { DbHandle } from '../dbDriver.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Run all pending SQL migrations in order.
 * Migrations are numbered .sql files in this directory.
 * Each is tracked in schema_migrations(version).
 */
export function runMigrations(db: DbHandle): void {
  // Ensure the migrations table exists first
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[]).map(
      (r) => r.version,
    ),
  );

  const migrationsDir = __dirname;
  const sqlFiles = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // lexicographic order — 001_, 002_, etc.

  for (const file of sqlFiles) {
    const version = file.replace('.sql', '');
    if (applied.has(version)) {
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

    // Run as a transaction so partial migrations are not committed
    const runMigration = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
    });
    runMigration();
  }
}
