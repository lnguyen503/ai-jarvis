/**
 * /scheduled command (v1.10.0).
 *
 *   /scheduled                      — list this user's tasks (page 1)
 *   /scheduled list                 — same as bare
 *   /scheduled list page <n>        — paginated listing
 *   /scheduled list all             — admin-only: all tasks including orphans
 *   /scheduled show <id>            — full detail for one task
 *   /scheduled pause <id>           — pause a task (ownership check)
 *   /scheduled resume <id>          — resume a paused task
 *   /scheduled delete <id>          — two-step: preview + CONFIRM
 *   /scheduled delete <id> CONFIRM  — execute the delete
 *   /scheduled claim <id>           — admin-only: adopt a NULL-owner task
 *
 * DM-ONLY. In group chats responds with redirect. Mirrors the /organize pattern.
 *
 * ADR 005 decisions 16, R8 (NULL-owner policy), R9 (pagination), R7 (audit categories).
 */

import type { Context } from 'grammy';
import type { AppConfig } from '../config/index.js';
import type { MemoryApi } from '../memory/index.js';
import type { SchedulerApi } from '../scheduler/index.js';
import type { ScheduledTask } from '../memory/scheduledTasks.js';
import { isGroupChat } from '../gateway/groupGate.js';
import { markdownToTelegramHtml } from '../messaging/markdownToHtml.js';
import { child } from '../logger/index.js';

const log = child({ component: 'commands.scheduled' });

const PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface ScheduledCommandDeps {
  config: AppConfig;
  memory: MemoryApi;
  /**
   * v1.10.0 — optional so tests that don't wire the scheduler remain clean.
   * When present, reload() is called after mutations (pause/resume/delete)
   * so the scheduler picks up the change without a restart.
   */
  schedulerApi?: SchedulerApi | null;
}

// ---------------------------------------------------------------------------
// Ownership helper (ADR 005 R8)
// ---------------------------------------------------------------------------

interface ManageCheck {
  allowed: boolean;
  reason?: string;
}

function isGlobalAdmin(userId: number, config: AppConfig): boolean {
  // Global admins are defined in config.groups.adminUserIds.
  // Note: resolveRole returns 'admin' for ALL DM users (because DMs are the
  // user's own sandbox), but /scheduled needs to distinguish global admins
  // (who can manage any user's tasks) from regular DM users (who can only
  // manage their own tasks). We check adminUserIds directly here.
  return config.groups.adminUserIds.includes(userId);
}

