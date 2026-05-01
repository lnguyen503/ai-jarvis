-- Migration 018: Avengers debate mode (v1.22.36).
--
-- Per-chat opt-in flag for the debate-for-accuracy flow. v1.22.35 shipped
-- debate as always-on for assemble mode, which proved too aggressive (heavy
-- per-bot models + 3-round debate stacked timeouts and hit Telegram rate
-- limits). Now off-by-default; toggle via /avengers debate on|off.

ALTER TABLE group_settings ADD COLUMN avengers_debate INTEGER NOT NULL DEFAULT 0;
