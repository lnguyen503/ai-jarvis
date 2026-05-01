/**
 * Debate webapp API routes (v1.16.0).
 *
 * Mounts:
 *   GET /api/webapp/debates             — list (debates.list.ts)
 *   GET /api/webapp/debates/:id         — detail (debates.detail.ts)
 *   GET /api/webapp/debates/:id/stream  — SSE stream (debates.stream.ts)
 *
 * Auth chain reuses items.auth.ts (single source of truth per R7).
 * Export: mountDebatesRoutes(app, deps) — mounted from server.ts alongside
 * items routes.
 */

import type { Express } from 'express';
import type { ItemsRouteDeps } from './items.auth.js';
import { mountDebatesListRoute } from './debates.list.js';
import { mountDebatesDetailRoute } from './debates.detail.js';
import { mountDebatesStreamRoute } from './debates.stream.js';

export type { ItemsRouteDeps } from './items.auth.js';

/**
 * Mount all /api/webapp/debates routes on the Express app.
 * Called from server.ts after mountItemsRoutes.
 */
export function mountDebatesRoutes(app: Express, deps: ItemsRouteDeps): void {
  mountDebatesListRoute(app, deps);
  // Stream BEFORE detail — Express matches most-specific first, but the :id
  // segment would match /debates/:id before /debates/:id/stream without ordering.
  mountDebatesStreamRoute(app, deps);
  mountDebatesDetailRoute(app, deps);
}
