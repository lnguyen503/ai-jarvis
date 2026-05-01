/**
 * Memory entries webapp API routes (v1.17.0).
 *
 * Mounts:
 *   GET    /api/webapp/memory       — list (memory.list.ts)
 *   GET    /api/webapp/memory/:key  — detail (memory.list.ts)
 *   POST   /api/webapp/memory       — create (memory.mutate.ts)
 *   PATCH  /api/webapp/memory/:key  — update with If-Match (memory.mutate.ts)
 *   DELETE /api/webapp/memory/:key  — delete (memory.mutate.ts)
 *
 * Auth chain reuses items.auth.ts (single source of truth per ADR 017 D5).
 * Export: mountMemoryRoutes(app, deps) — mounted from server.ts.
 *
 * deps.dataDir must be the absolute path to the data directory
 * (where memories/<userId>.md files live). Typically config.memory.dbPath's
 * parent directory (same dir that contains the SQLite db file).
 */

import type { Express } from 'express';
import type { MemoryRouteDeps } from './memory.shared.js';
import { mountMemoryListRoutes } from './memory.list.js';
import { mountMemoryMutateRoutes } from './memory.mutate.js';

export type { MemoryRouteDeps } from './memory.shared.js';

/**
 * Mount all /api/webapp/memory routes on the Express app.
 * Called from server.ts after mountScheduledRoutes.
 */
export function mountMemoryRoutes(app: Express, deps: MemoryRouteDeps): void {
  mountMemoryListRoutes(app, deps);
  mountMemoryMutateRoutes(app, deps);
}
