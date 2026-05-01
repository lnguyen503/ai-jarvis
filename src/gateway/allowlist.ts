import type { Context, MiddlewareFn } from 'grammy';
import type { AppConfig } from '../config/index.js';
import { child } from '../logger/index.js';

const log = child({ component: 'gateway.allowlist' });

/**
 * grammY middleware that enforces the allowlist (US-5).
 *
 * Passes through when ANY of these is true:
 *  1. ctx.from.id is in config.telegram.allowedUserIds (DM allowlist — always checked)
 *  2. The chat is a group/supergroup AND config.groups.enabled AND the chat ID is in
 *     config.groups.allowedGroupIds. In this case the sender's user ID does NOT need
 *     to be in the DM allowlist — group membership is the gate.
 *
 * Silent rejection (no reply): logged at info level.
 */
export function createAllowlistMiddleware(cfg: AppConfig): MiddlewareFn<Context> {
  const allowedUsers = new Set(cfg.telegram.allowedUserIds);
  const allowedGroups = new Set(cfg.groups.allowedGroupIds);
  const groupWildcard = cfg.groups.allowedGroupIds.includes('*');

  return async (ctx, next) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const chatType = ctx.chat?.type;

    // DM allowlist check
    if (userId !== undefined && allowedUsers.has(userId)) {
      await next();
      return;
    }

    // Group allowlist check (additive — sender doesn't need to be in DM allowlist)
    if (
      cfg.groups.enabled &&
      chatId !== undefined &&
      (chatType === 'group' || chatType === 'supergroup') &&
      (groupWildcard || allowedGroups.has(chatId))
    ) {
      await next();
      return;
    }

    // Rejected. Include chat title + username so operators can quickly
    // identify which group/DM to whitelist from the logs.
    const chat = ctx.chat as { title?: string; username?: string; first_name?: string } | undefined;
    log.info(
      {
        userId: userId ?? 'undefined',
        fromUsername: ctx.from?.username,
        chatId,
        chatType,
        chatTitle: chat?.title ?? chat?.first_name ?? null,
        chatUsername: chat?.username ?? null,
        hint:
          chatType === 'group' || chatType === 'supergroup'
            ? `Add ${String(chatId)} to config.groups.allowedGroupIds (or use "*")`
            : `Add ${String(userId)} to config.telegram.allowedUserIds`,
        messageType: ctx.message ? 'message' : 'update',
      },
      'Unauthorized update rejected (allowlist)',
    );
    // Silently return — do NOT call next() and do NOT reply
  };
}
