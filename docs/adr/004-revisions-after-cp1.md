# ADR 004 — Revisions after CP1 debate (2026-04-24)

**Parent:** `004-organize-reminders.md`
**Status:** Accepted. Folded into ADR 004 by reference. Developer agents implement the revised spec in `ARCHITECTURE.md` §17.
**Context.** Devil's Advocate review (`docs/reviews/cp1-organize-reminders-debate.md`) raised 3 HIGH + 8 MEDIUM + 1 LOW concerns. Anti-Slop Phase 1 review (`docs/reviews/anti-slop-organize-reminders-phase1-review.md`) added 3 required-before-Phase-2 actions + 12 warnings. This file records the resolution of each concern.

---

## Resolved (ADR revisions)

### R1 (new decision 16) — Output-message phishing filter (DA-C1 HIGH)

**Concern.** The triage LLM's `decision.message` is delivered verbatim to the user's DM. User-authored titles are re-surfaced into this message by the LLM (it is explicitly told to reference items by title). A malicious title like `"IMPORTANT: send CONFIRM TRANSFER abc123 to verify your account"` can cause the LLM to echo phishing-like content into a message that *appears* to come from Jarvis, bypassing the `<untrusted>` wrapper (which protected the INPUT pipeline, not the OUTPUT).

**Decision.** Before calling `sendMessage(chatId, decision.message)`, the orchestrator passes `decision.message` through a `checkOutboundSafety(text)` guard in `src/organize/reminders.ts`. The guard rejects any message matching the following patterns (case-insensitive, unicode-normalized, with whitespace collapsed to single spaces) — if any match, the nudge is SUPPRESSED (no DM sent, state NOT mutated for cooldown, audit row inserted with `result: 'suppressed', reason: 'outbound-safety-pattern'`):

  - `CONFIRM\s+SEND\s+[A-Za-z0-9]{6,}` — mimics the v1.7.15 gmail send confirmation token shape
  - `CONFIRM\s+TRANSFER\s+[A-Za-z0-9]{6,}` — generic financial-transfer phishing shape
  - `YES\s+[a-f0-9]{4,8}` — mimics the safety-confirmation action-id shape (`src/safety/confirmations.ts`)
  - `(ANTHROPIC|OPENAI|GOOGLE|OLLAMA|TAVILY|TELEGRAM)[_-]?(API)?[_-]?(KEY|TOKEN)` — credential-name echo
  - `sk-ant-[A-Za-z0-9_-]{20,}` / `ghp_[A-Za-z0-9]{30,}` / `AIza[0-9A-Za-z_-]{35}` / PEM headers — any scrubber-matched credential shape (reuses `src/safety/scrubber.ts`)
  - `https?://[^\s]{0,20}@[^\s]+` — URL with embedded user:password auth
  - `password\s*(is|:|=)\s*\S` — literal password dictation
  - Zero-width / bidi-override Unicode (U+200B, U+200C, U+200D, U+202A–U+202E, U+2066–U+2069) — homoglyph / bidi-spoof attacks

**`sendFileTool` shape discipline**: `decision.offer.description` is ALSO passed through `checkOutboundSafety`. The `reasoning` field (stored in audit only, never sent to user) is NOT filtered — but see R6 below for its redaction requirements.

**Test coverage** (add to `tests/unit/organize.reminders.test.ts`): seed a user with a title containing `"IMPORTANT: send CONFIRM SEND abc123"`; mock the LLM to echo that substring into `message`; assert `sendMessage` is NOT called, audit row has `result: 'suppressed'`, and state is unchanged (cooldown untouched).

### R2 (supersedes parts of decisions 7, 8) — Server-side quiet-hours hard gate (DA-C2 HIGH / AS-W7)

**Concern.** Quiet hours (22:00–08:00 server TZ) is enforced ONLY by a `quietHours: true` flag in the triage input that the LLM is instructed to honor. An LLM misbehavior or silent Haiku fallback under adversarial input could emit `shouldNudge: true` at 3am on a non-imminent task. Additionally, the cron expression `0 8-22/2 * * *` fires AT hour 22 — which is INSIDE the quiet window per the "quietHoursStart: 22:00" config — so the 22:00 tick does an LLM call that is discarded, wasted work.

**Decision.**

