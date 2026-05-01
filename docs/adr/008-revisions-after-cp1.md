# ADR 008 — Revisions after CP1 debate (2026-04-24)

**Parent:** `008-v1.13.0-webapp-foundation.md`
**Status:** Accepted. Folded into ADR 008 by reference. Developer agents implement the revised spec; deviations require another addendum.
**Context.** Devil's Advocate review (`docs/reviews/cp1-devils-advocate-v1.13.0.md`) raised 1 BLOCKING + 2 HIGH + 11 MEDIUM + 1 LOW + 12 new risks. Anti-Slop Phase 1 (`docs/reviews/anti-slop-phase1-review-v1.13.0.md`) raised 3 FAIL-adjacent + 17 warnings. Both reviewers flagged the package-layout decision (DA: "move to `src/webapp/auth.ts`"; Anti-Slop: "defend the categorization axis better"). Convergence: move + clarify. This file resolves all blockers.

---

## Resolved (R1 through R12)

### R1 (BLOCKING — supersedes decision 2) — Move auth helper to `src/webapp/auth.ts` (DA-C1)

**Concern.** `src/safety/` holds INTERNAL safety primitives (path sandbox, scrubber, blocklist, email-confirmation tokens) that gate the agent's own behavior. Telegram WebApp HMAC verification is an EXTERNAL auth-protocol implementation — different category. The architect's "single-file module" objection collapses once v1.14.0+ adds route handlers, session helpers, per-feature endpoints (all of which logically live under `src/webapp/`).

**Decision.** Create `src/webapp/auth.ts` (NEW). Imports allowed: `node:crypto`, `node:url` (or `URLSearchParams` global), pino logger via `child({component: 'webapp.auth'})`. NO imports from `src/gateway/`, `src/safety/`, `src/messaging/`, or any domain types.

Future v1.14.0+ files anticipated under `src/webapp/`: `server.ts` (Express factory), `routes/echo.ts`, `routes/items.ts`, `middleware/initData.ts`, `middleware/rateLimit.ts`. The directory is the right home.

`src/safety/` continues to host INTERNAL primitives. The categorization axis the Anti-Slop reviewer asked us to make explicit: **"who is the protocol's other party?"** Internal-to-Jarvis = `src/safety/`. External (Telegram, future Slack/WhatsApp WebApp protocols, OAuth client-side) = `src/webapp/` or another suitable module. This rule is documented in the file's top docstring.

**Test path mirror:** `tests/unit/webapp.auth.test.ts` (already specified in Item 8 — no change).

### R2 (FAIL-adjacent — supersedes decision 8) — `webappServer` lifecycle inside `initGateway` (Anti-Slop R1)

**Concern.** ADR 008 placed the new Express server's start/stop in `src/index.ts` boot step 10d. But the existing `createHealthServer` is constructed inside `initGateway` at `src/gateway/index.ts:305` and started/stopped at `:1442/:1462`. Two different code paths for two near-identical Express servers is asymmetric and surprising.

**Decision.** Mirror the health-server pattern exactly:

1. **Construct** in `initGateway`: alongside `const healthServer = createHealthServer(config, version);` add `const webappServer = createWebappServer({config, version, logger});`. Both are local consts, not exposed on `GatewayApi`.
2. **Start**: in `gatewayApi.start()` after `await healthServer.start();` add `if (config.webapp.publicUrl) await webappServer.start();`. The boolean check skips startup when no `publicUrl` is configured (operators not using the Web App pay zero overhead).
3. **Stop**: in `gatewayApi.stop()` mirror — `await webappServer.stop().catch(() => {});` AFTER `await healthServer.stop();` so health is the LAST thing to go down (operational convention: keep health observable as long as possible).

`src/index.ts` has NO new boot step — Item 6's config decision drives whether the server is alive, transparent to the boot orchestrator. Cleaner.

### R3 (FAIL-adjacent — supersedes decision 1 details) — `WEBAPP_BIND_ADDR` named constant (Anti-Slop R2)

**Concern.** `127.0.0.1` is prose in the ADR; risk register row 14 marks `0.0.0.0` misconfiguration as MEDIUM. Without a named constant, a future contributor "fixes" the loopback bind to make it work in a Docker container without realizing they're bypassing the security invariant.

**Decision.** In `src/webapp/server.ts` (NEW file, factored out by the same Architect choice from decision 1):

