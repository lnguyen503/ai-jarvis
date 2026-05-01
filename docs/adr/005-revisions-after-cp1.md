# ADR 005 — Revisions after CP1 debate (2026-04-24)

**Parent:** `005-v1.10.0-multiuser-prep.md`
**Status:** Accepted. Folded into ADR 005 by reference. Developer agents implement the revised spec in `ARCHITECTURE.md` §18.
**Context.** Devil's Advocate review (`docs/reviews/cp1-v1.10.0-debate.md`) raised 2 HIGH + 7 MEDIUM + 3 LOW. Anti-Slop Phase 1 review (`docs/reviews/anti-slop-v1.10.0-phase1-review.md`) added 3 required-before-Phase-2 + 17 warnings. This file records the resolution of each concern.

---

## Resolved (ADR revisions — R1 through R12)

### R1 (HIGH — supersedes part of decisions 6, 7) — Haiku cap check moves INSIDE the mutex (DA-C1)

**Concern.** Original decisions 6 + 7 had the flow: (a) read state outside any lock, (b) check `globalCount >= globalCap`, (c) enter mutex, (d) increment, (e) release. Under `tickConcurrency: 5`, five parallel users can all pass step (b) with a stale count (e.g. all read 498 against a cap of 500), then enter the mutex one at a time and all increment — final count is 498 + 5 = 503, breaching the cap by 3. The architect's own §18.3.5 proof-sketch labels this "possibly stale state" without closing the loop.

**Decision.** Replace the public increment helper with a single atomic "reserve + record" function that does the cap check AND the write UNDER the same mutex:

```typescript
// src/organize/reminderState.ts
export interface ReserveResult {
  ok: true;
  globalStateAfter: GlobalReminderState;
} | {
  ok: false;
  reason: 'global-budget-exhausted';
  globalState: GlobalReminderState;  // for audit
}

/**
 * Atomically reserve one Haiku fallback slot from the global budget.
 * Returns ok:true ONLY if the post-increment global count is still <= cap.
 * Otherwise returns ok:false and does NOT mutate. The lock covers the
 * read, the check, AND the write.
 */
export async function reserveGlobalHaikuFallback(
  dataDir: string,
  cap: number,
): Promise<ReserveResult>;
```

Callers in `triageForUser`:
1. Check per-user cap first (cheap; per-user state already loaded; no lock needed because state is single-user-owned within the tick).
2. If per-user has room → call `reserveGlobalHaikuFallback(dataDir, globalCap)`. If it returns ok:false → audit `result:'skipped', reason:'haiku-budget-exhausted'` (either per-user-exceeded OR global-exceeded; `reason` field carries which).
3. If ok:true → make the Haiku call. If it succeeds, update per-user counter and persist per-user state.
4. If ok:true but Haiku call THROWS → we've "spent" a global slot for a call that didn't happen. Acceptable over-accounting (conservative). Document.

§18.2.4 and §18.3.5 are rewritten accordingly. The "possibly stale" language is replaced with "atomic reservation."

**Test coverage** (added to `tests/unit/organize.reminderState.test.ts`):
- 10 concurrent callers of `reserveGlobalHaikuFallback` with cap=5 → exactly 5 return ok:true, 5 return ok:false. Final globalCount=5. No over-count, no under-count.
- Mutex holder throws mid-reserve → lock releases (try/finally contract verified).
- Cap=0 → every call returns ok:false without mutating.

### R2 (HIGH — supersedes decision 12) — Allowlist-drop audit + DM routing fixes (DA-C2)

**Concern.** Decision 12's audit row had `actor_user_id = task.owner_user_id` (the REMOVED user) and `category: 'admin_command'`. Reads as "the dropped user executed the admin command that dropped them" — wrong actor, wrong category. Separately, the DM went to `task.chat_id` which could be a group; a "task owner no longer authorized" message would leak to the group's other members.

**Decision.**

1. **New `AuditCategory: 'scheduler.policy'`** added to `src/memory/auditLog.ts`. Used for scheduler-originated policy decisions (allowlist drops, migration events, future similar). NOT `admin_command` (that category is for admin-invoked slash commands, and the actor for those IS the admin — different semantic).

2. **Audit row shape for allowlist-drop:**
   ```typescript
   ctx.memory.auditLog.insert({
     category: 'scheduler.policy',
     actor_user_id: null,        // system-originated, no user actor
     actor_chat_id: null,
     session_id: null,
     detail: {
       event: 'drop_unauthorized_owner',
       taskId: task.id,
       ownerUserId: task.owner_user_id,  // subject, not actor
       chatId: task.chat_id,
       description: task.description,    // user-authored; redacted per v1.9.0 R9 rules if exact-matches any user title (usually won't)
       reason: 'owner_not_in_allowlist',
     },
   });
   ```

