# Avengers — Multi-Bot Ensemble (v1.21.0)

> **This document is the canonical operator + user guide for the Avengers multi-bot feature.**
> See `docs/adr/021-v1.21.0-avengers-mvp.md` for the architectural decisions behind it.

---

## What is Avengers?

Avengers is the name for running **multiple Jarvis-family bots in the same Telegram chat**. Each bot is a specialist with its own personality, Telegram account, data directory, tool allowlist, and PM2 process. They can talk to each other via Telegram mentions, delegate tasks, and work in parallel.

**v1.21.0 ships with two bots:**

| Bot | Scope | Persona | Webapp port |
|-----|-------|---------|-------------|
| `ai-jarvis` | Full | Original Jarvis — orchestrator, Calendar, Gmail, organize, coach, shell | 7879 |
| `ai-tony` | Specialist | Engineering-focused, dry + decisive Tony Stark voice; no Calendar/Gmail/Coach | 7889 |

**Adding a 3rd bot (v1.22.0+)** is config-only — see [Adding More Bots](#adding-more-bots-v122x) below.

---

## Architecture Overview

```
Telegram group chat
        │
        ├── message @ai-jarvis → ai-jarvis process (BOT_NAME=ai-jarvis)
        │                        data/ai-jarvis/  |  port 7879
        │
        └── message @ai-tony  → ai-tony process  (BOT_NAME=ai-tony)
                                 data/ai-tony/   |  port 7889
```

- **Each bot is a separate PM2 process** running the same `dist/index.js` binary.
- `BOT_NAME` env var (set by `ecosystem.config.cjs`) selects the bot's identity at boot.
- **Per-bot data isolation:** each bot reads/writes only under `data/<botName>/`. The path-sandbox (ADR 021 D4) enforces this — ai-tony cannot read ai-jarvis's data directory, and vice versa.
- **Per-bot persona:** `config/personas/<botName>.md` is the system prompt. ai-jarvis uses its existing prompt; ai-tony has a fresh engineering-focused prompt.
- **Inter-bot routing:** bots watch for `@<self>` mentions and process only those. Messages not addressed to them are ignored.
- **Loop protection:** max 3 bot-to-bot turns per thread to prevent runaway chains.

---

## Setup Recipe (Step by Step)

### Prerequisites

- Node.js 20+ installed
- PM2 installed globally: `npm install -g pm2`
- ai-jarvis already set up and running (follow main README.md first)

### Step 1 — Create the ai-tony bot in BotFather

1. Open Telegram and message **@BotFather**.
2. Send `/newbot`.
3. Give it a display name (e.g. `AI Tony`) and a username (e.g. `ai_tony_bot`).
4. Copy the token BotFather gives you (looks like `7654321098:AABBcc…`).

### Step 2 — Add the token to .env

```bash
# .env (in D:\ai-jarvis)
BOT_TOKEN_AI_TONY=7654321098:AABBcc...your_tony_token_here
```

> Note: `BOT_TOKEN_AI_JARVIS` should already be set (it replaces the old `TELEGRAM_BOT_TOKEN` in v1.21.0). If not, add it too:
> ```
> BOT_TOKEN_AI_JARVIS=your_existing_jarvis_token_here
> ```

### Step 3 — Add config entries in config.json

The `config.json` must have ai-tony's Telegram user ID in the allowedUserIds list (so it can receive messages from group members) and its own botToken entry. Since both bots share the same config file in v1.21.0, the `telegram.botToken` is read from the env var via the `BOT_NAME` identity — no manual config.json edit required beyond the existing setup.

### Step 4 — Create the persona file for ai-tony

The file `config/personas/ai-tony.md` should already exist after the v1.21.0 build. If it doesn't, create it:

```bash
cp config/personas/ai-jarvis.md config/personas/ai-tony.md
# Then edit ai-tony.md to give Tony Stark's voice:
# - Dry, technical, engineering-focused
# - Short and decisive — no hedging
# - Lists tools it has AND tools it explicitly does not have (no Calendar, Gmail, Coach)
```

### Step 5 — Build and start the ensemble

```bash
npm run build
pm2 start ecosystem.config.cjs
pm2 save
```

PM2 starts two processes: `ai-jarvis` and `ai-tony`. Check status:

```bash
pm2 status
# Output:
# ┌───────────┬──────┬───────┬─────────┐
# │ name      │ mode │ status│ restart │
# ├───────────┼──────┼───────┼─────────┤
# │ ai-jarvis │ fork │ online│ 0       │
# │ ai-tony   │ fork │ online│ 0       │
# └───────────┴──────┴───────┴─────────┘
```

### Step 6 — Add both bots to your Telegram group

1. Open your Telegram group.
2. Add `@ai_tony_bot` (your ai-tony bot's username) to the group.
3. Give it admin permissions if needed (same as ai-jarvis).
4. Test: send `@ai-tony hello` in the group chat.

---

## How Bots Interact

### Mention-routed responses

Each bot only responds when directly `@<botname>` mentioned:

```
You: @ai-tony can you review this TypeScript code?
ai-tony: [reviews code, gives dry engineering feedback]

You: @ai-jarvis please schedule a call for tomorrow at 3pm
ai-jarvis: [creates calendar event, sends confirmation]
```

Bots ignore messages not addressed to them — even in a shared group.

### Inter-bot delegation

Bots can delegate to each other. If you ask ai-jarvis something better suited for ai-tony:

```
You: @ai-jarvis help me build a TypeScript utility function
ai-jarvis: @ai-tony this looks like your area — Boss needs a TypeScript utility...
ai-tony: [takes over and implements the function]
```

Or ai-tony can escalate to ai-jarvis for calendar/email work it doesn't have:

```
You: @ai-tony schedule a meeting for this feature review
ai-tony: That's not my surface — I don't have Calendar access. @ai-jarvis can help.
ai-jarvis: [schedules the meeting]
```

### Loop protection

To prevent bots from endlessly bouncing messages between each other, a **max 3 bot-to-bot turns per thread** limit is enforced. After 3 turns, the chain stops and the last bot states it has reached the inter-bot delegation limit.

### Self-message echo drop

Each bot drops messages it sent itself — no accidental self-loops.

### `<from-bot>` boundary

When ai-jarvis passes context from ai-tony (or vice versa), the content is wrapped in a `<from-bot>` XML boundary. This is a prompt-injection defense: the receiving bot's system prompt is instructed to treat `<from-bot>...</from-bot>` content as untrusted external input. See `docs/PROMPT_INJECTION_DEFENSE.md`.

---

## Adding More Bots (v1.22.x+)

> In v1.21.0, adding a bot requires a small code change (updating the `BOT_NAMES` closed set). In v1.22.0+, this will be config-only.

To add `ai-natasha` (e.g., a research/intelligence-focused bot):

### 1. Add the name to BOT_NAMES (v1.21.0 — code change required)

In `src/config/botIdentity.ts`, update:

```ts
export const BOT_NAMES = ['ai-jarvis', 'ai-tony', 'ai-natasha'] as const;
```

Also update `BOT_MARKER_BY_NAME`, `BOT_WEBAPP_PORT`, and `BOT_SCOPE` maps in the same file. Update the static test `tests/static/bot-name-closed-set.test.ts` to assert length `=== 3`.

### 2. Create the persona file

```bash
# config/personas/ai-natasha.md
# Give her a focused intelligence/research voice.
# List the tools she has and explicitly list tools she does NOT have.
```

### 3. Add the bot token env var

In `.env` and `.env.example`:
```
BOT_TOKEN_AI_NATASHA=your_natasha_bot_token_here
```

### 4. Update ecosystem.config.cjs

```js
{
  name: 'ai-natasha',
  script: 'dist/index.js',
  env: { BOT_NAME: 'ai-natasha' },
  out_file: 'data/ai-natasha/logs/out.log',
  error_file: 'data/ai-natasha/logs/err.log',
  autorestart: true,
  max_restarts: 10,
}
```

### 5. Build and reload

```bash
npm run build
pm2 reload ecosystem.config.cjs
```

---

## Limitations (v1.21.0)

These are known, intentional limitations of the initial release:

| Limitation | Notes |
|---|---|
| **No OAuth sharing** | Only ai-jarvis has Calendar + Gmail access. ai-tony uses no Google APIs. |
| **No cross-bot organize sharing** | Each bot has its own organize list under `data/<botName>/organize/`. |
| **No coach across bots** | Coach state is per-bot; ai-tony has no Coach functionality. |
| **No sandboxed shell for ai-tony** | `run_command` is excluded from ai-tony's tool allowlist (ADR 021 CP1 R6). Shell access for specialists deferred to v1.22.0+ with proper sandboxing. |
| **Adding a 3rd bot requires a code change** | `BOT_NAMES` is a closed-set const-array; 1-line code edit required to extend. Config-only addition targeted for v1.22.0. |

---

## Operator Runbook

### Checking logs

```bash
pm2 logs ai-jarvis          # tail ai-jarvis stdout + stderr
pm2 logs ai-tony            # tail ai-tony logs
pm2 logs ai-jarvis --lines 100  # last 100 lines
```

Logs are also written to:
- `data/ai-jarvis/logs/out.log` / `err.log`
- `data/ai-tony/logs/out.log` / `err.log`

### Restarting a single bot

```bash
pm2 restart ai-tony         # restart ai-tony without touching ai-jarvis
pm2 restart ai-jarvis       # restart ai-jarvis
pm2 restart all             # restart both
```

### Reloading after a config change

```bash
npm run build
pm2 reload ecosystem.config.cjs   # zero-downtime reload (SIGINT + restart)
```

### What to do when migration fails (R5 — partial-failure runbook)

On first v1.21.0 boot for ai-jarvis, the data migration helper moves `data/jarvis.db` (plus WAL + SHM sidecars) to `data/ai-jarvis/jarvis.db`. If this migration fails mid-way:

**Symptoms:**
- `pm2 logs ai-jarvis` shows `[botMigration] migration_failed` with a `reason` field.
- ai-jarvis exits or refuses to start.

**Diagnosis:**
1. Check the audit log: `sqlite3 data/ai-jarvis/jarvis.db "SELECT * FROM audit_log WHERE category LIKE 'bot.migration%' ORDER BY id DESC LIMIT 5;"` (if the new DB exists).
2. Or inspect PM2 error log: `cat data/ai-jarvis/logs/err.log | grep botMigration`.

**Recovery options:**

| Scenario | Action |
|---|---|
| `reason: WAL_CHECKPOINT_FAILED` | The legacy DB was locked by another process. Stop all pm2 processes: `pm2 stop all`. Remove stale lock files if any (`data/jarvis.db-wal`, `data/jarvis.db-shm`). Restart: `pm2 start ai-jarvis`. |
| `reason: SYMLINK_REJECTED` | Someone placed a symlink at `data/jarvis.db`. Remove it and replace with the actual DB file before restarting. |
| Partial rename (some files moved, some not) | Migration halts and audits `bot.migration_failed` with `partialState` listing completed renames. DO NOT attempt a manual rollback of renamed files. Instead: check whether `data/ai-jarvis/jarvis.db` exists. If it does and looks valid (non-zero size), run `PRAGMA integrity_check;` against it. If it passes, the migration is effectively complete — delete any leftover `data/jarvis.db*` legacy files and restart. |
| Both `data/jarvis.db` AND `data/ai-jarvis/jarvis.db` exist | A `bot.migration_conflict` was audited. Inspect both files. The newer one (check `ls -la`) is likely the canonical state. Manually remove the stale file and restart. |

**After any manual recovery:** always run `npm test` to verify the DB is in a consistent state before continuing.

---

## See Also

- `docs/adr/021-v1.21.0-avengers-mvp.md` — architectural decisions
- `docs/adr/021-revisions-after-cp1.md` — CP1 revisions (BINDING)
- `docs/ARCHITECTURE.md` — full system architecture
- `docs/PROMPT_INJECTION_DEFENSE.md` — `<from-bot>` boundary details
- `README.md` — single-bot setup (start here for first-time setup)
