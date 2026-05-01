/**
 * ETag computation for /organize items (v1.14.4).
 *
 * Single source of truth for ETag format used by:
 *   - items.read.ts  (GET /:id response header)
 *   - items.mutate.ts (PATCH / DELETE / POST /complete response headers + 412 envelope)
 *   - storage.ts     (ETAG_MISMATCH check inside updateItem + softDeleteItem)
 */

import type { OrganizeFrontMatter } from './types.js';

/**
 * Compute a strong ETag for an organize item.
 *
 * Format: `"<iso-8601>"` — the double-quotes are part of the ETag value (RFC 7232 §2.3).
 *
 * Source priority:
 *   1. fm.updated  — stamped on every write path since v1.14.3; monotonically advances.
 *   2. fileMtimeMs fallback — used for older items not yet written under v1.14.3.
 *
 * FAT/exFAT 2-second mtime resolution edge case: documented in ADR 012 R5 and
 * KNOWN_ISSUES.md. The fallback ETag is consumed on the FIRST write to the item
 * (which stamps `updated:`); subsequent ETags are `updated:`-based and collision-safe.
 */
export function computeETag(fm: OrganizeFrontMatter, fileMtimeMs: number): string {
  const iso = fm.updated ?? new Date(fileMtimeMs).toISOString();
  return `"${iso}"`;
}

/**
 * Strong ETag equality check. Quotes-sensitive per RFC 7232 §2.3.2.
 * Compares byte-equal after trim (defense-in-depth: callers must trim, but
 * etagsMatch trims internally so a caller passing un-trimmed whitespace does
 * not silently produce a false mismatch).
 */
export function etagsMatch(a: string, b: string): boolean {
  return a.trim() === b.trim();
}
