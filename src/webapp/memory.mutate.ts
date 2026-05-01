/**
 * Mutation routes for /api/webapp/memory (v1.17.0).
 *
 * POST   /api/webapp/memory       — create a new keyed entry
 * PATCH  /api/webapp/memory/:key  — update (with If-Match ETag per W4)
 * DELETE /api/webapp/memory/:key  — delete
 *
 * Auth: HMAC chain via authenticateRequest (items.auth.ts).
 * Per-user scoping: userId from auth; writes go to userId's memory file.
 * Audit: webapp.memory_mutate (action: 'create' | 'update' | 'delete').
 *
 * Memory key validation at API layer: /^[a-z0-9_-]{1,64}$/ (defense in depth;
 * sole-writer layer in userMemoryEntries.ts enforces too — ADR 017 D8 binding).
 *
 * If-Match (W4): PATCH sends If-Match: "<etag>" header. 412 on mismatch.
 */

import { type Express, type Request, type Response } from 'express';
import express from 'express';
import { child } from '../logger/index.js';
import { authenticateRequest } from './items.auth.js';
import { auditMemoryMutate, type MemoryRouteDeps } from './memory.shared.js';
import { redactIp } from './items.shared.js';
import {
  createEntry,
  updateEntry,
  deleteEntry,
  MEMORY_KEY_RE,
} from '../memory/userMemoryEntries.js';

const log = child({ component: 'webapp.memoryMutate' });

const BODY_LIMIT = '8kb';

export function mountMemoryMutateRoutes(app: Express, deps: MemoryRouteDeps): void {
  const jsonParser = express.json({ limit: BODY_LIMIT });

  // -------------------------------------------------------------------
  // POST /api/webapp/memory — create
  // -------------------------------------------------------------------
  app.post('/api/webapp/memory', jsonParser, async (req: Request, res: Response) => {
    const auth = authenticateRequest(req, res, deps);
    if (!auth.ok) return;
    const { userId } = auth;

    const { key, body } = req.body as Record<string, unknown>;

    // API-layer key validation (defense in depth)
    if (typeof key !== 'string' || !MEMORY_KEY_RE.test(key)) {
      res.status(400).json({
        ok: false,
        code: 'VALIDATION_ERROR',
        error: `Invalid key — must match /^[a-z0-9_-]{1,64}$/`,
      });
      return;
    }
    if (typeof body !== 'string' || body.trim().length === 0) {
      res.status(400).json({
        ok: false,
        code: 'VALIDATION_ERROR',
        error: 'body is required and must not be empty',
      });
      return;
    }

    let result;
    try {
      result = await createEntry(userId, deps.dataDir, key, body);
    } catch (err) {
      log.error(
        { userId, key, err: err instanceof Error ? err.message : String(err) },
        'Failed to create memory entry',
      );
      res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: 'Failed to create entry' });
      return;
    }

    if (!result.ok) {
      const status = result.code === 'KEY_EXISTS' ? 409 : 400;
      res.status(status).json({ ok: false, code: result.code, error: result.error });
      return;
    }

    const ip = req.ip ? redactIp(req.ip) : undefined;
    auditMemoryMutate(deps.memory, userId, 'create', key, ip);

    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({
      ok: true,
      entry: {
        key: result.entry.key,
        body: result.entry.body,
        etag: result.entry.etag,
        mtimeMs: result.entry.mtimeMs,
      },
    });
  });

  // -------------------------------------------------------------------
  // PATCH /api/webapp/memory/:key — update (If-Match)
  // -------------------------------------------------------------------
  app.patch('/api/webapp/memory/:key', jsonParser, async (req: Request, res: Response) => {
    const auth = authenticateRequest(req, res, deps);
    if (!auth.ok) return;
    const { userId } = auth;

    const key = req.params['key'] ?? '';

    // API-layer key validation (defense in depth)
    if (!MEMORY_KEY_RE.test(key)) {
      res.status(400).json({
        ok: false,
        code: 'VALIDATION_ERROR',
        error: `Invalid key "${key}" — must match /^[a-z0-9_-]{1,64}$/`,
      });
      return;
    }

    const { body } = req.body as Record<string, unknown>;
    if (typeof body !== 'string' || body.trim().length === 0) {
      res.status(400).json({
        ok: false,
        code: 'VALIDATION_ERROR',
        error: 'body is required and must not be empty',
      });
      return;
    }

    // Read If-Match header for ETag concurrency (W4)
    const ifMatch = req.header('If-Match');
    const expectedEtag = ifMatch ? ifMatch.trim() : undefined;

    let result;
    try {
      result = await updateEntry(userId, deps.dataDir, key, body, expectedEtag);
    } catch (err) {
      log.error(
        { userId, key, err: err instanceof Error ? err.message : String(err) },
        'Failed to update memory entry',
      );
      res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: 'Failed to update entry' });
      return;
    }

    if (!result.ok) {
      const status = result.code === 'NOT_FOUND' ? 404 : result.code === 'ETAG_MISMATCH' ? 412 : 400;
      res.status(status).json({ ok: false, code: result.code, error: result.error });
      return;
    }

    const ip = req.ip ? redactIp(req.ip) : undefined;
    auditMemoryMutate(deps.memory, userId, 'update', key, ip);

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      ok: true,
      entry: {
        key: result.entry.key,
        body: result.entry.body,
        etag: result.entry.etag,
        mtimeMs: result.entry.mtimeMs,
      },
    });
  });

  // -------------------------------------------------------------------
  // DELETE /api/webapp/memory/:key — delete
  // -------------------------------------------------------------------
  app.delete('/api/webapp/memory/:key', async (req: Request, res: Response) => {
    const auth = authenticateRequest(req, res, deps);
    if (!auth.ok) return;
    const { userId } = auth;

    const key = req.params['key'] ?? '';

    // API-layer key validation (defense in depth)
    if (!MEMORY_KEY_RE.test(key)) {
      res.status(400).json({
        ok: false,
        code: 'VALIDATION_ERROR',
        error: `Invalid key "${key}" — must match /^[a-z0-9_-]{1,64}$/`,
      });
      return;
    }

    let result;
    try {
      result = await deleteEntry(userId, deps.dataDir, key);
    } catch (err) {
      log.error(
        { userId, key, err: err instanceof Error ? err.message : String(err) },
        'Failed to delete memory entry',
      );
      res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: 'Failed to delete entry' });
      return;
    }

    if (!result.ok) {
      const status = result.code === 'NOT_FOUND' ? 404 : 400;
      res.status(status).json({ ok: false, code: result.code, error: result.error });
      return;
    }

    const ip = req.ip ? redactIp(req.ip) : undefined;
    auditMemoryMutate(deps.memory, userId, 'delete', key, ip);

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true });
  });
}
