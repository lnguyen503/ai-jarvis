# Jarvis — Personal AI Agent Gateway

**Current version:** v1.3.0 — group chat mode, multi-model routing (Ollama Cloud primary, Claude premium/fallback), context7 MCP docs lookup, Tavily web search.

Jarvis is a Telegram-fronted AI agent that runs on your Windows machine and gives you full shell, file, and system access from your phone. Send a voice memo or text command; Jarvis routes it to the best model (GLM-5.1, Nemotron, MiniMax M2.7, Gemma 4, or Claude) and executes it. Supports DM and group chat.

---

## First-Run Checklist (for Boss)

- [ ] Node.js 20+ installed (`node --version`)
- [ ] pm2 installed globally (`npm install -g pm2`)
- [ ] Telegram bot created via @BotFather — token in hand
- [ ] Anthropic API key ready (`sk-ant-…`)
- [ ] OpenAI API key ready (for Whisper voice transcription)
- [ ] Your Telegram user ID found (message @userinfobot)
- [ ] `config/config.json` created from `config/config.example.json` and edited
- [ ] `.env` created from `.env.example` and filled in
- [ ] `config/system-prompt.md` present (already committed)
- [ ] `data/` directory exists (`mkdir data`)
- [ ] (Optional, for group mode) add your Telegram user ID to `groups.adminUserIds` and target group IDs to `groups.allowedGroupIds` in `config.json`
- [ ] Run `npm test` — all 394 tests should pass before first boot

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure secrets (.env)

```bash
cp .env.example .env
```

Edit `.env`:

| Variable | Purpose |
|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Token from @BotFather |
| `ANTHROPIC_API_KEY` | Claude API key (`sk-ant-…`) — used as fallback / premium |
| `OLLAMA_API_KEY` | Ollama Cloud API key — get from https://ollama.com/settings/api-keys |
| `OPENAI_API_KEY` | Whisper transcription key |
| `TAVILY_API_KEY` | Tavily web search key — get from https://tavily.com/ (required for `/search` and `web_search` tool) |
| `LOG_LEVEL` | Optional — `info` (default) / `debug` / `warn` |
| `NODE_ENV` | Optional — `production` (default) |

### 3. Configure the agent (config.json)

```bash
cp config/config.example.json config/config.json
```

Edit `config/config.json`:

```json
{
  "telegram": {
    "allowedUserIds": [YOUR_TELEGRAM_USER_ID],
    "botToken": "ENV:TELEGRAM_BOT_TOKEN"
  },
  "filesystem": {
    "allowedPaths": [
      "D:\\your-projects-folder",
      "D:\\ai-jarvis"
    ]
  }
}
```

Key fields to edit:
- `telegram.allowedUserIds` — your Telegram numeric user ID (only this ID can use the bot)
- `filesystem.allowedPaths` — directories Jarvis is allowed to read/write
- `ai.defaultProvider` / `ai.defaultModel` — primary provider (default: `ollama-cloud` / `glm-5.1:cloud`)
- `ai.premiumProvider` / `ai.premiumModel` — used via `/model claude` or as silent fallback (default: `claude` / `claude-sonnet-4-6`)
- `ai.routing.enabled` — set `false` to disable keyword routing and always use `defaultProvider`

### 4. Create the data directory

```bash
mkdir data
```

The SQLite database is auto-created on first boot.

### 5. Build and start

```bash
npm run build
npm start
```

Or for development (no build step):

```bash
npm run dev
```

---

## Multi-bot (Avengers) — Recommended (v1.21.0+)

Run the full **Avengers ensemble** (ai-jarvis + ai-tony) with PM2:

```bash
npm run build
pm2 start ecosystem.config.cjs
pm2 save
```

For detailed setup — creating new bots, configuring persona files, adding a 3rd bot, and the operator runbook — see **[docs/AVENGERS.md](docs/AVENGERS.md)**.

Quick reference:

```bash
pm2 status                  # status of all bots
pm2 logs ai-jarvis          # tail ai-jarvis logs
pm2 logs ai-tony            # tail ai-tony logs
pm2 restart ai-tony         # restart a single bot
pm2 reload ecosystem.config.cjs  # zero-downtime reload after config change
```

## Single-bot (Legacy)

If you only want to run ai-jarvis as a single process (no ai-tony):

```bash
npm run build
BOT_NAME=ai-jarvis pm2 start dist/index.js --name jarvis
pm2 save
pm2 startup   # follow the instructions to start pm2 on boot
```

Or without PM2:

```bash
npm run build
npm start
```

---

## Running Tests

```bash
# All unit + integration tests (275 tests as of v1.1)
npm test

# With coverage report (output to ./coverage/)
npx vitest run --coverage

# Type-check without compiling
npm run typecheck

# Dependency security audit
npm audit --omit=dev
```

---

## Telegram Bot Commands

| Command | Action |
|---------|--------|
| `/start` | Welcome message + capabilities overview |
| `/status` | System info: uptime, CPU, RAM, disk, active processes |
| `/stop` | Kill any currently running command immediately |
| `/projects` | List configured projects with their paths |
| `/search <query>` | Fast web search via Tavily — bypasses agent for speed |
| `/model` | Show current model routing status |
| `/model claude` | Pin session to Claude (premium) |
| `/model <name>` | Pin session to any model (e.g. `/model glm-5.1:cloud`) |
| `/model auto` | Return to keyword-based auto-routing |
| `/cost` | Show session token usage and estimated cost |
| `/history` | Show recent command history from SQLite log |
| `/clear` | Clear conversation context — starts a fresh session |
| `/voice [on\|off]` | Toggle TTS voice replies for this chat (in-memory, default OFF) |
| `/vision [on\|off]` | Toggle image/GIF analysis for this chat (in-memory, default ON) |
| `/calendar [on\|off]` | Toggle Google Calendar tools for this chat (in-memory, default ON) |
| `/jarvis_intent [on\|off]` | Toggle LLM intent detection for group activation (in-memory, default ON) — when ON, Jarvis tries to understand when he's being addressed without the "jarvis" keyword, and asks to confirm if unsure |
| `/debate [on rounds exchanges]` | Multi-model adversarial debate mode |
| `/help` | List all commands and capabilities |

For anything else, just type or send a voice message — Jarvis will figure out what tools to use.

---

