/**
 * /organize command (v1.8.6).
 *
 *   /organize                  — show active-items summary (same as system-prompt
 *                                injection, formatted for humans)
 *   /organize all              — show all items including done/abandoned (up to 30)
 *   /organize tasks            — filter by type=task (active only)
 *   /organize events           — filter by type=event (active only)
 *   /organize goals            — filter by type=goal (active only)
 *   /organize <id>             — show full item (front-matter + notes + progress)
 *   /organize tag <tagname>    — filter by tag (active only)
 *   /organize off              — disable active-items injection for this session
 *   /organize on               — re-enable
 *
 * DM-ONLY. In group chats responds with a brief redirect and returns.
 * READ-ONLY. All writes go through agent tools so audit/privacy stays singular.
 *
 * See ARCHITECTURE.md §16.9 for the full spec.
 */

import type { Context } from 'grammy';
import type { AppConfig } from '../config/index.js';
import { resolveDataDir } from '../config/dataDir.js';
import type { MemoryApi } from '../memory/index.js';
import { readItem, listItems } from '../organize/storage.js';
import { restoreItem, listTrashedItems, findClosestTrashedIds } from '../organize/trash.js';
import { isGroupChat } from '../gateway/groupGate.js';
import { markdownToTelegramHtml } from '../messaging/markdownToHtml.js';
import { child } from '../logger/index.js';
import type { RemindersApi } from '../organize/reminders.js';
import {
  handleCoachSetup,
  handleCoachOff,
  handleCoachReset,
  handleCoachHelp,
} from './coachSubcommands.js';
import { buildReconcileListing, handleReconcileCallback, formatReconcileItemMessage } from './reconcileHandler.js';
import { handleNagCost } from './organizeNagCost.js';

const log = child({ component: 'commands.organize' });

// ---------------------------------------------------------------------------
// Per-user injection toggle (in-memory only — resets on restart, mirrors /memory).
// ---------------------------------------------------------------------------

const organizeDisabled = new Set<number>();

export function isOrganizeDisabledForUser(userId: number): boolean {
  return organizeDisabled.has(userId);
}

/** Test hook. */
export function _resetOrganizeToggleForTests(): void {
  organizeDisabled.clear();
}

// ---------------------------------------------------------------------------
// Deps + handler signature
// ---------------------------------------------------------------------------

export interface OrganizeCommandDeps {
  config: AppConfig;
  /** v1.9.0 — null when reminders not yet initialized (e.g. in tests). */
  reminders?: RemindersApi | null;
  /** v1.11.0 — null when memory not yet initialized (e.g. in tests). */
  memory?: MemoryApi | null;
  /**
   * v1.18.0 P2 fix Item 3 (Scalability WARNING-1.18.0.A): scheduler reference
   * so /organize coach setup|off can call scheduler.reload() after mutating
   * the coach scheduled task. Same late-binding pattern as scheduledDeps in
   * the gateway. null is accepted for tests + the brief boot window.
   */
  scheduler?: Pick<import('../scheduler/index.js').SchedulerApi, 'reload'> | null;
}

// ---------------------------------------------------------------------------
// Public handler
// ---------------------------------------------------------------------------

