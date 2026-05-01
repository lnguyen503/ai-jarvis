# Jarvis — Phase 3 Test Plan (CP4 + Sub-Phases A/B/C)

**Author:** QA Agent (opus)
**Date:** 2026-04-13
**Compliance:** None — Sub-Phase D skipped (REQUIREMENTS.md confirms single-user, no regulated data)
**Coverage Target:** 80% line, 75% branch (vitest v8 coverage)
**Reviewed Inputs:** ARCHITECTURE.md, QA-SECURITY.md, cp1-architecture-debate, cp2-cross-review, cp3-scalability-review, anti-slop-phase1, anti-slop-phase2, all `src/**/*.ts`, all `tests/**/*.ts`.

---

## 1. CP4 Risk Disclosure Summary

### 1.1 Risks Already Surfaced (synthesis)

| # | File | Risk | Source | Probing Test |
|---|---|---|---|---|
| R1 | `src/gateway/index.ts:130–136` | **CRITICAL** — Confirmation consumption re-enters the agent with natural-language text; re-classification sees destructive + no-pending → infinite confirm loop. | CP2 F1 | Drive a real `/YES a7f2` path through `gateway → agent.turn` with a mocked Claude that re-emits the same `run_command` tool_use; assert the command runs exactly once and no second confirmation prompt is produced. |
| R2 | `src/memory/messages.ts:36` | **CRITICAL** — `listRecent` is `ORDER BY created_at ASC`; returns the OLDEST N messages. Context window becomes frozen after 50 msgs. | CP3 CRITICAL-1 | Seed 60 messages across 2ms; call `listRecent(sid, 50)`; assert returned IDs are 11..60 (not 1..50), ordered ascending for prompt consumption. |
| R3 | `src/tools/types.ts:34` + `src/tools/index.ts:114` | **HIGH** — `Tool<TInput=any>` + `as never` cast silences drift between zod schema and `execute` signature. | CP2 F2 | Compile-time: flip a tool param type; `tsc --noEmit` must fail. Runtime: feed a malformed input that passes zod but violates the execute contract — expect typed failure, not a crash. |
| R4 | `src/agent/index.ts:174` + `src/tools/run_command.ts:33` | **HIGH** — Dual `classifyCommand` gates. Tool-level gate is dead code that can drift. | CP2 F3 | Unit test: assert `run_command.execute` does NOT call `classifyCommand` (spy). Integration: flip `allowEncodedCommands` between agent-gate and dispatch; assert only agent gate is authoritative. |
| R5 | `src/tools/write_file.ts:28` | **MEDIUM** — Uses `isPathAllowed`, not `isReadAllowed`. Agent can overwrite `D:\ai-jarvis\data\jarvis.db` or `logs/*.log`. | CP2 F7 | Write-against-denylist test: with `readDenyGlobs` covering `data/**,logs/**`, attempt `write_file` on `data/jarvis.db` — must be rejected (proposed `writeDenyGlobs` or reuse denylist). |
| R6 | `src/gateway/index.ts:169,219` | **LOW** — No `safety.scrub()` on outbound Telegram messages (belt-and-braces missing). | CP2 F12 | Force an un-scrubbed secret into `turnResult.replyText` via a mock agent turn and assert outbound message is scrubbed. |
| R7 | `src/tools/run_command.ts:164` + `src/tools/index.ts:130` | **MEDIUM** — Double scrub + double truncate. Harmless today but masks ownership. | CP2 F6 | Assert dispatch-level scrub is the single authoritative call (mock the per-tool scrub and verify it is not invoked, OR remove it). |
| R8 | `src/safety/confirmations.ts:25` | **MEDIUM** — Module-level `pendingBySession` Map shared across instances. | CP2 F9 / CP3 LOW-1 | Instantiate two `ConfirmationManager`s; stage pending on one; assert the other does NOT see it. Currently will fail — documents the defect. |
| R9 | `src/transcriber/index.ts:112` | **MEDIUM** — Whisper `fetch` has no AbortSignal/timeout; `/stop` cannot cancel in-flight transcription. | CP3 MEDIUM-1 | Mock a `fetch` that never resolves; fire `/stop`; assert the promise rejects within `transcribe.timeoutMs` and the queue slot is freed. |
| R10 | `src/safety/scrubber.ts:78–82` | **LOW** — `HEX_BLOB_40` over-matches git SHAs, SRI hashes. | AS Phase 2 W7 | False-positive regression: assert `git log` style SHAs in a benign tool output are NOT replaced when preceded by `commit `; assert real secrets still are. |
| R11 | `src/memory/db.ts:20–22` | **LOW** — Silent catch on pragmas; `foreign_keys=ON` failure is invisible. | AS Phase 2 W1 | After init, run `PRAGMA foreign_keys;` and assert `= 1`; verify DELETE on parent cascades children. |
| R12 | `src/agent/systemPrompt.ts:455` | **LOW** — Missing system prompt file falls back to 1-liner, violating §7. | AS Phase 2 W4 | Rename the template file at boot; assert boot fails OR full fallback is loaded (not the 1-liner). |

