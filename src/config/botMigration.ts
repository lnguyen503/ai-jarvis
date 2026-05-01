/**
 * botMigration.ts — Per-bot data directory migration (v1.21.0 ADR 021 D3 + CP1 R1).
 *
 * Migrates the legacy flat `data/` layout to the per-bot `data/<botName>/` layout
 * for `BOT_NAME=ai-jarvis` on first v1.21.0 boot. Idempotent, symlink-rejecting,
 * WAL-checkpointing, partial-failure-stopping.
 *
 * BINDING (CP1 R1):
 *   - `PRAGMA wal_checkpoint(TRUNCATE)` BEFORE any fs.renameSync.
 *   - symlink rejection BEFORE checkpoint.
 *   - partial-failure STOPS (no rollback — rollback can deepen inconsistency).
 *   - two-phase audit buffer: Phase A buffers events in memory (no DB yet);
 *     Phase B flushes them after initMemory opens the DB.
 *
 * ORDERING (ADR 021 D3 BINDING):
 *   Phase A (BEFORE initMemory): symlink check + WAL checkpoint + rename.
 *   Phase B (AFTER initMemory): flush buffered audit events.
 *   Static test tests/static/bot-migration-ordering.test.ts enforces Phase A
 *   precedes initMemory in src/index.ts.
 *
 * STATIC TEST (tests/static/bot-migration-wal-checkpoint.test.ts) asserts:
 *   1. lstatSync + isSymbolicLink check precedes pragma('wal_checkpoint(TRUNCATE)').
 *   2. pragma('wal_checkpoint(TRUNCATE)') precedes all fs.renameSync calls.
 */

import path from 'node:path';
import fs from 'node:fs';
import type { AuditLogRepo, AuditCategory } from '../memory/auditLog.js';
import type { BotIdentity } from './botIdentity.js';

// ---------------------------------------------------------------------------
// SQLite DB sidecar filenames — must be renamed atomically as a 3-file unit.
// ---------------------------------------------------------------------------

const SQLITE_DB_FILES = ['jarvis.db', 'jarvis.db-wal', 'jarvis.db-shm'] as const;

// ---------------------------------------------------------------------------
// Other path families migrated for ai-jarvis.
// ---------------------------------------------------------------------------

const LEGACY_DIR_SUBJECTS = ['organize', 'coach', 'workspaces', 'memories'] as const;
const LEGACY_FILE_SUBJECTS = ['google-tokens.json'] as const;
const LEGACY_LOGS_DIR = 'logs' as const;

// ---------------------------------------------------------------------------
// Buffered audit event — Phase A stores these in memory; Phase B flushes.
// ---------------------------------------------------------------------------

