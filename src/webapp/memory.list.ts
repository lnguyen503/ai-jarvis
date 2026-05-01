/**
 * GET /api/webapp/memory       — list all keyed memory entries (v1.17.0).
 * GET /api/webapp/memory/:key  — detail for a single keyed entry.
 *
 * Auth: HMAC chain via authenticateRequest (items.auth.ts).
 * Per-user scoping: userId from auth; dataDir from deps.
 * Audit: webapp.memory_view (action: 'list' | 'detail').
 *
 * Memory key validation at API layer: /^[a-z0-9_-]{1,64}$/ (defense in depth;
 * sole-writer layer in userMemoryEntries.ts enforces too — ADR 017 D8 binding).
 */

import { type Express, type Request, type Response } from 'express';
import { child } from '../logger/index.js';
import { authenticateRequest } from './items.auth.js';
import { auditMemoryView, type MemoryRouteDeps } from './memory.shared.js';
import { redactIp } from './items.shared.js';
import { listEntries, getEntry, MEMORY_KEY_RE } from '../memory/userMemoryEntries.js';

const log = child({ component: 'webapp.memoryList' });

export function mountMemoryListRoutes(app: Express, deps: MemoryRouteDeps): void {
  // -------------------------------------------------------------------
  // GET /api/webapp/memory — list all entries
  // -------------------------------------------------------------------
  app.get('/api/webapp/memory', async (req: Request, res: Response) => {
    const auth = authenticateRequest(req, res, deps);
    if (!auth.ok) return;
    const { userId } = auth;

    let entries;
    try {
      entries = await listEntries(userId, deps.dataDir);
    } catch (err) {
      log.error(
        { userId, err: err instanceof Error ? err.message : String(err) },
        'Failed to list memory entries',
      );
      res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: 'Failed to list entries' });
      return;
    }

    const ip = req.ip ? redactIp(req.ip) : undefined;
    auditMemoryView(deps.memory, userId, 'list', undefined, entries.length, ip);

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      ok: true,
      entries: entries.map((e) => ({
        key: e.key,
        body: e.body,
        etag: e.etag,
        mtimeMs: e.mtimeMs,
      })),
    });
  });

  // -------------------------------------------------------------------
  // GET /api/webapp/memory/:key — single entry detail
  // IMPORTANT: Mount AFTER list but BEFORE mutate routes.
  // -------------------------------------------------------------------
  app.get('/api/webapp/memory/:key', async (req: Request, res: Response) => {
    const auth = authenticateRequest(req, res, deps);
    if (!auth.ok) return;
    const { userId } = auth;

    const key = req.params['key'] ?? '';

    // Key validation at API layer (defense in depth)
    if (!MEMORY_KEY_RE.test(key)) {
      res.status(400).json({
        ok: false,
        code: 'VALIDATION_ERROR',
        error: `Invalid key "${key}" — must match /^[a-z0-9_-]{1,64}$/`,
      });
      return;
    }

    let entry;
    try {
      entry = await getEntry(userId, deps.dataDir, key);
    } catch (err) {
      log.error(
        { userId, key, err: err instanceof Error ? err.message : String(err) },
        'Failed to get memory entry',
      );
      res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: 'Failed to get entry' });
      return;
    }

    if (!entry) {
      res.status(404).json({ ok: false, code: 'NOT_FOUND', error: `No entry with key "${key}" found` });
      return;
    }

    const ip = req.ip ? redactIp(req.ip) : undefined;
    auditMemoryView(deps.memory, userId, 'detail', key, undefined, ip);

    // Fix 2 (F2 closure): set ETag response header so the client can use it
    // in subsequent PATCH If-Match headers (R5 + W4 concurrency control).
    // Without this header, memory/app.js:295 reads null and never sends If-Match,
    // silently disabling the 412 conflict guard in production.
    res.setHeader('ETag', entry.etag);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      ok: true,
      entry: {
        key: entry.key,
        body: entry.body,
        etag: entry.etag,
        mtimeMs: entry.mtimeMs,
      },
    });
  });
}
