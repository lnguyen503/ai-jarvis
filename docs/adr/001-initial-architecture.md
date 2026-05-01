# ADR 001 — Initial Architecture

**Status:** Accepted
**Date:** 2026-04-13
**Deciders:** Architect Agent (Phase 1)

This ADR records the key technology and structural decisions for Jarvis v1.0. Each uses the Status / Context / Decision / Consequences format.

---

## 1. Telegram client library: grammY

**Status:** Accepted.

**Context.** Two mature TypeScript Telegram libraries exist: `telegraf` (older, wider ecosystem, ~24k stars) and `grammY` (newer, first-class TS, actively maintained, middleware model similar to Koa, strict type inference on updates). SPEC names grammY explicitly; OpenClaw (our reference implementation) uses it.

**Decision.** Use grammY.

**Consequences.** Strong typing on `Context`, clean middleware chaining for the allowlist guard, and official plugins for auto-retry and conversation state. Trade-off: smaller community than telegraf, so fewer Stack Overflow hits — acceptable because the API surface we use is narrow (polling, message send, voice file download).

---

## 2. SQLite driver: better-sqlite3

**Status:** Accepted.

**Context.** Two options: `sqlite3` (async, callback-based, node-gyp builds) and `better-sqlite3` (synchronous, prepared-statement cache, WAL support, compiled native binding). Our workload is single-process, single-writer, latency-critical (we want a Claude turn to feel instant). Node.js async SQLite is slower in this shape because every call round-trips the event loop.

**Decision.** Use better-sqlite3 with WAL mode and `foreign_keys = ON`.

**Consequences.** Simpler code (no Promises for DB ops), faster writes, and safer transactions via `db.transaction()`. Trade-off: synchronous calls block the event loop — mitigated by the fact that queries are milliseconds and we're single-user. If we scale to multi-user, we migrate to Postgres (the repo layer is already abstracted).

---

## 3. Shell execution: execa

**Status:** Accepted.

**Context.** Node's built-in `child_process.spawn` is low-level: stream plumbing, manual timeout, PID management, cross-platform quoting all fall on the caller. `execa` wraps it with timeouts, abort-signal support, stdout/stderr capture with streaming, and sensible Windows shell handling.

**Decision.** Use execa for `run_command`. Run commands via `execa.command(cmd, { shell: 'powershell.exe', cwd, timeout, signal })` so the user's natural PowerShell one-liners work.

**Consequences.** We get timeouts, abort-signal, and streaming for free. Trade-off: dependency weight is trivial; API is well-documented.

---

## 4. Config + tool parameter validation: zod

**Status:** Accepted.

**Context.** We need runtime validation for (a) config.json at boot, (b) .env vars, and (c) tool inputs coming from Claude. Options: `joi`, `ajv` (JSON Schema direct), `zod`. Zod is TS-native, composable, and — critically — can be converted to JSON Schema for Claude's tool definitions via `zod-to-json-schema`, giving one source of truth for each tool's input shape.

**Decision.** Zod for all three. Single shared `ConfigSchema` in `src/config/schema.ts`.

**Consequences.** Type inference (`z.infer<typeof Schema>`) means we write the schema once and TS types flow everywhere. Boot fails fast on invalid config. Trade-off: one more dependency, but already in the factory's standard stack.

---

## 5. Logging: pino

**Status:** Accepted.

**Context.** Need structured JSON logs with rotation and field redaction (API keys must never leak). Options: `winston` (popular, heavier), `pino` (fastest in benchmarks, first-class redaction, small). Factory's `KNOWN_ISSUES.md` and the Anti-Slop framework (§15) require structured logs.

**Decision.** Pino with `pino-roll` for daily rotation and explicit redaction paths for tokens, API keys, and bot tokens.

**Consequences.** Low overhead, clean JSON output, child loggers per component. Trade-off: pretty-printing for dev needs `pino-pretty` as a separate dev dependency — acceptable.

---

## 6. Single-process vs worker pool

**Status:** Accepted (single-process for v1.0).

**Context.** The MVP is single-user. At most one active command per chat (SPEC). Node's event loop easily handles grammY polling + one execa child + occasional Claude and Whisper HTTP calls. A worker pool would add IPC overhead, complicate logging/DB sharing, and deliver no user-visible benefit at this scale.

