# ADR 020 — Revisions after CP1 (Devil's Advocate + Anti-Slop Phase 1)

**Status:** Proposed (CP1 complete; Phase 2 ready).
**Date:** 2026-04-25.
**Supersedes for v1.20.0 only:** Specific decisions of ADR 020 noted per section. ADR 020 still binds for everything not amended here.
**Header note for reviewers:** This is a **delta document**, not a rewrite. Each section names which ADR 020 Decision# it amends, the reviewer reference (DA R# / Anti-Slop F# / W#), and the concrete remediation. Phase 2 commit ordering at the end of this doc is BINDING; ADR 020's Phase 2 ordering is superseded.

---

## CP1 verdict snapshot

- **Devil's Advocate:** 3 BLOCKING + 2 downgraded. R1 — gateway plumbing trap class on the NEW spontaneous-fire path (4th iteration after v1.18.0 commit `ea0a8fd`, v1.19.0 W2 carry-forward, v1.19.0 W2.b chat-side gating). R2 — boot-wiring static test scope insufficient (catches 9 stub patterns; misses 3 + a "shape-without-wiring" trap). R3 — marker migration boot ordering + missing audit categories. R4 (downgraded) — quiet mode UX asymmetry confusing. R5 (downgraded) — calendar trigger felt-intrusive timing.
- **Anti-Slop Phase 1:** PASS WITH WARNINGS (0 FAIL + 2 WARN). LOC discipline + boot-wiring spec held cleanly — strong progress on the 5th-iter LOC trap class and 4th-iter boot-wiring trap class. W1 — `TriggerRecord.reason` convention-gated (free-form string risks bypassing v1.19.0 R1 Layer (b) `<untrusted>` wrap when injected as `${trigger_context}`). W2 — 3 new module edges ambiguous in the catch-all "extend coach-no-reverse-import.test.ts" spec.

