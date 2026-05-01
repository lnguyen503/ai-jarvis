# Jarvis — Working With the Codebase

Developer notes for agents and contributors. Read this before making changes.

---

## Architecture Quick Reference

- **Entry point:** `src/index.ts` → grammY bot + Express server
- **Telegram command routing:** `src/commands/` — one file per command group
- **Storage:** `src/organize/storage.ts` — all file I/O for the `/organize` module (flat-file markdown with YAML front-matter, SQLite via `src/memory/`)
- **Web app routes:** `src/webapp/` — Express routes for the Telegram WebApp UI at `public/webapp/organize/`
- **Tools:** `src/tools/` — agent-callable tools (file I/O, shell, calendar, etc.)
- **Type definitions:** `src/organize/types.ts`, `src/webapp/` per-route — do not redeclare types inline
- **Tests:** `tests/unit/` (Vitest, no server) and `tests/integration/` (Vitest, real SQLite + tempdir storage)

---

## Module Conventions

### Validation logic lives in validation.ts
All organize-item field validation is in `src/organize/validation.ts`. Do NOT duplicate validation in route handlers or chat commands. Both `src/webapp/items.mutate.ts` and any new surface import `validatePatchBody` from there.

### Items module split (v1.14.2+)
Webapp item routes are split by HTTP verb:
- `src/webapp/items.read.ts` — GET endpoints
- `src/webapp/items.mutate.ts` — PATCH / DELETE / POST /complete
- `src/webapp/items.shared.ts` — auth chain, audit helpers, `redactIp`, shared types

The legacy `src/webapp/itemsRoute.ts` is a shim kept for backwards compat with `server.ts`. New routes go in the matching file.

### writeAtomically random tmp suffix (R8 — do not change)
`writeAtomically` at `src/organize/storage.ts` uses a per-call random 6-byte hex suffix for the temp file. This was a BLOCKING fix (R8, v1.14.2). Do not revert to a static suffix. Regression suite: `tests/integration/storage.concurrency.test.ts`.

---

## v1.14.3 Invariants

### stampUpdated discipline
Every write path that calls `serializeItem` with new content MUST stamp `updated:` via the `stampUpdated(fm)` helper **before** passing the front-matter to the serializer. Verified write paths:

| Path | Stamps? |
|---|---|
| `createItem` | YES |
| `updateItem` | YES |
| `softDeleteItem` rewriteContent (line ~702) | YES |
| `appendProgressEntry` | YES |
| `restoreItem` | YES |
| `softDeleteItem` rename to .trash | NO — pure FS move, no content change |
| `evictExpiredTrash` unlink | NO — file is deleted; no stamp needed |

Phase 2 (and any future iteration) must grep-check: every `serializeItem(...)` call in `storage.ts` is preceded by a `stampUpdated(...)` call OR has an explicit inline comment justifying the omission.

### restoreItem rename-first pattern
The `restoreItem` storage primitive follows the same **rename-first** ordering as `softDeleteItem` (which does `rename(live, trash)`). `restoreItem` does the inverse:

1. `rename(trashPath, livePath)` — atomic file move. If this fails, nothing moved; no orphan. If it succeeds and step 2 fails, the file is in the live dir with `deletedAt` still set; R7 filters it from `listItems`; a second `restoreItem` call skips the rename (file already live) and retries step 2 — idempotent.
2. `readFile` → strip `deletedAt: null` → `stampUpdated(fm)` → `writeAtomically(livePath, content)` — atomic write via R8 random-tmp primitive.

**Do NOT replace with `writeAtomically(live) → unlink(trash)`** — that ordering has an unlink-failure case that creates an orphan (live + trash copies of the same id with different content). The rename-first pattern is structurally safe.

Any future `recoverItem` / `unArchiveItem` / reparent primitive that moves files between directories MUST follow the same rename-first pattern.

### hierarchy.js ES module choice
`public/webapp/organize/app.js` is loaded with `<script type="module" src="./app.js" defer>`. This enables ES module `import`/`export` syntax. The CSP `script-src 'self' https://telegram.org` permits same-origin module loads because the source is `'self'`.

`hierarchy.js` is a pure ES module at `public/webapp/organize/hierarchy.js`. Import it with:
```javascript
import { groupByParent } from './hierarchy.js';
```

**Do NOT introduce a bundler** (no Vite, no Webpack, no esbuild). Vanilla ES modules are the deliberate convention for this webapp. All three webapp JS files (`app.js`, `hierarchy.js`, and any future module) must be loaded as `type="module"` scripts from the same origin.

If Telegram WebApp's in-app browser ever fails to support ES Modules (smoke test: open the organize page and check the console), the fallback is to expose via `window.OrganizeHierarchy = {...}` and consume globally. Document the choice at the top of `app.js` with a 2-line comment per the CP1 RA3 guidance.

---

## Audit Categories

| Category | When emitted |
|---|---|
| `webapp.item_mutate` | Successful PATCH / DELETE / POST /complete (not 4xx/5xx) |
| `webapp.stale_edit` | mtime mismatch detected on any mutation |
| `organize.restore` | Successful `/organize restore <id>` chat command |
| `organize.create` | Every `organize_create` tool call; includes `result: 'rejected'` + `reason` on guard failures |

All audit detail JSON stores `itemId` but NEVER title, notes, or progress content (privacy posture per v1.14.2 RA2). `webapp.item_mutate` stores `changedFields: string[]` (field NAMES only, not values).

---

## Security Invariants (Client)

