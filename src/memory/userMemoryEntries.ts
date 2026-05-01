/**
 * Keyed memory entry CRUD for per-user memory files (v1.17.0 + v1.18.0).
 *
 * ADR 017 R3 SOLE-WRITER INVARIANT (BINDING):
 *   userMemoryEntries.ts is the SOLE WRITER for keyed memory entries.
 *   All CRUD on entries containing `<!-- key:* -->` sentinels MUST go through
 *   the exported functions here.
 *   userMemory.ts.appendUserMemoryEntry() continues to work for UNKEYED appends
 *   only (the chat-side "remember I'm a data scientist" flow). DO NOT bypass.
 *
 * ADR 017 F1 SENTINEL FORMAT (BINDING):
 *   Keyed entries use `- <!-- key:my_pref --> body text here` format.
 *   The body MUST NOT contain `<!-- key:` substring (sentinel injection guard).
 *   Sentinel regex (v1.18.0 extended): /^<!--\s*key:([a-zA-Z0-9._-]{1,128})\s*-->\s*(.+)$/
 *
 * ADR 017 W4 ETAG FORMAT (BINDING):
 *   etag = '"' + sha256(mtime_iso + '|' + body).slice(0, 16) + '"'
 *   Uses Node's built-in crypto.createHash('sha256') — zero new deps.
 *
 * ADR 017 R3 READ-TIME FALLBACK (BINDING):
 *   If a bullet line starts with a sentinel that fails to parse, fall back to
 *   `legacy_<sha8>` synthetic key (sha256(category + body[0..32]).slice(0, 8)).
 *   NEVER crash on malformed sentinels.
 *
 * Key validation (v1.18.0 ADR 018 D2 extended):
 *   /^[a-zA-Z0-9._-]{1,128}$/ enforced at this layer (defense in depth).
 *   Extension rationale: coach memory keys use dotted multi-segment format
 *   e.g. `coach.2026-04-25-abcd.lastNudge`. The dot separator and uppercase
 *   are tool-layer concerns; the storage layer just sees a longer key.
 *   Existing v1.17.0 keys (lowercase, no dots) still match — no regression.
 */

import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { child } from '../logger/index.js';

