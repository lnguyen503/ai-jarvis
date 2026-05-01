/**
 * GroupActivityRepo — persists group_user_activity for rate limiting and stats.
 * Rate-limit window: sliding window anchored to window_start_at.
 * When now > window_start_at + windowMinutes, the window resets before incrementing.
 */

import type { DbHandle, Statement } from './dbDriver.js';

export interface GroupUserActivity {
  group_id: number;
  user_id: number;
  username: string | null;
  message_count: number;
  input_tokens: number;
  output_tokens: number;
  last_active_at: string;
  window_start_at: string;
}

export interface RateLimitResult {
  allowed: boolean;
  /** current count in the window AFTER the check (before incrementing if allowed) */
  current: number;
  limit: number;
}

export class GroupActivityRepo {
  private readonly stmtGet: Statement;
  private readonly stmtUpsert: Statement;
  private readonly stmtIncrMsg: Statement;
  private readonly stmtResetWindow: Statement;
  private readonly stmtIncrTokens: Statement;
  private readonly stmtList: Statement;
  private readonly stmtGetOverride: Statement;
  private readonly stmtUpsertOverride: Statement;

  constructor(private readonly db: DbHandle) {
    this.stmtGet = db.prepare(
      `SELECT * FROM group_user_activity WHERE group_id = ? AND user_id = ?`,
    );
    this.stmtUpsert = db.prepare(`
      INSERT INTO group_user_activity (group_id, user_id, username, message_count, window_start_at, last_active_at)
      VALUES (?, ?, ?, 0, datetime('now'), datetime('now'))
      ON CONFLICT(group_id, user_id) DO UPDATE SET
        username = excluded.username,
        last_active_at = datetime('now')
    `);
    this.stmtIncrMsg = db.prepare(`
      UPDATE group_user_activity
      SET message_count = message_count + 1,
          last_active_at = datetime('now')
      WHERE group_id = ? AND user_id = ?
    `);
    this.stmtResetWindow = db.prepare(`
      UPDATE group_user_activity
      SET message_count = 1,
          window_start_at = datetime('now'),
          last_active_at = datetime('now')
      WHERE group_id = ? AND user_id = ?
    `);
    this.stmtIncrTokens = db.prepare(`
      UPDATE group_user_activity
      SET input_tokens = input_tokens + ?,
          output_tokens = output_tokens + ?
      WHERE group_id = ? AND user_id = ?
    `);
    this.stmtList = db.prepare(
      `SELECT * FROM group_user_activity WHERE group_id = ? ORDER BY message_count DESC`,
    );
    this.stmtGetOverride = db.prepare(
      `SELECT rate_limit FROM group_rate_limit_overrides WHERE group_id = ? AND user_id = ?`,
    );
    this.stmtUpsertOverride = db.prepare(`
      INSERT INTO group_rate_limit_overrides (group_id, user_id, rate_limit, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(group_id, user_id) DO UPDATE SET
        rate_limit = excluded.rate_limit,
        updated_at = datetime('now')
    `);
  }

  /**
   * Check whether a user is within the rate limit.
   * If within window and under limit: returns allowed=true and increments.
   * If window expired: resets window (count=1) and returns allowed=true.
   * If within window and AT or OVER limit: returns allowed=false.
   */
  checkAndIncrement(
    groupId: number,
    userId: number,
    username: string | null,
    limitPerWindow: number,
    windowMinutes: number,
  ): RateLimitResult {
    // Upsert to ensure the row exists
    this.stmtUpsert.run(groupId, userId, username);

    const row = this.stmtGet.get(groupId, userId) as GroupUserActivity | undefined;
    if (!row) {
      // Should not happen after upsert, but fail open
      return { allowed: true, current: 0, limit: limitPerWindow };
    }

    // Check for per-user override
    const overrideRow = this.stmtGetOverride.get(groupId, userId) as
      | { rate_limit: number }
      | undefined;
    const effectiveLimit =
      overrideRow && overrideRow.rate_limit > 0 ? overrideRow.rate_limit : limitPerWindow;

    // SQLite datetime() returns 'YYYY-MM-DD HH:MM:SS' (UTC, no 'T'/'Z').
    // Normalize to ISO-8601 with 'T' separator and 'Z' suffix for consistent Date.parse().
    const rawTs = String(row.window_start_at);
    const windowStartIso = rawTs.includes('T')
      ? rawTs.endsWith('Z') ? rawTs : rawTs + 'Z'
      : rawTs.replace(' ', 'T') + 'Z';
    const windowStartMs = new Date(windowStartIso).getTime();
    const windowMs = windowMinutes * 60 * 1000;
    const now = Date.now();

    if (now > windowStartMs + windowMs) {
      // Window expired — reset (count becomes 1)
      this.stmtResetWindow.run(groupId, userId);
      return { allowed: true, current: 1, limit: effectiveLimit };
    }

    const current = row.message_count;
    if (current >= effectiveLimit) {
      return { allowed: false, current, limit: effectiveLimit };
    }

    // Within window and under limit — increment
    this.stmtIncrMsg.run(groupId, userId);
    return { allowed: true, current: current + 1, limit: effectiveLimit };
  }

  /** Accumulate token usage for a user in a group */
  addTokens(groupId: number, userId: number, inputTokens: number, outputTokens: number): void {
    this.stmtIncrTokens.run(inputTokens, outputTokens, groupId, userId);
  }

  /** List all activity records for a group (for /jarvis-users) */
  listForGroup(groupId: number): GroupUserActivity[] {
    return this.stmtList.all(groupId) as GroupUserActivity[];
  }

  /**
   * v1.7.7 — look up a user by Telegram @username (case-insensitive, no @).
   * Scoped to ONE group for admin commands that target the current chat.
   * Returns null if no record with that username has been seen in the group.
   */
  findByUsernameInGroup(groupId: number, username: string): GroupUserActivity | null {
    const norm = username.toLowerCase().replace(/^@/, '');
    const row = this.db
      .prepare(
        `SELECT * FROM group_user_activity
         WHERE group_id = ? AND lower(username) = ?
         ORDER BY last_active_at DESC LIMIT 1`,
      )
      .get(groupId, norm) as GroupUserActivity | undefined;
    return row ?? null;
  }

  /**
   * v1.7.7 — look up a user by @username across any group we've seen.
   * Used when the admin manages roles from a DM and references users by
   * @username without specifying which chat to search.
   */
  findByUsernameAnyGroup(username: string): GroupUserActivity | null {
    const norm = username.toLowerCase().replace(/^@/, '');
    const row = this.db
      .prepare(
        `SELECT * FROM group_user_activity
         WHERE lower(username) = ?
         ORDER BY last_active_at DESC LIMIT 1`,
      )
      .get(norm) as GroupUserActivity | undefined;
    return row ?? null;
  }

  /** Set per-user rate limit override (0 = use default) */
  setRateLimitOverride(groupId: number, userId: number, limit: number): void {
    this.stmtUpsertOverride.run(groupId, userId, limit);
  }
}