- ALL user-authored content rendered via `textContent` ONLY — never `innerHTML`.
- Textarea values set via DOM property `.value` — never `setAttribute('value', ...)`.
- No native `confirm()` — use the inline "tap again" pattern (mirrors the delete confirm flow).
- No inline event handlers in HTML (`onclick="..."` is forbidden by CSP).
- No inline `<script>` bodies — CSP `script-src 'self' https://telegram.org` blocks them.

---

## v1.14.4 Invariants

### ETag header naming convention (v1.14.4 RA2a)
Standard HTTP response header `ETag` and request header `If-Match` per RFC 7232. The ONLY custom request header is `X-Force-Override: 1` for the Save Anyway path. Do not introduce additional `X-*` headers for conflict-detection concerns. CORS-safe under same-origin (cloudflared tunnel today — webapp and API served from the same origin; no preflight for these headers). Future multi-origin deployment (e.g., webapp at `app.jarvis.example.com`, API at `api.jarvis.example.com`) MUST either (a) list both `If-Match` and `X-Force-Override` in `Access-Control-Allow-Headers` (~3 LOC server-side), or (b) replace `X-Force-Override` with a body field `{forceOverride: true}` (~10 LOC validator update). Reference: ADR 012 D2/D5/D13; revisions doc R8.

### TOCTOU same-read invariant for `updateItem.options.expectedEtag` (v1.14.4 RA2b / R1)
When the storage primitive `updateItem` (or `softDeleteItem`) is called with `options.expectedEtag`, the ETag check MUST share the read with the FrontMatter that drives the response. Specifically: `fs.stat` + `readFile` happen in ONE sequential pair; `currentEtag` is computed from THAT `(parsedFm, fileMtimeMs)` pair; on mismatch, the thrown `ETAG_MISMATCH` error carries `currentFm` + `currentMtimeMs` from THAT read; the route handler builds the 412 envelope from `err.currentFm` WITHOUT re-reading or re-stat-ing disk. Adding a second stat or read between the check and the 412 response would allow a concurrent writer to make `currentEtag` and `currentItem` in the 412 body inconsistent — the client would see a 412-loop (it uses the stale ETag from the envelope for its next save, which also 412s). Chat-side callers (`organize_update.ts`, `organize_complete.ts`) call `updateItem` WITHOUT `options.expectedEtag` and pay ZERO `fs.stat` overhead — the conditional stat is only added when the caller opts in. Reference: ADR 012 D8; revisions doc R1/R6.

### Three layers on POST /complete (v1.14.4 RA2c — v1.14.2 R18 + v1.14.4 D9 + v1.14.4 R4)
POST /complete has three independent safety mechanisms that compose in a specific order:
1. **R4 no-op fast-path (v1.14.4)** — runs FIRST. If `body.done === (currentStatus === 'done')`, return 200 with current item, no write, no audit row, no ETag check. Eliminates ceremony for idempotent calls.
2. **D9 If-Match check (v1.14.4)** — runs SECOND for actual state-change path. Required-when-present per D3; 412 on mismatch with `currentEtag` + `currentItem` in body.
3. **R18 absolute-write semantic (v1.14.2)** — runs THIRD inside `updateItem`. `{done: true}` always sets `status = 'done'` regardless of current state; even if If-Match is absent, the data-corruption case is closed.

The order matters: changing to e.g. ETag-check-before-no-op would force unnecessary 412s on idempotent calls. Any new layer addition MUST update this comment block and reference the relevant ADR/revision. Reference: ADR 010 R18; ADR 012 D9; revisions doc R4.

---

## v1.14.5 Invariants

### parentId TOCTOU acceptance
Parent existence is checked at PATCH time via `parentExistsAndIsActiveGoal` (which mirrors the v1.14.3 R7 `deletedAt` filter at `src/organize/storage.ts:560-565`). The R1 BLOCKING fix ensures that a parent in the mid-soft-delete window (file has `deletedAt` stamped but not yet renamed to `.trash/`) is treated as NOT_FOUND. The accepted AFTER-validate-before-write TOCTOU window (D3): if the parent is deleted between `parentExistsAndIsActiveGoal` returning `{ok:true}` and `updateItem` writing the new `parentId`, the child stores a parentId pointing to a trashed goal. The v1.14.3 hierarchy renderer treats orphan children as top-level (`groupByParent` in `hierarchy.js`); no UI surprise. Locking the parent during PATCH would over-engineer; the orphan-renders-top-level rule provides graceful degradation. Reference: ADR 013 D3; revisions doc R1.

### BroadcastChannel scope discipline
Channel name `ORGANIZE_MUTATIONS_CHANNEL = 'organize-mutations-jarvis'` is hardcoded in `public/webapp/organize/app.js` for v1.14.5. The `-jarvis` suffix scopes to this bot's webapp. Multi-bot future (Avengers v1.18.0+) parameterizes by bot username — one constant change, filed in TODO.md. Always feature-detect: `typeof BroadcastChannel !== 'undefined'` before instantiation. Always wrap `postMessage` in try/catch to handle iOS Telegram WebApp partial-support population (some versions define the API but throw on use); on first throw, set `bcChannel = null` for the session (poison-pill). `broadcastMutation` MUST only be called on actual 200 success — never on 412 / 4xx / 5xx / network error (W4 contract; tests enforce). Reference: ADR 013 D8/D10; revisions doc R4/R7.

