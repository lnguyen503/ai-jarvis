/**
 * Coach subcommands handler (v1.18.0 + v1.19.0 D2).
 *
 * Extracted from commands/organize.ts per ADR 018-revisions W1 to keep
 * organize.ts under the 500 LOC soft threshold once coach subcommands land.
 *
 * v1.18.0 subcommands (under /organize coach):
 *   /organize coach setup [HH:MM]  — create or update the daily coach task
 *   /organize coach off            — delete (pause) the coach task
 *   /organize coach reset          — two-tap delete-all-coach-memory
 *   /organize coach reset confirm  — confirm the reset within 30s window
 *
 * v1.19.0 D2 top-level subcommands (under /coach):
 *   /coach on [HH:MM]  — activate daily coaching (default 08:00); alias for /organize coach setup
 *   /coach off         — pause coach; alias for /organize coach off
 *   /coach status      — current state: on/off, time, item count, last/next fire
 *
 * ADR 018 D6 + D9 + revisions W1.
 * ADR 019 D2.
 */

import type { Context } from 'grammy';
import type { MemoryApi } from '../memory/index.js';
import { upsertCoachTask, deleteCoachTask, resetCoachMemory, findCoachTask } from '../coach/index.js';
import { parseOverrideIntents } from '../coach/userOverrideParser.js';
import { coachLogUserOverride } from '../coach/coachOverrideTool.js';
import { listItems } from '../organize/storage.js';
import { child } from '../logger/index.js';
import { resolveDataDir } from '../config/dataDir.js';
import type { AppConfig } from '../config/index.js';
import type { SchedulerApi } from '../scheduler/index.js';

const log = child({ component: 'commands.coachSubcommands' });

// ---------------------------------------------------------------------------
// Context type for subcommand handlers
// ---------------------------------------------------------------------------

export interface CoachSubcommandCtx {
  ctx: Context;
  userId: number;
  chatId: number;
  memory: MemoryApi;
  config: AppConfig;
  /**
   * v1.18.0 P2 fix Item 3 (Scalability WARNING-1.18.0.A): scheduler reference
   * for reload-after-mutate. Late-bound — null is accepted for tests and
   * during the brief boot window before the scheduler is constructed.
   * Without this, /organize coach setup writes the task but the new cron
   * job is not registered until pm2 restart. Same trap as v1.17.0
   * WARNING-1.17.0.A in /scheduled.
   */
  scheduler?: Pick<SchedulerApi, 'reload'> | null;
}

// ---------------------------------------------------------------------------
// HH:MM validation
// ---------------------------------------------------------------------------

const HHMM_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

/**
 * Parse a HH:MM string and return the cron expression, or null on failure.
 * e.g. '08:00' → '0 8 * * *', '09:30' → '30 9 * * *'
 */
function hhmm_to_cron(hhmm: string): string | null {
  if (!HHMM_RE.test(hhmm)) return null;
  const [h, m] = hhmm.split(':');
  const hour = parseInt(h!, 10);
  const minute = parseInt(m!, 10);
  return `${minute} ${hour} * * *`;
}

// ---------------------------------------------------------------------------
// 30-second confirm-window store (in-memory; resets on restart)
// ---------------------------------------------------------------------------

interface ConfirmEntry {
  expiresAt: number; // Date.now() + 30_000
}

const pendingResetConfirms = new Map<number, ConfirmEntry>(); // keyed by userId

function hasValidConfirm(userId: number): boolean {
  const entry = pendingResetConfirms.get(userId);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    pendingResetConfirms.delete(userId);
    return false;
  }
  return true;
}

function setConfirm(userId: number): void {
  pendingResetConfirms.set(userId, { expiresAt: Date.now() + 30_000 });
}

function clearConfirm(userId: number): void {
  pendingResetConfirms.delete(userId);
}

/** Test hook — clears all pending confirm entries. */
export function _resetPendingConfirmsForTests(): void {
  pendingResetConfirms.clear();
}

// ---------------------------------------------------------------------------
// Subcommand handlers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * /organize coach setup [HH:MM]
 *
 * Creates or idempotently updates the user's daily coach task.
 * Default time: 08:00 (cron: '0 8 * * *').
 * Validates HH:MM format; rejects invalid times.
 *
 * ADR 018 D6 + D9.
 */
