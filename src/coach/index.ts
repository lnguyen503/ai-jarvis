/**
 * Coach module orchestration (v1.18.0 ADR 018 + v1.20.0 ADR 020).
 *
 * Exports:
 *   W2.a named constants (v1.18.0):
 *     COACH_TASK_DESCRIPTION — legacy sentinel description (v1.18.0/v1.19.0); @deprecated in v1.20.0.
 *     COACH_PROMPT_PLACEHOLDER — sentinel command value expanded to the coach prompt at fire time.
 *
 *   v1.20.0 multi-profile marker constants (ADR 020 D2):
 *     COACH_MARKER_BY_PROFILE — Record<CoachProfile, string> mapping profiles to markers.
 *     LEGACY_COACH_MARKER — '__coach__' (deprecated; migration target).
 *     COACH_PROFILE_MARKERS — ReadonlySet<string> of all 4 profile marker values.
 *     COACH_MARKER_PREFIX / COACH_MARKER_SUFFIX — for LIKE filtering.
 *     isCoachMarker(description) — true for any of the 4 profile markers OR legacy.
 *     profileFromMarker(description) — CoachProfile | null.
 *
 *   v1.20.0 helper (ADR 020 R1 — CP1 revisions):
 *     buildCoachTurnArgs(opts) — canonical TurnParams shape for ALL coach-turn entry points.
 *       BINDING: every coach-turn call (scheduled + spontaneous) MUST use this helper.
 *       Static test tests/static/coach-turn-args.test.ts enforces.
 *
 *   loadCoachPrompt()    — reads + caches coachPrompt.md.
 *   expandCoachPromptToken(command, triggerContext?) — expands COACH_PROMPT_PLACEHOLDER
 *                          and optionally ${trigger_context} (ADR 020 D15).
 *   findCoachTask()      — find the user's legacy coach task (null if none); soft-deprecated.
 *   findCoachTaskByProfile() — find a specific profile task by marker.
 *   upsertCoachTask()    — idempotently create-or-update the legacy coach task.
 *   upsertCoachTaskByProfile() — idempotently create-or-update a profile task.
 *   deleteCoachTask()    — remove the legacy coach task if it exists.
 *   resetCoachMemory()   — delete all `coach.*` keyed-memory entries for a user.
 *
 * Dependency edges (binding per ADR 018 Decision 15 + ADR 020 D16):
 *   coach/index.ts → node:fs, node:path, node:url, memory/scheduledTasks, memory/userMemoryEntries,
 *                    memory/auditLog, logger, coach/profileTypes
 *   NO import from agent/, tools/, commands/, or webapp/.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { child } from '../logger/index.js';
import { listEntries, deleteEntry } from '../memory/userMemoryEntries.js';
import type { MemoryApi } from '../memory/index.js';
import { COACH_PROFILES } from './profileTypes.js';
import type { CoachProfile } from './profileTypes.js';

// Re-export profile types for consumers that import from coach/index
export { COACH_PROFILES, isCoachProfile } from './profileTypes.js';
export type { CoachProfile } from './profileTypes.js';
export { parseHHMM, parseWeeklyDay } from './profileTypes.js';

const log = child({ component: 'coach.index' });

// ---------------------------------------------------------------------------
// W2.a named constants (binding; single source of truth)
// ---------------------------------------------------------------------------

/**
 * Legacy sentinel description for the single-profile coach task (v1.18.0/v1.19.0).
 * @deprecated in v1.20.0 — use COACH_MARKER_BY_PROFILE[profile] instead.
 * Retained for back-compat reads and migration helper only.
 *
 * ADR 018 Decision 9 + W2.a (revisions-after-cp1).
 * ADR 020 D2: marked @deprecated; migration rewrites to '__coach_morning__' on first v1.20.0 boot.
 */
export const COACH_TASK_DESCRIPTION = '__coach__';

/**
 * Alias for COACH_TASK_DESCRIPTION: the legacy v1.18.0/v1.19.0 single-profile marker.
 * Used by migration helper and scheduler back-compat dispatch.
 * ADR 020 D2.
 */
export const LEGACY_COACH_MARKER = '__coach__';

// ---------------------------------------------------------------------------
// v1.20.0 multi-profile marker constants (ADR 020 D2)
// ---------------------------------------------------------------------------

/**
 * Marker prefix for all coach profile sentinel descriptions.
 * Used for LIKE-based filtering in webapp and scheduler dispatch.
 * ADR 020 D2.
 */
export const COACH_MARKER_PREFIX = '__coach_';

/**
 * Marker suffix for all coach profile sentinel descriptions.
 * ADR 020 D2.
 */