3. **DM routing:** before sending the "task skipped" DM, call `adapter.resolveDmChatId(task.owner_user_id)`. 
   - If it returns a positive chatId → DM goes to the owner's private chat (Telegram: userId).
   - If it returns null → log warn + skip the DM (owner doesn't have a reachable DM surface; the audit row is sufficient).
   - Explicitly do NOT fall back to `task.chat_id` if it differs from the resolved DM id — the resolver is the boundary; respect it.

4. **If `task.chat_id === owner_user_id`** (the task was scheduled in the owner's DM originally) → no change from (3); the resolver returns `task.owner_user_id` and the DM lands in the same DM the task was created from.

**Test coverage** (added to `tests/unit/scheduler.ownerUserId.test.ts` — new file per the implementation task):
- Task owner removed from allowlist → fire skipped, audit row has `category: 'scheduler.policy', actor_user_id: null, detail.ownerUserId === ownerId`.
- DM delivered only to the resolved DM chatId, NEVER to a group `task.chat_id`.
- `resolveDmChatId(ownerUserId) === null` → no DM, warn log, audit still fires.

### R3 (required per AS-R1) — Allowlist re-check is config-boot-frozen; document the limitation (AS §9)

**Concern.** `src/config/index.ts:110` freezes the config object at boot via `Object.freeze(cfg)`. There is no runtime hot-reload. The allowlist re-check at fire time therefore reads the boot-time snapshot, not the live state. An admin who removes a user via `/jarvis_admin_remove` at 09:00 — the config in memory still includes that user until pm2 restart. The re-check STILL catches the user's post-restart removal (useful if the task was created before v1.10.0's config update) but it does NOT catch in-process role changes.

**Decision.** Two-part.

1. **Short-term (v1.10.0):** document the limitation prominently in ADR + §18. The re-check is "restart-interval granular" — it correctly blocks tasks from users who have been removed since the last pm2 restart. Admin role changes made within the same process lifetime that haven't triggered a restart will be missed. This is the honest accounting; better than claiming live enforcement the code doesn't deliver.

2. **Long-term (filed in TODO.md, not v1.10.0 scope):** add a config-reload path that watches `jarvis.yaml`/`config.json` via `fs.watch` and re-validates through the existing zod schema on any change. Non-trivial because the frozen config is held by reference across ~12 modules. Separate iteration.

Relevant §18 text is updated to say "restart-interval granularity" instead of "live allowlist" and references this revision.

### R4 (required per AS-R2) — `isBelowActiveCap` flips fail-open → fail-closed (v1.9.1 M1 carryforward)

**Concern.** QA session review at v1.9.1 filed this as "fix when multi-user support lands." v1.10.0 IS that iteration. Today at `src/organize/storage.ts:549`, a `readdir` error returns `true` (allow the create) — which in a multi-user deployment lets one user exceed the 200-item quota whenever their directory throws a transient FS error.

**Decision.** Flip the fail-open to fail-closed:

```typescript
export async function isBelowActiveCap(
  userId: number,
  dataDir: string,
  cap: number,
): Promise<boolean> {
  const dir = organizeUserDir(userId, dataDir);
  if (!existsSync(dir)) return true;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    // v1.10.0: fail CLOSED. Under multi-user, fail-open lets a transient
    // readdir error become a per-user quota bypass. The caller surfaces a
    // user-visible error ("couldn't check quota right now; try again").
    log.error(
      { userId, err: err instanceof Error ? err.message : String(err) },
      'isBelowActiveCap: readdir failed; failing CLOSED (rejecting create)',
    );
    return false;
  }

  const mdFileCount = entries.filter((e) => e.endsWith('.md')).length;
  if (mdFileCount < cap) return true;

  const activeCount = await countActiveItems(userId, dataDir);
  return activeCount < cap;
}
```

Plus in `organize_create.ts` the `belowCap === false` branch is extended: if the state `organize_create_readdir_failed_flag` is set (new session-scoped flag set when reserveGlobalHaikuFallback isn't the reason) — actually simpler, just check the log: if the reason is readdir failure, return a distinct error code `ACTIVE_CAP_CHECK_FAILED` instead of `ACTIVE_CAP_EXCEEDED` so the message is more accurate:

```typescript
// In organize_create.ts: distinguish "at cap" vs "couldn't verify cap":
if (!belowCap) {
  const exactCount = await countActiveItems(ctx.userId, dataDir).catch(() => -1);
  if (exactCount >= 0 && exactCount >= 200) {
    return { ok: false, error: { code: 'ACTIVE_CAP_EXCEEDED', ... } };
  }
  return { ok: false, error: { code: 'ACTIVE_CAP_CHECK_FAILED', message: 'Could not verify your item cap right now; try again in a moment.' } };
}
```

**Test coverage** — v1.9.1 has a test asserting fail-open; flip the assertion to fail-closed. Add a new test for the distinct `ACTIVE_CAP_CHECK_FAILED` error code when exactCount can't be determined either.

### R5 (required per AS-R3) — v1.9.1 §17 docs drift status: CONFIRMED RESOLVED

**Concern.** Anti-Slop Phase 1 reviewer flagged §17.6 (formatNudgeBody control-char strip) and §17.7 (orphan state.items cleanup) as "shipped but undocumented." 

**Verification (2026-04-24):** both sections ARE patched — §17.6 at line 1449 ("Defense-in-depth scrub + control-strip (v1.9.1 reviewed)") and §17.7 at line 1463 ("4a. (v1.9.1) Orphan state.items cleanup + single listItems call"). PROGRESS.md v1.9.1 entry is also present. The Anti-Slop reviewer likely read a stale snapshot or v1.9.0 file. **No action required for R5.**

### R6 (new — fixes DA-C4) — Abort signal flows through the sliding-window pool

**Concern.** The sliding-window pool in `tickAllUsers` creates Promise tasks for each user but doesn't pass an AbortController. If the cron-callback's parent abort signal fires mid-pool (e.g. shutdown during a long tick), in-flight user tasks don't cancel.

**Decision.** Each call to `tickOneUser` within the pool receives `deps.abortSignal` (new optional field on `ReminderDeps`). The cron callback creates a fresh `AbortController` per tick, stores it in a module-level `currentTickAbort`, and passes its signal into the deps.abortSignal on each `tickOneUser` call. `stop()` calls `currentTickAbort?.abort()`.

Inside `tickOneUser` / `triageForUser`, the existing `AbortController` for the triage LLM call gets `abortSignal.addEventListener('abort', ...)` to cascade the cancel. Tests: simulate shutdown mid-pool → all in-flight tasks reject with abort reason; mock adapter's sendMessage is NOT called for aborted users; state writes complete for users already past the LLM call (partial progress acceptable).

### R7 (new — fixes DA-C7 + AS warning on category drift) — `scheduled.*` audit categories get their own namespace

**Concern.** DA-C7 + Anti-Slop both flagged: the `admin_command` audit category is currently used for `/jarvis_admin_*`, `/jarvis_roles`, `/memory clear`, and now `/scheduled pause/resume/delete`. The detail.tool discriminator lets queries work today but loses meaning as the category becomes a grab-bag.

**Decision.** Replace the umbrella-category usage for `/scheduled` commands with dedicated sub-categories:

```typescript
export type AuditCategory =
  | /* existing */
  | 'organize.nudge'
  | 'scheduler.policy'           // R2 — system-originated scheduler decisions (drops, etc.)
  | 'scheduler.pause'            // user paused a task
  | 'scheduler.resume'           // user resumed a task
  | 'scheduler.delete'           // user deleted a task
  | 'scheduler.create';          // new task via `schedule` tool
```

Each carries `actor_user_id` (who did it), `detail.taskId`, `detail.ownerUserId` (the task's owner, may differ from actor if admin override), and `detail.adminOverride: true` when an admin acted on another user's task. DM to the task owner on admin-override delete/pause/resume delivers the accountability trail outside the audit table too.

The existing `admin_command` category stays for truly global-state admin commands (`/jarvis_admin_add`, `/jarvis_dev_add`, etc.) where the actor IS the admin and the action is truly "admin command." Schedule commands are per-user task management; separate namespace.

### R8 (new — fixes DA-C8) — NULL-owner task management policy

**Concern.** DA-C8: legacy task (owner_user_id=NULL) behavior under `/scheduled` commands wasn't spelled out. Today no legacy rows exist but the ADR claims null owners can arrive (e.g. direct SQL insert, future migration from a prior scheduler, etc.).

**Decision.** Explicit NULL-owner handling:

- `/scheduled list` (bare, no filter) — shows tasks WHERE `owner_user_id = ctx.from.id`. NULL-owner tasks do NOT appear in anyone's bare listing.
- `/scheduled list all` (new subcommand, admin-only) — admin sees ALL tasks including NULL-owner. NULL-owner rows labeled `[orphan]`.
- `/scheduled pause|resume|delete <id>` on a NULL-owner task — rejected for non-admin with "This task has no owner. An admin must manage it." Admin can manage via the explicit `/scheduled claim <id>` subcommand (new) which sets `owner_user_id = admin.userId`, or via `/scheduled delete <id>`.
- Fire-time behavior is unchanged: NULL owner → `agent.turn({userId: undefined})` → tools return `NO_USER_ID` with the "recreate the task with a current user context" message.

### R9 (new — fixes DA-C9) — Pagination on `/scheduled list`

**Concern.** Telegram message limit is ~4096 chars. A user with 50 scheduled tasks easily exceeds.

**Decision.** Cap `/scheduled list` at 20 tasks per page. `/scheduled list page 2` etc. Each page shows: total, current page, navigation hint. Format: HTML via `markdownToTelegramHtml` (same discipline as `/organize`).

### R10 (new — fixes DA-C6 + Anti-Slop warning on computeNextFire) — Reuse node-cron's parser instead of inline regex

**Concern.** The ADR's inline `computeNextFire` helper parses cron expressions with a custom regex. node-cron has `cron.validate(expr)` already exposed; it internally uses a fuller parser. For cron → next-fire computation, the simpler path is `new Date(Date.now() + intervalHintFromCron)` for display purposes only (never for actual scheduling) — node-cron handles actual firing internally. The `schedule` tool's output string can just say "cron: <expr>" and omit the "next at" humanization, which was a nice-to-have, not required. Simpler.

**Decision.** Remove the `computeNextFire` helper entirely. `schedule` tool output becomes:

> `Scheduled: "<description>" — cron "<cron>", status: active. The scheduler will fire on the next matching minute (use /scheduled show <id> for details).`

`/scheduled show <id>` displays the cron expression + last_run_at + next-fire computed inline via `cron.nextDate()` if available (check node-cron API — if not, skip the next-fire display and just show last-run-at).

### R11 (new — fixes Anti-Slop warning on schedule tool missing try/catch) — Error handling in the schedule tool

**Concern.** ADR 005 decision 15 didn't specify try/catch around the `scheduledTasks.insert` call. `update_memory.ts` has the pattern; `schedule` should mirror.

**Decision.** Full try/catch around DB insert, scheduler.reload call, and audit insert. Each layer has its own catch; the tool returns `ok:false` with a distinct error code (`SCHEDULE_INSERT_FAILED`, `SCHEDULER_RELOAD_FAILED`) and the audit row records the failure. Test coverage: mock the DB layer to throw; verify tool return shape + audit.

### R12 (new — fixes Anti-Slop warning on config.example.json) — Build order includes config.example.json

**Decision.** Added as explicit step 0.5 of the Phase 2 build order: `config/config.example.json` gains the `globalHaikuFallbackMaxPerDay` + `tickConcurrency` keys alongside the v1.10.0 stanza updates. Rationale: parity with v1.9.0 / v1.9.1 config-example updates; new users cloning the example shouldn't get a config that misses the new knobs.

---

## Accepted as documented risks (no ADR change)

- **DA-C3 adapter boot-order/sync-throw** — test coverage item, not a design gap. Dev agents add the test; no ADR change.
- **DA-C5 allowedUserIds live-vs-frozen** — resolved by R3.
- **DA-C10 Item 4 scope rationale** — the architect already addressed this in Decision 15's consequences section; Anti-Slop also confirmed "correct scope, not creep." No change.
- **Mutex-hold TOCTOU on over-count** (DA noted as LOW in C1's footer): under R1's atomic reserve pattern, this class is eliminated.
- **Scheduler queue backpressure from v1.5** (Anti-Slop warning) — cross-ref to existing docs; no v1.10.0 scope change.
- **Two node-cron instances in same process** (Anti-Slop warning) — noted in §18.8 module-boundaries addendum; both are lightweight.

## Summary of ADR changes

Original decisions 1-17 stand with amendments:

- **Decision 6 (cap check flow):** superseded by R1 — atomic reserve function; cap check moves inside mutex.
- **Decision 7 (mutex shape):** refined by R1 — returns reservation result, not a plain boolean.
- **Decision 12 (allowlist-drop audit):** superseded by R2 — new `scheduler.policy` category; `actor_user_id: null`; DM via `resolveDmChatId`.
- **Decision 15 (`schedule` tool):** refined by R10 (drop computeNextFire), R11 (try/catch), and R12 (config.example).
- **Decision 16 (`/scheduled` subcommands):** extended by R8 (null-owner policy) + R9 (pagination).

Plus six NEW decisions:
- **Decision 18:** `isBelowActiveCap` fail-closed (R4 — carryforward from v1.9.1 M1).
- **Decision 19:** Allowlist re-check is restart-interval granular (R3 — documented limitation).
- **Decision 20:** Abort signal flows into `tickOneUser` for graceful shutdown (R6).
- **Decision 21:** `scheduler.*` audit categories replace `admin_command` usage for schedule commands (R7).
- **Decision 22:** NULL-owner policy via `/scheduled list all` + `/scheduled claim` (R8).

`ARCHITECTURE.md` §18 is patched in-place with the revised behavior so developer agents have a single source of truth.
