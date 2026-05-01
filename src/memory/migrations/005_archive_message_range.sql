-- Migration 005: add message-id range columns to conversation_archive
-- Allows the recall_archive tool to identify which messages each archive covers.
-- Nullable for backward compatibility with pre-v1.4.1 rows.

ALTER TABLE conversation_archive ADD COLUMN first_message_id INTEGER;
ALTER TABLE conversation_archive ADD COLUMN last_message_id INTEGER;

CREATE INDEX idx_conv_archive_range ON conversation_archive(session_id, first_message_id, last_message_id);
