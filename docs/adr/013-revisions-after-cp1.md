# ADR 013 — Revisions after CP1 debate (2026-04-25)

**Parent:** `013-v1.14.5-picker-tier-completion.md`
**Status:** Accepted. Folded into ADR 013 by reference. Phase 2 dev agents implement the revised spec; deviations require another addendum.
**Context.** Devil's Advocate review (`docs/reviews/cp1-devils-advocate-v1.14.5.md`) raised 1 BLOCKING + 2 HIGH + 6 MEDIUM + 1 MINOR + 5 OK with 9 numbered R-revisions (R1–R9). Anti-Slop Phase 1 review (`docs/reviews/anti-slop-phase1-review-v1.14.5.md`) raised 1 Required Action (RA1) + 6 warnings (W1–W6) + 3 cosmetic carry-forward (C1, C2, C3). Convergence signal: both reviewers independently flagged the items.mutate.ts LOC trend (DA P15 → R3; Anti-Slop W2) and the BroadcastChannel multi-bot scope/wire-constants axis (DA P8 → R7; Anti-Slop W6). The architect resolves the BLOCKING (R1) with a 2-LOC `deletedAt` filter inside `parentExistsAndIsActiveGoal` mirroring the v1.14.3 R7 listItems pattern at `src/organize/storage.ts:560-565`, accepts both HIGH (R2 picker self-id filter; R3 items.mutate.ts split now), accepts the RA1 in full, accepts every MEDIUM (R4 postMessage try/catch; R6 strict integer offset parser; R7 channel-name `organize-mutations-jarvis`; R8 auto-refetch on read-only detail; R9 FAT mtime documentation), defers ONE MEDIUM (R5 trash.ts extraction — below the storage.ts ~1300 LOC re-evaluation threshold), and accepts every Anti-Slop warning (W1 banner DOM contract; W2 closes via R3; W3 TOCTOU regression test; W4 BC sender negative-path; W5 no-change-parentId audit forensic edge; W6 closes via R7).

The BLOCKING (R1 — `parentExistsAndIsActiveGoal` does not filter on `deletedAt`; the within-validate window where `softDeleteItem` has stamped `deletedAt` in the live file but not yet renamed produces a "live-but-doomed" parent that the validator accepts) MUST land in v1.14.5. Non-negotiable. Verified at `src/organize/storage.ts:914-927` (`readItemFrontMatter` returns parsed front-matter without filtering on `deletedAt`) and at `src/organize/storage.ts:822-847` (`softDeleteItem` writes `deletedAt` at line 828 and renames at line 847, with a microsecond-but-real window between them). The fix is the same 2-LOC pattern v1.14.3 R7 added at `src/organize/storage.ts:560-565` for `listItems`; v1.14.5 mirrors it inside `parentExistsAndIsActiveGoal`. Without it, a PATCH that races a chat-side `softDeleteItem` of the parent stores a parentId pointing at a goal that was just trashed — observable as orphan-renders-top-level on the next list refresh, but the storage-layer write is the data-integrity bug.

This revisions document supersedes the relevant clauses of ADR 013 by reference; the parent ADR is not edited.

---

## Resolved (R-numbered, ordered by file impact for Phase 2)

### R3 (HIGH — supersedes ADR 013 D12 deferral) — `items.mutate.ts` split now (Option B: PATCH+DELETE retained; POST /complete extracted)

**Concern (DA P15 + Anti-Slop W2 convergence).** ADR 013 D12 line 397-414 defers the `items.mutate.ts` split to "600 LOC OR a non-items webapp mutation surface." DA P15 verified the LOC trend (516 v1.14.2 → 525 v1.14.3 → 529 HEAD → projected 546 post-v1.14.5) is monotonic; each iteration adds 15-17 LOC; by v1.14.9 the projection crosses 600. Anti-Slop W2 separately asks the trigger be tightened from 600 to 575 LOC. **Both reviewers want action now.** Anti-Slop §13 soft threshold is 500; v1.14.5 projects 546 (8.4% over). The deferral logic is "wait until it's worse" — exactly what Anti-Slop §13 exists to force a conversation about.

DA's Option A suggests four-way split (`items.mutate.patch.ts`, `items.mutate.delete.ts`, `items.mutate.complete.ts`, plus a thin index `items.mutate.ts`). The architect picks **Option B (two-way split)** and rejects Option A as over-fragmentation: four files for four handlers when one cohesive pair (PATCH + DELETE) shares the If-Match envelope, the 412 path, the conflict-tracker plumbing, and the storagePatch explicit-copy block.

**Decision — accept R3 (Option B) in full; mechanical split lands as the FIRST commit of v1.14.5 Phase 2.**

**R3 — Option B split:**

  - **`src/webapp/items.mutate.ts` retains PATCH + DELETE** (and the new v1.14.5 parentId branch in PATCH per D1/D2). Both share: `If-Match` header parsing via `items.shared.ts:ifMatchCheck`; the same 412 envelope shape (per ADR 012 D4); the same `noteConflict()` call on 412 emit (per ADR 012 R2); the `X-Force-Override` truthiness check; the `bypassAfter412` audit field path. Cohesive.
  - **`src/webapp/items.complete.ts` (NEW)** — POST `/api/webapp/items/:id/complete` handler + the v1.14.4 R4 no-op fast-path + the v1.14.4 D9 If-Match check + the v1.14.2 R18 absolute-write semantic. The /complete handler has its own three-layer composition (per ADR 012 RA2 §c CLAUDE.md invariant); cleanly separable.
  - **`src/webapp/items.shared.ts`** unchanged in shape; the `ConflictTracker` LRU + `noteConflict` + `hasRecentConflict` + `ifMatchCheck` helpers stay where they live (already shared by all three handlers; no movement needed).
  - **Mounting:** `mountItemsMutateRoutes(app, deps)` (currently at `items.mutate.ts:161`) keeps PATCH + DELETE mounts. New `mountItemsCompleteRoutes(app, deps)` is exported from `items.complete.ts`. Both are called from the wiring site (`src/webapp/server.ts` or wherever `mountItemsMutateRoutes` is currently invoked). One additional `import` + one additional call site at the wiring layer.

**Projected LOC after split:**

  - `items.mutate.ts`: 529 LOC HEAD − 191 LOC POST /complete handler (lines 338-end) + ~30 LOC v1.14.5 parentId additions = **~370 LOC** (back below the 500 soft threshold).
  - `items.complete.ts` (NEW): ~200 LOC (191 LOC handler body + ~10 LOC mount function + imports/header).
  - `items.shared.ts`: 343 LOC unchanged.
  - **Total source LOC delta:** +9 LOC vs the architect's monolithic +20 LOC (the split's mount-function overhead is small; mostly mechanical line moves).

**Rationale for Option B over DA's Option A:**

  1. **Splitting four handlers into four files is over-fragmentation for the LOC count.** Each of the four (PATCH/DELETE/POST-complete/index) would average ~85 LOC; module overhead (imports, types, mount function, JSDoc) becomes a meaningful percentage of file content. Anti-Slop §9 over-engineering territory.
  2. **The natural fault line is between mutating-mode handlers (PATCH/DELETE share envelope semantics) and absolute-write handlers (POST /complete is idempotent and has its own fast-path).** PATCH and DELETE BOTH read the item, BOTH check If-Match, BOTH emit 412 with `currentItem` envelope. POST /complete additionally has the no-op fast-path that runs BEFORE any storage call. Two semantic groups; two files.
  3. **It composes with R3's mechanical-extract goal.** The split happens as the first commit of Phase 2 WITHOUT logic change; v1.14.5 features (parentId in PATCH; broadcastMutation hooks in all three handlers) land in subsequent commits at the appropriate file.

**Test-import-path impact.** Phase 2 audits all `tests/integration/webapp.organize.mutate.test.ts` imports; cases that only exercise POST /complete may want to migrate to a new `tests/integration/webapp.organize.complete.test.ts`. **Phase 2 binding: keep all tests in `webapp.organize.mutate.test.ts` for v1.14.5** (they import the mounted routes via the shared test harness; the split is server-internal); migrate test-file structure in v1.14.6+ if test count grows. ZERO test logic changes.

**Tests required (Phase 2).**

  1. **Test R3-1 (mount integrity):** boot the test server with both `mountItemsMutateRoutes` AND `mountItemsCompleteRoutes` called; verify all three endpoints (PATCH /:id, DELETE /:id, POST /:id/complete) respond 200 to the v1.14.4 happy-path payloads. Inherited test coverage; no new test logic.
  2. **Test R3-2 (no logic regression):** run the full `tests/integration/webapp.organize.mutate.test.ts` suite (T1–T29 from v1.14.4 + the v1.14.5 additions). All pass. The split is mechanical.

