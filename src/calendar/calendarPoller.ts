/**
 * calendarPoller.ts — 5-minute Google Calendar reverse-sync scheduler (v1.19.0 ADR 019 D6).
 *
 * Mirrors the TrashEvictor + Reminders patterns:
 *   - node-cron schedule (default: every 5 minutes)
 *   - start() / stop() / pollAllUsers() public API
 *   - Enumerates user directories under data/organize/<userId>/ to discover active users
 *   - Sequential per-user; at scale a concurrent pool would be warranted (deferred)
 *
 * Dependency edges (binding per ADR 019 D14):
 *   calendarPoller.ts → calendar/sync (pollCalendarChanges + SyncDeps)
 *                     → calendar/syncCursor (readCursor, writeCursor)
 *                     → logger
 *                     → node:fs/promises, node:path
 *   NO imports from src/organize/storage.ts (D14 one-way edge).
 *   All organize-layer operations are injected via SyncDeps.
 *
 * Boot: registered in src/index.ts after storage callbacks are wired.
 */

import * as cron from 'node-cron';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { child } from '../logger/index.js';
import { pollCalendarChanges } from './sync.js';
import type { SyncDeps } from './sync.js';

const log = child({ component: 'calendar.calendarPoller' });

/** Default poll cadence: every 5 minutes. */
const DEFAULT_CRON = '*/5 * * * *';

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export interface CalendarPollerApi {
  start(): void;
  stop(): void;
  /** Manual trigger — runs one pass over all users. Exposed for tests and admin. */
  pollAllUsers(): Promise<{ usersPolled: number; errors: number; elapsedMs: number }>;
}

export interface CalendarPollerDeps {
  /** Absolute path to the data directory (parent of organize/<userId>/ dirs). */
  dataDir: string;
  /** SyncDeps factory: given a userId, return the SyncDeps for that user. */
  buildSyncDeps(userId: number): SyncDeps;
  /** Optional cron expression override (default: every 5 minutes). */
  cronExpression?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function initCalendarPoller(deps: CalendarPollerDeps): CalendarPollerApi {
  let cronTask: cron.ScheduledTask | null = null;
  let stopped = false;

  /**
   * Enumerate all numeric user directories under data/organize/<userId>/
   * and run pollCalendarChanges for each.
   */
  async function pollAllUsers(): Promise<{ usersPolled: number; errors: number; elapsedMs: number }> {
    const startedAt = Date.now();
    let usersPolled = 0;
    let errors = 0;

    const organizeRoot = path.join(deps.dataDir, 'organize');
    let userDirs: string[] = [];

    try {
      const entries = await readdir(organizeRoot);
      userDirs = entries.filter((e) => /^\d+$/.test(e));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn({ err: (err as Error).message }, 'calendarPoller: failed to readdir organize root');
      }
      // Organize root doesn't exist yet — no users, no work.
      return { usersPolled: 0, errors: 0, elapsedMs: Date.now() - startedAt };
    }

    log.debug({ userCount: userDirs.length }, 'calendarPoller: tick start');

    for (const userIdStr of userDirs) {
      if (stopped) {
        log.info({ usersPolled }, 'calendarPoller: tick aborted — poller stopped');
        break;
      }

      const userId = Number.parseInt(userIdStr, 10);
      if (!Number.isFinite(userId) || userId <= 0) continue;

      try {
        const syncDeps = deps.buildSyncDeps(userId);
        await pollCalendarChanges(userId, syncDeps);
        usersPolled++;
      } catch (err) {
        log.error(
          { userId, err: (err as Error).message },
          'calendarPoller: per-user poll threw unexpectedly',
        );
        errors++;
      }
    }

    const elapsedMs = Date.now() - startedAt;
    log.info({ usersPolled, errors, elapsedMs }, 'calendarPoller: tick complete');
    return { usersPolled, errors, elapsedMs };
  }

  return {
    start() {
      if (cronTask) return; // idempotent
      const expression = deps.cronExpression ?? DEFAULT_CRON;
      cronTask = cron.schedule(expression, () => {
        void pollAllUsers();
      });
      log.info({ expression }, 'calendarPoller: started');
    },

    stop() {
      stopped = true;
      if (cronTask) {
        cronTask.stop();
        cronTask = null;
      }
      log.info({}, 'calendarPoller: stopped');
    },

    pollAllUsers,
  };
}
