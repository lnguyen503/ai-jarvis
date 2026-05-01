/**
 * Validate a PATCH body for the webapp items route (v1.14.2).
 *
 * This validator is the ONLY gate standing between a malicious HTTP client and
 * the storage layer's wider UpdateItemPatch shape. The storage layer accepts
 * `notes`, `calendarEventId`, `parentId`, etc. — fields the webapp MUST NOT
 * expose over HTTP in v1.14.2. Do NOT widen the allowed-fields list without an
 * ADR amendment.
 *
 * Design decisions (ADR 010 decision 2 + revisions RA1 / RA2 / W3):
 *   - Explicit reject when unknown fields are present alongside known ones
 *     (RA2 / R15). The silent-strip approach from the original ADR prose was
 *     superseded by the CP1 revisions which favour loud errors for debuggability.
 *   - Machine-readable error codes (RA1) — route handlers map them directly to
 *     the wire envelope without synthesis.
 *   - Named regex constants ISO_DATE_RE and TAG_RE (W3).
 *   - Title limit: 500 chars (mirrors storage; avoids create-vs-edit asymmetry
 *     per SF-1). Tag limit: 40 chars (mirrors storage).
 *   - No new npm dependencies — hand-rolled only.
 */

import type { OrganizeStatus, OrganizeType, CoachIntensity } from './types.js';

// ---------------------------------------------------------------------------
// Named regex constants (W3)
// ---------------------------------------------------------------------------

/**
 * ISO 8601 date shape: YYYY-MM-DD (10 chars exactly).
 * Note: `parseItemFile` is more tolerant — it accepts non-real-calendar dates
 * that match this shape (e.g., '2026-02-30'). Validator and storage agree on
 * shape; storage does not enforce calendar correctness.
 */
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Valid tag: no whitespace, no comma, no YAML-reserved chars ([ ] { } |).
 * Matches the existing system-wide tag posture (ADR 003 revisions).
 */
// eslint-disable-next-line no-useless-escape -- the brackets are part of a character class negation pattern
export const TAG_RE = /^[^\s,[\]{}|]+$/;

// ---------------------------------------------------------------------------
// Limits (mirror src/organize/privacy.ts to avoid create-vs-edit asymmetry)
// ---------------------------------------------------------------------------

/** Maximum title length in characters (after trim). Same as privacy.ts MAX_TITLE. */
export const MAX_TITLE = 500;

/** Maximum length per tag in characters (after trim). Same as privacy.ts MAX_TAG. */
export const MAX_TAG = 40;

/** Maximum number of tags per item. */
export const MAX_TAGS = 10;

/** Maximum notes length in characters (v1.14.3 D2). 10 KB. */
export const MAX_NOTES = 10240;

/** Maximum progress length in characters (v1.14.3 D3). 20 KB. */
export const MAX_PROGRESS = 20480;

// ---------------------------------------------------------------------------
// Error codes (RA1 — machine-readable)
// ---------------------------------------------------------------------------

