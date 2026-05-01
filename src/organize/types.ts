/**
 * Plain TypeScript types for the /organize feature (v1.8.6).
 *
 * No runtime code here — only type declarations. All other organize
 * modules import from this file.
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

// v1.18.0 ADR 018 Decision 1: coach intensity type used in OrganizeFrontMatter.
import type { CoachIntensity } from '../coach/intensityTypes.js';
// Re-export for callers that import coach intensity from organize types.
export type { CoachIntensity };

// ---------------------------------------------------------------------------
// Primitive union types
// ---------------------------------------------------------------------------

export type OrganizeType = 'task' | 'event' | 'goal';

export type OrganizeStatus = 'active' | 'done' | 'abandoned';

// ---------------------------------------------------------------------------
// Front-matter shape
// ---------------------------------------------------------------------------

export interface OrganizeFrontMatter {
  /** Matches YYYY-MM-DD-[a-z0-9]{4}. Authoritative id is always the filename. */
  id: string;
  type: OrganizeType;
  status: OrganizeStatus;
  /** Single line, 1–500 chars after trim. */
  title: string;
  /** Full ISO-8601 with Z or offset. */
  created: string;
  /** YYYY-MM-DD or ISO datetime. null means no due date (missing, empty, or unparseable). */
  due: string | null;
  /** Another item's id, or null. Orphaned references are tolerated. */
  parentId: string | null;
  /** Google Calendar event id. Only populated when type === 'event'. */
  calendarEventId: string | null;
  /** v1.11.0 R3 — ISO timestamp set by softDeleteItem; absent on live items and on legacy (pre-v1.11.0) trashes. */
  deletedAt?: string | null;
  /** v1.14.3 D1 — ISO timestamp of the most recent content write. Stamped via stampUpdated()
   *  on every write path. Older items (pre-v1.14.3) may not have this field; parser tolerates
   *  absence and first edit stamps it. Distinct from `created` (immutable) and from file mtime. */
  updated?: string | null;
  /** ≤10 tags, each ≤40 chars. */
  tags: string[];
  /**
   * v1.18.0 ADR 018 Decision 1 — per-item coach intensity.
   * off = no coaching; gentle = check-in; moderate = friendly push; persistent = direct push.
   * Defaults to 'off' at read time when absent (legacy items have no field).
   * Emitted in frontmatter ONLY when !== 'off' (omission === 'off' for legacy compat).
   */
  coachIntensity?: CoachIntensity;
  /**
   * v1.18.0 ADR 018 Decision 1 — cumulative nudge counter for telemetry.
   * Non-negative integer. Defaults to 0 at read time when absent.
   * Emitted in frontmatter ONLY when > 0 (omission === 0 for legacy compat).
   */
  coachNudgeCount?: number;
}

// ---------------------------------------------------------------------------
// Full item (front-matter + body sections + file path)
// ---------------------------------------------------------------------------

export interface OrganizeItem {
  frontMatter: OrganizeFrontMatter;
  /** Free markdown under ## Notes (may be empty string). */
  notesBody: string;
  /** Append-only bullet entries under ## Progress (may be empty string). */
  progressBody: string;
  /** Absolute path to the .md file on disk. */
  filePath: string;
}

// ---------------------------------------------------------------------------
// API response shape — shared by items.read.ts and items.mutate.ts (W7)
// ---------------------------------------------------------------------------

/**
 * Full item detail shape returned by GET /api/webapp/items/:id,
 * PATCH /api/webapp/items/:id, and POST /api/webapp/items/:id/complete.
 *
 * Front-matter fields are flattened (ADR 009 decision 3). Absolute filePath
 * is stripped; only fileBasename is exposed. mtimeMs added per R2-mtime so
 * the client can detect stale edits.
 */
