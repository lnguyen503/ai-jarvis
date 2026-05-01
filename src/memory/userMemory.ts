/**
 * Per-user persistent memory (v1.8.5).
 *
 * Each user gets a single markdown file at `data/memories/<userId>.md`.
 * The file is human-readable, hand-editable, and follows a stable
 * section structure so the agent's view of the user is consistent
 * across chats and platforms.
 *
 * Per-USER, not per-chat — the same Boss in DM, group A, and group B
 * sees one consistent memory. In group chats, only the speaker's
 * memory is loaded for any given turn (different users in the same
 * room get personalized context).
 *
 * Storage choice: plain markdown over SQLite. Three reasons:
 *   1. The user can `read_file` it from chat to inspect what Jarvis "knows."
 *   2. Manual edits work — open in any editor, save, no schema migration.
 *   3. /memory clear == delete file. /memory forget X == grep + rewrite.
 *
 * Privacy posture: see src/memory/userMemoryPrivacy.ts. Writes are filtered
 * BEFORE landing here. This file just persists what was already approved.
 */

import { readFile, writeFile, mkdir, unlink, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { child } from '../logger/index.js';

const log = child({ component: 'memory.user' });

/** Stable section order so the file shape doesn't drift across writes. */
export type MemoryCategory = 'profile' | 'preferences' | 'projects' | 'people' | 'avoid';

/** Heading shown above each section in the file. Order matters. */
const SECTION_HEADINGS: Array<{ category: MemoryCategory; heading: string; description: string }> = [
  {
    category: 'profile',
    heading: 'Profile',
    description: 'Stable facts the user has chosen to share (role, languages, time zone, OS, expertise level).',
  },
  {
    category: 'preferences',
    heading: 'Preferences',
    description: 'How the user wants Jarvis to respond (reply length, tone, default model, formatting).',
  },
  {
    category: 'projects',
    heading: 'Projects',
    description: 'Recurring work the user references — name, path, tech stack, deploy target.',
  },
  {
    category: 'people',
    heading: 'People',
    description: 'Names of people the user references repeatedly + their relationship to the user (no third-party private info).',
  },
  {
    category: 'avoid',
    heading: 'Avoid',
    description: 'Behaviors Jarvis should NOT do — explicit corrections the user has given.',
  },
];

/** Resolve the absolute path to the per-user memory file. */
export function userMemoryPath(userId: number, dataDir: string): string {
  // Use absolute integer to defend against any caller passing a string id.
  const safeId = Math.abs(Math.floor(Number(userId)));
  if (!Number.isFinite(safeId) || safeId === 0) {
    throw new Error(`Invalid userId for memory path: ${userId}`);
  }
  return path.resolve(dataDir, 'memories', `${safeId}.md`);
}

/** Build an empty memory file scaffold so newly-created files have the
 *  full section structure (makes append/forget operations simpler). */
function emptyScaffold(displayName: string): string {
  const header = `# Memory for ${displayName}\n\n_This file persists across all chats. Updated by Jarvis when you say "remember…" or "forget…". Manually editable; deleted via /memory clear._\n\n`;
  const sections = SECTION_HEADINGS.map(
    (s) => `## ${s.heading}\n\n_${s.description}_\n\n_(empty)_\n\n`,
  ).join('');
  return header + sections;
}

/** Read a user's memory file. Returns "" if no file exists. */
export async function readUserMemory(
  userId: number,
  dataDir: string,
): Promise<string> {
  const filePath = userMemoryPath(userId, dataDir);
  if (!existsSync(filePath)) return '';
  try {
    return await readFile(filePath, 'utf8');
  } catch (err) {
    log.warn(
      { userId, err: err instanceof Error ? err.message : String(err) },
      'Failed to read user memory file',
    );
    return '';
  }
}

/**
 * Append an entry under the given category. Creates the file with the
 * full scaffold on first write so subsequent operations have stable
 * section landmarks to anchor against.
 *
 * `fact` is assumed to already have passed the privacy filter; this
 * function does not re-validate (single point of truth).
 *
 * ADR 017 R3 SOLE-WRITER INVARIANT: This function is for UNKEYED appends only.
 * It MUST NOT write `<!-- key:* -->` sentinel lines. Keyed entry CRUD goes
 * through userMemoryEntries.ts exclusively. Do NOT add sentinel support here.
 */
export async function appendUserMemoryEntry(
  userId: number,
  category: MemoryCategory,
  fact: string,
  displayName: string,
  dataDir: string,
): Promise<{ ok: true }> {
  const filePath = userMemoryPath(userId, dataDir);
  await mkdir(path.dirname(filePath), { recursive: true });

  let body = await readUserMemory(userId, dataDir);
  if (body.trim().length === 0) {
    body = emptyScaffold(displayName);
  }

  const heading = SECTION_HEADINGS.find((s) => s.category === category)?.heading;
  if (!heading) throw new Error(`Unknown memory category: ${category}`);

  // Find the section's bullet block. Each section is bounded by the next
  // "## " heading or true end-of-file. NO `m` flag: with multiline,
  // `$` matches every line boundary, which causes `\n*$` to short-
  // circuit before the lazy prefix can engulf the section's `_(empty)_`
  // line. Without `m`, `$` is true end-of-string.
  const sectionRegex = new RegExp(`(##\\s+${heading}\\s*\\n[\\s\\S]*?)(\\n##\\s+|\\n*$)`);
  let match = sectionRegex.exec(body);
  if (!match) {
    // Section heading missing — re-scaffold and retry.
    body = emptyScaffold(displayName);
    match = sectionRegex.exec(body);
    if (!match) throw new Error('Memory scaffold corrupted');
  }

  // Strip the "_(empty)_" placeholder if present, then append the bullet.
  let sectionBody = (match[1] ?? '').replace(/\n_\(empty\)_\n*$/, '\n');
  if (!sectionBody.endsWith('\n')) sectionBody += '\n';
  sectionBody += `- ${fact.trim()}\n`;
  if (!sectionBody.endsWith('\n\n')) sectionBody += '\n';

  const updatedBody = body.replace(sectionRegex, sectionBody + (match[2] ?? ''));

  // Update timestamp at the top.
  const stamped = stampUpdatedAt(updatedBody);

  await writeAtomically(filePath, stamped);
  log.info({ userId, category, factLen: fact.length }, 'User-memory entry appended');
  return { ok: true };
}

/**
 * Delete every bullet line that contains the topic substring (case-
 * insensitive). Returns the count of removed entries. Empty sections
 * fall back to "_(empty)_" placeholder so the file shape stays stable.
 */
export async function forgetUserMemoryEntries(
  userId: number,
  topic: string,
  dataDir: string,
): Promise<{ removed: number }> {
  const body = await readUserMemory(userId, dataDir);
  if (!body) return { removed: 0 };

  const needle = topic.trim().toLowerCase();
  if (needle.length < 2) return { removed: 0 };

  let removed = 0;
  const lines = body.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    if (line.startsWith('- ') && line.toLowerCase().includes(needle)) {
      removed++;
      continue;
    }
    kept.push(line);
  }
  if (removed === 0) return { removed: 0 };

  // Restore "_(empty)_" placeholder under any section that lost all bullets.
  // NOTE: no `m` flag — see explanatory comment in appendUserMemoryEntry.
  let rebuilt = kept.join('\n');
  for (const { heading } of SECTION_HEADINGS) {
    const sectionRegex = new RegExp(
      `(##\\s+${heading}\\s*\\n[\\s\\S]*?\\n)(?=##\\s+|$)`,
    );
    rebuilt = rebuilt.replace(sectionRegex, (match) => {
      const hasBullet = /\n-\s/.test(match);
      const hasEmpty = /_\(empty\)_/.test(match);
      if (!hasBullet && !hasEmpty) {
        return match.replace(/\n+$/, '\n') + '\n_(empty)_\n\n';
      }
      return match;
    });
  }

  const stamped = stampUpdatedAt(rebuilt);
  await writeAtomically(userMemoryPath(userId, dataDir), stamped);
  log.info({ userId, topic, removed }, 'User-memory entries forgotten');
  return { removed };
}

/** Delete the entire memory file for this user. No-op if it doesn't exist. */
export async function clearUserMemory(
  userId: number,
  dataDir: string,
): Promise<{ ok: true }> {
  const filePath = userMemoryPath(userId, dataDir);
  if (!existsSync(filePath)) return { ok: true };
  await unlink(filePath);
  log.info({ userId }, 'User memory cleared');
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function stampUpdatedAt(body: string): string {
  const stamp = `_Last updated: ${new Date().toISOString()}_`;
  if (/_Last updated: [^_]+_/.test(body)) {
    return body.replace(/_Last updated: [^_]+_/, stamp);
  }
  // Insert just under the H1 header.
  return body.replace(/^(# .+\n\n)/, `$1${stamp}\n\n`);
}

/** Atomic write via temp-then-rename so a crash mid-write can't truncate
 *  the user's memory. */
async function writeAtomically(filePath: string, content: string): Promise<void> {
  const tmp = filePath + '.tmp';
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, filePath);
}