All resolved by the revisions below. **Two new commits land as a result: NEW commit 9.5 (gateway-plumbing static test) and NEW commit 11.5 (cross-file reachability lint). Migration boot ordering folds into commit 1 + adds a static-test assertion (commit 0a' inside the existing 0a scaffold). 22 → 24 commits total.**

R4 + R5 (downgraded by DA) are addressed inline because the revisions doc is open and the cost is low. R4 → user-facing helper text addition; R5 → `delayMs` constant on calendar trigger dispatch.

---

## Resolved (R/F/W-numbered, ordered by Phase 2 commit ordering)

### R1 (DA-CRITICAL BLOCKING — supersedes ADR 020 Decision 7) — Spontaneous-fire path MUST pass `isCoachRun: true` AND `coachTurnCounters` AND `isSpontaneousTrigger`; SOLE-SOURCE helper enforces

**The trap (DA finding).** ADR 020 D7 specified `fireSpontaneousCoachTurn` passes `coachTurnCounters: { nudges: 0, totalWrites: 0 }` AND `isSpontaneousTrigger: true` to `agent.turn()`. Verified at `src/agent/index.ts:591`:

```ts
const coachTurnCounters: { nudges: number; writes: number } | undefined =
  params.isCoachRun ? { nudges: 0, writes: 0 } : undefined;
```

**`coachTurnCounters` is initialized iff `params.isCoachRun === true`.** The agent ignores any caller-passed counters; it constructs its own. Without `isCoachRun: true`, `coachTurnCounters` stays `undefined`, the dispatcher's `UNAUTHORIZED_IN_CONTEXT` brake against `disabledTools` goes inert, AND the v1.18.0 R3 per-turn nudge cap (5) + total-writes cap (10) go inert. Spontaneous-fire path becomes a backdoor for a coach turn to call `run_command` or `organize_complete` or schedule a new task — the exact thing v1.18.0 R6/F1 was BLOCKING for.

**Same trap class as:**
- v1.18.0 commit `ea0a8fd` — original gateway plumbing fix (3 fix-cycle iterations to land).
- v1.19.0 R3/W1 — chat-side `coach_log_user_override` correctly DOES NOT pass counters (chat-side calls don't gate per v1.18.0 R3 invariant 5) — different gating direction, same load-bearing seam.
- v1.19.0 W2 — RA1 institutional-memory carry-forward of "any new scheduled-fire entry point MUST thread coachTurnCounters."

This is the **4th iteration of the trap class on a NEW path** that v1.20.0 introduces.

**Pick — single-source-of-truth helper + static lint.**

Add a NEW helper `buildCoachTurnArgs` in `src/coach/index.ts` (~25 LOC) that returns the canonical TurnParams shape for both coach entry points:

```ts
// src/coach/index.ts
export interface CoachTurnArgsOpts {
  /** True when the turn is fired by an event trigger (D6); false for scheduled cron. */
  isSpontaneousTrigger?: boolean;
  /** Populated trigger context string for spontaneous fires; empty for cron fires. */
  triggerContext?: string;
}

/**
 * Single source of truth for the canonical coach-turn TurnParams shape.
 *
 * BINDING (R1 — CP1 revisions): every coach-turn entry point — the scheduled cron
 * path AND the spontaneous-trigger path — MUST go through this helper. Direct
 * construction of the three flags inline is forbidden by tests/static/coach-turn-args.test.ts.
 *
 * Returns the three load-bearing flags the agent uses to gate coach-turn behavior:
 *   - isCoachRun: true  → activates coachTurnCounters initialization at agent/index.ts:591,
 *                          which in turn activates the dispatcher's UNAUTHORIZED_IN_CONTEXT brake
 *                          against `coach.disabledTools` (R6/F1 v1.18.0 invariant) AND the per-turn
 *                          nudge cap (5) + total-writes cap (10) (R3 v1.18.0 invariant).
 *   - coachTurnCounters: { nudges: 0, writes: 0 } → caller-passed counters are IGNORED by the agent
 *                          (the agent constructs its own iff isCoachRun is true). Included here for
 *                          documentation symmetry + future-proofing if the agent's logic changes.
 *   - isSpontaneousTrigger: true|false → gates D15 prompt behavior: spontaneous fires focus on the
 *                          single triggered item; scheduled fires run the full Step 0 → multi-item picker.
 *
 * Each flag does a different thing. Removing any one inverts a load-bearing brake.
 */
export function buildCoachTurnArgs(opts: CoachTurnArgsOpts = {}): {
  isCoachRun: true;
  coachTurnCounters: { nudges: number; writes: number };
  isSpontaneousTrigger: boolean;
  triggerContext: string;
} {
  return {
    isCoachRun: true,
    coachTurnCounters: { nudges: 0, writes: 0 },
    isSpontaneousTrigger: opts.isSpontaneousTrigger ?? false,
    triggerContext: opts.triggerContext ?? '',
  };
}
```

Both consumers:

- **Scheduled cron path** (`gateway.enqueueSchedulerTurn` — extended; existing v1.18.0 wiring at `scheduler/index.ts:262-274` already constructs `coachTurnCounters` for `__coach_*__`-marked tasks per v1.18.0 ea0a8fd; **the helper REPLACES that inline construction**) — calls `buildCoachTurnArgs({ isSpontaneousTrigger: false })`.
- **Spontaneous-fire path** (`gateway.fireSpontaneousCoachTurn` — NEW per ADR 020 D7) — calls `buildCoachTurnArgs({ isSpontaneousTrigger: true, triggerContext: <populated> })`.

Both spread the result into `agent.turn(...)` params.

**NEW static test `tests/static/coach-turn-args.test.ts` (~40 LOC, commit 9.5).** Greps `src/**/*.ts` for direct calls to `agent.turn(`. For each call site whose immediate caller name matches `/.*[Cc]oach.*/` OR whose enclosing function passes `isCoachRun` literally OR is the scheduler-fire dispatch path (matched by `description === COACH_TASK_DESCRIPTION` OR `isCoachMarker(description)` proximity), the test asserts the call goes through `buildCoachTurnArgs(...)` (i.e., the spread `...buildCoachTurnArgs(...)` appears in the same call expression). FAIL if any coach-turn call inlines the three flags.

The test is intentionally CONSERVATIVE: it errs on the side of false positives (would also flag tests that mock `agent.turn` with literal `isCoachRun: true` — those tests must ALSO use the helper, which is correct behavior).

**Why a helper, not just a docs invariant** (binding):

1. The v1.18.0 trap took 3 fix-cycle iterations to land. The v1.19.0 W2 invariant (carry-forward "remember to thread coachTurnCounters") was a docs invariant; it worked for v1.19.0 because v1.19.0 added no new scheduled-fire entry points. v1.20.0 adds ONE. A docs invariant alone is NOT enough — v1.18.0 R6/F1 set the precedent: "models slip; prompt-clauses are documentation, not a brake."
2. The helper is code-gated. Adding a 5th coach-turn entry point in v1.21.0+ that bypasses the helper FAILS the static test.
3. The helper documents WHY each flag matters, in one place. Future Dev-B doesn't need to reason about three flags interacting; they call one helper.

**Tests required (commit 9.5):**

- T-R1-1 — `buildCoachTurnArgs()` (no args) returns `{ isCoachRun: true, coachTurnCounters: { nudges: 0, writes: 0 }, isSpontaneousTrigger: false, triggerContext: '' }`.
- T-R1-2 — `buildCoachTurnArgs({ isSpontaneousTrigger: true, triggerContext: 'foo' })` returns `{ isCoachRun: true, coachTurnCounters: ..., isSpontaneousTrigger: true, triggerContext: 'foo' }`.
- T-R1-3 — Static lint asserts every coach-turn call to `agent.turn(...)` spreads `buildCoachTurnArgs(...)`. Fixture file containing direct `{ isCoachRun: true, ... }` triggers FAIL.
- T-R1-4 — Integration test: spontaneous fire from `fireSpontaneousCoachTurn` triggers a coach turn whose `coachTurnCounters` is initialized at agent/index.ts:591 (asserted via tool-dispatcher mock that observes counters being passed through ToolContext).
- T-R1-5 — Integration test: a coach turn (spontaneous OR scheduled) attempting to call `run_command` is BLOCKED with `UNAUTHORIZED_IN_CONTEXT` (regression anchor for v1.18.0 R6/F1 + v1.20.0 R1 carry-forward).

**ADR 020 Decision 7 amended.** The "Flow" step 3 wording is revised:

> 3. **Call `agent.turn()`** with `...buildCoachTurnArgs({ isSpontaneousTrigger: true, triggerContext })`. The helper expands to the three load-bearing flags (`isCoachRun: true`, `coachTurnCounters: { nudges: 0, writes: 0 }`, `isSpontaneousTrigger: true`) — same source of truth as the scheduled cron path. The flag `isSpontaneousTrigger` gates D15 coach prompt behavior (focus on the single triggered item; don't re-pick from full active list). `isCoachRun: true` is what activates the agent's `coachTurnCounters` initialization at `src/agent/index.ts:591`, which in turn activates the dispatcher's brake against `coach.disabledTools` (v1.18.0 R6/F1) and the per-turn cap (v1.18.0 R3). All three flags are required; removing any one inverts a load-bearing brake.

---

### R2 (DA-CRITICAL BLOCKING — supersedes ADR 020 Decision 17) — Boot-wiring static test scope must include 12 stub patterns + cross-file reachability for "shape-without-wiring" trap

**The trap (DA finding).** ADR 020 D17's lint catches 9 known stub patterns:

```
async () => undefined
async () => false
async () => null
() => {}
() => undefined
() => false
() => null
async () => {}
(x) => x   /  (_) => _
```

But MISSES 3 patterns DA verified can ship as "implemented" while being inert:

1. **Early-return guard pattern:** `if (cfg.disabled) return; ...` — registers the callback, but on first invocation returns immediately. The callback body has more than just `return` so the existing AST regex doesn't match.
2. **Promise-resolve-undefined pattern:** `Promise.resolve(undefined)` (or `Promise.resolve()`) — no syntactic difference from a real async handler that happens to return undefined. AST-level alone can't tell intent.
3. **TODO + log pattern:** `// TODO: implement\nlog.warn('handler not yet implemented')` — the body looks like real code. Regex misses; only manual review or runtime-side metric catches.

Worse: the v1.19.0 W1 trap (CONVERGENT R1 Layer b) shipped a different variant — `coachPromptBuilder.ts` had a real implementation with passing unit tests, but ZERO callers in production code. The "shape-without-wiring" anti-pattern: the function exists; the static call graph never reaches it. AST-level stub-detection alone cannot catch this.

**Pick — extend D17 to 12 patterns + cross-file reachability for the wiring TARGET function.**

**Layer (1) — Stub-pattern detection extended.** D17's existing 9 patterns + 3 new:

| Pattern | Detection |
|---|---|
| (existing 9) | as ADR 020 D17 |
| Early-return guard | callback body whose FIRST statement is `if (...) return` AND remaining body is ≤ 3 statements |
| Promise.resolve(undefined) | callback body matches `^return Promise\.resolve\(\s*(undefined\|null\|true\|false\|)\s*\)$` (single-statement) |
| TODO + log only | callback body whose ONLY non-comment, non-log statement count is 0 (i.e., body is exclusively comments + `log.*` calls) |

This requires AST parsing (TypeScript ESLint parser) — already a dev dep. Falls back to grep on source if AST parse fails (with a warning emitted in test output). The detection runs against the boot-wiring registration site (`src/index.ts`) AS BEFORE, but NOW also follows imports to inspect the TARGET function bodies.

**Layer (2) — Cross-file reachability for wiring-target functions.** For each boot-wiring callback name in the closed set (`registerItemStateMonitorCallback`, `registerChatMessageCallback`, `registerCalendarEventCallback`), the test:

1. Parses `src/index.ts` to find the registration call.
2. Resolves the callback argument to a TARGET function name (e.g., `notifyItemStateChange` from `src/coach/itemStateMonitor.ts`).
3. Greps `src/**/*.ts` (excluding `src/coach/itemStateMonitor.ts` itself, AND excluding the boot site, AND excluding test files) for references to that target function.
4. **FAIL if zero non-self, non-test, non-boot references exist.** The function is dead-code; the wiring is "shape-without-wiring."

**NEW commit 11.5 — cross-file reachability lint applied to `expandCoachPromptToken` AND `buildCoachActiveItemsBlock`** (the v1.19.0 W1 fix). Static test `tests/static/coach-prompt-builder-reachable.test.ts` (~40 LOC):

1. Asserts `expandCoachPromptToken` (extended in ADR 020 D15 to accept `triggerContext?`) has at least one non-self call site outside test files.
2. Asserts `buildCoachActiveItemsBlock` (the v1.19.0 R1 Layer (b) wrap surface) has at least one non-self call site outside test files.

The pattern is the same as Layer (2) above; commit 11.5 generalizes the helper into `src/test-utils/static/cross-file-reachable.ts` (or in the test file itself) so future iterations can apply it to any new "interface implemented; wiring TBD" surface.

**Why this discipline (binding):**

1. **The 4th iteration of the boot-wiring trap class** (v1.18.0 commit ea0a8fd, v1.19.0 calendar breaker stub mode 1, v1.19.0 audit shim mode 2, v1.19.0 boot wiring mode 3, v1.19.0 W1 shape-without-wiring mode 4). Each iteration found a new variant of "interface declared, wired-in incompletely." v1.20.0 introduces 3 new callbacks AND extends a prompt-builder surface (D15). Without cross-file reachability, we ship the 5th variant.
2. **Generalizable.** The cross-file reachability check applies to ANY future "register a callback at boot" surface. The helper goes into `src/test-utils/static/` so v1.21.0+ surfaces inherit it.
3. **Still allows test-only utilities.** The reachability rule is "at least one non-self, non-test reference." Test fixtures that import a function only for assertion purposes don't count. Functions used only by tests SHOULD be in `src/test-utils/` or marked `@internal`.

**Tests required:**

- T-R2-1 (commit 0a, extended) — `coach-event-wiring.test.ts` rejects all 12 stub patterns. Fixture files demonstrating each pattern individually trigger FAIL.
- T-R2-2 (commit 0a, extended) — Cross-file reachability for the 3 callback target names. Fixture: target function exists but has zero non-self references → FAIL.
- T-R2-3 (commit 11.5, NEW) — `coach-prompt-builder-reachable.test.ts` asserts `expandCoachPromptToken` and `buildCoachActiveItemsBlock` each have ≥1 non-self, non-test reference.

**ADR 020 Decision 17 amended.** The "Detection" paragraph now reads:

> **Detection.** Two layers. Layer (1) stub-pattern AST scan covers 12 known patterns (9 existing identity stubs + 3 new — early-return guard, Promise.resolve-undefined, TODO+log only). Layer (2) cross-file reachability: for each boot-wiring callback name, resolve the argument to its TARGET function, grep `src/**/*.ts` (excl. self + tests + boot), assert ≥1 reference. Generalized helper in `src/test-utils/static/cross-file-reachable.ts` so future "interface declared; wiring TBD" surfaces inherit.

---

### R3 (DA-CRITICAL BLOCKING — amends ADR 020 Decision 2 + Decision 14) — Migration boot ordering invariant + 3 audit categories (instead of 1) + conflict resolution

Three sub-issues with the migration:

#### R3.a — Boot ordering invariant

**The trap (DA finding).** ADR 020 D2 specified migration runs "on first v1.20.0 boot" but did not specify it runs BEFORE `initScheduler`. `src/index.ts` step 11 calls `scheduler.start()` which immediately reads `scheduledTasks.listActive()` and registers cron jobs. If migration runs in step 12 or later (or runs as fire-and-forget), the scheduler's first tick after boot still sees `description='__coach__'` rows (no `__coach_morning__` profile filter matches), AND the migration is happening concurrently with the scheduler's row reads.

Worse: a v1.20.0 user who upgrades from v1.19.0 mid-day and reboots at 7:55am — if migration completes after 8:00am, they MISS their morning fire that day (the scheduler registered the legacy row, then the migration UPDATEd it mid-flight, then the cron tick fires against a row whose description has changed under it; the scheduler's cron callback `fireTask(task)` uses the cached `task` reference, so the description IS `__coach__` in memory, but `isCoachMarker('__coach__')` returns FALSE — the v1.20.0 dispatch logic in commit 4 expects markers like `__coach_*__`). User's morning fire silently drops.

**Fix.** Migration MUST run BEFORE `initScheduler` in `src/index.ts` boot sequence. New ordering:

```
1.  loadConfig()
2.  initLogger()
3.  initMemory()                            ← migration runs here, INSIDE memory.init() OR
4.  initSafety()                              immediately after, BEFORE step 11 scheduler.start
5.  ...
9.  initGateway()
10. initScheduler()
10.5 (NEW) migrateLegacyCoachTasks(memory)  ← MUST land here at latest
11. scheduler.start()                        ← now sees migrated rows
```

The migration call site is in `src/index.ts` between steps 10 and 11 (i.e., between `initScheduler` returning the API and `scheduler.start()` reading the rows). `initScheduler` itself does NOT read rows; only `start()` does.

**NEW static test `tests/static/coach-migration-ordering.test.ts` (~40 LOC, lands as part of commit 0a's scaffold).** Parses `src/index.ts` source. Asserts:

1. `migrateLegacyCoachTasks(` appears in the file.
2. The line index of the `migrateLegacyCoachTasks` call is STRICTLY LESS than the line index of `scheduler.start()`.
3. Both calls appear at the top level of `main()` (not in conditional branches).

Test uses regex on source text + line-number comparison; no AST needed. Fails if migration is omitted, deferred, or moved after `scheduler.start()`.

#### R3.b — Missing audit categories

**The trap (DA finding).** ADR 020 D14 lists 3 new audit categories (`coach.event_trigger.fired`, `coach.event_trigger.suppressed`, `coach.global_quiet.engaged`) plus 1 migration-only (`coach.migration`). ADR 020 R2 institutional-memory section's open question Q1 referenced `coach.migration_skipped` — but that category was NEVER added to D14's list. Closed-set discipline violation; v1.17.0 H gate carry-forward at risk if this audit row is emitted but the category isn't in `KNOWN_AUDIT_CATEGORIES` (would 400 the webapp.audit_view route).

**Fix.** Three migration-related categories instead of one. D14's list updated:

| Category | When emitted |
|---|---|
| `coach.event_trigger.fired` | Spontaneous trigger fired and led to coach DM (success path) |
| `coach.event_trigger.suppressed` | Spontaneous trigger detected but suppressed (rate limit / quiet / debounce / fatigue / back_off) |
| `coach.global_quiet.engaged` | User invoked `/coach quiet`, `/coach quiet off`, or auto-expiry |
| `coach.migration_completed` | NEW — One-shot v1.20.0 boot rewrite of `__coach__` → `__coach_morning__` succeeded for a row |
| `coach.migration_skipped` | NEW — Row `__coach__` skipped because target `__coach_morning__` already exists for the same user (idempotent re-run) |
| `coach.migration_conflict` | NEW — Both `__coach__` AND `__coach_morning__` exist for the same user; legacy row dropped + audited (per R3.c below) |

**Total new audit categories: 6** (was 4 in D14). KNOWN_AUDIT_CATEGORIES count goes from 47 (v1.19.0 final) to **53** (was 51).

Privacy posture (v1.17.0 H gate carry-forward): structural metadata only. Migration audit detail JSON: `{ taskId, userId, fromDescription, toDescription, action: 'completed' | 'skipped' | 'conflict_dropped' }`. NEVER `cron_expression`, `chat_id` content beyond the row id.

#### R3.c — Conflict resolution: log + audit, don't silently drop

**The trap (DA finding).** D2's migration as drafted: `UPDATE WHERE description = '__coach__' AND no row with __coach_morning__ for owner_user_id`. Open question Q1 noted this. But what happens to the orphaned legacy row in the conflict case? D2 said "drop the legacy row + audit `coach.migration_skipped`" — but `migration_skipped` is the wrong category; the user's mental model differs depending on intent:

- `migration_skipped` = **"target already exists; we're a no-op"** (idempotent re-run).
- `migration_conflict` = **"two distinct rows existed; we resolved by dropping the legacy"** (one-time conflict at first migration).

Silently using one category for both cases hides the conflict from operator visibility.

**Fix.** Distinct categories per intent.

Migration helper logic (binding):

```
For each row r in scheduled_tasks WHERE description = '__coach__':
  let target = scheduled_tasks.findByOwnerAndDescription(r.owner_user_id, '__coach_morning__')
  if target is null:
    UPDATE r.description = '__coach_morning__'
    audit('coach.migration_completed', { taskId: r.id, userId: r.owner_user_id, fromDescription: '__coach__', toDescription: '__coach_morning__', action: 'completed' })
  else if target.id === r.id:
    // Already migrated; idempotent re-run on a row that was already rewritten
    // (impossible given the WHERE filter, but defensive)
    audit('coach.migration_skipped', { taskId: r.id, userId: r.owner_user_id, action: 'skipped' })
  else:
    // Genuine conflict: both rows exist for the same user.
    DELETE r  (the legacy row; user's existing __coach_morning__ row stays as-is)
    audit('coach.migration_conflict', { droppedTaskId: r.id, keptTaskId: target.id, userId: r.owner_user_id, action: 'conflict_dropped' })
    log.warn({ userId, droppedTaskId: r.id, keptTaskId: target.id }, 'coach: migration dropped legacy __coach__ row in favor of existing __coach_morning__')
```

User-visible: `/coach status` after first v1.20.0 boot shows the user's morning profile correctly. Admin/operator visible: audit log shows the conflict.

**Tests required (commit 1, extended):**

- T-R3-1 — Migration with single legacy row → UPDATE; audit `coach.migration_completed`.
- T-R3-2 — Migration with no legacy rows → no-op; no audit emitted.
- T-R3-3 — Migration with both `__coach__` AND `__coach_morning__` → DELETE legacy; audit `coach.migration_conflict`; second migration call is now no-op (no rows match WHERE).
- T-R3-4 — Migration boot ordering: static test `coach-migration-ordering.test.ts` asserts call site precedes `scheduler.start()`.
- T-R3-5 — Idempotency: 2nd invocation finds zero rows; emits no audit.

**ADR 020 Decision 2 amended.** "Migration path" paragraph updated to reflect the conflict resolution + boot ordering. **ADR 020 Decision 14 amended.** The audit categories list grows from 4 to 6.

---

### R4 (DA — DOWNGRADED, addressed inline; amends ADR 020 Decision 9) — Quiet mode helper text MUST mention scheduled-coach asymmetry

**The downgrade rationale.** DA flagged this as concern, not BLOCKING. UX surprise: user runs `/coach quiet 2h` expecting silence; morning DM fires anyway. Documented in D9 as architect intent, but the user-facing chat reply doesn't currently spell it out.

**Pick — explicit helper text in `/coach quiet` command response (binding).**

`/coach quiet <duration>` reply (extends D9):

```
Quiet mode active until 2026-04-26 12:00 UTC (3h 42m remaining).
This silences event-driven coach nudges (item state changes, chat patterns, calendar events).

Note: scheduled coach DMs (morning/midday/evening/weekly) will still fire as scheduled.
Use `/coach off [profile|all]` to mute those too.
```

The "Note:" block is the new helper text. Append-only — does not change quiet mode mechanics from D9.

`/coach quiet status` reply mirrors:

```
Quiet mode: active until 2026-04-26 12:00 UTC (3h 42m remaining).
(Event triggers silenced; scheduled profile DMs still fire.)
```

`/coach quiet off` reply (clears quiet):

```
Quiet mode cleared. Event triggers resumed. Scheduled profile DMs are unchanged.
```

The user's mental model after this exchange: "quiet" is the kill switch for the SYSTEM-initiated nudges. Their explicit schedule is still under their explicit control.

**Implementation site:** the strings live in `src/commands/coachQuietCommands.ts` (NEW per ADR 020 commit 0d) — not in `coachPrompt.md` (this is chat-command UX, not prompt). Same i18n discipline as the rest of v1.18.0/v1.19.0 chat replies (English only; no localization framework).

**Tests required (commit 3, extended):**

- T-R4-1 — `/coach quiet 2h` reply text contains the literal "scheduled coach DMs" + "still fire" substring.
- T-R4-2 — `/coach quiet status` reply text contains the asymmetry note.
- T-R4-3 — `/coach quiet off` reply text mentions "Scheduled profile DMs are unchanged" so the user knows the off doesn't accidentally re-mute their schedule.

**ADR 020 Decision 9 amended.** The "Documented in coachPrompt.md asymmetry note (D5) AND in user-facing /coach help text" sentence is amended to: "Documented in coachPrompt.md asymmetry note (D5), in user-facing /coach quiet command replies (R4 binding helper text), AND in /coach help text."

---

### R5 (DA — DOWNGRADED, addressed inline; amends ADR 020 Decision 13) — Calendar trigger 5-minute delay before fire

**The downgrade rationale.** DA F7 flagged the felt-intrusiveness: reverse-sync creates an organize item from a Google Calendar event the user JUST created (e.g., user adds "Doctor 3pm Tuesday" in Google Calendar; reverse-sync fires within 5 minutes; coach DMs immediately). User feels surveilled. DA marked as downgraded (not BLOCKING) but recommended inline fix.

**Pick — `delayMs: 300_000` constant on calendarMonitor.ts dispatch path.**

Add a delay primitive to `triggerFiring.ts` (D7 module):

```ts
// src/coach/triggerFiring.ts (new)
export interface DispatchOpts {
  /** Minimum delay before firing the trigger; used for low-urgency triggers like calendar events. */
  delayMs?: number;
}

export async function dispatchTrigger(
  deps: TriggerFireDeps,
  trigger: TriggerRecord,
  opts: DispatchOpts = {},
): Promise<{ fired: true } | { fired: false; reason: SuppressionReason }> {
  if (opts.delayMs && opts.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
    // After delay, re-check rate limits + quiet — they may have changed during the wait.
  }
  // ... existing rate-limit + quiet check + agent.turn fire path ...
}
```

`calendarMonitor.ts` dispatches with `{ delayMs: CALENDAR_TRIGGER_DELAY_MS }`:

```ts
// src/coach/calendarMonitor.ts
export const CALENDAR_TRIGGER_DELAY_MS = 5 * 60 * 1000; // 5 min — UX gentleness; user just created the event

export async function inspectCalendarEvent(...): Promise<void> {
  const trigger = detectCalendarTrigger(...);
  if (!trigger) return;
  await dispatchTrigger(deps, trigger, { delayMs: CALENDAR_TRIGGER_DELAY_MS });
}
```

`itemStateMonitor.ts` and `chatMonitor.ts` dispatch with **NO delay** (default `delayMs: 0`). State changes are user-visible signals (the user wrote progress just now); chat triggers are responses to user-typed text. Both are foreground; calendar is background.

**Why setTimeout, not a queue** (binding): single-user posture; in-process; ≤3 calendar triggers/day. A queue would be over-engineering. The await-setTimeout pattern is single-line; the post-delay rate-limit re-check (D7 step 1, runs again after delay) handles the case where the user invokes `/coach quiet` during the 5-min window.

**Edge case: pm2 restart during delay.** If pm2 restarts during the 5-min wait, the trigger is LOST. Acceptable — the user's calendar item already exists; they don't NEED the spontaneous nudge. The next item interaction may re-fire item-state triggers. Document: calendar-trigger fires are best-effort, not durable.

**Tests required (commit 9, extended):**

- T-R5-1 — `inspectCalendarEvent` dispatches with `delayMs: 5 * 60 * 1000`.
- T-R5-2 — `dispatchTrigger({ delayMs: 100 })` waits ~100ms before firing (use vitest fake timers; assert advance + fire).
- T-R5-3 — Quiet mode invoked DURING the delay window suppresses the trigger (the post-delay rate-limit re-check catches it). Asserts `coach.event_trigger.suppressed` audit emitted with `reason: 'QUIET_ACTIVE'`.

**ADR 020 Decision 13 amended.** "Order" step 6 wording: "If trigger produced AND rate limits permit → `dispatchTrigger(deps, trigger, { delayMs: CALENDAR_TRIGGER_DELAY_MS })` → after 5-min delay, re-check rate limits + quiet → if still permitted, fire `gateway.fireSpontaneousCoachTurn`."

---

### W1 (Anti-Slop §14 — amends ADR 020 Decision 6 + Decision 15) — `TriggerReason` is a closed-set enum; no free-form strings

**The trap (Anti-Slop finding).** ADR 020 D6's `TriggerRecord.reason` is typed as `string` — free-form, set by the monitor module's detect logic. D15's `${trigger_context}` injection embeds `reason` directly into the coach prompt. Phase 2 dev could populate `reason` with a user-message excerpt (intending to give the LLM context about what the user said). That excerpt would be injected into the coach prompt OUTSIDE the v1.19.0 R1 Layer (b) `<untrusted source="organize.item">` wrap. The exact prompt-injection trust-boundary trap that v1.19.0 R1/F1 closed for organize-item content reopens for trigger-context strings.

**Pick — closed-set enum `TriggerReason` + builder helper.**

Replace `TriggerRecord.reason: string` with `TriggerRecord.reason: TriggerReason`:

```ts
// src/coach/triggerFiring.ts
export type TriggerReason =
  // itemState (4)
  | 'due_24h'
  | 'goal_stale_14d'
  | 'persistent_zero_engagement_7d'
  | 'vague_new_goal'
  // chat (4)
  | 'commitment_language'
  | 'blocker_language'
  | 'procrastination_language'
  | 'completion_language'
  // calendar (2)
  | 'recurring_meeting'
  | 'standalone_meaningful_event';

export const TRIGGER_REASONS: readonly TriggerReason[] = [
  'due_24h', 'goal_stale_14d', 'persistent_zero_engagement_7d', 'vague_new_goal',
  'commitment_language', 'blocker_language', 'procrastination_language', 'completion_language',
  'recurring_meeting', 'standalone_meaningful_event',
] as const;
```

The values are 1:1 with the trigger types in D6 — same closed set, slightly normalized naming (snake_case with underscore separation; no sentence-fragments like `'due-in-24h-no-progress'`). The mapping from `triggerType` to `reason` is built into `buildTriggerReason()`:

```ts
// src/coach/triggerFiring.ts
export function buildTriggerReason(triggerType: TriggerRecord['triggerType']): TriggerReason {
  const m: Record<TriggerRecord['triggerType'], TriggerReason> = {
    'due-in-24h-no-progress': 'due_24h',
    'goal-stale-14d': 'goal_stale_14d',
    'persistent-zero-engagement-7d': 'persistent_zero_engagement_7d',
    'new-vague-goal': 'vague_new_goal',
    'commitment': 'commitment_language',
    'blocker': 'blocker_language',
    'procrastination': 'procrastination_language',
    'done-signal-confirmation': 'completion_language',
    'recurring-meeting-detected': 'recurring_meeting',
    'standalone-meaningful-event': 'standalone_meaningful_event',
  };
  return m[triggerType];
}
```

(The `triggerType` values stay as-is for audit detail / today-focus-card UI purposes; the `reason` enum is the LLM-facing slug. Two-keys-one-source-of-truth: the `m` map is the only place they cross-reference.)

The D15 `${trigger_context}` string template now embeds the closed-set value. NO user-supplied or item-derived content reaches the LLM via `reason`. Item title, when injected for context, goes through D15's existing focus-item identification (which goes through the v1.19.0 R1 Layer (b) wrap — coach prompt builder wraps every item's title/notes/progress already).

**`fromMessageHash`** (chat trigger only; D14 privacy posture) stays as `string`-typed but is sha256 hex output — bounded format, not LLM-injectable.

**Static test `tests/static/coach-trigger-reason-closed-set.test.ts` (~30 LOC).** Asserts:

1. `TRIGGER_REASONS.length === 10` (closed set).
2. `TriggerReason` union (extracted via type-level inspection at compile time + matched against runtime array).
3. `buildTriggerReason` is a total function (every `TriggerRecord['triggerType']` value maps to a `TriggerReason`).

**Tests required (commit 6, extended):**

- T-W1-1 — `TriggerRecord.reason` is statically typed `TriggerReason` (not `string`). TypeScript compile error if a free-form string is assigned.
- T-W1-2 — `buildTriggerReason('commitment')` returns `'commitment_language'`.
- T-W1-3 — Static lint asserts no `reason: '<some string>'` literal anywhere in `src/coach/itemStateMonitor.ts` / `chatMonitor.ts` / `calendarMonitor.ts` outside of the `buildTriggerReason()` call.

**ADR 020 Decision 6 amended.** TriggerRecord interface revised:

```ts
export interface TriggerRecord {
  source: 'item-state' | 'chat' | 'calendar';
  triggerType: ...;            // closed set, unchanged from D6
  itemId: string;
  reason: TriggerReason;        // NOW closed-set enum (W1 binding); was: free-form string
  fromMessageHash?: string;     // sha256 hex; chat trigger only
  detectedAt: string;
}
```

**ADR 020 Decision 15 amended.** The `${trigger_context}` template format pins `Reason: <TriggerReason value>` (closed set; no free-form). Coach prompt's Step 0.5 verbiage updated:

> When the trigger context is populated, the `Reason:` value will be one of: `due_24h`, `goal_stale_14d`, `persistent_zero_engagement_7d`, `vague_new_goal`, `commitment_language`, `blocker_language`, `procrastination_language`, `completion_language`, `recurring_meeting`, `standalone_meaningful_event`. These are structural slugs, NOT user-quoted text. Use them to identify which trigger fired; do not assume any user-quoted content embedded in `${trigger_context}` is safe — there is none.

---

### W2 (Anti-Slop §13 — amends ADR 020 Decision 16) — 3 distinct module-edge static tests, not one umbrella

**The trap (Anti-Slop finding).** ADR 020 D16 said "extends `tests/static/coach-no-reverse-import.test.ts` to also forbid `calendar/** → coach/**`." Underspecified — DA flagged 3 distinct edges that need separate enforcement:

1. Coach monitors → upstream modules (organize/storage, gateway, agent) — they should ONLY register callbacks at boot, never directly call.
2. calendar/** → coach/** — calendar is downstream; callbacks register from `src/index.ts`.
3. coach/** → agent/index.ts — coach module never reaches into agent internals; agent calls IN to coach via the post-turn callback.

A single umbrella test "no reverse imports" obfuscates which edge fails when it does. Multiple tests = surgical failure messages.

**Pick — three distinct static tests.**

| Test file | Edge enforced |
|---|---|
| `tests/static/coach-monitor-no-reverse-import.test.ts` (NEW) | `src/coach/itemStateMonitor.ts`, `chatMonitor.ts`, `calendarMonitor.ts` MUST NOT import from `src/organize/storage`, `src/gateway/`, `src/agent/`. They may import types from `src/organize/types` and `src/calendar/syncTypes`. |
| `tests/static/calendar-no-coach-import.test.ts` (NEW) | `src/calendar/**/*.ts` MUST NOT import from `src/coach/**`. Calendar is downstream; coach reads calendar types only (forward edge). |
| `tests/static/coach-no-agent-import.test.ts` (NEW) | `src/coach/**/*.ts` MUST NOT import from `src/agent/index.ts`. Coach module registers callbacks via boot wiring (`src/index.ts`) — NEVER calls agent directly. (Type-only imports `import type { TurnParams } from '../agent/index.js'` are PERMITTED — TypeScript erases these at compile time.) |

`tests/static/coach-no-reverse-import.test.ts` (existing v1.18.0) is RETAINED for `organize/** → coach/**` enforcement (the original v1.18.0 invariant); its scope does NOT grow.

Each new static test is ~30 LOC; uses the same import-extraction primitive (regex or AST). Implementation lives in `tests/static/_helpers/import-edges.ts` (NEW shared helper, ~40 LOC) so the four invariant tests share one parser.

**Tests required (commit 12, extended; lands as commits 12.a / 12.b / 12.c — sub-commits of commit 12 OR all in commit 12 grouped):**

- T-W2-1 — `coach-monitor-no-reverse-import.test.ts` PASS on the v1.20.0 module set (post-implementation; the monitors only import types).
- T-W2-2 — `calendar-no-coach-import.test.ts` PASS (calendar/** never imports coach/**).
- T-W2-3 — `coach-no-agent-import.test.ts` PASS (coach/** uses type-only imports for `TurnParams` if any).
- T-W2-4 — Each test FAILS on a fixture file demonstrating the forbidden edge (separate fixture per test).

**ADR 020 Decision 16 amended.** Module-edge enforcement revised:

```
Static tests:
- tests/static/coach-no-reverse-import.test.ts (v1.18.0 — RETAINED; organize/** → coach/** forbidden)
- tests/static/coach-monitor-no-reverse-import.test.ts (NEW — coach monitors → storage/gateway/agent forbidden)
- tests/static/calendar-no-coach-import.test.ts (NEW — calendar/** → coach/** forbidden)
- tests/static/coach-no-agent-import.test.ts (NEW — coach/** → agent/index.ts forbidden, type-only OK)
- tests/static/coach-textpattern-shared.test.ts (NEW per ADR 020 D16; unchanged)
- tests/static/coach-named-constants-single-source.test.ts (extends v1.18.0; unchanged)
```

---

## Updated R1 LOC table (post-CP1 revisions)

LOC discipline is on its **5th iteration** (v1.15.0 / v1.16.0 / v1.18.0 / v1.19.0 → v1.20.0). Anti-Slop CP1 reported 0 FAIL on LOC — strong progress. CP1 revisions add ~155 LOC across new code and 4 new static-test files. All within budget; no new threshold crossings beyond what ADR 020 R1 already documented.

LOC values BELOW reflect ADR 020 R1 baseline + CP1-revision deltas.

| File | ADR 020 R1 Post | CP1 revision Δ | Final Post | Threshold | Notes |
|---|---:|---:|---:|---:|---|
| `src/coach/profileTypes.ts` (NEW) | 30 | 0 | 30 | 500 soft | unchanged |
| `src/coach/itemStateMonitor.ts` (NEW) | 150 | 0 | 150 | 500 soft | unchanged (uses buildTriggerReason from triggerFiring) |
| `src/coach/chatMonitor.ts` (NEW) | 200 | 0 | 200 | 500 soft | unchanged |
| `src/coach/calendarMonitor.ts` (NEW) | 120 | +5 (CALENDAR_TRIGGER_DELAY_MS const + dispatch opts) | 125 | 500 soft | R5 |
| `src/coach/textPatternMatcher.ts` (NEW) | 120 | 0 | 120 | 500 soft | unchanged |
| `src/coach/triggerFiring.ts` (NEW) | 150 | +30 (TriggerReason enum + buildTriggerReason + delayMs param) | 180 | 500 soft | W1 + R5 |
| `src/coach/rateLimits.ts` (NEW) | 80 | 0 | 80 | 500 soft | unchanged |
| `src/coach/userOverrideParser.ts` | 238 | 0 | 238 | 500 soft | unchanged |
| `src/coach/index.ts` | 197 | +30 (`buildCoachTurnArgs` helper + 6 audit categories doc + migration helper extended for conflict resolution) | 227 | 500 soft | R1 + R3 |
| `src/coach/coachPrompt.md` | 190 | +5 (W1 closed-set list embedded in Step 0.5) | 195 | n/a | W1 |
| `src/commands/coachSubcommands.ts` (post-split) | 365 | 0 | 365 | 500 soft | unchanged |
| `src/commands/coachQuietCommands.ts` (NEW) | 150 | +15 (R4 helper text additions) | 165 | 500 soft | R4 |
| `src/commands/coachProfileCommands.ts` (NEW) | 140 | 0 | 140 | 500 soft | unchanged |
| `src/scheduler/index.ts` | 391 | 0 | 391 | 500 soft | unchanged |
| `src/gateway/index.ts` | 1739 | +5 (calls `buildCoachTurnArgs` instead of inline construction; net delta -25 inline +30 helper-call site = +5) | 1744 | 1300 hard (already over) | already-over precedent; filed in TODO.md |
| `src/organize/storage.ts` | 1097 | 0 | 1097 | 1300 hard | unchanged |
| `src/agent/index.ts` | 1033 | 0 | 1033 | 1300 hard | unchanged |
| `src/calendar/sync.ts` | 661 | 0 | 661 | 500 soft (already over) | unchanged |
| `src/memory/auditLog.ts` | 387 | +3 (3 migration audit categories: completed/skipped/conflict — was 1 in ADR 020) | 390 | 500 soft | R3.b |
| `src/index.ts` | 369 | +5 (migration call site between initScheduler and scheduler.start) | 374 | 500 soft | R3.a |
| `public/webapp/cron/app.js` | 1006 | 0 | 1006 | 500 soft (already over) | unchanged |
| `public/webapp/organize/today-focus-card.js` | 443 | 0 | 443 | 500 soft | unchanged |
| `public/webapp/app.js` | 221 | 0 | 221 | 500 soft | unchanged |
| `tests/static/coach-event-wiring.test.ts` (NEW commit 0a, extended) | 80 | +30 (3 new stub patterns + cross-file reachability layer) | 110 | n/a | R2 |
| `tests/static/coach-turn-args.test.ts` (NEW commit 9.5) | 0 | +40 | 40 | n/a | R1 |
| `tests/static/coach-prompt-builder-reachable.test.ts` (NEW commit 11.5) | 0 | +40 | 40 | n/a | R2 |
| `tests/static/coach-migration-ordering.test.ts` (NEW commit 0a, sibling) | 0 | +40 | 40 | n/a | R3.a |
| `tests/static/coach-monitor-no-reverse-import.test.ts` (NEW commit 12) | 0 | +30 | 30 | n/a | W2 |
| `tests/static/calendar-no-coach-import.test.ts` (NEW commit 12) | 0 | +30 | 30 | n/a | W2 |
| `tests/static/coach-no-agent-import.test.ts` (NEW commit 12) | 0 | +30 | 30 | n/a | W2 |
| `tests/static/coach-trigger-reason-closed-set.test.ts` (NEW commit 6) | 0 | +30 | 30 | n/a | W1 |
| `tests/static/_helpers/import-edges.ts` (NEW shared helper) | 0 | +40 | 40 | n/a | W2 |

**Net CP1-revision LOC delta:** ~+440 LOC (production + tests). 7 NEW static tests (+1 helper) total ~+340 LOC of test code. Production LOC delta ~+100. Budget healthy.

**No new threshold crossings.** `coachQuietCommands.ts` 150→165 stays under 500 soft. `index.ts` 369→374 stays under 500 soft. `triggerFiring.ts` 150→180 stays under 500 soft. `gateway/index.ts` already over 1300 hard at HEAD (deferred per ADR 020 R1; CP1 revision adds 5 LOC, no change to deferral status).

**Pre-emptive splits (commit 0d in ADR 020 — UNCHANGED).** No new pre-emptive splits required by CP1 revisions.

---

## Updated Phase 2 commit ordering (BINDING — supersedes ADR 020 commit ordering)

**22 → 24 commits** (six commit-zeros + 16 features + 2 NEW from CP1 revisions = 24). New commits 9.5 (gateway-plumbing static test) and 11.5 (cross-file reachability lint) inserted at the right dependency points. Existing commits 0a + 1 + 6 + 12 are EXTENDED (sub-commits or in-place additions) per the revisions.

| # | Commit | Owner | Notes |
|---|---|---|---|
| 0a | static test scaffold: `coach-event-wiring.test.ts` (12 stubs + reachability) **+ NEW sibling `coach-migration-ordering.test.ts`** | Lead | **EXTENDED per R2 + R3.a:** 12 stub patterns (was 9) + cross-file reachability layer + migration-ordering static test. |
| 0b | RA1 institutional memory v1.20.0 (**8 KI + 8 CLAUDE.md invariants**) | Lead | **EXTENDED per R1 + R2:** 8 entries instead of 6 (NEW: gateway-plumbing carry-forward to spontaneous path; cross-file reachability discipline). |
| 0c | refactor: extract `src/coach/textPatternMatcher.ts` from `userOverrideParser.ts` (Anti-Slop §6) | Dev-A | unchanged |
| 0d | refactor: pre-emptive split of `coachSubcommands.ts` → `coachSubcommands.ts` + `coachQuietCommands.ts` + `coachProfileCommands.ts` (W1; v1.18.0 KI #7 5th iter) | Dev-A | unchanged |
| 1 | feat(coach): `profileTypes.ts` + `COACH_PROFILES` closed set + marker constants + **migration helper with conflict resolution** | Dev-A | **EXTENDED per R3.b + R3.c:** migration helper now handles conflict case (DELETE legacy + audit `coach.migration_conflict`). |
| 2 | feat(coach): `/coach setup [profile] [HH:MM]` + `/coach off [profile\|all]` + `/coach status` (multi-profile) | Dev-A | unchanged |
| 3 | feat(coach): `/coach quiet <duration>` + `quiet status` + `quiet off` (parser in `rateLimits.ts.parseQuietDuration`) **+ R4 helper text** | Dev-A | **EXTENDED per R4:** reply text mentions scheduled-coach asymmetry. |
| 4 | feat(coach): scheduler dispatch by marker prefix (back-compat for legacy `__coach__` → migration runs first) | Dev-A | unchanged |
| 5 | feat(coach): `rateLimits.ts` (per-item 4h + global daily cap + quiet mode primitives + sweeper hook) | Dev-B | unchanged |
| 6 | feat(coach): `triggerFiring.ts` (shared dispatch + audit emission) + **6 new audit categories** (incl. 3 migration variants) **+ TriggerReason closed-set enum** | Dev-B | **EXTENDED per R3.b + W1:** 6 categories (was 4); `TriggerReason` is closed-set enum (was free-form string); `buildTriggerReason()` helper. |
| 7 | feat(coach): `itemStateMonitor.ts` + storage post-write callback registration | Dev-B | unchanged |
| 8 | feat(coach): `chatMonitor.ts` + agent post-turn callback registration (uses textPatternMatcher) | Dev-B | unchanged |
| 9 | feat(coach): `calendarMonitor.ts` + reverse-sync callback registration **+ R5 5-min delay constant** | Dev-B | **EXTENDED per R5:** `CALENDAR_TRIGGER_DELAY_MS = 5*60*1000`; dispatchTrigger receives `{ delayMs }`. |
| **9.5 (NEW)** | **feat(coach): `buildCoachTurnArgs` helper in `src/coach/index.ts` + `tests/static/coach-turn-args.test.ts`** | **Dev-B** | **NEW per R1: single source of truth for the three load-bearing flags (isCoachRun, coachTurnCounters, isSpontaneousTrigger). Test scaffold is RED until commits 10 + 11 land helper consumers.** |
| 10 | feat(gateway): `fireSpontaneousCoachTurn` path **using `buildCoachTurnArgs`** + `isSpontaneousTrigger` plumbing on `TurnParams` | Dev-B | **EXTENDED per R1:** consumes `buildCoachTurnArgs({ isSpontaneousTrigger: true, triggerContext })`. |
| 11 | feat(coach): `coachPrompt.md` Step 0.5 + `${trigger_context}` placeholder + `expandCoachPromptToken` extension | Dev-B | unchanged |
| **11.5 (NEW)** | **feat(static): cross-file reachability lint `coach-prompt-builder-reachable.test.ts`** | **Dev-B** | **NEW per R2: asserts `expandCoachPromptToken` and `buildCoachActiveItemsBlock` have ≥1 non-self, non-test reference. Closes the v1.19.0 W1 shape-without-wiring trap.** |
| 12 | feat(boot): wire 3 callbacks in `src/index.ts` (notifyItemStateChange/processChatMessage/inspectCalendarEvent) **+ migration call site between initScheduler and scheduler.start** **+ 3 module-edge static tests** | Dev-B | **EXTENDED per R2 + R3.a + W2:** commit 0a (extended) now passes; migration ordering enforced; 3 new edge tests (`coach-monitor-no-reverse-import`, `calendar-no-coach-import`, `coach-no-agent-import`) + shared `tests/static/_helpers/import-edges.ts`. |
| 13 | feat(webapp): Cron tile multi-coach UI + profile picker form | Dev-C | unchanged |
| 14 | feat(webapp): `today-focus-card` spontaneous activity feed (3rd section) | Dev-C | unchanged |
| 15 | feat(webapp): hub banner active-profile-count + click-to-expand + heavy-hammer disable button | Dev-C | unchanged |
| 16 | chore(coach): `ARCHITECTURE.md` §20 + `STRUCTURE.md` updates (Pillars 1+2+3) **+ revisions cross-refs** | Lead | **EXTENDED:** §20 cites this revisions doc for R1-R5 + W1 + W2. |
| 17 | chore(release): bump 1.19.0 → 1.20.0 + CHANGELOG + PROGRESS | Lead | unchanged |

**Cross-pillar dependencies (BINDING — supersedes ADR 020):**

- **Commit 0a (extended scaffold) MUST land before commits 10, 11.5, 12.** It establishes the static-test surface that the wiring commits make pass.
- **Commit 9.5 (NEW gateway-plumbing test) MUST land before commit 10 (gateway path).** Test is RED until 10 lands the helper consumer; RED-then-GREEN pattern matches commit 0a's discipline.
- **Commit 11.5 (NEW reachability lint) MUST land at the same point or after commit 11 (prompt builder extension).** Test asserts ≥1 reference exists; commit 12 (boot wiring) provides the production reference.
- **Commit 1 (extended migration helper) MUST land before commit 12 (boot wiring includes migration call site).** The migration call site at boot ordering depends on the helper existing.
- Commit 0c (`textPatternMatcher.ts` extraction) MUST land before commit 8 (chatMonitor uses it). (unchanged)
- Commit 0d (subcommand split) MUST land before commits 2, 3 (which add new commands; pre-emptive split avoids ratcheting `coachSubcommands.ts` further over the soft threshold). (unchanged)
- Commit 1 (profileTypes.ts) MUST land before commits 2-4, 13. (unchanged)
- Commits 5–9 → 9.5 → 10–11 → 11.5 → 12: this is the binding dependency chain. Dev-B's commit-flow sequence.

**Owner assignment unchanged from ADR 020.** Commit 9.5 + 11.5 are Dev-B (matches the Pillar 2 ownership: gateway path + prompt extension). Commit 0a + 0b + 1 extensions stay with their ADR 020 owners (Lead + Dev-A).

---

## Updated KI v1.20.0 entries (6 → 8)

ADR 020 R2 listed 6 KI + 6 CLAUDE.md invariants. CP1 revisions add 2 more (8 + 8 total). Final binding list of v1.20.0 KNOWN_ISSUES.md additions + CLAUDE.md invariants (added in commit 0b):

1. **`COACH_PROFILES` closed set + marker convention extension.** (Carried from ADR 020 R2; unchanged.)
2. **Profile sharing memory (WHEN vs WHAT distinction).** (Carried from ADR 020 R2; unchanged.)
3. **Event trigger boot-wiring discipline (4th-iter trap-class fix) — extended to 12 stub patterns + cross-file reachability.** Static test `tests/static/coach-event-wiring.test.ts` rejects 12 known stub patterns (9 identity + 3 added per R2: early-return guard, Promise.resolve-undefined, TODO+log-only). Layer (2) cross-file reachability — for each boot-wiring callback name, the test resolves to the TARGET function and asserts ≥1 non-self, non-test reference exists. Generalized helper `src/test-utils/static/cross-file-reachable.ts` so future "interface declared; wiring TBD" surfaces inherit. **EXTENDED per R2.** Reference: ADR 020 D17 + ADR 020-revisions R2.
4. **Rate-limit primitives — three keyed-memory entries.** (Carried from ADR 020 R2; unchanged.)
5. **Trigger priority order (override > fatigue > standard).** (Carried from ADR 020 R2; unchanged.)
6. **Conversation trigger 30-min cooldown after coach DM (feedback-loop prevention).** (Carried from ADR 020 R2; unchanged.)
7. **Gateway plumbing for coach-turn entry points carry-forward — `buildCoachTurnArgs` is sole source of truth.** v1.20.0's `fireSpontaneousCoachTurn` is the 4th iteration of the load-bearing seam (v1.18.0 commit ea0a8fd; v1.19.0 W2 carry-forward; v1.19.0 W2.b chat-side gating). Both entry points (scheduled cron + spontaneous trigger) MUST use `buildCoachTurnArgs(opts)` from `src/coach/index.ts`; direct construction of `{ isCoachRun, coachTurnCounters, isSpontaneousTrigger }` is forbidden by `tests/static/coach-turn-args.test.ts`. Each flag does a different thing: `isCoachRun: true` activates `coachTurnCounters` initialization at `agent/index.ts:591` (v1.18.0 R6/F1 + R3 brakes); `coachTurnCounters` provides the per-turn-cap counter object; `isSpontaneousTrigger` gates D15 prompt behavior (focus on the single triggered item). Removing any one inverts a load-bearing brake. **NEW per R1.** Reference: ADR 020-revisions R1 + ADR 020 D7. Test: `tests/static/coach-turn-args.test.ts`.
8. **Cross-file reachability discipline — applies to any "interface declared; wiring TBD" surface.** v1.19.0 W1 trap (CONVERGENT R1 Layer (b)) shipped `coachPromptBuilder.ts` with passing unit tests but ZERO callers in production code — "shape-without-wiring." AST-level stub-detection alone cannot catch this. v1.20.0 R2 generalizes the cross-file reachability check via `tests/static/_helpers/cross-file-reachable.ts`. Apply to any new boot-wiring callback OR any new "interface declared; expected to be called" surface. v1.20.0 commit 11.5 applies it to `expandCoachPromptToken` and `buildCoachActiveItemsBlock` (the v1.19.0 R1 Layer b surface). **NEW per R2.** Reference: ADR 020-revisions R2 + v1.19.0 W1 trap class. Tests: `tests/static/coach-prompt-builder-reachable.test.ts` + `tests/static/coach-event-wiring.test.ts` Layer (2).

**Common-pattern observation across v1.18.0 → v1.20.0 RA1 trap classes (operator note):**

- **LOC drift** — 4 iterations through v1.19.0; v1.20.0 CP1 reported 0 FAIL on LOC. Discipline holding. (Anti-Slop architect-claimed-vs-actual lint suggested as v1.21.0 follow-up.)
- **Closed-set / sole-writer invariants** — v1.17.0 R3+R6, v1.18.0 R5/F3, v1.19.0 R3, v1.20.0 W1 (TriggerReason). 4 iterations. Each adds a new write/inject path that nearly bypassed validators. Mitigation: every new module's design review MUST list its writes/injections against the closed-set + sole-writer invariants.
- **External-content trust boundary** — v1.18.0 R1/D19, v1.19.0 R1/F1, v1.20.0 W1 (TriggerReason injection surface). 3 iterations. Each retrofit closes a layer. Mitigation: every new external-content ingress MUST document its `<untrusted>` wrap surface AND its closed-set-vs-free-form discipline in its own ADR section.
- **Gateway plumbing / load-bearing seams** — v1.18.0 commit ea0a8fd, v1.19.0 W2 carry-forward, v1.19.0 W2.b chat-side gating, v1.20.0 R1 spontaneous-fire path. 4 iterations. Each iteration found a new variant of "thread the load-bearing flag through the new entry point." Mitigation: v1.20.0 R1 introduces `buildCoachTurnArgs` as the single source of truth + static lint. Future load-bearing-seam additions should follow the helper-plus-static-test pattern.
- **Boot-wiring trap class** — v1.18.0 commit ea0a8fd, v1.19.0 calendar breaker stub, v1.19.0 audit shim, v1.19.0 boot wiring identity-stub, v1.19.0 W1 shape-without-wiring. 5 iterations. v1.20.0 R2 closes via 12-pattern lint + cross-file reachability. **The mitigation is itself the highest-leverage carry-forward**: any future boot-wiring additions inherit the lint helper.

---

## File-impact summary table for Phase 2

Owner / commit / file map (BINDING — supersedes ADR 020's table):

| Owner | Commits | Touch |
|---|---|---|
| Lead | 0a, 0b, 16, 17 | ARCHITECTURE.md / STRUCTURE.md / KNOWN_ISSUES.md / CLAUDE.md / CHANGELOG.md / package.json version + 2 static-test scaffolds (commit 0a extended) |
| Dev-A (Pillar 1 — multi-coach profiles) | 0c, 0d, 1, 2, 3, 4 | `src/coach/profileTypes.ts`, `src/coach/textPatternMatcher.ts` (extraction), `src/commands/coach*.ts`, `src/coach/index.ts` (migration helper with conflict resolution per R3) |
| Dev-B (Pillar 2 — event triggers) | 5, 6, 7, 8, 9, **9.5 (NEW)**, 10, 11, **11.5 (NEW)**, 12 | `src/coach/itemStateMonitor.ts`, `chatMonitor.ts`, `calendarMonitor.ts`, `triggerFiring.ts`, `rateLimits.ts`, `src/gateway/index.ts` (spontaneous-fire path), `src/coach/index.ts` (`buildCoachTurnArgs` helper per R1), `src/coach/coachPrompt.md` (Step 0.5 per D15), `src/index.ts` (boot wiring + migration call site per R3.a), 4 NEW static-test files (commits 9.5 + 11.5 + 12 sub-commits) |
| Dev-C (Pillar 3 — webapp) | 13, 14, 15 | `public/webapp/cron/app.js`, `public/webapp/organize/today-focus-card.js`, `public/webapp/index.html` + `public/webapp/app.js` |

---

## Notes

The two new commits (9.5 + 11.5) move the v1.20.0 build to a "single-source-of-truth helper + static lint" pattern for load-bearing seams. v1.18.0's `coachTurnCounters` plumbing (commit ea0a8fd) was a docs invariant + integration test; it required 3 fix-cycle iterations to land + 2 carry-forward iterations (v1.19.0 W2 + v1.20.0 R1). With `buildCoachTurnArgs` as the sole source of truth + commit 9.5 static lint, future iterations inherit the discipline structurally rather than via documentation.

Five trap classes have now appeared in 3+ iterations each (LOC drift, closed-set/sole-writer invariants, external-content trust boundary, gateway plumbing, boot-wiring). Per the operator-note observation, the architect recommends the following lint adoptions as Phase 1 hand-off discipline:

1. **Phase 1 LOC verification** (filed during v1.19.0): diff architect's claimed HEAD against actual `wc -l` before CP1.
2. **Phase 1 closed-set + sole-writer audit** (filed during v1.19.0): per-iteration design-review checklist.
3. **Phase 1 cross-file reachability lint** (NEW per v1.20.0 R2): for any new boot-wiring or interface-declared surface.
4. **Phase 1 helper-source-of-truth pattern** (NEW per v1.20.0 R1): for any new load-bearing flag.

Items 3 + 4 are filed in `<factory-repo>\TODO.md` as cross-iteration discipline carry-forwards.

---

## Progress

CP1 → CP2 transition: this delta-doc replaces the unresolved-questions section of ADR 020 with concrete remediations. ADR 020 is amended per the bindings above; Phase 2 commit ordering in this doc is BINDING. The 7 open questions from ADR 020 are now either resolved (Q1 — addressed by R3 conflict resolution; Q3 — addressed by W1 closed-set TriggerReason; Q4 — accepted as-is; Q5 — accepted; Q7 — type-only forward edge confirmed by W2 binding tests), addressed by the revisions above (Q2 — DA accepted 30-min cooldown after probing; Q6 — refactor in commit 0d unchanged), or deferred (none — all resolved).

CP2 enters with all DA BLOCKING resolved + all Anti-Slop WARN findings resolved + 8 RA1 institutional memory entries pending in commit 0b. Phase 2 may begin.
