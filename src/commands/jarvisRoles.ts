/**
 * Per-group role management (v1.7.6).
 *
 * Commands (admin-only):
 *   /jarvis_roles                     — show roles for THIS chat
 *   /jarvis_roles <chatId>            — show roles for a specific chat (DM use)
 *   /jarvis_dev_add <userId>          — add developer to THIS chat
 *   /jarvis_dev_add <userId> <chatId> — add developer to a specific chat (DM)
 *   /jarvis_dev_remove <userId>       — remove developer from THIS chat
 *   /jarvis_admin_add <userId>        — add per-group admin to THIS chat
 *   /jarvis_admin_remove <userId>     — remove per-group admin
 *
 * All role-mutating commands write to `config/config.json` on disk. Restart
 * required — every change leaves a git-reviewable diff.
 */

import fs from 'fs';
import path from 'path';
import type { Context } from 'grammy';
import type { AppConfig } from '../config/index.js';
import type { MemoryApi } from '../memory/index.js';
import { child } from '../logger/index.js';

const log = child({ component: 'commands.jarvisRoles' });

export interface JarvisRolesDeps {
  config: AppConfig;
  configPath: string;
  memory: MemoryApi;
}

// ---------------------------------------------------------------------------
// v1.7.7 — user-reference resolver
// ---------------------------------------------------------------------------

type UserRefSource = 'id' | 'username' | 'alias' | 'reply';

interface UserRefOk {
  ok: true;
  userId: number;
  source: UserRefSource;
  displayHint: string; // human-readable note for reply messages
}
interface UserRefErr {
  ok: false;
  error: string;
}

/**
 * Resolve a user argument into a numeric Telegram ID.
 * Accepts (in order of precedence):
 *   1. Numeric ID  (e.g. "99999999")
 *   2. @username   (e.g. "@kimhandle") — looks up recent group activity
 *   3. Alias name  (e.g. "kim")        — looks up config.aliases
 *   4. (no arg)    — falls back to reply_to_message.from.id, if any
 *
 * `chatScopeId` is passed when resolving @usernames so we prefer the current
 * group's activity table; falls back to any-group search.
 */
export function resolveUserRef(
  arg: string | undefined,
  ctx: Context,
  deps: JarvisRolesDeps,
  chatScopeId: number | null,
): UserRefOk | UserRefErr {
  // (4) Fall back to reply-to when no arg given
  if (!arg) {
    const reply = ctx.message?.reply_to_message;
    if (reply && typeof reply.from?.id === 'number') {
      return {
        ok: true,
        userId: reply.from.id,
        source: 'reply',
        displayHint: reply.from.username
          ? `@${reply.from.username}`
          : (reply.from.first_name ?? String(reply.from.id)),
      };
    }
    return { ok: false, error: 'No user specified. Provide a userId, @username, alias, or reply to their message.' };
  }

  // (1) Numeric ID
  if (/^\d+$/.test(arg)) {
    const n = parseInt(arg, 10);
    if (Number.isFinite(n) && n > 0) {
      return { ok: true, userId: n, source: 'id', displayHint: String(n) };
    }
  }

  // (2) @username
  if (arg.startsWith('@')) {
    const uname = arg.slice(1);
    const row =
      (chatScopeId !== null
        ? deps.memory.groupActivity.findByUsernameInGroup(chatScopeId, uname)
        : null) ?? deps.memory.groupActivity.findByUsernameAnyGroup(uname);
    if (row) {
      return {
        ok: true,
        userId: row.user_id,
        source: 'username',
        displayHint: `@${uname}`,
      };
    }
    return {
      ok: false,
      error: `No user with @${uname} found in recent activity. They must have sent at least one message in a group first, or you can add them by numeric ID.`,
    };
  }

  // (3) Alias
  const aliases = deps.config.aliases ?? {};
  const aliasKey = Object.keys(aliases).find((k) => k.toLowerCase() === arg.toLowerCase());
  if (aliasKey) {
    return {
      ok: true,
      userId: aliases[aliasKey]!,
      source: 'alias',
      displayHint: aliasKey,
    };
  }

  return {
    ok: false,
    error: `Could not resolve "${arg}". Expected a numeric user ID, @username, or alias from /jarvis_alias_list.`,
  };
}

