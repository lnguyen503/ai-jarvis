# ADR 007 — Revisions after CP1 debate (2026-04-24)

**Parent:** `007-v1.12.0-progress-panel.md`
**Status:** Accepted. Folded into ADR 007 by reference. Developer agents implement the revised spec; deviations require another addendum.
**Context.** Devil's Advocate review (`docs/reviews/cp1-devils-advocate-v1.12.0.md`) raised 2 BLOCKING + 3 HIGH + 7 MEDIUM + 1 NIT, plus 8 new risks. Anti-Slop Phase 1 (`docs/reviews/anti-slop-phase1-review-v1.12.0.md`) raised 3 FAIL-adjacent + 14 warnings. Both converge on the same cluster of concrete defects (DebateParams missing `chatType`, cross-chat cancel guard, renderButtons signature ambiguity, transcript persistence open question). This file resolves them.

---

## Resolved (R1 through R15)

### R1 (HIGH, BLOCKING — supersedes decision 14) — `DebateParams` gains `chatType`; scrub wiring closes the group-leak gap (DA-C1)

**Concern.** Decision 18 says "group-chat scrubbing is applied to `turn.text` before the debater writes into `state.transcript`." Decision 14's `DebateParams` shape as quoted doesn't include `chatType` or `isGroupChat`, so the scrubber at the call site has nothing to branch on. Developer agent ships the silent group-chat leak.

**Decision.**

1. **Add `chatType` to `DebateParams`:**
   ```typescript
   export interface DebateParams {
     // ... existing fields
     /** Chat type at the callsite. Required for decision 18's group-scoped scrubber:
      *  'private' → skip path/hostname scrub; 'group'|'supergroup' → apply scrubForGroup(). */
     chatType: 'private' | 'group' | 'supergroup' | 'channel';
   }
   ```

2. **Caller (gateway `/debate` handler) wires it from `ctx.chat?.type`:**
   ```typescript
   await runDebate({
     ...existingParams,
     chatType: ctx.chat?.type ?? 'private',  // defensively default to private (stricter scrub NOT applied; but single-user default is private)
   });
   ```

