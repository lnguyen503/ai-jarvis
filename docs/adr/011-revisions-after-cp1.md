# ADR 011 — Revisions after CP1 debate (2026-04-25)

**Parent:** `011-v1.14.3-notes-progress-hierarchy.md`
**Status:** Accepted. Folded into ADR 011 by reference. Phase 2 dev agents implement the revised spec; deviations require another addendum.
**Context.** Devil's Advocate review (`docs/reviews/cp1-devils-advocate-v1.14.3.md`) raised 1 BLOCKING + 2 HIGH + 6 MEDIUM + 4 OK with 15 numbered R-revisions (R1–R15). Anti-Slop Phase 1 review (`docs/reviews/anti-slop-phase1-review-v1.14.3.md`) raised 3 Required Actions (RA1–RA3) + 6 warnings (W1–W6) + 2 cosmetic carry-forward (C1, C2). Convergence signal: both reviewers independently flagged the `restoreItem` two-stage write atomicity (Anti-Slop RA1; partially overlapping with DA P5/R7) and the `KNOWN_ISSUES.md` 7th-occurrence enumeration gap (Anti-Slop RA3; the architect's §Module/file plan listed the file but did not enumerate entries). The architect resolves the BLOCKING (R13) with a 5-LOC create-time guard at `src/tools/organize_create.ts:46`, accepts both HIGH (R7 listItems filter; R11 explicit parentId-rejection tests) plus all three RAs in full, and accepts every MEDIUM with light scoping where the DA offered A/B alternatives.

The BLOCKING (R13 — `organize_create` accepts `parentId` for `type: 'goal'` with no guard; `groupByParent` silently drops 3-level goal chains) MUST land in v1.14.3. Non-negotiable. Verified at `src/tools/organize_create.ts:46`: `parentId: ItemIdSchema.optional()` has NO type-restriction guard. Verified at `groupByParent` per ADR 011 D13 lines 762-790: a goal with parentId pointing to another goal that itself is a child gets dropped from both `groups` and `topLevel`. The fix is a 5-line conditional in `organize_create.ts` BEFORE the storage write at lines 389/488 (the two `createItem` call sites for type=event and type=task/goal). It ships as the FIRST commit of Phase 2 because the v1.14.3 hierarchy renderer ships in the SAME release as the create-time guard — the data invariant the architect originally assumed must be enforced before the renderer that depends on it goes live.

This revisions document supersedes the relevant clauses of ADR 011 by reference; the parent ADR is not edited.

---

## Resolved (R-numbered, ordered by file impact for Phase 2)

### R13 (BLOCKING — supersedes ADR 011 D5/D13 implicit assumption "goals don't have parentId by design") — Forbid goal-with-parent at create-time

**Concern (DA P12).** ADR 011 D5 + D13 + the §CP1 surface line 989 QA-prep section claimed "Goals don't have parentId by design." DA verified this is FALSE in code at `src/tools/organize_create.ts:46`:

```typescript
parentId: ItemIdSchema.optional().describe('Id of a parent goal (optional).'),
```

No type-restriction guard. A user (or autonomous agent calling `organize_create`) can pass `{type: 'goal', parentId: '<some-other-goal-id>'}`; the tool accepts it, writes to disk, and the storage layer dutifully records `parentId` in the goal's front-matter. The v1.14.3 `groupByParent` at D13 lines 762-790 traces:

  - First loop: child-goal-with-parent goes into `childrenByParentId.get(parentId)`. NOT pushed to `topLevel`.
  - Second loop: iterates `topLevel` only. Child goal is NOT in `topLevel`. **Loop never visits it.** `groups` contains only `{goal: top-level-goal, children: [child-goal]}`. **Any grandchild of the child goal is silently dropped.**

A 3-level chain — Goal A (no parent) → Goal B (parentId: GA) → Goal C (parentId: GB) — produces a UI rendering of `[{goal: GA, children: [GB]}]` with GC entirely absent. **Silent UI data loss in a real data shape that exists in code today.**

**This is BLOCKING for v1.14.3 specifically.** Pre-v1.14.3 the chat-side and webapp both rendered all items flat; goal-with-parent was a latent data-shape that no UI surface exposed. v1.14.3 ships the hierarchy renderer; goal-with-parent items become silent data loss the moment the iteration ships.

**Decision — pick R13 over R14 and R15.**

**R13 — 5-LOC fix in `organize_create.ts`.** Insert a type-restriction guard BEFORE the storage write at the two `createItem` call sites. Place it just after the privacy-filter block (after line 202) and just before the cap check (line 208) so the guard short-circuits BEFORE the cap-check and storage path:

```typescript
// --- Type-shape guard: goals are top-level (R13 BLOCKING from CP1 v1.14.3) ---
if (input.type === 'goal' && input.parentId) {
  ctx.memory.auditLog.insert({
    category: 'organize.create',
    actor_chat_id: ctx.chatId,
    actor_user_id: ctx.userId,
    session_id: ctx.sessionId,
    detail: { type: 'goal', result: 'rejected', reason: 'GOAL_CANNOT_HAVE_PARENT' },
  });
  return {
    ok: false,
    output: 'Goals are top-level; only tasks and events can have a parent goal.',
    error: { code: 'GOAL_CANNOT_HAVE_PARENT', message: 'goal with parentId rejected' },
  };
}
```

**Justification over R14 (recursive groupByParent) and R15 (warn-on-detection).**

1. **Smallest blast radius.** R13 is 5 LOC + 1 audit-shape constant + 1 unit test. R14 is ~30 LOC of recursive client-side rendering + ~5 more test cases + UI redesign for nested-goal visual hierarchy (chevron-of-chevron, indentation depth, etc.). R15 is ~5 LOC but PRESERVES the silent-drop in the rendered output (only adds a console.warn that users won't see) — below the bar.
2. **Fixes the architect's data-shape assumption at the SOURCE.** ADR 011 D5/D13 is correct ASSUMING goals are top-level. R13 enforces that assumption at the only write surface that violates it. The hierarchy renderer's "1-level flat" semantics (per the architect's binding at D5 + D13) become a true data invariant rather than an aspirational one.
3. **Future-proofs v1.14.5+.** The architect's D15 #2 plans to add `parentId` to ALLOWED_PATCH_FIELDS in v1.14.5+. When that work happens, the validator MUST reject `{parentId, type: 'goal'}` (mirror of R13's create-time guard). R13's audit-log + error-code precedent makes the v1.14.5 patch a straightforward extension.
4. **No data migration.** Pre-v1.14.3 items with goal-with-parent (if any exist in user data) remain on disk untouched. The renderer will drop them silently on first display; the user can fix by editing the file's front-matter manually OR by deleting and recreating without parentId. **Phase 2 verifies via a one-time grep**: walk `data/organize/<userId>/*.md` for files with `type: goal` AND `parentId: ` non-null; count occurrences across the test fixture set + the dev/canary user data. If any exist, surface a one-line CHANGELOG note: "v1.14.3 forbids goals with a parent goal; existing goal-with-parent items will not appear under their parent in the new hierarchy view (they render as orphan top-level)." Documented.
5. **Defense in depth at the validator.** ADR 011 D2/D3 expanded `ALLOWED_PATCH_FIELDS` from 4 to 6 (adds `notes`, `progress`); `parentId` is NOT in the allowed list. A PATCH with `{parentId: 'x'}` already returns `PATCH_NO_VALID_FIELDS` or `PATCH_UNKNOWN_FIELDS`. R13 closes the create-time gap; the validator has the patch-time gap closed by extension. R11 below adds the explicit tests.

**Why R14 is not the right call.** Recursive grouping changes the visual hierarchy of the webapp — the v1.14.3 brief's "1-level flat (goals as headers; tasks/events nested under them)" becomes "N-level tree." Touch the rendering surface, the collapse-state semantics (one collapsed-state-per-goal vs collapsed-state-per-subtree), the chevron tap-target ergonomics (deeper indent = smaller hit zone), and the orphan-rendering edge case (D5) all need re-design. Out of scope for v1.14.3.

**Why R15 is not the right call.** Console.warn is invisible to users. The user sees the silent-drop in the rendered output; the warn is operator-forensics only. Defense in depth WITHOUT user-visible recovery is below the bar — same posture as DA's P12 framing.

**ALSO — explicit PATCH-time test (DA P9 / R11 confirmed).** The architect's QA-prep claim that the v1.14.3 PATCH validator REJECTS `parentId` is correct by EXTENSION (it's not in `ALLOWED_PATCH_FIELDS` per `validation.ts:86-91`; D2/D3 extends to 6 fields, NOT 7). DA verified this; the rejection path is `PATCH_UNKNOWN_FIELDS` (when mixed) or `PATCH_NO_VALID_FIELDS` (when alone). But the test plan does NOT explicitly cover this. R11 below binds the explicit tests so v1.14.5 dev sees the deliberate v1.14.3 rejection.

**Tests required (Phase 2).** Add to `tests/unit/organize.commands.test.ts` (or `tests/unit/tools.organize_create.test.ts` if the file exists; check Phase 2):

  1. **Test create-1:** `organize_create({type: 'goal', title: 't', parentId: 'GA'})` → result `{ok: false, error: {code: 'GOAL_CANNOT_HAVE_PARENT'}}`; output text matches `/Goals are top-level/`; audit row in `organize.create` with `result: 'rejected'`, `reason: 'GOAL_CANNOT_HAVE_PARENT'`; NO file written to disk.
  2. **Test create-2:** `organize_create({type: 'task', title: 't', parentId: 'GA'})` → succeeds normally (sanity check; non-goal types still accept parentId).
  3. **Test create-3:** `organize_create({type: 'event', title: 't', parentId: 'GA', due: '...', endTime: '...'})` → succeeds (event with parentId is the existing valid shape; defensive regression).

**File/line impact.**

  - `src/tools/organize_create.ts:202-208` — INSERT the 5-LOC guard between privacy-filter block (`:202`) and cap check (`:208`). Audit row category is `organize.create` (existing) with new `reason: 'GOAL_CANNOT_HAVE_PARENT'`.
  - `tests/unit/organize.commands.test.ts` (or equivalent) — 3 unit tests above (~25 LOC).

---

### R11 (HIGH — supersedes ADR 011 §Test plan implicit by-extension claim) — Explicit `parentId`-rejection PATCH tests

**Concern (DA P9 / Anti-Slop §11 carry-forward).** ADR 011 D2/D3 extended `ALLOWED_PATCH_FIELDS` from 4 to 6 fields (`title, due, status, tags, notes, progress`). `parentId` is intentionally NOT in the list. A PATCH `{parentId: 'x'}` returns `PATCH_NO_VALID_FIELDS`; a PATCH `{title: 'foo', parentId: 'x'}` returns `PATCH_UNKNOWN_FIELDS`. The architect's claim is correct BY EXTENSION but the test plan at lines 920-931 of ADR 011 does NOT include explicit `parentId`-rejection cases. v1.14.5 dev planning to add `parentId` to ALLOWED_PATCH_FIELDS needs the negative tests as a SOURCE OF TRUTH that v1.14.3 deliberately rejected the field.