**File/line impact.**

  - `src/webapp/items.mutate.ts` — REMOVE lines 338-528 (POST /complete handler block; carries to new file). KEEP lines 1-337 (PATCH + DELETE) plus v1.14.5 parentId additions. New LOC: ~370.
  - `src/webapp/items.complete.ts` (NEW) — IMPORT shared helpers from `items.shared.ts`; EXPORT `mountItemsCompleteRoutes(app, deps)`. New LOC: ~200.
  - `src/webapp/server.ts` (or wiring site) — ADD `import { mountItemsCompleteRoutes } from './items.complete.js'`; CALL `mountItemsCompleteRoutes(app, deps)` after the existing `mountItemsMutateRoutes(app, deps)` line. ~2 LOC.
  - All test imports unchanged (the test harness mounts via the wiring layer).

---

### R1 (BLOCKING — supersedes ADR 013 D2 line 107-119 helper signature) — `deletedAt` filter inside `parentExistsAndIsActiveGoal`

**Concern (DA P2).** ADR 013 D2 lines 107-119 specify `parentExistsAndIsActiveGoal` as a helper that calls `readItemFrontMatter` (storage.ts:914-927) and checks `fm.type === 'goal'` AND `fm.status !== 'abandoned'`. **The spec language ("an existing, non-trashed goal" at line 110) IMPLIES a `deletedAt` filter but DOES NOT BIND it.** Verified at `src/organize/storage.ts:914-927`: `readItemFrontMatter` returns the parsed front-matter; it returns null ONLY on read-failure or parse-failure. It does NOT filter on `deletedAt`.

The TOCTOU window is **within** the validate call, distinct from D3's accepted **after-validate-before-write** window:

  1. `softDeleteItem` (storage.ts:765-851) is two FS operations: line 828 writes `deletedAt` into the LIVE file via atomic write; line 847 renames the live file to `.trash/<id>.md`.
  2. Between line 828 and line 847 (microseconds, but real), the LIVE file has `deletedAt: <ISO>` set in front-matter.
  3. v1.14.3 R7 added `if (fm.deletedAt != null) continue;` at `src/organize/storage.ts:564` to close this window for `listItems`.
  4. ADR 013 D2's helper has the SAME window. Without the filter, a concurrent webapp PATCH that calls `parentExistsAndIsActiveGoal` for parent G mid-`softDeleteItem(G)` reads G's front-matter with `deletedAt` set, observes `type === 'goal'` AND `status !== 'abandoned'`, and returns `{ok: true}` — accepting a parent the chat-agent is actively deleting.
  5. The PATCH commits a parentId pointing to G. Next `listItems` filters G out (per the v1.14.3 R7 invariant); the child renders top-level. The hierarchy renderer's orphan-treats-top-level rule masks the symptom, but the storage-layer write (a child whose parentId is a trashed goal) is the data-integrity bug.

**Why BLOCKING.** The fix is 2 LOC. Without it, v1.14.5 has a known race where the picker validates against deletedAt-stamped-but-not-yet-renamed parents. The architect's D2 spec language ("non-trashed") is ambiguous between the rename-completion check and the deletedAt-field check; v1.14.3 had to be told via R7; v1.14.5 must be told too.

**Decision — bind the deletedAt filter explicitly per the v1.14.3 R7 listItems pattern.**

**R1 — Update D2 line 107-119 helper body to include the deletedAt filter:**

```typescript
// src/organize/storage.ts — new exported function (binding for D13 location)

export type ParentRefRejection = 'NOT_FOUND' | 'NOT_GOAL' | 'NOT_ACTIVE';

export interface ParentRefResult {
  ok: boolean;
  reason?: ParentRefRejection;
}

/**
 * Verify that `parentId` references an existing, non-trashed goal whose status
 * is 'active' or 'done' (NOT 'abandoned' — D1 rationale).
 *
 * Reads only the parent item's file via readItemFrontMatter. Does NOT call
 * readItem (notes/progress not needed). Returns NOT_FOUND for a missing,
 * trashed, OR mid-soft-delete file (deletedAt-stamped-but-not-yet-renamed
 * window — same defense in depth as v1.14.3 R7 listItems filter at
 * storage.ts:564).
 *
 * @param userId   Telegram user id (per-user dataDir scoping).
 * @param dataDir  Resolved organize data directory root.
 * @param parentId Item id (regex `^\d{4}-\d{2}-\d{2}-[a-z0-9]{4}$`).
 */
export async function parentExistsAndIsActiveGoal(
  userId: number,
  dataDir: string,
  parentId: string,
): Promise<ParentRefResult> {
  const filePath = itemFilePath(userId, dataDir, parentId);
  if (!existsSync(filePath)) return { ok: false, reason: 'NOT_FOUND' };
  const fm = await readItemFrontMatter(filePath, parentId);
  if (fm === null) return { ok: false, reason: 'NOT_FOUND' };

  // R1 (BLOCKING from CP1 v1.14.5; mirrors v1.14.3 R7 listItems filter at
  // storage.ts:564): softDeleteItem stamps deletedAt at storage.ts:828 then
  // renames at storage.ts:847; the window between those two operations leaves
  // the LIVE file with deletedAt set. Without this filter, the validator
  // accepts a parent the chat-agent is actively deleting.
  if (fm.deletedAt != null) return { ok: false, reason: 'NOT_FOUND' };

  if (fm.type !== 'goal') return { ok: false, reason: 'NOT_GOAL' };
  if (fm.status === 'abandoned') return { ok: false, reason: 'NOT_ACTIVE' };
  return { ok: true };
}
```

The 2-LOC addition (line + comment line) is the only change to D2's helper body. The signature, return shape, and call-site pattern at `src/webapp/items.mutate.ts` are unchanged. ALL the routing work in D1/D2 (helper invocation; error mapping to PARENT_NOT_FOUND) composes cleanly because `NOT_FOUND` is the same rejection reason whether the file is missing, the parse fails, OR `deletedAt` is set.

**Tests required (Phase 2).** Add to `tests/unit/organize/storage.test.ts` (joining the 6 unit tests already specified at ADR 013 D14 §2 — the count rises from 6 to 7):

  1. **Test R1-1 (deletedAt-mid-soft-delete window):** Construct a parent goal file at the LIVE path with `deletedAt: '2026-04-25T12:00:00Z'` set in front-matter (simulating the rewrite-before-rename window per storage.ts:828). Call `parentExistsAndIsActiveGoal(userId, dataDir, parentId)`. Expect `{ok: false, reason: 'NOT_FOUND'}`. Mirrors the v1.14.3 R7 listItems-rewrite-window test that `tests/unit/organize/storage.test.ts` already carries from v1.14.3.

**File/line impact.**

  - `src/organize/storage.ts` — `parentExistsAndIsActiveGoal` body gains 2 LOC (1 LOC code + 1 LOC comment). No additional imports.
  - `tests/unit/organize/storage.test.ts` — +1 test (~15 LOC); D14 §2 count rises 6 → 7.

---

### R2 (HIGH — supersedes ADR 013 D4 line 167-179 + D5 line 196-197) — Picker source filter excludes `currentDetailItem.id`

**Concern (DA P11).** ADR 013 D4 line 167-179 binds the picker source as `GET /api/webapp/items?type=goal&status=active`. ADR 013 D5 line 196-197 disables the `<select>` element when the patched item is itself a goal as belt-and-suspenders against `GOAL_CANNOT_HAVE_PARENT`. **DA verified the picker source CAN contain `currentDetailItem.id` when the patched item is a goal:** the goals fetch returns ALL active goals in the user's dir; if the patched item is one of those goals, its id is in the array. The disabled-state UI invariant prevents the user from picking, but UI invariants can be bypassed (devtools, accessibility tooling, `<select disabled>` removal). Server-side `D1 rule 2` (`PARENT_ID_SELF_REFERENCE`) catches the resulting PATCH, but the wire path is dirty.

The cleaner invariant: **filter `currentDetailItem.id` from the picker source unconditionally.** Even when the patched item is non-goal (where the id is structurally absent from the goals fetch), the filter is a no-op safety net. For goal patched items, the filter prevents self-offering AND removes the need for the disabled-state belt-and-suspenders.

**Decision — accept R2 in full; client-side filter at picker render time.**

**R2 — Filter `currentDetailItem.id` from the picker source.** Update D4 line 167-179 + D5 line 196-197 to bind:

