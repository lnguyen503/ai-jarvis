-- Migration 014: bot_self_messages table (v1.21.0 R2)
--
-- Replaces keyed-memory FIFO for self-message echo tracking (ADR 021 R2 BLOCKING).
-- Keyed-memory FIFO had two failure modes:
--   (a) concurrent-write race: two outgoing messages can lose one update under simultaneous
--       reads; the lost message_id then arrives and is misclassified as user input.
--   (b) eviction at burst load: 20-entry FIFO evicts in <1h under ai-jarvis v1.20.0 load
--       profile (multi-coach + spontaneous triggers = 25+ msgs/hr plausible).
--
-- Per-bot DB (each bot has its own data/<botName>/jarvis.db) so no cross-bot lock contention.
-- INSERT OR IGNORE is atomic; UNIQUE constraint makes duplicate-insert a no-op.
-- Indexed membership check is O(log n) vs O(n) array scan.
-- Daily trash evictor sweeps rows older than SELF_MESSAGE_TTL_MS (1h).
--
-- Forwards-only (per ADR 002 migration policy). Idempotent via IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS bot_self_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  sent_at    TEXT NOT NULL,                -- ISO 8601 UTC
  UNIQUE (chat_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_bot_self_messages_lookup
  ON bot_self_messages (chat_id, message_id);

CREATE INDEX IF NOT EXISTS idx_bot_self_messages_evict
  ON bot_self_messages (sent_at);
