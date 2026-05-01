# ADR 012 — Revisions after CP1 debate (2026-04-25)

**Parent:** `012-v1.14.4-etag-conflict-resolution.md`
**Status:** Accepted. Folded into ADR 012 by reference. Phase 2 dev agents implement the revised spec; deviations require another addendum.
**Context.** Devil's Advocate review (`docs/reviews/cp1-devils-advocate-v1.14.4.md`) raised 1 BLOCKING + 2 HIGH + 6 MEDIUM + 3 OK with 9 numbered R-revisions (R1–R9). Anti-Slop Phase 1 review (`docs/reviews/anti-slop-phase1-review-v1.14.4.md`) raised 2 Required Actions (RA1, RA2) + 6 warnings (W1–W6) + 3 cosmetic carry-forward (C1, C2, C3). Convergence signal: both reviewers independently flagged the wire-protocol-magic-strings + audit-flag-distinguishability axis (DA P2 → R2 `bypassAfter412`; Anti-Slop RA1 enumerated header constants; both want richer forensic distinguishability across the audit `etag/forced` slot population) and the conditional-stat-call binding (DA P12 → R6; Anti-Slop W2). The architect resolves the BLOCKING (R1) with a 7-LOC same-read TOCTOU invariant in `updateItem` and `softDeleteItem`, accepts both HIGH (R2 `bypassAfter412` audit field; R6 conditional `expectedEtag` binding) plus both RAs in full, accepts every MEDIUM with light scoping (R3 audit-only telemetry; R4 no-op fast-path; R5 FAT-mtime doc; R8 deployment doc; R9 DELETE conflict UI), and defers ONE MEDIUM (R7 BroadcastChannel) to v1.14.5 where it's a focused client-only iteration.

The BLOCKING (R1 — handler-level + storage-level ETag computations are NOT atomic with each other; the 412 response's `currentEtag` and `currentItem` could come from different reads of the same file under concurrent load) MUST land in v1.14.4. Non-negotiable. Verified at `src/organize/storage.ts:649-703` (current `updateItem` implementation): the function reads the file via `readFile` at line 662, parses front-matter at line 670, applies the patch, calls `stampUpdated` at line 692, and writes via `writeAtomically` at line 698. **There is NO `fs.stat` call anywhere in the function.** ADR 012 D8's binding at line 527-535 (`if (options?.expectedEtag !== undefined) { const currentEtag = computeETag(parsedFm, fileMtimeMs); ... }`) requires a `fileMtimeMs` value that the current `updateItem` does not have access to — the only way to obtain it is to call `fs.stat` BEFORE the `readFile`. The fix in this addendum binds the explicit ordering: **stat-then-read happens in the SAME atomic block; `currentEtag` is computed from THAT pair; the `ETAG_MISMATCH` error carries the `parsedFm` (and `fileMtimeMs`) from THAT read so the handler's 412 response is bound to the same observation.** The fix ships as the FIRST commit of v1.14.4 Phase 2 because every PATCH/DELETE/POST-/complete handler depends on it.

This revisions document supersedes the relevant clauses of ADR 012 by reference; the parent ADR is not edited.

---

## Resolved (R-numbered, ordered by file impact for Phase 2)

### R1 (BLOCKING — supersedes ADR 012 D8 binding lines 504-540) — TOCTOU same-read invariant for `currentEtag` + `currentItem` in 412 response

**Concern (DA P7).** ADR 012 D8 at line 527-535 specifies the storage-layer ETag check as:

```typescript
if (options?.expectedEtag !== undefined) {
  const currentEtag = computeETag(parsedFm, fileMtimeMs);   // ← fileMtimeMs comes from where?
  if (!etagsMatch(options.expectedEtag, currentEtag)) {
    const err = new Error(`...`) as Error & { code: string; actualEtag: string };
    err.code = 'ETAG_MISMATCH';
    err.actualEtag = currentEtag;
    throw err;
  }
}
```

The spec is silent on how `fileMtimeMs` is obtained inside `updateItem`. DA verified at `src/organize/storage.ts:649-703` that `updateItem` currently has NO `fs.stat` call: it uses `existsSync` for presence (`:656`), `readFile` for content (`:662`), and `writeAtomically` for output (`:698`). The closest mtime source is the OS file metadata, which requires an additional system call.

**The TOCTOU window.** A naive D8 implementation could call `fs.stat` separately from `readFile`, producing two reads of the file's metadata that are NOT atomic. A concurrent writer (chat-agent `appendProgressEntry` on the same item) committing between the stat and the readFile produces:

  1. `stat` returns mtime M0 (pre-concurrent-write)
  2. concurrent writer commits → file's `updated:` becomes T_concurrent, mtime → M1
  3. `readFile` returns content with `updated: T_concurrent` (post-concurrent-write)
  4. ETag computed from `(parsedFm.updated: T_concurrent, fileMtimeMs: M0)` — but since `parsedFm.updated` is non-null, the computeETag uses `parsedFm.updated`, not the mtime. So `currentEtag = "T_concurrent"`.
  5. Compare to `options.expectedEtag = "T_baseline"` → mismatch → throw ETAG_MISMATCH with `actualEtag = "T_concurrent"`.

In this case the 412 response's `currentEtag` IS correct (it reflects the post-concurrent-write state). BUT the handler builds the `currentItem` field of the 412 envelope from a SECOND read of the file (per ADR 012 D4's "currentItem is a fresh fetch from disk to populate the 412 envelope"). If a THIRD writer commits between the storage-layer ETAG_MISMATCH throw and the handler's currentItem read, the 412 response carries:
  - `currentEtag` from time T_storage_check (from `parsedFm` read at storage layer)
  - `currentItem` from time T_handler_response (from a separate `readItem` call)

**These are not atomic.** The client receives a 412 with `currentEtag = X` and `currentItem` that has `etag = Y` (X ≠ Y). The client's "Reload to see the latest" UX (per D12) reloads with `currentItem`, but the displayed ETag in the form's hidden field is X (from the 412 envelope) — and now the NEXT save will use X as If-Match, which doesn't match the actual current state Y. The client sees a 412-loop. **Forensic visibility is degraded; UX is broken.**

This is BLOCKING for v1.14.4 specifically. The two-read TOCTOU is not theoretical — chat-agent `appendProgressEntry` writes happen on autonomous reflection cron timers (every 30 minutes per user); the user's webapp PATCH/DELETE flow can race against these without warning. Without R1's same-read invariant, the 412-loop bug ships.

**Decision — same-read invariant in `updateItem` and `softDeleteItem`.**

**R1 — bind the storage primitive's ETag check to a SINGLE atomic stat-then-read pair.** Update D8's binding at lines 504-540 to specify the explicit ordering:

```typescript
// src/organize/storage.ts — updateItem signature gains optional 4th argument

import { stat, readFile } from 'node:fs/promises';
import { computeETag, etagsMatch } from './etag.js';

/**
 * v1.14.4 R1 — When `options.expectedEtag` is set, this function:
 *   1. Performs ONE `fs.stat` call to get fileMtimeMs (line A below).
 *   2. Performs ONE `readFile` call (line B below) — the single FrontMatter source of truth.
 *   3. Computes `currentEtag` from THAT (parsedFm, fileMtimeMs) pair.
 *   4. If mismatch, throws `ETAG_MISMATCH` carrying `currentFm` (the parsed object from step 2)
 *      AND `currentMtimeMs` (from step 1) — the handler builds the 412 response from these
 *      WITHOUT re-reading or re-stat'ing.
 *
 * If `options.expectedEtag` is undefined (chat-side callers like organize_update.ts +
 * organize_complete.ts), the function does NOT call fs.stat — behavior is unchanged from
 * v1.14.3.
 *
 * Throws Error & { code: 'ETAG_MISMATCH'; actualEtag: string; currentFm: OrganizeFrontMatter;
 *                  currentMtimeMs: number } on mismatch.
 */
export async function updateItem(
  userId: number,
  dataDir: string,
  itemId: string,
  patch: UpdateItemPatch,
  options?: { expectedEtag?: string },
): Promise<OrganizeItem> {
  const filePath = itemFilePath(userId, dataDir, itemId);
  if (!existsSync(filePath)) {
    throw Object.assign(new Error(`Item not found: ${itemId}`), { code: 'ITEM_NOT_FOUND' });
  }

  // R1 (BLOCKING from CP1 v1.14.4): conditional fs.stat for ETag fallback path.
  // Only when expectedEtag is set; chat-side callers pay zero cost.
  let fileMtimeMs = 0;
  if (options?.expectedEtag !== undefined) {
    const st = await stat(filePath);                              // line A — SINGLE stat call
    fileMtimeMs = st.mtimeMs;
  }

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');                       // line B — SINGLE read; pairs with line A
  } catch (err) {
    throw Object.assign(
      new Error(`Failed to read item: ${err instanceof Error ? err.message : String(err)}`),
      { code: 'FILE_WRITE_FAILED' },
    );
  }

  const outcome = parseItemFile(raw, itemId);
  if (!outcome.ok) {
    throw Object.assign(
      new Error(`Item file is malformed: ${itemId}`),
      { code: 'ITEM_MALFORMED' },
    );
  }

  const { fm: parsedFm, notesBody: existingNotes, progressBody: existingProgress } = outcome.result;

  // R1 same-read invariant: compute currentEtag from THIS read's (parsedFm, fileMtimeMs);
  // throw error carrying THIS read's parsedFm + fileMtimeMs so the handler's 412 envelope
  // is bound to the SAME observation. NEVER re-read or re-stat to compute the conflict response.
  if (options?.expectedEtag !== undefined) {
    const currentEtag = computeETag(parsedFm, fileMtimeMs);
    if (!etagsMatch(options.expectedEtag, currentEtag)) {
      throw Object.assign(
        new Error(`ETag mismatch: expected ${options.expectedEtag}, got ${currentEtag}`),
        {
          code: 'ETAG_MISMATCH',
          actualEtag: currentEtag,
          currentFm: parsedFm,             // R1 — handler uses THIS for 412.currentItem
          currentMtimeMs: fileMtimeMs,     // R1 — handler uses THIS for ETag re-derivation if needed
        },
      );
    }
  }

  // ... existing patch-application + stampUpdated + serialize + writeAtomically ...
}
```

