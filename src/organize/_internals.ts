/**
 * Internal shared helpers for the organize storage layer (v1.15.0).
 *
 * Extracted from storage.ts (D10, ADR 015 + ADR 014 F4) to close the
 * single-source-of-truth violation (Anti-Slop §5) where both storage.ts and
 * trash.ts previously held identical copies of these two helpers.
 *
 * Dependency edge: both storage.ts and trash.ts import from here.
 * _internals.ts does NOT import from storage.ts or trash.ts.
 *
 * Extracted helpers:
 *   - writeAtomically  — temp-then-rename atomic file write (v1.14.2 R8 / SF-7)
 *   - serializeItem    — canonical front-matter + body serializer
 *
 * Zero logic change from the storage.ts originals. Bug-for-bug identical.
 */

import { writeFile, rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type { OrganizeFrontMatter } from './types.js';
import { COACH_INTENSITIES } from '../coach/intensityTypes.js';

// ---------------------------------------------------------------------------
// Atomic write helper
// ---------------------------------------------------------------------------

/**
 * Atomically write `content` to `filePath` using a temp-then-rename strategy.
 *
 * Each call generates a per-call random hex suffix for the tmp path
 * (`${filePath}.<6-byte-hex>.tmp`) so that concurrent callers never share the
 * same tmp filename. Without this, two concurrent writers would interleave
 * their writes to the SAME `.tmp` file, producing hybrid/corrupt content that
 * lands as the live file on the next rename. The random suffix de-collides the
 * WRITE boundary; the OS-atomic rename still guarantees the PUBLISH boundary.
 *
 * Last-rename-wins semantics: if two callers race, the final live file matches
 * whichever writer's rename executed last. No data corruption, no ENOENT on
 * the second rename (each writer renames its OWN tmp file).
 *
 * Stale `.tmp` files from a crashed process are harmless — `listItems` only
 * loads files matching the `<id>.md` pattern; a `<id>.<hex>.tmp` orphan is
 * ignored by all readers.
 *
 * Introduced in v1.14.2 (R8 / SF-7) to fix the latent race window exposed
 * by the new HTTP mutation path. Affects all four mutation paths that call
 * this function: createItem, updateItem, softDeleteItem, appendProgressEntry.
 *
 * Extracted to _internals.ts in v1.15.0 (D10, ADR 015) to close the
 * Anti-Slop §5 single-source-of-truth violation (storage.ts + trash.ts both
 * had identical copies).
 */
export async function writeAtomically(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Serializer — canonical front-matter + body shape
// ---------------------------------------------------------------------------

/**
 * Serialize an organize item into its canonical on-disk Markdown representation.
 *
 * Field order is normalized on every save (the managed-by comment reflects this).
 * Optional fields (deletedAt, updated) are emitted ONLY when non-null/non-undefined:
 *   - deletedAt: v1.11.0 R3 — omit for live items and legacy trash without the field.
 *   - updated:   v1.14.3 D1 — omit for legacy items (tolerant parser fills null on read).
 *
 * Extracted to _internals.ts in v1.15.0 (D10, ADR 015) to close the
 * Anti-Slop §5 single-source-of-truth violation. Future front-matter schema
 * changes only need to land here; storage.ts and trash.ts both import this.
 */
export function serializeItem(fm: OrganizeFrontMatter, notesBody: string, progressBody: string): string {
  const tags = fm.tags.length > 0
    ? `[${fm.tags.join(', ')}]`
    : '[]';

  const frontMatterLines = [
    '---',
    `id: ${fm.id}`,
    `type: ${fm.type}`,
    `status: ${fm.status}`,
    `title: ${fm.title}`,
    `created: ${fm.created}`,
    `due: ${fm.due ?? ''}`,
    `parentId: ${fm.parentId ?? ''}`,
    `calendarEventId: ${fm.calendarEventId ?? ''}`,
  ];
  // v1.11.0 R3: emit deletedAt ONLY when non-null; omit entirely for live items and legacy trash.
  if (fm.deletedAt != null) {
    frontMatterLines.push(`deletedAt: ${fm.deletedAt}`);
  }
  // v1.14.3 D1: emit updated ONLY when present; omit for legacy items (tolerant parser fills null on read).
  if (fm.updated != null) {
    frontMatterLines.push(`updated: ${fm.updated}`);
  }
  // v1.18.0 ADR 018 D1 + v1.19.0 D1:
  //   Emit coachIntensity ONLY when !== 'off' AND !== 'auto'.
  //   'off'  → omitted (legacy compat: missing field treated as 'off' by v1.18.0 readers).
  //   'auto' → omitted (v1.19.0 default: missing field reads as 'auto'; no need to write it back).
  //   Both defaults are implied by absence; writing them pollutes legacy items unnecessarily.
  if (fm.coachIntensity != null && fm.coachIntensity !== 'off' && fm.coachIntensity !== 'auto') {
    // Validate against closed set at write time (defense in depth).
    if ((COACH_INTENSITIES as readonly string[]).includes(fm.coachIntensity)) {
      frontMatterLines.push(`coachIntensity: ${fm.coachIntensity}`);
    }
  }
  // v1.18.0 ADR 018 D1: emit coachNudgeCount ONLY when > 0 (omission === 0 for legacy compat).
  if (fm.coachNudgeCount != null && fm.coachNudgeCount > 0) {
    frontMatterLines.push(`coachNudgeCount: ${fm.coachNudgeCount}`);
  }
  frontMatterLines.push(`tags: ${tags}`, '---');
  const frontMatter = frontMatterLines.join('\n');

  const header = '<!-- Managed by Jarvis /organize. Field order is normalized on every save. -->';

  const notesSec = `## Notes\n${notesBody}`;
  const progressSec = `## Progress\n${progressBody}`;

  return `${frontMatter}\n\n${header}\n\n${notesSec}\n\n${progressSec}\n`;
}
