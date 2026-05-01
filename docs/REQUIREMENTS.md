# Jarvis — Requirements

**App:** Jarvis — Personal AI Agent Gateway
**Mode:** Full
**Owner:** Boss (single-user lockdown)
**Compliance flags:** None (personal single-user tool, no regulated data). QA Sub-Phase D not triggered.

## User Stories (Given/When/Then)

### US-1 Text command
- **Given** I am the allowlisted Telegram user
- **When** I send a text message to the bot
- **Then** the agent processes it through Claude with tool access and replies within 3s (excluding tool exec time).

### US-2 Voice command
- **Given** I send a voice memo to the bot
- **When** the bot receives it
- **Then** it downloads the .ogg, transcribes via Whisper (<2s), echoes the transcript in italics, then acts on it.

### US-3 Shell execution
- **Given** the agent decides to run a shell command
- **When** it invokes the `run_command` tool
- **Then** it runs in the configured cwd, captures stdout+stderr, enforces a 120s timeout, and returns output truncated at `maxOutputLength`.

### US-4 Sandboxed file access
- **Given** the agent invokes a file tool
- **When** the path is outside `filesystem.allowedPaths`
- **Then** the tool rejects the call and returns a clear error — no filesystem read/write occurs.

### US-5 Allowlist enforcement
- **Given** a Telegram message arrives from a user NOT in `telegram.allowedUserIds`
- **When** the gateway processes the update
- **Then** the message is silently ignored and logged at info level.

### US-6 Destructive command confirmation
- **Given** the agent wants to run a command matching the blocklist or flagged destructive
- **When** it attempts execution
- **Then** the agent first asks the user to reply `YES`, and only executes after explicit confirmation within the same session.

### US-7 Session memory
- **Given** I talk to the bot across multiple messages
- **When** the agent builds its Claude prompt
- **Then** it includes up to `memory.maxHistoryMessages` prior messages from SQLite for continuity, across process restarts.

### US-8 Kill switch
- **Given** a command is running
- **When** I send `/stop`
- **Then** the active child process is killed and the bot confirms.

### US-9 Always-on gateway
- **Given** the machine is running
- **When** network or Telegram connection drops
- **Then** the gateway retries with exponential backoff and resumes polling automatically.

### US-10 Proactive notifications
- **Given** I ask the agent to watch something
- **When** a scheduled task (node-cron) fires and a condition is met
- **Then** the agent sends an unprompted Telegram message.

### US-11 Bot commands
- `/start /status /stop /projects /history /clear /help` behave per SPEC section "Telegram Bot Commands".

### US-12 Audit log
- Every executed shell command is persisted to `CommandLog` with command, cwd, exit_code, stdout/stderr preview, duration, timestamp.

## Non-functional
- Text round-trip < 3s (p50) excluding tool exec
- Voice transcription < 2s for <30s clips
- Gateway cold start < 5s
- Idle memory < 200MB
- No inbound network listener except localhost health endpoint
- API keys only via `.env`, validated by zod at boot

## External Dependencies
- Anthropic Claude API (Sonnet 4.6)
- OpenAI Whisper API
- Telegram Bot API (grammY)
- SQLite via better-sqlite3

## Out of Scope — see SPEC "Out of Scope (v1.0)"