### 1.2 New Risks Identified by QA Review

| # | File | Risk | Probing Test |
|---|---|---|---|
| N1 | `src/safety/paths.ts` (write-case realpath) | ARCH §9 says for writes "realpath the deepest existing ancestor and append the remainder". A TOCTOU or a remainder containing `..` or a newly-created symlink between check and `fs.writeFileSync` can escape. | Create a non-existent nested target `D:\ai-jarvis\new\sub\file.txt` where `D:\ai-jarvis\new` is about to be created as a junction to `C:\Windows`. Assert the write either fails the check or re-validates the final handle. |
| N2 | `src/tools/search_files.ts` (minimatch pattern) | Pattern is user/agent-supplied. Pathological glob like `**/*.*/**/*.*/**/*.*` combined with `MAX_ENTRIES_SCANNED=50000` can still burn CPU. Also `fs.readdirSync` is sync — blocks event loop; during that time `/stop` does nothing. | Point at a deep tree (synthetic) with a pathological pattern; measure wall time; assert it returns within a bounded budget AND that `abortSignal` fires (currently not checked inside `walkDir`). |
| N3 | `src/safety/blocklist.ts` | ARCH §9 mandates expanding `${env:NAME}` **literally for matching**. Need a regression that agent-supplied command `Remove-Item ${env:TEMP}\foo` is classified destructive AFTER normalization and also that `${env:NotASetVar}` does not accidentally render to empty and pass. | Fuzz test on 30+ env-expansion variants. |
| N4 | `src/tools/run_command.ts` argv form | `shell='none'` with `args` — if a caller ever forgets to pass `args`, `execa(cmd, {shell:false})` (no shell) treats `cmd` as a single argv element. Injection surface is gone but misuse returns an odd error. Not security; UX. | Assert `shell='none'` without `args` returns a typed error `CMD_MISSING_ARGS`, not a generic execa failure. |
| N5 | `src/memory/migrations/001_initial.sql` | Migrations are idempotent only if `schema_migrations` bookkeeping works. What happens on partial failure mid-migration? | Force a migration to throw halfway (inject bad SQL); re-run on the same DB file; assert no duplicate tables and migration retries cleanly. |
| N6 | `src/gateway/chatQueue.ts` | `userQueue` reject-new-on-overflow message needs to survive Telegram delivery failures; otherwise the user never learns their request was rejected. | Force telegram send to throw; assert the rejection is logged with `warn` and queue state is still consistent. |
| N7 | Secret leak via `system_info` tool | `system_info` was not listed as self-scrubbing (AS Phase 2 notes). Confirm its output does NOT include env var dumps. | Set `AN_TEST_TOKEN=sk-ant-deadbeef...`; call `system_info`; assert output does not contain the token AND dispatch-level scrubber would still catch it if it did. |
| N8 | Session scoping on `scheduled_tasks` | ARCH §9 W3 says "every future session-scoped table." `scheduled_tasks` has `chat_id` (not session_id). Tests exist for messages/command_log/sessions — none for scheduled_tasks. | Seed scheduled_tasks for two chat_ids; assert repo methods don't leak cross-chat. |
| N9 | `/stop` racing against `execa` startup | If `/stop` fires between `agent.turn` invocation and the first `execa` call, the child process may already be spawned before the signal is checked. | Spy on `execa`; fire abort immediately after enqueue; assert either execa is never called OR the spawned child is killed within 100ms. |
| N10 | Read allow + symlink at write target | Allowlist realpaths at config-load time. If a user later creates a symlink inside `D:\ai-jarvis` pointing outside, subsequent read/write must still reject it (live realpath every call). | Create a symlink post-boot; call `read_file`; assert rejection (regression against a config-time-only realpath). |

