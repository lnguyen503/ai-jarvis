# SPEC Addendum: Autonomous Plan & Execute (Manus-style mode)

**Status:** draft, not yet built
**Target version:** v1.8.0
**Author:** Boss (intent), Claude (drafting)
**Date:** 2026-04-21

---

## Problem Statement

Today Jarvis is a single-turn agent: one user message → one plan → one tool loop → one reply. Complex requests like "research the Indianapolis EV charging market and write me a one-pager" either get a single shallow answer or require the user to manually drive a chain of follow-up turns ("now search for X", "now read source Y", "now write the report").

The user wants Jarvis to behave like Manus / Replit Agent: detect a complex goal, build its own task list, execute the tasks autonomously using the existing tool stack and Ollama Cloud models, show live progress in a single editable Telegram message (the way Claude Code shows a TaskList while it works), and deliver a final synthesized result. The human supplies the goal; Jarvis figures out the plan and the steps.

The execution layer is already in place — multi-model routing (Ollama Cloud + Claude escalation), 16 tools (file system, shell, web search, headless browser, Calendar, Gmail, MCP), per-chat workspace isolation. What's missing is the meta-layer: a planner, an executor that drives multiple agent turns toward a stated goal, and a progress UI in Telegram.

---

## Scope

### In scope (v1.8.0 MVP)

- New "plan" turn type that wraps multiple existing agent turns toward a single goal.
- Auto-detection of complex requests OR explicit invocation via `/plan <goal>`.
- Claude-based planner that decomposes a goal into 3–15 atomic tasks.
- Executor loop that runs each task using the existing agent turn machinery, with Ollama Cloud as the default provider.
- Live progress panel in Telegram: a single message edited in place as tasks transition.
- Artifact persistence under the chat's existing workspace (`workspaces/{users|groups}/<chat_id>/plans/<plan_id>/`).
- Plan + task state persisted in SQLite so a long run survives a process restart.
- `/cancel <plan_id>` to abort a running plan; `/plans` to list active and recent plans.
- Hard runaway caps (max tasks, max wall time, max iterations per task).

### Out of scope (deferred)

- Parallel sub-agent fan-out (tasks run sequentially in MVP).
- Cross-plan memory (each plan is a fresh context; conversation history is unchanged).
- Plan templates / saved playbooks ("research playbook", "code-review playbook").
- Web UI / dashboard (everything stays inside Telegram).
- Multi-user plan collaboration (plans are owned by the chat that created them).
- Mid-plan replan ("the planner notices halfway that the original plan was wrong"). MVP commits to the plan it produced; the user can `/cancel` and re-issue if needed.

---

## Trigger Heuristic

A request enters Plan-mode if **any** of the following are true:

1. The user explicitly invokes `/plan <goal>` (always wins).
2. The request mentions a "research / analyze / build / write a report on / find out everything about / put together a / give me a deep dive on" verb cluster (regex set, easy to extend) AND is longer than 60 characters.
3. The intent classifier (the same `gemma4:cloud`-style call introduced in v1.7.13) returns `{plan: true}` — extend the classifier prompt to include a `plan` flag alongside the existing `addressed` flag. Cheap, already on the hot path.

If detected, Jarvis posts: *"This looks like a multi-step task. Planning… (use `/cancel <plan_id>` to stop me at any point.)"* and proceeds. The user can also opt out by prefixing with `/just` (single-turn override) to suppress auto-Plan.

---

## Planner

A single Claude call (Sonnet 4.6 or Opus, opus default) with a strict-output planning prompt.

### Input

```
Goal: <user's request>
Context:
  - Chat type: dm | group
  - Available tools: <list of currently active tool names with one-line descriptions>
  - Available models: <list of Ollama Cloud models with strengths>
  - Workspace path: <chat workspace root>
  - Recent conversation: <last 5 turns, scrubbed>
```

### Output schema

```json
{
  "plan_id": "<server-assigned uuid>",
  "goal_summary": "<one sentence restatement>",
  "estimated_tasks": 5,
  "tasks": [
    {
      "id": "t1",
      "title": "Search for recent news on <topic>",
      "rationale": "Need fresh primary sources before synthesizing.",
      "depends_on": [],
      "suggested_tools": ["web_search"],
      "suggested_model": "ollama-cloud:gemma4",
      "expected_artifact": "search-results.json",
      "max_iterations": 3
    },
    {
      "id": "t2",
      "title": "Browse top 3 results and extract key facts",
      "rationale": "Snippets aren't enough; need full article body.",
      "depends_on": ["t1"],
      "suggested_tools": ["browse_url", "write_file"],
      "suggested_model": "ollama-cloud:minimax-m2.7",
      "expected_artifact": "extracted-facts.md",
      "max_iterations": 6
    }
    /* ... */
  ],
  "synthesis_task": {
    "id": "tN",
    "title": "Compose final report",
    "suggested_tools": ["read_file", "write_file"],
    "suggested_model": "ollama-cloud:glm-5.1",
    "expected_artifact": "REPORT.md"
  }
}
```