```javascript
// public/webapp/organize/app.js — picker render helper

function renderParentPicker(currentItemId) {
  const select = document.getElementById('edit-parent-id');
  select.innerHTML = '<option value="">— None (top level) —</option>';
  for (const goal of goalsCache) {
    if (goal.id === currentItemId) continue;  // R2 (HIGH from CP1 v1.14.5):
                                              // never offer self as parent (defense
                                              // in depth over D1 rule 2 server-side
                                              // PARENT_ID_SELF_REFERENCE check).
    const opt = document.createElement('option');
    opt.value = goal.id;
    opt.textContent = goal.title;            // textContent only — same security posture
                                              // as tag rendering at app.js:382-388.
    select.appendChild(opt);
  }
  // Stale-abandoned current-parent preserved-option logic (D4 line 178-179) runs
  // AFTER this loop; that branch is independent of the self-id filter.
}
```

The `<select>` disabled-state for goals (D5 line 196-197) MAY be retained as additional belt-and-suspenders OR removed — both are correct now that the picker source is self-id-free. Phase 2 dev's choice. The architect's recommendation: **keep the disabled-state for goals** because it carries an additional UX signal ("goals can't have parents") that the empty-picker would not communicate; the cost is ~2 LOC of `select.disabled = (currentDetailItem.type === 'goal')` at picker-render time.

**Tests required (Phase 2).** Add to `tests/public/webapp/organize.parent-picker.test.ts` (joining the 4 client unit tests already specified at ADR 013 D14 §6 — the count rises from 4 to 5):

  1. **Test R2-1 (self-id filter):** Patched item is a goal (id `2026-04-25-aaaa`); `goalsCache` contains 3 goals including `2026-04-25-aaaa`; call `renderParentPicker('2026-04-25-aaaa')`. Assert `<select>` has 3 children (1 "— None —" `<option>` + 2 other-goal `<option>` entries; the self-id is absent). Assert no `<option>` has `value === '2026-04-25-aaaa'`.

**File/line impact.**

  - `public/webapp/organize/app.js` — `renderParentPicker` gains a 1-LOC `if (goal.id === currentItemId) continue;` filter (line + comment ≈ 3 LOC). Architect's D5 disabled-state retention is optional; the architect recommends keeping it.
  - `tests/public/webapp/organize.parent-picker.test.ts` — +1 test (~15 LOC); D14 §6 count rises 4 → 5.

---

### R4 (MEDIUM — supersedes ADR 013 D10 line 358-368 feature-detect block) — Try/catch around `BroadcastChannel.postMessage`

**Concern (DA P9).** ADR 013 D10 line 358-368 specifies feature-detect via `typeof BroadcastChannel !== 'undefined'` AND `try { new BroadcastChannel() }` with catch. **The architect's spec catches the constructor failure but NOT the postMessage failure.** Some iOS WKWebView versions (iOS 14.5 — iOS 16.x partial-support population) expose `BroadcastChannel` as a constructor (so `typeof !== 'undefined'` passes AND `new BroadcastChannel()` succeeds) but throw `TypeError: BroadcastChannel.postMessage not implemented` on `.postMessage()` calls. First attempted broadcast throws; subsequent broadcasts also throw; tab is stuck in a broadcast-attempt → uncaught-exception loop.

Telegram WebApp's documented minimum iOS version is iOS 14.5; ADR 013 D10 line 380 acknowledges "Safari 15.4+; older iOS may lack it." The 14.5 — 16.x population is real-but-small.

**Decision — accept R4 in full; wrap every `postMessage` site in try/catch with silent failure + diagnostic log.**

**R4 — Try/catch around `bcChannel.postMessage()`; disable on first throw.** Update D10 to bind:

```javascript
// public/webapp/organize/app.js — broadcast sender helper

function broadcastMutation(payload) {
  if (!bcChannel) return;
  try {
    bcChannel.postMessage(payload);
  } catch (err) {
    // R4 (MEDIUM from CP1 v1.14.5): some iOS WKWebView versions expose
    // BroadcastChannel as a constructor but throw on postMessage. Disable
    // for the session on first throw; subsequent calls no-op silently.
    console.warn('[organize] BroadcastChannel.postMessage failed; disabling for session', err);
    bcChannel = null;
  }
}
```

Every PATCH/DELETE/POST-/complete success site in `app.js` calls `broadcastMutation(payload)` (already specified at D8 line 322 sender side). The new try/catch is centralized in the helper; sites don't change. ~5 LOC code delta.

**Tests required (Phase 2).** Add to `tests/public/webapp/organize.broadcast-channel.test.ts` (joining the 5 client unit tests already specified at ADR 013 D14 §7 — the count rises from 5 to 6):

  1. **Test R4-1 (postMessage throws → disabled):** Mock `BroadcastChannel` with `postMessage` that throws `TypeError`. Call `broadcastMutation({...})` once. Assert `bcChannel` is `null` after the call. Call `broadcastMutation({...})` again. Assert no throw (the helper short-circuits on `if (!bcChannel) return`).

**File/line impact.**

  - `public/webapp/organize/app.js` — `broadcastMutation` helper gains ~5 LOC (try/catch + comment + disable line). The helper is the single sender site per D8.
  - `tests/public/webapp/organize.broadcast-channel.test.ts` — +1 test (~10 LOC); D14 §7 count rises 5 → 6.

---

### R5 (MEDIUM — DEFERRED) — `src/organize/trash.ts` extraction

**Concern (DA P3 + Anti-Slop W2 indirect).** DA's R5 argues `listTrashedItems` (~70 LOC for v1.14.5 D7) plus `evictExpiredTrash` (currently storage.ts:929-) plus `findClosestTrashedIds` (currently `src/commands/organize.ts:547-580`) plus optionally `restoreItem` form a trash-domain group that should live in `src/organize/trash.ts`. ADR 013 D13 puts both `parentExistsAndIsActiveGoal` and `listTrashedItems` in `storage.ts`, citing IO-neighbor cohesion and "one-function modules are anti-patterns."

DA's preferred R5 extraction would move ~200 LOC out of storage.ts into a new `trash.ts`; storage.ts stays at ~1100 LOC; trash.ts is ~250 LOC. Cohesion improves; storage.ts stays focused.

**Decision — DEFER R5; document the deferral with an explicit re-evaluation trigger.**

**Reasoning.**

  1. **storage.ts at HEAD is 1211 LOC.** Adding `parentExistsAndIsActiveGoal` (~30 LOC) and `listTrashedItems` (~70 LOC) brings it to ~1311. DA's R5 would extract ~200 LOC of trash-domain code, leaving storage.ts at ~1100. **Both states are above Anti-Slop §13 soft threshold (500 LOC); neither is at imminent breakage.**
  2. **The trash-extraction is independent of v1.14.5's three deliverables (parentId PATCH; trash list; BroadcastChannel).** R5 is engineering hygiene that COULD ship separately; bundling it with v1.14.5 expands scope and risk for marginal gain.
  3. **DA's R5-alt explicitly accepts deferral with a TODO entry.** The architect picks R5-alt.

**Re-evaluation trigger (NEW — added to KNOWN_ISSUES.md follow-up table per RA1 below):**

> Extract `src/organize/trash.ts` containing `listTrashedItems` + `evictExpiredTrash` + `restoreItem` + `findClosestTrashedIds` (currently scattered between `src/organize/storage.ts` and `src/commands/organize.ts:547-580`). **Trigger: storage.ts crosses 1300 LOC OR v1.14.6 starts (whichever first).** Mechanical extract; ZERO logic change; tests update import paths only. Re-evaluation matters because each iteration adds 50-100 LOC to storage.ts; deferring past 1400 makes the extract harder.

**Why explicit trigger AND iteration boundary.** The 1300-LOC trigger is mechanical (it fires at the end of v1.14.5 if `listTrashedItems` lands at the upper end of its ~70 LOC budget); the v1.14.6-start trigger is a safety net so the deferral doesn't accumulate indefinitely. **DA's monotonic-trend argument applied to storage.ts** — same shape as DA's argument against the items.mutate.ts deferral, just at a different file and a different threshold.

**File/line impact.**

  - `D:\ai-jarvis\KNOWN_ISSUES.md` — append the trash.ts extraction TODO with explicit trigger (per RA1 §Follow-ups). ~3 LOC.
  - No code changes for v1.14.5.

---

### R6 (MEDIUM — supersedes ADR 013 D6 line 210 silent parsing) — Strict integer offset parser for `/organize trash list <offset>`

**Concern (DA P5).** ADR 013 D6 line 210 specifies "Optional first arg is an integer offset (default 0)" but is silent on parsing strictness. JavaScript `parseInt` is permissive: `parseInt('-1')` returns `-1` (would slice from end of array → returns the OLDEST trashed item, opposite of user intent); `parseInt('1e3')` returns `1` (silently truncates `e3` — user typed 1000 got 1); `parseInt('NaN')` returns `NaN` (Array.slice(NaN) returns all elements, inconsistent with the 50-cap); `parseInt('1.5')` returns `1` (silent truncation). **No injection vector** — the value goes only into `Array.slice` — but UX is broken.

