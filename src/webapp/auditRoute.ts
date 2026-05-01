/**
 * Audit log webapp API routes (v1.17.0).
 *
 * Mounts:
 *   GET /api/webapp/audit      — paginated list (audit.list.ts)
 *   GET /api/webapp/audit/:id  — single row detail (audit.detail.ts)
 *
 * Auth chain reuses items.auth.ts (single source of truth per ADR 017 D5).
 * Export: mountAuditRoutes(app, deps) — mounted from server.ts.
 *
 * R6: categories filter validated against KNOWN_AUDIT_CATEGORIES closed set.
 * R4: cursor-based forward pagination; empty cursor = refresh-from-top.
 */

import type { Express } from 'express';
import type { ItemsRouteDeps } from './items.auth.js';
import { mountAuditListRoute } from './audit.list.js';
import { mountAuditDetailRoute } from './audit.detail.js';

export type { ItemsRouteDeps } from './items.auth.js';

/**
 * Mount all /api/webapp/audit routes on the Express app.
 * Called from server.ts after mountMemoryRoutes.
 */
export function mountAuditRoutes(app: Express, deps: ItemsRouteDeps): void {
  mountAuditListRoute(app, deps);
  mountAuditDetailRoute(app, deps);
}