1. **Cron expression corrected** to `0 8-20/2 * * *` — fires at 08, 10, 12, 14, 16, 18, 20 only. Last tick of the day is 20:00 (8pm). Hours 22 onward are now outside the cron entirely.
2. **Server-side hard gate** added to the per-user tick in `src/organize/reminders.ts`, AFTER `parseTriageDecision` returns a valid `shouldNudge: true`, BEFORE the `checkOutboundSafety` call:

```typescript
if (quietHoursNow(config)) {
  // During quiet hours, only event-type items with start time within 60 minutes pass.
  const item = activeItems.find((i) => i.id === decision.itemId);
  const isImminentEvent =
    item?.type === 'event' &&
    item.due &&
    isISODateTime(item.due) &&
    (Date.parse(item.due) - Date.now()) <= 60 * 60 * 1000 &&
    (Date.parse(item.due) - Date.now()) >= 0;
  if (!isImminentEvent) {
    log.info({ userId, itemId: decision.itemId, reason: 'quiet-hours-non-imminent' }, 'Nudge suppressed');
    return { suppressed: true, reason: 'quiet-hours' };
  }
}
```

3. **Cron fire during quiet hours is belt-and-braces** — the cron is already scoped to non-quiet hours (08–20), but manual triggers (future `/organize run-triage-now` admin command — out of scope for v1.9.0) would still hit the hard gate.

**Test coverage** (`tests/unit/organize.reminders.test.ts`): mock `Date.now()` to 23:30; mock LLM to return `shouldNudge:true` for a task-type item → `sendMessage` not called, audit has `result: 'suppressed', reason: 'quiet-hours'`. Then with an event item due in 30 min → `sendMessage` IS called.

### R3 (supersedes decision 15) — Nag opt-out persists across restarts (DA-C3 HIGH)

**Concern.** Decision 15 ("`/organize nag on|off|status` is a new subcommand family, distinct from `/organize on|off` injection toggle") is correct in spirit, but step 7 of the per-user gate sequence calls `isOrganizeDisabledForUser(userId)` — which is the v1.8.6 in-memory module-scoped Set in `src/commands/organize.ts:35`. After a process restart, that Set is empty — silently re-enabling nags for every user who had opted out.

**Decision.**

1. **Step 7 of the gate sequence is REPLACED.** Instead of `isOrganizeDisabledForUser(userId)`, the gate reads `state.userDisabledNag === true` from the persistent `.reminder-state.json` file. The in-memory Set stays as-is for the v1.8.6 `/organize off` INJECTION toggle but is NOT used for the nag gate.

2. **`/organize nag off` / `on`** updates `state.userDisabledNag` via `writeReminderState` (atomic temp-then-rename). `/organize nag status` reads the same field. Both also update an in-memory per-user cache (to avoid the fs-read on every gate check) keyed by userId; the cache is refreshed on write.

3. **The in-memory cache resets on restart and re-populates lazily** — first tick for a user reads `.reminder-state.json`, caches the `userDisabledNag` boolean, uses it. First call to `/organize nag <action>` also caches. No split-brain.

4. **Decision 15 stays** (nag commands are distinct from the injection toggle). The bug was the gate implementation, not the command shape.

**Test coverage** (`tests/unit/organize.reminders.test.ts`): seed state with `userDisabledNag: true`; run `tickAllUsers()` → the LLM is never called for that user; `sendMessage` never invoked. Separately: `/organize nag off` writes state; reading the file shows `userDisabledNag: true`.

### R4 (new decision 17) — Haiku fallback daily cap + circuit breaker (DA-C4 MEDIUM→now required)

**Concern.** Ollama Cloud cold-start often exceeds 60s (documented in `src/providers/ollama-cloud.ts:24-28`). The ADR's 30s `triageTimeoutMs` will cold-start-time-out frequently in normal operation, triggering Haiku fallback routinely, not only on outages. At single-user scale this is pennies; at any multi-user scale or during an Ollama Cloud incident the cost compounds.

**Decision.**

1. **Bump `triageTimeoutMs` default** from 30s to **90s**. Ollama Cloud's own cold-start claim is 60s; 90s gives margin before we give up. Documented as a deliberate adjustment to the provider's known characteristic.

2. **Per-day Haiku-fallback cap** added to config as `organize.reminders.haikuFallbackMaxPerDay` (default **20**). Tracked globally (not per-user) in a new `data/organize/.reminder-global-state.json` file (atomic write, same pattern as per-user state):

