/**
 * Trash evictor — v1.11.0 Item 3.
 *
 * Daily cron (default 4am) that hard-deletes items in .trash/ whose age
 * exceeds config.organize.trashTtlDays.
 *
 * Mirrors RemindersApi shape (ADR 006 decision 1).
 * Module isolation: imports only from src/organize/storage.ts, src/memory/,
 * src/config/, node:fs/promises, node:path, and the pino logger.
 * No imports from src/agent/, src/gateway/, src/scheduler/, src/tools/, src/commands/.
 *
 * Scale note: sequential per-user scan. At 100 users × 100 trash items each,
 * wall time is <30s — well within the 4am→8am-next-reminder gap. At 10,000+
 * users per process a concurrent pool would be warranted; deferred (TODO v1.12.0+).
 */

import * as cron from 'node-cron';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { child } from '../logger/index.js';
import { evictExpiredTrash } from './trash.js';
import type { AppConfig } from '../config/index.js';
import type { MemoryApi } from '../memory/index.js';
import { SELF_MESSAGE_TTL_MS } from '../memory/botSelfMessages.js';

const log = child({ component: 'organize.trashEvictor' });

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TrashEvictorApi {
  start(): void;
  stop(): void;
  /** Exposed for tests and ad-hoc trigger; runs one pass over all users. */
  evictAllUsers(): Promise<{ usersProcessed: number; evicted: number; errors: number; elapsedMs: number }>;
}

export interface TrashEvictorDeps {
  config: AppConfig;
  memory: MemoryApi;
  dataDir: string;
  /** Optional abort signal — mirrors reminders R6 pattern. */
  abortSignal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function initTrashEvictor(deps: TrashEvictorDeps): TrashEvictorApi {
  let cronTask: cron.ScheduledTask | null = null;
  let stopped = false;

  async function evictAllUsers(): Promise<{ usersProcessed: number; evicted: number; errors: number; elapsedMs: number }> {
    const startedAt = Date.now();
    const ttlDays = deps.config.organize.trashTtlDays;
    const warnMs = deps.config.organize.trashEvictWallTimeWarnMs;
    const auditZeroBatches = deps.config.organize.trashEvictAuditZeroBatches;

    log.info({ ttlDays }, 'trash evictor tick start');

    let usersProcessed = 0;
    let totalEvicted = 0;
    let totalErrors = 0;

    // Enumerate user directories under data/organize/
    const organizeRoot = path.join(deps.dataDir, 'organize');
    let userDirs: string[] = [];
    try {
      const entries = await readdir(organizeRoot);
      // Only numeric directory names are userId directories.
      userDirs = entries.filter((e) => /^\d+$/.test(e));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn({ err: (err as Error).message }, 'failed to readdir organize root');
      }
      // Organize root doesn't exist yet — no users, no work.
      return { usersProcessed: 0, evicted: 0, errors: 0, elapsedMs: Date.now() - startedAt };
    }

    for (const userIdStr of userDirs) {
      // Check abort at user boundary (v1.11.0 scope; per-file abort deferred to v1.12.0+).
      if (stopped || deps.abortSignal?.aborted) {
        log.info({ usersProcessed, totalEvicted }, 'trash evictor tick aborted');
        break;
      }

      const userId = Number.parseInt(userIdStr, 10);
      if (!Number.isFinite(userId) || userId <= 0) continue;

      try {
        const userStart = Date.now();
        const result = await evictExpiredTrash(userId, deps.dataDir, ttlDays);
        const userElapsed = Date.now() - userStart;

        usersProcessed++;
        totalEvicted += result.evicted;
        totalErrors += result.errors.length;

        // Emit per-user audit row unless empty and zero-batch audit is off (R7 + R13).
        if (result.evicted > 0 || result.errors.length > 0 || auditZeroBatches) {
          deps.memory.auditLog.insert({
            category: 'organize.trash.evict',
            actor_user_id: userId,
            actor_chat_id: userId,
            detail: {
              userId,
              evicted: result.evicted,
              filesScanned: result.filesScanned,
              errors: result.errors.length,
              ttlDays,
              elapsedMs: userElapsed,
            },
          });
        }

        // Individual per-file error paths go to log.warn (not audit detail) so the
        // audit detail stays count-only per R7 + decision 11.
        for (const e of result.errors) {
          log.warn(
            { userId, path: e.path, code: e.err.code, message: e.err.message },
            'trash evictor per-file error',
          );
        }
      } catch (err) {
        log.error({ userId, err: (err as Error).message }, 'trash evictor user iteration threw');
        totalErrors++;
      }
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > warnMs) {
      log.warn(
        { elapsedMs, warnMs, usersProcessed, totalEvicted, totalErrors },
        'trash eviction exceeded wall-time warn threshold',
      );
    }
    // v1.21.0 R2 — sweep expired bot_self_messages rows (TTL=1h).
    // Reuses organize.trash.evict audit shape; subject distinguishes from organize evictions.
    try {
      const now = Date.now();
      const { evicted: selfMsgEvicted } = deps.memory.botSelfMessages.evictExpired(SELF_MESSAGE_TTL_MS, now);
      if (selfMsgEvicted > 0) {
        deps.memory.auditLog.insert({
          category: 'organize.trash.evict',
          detail: { subject: 'bot_self_messages', evicted: selfMsgEvicted },
        });
        log.info({ evicted: selfMsgEvicted }, 'bot_self_messages eviction complete');
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'bot_self_messages eviction failed — continuing');
    }

    log.info({ usersProcessed, totalEvicted, totalErrors, elapsedMs }, 'trash evictor tick complete');

    return { usersProcessed, evicted: totalEvicted, errors: totalErrors, elapsedMs };
  }

  return {
    start() {
      if (cronTask) return; // idempotent
      const expression = deps.config.organize.trashEvictCron;
      cronTask = cron.schedule(expression, () => {
        void evictAllUsers();
      });
      log.info({ expression, ttlDays: deps.config.organize.trashTtlDays }, 'trash evictor started');
    },

    stop() {
      stopped = true;
      if (cronTask) {
        cronTask.stop();
        cronTask = null;
      }
      log.info({}, 'trash evictor stopped');
    },

    evictAllUsers,
  };
}
