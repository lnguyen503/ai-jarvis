/**
 * Role resolution for Telegram chat sessions (v1.7.5).
 *
 * Three roles:
 *   - admin     : full access (all tools, all admin commands, role management).
 *                 Defined by config.groups.adminUserIds.
 *   - developer : full tool access in group chats (run_command, write_file,
 *                 etc.) but bound by the existing write deny-globs — cannot
 *                 touch config/**, src/**, or other role definitions.
 *                 Defined by config.groups.developerUserIds.
 *   - member    : the default for everyone else in an allowed group. Text
 *                 + read-only tools; no run_command, write_file, system_info.
 *
 * DMs are always treated as admin role (the user's own DM is their personal
 * sandbox and they are on the allowedUserIds list).
 */

import type { AppConfig } from '../config/index.js';

export type Role = 'admin' | 'developer' | 'member';

export interface ChatContext {
  /** Telegram chat ID. Positive for DMs, negative for groups. */
  chatId: number;
  /** Telegram user ID of the message sender. */
  userId: number | undefined;
  /** 'private' = DM, 'group'/'supergroup' = group chat. */
  chatType: 'private' | 'group' | 'supergroup' | 'channel' | undefined;
}

/**
 * Resolve the role for a message sender.
 *
 * DMs always return 'admin' (the DM owner has full control of their own session).
 *
 * In groups, resolution order (first match wins):
 *   1. User in `groups.adminUserIds` (global)            -> admin
 *   2. User in `groupRoles[chatId].admins` (per-group)    -> admin
 *   3. User in `groupRoles[chatId].developers` (per-group) -> developer
 *   4. User in `groups.developerUserIds` (legacy global)  -> developer
 *   5. Otherwise                                          -> member
 *
 * This lets a user be a developer in one group but a member in another,
 * which is the v1.7.6 per-group-customization requirement.
 */
export function resolveRole(ctx: ChatContext, config: AppConfig): Role {
  if (ctx.chatType === 'private') return 'admin';
  if (ctx.userId === undefined) return 'member';

  // 1. Global admin wins everywhere
  if (config.groups.adminUserIds.includes(ctx.userId)) return 'admin';

  // 2 + 3. Per-group overrides (keyed by chatId-as-string for JSON compat)
  const perGroup = config.groups.groupRoles?.[String(ctx.chatId)];
  if (perGroup) {
    if (perGroup.admins?.includes(ctx.userId)) return 'admin';
    if (perGroup.developers?.includes(ctx.userId)) return 'developer';
  }

  // 4. Legacy global developer list
  if (config.groups.developerUserIds.includes(ctx.userId)) return 'developer';

  // 5. Default
  return 'member';
}

/**
 * Tools that are blocked for members in group mode. Admins and developers
 * bypass this filter; members never see these tools. Kept in sync with
 * config.groups.disabledTools historically.
 */
export const MEMBER_BLOCKED_TOOLS = new Set([
  'run_command',
  'write_file',
  'system_info',
]);

/**
 * Given a role, return the set of tool names that should be HIDDEN from
 * that role at dispatch time. Empty set = full access.
 */
export function blockedToolsForRole(role: Role): Set<string> {
  switch (role) {
    case 'admin':
    case 'developer':
      return new Set();
    case 'member':
      return MEMBER_BLOCKED_TOOLS;
  }
}
