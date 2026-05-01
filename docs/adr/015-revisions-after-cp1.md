# ADR 015 — Revisions after CP1 debate (2026-04-25)

**Parent:** `015-v1.15.0-kanban-calendar.md`
**Status:** Accepted. Folded into ADR 015 by reference. Phase 2 dev agents implement the revised spec; deviations require another addendum.

**Context.** Devil's Advocate review (`docs/reviews/cp1-devils-advocate-v1.15.0.md`) raised 1 BLOCKING + 2 HIGH + 6 MEDIUM + 7 OK with 10 numbered R-revisions (R1–R10). Anti-Slop Phase 1 review (`docs/reviews/anti-slop-phase1-review-v1.15.0.md`) raised 0 Required Actions (D15 enumeration pre-empted RA1) + 6 warnings (W1–W6) + 2 cosmetic (F1, F2). **Convergence signal:** DA P15/R1 (BLOCKING — app.js LOC accounting drift) is convergent with Anti-Slop §13 file-size posture; Anti-Slop verified app.js-projection at line ~2036 against the architect's 600-LOC tolerated threshold and noted "tolerated as app shell," but DA verified the actual HEAD at **2727 LOC** (not the 1786 LOC the ADR claimed). The 1786 figure was the pre-v1.14.6 baseline, not the post-ship state. With v1.15.0 work layered on, projection is ~2977 LOC — **the architect's own v1.16.0+ split trigger fires NOW**. Two reviewers + same finding from different angles = strong signal; this is the BLOCKING.

The architect resolves the BLOCKING (R1) with **mechanical pre-extraction of `list-view.js` + `edit-form.js` as Phase 2 commits 0a + 0b BEFORE the kanban/calendar work**. Zero logic change; pure relocation of well-bounded subsystems. Post-extraction app.js drops to ~1727 LOC; v1.15.0 view-switcher additions land it at ~1977 LOC — under 2000. The v1.16.0+ split trigger is also lowered from 2500 to 2000 LOC to reflect the architect's revised tolerance. Accepts both HIGH (R2 toast contract bound; R3 active-drag rollback cancellation contract bound), accepts every MEDIUM (R4 doc-only DnD test scope; R5 chat-side `/organize` parser regression test; R6 cross-month 412 rollback recovery UX; R7 strict-equal binding + 6 injection-probe tests; R8 full re-render on rollback to handle filter drift; R9 doc-only refresh-detail-state v1.16.0+ candidate; R10 KI #11 + #12 + CLAUDE.md invariant 4 — enumeration grows from 10 KI + 3 CLAUDE.md to 12 KI + 4 CLAUDE.md), accepts every Anti-Slop warning (W1 closes via R2; W2 ISO_DATE_RE + ISO_DATE_FORMAT constants in dates.js; W3 top-of-file JSDoc rationale block; W4 KI entry 8 enforcement strategy expanded; W5 closes via R1 commit ordering; W6 concurrent drag rollback test bound; F1 positive bind on absence of audit imports in config.ts).

The BLOCKING (R1 — app.js LOC threshold fires NOW with current numbers) MUST land in v1.15.0 BEFORE the kanban/calendar work. Non-negotiable. Verified: `wc -l public/webapp/organize/app.js` = 2727 (DA confirmed the math). Pre-extraction is mechanical (commits 0a + 0b are zero-logic-change relocations); the kanban/calendar work proceeds on the cleaner ~1727 LOC baseline.

This revisions document supersedes the relevant clauses of ADR 015 by reference; the parent ADR is not edited.

---

## Resolved (R-numbered, ordered by file impact for Phase 2)

### R1 (BLOCKING — supersedes ADR 015 D11 line 381 + line 431 + file plan line 560 + LOC accounting line 580) — Pre-extract list-view.js + edit-form.js as commits 0a + 0b

**Concern (DA P15/R1).** ADR 015 D11 line 381 says: "Current state (v1.14.6 ship): `public/webapp/organize/app.js` ≈ 1786 LOC." DA verified actual HEAD = **2727 LOC**. The 1786 figure was the pre-v1.14.6 baseline; the v1.14.6 R-revisions + multi-select state machine + bulk dispatcher + create form + verb-asymmetric If-Match + AbortController + typed-confirm + mutual exclusion ALL landed in app.js, growing it to 2727 LOC. ADR 015 D11's "partial-split keeping list/edit/detail/create in app.js while only extracting kanban-view.js + calendar-view.js + dates.js" defense was built on a 1786-LOC baseline that no longer exists. Recompute: 2727 (current) + 250 (v1.15.0 additions to app.js — view-switcher state machine + DnD coordinator + boot config fetch + detail-panel scaffolding) = **~2977 LOC**, not the 2036 the ADR projects.

**Architect's own v1.16.0+ trigger fires NOW.** D11 line 431 says: "If `app.js` crosses 2500 LOC OR a new mutation surface lands → file A full-split." Both conditions are met: (a) crosses 2500 by 477 LOC; (b) v1.15.0 adds new mutation surfaces (DnD-driven PATCH `parentId` for kanban; DnD-driven PATCH `due` for calendar). The architect's defense doesn't scale by 50%.

**Decision — pre-extract list-view.js + edit-form.js as Phase 2 commits 0a + 0b BEFORE the kanban/calendar work; mechanical zero-logic-change relocation; lower v1.16.0+ trigger from 2500 to 2000 LOC.**

Both subsystems are well-bounded inside the current app.js, with clean import seams to the rest of the file. The extractions are no riskier than D10's `_internals.ts` mechanical extraction; they ship the same way (commit-1 mechanical first, then dependent work).

