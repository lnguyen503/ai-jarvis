# ADR 014 — Revisions after CP1 debate (2026-04-25)

**Parent:** `014-v1.14.6-bulk-and-create.md`
**Status:** Accepted. Folded into ADR 014 by reference. Phase 2 dev agents implement the revised spec; deviations require another addendum.

**Context.** Devil's Advocate review (`docs/reviews/cp1-devils-advocate-v1.14.6.md`) raised 1 BLOCKING + 2 HIGH + 6 MEDIUM + 7 OK with 9 numbered R-revisions (R1–R9). Anti-Slop Phase 1 review (`docs/reviews/anti-slop-phase1-review-v1.14.6.md`) raised 1 Required Action (RA1) + 6 warnings (W1–W6) + 3 cosmetic carry-forward. **Convergence signal:** both reviewers independently flagged the bulk PATCH If-Match self-contradiction in ADR 014 (DA P2/R1 + Anti-Slop W2 — same finding from two angles). Two reviewers + same finding = strong signal; this is the BLOCKING. Independent convergence also surfaced on the trash-extract circular-import seam (DA P5 → Anti-Slop W1 corroborated): the resolution is to KEEP `ensureTrashDir` in `storage.ts` and pull `softDeleteItem` calls there, with `trash.ts → storage.ts` as the single one-way edge.

The architect resolves the BLOCKING (R1 + W2) with a **VERB-ASYMMETRIC If-Match contract** for bulk: DELETE + POST /complete MAY omit If-Match (verb-intent-clear; absolute-write semantics); PATCH (re-parent) MUST send per-item If-Match (parentId WRITE is the highest-risk silent-overwrite case). Accepts both HIGH (R2 typed-confirm at >50 delete; R3 split iteration declined with justification — see Pushback section), accepts the RA1 in full (11 KNOWN_ISSUES entries + 4 CLAUDE.md invariants), accepts every MEDIUM (R4 BC_DEDUP_WINDOW_MS / MAX_BULK_INFLIGHT relationship doc; R5 v1.14.7 trigger for re-parent preview; R6 AbortController + 30s timeout in handleCreateSubmit; R7 D9 filter-change-exits-select rationale; R8 D16 dedup prose tighten; R9 mutual exclusion select-mode vs create-form), accepts every Anti-Slop warning (W1 ensureTrashDir keeps in storage.ts; W2 closes via R1; W3 LOC math reconcile; W4 NUL-byte retrofit scope clarified; W5 visibility-change race test; W6 mountItemsCreateRoutes wire-integrity test).

The BLOCKING (R1 + W2 — convergent on the bulk PATCH If-Match self-contradiction) MUST land in v1.14.6. Non-negotiable. Verified at ADR 014 D5 line 187-191 (says bulk PATCH sends per-item If-Match) vs P4 line 1029 ("bulk-force-state"; bulk omits If-Match). The two passages are mutually inconsistent. The architect resolves with a verb-asymmetric contract documented below; this is more nuanced than either source position and is the architect's binding for Phase 2.

This revisions document supersedes the relevant clauses of ADR 014 by reference; the parent ADR is not edited.

---

## Resolved (R-numbered, ordered by file impact for Phase 2)

### R1 + W2 (BLOCKING — convergent — supersedes ADR 014 D5 line 187-191 + P4 line 1029) — Verb-asymmetric If-Match contract for bulk

**Concern (DA P2/R1 + Anti-Slop W2 convergent).** ADR 014 D5 line 187-191 specifies: "Client dispatches N parallel `PATCH /:id {parentId: G}` requests, each with its own `If-Match: <etag>` (the per-item ETag captured at list-fetch time, retained in `renderedItems[]`)." ADR 014 P4 line 1029 (CP1 surface section) specifies: "ADR 014 takes the LATTER position: bulk operations send NO If-Match (omit the header); the audit row records `etag: null, forced: false`." **The two passages are mutually inconsistent.** D5 binds bulk PATCH to per-item If-Match; P4 binds bulk to "no If-Match, forced state." DA flagged this as P2/R1 (BLOCKING — picker-source self-contradiction); Anti-Slop W2 caught the same line-pair from a doc-clarity angle. Two reviewers, same finding, different framings — strong signal that the architect's spec needs explicit binding.

The right answer is **neither** of the source positions in isolation. The verb determines the risk:

  - **DELETE.** Intent is clear ("I want this gone"); destination is trash (recoverable via /organize restore for 30 days); the user is in select-mode = explicit batch operation. Per-item If-Match would force per-item ETag tracking on the client (memory + complexity) for marginal protection. The user signaled "delete this set"; concurrent edits to a doomed item are not an overwrite to recover from. **Bulk DELETE MAY omit If-Match.**
  - **POST /complete.** Absolute-write semantics from v1.14.2 R18: the request body's `{done: true|false}` is the source of truth; conflict detection is moot because the operation is idempotent toward a target state. **Bulk POST /complete MAY omit If-Match.**
  - **PATCH (re-parent).** This is a parentId WRITE that overrides existing parentId. If another tab or the chat-agent has just re-parented the same item to a DIFFERENT goal, the bulk PATCH silently overwrites that decision. Same axis applies to other PATCHable fields (title, due, tags, notes, progress) if bulk-PATCH ever extends beyond re-parent — but for v1.14.6, re-parent is the only bulk PATCH use case. The parentId silent-overwrite case is the highest-risk WRITE in the bulk surface; without per-item If-Match, the user cannot detect the race. **Bulk PATCH MUST send per-item If-Match.** Closes DA R1.

**Decision — verb-asymmetric If-Match contract; bind explicitly in ADR text + Phase 2 dev brief.**

