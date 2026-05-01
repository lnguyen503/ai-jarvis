/**
 * On-disk CRUD for /organize items (v1.8.6).
 *
 * Storage layout: data/organize/<userId>/<itemId>.md
 * Soft-delete:    data/organize/<userId>/.trash/<itemId>.md
 *
 * Design decisions:
 *   - Atomic writes via temp-then-rename (mirrors userMemory.writeAtomically).
 *   - Tolerant parsing: missing fence, non-ISO due, unknown type, BOM, CRLF all handled.
 *   - Filename is authoritative for identity (R7): front-matter id disagrees → log + normalize.
 *   - UserId path defense: Math.abs(Math.floor(Number(userId))), zero/NaN throws.
 *   - Symlink defense: ensureUserDir + ensureTrashDir throw on symlink (R6).
 *   - All dates in UTC (R12): new Date().toISOString() only.
 *   - No js-yaml, no uuid, no date libraries. node:fs/promises + node:crypto only.
 *
 * v1.15.0 D10: writeAtomically + serializeItem moved to _internals.ts (Anti-Slop §5
 * single-source-of-truth; storage.ts and trash.ts both import from there).
 */

import {
  readFile,
  rename,
  mkdir,
  readdir,
  lstat,
  stat,
} from 'node:fs/promises';
import { computeETag, etagsMatch } from './etag.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { child } from '../logger/index.js';
import { writeAtomically, serializeItem } from './_internals.js';
import type { OrganizeFrontMatter, OrganizeItem, OrganizeType, OrganizeStatus, OrganizeListItem } from './types.js';
import { isCoachIntensity } from '../coach/intensityTypes.js';

const log = child({ component: 'organize.storage' });

// ---------------------------------------------------------------------------
// v1.19.0 ADR 019 D4 — Calendar sync callbacks (fire-and-forget post-write hooks)
//
// These callbacks are registered at boot in src/index.ts by the calendar sync
// module. organize/storage.ts holds ONLY a generic callback pointer — it does
// NOT import from src/calendar/**. This preserves the one-way edge invariant
// (ADR 019 D14): calendar is downstream of organize; organize never imports calendar.
//
// Pattern is identical to the v1.18.0 trash-evictor pattern.
// ---------------------------------------------------------------------------

/** Type for the post-write calendar sync callback. */
export type CalendarSyncCallback = (userId: number, item: OrganizeItem) => void;
/** Type for the post-delete calendar remove callback. */
export type CalendarRemoveCallback = (userId: number, itemId: string) => void;

let _calendarSyncCallback: CalendarSyncCallback | null = null;
let _calendarRemoveCallback: CalendarRemoveCallback | null = null;

/**
 * Register the calendar sync callback (called at boot from src/index.ts).
 * Fires after every createItem / updateItem / restoreItem write.
 */
export function registerCalendarSyncCallback(cb: CalendarSyncCallback): void {
  _calendarSyncCallback = cb;
}

/**
 * Register the calendar remove callback (called at boot from src/index.ts).
 * Fires after softDeleteItem renames the item to .trash.
 */
export function registerCalendarRemoveCallback(cb: CalendarRemoveCallback): void {
  _calendarRemoveCallback = cb;
}

// ---------------------------------------------------------------------------
// v1.20.0 ADR 020 D6.a — Item-state monitor callback (fire-and-forget post-write hook)
//
// Registered at boot from src/index.ts via registerItemStateMonitorCallback().
// organize/storage.ts holds ONLY a generic callback pointer — does NOT import
// from src/coach/**. Preserves the one-way edge invariant (ADR 020 D16):
// coach is downstream of organize; organize never imports coach.
// ---------------------------------------------------------------------------

/** Type for the post-write item-state monitor callback. */
export type ItemStateMonitorCallback = (userId: number, item: OrganizeItem) => void;

let _itemStateMonitorCallback: ItemStateMonitorCallback | null = null;

/**
 * Register the item-state monitor callback (called at boot from src/index.ts).
 * Fires after every createItem / updateItem write.
 * ADR 020 D17 boot-wiring lint asserts this is NOT registered with a stub.
 */
export function registerItemStateMonitorCallback(cb: ItemStateMonitorCallback): void {
  _itemStateMonitorCallback = cb;
}

/** Internal: fire the item-state monitor callback fire-and-forget. */
function _fireItemStateMonitor(userId: number, item: OrganizeItem): void {
  if (_itemStateMonitorCallback) {
    Promise.resolve()
      .then(() => _itemStateMonitorCallback!(userId, item))
      .catch((err: unknown) => {
        log.warn(
          {
            userId,
            itemId: item.frontMatter.id,
            err: err instanceof Error ? err.message : String(err),
          },
          'item-state monitor callback rejected',
        );
      });
  }
}

/** Internal: fire the sync callback fire-and-forget (ADR 019 D4 posture). */
function _fireCalendarSync(userId: number, item: OrganizeItem): void {
  if (_calendarSyncCallback) {
    Promise.resolve()
      .then(() => _calendarSyncCallback!(userId, item))
      .catch((err: unknown) => {
        log.warn(
          { userId, itemId: item.frontMatter.id, err: err instanceof Error ? err.message : String(err) },
          'calendar sync callback rejected',
        );
      });
  }
}