**Decision — accept R6 in full; strict integer-only parser at the chat-side dispatch.**

**R6 — Strict integer offset parser.** Update D6 line 210 to bind:

```typescript
// src/commands/organize.ts — handleTrashList offset parsing

const OFFSET_REGEX = /^\d+$/;            // digits only (rejects -, ., e, x, NaN)
const TRASH_LIST_MAX_OFFSET = 100000;    // sanity cap; well above realistic 30d × 100/d

function parseTrashListOffset(arg: string | undefined): { ok: true; offset: number } | { ok: false } {
  if (arg === undefined || arg === '') return { ok: true, offset: 0 };
  if (!OFFSET_REGEX.test(arg)) return { ok: false };
  const parsed = Number.parseInt(arg, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > TRASH_LIST_MAX_OFFSET) {
    return { ok: false };
  }
  return { ok: true, offset: parsed };
}

// In handleTrashList:
const parsedOffset = parseTrashListOffset(args[0]);
if (!parsedOffset.ok) {
  await ctx.reply('Invalid offset; must be a non-negative integer (≤ 100000).').catch(() => {});
  return;
}
const offset = parsedOffset.offset;
// ... continue with listTrashedItems(userId, dataDir, { offset, limit: 50 }) ...
```

The strict regex `^\d+$` rejects: `-1`, `1.5`, `1e3`, `NaN`, `0xff`, `abc`, ` 42` (leading space), `42 ` (trailing space), `+1` (explicit positive sign), empty string except via the `arg === undefined || arg === ''` early return. Default 0 when absent. Cap 100000 (~2000 pages of 50; far beyond realistic trash size).

**Tests required (Phase 2).** Add to `tests/integration/commands.organize.test.ts` (or `commands.organize.trash-list.test.ts`; joining the 6 integration tests already specified at ADR 013 D14 §5 — the count rises from 6 to 7):

  1. **Test R6-1 (strict offset rejects bad inputs):** invoke `/organize trash list -1` → expect "Invalid offset" reply (not an item list). Repeat for `1.5`, `1e3`, `abc`, `0xff`, `+1`. Each must return the usage reply. Single test with a parameterized table covers all 6 cases.

**File/line impact.**

  - `src/commands/organize.ts` — `parseTrashListOffset` helper + `handleTrashList` invocation (~10 LOC).
  - `tests/integration/commands.organize.test.ts` — +1 parameterized test (~20 LOC); D14 §5 count rises 6 → 7.

---

### R7 (MEDIUM — supersedes ADR 013 D8 line 308 channel name) — Channel name `organize-mutations-jarvis` (Option C; bot-scoped via hardcode)