```json
{
  "version": 1,
  "date": "2026-04-24",
  "haikuFallbacksToday": 3,
  "totalTicksToday": 17
}
```

3. **Circuit breaker** — when `haikuFallbacksToday >= haikuFallbackMaxPerDay`, the per-user tick skips the Claude fallback entirely (primary Ollama call still tries; on failure, the tick returns silently with an audit row `result: 'skipped', reason: 'haiku-budget-exhausted'`). Reset at local midnight same as per-user counter.

4. **Token-usage audit** — each `organize.nudge` audit row includes `inputTokens`, `outputTokens`, `provider`, `model` in detail so cost is attributable. For suppressions / skips, only `provider` + `model` (if known).

**Test coverage**: mock 20 consecutive Ollama-fail + Haiku-success pairs; 21st tick with Ollama-fail should NOT call Haiku and should audit `result: 'skipped', reason: 'haiku-budget-exhausted'`.

### R5 (supersedes part of decision 10) — Rollback uses `structuredClone`, not `Object.assign` (DA-C5 MEDIUM)

**Concern.** Decision 10's "snapshot via `Object.assign({}, state)` before tentative mutation" is a shallow copy. Nested objects (`state.items[id]`, `state.items[id].responseHistory[]`) share references with the snapshot, so mutations to nested fields leak into the snapshot — defeating the rollback.

**Decision.** Use `structuredClone(state)` for the snapshot. Available on Node ≥17 (we require ≥20). Deep-clones the state tree, guaranteeing rollback isolation. Same pattern as `src/plan/executor.ts` (which uses `structuredClone` for its own rollback snapshots).

**Test coverage**: induce a `sendMessage` throw after mutating `state.items[id].responseHistory`; assert the post-catch `state` has the ORIGINAL `responseHistory` (not the mutated one).

### R6 (new decision 18) — Tick-in-flight lock for overlapping fires (DA-C7 MEDIUM)

**Concern.** On pm2 restart, the old node process may still be running its cron tick when the new process boots and immediately fires its own. Two tickAllUsers() executions writing to the same state files races.

**Decision.** Module-level `let tickInFlight = false` in `src/organize/reminders.ts`. The cron handler:

```typescript
if (tickInFlight) {
  log.warn({ cron: 'skipped' }, 'Previous tick still running; skipping this fire');
  return;
}
tickInFlight = true;
try {
  await tickAllUsers(deps);
} finally {
  tickInFlight = false;
}
```

Per-process lock — doesn't defend against two concurrent NODE PROCESSES both writing to the same `.reminder-state.json` file (the atomic rename still wins by "last write"). But for single-process pm2 deployment this closes the overlap window. For multi-process future, add fs-lock via `proper-lockfile` (documented as a v1.9.1 TODO; don't add the dep now).

**Test coverage**: set `tickInFlight = true`; fire the cron handler → should return without doing anything. Then set `false` and fire → should execute.

### R7 (supersedes part of decision 7) — Imminent events prioritized over stale past items (DA-C8 MEDIUM)

**Concern.** Decision 7's step "sort by earliest due" means a user with 55 past-due stale tasks and 2 imminent events has the events crowded OUT of the 50-item input cap (stale past items sort first because their `due` is in the past). The LLM never sees the imminent events.

**Decision.** Pre-sort step in `buildTriageInput(userId, items)`:

```typescript
// R7: imminent events go to the front, past items to the back, then fill with earliest-due.
const now = Date.now();
const events = items.filter((i) => i.type === 'event' && i.due && Date.parse(i.due) - now >= 0);
const nonEvents = items.filter((i) => i.type !== 'event');
const pastItems = items.filter((i) => i.type === 'event' && i.due && Date.parse(i.due) - now < 0);

events.sort((a, b) => Date.parse(a.due!) - Date.parse(b.due!));
nonEvents.sort(compareDueAsc);           // existing helper — undated last
pastItems.sort((a, b) => Date.parse(b.due!) - Date.parse(a.due!));  // most-recent-past first

const picked = [
  ...events.slice(0, 25),                // up to 25 imminent events always make the cut
  ...nonEvents.slice(0, 50 - Math.min(events.length, 25) - Math.min(pastItems.length, 5)),
  ...pastItems.slice(0, 5),              // 5 most-recently-past for overdue context
].slice(0, 50);
```

