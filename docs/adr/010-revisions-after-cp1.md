# ADR 010 — Revisions after CP1 debate (2026-04-25)

**Parent:** `010-v1.14.2-mutations.md`
**Status:** Accepted. Folded into ADR 010 by reference. Phase 2 dev agents implement the revised spec; deviations require another addendum.
**Context.** Devil's Advocate review (`docs/reviews/cp1-devils-advocate-v1.14.2.md`) raised 1 BLOCKING + 2 HIGH + 5 MEDIUM + 2 LOW with 18 numbered R-revisions, several presented as A/B alternatives. Anti-Slop Phase 1 review (`docs/reviews/anti-slop-phase1-review-v1.14.2.md`) raised 2 FAIL-adjacent (RA1, RA2) + 8 warnings (W1–W8). Convergence signal: both reviewers independently flagged the validator/route envelope shape mismatch (Anti-Slop RA1; DA implicit in P8) and the audit `changedFields` privacy posture (Anti-Slop §6 PASS-with-context vs DA P5). The architect resolves the A/B picks below, accepts the FAIL-adjacent items in full, and binds the BLOCKING fix to a specific 2-LOC edit at `src/organize/storage.ts:339-343`.

The BLOCKING (R8 — `writeAtomically` shared `${filePath}.tmp` race) MUST land in v1.14.2. Non-negotiable. Verified at `src/organize/storage.ts:339-343` (lines confirmed against working tree); the fix is a 2-line change inside `writeAtomically` and ships as the FIRST commit of Phase 2 (precondition for the new mutation surfaces).

This revisions document supersedes the relevant clauses of ADR 010 by reference; the parent ADR is not edited.

---

## Resolved (R-numbered, ordered by file impact for Phase 2)

### R8 (BLOCKING — supersedes ADR 010 decision 6's "atomicity" claim and adds SF-7) — `writeAtomically` per-call random tmp suffix

**Concern (DA P4).** ADR 010 decision 6 reuses the storage layer's "atomic temp-then-rename" framing by reference. Verified at `src/organize/storage.ts:339-343`:

```typescript
async function writeAtomically(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp`;            // line 340 — SHARED tmp filename
  await writeFile(tmp, content, 'utf8');    // line 341
  await rename(tmp, filePath);              // line 342
}
```

The atomicity claim holds at the rename boundary; the WRITE boundary is racy because the tmp filename is shared across concurrent callers. v1.14.2 introduces the second concurrent-writer surface (HTTP/Express PATCH/POST/DELETE alongside the existing chat-handler path AND the chat-agent's `organize_update` tool path). Three writer surfaces × shared tmp filename = real race window. Worst-case is a HYBRID-content tmp file from interleaved writes that lands as a corrupted live file (`parseItemFile` rejects on next read → `ITEM_MALFORMED` → 500 → user can no longer view the item).

**This is BLOCKING for v1.14.2 specifically.** v1.13.x served single-grammY-message serialization which made the race window effectively zero in practice; v1.14.2's HTTP path makes it real. Latent bug in v1.13.x (chat-agent + cron `organize_update` could theoretically race) that never manifested at the prior single-writer scale.

**Decision — pick R8 over R9.**

**R8 — 2-LOC fix in `writeAtomically`.** Update `src/organize/storage.ts:339-343` to use a per-call random tmp filename:

```typescript
import { randomBytes } from 'node:crypto';   // ADD if not already imported

async function writeAtomically(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;   // line 340 changes
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, filePath);
}
```

**Justification over R9 (per-file mutex).**

1. **Same atomicity guarantee** — `rename` is atomic at the filesystem level; the random suffix only de-collides the tmp PATH, not the rename semantics. Two concurrent callers each get their own `${filePath}.<hex>.tmp`, each `rename` call is atomic, and the last-rename-wins outcome at the live file is identical to single-writer behavior. No data corruption (no interleaved tmp file), no ENOENT-on-second-rename (each writer renames its OWN tmp).
2. **Zero contention** — no lock map, no Map<userId, Promise<void>> queue, no serialization. Concurrent writes proceed in parallel; the OS handles atomicity at the rename boundary.
3. **Migration impact: zero.** Same on-disk footprint after success (the tmp file is deleted by `rename`). The `.gitignore` for `.tmp` files (if any — not currently configured in `data/organize/`'s scope) continues to apply because the suffix appears BEFORE `.tmp`. The cleanup story for orphaned tmp files (e.g., process crash mid-write) is identical to today: stale `.tmp` files in the user data dir are harmless garbage that doesn't affect parsing (filenames matching the `<id>.md` pattern are the only ones loaded by `listItems`).
4. **Affects all four mutation paths** — `createItem` (storage.ts:407), `updateItem` (:635), `softDeleteItem` (:680), `appendProgressEntry` (:751) all use `writeAtomically`. ALL four become safe under concurrent calls. The fix is upstream of every mutation surface.
5. **R9's complexity is gold-plating for v1.14.2's concurrency profile.** R9 (per-userId mutex) addresses ORDERING semantics in addition to write correctness. Ordering matters for "two webapp PATCHes from the same user, last-tap-wins" — but absolute-write semantics (R18 below) makes that LOGICALLY last-write-wins regardless of ordering. The mutex would change the audit-row order but not the on-disk outcome. Not worth the 30 LOC + lock-map complexity in v1.14.2.

**Why R9 is not the right call.** R9's per-userId mutex would add a Map<userId, Promise<void>> with serialization queue logic, complicating the storage layer with concurrency primitives that are otherwise alien to it. The storage layer should remain a pure I/O surface; concurrency control belongs at the application layer if it's needed (and the application has chosen NOT to need it for v1.14.2 per the iteration brief's "No concurrency control" non-negotiable). R8 fixes the data-corruption bug without introducing concurrency primitives.

**Latent v1.13.x bug acknowledgement.** The bug existed in v1.13.x; it never manifested because grammY serialized chat-handler messages and the chat-agent's `organize_update` tool calls were per-message-bound. v1.14.2 lights up the bug by adding the HTTP path; R8 retroactively fixes the latent v1.13.x bug at no cost. Document in the v1.14.2 CHANGELOG entry: "Fixed: `writeAtomically` now uses per-call random tmp suffix (latent race condition exposed by webapp HTTP path; affects all callers including chat-side). No data migration required."

**Add SF-7 to ADR 010.** Per DA's R10:

> **SF-7.** `writeAtomically` shares `${filePath}.tmp` across concurrent callers (`src/organize/storage.ts:339-343`). At pre-v1.14.2 single-writer-via-grammY scale this never manifested; v1.14.2 introduces the second concurrent writer surface (HTTP/Express) and lights up the race. R8 (per-call random tmp suffix, 2 LOC) is mandatory and lands as the FIRST commit of v1.14.2's Phase 2. The fix is upstream of all four mutation paths (`createItem`, `updateItem`, `softDeleteItem`, `appendProgressEntry`). No data migration. The `Atomic writes via temp-then-rename` JSDoc at storage.ts:8 stays correct AT THE RENAME BOUNDARY; SF-7 documents that the WRITE BOUNDARY needed the random-suffix fix to be safe under concurrent callers.

**Tests required (Phase 2).** Add to `tests/integration/storage.concurrency.test.ts` (new file, ~3 cases):

1. Two concurrent `updateItem` calls on the same item with different `title` patches → both succeed (no ENOENT, no `FILE_WRITE_FAILED`); the on-disk file matches one of the two patches verbatim (last-rename-wins is acceptable; no hybrid content).
2. One `updateItem` + one `softDeleteItem` concurrent on the same item → both succeed; the item ends in `.trash/` (delete is the destructive op; either order is acceptable as long as no hybrid content lands).
3. Stress: 50 concurrent `updateItem` calls on the same item → no `FILE_WRITE_FAILED` errors; final on-disk content is a coherent parse of one of the 50 patches.

**File/line impact.**

- `src/organize/storage.ts:339-343` — 2-LOC change inside `writeAtomically` (line 340 only changes; lines 341, 342 unchanged) + 1 import line for `randomBytes` if `node:crypto` is not already imported (verify Phase 2).
- `tests/integration/storage.concurrency.test.ts` — NEW file, ~3 test cases.

---

### R10 (BLOCKING carryover — same fix as R8) — Add SF-7 to ADR 010 surprise findings

Documentation-only. Specified above as part of R8. No additional code change.

---

### RA1 / R15 (FAIL-adjacent — supersedes ADR 010 decision 2 validator return shape) — Validator emits machine-readable codes

**Concern (Anti-Slop RA1 + DA P8 / R15).** ADR 010 decision 2 specified the validator returns `{ok: true, patch} | {ok: false, error: string}` (2-field shape). The route handlers return ADR 009 R3's `{ok: false, code: 'BAD_REQUEST', error: <human-readable>}` (3-field wire envelope). Two readings produce different shapes. Additionally, DA P8 / R15 calls for distinguishing "completely empty body" (no keys at all) from "had fields but all unrecognized" — both 400 today, indistinguishable error string.

**Decision.** The validator returns the FULL three-field shape directly; the route handler maps to the wire envelope without translation. Resolves both Anti-Slop RA1 (machine-readable codes) and DA R15 (distinguishable error messages) in one stroke.

**Validator return shape (binding):**

```typescript
type ValidatePatchResult =
  | { ok: true; patch: AllowedPatch }
  | { ok: false; code: ValidatorErrorCode; error: string };