export async function handleCoachSetup(
  deps: CoachSubcommandCtx,
  hhmmArg?: string,
): Promise<void> {
  const { ctx, userId, chatId, memory } = deps;
  const hhmm = hhmmArg?.trim() ?? '08:00';

  const cronExpression = hhmm_to_cron(hhmm);
  if (cronExpression === null) {
    await ctx
      .reply(
        `Invalid time format: "${hhmm}". Use HH:MM (e.g. 08:00, 14:30).`,
      )
      .catch(() => {});
    log.warn({ userId, hhmm }, '/organize coach setup: invalid HH:MM');
    return;
  }

  try {
    upsertCoachTask(memory, userId, chatId, cronExpression);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ userId, hhmm, err: msg }, '/organize coach setup: upsertCoachTask failed');
    await ctx
      .reply(`Couldn't set up Coach Jarvis: ${msg}`)
      .catch(() => {});
    return;
  }

  // v1.18.0 P2 fix Item 3 (Scalability WARNING-1.18.0.A): reload so the new
  // coach task fires immediately. Without this, the user's command appears
  // to succeed but no coach turn fires until pm2 restart. Same trap pattern
  // as v1.17.0 WARNING-1.17.0.A.
  try { deps.scheduler?.reload(); } catch (reloadErr) {
    log.warn(
      { userId, err: reloadErr instanceof Error ? reloadErr.message : String(reloadErr) },
      '/organize coach setup: scheduler.reload() threw (non-fatal — coach task will fire on next reload)',
    );
  }

  await ctx
    .reply(
      `Coach Jarvis active daily at ${hhmm}. ` +
        `He'll start checking your organize list tomorrow morning. ` +
        `Use \`/organize coach off\` to pause.`,
    )
    .catch(() => {});

  log.info({ userId, hhmm, cronExpression }, '/organize coach setup: success');
}

/**
 * /organize coach off
 *
 * Deletes the user's coach task (pauses coaching). Coach memory is preserved.
 * Idempotent: if no task exists, still replies with confirmation.
 *
 * ADR 018 D6.
 */
export async function handleCoachOff(deps: CoachSubcommandCtx): Promise<void> {
  const { ctx, userId, memory } = deps;

  try {
    deleteCoachTask(memory, userId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ userId, err: msg }, '/organize coach off: deleteCoachTask failed');
    await ctx.reply(`Couldn't pause Coach Jarvis: ${msg}`).catch(() => {});
    return;
  }

  // v1.18.0 P2 fix Item 3 (Scalability WARNING-1.18.0.A): same trap as setup —
  // the deleted task remains registered in node-cron until pm2 restart unless
  // we trigger a reload. Without reload, the user pauses the coach but the
  // next scheduled fire still goes through (since the row is gone the fire
  // path skips, but the cron timer keeps firing until restart).
  try { deps.scheduler?.reload(); } catch (reloadErr) {
    log.warn(
      { userId, err: reloadErr instanceof Error ? reloadErr.message : String(reloadErr) },
      '/organize coach off: scheduler.reload() threw (non-fatal)',
    );
  }

  await ctx
    .reply(
      `Coach Jarvis paused. Your coach memory is preserved. ` +
        `Use \`/organize coach setup\` to resume.`,
    )
    .catch(() => {});

  log.info({ userId }, '/organize coach off: success');
}

/**
 * /organize coach reset
 * /organize coach reset confirm
 *
 * Two-tap confirm pattern:
 *   First call: shows confirm prompt + sets 30s window.
 *   Second call with 'confirm' arg within 30s: calls resetCoachMemory.
 *   Second call after 30s: window expired error.
 *
 * ADR 018 D6 (reset helper).
 */
export async function handleCoachReset(
  deps: CoachSubcommandCtx,
  confirmed: boolean,
): Promise<void> {
  const { ctx, userId, config } = deps;
  const dataDir = resolveDataDir(config);

  if (!confirmed) {
    // First tap: show confirm message and arm the 30s window
    setConfirm(userId);
    await ctx
      .reply(
        `This deletes ALL coach memory entries for ALL items ` +
          `(the history of nudges, research, ideas, plans). ` +
          `Reply \`/organize coach reset confirm\` within 30s to proceed.`,
      )
      .catch(() => {});
    log.info({ userId }, '/organize coach reset: confirm requested');
    return;
  }

  // Second tap: confirm
  if (!hasValidConfirm(userId)) {
    await ctx
      .reply(
        `Confirm window expired (30s). ` +
          `Run \`/organize coach reset\` again to start a new confirmation.`,
      )
      .catch(() => {});
    log.warn({ userId }, '/organize coach reset confirm: window expired');
    return;
  }

  clearConfirm(userId);

  let deletedCount = 0;
  try {
    deletedCount = await resetCoachMemory(userId, dataDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ userId, err: msg }, '/organize coach reset: resetCoachMemory failed');
    await ctx.reply(`Couldn't reset coach memory: ${msg}`).catch(() => {});
    return;
  }

  await ctx
    .reply(`All coach memory cleared. (${deletedCount} entr${deletedCount === 1 ? 'y' : 'ies'} deleted.)`)
    .catch(() => {});

  log.info({ userId, deletedCount }, '/organize coach reset: success');
}