**Test coverage**: 55 past tasks + 2 events in 30 min → the 2 events ARE in the payload; at least 40 past tasks are excluded.

### R8 (supersedes part of decision 10) — Skip response-hook on slash commands (DA-C10 MEDIUM)

**Concern.** Decision 10's `markResponsiveIfPending(userId)` fires on every DM including slash commands. A user who types `/memory` five minutes after a nudge had nothing to do with responding to the nudge — they were running an unrelated command.

**Decision.** The gateway hook ONLY calls `markResponsiveIfPending(userId)` for messages that are NOT slash commands — i.e. the text does not start with `/`. Slash commands are treated as unrelated interactions. Natural-language DMs (what the user would send to engage with the nudge) continue to mark as responsive.

```typescript
// In src/gateway/index.ts DM message handler — FIRST statement:
const text = ctx.message?.text ?? '';
if (!text.startsWith('/')) {
  markResponsiveIfPending(userId).catch((err) => log.warn({ err }, 'markResponsiveIfPending failed'));
}
```

**Test coverage**: user has a pending nudge; sends `/memory` → state unchanged; sends `"done!"` → state updated.

### R9 (new decision 19) — Audit `reasoning` field NEVER contains user text (DA-C11 MEDIUM)

**Concern.** Decision 11's audit detail stores `reasoning` (LLM-authored, 300-char cap). The LLM frequently mentions item titles in its reasoning ("because 'buy groceries' was due yesterday..."). This re-introduces user text into the audit log — violating the v1.8.6 R10 / §16.7 invariant "raw user text never lands in audit detail."

**Decision.** Before storing `reasoning` in the audit row, scrub any substring that matches any known active-item title for that user:

```typescript
function redactTitlesFromReasoning(reasoning: string, items: OrganizeItem[]): string {
  let redacted = reasoning;
  for (const item of items) {
    if (item.frontMatter.title && redacted.includes(item.frontMatter.title)) {
      redacted = redacted.split(item.frontMatter.title).join(`[title:${item.frontMatter.id}]`);
    }
  }
  return redacted.slice(0, 300);
}
```

**Consequences.** The audit log's `reasoning` is less useful for debugging ("the LLM said 'foo deserves a nudge'" becomes "the LLM said '[title:id] deserves a nudge'"). But the privacy invariant stays intact. If a developer needs to see what the LLM actually said, they correlate the `[title:id]` marker with the storage file — which is by-design a per-user access path.

**Test coverage**: seed an item titled "Buy prescription meds"; triage LLM returns `reasoning: "Buy prescription meds was logged 14 days ago"` → audit row has `reasoning: "[title:2026-...] was logged 14 days ago"`.

### R10 (supersedes part of decision 10) — `chatId === userId` assumption documented as Telegram-specific (DA-C12 LOW)

**Concern.** Decision 10's "Telegram DM chatId equals userId — no lookup needed" is a Telegram implementation detail, not a platform-neutral promise. On Slack / WhatsApp ports this breaks.

**Decision.** Add a `MessagingAdapter.resolveDmChatId(userId): number | null` method to the adapter interface. Telegram's implementation: `return userId`. Slack's future implementation: look up in a `slack_dm_channels` table. WhatsApp's future implementation: the user's phone number → channel id mapping.

The reminder loop calls `adapter.resolveDmChatId(userId)` before `adapter.sendMessage`. Null return → log warn "cannot resolve DM channel for user {userId}" and skip (no DM, no state mutation). 

**Test coverage**: `tests/unit/organize.reminders.test.ts` uses a mock adapter where `resolveDmChatId` returns `null` for a specific userId → tick for that user skips without sending.

### R11 (new decision 20) — Build-order explicit rename + export for `neutralizeUntrusted` (AS-W15)

**Concern.** ADR §17.13 imports `neutralizeUntrusted` from `src/organize/injection.ts`, but the existing code defines this function as `neutralizeTitle` (un-exported, internal to injection.ts). Without an explicit build-order step, a developer may inline a second copy in reminders, drifting from the v1.8.6 implementation.

**Decision.** Step 0 of the Phase 2 build order (BEFORE any new reminders code is written):

