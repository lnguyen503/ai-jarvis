/**
 * Coach quiet-mode commands (v1.20.0 commit 3).
 *
 * Handles:
 *   /coach quiet <duration>    — set quiet mode for event-triggered nudges
 *   /coach quiet status        — check quiet mode remaining time
 *   /coach quiet off           — clear quiet mode
 *
 * Quiet mode semantics (ADR 020 D9):
 *   Silences EVENT-DRIVEN coach nudges only. Scheduled profile DMs (morning/etc.)
 *   still fire on their cron schedules. Use /coach off [profile|all] to mute those.
 *
 * R4 revision (binding): /coach quiet reply text MUST include the asymmetry note
 *   explaining that scheduled coach DMs still fire. Text verified by T-R4-1..T-R4-3.
 *
 * Duration grammar:
 *   <N>h          — N hours (1–168)
 *   <N>d          — N days (1–30)
 *   until tomorrow — next UTC midnight
 *   until <day>   — next occurrence of that weekday UTC midnight
 *
 * Storage: coach.global.quietUntil keyed-memory entry (rateLimits.ts sole-writer).
 *
 * Dependency edges (binding per ADR 020 D16):
 *   coachQuietCommands.ts → commands/coachSubcommands (CoachSubcommandCtx shared type)
 *   coachQuietCommands.ts → coach/rateLimits (parseQuietDuration, setQuietMode, clearQuietMode, checkQuietMode)
 *   coachQuietCommands.ts → config/dataDir (resolveDataDir)
 *   coachQuietCommands.ts → memory/auditLog (coach.global_quiet.engaged)
 *   coachQuietCommands.ts → logger
 *   NO import from agent/, gateway/, or webapp/.
 *
 * ADR 020 D4 + D8 + D9 + R4.
 */

import type { CoachSubcommandCtx } from './coachSubcommands.js';
import {
  parseQuietDuration,
  setQuietMode,
  clearQuietMode,
  checkQuietMode,
} from '../coach/rateLimits.js';
import { resolveDataDir } from '../config/dataDir.js';
import { child } from '../logger/index.js';

const log = child({ component: 'commands.coachQuietCommands' });

// ---------------------------------------------------------------------------
// R4 asymmetry note text (binding — T-R4-1, T-R4-2, T-R4-3 test these substrings)
// ---------------------------------------------------------------------------

const ASYMMETRY_NOTE =
  'Note: scheduled coach DMs (morning/midday/evening/weekly) will still fire as scheduled.\n' +
  'Use `/coach off [profile|all]` to mute those too.';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format an ISO timestamp for display.
 * Returns a compact "YYYY-MM-DD HH:MM UTC" string.
 */
function formatUntil(isoStr: string): string {
  try {
    const d = new Date(isoStr);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const min = String(d.getUTCMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${min} UTC`;
  } catch {
    return isoStr;
  }
}

/**
 * Compute a human-readable remaining-time string given an ISO future timestamp.
 * Returns e.g. "3h 42m remaining" or "42m remaining".
 */
function formatRemaining(untilIso: string): string {
  const nowMs = Date.now();
  const untilMs = new Date(untilIso).getTime();
  const diffMs = untilMs - nowMs;
  if (diffMs <= 0) return '0m remaining';
  const totalMinutes = Math.ceil(diffMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m remaining`;
  if (hours > 0) return `${hours}h remaining`;
  return `${minutes}m remaining`;
}

// ---------------------------------------------------------------------------
// /coach quiet <duration>  (ADR 020 D8 + D9 + R4)
// ---------------------------------------------------------------------------

/**
 * /coach quiet <duration>
 *
 * Parses duration and activates quiet mode by writing coach.global.quietUntil
 * to keyed memory via rateLimits.setQuietMode().
 *
 * R4 (binding): reply MUST include the asymmetry note about scheduled DMs still firing.
 * T-R4-1: reply text contains "scheduled coach DMs" + "still fire".
 *
 * ADR 020 D8 + D9 + R4.
 */
export async function handleCoachQuiet(
  deps: CoachSubcommandCtx,
  durationStr: string,
): Promise<void> {
  const { ctx, userId, config, memory } = deps;
  const dataDir = resolveDataDir(config);

  const trimmed = durationStr.trim();
  if (!trimmed) {
    await ctx
      .reply(
        'Usage: /coach quiet <duration>\n' +
          '  Examples: /coach quiet 2h\n' +
          '            /coach quiet 1d\n' +
          '            /coach quiet until tomorrow\n' +
          '            /coach quiet until monday',
      )
      .catch(() => {});
    return;
  }

  const parsed = parseQuietDuration(trimmed, new Date().toISOString());
  if (!parsed.ok) {
    await ctx
      .reply(
        `${parsed.error}\n\n` +
          'Supported formats: 2h, 1d, until tomorrow, until monday',
      )
      .catch(() => {});
    return;
  }

  const { untilIso } = parsed;

  try {
    await setQuietMode(userId, dataDir, untilIso);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ userId, durationStr, err: msg }, '/coach quiet: setQuietMode failed');
    await ctx.reply(`Couldn't set quiet mode: ${msg}`).catch(() => {});
    return;
  }

  // Audit (coach.global_quiet.engaged)
  try {
    memory.auditLog.insert({
      category: 'coach.global_quiet.engaged',
      actor_user_id: userId,
      detail: { action: 'engage', untilIso, durationStr: trimmed },
    });
  } catch (auditErr) {
    log.warn(
      { userId, err: auditErr instanceof Error ? auditErr.message : String(auditErr) },
      '/coach quiet: audit insert failed (non-fatal)',
    );
  }

  const displayUntil = formatUntil(untilIso);
  const remaining = formatRemaining(untilIso);

  await ctx
    .reply(
      `Quiet mode active until ${displayUntil} (${remaining}).\n` +
        'This silences event-driven coach nudges (item state changes, chat patterns, calendar events).\n' +
        '\n' +
        ASYMMETRY_NOTE,
    )
    .catch(() => {});

  log.info({ userId, durationStr: trimmed, untilIso }, '/coach quiet: activated');
}