export type ValidatorErrorCode =
  | 'PATCH_NO_VALID_FIELDS'       // body had no keys at all, or all keys were unknown
  | 'PATCH_UNKNOWN_FIELDS'        // body had unknown fields alongside at least one known field
  | 'TITLE_REQUIRED'              // title present but empty or whitespace-only after trim
  | 'TITLE_TOO_LONG'              // title > MAX_TITLE after trim
  | 'TITLE_NOT_STRING'            // title present but not a string
  | 'TITLE_INVALID_CHARS'         // title contains null bytes (v1.14.6 W4 — NUL-byte retrofit; applies to both PATCH + CREATE)
  | 'DUE_INVALID_FORMAT'          // due present, not null, fails ISO_DATE_RE
  | 'STATUS_INVALID'              // status present but not in {'active','done','abandoned'}
  | 'TAGS_NOT_ARRAY'              // tags present but not an array
  | 'TAG_TOO_LONG'                // at least one tag > MAX_TAG after trim
  | 'TAG_INVALID_CHARS'           // at least one tag contains disallowed chars (whitespace, comma, YAML-reserved)
  | 'TAGS_TOO_MANY'               // tags array length > MAX_TAGS
  | 'NOTES_NOT_STRING'            // notes present but not a string (v1.14.3 D2)
  | 'NOTES_TOO_LONG'              // notes string > MAX_NOTES chars (v1.14.3 D2)
  | 'NOTES_INVALID_CHARS'         // notes string contains null bytes (v1.14.3 Fix 4 — defense-in-depth against null-byte injection)
  | 'PROGRESS_NOT_STRING'         // progress present but not a string (v1.14.3 D3)
  | 'PROGRESS_TOO_LONG'           // progress string > MAX_PROGRESS chars (v1.14.3 D3)
  | 'PROGRESS_INVALID_CHARS'      // progress string contains null bytes (v1.14.3 Fix 4)
  | 'PARENT_ID_INVALID_FORMAT'    // parentId present, not null, fails item-id regex (v1.14.5 D1)
  | 'CREATE_TYPE_REQUIRED'        // type missing or not 'task'|'event'|'goal' (v1.14.6 D8)
  | 'CREATE_PARENT_ON_GOAL'       // type='goal' and parentId is non-null (v1.14.6 D8 — goals cannot have parents)
  | 'CREATE_UNKNOWN_FIELDS'       // body contains field not in the allowed create set (v1.14.6 D8)
  | 'COACH_INTENSITY_INVALID'    // coachIntensity present and not in the closed set (v1.18.0 ADR 018)
  | 'COACH_NUDGE_COUNT_INVALID'; // coachNudgeCount present and not a non-negative integer (v1.18.0 ADR 018)

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The fields the webapp is permitted to mutate (coachIntensity added v1.18.0). */
export interface AllowedPatch {
  title?: string;
  due?: string | null;
  status?: OrganizeStatus;
  tags?: string[];
  notes?: string;
  progress?: string;
  /** v1.14.5 D1 — string item-id (reparent), null (clear parent / top-level), or absent (leave unchanged). */
  parentId?: string | null;
  /** v1.18.0 ADR 018 D1 — per-item coach intensity. User-editable. */
  coachIntensity?: CoachIntensity;
}

/**
 * Canonical item-id regex for parentId format validation (D1).
 * Matches: YYYY-MM-DD-[a-z0-9]{4}
 */
export const PARENT_ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9]{4}$/;

/** Allowed field names as a set for O(1) membership checks. */
export const ALLOWED_PATCH_FIELDS: ReadonlySet<string> = new Set([
  'title',
  'due',
  'status',
  'tags',
  'notes',
  'progress',
  'parentId',
  'coachIntensity', // v1.18.0 ADR 018 D1 — user-editable per-item coach dial
]);

export type ValidationResult =
  | { ok: true; patch: AllowedPatch }
  | { ok: false; code: ValidatorErrorCode; error: string };

// ---------------------------------------------------------------------------
// Field-level helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Returns true when `s` is a valid OrganizeStatus value. */
export function isValidStatus(s: unknown): s is OrganizeStatus {
  return s === 'active' || s === 'done' || s === 'abandoned';
}

/**
 * Returns true when `t` is a valid tag:
 *   - string
 *   - 1-MAX_TAG chars after trim
 *   - matches TAG_RE (no whitespace, comma, or YAML-reserved chars)
 */
export function isValidTag(t: unknown): boolean {
  if (typeof t !== 'string') return false;
  const trimmed = t.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TAG) return false;
  return TAG_RE.test(trimmed);
}

// ---------------------------------------------------------------------------
// Core validator
// ---------------------------------------------------------------------------

/**
 * Validate a PATCH body for the webapp items route.
 *
 * Behavior (per RA1 + RA2, superseding ADR 010 decision 2 silent-strip prose):
 *   - If body has NO recognized fields at all → PATCH_NO_VALID_FIELDS
 *   - If body has at least one known field AND at least one unknown field →
 *     PATCH_UNKNOWN_FIELDS (explicit reject; don't silently strip)
 *   - If body has ONLY known fields → validate each present field
 *
 * The output `patch` object contains ONLY the four allowed fields — NEVER
 * spreads the input (RA2). Per-field validation errors short-circuit at the
 * first failure.
 *
 * @param body  The raw JSON body (already parsed by express.json).
 */