/** Internal: fire the remove callback fire-and-forget. */
function _fireCalendarRemove(userId: number, itemId: string): void {
  if (_calendarRemoveCallback) {
    Promise.resolve()
      .then(() => _calendarRemoveCallback!(userId, itemId))
      .catch((err: unknown) => {
        log.warn(
          { userId, itemId, err: err instanceof Error ? err.message : String(err) },
          'calendar remove callback rejected',
        );
      });
  }
}

/**
 * Exported shim for trash.ts → restoreItem to fire the calendar sync callback.
 * trash.ts cannot call _fireCalendarSync directly (private function), so this
 * exported wrapper allows it without exposing the raw callback pointer.
 */
export function fireCalendarSyncFromTrash(userId: number, item: OrganizeItem): void {
  _fireCalendarSync(userId, item);
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Returns the absolute path to the user's organize directory.
 * Defensive: collapses userId to a safe non-negative integer; throws on 0 or NaN.
 */
export function organizeUserDir(userId: number, dataDir: string): string {
  const safeId = Math.abs(Math.floor(Number(userId)));
  if (!Number.isFinite(safeId) || safeId === 0) {
    throw new Error(`Invalid userId for organize path: ${userId}`);
  }
  return path.resolve(dataDir, 'organize', String(safeId));
}

/**
 * Ensures the user's organize directory exists and is a plain directory.
 * Throws with code ORGANIZE_USER_DIR_SYMLINK if it exists but is a symlink.
 */
export async function ensureUserDir(userId: number, dataDir: string): Promise<string> {
  const dir = organizeUserDir(userId, dataDir);
  if (existsSync(dir)) {
    const st = await lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw Object.assign(
        new Error(`organize user dir is not a plain directory: ${dir}`),
        { code: 'ORGANIZE_USER_DIR_SYMLINK' },
      );
    }
  } else {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

/**
 * Ensures the .trash/ subdirectory exists and is a plain directory.
 * Throws with code ORGANIZE_TRASH_INVALID if it exists but is a symlink or non-directory.
 *
 * Exported so trash.ts can call it without creating a reverse edge (W1 binding,
 * ADR 014 revisions). trash.ts → storage.ts is the only permitted import direction.
 */
export async function ensureTrashDir(userId: number, dataDir: string): Promise<string> {
  const dir = organizeUserDir(userId, dataDir);
  const trashDir = path.join(dir, '.trash');
  if (existsSync(trashDir)) {
    const st = await lstat(trashDir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw Object.assign(
        new Error(`organize .trash/ is not a plain directory: ${trashDir}`),
        { code: 'ORGANIZE_TRASH_INVALID' },
      );
    }
  } else {
    await mkdir(trashDir, { recursive: true });
  }
  return trashDir;
}

// ---------------------------------------------------------------------------
// Id generation
// ---------------------------------------------------------------------------

/**
 * Generates an item id in the format YYYY-MM-DD-xxxx.
 * Uses UTC date (R12). Random suffix uses node:crypto.randomBytes.
 * Alphabet: a-z0-9 minus confusable chars (0, O, 1, l, I removed).
 * Actually per ADR 003 §9: "4 lowercase alphanumerics [a-z0-9]{4}" — we keep the
 * full a-z0-9 alphabet (36^4 ≈ 1.7M) per the ADR decision, noting the
 * confusable-avoidance was a "suggestion" not a final decision.
 */
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ID_SUFFIX_LENGTH = 4;

export function generateItemId(date: Date = new Date()): string {
  const datePart = date.toISOString().slice(0, 10); // UTC YYYY-MM-DD
  const bytes = randomBytes(ID_SUFFIX_LENGTH);
  let suffix = '';
  for (let i = 0; i < ID_SUFFIX_LENGTH; i++) {
    const byte = bytes[i];
    if (byte === undefined) throw new Error('randomBytes returned insufficient bytes');
    suffix += ID_ALPHABET[byte % ID_ALPHABET.length];
  }
  return `${datePart}-${suffix}`;
}

// ---------------------------------------------------------------------------
// File path helper
// ---------------------------------------------------------------------------

function itemFilePath(userId: number, dataDir: string, itemId: string): string {
  return path.join(organizeUserDir(userId, dataDir), `${itemId}.md`);
}

// serializeItem imported from './_internals.js' (v1.15.0 D10 extraction).

// ---------------------------------------------------------------------------
// Tolerant parser
// ---------------------------------------------------------------------------

interface ParseResult {
  fm: OrganizeFrontMatter;
  notesBody: string;
  progressBody: string;
  /** True if the filename id was used (overrides front-matter id). */
  filenameIdUsed: boolean;
}

type ParseError =
  | { kind: 'missing_fence' }
  | { kind: 'invalid_type'; value: string }
  | { kind: 'missing_required'; fields: string[] };

type ParseOutcome =
  | { ok: true; result: ParseResult }
  | { ok: false; error: ParseError };

/**
 * Parse a raw .md file content. Filename id is authoritative (R7).
 * Strips UTF-16 BOM. Normalizes CRLF to LF.
 */
function parseItemFile(content: string, filenameId: string): ParseOutcome {
  // Strip BOM if present.
  let normalized = content.startsWith('﻿') ? content.slice(1) : content;
  // Normalize CRLF to LF.
  normalized = normalized.replace(/\r\n/g, '\n');

  // Front-matter: bounded by ^--- lines.
  if (!normalized.startsWith('---\n')) {
    return { ok: false, error: { kind: 'missing_fence' } };
  }
  const closeIdx = normalized.indexOf('\n---\n', 4);
  if (closeIdx === -1) {
    return { ok: false, error: { kind: 'missing_fence' } };
  }

  const fmRaw = normalized.slice(4, closeIdx);
  const bodyRaw = normalized.slice(closeIdx + 5); // after closing ---\n

  // Parse key: value lines.
  const kv: Record<string, string> = {};
  for (const line of fmRaw.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    kv[key] = value;
  }

  // Required fields.
  const required = ['type', 'status', 'title', 'created'] as const;
  const missing: string[] = [];
  for (const f of required) {
    if (!kv[f] || kv[f]!.trim() === '') missing.push(f);
  }
  if (missing.length > 0) {
    return { ok: false, error: { kind: 'missing_required', fields: missing } };
  }

  // Type validation.
  const rawType = kv['type']!.trim();
  if (rawType !== 'task' && rawType !== 'event' && rawType !== 'goal') {
    return { ok: false, error: { kind: 'invalid_type', value: rawType } };
  }

  // Due — tolerate non-ISO.
  const rawDue = kv['due']?.trim() ?? '';
  const due = rawDue.length > 0 ? rawDue : null;

  // deletedAt — v1.11.0 R3. Missing or empty → null. Malformed ISO tolerated (same posture as due).
  const rawDeletedAt = kv['deletedAt']?.trim() ?? '';
  const deletedAt = rawDeletedAt.length > 0 ? rawDeletedAt : null;

  // updated — v1.14.3 D1. Missing or empty → null (legacy items). Valid ISO → string.
  const rawUpdated = kv['updated']?.trim() ?? '';
  const updated = rawUpdated.length > 0 ? rawUpdated : null;

  // Tags — parse flow-sequence [a, b, c].
  const rawTags = kv['tags']?.trim() ?? '[]';
  const tags = parseTags(rawTags);

  // Front-matter id vs filename id (R7).
  const fmId = kv['id']?.trim() ?? '';
  let filenameIdUsed = false;
  let resolvedId = fmId;
  if (fmId !== filenameId) {
    log.warn(
      { filenameId, fmId },
      'organize item: filename id does not match front-matter id; filename wins',
    );
    resolvedId = filenameId;
    filenameIdUsed = true;
  }

  // Status must be valid.
  const rawStatus = kv['status']!.trim();
  let status: OrganizeStatus = 'active';
  if (rawStatus === 'active' || rawStatus === 'done' || rawStatus === 'abandoned') {
    status = rawStatus;
  }

  // coachIntensity — v1.18.0 ADR 018 D1 + v1.19.0 D1.
  // v1.19.0 D1: 'auto' default; explicit 'off' preserved per opt-out.
  //   Missing or invalid field → 'auto' (back-compat: old items without the field are now
  //   auto-coached instead of silently ignored). Items with explicit 'off' stay 'off' —
  //   the user opted out; do NOT silently re-engage.
  const rawCoachIntensity = kv['coachIntensity']?.trim() ?? '';
  const coachIntensity: import('../coach/intensityTypes.js').CoachIntensity =
    isCoachIntensity(rawCoachIntensity) ? rawCoachIntensity : 'auto';

  // coachNudgeCount — v1.18.0 ADR 018 D1. Missing or non-integer → undefined (caller treats as 0).
  const rawCoachNudgeCount = kv['coachNudgeCount']?.trim() ?? '';
  const parsedNudgeCount = rawCoachNudgeCount.length > 0 ? parseInt(rawCoachNudgeCount, 10) : NaN;
  const coachNudgeCount = Number.isInteger(parsedNudgeCount) && parsedNudgeCount >= 0
    ? parsedNudgeCount
    : undefined;

  const fm: OrganizeFrontMatter = {
    id: resolvedId,
    type: rawType as OrganizeType,
    status,
    title: kv['title']!.trim(),
    created: kv['created']!.trim(),
    due,
    parentId: (kv['parentId']?.trim() || null),
    calendarEventId: (kv['calendarEventId']?.trim() || null),
    deletedAt,
    updated,
    tags,
    coachIntensity, // v1.19.0 D1: always set ('auto' for missing/invalid fields; 'off' preserved)
    ...(coachNudgeCount !== undefined ? { coachNudgeCount } : {}),
  };

  // Extract body sections.
  const { notesBody, progressBody } = extractBodySections(bodyRaw);

  return { ok: true, result: { fm, notesBody, progressBody, filenameIdUsed } };
}

function parseTags(raw: string): string[] {
  // Expects [a, b, c] or [] shape.
  const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
  if (inner.length === 0) return [];
  return inner.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
}

/**
 * Public wrapper around `parseItemFile` for callers in sibling modules
 * (trash.ts) that need to parse raw file content without going through
 * the full readItem path. Signature mirrors ParseOutcome.
 *
 * W1 binding (ADR 014 revisions): trash.ts calls this via the one-way
 * trash.ts → storage.ts edge; storage.ts does NOT import from trash.ts.
 */
export function parseItemFileFromRaw(
  content: string,
  filenameId: string,
): ParseOutcome {
  return parseItemFile(content, filenameId);
}

/**
 * Extract ## Notes and ## Progress sections from the body text.
 * Content outside the two H2 landmarks is preserved verbatim (ADR 003 §8).
 *
 * Uses a simple line-by-line state machine. This is robust across all edge
 * cases: no trailing content cut-off, no regex look-ahead limitations.
 */
function extractBodySections(body: string): { notesBody: string; progressBody: string } {
  const lines = body.split('\n');
  let inNotes = false;
  let inProgress = false;
  const notesLines: string[] = [];
  const progressLines: string[] = [];

  for (const line of lines) {
    if (line === '## Notes') {
      inNotes = true;
      inProgress = false;
      continue;
    }
    if (line === '## Progress') {
      inProgress = true;
      inNotes = false;
      continue;
    }
    if (line.startsWith('## ')) {
      // Another H2 — exit current section but preserve content below (round-trip).
      inNotes = false;
      inProgress = false;
      continue;
    }
    if (inNotes) notesLines.push(line);
    if (inProgress) progressLines.push(line);
  }

  // Join and normalize: strip leading blank line, keep trailing newline.
  const rawNotes = notesLines.join('\n');
  const rawProgress = progressLines.join('\n');

  // Strip a single leading newline that the heading/separator creates.
  const notesBody = rawNotes.replace(/^\n/, '');
  const progressBody = rawProgress.replace(/^\n/, '');

  return { notesBody, progressBody };
}

// ---------------------------------------------------------------------------
// updated: stamp helper (v1.14.3 D1)
// ---------------------------------------------------------------------------

/**
 * Return a new front-matter object with `updated` set to now. Pure — does not
 * mutate the input. Use at every write path that calls serializeItem with new
 * content. Pure rename calls (e.g., the .trash rename in softDeleteItem at line
 * ~721) do NOT call this helper — no content change occurs at rename.
 *
 * Note: evictExpiredTrash is the explicit no-stamp path (it unlinks; doesn't write).
 *
 * @param fm  Front-matter to stamp.
 * @param now Override for testability (default: new Date()).
 */
export function stampUpdated(fm: OrganizeFrontMatter, now: Date = new Date()): OrganizeFrontMatter {
  return { ...fm, updated: now.toISOString() };
}

// writeAtomically imported from './_internals.js' (v1.15.0 D10 extraction).

// ---------------------------------------------------------------------------
// Public CRUD API
// ---------------------------------------------------------------------------

export interface CreateItemInput {
  type: OrganizeType;
  title: string;
  due?: string;
  parentId?: string;
  calendarEventId?: string;
  tags?: string[];
  notes?: string;
  /** v1.14.6 D8.b — optional initial progress body for the POST /api/webapp/items create path. */
  progress?: string;
}

/**
 * Create a new organize item for the given user.
 * Generates an id (up to 5 collision retries) and writes atomically.
 */
export async function createItem(
  userId: number,
  dataDir: string,
  itemInput: CreateItemInput,
): Promise<OrganizeItem> {
  const dir = await ensureUserDir(userId, dataDir);
  const now = new Date();

  let itemId: string | null = null;
  let filePath: string | null = null;

  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateItemId(now);
    const candidatePath = path.join(dir, `${candidate}.md`);
    if (!existsSync(candidatePath)) {
      itemId = candidate;
      filePath = candidatePath;
      break;
    }
  }

  if (itemId === null || filePath === null) {
    throw Object.assign(
      new Error('Failed to generate a unique item id after 5 attempts'),
      { code: 'ID_COLLISION' },
    );
  }

  const baseFm: OrganizeFrontMatter = {
    id: itemId,
    type: itemInput.type,
    status: 'active',
    title: itemInput.title,
    created: now.toISOString(),
    due: itemInput.due ?? null,
    parentId: itemInput.parentId ?? null,
    calendarEventId: itemInput.calendarEventId ?? null,
    tags: itemInput.tags ?? [],
  };
  // v1.14.3 D1: stamp updated on creation (created and updated are equal at first write).
  const fm = stampUpdated(baseFm, now);

  const notesBody = itemInput.notes ? itemInput.notes + '\n' : '';
  const progressBody = itemInput.progress ? itemInput.progress + '\n' : '';

  const content = serializeItem(fm, notesBody, progressBody);
  await writeAtomically(filePath, content);

  log.info({ userId, itemId, type: fm.type }, 'organize item created');

  const createdItem = { frontMatter: fm, notesBody, progressBody, filePath };

  // v1.19.0 ADR 019 D4: fire-and-forget calendar sync callback after write.
  _fireCalendarSync(userId, createdItem);

  // v1.20.0 ADR 020 D6.a: fire-and-forget item-state monitor callback after write.
  _fireItemStateMonitor(userId, createdItem);

  return createdItem;
}

/**
 * Read a single item by id. Returns null if not found.
 * On filename ≠ front-matter id, uses filename (R7).
 */
export async function readItem(
  userId: number,
  dataDir: string,
  itemId: string,
): Promise<OrganizeItem | null> {
  const filePath = itemFilePath(userId, dataDir, itemId);
  if (!existsSync(filePath)) return null;

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    log.warn({ userId, itemId, err: err instanceof Error ? err.message : String(err) }, 'Failed to read item file');
    return null;
  }

  const outcome = parseItemFile(raw, itemId);
  if (!outcome.ok) {
    log.warn({ userId, itemId, error: outcome.error }, 'organize item parse failed');
    throw Object.assign(
      new Error(`Item front-matter malformed: ${JSON.stringify(outcome.error)}`),
      { code: 'ITEM_MALFORMED' },
    );
  }

  return {
    frontMatter: outcome.result.fm,
    notesBody: outcome.result.notesBody,
    progressBody: outcome.result.progressBody,
    filePath,
  };
}

