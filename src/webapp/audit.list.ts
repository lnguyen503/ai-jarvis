/**
 * GET /api/webapp/audit — paginated audit log list (v1.17.0).
 *
 * Filters: ?categories=<csv>&from=<iso>&to=<iso>&cursor=<base64>&limit=<n>
 *
 * R6 (BINDING): categories filter validated against KNOWN_AUDIT_CATEGORIES closed set.
 * Unknown values → 400 INVALID_CATEGORY. SQL uses parameterized ? placeholders.
 *
 * R4 (BINDING): Cursor-based forward pagination (newest-first).
 *   - cursor absent or empty → refresh-from-top (fetch latest rows)
 *   - cursor present → older rows (walk toward past)
 *   Cursor format: base64("<ts>_<id>") — opaque to client.
 *   nextCursor = null when result set is exhausted.
 *
 * Auth: HMAC chain via authenticateRequest (items.auth.ts).
 * Per-user scoping: WHERE actor_user_id = ? — cross-user isolation.
 * Audit: webapp.audit_view (action: 'list').
 */

import { type Express, type Request, type Response } from 'express';
import { child } from '../logger/index.js';
import { authenticateRequest } from './items.auth.js';
import { auditAuditView, KNOWN_AUDIT_CATEGORIES, type AuditCategory } from './audit.shared.js';
import { redactIp } from './items.shared.js';

const log = child({ component: 'webapp.auditList' });

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// ---------------------------------------------------------------------------
// Cursor encoding/decoding
// ---------------------------------------------------------------------------

/** Encode a cursor from (ts, id) pair. Opaque base64 string for the client. */
function encodeCursor(ts: string, id: number): string {
  return Buffer.from(`${ts}_${id}`, 'utf8').toString('base64');
}

/**
 * Decode a cursor from a base64 string.
 * Returns null on any malformed input (never throws).
 */
function decodeCursor(cursor: string): { ts: string; id: number } | null {
  try {
    const raw = Buffer.from(cursor, 'base64').toString('utf8');
    // Format: <ts>_<id> where ts is ISO 8601
    const lastUnderscore = raw.lastIndexOf('_');
    if (lastUnderscore < 1) return null;
    const ts = raw.slice(0, lastUnderscore);
    const idStr = raw.slice(lastUnderscore + 1);
    const id = parseInt(idStr, 10);
    if (Number.isNaN(id) || id <= 0) return null;
    // Minimal ISO 8601 sanity check
    if (!/^\d{4}-\d{2}-\d{2}T/.test(ts)) return null;
    return { ts, id };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Route mount
// ---------------------------------------------------------------------------

export function mountAuditListRoute(app: Express, deps: import('./items.auth.js').ItemsRouteDeps): void {
  app.get('/api/webapp/audit', (req: Request, res: Response) => {
    const auth = authenticateRequest(req, res, deps);
    if (!auth.ok) return;
    const { userId } = auth;

    // ---- Parse limit ----
    const rawLimit = parseInt(String(req.query['limit'] ?? DEFAULT_LIMIT), 10);
    const limit = Number.isNaN(rawLimit) ? DEFAULT_LIMIT : Math.min(Math.max(1, rawLimit), MAX_LIMIT);

    // ---- Parse categories (R6 closed-set validation) ----
    const rawCategories = String(req.query['categories'] ?? '').trim();
    let categories: AuditCategory[] = [];
    if (rawCategories.length > 0) {
      const parts = rawCategories.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      for (const part of parts) {
        if (!KNOWN_AUDIT_CATEGORIES.has(part as AuditCategory)) {
          res.status(400).json({
            ok: false,
            code: 'INVALID_CATEGORY',
            error: `Unknown audit category: ${part}`,
          });
          return;
        }
      }
      categories = parts as AuditCategory[];
    }

    // ---- Parse from/to ----
    const fromIso = typeof req.query['from'] === 'string' && req.query['from'].trim()
      ? req.query['from'].trim()
      : undefined;
    const toIso = typeof req.query['to'] === 'string' && req.query['to'].trim()
      ? req.query['to'].trim()
      : undefined;

    // ---- Parse cursor (R4) ----
    const rawCursor = typeof req.query['cursor'] === 'string' ? req.query['cursor'].trim() : '';
    let cursorTs: string | undefined;
    let cursorId: number | undefined;

    if (rawCursor.length > 0) {
      const decoded = decodeCursor(rawCursor);
      if (!decoded) {
        res.status(400).json({
          ok: false,
          code: 'INVALID_CURSOR',
          error: 'Invalid cursor format',
        });
        return;
      }
      cursorTs = decoded.ts;
      cursorId = decoded.id;
    }
    // Empty cursor = refresh-from-top (no cursor constraint in SQL)

    // ---- Fetch rows (per-user scoped, parameterized SQL per R6) ----
    let rows;
    try {
      rows = deps.memory.auditLog.listForUserPaginated({
        actorUserId: userId,
        categories,
        fromIso,
        toIso,
        cursorTs,
        cursorId,
        limit: limit + 1, // fetch one extra to detect hasMore
      });
    } catch (err) {
      log.error(
        { userId, err: err instanceof Error ? err.message : String(err) },
        'Failed to list audit rows',
      );
      res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: 'Failed to list audit rows' });
      return;
    }

    // ---- Determine nextCursor ----
    const hasMore = rows.length > limit;
    const resultRows = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = resultRows[resultRows.length - 1];
    const nextCursor = hasMore && lastRow
      ? encodeCursor(lastRow.ts, lastRow.id)
      : null;

    // ---- Audit this read access ----
    const ip = req.ip ? redactIp(req.ip) : undefined;
    auditAuditView(deps.memory, userId, 'list', undefined, resultRows.length, ip);

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      ok: true,
      rows: resultRows.map((r) => ({
        id: r.id,
        ts: r.ts,
        category: r.category,
        actorUserId: r.actor_user_id,
        actorChatId: r.actor_chat_id,
        sessionId: r.session_id,
        detailJson: r.detail_json,
      })),
      pagination: {
        limit,
        nextCursor,
      },
    });
  });
}
