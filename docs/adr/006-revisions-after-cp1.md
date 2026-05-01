# ADR 006 — Revisions after CP1 debate (2026-04-24)

**Parent:** `006-v1.11.0-cleanup-sweep.md`
**Status:** Accepted. Folded into ADR 006 by reference. Developer agents implement the revised spec; deviations require another addendum.
**Context.** Devil's Advocate review (`docs/reviews/cp1-devils-advocate-v1.11.0.md`) raised 2 HIGH (BLOCKING) + 8 MEDIUM + 1 LOW, plus 7 new risks. Anti-Slop Phase 1 review (`docs/reviews/anti-slop-phase1-review-v1.11.0.md`) added 3 required-before-Phase-2 (2 FAIL-adjacent + 1 stale-claim) + 15 warnings. The two reviews converge on the same core issues from different angles. This file records the resolution.

---

## Resolved (ADR revisions — R1 through R13)

### R1 (HIGH, BLOCKING — supersedes decisions 13 + 14) — `calendar_delete_event` 404 surfaces ambiguity; new code `EVENT_ALREADY_GONE` (DA-C1 + Anti-Slop §6)

**Concern.** Original decision 13's 404-delete success shape returned `output: 'Already deleted (event was not found on calendar).'` — which the LLM will paraphrase to the user as "I deleted the event." If the eventId was typo'd (LLM sampled wrong id, user dictated wrong reference over voice, wrong id copied from a stale list), Google returns 404, the tool says "deleted," but nothing was actually touched. The audit trail cannot distinguish real-delete from typo-404.

**Decision.**

1. **Distinguishable success string.** Replace the 404-success output with:
   ```
   Event <eventId> was not found on calendar "<calendarId>". If this was the
   event you meant to delete, it's already gone. If the id looks wrong,
   double-check it against a recent calendar_list_events output.
   ```
   This names both possibilities so the LLM cannot paraphrase the ambiguity away.

2. **New non-fatal code `EVENT_ALREADY_GONE`.** Distinct from success (`ok:true, data.deletedEventId`) and from failure (`ok:false, code:'GOOGLE_API_ERROR'`). The tool returns:
   ```typescript
   {
     ok: true,                    // still "success" from the caller's POV — nothing to retry
     output: <the new string above>,
     data: {
       calendarId,
       deletedEventId: input.eventId,
       outcome: '404-already-gone',   // NEW — audit dispatcher picks this up
     },
   }
   ```
   The `data.outcome` field (values: `'deleted' | '404-already-gone'`) carries the distinction through to the `tool_call` audit row's `detail.result`, so `/audit filter tool_call` can tell the two cases apart.

