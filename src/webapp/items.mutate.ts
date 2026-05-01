/**
 * Organize items MUTATION routes for the Telegram Web App (v1.14.5).
 *
 * Mounts:
 *   PATCH  /api/webapp/items/:id           — partial update (title, due, status, tags, parentId)
 *   DELETE /api/webapp/items/:id           — soft-delete
 *
 * POST /api/webapp/items/:id/complete was extracted to items.complete.ts (v1.14.5 R3
 * Option B two-way split). PATCH + DELETE share the If-Match envelope, 412 path,
 * conflict-tracker plumbing, and storagePatch explicit-copy block — cohesive; kept together.
 *
 * Auth: shared chain via authenticateRequest() from items.shared.ts.
 * Validation: hand-rolled via validatePatchBody() from organize/validation.ts.
 * Audit: webapp.item_mutate per successful mutation.
 *
 * v1.14.5 changes:
 *   - parentId PATCH support (D1/D2/R1): PATCH handler accepts parentId field.
 *     Validator codes: PARENT_ID_INVALID_FORMAT, PARENT_ID_SELF_REFERENCE,
 *     PARENT_NOT_FOUND, PARENT_NOT_GOAL, PARENT_NOT_ACTIVE, GOAL_CANNOT_HAVE_PARENT.
 *     Existence check via parentExistsAndIsActiveGoal() from storage.ts (R1 BLOCKING:
 *     deletedAt filter mirrors v1.14.3 R7 listItems filter).
 *   - items.complete.ts split (R3 Option B): POST /complete removed from this file.
 *
 * v1.14.4 changes preserved:
 *   - R2-mtime sunset (D6): removed X-Captured-Mtime reading, staleWarning field, and
 *     auditStaleEdit emission. webapp.stale_edit category NOT emitted (schema kept for compat).
 *   - ETag / If-Match / 412 (D3/D4/R1): PATCH, DELETE all support required-when-present
 *     If-Match. Mismatch → 412 with currentEtag + currentItem.
 *   - Force-override (D5/R9): X-Force-Override: 1 skips If-Match check; audit forced: true.
 *   - R2 bypassAfter412: conflict tracker distinguishes intentional override from header-strip.
 *
 * R8 (BLOCKING v1.14.2): writeAtomically() uses per-call random tmp suffix — this route
 * relies on that fix being in place. See storage.ts JSDoc.
 *
 * RA2: storagePatch is ALWAYS constructed with explicit field copies — never spread from
 * req.body or from the validated patch. The storage layer's UpdateItemPatch is wider
 * (accepts notes, calendarEventId, parentId); only permitted fields pass through.
 */

import express, { type Express, type Request, type Response } from 'express';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { child } from '../logger/index.js';
import { resolveDataDir } from '../config/dataDir.js';
import { updateItem, softDeleteItem, readItemFrontMatter, organizeUserDir, parentExistsAndIsActiveGoal } from '../organize/storage.js';
import type { UpdateItemPatch } from '../organize/storage.js';
import type { OrganizeFrontMatter, OrganizeItemDetail } from '../organize/types.js';
import { validatePatchBody } from '../organize/validation.js';
import { computeETag } from '../organize/etag.js';
import {
  ITEM_ID_RE,
  authenticateRequest,
  badRequest,
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

const log = child({ component: 'webapp.itemsMutate' });

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
    badRequest(res, 'Invalid item id format');
    return null;
  }
  return id;
}

// ---------------------------------------------------------------------------
// Mount function
// ---------------------------------------------------------------------------

/**
 * Mount the mutation routes on the given Express app.
 *
 * Design note (server.ts): this function is called alongside
 * mountItemsReadRoutes(). The Cache-Control no-store middleware is registered
 * by mountItemsReadRoutes on the /api/webapp/items prefix and therefore applies
 * to mutation responses too (middleware registration order matters; read routes
 * MUST be mounted first or the Cache-Control middleware must be registered here
 * as well for safety). To be safe, this function also sets Cache-Control on
 * every outgoing mutation response explicitly in the route handlers.
 */
