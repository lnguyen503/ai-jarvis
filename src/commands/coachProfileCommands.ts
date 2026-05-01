/**
 * Coach profile commands (v1.20.0 commit 2).
 *
 * Handles:
 *   /coach setup [profile] HH:MM      — create/update a profile schedule
 *   /coach setup weekly <day> HH:MM   — weekly profile schedule
 *   /coach off [profile|all]           — delete one or all profile tasks
 *   /coach status                      — multi-profile status display
 *
 * Profiles: morning, midday, evening, weekly (ADR 020 D1 closed set).
 * Markers: __coach_morning__, __coach_midday__, __coach_evening__, __coach_weekly__
 *
 * Parser strategy (ADR 020 D4 binding): regex + keyword tokens; NO LLM.
 * HH:MM and weekday parsing delegates to src/coach/profileTypes.ts helpers (ADR 020 D1 SSOT).
 *
 * Dependency edges (binding per ADR 020 D16):
 *   coachProfileCommands.ts → commands/coachSubcommands (CoachSubcommandCtx shared type)
 *   coachProfileCommands.ts → coach/index (marker constants + task helpers)
 *   coachProfileCommands.ts → coach/profileTypes (parseHHMM, parseWeeklyDay, isCoachProfile)
 *   coachProfileCommands.ts → logger
 *   NO import from agent/, gateway/, or webapp/.
 *
 * ADR 020 D1 + D2 + D3 + D4.
 */

import type { CoachSubcommandCtx } from './coachSubcommands.js';
import {
  COACH_PROFILES,
  isCoachProfile,
  parseHHMM,
  parseWeeklyDay,
  COACH_MARKER_BY_PROFILE,
  upsertCoachTaskByProfile,
  deleteCoachTaskByProfile,
  deleteAllCoachTasks,
  listCoachTasks,
  LEGACY_COACH_MARKER,
} from '../coach/index.js';
import type { CoachProfile } from '../coach/index.js';
import { child } from '../logger/index.js';

const log = child({ component: 'commands.coachProfileCommands' });

// ---------------------------------------------------------------------------
// Cron-expression builder helpers (ADR 020 D4)
// ---------------------------------------------------------------------------

/**
 * Parse a HH:MM string and return a human-readable time string.
 * e.g. '08:00' → '8:00am', '14:30' → '2:30pm'
 * Returns null if the string is not valid HH:MM.
 */
export function parseHHMMToDisplay(hhmm: string): string | null {
  const parsed = parseHHMM(hhmm);
  if (!parsed.ok) return null;
  const { hour, minute } = parsed;
  const period = hour < 12 ? 'am' : 'pm';
  const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  const displayMin = String(minute).padStart(2, '0');
  return `${displayHour}:${displayMin}${period}`;
}

/**
 * Build a cron expression from hour + minute (+optional day-of-week).
 * Returns `"MM HH * * *"` (daily) or `"MM HH * * DOW"` (weekly).
 * ADR 020 D4.
 */
export function buildCronFromHHMM(hh: number, mm: number, dayOfWeek?: number): string {
  const day = dayOfWeek !== undefined ? String(dayOfWeek) : '*';
  return `${mm} ${hh} * * ${day}`;
}

// Day-of-week short name for display
const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---------------------------------------------------------------------------
// /coach setup [profile] HH:MM (ADR 020 D4)
// ---------------------------------------------------------------------------

/**
 * /coach setup [profile] HH:MM
 * /coach setup weekly <day> HH:MM
 *
 * Parses profile (default 'morning') + HH:MM (or weekly day + HH:MM).
 * Creates/updates a scheduled task with description = __coach_<profile>__.
 * Profile defaults to 'morning' if omitted.
 *
 * Grammar (ADR 020 D4):
 *   /coach setup [profile] HH:MM
 *   /coach setup weekly <day> HH:MM
 *
 * ADR 020 D4.
 */