---

## 2. Sub-Phase A — Functional Test Plan

### 2.1 User Story → Test Mapping

| Story | Verifying Tests | Status | Gaps |
|---|---|---|---|
| US-1 Text command (happy path) | NEW `tests/integration/gateway.textTurn.test.ts` | MISSING | Need end-to-end with mocked grammY + mocked Claude returning `end_turn`. Assert reply <3s (exclude tool exec). |
| US-2 Voice command | NEW `tests/integration/gateway.voice.test.ts` | MISSING | Mock Telegram voice download + Whisper fetch; assert transcript is echoed in italics, then acted on. |
| US-3 Shell execution + timeout | `tests/unit/tools.run_command.test.ts` (partial) | PARTIAL | Add: timeout kills child (`execa` timeout path), `killed=1` persisted, `CMD_TIMEOUT` error shape. |
| US-4 Sandboxed file access | `tests/unit/safety.paths.test.ts`, `tools.read_file.test.ts`, `tools.write_file.test.ts`, `tools.list_directory.test.ts`, `tools.search_files.test.ts` | PASS | Add N1, N10 above. |
| US-5 Allowlist enforcement | NEW `tests/integration/gateway.allowlist.test.ts` | MISSING | Simulate update from non-allowlisted `from.id`; assert silent drop + info log; no downstream invocation. |
| US-6 Destructive confirmation | `tests/unit/safety.confirmations.test.ts`, `safety.blocklist.test.ts`, `agent.safety.test.ts` | PARTIAL | Add R1 end-to-end (YES consumption does not re-loop). |
| US-7 Session memory | `tests/unit/memory.messages.test.ts`, `memory.scoping.test.ts` | PARTIAL | Add R2 regression (OLDEST-vs-NEWEST), plus `contextBuilder` returns 50 most-recent. |
| US-8 Kill switch | `tests/unit/tools.run_command.test.ts` (abort) | PARTIAL | Add N9 (abort before spawn) + R9 (abort into transcriber) + `/stop` clears userQueue only. |
| US-9 Always-on gateway | None | MISSING | Mock grammY `bot.start()` throwing network err; assert reconnection loop with capped exp backoff (tests with fake timers). |
| US-10 Proactive notifications | NEW `tests/integration/scheduler.test.ts` | MISSING | Seed a `scheduled_tasks` row with `*/1 * * * *`; advance fake clock; assert an unprompted Telegram message fires through the scheduler queue. |
| US-11 Bot commands | NEW `tests/integration/gateway.commands.test.ts` | MISSING | Coverage for `/start /status /stop /projects /history /clear /help`. |
| US-12 Audit log | `tests/integration/tools.scrub.test.ts` (scrubbed preview), `tests/unit/memory.commandLog.test.ts` | PASS | Add `killed=1` on timeout; add synthetic `__confirmation__` / `__scheduler_drop__` rows. |

