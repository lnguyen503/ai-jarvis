# Anti-Slop Framework — 16-Section Enforcement Standard

> **This is AI Factory v2. This framework is ENFORCED by the Anti-Slop Reviewer agent, not advisory.**
> Every section is checked on every review pass. Any FAIL blocks the phase transition.

## Purpose

This document defines the 16 non-negotiable quality standards that all factory-built code must meet. The Anti-Slop Reviewer agent reads this file and uses it as the checklist for every review pass. Agents do not self-certify compliance — the Anti-Slop Reviewer independently verifies it.

Adapted from the AI Agency platform's AI-SLOP-PREVENTION.md, generalized for any project the factory builds.

---

## 1. Spec-Before-Code — For New Features

New modules, features, services, and data models require a written spec before implementation begins. Iterative refinements (bug fixes, UI tweaks, prompt tuning, refactoring) do NOT need specs.

### What NEEDS a spec:
- New modules or services
- New features within an existing module
- New API endpoints or changed data models
- Architectural changes (adding a queue, changing auth flow)

### What does NOT need a spec:
- Bug fixes, UI refinements, prompt tuning
- Code reviews, performance fixes, style changes
- Refactoring existing code

### What a spec must include:
- **Data models** — document structure with field names, types, and examples
- **API routes** — method, path, request body, response shape, error codes
- **Service interfaces** — what each service does, accepts, and returns
- **Build order** — numbered steps, each independently testable
- **What NOT to do** — explicit constraints and boundaries

---

## 2. Build Order Discipline

Features are built in a defined sequence. Each step must be tested and verified before the next step begins.

### Rules:
- Never skip a step to build something more exciting
- Never build Step N+1 on top of a broken Step N
- If a step fails testing, fix it before moving forward
- If a step requires rework that affects earlier steps, update and retest those too

---

## 3. Error Handling — No Silent Failures

Every service, route, and external API call must have explicit error handling.

### Rules:
- Every `try/catch` must log the error with context (what was being attempted, what input caused it)
- Every API route must return appropriate HTTP status codes, not just 500 for everything
- Every external API call must handle: timeouts, rate limits, auth expiry, malformed responses
- Never catch an error and do nothing with it
- Never use `console.log` for error logging in production — use structured logging
- No empty catch blocks. No generic "Error" messages.

### Required error response format:
```typescript
{
  error: string;       // Human-readable message
  code: string;        // Machine-readable error code (e.g., "EMAIL_SYNC_FAILED")
  details?: any;       // Optional debug info (omit sensitive data)
}
```

---

## 4. No Hardcoded Values

Configuration, credentials, URLs, model names, limits, and tenant-specific values must never be hardcoded in source code.

### Must be environment variables:
- API keys and secrets
- External URLs (redirect URIs, API endpoints)
- AI model names (allows switching models without code change)
- Rate limits and batch sizes

### Must be in database config (per-tenant, if applicable):
- User preferences, tenant settings
- Module activation status
- Feature flags

### Must be constants (in a shared config file):
- HTTP status codes, error code strings
- Default values and fallbacks

---

## 5. Separation of Concerns

Each service does one thing. Services communicate through defined interfaces, not by reaching into each other's internals.

### Rules:
- A service never imports another service's internal helpers
- A service never directly reads/writes another service's data store
- If two services need the same utility, extract it to a shared utility file
- Route handlers are thin — they call services, never other route handlers
- No god-functions that do everything

---

## 6. Data Discipline

Database-agnostic rules for data integrity and tenant isolation.

### Rules:
- Every database query MUST filter by tenant/user scope — no exceptions, ever
- Sensitive data (tokens, email bodies, PII) processed in memory and discarded unless storage is explicitly required and encrypted
- Use consistent field naming: camelCase for all fields
- Every record must have `createdAt` and `updatedAt` timestamps
- Never store derived data that can be recomputed (unless for performance, and then document why)
- Data model documentation must exist for every entity/table/collection

### Anti-pattern:
```typescript
// BAD — no tenant isolation
db.query('SELECT * FROM tasks WHERE userId = ?', [userId])
// No tenantId filter — any user from any tenant could access this

// CORRECT
db.query('SELECT * FROM tasks WHERE tenantId = ? AND userId = ?', [tenantId, userId])
```

---

## 7. AI Prompt Quality

All AI-facing prompts must be production-quality, not afterthoughts.

### Rules:
- Every AI prompt must be in a separate, editable constant or template file — not inline in service code
- Prompts must include explicit output format instructions (JSON schema, field names, allowed values)
- Prompts must include examples of expected input → output
- Prompts must define edge cases
- Never send more data than needed to the AI (cost + latency reduction)
- Log prompt + response pairs for debugging (redact PII in logs)

---

## 8. Frontend Quality Standards

### Rules:
- Loading states for every async operation — never leave the user staring at a blank screen
- Error states with actionable messages — "Failed to sync. Click to retry." not "Error."
- Empty states with helpful guidance — "No items yet. Click Add to get started."
- Responsive design — test at mobile, tablet, and desktop widths
- No hardcoded tenant/user data in the frontend
- Use the project's design system consistently — don't introduce new styling approaches
- Every user action that modifies data should show immediate feedback (optimistic updates or loading indicators)
- No `console.log` statements in production code

