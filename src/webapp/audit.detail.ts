/**
 * GET /api/webapp/audit/:id — single audit row detail (v1.17.0).
 *
 * Auth: HMAC chain via authenticateRequest (items.auth.ts).
 * Per-user scoping: cross-user 404 via single-query (WHERE id = ? AND actor_user_id = ?).
 * Audit: webapp.audit_view (action: 'detail').
 *
 * R9: detail_json truncation to 16KB for display is client-side; server returns full row.
 */

import { type Express, type Request, type Response } from 'express';
import { child } from '../logger/index.js';
import { authenticateRequest, type ItemsRouteDeps } from './items.auth.js';
import { auditAuditView } from './audit.shared.js';
import { redactIp } from './items.shared.js';

const log = child({ component: 'webapp.auditDetail' });

export function mountAuditDetailRoute(app: Express, deps: ItemsRouteDeps): void {
  app.get('/api/webapp/audit/:id', (req: Request, res: Response) => {
    const auth = authenticateRequest(req, res, deps);
    if (!auth.ok) return;
    const { userId } = auth;

    const rawId = req.params['id'];
    const auditId = parseInt(rawId ?? '', 10);
    if (Number.isNaN(auditId) || auditId <= 0) {
      res.status(400).json({ ok: false, code: 'BAD_REQUEST', error: 'Invalid audit id' });
      return;
    }

    let row;
    try {
      row = deps.memory.auditLog.getForUser(auditId, userId);
    } catch (err) {
      log.error(
        { userId, auditId, err: err instanceof Error ? err.message : String(err) },
        'Failed to get audit row',
      );
      res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: 'Failed to get audit row' });
      return;
    }

    // Cross-user isolation: single-query returns null when row belongs to another user
    if (!row) {
      res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'Audit row not found' });
      return;
    }

    const ip = req.ip ? redactIp(req.ip) : undefined;
    auditAuditView(deps.memory, userId, 'detail', row.id, undefined, ip);

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      ok: true,
      row: {
        id: row.id,
        ts: row.ts,
        category: row.category,
        actorUserId: row.actor_user_id,
        actorChatId: row.actor_chat_id,
        sessionId: row.session_id,
        detailJson: row.detail_json,
      },
    });
  });
}
