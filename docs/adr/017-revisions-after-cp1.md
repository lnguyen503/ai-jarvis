# ADR 017 — Revisions after CP1 debate (2026-04-25)

**Parent:** `017-v1.17.0-power-user-toolkit.md`
**Status:** Accepted. Folded into ADR 017 by reference. Phase 2 dev agents implement the revised spec; deviations require another addendum.

**Context.** Devil's Advocate review (`docs/reviews/cp1-devils-advocate-v1.17.0.md`) raised **1 BLOCKING + 3 HIGH + 6 MEDIUM + 7 OK** with numbered R-revisions. Anti-Slop Phase 1 review (`docs/reviews/anti-slop-phase1-review-v1.17.0.md`) raised **0 Required Actions (RA1 carry-forward only) + 4 Warnings (W1–W4) + 2 cosmetic Findings (F1, F2)**. **Convergence signal #1:** DA P3 (BLOCKING — `cron-parser` introduces a NEW npm dep, violating the user's firm "no new npm deps" rule established across iterations) is convergent with the architect's own Phase 1 hesitation (D7 line 254 says "Architect's preference: cron-parser over hand-rolled iteration" but defers to dep-list verification). The user has been firm — `node-cron` lacks a next-fire iterator, so the architect rolls our own ~80-LOC bounded iterator instead. **Convergence signal #2:** Anti-Slop F1 (sentinel format behavioral contradiction — D8 line 312 says `{key:my_pref}`; CP1 surface row 11 + Risk #6 say `<!-- key:my_pref -->`) is convergent with DA P-style "two-source-of-truth" smell. Architect picks `<!-- key:my_pref -->` (HTML comment) and propagates throughout. **Convergence signal #3:** DA P3 (HIGH — `userMemoryEntries.ts` sole-writer invariant unenforced; existing `userMemory.ts.appendUserMemoryEntry()` doesn't gate keyed entries) is convergent with Anti-Slop §6 defense-in-depth posture; architect binds the sole-writer invariant in CLAUDE.md.

The architect resolves the BLOCKING with: **(R1) `cron-parser` REJECTED; roll-our-own ~120-LOC bounded iterator at `src/scheduler/cronPreview.ts`** (5 match-bitmaps + minute-by-minute walk + dual termination conditions). Accepts every HIGH (R2 cap binding + Feb-31/Apr-31/Feb-29 explicit tests; R3 sole-writer invariant via CLAUDE.md + read-time fallback to `legacy_<sha8>` synthetic key; R6 audit category closed-set validation with `INVALID_CATEGORY` 400 + parameterized SQL), accepts every MEDIUM (R4 audit refresh-from-top semantics; R5 memory edit double-submit guard reusing v1.14.6 D15+R6 pattern; R7 hub tile mobile responsive `flex-wrap` + 140px min-width; R8 cron action field via textContent; R9 audit `detail_json` 16KB display cap + textContent in `<pre>`), accepts every Anti-Slop warning (W1 pre-extraction grep manifest as Phase 2 commit -1 binding; W2 cron day-of-week normalization — `presetToCron` emits the shorter form; W3 deterministic gate H scan for raw `: value` field names in audit shared modules; W4 ETag hash function shape `sha256(mtime || body).slice(0, 16)`), accepts F1 sentinel-resolution + F2 KI 7+10 expansions, updates RA1 (7th consecutive iteration enumeration) with two new KI entries.

**The BLOCKING (R1) MUST land before Phase 2 commit 1 proceeds.** R1 is a NEW file `src/scheduler/cronPreview.ts` (~120 LOC of pure JS; no external deps; bounded loop by construction). The original D7 binding to `cron-parser` is RESCINDED; the architect's hesitation in D7 line 254 ("Architect's preference: cron-parser over hand-rolled iteration") is reversed in light of the user's firm "no new npm deps" rule. node-cron stays as the only existing cron library (used in `src/scheduler/index.ts:1` for actual scheduling); cronPreview.ts is a sibling-helper that reuses node-cron's `cron.validate()` for syntax check then runs its own bounded fire-time iterator.

This revisions document supersedes the relevant clauses of ADR 017 by reference; the parent ADR is not edited.

---

## Resolved (R-numbered, ordered by Phase 2 commit ordering)

### R1 (BLOCKING — supersedes ADR 017 D7 lines 209-258 + §3.1 row `package.json`) — `cron-parser` REJECTED; roll-our-own bounded cron preview iterator

**Concern (DA P3 BLOCKING).** D7 line 248 says: "use `cron-parser` lib (better fit; verify package.json — if not present, add it as a Phase 2 dep; ~30KB gzip; well-maintained; same author as node-cron)." This violates the user's firm "no new npm deps" rule established across iterations. node-cron has no next-fire iterator API; D7 acknowledges this on line 254 ("node-cron does not expose a 'next-N-fires' iterator"). The architect's stated preference for `cron-parser` over hand-rolled iteration ("avoid leap-year / DST edge cases") is a code-complexity concern that does NOT outweigh the user's dep-discipline rule.

**Decision — reject `cron-parser`; implement a bounded ~120-LOC pure-JS cron evaluator at `src/scheduler/cronPreview.ts`. node-cron stays as the single existing cron library (used by `src/scheduler/index.ts:1` for actual scheduling).**

**D7.a — Cron preview implementation algorithm (binding for Phase 2; supersedes D7 lines 209-258).**

Algorithm: parse a 5-field cron expression into 5 match-bitmaps; walk minute-by-minute from `now + 1 minute`; for each minute check membership in all 5 bitmaps; collect first 5 matches; dual termination.

```typescript
// src/scheduler/cronPreview.ts (NEW; ~120 LOC; ZERO external deps)

const MAX_PREVIEW_ITERATIONS = 525_600;  // minutes in 1 year (365 × 1440)
const MAX_PREVIEW_RESULTS = 5;

export interface PreviewResult {
  ok: true;
  fireTimes: string[];      // ISO 8601 UTC; up to 5; empty = no fire in next year
  warning?: string;          // populated when fireTimes.length < MAX_PREVIEW_RESULTS at exhaustion
}

export interface PreviewError {
  ok: false;
  code: 'INVALID_EXPR';
  error: string;             // human-readable reason
}

interface ParsedCron {
  minute: Set<number>;       // 0..59
  hour: Set<number>;         // 0..23
  dom: Set<number>;          // 1..31
  month: Set<number>;        // 1..12
  dow: Set<number>;          // 0..6 (0 = Sunday; 7 mapped to 0)
}

/** Parse a single field; supports `*`, `*/N` (N>0), `A-B`, `A,B,C`, plain integer. */
function parseField(field: string, min: number, max: number): Set<number> | null {
  // Reject literal `*/0` and any zero step, negative numbers, out-of-range
  // Returns null on invalid input.
  // …
}

/** Parse the full 5-field expression. Reject expressions with !=5 whitespace-separated fields. */
function parseCron(expr: string): ParsedCron | null { /* … */ }

/** Compute next 5 fire times within 525,600 iterations from `now` (default Date.now()). */
export function previewCronFireTimes(expr: string, now?: Date): PreviewResult | PreviewError {
  // 1. cron.validate(expr) — node-cron's syntax check (already in deps).
  // 2. Reject pathological forms cron.validate misses (`*/0`, extra fields, negatives).
  // 3. Parse into 5 bitmaps.
  // 4. Walk minute-by-minute starting at floor(now to next minute):
  //      iterations = 0
  //      while iterations < MAX_PREVIEW_ITERATIONS && fireTimes.length < MAX_PREVIEW_RESULTS:
  //        check if (cur.minute, cur.hour, cur.dom, cur.month, cur.dow) all match
  //        if match: push ISO 8601 string
  //        cur += 1 minute
  //        iterations++
  // 5. If fireTimes.length === 0 at exit: return ok: true, [], warning: "no fires in next 365 days".
  // 6. Else if iterations === MAX_PREVIEW_ITERATIONS && fireTimes.length < 5: return ok: true, fireTimes, warning: "iteration cap reached".
  // 7. Else return ok: true, fireTimes (no warning).
}
```

