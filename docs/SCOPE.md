# Scope

## MVP (v1.0) — In Scope
- Telegram bot (grammY), single-user allowlist
- Claude agent loop with tool_use (ReAct)
- Voice transcription via Whisper
- SQLite persistence (sessions, messages, memory, projects, command log, scheduled tasks)
- Tools: run_command, read_file, write_file, list_directory, search_files, web_fetch, system_info
- Safety: blocklist + confirmation flow, sandboxed file paths, /stop kill switch
- Scheduler (node-cron) for proactive tasks
- Structured logging with pino + rotation
- Zod-validated config + env
- Localhost health endpoint
- Always-on process (pm2/node-windows instructions in README)

## Future (v2+) — Out of Scope
Web dashboard, multi-user, browser automation, additional channels (Discord/WhatsApp/Slack), TTS, mobile app, Docker, MCP, file uploads, screenshots, multi-agent routing, git tool.

## Success Criteria
- All 12 user stories verifiable
- 80%+ line coverage on src/**
- Anti-Slop PASS at all 4 checkpoints
- Scalability score ≥7/10 (single-user context considered)
- No CRITICAL security findings
- Gateway survives network drop and resumes
