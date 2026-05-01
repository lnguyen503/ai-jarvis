# Jarvis — Folder & Module Structure

Authoritative file layout for Phase 2. Every file listed here must exist after implementation.

```
D:\ai-jarvis\
├── .env                          # secrets, gitignored
├── .env.example                  # template
├── .gitignore                    # node_modules, dist, data, logs, .env
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── README.md
├── config\
│   ├── config.json               # main config (paths, model, limits)
│   ├── config.example.json       # template committed to git
│   └── system-prompt.md          # Claude system prompt
├── data\                         # gitignored
│   └── jarvis.db                 # SQLite, created on first run
├── logs\                         # gitignored
├── docs\
│   ├── ARCHITECTURE.md
│   ├── STRUCTURE.md
│   ├── REQUIREMENTS.md
│   ├── SCOPE.md
│   ├── ANTI-SLOP.md
│   ├── KNOWN_ISSUES.md
│   └── adr\
│       └── 001-initial-architecture.md
├── src\
│   ├── index.ts
│   ├── config\
│   │   ├── index.ts
│   │   ├── schema.ts
│   │   └── resolveEnvRefs.ts
│   ├── logger\
│   │   ├── index.ts
│   │   └── redact.ts
│   ├── memory\
│   │   ├── index.ts
│   │   ├── db.ts
│   │   ├── sessions.ts
│   │   ├── messages.ts
│   │   ├── projects.ts
│   │   ├── memoryStore.ts
│   │   ├── scheduledTasks.ts
│   │   ├── commandLog.ts
│   │   └── migrations\
│   │       ├── index.ts
│   │       └── 001_initial.sql
│   ├── safety\
│   │   ├── index.ts
│   │   ├── paths.ts                # isPathAllowed (C1) + isReadAllowed (C7/C10)
│   │   ├── blocklist.ts            # tokenize + normalize + shape-match (C2, W6)
│   │   ├── scrubber.ts             # secret scrubber, invoked by tools dispatcher (C7/C8)
│   │   └── confirmations.ts        # single-pending, action-id, TTL from config (C6, W5)
│   ├── tools\
│   │   ├── index.ts              # registry, dispatcher, Claude-def adapter
│   │   ├── types.ts              # Tool, ToolContext, ToolResult
│   │   ├── run_command.ts
│   │   ├── read_file.ts
│   │   ├── write_file.ts
│   │   ├── list_directory.ts
│   │   ├── search_files.ts
│   │   └── system_info.ts
│   │   # web_fetch.ts REMOVED from MVP per CP1/C8 + ADR 002 addendum
│   ├── transcriber\
│   │   └── index.ts
│   ├── agent\
│   │   ├── index.ts              # turn() orchestrator
│   │   ├── systemPrompt.ts       # composes from config/system-prompt.md + runtime context
│   │   ├── claude.ts             # Anthropic SDK wrapper + retry
│   │   └── contextBuilder.ts     # history + memory → Claude messages[]
│   ├── scheduler\
│   │   └── index.ts
│   ├── coach\                       # v1.18.0 — Coach Jarvis (active autonomous life-coach agent)
│   │   ├── index.ts                 # orchestration: loadCoachPrompt(), upsertCoachTask, deleteCoachTask, resetCoachMemory, wrapWriteForCoachRun
│   │   │                            # v1.19.0: +loadRecentNudgeHistory(userId, dataDir, itemId, n) for D11 active monitoring
│   │   │                            # v1.20.0: +COACH_MARKER_BY_PROFILE, isCoachMarker, profileFromMarker, migrateLegacyCoachTasks
│   │   ├── coachTools.ts            # the five coach_log_* tools + coach_read_history (zod + dispatchers + audit)
│   │   ├── coachOverrideTool.ts     # v1.19.0 — coach_clear_override tool (D10); extracted from coachTools.ts to keep <500 LOC
│   │   ├── coachMemory.ts           # bounded-FIFO write helper, coachMemoryKey() formatter, listCoachEntriesForItem
│   │   ├── intensityTypes.ts        # CoachIntensity union + COACH_INTENSITIES const + isValidCoachIntensity (v1.19.0: 'auto' added as 5th value)
│   │   ├── userOverrideParser.ts    # v1.19.0 — NL override parser (D3); v1.20.0: thin wrapper around shared textPatternMatcher.ts
│   │   ├── profileTypes.ts          # v1.20.0 NEW (~30 LOC) — COACH_PROFILES closed set + parseHHMM + parseWeeklyDay
│   │   ├── textPatternMatcher.ts    # v1.20.0 NEW (~120 LOC) — extracted shared tokenize + jaccardScore + STOP_WORDS + FUZZY_MATCH_THRESHOLD
│   │   ├── itemStateMonitor.ts      # v1.20.0 NEW (~150 LOC) — D6.a item-state trigger detector
│   │   ├── chatMonitor.ts           # v1.20.0 NEW (~200 LOC) — D6.b chat-pattern trigger detector
│   │   ├── calendarMonitor.ts       # v1.20.0 NEW (~120 LOC) — D6.c calendar-event trigger detector
│   │   ├── triggerFiring.ts         # v1.20.0 NEW (~150 LOC) — shared dispatch + audit emission for spontaneous fires
│   │   ├── rateLimits.ts            # v1.20.0 NEW (~80 LOC) — per-item 4h + global daily cap + quiet mode primitives
│   │   └── coachPrompt.md           # canonical coach prompt template (loaded once at module init)
│   │                                # v1.20.0: adds Step 0.5 + ${trigger_context} placeholder for spontaneous fires
│   │                                # v1.19.0: +Step 0 active monitoring + auto-intensity inference rules (D1, D11) + fatigue policy (D13)
│   ├── calendar\                    # v1.19.0 — two-way Google Calendar sync (ADR 019)
│   │   ├── sync.ts                  # syncItemToCalendar, syncCalendarEventToItem, pollCalendarChanges, ensureJarvisCalendar, removeItemFromCalendar
│   │   ├── syncTypes.ts             # SyncDirection enum, ConflictResolution enum, SyncResult, SyncCursorBody types
│   │   └── syncCursor.ts            # readCursor/writeCursor/resetCursor + 24h corruption-recovery fallback
│   └── gateway\
│       ├── index.ts              # bot startup + wiring
│       ├── allowlist.ts          # middleware
│       ├── commands.ts           # /start /status /stop /projects /history /clear /help
│       ├── chatQueue.ts          # per-chat FIFO queue + AbortController map
│       ├── voice.ts              # voice → transcriber glue
│       └── health.ts             # localhost health server
└── tests\
    ├── unit\                     # per-module unit tests
    ├── integration\              # multi-module flows (agent + tools + memory)
    └── fixtures\                 # sample Claude responses, sample Telegram updates
```