export function mountItemsMutateRoutes(app: Express, deps: ItemsRouteDeps): void {
  // -------------------------------------------------------------------------
  // PATCH /api/webapp/items/:id
  // -------------------------------------------------------------------------
  app.patch(
    '/api/webapp/items/:id',
    express.json({ limit: '32kb' }),  // v1.14.3 D4: raised from 1kb to accommodate notes (10KB) + progress (20KB)
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

      // --- Parse If-Match / X-Force-Override (v1.14.4 D3/D5) ---
      const ifMatch = readIfMatchHeader(req);       // null for absent or '*' (skip-check semantics)
      const ifMatchRaw = readIfMatchRaw(req);       // literal wire value for audit (preserves '*' vs absent)
      const force = readForceOverride(req);

      // --- Validate body ---
      const validationResult = validatePatchBody(req.body);
      if (!validationResult.ok) {
        res.status(400).json({
          ok: false,
          code: validationResult.code,
          error: validationResult.error,
        });
        return;
      }

      const validated = validationResult.patch;

      // --- Build storage patch (RA2: explicit field copy — NEVER spread) ---
      const storagePatch: UpdateItemPatch = {};
      if (validated.title !== undefined) storagePatch.title = validated.title;
      if (validated.due !== undefined) storagePatch.due = validated.due;
      if (validated.status !== undefined) storagePatch.status = validated.status;
      if (validated.tags !== undefined) storagePatch.tags = validated.tags;
      // v1.14.3 D2/D3: wire notes + progress through to storage layer.
      if (validated.notes !== undefined) storagePatch.notes = validated.notes;
      if (validated.progress !== undefined) storagePatch.progress = validated.progress;
      // v1.14.5 D1: parentId (string item-id, null = clear parent, absent = leave unchanged).
      if (validated.parentId !== undefined) storagePatch.parentId = validated.parentId;
      // v1.18.0 ADR 018 D1: coachIntensity — user-editable per-item coach dial.
      if (validated.coachIntensity !== undefined) storagePatch.coachIntensity = validated.coachIntensity;

      // --- v1.14.5 D1/D2 parentId route-level validation (after validator, before storage write) ---
      if (validated.parentId !== undefined) {
        // D2 call site: read current item's front-matter to check cross-type rule (D1 rule 3)
        // and the stale-abandoned leave-alone semantic (D4). One cheap front-matter read.
        const itemFilePath = path.join(organizeUserDir(userId, dataDir), `${id}.md`);
        const currentFm = await readItemFrontMatter(itemFilePath, id);

        if (currentFm === null) {
          // Item doesn't exist or is unreadable — updateItem will handle ITEM_NOT_FOUND.
          // Skip parentId checks; fall through to updateItem.
        } else {
          // D1 rule 3: goals cannot have parents.
          if (currentFm.type === 'goal' && validated.parentId !== null) {
            res.status(400).json({
              ok: false,
              code: 'GOAL_CANNOT_HAVE_PARENT',
              error: 'Goals cannot have a parent item.',
            });
            return;
          }

          if (validated.parentId !== null) {
            // D1 rule 2 (self-reference). Validator checks format; route handler checks identity.
            if (validated.parentId === id) {
              res.status(400).json({
                ok: false,
                code: 'PARENT_ID_SELF_REFERENCE',
                error: 'An item cannot be its own parent.',
              });
              return;
            }

            // D4 stale-abandoned leave-alone: if the value is identical to the current front-matter
            // parentId, the user is not changing the parent — skip the existence check even if the
            // current parent is abandoned. This allows "leave stale ref unchanged" without triggering
            // PARENT_NOT_ACTIVE. (The server only checks the active-goal rule for NEW reparentings.)
            const isLeaveAlone = validated.parentId === currentFm.parentId;

            if (!isLeaveAlone) {
              // D2 Option C: existence check via shared async helper.
              // TOCTOU note: parent could be trashed between this check and the updateItem write.
              // Hierarchy renderer treats orphaned children as top-level (v1.14.3 hierarchy.js);
              // the dangling reference is observable but not user-fatal. Accepted per ADR 013 D3.
              const ref = await parentExistsAndIsActiveGoal(userId, dataDir, validated.parentId);
              if (!ref.ok) {
                const code = ref.reason === 'NOT_FOUND' ? 'PARENT_NOT_FOUND'
                           : ref.reason === 'NOT_GOAL'  ? 'PARENT_NOT_GOAL'
                           : 'PARENT_NOT_ACTIVE';
                const messages: Record<string, string> = {
                  PARENT_NOT_FOUND: 'Parent item not found or has been deleted.',
                  PARENT_NOT_GOAL: 'Parent item must be a goal.',
                  PARENT_NOT_ACTIVE: 'Parent goal is abandoned. Reactivate it first, or choose a different parent.',
                };
                res.status(400).json({
                  ok: false,
                  code,
                  error: messages[code] ?? 'Invalid parent reference.',
                });
                return;
              }
            }
          }
        }
      }

      // --- Determine effective If-Match (force-override skips the check) ---
      const effectiveEtag = force ? undefined : (ifMatch ?? undefined);

      // --- Apply update ---
      let updated;
      try {
        updated = await updateItem(userId, dataDir, id, storagePatch, { expectedEtag: effectiveEtag });
      } catch (err: unknown) {
        const anyErr = err as { code?: string; actualEtag?: string; currentFm?: OrganizeFrontMatter; currentMtimeMs?: number };
        if (anyErr?.code === 'ETAG_MISMATCH') {
          // R1: build 412 envelope from THE SAME parsedFm the storage layer just observed.
          // NO re-read; NO re-stat.
          conflictTracker.noteConflict(userId, id);
          const currentFm = anyErr.currentFm!;
          const currentMtimeMs = anyErr.currentMtimeMs ?? 0;
          const currentEtag = anyErr.actualEtag!;
          const currentItem = projectFrontMatterOnly(currentFm, currentMtimeMs);
          res.setHeader(ETAG_HEADER, currentEtag);
          res.status(412).json({
            ok: false,
            code: PRECONDITION_FAILED_CODE,
            error: 'Item changed since you opened it. Reload to see the latest, or use Save Anyway to overwrite.',
            currentEtag,
            currentItem,
          });
          return;
        }
        if (anyErr?.code === 'ITEM_NOT_FOUND') {
          res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'Item not found' });
          return;
        }
        // v1.14.6 BK-12: EPERM/ENOENT signals the item file vanished mid-request —
        // most likely a concurrent DELETE that won the OS rename race (Windows) or
        // an unlink race (Linux). Map to 404 (resource is gone) rather than 500.
        if ((anyErr as NodeJS.ErrnoException)?.code === 'ENOENT' || (anyErr as NodeJS.ErrnoException)?.code === 'EPERM') {
          res.status(404).json({
            ok: false,
            code: 'NOT_FOUND',
            error: 'Item not found',
          });
          return;
        }
        log.error(
          { userId, id, err: err instanceof Error ? err.message : String(err) },
          'updateItem failed in PATCH handler',
        );
        res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: 'Failed to update item' });
        return;
      }

      // --- Set ETag on success response (D2) ---
      const item = await projectDetail(userId, dataDir, id, updated);
      const newEtag = computeETag(updated.frontMatter, item.mtimeMs);
      res.setHeader(ETAG_HEADER, newEtag);

      // --- Audit (successful mutations only, per decision 9) ---
      const bypassAfter412 = (force || !ifMatch) ? conflictTracker.hasRecentConflict(userId, id) : false;
      auditItemMutate(
        deps.memory,
        userId,
        id,
        'update',
        Object.keys(storagePatch),
        ip,
        { etag: ifMatchRaw, forced: force, bypassAfter412 },
      );

      res.status(200).json({ ok: true, item });
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /api/webapp/items/:id
  // -------------------------------------------------------------------------
  app.delete('/api/webapp/items/:id', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');

    const auth = authenticateRequest(req, res, deps);
    if (!auth.ok) return;
    const { userId } = auth;

    const id = validateItemId(req, res);
    if (id === null) return;

    const dataDir = resolveDataDir(deps.config);
    const ip = redactIp(req.ip ?? req.socket.remoteAddress ?? '0.0.0.0');

    // --- Parse If-Match / X-Force-Override (v1.14.4 D3/R9) ---
    const ifMatch = readIfMatchHeader(req);       // null for absent or '*' (skip-check semantics)
    const ifMatchRaw = readIfMatchRaw(req);       // literal wire value for audit (preserves '*' vs absent)
    const force = readForceOverride(req);

    // --- Determine effective If-Match (force-override skips the check) ---
    const effectiveEtag = force ? undefined : (ifMatch ?? undefined);

    try {
      await softDeleteItem(userId, dataDir, id, { expectedEtag: effectiveEtag });
    } catch (err: unknown) {
      const anyErr = err as { code?: string; actualEtag?: string; currentFm?: OrganizeFrontMatter; currentMtimeMs?: number };
      if (anyErr?.code === 'ETAG_MISMATCH') {
        // R1 + R9: 412 envelope for DELETE (same shape as PATCH 412).
        conflictTracker.noteConflict(userId, id);
        const currentFm = anyErr.currentFm!;
        const currentMtimeMs = anyErr.currentMtimeMs ?? 0;
        const currentEtag = anyErr.actualEtag!;
        const currentItem = projectFrontMatterOnly(currentFm, currentMtimeMs);
        res.setHeader(ETAG_HEADER, currentEtag);
        res.status(412).json({
          ok: false,
          code: PRECONDITION_FAILED_CODE,
          error: 'Item changed since you opened it. Reload to see the latest, or use Save Anyway to overwrite.',
          currentEtag,
          currentItem,
        });
        return;
      }
      if (anyErr?.code === 'ITEM_NOT_FOUND') {
        res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'Item not found' });
        return;
      }
      // v1.14.6 BK-12: EPERM/ENOENT signals the item file vanished mid-request —
      // concurrent DELETE already won the rename race, or Windows held a handle.
      // Map to 404 (resource is gone) rather than 500.
      if ((anyErr as NodeJS.ErrnoException)?.code === 'ENOENT' || (anyErr as NodeJS.ErrnoException)?.code === 'EPERM') {
        res.status(404).json({
          ok: false,
          code: 'NOT_FOUND',
          error: 'Item not found',
        });
        return;
      }
      log.error(
        { userId, id, err: err instanceof Error ? err.message : String(err) },
        'softDeleteItem failed in DELETE handler',
      );
      res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: 'Failed to delete item' });
      return;
    }

    // --- Audit ---
    const bypassAfter412 = (force || !ifMatch) ? conflictTracker.hasRecentConflict(userId, id) : false;
    auditItemMutate(deps.memory, userId, id, 'delete', [], ip, { etag: ifMatchRaw, forced: force, bypassAfter412 });

    res.status(200).json({ ok: true, deletedId: id });
  });
}