## Multi-Model Routing (v1.1)

Jarvis v1.1 routes tasks to different Ollama Cloud models based on keywords in your message:

| Keywords | Model | Strength |
|----------|-------|----------|
| `review`, `security`, `audit`, `vulnerability` | `minimax-m2.7:cloud` | Code review, security analysis |
| `architect`, `design`, `plan`, `schema` | `nemotron-cascade-2:cloud` | System design, planning |
| `search`, `find`, `research`, `docs` | `gemma4:cloud` | Research, documentation lookup |
| `code`, `build`, `implement`, `fix`, `write` | `glm-5.1:cloud` | Implementation, debugging |
| *(default — no keyword match)* | `glm-5.1:cloud` | General tasks |

**Claude is the premium fallback**: If Ollama Cloud fails (HTTP error, timeout, or malformed response), Jarvis silently retries with Claude. You won't see any error. Claude is also available on-demand via `/model claude`.

**Session pinning**: Use `/model <name>` to lock your session to a specific model for the rest of the conversation. `/model auto` returns to keyword routing.

**Config-driven**: All model IDs are overridable in `config.json` under `ai.providers.ollama-cloud` — no code changes needed to swap models.

---

## Tools Reference

| Tool | Description | Key Constraints |
|------|-------------|-----------------|
| `run_command` | Execute PowerShell or cmd commands | 120s timeout; dangerous patterns require confirmation |
| `read_file` | Read file contents (UTF-8 or base64) | Restricted to `filesystem.allowedPaths`; blocks `.env`, keys, certs |
| `write_file` | Write or append to a file | Restricted to `filesystem.allowedPaths`; blocks `.env`, `.db`, `logs/`, `data/` |
| `list_directory` | List directory contents | Restricted to allowed paths; hidden sensitive entries filtered |
| `search_files` | Glob-based file search | Max 500 entries scanned, max depth 8 to prevent DoS |
| `system_info` | CPU, RAM, disk, uptime, processes | Read-only, always available |
| `send_file` | Upload a file from the filesystem to the current Telegram chat | Restricted to `filesystem.allowedPaths` + read denylist; max 50 MB; allowed extensions only; all sends logged to SQLite |
| `web_search` | Tavily web search — current results with title/URL/snippet | Requires `tavily.enabled: true` and `TAVILY_API_KEY`; 15s timeout; scrubbed output |
| `browse_url` | Load a page in headless Chromium and return Readability-extracted article text (optional screenshot) | **Admin-only**; requires `browser.enabled: true` + `npx playwright install chromium`; fresh incognito context per call (no persistent cookies/logins); SSRF guard blocks private IPs + deny-host globs; 15s page timeout; 100KB text cap |
| `calendar_list_events` | Read events from your Google Calendar | **Admin-only** (never visible in groups); requires OAuth setup via `npm run google-auth`; refresh tokens auto-rotate |
| `calendar_create_event` | Create a new event on your Google Calendar (with optional Google Meet link) | **Admin-only**; default `notificationLevel: NONE` so attendees aren't auto-emailed unless explicitly requested |
| `gmail_search` | Search Gmail with native query syntax (is:unread, from:X, subject:Y, after:YYYY/MM/DD, has:attachment, newer_than:Nd) | **Admin-only**; `gmail.readonly` scope; `maxResults` capped by `google.gmail.maxResults` |
| `gmail_read` | Fetch a Gmail message by id (from gmail_search) with full body + attachment metadata | **Admin-only**; prefers `text/plain` over `text/html`; attachments listed but not downloaded |
| `gmail_draft` | Stage an outgoing email for your approval (does NOT send) | **Admin-only**; requires `google.gmail.send.enabled: true` + `gmail.compose` scope; LLM can draft but cannot send — send happens ONLY when you type `CONFIRM SEND <token>` in DM; rate-limited; full audit trail |
| `context7__*` | Tools discovered from context7 MCP server | Prefixed with server name; lazy connect; requires `mcp.enabled: true` |

> **web_fetch is intentionally absent** — removed at CP1 per ADR 002 (SSRF risk on a personal machine with no egress controls).

---

## File Upload (v1.5)

Jarvis can send files from the filesystem directly to Telegram using the `send_file` tool.

### When the agent sends files
The agent uses `send_file` automatically when:
- You ask it to generate a file and deliver it ("write a CSV report and send it to me")
- It has just written a file you requested ("now send me the output")

### Supported extensions
`.html` `.js` `.ts` `.json` `.md` `.txt` `.py` `.csv` `.pdf` `.png` `.jpg` `.jpeg` `.zip`

### Limits
- **Max size:** 50 MB (Telegram Bot API limit)
- **Allowed paths:** Same as `read_file` — must be inside `filesystem.allowedPaths`; `.env`, `*.db`, `logs/**`, SSH/PEM keys are blocked by the read denylist even if inside an allowed root

### Image preview
If you ask Jarvis to send a `.png` or `.jpg` and want it displayed inline (not as a downloadable attachment), say "send it as a photo". This sets `preview: true` on the tool call.

### HTML files
HTML files are sent as documents (the phone opens them in a browser/viewer). Telegram Instant View is not available for locally-sent files — it only works for public URLs matching an Instant View template.

### Audit log
Every send attempt (success or failure) is recorded in the `file_sends` SQLite table for security auditing.

---

## MCP Integration (v1.2)

