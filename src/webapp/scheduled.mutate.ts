/**
 * Mutation routes for /api/webapp/scheduled (v1.17.0).
 *
 * POST   /api/webapp/scheduled       — create a new scheduled task
 * PATCH  /api/webapp/scheduled/:id   — update (cron expression, description, status)
 * DELETE /api/webapp/scheduled/:id   — delete
 *
 * Auth: HMAC chain via authenticateRequest (items.auth.ts).
 * Per-user scoping: enforced — owner_user_id = authenticated userId on create;
 *   task.owner_user_id === userId guard on update/delete.
 * Audit: webapp.scheduled_mutate (action: 'create' | 'update' | 'delete').
 *
 * Cron expression validation: node-cron.validate() at the API layer (same
 * validator the scheduler uses for actual job registration).
 */

import { type Express, type Request, type Response } from 'express';
import express from 'express';
import cron from 'node-cron';
import { child } from '../logger/index.js';
import { authenticateRequest } from './items.auth.js';
import { auditScheduledMutate, type ScheduledRouteDeps } from './scheduled.shared.js';
import { redactIp } from './items.shared.js';
import {
  COACH_TASK_DESCRIPTION,
  isCoachMarker,
} from '../coach/index.js';

const log = child({ component: 'webapp.scheduledMutate' });

// Body size limit: 8KB is generous for a task description + cron expression
const BODY_LIMIT = '8kb';

// Max description length
const MAX_DESCRIPTION_LEN = 500;
// Max command length
const MAX_COMMAND_LEN = 1000;