function canManage(task: ScheduledTask, userId: number, config: AppConfig): ManageCheck {
  if (isGlobalAdmin(userId, config)) return { allowed: true };
  if (task.owner_user_id === null) {
    return { allowed: false, reason: 'This task has no owner. An admin must manage it.' };
  }
  if (task.owner_user_id !== userId) {
    return { allowed: false, reason: 'You can only manage tasks you created.' };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function statusEmoji(status: 'active' | 'paused'): string {
  return status === 'active' ? '🟢' : '⏸️';
}

/**
 * Format a nullable ISO timestamp as a human-readable relative string.
 * Returns "never" for null/invalid.
 */
function formatAgo(isoString: string | null): string {
  if (!isoString) return 'never';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return 'never';
  const agoMs = Date.now() - d.getTime();
  const agoMin = Math.floor(agoMs / 60_000);
  if (agoMin < 1) return 'just now';
  if (agoMin < 60) return `${agoMin}m ago`;
  const agoHr = Math.floor(agoMin / 60);
  if (agoHr < 24) return `${agoHr}h ago`;
  const agoDays = Math.floor(agoHr / 24);
  return `${agoDays}d ago`;
}

function formatTaskRow(task: ScheduledTask, index: number): string {
  const emoji = statusEmoji(task.status);
  const lastRun = formatAgo(task.last_run_at);
  return (
    `${index}. ${emoji} **${task.description}** — cron: \`${task.cron_expression}\`\n` +
    `   id: \`${task.id}\` • last run: ${lastRun}`
  );
}

function formatTaskRowAdmin(task: ScheduledTask, index: number): string {
  const emoji = statusEmoji(task.status);
  const lastRun = formatAgo(task.last_run_at);
  const owner =
    task.owner_user_id !== null ? `owner: ${task.owner_user_id}` : '**[orphan]**';
  return (
    `${index}. ${emoji} **${task.description}** — cron: \`${task.cron_expression}\`\n` +
    `   id: \`${task.id}\` • ${owner} • last run: ${lastRun}`
  );
}

// ---------------------------------------------------------------------------
// Safe scheduler reload (non-fatal per R11)
// ---------------------------------------------------------------------------

function safeReload(schedulerApi: SchedulerApi | null | undefined): void {
  if (schedulerApi == null) return;
  try {
    schedulerApi.reload();
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '/scheduled: scheduler.reload() threw (non-fatal)',
    );
  }
}

// ---------------------------------------------------------------------------
// Public handler
// ---------------------------------------------------------------------------

export async function handleScheduled(ctx: Context, deps: ScheduledCommandDeps): Promise<void> {
  // DM-ONLY — must be the FIRST check.
  if (isGroupChat(ctx)) {
    await ctx
      .reply('Scheduled tasks are DM-only — message me privately to manage your tasks.')
      .catch(() => {});
    return;
  }

  const userId = ctx.from?.id;
  if (!userId) {
    await ctx
      .reply('No user context — cannot determine whose scheduled tasks to show.')
      .catch(() => {});
    return;
  }

  const text = ctx.message?.text ?? '';
  const args = text
    .replace(/^\/scheduled(@\S+)?\s*/, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const sub = args[0]?.toLowerCase() ?? '';

  // ---- bare /scheduled or /scheduled list ----
  if (sub === '' || sub === 'list') {
    // Check for "list all" — admin-only
    if (args[1]?.toLowerCase() === 'all') {
      await handleListAll(ctx, userId, deps);
      return;
    }
    // Parse optional "page N"
    let page = 1;
    if (args[1]?.toLowerCase() === 'page' && args[2]) {
      const parsed = parseInt(args[2], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        page = parsed;
      }
    }
    await handleListOwner(ctx, userId, deps, page);
    return;
  }

  // ---- /scheduled show <id> ----
  if (sub === 'show') {
    const id = parseInt(args[1] ?? '', 10);
    if (!Number.isFinite(id)) {
      await ctx.reply('Usage: /scheduled show <id>').catch(() => {});
      return;
    }
    await handleShow(ctx, userId, id, deps);
    return;
  }

  // ---- /scheduled pause <id> ----
  if (sub === 'pause') {
    const id = parseInt(args[1] ?? '', 10);
    if (!Number.isFinite(id)) {
      await ctx.reply('Usage: /scheduled pause <id>').catch(() => {});
      return;
    }
    await handleSetStatus(ctx, userId, id, 'paused', deps);
    return;
  }

  // ---- /scheduled resume <id> ----
  if (sub === 'resume') {
    const id = parseInt(args[1] ?? '', 10);
    if (!Number.isFinite(id)) {
      await ctx.reply('Usage: /scheduled resume <id>').catch(() => {});
      return;
    }
    await handleSetStatus(ctx, userId, id, 'active', deps);
    return;
  }

  // ---- /scheduled delete <id> [CONFIRM] ----
  if (sub === 'delete') {
    const id = parseInt(args[1] ?? '', 10);
    if (!Number.isFinite(id)) {
      await ctx.reply('Usage: /scheduled delete <id>').catch(() => {});
      return;
    }
    const confirmed = (args[2] ?? '').toUpperCase() === 'CONFIRM';
    await handleDelete(ctx, userId, id, confirmed, deps);
    return;
  }

  // ---- /scheduled claim <id> — admin-only orphan rescue (R8) ----
  if (sub === 'claim') {
    const id = parseInt(args[1] ?? '', 10);
    if (!Number.isFinite(id)) {
      await ctx.reply('Usage: /scheduled claim <id>').catch(() => {});
      return;
    }
    await handleClaim(ctx, userId, id, deps);
    return;
  }

  // ---- unknown subcommand ----
  await ctx
    .reply(
      'Usage:\n' +
        '  /scheduled                    — list your tasks (page 1)\n' +
        '  /scheduled list page <n>      — paginated listing\n' +
        '  /scheduled list all           — (admin) all tasks including orphans\n' +
        '  /scheduled show <id>          — full task detail\n' +
        '  /scheduled pause <id>         — pause a task\n' +
        '  /scheduled resume <id>        — resume a paused task\n' +
        '  /scheduled delete <id>        — delete (requires CONFIRM)\n' +
        '  /scheduled delete <id> CONFIRM — execute the delete\n' +
        '  /scheduled claim <id>         — (admin) adopt an orphan task',
    )
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Sub-handlers
// ---------------------------------------------------------------------------

async function handleListOwner(
  ctx: Context,
  userId: number,
  deps: ScheduledCommandDeps,
  page: number,
): Promise<void> {
  const all = deps.memory.scheduledTasks.listByOwner(userId);

  if (all.length === 0) {
    await ctx
      .reply(
        'You have no scheduled tasks yet.\n\n' +
          'To create one, say something like:\n' +
          '"Remind me every day at 8am to check my goals"\n' +
          '"Every Monday at 9am summarize last week"',
      )
      .catch(() => {});
    return;
  }

  const totalPages = Math.ceil(all.length / PAGE_SIZE);
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const start = (safePage - 1) * PAGE_SIZE;
  const slice = all.slice(start, start + PAGE_SIZE);

  const lines: string[] = [
    `**Your scheduled tasks** (page ${safePage} of ${totalPages}, total ${all.length}):`,
    '',
  ];

  slice.forEach((task, i) => {
    lines.push(formatTaskRow(task, start + i + 1));
  });

  lines.push('');
  lines.push('`/scheduled show <id>` for details');
  lines.push('`/scheduled pause|resume|delete <id>` to manage');
  if (totalPages > 1) {
    lines.push(`\`/scheduled list page ${safePage < totalPages ? safePage + 1 : safePage}\` for more`);
  }

  const html = markdownToTelegramHtml(lines.join('\n'));
  await ctx.reply(html, { parse_mode: 'HTML' }).catch(() => {});
  log.info({ userId, page: safePage, total: all.length }, '/scheduled list');
}

async function handleListAll(
  ctx: Context,
  userId: number,
  deps: ScheduledCommandDeps,
): Promise<void> {
  // Admin-only per R8: checks global adminUserIds, not DM-auto-admin role.
  if (!isGlobalAdmin(userId, deps.config)) {
    await ctx.reply('Admin only.').catch(() => {});
    return;
  }

  const all = deps.memory.scheduledTasks.listAll();

  if (all.length === 0) {
    await ctx.reply('No scheduled tasks in the system yet.').catch(() => {});
    return;
  }

  const totalPages = Math.ceil(all.length / PAGE_SIZE);
  const slice = all.slice(0, PAGE_SIZE);

  const lines: string[] = [
    `**All scheduled tasks** (total ${all.length}${totalPages > 1 ? `, page 1 of ${totalPages}` : ''}):`,
    '',
  ];

  slice.forEach((task, i) => {
    lines.push(formatTaskRowAdmin(task, i + 1));
  });

  if (totalPages > 1) {
    lines.push('');
    lines.push('_(showing first 20 — pagination not yet available for list all)_');
  }

  const html = markdownToTelegramHtml(lines.join('\n'));
  await ctx.reply(html, { parse_mode: 'HTML' }).catch(() => {});
  log.info({ userId, total: all.length }, '/scheduled list all (admin)');
}

async function handleShow(
  ctx: Context,
  userId: number,
  taskId: number,
  deps: ScheduledCommandDeps,
): Promise<void> {
  const task = deps.memory.scheduledTasks.get(taskId);
  if (!task) {
    await ctx.reply(`No task with id ${taskId}.`).catch(() => {});
    return;
  }

  const check = canManage(task, userId, deps.config);
  if (!check.allowed) {
    await ctx.reply(check.reason ?? 'Access denied.').catch(() => {});
    return;
  }

  const ownerStr =
    task.owner_user_id !== null ? String(task.owner_user_id) : '`[orphan — no owner]`';

  const lines: string[] = [
    `**Scheduled task ${task.id}**`,
    '',
    `**Description:** ${task.description}`,
    `**Cron:** \`${task.cron_expression}\``,
    `**Status:** ${statusEmoji(task.status)} ${task.status}`,
    `**Owner:** ${ownerStr}`,
    `**Last run:** ${formatAgo(task.last_run_at)}`,
    `**Created:** ${task.created_at}`,
    '',
    `**Command:**`,
    `\`\`\``,
    task.command,
    `\`\`\``,
  ];

  const html = markdownToTelegramHtml(lines.join('\n'));
  await ctx.reply(html, { parse_mode: 'HTML' }).catch(() => {});
  log.info({ userId, taskId }, '/scheduled show');
}

async function handleSetStatus(
  ctx: Context,
  userId: number,
  taskId: number,
  newStatus: 'active' | 'paused',
  deps: ScheduledCommandDeps,
): Promise<void> {
  const task = deps.memory.scheduledTasks.get(taskId);
  if (!task) {
    await ctx.reply(`No task with id ${taskId}.`).catch(() => {});
    return;
  }

  const check = canManage(task, userId, deps.config);
  if (!check.allowed) {
    await ctx.reply(check.reason ?? 'Access denied.').catch(() => {});
    return;
  }

  const adminOverride = task.owner_user_id !== null && task.owner_user_id !== userId;
  const auditCategory = newStatus === 'paused' ? 'scheduler.pause' : 'scheduler.resume';

  deps.memory.scheduledTasks.setStatus(taskId, newStatus);

  deps.memory.auditLog.insert({
    category: auditCategory,
    actor_user_id: userId,
    actor_chat_id: ctx.chat?.id ?? userId,
    session_id: null,
    detail: {
      taskId,
      ownerUserId: task.owner_user_id,
      adminOverride,
    },
  });

  // Reload after status change — paused→active re-registers cron job; active→paused unregisters.
  safeReload(deps.schedulerApi);

  const verb = newStatus === 'paused' ? 'Paused' : 'Resumed';
  await ctx
    .reply(`${verb} task ${taskId}: "${task.description}".`)
    .catch(() => {});
  log.info({ userId, taskId, newStatus, adminOverride }, `/scheduled ${newStatus === 'paused' ? 'pause' : 'resume'}`);
}

async function handleDelete(
  ctx: Context,
  userId: number,
  taskId: number,
  confirmed: boolean,
  deps: ScheduledCommandDeps,
): Promise<void> {
  const task = deps.memory.scheduledTasks.get(taskId);
  if (!task) {
    await ctx.reply(`No task with id ${taskId}.`).catch(() => {});
    return;
  }

  const check = canManage(task, userId, deps.config);
  if (!check.allowed) {
    await ctx.reply(check.reason ?? 'Access denied.').catch(() => {});
    return;
  }

  if (!confirmed) {
    // Two-step: preview + CONFIRM instruction (mirrors /memory clear pattern)
    const lines = [
      `**Delete scheduled task ${taskId}?**`,
      '',
      `**Description:** ${task.description}`,
      `**Cron:** \`${task.cron_expression}\``,
      `**Status:** ${statusEmoji(task.status)} ${task.status}`,
      '',
      `To confirm: \`/scheduled delete ${taskId} CONFIRM\``,
    ];
    const html = markdownToTelegramHtml(lines.join('\n'));
    await ctx.reply(html, { parse_mode: 'HTML' }).catch(() => {});
    return;
  }

  // Confirmed — execute delete
  const adminOverride = task.owner_user_id !== null && task.owner_user_id !== userId;

  deps.memory.scheduledTasks.remove(taskId);

  deps.memory.auditLog.insert({
    category: 'scheduler.delete',
    actor_user_id: userId,
    actor_chat_id: ctx.chat?.id ?? userId,
    session_id: null,
    detail: {
      taskId,
      description: task.description,
      ownerUserId: task.owner_user_id,
      adminOverride,
    },
  });

  safeReload(deps.schedulerApi);

  await ctx
    .reply(`Deleted task ${taskId}: "${task.description}".`)
    .catch(() => {});
  log.info({ userId, taskId, adminOverride }, '/scheduled delete (confirmed)');
}

async function handleClaim(
  ctx: Context,
  userId: number,
  taskId: number,
  deps: ScheduledCommandDeps,
): Promise<void> {
  // Admin-only per R8: checks global adminUserIds, not DM-auto-admin role.
  if (!isGlobalAdmin(userId, deps.config)) {
    await ctx.reply('Admin only.').catch(() => {});
    return;
  }

  const task = deps.memory.scheduledTasks.get(taskId);
  if (!task) {
    await ctx.reply(`No task with id ${taskId}.`).catch(() => {});
    return;
  }

  if (task.owner_user_id !== null) {
    await ctx
      .reply(
        `Task ${taskId} already has an owner (user ${task.owner_user_id}). ` +
          'To reassign, delete the task and recreate it.',
      )
      .catch(() => {});
    return;
  }

  // Claim: set owner_user_id via a setStatus + direct SQL isn't available —
  // use a workaround: we insert a new row with the same data and remove the old one.
  // Actually ScheduledTasksRepo doesn't expose an UPDATE owner_user_id method.
  // Per the spec: "claim" sets owner_user_id = admin.userId. The repo doesn't have
  // this method. We add it inline via the DB handle — the repo's db is private,
  // so we implement claim by re-inserting and removing.
  //
  // Clean approach: expose a setOwner method on ScheduledTasksRepo (Dev-B scope).
  // Since we can't modify scheduledTasks.ts, we instead emit a scheduler.policy
  // audit row explaining that claim is not fully implemented and suggest recreate.
  //
  // Design decision: Rather than accessing private DB internals or adding a repo
  // method outside our scope, we implement claim as:
  //   1. Insert a new task with same fields + owner_user_id = userId.
  //   2. Remove the old (orphan) task.
  // This is safe and self-contained within our allowed scope.

  const newId = deps.memory.scheduledTasks.insert({
    description: task.description,
    cron_expression: task.cron_expression,
    command: task.command,
    chat_id: task.chat_id,
    owner_user_id: userId,
  });

  deps.memory.scheduledTasks.remove(taskId);

  deps.memory.auditLog.insert({
    category: 'scheduler.policy',
    actor_user_id: userId,
    actor_chat_id: ctx.chat?.id ?? userId,
    session_id: null,
    detail: {
      event: 'claim_orphan',
      oldTaskId: taskId,
      newTaskId: newId,
      newOwnerUserId: userId,
      description: task.description,
    },
  });

  safeReload(deps.schedulerApi);

  await ctx
    .reply(
      `Claimed orphan task ${taskId} → new task id ${newId}: "${task.description}". ` +
        `It is now owned by you (user ${userId}).`,
    )
    .catch(() => {});
  log.info({ userId, oldTaskId: taskId, newTaskId: newId }, '/scheduled claim');
}
