import cron, { type ScheduledTask as CronTask } from 'node-cron';
import type pino from 'pino';
import type { AppConfig } from '../config/index.js';
import type { MemoryApi, ScheduledTask } from '../memory/index.js';
import type { MessagingAdapter } from '../messaging/adapter.js';
import { child } from '../logger/index.js';
import {
  COACH_TASK_DESCRIPTION,
  isCoachMarker,
  expandCoachPromptToken,
} from '../coach/index.js';

const log = child({ component: 'scheduler' });

export interface SchedulerDeps {
  config: AppConfig;
  logger: pino.Logger;
  memory: MemoryApi;
  /**
   * Fire-and-enqueue handler — takes a scheduler-originated user message
   * and enqueues it on that chat's schedulerQueue via the gateway.
   * Returns void; the gateway handles queue overflow and drop notifications.
   *
   * v1.10.0: `ownerUserId` plumbs the task owner's userId through to
   * `agent.turn()` so /organize + /memory tools can operate per-user.
   * Legacy tasks (pre-v1.10.0) have `owner_user_id = null` and fire with
   * `ownerUserId: null`; those turns see `ctx.userId === undefined` and
   * the tools return NO_USER_ID with an actionable "recreate the task"
   * message.
   */
  enqueueSchedulerTurn(params: {
    chatId: number;
    taskId: number;
    description: string;
    command: string;
    ownerUserId: number | null;
    /**
     * v1.18.0 ADR 018 D3.a: per-coach-turn counters passed for coach tasks.
     * Activates coach_log_* per-turn cap enforcement. Undefined for non-coach tasks.
     */
    coachTurnCounters?: { nudges: number; writes: number };
  }): void;
  /**
   * v1.10.0 R2: optional messaging adapter so the scheduler can DM the
   * task owner when their task is dropped due to allowlist revocation.
   * Null-safe — null means "don't send the DM but still emit the audit row."
   */
  messagingAdapter?: MessagingAdapter | null;
}

export interface SchedulerApi {
  start(): void;
  stop(): void;
  reload(): void;
  /**
   * Test-only seam (prefix `_`). Invokes the same fire-path a cron tick
   * would — including the v1.10.0 allowlist re-check, audit emission,
   * DM delivery, and enqueue. Returns true if the task was found and
   * the fire path ran (whether it enqueued or dropped), false if the
   * task id is not registered. Use ONLY in tests; production paths
   * should let cron trigger the fire naturally.
   */
  _fireTaskForTests(taskId: number): boolean;
}

/**
 * node-cron based scheduler.
 * On start(), reads all 'active' scheduled_tasks rows and registers cron jobs.
 * Each fire calls enqueueSchedulerTurn — the gateway handles the queue semantics.
 *
 * v1.10.0 additions:
 *   - Reads `owner_user_id` off the task row and passes it to enqueueSchedulerTurn.
 *   - R2 allowlist re-check: before enqueueing, re-verifies the owner is still in
 *     `config.telegram.allowedUserIds`. If not, skips the fire + emits a
 *     `scheduler.policy` audit row with `actor_user_id: null` (system-originated,
 *     not the dropped user) + DMs the owner via `adapter.resolveDmChatId` (never
 *     falls back to `task.chat_id` which could be a group).
 *   - R3 limitation: the allowlist snapshot is boot-frozen. Admin role changes
 *     made mid-process without a pm2 restart will NOT be seen by this check.
 *     Documented as "restart-interval granularity" per ADR 005 Decision 19.
 */
