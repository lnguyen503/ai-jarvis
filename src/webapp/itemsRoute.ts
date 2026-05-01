/**
 * Organize items API routes — compatibility shim (v1.14.6).
 *
 * v1.14.0 shipped mountItemsRoutes() in this file. v1.14.2 splits by HTTP verb:
 *   - items.read.ts     → GET /api/webapp/items, GET /api/webapp/items/:id
 *   - items.mutate.ts   → PATCH, DELETE /api/webapp/items/:id
 *   - items.complete.ts → POST /api/webapp/items/:id/complete (v1.14.5 R3 split)
 *   - items.create.ts   → POST /api/webapp/items (v1.14.6 D17)
 *   - items.shared.ts   → auth, audit, validators (shared)
 *
 * This shim preserves the mountItemsRoutes(app, deps) export so server.ts
 * does not need updating. It delegates to all four sub-modules.
 */

import type { Express } from 'express';
import { mountItemsReadRoutes } from './items.read.js';
import { mountItemsMutateRoutes } from './items.mutate.js';
import { mountItemsCompleteRoutes } from './items.complete.js';
import { mountItemsCreateRoutes } from './items.create.js';
export type { AuditAuthFailureFn, ItemsRouteDeps } from './items.shared.js';

/**
 * Mount all organize items routes (GET + PATCH + DELETE + POST /complete + POST /).
 *
 * Read routes (including Cache-Control middleware) are mounted BEFORE mutate
 * routes so the no-store middleware registered by mountItemsReadRoutes on
 * /api/webapp/items applies to mutation responses too.
 *
 * Create routes are mounted last (v1.14.6 W6 T-mount-create wire integrity):
 * the no-store middleware from mountItemsReadRoutes covers this prefix too,
 * and mountItemsCreateRoutes also registers its own middleware for belt+suspenders.
 */
export function mountItemsRoutes(app: Express, deps: import('./items.shared.js').ItemsRouteDeps): void {
  mountItemsReadRoutes(app, deps);
  mountItemsMutateRoutes(app, deps);
  mountItemsCompleteRoutes(app, deps);
  mountItemsCreateRoutes(app, deps);
}
