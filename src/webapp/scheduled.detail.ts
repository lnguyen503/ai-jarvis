/**
 * GET /api/webapp/scheduled/:id — single task detail (v1.17.0).
 *
 * Auth: HMAC chain via authenticateRequest (items.auth.ts).
 * Per-user scoping: task.owner_user_id must match authenticated userId.
 * Audit: webapp.scheduled_view (action: 'detail').
 *
 * Cross-user 404: returns 404 (not 403) when the task exists but belongs
 * to a different user — single-query isolation (same pattern as audit.detail.ts).
 */

import { type Express, type Request, type Response } from 'express';
import { child } from '../logger/index.js';
import { authenticateRequest } from './items.auth.js';
import { auditScheduledView, type ScheduledRouteDeps } from './scheduled.shared.js';
import { redactIp } from './items.shared.js';

const log = child({ component: 'webapp.scheduledDetail' });

export function mountScheduledDetailRoute(app: Express, deps: ScheduledRouteDeps): void {
  app.get('/api/webapp/scheduled/:id', (req: Request, res: Response) => {
    const auth = authenticateRequest(req, res, deps);
    if (!auth.ok) return;
    const { userId } = auth;

    const rawId = req.params['id'];
    const taskId = parseInt(rawId ?? '', 10);
    if (Number.isNaN(taskId) || taskId <= 0) {
      res.status(400).json({ ok: false, code: 'BAD_REQUEST', error: 'Invalid task id' });
      return;
    }

    let task;
    try {
      task = deps.memory.scheduledTasks.get(taskId);
    } catch (err) {
      log.error(
        { userId, taskId, err: err instanceof Error ? err.message : String(err) },
        'Failed to get scheduled task',
      );
      res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: 'Failed to get task' });
      return;
    }

    // Cross-user isolation: 404 if not found OR if belongs to another user
    if (!task || task.owner_user_id !== userId) {
      res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'Task not found' });
      return;
    }

    const ip = req.ip ? redactIp(req.ip) : undefined;
    auditScheduledView(deps.memory, userId, 'detail', task.id, undefined, ip);

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      ok: true,
      task: {
        id: task.id,
        description: task.description,
        cronExpression: task.cron_expression,
        command: task.command,
        chatId: task.chat_id,
        status: task.status,
        lastRunAt: task.last_run_at ?? null,
        nextRunAt: task.next_run_at ?? null,
        createdAt: task.created_at,
        updatedAt: task.updated_at,
      },
    });
  });
}