export async function handleOrganize(ctx: Context, deps: OrganizeCommandDeps): Promise<void> {
  // DM-ONLY: must be the FIRST check — before any storage read.
  if (isGroupChat(ctx)) {
    await ctx.reply('Organize is DM-only — message me privately.').catch(() => {});
    return;
  }

  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply('No user context — cannot determine whose organize data to show.').catch(() => {});
    return;
  }

  const text = ctx.message?.text ?? '';
  const args = text.replace(/^\/organize(@\S+)?\s*/, '').trim().split(/\s+/).filter(Boolean);
  const sub = args[0]?.toLowerCase() ?? '';

  const dataDir = resolveDataDir(deps.config);

  // ---- /organize nag on | off | status | cost ----
  if (sub === 'nag') {
    await handleNag(ctx, userId, args, deps);
    return;
  }

  // ---- /organize coach [setup|off|reset] ----
  if (sub === 'coach') {
    const memory = deps.memory ?? null;
    if (!memory) {
      await ctx.reply('Memory not available for coach commands.').catch(() => {});
      return;
    }
    const coachCtx = {
      ctx,
      userId,
      chatId: ctx.chat?.id ?? userId,
      memory,
      config: deps.config,
      scheduler: deps.scheduler ?? null,
    };
    const coachSub = args[1]?.toLowerCase() ?? '';
    if (coachSub === 'setup') {
      const hhmm = args[2]; // optional; handleCoachSetup defaults to 08:00
      await handleCoachSetup(coachCtx, hhmm);
    } else if (coachSub === 'off') {
      await handleCoachOff(coachCtx);
    } else if (coachSub === 'reset') {
      const isConfirm = (args[2]?.toLowerCase() ?? '') === 'confirm';
      await handleCoachReset(coachCtx, isConfirm);
    } else {
      await handleCoachHelp(ctx);
    }
    return;
  }

  // ---- /organize reconcile ----
  if (sub === 'reconcile') {
    await handleReconcile(ctx, userId, dataDir, deps);
    return;
  }

  // ---- /organize off / on ----
  if (sub === 'off' || sub === 'disable') {
    organizeDisabled.add(userId);
    await ctx.reply(
      'Organize injection OFF for this session. Active items won\'t be loaded into context until you re-enable with /organize on.',
    ).catch(() => {});
    log.info({ userId }, '/organize off');
    return;
  }
  if (sub === 'on' || sub === 'enable') {
    organizeDisabled.delete(userId);
    await ctx.reply(
      'Organize injection ON. Active items are loaded into context for your turns.',
    ).catch(() => {});
    log.info({ userId }, '/organize on');
    return;
  }

  // ---- /organize restore <id> ----
  if (sub === 'restore') {
    const targetId = args[1] ?? '';
    const idPattern = /^\d{4}-\d{2}-\d{2}-[a-z0-9]{4}$/;
    if (!idPattern.test(targetId)) {
      await ctx.reply(
        'Usage: /organize restore <id>\nItem ids look like: 2026-04-25-ab1c',
      ).catch(() => {});
      return;
    }
    await handleRestoreItem(ctx, userId, dataDir, targetId, deps);
    return;
  }

  // ---- /organize trash list [offset] ----
  if (sub === 'trash') {
    const trashSub = args[1]?.toLowerCase() ?? '';
    if (trashSub === 'list') {
      const parsedOffset = parseTrashListOffset(args[2]);
      if (!parsedOffset.ok) {
        await ctx.reply('Invalid offset; must be a non-negative integer (≤ 100000).').catch(() => {});
        return;
      }
      await handleTrashList(ctx, userId, dataDir, parsedOffset.offset);
      return;
    }
    // Unknown trash subcommand — fall through to unknown-subcommand handler
  }

  // ---- /organize <id> — show full item detail ----
  // Item ids are YYYY-MM-DD-xxxx (date + 4 lowercase alphanumeric chars).
  const idPattern = /^\d{4}-\d{2}-\d{2}-[a-z0-9]{4}$/;
  if (idPattern.test(sub)) {
    await handleShowItem(ctx, userId, dataDir, sub);
    return;
  }

  // ---- /organize tag <tagname> ----
  if (sub === 'tag') {
    const tagName = args[1] ?? '';
    if (!tagName) {
      await ctx.reply('Usage: /organize tag <tagname>').catch(() => {});
      return;
    }
    await handleFilteredList(ctx, userId, dataDir, { filter: 'active', tag: tagName }, `tag: ${tagName}`);
    return;
  }

  // ---- /organize all ----
  if (sub === 'all') {
    await handleFilteredList(ctx, userId, dataDir, { filter: 'all' }, 'all');
    return;
  }

  // ---- /organize tasks / events / goals ----
  if (sub === 'tasks') {
    await handleFilteredList(ctx, userId, dataDir, { filter: 'active', type: 'task' }, 'tasks');
    return;
  }
  if (sub === 'events') {
    await handleFilteredList(ctx, userId, dataDir, { filter: 'active', type: 'event' }, 'events');
    return;
  }
  if (sub === 'goals') {
    await handleFilteredList(ctx, userId, dataDir, { filter: 'active', type: 'goal' }, 'goals');
    return;
  }

  // ---- bare /organize or /organize show — active-items summary ----
  if (sub === '' || sub === 'show' || sub === 'list') {
    const disabled = organizeDisabled.has(userId)
      ? '\n\n_(injection currently OFF — /organize on to re-enable)_'
      : '';
    await handleFilteredList(
      ctx, userId, dataDir, { filter: 'active' }, 'active', disabled,
    );
    return;
  }

  // ---- unknown subcommand ----
  await ctx.reply(
    'Usage:\n' +
    '  /organize              — show active items\n' +
    '  /organize all          — show all items (active + done + abandoned)\n' +
    '  /organize tasks        — show active tasks only\n' +
    '  /organize events       — show active events only\n' +
    '  /organize goals        — show active goals only\n' +
    '  /organize <id>         — show full item detail\n' +
    '  /organize restore <id> — restore a soft-deleted item from trash\n' +
    '  /organize trash list [offset] — list deleted items in trash\n' +
    '  /organize tag <name>   — filter active items by tag\n' +
    '  /organize off / on     — toggle active-items injection for this session\n' +
    '  /organize nag on|off|status|cost [days] — manage proactive nudge reminders\n' +
    '  /organize coach setup [HH:MM] — activate daily coaching (default 08:00)\n' +
    '  /organize coach off    — pause coach (memory preserved)\n' +
    '  /organize coach reset  — delete all coach memory\n' +
    '  /organize reconcile    — review and fix organize inconsistencies',
  ).catch(() => {});
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

