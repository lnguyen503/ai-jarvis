# App Spec: Jarvis — Personal AI Agent Gateway

**Mode: full**
**Build Location:** `D:\ai-jarvis`

---

## Problem Statement

Developers and power users want a personal AI assistant they can talk to from their phone that has full access to their computer — run shell commands, manage files, execute scripts, browse the web, and work on projects. OpenClaw proved this model (247K GitHub stars, used via Telegram/WhatsApp/Discord), but its 430K-line codebase is bloated, hard to audit, and has had serious security vulnerabilities (CVE-2026-25253). Lighter alternatives like NanoClaw (~4K lines) and Nanobot prove the core value can be delivered in a fraction of the code.

The target user (Boss) is a solo developer on Windows who wants to message his PC from his Android phone — send a voice memo or text command, and have an AI agent execute it: run builds, check logs, manage files, query APIs, and report back. Think Iron Man's Jarvis, but it lives in a Telegram chat.

## Target Users

**Primary: Boss (solo indie developer)**
- Windows 11 desktop, Samsung Galaxy Z Fold6
- Runs multiple projects: React Native apps, Node.js services, Cloud Run deployments
- Wants to trigger builds, check status, manage files, and run scripts from his phone
- Already uses Claude API (has keys), OpenAI API, Firebase, GCP
- Comfortable with terminal but wants voice/text control from anywhere

**Secondary: Technical power users**
- Developers who want a personal AI assistant accessible via messaging apps
- People who saw OpenClaw but want something simpler, more secure, and auditable

## Core Features (MVP)