type ValidatorErrorCode =
  | 'PATCH_NO_VALID_FIELDS'   // body had keys but none were in the allowed list
  | 'PATCH_UNKNOWN_FIELDS'    // body had unknown fields alongside known ones (R-RA2 binding)
  | 'TITLE_REQUIRED'          // title present and empty/whitespace-only
  | 'TITLE_TOO_LONG'          // title > MAX_TITLE (500)
  | 'TITLE_NOT_STRING'        // title present and not a string
  | 'DUE_INVALID_FORMAT'      // due present, not null, fails ISO_DATE_RE
  | 'STATUS_INVALID'          // status present, not in {'active','done','abandoned'}
  | 'TAGS_NOT_ARRAY'          // tags present, not an array
  | 'TAG_TOO_LONG'            // any tag > MAX_TAG (40)
  | 'TAG_INVALID_CHARS'       // any tag contains whitespace, comma, or YAML-reserved chars
  | 'TAGS_TOO_MANY';          // tags array length > MAX_TAGS (10)
```

**Empty-body distinction (DA R15 — accepted in full).**

- Body is `{}` OR all keys are in the unknown-fields set → `code: 'PATCH_NO_VALID_FIELDS'`, `error: 'No recognized fields in patch body. Allowed fields: title, due, status, tags.'`
- Body has at least one allowed field PLUS at least one unknown field → `code: 'PATCH_UNKNOWN_FIELDS'`, `error: 'Unknown fields in patch body: <comma-separated list>. Allowed fields: title, due, status, tags.'`

The architect's silent-stripping defense (decision 2 prose) is preserved for the case where the body has BOTH allowed AND unknown fields AND silently dropping the unknown fields would still produce a valid patch — but Anti-Slop RA2's "route MUST omit disallowed fields" supersedes silent acceptance: when unknown fields are present, the route REJECTS with `PATCH_UNKNOWN_FIELDS` (loud, not silent). This trades a tiny defense-in-depth loss (telling the attacker which fields are NOT in the allowed list — which they can trivially probe via the API docs anyway, since the four allowed field names are public) for a real improvement in client debuggability and audit-log signal.

**Wire envelope.** The route handler maps the validator result directly:

```typescript
// inside items.mutate.ts PATCH handler
const result = validatePatchBody(req.body);
if (!result.ok) {
  return res.status(400).json({ ok: false, code: result.code, error: result.error });
}
// result.patch is the AllowedPatch — see RA2 below for storage-call construction
```

**Test plan changes.**

- ADR 010 §Test plan tests 5 + 6 split into:
  - **Test 5a:** PATCH with `body: {}` → 400 + `{ok: false, code: 'PATCH_NO_VALID_FIELDS', error: '...'}`
  - **Test 5b:** PATCH with `body: {notes: 'foo'}` (only unknown field) → 400 + `{ok: false, code: 'PATCH_NO_VALID_FIELDS', error: '...'}`
  - **Test 5c:** PATCH with `body: {title: 'ok', notes: 'bad'}` (mix) → 400 + `{ok: false, code: 'PATCH_UNKNOWN_FIELDS', error: 'Unknown fields in patch body: notes. ...'}`
- All other 25 unit tests for validation expand to assert the exact `code` per failure mode (e.g., title=501 chars → `code: 'TITLE_TOO_LONG'`; status='unknown' → `code: 'STATUS_INVALID'`).

**Phase 2 grep-check.** Anti-Slop Phase-2 reviewer greps `code:` in `src/webapp/items.mutate.ts` for the route handlers and asserts: every 400 response includes a `code` matching one of the validator codes; no `code: 'BAD_REQUEST'` synthesized at the boundary (the validator owns the vocabulary).

**File/line impact.**

- `src/organize/validation.ts` (NEW) — the validator's return type expands to the 3-field shape with the 11 codes above. ~120 LOC instead of ~80 LOC for the bare 2-field shape.
- `src/webapp/items.mutate.ts` (NEW) — route handler maps `result.code` directly into the wire envelope. Saves ~5 LOC of synthesis boilerplate vs the bridging approach.
- `tests/unit/validation.test.ts` — 25 unit tests update to assert specific `code` values; 1 test (test 5/6) splits into 5a/5b/5c.

---

### RA2 — Route MUST construct storage patch from allowed fields explicitly; never spread

**Concern (Anti-Slop RA2 + ADR 010 §1 + §11).** `storage.ts:632` has the invariant `if (patch.notes !== undefined) ...` — the storage layer relies on `notes` being OMITTED from the patch object to preserve existing notes. Spreading `{...input, notes: undefined}` would set `notes: undefined` on the patch object, and a future refactor changing the conditional from `!== undefined` to truthiness check would silently truncate notes.

**Decision.** The route handler MUST construct the storage patch by EXPLICITLY copying ONLY the four allowed fields, ONLY when the validated patch has them defined. Bind the implementation pattern in ADR 010's decision 2 commentary:

```typescript
// inside items.mutate.ts PATCH handler, after validatePatchBody returns ok:true
const validated = result.patch;            // {title?, due?, status?, tags?}
const storagePatch: UpdateItemPatch = {};
if (validated.title !== undefined) storagePatch.title = validated.title;
if (validated.due !== undefined) storagePatch.due = validated.due;
if (validated.status !== undefined) storagePatch.status = validated.status;
if (validated.tags !== undefined) storagePatch.tags = validated.tags;
const updated = await updateItem(userId, dataDir, itemId, storagePatch);
```

**FORBIDDEN patterns (Anti-Slop Phase-2 grep-check):**

- `updateItem(..., {...validated, notes: undefined})` — spread + null
- `updateItem(..., validated as UpdateItemPatch)` — type-cast
- `updateItem(..., {...req.body, ...})` — passthrough from request body
- Any storage-call construction that does NOT use the explicit-field-copy pattern above

**Integration test (binding):** Add to `tests/integration/webapp.organize.test.ts`:

> **Test M-29:** Create an item with `notes: 'Multi-line\nnotes body\nwith preserved newlines'` and `progress: '- [2026-04-24T...] step 1'`. PATCH `{title: 'New title'}`. Assert (a) response item's `notes` field byte-identical to the original; (b) response item's `progress` field byte-identical to the original; (c) on-disk file's notes section byte-identical to the original (re-read via `readItem`).

> **Test M-30:** PATCH with body `{notes: 'attacker payload'}`. Assert (a) 400 response with `code: 'PATCH_NO_VALID_FIELDS'`; (b) on-disk item's `notes` UNCHANGED (re-read via `readItem`; assert byte-identical to pre-PATCH state); (c) audit_log has NO row for this PATCH (validator-fail short-circuits before audit emit, per ADR 010 decision 9 line 656).

**File/line impact.**

- `src/webapp/items.mutate.ts` — explicit-field-copy pattern in the PATCH handler; ~6 LOC of `if (...) storagePatch.X = validated.X;` instead of a 1-LOC spread.
- `tests/integration/webapp.organize.test.ts` — add tests M-29 and M-30 (notes preservation + attacker-notes-payload defense).

---

### R18 (HIGH — supersedes ADR 010 decision 3 prose) — POST /complete absolute-write semantics

**Concern (DA P10).** Decision 3's prose said "server flips status." Two concurrent POST /complete requests with different `done` values would both read 'active', both flip to 'done', producing wrong end-state. The architect's flip table at decision 3 IS consistent with absolute write — but the prose says "flip," which a Phase 2 dev could read as "read current; toggle."

**Decision.** Bind absolute-write semantics in ADR 010 decision 3:

> **Server implementation: ABSOLUTE WRITE.** The POST /complete handler maps `{done: true}` to `updateItem({status: 'done'})` and `{done: false}` to `updateItem({status: 'active'})`. The server does NOT read-then-flip; it writes the target state directly. This is correct under concurrent double-tap: each request's `done` field is an absolute target; the last write wins; the user's last tap matches the on-disk outcome.

> **Toggle-no-body path (POST /complete with empty body):** for completeness, the handler accepts a body-less POST /complete and toggles the current status (read → flip → write). This path has the read-flip-write race documented in DA P10 and is RECOMMENDED AGAINST for clients. **The webapp client always sends `{done: !currentLocalDone}`** — the client computes the absolute target locally and sends it explicitly. Document the toggle-no-body path as race-prone in Decision 3's prose; mark it as a courtesy for non-webapp clients (e.g., curl from CLI) where the user's intent is "flip whatever it is now."

> **Abandoned-state exception (per R14 below):** if current status is 'abandoned' and `done: false`, no-op (return 200 with the unchanged item). The flip table's abandoned + done:true → done case proceeds normally as an absolute write. The flip table's abandoned + done:false → no-op case is the ONLY case where the server reads-and-skips; this is acceptable because it's a single read followed by a conditional skip, not a read-flip-write.

**Client implementation note (binding for `public/webapp/organize/app.js`):**

```javascript
async function toggleComplete(itemId, currentLocalDone) {
  const targetDone = !currentLocalDone;
  // Optimistic flip on the client per ADR 010 decision 14.
  // ALWAYS send the explicit done field — never POST with no body.
  const res = await fetch(`/api/webapp/items/${itemId}/complete`, {
    method: 'POST',
    headers: {/* ... */},
    body: JSON.stringify({ done: targetDone }),
  });
  // ...rollback on error per Decision 14 + R-toast-split below
}
```

**File/line impact.**

- `src/webapp/items.mutate.ts` — POST /complete handler implements absolute write (~5 LOC simpler than read-flip-write).
- `public/webapp/organize/app.js` — client always sends `{done: !currentLocalDone}` (~2 LOC of the existing fetch call).
- `tests/integration/webapp.organize.test.ts` — add concurrent double-tap test: fire two POST /complete with `{done: true}` then `{done: false}` 50ms apart; assert final on-disk status is 'active' (the last `done: false` wins under absolute write).

---

### R14 (MEDIUM — supersedes ADR 010 decision 14 implicit rule) — Per-status checkbox visibility

**Concern (DA P7).** ADR 010 decision 3's flip table + decision 14's edit-form rules don't explicitly bind the per-status UI behavior. Phase 2 dev could ship checkbox-visible-for-abandoned, then Anti-Slop Phase 2 would push back at code review.

**Decision (accept R14 as-is).** Bind the per-status checkbox visibility rule in ADR 010 decision 14:

> **List card UI per status:**
> - **ACTIVE** items: complete checkbox visible (toggle to done).
> - **DONE** items: complete checkbox visible (toggle back to active — uncomplete).
> - **ABANDONED** items: complete checkbox HIDDEN. Per decision 3's flip-table semantics, the only paths to un-abandon are (a) the detail view's edit form > status dropdown > 'active' > Save, OR (b) chat-side `/organize update <id> --status active`.
>
> **Detail view edit form:** the status dropdown is ALWAYS visible (including for abandoned items), with options `active`, `done`, `abandoned`. The status dropdown is the only webapp path to un-abandon.
>
> **Server-side enforcement (per R18):** POST /complete with body `{done: true}` on `abandoned` item → set status to 'done' (un-abandons + completes — covered by absolute write). POST /complete with body `{done: false}` on `abandoned` item → no-op return 200 (un-abandoning to 'active' requires explicit status PATCH, not a checkbox click). POST /complete with NO body on `abandoned` item → 400 + `{ok: false, code: 'AMBIGUOUS_TOGGLE', error: 'Toggle requires explicit done field for non-binary status. Send {done: true} or {done: false}.'}` (matches DA's "toggle requires explicit intent for non-binary states").

**Test plan additions:**

- **Test M-31:** POST /complete `{done: true}` on abandoned item → 200 + status='done'.
- **Test M-32:** POST /complete `{done: false}` on abandoned item → 200 + status UNCHANGED (still 'abandoned').
- **Test M-33:** POST /complete no-body on abandoned item → 400 + `{ok: false, code: 'AMBIGUOUS_TOGGLE', error: '...'}`.
- **Test M-34:** Client list rendering — abandoned item shows NO checkbox in the DOM.

**File/line impact.**

- `src/webapp/items.mutate.ts` — POST /complete handler adds the abandoned-no-body 400 branch.
- `public/webapp/organize/app.js` — list-render path conditionally omits the checkbox for `status === 'abandoned'`.
- `public/webapp/organize/styles.css` — no change (the checkbox is omitted from the DOM, not hidden via CSS).
- `tests/integration/webapp.organize.test.ts` — tests M-31, M-32, M-33.
- `tests/unit/clientRender.test.ts` (if it exists; otherwise jsdom test in the appropriate file) — test M-34.

---

### R5 (MEDIUM — supersedes ADR 010 decision 7 timer) — Delete confirm 6s + visible countdown ring

**Concern (DA P2).** 4s catches the median-confirm user but truncates the long-tail (left-thumb-reach, distracted, tap-rhythm-rebound). Two A/B options were on the table: R4 (hold-to-delete, ~30 LOC) or R5 (6s with countdown, ~3 LOC).

**Decision — pick R5 (6s) over R4 (hold-to-delete).**

**Justification.**

1. **Pattern match with Telegram WebApp affordances.** Telegram WebApp users are accustomed to two-tap confirmation (the SDK's own `MainButton.showProgress` + `MainButton.hideProgress` + tap-then-confirm patterns are pervasive in third-party Telegram WebApps). Hold-to-delete is unfamiliar in this surface — it's a Discord/iOS pattern, not a Telegram one. Adopting it would be a UX-vocabulary outlier.
2. **Pointer event handling on Telegram in-app browsers is variable.** `pointerdown` + `setTimeout` + `pointerup/pointercancel` works on most modern WebView surfaces, but the Telegram-on-Android in-app browser has documented variance (some versions re-fire `pointerdown` on micro-jitter; some swallow `pointercancel` on scroll-overlap). Two-tap is mechanically simpler — `click` events are universally well-behaved.
3. **6s catches >95% of intentional confirms per the DA's research-backed numbers** (Fitts's Law + decision-latency = 800-1100ms typical; 95th percentile undo-action time is 4-5s; 6s gives 50% headroom over Gmail's 5s default for the higher-stakes destructive action).
4. **Cost asymmetry.** R5 is ~3 LOC (change `4000` to `6000` in the timer + update the countdown text). R4 is ~30 LOC of pointer-event state machine + visual-fill-bar + new test cases for `pointerdown`/`pointerup` simulation. R5's 50% timer headroom captures most of R4's UX-correctness benefit at 10% of the implementation cost.
5. **Visible countdown + Cancel button covers the abort case.** Decision 7 already specifies a countdown text ("Confirm delete (4s)" → updated to "Confirm delete (6s)"). Add an explicit **Cancel button** alongside the Confirm button — the user who realizes mid-countdown can ABORT without waiting. Cancel returns the UI to the pre-Delete-tap state. ~2 LOC of UI + 1 line of test.
6. **Visible countdown ring** (small CSS animation around the Confirm button — a 6-second SVG circle stroke-dashoffset transition) communicates remaining time visually for users who don't read the parenthetical. ~10 LOC of CSS + SVG.

**Decision 7 update (binding).** Replace the 4-second timer with 6 seconds. Add a Cancel button (separate from Confirm). Add a visible countdown ring (SVG stroke around the Confirm button) that animates from full to empty over 6 seconds. The state machine is otherwise unchanged from ADR 010 decision 7.

**File/line impact.**

- `public/webapp/organize/app.js` — `setTimeout(..., 6000)` (was 4000); add Cancel button click handler.
- `public/webapp/organize/index.html` — add Cancel button alongside Confirm button.
- `public/webapp/organize/styles.css` — add countdown-ring CSS (SVG circle with `stroke-dashoffset` transition over 6s).
- `tests/integration/webapp.organize.test.ts` — Test 33 update (6s timer) + add Test M-35 (Cancel button click during countdown returns to pre-Delete state, no DELETE fired).

---

### R7 (MEDIUM — supersedes ADR 010 decision 8 visual circle) — 32×32 visual inside 44×44 hit area

**Concern (DA P3).** 24×24 visual inside 44×44 hit area creates a 10px perceptual gap on each side. User taps near the visible circle, lands inside the padding, gets checkbox behavior when they intended card navigation.

**Decision — pick R7 (32×32 visual) over R6 (visual divider).**

**Justification.**

1. **Closes the perceptual gap from 10px to 6px on each side.** R7 makes the visual circle larger; R6 keeps the visual circle small but adds a divider line. R7 is a more direct fix — the user's mental model of the tap target matches the actual hit area more closely.
2. **List density penalty is acceptable.** Each list card grows ~4px taller (32 - 24 = 8px diameter, but the card's vertical padding is the constraint, not the circle's diameter; the actual height impact is ~4-6px per card). On a typical 6-inch phone showing ~8 items above the fold, this is ~5% fewer items visible. Acceptable trade-off for correctness-of-mental-model.
3. **Visual divider (R6) is necessary BUT NOT SUFFICIENT.** A 1px border between the checkbox padding and the card content communicates "separate zone," but doesn't change the fact that the user perceives the 24px target. R7 + R6 together would be ideal; R7 alone is the bigger win. Phase 2 dev MAY add the R6 visual divider as a polish-tier addition (Phase 2's call), but R7 is the binding decision.
4. **Still meets architect's design intent.** Decision 8's rationale was "list density matters" + "44×44 HIG compliance." R7 keeps both: the hit area stays 44×44 (HIG compliant), and the list density penalty is small (~5%, not the ~30% it would be at full 44×44 visual circles).

**CSS spec (binding):**

```css
.list-item-checkbox {
  width: 32px;                  /* was 24px */
  height: 32px;                 /* was 24px */
  /* Hit area extension via padding stays unchanged: */
  padding: 6px;                 /* (44 - 32) / 2 = 6px on each side; was 10px when visual was 24px */
  /* Visible circle styling: */
  border-radius: 50%;
  border: 2px solid var(--button-color, #2481cc);   /* slightly thicker to match larger circle */
  background: transparent;
  cursor: pointer;
}

.list-item-checkbox.checked {
  background: var(--button-color, #2481cc);
  /* Checkmark icon scales up slightly with the larger circle */
}

.list-item-checkbox-container {
  /* hit area = 32 + 2*6 = 44 px total */
  /* Optional R6 polish: border-right separator */
  margin-right: 8px;
}
```

**File/line impact.**

- `public/webapp/organize/styles.css` — checkbox width/height 24px → 32px; padding 10px → 6px; border 2px (already 2px or new). ~3 LOC.
- `tests/integration/webapp.organize.test.ts` — no change (the integration tests don't measure pixels); jsdom tests are not pixel-aware.
- `public/webapp/organize/app.js` — no change (the checkbox class names and event handlers are unaffected by visual size).

---

### R12 (MEDIUM — supersedes DA's R11 alternative) — Keep `changedFields: string[]` with explicit privacy posture

**Concern (DA P5).** ADR 010 decision 4's `changedFields: string[]` is privacy-leak-adjacent for forensics if combined with on-disk content + git/.trash side-channels. R11 would replace with `changedFieldCount: number` (privacy minimum); R12 keeps the array and documents the posture.

**Decision — pick R12 over R11.**

**Justification.**

1. **Forensics value of WHICH fields changed (not just HOW MANY) is high.** A forensic reader investigating "did user X change their item's title in response to event Y?" gets a much sharper answer from `changedFields: ['title']` than from `changedFieldCount: 1`. The latter forces the reader to ALSO inspect on-disk diffs to figure out which field changed; the former records the answer at audit time.
2. **The privacy risk is low because the trust boundary is already wider than the audit log.** A forensic reader who can read the audit log AND the markdown file is already INSIDE the trust boundary — they have access to BOTH the metadata AND the content. The audit log doesn't ADD to that exposure; it just records which actions hit the data. Removing `changedFields` from the audit log doesn't reduce the exposure (the forensic reader can still diff the on-disk file against git history); it just makes forensics more painful for legitimate operators.
3. **The git/.trash side-channels DA mentions are real but operator-controllable.** DA P5 itself names the mitigations: operators of compliance-sensitive deployments should disable git tracking of `data/organize/` and configure trash TTL ≤7 days. These are deployment-time decisions, not data-shape decisions. Keeping `changedFields` does NOT prevent operators from making the right deployment decisions; replacing it with `changedFieldCount` does NOT prevent operators from making the wrong ones.
4. **`changedFields` is a closed set of 4 strings (`'title' | 'due' | 'status' | 'tags'`).** It's not user-content; it's metadata about which schema-defined slot was touched. The privacy-leak vector DA describes is content reconstruction (figuring out the OLD title from the audit + disk + git) — this requires the on-disk content + git history, NOT just the audit log. The audit log alone leaks zero content.

**Decision 4 update (binding).** Keep `changedFields: string[]` as the array of allowed field names that were modified. Add to ADR 010 §Risks (replacing or augmenting row 1):

> **Privacy posture for `webapp.item_mutate` audit detail JSON.** The detail blob `{action, itemId, changedFields, ip?}` records WHICH fields were modified by name (closed set: `'title' | 'due' | 'status' | 'tags'`) — NOT the values. Field-name-only is by design: forensic operators investigating user actions can identify what was touched without seeing private content. Combined with on-disk content + git/.trash side-channels (if the operator git-tracks `data/organize/` or extends trash TTL beyond default), a privileged operator could correlate audit rows to content diffs. **This is acceptable single-user-deployment posture.** **Multi-user deployments with compliance requirements (FERPA, HIPAA, attorney-client privilege) MUST: (a) disable git tracking of `data/organize/`; (b) configure trash TTL ≤7 days; (c) restrict audit_log read access to a separate operator role from on-disk filesystem read access (the audit log alone leaks zero content, but the operator with BOTH read accesses has reconstruction capability).** Document in `docs/PRIVACY.md` (added in v1.14.2 README sweep).

**File/line impact.**

- `docs/adr/010-v1.14.2-mutations.md` §Risks — update row 1 wording per the binding text above (this is a documentation revision; the ADR file itself is not edited per the revisions-doc convention, but Phase 2 README sweep MUST include the privacy posture text in `docs/PRIVACY.md`).
- `docs/PRIVACY.md` (NEW or updated) — operator-hardening guidance for compliance-sensitive deployments.
- No code change. The existing `WebappItemMutateDetail` shape is correct.

---

### R2-mtime / R1 / R3 (HIGH — supersedes ADR 010 decision 6 ETag deferral) — mtime stale-warning mitigation in v1.14.2; ETag in v1.14.3

**Concern (DA P1).** ADR 010 decision 6 deferred ETag entirely. DA pushed back: webapp + chat-agent (`organize_update` tool) is a real race in v1.14.2 because the agent can fire ANY time including from webhooks/cron. Three options on the table: R1 (do nothing in v1.14.2; ETag in v1.14.3 hard deadline), R2 (mtime header → 412 + reload), R3 (console warning + audit row tag).

**Decision — pick R2 (mtime header + non-blocking staleWarning) over R1 (defer entirely) and R3 (console warning only).**

**Justification.**

1. **R2 is one line on the client + ~5 lines on the server.** The cost is genuinely tiny.
2. **R2 surfaces the stale-edit problem without blocking.** The mutation succeeds; the user sees a non-blocking toast: "This item was changed elsewhere; your save was applied. [Save anyway / Reload]." This communicates the race WITHOUT the 412 + reload UX cliff that proper ETag will add in v1.14.3.
3. **R3 (console warning only) is invisible to users.** A console warning helps a developer debugging; it doesn't help a user who just lost data. Below the bar.
4. **R1 (defer entirely) leaves the race undetectable.** Three concurrent writer surfaces × no detection = silent data loss. Below the bar.

**Decision 6 amendment (binding).**

- **v1.14.2:** Add mtime stale-warning mitigation per the spec below. NOT a hard 412 reject. The mutation proceeds; the response includes `staleWarning: true` + the user sees a non-blocking toast.
- **v1.14.3:** Hard deadline. Proper If-Match + 412 + ETag. **No "or later" — bound to v1.14.3 only.** Filed as a TODO with explicit version target.

**Implementation spec for v1.14.2.**

**Server side (`src/webapp/items.mutate.ts`).** On GET /:id, the response includes the file's mtime in the response body. On PATCH/POST /:id/complete/DELETE, the client SHOULD send `X-Captured-Mtime: <ms>` header. Server reads the current mtime via `fs.stat`; compares to the header. If header is missing → no warning (back-compat). If header is present and mismatches → log a NEW audit category `webapp.stale_edit` (one-line migration entry in `011_audit_webapp_item_mutate.sql` — extend the migration's union types to include `webapp.stale_edit` alongside `webapp.item_mutate`) AND continue with the mutation AND include `staleWarning: true` in the success response body.

```typescript
// inside items.mutate.ts (PATCH handler shown; same pattern for POST /complete and DELETE)
const itemPath = path.join(organizeUserDir(userId, dataDir), `${itemId}.md`);
const stat = await fs.stat(itemPath).catch(() => null);
const currentMtimeMs = stat?.mtimeMs;
const capturedMtimeMs = req.header('X-Captured-Mtime');
let staleWarning = false;
if (capturedMtimeMs && currentMtimeMs && Number(capturedMtimeMs) !== currentMtimeMs) {
  staleWarning = true;
  // NEW audit category — log without blocking
  await memory.auditLog.insertReturningId({
    category: 'webapp.stale_edit',
    actor_user_id: userId,
    detail_json: { itemId, capturedMtimeMs, currentMtimeMs, action: 'patch' },
  }).catch(err => serverLog.warn({ err }, 'Failed to insert webapp.stale_edit audit row'));
}
// ... proceed with the mutation as normal ...
return res.status(200).json({ ok: true, item: updated, staleWarning });
```

**Client side (`public/webapp/organize/app.js`).** On detail load, capture the response's `item.mtimeMs` (server adds this to the GET /:id response shape — see file impact below). On Save / Complete / Delete, send `X-Captured-Mtime: <ms>` header. On 200 response with `staleWarning: true`, show a non-blocking toast:

```javascript
if (data.staleWarning) {
  showToast({
    text: 'This item was changed elsewhere. Your save was applied.',
    actions: [
      { label: 'Reload', onClick: () => reloadDetail(itemId) },
      { label: 'Dismiss', onClick: () => {} },
    ],
    duration: 8000,  // longer than default toast since it has actions
  });
}
```

**Note:** there is NO "Save anyway" button in v1.14.2 because the save HAS ALREADY BEEN APPLIED (the server didn't 412). The user's choice is between dismissing and reloading to see the merged state. v1.14.3's proper ETag will introduce a "Save anyway" path when 412 becomes a real outcome.

**Migration impact.** Add `webapp.stale_edit` to the audit category union in `011_audit_webapp_item_mutate.sql` — single-line addition next to `webapp.item_mutate`. Anti-Slop Phase-2 grep-checks both categories are referenced.

**Response shape change.** GET /:id response gains `mtimeMs: number` field on the item shape. PATCH/POST /complete success responses gain `staleWarning?: boolean` field (optional; absent or false means no stale warning). These are ADDITIVE — back-compat with any existing client that ignores extra fields.

**v1.14.3 hard-deadline binding.** Update ADR 010 decision 17 #1 from "v1.14.3 or later" to "v1.14.3" — bound to that specific iteration. Add to `TODO.md`:

> **v1.14.3 — Proper ETag + If-Match + 412 (HARD DEADLINE).** Storage layer adds `updated` ISO field (ADR addition); GET /:id returns ETag header; PATCH/POST /:id/complete/DELETE require If-Match (or `?force=1` opt-out for CLI clients); 412 returns the current item shape so the client can render a 3-way diff or "Save anyway / Reload" UX. Estimate: ~80 LOC storage + ~60 LOC client + ~100 LOC tests = half-iteration. Ships within 30 days of v1.14.2 GA OR the iteration brief escalates to BLOCKING.

**§Risks update (DA R1).** Replace the "two-device-same-user" risk row wording with: "Any two of {webapp PATCH, chat-side `/organize update` command, chat-agent `organize_update` tool call} concurrently editing the same item. Severity: HIGH (the chat-agent can fire autonomously from webhooks, cron, MCP tools, or scheduled reconcile passes — the user has no awareness their item is being edited). v1.14.2 mitigation: mtime stale-warning toast (non-blocking; data is not corrupted thanks to R8's tmp-suffix fix; the user is INFORMED of cross-surface edits). v1.14.3: proper If-Match + 412 + ETag eliminates silent overwrites."

**File/line impact.**

- `src/webapp/items.read.ts` — GET /:id response shape adds `mtimeMs: number` field.
- `src/webapp/items.mutate.ts` — PATCH/POST /complete/DELETE handlers read `X-Captured-Mtime` header, compare to current mtime, log `webapp.stale_edit` on mismatch, return `staleWarning` in response.
- `src/memory/migrations/011_audit_webapp_item_mutate.sql` — add `webapp.stale_edit` to the audit category union/index.
- `public/webapp/organize/app.js` — capture `mtimeMs` on detail load; send `X-Captured-Mtime` header on mutate; show non-blocking toast on `staleWarning: true`.
- `tests/integration/webapp.organize.test.ts` — add Test M-36 (mtime mismatch → 200 + `staleWarning: true` + audit row in `webapp.stale_edit`); Test M-37 (mtime match → 200 + no `staleWarning` + no `webapp.stale_edit` row).
- `TODO.md` — v1.14.3 hard-deadline ETag entry.
- `docs/adr/010-v1.14.2-mutations.md` decision 17 #1 — language tightened from "v1.14.3 or later" to "v1.14.3" (revisions-doc supersedes by reference).

---

### R16-toast (MEDIUM — supersedes ADR 010 decision 7 toast wording) — Bind delete toast to chat-restore path; file v1.14.3 follow-up

**Concern (DA P9).** ADR 010 decision 7's toast wording is implied ("Item deleted") but not bound. Webapp users have no visible recovery path. Two options: R16 (bind toast wording with chat-restore hint) or R17 (defer to v1.14.3+).

**Decision — pick R16 over R17, with a v1.14.3 follow-up for the chat-side `restore` command.**

**Verification of pre-existing chat command.** Grepped `src/commands/organize.ts` for `restore|trash|undelete` — **no restore command exists today.** ADR 003's `softDeleteItem` has no inverse on the chat side. The chat-restore command is aspirational pending v1.14.3.

**Decision (binding).**

- **v1.14.2 toast wording:** "Deleted. Restore via Telegram chat: `/organize restore <id>`"
  - The wording binds the recoverability contract clearly.
  - The `<id>` placeholder is replaced with the actual deleted item's id at toast-render time (~5 LOC of string interpolation in `app.js`).
  - The toast is dismissable (default 5s duration) but does NOT auto-disappear before the user has time to read it — bump to 8s for delete toasts specifically.
- **v1.14.3 follow-up (FILED, not in v1.14.2 scope):** add `/organize restore <id>` chat command in `src/commands/organize.ts`. The command moves the file from `.trash/<id>.md` back to the live dir, strips the `deletedAt` front-matter field, audit-logs `organize.restore` (NEW audit category — coordinate with v1.14.3's audit category sweep). Estimate: ~40 LOC command + ~30 LOC tests + 1 audit migration line = ~75 LOC total.

**Why bind the toast wording NOW even though the chat command doesn't exist.**

1. **The trash retention is real today** (30-day TTL per ADR 003 R-revisions). The user CAN ask the operator to recover the file from `.trash/`. The toast tells the user "your data is recoverable" — TRUE today regardless of whether the chat command exists.
2. **The chat command is filed for v1.14.3.** The toast wording sets the expectation; v1.14.3 fulfills it.
3. **Binding the wording prevents Phase 2 invention.** A Phase 2 dev could write "Item deleted" (no recovery hint) or "Item permanently deleted" (false — it's soft-deleted). Binding the wording avoids both pitfalls.
4. **Aspirational copy is acceptable when the technical capability exists.** The file IS recoverable from `.trash/`; the chat command is the user-facing affordance that v1.14.3 ships. Until v1.14.3, the user can drop into chat and ask Jarvis "I deleted item X by mistake; can you help me recover it?" — Jarvis-the-agent CAN read `.trash/<id>.md` via the `organize_read` tool today (verify Phase 2 if `organize_read` supports `.trash/` paths; if not, file as v1.14.3 sub-task). Jarvis can read the trashed item and recreate it via `organize_add` as a workaround. Not elegant, but recoverable. The toast wording communicates that.

**File/line impact.**

- `public/webapp/organize/app.js` — toast text string + 8s duration override for delete toasts. ~3 LOC.
- `tests/integration/webapp.organize.test.ts` — no integration test (toast wording is client-side); add jsdom test M-38 if there's a clientRender test file: assert delete-success path renders toast with text matching `/Restore via Telegram chat/`.
- `TODO.md` — v1.14.3 follow-up: `/organize restore <id>` chat command + `organize.restore` audit category.

---

### R13 (LOW — accept) — Allowlist removal during in-flight mutation TOCTOU note

**Decision (accept R13 as-is).** Add to ADR 010 §Risks (after the existing rows):

> **Allowlist removal during in-flight mutation.** The auth check is once-per-request; if the user is removed from `config.telegram.allowedUserIds` AFTER the check passes but BEFORE the storage call, the mutation completes and the audit row records the userId. This is acceptable TOCTOU posture — the audit row records the actor, operators see the user's last action, and revocation is not retroactive. LOW.

No code change. Documentation-only addition to §Risks.

**File/line impact.**

- `docs/adr/010-v1.14.2-mutations.md` §Risks — new row per the binding text above (revisions-doc supersedes by reference).

---

### W1 (Anti-Slop W1) — `auditItemMutate` placement in `items.shared.ts`, not `server.ts`

**Concern (Anti-Slop W1).** ADR 010 decision 5 placed `auditItemMutate` helper in `server.ts` "for symmetry with `auditAuthFailure`." Anti-Slop notes that `auditItemMutate` has no debouncer (direct insert) and is only called from `items.mutate.ts`; co-locating with the only caller is a defensible alternative.

**Decision.** Place `auditItemMutate` in `src/webapp/items.shared.ts` (where the auth helper already lives), NOT in `server.ts`. **Reasoning is ASYMMETRIC with `auditAuthFailure`:**

- `auditAuthFailure` lives in `server.ts` because it OWNS the `AuditDebouncer` instance constructed at server boot. The debouncer is a stateful singleton; it must be created once and held by the server lifecycle.
- `auditItemMutate` has NO debouncer state; it's a thin wrapper around `memory.auditLog.insertReturningId`. It is stateless. Placing it next to the only caller (`items.mutate.ts`) AND alongside the other webapp-internal-but-shared helpers (`authenticateRequest` in `items.shared.ts`) is the cleaner cut.

**`mountItemsMutateRoutes` accepts `memory` directly** (already in the deps shape per ADR 010 decision 5's `ItemsRouteDeps`). The audit helper's signature: `auditItemMutate(memory, userId, itemId, changedFields, action, ip?)` — pure function, takes `memory` as a dep, no closure-over-server-state.

**File/line impact.**

- `src/webapp/items.shared.ts` (NEW per ADR 010 decision 5) — adds `auditItemMutate` export alongside `authenticateRequest`. ~25 LOC.
- `src/webapp/server.ts` — does NOT define `auditItemMutate` (the ADR's lines 419–432 inline-in-server.ts pattern is REVERSED).
- `src/webapp/items.mutate.ts` (NEW) — imports `auditItemMutate` from `./items.shared.ts`.

---

### W2 (Anti-Slop W2) — §CP1 surface gets architect's stance per item

**Decision.** ADR 010's §CP1 surface section (lines 1119–1142) gets a per-item Architect's stance annotation. This document carries that annotation explicitly:

| §CP1 item | Topic | Architect's stance | CP1 outcome |
|---|---|---|---|
| 1 | Title length 500 vs brief's 200 | **Accept** (avoid create-vs-edit asymmetry per SF-1) | DA + Anti-Slop did not push back; ACCEPTED |
| 2 | Tag regex relaxation | **Accept** (mirror existing storage posture) | DA + Anti-Slop did not push back; ACCEPTED |
| 3 | No ETag in v1.14.2 | **Defer** (v1.14.3) | DA pushed back (P1); RESOLVED via R2-mtime mitigation in v1.14.2 + v1.14.3 hard deadline |
| 4 | No privacy filter on edit | **Accept** (server-side validator IS the filter) | DA + Anti-Slop did not push back; ACCEPTED |
| 5 | Delete confirm 4s | **Revisit** (DA may have research) | DA pushed back (P2); RESOLVED via R5 (6s + countdown ring + Cancel button) |
| 6 | Hit-area 44×44 with 24×24 visual | **Revisit** (visual gap is real) | DA pushed back (P3); RESOLVED via R7 (32×32 visual) |
| 7 | Audit `changedFields` array | **Accept** (forensic value > leak risk) | DA pushed back (P5); RESOLVED via R12 (keep array, document posture) |
| 8 | Body-size 1KB cap | **Accept** (multilingual edge documented) | DA + Anti-Slop did not push back; ACCEPTED |
| 9 | UI doesn't show checkbox for abandoned | **Revisit** (decision implicit) | DA pushed back (P7); RESOLVED via R14 (bind per-status checkbox visibility rule) |
| 10 | No undo button | **Revisit** (toast wording matters) | DA pushed back (P9); RESOLVED via R16-toast (chat-restore hint + v1.14.3 follow-up) |

**File/line impact.**

- `docs/adr/010-v1.14.2-mutations.md` §CP1 surface — Architect's stance per item (this revisions doc carries the annotation; the parent ADR is not edited).

---

### W3 (Anti-Slop W3) — Named regex constants

**Decision.** `src/organize/validation.ts` exports the regex constants explicitly:

```typescript
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TAG_RE = /^[^\s,\[\]{}|]+$/;       // no whitespace, comma, or YAML reserved chars
// ITEM_ID_RE already exists in items.shared.ts (per ADR 010 decision 5 + ADR 009 inheritance)
```

The storage layer's `parseItemFile` tolerance is documented in a JSDoc note next to the validator's `ISO_DATE_RE`: "Note: `parseItemFile` is more tolerant — it accepts non-real-calendar dates that match `ISO_DATE_RE` shape (e.g., '2026-02-30'). Validator and storage agree on shape; storage does not enforce calendar correctness. Pin both to ISO_DATE_RE for stable identity."

**File/line impact.**

- `src/organize/validation.ts` — export `ISO_DATE_RE`, `TAG_RE` constants. ~3 LOC of named exports.
- `src/webapp/items.shared.ts` — `ITEM_ID_RE` already exported per ADR 010 decision 5 (no change).

---

### W4 / W5 / W6 (Anti-Slop W4-W6) — Test 33 split + audit XSS regression + notes preservation

**Decision (accept all three; partially overlaps with RA2 binding above).**

- **W4: Split Test 33 into 33a/33b/33c.**
  - **Test 33a:** PATCH returns HTTP 4xx (server rejects validation). Optimistic UI: client should NOT have flipped (the validator runs client-side first; server-side validation failure on a payload that passed client-side validation indicates a client-server schema drift — the client SHOULD show an error toast and NOT roll back, because the optimistic flip never happened). Assertion: visual state of the row is the PRE-tap state; toast text matches `/Server rejected: <error>/`.
  - **Test 33b:** POST /complete returns HTTP 5xx. Optimistic UI: client DID flip optimistically; on 5xx, roll back to pre-tap state + show error toast. Assertion: visual state ends at pre-tap; toast text matches `/Server error/`.
  - **Test 33c:** POST /complete network failure (fetch rejects). Optimistic UI: client DID flip optimistically; on network failure, roll back + show error toast. Assertion: visual state ends at pre-tap; toast text matches `/Network error/` or `/Try again/`.
- **W5: Audit XSS regression assertion.** Test 28 (XSS via title) gains an additional assertion: `audit_log.detail_json` for the action contains exactly `{action, itemId, changedFields, ip}` (the four expected keys) and the JSON string representation does NOT contain the attacker payload `<script>alert(1)</script>foo` ANYWHERE — assert `JSON.stringify(detail_json).includes('<script>')` is `false`.
- **W6: Notes preservation test (Test M-29 + M-30 above per RA2 binding).** Already covered as RA2's binding tests M-29 and M-30. W6 closes via RA2.

**File/line impact.**

- `tests/integration/webapp.organize.test.ts` — Test 33 splits into 33a/33b/33c (3 cases instead of 1); Test 28 gains audit-row assertion; Tests M-29 and M-30 added per RA2.

---

### W7 (Anti-Slop W7) — Extract `OrganizeItemDetail` interface into `src/organize/types.ts`

**Concern.** Phase-1 W6 from v1.14.0 carried forward into v1.14.2 (4th occurrence per Anti-Slop's count, now 5th if we count v1.14.2 W7). v1.14.2 doubles the response-shape duplication surface (PATCH + POST /complete + GET /:id all return the same item shape).

**Decision (accept).** Phase 2 step (insert between ADR 010's existing step 3 module split and step 4 mutate routes):

> **Step 3.5: Extract `OrganizeItemDetail` interface to `src/organize/types.ts`.** The interface matches the projection currently inlined at `itemsRoute.ts:182-202` (the GET /:id response shape: `{...frontMatter, notes: string, progress: string, fileBasename: string, mtimeMs: number}` — `mtimeMs` added per R2-mtime above). Reference from `items.read.ts` (GET /:id) and `items.mutate.ts` (PATCH success, POST /complete success). Reference from response interface declarations `PatchSuccessResponse.item: OrganizeItemDetail`, `CompleteSuccessResponse.item: OrganizeItemDetail`. ~15 LOC of new interface; ~6 LOC removed from the inlined projection at the existing GET /:id call site. Net positive.

**File/line impact.**

- `src/organize/types.ts` — NEW interface `OrganizeItemDetail` exported. ~15 LOC.
- `src/webapp/items.read.ts` — GET /:id handler imports `OrganizeItemDetail` and uses it as the response type.
- `src/webapp/items.mutate.ts` — PATCH + POST /complete success responses use `OrganizeItemDetail`.

---

### W8 (Anti-Slop W8) — Phase 2 step 8b: `CLAUDE.md` / `KNOWN_ISSUES.md` updates + factory-level follow-up

**Concern.** 5th occurrence of the recurring "Phase 2 implementation order omits CLAUDE.md / KNOWN_ISSUES.md updates" pattern (v1.11.0 W11 → v1.12.0 W10 → v1.13.0 W15 → v1.14.0 W8 → v1.14.2 W8).

**Decision (accept; add Phase 2 step 8b).** Insert between ADR 010's existing step 8 (README v1.14.2 subsection) and step 9 (Phase 2 reviewers):

> **Step 8b: Update `CLAUDE.md` and `KNOWN_ISSUES.md` with v1.14.2's new conventions:**
> 1. `src/organize/validation.ts` location (organize-feature validation; not `src/webapp/`).
> 2. `src/webapp/items.{read,mutate,shared}.ts` module split convention (split-by-method within the items module).
> 3. `webapp.item_mutate` audit category (one row per successful mutation; `webapp.stale_edit` per R2-mtime).
> 4. Hand-rolled validator pattern (no schema lib; aligned with ADR 010 decision 12).
> 5. `OrganizeItemDetail` interface as the canonical detail-response shape (per W7).
> 6. Per-call random tmp suffix in `writeAtomically` (per R8 / SF-7).

**Factory-level follow-up (W8 carryover).** Phase 2 dev (or the Lead Agent) should file a factory-level update to `<factory-repo>\KNOWN_ISSUES.md` adding an entry:

> **Recurring pattern: Architect agents historically omit CLAUDE.md / KNOWN_ISSUES.md updates from Phase 2 implementation orders.** Occurrences: v1.11.0 W11 (Architect: implementation order missed CLAUDE.md update), v1.12.0 W10, v1.13.0 W15, v1.14.0 W8, v1.14.2 W8. **Default behavior change:** Architect agents writing Phase 2 implementation orders MUST include a "Step N: Update CLAUDE.md and KNOWN_ISSUES.md with v<version>'s new conventions" step explicitly. Anti-Slop reviewers MUST grep for `CLAUDE.md` in the Phase 2 implementation order section of every ADR; missing → W flag.

This revisions doc DOES NOT write to the factory directory (per the "stay in build" rule). The follow-up note is FLAGGED for the Lead Agent / Phase 2 dev to action.

**File/line impact.**

- `CLAUDE.md` (project root) — updated per Phase 2 step 8b.
- `KNOWN_ISSUES.md` (project root) — updated per Phase 2 step 8b.
- `<factory-repo>\KNOWN_ISSUES.md` — FLAGGED for Lead Agent action (NOT modified by this revisions doc).

---

## File-impact summary table (Phase 2 dev reference)

| File | Status | Change driver(s) |
|---|---|---|
| `src/organize/storage.ts` | EDIT | R8 — 2-LOC change at `:339-343` (per-call random tmp suffix in `writeAtomically`); +1 import line for `randomBytes` if not already imported |
| `src/organize/validation.ts` | NEW | RA1 — validator returns `{ok:true,patch} \| {ok:false,code,error}` with 11 ValidatorErrorCode values; W3 — exports `ISO_DATE_RE`, `TAG_RE` |
| `src/organize/types.ts` | EDIT | W7 — adds `OrganizeItemDetail` interface (~15 LOC) |
| `src/webapp/items.shared.ts` | NEW (per ADR 010 D5) | W1 — `auditItemMutate` co-located here; ITEM_ID_RE already exported per ADR 010 D5 |
| `src/webapp/items.read.ts` | RENAME via `git mv` from `itemsRoute.ts` per ADR 010 D5 | R2-mtime — GET /:id response shape adds `mtimeMs: number`; W7 — uses `OrganizeItemDetail` |
| `src/webapp/items.mutate.ts` | NEW (per ADR 010 D5) | RA1 — direct validator-code → wire-envelope mapping; RA2 — explicit-field-copy storage patch; R18 — absolute-write POST /complete; R14 — abandoned-state branches; R2-mtime — read `X-Captured-Mtime` header, log `webapp.stale_edit`, return `staleWarning`; W1 — imports `auditItemMutate` from `items.shared.ts` |
| `src/webapp/server.ts` | EDIT | W1 — does NOT define `auditItemMutate` (REVERSAL of ADR 010 lines 419-432); calls `mountItemsMutateRoutes(app, deps)` |
| `src/memory/migrations/011_audit_webapp_item_mutate.sql` | NEW | ADR 010 D9; R2-mtime — extends category list to include `webapp.stale_edit` |
| `public/webapp/organize/app.js` | EDIT | R5 — 6s timer + Cancel button click handler; R7 — no JS change; R14 — list-render conditionally omits checkbox for abandoned; R16-toast — delete toast wording with chat-restore hint; R18 — always send `{done: !currentLocalDone}`; R2-mtime — capture `mtimeMs`, send `X-Captured-Mtime`, show non-blocking toast on `staleWarning: true` |
| `public/webapp/organize/index.html` | EDIT | R5 — Cancel button alongside Confirm |
| `public/webapp/organize/styles.css` | EDIT | R5 — countdown ring CSS (SVG circle stroke transition); R7 — checkbox 24→32 visual circle; padding 10→6 |
| `tests/integration/webapp.organize.test.ts` | EDIT | RA1 — 25 unit tests assert specific `code` values; R15 — Test 5 splits into 5a/5b/5c; RA2 — Tests M-29 + M-30; R14 — Tests M-31, M-32, M-33, M-34; R5 — Test 33 update + Test M-35; R2-mtime — Tests M-36 + M-37; W4 — Test 33 splits into 33a/33b/33c; W5 — Test 28 adds audit-row assertion |
| `tests/integration/storage.concurrency.test.ts` | NEW | R8 — 3 concurrency-stress tests for `writeAtomically` |
| `tests/unit/validation.test.ts` | EDIT | RA1 — 25 unit tests assert specific `code` values |
| `docs/PRIVACY.md` | NEW or UPDATED | R12 — operator-hardening guidance for compliance-sensitive deployments |
| `CLAUDE.md` | EDIT | W8 — v1.14.2 new conventions |
| `KNOWN_ISSUES.md` | EDIT | W8 — v1.14.2 new conventions |
| `TODO.md` | EDIT | R2-mtime — v1.14.3 hard-deadline ETag entry; R16-toast — v1.14.3 `/organize restore <id>` chat command |

**Net new files:** 4 (`validation.ts`, `items.shared.ts`, `items.mutate.ts`, `storage.concurrency.test.ts`) + the migration + the rename of `itemsRoute.ts` → `items.read.ts` (`git mv`).

**Net delta vs original ADR 010 file plan:**

- `storage.ts` was UNCHANGED in original ADR 010; now has a 2-LOC edit (R8 BLOCKING fix at `:339-343`).
- `items.shared.ts` was already NEW per ADR 010 D5; now also hosts `auditItemMutate` (W1) — no new file.
- `types.ts` was UNCHANGED in original ADR 010; now has +15 LOC `OrganizeItemDetail` (W7).
- `validation.ts` was NEW per ADR 010 D2; now ~120 LOC instead of ~80 (RA1's 11-code shape + W3's named regex constants).
- `items.mutate.ts` was NEW per ADR 010 D5; now contains the explicit-field-copy storage patch construction (RA2), the absolute-write POST /complete (R18), the abandoned-state branches (R14), the mtime stale-warning mitigation (R2-mtime), and imports `auditItemMutate` from `items.shared.ts` (W1) — material additions but no new file.
- `migrations/011_audit_webapp_item_mutate.sql` extends to include `webapp.stale_edit` (R2-mtime) — no new file.
- `app.js` material additions: R5 Cancel + countdown, R14 abandoned conditional, R16-toast wording, R18 absolute-done, R2-mtime header/capture/toast — no new file.
- `storage.concurrency.test.ts` is NEW (R8 — 3 tests).
- `PRIVACY.md` is NEW (R12).
- `TODO.md` is updated (R2-mtime + R16-toast follow-ups).

---

## Final R-list (numbered, ordered by file impact for Phase 2 dev)

This list is the binding sequence Phase 2 dev implements. Order is by file impact (storage layer first to unblock everything else; tests last).

| # | Decision | Source | Summary | Primary file |
|---|---|---|---|---|
| **R8** (BLOCKING) | `writeAtomically` at storage.ts:339-343 | DA P4 | Per-call random tmp suffix; 2 LOC | `src/organize/storage.ts` |
| R10 | SF-7 documentation | DA P4 carryover | Document the writeAtomically race + R8 fix in ADR 010 SF list | (revisions-doc) |
| RA1 / R15 | Validator return shape + empty-body distinction | Anti-Slop RA1 + DA P8 / R15 | 3-field shape with 11 ValidatorErrorCode values; route maps directly to wire envelope | `src/organize/validation.ts`, `src/webapp/items.mutate.ts` |
| RA2 | Storage-patch construction + tests M-29 / M-30 | Anti-Slop RA2 | Explicit-field-copy; never spread; integration tests verify notes/progress preserved | `src/webapp/items.mutate.ts` |
| W7 | `OrganizeItemDetail` interface extraction | Anti-Slop W7 | NEW interface in types.ts; referenced from read.ts + mutate.ts + response types | `src/organize/types.ts` |
| W3 | Named regex constants | Anti-Slop W3 | `ISO_DATE_RE`, `TAG_RE` exported from validation.ts | `src/organize/validation.ts` |
| W1 | `auditItemMutate` placement | Anti-Slop W1 | Co-located in `items.shared.ts` next to `authenticateRequest`, NOT in `server.ts` | `src/webapp/items.shared.ts`, `src/webapp/server.ts` |
| R18 | Absolute-write POST /complete | DA P10 | Server maps `{done}` → `updateItem({status})` directly; no read-flip-write | `src/webapp/items.mutate.ts` |
| R14 | Per-status checkbox visibility + abandoned branches | DA P7 | Active/done show checkbox; abandoned hides; POST /complete no-body on abandoned → 400 | `src/webapp/items.mutate.ts`, `public/webapp/organize/app.js` |
| R2-mtime | mtime stale-warning mitigation | DA P1 (R2 alternative) | `X-Captured-Mtime` header; non-blocking `staleWarning: true`; new audit category `webapp.stale_edit` | `src/webapp/items.mutate.ts`, `src/webapp/items.read.ts`, `public/webapp/organize/app.js`, migration 011 |
| (R1, R3 follow-up) | v1.14.3 hard deadline + risk-row update | DA P1 (R1+R3) | TODO entry; §Risks row wording | `TODO.md`, ADR §Risks |
| R5 | Delete confirm 6s + countdown ring + Cancel | DA P2 | 4s → 6s; visible countdown ring + Cancel button | `public/webapp/organize/app.js`, `index.html`, `styles.css` |
| R7 | Checkbox visual 32×32 inside 44×44 hit | DA P3 | CSS only; closes perceptual gap | `public/webapp/organize/styles.css` |
| R12 | `changedFields` array + privacy posture doc | DA P5 (R12 over R11) | Keep array; document operator hardening for compliance-sensitive deployments | `docs/PRIVACY.md`, ADR §Risks |
| R16-toast | Delete toast wording + v1.14.3 follow-up | DA P9 (R16 over R17) | "Deleted. Restore via Telegram chat: `/organize restore <id>`" + 8s duration; chat command filed v1.14.3 | `public/webapp/organize/app.js`, `TODO.md` |
| R13 | TOCTOU §Risks note | DA P6 | 1-line note; LOW; no code change | ADR §Risks |
| W2 | §CP1 surface architect's stance | Anti-Slop W2 | Per-item Accept/Revisit/Defer annotation in this revisions doc | (revisions-doc) |
| W4 | Test 33 split into 33a/33b/33c | Anti-Slop W4 | Three rollback paths exercised separately | `tests/integration/webapp.organize.test.ts` |
| W5 | Audit XSS regression assertion | Anti-Slop W5 | Test 28 asserts `JSON.stringify(detail_json).includes('<script>')` is false | `tests/integration/webapp.organize.test.ts` |
| W6 | Notes preservation test | Anti-Slop W6 | Closes via RA2 binding (Tests M-29 / M-30) | `tests/integration/webapp.organize.test.ts` |
| W8 | Phase 2 step 8b: CLAUDE.md / KNOWN_ISSUES.md | Anti-Slop W8 | Update with v1.14.2 conventions; flag factory-level follow-up | `CLAUDE.md`, `KNOWN_ISSUES.md`, factory follow-up |

---

## Pushbacks (the architect disagrees with, with justification)

**None.** All R-revisions and RA-actions are accepted. The A/B alternatives were resolved per the recommended defaults with justifications above:

- **R8 over R9** — same atomicity guarantee, zero contention, 2 LOC vs 30 LOC.
- **R5 over R4** — pattern match with Telegram WebApp; cost asymmetry; >95% confirm coverage at 10% of R4's cost.
- **R7 over R6** — closes the perceptual gap directly; R6's visual divider is a polish-tier addition.
- **R12 over R11** — forensic value of `changedFields` array > leak risk; the audit log alone leaks zero content.
- **R16-toast over R17** — bind the wording NOW; v1.14.3 fulfills with the chat command.
- **R2 over R1 and R3** — non-blocking mitigation with one-line client + five-line server; surfaces the race without the 412 cliff.

The architect did not push back on any DA finding or Anti-Slop finding because each was either (a) a real bug the architect did not catch (R8 BLOCKING — verified); (b) a UX cliff the architect did not have research for (R5 timing); (c) a documentation/code-shape improvement that's strictly better than the original (RA1, RA2, W1, W7); or (d) a privacy or correctness binding that closes a Phase-2 ambiguity (R14, R18, R12).

---

## Phase-2 readiness verdict

**READY.** All 1 BLOCKING (R8) + 2 HIGH (R2-mtime/P1, R18/P10) + 5 MEDIUM (R5, R7, R12, R14, R16-toast) + 2 LOW (R13, R15) + 2 FAIL-adjacent (RA1, RA2) + 8 warnings (W1–W8) resolved with concrete ADR text and file/line bindings. Phase 2 may start. The first commit MUST be R8 (`writeAtomically` random suffix at `src/organize/storage.ts:339-343`) — all subsequent mutation work depends on the data-corruption fix being upstream. Phase-2 Anti-Slop + Scalability + QA reviewers run after the full set lands. CP1 reviewers do not re-fire.