**Contract (specification).**

  - **Bulk DELETE (multiple `/api/webapp/items/:id` DELETE requests):**
    - Client MAY omit `If-Match` header.
    - Server's existing DELETE handler accepts requests without `If-Match` (already supported per ADR 012 — If-Match is optional on PATCH/DELETE; absence means "Save Anyway" semantics on the server).
    - Audit row records `etag: null, forced: true, bypassAfter412: false` (consistent with single-item Save Anyway semantics).
    - Conflict tracker is NOT consulted (no 412 path — the server doesn't emit 412 when If-Match is absent).
  - **Bulk POST /complete (multiple `/api/webapp/items/:id/complete` POST requests):**
    - Client MAY omit `If-Match` header.
    - Server's existing /complete handler accepts requests without `If-Match` (per v1.14.4 D9 — If-Match optional on /complete; absent means "absolute-write to target state").
    - Audit row records `etag: null, forced: true`.
  - **Bulk PATCH (multiple `/api/webapp/items/:id` PATCH requests for re-parent):**
    - Client MUST send per-item `If-Match: <captured-etag>` header.
    - Server's existing PATCH handler enforces If-Match per ADR 012; emits 412 with `currentItem` envelope on mismatch.
    - 412 responses surface in the bulk-results UI as: "X items had concurrent edits — open detail to retry" (D4 partial-failure UX, with a 412-specific message variant).
    - Audit row records `etag: <captured>, forced: false, bypassAfter412: false`.
    - **Save Anyway path on 412 from bulk:** ALSO bulk; user can choose "Save Anyway" from the bulk-results UI to retry the failed subset WITHOUT If-Match (rare; document as v1.14.7+ polish if usage data shows it matters; v1.14.6 surfaces the failures and lets the user pick a different parent or open items individually).

**Phase 2 dev's responsibility (binding).**

  1. Client builds N parallel PATCH requests with per-item `If-Match: <captured-etag>` headers (the ETag captured at list-fetch time, retained in `renderedItems[]`).
  2. Client builds N parallel DELETE requests WITHOUT If-Match (header omitted).
  3. Client builds N parallel POST /complete requests WITHOUT If-Match (header omitted).
  4. 412 responses from the bulk PATCH path surface in the results UI as: "X items had concurrent edits — open detail to retry" (D4 toast variant).
  5. Save Anyway from bulk-PATCH-412 results UI: retry the failed subset WITHOUT If-Match (rare; document as v1.14.7+ polish).
  6. Bulk DELETE / bulk POST /complete responses do NOT have a 412 path (server doesn't emit it without If-Match); failures from those endpoints are 4xx (validation), 401/403 (auth), or 5xx (server) — surfaced as generic "X items failed" toast.

**Tests required (Phase 2).**

  1. **Test R1-1 (verb-asymmetric If-Match — PATCH MUST send per-item If-Match):** Bulk re-parent dispatch via `dispatchBulk`; mock the fetch; assert each PATCH request has an `If-Match` header set to the item's captured ETag.
  2. **Test R1-2 (verb-asymmetric If-Match — DELETE omits If-Match):** Bulk delete dispatch; assert each DELETE request does NOT have an `If-Match` header.
  3. **Test R1-3 (verb-asymmetric If-Match — POST /complete omits If-Match):** Bulk complete dispatch; assert each POST /complete request does NOT have an `If-Match` header.
  4. **Test R1-4 (412 path on bulk PATCH):** Mock 412 response on subset of PATCH requests; assert results UI shows "X items had concurrent edits"; assert failed items remain selected per D4.
  5. **Test R1-5 (Save Anyway from bulk-PATCH-412 results UI):** From the 412 results, fire Save Anyway on the failed subset; assert the retry PATCH requests omit If-Match; assert success toast on resolve.

**File/line impact.**

  - `public/webapp/organize/app.js` — bulk dispatchers gain verb-asymmetric If-Match logic. PATCH dispatcher wraps each request with `If-Match: <etag>` header; DELETE + POST /complete dispatchers omit. ~10 LOC.
  - `tests/integration/webapp.organize.bulk.test.ts` — +5 tests (R1-1 through R1-5; ~80 LOC).
  - ADR 014 D5 prose updated to bind the verb-asymmetric contract (this addendum supersedes lines 187-191 and 1029).

---

### R2 (HIGH — supersedes ADR 014 D12 line 440 — bulk delete confirm) — Typed-confirm at >50 delete

**Concern (DA P1).** ADR 014 D12 line 440 specifies a SINGLE 6-second two-tap confirm for ALL bulk delete sizes. DA P1 raises: a user mis-taps "Select All" + "Delete" + the 6s confirm → 200 items gone, all in trash. The 6s confirm covers it but it's a single confirm for an N-amplified action. Items go to trash with 30-day TTL (recoverable via `/organize restore` from chat), so NOT lost — but recovery effort scales with N. The right pattern: keep the 6s two-tap for small batches; escalate to a typed-confirm at >50 items.

**Decision — accept R2 in full; escalate confirm at threshold.**

**R2 — bulk delete confirmation:**

  - **≤50 items:** existing 6-second two-tap confirm (D12 line 440 unchanged for this branch).
  - **>50 items:** typed-confirm — show a text input asking the user to type "DELETE" (uppercase, exact match). On match, fire the bulk. On mismatch, show error.

**Constant (per RA1 wire-constant discipline).**

```javascript
// public/webapp/organize/app.js — top-of-file constant block
const BULK_DELETE_TYPED_CONFIRM_THRESHOLD = 50;  // R2 (HIGH from CP1 v1.14.6):
                                                  // bulk delete >50 items requires typing "DELETE".
                                                  // ≤50 keeps the 6s two-tap pattern.
```

**UX detail (specification).**

  - Typed-confirm input is a focused `<input type="text">` next to the standard "Delete" button.
  - Replace the count display ("Selected: 75") with the input field when threshold crosses.
  - On Enter or button-tap, validate: if value === "DELETE" (exact match, case-sensitive), fire the bulk; else show error message "Type DELETE to confirm.".
  - On mode-exit (D9 transitions), the input field is cleared.
  - The 6s two-tap timer logic is bypassed entirely for the >50 branch — the typed-confirm IS the confirm; no second tap needed after typing.

**Pseudocode (specification).**

```javascript
function handleBulkDeleteClick() {
  const ids = Array.from(selectedIds);
  if (ids.length === 0) return;

  if (ids.length > BULK_DELETE_TYPED_CONFIRM_THRESHOLD) {
    // Show typed-confirm input + validation handler
    showTypedConfirmInput(ids);
    return;
  }

  // ≤50: existing 6-second two-tap confirm path
  if (!bulkDeleteConfirmPending) {
    bulkDeleteConfirmPending = true;
    showToast(`Delete ${ids.length} items? Tap Delete again within 6s.`, 6000);
    bulkDeleteConfirmTimer = setTimeout(() => {
      bulkDeleteConfirmPending = false;
    }, 6000);
    return;
  }
  // Second tap — fire bulk dispatch
  clearTimeout(bulkDeleteConfirmTimer);
  bulkDeleteConfirmPending = false;
  dispatchBulkDelete(ids);
}

function showTypedConfirmInput(ids) {
  // Replace count display with <input type="text"> + "Delete" button
  // Listen for Enter or button click; validate value === "DELETE";
  // On match, dispatchBulkDelete(ids); on mismatch, show error.
}
```

**Tests required (Phase 2).** Add to `tests/public/webapp/organize.multiselect.test.ts`:

  1. **Test R2-1 (≤50 items uses 6s two-tap):** Select 50 items; tap Delete; verify 6s toast appears; second tap fires bulk dispatch.
  2. **Test R2-2 (>50 items uses typed-confirm):** Select 51 items; tap Delete; verify typed-confirm input appears (NOT 6s toast); type "DELETE"; press Enter; verify bulk dispatch fires.
  3. **Test R2-3 (typed-confirm mismatch):** Select 100 items; tap Delete; type "delete" (lowercase); press Enter; verify error message; bulk dispatch does NOT fire.
  4. **Test R2-4 (mode-exit clears typed input):** Select 75 items; tap Delete; type "DELE"; press Cancel; verify input cleared; re-enter select mode; verify input is fresh.

**File/line impact.**

  - `public/webapp/organize/app.js` — `handleBulkDeleteClick` branches on `BULK_DELETE_TYPED_CONFIRM_THRESHOLD`; new `showTypedConfirmInput` helper; constant declared. ~25 LOC.
  - `public/webapp/organize/index.html` — add `<input id="bulk-delete-typed-confirm" type="text" hidden>` to the bulk-toolbar markup. ~3 LOC.
  - `public/webapp/organize/styles.css` — typed-confirm input styling. ~10 LOC.
  - `tests/public/webapp/organize.multiselect.test.ts` — +4 tests (~60 LOC).

---

### R6 (MEDIUM — supersedes ADR 014 D15 line 567-619 — handleCreateSubmit) — AbortController + 30s timeout

**Concern (DA P5).** ADR 014 D15's `_createSubmitInFlight` flag closes the JS-thread case (rapid double-clicks → exactly one POST). But the iOS Safari + WKWebView networking stack has a known failure mode where a fetch is queued at the OS level but the app is backgrounded before the request dispatches; the JS Promise sits forever-pending; the Create button is forever-disabled; the user has no recovery path except force-quit. Telegram WebApp inherits this surface. DA P5: wrap the fetch in AbortController + 30s setTimeout abort.

**Decision — accept R6 in full; AbortController + 30s timeout on create + bulk submissions.**

**Constant.**

```javascript
// public/webapp/organize/app.js — top-of-file constant block
const CREATE_SUBMIT_TIMEOUT_MS = 30000;  // R6 (MEDIUM from CP1 v1.14.6):
                                           // AbortController abort timeout for
                                           // create + bulk submissions; closes the
                                           // iOS-backgrounded-fetch-permanently-pending
                                           // state; on abort, re-enable the button + show error.
```

**handleCreateSubmit specification (revised D15).**

```javascript
async function handleCreateSubmit() {
  if (_createSubmitInFlight) return;
  _createSubmitInFlight = true;

  const btn = document.getElementById('create-submit');
  if (btn) btn.disabled = true;
  if (createSpinnerEl) createSpinnerEl.hidden = false;

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), CREATE_SUBMIT_TIMEOUT_MS);

  try {
    const body = collectCreateFormBody();
    const res = await fetch('/api/webapp/items', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `tma ${initData}`,
      },
      body: JSON.stringify(body),
      signal: abortController.signal,
    });
    // ... existing success / error branches ...
  } catch (err) {
    if (err.name === 'AbortError') {
      showCreateError('Request timed out; retry?');
    } else {
      showCreateError('Network error. Try again.');
    }
  } finally {
    clearTimeout(timeoutId);
    _createSubmitInFlight = false;
    if (btn) btn.disabled = false;
    if (createSpinnerEl) createSpinnerEl.hidden = true;
  }
}
```

**Bulk submissions ALSO use this pattern (binding for D3 dispatchBulk).** Each per-item fetch in `dispatchBulk` wraps with its own AbortController + `CREATE_SUBMIT_TIMEOUT_MS` setTimeout; on abort, the per-item result is `{ok: false, error: AbortError}`. D4 surfaces it as a generic failure ("X items failed").

**Tests required (Phase 2).** Add to `tests/public/webapp/organize.create-form.test.ts`:

  1. **Test R6-1 (timeout fires AbortError):** Mock fetch with a Promise that never resolves; advance fake timers to 30001ms; assert `_createSubmitInFlight === false` (button re-enabled); assert error message "Request timed out; retry?" is displayed.
  2. **Test R6-2 (timeout cleared on success):** Mock fetch with a Promise that resolves at 100ms; assert `clearTimeout` is called; assert no AbortError surfaces.

**File/line impact.**

  - `public/webapp/organize/app.js` — `handleCreateSubmit` gains AbortController + setTimeout; constant declared; bulk dispatchers also wrap. ~15 LOC.
  - `tests/public/webapp/organize.create-form.test.ts` — +2 tests (~30 LOC).

---

### R9 (MEDIUM — supersedes ADR 014 D10/D13 — mutual exclusion of select mode and create form)

**Concern (DA P15).** ADR 014 D10 adds a "Select" header button; D13 adds a "+ New" header button. Both can be tapped at any time. If select mode is active and the user taps "+ New", the create form opens BELOW the bulk toolbar — UX clutter (header + bulk toolbar + create form + filter chips all competing for the top of the viewport on phones). Conversely, if the create form is open and the user taps "Select", the select-mode toolbar appears with the create form still open. Either path gives the user three controls to track at once.

**Decision — accept R9; bind mutual exclusion at the UI level.**

**Specification.**

  - When create form is open: "Select" button is hidden (`hidden` attribute set) AND disabled (`disabled` attribute set, defense-in-depth).
  - When in select mode: "+ New" button is hidden AND disabled.
  - Toggling between the two modes: user must explicitly cancel the active mode first.
  - Visual state: the active mode's button label flips ("Select" → "Cancel"; "+ New" → "Cancel"); the inactive mode's button is hidden, not just disabled, so the user does not see a greyed-out tease.

**Pseudocode.**

```javascript
function showCreateForm() {
  createFormEl.hidden = false;
  selectToggleBtn.hidden = true;
  selectToggleBtn.disabled = true;
}

function hideCreateForm() {
  createFormEl.hidden = true;
  selectToggleBtn.hidden = false;
  selectToggleBtn.disabled = false;
}

function enterSelectMode() {
  multiSelectMode = true;
  selectToggleBtn.textContent = 'Cancel';
  newBtn.hidden = true;
  newBtn.disabled = true;
  // ... existing bulk-toolbar render ...
}

function exitSelectMode() {
  multiSelectMode = false;
  selectedIds.clear();
  selectToggleBtn.textContent = 'Select';
  newBtn.hidden = false;
  newBtn.disabled = false;
  // ... existing bulk-toolbar hide ...
}
```

**Justify.** Prevents UX clutter (action bar + form + multiple controls competing for the top of the viewport on phones). The cost is ~15 LOC client-side; the benefit is a clean state machine where exactly one of {normal-mode, select-mode, create-form-open} is active at a time. Same posture as the v1.14.5 banner / conflict-panel mutual exclusion (only one overlay layer active at a time).

**Tests required (Phase 2).** Add to `tests/public/webapp/organize.multiselect.test.ts` + `tests/public/webapp/organize.create-form.test.ts`:

  1. **Test R9-1 (open create form hides Select button):** Open create form; assert `selectToggleBtn.hidden === true`; assert `selectToggleBtn.disabled === true`.
  2. **Test R9-2 (enter select mode hides "+ New" button):** Tap Select; assert `newBtn.hidden === true`.
  3. **Test R9-3 (cancel create form restores Select):** Open create form; tap Cancel; assert `selectToggleBtn.hidden === false`.
  4. **Test R9-4 (exit select mode restores "+ New"):** Enter select mode; tap Cancel; assert `newBtn.hidden === false`.

**File/line impact.**

  - `public/webapp/organize/app.js` — `showCreateForm` / `hideCreateForm` / `enterSelectMode` / `exitSelectMode` gain visibility flips. ~15 LOC.
  - `tests/public/webapp/organize.multiselect.test.ts` + `tests/public/webapp/organize.create-form.test.ts` — +4 tests (~50 LOC).

---

### W1 (Anti-Slop W1 — supersedes ADR 014 D1 line 46) — `ensureTrashDir` STAYS in storage.ts

**Concern (Anti-Slop W1 + DA P5 corroborated).** ADR 014 D1 line 46 says: "`ensureTrashDir` (storage.ts:76) → moves to trash.ts as a private helper. softDeleteItem (which stays in storage.ts) imports it from trash.ts. This creates a controlled storage.ts → trash.ts dependency edge." DA P5 verified the cycle risk: storage.ts → trash.ts (for ensureTrashDir) AND trash.ts → storage.ts (for parseItemFileFromRaw). Two-way edge = circular import. ADR 014 P5 line 1031-1032 (CP1 surface section) recognizes the issue and concedes: "Move ensureTrashDir back to storage.ts; trash.ts imports it. … KEEP IT IN STORAGE.TS." But the D1 prose (line 46) was NOT updated to reflect the P5 concession. Two passages contradict; Phase 2 dev would have to pick one. Anti-Slop W1 asks the architect to bind explicitly.

**Decision — bind D1 to KEEP `ensureTrashDir` in storage.ts; one-way `trash.ts → storage.ts` edge only.**

**Specification (revised D1 line 46).**

  - `ensureTrashDir` STAYS in `storage.ts` (used by `softDeleteItem` in storage.ts AND by `listTrashedItems` / `evictExpiredTrash` / `restoreItem` in trash.ts).
  - `trash.ts` imports `ensureTrashDir` from `./storage.js` — one-way edge.
  - `storage.ts` does NOT import from `trash.ts` (no cycle).
  - `softDeleteItem` STAYS in storage.ts (writes are core CRUD; the live-dir → trash transition belongs with the CRUD primitives).

**Verification of one-way edge (call-graph trace).**

  - `softDeleteItem` (storage.ts) calls: `readItem` (storage.ts), `writeAtomically` (storage.ts), `ensureTrashDir` (storage.ts), `rename` (node:fs/promises). **All in storage.ts; zero trash.ts imports needed.**
  - `listTrashedItems` (trash.ts) calls: `ensureTrashDir` (storage.ts), `readdir` (node:fs), `parseItemFileFromRaw` (storage.ts), `readItemFrontMatterFromPath` (storage.ts). **trash.ts → storage.ts only.**
  - `evictExpiredTrash` (trash.ts) calls: `ensureTrashDir` (storage.ts), `readdir`, `unlink`, `parseItemFileFromRaw` (storage.ts). **trash.ts → storage.ts only.**
  - `restoreItem` (trash.ts) calls: `readItem` (storage.ts), `writeAtomically` (storage.ts), `rename`. **trash.ts → storage.ts only.**
  - `findClosestTrashedIds` (trash.ts) calls: `ensureTrashDir` (storage.ts), `readdir`, `readItemFrontMatterFromPath` (storage.ts). **trash.ts → storage.ts only.**

**No cycle. trash.ts imports from storage.ts; storage.ts does NOT import from trash.ts.**

**Bind D1's exact extraction list (revised).**

  - **MOVE to trash.ts:** `listTrashedItems`, `evictExpiredTrash`, `restoreItem`, `findClosestTrashedIds` (relocated from `commands/organize.ts`).
  - **KEEP IN storage.ts:** `softDeleteItem`, `ensureTrashDir`, `ensureUserDir`, `writeAtomically`, `readItem`, `readItemFrontMatter`, `readItemFrontMatterFromPath`, `parseItemFile`, `parseItemFileFromRaw` (new export wrapper from D1), `createItem`, `updateItem`, all CRUD primitives + helpers.

**LOC accounting (revised).** storage.ts: 1391 HEAD − 70 (listTrashedItems) − 130 (evictExpiredTrash) − 70 (restoreItem) + 8 (parseItemFileFromRaw export wrapper) = **~1129 LOC** (`ensureTrashDir` stays; the −16 LOC from the original D1 calc no longer applies; the +4 LOC import-line-from-trash.ts no longer applies). Below the 1300 threshold; clean.

**File/line impact.**

  - `src/organize/storage.ts` — keeps `ensureTrashDir` (no removal); adds `parseItemFileFromRaw` export wrapper. Net delta: −262 LOC (1391 → ~1129).
  - `src/organize/trash.ts` (NEW) — imports `ensureTrashDir`, `readItemFrontMatter`, `readItemFrontMatterFromPath`, `parseItemFileFromRaw` from `./storage.js` (one-way edge). Net delta: +351 LOC (unchanged from D1 estimate).
  - ADR 014 D1 line 46 prose updated to bind `ensureTrashDir` stays in storage.ts (this addendum supersedes).

---

### RA1 (Anti-Slop Required Action — `KNOWN_ISSUES.md` + `CLAUDE.md` enumeration — 4th consecutive iteration) — Accept in full

**Concern (Anti-Slop RA1).** The RA1 pattern is now in its 4th consecutive iteration (v1.14.3, v1.14.4, v1.14.5, v1.14.6). Before each Phase 2 launch, ADR enumerates the v-iteration entries that will land in `KNOWN_ISSUES.md` AND the invariants that will land in `CLAUDE.md`. The enumeration ensures ops + future architects see what changed in this iteration; the invariants ensure future agents do not re-litigate decided architecture.

**Decision — accept in full; enumerate 11 KNOWN_ISSUES entries + 4 CLAUDE.md invariants.**

**KNOWN_ISSUES.md v1.14.6 entries (11).**

  1. **Trash module split.** `src/organize/trash.ts` houses `listTrashedItems` + `evictExpiredTrash` + `restoreItem` + `findClosestTrashedIds`. `softDeleteItem` STAYS in storage.ts. `trash.ts → storage.ts` is one-way edge (`ensureTrashDir` lives in storage.ts).
  2. **Bulk pattern: client-fired N parallel requests.** Server has NO bulk endpoint. Each request gets its own audit row, ETag check (verb-asymmetric per #7 below), and 4xx/5xx response.
  3. **`MAX_BULK_INFLIGHT = 10`:** client-side concurrency limiter; queue-based; same magic number Chrome / Firefox use for HTTP concurrency-per-origin.
  4. **`BC_DEDUP_WINDOW_MS = 1000`:** BroadcastChannel listener dedup window; always-reset on incoming message; fire when timer expires.
  5. **`BULK_DELETE_TYPED_CONFIRM_THRESHOLD = 50`:** above this, bulk DELETE requires typing "DELETE" (uppercase, exact match) to confirm; ≤50 keeps the 6s two-tap pattern.
  6. **`CREATE_SUBMIT_TIMEOUT_MS = 30000`:** AbortController abort timeout on create + bulk submissions; closes the iOS-backgrounded-fetch-permanently-pending state.
  7. **Verb-asymmetric If-Match on bulk:** DELETE / POST /complete MAY omit If-Match (verb-intent-clear; absolute-write semantics); PATCH (re-parent) MUST send per-item If-Match. Closes the highest-risk parentId-silent-overwrite case. Save Anyway from 412 in bulk-results UI is also bulk; v1.14.7+ polish if usage data shows it matters.
  8. **`webapp.item_create` audit category** separate from `webapp.item_mutate`. Detail = `{itemId, type, hasParent, ip}`. NO field VALUES recorded (privacy posture matches v1.14.3 W5 + ADR 010 decision 4).
  9. **`validateCreateBody` separate from `validatePatchBody`** (required fields differ — type + title required for create; PATCH has none required). New codes `CREATE_TYPE_REQUIRED`, `CREATE_UNKNOWN_FIELDS`, `CREATE_PARENT_ON_GOAL`.
  10. **NUL-byte ban retrofit:** `TITLE_INVALID_CHARS` validator code added; tags via `TAG_RE` `^[a-z0-9-]+$` already excludes NUL byte (no retrofit needed); notes/progress already had it from v1.14.3 D2 fix 4.
  11. **Multi-select state:** in-memory only (NO sessionStorage / NO localStorage); mode-exit on Cancel / ESC / detail nav / filter change / all-success bulk; D9 transition contract.

**CLAUDE.md v1.14.6 invariants (4).**

  - **5-file webapp items module shape** — `items.read.ts`, `items.mutate.ts` (PATCH+DELETE), `items.complete.ts` (POST /complete), `items.create.ts` (POST /), `items.shared.ts` (helpers). Each ≤500 LOC. Add new resource = new file (don't grow `items.mutate.ts` past 500). Lesson learned from v1.14.5 R3 split: per-HTTP-verb / per-semantic-group is the right axis.
  - **Bulk-as-N-parallel** — per-item ETag tracking + per-item audit row + verb-asymmetric If-Match. Server is bulk-unaware. Each item is a REST resource with its own ETag, audit row, conflict-tracker entry, and 412 response path.
  - **Trash module location** — `trash.ts` owns trash-as-source-of-truth ops (read / restore / evict / findClosest); `storage.ts` owns CRUD primaries (including `softDeleteItem` and `ensureTrashDir`). One-way `trash.ts → storage.ts` edge only.
  - **`BC_DEDUP_WINDOW_MS` interacts with `MAX_BULK_INFLIGHT`** — window covers worst-case batch wall-clock (50 items × ~200ms / 10-concurrent ≈ 1s) + 200ms slop. Tunable: lower BC_DEDUP_WINDOW_MS to 500ms if real-world usage shows refetch lag is annoying.

**File/line impact.**

  - `D:\ai-jarvis\KNOWN_ISSUES.md` — +11 v1.14.6 entries (~80 LOC).
  - `D:\ai-jarvis\CLAUDE.md` — +4 v1.14.6 invariants (~16 LOC).

---

### R4 (MEDIUM — supersedes ADR 014 D3 / D16 — BC_DEDUP_WINDOW_MS / MAX_BULK_INFLIGHT relationship) — Document interaction

**Concern (DA P3).** ADR 014 D3 sets `MAX_BULK_INFLIGHT = 10`; ADR 014 D16 sets `BC_DEDUP_WINDOW_MS = 1000`. The two constants interact mathematically — the dedup window must cover the worst-case batch wall-clock to collapse a bulk-of-N broadcasts into ONE refetch. The interaction is implicit in D16's "Why 1s" rationale (line 687) but is not bound in ADR text or KNOWN_ISSUES. Future iterations that change either constant could break the collapse.

**Decision — accept R4; document the interaction in ADR text + KNOWN_ISSUES.md (covered by RA1 entry 4).**

**Specification (revised D16 prose, in addition to RA1 KNOWN_ISSUES entry).**

  - `MAX_BULK_INFLIGHT = 10`: client never has more than 10 PATCH/DELETE/POST in-flight at once.
  - `BC_DEDUP_WINDOW_MS = 1000`: listener tab waits 1s after last BC message before refetching.
  - **Bulk burst worst case:** 50 items × ~200ms each / 10-concurrent = ~1s wall clock. Listener's 1s window collapses 50 broadcasts into ONE refetch fired ~1s after batch completes.
  - **Tunable:** if real-world usage shows refetch lag is annoying, lower `BC_DEDUP_WINDOW_MS` to 500ms. The collapse still works for batches up to ~25 items at the throttle rate; bigger batches would split into 2 refetches.
  - **Inverse direction:** if `MAX_BULK_INFLIGHT` is raised (e.g., to 20), batch wall-clock shrinks; `BC_DEDUP_WINDOW_MS` may also be tuned down. Don't change one without the other.

**File/line impact.**

  - ADR 014 D16 prose addendum (this revisions doc; +1 paragraph).
  - `KNOWN_ISSUES.md` v1.14.6 entry 4 (covered by RA1).

---

### R5 (MEDIUM — supersedes ADR 014 D18 — bulk re-parent confirmation preview as v1.14.7+ trigger)

**Concern (DA P8).** ADR 014 D12 line 442 specifies "Bulk Re-parent: NO confirm." DA P8 raises: with parentId being a silent-overwrite write, the user may mis-target the parent picker — pick "Goal A" instead of "Goal A-2" — and re-parent 50 items to the wrong goal. Even with verb-asymmetric If-Match (R1 above), the user's INTENT is wrong; If-Match doesn't catch intent errors. A "5 tasks → 'Goal X'" confirmation preview would close it.

**Decision — accept R5; file as v1.14.7 candidate. v1.14.6 ships without a re-parent preview.**

**Specification.**

  - v1.14.6 bulk re-parent shows "Move N items to 'Goal X'?" as the picker confirmation but NO per-item preview.
  - v1.14.7+ TODO: per-item preview ("5 tasks → 'Goal X': [task A], [task B], [task C], [task D], [task E]"). Adds ~50 LOC client-side; defer to v1.14.7+ to keep v1.14.6 scope tight.
  - File the trigger: when user feedback shows mis-targeting, OR when bulk-re-parent usage data shows >5% rate of subsequent corrections (re-parent-after-re-parent within 60s window), bind v1.14.7 to land the preview.

**File/line impact.**

  - ADR 014 D18 line 891 (TODO list) updated with R5 v1.14.7+ trigger criteria.
  - No code change in v1.14.6.

---

### R7 (MEDIUM — supersedes ADR 014 D9 line 355 — filter-change-exits-select rationale) — Document explicitly

**Concern (DA P6).** ADR 014 D9 line 355 lists "navigating to a different filter (changing the type or status filter exits select mode and clears selectedIds — different filter = different working set)" as a mode-exit transition. The rationale is correct ("bulk operations across filters are mostly nonsensical") but is not documented in ADR text; future iterations may try to "improve" by preserving selection state across filter changes, breaking this invariant.

**Decision — accept R7 (doc-only); add ADR addendum + KNOWN_ISSUES.md entry (covered by RA1 entry 11).**

**Specification (revised D9 line 355 rationale).**

  - **Filter change exits select mode AND clears `selectedIds`.** Reason: bulk operations across filters are mostly nonsensical (filters partition by status — "active" vs "done" vs "abandoned"; bulk-completing a mix of active + done items is a user error masquerading as a feature).
  - **Predictable mode-exit beats preserved-but-hidden selection state.** If a user selects 10 active tasks, then changes the filter to "done", the 10 active tasks would be hidden from view; if selection were preserved, the user would have no way to see what's selected; bulk operations would fire on invisible items. Predictable: filter change = clean slate.
  - **Re-entering the original filter does NOT restore selection.** Selection is mode-scoped, not filter-scoped.

**File/line impact.**

  - ADR 014 D9 line 355 prose addendum (this revisions doc; +1 paragraph).
  - `KNOWN_ISSUES.md` v1.14.6 entry 11 (covered by RA1).

---

### R8 (MEDIUM — supersedes ADR 014 D16 line 631 — dedup prose tighten) — Always-reset semantics

**Concern (DA P11).** ADR 014 D16 line 631 says: "Listener queues incoming BC messages; if another arrives within 1 second, replace the queued action; only execute after 1 second of silence." The prose is correct in intent but ambiguous: "queue last action; only execute after 1s of silence" could be read as "wait 1s then check queue" (which would NOT collapse a 50-message burst into one refetch — it would fire one refetch every 1s indefinitely as long as messages keep arriving). The implementation pseudocode (line 668-684) IS correct (always-reset on incoming message), but the prose at line 631 should match.

**Decision — accept R8 (doc-only); rewrite D16 prose for clarity.**

**Specification (revised D16 prose).**

  - **Always-reset-on-message semantics.** Each incoming BC message resets the 1s timer.
  - **Burst of 50 in 200ms → 50 timer resets → ONE refetch fired 1s after the LAST message arrived.**
  - The implementation pattern is `clearTimeout(_bcDedupTimer); _bcDedupTimer = setTimeout(...)` on every message — the timer NEVER fires while messages are still arriving; it fires exactly 1s after the LAST message in a burst.
  - Old prose ("queue last action; only execute after 1s of silence") was correct but ambiguous. New prose: "always-reset on incoming message; fire when timer expires."

**File/line impact.**

  - ADR 014 D16 line 631 prose rewrite (this revisions doc; +1 paragraph).
  - No code change (implementation pseudocode at line 668-684 was correct; prose only).

---

### W3 (Anti-Slop W3 — supersedes ADR 014 D1 LOC accounting + D17 — LOC math reconcile)

**Concern (Anti-Slop W3).** ADR 014 D1 LOC accounting (line 56-60) projects trash.ts at ~280 LOC; reviewer verified the actual sum of body+JSDoc moves at ~351 LOC (off by 71). ADR 014 D17 (line 698) says items.create.ts is ~150 LOC; the file plan table at line 908 says ~180 LOC (off by 30 internally; same ADR contradicts itself). storage.ts post-extract: ADR D1 line 57 says "1391 - 70 - 130 - 70 - 16 + 8 + 4 = ~1117"; with W1 binding `ensureTrashDir` STAYS, the math is "1391 - 70 - 130 - 70 + 8 = ~1129" (the −16 + 4 lines no longer apply).

**Decision — accept W3; reconcile LOC math to match implementation reality + W1 binding.**

**Revised LOC accounting (binding for Phase 2).**

  - **trash.ts (NEW):** 70 (listTrashedItems body+JSDoc) + 130 (evictExpiredTrash body+JSDoc) + 70 (restoreItem body+JSDoc) + 35 (findClosestTrashedIds body+JSDoc) + ~30 (header + imports + module-comment) + ~16 (private helpers if needed) = **~351 LOC**. (Brief's ~250 reconciled to ~351; +101 LOC vs original D1 estimate.)
  - **items.create.ts (NEW):** **~180 LOC**. (D17 text said ~150; D1 file plan table said ~180; pick 180 — closer to implementation reality given the auth chain + parentId existence check + projection helper + audit emit.)
  - **storage.ts post-extract:** 1391 HEAD − 70 (listTrashedItems) − 130 (evictExpiredTrash) − 70 (restoreItem) + 8 (parseItemFileFromRaw export wrapper) = **~1129 LOC**. (Per W1: `ensureTrashDir` stays; no removal; no import-line-from-trash needed.)
  - **commands/organize.ts post-extract:** 758 HEAD − 35 (findClosestTrashedIds + JSDoc) − 2 (readdir import line if no other use) + 1 (import findClosestTrashedIds from trash.ts) = **~722 LOC** (unchanged from D1).

**File/line impact.**

  - ADR 014 D1 LOC accounting prose addendum (this revisions doc; supersedes lines 56-60).
  - ADR 014 D17 LOC stated prose addendum (this revisions doc; supersedes line 698; pick 180 LOC).
  - File plan table at line 900-924 reconciled (storage.ts post-extract: 1117 → 1129; trash.ts 280 → 351; items.create.ts row already 180).

---

### W4 (Anti-Slop W4 — supersedes ADR 014 D8.a — NUL-byte retrofit scope)

**Concern (Anti-Slop W4).** ADR 014 D8.a (line 271) says: "v1.14.6 adds the NUL-byte check to BOTH the new validateCreateBody AND retrofits it to validatePatchBody for consistency." The text is ambiguous about scope: does "NUL-byte check" apply to title only? Or also tags / notes / progress? Anti-Slop W4 asks for explicit scope binding.

**Decision — accept W4; clarify scope explicitly.**

**Specification (revised D8.a scope binding).**

  - **Title:** gets NUL ban via NEW `TITLE_INVALID_CHARS` validator code. Applied to BOTH `validateCreateBody` AND `validatePatchBody` (D8.a retrofit). Reason: titles are user-displayed text; NUL byte renders as garbled in many contexts and is a known SQLite-FTS edge.
  - **Tags:** do NOT need retrofit. `TAG_RE` `^[a-z0-9-]+$` already excludes NUL byte by character class. The existing `TAG_INVALID_CHARS` code catches it. Verified at validation.ts.
  - **Notes:** already has NUL ban from v1.14.3 D2 fix 4 (`NOTES_INVALID_CHARS` code). No retrofit needed.
  - **Progress:** already has NUL ban from v1.14.3 D2 fix 4 (`PROGRESS_INVALID_CHARS` code). No retrofit needed.

**Tests required (Phase 2).** Add to `tests/unit/organize.validation.test.ts`:

  1. **Test W4-1 (validateCreateBody title NUL byte rejected):** call validateCreateBody with title = "hello\0world"; assert `{ok: false, code: 'TITLE_INVALID_CHARS'}`.
  2. **Test W4-2 (validatePatchBody title NUL byte rejected — D8.a retrofit):** call validatePatchBody with title = "hello\0world"; assert `{ok: false, code: 'TITLE_INVALID_CHARS'}`. (Already specified in ADR 014 D14 §B test 35; bind explicitly.)

**File/line impact.**

  - `src/organize/validation.ts` — `validatePatchBody` gains 2-LOC NUL check on title; `validateCreateBody` includes NUL check on title from inception. ~5 LOC.
  - `tests/unit/organize.validation.test.ts` — +1 test for the validatePatchBody retrofit (W4-2; already counted in D14 §B test 35; binding clarified).

---

### W5 (Anti-Slop W5 — supersedes ADR 014 D15 — visibility-change race test for create submission)

**Concern (Anti-Slop W5).** ADR 014 P3 (CP1 surface section, line 1025-1026) acknowledges the visibility-change race risk for handleCreateSubmit: "btn.disabled + the in-flight flag should hold across foreground/background — neither resets. … Test for it (T-79 covers single-thread; add T-79a for visibility-change interleaving)." T-79a is mentioned but not bound in the test plan (D14 §G section line 1001-1009).

**Decision — accept W5; bind T-79a in the test plan.**

**Specification (added test).**

  - **T-79a (visibility-change race during create submission):** Mock fetch with a Promise that resolves at 5000ms; tap Create; immediately fire `document.dispatchEvent(new Event('visibilitychange'))` with `document.visibilityState = 'hidden'`; advance fake timers to 1000ms; assert `_createSubmitInFlight === true` (not reset by visibility change); assert button still disabled. Resolve fetch; assert finally clause fires; assert `_createSubmitInFlight === false`; assert button re-enabled.
  - This test verifies the in-flight flag and button state are NOT reset by visibility-change events; only by the fetch promise resolving / rejecting / aborting.

**File/line impact.**

  - `tests/public/webapp/organize.create-form.test.ts` — +1 test (T-79a; ~25 LOC).

---

### W6 (Anti-Slop W6 — supersedes ADR 014 D6 line 226-228 — mountItemsCreateRoutes wire integrity test)

**Concern (Anti-Slop W6).** ADR 014 D6 line 226-228 specifies that `mountItemsCreateRoutes` is wired in `src/webapp/itemsRoute.ts` after `mountItemsCompleteRoutes`. Test count line 228 says "+1 mount-integrity check (T-create-1)" but the test plan (D14 §C) does not have a dedicated mount-integrity test — only end-to-end behavior tests that incidentally exercise the route. Anti-Slop W6 asks for an explicit mount-integrity test mirroring v1.14.5 R3 Test R3-1.

**Decision — accept W6; bind T-mount-create explicitly.**

**Specification (added test).**

  - **T-mount-create (wire integrity for the new mountItemsCreateRoutes):** boot the test server with all FOUR mount calls (`mountItemsReadRoutes`, `mountItemsMutateRoutes`, `mountItemsCompleteRoutes`, `mountItemsCreateRoutes`); verify all routes respond:
    - GET `/api/webapp/items` → 200 (read).
    - PATCH `/api/webapp/items/:id` → 200 (mutate).
    - DELETE `/api/webapp/items/:id` → 200 (mutate).
    - POST `/api/webapp/items/:id/complete` → 200 (complete).
    - POST `/api/webapp/items` → 201 (create — NEW).
  - This test verifies the wiring is intact AND no route shadowing exists (e.g., POST `/api/webapp/items` does not accidentally match a prior route).

**File/line impact.**

  - `tests/integration/webapp.organize.create.test.ts` — +1 test (T-mount-create; ~30 LOC). Counted in D14 §C test 36 baseline; binding clarified.

---

## Pushback / disagreements with reviewers

**R3 (HIGH) — DA suggested splitting v1.14.6 into v1.14.6 (trash + create) + v1.14.7 (bulk). Anti-Slop more measured (no recommendation either way; verified the scope matches v1.14.5 P1 rigor; doesn't degrade).**

**Architect's position: keep full scope. R3 declined.**

**Justification.**

  1. **The architect's seams are clear.** trash.ts mechanical extraction is commit-1 (no logic change; ZERO test logic changes; tests update import paths only). items.create.ts is module-isolated (~180 LOC; symmetric with items.complete.ts; auth chain + parentId check + audit emit). Bulk operates on EXISTING PATCH/DELETE/POST endpoints with per-item independence — server unchanged. Each piece is self-contained; no cross-piece dependencies that would block parallel Phase 2 dev.
  2. **v1.14.5 also had three sub-features** (parentId + trash list + BroadcastChannel) and shipped cleanly with 2111 tests passing across the iteration. v1.14.6 is comparable in scope: trash.ts extraction (mechanical) + bulk (client-side; server unchanged) + create form (one new endpoint + one new validator + UI). The server surface is smaller than v1.14.5 (1 new endpoint vs v1.14.5's 0 new endpoints + 3 mutations to existing handlers + chat-side parser); the client surface is larger (multi-select state machine + create form + bulk dispatcher). Net: comparable rigor.
  3. **Splitting adds an extra full /iterate cycle** — meaningful agent + wall-clock cost. /iterate runs Phase 1 (ADR) + CP1 (DA + Anti-Slop) + Phase 2 (Dev-A + Dev-B) + Phase 2 reviewers (Anti-Slop + Scalability + QA) + fix loop + deterministic gates. Splitting v1.14.6 into v1.14.6+v1.14.7 doubles that. Not free.
  4. **The user has explicitly asked for full-feature momentum.** User's auto-memory: "subscription not per-token; don't under-scope task lists or throttle effort. Execute approved full scope with best judgment." Splitting against this preference without strong evidence (DA's case is "smells over-scoped" — speculative, not data-backed) is misaligned.
  5. **Quality gates are the same regardless of scope.** If Phase 2 reviewers find the iteration under-baked, the fix loop catches; if scope is too large, Phase 2 stalls — but the architect's per-file LOC estimates are conservative (W3 reconcile only added ~71 LOC for trash.ts; items.create.ts pegged at 180 LOC, not 150). The 7 deterministic gates (tsc, eslint, npm audit, gitleaks, semgrep, injection-defense, logging-standard) are the same whether v1.14.6 ships 1 feature or 3.
  6. **DA + Anti-Slop signal-divergence on this point.** DA says "split"; Anti-Slop says "matches v1.14.5 P1 rigor; doesn't improve." When two reviewers diverge on a structural question, the architect's call carries (per CP1 protocol). The convergence signals (R1 + W2) DID drive a binding (verb-asymmetric If-Match); R3's lack of convergence weakens the case.

**v1.14.6 ships full scope: trash.ts extraction + multi-select bulk actions + create-new-item form. R3 declined.**

---

## File-impact summary table for Phase 2

| File | Change | Driver | LOC delta (post-revisions) |
|---|---|---|---:|
| `src/organize/storage.ts` | EXTRACT trash code → trash.ts (W1: ensureTrashDir STAYS); ADD parseItemFileFromRaw wrapper export; ADD optional progress to CreateItemInput (D8.b) | D1 + W1 + W3 | **−262** (1391 → ~1129) |
| `src/organize/trash.ts` (NEW) | NEW (4 functions extracted; one-way `trash.ts → storage.ts` edge) | D1 + W1 + W3 | **+351** |
| `src/organize/trashEvictor.ts` | UPDATE import: `evictExpiredTrash` from `./trash.js` | D1 | 0 |
| `src/commands/organize.ts` | EXTRACT findClosestTrashedIds → trash.ts; UPDATE imports | D1 | **−36** |
| `src/organize/validation.ts` | ADD validateCreateBody + AllowedCreate type + CreateValidatorErrorCode union; ADD NUL-byte check to TITLE in validatePatchBody (D8.a; W4 scope clarified — title only) | D8 + W4 | **+175** |
| `src/webapp/items.create.ts` (NEW) | NEW (POST /api/webapp/items handler + mountItemsCreateRoutes) | D17 + W3 (180 LOC pegged) | **+180** |
| `src/webapp/items.shared.ts` | ADD auditItemCreate helper; ADD WebappItemCreateDetail interface | D7 | **+52** |
| `src/webapp/itemsRoute.ts` | ADD `import { mountItemsCreateRoutes }` + call site | D6 | **+3** |
| `public/webapp/organize/app.js` | Multi-select + bulk dispatcher + create form + BC dedup + verb-asymmetric If-Match (R1) + typed-confirm (R2) + AbortController (R6) + mutual exclusion (R9) + constants (RA1) | D9-D16 + R1 + R2 + R6 + R9 | **+420** (365 baseline + 10 R1 + 25 R2 + 15 R6 + 15 R9 minus overlaps) |
| `public/webapp/organize/index.html` | ADD "Select" + "+ New" buttons; ADD `<section id="create-form">` + `<div id="bulk-toolbar">` + typed-confirm `<input>` (R2) | D10 + D13 + R2 | **+72** (69 baseline + 3 R2) |
| `public/webapp/organize/styles.css` | ADD `.select-checkbox`, `.bulk-toolbar`, `.create-form`, `.type-pill`, typed-confirm input styling (R2) | D11 + D14 + R2 | **+130** (120 baseline + 10 R2) |
| `tests/unit/organize.trash.test.ts` (NEW) | RELOCATED from organize.storage.test.ts | D1 | **+410** |
| `tests/unit/organize.storage.test.ts` | REMOVE relocated tests | D1 | **−410** |
| `tests/unit/organize.validation.test.ts` | ADD validateCreateBody tests (~25 cases) + W4 retrofit test | D14 §B + W4 | **+250** |
| `tests/integration/webapp.organize.create.test.ts` (NEW) | end-to-end + T-mount-create (W6) | D14 §C + W6 | **+510** (480 baseline + 30 W6) |
| `tests/integration/webapp.organize.bulk.test.ts` (NEW) | bulk dispatcher unit tests + R1-1 to R1-5 verb-asymmetric If-Match | D14 §D + R1 | **+360** (280 baseline + 80 R1) |
| `tests/public/webapp/organize.multiselect.test.ts` (NEW) | multi-select tests + R2-1 to R2-4 typed-confirm + R9-1, R9-2 mutual exclusion | D14 §E + R2 + R9 | **+440** (340 baseline + 60 R2 + 25 R9 minus overlap; R9-1/2 in this file; R9-3/4 in create-form file) |
| `tests/public/webapp/organize.bc-dedup.test.ts` (NEW) | D16 dedup tests | D14 §F | **+100** |
| `tests/public/webapp/organize.create-form.test.ts` (NEW) | D14/D15 form tests + R6-1, R6-2 timeout + W5 visibility race + R9-3, R9-4 mutual exclusion | D14 §G + R6 + W5 + R9 | **+300** (220 baseline + 30 R6 + 25 W5 + 25 R9 minus overlap) |
| `D:\ai-jarvis\KNOWN_ISSUES.md` | 11 v1.14.6 entries | RA1 | **+80** |
| `D:\ai-jarvis\CLAUDE.md` | 4 v1.14.6 invariants | RA1 | **+16** |
| `docs/CHANGELOG.md` | v1.14.6 entry (Phase 5) | unchanged from ADR 014 | +30 |
| `package.json` | Version bump 1.14.5 → 1.14.6 | unchanged | +1 |

**Estimated total LOC delta vs ADR 014 baseline:**

  - **ADR 014 baseline (architect's projection):** ~1,005 source / ~1,670 tests = ~2,675 total.
  - **Post-revisions projection:** source ≈ 1,085 (W3 trash.ts 280→351 = +71; W1 storage.ts saves +12; R1 client +10; R2 client +25 + HTML +3 + CSS +10 = +38; R6 +15; R9 +15; W4 +5; minor net offsets); tests ≈ 1,925 (R1 +80; R2 +60; R6 +30; R9 +50 split between two files; W4 +0 baseline already counted; W5 +25; W6 +30); docs +96 (RA1 80+16); CHANGELOG +30; version +1.
  - **Net:** **~3,137 total LOC delta** (~1,085 source / ~1,925 tests / ~127 docs+misc), an increase of ~462 LOC over the ADR 014 baseline. The split-iteration-decline (R3 declined) carries 0 LOC of split-cost; the rest is added test rigor (R1 verb-asymmetric If-Match coverage; R2 typed-confirm coverage; R6 timeout; W5 visibility race; W6 mount integrity), R1's BLOCKING contract, R2's HIGH UX feature, R6's HIGH iOS hardening, R9's UX hygiene, and W3's LOC reconcile.
  - **Test ratio:** ~61% (1,925 / (1,085 + 1,925)). Healthy; matches ADR 014's projected 62%.

**Source code (non-test) LOC delta:** ~1,085. Of this, ~530 is server-side (storage extract + validation + handlers + commands + items.create.ts + items.shared.ts) and ~555 is client-side (HTML + CSS + JS); ~127 is docs.

**Test count revision (post-revisions): D14 baseline 80 tests + R1 +5 + R2 +4 + R6 +2 + R9 +4 + W4 +0 (already counted) + W5 +1 + W6 +0 (already counted as T-create-1 baseline; binding clarified) = ~96 tests.** Phase 2 binding: 96 tests is the new target.

---

## Final R-list ordered by file impact

| # | Severity | Resolution | Primary file impact | LOC |
|---|---|---|---|---|
| **R1 + W2** | BLOCKING (convergent) | Accept (verb-asymmetric If-Match contract) | `app.js` bulk dispatchers (+10) + tests (+80) | **+90** |
| **W1** | Anti-Slop W1 | Accept (ensureTrashDir STAYS in storage.ts; one-way trash.ts → storage.ts edge) | `storage.ts` (+12 vs original D1 estimate) + ADR doc binding | **+12** |
| **RA1** | Required Action | Accept (11 KI + 4 CLAUDE.md) | `KNOWN_ISSUES.md` (+80) + `CLAUDE.md` (+16) | **+96** |
| **R2** | HIGH | Accept (typed-confirm at >50; constant) | `app.js` (+25) + `index.html` (+3) + `styles.css` (+10) + tests (+60) | **+98** |
| **R6** | MEDIUM | Accept (AbortController + 30s timeout) | `app.js` (+15) + tests (+30) | **+45** |
| **R9** | MEDIUM | Accept (mutual exclusion select-mode vs create-form) | `app.js` (+15) + tests (+50) | **+65** |
| **W3** | Anti-Slop W3 | Accept (LOC math reconcile) | ADR D1/D17 prose; storage.ts/trash.ts/items.create.ts LOC pegged | doc-only |
| **W5** | Anti-Slop W5 | Accept (visibility-change race test T-79a) | `tests/public/webapp/organize.create-form.test.ts` (+25) | **+25** |
| **W6** | Anti-Slop W6 | Accept (T-mount-create wire integrity) | `tests/integration/webapp.organize.create.test.ts` (+30) | **+30** |
| **W4** | Anti-Slop W4 | Accept (NUL-byte retrofit scope clarified — title only) | `validation.ts` (+5; already in D8.a) + tests (+0; already in D14 §B 35) | **+5** |
| **R8** | MEDIUM | Accept (doc-only — D16 always-reset prose tighten) | ADR D16 prose | doc-only |
| **R7** | MEDIUM | Accept (doc-only — D9 filter-change rationale) | ADR D9 prose + RA1 KI entry 11 | doc-only |
| **R4** | MEDIUM | Accept (doc-only — D3/D16 interaction) | ADR D16 prose + RA1 KI entry 4 | doc-only |
| **R5** | MEDIUM | Accept (defer to v1.14.7+; trigger filed) | ADR D18 TODO update | 0 |
| **R3** | HIGH | **DECLINED with justification** (full scope keeps; see Pushback section) | (no change) | 0 |

**Phase 2 first-commit ordering (binding):**

  1. W1 + D1 trash.ts extraction (commit 1; mechanical; no logic change; ZERO test logic changes; W3 LOC reconcile applied).
  2. D6 + D7 + D8 + D17 + W3 + W4 items.create.ts module + validateCreateBody + auditItemCreate (commit 2; server-side create endpoint).
  3. D9-D11 multi-select state + card transformation (commit 3; client-side select mode).
  4. D3 + D4 + D12 + R1 + R2 bulk dispatcher + verb-asymmetric If-Match + typed-confirm + partial-failure UX (commit 4; client-side bulk).
  5. D13-D15 + R6 + R9 create form + handleCreateSubmit + AbortController + mutual exclusion (commit 5; client-side create UI).
  6. D16 + R4 + R8 BroadcastChannel dedup + always-reset prose (commit 6; client-side dedup).
  7. Test rigor adds (commit 7; R1-1 to R1-5 + R2-1 to R2-4 + R6-1/R6-2 + R9-1 to R9-4 + W4-1/W4-2 + W5 T-79a + W6 T-mount-create + the 80 baseline tests).
  8. RA1 docs (commit 8; KNOWN_ISSUES.md + CLAUDE.md additions).
  9. R5 + R7 + R8 ADR addenda + CHANGELOG + version bump (commit 9; ship).

End of revisions document for v1.14.6 CP1.
