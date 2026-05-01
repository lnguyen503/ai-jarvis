/**
 * v1.20.0 Coach task migration (ADR 020 D2 + R3 — CP1 revisions binding).
 *
 * One-shot boot migration: rewrites `__coach__` (legacy) scheduled tasks to
 * `__coach_morning__` (profile-marker scheme). Runs BEFORE scheduler.start()
 * in src/index.ts boot sequence — this ordering is enforced by a static test
 * (tests/static/coach-migration-ordering.test.ts, T-R3-4).
 *
 * Three outcomes per legacy row (R3.c — distinct audit categories):
 *   1. COMPLETED   — target `__coach_morning__` doesn't exist for this user;
 *                    UPDATE row.description = '__coach_morning__'.
 *                    Audit: coach.migration_completed.
 *   2. SKIPPED     — this row IS __coach_morning__ already (identity re-run,
 *                    impossible given WHERE filter but defensive).
 *                    Audit: coach.migration_skipped.
 *   3. CONFLICT    — both `__coach__` AND `__coach_morning__` exist for same user;
 *                    DELETE the legacy row (keep the newer profile row).
 *                    Audit: coach.migration_conflict.
 *
 * Idempotency (T-R3-5): a second call finds no rows matching WHERE description='__coach__';
 *   returns { completed: 0, skipped: 0, conflict: 0 }.
 *
 * Privacy posture (v1.17.0 H gate carry-forward): audit detail JSON is structural only.
 *   NEVER logs cron_expression, command content, or chat_id content.
 *
 * Dependency edges (binding per ADR 020 D16):
 *   migration.ts → memory/index (MemoryApi)
 *   migration.ts → memory/auditLog (AuditLogRepo — via memory.auditLog)
 *   migration.ts → logger
 *   NO import from agent/, gateway/, commands/, or webapp/.
 *
 * ADR 020 D2 + R3.a (boot ordering) + R3.b (3 audit categories) + R3.c (conflict resolution).
 */

import type { MemoryApi } from '../memory/index.js';
import { child } from '../logger/index.js';

const log = child({ component: 'coach.migration' });

/** Description constant for legacy tasks (value equals COACH_TASK_DESCRIPTION = '__coach__'). */
const LEGACY_DESCRIPTION = '__coach__';

/** Target description after migration (equals COACH_MARKER_BY_PROFILE['morning']). */
const MORNING_DESCRIPTION = '__coach_morning__';

export interface MigrationResult {
  completed: number;
  skipped: number;
  conflict: number;
}

/**
 * Migrate all legacy `__coach__` tasks to `__coach_morning__` (per-user).
 *
 * Must be called AFTER initMemory() and BEFORE scheduler.start() in src/index.ts.
 * Static test tests/static/coach-migration-ordering.test.ts enforces the ordering.
 *
 * @param memory - The initialized MemoryApi (read/write access to scheduledTasks + auditLog).
 * @returns Counts of each migration outcome (for logging and tests).
 */
export function migrateLegacyCoachTasks(memory: MemoryApi): MigrationResult {
  const result: MigrationResult = { completed: 0, skipped: 0, conflict: 0 };

  // Read all legacy rows (WHERE description = '__coach__')
  let legacyRows: ReturnType<typeof memory.scheduledTasks.listAll>;
  try {
    legacyRows = memory.scheduledTasks.listAll().filter(
      (t) => t.description === LEGACY_DESCRIPTION,
    );
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      'coach migration: failed to list scheduled tasks — migration skipped',
    );
    return result;
  }

  if (legacyRows.length === 0) {
    log.info({}, 'coach migration: no legacy __coach__ tasks found — no-op');
    return result;
  }

  log.info({ count: legacyRows.length }, 'coach migration: found legacy __coach__ tasks, migrating');

  for (const row of legacyRows) {
    const userId = row.owner_user_id;

    // Find an existing __coach_morning__ row for this user (if any)
    const allUserTasks = memory.scheduledTasks.listAll().filter(
      (t) => t.owner_user_id === userId && t.description === MORNING_DESCRIPTION,
    );

    if (allUserTasks.length === 0) {
      // Case 1: COMPLETED — no morning task; rewrite this row
      try {
        memory.scheduledTasks.updateDescription(row.id, MORNING_DESCRIPTION);
        log.info(
          { userId, taskId: row.id, fromDescription: LEGACY_DESCRIPTION, toDescription: MORNING_DESCRIPTION },
          'coach migration: completed (description updated)',
        );
        try {
          memory.auditLog.insert({
            category: 'coach.migration_completed',
            actor_user_id: userId,
            detail: {
              taskId: row.id,
              userId,
              fromDescription: LEGACY_DESCRIPTION,
              toDescription: MORNING_DESCRIPTION,
              action: 'completed',
            },
          });
        } catch (auditErr) {
          log.warn(
            { userId, taskId: row.id, err: auditErr instanceof Error ? auditErr.message : String(auditErr) },
            'coach migration: audit insert failed (non-fatal)',
          );
        }
        result.completed++;
      } catch (updateErr) {
        log.error(
          { userId, taskId: row.id, err: updateErr instanceof Error ? updateErr.message : String(updateErr) },
          'coach migration: updateDescription failed for task',
        );
      }
    } else {
      // Case 3: CONFLICT — both rows exist; drop the legacy row
      const morningTask = allUserTasks[0]!;
      try {
        memory.scheduledTasks.remove(row.id);
        log.warn(
          { userId, droppedTaskId: row.id, keptTaskId: morningTask.id },
          'coach migration: dropped legacy __coach__ row in favor of existing __coach_morning__',
        );
        try {
          memory.auditLog.insert({
            category: 'coach.migration_conflict',
            actor_user_id: userId,
            detail: {
              droppedTaskId: row.id,
              keptTaskId: morningTask.id,
              userId,
              action: 'conflict_dropped',
            },
          });
        } catch (auditErr) {
          log.warn(
            { userId, taskId: row.id, err: auditErr instanceof Error ? auditErr.message : String(auditErr) },
            'coach migration conflict: audit insert failed (non-fatal)',
          );
        }
        result.conflict++;
      } catch (removeErr) {
        log.error(
          { userId, taskId: row.id, err: removeErr instanceof Error ? removeErr.message : String(removeErr) },
          'coach migration: remove (conflict) failed for task',
        );
      }
    }
  }

  log.info(
    { completed: result.completed, conflict: result.conflict, skipped: result.skipped },
    'coach migration: done',
  );
  return result;
}
