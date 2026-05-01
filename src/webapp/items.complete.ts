/**
 * Organize items COMPLETE route for the Telegram Web App (v1.14.5).
 *
 * Mounts:
 *   POST /api/webapp/items/:id/complete — status flip (done/active/abandoned logic)
 *
 * Extracted from items.mutate.ts (v1.14.5 R3 — Option B two-way split).
 * PATCH + DELETE remain in items.mutate.ts (cohesive: both share If-Match envelope,
 * 412 path, conflict-tracker plumbing). POST /complete is an absolute-write handler
 * with its own no-op fast-path and idempotent semantics — cleanly separable.
 *
 * Auth: shared chain via authenticateRequest() from items.shared.ts.
 * Audit: webapp.item_mutate per successful mutation.
 *
 * v1.14.4 R4 no-op fast-path: target state === current state → 200 no-write.
 * v1.14.4 D9 If-Match check: runs AFTER the no-op fast-path.
 * v1.14.2 R18 absolute-write semantic: done/active are explicit; toggle is secondary.
 */

import express, { type Express, type Request, type Response } from 'express';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { child } from '../logger/index.js';
import { resolveDataDir } from '../config/dataDir.js';
import { updateItem, readItem, organizeUserDir } from '../organize/storage.js';
import type { OrganizeFrontMatter, OrganizeItemDetail } from '../organize/types.js';
import { computeETag } from '../organize/etag.js';
import {
  ITEM_ID_RE,
  authenticateRequest,
  auditItemMutate,
  redactIp,
  conflictTracker,
  readIfMatchHeader,
  readIfMatchRaw,
  readForceOverride,
  type ItemsRouteDeps,
} from './items.shared.js';
import {
  ETAG_HEADER,
  PRECONDITION_FAILED_CODE,
} from './etag-headers.js';

const log = child({ component: 'webapp.itemsComplete' });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Project an OrganizeItem result to the OrganizeItemDetail wire shape. */
async function projectDetail(
  userId: number,
  dataDir: string,
  itemId: string,
  item: Awaited<ReturnType<typeof updateItem>>,
): Promise<OrganizeItemDetail> {
  const fileBasename = item.filePath.split(/[/\\]/).pop() ?? `${itemId}.md`;
  let mtimeMs = 0;
  try {
    const fileStat = await stat(path.join(organizeUserDir(userId, dataDir), `${itemId}.md`));
    mtimeMs = fileStat.mtimeMs;
  } catch {
    // Non-fatal — client's ETag will fall back to updated: field if mtime unavailable
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
    // v1.18.0 ADR 018 D1: normalize undefined → 'off' / 0 at wire boundary.
    coachIntensity: item.frontMatter.coachIntensity ?? 'off',
    coachNudgeCount: item.frontMatter.coachNudgeCount ?? 0,
  };
}

/**
 * Build metadata-only OrganizeItemDetail from a FrontMatter object (for 412 envelope).
 *
 * Per ADR 012 R1 Option A: the 412 envelope carries a metadata-only projection of
 * currentItem (id, title, type, due, status, tags, parentId, calendarEventId, createdAt,
 * updated, mtimeMs). notes/progress are NOT included — client issues a follow-up GET /:id
 * when it needs them (via the Reload button). This keeps the storage error payload bounded.
 */