interface ListOptions {
  filter: 'active' | 'all';
  type?: 'task' | 'event' | 'goal';
  tag?: string;
}

async function handleFilteredList(
  ctx: Context,
  userId: number,
  dataDir: string,
  opts: ListOptions,
  label: string,
  suffix = '',
): Promise<void> {
  try {
    let items = await listItems(userId, dataDir, {
      status: opts.filter === 'active' ? 'active' : undefined,
      type: opts.type,
      tag: opts.tag,
    });

    // For /organize all, cap at 30.
    const CAP = opts.filter === 'all' ? 30 : 50;
    const total = items.length;
    if (items.length > CAP) {
      items = items.slice(0, CAP);
    }

    if (items.length === 0) {
      const typeLabel = opts.type ? ` ${opts.type}` : '';
      const tagLabel = opts.tag ? ` with tag "${opts.tag}"` : '';
      const msg =
        total === 0
          ? `No${typeLabel} items${tagLabel} yet.\n\n` +
            `To create one, just tell me: "add a task: …", "schedule an event at …", or "set a goal: …".` +
            suffix
          : `No matching items.${suffix}`;
      await ctx.reply(msg, { parse_mode: 'HTML' }).catch(() => {});
      return;
    }

    // Build markdown list then convert to HTML.
    const lines: string[] = [];
    for (const item of items) {
      const { id, type, status, title, due, tags } = item.frontMatter;
      const goalPin = type === 'goal' ? '⚑ ' : '';
      const dueStr = due ? ` — due ${due}` : '';
      const statusStr = status !== 'active' ? ` [${status}]` : '';
      const tagsStr = tags.length > 0 ? ` #${tags.join(' #')}` : '';
      lines.push(`- **[${type}]** ${goalPin}${title}${dueStr}${statusStr}${tagsStr} \`${id}\``);
    }

    const truncatedNote =
      total > items.length ? `\n\n_Showing ${items.length} of ${total} items_` : '';
    const markdown = lines.join('\n') + truncatedNote + suffix;
    const html = markdownToTelegramHtml(markdown);

    await ctx.reply(html, { parse_mode: 'HTML' }).catch(() => {});
    log.info({ userId, label, count: items.length }, '/organize list');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ userId, err: msg }, '/organize list failed');
    await ctx.reply(`Couldn't load items: ${msg}`).catch(() => {});
  }
}

