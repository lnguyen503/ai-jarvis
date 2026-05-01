# ADR 009 — Revisions after CP1 debate (2026-04-25)

**Parent:** `009-v1.14.0-organize-webapp.md`
**Status:** Accepted. Folded into ADR 009 by reference. Developer agents implement the revised spec; deviations require another addendum.
**Context.** Devil's Advocate review (`docs/reviews/cp1-devils-advocate-v1.14.0.md`) raised 0 BLOCKING + 1 BLOCKING-adjacent HIGH + 13 MEDIUM + 4 LOW + 2 new risks. Anti-Slop Phase 1 (`docs/reviews/anti-slop-phase1-review-v1.14.0.md`) raised 3 FAIL-adjacent + 9 warnings. Both reviewers independently caught the same JSDoc lie in `storage.ts` and the metadata-vs-full-body assumption in the brief — convergence signal that the architect's SF-1 finding was load-bearing. Twelve resolutions below.

---

## Resolved (R1 through R12)

### R1 (FAIL-adjacent — supersedes decision 7) — Route split to `src/webapp/itemsRoute.ts` ships in v1.14.0 (Anti-Slop R1)

**Concern.** ADR claimed `server.ts` was "~300 LOC" and that the route split should trigger only when v1.14.x crosses 500. **Verified false:** `wc -l src/webapp/server.ts` = **468 LOC today** (v1.13.1). Adding 2 new routes + auth chain duplication pushes it past 600 immediately. Phase 2 dev would either (a) cram into one growing file (Anti-Slop §5/§9/§13 violation by ship time), or (b) split mid-iteration without spec direction.

**Decision.** Split now, in v1.14.0:

1. **`src/webapp/server.ts`** stays as the Express factory — `createWebappServer`, `WEBAPP_BIND_ADDR`, rate limiter, audit debouncer, CSP middleware, `/api/webapp/echo` (it stays inline since it's tiny + paradigmatic). Server binds the routes from the items module via a single `mountItemsRoutes(app, deps)` call.
2. **`src/webapp/itemsRoute.ts`** (NEW) — exports `mountItemsRoutes(app: Express, deps: ItemsRouteDeps): void`. Contains the inline auth chain (per architect decision 7 — keep the inline pattern) for both `/api/webapp/items` and `/api/webapp/items/:id`. Imports `listItems`, `readItem` from `src/organize/storage.ts`. Imports `verifyTelegramInitData` from `src/webapp/auth.ts`. Imports the rate-limit + audit-debounce hooks from `server.ts` (or a shared `middleware.ts` if Phase 2 finds it cleaner — dev-agent's call as long as the boundary is named).
3. **`ItemsRouteDeps`** shape: `{config, dataDir, memory, auth: VerifyFn, rateLimit: RateLimitFn, auditDebounce: DebouncerFn}`. Pure-function injection — testable in isolation.

**Test path mirror:** `tests/integration/webapp.organize.test.ts` exercises `mountItemsRoutes` against a minimal Express harness. No change to the integration test surface.

### R2 (FAIL-adjacent — supersedes decision 7's helper-extraction note) — Both `dataDirFromConfig` duplicates documented (Anti-Slop R2)

**Concern.** ADR cited ONE duplicate of `dataDirFromConfig`. Anti-Slop verified TWO exist: `src/commands/organize.ts:62` AND `src/commands/memory.ts:41`. Phase 2 dev would migrate one and leave the other inconsistent.

**Decision.** Phase 2 extracts to `src/config/dataDir.ts` and migrates ALL three call sites in one commit:

```typescript
// src/config/dataDir.ts (NEW)
import path from 'node:path';
import type { AppConfig } from './index.js';

/**
 * Resolve the project data directory from config. Sibling of memory.dbPath.
 * Falls back to './data' when no dbPath is set (test fixtures).
 *
 * Source of truth — DO NOT inline `path.dirname(memory.dbPath)` in command
 * files. v1.14.0 R2: extracted from src/commands/{organize,memory}.ts and
 * the new src/webapp/itemsRoute.ts to avoid drift.
 */
export function resolveDataDir(config: AppConfig): string {
  return path.resolve(config.memory?.dbPath ? path.dirname(config.memory.dbPath) : 'data');
}
```

Migrated call sites:
1. `src/commands/organize.ts:62` — replace `dataDirFromConfig(deps.config)` with `resolveDataDir(deps.config)`.
2. `src/commands/memory.ts:41` — same.
3. `src/webapp/itemsRoute.ts` — new code uses `resolveDataDir(deps.config)`.

Tests: existing tests for organize + memory commands still pass unchanged (the helper renames are internal). Phase 2 verifies.

### R3 (FAIL-adjacent — supersedes §17 API spec) — Error envelope parity with v1.13.0 (Anti-Slop R3)

**Concern.** v1.13.0 echo returns `{ok: false, reason: 'malformed' | ...}`; ADR 009 §17 returns `{error: 'NOT_FOUND'}`. Two field names (`reason` vs `error`), missing `ok` flag, different shape. Future v1.14.1 mutations would multiply the inconsistency.

**Decision.** Unified error envelope across ALL `/api/webapp/*` endpoints:

```typescript
type ApiErrorResponse = {
  ok: false;
  code: string;           // SCREAMING_SNAKE machine identifier
  error: string;          // Human-readable message
  reason?: string;        // Auth-failure subreason (only on auth errors, matches v1.13.0)
};

type ApiSuccessResponse<T> = {
  ok: true;
  // ...payload-specific fields, NOT wrapped under `data` (matches v1.13.0 echo flat shape)
};
```

Concrete shapes for v1.14.0:

```typescript
// /api/webapp/items 200
{ ok: true, items: ListItem[], total: number, serverTime: ISOString }

// /api/webapp/items 401 (auth failure)
{ ok: false, code: 'AUTH_FAILED', error: 'Authentication failed', reason: 'malformed' | 'bad-hash' | 'stale' | 'no-user' | 'no-auth-header' }

// /api/webapp/items 400 (malformed query)
{ ok: false, code: 'BAD_REQUEST', error: 'Invalid filter value: type=...' }

// /api/webapp/items/:id 200
{ ok: true, item: { ...frontMatter, notes: string, progress: string, fileBasename: string } }

// /api/webapp/items/:id 400 (malformed id)
{ ok: false, code: 'BAD_REQUEST', error: 'Invalid item id format' }

// /api/webapp/items/:id 404
{ ok: false, code: 'NOT_FOUND', error: 'Item not found' }

// /api/webapp/items/:id 401 — same as items 401
```

v1.13.0 echo response also gains the `ok: true` flag for symmetry — minor breaking change to the echo client (the test file updates), but the v1.13.0 skeleton page hasn't shipped a real client that depends on the shape (it's the test ping). Documented.

### R4 (HIGH, BLOCKING-adjacent — supersedes decision 5) — Tighten replay window to 1h for items routes (DA-C1)

**Concern.** Architect's "screen recording shows the task list anyway" defense covers ONE channel. Other realistic disclosure paths leak initData WITHOUT corresponding task content: terminal scrollback, error-platform logs (Sentry), browser tab-restore lists, CI artifacts uploading the URL with auth, and crash dumps. Each is a separate exposure. 24h window is too generous for the more sensitive items endpoint (real PII — task titles).

**Decision.** Per-route replay window override:

1. Add `config.webapp.itemsInitDataMaxAgeSeconds` to schema, default `3600` (1h), range `[60, 86400]`. Echo endpoint keeps the existing global `initDataMaxAgeSeconds` (default 86400 / 24h).
2. The items route handlers call `verifyTelegramInitData(initData, botToken, {maxAgeSeconds: config.webapp.itemsInitDataMaxAgeSeconds, maxFutureSkewSeconds: config.webapp.initDataMaxFutureSkewSeconds})`.
3. Update README docs to mention the per-route tightening.

**Defense rationale.** v1.14.x's mutation endpoints will inherit the same 1h default (state-changing endpoints deserve at least the read endpoints' tightening). Operators who DO want longer windows can override per-deployment via config.

**Tests:** `tests/integration/webapp.organize.test.ts` includes a case where echo passes (24h window) but items rejects (1h window) for the same initData with `auth_date` 2h ago.

### R5 (MEDIUM — supersedes decision 15) — Convert webAppData test to negative assertion, don't delete (DA-C3)

**Concern.** ADR §17 said the v1.13.0 hub-conversion deletes `tests/unit/gateway.webAppData.test.ts` (which exists at lines 1–248 and asserts the ping handler). DA correctly observed this throws away a precedent v1.14.1+ will need (sendData for "complete from webapp" mutation flow). Pure information loss.