export interface ListFilter {
  status?: OrganizeStatus;
  type?: OrganizeType;
  tag?: string;
}

/**
 * List all items for a user, with optional filter.
 * Skips .trash/ directory. Reads and fully parses each .md file including
 * front-matter, notesBody, and progressBody (see parseItemFile → extractBodySections).
 * The 200-active-item cap applies only at CREATE; done + abandoned items accumulate
 * without bound and are all parsed on each call. Malformed items are logged at
 * warn and skipped.
 */
export async function listItems(
  userId: number,
  dataDir: string,
  filter: ListFilter = {},
): Promise<OrganizeItem[]> {
  const dir = organizeUserDir(userId, dataDir);
  if (!existsSync(dir)) return [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    log.warn({ userId, err: err instanceof Error ? err.message : String(err) }, 'Failed to readdir organize user dir');
    return [];
  }

  const items: OrganizeItem[] = [];

  for (const entry of entries) {
    // Skip .trash directory and non-.md files.
    if (entry === '.trash') continue;
    if (!entry.endsWith('.md')) continue;

    const itemId = entry.slice(0, -3); // strip .md
    const filePath = path.join(dir, entry);

    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (err) {
      log.warn({ userId, itemId, err: err instanceof Error ? err.message : String(err) }, 'Failed to read item file during listing');
      continue;
    }

    const outcome = parseItemFile(raw, itemId);
    if (!outcome.ok) {
      log.warn({ userId, itemId, error: outcome.error }, 'organize item skipped during listing (parse error)');
      continue;
    }

    const { fm, notesBody, progressBody } = outcome.result;

    // R7 (CP1 v1.14.3 HIGH): defense in depth against the v1.11.0
    // softDeleteItem rewrite-then-rename window. Items with deletedAt set
    // MUST not appear in active listings even if they're still in the live dir
    // during the ~5-50ms two-stage write window.
    if (fm.deletedAt != null) continue;

    // Apply filters.
    if (filter.status !== undefined && fm.status !== filter.status) continue;
    if (filter.type !== undefined && fm.type !== filter.type) continue;
    if (filter.tag !== undefined && !fm.tags.includes(filter.tag)) continue;

    items.push({ frontMatter: fm, notesBody, progressBody, filePath });
  }

  return items;
}

