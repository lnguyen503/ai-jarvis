# Contributing to Jarvis

Jarvis is a personal tool. This guide is primarily for Boss's own reference when extending the agent.

---

## Adding a New Tool

Tools live in `src/tools/`. Each tool is a single TypeScript file that exports one `Tool` object.

### Step 1 — Create the tool file

```typescript
// src/tools/my_tool.ts

/** One-line description of what this tool does. */

import { z } from 'zod';
import type { Tool, ToolResult, ToolContext } from './types.js';

const MyToolInput = z.object({
  myParam: z.string().min(1).describe('What this parameter is for'),
});

type MyToolInputType = z.infer<typeof MyToolInput>;

const myTool: Tool = {
  name: 'my_tool',
  description: 'Clear description for Claude — what it does, when to use it, what it returns.',
  parameters: MyToolInput,

  async execute(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = MyToolInput.parse(rawInput);

    try {
      // Your logic here
      const result = await doSomething(input.myParam);

      return {
        ok: true,
        output: `Result: ${result}`,
        data: { result },
      };
    } catch (err) {
      ctx.logger.error({ err, input }, 'my_tool failed');
      return {
        ok: false,
        output: `my_tool failed: ${err instanceof Error ? err.message : String(err)}`,
        error: { code: 'MY_TOOL_FAILED', message: String(err) },
      };
    }
  },
};

export default myTool;
```

### Step 2 — Register the tool

Edit `src/tools/index.ts` and add an import + registration:

```typescript
import myTool from './my_tool.js';

// Inside registerAll():
_tools.push(myTool);
```

### Step 3 — Write tests

Create `tests/unit/tools.my_tool.test.ts`. Follow the existing pattern in `tools.read_file.test.ts` or `tools.run_command.test.ts`:
- Test the happy path
- Test input validation (Zod errors)
- Test error handling (what happens when the underlying op fails)
- If it touches the filesystem, test path sandbox rejection

### Step 4 — Verify

```bash
npm run typecheck       # must pass
npm test                # all tests must pass
```

### Tool Interface Contract

| Property | Type | Required | Notes |
|----------|------|----------|-------|
| `name` | `string` | Yes | Snake_case, unique across all tools |
| `description` | `string` | Yes | Claude reads this — be precise and specific |
| `parameters` | `ZodTypeAny` | Yes | Zod schema; becomes JSON Schema for Claude |
| `execute` | `async function` | Yes | Always return `ToolResult` — never throw |

**Rules:**
- `execute` must never throw — catch all errors and return `{ ok: false, ... }`
- All file operations must go through `ctx.safety.isReadAllowed()` / `ctx.safety.isWriteAllowed()`
- All command outputs must be passed through `ctx.safety.scrub(output)` before returning
- Log with `ctx.logger` (structured), not `console.log`
- Respect `ctx.abortSignal` for long-running operations

---

## Coding Standards

### TypeScript
- Strict mode (`strict: true` in tsconfig.json) — no implicit `any`
- No `// @ts-ignore` or `// @ts-expect-error` without a comment explaining why
- Prefer `unknown` over `any` for external inputs; use Zod to narrow
- All public module exports get a one-line JSDoc comment (`/** ... */`)

### Error Handling
- Every `try/catch` must log the error with context before returning or rethrowing
- Silent `catch {}` is prohibited except for best-effort cleanup in `finally` blocks
- Use `ctx.logger.error({ err, ...context }, 'description')` — always object-first

### Secrets
- Never hardcode API keys, tokens, or passwords
- Use `ENV:VAR_NAME` in `config.json` for values sourced from environment
- The scrubber (`src/safety/scrubber.ts`) runs on all tool outputs — add new secret patterns there if needed

### Commits
Follow [Conventional Commits](https://www.conventionalcommits.org/):

| Prefix | When |
|--------|------|
| `feat:` | New tool, new command, new capability |
| `fix:` | Bug fix |
| `test:` | Adding or fixing tests only |
| `docs:` | Documentation changes only |
| `refactor:` | Code restructuring without behavior change |
| `chore:` | Tooling, deps, config |

Examples:
- `feat: add git_status tool`
- `fix(safety): tighten HEX_BLOB pattern to require context anchor`
- `test(tools): add edge cases for write_file append mode`

---

## Running the Test Suite

```bash
# All tests (unit + integration)
npm test

# With coverage report
npx vitest run --coverage

# Watch mode during development
npm run test:watch

# Type-check only
npm run typecheck

# Lint
npm run lint
npm run lint:fix
```

### Test File Naming Convention

| Pattern | What it tests |
|---------|---------------|
| `tests/unit/tools.{name}.test.ts` | A specific tool |
| `tests/unit/safety.{aspect}.test.ts` | Safety layer (paths, blocklist, scrubber, confirmations) |
| `tests/unit/memory.{aspect}.test.ts` | Memory/SQLite layer |
| `tests/unit/gateway.{aspect}.test.ts` | Gateway layer (allowlist, commands, health, queues) |
| `tests/unit/agent.{aspect}.test.ts` | Agent layer (context builder, Claude client, safety) |
| `tests/unit/security.{scenario}.test.ts` | Cross-cutting security regression tests |
| `tests/integration/tools.{name}.test.ts` | Integration tests (real filesystem, real DB) |

---

## Factory Gate Checklist

This project was built with the AI Factory v2. After significant changes, re-run these checks:

| Gate | Command | Pass Criteria |
|------|---------|---------------|
| TypeScript | `npm run typecheck` | Zero errors |
| Tests | `npm test` | All pass |
| Coverage | `npx vitest run --coverage` | 80%+ statements |
| Security audit | `npm audit --omit=dev` | Zero HIGH/CRITICAL |
| Anti-Slop | Manual review against `docs/ANTI-SLOP.md` | All 16 sections PASS |

---

## Project Structure

```
src/
├── index.ts          # Entry point — boots all modules in order
├── gateway/          # Telegram bot, message routing, per-chat queue
├── agent/            # Claude API client, ReAct loop, context builder
├── tools/            # Tool registry + individual tool implementations
├── safety/           # Path sandbox, command blocklist, confirmation flow, scrubber
├── memory/           # SQLite CRUD layer (sessions, messages, projects, etc.)
├── transcriber/      # Whisper voice transcription
├── scheduler/        # node-cron scheduled tasks
├── config/           # Zod config schema + loader
└── logger/           # Pino structured logger
```

See `docs/ARCHITECTURE.md` and `docs/STRUCTURE.md` for full design details.