**Concern (DA P8 + Anti-Slop W6 convergence).** ADR 013 D8 line 308 specifies channel name `organize-mutations` with a deferred-to-multi-user TODO. DA P8 argued same-origin path-based multi-bot hosting (`https://bots.user.com/jarvis/...` and `https://bots.user.com/tony/...`) shares the BroadcastChannel namespace — cross-bot interference is possible if a future ai-tony or ai-natasha runs at the same origin. Anti-Slop W6 separately notes the channel name is a wire-level magic string that should live in a top-of-file constant (mirroring ADR 012 RA1's wire-protocol-constants discipline at `src/webapp/etag-headers.ts`).

The architect weighs three multi-bot scoping options:

  - **Option A (server-templated bot username into client config).** Server endpoint or build-time templating injects the bot username into the client. Requires a new config endpoint OR a build-time template engine. Out of scope for v1.14.5.
  - **Option B (client fetches bot username from `/api/webapp/config` on boot).** New endpoint; new boot dependency; client must wait for config before subscribing to BC. Adds a boot-time round-trip; complicates the BC initialization sequence.
  - **Option C (hardcode `'jarvis'` in the channel name as a v1.14.5 simplification).** Channel name = `organize-mutations-jarvis`. Future Avengers (ai-tony, ai-natasha) get distinct channels by construction at v1.18.0+ when the multi-bot work parameterizes the name. Trivial; closes path-based multi-bot interference; Anti-Slop W6 satisfied via the named-constant.

**Decision — accept R7 (Option C); hardcode `'jarvis'`; document as v1.18.0+ parameterization TODO.**

**R7 — Channel name constant `ORGANIZE_MUTATIONS_CHANNEL = 'organize-mutations-jarvis'`.** Bind in `public/webapp/organize/app.js` top-of-file constants block (alongside the v1.14.4 `ETAG_HEADER` constants at `app.js:61-64` per ADR 012 RA1):

```javascript
// public/webapp/organize/app.js — top-of-file constants block (extends v1.14.4 RA1 block)

// v1.14.4 RA1 — wire-protocol header names (preserved):
const ETAG_HEADER = 'ETag';
const IF_MATCH_HEADER = 'If-Match';
const FORCE_OVERRIDE_HEADER = 'X-Force-Override';
const FORCE_OVERRIDE_VALUE = '1';

// v1.14.5 R7 — BroadcastChannel name (bot-scoped via hardcode; multi-bot
// parameterization is a v1.18.0+ TODO when ai-tony / ai-natasha land):
const ORGANIZE_MUTATIONS_CHANNEL = 'organize-mutations-jarvis';
```

The channel-name string appears in 3+ sites: the `setupBroadcastChannel()` helper, the test file's mock-construction site, and the closes-RA1 enumeration entry. All three reference `ORGANIZE_MUTATIONS_CHANNEL`. ZERO inline magic-string occurrences after R7 lands.

**v1.18.0+ parameterization TODO (binding for ADR 013 §D15 + KNOWN_ISSUES.md per RA1 below):**

> When ai-tony / ai-natasha (Avengers) join the deployment AND share an origin with ai-jarvis, parameterize `ORGANIZE_MUTATIONS_CHANNEL` per-bot. Two approaches: (a) server-templated bot username into client config; (b) client fetches bot username from `/api/webapp/config` on boot. v1.18.0+ work picks one based on the deployment posture at that time. Until then, the hardcode is correct.

**Tests required (Phase 2).** Add to `tests/public/webapp/organize.broadcast-channel.test.ts` (joining the 5+1 client unit tests already specified at ADR 013 D14 §7 + R4 — the count rises from 6 to 7):

  1. **Test R7-1 (channel name constant):** Mock `BroadcastChannel`; call `setupBroadcastChannel()`; assert the constructor was called with `'organize-mutations-jarvis'` (NOT `'organize-mutations'`). Closes the wire-name regression.

**File/line impact.**

  - `public/webapp/organize/app.js` — top-of-file constants block gains 1 LOC `ORGANIZE_MUTATIONS_CHANNEL` constant; `setupBroadcastChannel()` and any other site references the constant. ~3 LOC total (constant + comment).
  - `tests/public/webapp/organize.broadcast-channel.test.ts` — +1 test (~10 LOC); D14 §7 count rises 6 → 7.

---

### R8 (MEDIUM — supersedes ADR 013 D8 line 327-329 banner-on-detail-always policy) — Auto-refetch on read-only detail; banner only when edit form open

**Concern (DA P12 + Anti-Slop W3 indirect).** ADR 013 D8 line 327-329 binds: "Detail view (currentDetailItem matches itemId): show non-blocking banner." DA P12 steel-mans the asymmetric variant: **detail view in EDIT mode → banner (input-loss matters); detail view in READ-ONLY mode → silent refetch (no input to lose; user is just viewing); list view → silent refetch (already specified).** Three states, two behaviors, asymmetrically matched. The cost is ~5 LOC of `if (editFormEl.hidden)` branching.

**Decision — accept R8 in full; auto-refetch on read-only detail; banner only when edit form is visible.**

**R8 — Asymmetric BC listener policy.** Update D8 line 327-329 to bind:

```javascript
// public/webapp/organize/app.js — BroadcastChannel message handler

function handleBroadcastMessage(event) {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  // D8 invariant (preserved): conflict panel visible → BC banner suppressed.
  if (conflictPanelEl && !conflictPanelEl.hidden) return;

  // Detail view: dispatch on edit-form visibility per R8 (CP1 v1.14.5).
  if (currentDetailItem && currentDetailItem.id === msg.itemId) {
    if (editFormEl && !editFormEl.hidden) {
      // R8: edit form open — banner with [Reload] [Dismiss]; user has input to lose.
      showBcBanner(msg);
    } else {
      // R8: read-only detail — silent refetch; user has no input to lose.
      fetchAndShowDetail(msg.itemId).catch((err) => {
        console.warn('[organize] BC silent refetch failed', err);
      });
    }
    return;
  }

  // List view (no detail open): silent refetch list per existing D8 binding.
  if (!currentDetailItem) {
    loadItems().catch((err) => {
      console.warn('[organize] BC list refetch failed', err);
    });
  }
}
```

The architect's D8 reasoning at lines 332-336 ("Banner always (detail). PICK. Predictability over freshness; user-initiated refresh; no surprise input loss while editing.") was correct for the EDIT-mode case but applied symmetrically to read-only. R8 splits the case: edit-mode keeps the architect's banner; read-only treats the detail view as logically equivalent to the list view (silent refetch is correct because there's no input to disorient).

**Tests required (Phase 2).** Replace the `D14 §7` "receiver shows banner when message.itemId === currentDetailItem.id" single-state test with a two-state pair (the count stays at 5 in §7's original enumeration; R4 + R7 already added two; net §7 grows from 5 → 7 with R4+R7 + 0 net from R8 = 7):

  1. **Test R8-1 (banner shown when edit form open):** `currentDetailItem.id === 'X'`; `editFormEl.hidden === false`; dispatch BC message `{itemId: 'X', kind: 'patch'}`. Assert `bcBanner` element shown; assert `fetchAndShowDetail` NOT called.
  2. **Test R8-2 (silent refetch when edit form closed):** `currentDetailItem.id === 'X'`; `editFormEl.hidden === true`; dispatch BC message `{itemId: 'X', kind: 'patch'}`. Assert `fetchAndShowDetail('X')` called; assert `bcBanner` NOT shown.

These two tests REPLACE the single "receiver shows banner" test in D14 §7 (no net change in count); they ADD precision.

**File/line impact.**

  - `public/webapp/organize/app.js` — `handleBroadcastMessage` gains ~5 LOC of branching (if/else on `editFormEl.hidden`). Existing banner-suppress-on-conflict-panel logic preserved.
  - `tests/public/webapp/organize.broadcast-channel.test.ts` — split 1 test into 2 tests; net +1 LOC of test count, +10 LOC of test body. D14 §7 count revised from 5 → 7 (R4+R7+R8 nets to 7 from original 5).

---

### R9 (MEDIUM — supersedes ADR 013 D6 line 220-221 mtime fallback silence) — FAT/exFAT 2-second mtime resolution documentation

**Concern (DA P14 + Anti-Slop §13 implicit).** ADR 013 D6 line 220-221 specifies tertiary sort by filename id when both `deletedAt` and mtime are missing. **The spec is silent on FAT/exFAT mtime resolution** (2 seconds — items deleted within the same 2s window collapse to identical mtimes; sort within that window is non-deterministic). v1.14.4 R5 / P3 had a similar doc-only finding for FAT-mtime; v1.14.5 inherits the same gap for `listTrashedItems`.

**Decision — accept R9 (doc-only); add explicit invariant note in ADR 013 D6 + KNOWN_ISSUES.md entry.**

**R9 — Document the FAT 2s mtime resolution.** Update D6 line 220-221 to add:

> **FAT/exFAT mtime resolution invariant.** mtime resolution on FAT/exFAT filesystems is 2 seconds. Items deleted within the same 2s window collapse to identical mtimes; sort order within that window is non-deterministic via the deletedAt-desc primary key when deletedAt is missing (legacy pre-v1.11.0 trash). The tertiary sort by filename id (item creation date) provides deterministic-if-arbitrary order. **Acceptable: trash-list ordering is approximate; user-facing relative-time formatting ("3d ago") is identical for items in the same 2s window, so the visible UX is consistent even when the internal sort is non-deterministic.**

The note appears in ADR 013 D6 prose and in `KNOWN_ISSUES.md` per RA1 below.

**Tests required (Phase 2).** None. Pure documentation. The architect explicitly accepts the FAT-window edge as an invariant rather than mitigation.

**File/line impact.**

  - ADR 013 D6 — ~5 LOC of prose addition.
  - `D:\ai-jarvis\KNOWN_ISSUES.md` — entry per RA1 below (~3 LOC).
  - No code changes.

---

### RA1 (Anti-Slop RA1 — supersedes ADR 013 silent omission of v1.14.5-specific KNOWN_ISSUES.md and CLAUDE.md updates) — Documentation enumeration; avoid 9th-iteration regression

**Concern (Anti-Slop RA1).** ADR 013 has FOUR references to `KNOWN_ISSUES.md` (lines 414, 458, 479, 550) — all about TODOs filed forward and budget LOC, NOT about NEW v1.14.5-specific entries. The v1.14.4 RA2 closure pattern (which itself closed the v1.14.3 RA3 first-time-in-7-iterations pattern) requires up-front enumeration in this revisions document. **Without enumeration, the institutional-memory carry-forward returns at iteration 9** — same shape and class of finding as v1.14.4 RA2, regressing the just-paid-down-twice discipline.

**Decision — accept RA1 in full; bind enumerated entries below.**

**RA1 — KNOWN_ISSUES.md additions (Phase 2 dev appends to `D:\ai-jarvis\KNOWN_ISSUES.md`):**

  1. **`parentId` is editable via webapp PATCH; rejected on goals (mirrors create-time R13).** Symptom: webapp PATCH `/api/webapp/items/:id` accepts a `parentId` field (string item-id, `null`, or absent). Goals reject `parentId !== null` with `GOAL_CANNOT_HAVE_PARENT` (REUSE of v1.14.3 organize_create R13 wire code). Cause: D1 — adds `parentId` to `ALLOWED_PATCH_FIELDS`. Fix: D1 + D2 + R1 (deletedAt filter inside the existence helper). Prevention: 5 new validator codes (PARENT_ID_INVALID_FORMAT, PARENT_ID_SELF_REFERENCE, PARENT_NOT_FOUND, PARENT_NOT_GOAL, PARENT_NOT_ACTIVE) + reused GOAL_CANNOT_HAVE_PARENT. Reference: ADR 013 D1; this revisions doc R1 + R2.

  2. **Validator codes for parentId rejections.** Symptom: PATCH with bad parentId returns 400 with one of: `PARENT_ID_INVALID_FORMAT` (regex fail), `PARENT_ID_SELF_REFERENCE` (id === path-param), `PARENT_NOT_FOUND` (target missing, trashed, OR mid-soft-delete with deletedAt set), `PARENT_NOT_GOAL` (target type !== 'goal'), `PARENT_NOT_ACTIVE` (target status === 'abandoned'). Cause: D1 distinct forensic signal per rejection. Fix: spec-only; named string codes in `ValidatorErrorCode` union. Prevention: tests at D14 §1 (4 unit cases on validator) + §3 (8 integration cases on existence helper + happy paths).

  3. **`parentExistsAndIsActiveGoal` filters `deletedAt` (mirrors v1.14.3 R7 listItems pattern).** Symptom: helper returns `{ok:false, reason:'NOT_FOUND'}` for files with `deletedAt` set in front-matter, even when the file is at the LIVE path (not yet renamed to `.trash/`). Cause: R1 — closes the within-validate TOCTOU window for the softDeleteItem rewrite-then-rename two-stage operation (storage.ts:828 stamps deletedAt; storage.ts:847 renames). Fix: 2-LOC filter inside the helper at storage.ts. Prevention: test R1-1 (deletedAt-mid-soft-delete window). Reference: ADR 011 R7 listItems filter at storage.ts:564; this revisions doc R1.

  4. **`/organize trash list <offset>` chat command; page size 50; max offset 100000.** Symptom: new chat subcommand lists trashed items for the sender. Cause: D6 — closes v1.14.3 P4 trash-list deferral. Fix: strict integer parser (R6); lexicographic-by-deletedAt-desc sort (D6); collision-suffix base-id extraction (D7). Prevention: tests at D14 §5 (6 integration cases + R6-1).

  5. **`listTrashedItems` storage primitive; sort by `deletedAt` desc with mtime fallback for legacy items.** Symptom: helper reads `.trash/`; tolerant of malformed front-matter (entries surface as `(unreadable)` rather than being omitted); collision-suffix files (`<id>--<unix>-<hex>.md`) parsed correctly with base-id extraction. Cause: D7. Fix: spec at D7 line 286-300; tests at D14 §5. **FAT/exFAT mtime resolution is 2 seconds; items deleted within the same 2s window may sort non-deterministically by mtime; tertiary sort by filename id provides deterministic-if-arbitrary order — per R9 documentation invariant.** Prevention: D6 + D7 + R9.

  6. **BroadcastChannel name `organize-mutations-jarvis`; multi-bot scoping is a v1.18.0+ TODO.** Symptom: same-origin same-document JS API; channel name hardcoded with `-jarvis` suffix to avoid path-based multi-bot interference if future Avengers (ai-tony, ai-natasha) ever share an origin. Cause: D8 + R7 — Option C (hardcode now; parameterize at v1.18.0+). Fix: top-of-file constant `ORGANIZE_MUTATIONS_CHANNEL` in `public/webapp/organize/app.js` per ADR 012 RA1 wire-constants discipline. Prevention: test R7-1 (channel name constant).

  7. **BroadcastChannel listener: silent refetch on read-only detail; banner only when edit form open.** Symptom: BC `'patch'` / `'delete'` / `'complete'` event for the currently-viewed item triggers either silent `fetchAndShowDetail()` (read-only mode) OR `<div id="bc-banner">` (edit mode, with [Reload]/[Dismiss] buttons). Cause: D8 + R8 — asymmetric branch on `editFormEl.hidden`. Fix: ~5 LOC `if (editFormEl.hidden)` in `handleBroadcastMessage`. Prevention: tests R8-1 + R8-2.

  8. **BroadcastChannel sender posts AFTER server-success only.** Symptom: 412 / network error / validation reject does NOT broadcast. Cause: D8 line 322 sender contract; v1.14.5 W4 binding — explicit negative-path test. Fix: `broadcastMutation` invocation site is in the `.then()` of the response handler, AFTER status-200 verification. Prevention: tests at D14 §7 + W4 (sender-does-not-post-on-failure cases).

  9. **BroadcastChannel.postMessage try/catch (iOS partial-support guard).** Symptom: some iOS WKWebView versions expose BroadcastChannel constructor but throw on `.postMessage()`; helper disables for the session on first throw. Cause: R4 — Safari 14.5–16.x partial-support population. Fix: try/catch around `bcChannel.postMessage(payload)` in the centralized `broadcastMutation` helper; `bcChannel = null` on first throw; subsequent calls no-op. Prevention: test R4-1 (postMessage-throws-disables).

  10. **`items.mutate.ts` split at v1.14.5: PATCH+DELETE retained; POST /complete extracted.** Symptom: `src/webapp/items.mutate.ts` HEAD was 529 LOC (Anti-Slop W3 from v1.14.4); v1.14.5 R3 splits POST /complete into NEW `src/webapp/items.complete.ts` (~200 LOC). After split, `items.mutate.ts` = ~370 LOC (back below 500 soft threshold). Cause: DA P15 + Anti-Slop W2 convergence; trend-monotonicity argument. Fix: R3 — Option B two-way split as the FIRST commit of v1.14.5 Phase 2. Prevention: tests R3-1 + R3-2 (mount integrity + no logic regression).

**Follow-ups (DEFERRED items added to KNOWN_ISSUES.md follow-up table):**

  - **trash.ts module extraction** — TRIGGER: storage.ts crosses 1300 LOC OR v1.14.6 starts (whichever first). Move `listTrashedItems` + `evictExpiredTrash` + `restoreItem` + `findClosestTrashedIds` (currently scattered between `src/organize/storage.ts` and `src/commands/organize.ts:547-580`) into NEW `src/organize/trash.ts`. Mechanical extract; ZERO logic change. Per R5 deferral.
  - **BroadcastChannel multi-bot parameterization** — TRIGGER: ai-tony OR ai-natasha join the deployment AND share an origin with ai-jarvis. Replace hardcoded `'organize-mutations-jarvis'` with per-bot template. v1.18.0+ work picks (a) server-templated config or (b) client fetches `/api/webapp/config` on boot. Per R7.
  - **items.mutate.ts further split** — TRIGGER: items.mutate.ts re-crosses 500 LOC OR a non-PATCH/DELETE webapp resource lands. Split PATCH and DELETE into separate files (extending R3's two-way split into a three-way split). Per R3 + Anti-Slop §13.

**RA1 — CLAUDE.md additions (Phase 2 dev appends to `D:\ai-jarvis\CLAUDE.md`, alongside the v1.14.4 RA2 topics):**

  - **a. `parentId` TOCTOU acceptance — orphan child renders top-level (v1.14.3 D5 invariant inherited).** PATCH parentId path validates the parent goal via `parentExistsAndIsActiveGoal` (storage.ts) which filters `deletedAt`-stamped files (R1). After validation, a concurrent `softDeleteItem(parent)` could trash the parent before the PATCH commit completes — the child's stored parentId then points to a trashed goal. Fix posture: hierarchy renderer (`hierarchy.js` v1.14.3) treats orphan children as top-level; locking would over-engineer the single-user posture. Reference: ADR 013 D3; this revisions doc R1.

  - **b. BroadcastChannel scope — per-bot username; client-side feature-detect + try/catch postMessage for iOS partial support.** Channel name `'organize-mutations-jarvis'` is hardcoded in v1.14.5 (R7); multi-bot parameterization is v1.18.0+ work. Feature-detect via `typeof BroadcastChannel !== 'undefined'`; constructor wrapped in try/catch (D10); EVERY `postMessage` call wrapped in try/catch (R4) — first-throw disables for the session. Sender posts AFTER server-success only (W4); receiver branches on `editFormEl.hidden` for banner vs silent refetch (R8); receiver suppressed when conflict panel visible (D8). Reference: ADR 013 D8 + D10; this revisions doc R4 + R7 + R8.

  - **c. Trash module location — `src/organize/storage.ts` today; extract to `src/organize/trash.ts` when storage.ts crosses 1300 LOC or v1.14.6 starts.** v1.14.5 D7 lands `listTrashedItems` in storage.ts alongside `evictExpiredTrash`, `readItemFrontMatter`, `softDeleteItem`. R5 deferral binds the extraction trigger explicitly (per R5 + RA1 follow-ups). When the trigger fires, the extraction is mechanical; no logic change. Reference: ADR 013 D7 + D13; this revisions doc R5.

**File/line impact.**

  - `D:\ai-jarvis\KNOWN_ISSUES.md` — append 10 entries (~50 LOC) + 3 follow-up TODO entries (~10 LOC).
  - `D:\ai-jarvis\CLAUDE.md` — append 3 topics (~12 LOC).
  - Phase 2 dev verifies after implementation that grep for "v1.14.5" in both files matches the expected sections.

---

### W1 (Anti-Slop W1 — supersedes ADR 013 D8 line 327 banner DOM contract silence) — BroadcastChannel banner DOM contract specified verbatim

**Concern (Anti-Slop W1).** ADR 013 D8 line 327 specifies `<div id="bc-banner">` and the user-facing prose, but does NOT bind: button DOM tag, data-attribute test selectors, accessibility attributes, hidden-toggle vs class-toggle pattern. Same shape as v1.14.3 W1 / v1.14.4 RA1. Without explicit DOM contract, Phase 2 dev reaches for inline magic-string selectors (e.g., `document.getElementById('bc-banner').querySelector('button')`).

**Decision — accept W1 in full; bind the DOM contract verbatim per the v1.14.4 conflict panel precedent at `app.js:1084`.**

**W1 — Banner DOM contract (binding for `public/webapp/organize/index.html` + `app.js`):**

```html
<!-- public/webapp/organize/index.html — body-level after toast (per D5 §Module/file plan) -->
<div id="bc-banner" hidden role="status" aria-live="polite" data-bc-banner>
  <span data-bc-message>This item was just updated in another tab.</span>
  <button type="button" id="bc-reload" data-bc-reload aria-label="Reload to see the latest">Reload</button>
  <button type="button" id="bc-dismiss" data-bc-dismiss aria-label="Dismiss notification">Dismiss</button>
</div>
```

**DOM contract bindings:**

  - **Tag:** `<div>` outer; `<button type="button">` for both actions (matches v1.14.4 conflict panel at `app.js:1084`). NEVER `<a>` or `<div role="button">`.
  - **id markers:** `bc-banner` outer; `bc-reload` reload button; `bc-dismiss` dismiss button. Used by handlers + tests.
  - **data-attribute markers:** `data-bc-banner`, `data-bc-message`, `data-bc-reload`, `data-bc-dismiss`. Used by tests as primary selectors (avoid id-coupling regression).
  - **Visibility toggle:** `hidden` attribute (NOT class-based). `bcBannerEl.hidden = false` to show; `bcBannerEl.hidden = true` to dismiss. Matches v1.14.4 conflict panel pattern.
  - **Accessibility:** `role="status"` + `aria-live="polite"` on the outer (announce on show without interrupting). `aria-label` on each button (clear action description for screen-readers).

**Phase 2 grep enforcement (per the v1.14.4 RA1 discipline):**

```bash
# Should match ZERO results (all selectors use data-* via constants):
rg "querySelector\(.*['\"]#bc-" public/webapp/organize/app.js
rg "getElementById\(['\"]bc-" public/webapp/organize/app.js
# Tolerance: ONE site per id is allowed (the canonical setup in setupBroadcastChannel)
```

**Tests required (Phase 2).** Add to `tests/public/webapp/organize.broadcast-channel.test.ts` (joining the ongoing count):

  1. **Test W1-1 (DOM contract):** Render the page; assert `#bc-banner` exists with `hidden` attribute true; assert `[data-bc-reload]` and `[data-bc-dismiss]` selectors find buttons of type=button; assert `aria-live="polite"` on the outer.

**File/line impact.**

  - `public/webapp/organize/index.html` — banner element ~7 LOC.
  - `public/webapp/organize/styles.css` — `#bc-banner { ... }` rules matching v1.14.4 conflict panel ~10 LOC.
  - `public/webapp/organize/app.js` — `bcBannerEl = document.getElementById('bc-banner')` cache; `showBcBanner()` / `hideBcBanner()` helpers ~15 LOC.
  - `tests/public/webapp/organize.broadcast-channel.test.ts` — +1 test (~10 LOC).

---

### W2 (Anti-Slop W2 — closed via R3) — items.mutate.ts split tightening

**Disposition.** Anti-Slop W2 asked for the items.mutate.ts re-evaluation trigger to tighten from 600 → 575 LOC. **R3 supersedes W2 by splitting now in v1.14.5 Phase 2.** After R3, `items.mutate.ts` = ~370 LOC (below the 500 soft threshold; W2's 575 trigger is moot). The follow-up trigger for further sub-splitting is documented in RA1's Follow-ups table ("items.mutate.ts further split — TRIGGER: re-crosses 500 LOC OR a non-PATCH/DELETE webapp resource lands").

**File/line impact.** None (R3 carries the work).

---

### W3 (Anti-Slop W3 — supersedes ADR 013 D14 §3 test enumeration) — TOCTOU regression test for orphan-renders-top-level invariant

**Concern (Anti-Slop W3).** D14 §1-§7 enumerates 34 tests; none binds the dangling-parent post-PATCH render path. The v1.14.3 hierarchy-renderer test that established orphan-renders-top-level is INHERITED but not RE-ANCHORED in v1.14.5. R1 closes the within-validate TOCTOU; D3 accepts the after-validate TOCTOU; W3 binds the explicit regression test that the orphan-renders-top-level invariant holds when the parent is trashed BETWEEN PATCH commit and the next list-refresh.

**Decision — accept W3 in full; add 1 integration test to D14 §3.**

**W3 — Add to `tests/integration/webapp.organize.mutate.test.ts`:**

  1. **Test W3-1 (orphan-renders-top-level after parent trashed mid-flight):** Setup: user has goal G + child task T with `parentId === G.id` after a successful PATCH parentId. Action: call `softDeleteItem(G)` (chat-side helper). GET `/api/webapp/items` → assert T appears in the projection with `parentId === G.id` AND the hierarchy renderer's `groupByParent` (called in client test or asserted via projection structure) places T at the top level (since G.id is no longer in the live goalMap). Closes the D3 acceptance loop with belt-and-braces explicitness; matches the v1.14.4 D6 sunset T26+T27 rigor pattern.

D14 §3 count rises from 8 → 9.

**File/line impact.**

  - `tests/integration/webapp.organize.mutate.test.ts` — +1 test (~30 LOC).

---

### W4 (Anti-Slop W4 — supersedes ADR 013 D14 §7 test enumeration) — BroadcastChannel sender negative-path tests

**Concern (Anti-Slop W4).** D14 §7 covers feature-detect + sender-posts-on-success + receiver-banner + list-silent-refetch + conflict-panel-suppression (5 cases). Does NOT include: "sender does NOT post on 412 / network error / validation reject." D8 line 323 binding ("Sender does NOT post on failure") is asserted but not test-anchored.

**Decision — accept W4 in full; add 2 negative-path tests to D14 §7.**

**W4 — Add to `tests/public/webapp/organize.broadcast-channel.test.ts`:**

  1. **Test W4-1 (no broadcast on 412):** Mock fetch to return 412 for PATCH. Trigger submitEdit. Assert `bcChannel.postMessage` was NOT called.
  2. **Test W4-2 (no broadcast on network error):** Mock fetch to throw / return 500. Trigger submitEdit. Assert `bcChannel.postMessage` was NOT called.

These ANCHOR the D8 line 323 + CP1 surface item 6 invariant. Same shape as v1.14.4 W4 (X-Force-Override probing) but for the sender side of BC.

D14 §7 count rises further (from the post-R4+R7+R8 count of 7) to 9.

**File/line impact.**

  - `tests/public/webapp/organize.broadcast-channel.test.ts` — +2 tests (~20 LOC).

---

### W5 (Anti-Slop W5 — supersedes ADR 013 D14 §3 audit-row test enumeration) — No-change-parentId audit forensic edge documented

**Concern (Anti-Slop W5).** D14 §3 covers "PATCH parentId → audit changedFields includes 'parentId'" implicitly via §4 hierarchy regression. Does NOT cover the inverse: "PATCH that does NOT change parentId → audit changedFields does NOT include 'parentId'." DA P4 from v1.14.4 anticipated probe; v1.14.5 inherits.

**Decision — accept W5 (document the existing pattern; current pattern is correct and matches title-set-to-same-value).**

**W5 — Document the existing pattern; add 1 confirmatory test.**

The current `storagePatch` construction in `items.mutate.ts:201-208` is explicit-copy: `if (validated.title !== undefined) storagePatch.title = validated.title;` per field. v1.14.5 D1 + R1 binding adds the same pattern for parentId: `if (validated.parentId !== undefined) storagePatch.parentId = validated.parentId;`. **When the request body does NOT include parentId, validated.parentId is undefined; the field is NOT set on storagePatch; `Object.keys(storagePatch)` does NOT include 'parentId' in the audit row's changedFields.**

**This matches the existing title-set-to-same-value pattern** (P4 OK in DA review): a PATCH with `{title: 'X'}` where the on-disk title is already 'X' DOES emit an audit row with `changedFields: ['title']` — the audit captures intent, not effective change. **Same posture for parentId.**

**W5 — Add 1 confirmatory test to D14 §3:**

  1. **Test W5-1 (no parentId in body → not in changedFields):** PATCH with body `{title: 'X'}` only (no parentId field). Assert audit row's `changedFields === ['title']` (not `['title', 'parentId']`). Closes the forensic-honesty gap.

D14 §3 count rises to 10 (post-W3 was 9; +1 for W5).

**File/line impact.**

  - `tests/integration/webapp.organize.mutate.test.ts` — +1 test (~15 LOC).

---

### W6 (Anti-Slop W6 — closed via R7) — BroadcastChannel name as top-of-file constant

**Disposition.** Anti-Slop W6 asked for `'organize-mutations'` to be bound as a top-of-file constant `ORGANIZE_MUTATIONS_CHANNEL` in `app.js`. **R7 closes W6 by setting the channel name to `'organize-mutations-jarvis'` AND binding it as the named constant.** ZERO inline magic-string occurrences after R7 lands.

**File/line impact.** None (R7 carries the work).

---

## File-impact summary table for Phase 2

| File | Change | Source of change | LOC delta |
|---|---|---|---|
| `src/webapp/items.mutate.ts` | Remove POST /complete handler block (lines 338-528); retain PATCH + DELETE; add v1.14.5 parentId additions to PATCH per D1/D2/R1 | R3 + R1 + D1/D2 | -191 (extract) +30 (parentId) = **-161 net** (529 → ~370) |
| `src/webapp/items.complete.ts` (NEW) | POST /complete handler + R4 fast-path + If-Match logic + broadcast hook | R3 | **+200** |
| `src/webapp/server.ts` (or wiring) | Import + call `mountItemsCompleteRoutes` | R3 | +2 |
| `src/organize/storage.ts` | `parentExistsAndIsActiveGoal` body gains 2-LOC `deletedAt` filter; `listTrashedItems` per D7 unchanged | R1 + D7 | +112 (110 D7+D2 baseline + 2 R1) |
| `src/organize/validation.ts` | Per ADR 013 D1 unchanged | D1 | +35 |
| `src/commands/organize.ts` | `parseTrashListOffset` strict parser + invocation in `handleTrashList` | R6 + D6 | +95 (90 D6 baseline + 5 R6 + 0 R9 doc-only) |
| `public/webapp/organize/index.html` | Parent-goal picker (D5) + banner DOM contract per W1 | D5 + W1 | +22 (15 D5 + 7 W1) |
| `public/webapp/organize/styles.css` | Picker styling + `#bc-banner` rules | D5 + W1 | +20 |
| `public/webapp/organize/app.js` | Picker render with R2 self-id filter; broadcastMutation with R4 try/catch; handleBroadcastMessage with R8 asymmetric dispatch; `ORGANIZE_MUTATIONS_CHANNEL` constant per R7; banner show/hide helpers per W1 | D4/D8/R2/R4/R7/R8/W1 | +135 (130 D4/D8 baseline + ~5 net additions: R2 +3, R4 +5, R7 +3, R8 +5, W1 +15, minus overlaps) |
| `tests/unit/organize/storage.test.ts` | parentExistsAndIsActiveGoal + listTrashedItems + R1 deletedAt window | D14 §2 + R1 | +195 (180 baseline + 15 R1) |
| `tests/integration/webapp.organize.mutate.test.ts` | parentId PATCH + hierarchy + W3 TOCTOU + W5 audit-row | D14 §3+§4 + W3 + W5 | +265 (220 baseline + 30 W3 + 15 W5) |
| `tests/integration/commands.organize.test.ts` (or trash-list file) | trash list integration + R6 strict parser | D14 §5 + R6 | +140 (120 baseline + 20 R6) |
| `tests/public/webapp/organize.parent-picker.test.ts` (NEW) | Picker tests + R2 self-id filter | D14 §6 + R2 | +105 (90 baseline + 15 R2) |
| `tests/public/webapp/organize.broadcast-channel.test.ts` (NEW) | BC tests + R4 throw + R7 channel name + R8 asymmetric + W4 negative-path + W1 DOM contract | D14 §7 + R4/R7/R8/W4/W1 | +180 (120 baseline + 10 R4 + 10 R7 + 10 R8 + 20 W4 + 10 W1) |
| `D:\ai-jarvis\KNOWN_ISSUES.md` | 10 v1.14.5 entries + 3 follow-up TODO entries (R5 trash.ts trigger, R7 multi-bot trigger, R3 further-split trigger) | RA1 | **+60** |
| `D:\ai-jarvis\CLAUDE.md` | 3 v1.14.5 invariants per RA1 (a/b/c) | RA1 | **+12** |
| `docs/CHANGELOG.md` | v1.14.5 entry (Phase 5) | unchanged from ADR 013 | +25 |
| `package.json` | Version bump 1.14.4 → 1.14.5 | unchanged | +1 |

**Estimated total LOC delta vs ADR 013 baseline:**

  - **ADR 013 baseline (architect's projection):** ~1,246 total (~456 source / ~790 tests).
  - **Post-revisions projection:** source ≈ 460 (R3 split nets -161+200+2 = +41 to webapp surface; +2 R1 to storage; +5 R6 to commands; +10 W1 + R2/R4/R7/R8 client-side overhead = ~+60); tests ≈ 885 (R1 +15 + W3 +30 + W5 +15 + R6 +20 + R2 +15 + R4 +10 + R7 +10 + R8 +10 + W4 +20 + W1 +10 = +155 above the 790 baseline); docs +72 (RA1).
  - **Net:** **~1,417 total LOC delta** (~537 source / ~885 tests / ~ −5 misc), an increase of ~171 LOC over the ADR 013 baseline. The split-now-vs-defer trade-off (R3) carries +5 LOC of mount overhead; the rest is added test rigor (W3/W4/W5), R1's blocking 2-LOC, R7's constant binding, and W1's banner DOM contract.
  - **Test ratio:** ~62% (885 / (537+885)). Healthy; matches ADR 013's projected 63%.

**Source code (non-test) LOC delta:** ~537. Of this, ~310 is server-side (storage + validation + handlers + commands + items.complete.ts split) and ~155 is client-side (HTML + CSS + JS); ~72 is docs.

Test count revision per D14 (post-revisions): 4 (validation) + 7 (storage; +R1) + 10 (mutate integration; +W3+W5) + 1 (hierarchy regression) + 7 (commands; +R6) + 5 (picker; +R2) + 9 (BC; +R4+R7+R8 net 7, +W4 to 9) = **43 tests** (ADR 013 baseline was 34). Phase 2 binding: 43 tests is the new target.

---

## Pushback / disagreements with reviewers

**None expected.** All 9 DA R-revisions are accepted (R1 blocking; R2 + R3 high; R4 + R6 + R7 + R8 + R9 medium; R5 deferred with explicit re-evaluation trigger per DA's own R5-alt acceptance). All 6 Anti-Slop warnings are accepted (W1 explicit DOM contract; W2 closed via R3 better-than-tightening; W3 + W4 + W5 explicit test additions; W6 closed via R7). The 1 Anti-Slop Required Action (RA1 KNOWN_ISSUES + CLAUDE.md enumeration) is accepted in full with 10 entries + 3 follow-up TODOs + 3 CLAUDE.md invariants.

**One disposition difference worth noting** — DA's R3 suggested a four-way split (Option A); the architect picks two-way (Option B per the brief). Reasoning is in R3's "Rationale for Option B over DA's Option A" subsection. DA's preferred outcome (LOC trend reversed; soft threshold respected) is achieved by either Option A or Option B; Option B is cleaner for v1.14.5's surface and avoids over-fragmentation.

**One disposition difference for clarity** — DA's R5 had an R5-alt fallback (TODO entry + defer). The architect picks R5-alt explicitly with both a concrete LOC trigger (1300 LOC) AND an iteration-boundary safety net (v1.14.6 start). DA's primary R5 (extract now) is acceptable but expands v1.14.5 scope unnecessarily; R5-alt with explicit triggers is the disciplined deferral.

---

## Final R-list ordered by file impact

| # | Severity | Resolution | Primary file impact | LOC |
|---|---|---|---|---|
| **R3** | HIGH | Accept (Option B) | `src/webapp/items.mutate.ts` (-161 net) + `src/webapp/items.complete.ts` (NEW +200) + wiring (+2) | -161 / +200 / +2 |
| **RA1** | Required Action | Accept (10 KI + 3 follow-ups + 3 CLAUDE.md) | `KNOWN_ISSUES.md` (+60) + `CLAUDE.md` (+12) | +72 |
| **R6** | MEDIUM | Accept | `src/commands/organize.ts` strict parser (+5) | +5 |
| **W1** | Anti-Slop W1 | Accept (DOM contract bound) | `index.html` (+7) + `styles.css` (+10) + `app.js` (+15) + tests (+10) | +42 |
| **R8** | MEDIUM | Accept | `app.js` `handleBroadcastMessage` (+5) + tests (+10) | +15 |
| **R4** | MEDIUM | Accept | `app.js` `broadcastMutation` try/catch (+5) + tests (+10) | +15 |
| **R7** | MEDIUM | Accept (Option C — `organize-mutations-jarvis`) | `app.js` constant block (+3) + tests (+10) | +13 |
| **R2** | HIGH | Accept | `app.js` `renderParentPicker` self-id filter (+3) + tests (+15) | +18 |
| **W4** | Anti-Slop W4 | Accept (negative-path tests) | `tests/public/webapp/organize.broadcast-channel.test.ts` (+20) | +20 |
| **W3** | Anti-Slop W3 | Accept (TOCTOU regression test) | `tests/integration/webapp.organize.mutate.test.ts` (+30) | +30 |
| **W5** | Anti-Slop W5 | Accept (no-change-parentId audit test) | `tests/integration/webapp.organize.mutate.test.ts` (+15) | +15 |
| **R1** | BLOCKING | Accept (2-LOC `deletedAt` filter) | `src/organize/storage.ts` `parentExistsAndIsActiveGoal` (+2) + tests (+15) | +17 |
| **R9** | MEDIUM | Accept (doc-only) | ADR 013 D6 prose (+5) + KI entry (rolled into RA1) | +5 |
| **R5** | MEDIUM | DEFER (1300 LOC OR v1.14.6) | KI follow-up entry (rolled into RA1) | 0 |
| **W2** | Anti-Slop W2 | Closed via R3 | (no separate change) | 0 |
| **W6** | Anti-Slop W6 | Closed via R7 | (no separate change) | 0 |

**Phase 2 first-commit ordering (binding):**

  1. R3 mechanical split (commit 1; no logic change; full test suite green).
  2. R1 + D2 + D1 helper + handler (commit 2; parentId PATCH server-side).
  3. D4 + D5 + R2 picker (commit 3; client-side picker with self-id filter).
  4. D6 + R6 trash list (commit 4; chat-side).
  5. D8 + R4 + R7 + R8 + W1 BroadcastChannel (commit 5; client-side BC with all guards).
  6. Test rigor adds (commit 6; W3 + W4 + W5 + R1-1 + R6-1 + R2-1 + R4-1 + R7-1 + R8-1/2 + W1-1).
  7. RA1 docs (commit 7; KNOWN_ISSUES.md + CLAUDE.md additions).
  8. R9 ADR prose update + CHANGELOG + version bump (commit 8; ship).

End of revisions document for v1.14.5 CP1.