### Trash module location
`listTrashedItems` lives in `src/organize/storage.ts` at v1.14.5 (~+80 LOC). The natural extraction trigger: when `storage.ts` crosses **1300 LOC** OR v1.14.6 starts — extract `src/organize/trash.ts` with `listTrashedItems` + `evictExpiredTrash` + `softDeleteItem` coupling (these three functions share the `.trash/` directory concern; co-locating them reduces cross-file navigation). Pre-bound trigger; do not defer further. Reference: ADR 013 D7; revisions doc R5.

---

## v1.14.6 Invariants

### Verb-asymmetric If-Match — bulk operations contract
Bulk PATCH (re-parent) MUST send a per-item `If-Match: "<etag>"` header. Bulk DELETE and bulk POST /complete MUST NOT send `If-Match`. This asymmetry is intentional and load-bearing — delete/complete are intent-clear / absolute-write operations where a stale ETag only causes spurious 412s. Any change to add `If-Match` to delete/complete requires a new ADR revision. Reference: ADR 014-revisions R1+W2.

### Typed-confirm threshold is a named constant, not a magic number
`BULK_DELETE_TYPED_CONFIRM_THRESHOLD = 50` must remain a named wire constant at the top of `app.js`. The UX branch (typed-confirm vs. two-tap) is tested against this constant name in `webapp.organize.client.test.ts`. Inlining the literal `50` anywhere in the branch condition is a test-breaking anti-pattern. Reference: ADR 014-revisions R2; RA1 wire-constant discipline.

### Always-reset BC dedup — no "skip if timer set" guard
`handleBroadcastMessage` uses `clearTimeout(_bcDedupTimer); _bcDedupTimer = setTimeout(...)` unconditionally on every incoming message. Do NOT add a `if (_bcDedupTimer) return` short-circuit — that would deliver the stale first-message ETag instead of the fresh last-message state. Banner-show (edit-form conflict path) is exempt from the dedup window and fires immediately. Reference: ADR 014-revisions R8.

### R9 mutual exclusion must be symmetric
`enterSelectMode` / `exitSelectMode` and `enterCreateForm` / `exitCreateForm` each set AND restore both `.hidden` and `.disabled` on the opposing button. If only `.hidden` is set, a focused button can still be activated by keyboard. If only `.disabled` is set, the button remains in layout and confuses AT users. Both attributes must be set together in both directions. Reference: ADR 014-revisions R9.

---

## v1.15.0 Invariants

### View switcher whitelist is strict-equal only — no Array.includes, no regex
`loadView()`, `saveView()`, and `switchView()` all use `value === 'list' || value === 'kanban' || value === 'calendar'` comparisons. The `VALID_VIEWS` array constant exists for documentation only and must NOT be used for the whitelist comparison. Do NOT use `VALID_VIEWS.includes(raw)` — Array.prototype.includes can be prototype-polluted and turns the whitelist into an allowlist under adversarial sessionStorage injection. Do NOT use a regex — a future ADR can re-evaluate, but for now the triple-OR is the binding pattern. `webapp.organize.client.test.ts` has injection-probe tests that enforce this. Reference: ADR 015-revisions R7.

### Calendar date arithmetic is UTC-only — all cell placement uses getUTC* accessors
`dates.js` is the sole source of date arithmetic. Every function uses `Date.UTC(...)` constructors and `date.getUTCFullYear() / getUTCMonth() / getUTCDate() / getUTCDay()`. Do NOT use `date.getFullYear()`, `date.getMonth()`, `date.getDate()`, or `date.getDay()` in any calendar cell or DnD path. `new Date('YYYY-MM-DD')` produces midnight LOCAL time; in UTC−N timezones this shifts the date by a day. The `parseISO` function enforces round-trip correctness (rejects `'2026-13-45'`, `'2026-02-30'`). `dates.js` has a mandatory top-of-file JSDoc warning (`W3`). Regression test: `webapp.organize.dates.test.ts` — DST edge `parseISO('2026-03-08')`. Reference: ADR 015 D3; ADR 015-revisions W3.

### cancelPendingRollback must be the first call in any new pickup entry point
Any code path that establishes a new DnD pickup state (i.e., sets `_pickedItem`) MUST call `cancelPendingRollback()` first. This is already enforced at the start of `handleCardTap`, `enterKanbanView`, and `exitKanbanView`. If a future entry point (e.g., keyboard pickup, mobile long-press) is added, it MUST follow the same pattern. Failing to do so allows two items to carry the `rollback-animating` class simultaneously, and the deferred `requestAnimationFrame` / `setTimeout` callbacks from the first item will fire against the wrong DOM node after the second pickup reorders columns. Reference: ADR 015-revisions R3.

### BroadcastChannel name comes from /api/webapp/config — D9 boot ordering is non-negotiable
`fetchWebappConfig(initData)` must be called and awaited via `.then()` before `initBroadcastChannel()` at boot. The current ordering in DOMContentLoaded is: `fetchWebappConfig(initData).then(() => { initBroadcastChannel(); })`. Do NOT move `initBroadcastChannel()` outside the `.then()` callback, and do NOT make the two calls parallel (`Promise.all`). Rationale: `_resolvedChannelName` must be set before `new BroadcastChannel(_resolvedChannelName)` is called; if they race, the BroadcastChannel is constructed with the fallback name even when the server returned a per-bot name. `webapp.organize.client.test.ts` enforces the ordering with a source-position assertion. Reference: ADR 015 D9.

---

## v1.16.0 Invariants