export const COACH_MARKER_SUFFIX = '__';

/**
 * Map from CoachProfile name to the sentinel description marker.
 * Single source of truth for profile→marker mapping.
 *
 * BINDING (ADR 020 D2): literal marker strings appear ONLY in this map and
 * in src/coach/profileTypes.ts (via COACH_MARKER_BY_PROFILE re-export).
 * Static test tests/static/coach-named-constants-single-source.test.ts enforces.
 */
export const COACH_MARKER_BY_PROFILE: Record<CoachProfile, string> = {
  morning: '__coach_morning__',
  midday: '__coach_midday__',
  evening: '__coach_evening__',
  weekly: '__coach_weekly__',
};

/**
 * ReadonlySet of all 4 profile marker values.
 * Used for O(1) membership tests at scheduler dispatch time and RESERVED_DESCRIPTION checks.
 * ADR 020 D2.
 */
export const COACH_PROFILE_MARKERS: ReadonlySet<string> = new Set(
  Object.values(COACH_MARKER_BY_PROFILE),
);

/**
 * Returns true if `description` matches any of the 4 profile markers OR the legacy __coach__ marker.
 * Used by the scheduler to determine if a task is a coach task.
 *
 * ADR 020 D2: the gateway's spontaneous-fire path does NOT create rows — no `__coach_event__` marker.
 */
export function isCoachMarker(description: string): boolean {
  return COACH_PROFILE_MARKERS.has(description) || description === LEGACY_COACH_MARKER;
}

/**
 * Extract the CoachProfile from a marker string.
 * Returns null if the description is the legacy marker or not a profile marker.
 *
 * ADR 020 D2.
 */
export function profileFromMarker(description: string): CoachProfile | null {
  for (const profile of COACH_PROFILES) {
    if (COACH_MARKER_BY_PROFILE[profile] === description) return profile;
  }
  return null;
}

// ---------------------------------------------------------------------------
// v1.20.0 coach-turn args helper (ADR 020 R1 — CP1 revisions)
// ---------------------------------------------------------------------------

export interface CoachTurnArgsOpts {
  /**
   * True when the turn is fired by an event trigger (ADR 020 D6);
   * false (default) for scheduled cron fires.
   */
  isSpontaneousTrigger?: boolean;
  /**
   * Populated trigger context string for spontaneous fires; empty for cron fires.
   * ADR 020 D15: expanded into the ${trigger_context} placeholder in the coach prompt.
   */
  triggerContext?: string;
}

/**
 * Single source of truth for the canonical coach-turn TurnParams shape.
 *
 * BINDING (ADR 020 R1 — CP1 revision): every coach-turn entry point — the scheduled
 * cron path AND the spontaneous-trigger path — MUST go through this helper.
 * Direct inline construction of the three flags is forbidden.
 * Static test tests/static/coach-turn-args.test.ts enforces.
 *
 * Returns the three load-bearing flags:
 *   - isCoachRun: true  → activates coachTurnCounters initialization at agent/index.ts:591,
 *                          which activates the UNAUTHORIZED_IN_CONTEXT brake against
 *                          `coach.disabledTools` (v1.18.0 R6/F1) AND the per-turn caps
 *                          (nudges: 5, writes: 10 per v1.18.0 R3).
 *   - coachTurnCounters: { nudges: 0, writes: 0 } → included for documentation symmetry;
 *                          the agent constructs its own iff isCoachRun is true.
 *   - isSpontaneousTrigger: gates D15 prompt behavior (spontaneous fires focus on the
 *                          single triggered item; cron fires run the full Step 0 flow).
 *
 * Each flag does a different thing. Removing any one inverts a load-bearing brake.
 * ADR 020 R1 (CP1 revisions doc, 4th iteration of the trap class).
 */
export function buildCoachTurnArgs(opts: CoachTurnArgsOpts = {}): {
  isCoachRun: true;
  coachTurnCounters: { nudges: number; writes: number };
  isSpontaneousTrigger: boolean;
  triggerContext: string;
} {
  return {
    isCoachRun: true,
    coachTurnCounters: { nudges: 0, writes: 0 },
    isSpontaneousTrigger: opts.isSpontaneousTrigger ?? false,
    triggerContext: opts.triggerContext ?? '',
  };
}

/**
 * Placeholder string in the scheduled task's `command` field.
 * The scheduler replaces this literal with the loaded coach prompt at fire time (Decision 10).
 * Any task whose `command === COACH_PROMPT_PLACEHOLDER` is treated as a coach run.
 *
 * ADR 018 Decision 10 + W2.a (revisions-after-cp1).
 */