function projectFrontMatterOnly(fm: OrganizeFrontMatter, fileMtimeMs: number): OrganizeItemDetail {
  return {
    id: fm.id,
    type: fm.type,
    status: fm.status,
    title: fm.title,
    created: fm.created,
    due: fm.due,
    parentId: fm.parentId,
    calendarEventId: fm.calendarEventId,
    tags: fm.tags,
    notes: '',
    progress: '',
    fileBasename: `${fm.id}.md`,
    mtimeMs: fileMtimeMs,
    updated: fm.updated ?? null,
    // v1.18.0 ADR 018 D1: normalize undefined → 'off' / 0 at wire boundary.
    coachIntensity: fm.coachIntensity ?? 'off',
    coachNudgeCount: fm.coachNudgeCount ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Route validation helper
// ---------------------------------------------------------------------------

/**
 * Validate :id path parameter. Returns the id string on success, or sends a
 * 400 response and returns null.
 */
function validateItemId(req: Request, res: Response): string | null {
  const id = req.params['id'];
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > 50 ||
    !ITEM_ID_RE.test(id)
  ) {
    res.status(400).json({ ok: false, code: 'BAD_REQUEST', error: 'Invalid item id format' });
    return null;
  }
  return id;
}

// ---------------------------------------------------------------------------
// Mount function
// ---------------------------------------------------------------------------

/**
 * Mount the POST /complete route on the given Express app.
 *
 * Called from the wiring site (itemsRoute.ts or server.ts) AFTER
 * mountItemsMutateRoutes() so the no-store Cache-Control middleware
 * registered by mountItemsReadRoutes() covers these responses too.
 */
export function mountItemsCompleteRoutes(app: Express, deps: ItemsRouteDeps): void {
  // -------------------------------------------------------------------------
  // POST /api/webapp/items/:id/complete
  // -------------------------------------------------------------------------
  app.post(
    '/api/webapp/items/:id/complete',
    express.json({ limit: '256b' }),
    async (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');

      const auth = authenticateRequest(req, res, deps);
      if (!auth.ok) return;
      const { userId } = auth;

      const id = validateItemId(req, res);
      if (id === null) return;

      const dataDir = resolveDataDir(deps.config);
      const ip = redactIp(req.ip ?? req.socket.remoteAddress ?? '0.0.0.0');

      // --- Parse body ---
      // Body is either { done: boolean } or empty (toggle-no-body path)
      const body = req.body as unknown;
      const hasBody = body !== null && typeof body === 'object' && Object.keys(body as object).length > 0;
      let doneExplicit: boolean | null = null; // null = no-body toggle path

      if (hasBody) {
        const bodyObj = body as Record<string, unknown>;
        if (typeof bodyObj['done'] !== 'boolean') {
          res.status(400).json({
            ok: false,
            code: 'BAD_REQUEST',
            error: 'Body must be {done: boolean} or empty.',
          });
          return;
        }
        doneExplicit = bodyObj['done'] as boolean;
      }

      // --- Read current item (needed for R4 no-op fast-path + toggle-no-body path + abandoned checks) ---
      let currentItem;
      try {
        currentItem = await readItem(userId, dataDir, id);
      } catch (err) {
        log.error(
          { userId, id, err: err instanceof Error ? err.message : String(err) },
          'readItem failed in POST /complete handler',
        );
        res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: 'Failed to read item' });
        return;
      }

      if (currentItem === null) {
        res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'Item not found' });
        return;
      }

      const currentStatus = currentItem.frontMatter.status;

      // --- Handle abandoned + no-body (R14): ambiguous — must be explicit ---
      if (doneExplicit === null && currentStatus === 'abandoned') {
        res.status(400).json({
          ok: false,
          code: 'AMBIGUOUS_TOGGLE',
          error: 'Toggle requires explicit done field for non-binary status. Send {done: true} or {done: false}.',
        });
        return;
      }

      // --- Determine target status (R18: absolute-write semantics) ---
      // doneExplicit === null → toggle-no-body path (only for active/done)
      // doneExplicit === true → always set to 'done'
      // doneExplicit === false → set to 'active' (even from abandoned per R14)
      //                          BUT: abandoned + done:false → no-op (R14)
      let targetStatus: 'done' | 'active' | null; // null = no-op (abandoned + done:false)
      let auditAction: 'complete' | 'uncomplete';

      if (doneExplicit === null) {
        // Toggle: active ↔ done (abandoned was rejected above)
        targetStatus = currentStatus === 'done' ? 'active' : 'done';
        auditAction = targetStatus === 'done' ? 'complete' : 'uncomplete';
      } else if (doneExplicit === true) {
        // Absolute: set done regardless of current (un-abandons + completes)
        targetStatus = 'done';
        auditAction = 'complete';
      } else {
        // doneExplicit === false
        if (currentStatus === 'abandoned') {
          // no-op per R14: abandoned + done:false stays abandoned
          targetStatus = null;
          auditAction = 'uncomplete';
        } else {
          targetStatus = 'active';
          auditAction = 'uncomplete';
        }
      }

      // --- R4 (CP1 v1.14.4 MEDIUM): no-op fast-path ---
      // If target state matches current, skip the write entirely:
      // no ETag check, no audit row, no storage write.
      // This handles: (a) abandoned + done:false (R14 no-op), and
      //               (b) idempotent calls where done:bool matches current status.
      const targetStatusForNoOp = targetStatus === null ? currentStatus :
        (targetStatus === 'done' ? 'done' : (targetStatus === 'active' ? 'active' : targetStatus));
      const isNoOp = targetStatus === null || targetStatusForNoOp === currentStatus;

      if (isNoOp) {
        // Return 200 with unchanged item + current ETag. No audit row.
        const fileBasename = currentItem.filePath.split(/[/\\]/).pop() ?? `${id}.md`;
        let mtimeMs = 0;
        try {
          const fileStat = await stat(path.join(organizeUserDir(userId, dataDir), `${id}.md`));
          mtimeMs = fileStat.mtimeMs;
        } catch { /* non-fatal */ }

        const noOpDetail: OrganizeItemDetail = {
          id: currentItem.frontMatter.id,
          type: currentItem.frontMatter.type,
          status: currentItem.frontMatter.status,
          title: currentItem.frontMatter.title,
          created: currentItem.frontMatter.created,
          due: currentItem.frontMatter.due,
          parentId: currentItem.frontMatter.parentId,
          calendarEventId: currentItem.frontMatter.calendarEventId,
          tags: currentItem.frontMatter.tags,
          notes: currentItem.notesBody,
          progress: currentItem.progressBody,
          fileBasename,
          mtimeMs,
          updated: currentItem.frontMatter.updated ?? null,
          // v1.18.0 ADR 018 D1: normalize undefined → 'off' / 0 at wire boundary.
          coachIntensity: currentItem.frontMatter.coachIntensity ?? 'off',
          coachNudgeCount: currentItem.frontMatter.coachNudgeCount ?? 0,
        };

        const currentEtag = computeETag(currentItem.frontMatter, mtimeMs);
        res.setHeader(ETAG_HEADER, currentEtag);
        log.info({ userId, itemId: id, targetStatus }, 'organize complete: no-op (current state matches target)');
        res.status(200).json({ ok: true, item: noOpDetail });
        return;
      }

      // --- Parse If-Match / X-Force-Override (v1.14.4 D3) ---
      const ifMatch = readIfMatchHeader(req);       // null for absent or '*' (skip-check semantics)
      const ifMatchRaw = readIfMatchRaw(req);       // literal wire value for audit (preserves '*' vs absent)
      const force = readForceOverride(req);

      // --- Determine effective If-Match (force-override skips the check) ---
      const effectiveEtag = force ? undefined : (ifMatch ?? undefined);

      // --- Apply absolute write (R18) ---
      let updatedItem;
      try {
        updatedItem = await updateItem(userId, dataDir, id, { status: targetStatus! }, { expectedEtag: effectiveEtag });
      } catch (err: unknown) {
        const anyErr = err as { code?: string; actualEtag?: string; currentFm?: OrganizeFrontMatter; currentMtimeMs?: number };
        if (anyErr?.code === 'ETAG_MISMATCH') {
          // R1: 412 envelope from the storage layer's same-read observation.
          conflictTracker.noteConflict(userId, id);
          const currentFm = anyErr.currentFm!;
          const currentMtimeMs = anyErr.currentMtimeMs ?? 0;
          const currentEtag = anyErr.actualEtag!;
          const currentItemProj = projectFrontMatterOnly(currentFm, currentMtimeMs);
          res.setHeader(ETAG_HEADER, currentEtag);
          res.status(412).json({
            ok: false,
            code: PRECONDITION_FAILED_CODE,
            error: 'Item changed since you opened it. Reload to see the latest, or use Save Anyway to overwrite.',
            currentEtag,
            currentItem: currentItemProj,
          });
          return;
        }
        if (anyErr?.code === 'ITEM_NOT_FOUND') {
          res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'Item not found' });
          return;
        }
        log.error(
          { userId, id, err: err instanceof Error ? err.message : String(err) },
          'updateItem failed in POST /complete handler',
        );
        res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: 'Failed to update item' });
        return;
      }

      // --- Set ETag on success response (D2) ---
      const item = await projectDetail(userId, dataDir, id, updatedItem);
      const newEtag = computeETag(updatedItem.frontMatter, item.mtimeMs);
      res.setHeader(ETAG_HEADER, newEtag);

      // --- Audit ---
      const bypassAfter412 = (force || !ifMatch) ? conflictTracker.hasRecentConflict(userId, id) : false;
      auditItemMutate(deps.memory, userId, id, auditAction, ['status'], ip, { etag: ifMatchRaw, forced: force, bypassAfter412 });

      res.status(200).json({ ok: true, item });
    },
  );
}