3. **Pre-check remains OFF by default.** Decision 14's "no pre-check" posture stands; the pre-check would be a second API call that doesn't actually prove delete permission (Google's 403 is authoritative at delete time). The distinguishable-output path (1) and the audit-trail path (2) resolve the telemetry concern without adding a speculative GET.

4. **System-prompt rule 13 (decision 17) mentions the hedge.** A one-line addition: "`calendar_delete_event` returns `data.outcome: '404-already-gone'` when Google reports the event was not found. When relaying this to the user, do NOT say 'I deleted the event' — say 'the event is already gone (or the id may have been wrong — here's the id I tried: X)' so the user can double-check."

**Test coverage** (added to the v1.11.0 suite):
- `calendar_delete_event` with eventId that doesn't exist → Google returns 404 → tool returns `ok:true, output:<EVENT_ALREADY_GONE text>, data.outcome:'404-already-gone'`.
- Same with a valid eventId → tool returns `ok:true, data.outcome:'deleted'`.
- Audit row for each distinguishes `result` via the dispatcher's capture of `data.outcome`.

**BLOCKING status:** resolved.

---

### R2 (HIGH, BLOCKING — supersedes decision 15) — Drop `CALENDAR_DISABLED_FOR_CHAT` self-check; rely on agent-level filter (DA-C2 + Anti-Slop R2)

**Concern.** Two converging findings:

  - **Anti-Slop R2 (FAIL-adjacent):** `calendar_create_event.ts` does NOT self-check `isCalendarEnabledForChat`. The `/calendar off` enforcement lives at `src/agent/index.ts:513–515` where all tools whose name starts with `calendar_` are stripped from the active tool list. Adding a self-check to the new tools would be dead code — the tool never runs when calendar is off.
  - **DA-C2 (BLOCKING):** Even if the self-check could fire, a hard-refuse on `calendar_*` while `organize_*` applies-locally-and-warns under `/calendar off` is a posture contradiction that rule 13 doesn't disambiguate. User mental model breaks: "I moved one meeting fine; why won't Jarvis cancel this one?"

Both reviewers point at the same dead code. The fix simplifies the ADR.

**Decision.** Revise decision 15:

> The new `calendar_update_event` and `calendar_delete_event` tools do NOT self-check `isCalendarEnabledForChat(ctx.chatId)`. `/calendar off` enforcement happens ONE LEVEL UP at `src/agent/index.ts:513–515`, which strips every tool whose name starts with `calendar_` from the active tool list for that chat. When `/calendar off` is in effect, the LLM does not see these tools — no execution path is ever reached, so a tool-level check would be unreachable.
>
> This matches the existing `calendar_create_event.ts` pattern exactly. The `organize_*` tools DO self-check because they have a dual-mode need (continue local changes with `/calendar off`; skip Calendar sync with a warning). The `calendar_*` tools have no such need — there is no "local-only mode" for a tool that ONLY touches Calendar.
>
> The `CALENDAR_DISABLED_FOR_CHAT` error code is REMOVED from the new tools' error set. Remaining codes: `EVENT_NOT_FOUND`, `GOOGLE_API_ERROR`, `GOOGLE_NOT_AUTHORISED`, `EVENT_ALREADY_GONE` (from R1).

Rule 13 (decision 17) also updates — DA-C2 resolution now that posture is consistent across families:

  > **`/calendar off` behavior is symmetric-in-effect but different mechanism:** when calendar is OFF for the chat, `calendar_update_event` and `calendar_delete_event` are not in your active tool list (agent-level filter strips them). `organize_update` and `organize_delete` remain in the list but apply local changes only and skip Calendar sync with a warning. If the user asks you to modify a calendar-only event (no organize-item anchor) while `/calendar off` is active, explain that `/calendar off` is in effect and suggest `/calendar on` (or `/organize-track`-ing the event into a local item first if they want the organize sync-when-available path).

**Consequences.**
- Net scope reduction: 15 lines removed from decision 15; 3 lines added to rule 13.
- Zero dead code ships; developer agents read the clarified ADR and implement the same pattern as `calendar_create_event`.

**BLOCKING status:** resolved.

---

### R3 (FAIL-adjacent — supersedes decision 3's parser claim) — `parseItemFile` extended to read `deletedAt` (Anti-Slop R1)

**Concern.** Decision 3 claimed `parseItemFile` "already treats unknown keys as pass-through." Verified false: the parser reads front-matter into a transient `kv: Record<string, string>` (storage.ts:200–207) but constructs the returned `OrganizeFrontMatter` from a FIXED list of known keys (storage.ts:253–263). Unknown keys are silently dropped. A Phase-2 dev agent taking decision 3 literally would write the serializer-only change and ship a silent no-op: every file's `deletedAt` is written on soft-delete but nothing reads it back — every eviction falls through to the mtime fallback, defeating the stated purpose.

**Decision.** Decision 3 is patched in three places to make the parser extension explicit:

1. **`src/organize/types.ts`** — add optional field to `OrganizeFrontMatter`:
   ```typescript
   export interface OrganizeFrontMatter {
     // ... existing fields
     /** v1.11.0 — ISO timestamp set by softDeleteItem; absent on live items and on legacy (pre-v1.11.0) trashes. */
     deletedAt?: string | null;
   }
   ```

2. **`src/organize/storage.ts` `parseItemFile`** — add one new extraction line after the `due` handling at storage.ts:226–227:
   ```typescript
   const rawDeletedAt = kv['deletedAt']?.trim() ?? '';
   const deletedAt = rawDeletedAt.length > 0 ? rawDeletedAt : null;
   ```
   And include `deletedAt` in the returned `fm` construction at storage.ts:253. Missing or empty → `null`, same posture as `due`.

3. **`src/organize/storage.ts` `serializeItem`** — emit `deletedAt: <iso>` between `calendarEventId` and `tags`, but ONLY when non-null. Null/undefined → omit the line entirely so live items and legacy-migrated items don't gain an empty `deletedAt:` line on every save.

4. **Legacy fallback path stays** — if a `.trash/<id>.md` file has no `deletedAt` (pre-v1.11.0 trash), `evictExpiredTrash` falls back to `fs.stat(path).mtime`. Decision 3's original fallback rationale is unchanged.

**Test coverage** (added to `tests/unit/organize.storage.test.ts` + `organize.trashEvictor.test.ts`):
- Round-trip: `softDeleteItem` → readFile(trashedPath) → parseItemFile → `fm.deletedAt` is the ISO timestamp written at delete time.
- Legacy read: write a trashed file by hand without `deletedAt` → parseItemFile returns `fm.deletedAt === null` → evictor uses mtime fallback.
- Serializer: live item (no deletedAt set) → serialized output has NO `deletedAt:` line (bit-exact match against fixture).

**FAIL-adjacent status:** resolved.

---

### R4 (stale claim — supersedes decision 8 step 5) — Token counts already persisted; drop the "add them" branch (Anti-Slop R3)

**Concern.** Decision 8 step 5 said "Verify token counts are persisted today — if ADR 004 §11 rows don't currently carry input/output token counts, developer agent adds them." Verified false: `src/organize/reminders.ts:316–317` already writes `inputTokens` and `outputTokens` (field names WITHOUT leading underscore; the ADR's rigor text wrote `_inputTokens` / `_outputTokens` — misleading).

**Decision.** Decision 8 step 5 rewritten:

> 5. **Tally tokens per (model, local-YMD).** The `organize.nudge` audit detail ALREADY carries `inputTokens: row.inputTokens ?? null` and `outputTokens: row.outputTokens ?? null` (verified at `src/organize/reminders.ts:316–317`). Field names are without leading underscore. The aggregation reads `detail.inputTokens` and `detail.outputTokens` directly. Rows where either is `null` (e.g., provider didn't return token counts on failure) fall into a "unknown token usage" bucket that surfaces in the output as a separate line; see R5 below for the pre-v1.11.0-row handling.

No schema extension. No silent shape change.

**Stale-claim status:** resolved.

---

### R5 (MEDIUM — supersedes the nag-cost cost-math for pre-v1.11.0 rows, with DA-C8 date stamp) — Handle null tokens + surface pricing date (DA-C8 + DA-C9)

**Concern.** DA-C9 worried about a silent shape drift at deploy boundary. R4 shows the shape is ALREADY consistent (no boundary exists). But a related concern from DA-C8 is real: the `TOKEN_COSTS_USD_PER_MTOK` numbers are a point-in-time snapshot of Anthropic's price card; nothing surfaces WHEN the snapshot was taken, so a user looking at "$0.0041 this week" can't tell if that's 2 months stale.

Plus DA-C9's underlying mechanical concern: some rows may have `inputTokens: null` (provider failure case). Those should not silently be treated as 0-cost; they should be counted and flagged.

**Decision.**

1. **Add `TOKEN_COSTS_USD_PER_MTOK_AS_OF` constant** in `src/commands/organizeNagCost.ts`:
   ```typescript
   /** ISO date (YYYY-MM-DD) at which the pricing numbers below were last verified against Anthropic's card. */
   const TOKEN_COSTS_USD_PER_MTOK_AS_OF = '2026-04-24';
   ```
   Phase-2 developer agent sets this to the implementation-verification date (should match ship date of v1.11.0).

2. **Surface the as-of date in nag-cost output** as a trailing line:
   ```
   Prices as of 2026-04-24. Check anthropic.com/pricing for current rates; update
   TOKEN_COSTS_USD_PER_MTOK in src/commands/organizeNagCost.ts when the card moves.
   ```
   One extra line; bounded by the Telegram message envelope that's already trimmed to 14-day detail.

3. **Handle `inputTokens: null` or `outputTokens: null` cleanly.** Rows where EITHER is null go into a `tokensUnknown` counter (separate from `skipped`), rendered as:
   ```
   N nudges (2 with unknown token counts; cost unknown for those).
   ```
   Rows where BOTH are non-null contribute to the per-model cost tally.

4. **Fallbacks breakdown line** (also surfaces DA-C8's mis-read-as-policy risk): the output already aggregates by model, so users can see "5 Haiku rows this week (3 from Ollama-429 fallbacks)" as a distinct signal. Cost output shows fallback count explicitly.

**Test coverage:**
- Two rows, one with full tokens, one with `inputTokens: null` → aggregate shows 1-costed + 1-unknown.
- All rows with null tokens → "N nudges; cost unknown for all" path.
- Output contains `TOKEN_COSTS_USD_PER_MTOK_AS_OF` date verbatim.

---

### R6 (MEDIUM — supersedes decision 6) — Add `(category, actor_user_id, ts)` index as migration 010 (DA-C7)

**Concern.** Decision 6's hedge "add the index if profiling shows it matters" is the wrong posture. Adding an index at ship is free (<100ms on current row count). Deferring means future-me remembers to profile, finds the slow query, writes a migration, ships it, waits for a version bump. Worse: `/organize nag cost` and `/organize reconcile` are user-facing at Telegram's 2–5s latency budget, so the cost of "a scan got slow and nobody noticed until a user complained" is a real user-impact moment.

**Decision.** Add a new migration file `src/memory/migrations/010_audit_category_actor_ts_idx.sql`:

```sql
-- v1.11.0 — index supporting /organize reconcile (organize.inconsistency queries)
-- and /organize nag cost (organize.nudge queries). Also benefits any future
-- category-scoped aggregation (per-category audit summaries, compliance sweeps).
CREATE INDEX IF NOT EXISTS idx_audit_category_actor_ts
  ON audit_log(category, actor_user_id, ts DESC);
```

Column order is optimal for the query pattern `WHERE category = ? AND actor_user_id = ? AND ts >= ? ORDER BY ts DESC`.

Migration is idempotent (`IF NOT EXISTS`) and runs on boot via the existing migration runner. Cost at current audit_log row count: sub-100ms. Cost at 100k rows: <1s. Cost of the same query without the index at 100k rows: 100–300ms per call — user-visible.

**Test coverage:** migration is idempotent (running twice is a no-op); new query via `listByCategoryAndActorSince` uses the index (EXPLAIN QUERY PLAN verification in the test).

---

### R7 (MEDIUM — supersedes decision 10) — Evictor wall-time warn + `filesScanned` audit detail + error-code tuples (DA-C10 + Anti-Slop W4)

**Concern.** DA-C10: the evictor has the same silent-degradation shape that reminders.ts had in v1.9.0 → v1.9.1. A 4am cron that runs for 5 minutes is fine; one that runs for 2 hours because a directory bloated is silent-bad. Reminders got `wallTimeWarnRatio` + `wallTimeWarnMs` knobs; the evictor should get them too.

Anti-Slop W4: `errors: Array<{path, err: string}>` uses a free-form message where the rest of the codebase uses `{code, message}` tuples. Parity with `organize_delete`, `calendar_create_event`, etc., improves audit-log consumers.

**Decision.**

1. **Wall-time warn.** Add to `config.organize.trashEvictWallTimeWarnMs` (default `600000` = 10 minutes, range [60000, 3600000]). In `trashEvictor.ts`:
   ```typescript
   const elapsedMs = Date.now() - startedAt;
   if (elapsedMs > config.organize.trashEvictWallTimeWarnMs) {
     log.warn({elapsedMs, warnMs, usersProcessed, evicted, errors},
       'Trash eviction exceeded wall-time warn threshold');
   }
   ```
   Mirrors the v1.9.1 reminders `wallTimeWarnRatio` pattern but absolute-milliseconds instead of ratio (trash evictor's cadence is daily, not every-2-hours, so ratio doesn't fit as cleanly).

2. **`filesScanned` in audit detail.** Extend `organize.trash.evict` detail shape (decision 11):
   ```typescript
   {
     userId: number,
     evicted: number,          // files unlinked (> 0 per emission rule)
     filesScanned: number,     // NEW — total .md files in .trash/ for this user, regardless of TTL
     errors: number,           // count only
     ttlDays: number,
     elapsedMs: number,
   }
   ```
   `filesScanned >> evicted` signals a trash dir that's mostly within-TTL files (usage pattern feedback, not a bug).

3. **Error-code tuples in `evictExpiredTrash`.** Revise the return type:
   ```typescript
   type EvictError = {
     code: 'READ_FAILED' | 'STAT_FAILED' | 'UNLINK_FAILED' | 'PARSE_FAILED',
     message: string,
   };
   export async function evictExpiredTrash(
     userId: number, dataDir: string, ttlDays: number, now?: Date
   ): Promise<{ evicted: number; filesScanned: number; errors: Array<{path: string; err: EvictError}> }>;
   ```
   Each failure path tags with its code; audit consumer can differentiate. The `errors: number` in the audit detail is still a count; per-path details go to `log.warn` with the code as a field.

4. **Abort-signal scope.** Decision 10 said "at user boundary." Clarification added: v1.11.0 checks abort at user-boundary only. Per-file abort (for pathological 10k-item-per-user trashes) deferred to v1.11.1+ with a TODO comment. At deployed scale (O(10) items per user), user-boundary is sufficient.

---

### R8 (MEDIUM — supersedes decision 2) — Reconcile cap shows total + warns on hot emitter (DA-C4)

**Concern.** 20-item cap is right for the user but hides a bug-in-/organize signal: if an upstream tool creates inconsistencies faster than the user resolves them, the reconcile ritual becomes a treadmill with no visible accumulation.

**Decision.** Revise decision 2:

1. **Summary line shows total:** when the 30-day window has more than 20 items:
   ```
   Showing 20 of N total inconsistencies. Run /organize reconcile again after
   handling these to see more. If N is growing across invocations, something
   in /organize may be emitting inconsistencies faster than you can resolve.
   ```

2. **Hot-emitter warning:** if `N >= 100`, prepend:
   ```
   ⚠ Your /organize has emitted 100+ inconsistency rows in 30 days. This may
     indicate a bug in the organize tools. Check /audit filter organize.inconsistency
     for the pattern.
   ```
   `100` is an arbitrary threshold; tunable via `config.organize.reconcileHotEmitterThreshold` (default 100, range [10, 10000]).

3. **Audit on hot-emitter detection:** log at WARN when the threshold fires (captures the state in the audit trail for post-hoc analysis).

**Test coverage:** 25-item scenario → summary shows "Showing 20 of 25..."; 100-item scenario → hot-emitter warning prepends.

---

### R9 (MEDIUM — supersedes decision 4) — Reconcile callback pre-action verification + audit rejects (DA-C6)

**Concern.** The callback handler today (as specified) validates itemId SHAPE (regex match) but not EXISTENCE-OF-INCONSISTENCY. A stale message (from days ago), a replay, or a prompt-injection-driven fake callback could hit the handler and mutate state. The callback carries no nonce/HMAC.

**Decision.** Revise decision 4 with a pre-action verification step:

1. **Before acting, the handler must verify an active inconsistency exists:**
   ```typescript
   // Pseudocode
   const recentInconsistencies = auditRepo.listByCategoryAndActorSince(
     'organize.inconsistency', userId, iso30DaysAgo
   );
   const recentResolutions = auditRepo.listByCategoryAndActorSince(
     'organize.reconcile', userId, iso30DaysAgo
   );
   const unresolvedForItem = recentInconsistencies.filter(r =>
     parseDetail(r).itemId === itemId &&
     !recentResolutions.some(res =>
       parseDetail(res).itemId === itemId &&
       parseDetail(res).originalInconsistencyTs === r.ts
     )
   );
   if (unresolvedForItem.length === 0) {
     await ctx.answerCallbackQuery({text: 'Nothing to reconcile for this item.'});
     await ctx.editMessageReplyMarkup(undefined).catch(() => {});
     // Emit a rejected-action audit row:
     auditRepo.insert({category: 'organize.reconcile', actor_user_id: userId, ...,
       detail: {action: 'skipped', itemId, result: 'no-op',
                reason: 'no-active-inconsistency', originalInconsistencyKind: 'unknown',
                originalInconsistencyTs: new Date().toISOString()}});
     return;
   }
   ```
   The handler also cross-checks disk state (does the file exist vs. doesn't) before taking the fix action, so a "resolved elsewhere since the message was sent" path exits gracefully.

2. **Audit-log rejected callbacks:** the callback is an attack surface (however low-probability). Audit-logging every invocation — including rejected ones — keeps the defense visible. The `reason` field on the `organize.reconcile` detail shape (decision 5) gains a new union member: `'no-active-inconsistency' | 'state-already-consistent' | <existing>`.

3. **Keyboard removal.** On both fix-success AND fix-rejection, the handler calls `ctx.editMessageReplyMarkup(undefined).catch(() => {})` so the user can't double-tap.

**Test coverage:**
- Callback with itemId having no audit trail → rejection + audit row with `reason: 'no-active-inconsistency'`.
- Callback with itemId whose drift was already resolved (a later matching `organize.reconcile` row exists) → rejection + audit with `reason: 'state-already-consistent'`.
- Callback with valid itemId + active inconsistency → fix runs, removes keyboard, emits success audit row.

---

### R10 (MEDIUM — supersedes decision 13's attendees semantics) — Rule 13 partial-update guidance (DA-C3)

**Concern.** `attendees: []` clears the list; `attendees: ['alice@…']` REPLACES the full list. LLMs will mix "add alice" vs. "set attendees to alice" about half the time when the user's phrasing is ambiguous, leading to silent attendee loss.

**Decision.** Append to rule 13 (decision 17):

> **Partial-update semantics for `calendar_update_event`:** field-level patch with the following conventions:
>
>   - Omit a field → leave it unchanged.
>   - Pass empty string (`description: ''`, `location: ''`) → clear that field.
>   - Pass empty array (`attendees: []`) → clear the attendee list.
>   - Pass a non-empty array (`attendees: ['alice@…']`) → REPLACE the full list. Not "add alice."
>
> If the user asks "add Kim to the dentist meeting," you MUST first retrieve the existing attendees via `calendar_list_events` (or use a recent listing in your context) and pass the UNION — existing + Kim — as the attendees array. Silent attendee loss is worse than asking a clarifying question.

Developer agent verifies the current `CalendarApi.updateEvent` (`src/google/calendar.ts:176–200`) actually does "present empty array → patch to empty" — if it drops empty arrays instead, the rule 13 text needs adjustment. Verification is a one-liner test.

**Test coverage:**
- Update with `attendees: []` → Google's `events.patch` sees `attendees: []` → attendee list cleared.
- Update with `attendees: ['new@example.com']` → existing attendees replaced (NOT merged).
- Update with no `attendees` key → attendees left unchanged on Google's side.

---

### R11 (MEDIUM — supersedes Anti-Slop W7) — Reconcile handler goes in `src/commands/reconcileHandler.ts`

**Concern.** Decision 2 said "a new module or a new function in organize.ts — developer agent chooses." Ambiguous. The existing precedent for inline-keyboard handlers is `src/plan/panel.ts` sitting alongside `src/commands/plan.ts` (panel emits the keyboard + owns the callback semantics; the command file orchestrates). Match this.

**Decision.** Phase-2 developer agent creates `src/commands/reconcileHandler.ts` (new file) containing:
- `buildReconcileListing(userId, dataDir, memory, deps): Promise<...>` — reads inconsistency rows, correlates to current state, returns the renderable list (up to 20 items) + summary line.
- `handleReconcileCallback(data: string, ctx: Context, deps): Promise<{toast: string}>` — the callback handler with pre-action verification (R9).
- Small helpers for formatting item descriptions into the message-per-item shape.

`src/commands/organize.ts`'s `reconcile` subcommand dispatches to `buildReconcileListing` and sends the per-item messages. Gateway's `callback_query:data` handler routes `rec:*` to `handleReconcileCallback`.

---

### R12 (LOW + documentation — sweeps W11, W12, W14, W15, W2, W5, W6, W8, W9, W10, W13, DA-C5, DA-C11) — Documentation + minor cleanups

Grouped for scan-ability:

1. **W14 + W11 — `config/config.example.json` and `KNOWN_ISSUES.md` sweep:** Phase-2 adds entries under `organize.*`:
   ```json
   "trashTtlDays": 30,
   "trashEvictCron": "0 4 * * *",
   "trashEvictWallTimeWarnMs": 600000,
   "reconcileHotEmitterThreshold": 100
   ```
   (The last two added via R7 + R8 above.) Phase-5 Docs agent adds a brief v1.11.0 note to `docs/KNOWN_ISSUES.md` covering the `deletedAt` schema addition + the legacy-trash mtime fallback + the hot-emitter threshold intent.

2. **W15 — §19 rollback phrasing update:** change "four items in a short commit chain" to "v1.11.0 ships as ~10 commits (schema + helper + each item + tests + version bump)." The `git revert v1.11.0..HEAD` form is still correct; the "short chain" label was aspirational.

3. **W2 — line ref fix:** decision 1 references `tickAllUsers` "reminders.ts:856" → correct to `reminders.ts:844–858`. One-character fix.

4. **W5 — USD precision note:** decision 7 adds: "TOKEN_COSTS_USD_PER_MTOK values are `number` type (float); 4-decimal pricing (e.g. `$1.1500`) is supported without type change."

5. **W6 — evictor isolation scope clarification:** decision 1 adds: "`trashEvictor.ts` is the cron orchestrator (owns the schedule + start/stop lifecycle); file-operations logic lives in `evictExpiredTrash` at `src/organize/storage.ts` (same-family import, matches the existing reminders.ts→storage.ts edge). Module isolation is at the SCHEDULING layer, not the file-operations layer."

6. **W8 — reference block clarification:** decision §References adds one line: "ADR 005's initial 'reuse admin_command for scheduler audit rows' was superseded in `005-revisions-after-cp1.md` with distinct `scheduler.*` categories. v1.11.0 similarly adds distinct `organize.reconcile` + `organize.trash.evict` categories (decisions 5, 11) AND correctly reuses `tool_call` for calendar-tool audits (decision 16) via the dispatcher."

7. **W9 — §19 ARCHITECTURE.md stub:** Phase-2 developer agent writes a 50-line §19 stub capturing the four-item summary + each item's file-level footprint. Full §§19.1–19.4 subsections deferred to Phase 5 Docs agent.

8. **W10 — decision 15 folding:** now resolved by R2 (decision 15 is largely deleted; the "no group-chat redirect needed" note moves into decision 13's introduction as a one-liner).

9. **W12 — decision 1 "no edges" bullet:** decision 1 explicitly lists `trashEvictor.ts` imports: `src/organize/storage.ts` (for `evictExpiredTrash`), `src/memory/auditLog.ts` (for the category), `src/config/` (for the knobs), `node:fs/promises` + `node:path`, pino logger. No imports from `src/agent/`, `src/gateway/`, `src/scheduler/`, `src/tools/`, `src/commands/`.

10. **W13 — `/organize nag cost` audit emission:** defer to developer agent; the command is read-only and idempotent. If added, use `admin_command` with `detail: {tool: 'organize.nag.cost', days, totalCostUsd, modelsSeen}`. Low stakes.

11. **DA-C5 — `deletedAt` vs. mtime-only path:** architect's choice (extend serializer + mtime fallback) STANDS. DA's mtime-only-plus-utimes path is simpler but loses the in-file human-readability that matters if a user ever opens a trash file by hand. Trade-off accepted; R3 above closes the parser-completeness gap that was the actual concrete issue. Decision 3 adds one sentence: "The rewrite-before-rename path in softDeleteItem expands the write window marginally (read + serialize + write + rename) vs. the rename-only path, but remains last-writer-wins and soft-delete is user-initiated and rare."

12. **DA-C11 — rule 13 reordering + scheduled-task-vs-meeting disambiguation:** decision 17 rewrites the "How to choose" paragraph to lead with the common case (match against open-items block first) and adds:
    > "If the user says 'my scheduled task,' default to `/scheduled` (recurring task). If they say 'my scheduled meeting/event/appointment,' default to the calendar family. If genuinely ambiguous, ask."

---

### R13 (LOW — supersedes decision 11) — Config knob `trashEvictAuditZeroBatches` for future compliance (DA-C12)

**Concern.** Single-user deployment doesn't need zero-batch audit rows; a future compliance-forward deployment (GDPR right-to-be-forgotten, data-retention provability) would.

**Decision.** Add `config.organize.trashEvictAuditZeroBatches: boolean` (default `false`). When true, `evictAllUsers` emits a `organize.trash.evict` audit row per user even when `evicted === 0 && errors === 0` (with the same detail shape). Default preserves architect's original choice; operators flip for compliance needs without a code change.

---

## New risks added to §18 risk register

From DA's new-risks list (R_DA_1–R_DA_7), the seven items map to resolutions above. Adding to the register:

| Risk | Severity | Mitigation |
|---|---|---|
| Callback pre-action verification gap | MEDIUM | R9 — handler verifies active inconsistency before acting; audits rejected attempts. |
| `/calendar off` posture asymmetry between tool families | MEDIUM (was HIGH before resolution) | R2 — different mechanism (tool filter vs. self-check) produces consistent effect; rule 13 explains for the LLM. |
| 404-on-delete typo indistinguishability | MEDIUM (was HIGH) | R1 — distinguishable output string + `data.outcome: '404-already-gone'` preserves the signal through audit trail. |
| organize.nudge pre-v1.11.0 rows had no token counts | LOW (downgraded after R4) | R4 — token counts were already persisted; R5 handles null-token rows cleanly. |
| System-prompt rule-set polynomial growth | LOW (v1.11.0) / MEDIUM (v1.12.0+) | Consolidation pass deferred to v1.12.0 pre-ship. v1.11.0 adds ~30 rule-13 lines after R1 + R2 + R10 additions. |
| audit_log un-indexed on (category, actor_user_id, ts) | resolved at ship | R6 — migration 010 adds the index. |
| Reconcile queue masks upstream bugs | MEDIUM | R8 — total count shown; hot-emitter warn threshold. |

---

## Revised verdict — ready for Phase 2

All 2 BLOCKING (DA-C1, DA-C2) and 2 FAIL-adjacent (Anti-Slop R1, R2) items are resolved with concrete ADR text changes above. All 8 MEDIUM concerns are addressed either via direct revisions (R1–R11) or via the W-group in R12. LOW items are either resolved (R13) or documented-only.

**Phase 2 may start.** Developer agents implement against ADR 006 + this revisions file. Deviations require another addendum.

**Implementation order for Phase 2** (suggested, not binding — developer agents may reorder where safe):

1. **Schema layer.** `src/memory/migrations/010_audit_category_actor_ts_idx.sql`, `src/memory/auditLog.ts` (two new categories + `listByCategoryAndActorSince` helper), `src/organize/types.ts` (+`deletedAt`), `src/organize/storage.ts` (parser + serializer + softDeleteItem rewrite + evictExpiredTrash).
2. **Item 3 (trash evictor).** `src/organize/trashEvictor.ts`, `src/index.ts` boot wiring, config schema.
3. **Item 4 (calendar tools).** `src/tools/calendar_update_event.ts`, `src/tools/calendar_delete_event.ts`, `src/tools/index.ts` registration.
4. **Item 1 (reconcile).** `src/commands/reconcileHandler.ts`, `src/commands/organize.ts` dispatch, `src/gateway/index.ts` callback branch.
5. **Item 2 (nag cost).** `src/commands/organizeNagCost.ts`, `src/commands/organize.ts` dispatch.
6. **System-prompt rule 13.** `config/system-prompt.md`.
7. **Tests.** Per the test-coverage callouts in R1–R11.
8. **Docs.** `docs/ARCHITECTURE.md` §19 stub, config examples, KNOWN_ISSUES.

Phase-2 Anti-Slop + Scalability + QA run against the implementation in parallel after CP2.
