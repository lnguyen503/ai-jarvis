-- Migration 004: conversation archive for auto-compaction

CREATE TABLE IF NOT EXISTS conversation_archive (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id             INTEGER NOT NULL,
  compacted_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  trigger                TEXT    NOT NULL,           -- 'auto' | 'manual'
  provider               TEXT    NOT NULL,
  model                  TEXT    NOT NULL,
  original_tokens        INTEGER NOT NULL,
  compressed_tokens      INTEGER NOT NULL,
  original_message_count INTEGER NOT NULL,
  full_history_json      TEXT    NOT NULL,           -- scrubbed JSON blob
  summary_text           TEXT    NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_conv_archive_session
  ON conversation_archive(session_id, compacted_at DESC);
