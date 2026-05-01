# QA Security & Hardening Test Specifications

> **v2 Enhancement:** QA is split into four sub-phases. This file defines the test specifications for Sub-Phases B, C, and D. Sub-Phase A (Functional Testing) is covered by the existing `tests/CLAUDE.md` and `qa/CLAUDE.md`.

---

## Sub-Phase B: Security Testing

### B1. Automated Security Scans

**Dependency vulnerabilities:**
- Run `npm audit` (Node.js) or `pip audit` (Python)
- CRITICAL vulnerability = build blocker — must be fixed or documented with justification
- HIGH vulnerability = must be documented with justification if not fixed
- Generate report: affected package, severity, CVE ID, fix available (yes/no)

**Dependency license scan:**
- Flag any GPL or unknown-license dependencies in a commercial build
- Report: package name, license type, risk assessment

**Static analysis for vulnerability patterns:**
- Scan all source files for:
  - `eval()` usage
  - `innerHTML` with user-controlled input (use `textContent` or sanitize)
  - SQL string concatenation (must use parameterized queries)
  - Shell injection via string interpolation in `exec()` or `spawn()`
  - `dangerouslySetInnerHTML` without sanitization
  - `new Function()` with user input
  - Regex denial of service (ReDoS) patterns

### B2. Authentication & Authorization Testing

**Unauthenticated access:**
- Hit every API endpoint without an auth token → must return 401
- Hit every API endpoint with an expired token → must return 401
- Hit every API endpoint with a malformed token → must return 401

**Cross-tenant/cross-user access:**
- Hit every API endpoint with User A's token requesting User B's data → must return 403
- Attempt to modify another user's resource by changing IDs in the request body → must be rejected
- Verify tenant ID is derived from session, never from the request body/params

**Role-based access (if applicable):**
- Hit every admin-only endpoint with a non-admin token → must return 403
- Attempt privilege escalation by modifying request body to include a different role → must be rejected
- Verify role changes are audited

**Session management:**
- Verify session/token expiry works correctly
- Verify refresh token rotation (old refresh tokens are invalidated)
- Verify logout actually invalidates the session/token

### B3. Input Validation Testing

**XSS payloads — submit to every text input and form field:**
```
<script>alert(1)</script>
<img onerror="alert(1)" src="x">
<svg onload="alert(1)">
javascript:alert(1)
" onmouseover="alert(1)
```
Expected: sanitized or rejected. Never rendered as executable HTML.

**SQL injection payloads — submit to every search/filter parameter:**
```
'; DROP TABLE users; --
' OR '1'='1
' UNION SELECT * FROM users --
1; UPDATE users SET role='admin'
```
Expected: parameterized queries prevent execution. No error that leaks schema info.

**Oversized payloads:**
- Submit 1MB+ strings to text fields → must be rejected with 413 or 400
- Submit 10,000-element arrays → must be rejected
- Submit deeply nested JSON (100+ levels) → must be rejected

**Type confusion:**
- Submit string where number expected → must return 400 with clear validation error
- Submit object where string expected → must return 400
- Submit array where single value expected → must return 400

### B4. Secrets Scan

- Grep all source files, config files, and test files for patterns matching:
  - API keys (long alphanumeric strings, especially with prefixes like `sk-`, `pk_`, `AIza`)
  - Bearer tokens
  - Connection strings with embedded passwords
  - Base64-encoded credentials
- Verify `.env` is in `.gitignore`
- Verify no `.env` file was committed in git history: `git log --all --diff-filter=A -- '*.env'`
- Verify no hardcoded `localhost` URLs that would fail in production

---

## Sub-Phase C: Backend & Infrastructure Testing

### C1. API Contract Testing

- Every documented API endpoint exists and responds
- Every response matches the documented schema (field names, types, required vs optional)
- Error responses follow the standard error format: `{ error, code, details? }`
- Pagination parameters work correctly (page, limit, offset)
- Rate limiting headers are present where configured (`X-RateLimit-Limit`, `X-RateLimit-Remaining`)
- CORS headers are correct (no wildcard in production, correct allowed origins/methods)
- Security headers present: `X-Content-Type-Options`, `X-Frame-Options`, `Strict-Transport-Security`

### C2. Data Integrity Testing

**CRUD lifecycle:**
- Create a record → read it → verify all fields persisted correctly
- Update a record → read it → verify only changed fields updated, others unchanged, `updatedAt` bumped
- Delete a record → read it → verify it's gone (or soft-deleted per spec)
- Verify timestamps are set correctly on create and update

