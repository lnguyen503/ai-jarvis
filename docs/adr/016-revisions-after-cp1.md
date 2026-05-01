# ADR 016 — Revisions after CP1 debate (2026-04-25)

**Parent:** `016-v1.16.0-debate-viewer.md`
**Status:** Accepted. Folded into ADR 016 by reference. Phase 2 dev agents implement the revised spec; deviations require another addendum.

**Context.** Devil's Advocate review (`docs/reviews/cp1-devils-advocate-v1.16.0.md`) raised **2 BLOCKING + 3 HIGH + 6 MEDIUM + 9 OK** with 8 numbered R-revisions (R1–R8). Anti-Slop Phase 1 review (`docs/reviews/anti-slop-phase1-review-v1.16.0.md`) raised **0 Required Actions (D16 enumeration pre-empted RA1) + 6 Warnings (W1–W6) + 2 cosmetic (F1, F2)**. **Convergence signal #1:** DA P1/R1 (BLOCKING — SSE close-handler invariant gap) is convergent with Anti-Slop W1 (eventbus leak test shape not bound) — D5 prose says `try/finally`, D13 binding says `req.on('close')`, neither covers the union. **Convergence signal #2:** DA P19/R7 (BLOCKING — items.shared.ts 343 baseline is 74-LOC stale; actual = 417) is the v1.15.0 P15 LOC-drift pattern repeating — convergent-with-Anti-Slop §13 file-size posture (Anti-Slop's check at line ~33 used the 343 baseline + projection ~430; corrected math is 417 + ~80 = ~497 = AT the §13 default). Two reviewers + same shape of finding = strong signal; both BLOCKINGs land here.

The architect resolves the BLOCKINGs with: (R1) **explicit quad-binding of SSE close paths** (`req.on('close')` + `res.on('close')` + `res.on('error')` + `res.on('finish')` + outer try/catch with `unsubscribed` once-only flag) on a new D13.a sub-decision; (R7) **mandatory pre-extraction of `items.auth.ts` as Phase 2 commit -1 BEFORE all other v1.16.0 work** (option B from the prompt — split items.shared.ts → items.auth.ts (auth chain + ConflictTracker) + items.shared.ts (audit + helpers + IP redactor)). Mechanical zero-logic-change; debate.shared.ts then imports `authenticateRequest` from `./items.auth.ts` instead of from items.shared.ts. Accepts both BLOCKING (R1 + R7), accepts every HIGH (R3 markdown URL belt-and-suspenders + 6 injection-probe tests; R4 markdown DOS caps — 200 items per list + 50 headings per doc + indentation IGNORED; R5 persistenceHook audit emission — new `'debate.persistence_error'` audit category), accepts every MEDIUM (R2 single-user concurrency cap = 5; R6 pm2-restart zombie cleanup at boot; R8 detail-panel.js extraction explicitly DEFERRED to v1.17.0 first commit; P8 single-SQL verification; P12 inline help; P14 deleted-item placeholder; P17 top-overlay modal placement), accepts every Anti-Slop warning (W1 closes via R1; W2 closes via R5; W3 line-equality predicate = byte-exact after trim of trailing whitespace; W4 mobile breakpoint = `@media (min-width: 768px)`; W5 markdown swap regression test; W6 markdown bounded regex + pathological-input test; F1 KI entries 3 + 7 expanded; F2 acceptable as-is).

**The two BLOCKINGs (R1 + R7) MUST land before Phase 2 proceeds.** R1 is a ~10-LOC binding on D13 (no code yet — addendum to ADR text); R7 is a Phase 2 commit -1 that is purely mechanical (move ~170 LOC from items.shared.ts to a new items.auth.ts; update imports in all callers). Verified: `wc -l D:/ai-jarvis/src/webapp/items.shared.ts` = **417** (DA confirmed); `wc -l D:/ai-jarvis/public/webapp/organize/app.js` = **2113** (DA confirmed). The 343 figure ADR 016 D10 cited is a pre-v1.14.4 baseline; v1.14.4 R2 (ConflictTracker + readIfMatchHeader + readForceOverride + cacheControlNoStore) plus subsequent additions took the file to 417.

This revisions document supersedes the relevant clauses of ADR 016 by reference; the parent ADR is not edited.

---

## Resolved (R-numbered, ordered by Phase 2 commit ordering)

### R7 (BLOCKING — supersedes ADR 016 D10 lines 359-379; mandatory Phase 2 commit -1 pre-extraction) — Split items.shared.ts → items.auth.ts + items.shared.ts BEFORE all other v1.16.0 work

**Concern (DA P19/R7).** ADR 016 D10 line 366 says: "items.shared.ts is at 343 LOC (verified `wc -l` per the prompt's spec)." DA verified actual = **417 LOC**. The 343 figure was a pre-v1.14.4 baseline; v1.14.4 R2 (ConflictTracker + readIfMatchHeader + readForceOverride + cacheControlNoStore) plus follow-ons grew the file to 417. With the corrected baseline, D10's "would push it to ~430 LOC — approaching the 500-LOC threshold" becomes **417 + ~80 = ~497 LOC** — not "approaching" the §13 default but **AT** it. This is the v1.15.0 P15 BLOCKING pattern repeating: stale baseline citation propagating through architectural reasoning.

**Two paths considered.**