3. **`runDebateTurn` (or wherever `turn.text` is scrubbed per decision 18) receives the param:**
   ```typescript
   const scrubbedText = params.chatType === 'private'
     ? scrubCredentials(turn.text)     // always: credential scrub
     : scrubForGroup(turn.text, config); // group: full path/hostname/credential scrub
   state.transcript.push({ model: turn.model, text: scrubbedText });
   ```

   Credential-only scrub (via `scrubber.ts`'s outbound-safety pattern) applies in DMs too — credential leakage is DM-dangerous, not just group-dangerous. Decision 18 was ambiguous on DM credential posture; clarified here.

**Test coverage:**
- Group turn with path `C:\Users\foo\file.md` in debater output → scrubbed to `[PATH]` in state.transcript.
- DM turn with same path → passes through unscrubbed (user's own path, not exposed).
- DM turn with `sk-ant-api03-...` credential-like string → scrubbed to `[REDACTED]`.
- Group turn with both → both redacted.

### R2 (HIGH, BLOCKING — supersedes decision 9) — Cross-chat cancel guard (DA-C2)

**Concern.** Decision 9's cancel rule checks `ctx.from.id` but NOT `ctx.chat.id`. A forwarded inline-keyboard message in a different chat could fire the callback and cancel the debate. `plan.ts:429–441` shipped exactly this guard (HIGH-01 fix) the day before ADR 007 was drafted; mirroring plan.ts means mirroring that guard.

**Decision.** Decision 9's cancel authority check is revised with the chat guard FIRST:

```typescript
async function handleDebateCancelCallback(panelId, ctx, panelEntry, config) {
  // GUARD 0 (NEW — CP1 R2): same chat. Forwarded-button attack defence.
  if (ctx.chat?.id !== panelEntry.chatId) {
    await ctx.answerCallbackQuery({ text: 'Button no longer valid here.' }).catch(() => {});
    return;
  }
  // GUARD 1: owner or admin
  const userId = ctx.from?.id;
  if (userId === undefined) {
    await ctx.answerCallbackQuery({ text: 'No user context.' }).catch(() => {});
    return;
  }
  const isOwner = userId === panelEntry.ownerUserId;
  const isAdmin = config.groups?.adminUserIds?.includes(userId) === true;
  if (!isOwner && !isAdmin) {
    await ctx.answerCallbackQuery({ text: 'Only the debate starter or an admin can cancel.' }).catch(() => {});
    return;
  }
  // Proceed with cancel
  ...
}
```

**Expand/collapse** guards: apply the SAME `ctx.chat?.id === panelEntry.chatId` check first. Even though expand is read-only, a forwarded button showing someone else's debate transcript is a data-leak vector — blocking at the chat guard is the right layer.

**Test coverage:** test case 7 added to decision 9's test list — forwarded button from chat A tapped in chat B → rejected with "no longer valid here" toast.

### R3 (FAIL-adjacent — supersedes decision 3) — `renderButtons` signature clarified (Anti-Slop R1 + DA-C7)

**Concern.** Decision 3's `renderButtons(state, mode, terminal): InlineKeyboard` type contradicts decision 15's implementation `renderDebateButtons(panelId)(state, mode, terminal)` (curried form with panelId injected). Dev agent picks one or the other; either way the non-chosen form is wrong.

**Decision.** Add `panelId` as the FIRST parameter to the type. No currying.

```typescript
interface ProgressPanelDeps<S> {
  // ... other fields
  renderButtons(
    panelId: string,
    state: S,
    mode: 'collapsed' | 'expanded',
    terminal: boolean,
  ): InlineKeyboard;
}
```

Consumer-side:
```typescript
export function renderDebateButtons(
  panelId: string,
  state: DebateState,
  mode: 'collapsed' | 'expanded',
  terminal: boolean,
): InlineKeyboard {
  if (terminal && mode === 'collapsed') {
    return [[{label: '⌄ Show full transcript', data: `debate.expand:${panelId}`}]];
  }
  // ... etc
}
```

Panel primitive forwards `panelId` → `renderButtons` each call. No closures needed.

### R4 (FAIL-adjacent — supersedes decision 3 design note) — Button-authority wording (Anti-Slop R2)

**Concern.** Decision 3 says "the primitive ONLY injects the `expand`/`collapse` built-in buttons via the consumer's callback." This is backwards: the PRIMITIVE owns the callback_query ROUTING, but the CONSUMER emits the buttons (including their callback_data). The misphrasing would lead a dev agent to have the primitive inject buttons the consumer didn't ask for, duplicating the row.

**Decision.** Rewrite decision 3's design note:

> **Separation of concerns:** the primitive owns CALLBACK ROUTING (registers the namespace prefix, routes `debate.expand:<id>`, `debate.collapse:<id>`, `debate.cancel:<id>` to built-in handlers, strips keyboard on cancel). The primitive does NOT emit buttons — the consumer's `renderButtons(panelId, state, mode, terminal)` returns the full `InlineKeyboard` including the expand/collapse/cancel buttons with the well-known callback_data shape `<namespace>.<action>:<panelId>`. Consumers use a helper `standardPanelButton(panelId, action, label)` from the primitive to avoid typo'd callback_data.

Provide the helper:
```typescript
export function standardPanelButton(
  panelId: string,
  namespace: string,
  action: 'expand' | 'collapse' | 'cancel',
  label: string,
): InlineButton {
  return { label, data: `${namespace}.${action}:${panelId}` };
}
```

### R5 (MEDIUM — closes Open Question 1) — Transcript persistence: single `debate.complete` / `debate.cancel` row with full transcript in `detail_json` (DA-C13 + Anti-Slop R3)

**Concern.** §26 Open Question 1 was left unresolved. DA recommends option (d) one-row-per-debate; Anti-Slop recommends option (a) per-turn audit rows. They diverge on where the cost lands (detail_json size vs row count). Picked now to unblock Phase 2.

**Decision.** Option (d) — single terminal audit row per debate.

- **`debate.complete`** emitted on consensus / final-verdict paths. Detail shape:
  ```typescript
  {
    topic: string,                // scrubbed, ≤200 chars
    chatType: 'private' | 'group' | ...,
    roster: string[],
    rounds: number,
    consensusReached: boolean,
    durationMs: number,
    turns: Array<{model: string, text: string}>,  // full transcript, post-scrub
    verdict?: {kind: 'consensus' | 'final-arbiter', summary: string, decision?: string, rationale?: string, dissent?: string},
  }
  ```
- **`debate.cancel`** emitted on user-cancelled path. Same detail shape with `cancelled: true` and `verdict: undefined`.
- **`debate.start`** NOT emitted — the `debate.complete`/`debate.cancel` row is sufficient and contains start-time via `ts - durationMs`. Keeps audit_log row count flat.

**Rationale.**
- Query pattern: `/audit filter debate.complete actor_user_id=X since=Y` → one row per debate, instantly shows full context.
- Storage: ~3-8KB detail_json per debate × 10 debates/day × 365 days = ~11-29MB/year single-user. Tolerable.
- Comparison to (a): option (a) would add ~18 rows/debate × 10/day = 180 rows/day = 65K rows/year, with the new audit_log index (migration 010) bearing most of the cost. Not bad, but detail-per-row at ~200 chars is smaller per-row yet loses the "single row per debate event" semantic.
- Migration: no schema change. Just two new AuditCategory strings: `'debate.complete'` and `'debate.cancel'`.

**Test coverage:**
- Cancel mid-round-2 → `debate.cancel` row with `turns` containing exactly the completed turns; `cancelled: true`; `verdict: undefined`.
- Consensus in round 2 → `debate.complete` row with `consensusReached: true`; `verdict: {kind: 'consensus', summary}`.
- Detail_json size stays under 64KB for pathological 10-round debates with long turns (Architect flagged this cap in §23 risk register; enforced by truncating individual turn text at `turn.text.length > 8000 ? turn.text.slice(0, 8000) + '…' : turn.text` before audit-write).

### R6 (HIGH — supersedes decision 16) — Truncation switches to "preserve opener and closer" strategy (DA-C3 + Anti-Slop W7)

**Concern.** Option (a) "drop oldest rounds" strips the position statements that make later attacks comprehensible. A reader sees "Model B: That's circular" as the first line, with no referent for "that." Plus decision 16 reserves 200 chars for the truncation marker, but the marker text is ~80 chars — wasted 120 chars of transcript budget.

**Decision.** Switch to a hybrid "preserve first round + most recent rounds, drop middle":

1. **Always keep round 1** (all turns of round 1) as the opening context.
2. **Always keep the most recent completed round** as the current state.
3. **Middle rounds are elided** with a marker: `⋯ [N earlier rounds omitted — see /audit filter debate.complete for full transcript] ⋯` (~85 chars, within a 100-char reservation).
4. **Single-turn overflow** — if one turn exceeds the remaining budget, truncate that turn with `…` at the end. Do not drop it.
5. **Ordering math:**
   ```
   budget = 4096 - headerLen - footerLen - markerReservation(100)
   keep(round1Turns) + keep(recentRoundTurns) should fit budget
   if not, truncate recentRoundTurns individually before round1Turns
   ```

**Test coverage:**
- 5-round debate where middle rounds fit → no marker inserted; all rounds shown.
- 5-round debate where rounds 2-4 exceed budget → marker replaces rounds 2-4; rounds 1 and 5 intact.
- Single round-1 turn exceeds budget → that turn truncated with `…`, other turns intact.
- Empty debate (0 turns) → empty detail with no marker.

### R7 (MEDIUM — supersedes decision 20) — Pulsing typing indicator during Ollama calls (DA-C5)

**Concern.** Telegram's native typing indicator fades after ~5s. Ollama Cloud cold-starts routinely run 30-60s. One-shot `sendChatAction` per turn leaves 25-55s of silence where the user sees neither indicator nor panel change (the panel only edits between turns, not during a turn).

**Decision.** In `runDebate`'s per-turn loop, wrap the debater call with a `setInterval`-based typing pulse:

```typescript
async function callDebaterWithPulse(adapter, chatId, ...args) {
  const pulse = setInterval(() => {
    void adapter.sendChatAction(chatId, 'typing').catch(() => {});
  }, 4000);
  try {
    await adapter.sendChatAction(chatId, 'typing').catch(() => {});
    return await callDebater(...args);
  } finally {
    clearInterval(pulse);
  }
}
```

Mirrors v1.11.1's DM agent.turn pulse pattern (which DID land as a pulse in gateway/index.ts — CP1's claim otherwise was a read of a different path; decision 20's intent is to apply the same pattern to the debate per-turn loop).

**Test coverage:** mock adapter's sendChatAction called 5+ times during a 20s mock debater call (4s interval + initial fire); no stale interval after the call returns.

### R8 (MEDIUM — supersedes decision 18) — Scrub applies to Claude judge + arbiter too (DA-C12)

**Concern.** Decision 18 scrubs `topic` before passing to Ollama debaters, but `judgeConsensus` and `forceFinalVerdict` receive the original un-scrubbed `question` parameter — credentials can leak to the Anthropic API even though we guard the Ollama path.

**Decision.** Single source of truth: `state.topic` (post-scrub) flows to ALL LLM calls — Ollama debaters, Claude judge, Claude arbiter.

- Remove `DebateParams.question` entirely. Add `DebateState.topic: string` (already planned in decision 9). Runtime populates `state.topic = scrubCredentials(paramsTopic)` at the start of `runDebate`.
- `callDebater`, `judgeConsensus`, `forceFinalVerdict` all read from `state.topic`.
- Only ONE place does the scrub — the initial population — so a future scrubber change propagates everywhere automatically.
- Scrub policy for topic: credential-only (never path/hostname, regardless of chat type — topic is the user's question, which may legitimately reference paths/hostnames). Credential scrub catches `sk-ant-*`, `sk-*`, phone numbers, etc.

**Test coverage:**
- Topic containing `sk-ant-api03-foo` → `state.topic` has `[REDACTED]`; judge + arbiter calls receive the redacted form (grep the test mock's received payload).
- Topic with legitimate path reference `what's in /etc/hosts?` → path passes through untouched.

### R9 (MEDIUM — supersedes decision 3) — `renderButtons` signature finalized with panelId (consolidated with R3)

Covered by R3 above. The primitive API is:

```typescript
interface ProgressPanelDeps<S> {
  adapter: MessagingAdapter;
  chatId: number;
  ownerUserId: number;
  callbackNamespace: string;
  componentTag: string;
  renderSummary(state: S): string;
  renderDetail(state: S): string;
  renderButtons(panelId: string, state: S, mode: 'collapsed' | 'expanded', terminal: boolean): InlineKeyboard;
  extraActions?: Record<string, (ctx: Context, state: S) => Promise<{toast?: string}>>;
}

export function standardPanelButton(panelId, namespace, action, label): InlineButton;
```

### R10 (MEDIUM — supersedes decision 8) — Distinguishing catch on `editMessageReplyMarkup` (DA-C9)

**Concern.** `editMessageReplyMarkup(undefined).catch(() => {})` swallows everything, including "message to edit not found" (user deleted the panel message — worth logging). `plan.ts:230-235` precedent does distinguished catch.

**Decision.** Revise the strip-buttons pattern to match plan.ts:

```typescript
try {
  await adapter.editMessageReplyMarkup(chatId, messageId, undefined);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('message is not modified')) {
    // Already has no keyboard — fine.
    return;
  }
  if (msg.includes('message to edit not found') || msg.includes('MESSAGE_ID_INVALID')) {
    // User deleted the message; panel state should also be GC'd.
    log.debug({chatId, messageId}, 'panel message deleted by user; cleaning up');
    panelRegistry.closePanel(panelId);
    return;
  }
  log.warn({chatId, messageId, err: msg}, 'editMessageReplyMarkup failed');
}
```

Note: `MessagingAdapter` doesn't have `editMessageReplyMarkup` yet (only `editMessageText` with optional `buttons`). Adding that as part of this iteration — one method, passes through to grammY's `bot.api.editMessageReplyMarkup`. Non-breaking additive change to the adapter interface.

### R11 (MEDIUM — supersedes decision 15 + decision 8) — Explicit scrub/escape contract + callback_data regex (DA-C11 + Anti-Slop W13)

**Concern.** Decision 15 moves `escape()` from `debate/index.ts` to `debate/panelRender.ts`. The contract isn't explicit: does the scrubber escape HTML? Does the renderer scrub? If either side changes its assumption, HTML-injection or double-escape bugs land.

**Decision.** Explicit contract added to decision 15:

> **Scrub / escape contract:**
>   - `scrubber.ts` NEVER emits HTML-escaped text. Its output is raw strings with redacted-span markers `[REDACTED]` / `[PATH]` / etc.
>   - `panelRender.ts`'s `renderSummary` / `renderDetail` functions always HTML-escape via `escape()` before returning. ONLY the renderer is responsible for HTML-safety.
>   - Tests enforce this: a test fixture feeding `<script>alert(1)</script>` into a turn.text must be output as `&lt;script&gt;alert(1)&lt;/script&gt;` in renderDetail's result (not dropped, not passed through, explicit escape).

**Callback_data regex contract added to decision 8:**

```typescript
// Primitive's own callback_query router (in progressPanel.ts):
const CALLBACK_RE = /^([a-z][a-z0-9-]*)\.(expand|collapse|cancel)(:([A-Za-z0-9_-]{4,31}))?$/;

function parseCallback(data: string): {namespace: string; action: string; panelId: string | null} | null {
  const m = CALLBACK_RE.exec(data);
  if (!m) return null;
  return {namespace: m[1]!, action: m[2]!, panelId: m[4] ?? null};
}
```

Rejects malformed data at the router layer; no downstream handler needs to defensive-parse.

### R12 (MEDIUM — supersedes decision 10) — LRU+TTL sizing rationale for multi-user (DA-C4)

**Concern.** Default `cacheMax: 50` is too small for multi-user at 5+ concurrent debaters per user. Decision 10 doc-only needs clarification, no code change.

**Decision.** Add a paragraph to decision 10:

> **Sizing guidance for multi-user deployments:** the `panelStateCacheMax` knob is TOTAL concurrent panels across all users. Default 50 suits single-user. For ≥10-user deployments, raise to `max(100, 5 × expectedActiveUsers)`. The LRU eviction warn log (filed in §23 risk register) fires when eviction happens; operators tune based on frequency. TTL of 24h is independent — long-running debates aren't expected to span 24h, and expired panels show "panel expired" toast on callback which is the correct degradation.
>
> Zod schema validates both: `panelStateCacheMax: z.number().int().min(10).max(10000)`, `panelStateTtlHours: z.number().int().min(1).max(168)`. A schema-time warn log fires if `cacheMax < 10` (accidental mis-configuration).

### R13 (MEDIUM — supersedes decision 12) — ESLint rule for test-only access (DA-C10)

**Concern.** Decision 12 uses `no-restricted-syntax` to forbid importing `_getPanelForTests`. That rule can't cleanly match "import of symbol X from module Y in files not matching pattern Z." `no-restricted-imports` with path + importNamePattern is the right rule.

**Decision.** Use `no-restricted-imports`:

```jsonc
// .eslintrc (or overrides)
{
  "rules": {
    "no-restricted-imports": ["error", {
      "patterns": [{
        "group": ["**/gateway/progressPanel*"],
        "importNames": ["_getPanelForTests"],
        "message": "_getPanelForTests is a test-only seam. Import from tests/ only."
      }]
    }]
  },
  "overrides": [{
    "files": ["tests/**/*.ts"],
    "rules": { "no-restricted-imports": "off" }
  }]
}
```

Source files cannot import `_getPanelForTests`; test files can.

### R14 (MEDIUM, documentation-only) — Zombie panel after pm2 restart (DA-C8)

**Concern.** A debate in-flight when pm2 restarts leaves a panel saying `⚔️ Debate: X · Round 2/3 · Model A speaking...` forever. Decision 7 accepted this but didn't document the user-facing experience.

**Decision.** Add to decision 7's Consequences:

> **Zombie panel on pm2 restart mid-debate.** If pm2 restarts while `runDebate` is in-flight, the in-memory panel state is lost along with the async loop. The PANEL MESSAGE persists in the chat showing its last-rendered state (e.g. "Round 2/3 · Model A speaking..."). Tapping any button fires the stale-callback handler (R3 handling): toast "Panel expired — please re-run /debate" and strip buttons. The panel text itself stays mis-leading ("speaking...") until the user re-runs and sees a fresh panel. **This is acceptable for single-user pm2 but should be documented in the user-facing README** and the deployment checklist. A v1.12.x follow-up could scan for orphan panel messages at boot and edit them to "⚠ Panel orphaned by restart" — deferred as unnecessary complexity at deployed scale.

Add a line to `README.md` or `docs/DEPLOYMENT.md` (whichever exists) mentioning this. One sentence.

### R15 (NIT — supersedes decision 2 rationale) — Panel location defense wording (DA-C6)

**Concern.** Decision 2's defense of `src/gateway/progressPanel.ts` over-argues gateway-specific concerns. The primitive is compositional — it uses `MessagingAdapter` (messaging layer) but is used BY gateway callback routing. It's layer-above-messaging, layer-below-gateway. The physical file location matches the import direction.

**Decision.** Rewrite decision 2's rationale paragraph as:

> **Layering:** `ProgressPanel` imports from `src/messaging/adapter.ts` (`MessagingAdapter`, `InlineKeyboard`) and `src/logger/` + `src/config/`. It does NOT import from `src/gateway/`, `src/debate/`, `src/plan/`, or any command file. Gateway's callback router imports ProgressPanel to route `<namespace>.*` callbacks; `/debate` imports ProgressPanel to create panels. The file lives in `src/gateway/` because its primary CONSUMER is the gateway (gateway registers the callback router, gateway creates and manages panel lifecycles during command handlers). If a future refactor moves callback routing into `src/messaging/`, ProgressPanel moves with it. No principled test distinguishes `src/gateway/` from `src/messaging/` for this file today; the gateway co-location is a convenience that can be revisited without API change.

No functional impact; reader clarity only.

---

## Amended decision 14 — `DebateParams` final shape

After R1 + R8, the finalized interface is:

```typescript
export interface DebateParams {
  /** Panel-owned state; the runtime initializes state.topic from params.topic
   *  (scrubbed) and then ALL downstream calls read from state.topic. There is
   *  no params.question anymore — use state.topic. */
  topic: string;  // user-authored, scrubbed at state construction
  maxRounds: number;
  exchangesPerRound: number;
  panel: ProgressPanelApi<DebateState>;  // NEW — replaces sendMessage callback
  ollama: ModelProvider;
  claudeClient: Anthropic;
  judgeModel: string;
  abortSignal: AbortSignal;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';  // NEW per R1
  config: AppConfig;  // for scrubber + config knobs
}
```

The `sendMessage` callback from the legacy interface is REMOVED. Panel state updates go through `panel.updateState(newState)`.

---

## New risks added to §23 risk register

From DA's new-risks list (R_DA7_1 through R_DA7_8), mapped to resolutions:

| Risk | Severity | Mitigation |
|---|---|---|
| DebateParams missing chatType silently breaks group scrub | HIGH → resolved | R1 |
| Cross-chat cancel attack via forwarded button | HIGH → resolved | R2 |
| Un-scrubbed topic reaches Claude judge/arbiter | MEDIUM → resolved | R8 |
| Zombie panel after pm2 restart mid-debate | LOW | R14 — documented, no code fix |
| audit_log 100× balloon under per-turn persistence | MEDIUM → resolved | R5 — chose option (d) |
| LRU evictions surprise multi-user deployments | LOW (MEDIUM non-default) | R12 — docs |
| Typing indicator fades during Ollama cold-start | MEDIUM → resolved | R7 |
| Scrub/escape responsibility split | LOW → resolved | R11 — contract documented |

---

## Revised verdict — ready for Phase 2

Both BLOCKING (R1, R2) + both FAIL-adjacent (R3, R4) + remaining HIGH (R5 closes Open Question 1; R6 fixes truncation semantics) are resolved with concrete ADR text. MEDIUM R7-R11 apply as well. R12-R15 are documentation-only.

**Phase 2 may start.** Developer agents implement against ADR 007 + this revisions file. Deviations require another addendum.

**Implementation order for Phase 2** (suggested):

1. **Panel primitive (`src/gateway/progressPanel.ts`) + tests.** Includes `ProgressPanelDeps<S>`, `ProgressPanelApi<S>`, `panelRegistry`, `standardPanelButton` helper, callback_data regex, stale-callback handling, LRU+TTL state, distinguishing catch. No domain coupling.
2. **`MessagingAdapter.editMessageReplyMarkup`** method added per R10. Telegram implementation delegates to `bot.api.editMessageReplyMarkup`.
3. **`src/memory/auditLog.ts`** — add `'debate.complete'` and `'debate.cancel'` to the AuditCategory union.
4. **Config schema** — add `debate.panelStateCacheMax` + `debate.panelStateTtlHours` per R12.
5. **`src/debate/index.ts` rewrite** — new `DebateParams` + `DebateState` shape; typing pulse per R7; scrubbed `state.topic` flows everywhere per R8; truncation helper per R6.
6. **`src/debate/panelRender.ts` (new file)** — renderSummary, renderDetail, renderButtons with explicit escape contract (R11).
7. **Gateway callback router extension** — `debate.*` branch delegates to `panelRegistry.handleCallback`.
8. **`src/commands/debate.ts`** — `/debate` command handler creates the panel, passes `chatType`, no longer sends "debate starting" header message.
9. **Tests** — per-item tests per the coverage callouts in R1–R11.
10. **Docs** — `docs/ARCHITECTURE.md` §19 stub (v1.12.0 progress-panel section), README note re: zombie panel (R14), CHANGELOG + PROGRESS + TODO.

Phase-2 Anti-Slop + Scalability + QA run against the implementation in parallel after CP2.
