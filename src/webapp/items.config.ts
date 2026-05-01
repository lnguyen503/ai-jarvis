/**
 * /api/webapp/config route for the Telegram Web App (v1.15.0 D9).
 *
 * Provides read-only global configuration to the webapp client so the
 * BroadcastChannel name can be dynamically derived from the bot's username
 * rather than being hardcoded as 'organize-mutations-jarvis' (ADR 013 R7
 * Option C hardcode, pre-emptively parameterized for multi-bot scenarios).
 *
 * Mounts:
 *   GET /api/webapp/config  — returns { ok, botUsername, broadcastChannelName }
 *
 * Auth: same chain as items routes (authenticateRequest from items.shared.ts).
 * Audit: NO audit row — read-only metadata endpoint (ADR 015 D9 + F1).
 * Cache-Control: no-store (matches items routes pattern).
 *
 * F1 positive-bind (Anti-Slop review W6): this file MUST NOT import from
 * memory.auditLog or auditItemMutate — verified at review time.
 */

import { type Express, type Request, type Response } from 'express';
import { child } from '../logger/index.js';
import {
  authenticateRequest,
  type ItemsRouteDeps,
} from './items.shared.js';

const log = child({ component: 'webapp.itemsConfig' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Deps for the config route. Extends ItemsRouteDeps by adding the bot's
 * username (resolved at boot via getMe() in gateway/index.ts).
 *
 * botUsername is passed as a plain string from server.ts at server construction
 * time. It is the canonical bot username returned by Telegram's getMe() call
 * (e.g. 'jarvis'). If getMe() failed at boot, the gateway logs a warning and
 * passes an empty string; the config route still responds 200 with that value.
 */
export interface ConfigRouteDeps extends ItemsRouteDeps {
  /** Bot's Telegram username (e.g. 'jarvis'). Empty string if not yet resolved. */
  botUsername: string;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Mount the /api/webapp/config read-only endpoint.
 *
 * Response shape (200 OK):
 * ```json
 * {
 *   "ok": true,
 *   "botUsername": "jarvis",
 *   "broadcastChannelName": "organize-mutations-jarvis"
 * }
 * ```
 *
 * Auth failures return 401 / 403 from authenticateRequest (same as items routes).
 * No audit row is written — read-only metadata per ADR 015 D9.
 */
export function mountConfigRoute(app: Express, deps: ConfigRouteDeps): void {
  app.get('/api/webapp/config', (req: Request, res: Response) => {
    // 1. Auth chain — same as items routes: HMAC + timestamp + allowlist guard.
    const auth = authenticateRequest(req, res, deps);
    if (!auth.ok) return; // authenticateRequest already sent 401/403

    // 2. Read botUsername from deps (passed from server.ts at boot).
    const { botUsername } = deps;

    // 3. Derive broadcastChannelName — must be 'organize-mutations-' + botUsername exactly.
    const broadcastChannelName = `organize-mutations-${botUsername}`;

    // 4. Cache-Control: no-store — matches items routes pattern.
    res.setHeader('Cache-Control', 'no-store');

    log.debug({ botUsername, broadcastChannelName }, 'webapp config served');

    // 5. Respond 200 with config payload. NO audit row (read-only metadata; D9 + F1).
    res.status(200).json({
      ok: true,
      botUsername,
      broadcastChannelName,
    });
  });
}
