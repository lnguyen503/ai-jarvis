/**
 * /api/webapp/debates list route (v1.16.0).
 *
 * Mounts:
 *   GET /api/webapp/debates — paginated list of the authenticated user's debate runs
 *
 * Auth: HMAC chain via authenticateRequest (from items.auth.ts, re-exported by debate.shared.ts).
 * Per-user scoping: WHERE user_id = ? — cross-user isolation enforced in DebateRunsRepo.
 * Audit: webapp.debate_view (action: 'list').
 */

import { type Express, type Request, type Response } from 'express';
import { child } from '../logger/index.js';
import { authenticateRequest, type ItemsRouteDeps } from './items.auth.js';
import { auditDebateView } from './debate.shared.js';
import { redactIp } from './items.shared.js';

const log = child({ component: 'webapp.debatesList' });

// ADR 016 D11 spec: default limit = 50. Aligning server default to spec (F2.b fix).
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export function mountDebatesListRoute(app: Express, deps: ItemsRouteDeps): void {
  app.get('/api/webapp/debates', (req: Request, res: Response) => {
    // 1. Auth chain
    const auth = authenticateRequest(req, res, deps);
    if (!auth.ok) return;
    const { userId } = auth;

    // 2. Parse pagination params
    const rawLimit = parseInt(String(req.query['limit'] ?? DEFAULT_LIMIT), 10);
    const rawOffset = parseInt(String(req.query['offset'] ?? 0), 10);
    const limit = Number.isNaN(rawLimit) ? DEFAULT_LIMIT : Math.min(Math.max(1, rawLimit), MAX_LIMIT);
    const offset = Number.isNaN(rawOffset) ? 0 : Math.max(0, rawOffset);

    // 3. Fetch runs (per-user scoped)
    let runs;
    try {
      runs = deps.memory.debateRuns.findByUser(userId, { limit, offset });
    } catch (err) {
      log.error({ userId, err: err instanceof Error ? err.message : String(err) }, 'Failed to list debate runs');
      res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: 'Failed to list debates' });
      return;
    }

    // 4. Audit
    const ip = req.ip ? redactIp(req.ip) : undefined;
    auditDebateView(deps.memory, userId, 'list', undefined, runs.length, ip);

    // 5. Response
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      ok: true,
      debates: runs.map((r) => ({
        id: r.id,
        topic: r.topic,
        status: r.status,
        participantCount: r.participant_count,
        roundsTarget: r.rounds_target,
        roundsCompleted: r.rounds_completed,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        abortReason: r.abort_reason ?? undefined,
      })),
      pagination: { limit, offset },
    });
  });
}