**Commit 0a — `public/webapp/organize/list-view.js` (~600 LOC).**

  - **Contains:** `renderList`, item card construction (item-card-render helpers), hierarchy grouping integration (consumes `groupByParent` from `hierarchy.js` already), complete checkbox handlers + animations, multi-select rendering (the per-card `.select-checkbox` + `data-selected` state from v1.14.6 D9-D11 — the rendering layer; the multi-select state machine STAYS in app.js since it's cross-view per D8 mode-exit-on-view-switch).
  - **Imports:** `groupByParent` from `./hierarchy.js`; `formatDueLabel` from `./dates.js` (NEW in v1.15.0 D2 — list view also displays due dates); `escapeHTML` (or textContent helpers) from `./shared-helpers.js` (or inline; same pattern as kanban-view.js per ADR 015 D11).
  - **Exports:** `renderList(container, renderedItems, callbacks, state)` where `callbacks` carries `onSelect`, `onComplete`, `onEnterEdit`, `onEnterDetail` and `state` carries `multiSelectMode`, `selectedIds`, `currentFilter`. Callbacks-down events-up; no app.js imports inside list-view.js.
  - **Mechanical guarantee:** ZERO logic changes. All branches preserved. Bug-for-bug compatible. Tests in `tests/public/webapp/organize.list-view.test.ts` (relocated from existing `organize.list.test.ts` if present, or NEW; ~50 tests; same expectations).

**Commit 0b — `public/webapp/organize/edit-form.js` (~400 LOC).**

  - **Contains:** `enterEditMode`, `exitEditMode`, `submitEdit`, `cancelEdit`, parent picker UI rendering (the `<select>` builder + tier filtering from ADR 013 D5), char counters (title 200, notes 5000, progress 5000 — from ADR 011 D2), 412 conflict UI rendering (the conflict banner reuse from ADR 012 R1).
  - **Imports:** `validatePatchBody` (server-side validator wrapper not imported here — client-side preflight is in app.js's submit path); textContent helpers; `If-Match` ETag retrieval helper (from app.js's `renderedItems[]`). The form receives the item and the ETag via function args; it does NOT reach into app.js global state.
  - **Exports:** `enterEditMode(container, item, etag, callbacks)` where `callbacks` carries `onSubmit(patchBody, etag, options)`, `onCancel`, `onConflict(currentItem)`. App.js-side handler glues to the existing PATCH dispatcher.
  - **Mechanical guarantee:** ZERO logic changes. All edge cases (Save Anyway path; conflict banner; char-counter UI) preserved. Tests in `tests/public/webapp/organize.edit-form.test.ts` (relocated; ~30 tests; same expectations).

**LOC accounting (binding for Phase 2).**

  - app.js HEAD = **2727 LOC** (verified).
  - After commit 0a (list-view.js extracted): app.js ≈ **2127 LOC** (−600).
  - After commit 0b (edit-form.js extracted): app.js ≈ **1727 LOC** (−400).
  - After v1.15.0 commits 1-N (kanban/calendar/dates/_internals/config landing in their respective new files; app.js gains ~250 LOC for the view-switcher state machine + DnD coordinator entry points + boot config fetch + detail-panel scaffolding): app.js ≈ **1977 LOC**.
  - Below 2000. Below the revised v1.16.0+ trigger.

**Revised v1.16.0+ split trigger.** D11 line 431 supersedes:

  - Old: "If `app.js` crosses 2500 LOC OR a new mutation surface lands → file A full-split."
  - New: "If `app.js` crosses **2000 LOC** OR a new mutation surface lands without a corresponding extraction → file A full-split. v1.16.0+ candidates: detail-panel.js extraction (~200 LOC); create-form.js extraction (~250 LOC); view-switcher.js extraction (~150 LOC). Triggered when any of: (a) app.js crosses 2000 LOC; (b) Anti-Slop §13 reviewer flags app.js as the single largest file in webapp by ≥2x; (c) two consecutive iterations have added ≥150 LOC each to app.js."

**Phase 2 commit ordering (binding).**

  1. **Commit 0a:** list-view.js extraction (mechanical; no logic change; ZERO test logic changes — only import paths update).
  2. **Commit 0b:** edit-form.js extraction (mechanical; no logic change).
  3. **Commit 1:** D10 `_internals.ts` extraction (mechanical; closes v1.14.6 P2 F4 + Scalability WARNING-1.14.6.A).
  4. **Commit 2:** dates.js standalone (no callers yet; pure-function tests run; W2 + W3 binding lands).
  5. **Commit 3:** kanban-view.js standalone (callable but not yet imported by app.js; R2 toast renderer included; R3 cancelPendingRollback helper included).
  6. **Commit 4:** calendar-view.js standalone (R6 cross-month 412 recovery UX included).
  7. **Commit 5:** `src/webapp/config.ts` + gateway `botUsername` threading + `WebappConfigDeps` (D9; F1 positive-bind on no-audit-imports).
  8. **Commit 6:** app.js view-switcher state machine + boot config fetch + view-module integration + multi-select-exits-on-view-switch (D8) + detail-panel overlay; R7 strict-equal binding + 6 injection-probe tests; R8 full re-render on rollback.
  9. **Commit 7:** HTML view containers + view-switcher buttons + subview chips; CSS additions (kanban + calendar + DnD visuals + rollback animation keyframes; F2 LOC sub-total reconcile per Phase 2 reality).
  10. **Commit 8:** Test files in lockstep (R5 calendar timezone regression test; R6 cross-month UX tests; R7 injection probes; W6 concurrent drag rollback test).
  11. **Commit 9:** R10 KNOWN_ISSUES.md + CLAUDE.md additions (12 KI + 4 invariants).
  12. **Commit 10:** CHANGELOG + version bump 1.14.6 → 1.15.0; ship.

**Tests required (Phase 2).**

  1. **Test R1-1 (list-view.js mechanical extraction):** All existing list-view tests pass UNCHANGED after relocation; coverage measure confirms ≥ pre-extraction.
  2. **Test R1-2 (edit-form.js mechanical extraction):** All existing edit-form tests pass UNCHANGED after relocation; coverage measure confirms ≥ pre-extraction.
  3. **Test R1-3 (no circular imports post-extraction):** `madge` or equivalent dependency-graph tool confirms zero cycles between list-view.js, edit-form.js, kanban-view.js, calendar-view.js, dates.js, hierarchy.js, app.js.

**File/line impact.**

  - `public/webapp/organize/app.js` — net **−1000 LOC** (2727 → 1727 after commits 0a + 0b; then +250 for v1.15.0 work → 1977).
  - `public/webapp/organize/list-view.js` (NEW) — **+600 LOC** (mechanical relocation).
  - `public/webapp/organize/edit-form.js` (NEW) — **+400 LOC** (mechanical relocation).
  - `tests/public/webapp/organize.list-view.test.ts` (NEW or relocated) — ~50 tests; ~600 LOC test code (relocated from existing).
  - `tests/public/webapp/organize.edit-form.test.ts` (NEW or relocated) — ~30 tests; ~400 LOC test code (relocated from existing).
  - ADR 015 D11 line 381 prose updated: starting LOC 1786 → 2727; post-extraction projection 2036 → 1977; v1.16.0+ trigger 2500 → 2000.

---

### R2 (HIGH — supersedes ADR 015 D1 + CP1 surface row 1 + closes Anti-Slop W1) — Bind onboarding toast contract

**Concern (DA P1 + Anti-Slop W1 convergent).** ADR 015 D1.a binds the "⋮⋮" handle as the explicit pickup affordance (matching Material/iOS drag-handle conventions). CP1 surface row 1 line 624 mentions "Onboarding mention in v1.15.0 changelog + a one-time toast on first kanban entry" — but the toast is NOT bound in D1, NOT in the file plan, NOT in the test plan. Anti-Slop W1 raised the same finding from a doc-clarity angle: sessionStorage key + dismissal contract NOT specified. Phase 2 dev would have to invent both.

**Decision — bind D1.d toast contract explicitly.**

**D1.d — First-entry kanban onboarding toast.**

  - **Trigger:** First time the user opens the kanban view in a session (the user navigates list → kanban; AND the sessionStorage key is unset).
  - **sessionStorage key:** `organize-kanban-tutorial-seen` (per-tab session; matches v1.14.5 `organize-mutations-pending` + v1.15.0 D7 `organize-view-state-v1` sessionStorage precedent — NOT localStorage; the tutorial is per-session muscle-memory, not once-ever-per-browser).
  - **Toast text:** "Tap a task card to pick it up, then tap a goal column to drop it." (literal binding — Phase 2 dev does not paraphrase).
  - **Auto-dismiss:** 8 seconds (`KANBAN_TUTORIAL_TOAST_MS = 8000`) OR tap to dismiss (whichever comes first).
  - **sessionStorage write:** Sets `'1'` on first show (`'1'` for compactness; whitelist injection-probe defaults to "show toast" on any value other than `'1'`).
  - **Subsequent kanban entries in same session:** Skip toast (sessionStorage key === `'1'`).
  - **Cross-session:** sessionStorage clears on tab close → next-session first kanban entry shows toast again. This is the deliberate posture (re-onboard returning users; matches v1.14.5 sessionStorage pattern).

**Constants (per D15 wire-constant discipline + R10 KI #11).**

```javascript
// public/webapp/organize/kanban-view.js — top-of-file constant block
const KANBAN_TUTORIAL_KEY = 'organize-kanban-tutorial-seen';  // R2 (HIGH from CP1 v1.15.0):
                                                                // sessionStorage key for first-entry kanban toast.
                                                                // Per-tab; resets on tab close.
const KANBAN_TUTORIAL_TOAST_MS = 8000;                          // 8s auto-dismiss; tap-to-dismiss also works.
const KANBAN_TUTORIAL_TEXT =
  'Tap a task card to pick it up, then tap a goal column to drop it.';
```

**Pseudocode (specification).**

```javascript
function maybeShowKanbanTutorial(toastEl) {
  let raw = null;
  try { raw = sessionStorage.getItem(KANBAN_TUTORIAL_KEY); } catch (_) { /* private mode */ }
  if (raw === '1') return;  // strict equality; injection probe defaults to show
  showToast(toastEl, KANBAN_TUTORIAL_TEXT, KANBAN_TUTORIAL_TOAST_MS);
  try { sessionStorage.setItem(KANBAN_TUTORIAL_KEY, '1'); } catch (_) { /* private mode */ }
}

// Called from kanban-view.js render entry:
function renderKanban(container, items, callbacks, state) {
  // ... existing render ...
  maybeShowKanbanTutorial(state.toastEl);
}
```

**Tests required (Phase 2).** Add to `tests/public/webapp/organize.kanban-view.test.ts`:

  1. **Test R2-1 (first kanban entry shows toast):** Boot with empty sessionStorage; navigate to kanban; assert toast renders with literal text; assert sessionStorage key set to `'1'`.
  2. **Test R2-2 (second entry in same session does NOT re-show):** sessionStorage seeded with `'1'`; navigate to kanban; assert toast does NOT render.
  3. **Test R2-3 (tap-to-dismiss works):** First entry; toast renders; tap toast; assert toast hidden BEFORE 8000ms timer fires.
  4. **Test R2-4 (auto-dismiss at 8000ms):** First entry; advance fake timers to 8000ms; assert toast hidden.
  5. **Test R2-5 (injection probe defaults to show):** sessionStorage seeded with `'__proto__'` / `'true'` / `'yes'` / `''`; navigate to kanban; assert toast renders for each (only `'1'` suppresses).

**File/line impact.**

  - `public/webapp/organize/kanban-view.js` — `maybeShowKanbanTutorial` helper; constants block. ~25 LOC.
  - `public/webapp/organize/styles.css` — toast positioning + animation reuses v1.14.6 `TOAST_DEFAULT_MS` styles. ~5 LOC variant.
  - `tests/public/webapp/organize.kanban-view.test.ts` — +5 tests (R2-1 to R2-5; ~80 LOC).
  - ADR 015 D1 prose updated to bind D1.d (this addendum supersedes lines 46-71 to add D1.d sub-decision).

---

### R3 (HIGH — supersedes ADR 015 D12 line 439-459 + Risk row 4) — Bind active-drag rollback cancellation contract

**Concern (DA P3).** ADR 015 D12 binds the optimistic DnD sequence (capture → visually move → PATCH → 200/412/4xx/5xx/network-error paths) and Risk row 4 acknowledges concurrent drags on the SAME card (math is consistent — rollback of first reverses to original; rollback of second reverses to first-target). But D12 does NOT specify the **rollback-during-active-pickup** case: user tap-picks card A in column X (200ms PATCH in flight); user tap-picks card B in column X (entering pickup state); 412 returns on card A; rollback animation begins on card A; user has a DIFFERENT card B in active pickup state. D12 line 450 ("tap-pick-tap-drop is single-card by construction") is true for the PICK; it's false for the in-flight-retry path during which a second pick can begin on a DIFFERENT card.

Two reasonable answers were left unbound: (a) queue the rollback animation until the active pickup completes; (b) abort the active pickup and let the rollback complete first; (c) cancel the rollback animation; new pickup proceeds normally. The architect picks **(c)** — UX simplicity beats animation correctness when they conflict; new pickup always wins.

**Decision — bind D12.b active-drag rollback cancellation contract.**

**D12.b — Rollback cancellation during active pickup.**

  - During an in-flight rollback animation (200ms CSS transition; the architect's existing D12 binding), if the user picks up another card (any card, same or different):
    - **The new pickup IMMEDIATELY cancels the rollback animation.** No visual interruption mid-bounce.
    - The rolled-back card snaps to its source position (no animation; just position state — the source position was captured at D12 step 1 and is still in `_pendingRollback.sourcePosition`).
    - The new pickup proceeds normally (enters "selected for move" state; user drops; PATCH fires; etc.).
  - State maintained: `_pendingRollback = { itemId, sourceColumn, sourceCellDate, sourceIndex, animationFrameId } | null`. Reset to `null` when:
    - The rollback animation completes naturally (200ms timer fires).
    - A new pickup starts (`tap-pick` handler clears it via `cancelPendingRollback()`).
    - The user navigates away from the kanban view (D8 view-switch hook).

**Pseudocode (specification).**

```javascript
// public/webapp/organize/kanban-view.js — additions

let _pendingRollback = null;

function startRollbackAnimation(itemId, sourcePos) {
  cancelPendingRollback();  // defensive: clear any prior
  const cardEl = document.querySelector(`[data-item-id="${itemId}"]`);
  if (!cardEl) return;
  cardEl.classList.add('rollback-animating');
  const frameId = requestAnimationFrame(() => {
    // CSS transition handles the 200ms animation; just set the target style.
    cardEl.style.transform = `translate(${sourcePos.x}px, ${sourcePos.y}px)`;
  });
  const timerId = setTimeout(() => {
    cardEl.classList.remove('rollback-animating');
    cardEl.style.transform = '';
    _pendingRollback = null;
  }, 200);
  _pendingRollback = { itemId, sourcePosition: sourcePos, frameId, timerId, cardEl };
}

function cancelPendingRollback() {
  if (!_pendingRollback) return;
  const { frameId, timerId, cardEl, sourcePosition } = _pendingRollback;
  if (frameId) cancelAnimationFrame(frameId);
  if (timerId) clearTimeout(timerId);
  if (cardEl) {
    cardEl.classList.remove('rollback-animating');
    // Snap to source: no animation; position state only.
    cardEl.style.transform = '';
    cardEl.style.transition = 'none';
    // Force layout settle on next frame:
    requestAnimationFrame(() => { cardEl.style.transition = ''; });
  }
  _pendingRollback = null;
}

function handleCardTapPick(cardEl, itemId) {
  cancelPendingRollback();  // R3: new pickup wins
  // ... existing pickup state entry ...
}
```

**Why cancellation, not queueing.** Queueing rollback-then-new-pickup would force the user to wait ~200ms with stale visual state before their pickup registers — feels broken. Aborting the pickup mid-tap would lose the user's input — feels broken. Cancellation is the only path where the user ALWAYS gets their pickup honored immediately; the rolled-back card just snaps to source position (no bounce, but the position is correct).

**Tests required (Phase 2).** Add to `tests/public/webapp/organize.kanban-view.test.ts` (covers Anti-Slop W6 — concurrent drag rollback test):

  1. **Test R3-1 (rollback animation cancels on new pickup):** Trigger optimistic move + 412 rollback for card A; before 200ms timer fires, tap-pick card B; assert `_pendingRollback === null`; assert card A's `transform` style is empty (snapped to source); assert card B is in pickup state.
  2. **Test R3-2 (rollback completes naturally if no new pickup):** Trigger 412 rollback for card A; advance fake timers to 200ms; assert `_pendingRollback === null`; assert card A's classList no longer contains `rollback-animating`.
  3. **Test R3-3 (view-switch clears pending rollback):** Trigger 412 rollback for card A; before 200ms, switch view to list; assert `_pendingRollback === null`; assert no orphan animation state.

**File/line impact.**

  - `public/webapp/organize/kanban-view.js` — `_pendingRollback` state + `startRollbackAnimation` + `cancelPendingRollback` + `handleCardTapPick` glue. ~30 LOC.
  - `tests/public/webapp/organize.kanban-view.test.ts` — +3 tests (R3-1 to R3-3; ~50 LOC).
  - ADR 015 D12 prose updated to bind D12.b (this addendum supersedes lines 439-459 to add D12.b sub-decision).

---

### R8 (MEDIUM — supersedes ADR 015 D12 line 446-459) — Full re-render on rollback OR PATCH 200

**Concern (DA P12).** ADR 015 D12 binds optimistic DnD with rollback on 412/4xx/5xx/network-error. The drop sequence does a surgical DOM patch (move the card-element from source column to target column). But the user can change the filter mid-PATCH (e.g., filter "active" → "done" while the PATCH is in flight). On rollback, surgical DOM patch reverses the visual move — but `renderedItems[]` was updated by the filter change. The card-element ends up in a column that may no longer match the filter, OR ends up in a column that's still in the DOM but no longer rendered. State drift.

**Decision — accept R8; bind full re-render from `renderedItems[]` on every rollback OR PATCH 200.**

**Specification (revised D12.c).**

  - On rollback (412/4xx/5xx/network error): after `cancelPendingRollback()` (R3), re-render the entire kanban view from current `renderedItems[]`. The card snaps to wherever the current `renderedItems[]` says it should be — which respects the user's current filter, current goal-grouping, current sort. ~40 LOC of re-render call vs surgical patch.
  - On PATCH 200: also re-render. The PATCH updated `renderedItems[]` (parentId or due changed); re-render reflects the canonical state. Avoids "the surgical patch placed the card in column G; the renderedItems update placed it in column G' (semantically same column but DOM-different element)" drift.
  - Re-render reuses the same `renderKanban(container, items, callbacks, state)` entry from kanban-view.js. The function is idempotent; calling it on every state change is the bound pattern.

**Why full re-render, not optimistic surgical patch.** Surgical patches scale poorly with cross-state interactions (filter, sort, goal-grouping). Re-render is O(N) where N = items in current filter (typically ≤200 for the kanban view); on mobile, that's ~5-10ms. The cost is negligible; the correctness gain is large. Same posture as React's reconciliation — re-render from canonical state, let the diffing layer (CSS transitions; `data-item-id` attribute key) handle visual continuity.

**Tests required (Phase 2).** Add to `tests/public/webapp/organize.kanban-view.test.ts`:

  1. **Test R8-1 (filter change mid-PATCH; rollback re-renders to current filter):** Trigger optimistic move; user filters from "active" to "done"; PATCH returns 412; assert kanban re-renders showing only "done" items (the dragged card may or may not be in current view depending on its status); assert no orphan card-elements in stale columns.
  2. **Test R8-2 (PATCH 200 re-renders to canonical state):** Trigger optimistic move; PATCH returns 200 with updated item shape; assert re-render reflects the server-confirmed state (etag updated; parentId confirmed; any server-side changes propagate).

**File/line impact.**

  - `public/webapp/organize/kanban-view.js` — replace surgical DOM patch with `renderKanban` re-render call. ~40 LOC of refactor (mostly removal; net delta closer to −10 LOC).
  - `tests/public/webapp/organize.kanban-view.test.ts` — +2 tests (R8-1, R8-2; ~30 LOC).
  - ADR 015 D12 prose updated to bind D12.c (this addendum supersedes lines 446-459 to add D12.c sub-decision).

---

### R6 (MEDIUM — supersedes ADR 015 D6) — Cross-month 412 conflict banner with View-item recovery

**Concern (DA P6).** ADR 015 D6 binds calendar drag-to-reschedule = PATCH `due` with If-Match (per-item ETag); 412 surfaces conflict banner. But: user drags card from April 25 → April 30; PATCH returns 412 (concurrent edit moved it to May 5); calendar is in April view; user has navigated to May; banner shows "concurrent edit" but the user has no recovery path — the item is in a different month, no link, no preview.

**Decision — accept R6; bind 412 conflict banner with item TITLE + "View item" action button that switches to the canonical month and highlights the item.**

**Specification (revised D6.a).**

  - On 412 from calendar drag-to-reschedule:
    - The conflict banner shows: `"'<item title>' was moved by another change to <Month YYYY>. View item?"` (textContent on title — XSS safe per v1.14.5 R2 inheritance).
    - "View item" button: tap → switch calendar to the month containing `currentItem.due` (from the 412 response envelope; ADR 012 R1 contract); scroll the day-cell into view; pulse-highlight the cell + item for 2 seconds.
    - "Dismiss" button: tap → close banner; user stays on current month.
  - Same banner posture as v1.14.4 list-view conflict banner (D12 reuse), with the cross-month navigation hook bolted on.

**Pseudocode.**

```javascript
function showCalendarConflictBanner(currentItem, originalDue) {
  const newMonth = parseISO(currentItem.due);
  const monthLabel = formatMonthLabel(newMonth, navigator.language || 'en-US');
  bannerEl.querySelector('.banner-text').textContent =
    `'${currentItem.title}' was moved by another change to ${monthLabel}.`;
  const viewBtn = bannerEl.querySelector('.banner-view-item');
  viewBtn.onclick = () => {
    setCalendarMonth(newMonth);
    setTimeout(() => {
      const cellEl = document.querySelector(
        `[data-cell-date="${currentItem.due}"]`
      );
      if (cellEl) {
        cellEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        cellEl.classList.add('cell-highlight-pulse');
        setTimeout(() => cellEl.classList.remove('cell-highlight-pulse'), 2000);
      }
    }, 50);
    hideBanner();
  };
}
```

**Tests required (Phase 2).** Add to `tests/public/webapp/organize.calendar-view.test.ts`:

  1. **Test R6-1 (cross-month 412 banner shows title + new month):** Drag from April 25 → April 30; PATCH returns 412 with currentItem.due = '2026-05-05'; assert banner text contains item title + "May 2026"; assert "View item" button visible.
  2. **Test R6-2 (View item navigates + highlights):** From R6-1 state; click "View item"; assert calendar month state = May 2026; assert day-cell for May 5 has `cell-highlight-pulse` class; advance fake timers 2000ms; assert class removed.
  3. **Test R6-3 (Dismiss closes banner; stays on current month):** From R6-1 state; click Dismiss; assert banner hidden; assert calendar month state still April 2026.

**File/line impact.**

  - `public/webapp/organize/calendar-view.js` — `showCalendarConflictBanner` + cell-highlight CSS class hook. ~45 LOC.
  - `public/webapp/organize/styles.css` — `.cell-highlight-pulse` keyframe animation. ~10 LOC.
  - `tests/public/webapp/organize.calendar-view.test.ts` — +3 tests (R6-1 to R6-3; ~50 LOC).
  - ADR 015 D6 prose updated to bind D6.a (this addendum supersedes to add D6.a sub-decision).

---

### R7 (MEDIUM — supersedes ADR 015 D7 + closes Anti-Slop strict-equal verification) — Strict-equality binding + 6 injection-probe tests

**Concern (DA P7 + Anti-Slop strict-equal verification).** ADR 015 D7 line 234 says "strict-equal check on a string set"; Anti-Slop §9 verified the strict-equal pattern IS bound. But the architect's prose uses `||` of three === comparisons, and the binding is conceptual — Phase 2 dev could implement with `Array.prototype.includes` (which has prototype-pollution risk if some attacker has hijacked Array.prototype) or with regex (which has injection-vector risk depending on the regex). Bind the strict-equal pattern with literal-code precision.

**Decision — accept R7; bind D7 with the literal `|| || ||` pattern + 6 injection-probe tests.**

**Specification (revised D7.a).**

```javascript
// public/webapp/organize/app.js — top-of-file constant block
const ORGANIZE_VIEW_KEY = 'organize-view-state-v1';
const VALID_VIEWS = ['list', 'kanban', 'calendar'];  // documentation only

function loadView() {
  let raw = null;
  try { raw = sessionStorage.getItem(ORGANIZE_VIEW_KEY); } catch (_) { /* private mode */ }
  // R7 (MEDIUM from CP1 v1.15.0): strict-equal triple-OR.
  // NO Array.includes (prototype pollution risk); NO regex (injection vector risk).
  if (raw === 'list' || raw === 'kanban' || raw === 'calendar') return raw;
  return 'list';  // fallback for null, missing, invalid, prototype-pollution payloads
}

function saveView(view) {
  if (view !== 'list' && view !== 'kanban' && view !== 'calendar') return;  // defensive
  try { sessionStorage.setItem(ORGANIZE_VIEW_KEY, view); } catch (_) { /* private mode */ }
}
```

**Same pattern for D5.a calendar subview state** (`organize-calendar-subview-v1`; whitelist `'month' || 'week' || 'day'`).

**Tests required (Phase 2).** Add to `tests/public/webapp/organize.view-switcher.test.ts`:

  1. **Test R7-1 (`__proto__` injection rejected):** Seed sessionStorage with `__proto__`; loadView() returns `'list'`.
  2. **Test R7-2 (`constructor` rejected):** Seed with `constructor`; returns `'list'`.
  3. **Test R7-3 (`toString` rejected):** Seed with `toString`; returns `'list'`.
  4. **Test R7-4 (capitalization variants rejected):** Seed with `'List'` / `'KANBAN'` / `'Calendar'`; each returns `'list'` (case-sensitive).
  5. **Test R7-5 (embedded NUL byte rejected):** Seed with `'list\0'`; returns `'list'` (the NUL-terminated string is not strict-equal to `'list'`).
  6. **Test R7-6 (JSON-encoded gibberish rejected):** Seed with `'{"view":"kanban"}'`; returns `'list'`.

**File/line impact.**

  - `public/webapp/organize/app.js` — `loadView` + `saveView` with literal `||` pattern; constants. ~12 LOC (D7 baseline) + ~4 LOC clarification (R7).
  - `tests/public/webapp/organize.view-switcher.test.ts` — +6 tests (R7-1 to R7-6; ~80 LOC).
  - ADR 015 D7 prose updated to bind D7.a (this addendum supersedes to make the strict-equal pattern literal-code-precise).

---

### R5 (MEDIUM — supersedes ADR 015 §Test plan §dates) — Calendar timezone regression test for chat-side parser

**Concern (DA P4).** ADR 015 D3 binds calendar-date semantics — `due: '2026-04-25'` always renders on April 25 regardless of user's timezone — based on the architect's claim that "the chat-tool date parser already uses calendar-date semantics since v1.8.6." DA verified at ADR 011 §field-model that the parser stores `due` as a plain `'YYYY-MM-DD'` string — but the actual parser logic was NOT re-checked for v1.15.0; if some intermediate refactor sneaked in a timezone conversion, D3's contract breaks at the data layer not the UI. Regression marker so future timezone "fixes" don't drift the wire format.

**Decision — accept R5; add a regression test verifying both `/organize` chat command AND webapp PATCH/create writers store `due: '2026-04-25'` as the same string.**

**Specification (added test).**

  - **Test R5-1 (calendar-date wire-format consistency across writers):** Drive the chat command parser with `/organize task "test" due 2026-04-25`; capture the persisted item; assert `item.frontMatter.due === '2026-04-25'` (exact string). Drive the webapp PATCH endpoint with `PATCH /api/webapp/items/:id { due: '2026-04-25' }`; capture the persisted item; assert same exact string. Drive the webapp create endpoint with `POST /api/webapp/items { type: 'task', title: 'test', due: '2026-04-25' }`; capture the persisted item; assert same exact string. **All three writers MUST store the identical 10-character string.**
  - This test is a regression marker: if a future iteration adds timezone conversion to ANY writer (e.g., normalizing to UTC-midnight ISO), this test fails before the divergence ships.

**File/line impact.**

  - `tests/integration/organize.calendar-date-wire-format.test.ts` (NEW) — 1 multi-driver test (~80 LOC).
  - ADR 015 §Test plan §dates section gains 1 binding row referencing R5-1.

---

### R4 (MEDIUM — doc-only — supersedes ADR 015 §Test plan §kanban) — HTML5 DnD desktop test scope

**Concern (DA P2).** ADR 015's test plan covers tap-pick-tap-drop (universal mobile path) but the HTML5 DnD coexisting path on desktop is harder to assert in jsdom — jsdom's DnD support is limited to `dragstart`/`dragend` events without the full native flow (no ghost element, no dataTransfer transit between dragstart/drop). DA P2 asks for explicit scope binding so Phase 2 dev doesn't write futile tests.

**Decision — accept R4 doc-only; bind that HTML5 DnD desktop is best-effort with manual Chrome smoke verification before tag.**

**Specification (added prose to ADR 015 §Test plan §kanban).**

  - HTML5 DnD coexisting path on desktop is **best-effort test coverage in jsdom**.
  - jsdom does not simulate native drag events end-to-end (no ghost element; dataTransfer is a stub; the dragenter/dragover/drop sequence is partially synthesized).
  - **Manual smoke verification on Chrome (desktop) is required before v1.15.0 tag.** The smoke checklist:
    - Drag card body with mouse from one column to another; card visually moves; PATCH fires; banner / rollback / 200 path observed.
    - Cancel drag (drop outside any column); card stays in source column; no PATCH.
    - Drag card with the "⋮⋮" handle on desktop also works (handle is mobile-affordance; should not block desktop drag).
  - **If Telegram WebView desktop is found broken in manual smoke testing, file as v1.15.x-test-infra polish.** The coexisting native DnD is a desktop nice-to-have; tap-pick-tap-drop is the supported primary path on all platforms.

**File/line impact.**

  - ADR 015 §Test plan §kanban prose addendum (this revisions doc; +1 paragraph).
  - No code or test changes.

---

### R9 (MEDIUM — doc-only — supersedes ADR 015 §Out-of-scope) — Detail panel refresh state

**Concern (DA P13).** v1.15.0 has no URL routing; refresh-while-detail-open returns to default list view (not the previously-open detail). User re-taps to open detail. This is the v1.14.0 behavior carried forward — but DA P13 asks: should v1.15.0 introduce URL hash routing for view + detail state? Architect's call: defer to v1.16.0+.

**Decision — accept R9 doc-only; add ADR addendum noting v1.16.0+ candidate.**

**Specification (added prose to ADR 015 §Out-of-scope).**

  - **Refresh-with-detail-open returns to default list view.** v1.15.0 has no URL routing (matches v1.14.0 detail behavior). User re-taps to open detail. Acceptable for v1.15.0 — the detail panel is a transient overlay; refresh is a rare action.
  - **v1.16.0+ candidate:** URL hash routing for view + detail state. Hash format candidates: `#/list`, `#/kanban`, `#/calendar/2026-04`, `#/list/<itemId>`. Trigger criteria: (a) user feedback shows refresh-loses-detail is annoying, OR (b) deep-linking to specific items is requested for chat-tool integration (e.g., chat agent emits a webapp link with the item pre-selected).

**File/line impact.**

  - ADR 015 §Out-of-scope row prose addendum (this revisions doc; +1 entry).
  - No code or test changes.

---

### R10 (Anti-Slop RA1-equivalent — supersedes ADR 015 D15 enumeration) — Grow KI from 10 → 12; CLAUDE.md from 3 → 4

**Concern (DA's brief for the architect's revision pass).** ADR 015 D15 pre-enumerates 10 KI + 3 CLAUDE.md invariants (the in-ADR pre-emption that closed Anti-Slop RA1 structurally). Two new entries surface from CP1 + this revisions pass that need to land in the v1.15.0 KI:

  1. **Multi-select scope clarification** (DA P5 OK-with-verification — bulk re-parent via list-view multi-select; kanban DnD is single-card; user might wonder why kanban doesn't bulk).
  2. **list-view.js + edit-form.js extraction** (R1 BLOCKING resolution — Phase 2 mechanical commits 0a + 0b; future agents must understand the extraction wasn't a rewrite).

And one CLAUDE.md invariant grows to anchor the view-mode-specific affordance posture.

**Decision — accept R10; KI grows from 10 → 12; CLAUDE.md invariants grow from 3 → 4.**

**KNOWN_ISSUES.md v1.15.0 entries (revised — 12 total).**

  1. (D15 baseline) View switcher state model — sessionStorage-scoped; whitelist `{list, kanban, calendar}`; injection probe defaults to `list` and overwrites bad value.
  2. (D15 baseline) Kanban DnD strategy — tap-pick-tap-drop primary; native HTML5 DnD desktop coexisting; "⋮⋮" handle is mobile pickup affordance.
  3. (D15 baseline) Calendar-date semantics — `due: 'YYYY-MM-DD'` plain string; renders on the calendar date regardless of user's timezone; matches v1.8.6 chat-side parser.
  4. (D15 baseline) `dates.js` helpers — pure functions; UTC-only internally; no library; ~80 LOC; `ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/` and `ISO_DATE_FORMAT = 'YYYY-MM-DD'` constants exported (W2 binding).
  5. (D15 baseline) Optimistic DnD with rollback — capture source state → visually move → PATCH with If-Match → on 200/412/4xx/5xx/network-error paths bound; rollback animation 200ms; **R3 active-drag rollback cancellation: new pickup cancels rollback; rolled-back card snaps to source no-animation; new pickup proceeds normally**; **R8 full re-render on rollback OR 200 from `renderedItems[]` (no surgical DOM patch)**.
  6. (D15 baseline) Goal column ordering — by `frontMatter.created` ASC; Standalone column last.
  7. (D15 baseline) `/api/webapp/config` endpoint — read-only metadata; `Cache-Control: no-store`; auth chain matches items routes; **F1 positive bind: config.ts does NOT import auditItemMutate / auditItemCreate; no audit code path exists in the file**; client falls back to hardcoded `'organize-mutations-jarvis'` on 404 / network error / 401 / 403 / 500.
  8. (D15 baseline) `_internals.ts` boundary — underscore prefix = private to organize module; only files inside `src/organize/` may import. **Enforcement: convention-only (no ESLint rule today); discipline relies on JSDoc + CLAUDE.md invariant + code-review. v1.15.x+ candidate: ESLint rule `@typescript-eslint/no-restricted-imports` matching `**/_*` outside same dir; trigger when violations recur** (W4 binding).
  9. (D15 baseline) app.js partial split — kanban + calendar + dates extracted as new modules; **list-view.js + edit-form.js pre-extracted as Phase 2 commits 0a + 0b (mechanical zero-logic-change refactor; R1 BLOCKING resolution)**; v1.16.0+ trigger lowered from 2500 to **2000 LOC**.
  10. (D15 baseline) Calendar at 5000+ items — client-side filter at ~5-10ms acceptable on mobile; v1.15.x server-side filter trigger when >2000 items reported OR P95 calendar-render >500ms.
  11. **(NEW R10) Multi-select scope:** Multi-select is **list-view-only**. Kanban DnD is for low-N (1-5 items per drag) reparenting; calendar drag-to-reschedule is single-item; bulk Move-to-goal in list view (via multi-select + bulk PATCH per v1.14.6 R1 verb-asymmetric If-Match) is the high-N path. Cross-view operations not supported — user must switch to list view for bulk.
  12. **(NEW R10) list-view.js + edit-form.js extraction (Phase 2 commits 0a + 0b):** Mechanical zero-logic-change relocation. list-view.js (~600 LOC): renderList, item card construction, hierarchy grouping integration, complete checkbox, multi-select rendering. edit-form.js (~400 LOC): enterEditMode, exitEditMode, submitEdit, cancelEdit, parent picker UI, char counters, conflict UI rendering. Tests relocated alongside; same expectations preserved bug-for-bug.

**CLAUDE.md v1.15.0 invariants (revised — 4 total).**

  1. (D15 baseline) **View switcher state model** — sessionStorage-only (no localStorage; per-tab); whitelist + injection-probe defaults; mode-exit clears multi-select state per D8.
  2. (D15 baseline) **DnD pattern** — optimistic move → PATCH with If-Match → rollback on 412/4xx/5xx/network-error; animation 200ms; new pickup cancels in-flight rollback; full re-render from `renderedItems[]` on rollback OR 200.
  3. (D15 baseline) **`_internals.ts` module boundary** — underscore prefix = private; only `src/organize/*.ts` may import; convention-only enforcement; ESLint rule deferred.
  4. **(NEW R10) View-mode-specific affordances** — list view has multi-select (bulk operations); kanban has DnD reparenting (single-item; "⋮⋮" handle on mobile + native DnD on desktop); calendar has drag-to-reschedule (single-item; cross-day via month grid). **Cross-view operations not supported.** User must be in the right view for the operation. View-switch (D8) clears mode-specific state (multi-select state cleared; in-flight rollback cleared; pending pickup cleared).

**File/line impact.**

  - `D:\ai-jarvis\KNOWN_ISSUES.md` — 12 v1.15.0 entries (~95 LOC).
  - `D:\ai-jarvis\CLAUDE.md` — 4 v1.15.0 invariants (~20 LOC).
  - ADR 015 D15 prose updated to grow enumeration from 10 → 12 KI + 3 → 4 invariants.

---

### W2 (Anti-Slop W2 — supersedes ADR 015 D2) — ISO_DATE_RE + ISO_DATE_FORMAT constants in dates.js

**Concern (Anti-Slop W2).** ADR 015 D2 binds 10 pure-function helpers but uses literal `'YYYY-MM-DD'` repeatedly in JSDoc and return values. Phase 2 dev would invent a regex for `parseISO` (likely `/^\d{4}-\d{2}-\d{2}$/` but could drift). Bind both as named exports.

**Decision — accept W2; bind constants in dates.js.**

**Specification (revised D2.a — top of dates.js).**

```javascript
// public/webapp/organize/dates.js — v1.15.0

/**
 * @file Calendar-date helpers for the organize webapp.
 * @see {@link ../../docs/adr/015-v1.15.0-kanban-calendar.md} D2 + D3
 *
 * (W3) Calendar-date semantics rationale:
 * `due` is stored as a plain 'YYYY-MM-DD' string. The calendar renders the
 * task on that exact date regardless of the user's timezone. DO NOT "fix"
 * by converting to UTC midnight or to local midnight — both shift the date
 * near boundaries (a task due 2026-04-25 viewed at 11pm UTC on April 24
 * would render on April 24 if converted, which violates user intent).
 *
 * The chat-tool /organize parser has used calendar-date semantics since
 * v1.8.6; this module honors the same contract. Round-tripping through
 * UTC conversion at any layer breaks the wire-format invariant.
 *
 * REGRESSION TEST: tests/integration/organize.calendar-date-wire-format.test.ts
 * verifies all three writers (chat command, webapp PATCH, webapp create)
 * store the identical 'YYYY-MM-DD' string for the same input.
 */

export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const ISO_DATE_FORMAT = 'YYYY-MM-DD';  // documentation string; not a parser format

/**
 * Parse 'YYYY-MM-DD' into a UTC Date (midnight UTC). Returns null on malformed
 * OR on values that pass the regex but fail Date.UTC range (e.g., '2026-13-45').
 */
export function parseISO(s) {
  if (typeof s !== 'string' || !ISO_DATE_RE.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (isNaN(date.getTime())) return null;
  // Round-trip check — reject '2026-13-45' which Date.UTC silently normalizes
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return date;
}

// ... rest of D2 helpers ...
```

**File/line impact.**

  - `public/webapp/organize/dates.js` — `ISO_DATE_RE` + `ISO_DATE_FORMAT` exports + parseISO regex + range check. ~6 LOC binding + ~3 LOC of test (parseISO rejects `'2026-13-45'`, `'2026-02-30'`, etc.).
  - ADR 015 D2 prose updated to bind D2.a (this addendum supersedes).

---

### W3 (Anti-Slop W3 — supersedes ADR 015 D3) — Top-of-file rationale comment block in dates.js

**Concern (Anti-Slop W3).** D3 binds calendar-date semantics in prose + KI entry 3 + "an inline comment block in dates.js" — but WHERE in dates.js was not specified. Bind: top-of-file JSDoc header.

**Decision — accept W3; bind top-of-file JSDoc.**

**Specification.** Already covered in W2 above (the JSDoc block at the top of dates.js is the W3 binding location). The comment block:

  - Explains what calendar-date semantics means.
  - Documents the DO-NOT-FIX warning (no UTC conversion; no local-midnight conversion).
  - References ADR 015 D3 by file path.
  - References KI entry 3 by content.
  - Names the regression test path so future devs see the regression marker.

**File/line impact.** Same as W2 (the JSDoc lives at top of dates.js; ~12 LOC).

---

### W4 (Anti-Slop W4 — supersedes ADR 015 D15 KI entry 8) — Enforcement strategy expanded

**Concern (Anti-Slop W4).** D10 picks DOCUMENT + TRUST + DEFERRED-ESLint enforcement for `_internals.ts` underscore convention; KI entry 8 is silent on the strategy. Phase 2 dev reading the KI alone sees "only files inside `src/organize/` may import" without knowing it's convention-only (not tsc / ESLint hard error).

**Decision — accept W4; expand KI entry 8 (covered in R10 above).**

**Specification.** KI entry 8 (revised — see R10 above):

  - "`_internals.ts` boundary — underscore prefix = private to organize module; only files inside `src/organize/` may import. **Enforcement: convention-only (no ESLint rule today); discipline relies on JSDoc + CLAUDE.md invariant + code-review.** Discipline: don't import from `../_internals.ts` outside `src/organize/`. **v1.15.x+ candidate: ESLint rule `@typescript-eslint/no-restricted-imports` matching `**/_*` outside same dir;** trigger when violations recur (Risk row 10)."

**File/line impact.** Covered in R10 (KI entry 8 expansion).

---

### W6 (Anti-Slop W6 — supersedes ADR 015 §Test plan §kanban) — Concurrent drag rollback test

**Concern (Anti-Slop W6).** D12 covers happy + 412 + network error rollback tests; concurrent-drag rollback (Risk row 4 + the new R3 binding) NOT specifically bound in Test plan §kanban.

**Decision — accept W6; closes via R3-1 (added in R3 above).**

**Specification.** R3-1 IS the W6 closure. The test verifies `_pendingRollback` is cleared on new pickup; the rolled-back card snaps to source position; the new pickup proceeds normally. R3-2 + R3-3 add the natural-completion + view-switch coverage.

**File/line impact.** Covered in R3 (3 tests added; R3-1 specifically addresses W6).

---

### W1 (Anti-Slop W1) — Closes via R2

**Concern.** Toast key + dismissal contract not bound.

**Resolution.** R2 binds D1.d with `KANBAN_TUTORIAL_KEY = 'organize-kanban-tutorial-seen'`, `KANBAN_TUTORIAL_TOAST_MS = 8000`, literal toast text, and 5 tests. Closed.

---

### W5 (Anti-Slop W5) — Closes via R1

**Concern.** Phase 2 commit ordering not bound.

**Resolution.** R1 binds the 10-commit sequence (commits 0a, 0b, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10). Each commit independently testable. Closed.

---

### F1 (Anti-Slop cosmetic — /api/webapp/config audit absence positive bind)

**Concern.** D9 binds "no audit row" but doesn't positively state the absence (e.g., "config.ts does not import auditItemMutate / auditItemCreate; no audit code path exists in the file").

**Decision — accept F1 doc-only; expand D9 with explicit positive bind.**

**Specification (revised D9.a).**

  - **Audit category: NONE.** `/api/webapp/config` is read-only metadata; matches the audit posture of `GET /api/webapp/items` (no audit on read; only on mutate).
  - **Positive bind:** `src/webapp/config.ts` does NOT import `auditItemMutate`, `auditItemCreate`, or any other audit emitter. The file has zero audit code path. Phase 2 dev verifying via `grep -E 'auditItemMutate|auditItemCreate' src/webapp/config.ts` MUST return zero matches.
  - **Cosmetic clarity for code review:** future reviewers reading config.ts and not finding audit calls can confirm the absence is intentional, not an oversight.

**File/line impact.**

  - ADR 015 D9 prose addendum (this revisions doc; +1 paragraph).
  - No code change beyond what's already implied by D9.

---

### F2 (Anti-Slop cosmetic — CSS LOC sub-total breakdown)

**Concern.** ADR 015 §Module/file plan says styles.css gains +340 LOC; doesn't break down by subsystem.

**Decision — accept F2 doc-only; recommend Phase 2 reconcile after implementation.**

**Specification (added prose to ADR 015 §Module/file plan).**

  - Approximate sub-totals (preventive bookkeeping; reconcile in Phase 2 LOC report):
    - Kanban styles ~120 LOC (`.kanban-view`, `.column`, `.column-header`, `.card`, `.card-pickup-selected`, `.column-drop-target`, drop-target hover state, "⋮⋮" handle, R2 toast).
    - Calendar styles ~140 LOC (`.calendar-view`, `.month-grid`, `.day-cell`, `.day-cell-other-month`, `.day-cell-today`, item truncation, "+N more" indicator, R6 `.cell-highlight-pulse`).
    - View-switcher ~30 LOC (`.view-switcher-tabs`, `.view-tab`, `.view-tab-active`, subview chips).
    - DnD visuals + rollback animation keyframes ~50 LOC (`@keyframes rollback-bounce`, `.rollback-animating`, drop-zone visualization).
  - **Total ~340 LOC** (matches D11 +340 projection).
  - R2 toast styling adds ~5 LOC variant; R6 cell-highlight adds ~10 LOC; net post-revisions ~355 LOC. Reconcile in Phase 2 LOC report.

**File/line impact.**

  - ADR 015 §Module/file plan prose addendum (this revisions doc; +1 paragraph).
  - No code change in v1.15.0 plan; reconcile in Phase 2 LOC report.

---

## Pushback / disagreements with reviewers

**No reviewer findings declined.** All 1 BLOCKING + 2 HIGH + 6 MEDIUM + 6 W + 2 F accepted in some form (R1-R10 + W2-W6 + F1-F2; W1 + W5 + W6 close via R-revisions). The convergence between DA and Anti-Slop on R1/W5 (commit ordering implicated by the BLOCKING) and R2/W1 (toast contract) and R3/W6 (concurrent drag test) made the architect's job mostly mechanical — bind the contracts the reviewers identified.

The architect's only structural addition beyond reviewer findings is **lowering the v1.16.0+ split trigger from 2500 to 2000 LOC** (R1). The original 2500 was set based on the 1786 baseline; with the corrected 2727 baseline, the architect's tolerance for app.js growth must scale down. 2000 is a tighter discipline that preempts the same drift in v1.16.0+.

---

## File-impact summary table for Phase 2 (with new commits 0a + 0b)

| File | Change | Driver | LOC delta (post-revisions) |
|---|---|---|---:|
| `public/webapp/organize/list-view.js` (NEW) | Mechanical extraction from app.js (commit 0a) | R1 BLOCKING | **+600** |
| `public/webapp/organize/edit-form.js` (NEW) | Mechanical extraction from app.js (commit 0b) | R1 BLOCKING | **+400** |
| `public/webapp/organize/app.js` | (1) commit 0a removes ~600 LOC list rendering; (2) commit 0b removes ~400 LOC edit form; (3) commit 6+ adds ~250 LOC view-switcher + DnD coordinator + boot config fetch + R7 strict-equal + R8 re-render hook; net 2727 → ~1977 | R1 + D7-D11 + R7 + R8 | **−750** (2727 → ~1977) |
| `src/organize/_internals.ts` (NEW) | Mechanical extraction (commit 1) — writeAtomically + serializeItem | D10 | **+80** |
| `src/organize/storage.ts` | Import writeAtomically + serializeItem from _internals.ts; remove inline definitions | D10 | **−37** (1130 → ~1093) |
| `src/organize/trash.ts` | Import writeAtomically + serializeItem from _internals.ts; remove duplicates | D10 | **−27** (507 → ~480) |
| `public/webapp/organize/dates.js` (NEW) | Pure-function date helpers + W2 ISO_DATE_RE + W3 JSDoc rationale | D2 + W2 + W3 | **+100** (80 baseline + 12 W3 + 6 W2 + 2 range check) |
| `public/webapp/organize/kanban-view.js` (NEW) | Render + DnD + R2 toast + R3 rollback cancel + R8 re-render | D1 + D4 + D12 + R2 + R3 + R8 | **+335** (280 baseline + 25 R2 + 30 R3) |
| `public/webapp/organize/calendar-view.js` (NEW) | Render + drag-reschedule + R6 cross-month banner | D2 + D3 + D5 + D6 + D12 + R6 | **+395** (340 baseline + 45 R6 + 10 cell-highlight CSS hook) |
| `src/webapp/config.ts` (NEW) | GET /api/webapp/config + F1 positive no-audit bind | D9 + F1 | **+90** |
| `src/webapp/itemsRoute.ts` | Add mountWebappConfigRoutes call | D9 | **+3** |
| `src/gateway/index.ts` | Add botUsername state field; thread to webapp deps | D9 | **+8** |
| `public/webapp/organize/index.html` | Add view containers + view-switcher buttons + subview chips | D7 + D11 | **+45** |
| `public/webapp/organize/styles.css` | Kanban + calendar + view-switcher + DnD + rollback animations + R2 toast variant + R6 cell-highlight | D11 + R2 + R6 | **+355** (340 baseline + 5 R2 + 10 R6) |
| `tests/public/webapp/organize.list-view.test.ts` (NEW or relocated) | Existing list tests relocated; ZERO logic changes | R1 commit 0a | **+600** (relocated; net 0 vs prior file) |
| `tests/public/webapp/organize.edit-form.test.ts` (NEW or relocated) | Existing edit-form tests relocated; ZERO logic changes | R1 commit 0b | **+400** (relocated; net 0 vs prior file) |
| `tests/unit/organize._internals.test.ts` (NEW) | _internals.ts wire-integrity (commit 1) | D10 | **+80** (3 tests) |
| `tests/integration/webapp.config.test.ts` (NEW) | /api/webapp/config endpoint integration | D9 | **+200** (7 tests) |
| `tests/unit/organize.dates.test.ts` (NEW) | Pure-function dates.js tests + W2 range check + R5 wire-format regression | D2 + W2 | **+260** (11 baseline + 1 W2 + ~30 LOC of edge cases) |
| `tests/integration/organize.calendar-date-wire-format.test.ts` (NEW) | R5 calendar-date wire-format regression marker | R5 | **+80** (1 multi-driver test) |
| `tests/public/webapp/organize.kanban-view.test.ts` (NEW) | Render + DnD + R2 toast (5 tests) + R3 rollback cancel (3 tests) + R8 re-render (2 tests) + W6 (closes via R3-1) | D1 + D4 + D12 + R2 + R3 + R8 + W6 | **+340** (220 baseline + 80 R2 + 50 R3 + 30 R8) |
| `tests/public/webapp/organize.calendar-view.test.ts` (NEW) | Render + drag-reschedule + R6 cross-month UX (3 tests) | D2 + D3 + D5 + D6 + D12 + R6 | **+340** (290 baseline + 50 R6) |
| `tests/public/webapp/organize.view-switcher.test.ts` (NEW) | View switch + sessionStorage + R7 strict-equal + 6 injection-probe tests | D7 + D8 + R7 | **+200** (120 baseline + 80 R7) |
| `tests/integration/webapp.organize.broadcast.test.ts` | Add /api/webapp/config integration to BC update path | D9 | **+60** (3 tests) |
| `D:\ai-jarvis\KNOWN_ISSUES.md` | 12 v1.15.0 entries (R10 + W2 + W4 + F1) | R10 + W2 + W4 + F1 | **+95** |
| `D:\ai-jarvis\CLAUDE.md` | 4 v1.15.0 invariants (R10) | R10 | **+20** |
| `docs/CHANGELOG.md` | v1.15.0 entry (Phase 5) | unchanged | +50 |
| `package.json` | Version bump 1.14.6 → 1.15.0 | unchanged | +1 |

**Estimated total LOC delta vs ADR 015 baseline:**

  - **ADR 015 baseline (architect's projection):** ~1,135 source / ~1,490 tests / ~ doc = ~3,420 total.
  - **Post-revisions projection:**
    - **Source code (production):** −750 (app.js) + 600 (list-view.js) + 400 (edit-form.js) + 80 (_internals.ts) − 37 (storage.ts) − 27 (trash.ts) + 100 (dates.js) + 335 (kanban-view.js) + 395 (calendar-view.js) + 90 (config.ts) + 3 (itemsRoute.ts) + 8 (gateway/index.ts) + 45 (index.html) + 355 (styles.css) = **+1,597 LOC** (vs ~1,135 baseline; +462 vs ADR 015 baseline; the bulk is the mechanical relocations 0a + 0b which are zero-logic-change moves between files).
    - **Test code:** 600 (list-view test relocated) + 400 (edit-form test relocated) + 80 + 200 + 260 + 80 + 340 + 340 + 200 + 60 = **+2,560 LOC** (vs ~1,490 baseline; +1,070; bulk is the relocated test files which are zero-logic moves + R1-R10 + W6 test additions).
    - **Docs:** +95 KI + 20 CLAUDE.md = **+115 LOC**.
    - **CHANGELOG:** +50.
    - **Version:** +1.
  - **Net code delta (excluding mechanical relocations):** Source ~+557 (1597 − 600 − 400 − 40 net relocation move-cost); Tests ~+1,160 (2560 − 600 − 400 − 400 net relocation move-cost). Mechanical moves are bookkeeping; they don't change effective code complexity.
  - **Test ratio:** ~62% (2560 / (1597 + 2560)). Healthy; matches ADR 015's projected 57%.

**Source code (non-test) LOC delta:** ~1,597 with relocations counted; ~557 net new. Of this, ~101 is server-side (_internals.ts +80; config.ts +90; itemsRoute +3; gateway +8; storage −37; trash −27 = net 117 server; minus mechanical extractions); the rest is client-side (list-view.js + edit-form.js + dates.js + kanban-view.js + calendar-view.js + app.js + HTML + CSS); ~115 is docs.

**Test count delta (post-revisions):** D14 baseline 59 tests + R2 +5 + R3 +3 + R5 +1 + R6 +3 + R7 +6 + R8 +2 + W6 +0 (closes via R3-1) + R1 +3 (mechanical extraction wire-integrity) = **~82 tests.** Phase 2 binding: 82 tests is the new target (relocated list-view + edit-form tests already exist as ~80; net new ~82 tests; total ~162 tests in v1.15.0 across new + relocated suites).

---

## Final R-list ordered by Phase 2 file impact

| # | Severity | Resolution | Primary file impact | LOC |
|---|---|---|---|---:|
| **R1** | BLOCKING | Pre-extract list-view.js + edit-form.js as commits 0a + 0b; lower trigger 2500 → 2000 | `list-view.js` NEW (+600) + `edit-form.js` NEW (+400) + `app.js` (−1000 mechanical + 250 v1.15.0 work = −750 net) + 3 wire-integrity tests | **+1,000 mech + 80 test** |
| **R10** | RA-equivalent | KI grows 10 → 12; CLAUDE.md grows 3 → 4 | `KNOWN_ISSUES.md` (+95) + `CLAUDE.md` (+20) | **+115** |
| **R6** | MEDIUM | Cross-month 412 banner with View-item recovery | `calendar-view.js` (+45) + `styles.css` (+10) + tests (+50) | **+105** |
| **R7** | MEDIUM | Strict-equal binding + 6 injection-probe tests | `app.js` (+4) + tests (+80) | **+84** |
| **R3** | HIGH | Active-drag rollback cancellation contract | `kanban-view.js` (+30) + tests (+50) | **+80** |
| **R2** | HIGH | Toast contract (D1.d) — text + key + 8s + 5 tests | `kanban-view.js` (+25) + `styles.css` (+5) + tests (+80) | **+110** |
| **R8** | MEDIUM | Full re-render on rollback OR 200 from renderedItems | `kanban-view.js` (refactor, ~−10 net) + tests (+30) | **+30** |
| **R5** | MEDIUM | Calendar-date wire-format regression test | `tests/integration/organize.calendar-date-wire-format.test.ts` NEW (+80) | **+80** |
| **W2** | Anti-Slop W2 | ISO_DATE_RE + ISO_DATE_FORMAT constants + range check | `dates.js` (+8) | **+8** |
| **W3** | Anti-Slop W3 | Top-of-file JSDoc rationale block in dates.js | `dates.js` (+12) | **+12** |
| **W4** | Anti-Slop W4 | KI entry 8 enforcement strategy expanded | covered in R10 | doc-only |
| **W1** | Anti-Slop W1 | Toast key + dismissal contract | covered in R2 | covered |
| **W5** | Anti-Slop W5 | Phase 2 commit ordering | covered in R1 | covered |
| **W6** | Anti-Slop W6 | Concurrent drag rollback test | covered in R3 (R3-1) | covered |
| **F1** | Anti-Slop cosmetic | config.ts positive no-audit-imports bind | doc-only D9.a; covered in R10 KI #7 | doc-only |
| **F2** | Anti-Slop cosmetic | CSS LOC sub-totals | doc-only addendum | doc-only |
| **R4** | MEDIUM | doc-only — HTML5 DnD desktop test scope | ADR §Test plan §kanban prose | doc-only |
| **R9** | MEDIUM | doc-only — refresh-detail-state v1.16.0+ candidate | ADR §Out-of-scope prose | doc-only |

**Phase 2 commit ordering (binding — repeated for clarity from R1):**

  1. **Commit 0a:** list-view.js extraction (mechanical; ZERO logic change).
  2. **Commit 0b:** edit-form.js extraction (mechanical; ZERO logic change).
  3. **Commit 1:** _internals.ts extraction (mechanical; closes v1.14.6 P2 F4 + Scalability WARNING-1.14.6.A).
  4. **Commit 2:** dates.js standalone (D2 + W2 + W3).
  5. **Commit 3:** kanban-view.js standalone (D1 + D4 + R2 toast + R3 rollback cancel; not yet imported by app.js).
  6. **Commit 4:** calendar-view.js standalone (D2 + D3 + D5 + D6 + R6 cross-month banner).
  7. **Commit 5:** config.ts + gateway botUsername threading + WebappConfigDeps + F1 positive bind.
  8. **Commit 6:** app.js view-switcher + R7 strict-equal + R8 re-render hook + view-module integration.
  9. **Commit 7:** HTML view containers + view-switcher buttons + CSS additions (F2 reconcile).
  10. **Commit 8:** Test files in lockstep (R1-1, R1-2, R1-3 wire-integrity; R2-1 to R2-5; R3-1 to R3-3; R5-1; R6-1 to R6-3; R7-1 to R7-6; R8-1, R8-2; W6 closes via R3-1).
  11. **Commit 9:** R10 KNOWN_ISSUES.md + CLAUDE.md additions.
  12. **Commit 10:** CHANGELOG + version bump 1.14.6 → 1.15.0; ship.

End of revisions document for v1.15.0 CP1.