export function validatePatchBody(body: unknown): ValidationResult {
  // Body must be a plain object.
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      code: 'PATCH_NO_VALID_FIELDS',
      error: 'No recognized fields in patch body. Allowed fields: title, due, status, tags, notes, progress, parentId.',
    };
  }

  const input = body as Record<string, unknown>;
  const keys = Object.keys(input);

  if (keys.length === 0) {
    return {
      ok: false,
      code: 'PATCH_NO_VALID_FIELDS',
      error: 'No recognized fields in patch body. Allowed fields: title, due, status, tags, notes, progress, parentId.',
    };
  }

  const knownKeys = keys.filter((k) => ALLOWED_PATCH_FIELDS.has(k));
  const unknownKeys = keys.filter((k) => !ALLOWED_PATCH_FIELDS.has(k));

  if (knownKeys.length === 0) {
    // All keys are unknown
    return {
      ok: false,
      code: 'PATCH_NO_VALID_FIELDS',
      error: 'No recognized fields in patch body. Allowed fields: title, due, status, tags, notes, progress, parentId.',
    };
  }

  if (unknownKeys.length > 0) {
    // Mix of known + unknown → explicit reject (RA2 / R15)
    return {
      ok: false,
      code: 'PATCH_UNKNOWN_FIELDS',
      error: `Unknown fields in patch body: ${unknownKeys.join(', ')}. Allowed fields: title, due, status, tags, notes, progress, parentId.`,
    };
  }

  // All keys are known — validate each present field and build the patch object
  // using EXPLICIT field copy (never spread).
  const patch: AllowedPatch = {};

  // --- title ---
  if ('title' in input) {
    const rawTitle = input['title'];
    if (typeof rawTitle !== 'string') {
      return { ok: false, code: 'TITLE_NOT_STRING', error: 'Field "title" must be a string.' };
    }
    const trimmed = rawTitle.trim();
    if (trimmed.length === 0) {
      return { ok: false, code: 'TITLE_REQUIRED', error: 'Field "title" must not be empty after trimming.' };
    }
    if (trimmed.length > MAX_TITLE) {
      return { ok: false, code: 'TITLE_TOO_LONG', error: `Field "title" must be at most ${MAX_TITLE} characters after trimming.` };
    }
    // W4 (v1.14.6 NUL-byte retrofit): title with NUL byte is rejected on both PATCH and CREATE paths.
    if (trimmed.includes('\x00')) {
      return { ok: false, code: 'TITLE_INVALID_CHARS', error: 'Field "title" cannot contain null bytes.' };
    }
    patch.title = trimmed;
  }

  // --- due ---
  if ('due' in input) {
    const rawDue = input['due'];
    if (rawDue === null) {
      patch.due = null; // explicit clear
    } else if (typeof rawDue !== 'string' || !ISO_DATE_RE.test(rawDue)) {
      return {
        ok: false,
        code: 'DUE_INVALID_FORMAT',
        error: 'Field "due" must be null or an ISO date string in YYYY-MM-DD format.',
      };
    } else {
      patch.due = rawDue;
    }
  }

  // --- status ---
  if ('status' in input) {
    const rawStatus = input['status'];
    if (!isValidStatus(rawStatus)) {
      return {
        ok: false,
        code: 'STATUS_INVALID',
        error: 'Field "status" must be one of: active, done, abandoned.',
      };
    }
    patch.status = rawStatus;
  }

  // --- tags ---
  if ('tags' in input) {
    const rawTags = input['tags'];
    if (!Array.isArray(rawTags)) {
      return { ok: false, code: 'TAGS_NOT_ARRAY', error: 'Field "tags" must be an array.' };
    }
    if (rawTags.length > MAX_TAGS) {
      return { ok: false, code: 'TAGS_TOO_MANY', error: `Field "tags" must have at most ${MAX_TAGS} entries.` };
    }
    // Validate each tag
    for (const tag of rawTags) {
      if (typeof tag !== 'string') {
        return { ok: false, code: 'TAG_INVALID_CHARS', error: 'Each tag must be a string.' };
      }
      const trimmed = tag.trim();
      if (trimmed.length > MAX_TAG) {
        return { ok: false, code: 'TAG_TOO_LONG', error: `Each tag must be at most ${MAX_TAG} characters after trimming.` };
      }
      if (!TAG_RE.test(trimmed)) {
        return {
          ok: false,
          code: 'TAG_INVALID_CHARS',
          error: 'Tags must not contain whitespace, commas, or YAML-reserved characters ([ ] { } |).',
        };
      }
    }
    // Store trimmed tags
    patch.tags = rawTags.map((t) => (t as string).trim());
  }

  // --- notes (v1.14.3 D2) ---
  if ('notes' in input) {
    const rawNotes = input['notes'];
    if (typeof rawNotes !== 'string') {
      return { ok: false, code: 'NOTES_NOT_STRING', error: 'Field "notes" must be a string.' };
    }
    if (rawNotes.length > MAX_NOTES) {
      return {
        ok: false,
        code: 'NOTES_TOO_LONG',
        error: `Field "notes" must be at most ${MAX_NOTES} characters.`,
      };
    }
    // Fix 4 (v1.14.3): null-byte defense-in-depth — NUL chars are a YAML risk in any downstream consumer.
    if (rawNotes.includes('\x00')) {
      return { ok: false, code: 'NOTES_INVALID_CHARS', error: 'Field "notes" cannot contain null bytes.' };
    }
    patch.notes = rawNotes;
  }

  // --- progress (v1.14.3 D3) ---
  if ('progress' in input) {
    const rawProgress = input['progress'];
    if (typeof rawProgress !== 'string') {
      return { ok: false, code: 'PROGRESS_NOT_STRING', error: 'Field "progress" must be a string.' };
    }
    if (rawProgress.length > MAX_PROGRESS) {
      return {
        ok: false,
        code: 'PROGRESS_TOO_LONG',
        error: `Field "progress" must be at most ${MAX_PROGRESS} characters.`,
      };
    }
    // Fix 4 (v1.14.3): null-byte defense-in-depth.
    if (rawProgress.includes('\x00')) {
      return { ok: false, code: 'PROGRESS_INVALID_CHARS', error: 'Field "progress" cannot contain null bytes.' };
    }
    patch.progress = rawProgress;
  }

  // --- parentId (v1.14.5 D1) ---
  // Accepted values: a string matching PARENT_ID_RE, null (explicit clear), or absent (leave unchanged).
  // Self-reference and existence checks are done at the route handler level (D2 Option C — keep validator pure/sync).
  if ('parentId' in input) {
    const rawParentId = input['parentId'];
    if (rawParentId === null) {
      patch.parentId = null; // explicit clear — item becomes top-level / orphan
    } else if (typeof rawParentId !== 'string' || !PARENT_ID_RE.test(rawParentId)) {
      return {
        ok: false,
        code: 'PARENT_ID_INVALID_FORMAT',
        error: 'Field "parentId" must be null or a valid item id (format: YYYY-MM-DD-xxxx).',
      };
    } else {
      patch.parentId = rawParentId;
    }
  }

  // --- coachIntensity (v1.18.0 ADR 018 D1) ---
  if ('coachIntensity' in input) {
    const rawIntensity = input['coachIntensity'];
    // Import isCoachIntensity inline to keep validation.ts self-contained
    const validIntensities = ['off', 'gentle', 'moderate', 'persistent'];
    if (typeof rawIntensity !== 'string' || !validIntensities.includes(rawIntensity)) {
      return {
        ok: false,
        code: 'COACH_INTENSITY_INVALID',
        error: `Field "coachIntensity" must be one of: ${validIntensities.join(', ')}.`,
      };
    }
    patch.coachIntensity = rawIntensity as CoachIntensity;
  }

  // RA2: drop dead `sawUnknown: false` (Anti-Slop RA2; F3 carry-forward from v1.14.2 Phase-2 review).
  return { ok: true, patch };
}