**Decision.** Don't delete. Convert to a negative assertion that documents the intentional-pong-removal:

```typescript
// tests/unit/gateway.webAppData.test.ts (post-v1.14.0)
describe('web_app_data handler', () => {
  it('v1.14.0+: ping handler removed; receiving sendData no longer auto-replies', async () => {
    // v1.13.0 had a pong handler that replied "🏓 pong" to any sendData payload.
    // v1.14.0 hub conversion removed it; v1.14.1+ adds typed sendData routing
    // (e.g. {kind: 'complete-item', id} → organize_complete tool).
    //
    // This negative assertion preserves the precedent that gateway DOES still
    // listen for web_app_data messages — the bot.on() registration must remain
    // even though the handler body is intentionally minimal in v1.14.0.

    const handlers = collectGatewayHandlers();  // helper that introspects bot.on() registrations
    expect(handlers.has('message:web_app_data')).toBe(true);
    // Body intentionally a no-op in v1.14.0; v1.14.1+ replaces the no-op with
    // typed routing.
  });
});
```

Phase 2 dev preserves the file; converts the existing assertions to the negative shape; adds a TODO comment pointing at v1.14.1.

### R6 (MEDIUM — supersedes decision 8) — ETag/304 deferred to v1.14.1 with measurement gate (DA-C5)

**Concern.** Architect closed off all caching options. ETag/304 is structurally different — zero state, zero staleness, ~10 LOC, and addresses the chip-tap-latency story without the cross-module-invalidation coupling cache-with-TTL would need.

**Decision.** v1.14.0 ships no ETag (matches architect decision 8). But: v1.14.1's iteration brief includes a measurement gate — if `/api/webapp/items` shows P95 latency >100ms in real use, ETag lands then. Filed in TODO.md alongside the v1.14.1 mutations work so they ship together if needed.

This is a documentation-only change to ADR 009 — the decision stays "no cache for v1.14.0" but with an explicit re-open clause.

### R7 (MEDIUM — supersedes decision 10) — `BackButton.onClick` handler stability + `offClick` (DA-C7)

**Concern.** Telegram WebApp SDK's `BackButton.onClick(handler)` is ADDITIVE — calling it twice registers two handlers. If the page re-enters the detail view (e.g. tap → back → tap), the BackButton ends up firing both pop-to-list AND pop-to-list-again, closing the webview prematurely.

**Decision.** Stable handler reference + `offClick(prev)` before each `onClick(next)`:

```javascript
// public/webapp/organize/app.js
let _backButtonHandler = null;

function setBackButtonAction(action) {
  if (!Telegram?.WebApp?.BackButton) return;
  if (_backButtonHandler) {
    Telegram.WebApp.BackButton.offClick(_backButtonHandler);
  }
  _backButtonHandler = action;
  if (action) {
    Telegram.WebApp.BackButton.onClick(action);
    Telegram.WebApp.BackButton.show();
  } else {
    Telegram.WebApp.BackButton.hide();
  }
}

// Usage:
function enterDetail(itemId) {
  // ...render detail
  setBackButtonAction(() => returnToList());
}

function returnToList() {
  // ...render list
  setBackButtonAction(null);  // hide BackButton on list view; close-webview is the default
}
```

Add to ADR 009 §17. Phase 2 dev implements this exact shape.

### R8 (MEDIUM — adds a new risk + route-level allowlist) — Allowlist check inside items route handlers (DA new risk R-MISSING-A)

**Concern.** v1.13.0 R12.3 carry-forward: a forwarded WebApp button could be tapped by a non-allowlisted user. v1.13.0 echo doesn't care (just echoes their userId back). v1.14.0 items endpoint would AUTHENTICATE them and serve their (empty) item list. Empty == not a leak, but if v1.14.1+ has any bot-shared content, it leaks. Better to enforce now.

**Decision.** Add allowlist guard inside `/api/webapp/items*` handlers (alongside the verified userId check):

```typescript
// inside mountItemsRoutes
function isAllowedUser(userId: number, config: AppConfig): boolean {
  return config.telegram.allowedUserIds.includes(userId);
}

// in the handler, after verifyTelegramInitData succeeds:
if (!isAllowedUser(verifiedUserId, deps.config)) {
  return res.status(403).json({
    ok: false,
    code: 'NOT_ALLOWED',
    error: 'User not in allowlist',
  });
}
```