## Module Export Surfaces

### `src/config/index.ts`
```typescript
export type AppConfig = z.infer<typeof ConfigSchema>;
export function loadConfig(): AppConfig;  // sync, throws on invalid; call once at boot
export function getConfig(): AppConfig;   // returns the frozen instance
```

### `src/logger/index.ts`
```typescript
// logger is a typed wrapper (not pino.Logger directly); use child() or logger.child() in modules.
export const logger: {
  instance: pino.Logger;
  child(bindings: Record<string, unknown>): pino.Logger;
  trace(obj: Record<string, unknown> | string, msg?: string): void;
  debug(obj: Record<string, unknown> | string, msg?: string): void;
  info(obj: Record<string, unknown> | string, msg?: string): void;
  warn(obj: Record<string, unknown> | string, msg?: string): void;
  error(obj: Record<string, unknown> | string, msg?: string): void;
  fatal(obj: Record<string, unknown> | string, msg?: string): void;
};
export function child(bindings: Record<string, unknown>): pino.Logger;
// @internal — lifecycle functions for boot sequence only
export function initLogger(): pino.Logger;
export function getLogger(): pino.Logger;
```

### `src/memory/index.ts`
```typescript
export interface MemoryApi {
  sessions: SessionsRepo;
  messages: MessagesRepo;
  projects: ProjectsRepo;
  memory: MemoryRepo;
  scheduledTasks: ScheduledTasksRepo;
  commandLog: CommandLogRepo;
  close(): void;
}
export function initMemory(cfg: AppConfig): MemoryApi;  // opens DB, runs migrations
```
Each repo exposes typed CRUD — e.g. `SessionsRepo.getOrCreate(chatId): Session`, `MessagesRepo.listRecent(sessionId, limit): Message[]`, `CommandLogRepo.insert(row): number`.

### `src/safety/index.ts`
```typescript
export interface SafetyApi {
  isPathAllowed(absPath: string): boolean;             // US-4, C1 — realpath+NFC+casefold+sep-boundary
  isReadAllowed(absPath: string): boolean;             // C7/C10 — path allowed AND not in readDenyGlobs
  classifyCommand(                                      // US-6, C2, W6
    cmd: string,
    shell: 'powershell' | 'cmd' | 'none'
  ): {
    destructive: boolean;
    hardReject: boolean;                                // -EncodedCommand / iex when allowEncodedCommands=false
    matchedRule?: string;
    tokens: string[];                                   // post-tokenization sub-commands inspected
  };
  requireConfirmation(sessionId: number, pending: PendingAction): { actionId: string };
  consumeConfirmation(sessionId: number, userText: string, nowMs?: number): PendingAction | null;
  hasPending(sessionId: number): boolean;
  scrub(text: string): string;                         // C7/C8 — secret scrubber; dispatcher calls on every tool output
}
export function initSafety(cfg: AppConfig, memory: MemoryApi): SafetyApi;
```

### `src/tools/types.ts`
See ARCHITECTURE.md §4 for the `Tool`, `ToolContext`, `ToolResult` signatures.

### `src/tools/index.ts`
```typescript
export function registerTools(deps: ToolDeps): Tool[];
export function toClaudeToolDefs(tools: Tool[]): Anthropic.Tool[];
export function dispatch(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult>;
```

### `src/transcriber/index.ts`
```typescript
export interface Transcriber {
  transcribeVoice(fileUrl: string): Promise<{ text: string; durationMs: number }>;
}
export function initTranscriber(cfg: AppConfig): Transcriber;
```

### `src/agent/index.ts`
```typescript
export interface AgentApi {
  turn(params: {
    chatId: number;
    sessionId: number;
    userText: string;
    abortSignal: AbortSignal;
  }): Promise<{ replyText: string; toolCalls: number }>;
}
export function initAgent(deps: AgentDeps): AgentApi;
```

