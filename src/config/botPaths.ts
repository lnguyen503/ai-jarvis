/**
 * botPaths.ts — SSOT helper for all per-bot data path construction (v1.21.0 ADR 021 D17).
 *
 * All paths under data/<botName>/ MUST be constructed via resolveBotDataPath or one
 * of the named helpers below. Do NOT inline path.join(identity.dataDir, ...) at call
 * sites — that's the drift trap this module pre-empts.
 *
 * Defense: resolveBotDataPath rejects any subpath that would escape the bot's dataDir
 * (e.g. '../ai-jarvis/secret.db' from ai-tony's context).
 */

import path from 'node:path';
import type { BotIdentity } from './botIdentity.js';

// ---------------------------------------------------------------------------
// Core safe path resolver
// ---------------------------------------------------------------------------

/**
 * Safely join subpath segments under identity.dataDir.
 *
 * Invariants:
 *   - The result is always an absolute path.
 *   - The result is always inside identity.dataDir (no `..` escape).
 *   - Absolute paths in subpath segments are rejected (defense-in-depth).
 *
 * @throws Error if the resolved path escapes identity.dataDir.
 */
export function resolveBotDataPath(identity: BotIdentity, ...subpath: string[]): string {
  // Reject any absolute paths in subpath segments
  for (const segment of subpath) {
    if (path.isAbsolute(segment)) {
      throw new Error(
        `resolveBotDataPath: absolute segment "${segment}" rejected for bot "${identity.name}". ` +
          `Use relative subpath segments only.`,
      );
    }
  }

  const joined = path.resolve(identity.dataDir, ...subpath);

  // Normalize both paths for comparison (lowercase on Windows)
  const normalizedJoined = joined.toLowerCase();
  const normalizedBase = identity.dataDir.toLowerCase();

  // The joined path must equal the dataDir OR start with dataDir + separator.
  const isInside =
    normalizedJoined === normalizedBase ||
    normalizedJoined.startsWith(normalizedBase + path.sep.toLowerCase());

  if (!isInside) {
    throw new Error(
      `resolveBotDataPath: path "${joined}" escapes dataDir "${identity.dataDir}" for bot "${identity.name}". ` +
        `Subpath traversal rejected.`,
    );
  }

  return joined;
}

// ---------------------------------------------------------------------------
// Named helpers — each is a thin wrapper over resolveBotDataPath
// ---------------------------------------------------------------------------

/** Root data directory for this bot. */
export function botDataDir(identity: BotIdentity): string {
  return identity.dataDir;
}

/** SQLite database file path: data/<botName>/jarvis.db */
export function botSqliteDbPath(identity: BotIdentity): string {
  return resolveBotDataPath(identity, 'jarvis.db');
}

/** Organize directory for a user: data/<botName>/organize/<userId> */
export function botOrganizeDir(identity: BotIdentity, userId: string | number): string {
  return resolveBotDataPath(identity, 'organize', String(userId));
}

/** Coach directory for a user: data/<botName>/coach/<userId> */
export function botCoachDir(identity: BotIdentity, userId: string | number): string {
  return resolveBotDataPath(identity, 'coach', String(userId));
}

/** Coach drafts directory for a user: data/<botName>/coach/<userId>/drafts */
export function botCoachDraftsDir(identity: BotIdentity, userId: string | number): string {
  return resolveBotDataPath(identity, 'coach', String(userId), 'drafts');
}

/** Google OAuth tokens file path: data/<botName>/google-tokens.json */
export function botCalendarTokensPath(identity: BotIdentity): string {
  return resolveBotDataPath(identity, 'google-tokens.json');
}

/** Logs directory: data/<botName>/logs */
export function botLogsDir(identity: BotIdentity): string {
  return resolveBotDataPath(identity, 'logs');
}