**Same pattern for `softDeleteItem`** (binding for Phase 2):

```typescript
export async function softDeleteItem(
  userId: number,
  dataDir: string,
  itemId: string,
  options?: { expectedEtag?: string },
): Promise<{ trashedPath: string }> {
  await ensureUserDir(userId, dataDir);
  const trashDir = await ensureTrashDir(userId, dataDir);
  const srcPath = itemFilePath(userId, dataDir, itemId);

  if (!existsSync(srcPath)) {
    throw Object.assign(new Error(`Item not found: ${itemId}`), { code: 'ITEM_NOT_FOUND' });
  }

  // R1 (BLOCKING from CP1 v1.14.4): same single-stat-then-read pair as updateItem.
  let fileMtimeMs = 0;
  if (options?.expectedEtag !== undefined) {
    const st = await stat(srcPath);
    fileMtimeMs = st.mtimeMs;
  }

  const raw = await readFile(srcPath, 'utf8');
  const outcome = parseItemFile(raw, itemId);
  // ... ITEM_MALFORMED handling identical to updateItem ...
  const { fm: parsedFm, notesBody, progressBody } = outcome.result;

  if (options?.expectedEtag !== undefined) {
    const currentEtag = computeETag(parsedFm, fileMtimeMs);
    if (!etagsMatch(options.expectedEtag, currentEtag)) {
      throw Object.assign(
        new Error(`ETag mismatch: expected ${options.expectedEtag}, got ${currentEtag}`),
        { code: 'ETAG_MISMATCH', actualEtag: currentEtag, currentFm: parsedFm, currentMtimeMs: fileMtimeMs },
      );
    }
  }

  // ... existing rewriteContent (with deletedAt stamp) + rename to .trash/ ...
}
```

**Handler-side binding (binding for Phase 2):**

```typescript
// src/webapp/items.mutate.ts — PATCH handler 412 build

try {
  const updated = await updateItem(userId, dataDir, itemId, storagePatch, { expectedEtag: ifMatch });
  // ... happy path: build response, set ETag header, audit ...
} catch (err: any) {
  if (err?.code === 'ETAG_MISMATCH') {
    // R1: build the 412 envelope from THE SAME parsedFm the storage layer just observed.
    // currentItem is derived directly from err.currentFm (no re-read; no re-stat).
    const currentItem = projectDetail({
      frontMatter: err.currentFm,
      notesBody: '',         // notes/progress not fetched here; clients re-GET if needed
      progressBody: '',
      filePath: '',
    });
    return res.status(412).json({
      ok: false,
      code: PRECONDITION_FAILED_CODE,
      error: 'Item changed since you opened it. Reload to see the latest, or use Save Anyway to overwrite.',
      currentEtag: err.actualEtag,
      currentItem,
    });
  }
  // ... other error handling ...
}
```

**Trade-off: 412 envelope's `currentItem` doesn't have `notesBody`/`progressBody`.** The storage layer's `parseItemFile` returns them, but the storage error throws BEFORE the handler-side decision to include them. Two options:

  - **Option A (chosen):** the 412 envelope's `currentItem` is the FrontMatter projection only (matches `projectDetail` shape sans the notes/progress strings). The client's "Reload" button then issues a GET /:id to fetch the full notes/progress. **The two-step pattern is acceptable** because: (a) the conflict UI is a degraded path; one extra round-trip is fine; (b) the client already has the OLD notes/progress in the form; the Reload swaps them via the GET. **Spec the 412 `currentItem` as the metadata-only projection (id, title, type, due, status, tags, parentId, calendarEventId, createdAt, updated, mtimeMs); spec the full GET as the source of notes/progress.**

  - **Option B (rejected):** the storage layer ALSO reads notes/progress and includes them in the error. Doubles the storage primitive's surface; adds memory-pressure on race-window large-notes items. Below the bar.

Option A is the binding for v1.14.4. Document the metadata-only shape explicitly in D4.

**Tests required (Phase 2).** Add to `tests/integration/storage.concurrency.test.ts` (the file from v1.14.2 R8) and `tests/integration/webapp.organize.mutate.test.ts`:

  1. **Test R1-1 (storage-layer same-read invariant):** Call `updateItem(uid, dir, id, {title: 'X'}, {expectedEtag: '"T1"'})` against a file where the on-disk `updated:` is `T2` (mismatch). Verify the thrown error has `code: 'ETAG_MISMATCH'`, `actualEtag: '"T2"'`, AND `currentFm.title === <pre-X-title>` (the parsedFm before the patch was applied, NOT after).
  2. **Test R1-2 (chat-side path: zero stat overhead):** Call `updateItem(uid, dir, id, {title: 'X'})` (NO options arg). Spy on `fs.stat` — verify `stat` is NOT called. Sanity check that backcompat path is unchanged.
  3. **Test R1-3 (TOCTOU window — concurrent writer between stat and read):** Use the v1.14.2 R8 concurrency test pattern. Stat-then-read is bounded; verify that even if a concurrent `appendProgressEntry` interleaves between two `updateItem` calls, the 412 response's `currentEtag` matches a `currentItem` that is consistent with that ETag (round-trip: client GETs after 412; the GET's `etag` header equals the 412 response's `currentEtag`). This is the same-read invariant test at the wire level.
  4. **Test R1-4 (handler 412 envelope shape):** PATCH with stale If-Match → 412. Assert response body has BOTH `currentEtag` AND `currentItem` (with id, title, type, due, status, tags, parentId, calendarEventId, createdAt, updated, mtimeMs metadata fields), AND that `currentEtag` matches `currentItem.updated` (or `currentItem.mtimeMs`-derived ISO if `updated` is null) — the same-read invariant at the wire envelope level.
  5. **Test R1-5 (DELETE 412 envelope shape):** Same as R1-4 but DELETE. Verifies `softDeleteItem`'s same-read invariant.

**File/line impact.**

  - `src/organize/storage.ts:649-703` — REPLACE `updateItem` body per R1 binding above (~15 LOC delta from v1.14.3 baseline, +5 LOC for stat call + +10 LOC for ETag check block). New imports: `stat` from `node:fs/promises`; `computeETag, etagsMatch` from `./etag.js`. (Note: D7 etag.ts module is the dependency.)
  - `src/organize/storage.ts:709-769` — APPLY same pattern to `softDeleteItem` (~15 LOC delta).
  - `src/webapp/items.mutate.ts` — PATCH/DELETE/POST-/complete handlers' 412 build path uses `err.currentFm` (from R1) directly; no re-read.
  - `tests/integration/storage.concurrency.test.ts` — 3 tests above (~50 LOC).
  - `tests/integration/webapp.organize.mutate.test.ts` — 2 tests above (~30 LOC).

---

### R2 (HIGH — supersedes ADR 012 D5 + D10 audit-row shape) — `bypassAfter412` audit field; in-memory recent-412 LRU

**Concern (DA P2).** ADR 012 D10 at lines 600-628 specifies the audit detail shape's `etag` and `forced` fields. DA verified that the four-row taxonomy (D10 lines 604-607) does not distinguish between THREE meaningfully-different bypass populations:

  1. **Genuinely-malicious omission:** client deliberately strips If-Match to write without conflict detection. Audit row: `etag: null, forced: false`.
  2. **Header-stripped-by-transport:** Telegram WebApp variant strips non-standard headers. Audit row: `etag: null, forced: false` (identical to malicious).
  3. **User intentionally overriding via Save Anyway:** client sends `X-Force-Override: 1` header → `forced: true`. **But X-Force-Override is ALSO custom — vulnerable to the same stripping.** If stripped, the row looks like populations 1 + 2: `etag: null, forced: false`.

The forensic gap is: a Save Anyway with X-Force-Override stripped looks indistinguishable from a malicious-omission. Forensic queries can't separate intent from infrastructure.

**Decision — accept R2 in full.**

**R2 — track recent 412 in-memory; emit `bypassAfter412: true` for follow-ups.** Update D10's `WebappItemMutateDetail` interface to add `bypassAfter412?: boolean` (optional for backcompat). Update D5's Save Anyway handler binding to look up the recent-412 map.

**In-memory map shape:**

```typescript
// src/webapp/items.shared.ts (or items.mutate.ts module-scope)

interface RecentConflict {
  ts: number;            // Date.now() at the 412 event
  itemId: string;        // the item that conflicted (per-item TTL — different items don't bleed)
}

// Per-userId × per-itemId LRU. Capped at 100 entries; ~5 minute TTL.
// Process-restart loses state — accept transient-loss; the audit-log distinguishability
// is a forensic improvement, not a correctness primitive.
const RECENT_CONFLICT_TTL_MS = 5 * 60 * 1000;        // 5 minutes
const RECENT_CONFLICT_LRU_CAP = 100;

const recentConflicts: Map<string, RecentConflict> = new Map();
// key = `${userId}:${itemId}`

function noteConflict(userId: number, itemId: string): void {
  const key = `${userId}:${itemId}`;
  recentConflicts.set(key, { ts: Date.now(), itemId });
  // LRU eviction
  if (recentConflicts.size > RECENT_CONFLICT_LRU_CAP) {
    const oldest = recentConflicts.keys().next().value;
    if (oldest) recentConflicts.delete(oldest);
  }
}

function hasRecentConflict(userId: number, itemId: string): boolean {
  const key = `${userId}:${itemId}`;
  const entry = recentConflicts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.ts > RECENT_CONFLICT_TTL_MS) {
    recentConflicts.delete(key);
    return false;
  }
  return true;
}
```