export const COACH_PROMPT_PLACEHOLDER = '${coach_prompt}';

/**
 * Placeholder string for the trigger context in the coach prompt.
 * ADR 020 D15: when a spontaneous trigger fires, the caller populates this placeholder
 * with structural metadata (trigger type + reason + focus item).
 * For scheduled cron fires, this expands to empty string.
 *
 * ADR 020 D15.
 */
export const COACH_TRIGGER_CONTEXT_PLACEHOLDER = '${trigger_context}';

// ---------------------------------------------------------------------------
// Prompt loading (Decision 5)
// ---------------------------------------------------------------------------

const promptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  './coachPrompt.md',
);

let _cachedPrompt: string | null = null;

/**
 * Load and cache the coach prompt from `dist/coach/coachPrompt.md`.
 * Throws if the file is missing — the caller (scheduler expansion path) must handle
 * and send a DM to the user explaining the prompt load failure.
 *
 * ADR 018 Decision 5 (R6(b) binding).
 */
export function loadCoachPrompt(): string {
  if (_cachedPrompt === null) {
    _cachedPrompt = readFileSync(promptPath, 'utf8');
    log.info({ promptPath }, 'coach: prompt loaded and cached');
  }
  return _cachedPrompt;
}

/**
 * Expand the COACH_PROMPT_PLACEHOLDER in a scheduled-task command string.
 * Optionally also expands the COACH_TRIGGER_CONTEXT_PLACEHOLDER (ADR 020 D15).
 *
 * Returns the command unchanged if neither placeholder is present.
 *
 * @param command       Scheduled-task command string (typically COACH_PROMPT_PLACEHOLDER).
 * @param triggerContext Optional trigger context string for spontaneous fires.
 *                       When omitted (or empty), COACH_TRIGGER_CONTEXT_PLACEHOLDER expands to ''.
 *
 * Called by the scheduler at fire time (ADR 018 Decision 10) and by
 * gateway.fireSpontaneousCoachTurn (ADR 020 D7 + D15).
 */
export function expandCoachPromptToken(command: string, triggerContext?: string): string {
  let result = command;
  if (result.includes(COACH_PROMPT_PLACEHOLDER)) {
    result = result.replace(COACH_PROMPT_PLACEHOLDER, loadCoachPrompt());
  }
  if (result.includes(COACH_TRIGGER_CONTEXT_PLACEHOLDER)) {
    result = result.replace(COACH_TRIGGER_CONTEXT_PLACEHOLDER, triggerContext ?? '');
  }
  return result;
}

// ---------------------------------------------------------------------------
// Idempotent task management (Decision 6 + 9)
// ---------------------------------------------------------------------------

/**
 * Find the user's coach scheduled task by owner_user_id + COACH_TASK_DESCRIPTION.
 * Returns null if no coach task exists for this user.
 *
 * @deprecated in v1.20.0 — use findCoachTaskByProfile() for new code.
 * Retained for back-compat with v1.18.0/v1.19.0 callers.
 */
export function findCoachTask(memory: MemoryApi, userId: number) {
  const tasks = memory.scheduledTasks.listByOwner(userId);
  return tasks.find((t) => t.description === COACH_TASK_DESCRIPTION) ?? null;
}

/**
 * Find a specific profile's scheduled task for a user.
 * Returns null if no task with that profile's marker exists.
 *
 * ADR 020 D3: profile look-up via marker description (no new DB columns).
 */
export function findCoachTaskByProfile(
  memory: MemoryApi,
  userId: number,
  profile: CoachProfile,
) {
  const marker = COACH_MARKER_BY_PROFILE[profile];
  const tasks = memory.scheduledTasks.listByOwner(userId);
  return tasks.find((t) => t.description === marker) ?? null;
}

/**
 * List all active coach profile tasks for a user (all 4 markers + legacy).
 * Returns an array of ScheduledTask rows (may be empty).
 *
 * ADR 020 D3.
 */
export function listCoachTasks(memory: MemoryApi, userId: number) {
  const tasks = memory.scheduledTasks.listByOwner(userId);
  return tasks.filter((t) => isCoachMarker(t.description));
}

/**
 * Idempotently create or update the coach scheduled task for a user.
 *
 * If a task with COACH_TASK_DESCRIPTION already exists for the user, updates its
 * cron_expression and resets status to 'active'. Otherwise, creates a new task.
 *
 * Returns the task ID.
 *
 * ADR 018 Decision 6 + W2.a.
 */