**Decision (accept R11 in full).**

Add to `tests/integration/webapp.organize.mutate.test.ts` (or wherever the v1.14.2 PATCH validator integration tests live; verify Phase 2 against the actual test file path — `webapp.organize.test.ts` per ADR 010 patterns):

  - **Test M-NEW-P1:** PATCH `/api/webapp/items/<id>` with body `{parentId: '2026-04-20-abcd'}` (alone, valid item-id format) → 400 + `{ok: false, code: 'PATCH_NO_VALID_FIELDS', error: 'No recognized fields in patch body. Allowed fields: title, due, status, tags, notes, progress.'}`.
  - **Test M-NEW-P2:** PATCH with body `{parentId: 'not-an-id'}` (alone, malformed) → 400 + `{ok: false, code: 'PATCH_NO_VALID_FIELDS', ...}` (still rejected at the validator level via the same path; the field is unknown regardless of value validity).
  - **Test M-NEW-P3:** PATCH with body `{parentId: null}` (alone) → 400 + `{ok: false, code: 'PATCH_NO_VALID_FIELDS', ...}` (defensive — null is not a special-case in the unknown-field detector; same rejection path as a string value).
  - **Test M-NEW-P4 (mixed-with-allowed):** PATCH with body `{title: 'new title', parentId: '2026-04-20-abcd'}` → 400 + `{ok: false, code: 'PATCH_UNKNOWN_FIELDS', error: '...includes parentId...'}`. **Critically asserts the on-disk title is UNCHANGED** (re-read via `readItem`; byte-identical to pre-PATCH). The validator-fail short-circuits BEFORE the storage call; no partial mutation should land.

The test labels are P1/P2/P3/P4 ("P" = parentId rejection) so they group cleanly in the test output.

**File/line impact.**

  - `tests/integration/webapp.organize.mutate.test.ts` (or the actual test file path Phase 2 finds) — 4 integration tests above (~30 LOC).

---

### R7 (HIGH — supersedes ADR 011 D1's binding survey by closing the read-side inconsistency window in `listItems`) — Filter `deletedAt != null` in `listItems`

**Concern (DA P5).** Verified at `src/organize/storage.ts:702` (`writeAtomically(srcPath, rewriteContent)` — the live file is rewritten with `deletedAt` stamped) and `:721` (`rename(srcPath, destPath)` — the now-deletedAt-stamped live file is renamed to .trash/). Between line 702's atomic write resolution and line 721's rename, the LIVE dir contains a file with `deletedAt: <ISO>` set. On Windows NTFS this window can be tens of ms (filesystem cache flush, antivirus scan, etc.). Verified at `:529-532` that `listItems` filters by `status / type / tag` only; **it does NOT filter by `deletedAt`**. A concurrent `listItems` reader running between `:702` and `:721` returns an "active" item with `deletedAt` set.

This is an EXISTING v1.11.0 issue — R3 introduced the deletedAt-rewrite-then-rename pattern. v1.14.3 INHERITS it and also INCREASES observability: the new `updated:` field gets stamped on the same rewrite (per D1), so during the window the file has BOTH a fresh `updated:` AND a `deletedAt:` simultaneously — forensically interesting but UI-incoherent (an active item with deletedAt set).

**Decision — pick R7 (close the read-side window).**

**R7 — 2-LOC defensive filter in `listItems`.** Update `src/organize/storage.ts:529-532` to also skip items with `fm.deletedAt != null`. The filter goes BEFORE the existing filter chain so the early-skip avoids the existing comparisons:

```typescript
const { fm, notesBody, progressBody } = outcome.result;

// R7 (CP1 v1.14.3 HIGH): defense in depth against the v1.11.0
// softDeleteItem rewrite-then-rename window. Items with deletedAt set
// MUST not appear in active listings even if they're still in the live dir
// during the ~5-50ms two-stage write window.
if (fm.deletedAt != null) continue;

// Apply filters.
if (filter.status !== undefined && fm.status !== filter.status) continue;
// ... existing filters ...
```

**Justification.**

1. **Defense in depth, not a fix.** The "real" fix to the inconsistency window is to invert `softDeleteItem`'s order (rename first, then rewrite at the new path) — but inverting the order has its own failure mode (rename succeeds → rewrite fails → file is in .trash with NO deletedAt stamp, evictor falls back to mtime). The architect's current order is acceptable; R7 just closes the read-side observability gap.
2. **2 LOC + 1 test = strictly positive.** No callers regress: pre-R7, `listItems` returned items with deletedAt set during the brief window; post-R7, those items are filtered. The only client that COULD have observed those items is the chat-side `/organize all`, the chat-side `/organize <id>` (which uses `readItem`, not `listItems` — unaffected), the webapp LIST endpoint (which already filters by `status: 'active'` on the user-facing path; the deletedAt-set-but-active state slipped through that filter), and the active-cap counter (`countActiveItems` delegates to `listItems`). The cap counter post-R7 is MORE accurate, not less.
3. **Closes the v1.11.0 latent issue at v1.14.3 cost.** The v1.11.0 issue was below the bar at single-grammY-message scale; v1.14.3 reads (LIST endpoint via webapp) can race v1.14.3's softDelete (chat-side `/organize delete <id>` or webapp DELETE endpoint). R7 is the cheapest insurance.
4. **The architect's D1 stamping survey already documents the inconsistency.** D1's "softDeleteItem rewriteContent" row says "Content change (stamps `deletedAt`)" and the rename row says "no content change, no stamp." The window between rewrite and rename is the inconsistency. R7 doesn't change the write path — only the read path's tolerance.