/**
 * Count active items for the given user. Strict — returns the EXACT count
 * of items with `status: 'active'`. Runs a front-matter parse on every
 * .md file (same cost as listItems).
 *
 * For a pure cap-check (does the user have room to create another active
 * item?), prefer `isBelowActiveCap` (v1.9.1 — fast path that skips the
 * front-matter parse when total .md file count is already below the cap).
 */
export async function countActiveItems(userId: number, dataDir: string): Promise<number> {
  const items = await listItems(userId, dataDir, { status: 'active' });
  return items.length;
}

/**
 * Fast cap check — returns true iff the user's active-item count is strictly
 * below `cap`. Optimization over `countActiveItems() < cap`:
 *   1. readdir the user dir (no front-matter parse).
 *   2. If the total .md file count (active + done + abandoned, excluding
 *      `.trash/`) is already below `cap`, we KNOW active ≤ total < cap and
 *      return true without parsing any files.
 *   3. Otherwise fall back to the strict parse.
 * For users with far fewer than `cap` items (the common case), this cuts
 * the work per `organize_create` call from O(N files × readFile) to O(1
 * readdir). v1.9.1 scalability polish.
 */
export async function isBelowActiveCap(
  userId: number,
  dataDir: string,
  cap: number,
): Promise<boolean> {
  const dir = organizeUserDir(userId, dataDir);
  if (!existsSync(dir)) return true;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    // v1.10.0 R4: fail CLOSED (was fail-open in v1.9.1).
    // Under multi-user, fail-open lets a transient readdir error become a
    // per-user quota bypass. The caller (organize_create) distinguishes
    // "at cap" vs "couldn't verify" via the ACTIVE_CAP_CHECK_FAILED code
    // so the user gets an actionable message rather than a silent bypass.
    log.error(
      { userId, err: err instanceof Error ? err.message : String(err) },
      'isBelowActiveCap: readdir failed; failing CLOSED (rejecting create)',
    );
    return false;
  }

  const mdFileCount = entries.filter((e) => e.endsWith('.md')).length;
  if (mdFileCount < cap) return true;

  // Slow path: total may exceed cap; check exact active count.
  const activeCount = await countActiveItems(userId, dataDir);
  return activeCount < cap;
}

