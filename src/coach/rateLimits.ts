/**
 * Rate-limit primitives for the event-driven proactive coach (v1.20.0 ADR 020 D8).
 *
 * Three keyed-memory entries form the rate-limit primitive:
 *   - coach.<itemId>.lastSpontaneousAt  — per-item 4h window
 *   - coach.global.spontaneousCount.<YYYYMMDD>  — global daily cap (3/day)
 *   - coach.global.quietUntil           — kill switch
 *   - coach.global.lastUserMessageAt    — D12 debounce (60s)
 *   - coach.global.lastCoachDmAt        — D10 30-min cooldown after coach DM
 *
 * All reads/writes go through userMemoryEntries.ts (sole-writer invariant ADR 017 R3).
 *
 * Dependency edges (binding per ADR 020 D16):
 *   rateLimits.ts → memory/userMemoryEntries (read/write keyed entries)
 *   rateLimits.ts → logger
 *   NO import from agent/, tools/, gateway/, commands/, or coach/index.ts.
 *
 * ADR 020 Decision 8 + CP1 revisions.
 */

import { getEntry, createEntry, updateEntry } from '../memory/userMemoryEntries.js';
import { child } from '../logger/index.js';

const log = child({ component: 'coach.rateLimits' });

// ---------------------------------------------------------------------------
// Constants (binding per ADR 020 D8)
// ---------------------------------------------------------------------------

/** Per-item spontaneous fire window: 4 hours */
export const PER_ITEM_RATE_WINDOW_MS = 4 * 60 * 60 * 1000;

/** Global daily cap on spontaneous fires */
export const GLOBAL_DAILY_CAP = 3;

/** Debounce: must wait this many ms after last user message before firing trigger */
export const USER_MESSAGE_DEBOUNCE_MS = 60 * 1000;

/** Cooldown after coach DM (any kind) to prevent feedback loops */
export const COACH_DM_COOLDOWN_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Key builders
// ---------------------------------------------------------------------------

function perItemKey(itemId: string): string {
  return `coach.${itemId}.lastSpontaneousAt`;
}

function globalDailyKey(dayIso: string): string {
  return `coach.global.spontaneousCount.${dayIso}`;
}

const QUIET_UNTIL_KEY = 'coach.global.quietUntil';
const LAST_USER_MESSAGE_KEY = 'coach.global.lastUserMessageAt';
const LAST_COACH_DM_KEY = 'coach.global.lastCoachDmAt';

// ---------------------------------------------------------------------------
// Helper: read JSON value from a keyed memory entry
// ---------------------------------------------------------------------------