**Decision.** Single Node.js process. One event loop. Shell commands run as child processes (not worker threads).

**Consequences.** Simpler mental model, simpler deployment (one pm2 entry). A synchronous SQLite call that took a surprise 500ms would stall the bot — acceptable given our workload profile. **Upgrade path recorded** in ARCHITECTURE.md §1: for multi-user, split agent/tools into a worker pool and move SQLite → Postgres.

---

## 7. Telegram transport: polling, not webhooks

**Status:** Accepted.

**Context.** Telegram supports two bot transports: long-polling (bot calls `getUpdates` outbound) and webhooks (Telegram POSTs to a public HTTPS URL on your server). Webhooks require a public DNS name, a TLS cert, and an inbound-listening port. The SPEC and REQUIREMENTS forbid remote network exposure ("No remote network exposure — gateway binds to localhost only, Telegram connection is outbound-only").

**Decision.** Long-polling via `bot.start()`.

**Consequences.** Zero inbound exposure → no attack surface from the public internet, no NAT punchthrough needed for a desktop deployment. Trade-off: polling has a ~0.5–1s latency floor (negligible vs Claude's 1–3s turn time) and Telegram rate-limits `getUpdates` to reasonable levels. If Jarvis ever moves to a cloud VM with a stable hostname, webhooks can be added behind a toggle without changing the agent core.

---

## 8. Agent control flow: Claude native tool_use, not a custom router

**Status:** Accepted.

**Context.** Two shapes: (a) parse Claude's natural-language output for "call tool X with args Y" — brittle, requires few-shot prompting, error-prone. (b) Use Claude's native `tool_use` blocks with the Messages API — model is trained for this, supports parallel tool calls, returns structured `input` objects that validate against our zod schemas.

**Decision.** Native tool_use. The ReAct loop is: send `messages[]` + `tools[]` → inspect `stop_reason` → if `tool_use`, dispatch each `tool_use` block and append `tool_result` blocks → send again → repeat until `end_turn` or max 10 iterations.

**Consequences.** No prompt-engineering of a router, no parsing failures, structured inputs validated with zod. Trade-off: we tie ourselves to Anthropic's API shape — acceptable because the SPEC commits to Claude as the AI provider. If we ever swap providers, only `src/agent/claude.ts` changes.

---

## Addendum from CP1 (2026-04-13)

Three concerns from the Checkpoint 1 architecture debate are accepted as-designed and recorded here for traceability. See `docs/reviews/cp1-architecture-debate.md` for full challenge text.

### A1 — Voice data is sent to OpenAI Whisper (CP1 C9)
**Decision.** Accepted. Voice memos are transmitted to `api.openai.com` for transcription. No local fallback in v1.0. A v2 feature may add Whisper.cpp for local-only transcription. Users should be informed in README that voice audio leaves the machine.

### A2 — Localhost health endpoint has no auth (CP1 C13)
**Decision.** Accepted. The health endpoint at `127.0.0.1:7878` returns only `{ ok: true, uptimeSec, version }`. No session data, no command history, no PII. Any process running as the logged-in user can reach it; since those processes already have full user-level access, the exposure is not a meaningful escalation. Health endpoint MUST NOT expose any field beyond the three listed; enforce in code review.

### A3 — `projects` SQLite table dropped; config is source of truth (CP1 C15)
**Decision.** Accepted. The `projects` table in ARCHITECTURE.md §3 is NOT to be created. `config.projects` is the sole source of truth for project name → path mappings. The `/projects` Telegram command reads from config directly. Rationale: eliminates duplication and a sync bug class for a feature that has no write path in the MVP. If future features require mutable project metadata, re-introduce the table via a migration.

The `memory` and `scheduled_tasks` tables remain as specified — both have clear write paths in SPEC flows.

---

## Decisions deferred (documented for v2+)

- **Browser automation / Playwright:** out of scope, noted in SPEC §Roadmap.
- **MCP compatibility:** out of scope; custom tool interface is simpler for v1.0.
- **Multi-user:** out of scope; architecture notes the upgrade path.
- **Webhook transport:** out of scope; polling is sufficient and safer for a personal desktop deployment.