**Test required (Phase 2).** Add to `tests/integration/storage.softDelete.test.ts` (or wherever v1.11.0's softDelete tests live; verify in Phase 2):

  - **Test SD-NEW1:** Inject a hook between line 702 (`writeAtomically`) and line 721 (`rename`) — e.g., monkey-patch `rename` to `setTimeout(() => realRename(...), 50)`. Soft-delete an item; concurrently call `listItems`. Assert `listItems` does NOT return the item being soft-deleted, even when called inside the window. ~15 LOC.

If injecting a delay is too disruptive, an alternative test asserts the BEHAVIOR via a unit test on a synthesized in-memory file: write a file with `deletedAt: '2026-04-25T...'` set INTO the live dir directly (bypassing `softDeleteItem`); call `listItems`; assert the file is NOT returned. Same outcome, less mock surface.

**File/line impact.**

  - `src/organize/storage.ts:529-532` — INSERT the 2-LOC filter just before the existing filter block.
  - `tests/integration/storage.softDelete.test.ts` (or equivalent) — 1 race-window test (~15 LOC).

**Documentation note.** Update D1's "Write paths that MUST call stampUpdated" table in ADR 011 line 141-148 to add a one-liner under the `softDeleteItem rewriteContent` row: "**Read-side note:** during the ~5-50ms between rewrite and rename, a concurrent listItems reader sees a deletedAt-stamped item in the live dir; R7 (CP1 v1.14.3) filters this out at the read side." Documentation only; no code beyond R7 itself.

---

### RA1 (Anti-Slop RA1 — supersedes ADR 011 D9's two-stage write JSDoc) — `restoreItem` rename-first pattern

**Concern (Anti-Slop RA1).** ADR 011 D9 lines 597-609 specified the `restoreItem` storage primitive with the order `writeAtomically(live, content-without-deletedAt) → unlink(trash)`. Anti-Slop verified that this is NOT symmetric with `softDeleteItem`'s `writeAtomically(live, ...) → rename(live, trash)` pattern. The asymmetry creates an unaudited orphan in the unlink-failure case: live + trash files both exist with the same id; a subsequent `softDeleteItem` falls into the collision-suffix branch at `:716-718` and creates `<id>--<unix>-<hex>.md` in trash alongside the orphan `<id>.md`. Two trashed copies of the "same id" with different content; the evictor eventually deletes both per TTL, but operator forensics of "what did this item look like at time T?" becomes ambiguous.

The v1.14.2 BLOCKING fix (R8 random tmp suffix) was about temp-file racing at the WRITE boundary; this RA1 is about atomicity at the file-MOVE boundary. Different concern, different fix.

**Decision (pick A — `rename(trash, live)` symmetric with `softDeleteItem`).**

**A — `restoreItem` rename-first pattern.** Update D9's `restoreItem` storage primitive to mirror `softDeleteItem`'s ordering. The implementation has TWO atomic operations:

1. **`rename(trashPath, livePath)`** — atomic file move at the filesystem boundary. After this resolves, the file exists at `<id>.md` in the live dir. NO orphan possible: rename fails → file stays in trash (no data movement); rename succeeds → file is in live with the still-stamped `deletedAt` from softDeleteItem and the original `updated:` from softDeleteItem. The two-of-two failure case (rename succeeds; the next operation fails) is benign: the file is correctly in the live dir; the next call to `readItem` will succeed; the only oddity is that the live file STILL has `deletedAt` set (transient — the next operation fixes it).

2. **`updateItem(userId, dataDir, itemId, {})` to strip `deletedAt` and stamp fresh `updated:`** — uses the existing primitive. The empty patch `{}` triggers a re-serialize of the front-matter via `stampUpdated` (per D1's binding) without changing any user-visible field. The `deletedAt` stamp gets dropped by `updateItem`'s patch-application logic (since `deletedAt` is not in `UpdateItemPatch`'s field set, it's not preserved on re-serialize — verify in Phase 2 against the existing `updateItem` implementation; if it IS preserved, add an explicit `if (fm.deletedAt) fm.deletedAt = null;` step in the rewriteContent path before serializeItem).

**Wait — verify the empty-patch behavior.** `updateItem` at `storage.ts:612-662` reads the file, applies the patch, re-serializes via `serializeItem`. `serializeItem` at `:131-160` writes `deletedAt` only if `fm.deletedAt != null` (per the v1.11.0 R3 conditional pattern). So if the rewriteContent step sets `fm.deletedAt = null` BEFORE re-serializing, the field gets dropped from the on-disk file. **The empty-patch approach works IF `restoreItem` explicitly sets `fm.deletedAt = null` on the parsed FM before delegating to updateItem's path.** Cleaner than calling updateItem directly: do the strip + stamp in a dedicated `restoreItem` function so the audit trail is clear.

**Revised `restoreItem` signature (binding for Phase 2):**

```typescript
/**
 * Restore a soft-deleted item: atomic rename from .trash/<id>.md back to <id>.md,
 * then strip deletedAt and stamp fresh updated: via a separate atomic write.
 *
 * v1.14.3 RA1 from CP1: pattern symmetric with softDeleteItem (rename-first).
 * Replaces the original D9 spec's writeAtomically(live) → unlink(trash) ordering,
 * which had an unaudited orphan in the unlink-failure case.
 *
 * Two atomic operations, BOTH must succeed for the restore to be complete:
 *   Step 1: rename(trash, live) — atomic file move; no data loss possible.
 *           After this resolves, the file is in the live dir with the original
 *           softDeleteItem-stamped deletedAt + updated still in the front-matter.
 *   Step 2: read(live) → strip deletedAt → stamp fresh updated: → writeAtomically(live)
 *           via the existing R8-random-tmp-suffix-protected primitive. If this
 *           step fails, the file is in the live dir with deletedAt set
 *           (transient inconsistent state). R7 above filters it out of listItems
 *           during the window. Operator can manually re-run restoreItem; the
 *           rename will fail with EEXIST (live exists), the function recovers by
 *           skipping rename and proceeding to step 2 alone.
 *
 * Throws:
 *   - ITEM_NOT_FOUND_IN_TRASH if .trash/<id>.md doesn't exist.
 *   - ITEM_ALREADY_LIVE if <id>.md already exists in the live dir AND the
 *     trash file ALSO exists (genuine ambiguity — caller resolves).
 *   - FILE_WRITE_FAILED for atomic-write failures during the deletedAt strip.
 *
 * @returns the restored OrganizeItem (with the new updated:).
 */
export async function restoreItem(
  userId: number,
  dataDir: string,
  itemId: string,
): Promise<OrganizeItem> {
  await ensureUserDir(userId, dataDir);
  await ensureTrashDir(userId, dataDir);
  const liveDir = organizeUserDir(userId, dataDir);
  const trashPath = path.join(liveDir, '.trash', `${itemId}.md`);
  const livePath = path.join(liveDir, `${itemId}.md`);

  const trashExists = existsSync(trashPath);
  const liveExists = existsSync(livePath);

  if (!trashExists && !liveExists) {
    throw Object.assign(new Error(`Item not in trash: ${itemId}`), { code: 'ITEM_NOT_FOUND_IN_TRASH' });
  }
  if (liveExists && trashExists) {
    throw Object.assign(
      new Error(`Item exists in both live and trash: ${itemId}`),
      { code: 'ITEM_ALREADY_LIVE' },
    );
  }

  // Step 1: atomic rename trash → live (skip if step-2-only recovery path)
  if (trashExists) {
    await rename(trashPath, livePath);
  }

  // Step 2: read, strip deletedAt, stamp updated, atomic write
  const raw = await readFile(livePath, 'utf8');
  const outcome = parseItemFile(raw, itemId);
  if (!outcome.ok) {
    throw Object.assign(
      new Error(`Restored item is malformed: ${itemId}`),
      { code: 'ITEM_MALFORMED' },
    );
  }

  const { fm: parsedFm, notesBody, progressBody } = outcome.result;
  const fm = stampUpdated({ ...parsedFm, deletedAt: null });
  fm.id = itemId; // R7 normalize (v1.11.0)

  const content = serializeItem(fm, notesBody, progressBody);
  await writeAtomically(livePath, content);

  log.info({ userId, itemId }, 'organize item restored');
  return { frontMatter: fm, notesBody, progressBody, filePath: livePath };
}
```

**Justification over Option B (keep two-stage with cleanup-on-failure logic).**

1. **Rename is atomic at the filesystem level.** No window where both files exist; no orphan trash file possible. Symmetric with `softDeleteItem`'s rename pattern. R8's random-tmp-suffix already protects the writeAtomically step from concurrent races.
2. **Recovery story is clean.** If step 1 (rename) fails, the trash file is intact; user retries. If step 2 (deletedAt-strip + updated-stamp) fails, the file is in the live dir with the original deletedAt still set; R7 filters it from `listItems` during the window; operator/user retries via a second `restoreItem` call which sees `liveExists && !trashExists`, skips the rename, and proceeds to step 2 alone (idempotent).
3. **No new audit category.** D9's `organize.restore` audit row stays the same shape; failure recovery doesn't need a new sibling category.
4. **The duplicate-trash-files concern is structurally impossible.** The original D9 ordering's unlink-failure-leaves-orphan case is the failure mode Anti-Slop flagged. The new ordering's failure modes are: (a) rename fails → no movement → no orphan; (b) write-after-rename fails → file in live dir with deletedAt set → R7 hides from listings → next restore call recovers idempotently. **No filesystem state can produce two trash files of the same id.**

**Why Option B is not the right call.** "Cleanup-on-failure logic" means try-catch around unlink, retry-with-backoff, audit-the-orphan, etc. — same complexity as a generic distributed-systems retry layer. Strictly worse than getting the ordering right.

**File/line impact.**

  - `src/organize/storage.ts` — `restoreItem` (~60 LOC; +10 LOC vs the original D9 spec for the rename-first pattern + idempotent recovery branch).
  - `tests/integration/organize.restore.test.ts` — D9's existing 7-test plan PLUS one additional test:
    - **Test R-NEW1:** inject a failure on the writeAtomically step (mock `writeAtomically` to throw on the second call); call `restoreItem`; assert the file IS in the live dir (rename succeeded), `deletedAt` IS still set (write failed); `listItems` does NOT return the item (R7 filters it); call `restoreItem` again; assert it succeeds idempotently (skip rename branch hits via `liveExists && !trashExists`).

---

### RA2 (Anti-Slop RA2 — supersedes ADR 011 D12 silent dead-field carry-forward) — Drop `sawUnknown: false` from validation.ts

**Concern (Anti-Slop RA2; F3 carry-forward from v1.14.2 Phase-2 review).** Verified at `src/organize/validation.ts:94` and `:259`:

```typescript
// Line 94
| { ok: true; patch: AllowedPatch; sawUnknown: false }

// Line 259
return { ok: true, patch, sawUnknown: false };
```

The `sawUnknown` field is vestigial from an earlier silent-strip design that R15 (from v1.14.2 CP1 revisions) superseded — explicit-reject-on-mix replaced silent-strip-with-flag. Zero callers read the field (verified by Anti-Slop Phase-2 v1.14.2 review §F3). v1.14.3 ADR 011 D2/D3 add NOTES_TOO_LONG / PROGRESS_TOO_LONG to the union and edit BOTH lines 94 and 259 to extend the success branch; this is the right moment to drop the dead field. Missing it now means the dead field carries forward a third iteration.

**Decision (accept RA2 in full).**

Phase 2 dev makes a 3-line edit to `src/organize/validation.ts`:

  - **Line 94** — drop `sawUnknown: false` from the success branch of `ValidationResult`. The line becomes:
    ```typescript
    | { ok: true; patch: AllowedPatch }
    ```
  - **Line 259** — drop `sawUnknown: false` from the return statement. The line becomes:
    ```typescript
    return { ok: true, patch };
    ```
  - **Any caller code** — no changes needed; zero callers read the field per F3.

3 LOC delta. Closes F3 at the architectural level. Phase 2 anti-slop greps for `sawUnknown` post-edit and asserts zero matches.

**File/line impact.**

  - `src/organize/validation.ts:94` — 1-LOC edit (drop `; sawUnknown: false` from union variant).
  - `src/organize/validation.ts:259` — 1-LOC edit (drop `, sawUnknown: false` from return object).
  - No test file changes (zero callers; no existing test references the field per the v1.14.2 Phase-2 §F3 grep).

---

### RA3 (Anti-Slop RA3 — supersedes ADR 011 §Module/file plan implicit enumeration) — `KNOWN_ISSUES.md` + `CLAUDE.md` enumeration

**Concern (Anti-Slop RA3; W8 carry-forward from v1.14.2 Phase-2 review; 7th consecutive iteration).** ADR 011 §Module/file plan listed `CLAUDE.md` as EDIT (+12 LOC) and `KNOWN_ISSUES.md` as EDIT (+18 LOC) but did NOT enumerate the entries. Phase 2 dev would improvise the wording without a binding template. The v1.14.2 Phase-2 review's F2 listed six explicit entries the architect needed to write; this same vigilance is needed.

**Decision (accept RA3 in full; enumerate both files).**

**`KNOWN_ISSUES.md` v1.14.3 entries (binding for Phase 2; SEVEN entries):**

  1. **`updated:` ISO front-matter field — auto-stamped on every write path.** Added v1.14.3. Optional field (`string | null`) on `OrganizeFrontMatter` and `OrganizeItemDetail`. Stamped via `stampUpdated()` helper at five write paths: `createItem`, `updateItem`, `softDeleteItem` rewriteContent, `appendProgressEntry`, `restoreItem`. NOT stamped at `softDeleteItem` rename (pure FS move) or `evictExpiredTrash` unlink (hard delete). Pre-v1.14.3 items don't have the field; parser tolerates missing field; first edit stamps it. Foundation for v1.14.4's ETag work (`W/${updated}`).

  2. **`restoreItem` storage primitive uses rename-first pattern.** Per CP1 v1.14.3 RA1. Symmetric with `softDeleteItem`'s `rename(live, trash)` ordering. Two atomic ops: `rename(trash, live)` then `writeAtomically(live, content-without-deletedAt-with-updated-stamp)`. Idempotent recovery if the second op fails (R7 filters live-with-deletedAt from listings during the window; next restoreItem call sees `liveExists && !trashExists`, skips rename, proceeds to step 2). NO orphan trash file possible.

  3. **Hierarchy grouping in client-side `public/webapp/organize/hierarchy.js`.** Pure JS module; exports `groupByParent`, `loadCollapseState`, `saveCollapseState`, `isCollapsed`, `toggleCollapsed`, `pruneCollapseState`. No dependencies; no DOM. Server returns flat list with `parentId`; client groups. SessionStorage key `organize-collapse-state-v1` (v1.14.0 R10 precedent).

  4. **PATCH body cap 32KB (raised from 1KB).** v1.14.3 D4. `express.json({ limit: '32kb' })` at the PATCH route. Returns 413 (NOT 400) when exceeded; server-level error handler wraps Express's `PayloadTooLargeError` to emit unified envelope `{ok: false, code: 'PAYLOAD_TOO_LARGE', error: 'Request body exceeds 32KB.'}`. Multilingual UTF-8 edge case: a 10240-char CJK notes field is up to ~30KB UTF-8; combined with 20KB progress + headers, can exceed 32KB body cap; user splits saves into title-only-then-notes-only-then-progress-only OR trims content. Documented in README.

  5. **New audit category `organize.restore`** (chat-side restore command). Detail JSON shape: `{itemId}` only — no title, no notes, no progress (privacy posture per v1.14.2 RA2 + W5 carry-forward). Emitted on successful `/organize restore <id>` chat command; one row per success. Migration `012_audit_organize_restore.sql` is a marker migration mirroring `011_audit_webapp_item_mutate.sql` (idempotent CREATE INDEX IF NOT EXISTS only; no DDL).

  6. **Goal-with-parentId rejected at create-time.** Per CP1 v1.14.3 R13 BLOCKING fix. `organize_create` returns `{code: 'GOAL_CANNOT_HAVE_PARENT'}` when `type === 'goal' && parentId != null`. Audit row in `organize.create` with `result: 'rejected'`, `reason: 'GOAL_CANNOT_HAVE_PARENT'`. Pre-v1.14.3 items with goal-with-parent (if any exist in user data) remain on disk but render as orphan top-level in the v1.14.3 hierarchy view (their parent goal does NOT contain them as children; the renderer drops the relationship to preserve "1-level flat" semantics). v1.14.5+ may add `parentId` to ALLOWED_PATCH_FIELDS; that work MUST also reject `parentId` for goals (mirror of R13 at the validator).

  7. **New `OrganizeListItem` interface in `src/organize/types.ts`** (replaces anonymous LIST projection from v1.14.0). Closes 5-iteration carry-forward (v1.14.0 W6 → v1.14.2 Phase-2 F4 → v1.14.3 D6/RA-equivalent). 12-field shape with `parentId` (NEW — required for hierarchy rendering) and `updated` (NEW per v1.14.3 D1) added to the existing 10 fields. Phase 2 type-annotates the projection at `src/webapp/items.read.ts:101-112`.

**`CLAUDE.md` v1.14.3 entries (binding for Phase 2; THREE topics):**

  a. **`stampUpdated` discipline at `src/organize/storage.ts`.** Every write path that calls `serializeItem` with new content MUST stamp `updated:` via the `stampUpdated(fm)` helper. Pure rename ops (e.g., `softDeleteItem` rename to .trash) don't stamp (no content change). Hard deletes (`evictExpiredTrash` unlink) don't stamp (file is gone). Phase 2 grep-check: every `serializeItem` call in `storage.ts` is preceded by a `stampUpdated` call OR has an explicit comment justifying the omission.

  b. **`restoreItem` storage primitive + symmetric two-stage pattern with `softDeleteItem`.** Per RA1 above. The pattern is "rename-first, then write": atomic file move from trash to live, then atomic write to strip `deletedAt` + stamp `updated:`. The recovery branch (`liveExists && !trashExists`) is idempotent; operator can re-run on a partial restore. Any future v1.14.x `recoverItem` / `unArchiveItem` / etc. primitives MUST follow the same pattern.

  c. **`hierarchy.js` location + ES Modules vs window-global Phase-2 choice.** Pure JS module at `public/webapp/organize/hierarchy.js`. Phase 2 verifies Telegram WebApp ES Modules support via a quick smoke test (per the v1.14.0 R10 sessionStorage-availability verification pattern); if ES Modules work, use `import { groupByParent } from './hierarchy.js'` in `app.js`; if not, expose via `window.OrganizeHierarchy = {...}` and consume globally. Phase 2 documents the choice via a 2-LOC comment at the top of the consumer module so future maintainers know which form to use.

**Factory-level recommendation (carry-forward from v1.14.2 W8).** This is the 7th consecutive iteration with the recurring `KNOWN_ISSUES.md` enumeration gap. v1.14.2's revisions doc flagged it as a factory-level follow-up; that follow-up is STILL not actioned at the factory. Recommend the Lead Agent adds an entry to `<factory-repo>\KNOWN_ISSUES.md`:

> **Recurring pattern (7+ iterations): Architect Phase-1 ADRs consistently list `KNOWN_ISSUES.md` and `CLAUDE.md` in their §Module/file plan but omit ENUMERATED entries.** Occurrences: v1.11.0 W11, v1.12.0 W10, v1.13.0 W15, v1.14.0 W8, v1.14.2 Phase-1 W8, v1.14.2 Phase-2 F2, v1.14.3 Phase-1 RA3. **Default behavior change:** the Architect agent MUST include a `### KNOWN_ISSUES.md entries` and `### CLAUDE.md entries` subsection under §Module/file plan with explicit numbered entries. Anti-Slop Phase-1 reviewers MUST grep for `### KNOWN_ISSUES.md entries` in every ADR; missing → RA flag. Pipeline-level enforcement, not per-iteration vigilance.

This revisions doc DOES NOT write to the factory directory (per the "stay in build" rule). FLAGGED for Lead Agent action.

**File/line impact.**

  - `KNOWN_ISSUES.md` (project root) — 7 entries above (~40 LOC).
  - `CLAUDE.md` (project root) — 3 topics above (~15 LOC).
  - `<factory-repo>\KNOWN_ISSUES.md` — FLAGGED for Lead Agent action (NOT modified by this revisions doc).

---

### R1 (DA P1 MEDIUM — supersedes ADR 011 D2 + D3 implicit textarea HTML attributes) — Bind `maxlength` + character counter + 8KB warning

**Concern (DA P1).** ADR 011 D2 specifies `MAX_NOTES = 10240` server-side but does NOT bind `maxlength="10240"` on the new `<textarea>` HTML element. Same for D3's progress at 20480. Without client-side enforcement, a user pasting a 50KB note hits the 32KB body cap → 413 → "Request body exceeds 32KB" toast → no field-specific guidance. The user wastes ~50ms of network latency and must figure out which field is too big by trial and error.

**Decision (accept R1 in full).**

Update D2 and D3's "Validator rules" sections to include client-side enforcement as BINDING (not optional):

  - **HTML `maxlength`.** `<textarea maxlength="10240">` for notes; `<textarea maxlength="20480">` for progress. Server-side validator remains the authoritative check; client-side `maxlength` is UX (browser blocks further input at the cap).
  - **Live character counter.** Adjacent `<span class="char-counter">` shows `<current-length> / <max-length>` chars. Updates on every `input` event.
  - **Warning style at 80% threshold.** When `currentLength >= maxLength * 0.8` (i.e., 8000 for notes, 16384 for progress), the counter element gets a CSS class `char-counter--warn` (yellow/orange text). At `currentLength >= maxLength`, the counter gets `char-counter--error` (red text); the user is also blocked by the HTML `maxlength` from typing further but paste operations may push past — the counter visually surfaces overflow even if HTML enforcement engaged.
  - **Magic-number naming (per W1 below).** The 80% threshold gets a named constant `CHAR_COUNTER_WARN_THRESHOLD = 0.8`; the max values reuse the existing `MAX_NOTES_CLIENT = 10240` and `MAX_PROGRESS_CLIENT = 20480` (client-side constants mirroring the server-side `MAX_NOTES` / `MAX_PROGRESS` from validation.ts; if Phase 2 dev finds an opportunity to share via a build step, take it; otherwise duplicate the values with a comment binding them to the server-side source of truth).

**Implementation pattern (binding for Phase 2):**

```javascript
// public/webapp/organize/app.js — inside the edit-form setup
const CHAR_COUNTER_WARN_THRESHOLD = 0.8;
const MAX_NOTES_CLIENT = 10240;
const MAX_PROGRESS_CLIENT = 20480;

function attachCharCounter(textarea, maxLength) {
  const counter = document.createElement('span');
  counter.className = 'char-counter';
  counter.textContent = `0 / ${maxLength}`;
  textarea.parentElement.appendChild(counter);

  textarea.addEventListener('input', () => {
    const len = textarea.value.length;
    counter.textContent = `${len} / ${maxLength}`;
    counter.classList.toggle('char-counter--warn', len >= maxLength * CHAR_COUNTER_WARN_THRESHOLD && len < maxLength);
    counter.classList.toggle('char-counter--error', len >= maxLength);
  });
}

attachCharCounter(notesTextarea, MAX_NOTES_CLIENT);
attachCharCounter(progressTextarea, MAX_PROGRESS_CLIENT);
```

**Tests required (Phase 2).** Add to `tests/unit/webapp.organize.editForm.test.ts` (jsdom):

  - **Test EF-NEW1:** simulate typing into the notes textarea up to 8001 chars; assert the counter element has class `char-counter--warn`.
  - **Test EF-NEW2:** simulate typing 10241 chars; assert HTML maxlength prevented overflow (textarea value length is capped at 10240); counter has class `char-counter--error` if exactly at cap; class `char-counter--warn` reflects the threshold correctly.

**File/line impact.**

  - `public/webapp/organize/index.html` — `<textarea maxlength="10240">` + `maxlength="20480"`; `<span class="char-counter">` next to each textarea.
  - `public/webapp/organize/app.js` — `attachCharCounter` helper + threshold + client-side max constants (~20 LOC).
  - `public/webapp/organize/styles.css` — `.char-counter`, `.char-counter--warn`, `.char-counter--error` rules (~6 LOC).
  - `tests/unit/webapp.organize.editForm.test.ts` — 2 jsdom tests above (~25 LOC).

---

### R3 + R2 (DA P2 MEDIUM — supersedes ADR 011 D3 race-window mitigation; defense in depth) — Diff toast + audit line-count

**Concern (DA P2).** ADR 011 D3 documents the progress-overwrite race (SF-4) honestly: webapp PATCH `{progress}` overwrites; chat-agent's `appendProgressEntry` appends. mtime stale-warning catches detected races; v1.14.4 ETag closes properly. DA's pushback: the user's recovery experience depends on reading the toast, which is famously low-attention. Two complementary mitigations:

  - **R2 (audit line-count).** When staleWarning fires AND `progress` is in changedFields, the `webapp.stale_edit` audit detail JSON includes a `progressLineDelta: number` count (lines in pre-PATCH file MINUS lines in user's submitted progress). NOT the line content (privacy posture per RA-revisions). Just the count. Forensic readers can tell "user lost N agent entries" from the audit log alone.
  - **R3 (client-side diff toast).** When the user is about to save progress AND the client-side diff (current saved state vs current textarea state) shows a line-count delta exceeding a threshold, a "you're about to overwrite N entries" warning fires BEFORE the network call. User can review and choose.

**Decision (accept BOTH lightly — defense in depth).**

The user's brief asked: "R3 (preferred) cleaner UX; R2 defensive forensics. Pick R3 for v1.14.3; file R2-style audit metadata as v1.14.4 follow-up. **Actually pick BOTH lightly:** R3 for UX + R2 abbreviated as audit metadata `progressLineDelta: number` (no field values, just a count). Defense in depth."

**R3 (client-side diff before save) — binding for Phase 2.**

Before submitting the PATCH, the client computes `currentLineCount(textarea.value) - originalLineCount(item.progress)`. If the delta is < `-DIFF_WARN_THRESHOLD_LINES` (i.e., the user is removing more lines than the threshold), a `confirm()` dialog fires:

```javascript
const DIFF_WARN_THRESHOLD_LINES = 3;  // see W1 magic-number naming

function countLines(s) { return (s ?? '').split('\n').filter((l) => l.trim().length > 0).length; }

async function saveEditForm(itemId) {
  const submitted = progressTextarea.value;
  const original = currentItem.progress ?? '';
  const delta = countLines(submitted) - countLines(original);

  if (delta < -DIFF_WARN_THRESHOLD_LINES) {
    const removed = -delta;
    const ok = window.confirm(`You're about to remove ${removed} progress entries. Continue?`);
    if (!ok) return;
  }

  // proceed with PATCH
}
```

The threshold is 3 lines (configurable via the named constant) — 1-2 lines is editing-noise; 3+ is the user clearly removing content. The `confirm()` dialog is intentionally simple — Telegram WebApp supports `window.confirm`. Phase 2 verifies Telegram's confirm-dialog UX is acceptable in the in-app browser (if it's broken on iOS Telegram, fall back to a custom confirmation overlay using existing toast primitives).

**R2 (audit line-count) — binding for Phase 2.**

When the server receives a PATCH that includes `progress` AND staleWarning fires, the `webapp.stale_edit` audit detail JSON gains a `progressLineDelta: number` field:

```typescript
// inside items.mutate.ts PATCH handler, when staleWarning fires AND validated.progress !== undefined
const oldProgressLines = countLines(currentItem.progress);  // pre-PATCH state already read for stale check
const newProgressLines = countLines(validated.progress);
const progressLineDelta = newProgressLines - oldProgressLines;

await memory.auditLog.insert({
  category: 'webapp.stale_edit',
  // ... existing fields ...
  detail: { itemId, capturedMtimeMs, currentMtimeMs, action: 'patch', progressLineDelta },
});
```

NEVER the line content. Just the delta count. Privacy posture preserved.

**File/line impact.**

  - `public/webapp/organize/app.js` — `countLines` helper + R3 confirm-on-removal logic + `DIFF_WARN_THRESHOLD_LINES` constant (~15 LOC).
  - `src/webapp/items.mutate.ts` — R2 line-count computation + audit detail extension (~5 LOC).
  - `tests/unit/webapp.organize.editForm.test.ts` — 1 jsdom test for R3 (mock confirm; assert PATCH not sent when user cancels).
  - `tests/integration/webapp.organize.mutate.test.ts` — 1 integration test for R2 (mtime mismatch + progress patch → audit row has `progressLineDelta`).

---

### R5 (DA P4 MEDIUM — supersedes ADR 011 D9's bare 404) — Smart 404 with closest-id matches in trash

**Concern (DA P4).** ADR 011 D9's 404 reply is `"Couldn't find that item in trash: \`<id>\`. Use /organize all to see live items."` — implies "wrong id" when the actual reason is often "you typoed by one char" or "you deleted multiple items and don't remember which is which." The hint "use /organize all" is irrelevant for a trash-recovery flow.

**Decision (pick R5 over R6 — smart 404 with closest matches).**

Update D9's 404 reply to query `.trash/` for closest-id matches via Levenshtein distance. ~15 LOC.

**Implementation pattern (binding for Phase 2):**

```typescript
// inside handleRestoreItem, on the ITEM_NOT_FOUND_IN_TRASH path
async function findClosestTrashedIds(userId: number, dataDir: string, target: string): Promise<Array<{id: string; title: string}>> {
  const trashDir = path.join(organizeUserDir(userId, dataDir), '.trash');
  if (!existsSync(trashDir)) return [];
  const entries = (await readdir(trashDir)).filter((e) => e.endsWith('.md')).map((e) => e.slice(0, -3));

  const scored = entries.map((id) => ({ id, distance: levenshtein(target, id) }));
  scored.sort((a, b) => a.distance - b.distance);
  const top3 = scored.slice(0, 3).filter((s) => s.distance <= 4);  // 4 is permissive; tighter caps may be too strict

  // Read titles via readItemFrontMatter (cheap, parses front-matter only)
  const enriched = await Promise.all(top3.map(async ({ id }) => {
    try {
      const trashPath = path.join(trashDir, `${id}.md`);
      const fm = await readItemFrontMatterFromPath(trashPath);
      return { id, title: fm.title ?? id };
    } catch {
      return { id, title: '(unreadable)' };
    }
  }));

  return enriched;
}

// 404 reply branching
const matches = await findClosestTrashedIds(userId, dataDir, targetId);
if (matches.length > 0) {
  const lines = matches.map((m) => `  • \`${m.id}\`  (${m.title})`).join('\n');
  await ctx.reply(
    `Couldn't find \`${targetId}\` in trash. Closest matches:\n${lines}\nTry \`/organize restore <id>\` with the right id.`,
    { parse_mode: 'Markdown' },
  );
  return;
}
// fall through to R12 audit-lookup branching (below)
```

`levenshtein` is a 15-LOC vanilla implementation (no new npm dep per the v1.14.3 non-negotiables). Phase 2 dev places it in `src/utils/levenshtein.ts` (NEW) or inlines in the chat command file if simpler. The `readItemFrontMatterFromPath` helper extends the existing `readItemFrontMatter` to accept an absolute path (currently it accepts `userId + dataDir + itemId` and constructs the path internally; the trash variant needs a path-based call); if Phase 2 finds the existing helper works against trash paths via duck-typing, reuse — otherwise add a thin wrapper.

**Tests required (Phase 2).** Add to `tests/integration/organize.restore.test.ts`:

  - **Test R-NEW2:** soft-delete items A/B/C with ids `2026-04-20-abcd`, `2026-04-20-efgh`, `2026-04-20-ijkl`. Run `/organize restore 2026-04-20-abce` (typo: `abce` vs `abcd`). Assert the reply includes `2026-04-20-abcd` in the closest-matches list AND its title.
  - **Test R-NEW3:** run `/organize restore 9999-99-99-zzzz` (no close match in trash). Assert the reply falls through to the R12 audit-lookup path (below) — generic "no record" branch.

**File/line impact.**

  - `src/commands/organize.ts` — `handleRestoreItem` 404 path; ~25 LOC of closest-matches logic.
  - `src/utils/levenshtein.ts` (NEW) — ~15 LOC pure function.
  - `tests/integration/organize.restore.test.ts` — 2 tests above (~30 LOC).

---

### R9 + R10 (DA P8 MEDIUM — supersedes ADR 011 D2 + D3 textarea HTML attributes) — iOS textarea attributes + KNOWN_ISSUES note

**Concern (DA P8).** ADR 011 D2/D3 specify `<textarea>` as the edit primitive but don't bind iOS-specific HTML attributes. iOS soft-keyboard interactions with the Telegram WebApp viewport produce four failure modes: Save button below keyboard, autocorrect aggression, scroll position lost, textarea height too small.

**Decision (accept R9 + R10 in full).**

**R9 — bind iOS-friendly textarea attributes (binding for Phase 2).**

The notes textarea:

```html
<textarea
  id="edit-notes"
  rows="10"
  maxlength="10240"
  autocorrect="off"
  autocapitalize="sentences"
  spellcheck="true"
></textarea>
```

The progress textarea:

```html
<textarea
  id="edit-progress"
  rows="15"
  maxlength="20480"
  autocorrect="off"
  autocapitalize="sentences"
  spellcheck="true"
></textarea>
```

**The user's brief overrode DA's recommendation on autocapitalize and spellcheck.** DA recommended `autocapitalize="off" spellcheck="false"`. The user's specification is `autocapitalize="sentences" spellcheck="true"` — rationale: "notes is prose; spellcheck helps." Apply the user's specification verbatim. The autocorrect=off prevents URL-mangling and word-replacement; autocapitalize=sentences applies first-letter-of-sentence capitalization (helpful for prose); spellcheck=true surfaces typos via the browser's native spellcheck UI.

**`rows` attribute.** Notes gets `rows="10"` (visible height ~10 lines without scrolling); progress gets `rows="15"` (taller because progress accumulates). Both are scrollable when content exceeds the visible rows. NO autoresize (autoresize is library territory; non-negotiable per "no new npm deps").

**Scroll position preservation (Phase 2 polish, NOT bound).** The `textarea.addEventListener('blur', () => savedScrollTop = textarea.scrollTop)` + restore on next focus is filed as Phase 2 polish; if Phase 2 has time, implement (~5 LOC). If not, file as v1.14.5+ follow-up.

**R10 — KNOWN_ISSUES.md entry (per RA3 above).**

The KNOWN_ISSUES.md entries enumerated in RA3 already cover the iOS-keyboard concern indirectly via entry #4 (32KB body cap split-saves workaround). Add an EIGHTH entry to RA3's enumeration:

  8. **iOS soft-keyboard may obscure Save button when textarea is focused.** Telegram WebApp on iOS does not consistently auto-scroll-into-view on textarea focus. User must dismiss the keyboard manually (tap Done, or tap outside the textarea) before Save is reachable. Filed for v1.14.5+ if real-user complaints surface — possible mitigations include sticky Save bar at viewport bottom, or programmatic scroll-into-view on textarea blur. Documented in KNOWN_ISSUES.md per CP1 v1.14.3 R10.

**File/line impact.**

  - `public/webapp/organize/index.html` — 6 new HTML attributes on each textarea (12 attributes total).
  - `KNOWN_ISSUES.md` — append entry #8 to the v1.14.3 section per RA3 enumeration.

---

### R12 (DA P11 MEDIUM — supersedes ADR 011 D9's flat 404) — Informative 404 with audit-log lookup

**Concern (DA P11).** ADR 011 D9's 404 reply is the same regardless of whether the file was evicted by the 30-day TTL evictor (genuinely unrecoverable — user needs to know) or whether the user typoed (R5 closest-matches handles this). Operator forensics querying `audit_log WHERE itemId = '<id>'` see a delete row from Day 0 + no restore row + no file in trash on Day 35 → confused expectation of "should still be in trash."

**Decision (accept R12 in full).**

Update the `handleRestoreItem` 404 path to branch by audit-log lookup, after R5's closest-matches branch:

  - If R5's `findClosestTrashedIds` returned at least one match → reply with the closest-matches list (R5 branch handled; this R12 path is the fallback when no close match exists).
  - Otherwise: query `audit_log` for the most recent `webapp.item_mutate` row with `action: 'delete'` AND `itemId: <target>` (or the equivalent chat-side delete category — verify the exact category in Phase 2).
    - If found AND the row's `created_at` is more than 30 days ago → reply: `"Item \`<id>\` was deleted on <date> and the trash was evicted (30-day TTL). Cannot restore — hard delete is irreversible."`
    - If found AND less than 30 days ago → reply: `"Item \`<id>\` was deleted on <date> but should still be in trash. Filesystem may be inconsistent — please report."`
    - If NOT found in audit log → reply: `"Couldn't find any record of \`<id>\`. Did you typo the id? Check chat history for the original delete toast."` (generic "wrong id" path; the R5 closest-matches branch should have handled the typo case if there's anything close in trash).

The 30-day threshold is defined by the trash TTL constant (verify the existing constant in storage.ts; if it's not named, name it `TRASH_TTL_DAYS = 30` per W1 below).

**Implementation pattern (binding for Phase 2):**

```typescript
async function handleRestoreItemNotFound(ctx: Context, userId: number, dataDir: string, targetId: string, deps: Deps) {
  // Step 1 (R5): closest matches in trash
  const matches = await findClosestTrashedIds(userId, dataDir, targetId);
  if (matches.length > 0) {
    const lines = matches.map((m) => `  • \`${m.id}\`  (${m.title})`).join('\n');
    await ctx.reply(`Couldn't find \`${targetId}\` in trash. Closest matches:\n${lines}\nTry \`/organize restore <id>\` with the right id.`, { parse_mode: 'Markdown' });
    return;
  }

  // Step 2 (R12): audit-log lookup for prior delete event
  const priorDelete = await deps.memory.auditLog.findRecentDelete(userId, targetId);
  if (priorDelete) {
    const ageDays = (Date.now() - priorDelete.created_at) / (1000 * 60 * 60 * 24);
    if (ageDays > TRASH_TTL_DAYS) {
      await ctx.reply(`Item \`${targetId}\` was deleted on ${formatDate(priorDelete.created_at)} and the trash was evicted (${TRASH_TTL_DAYS}-day TTL). Cannot restore — hard delete is irreversible.`, { parse_mode: 'Markdown' });
    } else {
      await ctx.reply(`Item \`${targetId}\` was deleted on ${formatDate(priorDelete.created_at)} but should still be in trash. Filesystem may be inconsistent — please report.`, { parse_mode: 'Markdown' });
    }
    return;
  }

  // Step 3: generic "no record"
  await ctx.reply(`Couldn't find any record of \`${targetId}\`. Did you typo the id? Check chat history for the original delete toast.`, { parse_mode: 'Markdown' });
}
```

The `auditLog.findRecentDelete(userId, itemId)` is a NEW query primitive — Phase 2 dev adds it to `src/memory/auditLog.ts`. Signature: `findRecentDelete(userId: number, itemId: string): Promise<{ created_at: number } | null>`. SQL: `SELECT created_at FROM audit_log WHERE actor_user_id = ? AND category IN ('webapp.item_mutate') AND json_extract(detail, '$.action') = 'delete' AND json_extract(detail, '$.itemId') = ? ORDER BY created_at DESC LIMIT 1`. Reuses the existing `idx_audit_category_ts` index (per migration 011) for the category filter; the JSON-extract on detail is unindexed but bounded by the category filter so query cost is acceptable.

**Tests required (Phase 2).** Add to `tests/integration/organize.restore.test.ts`:

  - **Test R-NEW4:** soft-delete an item; manually advance the audit row's `created_at` to 35 days ago; manually unlink the trash file (simulating evictor); run `/organize restore <id>`. Assert reply matches `/evicted.*30-day TTL/`.
  - **Test R-NEW5:** soft-delete an item; manually unlink the trash file (simulating filesystem corruption mid-window); run `/organize restore <id>`. Assert reply matches `/should still be in trash/`.
  - **Test R-NEW6:** run `/organize restore 9999-99-99-zzzz` (id never existed; no audit row). Assert reply matches `/Couldn't find any record/`.

**File/line impact.**

  - `src/commands/organize.ts` — `handleRestoreItemNotFound` ~30 LOC (replaces the original D9 single-line 404 reply).
  - `src/memory/auditLog.ts` — `findRecentDelete` query primitive ~15 LOC.
  - `tests/integration/organize.restore.test.ts` — 3 tests above (~40 LOC).

---

### R4 (DA P3 OK — no change) — sessionStorage precedent verification

**Decision (KEEP D7).** No code change. Phase 2 dev verifies the v1.14.0 R10 sessionStorage-vs-localStorage reasoning still applies — Telegram WebApp localStorage availability has not improved since v1.14.0. If a future iteration finds localStorage is now reliable, a 1-LOC change in `hierarchy.js` swaps the storage backend.

Documentation only. No file impact beyond a 1-LOC comment in `hierarchy.js` (per W4 below).

---

### R6 (DA P6 OK — no change) — Hierarchy filter intersection orphan rendering

**Decision (KEEP D5).** Architect's pick of Option A (orphan child renders top-level when its parent is hidden by filter) stands. DA's steel-man for Option B (ghost-parent header) was real but doesn't outweigh — Option B introduces a UX primitive we don't have elsewhere and creates a half-filter-bypass affordance.

No file impact.

---

### R7-DA-P7 (DA P7 OK — no change) — Notes/progress XSS verification

**Decision (KEEP — no ADR change needed).** DA verified all three render paths (detail view via `textContent`; edit form via textarea `.value`; list view via no-content booleans). XSS-safe. Phase 2 Anti-Slop reviewer greps for `innerHTML` on any new client-side notes/progress code path; introduction of `innerHTML` is a Phase 2 gate failure.

No file impact beyond Phase 2 grep enforcement.

---

### R10-DA-P10 (DA P10 OK — no change) — 32KB body cap multilingual edge

**Decision (KEEP D4).** Architect's 32KB pick stands. Multilingual UTF-8 edge case (CJK 10240-char inflation up to ~30KB UTF-8) is documented honestly in D4 + KNOWN_ISSUES.md entry #4 (per RA3 enumeration above). User-facing mitigation: split saves OR trim.

No file impact.

---

### W1 (Anti-Slop W1 — supersedes implicit magic-number naming) — Named constants for ms literals + thresholds

**Decision (accept W1).** Phase 2 dev consolidates magic-number literals at the top of `app.js` and `hierarchy.js`:

```javascript
// public/webapp/organize/app.js — top-of-file constants block
const TOAST_DURATION_DEFAULT_MS = 3000;
const TOAST_DURATION_ERROR_MS = 4000;
const TOAST_DURATION_RESTORE_HINT_MS = 8000;
const TOAST_DURATION_STALE_WARN_MS = 5000;
const COLLAPSE_TOAST_MS = 2000;          // (if needed for hierarchy collapse confirmations)
const DIFF_WARN_THRESHOLD_LINES = 3;     // R3 progress overwrite warning (above)
const CHAR_COUNTER_WARN_THRESHOLD = 0.8; // R1 textarea counter warn-color threshold (above)
const MAX_NOTES_CLIENT = 10240;
const MAX_PROGRESS_CLIENT = 20480;
const TRASH_TTL_DAYS = 30;               // R12 audit-lookup age threshold
```

Phase 2 grep-checks: every numeric literal in `app.js` is either (a) a named constant defined at the top, (b) inline with a binding comment that explains the value, or (c) a documented exception (e.g., array indices, percentage math). Carries forward the v1.14.2 W1 posture into v1.14.3.

**File/line impact.**

  - `public/webapp/organize/app.js` — top-of-file constants block ~12 LOC (replaces ~12 inline literals across the file).

---

### W2 (Anti-Slop W2 — confirm `OrganizeListItem` type name binding) — Pin name

**Decision (accept W2).** The new interface is named `OrganizeListItem` (matches `OrganizeItemDetail` symmetry). DA's reference to `interface ListItem` in the v1.14.2 Phase-2 review was a shorthand; v1.14.3 binding name is `OrganizeListItem`. Phase 2 dev:

  - Defines `OrganizeListItem` in `src/organize/types.ts` (~12 LOC) per ADR 011 D6 lines 357-388.
  - References by name from `src/webapp/items.read.ts` (LIST projection).
  - References by name from any Phase 2 test that asserts the wire shape.

NO references to `ListItem` (without the `Organize` prefix) anywhere in v1.14.3 source. Phase 2 grep-checks: zero matches for `interface ListItem` or `type ListItem` in `src/`.

**File/line impact.** As specified in ADR 011 D6 (no delta from the parent ADR's binding).

---

### W3 (Anti-Slop W3 — supersedes implicit `evictExpiredTrash` non-stamping) — Document the explicit no-stamp path

**Decision (accept W3).** Update D1's "Write paths that MUST call stampUpdated" table in ADR 011 line 141-148 to add a row for `evictExpiredTrash`:

| Path | File:line | Stamps? | Why |
|---|---|---|---|
| `evictExpiredTrash` per-file `unlink` | `storage.ts:937` | NO | Hard delete; the file is removed entirely, not modified. Stamping `updated:` would be meaningless on a file that ceases to exist. |

This was the architect's implicit position (verified by Anti-Slop's end-to-end walk of `storage.ts`); the documentation only makes it explicit. No code change.

**File/line impact.** Documentation only — the ADR addendum table is the binding artifact. Phase 2 dev does NOT modify `evictExpiredTrash`.

---

### W4 (Anti-Slop W4 — supersedes implicit per-decision test labels) — Number tests by decision

**Decision (accept W4).** Phase 2 dev labels each new test with its source decision (M-1, M-2, M-NEW1, R-1, R-NEW1, etc.) so the test output greps cleanly to the ADR. Carries forward the v1.14.2 test-naming discipline. Mapping:

  - Tests covering D1 (`updated:` stamping per write path) → labels D1-1 through D1-5 (one per write path: createItem, updateItem, softDeleteItem, appendProgressEntry, restoreItem).
  - Tests covering D2 (notes editing) → D2-1 through D2-N.
  - Tests covering D3 (progress editing) → D3-1 through D3-N.
  - Tests covering D9 (restore command) → D9-1 through D9-N.
  - Tests added by CP1 revisions → R-prefix matching the R-number (R7-1, R11-P1 through R11-P4, R13-create-1 through create-3, R1-EF-NEW1, R12-NEW4, etc.).

Test docstrings include the binding ADR section reference: e.g., `it('D1-3: softDeleteItem stamps updated on rewriteContent (per ADR 011 D1 line 145)', ...)`. ~5 LOC of test docstring annotations across the 60-test plan.

**File/line impact.** Test files only — no source change. ~5 LOC of docstring annotations across `tests/unit/*` and `tests/integration/*`.

---

### W5 (Anti-Slop W5 — supersedes single-field audit-privacy assertion) — Three-way audit-privacy test

**Decision (accept W5).** ADR 011 D11's audit-privacy test at line 696 asserts that the audit row's detail JSON does not contain a sensitive value. Extend to cover THREE patterns:

  - **Test M-AP1 (notes only):** PATCH `{notes: '<sensitive-string-1>'}`; staleWarning fires; audit row's `JSON.stringify(detail).includes('<sensitive-string-1>')` is `false`.
  - **Test M-AP2 (progress only):** PATCH `{progress: '<sensitive-string-2>'}`; staleWarning fires; audit row's `JSON.stringify(detail).includes('<sensitive-string-2>')` is `false`.
  - **Test M-AP3 (both edited together):** PATCH `{notes: '<s1>', progress: '<s2>'}`; staleWarning fires; audit row's stringified detail does not contain EITHER sensitive string.

Sensitive strings are deliberately attacker-shaped (`<script>alert(1)</script>` or `password=secret123`) so the test catches both literal and quoted variants.

**File/line impact.**

  - `tests/integration/webapp.organize.mutate.test.ts` — 3 audit-privacy tests above (~25 LOC).

---

### W6 (Anti-Slop W6 — supersedes implicit Phase-2 implementation order) — Number the Phase-2 steps

**Decision (accept W6).** Add to ADR 011 a §Phase 2 implementation order section with 12 numbered steps:

> **Phase 2 implementation order (v1.14.3):**
>
> 1. `src/organize/types.ts` — add `OrganizeFrontMatter.updated` (D1), `OrganizeItemDetail.updated` (D1), `OrganizeListItem` interface (D6 / F4 closure).
> 2. `src/organize/storage.ts` — add `stampUpdated` helper (D1); update `serializeItem` and `parseItemFile` for the `updated:` field (D1).
> 3. `src/organize/storage.ts` — stamp `updated:` at every write path: createItem (D1), updateItem (D1), softDeleteItem rewriteContent (D1 + R7's read-side filter at listItems), appendProgressEntry (D1).
> 4. `src/organize/storage.ts` — add `restoreItem` storage primitive with rename-first pattern (D9 + RA1).
> 5. `src/organize/storage.ts` — add R7 `deletedAt != null` filter in `listItems`; storage tests for the race-window scenario.
> 6. `src/organize/validation.ts` — add NOTES_TOO_LONG, PROGRESS_TOO_LONG, NOTES_INVALID_CHARS, PROGRESS_INVALID_CHARS codes (D2/D3); extend `ALLOWED_PATCH_FIELDS` to six entries; drop dead `sawUnknown: false` per RA2; add MAX_NOTES + MAX_PROGRESS constants.
> 7. `src/webapp/items.read.ts` — extend LIST projection with `parentId` + `updated` (SF-1 + D1); type the projection as `OrganizeListItem[]` (W2).
> 8. `src/webapp/items.mutate.ts` — extend RA2 explicit-field-copy with notes/progress branches (D2/D3); raise body cap from `'1kb'` to `'32kb'` (D4); add R2 progress-line-delta to staleWarning audit detail.
> 9. `src/webapp/server.ts` — add `PayloadTooLargeError` wrapper for 413 unified envelope (D4).
> 10. `src/commands/organize.ts` — add `restore` branch in `handleOrganize` (D9); add `handleRestoreItem` with R5 closest-matches + R12 audit-lookup branching for the 404 path; reuse existing chat-command auth chain.
> 11. `src/tools/organize_create.ts` — add R13 BLOCKING goal-with-parent guard between privacy filter and cap check.
> 12. `src/memory/auditLog.ts` — extend `AuditCategory` union with `organize.restore` (D9); add `findRecentDelete` query primitive (R12).
> 13. `src/memory/migrations/012_audit_organize_restore.sql` — marker migration (D9).
> 14. Client: `public/webapp/organize/index.html` — add textareas for notes/progress with R9 iOS-friendly attributes + R1 maxlength + char-counter spans.
> 15. Client: `public/webapp/organize/hierarchy.js` (NEW) — `groupByParent`, `loadCollapseState`, `saveCollapseState`, `isCollapsed`, `toggleCollapsed`, `pruneCollapseState` (D7 / D13).
> 16. Client: `public/webapp/organize/app.js` — wire textareas to PATCH; wire char counters per R1; wire R3 progress-diff confirm; consume `hierarchy.js`; wire collapse/expand UI per D6/D7/D8; W1 magic-number consolidation.
> 17. Client: `public/webapp/organize/styles.css` — `.char-counter`, `.char-counter--warn`, `.char-counter--error`; goal-header chevron rotation; nested-task indentation.
> 18. Tests: `tests/unit/*.test.ts` — D1 stamping tests, validation extension tests, hierarchy.js tests, edit-form jsdom tests.
> 19. Tests: `tests/integration/*.test.ts` — webapp PATCH notes/progress tests, restore command tests (D9 + R5 + R12 happy/error paths), R7 race-window test, R11 explicit parentId-rejection tests.
> 20. Docs: README.md v1.14.3 subsection; `KNOWN_ISSUES.md` (7 entries per RA3); `CLAUDE.md` (3 topics per RA3); `TODO.md` (v1.14.4 hard-deadline carryforward + R10 iOS keyboard follow-up).
> 21. Version: `package.json` 1.14.2 → 1.14.3; `CHANGELOG.md` entry; commit + tag `v1.14.3`.

20 + 1 numbered steps. The "implementation order" section in ADR 011 currently lacks this enumeration; adding it closes W6.

**File/line impact.** Documentation only — the ADR addendum is the binding artifact.

---

## Pushbacks (the architect disagrees with, with justification)

**None.** All 15 R-revisions, 3 RAs, and 6 warnings are accepted with the following A/B resolutions:

  - **R13 over R14 / R15** — smallest blast radius; fixes the architect's data-shape assumption at the source; future-proofs v1.14.5+; defense in depth at the validator. R14's recursive grouping is gold-plating; R15's console.warn is invisible to users.
  - **RA1 Option A (rename-first) over Option B (cleanup-on-failure)** — atomic at the filesystem boundary; symmetric with `softDeleteItem`; recovery branch is idempotent; no orphan trash possible.
  - **R5 over R6** — engineering-best for v1.14.3 (smart 404 with closest matches); R6's defer-with-promise toast is below the bar without R5's actual matching capability.
  - **R3 + R2 (defense in depth)** — the user's brief override on this revision: BOTH the client-side diff toast (R3) AND the audit line-count metadata (R2) ship; R2 is abbreviated to a `progressLineDelta: number` count (no field values, privacy posture preserved).
  - **R9 with autocapitalize=sentences + spellcheck=true** — DA recommended `autocapitalize="off" spellcheck="false"`; user's brief overrode with the prose-friendly attributes. Notes is prose; spellcheck helps; sentence capitalization is the iOS default that users expect.

The architect did not push back on any DA finding or Anti-Slop finding because each was either (a) a real bug verified in code (R13 BLOCKING — `organize_create.ts:46` confirmed; R7 listItems window — `:529-532` confirmed); (b) a UX cliff with a real recovery path the architect didn't bind (R1 textarea maxlength; R5 typo recovery; R12 evicted-trash forensics); (c) a documentation/code-shape improvement that's strictly better than the original (RA1 rename-first symmetry; RA2 dead-field cleanup; RA3 entry enumeration); or (d) a scoped defense-in-depth addition that the architect would have made if they had thought of it (R7 listItems filter; R2/R3 line-count audit + diff toast; R11 explicit parentId-rejection tests).

---

## File-impact summary table (Phase 2 dev reference)

| File | Status | Change driver(s) |
|---|---|---|
| `src/tools/organize_create.ts` | EDIT | **R13 BLOCKING** — 5-LOC type-restriction guard for goal-with-parent at `:202-208` |
| `src/organize/storage.ts` | EDIT | D1 — `stampUpdated` helper + serializer/parser; `updated:` stamping at 5 write paths; **R7** — 2-LOC `deletedAt != null` filter at `listItems:529-532`; **D9 + RA1** — `restoreItem` storage primitive (rename-first pattern) |
| `src/organize/types.ts` | EDIT | D1 — `OrganizeFrontMatter.updated`, `OrganizeItemDetail.updated`; **D6 / F4 closure** — NEW `OrganizeListItem` interface (~12 LOC); **W2** — name binding |
| `src/organize/validation.ts` | EDIT | D2/D3 — NOTES_TOO_LONG, PROGRESS_TOO_LONG, NOTES_INVALID_CHARS, PROGRESS_INVALID_CHARS codes; ALLOWED_PATCH_FIELDS extended to six; MAX_NOTES, MAX_PROGRESS constants; **RA2** — drop dead `sawUnknown: false` at `:94 + :259` |
| `src/webapp/items.read.ts` | EDIT | D6 — extend LIST projection with `parentId` + `updated`; type as `OrganizeListItem[]` |
| `src/webapp/items.mutate.ts` | EDIT | D2/D3 — extend RA2 explicit-field-copy with notes/progress branches; D4 — body cap `'1kb'` → `'32kb'`; **R2** — `progressLineDelta` in staleWarning audit detail |
| `src/webapp/server.ts` | EDIT | D4 — `PayloadTooLargeError` wrapper for 413 unified envelope |
| `src/commands/organize.ts` | EDIT | D9 — `restore` branch in `handleOrganize` + `handleRestoreItem`; **R5** — closest-matches in 404; **R12** — audit-lookup branching in 404 |
| `src/memory/auditLog.ts` | EDIT | D9 — extend `AuditCategory` union with `organize.restore`; **R12** — `findRecentDelete` query primitive |
| `src/memory/migrations/012_audit_organize_restore.sql` | NEW | D9 — marker migration mirroring 011 |
| `src/utils/levenshtein.ts` | NEW | **R5** — pure 15-LOC Levenshtein helper for closest-matches |
| `public/webapp/organize/index.html` | EDIT | D2/D3 — `<textarea>` for notes + progress; **R1** — `maxlength` + char-counter spans; **R9** — iOS-friendly attributes (`rows`, `autocorrect=off`, `autocapitalize=sentences`, `spellcheck=true`) |
| `public/webapp/organize/hierarchy.js` | NEW | D7 + D13 — `groupByParent`, `loadCollapseState`, `saveCollapseState`, `isCollapsed`, `toggleCollapsed`, `pruneCollapseState`; **R4** — sessionStorage precedent doc-comment |
| `public/webapp/organize/app.js` | EDIT | D2/D3 — wire textareas to PATCH; **W1** — top-of-file constants block; **R1** — `attachCharCounter` helper; **R3** — `countLines` + diff confirm; D6/D7/D8 — collapse/expand UI; consume `hierarchy.js` |
| `public/webapp/organize/styles.css` | EDIT | **R1** — `.char-counter`, `.char-counter--warn`, `.char-counter--error`; D8 — chevron rotation; D6 — nested-task indentation |
| `tests/unit/organize.commands.test.ts` (or tools test) | EDIT/NEW | **R13** — 3 unit tests (goal-with-parent rejected; task/event with parent succeed) |
| `tests/unit/validation.test.ts` | EDIT | D2/D3 — 11 tests for NOTES/PROGRESS validation; **RA2** — verify `sawUnknown` no longer in success branch |
| `tests/unit/storage.test.ts` | EDIT | D1 — `stampUpdated` purity, round-trip, legacy parser tolerance, per-write-path stamping; **R7** — listItems race-window test |
| `tests/unit/webapp.organize.hierarchy.test.ts` | NEW | D13 — 16 tests for `hierarchy.js` exports |
| `tests/unit/webapp.organize.editForm.test.ts` | NEW or EDIT | **R1** — 2 jsdom tests for char counter; **R3** — 1 jsdom test for diff confirm; D8 — chevron stopPropagation tests |
| `tests/integration/webapp.organize.mutate.test.ts` | EDIT | M-NEW1 (32KB body 413), M-NEW2 (NOTES_TOO_LONG), M-NEW3 (PROGRESS_TOO_LONG); **R11** — M-NEW-P1 through M-NEW-P4 (parentId rejection); **R2** — staleWarning + `progressLineDelta`; **W5** — M-AP1 / M-AP2 / M-AP3 (audit privacy 3-way) |
| `tests/integration/organize.restore.test.ts` | NEW | D9 — 7 happy/error path tests; **RA1** — R-NEW1 (idempotent recovery); **R5** — R-NEW2 / R-NEW3 (closest matches); **R12** — R-NEW4 / R-NEW5 / R-NEW6 (audit-lookup branching) |
| `KNOWN_ISSUES.md` (project root) | EDIT | **RA3** — 7 entries enumerated above + R10 iOS keyboard entry (8 total) |
| `CLAUDE.md` (project root) | EDIT | **RA3** — 3 topics enumerated above |
| `TODO.md` | EDIT | v1.14.4 ETag hard-deadline carryforward; v1.14.5 R10 iOS keyboard follow-up; v1.14.5 `/organize trash list` (D10 deferred); v1.14.5+ parentId editing |
| `<factory-repo>\KNOWN_ISSUES.md` | FLAGGED for Lead Agent | **RA3 carryforward** — 7th occurrence of `KNOWN_ISSUES.md` enumeration gap; pipeline-level enforcement recommendation |

**Net new files:** 4 (`hierarchy.js`, `levenshtein.ts`, `migrations/012_audit_organize_restore.sql`, `tests/integration/organize.restore.test.ts`) + 1 conditional (`tests/unit/webapp.organize.editForm.test.ts` may be NEW or EDIT depending on Phase 2 file inventory) + 1 conditional (`tests/unit/webapp.organize.hierarchy.test.ts` is NEW per D13).

**Net delta vs original ADR 011 file plan:**

  - `src/tools/organize_create.ts` was UNCHANGED in original ADR 011; now has a 5-LOC R13 BLOCKING insertion at `:202-208`.
  - `src/organize/storage.ts` extends with R7's 2-LOC listItems filter beyond the original D1 + D9 work; restoreItem grows from ~50 LOC to ~60 LOC for the rename-first pattern (RA1).
  - `src/organize/validation.ts` extends with the RA2 dead-field cleanup (3 LOC delta).
  - `src/webapp/items.mutate.ts` extends with R2's `progressLineDelta` audit-detail field beyond the D2/D3/D4 work.
  - `src/commands/organize.ts` extends with R5 + R12 branching beyond the D9 happy-path work.
  - `src/memory/auditLog.ts` extends with R12's `findRecentDelete` query primitive beyond the D9 audit-category-union extension.
  - `src/utils/levenshtein.ts` is NEW (R5).
  - `tests/unit/organize.commands.test.ts` extends with R13 tests; `tests/integration/webapp.organize.mutate.test.ts` extends with R11 + R2 + W5 tests; `tests/integration/organize.restore.test.ts` extends with RA1 + R5 + R12 tests.
  - `public/webapp/organize/app.js` extends with W1 constants block + R1 char counter + R3 diff confirm beyond the D2/D3/D6/D7/D8 work.
  - `public/webapp/organize/index.html` extends with R9 iOS attributes + R1 maxlength + char-counter span beyond the D2/D3 textarea binding.
  - `KNOWN_ISSUES.md` enumerates 8 entries (RA3 + R10).
  - `CLAUDE.md` enumerates 3 topics (RA3).

---

## Final R-list (numbered, ordered by file impact for Phase 2 dev)

This list is the binding sequence Phase 2 dev implements. Order is by file impact (BLOCKING fix first; storage layer next to unblock everything else; tests last).

| # | Decision | Source | Summary | Primary file |
|---|---|---|---|---|
| **R13** (BLOCKING) | Goal-with-parent guard at create-time | DA P12 | 5-LOC type-restriction guard between privacy filter and cap check; new error code `GOAL_CANNOT_HAVE_PARENT`; 3 unit tests | `src/tools/organize_create.ts` |
| **R7** (HIGH) | `listItems` filter `deletedAt != null` | DA P5 | 2-LOC defensive filter at `:529-532` to close the v1.11.0 rewrite-then-rename window; 1 race-window integration test | `src/organize/storage.ts` |
| **R11** (HIGH) | Explicit parentId-rejection PATCH tests | DA P9 | 4 integration tests (alone, malformed, null, mixed-with-allowed); documents the v1.14.3 deliberate rejection for v1.14.5+ dev | `tests/integration/webapp.organize.mutate.test.ts` |
| **RA1** | `restoreItem` rename-first pattern | Anti-Slop RA1 | Symmetric with `softDeleteItem`; atomic file move + idempotent recovery; no orphan trash possible | `src/organize/storage.ts` |
| **RA2** | Drop `sawUnknown: false` from validation.ts | Anti-Slop RA2 (F3 carry) | 3-LOC cleanup at `:94 + :259`; closes 3rd-iteration carry-forward | `src/organize/validation.ts` |
| **RA3** | KNOWN_ISSUES.md + CLAUDE.md enumeration | Anti-Slop RA3 (W8 carry) | 7 entries + 3 topics; 7th-occurrence avoidance; factory-level recommendation flagged | `KNOWN_ISSUES.md`, `CLAUDE.md`, factory follow-up |
| R1 | Textarea maxlength + char counter + 8KB warning | DA P1 | Client-side enforcement complements server-side cap; warning style at 80% threshold | `public/webapp/organize/index.html`, `app.js`, `styles.css` |
| R2 + R3 | Progress overwrite mitigation (defense in depth) | DA P2 | R3 client-side diff confirm before save (prevents overwrite); R2 audit `progressLineDelta` count (post-fact forensics) | `public/webapp/organize/app.js`, `src/webapp/items.mutate.ts` |
| R5 | Smart 404 with closest-matches in trash | DA P4 | Levenshtein-based closest-id matches + title; closes typo-recovery gap; new `levenshtein.ts` utility | `src/commands/organize.ts`, `src/utils/levenshtein.ts` |
| R9 + R10 | iOS textarea attributes + KNOWN_ISSUES note | DA P8 | rows, maxlength, autocorrect=off, autocapitalize=sentences, spellcheck=true (user-overridden from DA's recommendation); KNOWN_ISSUES entry #8 for keyboard-obscured Save button | `public/webapp/organize/index.html`, `KNOWN_ISSUES.md` |
| R12 | Informative 404 with audit-log lookup | DA P11 | 3-way branching (evicted-by-TTL / inconsistent-state / no-record); new `findRecentDelete` query; 3 integration tests | `src/commands/organize.ts`, `src/memory/auditLog.ts` |
| R4 | sessionStorage precedent verification | DA P3 | Documentation only — Phase 2 verifies the v1.14.0 R10 reasoning still applies | `public/webapp/organize/hierarchy.js` (1-LOC comment) |
| R6 (DA P6 OK) | Hierarchy filter intersection orphan rendering | DA P6 | KEEP D5 — Option A stands; no change | (no file impact) |
| R7 (DA P7 OK) | Notes/progress XSS verification | DA P7 | KEEP — Phase 2 grep-check `innerHTML` on new client code | (Phase 2 grep enforcement) |
| R10 (DA P10 OK) | 32KB body cap multilingual edge | DA P10 | KEEP D4 — documented honestly; user split-saves workaround | (no file impact) |
| W1 | Magic-number named constants | Anti-Slop W1 | Top-of-file constants block in app.js (~12 LOC) | `public/webapp/organize/app.js` |
| W2 | `OrganizeListItem` name binding | Anti-Slop W2 | Pin name; zero references to `ListItem` (without `Organize` prefix) | `src/organize/types.ts` (per ADR 011 D6) |
| W3 | `evictExpiredTrash` non-stamping documentation | Anti-Slop W3 | ADR addendum table row; no code change | (revisions-doc) |
| W4 | Numbered test labels | Anti-Slop W4 | Test docstrings include ADR section reference | `tests/unit/*`, `tests/integration/*` |
| W5 | 3-way audit-privacy test | Anti-Slop W5 | M-AP1 (notes), M-AP2 (progress), M-AP3 (both edited together) | `tests/integration/webapp.organize.mutate.test.ts` |
| W6 | Numbered Phase-2 implementation order | Anti-Slop W6 | 21 numbered steps in ADR addendum | (revisions-doc + ADR §Phase 2 implementation order) |

**Net total:** 1 BLOCKING (R13) + 2 HIGH (R7 listItems, R11 explicit tests) + 3 RAs (RA1 rename-first, RA2 dead-field cleanup, RA3 KNOWN_ISSUES enumeration) + 6 MEDIUM accepted (R1 char counter, R2+R3 progress mitigation, R5 closest-matches, R9+R10 iOS, R12 audit-lookup) + 4 OK acknowledged (R4 sessionStorage doc, R6 D5 keep, R7-DA-P7 XSS keep, R10-DA-P10 body cap keep) + 6 warnings accepted (W1 constants, W2 name binding, W3 doc, W4 test labels, W5 audit privacy, W6 numbered steps) = 22 R-revision units.

---

## Phase-2 readiness verdict

**READY.** All BLOCKING + HIGH + RA + MEDIUM revisions resolved with binding implementation specifications. Phase 2 dev agents implement per the §Phase 2 implementation order (W6) above; deviations require another addendum.

R13 lands as the FIRST commit of Phase 2 (the type-restriction guard precedes the hierarchy renderer that depends on the data invariant). RA1 + R7 land in the same storage-layer commit set as D1's stampUpdated discipline. RA2 lands as the same commit as D2/D3's validation extension (touch the file once). RA3's enumerated entries land in the documentation commit just before the v1.14.3 tag.

Convergence with the v1.14.2 → v1.14.3 contracts is clean: zero R-revision contradictions; mtime stale-warning + R8 random-tmp-suffix + RA1 + RA2 + R14/R18/R5/R7-v1.14.2 all inherited correctly. The v1.14.4 hard-deadline ETag work (per D15 #1) closes the v1.14.3 race-window posture properly; v1.14.5+ parentId-on-PATCH work mirrors R13's create-time guard at the validator.

End of CP1 revisions for v1.14.3.
