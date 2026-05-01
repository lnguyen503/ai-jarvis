# ADR 003 — /organize Feature (Chat-native Task / Event / Goal Organizer)

**Status:** Proposed (Phase 1, v1.8.6)
**Date:** 2026-04-24
**Deciders:** Architect Agent (iteration)
**Supersedes:** none. Extends ADR 001 (module boundaries, storage philosophy) and piggy-backs on the `CalendarApi` surface introduced for `calendar_create_event`.

This ADR records the architectural decisions for the `/organize` feature — a chat-native task / event / goal organizer surfaced through Telegram. The feature adds one slash command, six agent tools, one active-items system-prompt injection, one new module (`src/organize/`), and two narrowly-scoped additions to `CalendarApi`. Each decision uses the Status / Context / Decision / Consequences format used by ADR 001 and ADR 002.

Scope of this ADR is design only — no code is in scope here. The Developer agents that implement `/organize` in Phase 2 of this iteration MUST NOT deviate from the decisions below without a follow-up ADR addendum.

---

## 1. File-based markdown storage (not SQLite)

**Status:** Accepted.

**Context.** `/organize` items are small (title + due + notes + progress log + a handful of fields). They are written from chat, read from chat, and — critically — the user has explicitly asked for the same "hand-editable, file-on-disk" posture `userMemory.ts` already provides. The two existing storage shapes in Jarvis are:

  - **SQLite (`data/jarvis.db`)** — `sessions`, `messages`, `command_log`, `scheduled_tasks`, `audit_log`. Used for structured, high-write, query-heavy data.
  - **Per-user markdown (`data/memories/<userId>.md`)** — a single file per user, YAML-free, human-readable, atomic write-then-rename. Used for long-lived profile context that the user wants to be able to open in an editor and manipulate.

`/organize` sits on the second shape. There is no query surface we need beyond "list active items for userId filter by type/tag/status." A table would let us add indexes later, but we'd pay for it upfront with schema migrations, ORM-ish code, a repo class, and the fact that the user cannot `read_file` a SQLite row from inside Telegram.

**Decision.** One markdown file per item at `data/organize/<userId>/<itemId>.md`. Each file has a YAML-ish front-matter block bounded by `---` fences (hand-parsed; no `js-yaml` dependency — we already refuse new dependencies per the iteration brief) followed by a free-form body. The front-matter contains only small scalar fields: `id`, `type`, `status`, `title`, `created`, `due`, `parentId`, `calendarEventId`, `tags`. The body has two H2 sections: `## Notes` (free markdown) and `## Progress` (append-only bullet list of dated entries). No third H2 is permitted — the parser stops caring after the second.

**Consequences.**

  - **Positive.** Mirrors `userMemory.ts` almost exactly. Atomic writes via temp-then-rename reuse the pattern from `userMemory.writeAtomically`. Users can `read_file` their own organize items from chat. Manual edits (e.g. the user fixes a typo in `notes` from VS Code) work without schema migration.
  - **Positive.** Listing is an `fs.readdir(data/organize/<userId>)` — O(N) in items for that user, and we cap at 200 active items so the worst case is a ~200-file scan per `organize_list` call. On a modern SSD that is sub-10ms and, crucially, the listing happens only on explicit tool call or `/organize`. The per-turn active-items injection reads the same directory (decision 3 caps the cost).
  - **Negative.** Cross-item queries (e.g. "how many tasks due this week across all users") are N-file scans. Out of scope for v1 — Jarvis is a personal assistant; multi-user aggregate queries do not exist.
  - **Negative.** Hand-editable files create a race: the user could edit `notes` in an editor while `organize_update` is rewriting the file. Mitigation: atomic temp-then-rename on the tool side (last writer wins; no torn writes). We accept "user-in-editor loses their unsaved change if Jarvis writes during it" as documented behavior — same posture as `userMemory.ts`.

---

## 2. Privacy filter — narrowed health posture for `/organize` (separate from memory)

**Status:** Accepted.

**Context.** `src/memory/userMemoryPrivacy.ts` rejects a broad set of health-specific terms (`HIV`, `AIDS`, `cancer`, `diabetes`, `depression`, `anxiety`, `bipolar`, `schizophrenia`, `tumor`, `chemotherapy`, `prescription`). That posture is correct for `update_memory` — memory is a long-lived profile, the LLM doesn't need disease context to respond well, and the cost of a false-accept (persisting "Boss is HIV+" to disk forever) is high.

For `/organize` the posture is different. The user has explicitly asked for goals like "Lose 10 lbs by summer" and tasks like "20-minute walk after dinner" to work. Those strings contain `lbs` and `walk`, which are not in the memory blocklist, but they are symptomatic of a feature class — personal-fitness goals — that is adjacent to the health vocabulary. If the organize privacy filter evolves by copy-paste from memory privacy, those use cases will break.

