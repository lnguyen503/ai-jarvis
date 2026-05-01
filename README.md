# Jarvis — A Personal AI Assistant

> A Telegram-fronted AI assistant that runs on your machine. Reads your files, browses the web, manages your calendar, runs scheduled tasks, and (optionally) coordinates a multi-bot persona ensemble for adversarial-review work.
>
> **Status:** personal learning project / portfolio piece. Not a SaaS product. Not actively maintained for external users. Read [Honest Positioning](#honest-positioning) before adopting.

---

## ⚠️ Before You Use the "Avengers" Theme

The default repo ships with persona files and avatar assets themed around **Marvel characters** (Iron Man, Black Widow, Hulk, Avengers). These are **trademarks of Marvel/Disney**. They are fine to use locally for personal entertainment but are **not safe to distribute, deploy publicly, or fork verbatim**.

If you're forking this for your own public use, before you push:

1. Rename the project (e.g. `Sidekick`, `OwnAssistant`, `Hearthbot` — pick something not trademarked).
2. Replace persona files in `config/personas/` with your own theme (or keep them generic — `assistant`, `engineer`, `researcher`, `analyst`).
3. Generate your own avatars (or omit them).
4. Update display names in `src/config/botIdentity.ts` (`BOT_NAMES`, `BOT_TELEGRAM_USERNAMES`, `BOT_DOMAINS`).

The codebase itself is generic — only persona text + avatar PNGs carry the IP risk.

---

## Honest Positioning

This is a **personal-OpenClaw-style clone**, built solo as a learning project. If you want a polished, actively-maintained personal AI assistant with this feature set, look at:

- **[OpenClaw](https://openclaw.ai)** by Peter Steinberger — open-source, multi-platform (Telegram, WhatsApp, Slack, Discord, Signal, iMessage), 50+ skills, active community. The mature alternative.
- **[Claude Cowork / Claude.ai](https://claude.ai)** — hosted by Anthropic, ships Schedule + Files + MCP, single-user productivity focus. Easier to set up, no maintenance burden.

Jarvis converged independently on most of OpenClaw's architectural choices (local-first, channel adapter, persistent SQLite memory, scheduled tasks, model routing, browser automation, MCP). It's a working personal-use system but it has fewer integrations, fewer chat platforms, and no community of skill-contributors. Use it if you want to **learn how this kind of system is built**, not if you want a finished tool.

What Jarvis does have that's worth examining:

- **Coach** — a proactive scheduler that DMs nudges to your phone based on your `/organize` items, intensity profiles, and event triggers. Closer to a "patient counselor" than a passive task list.
- **Multi-bot persona ensemble** — separate Telegram bot accounts that can delegate to each other and produce a synthesized HTML deliverable. Useful for adversarial-review patterns (more than for daily productivity).
- **Per-bot data isolation** — each bot's DB, sandbox, and tool allowlist are separate processes. Cleaner than running one bot with multiple personas.

---

## What it does

- **Telegram bot** — DM or group, voice-message in (Whisper transcription), text out (with optional TTS reply)
- **Tools** — read/write files, run shell commands (path-sandboxed), search/browse the web, search Gmail, read/write calendar, send files
- **Memory** — persistent per-user facts; you say "remember X", it sticks across chats
- **Scheduled tasks** — cron-style; coach nudges, daily briefings, recurring reminders
- **`/organize`** — task list with goal hierarchy, due dates, kanban + calendar webapp views
- **Model routing** — defaults to Ollama Cloud (cheap subscription); falls back to Claude on errors with loud notification
- **Multi-bot ensemble (optional)** — 4 specialized bots that can delegate to each other and produce HTML deliverables
- **MCP integration** — Anthropic Model Context Protocol; ships with `context7` docs-lookup wired

---

## Architecture (high level)

```
                   ┌──────────────────────────────────────┐
                   │  Telegram (DM + group chats)         │
                   └──────────────────┬───────────────────┘
                                      │ long-poll
                          ┌───────────┴───────────┐
                          │  grammY bot adapter   │
                          └───────────┬───────────┘
                                      │
              ┌───────────────────────┼───────────────────────┐
              ▼                       ▼                       ▼
      ┌───────────────┐      ┌────────────────┐      ┌────────────────┐
      │ Group gate +  │      │  Agent loop    │      │  Webapp        │
      │ mention router│ ───▶ │  (ReAct-style) │      │  (Express)     │
      └───────────────┘      └───────┬────────┘      └────────────────┘
                                     │
                          ┌──────────┼──────────┐
                          ▼          ▼          ▼
                    ┌──────────┐ ┌────────┐ ┌──────────┐
                    │  Tools   │ │  LLM   │ │ Memory   │
                    │ (closed  │ │ router │ │ (SQLite) │
                    │   set)   │ │        │ │          │
                    └──────────┘ └────────┘ └──────────┘
                                     │
                              ┌──────┴───────┐
                              ▼              ▼
                     ┌──────────────┐ ┌────────────────┐
                     │ Ollama Cloud │ │ Anthropic API  │
                     │  (default)   │ │  (fallback)    │
                     └──────────────┘ └────────────────┘
```

- **Single-bot mode**: one PM2 process, one Telegram bot, one SQLite DB.
- **Multi-bot mode (Avengers)**: 4 PM2 processes sharing the same `dist/index.js`. Each loads a different `BOT_NAME` env var and selects its own persona, data dir, tool allowlist, ports.
- **Per-bot data isolation**: `data/<bot-name>/jarvis.db` — specialists cannot read each other's DBs or each other's user memory files.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for more depth.

---

## Quick start (single-bot, ~15 minutes)

This walks you from a fresh clone to a working Telegram bot you can DM. The single-bot path is the simplest; the Avengers ensemble is in the next section.

### Prerequisites

- **Node.js 20+** — verify with `node --version`
- **A Telegram account**
- **An [Anthropic API key](https://console.anthropic.com)** — used as fallback when local models fail, and for vision/image input
- **An [Ollama Cloud](https://ollama.com) API key** — primary model provider (subscription-based, no per-token cost)
- *(Optional)* An [OpenAI API key](https://platform.openai.com) — required only if you want voice-message transcription (Whisper)
- *(Optional)* A [Tavily API key](https://tavily.com) — required only if you want the `/search` command and `web_search` tool
- *(Optional)* Google OAuth desktop credentials — required only if you want Gmail / Calendar integration

### 1. Clone and install

```bash
git clone https://github.com/<your-account>/<your-repo>.git
cd <your-repo>
npm install
```

### 2. Create your Telegram bot

Open `@BotFather` in Telegram and send `/newbot`. Pick a display name and a username. Save the token it returns — you'll paste it into `.env` in the next step.

*(Optional polish: `/setuserpic` to upload an avatar (`assets/jarvis-avatar.png` for the generic monogram, or `assets/avengers/jarvis.png` for the Marvel-themed one), `/setdescription` for the about text. See [`docs/BOTFATHER_SETUP.md`](docs/BOTFATHER_SETUP.md).)*

> **IP note on the Marvel-themed avatars.** `assets/avengers/jarvis.png`, `tony.png`, `natasha.png`, and `bruce.png` are stylized renders of Iron Man / Black Widow / Hulk likenesses. Marvel and the Avengers are trademarks of Marvel/Disney. They are fine for personal use on a private bot. If you intend to make your bot public, generate your own avatars instead.

### 3. Configure secrets (`.env`)

```bash
cp .env.example .env
```

Edit `.env` and fill in the values you have. At minimum:

```bash
TELEGRAM_BOT_TOKEN=<your bot token from BotFather>
BOT_TOKEN_AI_JARVIS=<same value as TELEGRAM_BOT_TOKEN — used by the multi-bot loader>
ANTHROPIC_API_KEY=sk-ant-…
OLLAMA_API_KEY=<from ollama.com>
```

The other keys (`OPENAI_API_KEY`, `TAVILY_API_KEY`, `GOOGLE_OAUTH_*`) gate optional features — you can leave them blank and add them later.

### 4. Configure the agent (`config/config.json`)

```bash
cp config/config.example.json config/config.json
```

Edit `config/config.json` — at minimum:

- **`telegram.allowedUserIds`** — your Telegram numeric user ID (DM `@userinfobot` to find it). Only this ID can talk to the bot in DM.
- **`filesystem.allowedPaths`** — directories Jarvis is allowed to read/write. Add the project root and any project folders you want it to touch. Anything outside this list is blocked by the path sandbox.
- **`groups.adminUserIds`** — same numeric user ID as above, if you intend to use the bot in groups.
- **`webapp.publicUrl`** — your public HTTPS URL if you want the webapp dashboard accessible from your phone (use [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) or [ngrok](https://ngrok.com)). Leave blank if you don't need the webapp from outside localhost.

`config.json` is **not** committed to git (it's in `.gitignore`); the example file is what ships in the repo.

### 5. (Optional) Customize the persona

The default persona files in `config/personas/` are themed around the Marvel "Avengers" cast and address the operator as `Boss`. If you don't like that:

- Edit `config/personas/ai-jarvis.md` to your taste — change the name, voice, owner-address, in-character backstory.
- Search-and-replace `Boss` to whatever name you want the bot to call you (e.g. your first name).
- For the multi-bot setup, do the same in `ai-tony.md`, `ai-natasha.md`, `ai-bruce.md`, and `ai-jarvis-critic.md`.

The default persona will work without any changes — these are just text files Jarvis loads as its system prompt.

### 6. Build and start

```bash
npm run build
node dist/index.js
```

DM your bot in Telegram and send `hi`. You should get a reply within a few seconds.

For a long-running setup (always-on, auto-restart on crash):

```bash
npm install -g pm2
npx pm2 start ecosystem.config.cjs --only ai-jarvis
npx pm2 save
```

`--only ai-jarvis` runs just the orchestrator. Drop the flag to run all four bots if you also configured the ensemble (next section).

### 7. (Optional) Verify the install

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest
```

The test suite includes static lint-style invariants (closed-set assertions, audit-category coverage, no-stub wiring checks). All tests should pass on a fresh clone.

---

## Adding more bots (the Avengers ensemble)

If you want the multi-bot ensemble (one orchestrator + 3 specialists who delegate to each other):

1. Create 3 more bots in `@BotFather`, each with their own token.
2. Add `BOT_TOKEN_AI_TONY`, `BOT_TOKEN_AI_NATASHA`, `BOT_TOKEN_AI_BRUCE` to `.env`.
3. Update `BOT_TELEGRAM_USERNAMES` in `src/config/botIdentity.ts` with each bot's `@username` (the values that ship are placeholders — `your_jarvis_bot`, `your_tony_bot`, etc.).
4. Update `BOT_ALIASES_BY_NAME` in the same file if you want natural-language aliases (default: `jarvis`, `tony`, `natasha`, `bruce`).
5. Customize personas in `config/personas/<bot-name>.md` (or keep the defaults and accept the IP warning above).
6. *(Optional)* Set per-bot avatars in `@BotFather` via `/setuserpic` for each bot — the four matching PNGs ship in `assets/avengers/` (`jarvis.png`, `tony.png`, `natasha.png`, `bruce.png`). See the IP note in the single-bot section before using these on a public bot.
7. `npm run build && npx pm2 reload ecosystem.config.cjs`
8. Invite all 4 bots into a Telegram group, promote them to admin (with "Pin Messages" permission).
9. In the group: `/avengers assemble on`.

See [`docs/AVENGERS.md`](docs/AVENGERS.md) for the full architecture + operating guide.

### How the ensemble actually responds

There are **two distinct prompt shapes** and they produce different behavior. Knowing which is which prevents the most common UX confusion:

**Casual prompt** — addressing the team without a per-specialist breakdown:

> "Avengers, what's a good name for a side project?"
> "Hi avengers, jokes only — funniest comedian alive?"

The orchestrator answers, and specialists may chime in (subject to a tight peer-bot turn cap when no plan is active). **No plan is created. No deliverable.** This is banter mode.

**Task prompt** — addressing the team WITH a per-specialist breakdown using a directive separator:

> "Avengers, audit the repo for github readiness.
>  **Tony —** check src/ for hardcoded secrets and missing setup docs.
>  **Natasha —** find 2 comparable open-source assistants on GitHub.
>  **Bruce —** score the repo 0-10 on docs / security / tests."

The orchestrator detects the explicit names with directive separators (`—` / `-` / `:` / `,`), delegates to each specialist in parallel, creates a plan with a live TODO message at the top of the chat, runs each specialist's reply through an optional 3-round critic debate (`/avengers debate on`), and finally compiles a one-page HTML deliverable that gets uploaded to the chat.

**To trigger task mode**, you must (a) have `/avengers assemble on` for the chat AND (b) name 2+ specialists with a directive separator. Anything else is casual mode.

### Useful chat commands

| Command | What it does |
|---|---|
| `/avengers status` | Show current chat/assemble/debate flag state |
| `/avengers assemble on\|off` | Toggle task-execution mode (orchestrator coordinates the team) |
| `/avengers chat on\|off` | Toggle free-form chat mode (specialists may chime in on banter) |
| `/avengers debate on\|off` | Toggle adversarial-review debate (specialists vs Jarvis-as-critic, ≤3 rounds, slower) |
| `/avengers reset` | Break in-progress chatter; tell specialists no task is active. Useful if a previous task left them looping. |

---

## Optional features

| Feature | Setup |
|---|---|
| **Google Calendar two-way sync** | OAuth 2.0 desktop app via Google Cloud Console; run `npm run google-auth`. See [`docs/INTERNAL.md`](docs/INTERNAL.md). |
| **Gmail (read + draft)** | Same OAuth flow as Calendar; gated on `google.gmail.enabled` in config. |
| **Voice messages** | Add `OPENAI_API_KEY`; flips Whisper transcription on. TTS replies via `tts.enabled`. |
| **Image input** | Vision API auto-engages when you send an image to Jarvis. Uses Claude (premium). |
| **Web search** | [Tavily](https://tavily.com) API key in `.env` as `TAVILY_API_KEY`; flips `tavily.enabled`. |
| **Browser automation** | Playwright; one-time `npx playwright install chromium`. Tools: `browse_url`. |
| **MCP servers** | Add to `config/config.json` `mcp.servers`. Ships with `context7` docs lookup. |
| **`/research`, `/plan`, `/fix`, `/build`** | Multi-step skill executors that run a research/plan/fix/build loop with progress panels. |
| **`/debate`** | Multi-model adversarial debate on a question; useful for accuracy. |
| **`/coach`** | Proactive nudge scheduler that DMs you based on your `/organize` items + intensity profile. |
| **Webapp UI** | Hub at `https://<your-publicUrl>/webapp/` — tabs for Organize, Calendar, Memory, Audit, Avengers Operations Dashboard. |

---

## Project layout

```
src/
  agent/          # ReAct loop, system prompt builder, compaction
  avengers/       # Multi-bot plan tracker + lifecycle + HTML deliverable renderer
  channels/       # (Future) cross-platform messaging adapters; currently Telegram only
  coach/          # Coach Jarvis: scheduled nudges, intensity profiles, event triggers
  commands/       # Slash command handlers
  config/         # Config schema (Zod), bot identity resolver
  gateway/        # Telegram I/O, group activation, mention routing, loop protection
  memory/         # SQLite repos (sessions, messages, plans, audit, etc.) + migrations
  messaging/      # Platform-neutral MessagingAdapter interface (Telegram impl shipped)
  organize/       # Task list + reminders cron
  plan/           # /research multi-step executor
  providers/      # Anthropic + Ollama Cloud client adapters
  router/         # Model routing (keyword + per-session pin)
  safety/         # Path sandbox, role resolution, group scrubber
  scheduler/      # Cron registry (organize reminders, coach fires, scheduled tasks)
  tools/          # Closed-set tool registry (read_file, web_search, delegate_to_specialist, etc.)
  vision/         # Image transcription (Claude)
  webapp/         # Express HTTP server + REST routes + static page handlers
  index.ts        # Boot

public/webapp/    # Static webapp assets (HTML/CSS/JS, no bundler)
config/           # config.json + personas/<bot>.md + system-prompt.md
data/<bot-name>/  # SQLite + per-user memory + per-bot logs (gitignored)
docs/             # Architecture, anti-slop, ADRs, prompt-injection defense, etc.
ecosystem.config.cjs   # PM2 manifest (4 bots)
```

---

## Testing

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest
```

The `tests/static/` suite contains lint-style invariants: closed-set assertions, audit-category coverage, no-stub wiring checks. Useful sanity gates.

---

## Extending it (fork it, hack it, make it yours)

This is a personal project, but it is structured so you can extend it without rewriting the core. Some of the natural directions:

- **New webapps / dashboard tabs** — `public/webapp/` ships static HTML/CSS/JS with no bundler. Drop in a new folder (e.g. `public/webapp/myview/`), add an Express route in `src/webapp/`, and link it from the hub. The existing Organize, Calendar, Memory, and Avengers Operations tabs are templates you can copy.
- **New tools (agent capabilities)** — Add a file under `src/tools/`, register it in `src/tools/index.ts`, and document it in the persona's tool list. The closed-set test (`tests/static/`) will tell you what to wire.
- **New messaging platforms** — `src/messaging/MessagingAdapter` is platform-neutral. Implement it for WhatsApp/Slack/Discord/Signal/iMessage and the agent loop, memory, and tools work without other changes.
- **New slash commands** — Add a handler in `src/commands/`, register it in the gateway's command table.
- **New personas / bots** — Drop a `config/personas/<name>.md` file, add the bot name to `BOT_NAMES` in `src/config/botIdentity.ts`, set its token env var, and add a process block to `ecosystem.config.cjs`.
- **New skills (multi-step workflows)** — `/research`, `/fix`, `/build`, `/plan` live in `src/plan/` and `src/skill/`. Same pattern works for any agentic loop you want to add.

You don't need to ask permission. Fork, modify, ship. The MIT license means you're free to do whatever you want with it.

If you build something interesting, you don't have to upstream it — but PRs are welcome.

---

## Limitations / Design Choices

- **Telegram-only.** The `MessagingAdapter` interface is platform-neutral but only the Telegram implementation ships. Adding WhatsApp / Slack / Discord is a real exercise but not done.
- **Web App buttons don't work in supergroups.** Telegram restriction (private chats only). The Avengers dashboard opens in your default browser via a `url` button instead.
- **Local-first.** All your data lives in `data/<bot-name>/jarvis.db` on disk. No cloud sync. If you wipe your machine you lose your memory.
- **Ollama Cloud as primary, Claude as fallback.** Default. The fallback used to be silent and burn premium tokens; now it sends a loud throttled chat warning so you see when it fires.
- **No multi-machine fleet.** OpenClaw supports agent fleets across multiple machines; Jarvis is single-machine.
- **Windows-first.** The path sandbox uses Windows-style paths (`D:\…`) in the example config; Linux/macOS work but you'll need to adjust `filesystem.allowedPaths`. PM2 + cloudflared scripts in `scripts/` are PowerShell.

---

## Acknowledgments

Architecturally indebted to [**OpenClaw**](https://openclaw.ai) by Peter Steinberger — the larger, more mature, community-driven open-source personal AI assistant project. Jarvis converged on most of the same beats independently as a learning exercise; OpenClaw is the better choice if you want a polished, actively-developed assistant.

Built on:
- [grammY](https://grammy.dev) (Telegram bot framework)
- [Playwright](https://playwright.dev) (browser automation)
- [`@anthropic-ai/sdk`](https://github.com/anthropics/anthropic-sdk-typescript)
- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)
- Ollama Cloud + Anthropic API
- Vitest, ESLint, TypeScript

---

## License

[MIT](LICENSE). Edit the copyright line in `LICENSE` to put your real name in the `[Your Name]` placeholder before publishing.

---

## Development notes

- Internal-format reference (deep technical detail, build pipeline, audit trail conventions): [`docs/INTERNAL.md`](docs/INTERNAL.md)
- Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Avengers operating guide: [`docs/AVENGERS.md`](docs/AVENGERS.md)
- BotFather setup: [`docs/BOTFATHER_SETUP.md`](docs/BOTFATHER_SETUP.md)
- Anti-slop / quality conventions: [`docs/ANTI-SLOP.md`](docs/ANTI-SLOP.md)
- Prompt injection defense: [`docs/PROMPT_INJECTION_DEFENSE.md`](docs/PROMPT_INJECTION_DEFENSE.md)
- Module map / structure: [`docs/STRUCTURE.md`](docs/STRUCTURE.md)
- Original spec / requirements: [`SPEC.md`](SPEC.md), [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md), [`docs/SCOPE.md`](docs/SCOPE.md)
- Plan / Research / Fix / Build skill spec: [`docs/SPEC-PLAN-EXECUTE.md`](docs/SPEC-PLAN-EXECUTE.md)
- ADRs: [`docs/adr/`](docs/adr/)