export interface UpdateItemPatch {
  title?: string;
  due?: string | null;
  status?: OrganizeStatus;
  notes?: string;
  progress?: string;
  tags?: string[];
  calendarEventId?: string | null;
  parentId?: string | null;
  /** v1.18.0 ADR 018 D1 — per-item coach intensity. */
  coachIntensity?: import('../coach/intensityTypes.js').CoachIntensity;
  /** v1.18.0 ADR 018 D1 — nudge counter (set only by coach_log_nudge). */
  coachNudgeCount?: number;
}

/**
 * PATCH-style update. Only supplied fields are changed. Returns updated item.
 * Re-serializes via atomic write. Normalizes front-matter id to filename (R7).
 *
 * v1.14.4 R1 (BLOCKING from CP1): When `options.expectedEtag` is set, this function:
 *   1. Performs ONE `fs.stat` call to obtain `fileMtimeMs` (for the legacy ETag fallback).
 *   2. Performs ONE `readFile` call — the single FrontMatter source of truth.
 *   3. Computes `currentEtag` from THAT (parsedFm, fileMtimeMs) pair.
 *   4. On mismatch, throws `ETAG_MISMATCH` carrying `currentFm` + `currentMtimeMs` from
 *      THAT read so the handler's 412 envelope is bound to the SAME observation.
 *      NO re-read; NO re-stat after the throw.
 *
 * If `options.expectedEtag` is undefined (chat-side callers: organize_update.ts,
 * organize_complete.ts), this function does NOT call `fs.stat` — behavior is unchanged
 * from v1.14.3. Chat-side callers pay zero overhead for v1.14.4 ETag work.
 *
 * Throws Error & { code: 'ETAG_MISMATCH'; actualEtag: string; currentFm: OrganizeFrontMatter;
 *                  currentMtimeMs: number } on ETag mismatch.
 */