async function handleNag(
  ctx: Context,
  userId: number,
  args: string[],
  deps: OrganizeCommandDeps,
): Promise<void> {
  const subSub = args[1] ?? '';
  const reminders = deps.reminders ?? null;

  // ---- /organize nag cost [days] ----
  if (subSub === 'cost') {
    const memory = deps.memory ?? null;
    if (!memory) {
      await ctx.reply('Memory not available.').catch(() => {});
      return;
    }
    await handleNagCost(ctx, userId, args[2] ?? '', { config: deps.config, memory });
    return;
  }

  if (subSub === 'off') {
    if (!reminders) {
      await ctx.reply('Reminders not available.').catch(() => {});
      return;
    }
    await reminders.setUserDisabledNag(userId, true);
    await ctx.reply(
      "Reminders OFF. Jarvis won't DM you about your organize items until you say /organize nag on." +
      ' (Your items still appear in his context during DMs.)',
    ).catch(() => {});
    log.info({ userId }, '/organize nag off');
    return;
  }

  if (subSub === 'on') {
    if (!reminders) {
      await ctx.reply('Reminders not available.').catch(() => {});
      return;
    }
    await reminders.setUserDisabledNag(userId, false);
    const dailyCap = deps.config.organize?.reminders?.dailyCap ?? 3;
    await ctx.reply(
      `Reminders ON. Jarvis will nudge you about organize items when useful (max ${dailyCap}/day, quiet hours 22:00–08:00).`,
    ).catch(() => {});
    log.info({ userId }, '/organize nag on');
    return;
  }

  if (subSub === 'status') {
    if (!reminders) {
      await ctx.reply('Reminders not available.').catch(() => {});
      return;
    }
    const status = await reminders.getNagStatus(userId);
    const onOff = status.disabledNag ? 'OFF' : 'ON';
    const dailyCap = deps.config.organize?.reminders?.dailyCap ?? 3;
    const lastNudgeStr = formatLastNudge(status.lastNudgeAt);
    const reply =
      `**Reminders:** ${onOff}\n` +
      `**Nudges today:** ${status.nudgesToday} / ${dailyCap}\n` +
      `**Last nudge:** ${lastNudgeStr}\n` +
      `**Muted items:** ${status.mutedCount}`;
    await ctx.reply(markdownToTelegramHtml(reply), { parse_mode: 'HTML' }).catch(() => {});
    log.info({ userId }, '/organize nag status');
    return;
  }

  // Unknown sub-subcommand
  await ctx.reply('Usage: /organize nag on|off|status|cost [days]').catch(() => {});
}

// ---------------------------------------------------------------------------
// /organize reconcile handler
// ---------------------------------------------------------------------------