**Concurrency:**
- Concurrent writes to the same record → verify no data corruption
- Concurrent reads during a write → verify read consistency

**Referential integrity:**
- Deleting a parent record → verify children are handled (cascade delete, soft delete, or rejected)
- Creating a record with a non-existent foreign key → must return error

### C3. Database Scope Testing

- Grep all query/find/where calls in the codebase → verify each includes tenant/user scope filter
- Create two test tenants with test data
- Verify Tenant A cannot see Tenant B's data through any endpoint
- Verify Tenant A cannot modify Tenant B's data through any endpoint
- Verify list endpoints only return records for the authenticated tenant

### C4. Environment Configuration Testing

- All required env vars are documented in `.env.example`
- App starts without crashing when all documented env vars are set
- App produces a clear error message (not a stack trace) when a required env var is missing
- No env var has a default value that would work in dev but fail in production (e.g., `localhost` URLs, `change-me` secrets in production mode)
- Verify `NODE_ENV` handling: development enables debug features, production disables them

---

## Sub-Phase D: Compliance-Specific Testing (Conditional)

> **This sub-phase runs ONLY when the spec or build context indicates compliance requirements** (FERPA, HIPAA, SOC2, attorney-client privilege, etc.). The Lead Agent determines applicability during Phase 0.

### D1. Audit Trail Testing

- Every data-modifying action produces an audit log entry
- Audit entries include: who (user/tenant ID), what (action type), when (timestamp), what changed (before/after or description)
- Audit log entries cannot be modified or deleted through any API endpoint
- Audit log is queryable by date range, user, and action type
- Verify audit entries are created for: create, update, delete, role change, login, failed login

### D2. Role-Based Access Control Testing

- Build a matrix of all roles × all endpoints
- Test every cell in the matrix — verify each role can only access what it should
- Verify role assignment and role changes are audited
- Verify no endpoint defaults to "allow" when role is unrecognized
- Verify role checks cannot be bypassed by manipulating request headers or body

### D3. Data Handling Testing

**PII identification and protection:**
- PII fields are identified in the data model
- PII does not appear in application logs (grep all log statements for PII field names)
- PII does not appear in error messages returned to clients
- PII does not appear in URLs or query parameters

**Data lifecycle:**
- Data deletion requests actually remove data from all storage layers (primary DB, caches, search indexes)
- Data export produces complete and accurate results
- Data retention policies are enforced (if applicable)

### D4. Encryption Testing

- Data in transit: all external API calls use HTTPS. No HTTP fallbacks.
- Data at rest: sensitive fields (tokens, PII) are encrypted in the database (if spec requires)
- Encryption keys are not stored alongside the data they protect
- Verify TLS configuration for any exposed endpoints

---

## QA Report Format

Each sub-phase produces a report at `{build_dir}/docs/reviews/qa-{subphase}-report.md`:

```markdown
# QA Report — Sub-Phase {A/B/C/D}
Date: {timestamp}
Agent: QA Agent

## Verdict: PASS | FAIL | PASS WITH WARNINGS

## Summary
- Tests run: {count}
- Passed: {count}
- Failed: {count}
- Warnings: {count}

## Failures
### Failure 1
- Test: {test name}
- Expected: {expected behavior}
- Actual: {actual behavior}
- Severity: CRITICAL | HIGH | MEDIUM
- File(s) affected: {paths}

## Warnings
### Warning 1
- Test: {test name}
- Concern: {description}
- Recommendation: {action}

## Human Review Notes
{Section specifically for the human reviewer — plain English summary of what was tested, 
what passed, what the reviewer should double-check manually. Written assuming the reviewer 
is a developer who did NOT build the code and needs to understand the security posture quickly.}
```

---

## Integration with Pipeline

| Sub-Phase | When It Runs | Blocking? |
|-----------|-------------|-----------|
| A: Functional | Phase 3 | Yes — all tests must pass |
| B: Security | Phase 3 (after A) | Yes — CRITICAL = blocker, HIGH = must document |
| C: Backend & Infra | Phase 3 (after B) | Yes — all tests must pass |
| D: Compliance | Phase 3 (after C, conditional) | Yes — all tests must pass if triggered |

All four sub-phase reports must be PASS or PASS WITH WARNINGS before CP5 (Final Review Gate).