export async function updateItem(
  userId: number,
  dataDir: string,
  itemId: string,
  patch: UpdateItemPatch,
  options?: { expectedEtag?: string },
): Promise<OrganizeItem> {
  const filePath = itemFilePath(userId, dataDir, itemId);
  if (!existsSync(filePath)) {
    throw Object.assign(new Error(`Item not found: ${itemId}`), { code: 'ITEM_NOT_FOUND' });
  }

  // R1 (BLOCKING from CP1 v1.14.4): conditional fs.stat for ETag mtime-fallback path.
  // Only when expectedEtag is set; chat-side callers pay zero cost.
  let fileMtimeMs = 0;
  if (options?.expectedEtag !== undefined) {
    const st = await stat(filePath);                              // line A — SINGLE stat call
    fileMtimeMs = st.mtimeMs;
  }

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');                       // line B — SINGLE read; pairs with line A
  } catch (err) {
    throw Object.assign(
      new Error(`Failed to read item: ${err instanceof Error ? err.message : String(err)}`),
      { code: 'FILE_WRITE_FAILED' },
    );
  }

  const outcome = parseItemFile(raw, itemId);
  if (!outcome.ok) {
    throw Object.assign(
      new Error(`Item file is malformed: ${itemId}`),
      { code: 'ITEM_MALFORMED' },
    );
  }

  const { fm: parsedFm, notesBody: existingNotes, progressBody: existingProgress } = outcome.result;

  // R1 same-read invariant: compute currentEtag from THIS read's (parsedFm, fileMtimeMs);
  // throw error carrying THIS read's parsedFm + fileMtimeMs so the handler's 412 envelope
  // is bound to the SAME observation. NEVER re-read or re-stat to compute the conflict response.
  if (options?.expectedEtag !== undefined) {
    const currentEtag = computeETag(parsedFm, fileMtimeMs);
    if (!etagsMatch(options.expectedEtag, currentEtag)) {
      throw Object.assign(
        new Error(`ETag mismatch: expected ${options.expectedEtag}, got ${currentEtag}`),
        {
          code: 'ETAG_MISMATCH',
          actualEtag: currentEtag,
          currentFm: parsedFm,           // R1 — handler uses THIS for 412.currentItem
          currentMtimeMs: fileMtimeMs,   // R1 — handler uses THIS for ETag re-derivation if needed
        },
      );
    }
  }

  // Apply patch.
  if (patch.title !== undefined) parsedFm.title = patch.title;
  if (patch.due !== undefined) parsedFm.due = patch.due;
  if (patch.status !== undefined) parsedFm.status = patch.status;
  if (patch.tags !== undefined) parsedFm.tags = patch.tags;
  if (patch.calendarEventId !== undefined) parsedFm.calendarEventId = patch.calendarEventId;
  if (patch.parentId !== undefined) parsedFm.parentId = patch.parentId;
  // v1.18.0 ADR 018 D1: coach fields (coachNudgeCount not in PATCH fields but kept for internal tool use).
  if (patch.coachIntensity !== undefined) parsedFm.coachIntensity = patch.coachIntensity;
  if (patch.coachNudgeCount !== undefined) parsedFm.coachNudgeCount = patch.coachNudgeCount;

  // Id always normalized to filename (R7).
  parsedFm.id = itemId;

  // v1.14.3 D1: stamp updated on every write path that modifies content.
  const fm = stampUpdated(parsedFm);

  const newNotesBody = patch.notes !== undefined ? (patch.notes + '\n') : existingNotes;
  const newProgressBody = patch.progress !== undefined ? (patch.progress + '\n') : existingProgress;

  const content = serializeItem(fm, newNotesBody, newProgressBody);
  await writeAtomically(filePath, content);

  log.info({ userId, itemId, patchFields: Object.keys(patch) }, 'organize item updated');

  const updatedItem = { frontMatter: fm, notesBody: newNotesBody, progressBody: newProgressBody, filePath };

  // v1.19.0 ADR 019 D4: fire-and-forget calendar sync callback after write.
  _fireCalendarSync(userId, updatedItem);

  return updatedItem;
}