Jarvis can connect to [Model Context Protocol](https://modelcontextprotocol.io/) servers and expose their tools to the agent.

### Configuring MCP servers

In `config/config.json`:

```json
{
  "mcp": {
    "enabled": true,
    "servers": [
      {
        "name": "context7",
        "url": "https://mcp.context7.com/mcp",
        "enabled": true,
        "transport": "http"
      }
    ]
  }
}
```

- `transport`: `"http"` (Streamable HTTP, default) or `"sse"` (Server-Sent Events)
- MCP connections are **lazy** — they open on first tool use, not at boot
- Discovery failures are **non-fatal** — Jarvis boots normally if an MCP server is unreachable
- All MCP tool outputs pass through the same safety scrubber as built-in tools
- Tools are prefixed with the server name to prevent collisions: `context7__get_library_docs`

### Disabling MCP

Set `mcp.enabled: false` in config — no network calls will be made.

---

## Web Search (v1.2)

Powered by [Tavily](https://tavily.com/). Two access modes:

1. **As a tool** — Claude can invoke `web_search` in the normal agent loop
2. **As `/search <query>`** — Direct command, bypasses agent for speed

### Setup

1. Get a Tavily API key from https://tavily.com/
2. Add to `.env`: `TAVILY_API_KEY=tvly-your-key-here`
3. Enable in config: `"tavily": { "enabled": true, "apiKey": "ENV:TAVILY_API_KEY" }`

### Toggling

Set `tavily.enabled: false` to disable both the tool and the `/search` command without a restart.

---

## Autonomous Web Research (v1.7.14)

Jarvis can now open a real headless browser, load a page, and read the article content — not just the Tavily snippet. Combined with `web_search`, he can research on his own: Tavily for links, `browse_url` for the actual content, then synthesize.

### One-time install

```bash
cd D:\ai-jarvis
npx playwright install chromium   # downloads Chromium (~300 MB)
```

Already run if this was a fresh clone of v1.7.14+.

### How it works

- **`browse_url`** is an **admin-only** tool. Developers and members in group chats never see it.
- Every call opens a **fresh incognito context** in the shared Chromium process, navigates, extracts, and closes the context. Cookies/localStorage/IndexedDB from one call NEVER survive to the next. This is how "Jarvis can browse but can't log in to my bank" is enforced — structurally, not by policy.
- A **pre-navigation SSRF guard** blocks `file:`, `data:`, `javascript:` schemes and any hostname that resolves to a private/loopback/link-local/cloud-metadata IP (v4 and v6). Configured `browser.denyHosts` globs add further denies.
- Content is extracted via **Readability** (the Firefox Reader View algorithm) — article body only, nav/footer/ads stripped. Non-article pages fall back to body text.
- Output is capped at `browser.maxContentChars` (default 100KB) so one giant page can't blow the context window.

### Example

DM the bot:
> search the web for the latest on Claude 4.7 and summarize what's new

The agent will:
1. Call `web_search("Claude 4.7 release notes")` → list of URLs + snippets.
2. Pick the 2-3 most relevant (e.g. anthropic.com, a changelog).
3. Call `browse_url(url)` on each → gets the actual article bodies.
4. Write a synthesis grounded in the real content, not just snippets.

Or ask for a page directly:
> read this page and tell me the main point: https://example.com/article

### Config

```json
"browser": {
  "enabled": true,
  "headless": true,
  "pageTimeoutMs": 15000,
  "maxContentChars": 100000,
  "denyHosts": [],
  "userAgent": ""
}
```

- `headless: false` is supported for local debugging (a visible Chromium window appears) — not recommended for production.
- `denyHosts` accepts exact hosts or wildcard globs like `"*.internal"`.
- `userAgent: ""` uses the Chromium default. Set a custom string if a specific site blocks the default.

### Privacy + safety posture

- **Admin-only.** Never available in group chats regardless of who sends the message.
- **No persistent state.** Fresh incognito context per call; closed on finish. Nothing Jarvis browses with is cached across calls.
- **No logged-in access by design.** The scope is deliberately "read public web pages." Banking, social media, email web UIs — Jarvis cannot touch them because the architecture doesn't give him a cookie jar.
- **SSRF protected.** DNS is resolved up front; any answer in a private range rejects the whole URL. DNS rebinding is defeated because all A/AAAA records are checked.
- **Bounded.** 15s page timeout, 5MB response body cap, 100KB extracted text cap, media/font requests blocked, max 10 redirects.
- **Scrubbed.** Extracted text passes through the same secret scrubber as every other tool output before the agent sees it.

### Disabling

Set `browser.enabled: false` in `config/config.json` — the tool isn't registered at boot, and the Chromium binary is never launched.

---

## Google Calendar (v1.7.11)

Native Calendar integration via Google's official OAuth flow. Surfaces a `calendar_list_events` tool that's **admin-only** — never visible in group chats regardless of who sends the message.

### One-time setup

1. **Create a Google Cloud OAuth client** (5 min):
   - Go to https://console.cloud.google.com/apis/credentials
   - If you don't have a project yet: create one (any name).
   - Enable the **Google Calendar API** under "APIs & Services > Library".
   - Click **Create Credentials > OAuth client ID > Desktop app**, give it a name.
   - Copy the client ID and client secret.

2. **Add the credentials to `.env`**:
   ```
   GOOGLE_OAUTH_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-...
   ```

3. **Enable in `config/config.json`** (already on by default in the shipped config):
   ```json
   "google": {
     "enabled": true,
     "oauth": {
       "clientId": "ENV:GOOGLE_OAUTH_CLIENT_ID",
       "clientSecret": "ENV:GOOGLE_OAUTH_CLIENT_SECRET",
       "tokenPath": "./data/google-tokens.json"
     },
     "calendar": { "enabled": true, "defaultCalendarId": "primary" }
   }
   ```

4. **Authorise once**:
   ```bash
   npm run google-auth
   ```
   This opens a browser, asks you to sign in to Google and grant calendar access, then writes a refresh token to `data/google-tokens.json`. The file is gitignored and the `data/**` read-deny glob keeps tools from reading it.

5. **Restart Jarvis**:
   ```bash
   pm2 restart jarvis
   ```

### Usage

DM the bot:
> what's on my calendar today?

Or any natural variation — Claude/Ollama call `calendar_list_events` with the right time window. The tool returns event titles, times, locations, attendees, and links.

### Privacy posture

- The tool is `adminOnly: true` — group developers and members never see it in their tool list, and dispatch rejects any hallucinated call to it.
- Tokens live at `data/google-tokens.json` with `0o600` permissions; the `data/**` deny glob blocks all `read_file` / `send_file` access.
- Refresh tokens auto-rotate; the file is updated atomically when googleapis refreshes the access token.

### Disabling

Set `google.calendar.enabled: false` (or `google.enabled: false`) — the tool isn't registered at boot.

---

## Gmail (v1.7.12)

Native Gmail integration via the same Google OAuth client as Calendar. Surfaces `gmail_search` and `gmail_read` — both **admin-only**, never visible in group chats regardless of who sends the message. Scope: `gmail.readonly` (no send, no modify).

### Setup

The OAuth client is the same one you created for Calendar. If you already ran `npm run google-auth` for Calendar, you need to **re-run it** so Google grants the newly-added Gmail scope — existing refresh tokens don't auto-upgrade.

1. **Ensure Gmail API is enabled** for your Google Cloud project: https://console.cloud.google.com/apis/library/gmail.googleapis.com (click **Enable**).

2. **Re-authorise** (required for existing users after upgrading to v1.7.12):
   ```bash
   npm run google-auth
   ```
   Sign in, approve the new "Read your email" permission, and the token file at `data/google-tokens.json` will be rewritten with the expanded scope.

3. **Enable in `config/config.json`** (on by default in the shipped config):
   ```json
   "google": {
     "enabled": true,
     "gmail": { "enabled": true, "maxResults": 10 }
   }
   ```

4. **Restart Jarvis**:
   ```bash
   pm2 restart jarvis
   ```

### Usage

DM the bot:
> any unread email from Sam this week?
> show me invoices from April
> read the latest email from my landlord

The agent calls `gmail_search` with a Gmail query like `from:sam@x.com is:unread newer_than:7d`, picks the most relevant id, then calls `gmail_read` for the full body.

### Query syntax

Full reference: https://support.google.com/mail/answer/7190 — common patterns:
- `is:unread` — unread only
- `from:sam@example.com` / `to:me`
- `subject:invoice` (phrase match)
- `after:2026/04/01 before:2026/04/15`
- `newer_than:7d` / `older_than:1y`
- `has:attachment filename:pdf`
- `label:important`

### Privacy posture

- Tools are `adminOnly: true` — group developers and members never see them in their tool list; dispatch rejects any hallucinated call.
- Tokens live at `data/google-tokens.json` (mode `0o600`); the `data/**` deny glob blocks all `read_file` / `send_file` access.
- Scope is `gmail.readonly` — Jarvis cannot send, delete, or modify messages with the current token.
- Every tool output passes through the secret scrubber.

### Not yet shipped

- `gmail_send` — will require the `gmail.send` scope and the existing `safety.requireConfirmation` flow so every outbound mail prompts for OK in chat before sending.
- `gmail_download_attachment` — attachment ids are returned today, but downloading the bytes isn't wired up.

### Disabling

Set `google.gmail.enabled: false` (or `google.enabled: false`) — the tools aren't registered at boot.

---

## Gmail Send — On Your Behalf, Only With Your Approval (v1.7.15)

Jarvis can now compose outbound email. He **cannot** send it. Every outgoing message requires you to type a confirmation token in DM — enforced architecturally, not by policy.

### How it works

1. You ask Jarvis to draft or reply to an email.
2. Jarvis calls `gmail_draft` → creates a Gmail draft + stages an 8-hex confirmation token bound to a SHA-256 hash of the exact proposed content.
3. The **full preview** (from/to/cc/subject/body) is posted directly to your DM by the gateway — not by the LLM, so the model cannot paraphrase or hide what you see.
4. You read the preview and type: `CONFIRM SEND a7b3c2d1`
5. The gateway (not the agent) matches the pattern, re-verifies the token's chat/user/TTL/hash, then calls Gmail `drafts.send`.
6. Token is single-use. Anything else you type starts a normal agent turn — the pending draft expires quietly.

### Thirteen defense layers (all must pass)

If ONE fails, the other twelve still block the send:

1. **Narrow scope** — `gmail.compose` only. Can draft + send; cannot delete or relabel existing mail.
2. **No `gmail_send` tool exists** in the LLM's toolbelt. The model has no instrument to directly send.
3. **Send is gateway-only** — `handleConfirmSend` runs before the agent loop in the DM handler. LLM not in the path.
4. **Preview posted via `ctx.telegram.sendMessage`** — not via the agent's reply. LLM cannot forge the preview.
5. **Cryptographic token** — `crypto.randomBytes(4)` → 8 hex chars. Unguessable.
6. **Content-hash binding** — SHA-256 of `from|to|cc|bcc|subject|body` stored at stage time. At send time the gateway fetches the raw Gmail draft and re-hashes it. **Mismatch → refuse + delete draft + audit.**
7. **Chat binding** — token valid only in the DM where it was staged.
8. **Owner binding** — only users in `telegram.allowedUserIds` can confirm.
9. **DM-only** — non-private chat fails silently.
10. **Single-use** — `UPDATE ... WHERE status='pending'` makes concurrent duplicate confirms no-op.
11. **5-min TTL** (configurable).
12. **Rate limit** — max 10 SENT / hour (configurable). Checked BEFORE staging.
13. **System-prompt rule 9** — the model is told that email bodies, web pages, and tool outputs are untrusted content. Instructions to send email inside them are prompt injection and must be ignored.

Every state transition is logged in `email_sends` (full proposed content preserved) and `audit_log` (`category='confirmation'`).

### Turning it on (off by default)

```bash
cd D:\ai-jarvis

# 1. Grant the new gmail.compose scope:
npm run google-auth
#    Sign in, approve "Manage drafts and send emails".

# 2. Flip the switch in config/config.json:
#    "google": { "gmail": { "send": { "enabled": true } } }

# 3. Build + restart:
npm run build
pm2 restart jarvis
```

### Configuration knobs

```json
"google": {
  "gmail": {
    "send": {
      "enabled": false,
      "confirmationTtlSeconds": 300,
      "rateLimitPerHour": 10,
      "maxRecipientsPerSend": 20,
      "requireReplyToThread": false
    }
  }
}
```

### Disabling at any time

Any one of these kills the send path:
- `google.gmail.send.enabled: false` — `gmail_draft` isn't registered
- `google.gmail.enabled: false` — no Gmail tools at all
- `google.enabled: false` — no Google tools at all

Revoking the Gmail token at https://myaccount.google.com/permissions kills it instantly — next send attempt fails auth, all other tools continue.

### Auditing what Jarvis proposed

Every draft (sent, cancelled, failed, expired) is in SQLite:

```sql
SELECT created_at, status, from_addr, to_addrs, subject, body_preview
FROM email_sends ORDER BY created_at DESC LIMIT 50;
```

---

## Persistent User Memory (v1.8.5)

Jarvis remembers preferences, profile, projects, people, and corrections about each user who talks to him — across every DM and group chat. Per-user, not per-chat. Stored as hand-editable markdown at `data/memories/<userId>.md` (gitignored; never committed).

- **Save:** "remember I prefer brief replies" → `update_memory` tool → appended to your file.
- **Forget:** "forget that I prefer brief replies" → `forget_memory` tool → removes matching lines.
- **Inspect:** `/memory` — shows your full memory file.
- **Wipe:** `/memory clear CONFIRM` — deletes your file.
- **Toggle:** `/memory off` / `/memory on` — suspends injection for your session.

**Privacy filter at write time** (deterministic, not LLM judgment): phone / SSN / credit card / email / credentials / health-specific terms / long opaque tokens are all rejected with a reason the agent relays to you. No "trust me" — the filter rejects or passes, end of story. See `src/memory/userMemoryPrivacy.ts` for the exact pattern list.

---

## Personal Organizer — `/organize` (v1.8.6)

A mobile-task-app-style organizer surfaced through Telegram chat. Each item is a per-user markdown file. Events sync to Google Calendar; tasks and goals stay local. Jarvis has persistent access to your active items — they appear at the top of his context on every DM turn, so you can say "complete the dentist task" or "log 2 lbs lost this week" without paging him in.

### What it stores

- **Tasks** — one-off to-dos with optional due dates. "Add a task to finish the report by Friday."
- **Events** — calendar-bound. Syncs to Google Calendar. "Schedule dentist Tuesday at 2pm."
- **Goals** — long-running, possibly dateless. Progress is tracked via dated log entries. "I want to lose 10 lbs by summer." Then later: "I lost 2 lbs this week" → appended to the goal's progress log.

Each item lives at `data/organize/<userId>/<itemId>.md` (gitignored). Format:

```
---
id: 2026-04-24-a1b2
type: goal
status: active
title: Lose 10 lbs by summer
created: 2026-04-24T10:30:00Z
due: 2026-07-01
parentId:
calendarEventId:
tags: [fitness, health]
---

## Notes
Walk after dinner most nights. Protein at breakfast.

## Progress
- 2026-04-24: Baseline weigh-in 185 lbs.
```

Hand-editable — open it in any editor, save, and Jarvis picks up the change on the next turn.

### How you interact

**Via natural language** — the agent picks the right tool. "Add a task to renew my license by May 15" → `organize_create`. "Mark the dentist appointment done" → `organize_complete`. "Log weight 173 today on the weight-loss goal" → `organize_log_progress`. "Delete the book-flight task" → `organize_delete`.

**Via slash command** — `/organize` (DM-only, read-only):

- `/organize` — active items summary (same block the agent sees).
- `/organize all` — all items including done/abandoned.
- `/organize tasks` / `events` / `goals` — filter by type.
- `/organize <id>` — full item (front-matter + notes + progress log).
- `/organize tag <name>` — filter by tag.
- `/organize off` / `on` — toggle active-items injection for your session.

All writes go through agent tools (not slash subcommands) so the audit log and privacy filter stay singular.

### Google Calendar integration

For `type=event`, Jarvis creates the actual Google Calendar event alongside the local file. Update the item (title, time, location, attendees) → the calendar event is patched. Delete the item → the calendar event is deleted. Complete the item → the calendar event is untouched (the event happened; you're just noting it's done).

`/calendar off` in your chat blocks GCal sync completely — `organize_create type=event` will refuse until you `/calendar on`, and updates/deletes to existing events happen locally-only with a warning that the GCal side is stale.

### Privacy

Narrower than memory on purpose — fitness goals work but disease-specific terms don't persist:

- ✅ "Lose 10 lbs by summer" / "30 min yoga M/W/F" / "drink more water" / "stretch daily" / "7 hours sleep target" — all pass.
- ❌ "Schedule chemo Tuesday" / "refill Adderall" / "diabetes check-up" / "depression workout plan" — all reject. The reject list is DOMINANT: if a disease term is anywhere in the text, the field is rejected (no "but I added workout at the end" bypass).

Phone numbers, credentials, credit cards, SSNs, long opaque tokens — same rejections as memory.

Rejection reasons name the CATEGORY ("contains disease/prescription terms"), never the matched word — so your audit log never echoes health data.

### Limits

- 500 chars per title, 5000 per notes body, 500 per progress entry, 40 per tag, 10 tags per item.
- 200 active items per user; the 201st create returns `ACTIVE_CAP_EXCEEDED` — complete or delete some first.
- Active-items block in the agent's context shows up to 15 items (5 goals pinned + 10 earliest-due non-goals; `_(+N more)_` footer when exceeded).

### Audit trail

Every organize operation lands in `audit_log` with a category like `organize.create` / `organize.update` / `organize.inconsistency` (the last one records cross-system orphan conditions so `/audit` can surface them). Raw titles/notes/tags NEVER appear in audit detail — structural fields only (id, type, result, reason-category, fieldsChanged).

### Known gaps (filed for future iterations)

- **Scheduled tasks cannot use `/organize`** — scheduler turns have no userId, so tools return `NO_USER_ID`. "8am daily: list my tasks" fails every fire. Fix requires plumbing `owner_user_id` through the scheduler.
- **No Telegram Web App UI yet** — Phase 2 will add a Kanban board / goal progress bars / calendar view. The data model is ready for it.
- **No recurring items** ("remind me weekly to X") — deferred.
- **`.trash/` has no TTL** — soft-deletes accumulate until you clean them up manually.

### v1.14.5 — Picker tier complete

**Reparent items.** Open a task or event → ✏️ Edit → new "Parent goal" dropdown shows your active goals. Pick one to nest the item under it; pick "(none)" to make it standalone. Goals can't have parents (structural invariant). Reparenting respects the same conflict detection as other edits.

**Cross-tab sync.** Open the webapp in two tabs/devices. Save a change in one → the other tab knows. If the other tab is mid-edit on the same item, you get a Reload prompt; otherwise it silently refreshes. Falls back gracefully if your browser doesn't support BroadcastChannel.

**Trash listing.** `/organize trash list` in chat shows up to 50 deleted items sorted by delete date with their ids. `/organize trash list 50` shows the next page. Pair with `/organize restore <id>` for recovery.

### v1.14.6 — Multi-select bulk + create form

**Multi-select.** Tap "Select" in the header → checkboxes appear on each card (tasks, events, and goals alike, including abandoned items). Tap cards to select; the header bar updates with the running count. Tap Cancel (or press Escape) to exit without changes. Selecting an item no longer navigates to the detail panel — navigation only happens outside select mode.

**Bulk safety.** Deleting more than 50 items at once requires typing "DELETE" into a confirmation field before the request is sent — no native browser dialogs are used. Below that threshold a two-tap confirmation (6 s window) is required. Bulk re-parent sends a per-item `If-Match` header so stale overwrites are caught; bulk complete and bulk delete use intent-clear / absolute-write semantics and omit it. Up to 10 requests run concurrently; partial failures are surfaced with a per-count toast (succeeded / failed / 412-stale breakdown). Succeeded items are deselected automatically; failed items remain selected for retry.

**Create from webapp.** Tap "+ New" in the header → inline form slides in. Choose the item type (Task / Event / Goal), fill in title, optional due date, tags, notes, and progress. Goals hide the parent-goal picker (goals can't be nested). Character counters track the 500-char title, 10 240-char notes, and 20 480-char progress limits. A 30-second AbortController timeout guards against iOS-backgrounded stalls. Double-submit is blocked at the JS level and by disabling the button for the duration of the request. Select mode and the create form are mutually exclusive — opening one closes the other.

### v1.15.0 — Kanban, Calendar, multi-bot BroadcastChannel

**Kanban view.** Tap "Kanban" in the header view-switcher. Each active goal gets a vertical column; orphan tasks/events that have no parent goal land in a "Standalone" column at the right. Tap a task card to pick it up (visual highlight + cursor changes); tap a column header or card list to drop it — reparenting fires a `PATCH` with `If-Match` in the background. If the item changed on another device while you were dragging, a 412 conflict rolls back the move and shows an inline toast. HTML5 drag-and-drop works on desktop in parallel. A first-entry tutorial toast appears once per session (sessionStorage-gated, 8 seconds, tap-to-dismiss).

**Calendar view.** Tap "Calendar" to enter the calendar. Three subviews: Month (default), Week, and Day — toggle with the chips at the top. Navigation arrows step backward/forward by month, week, or day respectively; "Today" snaps back. Items render as pills on their due date. Drag a pill to a new cell to reschedule — fires a `PATCH { due: "YYYY-MM-DD" }` with `If-Match`. Drop on the same day is a no-op. If a cross-month 412 conflict occurs (the server's current due date is in a different month than where you dragged), an inline conflict banner shows the item's title and a "View item" button that navigates to the correct month and pulses the target cell.

**View persistence.** The selected view (list, kanban, calendar) and calendar subview persist across tab refreshes via sessionStorage with a strict-equal whitelist guard — injection probes (`__proto__`, mixed-case, NUL bytes) all fall back to the default safely.

**Multi-bot BroadcastChannel.** `GET /api/webapp/config` (new endpoint) returns the per-bot BroadcastChannel name so multiple Jarvis bots on the same device don't cross-pollinate each other's live-update events. Falls back to the hardcoded `organize-mutations-jarvis` if the server doesn't have the endpoint (older deployment).

**Module split.** `app.js` was split into `list-view.js`, `edit-form.js`, `dates.js`, `kanban-view.js`, and `calendar-view.js` — all vanilla ES modules with no bundler, keeping the strict CSP (`script-src 'self' https://telegram.org`) intact. The `dates.js` module is UTC-only: all calendar-date arithmetic uses `Date.UTC` constructors and `getUTC*` accessors so DST transitions never shift a "2026-03-08" due date to March 7 in your timezone.

---

## Group Chat Mode (v1.3)

Jarvis can participate in Telegram group chats with guardrails. Off by default.

### How to enable

1. **Find the group's chat ID**: Add @userinfobot or @getidsbot to the group, or forward a group message to @userinfobot. The chat ID is a negative integer like `-1001234567890`.

2. **Add your user ID as admin** (to use `/jarvis_enable` etc.): Your Telegram user ID from @userinfobot.

3. **Edit `config/config.json`**:
```json
{
  "groups": {
    "enabled": true,
    "allowedGroupIds": [-1001234567890],
    "adminUserIds": [YOUR_TELEGRAM_USER_ID],
    "rateLimitPerUser": 10,
    "rateLimitWindowMinutes": 60,
    "maxResponseLength": 2000,
    "disabledTools": ["run_command", "write_file", "system_info"]
  }
}
```

4. Restart Jarvis.

### Activation rules (v1.7.13 layered gate)

Jarvis decides whether to reply in a group through five layers, first match wins:

1. **Preflight** — `groups.enabled`, chat in `allowedGroupIds`, group not disabled via `/jarvis_disable`. Fail any → silent.
2. **Pending confirmation** — if Jarvis just asked "were you talking to me?", this message from that same user is interpreted as yes/no. Yes → run the original stashed text. No → silent.
3. **Fast deterministic** — message contains "jarvis" (case-insensitive) OR is a reply to Jarvis's own message → proceed.
4. **Follow-up heuristic** *(v1.7.13, free)* — Jarvis replied to THIS user within 120s → proceed silently. A natural "thanks, can you also..." works without mentioning him again. Different users inside the window still need the keyword or classifier (no bystander activation).
5. **LLM intent classifier** *(v1.7.13, paid)* — cheap Ollama Cloud call (`gemma4:cloud` by default) with the last few messages for context. Returns `{addressed, confidence}`:
   - `high` → proceed
   - `medium` → Jarvis posts "@X were you talking to me?" and waits for your next message (yes/no/explicit mention)
   - `low` or not addressed → silent

Ties go silent. Barging into a human conversation is worse than missing a request.

### Configuring intent detection

```json
"groups": {
  "intentDetection": {
    "enabled": true,
    "provider": "ollama-cloud",
    "model": "gemma4:cloud",
    "followUpWindowSeconds": 120,
    "confirmationTtlSeconds": 120,
    "rateLimitPerMinute": 30,
    "recentMessageContext": 4
  }
}
```

Per-chat override: `/jarvis_intent on|off` in the group. Off disables only the classifier path (and the confirm prompt it drives) — keyword / reply / follow-up still activate as before.

### Addressing rule

Jarvis always prefixes group replies with `@FirstName:` naming the asker, and the system prompt tells the model to answer in second person ("you"), never greet other participants by name, and never invent names for other people in the group. No more "Hi Kim, here's your calendar" when Boss was the one asking.

### Guardrails (always on in group mode)

| Guardrail | Value |
|-----------|-------|
| Disabled tools | `run_command`, `write_file`, `system_info` (configurable) |
| Max response length | 2000 chars (truncated with `…`) |
| Rate limit | 10 messages / 60 min per user (configurable) |
| Output scrubbing | Paths, hostname, username redacted in addition to secrets |
| Destructive commands | Disabled via disabledTools (confirmation flow is DM-only) |
| `/model` command | Admin-only in groups |

### Admin commands (group only)

| Command | Action |
|---------|--------|
| `/jarvis_enable` | Enable Jarvis in this group (persisted to DB) |
| `/jarvis_disable` | Disable Jarvis in this group |
| `/jarvis_users` | Show per-user message and token stats |
| `/jarvis_limit <user_id> <n>` | Set per-user rate limit override (0 = use default) |

All admin commands require your user ID in `groups.adminUserIds`. Non-admins get "Admin only." with no other information.

### What stays the same in DM

All DM behaviour is unchanged. Group mode is purely additive — if `groups.enabled: false` or the chat isn't in `allowedGroupIds`, all new code paths are no-ops.

---

## Security Model Summary

| Layer | Mechanism |
|-------|-----------|
| **Single-user allowlist** | Only messages from `telegram.allowedUserIds` are processed; all others silently dropped |
| **Path sandbox** | All file ops restricted to `filesystem.allowedPaths`; realpath + NFC normalization + separator-boundary check defeats traversal attacks |
| **Read denylist** | `.env`, `.env.*`, `*.pem`, `*.key`, `**/id_rsa`, `**/credentials*.json`, `logs/**`, `data/**` blocked even within allowed paths |
| **Write denylist** | `.env*`, `*.pem`, `*.db`, `*.sqlite`, `data/**`, `logs/**`, `.ssh/**`, `.aws/**` blocked for writes |
| **Command blocklist** | Pattern-matched list of destructive commands; action is `confirm` (requires YES reply) or `block` (hard reject) |
| **Destructive confirmation** | Dangerous commands enter a 5-minute confirmation window; user must reply YES; any other response cancels |
| **Output scrubber** | All tool outputs are scanned for secrets (`sk-ant-`, `AKIA`, `sk-`, PEM blocks, hex token patterns) before returning to Claude or the user |
| **No inbound network** | Gateway uses Telegram long-polling (outbound only); health endpoint bound to `127.0.0.1` only |
| **Secrets in .env only** | API keys are never in `config.json` or source — `ENV:VAR_NAME` syntax resolves at boot |

---

## How Compaction Works (v1.4.1)

When the conversation context reaches 75% of the model's context window, Jarvis automatically compacts it: the full message history is summarised by the current model, the original messages are archived to SQLite (`conversation_archive` table), and a single synthetic summary message replaces them. No data is ever discarded.

**Lossless recall (v1.4.1):** The summary message is tagged with the message-id range it covers and the archive row id — e.g. `[Prior conversation summary · messages 42-187 · archive #2]`. If you later reference something the summary glossed over (a file path, a command, a specific decision), Jarvis automatically calls the `recall_archive` tool to search the full pre-compaction history in SQLite and retrieve the relevant snippets before responding. From your perspective, compaction is lossless — details are always recoverable.

You can also trigger compaction manually with `/compact`.

---

## Architecture Overview

See `docs/ARCHITECTURE.md` for the full design. In brief:

```
Telegram (phone) ──outbound polling──► grammY Bot (gateway)
                                           │
                                    allowlist check
                                           │
                                    per-chat queue
                                           │
                              ┌────────────┴────────────┐
                         /commands              free-form text/voice
                              │                         │
                         command router          Transcriber (voice→text)
                                                         │
                                                   Agent (Claude API)
                                                   ReAct loop
                                                         │
                                                   Tool Dispatcher
                                                   ┌────┴────┐
                                             Safety checks  Memory (SQLite)
                                                         │
                                                   Tool execute
                                                   (shell/file/sys)
```

Single Node.js process. SQLite for all persistence. No inbound ports except `127.0.0.1:7878` health check.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Bot doesn't respond | Check `pm2 logs jarvis` — likely a missing env var or bad token |
| "Access denied" on file op | Add the path to `filesystem.allowedPaths` in `config.json` |
| "Command requires confirmation" | Reply `YES` (all caps) within 5 minutes to proceed |
| "Command blocked" | The command is in the hard-block list — rephrase or remove the pattern from config |
| High memory usage | Check `pm2 monit` — `max_memory_restart` is set to 400MB and will auto-restart |
| Voice transcription fails | Check `OPENAI_API_KEY` is set and valid; verify Whisper API is reachable |
| SQLite experimental warning | Expected on Node 20 — harmless; uses `better-sqlite3` fallback automatically |
| `system-prompt.md` missing | Restore `config/system-prompt.md` from git: `git checkout HEAD -- config/system-prompt.md` |

---

## Telegram Web App (v1.13.0)

Jarvis ships a foundation for Telegram Mini Apps as of v1.13.0 — a vanilla
HTML/JS skeleton served from your local Express server, exposed via cloudflared
during development. v1.13.0 ships ONLY the platform plumbing (HMAC-verified
auth, static serving, rate limiting, audit). The actual feature UI (organize
Kanban, etc.) lands in v1.14.0+.

### Quick start (development with cloudflared)

1. Install cloudflared: https://github.com/cloudflare/cloudflared/releases
2. With Jarvis running on pm2, in a separate terminal:
   ```bash
   cloudflared tunnel --url http://localhost:7879
   ```
3. Copy the `https://<random>.trycloudflare.com` URL cloudflared prints.
4. Edit `config/config.json`:
   ```json
   "webapp": {
     "publicUrl": "https://<random>.trycloudflare.com",
     "port": 7879
   }
   ```
5. Restart Jarvis: `npx pm2 restart jarvis --update-env`
6. DM `/webapp` and tap the button.

### Production hosting

For stable URLs, point a real domain at the gateway (cloudflared `trycloudflare.com`
URLs rotate on every restart). Real-domain migration: terminate TLS at a reverse
proxy (cloudflared named tunnel, nginx + Let's Encrypt, Caddy, etc.) that forwards
HTTPS to `http://localhost:7879`. The Express server stays bound to 127.0.0.1
in all hosting modes (security invariant — see ADR 008 R3).

### Loopback-only invariant

The Web App Express server binds 127.0.0.1 ONLY. The HTTPS tunnel/proxy
terminates TLS in front and forwards to the loopback. NEVER bind 0.0.0.0:
that would expose the unauthenticated `/webapp/*` static routes (and any
future `/api/webapp/*` routes) directly to your host's LAN, bypassing
the tunnel's CSP, rate limit, and audit chokepoints.

### v1.14.0 — Organize Web App

`/organize` items now have a Web App view at `/webapp/organize/`. After running `/webapp` and tapping **🚀 Open**, the hub page shows a `📋 Organize` button — tap it for the read-only items view.

**What you get:**
- Filter chips: type (All / Tasks / Events / Goals) and status (Active / Done / All).
- List view with type icon, title, status badge, due date, tags.
- Tap an item → detail view (full notes + progress entries).
- Filter selections persist within the same webview session.

**What's not yet:**
- Read-only — no create-from-webapp. Notes/progress editing is via Telegram chat for now.
- No drag-drop or calendar grid (added in v1.15.0).
- No multi-select (added in v1.14.2).

**Security note:** the `/api/webapp/items*` endpoints use a tighter 1h `auth_date` window (vs. the 24h echo window) because they expose user-authored task titles. Configure via `webapp.itemsInitDataMaxAgeSeconds` if needed.

### v1.14.2 — Mutations

**Edit a task:** Tap the item → tap ✏️ Edit → change title/due/status/tags → tap Save.
**Complete a task:** Tap the ⭕ circle on the card. It flips to ✅. Tap again to uncheck.
**Delete a task:** Open the item → tap 🗑 Delete → tap again within 6 seconds to confirm.

Notes/progress editing is via Telegram chat for now (markdown editing in the webapp is a v1.14.x design topic). Restore a deleted item from chat: `/organize restore <id>`.

Concurrent edits across devices: v1.14.2 introduced stale-edit detection. v1.14.4 replaces it with proper If-Match / 412 conflict resolution (see below).

### v1.14.4 — Conflict resolution

**Concurrent edit detection.** When you save an edit, Jarvis checks whether the item changed underneath you (e.g., you edited the same task on your phone, or Jarvis updated the progress log via chat). If it did, you'll see an inline conflict prompt: **Reload** to see the latest version (drops your unsaved edits), **Save anyway** to overwrite (logged in the audit trail), or **Cancel** to keep the current view and decide later.

**Same UX for delete.** When you delete an item that's changed since you opened it, you'll see Cancel + Delete anyway. Reload doesn't apply (you're trying to delete, not view).

**Backwards compatible.** If your client (e.g., a future API integration) doesn't send the `If-Match` header, conflict checking is bypassed silently — last-writer-wins. The webapp client always sends it.

### v1.14.3 — Notes/Progress + Hierarchy

**Edit notes & progress:** Tap an item → ✏️ Edit. New "Notes" and "Progress" textareas at the bottom of the edit form. Save sends only changed fields. Character counter turns orange at 80% capacity (10K notes, 20K progress). Removing 4+ progress lines triggers an inline "Tap again to confirm" prompt before saving — no data lost by accident.

**Hierarchical view:** Tasks and events with a goal `parentId` now render indented under their goal, with a tap chevron to collapse/expand. Items without a goal parent render at top level. Collapsed state persists during the session via sessionStorage. Goals are always top-level; goal-with-parent is rejected at create time.

**Restore deleted items:** `/organize restore <id>` brings a soft-deleted item back from trash. Smart 404 suggests close-id matches if you typo the id. After 30 days the trash evictor purges it permanently — restore replies with the eviction date if you ask too late.

**Body cap note:** The PATCH body cap is 32 KB (raised from 1 KB). A 10 240-char CJK notes field is up to ~30 KB UTF-8; if you also have a large progress field, split saves into separate requests (notes first, progress second).

### v1.17.0 — Power-user toolkit

**Cron builder.** `/webapp` → tap "🕐 Cron" → create/edit scheduled tasks. Visual builder for common patterns (every X minutes, daily, weekly), or raw cron string for custom. Live preview shows next 5 fire times.

**Memory browser.** `/webapp` → tap "🧠 Memory" → see what Jarvis remembers about you. Edit individual entries; create new keyed memory; delete obsolete entries. Concurrent-edit protection via 412/ETag.

**Audit log.** `/webapp` → tap "📜 Audit" → searchable read-only view of your action history. Filter by category and time range; tap a row for full detail.

---

### v1.16.0 — Live debate viewer + markdown rendering

**Live debate.** `/webapp` → tap "🤔 Debate" → see your debate history. Open a running debate → side-by-side debater columns stream new rounds as they complete via Server-Sent Events. Past debates show full transcripts + verdict.

**Markdown rendering.** Notes and progress in `/organize` detail view now render as Markdown (headings, bold, italic, code, lists, links). Edit form stays as raw text — write Markdown, see it rendered.

**3-way diff for conflicts.** When you edit notes/progress and hit a 412 conflict (concurrent edit), instead of just "Reload or Save anyway," you see a 3-way diff: your changes vs server's current vs the original baseline. Take Mine / Take Theirs / Save Manually-Merged buttons.

---

## Known Limitations

### Zombie panel after pm2 restart mid-debate (v1.12.0)

If Jarvis is restarted via pm2 while a `/debate` is running, the in-memory panel
state is lost along with the async orchestration loop. The panel message persists
in the chat showing its last-rendered state (e.g. "Round 2/3 · Model X speaking...")
until the user taps a button — at which point they see a "Panel expired — please
re-run /debate" toast and the buttons are stripped. The stale text itself stays
until the user re-runs /debate. Documented in ADR 007 R14.

---

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `TELEGRAM_BOT_TOKEN` | Yes | — | Telegram bot token from @BotFather |
| `ANTHROPIC_API_KEY` | Yes | — | Claude API key |
| `OPENAI_API_KEY` | Yes | — | OpenAI Whisper API key |
| `CONFIG_PATH` | No | `./config/config.json` | Override config file location |
| `LOG_LEVEL` | No | `info` | Pino log level |
| `NODE_ENV` | No | `production` | Node environment |
