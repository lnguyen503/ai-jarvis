/**
 * GET /api/webapp/scheduled — list the authenticated user's scheduled tasks (v1.17.0).
 * GET /api/webapp/scheduled/preview?expr=... — cron expression preview (v1.17.0).
 *
 * Auth: HMAC chain via authenticateRequest (items.auth.ts).
 * Per-user scoping: ScheduledTasksRepo.listByOwner(userId).
 * Audit: webapp.scheduled_view (action: 'list' | 'preview').
 */

import { type Express, type Request, type Response } from 'express';
import { child } from '../logger/index.js';
import { authenticateRequest } from './items.auth.js';
import { auditScheduledView, type ScheduledRouteDeps } from './scheduled.shared.js';
import { redactIp } from './items.shared.js';
import { previewCronFireTimes } from '../scheduler/cronPreview.js';

const log = child({ component: 'webapp.scheduledList' });

export function mountScheduledListRoutes(app: Express, deps: ScheduledRouteDeps): void {
  // -------------------------------------------------------------------
  // GET /api/webapp/scheduled — list user's tasks
  // -------------------------------------------------------------------
  app.get('/api/webapp/scheduled', (req: Request, res: Response) => {
    const auth = authenticateRequest(req, res, deps);
    if (!auth.ok) return;
    const { userId } = auth;

    let tasks;
    try {
      tasks = deps.memory.scheduledTasks.listByOwner(userId);
    } catch (err) {
      log.error(
        { userId, err: err instanceof Error ? err.message : String(err) },
        'Failed to list scheduled tasks',
      );
      res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: 'Failed to list tasks' });
      return;
    }

    const ip = req.ip ? redactIp(req.ip) : undefined;
    auditScheduledView(deps.memory, userId, 'list', undefined, tasks.length, ip);

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      ok: true,
      tasks: tasks.map((t) => ({
        id: t.id,
        description: t.description,
        cronExpression: t.cron_expression,
        command: t.command,
        chatId: t.chat_id,
        status: t.status,
        lastRunAt: t.last_run_at ?? null,
        nextRunAt: t.next_run_at ?? null,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
      })),
    });
  });

  // -------------------------------------------------------------------
  // GET /api/webapp/scheduled/preview?expr=... — cron fire-time preview
  // IMPORTANT: mount BEFORE /:id so Express matches this specific path first.
  // -------------------------------------------------------------------
  app.get('/api/webapp/scheduled/preview', (req: Request, res: Response) => {
    const auth = authenticateRequest(req, res, deps);
    if (!auth.ok) return;
    const { userId } = auth;

    const expr = String(req.query['expr'] ?? '').trim();
    if (!expr) {
      res.status(400).json({
        ok: false,
        code: 'MISSING_PARAM',
        error: 'Query parameter "expr" is required',
      });
      return;
    }

    const ip = req.ip ? redactIp(req.ip) : undefined;
    auditScheduledView(deps.memory, userId, 'preview', undefined, undefined, ip);

    const result = previewCronFireTimes(expr);
    if (!result.ok) {
      res.status(400).json({
        ok: false,
        code: result.code,
        error: result.error,
      });
      return;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      ok: true,
      fireTimes: result.fireTimes,
      ...(result.warning ? { warning: result.warning } : {}),
    });
  });
}