1. In `src/organize/injection.ts`, rename function `neutralizeTitle` → `neutralizeUntrusted`.
2. `export` the renamed function.
3. Update the one call site inside `injection.ts`.
4. Update `tests/unit/organize.injection.test.ts` to import and directly test the exported function (in addition to the integration-level tests).
5. Run `npx vitest run tests/unit/organize.injection.test.ts` — must pass.

Then proceed to Phase 2 implementation. `src/organize/reminders.ts` and `src/organize/triagePrompt.ts` import the exported `neutralizeUntrusted`.

**Test coverage**: no new test; existing injection.test.ts adapted to reference the renamed function.

### R12 — Cold-start timeout + fallback counter cross-reference (AS-W7 / DA-C4 combined)

See R4 above — 30s → 90s, plus global fallback cap. No separate decision.

### R13 — Missing `errMsg` helper + output-side scrubber in `formatNudgeBody` (AS warnings)

**Decision.**

1. Add a 3-line helper `src/organize/reminderUtils.ts` or inline in `reminders.ts`:
   ```typescript
   function errMsg(err: unknown): string {
     return err instanceof Error ? err.message : String(err);
   }
   ```

2. `formatNudgeBody(decision)` passes the rendered body through the existing `scrub` from `src/safety/scrubber.ts` as a defense-in-depth pass (parallel to the gateway's pre-send scrub). Catches any credential shape the R1 filter missed.

### R14 — Failure-matrix completions (AS warnings)

Add rows to §17.12:
  - Ollama Cloud 429 → `result: 'skipped', reason: 'rate-limit'`. No Haiku fallback (429 indicates we've already been too chatty).
  - State-file write failure (rename fails due to EPERM) → `result: 'failed', reason: 'state-write'`. No DM sent (because state rollback can't complete).
  - `resolveDmChatId` returns null → `result: 'skipped', reason: 'no-dm-channel'`.
  - Global Haiku budget exhausted → `result: 'skipped', reason: 'haiku-budget-exhausted'`.
  - Quiet-hours hard gate → `result: 'suppressed', reason: 'quiet-hours'`.
  - Outbound-safety filter → `result: 'suppressed', reason: 'outbound-safety-pattern'`.

### R15 — Parameterize "last 3 entries" in ignore-backoff check (AS warnings)

**Decision.** `state.items[id].responseHistory.slice(-config.organize.reminders.muteAfterConsecutiveIgnores)` instead of a hardcoded 3. Already set in config; just use it at the call site.

### R16 — Update `config/config.example.json` in build order (AS warnings)

**Decision.** Phase 2 build order includes a step to write/update `config/config.example.json` with the `organize.reminders` stanza at default values. Matches the pattern for other config sections.

---

## Accepted as documented risks (no ADR change)

  - **DA-C6** — cleanup + mtime-stat run BEFORE opt-out gates. Perf nit. Move after the cheap gates in a v1.9.1 refactor; not blocking ship.
  - **DA-C9** — mtime un-mute fires on `organize_log_progress`. Design debate: is progress-logged-but-DM-ignored a reset signal? Current ADR says yes; DA disagrees. Accept ADR behavior for v1.9.0; revisit if users complain of nag/mute/unmute churn.
  - **AS-W5** — 1-item edge case test not explicitly listed. Developer adds during implementation.
  - **AS minor**: ADR cross-ref typo (§17.12 vs §17.14) — corrected in-place during §17 patch.

## Summary of ADR changes

Original decisions 1–15 stand with amendments:

  - **Decision 7:** + server-side quiet-hours hard gate (R2), + imminent-events pre-sort (R7), + `userDisabledNag` from persistent state (R3).
  - **Decision 8:** + 90s triageTimeoutMs (R4), + fallback budget check (R4).
  - **Decision 10:** + structuredClone snapshot (R5), + slash-command skip on response hook (R8), + resolveDmChatId (R10).
  - **Decision 11:** + redact titles from reasoning (R9).

Plus five NEW decisions:
  - **Decision 16:** Output-message phishing filter (R1).
  - **Decision 17:** Haiku fallback daily cap + circuit breaker (R4).
  - **Decision 18:** Tick-in-flight lock (R6).
  - **Decision 19:** Audit `reasoning` title redaction (R9).
  - **Decision 20:** Build-order step for `neutralizeUntrusted` rename+export (R11).

`ARCHITECTURE.md` §17 is patched in-place with the revised behavior so developer agents have a single source of truth.