### Debate persistence hook contract (RA1 invariant 1)
`runDebate` calls the persistence hook at each lifecycle event: `onStart`, `onRound`, `onVerdict`, `onAbort`. The hook is provided by the gateway (`src/gateway/debate.ts`) — `runDebate` itself has zero direct repo imports. Hook ordering is: scrub turn text → `await onRound()` (per-callback try/catch) → `state.transcript.push` → `panel.updateState`. This ordering ensures unscrubbed content never leaks through the hook before scrubbing. On any hook callback throw: (1) catch the error, (2) log at `warn`, (3) emit `'debate.persistence_error'` audit row with `{ debateRunId, roundNumber?, debaterName?, hookName, error: msg.slice(0, 200) }`, (4) continue the debate. The `debate.complete` audit row at terminal state carries the full in-memory transcript regardless of per-round hook failures. Reference: ADR 016 D6/D6.b (R5).

### SSE close-handler quad-binding pattern (RA1 invariant 2)
Every SSE handler (`src/webapp/debates.stream.ts`) MUST bind cleanup to ALL FIVE close paths: `req.on('close', onClose)` + `res.on('close', onClose)` + `res.on('error', onClose)` + `res.on('finish', onClose)` + outer try/catch with `unsubscribed = true` once-only flag. The `unsubscribed` flag makes all five paths idempotent. Cleanup MUST unsubscribe from the `debateEventBus` AND clear the keepalive interval AND clear the idle-timeout timer. Do NOT rely solely on `req.on('close')` — it does NOT fire on `res.destroy()`, socket errors, or unhandled rejections before the await loop exits. `debateEventBus.setMaxListeners(0)` suppresses the Node.js leak warning for unlimited concurrent connections; the quad-binding contract is what actually prevents leaks. Integration test `debate.eventbus.leak.test.ts` asserts `listenerCount === 0` after 100 force-closes. Reference: ADR 016 D5/D13 + R1.

### Markdown renderer invariants (RA1 invariant 3)
`public/webapp/organize/markdown.js` is the ONLY place markdown is rendered in the organize webapp. Rules:
1. Line-based parser → DOM construction → `textContent` only. NEVER `innerHTML` for user content.
2. URL allowlist enforced by `isSafeUrl()`: trim → entity-unescape (decimal + hex) → URL-decode → re-trim → `/^(https?:\/\/|mailto:)/i` prefix regex → `new URL()` parse + scheme allowlist `['http:', 'https:', 'mailto:']`.
3. Image syntax `![alt](url)` is NOT parsed — passes through as literal text.
4. Reference-style links `[text][ref]` are NOT parsed — passes through as literal text.
5. Flat lists only — indentation IGNORED (no nested lists in v1.16.0).
6. Per-list cap: 200 items + truncation marker `<li class="markdown-truncated">`. Per-document heading cap: 50; overflow renders as `<p>`.
7. Inline regexes use character-class negation (e.g., `[^*\n]+`) to prevent catastrophic backtracking and cross-line matching.
Reference: ADR 016 D7/D7.b/D7.c + R3/R4/W6.

### `items.shared.ts` vs `items.auth.ts` boundary (RA1 invariant 4)
Auth chain (`authenticateRequest`) + `ConflictTracker` live in `src/webapp/items.auth.ts` (single source of truth). Audit emission helpers + `redactIp` + generic header helpers (`readIfMatchHeader`, `readForceOverride`, `cacheControlNoStore`) + error envelope shapes + `ItemsRouteDeps` interface live in `src/webapp/items.shared.ts`. `debate.shared.ts` imports `authenticateRequest` from `./items.auth.ts` — never from `items.shared.ts`. All items.* routes (`items.create.ts`, `items.read.ts`, `items.mutate.ts`, `items.complete.ts`, `itemsRoute.ts`) import `authenticateRequest` from `./items.auth.ts`. Do NOT add auth-chain logic to `items.shared.ts`; do NOT duplicate `authenticateRequest` into `debate.shared.ts`. Reference: ADR 016 D10 + R7 BLOCKING.

---

## v1.17.0 Invariants

### detail-panel.js boundary (RA1 invariant 1)
`public/webapp/organize/detail-panel.js` owns rendering + state for the detail view. Contains: `renderDetail`, `enterDetailView`, `exitDetailView`, detail meta block rendering, markdown integration calls, `currentDetailItem` + `currentDetailEtag` state vars + getters/setters (`getCurrentDetailItem`, `getCurrentDetailEtag`, `setCurrentDetailEtag`, `clearDetailState`). `app.js` MUST NOT re-declare `currentDetailItem` or `currentDetailEtag` directly; use the accessor functions exported by `detail-panel.js`. Do NOT add detail-rendering logic back to `app.js`. Reference: ADR 017 D1 + W1.

### Per-resource shared module discipline (RA1 invariant 2)
Each new webapp resource has its own `*.shared.ts` file: `src/webapp/scheduled.shared.ts` (cron), `src/webapp/memory.shared.ts`, `src/webapp/audit.shared.ts`. Each mirrors the `debate.shared.ts` shape (ADR 016 D10): re-exports `authenticateRequest` from `items.auth.ts`, defines the `*RouteDeps` interface, defines audit category pairs, exports audit emission helpers. Do NOT bundle all three resources into a single `webapp.shared.ts` catch-all. Reference: ADR 017 D5.