### `src/scheduler/index.ts`
```typescript
export interface SchedulerApi {
  start(): void;
  stop(): void;
  reload(): void;   // re-read scheduled_tasks from DB
}
export function initScheduler(deps: SchedulerDeps): SchedulerApi;
```

### `src/coach/index.ts` (v1.18.0)
```typescript
export function loadCoachPrompt(): string;                                          // cached read of coach/coachPrompt.md
export interface CoachTaskRow { id: number; cronExpression: string; chatId: number }
export function findCoachTask(memory: MemoryApi, ownerUserId: number): CoachTaskRow | null;
export function upsertCoachTask(deps: { memory: MemoryApi; messagingAdapter: MessagingAdapter; schedulerApi: SchedulerApi }, params: { ownerUserId: number; hhmm: string }): { ok: true; taskId: number; created: boolean } | { ok: false; code: 'INVALID_HHMM' | 'NO_DM_CHAT'; error: string };
export function deleteCoachTask(deps: { memory: MemoryApi; schedulerApi: SchedulerApi }, ownerUserId: number): { ok: true; deleted: boolean };
export function resetCoachMemory(deps: { dataDir: string }, ownerUserId: number): Promise<{ ok: true; deletedCount: number }>;
export function wrapWriteForCoachRun(toolCtx: ToolContext, ownerUserId: number): ToolContext;  // pins write_file path prefix to data/coach/<ownerUserId>/
```

### `src/coach/coachMemory.ts` (v1.18.0)
```typescript
export function coachMemoryKey(itemId: string, eventType: 'lastNudge' | 'research' | 'idea' | 'plan'): string;
export function writeCoachMemoryEntry(params: { userId: number; dataDir: string; itemId: string; eventType: 'lastNudge' | 'research' | 'idea' | 'plan'; body: string; capPerFamily?: number }): Promise<{ ok: true; key: string } | { ok: false; code: string; error: string }>;
export function listCoachEntriesForItem(userId: number, dataDir: string, itemId: string): Promise<MemoryEntry[]>;
export function deleteCoachEntriesForItem(userId: number, dataDir: string, itemId: string): Promise<{ ok: true; deletedCount: number }>;
export const COACH_MEMORY_FAMILY_CAP = 30;
```

### `src/coach/intensityTypes.ts` (v1.18.0; v1.19.0 adds 'auto')
```typescript
// v1.19.0 ADR 019 D1: 'auto' added as 5th value (default for unset items;
// behavior inferred in coach prompt). Static test asserts array length === 5
// AND closed-set duplicate-source-of-truth invariant with organize/validation.ts.
export type CoachIntensity = 'auto' | 'off' | 'gentle' | 'moderate' | 'persistent';
export const COACH_INTENSITIES: readonly CoachIntensity[] = ['auto', 'off', 'gentle', 'moderate', 'persistent'] as const;
export function isValidCoachIntensity(v: unknown): v is CoachIntensity;
```

### `src/coach/userOverrideParser.ts` (v1.19.0 NEW)
```typescript
export type OverrideIntent = 'back_off' | 'push' | 'defer' | 'done_signal';
export interface OverrideDecision {
  itemId: string;
  intent: OverrideIntent;
  expiresAt: string;       // ISO; per-intent (back_off=7d, push=1run, defer=1d, done_signal=1run)
  fromMessage: string;     // scrubbed; ≤256 chars; NUL-banned
  fuzzyScore: number;      // 0..1; > 0.6 required to fire
}
export function parseUserOverride(
  userMessage: string,
  activeItems: { id: string; title: string; updated: string }[],
): OverrideDecision | null;
export const NEGATION_TOKEN_WINDOW = 8;
```

### `src/coach/coachOverrideTool.ts` (v1.19.0 NEW)
```typescript
// Extracted from coachTools.ts to keep coachTools.ts under 500 LOC.
// Coach calls this AFTER consuming a one-shot intent (push, done_signal).
export const coachClearOverrideTool: Tool;
```

### `src/calendar/sync.ts` (v1.19.0 NEW)
```typescript
export interface SyncOpts {
  userId: number;
  item: OrganizeItem;
  memory: MemoryApi;
  config: AppConfig;
  logger: Logger;
}
export function syncItemToCalendar(opts: SyncOpts): Promise<SyncResult>;
export function removeItemFromCalendar(userId: number, itemId: string, memory: MemoryApi, config: AppConfig): Promise<SyncResult>;
export function pollCalendarChanges(userId: number, memory: MemoryApi, config: AppConfig): Promise<{ processed: number; conflicts: number }>;
export function ensureJarvisCalendar(userId: number, memory: MemoryApi, config: AppConfig): Promise<{ ok: true; calendarId: string } | { ok: false; code: string }>;
```

### `src/calendar/syncTypes.ts` (v1.19.0 NEW)
```typescript
export type SyncDirection = 'to_calendar' | 'from_calendar';
export type ConflictResolution = 'webapp_wins' | 'calendar_wins' | 'webapp_wins_tie';
export interface SyncResult {
  ok: boolean;
  direction?: SyncDirection;
  conflictResolution?: ConflictResolution;
  error?: { code: string; message: string };
}
export interface SyncCursorBody {
  lastPolledAt: string;     // ISO
  lastEventEtag: string;    // Google sync token
}
```