export function mountScheduledMutateRoutes(app: Express, deps: ScheduledRouteDeps): void {
  const jsonParser = express.json({ limit: BODY_LIMIT });

  // -------------------------------------------------------------------
  // POST /api/webapp/scheduled — create
  // -------------------------------------------------------------------
  app.post('/api/webapp/scheduled', jsonParser, (req: Request, res: Response) => {
    const auth = authenticateRequest(req, res, deps);
    if (!auth.ok) return;
    const { userId } = auth;

    const { description, cronExpression, command, chatId } = req.body as Record<string, unknown>;

    // Validate required fields
    if (typeof description !== 'string' || description.trim().length === 0) {
      res.status(400).json({ ok: false, code: 'VALIDATION_ERROR', error: 'description is required' });
      return;
    }
    if (description.trim().length > MAX_DESCRIPTION_LEN) {
      res.status(400).json({
        ok: false,
        code: 'VALIDATION_ERROR',
        error: `description too long (max ${MAX_DESCRIPTION_LEN} chars)`,
      });
      return;
    }
    if (typeof cronExpression !== 'string' || cronExpression.trim().length === 0) {
      res.status(400).json({ ok: false, code: 'VALIDATION_ERROR', error: 'cronExpression is required' });
      return;
    }
    if (!cron.validate(cronExpression.trim())) {
      res.status(400).json({ ok: false, code: 'VALIDATION_ERROR', error: 'Invalid cron expression' });
      return;
    }
    if (typeof command !== 'string' || command.trim().length === 0) {
      res.status(400).json({ ok: false, code: 'VALIDATION_ERROR', error: 'command is required' });
      return;
    }
    if (command.trim().length > MAX_COMMAND_LEN) {
      res.status(400).json({
        ok: false,
        code: 'VALIDATION_ERROR',
        error: `command too long (max ${MAX_COMMAND_LEN} chars)`,
      });
      return;
    }
    if (typeof chatId !== 'number' || !Number.isInteger(chatId)) {
      res.status(400).json({ ok: false, code: 'VALIDATION_ERROR', error: 'chatId must be an integer' });
      return;
    }

    // v1.18.0 ADR 018 D9 + v1.20.0 ADR 020 D2: defense in depth — reject all coach marker descriptions
    // on create. User-supplied tasks with __coach__ or __coach_*__ markers are reserved.
    if (isCoachMarker(description.trim()) || description.trim() === COACH_TASK_DESCRIPTION) {
      res.status(400).json({
        ok: false,
        code: 'RESERVED_DESCRIPTION',
        error: 'Coach marker descriptions are reserved. Use the coach setup endpoint.',
      });
      return;
    }

    let taskId: number;
    try {
      taskId = deps.memory.scheduledTasks.insert({
        description: description.trim(),
        cron_expression: cronExpression.trim(),
        command: command.trim(),
        chat_id: chatId,
        owner_user_id: userId,
      });
    } catch (err) {
      log.error(
        { userId, err: err instanceof Error ? err.message : String(err) },
        'Failed to create scheduled task',
      );
      res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: 'Failed to create task' });
      return;
    }

    // ADR 017 §7 Risk #8 + CP1 surface row 13: reload scheduler so the new task
    // fires immediately without requiring a pm2 restart. Null-safe: scheduler is
    // late-bound; during the brief boot window or in tests without a real scheduler
    // this is a no-op rather than a crash.
    try { deps.scheduler?.reload(); } catch (reloadErr) {
      log.warn(
        { err: reloadErr instanceof Error ? reloadErr.message : String(reloadErr), taskId },
        'scheduler.reload() failed after task create — task will fire on next scheduler reload',
      );
    }

    const ip = req.ip ? redactIp(req.ip) : undefined;
    auditScheduledMutate(deps.memory, userId, 'create', taskId, ip);

    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({ ok: true, id: taskId });
  });

  // -------------------------------------------------------------------
  // PATCH /api/webapp/scheduled/:id — update
  // -------------------------------------------------------------------
  app.patch('/api/webapp/scheduled/:id', jsonParser, (req: Request, res: Response) => {
    const auth = authenticateRequest(req, res, deps);
    if (!auth.ok) return;
    const { userId } = auth;

    const taskId = parseInt(req.params['id'] ?? '', 10);
    if (Number.isNaN(taskId) || taskId <= 0) {
      res.status(400).json({ ok: false, code: 'BAD_REQUEST', error: 'Invalid task id' });
      return;
    }

    let task;
    try {
      task = deps.memory.scheduledTasks.get(taskId);
    } catch (err) {
      log.error({ userId, taskId, err: err instanceof Error ? err.message : String(err) }, 'Failed to get task for update');
      res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: 'Failed to update task' });
      return;
    }

    if (!task || task.owner_user_id !== userId) {
      res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'Task not found' });
      return;
    }

    // v1.18.0 ADR 018 D9 + v1.20.0 ADR 020 D2: coach task markers are reserved.
    // upsertCoachTask(ByProfile)() owns their lifecycle; direct PATCH would desync the sentinels.
    // Defense in depth: reject both the legacy __coach__ AND all 4 profile markers.
    if (isCoachMarker(task.description)) {
      res.status(400).json({
        ok: false,
        code: 'RESERVED_DESCRIPTION',
        error: 'Coach task cannot be modified directly. Use the coach setup endpoint.',
      });
      return;
    }

    const body = req.body as Record<string, unknown>;

    // Validate the fields that are present
    if ('status' in body) {
      const status = body['status'];
      if (status !== 'active' && status !== 'paused') {
        res.status(400).json({
          ok: false,
          code: 'VALIDATION_ERROR',
          error: 'status must be "active" or "paused"',
        });
        return;
      }
      try {
        deps.memory.scheduledTasks.setStatus(taskId, status);
      } catch (err) {
        log.error({ userId, taskId, err: err instanceof Error ? err.message : String(err) }, 'Failed to update task status');
        res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: 'Failed to update task' });
        return;
      }
    }

    // ADR 017 §7 Risk #8: reload so status changes (pause/resume) take effect immediately.
    try { deps.scheduler?.reload(); } catch (reloadErr) {
      log.warn(
        { err: reloadErr instanceof Error ? reloadErr.message : String(reloadErr), taskId },
        'scheduler.reload() failed after task update — change will apply on next reload',
      );
    }

    const ip = req.ip ? redactIp(req.ip) : undefined;
    auditScheduledMutate(deps.memory, userId, 'update', taskId, ip);

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true });
  });

  // -------------------------------------------------------------------
  // DELETE /api/webapp/scheduled/:id — delete
  // -------------------------------------------------------------------
  app.delete('/api/webapp/scheduled/:id', (req: Request, res: Response) => {
    const auth = authenticateRequest(req, res, deps);
    if (!auth.ok) return;
    const { userId } = auth;

    const taskId = parseInt(req.params['id'] ?? '', 10);
    if (Number.isNaN(taskId) || taskId <= 0) {
      res.status(400).json({ ok: false, code: 'BAD_REQUEST', error: 'Invalid task id' });
      return;
    }

    let task;
    try {
      task = deps.memory.scheduledTasks.get(taskId);
    } catch (err) {
      log.error({ userId, taskId, err: err instanceof Error ? err.message : String(err) }, 'Failed to get task for delete');
      res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: 'Failed to delete task' });
      return;
    }

    if (!task || task.owner_user_id !== userId) {
      res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'Task not found' });
      return;
    }

    try {
      deps.memory.scheduledTasks.remove(taskId);
    } catch (err) {
      log.error({ userId, taskId, err: err instanceof Error ? err.message : String(err) }, 'Failed to delete scheduled task');
      res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: 'Failed to delete task' });
      return;
    }

    // ADR 017 §7 Risk #8: reload so deleted task is de-registered from the scheduler immediately.
    try { deps.scheduler?.reload(); } catch (reloadErr) {
      log.warn(
        { err: reloadErr instanceof Error ? reloadErr.message : String(reloadErr), taskId },
        'scheduler.reload() failed after task delete — task will be de-registered on next reload',
      );
    }

    const ip = req.ip ? redactIp(req.ip) : undefined;
    auditScheduledMutate(deps.memory, userId, 'delete', taskId, ip);

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true });
  });
}