### Memory storage path-traversal: dual-layer whitelist (RA1 invariant 3)
Memory key regex `^[a-z0-9_-]{1,64}$` enforced at TWO layers: (1) client-side `validateMemoryKey` in `public/webapp/memory/app.js`, (2) server-side in `src/webapp/memory.mutate.ts`. Server is authoritative; client provides fast UX feedback. Any future route that reads/writes a memory file via a user-supplied key MUST apply this regex as the first validation step. Do NOT derive a file path from a user-supplied key without running the whitelist check first. Reference: ADR 017 D3 + KI 10.

### Cron preview: `src/scheduler/cronPreview.ts` — 525,600 iteration cap; no new npm dep (RA1 invariant 4)
`cronPreview.ts` is the SOLE preview-computation module. `MAX_PREVIEW_ITERATIONS = 525_600` (365 × 1440) and `MAX_PREVIEW_RESULTS = 5` are the authoritative constants — do NOT change them or add a `--force-long-preview` escape hatch. `src/webapp/scheduled.preview.ts` imports `previewCronFireTimes` from `../scheduler/cronPreview.js` — NOT from `cron-parser` (which is NOT a dependency). Do NOT add `cron-parser` or any other cron-parsing library to package.json. node-cron is used only for actual task scheduling in `src/scheduler/index.ts`. Reference: ADR 017-revisions R1.

### `userMemoryEntries.ts` is the sole writer for keyed memory entries (RA1 invariant 5)
`src/memory/userMemoryEntries.ts` is the SOLE WRITER for keyed entries (entries containing `<!-- key:my_pref -->` sentinels). All CRUD on keyed entries MUST go through `userMemoryEntries.ts.{listMemoryEntries, getMemoryEntry, createMemoryEntry, updateMemoryEntry, deleteMemoryEntry}`. `userMemory.ts.appendUserMemoryEntry` continues for UNKEYED appends only (chat-side `/update_memory` tool). Do NOT add keyed-entry support to `appendUserMemoryEntry`. Read-time fallback: malformed sentinels → `legacy_<sha8>` key; never crash. Sentinel injection guard: `createMemoryEntry` + `updateMemoryEntry` reject bodies containing `<!-- key:` substring. Reference: ADR 017-revisions R3 + F1.

---

## v1.18.0 Invariants (Coach Jarvis)

### Coach module one-way edge (RA1 invariant 1)
`src/coach/` reads from `src/organize/` + `src/memory/` + `src/tools/`. NO file in `src/organize/**` may import from `src/coach/**`. Enforced by `tests/static/coach-no-reverse-import.test.ts`. Reverse edge inverts the dependency graph (organize is foundational; coach is a consumer) and creates circular-import risk. If you need an organize helper from inside coach: import it. If you're tempted to call coach from organize: STOP — expose what's needed from organize and let coach call it. Reference: ADR 018 D15 + Anti-Slop F2 BLOCKING.

### Coach allowlist enforced by code, not prompt (RA1 invariant 2)
`config.coach.disabledTools` default contains 8 tools removed from coach turn allowlist: `run_command`, `schedule`, `organize_complete`, `organize_delete`, `forget_memory`, `calendar_delete_event`, `calendar_update_event`, `gmail_draft`. Coach prompt (`src/coach/coachPrompt.md`) STILL contains "never call X" clauses but enforcement is at the dispatcher (any disabled-tool call from a coach turn returns `UNAUTHORIZED_IN_CONTEXT`). **Models slip; prompt-clauses are documentation, not a brake.** Adding a "the agent must not do X" rule to the coach prompt for a tool not in `disabledTools` is a §15 violation. Always also add to `disabledTools`. Reference: ADR 018-revisions R6/F1 CONVERGENT BLOCKING.

### Tool dispatcher wraps external-content output in `<untrusted>` (RA1 invariant 3 — system-wide retrofit)
`src/tools/index.ts` wraps the output of 6 tools — `web_search`, `browse_url`, `read_file`, `list_directory`, `search_files`, `recall_archive` — in `<untrusted source="<tool>" args="...">...</untrusted>` boundary tags. Closed-set constant `UNTRUSTED_CONTENT_TOOLS` controls which tools wrap. Wrap happens AFTER scrubber + truncate, BEFORE return-to-agent. Adding a NEW tool that returns external content: add to `UNTRUSTED_CONTENT_TOOLS`. v1.18.0 commit 0c closes a latent gap that pre-dated v1.18.0; per-domain wrappers existed (organize/injection.ts, organize/triagePrompt.ts, plan/synthesizer.ts) but the dispatcher didn't wrap. Reference: ADR 018-revisions R1/D19 BLOCKING.

### Coach scheduled task uses marker convention `description='__coach__'` (RA1 invariant 4)
`COACH_TASK_DESCRIPTION = '__coach__'` is the single source of truth (exported from `src/coach/index.ts`). Identifies the coach scheduled task; idempotent setup queries by this marker. The PROMPT field stores `COACH_PROMPT_PLACEHOLDER = '${coach_prompt}'` (also a constant); scheduler resolves to `loadCoachPrompt()` at fire time. User-attempted webapp PATCH with `description='__coach__'` is rejected with `RESERVED_DESCRIPTION` 400. Static test `tests/static/coach-named-constants-single-source.test.ts` asserts both literals appear in only `src/coach/index.ts` across `src/**`. Reference: ADR 018-revisions W2.