The risk tradeoff: narrowing health rejection for organize makes it easier to accidentally persist a disease-specific item (`"schedule chemo next Tuesday"`). That item then lives on disk for as long as the user doesn't delete it, is re-emitted into the system prompt on every turn while active, and appears in audit logs.

**Decision.** Create `src/organize/privacy.ts` — a *new* module, not an import from `userMemoryPrivacy.ts`. The organize filter:

  1. Re-uses the safety scrubber from `src/safety/scrubber.ts` for credential shapes (`sk-ant-…`, PEMs, PATs, bearer tokens, long hex blobs). Same posture as memory privacy — no reason to diverge.
  2. Keeps (copied, not imported): phone-US-international, SSN, credit-card shape, password-like, URL-with-token, financial-specifics, 40+ char opaque-token heuristic.
  3. **Keeps email rejection EXCEPT in the `attendees` field of `organize_create` for type=event**, where attendees is an array input whose element shape is *specifically* `z.string().email()` and the email shape is expected. The filter is applied per-field; `attendees[i]` is exempted from the email-rejection rule but still runs through length cap and scrubber. No other field exempts emails.
  4. **Narrows health rejection to a disease/prescription list that EXCLUDES general fitness/nutrition terms.**

     **Still reject** (case-insensitive word-boundary match): `HIV`, `AIDS`, `cancer`, `tumor`, `chemotherapy`, `chemo`, `radiation therapy`, `diabetes`, `insulin`, `depression`, `anxiety disorder`, `bipolar`, `schizophrenia`, `prescription`, `diagnosis`, `diagnosed`, `medication` followed by a brand-name-shaped token, plus an explicit drug-name seed list: `adderall`, `xanax`, `prozac`, `zoloft`, `lexapro`, `oxycontin`, `vicodin`, `ativan`, `klonopin`, `ambien`, `lithium`, `ritalin`. Seed list lives in a constant at the top of `src/organize/privacy.ts`; if the user ever tunes it, we tune it there, not scattered.

     **Allow explicitly** (i.e. the health rejection regex is written to NOT match these): `lose weight`, `weight loss`, `lbs`, `kg`, `pounds`, `fitness`, `exercise`, `workout`, `walk`, `walking`, `run`, `running`, `jog`, `diet`, `nutrition`, `cardio`, `gym`, `yoga`, `meditation`, `meditate`, `sleep`, `hydration`, `hydrate`, `stretch`, `stretching`. These appear in goal titles; rejecting them breaks the feature.

  5. Field-specific length caps instead of one global 500-char cap:
     - `title`: 500 chars (same as memory per-fact cap).
     - `notes`: 5000 chars. Notes are the long-form section; a hard 500-char cap would make users stuff context into filenames.
     - `progress entry`: 500 chars. A progress line is "on 2026-04-24, noted X" — if the user has 5000 chars to say, they should edit `notes` or create a new item.
     - Each `tag`: 40 chars. Tags are labels, not essays.
     - Max `10` tags per item. Tags are a tagging system, not a notes field.
  6. Per-user cap: **max 200 active items**. `organize_create` checks the active-count before persisting; on overflow the tool returns `{code: 'ACTIVE_CAP_EXCEEDED', output: 'You have 200 active items — complete or delete some before creating new ones.'}`. 200 is larger than any realistic personal-task list, small enough that the per-turn listing cost (decision 3) stays bounded, and a clean integer for audit clarity.

**Consequences.**

  - **Positive.** Legitimate fitness goals work. "Lose 10 lbs by summer", "20-minute walk after dinner", "30 min yoga Mon/Wed/Fri" all pass the filter and persist.
  - **Positive.** Disease-specific items still reject with a user-visible reason ("contains terms we don't store in organize — diseases/prescriptions/medical terms stay in chat, not on disk").
  - **Negative (deliberate tradeoff).** A user who writes `"walk 30 min to manage blood pressure"` will have the string persisted (no `blood pressure` keyword in the narrowed blocklist). If we add `blood pressure`, we break a legitimate wellness goal. We accept the narrower posture as the explicit user-requested design; if the seed list proves too narrow in practice, we tune it via a future ADR addendum and update the `src/organize/privacy.ts` seed list — single source of truth.
  - **Negative.** The organize filter and memory filter will drift. That's intentional — they serve different functions — but it requires ongoing vigilance during review. The Anti-Slop Reviewer (Section 9) must check both filters on any change to either.
  - **Negative.** A non-obvious cross-tool bypass: the user could ask `update_memory` to persist a forbidden health term (gets rejected) and then ask `organize_create` to persist the same thing (might go through). Mitigation: document in the user-visible refusal that organize has its own narrower posture, so the user knows rephrasing is not a bypass of memory privacy, it is an explicit feature of organize.