const log = child({ component: 'memory.userMemoryEntries' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Key validation regex — enforced at storage layer (defense in depth).
 *
 * v1.18.0 ADR 018 D2 extension: accepts dotted multi-segment keys like
 * `coach.2026-04-25-abcd.lastNudge`. Extension vs v1.17.0:
 *   - Added `.` (dot) to the character class for dotted coach keys.
 *   - Added `A-Z` (uppercase, defensive — coach itemIds are lowercase but
 *     future keys may want camelCase namespace segments).
 *   - Length cap 64 → 128 to absorb `coach.<19-char-itemId>.<eventType>` (≤54 chars).
 * Backward compat: existing `[a-z0-9_-]` keys still match.
 */
export const MEMORY_KEY_RE = /^[a-zA-Z0-9._-]{1,128}$/;

/** Sentinel regex — matches `<!-- key:my_pref -->` at the start of a line body.
 *
 * v1.18.0: extended to accept the wider MEMORY_KEY_RE character class and length.
 */
const SENTINEL_RE = /^<!--\s*key:([a-zA-Z0-9._-]{1,128})\s*-->\s*(.+)$/;

/** Sentinel injection guard pattern — reject body containing this. */
const SENTINEL_INJECTION_RE = /<!--\s*key:/i;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MemoryEntry {
  key: string;
  /** The body text after the sentinel. */
  body: string;
  /** Strong ETag: `"<16-hex-chars>"` */
  etag: string;
  /** File mtime in milliseconds since epoch. */
  mtimeMs: number;
}

export type MemoryEntryResult =
  | { ok: true; entry: MemoryEntry }
  | { ok: false; code: 'NOT_FOUND'; error: string }
  | { ok: false; code: 'ETAG_MISMATCH'; error: string }
  | { ok: false; code: 'VALIDATION_ERROR'; error: string }
  | { ok: false; code: 'KEY_EXISTS'; error: string };

// ---------------------------------------------------------------------------
// Sentinel injection guard
// ---------------------------------------------------------------------------

/**
 * Reject bodies that contain the sentinel injection pattern.
 * Called from createEntry + updateEntry BEFORE the privacy filter.
 * (F1 binding)
 */
function rejectSentinelInjection(body: string): { ok: true } | { ok: false; error: string } {
  if (SENTINEL_INJECTION_RE.test(body)) {
    return {
      ok: false,
      error: 'Memory body must not contain <!-- key: substring (sentinel injection guard).',
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Key validation
// ---------------------------------------------------------------------------

function validateKey(key: string): { ok: true } | { ok: false; error: string } {
  if (!MEMORY_KEY_RE.test(key)) {
    return {
      ok: false,
      error: `Invalid key "${key}" — must match /^[a-zA-Z0-9._-]{1,128}$/`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// File path helper
// ---------------------------------------------------------------------------

/** Resolve the absolute path to the per-user memory file. */
function memoryFilePath(userId: number, dataDir: string): string {
  const safeId = Math.abs(Math.floor(Number(userId)));
  if (!Number.isFinite(safeId) || safeId === 0) {
    throw new Error(`Invalid userId for memory path: ${userId}`);
  }
  return path.resolve(dataDir, 'memories', `${safeId}.md`);
}

// ---------------------------------------------------------------------------
// ETag computation (W4 binding)
// ---------------------------------------------------------------------------

/**
 * Compute a strong ETag for a keyed entry.
 * Format: `"<sha256(mtime_iso + '|' + body).slice(0, 16)>"`
 * Matches v1.14.4 strong-format pattern. Uses Node's built-in crypto only.
 */
function computeEtag(mtimeMs: number, body: string): string {
  const mtimeIso = new Date(mtimeMs).toISOString();
  const hash = createHash('sha256').update(mtimeIso + '|' + body).digest('hex').slice(0, 16);
  return `"${hash}"`;
}

// ---------------------------------------------------------------------------
// Synthetic key for malformed sentinels (R3 read-time fallback)
// ---------------------------------------------------------------------------

function syntheticKey(category: string, bodySlice: string): string {
  const sha8 = createHash('sha256').update(category + bodySlice).digest('hex').slice(0, 8);
  return `legacy_${sha8}`;
}

// ---------------------------------------------------------------------------
// File read/write helpers
// ---------------------------------------------------------------------------

/** Read the raw markdown content of the memory file. Returns '' if not found. */
async function readMemoryFile(userId: number, dataDir: string): Promise<string> {
  const filePath = memoryFilePath(userId, dataDir);
  if (!existsSync(filePath)) return '';
  try {
    return await readFile(filePath, 'utf8');
  } catch (err) {
    log.warn(
      { userId, err: err instanceof Error ? err.message : String(err) },
      'userMemoryEntries: failed to read memory file',
    );
    return '';
  }
}

/** Get file mtime in ms. Returns Date.now() if file doesn't exist (shouldn't happen after write). */
async function getFileMtime(userId: number, dataDir: string): Promise<number> {
  const filePath = memoryFilePath(userId, dataDir);
  try {
    const s = await stat(filePath);
    return s.mtimeMs;
  } catch {
    return Date.now();
  }
}

/** Atomic write via temp-then-rename (same pattern as userMemory.ts). */
async function writeAtomically(filePath: string, content: string): Promise<void> {
  const tmp = filePath + '.entries.tmp';
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Parse lines into entries
// ---------------------------------------------------------------------------

/**
 * Parse all bullet lines from a memory file.
 *
 * Lines that match `- <!-- key:foo --> body` are extracted as keyed entries.
 * Lines that start with `- ` but don't match the sentinel pattern are
 * treated as unkeyed (legacy) entries and returned with synthetic keys
 * (R3 read-time fallback).
 *
 * @param content  Raw file content.
 * @param mtimeMs  File mtime used for ETag computation.
 * @returns Array of MemoryEntry (keyed + legacy fallback entries).
 */
function parseEntries(content: string, mtimeMs: number): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  const lines = content.split('\n');
  let currentCategory = 'unknown';

  for (const line of lines) {
    // Track the current section heading for synthetic key generation.
    const headingMatch = /^##\s+(.+)$/.exec(line);
    if (headingMatch) {
      currentCategory = (headingMatch[1] ?? 'unknown').toLowerCase().replace(/\s+/g, '_');
      continue;
    }

    if (!line.startsWith('- ')) continue;

    const bulletBody = line.slice(2); // strip '- '

    // Try to match the sentinel pattern
    const sentinelMatch = SENTINEL_RE.exec(bulletBody);
    if (sentinelMatch) {
      const key = sentinelMatch[1] ?? '';
      const body = sentinelMatch[2] ?? '';
      if (MEMORY_KEY_RE.test(key) && body.length > 0) {
        entries.push({
          key,
          body,
          etag: computeEtag(mtimeMs, body),
          mtimeMs,
        });
      } else {
        // Malformed: key doesn't match regex or body is empty
        log.debug(
          { key, bodyLen: body.length },
          'userMemoryEntries: malformed sentinel key/body — using legacy fallback',
        );
        const fallbackKey = syntheticKey(currentCategory, bulletBody.slice(0, 32));
        entries.push({
          key: fallbackKey,
          body: bulletBody,
          etag: computeEtag(mtimeMs, bulletBody),
          mtimeMs,
        });
      }
    } else if (/<!--\s*key:/.test(bulletBody)) {
      // Partial/truncated sentinel (e.g., `<!-- key:my_pre body text` without closing `-->`)
      log.debug(
        { bulletBody: bulletBody.slice(0, 40) },
        'userMemoryEntries: partial/truncated sentinel — using legacy fallback',
      );
      const fallbackKey = syntheticKey(currentCategory, bulletBody.slice(0, 32));
      entries.push({
        key: fallbackKey,
        body: bulletBody,
        etag: computeEtag(mtimeMs, bulletBody),
        mtimeMs,
      });
    }
    // Unkeyed bullets (no sentinel) are not yielded as keyed entries.
    // They are preserved in the file on write (we only rewrite the sentinel lines).
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Write helpers — update/delete sentinel lines in-place
// ---------------------------------------------------------------------------

/** Build a sentinel line from a key and body. */
function buildSentinelLine(key: string, body: string): string {
  return `- <!-- key:${key} --> ${body}`;
}

/**
 * Insert a new sentinel line into the memory file.
 *
 * Appends to the end of the file (after all existing content).
 * Creates the file with minimal scaffold if it doesn't exist.
 */
async function insertSentinelLine(
  userId: number,
  dataDir: string,
  key: string,
  body: string,
): Promise<void> {
  const filePath = memoryFilePath(userId, dataDir);
  await mkdir(path.dirname(filePath), { recursive: true });

  let content = await readMemoryFile(userId, dataDir);
  if (content.trim().length === 0) {
    content = `# Memory for user ${userId}\n\n`;
  }
  if (!content.endsWith('\n')) content += '\n';
  content += buildSentinelLine(key, body) + '\n';
  await writeAtomically(filePath, content);
}

/**
 * Update an existing sentinel line in the memory file.
 * Finds the line matching `- <!-- key:${key} -->` and replaces it.
 * Returns false if no matching line found.
 */
async function updateSentinelLine(
  userId: number,
  dataDir: string,
  key: string,
  newBody: string,
): Promise<boolean> {
  const content = await readMemoryFile(userId, dataDir);
  if (!content) return false;

  const lines = content.split('\n');
  let found = false;
  const updated = lines.map((line) => {
    if (!line.startsWith('- ')) return line;
    const match = SENTINEL_RE.exec(line.slice(2));
    if (match && match[1] === key) {
      found = true;
      return buildSentinelLine(key, newBody);
    }
    return line;
  });

  if (!found) return false;
  const filePath = memoryFilePath(userId, dataDir);
  await writeAtomically(filePath, updated.join('\n'));
  return true;
}

/**
 * Delete an existing sentinel line from the memory file.
 * Returns false if no matching line found.
 */
async function deleteSentinelLine(
  userId: number,
  dataDir: string,
  key: string,
): Promise<boolean> {
  const content = await readMemoryFile(userId, dataDir);
  if (!content) return false;

  const lines = content.split('\n');
  let found = false;
  const kept = lines.filter((line) => {
    if (!line.startsWith('- ')) return true;
    const match = SENTINEL_RE.exec(line.slice(2));
    if (match && match[1] === key) {
      found = true;
      return false;
    }
    return true;
  });

  if (!found) return false;
  const filePath = memoryFilePath(userId, dataDir);
  await writeAtomically(filePath, kept.join('\n'));
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List all keyed entries in the user's memory file.
 *
 * Includes legacy entries with synthetic keys for malformed sentinels
 * (R3 read-time fallback).
 */
export async function listEntries(userId: number, dataDir: string): Promise<MemoryEntry[]> {
  const content = await readMemoryFile(userId, dataDir);
  if (!content) return [];
  const mtimeMs = await getFileMtime(userId, dataDir);
  return parseEntries(content, mtimeMs);
}

/**
 * Get a single keyed entry by key.
 * Returns null if no entry with that key exists.
 */
export async function getEntry(
  userId: number,
  dataDir: string,
  key: string,
): Promise<MemoryEntry | null> {
  const keyValidation = validateKey(key);
  if (!keyValidation.ok) return null;

  const entries = await listEntries(userId, dataDir);
  return entries.find((e) => e.key === key) ?? null;
}

/**
 * Create a new keyed entry.
 *
 * Returns VALIDATION_ERROR if:
 *   - key doesn't match /^[a-z0-9_-]{1,64}$/
 *   - body contains `<!-- key:` sentinel injection pattern
 *   - body is empty
 *
 * Returns KEY_EXISTS if a keyed entry with this key already exists.
 */
export async function createEntry(
  userId: number,
  dataDir: string,
  key: string,
  body: string,
): Promise<MemoryEntryResult> {
  const keyValidation = validateKey(key);
  if (!keyValidation.ok) {
    return { ok: false, code: 'VALIDATION_ERROR', error: keyValidation.error };
  }

  const injectionCheck = rejectSentinelInjection(body);
  if (!injectionCheck.ok) {
    return { ok: false, code: 'VALIDATION_ERROR', error: injectionCheck.error };
  }

  const trimmedBody = body.trim();
  if (trimmedBody.length === 0) {
    return { ok: false, code: 'VALIDATION_ERROR', error: 'Memory body must not be empty' };
  }

  // Check for duplicate key
  const existing = await getEntry(userId, dataDir, key);
  if (existing !== null) {
    return { ok: false, code: 'KEY_EXISTS', error: `Entry with key "${key}" already exists` };
  }

  await insertSentinelLine(userId, dataDir, key, trimmedBody);

  const mtimeMs = await getFileMtime(userId, dataDir);
  const etag = computeEtag(mtimeMs, trimmedBody);
  log.info({ userId, key }, 'userMemoryEntries: entry created');
  return { ok: true, entry: { key, body: trimmedBody, etag, mtimeMs } };
}

/**
 * Update an existing keyed entry (If-Match ETag support per W4).
 *
 * If `expectedEtag` is provided and does not match the current ETag,
 * returns ETAG_MISMATCH (412 precondition failed).
 *
 * Returns NOT_FOUND if no entry with that key exists.
 * Returns VALIDATION_ERROR if body contains sentinel injection pattern.
 */
export async function updateEntry(
  userId: number,
  dataDir: string,
  key: string,
  newBody: string,
  expectedEtag?: string,
): Promise<MemoryEntryResult> {
  const keyValidation = validateKey(key);
  if (!keyValidation.ok) {
    return { ok: false, code: 'VALIDATION_ERROR', error: keyValidation.error };
  }

  const injectionCheck = rejectSentinelInjection(newBody);
  if (!injectionCheck.ok) {
    return { ok: false, code: 'VALIDATION_ERROR', error: injectionCheck.error };
  }

  const trimmedBody = newBody.trim();
  if (trimmedBody.length === 0) {
    return { ok: false, code: 'VALIDATION_ERROR', error: 'Memory body must not be empty' };
  }

  const existing = await getEntry(userId, dataDir, key);
  if (existing === null) {
    return { ok: false, code: 'NOT_FOUND', error: `No entry with key "${key}" found` };
  }

  // If-Match ETag check
  if (expectedEtag !== undefined && expectedEtag !== existing.etag) {
    return {
      ok: false,
      code: 'ETAG_MISMATCH',
      error: `ETag mismatch: expected ${expectedEtag}, got ${existing.etag}`,
    };
  }

  const updated = await updateSentinelLine(userId, dataDir, key, trimmedBody);
  if (!updated) {
    return { ok: false, code: 'NOT_FOUND', error: `No entry with key "${key}" found` };
  }

  const mtimeMs = await getFileMtime(userId, dataDir);
  const etag = computeEtag(mtimeMs, trimmedBody);
  log.info({ userId, key }, 'userMemoryEntries: entry updated');
  return { ok: true, entry: { key, body: trimmedBody, etag, mtimeMs } };
}

/**
 * Delete a keyed entry.
 * Returns NOT_FOUND if no entry with that key exists.
 */
export async function deleteEntry(
  userId: number,
  dataDir: string,
  key: string,
): Promise<{ ok: true } | { ok: false; code: 'NOT_FOUND'; error: string } | { ok: false; code: 'VALIDATION_ERROR'; error: string }> {
  const keyValidation = validateKey(key);
  if (!keyValidation.ok) {
    return { ok: false, code: 'VALIDATION_ERROR', error: keyValidation.error };
  }

  const deleted = await deleteSentinelLine(userId, dataDir, key);
  if (!deleted) {
    return { ok: false, code: 'NOT_FOUND', error: `No entry with key "${key}" found` };
  }

  log.info({ userId, key }, 'userMemoryEntries: entry deleted');
  return { ok: true };
}