### Coach memory key format and sentinel parser extension (RA1 invariant 5)
Coach memory entries use the keyed-memory infrastructure with key shape `coach.<itemId>.<eventType>` where eventType ∈ `{lastNudge, research, idea, plan}`. Per-(item, eventType) FIFO cap of 30 entries; oldest dropped on 31st write. Cap is enforced at the coach tool layer (`src/coach/coachMemory.ts`), NOT in the underlying keyed-memory storage. Per-coach-turn cap (R3): max 5 nudges + max 10 total writes per coach scheduled fire — counter on `ToolContext.coachTurnCounters`, initialized to `{nudges: 0, totalWrites: 0}` at coach turn entry; chat-side calls don't gate. Sentinel parser regex extended from `[a-z0-9_-]{1,64}` to `[a-zA-Z0-9._-]{1,128}` for dotted keys; backward-compatible with v1.17.0 simple keys. Reference: ADR 018 D2 + D3 + revisions R3 + R5/F3.

### NUL-byte ban + per-field char caps on coach memory text (RA1 invariant 6)
Coach memory write tools (`coach_log_nudge`, `coach_log_research`, `coach_log_idea`, `coach_log_plan`) reject NUL bytes (`\x00`) in every text field via reused `src/organize/validation.ts` helper (parallel to v1.14.3 D2/D3 NUL ban on `notes`/`progress`/`title`). Per-field char caps: `nudgeText` ≤ 1024, `query` ≤ 256, `resultDigest` ≤ 4096, `suggestion` ≤ 512, `ideaSummary` ≤ 1024, `planSummary` ≤ 4096. Worst-case memory growth at 100 active coached items: ~24 MB/user (research entries dominant; ~2 KB/entry). Acceptable; documented. Reference: ADR 018-revisions R5/F3 CONVERGENT BLOCKING.

### LOC accounting discipline (RA1 invariant 7)
ADR LOC tables in R1 sections MUST be computed AFTER all self-edits to ARCHITECTURE.md / STRUCTURE.md complete. Self-editing the docs while computing the projection drifts the doc baselines (architect's projection becomes stale). v1.18.0 caught this trap a third time (after v1.15.0 R1 + v1.16.0 R7). Mitigation: write the LOC table as the LAST section of the ADR; re-run `wc -l` on every row before committing the ADR. The architect's claim "verified via wc -l" must be true at the moment of write, not at the moment of initial estimation. Pre-emptive splits are commit-zero (NOT deferred conditionals): when a file would cross the 500 soft threshold post-iteration, extract a sibling module BEFORE feature work begins (W1 commits 0a + 0b + 0d in v1.18.0). Reference: ADR 018-revisions R2 + W1 + KI v1.18.0-7.

---

## v1.19.0 Invariants (Coach polish + Calendar two-way sync)

### Auto-intensity inference lives in the coach prompt, not in code (RA1 invariant 1)
`coachIntensity = 'auto'` (5th value; default for items with no field set; explicit `'off'` STAYS off). Inference rules in `src/coach/coachPrompt.md` Step 1; LLM applies them per item per coach run. Adding a new auto rule = edit prompt, no code change. Acceptable non-determinism at single-user scale; promote to deterministic JS heuristic if telemetry requires. Reference: ADR 019 D1.

### NL override parser is PURE — coach memory writes via sole-writer chain (RA1 invariant 2)
`src/coach/userOverrideParser.ts` returns intent objects only; NO side effects. Coach memory writes for overrides go through `coach_log_user_override` in `src/coach/coachOverrideTool.ts` (reuses v1.18.0 R5/F3 NUL ban + char caps + R3 per-turn cap). `agent.turn()` does NOT auto-invoke the parser; writes happen only from coach scheduled fires OR explicit `/coach back-off X` chat commands. Static test `tests/static/agent-no-parser-import.test.ts` enforces. Reference: ADR 019-revisions R3/W1 BLOCKING.

### Calendar sync infinite-loop defense (RA1 invariant 3)
Round-trip identity via `extendedProperties.private.itemId` (NO PII; just itemId). Reverse sync only writes if `event.modified > item.lastSyncedAt + 100ms`. Without `lastSyncedAt` the loop fires forever (the trap). Document hygiene: NEVER put item title / notes / progress in `extendedProperties` — only the opaque ID. Reference: ADR 019 D7 + D9.

### Calendar sync cursor recovery: 24h fallback (RA1 invariant 4)
`calendar.jarvis_sync_cursor` keyed memory entry. On missing/corrupted: fall back to `events.list({ updatedMin: now - 24h })` + write fresh cursor. NEVER fail, NEVER prompt user. Manual `/calendar reset-cursor` chat command audits as `coach.calendar_cursor_reset`. Reference: ADR 019 D5 + D6.

### Calendar drag-reschedule reuses kanban DnD pattern (RA1 invariant 5)
`calendar-day-view.js` / `calendar-week-view.js` / `calendar-month-view.js` reuse `kanban-view.js`'s `cancelPendingRollback` + optimistic-move + 5s-undo-toast pattern. v1.15.0 invariant 3 (`cancelPendingRollback` first call in any new pickup entry point) binds calendar drag. Don't reimplement DnD; import. Reference: ADR 019 D3 + D19 + D20.

### Today focus card uses existing endpoints — no new server routes (RA1 invariant 6)
`today-focus-card.js` reads GET `/api/webapp/items` + GET `/api/webapp/memory?prefix=coach.` (both existing). Compute coach picks + due-today + engaged-state client-side. Anti-Slop §6 single-source-of-truth: don't add specialty endpoints when generic ones suffice. Reference: ADR 019 D4.

### Coach fatigue: 3-strike-then-7-day-skip; persistent items NEVER fatigue (RA1 invariant 7)
After 3 consecutive `lastNudge.outcome === 'ignored'` on the same gentle item, coach writes `coach.<itemId>.fatigue` keyed memory via `coach_log_fatigue` tool. Coach run reads + skips until expiry. **Persistent items DO NOT fatigue** — user policy is user policy. Audit category `coach.fatigue` in closed set. Reference: ADR 019 D13.

### Reverse-sync `<untrusted>` is TWO LAYERS — sanitizer + prompt builder (RA1 invariant 8)
External content from Google Calendar is hostile by default. **Layer (a):** `sanitizeCalendarTextForSync()` in `src/calendar/sync.ts` STRONG-REJECTS prompt-injection markers (`<untrusted`, `</untrusted`, `Ignore previous instructions`, `<!-- key:`, `<!-- coach:`) at sync entry; NUL ban + char caps. **Layer (b):** `src/coach/coachPromptBuilder.ts` wraps every item's user-text fields in `<untrusted source="organize.item" itemId="..." field="...">…</untrusted>` when building active-items injection block. Both layers required (Anti-Slop §15 defense-in-depth). Calendar-side ingress is the ONLY new external-content path in v1.19.0; extends v1.18.0 commit 0c dispatcher retrofit. Reference: ADR 019-revisions R1/F1 BLOCKING; Decision 21.

### Gateway plumbing for coachTurnCounters carry-forward (RA1 invariant 9 — binding from v1.18.0 ea0a8fd)
v1.18.0 commit ea0a8fd is the load-bearing fix wiring `coachTurnCounters` through `gateway.enqueueSchedulerTurn` → `agent.turn()`. v1.19.0 chat commands (`/coach back-off X`, `/coach push X`) invoke tools directly via the chat-side dispatcher — they correctly DON'T pass coachTurnCounters per v1.18.0 R3 invariant 5 (chat-side calls don't gate). Any future SCHEDULED-FIRE entry point MUST thread coachTurnCounters or R6/F1 + R3 brakes go inert. Test `tests/integration/coach.gateway-plumbing.test.ts` is the regression anchor. Reference: ADR 019-revisions W2.