- **Path A — Make `debate.shared.ts` fully independent** (don't re-export from items.shared.ts; copy `authenticateRequest` fragment into debate.shared.ts as duplicate logic). **Rejected.** v1.15.0 P2 R1 lesson against duplication; if the auth chain ever evolves (e.g., adds a route-prefix variant), debate would silently diverge. Risk: future drift. Single-source-of-truth posture is the encoded v1.15.0 P2 R1 lesson; do not undo it.
- **Path B — Pre-split items.shared.ts itself** into a focused `items.auth.ts` (auth chain + ConflictTracker — single source for the auth invariant) + a thinner `items.shared.ts` (audit + helpers + IP redactor). debate.shared.ts then imports `authenticateRequest` from `./items.auth.ts`. **Picked.** Mechanical relocation; preserves single-source; both files stay well under §13 threshold; future routes (debate, schedule, memory per the hub roadmap) all import from the same auth seam. Cost: one Phase 2 commit BEFORE the v1.16.0 work begins.

**Decision — pre-extract `items.auth.ts` as Phase 2 commit -1 (BEFORE the v1.16.0 commit 0 ordering); mechanical zero-logic-change relocation; ALL items.* routes update their `authenticateRequest` imports.**

**Phase 2 commit -1 — `src/webapp/items.auth.ts` (NEW, ~170 LOC).**

  - **Contains:** `authenticateRequest` function + the request-authentication chain (HMAC verify → `userId` extraction → allowlist check). `ConflictTracker` class (the v1.14.4 R2 tracker for verb-asymmetric If-Match handling — keyed to active edit sessions; canonical home moves out of items.shared.ts where it currently lives).
  - **Imports:** Same as the relocated chunks (no new imports; mechanical move).
  - **Exports:** `authenticateRequest`, `ConflictTracker`, the related types/interfaces (`AuthenticatedRequest`, `AuthFailure` enum, etc.).
  - **Mechanical guarantee:** ZERO logic changes. Every branch, every error path, every type signature preserved. Bug-for-bug compatible. Tests in `tests/unit/webapp.items.auth.test.ts` (relocated from existing items.shared.test.ts coverage of these symbols, OR new file with identical assertion shape).

**Phase 2 commit -1 also — `src/webapp/items.shared.ts` slims to ~250 LOC.**

  - **Retains:** audit emission helpers (`auditItemMutate`, `auditItemCreate`, `auditWebappAuthFailure` etc.); IP redactor (`redactIp` — the canonical 3-octet redactor referenced by debate.shared.ts via re-export); generic header helpers (`readIfMatchHeader`, `readForceOverride`, `cacheControlNoStore`); shared error envelope shapes; `ItemsRouteDeps` interface.
  - **Removes:** `authenticateRequest` (moved to items.auth.ts); `ConflictTracker` (moved to items.auth.ts); the auth-related types (moved with their owner).

**Import updates (mechanical — covers ALL items.* + items-shared callers).**

  - `src/webapp/items.create.ts` — change `import { authenticateRequest, ... } from './items.shared.ts'` to split between `./items.auth.ts` (auth) and `./items.shared.ts` (helpers).
  - `src/webapp/items.read.ts` — same split.
  - `src/webapp/items.mutate.ts` — same split (also imports `ConflictTracker`).
  - `src/webapp/items.complete.ts` — same split.
  - `src/webapp/itemsRoute.ts` — wires through; verify imports still resolve.
  - Any other importer surfaced by `grep -r "from.*items.shared" src/webapp` — all updated mechanically.

**LOC accounting (binding for Phase 2).**

  - items.shared.ts HEAD = **417 LOC** (verified `wc -l D:/ai-jarvis/src/webapp/items.shared.ts` 2026-04-25).
  - After commit -1 (split): items.auth.ts NEW ~170 LOC; items.shared.ts ~250 LOC. Combined ~420 LOC across two files; both well under the §13 500-LOC default threshold.
  - debate.shared.ts (D10, ~80 LOC) imports `authenticateRequest` from `./items.auth.ts`; re-exports stay within debate.shared.ts only as needed.
  - Net change to `src/webapp/items.shared.ts`: 417 → ~250 (−167 LOC mechanical).
  - Net new file: items.auth.ts +~170 LOC (mechanical relocation).
  - **Aggregate**: equivalent code count; cleaner module seams.

**ADR text correction (binding for Phase 2 + supersedes D10 line 366 prose).**

  - Replace "items.shared.ts is at 343 LOC" with "items.shared.ts HEAD = 417 LOC (verified `wc -l D:/ai-jarvis/src/webapp/items.shared.ts` 2026-04-25); pre-extracted to items.auth.ts (~170 LOC) + items.shared.ts (~250 LOC) as Phase 2 commit -1."
  - Replace "would push it to ~430 LOC — approaching the 500-LOC threshold" with "absent the split, adding debate-shared content would push items.shared.ts to ~497 LOC, AT the §13 default threshold; the items.auth.ts pre-extraction makes the debate-shared addition land cleanly on a focused ~250-LOC items.shared.ts."
  - Update D10 rejected-B reasoning: "B (extend items.shared.ts directly) crosses the §13 threshold; rejected for size + concern-mixing."
  - Update D10 binding line 372: `export { authenticateRequest } from './items.shared.ts';` → `export { authenticateRequest } from './items.auth.ts';`.

**Tests required (Phase 2).**

  1. **Test R7-1 (items.auth.ts mechanical extraction):** All existing auth-chain tests pass UNCHANGED after relocation; coverage measure confirms ≥ pre-extraction.
  2. **Test R7-2 (no circular imports post-extraction):** dependency-graph check confirms zero cycles between items.auth.ts, items.shared.ts, items.{create,read,mutate,complete}.ts, debate.shared.ts.
  3. **Test R7-3 (debate.shared.ts re-export resolves to items.auth.ts):** import-resolution probe — `import { authenticateRequest } from 'src/webapp/debate.shared.ts'` must trace to items.auth.ts (NOT items.shared.ts).

**File/line impact.**

  - `src/webapp/items.auth.ts` (NEW) — **+170 LOC** (mechanical relocation).
  - `src/webapp/items.shared.ts` — **−167 LOC** (417 → ~250).
  - `src/webapp/items.create.ts` / `items.read.ts` / `items.mutate.ts` / `items.complete.ts` / `itemsRoute.ts` — import-line updates only; ~1-2 LOC each; ~6 LOC total.
  - `src/webapp/debate.shared.ts` (NEW per D10) — `authenticateRequest` import points at `./items.auth.ts` (1-line delta vs the original D10 binding).
  - `tests/unit/webapp.items.auth.test.ts` (NEW or relocated) — ~30 LOC tests for the relocated symbols (mechanical).
  - ADR 016 D10 prose updated per the text correction above; this revisions doc supersedes lines 366-379.

---

### R1 (BLOCKING — supersedes ADR 016 D5 line 184 + D13 line 507 + Risk row 1) — Bind SSE close-handler quad-binding (req+res+error+finish + outer try/catch + once-only flag)

**Concern (DA P1/R1 + Anti-Slop W1 convergent).** ADR 016 D5 line 184 says: "Phase 2 dev binds this with a `try { ... } finally { unsubscribe(); }` wrapper around the SSE handler." ADR 016 D13 line 507 says: "Client disconnects. Server detects `req.on('close')`, calls the unsubscribe callback (D5), no further sends." **The two are NOT equivalent.** `try/finally` on a long-lived async handler doesn't fire until the await loop exits; `req.on('close')` fires on canonical client disconnect but does NOT fire reliably on (a) `res.destroy()` after a server-side error, (b) socket-level errors before headers were flushed, (c) unhandled rejection in the SSE handler bubbling past Express's catch. With `setMaxListeners(0)` (D5 line 184), a leaked listener fires NO warning. The leak is silent until per-emit cost (O(N) over leaked listeners) creeps into latency over weeks. Anti-Slop W1 raised the same finding from a "test shape not bound" angle.

**Decision — bind D13.a SSE close-path quad-binding contract.**

**D13.a — SSE close-path invariant (binding for Phase 2; supersedes D5 line 184 + D13 line 507).**

  - On `subscribe()`, immediately register a single cleanup callback. Wrap in an `unsubscribed` once-only flag for idempotency.
  - Bind cleanup to ALL FIVE close paths:
    1. `req.on('close', onClose)` — canonical client disconnect (TCP RST, Telegram WebApp closed, navigation away).
    2. `res.on('close', onClose)` — response destroyed (`res.destroy()`; proxy timeout drop).
    3. `res.on('error', onClose)` — socket-level error (TCP write fail; broken pipe; cloudflared tunnel reset).
    4. `res.on('finish', onClose)` — normal completion (`res.end()` after terminal event published).
    5. **Outer try/catch on the SSE handler body** — if the handler throws synchronously BEFORE the long-lived loop (e.g., a TypeError in initial snapshot construction), `onClose` fires from the catch block.
  - Unsubscribe is also responsible for clearing the keepalive interval (`KEEPALIVE_INTERVAL_MS = 25_000` per D4) AND any idle-timeout timer (`SSE_IDLE_TIMEOUT_MS = 60_000` per D4).

**Pseudocode (specification — binding for Phase 2).**

```typescript
// src/webapp/debates.stream.ts — SSE handler skeleton
async function handleDebateStream(req: AuthenticatedRequest, res: Response) {
  const { runId } = req.params;
  // ... auth + snapshot build (may throw before subscribe) ...

  let unsubscribed = false;
  let unsubscribe: (() => void) | null = null;
  let keepaliveTimer: NodeJS.Timeout | null = null;
  let idleTimer: NodeJS.Timeout | null = null;

  const onClose = () => {
    if (unsubscribed) return;
    unsubscribed = true;
    if (unsubscribe) unsubscribe();
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    if (idleTimer) clearTimeout(idleTimer);
    log.debug({ component: 'webapp.debates.stream', runId }, 'sse close');
  };

  // Quad-bind close paths BEFORE the subscribe (so that an immediate close
  // triggered by lifecycle event during subscribe still cleans up).
  req.on('close', onClose);
  res.on('close', onClose);
  res.on('error', onClose);
  res.on('finish', onClose);

  try {
    unsubscribe = debateEventBus.subscribe(runId, eventHandler);
    // ... write snapshot event ...
    keepaliveTimer = setInterval(writeKeepalive, KEEPALIVE_INTERVAL_MS);
    idleTimer = setTimeout(writeIdleClose, SSE_IDLE_TIMEOUT_MS);
    // long-lived; events flow via eventHandler until close
  } catch (err) {
    log.warn({ component: 'webapp.debates.stream', runId, err }, 'sse handler threw');
    onClose();
    throw err;
  }
}
```

The five paths are independent; the `unsubscribed` flag makes them idempotent — calling `onClose` from any path (including all five firing in rapid succession) clears state exactly once.

**Tests required (Phase 2 — closes Anti-Slop W1).** Add to `tests/integration/webapp.debates.stream.test.ts` AND `tests/unit/debate.eventbus.leak.test.ts`:

  1. **Test R1-1 (cleanup on `res.destroy()`):** Open SSE; assert `debateEventBus.listenerCount(\`run:${runId}\`) === 1`; force `res.destroy(new Error('test'))` server-side; assert listener count === 0 within one tick.
  2. **Test R1-2 (cleanup on `req.close`):** Open SSE; emit `req.emit('close')`; assert listener count === 0.
  3. **Test R1-3 (cleanup on synchronous handler throw):** Mock initial snapshot construction to throw a TypeError BEFORE subscribe; open SSE; assert listener count returns to (or stays at) 0; assert HTTP 500 returned.
  4. **Test R1-4 (cleanup idempotent on multiple close paths):** Open SSE; fire `req.close` AND `res.finish` AND `res.error` in succession; assert `unsubscribed` flag fires once; assert listener count === 0; no double-cleanup error.
  5. **Test R1-5 (100 subscribe-without-clean-disconnect leak guard):** Open 100 SSE connections; force-close 100 via `res.destroy()`; assert total leaked listeners across all run namespaces === 0 (`process` heap not growing). This is the W1 leak-test shape.

**File/line impact.**

  - `src/webapp/debates.stream.ts` — D13.a quad-binding + `unsubscribed` flag + outer try/catch + cleanup of keepalive + idle timers; ~25 LOC of binding logic.
  - `tests/integration/webapp.debates.stream.test.ts` — +5 tests (R1-1 to R1-4); ~80 LOC.
  - `tests/unit/debate.eventbus.leak.test.ts` — R1-5 leak-test (W1 closure); ~40 LOC.
  - ADR 016 D5 prose updated to point at D13.a as the canonical binding (D5's "try/finally" wording was misleading — corrected here).
  - ADR 016 D13 prose updated to add D13.a sub-section explicitly.

---

### R3 (HIGH — supersedes ADR 016 D7 lines 244-273) — Bind markdown URL belt-and-suspenders validator + 6 injection-probe tests

**Concern (DA P3 + Anti-Slop §9 convergent).** ADR 016 D7's `isSafeLinkUrl` validates via `new URL(url, window.location.origin)` + `SAFE_LINK_SCHEMES.includes(parsed.protocol)`. Multiple bypass classes need explicit binding: HTML entity (`&#106;avascript:...`), URL-encoded (`%6Aavascript:...`), leading whitespace (`[a]( javascript:...)`), embedded whitespace (`java\tscript:...`), image syntax masquerading as link (`![alt](javascript:...)`), reference-style links (`[a][b]\n[b]: javascript:...`). D7 doesn't bind that the markdown parser takes the URL verbatim (no entity decoding), doesn't bind `.trim()`, doesn't bind a belt-and-suspenders prefix regex on top of the URL parser.

**Decision — bind D7's URL validator with belt-and-suspenders + 6 markdown injection-probe tests; explicitly exclude image syntax and reference-style links from v1.16.0 markdown subset.**

**D7.b — URL validator binding (binding for Phase 2; supersedes D7 lines 244-273).**

```javascript
// public/webapp/organize/markdown.js — URL validator (binding)
function isSafeUrl(href) {
  // 1. Trim leading + trailing whitespace.
  const trimmed = href.trim();
  // 2. Reject empty.
  if (!trimmed) return false;
  // 3. HTML entity unescape — handles &#106;avascript:, &#x6A;avascript:, etc.
  //    Belt: parser does NOT entity-decode URLs (raw bytes from `[text](URL)`),
  //    but the validator decodes defensively as belt-and-suspenders.
  const unescaped = trimmed.replace(/&#(\d+);/g, (m, n) => String.fromCharCode(parseInt(n, 10)))
                           .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  // 4. URL-decode — handles %6Aavascript:, %4A%41%56%41%53..., etc.
  let decoded;
  try { decoded = decodeURIComponent(unescaped); } catch { return false; }
  // 5. Re-trim after decode (decoded result may have leading whitespace).
  const final = decoded.trim();
  // 6. Strict prefix regex (case-insensitive) — belt-and-suspenders allowlist.
  if (!/^(https?:\/\/|mailto:)/i.test(final)) return false;
  // 7. Final: try new URL() to catch any remaining browser-quirk parse paths.
  try {
    const u = new URL(final);
    return ['http:', 'https:', 'mailto:'].includes(u.protocol);
  } catch {
    return false;
  }
}
```

**Hard exclusions in v1.16.0 markdown subset (binding for Phase 2).**

  - **Image syntax `![alt](url)` is NOT parsed** — the parser does NOT recognize `![...]` as a tokenized form; lines containing `![` pass through to `textContent` as literal text. Reason: image embedding is an exfiltration channel; a hostile `<img src=javascript:...>` analog would bypass scheme allowlist via vendor-specific URL handlers.
  - **Reference-style links `[text][ref]` + `[ref]: url` are NOT parsed** — defer to v1.16.x. Only inline `[text](url)` syntax becomes a link.

**Tests required (Phase 2 — 6 markdown injection-probe tests; closes DA P3 + Anti-Slop §9).** Add to `tests/public/webapp/markdown.test.ts`:

  1. **Test R3-1 (`[click](javascript:alert(1))`):** Render. Assert NO `<a>` tag. Assert literal `[click](javascript:alert(1))` text appears in output.
  2. **Test R3-2 (`[click]( javascript:alert(1))` — leading space):** Render. Assert NO `<a>` tag (validator's `.trim()` + scheme check rejects).
  3. **Test R3-3 (`[click](&#106;avascript:alert(1))` — HTML entity):** Render. Assert NO `<a>` tag (validator's entity-unescape catches).
  4. **Test R3-4 (`[click](%6Aavascript:alert(1))` — URL-encoded):** Render. Assert NO `<a>` tag (validator's decodeURIComponent + scheme check rejects).
  5. **Test R3-5 (`![alt](javascript:alert(1))` — image syntax):** Render. Assert NO `<img>` tag, NO `<a>` tag. Assert literal `![alt](javascript:alert(1))` text appears in output (parser does not recognize `![]()` form).
  6. **Test R3-6 (`[click][ref]\n\n[ref]: javascript:alert(1)` — reference-style):** Render. Assert NO `<a>` tag. Assert literal text passes through (parser does not recognize reference-style).

**File/line impact.**

  - `public/webapp/organize/markdown.js` — `isSafeUrl` validator (binding above; ~25 LOC); +1-2 LOC parser guards confirming `![` and reference-style passes verbatim. Net ~30 LOC.
  - `tests/public/webapp/markdown.test.ts` — +6 injection-probe tests (R3-1 to R3-6); ~50 LOC.
  - ADR 016 D7 prose updated to add D7.b sub-section with the validator pseudocode + bypass-class enumeration.

---

### R4 (HIGH — supersedes ADR 016 D7 line 234) — Bind markdown DOS caps (200 items per list + 50 headings per doc + indentation IGNORED)

**Concern (DA P4 + Anti-Slop §10 convergent).** ADR 016 D7 line 234 lists `- bullet lists` and `1. numbered lists` as supported "single level, no nesting" but the binding is silent on (a) what "no nesting" means at parse time (silent flatten? indentation-respected?), (b) max items per list, (c) max headings per document. Phase 2 dev would have to invent all three. Hostile inputs (5000-item list within the 10240-char notes cap; 1000-deep indented list; 200-heading doc) all stay below input cap but produce ugly DOM.

**Decision — bind D7.c list/heading bounds; indentation IGNORED (no nested lists in v1.16.0; flat lists only).**

**D7.c — Markdown rendering bounds (binding for Phase 2; supersedes D7 line 234).**

  - **Per-list cap: 200 items.** Beyond 200, the list closes and a `<li class="markdown-truncated">… (truncated; N more items not rendered)</li>` appears as the final entry.
  - **Per-document heading cap: 50.** Beyond 50, additional heading lines render as plain `<p>` paragraphs.
  - **Indentation IGNORED.** All `- ` and `1. ` lines render as siblings of a single `<ul>`/`<ol>`. There is NO nested-list rendering in v1.16.0; even hostile 1000-deep indentation produces a single flat list. Document this clearly so users don't confuse it with a parser bug.
  - **Mixed list types in one block.** Consecutive `- ` lines belong to one `<ul>`; switching to `1. ` starts a new `<ol>`; switching back starts another `<ul>`. Same rule for `<h1>`/`<h2>`/`<h3>` boundaries.

**Tests required (Phase 2).** Add to `tests/public/webapp/markdown.test.ts`:

  1. **Test R4-1 (200-item cap):** Input = 250 lines of `- item N`. Render. Assert exactly 200 `<li>` rendered + 1 truncation marker `<li>`.
  2. **Test R4-2 (indentation flattens):** Input = `- a\n  - b\n    - c\n      - d\n`. Render. Assert exactly 4 sibling `<li>` in one `<ul>` (NOT nested).
  3. **Test R4-3 (50-heading cap):** Input = 60 lines of `# Heading N`. Render. Assert exactly 50 `<h1>` rendered + 10 `<p>` paragraphs (overflow as plain text, NOT additional headings).

**File/line impact.**

  - `public/webapp/organize/markdown.js` — list/heading counter + truncation marker; ~10 LOC.
  - `tests/public/webapp/markdown.test.ts` — +3 tests (R4-1 to R4-3); ~30 LOC.
  - ADR 016 D7 prose updated to add D7.c sub-section.

---

### R5 (HIGH — supersedes ADR 016 D6 line 214 + D9 line 332-353; closes Anti-Slop W2) — persistenceHook audit emission on hook failure

**Concern (DA P11 + Anti-Slop W2 convergent).** ADR 016 D6 line 214 says hook errors "are caught and logged at warn"; D5 line 184 says listener leak is silently allowed via `setMaxListeners(0)`. Combined gap: a `persistenceHook.onRound` failure is invisible to operators. The user sees the Telegram panel update (panel happens after hook); the SSE viewer doesn't see the round (the hook publishes to event bus AFTER the DB insert succeeds; if the insert fails, no publish); the audit row at terminal state captures the round (from in-memory state). Webapp shows N-1 rounds while Telegram shows N. The discrepancy persists. WARN log entries are forensics-by-grep; an audit row is queryable. Anti-Slop W2 separately raised the same gap from "per-callback try/catch wrapper shape not bound" angle.

**Decision — emit `'debate.persistence_error'` audit row on hook callback throw; bind per-callback try/catch wrapper shape; add audit category to AuditCategory union.**

**D6.b — persistenceHook error policy (binding for Phase 2; supersedes D6 line 214).**

When any of the four hook callbacks (`onStart`, `onRound`, `onVerdict`, `onAbort`) throws or rejects:

  1. Catch the error. Do NOT abort the debate.
  2. Log at `warn` level: `log.warn({ component: 'debate', hookName: 'onRound', runId, err: err.message }, 'persistenceHook callback failed; debate continues');`.
  3. **Emit an audit row** with category `'debate.persistence_error'` and detail JSON:
     - `{ debateRunId, roundNumber?, debaterName?, hookName: 'onStart' | 'onRound' | 'onVerdict' | 'onAbort', error: err.message.slice(0, 200) }`.
     - `userId` taken from the gateway's `runDebate` invocation context (the user who started the debate).
     - `roundNumber` and `debaterName` populated only when `hookName === 'onRound'`; null otherwise.
  4. Continue the debate. The in-memory `state.transcript` is the canonical record at terminal; the `debate.complete` audit row at terminal carries the FULL transcript regardless of any per-round hook failure.

**Per-callback try/catch wrapper (binding — closes Anti-Slop W2):**

```typescript
// src/debate/index.ts — pattern applied at each of the four hook call sites
try {
  await persistenceHook?.onRound(roundEvent);
} catch (err) {
  log.warn({ component: 'debate', hookName: 'onRound', runId: state.runId, err: (err as Error).message },
           'persistenceHook.onRound failed; debate continues');
  // Emit audit via memory.auditLog.insert (same path as debate.complete).
  await emitPersistenceErrorAudit({
    debateRunId: state.runId,
    roundNumber: roundEvent.roundNumber,
    debaterName: roundEvent.debaterName,
    hookName: 'onRound',
    error: (err as Error).message,
    userId: params.userId,
  });
  // Do NOT rethrow.
}
```

**D9.a — Audit category union update (binding for Phase 2; supersedes D9 line 330).**

Add `'debate.persistence_error'` to the `AuditCategory` union in `src/memory/auditLog.ts`. The union now includes (alongside `'webapp.debate_view'`):

```typescript
export type AuditCategory =
  | 'debate.complete'
  | 'debate.cancel'
  | 'debate.persistence_error'   // NEW per R5: hook callback failure forensics
  | 'webapp.debate_view'         // per D9: read-access only
  | /* … existing categories … */;
```

No migration needed (audit_log.category is `TEXT NOT NULL`; adding a string is a code-only change; matches v1.14.6 D7 pattern).

**Tests required (Phase 2 — closes Anti-Slop W2).** Add to `tests/integration/debate.persistenceHook.test.ts`:

  1. **Test R5-1 (`onRound` hook throw → audit row + debate continues):** Mock `persistenceHook.onRound` to throw on round 2 turn 3. Run debate. Assert `debate.persistence_error` audit row inserted with `{ debateRunId, roundNumber: 2, debaterName, hookName: 'onRound', error }`. Assert debate proceeds to terminal state. Assert in-memory `state.transcript` still has the round.
  2. **Test R5-2 (each of four hooks):** Mock each of `onStart`, `onRound`, `onVerdict`, `onAbort` independently; assert each fires its own `debate.persistence_error` row with correct `hookName` discriminant.
  3. **Test R5-3 (error message truncation):** Mock hook to throw `new Error('x'.repeat(500))`; assert audit row's `error` field is truncated to 200 chars.
  4. **Test R5-4 (per-callback wrapper isolation):** Mock `onStart` to throw; assert subsequent `onRound`/`onVerdict`/`onAbort` calls still fire (the catch in `onStart` does not unwind subsequent hook callsites).

**File/line impact.**

  - `src/memory/auditLog.ts` — `AuditCategory` union expanded; ~2 LOC.
  - `src/debate/index.ts` — per-callback try/catch wrapper at four hook callsites; `emitPersistenceErrorAudit` helper; ~25 LOC.
  - `tests/integration/debate.persistenceHook.test.ts` — +4 tests (R5-1 to R5-4); ~80 LOC.
  - ADR 016 D6 prose updated to add D6.b sub-section.
  - ADR 016 D9 prose updated to add D9.a (audit category union update).

---

### R2 (MEDIUM — supersedes ADR 016 D2 line 122 + Risk row 2) — Bind v1.16.0 single-user concurrency posture (≤5 concurrent debates per user; ≤4 SSE subscribers per debate)

**Concern (DA P2).** ADR 016 D2 line 122 says: "SQLite WAL + busy_timeout = 5000 setup handles concurrent writes adequately at single-user-instance scale." Adversarial: the architect's stated scale is ~5 debates/week per user; the system handles WAL contention at single-digit concurrent writes. At 100+ concurrent debates (multi-user shared, v1.18.0+ Avengers prep), the math changes. The ADR doesn't bound the concurrent-debate cap explicitly.

**Decision — bind explicit concurrency posture for v1.16.0; document multi-user as v1.18.0+ Avengers concern.**

**D2.c — v1.16.0 concurrency posture (binding for Phase 2; supersedes D2 line 122).**

  - **v1.16.0 deployment is single-user; multi-user shared debates is v1.18.0+ Avengers concern.**
  - **Concurrent-debate cap: `MAX_CONCURRENT_DEBATES_PER_USER = 5`.** Enforced at the gateway: when `/debate` is invoked, the gateway counts the user's `debate_runs` rows with `status='running'`; if ≥5, reject with a friendly Telegram message ("You already have 5 debates running. Wait for one to complete or cancel one with `/cancel`.").
  - **SSE subscribers per debate: ≤4** (one per debater column rendering — the upper bound assumes a single user has 4 browser tabs/windows open on the same debate detail view simultaneously).
  - **Aggregate cap derivation:** 5 concurrent debates × ~16 rounds × 4 turns/round × ~1 INSERT/turn = ~320 INSERTs per debate-run-window across all 5 debates. Spread over the runtime (rounds fire sequentially per debate but concurrently across debates), that's well within WAL + busy_timeout=5000 headroom.
  - **At v1.18.0+ scale (Avengers) re-examine:** If the user count grows or the ≤5 cap is lifted, the WAL + busy_timeout posture must be re-validated against the realistic concurrent-write rate.

**Constants (per D15 wire-constant discipline + R10-equivalent KI #12).**

```typescript
// src/gateway/debate.ts — constant
const MAX_CONCURRENT_DEBATES_PER_USER = 5;  // R2 (MEDIUM from CP1 v1.16.0):
                                             // gateway-enforced cap; ≤4 SSE subscribers per debate;
                                             // multi-user → v1.18.0+ Avengers re-examine.
```

**Tests required (Phase 2).** Add to `tests/integration/debate.gateway.test.ts`:

  1. **Test R2-1 (5-cap enforced):** Seed user with 5 `running` `debate_runs`; invoke `/debate` for that user; assert gateway rejects with the friendly message; assert NO new debate_runs row inserted; assert NO `runDebate` invocation.
  2. **Test R2-2 (cap allows after one completes):** Seed user with 5 `running` then mark one `complete`; invoke `/debate`; assert acceptance.

**File/line impact.**

  - `src/gateway/debate.ts` — `MAX_CONCURRENT_DEBATES_PER_USER` constant + count-and-reject branch at `/debate` invocation; ~12 LOC.
  - `tests/integration/debate.gateway.test.ts` — +2 tests (R2-1, R2-2); ~30 LOC.
  - ADR 016 D2 prose updated to add D2.c sub-section.

---

### R6 (MEDIUM — supersedes ADR 016 §Phase 2 boot path + adds D2.d) — pm2-restart zombie cleanup at boot

**Concern (DA P10).** ADR 016 doesn't bind what happens when pm2 restarts the Node process mid-debate. In-memory state (DebateEventBus listeners; runDebate orchestrator) dies; active SSE TCP connections close (RST); but `debate_runs` rows with `status='running'` stay in that state forever — there's no orchestrator to mark them aborted. The next webapp client opening the run sees `status='running'` indefinitely.

**Decision — bind boot-time zombie cleanup SQL.**

**D2.d — Boot-time zombie cleanup (binding for Phase 2; new sub-decision).**

On Node process boot, after migrations run, execute:

```sql
UPDATE debate_runs
   SET status = 'aborted',
       abort_reason = 'pm2_restart',
       updated_at = datetime('now')
 WHERE status = 'running'
   AND updated_at < datetime('now', '-5 minutes')
```

  - **5-minute threshold:** if the row was updated within the last 5 minutes, do NOT touch it — that could be an in-flight insert from a recently-restarted process or a still-active process. 5 minutes is generous (typical round duration is ~5-30s; pm2 restarts complete in seconds; a 5-minute idle running row is extremely likely to be abandoned).
  - **Runs in `initMemory`** (`src/memory/index.ts`) AFTER migrations run; BEFORE the gateway accepts connections. Fires once per process boot.
  - **Logging:** `log.info({ component: 'memory', count: rowsUpdated }, 'cleaned up N zombie debate_runs at boot');`.
  - **Audit:** No audit emission for the cleanup (it's a maintenance action, not a user-driven event); the WARN log is sufficient forensics.

**Tests required (Phase 2).** Add to `tests/integration/memory.boot.test.ts`:

  1. **Test R6-1 (zombie cleanup fires):** Seed two `debate_runs` with `status='running'` — one with `updated_at` 10 minutes ago, one with `updated_at` 1 minute ago. Run `initMemory`. Assert old row is now `status='aborted'` with `abort_reason='pm2_restart'`; assert young row is still `running`.
  2. **Test R6-2 (clean boot leaves nothing):** Seed only `complete`/`aborted` rows. Run `initMemory`. Assert NO updates fire.

**File/line impact.**

  - `src/memory/index.ts` — boot-time cleanup SQL after migrations; ~8 LOC.
  - `tests/integration/memory.boot.test.ts` — +2 tests (R6-1, R6-2); ~30 LOC.
  - ADR 016 D2 prose updated to add D2.d sub-section.

---

### R8 (MEDIUM — supersedes ADR 016 §3.5 line 703; defers detail-panel.js extraction to v1.17.0) — app.js LOC drift acknowledged + extraction explicitly deferred

**Concern (DA P20).** ADR 016 §3.5 line 703 says: "App.js post-v1.16.0 projection: 1,977 (post-v1.15.0) + 40 (D15 + D8 dispatch) = ~2,017 LOC — JUST over the 2000 trigger lowered by R1 in v1.15.0." DA verified actual: `wc -l D:/ai-jarvis/public/webapp/organize/app.js` = **2113 LOC** (HEAD). The 1977 figure was the v1.15.0 R1 PROJECTION; reality at v1.15.0 ship is 2113 — 136-LOC drift. Adding D15's ~+40 = **2153 LOC**, 76 past the 2000 trigger. v1.15.0 R1's trigger has ALREADY fired retroactively (v1.15.0 ship overshot).

**Two paths considered.**

- **Path A — Extract detail-panel.js NOW in v1.16.0** (~500 LOC mechanical move from app.js into a new detail-panel.js). Pro: closes the trigger immediately. Con: v1.16.0 already has 2 BLOCKING fixes (R1 + R7) and a heavy load (live debate viewer + 3-way diff + markdown); piling on a sizable extraction is scope creep and risk.
- **Path B — Defer extraction to v1.17.0 with explicit ADR-recorded acknowledgment** (mirrors v1.14.5 → v1.14.6 trash.ts pattern: an extraction trigger fires; the architect records the acknowledgment; the next iteration's first commit closes). Pro: keeps v1.16.0 scope manageable; the deferral is explicit + binding. Con: v1.16.0 ships with app.js at ~2153 LOC.

**Decision — Path B; defer detail-panel.js extraction to v1.17.0 first commit; explicit ADR record.**

**§3.5 prose correction (binding for Phase 2; supersedes ADR 016 §3.5 line 703).**

  - app.js HEAD = **2113 LOC** (verified `wc -l` 2026-04-25). The 1977 figure was the v1.15.0 R1 PROJECTION; v1.15.0 ship overshot by 136 LOC.
  - v1.16.0 adds D15 markdown swap (~10 LOC) + D8 3-way diff dispatch (~30 LOC) = **~+40 LOC**.
  - v1.16.0 ship projection: **~2153 LOC**.
  - **v1.15.0 R1's 2000-LOC trigger has already fired retroactively at v1.15.0 ship** (2113 > 2000).
  - **v1.16.0 explicitly defers the detail-panel.js extraction to v1.17.0 first commit.** This mirrors the v1.14.5 → v1.14.6 trash.ts pattern: an extraction trigger fires in iteration N; iteration N+1's first commit closes.
  - **v1.17.0 first commit obligation (binding):** mechanical extraction of `detail-panel.js` (~500 LOC moved out of app.js); post-extract app.js drops to ~1653 LOC. v1.17.0's other work proceeds on the cleaner baseline.

**KI entry update (per RA1 enumeration below).** KI entry "v1.17.0 first commit obligation: detail-panel.js extraction" carries this binding forward.

**Tests required (Phase 2).** None for v1.16.0 (the deferral is documentation-only). v1.17.0 will add the mechanical-extraction wire-integrity tests (matching the v1.15.0 R1 + v1.16.0 R7 pattern).

**File/line impact.**

  - ADR 016 §3.5 prose updated per the correction above.
  - `KNOWN_ISSUES.md` (this revisions doc + v1.16.0 KI propagation) — entry for the v1.17.0 first-commit obligation.
  - No code change in v1.16.0.

---

### MEDIUM probe clarifications (P8, P12, P14, P17 — folded into Phase 2 bindings)

**P8 (cross-user 404 timing — single-SQL verification).** D12 line 463 binds the safe pattern: `SELECT … FROM debate_runs WHERE id = ? AND user_id = ?`. **Phase 2 binding:** verify the implementation is ONE query, not TWO (no SELECT WHERE id, then check user_id in JS). UUID v4 entropy makes existence-oracle attacks infeasible (2^61 expected probes), but defense-in-depth says single-query. Test plan addition: `tests/integration/webapp.debates.detail.test.ts` AND `…stream.test.ts` each include an assertion that the SQL trace shows ONE query to debate_runs (not two). ~5 LOC test additions per file. No ADR text change beyond confirming the binding.

**P12 (markdown rendered in detail vs raw in edit form — inline help).** D15 binds Option A (detail rendered; edit raw). User pastes `**bold**`, sees rendered output; re-enters edit, sees raw `**bold**` again — confusing for non-markdown users. **Phase 2 binding:** add inline help string under the notes textarea + the progress textarea: "Notes use Markdown formatting (rendered in detail view)." ~3 LOC HTML; ~1 line CSS. Add to D15 prose.

**P14 (3-way diff with deleted server item — placeholder + relabel).** D8 doesn't address the case where the item was deleted/trashed between edit-mode entry and PATCH submit (412 envelope's `currentItem: null`). **Phase 2 binding:** when 412 envelope `currentItem: null`, render diff with server column showing `[Item deleted]` placeholder; relabel "Take Theirs" → "Discard"; "Take Mine" remains as "Save anyway" (recreate-item wire path deferred to v1.16.x). ~10 LOC in app.js diff dispatch. Add to D8 prose.

**P17 (3-way diff placement — top overlay modal).** D8 doesn't bind whether the 3-way diff renders inline (pushing edit form down) or as a top overlay modal. **Phase 2 binding:** top overlay modal. CSS `.diff-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 1000; display: flex; align-items: center; justify-content: center; }` with the diff panel centered. Edit form preserved underneath; user resolves diff; modal closes; edit form reflects resolution. ~5 LOC CSS; ~5 LOC overlay scaffold. Add to D8 prose.

---

### Anti-Slop closures (W1-W6 + F1 + F2)

  - **W1 (eventbus leak test shape) — closes via R1 quad-binding + R1-1 to R1-5 tests.** The leak-test shape (R1-5) explicitly counts `debateEventBus.listenerCount(\`run:${runId}\`)` after 100 force-closes and asserts === 0. Bound.
  - **W2 (D6 hook try/catch shape) — closes via R5 per-callback wrapper binding.** Each of `onStart`/`onRound`/`onVerdict`/`onAbort` wrapped per the R5 specification; log shape + audit emission both bound.
  - **W3 (D8 line-equality predicate) — bind: byte-exact after trimming trailing whitespace only.** Specifically: `const linesEqual = (a, b) => a.replace(/\s+$/, '') === b.replace(/\s+$/, '');`. Trailing whitespace ignored (matches Git's default-ish behavior; users routinely have trailing-space drift in textareas); leading whitespace, case, and Unicode normalization all preserved (case-sensitive, byte-exact otherwise). Test in `tests/public/webapp/diff.test.ts`: `diff3("foo \n", "foo\n", "foo  \n")` shows all-same; `diff3("FOO\n", "foo\n", "foo\n")` shows a remove/add pair on case difference. ~3 LOC binding + 2 tests.
  - **W4 (D14 mobile breakpoint convention) — bind: mobile-first `@media (min-width: 768px) { /* desktop grid */ }`.** Default state is the accordion (mobile); the media query promotes to grid at 768px+. 768px chosen to match iPad-portrait threshold + Tailwind's `md:` breakpoint + v1.15.0's existing convention in `public/webapp/organize/styles.css`. ~4 LOC binding in `public/webapp/debate/styles.css`.
  - **W5 (markdown swap regression test) — extends test plan §15 (D15 markdown swap regression).** New test in `tests/public/webapp/organize.markdown-render.test.ts`: existing items with `notes = "plain text\n\nwith blank lines"` render as `<p>plain text</p><p>with blank lines</p>` (NOT `<pre>`); existing `<pre>`-asserting tests in other organize-detail test files updated to assert `.markdown-content` instead. ~8 LOC binding + ~5 LOC of existing-test updates.
  - **W6 (markdown bounded regex + pathological-input test) — extends test plan §7 (D7 markdown).** Bind the four inline-token regexes in D7.d sub-decision: `BOLD = /\*\*([^*\n]+)\*\*/g`, `ITALIC = /\*([^*\n]+)\*/g`, `INLINE_CODE = /\`([^\`\n]+)\`/g`, `LINK = /\[([^\]\n]+)\]\(([^)\n]+)\)/g`. Character-class negation prevents catastrophic backtracking AND prevents tokens spanning newlines. Pathological-input test: `**` × 1000 input completes in < 100ms. ~5 LOC binding + 1 test.
  - **F1 (KI entries 3 + 7 thinness) — closes via expanded enumeration in RA1 update below.** Entry 3 (DebateEventBus) gains the unsubscribe-contract enforcement detail + R1 quad-binding. Entry 7 (markdown subset) gains the hard-exclusions enumeration (no images, no raw HTML, no autolinking, no reference-style) + the URL belt-and-suspenders pattern.
  - **F2 (test-count contract) — accepted as-is.** The "MAY consolidate" prose is loose but the binding floor (30 server + 50 client = 80) is concrete. Phase 2 ships within the projected 132-test ceiling; consolidating below 100 requires architect approval (matches F2's recommendation). No revision needed.

---

### RA1 enumeration update — 6th-consecutive-iteration discipline preserved

ADR 016 D16 enumerated 10 KI + 3 CLAUDE.md. After the R1-R8 + W1-W6 + F1-F2 revisions, the enumeration grows to **12 KI + 4 CLAUDE.md** (still in-ADR pre-empted; matches v1.15.0 D15 posture).

**KNOWN_ISSUES.md additions (12 entries; binding for Phase 2 commit 9):**

  1. **Debate webapp at `/webapp/debate/`; hub gets Debate tile.** Standalone webapp; separate domain model from organize.
  2. **`debate_runs` + `debate_rounds` tables (migration 013).** Two-table normalized; FK CASCADE; UNIQUE on `(debate_run_id, round_number, debater_name)`.
  3. **DebateEventBus singleton; `setMaxListeners(0)`; R1 close-handler quad-binding** (`req.on('close')` + `res.on('close')` + `res.on('error')` + `res.on('finish')` + outer try/catch with `unsubscribed` once-only flag). Symptom: missed close path leaks listener silently. Fix: quad-bind all close paths + once-only flag + outer catch. Prevention: integration test asserts `listenerCount === 0` after force-close.
  4. **Persistence hook contract; on-error: log.warn + emit `debate.persistence_error` audit row** (R5). Per-callback try/catch; log shape + audit shape both bound. Hook is gateway-provided; debate decoupled from memory layer.
  5. **SSE auth: HMAC at open; userId-scoped DB lookup with single-query SQL (P8); 60s idle close + 25s keepalive.** Reuses items.shared.ts auth chain (post-R7: items.auth.ts auth chain).
  6. **Markdown rendering subset (no external lib): headings/bold/italic/code/lists/links; flat lists only (no nesting per R4); bounded inline regexes (W6).** Indentation IGNORED.
  7. **Markdown link safety: belt-and-suspenders URL validator (R3) — trim → entity-unescape → URL-decode → re-trim → prefix regex `/^(https?:\/\/|mailto:)/i` → `new URL()` parse + scheme allowlist; image syntax NOT parsed; reference-style NOT parsed.** Hard exclusions documented.
  8. **Markdown DOS caps: per-list 200 items + truncation marker; per-document heading cap 50 (R4).** Bounded by input cap (notes 10240 + progress 20480) AND explicit caps.
  9. **3-way diff (~120 LOC LCS); top-overlay modal placement (P17); deleted-server-item placeholder + Discard relabel (P14).** Pure `diff3` algorithm + separate `renderDiffPanel`; long-text-only dispatch; v1.14.4 R1 2-button stays for short fields.
  10. **`webapp.debate_view` audit category for read access; `debate.persistence_error` for hook failures (R5).** No content in audit detail JSON; privacy posture mirrors `webapp.item_create`.
  11. **`items.auth.ts` split (NEW per R7); items.shared.ts drops 417 → 250 LOC; debate.shared.ts imports `authenticateRequest` from `items.auth.ts`.** Single source of truth for auth chain + ConflictTracker.
  12. **`MAX_CONCURRENT_DEBATES_PER_USER = 5` (R2); pm2-restart zombie cleanup at boot (R6).** v1.16.0 single-user posture; multi-user is v1.18.0+ Avengers concern.

(Plus carry-forward: **v1.17.0 first commit obligation: detail-panel.js extraction** per R8; explicit deferral with ADR record.)

**CLAUDE.md additions (4 invariants; binding for Phase 2 commit 9):**

  1. **Debate persistence hook contract:** `runDebate` calls hook on round/verdict/abort; gateway provides; on-error log.warn + emit `debate.persistence_error` audit row; debate continues. Hook ordering: scrub → `await onRound()` (try/catch) → `state.transcript.push` → `panel.updateState` (per D6 invariant; unscrubbed text never leaks).
  2. **SSE close-handler quad-binding pattern:** `req.on('close', cleanup)` + `res.on('close', cleanup)` + `res.on('error', cleanup)` + `res.on('finish', cleanup)` + outer try/catch with `unsubscribed = true` once-only flag. Cleanup unsubscribes from event bus + clears keepalive/idle timers.
  3. **Markdown renderer:** line-based parser → DOM construction → `textContent` only (NEVER `innerHTML`); URL allowlist + belt-and-suspenders (trim → entity-unescape → URL-decode → re-trim → prefix regex → `new URL()` parse); flat lists only; image and reference-style syntax NOT parsed.
  4. **`items.shared.ts` vs `items.auth.ts` boundary:** auth chain (`authenticateRequest`) + ConflictTracker live in `items.auth.ts` (single source of truth); audit emission helpers + `redactIp` + generic header helpers + error envelope shapes live in `items.shared.ts`. `debate.shared.ts` imports `authenticateRequest` from `items.auth.ts`; re-exports as needed for downstream callers.

---

## Pushback / disagreements with reviewers

**No reviewer findings declined.** All 2 BLOCKING + 3 HIGH + 6 MEDIUM + 6 W + 2 F accepted in some form (R1-R8 + W1-W6 closures + F1 expansion + F2 acceptance + 4 MEDIUM probe clarifications). The convergence between DA and Anti-Slop on R1/W1 (close-handler invariant + leak test shape), R5/W2 (per-callback try/catch + audit emission), and R7/§13 (items.shared.ts LOC drift + file-size threshold) made the architect's job mostly mechanical — bind the contracts the reviewers identified.

The architect's only structural addition beyond reviewer findings is **picking Path B for R7** (split items.shared.ts itself rather than duplicating auth into debate.shared.ts) and **picking Path B for R8** (defer detail-panel.js extraction to v1.17.0 first commit rather than extracting NOW). Both choices are documented per the v1.15.0 P2 R1 lesson against duplication (Path A on R7) and the v1.14.5 → v1.14.6 trash.ts pattern (deferral with explicit ADR record on R8).

---

## File-impact summary table for Phase 2 (with new commit -1 + commits 0-N)

| File | Change | Driver | LOC delta (post-revisions) |
|---|---|---|---:|
| `src/webapp/items.auth.ts` (NEW) | Mechanical extraction from items.shared.ts (commit -1) | R7 BLOCKING | **+170** |
| `src/webapp/items.shared.ts` | Commit -1 removes ~170 LOC (auth chain + ConflictTracker); 417 → ~250 | R7 BLOCKING | **−167** |
| `src/webapp/items.create.ts` / `items.read.ts` / `items.mutate.ts` / `items.complete.ts` / `itemsRoute.ts` | Import-line updates | R7 mechanical | **~+6** |
| `src/webapp/debate.shared.ts` (NEW per D10) | `authenticateRequest` import points at `./items.auth.ts` (per R7) | D10 + R7 | **+80** |
| `src/memory/migrations/013_debate_runs_and_rounds.sql` (NEW) | Tables + indexes + UNIQUE | D2 | **+45** |
| `src/memory/debateRuns.ts` (NEW) | Repo + zombie cleanup query (R6) | D2 + R6 | **~+135** (130 baseline + 5 R6) |
| `src/memory/debateRounds.ts` (NEW) | Repo | D2 | **+60** |
| `src/memory/index.ts` | Boot-time zombie cleanup call (R6) | R6 | **+8** |
| `src/memory/auditLog.ts` | `AuditCategory` union expanded with `'debate.persistence_error'` (R5) + `'webapp.debate_view'` (D9) | R5 + D9 | **+2** |
| `src/debate/eventbus.ts` (NEW) | EventEmitter singleton; `setMaxListeners(0)` | D5 | **+60** |
| `src/debate/index.ts` | `persistenceHook?` field + per-callback try/catch + `emitPersistenceErrorAudit` helper (R5) | D6 + R5 | **~+75** (50 baseline + 25 R5) |
| `src/gateway/debate.ts` | Hook construction + `MAX_CONCURRENT_DEBATES_PER_USER = 5` cap (R2) + count-and-reject branch | D6 + R2 | **~+72** (60 baseline + 12 R2) |
| `src/webapp/debates.list.ts` (NEW) | D11 list endpoint | D11 | **+90** |
| `src/webapp/debates.detail.ts` (NEW) | D12 detail endpoint; single-query SQL verified (P8) | D12 + P8 | **+110** |
| `src/webapp/debates.stream.ts` (NEW) | D13 SSE endpoint + R1 quad-binding (req+res+error+finish + outer try/catch + once-only flag) + cleanup of keepalive/idle timers | D13 + R1 | **~+225** (200 baseline + 25 R1) |
| `src/webapp/debatesRoute.ts` (NEW) | mountDebatesRoutes | D11+D12+D13 | **+50** |
| `src/webapp/server.ts` | Wire mountDebatesRoutes | D11+D12+D13 | **+5** |
| `public/webapp/index.html` | Hub Debate tile | D1 | **+10** |
| `public/webapp/debate/index.html` (NEW) | Debate webapp shell | D1 | **+100** |
| `public/webapp/debate/app.js` (NEW) | Debate detail + list + SSE client | D14 | **+600** |
| `public/webapp/debate/styles.css` (NEW) | Grid + accordion (W4 mobile-first 768px) | D14 + W4 | **~+254** (250 baseline + 4 W4) |
| `public/webapp/organize/markdown.js` (NEW) | Line-based parser + R3 belt-and-suspenders URL validator + R4 list/heading caps + W6 bounded regexes | D7 + R3 + R4 + W6 | **~+200** (150 baseline + 30 R3 + 10 R4 + 5 W6 + 5 R3 image/ref guards) |
| `public/webapp/organize/diff.js` (NEW) | Pure `diff3` (LCS line-by-line) + `renderDiffPanel` + W3 line-equality predicate (trim trailing whitespace) | D8 + W3 | **~+173** (170 baseline + 3 W3) |
| `public/webapp/organize/app.js` | D15 markdown swap (~10) + D8 3-way diff dispatch (~30) + P12 inline help + P14 deleted-item placeholder + P17 overlay modal scaffold | D15 + D8 + P12 + P14 + P17 | **~+50** (2113 → ~2163; v1.17.0 detail-panel.js extraction will close per R8) |
| `public/webapp/organize/styles.css` | Markdown content styles + diff overlay (P17) | D15 + P17 | **~+50** |
| `tests/unit/webapp.items.auth.test.ts` (NEW or relocated) | Mechanical relocation of auth-chain tests; ZERO logic change (R7-1) | R7 commit -1 | **~+30** (relocated; net 0 vs prior) |
| `tests/integration/memory.debateRuns.test.ts` (NEW) | Repo + migration 013 idempotency | D2 | **+200** (12 tests) |
| `tests/integration/memory.debateRounds.test.ts` (NEW) | Repo + UNIQUE + cascade | D2 | **+100** (6 tests) |
| `tests/integration/memory.boot.test.ts` (NEW or extended) | R6 zombie cleanup (R6-1, R6-2) | R6 | **+30** (2 tests) |
| `tests/unit/debate.eventbus.test.ts` (NEW) | publish/subscribe/unsubscribe + namespace + setMaxListeners | D5 | **+80** (5 tests) |
| `tests/unit/debate.eventbus.leak.test.ts` (NEW) | R1-5 leak-test (W1 closure) | R1 + W1 | **+40** (1 test) |
| `tests/integration/debate.persistenceHook.test.ts` (NEW) | Order + abort + absent compat + error caught (4 baseline) + R5 (R5-1 to R5-4) | D6 + R5 | **~+160** (80 baseline + 80 R5) |
| `tests/integration/debate.gateway.test.ts` (NEW or extended) | R2 5-cap (R2-1, R2-2) | R2 | **+30** (2 tests) |
| `tests/integration/webapp.debates.list.test.ts` (NEW) | D11 list endpoint | D11 | **+150** (9 tests) |
| `tests/integration/webapp.debates.detail.test.ts` (NEW) | D12 detail endpoint + single-query SQL assertion (P8) | D12 + P8 | **~+135** (130 + 5 P8) |
| `tests/integration/webapp.debates.stream.test.ts` (NEW) | SSE snapshot/round/verdict/complete/error/idle/keepalive/reconnect/auth/audit/abort/close (12 baseline) + R1-1 to R1-4 + single-query (P8) | D13 + R1 + P8 | **~+295** (240 baseline + 50 R1 + 5 P8) |
| `tests/integration/webapp.debates.audit.test.ts` (NEW) | D9 audit emission (5 tests) | D9 | **+80** |
| `tests/public/webapp/debate.list-view.test.ts` (NEW) | D14 list view rendering | D14 | **+150** (10 tests) |
| `tests/public/webapp/debate.detail-view.test.ts` (NEW) | D14 detail view rendering | D14 | **+200** (12 tests) |
| `tests/public/webapp/debate.sse-client.test.ts` (NEW) | SSE client snapshot/reconnect/backoff/close | D14 | **+120** (8 tests) |
| `tests/public/webapp/markdown.test.ts` (NEW) | 20 baseline injection probes + R3 (R3-1 to R3-6) + R4 (R4-1 to R4-3) + W6 pathological-input | D7 + R3 + R4 + W6 | **~+330** (240 baseline + 50 R3 + 30 R4 + 10 W6) |
| `tests/public/webapp/diff.test.ts` (NEW) | Pure diff (8) + render (4) + W3 line-equality (2) | D8 + W3 | **~+193** (170 baseline + 23 W3) |
| `tests/public/webapp/organize.markdown-render.test.ts` (NEW) | D15 swap (4 baseline) + W5 regression test (1) | D15 + W5 | **~+88** (80 baseline + 8 W5) |
| `tests/public/webapp/organize.diff-conflict.test.ts` (NEW) | D8 conflict dispatch (5 tests) + P14 deleted-item placeholder (1) | D8 + P14 | **~+90** (80 baseline + 10 P14) |
| `D:\ai-jarvis\KNOWN_ISSUES.md` | 12 v1.16.0 entries (R1-R8 + W1-W6 + F1) | R1-R8 + W1-W6 + F1 | **~+130** |
| `D:\ai-jarvis\CLAUDE.md` | 4 v1.16.0 invariants | R1 + R5 + R7 + D7 | **~+25** |
| `docs/CHANGELOG.md` | v1.16.0 entry (Phase 5) | unchanged | +50 |
| `package.json` | Version bump 1.15.0 → 1.16.0 | unchanged | +1 |

**Estimated total LOC delta vs ADR 016 baseline:**

  - **ADR 016 baseline (architect's projection):** ~2,391 source / ~2,900 tests / docs = ~5,467 total.
  - **Post-revisions projection:**
    - **Source code (production):** +170 (items.auth.ts NEW) − 167 (items.shared.ts) + 6 (import updates) + 80 (debate.shared.ts) + 45 (migration 013) + 135 (debateRuns.ts) + 60 (debateRounds.ts) + 8 (memory/index.ts boot cleanup) + 2 (auditLog.ts union) + 60 (eventbus.ts) + 75 (debate/index.ts) + 72 (gateway/debate.ts) + 90 + 110 + 225 + 50 + 5 + 10 + 100 + 600 + 254 + 200 + 173 + 50 + 50 = **~+2,463 LOC** (vs ~2,391 baseline; +72 vs ADR 016 baseline; the bulk delta is R1 quad-binding (~+25), R3 belt-and-suspenders (~+30), R4 caps (~+10), R5 audit emission (~+25), R6 boot cleanup (~+13), R7 net (~+9 across files), R2 cap (~+12), W3+W4+W6 (~+12), P12+P14+P17 (~+15)).
    - **Test code:** ~+30 (items.auth) + 200 + 100 + 30 + 80 + 40 + 160 + 30 + 150 + 135 + 295 + 80 + 150 + 200 + 120 + 330 + 193 + 88 + 90 = **~+2,501 LOC** (vs ~2,900 baseline + R-revision additions; total ~2,900-3,100 effective).
    - **Docs:** +130 KI + 25 CLAUDE.md = **+155 LOC**.
    - **CHANGELOG:** +50.
    - **Version:** +1.
  - **Test ratio:** ~50% (2501 / (2463 + 2501)). Healthy; matches ADR 016's projected ~55%.

**Source code (non-test) LOC delta:** ~2,463 with all relocations counted; ~2,294 net new. Of this, the bulk is server-side (memory + debate + webapp/debates.*); the rest is client-side (debate webapp + markdown.js + diff.js + organize/app.js touches); ~155 is docs.

**Test count delta (post-revisions):** ADR 016 baseline 132 tests + R1 +5 (R1-1 to R1-5) + R2 +2 + R3 +6 + R4 +3 + R5 +4 + R6 +2 + R7 +3 (R7-1 to R7-3 mechanical wire-integrity) + W3 +2 + W5 +1 + W6 +1 + P8 +2 (single-query assertions across detail + stream) + P14 +1 = **~164 tests.** Phase 2 binding: 164 tests is the new target; consolidating below 130 requires architect approval.

---

## Final R-list ordered by Phase 2 file impact

| # | Severity | Resolution | Primary file impact | LOC |
|---|---|---|---|---:|
| **R7** | BLOCKING | Pre-extract `items.auth.ts` as Phase 2 commit -1; items.shared.ts 417 → ~250; debate.shared.ts imports from items.auth.ts | `items.auth.ts` NEW (+170) + `items.shared.ts` (−167) + 5 importer updates (+6) + 3 wire-integrity tests | **+170 mech + 30 test** |
| **R1** | BLOCKING | SSE close-path quad-binding (req+res+error+finish + outer try/catch + once-only flag); cleanup keepalive/idle timers | `debates.stream.ts` (+25) + tests (+50 R1-1..R1-4 + 40 R1-5 leak) | **+115** |
| **R3** | HIGH | Markdown URL belt-and-suspenders validator + image/reference syntax not parsed + 6 injection-probe tests | `markdown.js` (+30) + tests (+50) | **+80** |
| **R5** | HIGH | persistenceHook audit emission (`debate.persistence_error` category) + per-callback try/catch + 4 tests | `debate/index.ts` (+25) + `auditLog.ts` (+2) + tests (+80) | **+107** |
| **R4** | HIGH | List/heading caps (200 items + 50 headings + indentation IGNORED) + 3 tests | `markdown.js` (+10) + tests (+30) | **+40** |
| **R2** | MEDIUM | `MAX_CONCURRENT_DEBATES_PER_USER = 5` gateway cap + 2 tests | `gateway/debate.ts` (+12) + tests (+30) | **+42** |
| **R6** | MEDIUM | Boot-time zombie cleanup SQL + 2 tests | `memory/index.ts` (+8) + `debateRuns.ts` (+5) + tests (+30) | **+43** |
| **R8** | MEDIUM | Defer detail-panel.js extraction to v1.17.0 first commit; ADR §3.5 prose correction | doc-only ADR §3.5 + KI carry-forward entry | doc-only |
| **W1** | Anti-Slop W1 | Eventbus leak test shape (R1-5) | covered in R1 | covered |
| **W2** | Anti-Slop W2 | Per-callback try/catch shape | covered in R5 | covered |
| **W3** | Anti-Slop W3 | Line-equality predicate (byte-exact after trim trailing) | `diff.js` (+3) + tests (+20) | **+23** |
| **W4** | Anti-Slop W4 | Mobile-first `@media (min-width: 768px)` | `debate/styles.css` (+4) | **+4** |
| **W5** | Anti-Slop W5 | Markdown swap regression test | tests (+8) | **+8** |
| **W6** | Anti-Slop W6 | Bounded inline regexes + pathological-input test | `markdown.js` (+5) + tests (+10) | **+15** |
| **F1** | Anti-Slop cosmetic | KI entries 3 + 7 expanded | covered in RA1 update | doc-only |
| **F2** | Anti-Slop cosmetic | Test-count contract acceptable as-is | n/a | n/a |
| **P8** | MEDIUM | Single-SQL verification (already bound; assertion test addition) | tests (+5 per file × 2 = +10) | **+10** |
| **P12** | MEDIUM | Inline help string under notes/progress textareas | `organize/index.html` (+3) | **+3** |
| **P14** | MEDIUM | Deleted-server-item placeholder + Discard relabel | `organize/app.js` (+10) + tests (+10) | **+20** |
| **P17** | MEDIUM | Top-overlay modal placement for diff | `organize/app.js` (+5) + `organize/styles.css` (+5) | **+10** |
| **RA1** | enumeration | KI 10 → 12; CLAUDE.md 3 → 4 | `KNOWN_ISSUES.md` (+130) + `CLAUDE.md` (+25) | **+155** |

**Phase 2 commit ordering (binding — Phase 2 commit -1 ADDED ahead of v1.16.0 commit 0):**

  - **Commit -1:** `items.auth.ts` extraction (mechanical; ZERO logic change; closes R7 BLOCKING; updates importers in items.{create,read,mutate,complete}.ts + itemsRoute.ts).
  - **Commit 0:** Migration 013 (D2 schema) + DebateRunsRepo + DebateRoundsRepo + R6 boot-time zombie cleanup wiring.
  - **Commit 1:** AuditLog category union expansion (D9 `'webapp.debate_view'` + R5 `'debate.persistence_error'`) + debate.shared.ts (D10; imports `authenticateRequest` from `./items.auth.ts` per R7).
  - **Commit 2:** debate/eventbus.ts (D5; EventEmitter singleton).
  - **Commit 3:** debate/index.ts hook plumbing (D6) + R5 per-callback try/catch + emitPersistenceErrorAudit helper.
  - **Commit 4:** gateway/debate.ts (hook wire + R2 5-cap).
  - **Commit 5:** webapp/debates.list.ts (D11).
  - **Commit 6:** webapp/debates.detail.ts (D12; P8 single-query SQL verified).
  - **Commit 7:** webapp/debates.stream.ts (D13 + R1 quad-binding + cleanup of keepalive/idle timers).
  - **Commit 8:** webapp/debatesRoute.ts + webapp/server.ts wiring.
  - **Commit 9:** organize/markdown.js (D7 + R3 belt-and-suspenders + R4 caps + W6 bounded regexes).
  - **Commit 10:** organize/diff.js (D8 + W3 line-equality).
  - **Commit 11:** Hub Debate tile (D1; index.html +10).
  - **Commit 12:** Debate webapp index.html + app.js + styles.css (D14 + W4 mobile-first 768px).
  - **Commit 13:** organize/app.js D15 markdown swap + D8 3-way diff dispatch + P12 inline help + P14 deleted-item placeholder + P17 overlay modal; organize/styles.css for diff overlay.
  - **Commit 14:** Test files in lockstep (R7-1..R7-3; R1-1..R1-5; R3-1..R3-6; R4-1..R4-3; R5-1..R5-4; R6-1..R6-2; R2-1..R2-2; W3 + W5 + W6 + P8 + P14; D2 + D5 + D6 + D9 + D11 + D12 + D13 + D14 baseline tests).
  - **Commit 15:** RA1 enumeration — KNOWN_ISSUES.md +12 entries + CLAUDE.md +4 invariants.
  - **Commit 16:** CHANGELOG + version bump 1.15.0 → 1.16.0; ship.

End of revisions document for v1.16.0 CP1.