**Justification.** Defense-in-depth. Same posture as the bot's group-allowlist gate. Future-proofs v1.14.1+ which WILL serve mutations.

Tests: `tests/integration/webapp.organize.test.ts` includes a case where verified userId is not in `allowedUserIds` → 403.

### R9 (MEDIUM — supersedes Item 6) — Test list expanded to 18+ cases (Anti-Slop W12 + DA test-design notes)

**Concern.** ADR §17 sketched 7 test cases. SF-5 lesson from v1.13.1 demands more breadth. Anti-Slop W12 explicitly asked for the full enumeration.

**Decision.** Phase 2's `tests/integration/webapp.organize.test.ts` covers (minimum):

1. Static reachability — `GET /webapp/organize/index.html` 200 + content-type + body markers.
2. Static reachability — `GET /webapp/organize/app.js` 200 + javascript content-type.
3. Static reachability — `GET /webapp/organize/styles.css` 200 + css content-type.
4. CSP correctness — index.html response header includes `frame-ancestors https://web.telegram.org`, NOT `'none'`.
5. CSP correctness — index.html response includes `script-src 'self' https://telegram.org`.
6. API auth — `/api/webapp/items` no header → 401 + `{ok:false, code:'AUTH_FAILED', reason:'no-auth-header'}`.
7. API auth — wrong-prefix Authorization → 401 + reason 'no-auth-header'.
8. API auth — stale initData (>1h, the new tighter window per R4) → 401 + reason 'stale'.
9. API auth — same stale initData against echo → 200 (echo's 24h window).
10. API allowlist — verified userId NOT in `config.telegram.allowedUserIds` → 403 + `{ok:false, code:'NOT_ALLOWED'}`.
11. Filter — `?type=task` returns only tasks; ?type=event returns only events.
12. Filter — `?status=done` returns only done items; default omits done.
13. Filter — `?tag=foo` returns only items with `foo` tag.
14. Filter — invalid query value (`?type=banana`) → 400 + `{ok:false, code:'BAD_REQUEST'}`.
15. Per-user scoping — userA's initData returns userA items; userB's initData returns empty.
16. Items detail — valid id → 200 + full shape including `notes`, `progress`, `fileBasename`.
17. Items detail — id format invalid (`../../etc/passwd`) → 400 + `{ok:false, code:'BAD_REQUEST'}`. Path-traversal NOT 404.
18. Items detail — id format valid but item missing → 404 + `{ok:false, code:'NOT_FOUND'}`.
19. Items detail — embedded null byte in id → 400 (defense before filesystem call).
20. Items detail — oversized id (>50 chars) → 400.
21. Response shape — list response has `ok: true, items: [], total: number, serverTime: ISO`.
22. Response shape — detail response has `ok: true, item: {...}`.

Phase 2 may add more; this is the floor.

### R10 (MEDIUM — supersedes decision 14) — Filter chip state in sessionStorage (DA-C-filter-reset)

**Concern.** Architect decided "reset on each load" for simplicity. But user opens webapp → filters to "Goals only" → taps an item → taps back → filter is reset to default. Annoying for actual use.

**Decision.** Use `sessionStorage` to persist filter chip state across navigations within the SAME webview session. Cleared when the webview closes. ~10 LOC:

```javascript
const FILTER_KEY = 'organize-filter-state-v1';

function loadFilters() {
  try {
    const raw = sessionStorage.getItem(FILTER_KEY);
    if (!raw) return DEFAULT_FILTERS;
    return JSON.parse(raw);
  } catch { return DEFAULT_FILTERS; }
}

function saveFilters(filters) {
  try { sessionStorage.setItem(FILTER_KEY, JSON.stringify(filters)); } catch { /* ignore */ }
}

const DEFAULT_FILTERS = { type: 'all', status: 'active', tag: null };
```

**Tradeoff.** sessionStorage is webview-scoped. Closing and reopening the webapp resets to defaults. That's the right scope — within-session persistence, no cross-session memory.

### R11 (LOW — fixes JSDoc + W4) — `storage.ts` JSDoc correction (Anti-Slop W4 + DA-C2)

**Concern.** Both reviewers flagged the same lie at `src/organize/storage.ts:459`: "Parses front-matter only for efficiency" — actually `parseItemFile` calls `extractBodySections` unconditionally. Real cost is full-body parse per file.

**Decision.** Phase 2 corrects the JSDoc as part of the v1.14.0 commit (one-line fix). Body of `listItems` itself stays unchanged (architect decision 4 punts the optimization). Adding the truthful documentation prevents future readers from believing a non-existent fast path.

### R12 (LOW + documentation polish — sweeps remaining DA + Anti-Slop nits)

Grouped:

- **R12.1 — `ItemDetailResponse` envelope** (Anti-Slop W7) — resolved by R3's unified envelope. Both success and error wrap with `{ok: ...}`.
- **R12.2 — Empty-state copy** (architect decision 11): non-clickable text. Phase 2 adds an explicit comment near the empty-state element noting why it must NOT be a link (would close the webview prematurely).
- **R12.3 — Hub orphaned ping handler** is removed in the same commit as the hub conversion + the test conversion per R5. Atomic.
- **R12.4 — `themeChanged` subscription** (DA new risk R-MISSING-B). Telegram WebApp SDK fires `themeChanged` events. Hub + organize page both subscribe via `Telegram.WebApp.onEvent('themeChanged', applyTheme)`. ~5 LOC each.
- **R12.5 — `config/config.example.json`** sweep: include the new `itemsInitDataMaxAgeSeconds` field per R4. Recurring oversight per ADR 008 R12.5.
- **R12.6 — README v1.14.0 subsection** lists the new endpoints + filter chips + tap-to-detail flow, plus a note about the 1h replay window for items routes.

---

## New risks added to §13 risk register

DA + Anti-Slop new risks mapped:

| Risk | Severity | Mitigation |
|---|---|---|
| 24h replay window leaks task titles | HIGH → resolved | R4 (1h items-route window) |
| Forwarded button → non-allowlisted user authenticates | MEDIUM → resolved | R8 (allowlist check in route handlers) |
| BackButton handler accumulation | MEDIUM → resolved | R7 (offClick before onClick) |
| Server.ts crosses 500 LOC at v1.14.0 ship | FAIL-adjacent → resolved | R1 (route split now) |
| Error envelope shape drift across endpoints | FAIL-adjacent → resolved | R3 (unified `{ok, code, error}` shape) |
| `dataDirFromConfig` triple-duplication | FAIL-adjacent → resolved | R2 (extract + migrate all 3) |
| Filter reset on every navigation | MEDIUM → resolved | R10 (sessionStorage) |
| webAppData test loss kills v1.14.1+ precedent | MEDIUM → resolved | R5 (negative assertion, don't delete) |
| storage.ts JSDoc lies | LOW → resolved | R11 (correct it) |
| Filter-chip-tap latency >100ms at scale | LOW → conditionally deferred | R6 (ETag in v1.14.1 if measurement gate fires) |
| themeChanged not handled | LOW → resolved | R12.4 (subscribe on both pages) |

---

## Implementation order for Phase 2

Suggested:

1. **Schema + helper extraction first**: `src/config/dataDir.ts` (NEW per R2), `src/webapp/itemsRoute.ts` (NEW per R1), config schema additions (R4: `itemsInitDataMaxAgeSeconds`). Migrate `src/commands/{organize,memory}.ts` to use `resolveDataDir`.
2. **API routes**: implement `mountItemsRoutes` + auth + allowlist guard + unified error envelope per R3 + R8.
3. **Storage JSDoc fix** (R11) — drive-by while Dev-A is in storage.ts.
4. **Static page**: `public/webapp/organize/{index.html, app.js, styles.css}` per architect decision 12 + R7 BackButton + R10 sessionStorage + R12.4 themeChanged.
5. **Hub conversion**: `public/webapp/index.html` + `public/webapp/app.js` — remove ping, add Organize button. Convert (don't delete) `tests/unit/gateway.webAppData.test.ts` per R5.
6. **Tests**: 22+ integration tests per R9 + unit tests for helpers.
7. **Docs**: README v1.14.0 subsection per R12.6; config.example.json per R12.5.

Phase-2 Anti-Slop + Scalability + QA reviewers run after the full set lands.

---

## Phase-2 readiness verdict

**READY.** All 1 BLOCKING-adjacent (R4) + 3 FAIL-adjacent (R1, R2, R3) + 7 MEDIUM concerns resolved with concrete ADR text. Two LOW items (R11, R12) are documentation-only. No carry-forward open questions block Phase 2.

Phase 2 may start. Anti-Slop Phase 2 + Scalability + QA reviewers run after Phase 2 implementation lands. CP1 reviewers do not re-fire.