**Audit row binding (PATCH/DELETE/POST-/complete handlers):**

  - On 412 emit: `noteConflict(userId, itemId)` BEFORE returning the response.
  - On a subsequent mutation with `forced: true` (X-Force-Override sent OR no If-Match + recent 412): set `bypassAfter412: true` if `hasRecentConflict(userId, itemId)` returns true; else `false`.
  - The audit row's three-population distinguishability:
    - `forced: true, bypassAfter412: true` → Save Anyway following a 412 (clear user intent; the X-Force-Override header DID reach the server OR the user just-saw-a-412-and-retried).
    - `forced: true, bypassAfter412: false` → Save Anyway WITHOUT a preceding 412 in the window. Possibly a force-probe (header set without seeing a conflict). Forensically interesting.
    - `forced: false, bypassAfter412: true` → no X-Force-Override BUT there was a recent 412 → header-stripped-by-transport OR buggy client (the user DID see a conflict but the override didn't propagate).
    - `forced: false, bypassAfter412: false` → naïve no-If-Match (legitimately-old client; no recent conflict).

**v1.14.5+ alerting follow-up (TODO).** File a v1.14.5+ TODO: "If `forced: true` count > 3 within 24h for any single userId, surface an audit-log alert via the existing audit-query path." v1.14.4 ships only the audit field; alerting query is deferred. Per R3 below.

**Tests required (Phase 2).** Add to `tests/integration/webapp.organize.mutate.test.ts`:

  1. **Test R2-1 (force-probe — no preceding 412):** PATCH with `X-Force-Override: 1` (no If-Match) → 200; audit row `forced: true, bypassAfter412: false` (distinguishes intentional force from override-after-conflict).
  2. **Test R2-2 (Save Anyway after 412):** PATCH with stale If-Match → 412; same client retries within 5 min with `X-Force-Override: 1` (no If-Match) → 200; audit row `forced: true, bypassAfter412: true`.
  3. **Test R2-3 (header-stripped scenario):** PATCH with stale If-Match → 412; same client retries WITHOUT X-Force-Override AND without If-Match → 200; audit row `forced: false, bypassAfter412: true` (the conflict-detection-bypass-by-omission is now distinguishable from naïve-no-If-Match).
  4. **Test R2-4 (TTL expiry):** PATCH with stale If-Match → 412; wait 6 minutes (or simulate via injected clock); same client retries with `X-Force-Override: 1` → audit row `forced: true, bypassAfter412: false` (TTL expired; treated as fresh force-probe).
  5. **Test R2-5 (LRU eviction):** Trigger 412s on 101 different items by 1 user; the first 412 should be evicted from the map. Test verifies LRU semantics aren't a correctness regression (negative-cache miss is acceptable).

**File/line impact.**

  - `src/webapp/items.shared.ts` — `RecentConflict` map + `noteConflict` + `hasRecentConflict` helpers (~25 LOC).
  - `src/webapp/items.mutate.ts` — call `noteConflict` on every 412 emission (3 sites: PATCH, DELETE, POST-/complete); call `hasRecentConflict` on every audit emit for `forced: true` paths.
  - `WebappItemMutateDetail` (in `items.shared.ts`) — add `bypassAfter412?: boolean` field.
  - `tests/integration/webapp.organize.mutate.test.ts` — 5 tests above (~60 LOC).

---

### R6 (HIGH — supersedes ADR 012 D8 implicit "stat always" interpretation) — Conditional `fs.stat` binding in `updateItem` JSDoc

**Concern (DA P12).** ADR 012 D8 at line 504-540 introduces an `expectedEtag` option; the example pseudocode at lines 527-535 references `fileMtimeMs` without showing the stat call. Verified at storage.ts:649-703: current `updateItem` has no `fs.stat`. A naive Phase-2 implementation might add `fs.stat` UNCONDITIONALLY (every chat-side `organize_update` and `organize_complete` call gains a `stat()` round-trip — ~50µs each, but accreting). Anti-Slop W2 separately calls for explicit JSDoc on the storage signature change.

**Decision — accept R6 in full; bind in JSDoc per R1 above.**

**R6 — JSDoc explicitness for the conditional stat.** The R1 binding above includes the explicit JSDoc. Repeated here for emphasis; this is the v1.14.4 storage primitive's contract:

> **JSDoc for `updateItem` (and `softDeleteItem`):**
>
> *"If `options.expectedEtag` is set, this function performs ONE `fs.stat` call (to obtain `mtimeMs` for the legacy-ETag fallback path) AND ONE `fs.readFile` call (to obtain front-matter), then computes `currentEtag` from THAT (parsedFm, mtimeMs) pair. On mismatch, throws `Error & { code: 'ETAG_MISMATCH', actualEtag, currentFm, currentMtimeMs }` carrying the same observation the handler uses for the 412 envelope. NO re-read; NO re-stat after the throw.*
>
> *If `options.expectedEtag` is undefined (chat-side callers `organize_update.ts`, `organize_complete.ts`), this function does NOT call `fs.stat` — the legacy behavior from v1.14.3 is preserved. Chat-side callers pay zero overhead for v1.14.4's ETag work."*

**Cost guarantee.** Phase 2 verifies via test R1-2 (above) that `fs.stat` is not called when `options` is absent. The conditional is the contract; the test is the enforcement.

**Tests required (Phase 2).** R1-2 (above) covers this. No additional test beyond R1.

**File/line impact.**

  - `src/organize/storage.ts:649-703` — JSDoc binding (per R1). No additional LOC beyond R1's bundle.

---

### RA1 (Anti-Slop RA1 — supersedes ADR 012 D2/D5/D7/D12/D13/D15 inline magic strings) — Wire-protocol constants enumeration

**Concern (Anti-Slop RA1).** ADR 012 introduces FOUR new wire-level magic strings (`'ETag'`, `'If-Match'`, `'X-Force-Override'`, `'PRECONDITION_FAILED'`) plus the value `'1'` for the X-Force-Override truthiness check. The strings appear inline across a dozen sites (server-side: items.read.ts GET handler; items.mutate.ts PATCH/DELETE/POST-/complete handlers; items.shared.ts ifMatchCheck; etag.ts; client-side: app.js fetch headers + 412 handler + Save Anyway flow + tests). A typo at any one site is a silent bug. Anti-Slop §4 wants named constants. Additionally, the v1.14.3 F2 carry-forward (toast magic-ms inline literals) actively GROWS in v1.14.4 (D5 line 803 `showToast(..., 4000)` and D12 line 792 `showToast(..., 3000)`) — the same client edit can close F2 by consolidating.

**Decision — accept RA1 in full; consolidate at one well-scoped location per side.**

**RA1 — Server-side constants in `src/webapp/etag-headers.ts` (NEW file, ~12 LOC).** A new file (not co-located with `etag.ts` because the header names are webapp-wire-protocol, not framework-agnostic ETag computation):

```typescript
// src/webapp/etag-headers.ts (NEW)

/** v1.14.4 — wire-protocol header names + force-override value, single source of truth. */
export const ETAG_HEADER = 'ETag';
export const IF_MATCH_HEADER = 'If-Match';
export const FORCE_OVERRIDE_HEADER = 'X-Force-Override';
export const FORCE_OVERRIDE_VALUE = '1';
export const PRECONDITION_FAILED_CODE = 'PRECONDITION_FAILED';

/** v1.14.4 R2 — audit-row field name for bypass-after-412 forensics (string literal kept
 *  here so the audit emit + the audit query both reference the same source.) */
export const AUDIT_FIELD_BYPASS_AFTER_412 = 'bypassAfter412';
```

**Cross-imports (binding):**

  - `src/webapp/items.read.ts`: `import { ETAG_HEADER } from './etag-headers.js';` — used at GET /:id to set the response header.
  - `src/webapp/items.mutate.ts`: `import { ETAG_HEADER, IF_MATCH_HEADER, FORCE_OVERRIDE_HEADER, FORCE_OVERRIDE_VALUE, PRECONDITION_FAILED_CODE } from './etag-headers.js';` — used at all three mutation handlers + the 412 envelope build.
  - `src/webapp/items.shared.ts`: `import { IF_MATCH_HEADER, FORCE_OVERRIDE_HEADER, FORCE_OVERRIDE_VALUE, PRECONDITION_FAILED_CODE } from './etag-headers.js';` — used in `ifMatchCheck`.
  - Tests: `tests/integration/webapp.organize.mutate.test.ts` and `tests/integration/storage.concurrency.test.ts` — import the constants for header sends and assertions.

**RA1 — Client-side constants block at the top of `app.js` (~10 LOC; alongside the existing v1.14.3 W1 block at :47-51).** Vanilla JS doesn't have ESM-shared constants with the server; client-side has a separate (but matching by convention) constants block:

```javascript
// public/webapp/organize/app.js — top-of-file constants block (extends v1.14.3 W1 block)

// v1.14.3 W1 carry (preserved):
const CHAR_COUNTER_WARN_THRESHOLD = 0.8;
const DIFF_WARN_THRESHOLD_LINES = 3;
const COLLAPSE_STATE_KEY = 'organize-collapse-state-v1';
const NOTES_MAX = 10240;
const PROGRESS_MAX = 20480;

// v1.14.4 RA1 — wire-protocol header names (mirror server-side etag-headers.ts):
const ETAG_HEADER = 'ETag';
const IF_MATCH_HEADER = 'If-Match';
const FORCE_OVERRIDE_HEADER = 'X-Force-Override';
const FORCE_OVERRIDE_VALUE = '1';

// v1.14.4 RA1 (closes v1.14.3 F2 carry-forward) — toast duration constants:
const TOAST_DEFAULT_MS = 3000;
const TOAST_LONG_MS = 5000;        // pre-v1.14.4 stale-warn carry; sunset with R2 per D6
const TOAST_RESTORE_MS = 8000;     // restore-success toast (existing)
const TOAST_OVERRIDE_MS = 4000;    // v1.14.4 D5 — Save Anyway success ("Note: another change was overridden")
// NOTE: no CONFLICT_UI_TIMEOUT_MS — the conflict panel is dismissed by user action (Reload/Save Anyway/Cancel),
// not by timeout. If a future iteration adds an auto-dismiss, add it here.
```

**Phase 2 grep enforcement.** After implementation, Phase 2 dev runs:

```bash
# Server-side: should match ZERO results (all replaced with named constants)
rg "['\"]ETag['\"]" src/webapp/                         # tolerance: response.set('ETag', ...) is the only allowed inline
rg "['\"]If-Match['\"]" src/webapp/
rg "['\"]X-Force-Override['\"]" src/webapp/
rg "['\"]PRECONDITION_FAILED['\"]" src/webapp/
# Client-side: should match ZERO results (all replaced with named constants)
rg "['\"]X-Force-Override['\"]" public/webapp/organize/app.js
rg "showToast\([^,]+,\s*\d+\s*\)" public/webapp/organize/app.js   # inline ms literals in showToast
```

Each should return zero matches OR exactly the constants-definition site. If non-zero (ignoring the definition site), a follow-up commit consolidates.

**Tests required (Phase 2).** No new tests for constants themselves (the consumers' integration tests provide coverage). But the W1 below (closes RA1 W1) requires the test files import the same constants from `etag-headers.ts` — if the constants drift between source and test, the tests catch the drift.

**File/line impact.**

  - `src/webapp/etag-headers.ts` (NEW) — ~12 LOC.
  - `src/webapp/items.read.ts` — replace inline `'ETag'` at GET handler with `ETAG_HEADER` import.
  - `src/webapp/items.mutate.ts` — replace inline strings at PATCH/DELETE/POST-/complete handlers + 412 envelope build (~5-8 sites).
  - `src/webapp/items.shared.ts` — replace inline strings in `ifMatchCheck` (~3 sites).
  - `public/webapp/organize/app.js` — top-of-file constants block ~10 LOC; replace inline `'ETag'` / `'If-Match'` / `'X-Force-Override'` / `'1'` at fetch headers + Save Anyway flow + 412 handler (~6-10 sites); replace inline ms literals at `showToast(...)` calls (~12+ sites; closes v1.14.3 F2).

---

### RA2 (Anti-Slop RA2 — supersedes ADR 012 silent omission of KNOWN_ISSUES.md and CLAUDE.md updates) — Documentation enumeration; avoid 8th-iteration regression

**Concern (Anti-Slop RA2).** ADR 012 has ZERO references to `KNOWN_ISSUES.md` or `CLAUDE.md`. v1.14.3 Phase 2 closed RA3 with 8 KNOWN_ISSUES.md entries + a NEW project-root CLAUDE.md (3 topics). Anti-Slop called that the "first closure in 7 iterations" — a recently-paid-down debt. Without enumeration in this revisions document, Phase 2 dev-agents reading ADR 012 literally will not update either file, and the institutional-memory carry-forward returns at iteration 8.

**Decision — accept RA2 in full; bind enumerated entries below.**

**RA2 — KNOWN_ISSUES.md additions (Phase 2 dev appends to `D:\ai-jarvis\KNOWN_ISSUES.md`):**

  1. **ETag computation (`updated:`-based; mtime fallback for legacy items).** Symptom: pre-v1.14.3 items with `updated: null` use `mtime`-derived ETag; first v1.14.3+ edit immediately stamps `updated:` and the ETag stabilizes on it. Fix: D1 + D7 (`computeETag(fm, fileMtimeMs)` in `src/organize/etag.ts` is the single source of truth). Prevention: every write path that modifies content stamps `updated:` (D1 invariant). Reference: ADR 012 D1, D7; this revisions doc R5.

  2. **ETag format: strong, value = `"<updated-iso>"` for items with `updated:`; `"<mtime-iso>"` fallback for older items.** Symptom: byte-level ETag string is the quoted ISO timestamp. Cause: D1 chosen because `updated:` is the existing v1.14.3 monotonic-stamp source. Fix: spec-only; no code-bug. Prevention: when adding new write paths, ensure they stamp `updated:` per the v1.14.3 D1 discipline.

  3. **If-Match required-when-present (optional-for-backcompat).** Symptom: client that omits If-Match silently bypasses conflict detection. Cause: v1.14.4 D3 chose backcompat over strict. Fix: D3 + R2 (`bypassAfter412: true` distinguishes the populations forensically). Prevention: v1.15.0+ strict mode (per `?strict=1` future contract; D16). Reference: ADR 012 D3; this revisions doc R2.

  4. **412 Precondition Failed envelope shape (`currentEtag` + `currentItem` metadata in body).** Symptom: 412 response carries metadata-only `currentItem` (no notes/progress); client must GET /:id for full body. Cause: D4 + R1 — same-read invariant requires `currentItem` derived from the parsedFm the storage layer just observed; notes/progress excluded from the storage error to keep the surface bounded. Fix: client's "Reload" button issues a follow-up GET. Prevention: documented at D4 line 252-258 + this revisions doc R1.

  5. **Save Anyway path (`X-Force-Override: 1` header).** Symptom: client sends header to bypass If-Match check; audit row records `forced: true`. Fix: D5 + R2 — `bypassAfter412` audit field distinguishes intentional force from header-stripped scenarios. Prevention: v1.14.5+ alerting on `forced: true` count > 3 in 24h (TODO filed; D16 + R3). Reference: ADR 012 D5; this revisions doc R2 + R3.

  6. **POST /complete no-op fast-path.** Symptom: when target state matches current state, skip storage write entirely (no ETag check, no audit row). Cause: R4 — eliminates the ceremony from D9 for the common idempotent-call case. Fix: handler-level check before storage call. Prevention: tests T16/T17/T18/T19 + a new no-op fast-path test (R4).

  7. **R2 X-Captured-Mtime sunset.** Symptom: v1.14.2 R2 staleWarning toast no longer fires; v1.14.4 emits 412 on conflict instead. Cause: D6 — If-Match strictly subsumes X-Captured-Mtime. Fix: code REMOVED from items.mutate.ts (per D6's enumerated file:line ranges). Prevention: T26 + T27 sunset assertions ensure the `staleWarning` field and `webapp.stale_edit` audit rows are not emitted.

  8. **TOCTOU same-read invariant in `updateItem` and `softDeleteItem`.** Symptom: a naive D8 implementation could call `fs.stat` and `readFile` separately, allowing a concurrent writer to make the storage-layer ETAG_MISMATCH inconsistent with the handler's 412 envelope. Fix: R1 — single stat-then-read pair; error carries `currentFm` + `currentMtimeMs`; handler builds 412 from THAT observation. Prevention: tests R1-1 through R1-5.

  9. **DELETE-specific conflict UI (no Reload button).** Symptom: 412 on DELETE has same shape as 412 on PATCH but the conflict UI is different — Cancel + Delete Anyway, NO Reload (reload wouldn't help since user wants to delete). Cause: R9 — semantic difference between mutate-and-reload vs delete. Fix: client-side conflict-panel render branches on the originating mutation (PATCH→Reload+Save Anyway+Cancel; DELETE→Delete Anyway+Cancel). Reference: ADR 012 D5/D12; this revisions doc R9.

  10. **List-flow POST /complete cannot send If-Match.** Symptom: list-card complete-checkbox doesn't have per-item ETag (D2); the optimistic-flip path doesn't send If-Match; concurrent two-tab race silently overrides another tab's just-completed item. Cause: D2 declined per-item-list-ETag (anti-gold-plating); D9 documents the uncloseable race. Fix: documented uncloseable; mitigated by R18 absolute-write semantic (data corruption case is closed) + R4 no-op fast-path (idempotent calls bypass even the audit ceremony). Prevention: future per-item-list-ETag is filed in D16 as a v1.16.0+ candidate.

**RA2 — CLAUDE.md additions (Phase 2 dev appends to `D:\ai-jarvis\CLAUDE.md`, alongside the v1.14.3 RA3 topics):**

  a. **ETag header naming (v1.14.4).** Standard response header `ETag` and request header `If-Match` per RFC 7232. ONE custom header: `X-Force-Override: 1` for the Save Anyway path. No CORS preflight needed in same-origin deployment (cloudflared tunnel forwards all headers). Future multi-origin deployment requires either (a) listing X-Force-Override in CORS preflight `Access-Control-Allow-Headers`, or (b) replacing with a body field. Reference: ADR 012 D2 + D5 + D13; this revisions doc R8.

  b. **TOCTOU invariant for `updateItem.options.expectedEtag` (v1.14.4 R1).** The storage primitive's ETag check MUST share the read with the FrontMatter that drives the response. Specifically: `fs.stat` + `readFile` happen in ONE atomic block; `currentEtag` is computed from THAT pair; on mismatch, the thrown error carries `currentFm` + `currentMtimeMs` from THAT read; the handler builds the 412 envelope from THAT observation WITHOUT re-reading or re-stat'ing. Adding a separate stat or read between the check and the response is a regression — the conflict UI would display an inconsistent state. Reference: ADR 012 D8; this revisions doc R1.

  c. **Concurrent /complete: three layers compose (v1.14.2 R18 + v1.14.4 D9 + v1.14.4 R4).** POST /complete has three independent safety mechanisms that compose in a specific order: **(1) R4 no-op fast-path (v1.14.4)** — runs FIRST; if `body.done === currentStatus`, return 200 with current item, no write, no audit row, no ETag check. **(2) D9 If-Match check (v1.14.4)** — runs SECOND for the actual state-change path; required-when-present per D3; 412 on mismatch. **(3) R18 absolute-write semantic (v1.14.2)** — runs THIRD inside `updateItem`; `{done: true}` always sets status='done' regardless of current state, so even if If-Match was absent, the data-corruption case is closed. Documented order matters: changing the order to e.g. ETag-check-before-no-op would force unnecessary 412s on idempotent calls. Reference: ADR 010 R18; ADR 012 D9; this revisions doc R4.

**File/line impact.**

  - `D:\ai-jarvis\KNOWN_ISSUES.md` — append 10 entries (~50 LOC).
  - `D:\ai-jarvis\CLAUDE.md` — append 3 topics (~15 LOC).
  - Phase 2 dev verifies after implementation that grep for "v1.14.4" in both files matches the expected sections.

---

### R3 (MEDIUM — supersedes ADR 012 D5's "no friction-on-repeat" implicit) — Audit-only telemetry; v1.14.5+ alerting query

**Concern (DA P1 / R3).** ADR 012 D5 picks (5a) yes / (5b) yes / (5c) no — Save Anyway is allowed; logged via `forced: true`; no second confirm. DA argued for friction-on-repeat (R3 friction-on-repeat counter OR (a) 3-second countdown OR (c) type-OVERWRITE). The architect's CP1.2 prepared response is defensible.

**Decision — accept R3 as audit-only telemetry; no UX friction in v1.14.4.**

**R3 — Audit-only telemetry.** v1.14.4 ships only the audit field extension (R2 above adds `bypassAfter412`; D10 already specifies `forced`). The alerting query — "if `forced: true` count > 3 within 24h for any single userId, surface an alert" — is filed as a v1.14.5+ TODO via the existing audit-query path. v1.14.4 does NOT add UX friction (countdown, type-OVERWRITE, friction-on-repeat counter).

**Reasoning.**

  1. **Webapp is single-user.** UX friction punishes legitimate use. The user is the only operator; trust boundary is owner-only; reflexive Save Anyway is the user overriding their own past decision, not a hostile actor.
  2. **Audit trail is sufficient forensics.** With R2's `bypassAfter412` field, the audit log distinguishes intentional force from header-stripped scenarios. Retrospective review of the audit log answers the "did I make a mistake?" question without UX cost.
  3. **v1.14.5+ alerting is the right slot for friction.** Once the audit log accumulates real data, an alerting query (e.g., "show me items where `forced: true` count > 3 in 24h" via `audit_log` SQL primitives) gives the user FORENSIC visibility — a one-page admin micro-view that lists recent forced overrides. UX friction at the conflict UI is the wrong tool; retrospective surfacing is the right tool.

**v1.14.5+ TODO entry (binding for ADR 012 D16 supplement):**

| TODO | Target | Reasoning |
|---|---|---|
| Audit-log alerting query for high-frequency `forced: true` | v1.14.5+ | R3 deferral; surfaces the forced-override pattern via existing audit-query path; ~20 LOC + 1 micro-view. |

**File/line impact.**

  - `D:\ai-jarvis\TODO.md` — add v1.14.5+ entry (1 LOC).

---

### R4 (MEDIUM — supersedes ADR 012 D9 implicit "always check If-Match" for /complete) — POST /complete no-op fast-path

**Concern (DA P6 / R4).** ADR 012 D9 specifies POST /complete with required-when-present If-Match. DA argued: when `body.done === currentStatus` (the call is a no-op — user is marking-done an already-done item, or marking-not-done an already-not-done item), the ETag ceremony adds friction without benefit. No state changes; no race window; no need for 412.

**Decision — accept R4 in full.**

**R4 — handler-level no-op fast-path.** Update D9's POST /complete handler binding to add a fast-path:

```typescript
// src/webapp/items.mutate.ts — POST /:id/complete handler

const currentItemRaw = await readItem(userId, dataDir, itemId);
const currentStatus = currentItemRaw.frontMatter.status;
const targetStatus = body.done ? 'done' : 'active';

// R4 (CP1 v1.14.4 MEDIUM): no-op fast-path — if target state matches current, skip the
// write entirely (no ETag check, no audit row).
if (currentStatus === targetStatus) {
  // Log for observability; no audit emit.
  log.info({ userId, itemId, targetStatus }, 'organize complete: no-op (current state matches target)');
  // Return 200 with the unchanged item; ETag header reflects current state.
  const currentEtag = computeETag(currentItemRaw.frontMatter, /* mtime-from-stat */);
  res.set(ETAG_HEADER, currentEtag);
  return res.json({ ok: true, item: projectDetail(currentItemRaw) });
}

// ELSE: proceed with If-Match check (D9) + storage write (R18 absolute-write).
const ifMatchResult = ifMatchCheck(req, currentItemRaw.frontMatter, /* mtime */);
// ... existing D9 + R18 binding ...
```

**Reasoning.**

  1. **Idempotency wins.** The user's mental model: "marking done an already-done item should be a no-op." The fast-path matches.
  2. **Eliminates list-flow racing.** The list-card complete-checkbox sometimes generates spurious POST /complete calls (e.g., user double-taps; client-side debounce isn't perfect). With the no-op fast-path, these have ZERO data-corruption risk and ZERO audit-noise.
  3. **Bypasses 412 unnecessarily.** Without R4, a stale list-flow POST `{done: true}` against an already-done item would fire If-Match check; if absent (list flow) → audit-noisy 200; if present (detail flow) → potential 412. With R4, both paths short-circuit to 200 with no audit row.
  4. **No data-integrity risk.** The write would be a no-op anyway (R18 absolute-write `{done: true}` against `status: 'done'` produces the same bytes). Skipping it just removes the ETag-check + audit-row ceremony.

**Trade-off.** The no-op fast-path means `forced: true` audit rows are NOT emitted for no-op POST /complete calls. The user CANNOT force-override a no-op; the no-op short-circuits before the X-Force-Override check. This is fine — there's nothing to override.

**Tests required (Phase 2).** Add to `tests/integration/webapp.organize.mutate.test.ts`:

  1. **Test R4-1 (no-op done→done):** POST /:id/complete `{done: true}` against an item with `status: 'done'` → 200; `currentItemRaw` unchanged; NO audit row in `webapp.item_mutate`; NO ETag check (verifiable by stale If-Match → still 200, not 412).
  2. **Test R4-2 (no-op active→active):** POST /:id/complete `{done: false}` against an item with `status: 'active'` → 200; same assertions.
  3. **Test R4-3 (state-change still requires If-Match):** POST /:id/complete `{done: true}` against an item with `status: 'active'` and a stale If-Match → 412 (verifies the fast-path doesn't bypass conflict detection for actual state changes).

**File/line impact.**

  - `src/webapp/items.mutate.ts` — POST /:id/complete handler (~10 LOC delta for the fast-path branch).
  - `tests/integration/webapp.organize.mutate.test.ts` — 3 tests above (~30 LOC).

---

### R5 (MEDIUM — supersedes ADR 012 D1 implicit "FAT mtime is fine") — Document FAT/exFAT mtime resolution invariant

**Concern (DA P3 / R5).** ADR 012 D1 specifies the mtime fallback for legacy items: `new Date(stat.mtimeMs).toISOString()`. NTFS/ext4/APFS resolution is sub-millisecond; FAT/exFAT resolution is 2 seconds. DA traced the FAT scenario carefully and concluded the design is correct — the FIRST v1.14.3+ write to a legacy item stamps `updated:`, immediately taking precedence over the mtime — but the architect's spec doesn't explicitly call this out.

**Decision — accept R5 as documentation-only.**

**R5 — Add an explicit FAT-mtime invariant note to D1.** The text below is bound for inclusion in ADR 012's D1 section (and for KNOWN_ISSUES.md entry #1 per RA2 above):

> *"v1.14.4 fallback ETag uses `new Date(stat.mtimeMs).toISOString()`. Filesystem mtime resolution varies by FS:*
>
>   - *NTFS / ext4 / APFS: sub-millisecond resolution. Two PATCHes within 1ms produce distinct mtimes; mtime-based ETag is collision-safe.*
>   - *FAT / exFAT: 2-second resolution. Theoretical collision window of 2s. Mitigated by:*
>     - *(a) every `updateItem` write stamps `updated:` (D1 v1.14.3 discipline) — the fallback path is consumed on FIRST edit; subsequent ETags are `updated:`-based, not mtime-based.*
>     - *(b) the v1.14.4 D8 storage-level ETag check (R1) is TOCTOU-safe; even within the 2-second FAT window, two concurrent first-edits are detected by the storage-layer same-read check.*
>
> *ETag drift requires (a) FAT/exFAT filesystem AND (b) older item never edited since v1.14.3 deployment AND (c) two concurrent first-edits within 2s. The compound condition is acceptable for v1.14.4. If a future iteration removes `updated:` stamping (regression), the FAT concern reopens — see D1 stamping invariant."*

**No code change.** Documentation-only; the binding is honest about a real edge case.

**File/line impact.**

  - ADR 012 D1 — text addition (this revisions doc IS the binding artifact; ADR 012 itself is not edited).
  - `D:\ai-jarvis\KNOWN_ISSUES.md` — entry #1 covers this (per RA2).

---

### R8 (MEDIUM — supersedes ADR 012 D13 implicit "X- header just works") — Document X-Force-Override deployment posture

**Concern (DA P8 / R8).** ADR 012 D13 chose `X-Force-Override: 1` as a custom header. DA flagged: in same-origin deployment (cloudflared tunnel today), custom headers reach the Express server unimpeded — no CORS preflight, no header filtering. But the ADR is silent on the multi-origin case (a future v1.15.0+ deployment that splits webapp from API origin).

**Decision — accept R8 as documentation-only.**

**R8 — Add an explicit deployment posture note to D13.** The text below is bound for inclusion in ADR 012's D13 section (and for CLAUDE.md topic (a) per RA2 above):

> *"Custom request header `X-Force-Override: 1` reaches the Express server today because deployment is same-origin: the webapp and `/api/webapp/*` are served from the same cloudflared tunnel; cloudflared forwards all headers transparently; no CORS preflight is invoked. Future multi-origin deployment (e.g., webapp at `app.jarvis.example.com`, API at `api.jarvis.example.com`) would invoke a CORS preflight for ANY request with `If-Match` or `X-Force-Override` (both are non-simple headers per Fetch spec). Resolution paths:*
>
>   - *(a) List the headers in the API server's CORS preflight `Access-Control-Allow-Headers` response (~3 LOC server-side; preferred for backwards compat).*
>   - *(b) Replace `X-Force-Override` with a body field `{forceOverride: true}` (~10 LOC validator update; preserves the wire shape but moves the force flag from headers to JSON body; transport-resilient against header stripping).*
>
> *v1.14.4 ships the header. v1.15.0+ multi-tenant work re-evaluates and picks (a) or (b). v1.14.4 audit forensics already distinguish header-stripped scenarios via R2's `bypassAfter412` field, so the multi-origin migration has a graceful path."*

**No code change.** Documentation-only.

**File/line impact.**

  - ADR 012 D13 — text addition (this revisions doc IS the binding artifact).
  - `D:\ai-jarvis\CLAUDE.md` — topic (a) covers this (per RA2).

---

### R9 (MEDIUM — supersedes ADR 012 D5/D12 implicit "all conflicts are PATCH-shape") — DELETE-specific conflict UI

**Concern (DA P11 / R9).** ADR 012 D5 + D12 specify the conflict-panel UX with three buttons: Reload, Save Anyway, Cancel. The Reload button works for PATCH conflicts (user wants to see the new state, then re-edit). For DELETE conflicts, Reload is meaningless — the user wanted to delete; reloading just shows the now-modified item but the user's intent (delete) is unchanged. The DELETE conflict UI needs different buttons.

**Decision — accept R9 in full.**

**R9 — DELETE conflict UI binding.** The 412 response shape is the SAME for PATCH and DELETE (both carry `currentEtag` + `currentItem` per D4). The CLIENT-side conflict panel branches on the originating mutation:

  - **PATCH conflict UI:** three buttons — `[Reload]` `[Save Anyway]` `[Cancel]`. (Per D12.) The user can reload to see latest, force the override, or abandon.
  - **DELETE conflict UI (NEW):** two buttons — `[Cancel]` `[Delete Anyway]`. NO Reload button. The text: *"Item changed since you opened it. Cancel deletion or delete anyway?"* On Delete Anyway: client retries DELETE without If-Match; same audit `forced: true` + `bypassAfter412` pattern as Save Anyway (per R2).

**Server-side handling for "Delete Anyway":** identical to Save Anyway path on PATCH — the DELETE handler reads `X-Force-Override: 1`; if set, skip the If-Match check; proceed with `softDeleteItem`; emit audit row with `forced: true` + `bypassAfter412` per R2.

**Tests required (Phase 2).** Add to `tests/integration/webapp.organize.mutate.test.ts`:

  1. **Test R9-1 (DELETE 412 envelope):** DELETE with stale If-Match → 412 with `currentEtag` + `currentItem` (same shape as PATCH 412).
  2. **Test R9-2 (Delete Anyway path):** DELETE with stale If-Match → 412; client retries DELETE with `X-Force-Override: 1` (no If-Match) → 200; audit row `forced: true, bypassAfter412: true` (per R2).
  3. **Test R9-3 (DELETE force-probe — no preceding 412):** DELETE with `X-Force-Override: 1` (no If-Match, no preceding 412) → 200; audit row `forced: true, bypassAfter412: false`.

(Also covered by R1-5 above for the same-read invariant.)

**Client-side test (jsdom, optional):** Add to `tests/unit/webapp.organize.editForm.test.ts` (or NEW): render the conflict panel with `originatingMutation: 'delete'` → assert two buttons present (Cancel + Delete Anyway); render with `originatingMutation: 'patch'` → assert three buttons present (Reload + Save Anyway + Cancel).

**File/line impact.**

  - `public/webapp/organize/app.js` — conflict-panel render branches on originating mutation (~10 LOC).
  - `public/webapp/organize/index.html` — conflict-panel template carries both layouts OR a single layout with conditional buttons (~5-8 LOC).
  - `tests/integration/webapp.organize.mutate.test.ts` — 3 tests above (~25 LOC).
  - `tests/unit/webapp.organize.editForm.test.ts` — 1-2 jsdom tests (optional; ~15 LOC).

---

### R7 (MEDIUM — DEFERRED to v1.14.5) — Same-device cross-tab BroadcastChannel sync

**Concern (DA P4 / R7).** DA proposed ~15 LOC client-side BroadcastChannel API to sync ETag state across tabs of the same device. Closes the multi-tab race scenario where Tab 1's mutation invalidates Tab 2's baseline without Tab 2 noticing.

**Decision — DEFER to v1.14.5.**

**R7 — Defer.** v1.14.4's scope is ETag/If-Match/412 server-side + the 412 conflict UI. BroadcastChannel adds a separate client-only feature surface (cross-tab signaling) that:

  1. Has its own architecture decisions (BroadcastChannel vs SharedWorker vs storage-events vs polling).
  2. Has its own browser-compatibility surface (Telegram WebApp's BroadcastChannel support is unverified across platforms).
  3. Has its own UX surface (does Tab 2 silently update? show a "another tab updated this" toast? auto-reload?).
  4. Adds 15-30 LOC + ~5 jsdom tests + manual cross-tab QA.

Folding it into v1.14.4 dilutes the iteration's focus. v1.14.5 has a clean slot for client-only enhancements; BroadcastChannel fits cleanly there alongside the deferred `mtimeMs` retire, `/organize trash list`, and possibly the v1.14.5+ alerting query (R3).

**v1.14.5 TODO entry (binding for D16 supplement):**

| TODO | Target | Reasoning |
|---|---|---|
| Cross-tab ETag sync via BroadcastChannel | v1.14.5 | R7 deferral; ~15 LOC client; client-only iteration; closes the multi-tab race (D9 list-flow uncloseable case) for same-device scenarios. |

**No file impact in v1.14.4.**

---

### W1 (Anti-Slop W1) — Constants enumeration in tests + server-side

**Decision (accept W1).** Closes simultaneously with RA1 (above). The new constants in `src/webapp/etag-headers.ts` are imported by `tests/integration/webapp.organize.mutate.test.ts` and `tests/integration/storage.concurrency.test.ts` for header sends and assertions. The client-side constants block in `app.js` (per RA1) is enumerated. Phase 2 grep enforcement (per RA1) verifies zero residual inline magic strings post-implementation.

**File/line impact.** Covered by RA1 (above).

---

### W2 (Anti-Slop W2) — Storage primitive signature change explicit JSDoc; ETAG_MISMATCH error class

**Decision (accept W2).** Closes simultaneously with R1 (above). The `updateItem` and `softDeleteItem` JSDoc binding in R1 explicitly documents:
  - The `options.expectedEtag` semantics.
  - The conditional-stat behavior (chat-side path: zero overhead).
  - The thrown error shape (`Error & { code: 'ETAG_MISMATCH', actualEtag, currentFm, currentMtimeMs }`).
  - The same-read invariant (no re-read; no re-stat after the throw).

**Error-class pattern.** Per Anti-Slop C3 cosmetic carry-forward, the codebase precedent is `Object.assign(new Error(...), { code: '...' })` rather than TypeScript double-cast `as Error & { ... }`. R1's binding above uses `Object.assign` for consistency.

**File/line impact.** Covered by R1 (above).

---

### W3 (Anti-Slop W3) — Toast-ms consolidation (closes v1.14.3 F2 carry-forward)

**Decision (accept W3).** Closes simultaneously with RA1 (above). The client-side constants block in `app.js` (per RA1) includes the toast-ms constants:

```javascript
const TOAST_DEFAULT_MS = 3000;
const TOAST_LONG_MS = 5000;
const TOAST_RESTORE_MS = 8000;
const TOAST_OVERRIDE_MS = 4000;
```

All inline `showToast(..., <number>)` literals across `app.js` get replaced with the named constants. Phase 2 grep enforcement (per RA1) verifies zero residual `showToast\(..., \d+\)` literals.

**File/line impact.** Covered by RA1 (above).

---

### W4 (Anti-Slop W4) — Force-probe test (no preceding 412 distinguishes from intentional override)

**Decision (accept W4).** Closes simultaneously with R2 (above). Test R2-1 (force-probe) AND test R2-2 (Save Anyway after 412) AND test R2-3 (header-stripped scenario) are the three-population distinguishability tests. Test R2-1 specifically asserts that `forced: true, bypassAfter412: false` distinguishes a force-probe (X-Force-Override sent without seeing a conflict) from an intentional override (force after 412).

**File/line impact.** Covered by R2 (above).

---

### W5 (Anti-Slop W5) — Test count by ADR decision; D6 sunset assertions

**Decision (accept W5).** ADR 012 D11's 26-case test matrix is preserved. Additions from this revisions doc:

  - **R1:** 5 tests (R1-1 through R1-5).
  - **R2:** 5 tests (R2-1 through R2-5).
  - **R4:** 3 tests (R4-1 through R4-3).
  - **R9:** 3 tests (R9-1 through R9-3) + 1-2 jsdom (optional).

**D6 sunset assertions explicit.** Per W5's binding, T26 and T27 already cover the route-level assertions (no `staleWarning` field; no `webapp.stale_edit` rows). W5 also calls for HELPER deletion assertions:

  - **Test T26-helper:** grep / static check that `auditStaleEdit` and `countProgressLines` helpers are NOT present in `items.mutate.ts` post-implementation. This is a Phase 2 dev-checklist item rather than a runtime test (~1 LOC of grep enforcement).

Total test count (v1.14.4 + revisions): 26 (D11) + 5 (R1) + 5 (R2) + 3 (R4) + 3 (R9) + 1 (T26-helper grep) + a few X-Force-Override probing variants per W4 (covered by R2-1) = **~43 cases**. Up from the 26 in D11; all additive, no test removed.

**File/line impact.** Covered by R1, R2, R4, R9 above. T26-helper grep is a Phase 2 implementation step.

---

### W6 (Anti-Slop W6) — Numbered Phase-2 implementation steps

**Decision (accept W6).** Add to ADR 012 a §Phase 2 implementation order section with numbered steps:

> **Phase 2 implementation order (v1.14.4):**
>
> 1. `src/organize/etag.ts` (NEW) — `computeETag(fm, fileMtimeMs)`, `etagsMatch(a, b)`. Pure helpers; no Express; no IO. Imports from `./types.js`. (D7)
> 2. `src/webapp/etag-headers.ts` (NEW) — `ETAG_HEADER`, `IF_MATCH_HEADER`, `FORCE_OVERRIDE_HEADER`, `FORCE_OVERRIDE_VALUE`, `PRECONDITION_FAILED_CODE`, `AUDIT_FIELD_BYPASS_AFTER_412`. (RA1)
> 3. `src/organize/storage.ts` — `updateItem` gains `options?: { expectedEtag?: string }`; conditional `fs.stat` + `readFile` SAME-READ block; throws `Error & { code: 'ETAG_MISMATCH', actualEtag, currentFm, currentMtimeMs }` on mismatch. (R1 BLOCKING + R6 + W2)
> 4. `src/organize/storage.ts` — `softDeleteItem` gains the same options; same SAME-READ pattern. (R1)
> 5. `src/webapp/items.shared.ts` — `ifMatchCheck` helper; `WebappItemMutateDetail` extension (`etag`, `forced`, `bypassAfter412`); `auditItemMutate` signature gain; `noteConflict` + `hasRecentConflict` recent-412 LRU map. (D15 + D10 + R2)
> 6. `src/webapp/items.read.ts` — set `ETag` header on GET /:id response. (D2)
> 7. `src/webapp/items.mutate.ts` — D6 sunset (DELETE the X-Captured-Mtime block + `auditStaleEdit` helper + `countProgressLines` helper + `staleWarning` decoration at PATCH/DELETE/POST-/complete responses; ~110 LOC removed).
> 8. `src/webapp/items.mutate.ts` — PATCH handler gets If-Match + 412 envelope + audit `etag/forced/bypassAfter412` + 200 ETag header set. (D3 + D4 + D5 + D10 + R1 412-build + R2 audit)
> 9. `src/webapp/items.mutate.ts` — DELETE handler same shape (D3 + D4 + D5 + D10 + R1 + R2 + R9 — but note R9 conflict-UI is client-side only).
> 10. `src/webapp/items.mutate.ts` — POST /:id/complete handler with R4 no-op fast-path + D9 If-Match (state-change path) + R18 absolute-write semantic.
> 11. `public/webapp/organize/app.js` — top-of-file constants block (RA1 + W3); `currentDetailEtag` state; If-Match sends + ETag receives; conflict panel render (PATCH 3-button + DELETE 2-button per R9); `capturedMtime` removal (D6 sunset).
> 12. `public/webapp/organize/index.html` — conflict-panel `<div>`; conditional button layouts.
> 13. `public/webapp/organize/styles.css` — conflict panel styling.
> 14. `tests/unit/organize/etag.test.ts` (NEW) — 5 unit tests for `computeETag` + `etagsMatch`. (D11 T1-T5)
> 15. `tests/integration/storage.concurrency.test.ts` — extend with R1-1, R1-2, R1-3 (storage-layer same-read invariant + chat-side zero-overhead + TOCTOU window). Build on the v1.14.2 R8 concurrency test scaffold.
> 16. `tests/integration/webapp.organize.mutate.test.ts` — extend with all wire-shape tests: D11 T6-T27 + R1-4, R1-5 (handler 412 envelope) + R2-1 through R2-5 (bypassAfter412 distinguishability) + R4-1, R4-2, R4-3 (no-op fast-path) + R9-1, R9-2, R9-3 (DELETE-specific). Plus the X-Force-Override probing test from W4 (covered by R2-1).
> 17. `tests/unit/webapp.organize.editForm.test.ts` (extend or NEW) — optional jsdom tests for client conflict-flow state machine (~5 cases per W1) + 1-2 R9 conflict-panel button tests.
> 18. Phase 2 dev-checklist grep: zero `'ETag'`, `'If-Match'`, `'X-Force-Override'`, `'PRECONDITION_FAILED'`, `'1'` (X-Force-Override value) magic-string residue in `src/webapp/`; zero `showToast(..., \d+)` inline ms literals in `app.js`; zero `auditStaleEdit` or `countProgressLines` helper definitions in `items.mutate.ts` (D6 sunset W5 verification).
> 19. `D:\ai-jarvis\KNOWN_ISSUES.md` — append 10 entries per RA2.
> 20. `D:\ai-jarvis\CLAUDE.md` — append 3 topics per RA2.
> 21. `D:\ai-jarvis\TODO.md` — add R3 (audit alerting) + R7 (BroadcastChannel) v1.14.5 entries; carry forward the v1.14.5 entries from D16.
> 22. Version: `package.json` 1.14.3 → 1.14.4; `CHANGELOG.md` entry; commit + tag `v1.14.4`.

22 numbered steps. Phase 2 dev-agents follow this order; the storage-layer SAME-READ invariant (steps 3-4) lands BEFORE any handler edits (step 5+), and the constants files (steps 1-2) land BEFORE any consumer.

**File/line impact.** Documentation only — this revisions doc IS the binding artifact.

---

## Pushbacks (the architect disagrees with, with justification)

**None.** All 9 R-revisions, 2 RAs, and 6 warnings are accepted with the following A/B resolutions:

  - **R1 same-read invariant** — non-negotiable. Storage-layer ETAG_MISMATCH error carries `currentFm` + `currentMtimeMs` so the handler builds the 412 envelope from the SAME observation. The alternative (handler re-reads after 412) would create a TOCTOU window that ships the bug DA flagged.

  - **R2 over R2-alt (body-field for force)** — engineering-best because it closes the forensic gap without changing the validated PATCH body shape. R2-alt (move force flag to body) was a transport-resilience improvement that closed a different concern (X-Force-Override stripping); R2 is orthogonal and complementary. Both is gold-plated. v1.14.4 ships R2; R2-alt could be adopted in v1.15.0+ multi-origin work alongside the CORS posture decision (R8).

  - **R3 audit-only telemetry over UX friction** — webapp is single-user; UX friction punishes legitimate use; audit trail is sufficient forensics; v1.14.5+ alerting query is the right slot for retrospective surfacing.

  - **R5 documentation-only over FAT detection migration** — DA agreed with the documentation-only path; the FAT scenario IS closed by the D1 + D8 design, just not explicitly documented.

  - **R7 deferred to v1.14.5** — v1.14.4 server-side scope holds; BroadcastChannel adds a separate client-only feature surface that benefits from its own iteration. Filed in TODO.md.

  - **R9 DELETE-specific conflict UI** — accept in full. PATCH-shape Reload button doesn't fit DELETE; the user wanted to delete, not see latest.

  - **W1+W3 close with RA1; W2 closes with R1; W4 closes with R2; W5+W6 close with their own enumeration.** Convergence: every Anti-Slop warning has a binding closure path through a DA R-revision OR through a dedicated W binding.

The architect did not push back on any DA finding or Anti-Slop finding because each was either (a) a real correctness gap verified in code (R1 BLOCKING — `storage.ts:649-703` confirmed has no fs.stat; the spec leaked this); (b) a forensic-visibility improvement that strictly enriches the audit log (R2 `bypassAfter412`; R8 deployment doc); (c) a UX simplification that matches user intent (R4 no-op fast-path; R9 DELETE conflict UI); (d) a documentation honesty that the architect should have included (R5 FAT-mtime; R6 conditional stat; R8 X-header deployment); (e) a process discipline regression (RA2 KNOWN_ISSUES + CLAUDE.md enumeration); or (f) constants consolidation that converges with v1.14.3's W1 closure (RA1 + W3).

---

## File-impact summary table (Phase 2 dev reference)

| File | Status | Change driver(s) |
|---|---|---|
| `src/organize/etag.ts` | NEW | D7 — `computeETag(fm, fileMtimeMs)` + `etagsMatch(a, b)`; ~30 LOC |
| `src/webapp/etag-headers.ts` | NEW | **RA1** — wire-protocol header names + constants; ~12 LOC |
| `src/organize/storage.ts` | EDIT | D8 — `updateItem` + `softDeleteItem` gain `options.expectedEtag`; **R1 BLOCKING + R6 + W2** — same-read invariant (single fs.stat + readFile pair; ETAG_MISMATCH error carries currentFm + currentMtimeMs); conditional stat for backcompat |
| `src/webapp/items.shared.ts` | EDIT | D15 — `ifMatchCheck` helper; D10 — `WebappItemMutateDetail` extension; **R2** — `bypassAfter412` field, `RecentConflict` map, `noteConflict`, `hasRecentConflict` LRU helpers (~25 LOC additional) |
| `src/webapp/items.read.ts` | EDIT | D2 — set `ETag` header on GET /:id response (~5 LOC); **RA1** — use `ETAG_HEADER` constant |
| `src/webapp/items.mutate.ts` | EDIT | D6 sunset (~-110 LOC: X-Captured-Mtime + `auditStaleEdit` helper + `countProgressLines` helper + `staleWarning` decorations); **D3 + D4 + D5 + D10 + R1 + R2** — If-Match check + 412 envelope (built from `err.currentFm`) + Save Anyway flow + audit `etag/forced/bypassAfter412` (~+90 LOC); **R4** — no-op fast-path on POST /complete (~10 LOC); **RA1** — use header constants |
| `public/webapp/organize/app.js` | EDIT | **RA1 + W3** — top-of-file constants block (~22 LOC: header constants + toast-ms constants closing v1.14.3 F2); D6 sunset (`capturedMtime`, X-Captured-Mtime sends, staleWarning toast — `~-30 LOC`); **D12 + R9** — `currentDetailEtag` state, conflict panel render (PATCH 3-button + DELETE 2-button), Reload/Save Anyway/Cancel/Delete Anyway handlers (~+50 LOC) |
| `public/webapp/organize/index.html` | EDIT | D5 — conflict-panel `<div>`; **R9** — conditional button layouts |
| `public/webapp/organize/styles.css` | EDIT | D5 — conflict panel styling |
| `tests/unit/organize/etag.test.ts` | NEW | D11 T1-T5 — 5 unit tests for computeETag + etagsMatch |
| `tests/integration/storage.concurrency.test.ts` | EDIT | Extends v1.14.2 R8 scaffold; adds **R1-1, R1-2, R1-3** (storage-layer same-read invariant + chat-side zero-overhead stat + TOCTOU window + concurrent PATCH double-check) |
| `tests/integration/webapp.organize.mutate.test.ts` | EDIT | D11 T6-T27 wire-shape tests; **R1-4, R1-5** (handler 412 envelope same-read); **R2-1 through R2-5** (bypassAfter412 forensic distinguishability + force-probe per W4 + LRU TTL); **R4-1, R4-2, R4-3** (no-op fast-path); **R9-1, R9-2, R9-3** (DELETE-specific); **W5** — D6 sunset assertions T26 + T27 |
| `tests/unit/webapp.organize.editForm.test.ts` | EDIT or NEW | W1 (optional) — ~5 jsdom cases for client conflict-flow state machine; **R9** — 1-2 conflict-panel button-layout tests |
| `D:\ai-jarvis\KNOWN_ISSUES.md` | EDIT | **RA2** — append 10 entries (~50 LOC) |
| `D:\ai-jarvis\CLAUDE.md` | EDIT | **RA2** — append 3 topics (~15 LOC) |
| `D:\ai-jarvis\TODO.md` | EDIT | **R3** (v1.14.5+ alerting query); **R7** (v1.14.5 BroadcastChannel cross-tab sync); D16 carry-forward (`mtimeMs` retire, `/organize trash list`) |

**Net new files:** 3 (`src/organize/etag.ts`, `src/webapp/etag-headers.ts`, `tests/unit/organize/etag.test.ts`). The storage-concurrency test file already exists (from v1.14.2 R8 scaffold). The editForm jsdom test is OPTIONAL.

**Net delta vs original ADR 012 file plan:**

  - `src/webapp/etag-headers.ts` was implicitly going to be inline strings in original ADR 012; now a NEW dedicated constants module (RA1).
  - `src/organize/storage.ts` was going to gain `+10 LOC` per ADR 012 D15; now `+15-20 LOC` for the R1 same-read binding (one-time stat call + the ETAG_MISMATCH error class with `currentFm` + `currentMtimeMs` payload).
  - `src/webapp/items.shared.ts` was going to grow by `+25 LOC` per D15; now `+50 LOC` for the additional `RecentConflict` LRU map + `noteConflict`/`hasRecentConflict` helpers + `bypassAfter412` audit field (R2).
  - `src/webapp/items.mutate.ts` was going to net `-20 LOC` per D15 (516 → ~496); R4 no-op fast-path adds `+10 LOC`; final estimate ~506 LOC. **Stays within the soft 500-LOC threshold (or marginally above; if the threshold is hard, the helper extraction can absorb).**
  - `public/webapp/organize/app.js` extends with the R9 DELETE-specific conflict-panel branch (~+10 LOC) and the RA1 constants block (~+22 LOC), for a net `+40-50 LOC` vs the original `+20 LOC` estimate.
  - `tests/unit/organize/etag.test.ts` is NEW (D7).
  - `tests/integration/storage.concurrency.test.ts` extends with R1 tests (~+50 LOC).
  - `tests/integration/webapp.organize.mutate.test.ts` extends with R1, R2, R4, R9 tests (~+115 LOC over the D11 baseline).
  - `KNOWN_ISSUES.md` enumerates 10 entries (RA2).
  - `CLAUDE.md` enumerates 3 topics (RA2).
  - `TODO.md` adds R3 + R7 entries.

---

## Final R-list (numbered, ordered by file impact for Phase 2 dev)

This list is the binding sequence Phase 2 dev implements. Order is by file impact (BLOCKING fix first; constants modules second to unblock everything else; storage layer third; tests last).

| # | Decision | Source | Summary | Primary file |
|---|---|---|---|---|
| **R1** (BLOCKING) | TOCTOU same-read invariant in `updateItem` + `softDeleteItem` | DA P7 | Single fs.stat + readFile pair; ETAG_MISMATCH error carries `currentFm` + `currentMtimeMs`; handler builds 412 from the SAME observation; 5 tests (R1-1 through R1-5) | `src/organize/storage.ts` |
| **RA1** | Wire-protocol constants enumeration + toast-ms consolidation | Anti-Slop RA1 (closes v1.14.3 F2 carry-forward) + W1 + W3 | NEW `src/webapp/etag-headers.ts` (server constants); top-of-file constants block in `app.js` (client constants + toast-ms); Phase 2 grep enforcement | `src/webapp/etag-headers.ts` (NEW), `public/webapp/organize/app.js` |
| **R6 / W2** (HIGH) | Conditional fs.stat binding in JSDoc | DA P12, Anti-Slop W2 | JSDoc explicitness: `options.expectedEtag` controls whether fs.stat is called; chat-side path (no options) pays zero overhead; ETAG_MISMATCH error class via `Object.assign` per C3 | `src/organize/storage.ts` |
| **R2** (HIGH) | `bypassAfter412` audit field + recent-412 LRU | DA P2 | In-memory `Map<userId:itemId, RecentConflict>` 5-min TTL LRU 100; emit `bypassAfter412: true` for follow-ups; distinguishes 4 audit-row populations forensically; 5 tests (R2-1 through R2-5; closes W4) | `src/webapp/items.shared.ts`, `src/webapp/items.mutate.ts` |
| **RA2** | KNOWN_ISSUES.md + CLAUDE.md enumeration | Anti-Slop RA2 (avoid 8th-iter regression of v1.14.3 RA3) | 10 KNOWN_ISSUES.md entries + 3 CLAUDE.md topics; Phase 2 dev appends; factory follow-up flagged | `KNOWN_ISSUES.md`, `CLAUDE.md` |
| **R4** | POST /complete no-op fast-path | DA P6 | When target state matches current, skip storage write entirely (no ETag check, no audit row); 3 tests (R4-1 through R4-3) | `src/webapp/items.mutate.ts` |
| **R9** | DELETE-specific conflict UI | DA P11 | DELETE 412 same shape as PATCH; client-side conflict panel branches: PATCH 3-button (Reload + Save Anyway + Cancel); DELETE 2-button (Cancel + Delete Anyway); 3 integration tests + 1-2 jsdom | `public/webapp/organize/app.js`, `public/webapp/organize/index.html` |
| **R3** | Audit-only telemetry; v1.14.5+ alerting deferred | DA P1 | No UX friction in v1.14.4; ships only the audit field (R2's `bypassAfter412`); v1.14.5+ TODO for alerting query | `D:\ai-jarvis\TODO.md` |
| **R5** | FAT-mtime invariant documentation | DA P3 | ADR addendum text for D1; FAT 2-second resolution acceptable because (a) first edit stamps `updated:`; (b) D8 same-read invariant closes the race | (revisions-doc + KNOWN_ISSUES.md entry #1) |
| **R8** | X-Force-Override deployment posture documentation | DA P8 | ADR addendum text for D13; same-origin today (cloudflared); v1.15.0+ multi-origin requires CORS preflight Allow-Headers OR body-field migration | (revisions-doc + CLAUDE.md topic (a)) |
| **R7** (DEFERRED) | Cross-tab BroadcastChannel sync | DA P4 | DEFERRED to v1.14.5; client-only iteration; ~15 LOC + jsdom + manual cross-tab QA | `D:\ai-jarvis\TODO.md` |
| W4 | Force-probe test (no preceding 412 distinguishes from intentional override) | Anti-Slop W4 | Closes with R2 (test R2-1); audit row distinguishes 4 populations | (covered by R2 tests) |
| W5 | Test count by ADR decision; D6 sunset helper-deletion grep | Anti-Slop W5 | T26 + T27 wire-shape sunset assertions; T26-helper grep verifies `auditStaleEdit` + `countProgressLines` are deleted (not just unreferenced); ~43 total tests | (covered by R1, R2, R4, R9 + Phase 2 dev-checklist grep) |
| W6 | Numbered Phase-2 implementation steps | Anti-Slop W6 | 22 numbered steps in this revisions doc | (revisions-doc) |

**Net total:** 1 BLOCKING (R1) + 2 HIGH (R2 audit, R6 conditional stat) + 2 RAs (RA1 constants, RA2 docs) + 5 MEDIUM accepted (R3 audit-only, R4 no-op, R5 FAT doc, R8 deployment doc, R9 DELETE UI) + 1 DEFERRED (R7) + 6 W accepted (W1+W3 close with RA1; W2 with R1; W4 with R2; W5+W6 each their own) = 17 R-revision units.

**Convergence with v1.14.2 → v1.14.3 → v1.14.4 contracts:** zero R-revision contradictions. v1.14.2's R8 random-tmp-suffix preserved (R1's stat + readFile pair runs INSIDE updateItem's existing flow, upstream of writeAtomically). v1.14.3's `updated:` stamping discipline preserved (R1's same-read invariant relies on `parsedFm.updated` as the canonical ETag input). v1.14.4's R2 X-Captured-Mtime sunset (D6) is intentional and explicit — schema retention (`webapp.stale_edit` audit category) is forward-compat. The v1.14.5+ candidates (R3 alerting query, R7 BroadcastChannel, D16's `mtimeMs` retire + `/organize trash list`) form a coherent next-iteration scope.

---

## Phase-2 readiness verdict

**READY.** All BLOCKING + HIGH + RA + MEDIUM revisions resolved with binding implementation specifications. Phase 2 dev agents implement per the §Phase 2 implementation order (W6) above; deviations require another addendum.

R1 lands as the FIRST commit of Phase 2 (the same-read invariant in `updateItem` + `softDeleteItem` is the foundation for every handler change). RA1's constants files (`etag.ts` + `etag-headers.ts`) land as steps 1-2 (BEFORE any consumer). RA2's docs land in the documentation commit just before the v1.14.4 tag. R7's BroadcastChannel work is filed in TODO.md for v1.14.5; v1.14.4 does not block on it.

The convergence with the v1.14.3 → v1.14.4 contracts is clean: zero R-revision contradictions; the `updated:` stamping discipline (v1.14.3 D1) + the random-tmp-suffix (v1.14.2 R8) + the absolute-write semantic (v1.14.2 R18) all compose with v1.14.4's same-read invariant (R1) + If-Match required-when-present (D3) + no-op fast-path (R4). The v1.14.4 hard-deadline ETag work closes the v1.14.3 race-window posture properly; v1.14.5+ work picks up R3 alerting + R7 BroadcastChannel + D16's deferred items.

End of CP1 revisions for v1.14.4.