/**
 * Soft-delete: move item to .trash/ directory.
 * On collision in .trash/, appends <unix-ms>-<randomHex> suffix (R6).
 *
 * v1.14.4 R1 (BLOCKING from CP1): When `options.expectedEtag` is set, this function:
 *   1. Performs ONE `fs.stat` call to obtain `fileMtimeMs`.
 *   2. Performs ONE `readFile` call — the single FrontMatter source of truth.
 *   3. Computes `currentEtag` from THAT (parsedFm, fileMtimeMs) pair.
 *   4. On mismatch, throws `ETAG_MISMATCH` carrying `currentFm` + `currentMtimeMs` from
 *      THAT read. NO re-read; NO re-stat after the throw.
 *
 * If `options.expectedEtag` is undefined, function does NOT call `fs.stat` — chat-side
 * callers pay zero overhead.
 *
 * Throws Error & { code: 'ETAG_MISMATCH'; actualEtag: string; currentFm: OrganizeFrontMatter;
 *                  currentMtimeMs: number } on ETag mismatch.
 */
export async function softDeleteItem(
  userId: number,
  dataDir: string,
  itemId: string,
  options?: { expectedEtag?: string },
): Promise<{ trashedPath: string }> {
  await ensureUserDir(userId, dataDir);
  const trashDir = await ensureTrashDir(userId, dataDir);
  const srcPath = itemFilePath(userId, dataDir, itemId);

  if (!existsSync(srcPath)) {
    throw Object.assign(new Error(`Item not found: ${itemId}`), { code: 'ITEM_NOT_FOUND' });
  }

  // R1 (BLOCKING from CP1 v1.14.4): same single-stat-then-read pair as updateItem.
  // Only when expectedEtag is set; chat-side callers pay zero cost.
  let fileMtimeMs = 0;
  if (options?.expectedEtag !== undefined) {
    const st = await stat(srcPath);                              // line A — SINGLE stat call
    fileMtimeMs = st.mtimeMs;
  }

  // v1.11.0 R3: rewrite the live file with deletedAt before renaming to .trash/.
  // Atomic temp-then-rename in the live user dir. If the rewrite fails, throw
  // FILE_WRITE_FAILED — the item stays live and the user can retry.
  // This expands the write window slightly vs. rename-only; that is acceptable per R12.11.
  let raw: string;
  try {
    raw = await readFile(srcPath, 'utf8');                       // line B — SINGLE read; pairs with line A
  } catch (err) {
    throw Object.assign(
      new Error(`softDeleteItem: failed to read item for deletedAt rewrite: ${err instanceof Error ? err.message : String(err)}`),
      { code: 'FILE_WRITE_FAILED' },
    );
  }
  const parseOutcome = parseItemFile(raw, itemId);

  // R1 same-read invariant: check ETag before any write, using the parsedFm from THIS read.
  if (options?.expectedEtag !== undefined && parseOutcome.ok) {
    const currentEtag = computeETag(parseOutcome.result.fm, fileMtimeMs);
    if (!etagsMatch(options.expectedEtag, currentEtag)) {
      throw Object.assign(
        new Error(`ETag mismatch: expected ${options.expectedEtag}, got ${currentEtag}`),
        {
          code: 'ETAG_MISMATCH',
          actualEtag: currentEtag,
          currentFm: parseOutcome.result.fm,    // R1 — handler uses THIS for 412.currentItem
          currentMtimeMs: fileMtimeMs,           // R1 — handler uses THIS for ETag re-derivation
        },
      );
    }
  }

  if (parseOutcome.ok) {
    // Stamp deletedAt on the parsed front-matter and rewrite atomically into the live path.
    const { fm: parsedFm, notesBody, progressBody } = parseOutcome.result;
    parsedFm.id = itemId; // normalize to filename (R7)
    parsedFm.deletedAt = new Date().toISOString();
    // v1.14.3 D1: stamp updated on the rewriteContent path (content change).
    // The subsequent rename to .trash is a pure FS move — no additional stamp needed.
    const fm = stampUpdated(parsedFm);
    const rewriteContent = serializeItem(fm, notesBody, progressBody);
    try {
      await writeAtomically(srcPath, rewriteContent);
    } catch (err) {
      throw Object.assign(
        new Error(`softDeleteItem: atomic write of deletedAt failed: ${err instanceof Error ? err.message : String(err)}`),
        { code: 'FILE_WRITE_FAILED' },
      );
    }
  }
  // If parse failed (malformed file), proceed with rename without deletedAt stamp.
  // The evictor will fall back to mtime for this file.

  let destPath = path.join(trashDir, `${itemId}.md`);

  // Handle collision in .trash/.
  if (existsSync(destPath)) {
    const suffix = `${Date.now()}-${randomBytes(3).toString('hex')}`;
    destPath = path.join(trashDir, `${itemId}--${suffix}.md`);
  }

  await rename(srcPath, destPath);
  log.info({ userId, itemId, trashedPath: destPath }, 'organize item soft-deleted');

  // v1.19.0 ADR 019 D4: fire-and-forget calendar remove callback after soft-delete.
  _fireCalendarRemove(userId, itemId);

  return { trashedPath: destPath };
}

/**
 * Append a progress entry to the item's ## Progress section.
 * Creates the section if absent. Uses UTC date (R12).
 */