// ---------------------------------------------------------------------------
// validateCreateBody — v1.14.6 D8 + D8.b
// ---------------------------------------------------------------------------

/**
 * The complete set of fields accepted on the POST /api/webapp/items create path.
 *
 * Differences from AllowedPatch (D8):
 *   - `type` is REQUIRED (not updatable via PATCH; set at creation only).
 *   - `status` is NOT settable on create (always starts 'active'; any status field → 400).
 *   - `progress` IS settable (D8.b — optional initial progress body).
 *   - `parentId` is rejected when type === 'goal' (CREATE_PARENT_ON_GOAL).
 */
export interface CreateItemInput {
  type: 'task' | 'event' | 'goal';
  title: string;
  due?: string | null;
  tags?: string[];
  notes?: string;
  progress?: string;
  parentId?: string | null;
}

/** Set of fields accepted on create (used for unknown-field detection). */
const ALLOWED_CREATE_FIELDS: ReadonlySet<string> = new Set([
  'type',
  'title',
  'due',
  'tags',
  'notes',
  'progress',
  'parentId',
  // coachIntensity intentionally NOT in create fields (ADR 018 D1: coachNudgeCount always starts 0;
  // coachIntensity defaults to 'off'; only coach_log_nudge increments count; PATCH route sets intensity).
]);

