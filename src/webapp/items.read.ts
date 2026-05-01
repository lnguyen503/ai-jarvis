/**
 * Organize items READ routes for the Telegram Web App (v1.14.2).
 *
 * Extracted from itemsRoute.ts (v1.14.0) as part of the module split
 * mandated by ADR 010 SF-6 + decision 5. Retains all GET handlers verbatim;
 * imports shared helpers from items.shared.ts (W1).
 *
 * Mounts:
 *   GET /api/webapp/items          — list user's organize items (metadata only)
 *   GET /api/webapp/items/:id      — full item detail (includes mtimeMs per R2-mtime)
 *
 * Auth: shared chain via authenticateRequest() from items.shared.ts.
 * Cache-Control: no-store for both routes (user-authored content).
 */

import { type Express, type Request, type Response, type NextFunction } from 'express';
import { child } from '../logger/index.js';
import { resolveDataDir } from '../config/dataDir.js';
import { listItems, readItem } from '../organize/storage.js';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { organizeUserDir } from '../organize/storage.js';
import type { OrganizeStatus, OrganizeType, OrganizeItemDetail, OrganizeListItem } from '../organize/types.js';
import {
  ITEM_ID_RE,
  authenticateRequest,
  badRequest,
  type ItemsRouteDeps,
} from './items.shared.js';
import { computeETag } from '../organize/etag.js';
import { ETAG_HEADER } from './etag-headers.js';

const log = child({ component: 'webapp.itemsRead' });

const VALID_TYPES: ReadonlyArray<OrganizeType> = ['task', 'event', 'goal'];
const VALID_STATUSES: ReadonlyArray<OrganizeStatus | 'all'> = ['active', 'done', 'abandoned', 'all'];

/**
 * Mount the read-only items routes on the given Express app.
 * Called from server.ts (or from mountItemsRoutes in itemsRoute.ts for backward compat).
 */
export function mountItemsReadRoutes(app: Express, deps: ItemsRouteDeps): void {
  // -------------------------------------------------------------------------
  // Cache-Control middleware — applied to ALL /api/webapp/items* routes.
  // -------------------------------------------------------------------------
  app.use('/api/webapp/items', (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    next();
  });

  // -------------------------------------------------------------------------
  // GET /api/webapp/items
  // -------------------------------------------------------------------------
  app.get('/api/webapp/items', async (req: Request, res: Response) => {
    const auth = authenticateRequest(req, res, deps);
    if (!auth.ok) return;

    const { userId } = auth;
    const dataDir = resolveDataDir(deps.config);

    const typeRaw = req.query['type'];
    const statusRaw = req.query['status'] ?? 'active';
    const tagRaw = req.query['tag'];

    if (
      typeRaw !== undefined &&
      (typeof typeRaw !== 'string' ||
        (typeRaw !== 'all' && !VALID_TYPES.includes(typeRaw as OrganizeType)))
    ) {
      badRequest(res, `Invalid filter value: type=${String(typeRaw)}`);
      return;
    }
    if (
      typeof statusRaw !== 'string' ||
      !VALID_STATUSES.includes(statusRaw as OrganizeStatus | 'all')
    ) {
      badRequest(res, `Invalid filter value: status=${String(statusRaw)}`);
      return;
    }
    if (tagRaw !== undefined && typeof tagRaw !== 'string') {
      badRequest(res, 'Invalid filter value: tag must be string');
      return;
    }

    const filter: { status?: OrganizeStatus; type?: OrganizeType; tag?: string } = {};
    if (statusRaw !== 'all') filter.status = statusRaw as OrganizeStatus;
    if (typeRaw !== undefined && typeRaw !== 'all') filter.type = typeRaw as OrganizeType;
    if (typeof tagRaw === 'string' && tagRaw.length > 0) filter.tag = tagRaw;

    let items;
    try {
      items = await listItems(userId, dataDir, filter);
    } catch (err) {
      log.error(
        { userId, err: err instanceof Error ? err.message : String(err) },
        'listItems failed',
      );
      res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: 'Failed to read items' });
      return;
    }

    // v1.14.3 D6/SF-1: `parentId` added to LIST projection for client-side hierarchy grouping.
    // v1.14.3 D1: `updated` added for last-modified display.
    // Type-annotated as OrganizeListItem per W2/F4 carry-forward closure (RA3 KNOWN_ISSUES #7).
    const projected: OrganizeListItem[] = items.map((it) => ({
      id: it.frontMatter.id,
      type: it.frontMatter.type,
      status: it.frontMatter.status,
      title: it.frontMatter.title,
      due: it.frontMatter.due,
      tags: it.frontMatter.tags,
      created: it.frontMatter.created,
      hasNotes: it.notesBody.trim().length > 0,
      hasProgress: it.progressBody.trim().length > 0,
      calendarEventId: it.frontMatter.calendarEventId,
      parentId: it.frontMatter.parentId,
      updated: it.frontMatter.updated ?? null,
    }));

    res.status(200).json({
      ok: true,
      items: projected,
      total: projected.length,
      serverTime: new Date().toISOString(),
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/webapp/items/:id
  // -------------------------------------------------------------------------
  app.get('/api/webapp/items/:id', async (req: Request, res: Response) => {
    const auth = authenticateRequest(req, res, deps);
    if (!auth.ok) return;

    const { userId } = auth;
    const id = req.params['id'];

    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      id.length > 50 ||
      !ITEM_ID_RE.test(id)
    ) {
      badRequest(res, 'Invalid item id format');
      return;
    }

    const dataDir = resolveDataDir(deps.config);

    let item;
    try {
      item = await readItem(userId, dataDir, id);
    } catch (err) {
      log.error(
        { userId, id, err: err instanceof Error ? err.message : String(err) },
        'readItem failed',
      );
      res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: 'Failed to read item' });
      return;
    }

    if (item === null) {
      res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'Item not found' });
      return;
    }

    const fileBasename = item.filePath.split(/[/\\]/).pop() ?? `${id}.md`;

    // Fetch mtime for ETag fallback (used when item has no `updated:` front-matter field).
    let mtimeMs = 0;
    try {
      const fileStat = await stat(path.join(organizeUserDir(userId, dataDir), `${id}.md`));
      mtimeMs = fileStat.mtimeMs;
    } catch {
      // Non-fatal — mtimeMs stays 0; ETag falls back to epoch (legacy items get mtime=0 until first write).
    }

    const detail: OrganizeItemDetail = {
      id: item.frontMatter.id,
      type: item.frontMatter.type,
      status: item.frontMatter.status,
      title: item.frontMatter.title,
      created: item.frontMatter.created,
      due: item.frontMatter.due,
      parentId: item.frontMatter.parentId,
      calendarEventId: item.frontMatter.calendarEventId,
      tags: item.frontMatter.tags,
      notes: item.notesBody,
      progress: item.progressBody,
      fileBasename,
      mtimeMs,
      updated: item.frontMatter.updated ?? null,
      // v1.18.0 ADR 018 D1: normalize undefined → 'off' / 0 at wire boundary.
      coachIntensity: item.frontMatter.coachIntensity ?? 'off',
      coachNudgeCount: item.frontMatter.coachNudgeCount ?? 0,
    };

    // v1.14.4 D2: set ETag header on single-item GET (the canonical edit-baseline).
    // ETag format: "<iso>" — quotes are part of the value per RFC 7232.
    // Fallback to mtime ISO for legacy items with updated: null.
    const etag = computeETag(item.frontMatter, mtimeMs);
    res.setHeader(ETAG_HEADER, etag);

    res.status(200).json({ ok: true, item: detail, etag });
  });
}
