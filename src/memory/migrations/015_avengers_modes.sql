-- Migration 015: Avengers modes per-group state (v1.22.1).
--
-- Two independent flags per chat:
--   avengers_chat — when on, specialists may chime in freely on conversation
--                   (not just respond to explicit @-mentions). Casual demo mode.
--   avengers_assemble — when on, the orchestrator runs in "team execution"
--                   mode: explicitly delegates domain work to the team and
--                   coordinates a multi-step deliverable.
--
-- Toggled via /avengers chat on|off and /avengers assemble on|off.

ALTER TABLE group_settings ADD COLUMN avengers_chat INTEGER NOT NULL DEFAULT 0;
ALTER TABLE group_settings ADD COLUMN avengers_assemble INTEGER NOT NULL DEFAULT 0;
