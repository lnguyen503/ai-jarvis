/**
 * Group admin commands (v1.3).
 *
 * /jarvis-enable   — enable Jarvis in THIS group (persisted to DB)
 * /jarvis-disable  — disable Jarvis in THIS group
 * /jarvis-users    — show per-user stats for this group
 * /jarvis-limit <user_id> <number> — set per-user rate limit override (0 = default)
 *
 * All commands:
 *  - Only work in group/supergroup chats
 *  - Only available to adminUserIds from config
 *  - In DM, admin commands work only for the admin (and only /enable /disable make sense in DM context — but per spec they're group commands)
 */

import type { Context } from 'grammy';
import type { AppConfig } from '../config/index.js';
import type { GroupActivityRepo } from '../memory/groupActivity.js';
import type { GroupSettingsRepo } from '../memory/groupSettings.js';
import type { AuditLogRepo } from '../memory/auditLog.js';
import { child } from '../logger/index.js';

const log = child({ component: 'commands.groupAdmin' });

export interface GroupAdminDeps {
  config: AppConfig;
  groupActivity: GroupActivityRepo;
  groupSettings: GroupSettingsRepo;
  auditLog?: AuditLogRepo;
}

function isAdmin(userId: number | undefined, config: AppConfig): boolean {
  if (userId === undefined) return false;
  return config.groups.adminUserIds.includes(userId);
}

function isGroupCtx(ctx: Context): boolean {
  const type = ctx.chat?.type;
  return type === 'group' || type === 'supergroup';
}

export async function handleJarvisEnable(ctx: Context, deps: GroupAdminDeps): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!isAdmin(userId, deps.config)) {
    await ctx.reply('Admin only.').catch(() => {});
    return;
  }

  if (!isGroupCtx(ctx) || chatId === undefined) {
    await ctx.reply('This command only works in a group chat.').catch(() => {});
    return;
  }

  deps.groupSettings.setEnabled(chatId, true);
  log.info({ chatId, userId }, 'Group enabled via /jarvis-enable');
  deps.auditLog?.insert({ category: 'admin_command', actor_user_id: userId, actor_chat_id: chatId, detail: { command: 'jarvis_enable', chatId } });
  await ctx.reply('Jarvis enabled in this group.').catch(() => {});
}

export async function handleJarvisDisable(ctx: Context, deps: GroupAdminDeps): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!isAdmin(userId, deps.config)) {
    await ctx.reply('Admin only.').catch(() => {});
    return;
  }

  if (!isGroupCtx(ctx) || chatId === undefined) {
    await ctx.reply('This command only works in a group chat.').catch(() => {});
    return;
  }

  deps.groupSettings.setEnabled(chatId, false);
  log.info({ chatId, userId }, 'Group disabled via /jarvis-disable');
  deps.auditLog?.insert({ category: 'admin_command', actor_user_id: userId, actor_chat_id: chatId, detail: { command: 'jarvis_disable', chatId } });
  await ctx.reply('Jarvis disabled in this group.').catch(() => {});
}

export async function handleJarvisUsers(ctx: Context, deps: GroupAdminDeps): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!isAdmin(userId, deps.config)) {
    await ctx.reply('Admin only.').catch(() => {});
    return;
  }

  if (!isGroupCtx(ctx) || chatId === undefined) {
    await ctx.reply('This command only works in a group chat.').catch(() => {});
    return;
  }

  const rows = deps.groupActivity.listForGroup(chatId);
  if (rows.length === 0) {
    await ctx.reply('No user activity in this group yet.').catch(() => {});
    return;
  }

  const lines = rows.map((r) => {
    const name = r.username ?? `user:${r.user_id}`;
    return (
      `• ${name} — ${r.message_count} msgs, ` +
      `in:${r.input_tokens} out:${r.output_tokens} tokens, ` +
      `last: ${r.last_active_at.slice(0, 16)}`
    );
  });

  await ctx.reply(`<b>Group users:</b>\n${lines.join('\n')}`, { parse_mode: 'HTML' }).catch(
    async () => {
      await ctx.reply(`Group users:\n${lines.join('\n')}`);
    },
  );
}

export async function handleJarvisLimit(ctx: Context, deps: GroupAdminDeps): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!isAdmin(userId, deps.config)) {
    await ctx.reply('Admin only.').catch(() => {});
    return;
  }

  if (!isGroupCtx(ctx) || chatId === undefined) {
    await ctx.reply('This command only works in a group chat.').catch(() => {});
    return;
  }

  // Parse args: /jarvis-limit <user_id> <number>
  const text = ctx.message?.text ?? '';
  const parts = text.trim().split(/\s+/);
  if (parts.length < 3) {
    await ctx.reply('Usage: /jarvis-limit <user_id> <limit> (0 = use default)').catch(() => {});
    return;
  }

  const targetUserId = parseInt(parts[1] ?? '', 10);
  const limitValue = parseInt(parts[2] ?? '', 10);

  if (isNaN(targetUserId) || isNaN(limitValue) || limitValue < 0) {
    await ctx.reply('Invalid arguments. Usage: /jarvis-limit <user_id> <limit>').catch(() => {});
    return;
  }

  deps.groupActivity.setRateLimitOverride(chatId, targetUserId, limitValue);
  log.info({ chatId, userId, targetUserId, limitValue }, 'Rate limit override set');

  const msg =
    limitValue === 0
      ? `Rate limit override cleared for user ${targetUserId} (will use default).`
      : `Rate limit for user ${targetUserId} set to ${limitValue} per window.`;

  await ctx.reply(msg).catch(() => {});
}