async function handleReconcile(
  ctx: Context,
  userId: number,
  dataDir: string,
  deps: OrganizeCommandDeps,
): Promise<void> {
  const memory = deps.memory ?? null;
  if (!memory) {
    await ctx.reply('Memory not available for reconcile.').catch(() => {});
    return;
  }

  let result;
  try {
    result = await buildReconcileListing(userId, dataDir, memory, deps.config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ userId, err: msg }, '/organize reconcile: buildReconcileListing failed');
    await ctx.reply(`Couldn't load reconcile items: ${msg}`).catch(() => {});
    return;
  }

  const { items, totalCount, hotEmitter } = result;

  if (items.length === 0) {
    await ctx.reply(
      'Nothing to reconcile. /audit filter organize.inconsistency is empty (or already resolved).',
    ).catch(() => {});
    log.info({ userId }, '/organize reconcile: nothing to reconcile');
    return;
  }

  // Hot-emitter warning (R8 §2).
  if (hotEmitter) {
    await ctx.reply(
      '⚠ Your /organize has emitted 100+ inconsistency rows in 30 days. This may indicate a bug in the organize tools. Check /audit filter organize.inconsistency for the pattern.',
    ).catch(() => {});
  }

  // Send one message per item with inline keyboard.
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const text = formatReconcileItemMessage(item, i, Math.min(totalCount, 20));
    try {
      await ctx.reply(text, {
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Fix', callback_data: `rec:fix:${item.itemId}` },
            { text: '❌ Skip', callback_data: `rec:skip:${item.itemId}` },
          ]],
        },
      });
    } catch (err) {
      log.warn(
        { userId, itemId: item.itemId, err: err instanceof Error ? err.message : String(err) },
        '/organize reconcile: failed to send item message',
      );
    }
  }

  // If more items than cap, append summary (R8 §1).
  if (totalCount > 20) {
    await ctx.reply(
      `Showing 20 of ${totalCount} total inconsistencies. Run /organize reconcile again after handling these to see more. If ${totalCount} is growing across invocations, something in /organize may be emitting inconsistencies faster than you can resolve.`,
    ).catch(() => {});
  }

  log.info({ userId, itemCount: items.length, totalCount }, '/organize reconcile: listed items');
}

// ---------------------------------------------------------------------------
// Trash TTL constant (mirrors evictExpiredTrash default in storage.ts)
// ---------------------------------------------------------------------------

/** Trash TTL in days — must match the evictExpiredTrash default caller. */
const TRASH_TTL_DAYS = 30;

// ---------------------------------------------------------------------------
// /organize restore <id> handler (v1.14.3 D9)
// ---------------------------------------------------------------------------

async function handleRestoreItem(
  ctx: Context,
  userId: number,
  dataDir: string,
  targetId: string,
  deps: OrganizeCommandDeps,
): Promise<void> {
  try {
    const item = await restoreItem(userId, dataDir, targetId);
    const { title, status } = item.frontMatter;

    // Emit organize.restore audit row on success (one row per successful restore).
    if (deps.memory) {
      try {
        deps.memory.auditLog.insert({
          category: 'organize.restore',
          actor_user_id: userId,
          detail: { itemId: targetId }, // privacy posture: itemId only, no title/notes/progress
        });
      } catch (auditErr) {
        log.warn(
          { userId, targetId, err: auditErr instanceof Error ? auditErr.message : String(auditErr) },
          '/organize restore: audit insert failed (non-blocking)',
        );
      }
    }

    const statusBadge = status !== 'active' ? ` [${status}]` : '';
    await ctx.reply(`Restored: ${title}${statusBadge}`).catch(() => {});
    log.info({ userId, targetId }, '/organize restore: success');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException & { code?: string }).code;

    if (code === 'ITEM_NOT_FOUND_IN_TRASH' || code === 'ITEM_NOT_FOUND') {
      await handleRestoreItemNotFound(ctx, userId, dataDir, targetId, deps);
      return;
    }

    if (code === 'ITEM_ALREADY_LIVE') {
      await ctx.reply(
        `Item \`${targetId}\` exists in both live and trash — possible filesystem inconsistency. ` +
        `If it appears in /organize, no action needed. If not, please report.`,
      ).catch(() => {});
      return;
    }

    const msg = err instanceof Error ? err.message : String(err);
    log.error({ userId, targetId, err: msg }, '/organize restore: restoreItem failed');
    await ctx.reply(`Failed to restore item: ${msg}`).catch(() => {});
  }
}

/**
 * Handle the 404 case for /organize restore.
 * R5: first try closest-id Levenshtein matches in trash.
 * R12: if no close match, query audit log for context (evicted vs bad id).
 */
