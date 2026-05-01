/**
 * Coach memory helpers — bounded-FIFO writer + key formatter + reader (v1.18.0 ADR 018).
 *
 * ADR 018 Decision 3 — per-item per-event-type FIFO cap of 30 entries.
 * ADR 018 Decision 14.d — audit rows carry hash+length only; body stays in keyed memory.
 * ADR 019 D11 (v1.19.0) — loadRecentNudgeHistory helper for Step 0 monitoring loop.
 *
 * Dependency graph (binding per ADR 018 Decision 15):
 *   coachMemory.ts → memory/userMemoryEntries
 *   NO import from coach/coachTools.ts, coach/index.ts, or any agent/webapp layer.
 *
 * Key format: `coach.<itemId>.<eventType>.<YYYYMMDDTHHMMSSmmmmZxxxx>`
 *   The timestamp+4-hex-random suffix gives each write a unique key even within the same ms.
 *   The key prefix `coach.<itemId>.<eventType>.` (with trailing dot) identifies the family.
 *   The 128-char limit of MEMORY_KEY_RE comfortably absorbs the full key:
 *     "coach." (6) + itemId (≤19) + "." (1) + eventType (≤9) + "." (1) + ts (19) + rand (4) = ≤59 chars.
 *   Dots in the key are only the three separators; no dots appear in the timestamp/rand portion,
 *   so the family prefix `coach.<id>.<type>.` terminates cleanly at the third dot.
 */

import { randomBytes } from 'node:crypto';
import { listEntries, createEntry, deleteEntry } from '../memory/userMemoryEntries.js';
import { child } from '../logger/index.js';