export interface OrganizeItemDetail {
  id: string;
  type: OrganizeType;
  status: OrganizeStatus;
  title: string;
  created: string;
  due: string | null;
  parentId: string | null;
  calendarEventId: string | null;
  tags: string[];
  notes: string;
  progress: string;
  fileBasename: string;
  /** File modification time in milliseconds since epoch. Used as ETag fallback
   *  for items not yet written under v1.14.3 (no `updated:` front-matter field). */
  mtimeMs: number;
  /** v1.14.3 D1 — ISO timestamp of the most recent content write. Nullable for legacy items. */
  updated: string | null;
  /**
   * v1.18.0 ADR 018 D1 — per-item coach intensity dial.
   * Normalized to 'off' at the wire boundary for legacy items (undefined in frontmatter → 'off').
   */
  coachIntensity: CoachIntensity | 'off';
  /**
   * v1.18.0 ADR 018 D1 — number of coach nudges delivered for this item.
   * Defaults to 0 for legacy items.
   */
  coachNudgeCount: number;
}

// ---------------------------------------------------------------------------
// List projection shape (W2 — closes F4 carry-forward from v1.14.0)
// ---------------------------------------------------------------------------

/**
 * Projection shape returned by GET /api/webapp/items (list endpoint).
 * Previously an anonymous object literal in items.read.ts; extracted here per
 * ADR 011 D6 + RA3 KNOWN_ISSUES.md entry #7 to close the 5-iteration carry-forward.
 * Includes `parentId` (NEW in v1.14.3 for hierarchy grouping) and `updated`
 * (NEW in v1.14.3 D1).
 */
export interface OrganizeListItem {
  id: string;
  type: OrganizeType;
  status: OrganizeStatus;
  title: string;
  due: string | null;
  tags: string[];
  created: string;
  hasNotes: boolean;
  hasProgress: boolean;
  calendarEventId: string | null;
  /** v1.14.3 D6/SF-1 — required for client-side hierarchy grouping. */
  parentId: string | null;
  /** v1.14.3 D1 — last-modified ISO timestamp; null for legacy items. */
  updated: string | null;
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/**
 * Every error code that can appear in an organize tool result.
 * The union is exhaustive — no error code should be returned that is not
 * listed here.
 */
export type OrganizeErrorCode =
  // Identity / access
  | 'NO_USER_ID'
  // Privacy filter
  | 'PRIVACY_FILTER_REJECTED'
  // Create limits
  | 'ACTIVE_CAP_EXCEEDED'
  | 'ACTIVE_CAP_CHECK_FAILED'
  // Input validation
  | 'MISSING_EVENT_FIELDS'
  | 'INVALID_DUE_FORMAT'
  // Calendar errors
  | 'CALENDAR_CREATE_FAILED'
  | 'CALENDAR_DISABLED_FOR_CHAT'
  | 'CALENDAR_DISABLED_FOR_CHAT_SOFT'
  // Atomic-write / compensating-delete paths
  | 'FILE_WRITE_FAILED_EVENT_ROLLED_BACK'
  | 'FILE_WRITE_FAILED_EVENT_ORPHANED'
  | 'FILE_WRITE_FAILED'
  // Id generation
  | 'ID_COLLISION'
  // Directory defense
  | 'ORGANIZE_USER_DIR_SYMLINK'
  // Item operations
  | 'ITEM_NOT_FOUND'
  | 'ITEM_MALFORMED'
  // Soft update calendar sync
  | 'CALENDAR_SYNC_FAILED_SOFT'
  // Complete
  | 'ALREADY_COMPLETE'
  // List
  | 'LIST_READ_FAILED'
  // Delete
  | 'CALENDAR_DELETE_FAILED'
  | 'FILE_DELETE_FAILED'
  | 'ORGANIZE_TRASH_INVALID'
  // Tag validation
  | 'TAG_TOO_LONG'
  | 'TAG_LIMIT_EXCEEDED'
  // Restore
  | 'ITEM_NOT_FOUND_IN_TRASH'
  | 'ITEM_ALREADY_LIVE';