async function handleRestoreItemNotFound(
  ctx: Context,
  userId: number,
  dataDir: string,
  targetId: string,
  deps: OrganizeCommandDeps,
): Promise<void> {
  // Step 1 (R5): find closest id matches in .trash/
  const matches = await findClosestTrashedIds(userId, dataDir, targetId);

  if (matches.length > 0) {
    const lines = matches.map((m) => `  • \`${m.id}\`  (${m.title})`).join('\n');
    await ctx.reply(
      `Couldn't find \`${targetId}\` in trash. Closest matches:\n${lines}\n` +
      `Try \`/organize restore <id>\` with the correct id.`,
    ).catch(() => {});
    return;
  }

  // Step 2 (R12): query audit log for prior delete record
  if (deps.memory) {
    let deleteRow = null;
    try {
      deleteRow = deps.memory.auditLog.findRecentDelete(userId, targetId);
    } catch (auditErr) {
      log.warn(
        { userId, targetId, err: auditErr instanceof Error ? auditErr.message : String(auditErr) },
        '/organize restore: findRecentDelete failed (non-blocking)',
      );
    }

    if (deleteRow) {
      const deletedDate = deleteRow.ts.slice(0, 10); // YYYY-MM-DD
      const deletedMs = new Date(deleteRow.ts).getTime();
      const ageMs = Date.now() - deletedMs;
      const ageDays = ageMs / (24 * 60 * 60 * 1000);

      if (ageDays > TRASH_TTL_DAYS) {
        await ctx.reply(
          `Item \`${targetId}\` was deleted on ${deletedDate} and the trash was evicted ` +
          `(${TRASH_TTL_DAYS}-day TTL). Cannot restore — hard delete is irreversible.`,
        ).catch(() => {});
      } else {
        await ctx.reply(
          `Item \`${targetId}\` was deleted on ${deletedDate} but should still be in trash. ` +
          `Filesystem may be inconsistent — please report this.`,
        ).catch(() => {});
      }
      return;
    }
  }

  // Step 3: no close match, no audit record — generic bad-id path
  await ctx.reply(
    `Couldn't find any record of \`${targetId}\` in trash. ` +
    `Did you typo the id? Check chat history for the original delete toast.`,
  ).catch(() => {});
}

// ---------------------------------------------------------------------------
// /organize trash list [offset] — v1.14.5 D6/R6
// ---------------------------------------------------------------------------

/** R6 (MEDIUM from CP1 v1.14.5): strict integer-only offset parser. */
const OFFSET_REGEX = /^\d+$/; // digits only — rejects -, ., e, x, NaN, leading/trailing spaces
const TRASH_LIST_MAX_OFFSET = 100000; // sanity cap; well above realistic trash size

function parseTrashListOffset(
  arg: string | undefined,
): { ok: true; offset: number } | { ok: false } {
  if (arg === undefined || arg === '') return { ok: true, offset: 0 };
  if (!OFFSET_REGEX.test(arg)) return { ok: false };
  const parsed = Number.parseInt(arg, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > TRASH_LIST_MAX_OFFSET) {
    return { ok: false };
  }
  return { ok: true, offset: parsed };
}

/** Type-icon prefix per item type (mirrors system-prompt injection icon convention). */
function typeIcon(type: string): string {
  if (type === 'goal') return '⚑';
  if (type === 'event') return '📅';
  return '✓'; // task
}