---

## v1.20.0 Invariants (Multi-coach + event-driven proactive coach)

### COACH_PROFILES closed set + per-profile marker convention (RA1 invariant 1)
4 profiles in closed set: `morning | midday | evening | weekly`. Distinct marker per profile (`__coach_morning__` / `__coach_midday__` / `__coach_evening__` / `__coach_weekly__`). All 4 + legacy `__coach__` reserved (RESERVED_DESCRIPTION 400 on user PATCH). Single source of truth: `COACH_MARKER_BY_PROFILE` in `src/coach/index.ts`. Static test `tests/static/coach-profile-closed-set.test.ts`. Reference: ADR 020 D1 + D2.

### Profile-agnostic coach memory (RA1 invariant 2)
Profiles affect WHEN coach fires; memory tracks WHAT coach has done. Fatigue counter accumulates across all profiles per item. `/coach status` surfaces per-item state. Reference: ADR 020 D5.

### Boot-wiring lint (RA1 invariant 3 — 4th iter trap class pre-empted)
Static test `tests/static/coach-event-wiring.test.ts` (commit 0a) walks `src/index.ts` for `notify(ItemStateChange|ChatMessage|CalendarEvent)` callbacks; rejects 12 stub patterns. Layer-2 cross-file reachability test `tests/static/coach-prompt-builder-reachable.test.ts` (commit 11.5) asserts target functions have ≥1 production call site (catches the v1.19.0 W1 dead-code trap). Reference: ADR 020 D17 + 020-revisions R2.

### `buildCoachTurnArgs()` SSOT (RA1 invariant 4)
`src/coach/index.ts buildCoachTurnArgs()` returns canonical TurnParams with `isCoachRun: true` + `coachTurnCounters` + `isSpontaneousTrigger?`. Both scheduled cron path AND `gateway.fireSpontaneousCoachTurn` MUST consume this helper. Direct `agent.turn(` calls from coach contexts FORBIDDEN — `tests/static/coach-turn-args.test.ts` (commit 9.5) enforces. Reference: ADR 020-revisions R1.

### Rate limiting primitives (RA1 invariant 5)
Per-item 4h via `coach.<itemId>.lastSpontaneousAt`. Global daily cap 3 via `coach.global.spontaneousCount.<dayIso>`. Quiet mode via `coach.global.quietUntil`. All checked by `triggerFiring.dispatchTrigger()` before firing; blocks → `coach.event_trigger.suppressed` audit. Atomic via keyed memory sole-writer. Reference: ADR 020 D8.

### Trigger priority order (RA1 invariant 6)
`back_off (user override) > push (user override) > fatigue > done_signal > standard`. Within standard: `chat > item-state > calendar`. Mutually exclusive per fire — first match wins. Reference: ADR 020 D11.

### 30-min coach-DM cooldown + 60s user-message debounce (RA1 invariant 7)
After any coach DM (cron OR spontaneous), event triggers ignore user messages for 30 min (feedback-loop prevention). Plus 60s debounce after user types — triggers wait for typing pause. Stored as `coach.global.lastCoachDMAt` + `coach.global.lastUserMessageAt`. Reference: ADR 020 D10 + D12.