/**
 * Render help text for /organize coach with no recognized subcommand.
 */
export async function handleCoachHelp(ctx: Context): Promise<void> {
  await ctx
    .reply(
      'Coach Jarvis commands:\n' +
        '  /organize coach setup [HH:MM]    — activate daily coaching (default 08:00)\n' +
        '  /organize coach off              — pause (memory preserved)\n' +
        '  /organize coach reset            — delete all coach memory (two-tap confirm)\n' +
        '\nTop-level aliases (v1.19.0):\n' +
        '  /coach on [HH:MM]                — activate daily coaching (default 08:00)\n' +
        '  /coach off                       — pause (memory preserved)\n' +
        '  /coach status                    — current coach state\n',
    )
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// v1.19.0 D2 — Top-level /coach on /off /status handlers
// ---------------------------------------------------------------------------

/**
 * /coach on [HH:MM]
 *
 * Top-level alias for /organize coach setup [HH:MM].
 * Default time: 08:00 if not specified.
 * Idempotent: safe to call multiple times.
 *
 * ADR 019 D2.
 */
export async function handleCoachOnTopLevel(
  deps: CoachSubcommandCtx,
  hhmmArg?: string,
): Promise<void> {
  // Delegate to the existing setup handler — same behavior, top-level UX
  await handleCoachSetup(deps, hhmmArg);
  log.info({ userId: deps.userId, hhmm: hhmmArg ?? '08:00' }, '/coach on: delegated to handleCoachSetup');
}

/**
 * /coach off
 *
 * Top-level alias for /organize coach off.
 * Deletes the coach task (pause). Memory preserved.
 * Idempotent.
 *
 * ADR 019 D2.
 */
export async function handleCoachOffTopLevel(deps: CoachSubcommandCtx): Promise<void> {
  // Delegate to the existing off handler — same behavior, top-level UX
  await handleCoachOff(deps);
  log.info({ userId: deps.userId }, '/coach off: delegated to handleCoachOff');
}

/**
 * /coach status
 *
 * Reports the current coach state:
 *   - Whether the coach is ON or OFF
 *   - If ON: the scheduled time (derived from cron expression)
 *   - Count of items currently being monitored (coachIntensity != 'off')
 *
 * ADR 019 D2.
 */
export async function handleCoachStatus(deps: CoachSubcommandCtx): Promise<void> {
  const { ctx, userId, memory, config } = deps;
  const dataDir = resolveDataDir(config);

  // Check if the coach task exists
  const task = findCoachTask(memory, userId);

  let statusLine: string;
  if (!task) {
    statusLine = 'Coach is **OFF**. Use `/coach on` to activate.';
  } else {
    // Parse the cron expression to get a human-readable time
    // Cron format: "minute hour * * *" (e.g. "0 8 * * *" → 08:00)
    const cronParts = task.cron_expression.split(' ');
    let timeStr = task.cron_expression;
    if (cronParts.length >= 2) {
      const minute = cronParts[0];
      const hour = cronParts[1];
      if (minute !== undefined && hour !== undefined) {
        const h = parseInt(hour, 10);
        const m = parseInt(minute, 10);
        if (Number.isFinite(h) && Number.isFinite(m)) {
          timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        }
      }
    }

    // Count items being actively coached (coachIntensity != 'off')
    let monitoredCount = 0;
    try {
      const items = await listItems(userId, dataDir);
      monitoredCount = items.filter(
        (i) => i.frontMatter.coachIntensity !== 'off' && !i.frontMatter.deletedAt && i.frontMatter.status !== 'done',
      ).length;
    } catch (_err) {
      // Non-fatal: count stays 0 if listing fails
      log.warn({ userId }, '/coach status: listItems failed; using count=0');
    }

    statusLine =
      `Coach is **ON**, daily at ${timeStr}. ` +
      `${monitoredCount} item${monitoredCount === 1 ? '' : 's'} being monitored (auto). ` +
      `Use \`/coach off\` to pause.`;
  }

  await ctx.reply(statusLine).catch(() => {});
  log.info({ userId, taskExists: !!task }, '/coach status: replied');
}

// ---------------------------------------------------------------------------
// v1.19.0 R3 — /coach back-off|push|defer <item> explicit override commands
// ---------------------------------------------------------------------------

/**
 * Internal helper: run the parser + call coach_log_user_override for an explicit
 * /coach back-off|push|defer command. The user has explicitly requested the override
 * so this is authorized; tool is called inline (NOT via a coach agent turn).
 *
 * ADR 019 R3: chat-side calls do NOT increment coachTurnCounters (per v1.18.0 R3 invariant 5).
 * ADR 019 W2: this command does NOT call enqueueSchedulerTurn; it invokes the tool directly.
 */
async function handleExplicitOverride(
  deps: CoachSubcommandCtx,
  intentKind: 'back_off' | 'push' | 'defer',
  userMessage: string,
): Promise<void> {
  const { ctx, userId, config } = deps;
  const dataDir = resolveDataDir(config);

  // Load active items for fuzzy matching
  let items;
  try {
    items = await listItems(userId, dataDir);
  } catch (_err) {
    await ctx.reply('Could not load your organize items. Try again.').catch(() => {});
    return;
  }

  // Run the pure parser to find the best matching item
  const intents = parseOverrideIntents([userMessage], items);
  const matchedIntent = intents.find((i) => i.intent === intentKind) ?? intents[0];

  if (!matchedIntent) {
    await ctx
      .reply(
        `Couldn't match "${userMessage}" to any of your organize items. ` +
          `Try a more specific title or check \`/organize list\`.`,
      )
      .catch(() => {});
    log.warn({ userId, userMessage, intentKind }, '/coach override: no match found');
    return;
  }

  // Compute expiry per intent
  const now = new Date();
  let expiresAtIso: string;
  if (intentKind === 'back_off') {
    expiresAtIso = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(); // +7 days
  } else if (intentKind === 'defer') {
    expiresAtIso = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(); // +1 day
  } else {
    expiresAtIso = now.toISOString(); // push: single-run expiry (now = already expired next run)
  }

  // Build a minimal ToolContext for the tool call
  // Chat-side: coachTurnCounters is undefined (per v1.18.0 R3 invariant 5)
  const toolCtx = {
    userId: deps.userId,
    chatId: deps.chatId,
    sessionId: null,
    config: deps.config,
    memory: deps.memory,
    safety: {
      scrub: (s: string) => s, // minimal scrub for chat-side calls
    },
    coachTurnCounters: undefined, // NOT a coach turn; no counter increment
  } as unknown as Parameters<typeof coachLogUserOverride.execute>[1];

  const result = await coachLogUserOverride.execute(
    {
      itemId: matchedIntent.itemId,
      intent: intentKind,
      fromMessage: userMessage.slice(0, 500),
      expiresAtIso,
    },
    toolCtx,
  );

  if (!result.ok) {
    await ctx.reply(`Override failed: ${result.error?.message ?? 'Unknown error'}`).catch(() => {});
    log.warn({ userId, intentKind, itemId: matchedIntent.itemId, error: result.error }, '/coach override: tool failed');
    return;
  }

  const intentLabel = intentKind === 'back_off' ? 'backed off' : intentKind === 'push' ? 'push priority set' : 'deferred';
  await ctx
    .reply(
      `Got it — ${intentLabel} on item "${matchedIntent.itemId}" (score: ${matchedIntent.fuzzyScore.toFixed(2)}). ` +
        `Expires: ${expiresAtIso.slice(0, 10)}.`,
    )
    .catch(() => {});

  log.info({ userId, intentKind, itemId: matchedIntent.itemId }, '/coach override: success');
}

/**
 * /coach back-off <item-or-keyword>
 *
 * Explicitly sets a 7-day back_off override for the closest-matching item.
 * ADR 019 R3 — explicit user chat command; calls coach_log_user_override inline.
 */
export async function handleCoachBackOff(
  deps: CoachSubcommandCtx,
  itemRef: string,
): Promise<void> {
  if (!itemRef.trim()) {
    await deps.ctx.reply('Usage: /coach back-off <item title or keyword>').catch(() => {});
    return;
  }
  await handleExplicitOverride(deps, 'back_off', itemRef.trim());
}

/**
 * /coach push <item-or-keyword>
 *
 * Explicitly sets a single-run push override for the closest-matching item.
 * ADR 019 R3.
 */
export async function handleCoachPush(
  deps: CoachSubcommandCtx,
  itemRef: string,
): Promise<void> {
  if (!itemRef.trim()) {
    await deps.ctx.reply('Usage: /coach push <item title or keyword>').catch(() => {});
    return;
  }
  await handleExplicitOverride(deps, 'push', itemRef.trim());
}

/**
 * /coach defer <item-or-keyword>
 *
 * Explicitly sets a 1-day defer override for the closest-matching item.
 * ADR 019 R3.
 */
export async function handleCoachDefer(
  deps: CoachSubcommandCtx,
  itemRef: string,
): Promise<void> {
  if (!itemRef.trim()) {
    await deps.ctx.reply('Usage: /coach defer <item title or keyword>').catch(() => {});
    return;
  }
  await handleExplicitOverride(deps, 'defer', itemRef.trim());
}