export interface BufferedAuditEvent {
  category: AuditCategory;
  detail: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Result shape.
// ---------------------------------------------------------------------------

export interface MigrationResult {
  /** Did the migration rename any files? */
  migrated: boolean;
  /** Status for routing audit categories. */
  status: 'completed' | 'skipped' | 'conflict' | 'failed';
  /** Reason phrase (used for skipped / failed). */
  reason?: string;
  /** Files that were successfully renamed before any failure. */
  renamedSubjects: string[];
  /** Audit events buffered in Phase A for flush in Phase B. */
  auditBuffer: BufferedAuditEvent[];
  /** Partial-failure detail (set when status === 'failed'). */
  failure?: { subject: string; reason: string; partialState: string[] };
}

// ---------------------------------------------------------------------------
// Phase B: flush buffered audit events into the now-open DB.
// ---------------------------------------------------------------------------

/**
 * Flush Phase A buffered audit events into the audit log.
 * Call AFTER initMemory() returns the MemoryApi.
 */
export function flushMigrationAuditBuffer(
  buffer: BufferedAuditEvent[],
  auditLog: AuditLogRepo,
): void {
  for (const event of buffer) {
    try {
      auditLog.insert({ category: event.category, detail: event.detail });
    } catch (err) {
      // Best-effort — do not crash the process if audit insert fails after migration.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[botMigration] audit flush failed: ${msg}\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main migration helper — Phase A (runs BEFORE initMemory).
// ---------------------------------------------------------------------------

/**
 * Run the per-bot data directory migration for this process's identity.
 *
 * For ai-tony (or any future bot other than ai-jarvis): no-op — there is no
 * legacy flat layout to migrate.
 *
 * For ai-jarvis (first v1.21.0 boot):
 *   1. SYMLINK CHECK — reject if `data/jarvis.db` is a symlink.
 *   2. WAL CHECKPOINT — `PRAGMA wal_checkpoint(TRUNCATE)` flushes WAL into main DB.
 *   3. RENAME — 3-file SQLite unit + other path families.
 *   4. PARTIAL-FAILURE-STOPS — if any rename fails, stop; do NOT continue.
 *
 * Returns a MigrationResult. The `.auditBuffer` must be flushed by the caller
 * after initMemory opens the DB (Phase B).
 */
export async function runBotDataMigration(identity: BotIdentity): Promise<MigrationResult> {
  const auditBuffer: BufferedAuditEvent[] = [];

  // Only ai-jarvis has legacy state.
  if (identity.name !== 'ai-jarvis') {
    return {
      migrated: false,
      status: 'skipped',
      reason: `No legacy data for bot "${identity.name}"`,
      renamedSubjects: [],
      auditBuffer,
    };
  }

  const cwd = process.cwd();
  const legacyDbPath = path.resolve(cwd, 'data', 'jarvis.db');
  const newDir = path.resolve(cwd, 'data', identity.name);
  const newDbPath = path.resolve(newDir, 'jarvis.db');

  // Idempotency: if target DB already exists → no-op.
  if (fs.existsSync(newDbPath)) {
    auditBuffer.push({
      category: 'bot.migration_skipped',
      detail: { reason: 'target_exists', newDbPath },
    });
    return {
      migrated: false,
      status: 'skipped',
      reason: 'target_exists',
      renamedSubjects: [],
      auditBuffer,
    };
  }

  // Fresh install: legacy DB doesn't exist → create empty bot dir and return.
  if (!fs.existsSync(legacyDbPath)) {
    fs.mkdirSync(newDir, { recursive: true });
    return {
      migrated: false,
      status: 'skipped',
      reason: 'fresh_install',
      renamedSubjects: [],
      auditBuffer,
    };
  }

  // R1.a — SYMLINK CHECK (MUST COME BEFORE checkpoint and renames).
  // Defense: a symlink at the legacy DB path could redirect the migration write target.
  const legacyStat = fs.lstatSync(legacyDbPath);
  if (legacyStat.isSymbolicLink()) {
    const detail = {
      subject: 'jarvis.db',
      reason: 'SYMLINK_REJECTED',
      legacyPath: legacyDbPath,
    };
    auditBuffer.push({ category: 'bot.migration_failed', detail });
    process.stderr.write(`[botMigration] SYMLINK_REJECTED: ${legacyDbPath}\n`);
    return {
      migrated: false,
      status: 'failed',
      reason: 'SYMLINK_REJECTED',
      renamedSubjects: [],
      auditBuffer,
      failure: { subject: 'jarvis.db', reason: 'SYMLINK_REJECTED', partialState: [] },
    };
  }

  // Conflict: both legacy AND new exist (should not happen normally, but be safe).
  // The target db-path check above would have returned early for the new path.
  // However if the operator manually created data/ai-jarvis/ without jarvis.db,
  // we still want to proceed. The conflict guard is: if BOTH main files exist.
  // (Already handled above — if newDbPath exists we skip. But check for the
  // edge case where newDir exists but lacks jarvis.db — that's a valid fresh dir.)

  // R1.b — WAL CHECKPOINT (AFTER symlink check, BEFORE renames).
  // pragma('wal_checkpoint(TRUNCATE)') flushes WAL writes into the main DB file.
  // After TRUNCATE, the -wal file is zero-length (may still exist on disk).
  try {
    // Dynamic import to keep the module testable without requiring better-sqlite3.
    const { openDriver } = await import('../memory/dbDriver.js');
    const db = openDriver(legacyDbPath);
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const detail = { subject: 'jarvis.db', reason: 'WAL_CHECKPOINT_FAILED', error: msg };
    auditBuffer.push({ category: 'bot.migration_failed', detail });
    process.stderr.write(`[botMigration] WAL_CHECKPOINT_FAILED: ${msg}\n`);
    return {
      migrated: false,
      status: 'failed',
      reason: 'WAL_CHECKPOINT_FAILED',
      renamedSubjects: [],
      auditBuffer,
      failure: { subject: 'jarvis.db', reason: 'WAL_CHECKPOINT_FAILED', partialState: [] },
    };
  }

  // R1.c — ensure target dir exists.
  fs.mkdirSync(newDir, { recursive: true });

  // R1.d — rename the 3-file SQLite unit atomically.
  // PARTIAL-FAILURE-STOPS: if any rename fails, return immediately without
  // attempting rollback (rolling back can deepen inconsistency).
  const renamed: string[] = [];

  for (const filename of SQLITE_DB_FILES) {
    const from = path.resolve(cwd, 'data', filename);
    const to = path.resolve(newDir, filename);
    if (!fs.existsSync(from)) continue; // -wal / -shm may not exist post-TRUNCATE
    try {
      fs.renameSync(from, to);
      renamed.push(filename);
      auditBuffer.push({
        category: 'bot.migration_completed',
        detail: { subject: filename, fromPath: from, toPath: to },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const detail = {
        subject: filename,
        reason: 'RENAME_FAILED',
        error: msg,
        partialState: renamed,
      };
      auditBuffer.push({ category: 'bot.migration_failed', detail });
      process.stderr.write(`[botMigration] RENAME_FAILED ${filename}: ${msg}\n`);
      return {
        migrated: renamed.length > 0,
        status: 'failed',
        reason: 'RENAME_FAILED',
        renamedSubjects: renamed,
        auditBuffer,
        failure: { subject: filename, reason: 'RENAME_FAILED', partialState: renamed },
      };
    }
  }

  // R1.e — migrate other path families (organize/, coach/, workspaces/, logs/, google-tokens.json).
  // Same partial-failure-stops semantics.

  for (const dirName of LEGACY_DIR_SUBJECTS) {
    const from = path.resolve(cwd, 'data', dirName);
    const to = path.resolve(newDir, dirName);
    if (!fs.existsSync(from)) continue;
    try {
      fs.renameSync(from, to);
      renamed.push(dirName);
      auditBuffer.push({
        category: 'bot.migration_completed',
        detail: { subject: dirName, fromPath: from, toPath: to },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const detail = { subject: dirName, reason: 'RENAME_FAILED', error: msg, partialState: renamed };
      auditBuffer.push({ category: 'bot.migration_failed', detail });
      process.stderr.write(`[botMigration] RENAME_FAILED ${dirName}: ${msg}\n`);
      return {
        migrated: true,
        status: 'failed',
        reason: 'RENAME_FAILED',
        renamedSubjects: renamed,
        auditBuffer,
        failure: { subject: dirName, reason: 'RENAME_FAILED', partialState: renamed },
      };
    }
  }

  for (const fileName of LEGACY_FILE_SUBJECTS) {
    const from = path.resolve(cwd, 'data', fileName);
    const to = path.resolve(newDir, fileName);
    if (!fs.existsSync(from)) continue;
    try {
      fs.renameSync(from, to);
      renamed.push(fileName);
      auditBuffer.push({
        category: 'bot.migration_completed',
        detail: { subject: fileName, fromPath: from, toPath: to },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const detail = { subject: fileName, reason: 'RENAME_FAILED', error: msg, partialState: renamed };
      auditBuffer.push({ category: 'bot.migration_failed', detail });
      process.stderr.write(`[botMigration] RENAME_FAILED ${fileName}: ${msg}\n`);
      return {
        migrated: true,
        status: 'failed',
        reason: 'RENAME_FAILED',
        renamedSubjects: renamed,
        auditBuffer,
        failure: { subject: fileName, reason: 'RENAME_FAILED', partialState: renamed },
      };
    }
  }

  // logs directory
  const logsFrom = path.resolve(cwd, 'data', LEGACY_LOGS_DIR);
  const logsTo = path.resolve(newDir, LEGACY_LOGS_DIR);
  if (fs.existsSync(logsFrom)) {
    try {
      fs.renameSync(logsFrom, logsTo);
      renamed.push(LEGACY_LOGS_DIR);
      auditBuffer.push({
        category: 'bot.migration_completed',
        detail: { subject: LEGACY_LOGS_DIR, fromPath: logsFrom, toPath: logsTo },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const detail = { subject: LEGACY_LOGS_DIR, reason: 'RENAME_FAILED', error: msg, partialState: renamed };
      auditBuffer.push({ category: 'bot.migration_failed', detail });
      process.stderr.write(`[botMigration] RENAME_FAILED ${LEGACY_LOGS_DIR}: ${msg}\n`);
      return {
        migrated: true,
        status: 'failed',
        reason: 'RENAME_FAILED',
        renamedSubjects: renamed,
        auditBuffer,
        failure: { subject: LEGACY_LOGS_DIR, reason: 'RENAME_FAILED', partialState: renamed },
      };
    }
  }

  return {
    migrated: true,
    status: 'completed',
    renamedSubjects: renamed,
    auditBuffer,
  };
}