### Migration boot-ordering invariant (RA1 invariant 8)
`migrateLegacyCoachMarker()` MUST run before `scheduler.start()` in `src/index.ts`. Static test `tests/static/coach-migration-ordering.test.ts` enforces. Migration is idempotent: skip if target already exists; on conflict (both legacy + new) delete legacy + audit `coach.migration_conflict`. Three migration audit categories. Reference: ADR 020 D2 + 020-revisions R3.

---

## v1.21.0 Invariants (Avengers — multi-bot ensemble)

### BOT_NAMES closed set + per-process bot identity (RA1 invariant 1)
`BOT_NAMES = ['ai-jarvis', 'ai-tony']` (closed set; `src/config/botIdentity.ts`). Each Telegram bot is a SEPARATE pm2 process resolving its `BotIdentity` from `BOT_NAME` env. Adding bots = code change to extend BOT_NAMES + new persona file; no architecture change. Static test enforces. Reference: ADR 021 D1 + D2.

### Per-bot data isolation + WAL-aware migration (RA1 invariant 2)
Each bot's data lives at `data/<botName>/`. Pre-v1.21.0 single-bot data migrates to `data/ai-jarvis/...` on first boot. **`PRAGMA wal_checkpoint(TRUNCATE)` MUST run BEFORE renaming `jarvis.db`** so uncommitted WAL writes flush — otherwise data loss. Symlink rejection at idempotency check. Two-phase audit-buffer: any rename failure aborts + emits `bot.migration_failed`. Migration runs BEFORE `initMemory()` (boot ordering invariant). Static test `tests/static/bot-migration-ordering.test.ts` enforces. Reference: ADR 021 D3 + 021-revisions R1.

### Path-sandbox narrows to `data/<botName>/` per process (RA1 invariant 3)
Tier 1 path-sandbox narrows from `["{build_dir}"]` to `data/<botName>/` per process. ai-tony cannot read/write `data/ai-jarvis/`. Helper `wrapPathForBotIdentity()` gates read_file / write_file / list_directory / search_files. **`run_command` REMOVED from ai-tony's specialist allowlist** (CP1 R6 §15: shell bypasses path-sandbox). Sandboxed shell deferred v1.22.0+. Reference: ADR 021 D4 + R6.

### Per-bot persona prompt + `{{TOOL_LIST}}` template SSOT (RA1 invariant 4)
Personas at `config/personas/<botName>.md`. `{{TOOL_LIST}}` template variable substituted at load time from `botIdentity.allowedTools`. Static test `tests/static/persona-tool-list-template.test.ts` rejects hardcoded tool names in persona .md files (drift = v1.18.0 R6/F1 trap on a new surface). Reference: ADR 021 D5 + R4/W2.

### Per-bot tool allowlist + 3-gate dispatcher ordering (RA1 invariant 5)
Two scopes: `'full'` (ai-jarvis; back-compat) and `'specialist'` (ai-tony; 9 tools). Dispatcher 3 gates in order: GATE 1 `botIdentity.allowedTools` (broadest) → GATE 2 `allowedToolNames` (per-turn) → GATE 3 `coachTurnCounters` `coach.disabledTools` (per-coach-turn; v1.18.0 R6/F1). GATE 1 rejection emits `bot.tool_unauthorized` audit. Reference: ADR 021 D6 + W1.

### Mention routing — each bot independently (RA1 invariant 6)
Each bot in groups processes messages only when (a) `@<selfBotUsername>` mention (structured Telegram `entities`; case-insensitive) OR (b) reply-to-self. Multiple-bot mentions → BOTH process independently. No central router. Reference: ADR 021 D7.

### Inter-bot wrap + boundary clause + SQLite self-echo drop (RA1 invariant 7)
Bot-to-bot messages wrapped `<from-bot name="...">...</from-bot>`. Each persona has the verbatim **Inter-bot boundary discipline** clause (per `docs/PROMPT_INJECTION_DEFENSE.md`). Self-echo drop via SQLite table `bot_self_messages` (migration 006; `INSERT OR IGNORE` atomic; per-bot DB; 1h TTL). Replaces failed keyed-memory FIFO (concurrent-write race + 20-entry cap too small). Reference: ADR 021 D8 + D9 + R2 + R3.

### Loop protection: 3-turn cap per thread; reset on user (RA1 invariant 8)
Max 3 sequential bot-to-bot turns per Telegram thread. Counter `bot.thread.<threadKey>.botToBotCount` with TTL 1h. **User message resets** (DA open Q). 4th turn → drop + audit `bot.loop_protection.engaged`. Reference: ADR 021 D10.

### ToolContext.botIdentity SSOT carry-forward (RA1 invariant 9)
6th-iter trap class pre-emption. ALL `ToolContext` literal construction in `src/` MUST go through `buildToolContext()` (`src/tools/buildToolContext.ts`). Static test `tests/static/tool-context-bot-identity.test.ts` catches direct ToolContext construction that bypasses identity population. Reference: ADR 021 D16 + F1.

### PM2 ecosystem.config.cjs is CommonJS (RA1 invariant 10)
`ecosystem.config.cjs` (NOT `.js` or `.mjs`) — PM2 doesn't natively load ESM. Each bot is an app entry with `BOT_NAME` env. `pm2 start ecosystem.config.cjs` (or `npm run start:avengers`) brings the ensemble up. Reference: ADR 021 D11.

### Per-bot pino child logger (RA1 invariant 11)
At boot: `const log = pino().child({ component: 'index', botName: identity.name })`. All downstream loggers inherit `botName` binding. Combined with PM2 file-separation per bot for parallel-bot debugging. Reference: ADR 021 §21.1 + W3.