### `src/calendar/syncCursor.ts` (v1.19.0 NEW)
```typescript
export function readCursor(userId: number, dataDir: string): Promise<SyncCursorBody | null>;
export function writeCursor(userId: number, dataDir: string, body: SyncCursorBody): Promise<{ ok: true } | { ok: false; code: string }>;
export function resetCursor(userId: number, dataDir: string): Promise<{ ok: true; deleted: boolean }>;
// 24h fallback when cursor is missing/corrupt — used by sync.pollCalendarChanges
export const CORRUPTION_FALLBACK_LOOKBACK_HOURS = 24;
```

### `src/google/calendar.ts` (v1.19.0 extensions)
```typescript
export class CalendarApi {
  // ... existing v1.7.x methods (createEvent, listEvents, updateEvent, deleteEvent)
  // v1.19.0 ADR 019 D8 + D9 additions:
  listCalendars(): Promise<{ id: string; summary: string; primary?: boolean }[]>;
  createCalendar(opts: { summary: string; description?: string; timeZone?: string }): Promise<{ id: string }>;
  // createEvent + updateEvent now accept optional extendedProperties.private.itemId on opts.
}
```

### `src/coach/coachTools.ts` (v1.18.0)
```typescript
export const coachLogNudgeTool: Tool;
export const coachLogResearchTool: Tool;
export const coachLogIdeaTool: Tool;
export const coachLogPlanTool: Tool;
export const coachReadHistoryTool: Tool;
```

### `src/gateway/index.ts`
```typescript
export interface GatewayApi {
  start(): Promise<void>;
  stop(): Promise<void>;
}
export function initGateway(deps: GatewayDeps): GatewayApi;
```

### `src/index.ts`
Boot sequence:
1. `loadConfig()`
2. `initMemory(cfg)`
3. `initSafety(cfg, memory)`
4. `initTranscriber(cfg)`
5. `registerTools({cfg, logger, safety, memory})`
6. `initAgent({cfg, logger, memory, tools, safety})`
7. `initScheduler({cfg, logger, memory, agent, sendFn})`
8. `initGateway({cfg, logger, memory, safety, agent, transcriber, version})` — NOTE: scheduler is NOT passed here; passing it would create a circular dependency (scheduler needs gateway.enqueueSchedulerTurn). Instead, after step 9 the scheduler's send function is injected into the gateway separately.
9. `gateway.start()`
10. Register SIGINT/SIGTERM handlers that call `gateway.stop() → scheduler.stop() → memory.close()`.

## Testing layout

- `tests/unit/safety.paths.test.ts` (C1 + C7/C10 — see ARCH §15.1, §15.2)
- `tests/unit/safety.blocklist.test.ts` (C2/W6 — see ARCH §15.3)
- `tests/unit/safety.confirmations.test.ts` (C6/W5 — see ARCH §15.4)
- `tests/unit/safety.scrubber.test.ts` (C7/C8 — see ARCH §15.5)
- `tests/unit/memory.sessions.test.ts`, `tests/unit/memory.commandLog.test.ts`, `tests/unit/memory.scoping.test.ts` (W3 — §15.7)
- `tests/unit/tools.run_command.test.ts` (execa mocked), `tests/unit/tools.read_file.test.ts`, etc.
- `tests/unit/tools.registry.test.ts` (web_fetch absence — §15.8)
- `tests/unit/config.schema.test.ts` (health.port, readDenyGlobs defaults, allowedPaths boot-fail)
- `tests/integration/agent.turn.test.ts` (Claude mocked, SQLite real in tmp dir)
- `tests/integration/gateway.allowlist.test.ts` (grammY test bot)
- `tests/integration/gateway.queues.test.ts` (C3 — §15.6)
- `tests/integration/confirmation-flow.test.ts`
- `tests/integration/tools.scrub.test.ts` (dispatcher applies scrubber before persist + return — §15.5)
- `tests/integration/coach.tools.test.ts` (v1.18.0 — coach_log_* + coach_read_history; bounded-FIFO cap; sentinel-injection guard inheritance)
- `tests/integration/coach.scheduler.test.ts` (v1.18.0 — `${coach_prompt}` expansion at fire time; load-fail audit + DM)
- `tests/integration/scheduler.coachExpansion.test.ts` (v1.18.0 — non-coach tasks unchanged; coach token ONLY expanded for `__coach__`-marked tasks)
- `tests/integration/webapp.coach.test.ts` (v1.18.0 — coach setup + reset endpoints; intensity PATCH; reserved-description rejection)
- `tests/integration/organize.frontmatter.coach.test.ts` (v1.18.0 — coachIntensity + coachNudgeCount round-trip; legacy items default to 'off' / 0)
- `tests/static/coach-intensity-closed-set.test.ts` (v1.18.0 — closed-set duplicate-source-of-truth invariant; arrays in coach/intensityTypes.ts and organize/validation.ts MUST equal)
- `tests/public/webapp/edit-form.coach.test.ts` (v1.18.0 — Coaching subsection wiring + dropdown values)
- `tests/public/webapp/list-view.coach-badge.test.ts` (v1.18.0 — intensity badge render + Coached-only filter chip)
- `tests/public/webapp/cron.coach.test.ts` (v1.18.0 — Coach badge on `__coach__` rows; Setup + Reset Memory buttons)
- `tests/unit/coach.userOverrideParser.test.ts` (v1.19.0 — NL parser regex set + negation + fuzzy match; T-D3-1 to T-D3-6)
- `tests/integration/calendar.sync.test.ts` (v1.19.0 — round-trip create-edit-delete; conflict resolution; cursor recovery; T-D8-1 to T-D8-5)
- `tests/integration/calendar.sync.no-loop.test.ts` (v1.19.0 — 10 poll cycles after a single PATCH assert exactly 1 calendar write)
- `tests/unit/calendar.syncCursor.test.ts` (v1.19.0 — cursor read/write/reset/corruption-recovery)
- `tests/static/calendar-no-reverse-import.test.ts` (v1.19.0 — `src/organize/**` MUST NOT import from `src/calendar/**`)
- `tests/public/webapp/today-focus-card.test.ts` (v1.19.0 — coach picks render; due-today filter; collapse/expand)
- `tests/public/webapp/calendar-day-view.test.ts` (v1.19.0 — Day view render + drag-reschedule + undo toast)
- `tests/public/webapp/calendar-week-view.test.ts` (v1.19.0 — Week view render + drag-reschedule)
- `tests/public/webapp/coach-banner.test.ts` (v1.19.0 — hub banner show/hide/dismiss/disable wiring)
- `tests/public/webapp/edit-form.coach-advanced.test.ts` (v1.19.0 — `<details>` Advanced disclosure wraps pill picker; current-intensity badge always visible)