export function initScheduler(deps: SchedulerDeps): SchedulerApi {
  const { config, memory, enqueueSchedulerTurn, messagingAdapter } = deps;

  // R3: build the allowlist set ONCE at boot. Any in-process admin role change
  // is not reflected until restart. This is the boot-frozen limitation documented
  // in ADR 005 Decision 19.
  const allowlist: ReadonlySet<number> = new Set(config.telegram.allowedUserIds);

  const activeJobs = new Map<number, CronTask>();
  let running = false;

  function handleDroppedOwner(task: ScheduledTask): void {
    // R2: audit the drop with `scheduler.policy` category and NULL actor.
    try {
      memory.auditLog.insert({
        category: 'scheduler.policy',
        actor_user_id: null,
        actor_chat_id: null,
        session_id: null,
        detail: {
          event: 'drop_unauthorized_owner',
          taskId: task.id,
          ownerUserId: task.owner_user_id,
          chatId: task.chat_id,
          description: task.description,
          reason: 'owner_not_in_allowlist',
        },
      });
    } catch (err) {
      log.error(
        { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
        'scheduler.policy audit insert failed',
      );
    }

    // R2: DM the owner via resolveDmChatId. Never fall back to task.chat_id.
    if (messagingAdapter && task.owner_user_id !== null) {
      const dmChatId = messagingAdapter.resolveDmChatId(task.owner_user_id);
      if (dmChatId !== null) {
        const body =
          `⚠️ Scheduled task skipped: "${task.description}"\n\n` +
          `You're no longer in the allowlist, so this task cannot fire. ` +
          `If this is unexpected, contact the Jarvis admin. ` +
          `Use /scheduled delete ${task.id} to remove it.`;
        messagingAdapter.sendMessage(dmChatId, body).catch((err: unknown) => {
          log.warn(
            { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
            'scheduler: failed to DM dropped-owner notice',
          );
        });
      } else {
        log.warn(
          { taskId: task.id, ownerUserId: task.owner_user_id },
          'scheduler: dropped owner has no DM channel; audit emitted but no DM sent',
        );
      }
    }
  }

  /**
   * Dedup memory key for coach prompt-load-fail DMs (24h window).
   * Stored in the in-memory map keyed by userId so a second failure in the
   * same 24h window is audited but does NOT DM again.
   */
  const promptLoadFailDmSentAt = new Map<number, number>(); // userId → Date.now() of last DM

  /** 24 hours in milliseconds */
  const DM_DEDUP_MS = 24 * 60 * 60 * 1000;

  /**
   * Handle a coach-prompt load failure: emit audit row + conditionally DM owner.
   * Deduplicates DMs to once per 24h per user (ADR 018 commit 6 spec).
   */
  function handleCoachPromptLoadFail(task: ScheduledTask): void {
    // Emit audit row regardless of DM dedup.
    try {
      memory.auditLog.insert({
        category: 'coach.prompt_load_failed',
        actor_user_id: task.owner_user_id,
        actor_chat_id: task.chat_id,
        session_id: null,
        detail: {
          taskId: task.id,
          ownerUserId: task.owner_user_id,
          reason: 'coachPrompt.md missing from build',
        },
      });
    } catch (auditErr) {
      log.error(
        { taskId: task.id, err: auditErr instanceof Error ? auditErr.message : String(auditErr) },
        'scheduler: coach.prompt_load_failed audit insert failed',
      );
    }

    if (!messagingAdapter || task.owner_user_id === null) return;

    const userId = task.owner_user_id;
    const lastSent = promptLoadFailDmSentAt.get(userId) ?? 0;
    const now = Date.now();

    if (now - lastSent < DM_DEDUP_MS) {
      log.info(
        { userId, taskId: task.id },
        'scheduler: coach prompt-load-fail DM suppressed (24h dedup)',
      );
      return;
    }

    // Update dedup timestamp BEFORE the async send so concurrent fires don't double-DM.
    promptLoadFailDmSentAt.set(userId, now);

    const dmChatId = messagingAdapter.resolveDmChatId(userId);
    if (dmChatId !== null) {
      messagingAdapter
        .sendMessage(
          dmChatId,
          'Coach scheduled task failed to fire — coachPrompt.md missing from build. Check pm2 logs.',
        )
        .catch((err: unknown) => {
          log.warn(
            { userId, taskId: task.id, err: err instanceof Error ? err.message : String(err) },
            'scheduler: failed to DM coach prompt-load-fail notice',
          );
        });
    } else {
      log.warn(
        { userId, taskId: task.id },
        'scheduler: coach prompt-load-fail — no DM channel for owner; audit emitted but no DM sent',
      );
    }
  }

  /**
   * Execute the fire-path for a task. Extracted so the cron callback AND
   * `_fireTaskForTests` share the same logic (v1.10.0 Phase-2 QA finding:
   * previous tests inline-simulated the fire-path instead of exercising
   * the real callback — a false-green).
   */
  function fireTask(task: ScheduledTask): void {
    log.info(
      { taskId: task.id, ownerUserId: task.owner_user_id, description: task.description },
      'Scheduled task firing',
    );

    try {
      // R2: re-check owner against the allowlist snapshot. Owner=null is a
      // legacy task; the tools will surface NO_USER_ID at turn time, but
      // the task itself is allowed to fire (backward compat).
      if (task.owner_user_id !== null && !allowlist.has(task.owner_user_id)) {
        log.warn(
          { taskId: task.id, ownerUserId: task.owner_user_id },
          'Scheduled task owner not in allowlist — skipping fire',
        );
        handleDroppedOwner(task);
        return;
      }

      // --- ADR 018 commit 6: ${coach_prompt} expansion at fire time ---
      // expandCoachPromptToken() is a no-op for tasks without the placeholder.
      // If the task IS a coach task (description === COACH_TASK_DESCRIPTION) and
      // the prompt file is missing, we skip the fire and DM the owner (24h dedup).
      let expandedCommand: string;
      try {
        expandedCommand = expandCoachPromptToken(task.command);
      } catch (expandErr) {
        // loadCoachPrompt() threw — coachPrompt.md missing from dist/.
        log.warn(
          {
            taskId: task.id,
            ownerUserId: task.owner_user_id,
            err: expandErr instanceof Error ? expandErr.message : String(expandErr),
          },
          'scheduler: coach prompt expansion failed — skipping fire',
        );
        handleCoachPromptLoadFail(task);
        return; // do NOT enqueue the turn
      }

      // --- Build coachTurnCounters if this is a coach task (ADR 018 D3.a R3) ---
      // This activates Dev-A's per-turn cap (MAX_NUDGES_PER_COACH_TURN = 5,
      // MAX_MEMORY_WRITES_PER_COACH_TURN = 10) in the coach_log_* tools.
      // v1.20.0 ADR 020 D2 + D4: extended to cover all 4 profile markers
      // (__coach_morning__, __coach_midday__, __coach_evening__, __coach_weekly__)
      // and the legacy __coach__ marker via isCoachMarker(). COACH_TASK_DESCRIPTION
      // is retained for backward compat (same value as LEGACY_COACH_MARKER = '__coach__').
      const isCoachTask = isCoachMarker(task.description) || task.description === COACH_TASK_DESCRIPTION;

      memory.scheduledTasks.markRan(task.id);
      enqueueSchedulerTurn({
        chatId: task.chat_id,
        taskId: task.id,
        description: task.description,
        command: expandedCommand,
        ownerUserId: task.owner_user_id,
        ...(isCoachTask
          ? { coachTurnCounters: { nudges: 0, writes: 0 } }
          : {}),
      });
    } catch (err) {
      log.error(
        {
          taskId: task.id,
          err: err instanceof Error ? err.message : String(err),
        },
        'Scheduler fire failed',
      );
    }
  }

  // Keep the registered task rows around so _fireTaskForTests can look them up
  // without re-reading from memory (the test may have registered a task directly
  // via the repo and then wants to trigger the fire for that row).
  const registeredTasks = new Map<number, ScheduledTask>();

  function registerTask(task: ScheduledTask): void {
    if (!cron.validate(task.cron_expression)) {
      log.warn(
        { taskId: task.id, cron: task.cron_expression },
        'Invalid cron expression, skipping task',
      );
      return;
    }

    const job = cron.schedule(
      task.cron_expression,
      () => {
        if (!running) return;
        fireTask(task);
      },
      { scheduled: false },
    );

    activeJobs.set(task.id, job);
    registeredTasks.set(task.id, task);
    job.start();
  }

  return {
    start(): void {
      if (running) {
        log.warn({}, 'Scheduler already running');
        return;
      }
      running = true;

      const tasks = memory.scheduledTasks.listActive();
      for (const task of tasks) {
        registerTask(task);
      }
      log.info({ count: tasks.length }, 'Scheduler started');
    },

    stop(): void {
      running = false;
      for (const job of activeJobs.values()) {
        job.stop();
      }
      activeJobs.clear();
      log.info({}, 'Scheduler stopped');
    },

    reload(): void {
      // Stop existing jobs
      for (const job of activeJobs.values()) {
        job.stop();
      }
      activeJobs.clear();
      registeredTasks.clear();

      // Re-read from DB
      const tasks = memory.scheduledTasks.listActive();
      for (const task of tasks) {
        registerTask(task);
      }
      log.info({ count: tasks.length }, 'Scheduler reloaded');
    },

    _fireTaskForTests(taskId: number): boolean {
      const task = registeredTasks.get(taskId);
      if (!task) return false;
      fireTask(task);
      return true;
    },
  };
}