export type CreateValidationResult =
  | { ok: true; input: CreateItemInput }
  | { ok: false; code: ValidatorErrorCode; error: string };

/**
 * Validate a POST body for the POST /api/webapp/items create route.
 *
 * Rules (D8 + D8.b + W4):
 *   - `type` required; must be 'task'|'event'|'goal'; else CREATE_TYPE_REQUIRED.
 *   - `title` required; 1-500 chars after trim; NUL byte rejected (W4).
 *   - `due` optional; null or ISO YYYY-MM-DD.
 *   - `tags` optional; array; max 10; each matches TAG_RE.
 *   - `notes` optional; string; max 10240; NUL-banned.
 *   - `progress` optional (D8.b); string; max 20480; NUL-banned.
 *   - `parentId` optional; null or PARENT_ID_RE; rejected when type='goal' (CREATE_PARENT_ON_GOAL).
 *   - `status` MUST NOT appear → CREATE_UNKNOWN_FIELDS.
 *   - Any other unknown field → CREATE_UNKNOWN_FIELDS.
 *
 * @param body  The raw JSON body (already parsed by express.json).
 */
export function validateCreateBody(body: unknown): CreateValidationResult {
  // Body must be a plain object.
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      code: 'CREATE_TYPE_REQUIRED',
      error: 'Request body must be a JSON object with at least {type, title}.',
    };
  }

  const input = body as Record<string, unknown>;

  // Unknown-field detection — reject any field not in the allowed create set.
  // Note: status is NOT in ALLOWED_CREATE_FIELDS, so body.status → CREATE_UNKNOWN_FIELDS.
  const unknownKeys = Object.keys(input).filter((k) => !ALLOWED_CREATE_FIELDS.has(k));
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      code: 'CREATE_UNKNOWN_FIELDS',
      error: `Unknown fields in create body: ${unknownKeys.join(', ')}. Allowed fields: type, title, due, tags, notes, progress, parentId.`,
    };
  }

  // --- type (required) ---
  const rawType = input['type'];
  if (rawType !== 'task' && rawType !== 'event' && rawType !== 'goal') {
    return {
      ok: false,
      code: 'CREATE_TYPE_REQUIRED',
      error: 'Field "type" is required and must be one of: task, event, goal.',
    };
  }
  const validatedType = rawType as OrganizeType;

  // --- title (required) ---
  const rawTitle = input['title'];
  if (typeof rawTitle !== 'string') {
    return {
      ok: false,
      code: typeof rawTitle === 'undefined' ? 'TITLE_REQUIRED' : 'TITLE_NOT_STRING',
      error: 'Field "title" is required and must be a string.',
    };
  }
  const trimmedTitle = rawTitle.trim();
  if (trimmedTitle.length === 0) {
    return { ok: false, code: 'TITLE_REQUIRED', error: 'Field "title" must not be empty after trimming.' };
  }
  if (trimmedTitle.length > MAX_TITLE) {
    return { ok: false, code: 'TITLE_TOO_LONG', error: `Field "title" must be at most ${MAX_TITLE} characters after trimming.` };
  }
  // W4 (v1.14.6 NUL-byte): reject NUL in title on both create and patch paths.
  if (trimmedTitle.includes('\x00')) {
    return { ok: false, code: 'TITLE_INVALID_CHARS', error: 'Field "title" cannot contain null bytes.' };
  }

  // --- due (optional) ---
  let validatedDue: string | null | undefined;
  if ('due' in input) {
    const rawDue = input['due'];
    if (rawDue === null) {
      validatedDue = null;
    } else if (typeof rawDue !== 'string' || !ISO_DATE_RE.test(rawDue)) {
      return {
        ok: false,
        code: 'DUE_INVALID_FORMAT',
        error: 'Field "due" must be null or an ISO date string in YYYY-MM-DD format.',
      };
    } else {
      validatedDue = rawDue;
    }
  }

  // --- tags (optional) ---
  let validatedTags: string[] | undefined;
  if ('tags' in input) {
    const rawTags = input['tags'];
    if (!Array.isArray(rawTags)) {
      return { ok: false, code: 'TAGS_NOT_ARRAY', error: 'Field "tags" must be an array.' };
    }
    if (rawTags.length > MAX_TAGS) {
      return { ok: false, code: 'TAGS_TOO_MANY', error: `Field "tags" must have at most ${MAX_TAGS} entries.` };
    }
    for (const tag of rawTags) {
      if (typeof tag !== 'string') {
        return { ok: false, code: 'TAG_INVALID_CHARS', error: 'Each tag must be a string.' };
      }
      const trimmedTag = tag.trim();
      if (trimmedTag.length > MAX_TAG) {
        return { ok: false, code: 'TAG_TOO_LONG', error: `Each tag must be at most ${MAX_TAG} characters after trimming.` };
      }
      if (!TAG_RE.test(trimmedTag)) {
        return {
          ok: false,
          code: 'TAG_INVALID_CHARS',
          error: 'Tags must not contain whitespace, commas, or YAML-reserved characters ([ ] { } |).',
        };
      }
    }
    validatedTags = (rawTags as string[]).map((t) => t.trim());
  }

  // --- notes (optional) ---
  let validatedNotes: string | undefined;
  if ('notes' in input) {
    const rawNotes = input['notes'];
    if (typeof rawNotes !== 'string') {
      return { ok: false, code: 'NOTES_NOT_STRING', error: 'Field "notes" must be a string.' };
    }
    if (rawNotes.length > MAX_NOTES) {
      return { ok: false, code: 'NOTES_TOO_LONG', error: `Field "notes" must be at most ${MAX_NOTES} characters.` };
    }
    if (rawNotes.includes('\x00')) {
      return { ok: false, code: 'NOTES_INVALID_CHARS', error: 'Field "notes" cannot contain null bytes.' };
    }
    validatedNotes = rawNotes;
  }

  // --- progress (optional, D8.b) ---
  let validatedProgress: string | undefined;
  if ('progress' in input) {
    const rawProgress = input['progress'];
    if (typeof rawProgress !== 'string') {
      return { ok: false, code: 'PROGRESS_NOT_STRING', error: 'Field "progress" must be a string.' };
    }
    if (rawProgress.length > MAX_PROGRESS) {
      return { ok: false, code: 'PROGRESS_TOO_LONG', error: `Field "progress" must be at most ${MAX_PROGRESS} characters.` };
    }
    if (rawProgress.includes('\x00')) {
      return { ok: false, code: 'PROGRESS_INVALID_CHARS', error: 'Field "progress" cannot contain null bytes.' };
    }
    validatedProgress = rawProgress;
  }

  // --- parentId (optional) ---
  let validatedParentId: string | null | undefined;
  if ('parentId' in input) {
    const rawParentId = input['parentId'];
    if (rawParentId === null) {
      validatedParentId = null;
    } else if (typeof rawParentId !== 'string' || !PARENT_ID_RE.test(rawParentId)) {
      return {
        ok: false,
        code: 'PARENT_ID_INVALID_FORMAT',
        error: 'Field "parentId" must be null or a valid item id (format: YYYY-MM-DD-xxxx).',
      };
    } else {
      // Goals cannot have parents (D8 invariant).
      if (validatedType === 'goal') {
        return {
          ok: false,
          code: 'CREATE_PARENT_ON_GOAL',
          error: 'Goals cannot have a parent. Remove "parentId" or set it to null.',
        };
      }
      validatedParentId = rawParentId;
    }
  }

  // Build the validated input object with EXPLICIT field copy (RA2 principle).
  const validatedInput: CreateItemInput = {
    type: validatedType,
    title: trimmedTitle,
  };
  if (validatedDue !== undefined) validatedInput.due = validatedDue;
  if (validatedTags !== undefined) validatedInput.tags = validatedTags;
  if (validatedNotes !== undefined) validatedInput.notes = validatedNotes;
  if (validatedProgress !== undefined) validatedInput.progress = validatedProgress;
  if (validatedParentId !== undefined) validatedInput.parentId = validatedParentId;

  return { ok: true, input: validatedInput };
}
