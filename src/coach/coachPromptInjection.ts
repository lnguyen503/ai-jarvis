/**
 * coachPromptInjection.ts — Build the active-items block for coach turns
 * with Layer (b) <untrusted> wrap (v1.19.0 fix-loop).
 *
 * Owned by the coach trust boundary. Wired into agent.turn() in src/agent/index.ts
 * for turns where `params.isCoachRun === true`.
 *
 * Per ADR 019 R1 Layer (b): user-text fields (title/notes/progress) are wrapped
 * in <untrusted source="organize.item" itemId="..." field="...">...</untrusted>.
 * Layer (a) sanitizer in src/calendar/sync.ts already neutralizes the actual
 * injection threat at sync time; Layer (b) is defense-in-depth at the LLM
 * boundary so even if hostile content reaches the prompt by some other path
 * (cross-turn replay, manual file edit, future ingest path), it cannot
 * impersonate operator instructions.
 *
 * Privacy posture (binding):
 *   - Override entries in keyed memory store hash + length only (no raw fromMessage).
 *     We pass `fromMessage: ''` to the builder so the <untrusted source="user.message">
 *     boundary still emits as a structural marker without leaking content.
 *
 * Dependency edges (binding):
 *   coachPromptInjection.ts → organize/storage (listItems)
 *                           → coach/coachMemory (readCoachEntries)
 *                           → coach/coachPromptBuilder (builder + types)
 *                           → memory/userMemoryEntries (listEntries — for override scan)
 *                           → logger
 *   NO import from src/agent/** — this module is the seam.
 */

import { listItems } from '../organize/storage.js';
import { readCoachEntries, type CoachEntry } from './coachMemory.js';
import {
  buildCoachPromptWithItems,
  type OverrideIntent,
} from './coachPromptBuilder.js';
import { listEntries } from '../memory/userMemoryEntries.js';
import { child } from '../logger/index.js';

const log = child({ component: 'coach.promptInjection' });

const OVERRIDE_KEY_RE = /^coach\.([^.]+)\.userOverride$/;
const OVERRIDE_INTENT_KINDS = new Set(['back_off', 'push', 'defer', 'done_signal']);

/**
 * Build the active-items injection block for a coach turn.
 *
 * Returns empty string when the user has no active items, on any error
 * (silent-fail posture mirrors injection.ts), or when the user dir is missing.
 *
 * The leading "\n\n" separator that injection.ts conventionally emits is the
 * caller's responsibility — keeping this module's output a clean block lets
 * callers compose freely.
 */
export async function buildCoachActiveItemsBlock(
  userId: number,
  dataDir: string,
): Promise<string> {
  let items;
  try {
    items = await listItems(userId, dataDir, { status: 'active' });
  } catch (err) {
    log.warn(
      { userId, err: err instanceof Error ? err.message : String(err) },
      'coach injection: listItems failed — returning empty block',
    );
    return '';
  }

  if (items.length === 0) return '';

  // Coach memory entries (lastNudge / research / idea / plan) for these items.
  let coachEntries: CoachEntry[];
  try {
    coachEntries = await readCoachEntries(userId, dataDir);
  } catch (err) {
    log.warn(
      { userId, err: err instanceof Error ? err.message : String(err) },
      'coach injection: readCoachEntries failed — proceeding with empty list',
    );
    coachEntries = [];
  }

  // Active overrides: scan keyed memory for keys matching coach.<itemId>.userOverride.
  const overrides: OverrideIntent[] = [];
  try {
    const allEntries = await listEntries(userId, dataDir);
    const nowMs = Date.now();
    for (const entry of allEntries) {
      const m = OVERRIDE_KEY_RE.exec(entry.key);
      if (!m) continue;
      try {
        const parsed = JSON.parse(entry.body) as {
          intent?: unknown;
          expiresAtIso?: unknown;
        };
        const kind = parsed.intent;
        const expiresAtIso = parsed.expiresAtIso;
        if (
          typeof kind === 'string' &&
          OVERRIDE_INTENT_KINDS.has(kind) &&
          typeof expiresAtIso === 'string'
        ) {
          // Skip expired overrides.
          const expMs = new Date(expiresAtIso).getTime();
          if (Number.isFinite(expMs) && expMs < nowMs) continue;
          overrides.push({
            itemId: m[1]!,
            kind: kind as OverrideIntent['kind'],
            expiresAt: expiresAtIso,
            fromMessage: '', // privacy: raw text not stored — empty wrap by design
          });
        }
      } catch {
        // Malformed override entry — skip silently (keyed memory may be corrupt).
      }
    }
  } catch (err) {
    log.warn(
      { userId, err: err instanceof Error ? err.message : String(err) },
      'coach injection: listEntries (override scan) failed — proceeding without overrides',
    );
  }

  return buildCoachPromptWithItems(items, coachEntries, overrides);
}