/** Is the sender a GLOBAL admin? Only globals can manage roles. */
function requireGlobalAdmin(ctx: Context, config: AppConfig): boolean {
  const userId = ctx.from?.id;
  if (userId !== undefined && config.groups.adminUserIds.includes(userId)) {
    return true;
  }
  void ctx.reply('This command is admin-only.').catch(() => {});
  return false;
}


/** Parse any integer (allows negative for chat IDs). */
function parseInt64(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Figure out which chat the command is targeting.
 * Priority: explicit `<chatId>` argument > the current chat ID.
 * Returns null if we can't determine (should never happen in practice).
 */
function targetChatId(ctx: Context, explicitArg: string | undefined): number | null {
  if (explicitArg) {
    const fromArg = parseInt64(explicitArg);
    if (fromArg !== null) return fromArg;
  }
  return ctx.chat?.id ?? null;
}

/** Shape of the on-disk groupRoles map after a round-trip through JSON. */
interface GroupRolesMap {
  [chatIdStr: string]: { admins?: number[]; developers?: number[] } | undefined;
}

/** Read, transform, and write config.json. Returns the updated entry. */
function mutateGroupRoles(
  configPath: string,
  chatId: number,
  transform: (entry: { admins: number[]; developers: number[] }) => {
    admins: number[];
    developers: number[];
  },
): { admins: number[]; developers: number[] } {
  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const groups = (parsed['groups'] as Record<string, unknown> | undefined) ?? {};
  const groupRoles = ((groups['groupRoles'] as GroupRolesMap | undefined) ?? {}) as GroupRolesMap;

  const key = String(chatId);
  const current = groupRoles[key] ?? {};
  const currentFilled = {
    admins: current.admins ? [...current.admins] : [],
    developers: current.developers ? [...current.developers] : [],
  };
  const next = transform(currentFilled);
  // Deduplicate
  next.admins = Array.from(new Set(next.admins));
  next.developers = Array.from(new Set(next.developers));

  // Drop the entry entirely if both arrays end up empty (keeps config tidy).
  if (next.admins.length === 0 && next.developers.length === 0) {
    delete groupRoles[key];
  } else {
    groupRoles[key] = next;
  }

  const nextGroups = { ...groups, groupRoles };
  const nextConfig = { ...parsed, groups: nextGroups };
  fs.writeFileSync(configPath, JSON.stringify(nextConfig, null, 2) + '\n');
  return next;
}

// ---------------------------------------------------------------------------
// /jarvis_roles — show current mapping for a chat
// ---------------------------------------------------------------------------

export async function handleJarvisRoles(ctx: Context, deps: JarvisRolesDeps): Promise<void> {
  if (!requireGlobalAdmin(ctx, deps.config)) return;

  const parts = (ctx.message?.text ?? '').trim().split(/\s+/);
  const chatId = targetChatId(ctx, parts[1]);
  if (chatId === null) {
    await ctx.reply('Could not resolve a target chat ID.').catch(() => {});
    return;
  }

  const globalAdmins = deps.config.groups.adminUserIds;
  const legacyDevs = deps.config.groups.developerUserIds;
  const perGroup = deps.config.groups.groupRoles?.[String(chatId)] ?? {};
  const perGroupAdmins = perGroup.admins ?? [];
  const perGroupDevs = perGroup.developers ?? [];

  const fmt = (ids: readonly number[]) =>
    ids.length ? ids.map((id) => `  • <code>${id}</code>`).join('\n') : '  (none)';

  const msg =
    `<b>Role map for chat <code>${chatId}</code></b>\n\n` +
    `<b>Global admins</b> (full access everywhere):\n${fmt(globalAdmins)}\n\n` +
    `<b>Per-group admins</b> (admin only in this chat):\n${fmt(perGroupAdmins)}\n\n` +
    `<b>Per-group developers</b> (dev only in this chat):\n${fmt(perGroupDevs)}\n\n` +
    `<b>Legacy global developers</b> (dev everywhere — deprecated):\n${fmt(legacyDevs)}\n\n` +
    `Everyone else in this chat is a <b>member</b> (text + read-only tools).\n\n` +
    `Manage:\n` +
    `<code>/jarvis_dev_add &lt;userId&gt; [chatId]</code>\n` +
    `<code>/jarvis_dev_remove &lt;userId&gt; [chatId]</code>\n` +
    `<code>/jarvis_admin_add &lt;userId&gt; [chatId]</code>\n` +
    `<code>/jarvis_admin_remove &lt;userId&gt; [chatId]</code>\n` +
    `Omit chatId in a group to manage that group; include chatId from DM.`;
  await ctx.reply(msg, { parse_mode: 'HTML' }).catch(() => {});
}

// ---------------------------------------------------------------------------
// /jarvis_dev_add, /jarvis_dev_remove — per-chat developer management
// ---------------------------------------------------------------------------

async function roleMutation(
  ctx: Context,
  deps: JarvisRolesDeps,
  kind: 'admins' | 'developers',
  op: 'add' | 'remove',
): Promise<void> {
  if (!requireGlobalAdmin(ctx, deps.config)) return;

  const parts = (ctx.message?.text ?? '').trim().split(/\s+/);
  // Argument parsing: the user-ref can be in parts[1], followed by an
  // optional chat ID in parts[2]. When the user references by reply,
  // both parts may be missing.
  const userArg = parts[1];
  const chatArg = parts[2];
  const chatId = targetChatId(ctx, chatArg);
  if (chatId === null) {
    await ctx.reply('Could not resolve a target chat ID.').catch(() => {});
    return;
  }
  const ref = resolveUserRef(userArg, ctx, deps, chatId);
  if (!ref.ok) {
    await ctx.reply(ref.error).catch(() => {});
    return;
  }

  const updated = mutateGroupRoles(deps.configPath, chatId, (entry) => {
    const list = entry[kind];
    if (op === 'add') {
      return { ...entry, [kind]: [...list, ref.userId] };
    }
    return { ...entry, [kind]: list.filter((id) => id !== ref.userId) };
  });

  log.info(
    { chatId, userId: ref.userId, source: ref.source, kind, op, result: updated },
    'Per-group role updated',
  );
  const kindLabel = kind === 'admins' ? 'admin' : 'developer';
  const action = op === 'add' ? 'Added' : 'Removed';
  const list = updated[kind];
  const listStr = list.length ? list.map((id) => `<code>${id}</code>`).join(', ') : '(none)';
  const resolvedNote = ref.source === 'id' ? '' : ` (resolved ${ref.displayHint})`;

  await ctx
    .reply(
      `${action} <code>${ref.userId}</code>${resolvedNote} ${op === 'add' ? 'to' : 'from'} ${kindLabel}s of chat <code>${chatId}</code>.\n` +
        `Current ${kindLabel}s: ${listStr}\n\n` +
        `⚠️ Restart Jarvis for the change to take effect.`,
      { parse_mode: 'HTML' },
    )
    .catch(() => {});
}

export const handleJarvisDevAdd = (ctx: Context, deps: JarvisRolesDeps) =>
  roleMutation(ctx, deps, 'developers', 'add');

export const handleJarvisDevRemove = (ctx: Context, deps: JarvisRolesDeps) =>
  roleMutation(ctx, deps, 'developers', 'remove');

export const handleJarvisAdminAdd = (ctx: Context, deps: JarvisRolesDeps) =>
  roleMutation(ctx, deps, 'admins', 'add');

export const handleJarvisAdminRemove = (ctx: Context, deps: JarvisRolesDeps) =>
  roleMutation(ctx, deps, 'admins', 'remove');

// ---------------------------------------------------------------------------
// /jarvis_alias — map a name to a Telegram user ID
// ---------------------------------------------------------------------------

/** Mutate the top-level `aliases` map on disk. */
function mutateAliases(
  configPath: string,
  transform: (aliases: Record<string, number>) => Record<string, number>,
): Record<string, number> {
  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const current = (parsed['aliases'] as Record<string, number> | undefined) ?? {};
  const next = transform({ ...current });
  const nextConfig = { ...parsed, aliases: next };
  fs.writeFileSync(configPath, JSON.stringify(nextConfig, null, 2) + '\n');
  return next;
}

export async function handleJarvisAlias(ctx: Context, deps: JarvisRolesDeps): Promise<void> {
  if (!requireGlobalAdmin(ctx, deps.config)) return;

  const parts = (ctx.message?.text ?? '').trim().split(/\s+/);
  const sub = parts[1]?.toLowerCase();

  // /jarvis_alias list
  if (!sub || sub === 'list') {
    const aliases = deps.config.aliases ?? {};
    const entries = Object.entries(aliases);
    const body = entries.length
      ? entries.map(([name, id]) => `  • <b>${name}</b> → <code>${id}</code>`).join('\n')
      : '  (none)';
    await ctx
      .reply(
        `<b>Aliases</b>\n${body}\n\n` +
          `Usage:\n` +
          `<code>/jarvis_alias set &lt;name&gt; &lt;userId&gt;</code>\n` +
          `<code>/jarvis_alias remove &lt;name&gt;</code>\n` +
          `Then use the alias anywhere a userId is expected, e.g. ` +
          `<code>/jarvis_dev_add kim</code>.`,
        { parse_mode: 'HTML' },
      )
      .catch(() => {});
    return;
  }

  // /jarvis_alias set <name> <userId|@username>
  if (sub === 'set' || sub === 'add') {
    const name = parts[2];
    const refArg = parts[3];
    if (!name || !refArg) {
      await ctx.reply('Usage: /jarvis_alias set <name> <userId or @username>').catch(() => {});
      return;
    }
    // Resolve the right side — lets you type "/jarvis_alias set kim @kimhandle"
    // and Jarvis looks up her ID from recent activity.
    const ref = resolveUserRef(refArg, ctx, deps, ctx.chat?.id ?? null);
    if (!ref.ok) {
      await ctx.reply(ref.error).catch(() => {});
      return;
    }
    const key = name.toLowerCase();
    if (key === 'set' || key === 'remove' || key === 'list' || /^\d+$/.test(key) || key.startsWith('@')) {
      await ctx.reply(`Alias name "${name}" is reserved or invalid. Pick a different name.`).catch(() => {});
      return;
    }
    const updated = mutateAliases(deps.configPath, (a) => ({ ...a, [key]: ref.userId }));
    log.info({ alias: key, userId: ref.userId }, 'Alias set');
    await ctx
      .reply(
        `Alias <b>${key}</b> → <code>${ref.userId}</code>.\n` +
          `Total aliases: ${Object.keys(updated).length}\n\n` +
          `⚠️ Restart Jarvis for the change to take effect.`,
        { parse_mode: 'HTML' },
      )
      .catch(() => {});
    return;
  }

  // /jarvis_alias remove <name>
  if (sub === 'remove' || sub === 'delete' || sub === 'rm') {
    const name = parts[2]?.toLowerCase();
    if (!name) {
      await ctx.reply('Usage: /jarvis_alias remove <name>').catch(() => {});
      return;
    }
    const updated = mutateAliases(deps.configPath, (a) => {
      return Object.fromEntries(Object.entries(a).filter(([k]) => k !== name));
    });
    log.info({ alias: name }, 'Alias removed');
    await ctx
      .reply(
        `Alias <b>${name}</b> removed.\n` +
          `Remaining: ${Object.keys(updated).length}\n\n` +
          `⚠️ Restart Jarvis for the change to take effect.`,
        { parse_mode: 'HTML' },
      )
      .catch(() => {});
    return;
  }

  await ctx.reply('Usage: /jarvis_alias [list | set <name> <userId|@username> | remove <name>]').catch(() => {});
}

export function defaultConfigPath(): string {
  return path.resolve(process.cwd(), 'config', 'config.json');
}