async function readJsonEntry<T>(
  userId: number,
  dataDir: string,
  key: string,
): Promise<T | null> {
  const entry = await getEntry(userId, dataDir, key);
  if (!entry) return null;
  try {
    return JSON.parse(entry.body) as T;
  } catch {
    log.warn({ userId, key }, 'rateLimits: failed to parse JSON from entry');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helper: write JSON value to a keyed memory entry (create or update)
// ---------------------------------------------------------------------------

async function writeJsonEntry(
  userId: number,
  dataDir: string,
  key: string,
  value: unknown,
): Promise<void> {
  const body = JSON.stringify(value);
  const existing = await getEntry(userId, dataDir, key);
  if (existing) {
    await updateEntry(userId, dataDir, key, body);
  } else {
    await createEntry(userId, dataDir, key, body);
  }
}

// ---------------------------------------------------------------------------
// Per-item rate limit (4h window)
// ---------------------------------------------------------------------------

/**
 * Check if a spontaneous trigger is allowed for a specific item.
 * Allowed if `coach.<itemId>.lastSpontaneousAt` is missing or > 4h ago.
 */
export async function checkPerItemRateLimit(
  userId: number,
  dataDir: string,
  itemId: string,
): Promise<{ allowed: boolean; nextAllowedIso?: string }> {
  const data = await readJsonEntry<{ at: string }>(userId, dataDir, perItemKey(itemId));
  if (!data?.at) return { allowed: true };

  const lastMs = new Date(data.at).getTime();
  const nowMs = Date.now();
  const elapsedMs = nowMs - lastMs;

  if (elapsedMs < PER_ITEM_RATE_WINDOW_MS) {
    const nextAllowedMs = lastMs + PER_ITEM_RATE_WINDOW_MS;
    return {
      allowed: false,
      nextAllowedIso: new Date(nextAllowedMs).toISOString(),
    };
  }

  return { allowed: true };
}

/**
 * Record a spontaneous fire for a specific item (updates lastSpontaneousAt).
 */
export async function recordPerItemFire(
  userId: number,
  dataDir: string,
  itemId: string,
): Promise<void> {
  await writeJsonEntry(userId, dataDir, perItemKey(itemId), {
    at: new Date().toISOString(),
  });
  log.debug({ userId, itemId }, 'rateLimits: recorded per-item spontaneous fire');
}

// ---------------------------------------------------------------------------
// Global daily cap (3/day)
// ---------------------------------------------------------------------------

/**
 * Check if the global daily cap has been reached.
 * Allowed if count for today's YYYYMMDD is < GLOBAL_DAILY_CAP.
 */
export async function checkGlobalDailyCap(
  userId: number,
  dataDir: string,
  dayIso: string,
): Promise<{ allowed: boolean; currentCount: number }> {
  const data = await readJsonEntry<{ count: number }>(userId, dataDir, globalDailyKey(dayIso));
  const count = data?.count ?? 0;

  return {
    allowed: count < GLOBAL_DAILY_CAP,
    currentCount: count,
  };
}

/**
 * Increment the global daily fire counter for today.
 */
export async function recordGlobalDailyFire(
  userId: number,
  dataDir: string,
  dayIso: string,
): Promise<void> {
  const data = await readJsonEntry<{ count: number }>(userId, dataDir, globalDailyKey(dayIso));
  const newCount = (data?.count ?? 0) + 1;
  await writeJsonEntry(userId, dataDir, globalDailyKey(dayIso), { count: newCount });
  log.debug({ userId, dayIso, newCount }, 'rateLimits: incremented global daily counter');
}

// ---------------------------------------------------------------------------
// Quiet mode
// ---------------------------------------------------------------------------

/**
 * Check if quiet mode is active.
 * Active if `coach.global.quietUntil.at` is in the future.
 */
export async function checkQuietMode(
  userId: number,
  dataDir: string,
): Promise<{ active: boolean; untilIso?: string }> {
  const data = await readJsonEntry<{ at: string }>(userId, dataDir, QUIET_UNTIL_KEY);
  if (!data?.at) return { active: false };

  const untilMs = new Date(data.at).getTime();
  const nowMs = Date.now();

  if (nowMs < untilMs) {
    return { active: true, untilIso: data.at };
  }

  return { active: false };
}

/**
 * Activate quiet mode until the given ISO timestamp.
 */
export async function setQuietMode(
  userId: number,
  dataDir: string,
  untilIso: string,
): Promise<void> {
  await writeJsonEntry(userId, dataDir, QUIET_UNTIL_KEY, { at: untilIso });
  log.info({ userId, untilIso }, 'rateLimits: quiet mode activated');
}

/**
 * Clear quiet mode.
 */
export async function clearQuietMode(
  userId: number,
  dataDir: string,
): Promise<void> {
  await writeJsonEntry(userId, dataDir, QUIET_UNTIL_KEY, { at: '' });
  log.info({ userId }, 'rateLimits: quiet mode cleared');
}

/**
 * Parse a quiet duration string into an until-ISO timestamp.
 *
 * Accepts:
 *   - "2h", "4h", "8h" etc. (hours)
 *   - "1d", "3d", "7d" etc. (days)
 *   - "until tomorrow" (next UTC midnight)
 *   - "until monday" (next Monday UTC)
 *
 * Returns { ok: true; untilIso } or { ok: false; error }.
 */
export function parseQuietDuration(
  input: string,
  nowIso: string,
): { ok: true; untilIso: string } | { ok: false; error: string } {
  const s = input.trim().toLowerCase();
  const nowMs = new Date(nowIso).getTime();

  // Hours: "2h", "4h"
  const hoursMatch = /^(\d+)h$/.exec(s);
  if (hoursMatch) {
    const hours = parseInt(hoursMatch[1]!, 10);
    if (hours < 1 || hours > 168) {
      return { ok: false, error: `Hours must be between 1 and 168 (7 days). Got: ${hours}` };
    }
    return { ok: true, untilIso: new Date(nowMs + hours * 60 * 60 * 1000).toISOString() };
  }

  // Days: "1d", "3d"
  const daysMatch = /^(\d+)d$/.exec(s);
  if (daysMatch) {
    const days = parseInt(daysMatch[1]!, 10);
    if (days < 1 || days > 30) {
      return { ok: false, error: `Days must be between 1 and 30. Got: ${days}` };
    }
    return { ok: true, untilIso: new Date(nowMs + days * 24 * 60 * 60 * 1000).toISOString() };
  }

  // "until tomorrow" — next UTC midnight
  if (s === 'until tomorrow') {
    const now = new Date(nowMs);
    const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return { ok: true, untilIso: tomorrow.toISOString() };
  }

  // "until monday" etc.
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const untilDayMatch = /^until\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/i.exec(s);
  if (untilDayMatch) {
    const targetDay = dayNames.indexOf(untilDayMatch[1]!.toLowerCase());
    const now = new Date(nowMs);
    const currentDay = now.getUTCDay();
    let daysAhead = targetDay - currentDay;
    if (daysAhead <= 0) daysAhead += 7; // next occurrence
    const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysAhead));
    return { ok: true, untilIso: target.toISOString() };
  }

  return {
    ok: false,
    error: `Couldn't parse "${input}" — use "2h", "1d", "until tomorrow", or "until monday".`,
  };
}