### 2.2 Coverage Targets
- **Line coverage ≥ 80%**, **branch ≥ 75%**, **function ≥ 80%** (vitest v8).
- Known likely uncovered paths in current tree (grep-based estimate):
  - `src/gateway/*` — integration tests mostly absent; **add `gateway.textTurn`, `gateway.allowlist`, `gateway.voice`, `gateway.commands`**.
  - `src/scheduler/index.ts` — no tests; **add `scheduler.test.ts`**.
  - `src/agent/claude.ts` — retry/backoff paths and `overloaded_error` mapping; **add `agent.claudeRetry.test.ts`** (fake timers).
  - `src/agent/contextBuilder.ts` — depends on R2 fix; **add `agent.contextBuilder.test.ts` covering trim-to-maxHistory + system-prompt injection**.
  - `src/transcriber/index.ts` — no abort path, no timeout; **add `transcriber.test.ts`** covering retry + timeout + abort.
  - `src/safety/scrubber.ts` — add HEX false-positive guard test (R10).
  - `src/gateway/chatQueue.ts` — 6th user rejection and 21st scheduler drop covered in `gateway.queues.test.ts`; **add `/stop all` behavior if missing** (verify present).

### 2.3 New Test Files to Create (Sub-Phase A)
1. `tests/integration/gateway.textTurn.test.ts`
2. `tests/integration/gateway.allowlist.test.ts`
3. `tests/integration/gateway.voice.test.ts`
4. `tests/integration/gateway.commands.test.ts`
5. `tests/integration/scheduler.test.ts`
6. `tests/integration/confirmation.e2e.test.ts` (R1 regression)
7. `tests/unit/agent.claudeRetry.test.ts`
8. `tests/unit/agent.contextBuilder.test.ts`
9. `tests/unit/transcriber.test.ts`
10. `tests/unit/memory.messages.recentOrder.test.ts` (R2 regression, 60 seeded msgs)
11. `tests/unit/memory.scheduledTasks.scoping.test.ts` (N8)

---

## 3. Sub-Phase B — Security Test Plan

All tests live under `tests/security/` (new directory).

### B1. Automated Scans
- **B1.1** Run `npm audit --omit=dev --json`; parse; fail if any CRITICAL; file a HIGH disclosure in `qa-security-report.md` if any HIGH.
- **B1.2** Run `npm ls --all --json`; grep for `GPL`/`AGPL`/`UNKNOWN` licenses; report.
- **B1.3** Static scan: grep (via ripgrep in the QA runner, not in code) for `eval(`, `new Function(`, `innerHTML`, `dangerouslySetInnerHTML` across `src/**`. Must be zero matches OR documented (frontend §8 is N/A here so zero is achievable).
- **B1.4** SQL string concatenation: grep for `db.prepare(\`\${` / `.prepare("SELECT " +` style patterns — must be zero.
- **B1.5** Shell injection: grep for `execa(\`\${` / `execSync(` / `spawn(` with string interpolation — must be zero.
- **B1.6** ReDoS: run `safe-regex` (or manual inspection) over every regex in `src/safety/blocklist.ts` and `src/safety/scrubber.ts`. Assert star-height ≤ 2 and no nested `(a+)+` patterns.

### B2. Authentication & Authorization (Jarvis surface = Telegram allowlist)
- **B2.1** `tests/security/allowlist.fuzz.test.ts` — table-drive 20 `from.id` values (allowed, not-allowed, boundary `0`, negative, missing, string, bot user, forwarded message with different `forward_from`). Only the configured allowed id progresses; all others drop silently.
- **B2.2** Impersonation: an update with `from.id=<allowed>` but `forward_from.id=<allowed>` and `sender_chat=<evil>` — assert the primary `from.id` is what we check; no fallback to any other field.
- **B2.3** Session hijack via chat id: craft update with `chat.id=<foreign>` + `from.id=<allowed>` — assert the session is keyed by `chat.id` per ARCH §5 (no auth escalation from id mismatch).