/** Format millisecond age as a human-readable "N ago" string. */
function formatAgo(isoString: string): string {
  const ms = Date.now() - new Date(isoString).getTime();
  if (Number.isNaN(ms) || ms < 0) return 'unknown';
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

async function handleTrashList(
  ctx: Context,
  userId: number,
  dataDir: string,
  offset: number,
): Promise<void> {
  try {
    const { items, total } = await listTrashedItems(userId, dataDir, { limit: 50, offset });

    if (total === 0) {
      await ctx.reply('Trash is empty.').catch(() => {});
      return;
    }

    if (items.length === 0) {
      // Offset beyond total — no items on this page
      await ctx.reply(`Offset ${offset} is beyond the end of trash (${total} items total). Try a smaller offset.`).catch(() => {});
      return;
    }

    const lines: string[] = [];
    const rangeStart = offset + 1;
    const rangeEnd = offset + items.length;
    lines.push(`**Trash (${total} item${total === 1 ? '' : 's'}, showing ${rangeStart}–${rangeEnd}):**\n`);

    for (const item of items) {
      const ago = item.deletedAt !== '(unknown)' ? formatAgo(item.deletedAt) : 'unknown time';
      const icon = typeIcon(item.type);
      lines.push(`🗑 ${icon} ${item.title} (${item.type}) — deleted ${ago}`);
      lines.push(`   id: \`${item.id}\``);
    }

    // Pagination note if more items exist beyond this page
    if (total > offset + items.length) {
      const nextOffset = offset + items.length;
      lines.push(`\n_Showing ${rangeStart}–${rangeEnd} of ${total}. Use \`/organize trash list ${nextOffset}\` for more._`);
    }

    const markdown = lines.join('\n');
    const html = markdownToTelegramHtml(markdown);
    await ctx.reply(html, { parse_mode: 'HTML' }).catch(() => {});
    log.info({ userId, total, offset, returned: items.length }, '/organize trash list');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ userId, offset, err: msg }, '/organize trash list failed');
    await ctx.reply(`Couldn't list trash: ${msg}`).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Exports for gateway callback handler
// ---------------------------------------------------------------------------

export { handleReconcileCallback };

/** Format a nullable ISO timestamp as a human-readable string. */
function formatLastNudge(isoString: string | null): string {
  if (!isoString) return 'never';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return 'never';
  const agoMs = Date.now() - d.getTime();
  const agoMin = Math.round(agoMs / 60_000);
  if (agoMin < 60) return `${isoString} (${agoMin} min ago)`;
  const agoHr = Math.round(agoMin / 60);
  if (agoHr < 24) return `${isoString} (${agoHr} hour${agoHr === 1 ? '' : 's'} ago)`;
  const agoDays = Math.round(agoHr / 24);
  return `${isoString} (${agoDays} day${agoDays === 1 ? '' : 's'} ago)`;
}

async function handleShowItem(
  ctx: Context,
  userId: number,
  dataDir: string,
  itemId: string,
): Promise<void> {
  try {
    const item = await readItem(userId, dataDir, itemId);
    if (!item) {
      await ctx.reply(`Item not found: \`${itemId}\`. Use /organize to see active items.`, {
        parse_mode: 'HTML',
      }).catch(() => {});
      return;
    }

    const { id, type, status, title, due, created, tags, parentId, calendarEventId } =
      item.frontMatter;

    // Build a human-readable markdown detail block.
    const lines: string[] = [
      `**[${type}]** ${title}`,
      `**id:** \`${id}\``,
      `**status:** ${status}`,
      `**created:** ${created}`,
    ];
    if (due) lines.push(`**due:** ${due}`);
    if (tags.length > 0) lines.push(`**tags:** ${tags.map((t) => `#${t}`).join(' ')}`);
    if (parentId) lines.push(`**parentId:** \`${parentId}\``);
    if (calendarEventId) lines.push(`**calendarEventId:** \`${calendarEventId}\``);

    if (item.notesBody.trim().length > 0) {
      lines.push('');
      lines.push('**Notes:**');
      lines.push(item.notesBody.trim());
    }

    if (item.progressBody.trim().length > 0) {
      lines.push('');
      lines.push('**Progress:**');
      lines.push(item.progressBody.trim());
    }

    const html = markdownToTelegramHtml(lines.join('\n'));
    await ctx.reply(html, { parse_mode: 'HTML' }).catch(() => {});
    log.info({ userId, itemId }, '/organize show item');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ userId, itemId, err: msg }, '/organize show item failed');
    await ctx.reply(`Couldn't load item: ${msg}`).catch(() => {});
  }
}