---

## 9. Security — Non-Negotiable Rules

### Authentication:
- Auth middleware on every non-public route — no exceptions
- Tenant/user ID derived from session, never trusted from client
- Validate that the authenticated user has access to the requested resource

### Data:
- Sanitize HTML before rendering (XSS prevention)
- Never log full tokens, API keys, or passwords
- Never return credentials in API responses
- Never store credentials in the database — use environment variables or a secret manager

### Additional (v2):
- CORS policy must be explicit — no wildcard in production
- CSP headers configured
- Rate limiting on authentication endpoints specifically
- All external API calls use HTTPS — no HTTP fallbacks

---

## 10. Real Data Testing

Tests use realistic data shapes, not `{foo: "bar"}`.

### Rules:
- Test data must resemble real production data in shape and content
- Edge cases covered: empty arrays, null values, max-length strings, unicode, special characters
- Every feature must be tested with realistic scenarios, not just compile-and-pass
- Error cases tested: network errors, bad input, auth failures, empty data

---

## 11. Code Review Checkpoints

### Rules:
- No duplicated code that should be shared
- No missing TypeScript types
- No `any` type usage without documented justification
- No console.log statements that should be structured logging
- No service reaching into another service's internals
- No API routes missing auth middleware
- No database queries missing tenant/user scope filter

---

## 12. Institutional Memory

CLAUDE.md in the build directory must be updated with every known bug, every env var change, every structural decision.

### After every session, update CLAUDE.md with:
- New environment variables added
- New known bugs discovered and how they were fixed
- New deployment steps or changes to the deploy process
- Any changes to project structure

### Known Bug format:
```markdown
### [Number]. [Short description]
**Symptom:** What the user or developer sees
**Cause:** What actually went wrong
**Fix:** What was changed
**Prevention:** How to avoid this in the future
```

---

## 13. Module Isolation

Each module has its own directory, its own routes, its own data scope. A broken module cannot crash another module.

### Rules:
- Each module has its own directory with clear boundaries
- Modules communicate through defined interfaces (REST APIs, shared types), not by importing each other's services
- Shared utilities (auth, logging, database helpers) live in a shared directory
- A module being disabled or broken must never affect other modules
- Each module has its own route prefix (e.g., `/api/v1/tasks/`, `/api/v1/users/`)

---

## 14. Performance Guardrails

### Rules:
- Batch operations have configurable limits (not unlimited)
- Long-running operations are async with status tracking — never block a request for more than 5 seconds
- Pagination on all list endpoints
- Rate limit handling with exponential backoff for external APIs
- Frontend paginates or virtualizes large lists
- Never fetch bulk data when a filtered/paginated query would suffice

---

## 15. Logging Standards

### What to log:
- Every API request (method, path, tenant, response time, status code)
- Every external API call with duration and status
- Every error with full context
- Authentication events (login, logout, token refresh)

### What NOT to log:
- Email bodies, message content, or document text
- OAuth tokens, API keys, passwords, or credentials
- PII beyond what's needed for debugging (use tenant/user IDs, not names/emails)

### Log format:
Use structured logging (JSON-compatible), not free-text console.log.

---

## 16. Deployment Checklist

Before every deploy:
- [ ] Code compiles without TypeScript errors
- [ ] No `console.log` debug statements left in code
- [ ] New environment variables documented in `.env.example` and CLAUDE.md
- [ ] All new API routes have auth middleware
- [ ] All new database queries have tenant/user scope filters
- [ ] No debug statements or test-only code in production paths
- [ ] Dependency audit clean (no CRITICAL vulnerabilities)

---

## Anti-Slop Review Output Format

The Anti-Slop Reviewer produces this format for every review pass:

```markdown
# Anti-Slop Review — Phase {N}
Date: {timestamp}
Reviewer: Anti-Slop Agent (opus)
Files Reviewed: {count}

## Verdict: PASS | FAIL | PASS WITH WARNINGS

## Section Results

| # | Section | Verdict | Files Affected | Notes |
|---|---------|---------|---------------|-------|
| 1 | Spec-Before-Code | PASS | — | — |
| 2 | Build Order | PASS | — | — |
| 3 | Error Handling | FAIL | src/services/api.ts:42 | Empty catch block, no error context |
| ... | ... | ... | ... | ... |

## Violations (FAIL)
### Violation 1: [Section name]
- File: {path}:{line}
- What's wrong: {description}
- Required fix: {specific instruction}
- Anti-Slop section reference: Section {N}

## Warnings
### Warning 1: [Section name]
- File: {path}:{line}
- Concern: {description}
- Recommendation: {specific instruction}

## Files Reviewed
{list of every file reviewed with PASS/FAIL per file}
```

---

## Project-Specific Extensions

The 16 sections above are the universal baseline. For builds with compliance requirements (FERPA, HIPAA, SOC2, attorney-client privilege, etc.), the Lead Agent adds project-specific rules during Phase 0 that are loaded alongside these. The Anti-Slop Reviewer enforces both the universal and project-specific rules.