```typescript
/**
 * Loopback-only bind address for the Web App Express server.
 *
 * MUST stay 127.0.0.1. cloudflared (or any future production HTTPS terminator
 * such as nginx + Let's Encrypt) connects to this loopback address; the
 * outside world only ever sees the tunnel/proxy endpoint, which is the
 * place where TLS terminates and rate limiting / WAF rules apply.
 *
 * Binding 0.0.0.0 here would expose the unauthenticated /webapp/* static
 * routes (and any future /api/webapp/* routes) directly to the host's LAN
 * AND any container/VM network interface, bypassing the tunnel's CSP, rate
 * limit, and audit chokepoints.
 *
 * This invariant is part of v1.13.0's security posture; do NOT relax without
 * a corresponding ADR amendment that explicitly redesigns the threat model.
 */
const WEBAPP_BIND_ADDR = '127.0.0.1';
```

Same pattern in `src/gateway/health.ts` for symmetry — extract `127.0.0.1` from the inline string at line 38 to a named constant in that file. Matches existing precedent in security-sensitive code (e.g. `src/safety/scrubber.ts`'s named regex constants).

### R4 (HIGH — supersedes decision 1 + adds risk register row) — Production hosting `127.0.0.1` invariant + tunnel-only consequence (DA-C2)

**Concern.** cloudflared free tier targets ONE local port. Architect's separate-app choice means `/health` (port 7878) is NOT reachable via the production HTTPS path; only `/webapp/*` and `/api/webapp/*` (port 7879) are. That's a feature for v1.13.0 (privacy: `version` info from `/health` doesn't leak via the tunnel). It becomes a footgun in v1.14.0+ when an operator adds a real domain and forgets that production HTTPS only exposes the webapp surface.

**Decision.** Add to ADR 008's §13 risk register a new row R12 (use the next available number after the existing risk-register entries):

| Risk | Severity | Mitigation |
|---|---|---|
| Production HTTPS exposes only webapp port; `/health` invisible to ops outside the host | LOW (intentional in v1.13.0) → MEDIUM in v1.14.0+ if operators expect health on the tunnel | Document the loopback-only invariant prominently in README. v1.14.0+ MAY add a separate `/api/health` route on the webapp Express server (loopback bind unchanged; tunnel exposes it). Out of scope for v1.13.0. |

Also: extend Decision 1's "Operator threat-model invariant" subsection (or add one) committing to `WEBAPP_BIND_ADDR = '127.0.0.1'` across v1.14.0+ production hosting, per R3 above. Real-domain migration NEVER changes the bind address — it only changes what's in front of the loopback (cloudflared vs nginx vs caddy).

### R5 (HIGH — supersedes decision 5) — Drop `?initData=` query-string fallback; strict `Authorization: tma <initData>` only (DA-C3)

**Concern.** Telegram-Mini-App spec recommends header-based auth. v1.13.0's permissive `?initData=...` fallback creates a 24-hour phishing surface: an accidentally-disclosed initData via browser history, terminal scrollback, screen recording, DNS query logs, or referer headers becomes a one-shot account-impersonation cookie. With ZERO consumers today (no v1.14.0 yet), shipping permissive is purely additive risk for no immediate compatibility win.

**Decision.** v1.13.0 supports ONLY the `Authorization: tma <initData>` header. The query-string fallback is removed.

- Skeleton page in `public/webapp/index.html` constructs the header explicitly: `fetch('/api/webapp/echo', {headers: {Authorization: \`tma ${Telegram.WebApp.initData}\`}})`.
- Server-side: missing or non-`tma`-prefix Authorization → 401 with `reason: 'no-auth-header'` (a new reject reason added to the union).
- Future v1.14.0+ MAY add the query-string path back with documented rationale (e.g. SSE / EventSource APIs that don't support custom headers); migration is additive, doesn't break the locked-down v1.13.0 surface.

Update Item 8's test list: add `tests/integration/webapp.echo.test.ts` cases for missing Authorization header (401), wrong-prefix (`Authorization: bearer ...` → 401), valid-but-expired (stale auth_date → 401 reason 'stale').

### R6 (MEDIUM — supersedes decision 10) — Debounce audit-row emission on auth_failure (DA-C7 + DA-C10)

**Concern.** Decision 10 chose to audit-log only `ok:false` outcomes. Without debounce, a hostile burst (1000 req/sec with malformed initData) writes 1000 audit rows per second. The pino warn-log already debounces (per the rate-limiter's design), but the audit-log path doesn't.

**Decision.** Audit-row emission for `webapp.auth_failure` is debounced per-IP at 1 row per 60 seconds:

- A `Map<ipAddress, lastAuditAt: number>` tracks the last audit-row timestamp per IP.
- On rejection, check `lastAuditAt[ip]`; if absent or `>60s ago`, insert the row and update the map.
- The map is bounded — after 1000 distinct IPs in a sliding window, oldest entries are evicted (LRU). 1000 entries × ~80 bytes ≈ 80KB max memory. Fixed-size; no leak.
- Map lives in `src/webapp/server.ts` module-scope (same lifecycle as the Express server itself). Cleared on `webappServer.stop()`.

Detail shape for the audit row:
```typescript
{
  ip: string,                      // partial-hash or first-3-octets to avoid full PII storage; see R6.1
  reason: 'malformed' | 'bad-hash' | 'stale' | 'no-user' | 'no-auth-header',
  pathHit: '/api/webapp/echo',     // future endpoints expand this
  userAgentHash: string,           // sha1 first 8 chars; correlates without storing UA
  suppressedSince: string,         // ISO; the start of the current debounce window
  suppressedCount: number,         // increments each suppressed event in the window
}
```

R6.1 — IP storage: full IP is unnecessary for forensics at this scale. Store first-3-octets (`192.168.1.x`) which still identifies subnet/region while reducing PII surface. Operators wanting full-IP forensics can flip to a config knob in v1.13.x. Default is partial.

### R7 (MEDIUM — supersedes decision 4) — Future auth_date skew default 300s, configurable (DA-C8)

**Concern.** Architect picked 60s for "auth_date in future" sanity check (per the rigor-ask). 60s is too tight on corporate networks with NTP issues, container clocks that drift, mobile devices switching between WiFi and cellular. OAuth/JWT industry standard is 300s (5 min).

**Decision.** Default `maxFutureSkewSeconds` is **300** (5 min). Add to config:

```typescript
webapp: z.object({
  // ...existing fields
  initDataMaxAgeSeconds: z.number().int().min(60).max(86400 * 7).default(86400),
  /** Reject initData when its auth_date is more than this far in the future,
   *  defending against forged-timestamp replay. Default 300s matches OAuth/JWT;
   *  tighten only on hosts with reliable NTP. Wider tolerates clock skew. */
  initDataMaxFutureSkewSeconds: z.number().int().min(0).max(3600).default(300),
}).default({}),
```

Setting this to `0` disables the check entirely (for niche hosts where clock skew is unbounded). Default 300 is the right balance.

### R8 (MEDIUM — supersedes decision 2 + adds to test plan) — HMAC implementation hardening (DA-C5, DA-C6, DA's deeper HMAC notes)

**Concern.** Architect's HMAC algorithm is correct per spec, but several real-world bugs lurk in the implementation details:
1. URL-decoding of values BEFORE building the data-check-string (Telegram spec is ambiguous; reference implementations decode before sign).
2. `crypto.timingSafeEqual` throws on length mismatch — the throw vs no-throw is observably timing-different. Mitigated by the per-IP rate limit (60/min/IP), but should be NAMED.
3. Hash field is `params.get('hash')` — case-sensitive. Reject duplicate `?hash=BAD&hash=GOOD` (URLSearchParams returns the first; an attacker may try to confuse). Reject case-variant `?Hash=...` lookalikes.
4. Test harness should include at least ONE externally-sourced HMAC vector (from grammY or python-telegram-bot's test suite) to prove our implementation matches reference.

**Decision.** Add to `src/webapp/auth.ts` documentation (top of file):

```typescript
/**
 * Verifies Telegram Mini App initData per the spec at
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Implementation notes:
 *
 * 1. URL decoding: We URL-decode each value AFTER extracting it from
 *    URLSearchParams (which decodes once already). This matches grammY's
 *    reference impl (https://github.com/grammyjs/grammY/...). The
 *    data-check-string components are decoded once total — Telegram's spec
 *    examples confirm.
 *
 * 2. Hash extraction: We use exact case-sensitive `'hash'` (lowercase). Other
 *    case variants (e.g. 'Hash', 'HASH') are NOT recognized and the missing-
 *    hash path returns reason 'malformed'. This defends against attackers
 *    submitting BOTH a real lowercase hash AND a lookalike that an
 *    accidentally-permissive parser might accept.
 *
 * 3. Duplicate-hash defense: URLSearchParams.get() returns the FIRST value of
 *    a duplicated key. We additionally reject when params.getAll('hash')
 *    returns more than one value, with reason 'malformed'. Defends against
 *    attackers crafting initData with both a forged hash AND a valid hash
 *    hoping a permissive verifier picks the wrong one.
 *
 * 4. timingSafeEqual: requires equal-length buffers. We pre-validate both
 *    are 64 hex chars (=32 bytes) BEFORE calling timingSafeEqual. The
 *    pre-check is observably timed (length is public anyway), so its timing
 *    leaks nothing. If lengths differ, return 'bad-hash' immediately.
 *
 * 5. Future-skew: per R7, reject when auth_date is > maxFutureSkewSeconds
 *    in the future (default 300s). Stale check (older than maxAgeSeconds)
 *    happens after the future-skew check; both run AFTER the HMAC check,
 *    so a malformed-hash request never gets a clock-related error message
 *    (which could leak server-side time).
 */
```

Add to `tests/unit/webapp.auth.test.ts`:
- One vector copied verbatim from grammY's test suite (with attribution comment).
- Duplicate-hash injection rejected.
- Case-variant hash field rejected (`'Hash=foo&user=...'`).
- Length-mismatched hash rejected with 'bad-hash' (not `crypto.timingSafeEqual` throw).
- Future auth_date >300s rejected; <300s but >0s in future accepted.
- Past auth_date but within maxAge accepted.

### R9 (MEDIUM — supersedes Item 8 test list) — Integration tests assert audit row shape (Anti-Slop W5)

**Concern.** Anti-Slop W5 noted that the integration tests verify HTTP response codes but not the audit-log row shape on auth_failure. Audit emission is the FORENSIC layer; if its shape silently regresses, ops loses visibility.

**Decision.** Extend `tests/integration/webapp.echo.test.ts`:
- Hit echo with malformed initData → 401 + assert exactly ONE audit row inserted with `category: 'webapp.auth_failure'`, `detail.reason: 'malformed'`, partial IP shape.
- Hit echo with stale initData → 401 + audit row with `detail.reason: 'stale'`.
- Hit echo with valid initData → 200 + assert NO audit row inserted (success path doesn't audit per decision 10).
- Burst of 5 malformed requests within 1s → exactly ONE audit row (debounce per R6) with `detail.suppressedCount: 4`.

### R10 (MEDIUM — supersedes Item 6 + path resolution) — `staticDir` resolved relative to project root (Anti-Slop W8)

**Concern.** `staticDir` default `'public/webapp'` is a relative path. pm2 sets the working directory to wherever `pm2 start` was run from — could be anywhere. If a future operator runs `pm2 start dist/index.js` from `/home/Boss/` instead of the project root, `public/webapp/` won't exist there.

**Decision.** Resolve `staticDir` relative to the **project root** (the directory containing `package.json`), not `process.cwd()`. Implementation:

```typescript
// src/webapp/server.ts
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Project root — two parents up from this file (src/webapp/server.js → src/ → root)
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function resolveStaticDir(configValue: string): string {
  if (path.isAbsolute(configValue)) return configValue;
  return path.resolve(PROJECT_ROOT, configValue);
}
```

`resolveStaticDir(config.webapp.staticDir)` is called at server-construction time. Operators can override with an absolute path if hosting the static assets elsewhere (e.g. CDN-mirrored copy). Document in the schema doc-comment.

Same pattern works after `tsc` build (the relative `'..', '..'` from `dist/webapp/server.js` resolves to `dist/`'s parent = project root).

### R11 (MEDIUM — supersedes architect's "ready for Phase 2" verdict) — Explicit Phase-2 readiness verdict (Anti-Slop W12)

**Concern.** ADR 007 had a §29 "READY with flags" verdict. ADR 008 lacks an equivalent explicit gate.

**Decision.** Add §18 "Ready-for-Phase-2 verdict" to ADR 008 (or this revisions doc serves as the verdict):

> **READY.** Twenty-two decisions across the eight items, plus this revisions addendum (R1–R12) addressing the BLOCKING + 2 HIGH + 3 FAIL-adjacent + 7 MEDIUM concerns from CP1. Three deferred items remain explicitly out of scope (target / hosting / scope cut, per the user's deferral). Developer agents implement against ADR 008 + this revisions file. Deviations require another addendum.
>
> Phase 2 may start. Anti-Slop Phase 2 + Scalability + QA reviewers run after Phase 2 implementation lands; CP1 reviewers do not re-fire.

### R12 (LOW + documentation polish — sweeps remaining MEDIUM items)

Grouped:

1. **R12.1 — Handler registration test (DA-C12 elaborated):** add `tests/unit/gateway.webAppData.test.ts` asserting `bot.on('message:web_app_data', ...)` is registered when the Web App is enabled. v1.13.0's handler logs the ping payload at info level and replies with a confirmation toast (`web_app_data` handlers in grammY can `ctx.reply()`). Detect "missing handler" in tests so a Phase-2 dev's omission doesn't ship as a silent regression.

2. **R12.2 — Port-conflict UX (DA-C7 elaborated):** if the webapp Express server's `app.listen()` errors with `EADDRINUSE`, do NOT crash the process (matches health-server precedent which DOES crash, but webapp is non-essential — different posture). Log error at warn level; mark the webapp as disabled-for-this-process; the bot continues running. The `/webapp` slash command then replies with "Web App server failed to start (port conflict); see logs."

3. **R12.3 — Forwarded-button-from-other-chat allowlist (DA new risk R_DA8_10):** v1.13.0 doesn't have multi-chat panels, but the Web App button could theoretically be forwarded between chats. The skeleton page does NOT enforce chat ownership at the API layer (echo just returns whatever the initData says). v1.14.0+ MUST add a chat-ownership check; flag in `TODO.md`.

4. **R12.4 — `CLAUDE.md` / `KNOWN_ISSUES.md` factory-level update plan (Anti-Slop W15):** filed as an open factory issue rather than blocking v1.13.0. The Phase 5 Docs agent updates `docs/KNOWN_ISSUES.md` with the v1.13.0 Web App addition, the cloudflared dev-tunnel posture, and the production-hosting deferral. CLAUDE.md doesn't change.

5. **R12.5 — `config/config.example.json` sweep:** the recurring oversight (per Anti-Slop W14 in v1.10.0 / v1.11.0). Phase 2 Dev-A adds the new `webapp` stanza to `config/config.example.json` alongside the schema change.

6. **R12.6 — CSP escape clauses:** Decision 7 specifies strict CSP with no `'unsafe-inline'`. Document in the file's HTML comment that future inline scripts go through CSP-nonce mechanism (Express middleware generates a nonce per response; `<script nonce="...">` allowed). v1.13.0 uses a sibling `app.js` referenced via `<script src="./app.js">` — no nonce needed yet.

---

## New risks added to §13 risk register

DA-R_DA8_1 through R_DA8_12 mapped to resolutions:

| Risk | Severity | Mitigation |
|---|---|---|
| Layering precedent (auth in `src/safety/`) misleads future contributors | HIGH → resolved | R1 (move + categorization-axis docstring) |
| Production HTTPS exposes only webapp port; /health invisible | LOW (v1.13.0) / MEDIUM (v1.14.0+) | R4 (documented; deferred) |
| 24h phishing window via query-string fallback | HIGH → resolved | R5 (header-only) |
| Audit-row firehose under attack | MEDIUM → resolved | R6 (per-IP debounce + LRU cap) |
| Future-skew default too tight on corp networks | MEDIUM → resolved | R7 (300s default) |
| URL-decode-before-sign ambiguity | MEDIUM → resolved | R8 (documented + grammY-vector test) |
| Hash-field case/duplicate attacks | MEDIUM → resolved | R8 (explicit reject paths + tests) |
| timingSafeEqual length-mismatch throw observability | LOW → mitigated by R8 (pre-check + rate limit) | R8 |
| `staticDir` cwd-dependent resolution | MEDIUM → resolved | R10 (project-root resolution) |
| Handler registration silent omission | MEDIUM → resolved | R12.1 (test) |
| Port-conflict crash | LOW → resolved | R12.2 (warn + disable, no crash) |
| Forwarded-button cross-chat exfiltration | LOW (v1.13.0) / MEDIUM (v1.14.0+) | R12.3 (filed in TODO; mandated for v1.14.0+) |

---

## Implementation order for Phase 2

Suggested:

1. `src/webapp/auth.ts` (new file) — verify function + tests.
2. `src/webapp/server.ts` (new file) — Express factory with strict CSP, rate limit, audit debounce, partial-IP storage, project-root staticDir resolution, port-conflict handling.
3. `src/messaging/auditLog.ts` — add `'webapp.auth_failure'` to AuditCategory union.
4. `src/config/schema.ts` — webapp stanza per Item 6 + R7's new field.
5. `config/config.example.json` — webapp stanza.
6. `src/messaging/{adapter,telegram}.ts` — `sendWebAppButton` per Item 4.
7. `public/webapp/index.html` + `public/webapp/app.js` (sibling per strict-CSP decision) — skeleton page.
8. `src/commands/webapp.ts` — slash command per Item 5.
9. `src/gateway/index.ts` — wire webappServer into `initGateway`; register `bot.on('message:web_app_data', ...)`; route `/webapp` command.
10. Tests per Items 8 + R8 + R9 + R12.1.
11. README cloudflared section per Item 7.

Phase-2 Anti-Slop + Scalability + QA reviewers run after the full set lands.