---

## 3. Active-items injection — location, cap, ordering

**Status:** Accepted.

**Context.** The user wants the agent to "always know what's open" without having to ask. In the existing architecture, `src/agent/index.ts` builds the system prompt per-turn; memory is injected at lines 439–461, right before the tool-filter section at line 466. Injecting active items in the same style is the minimally-disruptive placement. Two open questions:

  1. **Where exactly in the system prompt.** Before memory? After memory? The answer affects prompt caching: we want everything that changes infrequently at the top (cached) and everything that changes often at the bottom (not cached). Memory is comparatively stable; organize items turn over faster. So organize items go AFTER memory.
  2. **How much to inject.** A user with 200 active items cannot have all 200 in the prompt — that is prompt-bloat, cache-invalidation on every change, and token cost unrelated to the turn's value.

**Decision.** After the memory-injection block in `src/agent/index.ts` (immediately after line 461, before the tool-filter section at line 466), and BEFORE any tool-enabled checks that might filter organize tools out of the list, inject a `## Your open items` section when both of the following are true:

  - `params.userId` is defined AND `Number.isFinite(params.userId)` (same guard as memory injection).
  - The turn is not in group mode (see decision 7).

The injection calls `listActiveItems(userId, dataDir)` from `src/organize/injection.ts`. That function:

  1. Reads `data/organize/<userId>/*.md`, skipping the `.trash/` subdir.
  2. Parses front-matter only (skips body — body can be large; we don't need it for the one-line injection).
  3. Drops items with `status !== 'active'`.
  4. Sorts: goals pinned first (any item with `type==='goal'`), then remaining items sorted by `due` ascending (ISO-string compare is correct for our YYYY-MM-DD / ISO-datetime shapes because both lex-sort and time-sort agree), items with no `due` sorted last.
  5. Caps at 15 items. If >15 active items exist after sort, it shows the 15 most-recently-updated (by file `mtime`) instead of the 15-by-due — because "most recent churn" is the better heuristic for "what's top-of-mind" when the user has a lot active — and appends `_(+N more — ask me to list them)_` so the LLM knows the cap was hit.
  6. Renders each item as `- [type] title — due <date if any> (<id>)` with goal-pinned items prefixed `- [goal] ⚑ title — due …`. Progress log and notes are NOT included — the LLM can call `organize_list` or `read_file` if it needs detail.

**Cap rationale — why 15.** A 15-item list is ~15 × 80 chars = 1200 chars of prompt. Compared to the ~4–8K char system prompt base, that's a 15–30% bump — acceptable. At 30 items we're at 2400 chars and starting to crowd memory and Security Rules. 15 is the knee of the curve.

**Failure mode.** If the directory doesn't exist or a file is malformed, the injection logs a warning and proceeds WITHOUT the injection (same posture as memory injection). An individual malformed item file logs a warning, is skipped, and does NOT block the other items — tolerant parsing (decision 8).

**Consequences.**

  - **Positive.** The LLM has context on what's open without the user having to ask every turn. Goals get top-of-mind treatment (pinned). Recent churn stays visible even at the cap.
  - **Positive.** Anthropic prompt caching keeps the injection "free" after the first turn of a session as long as active items haven't changed. Any `organize_*` write invalidates the cache for subsequent turns — acceptable, the user just created/changed an item, so cache-miss is deserved.
  - **Negative.** Every turn does a `readdir` and up to 200 front-matter reads. At 200 items that's ~200 × small-file-read on an SSD — measured at <20ms in similar shapes. Still, we cap at 200 (decision 2) and the work is per-user not per-chat, so group chats with 20 members don't stack 4000 file reads.
  - **Negative.** A user who wants zero injection can't turn it off individually without adding a toggle. v1 does not ship a toggle — if the user wants to disable it they can `/organize off` (subcommand added in Phase 5 of this iteration). Out of scope for the ADR; noted for the slash-command design.

---

## 4. Soft-delete via `.trash/` subdirectory (not hard delete, not `status=trashed`)

**Status:** Accepted.

**Context.** Three delete shapes were considered:

  - (a) **Hard delete** — `fs.unlink` on the markdown file. Irreversible. User mistakes are permanent.
  - (b) **`status=trashed` front-matter flag** — the item stays in `data/organize/<userId>/` but the listing filters it out. Reversible, but every listing now has to scan trashed items too (slower, larger cache surface).
  - (c) **Move to `.trash/` subdirectory** — `fs.rename` into `data/organize/<userId>/.trash/<itemId>.md`. Reversible, listing naturally ignores `.trash/` (it's a hidden dir convention), no per-file overhead on the hot path.

**Decision.** (c) soft-delete via `.trash/` subdirectory.

  - `organize_delete` calls `fs.rename(data/organize/<userId>/<id>.md, data/organize/<userId>/.trash/<id>.md)`. The `.trash/` directory is created on demand.
  - `organize_list` and the active-items injection skip the `.trash/` directory (explicit check in `listItems()` and `listActiveItems()`: if the filename/dir contains `.trash`, skip).
  - No automatic trash eviction in v1. The user can manually delete `.trash/` via a future `/organize empty-trash` subcommand (not in scope for this iteration).
  - If a `.trash/<id>.md` already exists (unlikely but possible — collision after recreate-then-delete-then-same-id), append a timestamp suffix: `.trash/<id>--<unix-ms>.md`. Preserves both.
  - **GCal side.** If the item has a `calendarEventId`, `organize_delete` calls `CalendarApi.deleteEvent` BEFORE the rename (see decision 6 for failure semantics). The soft-delete does NOT write `calendarEventId: null` into the trashed file — the trashed file preserves its original front-matter so a future "undelete" command has everything it needs.

**Consequences.**

  - **Positive.** Mistakes are recoverable for the foreseeable future. "I accidentally deleted my home-reno goal" is a `mv data/organize/<id>/.trash/<file> data/organize/<id>/` away (or a future undelete tool).
  - **Positive.** Listing hot path stays fast — one directory read, no per-file front-matter peek to check `status=trashed`.
  - **Negative.** Disk usage grows without bound. For a personal assistant this is a rounding error (~1KB per trashed item × thousands = single-digit MB), but we document the growth and leave eviction to a future iteration.
  - **Negative.** The trashed file still contains the item's content. If the item had "sensitive" content that the user wants really-deleted, the soft-delete is not enough. Document this in the slash-command help text: "`/organize delete` soft-deletes. For a permanent wipe, use `/organize purge <id>`" (purge is a future v1.x addition; not in this iteration).

---

## 5. `CalendarApi` extension — `updateEvent` + `deleteEvent` scoped to /organize's needs

**Status:** Accepted.

**Context.** `CalendarApi` (in `src/google/calendar.ts`) currently has `createEvent` and `listEvents`. `/organize` needs `updateEvent` (to sync on `organize_update` when relevant fields change) and `deleteEvent` (for `organize_delete` when `calendarEventId` is set). Two options:

  - (a) **Extend `CalendarApi` with narrow methods.** Keep the module boundary clean — organize imports `src/google/calendar.js`, not `googleapis` directly. Rationale: the existing downstream TODO (see `src/tools/calendar_create_event.ts` line 8 comment: "Update / delete are separate tools") already calls for standalone `calendar_update_event` / `calendar_delete_event` tools. This iteration lays the groundwork; the standalone tools become a 50-line wrapper in a later iteration.
  - (b) **Keep `CalendarApi` unchanged; use `googleapis` directly in the organize tool.** Rejected — breaks module isolation (Anti-Slop §5 Separation of Concerns, §13 Module Isolation). `organize` would depend on `googleapis` and duplicate the auth-and-normalization logic.

**Decision.** (a). Extend `CalendarApi` with two methods, scoped narrowly to the fields `/organize` uses.

### TypeScript signatures

```typescript
// Add to src/google/calendar.ts alongside CreateEventOptions.

export interface UpdateEventOptions {
  calendarId: string;
  eventId: string;
  /** PATCH-style: only fields present are changed. undefined = leave as-is. null = not accepted (use empty string if you want to clear a description). */
  summary?: string;
  startTime?: string;          // same rules as CreateEventOptions
  endTime?: string;
  allDay?: boolean;            // if toggled, start/end must also be provided in the matching shape
  description?: string;
  location?: string;
  attendees?: string[];        // full replace semantics — omitting = leave as-is; [] = clear
  timeZone?: string;
  notificationLevel?: 'NONE' | 'EXTERNAL_ONLY' | 'ALL';
}

export interface DeleteEventOptions {
  calendarId: string;
  eventId: string;
  notificationLevel?: 'NONE' | 'EXTERNAL_ONLY' | 'ALL';
}

export class CalendarApi {
  // … existing createEvent, listEvents …

  /**
   * Patch an existing event. Uses the Google events.patch API so only the
   * supplied fields are changed server-side. Returns the normalised updated
   * event or throws on API failure.
   *
   * Scope: the fields /organize currently syncs (summary, start/end,
   * allDay, description, location, attendees, timeZone). Other event
   * properties (reminders, colorId, recurrence) are deliberately not
   * exposed — /organize doesn't touch them and adding them here widens
   * the surface without a caller.
   */
  async updateEvent(opts: UpdateEventOptions): Promise<CalendarEventSummary>;

  /**
   * Delete an event. Resolves with void on success. Google returns 404 or
   * 410 if the event is already gone — the caller (organize_delete) treats
   * both as success and continues; all other errors propagate.
   *
   * `notificationLevel` maps to `sendUpdates` the same way as createEvent.
   */
  async deleteEvent(opts: DeleteEventOptions): Promise<void>;
}
```

### Implementation notes (for the Developer agent)

  - `updateEvent` uses `events.patch` (not `events.update`); patch merges fields, update replaces the whole resource. We want patch semantics so undefined fields leave the server-side value intact.
  - Building the patch body: use the same allDay branch as `createEvent` (`start.date` / `end.date` for all-day; `start.dateTime` / `end.dateTime` + optional `timeZone` for timed). If `allDay` is explicitly provided and one of start/end isn't, throw before calling the API — the caller gave us inconsistent input.
  - `deleteEvent` calls `events.delete` with `sendUpdates` mapped the same way as createEvent. Catch 404/410 in `organize_delete` (the caller), NOT here — `CalendarApi` should reflect Google's actual response faithfully; the organize-specific "already-gone is fine" semantic is organize's concern, not Calendar's.

**Consequences.**

  - **Positive.** `organize` imports `src/google/calendar.js` only — no `googleapis` leak into `src/organize/`. Module boundaries stay clean.
  - **Positive.** The standalone `calendar_update_event` / `calendar_delete_event` tools that are already on the roadmap become thin wrappers — no additional design work needed in that future iteration.
  - **Negative.** `CalendarApi` grows. We accept this; it is the intended home for Calendar operations.

---

## 6. GCal failure semantics — atomic vs. eventually-consistent per operation

**Status:** Accepted.

**Context.** `/organize` tools have two sides of state: the organize markdown file on disk, and (for type=event items) a Google Calendar event. These two states can disagree. The question for every write operation is: when one side fails, what happens to the other?

Three principles:

  1. **Never leave an orphan on Google Calendar.** A GCal event with no corresponding organize file is noise the user can't easily clean up — it shows on their calendar, Jarvis doesn't know about it, and the user has to open `calendar.google.com` to delete it.
  2. **The local file is the source of truth for /organize state.** GCal is a projection. If sync fails, we prefer "file is correct, calendar is stale" over "file and calendar silently disagree."
  3. **Loud failures, not silent.** The user sees when sync fails; they do not need to infer it from a missing calendar notification.

**Decision.** Per-operation failure semantics:

### `organize_create` (type=event)
**Atomic: call GCal FIRST, then write file. On file-write failure, compensate by calling `deleteEvent` on GCal.**

  1. Call `CalendarApi.createEvent(...)`. If it throws → return `{ok:false, code:'CALENDAR_CREATE_FAILED'}`. No file is written. No local state changed. User sees the GCal error.
  2. On success, capture `eventId` and write the organize file with `calendarEventId: <eventId>`.
  3. If the file-write throws (disk full, permission error) → call `CalendarApi.deleteEvent({eventId})` to compensate. Log BOTH error chains (the file-write failure and, separately, the result of the compensating delete). Return `{ok:false, code:'FILE_WRITE_FAILED_EVENT_ROLLED_BACK'}` or, if the compensating delete also throws, `{ok:false, code:'FILE_WRITE_FAILED_EVENT_ORPHANED', message: 'Event created on Calendar but local file failed and rollback also failed; you have an orphan event id <eventId>'}`.

  Residual risk: the compensating `deleteEvent` can itself fail (network flaps between calls). We document the orphan risk — worst case the user has a GCal event with no corresponding organize item. The error message surfaces the eventId so the user can delete it manually from Google Calendar.

### `organize_create` (type=task or type=goal)
No GCal interaction. File write is the entire operation. Standard atomic temp-then-rename.

### `organize_update`
**Eventually-consistent: update the file FIRST, then attempt GCal patch. On GCal failure, the file is already updated — surface a WARNING.**

  1. Compute the patch. If no field changed, return early `{ok:true, output:'No changes.'}`.
  2. Write the updated file atomically. If the file-write throws → return `{ok:false, code:'FILE_WRITE_FAILED'}`. No GCal call was attempted.
  3. If the item has `calendarEventId` AND one of the GCal-synced fields changed (title/due/notes→description/allDay/attendees/timeZone/location), call `CalendarApi.updateEvent(...)`.
  4. On GCal failure → return `{ok:true, output:'Updated locally. Calendar sync failed (<reason>). Retry with organize_update next time you\'re online.', code:'CALENDAR_SYNC_FAILED_SOFT'}`. `ok:true` because the organize state is correct; the `code` tells the LLM what happened so it can relay to the user.

  Rationale: an update that fails halfway is a sticky local-correct / remote-stale state, which is strictly better than local-correct / remote-blown-away. The user retries; the system converges.

### `organize_delete`
**Atomic: delete from GCal FIRST. 404/410 counts as success. Any other failure aborts — don't soft-delete locally.**

  1. If the item has `calendarEventId`, call `CalendarApi.deleteEvent(...)`. If Google returns 404 or 410 (already-gone), treat as success. Any other error → return `{ok:false, code:'CALENDAR_DELETE_FAILED'}`. Do NOT soft-delete locally.
  2. On GCal success (or if no `calendarEventId`), rename the file to `.trash/<id>.md`. If the rename fails, log an error and return `{ok:false, code:'FILE_DELETE_FAILED', message:'Calendar event was deleted but local file rename failed — manual cleanup required at data/organize/<userId>/<id>.md'}`. This is a hard inconsistency the user needs to know about. It should be vanishingly rare.

  Rationale for "GCal first": if the user says "delete this event" and we succeed locally but fail remotely, they see the event on their phone tomorrow morning and are confused. If we fail remotely, we stop — the user retries, the system converges. Orphaning a GCal event after a "delete" command is the worst UX.

### `organize_complete` (type=event)
**Never touches GCal.** Marking an event "done" is purely local state — the event already happened (or didn't). We do not delete it from the calendar, we do not patch its summary. It stays on the calendar as history, which is what most users want.

### `organize_log_progress`
File-only. No GCal interaction under any conditions.

**Consequences.**

  - **Positive.** The user's calendar never has orphan events from `/organize` writes under normal operation. Rollback logic is compensating, not two-phase-commit.
  - **Positive.** The failure messages are specific (`CALENDAR_CREATE_FAILED` vs `FILE_WRITE_FAILED_EVENT_ROLLED_BACK` vs `FILE_WRITE_FAILED_EVENT_ORPHANED`) — the LLM (and the user) can tell what actually went wrong.
  - **Negative (residual).** Compensating delete can itself fail (network flap). We document the orphan risk and surface the eventId in the error so the user has a recovery path. This is the irreducible risk of any two-system write without 2PC.
  - **Negative.** `organize_update` can leave local-correct / remote-stale state indefinitely if the user never retries. We accept this — it's strictly safer than the alternative (patching the calendar while the local file is wrong).

---

## 7. Group-mode exclusion — `/organize` is DM-only

**Status:** Accepted.

**Context.** `/memory` is already DM-only for the same reason: memory is per-user, groups mix users, and exposing one user's state to a group context is a privacy leak. `/organize` has the same shape (per-user storage) and the same risk (item titles like "Divorce lawyer consultation Wed 3pm" in a work group chat would be Very Bad).

There are three surfaces to consider:

  1. The `/organize` slash command itself.
  2. The `organize_*` tools' visibility to the LLM.
  3. The active-items system-prompt injection.

**Decision.**

  - (1) `/organize` and subcommands reply "Organize is DM-only — message me privately." in groups. Same flow as `/memory`'s DM guard.
  - (2) The `organize_*` tools are filtered out of the active tool list in group turns. In `src/agent/index.ts`, after the existing role-based and calendar-based filters (lines 476–484), add a block: if the turn is in group mode, filter out any tool whose name starts with `organize_`. Parallel to the `calendar_` toggle pattern. The tools remain registered; they are simply not offered to the model in group turns — belt-and-braces with the dispatcher's `allowedToolNames` check (see `dispatch()` in `src/tools/index.ts` lines 160–167).
  - (3) The active-items injection (decision 3) is gated on `!groupMode`. No active-items block is added to the system prompt for group turns — otherwise one user's items would bleed into every other user's context in the same room.

  Phrased together: **in a group chat, /organize behaves as if the feature does not exist.** No tool, no injection, no command handler. A hypothetical jailbreak of the model to call `organize_*` anyway is defense-in-depthed by the dispatcher's allowedToolNames filter.

**Consequences.**

  - **Positive.** Zero bleed of per-user organize state into groups. Same guarantee as memory.
  - **Positive.** Symmetric with existing `/memory` posture — no new user education needed.
  - **Negative.** A user who naturally starts typing `/organize add …` in a group has to re-send in DM. One extra step. Acceptable.

---

## 8. Hand-editable markdown as a first-class surface — tolerant parsing posture

**Status:** Accepted.

**Context.** One of the feature's design premises is that users can open item files in an editor and modify them by hand. That's a benefit; it is also a risk. Malformed files exist in practice:

  - User accidentally deletes the closing `---` of the front-matter.
  - User types a non-ISO date in `due:` ("next Tuesday").
  - User nests a `## Progress` section inside `## Notes`.
  - File ends mid-word because the editor crashed before save.
  - File gets UTF-16 BOM because the user saved from Notepad with wrong encoding.

The existing `userMemory.ts` pattern handles scaffold drift by "reading, detecting the shape it expects, rewriting if a landmark is missing." That works for memory because memory is one file per user with a known fixed section set. `/organize` has N files per user, each with its own front-matter.

**Decision.** Tolerant parsing with explicit failure modes, documented in `src/organize/storage.ts`:

  1. **Read** — if the file cannot be read (permission, encoding), log a warning and surface in tool results as `{code:'FILE_READ_FAILED', itemId, message}`. The item is SKIPPED from listings; it is not auto-deleted.
  2. **Front-matter parse** — hand-rolled parser: find `^---\n` at the start, find the next `^---\n`, parse the block between as `key: value` lines where `value` is trimmed. Unknown keys are logged and dropped. Required keys (`id`, `type`, `status`, `title`, `created`) missing → the file is treated as malformed; SKIPPED from listings; an audit-log entry is inserted once per file (not per read) with `category:'organize.malformed'` — no, wait: we add `organize.malformed` only if we grow the category set. For v1, log at `warn` level and include `itemId` in the log; do NOT insert a new audit category for malformed reads (see decision below on audit).
  3. **Type validation** — `type` must be `task | event | goal`. Unknown type → SKIP with warning.
  4. **Date validation** — `due` must be either `YYYY-MM-DD` or a full ISO datetime. If it fails this check, the item still lists but sorts as undated (no `due`). This lets "next Tuesday" not block the whole listing while giving the user a chance to fix it.
  5. **Body** — the parser looks for `## Notes` and `## Progress` H2 landmarks anywhere after the closing `---`. Anything else in the body is preserved on write (pass-through for user-added markdown).
  6. **Write** — the write path always emits a canonical shape (front-matter in a stable key order, Notes before Progress). The user's in-file ordering is not preserved across a Jarvis-initiated write. Document this explicitly in the file header comment: `<!-- Managed by Jarvis /organize. Field order is normalized on every save. -->`
  7. **Error to user** — if the user tries to `organize_update` an item whose file is malformed at the required-keys level, return `{code:'ITEM_MALFORMED', message:'This item file is missing required front-matter fields (id, type, status, title, created). Fix it in your editor or delete it.'}`.

**Consequences.**

  - **Positive.** One bad file doesn't break listings. Progress is incremental; users can fix files at their leisure.
  - **Positive.** User edits are not silently lost — write-through preserves unknown body content.
  - **Negative.** Users might be confused when their manual field reordering is normalized away on save. Mitigated by the file header comment.
  - **Negative.** No schema migration story. If we ever change the front-matter shape (add a required field), old files become "malformed" until touched. We document this risk and commit to migrating-on-next-write rather than breaking-on-read. Out of scope for v1.

---

## 9. `itemId` format: `YYYY-MM-DD-<4-char-random>`

**Status:** Accepted.

**Context.** The item id appears on disk as the filename and in the active-items injection as the parenthesized reference (`... (2026-04-24-a1b2)`). It has four jobs:

  1. Disambiguate two items created on the same day.
  2. Sort chronologically when listed via `fs.readdir`.
  3. Be pasteable out of Telegram (user sees "(2026-04-24-a1b2)" and asks "show me 2026-04-24-a1b2" in DM).
  4. Not collide in practice.

Three common shapes:
  - UUIDv4 — collision-free, ugly, non-chronological, unmemorable.
  - Timestamp-only (`2026-04-24T10:30:00Z`) — chronological, collides if two items are created in the same second, can't easily be typed back.
  - Date + random suffix (`YYYY-MM-DD-<4-char-random>`) — sorts by day (good enough for humans), 4 random chars = 36⁴ = ~1.7M possibilities.

**Decision.** `YYYY-MM-DD-<4-char-random>` where random is 4 lowercase alphanumerics (`[a-z0-9]{4}`).

  - Collision probability per day (birthday paradox, 36⁴ space): at 100 items in one day, P(collision) ≈ 100·99/(2·1,679,616) ≈ 0.3%. At 200 (our per-user active cap), P ≈ 1.2%. Non-zero. Storage layer DOES check for collision: if `data/organize/<userId>/<id>.md` already exists, regenerate the suffix (max 5 attempts, then throw). Not a race since the per-chat agent queue serializes all tool calls per user.
  - Sort order: filenames sort lexicographically, which also sorts chronologically on the date prefix. The random suffix tie-breaks within a day; it is not meaningful order (a1b2 is not "before" a1b3 in any semantic sense), but that's fine — intra-day order is "whichever you created first," captured correctly by the `created` ISO field in front-matter, not by the id.
  - Ambiguity when copying ids out of chat: four-char alphanumerics avoid `0`/`o`/`1`/`l` confusion on most fonts, but not always. We don't collapse the alphabet (36 → 32) because the marginal confusion cost is low and the entropy loss matters at scale. Users who type the id wrong get a clear "item not found" error — acceptable.

**Consequences.**

  - **Positive.** Readable, chronological, pasteable, low collision.
  - **Negative.** Not globally unique across users. Two different users CAN have the same id. That's fine — files are under `data/organize/<userId>/`, and every storage function takes userId as first param (decision 10 / module boundary). Collision across users is impossible because the paths differ.
  - **Negative.** A determined adversary can enumerate — 1.7M attempts per day is trivial. Not a concern because (a) we require userId scoping and (b) the agent dispatcher rejects cross-user access.

---

## 10. 200 active items per user cap

**Status:** Accepted.

**Context.** There must be an upper bound. Unbounded storage means:

  - Per-turn injection cost grows with N (even with the 15-item cap, the scan-all-files-to-pick-top-15 scales with N).
  - Users can accumulate abandoned items forever and drown themselves in noise.
  - A bug in the agent that creates items in a loop can fill the disk quickly.

Options considered:

  - **No cap, paginate** — out of scope; list UIs are a feature we aren't building.
  - **Cap at 50** — too tight. A power user with 3 active goals, 10 milestones each, plus 20 upcoming events is already past 50.
  - **Cap at 200** — comfortable headroom; per-turn scan is ~20ms worst case on SSD.
  - **Cap at 1000** — over-engineered. Nobody personally manages 1000 active items.

**Decision.** 200 active items per user. Only `status === 'active'` items count; done / abandoned items do not count toward the cap (they exist until the user deletes them or they're manually archived). Trashed items (in `.trash/`) also do not count.

  - `organize_create` checks count before creating. If count >= 200 → return `{code:'ACTIVE_CAP_EXCEEDED', output:'You have 200 active items. Complete or delete some before creating new ones. Use /organize to review.'}`.
  - `organize_complete` and `organize_delete` are the release valves.
  - We log `warn` when a user crosses 150 active items (gives the LLM a hint to suggest cleanup to the user).

**Consequences.**

  - **Positive.** Bounded per-turn cost. Bounded disk usage (roughly 200 × 5KB = 1MB per user).
  - **Positive.** Forces hygiene — users with unmanaged items get a clear "this feature has a limit" signal rather than silent degradation.
  - **Negative.** A user close to the cap who forgets to clean up has a "feature stops working" experience. Mitigated by the 150-item warning and by listing `done` / `abandoned` items being fully cheap — the user can archive in bulk.

---

## Summary — What This ADR Commits To

  - New module `src/organize/` with `storage.ts`, `privacy.ts`, `injection.ts`, `types.ts`.
  - 6 new tools: `organize_create`, `organize_update`, `organize_complete`, `organize_list`, `organize_log_progress`, `organize_delete`.
  - 2 new methods on `CalendarApi`: `updateEvent`, `deleteEvent`.
  - 1 new slash command: `/organize` (DM-only).
  - 1 new system-prompt injection: active-items block, post-memory, DM-only, capped 15 items.
  - 1 new system-prompt rule: rule 11 for `/organize` in `config/system-prompt.md`.
  - 3 new audit categories: `organize.create`, `organize.update`, `organize.complete`, `organize.progress`, `organize.delete` (five subcategories under the existing `organize.*` family — added to `AuditCategory` in `src/memory/auditLog.ts`).
  - Zero new dependencies. Zero new DB tables. No queues, caches, workers.

The detailed shapes (zod schemas, tool contracts, failure-mode matrix, injection flow, module boundaries) live in the ARCHITECTURE.md addendum companion to this ADR (Section 16).

---

## References

  - `docs/ARCHITECTURE.md` — existing module boundaries and security invariants
  - `docs/adr/001-initial-architecture.md` — storage and module philosophy
  - `docs/adr/002-sqlite-driver-shim.md` — ADR format reference
  - `docs/reviews/cp1-architecture-debate.md` — adversarial review style; Devil's Advocate challenges this ADR next
  - `docs/ANTI-SLOP.md` — 16-section compliance baseline
  - `src/memory/userMemory.ts` — storage philosophy we mirror
  - `src/memory/userMemoryPrivacy.ts` — privacy filter pattern we extend (NOT import) in decision 2
  - `src/google/calendar.ts` — `CalendarApi` we extend in decision 5
  - `src/agent/index.ts` lines 439–461 — injection site for decision 3
  - `src/safety/scrubber.ts` — credential regex set re-used by organize privacy