// ---------------------------------------------------------------------------
// /coach quiet status  (ADR 020 D8 + D9 + R4)
// ---------------------------------------------------------------------------

/**
 * /coach quiet status
 *
 * Reads coach.global.quietUntil and reports remaining time or "not active".
 *
 * R4 (binding): reply includes the asymmetry note when quiet is active.
 * T-R4-2: reply text contains the asymmetry note substring.
 *
 * ADR 020 D8 + D9 + R4.
 */
export async function handleCoachQuietStatus(deps: CoachSubcommandCtx): Promise<void> {
  const { ctx, userId, config } = deps;
  const dataDir = resolveDataDir(config);

  let result: { active: boolean; untilIso?: string };
  try {
    result = await checkQuietMode(userId, dataDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ userId, err: msg }, '/coach quiet status: checkQuietMode failed');
    await ctx.reply(`Couldn't check quiet mode: ${msg}`).catch(() => {});
    return;
  }

  if (!result.active || !result.untilIso) {
    await ctx
      .reply(
        'Quiet mode: not active.\n' +
          '(Event triggers are enabled. Scheduled profile DMs fire as scheduled.)',
      )
      .catch(() => {});
    return;
  }

  const displayUntil = formatUntil(result.untilIso);
  const remaining = formatRemaining(result.untilIso);

  await ctx
    .reply(
      `Quiet mode: active until ${displayUntil} (${remaining}).\n` +
        '(Event triggers silenced; scheduled profile DMs still fire.)',
    )
    .catch(() => {});

  log.info({ userId, untilIso: result.untilIso }, '/coach quiet status: replied');
}

// ---------------------------------------------------------------------------
// /coach quiet off  (ADR 020 D8 + D9 + R4)
// ---------------------------------------------------------------------------

/**
 * /coach quiet off
 *
 * Clears the coach.global.quietUntil entry.
 *
 * R4 (binding): reply mentions scheduled DMs are unchanged.
 * T-R4-3: reply text contains "Scheduled profile DMs are unchanged".
 *
 * ADR 020 D8 + D9 + R4.
 */
export async function handleCoachQuietOff(deps: CoachSubcommandCtx): Promise<void> {
  const { ctx, userId, config, memory } = deps;
  const dataDir = resolveDataDir(config);

  try {
    await clearQuietMode(userId, dataDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ userId, err: msg }, '/coach quiet off: clearQuietMode failed');
    await ctx.reply(`Couldn't clear quiet mode: ${msg}`).catch(() => {});
    return;
  }

  // Audit (coach.global_quiet.engaged — off action)
  try {
    memory.auditLog.insert({
      category: 'coach.global_quiet.engaged',
      actor_user_id: userId,
      detail: { action: 'off' },
    });
  } catch (auditErr) {
    log.warn(
      { userId, err: auditErr instanceof Error ? auditErr.message : String(auditErr) },
      '/coach quiet off: audit insert failed (non-fatal)',
    );
  }

  await ctx
    .reply('Quiet mode cleared. Event triggers resumed. Scheduled profile DMs are unchanged.')
    .catch(() => {});

  log.info({ userId }, '/coach quiet off: cleared');
}