export async function handleCoachSetupWithProfile(
  deps: CoachSubcommandCtx,
  args: string[],
): Promise<void> {
  const { ctx, userId, chatId, memory } = deps;

  // Normalize args to non-empty strings
  const parts = args.map((a) => a.trim()).filter((a) => a.length > 0);

  // Parse: detect [profile] [day] HH:MM
  let profile: CoachProfile = 'morning'; // default
  let hhmmStr: string | undefined;
  let dayOfWeek: number | undefined;

  if (parts.length === 0) {
    await ctx
      .reply(
        'Usage: /coach setup [profile] HH:MM\n' +
          '  Profiles: morning (default), midday, evening, weekly\n' +
          '  Examples: /coach setup 08:00\n' +
          '            /coach setup midday 12:00\n' +
          '            /coach setup weekly mon 09:00',
      )
      .catch(() => {});
    return;
  }

  // Case 1: /coach setup HH:MM (no profile)
  if (parts.length === 1) {
    hhmmStr = parts[0]!;
    // profile stays 'morning' (default)
  }
  // Case 2: /coach setup <profile> HH:MM
  else if (parts.length === 2) {
    const possibleProfile = parts[0]!;
    if (isCoachProfile(possibleProfile)) {
      if (possibleProfile === 'weekly') {
        // weekly requires day+time → error
        await ctx
          .reply(
            'Weekly profile requires a day: /coach setup weekly <day> HH:MM\n' +
              '  Days: mon, tue, wed, thu, fri, sat, sun',
          )
          .catch(() => {});
        return;
      }
      profile = possibleProfile;
      hhmmStr = parts[1]!;
    } else {
      // Not a profile — might be bad input
      await ctx
        .reply(
          `Unknown profile "${possibleProfile}". Valid profiles: morning, midday, evening, weekly.\n` +
            'Usage: /coach setup [profile] HH:MM',
        )
        .catch(() => {});
      return;
    }
  }
  // Case 3: /coach setup weekly <day> HH:MM
  else if (parts.length === 3) {
    const possibleProfile = parts[0]!;
    if (!isCoachProfile(possibleProfile) || possibleProfile !== 'weekly') {
      await ctx
        .reply(
          'Too many arguments. Usage:\n' +
            '  /coach setup [profile] HH:MM\n' +
            '  /coach setup weekly <day> HH:MM',
        )
        .catch(() => {});
      return;
    }
    profile = 'weekly';
    const dayResult = parseWeeklyDay(parts[1]!);
    if (!dayResult.ok) {
      await ctx
        .reply(
          `Invalid day "${parts[1]}". Use: mon, tue, wed, thu, fri, sat, sun.`,
        )
        .catch(() => {});
      return;
    }
    dayOfWeek = dayResult.day;
    hhmmStr = parts[2]!;
  } else {
    await ctx
      .reply(
        'Too many arguments. Usage:\n' +
          '  /coach setup [profile] HH:MM\n' +
          '  /coach setup weekly <day> HH:MM',
      )
      .catch(() => {});
    return;
  }

  // Parse the HH:MM
  if (!hhmmStr) {
    await ctx.reply('Missing time. Use HH:MM format (e.g. 08:00, 14:30).').catch(() => {});
    return;
  }

  const timeResult = parseHHMM(hhmmStr);
  if (!timeResult.ok) {
    await ctx
      .reply(
        `Couldn't parse "${hhmmStr}" — use HH:MM (e.g. 08:00, 14:30) or '/coach status' to see all profiles.`,
      )
      .catch(() => {});
    log.warn({ userId, hhmmStr, profile }, '/coach setup: invalid HH:MM');
    return;
  }

  const { hour, minute } = timeResult;
  const cronExpression = buildCronFromHHMM(hour, minute, dayOfWeek);

  try {
    upsertCoachTaskByProfile(memory, userId, chatId, profile, cronExpression);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ userId, profile, hhmmStr, err: msg }, '/coach setup: upsertCoachTaskByProfile failed');
    await ctx.reply(`Couldn't set up Coach Jarvis: ${msg}`).catch(() => {});
    return;
  }

  // Reload scheduler so the new task fires immediately (v1.18.0 P2 fix Item 3 carry-forward)
  try {
    deps.scheduler?.reload();
  } catch (reloadErr) {
    log.warn(
      { userId, err: reloadErr instanceof Error ? reloadErr.message : String(reloadErr) },
      '/coach setup: scheduler.reload() threw (non-fatal)',
    );
  }

  const displayTime = parseHHMMToDisplay(hhmmStr) ?? hhmmStr;
  const profileLabel = profile.charAt(0).toUpperCase() + profile.slice(1);
  let replyMsg: string;
  if (profile === 'weekly' && dayOfWeek !== undefined) {
    const dayName = DOW_NAMES[dayOfWeek] ?? String(dayOfWeek);
    replyMsg =
      `Coach Jarvis (${profileLabel}) active every ${dayName} at ${displayTime}. ` +
      `Use \`/coach off ${profile}\` to pause this schedule.`;
  } else {
    replyMsg =
      `Coach Jarvis (${profileLabel}) active daily at ${displayTime}. ` +
      `Use \`/coach off ${profile}\` to pause this schedule.`;
  }

  await ctx.reply(replyMsg).catch(() => {});
  log.info({ userId, profile, cronExpression, displayTime }, '/coach setup: success');
}

// ---------------------------------------------------------------------------
// /coach off [profile|all] (ADR 020 D4)
// ---------------------------------------------------------------------------

/**
 * /coach off [profile|all]
 *
 * Deletes one specific profile task or all profile tasks.
 * profileOrAll defaults to 'all' if omitted.
 * Memory is preserved.
 *
 * ADR 020 D4.
 */
