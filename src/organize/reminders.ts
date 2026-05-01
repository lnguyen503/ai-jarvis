/**
 * /organize reminder orchestrator (v1.9.0).
 *
 * Exports initReminders(deps): RemindersApi
 *   start()                — register cron; no-op if disabled
 *   stop()                 — stop cron
 *   tickAllUsers()         — iterate data/organize/<userId>/ dirs, tick each
 *   tickOneUser(userId)    — full per-user gate sequence (§17.7)
 *   markResponsiveIfPending(userId) — flip 'pending' → 'responded' on DM
 *   setUserDisabledNag(userId, disabled) — persistent /organize nag on|off
 *   getNagStatus(userId)   — read nag status for /organize nag status
 *
 * See ARCHITECTURE.md §17 and ADR 004 (+ revisions after CP1).
 */

import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import type pino from 'pino';
import { child } from '../logger/index.js';
import { scrub } from '../safety/scrubber.js';
import { listItems } from './storage.js';
import {
  loadReminderState,
  writeReminderState,
  loadGlobalState,
  ymdLocal,
  reminderStatePath,
  reserveGlobalHaikuFallback,
} from './reminderState.js';
import type { ReminderState, GlobalReminderState } from './reminderState.js';
import { TRIAGE_SYSTEM_PROMPT, buildTriageInput } from './triagePrompt.js';
import { parseTriageDecision } from './triageDecision.js';
import type { TriageDecision } from './triageDecision.js';
import type { OrganizeItem } from './types.js';
import type { AppConfig } from '../config/index.js';
import type { MemoryApi } from '../memory/index.js';
import type { MessagingAdapter } from '../messaging/adapter.js';
import type { ModelProvider, UnifiedMessage } from '../providers/types.js';

const log = child({ component: 'organize.reminders' });

// ---------------------------------------------------------------------------
// Module-level state (CP1 R6 — tick-in-flight lock; v1.10.0 R6 — abort ctrl)
// ---------------------------------------------------------------------------

let tickInFlight = false;
let cronTask: cron.ScheduledTask | null = null;
/** R6: AbortController for the currently-running tick. stop() calls abort() on it. */
let currentTickAbort: AbortController | null = null;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReminderDeps {
  config: AppConfig;
  logger: pino.Logger;
  memory: MemoryApi;
  adapter: MessagingAdapter & { resolveDmChatId(userId: number): number | null };
  claudeProvider: ModelProvider;
  ollamaProvider: ModelProvider;
  dataDir: string;
  /** R6 (v1.10.0): optional abort signal — wired in by tickAllUsers pool for graceful shutdown. */
  abortSignal?: AbortSignal;
}

