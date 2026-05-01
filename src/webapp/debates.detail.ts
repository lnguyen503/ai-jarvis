/**
 * /api/webapp/debates/:id detail route (v1.16.0).
 *
 * Mounts:
 *   GET /api/webapp/debates/:id — full debate run with transcript (rounds)
 *
 * Auth: HMAC chain via authenticateRequest.
 * Per-user scoping: findByIdScoped(id, userId) — single SQL query (ADR 016 P8 binding).
 *   Returns 404 for both "not found" and "belongs to another user" — timing-safe.
 * Audit: webapp.debate_view (action: 'detail').
 */

import { type Express, type Request, type Response } from 'express';
import { child } from '../logger/index.js';
import { authenticateRequest, type ItemsRouteDeps } from './items.auth.js';
import { auditDebateView } from './debate.shared.js';
import { redactIp } from './items.shared.js';

const log = child({ component: 'webapp.debatesDetail' });

export function mountDebatesDetailRoute(app: Express, deps: ItemsRouteDeps): void {
  app.get('/api/webapp/debates/:id', (req: Request, res: Response) => {
    // 1. Auth chain
    const auth = authenticateRequest(req, res, deps);
    if (!auth.ok) return;
    const { userId } = auth;

    const { id } = req.params;
    if (!id || typeof id !== 'string' || id.length > 64) {
      res.status(400).json({ ok: false, code: 'BAD_REQUEST', error: 'Invalid debate id' });
      return;
    }

    // 2. Fetch run — single-query per-user scoping (P8 binding)
    let run;
    try {
      run = deps.memory.debateRuns.findByIdScoped(id, userId);
    } catch (err) {
      log.error({ userId, id, err: err instanceof Error ? err.message : String(err) }, 'Failed to fetch debate run');
      res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: 'Failed to fetch debate' });
      return;
    }

    if (!run) {
      // 404 for both not-found AND cross-user — timing-safe (single query)
      res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'Debate not found' });
      return;
    }

    // 3. Fetch rounds
    let rounds;
    try {
      rounds = deps.memory.debateRounds.listByRun(id);
    } catch (err) {
      log.error({ userId, id, err: err instanceof Error ? err.message : String(err) }, 'Failed to fetch debate rounds');
      res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: 'Failed to fetch debate transcript' });
      return;
    }

    // 4. Audit
    const ip = req.ip ? redactIp(req.ip) : undefined;
    auditDebateView(deps.memory, userId, 'detail', id, undefined, ip);

    // 5. Parse verdict JSON safely
    let verdict: unknown = null;
    if (run.verdict_json) {
      try {
        verdict = JSON.parse(run.verdict_json) as unknown;
      } catch {
        verdict = null;
      }
    }

    // 6. Parse model lineup JSON safely
    let modelLineup: unknown[] = [];
    try {
      modelLineup = JSON.parse(run.model_lineup_json) as unknown[];
    } catch {
      modelLineup = [];
    }

    // 7. Response — full transcript shape
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      ok: true,
      debate: {
        id: run.id,
        topic: run.topic,
        status: run.status,
        modelLineup,
        participantCount: run.participant_count,
        roundsTarget: run.rounds_target,
        roundsCompleted: run.rounds_completed,
        verdict,
        reasoning: run.reasoning ?? undefined,
        createdAt: run.created_at,
        updatedAt: run.updated_at,
        abortReason: run.abort_reason ?? undefined,
        rounds: rounds.map((r) => ({
          id: r.id,
          roundNumber: r.round_number,
          debaterName: r.debater_name,
          modelName: r.model_name,
          content: r.content,
          ts: r.ts,
        })),
      },
    });
  });
}