export function upsertCoachTask(
  memory: MemoryApi,
  userId: number,
  chatId: number,
  cronExpression: string,
): number {
  const existing = findCoachTask(memory, userId);
  if (existing) {
    // Update the cron expression by remove + re-insert (ScheduledTasksRepo has no update method)
    memory.scheduledTasks.remove(existing.id);
    log.info({ userId, existingId: existing.id, cronExpression }, 'coach: removed old coach task for upsert');
  }
  const id = memory.scheduledTasks.insert({
    description: COACH_TASK_DESCRIPTION,
    cron_expression: cronExpression,
    command: COACH_PROMPT_PLACEHOLDER,
    chat_id: chatId,
    owner_user_id: userId,
  });
  log.info({ userId, id, cronExpression }, 'coach: coach task upserted');
  return id;
}

/**
 * Idempotently create or update a profile-specific coach scheduled task.
 *
 * Uses COACH_MARKER_BY_PROFILE[profile] as the description sentinel.
 * If a task with the profile marker already exists, removes it and re-inserts
 * (same pattern as upsertCoachTask — ScheduledTasksRepo has no update method).
 *
 * Returns the new task ID.
 *
 * ADR 020 D3.
 */
export function upsertCoachTaskByProfile(
  memory: MemoryApi,
  userId: number,
  chatId: number,
  profile: CoachProfile,
  cronExpression: string,
): number {
  const existing = findCoachTaskByProfile(memory, userId, profile);
  if (existing) {
    memory.scheduledTasks.remove(existing.id);
    log.info(
      { userId, profile, existingId: existing.id, cronExpression },
      'coach: removed old profile task for upsert',
    );
  }
  const marker = COACH_MARKER_BY_PROFILE[profile];
  const id = memory.scheduledTasks.insert({
    description: marker,
    cron_expression: cronExpression,
    command: COACH_PROMPT_PLACEHOLDER,
    chat_id: chatId,
    owner_user_id: userId,
  });
  log.info({ userId, profile, id, cronExpression, marker }, 'coach: profile task upserted');
  return id;
}

/**
 * Delete the user's coach scheduled task if it exists.
 * Returns true if a task was deleted, false if none existed.
 *
 * @deprecated in v1.20.0 — use deleteCoachTaskByProfile() for new code.
 */
export function deleteCoachTask(memory: MemoryApi, userId: number): boolean {
  const existing = findCoachTask(memory, userId);
  if (!existing) return false;
  memory.scheduledTasks.remove(existing.id);
  log.info({ userId, id: existing.id }, 'coach: coach task deleted');
  return true;
}

/**
 * Delete a specific profile's coach task for a user.
 * Returns true if a task was deleted, false if none existed.
 *
 * ADR 020 D4.
 */
export function deleteCoachTaskByProfile(
  memory: MemoryApi,
  userId: number,
  profile: CoachProfile,
): boolean {
  const existing = findCoachTaskByProfile(memory, userId, profile);
  if (!existing) return false;
  memory.scheduledTasks.remove(existing.id);
  log.info({ userId, profile, id: existing.id }, 'coach: profile task deleted');
  return true;
}

/**
 * Delete ALL profile coach tasks for a user (all 4 profiles + legacy if present).
 * Returns the count of tasks deleted.
 *
 * ADR 020 D4: /coach off all behavior.
 */
export function deleteAllCoachTasks(memory: MemoryApi, userId: number): number {
  const tasks = listCoachTasks(memory, userId);
  let deleted = 0;
  for (const task of tasks) {
    memory.scheduledTasks.remove(task.id);
    deleted++;
    log.info({ userId, id: task.id, description: task.description }, 'coach: task deleted (off all)');
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// Coach memory reset (for /organize coach reset subcommand)
// ---------------------------------------------------------------------------

/**
 * Delete all `coach.*` keyed-memory entries for a user (resets coach history).
 * Returns the count of deleted entries.
 *
 * Used by `/organize coach reset` to give the user a clean slate.
 * ADR 018 Decision 6 (reset helper).
 */
export async function resetCoachMemory(
  userId: number,
  dataDir: string,
): Promise<number> {
  const allEntries = await listEntries(userId, dataDir);
  const coachEntries = allEntries.filter((e) => e.key.startsWith('coach.'));
  let deletedCount = 0;
  for (const entry of coachEntries) {
    const result = await deleteEntry(userId, dataDir, entry.key);
    if (result.ok) {
      deletedCount++;
    } else {
      log.warn({ userId, key: entry.key, code: result.code }, 'coach: resetCoachMemory failed to delete entry');
    }
  }
  log.info({ userId, deletedCount }, 'coach: resetCoachMemory complete');
  return deletedCount;
}
