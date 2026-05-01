/**
 * GET /api/webapp/identity — bot identity endpoint (v1.21.0 ADR 021 Pillar 4 D13 + D15).
 *
 * Returns { ok: true, botName, scope } for the running bot process.
 * The hub banner fetches this endpoint on boot to display the bot name badge.
 *
 * Auth: same HMAC + allowlist chain as other webapp routes (authenticateRequest).
 * No audit row — read-only metadata, same policy as /api/webapp/config.
 *
 * Shape:
 *   200 { ok: true, botName: BotName, scope: BotScope }
 *   401 { ok: false, code: 'AUTH_FAILED', error: string, reason: string }
 *       (response sent by authenticateRequest on auth failure)
 */

import { type Express, type Request, type Response } from 'express';
import type { BotIdentity } from '../config/botIdentity.js';
import { authenticateRequest, type ItemsRouteDeps } from './items.auth.js';

/**
 * Mount the identity route. Requires `identity` in deps — if not provided
 * (pre-v1.21.0 boot without botIdentity wiring), returns a safe default.
 */
export function mountIdentityRoute(
  app: Express,
  deps: ItemsRouteDeps & { identity?: BotIdentity | null },
): void {
  // GET /api/webapp/identity
  app.get('/api/webapp/identity', (req: Request, res: Response) => {
    // authenticateRequest sends the 401 response on failure and returns { ok: false }.
    const authResult = authenticateRequest(req, res, deps);
    if (!authResult.ok) return;

    const identity = deps.identity;
    if (!identity) {
      // No identity wired — legacy single-bot mode. Return ai-jarvis defaults.
      res.status(200).json({ ok: true, botName: 'ai-jarvis', scope: 'full' });
      return;
    }

    res.status(200).json({
      ok: true,
      botName: identity.name,
      scope: identity.scope,
    });
  });
}
