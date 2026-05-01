/**
 * Tool: schedule — create a recurring scheduled task (v1.10.0).
 *
 * The agent calls this when the user explicitly asks for a recurring or
 * future-time-triggered action. The task is saved to `scheduled_tasks`
 * with the speaker's owner_user_id so all user-scoped tools work when it fires.
 *
 * Audit note: `description` (user-authored) lands in the audit detail under
 * `scheduler.create`. This matches the `admin_command` precedent where slash
 * commands echo user-authored inputs into audit detail (they are user-authored,
 * meant to be queryable). The `commandPreview` truncates at 100 chars to keep
 * rows readable; the full command lives in `scheduled_tasks.command`.
 *
 * ADR 005 decisions 15, R10 (no computeNextFire), R11 (try/catch), R7 (audit category).
 */

import { z } from 'zod';
import cron from 'node-cron';
import type { Tool, ToolResult, ToolContext } from './types.js';
import { child } from '../logger/index.js';

const ScheduleInput = z.object({
  description: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'Short human label for the task (≤200 chars). Shown in /scheduled listings and ' +
        'in the DM notice when the task fires. Example: "morning goal check".',
    ),
  cron: z
    .string()
    .min(1)
    .describe(
      'Cron schedule in node-cron syntax (5-field: minute hour day-of-month month day-of-week). ' +
        '"0 8 * * *" = 8am daily, "*/15 * * * *" = every 15 min, "0 9 * * 1-5" = 9am weekdays.',
    ),
  command: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      'The prompt Jarvis runs when the task fires — as if the owner typed it. ' +
        'Example: "list my active organize items". Tools marked adminOnly run only if the owner is an admin.',
    ),
});

type ScheduleInputType = z.infer<typeof ScheduleInput>;

export const scheduleTool: Tool<ScheduleInputType> = {
  name: 'schedule',
  description:
    'Create a recurring scheduled task. The task fires at the cron time as if the user typed the command. ' +
    'Call ONLY when the user says "remind me every …", "schedule X daily at Y", "every morning do …", etc. ' +
    'Do NOT call for one-off immediate actions — just do those directly. ' +
    'The task carries the user\'s identity at fire time, so organize_*, memory_*, calendar_*, etc. ' +
    'all work the same as in an interactive DM turn. ' +
    'Input: description (≤200 chars label), cron (standard 5-field expression), command (≤2000 chars prompt text). ' +
    'Cron examples: "0 8 * * *" = 8am daily; "0 9 * * 1" = 9am Mondays; "*/15 * * * *" = every 15 min.',
  parameters: ScheduleInput,
  adminOnly: false,

  async execute(input: ScheduleInputType, ctx: ToolContext): Promise<ToolResult> {
    const log = child({ component: 'tools.schedule' });

    // Guard: speaker userId must be present so the task carries ownership.
    if (!ctx.userId || !Number.isFinite(ctx.userId)) {
      return {
        ok: false,
        output:
          'Cannot schedule: speaker user id is not available for this turn. ' +
          'If this came from a scheduled task created before v1.10.0, recreate it — ' +
          'the new task will carry your user id automatically.',
        error: { code: 'NO_USER_ID', message: 'ctx.userId missing' },
      };
    }

    // Validate cron expression before touching the DB (R10: use node-cron's validator).
    if (!cron.validate(input.cron)) {
      return {
        ok: false,
        output:
          `Cron expression "${input.cron}" is invalid. ` +
          'Use standard 5-field node-cron syntax: minute hour day-of-month month day-of-week. ' +
          'Examples: "0 8 * * *" (8am daily), "0 */2 * * *" (every 2 hours), "0 9 * * 1-5" (9am weekdays).',
        error: { code: 'INVALID_CRON', message: `Invalid cron expression: "${input.cron}"` },
      };
    }

    // Insert into scheduled_tasks (R11: try/catch around DB insert).
    let taskId: number;
    try {
      taskId = ctx.memory.scheduledTasks.insert({
        description: input.description,
        cron_expression: input.cron,
        command: input.command,
        chat_id: ctx.chatId,
        owner_user_id: ctx.userId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ userId: ctx.userId, err: msg }, 'schedule tool: DB insert failed');
      return {
        ok: false,
        output: `Failed to save scheduled task: ${msg}`,
        error: { code: 'SCHEDULE_INSERT_FAILED', message: msg },
      };
    }

    // Audit row: scheduler.create category (R7).
    // description is user-authored; it lands in detail to make audit rows queryable.
    // This matches the admin_command precedent for user-authored slash command inputs.
    try {
      ctx.memory.auditLog.insert({
        category: 'scheduler.create',
        actor_user_id: ctx.userId,
        actor_chat_id: ctx.chatId,
        session_id: ctx.sessionId,
        detail: {
          taskId,
          description: input.description,
          cron: input.cron,
          commandPreview: input.command.slice(0, 100),
        },
      });
    } catch (auditErr) {
      // Audit failure is non-fatal — the task is already saved. Log warn and continue.
      log.warn(
        { taskId, userId: ctx.userId, err: auditErr instanceof Error ? auditErr.message : String(auditErr) },
        'schedule tool: audit insert failed (non-fatal)',
      );
    }

    // Reload the scheduler so the new task fires without a process restart.
    // schedulerApi is optional (null-safe): old callers and tests that don't wire
    // the scheduler still get ok:true — the task is saved; the scheduler will pick
    // it up on its next natural reload or restart. (R11: reload failure is non-fatal)
    const schedulerApi = ctx.schedulerApi;
    if (schedulerApi != null) {
      try {
        schedulerApi.reload();
      } catch (reloadErr) {
        // Reload failure is non-fatal. The task is saved; it will fire on the next
        // natural pick-up (i.e. process restart). Documented as non-blocking per R11.
        log.warn(
          { taskId, userId: ctx.userId, err: reloadErr instanceof Error ? reloadErr.message : String(reloadErr) },
          'schedule tool: scheduler.reload() threw (non-fatal)',
        );
      }
    }

    log.info({ taskId, userId: ctx.userId, cron: input.cron }, 'schedule tool: task created');

    return {
      ok: true,
      output:
        `Scheduled: "${input.description}" — cron "${input.cron}", status: active. ` +
        `Your user id is linked so /organize and /memory tools work when it fires. ` +
        `Use /scheduled to manage your tasks (list, pause, resume, delete).`,
      data: { taskId, description: input.description, cron: input.cron },
    };
  },
};