export async function appendProgressEntry(
  userId: number,
  dataDir: string,
  itemId: string,
  entry: string,
  date: Date = new Date(),
): Promise<OrganizeItem> {
  const filePath = itemFilePath(userId, dataDir, itemId);
  if (!existsSync(filePath)) {
    throw Object.assign(new Error(`Item not found: ${itemId}`), { code: 'ITEM_NOT_FOUND' });
  }

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    throw Object.assign(
      new Error(`Failed to read item: ${err instanceof Error ? err.message : String(err)}`),
      { code: 'FILE_WRITE_FAILED' },
    );
  }

  const outcome = parseItemFile(raw, itemId);
  if (!outcome.ok) {
    throw Object.assign(
      new Error(`Item file is malformed: ${itemId}`),
      { code: 'ITEM_MALFORMED' },
    );
  }

  const { fm: parsedFm, notesBody } = outcome.result;

  // Normalize id to filename (R7).
  parsedFm.id = itemId;

  // v1.14.3 D1: stamp updated on every write path that modifies content.
  const fm = stampUpdated(parsedFm, date);

  const dateStr = date.toISOString().slice(0, 10); // UTC YYYY-MM-DD
  const newLine = `- ${dateStr}: ${entry.trim()}\n`;

  const existingProgress = outcome.result.progressBody;
  const newProgressBody = existingProgress + newLine;

  const content = serializeItem(fm, notesBody, newProgressBody);
  await writeAtomically(filePath, content);

  log.info({ userId, itemId }, 'organize progress entry appended');

  return { frontMatter: fm, notesBody, progressBody: newProgressBody, filePath };
}

/**
 * Helper: read a file and return parsed front-matter only (no body).
 * Used by listItems for efficient front-matter-only scans.
 * Returns null on any parse failure.
 */
export async function readItemFrontMatter(
  filePath: string,
  itemId: string,
): Promise<OrganizeFrontMatter | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  const outcome = parseItemFile(raw, itemId);
  if (!outcome.ok) return null;
  return outcome.result.fm;
}

// ---------------------------------------------------------------------------
// readItemFrontMatterFromPath — absolute-path variant (used by smart-404 R5)
// ---------------------------------------------------------------------------

/**
 * Read front-matter from an arbitrary absolute file path (e.g., a trash file).
 * Used by handleRestoreItemNotFound's closest-match enrichment to read titles
 * from trash entries without knowing the userId/dataDir structure.
 * Returns null on any error.
 */
export async function readItemFrontMatterFromPath(
  filePath: string,
): Promise<OrganizeFrontMatter | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  const itemId = path.basename(filePath, '.md');
  const outcome = parseItemFile(raw, itemId);
  if (!outcome.ok) return null;
  return outcome.result.fm;
}

// Export OrganizeListItem re-export for consumers (closed via types.ts import)
export type { OrganizeListItem };

// ---------------------------------------------------------------------------
// parentExistsAndIsActiveGoal — v1.14.5 D2/D13 + R1 (BLOCKING)
// ---------------------------------------------------------------------------

export type ParentRefRejection = 'NOT_FOUND' | 'NOT_GOAL' | 'NOT_ACTIVE';

export interface ParentRefResult {
  ok: boolean;
  reason?: ParentRefRejection;
}

/**
 * Verify that `parentId` references an existing, non-trashed goal whose status
 * is 'active' or 'done' (NOT 'abandoned' — ADR 013 D1 rationale).
 *
 * Reads only the parent item's file via readItemFrontMatter. Does NOT call
 * readItem (notes/progress not needed). Returns NOT_FOUND for a missing,
 * trashed, OR mid-soft-delete file (deletedAt-stamped-but-not-yet-renamed
 * window — R1 BLOCKING from CP1 v1.14.5; same defense in depth as v1.14.3 R7
 * listItems filter at storage.ts:564).
 *
 * Returns NOT_GOAL for a present non-goal item.
 * Returns NOT_ACTIVE for an abandoned goal (done goals ARE accepted — D1).
 *
 * @param userId   Telegram user id (per-user dataDir scoping).
 * @param dataDir  Resolved organize data directory root.
 * @param parentId Item id (format: YYYY-MM-DD-[a-z0-9]{4}).
 */
export async function parentExistsAndIsActiveGoal(
  userId: number,
  dataDir: string,
  parentId: string,
): Promise<ParentRefResult> {
  const filePath = itemFilePath(userId, dataDir, parentId);
  if (!existsSync(filePath)) return { ok: false, reason: 'NOT_FOUND' };
  const fm = await readItemFrontMatter(filePath, parentId);
  if (fm === null) return { ok: false, reason: 'NOT_FOUND' };

  // R1 (BLOCKING from CP1 v1.14.5; mirrors v1.14.3 R7 listItems filter at
  // storage.ts:564): softDeleteItem stamps deletedAt at storage.ts:828 then
  // renames at storage.ts:847; the window between those two operations leaves
  // the LIVE file with deletedAt set. Without this filter, the validator
  // accepts a parent the chat-agent is actively deleting.
  if (fm.deletedAt != null) return { ok: false, reason: 'NOT_FOUND' };

  if (fm.type !== 'goal') return { ok: false, reason: 'NOT_GOAL' };
  if (fm.status === 'abandoned') return { ok: false, reason: 'NOT_ACTIVE' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// listTrashedItems, TrashedItemSummary, EvictErrorCode, EvictResult,
// evictExpiredTrash, restoreItem — MOVED to trash.ts (v1.14.6 D1).
// Import them from './trash.js' at all call sites.
// ---------------------------------------------------------------------------