### B3. Input Validation
- **B3.1 Allowlist bypass (paths)** — `tests/security/paths.bypass.test.ts`:
  - `..\..\..\Windows\system32` (forward + back variants)
  - `%SYSTEMROOT%` literal
  - UNC `\\?\C:\Windows`, `\\.\pipe\foo`, `\\localhost\c$`
  - 8.3: `C:\PROGRA~1` and multi-hop `D:\AI-JAR~1\src`
  - Symlinks: create `D:\ai-jarvis\evil_link → C:\Users` post-boot
  - NTFS junction (skip with `it.skipIf(!isAdmin)`): `mklink /J` inside allowed root to `C:\Windows`
  - NFD-encoded Unicode path equal to NFC allowed root
  - Trailing-separator edge: `D:\ai-jarvis-evil\*` must NOT match `D:\ai-jarvis` prefix
  - Case variations: `d:\AI-JARVIS\SRC\INDEX.ts`
  - Empty / NUL-containing / `\\?\C:\` prefixed
- **B3.2 Command injection** — `tests/security/command.injection.test.ts`:
  - Chain operators: `&&`, `;`, `|`, `||`, `` ` `` (backtick line-continuation), `$(...)`, `@(...)`, `&(...)`
  - Aliases: `rm`, `ri`, `rmdir`, `del`, `erase`, `rd /s`, `Format-Volume`, `diskpart`, `reg delete`
  - `-EncodedCommand <b64>` (b64 of both safe and `Remove-Item C:\`) — must be hard-rejected when `allowEncodedCommands=false`
  - `iex`, `Invoke-Expression`, `IEX(`, `& (gcm rem*)`, `.Invoke()` reflection
  - Env expansion: `Remove-Item ${env:SystemRoot}`, `$env:TEMP\..`, undefined `${env:NotSet}`
  - Fullwidth Unicode: `Ｒemove-Item C:\foo`
  - Combined: `echo hi && powershell -EncodedCommand <b64 of rm -rf>`
- **B3.3 Secret leakage — `.env` read attempt** — `tests/security/secrets.read.test.ts`:
  - `read_file` on `D:\ai-jarvis\.env` — rejected by `isReadAllowed`
  - `read_file` on `D:\ai-jarvis\.env.production` — rejected
  - `list_directory` on `D:\ai-jarvis` — result MUST omit `.env*`, `logs/`, `data/`
  - `search_files` with pattern `**/*.env*` — must return zero results (filter in walk)
  - `run_command` with `cat .env` / `Get-Content .env` — confirms scrubber redacts if somehow read
- **B3.4 Scrubber coverage across ALL tool outputs** — `tests/security/scrubber.every-tool.test.ts`:
  - For each tool (`run_command`, `read_file`, `list_directory`, `search_files`, `system_info`, `write_file`), stage an output containing: `sk-ant-...`, `ghp_...`, `AIza...`, `AKIA...` + 40-char secret, `Bearer ey...`, PEM block, 40-hex. Assert dispatcher returns scrubbed output AND DB `messages.tool_output` is scrubbed.
  - Negative: a benign 40-char hex preceded by `commit ` is NOT scrubbed (R10).
- **B3.5 Oversized payloads**:
  - `read_file` on a 5MB file — must stop at `maxBytes` (1MB) with a truncation marker, no OOM.
  - `run_command` stdout 10MB — must truncate at `maxOutputLength` (4KB) with `…[truncated]`; process memory does not balloon past 200MB RSS (NFR).
  - Agent turn with message text 5MB — must be rejected/truncated before Claude call; no 10x context explosion.
  - `scheduledTasks` insert with 1MB `command` — must be rejected by zod schema (add max-length constraint if missing).
- **B3.6 DoS via pathological regex / recursive search** — `tests/security/dos.test.ts`:
  - `search_files` with pattern `**/*.*/**/*.*/**` on a 5-level-deep synthetic tree; assert returns under 2s, `MAX_ENTRIES_SCANNED` respected.
  - Scrubber input 10MB of `AAAA...`: runs under 500ms.
  - `classifyCommand` input 100KB with alternating `&&echo `: runs under 100ms (ReDoS guard).

### B4. Secrets Hygiene
- **B4.1** Grep `src/**/*.ts` `config/**` for `sk-ant-`, `sk-`, `AIza`, `Bearer `, `-----BEGIN`: zero hits except in `scrubber.ts` constants and tests.
- **B4.2** `git log --all --diff-filter=A -- '*.env' '*.env.*'` returns empty.
- **B4.3** `.env` is listed in `.gitignore`.
- **B4.4** No hardcoded `localhost:` outside health endpoint (`127.0.0.1` is allowed; bare `localhost` elsewhere is flagged).

---

## 4. Sub-Phase C — Backend & Infrastructure Test Plan

### C1. API / Tool Contract Testing
Jarvis exposes **tool schemas to Claude**, not HTTP endpoints. Contract surface = `toClaudeToolDefs`.
- **C1.1** `tests/contract/tools.schema.test.ts`:
  - For each tool in `registerTools(deps)`, assert `toClaudeToolDefs(tools)` produces a JSON Schema whose `properties` exactly matches the zod `parameters` shape (use `zod-to-json-schema` reference output).
  - Assert no tool named `web_fetch` when `config.web.enabled=false` (regression for §15.8).
  - Assert tool `name`s are unique.
  - Assert every tool has a non-empty `description` (Claude-visible).
- **C1.2** Error shape contract — assert every `ToolResult` with `ok=false` has `error.code` and `error.message`; shape matches Anti-Slop §3 `{error, code, details?}`.
- **C1.3** Health endpoint `GET /health` (integration) — returns `{ok:true, uptimeSec:number, version:string}`, bound to `127.0.0.1`, rejects requests with non-loopback `Host` header if applicable.

### C2. Data Integrity
- **C2.1** CRUD lifecycle per entity (`tests/integration/memory.crud.test.ts`):
  - `sessions`: create → read (by chat) → update `last_active_at` → archive → assert `updated_at` moved, `created_at` unchanged.
  - `messages`: insert user/assistant/tool → list → assert round-trip; tool_output persisted as scrubbed.
  - `memory`: upsert by `(category,key)` unique — second insert updates, not duplicates.
  - `projects`: insert unique name — duplicate name rejected.
  - `scheduled_tasks`: insert → set `last_run_at`/`next_run_at` → pause → reactivate; updated_at advances.
  - `command_log`: insert via `run_command` dispatch path — verify `killed`, `duration_ms`, previews.
- **C2.2** Concurrency — with better-sqlite3 sync API, simulate 100 interleaved inserts via rapid calls; assert no corruption and no ordering inversion on `id`.
- **C2.3** Referential integrity:
  - Delete a `session` → `messages` ON DELETE CASCADE purges children; `command_log.session_id` → SET NULL.
  - Insert `message` with non-existent `session_id` — must fail (FK enforcement requires R11 pragma fix).
- **C2.4** `updated_at` triggers exist on `sessions`, `projects`, `memory`, `scheduled_tasks`.

### C3. Database Scope / Session Isolation
- **C3.1** Extend `tests/unit/memory.scoping.test.ts` with `scheduled_tasks` (N8) and confirm `commandLog.listRecent` is the **only** unscoped method (documented exception W3/F13).
- **C3.2** Ripgrep assertion in CI: every `.prepare(` statement that touches `messages`, `command_log`, or a future session-scoped table contains `WHERE session_id = ?` or `WHERE telegram_chat_id = ?` or is in `listRecent` global (whitelist).
- **C3.3** Seed two chat_ids worth of data; assert `SessionsRepo.getOrCreate(chatA)` never returns chatB's row; `MessagesRepo.listRecent(sidA)` returns zero chatB rows.

### C4. Environment Config Failure
- **C4.1** `tests/unit/config.schema.test.ts` (extend):
  - Missing `ANTHROPIC_API_KEY` at boot → clear fatal error "`ANTHROPIC_API_KEY` is required" — NOT a zod stack trace dumped to stderr.
  - Missing `TELEGRAM_BOT_TOKEN` → same.
  - `OPENAI_API_KEY` missing + `transcriber.enabled=false` → boot ok.
  - `config.json` has `web.enabled=true` but `web.allowedHosts=[]` → boot fails.
  - `filesystem.allowedPaths` entry that does not exist on disk → boot fails at realpath step.
  - `health.port=80` (below 1024) → boot fails.
  - `health.port=70000` → boot fails.
  - User config omits `readDenyGlobs` → merged default is non-empty (defaults are additive, cannot shrink).
- **C4.2** `.env.example` contains every required var documented in `config/schema.ts`; CI compares.
- **C4.3** Migration idempotency (`tests/integration/memory.migrations.test.ts`) covering N5:
  - Fresh DB → run migrations → `schema_migrations` has expected row(s).
  - Re-run `memory.init()` → no-op, no duplicate table error.
  - Inject a failing migration → re-run → retries cleanly, no partial schema.

---

## 5. Execution Instructions for the QA Run Agent

### 5.1 Preconditions
```
cd D:\ai-jarvis
node --version   # must be >=20
npm ci           # clean install (optional; if stale node_modules, re-install)
```
Confirm `.env.test` exists with mock keys (`ANTHROPIC_API_KEY=sk-ant-test-000`, `OPENAI_API_KEY=sk-test-000`, `TELEGRAM_BOT_TOKEN=000:test`). If missing, copy from `.env.example` and fill with dummy values.

### 5.2 Create New Test Files (exact list)
Create these 11 files from Sub-Phase A plus the security + contract files, all as empty scaffolds first (use `describe.todo` where the behavior depends on an unfixed defect):

Sub-Phase A:
1. `tests/integration/gateway.textTurn.test.ts`
2. `tests/integration/gateway.allowlist.test.ts`
3. `tests/integration/gateway.voice.test.ts`
4. `tests/integration/gateway.commands.test.ts`
5. `tests/integration/scheduler.test.ts`
6. `tests/integration/confirmation.e2e.test.ts`
7. `tests/unit/agent.claudeRetry.test.ts`
8. `tests/unit/agent.contextBuilder.test.ts`
9. `tests/unit/transcriber.test.ts`
10. `tests/unit/memory.messages.recentOrder.test.ts`
11. `tests/unit/memory.scheduledTasks.scoping.test.ts`

Sub-Phase B (create `tests/security/` directory):
12. `tests/security/allowlist.fuzz.test.ts`
13. `tests/security/paths.bypass.test.ts`
14. `tests/security/command.injection.test.ts`
15. `tests/security/secrets.read.test.ts`
16. `tests/security/scrubber.every-tool.test.ts`
17. `tests/security/dos.test.ts`

Sub-Phase C:
18. `tests/contract/tools.schema.test.ts`
19. `tests/integration/memory.crud.test.ts`
20. `tests/integration/memory.migrations.test.ts`

**Total new test files: 20. Estimated new `it()` cases: ~140** (counts: A ≈ 55, B ≈ 55, C ≈ 30).

### 5.3 Run Commands (in this order)
```bash
# 1. Lint + typecheck gate
npm run lint
npm run typecheck

# 2. Sub-Phase A: full functional run with coverage
npx vitest run --coverage --coverage.reporter=text --coverage.reporter=json-summary --coverage.reporter=lcov

# 3. Extract coverage numbers and gate
node -e "const s=require('./coverage/coverage-summary.json').total; const ok=s.lines.pct>=80 && s.branches.pct>=75 && s.functions.pct>=80; console.log(JSON.stringify(s,null,2)); process.exit(ok?0:1)"

# 4. Sub-Phase B: security-only run (tagged via path)
npx vitest run tests/security --reporter=verbose

# 5. Sub-Phase B1 automated scans
npm audit --omit=dev --json > qa/artifacts/npm-audit.json
npm ls --all --json > qa/artifacts/deps.json

# 6. Sub-Phase B4 secrets hygiene (use the factory's Grep tool equivalent — in a QA run use ripgrep CLI)
#    (QA agent: invoke Grep tool with patterns sk-ant-, sk-[A-Za-z0-9]{20,}, AIza, -----BEGIN, Bearer )
#    Store hits to qa/artifacts/secrets-grep.txt

git log --all --diff-filter=A -- '*.env' '*.env.*' > qa/artifacts/env-history.txt  # must be empty

# 7. Sub-Phase C: contract + backend run
npx vitest run tests/contract tests/integration/memory --reporter=verbose

# 8. Produce three reports
#    - docs/reviews/qa-A-report.md
#    - docs/reviews/qa-B-report.md
#    - docs/reviews/qa-C-report.md
#    using the template in QA-SECURITY.md "QA Report Format"
```

### 5.4 Coverage Threshold Enforcement
Add/confirm in `vitest.config.ts`:
```ts
test: {
  coverage: {
    provider: 'v8',
    thresholds: { lines: 80, branches: 75, functions: 80, statements: 80 },
    exclude: ['tests/**','dist/**','**/*.d.ts','src/index.ts' /* boot */]
  }
}
```
The QA run agent must use `npx vitest run --coverage` so the threshold is enforced by vitest itself, not just by the gate script above.

### 5.5 Verdict Rules
- **Sub-Phase A PASS:** all functional tests green AND coverage thresholds met.
- **Sub-Phase B PASS:** zero CRITICAL, all HIGH documented in `qa-B-report.md` with justification OR fix ticket.
- **Sub-Phase B BLOCKER (auto-fail):** any test in `paths.bypass`, `command.injection`, `secrets.read`, or `scrubber.every-tool` fails — these map to CP1 concerns C1, C2, C7 which the Devil's Advocate flagged as HIGH and said must not be deferred.
- **Sub-Phase C PASS:** all green; contract tests verify no `web_fetch`; scoping grep returns only whitelisted unscoped callers.
- **Sub-Phase D:** SKIPPED (not triggered).

### 5.6 What the Fix Loop (Phase 4) Must Prioritize
If these fail, they are **single-commit fixes** and should be fixed before the next full QA iteration:
1. R2 — `listRecent` ORDER BY DESC (CP3 CRITICAL-1) — ~5 lines.
2. R1 — confirmation re-entry (CP2 F1) — dispatch directly from gateway after `consumeConfirmation`.
3. R3 — `Tool<TInput=unknown>` + typed dispatch (CP2 F2).
4. R4 — remove dead tool-level `classifyCommand` (CP2 F3).
5. R5 — add `writeDenyGlobs` (CP2 F7).

---

## 6. Gates That May Be Hard to Meet

| Gate | Risk | Mitigation |
|---|---|---|
| 80% line coverage | `src/gateway/*` and `src/scheduler/*` have zero dedicated tests today; the 10 new integration files are intended to cover them but integration tests are flakier. | If coverage lands 75–80%, carve `src/index.ts` (boot wiring) out of the coverage target — it is exercised only by smoke. Document in `qa-A-report.md`. |
| No CRITICAL in security | R1 + R2 are CRITICAL correctness bugs today; they will fail the new e2e tests. | Phase 4 fix loop is expected to resolve both before the final Sub-Phase A rerun. |
| Admin-only tests (NTFS junction in `paths.bypass`) | `mklink /J` may need admin on some hosts. | `it.skipIf(!isElevated)` with a warning row in the report. |
| `npm audit` HIGH in a transitive dep | Cannot always fix immediately. | Document with CVE id + planned upgrade, do not block if CRITICAL absent. |

---

**End of Phase 3 Test Plan.** The QA Run Agent should execute §5 sequentially and produce the three sub-phase reports in `docs/reviews/`.