**Bounded by construction.** Pure JS iterator with hard cap of 525,600 iterations per call. Each iteration does 5 Set.has() lookups (O(1)). Worst case: ~2.5M ops, ~10ms wall clock on commodity hardware. NO `setTimeout` race needed; NO event-loop yield required (10ms is acceptable single-tick block on Node).

**Day-of-week normalization (binding — supersedes D2 line 80 + Anti-Slop W2 closure).** `presetToCron(presetKey, params)` emits the shorter form for day-of-week ranges:
  - `1-5` for Mon-Fri (NOT `1,2,3,4,5`).
  - `1,3,5` for Mon-Wed-Fri (sparse list — short form unchanged).
  - `0,6` for weekend.
  - `cronToPreset(expr)` MUST recognize BOTH forms as equivalent — `1-5` and `1,2,3,4,5` both map to "Every weekday at HH:MM"; `0,6` and `6,0` both map to "Every weekend at HH:MM" (sort the list before compare).

**Pathological-input rejection (binding for Phase 2).** Reject at parse time:
  - `*/0` in any field → `INVALID_EXPR: Step values cannot be zero`.
  - `60 * * * *` (minute out of range) → `INVALID_EXPR: Minute field out of range (0..59)`.
  - `* * 32 * *` (dom out of range) → `INVALID_EXPR: Day-of-month field out of range (1..31)`.
  - `* * * 13 *` (month out of range) → `INVALID_EXPR: Month field out of range (1..12)`.
  - `* * * * 8` (dow out of range — only 0..7 with 7=Sunday alias accepted) → `INVALID_EXPR: Day-of-week field out of range (0..7)`.
  - Negative numbers anywhere → `INVALID_EXPR`.
  - !=5 fields → `INVALID_EXPR`.

**No-fire expressions (binding).** Expressions like `0 0 31 2 *` (Feb 31), `0 0 31 4 *` (Apr 31), `0 0 30 2 *` (Feb 30), `0 0 29 2 *` (Feb 29 in non-leap year — depends on `now`) iterate the full year and return `fireTimes: []` with `warning: "This expression doesn't fire in the next 365 days — check the day-of-month + month combination."`.

