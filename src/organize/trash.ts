/**
 * Trash-as-source-of-truth operations for /organize items (v1.14.6).
 *
 * Extracted from storage.ts (D1 + W1 from CP1 revisions, ADR 014 addendum).
 * This module owns all READ operations on the .trash/ directory:
 *   - listTrashedItems      — paginated listing (v1.14.5 D7)
 *   - evictExpiredTrash     — TTL-based hard-delete cron task (v1.11.0)
 *   - restoreItem           — atomic rename + deletedAt-strip (v1.14.3 D9)
 *   - findClosestTrashedIds — Levenshtein fuzzy match for smart-404 (v1.14.3 R5)
 *
 * NOT in this module (stay in storage.ts per W1 binding):
 *   - softDeleteItem   (writes TO trash; core CRUD; stays with CRUD primitives)
 *   - ensureTrashDir   (called by softDeleteItem in storage.ts; stays to avoid
 *                       the circular storage.ts → trash.ts import edge)
 *
 * Dependency edge: trash.ts → storage.ts (one-way only).
 * storage.ts does NOT import from trash.ts.
 *
 * Call-graph summary (all imports from storage.ts):
 *   listTrashedItems     → ensureTrashDir (removed — uses path directly), readItemFrontMatter, readItemFrontMatterFromPath
 *   evictExpiredTrash    → organizeUserDir, lstat/readdir/stat/unlink from node:fs/promises
 *   restoreItem          → ensureUserDir, ensureTrashDir, writeAtomically (via re-export), stampUpdated, serializeItem
 *   findClosestTrashedIds → organizeUserDir, readItemFrontMatterFromPath
 *
 * Note: listTrashedItems and evictExpiredTrash originally called ensureTrashDir
 * but were changed to use direct path construction + lstat/ENOENT guard — the same
 * defensive pattern — so that trash.ts does NOT need to import ensureTrashDir
 * from storage.ts at all. restoreItem DOES call ensureUserDir + ensureTrashDir from
 * storage.ts (correct: one-way edge preserved).
 */