### Planner prompt principles

- Atomic tasks — each task should be completable in one agent turn (≤6 tool iterations).
- Tasks list their inputs (`depends_on`) explicitly so the executor can pass artifact paths forward.
- Tasks suggest a model + tool set, but the executor is allowed to override (e.g., if a model is rate-limited).
- The plan always ends with one synthesis task that reads the accumulated artifacts and produces the final deliverable.
- If the planner can't decompose the goal (vague, ambiguous, or single-step), it returns `{plan: null, reason: "..."}` and Jarvis falls back to a normal single-turn agent.

---

## Executor

A new `src/plan/executor.ts` module. The executor is essentially a state machine over `plan_tasks`.

### Per-task loop

For each task in topological order (respecting `depends_on`):

1. Mark task `running`. Update progress panel.
2. Build a "task brief" string: title + rationale + list of artifact paths from completed dependencies.
3. Call the existing agent turn loop with:
    - `provider/model` = `task.suggested_model` (resolved through the existing router).
    - `allowedToolNames` = `task.suggested_tools` (intersected with the chat's role-based allowlist for safety).
    - `maxIterations` = `task.max_iterations`.
    - `system_prompt_suffix` = "You are executing task <id> of plan <plan_id>. Goal: <goal_summary>. Your task: <title>. Write any artifacts to <plan_dir>/<task_id>/ and return a one-paragraph summary of what you did and where the artifact is."
4. Capture the agent's reply + any files it wrote under the plan directory. Mark task `completed` with `output_summary` + `artifact_paths`.
5. Update progress panel.
6. If the task fails (agent error, model 429 after retries, exceeded iterations): mark `failed`, log the error, and **continue to the next task that doesn't depend on the failed one**. The plan is never aborted by a single task failure unless the synthesis task fails.
7. If the synthesis task completes, the plan is `completed`. Post the final artifact contents to the chat (or send as a file via `send_file` if too large).

### Model fallback / rate-limit handling

- If Ollama Cloud returns 429 on the suggested model, retry with exponential backoff (3 attempts, 2s/4s/8s).
- After 3 failed retries, switch to the next model in the debate pool (`src/debate/pool.ts` already has the rotation list).
- If all OSS models in the pool are rate-limited, the executor pauses for 60s and retries from the top.
- Claude is **not** used as a fallback for executor tasks (per the user's "build is Ollama" rule). If you want Claude on a specific task, the planner specifies it.

### Concurrency

MVP runs tasks sequentially. The data model already supports `depends_on`, so a future iteration can add a worker pool that runs independent tasks in parallel. Sequential is also gentler on the rate limit.

---

## Progress Panel (Telegram UI)

A single Telegram message, posted at plan start, edited in place as the plan progresses. Uses `bot.api.editMessageText` (already exposed via `TelegramAdapter`).

### Format

```
🤖 Plan: research the Indianapolis EV charging market
   ID: pl_4f2a · 5 tasks · started 6:42pm

✓ t1  Search for recent news (3s)
✓ t2  Browse top 3 results and extract facts (47s)
⋯ t3  Pull state-level subsidy data
   └ web_search: "Indiana EV charging tax credit 2026"…
   t4  Compare against Ohio + Illinois benchmarks
   t5  Compose final report

⏱ 1m12s elapsed · /cancel pl_4f2a to stop
```

### Symbols

- `✓` completed
- `⋯` running (with active sub-line showing the current tool call)
- ` ` (blank, two spaces) pending
- `✗` failed (with a red error line below)
- `⊘` skipped (dependency failed)

### Edit cadence

- Minimum interval: 1500ms between edits (Telegram limits ~30 edits/min in groups).
- Buffer state changes within the interval; flush on a debounce timer.
- Always flush immediately on task `completed`/`failed`/`plan_completed`.

### Length limit

Telegram caps message text at 4096 chars. If the plan has too many tasks or the active sub-line is too long:

- Collapse `expected_artifact` lines to filename only.
- Truncate any line >100 chars with `…`.
- If the panel still exceeds 3800 chars, switch to a "compact" layout: one line per task, no sub-lines, no rationale.
- If even compact is too big, render the first/last 5 tasks and a `… 12 more …` middle line.

### When the plan completes

Edit the panel one final time to show all `✓`/`✗` final states + total time + artifact paths. Then post the synthesis output as a separate message (or file via `send_file` if >3000 chars).

---

## Artifact Storage

Every plan gets its own directory under the chat's existing workspace:

```
workspaces/users/<chat_id>/plans/<plan_id>/
├── plan.json              # the planner's full output
├── t1/
│   └── search-results.json
├── t2/
│   └── extracted-facts.md
├── t3/
│   └── subsidy-data.csv
└── REPORT.md              # the synthesis task's output
```

The plan directory is passed to each task's agent turn as part of the system prompt suffix. The existing `PathSandbox` already restricts writes to the chat's workspace root, so plan artifacts inherit the same isolation — no new safety surface.

`<plan_id>` is a short ulid-ish string (e.g., `pl_4f2a8c`). Generated when the planner returns. Visible in the progress panel and `/plans` output.

Old plans are not auto-deleted in MVP. A future iteration can add `/plans cleanup older-than 30d`.

---

## Persistence (SQLite)

Two new tables in a new migration `009_plans.sql`.

```sql
CREATE TABLE plans (
  plan_id          TEXT PRIMARY KEY,           -- 'pl_4f2a8c'
  chat_id          INTEGER NOT NULL,
  user_id          INTEGER NOT NULL,           -- creator
  goal             TEXT NOT NULL,              -- raw user request
  goal_summary     TEXT NOT NULL,              -- planner's restatement
  status           TEXT NOT NULL CHECK (status IN
                     ('planning','running','completed','failed','cancelled')),
  panel_message_id INTEGER,                    -- Telegram message id of the live panel
  plan_dir         TEXT NOT NULL,              -- absolute path to artifact dir
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  completed_at     INTEGER,
  error            TEXT
);

CREATE TABLE plan_tasks (
  task_id          TEXT NOT NULL,              -- 't1'
  plan_id          TEXT NOT NULL REFERENCES plans(plan_id) ON DELETE CASCADE,
  task_order       INTEGER NOT NULL,
  title            TEXT NOT NULL,
  rationale        TEXT,
  depends_on       TEXT,                       -- JSON array of task_ids
  suggested_tools  TEXT,                       -- JSON array
  suggested_model  TEXT,
  status           TEXT NOT NULL CHECK (status IN
                     ('pending','running','completed','failed','skipped')),
  output_summary   TEXT,
  artifact_paths   TEXT,                       -- JSON array of relative paths
  iterations_used  INTEGER DEFAULT 0,
  started_at       INTEGER,
  completed_at     INTEGER,
  error            TEXT,
  PRIMARY KEY (plan_id, task_id)
);

CREATE INDEX idx_plans_chat_id ON plans(chat_id);
CREATE INDEX idx_plans_status ON plans(status);
CREATE INDEX idx_plan_tasks_status ON plan_tasks(plan_id, status);
```

On Jarvis startup, scan for `plans WHERE status='running'` and either resume them (if `--resume-plans` flag is set, default off) or mark them `failed` with `error='process restart'`.

---

## Commands

| Command | Behavior |
|---------|----------|
| `/plan <goal>` | Force Plan-mode for the given goal (skips heuristic). |
| `/just <prompt>` | Force single-turn agent (skip auto-Plan even if heuristic would trigger). |
| `/plans` | List active and recent plans for this chat (last 10). |
| `/plans show <plan_id>` | Show the plan's task tree + status (re-renders the panel as a fresh message). |
| `/cancel <plan_id>` | Cancel a running plan. Marks running task `failed`, all pending tasks `skipped`. |

`/cancel` and `/plans` are admin-only in groups (same gating as `/audit`, `/clear`).

---

## Runaway Guards

Hard caps, all configurable but with safe defaults:

| Cap | Default | Purpose |
|-----|---------|---------|
| `plan.maxTasks` | 15 | Planner is rejected if it returns more. |
| `plan.maxWallTimeMs` | 600_000 (10 min) | Plan auto-cancels at this point. |
| `plan.maxIterationsPerTask` | 6 | Hard ceiling on agent iterations within one task. |
| `plan.maxArtifactBytes` | 5 * 1024 * 1024 (5 MB) | Per-artifact write cap (also enforced by existing `write_file` cap). |
| `plan.maxConcurrentPlansPerChat` | 1 | One plan at a time per chat. New `/plan` while one is running gets rejected with the active plan_id. |
| `plan.classifierThrottleMs` | 5_000 | Don't run the auto-detect classifier more than once per chat per 5s. |

All caps are surfaced in `config/config.json` under a new `plan: { ... }` section.

---

## Integration Points (existing code that needs to change)

This is a build sketch — don't treat it as a contract.

- **`src/gateway/index.ts`** — new command handlers (`/plan`, `/just`, `/plans`, `/cancel`); auto-Plan trigger after the existing intent classifier; route Plan-mode messages to the new executor instead of the agent turn loop.
- **`src/agent/index.ts`** — extract the per-turn execution into a function callable from the executor with explicit `model`, `tools`, `system_suffix`, `maxIterations`. Today these are gateway-coupled.
- **`src/plan/`** (new) — `planner.ts`, `executor.ts`, `panel.ts` (renderer + edit debouncer), `repo.ts` (SQLite), `types.ts`.
- **`src/config/schema.ts`** — add `plan` config block.
- **`src/memory/migrations/009_plans.sql`** — new migration.
- **`src/memory/index.ts`** — wire `PlansRepo` + `PlanTasksRepo`.
- **`src/commands/plan.ts`, `cancel.ts`, `plans.ts`** (new) — command handlers.
- **`config/system-prompt.md`** — new section explaining to the LLM that during a planned task it should focus on the task brief, write artifacts to the plan directory, and return a one-paragraph summary (not a full chatty response).

---

## Test Plan (sketch)

Unit:
- Planner output schema validation (zod schema, reject malformed plans).
- Topological sort of `depends_on` (handle cycles → reject).
- Panel renderer (compact mode, truncation, edge cases — empty plan, all-failed plan, plan with one task).
- Edit debouncer (verify ≥1500ms between edits, flush on terminal events).
- Runaway cap enforcement (mock plan with maxTasks=2, planner returns 5 → rejected).

Integration:
- Mock Ollama provider returns canned responses → executor walks a 3-task plan to completion → final artifact written.
- Mock provider returns 429 → executor retries 3× with backoff → switches to next model → succeeds.
- Mock provider always 429 → executor pauses, retries, eventually marks task `failed` after total wall time.
- `/cancel` mid-plan: pending tasks marked `skipped`, running task gets abort signal, plan marked `cancelled`.
- Process restart with running plan: on startup, plan is marked `failed` with `error='process restart'` (resume disabled by default).

E2E (manual, against real Telegram):
- DM "research X" → auto-Plan triggers → live panel updates → final report posted.
- Same flow in a group with admin user → works. Same flow with non-admin → rejected with permission message.
- `/plans` shows active + recent.

---

## Open Questions (decide before implementation)

1. **Auto-Plan trigger conservatism.** Default to "trigger only on explicit `/plan` or very obvious patterns"? Or aggressive ("if intent classifier says it's complex, go")? Aggressive is more Manus-like but risks unwanted long runs. Recommend conservative default + a `/plan-auto on|off` toggle.
2. **Per-task timeout vs per-task iteration cap.** Currently spec'd both (wall time cap on the whole plan, iteration cap per task). Add a per-task wall-time cap too? Probably yes (default 120s), to prevent one stuck task from eating the plan budget.
3. **Resume after restart.** Default off (mark running plans `failed` on startup). Could be useful for long research, but needs careful state recovery. Defer to a follow-up.
4. **Cost reporting.** `/cost` today shows session totals. Should planned runs report their token usage separately in the panel? Cheap to add — recommend yes, just append a `Σ in:1.2k out:8.4k` line to the panel.
5. **Group-mode plans.** Plans run with the *creator's* permissions snapshot (captured at `/plan` time). Other group members see the panel update but can't cancel. Document this clearly to avoid confusion.

---

## Non-Goals (explicit)

- We are not building Manus. We're building a Manus-shaped feature inside Jarvis, scoped to the existing tool surface and the existing Telegram UI.
- We are not adding parallel sub-agents in MVP. Sequential execution + good model selection covers most research-style goals.
- We are not adding a planning UI ("preview the plan before running"). The planner runs, the executor runs, the user sees progress. If the user wants control, they cancel and re-issue with more specifics.
- We are not changing the existing agent turn loop's behavior for non-Plan messages. This is purely additive.
