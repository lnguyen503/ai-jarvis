/**
 * /api/webapp/debates/:id/stream SSE route (v1.16.0).
 *
 * Mounts:
 *   GET /api/webapp/debates/:id/stream — server-sent events for a live debate run
 *
 * Auth: HMAC at connection open (same chain as items routes; per ADR 016 D3).
 * Per-user scoping: findByIdScoped(id, userId) — single-query (P8 binding).
 *
 * SSE close-path quad-binding (R1 BLOCKING / D13.a):
 *   req.on('close') + res.on('close') + res.on('error') + res.on('finish')
 *   + outer try/catch with unsubscribed once-only flag.
 *   All five paths call onClose(); idempotent via unsubscribed flag.
 *
 * Events emitted:
 *   snapshot — initial state on connect (covers rounds missed before subscribe)
 *   round     — debater turn
 *   verdict   — debate verdict
 *   complete  — debate finished (terminal; client may close)
 *   error     — abort/error (terminal; client may close)
 *   : keepalive — comment every 25s to reset proxy idle timers
 *
 * Idle close: 60s after last event (keepalive resets the idle timer).
 *
 * Audit: webapp.debate_view (action: 'stream_open') on connect.
 */

import { type Express, type Request, type Response } from 'express';
import { child } from '../logger/index.js';
import { authenticateRequest, type ItemsRouteDeps } from './items.auth.js';
import { auditDebateView } from './debate.shared.js';
import { redactIp } from './items.shared.js';
import { debateEventBus, type DebateEvent } from '../debate/eventbus.js';

const log = child({ component: 'webapp.debatesStream' });

// D4 constants (ADR 016)
const KEEPALIVE_INTERVAL_MS = 25_000; // 25s — below typical 60s proxy timeout
const SSE_IDLE_TIMEOUT_MS = 60_000;   // 60s server-side idle close

// SSE event-name constants — shared convention with client (debate/app.js).
// Named so that typos are caught at build time; never emit raw string literals below.
// F2 fix (Anti-Slop Phase 2 cosmetic): named constants for protocol strings.
export const SSE_EVENT_SNAPSHOT = 'snapshot';
export const SSE_EVENT_ROUND    = 'round';
export const SSE_EVENT_VERDICT  = 'verdict';
export const SSE_EVENT_COMPLETE = 'complete';
export const SSE_EVENT_ERROR    = 'error';