import {
  readFile,
  rename,
  readdir,
  lstat,
  stat,
  unlink,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { child } from '../logger/index.js';
import { writeAtomically, serializeItem } from './_internals.js';
import {
  organizeUserDir,
  ensureUserDir,
  ensureTrashDir,
  readItemFrontMatter,
  readItemFrontMatterFromPath,
  stampUpdated,
  parseItemFileFromRaw,
  fireCalendarSyncFromTrash,
} from './storage.js';
import type { OrganizeFrontMatter, OrganizeItem, OrganizeType, OrganizeStatus } from './types.js';
import { levenshtein } from '../utils/levenshtein.js';

const log = child({ component: 'organize.trash' });

// writeAtomically + serializeItem imported from './_internals.js' (v1.15.0 D10).
// The previous local copies have been removed; _internals.ts is now the
// single source of truth for both helpers (Anti-Slop §5 / ADR 015 D10).

// ---------------------------------------------------------------------------
// listTrashedItems — v1.14.5 D7
// ---------------------------------------------------------------------------

export interface TrashedItemSummary {
  /** Base item id (collision suffix stripped: everything before '--' if present). */
  id: string;
  /** Full filename without .md — includes collision suffix for diagnostic use. */
  fileBasename: string;
  /** Front-matter title; '(unreadable)' on parse failure. */
  title: string;
  type: OrganizeType;
  /** ISO timestamp from front-matter; falls back to mtime ISO; '(unknown)' if neither. */
  deletedAt: string;
  /** Status pre-delete (from front-matter); 'active' fallback on parse failure. */
  originalStatus: OrganizeStatus;
}

/**
 * List trashed items for a user.
 *
 * Reads `data/organize/<userId>/.trash/`. Each .md file is parsed via the
 * existing tolerant parser. Parse failures are surfaced as `{title:"(unreadable)"}`
 * entries (not omitted — the user needs to know they exist).
 *
 * Sorted: deletedAt desc; ties broken by fileBasename ascending.
 *
 * @param options.limit  Max entries per page (default 50; cap 50).
 * @param options.offset Number of entries to skip (default 0).
 */
export async function listTrashedItems(
  userId: number,
  dataDir: string,
  options?: { limit?: number; offset?: number },
): Promise<{ items: TrashedItemSummary[]; total: number }> {
  const trashDir = path.join(organizeUserDir(userId, dataDir), '.trash');
  if (!existsSync(trashDir)) return { items: [], total: 0 };

  // 1. Read filenames (don't open contents yet)
  let filenames: string[];
  try {
    filenames = await readdir(trashDir);
  } catch {
    return { items: [], total: 0 };
  }
  const mdFiles = filenames.filter((n) => n.endsWith('.md'));

  // 2. For each file, stat for mtime (cheap — needed for sort on legacy files) + derive baseId
  const filesWithMeta = await Promise.all(
    mdFiles.map(async (name) => {
      const full = path.join(trashDir, name);
      let mtimeMs = 0;
      try {
        const st = await stat(full);
        mtimeMs = st.mtimeMs;
      } catch { /* non-fatal: mtime unavailable → fallback to 0 */ }
      // Collision suffix: <id>--<unix>-<hex>.md → base id is everything before '--'
      const basename = name.slice(0, -3); // strip .md
      const dashDashIdx = basename.indexOf('--');
      const baseId = dashDashIdx !== -1 ? basename.slice(0, dashDashIdx) : basename;
      return { name, basename, full, baseId, mtimeMs };
    }),
  );

  // 3. Parse front-matter for each file to get deletedAt (used as primary sort key)
  const enriched: Array<{
    name: string;
    basename: string;
    full: string;
    baseId: string;
    mtimeMs: number;
    fm: OrganizeFrontMatter | null;
  }> = await Promise.all(
    filesWithMeta.map(async (f) => {
      const fm = await readItemFrontMatter(f.full, f.baseId);
      return { ...f, fm };
    }),
  );

  // 4. Sort by deletedAt desc (primary); ties broken by fileBasename ascending (deterministic fallback)
  enriched.sort((a, b) => {
    const aMs = a.fm?.deletedAt ? new Date(a.fm.deletedAt).getTime() : a.mtimeMs;
    const bMs = b.fm?.deletedAt ? new Date(b.fm.deletedAt).getTime() : b.mtimeMs;
    if (bMs !== aMs) return bMs - aMs; // desc
    return a.basename.localeCompare(b.basename); // deterministic tie-break
  });

  const total = enriched.length;

  // 5. Slice limit + offset BEFORE building summaries
  const limit = Math.max(1, Math.min(options?.limit ?? 50, 50));
  const offset = Math.max(0, options?.offset ?? 0);
  const slice = enriched.slice(offset, offset + limit);

  // 6. Build TrashedItemSummary for the slice
  const items: TrashedItemSummary[] = slice.map((f) => {
    if (f.fm === null) {
      // Parse failure — tolerant: surface as (unreadable) entry
      const deletedAt = f.mtimeMs > 0 ? new Date(f.mtimeMs).toISOString() : '(unknown)';
      return {
        id: f.baseId,
        fileBasename: f.basename,
        title: '(unreadable)',
        type: 'task' as OrganizeType,
        deletedAt,
        originalStatus: 'active' as OrganizeStatus,
      };
    }
    const deletedAt = f.fm.deletedAt ?? new Date(f.mtimeMs).toISOString();
    return {
      id: f.baseId,
      fileBasename: f.basename,
      title: f.fm.title,
      type: f.fm.type,
      deletedAt,
      originalStatus: f.fm.status,
    };
  });

  return { items, total };
}

// ---------------------------------------------------------------------------
// evictExpiredTrash — v1.11.0
// ---------------------------------------------------------------------------

export type EvictErrorCode = 'READ_FAILED' | 'STAT_FAILED' | 'UNLINK_FAILED' | 'PARSE_FAILED';

export interface EvictResult {
  evicted: number;
  filesScanned: number;
  errors: Array<{ path: string; err: { code: EvictErrorCode; message: string } }>;
}

/**
 * Hard-delete trashed items for a user whose age exceeds ttlDays.
 *
 * Age source priority:
 *   1. Parsed front-matter deletedAt (new in v1.11.0)
 *   2. fs.stat(path).mtime (legacy fallback for pre-v1.11.0 trash with no deletedAt).
 *
 * Idempotent: running twice back-to-back produces no second eviction.
 * Tolerant: per-file errors are recorded and processing continues; function never throws.
 */
export async function evictExpiredTrash(
  userId: number,
  dataDir: string,
  ttlDays: number,
  now: Date = new Date(),
): Promise<EvictResult> {
  const userDir = organizeUserDir(userId, dataDir);
  const trashDir = path.join(userDir, '.trash');

  // v1.11.0 QA L1 — defense-in-depth: .trash/ must be a plain directory, not a symlink.
  try {
    const st = await lstat(trashDir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      log.warn({ userId, trashDir }, 'evictExpiredTrash: .trash/ is not a plain directory, skipping');
      return { evicted: 0, filesScanned: 0, errors: [] };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { evicted: 0, filesScanned: 0, errors: [] }; // no trash dir yet
    }
    throw err;
  }

  let entries: string[];
  try {
    entries = await readdir(trashDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { evicted: 0, filesScanned: 0, errors: [] };
    }
    return {
      evicted: 0,
      filesScanned: 0,
      errors: [{ path: trashDir, err: { code: 'READ_FAILED', message } }],
    };
  }

  const mdFiles = entries.filter((e) => e.endsWith('.md'));
  const nowMs = now.getTime();
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;

  let evicted = 0;
  const errors: EvictResult['errors'] = [];

  for (const file of mdFiles) {
    const filePath = path.join(trashDir, file);
    const itemId = file.endsWith('.md') ? file.slice(0, -3) : file;

    // Attempt to parse deletedAt from front-matter.
    let ageMs: number | null = null;
    let parseError = false;

    try {
      const raw = await readFile(filePath, 'utf8');
      const outcome = parseItemFileFromRaw(raw, itemId);
      if (outcome.ok && outcome.result.fm.deletedAt != null) {
        const deletedAtMs = new Date(outcome.result.fm.deletedAt).getTime();
        if (!Number.isNaN(deletedAtMs)) {
          ageMs = nowMs - deletedAtMs;
        }
      } else if (!outcome.ok) {
        parseError = true;
        errors.push({
          path: filePath,
          err: { code: 'PARSE_FAILED', message: `parseItemFile failed: ${JSON.stringify(outcome.error)}` },
        });
        log.warn({ userId, itemId, code: 'PARSE_FAILED', message: 'parseItemFile failed for trash item; falling back to mtime' }, 'trash evictor per-file error');
      }
    } catch (readErr) {
      const message = readErr instanceof Error ? readErr.message : String(readErr);
      if ((readErr as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      errors.push({ path: filePath, err: { code: 'READ_FAILED', message } });
      log.warn({ userId, itemId, code: 'READ_FAILED', message }, 'trash evictor per-file error');
      // Fall through to mtime fallback below.
    }

    // Mtime fallback: no deletedAt parsed (new file without the field, or parse failed).
    if (ageMs === null) {
      try {
        const st = await stat(filePath);
        ageMs = nowMs - st.mtimeMs;
      } catch (statErr) {
        if ((statErr as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }
        const message = statErr instanceof Error ? statErr.message : String(statErr);
        if (!parseError) {
          errors.push({ path: filePath, err: { code: 'STAT_FAILED', message } });
          log.warn({ userId, itemId, code: 'STAT_FAILED', message }, 'trash evictor per-file error');
        }
        continue;
      }
    }

    // Check TTL.
    if (ageMs < ttlMs) {
      continue;
    }

    // Evict.
    try {
      await unlink(filePath);
      evicted++;
    } catch (unlinkErr) {
      if ((unlinkErr as NodeJS.ErrnoException).code === 'ENOENT') {
        evicted++;
        continue;
      }
      const message = unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr);
      errors.push({ path: filePath, err: { code: 'UNLINK_FAILED', message } });
      log.warn({ userId, itemId, code: 'UNLINK_FAILED', message }, 'trash evictor per-file error');
    }
  }

  return { evicted, filesScanned: mdFiles.length, errors };
}

// ---------------------------------------------------------------------------
// restoreItem — v1.14.3 D9 + RA1 rename-first pattern
// ---------------------------------------------------------------------------

/**
 * Restore a soft-deleted item: atomic rename from .trash/<id>.md back to <id>.md,
 * then strip deletedAt and stamp fresh updated: via a separate atomic write.
 *
 * v1.14.3 RA1 from CP1: pattern symmetric with softDeleteItem (rename-first).
 *
 * Throws:
 *   - ITEM_NOT_FOUND_IN_TRASH if .trash/<id>.md doesn't exist and <id>.md also doesn't.
 *   - ITEM_ALREADY_LIVE if <id>.md exists in the live dir AND the trash file also exists.
 *   - FILE_WRITE_FAILED for atomic-write failures during the deletedAt strip.
 *
 * @returns the restored OrganizeItem (with the new updated:).
 */
export async function restoreItem(
  userId: number,
  dataDir: string,
  itemId: string,
): Promise<OrganizeItem> {
  await ensureUserDir(userId, dataDir);
  await ensureTrashDir(userId, dataDir);
  const liveDir = organizeUserDir(userId, dataDir);
  const trashPath = path.join(liveDir, '.trash', `${itemId}.md`);
  const livePath = path.join(liveDir, `${itemId}.md`);

  const trashExists = existsSync(trashPath);
  const liveExists = existsSync(livePath);

  if (!trashExists && !liveExists) {
    throw Object.assign(
      new Error(`Item not in trash: ${itemId}`),
      { code: 'ITEM_NOT_FOUND_IN_TRASH' },
    );
  }
  if (liveExists && trashExists) {
    throw Object.assign(
      new Error(`Item exists in both live and trash: ${itemId}`),
      { code: 'ITEM_ALREADY_LIVE' },
    );
  }

  // Step 1: atomic rename trash → live (skip if step-2-only recovery path)
  if (trashExists) {
    await rename(trashPath, livePath);
  }

  // Step 2: read, strip deletedAt, stamp updated, atomic write
  let raw: string;
  try {
    raw = await readFile(livePath, 'utf8');
  } catch (err) {
    throw Object.assign(
      new Error(`restoreItem: failed to read live file after rename: ${err instanceof Error ? err.message : String(err)}`),
      { code: 'FILE_WRITE_FAILED' },
    );
  }

  const outcome = parseItemFileFromRaw(raw, itemId);
  if (!outcome.ok) {
    throw Object.assign(
      new Error(`Restored item is malformed: ${itemId}`),
      { code: 'ITEM_MALFORMED' },
    );
  }

  const { fm: parsedFm, notesBody, progressBody } = outcome.result;
  // Strip deletedAt and stamp a fresh updated:.
  const fm = stampUpdated({ ...parsedFm, deletedAt: null });
  fm.id = itemId; // normalize to filename (R7)

  const content = serializeItem(fm, notesBody, progressBody);
  try {
    await writeAtomically(livePath, content);
  } catch (err) {
    throw Object.assign(
      new Error(`restoreItem: atomic write of deletedAt-strip failed: ${err instanceof Error ? err.message : String(err)}`),
      { code: 'FILE_WRITE_FAILED' },
    );
  }

  log.info({ userId, itemId }, 'organize item restored');

  const restoredItem = { frontMatter: fm, notesBody, progressBody, filePath: livePath };

  // v1.19.0 ADR 019 D4: fire-and-forget calendar sync callback after restore.
  fireCalendarSyncFromTrash(userId, restoredItem);

  return restoredItem;
}

// ---------------------------------------------------------------------------
// findClosestTrashedIds — v1.14.3 R5 (relocated from commands/organize.ts)
// ---------------------------------------------------------------------------

/**
 * Find the closest matching item ids in .trash/ using Levenshtein distance.
 * Returns up to 3 matches with distance ≤ 4, with their titles.
 * Relocated from commands/organize.ts (D1) so the trash module owns all
 * trash-directory READ operations.
 */
export async function findClosestTrashedIds(
  userId: number,
  dataDir: string,
  target: string,
): Promise<Array<{ id: string; title: string }>> {
  const trashDir = path.join(organizeUserDir(userId, dataDir), '.trash');
  if (!existsSync(trashDir)) return [];

  let entries: string[];
  try {
    entries = await readdir(trashDir);
  } catch {
    return [];
  }

  const ids = entries.filter((e) => e.endsWith('.md')).map((e) => e.slice(0, -3));
  const scored = ids.map((id) => ({ id, distance: levenshtein(target, id) }));
  scored.sort((a, b) => a.distance - b.distance);
  const top3 = scored.slice(0, 3).filter((s) => s.distance <= 4);

  const enriched = await Promise.all(
    top3.map(async ({ id }) => {
      try {
        const trashPath = path.join(trashDir, `${id}.md`);
        const fm = await readItemFrontMatterFromPath(trashPath);
        return { id, title: fm?.title ?? id };
      } catch {
        return { id, title: '(unreadable)' };
      }
    }),
  );

  return enriched;
}

// Re-export types that consumers of the old storage.ts import path may need.
export type { TrashedItemSummary as TrashItem };
