/**
 * Organize items CREATE route for the Telegram Web App (v1.14.6).
 *
 * Mounts:
 *   POST /api/webapp/items — create a new organize item
 *
 * New file per v1.14.6 D17 + W6 (T-mount-create wire integrity).
 * Mirrors items.complete.ts structure (v1.14.5 R3 split precedent).
 *
 * Auth: shared chain via authenticateRequest() from items.shared.ts.
 * Validation: validateCreateBody() from organize/validation.ts (D8 + W4).
 * Audit: webapp.item_create per successful create (NOT debounced per D7).
 *
 * D17 contract:
 *   - Returns 201 Created (not 200) for new resource creation.
 *   - ETag header on response (auto-stamped updated: by createItem per v1.14.3 D1).
 *   - Idempotency: NO server-side dedup in v1.14.6 (client double-submit guard +
 *     AbortController R6 close it).
 *
 * parentId validation (v1.14.5 R1 BLOCKING invariant preserved):
 *   - parentExistsAndIsActiveGoal check mirrors PATCH parentId handler in items.mutate.ts.
 *   - NOT_FOUND / NOT_GOAL / NOT_ACTIVE → 400 with mapped code.
 *   - deletedAt race window handled identically to PATCH (softDeleteItem two-step).
 *
 * Body size cap: 32KB (matches PATCH for notes/progress headroom; D8.b adds progress).
 */

import express, { type Express, type Request, type Response } from 'express';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { child } from '../logger/index.js';
import { resolveDataDir } from '../config/dataDir.js';
import { createItem, organizeUserDir, parentExistsAndIsActiveGoal } from '../organize/storage.js';
import type { OrganizeItemDetail } from '../organize/types.js';
import { computeETag } from '../organize/etag.js';
import { validateCreateBody } from '../organize/validation.js';
import {
  authenticateRequest,
  redactIp,
  auditItemCreate,
  type ItemsRouteDeps,
} from './items.shared.js';
import {
  ETAG_HEADER,
} from './etag-headers.js';
import { cacheControlNoStore } from './items.shared.js';

const log = child({ component: 'webapp.itemsCreate' });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Project a newly created item to the OrganizeItemDetail wire shape. */
async function projectNewItem(
  userId: number,
  dataDir: string,
  itemId: string,
  item: Awaited<ReturnType<typeof createItem>>,
): Promise<OrganizeItemDetail> {
  const fileBasename = item.filePath.split(/[/\\]/).pop() ?? `${itemId}.md`;
  let mtimeMs = 0;
  try {
    const fileStat = await stat(path.join(organizeUserDir(userId, dataDir), `${itemId}.md`));
    mtimeMs = fileStat.mtimeMs;
  } catch {
    // Non-fatal — ETag falls back to updated: field if mtime unavailable.
  }

  return {
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
    // v1.18.0 ADR 018 D1: new items start with coachIntensity 'off' and 0 nudges.
    coachIntensity: item.frontMatter.coachIntensity ?? 'off',
    coachNudgeCount: item.frontMatter.coachNudgeCount ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Mount function
// ---------------------------------------------------------------------------

/**
 * Mount the POST /api/webapp/items route on the given Express app.
 *
 * Called from the wiring site (itemsRoute.ts) AFTER all other mounts so the
 * no-store Cache-Control middleware registered by mountItemsReadRoutes covers
 * these responses too. Also sets Cache-Control on each response explicitly.
 */
export function mountItemsCreateRoutes(app: Express, deps: ItemsRouteDeps): void {
  // Apply Cache-Control no-store to the /api/webapp/items prefix for this route too.
  app.use('/api/webapp/items', cacheControlNoStore);

  // -------------------------------------------------------------------------
  // POST /api/webapp/items
  // -------------------------------------------------------------------------
  app.post(
    '/api/webapp/items',
    express.json({ limit: '32kb' }),  // 32KB matches PATCH cap; notes (10KB) + progress (20KB) + headroom
    async (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');

      // 1. Auth chain
      const auth = authenticateRequest(req, res, deps);
      if (!auth.ok) return;
      const { userId } = auth;

      const dataDir = resolveDataDir(deps.config);
      const ip = redactIp(req.ip ?? req.socket.remoteAddress ?? '0.0.0.0');

      // 2. Body parse + validate
      const body = req.body as unknown;
      const validation = validateCreateBody(body);
      if (!validation.ok) {
        res.status(400).json({
          ok: false,
          code: validation.code,
          error: validation.error,
        });
        return;
      }
      const { input } = validation;

      // 3. parentId existence check (v1.14.5 R1 same-read invariant)
      //    Only needed when parentId is a non-null string.
      if (input.parentId != null) {
        let parentResult;
        try {
          parentResult = await parentExistsAndIsActiveGoal(userId, dataDir, input.parentId);
        } catch (err) {
          log.error(
            { userId, parentId: input.parentId, err: err instanceof Error ? err.message : String(err) },
            'parentExistsAndIsActiveGoal failed in POST /items create handler',
          );
          res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: 'Failed to verify parent item' });
          return;
        }

        if (!parentResult.ok) {
          // Map storage reason codes to HTTP 400 codes.
          const codeMap: Record<string, string> = {
            NOT_FOUND: 'PARENT_NOT_FOUND',
            NOT_GOAL: 'PARENT_NOT_GOAL',
            NOT_ACTIVE: 'PARENT_NOT_ACTIVE',
          };
          const httpCode = codeMap[parentResult.reason ?? ''] ?? 'PARENT_NOT_FOUND';
          res.status(400).json({
            ok: false,
            code: httpCode,
            error: `Parent item not found or not an active goal (reason: ${parentResult.reason}).`,
          });
          return;
        }
      }

      // 4. Create item
      let newItem;
      try {
        newItem = await createItem(userId, dataDir, {
          type: input.type,
          title: input.title,
          due: input.due ?? undefined,
          tags: input.tags,
          notes: input.notes,
          progress: input.progress,
          parentId: input.parentId ?? undefined,
        });
      } catch (err: unknown) {
        const anyErr = err as { code?: string };
        if (anyErr?.code === 'ID_COLLISION') {
          log.error({ userId }, 'createItem: ID collision after 5 attempts');
          res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: 'Failed to generate unique item id' });
          return;
        }
        log.error(
          { userId, err: err instanceof Error ? err.message : String(err) },
          'createItem failed in POST /items create handler',
        );
        res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: 'Failed to create item' });
        return;
      }

      // 5. Project + compute ETag from auto-stamped updated: (v1.14.3 D1)
      const item = await projectNewItem(userId, dataDir, newItem.frontMatter.id, newItem);
      const etag = computeETag(newItem.frontMatter, item.mtimeMs);

      // 6. Set ETag + emit audit
      res.setHeader(ETAG_HEADER, etag);
      auditItemCreate(
        deps,
        userId,
        newItem.frontMatter.id,
        newItem.frontMatter.type,
        input.parentId != null,
        ip,
      );

      // 7. Respond 201 Created (D17 — create returns 201, not 200)
      log.info({ userId, itemId: newItem.frontMatter.id, type: newItem.frontMatter.type }, 'webapp item created');
      res.status(201).json({ ok: true, item, etag });
    },
  );
}