## v1.19.0 webapp module map

`public/webapp/organize/` after v1.19.0:

```
public/webapp/organize/
├── app.js                    # 2101 → ~1951 LOC (extractions land it under the 2000 trigger)
├── calendar-view.js          # 552 → ~302 LOC (REPURPOSED to month + dispatcher; week + day extracted)
├── calendar-day-view.js      # NEW ~300 LOC (Day view + DnD + coach activity rail)
├── calendar-week-view.js     # NEW ~280 LOC (Week view + DnD)
├── today-focus-card.js       # NEW ~120 LOC (coach picks + due-today; read-only collapsible card)
├── view-toggle.js            # NEW ~80 LOC (Day/Week/Month/List/Kanban toggle; sessionStorage)
├── kanban-view.js            # unchanged (DnD pattern source)
├── list-view.js              # unchanged
├── detail-panel.js           # unchanged (v1.17.0 boundary)
├── edit-form.js              # +30 LOC (Advanced disclosure wrap of pill picker)
├── markdown.js               # unchanged
├── hierarchy.js              # unchanged
├── dates.js                  # unchanged (UTC-only invariant)
└── diff.js                   # unchanged
```

**Module ownership.** Dev-A owns `src/coach/**`, `src/commands/coachSubcommands.ts`, `src/agent/index.ts` (NL parser invocation only). Dev-B owns `src/calendar/**`, `src/google/calendar.ts` (extensions), `src/scheduler/index.ts` (poll registration), `src/organize/storage.ts` (callback registry hook only). Dev-C owns `public/webapp/organize/**` and `public/webapp/index.html` + `public/webapp/styles.css` deltas. Lead owns `src/index.ts` boot wiring, `docs/`, `CHANGELOG.md`, `package.json` version bump.

Vitest config uses forward-slash paths per `KNOWN_ISSUES.md`.

---

## v1.20.0 module map (multi-coach + event triggers)

Per ADR 020. 7 new files in `src/coach/` + 2 new sibling command files (pre-emptive split per W1).

```
src/coach/
├── profileTypes.ts          # NEW ~30 LOC (D1) — COACH_PROFILES closed set + parsers
├── textPatternMatcher.ts    # NEW ~120 LOC (D10/D16) — shared tokenize + jaccardScore (extracted from userOverrideParser)
├── itemStateMonitor.ts      # NEW ~150 LOC (D6.a) — storage.updateItem post-write callback
├── chatMonitor.ts           # NEW ~200 LOC (D6.b) — agent.turn() post-turn callback
├── calendarMonitor.ts       # NEW ~120 LOC (D6.c) — calendar/sync.ts reverse-sync callback
├── triggerFiring.ts         # NEW ~150 LOC (D7) — gateway-side dispatch + audit emission helper
└── rateLimits.ts            # NEW ~80 LOC (D8) — per-item 4h + global daily cap + quiet mode

src/commands/
├── coachSubcommands.ts      # Δ -255 LOC after pre-emptive split (post-split ~365 LOC)
├── coachQuietCommands.ts    # NEW ~150 LOC — /coach quiet set/status/off (extracted commit 0d)
└── coachProfileCommands.ts  # NEW ~140 LOC — /coach setup [profile]/off/status (extracted commit 0d)
```

**Public surfaces** (binding):