// ---------------------------------------------------------------------------
// User message debounce (D12 — 60s after last user message)
// ---------------------------------------------------------------------------

/**
 * Check if enough time has passed since the last user message to allow firing.
 * Allowed if > 60s since lastUserMessageAt (or if no record exists).
 */
export async function checkUserMessageDebounce(
  userId: number,
  dataDir: string,
): Promise<{ allowed: boolean; secondsSince: number }> {
  const data = await readJsonEntry<{ at: string }>(userId, dataDir, LAST_USER_MESSAGE_KEY);
  if (!data?.at) return { allowed: true, secondsSince: Infinity };

  const lastMs = new Date(data.at).getTime();
  const nowMs = Date.now();
  const secondsSince = (nowMs - lastMs) / 1000;

  return {
    allowed: secondsSince > USER_MESSAGE_DEBOUNCE_MS / 1000,
    secondsSince,
  };
}

/**
 * Record the current time as the last user message time.
 */
export async function recordUserMessage(
  userId: number,
  dataDir: string,
): Promise<void> {
  await writeJsonEntry(userId, dataDir, LAST_USER_MESSAGE_KEY, {
    at: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Coach DM cooldown (D10 — 30-min after last coach DM)
// ---------------------------------------------------------------------------

/**
 * Check if the coach-DM cooldown is still active.
 * Allowed if > 30min since last coach DM (or if no record exists).
 */
export async function checkCoachDMCooldown(
  userId: number,
  dataDir: string,
): Promise<{ allowed: boolean }> {
  const data = await readJsonEntry<{ at: string }>(userId, dataDir, LAST_COACH_DM_KEY);
  if (!data?.at) return { allowed: true };

  const lastMs = new Date(data.at).getTime();
  const nowMs = Date.now();
  const elapsedMs = nowMs - lastMs;

  return { allowed: elapsedMs > COACH_DM_COOLDOWN_MS };
}

/**
 * Record the current time as the last coach DM time.
 * Called on every coach DM (both scheduled and spontaneous).
 */
export async function recordCoachDM(
  userId: number,
  dataDir: string,
): Promise<void> {
  await writeJsonEntry(userId, dataDir, LAST_COACH_DM_KEY, {
    at: new Date().toISOString(),
  });
  log.debug({ userId }, 'rateLimits: recorded coach DM timestamp');
}