**Tests required (Phase 2; supersedes §3.3 row 1's 8-test count → 12 tests).**

  1. **Test R1-1 (parseField round-trip):** 12 canonical cron expressions parse + serialize cleanly: `* * * * *`, `*/5 * * * *`, `0 9 * * *`, `0 9 * * 1-5`, `0 9 * * 1,3,5`, `0 9 * * 0,6`, `*/15 9-17 * * 1-5`, `30 4 1 * *`, `0 0 1 1 *`, `0 0 * * 0`, `45 23 * * *`, `0 8-18/2 * * 1-5`.
  2. **Test R1-2 (`*/0` rejection):** Each of `*/0 * * * *`, `* */0 * * *`, `* * */0 * *`, `* * * */0 *`, `* * * * */0` returns `INVALID_EXPR`.
  3. **Test R1-3 (out-of-range rejection):** `60 * * * *`, `* 24 * * *`, `* * 32 * *`, `* * * 13 *`, `* * * * 8` each return `INVALID_EXPR`.
  4. **Test R1-4 (Feb-31 non-firing):** `0 0 31 2 *` returns `ok: true, fireTimes: [], warning: <…>`.
  5. **Test R1-5 (Apr-31 non-firing):** `0 0 31 4 *` returns `ok: true, fireTimes: [], warning: <…>`.
  6. **Test R1-6 (Feb-30 non-firing):** `0 0 30 2 *` returns `ok: true, fireTimes: [], warning: <…>`.
  7. **Test R1-7 (Feb-29 non-leap-year):** `0 0 29 2 *` with `now = 2026-01-01` (2027 not a leap year) — assert next fire is `2028-02-29` OR empty + warning depending on iteration cap; document the actual behavior in the test.
  8. **Test R1-8 (negative-number rejection):** `* * -1 * *` returns `INVALID_EXPR`.
  9. **Test R1-9 (extra/missing fields):** `* * * *` (4 fields) and `* * * * * *` (6 fields) return `INVALID_EXPR`.
  10. **Test R1-10 (deterministic clock):** Pass `now = new Date('2026-04-25T09:00:00.000Z')`; assert `*/5 * * * *` returns `['2026-04-25T09:05:00.000Z', '2026-04-25T09:10:00.000Z', ...]`.
  11. **Test R1-11 (DOW normalization):** Both `0 9 * * 1-5` and `0 9 * * 1,2,3,4,5` produce identical fire-time lists.
  12. **Test R1-12 (iteration-cap warning):** Construct a contrived expression that fires once per year (e.g., `0 0 1 1 *`); with `now = mid-year`, expect 1 fire within 525,600 iterations; assert `warning` populated.

**File/line impact.**

  - `src/scheduler/cronPreview.ts` (NEW) — **+~120 LOC** (parser + matcher + iterator).
  - `src/webapp/scheduled.preview.ts` — imports `previewCronFireTimes` from `../scheduler/cronPreview.js` (NOT cron-parser); **±0** (still ~60 LOC; just the import target changed).
  - `package.json` — REMOVE the planned `cron-parser` dep addition; **net 0** (no dep added; D7's `+1` LOC delta in §3.1 is rescinded).
  - `tests/integration/scheduler.preview.test.ts` (renamed from D7 test file): **+~250 LOC** (12 tests; up from 8 in §3.3).
  - ADR 017 D7 prose updated to point at D7.a (cronPreview.ts) as canonical binding; D7's "Phase 2 dep note (binding): node-cron does not expose a 'next-N-fires' iterator. cron-parser does (`CronExpression.next()`); add it as a runtime dep" is RESCINDED.

---

### R2 (HIGH — supersedes ADR 017 D7 lines 256-258 + Risk #1) — Bind 365-day cap explicitly + explicit Feb-31/Apr-31/Feb-29/Feb-30 test cases

**Concern (DA P2 HIGH).** D7's "Why the 365-day cap" prose (lines 256-258) describes intent ("any reasonable cron fires at least yearly") but doesn't bind the constants or the dual termination semantics. Feb 31 / Apr 31 / Feb 29 (non-leap-year) / Feb 30 are pathologically slow inputs that walk the full year before returning empty; without bounded iteration they could loop forever.

**Decision — bind D7.b cap constants + dual-termination semantics.**

**D7.b — Cap binding (binding for Phase 2; supersedes D7 lines 256-258).**

  - `MAX_PREVIEW_ITERATIONS = 525_600` (minutes in 1 year = 365 × 1440).
  - `MAX_PREVIEW_RESULTS = 5`.
  - Iterator stops at the FIRST condition met (whichever happens first):
    - `iterations >= MAX_PREVIEW_ITERATIONS`, OR
    - `fireTimes.length >= MAX_PREVIEW_RESULTS`.
  - If iterations exhausted (`>= MAX_PREVIEW_ITERATIONS`) with `fireTimes.length < MAX_PREVIEW_RESULTS`: return `ok: true` with whatever was collected + warning string (one of: "no fires in next 365 days" if length === 0; "iteration cap reached after collecting N fires" if 0 < length < 5).

R1 supersedes the original "timeout-bounded; server response budget < 1s" prose from §7 Risk #1 — the pure-JS bounded iterator is correct by construction; no `setTimeout` race / no async yield needed.

**Tests required (Phase 2; covered by R1 tests R1-4 / R1-5 / R1-6 / R1-7 / R1-12).** No new test files; the explicit Feb-31 / Apr-31 / Feb-30 / Feb-29 cases are R1-4 through R1-7. R1-12 covers the iteration-cap-with-partial-results warning.

**File/line impact.**

  - `src/scheduler/cronPreview.ts` — bind `MAX_PREVIEW_ITERATIONS` + `MAX_PREVIEW_RESULTS` as `const`s at top of file; ~2 LOC of constants + comments. Already covered in R1 ~120 LOC.
  - ADR 017 D7 prose updated per D7.b above.
  - ADR 017 §7 Risk #1 prose updated: "node-cron timeout-bounded" struck; replaced with "pure-JS iterator bounded by `MAX_PREVIEW_ITERATIONS = 525_600` and `MAX_PREVIEW_RESULTS = 5` constants; first termination wins."

---

### R3 (HIGH — supersedes ADR 017 D8 lines 260-312) — `userMemoryEntries.ts` sole-writer invariant for keyed entries; read-time fallback to `legacy_<sha8>` synthetic key

**Concern (DA P3 HIGH).** D8 introduces `userMemoryEntries.ts` as the new layer for `<!-- key:* -->` keyed entries (per the F1 resolution) but does NOT bind that the existing `userMemory.ts.appendUserMemoryEntry()` won't ALSO write keyed entries (creating two writers + inevitable drift). The chat-side `/update_memory` flow goes through `appendUserMemoryEntry` for unkeyed appends; nothing prevents a future Phase 2 dev or fix-cycle agent from adding keyed-entry support there too. Architect needs a sole-writer binding.

**Decision — bind D8.a sole-writer invariant + read-time fallback.**

**D8.a — Sole-writer invariant (binding for Phase 2; supersedes D8 lines 260-312).**

  - `userMemoryEntries.ts` is the SOLE WRITER for keyed entries (entries containing `<!-- key:my_pref -->` sentinels). All CRUD on keyed entries goes through `userMemoryEntries.ts.{listMemoryEntries, getMemoryEntry, createMemoryEntry, updateMemoryEntry, deleteMemoryEntry}`.
  - Existing `userMemory.ts.appendUserMemoryEntry()` continues to work for UNKEYED appends only (the chat-side memory tool's "remember I'm a data scientist" flow appends a bullet without a sentinel; that's fine and backward-compatible).
  - **Read-time fallback (binding).** When `listMemoryEntries` parses the `.md` file: if a bullet line starts with a sentinel that fails to parse (corruption from manual edit; encoding artifact; sentinel partially deleted) — fall back to synthesizing `legacy_<sha8>` where `sha8 = sha256(category + body[0..32]).slice(0, 8)`. NEVER crash on malformed sentinels. Log a warning at `log.debug` level.
  - **CLAUDE.md invariant addition:** "userMemoryEntries.ts is the sole writer for keyed memory entries (`<!-- key:* -->` sentinels); userMemory.ts.appendUserMemoryEntry remains for unkeyed appends only; do not bypass."

**Tests required (Phase 2; supersedes §3.3 row 2's 12-test count → 14 tests).**

  1. **Test R3-1 (sole-writer invariant — appendUserMemoryEntry doesn't write sentinels):** Call `userMemory.appendUserMemoryEntry(userId, category, "remember I prefer brief replies")`; assert the resulting bullet line in the file does NOT contain `<!-- key:` substring.
  2. **Test R3-2 (read-time fallback on malformed sentinel):** Manually craft a `.md` file with `- <!-- key: --> body text` (empty key); call `listMemoryEntries`; assert the entry is returned with `key === 'legacy_<sha8>'` and a debug log was emitted.
  3. **Test R3-3 (read-time fallback on truncated sentinel):** `- <!-- key:my_pre body text` (missing closing `-->`); same expectation.
  4. **Test R3-4 (read-time fallback on missing sentinel — backward compat):** `- body text without sentinel`; same expectation; key = `legacy_<sha8(category||body[0..32])>`.

**File/line impact.**

  - `src/memory/userMemoryEntries.ts` — bind sole-writer behavior at top of file (export comment) + read-time fallback in `listMemoryEntries`; ~10 LOC additional logic.
  - `src/memory/userMemory.ts` — verify `appendUserMemoryEntry` does NOT emit `<!-- key:* -->` sentinels (defensive comment + test); ~2 LOC of doc comment.
  - `D:\ai-jarvis\CLAUDE.md` — add invariant per D8.a; +1 line item.
  - `tests/integration/memory.userMemoryEntries.test.ts` — +4 tests (R3-1 to R3-4); ~80 LOC.
  - ADR 017 D8 prose updated to point at D8.a.

---

### R6 (HIGH — supersedes ADR 017 D4 lines 122-135 + §3.1 row `audit.list.ts`) — Audit category filter closed-set validation + parameterized SQL

**Concern (DA P10 HIGH).** D4's `?categories=<csv>` filter parameter doesn't bind validation against the closed `AuditCategory` union. Without explicit validation: (a) unknown values reach SQL where they silently match no rows (debugging-hostile); (b) string concatenation into SQL becomes a SQLi vector if a future Phase 2 dev cuts corners on parameterization.

**Decision — bind D4.a categories filter validation + parameterized SQL.**

**D4.a — Audit category filter validation (binding for Phase 2; supersedes D4 lines 122-135).**

  - `?categories=<csv>` parsed into a string array on the server.
  - Each value validated against the closed `AuditCategory` union (the type union from `src/memory/auditLog.ts`, including the 5 new ones from D6).
  - Unknown values → 400 with `{ ok: false, code: 'INVALID_CATEGORY', error: 'Unknown audit category: <value>' }`.
  - Empty array (no `categories` param) means "all categories" (default).
  - SQL: parameterized via `?` placeholders for each validated category; NEVER string interpolation. Example: `WHERE category IN (?, ?, ?)` with `[cat1, cat2, cat3]` bind list.

**Tests required (Phase 2; supersedes §3.3 row 10's 9-test count → 11 tests).**

  1. **Test R6-1 (valid categories accepted):** `?categories=webapp.scheduled_view,webapp.memory_view`; assert 200 + filtered result.
  2. **Test R6-2 (unknown category rejected):** `?categories=foo.bar`; assert 400 + `INVALID_CATEGORY` code.
  3. **Test R6-3 (mixed valid/invalid rejected):** `?categories=webapp.scheduled_view,foo.bar`; assert 400 + `INVALID_CATEGORY` code (NOT silently dropping the bad one).
  4. **Test R6-4 (empty categories param defaults to all):** `?categories=`; assert 200 + result includes rows from all categories.
  5. **Test R6-5 (SQL injection probe):** `?categories=' OR 1=1 --`; assert 400 + `INVALID_CATEGORY` (rejected at validator before reaching SQL).

**File/line impact.**

  - `src/webapp/audit.list.ts` — categories validation + parameterized SQL; ~10 LOC of validation + binding.
  - `src/webapp/audit.shared.ts` — export `KNOWN_AUDIT_CATEGORIES: ReadonlySet<AuditCategory>` for the validator to check membership; ~5 LOC.
  - `tests/integration/webapp.audit.list.test.ts` — +5 tests (R6-1 to R6-5); ~80 LOC.
  - ADR 017 D4 prose updated per D4.a.

---

### F1 (Anti-Slop behavioral contradiction — supersedes ADR 017 D8 line 312 + §5 row 11 + §7 Risk #6 + §2.D11 KI #11) — Memory keyed-entry sentinel format = `<!-- key:my_pref -->` (HTML comment); single source of truth

**Concern (Anti-Slop F1 + DA P11 implicit).** ADR 017 D8 line 312 says: `- {key:my_pref} prefers brief replies`. ADR 017 §5 CP1 surface row 11 + §7 Risk #6 + KI #11 say: "use `<!-- key:my_pref -->` HTML comment". Two formats in the same ADR — Phase 2 dev would pick one and break the other reader's expectations.

**Decision — pick `<!-- key:my_pref -->` (HTML comment); propagate throughout.**

**Justification.**
  1. **Markdown invisibility.** The v1.16.0 `markdown.js` parser strips HTML comments (verified — line-based parser ignores `<!-- ... -->` blocks per W6 bounded regexes). `{key:my_pref}` would render as literal curly-brace text in the body, polluting display.
  2. **Greppable.** `grep -c '<!-- key:' D:/ai-jarvis/data/memories/*.md` is a clean line-count audit; `grep '{key:'` would catch user-typed `{` in conversational content.
  3. **User-edit-friendly.** Power users editing the `.md` file in their text editor (a stated v1.17.0 use case per D3 "audit what Jarvis knows about them") see the sentinel as an HTML comment which most editors render in muted color; unambiguous.
  4. **Collision-resistance.** Conversational text rarely contains literal `<!--` followed by `-->` on the same line; `{key:foo}` is a far more common typed sequence.

**Decision — bind F1.a sentinel format (binding for Phase 2; supersedes D8 line 312 prose).**

  - All keyed entries use `- <!-- key:my_pref --> body text here` format.
  - `userMemoryEntries.ts` sentinel regex: `/^<!--\s*key:([a-z0-9_-]{1,64})\s*-->\s*(.+)$/`.
  - The body text is everything AFTER the sentinel + any whitespace; the body MUST NOT begin with the sentinel pattern (defensive — if it did, the regex would still extract the first match, but Phase 2 dev's create/update path REJECTS user-supplied bodies that contain `<!-- key:` substring at any position to avoid sentinel injection).

**Sentinel injection defense (binding for Phase 2; addition to D8.a).**

```typescript
// src/memory/userMemoryEntries.ts (binding addition)
function rejectSentinelInjection(body: string): { ok: true } | { ok: false, error: string } {
  if (/<!--\s*key:/i.test(body)) {
    return { ok: false, error: 'Memory body must not contain <!-- key: substring (sentinel injection guard).' };
  }
  return { ok: true };
}
// Called from createMemoryEntry + updateMemoryEntry BEFORE the privacy filter.
```

**Tests required (Phase 2; addition to R3 test set).**

  - **Test F1-1 (sentinel injection rejected at create):** `createMemoryEntry(uid, 'pref', 'preferences', '<!-- key:other_key --> hostile body', dataDir)` returns `ok: false`.
  - **Test F1-2 (sentinel injection rejected at update):** Same body via `updateMemoryEntry` — same rejection.
  - **Test F1-3 (sentinel-like-but-not-real allowed):** Body containing `<-- key: missing closing` (no `-->`) is accepted (only the strict `<!--\s*key:` pattern triggers rejection).

**File/line impact.**

  - `src/memory/userMemoryEntries.ts` — sentinel format constant + regex + injection-guard function; ~10 LOC.
  - ADR 017 D8 line 312 prose updated: replace `{key:my_pref}` with `<!-- key:my_pref -->`.
  - ADR 017 §5 row 11 prose updated: confirm `<!-- key:my_pref -->` already cited; close the contradiction.
  - ADR 017 §7 Risk #6 prose updated: confirm `<!-- key:my_pref -->` already cited.
  - ADR 017 §2 D11 KI #11 prose updated: replace any `{key:...}` references with `<!-- key:... -->`.
  - `tests/integration/memory.userMemoryEntries.test.ts` — +3 tests (F1-1 to F1-3); ~30 LOC.

---

### R4 (MEDIUM — supersedes ADR 017 D4 lines 122-135) — Audit refresh-from-top semantics

**Concern (DA P4 MEDIUM).** D4's cursor-based pagination is forward-only (good) but doesn't address "refresh" — when the operator wants to see the LATEST audit rows (newer than the current top of the page) without scrolling. Without an explicit refresh-from-top semantic, the operator either reloads the whole webapp (loses scroll position + filters) or the client invents an ad-hoc API.

**Decision — bind D4.b refresh-from-top semantics.**

**D4.b — Refresh-from-top (binding for Phase 2; addition to D4 lines 122-135).**

  - **Refresh** is a separate request shape: `GET /api/webapp/audit?cursor=` (empty cursor) — fetches LATEST rows with the active filters; no cursor advancement.
  - **Forward pagination** (cursor-based) walks OLDER rows: `GET /api/webapp/audit?cursor=<opaque>` advances toward older rows; `nextCursor === null` marks end of result set.
  - The two modes are NOT interleaved. Refresh-from-top discards the prior cursor; pagination uses it. Client UI: a "Refresh" button at the top resets cursor + re-fetches; a "Load more" button at the bottom advances cursor.
  - Default page size 50; max 200; same as D4 baseline.

**File/line impact.**

  - ADR 017 D4 prose updated per D4.b (~5 lines added).
  - `src/webapp/audit.list.ts` — no new code (cursor-empty case already returns latest rows by `ts DESC, id DESC`); doc comment + tests; ~3 LOC.
  - `public/webapp/audit/app.js` — Refresh button wiring (~10 LOC).
  - `tests/integration/webapp.audit.list.test.ts` — +1 test (refresh-from-top discards cursor + returns latest rows; documented behavior); ~15 LOC.
  - `tests/public/webapp/audit.list-pagination.test.ts` — +1 test (Refresh button click resets cursor); ~15 LOC.

---

### R5 (MEDIUM — supersedes ADR 017 §3.2 row `memory/app.js`) — Memory edit double-submit guard (`_memorySubmitInFlight` + AbortController + 30s timeout)

**Concern (DA P6 MEDIUM).** D9's per-key ETag + If-Match concurrency works for cross-tab races but does NOT guard against double-submit within a single tab (user clicks "Save" twice quickly while the first PUT is in flight). v1.14.6 D15+R6 established the pattern (`_editFormSubmitInFlight` flag + AbortController + 30s timeout); reuse it for memory.

**Decision — bind D9.a memory edit double-submit guard (mirror v1.14.6 D15+R6 pattern).**

**D9.a — Double-submit guard (binding for Phase 2; addition to D9 line 320).**

  - `_memorySubmitInFlight: boolean` flag in `public/webapp/memory/app.js` module scope.
  - `MEMORY_SUBMIT_TIMEOUT_MS = 30_000` constant.
  - On Save click:
    - If `_memorySubmitInFlight === true`: return early (silently — UI already shows the spinner).
    - Else: set `_memorySubmitInFlight = true`; create `AbortController`; start 30s timer that calls `controller.abort()` on expiry.
    - Issue PUT with `{ signal: controller.signal }`.
    - On response (success / 412 / 500 / abort): clear `_memorySubmitInFlight = false`; clear timer.
  - Same behavior for Delete click (DELETE request through the same in-flight flag — sharing a flag is intentional; user can't double-submit ANY mutation while one is pending).

**Tests required (Phase 2; supersedes §3.3 client row 6's 6-test count → 8 tests).**

  - **Test R5-1 (double-click suppressed):** Mount the edit form; click Save twice within 50ms; assert exactly ONE PUT is issued.
  - **Test R5-2 (timeout abort):** Mock PUT to never resolve; click Save; advance fake timer 30s; assert AbortController fired + flag cleared + UI shows error.

**File/line impact.**

  - `public/webapp/memory/app.js` — double-submit guard + constants; ~30 LOC. (D9 baseline already includes basic Save handling; this adds the in-flight flag + AbortController.)
  - ADR 017 D9 prose updated per D9.a (~5 lines added).
  - `tests/public/webapp/memory.edit-conflict.test.ts` — +2 tests (R5-1, R5-2); ~30 LOC.

---

### R7 (MEDIUM — supersedes ADR 017 §3.2 row `index.html`) — Hub tile mobile responsive `flex-wrap` + 140px min-width

**Concern (DA P11 MEDIUM).** D1's hub adds 3 tiles (Cron, Memory, Audit) to the existing 2 (Organize, Debate) for 5 total. On a 320px viewport (the smallest reasonable mobile width), 5 tiles would either overflow horizontally OR stack vertically with massive scroll. No mobile responsive plan in ADR 017.

**Decision — bind D1.a hub responsive layout.**

**D1.a — Hub responsive layout (binding for Phase 2; addition to ADR 017 §3.2 + D14 hub commit).**

  - Hub container CSS: `display: flex; flex-wrap: wrap; gap: 16px;`.
  - Tile CSS: `min-width: 140px; flex: 1 1 140px;` — each tile claims at least 140px; flex-grow expands them in available space.
  - At 320px viewport: 2 tiles per row (140 + gap + 140 = 296px; 3rd wraps to row 2). 5 tiles → 3 rows (2+2+1). Acceptable.
  - At 768px viewport: 5 tiles per row (140 × 5 + gap = 764px; fits). Or 4+1 depending on exact gap.
  - At 1024px viewport: 5 tiles per row (140 × 5 + gap = 764px; fits with whitespace).

**File/line impact.**

  - `public/webapp/index.html` — already +30 LOC per ADR 017 §3.2; +5 LOC for the responsive CSS rules (or add to inline `<style>`); ~5 LOC.
  - `tests/public/webapp/hub.responsive.test.ts` (NEW) — 1 test (320px viewport assertion via JSDOM resize + getComputedStyle); ~30 LOC.

---

### R8 (MEDIUM — supersedes ADR 017 §3.2 row `cron/app.js`) — Cron task action field rendered via textContent (NEVER innerHTML)

**Concern (DA P13 MEDIUM).** D2's cron list UI renders each task's action field (the user-supplied "command" or "description" — what fires when cron triggers). User-supplied content via innerHTML = XSS. v1.14.0 established the discipline (textContent for all user content); ADR 017 doesn't explicitly bind it for cron.

**Decision — bind D2.a cron action textContent invariant.**

**D2.a — Cron user-content rendering (binding for Phase 2; addition to D2).**

  - `public/webapp/cron/app.js` renders `task.action`, `task.description`, and `task.expr` via `element.textContent = value` ONLY. NEVER `element.innerHTML = value`.
  - The status pills + buttons (server-controlled enum values from `'active' | 'paused'`) MAY use `innerHTML` for the badge structure (small markup like `<span class="badge">…</span>`) but the ENUM VALUE itself is via textContent.

**Tests required (Phase 2; supersedes §3.3 client row 3's 8-test count → 9 tests).**

  - **Test R8-1 (XSS probe in action):** Mount list with task `{ action: '<script>alert(1)</script>', ... }`; assert the rendered cell `textContent === '<script>alert(1)</script>'` literal AND `innerHTML` contains `&lt;script&gt;` (escaped); no `<script>` element exists in the DOM.

**File/line impact.**

  - `public/webapp/cron/app.js` — verify all user-content rendering uses textContent; ~0 LOC (binding-only; the existing baseline 450 LOC already matches v1.14.0 discipline; this is a defensive test).
  - `tests/public/webapp/cron.list-detail.test.ts` — +1 test (R8-1); ~20 LOC.

---

### R9 (MEDIUM — supersedes ADR 017 D10 lines 322-336) — Audit `detail_json` display caps + textContent + 16KB truncation

**Concern (DA P14 MEDIUM).** D10's "pretty-format as JSON in the detail panel" doesn't bind size limit. A future audit row with an oversized `detail_json` (e.g., a debate event with full transcript inline — though D9 invariant forbids this, future regression possible) would lock up the browser when rendered.

**Decision — bind D10.a detail_json display caps.**

**D10.a — Audit detail_json display (binding for Phase 2; supersedes D10 lines 322-336).**

  - Detail-panel rendering of `detail_json`:
    1. Parse the JSON string (server-emitted; already valid JSON).
    2. Pretty-print via `JSON.stringify(parsed, null, 2)`.
    3. Truncate display at **16,384 characters** (16KB). If truncated, append `\n\n... [truncated; full content in audit_log.detail_json column]`.
    4. Render in a `<pre>` element via `pre.textContent = pretty` (NEVER innerHTML).

**Tests required (Phase 2; supersedes §3.3 client row 8's 4-test count → 5 tests).**

  - **Test R9-1 (16KB truncation):** Render audit row with detail_json of 20KB length; assert displayed text is 16KB + the truncation suffix.

**File/line impact.**

  - `public/webapp/audit/app.js` — bind 16KB cap constant + truncation in detail render; ~10 LOC.
  - ADR 017 D10 prose updated per D10.a.
  - `tests/public/webapp/audit.detail-render.test.ts` — +1 test (R9-1); ~20 LOC.

---

### W1 (Anti-Slop — pre-extraction grep manifest binding for `detail-panel.js` commit -1) — Run grep BEFORE + AFTER extraction; assert zero hits in app.js post-extraction

**Concern (Anti-Slop W1).** ADR 017 D1's "mechanical extraction" of `detail-panel.js` from `app.js` says "ZERO logic changes" but doesn't bind a pre/post grep that PROVES the originals were deleted from `app.js` (not just copied). v1.15.0 P2 R1 trap (where `kanban-view.js` extraction left zombie copies in `app.js`) would re-fire here without the binding.

**Decision — bind W1.a pre-extraction grep manifest.**

**W1.a — Phase 2 commit -1 binding (addition to ADR 017 D1).**

  - **Before** moving any code: `grep -c "function renderDetail\\|function enterDetailView\\|function exitDetailView" public/webapp/organize/app.js` — record the baseline count (expected ≥ 3).
  - **After** the move (commit -1 staged but not yet committed): same grep MUST return **0** in `app.js` (proves originals deleted, not duplicated). Same grep against `public/webapp/organize/detail-panel.js` MUST return ≥ 3 (proves originals relocated).
  - If the post-extraction grep returns nonzero in `app.js`: STOP; the extraction is incomplete; remove the duplicates from `app.js` before committing.
  - This sequence runs as part of commit -1's pre-commit verification (Phase 2 dev MUST run it; document in commit message: "Pre-extraction grep baseline: N; post-extraction grep in app.js: 0; in detail-panel.js: N." where N matches).

**File/line impact.**

  - ADR 017 D1 prose updated per W1.a (~5 lines added to D1's mechanical guarantee section).
  - No new tests; the grep is a pre-commit check, not a runtime assertion. (Optional: add a CI grep gate in `tests/static/no-zombie-detail-panel-symbols.test.ts` — runs `grep` via `child_process.execSync`; ~15 LOC; +1 test. Architect's call: include it; +1 to W1 closure.)

---

### W2 (Anti-Slop — supersedes ADR 017 D2 line 80) — Cron day-of-week normalization in `cronToPreset` + `presetToCron`

**Concern (Anti-Slop W2).** D2 line 80 lists weekday cron as `1-5` (range form); user could equally type `1,2,3,4,5` (list form). Both are equivalent semantically but different lexically; `cronToPreset` would fail to map the list form to "Every weekday" preset, falling through to "Custom" — a usability regression.

**Decision — bind W2.a normalization (covered in R1's day-of-week normalization clause).**

**W2.a — DOW normalization (binding for Phase 2; addition to D2 + R1).**

  - `cronToPreset(expr)` MUST recognize BOTH range forms (`1-5`) AND list forms (`1,2,3,4,5`) for day-of-week; BOTH map to "Every weekday" preset.
  - `cronToPreset` MUST recognize order-independent list forms (`6,0` and `0,6` both map to "Every weekend"; sort the list before equality compare).
  - `presetToCron(preset, params)` ALWAYS emits the SHORTER form: `1-5` for weekdays, `0,6` for weekend (sorted).

Already covered by R1 Test R1-11. No additional file impact beyond R1's `cronToPreset` parser logic (~5 LOC of normalization in the parser; included in R1's ~120 LOC).

---

### W3 (Anti-Slop — deterministic Gate H post-fix scan) — Audit shared modules contain ZERO raw `: value` field names (privacy invariant enforcement)

**Concern (Anti-Slop W3).** D6 + D10 + §7 Risk #5 establish the privacy invariant (no field VALUES in audit detail rows). Anti-Slop wants a deterministic CI-runnable scan that closes the loop — a grep over `src/webapp/audit*.ts + memory.shared.ts + scheduled.shared.ts` for `: value` (the smell-pattern that would indicate a Phase 2 dev injected a value field).

**Decision — bind W3.a Gate H deterministic scan.**

**W3.a — Gate H scan (binding for Phase 2 + post-fix CI).**

  - Phase 2 commit -1 + every subsequent Phase 2 commit MUST pass:
    - `grep -nE "['\"]?\\bvalue\\b['\"]?\\s*:\\s*" src/webapp/audit*.ts src/webapp/memory.shared.ts src/webapp/scheduled.shared.ts | grep -v '// ALLOWED:'` — expected ZERO matches.
  - Inline allow-list comment `// ALLOWED: <reason>` lets a future legitimate `value:` (e.g., a closed-enum literal) through with documentation; require explicit comment.
  - Gate H is a DETERMINISTIC_GATES.md addition (post-fix scan; runs alongside gates A-G).

**File/line impact.**

  - `D:\ai-jarvis\DETERMINISTIC_GATES.md` — add Gate H ("audit privacy field-name scan"); ~10 LOC.
  - `tests/static/audit-privacy-scan.test.ts` (NEW) — runs the grep via `child_process.execSync`; assertion: stdout empty; ~30 LOC; +1 test.

---

### W4 (Anti-Slop — supersedes ADR 017 D9 line 316) — ETag hash function shape

**Concern (Anti-Slop W4).** D9 says "hash(file_mtime_iso || body)" without binding the hash function or output truncation. v1.14.4 used `sha256` truncated to 16 hex chars for ETag headers; consistency demands the same shape.

**Decision — bind D9.b ETag function shape.**

**D9.b — Memory entry ETag (binding for Phase 2; supersedes D9 line 316).**

  - `etag = '"' + sha256(mtime_iso + '|' + body).slice(0, 16) + '"'` — strong-format quoted, 16 hex chars.
  - `mtime_iso` is the file's stat-mtime serialized as ISO 8601 (UTC); concatenated with `|` separator before body to ensure mtime + body changes both shift the hash.
  - SHA-256 is overkill for ETag (collision probability ~ 0 at 16-char truncation), but matches v1.14.4's strong-format pattern; no need to introduce a faster non-cryptographic hash.
  - Use Node's built-in `crypto.createHash('sha256')` — already in use elsewhere in the codebase; ZERO new deps.

**File/line impact.**

  - `src/memory/userMemoryEntries.ts` — bind ETag function; ~5 LOC.
  - ADR 017 D9 prose updated per D9.b.
  - `tests/integration/memory.userMemoryEntries.test.ts` — +1 test (etag round-trip + collision-resistance probe; ETag shifts when mtime changes; ETag shifts when body changes); ~20 LOC.

---

### F2 (Anti-Slop cosmetic — supersedes ADR 017 §2 D11 KI #7 + KI #10) — Expand KI 7 + 10 with new constants and exact behavior

**Concern (Anti-Slop F2).** KI #7 ("5 new audit categories") and KI #10 ("Memory key whitelist") are thin — KI entries live to be greppable archeology for future Phase 2 devs. Expand them with the new constants from R1 (cron) + R6 (validator) + W4 (ETag).

**Decision — bind F2.a KI expansion (covered in RA1 update below).**

**F2.a — KI expansion (binding for Phase 2 commit 15; supersedes §2 D11 KI #7 + #10 + adds 2 new entries).**

  - **KI #7 (audit categories):** add the closed-set validator behavior — "categories filter validated against `KNOWN_AUDIT_CATEGORIES` set; unknown → 400 INVALID_CATEGORY; SQL parameterized via `?`."
  - **KI #10 (memory key whitelist):** add the sole-writer invariant — "userMemoryEntries.ts is the sole writer for keyed entries; userMemory.ts.appendUserMemoryEntry remains for unkeyed appends; read-time fallback to `legacy_<sha8>` synthetic key on malformed sentinel."
  - **NEW KI #13 (cron preview implementation):** "src/scheduler/cronPreview.ts: roll-our-own ~120-LOC bounded iterator; NO `cron-parser` dependency; constants `MAX_PREVIEW_ITERATIONS = 525_600` + `MAX_PREVIEW_RESULTS = 5`; dual-termination; first match wins."
  - **NEW KI #14 (sentinel format):** "Memory keyed entries use `<!-- key:my_pref -->` HTML comment sentinel (markdown-invisible; greppable; collision-resistant). userMemoryEntries.ts rejects bodies containing `<!-- key:` substring (sentinel injection guard)."

---

### RA1 update (7th consecutive iteration — supersedes ADR 017 D11)

Per ADR 015 R10 / ADR 016 D16 / ADR 017 D11, RA1 (Anti-Slop's standing requirement on KI/CLAUDE.md propagation) is updated for the revisions. ADR 017 D11 enumerated 12 KI + 4 CLAUDE.md invariants pre-CP1; revisions add:

**KNOWN_ISSUES.md (14 entries — was 12 in D11; +2 from R1 + R3):**
  - KI #7 expanded per F2.a (audit categories closed-set validation).
  - KI #10 expanded per F2.a (sole-writer invariant + read-time fallback).
  - **NEW KI #13:** roll-our-own cronPreview.ts (no cron-parser dep) per R1.
  - **NEW KI #14:** memory sentinel format `<!-- key:my_pref -->` + sentinel injection guard per F1.

**CLAUDE.md (5 invariants — was 4 in D11; +1 from R3):**
  - Invariants 1-4 unchanged from D11 (detail-panel.js boundary; per-resource shared module; memory key whitelist defense in depth; cron preview contract — but invariant #4 prose updated per R1 to reference cronPreview.ts NOT cron-parser).
  - **NEW invariant #5:** "userMemoryEntries.ts is the sole writer for keyed memory entries (`<!-- key:* -->` sentinels); userMemory.ts.appendUserMemoryEntry remains for unkeyed appends only; do not bypass."

**File/line impact.**

  - `D:\ai-jarvis\KNOWN_ISSUES.md` — 14 entries (was 12); ~+130 LOC (was +110 in D11; +20 for the two new entries + expansions).
  - `D:\ai-jarvis\CLAUDE.md` — 5 invariants (was 4); ~+35 LOC (was +30 in D11; +5 for the new invariant + R1 prose update).

---

## File-impact summary table for Phase 2

| File | Change | Tied to | LOC delta vs ADR 017 baseline |
|------|--------|---------|------------------------------:|
| `src/scheduler/cronPreview.ts` (NEW) | R1 — roll-our-own ~120-LOC bounded iterator (REPLACES D7's `src/scheduler/preview.ts` planned at +50) | R1 | **+120** (was +50; +70 vs baseline) |
| `src/scheduler/preview.ts` | RESCINDED — file is `src/scheduler/cronPreview.ts` per R1 (renamed to clarify "preview" is webapp-namespace ambiguous) | R1 | (rename, not LOC delta) |
| `src/webapp/scheduled.preview.ts` | Import target changed to `../scheduler/cronPreview.js` | R1 | **±0** |
| `package.json` | `cron-parser` dep RESCINDED | R1 | **−1** (was +1 in D7) |
| `src/memory/userMemoryEntries.ts` | D8.a sole-writer + read-time fallback + sentinel injection guard + ETag function | R3 + F1 + W4 | **+15** vs ADR 017 D8 baseline (140 → ~155) |
| `src/memory/userMemory.ts` | Doc comment confirming appendUserMemoryEntry doesn't emit sentinels | R3 | **+2** |
| `src/webapp/audit.list.ts` | R6 closed-set validation + parameterized SQL | R6 | **+10** vs ADR 017 baseline (150 → ~160) |
| `src/webapp/audit.shared.ts` | Export `KNOWN_AUDIT_CATEGORIES` set | R6 | **+5** vs baseline (60 → ~65) |
| `public/webapp/index.html` | R7 hub responsive CSS | R7 | **+5** vs baseline (30 → ~35) |
| `public/webapp/cron/app.js` | R8 (verify textContent discipline; no LOC change) | R8 | **±0** |
| `public/webapp/audit/app.js` | R9 16KB display cap + truncation suffix | R9 | **+10** vs baseline (450 → ~460) |
| `public/webapp/audit/app.js` | R4 Refresh button wiring | R4 | **+10** vs baseline (already counted; +20 R4+R9 combined) |
| `public/webapp/memory/app.js` | R5 double-submit guard + AbortController + 30s timeout | R5 | **+30** vs baseline (400 → ~430) |
| `public/webapp/organize/app.js` + `detail-panel.js` | W1 pre/post grep verification (no LOC; commit-message discipline + optional CI test) | W1 | **±0** code; +15 if optional CI test added |
| `D:\ai-jarvis\KNOWN_ISSUES.md` | RA1 update — 14 entries (was 12) | RA1 + F2 | **+130** (was +110; +20 for new entries) |
| `D:\ai-jarvis\CLAUDE.md` | RA1 update — 5 invariants (was 4) | RA1 + R3 | **+35** (was +30; +5 for new invariant) |
| `D:\ai-jarvis\DETERMINISTIC_GATES.md` | W3 Gate H ("audit privacy field-name scan") | W3 | **+10** |
| `tests/integration/scheduler.preview.test.ts` (renamed `tests/integration/scheduler.cronPreview.test.ts`) | R1 — 12 tests (was 8) | R1 | **+~250** (was +150; +100 for the 4 new tests R1-4..R1-7 + R1-12) |
| `tests/integration/memory.userMemoryEntries.test.ts` | R3 (R3-1..R3-4) + F1 (F1-1..F1-3) + W4 ETag round-trip | R3 + F1 + W4 | **+~150** vs ADR 017 baseline (250 → ~400) |
| `tests/integration/webapp.audit.list.test.ts` | R4 refresh-from-top (1) + R6 (R6-1..R6-5) | R4 + R6 | **+~100** vs ADR 017 baseline (220 → ~320) |
| `tests/public/webapp/cron.list-detail.test.ts` | R8 XSS probe (R8-1) | R8 | **+~20** vs baseline (150 → ~170) |
| `tests/public/webapp/audit.list-pagination.test.ts` | R4 Refresh button click test | R4 | **+~15** vs baseline (200 → ~215) |
| `tests/public/webapp/audit.detail-render.test.ts` | R9 16KB truncation (R9-1) | R9 | **+~20** vs baseline (100 → ~120) |
| `tests/public/webapp/memory.edit-conflict.test.ts` | R5 double-submit (R5-1, R5-2) | R5 | **+~30** vs baseline (150 → ~180) |
| `tests/public/webapp/hub.responsive.test.ts` (NEW) | R7 320px viewport assertion | R7 | **+30** (NEW file; 1 test) |
| `tests/static/audit-privacy-scan.test.ts` (NEW) | W3 Gate H grep | W3 | **+30** (NEW file; 1 test) |
| `tests/static/no-zombie-detail-panel-symbols.test.ts` (NEW; OPTIONAL) | W1 CI grep gate | W1 | **+15** (NEW file; 1 test) |

**Estimated total LOC delta vs ADR 017 baseline:**

  - **ADR 017 baseline (architect's projection):** ~3,756 source / ~3,080 tests / ~211 docs = ~7,047 total.
  - **Post-revisions projection:**
    - **Source code (production):** baseline ~3,756 + R1 (+70 cronPreview vs +50 baseline; net +70) − 1 (`cron-parser` removed) + R3+F1+W4 (+15 in userMemoryEntries.ts + 2 in userMemory.ts) + R6 (+10 in audit.list.ts + 5 in audit.shared.ts) + R7 (+5 in index.html) + R9 (+10 in audit/app.js) + R4 (+10 in audit/app.js) + R5 (+30 in memory/app.js) = **~+156 source-code LOC delta**; new total ~3,912.
    - **Test code:** baseline 3,080 + R1 (+100) + R3+F1+W4 (+150) + R4+R6 (+100) + R8 (+20) + R4 (+15) + R9 (+20) + R5 (+30) + R7 (+30 new file) + W3 (+30 new file) + W1 optional (+15 new file) = **~+510 test LOC delta**; new total ~3,590.
    - **Docs:** baseline +211 + RA1 (+20 KI + 5 CLAUDE.md) + W3 (+10 DETERMINISTIC_GATES.md) = **~+246 docs LOC**.
    - **Grand total:** ~3,912 + 3,590 + 246 = **~7,748 LOC** (was ~7,047; +701 LOC).
  - **Test ratio:** ~92% (3,590 / 3,912) — healthy; matches ADR 017's projected 82% post-revisions.

**Source code (non-test) LOC delta:** ~+156 vs ADR 017 baseline; the bulk is R1 (+70 for the larger cronPreview iterator vs the original +50 cron-parser-using helper) and R3+F1+W4 combined (+17 in memory layer).

**Test count delta (post-revisions):** ADR 017 baseline 133 tests + R1 +4 (R1-4..R1-7 + R1-12 net new vs baseline 8) + R3 +4 (R3-1..R3-4) + F1 +3 (F1-1..F1-3) + W4 +1 (etag round-trip) + R4 +2 (refresh-from-top integration + Refresh button client) + R6 +5 (R6-1..R6-5) + R8 +1 (R8-1) + R9 +1 (R9-1) + R5 +2 (R5-1, R5-2) + R7 +1 (hub.responsive) + W3 +1 (audit-privacy-scan) + W1 +1 (no-zombie-detail-panel-symbols, optional but accepted) = **~158 tests.** Phase 2 binding: 158 tests is the new target; the architect's pre-CP1 binding floor was 90, so 158 is well above floor.

---

## Final R-list ordered by Phase 2 file impact

| # | Severity | Resolution | Primary file impact | LOC |
|---|---|---|---|---:|
| **R1** | BLOCKING | `cron-parser` REJECTED; roll-our-own bounded iterator at `src/scheduler/cronPreview.ts` (~120 LOC; 5 match-bitmaps; 525,600 iteration cap; 5-result cap; first-termination wins) | `cronPreview.ts` NEW (+120) + `package.json` (−1) + tests (+250) | **+370** (vs +200 baseline) |
| **R2** | HIGH | Bind `MAX_PREVIEW_ITERATIONS = 525_600` + `MAX_PREVIEW_RESULTS = 5` constants + dual-termination semantics (covered by R1 implementation; tests R1-4..R1-7 + R1-12) | covered in R1 | covered |
| **R3** | HIGH | `userMemoryEntries.ts` sole-writer invariant + read-time fallback to `legacy_<sha8>` + CLAUDE.md invariant #5 | `userMemoryEntries.ts` (+10) + `userMemory.ts` (+2) + CLAUDE.md (+5) + tests (+80) | **+97** |
| **R6** | HIGH | Audit category closed-set validation + parameterized SQL + `KNOWN_AUDIT_CATEGORIES` exported set | `audit.list.ts` (+10) + `audit.shared.ts` (+5) + tests (+80) | **+95** |
| **F1** | Anti-Slop | Sentinel format `<!-- key:my_pref -->` (single source of truth across D8 + §5 + §7 + KI) + sentinel injection guard | `userMemoryEntries.ts` (+10) + ADR doc updates + tests (+30) | **+40** |
| **R4** | MEDIUM | Audit refresh-from-top semantics (cursor empty = latest; cursor opaque = older) + Refresh button wiring | `audit/app.js` (+10) + tests (+30) | **+40** |
| **R5** | MEDIUM | Memory edit double-submit guard (`_memorySubmitInFlight` + AbortController + 30s timeout) | `memory/app.js` (+30) + tests (+30) | **+60** |
| **R7** | MEDIUM | Hub tile mobile responsive CSS (`flex-wrap: wrap` + `min-width: 140px`) | `index.html` (+5) + tests (+30 new file) | **+35** |
| **R8** | MEDIUM | Cron action field rendered via textContent (defensive XSS probe test) | tests (+20) | **+20** |
| **R9** | MEDIUM | Audit detail_json display cap 16KB + truncation suffix + textContent in `<pre>` | `audit/app.js` (+10) + tests (+20) | **+30** |
| **W1** | Anti-Slop W1 | Pre-extraction grep manifest binding for detail-panel.js commit -1 + optional CI grep gate | doc-only ADR §3.5 + optional `tests/static/no-zombie-detail-panel-symbols.test.ts` (+15) | **+15** (optional) |
| **W2** | Anti-Slop W2 | Cron DOW normalization (`1-5` ≡ `1,2,3,4,5`; `presetToCron` emits shorter form) | covered in R1 | covered |
| **W3** | Anti-Slop W3 | Deterministic Gate H scan for raw `: value` field names in audit shared modules | DETERMINISTIC_GATES.md (+10) + `tests/static/audit-privacy-scan.test.ts` (+30) | **+40** |
| **W4** | Anti-Slop W4 | ETag = `sha256(mtime_iso || '|' || body).slice(0, 16)` strong-format quoted | `userMemoryEntries.ts` (+5) + tests (+20) | **+25** |
| **F2** | Anti-Slop cosmetic | KI #7 + #10 expanded; KI #13 + #14 added | covered in RA1 update | doc-only |
| **RA1** | enumeration | KI 12 → 14 entries; CLAUDE.md 4 → 5 invariants | KI (+130) + CLAUDE.md (+35) | **+165** |

**Phase 2 commit ordering (binding — Phase 2 commit -1 retained as `detail-panel.js` extraction; the v1.17.0 work ordering otherwise unchanged from ADR 017 baseline):**

  - **Commit -1:** `detail-panel.js` extraction from `app.js` (D1; mechanical zero-logic-change relocation; W1 pre/post grep manifest verified in commit message).
  - **Commit 0:** AuditLog category union expansion (D6 — 5 new categories).
  - **Commit 1:** `src/scheduler/cronPreview.ts` (R1 — NEW; replaces planned `src/scheduler/preview.ts`); `package.json` cron-parser RESCISSION; tests R1-1..R1-12.
  - **Commit 2:** `scheduled.shared.ts` + `scheduled.list.ts` + `scheduled.detail.ts` + `scheduled.preview.ts` (D5 + D6 + D7-via-cronPreview-import) + `scheduled.mutate.ts` + `scheduledRoute.ts` + server.ts wiring; tests for all 4 scheduled endpoints.
  - **Commit 3:** `src/memory/userMemoryEntries.ts` (D8 + R3 sole-writer + F1 sentinel + W4 ETag); `userMemory.ts` doc comment; tests R3-1..R3-4 + F1-1..F1-3 + ETag round-trip.
  - **Commit 4:** `memory.shared.ts` + `memory.list.ts` + `memory.detail.ts` + `memory.mutate.ts` + `memoryRoute.ts` + server.ts wiring; tests for all 3 memory endpoints.
  - **Commit 5:** `audit.shared.ts` + `audit.list.ts` (R6 closed-set validation + R4 refresh-from-top) + `audit.detail.ts` + `auditRoute.ts` + server.ts wiring; tests for all audit endpoints (including R6-1..R6-5 + R4 refresh-from-top).
  - **Commit 6:** `public/webapp/index.html` Hub tiles + R7 responsive CSS; `tests/public/webapp/hub.responsive.test.ts`.
  - **Commit 7:** `public/webapp/cron/index.html` + `cron-builder.js` (W2 DOW normalization) + `cron/app.js` (R8 textContent) + `cron/styles.css`; tests including R8-1.
  - **Commit 8:** `public/webapp/memory/index.html` + `memory/app.js` (R5 double-submit guard) + `memory/styles.css`; tests including R5-1, R5-2.
  - **Commit 9:** `public/webapp/audit/index.html` + `audit/app.js` (R4 Refresh button + R9 16KB cap) + `audit/styles.css`; tests including R4 + R9-1.
  - **Commit 10:** Static gates — `tests/static/audit-privacy-scan.test.ts` (W3); `tests/static/no-zombie-detail-panel-symbols.test.ts` (W1 optional); `DETERMINISTIC_GATES.md` Gate H addition.
  - **Commit 11:** RA1 enumeration — `KNOWN_ISSUES.md` 14 entries + `CLAUDE.md` 5 invariants.
  - **Commit 12:** CHANGELOG + version bump 1.16.0 → 1.17.0; ship.

End of revisions document for v1.17.0 CP1.