```ts
// src/coach/profileTypes.ts
export const COACH_PROFILES: readonly ['morning', 'midday', 'evening', 'weekly'];
export type CoachProfile = typeof COACH_PROFILES[number];
export function isCoachProfile(v: unknown): v is CoachProfile;
export function parseHHMM(s: string): { ok: true; hour: number; minute: number } | { ok: false };
export function parseWeeklyDay(s: string): { ok: true; day: 0|1|2|3|4|5|6 } | { ok: false };

// src/coach/index.ts (extensions)
export const COACH_MARKER_BY_PROFILE: Record<CoachProfile, string>;
export const COACH_MARKER_PREFIX: '__coach_';
export const COACH_MARKER_SUFFIX: '__';
export function isCoachMarker(description: string): boolean;
export function profileFromMarker(description: string): CoachProfile | null;
export function migrateLegacyCoachTasks(memory: MemoryApi): { rewrittenCount: number; skippedCount: number };
export const COACH_TRIGGER_CONTEXT_PLACEHOLDER: '${trigger_context}';
export function expandCoachPromptToken(command: string, triggerContext?: string): string;
export function findCoachTaskByProfile(memory: MemoryApi, userId: number, profile: CoachProfile): ScheduledTask | null;
export function upsertCoachTaskByProfile(memory: MemoryApi, userId: number, chatId: number, profile: CoachProfile, cronExpression: string): number;

// src/coach/textPatternMatcher.ts
export const STOP_WORDS: ReadonlySet<string>;
export const FUZZY_MATCH_THRESHOLD: 0.7;
export function tokenize(text: string): string[];
export function jaccardScore(titleTokens: string[], phraseTokens: string[]): number;
export function fuzzyMatchItem(text: string, items: OrganizeItem[]): { item: OrganizeItem; score: number } | null;

// src/coach/triggerFiring.ts
export interface TriggerRecord { source, triggerType, itemId, reason, fromMessageHash?, detectedAt };
export type SuppressionReason = 'PER_ITEM_BACKOFF' | 'GLOBAL_DAILY_CAP' | 'QUIET_ACTIVE' | 'DEBOUNCE' | 'FATIGUE' | 'BACK_OFF_OVERRIDE';
export function dispatchTrigger(deps, trigger: TriggerRecord): Promise<{ fired: true } | { fired: false; reason: SuppressionReason }>;

// src/coach/itemStateMonitor.ts
export function notifyItemStateChange(userId: number, item: OrganizeItem): void;
// (registered as the post-write callback at boot)

// src/coach/chatMonitor.ts
export function processChatMessage(userId: number, chatId: number, userMessage: string, items: OrganizeItem[]): void;

// src/coach/calendarMonitor.ts
export function inspectCalendarEvent(userId: number, item: OrganizeItem, eventMetadata: { recurringEventId?: string; description?: string; start: string }): void;

// src/coach/rateLimits.ts
export const PER_ITEM_RATE_WINDOW_MS: 14_400_000;
export const GLOBAL_DAILY_CAP: 3;
export async function checkPerItemRate(userId, dataDir, itemId, nowMs): Promise<{ ok: true } | { ok: false; reason: 'PER_ITEM_BACKOFF'; retryAfterMs: number }>;
export async function checkGlobalDailyRate(userId, dataDir, todayYYYYMMDD): Promise<{ ok: true } | { ok: false; reason: 'GLOBAL_DAILY_CAP'; current: number; cap: number }>;
export async function checkQuietMode(userId, dataDir, nowMs): Promise<{ ok: true } | { ok: false; reason: 'QUIET_ACTIVE'; quietUntilIso: string }>;
export async function recordPerItemFire(userId, dataDir, itemId, nowIso): Promise<void>;
export async function recordGlobalDailyFire(userId, dataDir, todayYYYYMMDD): Promise<void>;
export async function setQuietUntil(userId, dataDir, untilIso): Promise<void>;
export async function clearQuietMode(userId, dataDir): Promise<void>;
export function parseQuietDuration(input: string, nowIso: string): { ok: true; untilIso: string } | { ok: false; error: string };
```

**Tests added in v1.20.0:**

- `tests/static/coach-event-wiring.test.ts` (Pillar 3 trap-class lint; commit 0a)
- `tests/static/coach-profile-closed-set.test.ts` (D1)
- `tests/static/coach-textpattern-shared.test.ts` (D16 §6 single-source)
- `tests/static/coach-named-constants-single-source.test.ts` (extended for 4 new markers)
- `tests/integration/coach.multi-profile.test.ts` (D2/D3 — multi-profile fire dispatch)
- `tests/integration/coach.event-trigger.test.ts` (D6/D7 — full spontaneous fire flow)
- `tests/integration/coach.rate-limits.test.ts` (D8 — per-item, daily cap, quiet mode)
- `tests/integration/coach.migration.test.ts` (D2 migration idempotency)
- `tests/unit/coach.profileTypes.test.ts`, `tests/unit/coach.textPatternMatcher.test.ts`, `tests/unit/coach.rateLimits.test.ts`, `tests/unit/coach.chatMonitor.test.ts`, `tests/unit/coach.itemStateMonitor.test.ts`, `tests/unit/coach.calendarMonitor.test.ts`
- `tests/public/webapp/cron.multi-coach.test.ts` (D18 webapp UI)
- `tests/public/webapp/today-focus-card.spontaneous.test.ts` (D19 activity feed)
- `tests/public/webapp/hub-banner.multi-profile.test.ts` (D20 banner upgrade)

**Module ownership (v1.20.0):**
- Dev-A: `src/coach/profileTypes.ts`, `src/coach/textPatternMatcher.ts` (extraction), `src/commands/coach*.ts`, refactor commits 0c + 0d.
- Dev-B: `src/coach/itemStateMonitor.ts`, `chatMonitor.ts`, `calendarMonitor.ts`, `triggerFiring.ts`, `rateLimits.ts`, gateway path, prompt extension, boot wiring (commits 5–12).
- Dev-C: `public/webapp/cron/app.js` multi-coach UI, `today-focus-card.js` activity feed, `app.js` hub banner (commits 13–15).
- Lead: docs (ARCHITECTURE.md §20, STRUCTURE.md, KNOWN_ISSUES.md, CLAUDE.md), boot orchestration in `src/index.ts`, version bump, static-test scaffold (commit 0a), institutional memory (commit 0b), release commit 17.

