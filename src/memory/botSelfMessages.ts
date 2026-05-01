/**
 * BotSelfMessagesRepo — tracks outgoing message IDs to prevent self-echo processing.
 *
 * v1.21.0 R2 BLOCKING: replaces the keyed-memory FIFO primitive (D8) with a SQLite
 * table. Two failure modes fixed:
 *   (a) concurrent-write race: INSERT OR IGNORE is atomic; no read-then-write race.
 *   (b) eviction at burst load: no fixed cap; rows live for TTL_MS (1h) then are
 *       swept by the daily trash evictor.
 *
 * Schema: see migrations/014_bot_self_messages.sql.
 * Per-bot isolation: each bot has its own data/<botName>/jarvis.db — no cross-bot lock
 * contention; ai-tony's low volume does not compete with ai-jarvis burst load.
 */

import type { DbHandle } from './dbDriver.js';

/** 1 hour TTL for self-message records. Long enough to survive webhook restarts,
 *  pm2 reload, and late Telegram redeliveries. Short enough that the eviction sweep
 *  remains trivially cheap. */
export const SELF_MESSAGE_TTL_MS = 3_600_000;

export interface BotSelfMessageRow {
  id: number;
  chat_id: number;
  message_id: number;
  sent_at: string; // ISO 8601 UTC
}

export class BotSelfMessagesRepo {
  private readonly db: DbHandle;

  constructor(db: DbHandle) {
    this.db = db;
  }

  /**
   * Record an outgoing message as sent by this bot.
   *
   * Uses INSERT OR IGNORE so duplicate inserts on the same (chat_id, message_id)
   * are silently no-ops. This makes the call idempotent under webhook redelivery
   * and concurrent sendMessage paths — the UNIQUE constraint is the guard, not the
   * caller.
   */
  recordOutgoing(chatId: number, messageId: number, sentAtIso: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO bot_self_messages (chat_id, message_id, sent_at) VALUES (?, ?, ?)`,
      )
      .run(chatId, messageId, sentAtIso);
  }

  /**
   * Returns true iff (chat_id, message_id) is recorded AND the row's sent_at is
   * within ttlMs of nowMs. Rows outside the TTL window are treated as non-existent
   * (the membership check is age-aware).
   */
  isOurEcho(chatId: number, messageId: number, ttlMs: number, nowMs: number): boolean {
    const row = this.db
      .prepare(
        `SELECT sent_at FROM bot_self_messages WHERE chat_id = ? AND message_id = ?`,
      )
      .get(chatId, messageId) as { sent_at: string } | undefined;
    if (!row) return false;
    const sentMs = new Date(row.sent_at).getTime();
    if (Number.isNaN(sentMs)) return false;
    return nowMs - sentMs < ttlMs;
  }

  /**
   * Delete rows where sent_at < (nowMs - ttlMs).
   * Called by the daily trash evictor (v1.11.0 pattern carry-forward).
   * Returns the number of rows evicted (0 is common and not audited by default).
   */
  evictExpired(ttlMs: number, nowMs: number): { evicted: number } {
    const cutoffIso = new Date(nowMs - ttlMs).toISOString();
    const result = this.db
      .prepare(`DELETE FROM bot_self_messages WHERE sent_at < ?`)
      .run(cutoffIso);
    return { evicted: result.changes };
  }
}