- [ ] **Feature 1: Telegram Bot Interface** — A Telegram bot that receives text and voice messages from the user. Voice messages are transcribed (Whisper API or Telegram's built-in transcription). The bot is the sole user interface — no web dashboard needed for MVP.

- [ ] **Feature 2: AI Agent Brain (Claude)** — Every incoming message is processed by Claude (Sonnet 4.6 via API) with a system prompt that defines the agent's capabilities, personality, and safety rules. The agent decides what tools to invoke and composes responses. Supports multi-turn conversation with session memory persisted to SQLite.

- [ ] **Feature 3: Shell Command Execution** — The agent can run shell commands on the host Windows machine (PowerShell and cmd). Commands execute in a configurable working directory. Output (stdout + stderr) is captured and returned to the user via Telegram. Long-running commands stream partial output. A hard timeout (default: 120s) kills hung processes.

- [ ] **Feature 4: File System Access** — The agent can read, write, create, delete, list, and search files within whitelisted directories. Supports reading file contents, writing new files, directory listings, and glob-based file search. All file operations are restricted to explicitly allowed paths in config.

- [ ] **Feature 5: Project Context & Memory** — SQLite database stores: conversation history (per-session and cross-session), user preferences, project-specific context (which directories map to which projects), and a scratchpad for the agent to persist notes. The agent can recall previous conversations and context across restarts.

- [ ] **Feature 6: Safety & Access Control** — Single-user lockdown: only messages from a configured Telegram user ID are processed (all others ignored). Dangerous command blocklist (e.g., `format`, `del /s`, `Remove-Item -Recurse C:\`) requires explicit confirmation before execution. All commands are logged with timestamps. A kill switch command (`/stop`) halts any running process immediately.

- [ ] **Feature 7: Voice Input** — Voice messages sent to Telegram are downloaded, transcribed via OpenAI Whisper API (reusing Boss's existing proxy pattern), and processed as text commands. Transcription text is shown to the user before the agent acts on it.

- [ ] **Feature 8: Tool System (Extensible)** — Tools are defined as TypeScript modules with a standard interface: `name`, `description`, `parameters` (JSON Schema), and `execute()` function. The agent uses Claude's native tool_use to invoke them. MVP ships with: `run_command`, `read_file`, `write_file`, `list_directory`, `search_files`, `web_fetch`, `get_system_info`. New tools can be added by dropping a `.ts` file into the `tools/` directory.

- [ ] **Feature 9: Gateway Process (Always-On)** — A Node.js process that runs as a Windows service (or background process via pm2/node-windows). Starts on boot, reconnects to Telegram on network drops, and logs to a rotating log file. Health check endpoint on localhost for monitoring.

- [ ] **Feature 10: Status & Notifications** — The agent can send proactive messages: build completion notifications, error alerts from watched log files, or scheduled status updates. A `/status` command returns system info (uptime, CPU, RAM, disk, running processes).

## User Flows

### Flow 1: Text Command Execution
1. User sends text message to Telegram bot: "Check if the rehearse-sales proxy is running"
2. Gateway receives message, verifies sender against allowlist
3. Message + conversation history + tool definitions sent to Claude API
4. Claude decides to use `run_command` tool with `gcloud run services describe rehearse-proxy --region us-central1 --format="value(status.url)"`
5. Gateway executes command, captures output
6. Output sent back to Claude for interpretation
7. Claude composes a human-friendly summary: "The rehearse-sales proxy is running at https://rehearse-proxy-256293129558.us-central1.run.app — status is active."
8. Response sent to user via Telegram

### Flow 2: Voice Command
1. User holds phone, records voice message in Telegram: "Read the progress file in the social reps directory"
2. Gateway downloads the voice file (.ogg)
3. Voice file sent to Whisper API for transcription
4. Transcription sent to user: "🎤 _Read the progress file in the social reps directory_"
5. Transcribed text enters the same pipeline as Flow 1
6. Claude uses `read_file` tool on `D:\projects\example-app\PROGRESS.md`
7. Claude summarizes the file content and sends it back via Telegram

### Flow 3: Dangerous Command Confirmation
1. User sends: "Delete all node_modules folders in D:\projects"
2. Claude recognizes this as a destructive recursive operation
3. Agent responds: "⚠️ This will recursively delete node_modules in D:\projects and all subdirectories. Confirm? Reply YES to proceed."
4. User replies: "YES"
5. Agent executes: `Get-ChildItem -Path "D:\projects" -Directory -Recurse -Filter "node_modules" | Remove-Item -Recurse -Force`
6. Agent reports: "Done. Removed 12 node_modules directories, freed ~4.2GB."

### Flow 4: Multi-Step Project Task
1. User sends: "Build a preview APK for rehearse sales"
2. Claude reasons through the steps needed and describes its plan
3. Claude executes sequentially: `cd D:\projects\example-app`, clean .expo and android dirs, run `npx expo prebuild --clean`, run `eas build --profile preview --platform android --non-interactive`
4. Agent streams progress updates as each step completes
5. On completion: "Preview build submitted. EAS build ID: abc123. Track at: https://expo.dev/accounts/youruser/projects/example-app/builds/abc123"

### Flow 5: Proactive Notification
1. User previously told the agent: "Watch the EAS build dashboard and ping me when my build finishes"
2. Agent sets up a polling task (check every 60s via EAS CLI or API)
3. 20 minutes later, build completes
4. Agent sends unprompted Telegram message: "Your Rehearse Sales preview build just finished — status: SUCCESS. Download: [link]"

## Data Model

- **Session:** id, telegram_chat_id, created_at, last_active_at, status (active/archived)
- **Message:** id, session_id, role (user/assistant/tool), content, tool_name, tool_input, tool_output, created_at
- **Project:** id, name, path, description, created_at (e.g., "Example App" → "D:\projects\example-app")
- **Memory:** id, key, value, category (preference/fact/note), created_at, updated_at
- **ScheduledTask:** id, description, cron_expression, command, last_run_at, next_run_at, status (active/paused)
- **CommandLog:** id, command, working_dir, exit_code, stdout_preview, stderr_preview, duration_ms, created_at

## Tech Preferences

- Frontend: None (Telegram is the UI)
- Backend: Node.js + TypeScript + Express (minimal — health endpoint only)
- Database: SQLite (better-sqlite3) for all persistence — conversations, memory, logs, scheduled tasks
- Auth: Telegram user ID allowlist (single-user lockdown)
- AI Provider: Anthropic Claude API (Sonnet 4.6 default, configurable to Opus/Haiku)
- Voice Transcription: OpenAI Whisper API
- Telegram Library: grammY (modern, TypeScript-native, actively maintained — same lib OpenClaw uses)
- Process Manager: pm2 or node-windows for always-on background service
- Other:
  - `execa` for shell command execution with timeout/streaming
  - `node-cron` for scheduled tasks
  - `pino` for structured logging with rotation
  - `zod` for config and tool parameter validation

## Constraints

- Must work offline? No — requires internet for Telegram + Claude API. But local tools (file access, shell) work if API is reachable.
- Must be mobile-responsive? N/A — no web UI. Telegram IS the UI.
- API integrations needed: Anthropic Claude API, OpenAI Whisper API, Telegram Bot API
- Security requirements:
  - **Single-user only** — reject all messages from non-allowlisted Telegram IDs
  - **File access sandboxed** to whitelisted directories (configurable in `config.json`)
  - **Command blocklist** for destructive operations requiring confirmation
  - **No remote network exposure** — gateway binds to localhost only, Telegram connection is outbound-only
  - **All commands logged** with full audit trail in SQLite
  - **API keys in .env file** — never in code, never in git
  - **Confirmation required** for any command Claude flags as destructive
- Performance targets:
  - Text command response: < 3 seconds (excluding command execution time)
  - Voice transcription: < 2 seconds
  - Gateway startup: < 5 seconds
  - Memory usage: < 200MB idle

## Architecture Notes

### Why This Is NOT a Full OpenClaw Clone

OpenClaw is 430K lines, supports 20+ messaging channels, has a plugin marketplace, multi-agent routing, browser automation, macOS app, iOS/Android nodes, and a web dashboard. That's overkill for a single-user personal assistant.

This project takes the **NanoClaw/Nanobot philosophy**: build the core agent loop in a small, auditable codebase (~2-5K lines), focused on one channel (Telegram), one user (Boss), and the tools that matter most (shell + files + memory).

### Core Agent Loop (ReAct Pattern)
```
Telegram Message → Transcribe (if voice) → Build Context (history + memory + tools)
    → Claude API (with tool_use) → Execute Tool → Return Result to Claude
    → Claude Composes Response → Send to Telegram
    → Persist to SQLite
```

### Directory Structure
```
D:\ai-jarvis\
├── src/
│   ├── index.ts              # Entry point — start gateway
│   ├── gateway.ts            # Telegram bot setup + message routing
│   ├── agent.ts              # Claude API integration + ReAct loop
│   ├── transcriber.ts        # Whisper voice transcription
│   ├── memory.ts             # SQLite session/memory management
│   ├── scheduler.ts          # Cron-based scheduled tasks
│   ├── safety.ts             # Command validation, blocklist, confirmations
│   ├── logger.ts             # Pino structured logging
│   ├── config.ts             # Config loading + validation (zod)
│   └── tools/
│       ├── index.ts           # Tool registry + loader
│       ├── run_command.ts     # Shell execution (PowerShell/cmd)
│       ├── read_file.ts       # Read file contents
│       ├── write_file.ts      # Write/create files
│       ├── list_directory.ts  # Directory listing
│       ├── search_files.ts    # Glob-based file search
│       ├── web_fetch.ts       # Fetch URL contents
│       └── system_info.ts     # CPU, RAM, disk, uptime
├── config/
│   ├── config.json            # Main config (allowed dirs, model, etc.)
│   └── system-prompt.md       # Agent personality + instructions
├── data/                      # SQLite databases (gitignored)
│   └── jarvis.db
├── logs/                      # Rotating log files (gitignored)
├── .env                       # API keys (gitignored)
├── package.json
├── tsconfig.json
└── README.md
```

### Config Shape (config.json)
```json
{
  "telegram": {
    "allowedUserIds": [123456789],
    "botToken": "ENV:TELEGRAM_BOT_TOKEN"
  },
  "ai": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6-20250514",
    "maxTokens": 4096,
    "temperature": 0.3
  },
  "whisper": {
    "model": "whisper-1",
    "apiBaseUrl": "https://api.openai.com/v1"
  },
  "safety": {
    "blockedCommands": ["format", "del /s /q C:", "Remove-Item -Recurse C:\\"],
    "confirmDestructive": true,
    "commandTimeoutMs": 120000,
    "maxOutputLength": 4000
  },
  "filesystem": {
    "allowedPaths": [
      "D:\\projects\\example-app",
      "D:\\projects\\another-app",
      "D:\\projects\\third-app",
      "D:\\ai-jarvis",
      "D:\\projects\\fourth-app",
      "D:\\projects"
    ]
  },
  "memory": {
    "dbPath": "./data/jarvis.db",
    "maxHistoryMessages": 50
  },
  "projects": [
    { "name": "Example App", "path": "D:\\projects\\example-app" },
    { "name": "Another App", "path": "D:\\projects\\another-app" },
    { "name": "Third App", "path": "D:\\projects\\third-app" },
    { "name": "Fifth App", "path": "D:\\projects\\fifth-app" },
    { "name": "Sixth App", "path": "D:\\projects\\sixth-app" }
  ]
}
```

### System Prompt Strategy
The agent's system prompt (stored in `config/system-prompt.md`) should:
1. Define the agent's identity: "You are Jarvis, Boss's personal AI assistant running on his Windows development machine."
2. List available tools and when to use each
3. Include project context from the `projects` config
4. Define safety rules: always confirm destructive operations, never expose API keys, never run commands outside allowed paths
5. Set communication style: concise, technical, no fluff — match Boss's preference for direct responses
6. Include the current date/time and system context at runtime

### Telegram Bot Commands
| Command | Action |
|---------|--------|
| `/start` | Welcome message + capabilities overview |
| `/status` | System info: uptime, CPU, RAM, disk, active processes |
| `/stop` | Kill any currently running command |
| `/projects` | List configured projects with paths |
| `/history` | Show recent command history |
| `/clear` | Clear conversation context (start fresh session) |
| `/help` | List all commands and capabilities |

## Out of Scope (v1.0)

- **No web dashboard** — Telegram is the UI. Dashboard is a v2 feature.
- **No multi-user support** — single user lockdown only.
- **No browser automation** — shell commands + file access only. Playwright/CDP integration is a future feature.
- **No WhatsApp/Discord/Slack** — Telegram only for MVP. Multi-channel is v2.
- **No TTS response** — text only in Telegram. Voice input supported but responses are text.
- **No mobile app** — Telegram IS the mobile app.
- **No Docker** — runs directly on Windows. Containerization is a future option.
- **No MCP server integration** — custom tool system for MVP. MCP compatibility is a v2 feature.
- **No skill marketplace** — tools are local TypeScript files only.
- **No file upload handling** — user can't send files to the bot for processing (v2).
- **No image/screenshot capabilities** — text and voice only (v2).

## Post-MVP Roadmap (v2+)

1. **Browser Automation** — Playwright/CDP integration for web interactions
2. **Discord/WhatsApp Channels** — Multi-channel support via channel plugins
3. **Web Dashboard** — Real-time view of agent activity, logs, and command history
4. **File Upload Processing** — Send files to the bot for analysis/transformation
5. **Screenshot Tool** — Capture and send screenshots of the desktop
6. **MCP Compatibility** — Expose tools as MCP servers, consume external MCP servers
7. **Multi-Agent Routing** — Route different types of tasks to specialized agents (code vs. ops vs. research)
8. **Proactive Monitoring** — Watch log files, build pipelines, and system health; alert on anomalies
9. **Git Integration Tool** — Native git operations (status, diff, commit, push) as first-class tools
10. **OpenCode/Swarm Integration** — Trigger and monitor OpenCode swarm builds from Telegram

## Design Notes

- **No UI to design** — Telegram handles all presentation
- Agent responses should use Telegram Markdown formatting: bold, italic, code blocks, inline code
- Long outputs (>4000 chars) should be split into multiple messages or sent as document attachments
- Use Telegram's reply-to feature to thread tool outputs with the original command
- Typing indicator ("Jarvis is typing...") should show while the agent is processing
- Voice transcriptions should be shown in italics before the agent's response
