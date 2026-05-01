/**
 * Scheduled tasks webapp API routes (v1.17.0).
 *
 * Mounts:
 *   GET    /api/webapp/scheduled           — list (scheduled.list.ts)
 *   GET    /api/webapp/scheduled/preview   — cron preview (scheduled.list.ts)
 *   GET    /api/webapp/scheduled/:id       — detail (scheduled.detail.ts)
 *   POST   /api/webapp/scheduled           — create (scheduled.mutate.ts)
 *   PATCH  /api/webapp/scheduled/:id       — update (scheduled.mutate.ts)
 *   DELETE /api/webapp/scheduled/:id       — delete (scheduled.mutate.ts)
 *
 * Auth chain reuses items.auth.ts (single source of truth per ADR 017 D5).
 * Export: mountScheduledRoutes(app, deps) — mounted from server.ts.
 *
 * Mount order: preview BEFORE :id (specific path before parameterized pattern).
 */

import type { Express } from 'express';
import type { ScheduledRouteDeps } from './scheduled.shared.js';
import { mountScheduledListRoutes } from './scheduled.list.js';
import { mountScheduledDetailRoute } from './scheduled.detail.js';
import { mountScheduledMutateRoutes } from './scheduled.mutate.js';

export type { ScheduledRouteDeps } from './scheduled.shared.js';

/**
 * Mount all /api/webapp/scheduled routes on the Express app.
 * Called from server.ts after mountItemsRoutes + mountDebatesRoutes.
 *
 * deps.scheduler is a { reload() } wrapper (may be null during tests that
 * don't wire a real scheduler). The wrapper is populated in src/index.ts at
 * step 10 via the same late-binding pattern as the chat-side /scheduled command.
 */
export function mountScheduledRoutes(app: Express, deps: ScheduledRouteDeps): void {
  // List + preview (preview MUST be before :id to avoid Express matching /preview as an id)
  mountScheduledListRoutes(app, deps);
  // Detail (:id)
  mountScheduledDetailRoute(app, deps);
  // Mutate (POST + PATCH + DELETE)
  mountScheduledMutateRoutes(app, deps);
}