const log = child({ component: 'coach.coachMemory' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Event types the coach can log per organize item. */
export const COACH_EVENT_TYPES = ['lastNudge', 'research', 'idea', 'plan'] as const;
export type CoachEventType = (typeof COACH_EVENT_TYPES)[number];

/** FIFO cap: max entries per (itemId, eventType) family. */
export const COACH_FIFO_LIMIT = 30;

/**
 * Validate that a value is a CoachEventType.
 */
export function isCoachEventType(value: unknown): value is CoachEventType {
  return typeof value === 'string' && (COACH_EVENT_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single coach memory entry, as returned by readCoachEntries. */
export interface CoachEntry {
  /** Timestamp the entry was written (ISO 8601). */
  at: string;
  /** Event type: lastNudge | research | idea | plan */
  eventType: CoachEventType;
  /** Organize item ID this entry is associated with. */
  itemId: string;
  /** JSON-serializable payload written by the coach tool. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: Record<string, any>;
  /** Raw storage key (for deletion / debugging). */
  key: string;
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

/**
 * itemId validation regex.
 * Organize itemIds are `YYYY-MM-DD-[a-z0-9]{4}` (19 chars) by the existing convention.
 * We accept the broader set `[a-zA-Z0-9_-]+` here to tolerate test IDs and future formats.
 */
const ITEM_ID_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Format the unique storage key for a single coach memory entry.
 *
 * Pattern: `coach.<itemId>.<eventType>.<timestamp>`
 * Example: `coach.2026-04-25-abcd.lastNudge.20260425T100000123Zaf3e`
 *
 * @param itemId    - Organize item ID (validated as `[a-zA-Z0-9_-]+`).
 * @param eventType - One of the CoachEventType values.
 * @param at        - ISO timestamp for this entry (defaults to now).
 */
export function formatCoachKey(
  itemId: string,
  eventType: CoachEventType,
  at?: Date,
): string {
  if (!ITEM_ID_RE.test(itemId)) {
    throw new Error(`formatCoachKey: invalid itemId "${itemId}" — must match /^[a-zA-Z0-9_-]+$/`);
  }
  // Format: YYYYMMDDTHHMMSSmmm (compact, no separators, milliseconds appended)
  // We avoid '.' in the timestamp portion so the coach key prefix matcher (`coach.<id>.<type>.`)
  // works correctly — the family prefix ends at the third dot, and the timestamp must not add dots.
  // A 4-hex-char random suffix is appended after the timestamp to prevent key collisions when
  // multiple writes happen within the same millisecond (e.g. in tests or rapid coach tool loops).
  const d = at ?? new Date();
  const ts = d.toISOString()
    .replace(/[-:]/g, '')       // remove dashes and colons
    .replace('T', 'T')          // keep T separator
    .replace(/\.(\d{3})Z$/, '$1Z'); // fold .mmm before Z: "20260425T100000123Z"
  const rand = randomBytes(2).toString('hex'); // 4 hex chars
  return `coach.${itemId}.${eventType}.${ts}${rand}`;
}

/**
 * Return the key prefix that identifies a (itemId, eventType) family.
 * Example: `coach.2026-04-25-abcd.lastNudge.` (trailing dot is the delimiter).
 */
export function coachKeyPrefix(itemId: string, eventType: CoachEventType): string {
  return `coach.${itemId}.${eventType}.`;
}

// ---------------------------------------------------------------------------
// Body encode/decode
// ---------------------------------------------------------------------------

/**
 * Encode a coach entry body as a JSON string stored in the keyed-memory bullet.
 * Format: `{"at":"<iso>","payload":{...}}`
 * The body must NOT contain `<!-- key:` (sentinel injection guard);
 * JSON encoding of normal strings never produces that sequence.
 */
function encodeBody(at: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ at, payload });
}

/**
 * Decode a stored body string. Returns null if not valid JSON or missing `at`.
 */
function decodeBody(raw: string): { at: string; payload: Record<string, unknown> } | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>)['at'] === 'string'
    ) {
      return parsed as { at: string; payload: Record<string, unknown> };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export type CoachWriteOptions = {
  /** Per-(itemId, eventType) FIFO cap. Defaults to COACH_FIFO_LIMIT (30). */
  fifoLimit?: number;
  /**
   * Safety scrubber applied to the serialized payload BEFORE the write.
   * Must strip secrets (credential patterns, PII patterns).
   * Injected by the tool layer to keep coachMemory.ts free of safety deps.
   */
  safetyScrubber: (text: string) => string;
};

/**
 * Write a new coach memory entry for (userId, itemId, eventType).
 *
 * Enforces the bounded-FIFO cap (Decision 3):
 *   1. List all entries for the (itemId, eventType) family.
 *   2. If count >= fifoLimit, delete the entry with the oldest `at` timestamp.
 *   3. Apply safetyScrubber to the serialized body.
 *   4. Create the new entry.
 *
 * Throws on unexpected storage errors (caller's audit layer handles the error path).
 *
 * @param userId    - Owner user ID.
 * @param dataDir   - Root data directory (passed through to userMemoryEntries).
 * @param itemId    - Organize item ID.
 * @param eventType - CoachEventType.
 * @param payload   - JSON-serializable payload; scrubbed before storage.
 * @param opts      - { fifoLimit?, safetyScrubber }
 */
export async function writeCoachEntry(
  userId: number,
  dataDir: string,
  itemId: string,
  eventType: CoachEventType,
  payload: Record<string, unknown>,
  opts: CoachWriteOptions,
): Promise<void> {
  const fifoLimit = opts.fifoLimit ?? COACH_FIFO_LIMIT;
  const at = new Date().toISOString();

  // 1. List all entries in this (itemId, eventType) family.
  const prefix = coachKeyPrefix(itemId, eventType);
  const allEntries = await listEntries(userId, dataDir);
  const family = allEntries.filter((e) => e.key.startsWith(prefix));

  // 2. Prune oldest if at cap.
  if (family.length >= fifoLimit) {
    // Sort by the `at` field in the body, oldest first.
    const sorted = [...family].sort((a, b) => {
      const da = decodeBody(a.body)?.at ?? a.key;
      const db = decodeBody(b.body)?.at ?? b.key;
      return da < db ? -1 : da > db ? 1 : 0;
    });
    // Delete the oldest entries until we're under the limit.
    const deleteCount = family.length - fifoLimit + 1;
    for (let i = 0; i < deleteCount; i++) {
      const oldest = sorted[i];
      if (!oldest) continue;
      const delResult = await deleteEntry(userId, dataDir, oldest.key);
      if (!delResult.ok) {
        log.warn(
          { userId, key: oldest.key, code: delResult.code },
          'coachMemory: failed to delete oldest FIFO entry',
        );
      }
    }
  }

  // 3. Serialize + scrub the body.
  const raw = encodeBody(at, payload);
  const scrubbed = opts.safetyScrubber(raw);

  // 4. Create the new entry.
  const key = formatCoachKey(itemId, eventType, new Date(at));
  const result = await createEntry(userId, dataDir, key, scrubbed);
  if (!result.ok) {
    throw new Error(
      `coachMemory.writeCoachEntry: createEntry failed — code=${result.code} key=${key}`,
    );
  }

  log.info({ userId, itemId, eventType, key }, 'coachMemory: entry written');
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read coach memory entries for a user, optionally filtered by prefix.
 *
 * Returns entries sorted by `at` descending (newest first), limited to `limit`.
 *
 * @param userId   - Owner user ID.
 * @param dataDir  - Root data directory.
 * @param prefix   - Optional key prefix to filter (e.g. `coach.2026-04-25-abcd.`).
 *                   If omitted, returns ALL `coach.*` entries.
 * @param limit    - Maximum number of entries to return (default: COACH_FIFO_LIMIT).
 */
export async function readCoachEntries(
  userId: number,
  dataDir: string,
  prefix?: string,
  limit?: number,
): Promise<CoachEntry[]> {
  const effectivePrefix = prefix ?? 'coach.';
  const effectiveLimit = limit ?? COACH_FIFO_LIMIT;

  const allEntries = await listEntries(userId, dataDir);

  const coachEntries: CoachEntry[] = [];
  for (const entry of allEntries) {
    if (!entry.key.startsWith(effectivePrefix)) continue;

    // Parse key: coach.<itemId>.<eventType>.<timestamp>
    // key.startsWith('coach.') is guaranteed
    const withoutCoach = entry.key.slice('coach.'.length); // "<itemId>.<eventType>.<ts>"
    const firstDot = withoutCoach.indexOf('.');
    const secondDot = withoutCoach.indexOf('.', firstDot + 1);
    if (firstDot === -1 || secondDot === -1) continue; // malformed, skip

    const itemId = withoutCoach.slice(0, firstDot);
    const eventTypeRaw = withoutCoach.slice(firstDot + 1, secondDot);
    if (!isCoachEventType(eventTypeRaw)) continue; // unknown eventType, skip

    const decoded = decodeBody(entry.body);
    if (!decoded) continue; // not a coach-format body, skip

    coachEntries.push({
      at: decoded.at,
      eventType: eventTypeRaw,
      itemId,
      payload: decoded.payload,
      key: entry.key,
    });
  }

  // Sort newest first.
  coachEntries.sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : 0));

  return coachEntries.slice(0, effectiveLimit);
}

// ---------------------------------------------------------------------------
// v1.19.0 D11 — loadRecentNudgeHistory (Step 0 monitoring loop helper)
// ---------------------------------------------------------------------------

/**
 * A summarised view of a single past nudge, used by the Step 0 monitoring loop
 * in coachPrompt.md to assess recent coach engagement.
 *
 * Fields:
 *   - at         — ISO timestamp of the nudge
 *   - intensity  — intensity at nudge time ('gentle' | 'moderate' | 'persistent')
 *   - userReply  — optional: 'engaged' | 'pushback' | null (null = ignored / no reply)
 *   - outcome    — optional: free-text outcome recorded at nudge time (null if not set)
 */
export interface NudgeHistoryEntry {
  at: string;
  intensity: string | null;
  userReply: 'engaged' | 'pushback' | null;
  outcome: string | null;
}

/**
 * Return the last `n` `lastNudge` entries for a given organize item, sorted
 * newest-first. Used by the coach scheduler to build the nudge-history summary
 * injected into the coach prompt context (ADR 019 D11 — Step 0 monitoring loop).
 *
 * Returns an empty array if no nudge history exists (new item or no prior nudges).
 *
 * @param userId  - User whose memory to read.
 * @param dataDir - Absolute path to the data directory.
 * @param itemId  - Organize item ID.
 * @param n       - Maximum number of entries to return (default 3, per D11 spec).
 */
export async function loadRecentNudgeHistory(
  userId: number,
  dataDir: string,
  itemId: string,
  n = 3,
): Promise<NudgeHistoryEntry[]> {
  const prefix = coachKeyPrefix(itemId, 'lastNudge');
  const entries = await readCoachEntries(userId, dataDir, prefix, n);

  return entries.map((entry): NudgeHistoryEntry => {
    const payload = entry.payload as Record<string, unknown>;

    const intensity = typeof payload['intensity'] === 'string' ? payload['intensity'] : null;

    const rawReply = payload['userReply'];
    const userReply: NudgeHistoryEntry['userReply'] =
      rawReply === 'engaged' ? 'engaged'
      : rawReply === 'pushback' ? 'pushback'
      : null;

    const rawOutcome = payload['outcome'];
    const outcome = typeof rawOutcome === 'string' ? rawOutcome : null;

    return { at: entry.at, intensity, userReply, outcome };
  });
}
