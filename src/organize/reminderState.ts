/**
 * Reminder state persistence (v1.9.0).
 *
 * Two layers:
 *  - Per-user: data/organize/<userId>/.reminder-state.json
 *  - Global:   data/organize/.reminder-global-state.json
 *
 * Both use atomic temp-then-rename writes (same pattern as userMemory and
 * organize/storage). Both use tolerant parsing — file absent or malformed
 * returns a fresh default so a hand-edit gone wrong resets instead of
 * crashing the tick.
 *
 * See ARCHITECTURE.md §17.4 and ADR 004 §3.
 */

import { readFile, writeFile, rename, mkdir, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { child } from '../logger/index.js';
import { organizeUserDir, ensureUserDir } from './storage.js';

const log = child({ component: 'organize.reminderState' });

// ---------------------------------------------------------------------------
// Per-user schema
// ---------------------------------------------------------------------------

export const ReminderItemStateSchema = z.object({
  lastNudgedAt: z.string().nullable().default(null),
  nudgeCount: z.number().int().min(0).default(0),
  responseHistory: z.array(z.enum(['pending', 'responded', 'ignored'])).default([]),
  muted: z.boolean().default(false),
});

export const ReminderStateSchema = z.object({
  version: z.literal(1).default(1),
  lastTickAt: z.string().default(''),
  nudgesToday: z.number().int().min(0).default(0),
  dailyResetDate: z.string().default(''),
  lastNudgeAt: z.string().nullable().default(null),
  userDisabledNag: z.boolean().default(false),
  // v1.10.0: per-user Haiku fallback counter. Resets alongside nudgesToday on
  // daily reset. Gated by config.organize.reminders.haikuFallbackMaxPerDay
  // (the v1.9.0 knob is repurposed from global-cap → per-user-cap per ADR 005 §1).
  haikuFallbacksTodayPerUser: z.number().int().min(0).default(0),
  items: z.record(z.string(), ReminderItemStateSchema).default({}),
});

export type ReminderState = z.infer<typeof ReminderStateSchema>;
export type ReminderItemState = z.infer<typeof ReminderItemStateSchema>;

// ---------------------------------------------------------------------------
// Global schema
// ---------------------------------------------------------------------------

export const GlobalReminderStateSchema = z.object({
  version: z.literal(1).default(1),
  date: z.string().default(''),
  haikuFallbacksToday: z.number().int().min(0).default(0),
  totalTicksToday: z.number().int().min(0).default(0),
});

export type GlobalReminderState = z.infer<typeof GlobalReminderStateSchema>;

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Returns YYYY-MM-DD in server local time.
 * Used for daily reset checks — must be consistent with what node-cron fires
 * against (server local TZ).
 */
export function ymdLocal(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Returns true if the date string (YYYY-MM-DD) is in the future
 * OR more than 1 year in the past (relative to today local).
 * Used for clock-skew defense on dailyResetDate.
 */
function isSkewedDate(dateStr: string, todayLocal: string): boolean {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return true;
  if (dateStr > todayLocal) return true; // future
  // More than 1 year in the past: compare year part
  const [y] = dateStr.split('-').map(Number);
  const [ty] = todayLocal.split('-').map(Number);
  if (ty !== undefined && y !== undefined && ty - y > 1) return true;
  // Same check via months: could be exactly 12 months in same year edge case
  // Simpler: parse as Date and compare
  const d = new Date(dateStr + 'T00:00:00');
  const today = new Date(todayLocal + 'T00:00:00');
  const oneYearMs = 365 * 24 * 60 * 60 * 1000;
  if (today.getTime() - d.getTime() > oneYearMs) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function reminderStatePath(userId: number, dataDir: string): string {
  return path.join(organizeUserDir(userId, dataDir), '.reminder-state.json');
}

export function globalStatePath(dataDir: string): string {
  return path.join(dataDir, 'organize', '.reminder-global-state.json');
}

// ---------------------------------------------------------------------------
// Symlink defense helpers (QA W9)
// ---------------------------------------------------------------------------

/**
 * Ensures data/organize/ exists and is a plain directory (not a symlink).
 * Mirrors the ensureUserDir pattern from storage.ts for the global-state layer.
 */
async function ensureDataOrganizeDir(dataDir: string): Promise<string> {
  const organizeDir = path.join(dataDir, 'organize');
  if (existsSync(organizeDir)) {
    const st = await lstat(organizeDir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw Object.assign(
        new Error(`organize root dir is not a plain directory: ${organizeDir}`),
        { code: 'ORGANIZE_USER_DIR_SYMLINK' },
      );
    }
  } else {
    await mkdir(organizeDir, { recursive: true });
  }
  return organizeDir;
}

// ---------------------------------------------------------------------------
// Atomic write (mirrors organize/storage.ts:writeAtomically)
// ---------------------------------------------------------------------------

async function writeAtomically(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Per-user read / write
// ---------------------------------------------------------------------------

function freshDefaultState(now: Date = new Date()): ReminderState {
  return ReminderStateSchema.parse({
    version: 1,
    lastTickAt: now.toISOString(),
    nudgesToday: 0,
    dailyResetDate: ymdLocal(now),
    lastNudgeAt: null,
    userDisabledNag: false,
    haikuFallbacksTodayPerUser: 0,
    items: {},
  });
}

/**
 * Load per-user reminder state.
 * Returns a fresh default when file is absent or malformed.
 * Applies clock-skew defense: resets dailyResetDate if it is in the future
 * or more than 1 year in the past.
 */
export async function loadReminderState(
  userId: number,
  dataDir: string,
): Promise<ReminderState> {
  const filePath = reminderStatePath(userId, dataDir);
  const now = new Date();
  const todayLocal = ymdLocal(now);

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    // File absent — return fresh default (no warning; first-run is expected)
    return freshDefaultState(now);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn(
      { userId, err: err instanceof Error ? err.message : String(err), reason: 'json-parse-failed' },
      'reminderState: JSON parse failed, resetting to default',
    );
    return freshDefaultState(now);
  }

  const result = ReminderStateSchema.safeParse(parsed);
  if (!result.success) {
    log.warn(
      { userId, reason: 'schema-validation-failed', issues: result.error.issues.length },
      'reminderState: schema parse failed, resetting to default',
    );
    return freshDefaultState(now);
  }

  const state = result.data;

  // Clock-skew defense on dailyResetDate
  if (isSkewedDate(state.dailyResetDate, todayLocal)) {
    log.warn(
      { userId, dailyResetDate: state.dailyResetDate, todayLocal, reason: 'clock-skew' },
      'reminderState: dailyResetDate skewed, resetting to today',
    );
    state.dailyResetDate = todayLocal;
    state.nudgesToday = 0;
  }

  return state;
}

/**
 * Write per-user reminder state atomically.
 * Calls ensureUserDir (symlink defense) before writing.
 * Throws on rename failure or symlink detection; caller decides how to handle.
 */
export async function writeReminderState(
  userId: number,
  dataDir: string,
  state: ReminderState,
): Promise<void> {
  await ensureUserDir(userId, dataDir); // symlink defense (QA W9)
  const filePath = reminderStatePath(userId, dataDir);
  await writeAtomically(filePath, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Global state read / write
// ---------------------------------------------------------------------------

function freshGlobalState(todayLocal: string): GlobalReminderState {
  return GlobalReminderStateSchema.parse({
    version: 1,
    date: todayLocal,
    haikuFallbacksToday: 0,
    totalTicksToday: 0,
  });
}

/**
 * Load global reminder state.
 * Returns a fresh default if absent or malformed.
 * Resets counters if date !== todayLocal.
 */
export async function loadGlobalState(dataDir: string): Promise<GlobalReminderState> {
  const filePath = globalStatePath(dataDir);
  const todayLocal = ymdLocal(new Date());

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return freshGlobalState(todayLocal);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), reason: 'json-parse-failed' },
      'globalReminderState: JSON parse failed, resetting to default',
    );
    return freshGlobalState(todayLocal);
  }

  const result = GlobalReminderStateSchema.safeParse(parsed);
  if (!result.success) {
    log.warn(
      { reason: 'schema-validation-failed', issues: result.error.issues.length },
      'globalReminderState: schema parse failed, resetting to default',
    );
    return freshGlobalState(todayLocal);
  }

  const state = result.data;

  // Daily reset
  if (state.date !== todayLocal) {
    return freshGlobalState(todayLocal);
  }

  return state;
}

/**
 * Write global reminder state atomically.
 * Calls ensureDataOrganizeDir (symlink defense) before writing.
 * Throws on symlink detection; caller decides how to handle.
 */
export async function writeGlobalState(
  dataDir: string,
  state: GlobalReminderState,
): Promise<void> {
  await ensureDataOrganizeDir(dataDir); // symlink defense (QA W9)
  const filePath = globalStatePath(dataDir);
  await writeAtomically(filePath, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Atomic global Haiku fallback reservation (v1.10.0 R1)
// ---------------------------------------------------------------------------

/**
 * Result type for reserveGlobalHaikuFallback.
 * ok:true → the slot was reserved, globalStateAfter is the post-increment state.
 * ok:false → the global budget is full; state was NOT mutated.
 */
export type ReserveResult =
  | { ok: true; globalStateAfter: GlobalReminderState }
  | { ok: false; reason: 'global-budget-exhausted'; globalState: GlobalReminderState };

/**
 * Module-level mutex for global state writes. One lock per process.
 * Jarvis runs single-process; multi-process safety deferred to proper-lockfile
 * (v1.9.0 TODO still stands, slightly more relevant at multi-user scale).
 *
 * The lock is a promise chain: each call chains on the current tail, so only
 * one reserve runs at a time. try/finally ensures the lock always advances
 * even if the inner work throws.
 */
let globalStateMutex: Promise<unknown> = Promise.resolve();

/**
 * Atomically reserve one Haiku fallback slot from the global budget.
 *
 * The cap check AND the write happen UNDER THE SAME MUTEX so N concurrent
 * callers cannot all pass the check before any of them write (TOCTOU-free).
 *
 * Returns ok:true ONLY when the post-increment count is still ≤ cap.
 * Returns ok:false WITHOUT mutating state when the budget is full.
 *
 * Also applies the daily reset inside the lock if the stored date is stale.
 */
export async function reserveGlobalHaikuFallback(
  dataDir: string,
  cap: number,
): Promise<ReserveResult> {
  // Chain onto the current mutex tail.
  const result = globalStateMutex.then(async (): Promise<ReserveResult> => {
    const state = await loadGlobalState(dataDir);

    if (state.haikuFallbacksToday >= cap) {
      return { ok: false, reason: 'global-budget-exhausted', globalState: state };
    }

    state.haikuFallbacksToday += 1;
    await writeGlobalState(dataDir, state);
    return { ok: true, globalStateAfter: state };
  });

  // Advance the mutex tail so the next caller waits for THIS operation.
  // Both resolve and reject advance the tail so the lock is never permanently held.
  globalStateMutex = result.then(
    () => undefined,
    () => undefined,
  );

  return result;
}

/**
 * Test hook — reset the global state mutex to a resolved promise.
 * Call between test cases to avoid lock carry-over.
 */
export function _resetGlobalStateMutexForTests(): void {
  globalStateMutex = Promise.resolve();
}