---

## v1.21.0 module map (Avengers MVP — multi-bot identity)

Per ADR 021. 6 new files in `src/` + 2 new persona files + 2 new ops files. Each pm2 process resolves `BotIdentity` at boot from `BOT_NAME` env; identity fans out to data dir, persona, tool allowlist, webapp port.

```
src/config/
├── botIdentity.ts          # NEW ~80 LOC (D1) — BOT_NAMES closed set + resolveBotIdentity + SPECIALIST_TOOL_ALLOWLIST
├── botPaths.ts             # NEW ~60 LOC (D17) — resolveBotDataPath SSOT helper
├── botMigration.ts         # NEW ~120 LOC (D3) — legacy data/ → data/<botName>/ migration; persona file copy
└── dataDir.ts              # unchanged at HEAD; back-compat thin wrapper (routes through botPaths)

src/gateway/
├── mentionRouter.ts        # NEW ~120 LOC (D7 + D8) — isMentionedByUsername (structured-entity) + self-message echo drop
├── interBotContext.ts      # NEW ~80 LOC (D9) — wrapInterBotMessage with <from-bot name="..."> boundary
└── loopProtection.ts       # NEW ~80 LOC (D10) — checkAndIncrementBotTurn; MAX_BOT_TO_BOT_TURNS_PER_THREAD = 3

src/safety/paths.ts          # +30 LOC — wrapPathForBotIdentity helper (D4); narrows allowedPaths per bot
src/agent/systemPrompt.ts    # +20 LOC — accepts BotIdentity; reads from identity.personaPath
src/tools/index.ts           # +40 LOC — specialist allowlist gate (D6) before existing dispatcher gates
src/tools/types.ts           # +5 LOC — botIdentity?: BotIdentity on ToolContext
src/memory/auditLog.ts       # +6 LOC — 6 new audit categories (D18)
src/index.ts                 # +30 LOC — resolveBotIdentity → migration → identity-into-systemPrompt → wrapPathForBotIdentity → identity_resolved audit
src/webapp/botIdentityRoute.ts  # NEW ~30 LOC (D15) — GET /api/webapp/bot/identity

config/
├── personas/
│   ├── ai-jarvis.md        # NEW (D5; copy of legacy config/system-prompt.md) ~224 LOC
│   └── ai-tony.md          # NEW (D5) ~80 LOC — specialist persona for engineering/build/code
└── avengers.json           # NEW (D9) ~15 LOC — KNOWN_BOTS_BY_USERNAME map (Telegram username → BotName)

ecosystem.config.cjs         # NEW (D11) ~20 LOC — pm2 apps[]: ai-jarvis + ai-tony
docs/AVENGERS.md             # NEW (Pillar 3 runbook) ~150 LOC — operator runbook: pm2 ops + tunnel setup + bot creation

public/webapp/app.js         # +30 LOC (D15) — hub banner identity fetch + render
```

**Public surfaces** (binding):

```ts
// src/config/botIdentity.ts
export const BOT_NAMES: readonly ['ai-jarvis', 'ai-tony'];
export type BotName = typeof BOT_NAMES[number];
export type BotScope = 'full' | 'specialist';
export interface BotIdentity {
  name: BotName;
  scope: BotScope;
  telegramToken: string;     // resolved from BOT_TOKEN_<NAME> env
  botUsername: string;       // resolved from getMe at boot; cached
  personaPath: string;       // absolute path
  webappPort: number;
  healthPort: number;
}
export function isBotName(v: unknown): v is BotName;
export function resolveBotIdentity(envBotName: string | undefined): { ok: true; identity: BotIdentity } | { ok: false; error: string };
export function personaPathFor(name: BotName): string;
export function dataDirFor(name: BotName): string;
export function webappPortFor(name: BotName): number;
export function healthPortFor(name: BotName): number;
export const SPECIALIST_TOOL_ALLOWLIST: ReadonlySet<string>;  // closed set, size 10

// src/config/botPaths.ts
export function resolveBotDataPath(identity: BotIdentity, ...subpath: string[]): string;
export function resolveBotDbPath(identity: BotIdentity): string;
export function resolveBotOrganizePath(identity: BotIdentity, userId?: number): string;
export function resolveBotCoachPath(identity: BotIdentity, userId?: number): string;
export function resolveBotCalendarPath(identity: BotIdentity, userId?: number): string;
export function resolveGoogleTokensPath(identity: BotIdentity): string;
export function resolveBotWorkspacesPath(identity: BotIdentity, chatId?: number): string;

// src/config/botMigration.ts
export interface MigrationResult { migrated: boolean; subjects: Array<{ subject: string; fromPath: string; toPath: string }>; conflicts: Array<{ subject: string; legacyPath: string; newPath: string }> }
export async function runBotDataMigration(identity: BotIdentity): Promise<MigrationResult>;
export async function runPersonaMigration(identity: BotIdentity): Promise<{ migrated: boolean; from?: string; to?: string }>;

// src/safety/paths.ts (extension)
export function wrapPathForBotIdentity(identity: BotIdentity, configAllowedPaths: string[]): string[];

// src/gateway/mentionRouter.ts
export function isMentionedByUsername(ctx: Context, botUsername: string): boolean;
export interface SelfMessageRecord { messageId: number; chatId: number; sentAt: string }
export async function recordOutgoingMessage(userId: number, dataDir: string, record: SelfMessageRecord): Promise<void>;
export async function isOurEcho(userId: number, dataDir: string, chatId: number, messageId: number): Promise<boolean>;
export const SELF_MESSAGE_FIFO_CAP: 20;
export const SELF_MESSAGE_TTL_MS: 3_600_000;  // 1h

// src/gateway/interBotContext.ts
export interface InterBotMessageMeta { fromBotName: string; rawText: string; messageId: number }
export function wrapInterBotMessage(meta: InterBotMessageMeta): string;
export const INTER_BOT_TEXT_CAP: 4096;

// src/gateway/loopProtection.ts
export const MAX_BOT_TO_BOT_TURNS_PER_THREAD: 3;
export const LOOP_PROTECTION_TTL_MS: 3_600_000;  // 1h
export async function checkAndIncrementBotTurn(userId: number, dataDir: string, threadKey: string): Promise<{ ok: true; count: number } | { ok: false; reason: 'LOOP_PROTECTION'; count: number }>;
export async function resetThreadCounter(userId: number, dataDir: string, threadKey: string): Promise<void>;
export function deriveThreadKey(message: { message_thread_id?: number; message_id: number }): string;

// src/agent/systemPrompt.ts (extension)
export function buildSystemPrompt(cfg: AppConfig, identity: BotIdentity): string;  // reads from identity.personaPath; replaces hardcoded config/system-prompt.md

// src/tools/types.ts (extension)
export interface ToolContext {
  // ... existing fields
  botIdentity?: BotIdentity;  // populated at boot for production calls; tests may omit
}

// src/webapp/botIdentityRoute.ts
export function buildBotIdentityRoute(identity: BotIdentity): RequestHandler;
// GET /api/webapp/bot/identity → { botName, scope, webappPort } — NO token, NO sensitive data
```

