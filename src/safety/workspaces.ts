/**
 * Per-chat isolated workspaces (v1.7.5).
 *
 * Each group chat and each DM gets its own subfolder under the configured
 * workspaces.root. When a session is processing a turn, ONLY that chat's
 * workspace is added to the effective allowedPaths — other chats'
 * workspaces are invisible to the session.
 *
 * This is how we expand Jarvis to multiple teams without leaking files
 * between groups.
 */

import fs from 'fs';
import path from 'path';
import type { AppConfig } from '../config/index.js';
import { child } from '../logger/index.js';

const log = child({ component: 'safety.workspaces' });

/**
 * Build the absolute workspace path for a chat using a two-level
 * hierarchy under the workspaces root:
 *  - DMs (positive chat IDs)    -> `{root}/users/{chatId}/`
 *  - Groups (negative chat IDs) -> `{root}/groups/{abs(chatId)}/`
 *
 * This separates "per-user" and "per-group" tenancy at the filesystem
 * level for easier inspection/backup, and is the convention we'll
 * extend to future categories (e.g., `{root}/channels/{id}` if we
 * ever support broadcast channels).
 *
 * Returns null when workspaces are disabled in config.
 */
export function workspacePathForChat(
  chatId: number,
  config: AppConfig,
): string | null {
  if (!config.workspaces.enabled) return null;
  const root = config.workspaces.root;
  const tenantKind = chatId > 0 ? 'users' : 'groups';
  const idPart = Math.abs(chatId).toString();
  return path.resolve(root, tenantKind, idPart);
}

/**
 * True if `absPath` is inside `config.workspaces.root`. Used by the path
 * sandbox to apply a carveout — the factory-internal deny-globs
 * (`config/**`, `src/**`, `tests/**`, etc.) do NOT apply inside the
 * workspaces tree, so a developer can actually create a normal project
 * structure in their own workspace without tripping the self-modification
 * guards that exist to protect Jarvis's own code.
 */
export function isInsideWorkspacesRoot(
  absPath: string,
  config: AppConfig,
): boolean {
  if (!config.workspaces.enabled) return false;
  const root = path.resolve(config.workspaces.root);
  const normRoot = root.toLowerCase().normalize('NFC');
  const normPath = absPath.toLowerCase().normalize('NFC');
  return normPath === normRoot || normPath.startsWith(normRoot + path.sep);
}

/**
 * Ensure the workspace directory exists. Idempotent — safe to call on
 * every turn. Returns the path, or null if workspaces disabled.
 *
 * Also creates a README.md on first creation so operators can see what
 * this folder is for when they stumble on it.
 */
export function ensureWorkspace(chatId: number, config: AppConfig): string | null {
  const dir = workspacePathForChat(chatId, config);
  if (dir === null) return null;
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const readme = path.join(dir, 'README.md');
      if (!fs.existsSync(readme)) {
        const label = chatId > 0 ? `DM with user ${chatId}` : `group ${chatId}`;
        fs.writeFileSync(
          readme,
          `# Jarvis Workspace — ${label}\n\n` +
            `This folder is the isolated workspace for this chat.\n\n` +
            `- Only sessions from this chat can read or write here.\n` +
            `- Other groups' workspaces are NOT accessible from here.\n` +
            `- Jarvis's own source code (D:\\ai-jarvis) is also NOT accessible from here.\n\n` +
            `Safe to delete this folder if you want to reset the chat's build artifacts.\n`,
        );
      }
      log.info({ chatId, dir }, 'Workspace created');
    } catch (err) {
      log.error(
        { chatId, dir, err: err instanceof Error ? err.message : String(err) },
        'Failed to create workspace',
      );
      return null;
    }
  }
  return dir;
}

/**
 * Compute the effective allowedPaths for this session.
 *
 * Admins see the full config.filesystem.allowedPaths (so you retain access
 * to <factory-repo>, D:\projects, etc. from your admin DM).
 *
 * Non-admins (developers and members) in group chats see ONLY that group's
 * workspace. This prevents a developer in the Boss+Kim group from reaching
 * D:\ai-jarvis or files belonging to a different group.
 *
 * @param baseAllowedPaths  config.filesystem.allowedPaths
 * @param chatId            current chat's Telegram chat ID
 * @param role              resolved role for the user sending this turn
 * @param config            app config
 */
export function effectiveAllowedPaths(
  baseAllowedPaths: readonly string[],
  chatId: number,
  role: 'admin' | 'developer' | 'member',
  config: AppConfig,
): string[] {
  const workspace = ensureWorkspace(chatId, config);

  // Admins keep full config-declared access PLUS their own workspace.
  if (role === 'admin') {
    return workspace
      ? [...baseAllowedPaths, workspace]
      : [...baseAllowedPaths];
  }

  // Developers and members in a group are confined to that group's workspace.
  // If workspaces are disabled, they fall back to the base allowlist — but
  // that's only safe if the operator explicitly disabled isolation.
  if (workspace !== null) {
    return [workspace];
  }
  return [...baseAllowedPaths];
}