export async function handleCoachOffByProfile(
  deps: CoachSubcommandCtx,
  profileOrAll: string,
): Promise<void> {
  const { ctx, userId, memory } = deps;
  const arg = profileOrAll.trim().toLowerCase() || 'all';

  if (arg === 'all') {
    const deleted = deleteAllCoachTasks(memory, userId);
    try {
      deps.scheduler?.reload();
    } catch (reloadErr) {
      log.warn(
        { userId, err: reloadErr instanceof Error ? reloadErr.message : String(reloadErr) },
        '/coach off all: scheduler.reload() threw (non-fatal)',
      );
    }
    await ctx
      .reply(
        deleted === 0
          ? 'No coach profiles were active. Memory preserved.'
          : `Coach Jarvis paused (all ${deleted} profile${deleted === 1 ? '' : 's'} removed). ` +
              `Memory preserved. Use \`/coach setup [profile] HH:MM\` to resume.`,
      )
      .catch(() => {});
    log.info({ userId, deleted }, '/coach off all: success');
    return;
  }

  if (!isCoachProfile(arg)) {
    await ctx
      .reply(
        `Unknown profile "${arg}". Valid profiles: morning, midday, evening, weekly, all.`,
      )
      .catch(() => {});
    return;
  }

  const profile = arg as CoachProfile;
  const deleted = deleteCoachTaskByProfile(memory, userId, profile);

  try {
    deps.scheduler?.reload();
  } catch (reloadErr) {
    log.warn(
      { userId, err: reloadErr instanceof Error ? reloadErr.message : String(reloadErr) },
      '/coach off [profile]: scheduler.reload() threw (non-fatal)',
    );
  }

  const profileLabel = profile.charAt(0).toUpperCase() + profile.slice(1);
  await ctx
    .reply(
      deleted
        ? `Coach Jarvis (${profileLabel}) paused. Memory preserved. ` +
            `Use \`/coach setup ${profile} HH:MM\` to resume.`
        : `Coach Jarvis (${profileLabel}) was not active.`,
    )
    .catch(() => {});

  log.info({ userId, profile, deleted }, '/coach off [profile]: success');
}

// ---------------------------------------------------------------------------
// /coach status (multi-profile) (ADR 020 D4)
// ---------------------------------------------------------------------------

/**
 * /coach status
 *
 * Displays per-profile schedule status for all 4 profiles.
 * Format (ADR 020 D4):
 *
 *   Morning: 8:00am ✓
 *   Midday: not set
 *   Evening: 7:00pm ✓
 *   Weekly: Mon 9:00am ✓
 *
 *   Event triggers: ON
 *   Quiet mode: not active
 *
 * ADR 020 D4.
 */
export async function handleCoachStatusMultiProfile(deps: CoachSubcommandCtx): Promise<void> {
  const { ctx, userId, memory } = deps;

  const allTasks = listCoachTasks(memory, userId);
  const lines: string[] = [];

  for (const profile of COACH_PROFILES) {
    const marker = COACH_MARKER_BY_PROFILE[profile];
    const task = allTasks.find((t) => t.description === marker);
    const profileLabel = profile.charAt(0).toUpperCase() + profile.slice(1);

    if (!task) {
      lines.push(`${profileLabel}: not set`);
      continue;
    }

    // Parse cron expression to display time
    // Format: "MM HH * * DOW" or "MM HH * * *"
    const cronParts = task.cron_expression.split(' ');
    if (cronParts.length < 2) {
      lines.push(`${profileLabel}: active (cron: ${task.cron_expression})`);
      continue;
    }

    const minutePart = cronParts[0] ?? '0';
    const hourPart = cronParts[1] ?? '0';
    const dowPart = cronParts[4];
    const hour = parseInt(hourPart, 10);
    const minute = parseInt(minutePart, 10);

    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
      lines.push(`${profileLabel}: active (cron: ${task.cron_expression})`);
      continue;
    }

    const displayTime = parseHHMMToDisplay(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);

    if (profile === 'weekly' && dowPart && dowPart !== '*') {
      const dowNum = parseInt(dowPart, 10);
      const dayName = Number.isFinite(dowNum) ? (DOW_NAMES[dowNum] ?? dowPart) : dowPart;
      lines.push(`${profileLabel}: ${dayName} ${displayTime ?? task.cron_expression} ✓`);
    } else {
      lines.push(`${profileLabel}: ${displayTime ?? task.cron_expression} ✓`);
    }
  }

  // Check for legacy __coach__ task (back-compat display)
  const legacyTask = allTasks.find((t) => t.description === LEGACY_COACH_MARKER);
  if (legacyTask) {
    lines.push(`Legacy: active (will migrate to morning on next restart)`);
  }

  // Event triggers status (always ON until Dev-B's rateLimits.ts is wired)
  lines.push('');
  lines.push('Event triggers: ON (coming in v1.20.0)');
  lines.push('Quiet mode: not active');

  await ctx.reply(lines.join('\n')).catch(() => {});
  log.info({ userId, profileCount: allTasks.length }, '/coach status multi-profile: replied');
}
