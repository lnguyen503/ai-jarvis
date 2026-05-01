-- Migration 008: email_sends table (v1.7.15)
--
-- Audit + pending-state for Gmail sends. A row is created when the agent
-- calls gmail_draft (status='pending'), transitions to 'sent' when the user
-- approves via CONFIRM SEND, or to 'failed'/'expired'/'cancelled' otherwise.
--
-- Every transition is immutable: we never update `status` without also
-- stamping `consumed_at`, and the body content stays intact so we always
-- have a full audit trail of exactly what was proposed and whether it was
-- actually sent.
--
-- Rate-limiting queries this table: count(status='sent' AND consumed_at >= now - 1h).

CREATE TABLE email_sends (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  token            TEXT NOT NULL UNIQUE,           -- 8-hex crypto-random confirmation token
  draft_id         TEXT NOT NULL,                  -- Gmail drafts.create id
  session_id       INTEGER NOT NULL,
  chat_id          INTEGER NOT NULL,               -- Telegram chat where the preview was posted
  user_id          INTEGER NOT NULL,               -- Telegram user who must confirm (admin)
  from_addr        TEXT NOT NULL,
  to_addrs         TEXT NOT NULL,                  -- JSON array of recipient emails
  cc_addrs         TEXT NOT NULL,                  -- JSON array (may be '[]')
  bcc_addrs        TEXT NOT NULL,                  -- JSON array
  subject          TEXT NOT NULL,
  body_preview     TEXT NOT NULL,                  -- first ~500 chars for audit readability
  body_hash        TEXT NOT NULL,                  -- SHA-256 of normalized to|cc|bcc|subject|body
  status           TEXT NOT NULL
                     CHECK (status IN ('pending', 'sent', 'failed', 'expired', 'cancelled')),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at       TEXT NOT NULL,
  consumed_at      TEXT,                           -- set when status leaves 'pending'
  error            TEXT,                           -- populated on 'failed'
  sent_message_id  TEXT,                           -- populated on 'sent'
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Lookup by token — the confirmation path's hot query.
CREATE UNIQUE INDEX idx_email_sends_token ON email_sends(token);

-- Rate-limit + list-recent queries.
CREATE INDEX idx_email_sends_status_created ON email_sends(status, created_at DESC);

-- Cleanup sweep.
CREATE INDEX idx_email_sends_expiry ON email_sends(status, expires_at);
