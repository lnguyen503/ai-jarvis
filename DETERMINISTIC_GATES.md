# Jarvis — Deterministic Hard Gates

Tool-based gates that run sequentially after CP2. Each gate is a tool invocation (not an agent judgment). First failure halts the sequence; Fix Agents address that specific gate before the next runs. Results populate the `BUILD_REPORT.md` gate table.

**Reference:** ADR 017 §3.5 + W3 (Gate H addition v1.17.0).

---

## Gate A — TypeScript compile (no emit)

```bash
npx tsc --noEmit
```

**Pass condition:** Zero errors, zero warnings (except those explicitly suppressed with `// @ts-expect-error` + reason comment).

---

## Gate B — ESLint

```bash
npx eslint src tests --ext .ts --max-warnings=0
```

**Pass condition:** Zero warnings, zero errors.

---

## Gate C — npm audit

```bash
npm audit --audit-level=high
```

**Pass condition:** Zero high/critical vulnerabilities. Moderate vulnerabilities documented in `docs/SECURITY-EXEMPTIONS.md` with justification.

---

## Gate D — Secrets scan (gitleaks)

```bash
gitleaks detect --source . --no-git
```

**Pass condition:** Zero leaked secrets. Any suppressed finding requires a `gitleaks:allow` comment with reason.

---

## Gate E — Static analysis (semgrep)

```bash
semgrep --config auto src/ --error
```

**Pass condition:** Zero findings at `error` severity. Warnings documented.

---

## Gate F — Prompt-injection defense clause scan

```bash
grep -rn "untrusted" src/ --include="*.ts"
```

**Pass condition:** Every agent tool handler that calls `read_file`, `web_fetch`, `run_command`, or MCP tools contains the `<untrusted>` boundary wrapper and system-prompt clause. Zero handlers without the wrapper.

---

## Gate G — Logging standard scan

```bash
grep -rn "console.log\|console.error\|console.warn" src/ --include="*.ts"
```

**Pass condition:** Zero raw `console.*` calls in `src/`. All logging uses the `src/logger/index.ts` pino logger. Suppressions require `// LOGGING-EXEMPT: <reason>` inline comment.

---

## Gate H — Audit privacy field-name scan (v1.17.0; W3 binding)

**W3 binding (ADR 017-revisions):** Audit shared modules must not contain raw field-value patterns (`value:`, `content:`, `title:`, `body:`) that would indicate developer injected user-authored content values into audit detail rows. Privacy posture: audit rows store metadata (ids, counts, action types, ip), never content.

**Scan command:**

```bash
grep -nE "['\"]?\bvalue\b['\"]?\s*:\s*" \
  src/webapp/audit.list.ts \
  src/webapp/audit.shared.ts \
  src/webapp/memory.shared.ts \
  src/webapp/scheduled.shared.ts \
  | grep -v '// ALLOWED:'
```

**Pass condition:** Zero matches. Inline `// ALLOWED: <reason>` comment permits a specific legitimate use (e.g., a closed-enum literal like `action: 'list'`).

**CI test:** `tests/static/audit-privacy-scan.test.ts` (Vitest) — runs the equivalent TypeScript check as part of the test suite.

---

## Usage

Run all gates sequentially:

```bash
npx tsc --noEmit && \
npx eslint src tests --ext .ts --max-warnings=0 && \
npm audit --audit-level=high && \
npx vitest run tests/static/
```

Gates A + B + H run as part of `npx vitest run` via the static test files. Gates C + D + E + F + G require separate tool invocations.