export interface RemindersApi {
  start(): void;
  stop(): void;
  tickAllUsers(): Promise<void>;
  tickOneUser(userId: number): Promise<void>;
  markResponsiveIfPending(userId: number): Promise<void>;
  setUserDisabledNag(userId: number, disabled: boolean): Promise<void>;
  getNagStatus(userId: number): Promise<{
    disabledNag: boolean;
    nudgesToday: number;
    lastNudgeAt: string | null;
    mutedCount: number;
  }>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Short error string without echoing user content. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Outbound-safety filter (CP1 R1).
 * Returns {ok:true} if the text is safe, {ok:false, pattern:<rule-name>} if it matches.
 * Patterns are case-insensitive, unicode-normalized NFC, whitespace-collapsed.
 * Exported for direct unit testing (Fix #4 / QA W7).
 */
export function checkOutboundSafety(text: string): { ok: true } | { ok: false; pattern: string } {
  if (!text) return { ok: true };

  // Normalize: NFC + collapse whitespace
  const normalized = text.normalize('NFC').replace(/\s+/g, ' ');

  // Credential-echo patterns (before scrubber, to get named matches)
  if (/CONFIRM\s+SEND\s+[A-Za-z0-9]{6,}/i.test(normalized)) {
    return { ok: false, pattern: 'confirm-send' };
  }
  if (/CONFIRM\s+TRANSFER\s+[A-Za-z0-9]{6,}/i.test(normalized)) {
    return { ok: false, pattern: 'confirm-transfer' };
  }
  if (/\bYES\s+[a-f0-9]{4,8}\b/i.test(normalized)) {
    return { ok: false, pattern: 'yes-action-id' };
  }
  if (/(ANTHROPIC|OPENAI|GOOGLE|OLLAMA|TAVILY|TELEGRAM)[_-]?(API)?[_-]?(KEY|TOKEN)/i.test(normalized)) {
    return { ok: false, pattern: 'credential-name-echo' };
  }
  if (/https?:\/\/[^\s]{0,20}@[^\s]+/.test(normalized)) {
    return { ok: false, pattern: 'url-with-auth' };
  }
  if (/password\s*(is|:|=)\s*\S/i.test(normalized)) {
    return { ok: false, pattern: 'password-dictation' };
  }

  // Zero-width / bidi-override Unicode
  // U+200B-U+200D, U+202A-U+202E, U+2066-U+2069
  // Built via RegExp constructor (escape-sequence source) so the file does not
  // contain raw bidi/zero-width characters.
  const bidiZeroWidthRegex = new RegExp(
    '[' +
      '\u200b-\u200d' +
      '\u202a-\u202e' +
      '\u2066-\u2069' +
      ']'
  );
  if (bidiZeroWidthRegex.test(text)) {
    return { ok: false, pattern: 'bidi-zero-width' };
  }

  // Reuse scrubber for credential shapes (catches API key patterns)
  if (scrub(text) !== text) {
    return { ok: false, pattern: 'credential-scrubber' };
  }

  return { ok: true };
}

/**
 * Returns true when the current server-local hour is in the quiet window
 * (configurable via config.organize.reminders.quietHoursLocal).
 */
function quietHoursNow(config: AppConfig, now: Date = new Date()): boolean {
  const hour = now.getHours();
  const quietHours: number[] = config.organize?.reminders?.quietHoursLocal ?? [22, 23, 0, 1, 2, 3, 4, 5, 6, 7];
  return quietHours.includes(hour);
}

/**
 * Returns true when the item is an event whose due timestamp is within
 * thresholdMs in the future (default 60 min).
 */
function isImminentEvent(
  item: OrganizeItem,
  now: Date,
  thresholdMs: number = 60 * 60 * 1000,
): boolean {
  if (item.frontMatter.type !== 'event') return false;
  const due = item.frontMatter.due;
  if (!due) return false;
  const dueMs = Date.parse(due);
  if (Number.isNaN(dueMs)) return false;
  const diff = dueMs - now.getTime();
  return diff >= 0 && diff <= thresholdMs;
}

/**
 * Redact item titles from LLM reasoning before storing in audit (CP1 R9).
 * Replaces exact title substrings with [title:<itemId>]. Caps at 300 chars.
 */
function redactTitlesFromReasoning(reasoning: string, items: OrganizeItem[]): string {
  let redacted = reasoning;
  for (const item of items) {
    const title = item.frontMatter.title;
    if (title && redacted.includes(title)) {
      redacted = redacted.split(title).join(`[title:${item.frontMatter.id}]`);
    }
  }
  return redacted.slice(0, 300);
}

/**
 * Strip ASCII + Unicode control characters that could render weirdly in
 * Telegram or be used for display-level spoofing (bidi overrides,
 * zero-width joiners). Keeps tab/newline. Matches what the outbound-safety
 * filter rejects but is used as a belt-and-braces strip on the FINAL body
 * (the filter's job is to REJECT; this function's job is to CLEAN anything
 * that sneaks past).
 *
 * Codepoints stripped:
 *   0x00-0x08, 0x0b, 0x0c, 0x0e-0x1f, 0x7f  — ASCII control (keep \t, \n, \r)
 *   U+200B-U+200D                            — zero-width space/non-joiner/joiner
 *   U+202A-U+202E                            — LTR/RTL/PDF bidi overrides
 *   U+2066-U+2069                            — LRI/RLI/FSI/PDI isolates
 */
const CONTROL_CHAR_STRIP_REGEX = new RegExp(
  '[' +
    '\\u0000-\\u0008' +
    '\\u000b\\u000c' +
    '\\u000e-\\u001f' +
    '\\u007f' +
    '\\u200b-\\u200d' +
    '\\u202a-\\u202e' +
    '\\u2066-\\u2069' +
    ']',
  'g',
);

/**
 * Format the nudge body for delivery. Passes through scrubber + control-char
 * strip as defense-in-depth (CP1 R13 / §17.6 + v1.9.1 polish).
 */
export function formatNudgeBody(decision: TriageDecision & { shouldNudge: true }): string {
  const offerLine =
    decision.offer && decision.offer.kind !== 'none' && decision.offer.description
      ? `\n\n_${decision.offer.description}_`
      : '';
  const body = `${decision.message}${offerLine}`;
  // v1.9.1-review-fix: strip control/bidi chars FIRST so that a credential
  // interspersed with zero-width joiners (e.g. "sk-ant-[ZWSP]api03-xxx")
  // gets its ZW removed BEFORE the scrubber's regex runs — otherwise the
  // ZW breaks the credential pattern and the scrubber misses, leaving a
  // plaintext key in the message. Order matters.
  return scrub(body.replace(CONTROL_CHAR_STRIP_REGEX, ''));
}

// ---------------------------------------------------------------------------
// Extended decision type with provider provenance
// ---------------------------------------------------------------------------

type DecisionWithProvenance = TriageDecision & {
  _providerUsed: string;
  _model: string;
  _fallbackUsed: boolean;
  _inputTokens: number | undefined;
  _outputTokens: number | undefined;
};

type TriageSkipped = {
  _skipped: true;
  reason: 'rate-limit' | 'haiku-budget-exhausted' | 'all-providers-failed';
};

// `TriageResult = DecisionWithProvenance | TriageSkipped` was in use before
// the v1.10.0 refactor split the audit write from the triage call. Leaving
// the component types exported — the union was only the internal alias.

// ---------------------------------------------------------------------------
// Audit helper
// ---------------------------------------------------------------------------

function insertNudgeAudit(
  deps: ReminderDeps,
  row: {
    userId: number;
    result: 'ok' | 'suppressed' | 'skipped' | 'failed';
    reason?: string;
    decision?: TriageDecision;
    items?: OrganizeItem[];
    inputTokens?: number;
    outputTokens?: number;
    provider?: string;
    model?: string;
    fallbackUsed?: boolean;
    pattern?: string;
    nudgesToday?: number;
    /** v1.10.0: per-user Haiku fallback counter (post-increment when fallback used) */
    haikuFallbacksTodayPerUser?: number;
    /** v1.10.0: global Haiku fallback counter (post-increment when fallback used) */
    globalHaikuFallbacksToday?: number;
  },
): void {
  const decision = row.decision;
  const hasNudge = decision && 'itemId' in decision && decision.shouldNudge === true;
  const nudgeDecision = hasNudge ? decision : undefined;

  const reasoningRaw =
    decision && 'reasoning' in decision ? decision.reasoning ?? '' : '';
  const reasoning = row.items
    ? redactTitlesFromReasoning(reasoningRaw, row.items)
    : reasoningRaw.slice(0, 300);

  // v1.9.1: offerDescription is LLM-authored and may echo user titles — redact
  // identically to `reasoning` so the audit log invariant (no raw user text)
  // holds for this field too.
  const offerDescriptionRaw = nudgeDecision?.offer?.description ?? null;
  const offerDescription = offerDescriptionRaw !== null && row.items
    ? redactTitlesFromReasoning(offerDescriptionRaw, row.items)
    : offerDescriptionRaw;

  try {
    deps.memory.auditLog.insert({
      category: 'organize.nudge' as import('../memory/auditLog.js').AuditCategory,
      actor_user_id: row.userId,
      actor_chat_id: row.userId,
      session_id: null,
      detail: {
        itemId: nudgeDecision?.itemId ?? null,
        type: (nudgeDecision && row.items?.find((i) => i.frontMatter.id === nudgeDecision.itemId)?.frontMatter.type) ?? null,
        urgency: nudgeDecision?.urgency ?? null,
        offerKind: nudgeDecision?.offer?.kind ?? 'none',
        offerDescription,
        reasoning,
        provider: row.provider ?? null,
        model: row.model ?? null,
        fallbackUsed: row.fallbackUsed ?? false,
        inputTokens: row.inputTokens ?? null,
        outputTokens: row.outputTokens ?? null,
        result: row.result,
        reason: row.reason ?? null,
        pattern: row.pattern ?? null,
        nudgesToday: row.nudgesToday ?? null,
        // v1.10.0: dual-layer Haiku budget attribution
        haikuFallbacksToday: row.haikuFallbacksTodayPerUser ?? null,  // per-user (repurposed field name per ADR 005 §3)
        globalHaikuFallbacksToday: row.globalHaikuFallbacksToday ?? null,
      },
    });
  } catch (err) {
    log.warn({ userId: row.userId, err: errMsg(err) }, 'reminders: audit insert failed');
  }
}

// ---------------------------------------------------------------------------
// Extended TriageSkipped reason type (v1.10.0)
// ---------------------------------------------------------------------------

// (TriageSkipped already handles 'haiku-budget-exhausted' for both per-user and global;
//  the distinct reasons are carried in the audit row via the 'reason' field.)

// ---------------------------------------------------------------------------
// Provider call (§17.8) — v1.10.0: uses dual-layer Haiku budget (R1)
// ---------------------------------------------------------------------------

/**
 * Extended result that also carries the global state (post-increment when
 * fallback was used, pre-reserve when skipped) for audit attribution.
 */
type TriageResultWithGlobal =
  | (DecisionWithProvenance & { _globalStateAfter: GlobalReminderState })
  | (TriageSkipped & { _globalState?: GlobalReminderState });

async function triageForUser(
  userId: number,
  userContent: string,
  pickedItemIds: string[],
  deps: ReminderDeps,
  userState: ReminderState,
): Promise<TriageResultWithGlobal> {
  const cfg = deps.config.organize?.reminders;
  const timeoutMs = cfg?.triageTimeoutMs ?? 90_000;
  const perUserBudget = cfg?.haikuFallbackMaxPerDay ?? 20;
  const globalCap = (cfg as Record<string, unknown> | undefined)?.globalHaikuFallbackMaxPerDay as number ?? 500;
  const fallbackEnabled = deps.config.ai?.routing?.fallbackToClaudeOnError ?? true;

  // Wire in the parent tick's abort signal so shutdown cancels in-flight provider calls.
  const parentSignal = deps.abortSignal;
  const ctrl = new AbortController();
  const timeoutHandle = setTimeout(() => ctrl.abort('triage-timeout'), timeoutMs);
  if (parentSignal) {
    if (parentSignal.aborted) {
      clearTimeout(timeoutHandle);
      ctrl.abort('tick-aborted');
    } else {
      parentSignal.addEventListener('abort', () => ctrl.abort('tick-aborted'), { once: true });
    }
  }

  const userMsg: UnifiedMessage = {
    role: 'user',
    content: userContent,
  };

  let raw: string | null = null;
  let providerUsed = 'ollama-cloud';
  let model = cfg?.triageModel ?? 'deepseek-v4-flash';
  let fallbackUsed = false;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  try {
    const resp = await deps.ollamaProvider.call({
      model,
      system: TRIAGE_SYSTEM_PROMPT,
      messages: [userMsg],
      tools: [],
      maxTokens: 600,
      abortSignal: ctrl.signal,
    });
    raw = resp.content;
    inputTokens = resp.usage?.input_tokens;
    outputTokens = resp.usage?.output_tokens;
  } catch (err) {
    const msg = errMsg(err);
    // Detect 429 rate-limit — do NOT fall back to Claude on 429
    if (msg.includes('429') || msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('too many requests')) {
      clearTimeout(timeoutHandle);
      log.warn({ reason: 'rate-limit' }, 'triage: Ollama Cloud 429 rate limit, skipping (no Haiku fallback)');
      return { _skipped: true, reason: 'rate-limit' };
    }

    log.warn({ err: msg }, 'triage: Ollama Cloud failed, checking Haiku budget');
    fallbackUsed = true;
    providerUsed = 'claude';
    model = cfg?.fallbackModel ?? 'claude-haiku-4-5';

    // Step 1 (R1): Check per-user budget FIRST (cheap — state already loaded)
    if (userState.haikuFallbacksTodayPerUser >= perUserBudget) {
      clearTimeout(timeoutHandle);
      log.warn(
        { userId, haikuFallbacksTodayPerUser: userState.haikuFallbacksTodayPerUser, perUserBudget },
        'triage: per-user Haiku budget exhausted',
      );
      return { _skipped: true, reason: 'haiku-budget-exhausted' };
    }

    if (!fallbackEnabled) {
      clearTimeout(timeoutHandle);
      log.warn({}, 'triage: fallback disabled by config, skipping');
      return { _skipped: true, reason: 'all-providers-failed' };
    }

    // Step 2 (R1): Atomically reserve a global slot (cap check + write under mutex)
    let reservation: Awaited<ReturnType<typeof reserveGlobalHaikuFallback>>;
    try {
      reservation = await reserveGlobalHaikuFallback(deps.dataDir, globalCap);
    } catch (reserveErr) {
      clearTimeout(timeoutHandle);
      log.warn({ err: errMsg(reserveErr) }, 'triage: global reserve failed; skipping');
      return { _skipped: true, reason: 'all-providers-failed' };
    }

    if (!reservation.ok) {
      clearTimeout(timeoutHandle);
      log.warn(
        { haikuFallbacksToday: reservation.globalState.haikuFallbacksToday, globalCap },
        'triage: global Haiku budget exhausted',
      );
      return { _skipped: true, reason: 'haiku-budget-exhausted', _globalState: reservation.globalState };
    }

    // Slot reserved — make the Haiku call.
    // Note: if the call throws we've "spent" a global slot conservatively. Acceptable per ADR 005 R1.
    try {
      const resp = await deps.claudeProvider.call({
        model,
        system: TRIAGE_SYSTEM_PROMPT,
        messages: [userMsg],
        tools: [],
        maxTokens: 600,
        abortSignal: ctrl.signal,
      });
      raw = resp.content;
      inputTokens = resp.usage?.input_tokens;
      outputTokens = resp.usage?.output_tokens;

      // Global counter already incremented by reserveGlobalHaikuFallback.
      // Update per-user counter here (outside the global mutex — single-user-owned).
      userState.haikuFallbacksTodayPerUser += 1;

      clearTimeout(timeoutHandle);

      if (!raw) return { _skipped: true, reason: 'all-providers-failed', _globalState: reservation.globalStateAfter };

      const decision = parseTriageDecision(raw, pickedItemIds);
      if (decision === null) {
        log.warn({ providerUsed, model, fallbackUsed }, 'triage: parse/schema/hallucination check failed');
        return { _skipped: true, reason: 'all-providers-failed', _globalState: reservation.globalStateAfter };
      }

      return Object.assign(decision, {
        _providerUsed: providerUsed,
        _model: model,
        _fallbackUsed: fallbackUsed,
        _inputTokens: inputTokens,
        _outputTokens: outputTokens,
        _globalStateAfter: reservation.globalStateAfter,
      }) as DecisionWithProvenance & { _globalStateAfter: GlobalReminderState };
    } catch (err2) {
      clearTimeout(timeoutHandle);
      log.warn({ err: errMsg(err2) }, 'triage: Claude fallback also failed, skipping');
      return { _skipped: true, reason: 'all-providers-failed', _globalState: reservation.globalStateAfter };
    }
  }

  clearTimeout(timeoutHandle);

  if (!raw) return { _skipped: true, reason: 'all-providers-failed' };

  const decision = parseTriageDecision(raw, pickedItemIds);
  if (decision === null) {
    log.warn({ providerUsed, model, fallbackUsed }, 'triage: parse/schema/hallucination check failed');
    return { _skipped: true, reason: 'all-providers-failed' };
  }

  // Ollama succeeded — load global state for audit attribution (read-only)
  let globalStateForAudit: GlobalReminderState;
  try {
    globalStateForAudit = await loadGlobalState(deps.dataDir);
  } catch {
    globalStateForAudit = { version: 1, date: ymdLocal(new Date()), haikuFallbacksToday: 0, totalTicksToday: 0 };
  }

  return Object.assign(decision, {
    _providerUsed: providerUsed,
    _model: model,
    _fallbackUsed: fallbackUsed,
    _inputTokens: inputTokens,
    _outputTokens: outputTokens,
    _globalStateAfter: globalStateForAudit,
  }) as DecisionWithProvenance & { _globalStateAfter: GlobalReminderState };
}

// ---------------------------------------------------------------------------
// Per-user tick (§17.7)
// ---------------------------------------------------------------------------

async function tickOneUser(userId: number, deps: ReminderDeps): Promise<void> {
  const { config, dataDir } = deps;
  const now = new Date();
  const todayLocal = ymdLocal(now);

  // Step 1: load state
  const state = await loadReminderState(userId, dataDir);

  // Step 2: ignored-tick cleanup — flip 'pending' → 'ignored' if pre-dates lastTickAt
  const previousTickAt = state.lastTickAt ? Date.parse(state.lastTickAt) : 0;
  for (const [, itemState] of Object.entries(state.items)) {
    const hist = itemState.responseHistory;
    const n = hist.length;
    if (n > 0 && hist[n - 1] === 'pending') {
      // Check if this 'pending' entry pre-dates the previous tick
      if (previousTickAt > 0 && itemState.lastNudgedAt) {
        const nudgedAt = Date.parse(itemState.lastNudgedAt);
        if (nudgedAt < previousTickAt) {
          hist[n - 1] = 'ignored';
        }
      }
    }
    // Mute after N consecutive ignores
    const consecutiveIgnoreThreshold = config.organize?.reminders?.muteAfterConsecutiveIgnores ?? 3;
    const recentHistory = hist.slice(-consecutiveIgnoreThreshold);
    if (
      recentHistory.length === consecutiveIgnoreThreshold &&
      recentHistory.every((e) => e === 'ignored')
    ) {
      itemState.muted = true;
    }
  }

  // Step 3: daily reset
  if (state.dailyResetDate !== todayLocal) {
    state.nudgesToday = 0;
    state.dailyResetDate = todayLocal;
  }

  // v1.9.1 polish: orphan state.items cleanup + single listItems call.
  // Call listItems ONCE (no filter → active + done + abandoned; still skips
  // .trash/). Use the unfiltered set for the orphan sweep, then filter to
  // active in-memory for step 4 — saves a second readdir + front-matter
  // parse pass on every tick (Scalability session-review W-1).
  const allItems = await listItems(userId, dataDir, {});
  const liveIds = new Set<string>(allItems.map((i) => i.frontMatter.id));
  const orphanIds = Object.keys(state.items).filter((id) => !liveIds.has(id));
  if (orphanIds.length > 0) {
    for (const id of orphanIds) delete state.items[id];
    log.info({ userId, orphansDropped: orphanIds.length }, 'cleaned orphan state.items entries');
  }

  // Step 4: mtime un-mute — for each ACTIVE item, if file mtime > lastNudgedAt → un-mute.
  // Reuse the single allItems list; filter in-memory instead of re-reading.
  const items = allItems.filter((i) => i.frontMatter.status === 'active');
  for (const item of items) {
    const id = item.frontMatter.id;
    const itemState = state.items[id];
    if (!itemState) continue;
    if (!itemState.muted) continue;
    try {
      const st = await stat(item.filePath);
      const mtimeMs = st.mtimeMs;
      const lastNudgedAt = itemState.lastNudgedAt;
      if (lastNudgedAt) {
        const lastNudgedMs = Date.parse(lastNudgedAt);
        if (mtimeMs > lastNudgedMs) {
          itemState.muted = false;
          itemState.responseHistory = [];
        }
      }
    } catch {
      // stat failed — ignore; item might have been deleted
    }
  }

  // Step 5: update lastTickAt
  state.lastTickAt = now.toISOString();

  // Step 6: check persistent nag opt-out (CP1 R3)
  if (state.userDisabledNag === true) {
    await safeWriteState(userId, dataDir, state);
    return;
  }

  // Step 7: daily cap
  if (state.nudgesToday >= (config.organize?.reminders?.dailyCap ?? 3)) {
    await safeWriteState(userId, dataDir, state);
    return;
  }

  // Step 8: item list (already loaded above for mtime check)
  // Step 9: min active items threshold
  if (items.length < (config.organize?.reminders?.minActiveItemsForOptIn ?? 3)) {
    await safeWriteState(userId, dataDir, state);
    return;
  }

  // Step 10: filter eligible items
  const cooldownMinutes = config.organize?.reminders?.itemCooldownMinutes ?? 4320;
  const eligible = items.filter((item) => {
    const id = item.frontMatter.id;
    const itemState = state.items[id];
    if (itemState?.muted) return false;
    if (itemState?.lastNudgedAt) {
      const minutesAgo = (now.getTime() - Date.parse(itemState.lastNudgedAt)) / 60_000;
      if (minutesAgo < cooldownMinutes) return false;
    }
    return true;
  });

  // v1.9.1: load globalState once per tick for buildTriageInput.
  // v1.10.0: triageForUser now manages the global counter atomically inside the
  // mutex so we no longer pass globalState into it; pass state (per-user) instead.
  let globalStateForBuild: GlobalReminderState;
  try {
    globalStateForBuild = await loadGlobalState(dataDir);
  } catch {
    globalStateForBuild = { version: 1, date: ymdLocal(now), haikuFallbacksToday: 0, totalTicksToday: 0 };
  }

  // Step 11: pre-sort per R7 and cap at maxItemsPerTriage
  const { userContent, pickedItems } = buildTriageInput({
    userId,
    activeItems: eligible,
    reminderState: state,
    globalState: globalStateForBuild,
    lastUserMessageAgoMinutes: null,
    quietHours: quietHoursNow(config, now),
    now,
    config,
  });

  // Step 12: no eligible items
  if (pickedItems.length === 0) {
    await safeWriteState(userId, dataDir, state);
    return;
  }

  // Step 13 + 14: triage call — triageForUser checks per-user + global budgets atomically
  const pickedItemIds = pickedItems.map((i) => i.frontMatter.id);

  const triageResult = await triageForUser(userId, userContent, pickedItemIds, deps, state);

  // Step 15: handle skipped
  if ('_skipped' in triageResult) {
    insertNudgeAudit(deps, {
      userId,
      result: 'skipped',
      reason: triageResult.reason,
      items,
    });
    await safeWriteState(userId, dataDir, state);
    return;
  }

  const decision = triageResult;

  // Step 16: shouldNudge === false
  if (!decision.shouldNudge) {
    await safeWriteState(userId, dataDir, state);
    return;
  }

  // Guaranteed: shouldNudge === true from here
  const nudgeDecision = decision as DecisionWithProvenance & { shouldNudge: true; itemId: string };

  // Step 17: server-side quiet-hours hard gate (CP1 R2)
  if (quietHoursNow(config, now)) {
    const targetItem = pickedItems.find((i) => i.frontMatter.id === nudgeDecision.itemId);
    if (!targetItem || !isImminentEvent(targetItem, now)) {
      insertNudgeAudit(deps, {
        userId,
        result: 'suppressed',
        reason: 'quiet-hours',
        decision,
        items,
        provider: nudgeDecision._providerUsed,
        model: nudgeDecision._model,
        fallbackUsed: nudgeDecision._fallbackUsed,
        inputTokens: nudgeDecision._inputTokens,
        outputTokens: nudgeDecision._outputTokens,
      });
      await safeWriteState(userId, dataDir, state);
      return;
    }
  }

  // Step 18: outbound-safety filter (CP1 R1)
  const msgSafety = checkOutboundSafety(nudgeDecision.message);
  if (!msgSafety.ok) {
    insertNudgeAudit(deps, {
      userId,
      result: 'suppressed',
      reason: 'outbound-safety-pattern',
      pattern: msgSafety.pattern,
      decision,
      items,
      provider: nudgeDecision._providerUsed,
      model: nudgeDecision._model,
    });
    await safeWriteState(userId, dataDir, state);
    return;
  }

  const offerDesc = nudgeDecision.offer?.description;
  if (offerDesc) {
    const offerSafety = checkOutboundSafety(offerDesc);
    if (!offerSafety.ok) {
      insertNudgeAudit(deps, {
        userId,
        result: 'suppressed',
        reason: 'outbound-safety-pattern',
        pattern: offerSafety.pattern,
        decision,
        items,
        provider: nudgeDecision._providerUsed,
        model: nudgeDecision._model,
      });
      await safeWriteState(userId, dataDir, state);
      return;
    }
  }

  // Step 19: deliver nudge
  // Resolve DM channel (CP1 R10)
  const chatId = deps.adapter.resolveDmChatId(userId);
  if (chatId === null) {
    log.warn({ userId }, 'reminders: cannot resolve DM channel, skipping nudge');
    insertNudgeAudit(deps, {
      userId,
      result: 'skipped',
      reason: 'no-dm-channel',
      decision,
      items,
      provider: nudgeDecision._providerUsed,
      model: nudgeDecision._model,
    });
    await safeWriteState(userId, dataDir, state);
    return;
  }

  const body = formatNudgeBody(nudgeDecision);

  // Snapshot for rollback (CP1 R5)
  const snapshot = structuredClone(state);

  // Tentatively mutate state
  const nowIso = now.toISOString();
  state.nudgesToday += 1;
  state.lastNudgeAt = nowIso;

  const existingItemState = state.items[nudgeDecision.itemId] ?? {
    lastNudgedAt: null,
    nudgeCount: 0,
    responseHistory: [],
    muted: false,
  };
  existingItemState.lastNudgedAt = nowIso;
  existingItemState.nudgeCount += 1;
  existingItemState.responseHistory.push('pending');
  state.items[nudgeDecision.itemId] = existingItemState;

  try {
    await deps.adapter.sendMessage(chatId, body);
  } catch (err) {
    log.warn({ userId, itemId: nudgeDecision.itemId, err: errMsg(err) }, 'reminders: nudge send failed; rolling back state');
    // Rollback (CP1 R5)
    Object.assign(state, snapshot);
    insertNudgeAudit(deps, {
      userId,
      result: 'failed',
      reason: 'send-failed',
      decision,
      items,
      provider: nudgeDecision._providerUsed,
      model: nudgeDecision._model,
      fallbackUsed: nudgeDecision._fallbackUsed,
    });
    await safeWriteState(userId, dataDir, state);
    return;
  }

  // Success: emit audit (v1.10.0: include per-user and global Haiku counters)
  const globalStateAfterNudge = '_globalStateAfter' in triageResult ? triageResult._globalStateAfter : undefined;
  insertNudgeAudit(deps, {
    userId,
    result: 'ok',
    decision,
    items,
    provider: nudgeDecision._providerUsed,
    model: nudgeDecision._model,
    fallbackUsed: nudgeDecision._fallbackUsed,
    inputTokens: nudgeDecision._inputTokens,
    outputTokens: nudgeDecision._outputTokens,
    nudgesToday: state.nudgesToday,
    haikuFallbacksTodayPerUser: nudgeDecision._fallbackUsed ? state.haikuFallbacksTodayPerUser : undefined,
    globalHaikuFallbacksToday: globalStateAfterNudge?.haikuFallbacksToday,
  });

  // Step 20: write state
  await safeWriteState(userId, dataDir, state);
}

/** Write state, log error on failure (state-write failure is non-fatal at the tick level). */
async function safeWriteState(userId: number, dataDir: string, state: ReminderState): Promise<void> {
  try {
    // writeReminderState calls ensureUserDir (symlink defense + mkdir) internally
    await writeReminderState(userId, dataDir, state);
  } catch (err) {
    log.error({ userId, err: errMsg(err) }, 'reminders: failed to write reminder state');
  }
}

// ---------------------------------------------------------------------------
// tickAllUsers — v1.10.0: sliding-window pool + R6 abort signal
// ---------------------------------------------------------------------------

async function tickAllUsers(deps: ReminderDeps): Promise<void> {
  const organizeRoot = path.join(deps.dataDir, 'organize');
  if (!existsSync(organizeRoot)) return;

  let entries: string[];
  try {
    entries = await readdir(organizeRoot);
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'reminders tick: readdir organize root failed');
    return;
  }

  const userIds = entries
    .map((e) => Number.parseInt(e, 10))
    .filter((n) => Number.isFinite(n) && n > 0);

  // Read tickConcurrency from config; clamp to [1, 20] (schema enforces this but
  // be defensive for tests that pass partial configs).
  const rawConcurrency = (deps.config.organize?.reminders as Record<string, unknown> | undefined)?.tickConcurrency as number | undefined;
  const tickConcurrency = Math.max(1, Math.min(20, rawConcurrency ?? 5));

  const tickStart = Date.now();
  log.info({ users: userIds.length, concurrency: tickConcurrency }, 'tick start');

  let usersProcessed = 0;
  let failed = 0;
  let maxInFlight = 0;
  let currentInFlight = 0;

  // Sliding-window pool (ADR 005 decision 5)
  const inFlight = new Set<Promise<void>>();

  for (const userId of userIds) {
    // Check abort before starting a new user
    if (deps.abortSignal?.aborted) {
      log.info({ userId, reason: 'tick-aborted' }, 'reminders tick: aborting — stop() called');
      break;
    }

    currentInFlight++;
    if (currentInFlight > maxInFlight) maxInFlight = currentInFlight;

    const p: Promise<void> = tickOneUser(userId, deps)
      .catch((err) => {
        log.warn({ userId, err: errMsg(err) }, 'reminders tick: per-user error, continuing');
        failed++;
      })
      .finally(() => {
        inFlight.delete(p);
        usersProcessed++;
        currentInFlight--;
      });
    inFlight.add(p);

    if (inFlight.size >= tickConcurrency) {
      await Promise.race(inFlight);
    }
  }

  // Drain remaining in-flight
  await Promise.all(inFlight);

  const elapsedMs = Date.now() - tickStart;
  log.info({ usersProcessed, failed, elapsedMs, concurrency: tickConcurrency, maxInFlight }, 'tick complete');

  // v1.9.1 polish: warn if a tick exceeded a fraction of the cron interval.
  const overflowRatio = deps.config.organize?.reminders?.wallTimeWarnRatio ?? 0.75;
  const cronIntervalMs = inferCronIntervalMs(deps.config.organize.reminders.cronExpression);
  if (cronIntervalMs !== null && elapsedMs > cronIntervalMs * overflowRatio) {
    log.warn(
      {
        usersProcessed,
        elapsedMs,
        cronIntervalMs,
        concurrency: tickConcurrency,
        percentOfInterval: Math.round((elapsedMs / cronIntervalMs) * 100),
      },
      'reminders tick exceeded 75% of cron interval — next fire may be skipped by tickInFlight lock',
    );
  }
}

/**
 * Infer the tick interval from a cron expression of the shape
 * `M H1-H2/STEP * * *`. Returns `STEP * 60 * 60 * 1000` ms, or null if
 * the expression doesn't match the expected shape.
 *
 * v1.9.1: used only for the wall-time overflow warn — a non-match falls
 * back to "don't warn" rather than hard-coding 2h, so non-standard cron
 * expressions (configured by advanced users) don't spam warns.
 */
function inferCronIntervalMs(cronExpression: string): number | null {
  const match = /^\d+\s+\d+(?:-\d+)?(?:\/(\d+))?\s+\*\s+\*\s+\*$/.exec(cronExpression);
  if (!match) return null;
  const stepHours = match[1] ? Number.parseInt(match[1], 10) : 1;
  if (!Number.isFinite(stepHours) || stepHours <= 0) return null;
  return stepHours * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// initReminders
// ---------------------------------------------------------------------------

export function initReminders(deps: ReminderDeps): RemindersApi {
  const { config, dataDir } = deps;

  const api: RemindersApi = {
    start() {
      const remCfg = config.organize?.reminders;
      if (!remCfg?.enabled) {
        log.info({}, 'Reminders disabled in config');
        return;
      }

      const cronExpr = remCfg.cronExpression ?? '0 8-20/2 * * *';
      if (!cron.validate(cronExpr)) {
        log.error({ cronExpr }, 'reminders: invalid cron expression, not starting');
        return;
      }

      cronTask = cron.schedule(cronExpr, async () => {
        if (tickInFlight) {
          log.warn({ cron: 'skipped' }, 'Previous tick still running; skipping this fire');
          return;
        }
        tickInFlight = true;
        // R6: create a fresh abort controller per tick; store it so stop() can abort it.
        const abortCtrl = new AbortController();
        currentTickAbort = abortCtrl;
        try {
          await tickAllUsers({ ...deps, abortSignal: abortCtrl.signal });
        } catch (err) {
          log.error({ err: errMsg(err) }, 'tickAllUsers failed');
        } finally {
          tickInFlight = false;
          if (currentTickAbort === abortCtrl) currentTickAbort = null;
        }
      }, { scheduled: true });

      log.info({ cronExpr }, 'reminders: cron registered');
    },

    stop() {
      cronTask?.stop();
      cronTask = null;
      // R6: abort any in-flight tick so provider calls cancel promptly on shutdown.
      currentTickAbort?.abort('stop-called');
      currentTickAbort = null;
    },

    async tickAllUsers() {
      return tickAllUsers(deps);
    },

    async tickOneUser(userId: number) {
      return tickOneUser(userId, deps);
    },

    async markResponsiveIfPending(userId: number): Promise<void> {
      const state = await loadReminderState(userId, dataDir);
      let changed = 0;
      for (const itemState of Object.values(state.items)) {
        const n = itemState.responseHistory.length;
        if (n > 0 && itemState.responseHistory[n - 1] === 'pending') {
          itemState.responseHistory[n - 1] = 'responded';
          changed++;
        }
      }
      if (changed > 0) {
        // writeReminderState calls ensureUserDir (symlink defense + mkdir) internally
        await writeReminderState(userId, dataDir, state);
        log.debug({ userId, flipped: changed }, 'markResponsiveIfPending: flipped pending → responded');
      } else {
        log.debug({ userId }, 'markResponsiveIfPending: no pending nudges to flip');
      }
    },

    async setUserDisabledNag(userId: number, disabled: boolean): Promise<void> {
      const state = await loadReminderState(userId, dataDir);
      state.userDisabledNag = disabled;
      // writeReminderState calls ensureUserDir (symlink defense + mkdir) internally
      await writeReminderState(userId, dataDir, state);
    },

    async getNagStatus(userId: number) {
      const state = await loadReminderState(userId, dataDir);
      const mutedCount = Object.values(state.items).filter((i) => i.muted).length;
      return {
        disabledNag: state.userDisabledNag,
        nudgesToday: state.nudgesToday,
        lastNudgeAt: state.lastNudgeAt,
        mutedCount,
      };
    },
  };

  return api;
}

// ---------------------------------------------------------------------------
// Exports for testing (allow tests to reset module-level state)
// ---------------------------------------------------------------------------

/** Test hook — reset tick-in-flight lock. */
export function _resetTickInFlightForTests(): void {
  tickInFlight = false;
}

/** Test hook — read current tickInFlight value. */
export function _getTickInFlight(): boolean {
  return tickInFlight;
}

/** Test hook — set tickInFlight (to simulate a running tick). */
export function _setTickInFlightForTests(value: boolean): void {
  tickInFlight = value;
}

/** Test hook — get the current tick's AbortController (for abort-mid-tick tests). */
export function _getCurrentTickAbortForTests(): AbortController | null {
  return currentTickAbort;
}

/** Test hook — set a custom AbortController for the current tick (for abort-mid-tick tests). */
export function _setCurrentTickAbortForTests(ctrl: AbortController | null): void {
  currentTickAbort = ctrl;
}

// Export path helper for tests
export { reminderStatePath };