export function mountDebatesStreamRoute(app: Express, deps: ItemsRouteDeps): void {
  app.get('/api/webapp/debates/:id/stream', async (req: Request, res: Response) => {
    // 1. Auth chain
    const auth = authenticateRequest(req, res, deps);
    if (!auth.ok) return;
    const { userId } = auth;

    const { id: runId } = req.params;
    if (!runId || typeof runId !== 'string' || runId.length > 64) {
      res.status(400).json({ ok: false, code: 'BAD_REQUEST', error: 'Invalid debate id' });
      return;
    }

    // 2. Per-user scoped lookup — single SQL query (P8 binding).
    let run;
    try {
      run = deps.memory.debateRuns.findByIdScoped(runId, userId);
    } catch (err) {
      log.error({ userId, runId, err: err instanceof Error ? err.message : String(err) }, 'Failed to fetch debate run for SSE');
      res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: 'Failed to fetch debate' });
      return;
    }

    if (!run) {
      res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'Debate not found' });
      return;
    }

    // 3. Set SSE headers (D4 + defense-in-depth for nginx/cloudflared)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // 4. Audit
    const ip = req.ip ? redactIp(req.ip) : undefined;
    auditDebateView(deps.memory, userId, 'stream_open', runId, undefined, ip);

    // -----------------------------------------------------------------------
    // R1 BLOCKING — D13.a SSE close-path quad-binding
    // -----------------------------------------------------------------------

    let unsubscribed = false;
    let unsubscribeFn: (() => void) | null = null;
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * onClose is idempotent (unsubscribed once-only flag) and bound to ALL FIVE
     * close paths: req.close, res.close, res.error, res.finish, outer try/catch.
     *
     * Responsible for: event-bus unsubscribe + keepalive interval clear + idle timer clear.
     */
    const onClose = (): void => {
      if (unsubscribed) return;
      unsubscribed = true;
      if (unsubscribeFn) unsubscribeFn();
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      if (idleTimer) clearTimeout(idleTimer);
      log.debug({ component: 'webapp.debates.stream', runId }, 'sse close');
    };

    // Quad-bind BEFORE subscribe so that an immediate close still cleans up.
    req.on('close', onClose);   // canonical client disconnect (TCP RST, navigation)
    res.on('close', onClose);   // res.destroy(); proxy timeout drop
    res.on('error', onClose);   // socket-level error (broken pipe; cloudflared reset)
    res.on('finish', onClose);  // res.end() after terminal event

    // Helper: write an SSE event line
    const writeEvent = (eventType: string, data: unknown): void => {
      if (unsubscribed) return;
      try {
        res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        onClose();
      }
      // Reset idle timer on every real event
      if (idleTimer) clearTimeout(idleTimer);
      if (!unsubscribed) {
        idleTimer = setTimeout(() => {
          if (!unsubscribed) {
            try {
              res.write(': idle-timeout\n\n');
            } catch {
              // ignore
            }
            onClose();
            res.end();
          }
        }, SSE_IDLE_TIMEOUT_MS);
      }
    };

    try {
      // 5. Subscribe to event bus
      const handler = (event: DebateEvent): void => {
        if (unsubscribed) return;
        switch (event.type) {
          case 'round':
            writeEvent(SSE_EVENT_ROUND, event.round);
            break;
          case 'verdict':
            writeEvent(SSE_EVENT_VERDICT, event.verdict);
            break;
          case 'complete':
            writeEvent(SSE_EVENT_COMPLETE, { status: 'complete' });
            // Terminal event — close gracefully
            onClose();
            res.end();
            break;
          case 'error':
            writeEvent(SSE_EVENT_ERROR, { reason: event.reason });
            // Terminal event — close gracefully
            onClose();
            res.end();
            break;
          case 'snapshot':
            writeEvent(SSE_EVENT_SNAPSHOT, event.state);
            break;
        }
      };

      unsubscribeFn = debateEventBus.subscribe(runId, handler);

      // 6. Send initial snapshot (covers rounds that fired before we subscribed)
      let rounds: import('../memory/debateLog.js').DebateRoundRow[];
      try {
        rounds = deps.memory.debateRounds.listByRun(runId);
      } catch (err) {
        log.warn({ runId, err: err instanceof Error ? err.message : String(err) }, 'Failed to fetch rounds for SSE snapshot');
        rounds = [];
      }

      // Build snapshot state shape for the client
      const snapshotData = {
        id: run.id,
        topic: run.topic,
        status: run.status,
        roundsTarget: run.rounds_target,
        roundsCompleted: run.rounds_completed,
        rounds: rounds.map((r) => ({
          roundNumber: r.round_number,
          debaterName: r.debater_name,
          modelName: r.model_name,
          content: r.content,
          ts: r.ts,
        })),
        verdict: run.verdict_json ? (() => {
          try { return JSON.parse(run.verdict_json!) as unknown; } catch { return null; }
        })() : null,
      };
      writeEvent(SSE_EVENT_SNAPSHOT, snapshotData);

      // If the run is already terminal, send terminal event immediately and close
      if (run.status === 'complete') {
        writeEvent(SSE_EVENT_COMPLETE, { status: 'complete' });
        onClose();
        res.end();
        return;
      }
      if (run.status === 'aborted') {
        writeEvent(SSE_EVENT_ERROR, { reason: run.abort_reason ?? 'aborted' });
        onClose();
        res.end();
        return;
      }

      // 7. Keepalive — every 25s, resets proxy idle timers
      keepaliveTimer = setInterval(() => {
        if (unsubscribed) return;
        try {
          res.write(': keepalive\n\n');
        } catch {
          onClose();
        }
        // Keepalive resets idle timer
        if (idleTimer) clearTimeout(idleTimer);
        if (!unsubscribed) {
          idleTimer = setTimeout(() => {
            if (!unsubscribed) {
              try { res.write(': idle-timeout\n\n'); } catch { /* ignore */ }
              onClose();
              res.end();
            }
          }, SSE_IDLE_TIMEOUT_MS);
        }
      }, KEEPALIVE_INTERVAL_MS);

      // 8. Initial idle timer
      idleTimer = setTimeout(() => {
        if (!unsubscribed) {
          try { res.write(': idle-timeout\n\n'); } catch { /* ignore */ }
          onClose();
          res.end();
        }
      }, SSE_IDLE_TIMEOUT_MS);

    } catch (err) {
      // Outer try/catch: if handler setup throws BEFORE the long-lived loop
      log.warn({ component: 'webapp.debates.stream', runId, err: err instanceof Error ? err.message : String(err) }, 'sse handler threw');
      onClose();
      if (!res.headersSent) {
        res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: 'SSE setup failed' });
      } else {
        res.end();
      }
    }
  });
}
