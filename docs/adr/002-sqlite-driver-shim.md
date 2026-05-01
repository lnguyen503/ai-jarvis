# ADR 002 — SQLite Driver Shim (node:sqlite Fallback)

**Status:** Accepted
**Date:** 2026-04-13
**Deciders:** Fix Agent (CP3 hardening)
**Supersedes:** ADR 001 §2 (SQLite driver) — partial revision

---

## Context

ADR 001 mandates `better-sqlite3` as the SQLite driver. `better-sqlite3` is a native Node.js addon that must be compiled against the target Node.js ABI using `node-gyp`. On the development machine (Windows 11, Node 25.x), this compilation fails because:

1. **No VS Build Tools installed.** `node-gyp` requires Visual Studio Build Tools (or the full VS IDE) with the "Desktop development with C++" workload. These are not present and installation adds ~6 GB to the developer machine.
2. **Node 25 is a Current release.** Pre-built binaries for `better-sqlite3` are published for LTS lines only. Node 25 has no pre-built binary at time of writing; source compilation is the only option, which brings us back to (1).

Node.js 22.5+ ships `node:sqlite` as an experimental built-in module. It covers the same synchronous API surface (prepared statements, WAL, pragmas) that Jarvis uses. The interface is different enough from `better-sqlite3` that it cannot be used as a drop-in, but it is close enough to wrap in a thin shim.

---

## Decision

`src/memory/dbDriver.ts` implements a driver abstraction (`DbHandle` + `Statement`) that normalises the `better-sqlite3` and `node:sqlite` APIs behind a common interface. At runtime the module attempts to load `better-sqlite3` first; if that fails it falls back to `node:sqlite`.

The shim boundary is intentionally minimal:

- `DbHandle.prepare(sql)` → `Statement`
- `Statement.run(params)` → `{ lastInsertRowid: number }`
- `Statement.all(params)` → `unknown[]`
- `Statement.get(params)` → `unknown | undefined`
- `DbHandle.pragma(expr)` → `void`
- `DbHandle.close()` → `void`

All repository code (`MessagesRepo`, `CommandLogRepo`, `SessionsRepo`, etc.) interacts only through this interface. No repository module imports `better-sqlite3` or `node:sqlite` directly.

---

## Consequences

**Positive:**
- Zero build-tooling dependency for local development on Windows without VS Build Tools.
- The project remains functional on Node 25 current without waiting for `better-sqlite3` to publish a pre-built binary.
- CI/CD on Linux runners (with build tools available) uses `better-sqlite3` and benefits from its battle-tested stability and performance.

**Negative / Risks:**
- `node:sqlite` is marked experimental. Its API may change in a Node minor release. The shim isolates this risk to one file (`dbDriver.ts`), but a breaking change in `node:sqlite` would require updating the shim.
- The shim is a hand-written bridge — it has been tested against our query patterns but is not as thoroughly validated as `better-sqlite3`'s adapter code.
- If `better-sqlite3` compilation is fixed (e.g. VS Build Tools are installed, or Node 22 LTS is adopted), the fallback path becomes dead code. It should be removed at that point.

---

## Removal Criteria

Remove the `node:sqlite` fallback when **all** of the following are true:

1. The primary runtime Node.js version is an LTS release for which `better-sqlite3` publishes pre-built binaries (currently Node 20 or 22).
2. Pre-built binaries are confirmed to install without compilation (`npm install` succeeds without invoking `node-gyp`).
3. All CI and production environments satisfy (1) and (2).

Until then, the shim stays.

---

## References

- `src/memory/dbDriver.ts` — shim implementation
- ADR 001 §2 — original `better-sqlite3` decision
- Anti-Slop Review Phase 2, Warning 8 — flagged missing ADR
- CP3 Scalability Review — verified shim does not affect query correctness or WAL behaviour