**Audit categories added in v1.21.0** (closed-set count 51 → 57; D18):

```
'bot.identity_resolved'      — boot-time identity announce (token NEVER in detail JSON)
'bot.tool_unauthorized'      — dispatcher rejected an out-of-allowlist tool for specialist scope
'bot.loop_protection.engaged' — 4th bot-to-bot turn dropped
'bot.migration_completed'    — legacy data/ → data/<botName>/ migration succeeded per subject
'bot.migration_conflict'     — both legacy + new path exist (idempotency edge)
'bot.self_message_dropped'   — rate-limited 1/chat/hour; self-echo drop forensics
```

**Tests added in v1.21.0:**

- `tests/static/bot-identity-no-stub.test.ts` (commit 0a; D16; 5th-iter trap class fix; rejects identity stubs at boot)
- `tests/static/bot-data-path-centralization.test.ts` (commit 0b; D17; rejects ad-hoc `data/...` strings outside botPaths.ts)
- `tests/static/bot-identity-closed-set.test.ts` (commit 1; D1 + D6; asserts `BOT_NAMES.length === 2` AND `SPECIALIST_TOOL_ALLOWLIST.size === 10`)
- `tests/static/bot-migration-ordering.test.ts` (commit 3; D3; asserts `runBotDataMigration` precedes `initMemory` in src/index.ts)
- `tests/static/chat-monitor-bot-guard.test.ts` (commit 10; v1.20.0 chatMonitor extension; rejects when message.from.is_bot === true)
- `tests/integration/bot-mention-routing.test.ts` (commit 8; D7)
- `tests/integration/bot-tool-allowlist.test.ts` (commit 6; D6)
- `tests/integration/bot-context-wrap.test.ts` (commit 10; D9)
- `tests/integration/bot-loop-protection.test.ts` (commit 11; D10)
- `tests/integration/bot-sandbox-isolation.test.ts` (commit 4; D4; cross-bot read rejection)
- `tests/integration/bot-migration.test.ts` (commit 3; idempotency + conflict path)

**Module ownership (v1.21.0):**
- Dev-A: Pillar 1 — `src/config/botIdentity.ts`, `botPaths.ts`, `botMigration.ts`; `src/safety/paths.ts` extension; `src/agent/systemPrompt.ts` extension; `src/tools/index.ts` allowlist gate; `src/tools/types.ts` ToolContext; `src/memory/auditLog.ts` audit categories; `config/personas/ai-jarvis.md` (copy) + `ai-tony.md` (NEW). Commits 1–7.
- Dev-B: Pillar 2 — `src/gateway/mentionRouter.ts`, `interBotContext.ts`, `loopProtection.ts`; `src/gateway/groupGate.ts` extension; `src/gateway/index.ts` chat-receive path; `src/agent/contextBuilder.ts` `<from-bot>` integration; `src/index.ts` boot wiring. Commits 8–12.
- Dev-C: Pillar 3 + 4 — `ecosystem.config.cjs`, `config/avengers.json`, `docs/AVENGERS.md`, `.env.example`; `src/webapp/botIdentityRoute.ts`; `public/webapp/app.js` hub banner. Commits 13–15.
- Lead: docs (ARCHITECTURE.md §21, STRUCTURE.md v1.21.0 module map, KNOWN_ISSUES.md, CLAUDE.md), version bump, static-test scaffolds (commits 0a + 0b), institutional memory (commit 0c), chore commit 16, release commit 17.
